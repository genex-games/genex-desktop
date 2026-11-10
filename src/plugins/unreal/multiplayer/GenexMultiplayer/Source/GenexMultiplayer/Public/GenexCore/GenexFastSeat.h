// A seat's fast channel inside the authority session (PROTOCOL.md §17.12 *Client*): the reliable side of
// `fast@1` (the `__fast` binding, `__fast:off`), the inputs the session sends going by datagram while the
// channel is live, and each applied snapshot written into the decoded state (the C core's schema
// structs) exactly as a patch would write it, then the session's own state pass run, so the reconciler,
// prediction and drawing read one state and never learn which transport delivered it.
//
// Port of packages/multiplayer/src/authority/fast-session.ts. While the channel is live:
//  - the input handle still numbers, records and replays every input (its seq is the input's client
//    sequence less the socket's `seqBase`);
//  - your inputs' ack is your own seat record's `inAck` (the server's WebSocket ack counts its WebSocket
//    buffer, which the channel does not use);
//  - motion fields and the state's `tick` (and `keyframe` in a room that writes keyframes) come from
//    snapshots only: a WebSocket patch that would write one of them for a record the channel holds is put
//    back before the session reads the state (MotionGuard), and the WebSocket's latest value is kept.
// One deliberate difference from the TypeScript: the handle's WebSocket input frames are NOT muted. The C
// core's input encoder diffs each frame against the last one it sent (colyseus/schema/input_encoder.h),
// so frames the server never got would leave its decoder on a stale baseline, and after a fallback a field
// unchanged since would be stepped at its old value. The server drops a live fast seat's WebSocket inputs
// unread (room.ts sourceOf) and counts the fallback's on from them, which is why `wsBefore` at a fallback is
// the handle's count then. It also means this handle hears an ack for inputs the server has not stepped, so a
// replay reads past it (the session's ReplayInput), where the TypeScript's handle still holds them.
//
// A fallback is not the end (§17.12 *Return to the channel*): from a host that offers it the seat asks for a
// fresh binding with backoff and jitter, proves the path while the WebSocket carries everything, and at the
// third snapshot swaps at one instant (`__fast:on { last }`). The session polls, so the keepalive and the
// retries run on its frames.
#pragma once

#include "GenexCore/AuthoritySchema.h"
#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexFastClient.h"
#include "GenexCore/GenexInput.h"
#include "GenexCore/GenexJson.h"

#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace genex::fast {

/** Applied snapshots a seat's settle trail keeps (fast-session.ts SETTLE_ACK_TRAIL). */
constexpr std::size_t kSettleAckTrail = 64;

/** Your inputs' ack as the WebSocket's entity list knows it (fast-session.ts settleAckTrail, §17.12 *Client*),
 *  for the rule that drops a projectile prediction whose firing input is acknowledged and whose id that list
 *  lacks (the session's SettleShots). A snapshot's `inAck` runs ahead of the list: the launch an input made
 *  comes by WebSocket, which can land after the snapshot of the same tick. So the trail keeps each applied
 *  snapshot's tick and ack, and a list as of a tick is current with the ack of the newest snapshot at or before
 *  it. Past kSettleAckTrail entries the oldest go without raising the floor. Held to fast-transport.json's
 *  `settleAck` vectors. */
class GENEX_CORE_API SettleAckTrail {
 public:
  /** A snapshot of `tick` was applied; the channel's ack is now `ack`. */
  void Snapshot(double tick, int ack);
  /** The ack a list as of `tick` (the WebSocket's latest) is current with; never less than before. */
  int Through(double tick);
  /** A new link: nothing kept, the list current with `floor`. */
  void Reset(int floor);

 private:
  struct Entry {
    double tick = 0;
    int ack = 0;
  };
  std::vector<Entry> trail_;
  int floor_ = 0;
};

/** Holds the channel's fields in the decoded state against the WebSocket's (fast-session.ts motionGuard).
 *  The C core decodes a patch straight into the structs, so the session shows the WebSocket's values in
 *  every held field before a poll (Expose), and right after each decode takes the decoded values as the
 *  WebSocket's and puts the channel's back (Cover). */
class GENEX_CORE_API MotionGuard {
 public:
  /** Writes snapshot `changed` and the root tick into `state`, holding every field written. */
  void Write(authority_wire::AuthorityRoomState* state, const std::vector<MotionRecord>& changed, double tick);
  /** Shows the WebSocket's values in the held fields (before a decode). */
  void Expose(authority_wire::AuthorityRoomState* state);
  /** After a decode: the held fields' decoded values are the WebSocket's; the channel's go back; an entity or
   *  seat the patch added while `client` holds its record starts at the record. */
  void Cover(authority_wire::AuthorityRoomState* state, const FastClient* client);
  /** Every held field takes the WebSocket's latest value; true when one changed. */
  bool Release(authority_wire::AuthorityRoomState* state);
  /** Forget every held field (a drop: the reconnect's full state rewrites them). */
  void Forget();
  bool Exposed() const { return exposed_; }
  /** The state's tick as the WebSocket last wrote it (the channel holds the state's own). */
  double WebSocketTick(const authority_wire::AuthorityRoomState* state) const;
  std::size_t HeldRefs() const { return held_.size(); }

 private:
  struct HeldField {
    double fast = 0;
    double ws = 0;
  };
  struct Held {
    RecordKind kind = RecordKind::Entity;
    bool root = false;
    std::string id;
    std::map<std::string, HeldField> fields;
  };
  bool Current(authority_wire::AuthorityRoomState* state, void* ref, const Held& h) const;
  void Hold(void* ref, RecordKind kind, bool root, const std::string& id, const char* field, double value);
  void WriteRecord(authority_wire::AuthorityRoomState* state, const MotionRecord& record);

