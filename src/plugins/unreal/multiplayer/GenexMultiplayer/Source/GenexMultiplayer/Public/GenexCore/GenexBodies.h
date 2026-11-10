// Drawing a physics body (PROTOCOL.md §17.10 *State* and *Drawing*): the server alone steps physics,
// and a client draws each body entity at the server's present, extrapolated on the room clock from the
// latest state the server sent, with a newer state's correction eased out over 100 ms and a snap on an
// epoch change, an offset over one metre, or a body that just got its descriptor. No body is predicted
// and no physics is stepped here.
//
// Ported from packages/netcode-bench/conformance/authority/physics-draw.reference.mjs (written from the
// PROTOCOL text) and held to its vectors, physics-draw.json, within the file's tolerance by
// genex_physics_draw_check (sdks/unreal/core/tools/physics_draw_check.cpp). The time axis is the ROOM
// clock (§16.1's serverNow, ms) for both a state's arrival and a render instant, as in the reference:
// the correction's age and the extrapolation's Δ are read off the same clock.
//
// Engine-free, allocation-free, and pure: the session (GenexAuthoritySession.cpp) keeps one BodyDrawer
// per body and feeds it each patch that carries a newer state.
#pragma once

#include "GenexCore/GenexConfig.h"

#include <cstdint>

