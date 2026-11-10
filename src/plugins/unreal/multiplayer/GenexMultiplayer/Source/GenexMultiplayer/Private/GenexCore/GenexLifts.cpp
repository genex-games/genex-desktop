// Lifts and the lift slots (GenexCore/GenexLifts.h): a port of lifts.ts, every operation in its order, unfused
// (GENEX_FP_STRICT_BEGIN), with JavaScript's `%` as std::fmod and §17.7's portable sine and cosine, so a pose, a carry,
// a posed solid and a whole tick's slots are the TypeScript's bit for bit.
#include "GenexCore/GenexLifts.h"

#include "GenexCore/GenexPhysicsPredictor.h"
#include "GenexCore/GenexPresets.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <functional>
#include <utility>

GENEX_FP_STRICT_BEGIN

namespace genex::lifts {
namespace {

constexpr double kTwoPi = 2 * 3.14159265358979323846;

double F32(double v) { return presets::Fround(v); }

/** `x mod n` in [0, n) (JavaScript's `((x % n) + n) % n`). */
double Wrap(double x, double n) { return std::fmod(std::fmod(x, n) + n, n); }

/** One leg's point at its tick `i` of `n`. */
Vec3 Along(const Vec3& a, const Vec3& b, double i, double n, Ease ease) {
  if (ease == Ease::Linear) {
    return Vec3{F32(a[0] + ((b[0] - a[0]) * i) / n), F32(a[1] + ((b[1] - a[1]) * i) / n), F32(a[2] + ((b[2] - a[2]) * i) / n)};
  }
  const double s = i / n;
  const double e = s * s * (3 - 2 * s);
  return Vec3{F32(a[0] + (b[0] - a[0]) * e), F32(a[1] + (b[1] - a[1]) * e), F32(a[2] + (b[2] - a[2]) * e)};
}

/** One of the path's legs in running order: from, to, its ticks, then the wait at `to`. */
struct Leg {
  const Vec3* from;
  const Vec3* to;
  double ticks;
  double wait;
};

std::vector<Leg> LegsOf(const Path& p) {
  std::vector<Leg> legs;
  const std::size_t n = p.legs.size();
  if (p.mode == PathMode::Loop) {
    for (std::size_t k = 0; k < n; ++k) legs.push_back(Leg{&p.points[k], &p.points[(k + 1) % n], p.legs[k], p.waits[(k + 1) % n]});
    return legs;
  }
  for (std::size_t k = 0; k < n; ++k) legs.push_back(Leg{&p.points[k], &p.points[k + 1], p.legs[k], p.waits[k + 1]});
  for (std::size_t k = n; k-- > 0;) legs.push_back(Leg{&p.points[k + 1], &p.points[k], p.legs[k], p.waits[k]});
  return legs;
}

/** The path's centre at phase `m` in [0, period). */
Vec3 PathAt(const Path& p, double m) {
  double t = m;
  for (const Leg& leg : LegsOf(p)) {
    if (t < leg.ticks) return Along(*leg.from, *leg.to, t, leg.ticks, p.ease);
    t -= leg.ticks;
    if (t < leg.wait) return *leg.to;
    t -= leg.wait;
  }
  return p.points[0];
}

/** The phase of a lift's path at `tick`: a called lift's ticks since its call `start` for one cycle (0 before it, after
 *  it and while uncalled), else the tick plus its phase, in the period. */
double PhaseOf(const Lift& lift, const Path& p, double tick, std::optional<double> start) {
  if (!lift.called) return Wrap(tick + p.phase, p.period);
  if (!start || tick < *start || tick - *start >= p.period) return 0;
  return tick - *start;
}

std::optional<double> StartOf(const Starts* starts, const Lift& lift) {
  if (starts == nullptr) return std::nullopt;
  const auto it = starts->find(lift.id);
  if (it == starts->end()) return std::nullopt;
  return it->second;
}

/** Writes a carry's or push-out's place into `seat` as float32. */
void Place(LiftSeat& seat, double x, double y, double z) {
  seat.x = F32(x);
  seat.y = F32(y);
  seat.z = F32(z);
}

HullBody BodyOf(const LiftSeat& s) {
  HullBody b;
  b.x = s.x;
  b.y = s.y;
  b.z = s.z;
  b.vz = s.vz;
  b.duck = s.duck;
  return b;
}

std::vector<contact::PolicyBody*> PointersTo(std::vector<LiftSeat>& seats) {
  std::vector<contact::PolicyBody*> out;
  out.reserve(seats.size());
  for (LiftSeat& s : seats) out.push_back(&s);
  return out;
}

/** The solids a seat's support is asked of: the lifts at the tick's start, then its own head slabs. */
std::vector<PosedSolid> WithSlabs(const std::vector<PosedSolid>& now, const HeadSlabs& own) {
  std::vector<PosedSolid> all = now;
  all.insert(all.end(), own.solids.begin(), own.solids.end());
  return all;
}

/** Each seat's support at the tick's start among the lifts (`now`) and, with heads, its head slabs: the lift's index
 *  (else −1) and the seat it rides (a `stand` pair with `ride`; else none). */
void SupportsOf(const LiftsPolicy& policy, std::vector<LiftSeat>& seats, const std::vector<PosedSolid>& now, const HullOps& ops,
                const HeadsContext* heads, std::vector<int>* bases, std::vector<std::optional<std::string>>* on) {
  const int lifts = static_cast<int>(policy.platforms.size());
  const std::vector<contact::PolicyBody*> ptrs = PointersTo(seats);
  for (std::size_t i = 0; i < seats.size(); ++i) {
    std::optional<HeadSlabs> own;
    if (heads != nullptr) own = HeadSlabsFor(ptrs, i, *heads->policy, *heads->env, 0);
    const int k = !own || own->solids.empty() ? ops.Support(BodyOf(seats[i]), now) : ops.Support(BodyOf(seats[i]), WithSlabs(now, *own));
    const LiftSeat* lower = nullptr;
    if (k >= lifts && own) {
      const std::string& id = own->lowers[static_cast<std::size_t>(k - lifts)];
      for (const LiftSeat& s : seats) {
        if (s.id == id) {
          lower = &s;
          break;
        }
      }
    }
    const contact::TopRule* rule = heads != nullptr && lower != nullptr ? &contact::TopRuleOf(*heads->policy, seats[i], *lower) : nullptr;
    bases->push_back(k < lifts ? k : -1);
    on->push_back(lower != nullptr && rule != nullptr && rule->policy == contact::TopPolicy::Stand && rule->ride ? std::optional<std::string>(lower->id)
                                                                                                                : std::nullopt);
  }
}

/** Each seat's carry over the tick from the seats as they were (`before`): a lift's (`CarryOnLift`), or a ridden
 *  seat's carry, base first, kRideChainMax deep (the ridden seat's walk follows in `RideSlot`, after the steps). */
std::vector<std::optional<Carried>> CarriesOf(const LiftsPolicy& policy, const std::vector<LiftSeat>& before, const std::vector<int>& bases,
                                              const std::vector<std::optional<std::string>>& on, double tick, double tickHz,
                                              const Starts* starts) {
  std::vector<std::optional<Carried>> lifted;
  for (std::size_t i = 0; i < before.size(); ++i) {
    if (bases[i] < 0) {
      lifted.push_back(std::nullopt);
      continue;
    }
    const Lift& lift = policy.platforms[static_cast<std::size_t>(bases[i])];
    lifted.push_back(CarryOnLift(lift, RiderPose{before[i].x, before[i].y, before[i].z, before[i].yaw}, tick, tickHz, StartOf(starts, lift)));
  }
  const std::function<Vec3(std::size_t, int)> moveOf = [&](std::size_t i, int depth) -> Vec3 {
    if (lifted[i]) return Vec3{lifted[i]->x - before[i].x, lifted[i]->y - before[i].y, lifted[i]->z - before[i].z};
    std::optional<std::size_t> j;
    if (on[i]) {
      for (std::size_t k = 0; k < before.size(); ++k) {
        if (before[k].id == *on[i]) j = k;  // a Map keeps the last of a repeated id
      }
    }
    if (!j || depth >= kRideChainMax) return Vec3{0, 0, 0};
    return moveOf(*j, depth + 1);
  };
  std::vector<std::optional<Carried>> out;
  for (std::size_t i = 0; i < before.size(); ++i) {
    if (lifted[i]) {
      out.push_back(lifted[i]);
      continue;
    }
    if (!on[i]) {
      out.push_back(std::nullopt);
      continue;
    }
    const Vec3 m = moveOf(i, 0);
    Carried c;
    c.x = before[i].x + m[0];
    c.y = before[i].y + m[1];
    c.z = before[i].z + m[2];
    c.yaw = before[i].yaw;
    c.v = Vec3{m[0] * tickHz, m[1] * tickHz, m[2] * tickHz};
    out.push_back(c);
  }
  return out;
}

/** Whether seat i still rides seat `id` after the tick: it stands on that seat's head slab. */
bool StillRides(std::vector<LiftSeat>& seats, std::size_t i, const std::string& id, const std::vector<PosedSolid>& next, const HullOps& ops,
                const HeadsContext& heads) {
  const std::vector<contact::PolicyBody*> ptrs = PointersTo(seats);
  const HeadSlabs own = HeadSlabsFor(ptrs, i, *heads.policy, *heads.env, 0);
  if (own.solids.empty()) return false;
  const int k = ops.Support(BodyOf(seats[i]), WithSlabs(next, own));
  const int n = static_cast<int>(next.size());
  return k >= n && own.lowers[static_cast<std::size_t>(k - n)] == id;
}

}  // namespace

LiftPose LiftPoseAt(const Lift& lift, double tick, std::optional<double> start) {
  LiftPose pose;
  pose.c = lift.path ? PathAt(*lift.path, PhaseOf(lift, *lift.path, tick, start)) : lift.at;
  if (!lift.spin) return pose;
  const Spin& spin = *lift.spin;
  pose.yaw = F32(spin.dir * ((kTwoPi * Wrap(tick + spin.phase, spin.period)) / spin.period));
  return pose;
}

std::vector<LiftPose> LiftPoses(const LiftsPolicy& policy, double tick, const Starts* starts) {
  std::vector<LiftPose> out;
  for (const Lift& l : policy.platforms) out.push_back(LiftPoseAt(l, tick, StartOf(starts, l)));
  return out;
}

double SpinStep(const Lift& lift) { return lift.spin ? (lift.spin->dir * kTwoPi) / lift.spin->period : 0.0; }

Carried CarryOnLift(const Lift& lift, const RiderPose& rider, double tick, double tickHz, std::optional<double> start) {
  const LiftPose p0 = LiftPoseAt(lift, tick, start);
  const LiftPose p1 = LiftPoseAt(lift, tick + 1, start);
  const double delta = SpinStep(lift);
  double x;
  double y;
  if (delta == 0) {
    x = rider.x + (p1.c[0] - p0.c[0]);
    y = rider.y + (p1.c[1] - p0.c[1]);
  } else {
    const presets::SinCos sc = presets::PSinCos(delta);
    const double dx = rider.x - p0.c[0];
    const double dy = rider.y - p0.c[1];
    x = p1.c[0] + (sc.cos * dx - sc.sin * dy);
    y = p1.c[1] + (sc.sin * dx + sc.cos * dy);
  }
  const double z = rider.z + (p1.c[2] - p0.c[2]);
  if (lift.surface) {
    const double sx = (*lift.surface)[0];
    const double sy = (*lift.surface)[1];
    if (p1.yaw == 0) {
      x += sx / tickHz;
      y += sy / tickHz;
    } else {
      const presets::SinCos sc = presets::PSinCos(p1.yaw);
      x += (sc.cos * sx - sc.sin * sy) / tickHz;
      y += (sc.sin * sx + sc.cos * sy) / tickHz;
    }
  }
  Carried out;
  out.x = x;
  out.y = y;
  out.z = z;
  out.yaw = rider.yaw + delta;
  out.v = Vec3{(x - rider.x) * tickHz, (y - rider.y) * tickHz, (z - rider.z) * tickHz};
  return out;
}

std::vector<PosedSolid> PosedSolidsOf(const LiftsPolicy& policy, const std::vector<LiftPose>& poses) {
  std::vector<PosedSolid> out;
  for (std::size_t i = 0; i < policy.platforms.size(); ++i) {
    const Lift& lift = policy.platforms[i];
    const Vec3& c = poses[i].c;
    const double yaw = poses[i].yaw;
    const Shape& shape = lift.shape;
    if (shape.kind == ShapeKind::Disc) {
      out.push_back(PosedSolid::MakeDisc(c, shape.radius, shape.discHalf));
      continue;
    }
    const Vec3& h = shape.half;
    if (!lift.spin) {
      out.push_back(PosedSolid::MakeBox(Vec3{c[0] - h[0], c[1] - h[1], c[2] - h[2]}, Vec3{c[0] + h[0], c[1] + h[1], c[2] + h[2]}));
      continue;
    }
    const presets::SinCos sc = presets::PSinCos(yaw);
    out.push_back(PosedSolid::MakeOBox(c, h, sc.sin, sc.cos));
  }
  return out;
}

TickSolids TickSolidsOf(const LiftsPolicy& policy, double tick, const Starts* starts) {
  TickSolids t;
  t.now = PosedSolidsOf(policy, LiftPoses(policy, tick, starts));
  t.next = PosedSolidsOf(policy, LiftPoses(policy, tick + 1, starts));
  return t;
}

CarryReport CarrySlot(const LiftsPolicy& policy, std::vector<LiftSeat>& seats, double tick, double tickHz, const Starts* starts,
                      const HullOps& ops, bool turnYaw, const TickSolids& solids, const HeadsContext* heads) {
  std::vector<LiftSeat> before = seats;
  CarryReport report;
  SupportsOf(policy, before, solids.now, ops, heads, &report.bases, &report.on);
  const std::vector<std::optional<Carried>> carries = CarriesOf(policy, before, report.bases, report.on, tick, tickHz, starts);
  for (std::size_t i = 0; i < seats.size(); ++i) {
    LiftSeat& seat = seats[i];
    const int base = report.bases[i];
    const std::optional<Carried>& c = carries[i];
    if (c) {
      Place(seat, c->x, c->y, c->z);
      if (turnYaw && base >= 0) seat.yaw = F32(c->yaw);
    }
    report.v.push_back(c ? std::optional<Vec3>(c->v) : std::nullopt);
    for (std::size_t k = 0; k < policy.platforms.size(); ++k) {
      if (static_cast<int>(k) == base || !ops.Inside(BodyOf(seat), solids.next, static_cast<int>(k))) continue;
      const Lift& lift = policy.platforms[k];
      const Carried moved = CarryOnLift(lift, RiderPose{seat.x, seat.y, seat.z, seat.yaw}, tick, tickHz, StartOf(starts, lift));
      HullBody at = BodyOf(seat);
      at.x = moved.x;
      at.y = moved.y;
      at.z = moved.z;
      const HullOps::Pushed out = ops.PushOut(at, solids.next);
      Place(seat, out.x, out.y, out.z);
      if (out.inside) report.crushed.push_back(Crush{seat.id, lift.id});
    }
  }
  for (const LiftSeat& seat : seats) report.from.push_back(Vec3{seat.x, seat.y, seat.z});
  return report;
}

CarryReport RideSlot(std::vector<LiftSeat>& seats, const CarryReport& report, double tickHz) {
  bool any = false;
  for (const std::optional<std::string>& id : report.on) any = any || id.has_value();
  if (!any) return report;
  std::vector<std::array<double, 2>> walked;
  for (std::size_t i = 0; i < seats.size(); ++i) walked.push_back({seats[i].x - report.from[i][0], seats[i].y - report.from[i][1]});
  // The walks of the seats under seat i, base first, kRideChainMax deep.
  const std::function<std::array<double, 2>(std::size_t, int)> rideOf = [&](std::size_t i, int depth) -> std::array<double, 2> {
    std::optional<std::size_t> j;
    if (report.on[i]) {
      for (std::size_t k = 0; k < seats.size(); ++k) {
        if (seats[k].id == *report.on[i]) j = k;  // a Map keeps the last of a repeated id
      }
    }
    if (!j || depth >= kRideChainMax) return {0, 0};
    const std::array<double, 2> m = rideOf(*j, depth + 1);
    return {walked[*j][0] + m[0], walked[*j][1] + m[1]};
  };
  std::vector<std::array<double, 2>> moves;
  for (std::size_t i = 0; i < seats.size(); ++i) moves.push_back(rideOf(i, 0));
  CarryReport out = report;
  for (std::size_t i = 0; i < seats.size(); ++i) {
    if (!report.on[i]) continue;
    const std::array<double, 2>& m = moves[i];
    if (out.v[i]) out.v[i] = Vec3{(*out.v[i])[0] + m[0] * tickHz, (*out.v[i])[1] + m[1] * tickHz, (*out.v[i])[2]};
    seats[i].x = F32(seats[i].x + m[0]);
    seats[i].y = F32(seats[i].y + m[1]);
  }
  return out;
}

void ImpartSlot(const LiftsPolicy& policy, std::vector<LiftSeat>& seats, const CarryReport& report, double /*tick*/, const Starts* /*starts*/,
                const HullOps& ops, const std::vector<PosedSolid>& next, const HeadsContext* heads) {
  std::vector<LiftSeat> after = seats;
  for (std::size_t i = 0; i < seats.size(); ++i) {
    LiftSeat& seat = seats[i];
    const int base = i < report.bases.size() ? report.bases[i] : -1;
    if (i >= report.v.size() || !report.v[i]) continue;
    const Vec3& v = *report.v[i];
    const std::optional<std::string>& rode = report.on[i];
    if (rode && heads != nullptr) {
      if (StillRides(after, i, *rode, next, ops, *heads)) continue;
    } else if (base < 0 || policy.platforms[static_cast<std::size_t>(base)].impart != Impart::All ||
               ops.Support(BodyOf(seat), next) == base) {
      continue;
    }
    seat.vx = F32(seat.vx + v[0]);
    seat.vy = F32(seat.vy + v[1]);
    seat.vz = F32(seat.vz + v[2]);
  }
}

// ---- head slabs (heads.ts) ----

bool HasStand(const contact::ContactPolicy& policy) {
  if (policy.top.policy == contact::TopPolicy::Stand) return true;
  for (const contact::PairRule& r : policy.pairs) {
    if (r.top.policy == contact::TopPolicy::Stand) return true;
  }
  return false;
}

PosedSolid HeadSlab(const contact::PolicyBody& lower, const contact::ContactPolicy& policy, double dt) {
  const double x = lower.x + lower.vx * dt;
  const double y = lower.y + lower.vy * dt;
  const double z = lower.z + lower.vz * dt;
  const contact::ContactShape& shape = policy.shape;
  const double trace = policy.groundTrace;
  if (shape.kind == contact::ContactShapeKind::Hull) {
    const double r = shape.radius;
    return PosedSolid::MakeBox(Vec3{x - r, y - r, z + shape.height - trace}, Vec3{x + r, y + r, z + shape.height});
  }
  const presets::SinCos sc = presets::PSinCos(lower.yaw);
  return PosedSolid::MakeOBox(Vec3{x, y, z + shape.top - trace / 2}, Vec3{shape.length / 2, shape.width / 2, trace / 2}, sc.sin, sc.cos);
}

namespace {

/** The top of a seat with this policy's shape, over its base. */
double TopOf(const contact::ContactPolicy& policy) {
  return policy.shape.kind == contact::ContactShapeKind::Hull ? policy.shape.height : policy.shape.top;
}

/** The farthest off a head (a share of its half extent) a seat may get its slab: the two footprints still overlap. */
constexpr double kSlabReach = 2;

/** Whether seat `upper` gets seat `lower`'s slab: a `stand` pair, the upper over the lower's top (its base from
 *  `groundTrace` under it to one top over it, its centre within kSlabReach of the lower's), the lower standable, and
 *  the upper passing the stand test. */
bool SlabFor(const contact::PolicyBody& upper, const contact::PolicyBody& lower, const contact::ContactPolicy& policy,
             const contact::ContactEnv& env) {
  const contact::TopRule& rule = contact::TopRuleOf(policy, upper, lower);
  if (rule.policy != contact::TopPolicy::Stand) return false;
  const double top = TopOf(policy);
  if (upper.z < lower.z + top - policy.groundTrace || upper.z > lower.z + 2 * top) return false;
  if (!(contact::HeadOffset(upper, lower, policy) < kSlabReach)) return false;
  if (contact::SupportUpOf(lower, policy, env)[2] < policy.supportCos) return false;
  return contact::HeadStands(upper, lower, rule, policy);
}

}  // namespace

HeadSlabs HeadSlabsFor(const std::vector<contact::PolicyBody*>& seats, std::size_t i, const contact::ContactPolicy& policy,
                       const contact::ContactEnv& env, double dt) {
  HeadSlabs out;
  const contact::PolicyBody& upper = *seats[i];
  for (std::size_t k = 0; k < seats.size(); ++k) {
    const contact::PolicyBody& lower = *seats[k];
    if (k == i || !SlabFor(upper, lower, policy, env)) continue;
    out.solids.push_back(HeadSlab(lower, policy, dt));
    out.lowers.push_back(lower.id);
  }
  return out;
}

std::vector<HeadSlabs> HeadSlabsOf(const std::vector<contact::PolicyBody*>& seats, const contact::ContactPolicy& policy,
                                   const contact::ContactEnv& env, double dt) {
  std::vector<HeadSlabs> out;
  for (std::size_t i = 0; i < seats.size(); ++i) out.push_back(HeadSlabsFor(seats, i, policy, env, dt));
  return out;
}

// ---- lifts as physics bodies ----

std::string LiftBodyKey(const std::string& id) { return "lift." + id; }

LiftBodyPose LiftBodyPoseAt(const Lift& lift, double tick, const Starts* starts) {
  const LiftPose pose = LiftPoseAt(lift, tick, StartOf(starts, lift));
  const presets::SinCos sc = presets::PSinCos(pose.yaw / 2);
  LiftBodyPose out;
  out.p = pose.c;
  out.q = {0, 0, F32(sc.sin), F32(sc.cos)};
  return out;
}

namespace {
/** A disc's body is a prism of this many sides around its radius. */
constexpr int kDiscSides = 16;

Json Numbers(std::initializer_list<double> values) {
  Json a = Json::MakeArray();
  for (double v : values) a.Push(Json(v));
  return a;
}

/** Whether `(x, y)` is inside lift `lift`'s footprint at `pose` (in its own frame). */
bool OverFootprint(const Lift& lift, const LiftPose& pose, double x, double y) {
  const double dx = x - pose.c[0];
  const double dy = y - pose.c[1];
  double s = 0, c = 1;
  if (pose.yaw != 0) {
    const presets::SinCos sc = presets::PSinCos(pose.yaw);
    s = sc.sin;
    c = sc.cos;
  }
  const double lx = c * dx + s * dy;
  const double ly = c * dy - s * dx;
  if (lift.shape.kind == ShapeKind::Disc) return lx * lx + ly * ly <= lift.shape.radius * lift.shape.radius;
  return std::abs(lx) <= lift.shape.half[0] && std::abs(ly) <= lift.shape.half[1];
}

double TopOver(const Lift& lift) { return lift.shape.kind == ShapeKind::Disc ? lift.shape.discHalf : lift.shape.half[2]; }
}  // namespace

Json LiftBodySpawn(const Lift& lift, double tick, const Starts* starts) {
  Json shape = Json::MakeObject();
  if (lift.shape.kind == ShapeKind::Box) {
    shape.Set("kind", "box");
    shape.Set("half", Numbers({lift.shape.half[0], lift.shape.half[1], lift.shape.half[2]}));
  } else {
    Json points = Json::MakeArray();
    for (int i = 0; i < kDiscSides; ++i) {
      const presets::SinCos sc = presets::PSinCos((kTwoPi * i) / kDiscSides);
      const double x = F32(lift.shape.radius * sc.cos);
      const double y = F32(lift.shape.radius * sc.sin);
      points.Push(Numbers({x, y, -lift.shape.discHalf}));
      points.Push(Numbers({x, y, lift.shape.discHalf}));
    }
    shape.Set("kind", "hull");
    shape.Set("points", std::move(points));
  }
  Json collider = Json::MakeObject();
  collider.Set("key", "lift");
  collider.Set("shape", std::move(shape));
  if (lift.surface) collider.Set("friction", Json(0));
  Json colliders = Json::MakeArray();
  colliders.Push(std::move(collider));
  const LiftBodyPose pose = LiftBodyPoseAt(lift, tick, starts);
  Json p = Json::MakeObject();
  p.Set("p", Numbers({pose.p[0], pose.p[1], pose.p[2]}));
  p.Set("q", Numbers({pose.q[0], pose.q[1], pose.q[2], pose.q[3]}));
  Json body = Json::MakeObject();
  body.Set("key", LiftBodyKey(lift.id));
  body.Set("type", "kinematic");
  body.Set("pose", std::move(p));
  body.Set("colliders", std::move(colliders));
  return body;
}

std::vector<PropNudge> ConveyorNudges(const LiftsPolicy& policy, double tick, const Starts* starts, double tickHz,
                                      const std::vector<RuleProp>& bodies, double reach) {
  std::vector<std::pair<const Lift*, LiftPose>> belts;
  for (const Lift& l : policy.platforms) {
    if (l.surface) belts.emplace_back(&l, LiftPoseAt(l, tick, StartOf(starts, l)));
  }
  const double k = std::min(1.0, kConveyorRate / tickHz);
  std::vector<PropNudge> out;
  for (const RuleProp& body : bodies) {
    const Lift* lift = nullptr;
    for (const auto& belt : belts) {
      const double rise = body.p[2] - (belt.second.c[2] + TopOver(*belt.first));
      if (rise > 0 && rise <= reach && OverFootprint(*belt.first, belt.second, body.p[0], body.p[1])) {
        lift = belt.first;
        break;
      }
    }
    if (lift == nullptr) continue;
    const Carried carried = CarryOnLift(*lift, RiderPose{body.p[0], body.p[1], body.p[2], 0}, tick, tickHz, StartOf(starts, *lift));
    const double dx = carried.v[0] - body.v[0];
    const double dy = carried.v[1] - body.v[1];
    if (dx == 0 && dy == 0) continue;
    out.push_back(PropNudge{body.key, Vec3{body.v[0] + dx * k, body.v[1] + dy * k, body.v[2]}});
  }
  return out;
}

std::vector<PropNudge> PropSlideNudges(const std::vector<PropSeat>& seats, const Vec3& half, const std::vector<RuleProp>& bodies,
                                       const contact::PropSlide& slide) {
  std::vector<PropNudge> out;
  for (const RuleProp& body : bodies) {
    const PropSeat* seat = nullptr;
    for (const PropSeat& s : seats) {
      const bool over = std::abs(body.p[0] - s.x) <= half[0] && std::abs(body.p[1] - s.y) <= half[1] && body.p[2] > s.z + 2 * half[2] &&
                        body.p[2] <= s.z + 4 * half[2];
      if (over) {
        seat = &s;
        break;
      }
    }
    if (seat == nullptr) continue;
    const double dx = body.p[0] - seat->x;
    const double dy = body.p[1] - seat->y;
    const double d = physics::JsHypot(dx, dy, 0);
    const double ux = d > 0 ? dx / d : 1;
    const double uy = d > 0 ? dy / d : 0;
    const double parting = (body.v[0] - seat->vx) * ux + (body.v[1] - seat->vy) * uy;
    if (!(parting < slide.speed)) continue;
    const double add = std::min(slide.step, slide.speed - parting);
    out.push_back(PropNudge{body.key, Vec3{body.v[0] + ux * add, body.v[1] + uy * add, body.v[2]}});
  }
  return out;
}

namespace {
class LiftBodies final : public physics::PredictLifts {
 public:
  LiftBodies(LiftsPolicy policy, Starts starts, std::optional<contact::PropSlide> slide)
      : policy_(std::move(policy)), starts_(std::move(starts)), slide_(slide) {
    for (const Lift& l : policy_.platforms) belts_ = belts_ || l.surface.has_value();
  }
  std::size_t Count() const override { return policy_.platforms.size(); }
  std::string Key(std::size_t i) const override { return LiftBodyKey(policy_.platforms[i].id); }
  Json Spawn(std::size_t i, double tick) const override { return LiftBodySpawn(policy_.platforms[i], tick, &starts_); }
  void Pose(std::size_t i, double tick, double p[3], double q[4]) const override {
    const LiftBodyPose pose = LiftBodyPoseAt(policy_.platforms[i], tick, &starts_);
    for (std::size_t k = 0; k < 3; ++k) p[k] = pose.p[k];
    for (std::size_t k = 0; k < 4; ++k) q[k] = pose.q[k];
  }
  bool HasRules() const override { return belts_ || slide_.has_value(); }
  std::vector<physics::RuleVelocity> Rules(double tick, double tickHz, const std::vector<physics::RuleSeat>& seats,
                                           const std::vector<physics::RuleProp>& props, const double half[3]) const override {
    std::vector<RuleProp> bodies;
    for (const physics::RuleProp& b : props) bodies.push_back(RuleProp{b.key, Vec3{b.p.x, b.p.y, b.p.z}, Vec3{b.v.x, b.v.y, b.v.z}});
    std::vector<PropNudge> nudges;
    if (belts_) nudges = ConveyorNudges(policy_, tick, &starts_, tickHz, bodies, 2 * half[2]);
    if (slide_) {
      std::vector<PropSeat> on;
      for (const physics::RuleSeat& s : seats) on.push_back(PropSeat{s.key, s.x, s.y, s.z, s.vx, s.vy});
      for (const PropNudge& n : PropSlideNudges(on, Vec3{half[0], half[1], half[2]}, bodies, *slide_)) nudges.push_back(n);
    }
    std::vector<physics::RuleVelocity> out;
    for (const PropNudge& n : nudges) {
      physics::RuleVelocity v;
      v.key = n.key;
      v.v.x = n.v[0];
      v.v.y = n.v[1];
      v.v.z = n.v[2];
      out.push_back(v);
    }
    return out;
  }

