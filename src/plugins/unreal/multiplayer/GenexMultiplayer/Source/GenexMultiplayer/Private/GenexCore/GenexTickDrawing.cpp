// The port of packages/multiplayer/src/authority/tick-drawing.ts. See GenexTickDrawing.h.
#include "GenexCore/GenexTickDrawing.h"

#include <cmath>

namespace genex {

namespace {

/** `next` folded onto `prev` along the short arc (tick-drawing.ts fold). */
double Fold(double prev, double next) { return prev + std::atan2(std::sin(next - prev), std::cos(next - prev)); }

TickPose Lerp(const TickPose& a, const TickPose& b, double u) {
  TickPose out;
  out.x = a.x + (b.x - a.x) * u;
  out.y = a.y + (b.y - a.y) * u;
  out.z = a.z + (b.z - a.z) * u;
  out.yaw = a.yaw + (b.yaw - a.yaw) * u;
  out.pitch = a.pitch + (b.pitch - a.pitch) * u;
  out.duck = a.duck + (b.duck - a.duck) * u;
  return out;
}

}  // namespace

void TickDrawing::Push(const std::string& key, double t, const TickPose& pose, double period, double life) {
  // Deviation: a non-finite instant is ignored (the TypeScript would append it out of order).
  if (!std::isfinite(t)) return;
  std::vector<Sample>& ring = rings_[key];
  const bool has = !ring.empty();
  if (has && t <= ring.back().t) return;
  // A NaN life never equals the last (NaN != NaN, as the TypeScript's ===): a life of its own.
  const bool sameLife = has && ring.back().life == life;
  Sample next;
  next.t = t;
  next.life = life;
  next.pose = pose;
  if (sameLife) {
    const Sample last = ring.back();
    next.pose.yaw = Fold(last.pose.yaw, pose.yaw);
    // Held since the keyframe before: repeat the last sample a period before this one.
    if (t - last.t > period * 1.5) {
      Sample held = last;
      held.t = t - period;
      ring.push_back(held);
    }
  }
  ring.push_back(next);
  if (ring.size() > kRing) ring.erase(ring.begin(), ring.begin() + static_cast<std::ptrdiff_t>(ring.size() - kRing));
}

std::optional<TickDrawn> TickDrawing::At(const std::string& key, double target) const {
  const auto it = rings_.find(key);
  if (it == rings_.end() || it->second.empty()) return std::nullopt;
  const std::vector<Sample>& ring = it->second;
  const Sample& first = ring.front();
  const Sample& last = ring.back();
  TickDrawn out;
  if (target <= first.t) {
    out.pose = first.pose;
    out.life = first.life;
    return out;
  }
  // Deviation: a NaN render time draws the newest sample (the TypeScript would draw NaN).
  if (target >= last.t || std::isnan(target)) {
    out.pose = last.pose;
    out.life = last.life;
    return out;
  }
  std::size_t k = ring.size() - 2;
  while (k > 0 && ring[k].t > target) --k;
  const Sample& a = ring[k];
  const Sample& b = ring[k + 1];
  out.life = a.life;
  // Never across lives: the old one holds until the new one's first sample.
  if (!(a.life == b.life)) {
    out.pose = a.pose;
    return out;
  }
  out.pose = Lerp(a.pose, b.pose, (target - a.t) / (b.t - a.t));
  return out;
}

void TickDrawing::Forget(const std::string& key) { rings_.erase(key); }

void TickDrawing::Clear() { rings_.clear(); }

std::size_t TickDrawing::Count(const std::string& key) const {
  const auto it = rings_.find(key);
  return it == rings_.end() ? 0 : it->second.size();
}

}  // namespace genex
