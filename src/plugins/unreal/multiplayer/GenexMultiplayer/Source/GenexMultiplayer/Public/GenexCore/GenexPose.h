// Optional typed pose (PROTOCOL.md §6.6, §10.1): the pure half. Port of
// sdks/rust/genex-multiplayer/src/pose.rs (itself a port of packages/multiplayer/src/pose.ts);
// when the two disagree, the Rust file is the reference and this one is the bug.
//
// Off by default for senders (RelayConnectOptions::pose); receivers always understand a posed player.
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexJson.h"

#include <array>
#include <deque>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

namespace genex {

/** One `__pose` publish. Every field is optional: an absent field keeps the relay's stored value. */
struct GENEX_CORE_API PoseFields {
  std::optional<double> x;
  std::optional<double> y;
  std::optional<double> z;
  /** Radians, any finite value. */
  std::optional<double> yaw;
  /** World units per second. Derived from successive poses when left unset. */
  std::optional<double> vx;
  std::optional<double> vy;
  std::optional<double> vz;
  /** At most 64 characters (UTF-16 units). Discrete: never interpolated. */
  std::optional<std::string> anim;

  /** Whether every present value is one the relay accepts (finite, |v| <= 1e9, anim <= 64 chars). */
  bool IsValid() const;
  /** No field set. */
  bool IsEmpty() const;
  /** The wire object: only the present fields (serde's skip_serializing_if = None). */
  Json ToJson() const;

  bool operator==(const PoseFields& other) const;
  bool operator!=(const PoseFields& other) const { return !(*this == other); }
};

/** Finite and |v| <= protocol::limits::kMaxPoseAbs. */
GENEX_CORE_API bool ValidPoseNumber(double v);

/** Map an angle into (-pi, pi]; non-finite reads as 0. */
GENEX_CORE_API double WrapAngle(double a);

/** Sender-side memory for velocity derivation: the last published position and its stamp. */
struct VelocityMemory {
  double t = 0.0;
  std::array<std::optional<double>, 3> pos{};
};

/** Fill in vx/vy/vz the game did not set, from delta-position / delta-t on the sender's clock
 *  (§6.6). A first publish, or a gap outside (5, 2000) ms, derives 0 rather than a spike.
 *  `memoryOut` receives the memory for the next call. */
GENEX_CORE_API PoseFields DeriveVelocity(const PoseFields& pose, double t, const VelocityMemory* prev,
                                         VelocityMemory* memoryOut);

/** A pose sample as a JSON object (the stream representation the interpolator stores).
 *  `nums` is {x, y, z, yaw, vx, vy, vz}; non-finite values read as 0. */
GENEX_CORE_API Json PoseMap(const std::array<double, 7>& nums, std::string_view anim);

/** A stream buffer: (sender-clock stamp, state object), stamps ascending. */
using SampleBuffer = std::deque<std::pair<double, Json>>;

/** §10.1 step 2: sample a posed player's buffer at render time `r`. nullopt when empty. */
GENEX_CORE_API std::optional<Json> SamplePose(const SampleBuffer& buf, double r);

/** §10.1 step 3: output ease. Numbers by `aPos`, `yaw` on the shortest arc by `aRot`, the rest snaps. */
GENEX_CORE_API Json EasePose(const Json& prev, const Json& target, double aPos, double aRot);

}  // namespace genex
