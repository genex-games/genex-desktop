// Movement presets (PROTOCOL.md §17.7), the projectile flight (§17.9) and the number rules of the
// input sanitizer (§17.3). Ported from packages/multiplayer/src/authority/{presets,projectile,numeric}.ts
// (the reference) through
// sdks/godot/addons/genex_multiplayer/authority_presets.gd and
// sdks/unity/Runtime/Core/Authority/Presets.cs. The authority server moves an entity with the same
// step, so the reconciler's prediction matches it by construction.
//
// Determinism rules, as the TypeScript keeps them: double arithmetic in the order written there,
// std::sqrt (correctly rounded) and never a hypot, a float32 rounding (Fround, a static_cast<float>:
// IEEE round to nearest, ties to even, exactly Math.fround) at precisely the points Math.fround
// appears, and no floating-point contraction (GENEX_FP_STRICT_BEGIN/END around every function doing
// preset arithmetic; never -ffast-math). Held bit for bit to
// packages/netcode-bench/conformance/authority/presets/topdown.json, projectile.json and sincos.json (the
// portable sine and cosine) by genex_presets_check (sdks/unreal/core/tools/presets_check.cpp) and the
// Genex.Multiplayer.Presets, Projectile and Sincos automation tests (the same vectors under UBT's flags).
//
// Engine-free and allocation-free per step: PredictionFor parses the room's preset text once (it
// allocates while parsing); Prediction::Step and everything in genex::presets never allocate.
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexFirstperson.h"
#include "GenexCore/GenexVehicle.h"

#include <cstdint>
#include <optional>
#include <string_view>

