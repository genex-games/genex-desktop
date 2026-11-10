// See GenexInputRepeat.h (input-repeat.ts's client half).
#include "GenexCore/GenexInputRepeat.h"

#include "GenexCore/AuthoritySchema.h"
#include "GenexCore/GenexJson.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace genex::input_repeat {

namespace tuning = genex::authority_wire::tuning;

InputRepeat InputRepeatOf(std::string_view presetText) {
  const std::optional<Json> spec = Json::Parse(presetText);
  const Json* inputs = spec && spec->IsObject() ? spec->Find("inputs") : nullptr;
  const Json* repeat = inputs != nullptr && inputs->IsObject() ? inputs->Find("repeat") : nullptr;
  const bool off = repeat != nullptr && repeat->IsString() && repeat->AsString() == "off";
  return off ? InputRepeat::Off : InputRepeat::On;
}

int SteppedThrough(int ack, double inRep, int sent, InputRepeat repeat) {
  if (repeat == InputRepeat::Off) return ack;
  const bool valid = std::isfinite(inRep) && inRep > 0 && std::floor(inRep) == inRep;
  // A huge inRep stops at what was sent; compared as doubles so no cast overflows.
  const double through = valid ? std::min(static_cast<double>(ack) + inRep, static_cast<double>(sent)) : ack;
  return std::max(ack, static_cast<int>(through));
}

int StateThrough(int ack, double inRep, InputRepeat repeat) {
  if (repeat == InputRepeat::Off) return ack;
  const bool valid = std::isfinite(inRep) && inRep > 0 && std::floor(inRep) == inRep;
  if (!valid) return ack;
  // A huge inRep saturates at INT_MAX (past anything sent); summed as doubles so no cast overflows.
  return static_cast<int>(std::min(static_cast<double>(ack) + inRep, static_cast<double>(std::numeric_limits<int>::max())));
}

namespace {
/** The hitch clause: `through` once it is sent, else `held`, never past `sent`. */
int WaitPastSent(int held, int through, int sent) { return through <= sent ? through : std::min(held, sent); }
}  // namespace

int ReconcileThrough(int held, int ack, double inRep, int sent, InputRepeat repeat) {
  if (repeat == InputRepeat::Off) return ack;
  return WaitPastSent(held, StateThrough(ack, inRep, repeat), sent);
}

void ThrottleState(InputThrottle& t, double inStarve, double inBuf, double stepMs, InputRepeat repeat) {
  if (repeat == InputRepeat::Off || !std::isfinite(inStarve)) return;
  const bool fresh = t.seenRuns.has_value() && inStarve > *t.seenRuns;
  t.seenRuns = inStarve;
  if (!fresh || !(stepMs > 0)) return;
  const double buffered = std::isfinite(inBuf) ? inBuf : 0.0;
  if (buffered <= tuning::kThrottleLowInputs) t.owedMs = std::max(t.owedMs, stepMs);
}

int ThrottleSteps(InputThrottle& t, double dtMs, double stepMs) {
  if (!(stepMs > 0) || !(dtMs > 0) || t.owedMs <= 0) return 0;
  const double add = std::min(t.owedMs, dtMs * tuning::kThrottleDilation);
  t.owedMs -= add;
  t.accMs += add;
  t.aheadMs += add;
  // Sent halfway through the dilation, not at its end: the extra input is then never more than half a
  // step off the throttled clock, which the drawing eases.
  const double steps = std::floor(t.accMs / stepMs + 0.5);
  t.accMs -= steps * stepMs;
  return static_cast<int>(steps);
}

SeatLead SeatLeadClock(double stepped, double drawn, const InputThrottle& t, double stepMs, double frameNow) {
  const double part = stepMs > 0 ? t.accMs / stepMs : 0.0;
  return SeatLead{stepped + drawn + tuning::kThrottleSeatLead * part, frameNow + tuning::kThrottleSeatLead * t.aheadMs};
}

int ReconcilerAck(ReconcilerAckHold& hold, int through, int sent, int ring, bool kept) {
  const int stepped = WaitPastSent(hold.shown, through, sent);
  if (stepped <= hold.shown) {
    if (stepped < hold.shown) hold.heldFrom.reset();
    hold.shown = stepped;
    return stepped;
  }
  const bool whole = stepped == sent || sent - (stepped + 1) < ring || kept;
  if (whole) {
    hold.heldFrom.reset();
    hold.shown = stepped;
    return stepped;
  }
  if (!hold.heldFrom) hold.heldFrom = sent;
  if (sent - *hold.heldFrom < ring) return hold.shown;
  hold.shown = stepped;
  return stepped;
}

}  // namespace genex::input_repeat
