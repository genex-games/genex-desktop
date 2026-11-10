// Movement presets, the projectile flight and the sanitizer's number rules. Source of truth:
// packages/multiplayer/src/authority/{presets,projectile,numeric}.ts; ported as
// sdks/godot/addons/genex_multiplayer/authority_presets.gd and sdks/unity/Runtime/Core/Authority/Presets.cs.
// Every expression below is the TypeScript's, in its order (C++ evaluates `a * b * c * d` left to
// right, as JS does), with a static_cast<float> exactly where Math.fround appears, and contraction
// off (GENEX_FP_STRICT_BEGIN), so clang cannot fuse `x + a * b` into an FMA that JS never rounds as.
#include "GenexCore/GenexPresets.h"

#include "GenexCore/AuthoritySchema.h"
#include "GenexCore/GenexInput.h"
#include "GenexCore/GenexJson.h"

#include <cmath>
#include <limits>
#include <string_view>
#include <utility>

GENEX_FP_STRICT_BEGIN

namespace genex::presets_detail {

/** Math.PI: the double nearest π. */
constexpr double kJsPi = 3.141592653589793;
/** numeric.ts TWO_PI = 2 * Math.PI (exact: a power-of-two scale). */
constexpr double kTwoPi = 2.0 * kJsPi;

struct ParamRange {
  const char* key;
  double TopdownParams::*field;
  double min;
  double max;
  bool positive;
};

/** presets.ts TOPDOWN_RANGE, in its key order (speed, then arena). */
constexpr ParamRange kTopdownRange[] = {
    {"speed", &TopdownParams::speed, 0.0, 1000.0, false},
    {"arena", &TopdownParams::arena, 0.0, 1e6, true},
};

const char* const kTopdownFields[] = {"x", "y", "yaw"};
/** firstperson's written fields, then `cap`, which it only reads (presets.ts FIRSTPERSON_PRESET
 *  fields + reads), in schema order. */
const char* const kFirstpersonFields[] = {"x", "y", "z", "vx", "vy", "vz", "yaw", "pitch", "duck", "mstate", "cap"};
/** vehicle's written fields and `cap`, which it only reads (presets.ts VEHICLE_PRESET fields + reads),
 *  in schema order. */
const char* const kVehicleFields[] = {"x", "y", "z", "vx", "vy", "vz", "yaw", "mstate", "cap", "spin", "fuel"};

// ---- §17.7's portable sine and cosine: the constants, each written by its bits as a hexadecimal
// floating literal (exact by definition, whatever the compiler's decimal parsing; the table's bits are
// pinned against sincos.json's `constants` by genex_presets_check and the Sincos automation test). ----
constexpr double kInvPio2 = 0x1.45f306dc9c883p-1;
constexpr double kPio2_1 = 0x1.921fb54400000p0;
constexpr double kPio2_2 = 0x1.0b4611a600000p-34;
constexpr double kPio2_2t = 0x1.3198a2e037073p-69;
constexpr double kS1 = -0x1.5555555555549p-3;
constexpr double kS2 = 0x1.111111110f8a6p-7;
constexpr double kS3 = -0x1.a01a019c161d5p-13;
constexpr double kS4 = 0x1.71de357b1fe7dp-19;
constexpr double kS5 = -0x1.ae5e68a2b9cebp-26;
constexpr double kS6 = 0x1.5d93a5acfd57cp-33;
constexpr double kC1 = 0x1.555555555554cp-5;
constexpr double kC2 = -0x1.6c16c16c15177p-10;
constexpr double kC3 = 0x1.a01a019cb1590p-16;
constexpr double kC4 = -0x1.27e4f809c52adp-22;
constexpr double kC5 = 0x1.1ee9ebdb4b1c4p-29;
constexpr double kC6 = -0x1.8fae9be8838d4p-37;

struct NamedConstant {
  const char* name;
  double value;
};
constexpr NamedConstant kSinCosConstants[] = {
    {"invpio2", kInvPio2}, {"pio2_1", kPio2_1}, {"pio2_2", kPio2_2}, {"pio2_2t", kPio2_2t},
    {"S1", kS1}, {"S2", kS2}, {"S3", kS3}, {"S4", kS4}, {"S5", kS5}, {"S6", kS6},
    {"C1", kC1}, {"C2", kC2}, {"C3", kC3}, {"C4", kC4}, {"C5", kC5}, {"C6", kC6},
};

bool IsFinite(double v) { return std::isfinite(v); }

double FiniteOrZero(double v) { return IsFinite(v) ? v : 0.0; }

/** The range `key` names, or nullptr (Object.hasOwn(TOPDOWN_RANGE, key)). */
const ParamRange* RangeFor(std::string_view key) {
  for (const ParamRange& range : kTopdownRange) {
    if (key == range.key) return &range;
  }
  return nullptr;
}

/** `typeof v === 'number' && Number.isFinite(v) && min <= v <= max && (!positive || (v > 0 &&
 *  Math.fround(v) > 0))`: a range that excludes 0 excludes it as the step would use the value, as a
 *  float32 (1e-46 is 0 there). */
bool InRange(const Json* value, const ParamRange& range) {
  if (value == nullptr || !value->IsNumber()) return false;
  const double v = value->AsNumber();
  if (!IsFinite(v) || v < range.min || v > range.max) return false;
  return !range.positive || (v > 0.0 && static_cast<double>(static_cast<float>(v)) > 0.0);
}

}  // namespace genex::presets_detail

