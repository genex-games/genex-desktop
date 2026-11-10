// The physics predictor (PROTOCOL.md §17.11): see GenexPhysicsPredictor.h. Each function follows
// packages/multiplayer/src/authority/physics-predict.ts and physics-keyframe.ts in its order of
// operations, unfused, and walks its maps in the TypeScript Map's insertion order wherever the order
// reaches the core (seats, kinematic bodies, removals, imports).
#include "GenexCore/GenexPhysicsPredictor.h"

#include "GenexCore/GenexClock.h"

#include <algorithm>
#include <cmath>
#include <limits>

GENEX_FP_STRICT_BEGIN

namespace genex::physics_predict_detail {

using genex::Json;
using genex::bodies::Pose;
using genex::bodies::Quat;
using genex::bodies::Vec3;

constexpr double kQuantSpan = 65534.0;
constexpr double kOrientationMin = -1.0;
constexpr double kOrientationMax = 1.0;
constexpr double kVelocityMin = -64.0;
constexpr double kVelocityMax = 64.0;
constexpr double kWireRestMax = 65535.0;
constexpr double kIslandMarginMetres = 0.5;
constexpr double kTauSmallMs = 300.0;
constexpr double kTauLargeMs = 100.0;
constexpr double kSmallMetres = 0.25;
constexpr double kLargeMetres = 1.0;
constexpr double kSnapPlayerMetres = 2.0;
constexpr double kSnapOtherMetres = 6.0;
constexpr double kMinLeadMs = 50.0;
constexpr double kMaxLeadMs = 1000.0;
constexpr double kMaxRemoteDecayMs = 1000.0;
/** The wire row of a preset body after its position: identity, still, awake (C§20.2's integers). */
constexpr double kPresetRowTail[12] = {32767, 32767, 32767, 65534, 32767, 32767, 32767, 32767, 32767, 32767, 0, 0};
/** Doubles past this round to ±Infinity as float32 (FLT_MAX plus half its ulp: a tie, to even). */
constexpr double kFroundInfinity = 3.4028235677973366e38;
constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();
constexpr double kInf = std::numeric_limits<double>::infinity();

/** Math.max / Math.min of two: NaN when either is. */
double JsMax(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return kNaN;
  return a > b ? a : b;
}
double JsMin(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return kNaN;
  return a < b ? a : b;
}

/** Object.is on two numbers (the wire-row compare). */
bool SameNumber(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return std::isnan(a) && std::isnan(b);
  return a == b && std::signbit(a) == std::signbit(b);
}

bool SameRow(const genex::physics::WireRow& a, const genex::physics::WireRow& b) {
  for (std::size_t i = 0; i < genex::physics::kWireRowStride; ++i) {
    if (!SameNumber(a[i], b[i])) return false;
  }
  return true;
}

/** −0 sent as 0 (C§20.2). */
double UnsignedZero(double v) { return v == 0.0 ? 0.0 : v; }

/** A number field, or NaN (JavaScript reads a missing or non-number field as NaN in arithmetic). */
double NumberOf(const Json* v) { return v != nullptr && v->IsNumber() ? v->AsNumber() : kNaN; }

/** The JavaScript length of a 3-array: sqrt(x² + y² + z²), 0 for anything else. */
double Length3(const Json* v) {
  if (v == nullptr || !v->IsArray() || v->Size() != 3) return 0.0;
  const double x = NumberOf(&v->At(0));
  const double y = NumberOf(&v->At(1));
  const double z = NumberOf(&v->At(2));
  return std::sqrt(x * x + y * y + z * z);
}

double Farthest(const Json* points) {
  if (points == nullptr || !points->IsArray()) return 0.0;
  double m = 0.0;
  for (const Json& p : points->Items()) m = JsMax(m, Length3(&p));
  return m;
}

double ShapeRadius(const Json& shape) {
  const Json* kind = shape.Find("kind");
  const std::string k = kind != nullptr && kind->IsString() ? kind->AsString() : std::string();
  const auto numberOr0 = [&shape](const char* name) {
    const Json* v = shape.Find(name);
    return v != nullptr && v->IsNumber() ? v->AsNumber() : 0.0;
  };
  if (k == "box") return Length3(shape.Find("half"));
  if (k == "sphere") return numberOr0("radius");
  if (k == "capsule") return numberOr0("halfHeight") + numberOr0("radius");
  if (k == "hull") return Farthest(shape.Find("points"));
  if (k == "trimesh") return Farthest(shape.Find("vertices"));
  if (k == "heightfield") return Length3(shape.Find("size"));
  return 0.0;
}

/** The descriptor's text: its identity (JSON.stringify). */
std::string DescKey(const std::optional<Json>& desc) { return desc ? desc->Dump() : std::string(); }

/** String(desc.type) for the types that matter. */
std::string TypeOf(const Json& desc) {
  const Json* t = desc.Find("type");
  if (t == nullptr) return "undefined";
  return t->IsString() ? t->AsString() : t->Dump();
}

bool IsKinematic(const std::optional<Json>& desc) { return desc && TypeOf(*desc) == "kinematic"; }

Quat Q(double x, double y, double z, double w) {
  Quat q;
  q.x = x;
  q.y = y;
  q.z = z;
  q.w = w;
  return q;
}

Vec3 V(double x, double y, double z) {
  Vec3 v;
  v.x = x;
  v.y = y;
  v.z = z;
  return v;
}

/** `q` turned by angular velocity `av` (world axes) over `dt` seconds. */
Quat Turned(const Quat& q, const Vec3& av, double dt) {
  const double rate = genex::physics::JsHypot(av.x, av.y, av.z);
  if (rate == 0.0 || dt == 0.0) return q;
  const double half = (rate * dt) / 2.0;
  const double s = std::sin(half) / rate;
  return genex::bodies::Normalize(genex::bodies::Mul(Q(av.x * s, av.y * s, av.z * s, std::cos(half)), q));
}

/** A module kinematic body's pose as its keyframe row holds it (never extrapolated). */
void KeyframePose(const genex::physics::WireRow& row, double p[3], double q[4]) {
  const auto unit = [](double v) { return -1.0 + (v / kQuantSpan) * 2.0; };
  const Quat n = genex::bodies::Normalize(Q(unit(row[3]), unit(row[4]), unit(row[5]), unit(row[6])));
  p[0] = row[0];
  p[1] = row[1];
  p[2] = row[2];
  q[0] = n.x;
  q[1] = n.y;
  q[2] = n.z;
  q[3] = n.w;
}

/** A row's 15 numbers as float32 (a Float32Array's conversion). */
void AppendRowF32(std::vector<float>& out, const double* row, std::size_t count) {
  for (std::size_t i = 0; i < count; ++i) out.push_back(static_cast<float>(genex::physics::Fround(row[i])));
}

/** `v` scaled to length `max` when longer, else none (float64; the core rounds each to float32). */
bool ClampLength(const double v[3], double max, double out[3]) {
  const double length = std::sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (!(length > max)) return false;
  const double scale = max / length;
  out[0] = v[0] * scale;
  out[1] = v[1] * scale;
  out[2] = v[2] * scale;
  return true;
}

/** One body as islands see it. */
struct IslandBody {
  std::string key;
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double radius = 0.0;
};

/** Proximity islands: key → island id (its least key). physics-keyframe.ts's proximityIslands. */
std::map<std::string, std::string> ProximityIslands(const std::vector<IslandBody>& islandBodies,
                                                    const std::vector<std::pair<std::string, std::string>>& links,
                                                    double margin) {
  std::map<std::string, std::string> parent;
  const auto find = [&parent](const std::string& k) {
    std::string root = k;
    while (parent[root] != root) root = parent[root];
    std::string at = k;
    while (at != root) {
      std::string next = parent[at];
      parent[at] = root;
      at = next;
    }
    return root;
  };
  const auto join = [&parent, &find](const std::string& a, const std::string& b) {
    const std::string ra = find(a);
    const std::string rb = find(b);
    if (ra == rb) return;
    if (ra < rb) {
      parent[rb] = ra;
    } else {
      parent[ra] = rb;
    }
  };
  for (const IslandBody& b : islandBodies) parent[b.key] = b.key;
  std::vector<const IslandBody*> sorted;
  for (const IslandBody& b : islandBodies) sorted.push_back(&b);
  // A NaN position sorts last (V8's order for it is unspecified; std::sort needs a strict order).
  const auto sortX = [](const IslandBody* b) { return std::isnan(b->x) ? kInf : b->x; };
  std::stable_sort(sorted.begin(), sorted.end(), [&sortX](const IslandBody* a, const IslandBody* b) {
    const double ax = sortX(a);
    const double bx = sortX(b);
    if (ax != bx) return ax < bx;
    return a->key < b->key;
  });
  double widest = 0.0;
  for (const IslandBody* b : sorted) widest = JsMax(widest, b->radius);
  for (std::size_t i = 0; i < sorted.size(); ++i) {
    const IslandBody& a = *sorted[i];
    for (std::size_t j = i + 1; j < sorted.size(); ++j) {
      const IslandBody& b = *sorted[j];
      if (b.x - a.x > a.radius + widest + margin) break;
      const double dx = b.x - a.x;
      const double dy = b.y - a.y;
      const double dz = b.z - a.z;
      const double reach = a.radius + b.radius + margin;
      if (dx * dx + dy * dy + dz * dz <= reach * reach) join(a.key, b.key);
    }
  }
  for (const auto& link : links) {
    if (parent.count(link.first) != 0 && parent.count(link.second) != 0) join(link.first, link.second);
  }
  std::map<std::string, std::string> out;
  for (const IslandBody& b : islandBodies) out[b.key] = find(b.key);
  return out;
}

/** Whether a seat's preset body is within an island's reach of a body. */
bool Near(const genex::physics::KeyframeBody& b, const genex::physics::KeyframeSeat& s, double margin,
          const genex::physics::PhysDesc& desc) {
  double half[3] = {0.0, 0.0, 0.0};
  if (desc.presetBody) {
    half[0] = desc.presetBody->half[0];
    half[1] = desc.presetBody->half[1];
    half[2] = desc.presetBody->half[2];
  }
  const double radius = b.desc ? genex::physics::BodyRadiusOf(*b.desc) : 0.0;
  const double reach = genex::physics::JsHypot(half[0], half[1], half[2]) + radius + margin;
  return genex::physics::JsHypot(b.row[0] - s.x, b.row[1] - s.y, b.row[2] - (s.z + half[2])) <= reach;
}

/** A body state as its wire row (wireRowOfState → wireRowOfExport). */
genex::physics::WireRow WireRowOfState(const genex::physics::NetStateRest& st, double lengthUnit, double innerDt) {
  using genex::physics::QuantizeBodyValue;
  genex::physics::WireRow out{};
  for (int i = 0; i < 3; ++i) out[static_cast<std::size_t>(i)] = UnsignedZero(st.p[i]);
  for (int i = 0; i < 4; ++i) out[static_cast<std::size_t>(3 + i)] = QuantizeBodyValue(st.q[i], kOrientationMin, kOrientationMax);
  for (int i = 0; i < 3; ++i) {
    out[static_cast<std::size_t>(7 + i)] = QuantizeBodyValue(st.v[i] / lengthUnit, kVelocityMin, kVelocityMax);
  }
  for (int i = 0; i < 3; ++i) out[static_cast<std::size_t>(10 + i)] = QuantizeBodyValue(st.w[i], kVelocityMin, kVelocityMax);
  out[13] = st.sleeping ? 1.0 : 0.0;
  out[14] = genex::physics::RestStepsOf(st.rest, innerDt);
  return out;
}

/** The `q` quantile of `values` (the nearest rank below; quantileOf), 0 for none. A NaN cost sorts last
 *  (the TypeScript's comparator leaves its place to the engine; std::sort needs a strict order). */
double QuantileOf(const std::deque<double>& values, double q) {
  if (values.empty()) return 0.0;
  std::vector<double> sorted(values.begin(), values.end());
  std::stable_sort(sorted.begin(), sorted.end(), [](double a, double b) {
    if (std::isnan(a)) return false;
    if (std::isnan(b)) return true;
    return a < b;
  });
  const double rank = std::floor(q * static_cast<double>(sorted.size()));
  const std::size_t i = (std::min)(sorted.size() - 1, static_cast<std::size_t>(rank));
  return sorted[i];
}

/** A field of a remote seat's body, NaN when it has none (JavaScript reads `undefined` as NaN). */
double FieldOr(const std::map<std::string, double>& body, const char* name, double fallback) {
  const auto it = body.find(name);
  return it == body.end() ? fallback : it->second;
}

Json NumberArray(std::initializer_list<double> values) {
  Json a = Json::MakeArray();
  for (double v : values) a.Push(v);
  return a;
}

}  // namespace genex::physics_predict_detail

