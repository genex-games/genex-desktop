// The client side of the fast channel (PROTOCOL.md §17.12 *Client*): one seat's datagram socket, the
// inputs it still holds for the redundant uplink, its snapshot reassembly and the deadlines after which
// the seat goes back to the WebSocket. No I/O of its own: the socket comes from a SocketOpener (an
// FSocket UDP socket in the UE module, GenexUnrealUdp; a POSIX one in the CMake tools), and the clock is
// injected, so every decision here is replayable. Single-threaded and polled (sdks/unreal/core/DESIGN.md):
// Poll() drains what the socket received.
//
// Port of packages/multiplayer/src/authority/fast-client.ts, with `udpEndpoint` of fast-udp.ts (the
// `__fast` url is server-supplied, so it is a network boundary: anything but `udp://host:port` is refused).
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexFastRecords.h"
#include "GenexCore/GenexFastTransport.h"
#include "GenexCore/GenexJson.h"

#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace genex::fast {

/** The `__fast` message's payload: the seat's binding and the endpoint's url. */
struct BindMessage {
  double sid = 0;
  std::string key;
  std::string url;
  /** The host's revision of the channel (0: older than kBindRev; it gets no empty uplink). */
  int rev = 0;
  /** A fresh binding to prove while the WebSocket carries everything (§17.12 *Return to the channel*). */
  bool probe = false;
};

/** A `__fast` payload this client can use (sid a uint32, key kKeyBytes bytes of lowercase hex, url a
 *  non-empty string), else nothing. */
GENEX_CORE_API std::optional<BindMessage> FastBindOf(const Json& message);

/** Where a `udp://` url points: the host (an IPv6 host unbracketed) and the port. */
struct UdpTarget {
  std::string host;
  int port = 0;
};

/** The host and port of a `udp://host:port` url, else nothing: a port in 1..65535, a host name or IPv4
 *  address, or an IPv6 address in brackets, and nothing more (no credentials, path, query or fragment;
 *  a bare `/` path is taken). Stricter than WHATWG parsing where that would take an empty `@`, `?` or `#`. */
GENEX_CORE_API std::optional<UdpTarget> UdpEndpoint(std::string_view url);

/** A datagram socket to the room's fast endpoint. Sends never fail visibly: a lost datagram is the
 *  channel's normal case. Polled: Poll hands every datagram received since the last poll to `receive`
 *  (only datagrams from the endpoint the socket was opened to). */
class GENEX_CORE_API DatagramSocket {
 public:
  virtual ~DatagramSocket();
  virtual void Send(const std::uint8_t* data, std::size_t length) = 0;
  virtual void Poll(const std::function<void(const std::uint8_t* data, std::size_t length)>& receive) = 0;
  virtual void Close() = 0;
};

/** Opens a socket to a `__fast` url; nullptr when this client cannot reach that url (the seat then
 *  falls back at once). */
using SocketOpener = std::function<std::unique_ptr<DatagramSocket>(const std::string& url)>;

/** Why a fast seat went back to the WebSocket. */
enum class FallbackReason : std::uint8_t {
  /** The `__fast` binding was malformed, or this client cannot open its url. */
  Unreachable,
  /** No snapshot within kHandshakeMs of the first datagram. */
  Handshake,
  /** No snapshot for kStallFallbackMs after the last one. */
  Stall,
  /** The server asked for it (`__fast:off` from the server). */
  Server,
};

/** The reason's spelling (`unreachable`, `handshake`, `stall`, `server`). */
GENEX_CORE_API const char* FallbackReasonName(FallbackReason reason);

/** What the session reads of a seat's fast channel. */
struct FastSeatStatus {
  /** Snapshots are flowing and inputs go by datagram. */
  bool live = false;
  /** Snapshots applied on this session. */
  int snapshots = 0;
  /** Why this seat is on the WebSocket now. */
  std::optional<FallbackReason> fallback;
  /** Times this session fell back. */
  int fallbacks = 0;
  /** Times this session came back to the channel after a fallback. */
  int returns = 0;
};

/** One applied snapshot as the session uses it: its header and the motion records that differ from the
 *  previous applied snapshot's (a record that does not decode is left out: its id stays as it was). */
struct FastSnapshot {
  double snap = 0;
  double tick = 0;
  /** The last input seq the server accepted (the header's `inputAck`). */
  double inputAck = 0;
  /** The room clock the server wrote it at (the header's `sent`, a WebSocket patch's TIMED `sNow`). */
  double sent = 0;
  std::vector<MotionRecord> changed;
};