namespace genex::presets {

double Fround(double v) { return static_cast<double>(static_cast<float>(v)); }

double UnsignedZero(double v) { return v == 0.0 ? 0.0 : v; }

double Clamp(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

double Axis(double v) {
  if (!presets_detail::IsFinite(v)) return 0.0;
  const double clamped = v < -1.0 ? -1.0 : v > 1.0 ? 1.0 : v;
  return UnsignedZero(Fround(clamped));
}

std::optional<double> WrappedAngle(double v) {
  if (!presets_detail::IsFinite(v) || std::fabs(v) > kMaxAbs) return std::nullopt;
  const double wrapped =
      Fround(v - presets_detail::kTwoPi * std::floor((v + presets_detail::kJsPi) / presets_detail::kTwoPi));
  const double f32Pi = Fround(presets_detail::kJsPi);
  return wrapped == f32Pi ? -f32Pi : UnsignedZero(wrapped);
}

double Mask(double v) {
  return presets_detail::IsFinite(v) && v == std::floor(v) && v >= 0.0 && v < kMaskLimit ? UnsignedZero(v) : 0.0;
}

double StepSeconds(double v, double max) {
  if (!presets_detail::IsFinite(v) || v <= 0.0) return 0.0;
  return v > max ? max : v;
}

// numeric.ts psincos, step by step (§17.7 "Portable sine and cosine"). Every expression is written as
// §17.7 writes it and C++ evaluates it left to right by the same precedence; GENEX_FP_STRICT keeps
// `a * invpio2 + 0.5` and every Horner step two roundings (sincos.json's discriminate-fma-* cases land
// on another double when they are fused).
SinCos PSinCos(double a) {
  namespace d = presets_detail;
  SinCos out;
  // 1. An angle that cannot be used is read as 0.
  if (!d::IsFinite(a) || std::fabs(a) > kMaxAbs) return out;
  // 2. The nearest integer to a·2/π by the float64 sum (|n| ≤ 636619773: exact in a double).
  const double n = std::floor(a * d::kInvPio2 + 0.5);
  // 3. The quadrant, exactly (n / 4 is an exact division of an integer-valued double).
  const double q = n - 4.0 * std::floor(n / 4.0);
  // 4. The reduced argument: Cody–Waite with fdlibm's three-part π/2.
  const double r = a - n * d::kPio2_1 - n * d::kPio2_2 - n * d::kPio2_2t;
  // 5. The kernels (k_sin.c, k_cos.c in FreeBSD msun's form), Horner, the tail argument dropped.
  const double z = r * r;
  const double ks = r + z * r * (d::kS1 + z * (d::kS2 + z * (d::kS3 + z * (d::kS4 + z * (d::kS5 + z * d::kS6)))));
  const double hz = 0.5 * z;
  const double w = 1.0 - hz;
  const double kc = w + (1.0 - w - hz + z * (z * (d::kC1 + z * (d::kC2 + z * (d::kC3 + z * (d::kC4 + z * (d::kC5 + z * d::kC6)))))));
  // 6–7. By quadrant, −0 as 0.
  if (q == 0.0) {
    out.sin = UnsignedZero(ks);
    out.cos = UnsignedZero(kc);
  } else if (q == 1.0) {
    out.sin = UnsignedZero(kc);
    out.cos = UnsignedZero(-ks);
  } else if (q == 2.0) {
    out.sin = UnsignedZero(-ks);
    out.cos = UnsignedZero(-kc);
  } else {
    out.sin = UnsignedZero(-kc);
    out.cos = UnsignedZero(ks);
  }
  return out;
}

double PSin(double a) { return PSinCos(a).sin; }

double PCos(double a) { return PSinCos(a).cos; }

double SinCosConstant(std::string_view name) {
  for (const presets_detail::NamedConstant& c : presets_detail::kSinCosConstants) {
    if (name == c.name) return c.value;
  }
  return std::numeric_limits<double>::quiet_NaN();
}

bool TopdownParamsValid(const Json* params) {
  if (params == nullptr) return true;
  if (!params->IsObject()) return false;
  for (const JsonMember& member : params->Members()) {
    const presets_detail::ParamRange* range = presets_detail::RangeFor(member.key);
    if (range == nullptr || !presets_detail::InRange(&member.value, *range)) return false;
  }
  return true;
}

TopdownParams ResolveTopdownParams(const Json* params) {
  TopdownParams out = kTopdownDefaults;
  if (params == nullptr || !params->IsObject()) return out;
  for (const presets_detail::ParamRange& range : presets_detail::kTopdownRange) {
    const Json* value = params->Find(range.key);
    if (presets_detail::InRange(value, range)) out.*range.field = value->AsNumber();
  }
  return out;
}

TopdownBody StepTopdown(const TopdownBody& body, double moveX, double moveY, double yaw, double dt,
                        const TopdownParams& params) {
  const double mx = Axis(moveX);
  const double my = Axis(moveY);
  const double step = StepSeconds(dt, kMaxDtSeconds);
  const double length = std::sqrt(mx * mx + my * my);
  const double scale = length > 1.0 ? 1.0 / length : 1.0;
  const double x = presets_detail::FiniteOrZero(body.x) + mx * scale * params.speed * step;
  const double y = presets_detail::FiniteOrZero(body.y) + my * scale * params.speed * step;
  TopdownBody next;
  next.x = UnsignedZero(Fround(Clamp(x, -params.arena, params.arena)));
  next.y = UnsignedZero(Fround(Clamp(y, -params.arena, params.arena)));
  const std::optional<double> wrapped = WrappedAngle(yaw);
  next.yaw = wrapped ? *wrapped : UnsignedZero(Fround(presets_detail::FiniteOrZero(body.yaw)));
  return next;
}

TopdownBody StepTopdown(const TopdownBody& body, const Input& input, double dt, const TopdownParams& params) {
  return StepTopdown(body, input.moveX, input.moveY, input.yaw, dt, params);
}

// projectile.ts projectileAt, expression for expression. C++ evaluates `a + b * s - c * g * s * s` as
// `(a + (b * s)) - (((c * g) * s) * s)`, as JS does; GENEX_FP_STRICT keeps each `x + vx * s` two
// roundings (the order-fma-* vectors land on another float32 when they are fused).
ProjectileState ProjectileAt(const ProjectileLaunch& launch, double tick, double tickHz) {
  const double elapsed = (tick - launch.t0) / tickHz;
  const double s = presets_detail::IsFinite(elapsed) && elapsed >= 0.0 ? elapsed : 0.0;
  ProjectileState out;
  out.x = UnsignedZero(Fround(launch.x + launch.vx * s));
  out.y = UnsignedZero(Fround(launch.y + launch.vy * s));
  out.z = UnsignedZero(Fround(launch.z + launch.vz * s - 0.5 * launch.g * s * s));
  out.vx = UnsignedZero(launch.vx);
  out.vy = UnsignedZero(launch.vy);
  out.vz = UnsignedZero(Fround(launch.vz - launch.g * s));
  return out;
}

double ServerTick(double serverNowMs, double tickOrigin, double tickHz) {
  return ((serverNowMs - tickOrigin) * tickHz) / 1000.0;
}

double TickInstant(double tick, double tickOrigin, double tickHz) { return tickOrigin + (tick * 1000.0) / tickHz; }

double LaunchNumber(double v) { return presets_detail::IsFinite(v) ? UnsignedZero(Fround(v)) : 0.0; }

double LaunchGravity(double g) {
  const double v = LaunchNumber(g);
  return v < 0.0 ? 0.0 : v > kMaxProjectileG ? kMaxProjectileG : v;
}

}  // namespace genex::presets

namespace genex {

Prediction Prediction::ForTopdown(const TopdownParams& params) {
  Prediction prediction;
  prediction.kind_ = PresetKind::Topdown;
  prediction.topdown_ = params;
  return prediction;
}

Prediction Prediction::ForFirstperson(const FirstpersonParams& params, FirstpersonWorldPtr world) {
  Prediction prediction;
  prediction.kind_ = PresetKind::Firstperson;
  prediction.firstperson_ = params;
  prediction.world_ = world != nullptr ? std::move(world) : FirstpersonWorld::Empty();
  return prediction;
}

Prediction Prediction::ForVehicle(const VehicleParams& params, FirstpersonWorldPtr world) {
  Prediction prediction;
  prediction.kind_ = PresetKind::Vehicle;
  prediction.vehicle_ = params;
  prediction.world_ = world != nullptr ? std::move(world) : FirstpersonWorld::Empty();
  return prediction;
}

const char* Prediction::Name() const {
  switch (kind_) {
    case PresetKind::Topdown:
      return presets::kTopdown;
    case PresetKind::Firstperson:
      return presets::kFirstperson;
    case PresetKind::Vehicle:
      return presets::kVehicle;
    case PresetKind::None:
      break;
  }
  return "";
}

std::optional<std::uint32_t> Prediction::RoomWorld() const {
  if (!HasWorld()) return std::nullopt;
  // `world` is an integer in [0, 2^32 − 1] (resolved and range-checked): exact in a double and a u32.
  return static_cast<std::uint32_t>(kind_ == PresetKind::Vehicle ? vehicle_.world : firstperson_.world);
}

bool Prediction::WorldMatches() const {
  if (!HasWorld()) return true;
  const std::uint32_t mine = world_ != nullptr ? world_->Hash() : FirstpersonWorld::kEmptyHash;
  return static_cast<double>(mine) == (kind_ == PresetKind::Vehicle ? vehicle_.world : firstperson_.world);
}

Prediction Prediction::WithWorld(FirstpersonWorldPtr world) const {
  if (kind_ == PresetKind::Firstperson) return ForFirstperson(firstperson_, std::move(world));
  if (kind_ == PresetKind::Vehicle) return ForVehicle(vehicle_, std::move(world));
  return *this;
}

double Prediction::PitchLimit() const {
  return kind_ == PresetKind::Firstperson ? presets::Fround(firstperson_.pitchLimit) : presets_detail::kJsPi;
}

const char* const* Prediction::Fields() const {
  switch (kind_) {
    case PresetKind::Topdown:
      return presets_detail::kTopdownFields;
    case PresetKind::Firstperson:
      return presets_detail::kFirstpersonFields;
    case PresetKind::Vehicle:
      return presets_detail::kVehicleFields;
    case PresetKind::None:
      break;
  }
  return nullptr;
}

int Prediction::FieldCount() const {
  switch (kind_) {
    case PresetKind::Topdown:
      return static_cast<int>(sizeof(presets_detail::kTopdownFields) / sizeof(presets_detail::kTopdownFields[0]));
    case PresetKind::Firstperson:
      return static_cast<int>(sizeof(presets_detail::kFirstpersonFields) / sizeof(presets_detail::kFirstpersonFields[0]));
    case PresetKind::Vehicle:
      return static_cast<int>(sizeof(presets_detail::kVehicleFields) / sizeof(presets_detail::kVehicleFields[0]));
    case PresetKind::None:
      break;
  }
  return 0;
}

void Prediction::Step(authority_wire::AuthorityEntity& mirror, const Input& sanitized, double dt) const {
  // float → double is exact; every value a step returns is already a float32 (or, for mstate, a small
  // integer), so the store back is exact too.
  if (kind_ == PresetKind::Topdown) {
    TopdownBody body;
    body.x = static_cast<double>(mirror.x);
    body.y = static_cast<double>(mirror.y);
    body.yaw = static_cast<double>(mirror.yaw);
    const TopdownBody next = presets::StepTopdown(body, sanitized, dt, topdown_);
    mirror.x = static_cast<float>(next.x);
    mirror.y = static_cast<float>(next.y);
    mirror.yaw = static_cast<float>(next.yaw);
    return;
  }
  if (kind_ == PresetKind::Vehicle) {
    VehicleBody body;
    body.x = static_cast<double>(mirror.x);
    body.y = static_cast<double>(mirror.y);
    body.z = static_cast<double>(mirror.z);
    body.vx = static_cast<double>(mirror.vx);
    body.vy = static_cast<double>(mirror.vy);
    body.vz = static_cast<double>(mirror.vz);
    body.yaw = static_cast<double>(mirror.yaw);
    body.spin = static_cast<double>(mirror.spin);
    body.fuel = static_cast<double>(mirror.fuel);
    body.mstate = mirror.mstate;
    body.cap = static_cast<double>(mirror.cap);
    const FirstpersonWorld& world = world_ != nullptr ? *world_ : *FirstpersonWorld::Empty();
    const VehicleBody next = presets::StepVehicle(body, sanitized, dt, vehicle_, world);
    // pitch and duck are never touched by a vehicle step.
    mirror.x = static_cast<float>(next.x);
    mirror.y = static_cast<float>(next.y);
    mirror.z = static_cast<float>(next.z);
    mirror.vx = static_cast<float>(next.vx);
    mirror.vy = static_cast<float>(next.vy);
    mirror.vz = static_cast<float>(next.vz);
    mirror.yaw = static_cast<float>(next.yaw);
    mirror.spin = static_cast<float>(next.spin);
    mirror.fuel = static_cast<float>(next.fuel);
    mirror.mstate = next.mstate;
    return;
  }
  if (kind_ != PresetKind::Firstperson) return;
  FirstpersonBody body;
  body.x = static_cast<double>(mirror.x);
  body.y = static_cast<double>(mirror.y);
  body.z = static_cast<double>(mirror.z);
  body.vx = static_cast<double>(mirror.vx);
  body.vy = static_cast<double>(mirror.vy);
  body.vz = static_cast<double>(mirror.vz);
  body.yaw = static_cast<double>(mirror.yaw);
  body.pitch = static_cast<double>(mirror.pitch);
  body.duck = static_cast<double>(mirror.duck);
  body.mstate = mirror.mstate;
  body.cap = static_cast<double>(mirror.cap);
  const FirstpersonWorld& world = world_ != nullptr ? *world_ : *FirstpersonWorld::Empty();
  const FirstpersonBody next = presets::StepFirstperson(body, sanitized, dt, firstperson_, world);
  // A yaw read past the float32 range is ±Infinity, as the reference keeps it.
  mirror.x = static_cast<float>(next.x);
  mirror.y = static_cast<float>(next.y);
  mirror.z = static_cast<float>(next.z);
  mirror.vx = static_cast<float>(next.vx);
  mirror.vy = static_cast<float>(next.vy);
  mirror.vz = static_cast<float>(next.vz);
  mirror.yaw = static_cast<float>(next.yaw);
  mirror.pitch = static_cast<float>(next.pitch);
  mirror.duck = static_cast<float>(next.duck);
  mirror.mstate = next.mstate;
}

void Prediction::Step(authority_wire::AuthorityEntity& mirror, const authority_wire::AuthorityInput& command,
                      double dt) const {
  Step(mirror, Input::FromWire(command), dt);
}

Prediction PredictionFor(std::string_view presetText, FirstpersonWorldPtr world) {
  if (presetText.empty()) return Prediction();
  const std::optional<Json> spec = Json::Parse(presetText);
  if (!spec || !spec->IsObject()) return Prediction();
  const Json* name = spec->Find("name");
  if (name == nullptr || !name->IsString()) return Prediction();
  if (name->AsString() == presets::kTopdown) {
    return Prediction::ForTopdown(presets::ResolveTopdownParams(spec->Find("params")));
  }
  if (name->AsString() == presets::kFirstperson) {
    return Prediction::ForFirstperson(presets::ResolveFirstpersonParams(spec->Find("params")), std::move(world));
  }
  if (name->AsString() == presets::kVehicle) {
    return Prediction::ForVehicle(presets::ResolveVehicleParams(spec->Find("params")), std::move(world));
  }
  return Prediction();
}

}  // namespace genex

GENEX_FP_STRICT_END