namespace genex::physics {

namespace pd = ::genex::physics_predict_detail;
using bodies::Pose;
using bodies::Quat;
using bodies::Vec3;

// ---- the shared rules ----

double Fround(double v) {
  if (std::isnan(v)) return v;
  if (v >= pd::kFroundInfinity) return pd::kInf;
  if (v <= -pd::kFroundInfinity) return -pd::kInf;
  return static_cast<double>(static_cast<float>(v));
}

double JsHypot(double a, double b, double c) {
  // V8's MathHypot: Infinity wins over NaN, then the values scaled by the largest, Kahan-summed.
  const double values[3] = {std::fabs(a), std::fabs(b), std::fabs(c)};
  bool nan = false;
  double max = 0.0;
  for (double v : values) {
    if (std::isnan(v)) {
      nan = true;
    } else if (v > max) {
      max = v;
    }
  }
  if (max == pd::kInf) return pd::kInf;
  if (nan) return pd::kNaN;
  if (max == 0.0) return 0.0;
  double sum = 0.0;
  double compensation = 0.0;
  for (double v : values) {
    const double n = v / max;
    const double summand = n * n - compensation;
    const double preliminary = sum + summand;
    compensation = (preliminary - sum) - summand;
    sum = preliminary;
  }
  return std::sqrt(sum) * max;
}

double QuantizeBodyValue(double v, double min, double max) {
  if (std::isnan(v)) return 0.0;
  double clamped = v;
  if (v < min) {
    clamped = min;
  } else if (v > max) {
    clamped = max;
  }
  return std::floor(((clamped - min) / (max - min)) * pd::kQuantSpan + 0.5);
}

double InnerDtOf(double dt, double substeps) { return Fround(Fround(dt) / substeps); }

double RestStepsOf(double rest, double innerDt) {
  const double steps = std::floor(rest / innerDt + 0.5);
  if (std::isnan(steps) || steps < 0.0) return 0.0;
  return steps < pd::kWireRestMax ? steps : pd::kWireRestMax;
}

std::optional<bodies::Vec3> OutOfViewAt(const std::optional<bodies::Vec3>& listed, bool motionKnown,
                                        const std::optional<bodies::Vec3>& lastSeen) {
  if (listed && motionKnown) return std::nullopt;
  if (lastSeen) return *lastSeen;
  return listed ? *listed : bodies::Vec3{};
}

double BodyRadiusOf(const Json& desc) {
  const Json* colliders = desc.Find("colliders");
  if (colliders == nullptr || !colliders->IsArray()) return 0.0;
  double radius = 0.0;
  for (const Json& c : colliders->Items()) {
    if (!c.IsObject()) continue;
    const Json* shape = c.Find("shape");
    if (shape == nullptr || !shape->IsObject()) continue;
    const Json* offset = c.Find("offset");
    const double o = offset != nullptr && offset->IsObject() ? pd::Length3(offset->Find("p")) : 0.0;
    radius = pd::JsMax(radius, o + pd::ShapeRadius(*shape));
  }
  return radius;
}

double RemoteInputWeight(double j, double tickHz, double decayMs) {
  if (decayMs <= 0.0) return j <= 1.0 ? 1.0 : 0.0;
  const double w = 1.0 - ((j - 1.0) * (1000.0 / tickHz)) / decayMs;
  if (w <= 0.0) return 0.0;
  return w >= 1.0 ? 1.0 : w;
}

double CorrectionTauMs(double metres) {
  if (metres <= pd::kSmallMetres) return pd::kTauSmallMs;
  if (metres >= pd::kLargeMetres) return pd::kTauLargeMs;
  return pd::kTauSmallMs +
         ((metres - pd::kSmallMetres) / (pd::kLargeMetres - pd::kSmallMetres)) * (pd::kTauLargeMs - pd::kTauSmallMs);
}

double CorrectionShare(double age, double tauMs) {
  const double x = pd::JsMax(age, 0.0) / tauMs;
  return (1.0 + x) * std::exp(-x);
}

std::pair<double, double> CorrectionAt(double o0, double r0, double age, double tauMs) {
  const double t = pd::JsMax(age, 0.0);
  const double h = tauMs / 2.0;
  const double e = std::exp(-t / h);
  const double c = r0 + o0 / h;
  return {(o0 + c * t) * e, (r0 - (c * t) / h) * e};
}

double SnapMetresOf(const std::string* kind) {
  const bool player = kind != nullptr && (*kind == "player" || *kind == "vehicle");
  return player ? pd::kSnapPlayerMetres : pd::kSnapOtherMetres;
}

Pose DrawHandoff::Draw(const Pose& pose, bool predicted, double epoch, double now, double snapMetres, double lengthUnit) {
  if (!last_ || last_->epoch != epoch) {
    offset_.reset();
  } else if (last_->predicted != predicted) {
    StartFrom(last_->pose, pose, now, snapMetres, lengthUnit);
  }
  const Pose drawn = Apply(pose, now);
  last_ = Last{drawn, predicted, epoch};
  return drawn;
}

void DrawHandoff::StartFrom(const Pose& from, const Pose& to, double now, double snapMetres, double lengthUnit) {
  const Vec3 dp = pd::V(from.p.x - to.p.x, from.p.y - to.p.y, from.p.z - to.p.z);
  const double metres = JsHypot(dp.x, dp.y, dp.z) / lengthUnit;
  if (metres > snapMetres) {
    offset_.reset();
    return;
  }
  const Quat raw = bodies::Mul(from.q, pd::Q(-to.q.x, -to.q.y, -to.q.z, to.q.w));
  const Quat dq = raw.w < 0.0 ? pd::Q(-raw.x, -raw.y, -raw.z, -raw.w) : raw;
  offset_ = Offset{dp, dq, now, CorrectionTauMs(metres)};
}

Pose DrawHandoff::Apply(const Pose& pose, double now) const {
  if (!offset_) return pose;
  const Offset& o = *offset_;
  const double k = CorrectionShare(now - o.since, o.tau);
  Pose out;
  out.p = pd::V(pose.p.x + o.dp.x * k, pose.p.y + o.dp.y * k, pose.p.z + o.dp.z * k);
  out.q = bodies::Mul(bodies::SlerpFromIdentity(o.dq, k), pose.q);
  return out;
}

std::optional<Pose> RuledPoseAt(const KinematicRule& rule, const std::string& key, double at, double tickHz, double tickOrigin) {
  if (!rule) return std::nullopt;
  const double f = ((at - tickOrigin) * tickHz) / 1000.0;
  const double tick = std::floor(f);
  const std::optional<Pose> a = rule(key, tick);
  const std::optional<Pose> b = rule(key, tick + 1.0);
  if (!a || !b) return std::nullopt;
  const double k = f - tick;
  Pose out;
  out.p = pd::V(a->p.x + (b->p.x - a->p.x) * k, a->p.y + (b->p.y - a->p.y) * k, a->p.z + (b->p.z - a->p.z) * k);
  out.q = bodies::Normalize(a->q);
  return out;
}

WireRow WireRowOfFields(const bodies::BodyFields& f, double rest) {
  WireRow out{};
  out[0] = pd::UnsignedZero(f.x);
  out[1] = pd::UnsignedZero(f.y);
  out[2] = pd::UnsignedZero(f.z);
  out[3] = QuantizeBodyValue(f.qx, pd::kOrientationMin, pd::kOrientationMax);
  out[4] = QuantizeBodyValue(f.qy, pd::kOrientationMin, pd::kOrientationMax);
  out[5] = QuantizeBodyValue(f.qz, pd::kOrientationMin, pd::kOrientationMax);
  out[6] = QuantizeBodyValue(f.qw, pd::kOrientationMin, pd::kOrientationMax);
  out[7] = QuantizeBodyValue(f.lvx, pd::kVelocityMin, pd::kVelocityMax);
  out[8] = QuantizeBodyValue(f.lvy, pd::kVelocityMin, pd::kVelocityMax);
  out[9] = QuantizeBodyValue(f.lvz, pd::kVelocityMin, pd::kVelocityMax);
  out[10] = QuantizeBodyValue(f.avx, pd::kVelocityMin, pd::kVelocityMax);
  out[11] = QuantizeBodyValue(f.avy, pd::kVelocityMin, pd::kVelocityMax);
  out[12] = QuantizeBodyValue(f.avz, pd::kVelocityMin, pd::kVelocityMax);
  out[13] = f.sleep ? 1.0 : 0.0;
  out[14] = rest;
  return out;
}

std::optional<std::size_t> NextPredictSetSize(std::size_t current, double chosen) {
  constexpr std::size_t kSizes = sizeof(kPredictSetSizes) / sizeof(kPredictSetSizes[0]);
  for (std::size_t i = current + 1; i < kSizes; ++i) {
    if (static_cast<double>(kPredictSetSizes[i]) < chosen) return i;
  }
  return std::nullopt;
}

const char* PredictStatusName(PredictStatus status) {
  switch (status) {
    case PredictStatus::On:
      return "on";
    case PredictStatus::Off:
      return "off";
    case PredictStatus::Loading:
      return "loading";
    case PredictStatus::Unavailable:
      return "unavailable";
    case PredictStatus::Mismatch:
      return "mismatch";
    case PredictStatus::SelfTest:
      return "self_test";
    case PredictStatus::Diverged:
      return "diverged";
    case PredictStatus::Cpu:
      return "cpu";
  }
  return "off";
}

const char* AdoptKindName(AdoptReport::Kind kind) {
  switch (kind) {
    case AdoptReport::Kind::Match:
      return "match";
    case AdoptReport::Kind::Replay:
      return "replay";
    case AdoptReport::Kind::None:
      return "none";
  }
  return "none";
}

std::optional<PhysDesc> PhysDescOf(const Json& raw) {
  if (!raw.IsObject()) return std::nullopt;
  const Json* world = raw.Find("world");
  if (world == nullptr || !world->IsObject()) return std::nullopt;
  const Json* k = raw.Find("keyframeTicks");
  const Json* maxLinear = raw.Find("maxLinear");
  const Json* maxAngular = raw.Find("maxAngular");
  const auto positive = [](const Json* v) { return v != nullptr && v->IsNumber() && std::isfinite(v->AsNumber()) && v->AsNumber() > 0.0; };
  const bool whole = k != nullptr && k->IsNumber() && std::isfinite(k->AsNumber()) && k->AsNumber() >= 1.0 &&
                     k->AsNumber() == std::floor(k->AsNumber()) && k->AsNumber() <= 1.0e6;
  if (!whole || !positive(maxLinear) || !positive(maxAngular)) return std::nullopt;
  PhysDesc d;
  d.world = *world;
  d.keyframeTicks = static_cast<int>(k->AsNumber());
  d.maxLinear = maxLinear->AsNumber();
  d.maxAngular = maxAngular->AsNumber();
  const Json* preset = raw.Find("presetBody");
  const Json* half = preset != nullptr && preset->IsObject() ? preset->Find("half") : nullptr;
  if (half != nullptr && half->IsArray() && half->Size() == 3) {
    PresetBodyShape shape;
    for (std::size_t i = 0; i < 3; ++i) shape.half[i] = pd::NumberOf(&half->At(i));
    const Json* events = preset->Find("events");
    shape.events = events != nullptr && events->IsBool() && events->AsBool();
    d.presetBody = shape;
  }
  const Json* remote = raw.Find("remotePredict");
  if (remote != nullptr && remote->IsString() && remote->AsString() == "inputDecay") d.remotePredict = RemotePredict::InputDecay;
  if (remote != nullptr && remote->IsString() && remote->AsString() == "hold") d.remotePredict = RemotePredict::Hold;
  const auto numberIn = [](const Json* v, double min, double max) {
    return v != nullptr && v->IsNumber() && std::isfinite(v->AsNumber()) && v->AsNumber() >= min && v->AsNumber() <= max;
  };
  const Json* decay = raw.Find("remoteDecayMs");
  if (numberIn(decay, 0.0, pd::kMaxRemoteDecayMs)) d.remoteDecayMs = decay->AsNumber();
  const Json* lead = raw.Find("leadMs");
  if (numberIn(lead, pd::kMinLeadMs, pd::kMaxLeadMs)) d.leadMs = lead->AsNumber();
  return d;
}

std::optional<PhysDesc> ParsePhysDesc(const std::string& text) {
  if (text.empty()) return std::nullopt;
  const std::optional<Json> raw = Json::Parse(text);
  if (!raw) return std::nullopt;
  return PhysDescOf(*raw);
}

// ---- the predictor ----

PhysicsPredictor::PhysicsPredictor(std::shared_ptr<PredictCore> core, PredictorOptions options)
    : core_(std::move(core)), desc_(std::move(options.desc)) {
  tickHz_ = options.tickHz;
  innerDt_ = InnerDtOf(pd::NumberOf(desc_.world.Find("dt")), pd::NumberOf(desc_.world.Find("substeps")));
  lengthUnit_ = Fround(pd::NumberOf(desc_.world.Find("lengthUnit")));
  const Json* limits = desc_.world.Find("limits");
  const Json* extent = limits != nullptr ? limits->Find("worldExtent") : nullptr;
  worldExtent_ = extent != nullptr && extent->IsNumber() ? extent->AsNumber() : pd::kInf;
  // The lead cap's ticks past the latest keyframe's ack, plus the K − 1 ticks until the next keyframe.
  const double leadMs = options.leadMs ? *options.leadMs : desc_.leadMs;
  leadMax_ = static_cast<int>(std::ceil((leadMs * options.tickHz) / 1000.0)) + desc_.keyframeTicks - 1;
  const bool stepped = desc_.remotePredict == RemotePredict::InputDecay || desc_.remotePredict == RemotePredict::Hold;
  if (stepped) remoteStep_ = std::move(options.remoteStep);
  seatPose_ = std::move(options.seatPose);
  contactPass_ = std::move(options.contactPass);
  budgetMs_ = options.budgetMs;
  clock_ = std::move(options.clock);
  hashesKept_ = options.hashesKept;
  bodyRule_ = std::move(options.bodyRule);
  seatRule_ = std::move(options.seatRule);
  kinematicRule_ = std::move(options.kinematicRule);
  lifts_ = std::move(options.lifts);
  if (!core_) {
    status_ = PredictStatus::Unavailable;
    return;
  }
  CoreResult refused;
  std::unique_ptr<PredictWorld> world = core_->CreateWorld(desc_.world, &refused);
  if (!world) {
    status_ = PredictStatus::Mismatch;
    return;
  }
  if (!options.staticWorld.Empty() && !world->AddStaticWorld(options.staticWorld).ok) {
    status_ = PredictStatus::Mismatch;
    return;
  }
  if (world->PhysicsHash() != options.physicsHash) {
    status_ = PredictStatus::Mismatch;
    return;
  }
  world_ = std::move(world);
}

PhysicsPredictor::~PhysicsPredictor() = default;

double PhysicsPredictor::Now() const { return clock_ ? clock_() : Clock::NowMs(); }

bool PhysicsPredictor::Draws(const std::string& key) const {
  return status_ == PredictStatus::On && (drawn_.count(key) != 0 || RuledElsewhere(key));
}

bool PhysicsPredictor::Ruled(const std::string& key) const {
  if (!kinematicRule_) return false;
  const double tick = base_ ? base_->tick + (seq_ - base_->ack) : 0.0;
  return kinematicRule_(key, tick).has_value();
}

bool PhysicsPredictor::RuledElsewhere(const std::string& key) const {
  return base_.has_value() && drawn_.count(key) == 0 && Ruled(key);
}

std::optional<Pose> PhysicsPredictor::RuledDrawn(const std::string& key, double now) const {
  const std::optional<double> tick = RuledTick(now);
  if (!kinematicRule_ || !tick) return std::nullopt;
  const double t = std::floor(*tick);
  const std::optional<Pose> a = kinematicRule_(key, t);
  const std::optional<Pose> b = kinematicRule_(key, t + 1.0);
  if (!a || !b) return std::nullopt;
  const double k = *tick - t;
  Pose out;
  out.p = pd::V(a->p.x + (b->p.x - a->p.x) * k, a->p.y + (b->p.y - a->p.y) * k, a->p.z + (b->p.z - a->p.z) * k);
  out.q = bodies::Normalize(a->q);
  return out;
}

std::optional<double> PhysicsPredictor::RuledTick(double now) const {
  if (!base_) return std::nullopt;
  const double k = pd::JsMin(pd::JsMax(((now - steppedAt_) / 1000.0) * tickHz_, 0.0), 1.0);
  const double target = base_->tick + (seq_ - base_->ack) + 1.0 + k;
  if (!ruledClock_ || now < ruledClock_->at || std::fabs(target - ruledClock_->tick) > kRuledSnapTicks) {
    ruledClock_ = RuledClock{now, target};
    return target;
  }
  const double passed = ((now - ruledClock_->at) / 1000.0) * tickHz_;
  const double free = ruledClock_->tick + passed;
  const double slew = kRuledSlew * passed;
  const double tick = free + pd::JsMin(pd::JsMax(target - free, -slew), slew);
  ruledClock_ = RuledClock{now, tick};
  return tick;
}

std::string PhysicsPredictor::StateHash() { return world_ ? world_->StateHash() : std::string(); }

void PhysicsPredictor::Stop(PredictStatus status) {
  status_ = status;
  world_.reset();
  drawn_.clear();
}

AdoptReport PhysicsPredictor::Adopt(const PredictKeyframe& kf, double sent, const OwnPoseOf& ownPose, double now,
                                    const OwnPoseOf& ownVelocity) {
  const AdoptReport none;
  if (!world_) return none;
  const bool probing = status_ == PredictStatus::Cpu;
  // In cpu only a probe adopts: one keyframe every kCpuProbeMs, by a full replay.
  if (probing && now - probedAt_ < kCpuProbeMs) return none;
  if (!probing && !Predicting()) return none;
  ownPose_ = ownPose;
  ownVelocity_ = ownVelocity;
  const std::vector<const KeyframeBody*> chosen = Choose(kf);
  // Bodies the module respawned since the keyframe that last carried them (their epoch moved): a deliberate
  // discontinuity (§17.3), no canary sample and never eased from the old life.
  std::set<std::string> respawned;
  for (const KeyframeBody* b : chosen) {
    const auto known = epochs_.find(b->key);
    if (b->epoch && known != epochs_.end() && known->second != *b->epoch) respawned.insert(b->key);
  }
  for (const KeyframeBody* b : chosen) {
    if (b->epoch) epochs_[b->key] = *b->epoch;
  }
  AdoptReport report;
  report.kind = AdoptReport::Kind::Replay;
  if (!probing) report = Compare(kf, chosen, respawned);
  // The canary may have just turned prediction off.
  if (!world_) {
    report.kind = AdoptReport::Kind::None;
    return report;
  }
  if (report.kind == AdoptReport::Kind::Match) {
    base_ = Base{kf.tick, kf.ack};
    // The seats move on from this keyframe (their bodies stay: same epochs), and module kinematic
    // bodies take its poses (the latest server state).
    for (const KeyframeSeat* seat : SeatsOf(kf)) HoldSeat(*seat);
    for (const KeyframeBody* b : chosen) {
      if (kinematic_.Has(b->key)) kinematic_.Set(b->key, b->row);
    }
    Prune(kf.tick);
    status_ = PredictStatus::On;
    return report;
  }
  // A probe starts every drawn body afresh: what was drawn in cpu was §17.10's drawing.
  if (probing) drawn_.clear();
  const std::map<std::string, DrawnAt> before = SnapshotDrawn(now);
  const double started = Now();
  if (!Rebuild(kf, chosen)) {
    Stop(PredictStatus::Mismatch);
    return none;
  }
  base_ = Base{kf.tick, kf.ack};
  seq_ = kf.ack;
  ring_.clear();
  ReadAll();
  const double target = (std::min)(sent, kf.ack + static_cast<double>(leadMax_));
  int replayed = 0;
  for (double s = kf.ack + 1.0; s <= target; s += 1.0) {
    StepOnce();
    // A step the core refused stopped prediction (diverged) and freed the world: the replay ends there.
    if (!world_) break;
    ++replayed;
  }
  const double ms = Now() - started;
  report.kind = AdoptReport::Kind::Replay;
  report.replayed = replayed;
  report.ms = ms;
  if (!world_) return report;
  steppedAt_ = now;
  Ease(before, now, respawned);
  if (probing) {
    JudgeProbe(ms, now);
  } else {
    status_ = PredictStatus::On;
    JudgeBudget(ms);
  }
  return report;
}

void PhysicsPredictor::Advance(double seq, double now) {
  if (!world_ || !base_ || status_ != PredictStatus::On) return;
  if (seq != seq_ + 1.0 || seq - base_->ack > static_cast<double>(leadMax_)) return;
  StepOnce();
  steppedAt_ = now;
}

std::optional<Pose> PhysicsPredictor::Draw(const std::string& key, double now) const {
  if (status_ != PredictStatus::On) return std::nullopt;
  const auto it = drawn_.find(key);
  if (it == drawn_.end()) return RuledElsewhere(key) ? RuledDrawn(key, now) : std::nullopt;
  const Drawn& d = it->second;
  const double dt = d.sleep ? 0.0 : pd::JsMin(pd::JsMax((now - steppedAt_) / 1000.0, 0.0), 1.0 / tickHz_);
  const double u = lengthUnit_;
  const Vec3 p = pd::V(d.p.x + d.lv.x * u * dt, d.p.y + d.lv.y * u * dt, d.p.z + d.lv.z * u * dt);
  const Quat q = pd::Turned(d.q, d.av, dt);
  const double age = pd::JsMax(now - d.since, 0.0);
  const auto ox = CorrectionAt(d.dp.x, d.dv.x, age, d.tau);
  const auto oy = CorrectionAt(d.dp.y, d.dv.y, age, d.tau);
  const auto oz = CorrectionAt(d.dp.z, d.dv.z, age, d.tau);
  Pose out;
  out.p = pd::V(p.x + ox.first, p.y + oy.first, p.z + oz.first);
  out.q = bodies::Mul(bodies::SlerpFromIdentity(d.dq, std::exp(-age / d.tau)), q);
  return out;
}

// ---- adoption ----

std::vector<const KeyframeBody*> PhysicsPredictor::Choose(const PredictKeyframe& kf) {
  const double margin = pd::kIslandMarginMetres * lengthUnit_;
  std::vector<pd::IslandBody> islandBodies;
  std::map<std::string, const KeyframeBody*> inView;
  for (const KeyframeBody& b : kf.bodies) {
    inView[b.key] = &b;
    pd::IslandBody ib;
    ib.key = b.key;
    ib.x = b.row[0];
    ib.y = b.row[1];
    ib.z = b.row[2];
    ib.radius = b.desc ? BodyRadiusOf(*b.desc) : 0.0;
    islandBodies.push_back(ib);
  }
  for (const KeyframeOutside& o : kf.outside) {
    pd::IslandBody ib;
    ib.key = o.key;
    ib.x = o.x;
    ib.y = o.y;
    ib.z = o.z;
    ib.radius = o.radius;
    islandBodies.push_back(ib);
  }
  std::vector<std::pair<std::string, std::string>> links;
  for (const KeyframeJoint& j : kf.joints) {
    const Json* a = j.desc.Find("a");
    const Json* b = j.desc.Find("b");
    if (a != nullptr && a->IsString() && b != nullptr && b->IsString()) links.emplace_back(a->AsString(), b->AsString());
  }
  const std::map<std::string, std::string> islands = pd::ProximityIslands(islandBodies, links, margin);
  InsertionMap<std::vector<std::string>> members;
  for (const pd::IslandBody& b : islandBodies) {
    const std::string& island = islands.at(b.key);
    std::vector<std::string>* list = members.Get(island);
    if (list == nullptr) {
      members.Set(island, std::vector<std::string>{b.key});
    } else {
      list->push_back(b.key);
    }
  }
  const KeyframeSeat* own = nullptr;
  for (const KeyframeSeat& s : kf.seats) {
    if (s.own) {
      own = &s;
      break;
    }
  }
  const auto distance = [&inView, own](const std::string& key) {
    const KeyframeBody* b = inView.at(key);
    if (own == nullptr) return 0.0;
    return JsHypot(b->row[0] - own->x, b->row[1] - own->y, b->row[2] - own->z);
  };
  // `nearest`, never `near`: Windows headers define `near` (and `far`) as empty macros.
  struct Complete {
    std::string island;
    const std::vector<std::string>* keys = nullptr;
    double nearest = 0.0;
  };
  std::vector<Complete> complete;
  for (const auto& entry : members.Items()) {
    bool whole = true;
    for (const std::string& k : entry.second) {
      const auto it = inView.find(k);
      if (it == inView.end() || !it->second->desc) {
        whole = false;
        break;
      }
    }
    if (!whole) continue;
    double nearest = pd::kInf;
    for (const std::string& k : entry.second) nearest = pd::JsMin(nearest, distance(k));
    // A NaN distance sorts last (std::sort needs a strict order; V8's for NaN is unspecified).
    complete.push_back(Complete{entry.first, &entry.second, std::isnan(nearest) ? pd::kInf : nearest});
  }
  std::stable_sort(complete.begin(), complete.end(), [](const Complete& a, const Complete& b) {
    if (a.nearest != b.nearest) return a.nearest < b.nearest;
    return a.island < b.island;
  });
  const std::size_t cap = static_cast<std::size_t>(kPredictSetSizes[setSize_]);
  std::vector<const KeyframeBody*> chosen;
  pure_.clear();
  for (const Complete& c : complete) {
    if (chosen.size() + c.keys->size() > cap) continue;
    for (const std::string& k : *c.keys) chosen.push_back(inView.at(k));
    // A seat is near an island where this keyframe has it or where the world last had it (the previous keyframe):
    // the world moved that seat by extrapolation from there, so a seat the module respawned or that left between
    // keyframes still made the bodies it left impure (Mechanism Hall's cycle start).
    const auto nearAny = [&](const KeyframeSeat& s) {
      for (const std::string& k : *c.keys) {
        if (pd::Near(*inView.at(k), s, margin, desc_)) return true;
      }
      return false;
    };
    bool seatNear = false;
    for (const KeyframeSeat& s : kf.seats) seatNear = seatNear || nearAny(s);
    for (const auto& held : seats_.Items()) seatNear = seatNear || nearAny(held.second);
    bool kinematic = false;
    for (const std::string& k : *c.keys) kinematic = kinematic || pd::IsKinematic(inView.at(k)->desc);
    if (!seatNear && !kinematic) {
      for (const std::string& k : *c.keys) pure_.insert(k);
    }
  }
  std::stable_sort(chosen.begin(), chosen.end(),
                   [](const KeyframeBody* a, const KeyframeBody* b) { return a->key < b->key; });
  chosenKeys_.clear();
  for (const KeyframeBody* b : chosen) chosenKeys_.insert(b->key);
  double count = 0.0;
  for (const Complete& c : complete) count += static_cast<double>(c.keys->size());
  chosenCount_ = count;
  return chosen;
}

AdoptReport PhysicsPredictor::Compare(const PredictKeyframe& kf, const std::vector<const KeyframeBody*>& chosen,
                                      const std::set<std::string>& respawned) {
  AdoptReport replay;
  replay.kind = AdoptReport::Kind::Replay;
  replay.miss = AdoptReport::Miss::NoPrediction;
  const auto predictedIt = ring_.find(kf.tick);
  if (!base_ || predictedIt == ring_.end()) return replay;
  const std::map<std::string, WireRow>& predicted = predictedIt->second;
  int pure = 0;
  int mismatched = 0;
  bool all = true;
  for (const KeyframeBody* b : chosen) {
    // Module kinematic bodies are posed from the keyframe, never predicted: not compared.
    if (pd::IsKinematic(b->desc)) continue;
    const auto mine = predicted.find(b->key);
    const bool equal = mine != predicted.end() && pd::SameRow(mine->second, b->row);
    // A body the world did not predict for this keyframe (it just entered the set: the view, an island now whole)
    // has nothing to compare: no canary sample, though the keyframe is no match.
    if (pure_.count(b->key) != 0 && respawned.count(b->key) == 0 && mine != predicted.end()) {
      ++pure;
      if (!equal) ++mismatched;
    }
    if (!equal) all = false;
  }
  NoteCanary(pure, mismatched);
  bool sameSet = chosen.size() == simulated_.Size();
  for (const KeyframeBody* b : chosen) {
    const Simulated* sim = simulated_.Get(b->key);
    sameSet = sameSet && sim != nullptr && sim->desc == pd::DescKey(b->desc);
  }
  const bool ackOnTime = kf.ack == base_->ack + (kf.tick - base_->tick) && seq_ >= kf.ack;
  AdoptReport report = replay;
  report.pure = pure;
  report.mismatched = mismatched;
  // Each check runs only when the ones before it passed, as one && chain would.
  if (!all) {
    report.miss = AdoptReport::Miss::Rows;
  } else if (!sameSet) {
    report.miss = AdoptReport::Miss::BodySet;
  } else if (!ackOnTime) {
    report.miss = AdoptReport::Miss::AckLate;
  } else if (!SameJoints(kf)) {
    report.miss = AdoptReport::Miss::Joints;
  } else if (!SameSeats(kf, predicted)) {
    report.miss = AdoptReport::Miss::Seats;
  } else {
    report.miss = AdoptReport::Miss::None;
    report.kind = AdoptReport::Kind::Match;
  }
  return report;
}

bool PhysicsPredictor::SameJoints(const PredictKeyframe& kf) const {
  const InsertionMap<WantedJoint> wanted = JointsOf(kf);
  if (wanted.Size() != joints_.Size()) return false;
  for (const auto& entry : wanted.Items()) {
    const JointText* mine = joints_.Get(entry.first);
    if (mine == nullptr || mine->desc != entry.second.desc || mine->motor != entry.second.motor) return false;
  }
  return true;
}

bool PhysicsPredictor::SameSeats(const PredictKeyframe& kf, const std::map<std::string, WireRow>& predicted) const {
  const std::vector<const KeyframeSeat*> wanted = SeatsOf(kf);
  if (wanted.size() != seats_.Size()) return false;
  for (const KeyframeSeat* s : wanted) {
    const auto mine = predicted.find("seat:" + s->key);
    const KeyframeSeat* known = seats_.Get(s->key);
    if (mine == predicted.end() || known == nullptr || known->epoch != s->epoch) return false;
    double p[3];
    PresetPosition(s->x, s->y, s->z, p);
    if (!(mine->second[0] == p[0] && mine->second[1] == p[1] && mine->second[2] == p[2])) return false;
  }
  return true;
}

void PhysicsPredictor::NoteCanary(int pure, int mismatched) {
  for (int i = 0; i < pure; ++i) canary_.push_back(i < mismatched);
  while (canary_.size() > kCanaryWindow) canary_.pop_front();
  if (canary_.size() < kCanaryMinSamples) return;
  std::size_t bad = 0;
  for (bool b : canary_) bad += b ? 1u : 0u;
  if (static_cast<double>(bad) / static_cast<double>(canary_.size()) > kCanaryMaxMismatch) Stop(PredictStatus::Diverged);
}

void PhysicsPredictor::JudgeBudget(double ms) {
  costs_.push_back(ms);
  while (costs_.size() > kBudgetWindow) costs_.pop_front();
  if (costs_.size() < kBudgetMinSamples) return;
  const double median = pd::QuantileOf(costs_, 0.5);
  const double p90 = pd::QuantileOf(costs_, 0.9);
  const bool over = median > budgetMs_ || p90 > kBudgetP90Factor * budgetMs_;
  if (over) {
    costs_.clear();
    const std::optional<std::size_t> next = NextPredictSetSize(setSize_, chosenCount_);
    if (next) {
      setSize_ = *next;
      return;
    }
    FallBack();
    return;
  }
  const bool calm = costs_.size() >= kBudgetWindow && p90 <= kBudgetCalmShare * budgetMs_;
  if (calm && setSize_ > 0) {
    --setSize_;
    costs_.clear();
  }
}

void PhysicsPredictor::FallBack() {
  status_ = PredictStatus::Cpu;
  ++fallbacks_;
  drawn_.clear();
  probedAt_ = -pd::kInf;
  calmProbes_ = 0;
}

void PhysicsPredictor::JudgeProbe(double ms, double now) {
  probedAt_ = now;
  calmProbes_ = ms <= kBudgetCalmShare * budgetMs_ ? calmProbes_ + 1 : 0;
  if (calmProbes_ < kCpuCalmProbes) {
    // Not drawn: the probe's world is kept for the next one, its drawing dropped.
    drawn_.clear();
    return;
  }
  status_ = PredictStatus::On;
  ++recoveries_;
  costs_.clear();
  calmProbes_ = 0;
}

void PhysicsPredictor::HoldSeat(const KeyframeSeat& seat) {
  seats_.Set(seat.key, seat);
  seatSerial_[seat.key] = ++nextSeatSerial_;
}

InsertionMap<PhysicsPredictor::WantedJoint> PhysicsPredictor::JointsOf(const PredictKeyframe& kf) const {
  InsertionMap<WantedJoint> out;
  const auto known = [this](const std::string& key) { return simulated_.Has(key) || chosenKeys_.count(key) != 0; };
  for (const KeyframeJoint& j : kf.joints) {
    const Json* a = j.desc.Find("a");
    const Json* b = j.desc.Find("b");
    if (a == nullptr || !a->IsString() || !known(a->AsString())) continue;
    // `b` null is the world; anything but a body this client simulates leaves the joint out.
    const bool toWorld = b != nullptr && b->IsNull();
    if (!toWorld && (b == nullptr || !b->IsString() || !known(b->AsString()))) continue;
    WantedJoint w;
    w.desc = j.desc.Dump();
    w.motor = j.motor ? j.motor->Dump() : std::string();
    w.parsed = &j;
    out.Set(j.key, std::move(w));
  }
  return out;
}

std::vector<const KeyframeSeat*> PhysicsPredictor::SeatsOf(const PredictKeyframe& kf) const {
  std::vector<const KeyframeSeat*> out;
  if (!desc_.presetBody) return out;
  for (const KeyframeSeat& s : kf.seats) {
    double p[3];
    PresetPosition(s.x, s.y, s.z, p);
    const bool inside = std::fabs(p[0]) <= worldExtent_ && std::fabs(p[1]) <= worldExtent_ && std::fabs(p[2]) <= worldExtent_;
    if (inside) out.push_back(&s);
  }
  std::stable_sort(out.begin(), out.end(), [](const KeyframeSeat* a, const KeyframeSeat* b) { return a->key < b->key; });
  return out;
}

void PhysicsPredictor::PresetPosition(double x, double y, double z, double out[3]) const {
  const double half = desc_.presetBody ? desc_.presetBody->half[2] : 0.0;
  out[0] = Fround(x);
  out[1] = Fround(y);
  out[2] = Fround(Fround(z) + half);
}

bool PhysicsPredictor::Rebuild(const PredictKeyframe& kf, const std::vector<const KeyframeBody*>& chosen) {
  PredictWorld& world = *world_;
  const InsertionMap<WantedJoint> wantedJoints = JointsOf(kf);
  std::vector<std::string> jointKeys;
  for (const auto& entry : joints_.Items()) jointKeys.push_back(entry.first);
  for (const std::string& key : jointKeys) {
    const WantedJoint* want = wantedJoints.Get(key);
    if (want != nullptr && want->desc == joints_.Get(key)->desc) continue;
    world.RemoveJoint(key);
    joints_.Delete(key);
  }
  const std::vector<std::pair<std::string, Simulated>> simulated = simulated_.Items();
  for (const auto& entry : simulated) {
    const KeyframeBody* want = nullptr;
    for (const KeyframeBody* b : chosen) {
      if (b->key == entry.first) {
        want = b;
        break;
      }
    }
    if (want != nullptr && pd::DescKey(want->desc) == entry.second.desc) continue;
    world.Remove(entry.first);
    simulated_.Delete(entry.first);
    kinematic_.Delete(entry.first);
    drawn_.erase(entry.first);
  }
  for (const KeyframeBody* b : chosen) {
    if (simulated_.Has(b->key) || !b->desc) continue;
    if (!world.Spawn(*b->desc).ok) return false;
    const Json* kind = b->desc->Find("kind");
    if (kind != nullptr && kind->IsString()) {
      kinds_[b->key] = kind->AsString();
    } else {
      kinds_.erase(b->key);
    }
    simulated_.Set(b->key, Simulated{pd::TypeOf(*b->desc), pd::DescKey(b->desc)});
  }
  kinematic_.Clear();
  for (const KeyframeBody* b : chosen) {
    if (!pd::IsKinematic(b->desc)) continue;
    kinematic_.Set(b->key, b->row);
    // One the kinematic rule poses is drawn by the predictor, its correction kept like any body's.
    if (!Ruled(b->key)) drawn_.erase(b->key);
  }
  if (!RebuildSeats(kf)) return false;
  for (const auto& entry : wantedJoints.Items()) {
    const WantedJoint& j = entry.second;
    if (!joints_.Has(entry.first) && !world.AddJoint(j.parsed->desc).ok) return false;
    const JointText* known = joints_.Get(entry.first);
    const bool motorMoved = known == nullptr || known->motor != j.motor;
    if (j.parsed->motor && motorMoved && !world.SetMotor(entry.first, *j.parsed->motor).ok) return false;
    joints_.Set(entry.first, JointText{j.desc, j.motor});
  }
  std::vector<std::string> keys;
  std::vector<float> rows;
  for (const KeyframeBody* b : chosen) {
    keys.push_back(b->key);
    pd::AppendRowF32(rows, b->row.data(), kWireRowStride);
  }
  for (const auto& entry : seats_.Items()) {
    keys.push_back(entry.first);
    double p[3];
    PresetPosition(entry.second.x, entry.second.y, entry.second.z, p);
    pd::AppendRowF32(rows, p, 3);
    pd::AppendRowF32(rows, pd::kPresetRowTail, 12);
  }
  if (!RebuildLifts(kf.tick, keys, rows)) return false;
  if (!keys.empty() && !world.ImportWire(keys, rows).ok) return false;
  return world.Canonicalize(true).ok;
}

bool PhysicsPredictor::RebuildLifts(double tick, std::vector<std::string>& keys, std::vector<float>& rows) {
  if (!lifts_ || lifts_->Count() == 0) return true;
  if (!liftsSpawned_) {
    for (std::size_t i = 0; i < lifts_->Count(); ++i) {
      if (!world_->Spawn(lifts_->Spawn(i, tick + 1)).ok) return false;
    }
    liftsSpawned_ = true;
  }
  static constexpr double kStillRowTail[8] = {32767, 32767, 32767, 32767, 32767, 32767, 0, 0};
  for (std::size_t i = 0; i < lifts_->Count(); ++i) {
    double row[7];
    double q[4];
    lifts_->Pose(i, tick + 1, row, q);
    keys.push_back(lifts_->Key(i));
    for (int k = 0; k < 4; ++k) row[3 + k] = std::floor(((q[k] + 1) / 2) * 65534 + 0.5);
    pd::AppendRowF32(rows, row, 7);
    pd::AppendRowF32(rows, kStillRowTail, 8);
  }
  return true;
}

bool PhysicsPredictor::RebuildSeats(const PredictKeyframe& kf) {
  PredictWorld& world = *world_;
  InsertionMap<const KeyframeSeat*> wanted;
  for (const KeyframeSeat* s : SeatsOf(kf)) wanted.Set(s->key, s);
  const std::vector<std::pair<std::string, KeyframeSeat>> seats = seats_.Items();
  for (const auto& entry : seats) {
    const KeyframeSeat* const* want = wanted.Get(entry.first);
    if (want != nullptr && (*want)->epoch == entry.second.epoch) continue;
    world.Remove(entry.first);
    seats_.Delete(entry.first);
  }
  for (const auto& entry : wanted.Items()) {
    const KeyframeSeat& s = *entry.second;
    if (!seats_.Has(entry.first) && desc_.presetBody) {
      double p[3];
      PresetPosition(s.x, s.y, s.z, p);
      Json shape = Json::MakeObject();
      shape.Set("kind", "box");
      shape.Set("half", pd::NumberArray({desc_.presetBody->half[0], desc_.presetBody->half[1], desc_.presetBody->half[2]}));
      Json collider = Json::MakeObject();
      collider.Set("key", "hull");
      collider.Set("shape", std::move(shape));
      collider.Set("events", desc_.presetBody->events);
      Json colliders = Json::MakeArray();
      colliders.Push(std::move(collider));
      Json pose = Json::MakeObject();
      pose.Set("p", pd::NumberArray({p[0], p[1], p[2]}));
      pose.Set("q", pd::NumberArray({0.0, 0.0, 0.0, 1.0}));
      Json body = Json::MakeObject();
      body.Set("key", entry.first);
      body.Set("type", "kinematic");
      body.Set("pose", std::move(pose));
      body.Set("colliders", std::move(colliders));
      if (!world.Spawn(body).ok) return false;
    }
    HoldSeat(s);
  }
  return true;
}

// ---- one predicted tick: the server's order (§17.11 *The tick*) ----

void PhysicsPredictor::StepOnce() {
  if (!world_ || !base_) return;
  const Base base = *base_;
  const double seq = seq_ + 1.0;
  const double tick = base.tick + (seq - base.ack);
  static const double kIdentity[4] = {0.0, 0.0, 0.0, 1.0};
  std::vector<RuleSeat> seats;
  bool seatsPosed = false;
  // SeatAt may continue a remote seat's memo; seats_ itself is not changed while it is walked.
  for (const auto& entry : seats_.Items()) {
    seats.push_back(SeatAt(entry.second, seq, tick - base.tick));
    seatsPosed = seatsPosed || posedBySeats_;
  }
  if (!seatsPosed) PassSeats(seats);
  for (std::size_t i = 0; i < seats.size(); ++i) {
    const RuleSeat& at = seats[i];
    double p[3];
    PresetPosition(at.x, at.y, at.z, p);
    world_->SetNextKinematicPose(seats_.Items()[i].first, p, kIdentity);
  }
  // A module kinematic body holds the keyframe's pose, unless the room's kinematic rule poses it: then the rule's
  // pose at the end of this tick's step, as the module sends it (§17.11 *Kinematic rules*).
  for (const auto& entry : kinematic_.Items()) {
    double p[3];
    double q[4];
    const std::optional<Pose> posed = kinematicRule_ ? kinematicRule_(entry.first, tick + 1.0) : std::nullopt;
    if (posed) {
      p[0] = posed->p.x;
      p[1] = posed->p.y;
      p[2] = posed->p.z;
      q[0] = posed->q.x;
      q[1] = posed->q.y;
      q[2] = posed->q.z;
      q[3] = posed->q.w;
    } else {
      pd::KeyframePose(entry.second, p, q);
    }
    world_->SetNextKinematicPose(entry.first, p, q);
  }
  // The room's lifts at the end of this tick's step, as the host poses them (§17.11 *Lifts* step 9).
  if (lifts_ && liftsSpawned_) {
    for (std::size_t i = 0; i < lifts_->Count(); ++i) {
      double p[3];
      double q[4];
      lifts_->Pose(i, tick + 1, p, q);
      world_->SetNextKinematicPose(lifts_->Key(i), p, q);
    }
  }
  ApplyBodyRule(tick, seats);
  const double since = world_->Tick();
  const StepResult stepped = world_->Step();
  if (!stepped.result.ok) {
    Stop(PredictStatus::Diverged);
    return;
  }
  for (const std::string& key : stepped.escaped) {
    world_->Remove(key);
    simulated_.Delete(key);
    drawn_.erase(key);
  }
  Clamp(since);
  if (std::fmod(tick, static_cast<double>(desc_.keyframeTicks)) == 0.0) {
    world_->Canonicalize(true);
    ring_[tick] = RowsNow();
  }
  seq_ = seq;
  ReadDrawn(since);
  hashes_.push_back(TickHash{tick, world_->StateHash()});
  if (hashesKept_ != 0 && hashes_.size() > hashesKept_) {
    hashes_.erase(hashes_.begin(), hashes_.begin() + static_cast<std::ptrdiff_t>(hashes_.size() - hashesKept_));
  }
}

void PhysicsPredictor::PassSeats(std::vector<RuleSeat>& seats) {
  if (!contactPass_ || seats.size() < 2) return;
  std::vector<ContactBody> bodies;
  for (const RuleSeat& s : seats) {
    ContactBody b;
    b.id = s.key;
    b.x = s.x;
    b.y = s.y;
    b.z = s.z;
    b.vx = s.vx;
    b.vy = s.vy;
    b.vz = s.vz;
    b.yaw = s.yaw;
    bodies.push_back(std::move(b));
  }
  std::stable_sort(bodies.begin(), bodies.end(), [](const ContactBody& a, const ContactBody& b) { return a.id < b.id; });
  contactPass_(bodies);
  for (RuleSeat& s : seats) {
    for (const ContactBody& b : bodies) {
      if (b.id != s.key) continue;
      s.x = b.x;
      s.y = b.y;
      s.z = b.z;
      s.vx = b.vx;
      s.vy = b.vy;
      s.vz = b.vz;
      break;
    }
  }
}

RuleSeat PhysicsPredictor::SeatAt(const KeyframeSeat& s, double seq, double j) {
  posedBySeats_ = false;
  RuleSeat out;
  out.key = s.key;
  if (s.own && ownPose_) {
    const std::optional<Vec3> own = ownPose_(seq);
    if (own) {
      const std::optional<Vec3> v = ownVelocity_ ? ownVelocity_(seq) : std::nullopt;
      out.x = own->x;
      out.y = own->y;
      out.z = own->z;
      out.vx = v ? v->x : s.vx;
      out.vy = v ? v->y : s.vy;
      out.vz = v ? v->z : s.vz;
      return out;
    }
  }
  if (!s.own && seatPose_) {
    if (std::optional<RuleSeat> predicted = seatPose_(s.key, seq)) {
      posedBySeats_ = true;
      predicted->key = s.key;
      return *predicted;
    }
  }
  if (s.own || !remoteStep_ || !s.input) {
    const double ahead = j / tickHz_;
    out.x = s.x + s.vx * ahead;
    out.y = s.y + s.vy * ahead;
    out.z = s.z + s.vz * ahead;
    out.vx = s.vx;
    out.vy = s.vy;
    out.vz = s.vz;
    return out;
  }
  // The seat's body stepped tick by tick from its keyframe entity: a replay asks for j = 1, 2, … in
  // order, so the last stepped body is continued, not stepped again from the keyframe (the same steps).
  const auto serial = seatSerial_.find(s.key);
  const std::uint64_t from = serial == seatSerial_.end() ? 0u : serial->second;
  const auto known = remoteBodies_.find(s.key);
  const bool resume = known != remoteBodies_.end() && known->second.from == from && known->second.j <= j;
  RemoteBody& memo = remoteBodies_[s.key];
  if (!resume) {
    memo.body = s.body;
    memo.body["x"] = s.x;
    memo.body["y"] = s.y;
    memo.body["z"] = s.z;
  }
  const double start = resume ? memo.j : 0.0;
  const double dt = 1.0 / tickHz_;
  const double baseTick = base_ ? base_->tick : 0.0;
  for (double i = start + 1.0; i <= j; i += 1.0) {
    if (seatRule_) seatRule_(memo.body, baseTick + i);
    RemoteInput decayed = *s.input;
    // `hold`: the last input as it was, every tick; `inputDecay`: its axes decayed.
    if (desc_.remotePredict != RemotePredict::Hold) {
      const double w = RemoteInputWeight(i, tickHz_, desc_.remoteDecayMs);
      decayed.moveX = s.input->moveX * w;
      decayed.moveY = s.input->moveY * w;
      decayed.moveZ = s.input->moveZ * w;
    }
    remoteStep_(memo.body, decayed, dt);
  }
  memo.from = from;
  memo.j = j;
  out.x = pd::FieldOr(memo.body, "x", pd::kNaN);
  out.y = pd::FieldOr(memo.body, "y", pd::kNaN);
  out.z = pd::FieldOr(memo.body, "z", pd::kNaN);
  out.vx = pd::FieldOr(memo.body, "vx", s.vx);
  out.vy = pd::FieldOr(memo.body, "vy", s.vy);
  out.vz = pd::FieldOr(memo.body, "vz", s.vz);
  out.yaw = pd::FieldOr(memo.body, "yaw", 0.0);
  return out;
}

void PhysicsPredictor::ApplyBodyRule(double tick, std::vector<RuleSeat>& seats) {
  if (!world_) return;
  std::stable_sort(seats.begin(), seats.end(), [](const RuleSeat& a, const RuleSeat& b) { return a.key < b.key; });
  // The built-in rules read the bodies as the last step left them (the host's view: its last export).
  const std::optional<std::vector<RuleProp>> props = BuiltInProps();
  ApplyModuleRule(tick, seats);
  if (props) ApplyBuiltInRules(tick, seats, *props);
}

std::optional<std::vector<RuleProp>> PhysicsPredictor::BuiltInProps() {
  if (!desc_.presetBody || !lifts_ || !lifts_->HasRules()) return std::nullopt;
  std::vector<std::string> keys;
  for (const auto& entry : simulated_.Items()) {
    if (entry.second.type == "dynamic") keys.push_back(entry.first);
  }
  std::sort(keys.begin(), keys.end());
  std::vector<RuleProp> out;
  for (const std::string& key : keys) {
    const std::optional<NetStateRest> st = world_->ExportBodyStateRest(key);
    if (!st) continue;
    out.push_back(RuleProp{key, pd::V(st->p[0], st->p[1], st->p[2]), pd::V(st->v[0], st->v[1], st->v[2])});
  }
  return out;
}

void PhysicsPredictor::ApplyBuiltInRules(double tick, const std::vector<RuleSeat>& seats, const std::vector<RuleProp>& props) {
  for (const RuleVelocity& n : lifts_->Rules(tick, tickHz_, seats, props, desc_.presetBody->half)) {
    // The linear velocity alone: the angular one is the body's own (its float32, read back exactly).
    const std::optional<NetStateRest> st = world_->ExportBodyStateRest(n.key);
    if (!st) continue;
    const double linvel[3] = {n.v.x, n.v.y, n.v.z};
    world_->SetVelocity(n.key, linvel, st->w);
  }
}

void PhysicsPredictor::ApplyModuleRule(double tick, std::vector<RuleSeat>& seats) {
  if (!bodyRule_ || !world_) return;
  RuleTick t;
  t.tick = tick;
  t.seats = &seats;
  t.body = [this](const std::string& key) -> std::optional<RuleBody> {
    const Simulated* sim = simulated_.Get(key);
    if (!world_ || sim == nullptr || sim->type != "dynamic") return std::nullopt;
    const std::optional<NetStateRest> st = world_->ExportBodyStateRest(key);
    if (!st) return std::nullopt;
    RuleBody b;
    b.p = pd::V(st->p[0], st->p[1], st->p[2]);
    b.v = pd::V(st->v[0], st->v[1], st->v[2]);
    return b;
  };
  const std::vector<RuleVelocity> sets = bodyRule_(t);
  for (const RuleVelocity& set : sets) {
    const Simulated* sim = simulated_.Get(set.key);
    if (!world_ || sim == nullptr || sim->type != "dynamic") continue;
    // The TypeScript sets the linear velocity alone; the C boundary takes both, so the angular one is
    // the body's own (its float32, read back exactly), which leaves it as it was.
    const std::optional<NetStateRest> st = world_->ExportBodyStateRest(set.key);
    if (!st) continue;
    const double linvel[3] = {set.v.x, set.v.y, set.v.z};
    world_->SetVelocity(set.key, linvel, st->w);
  }
}

void PhysicsPredictor::Clamp(double since) {
  const ExportRows rows = world_->ExportChangedRest(since);
  for (std::size_t i = 0; i < rows.keys.size(); ++i) {
    const Simulated* sim = simulated_.Get(rows.keys[i]);
    if (sim == nullptr || sim->type != "dynamic") continue;
    const std::size_t o = i * kWireRowStride;
    const double v[3] = {rows.data[o + 7], rows.data[o + 8], rows.data[o + 9]};
    const double w[3] = {rows.data[o + 10], rows.data[o + 11], rows.data[o + 12]};
    double linvel[3] = {v[0], v[1], v[2]};
    double angvel[3] = {w[0], w[1], w[2]};
    const bool linear = pd::ClampLength(v, desc_.maxLinear * lengthUnit_, linvel);
    const bool angular = pd::ClampLength(w, desc_.maxAngular, angvel);
    if (linear || angular) world_->SetVelocity(rows.keys[i], linvel, angvel);
  }
}

std::map<std::string, WireRow> PhysicsPredictor::RowsNow() {
  std::map<std::string, WireRow> rows;
  const auto read = [this, &rows](const std::string& key, const std::string& name) {
    const std::optional<NetStateRest> st = world_->ExportBodyStateRest(key);
    if (st) rows[name] = pd::WireRowOfState(*st, lengthUnit_, innerDt_);
  };
  for (const auto& entry : simulated_.Items()) read(entry.first, entry.first);
  for (const auto& entry : seats_.Items()) read(entry.first, "seat:" + entry.first);
  return rows;
}

void PhysicsPredictor::Prune(double tick) {
  for (auto it = ring_.begin(); it != ring_.end();) {
    if (it->first <= tick) {
      it = ring_.erase(it);
    } else {
      ++it;
    }
  }
}

// ---- drawing ----

void PhysicsPredictor::ReadDrawn(double since) {
  const ExportRows rows = world_->ExportChangedRest(since);
  for (std::size_t i = 0; i < rows.keys.size(); ++i) {
    const std::string& key = rows.keys[i];
    // A module kinematic body is drawn from the server's states (§17.10), not by the predictor, unless the room's
    // kinematic rule poses it.
    if (!simulated_.Has(key) || (kinematic_.Has(key) && !Ruled(key))) continue;
    const std::size_t o = i * kWireRowStride;
    const float* d = rows.data.data() + o;
    Drawn next;
    const auto known = drawn_.find(key);
    if (known != drawn_.end()) {
      next = known->second;
    } else {
      next.snap = SnapOf(key);
    }
    next.p = pd::V(d[0], d[1], d[2]);
    next.q = bodies::Normalize(pd::Q(d[3], d[4], d[5], d[6]));
    next.lv = pd::V(d[7] / lengthUnit_, d[8] / lengthUnit_, d[9] / lengthUnit_);
    next.av = pd::V(d[10], d[11], d[12]);
    next.sleep = d[13] == 1.0F;
    drawn_[key] = next;
  }
}

void PhysicsPredictor::ReadAll() {
  for (const auto& entry : simulated_.Items()) {
    const std::string& key = entry.first;
    if (kinematic_.Has(key) && !Ruled(key)) continue;
    const std::optional<NetStateRest> st = world_->ExportBodyStateRest(key);
    if (!st) continue;
    const double u = lengthUnit_;
    Drawn next;
    const auto known = drawn_.find(key);
    if (known != drawn_.end()) {
      next = known->second;
    } else {
      next.snap = SnapOf(key);
    }
    next.p = pd::V(st->p[0], st->p[1], st->p[2]);
    next.q = bodies::Normalize(pd::Q(st->q[0], st->q[1], st->q[2], st->q[3]));
    next.lv = pd::V(st->v[0] / u, st->v[1] / u, st->v[2] / u);
    next.av = pd::V(st->w[0], st->w[1], st->w[2]);
    next.sleep = st->sleeping;
    drawn_[key] = next;
  }
}

std::map<std::string, PhysicsPredictor::DrawnAt> PhysicsPredictor::SnapshotDrawn(double now) const {
  std::map<std::string, DrawnAt> out;
  for (const auto& entry : drawn_) {
    const Drawn& d = entry.second;
    const double age = pd::JsMax(now - d.since, 0.0);
    const auto ox = CorrectionAt(d.dp.x, d.dv.x, age, d.tau);
    const auto oy = CorrectionAt(d.dp.y, d.dv.y, age, d.tau);
    const auto oz = CorrectionAt(d.dp.z, d.dv.z, age, d.tau);
    DrawnAt at;
    at.pose.p = pd::V(d.p.x + ox.first, d.p.y + oy.first, d.p.z + oz.first);
    at.pose.q = bodies::Mul(bodies::SlerpFromIdentity(d.dq, std::exp(-age / d.tau)), d.q);
    at.rate = pd::V(ox.second, oy.second, oz.second);
    out[entry.first] = at;
  }
  return out;
}

double PhysicsPredictor::SnapOf(const std::string& key) const {
  const auto it = kinds_.find(key);
  return SnapMetresOf(it == kinds_.end() ? nullptr : &it->second) * lengthUnit_;
}

void PhysicsPredictor::Ease(const std::map<std::string, DrawnAt>& before, double now, const std::set<std::string>& respawned) {
  for (auto& entry : drawn_) {
    Drawn& d = entry.second;
    const auto old = before.find(entry.first);
    const auto snapped = [&d, now]() {
      d.dp = Vec3();
      d.dv = Vec3();
      d.dq = Quat();
      d.since = now;
      d.tau = CorrectionTauMs(0.0);
    };
    if (old == before.end() || respawned.count(entry.first) != 0) {
      snapped();
      continue;
    }
    const Pose& was = old->second.pose;
    const Vec3 dp = pd::V(was.p.x - d.p.x, was.p.y - d.p.y, was.p.z - d.p.z);
    const double size = JsHypot(dp.x, dp.y, dp.z);
    if (size > d.snap) {
      snapped();
      continue;
    }
    const Quat raw = bodies::Mul(was.q, pd::Q(-d.q.x, -d.q.y, -d.q.z, d.q.w));
    d.dp = dp;
    d.dv = old->second.rate;
    d.dq = raw.w < 0.0 ? pd::Q(-raw.x, -raw.y, -raw.z, -raw.w) : raw;
    d.since = now;
    d.tau = CorrectionTauMs(size / lengthUnit_);
  }
}

// ---- level 2: the self-test scene at core load (§17.11 *Fallback levels*) ----

bool SelfTestPredictCore(PredictCore& core) {
  constexpr int kTicks = 12;
  Json world = Json::MakeObject();
  world.Set("contract", "1.0");
  world.Set("dt", 1.0 / 60.0);
  world.Set("substeps", 1.0);
  world.Set("gravity", pd::NumberArray({0.0, 0.0, -9.81}));
  world.Set("upAxis", "z");
  world.Set("lengthUnit", 1.0);
  CoreResult refused;
  std::unique_ptr<PredictWorld> server = core.CreateWorld(world, &refused);
  std::unique_ptr<PredictWorld> client = core.CreateWorld(world, &refused);
  if (!server || !client) return false;
  StaticWorld floor;
  floor.boxes.push_back({-20.0, -20.0, -1.0, 20.0, 20.0, 0.0});
  if (!server->AddStaticWorld(floor).ok || !client->AddStaticWorld(floor).ok) return false;
  const auto collider = [](Json shape) {
    Json c = Json::MakeObject();
    c.Set("key", "c");
    c.Set("shape", std::move(shape));
    Json list = Json::MakeArray();
    list.Push(std::move(c));
    return list;
  };
  const auto pose = [](double x, double y, double z) {
    Json p = Json::MakeObject();
    p.Set("p", pd::NumberArray({x, y, z}));
    p.Set("q", pd::NumberArray({0.0, 0.0, 0.0, 1.0}));
    return p;
  };
  const auto box = [&](const char* key, double x, double y, double z, double half) {
    Json shape = Json::MakeObject();
    shape.Set("kind", "box");
    shape.Set("half", pd::NumberArray({half, half, half}));
    Json b = Json::MakeObject();
    b.Set("key", key);
    b.Set("type", "dynamic");
    b.Set("pose", pose(x, y, z));
    b.Set("linvel", pd::NumberArray({1.0, 0.0, 0.0}));
    b.Set("colliders", collider(std::move(shape)));
    return b;
  };
  Json sphere = Json::MakeObject();
  sphere.Set("kind", "sphere");
  sphere.Set("radius", 0.4);
  Json ball = Json::MakeObject();
  ball.Set("key", "c");
  ball.Set("type", "dynamic");
  ball.Set("pose", pose(2.0, 0.0, 1.0));
  ball.Set("angvel", pd::NumberArray({0.0, 3.0, 0.0}));
  ball.Set("colliders", collider(std::move(sphere)));
  const Json scene[3] = {box("a", 0.0, 0.0, 0.5, 0.5), box("b", 0.0, 0.0, 1.6, 0.5), ball};
  for (const Json& body : scene) {
    if (!server->Spawn(body).ok || !client->Spawn(body).ok) return false;
  }
  // Both step as many ticks (the tick counter is in the stateHash, C§10.1); the client is still at its
  // spawn state, so only the import can bring it to the server's.
  for (int i = 0; i < kTicks; ++i) server->Step();
  client->Canonicalize(false);
  for (int i = 0; i < kTicks; ++i) client->Step();
  if (!server->Canonicalize(true).ok) return false;
  const ExportRows rows = server->ExportChangedRest(server->Tick());
  const double innerDt = InnerDtOf(1.0 / 60.0, 1.0);
  std::vector<float> wire;
  for (std::size_t i = 0; i < rows.keys.size(); ++i) {
    const float* d = rows.data.data() + i * kWireRowStride;
    NetStateRest st;
    for (int k = 0; k < 3; ++k) st.p[k] = d[k];
    for (int k = 0; k < 4; ++k) st.q[k] = d[3 + k];
    for (int k = 0; k < 3; ++k) st.v[k] = d[7 + k];
    for (int k = 0; k < 3; ++k) st.w[k] = d[10 + k];
    st.sleeping = d[13] == 1.0F;
    st.rest = d[14];
    const WireRow row = pd::WireRowOfState(st, 1.0, innerDt);
    pd::AppendRowF32(wire, row.data(), kWireRowStride);
  }
  if (rows.keys.size() != 3 || !client->ImportWire(rows.keys, wire).ok || !client->Canonicalize(true).ok) return false;
  for (int i = 0; i < kTicks; ++i) {
    server->Step();
    client->Step();
    if (server->StateHash() != client->StateHash()) return false;
  }
  return true;
}

}  // namespace genex::physics

GENEX_FP_STRICT_END
