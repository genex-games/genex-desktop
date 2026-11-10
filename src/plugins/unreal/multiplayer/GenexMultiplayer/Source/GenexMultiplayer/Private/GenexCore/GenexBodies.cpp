// Drawing a physics body (PROTOCOL.md §17.10 *Drawing*): see GenexBodies.h. Every function follows
// packages/netcode-bench/conformance/authority/physics-draw.reference.mjs in its order of operations,
// unfused, so a port's last bits differ from the reference only where libm's sin, cos, atan2, exp do.
#include "GenexCore/GenexBodies.h"

#include <cmath>

GENEX_FP_STRICT_BEGIN

namespace genex::bodies {

double Dequantize(std::uint32_t q, double min, double max) {
  return min + (static_cast<double>(q) / kQuantizedSpan) * (max - min);
}

Quat Mul(const Quat& a, const Quat& b) {
  Quat r;
  r.x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  r.y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  r.z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  r.w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  return r;
}

Quat Conjugate(const Quat& q) {
  Quat r;
  r.x = -q.x;
  r.y = -q.y;
  r.z = -q.z;
  r.w = q.w;
  return r;
}

Quat Normalize(const Quat& q) {
  const double len = std::sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (len == 0.0) return Quat();
  Quat r;
  r.x = q.x / len;
  r.y = q.y / len;
  r.z = q.z / len;
  r.w = q.w / len;
  return r;
}

Quat AxisAngle(const Vec3& axis, double angle) {
  const double s = std::sin(angle / 2.0);
  Quat r;
  r.x = axis.x * s;
  r.y = axis.y * s;
  r.z = axis.z * s;
  r.w = std::cos(angle / 2.0);
  return r;
}

Quat SlerpFromIdentity(const Quat& dq, double k) {
  const double s = std::sqrt(dq.x * dq.x + dq.y * dq.y + dq.z * dq.z);
  if (s == 0.0) return Quat();
  const double theta = 2.0 * std::atan2(s, dq.w);
  Vec3 axis;
  axis.x = dq.x / s;
  axis.y = dq.y / s;
  axis.z = dq.z / s;
  return AxisAngle(axis, k * theta);
}

BodyState StateOf(double patchTick, const BodyFields& f) {
  BodyState s;
  s.tick = patchTick + 1.0;
  s.p.x = f.x;
  s.p.y = f.y;
  s.p.z = f.z;
  Quat q;
  q.x = f.qx;
  q.y = f.qy;
  q.z = f.qz;
  q.w = f.qw;
  s.q = Normalize(q);
  s.lv.x = f.lvx;
  s.lv.y = f.lvy;
  s.lv.z = f.lvz;
  s.av.x = f.avx;
  s.av.y = f.avy;
  s.av.z = f.avz;
  s.sleep = f.sleep;
  s.epoch = f.epoch;
  return s;
}

double ServerTickAt(double serverNowMs, double tickOrigin, double tickHz) {
  return ((serverNowMs - tickOrigin) * tickHz) / 1000.0;
}

double ExtrapolationSeconds(const BodyState& state, double serverTick, double tickHz) {
  if (state.sleep || !(tickHz > 0.0)) return 0.0;
  const double d = (serverTick - state.tick) / tickHz;
  const double cap = kExtrapolateMaxMs / 1000.0;
  const double back = -kExtrapolateBackTicks / tickHz;
  if (d < back) return back;
  return d > cap ? cap : d;
}

Pose Extrapolate(const BodyState& state, double serverTick, double tickHz, double lengthUnit) {
  const double d = ExtrapolationSeconds(state, serverTick, tickHz);
  Pose out;
  out.p.x = state.p.x + state.lv.x * lengthUnit * d;
  out.p.y = state.p.y + state.lv.y * lengthUnit * d;
  out.p.z = state.p.z + state.lv.z * lengthUnit * d;
  const Vec3& av = state.av;
  const double rate = std::sqrt(av.x * av.x + av.y * av.y + av.z * av.z);
  if (rate == 0.0 || d == 0.0) {
    out.q = state.q;
    return out;
  }
  Vec3 axis;
  axis.x = av.x / rate;
  axis.y = av.y / rate;
  axis.z = av.z / rate;
  out.q = Normalize(Mul(AxisAngle(axis, rate * d), state.q));
  return out;
}

bool BodyDrawer::Receive(const BodyState& state, double atMs, bool spawned, const BodyRoom& room) {
  const bool snap = spawned || !has_ || state.epoch != state_.epoch;
  if (!snap) {
    const Pose old = Draw(atMs, room);
    const Pose next = Extrapolate(state, ServerTickAt(atMs, room.tickOrigin, room.tickHz), room.tickHz, room.lengthUnit);
    Vec3 dp;
    dp.x = old.p.x - next.p.x;
    dp.y = old.p.y - next.p.y;
    dp.z = old.p.z - next.p.z;
    if (!(std::sqrt(dp.x * dp.x + dp.y * dp.y + dp.z * dp.z) > room.lengthUnit * kSnapMetres)) {
      Quat dq = Mul(old.q, Conjugate(next.q));
      if (dq.w < 0.0) {
        dq.x = -dq.x;
        dq.y = -dq.y;
        dq.z = -dq.z;
        dq.w = -dq.w;
      }
      state_ = state;
      at_ = atMs;
      dp_ = dp;
      dq_ = dq;
      return false;
    }
  }
  has_ = true;
  state_ = state;
  at_ = atMs;
  dp_ = Vec3();
  dq_ = Quat();
  return true;
}

Pose BodyDrawer::Draw(double atMs, const BodyRoom& room) const {
  if (!has_) return Pose();
  const Pose e = Extrapolate(state_, ServerTickAt(atMs, room.tickOrigin, room.tickHz), room.tickHz, room.lengthUnit);
  const double age = atMs - at_;
  const double k = std::exp(-(age < 0.0 ? 0.0 : age) / kCorrectionTauMs);
  Pose out;
  out.p.x = e.p.x + dp_.x * k;
  out.p.y = e.p.y + dp_.y * k;
  out.p.z = e.p.z + dp_.z * k;
  out.q = Mul(SlerpFromIdentity(dq_, k), e.q);
  return out;
}

}  // namespace genex::bodies

GENEX_FP_STRICT_END