namespace genex {

class Json;
struct Input;

namespace authority_wire {
struct AuthorityEntity;
struct AuthorityInput;
}  // namespace authority_wire

/** `topdown` parameters. */
struct TopdownParams {
  /** Movement speed, world units per second. */
  double speed = 6.0;
  /** Half the arena's side: x and y stay within [-arena, arena]. */
  double arena = 20.0;
};

/** The body a `topdown` step reads and writes. */
struct TopdownBody {
  double x = 0.0;
  double y = 0.0;
  /** Aim, radians. */
  double yaw = 0.0;
};

/** A projectile's launch (PROTOCOL.md §17.9), as the server writes it once: the entity's float32
 *  position and velocity, its gravity (units/s², down along −z) and its launch tick `t0` (an integer,
 *  0 = not a projectile; a client's own prediction carries the fractional tick it was fired at). */
struct ProjectileLaunch {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double vx = 0.0;
  double vy = 0.0;
  double vz = 0.0;
  double g = 0.0;
  double t0 = 0.0;
};

/** A projectile at one instant. */
struct ProjectileState {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double vx = 0.0;
  double vy = 0.0;
  double vz = 0.0;
};

namespace presets {

/** The `topdown` preset's name. Preset names are append-only. */
inline constexpr char kTopdown[] = "topdown";
/** The longest step a preset simulates (seconds); a longer dt is cut to it. */
inline constexpr double kMaxDtSeconds = 0.25;
/** Largest magnitude an authority number may carry; past it an angle is unusable. */
inline constexpr double kMaxAbs = 1e9;
/** A bitmask (`buttons`, `flags`) is an integer in [0, 2^24). */
inline constexpr double kMaskLimit = 16777216.0;
/** TOPDOWN_DEFAULTS. */
inline constexpr TopdownParams kTopdownDefaults{};

/** `v` rounded to float32 and read back as a double (Math.fround). */
GENEX_CORE_API double Fround(double v);
/** -0 → 0, so an unchanged value never re-sends. */
GENEX_CORE_API double UnsignedZero(double v);
/** `v` clamped to [lo, hi] (numeric.ts `clamp`: `v < lo ? lo : v > hi ? hi : v`). */
GENEX_CORE_API double Clamp(double v, double lo, double hi);
/** A move axis: non-finite → 0, clamped to [-1, 1], float32. */
GENEX_CORE_API double Axis(double v);
/** An angle in radians wrapped to [-π, π) as float32; nullopt when it is not finite or past kMaxAbs.
 *  A result that rounds to float32(π) is written as -float32(π), so one heading has one wire value. */
GENEX_CORE_API std::optional<double> WrappedAngle(double v);
/** A bitmask: an integer in [0, 2^24), else 0 (-0 reads as 0, as Godot's and Unity's ports). */
GENEX_CORE_API double Mask(double v);
/** A step length in seconds: non-finite or ≤ 0 → 0, capped at `max`. */
GENEX_CORE_API double StepSeconds(double v, double max);

/** §17.7's portable sine and cosine of a float64 angle, `{psin(a), pcos(a)}`, from one reduction: the
 *  same bits in every engine (std::sin and std::cos are not: they differ in the last bit between C
 *  libraries, and clang may fold or fuse them). Cody–Waite reduction by π/2 with fdlibm's three-part
 *  split of π/2, then fdlibm's kernels in Horner form, the tail argument dropped; only + − ×, floor and
 *  one exact division by 4, in the order written, unfused (GENEX_FP_STRICT). An angle that is not finite,
 *  or past ±1e9, is read as 0 (sine 0, cosine 1); a −0 result is 0. Held bit for bit to
 *  packages/netcode-bench/conformance/authority/presets/sincos.json. */
struct SinCos {
  double sin = 0.0;
  double cos = 1.0;
};
GENEX_CORE_API SinCos PSinCos(double a);
/** psin(a): PSinCos(a).sin. */
GENEX_CORE_API double PSin(double a);
/** pcos(a): PSinCos(a).cos. */
GENEX_CORE_API double PCos(double a);
/** §17.7's sine and cosine constants by name (invpio2, pio2_1, pio2_2, pio2_2t, S1..S6, C1..C6), for the
 *  checks that pin their bits; NaN for any other name. */
GENEX_CORE_API double SinCosConstant(std::string_view name);

/** Whether `params` is acceptable for topdown (presets.ts presetParamsValid): absent (nullptr), or a
 *  JSON object whose every key is a topdown parameter with a number in its range. */
GENEX_CORE_API bool TopdownParamsValid(const Json* params);
/** topdown parameters from a room's `preset.params` (nullptr: absent): defaults for anything unset
 *  or invalid, key by key. */
GENEX_CORE_API TopdownParams ResolveTopdownParams(const Json* params);

/**
 * One fixed topdown step. Pure: returns the next body. A NaN input field means "unusable", like an
 * absent one in the TypeScript reference.
 *  - moveX, moveY: non-finite → 0, clamped to [-1, 1], float32; a vector longer than 1 is scaled to 1;
 *  - dt: non-finite or ≤ 0 → 0, capped at kMaxDtSeconds;
 *  - x' = fround(clamp(x + moveX * scale * speed * dt, -arena, arena)), y' likewise;
 *  - yaw' = the input yaw wrapped to [-π, π) as float32, or the previous yaw when it is not usable.
 */
GENEX_CORE_API TopdownBody StepTopdown(const TopdownBody& body, double moveX, double moveY, double yaw, double dt,
                                       const TopdownParams& params);
/** One fixed topdown step under a (sanitized) input. */
GENEX_CORE_API TopdownBody StepTopdown(const TopdownBody& body, const Input& input, double dt,
                                       const TopdownParams& params);

/** Largest launch tick (`t0` is an integer in [0, kMaxProjectileTick]; 0 = not a projectile). */
inline constexpr double kMaxProjectileTick = 4294967295.0;
/** Largest downward acceleration a projectile may carry, units/s² (`g` is in [0, kMaxProjectileG]). */
inline constexpr double kMaxProjectileG = 1000.0;

/**
 * Where a projectile launched as `launch` is at tick `tick` (whole or fractional), in a room at
 * `tickHz` (projectile.ts projectileAt, PROTOCOL.md §17.9). Pure; double arithmetic in this order,
 * each operation rounded on its own (no FMA), only + − × ÷:
 *  1. s = (tick − t0) / tickHz; non-finite or negative → 0 (before its launch it sits at its origin);
 *  2. x' = float32(x + vx·s), y' = float32(y + vy·s);
 *  3. z' = float32(((z + (vz·s)) − (((0.5·g)·s)·s)));
 *  4. vx' = vx, vy' = vy, vz' = float32(vz − g·s);
 *  5. a −0 result is written as 0.
 * The launch values are the entity's float32 fields (read them as they are; nothing here rounds them).
 */
GENEX_CORE_API ProjectileState ProjectileAt(const ProjectileLaunch& launch, double tick, double tickHz);
/** The room's tick at server time `serverNowMs` (the room clock, ms), fractional:
 *  `((serverNow − tickOrigin) · tickHz) / 1000`. `tickOrigin` is AuthorityRoomState.tickOrigin. */
GENEX_CORE_API double ServerTick(double serverNowMs, double tickOrigin, double tickHz);
/** Tick `tick`'s nominal instant on the room clock, ms: `tickOrigin + (tick · 1000) / tickHz`. */
GENEX_CORE_API double TickInstant(double tick, double tickOrigin, double tickHz);
/** A predicted launch value as the server will write it (session.ts shotNumber): float32, a
 *  non-finite one 0, −0 as 0. */
GENEX_CORE_API double LaunchNumber(double v);
/** A predicted gravity as the server will write it: LaunchNumber, clamped to [0, kMaxProjectileG]. */
GENEX_CORE_API double LaunchGravity(double g);

}  // namespace presets

/** The movement presets this port predicts with. */
enum class PresetKind : std::uint8_t { None, Topdown, Firstperson, Vehicle };

/**
 * How the own entity is predicted, from the room's `preset` text (AuthorityRoomState.preset,
 * `{"name":…,"params":{…}}`). Known() is false when the room runs no preset this port knows (only the
 * exact names "topdown", "firstperson" and "vehicle" are known): the own entity is then drawn from the
 * server's state, unpredicted. A firstperson or vehicle prediction steps through the collision world it
 * was built with; it is the server's step only while that world's hash is the room's `params.world`
 * (WorldMatches()), and a session predicts with it only then (PROTOCOL.md §17.7).
 *
 * Step() is the reconciler's step (also from its manual pump): advance the C core's predicted mirror
 * (an AuthorityEntity, GenexCore/AuthoritySchema.h) by one fixed step of `dt` seconds. Only the fields
 * Fields() names are mirrored (schema names, for colyseus_reconciler_options_t.fields): the step writes
 * them all but `cap`, which a firstperson or vehicle step only reads (the mirror holds the server's
 * value, so a replay steps with it).
 */
class GENEX_CORE_API Prediction {
 public:
  /** Unknown: no prediction. */
  Prediction() = default;
  /** topdown with these parameters (PredictionFor resolves them from the room's preset text). */
  static Prediction ForTopdown(const TopdownParams& params);
  /** firstperson with these parameters, through `world` (nullptr: the empty world). */
  static Prediction ForFirstperson(const FirstpersonParams& params, FirstpersonWorldPtr world);
  /** vehicle with these parameters, through `world` (nullptr: the empty world). */
  static Prediction ForVehicle(const VehicleParams& params, FirstpersonWorldPtr world);