namespace genex::bodies {

/** A client extrapolates a body at most this far past its latest state (BODY_EXTRAPOLATE_MAX_MS). */
inline constexpr double kExtrapolateMaxMs = 250.0;
/** A state that arrives before its own tick is moved back at most this many ticks (it lands up to one
 *  early: tick t is stepped at its instant and its state is the body at t + 1). */
inline constexpr double kExtrapolateBackTicks = 1.0;
/** A correction's offset decays as e^(−age / kCorrectionTauMs) (BODY_CORRECTION_TAU_MS). */
inline constexpr double kCorrectionTauMs = 100.0;
/** A correction over this many metres (times lengthUnit, in room units) snaps instead (BODY_SNAP_METRES). */
inline constexpr double kSnapMetres = 1.0;
/** A quantized body field's integer steps across its symmetric range (2^16 − 2): 0 decodes exactly. */
inline constexpr double kQuantizedSpan = 65534.0;
/** `qx qy qz qw`: [−1, 1]. */
inline constexpr double kOrientationMin = -1.0;
inline constexpr double kOrientationMax = 1.0;
/** `lvx lvy lvz` (metres per second) and `avx avy avz` (rad/s): [−64, 64]. */
inline constexpr double kVelocityMin = -64.0;
inline constexpr double kVelocityMax = 64.0;

struct Vec3 {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

/** A quaternion [x, y, z, w]; ⊗ is the Hamilton product. */
struct Quat {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double w = 1.0;
};

/** A drawn pose: position in room units, orientation a unit quaternion (z up, caller frame). */
struct Pose {
  Vec3 p;
  Quat q;
};

/** The body fields of an entity as they arrive (§17.10 *State*): x y z the float32 position, the
 *  quantized fields already decoded to float64 (the Colyseus decoder's colyseus_dequantize, or
 *  Dequantize below from the wire integers), the sleep flag and the entity's epoch. */
struct BodyFields {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double qx = 0.0;
  double qy = 0.0;
  double qz = 0.0;
  double qw = 0.0;
  double lvx = 0.0;
  double lvy = 0.0;
  double lvz = 0.0;
  double avx = 0.0;
  double avy = 0.0;
  double avz = 0.0;
  bool sleep = false;
  double epoch = 0.0;
};

/** A body state off one patch: the patch's tick `t` means the body at tick t + 1 (`tick` holds t + 1),
 *  its orientation normalized (length 0 is the identity), velocities as decoded. */
struct BodyState {
  double tick = 0.0;
  Vec3 p;
  Quat q;
  /** Linear velocity, metres per second (times lengthUnit for room units). */
  Vec3 lv;
  /** Angular velocity, rad/s, in world axes. */
  Vec3 av;
  bool sleep = false;
  double epoch = 0.0;
};

/** The value a client decodes from a quantized field's wire integer: min + (q / 65534) · (max − min),
 *  in float64, unfused (Colyseus schema 5's colyseus_dequantize). */
GENEX_CORE_API double Dequantize(std::uint32_t q, double min, double max);

/** Hamilton product a ⊗ b. */
GENEX_CORE_API Quat Mul(const Quat& a, const Quat& b);
/** The conjugate (the inverse of a unit quaternion). */
GENEX_CORE_API Quat Conjugate(const Quat& q);
/** q / |q|; the identity when |q| is 0. */
GENEX_CORE_API Quat Normalize(const Quat& q);
/** The rotation by `angle` (radians) about the unit `axis`. */
GENEX_CORE_API Quat AxisAngle(const Vec3& axis, double angle);
/** slerp(identity, dq, k) for a unit dq with w ≥ 0: the rotation by k · θ about dq's axis,
 *  θ = 2 · atan2(|v|, w); the identity when dq has no vector part. */
GENEX_CORE_API Quat SlerpFromIdentity(const Quat& dq, double k);

/** The body state a patch whose `tick` was `patchTick` carried. */
GENEX_CORE_API BodyState StateOf(double patchTick, const BodyFields& fields);

/** §17.9's serverTick on the room clock: (serverNowMs − tickOrigin) · tickHz / 1000. */
GENEX_CORE_API double ServerTickAt(double serverNowMs, double tickOrigin, double tickHz);

/** Δ seconds past `state`: clamp((serverTick − state.tick) / tickHz, −1 / tickHz, 0.25), and 0 while asleep
 *  (back a tick at most: the patch after a step lands up to a tick before its state's instant). */
GENEX_CORE_API double ExtrapolationSeconds(const BodyState& state, double serverTick, double tickHz);

/** The state extrapolated to `serverTick`: p + (lv · lengthUnit) · Δ, and q' = normalize(r ⊗ q) with r
 *  the rotation by |av| · Δ about av / |av| (q unchanged when av is 0 or Δ is 0). */
GENEX_CORE_API Pose Extrapolate(const BodyState& state, double serverTick, double tickHz, double lengthUnit);

/** The room a body is drawn in: its tick rate, its lengthUnit (room units per metre) and its tickOrigin
 *  (the room clock's ms at tick 0). */
struct BodyRoom {
  double tickHz = 30.0;
  double lengthUnit = 1.0;
  double tickOrigin = 0.0;
};

/**
 * One body as a client draws it (§17.10 *Drawing*): its latest state, the room-clock instant that state
 * arrived, and the offset that arrival left (position dp, orientation dq, both decaying with
 * k = e^(−age / 100 ms)). Receive each newer state as it arrives; Draw at any render instant.
 */
class GENEX_CORE_API BodyDrawer {
 public:
  /** A newer state arrives at room-clock `atMs`. `spawned`: the body's first state since it got its
   *  descriptor (snaps). Also snaps on its first state, an epoch change, or a position offset over
   *  kSnapMetres · lengthUnit; otherwise the offset is the pose drawn from the older state at `atMs`
   *  less the newer state's pose at the same instant (dq on the short way round, w ≥ 0). Returns true
   *  when it snapped. */
  bool Receive(const BodyState& state, double atMs, bool spawned, const BodyRoom& room);

  /** The pose drawn at room-clock instant `atMs`: the latest state extrapolated there, plus the
   *  decaying offset (position p + dp · k, orientation slerp(identity, dq, k) ⊗ q). The identity at the
   *  origin before any state. */
  Pose Draw(double atMs, const BodyRoom& room) const;

  bool HasState() const { return has_; }
  const BodyState& State() const { return state_; }
  /** The room-clock instant the latest state arrived. */
  double ArrivedAt() const { return at_; }
  /** The position offset the latest arrival left (0 after a snap). */
  const Vec3& Offset() const { return dp_; }

 private:
  bool has_ = false;
  BodyState state_;
  double at_ = 0.0;
  Vec3 dp_;
  Quat dq_;
};

}  // namespace genex::bodies