/** What one received datagram did. */
struct Receipt {
  std::optional<FastSnapshot> applied;
  std::optional<Fault> fault;
};

/** The inputs UplinkFor still needs once the server accepted through `inputAck`: the window's newest
 *  inputs, every input after the ack, and the one before the oldest of those. At most SeqAheadMax. */
GENEX_CORE_API std::vector<FastInput> HeldInputs(const std::vector<FastInput>& sent, double inputAck, double tickHz);

struct FastClientOptions {
  BindMessage bind;
  double tickHz = 0;
  SocketOpener open;
  /** The clock the deadlines run on (ms). */
  std::function<double()> now;
  /** Each applied snapshot, after the receive state took it. */
  std::function<void(const FastSnapshot&)> onSnapshot;
};

/** One seat's fast channel on one socket. */
class GENEX_CORE_API FastClient {
 public:
  /** Opens a seat's fast channel on `o.bind`; nullptr when the opener cannot reach its url. */
  static std::unique_ptr<FastClient> Open(FastClientOptions o);
  ~FastClient();
  FastClient(const FastClient&) = delete;
  FastClient& operator=(const FastClient&) = delete;

  const BindMessage& Bind() const { return options_.bind; }
  /** The snapshot receive state (reassembly, held bases, newest applied). */
  const ClientRx& Rx() const { return rx_; }
  /** The newest input seq queued (0: none). */
  double LastQueued() const { return sent_.empty() ? 0 : sent_.back().seq; }
  /** True once closed: nothing is sent or received again. */
  bool Closed() const { return closed_; }
  /** An input sent this frame: seqs ascend by one from the first queued. */
  void Queue(const FastInput& input);
  /** One datagram carrying the inputs queued since the last flush and the redundant window (one more for
   *  each further window's worth of new inputs); nothing when none was queued. */
  void Flush();
  /** An empty uplink when one is due (§17.12 *Keepalive*), from a host that takes them: the seat binds with
   *  no input, its snapshots stay acknowledged and its NAT mapping stays open. */
  void Keepalive();
  /** A frame begins: time since the last frame past kFrameGapMs is taken off both deadlines' clocks, so a seat
   *  whose frames stopped does not read its own stop as a dead path. */
  void Framed();
  /** Every record of the newest applied snapshot. */
  std::vector<MotionRecord> AllRecords() const;
  /** The input of seq `seq` while it is still held. */
  const FastInput* InputAt(double seq) const;
  /** When the input of seq `seq` was first sent (by `now`), for each of the newest SeqAheadMax inputs: the
   *  server consumes an input well after it received it (its buffer, the next keyframe), and the round trip
   *  is timed from the send of the input a snapshot acks as consumed. */
  std::optional<double> SentAt(double seq) const;
  /** The latest decoded record of `id` of `kind` (from the newest applied snapshot). */
  const MotionRecord* MotionOf(RecordKind kind, const std::string& id) const;
  /** Whether a deadline has passed (§17.12 *Fallback*), by the injected clock. */
  std::optional<FallbackReason> Due() const;
  /** One datagram from the socket. A fault, a stale or duplicate fragment or a datagram for another seat
   *  changes nothing. */
  Receipt Receive(const std::uint8_t* data, std::size_t length);
  /** Every datagram the socket received since the last poll, through Receive. */
  void Poll();
  void Close();

 private:
  struct Decoded {
    Bytes bytes;
    std::optional<MotionRecord> record;
  };
  explicit FastClient(FastClientOptions o);
  std::vector<MotionRecord> DecodeChanged(const Records& records);
  double InputAck() const { return rx_.history.empty() ? 0 : rx_.history.back().inputAck; }
  void SendEmpty();

  FastClientOptions options_;
  std::unique_ptr<DatagramSocket> socket_;
  ClientRx rx_;
  std::vector<FastInput> sent_;
  std::map<double, double> sentTimes_;
  int fresh_ = 0;
  bool closed_ = false;
  std::optional<double> firstSentAt_;
  std::optional<double> lastAppliedAt_;
  std::optional<double> lastUplinkAt_;
  std::optional<double> lastFrameAt_;
  double lastAppliedSnap_ = 0;
  std::map<double, Decoded> decodedByKey_;
  std::map<std::string, MotionRecord> latest_;
};

}  // namespace genex::fast
