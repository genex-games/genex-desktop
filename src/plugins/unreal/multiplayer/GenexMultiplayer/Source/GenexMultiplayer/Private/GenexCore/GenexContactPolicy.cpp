// The universal contact policy (GenexCore/GenexContactPolicy.h): a port of contact-policy.ts, every operation in
// its order, unfused (GENEX_FP_STRICT_BEGIN), with JavaScript's Math.min / Math.max / Math.hypot where it uses them,
// so a pair step, a pass and a ride are the TypeScript's bit for bit.
#include "GenexCore/GenexContactPolicy.h"

#include "GenexCore/GenexPresets.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <utility>

GENEX_FP_STRICT_BEGIN

namespace genex::contact {
namespace {

constexpr V3 kUp{0, 0, 1};

double Dot(const V3& p, const V3& q) { return p[0] * q[0] + p[1] * q[1] + p[2] * q[2]; }
V3 Cross(const V3& p, const V3& q) { return V3{p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]}; }
V3 Neg(const V3& p) { return V3{-p[0], -p[1], -p[2]}; }

/** JavaScript's Math.max of two: NaN if either is, +0 over −0. */
double JsMax(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return std::numeric_limits<double>::quiet_NaN();
  if (a == 0 && b == 0) return std::signbit(a) ? b : a;
  return a > b ? a : b;
}

/** JavaScript's Math.min of two: NaN if either is, −0 under +0. */
double JsMin(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return std::numeric_limits<double>::quiet_NaN();
  if (a == 0 && b == 0) return std::signbit(a) ? a : b;
  return a < b ? a : b;
}

/** JavaScript's Math.hypot of three, V8's way: every |value| divided by the largest, their squares summed with
 *  Kahan compensation, then the square root times the largest (std::hypot differs in the last bit). */
double JsHypot3(double a, double b, double c) {
  const double v[3] = {std::fabs(a), std::fabs(b), std::fabs(c)};
  double max = 0;
  bool nan = false;
  for (const double x : v) {
    if (std::isnan(x)) nan = true;
    else if (x > max) max = x;
  }
  if (max == std::numeric_limits<double>::infinity()) return max;
  if (nan) return std::numeric_limits<double>::quiet_NaN();
  if (max == 0) return 0;
  double sum = 0;
  double compensation = 0;
  for (const double x : v) {
    const double n = x / max;
    const double summand = n * n - compensation;
    const double preliminary = sum + summand;
    compensation = (preliminary - sum) - summand;
    sum = preliminary;
  }
  return std::sqrt(sum) * max;
}

/** A seat's body for one pair test: its geometric up, support up, half extents, top and heading. `b` is the live
 *  seat (a pair step moves it); a classification only reads it. */
struct Frame {
  PolicyBody* b = nullptr;
  V3 up{0, 0, 1};
  V3 support{0, 0, 1};
  double hl = 0;
  double hw = 0;
  double top = 0;
  double s = 0;
  double c = 1;
};

/** The support up of a seat's base (the module's, else the surface under it). */
V3 SupportOf(const PolicyBody& b, const ContactPolicy& policy, const ContactEnv& env) {
  if (env.supportUp) return env.supportUp(b.x, b.y, b.z);
  return SurfaceUp(env.world, b.x, b.y, b.z, policy.groundTrace);
}

/** A seat's frame: a box turned with its heading and laid on its support up; a hull upright. */
Frame FrameOf(PolicyBody* b, const ContactPolicy& policy, const ContactEnv& env) {
  const ContactShape& shape = policy.shape;
  Frame f;
  f.b = b;
  f.support = SupportOf(*b, policy, env);
  if (shape.kind == ContactShapeKind::Hull) {
    f.up = kUp;
    f.hl = shape.radius;
    f.hw = shape.radius;
    f.top = shape.height;
    f.s = 0;
    f.c = 1;
    return f;
  }
  const presets::SinCos sc = presets::PSinCos(b->yaw);
  f.up = f.support;
  f.hl = shape.length / 2;
  f.hw = shape.width / 2;
  f.top = shape.top;
  f.s = sc.sin;
  f.c = sc.cos;
  return f;
}

/** The farthest a frame's footprint reaches from its centre in the plane. */
double DiagOf(const Frame& f) { return std::sqrt(f.hl * f.hl + f.hw * f.hw); }

struct Axis {
  double depth = 0;
  V3 n{0, 0, 1};
};

/** The in-plane geometry of a pair: the least-overlap axis (from a to b), the across axis, and what gives a half
 *  extent along any direction. */
struct Geometry {
  enum class HalfKind { Level, Tilted, Sat };
  V3 plane{0, 0, 1};
  bool level = false;
  Axis side;
  /** The index of `side` in `axes`; -1 when a side contact took the across axis. */
  int sideIndex = -1;
  /** Every axis (each oriented from a to b), with its depth. */
  std::vector<Axis> axes;
  Axis across;
  /** b's centre less a's. */
  V3 d{0, 0, 0};
  HalfKind kind = HalfKind::Level;
  // Level: both frames' half extents and headings.
  double aHl = 0, aHw = 0, aC = 1, aS = 0, bHl = 0, bHw = 0, bC = 1, bS = 0;
  // Tilted: each frame's heading and side laid in the plane.
  V3 fa{}, ra{}, fb{}, rb{};
  // Sat: each box's three axes and half extents.
  V3 boxAxes[2][3]{};
  double boxHalf[2][3]{};

  /** Both boxes' half extent along `w`. */
  double Half(const V3& w) const {
    if (kind == HalfKind::Level) {
      const double a = aHl * std::fabs(aC * w[0] + aS * w[1]) + aHw * std::fabs(aC * w[1] - aS * w[0]);
      const double b = bHl * std::fabs(bC * w[0] + bS * w[1]) + bHw * std::fabs(bC * w[1] - bS * w[0]);
      return a + b;
    }
    if (kind == HalfKind::Tilted) {
      return aHl * std::fabs(Dot(fa, w)) + aHw * std::fabs(Dot(ra, w)) + (bHl * std::fabs(Dot(fb, w)) + bHw * std::fabs(Dot(rb, w)));
    }
    return Radius(0, w) + Radius(1, w);
  }

