// The `vehicle` movement preset (PROTOCOL.md §17.7): an arcade car on Rocket League's ground and air
// handling, kept level (no pitch or roll), moving `firstperson`'s axis-aligned hull through the same
// static world of boxes and ramps with that preset's collision procedures (checkGround, traceDown,
// fits, sweep with slab and wedge, slideMove, groundMove, stayOnGround), the slides inside its ground
// move being the car's ground slide. Ported expression for expression from
// packages/multiplayer/src/authority/presets.ts (`stepVehicle`), which the authority server runs, so
// the reconciler's prediction matches the server by construction.
//
// The step lives in GenexFirstperson.cpp beside firstperson's, because both share one set of
// collision procedures (the `Hull` there); firstperson's results are unchanged by the sharing
// (firstperson.json, bit for bit). The heading is body state, so the step turns it with the portable
// sine and cosine (presets::PSinCos, GenexPresets.h), never std::sin/std::cos.
//
// Determinism rules, as GenexFirstperson.h keeps them: double arithmetic in the order §17.7 writes it,
// std::sqrt and std::floor and nothing else beyond + − × ÷ (and psin/pcos), a float32 rounding exactly
// where §17.7 rounds, and no floating-point contraction (GENEX_FP_STRICT_BEGIN/END; never -ffast-math).
// Held bit for bit to packages/netcode-bench/conformance/authority/presets/vehicle.json (with and
// without the broadphase) by genex_presets_check and the Genex.Multiplayer.Vehicle automation test.
//
// Axes: x/y the ground plane, +z up, +yaw turning +x toward +y (counterclockwise seen from above in
// §17.7's right-handed frame). The input's `moveY` is the throttle (below 0 reverses), `moveX` the
// steer: +1 turns right in that frame, toward −yaw. Unreal's views draw Genex (x, y, z) as UE (X, Y, Z)
// and Genex yaw as UE Yaw (both turn X toward Y), but Unreal is left-handed: +Y is to the RIGHT of +X
// seen from above, so a −yaw turn is drawn as a turn to the left. UGenexAuthoritySubsystem's Make
// Vehicle Input takes a steer as the Unreal screen shows it (+1 right) and sends moveX = −steer
// (README "Vehicle").
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexFirstperson.h"

#include <cstdint>

