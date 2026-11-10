// The fast channel (PROTOCOL.md §17.12, cap `fast@1`): a seat's inputs and motion state on an
// unordered, unreliable datagram path (raw UDP for the engines) beside the WebSocket. Each uplink
// datagram carries the seat's last inputs (the redundant window) and its presses not yet acknowledged,
// so a lost datagram costs nothing the next one does not carry; the server keeps the first copy of each
// seq and fills a gap no datagram covered with the last input held. Downlink snapshots are deltas
// against the snapshot the seat acknowledged, fragmented under one datagram, and a lost one is replaced
// by the next.
//
// Port of packages/multiplayer/src/authority/fast-transport.ts, held to
// packages/multiplayer/test/vectors/fast-transport.json by genex_fast_transport_check. Pure: no I/O, no
// clock. Every number is a double, as the TypeScript's are (seqs and ticks are integers a double holds
// exactly), so the encoder refuses the very values the reference refuses. A refusal never changes
// state: AcceptUplink answers the seat it was given (`changed` false), and ReceiveFragment leaves the
// receive state as it was whenever the reference answers the very object it was given.
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexInput.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace genex::fast {

/** The datagram format's version, the first byte of every datagram. */
constexpr int kFastVersion = 1;
/** No datagram is longer: the IPv6 minimum MTU (1280) less IP, UDP and QUIC headers. */
constexpr std::size_t kMaxDatagramBytes = 1200;
/** The binding key's length: 8 random bytes per socket, sent on the reliable channel at join. */
constexpr std::size_t kKeyBytes = 8;
/** The redundant window as time: the longest delay episode measured on `real-mac-wifi` (70–170 ms). */
constexpr double kInputRedundancyMs = 170;
/** The window's least inputs: two datagrams lost in a row are recovered at any tick rate. */
constexpr int kInputRedundancyMin = 3;
/** The window's most inputs, and the most a datagram may carry. */
constexpr int kInputRedundancyMax = 32;
/** Presses past the window awaiting the server's ack that one datagram carries (the oldest). */
constexpr int kMaxActions = 8;
/** The longest gap the server fills with the last input held; a longer one is skipped. */
constexpr double kGapFillMs = 250;
/** A datagram whose newest seq is more than this far (as ticks) past the last accepted is dropped. */
constexpr double kSeqAheadMs = 5000;
/** Snapshots each side holds as bases. */
constexpr std::size_t kSnapshotHistory = 32;
/** The most fragments one snapshot may have (about 37 KB). */
constexpr int kMaxFragments = 32;
/** Incomplete snapshots a client gathers at once; the oldest gives way. */
constexpr std::size_t kReassemblySlots = 4;
/** One record's most bytes. */
constexpr std::size_t kMaxRecordBytes = 1024;
/** A client with no snapshot this long after its first datagram falls back to the WebSocket. */
constexpr double kHandshakeMs = 1000;
/** A client with no snapshot for this long falls back to the WebSocket. */
constexpr double kStallFallbackMs = 2000;

/** A seat with nothing to send sends an empty uplink this often while snapshots reach it (§17.12 *Keepalive*):
 *  under kSnapshotHistory snapshots at 120 Hz, far under any NAT timer measured. */
constexpr double kKeepaliveMs = 250;
/** Likewise before its first snapshot. */
constexpr double kKeepaliveBindMs = 50;
/** A snapshot changing this many records is acknowledged as it lands by a seat with nothing else to send. */
constexpr std::size_t kAckEagerRecords = 32;
/** No eager ack within this long of another uplink: a seat sending inputs every frame sends none. */
constexpr double kAckEagerGapMs = 20;
/** A snapshot id at least this far past the client's newest is a return-path challenge: echoed at once. */
constexpr double kChallengeJump = 65536;
/** No frame for this long: the deadlines' clocks did not run. */
constexpr double kFrameGapMs = 250;
/** The binding's `rev` from a host that takes empty uplinks, challenges addresses and offers fresh bindings. */
constexpr int kBindRev = 2;
/** Snapshots a seat applies on a fresh binding before its inputs and motion move to it. */
constexpr int kReturnProof = 3;
/** A retry's delay at attempt 0, before jitter. */
constexpr double kRetryBaseMs = 1000;
/** Its most, before jitter. */
constexpr double kRetryMaxMs = 60000;
/** A seat that held the channel this long starts its next backoff from attempt 0. */
constexpr double kReturnStableMs = 30000;

/** The delay before retry number `attempt` (from 0), jittered by `unit` in [0, 1): doubling from kRetryBaseMs
 *  to kRetryMaxMs, half of it random, so seats behind one failed link do not come back as one. */
GENEX_CORE_API double RetryDelayMs(int attempt, double unit);

/** The reliable messages of the fast channel: server → client `{ sid, key, url }`, the seat's binding. */
constexpr const char* kBindMessage = "__fast";
/** Client → server `{ last }` (and server → client `{}`): the seat goes back to the WebSocket. */
constexpr const char* kOffMessage = "__fast:off";
/** Client → server `{}`: a seat off the channel asks for a fresh binding. */
constexpr const char* kAgainMessage = "__fast:again";
/** Client → server `{ last }`, the last seq sent by WebSocket: its inputs go by datagram from now on. */
constexpr const char* kOnMessage = "__fast:on";

/** The datagram kinds, the second byte. */
enum class Kind : std::uint8_t { Uplink = 1, Snapshot = 2 };

/** Why a datagram or a value was refused (FastFault). */
enum class Fault : std::uint8_t {
  Oversized,
  Truncated,
  Trailing,
  Version,
  Kind,
  Session,
  Key,
  Count,
  Fresh,
  Actions,
  Flags,
  Order,
  Field,
  Ahead,
  Fragment,
  Mismatch,
  Duplicate,
  Keyframe,
  Body,
  Base,
  Stale,
};

/** The fault's wire spelling (`oversized`, …), as the vectors write it. */
GENEX_CORE_API const char* FaultName(Fault fault);

/** How the server came by an accepted input. */
enum class AcceptKind : std::uint8_t {
  /** First sent in the datagram that brought it. */
  Fresh,
  /** Sent first in an earlier datagram that was lost; carried again by redundancy or as an action. */
  Recovered,
  /** No datagram the server got carried it: the last input held stands in for it. */
  Fill,
};

/** The kind's wire spelling (`fresh`, `recovered`, `fill`). */
GENEX_CORE_API const char* AcceptKindName(AcceptKind kind);

using Bytes = std::vector<std::uint8_t>;

/** A value, or the fault that refused it. */
template <typename T>
struct Result {
  std::optional<T> value;
  Fault fault = Fault::Field;
  bool Ok() const { return value.has_value(); }
};

/** One input on the wire: its client sequence, its `tick@1` field, its payload and its render time. */
struct FastInput {
  double seq = 0;
  double tick = 0;
  Input input;
  /** The render time its sender drew the world at when it sent it (§17.5): the room clock, whole ms, as
   *  its WebSocket input frame's stamp would carry it; 0: not stamped (no synced clock). */
  double render = 0;
};

/** An uplink datagram's content. `window` is contiguous, oldest first; `actions` ascend below it. */
struct Uplink {
  double sid = 0;
  std::string key;
  double ackSnap = 0;
  double fresh = 0;
  std::vector<FastInput> actions;
  std::vector<FastInput> window;
};

/** A seat's fast-channel binding, from the reliable `__fast` message. */
struct Binding {
  double sid = 0;
  std::string key;
};

/** The redundant window at `tickHz`: kInputRedundancyMs of inputs, within its bounds. */
GENEX_CORE_API int InputRedundancyTicks(double tickHz);
/** The longest gap filled at `tickHz` (kGapFillMs of ticks). */
GENEX_CORE_API int GapFillMax(double tickHz);
/** The farthest a datagram's newest seq may be past the last accepted at `tickHz`. */
GENEX_CORE_API int SeqAheadMax(double tickHz);

/** Lowercase hex of `bytes`. */
GENEX_CORE_API std::string ToHex(const std::uint8_t* data, std::size_t length);
GENEX_CORE_API std::string ToHex(const Bytes& bytes);
/** The bytes of hex text `hex` (an even count of hex digits; anything else reads as no bytes). */
GENEX_CORE_API Bytes FromHex(std::string_view hex);
/** A binding key: exactly kKeyBytes bytes of lowercase hex. */
GENEX_CORE_API bool IsKey(std::string_view key);

/** An input whose buttons gain a bit over `previous`'s (none: over no buttons). */
GENEX_CORE_API bool IsPress(const Input* previous, const Input& input);

// ---- the uplink ----

/** Encodes uplink `u` (§17.12 *Uplink datagram*); refuses (`field`) what the wire cannot carry. */
GENEX_CORE_API Result<Bytes> EncodeUplink(const Uplink& u);

/** Decodes an uplink datagram for the seat bound by `binding`: checked whole, the session and key
 *  first; any fault drops it. Payloads are as sent (the server sanitizes as it accepts). */
GENEX_CORE_API Result<Uplink> DecodeUplink(const std::uint8_t* data, std::size_t length, const Binding& binding);

/** What UplinkFor needs beside the inputs. */
struct UplinkOptions {
  double sid = 0;
  std::string key;
  /** The newest snapshot the client applied. */
  double ackSnap = 0;
  /** The server's last accepted input seq, from the newest applied snapshot's `inputAck`. */
  double inputAck = 0;
  /** How many of the newest inputs this datagram sends first. */
  double fresh = 0;
  double tickHz = 0;
};

/** The client's next uplink (§17.12 *Redundancy and one-shot inputs*): `sent[0, count)` is every input
 *  it still holds, ascending and contiguous, back past `inputAck`; the window is the newest
 *  InputRedundancyTicks, and the oldest kMaxActions presses before it the server has not acked ride as
 *  actions. */
GENEX_CORE_API Uplink UplinkFor(const FastInput* sent, std::size_t count, const UplinkOptions& o);

/** The render time a fast input carries (§17.12 *Render-time stamp*), the stamp its WebSocket input
 *  frame would carry: `round(serverNow) − round(renderDelay + rtt/2)` whole ms, the delay clamped to
 *  [0, 65535], 0 when that is not above 0 or the clock has not synced (`serverNow` none). */
GENEX_CORE_API double RenderStamp(std::optional<double> serverNow, double renderDelay, double rtt);

// ---- the server's dedup ----

/** A seat's receive state: the last accepted seq, the last accepted input (none before the first) and
 *  the newest snapshot the seat acknowledged. */
struct SeatRx {
  double last = 0;
  std::optional<Input> input;
  double ackSnap = 0;
};

/** One input the server accepted, sanitized, in seq order, with the render time lag compensation
 *  judges it at (0: unstamped; a filled input takes the one of the input after its gap). */
struct AcceptedInput {
  double seq = 0;
  double tick = 0;
  Input input;
  AcceptKind kind = AcceptKind::Fresh;
  double render = 0;
};

struct AcceptOptions {
  double tickHz = 0;
  /** The newest snapshot id the server sent this seat (an `ackSnap` past it is ignored). */
  double snapSent = 0;
};

struct AcceptResult {
  /** The seat after the datagram: the one given when `changed` is false. */
  SeatRx seat;
  std::vector<AcceptedInput> accepted;
  /** Seqs consumed without a step: a gap longer than GapFillMax. */
  double skipped = 0;
  /** Set when the whole datagram was dropped. */
  std::optional<Fault> fault;
  /** False when nothing changed: the reference answers the very seat it was given. */
  bool changed = false;
};

/** The server's take of decoded uplink `u` for seat `seat` (§17.12 *Server dedup*). */
GENEX_CORE_API AcceptResult AcceptUplink(const SeatRx& seat, const Uplink& u, const AcceptOptions& o);

// ---- snapshots ----

/** One motion record of a snapshot: its record key and the record codec's bytes. */
struct KeyedRecord {
  double key = 0;
  Bytes bytes;
  bool operator==(const KeyedRecord& other) const { return key == other.key && bytes == other.bytes; }
};

/** A snapshot's motion records, ascending by key. */
using Records = std::vector<KeyedRecord>;

/** A snapshot body: the keys removed since the base, then the records new or changed. */
struct SnapshotBody {
  std::vector<double> removed;
  Records records;
};

/** The snapshot header the server writes. `base` 0 is a keyframe. */
struct SnapshotHead {
  double sid = 0;
  double snap = 0;
  double base = 0;
  double tick = 0;
  double inputAck = 0;
  /** The room clock (ms since room start, §16.1 `sNow`, truncated to a uint32) when the server wrote the
   *  snapshot: the value a WebSocket patch's TIMED prefix carries, so a fast seat's clock samples exactly what
   *  a WebSocket seat's does (the tick's nominal instant is up to a step earlier). */
  double sent = 0;
};

/** The body that turns `base` into `next` (no `base`: a keyframe, every record). */
GENEX_CORE_API SnapshotBody DiffSnapshot(const Records* base, const Records& next);

/** The base the server deltas against: the seat's `ackSnap` while it still holds that snapshot, else 0. */
GENEX_CORE_API double DeltaBase(const std::vector<double>& held, double ackSnap);

/** The fragments of snapshot `head` with body `body`: `oversized` past kMaxFragments, `field` for a
 *  value the wire cannot carry. */
GENEX_CORE_API Result<std::vector<Bytes>> EncodeSnapshot(const SnapshotHead& head, const SnapshotBody& body);

/** One decoded snapshot fragment. */
struct Fragment {
  double snap = 0;
  double base = 0;
  double tick = 0;
  double inputAck = 0;
  double sent = 0;
  bool keyframe = false;
  int frag = 0;
  int frags = 0;
  Bytes chunk;
};

/** Decodes a snapshot fragment for seat `sid`; any fault drops it. */
GENEX_CORE_API Result<Fragment> DecodeFragment(const std::uint8_t* data, std::size_t length, double sid);

/** Parses a reassembled body to the byte (keys ascending and unique, lengths in bounds, nothing left). */
GENEX_CORE_API Result<SnapshotBody> ParseBody(const std::uint8_t* data, std::size_t length);

/** `base`'s records less `body.removed`, with `body.records` written over them, ascending by key. */
GENEX_CORE_API Records ApplyBody(const Records& base, const SnapshotBody& body);

/** An applied snapshot the client holds as a base. */
struct HeldSnapshot {
  double snap = 0;
  double tick = 0;
  double inputAck = 0;
  double sent = 0;
  Records records;
  bool operator==(const HeldSnapshot& o) const {
    return snap == o.snap && tick == o.tick && inputAck == o.inputAck && sent == o.sent && records == o.records;
  }
};

/** A snapshot being gathered: its first fragment's header and the chunks so far. */
struct PartialSnapshot {
  double snap = 0;
  double base = 0;
  double tick = 0;
  double inputAck = 0;
  double sent = 0;
  bool keyframe = false;
  int frags = 0;
  std::vector<std::optional<Bytes>> chunks;
  bool operator==(const PartialSnapshot& o) const {
    return snap == o.snap && base == o.base && tick == o.tick && inputAck == o.inputAck && sent == o.sent && keyframe == o.keyframe &&
           frags == o.frags && chunks == o.chunks;
  }
};

/** The client's receive state: sets being gathered (ascending), applied snapshots held as bases (oldest
 *  first, at most kSnapshotHistory) and the newest applied id (0: none). */
struct ClientRx {
  std::vector<PartialSnapshot> partials;
  std::vector<HeldSnapshot> history;
  double newest = 0;
  bool operator==(const ClientRx& o) const { return newest == o.newest && partials == o.partials && history == o.history; }
};

struct ReceiveResult {
  /** The snapshot this fragment completed and applied. */
  std::optional<double> applied;
  std::optional<Fault> fault;
};

/** The client's take of one snapshot datagram (§17.12 *Applying a snapshot*), into `rx`. A fault drops
 *  the fragment; while nothing was gathered for it, `rx` is left exactly as it was. */
GENEX_CORE_API ReceiveResult ReceiveFragment(ClientRx& rx, const std::uint8_t* data, std::size_t length, double sid);

}  // namespace genex::fast