 private:
  double Radius(int box, const V3& w) const {
    return boxHalf[box][0] * std::fabs(Dot(boxAxes[box][0], w)) + boxHalf[box][1] * std::fabs(Dot(boxAxes[box][1], w)) +
           boxHalf[box][2] * std::fabs(Dot(boxAxes[box][2], w));
  }
};

/** Half a level frame's box along a horizontal unit axis (nx, ny). */
double HalfLevel(const Frame& f, double nx, double ny) {
  return f.hl * std::fabs(f.c * nx + f.s * ny) + f.hw * std::fabs(f.c * ny - f.s * nx);
}

/** Two level frames (both upright): the footprints' four edge normals, least overlap first of equals, and the
 *  across axis along z; none when an axis separates them. Two centres on one spot are split along a's heading. */
std::optional<Geometry> LevelGeometry(const Frame& a, const Frame& b) {
  const double across = b.b->z - a.b->z + (b.top - a.top) / 2;
  const double reachUp = (a.top + b.top) / 2;
  if (std::fabs(across) >= reachUp) return std::nullopt;
  const double dx = b.b->x - a.b->x;
  const double dy = b.b->y - a.b->y;
  const double reach = DiagOf(a) + DiagOf(b);
  if (std::fabs(dx) >= reach || std::fabs(dy) >= reach) return std::nullopt;
  const double axes[8] = {a.c, a.s, -a.s, a.c, b.c, b.s, -b.s, b.c};
  Geometry g;
  int best = -1;
  for (int k = 0; k < 8; k += 2) {
    const double nx = axes[k];
    const double ny = axes[k + 1];
    const double along = dx * nx + dy * ny;
    const double depth = HalfLevel(a, nx, ny) + HalfLevel(b, nx, ny) - std::fabs(along);
    if (depth <= 0) return std::nullopt;
    Axis axis;
    axis.depth = depth;
    axis.n = along < 0 ? V3{-nx, -ny, 0} : V3{nx, ny, 0};
    g.axes.push_back(axis);
    if (best < 0 || depth < g.axes[static_cast<std::size_t>(best)].depth) best = static_cast<int>(g.axes.size()) - 1;
  }
  g.plane = kUp;
  g.level = true;
  g.sideIndex = best;
  g.side = g.axes[static_cast<std::size_t>(best)];
  g.across.depth = reachUp - std::fabs(across);
  g.across.n = across < 0 ? V3{0, 0, -1} : kUp;
  g.d = V3{dx, dy, 0};
  g.kind = Geometry::HalfKind::Level;
  g.aHl = a.hl;
  g.aHw = a.hw;
  g.aC = a.c;
  g.aS = a.s;
  g.bHl = b.hl;
  g.bHw = b.hw;
  g.bC = b.c;
  g.bS = b.s;
  return g;
}

/** A heading (horizontal unit vector) laid in the plane across `n`, of unit length; straight up the plane where
 *  the heading points along `n`. */
V3 InPlane(double hx, double hy, const V3& n) {
  const double along = hx * n[0] + hy * n[1];
  double px = hx - along * n[0];
  double py = hy - along * n[1];
  double pz = -along * n[2];
  double len = std::sqrt(px * px + py * py + pz * pz);
  if (len < 1e-9) {
    px = -n[2] * n[0];
    py = -n[2] * n[1];
    pz = 1 - n[2] * n[2];
    len = std::sqrt(px * px + py * py + pz * pz);
  }
  return V3{px / len, py / len, pz / len};
}

/** Two frames of which one at least is tilted and whose ups are equal: the boxes in the plane across that up, the
 *  least of the four in-plane edge normals and the axis across the plane. */
std::optional<Geometry> TiltedGeometry(const Frame& a, const Frame& b) {
  const V3 sum{a.up[0] + b.up[0], a.up[1] + b.up[1], a.up[2] + b.up[2]};
  const double len = std::sqrt(Dot(sum, sum));
  if (len < 1e-9) return std::nullopt;
  const V3 n{sum[0] / len, sum[1] / len, sum[2] / len};
  const double ha = a.top / 2;
  const double hb = b.top / 2;
  const V3 d{b.b->x + b.up[0] * hb - a.b->x - a.up[0] * ha, b.b->y + b.up[1] * hb - a.b->y - a.up[1] * ha,
             b.b->z + b.up[2] * hb - a.b->z - a.up[2] * ha};
  const double across = Dot(d, n);
  const double reachUp = ha + hb;
  if (std::fabs(across) >= reachUp) return std::nullopt;
  Geometry g;
  g.kind = Geometry::HalfKind::Tilted;
  g.aHl = a.hl;
  g.aHw = a.hw;
  g.bHl = b.hl;
  g.bHw = b.hw;
  g.fa = InPlane(a.c, a.s, n);
  g.fb = InPlane(b.c, b.s, n);
  g.ra = Cross(n, g.fa);
  g.rb = Cross(n, g.fb);
  int best = -1;
  for (const V3* k : {&g.fa, &g.ra, &g.fb, &g.rb}) {
    const double along = Dot(d, *k);
    const double depth = a.hl * std::fabs(Dot(g.fa, *k)) + a.hw * std::fabs(Dot(g.ra, *k)) +
                         (b.hl * std::fabs(Dot(g.fb, *k)) + b.hw * std::fabs(Dot(g.rb, *k))) - std::fabs(along);
    if (depth <= 0) return std::nullopt;
    Axis axis;
    axis.depth = depth;
    axis.n = along < 0 ? Neg(*k) : *k;
    g.axes.push_back(axis);
    if (best < 0 || depth < g.axes[static_cast<std::size_t>(best)].depth) best = static_cast<int>(g.axes.size()) - 1;
  }
  g.plane = n;
  g.level = false;
  g.sideIndex = best;
  g.side = g.axes[static_cast<std::size_t>(best)];
  g.across.depth = reachUp - std::fabs(across);
  g.across.n = across < 0 ? Neg(n) : n;
  g.d = d;
  return g;
}

/** Cross products of two box axes shorter than this are parallel axes: no separating axis of their own. */
constexpr double kSatParallel = 1e-6;

/** Two frames on supports that are not parallel (§17.11 step 2): the two oriented boxes, each laid on its own up,
 *  by the separating axis test over the 15 axes (a's three, b's three, then each of a's crossed with each of b's,
 *  in that order; a near-zero cross product skipped); none when one separates them. The side axis is the least
 *  deep of all 15 (the minimum translation axis), the across axis the mean up itself. */
std::optional<Geometry> SatGeometry(const Frame& a, const Frame& b, const V3& n) {
  Geometry g;
  g.kind = Geometry::HalfKind::Sat;
  V3 centre[2];
  const Frame* frames[2] = {&a, &b};
  for (int i = 0; i < 2; ++i) {
    const Frame& f = *frames[i];
    const V3 fw = InPlane(f.c, f.s, f.up);
    const double h = f.top / 2;
    centre[i] = V3{f.b->x + f.up[0] * h, f.b->y + f.up[1] * h, f.b->z + f.up[2] * h};
    g.boxAxes[i][0] = fw;
    g.boxAxes[i][1] = Cross(f.up, fw);
    g.boxAxes[i][2] = f.up;
    g.boxHalf[i][0] = f.hl;
    g.boxHalf[i][1] = f.hw;
    g.boxHalf[i][2] = h;
  }
  const V3 d{centre[1][0] - centre[0][0], centre[1][1] - centre[0][1], centre[1][2] - centre[0][2]};
  std::vector<V3> candidates;
  for (int i = 0; i < 2; ++i) {
    for (int k = 0; k < 3; ++k) candidates.push_back(g.boxAxes[i][k]);
  }
  for (int p = 0; p < 3; ++p) {
    for (int q = 0; q < 3; ++q) {
      const V3 c = Cross(g.boxAxes[0][p], g.boxAxes[1][q]);
      const double len = std::sqrt(Dot(c, c));
      if (len > kSatParallel) candidates.push_back(V3{c[0] / len, c[1] / len, c[2] / len});
    }
  }
  int best = -1;
  for (const V3& k : candidates) {
    const double along = Dot(d, k);
    const double depth = g.Half(k) - std::fabs(along);
    if (depth <= 0) return std::nullopt;
    Axis axis;
    axis.depth = depth;
    axis.n = along < 0 ? Neg(k) : k;
    g.axes.push_back(axis);
    if (best < 0 || depth < g.axes[static_cast<std::size_t>(best)].depth) best = static_cast<int>(g.axes.size()) - 1;
  }
  const double across = Dot(d, n);
  g.plane = n;
  g.level = false;
  g.sideIndex = best;
  g.side = g.axes[static_cast<std::size_t>(best)];
  g.across.depth = g.Half(n) - std::fabs(across);
  g.across.n = across < 0 ? Neg(n) : n;
  g.d = d;
  return g;
}

/** The pair's geometry, or none when the two do not touch. */
std::optional<Geometry> GeometryOf(const Frame& a, const Frame& b) {
  const double reach = DiagOf(a) + DiagOf(b);
  const double reachUp = (a.top + b.top) / 2;
  const double far = std::sqrt(reach * reach + reachUp * reachUp) + reachUp;
  if (std::fabs(b.b->x - a.b->x) >= far || std::fabs(b.b->y - a.b->y) >= far || std::fabs(b.b->z - a.b->z) >= far) return std::nullopt;
  if (a.up[2] == 1 && b.up[2] == 1) return LevelGeometry(a, b);
  if (a.up[0] == b.up[0] && a.up[1] == b.up[1] && a.up[2] == b.up[2]) return TiltedGeometry(a, b);
  const V3 sum{a.up[0] + b.up[0], a.up[1] + b.up[1], a.up[2] + b.up[2]};
  const double len = std::sqrt(Dot(sum, sum));
  if (len < 1e-9) return std::nullopt;
  return SatGeometry(a, b, V3{sum[0] / len, sum[1] / len, sum[2] / len});
}

/** How fast `b` closes on `a` along `n` (from a to b): positive when closing. */
double ClosingAlong(const PolicyBody& a, const PolicyBody& b, const V3& n) {
  return -((b.vx - a.vx) * n[0] + (b.vy - a.vy) * n[1] + (b.vz - a.vz) * n[2]);
}

/** How the pair entered (§17.11 step 2): whether the across axis is its contact axis, and whether the pair landed
 *  across the plane. It landed when it came down within `entryWindow` (the across depth over its closing speed,
 *  at least `entrySpeed`) and less than halfway in, or, tilted, when it rests within the preset's ground trace
 *  across it. The across axis is the contact axis only when the pair landed and entered through it last (its
 *  time under the in-plane axis's, a tie to the lesser depth). */
struct Entry {
  bool across = false;
  bool landed = false;
};

Entry EntryOf(const Geometry& g, const Frame& a, const Frame& b, const ContactPolicy& policy) {
  const double tUp = g.across.depth / JsMax(ClosingAlong(*a.b, *b.b, g.across.n), policy.entrySpeed);
  const bool cameDown = tUp <= policy.entryWindow && g.across.depth <= (a.top + b.top) / 4;
  Entry e;
  e.landed = cameDown || (!g.level && g.across.depth <= policy.groundTrace);
  if (!e.landed) return e;
  const double tSide = g.side.depth / JsMax(ClosingAlong(*a.b, *b.b, g.side.n), policy.entrySpeed);
  e.across = tUp < tSide || (tUp == tSide && g.across.depth < g.side.depth);
  return e;
}

/** A contact and the geometry it came from; `axisIndex` is the index of its axis in the geometry's axes (-1: the
 *  across axis). */
struct Found {
  PairContact contact;
  Geometry g;
  int axisIndex = -1;
};

/** Whether `a` carries tag `t`. */
bool HasTag(const std::vector<std::string>& tags, const std::string& t) { return std::find(tags.begin(), tags.end(), t) != tags.end(); }

std::optional<Found> RestingOf(const Frame& fa, const Frame& fb, const ContactPolicy& policy);

/** The contact of two frames and the geometry it came from; none when they do not touch. */
std::optional<Found> ContactOfFrames(const Frame& fa, const Frame& fb, const ContactPolicy& policy) {
  std::optional<Geometry> g = GeometryOf(fa, fb);
  if (!g) return RestingOf(fa, fb, policy);
  const Entry entry = EntryOf(*g, fa, fb, policy);
  Found found;
  if (!entry.across) {
    found.contact.kind = ContactKind::Side;
    found.contact.n = g->side.n;
    found.contact.depth = g->side.depth;
    found.contact.upperIsB = Dot(g->d, g->plane) >= 0;
    found.axisIndex = g->sideIndex;
    found.g = std::move(*g);
    return found;
  }
  const V3 n = g->across.n;
  const bool upperIsB = n == g->plane || Dot(n, g->plane) > 0;
  const Frame& lower = upperIsB ? fa : fb;
  const V3 toUpper = upperIsB ? n : Neg(n);
  // A top contact is a seat that came down onto another; two at rest across the plane (side by side up a wall)
  // are pushed apart along it, half each.
  const bool top = entry.landed && Dot(toUpper, lower.support) >= policy.supportCos;
  found.contact.kind = top ? ContactKind::Top : ContactKind::Side;
  found.contact.n = n;
  found.contact.depth = g->across.depth;
  found.contact.upperIsB = upperIsB;
  found.axisIndex = -1;
  found.g = std::move(*g);
  return found;
}

/** A seat resting on another's top without touching it (§17.11 step 2): the upper seat (the higher base) let
 *  down by the ground trace meets the lower one across the plane, the across axis shallower than the in-plane one
 *  and within `supportCos` of the lower seat's support up, the lower seat can be stood on, and the upper seat is
 *  not leaving it. A top contact of depth at most 0 (the gap, negative). */
std::optional<Found> RestingOf(const Frame& fa, const Frame& fb, const ContactPolicy& policy) {
  const bool upperIsB = fb.b->z >= fa.b->z;
  PolicyBody dropped = upperIsB ? *fb.b : *fa.b;
  dropped.z = dropped.z - policy.groundTrace;
  Frame df = upperIsB ? fb : fa;
  df.b = &dropped;
  std::optional<Geometry> g = upperIsB ? GeometryOf(fa, df) : GeometryOf(df, fb);
  if (!g || !(g->across.depth < g->side.depth)) return std::nullopt;
  const V3 toUpper = upperIsB ? g->across.n : Neg(g->across.n);
  if (!(Dot(toUpper, g->plane) > 0)) return std::nullopt;
  const Frame& lower = upperIsB ? fa : fb;
  // Only on a lower seat that can be stood on: up a wall two seats a hair apart across its plane are side by
  // side, not one on the other.
  if (lower.support[2] < policy.supportCos || Dot(toUpper, lower.support) < policy.supportCos) return std::nullopt;
  const PolicyBody* u = upperIsB ? fb.b : fa.b;
  const PolicyBody* l = upperIsB ? fa.b : fb.b;
  if (-ClosingAlong(*l, *u, toUpper) > policy.entrySpeed) return std::nullopt;
  Found found;
  found.contact.kind = ContactKind::Top;
  found.contact.n = g->across.n;
  found.contact.depth = g->across.depth - policy.groundTrace;
  found.contact.upperIsB = upperIsB;
  found.axisIndex = -1;
  found.g = std::move(*g);
  return found;
}

/** How far a seat's body reaches from its base, any way it is laid (its box's corner from the base). */
double ReachOf(const ContactPolicy& policy) {
  const ContactShape& shape = policy.shape;
  if (shape.kind == ContactShapeKind::Hull) return std::sqrt(2 * shape.radius * shape.radius + shape.height * shape.height);
  return std::sqrt((shape.length * shape.length) / 4 + (shape.width * shape.width) / 4 + shape.top * shape.top);
}

/** Whether two seats' bases are too far apart for their bodies to touch, or one to rest on the other (its ground
 *  trace and a unit over): no frame is laid for them (each a cast down the world). */
bool FarApart(const PolicyBody& a, const PolicyBody& b, const ContactPolicy& policy) {
  const double reach = 2 * ReachOf(policy) + policy.groundTrace + 1;
  const double dx = b.x - a.x;
  const double dy = b.y - a.y;
  const double dz = b.z - a.z;
  return dx * dx + dy * dy + dz * dz > reach * reach;
}

/** The policy's per-axis velocity clamp. */
double Clamp(const ContactPolicy& policy, double v) {
  if (!policy.maxVelocity) return v;
  const double m = *policy.maxVelocity;
  return v < -m ? -m : v > m ? m : v;
}

V3 BaseOf(const PolicyBody& b) { return V3{b.x, b.y, b.z}; }

/** A face this close to a seat's support up (its cosine) is the ground it rides (a wall for a car on it). */
constexpr double kGroundFace = 0.7;
/** A push whose part along the seat's support up is under minus this (sin 30°) points into its ground. */
constexpr double kGroundInto = 0.5;
/** A side push slides along a wall it meets only within this of the push (cos 60°). */
constexpr double kSideSlideCos = 0.5;

/** How a seat takes a side push along unit `d` (§17.11 step 4): straight up to the first wall its cast meets
 *  (`straight`), then along that wall in the plane the seat rides (`slide`), as a swept hull slides; `sep` how
 *  much of the push it takes, along `d`. */
struct SeatWay {
  V3 d{0, 0, 1};
  double straight = 0;
  std::optional<V3> slide;
  double cos = 1;
  double sep = 0;
};

/** The way along face `f` a push `d` that it stopped takes (unit), or none under kSideSlideCos of `d`: along the
 *  seat's own ground (`f` within kGroundFace of its `up`: a car on a wall pushed along it) the push laid in that
 *  face; along a wall the line where it meets the seat's plane (`cross(f, up)`, turned along `d`). */
std::optional<V3> SlideOn(const V3& f, const V3& d, const V3& up) {
  if (Dot(f, up) >= kGroundFace) {
    const double k = Dot(d, f);
    const V3 v{d[0] - k * f[0], d[1] - k * f[1], d[2] - k * f[2]};
    const double len = JsHypot3(v[0], v[1], v[2]);
    if (len >= kSideSlideCos) return V3{v[0] / len, v[1] / len, v[2] / len};
    return std::nullopt;
  }
  const V3 line = Cross(f, up);
  const double len = JsHypot3(line[0], line[1], line[2]);
  const double along = len > 0 ? Dot(line, d) / len : 0;
  if (!(std::fabs(along) >= kSideSlideCos)) return std::nullopt;
  const double k = along > 0 ? 1 / len : -1 / len;
  return V3{line[0] * k, line[1] * k, line[2] * k};
}

/** A seat's way (`SeatWay`) at base `p`, riding the plane whose up is `up`, for a push of `depth` along `d`;
 *  faces `rides` passes do not stop it (the surface its preset follows). */
SeatWay SeatWayAt(const ContactWorld& world, const V3& p, const V3& d, double depth, const Rides* rides, const V3& up) {
  // A push into the ground the seat rides is stopped by it (the push-out would only lift the seat back).
  const CastHit hit = CastWorld(world, p, d, depth, Dot(d, up) < -kGroundInto ? nullptr : rides);
  SeatWay way;
  way.d = d;
  way.straight = hit.t;
  way.sep = hit.t;
  if (!hit.face || !(hit.t < depth)) return way;
  const V3 f{hit.face->nx, hit.face->ny, hit.face->nz};
  const std::optional<V3> slide = SlideOn(f, d, up);
  if (!slide) return way;
  const double cos = Dot(*slide, d);
  const V3 from{p[0] + d[0] * hit.t, p[1] + d[1] * hit.t, p[2] + d[2] * hit.t};
  const double room = CastWorld(world, from, *slide, (depth - hit.t) / cos, rides).t;
  way.slide = slide;
  way.cos = cos;
  way.sep = hit.t + room * cos;
  return way;
}

/** The move of a seat taking `along` of a push its way `w` (straight, then the slide for the rest). */
V3 WayMove(const SeatWay& w, double along) {
  const V3& d = w.d;
  if (!w.slide || !(along > w.straight)) return V3{d[0] * along, d[1] * along, d[2] * along};
  const double rest = (along - w.straight) / w.cos;
  const V3& u = *w.slide;
  return V3{d[0] * w.straight + u[0] * rest, d[1] * w.straight + u[1] * rest, d[2] * w.straight + u[2] * rest};
}

/** The shares from two rooms (fractions of the push): `b` at most the rest of what `a` can take up to `wantA`
 *  (half: equal masses), then `a` the rest of what `b` could not take. */
std::pair<double, double> SharesOf(double roomA, double roomB, double wantA) {
  const double sb = JsMin(roomB, 1 - JsMin(roomA, wantA));
  return {JsMin(roomA, 1 - sb), sb};
}

/** The faces seat frame `f` rides (within the policy's `supportCos` of its support up). */
Rides RidesOf(const Frame& f, const ContactPolicy& policy) {
  Rides r;
  r.up = f.support;
  r.cos = policy.supportCos;
  return r;
}

/** The part of a side push along `n` (from a to b) seat `a` would take before walls (§17.11 step 4): half under
 *  `shared`; under `mover` its own share of the two closing speeds, half when neither closes. */
double WantOf(const PolicyBody& a, const PolicyBody& b, const V3& n, const ContactPolicy& policy) {
  if (policy.push != ContactPush::Mover) return 0.5;
  double va = a.vx * n[0] + a.vy * n[1];
  double vb = b.vx * n[0] + b.vy * n[1];
  if (n[2] != 0) {
    va += a.vz * n[2];
    vb += b.vz * n[2];
  }
  const double wa = va > 0 ? va : 0;
  const double wb = vb < 0 ? -vb : 0;
  return wa + wb > 0 ? wa / (wa + wb) : 0.5;
}

/** The shares of a pair's side push (`YieldShares`), a fixed seat (`env.fixed`) taking none: the other takes what
 *  its way allows. */
std::pair<double, double> PairShares(const Frame& fa, const Frame& fb, const V3& n, double depth, const ContactPolicy& policy,
                                     const ContactEnv& env) {
  const Rides ra = RidesOf(fa, policy);
  const Rides rb = RidesOf(fb, policy);
  const std::pair<double, double> s =
      YieldShares(*fa.b, *fb.b, n, depth, env.world, &ra, &rb, fa.support, fb.support, WantOf(*fa.b, *fb.b, n, policy));
  if (!env.fixed) return s;
  if (fa.b->id == *env.fixed) {
    return {0, env.world == nullptr ? 1 : SeatWayAt(*env.world, BaseOf(*fb.b), n, depth, &rb, fb.support).sep / depth};
  }
  if (fb.b->id == *env.fixed) {
    return {env.world == nullptr ? 1 : SeatWayAt(*env.world, BaseOf(*fa.b), Neg(n), depth, &ra, fa.support).sep / depth, 0};
  }
  return s;
}

struct Wedged {
  V3 n;
  double depth;
  double sa;
  double sb;
};

/** A side push for a pair wedged along its contact axis (the two shares leave some of it): the next axis, least
 *  deep first, along which the two have room for the whole of its depth; else the contact axis with what is left
 *  split half each (the push-out after the pass takes it out of the walls), so a pair is never left inside each
 *  other for want of room. */
Wedged WedgedPush(const Frame& fa, const Frame& fb, const PairContact& c, int axisIndex, const Geometry& g,
                  const ContactPolicy& policy, const ContactEnv& env) {
  std::vector<const Axis*> others;
  for (std::size_t i = 0; i < g.axes.size(); ++i) {
    if (static_cast<int>(i) != axisIndex) others.push_back(&g.axes[i]);
  }
  std::stable_sort(others.begin(), others.end(), [](const Axis* p, const Axis* q) { return p->depth < q->depth; });
  for (const Axis* k : others) {
    const std::pair<double, double> s = PairShares(fa, fb, k->n, k->depth, policy, env);
    if (!(s.first + s.second < 1)) return Wedged{k->n, k->depth, s.first, s.second};
  }
  const std::pair<double, double> s = PairShares(fa, fb, c.n, c.depth, policy, env);
  const double left = 1 - s.first - s.second;
  if (env.fixed && fa.b->id == *env.fixed) return Wedged{c.n, c.depth, s.first, s.second + left};
  if (env.fixed && fb.b->id == *env.fixed) return Wedged{c.n, c.depth, s.first + left, s.second};
  return Wedged{c.n, c.depth, s.first + left / 2, s.second + left / 2};
}

/** Seat `b` moved by `m` (z only when the move has a z part). */
void MoveBy(PolicyBody& b, const V3& m) {
  b.x += m[0];
  b.y += m[1];
  if (m[2] != 0) b.z += m[2];
}

/** The two seats moved apart along `n` by their shares of `depth`, each its way (straight, then along the wall it
 *  meets; without a world straight along the axis). */
void PushApart(const Frame& fa, const Frame& fb, const V3& n, double depth, double sa, double sb, const ContactPolicy& policy,
               const ContactEnv& env) {
  PolicyBody& a = *fa.b;
  PolicyBody& b = *fb.b;
  const V3 away = Neg(n);
  const Rides ra = RidesOf(fa, policy);
  const Rides rb = RidesOf(fb, policy);
  SeatWay wa;
  SeatWay wb;
  if (env.world == nullptr) {
    wa.d = away;
    wa.straight = depth;
    wa.sep = depth;
    wb.d = n;
    wb.straight = depth;
    wb.sep = depth;
  } else {
    wa = SeatWayAt(*env.world, BaseOf(a), away, depth, &ra, fa.support);
    wb = SeatWayAt(*env.world, BaseOf(b), n, depth, &rb, fb.support);
  }
  MoveBy(a, WayMove(wa, depth * sa));
  MoveBy(b, WayMove(wb, depth * sb));
}

struct SideResult {
  double j = 0;
  V3 n{0, 0, 1};
  double depth = 0;
};

/** A side contact (§17.11 step 4): pushed apart by the yield shares, each seat its way, the parts of the velocities
 *  along the axis swapped keeping `restitution` of the closing speed (none while `cooling`), and each seat's `spin`
 *  stopped when the policy says so. */
SideResult SideContact(const Frame& fa, const Frame& fb, const PairContact& contact, int axisIndex, const Geometry& g,
                       const ContactPolicy& policy, const ContactEnv& env, bool cooling) {
  PolicyBody& a = *fa.b;
  PolicyBody& b = *fb.b;
  const std::pair<double, double> s0 = PairShares(fa, fb, contact.n, contact.depth, policy, env);
  Wedged w{contact.n, contact.depth, s0.first, s0.second};
  if (s0.first + s0.second < 1) w = WedgedPush(fa, fb, contact, axisIndex, g, policy, env);
  const V3 n = w.n;
  const double nx = n[0];
  const double ny = n[1];
  const double nz = n[2];
  double closing = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (nz != 0) closing += (b.vz - a.vz) * nz;
  const double j = closing < 0 && !cooling ? (-(1 + policy.restitution) * closing) / 2 : 0;
  // The impulse each takes: half each under `shared` (j), by the closing speeds under `mover`.
  const double want = WantOf(a, b, n, policy);
  const double ja = 2 * j * want;
  const double jb = 2 * j * (1 - want);
  PushApart(fa, fb, n, w.depth, w.sa, w.sb, policy, env);
  a.vx = Clamp(policy, a.vx - ja * nx);
  a.vy = Clamp(policy, a.vy - ja * ny);
  if (policy.stopSpin) a.spin = 0;
  b.vx = Clamp(policy, b.vx + jb * nx);
  b.vy = Clamp(policy, b.vy + jb * ny);
  if (policy.stopSpin) b.spin = 0;
  if (nz != 0) {
    a.vz = Clamp(policy, a.vz - ja * nz);
    b.vz = Clamp(policy, b.vz + jb * nz);
  }
  SideResult r;
  r.j = j;
  r.n = n;
  r.depth = w.depth;
  return r;
}

/** A unit in-plane way and how far the upper seat must move along it to clear the lower. */
struct Way {
  V3 w{0, 0, 1};
  double move = 0;
};

/** Sorts ways by move, ties keeping the order they were listed in (the stable sort the TypeScript's `k` makes). */
void SortWays(std::vector<Way>& ways) {
  std::stable_sort(ways.begin(), ways.end(), [](const Way& x, const Way& y) { return x.move < y.move; });
}

/** The four slide candidates of a top contact (§17.11 step 6 *free way*), from the lower seat toward the upper's
 *  side: (a) the in-plane least-overlap axis, (b) its opposite, (c) and (d) the two in-plane perpendiculars; each
 *  with the distance the upper seat must move along it to clear the lower, least first. */
std::vector<Way> WaysOf(const Geometry& g, bool upperIsB) {
  const V3 w1 = upperIsB ? g.side.n : Neg(g.side.n);
  const V3 off = upperIsB ? g.d : Neg(g.d);
  const V3 p = Cross(g.plane, w1);
  std::vector<Way> ways;
  for (const V3& w : {w1, Neg(w1), p, Neg(p)}) {
    Way way;
    way.w = w;
    way.move = g.Half(w) - Dot(off, w);
    ways.push_back(way);
  }
  SortWays(ways);
  return ways;
}

/** How far the upper seat must move along `w` to clear the lower one of a pair with geometry `g`. */
double ClearAlong(const Geometry& g, bool upperIsB, const V3& w) { return g.Half(w) - Dot(upperIsB ? g.d : Neg(g.d), w); }

/** The pairs' geometries of every other seat in `others` the upper seat (frame `upperF`) rests on: a top contact
 *  with it above (a ghost pair aside). */
std::vector<Geometry> SupportsOf(const Frame& upperF, const PolicyBody* lower, const std::vector<PolicyBody*>& others,
                                 const ContactPolicy& policy, const ContactEnv& env) {
  std::vector<Geometry> out;
  for (PolicyBody* o : others) {
    if (o == upperF.b || o == lower || FarApart(*upperF.b, *o, policy) || TopRuleOf(policy, *upperF.b, *o).policy == TopPolicy::Ghost) {
      continue;
    }
    const std::optional<Found> found = ContactOfFrames(upperF, FrameOf(o, policy, env), policy);
    if (found && found->contact.kind == ContactKind::Top && !found->contact.upperIsB) out.push_back(found->g);
  }
  return out;
}

/** The upper seat's ways (§17.11 step 6 *free way*): the pair's four, each needing the move that clears every seat
 *  it rests on (`supports`, the other lower seats), least first (ties keep the order). */
std::vector<Way> UpperWaysOf(const Geometry& g, bool upperIsB, const std::vector<Geometry>& supports) {
  if (supports.empty()) return WaysOf(g, upperIsB);
  const V3 w1 = upperIsB ? g.side.n : Neg(g.side.n);
  const V3 p = Cross(g.plane, w1);
  std::vector<Way> ways;
  for (const V3& w : {w1, Neg(w1), p, Neg(p)}) {
    double move = ClearAlong(g, upperIsB, w);
    for (const Geometry& s : supports) move = JsMax(move, ClearAlong(s, false, w));
    Way way;
    way.w = w;
    way.move = move;
    ways.push_back(way);
  }
  SortWays(ways);
  return ways;
}

/** Whether a seat can move `way.move` along `way.w` without entering a grown solid (faces it rides pass). */
bool IsFree(const ContactWorld* world, const Frame& f, const Way& way, const ContactPolicy& policy) {
  if (way.move <= 0) return true;
  const Rides r = RidesOf(f, policy);
  return RoomAlong(world, BaseOf(*f.b), way.w, way.move, &r) >= way.move;
}

/** Changes `body`'s velocity by `j` along `w`, x and y always written (clamped), z only when `w` leaves the
 *  ground's plane. */
void Kick(PolicyBody& body, const V3& w, double j, const ContactPolicy& policy) {
  body.vx = Clamp(policy, body.vx + j * w[0]);
  body.vy = Clamp(policy, body.vy + j * w[1]);
  if (w[2] != 0) body.vz = Clamp(policy, body.vz + j * w[2]);
}

/** The slide's velocity change for a parting `parting` along the way: up to `speed`, by at most `step`. */
double SlideStep(const SlideRule& rule, double parting) {
  if (!(parting < rule.speed)) return 0;
  const double want = rule.speed - parting;
  return rule.step ? JsMin(want, *rule.step) : want;
}

/** A top contact's slide: how it went, the change and the way taken. */
struct SlideOutcome {
  double j = 0;
  SlideWay way = SlideWay::None;
  std::optional<V3> w;
};

/** A top contact's slide (§17.11 step 6 `slide`): frictionless, the pair parted along the upper seat's first free
 *  way up to the rule's speed by at most its step a tick, `share` of it on the upper seat; when no way is free for
 *  it, the lower seat slides out along its own first free way (all of it on the lower); when neither is, the pair
 *  stands (pinned). */
SlideOutcome SlideOff(const Frame& upperF, const Frame& lowerF, const Geometry& g, bool upperIsB, const SlideRule& rule,
                      const ContactPolicy& policy, const ContactEnv& env, const std::vector<PolicyBody*>& others) {
  PolicyBody& upper = *upperF.b;
  PolicyBody& lower = *lowerF.b;
  const std::vector<Way> ways = WaysOf(g, upperIsB);
  const std::vector<Way> upperWays = UpperWaysOf(g, upperIsB, SupportsOf(upperF, &lower, others, policy, env));
  for (const Way& way : upperWays) {
    if (!IsFree(env.world, upperF, way, policy)) continue;
    const double parting = (upper.vx - lower.vx) * way.w[0] + (upper.vy - lower.vy) * way.w[1] + (upper.vz - lower.vz) * way.w[2];
    const double j = SlideStep(rule, parting);
    Kick(upper, way.w, j * rule.share, policy);
    if (rule.share != 1) Kick(lower, way.w, -j * (1 - rule.share), policy);
    SlideOutcome out;
    out.j = j;
    out.way = SlideWay::Free;
    out.w = way.w;
    return out;
  }
  for (const Way& way : ways) {
    Way own;
    own.w = Neg(way.w);
    own.move = way.move;
    if (!IsFree(env.world, lowerF, own, policy)) continue;
    const double parting = (lower.vx - upper.vx) * own.w[0] + (lower.vy - upper.vy) * own.w[1] + (lower.vz - upper.vz) * own.w[2];
    const double j = SlideStep(rule, parting);
    Kick(lower, own.w, j, policy);
    SlideOutcome out;
    out.j = j;
    out.way = SlideWay::LowerYields;
    out.w = own.w;
    return out;
  }
  SlideOutcome pinned;
  pinned.way = SlideWay::Pinned;
  return pinned;
}

/** The upper seat set on the lower's top (§17.11 step 5), its base moved along the contact's normal (`up`, from
 *  the lower to the upper) by `depth` plus the roof skin; what the world does not let it take, the lower seat
 *  takes the other way. Level: its base at the lower's base plus the lower's top. */
void PlaceOnTop(PolicyBody& upper, PolicyBody& lower, const V3& up, double depth, const Geometry& g, double lowerTop,
                const ContactPolicy& policy, const ContactEnv& env) {
  const double need = depth + policy.roofSkin;
  // A resting seat (depth at most −roofSkin) is already on the top: it is never pulled down onto it.
  if (!(need > 0)) return;
  const bool upperFixed = env.fixed && upper.id == *env.fixed;
  const double room = upperFixed ? 0 : RoomAlong(env.world, BaseOf(upper), up, need, nullptr);
  if (room >= need && g.level) {
    upper.z = lower.z + lowerTop + policy.roofSkin;
    return;
  }
  upper.x += up[0] * room;
  upper.y += up[1] * room;
  upper.z += up[2] * room;
  if (room >= need) return;
  const bool lowerFixed = env.fixed && lower.id == *env.fixed;
  const double rest = lowerFixed ? 0 : RoomAlong(env.world, BaseOf(lower), Neg(up), need - room, nullptr);
  lower.x -= up[0] * rest;
  lower.y -= up[1] * rest;
  lower.z -= up[2] * rest;
}

/** The upper seat's velocity along `up` raised to the lower's when it was closing (it stops on it). */
void StopOnTop(PolicyBody& upper, const PolicyBody& lower, const V3& up) {
  const double vu = upper.vx * up[0] + upper.vy * up[1] + upper.vz * up[2];
  const double vl = lower.vx * up[0] + lower.vy * up[1] + lower.vz * up[2];
  if (!(vu < vl)) return;
  if (up[0] == 0 && up[1] == 0) {
    upper.vz = lower.vz;
    return;
  }
  upper.vx += up[0] * (vl - vu);
  upper.vy += up[1] * (vl - vu);
  upper.vz = upper.vz + up[2] * (vl - vu);
}

/** A stomp (§17.11 step 6 `bounce`): the upper seat's velocity along `up` set to the bounce speed (plus the boost
 *  while its jump is held). */
void Bounce(PolicyBody& upper, const V3& up, double speed) {
  const double vu = upper.vx * up[0] + upper.vy * up[1] + upper.vz * up[2];
  upper.vx += up[0] * (speed - vu);
  upper.vy += up[1] * (speed - vu);
  upper.vz = upper.vz + up[2] * (speed - vu);
}

/** How fast the lower seat moves away from under the upper in the plane (its velocity along the way from the upper's
 *  centre to its own): a lower that carries its rider never parts them; the upper's own speed never counts. */
double LeavingOf(const PolicyBody& upper, const PolicyBody& lower, bool ride) {
  if (ride) return 0;
  const double dx = upper.x - lower.x;
  const double dy = upper.y - lower.y;
  const double len = std::sqrt(dx * dx + dy * dy);
  if (!(len > 0)) return 0;
  return -(lower.vx * dx + lower.vy * dy) / len;
}

/** A top contact (§17.11 steps 5 and 6). */
SlideOutcome TopContact(const Frame& fa, const Frame& fb, const PairContact& c, const Geometry& g, const TopRule& rule,
                        const ContactPolicy& policy, const ContactEnv& env, const std::vector<PolicyBody*>& others) {
  const Frame& upperF = c.upperIsB ? fb : fa;
  const Frame& lowerF = c.upperIsB ? fa : fb;
  PolicyBody& upper = *upperF.b;
  PolicyBody& lower = *lowerF.b;
  const V3 up = c.upperIsB ? c.n : Neg(c.n);
  const double closing = ClosingAlong(lower, upper, up);
  // The stand test reads the pair as it came in: a landing is told by its closing speed.
  const bool slides = rule.policy == TopPolicy::Stand && HeadHoldOf(upper, lower, rule, policy) == HeadHold::Slide;
  PlaceOnTop(upper, lower, up, c.depth, g, lowerF.top, policy, env);
  StopOnTop(upper, lower, up);
  if (lowerF.support[2] < policy.supportCos) return SlideOff(upperF, lowerF, g, c.upperIsB, policy.offWall, policy, env, others);
  if (rule.policy == TopPolicy::Stand) return slides ? SlideOff(upperF, lowerF, g, c.upperIsB, rule.slide, policy, env, others) : SlideOutcome{};
  if (rule.policy == TopPolicy::Slide) return SlideOff(upperF, lowerF, g, c.upperIsB, rule.slide, policy, env, others);
  if (rule.policy == TopPolicy::Bounce && closing >= rule.stompMin) {
    Bounce(upper, up, rule.bounceSpeed + (upper.jump != 0 ? rule.jumpBoost : 0));
    if (env.onContact) env.onContact(upper, lower, ContactEvent::Stomp);
    return SlideOutcome{};
  }
  return rule.policy == TopPolicy::Bounce ? SlideOff(upperF, lowerF, g, c.upperIsB, rule.slide, policy, env, others) : SlideOutcome{};
}

/** Whether a later pass runs a pair again: a side contact deeper than `slop`, or a stack at all. */
bool StillTouching(const std::optional<PairContact>& c, const ContactPolicy& policy) {
  return c && (c->depth > policy.slop || (c->kind == ContactKind::Top && c->depth > 0));
}

/** Whether seat `upper` stands on seat `lower`: their pair rule is `stand`, the lower seat's support can be stood
 *  on, and the upper seat let down by `groundTrace` meets the lower across the plane from above, within
 *  `supportCos` of its support up (resting there, never moving in). */
bool StandsOn(const PolicyBody& upper, PolicyBody& lower, const ContactPolicy& policy, const ContactEnv& env) {
  const TopRule& rule = TopRuleOf(policy, upper, lower);
  if (rule.policy != TopPolicy::Stand || !rule.ride) return false;
  const Frame fl = FrameOf(&lower, policy, env);
  if (fl.support[2] < policy.supportCos) return false;
  PolicyBody dropped = upper;
  dropped.z = upper.z - policy.groundTrace;
  const Frame fu = FrameOf(&dropped, policy, env);
  const std::optional<Geometry> g = GeometryOf(fl, fu);
  if (!g || !(Dot(g->across.n, g->plane) > 0)) return false;
  return Dot(g->across.n, fl.support) >= policy.supportCos;
}

/** Whether a seat's base stands on kinematic body `k`: inside its footprint, within `trace` over its top. */
bool OnKinematic(const PolicyBody& b, const KinematicSupport& k, double trace) {
  const double over = b.z - k.max[2];
  return b.x >= k.min[0] && b.x <= k.max[0] && b.y >= k.min[1] && b.y <= k.max[1] && over >= -trace && over <= trace;
}

/** What seat `b` stands on, from the seats and supports as they are. */
std::optional<Ride> RideOf(PolicyBody& b, std::vector<PolicyBody>& seats, const std::vector<KinematicSupport>& supports,
                           const ContactPolicy& policy, const ContactEnv& env, double tickHz) {
  for (const KinematicSupport& k : supports) {
    if (OnKinematic(b, k, policy.groundTrace)) return Ride{b.id, k.key, V3{k.dp[0] * tickHz, k.dp[1] * tickHz, 0}};
  }
  for (PolicyBody& o : seats) {
    if (&o != &b && StandsOn(b, o, policy, env)) return Ride{b.id, o.id, V3{o.vx, o.vy, 0}};
  }
  return std::nullopt;
}

}  // namespace