 private:
  LiftsPolicy policy_;
  Starts starts_;
  std::optional<contact::PropSlide> slide_;
  bool belts_ = false;
};
}  // namespace

namespace {
bool SafeInteger(double v) { return std::isfinite(v) && std::floor(v) == v && std::abs(v) <= 9007199254740991.0; }
}  // namespace

double InputTickField(double tick) {
  if (!SafeInteger(tick)) return 0;
  const double m = std::fmod(std::fmod(tick, kInputTickMod) + kInputTickMod, kInputTickMod);
  return m == 0 ? 0 : m;
}

double InputTickLag(std::optional<double> field, double applied, double tickHz) {
  if (!field || !std::isfinite(*field) || std::floor(*field) != *field || *field < 0 || *field >= kInputTickMod) return 0;
  if (!SafeInteger(applied)) return 0;
  const double hz = std::isfinite(tickHz) && tickHz > 0 ? tickHz : 0;
  const double slack = std::max(1.0, std::floor(kInputTickSlackS * hz + 0.5));
  const double half = kInputTickMod / 2;
  const double back = std::fmod(std::fmod(applied - *field, kInputTickMod) + kInputTickMod + half, kInputTickMod) - half;
  return std::abs(back) > slack || back == 0 ? 0 : back;
}

double ViewOnLift(const Lift& lift, double yaw, double lag) {
  if (lag == 0 || !lift.spin) return yaw;
  return F32(yaw + SpinStep(lift) * lag);
}

std::shared_ptr<const physics::PredictLifts> MakePredictLifts(const LiftsPolicy& policy, const Starts& starts, std::optional<contact::PropSlide> headSlide) {
  return std::make_shared<LiftBodies>(policy, starts, headSlide);
}

}  // namespace genex::lifts

GENEX_FP_STRICT_END
