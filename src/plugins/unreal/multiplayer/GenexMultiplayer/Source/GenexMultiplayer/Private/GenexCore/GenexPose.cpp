// Port of sdks/rust/genex-multiplayer/src/pose.rs.
#include "GenexCore/GenexPose.h"

#include "GenexCore/GenexProtocol.h"

#include <algorithm>
#include <cmath>

namespace genex::pose_detail {

constexpr double kPoseTwoPi = 6.283185307179586476925286766559;
constexpr double kPosePi = 3.141592653589793238462643383279;

constexpr const char* kNumericPoseKeys[7] = {"x", "y", "z", "yaw", "vx", "vy", "vz"};

struct PoseAxis {
  const char* axis;
  const char* vel;
};
constexpr PoseAxis kPoseAxes[3] = {{"x", "vx"}, {"y", "vy"}, {"z", "vz"}};

/** A finite number at `key`, else 0 (Rust `num`). */
double PoseNum(const Json& o, const char* key) {
  const Json* v = o.Find(key);
  if (v == nullptr || !v->IsNumber()) return 0.0;
  const double n = v->AsNumber();
  return std::isfinite(n) ? n : 0.0;
}

void PutPoseOptional(Json& out, const char* key, const std::optional<double>& v) {
  if (v) out.Set(key, *v);
}

}  // namespace genex::pose_detail

namespace genex {

bool ValidPoseNumber(double v) { return std::isfinite(v) && std::fabs(v) <= protocol::limits::kMaxPoseAbs; }

bool PoseFields::IsValid() const {
  const std::optional<double>* nums[7] = {&x, &y, &z, &yaw, &vx, &vy, &vz};
  for (const std::optional<double>* n : nums) {
    if (n->has_value() && !ValidPoseNumber(**n)) return false;
  }
  return !anim || protocol::Utf16Length(*anim) <= protocol::limits::kMaxAnimChars;
}

bool PoseFields::IsEmpty() const { return !x && !y && !z && !yaw && !vx && !vy && !vz && !anim; }

bool PoseFields::operator==(const PoseFields& other) const {
  return x == other.x && y == other.y && z == other.z && yaw == other.yaw && vx == other.vx && vy == other.vy &&
         vz == other.vz && anim == other.anim;
}

Json PoseFields::ToJson() const {
  Json out = Json::MakeObject();
  pose_detail::PutPoseOptional(out, "x", x);
  pose_detail::PutPoseOptional(out, "y", y);
  pose_detail::PutPoseOptional(out, "z", z);
  pose_detail::PutPoseOptional(out, "yaw", yaw);
  pose_detail::PutPoseOptional(out, "vx", vx);
  pose_detail::PutPoseOptional(out, "vy", vy);
  pose_detail::PutPoseOptional(out, "vz", vz);
  if (anim) out.Set("anim", *anim);
  return out;
}

double WrapAngle(double a) {
  if (!std::isfinite(a)) return 0.0;
  double r = std::fmod(a, pose_detail::kPoseTwoPi);
  if (r <= -pose_detail::kPosePi) {
    r += pose_detail::kPoseTwoPi;
  } else if (r > pose_detail::kPosePi) {
    r -= pose_detail::kPoseTwoPi;
  }
  return r;
}

PoseFields DeriveVelocity(const PoseFields& pose, double t, const VelocityMemory* prev, VelocityMemory* memoryOut) {
  PoseFields out = pose;
  VelocityMemory memory;
  memory.t = t;
  const double dt = prev != nullptr ? t - prev->t : 0.0;
  const bool usable = prev != nullptr && dt > protocol::interpolation::kMinGapMs && dt < protocol::interpolation::kMaxGapMs;
  const std::optional<double>* positions[3] = {&pose.x, &pose.y, &pose.z};
  std::optional<double>* velocities[3] = {&out.vx, &out.vy, &out.vz};
  for (std::size_t i = 0; i < 3; ++i) {
    const std::optional<double>& p = *positions[i];
    if (!p) continue;
    memory.pos[i] = *p;
    if (velocities[i]->has_value()) continue;
    const std::optional<double> before = prev != nullptr ? prev->pos[i] : std::nullopt;
    double v = 0.0;
    if (usable && before) v = (*p - *before) / dt * 1000.0;
    *velocities[i] = ValidPoseNumber(v) ? v : 0.0;
  }
  if (memoryOut != nullptr) *memoryOut = memory;
  return out;
}

Json PoseMap(const std::array<double, 7>& nums, std::string_view anim) {
  Json m = Json::MakeObject();
  for (std::size_t i = 0; i < 7; ++i) {
    m.Set(pose_detail::kNumericPoseKeys[i], std::isfinite(nums[i]) ? nums[i] : 0.0);
  }
  m.Set("anim", anim);
  return m;
}

std::optional<Json> SamplePose(const SampleBuffer& buf, double r) {
  const std::size_t n = buf.size();
  if (n == 0) return std::nullopt;
  std::size_t j = 0;
  while (j < n && buf[j].first <= r) ++j;
  if (j == 0) return buf[0].second;
  if (j >= n) {
    const double bt = buf[n - 1].first;
    const Json& b = buf[n - 1].second;
    Json out = b;
    const double ahead = (std::min)((std::max)(r - bt, 0.0), protocol::interpolation::kMaxExtrapMs) / 1000.0;
    for (const pose_detail::PoseAxis& ax : pose_detail::kPoseAxes) {
      out.Set(ax.axis, pose_detail::PoseNum(b, ax.axis) + pose_detail::PoseNum(b, ax.vel) * ahead);
    }
    if (n >= 2) {
      const double at = buf[n - 2].first;
      const Json& a = buf[n - 2].second;
      const double span = bt - at;
      if (span > 0.0) {
        const double k = (std::min)((std::max)(r - bt, 0.0), protocol::interpolation::kRotExtrapMs) / span;
        const double yb = pose_detail::PoseNum(b, "yaw");
        out.Set("yaw", yb + WrapAngle(yb - pose_detail::PoseNum(a, "yaw")) * k);
      }
    }
    return out;
  }
  const double at = buf[j - 1].first;
  const Json& a = buf[j - 1].second;
  const double bt = buf[j].first;
  const Json& b = buf[j].second;
  const double span = bt - at;
  const double k = span > 0.0 ? (r - at) / span : 1.0;
  Json out = a;
  for (const char* key : pose_detail::kNumericPoseKeys) {
    const double va = pose_detail::PoseNum(a, key);
    const double vb = pose_detail::PoseNum(b, key);
    const bool isYaw = std::string_view(key) == "yaw";
    out.Set(key, isYaw ? va + WrapAngle(vb - va) * k : va + (vb - va) * k);
  }
  return out;
}

Json EasePose(const Json& prev, const Json& target, double aPos, double aRot) {
  Json out = target;
  for (const char* key : pose_detail::kNumericPoseKeys) {
    const Json* pv = prev.Find(key);
    const Json* tv = target.Find(key);
    if (pv == nullptr || tv == nullptr || !pv->IsNumber() || !tv->IsNumber()) continue;
    const double p = pv->AsNumber();
    const double t = tv->AsNumber();
    if (!std::isfinite(p) || !std::isfinite(t)) continue;
    const bool isYaw = std::string_view(key) == "yaw";
    out.Set(key, isYaw ? p + WrapAngle(t - p) * aRot : p + (t - p) * aPos);
  }
  return out;
}

}  // namespace genex