std::vector<std::string> TagsOf(const PolicyBody& b) {
  std::vector<std::string> tags = b.tags;
  for (int k = 0; k < 24; ++k) {
    if (std::fmod(std::floor(b.flags / std::ldexp(1.0, k)), 2.0) == 1.0) tags.push_back("flag:" + std::to_string(k));
  }
  return tags;
}

const TopRule& TopRuleOf(const ContactPolicy& policy, const PolicyBody& a, const PolicyBody& b) {
  if (policy.pairs.empty()) return policy.top;
  const std::vector<std::string> ta = TagsOf(a);
  const std::vector<std::string> tb = TagsOf(b);
  for (const PairRule& r : policy.pairs) {
    if ((HasTag(ta, r.a) && HasTag(tb, r.b)) || (HasTag(ta, r.b) && HasTag(tb, r.a))) return r.top;
  }
  return policy.top;
}

double HeadOffset(const PolicyBody& upper, const PolicyBody& lower, const ContactPolicy& policy) {
  const double dx = upper.x - lower.x;
  const double dy = upper.y - lower.y;
  const ContactShape& shape = policy.shape;
  if (shape.kind == ContactShapeKind::Hull) return JsMax(std::fabs(dx), std::fabs(dy)) / shape.radius;
  const presets::SinCos sc = presets::PSinCos(lower.yaw);
  return JsMax(std::fabs(dx * sc.cos + dy * sc.sin) / (shape.length / 2), std::fabs(dy * sc.cos - dx * sc.sin) / (shape.width / 2));
}

