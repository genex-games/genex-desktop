// `config.lifts` resolution (GenexCore/GenexLiftsConfig.h): a port of lifts-config.ts, in its order, so a declaration
// with several bad values is refused by the same path with the same message.
#include "GenexCore/GenexLiftsConfig.h"

#include "GenexCore/GenexPresets.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <set>
#include <string>

GENEX_FP_STRICT_BEGIN

namespace genex::lifts {
namespace {

using Opt = std::optional<LiftsRefusal>;

LiftsRefusal Refuse(const std::string& path, const std::string& why) { return LiftsRefusal{path, why, std::nullopt}; }

constexpr double kFullTurn = 2 * 3.14159265358979323846;
/** `smooth`'s peak speed over its mean (the derivative of `s·s·(3 − 2s)` at ½). */
constexpr double kSmoothPeak = 1.5;

using Keys = std::set<std::string>;

/** A JavaScript number as text, for the messages: an integer prints bare; others as the shortest digits that read back. */
std::string JsNumber(double v) {
  if (std::isfinite(v) && v == std::floor(v) && std::fabs(v) < 1e21) {
    char buf[64];
    std::snprintf(buf, sizeof buf, "%.0f", v);
    return buf;
  }
  char buf[64];
  for (int digits = 1; digits <= 17; ++digits) {
    std::snprintf(buf, sizeof buf, "%.*g", digits, v);
    if (std::strtod(buf, nullptr) == v) break;
  }
  return buf;
}

/** `Number(v.toFixed(f))` printed: v rounded to f decimals, half up on the exact value (a positive v), no trailing zeros. */
std::string FixedNumber(double v, int f) {
  char exact[400];
  std::snprintf(exact, sizeof exact, "%.60f", v);
  std::string s = exact;
  const std::size_t dot = s.find('.');
  std::string whole = s.substr(0, dot);
  std::string frac = s.substr(dot + 1);
  const bool up = frac[static_cast<std::size_t>(f)] >= '5';
  frac = frac.substr(0, static_cast<std::size_t>(f));
  std::string digits = whole + frac;
  if (up) {
    std::size_t i = digits.size();
    while (i > 0) {
      --i;
      if (digits[i] == '9') {
        digits[i] = '0';
        continue;
      }
      digits[i] += 1;
      break;
    }
    if (i == 0 && digits[0] == '0') digits.insert(digits.begin(), '1');
  }
  const std::size_t wholeLen = digits.size() - static_cast<std::size_t>(f);
  std::string out = digits.substr(0, wholeLen);
  std::string tail = digits.substr(wholeLen);
  while (!tail.empty() && tail.back() == '0') tail.pop_back();
  if (!tail.empty()) out += "." + tail;
  return out;
}

std::string SpeedText(double perTick, double tickHz, const std::string& rate = std::string()) {
  return FixedNumber(perTick, 3) + " u a tick (" + FixedNumber(perTick * tickHz, 1) + " u/s" + rate + ")";
}

Opt OnlyKeys(const Json& o, const Keys& keys, const std::string& path) {
  for (const JsonMember& m : o.Members()) {
    if (keys.count(m.key) == 0) return Refuse(path + "." + m.key, "is not a lift setting");
  }
  return std::nullopt;
}

/** `has(o, k)`: the key is present (a JSON null is a value). */
const Json* Has(const Json& o, const char* k) { return o.Find(k); }

/** A finite number of magnitude at most kLiftValueMax (`positive`: above 0), as its float32 (−0 as 0). */
Opt Value(const Json* v, const std::string& path, bool positive, double* out) {
  if (v == nullptr || !v->IsNumber() || !std::isfinite(v->AsNumber()) || std::fabs(v->AsNumber()) > kLiftValueMax) {
    return Refuse(path, "must be a number of magnitude at most " + JsNumber(kLiftValueMax));
  }
  const double r = presets::Fround(v->AsNumber());
  const double f = r == 0 ? 0 : r;
  if (positive && !(f > 0)) return Refuse(path, "must be above 0");
  *out = f;
  return std::nullopt;
}

/** An integer tick count in [lo, kLiftTicksMax]. */
Opt Ticks(const Json* v, const std::string& path, double lo, double* out) {
  const bool ok = v != nullptr && v->IsNumber() && std::isfinite(v->AsNumber()) && v->AsNumber() == std::floor(v->AsNumber()) &&
                  v->AsNumber() >= lo && v->AsNumber() <= kLiftTicksMax;
  if (!ok) return Refuse(path, "must be an integer number of ticks in [" + JsNumber(lo) + ", " + JsNumber(kLiftTicksMax) + "]");
  *out = v->AsNumber();
  return std::nullopt;
}

Opt Vector(const Json* v, const std::string& path, std::size_t n, bool positive, double* out) {
  if (v == nullptr || !v->IsArray() || v->Size() != n) return Refuse(path, "must be an array of " + std::to_string(n) + " numbers");
  for (std::size_t i = 0; i < n; ++i) {
    if (Opt r = Value(&v->At(i), path + "[" + std::to_string(i) + "]", positive, &out[i])) return r;
  }
  return std::nullopt;
}

Opt ShapeOf(const Json* v, const std::string& path, Shape* out) {
  if (v == nullptr || !v->IsObject()) return Refuse(path, "must be an object");
  const Json* kind = v->Find("kind");
  const std::string k = kind != nullptr && kind->IsString() ? kind->AsString() : std::string();
  Shape s;
  if (k == "box") {
    static const Keys keys = {"kind", "half"};
    if (Opt r = OnlyKeys(*v, keys, path)) return r;
    s.kind = ShapeKind::Box;
    if (Opt r = Vector(v->Find("half"), path + ".half", 3, true, s.half.data())) return r;
    *out = s;
    return std::nullopt;
  }
  if (k == "disc") {
    static const Keys keys = {"kind", "radius", "half"};
    if (Opt r = OnlyKeys(*v, keys, path)) return r;
    s.kind = ShapeKind::Disc;
    if (Opt r = Value(v->Find("radius"), path + ".radius", true, &s.radius)) return r;
    if (Opt r = Value(v->Find("half"), path + ".half", true, &s.discHalf)) return r;
    *out = s;
    return std::nullopt;
  }
  return Refuse(path + ".kind", "must be box or disc");
}

/** An enum by its wire spelling over `names` (the declared order for the message), else `fallback`. */
template <typename T, std::size_t N>
Opt EnumOf(const Json& o, const char* key, const std::string& path, const std::pair<const char*, T> (&names)[N], T fallback, T* out) {
  const Json* v = Has(o, key);
  if (v == nullptr) {
    *out = fallback;
    return std::nullopt;
  }
  if (v->IsString()) {
    for (const auto& n : names) {
      if (v->AsString() == n.first) {
        *out = n.second;
        return std::nullopt;
      }
    }
  }
  std::string list;
  for (std::size_t i = 0; i < N; ++i) list += (i == 0 ? "" : " or ") + std::string(names[i].first);
  return Refuse(path + "." + key, "must be " + list);
}

const std::pair<const char*, PathMode> kModes[] = {{"pingpong", PathMode::PingPong}, {"loop", PathMode::Loop}};
const std::pair<const char*, Ease> kEases[] = {{"linear", Ease::Linear}, {"smooth", Ease::Smooth}};
const std::pair<const char*, Impart> kImparts[] = {{"all", Impart::All}, {"none", Impart::None}};

double Sum(const std::vector<double>& xs) {
  double a = 0;
  for (const double x : xs) a += x;
  return a;
}

/** A path's cycle: pingpong runs out and back (every leg twice, the end points' waits once, the inner points'
 *  twice); loop runs round once. */
double PeriodOf(const std::vector<double>& legs, const std::vector<double>& waits, PathMode mode) {
  if (mode == PathMode::Loop) return Sum(legs) + Sum(waits);
  return 2 * Sum(legs) + 2 * Sum(waits) - (waits.empty() ? 0 : waits.front()) - (waits.empty() ? 0 : waits.back());
}

Opt PathOf(const Json* v, const std::string& path, bool called, Path* out) {
  if (v == nullptr || !v->IsObject()) return Refuse(path, "must be an object");
  static const Keys keys = {"points", "legs", "waits", "mode", "ease", "phase"};
  if (Opt r = OnlyKeys(*v, keys, path)) return r;
  Path p;
  if (Opt r = EnumOf(*v, "mode", path, kModes, PathMode::PingPong, &p.mode)) return r;
  if (Opt r = EnumOf(*v, "ease", path, kEases, Ease::Linear, &p.ease)) return r;
  const Json* legs = v->Find("legs");
  if (legs == nullptr || !legs->IsArray() || legs->Size() < 1 || legs->Size() > kLiftPointsMax) {
    return Refuse(path + ".legs", "must be a list of 1 to " + std::to_string(kLiftPointsMax) + " leg tick counts");
  }
  for (std::size_t i = 0; i < legs->Size(); ++i) {
    double t = 0;
    if (Opt r = Ticks(&legs->At(i), path + ".legs[" + std::to_string(i) + "]", 1, &t)) return r;
    p.legs.push_back(t);
  }
  const std::size_t wantPoints = p.mode == PathMode::Loop ? p.legs.size() : p.legs.size() + 1;
  const Json* points = v->Find("points");
  if (points == nullptr || !points->IsArray() || points->Size() != wantPoints || wantPoints < 2) {
    return Refuse(path + ".points", "must be " + (wantPoints < 2 ? std::string("at least 2") : std::to_string(wantPoints)) + " points (" +
                                        (p.mode == PathMode::Loop ? "one per leg" : "one more than the legs") + ")");
  }
  for (std::size_t i = 0; i < points->Size(); ++i) {
    Vec3 pt{};
    if (Opt r = Vector(&points->At(i), path + ".points[" + std::to_string(i) + "]", 3, false, pt.data())) return r;
    p.points.push_back(pt);
  }
  const Json* waits = v->Find("waits");
  if (waits != nullptr && (!waits->IsArray() || waits->Size() != p.points.size())) {
    return Refuse(path + ".waits", "must be one wait per point (" + std::to_string(p.points.size()) + ")");
  }
  if (waits == nullptr) {
    p.waits.assign(p.points.size(), 0.0);
  } else {
    for (std::size_t i = 0; i < waits->Size(); ++i) {
      double t = 0;
      if (Opt r = Ticks(&waits->At(i), path + ".waits[" + std::to_string(i) + "]", 0, &t)) return r;
      p.waits.push_back(t);
    }
  }
  const Json* phase = Has(*v, "phase");
  if (called && phase != nullptr) return Refuse(path + ".phase", "is not allowed on a called lift (its call sets its start)");
  if (phase != nullptr) {
    if (Opt r = Ticks(phase, path + ".phase", 0, &p.phase)) return r;
  }
  p.period = PeriodOf(p.legs, p.waits, p.mode);
  *out = std::move(p);
  return std::nullopt;
}

Opt SpinOf(const Json* v, const std::string& path, Spin* out) {
  if (v == nullptr || !v->IsObject()) return Refuse(path, "must be an object");
  static const Keys keys = {"period", "dir", "phase"};
  if (Opt r = OnlyKeys(*v, keys, path)) return r;
  Spin s;
  if (Opt r = Ticks(v->Find("period"), path + ".period", kLiftSpinMinPeriod, &s.period)) return r;
  if (const Json* dir = Has(*v, "dir")) {
    if (!dir->IsNumber() || (dir->AsNumber() != 1 && dir->AsNumber() != -1)) return Refuse(path + ".dir", "must be 1 or -1");
    s.dir = dir->AsNumber() == 1 ? 1 : -1;
  }
  if (const Json* phase = Has(*v, "phase")) {
    if (Opt r = Ticks(phase, path + ".phase", 0, &s.phase)) return r;
  }
  *out = s;
  return std::nullopt;
}

/** The farthest any point of the shape is from its centre on x and y (a spin's tip). */
double ReachOf(const Shape& s) { return s.kind == ShapeKind::Disc ? s.radius : std::sqrt(s.half[0] * s.half[0] + s.half[1] * s.half[1]); }

/** The movement refusal: a platform any point of which moves more than the hull radius a tick could pass through a
 *  seat. It names the platform, its fastest move and the most allowed at `tickHz`. */
Opt RefuseFast(const Lift& lift, const std::string& path, double radius, double tickHz) {
  const double spinTip = lift.spin ? (ReachOf(lift.shape) * kFullTurn) / lift.spin->period : 0.0;
  const std::string allowed = "at most " + SpeedText(radius, tickHz, " at " + JsNumber(tickHz) + " Hz") + " is allowed (the hull radius a tick)";
  std::string at = path + ".spin.period";
  double fastest = spinTip;
  if (lift.path) {
    const Path& p = *lift.path;
    for (std::size_t i = 0; i < p.legs.size(); ++i) {
      const Vec3& a = p.points[i];
      const Vec3& b = p.points[(i + 1) % p.points.size()];
      const double dx = b[0] - a[0];
      const double dy = b[1] - a[1];
      const double dz = b[2] - a[2];
      const double mean = std::sqrt(dx * dx + dy * dy + dz * dz) / p.legs[i];
      const double move = (p.ease == Ease::Smooth ? kSmoothPeak * mean : mean) + spinTip;
      if (move > fastest) {
        at = path + ".path.legs[" + std::to_string(i) + "]";
        fastest = move;
      }
    }
  }
  if (!(fastest > radius)) return std::nullopt;
  LiftsRefusal r = Refuse(at, "platform '" + lift.id + "' moves up to " + SpeedText(fastest, tickHz) + "; " + allowed);
  r.fast = LiftTooFast{lift.id, fastest, radius, tickHz};
  return r;
}

bool IdOk(const std::string& id) {
  if (id.empty() || id.size() > kLiftIdMax) return false;
  for (const char c : id) {
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) return false;
  }
  return true;
}

Opt PlatformOf(const Json& v, const std::string& path, std::set<std::string>& ids, double radius, double tickHz, Lift* out) {
  if (!v.IsObject()) return Refuse(path, "must be an object");
  static const Keys keys = {"id", "shape", "at", "path", "spin", "surface", "impart", "called"};
  if (Opt r = OnlyKeys(v, keys, path)) return r;
  Lift lift;
  const Json* id = v.Find("id");
  if (id == nullptr || !id->IsString() || !IdOk(id->AsString())) {
    return Refuse(path + ".id", "must be 1 to " + std::to_string(kLiftIdMax) + " of a-z, 0-9 and -");
  }
  lift.id = id->AsString();
  if (ids.count(lift.id) != 0) return Refuse(path + ".id", "repeats the id '" + lift.id + "'");
  ids.insert(lift.id);
  if (Opt r = ShapeOf(v.Find("shape"), path + ".shape", &lift.shape)) return r;
  const Json* called = Has(v, "called");
  if (called != nullptr && !called->IsBool()) return Refuse(path + ".called", "must be true or false");
  lift.called = called != nullptr && called->AsBool();
  if (Has(v, "path") != nullptr) {
    Path p;
    if (Opt r = PathOf(v.Find("path"), path + ".path", lift.called, &p)) return r;
    lift.path = std::move(p);
  }
  if (!lift.path && Has(v, "at") == nullptr) return Refuse(path + ".at", "is required without a path");
  if (Has(v, "at") != nullptr) {
    if (Opt r = Vector(v.Find("at"), path + ".at", 3, false, lift.at.data())) return r;
  } else {
    lift.at = lift.path->points[0];
  }
  if (Has(v, "spin") != nullptr) {
    Spin s;
    if (Opt r = SpinOf(v.Find("spin"), path + ".spin", &s)) return r;
    lift.spin = s;
  }
  if (Has(v, "surface") != nullptr) {
    std::array<double, 2> s{};
    if (Opt r = Vector(v.Find("surface"), path + ".surface", 2, false, s.data())) return r;
    lift.surface = s;
  }
  if (Opt r = EnumOf(v, "impart", path, kImparts, Impart::All, &lift.impart)) return r;
  if (Opt r = RefuseFast(lift, path, radius, tickHz)) return r;
  *out = std::move(lift);
  return std::nullopt;
}

}  // namespace