namespace genex {

class Json;
struct Input;
struct PosedWorld;

/** `vehicle` parameters (§17.7's table, in its order). The real-valued ones are used as float32, the
 *  integer ones (the button masks, `substeps`, `world`) exactly. */
struct VehicleParams {
  /** Top speed on the throttle, units/s, before the body's `cap`. */
  double maxSpeed = 1410.0;
  /** Throttle acceleration, units/s². */
  double accel = 1000.0;
  /** Deceleration while the throttle opposes the motion. */
  double brake = 3500.0;
  /** Deceleration with no throttle, and down to the throttle's speed when above it without boost. */
  double coast = 525.0;
  /** Boost's acceleration along the heading, on top of the throttle's. */
  double boostAccel = 1000.0;
  /** Top speed under boost, before `cap`. */
  double boostMaxSpeed = 2300.0;
  /** Fuel burned per second of boost (a full tank is 1: 3 s). */
  double boostBurn = 0.3333333432674408;
  /** Deceleration of the sideways speed on the ground, units/s². */
  double grip = 6000.0;
  /** The same, while drift is held. */
  double driftGrip = 1500.0;
  /** Yaw rate at full steer on the ground, rad/s, at or above `turnSpeed`. */
  double turnRate = 2.2;
  /** The forward speed at which the full turn rate is reached; below it the rate scales with speed. */
  double turnSpeed = 400.0;
  /** How fast the yaw rate follows the steering on the ground, rad/s². */
  double spinAccel = 30.0;
  /** Yaw rate at full steer in the air, rad/s. */
  double airTurnRate = 5.5;
  /** How fast the yaw rate follows the steering in the air, rad/s². */
  double airSpinAccel = 9.0;
  /** Units/s² along −z. */
  double gravity = 650.0;
  /** The `vz` a jump sets. */
  double jumpImpulse = 450.0;
  /** Each velocity axis is clamped to ±this. */
  double maxVelocity = 6000.0;
  /** Half the side of the hull's square footprint. */
  double radius = 50.0;
  /** Hull height. */
  double height = 36.0;
  /** Highest ledge driven up without a jump, and the deepest drop a sub-step follows down. */
  double stepHeight = 8.0;
  /** Least z of a ramp top's unit normal that can be driven on. */
  double standable = 0.7;
  /** How far below the hull's base ground is found. */
  double groundTrace = 4.0;
  /** How far above the hull's base ground is found. */
  double groundSnap = 2.0;
  /** Clearance kept from a surface. */
  double skin = 0.03;
  /** Button masks: any shared bit counts as held; 0 disables. Integers in [0, 2^24). */
  double jumpBit = 1.0;
  double boostBit = 2.0;
  double driftBit = 4.0;
  /** Sub-steps per step, an integer in [1, 8]. */
  double substeps = 2.0;
  /** 1: a jump works at `cap` 0. 0: a press at `cap` 0 is no jump (a freeze time, a kickoff's hold). */
  double capZeroJump = 1.0;
  /** The collision world's hash (FirstpersonWorld::Hash), written by the sandbox: an exact u32. */
  double world = 2615243109.0;
};

/** The body a `vehicle` step reads (`cap` too, which it never writes) and writes. A NaN field reads as
 *  missing (0, or 1 for `cap`), as an absent key does in the TypeScript reference. The step never
 *  touches `pitch` or `duck`, which are not here. */
struct VehicleBody {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double vx = 0.0;
  double vy = 0.0;
  double vz = 0.0;
  /** Heading, radians, +yaw counterclockwise seen from above (z up): body state, not input. */
  double yaw = 0.0;
  /** Yaw rate, rad/s, positive toward +yaw, [−1000, 1000]. */
  double spin = 0.0;
  /** The boost tank, [0, 1]. The module writes it to refuel; the step only burns it. */
  double fuel = 0.0;
  /** Movement bits (vehicle_state): 1 onGround, 4 jumpHeld (the ducking bit is read as 0). */
  double mstate = 0.0;
  /** Multiplier of both top speeds the room module writes, [0, 4]. */
  double cap = 1.0;
};

namespace vehicle_state {
inline constexpr std::uint32_t kOnGround = 1;
inline constexpr std::uint32_t kJumpHeld = 4;
}  // namespace vehicle_state

namespace presets {

/** The `vehicle` preset's name. Preset names are append-only. */
inline constexpr char kVehicle[] = "vehicle";
/** VEHICLE_DEFAULTS. */
inline constexpr VehicleParams kVehicleDefaults{};

/** Whether `params` is acceptable for vehicle (presets.ts presetParamsValid): absent (nullptr), or a JSON
 *  object whose every key is a vehicle parameter with a number in its range (an integer one an integer,
 *  one whose range excludes 0 nonzero as a float32). */
GENEX_CORE_API bool VehicleParamsValid(const Json* params);
/** vehicle parameters from a room's `preset.params` (nullptr: absent): defaults for anything unset or
 *  invalid, key by key. */
GENEX_CORE_API VehicleParams ResolveVehicleParams(const Json* params);

/**
 * One fixed `vehicle` step (§17.7) through `world`. Pure: returns the next x y z vx vy vz yaw spin fuel
 * mstate (and the body's cap, unchanged). The input is applied as handed: `moveY` the throttle,
 * `moveX` the steer (+1 right, toward −yaw), a NaN field unusable (an axis 0, buttons 0). `world` must
 * be the world whose hash is `params.world` for the result to be the server's; the step does not
 * compare them.
 */
GENEX_CORE_API VehicleBody StepVehicle(const VehicleBody& body, double moveX, double moveY, double buttons, double dt,
                                       const VehicleParams& params, const FirstpersonWorld& world,
                                       const PosedWorld* posed = nullptr);
/** One fixed step under an input (already sanitized as the server sanitizes it, for a prediction). `posed`: the
 *  tick's posed solids (GenexPosed.h; §17.7 *Posed solids*), visited after the static world's. */
GENEX_CORE_API VehicleBody StepVehicle(const VehicleBody& body, const Input& input, double dt,
                                       const VehicleParams& params, const FirstpersonWorld& world,
                                       const PosedWorld* posed = nullptr);

}  // namespace presets

}  // namespace genex