HeadHold HeadHoldOf(const PolicyBody& upper, const PolicyBody& lower, const TopRule& rule, const ContactPolicy& policy) {
  if (!rule.center) return HeadHold::Stand;
  const double u = HeadOffset(upper, lower, policy);
  if (u <= *rule.center) return HeadHold::Stand;
  const bool landing = lower.vz - upper.vz > kHeadLandingSpeed;
  if (landing) return HeadHold::Slide;
  if (LeavingOf(upper, lower, rule.ride) >= (rule.slide.step ? *rule.slide.step : rule.slide.speed) / 2) return HeadHold::Release;
  return u > 1 ? HeadHold::Slide : HeadHold::Stand;
}

bool HeadStands(const PolicyBody& upper, const PolicyBody& lower, const TopRule& rule, const ContactPolicy& policy) {
  return rule.policy == TopPolicy::Stand && HeadHoldOf(upper, lower, rule, policy) == HeadHold::Stand;
}

V3 SupportUpOf(const PolicyBody& b, const ContactPolicy& policy, const ContactEnv& env) { return SupportOf(b, policy, env); }

std::optional<PairContact> ContactOf(const PolicyBody& a, const PolicyBody& b, const ContactPolicy& policy, const ContactEnv& env) {
  if (FarApart(a, b, policy)) return std::nullopt;
  // Frames only read the seats here: a classification moves nothing.
  const Frame fa = FrameOf(const_cast<PolicyBody*>(&a), policy, env);
  const Frame fb = FrameOf(const_cast<PolicyBody*>(&b), policy, env);
  const std::optional<Found> found = ContactOfFrames(fa, fb, policy);
  if (!found) return std::nullopt;
  return found->contact;
}