  bool Known() const { return kind_ != PresetKind::None; }
  PresetKind Kind() const { return kind_; }
  /** The preset's name ("topdown", "firstperson", "vehicle"), or "" when unknown. */
  const char* Name() const;
  /** The resolved topdown parameters (the defaults when the preset is not topdown). */
  const TopdownParams& Topdown() const { return topdown_; }
  /** The resolved firstperson parameters (the defaults when the preset is not firstperson). */
  const FirstpersonParams& Firstperson() const { return firstperson_; }
  /** The resolved vehicle parameters (the defaults when the preset is not vehicle). */
  const VehicleParams& Vehicle() const { return vehicle_; }
  /** The world a firstperson or vehicle prediction steps through (null for any other). */
  const FirstpersonWorldPtr& World() const { return world_; }
  /** Whether the preset steps through a collision world (firstperson, vehicle). */
  bool HasWorld() const { return kind_ == PresetKind::Firstperson || kind_ == PresetKind::Vehicle; }
  /** The room's world hash (`params.world`, an exact u32) for a preset with a world, else nullopt. */
  std::optional<std::uint32_t> RoomWorld() const;
  /** True unless the preset has a world whose hash is not World()'s. */
  bool WorldMatches() const;
  /** The same preset through another world (firstperson, vehicle; any other is returned as is). */
  Prediction WithWorld(FirstpersonWorldPtr world) const;
  /** The pitch limit a drawn pitch is held to: float32(pitchLimit) for firstperson, else π. */
  double PitchLimit() const;

  /** The entity fields the step mirrors, in schema order; FieldCount() of them (0 when unknown). */
  const char* const* Fields() const;
  int FieldCount() const;

  /** Step the mirror under an input already sanitized as the server sanitizes (Input::Sanitized()).
   *  Does nothing when the preset is unknown. Never allocates. */
  void Step(authority_wire::AuthorityEntity& mirror, const Input& sanitized, double dt) const;
  /** Step the mirror under the input exactly as sent (the reconciler's command): sanitized here first,
   *  as the server does before its own step. */
  void Step(authority_wire::AuthorityEntity& mirror, const authority_wire::AuthorityInput& command, double dt) const;

 private:
  PresetKind kind_ = PresetKind::None;
  TopdownParams topdown_;
  FirstpersonParams firstperson_;
  VehicleParams vehicle_;
  FirstpersonWorldPtr world_;
};

/** The prediction a room's `preset` text names (unknown for "", unparsable text, a non-object, or a
 *  name this port has no step for); a firstperson or vehicle one steps through `world` (nullptr: the
 *  empty world), whether or not it is the room's (check WorldMatches()). */
GENEX_CORE_API Prediction PredictionFor(std::string_view presetText, FirstpersonWorldPtr world = nullptr);

}  // namespace genex