const char* PathModeName(PathMode m) { return m == PathMode::Loop ? "loop" : "pingpong"; }
const char* EaseName(Ease e) { return e == Ease::Smooth ? "smooth" : "linear"; }
const char* ImpartName(Impart i) { return i == Impart::None ? "none" : "all"; }

std::optional<LiftsPolicy> ResolveLifts(const Json& given, const contact::ContactPresetParams* preset, double tickHz, LiftsRefusal* refusal,
                                        const std::string& path) {
  const auto refuse = [refusal](const LiftsRefusal& r) -> std::optional<LiftsPolicy> {
    if (refusal != nullptr) *refusal = r;
    return std::nullopt;
  };
  if (!given.IsObject()) return refuse(Refuse(path, "must be an object"));
  static const Keys keys = {"platforms", "bodies"};
  if (Opt r = OnlyKeys(given, keys, path)) return refuse(*r);
  if (preset == nullptr || (preset->name != "firstperson" && preset->name != "vehicle")) {
    return refuse(Refuse(path, "needs a firstperson or vehicle movement preset"));
  }
  const Json* list = given.Find("platforms");
  if (list == nullptr || !list->IsArray() || list->Size() < 1 || list->Size() > kLiftsMax) {
    return refuse(Refuse(path + ".platforms", "must be a list of 1 to " + std::to_string(kLiftsMax) + " platforms"));
  }
  const Json* bodies = Has(given, "bodies");
  if (bodies != nullptr && !bodies->IsBool()) return refuse(Refuse(path + ".bodies", "must be true or false"));
  const Json* radiusJson = preset->params == nullptr ? nullptr : preset->params->Find("radius");
  const double radius = radiusJson != nullptr && radiusJson->IsNumber() ? radiusJson->AsNumber() : 0.0;
  LiftsPolicy policy;
  std::set<std::string> ids;
  for (std::size_t i = 0; i < list->Size(); ++i) {
    Lift lift;
    if (Opt r = PlatformOf(list->At(i), path + ".platforms[" + std::to_string(i) + "]", ids, radius, tickHz, &lift)) return refuse(*r);
    policy.platforms.push_back(std::move(lift));
  }
  policy.bodies = !(bodies != nullptr && !bodies->AsBool());
  return policy;
}

}  // namespace genex::lifts

GENEX_FP_STRICT_END