std::pair<double, double> YieldShares(const PolicyBody& a, const PolicyBody& b, const V3& n, double depth, const ContactWorld* world,
                                      const Rides* ridesA, const Rides* ridesB, const V3& upA, const V3& upB, double wantA) {
  if (world == nullptr) return {wantA, 1 - wantA};
  const SeatWay wa = SeatWayAt(*world, BaseOf(a), Neg(n), depth, ridesA, upA);
  const SeatWay wb = SeatWayAt(*world, BaseOf(b), n, depth, ridesB, upB);
  return SharesOf(wa.sep / depth, wb.sep / depth, wantA);
}

std::optional<PairOutcome> ContactPair(PolicyBody& a, PolicyBody& b, const ContactPolicy& policy, const ContactEnv& env, bool cooling,
                                       const std::vector<PolicyBody*>* others) {
  const TopRule& rule = TopRuleOf(policy, a, b);
  if (rule.policy == TopPolicy::Ghost || FarApart(a, b, policy)) return std::nullopt;
  const Frame fa = FrameOf(&a, policy, env);
  const Frame fb = FrameOf(&b, policy, env);
  const std::optional<Found> found = ContactOfFrames(fa, fb, policy);
  if (!found) return std::nullopt;
  PairOutcome out;
  static_cast<PairContact&>(out) = found->contact;
  if (found->contact.kind == ContactKind::Side) {
    const SideResult side = SideContact(fa, fb, found->contact, found->axisIndex, found->g, policy, env, cooling);
    out.j = side.j;
    out.n = side.n;
    out.depth = side.depth;
    return out;
  }
  static const std::vector<PolicyBody*> none;
  const SlideOutcome top = TopContact(fa, fb, found->contact, found->g, rule, policy, env, others != nullptr ? *others : none);
  out.j = top.j;
  out.way = top.way;
  out.w = top.w;
  return out;
}

