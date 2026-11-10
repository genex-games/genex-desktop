// A predicting room's repeated inputs, as this client reconciles them (PROTOCOL.md §17.11 *Input
// pacing*): the input your entity in the state was stepped through, the upstream throttle that asks for
// one more input of lead after a starve, the clock other seats are drawn on, and the ack your reconciler
// is told while its replay ring cannot hold every input after it. Port of
// packages/multiplayer/src/authority/input-repeat.ts's client half; held to
// packages/netcode-bench/conformance/authority/input-repeat.json (`clients`, `throttle`, `seatClock`,
// `reconcilerAck`) by
// genex_input_repeat_check. Its tunables are AuthoritySchema.h's generated `tuning` constants, never
// retyped here. All of it is the room's setting (`config.inputs.repeat`, input-config.ts): in a room
// whose setting is off the room repeats nothing, and this client reads the plain ack and never throttles.
#pragma once

#include "GenexCore/GenexConfig.h"

#include <optional>
#include <string_view>

namespace genex::input_repeat {

/** A room's input repeat setting (§17.11 *Input pacing*): `On`, a starved seat's held input is
 *  repeated and its client reconciles at `ack + inRep` and throttles; `Off`, the seat holds on a starved
 *  tick and its client reads the plain ack and never throttles. */
enum class InputRepeat { On, Off };

/** The setting as the state's `preset` text (JSON) publishes it in its `inputs` key: `Off` only when the
 *  text says so outright, `On` for anything else (absent: a room without the setting or an older host;
 *  a hostile value: the room's own fields are the truth, and a room that is off writes none). */
GENEX_CORE_API InputRepeat InputRepeatOf(std::string_view presetText);

/** The input your entity in the state was stepped through: `ack` (the room's ackSeq) plus the state's
 *  `inRep` for your seat when that is a non-negative integer (anything else reads 0), never past
 *  `sent` and never below `ack`. With the setting `repeat` off, `inRep` is never read: the ack. */
GENEX_CORE_API int SteppedThrough(int ack, double inRep, int sent, InputRepeat repeat);

/** The input the state holds your entity stepped through (input-repeat.ts stateThrough): `ack` plus a
 *  valid `inRep` (a positive integer, else none), not clamped to `sent` (a hitch steps it past the
 *  inputs you sent); a huge `inRep` saturates at INT_MAX. With the setting `repeat` off: the ack. What
 *  ReconcilerAck is handed. */
GENEX_CORE_API int StateThrough(int ack, double inRep, InputRepeat repeat);

/** The input your reconciler compares the state with your prediction at, given the one it compared at
 *  last (`held`; input-repeat.ts reconcileThrough), §17.11 *The reconciler's ack*, its hitch clause
 *  alone: `ack` plus a valid `inRep` once you have sent that input. Past what you sent (a hitch drained
 *  your seat's buffer and the room repeated for inputs you have not sent yet) no prediction of yours is
 *  at the state's input, so the reconcile waits at `held`, never past `sent`. With the setting `repeat`
 *  off: the ack. A reconciler is told ReconcilerAck, which applies this clause and then the ring's. */
GENEX_CORE_API int ReconcileThrough(int held, int ack, double inRep, int sent, InputRepeat repeat);

/** A client's upstream throttle: the starve runs it has answered (none before the first reading), the
 *  lead (ms) still owed, the part of the next extra input already paid (`accMs`), and the lead added so
 *  far (`aheadMs`: the input clock runs this far ahead of real time). */
struct InputThrottle {
  std::optional<double> seenRuns;
  double owedMs = 0.0;
  double accMs = 0.0;
  double aheadMs = 0.0;
};

/** A keyframe's `inStarve` and `inBuf` for your seat (NaN = absent): a new starve run with at most the
 *  tuned low buffer owes one step (`stepMs`) of lead, at most one step owed at a time; the first reading
 *  only takes the count. With the setting `repeat` off no reading is taken: nothing is ever owed. */
GENEX_CORE_API void ThrottleState(InputThrottle& t, double inStarve, double inBuf, double stepMs, InputRepeat repeat);

/** A frame `dtMs` long: the extra inputs it sends (0 or more), the owed lead paid the tuned dilation of
 *  real time at a time, each input sent once half of its step has been paid. */
GENEX_CORE_API int ThrottleSteps(InputThrottle& t, double dtMs, double stepMs);

/** The input clock other seats are drawn on: `raw` the input `stepped` plus `drawn` inputs past it plus
 *  the tuned share of the throttle's part-paid extra input, `at` the frame's instant plus that share of
 *  its lead. */
struct SeatLead {
  double raw = 0.0;
  double at = 0.0;
};
GENEX_CORE_API SeatLead SeatLeadClock(double stepped, double drawn, const InputThrottle& t, double stepMs, double frameNow);

/** The ack your reconciler was last told (`shown`) and the inputs sent when it began holding one back
 *  (`heldFrom`; none: not holding), §17.11 *The reconciler's ack*. */
struct ReconcilerAckHold {
  int shown = 0;
  std::optional<int> heldFrom;
};

/** The ack your reconciler is told, from the input the state holds your entity stepped through
 *  (`through`, StateThrough: never clamped to `sent`). The hitch clause first: past `sent` it is the ack
 *  told last, never past `sent` (ReconcileThrough). Then the ring's: that ack `stepped`, unless it
 *  advanced while input `stepped + 1` is in neither the replay ring (`ring` inputs back from `sent`) nor
 *  another copy the reconciler reads (`kept`). Then it stays the ack last told, for at most a ring's
 *  length of sends from the first held ack; the hold is armed again only by an ack within the ring or
 *  one that moved back. A hitch neither arms nor ends a hold. */
GENEX_CORE_API int ReconcilerAck(ReconcilerAckHold& hold, int through, int sent, int ring, bool kept);

}  // namespace genex::input_repeat