  std::map<void*, Held> held_;
  bool exposed_ = false;
};

/** What the session gives its fast seat. */
struct FastSeatHost {
  /** The socket opener; empty: the seat never asks for `fast@1`. */
  SocketOpener open;
  /** A millisecond clock for the deadlines and round trips. */
  std::function<double()> now;
  std::function<double()> tickHz;
  /** The input handle's count of inputs sent, and the server's WebSocket ack of them. */
  std::function<int()> sentCount;
  std::function<int()> lastProcessed;
  /** The socket's `seqBase` (the player's), and this seat's session id. */
  std::function<double()> seqBase;
  std::function<std::string()> sessionId;
  /** False from a drop until the reconnect's first state is decoded. */
  std::function<bool()> stateCurrent;
  /** The decoded state (null before the first). */
  std::function<authority_wire::AuthorityRoomState*()> state;
  /** Sends a reliable message. */
  std::function<void(const char* type, const Json& payload)> send;
  /** A clock sample at the room clock `sent` (a snapshot's, the server's sNow when it wrote it), with `rtt`
   *  (< 0: none). */
  std::function<void(double sent, double rtt)> sample;
  /** The session's pass over a new state (what a decoded patch runs). */
  std::function<void()> statePass;
  /** A number in [0, 1) for a retry's jitter (default: a generator seeded from the clock). */
  std::function<double()> random;
};

/** One seat's fast channel across the session's sockets (fast-session.ts fastSeat). */
class GENEX_CORE_API FastSeat {
 public:
  explicit FastSeat(FastSeatHost host);
  ~FastSeat();
  FastSeat(const FastSeat&) = delete;
  FastSeat& operator=(const FastSeat&) = delete;

  const FastSeatStatus& Status() const { return status_; }
  /** The url this socket's binding named; empty before one came. */
  const std::string& BoundUrl() const { return boundUrl_; }
  /** Your inputs' ack, counted as the input handle counts: the channel's while live, the WebSocket's
   *  counted on from the fallback after. */
  int Ack() const;
  /** Your inputs' ack as the WebSocket's entity list knows it (a projectile's settling reads it): Ack() off
   *  the channel; while live, the newest snapshot's at or before the WebSocket's latest tick (SettleAckTrail). */
  int SettleAck();
  /** An input the handle just sent as seq `seq` (its tick field and payload, as sent), and `render`, the
   *  render time it was sent at (RenderStamp). */
  void Sent(int seq, double tick, const Input& input, double render);
  /** After a frame's sends: one datagram for them. */
  void Flush();
  /** At a frame's start: falls back when a deadline passed. */
  void Poll();
  /** Every datagram the socket received (after the C core's poll). */
  void Receive();
  /** Input `seq` (handle-counted) while the channel still holds it. */
  const FastInput* InputAt(int seq) const;
  /** The reliable `__fast` message. */
  void OnBind(const Json& message);
  /** The server's `__fast:off`. */
  void OnServerOff();
  /** A state was decoded: a binding that waited for it is taken now. */
  void OnState();
  /** The socket dropped: the channel closes; the reconnect gets a new binding. */
  void Dropped();
  /** Whether entity `id`'s motion in the state is the newest snapshot's: always off the channel; while it
   *  is live, only when that snapshot carries the entity's record (§17.12 *Client*). */
  bool MotionKnown(const std::string& id) const {
    return client_ == nullptr || client_->MotionOf(RecordKind::Entity, id) != nullptr;
  }
  /** The channel's client while live (the guard's records). */
  const FastClient* Client() const { return client_.get(); }
  MotionGuard& Guard() { return guard_; }

 private:
  void FallBack(FallbackReason reason);
  void Bind(const Json& message);
  void Applied(const FastSnapshot& s);
  void StartProbe(const std::optional<BindMessage>& bind);
  /** Off the channel for `reason`: the first word of a stretch off it is one fallback, as the line says. */
  void OffChannel(FallbackReason reason);
  void ProbeApplied(const FastSnapshot& s);
  void AbandonProbe(FallbackReason reason);
  void ScheduleRetry();

  FastSeatHost host_;
  FastSeatStatus status_;
  std::unique_ptr<FastClient> client_;
  /** A fresh binding being proven while the WebSocket carries everything, and its snapshots so far. */
  std::unique_ptr<FastClient> probe_;
  int probeApplied_ = 0;
  /** This socket's host offers fresh bindings (its binding said `rev` 2). */
  bool hostReturns_ = false;
  /** Retries since the channel last held. */
  int attempt_ = 0;
  /** When the next `__fast:again` goes. */
  std::optional<double> retryAt_;
  std::optional<double> liveSince_;
  /** The socket's seqBase while live: wire seq = seqBase + handle seq. */
  double linkSeqBase_ = 0;
  struct Fallback {
    int at = 0;
    int wsBefore = 0;
    int ack = 0;
  };
  std::optional<Fallback> fallback_;
  /** The channel's ack, handle-counted. */
  int fastAck_ = 0;
  /** The channel's acks by snapshot tick, for SettleAck. */
  SettleAckTrail settle_;
  /** Inputs sent on this socket before a binding arrived (the first datagram carries them again). */
  std::vector<FastInput> early_;
  std::optional<Json> pendingBind_;
  std::string boundUrl_;
  MotionGuard guard_;
};

}  // namespace genex::fast