ContactReport ContactPass(std::vector<PolicyBody>& seats, const ContactPolicy& policy, const ContactEnv& env) {
  ContactReport report;
  std::vector<PolicyBody*> all;
  for (PolicyBody& s : seats) all.push_back(&s);
  for (int pass = 0; pass < policy.passes; ++pass) {
    bool touched = false;
    for (std::size_t i = 0; i < seats.size(); ++i) {
      for (std::size_t k = i + 1; k < seats.size(); ++k) {
        PolicyBody& a = seats[i];
        PolicyBody& b = seats[k];
        if (pass > 0 && !StillTouching(ContactOf(a, b, policy, env), policy)) continue;
        const std::optional<PairOutcome> out = ContactPair(a, b, policy, env, false, &all);
        if (!out) continue;
        touched = true;
        if (out->way == SlideWay::Pinned) report.pinned += 1;
      }
    }
    if (!touched) break;
    report.passes += 1;
    if (env.world == nullptr) continue;
    for (PolicyBody& seat : seats) {
      const auto wall = [&](const std::array<double, 4>& face) {
        const auto known = report.walls.find(seat.id);
        if (face[2] < policy.supportCos && face[3] > (known == report.walls.end() ? 0.0 : known->second)) report.walls[seat.id] = face[3];
      };
      const double depth = UnstickBody(*env.world, &seat.x, &seat.y, &seat.z, wall);
      const auto known = report.pushed.find(seat.id);
      if (depth > (known == report.pushed.end() ? 0.0 : known->second)) report.pushed[seat.id] = depth;
    }
  }
  return report;
}

std::vector<Ride> RideStep(std::vector<PolicyBody>& seats, const std::vector<KinematicSupport>& supports, const ContactPolicy& policy,
                           const ContactEnv& env, double tickHz) {
  std::vector<PolicyBody> before = seats;
  std::vector<Ride> rides;
  for (std::size_t i = 0; i < seats.size(); ++i) {
    const std::optional<Ride> ride = RideOf(before[i], before, supports, policy, env, tickHz);
    if (!ride) continue;
    PolicyBody& seat = seats[i];
    seat.x += ride->v[0] / tickHz;
    seat.y += ride->v[1] / tickHz;
    if (seat.vz > 0) {
      seat.vx += ride->v[0];
      seat.vy += ride->v[1];
    }
    rides.push_back(*ride);
  }
  return rides;
}

}  // namespace genex::contact

GENEX_FP_STRICT_END
