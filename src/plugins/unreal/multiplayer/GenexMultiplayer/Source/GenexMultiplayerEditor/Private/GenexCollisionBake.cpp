#include "GenexCollisionBake.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <limits>
#include <map>
#include <string>
#include <tuple>
#include <utility>

namespace genex::collision_bake_detail {

using collision_bake::ActorGeometry;
using collision_bake::ActorReport;
using collision_bake::BakeOptions;
using collision_bake::BoundsRule;
using collision_bake::ConvexHull;
using collision_bake::OrientedBox;
using collision_bake::SkipReason;
using collision_bake::TriangleMesh;
using collision_bake::Vec3;

constexpr double kInfinity = std::numeric_limits<double>::infinity();
/** Points and faces this close are one: float noise in a mesh or a rotation, far below anything a player can feel. */
constexpr double kWeldCm = 0.01;
/** An open surface becomes a plate this thick behind its faces (or maxErrorCm, when that is thinner). */
constexpr double kPlateCm = 1.0;
/** Below this area a triangle or a clipped piece of one has no surface. */
constexpr double kMinArea = 1e-7;
/** A point this far past a plane still counts as on it. */
constexpr double kInsideSlack = 1e-6;
/** §17.7's largest value, in Genex units. */
constexpr double kMaxGenex = 1e9;
constexpr std::size_t kMaxHullPoints = 512;
/** Steeper than this a top is a leaning wall, not a ramp (normal z, about 78 degrees). */
constexpr double kMinRampNormalZ = 0.2;
/** A top face must carry this share of a solid's footprint to be its ramp. */
constexpr double kMinRampFootprint = 0.5;
constexpr int kMaxRampStrips = 64;
constexpr int kMaxRampSegments = 64;
/** A ramp's flat bottom may hang below the source by this share of maxErrorCm. */
constexpr double kRampHang = 0.9;
/** Steps of the search for the widest slice that stays inside maxErrorCm. */
constexpr int kSliceSearchSteps = 12;
/** A slice thinner than this is no progress: the box is cut instead, so the search can never shave a solid away. */
constexpr double kMinSliceCm = 4.0 * kWeldCm;
constexpr int kMaxDepth = 64;
/** Refinement steps per allowed box before an actor counts as over budget. */
constexpr int kStepsPerBox = 64;
/** tris x vertices past this skips the convexity test (the general path is always correct). */
constexpr double kMaxConvexWork = 5e7;
constexpr int kReportedActors = 10;
/** Steps per engine unit that output values land on: far under float32's reach at any useful coordinate. */
constexpr double kDenoise = 1e6;

inline double At(const Vec3& v, int axis) {
  if (axis == 0) return v.x;
  return axis == 1 ? v.y : v.z;
}
inline void SetAt(Vec3& v, int axis, double value) {
  if (axis == 0) v.x = value;
  else if (axis == 1) v.y = value;
  else v.z = value;
}
inline Vec3 Plus(const Vec3& a, const Vec3& b) { return Vec3{a.x + b.x, a.y + b.y, a.z + b.z}; }
inline Vec3 Minus(const Vec3& a, const Vec3& b) { return Vec3{a.x - b.x, a.y - b.y, a.z - b.z}; }
inline Vec3 Times(const Vec3& a, double s) { return Vec3{a.x * s, a.y * s, a.z * s}; }
inline double DotOf(const Vec3& a, const Vec3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline Vec3 CrossOf(const Vec3& a, const Vec3& b) {
  return Vec3{a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}
inline double LengthOf(const Vec3& a) { return std::sqrt(DotOf(a, a)); }

struct Aabb {
  std::array<double, 3> lo{kInfinity, kInfinity, kInfinity};
  std::array<double, 3> hi{-kInfinity, -kInfinity, -kInfinity};

  void Add(const Vec3& p) {
    for (int a = 0; a < 3; ++a) {
      const std::size_t i = static_cast<std::size_t>(a);
      lo[i] = (std::min)(lo[i], At(p, a));
      hi[i] = (std::max)(hi[i], At(p, a));
    }
  }
  double Size(int axis) const { return hi[static_cast<std::size_t>(axis)] - lo[static_cast<std::size_t>(axis)]; }
  bool Empty() const { return lo[0] > hi[0]; }
  /** Thinner than a weld on some axis: no volume to speak of. */
  bool Thin() const { return Empty() || Size(0) < kWeldCm || Size(1) < kWeldCm || Size(2) < kWeldCm; }
  double Diagonal() const { return std::sqrt(Size(0) * Size(0) + Size(1) * Size(1) + Size(2) * Size(2)); }
  Vec3 Center() const { return Vec3{(lo[0] + hi[0]) * 0.5, (lo[1] + hi[1]) * 0.5, (lo[2] + hi[2]) * 0.5}; }
  Vec3 Corner(int i) const {
    return Vec3{(i & 1) != 0 ? hi[0] : lo[0], (i & 2) != 0 ? hi[1] : lo[1], (i & 4) != 0 ? hi[2] : lo[2]};
  }
  /** The part at or below `value` on `axis`, and the part at or above it. */
  Aabb Below(int axis, double value) const {
    Aabb part = *this;
    part.hi[static_cast<std::size_t>(axis)] = value;
    return part;
  }
  Aabb Above(int axis, double value) const {
    Aabb part = *this;
    part.lo[static_cast<std::size_t>(axis)] = value;
    return part;
  }
};

struct Plane {
  Vec3 normal;
  double offset = 0.0;
  double Signed(const Vec3& p) const { return DotOf(normal, p) - offset; }
};

/** A triangle with its outward plane. */
struct Tri {
  Vec3 a, b, c;
  Plane plane;
};

inline double AreaOf(const Vec3& a, const Vec3& b, const Vec3& c) { return 0.5 * LengthOf(CrossOf(Minus(b, a), Minus(c, a))); }

Tri MakeTri(const Vec3& a, const Vec3& b, const Vec3& c) {
  Tri t{a, b, c, Plane{}};
  const Vec3 n = CrossOf(Minus(b, a), Minus(c, a));
  const double length = LengthOf(n);
  t.plane.normal = length > 0.0 ? Times(n, 1.0 / length) : Vec3{};
  t.plane.offset = DotOf(t.plane.normal, a);
  return t;
}

using Poly = std::vector<Vec3>;

/** Sutherland-Hodgman against one axis plane. */
void ClipHalf(Poly& poly, int axis, double bound, bool keepBelow, Poly& scratch) {
  scratch.clear();
  const std::size_t count = poly.size();
  const double sign = keepBelow ? 1.0 : -1.0;
  for (std::size_t i = 0; i < count; ++i) {
    const Vec3& from = poly[i];
    const Vec3& to = poly[(i + 1) % count];
    const double dFrom = sign * (At(from, axis) - bound);
    const double dTo = sign * (At(to, axis) - bound);
    if (dFrom <= 0.0) scratch.push_back(from);
    if ((dFrom < 0.0 && dTo > 0.0) || (dFrom > 0.0 && dTo < 0.0)) {
      Vec3 cut = Plus(from, Times(Minus(to, from), dFrom / (dFrom - dTo)));
      SetAt(cut, axis, bound);
      scratch.push_back(cut);
    }
  }
  poly.swap(scratch);
}

/** A triangle's part inside `region`, empty when that has no area. */
Poly ClipTriangle(const Tri& t, const Aabb& region, Poly& scratch) {
  Poly poly{t.a, t.b, t.c};
  for (int axis = 0; axis < 3 && !poly.empty(); ++axis) {
    ClipHalf(poly, axis, region.hi[static_cast<std::size_t>(axis)], true, scratch);
    if (!poly.empty()) ClipHalf(poly, axis, region.lo[static_cast<std::size_t>(axis)], false, scratch);
  }
  if (poly.size() < 3) return Poly{};
  Vec3 sum;
  for (std::size_t i = 1; i + 1 < poly.size(); ++i) sum = Plus(sum, CrossOf(Minus(poly[i], poly[0]), Minus(poly[i + 1], poly[0])));
  if (0.5 * LengthOf(sum) < kMinArea) return Poly{};
  return poly;
}

/** Closest point on a triangle (Ericson, Real-Time Collision Detection 5.1.5), as a distance. */
double DistanceToTriangle(const Vec3& p, const Vec3& a, const Vec3& b, const Vec3& c) {
  const Vec3 ab = Minus(b, a);
  const Vec3 ac = Minus(c, a);
  const Vec3 ap = Minus(p, a);
  const double d1 = DotOf(ab, ap);
  const double d2 = DotOf(ac, ap);
  if (d1 <= 0.0 && d2 <= 0.0) return LengthOf(ap);
  const Vec3 bp = Minus(p, b);
  const double d3 = DotOf(ab, bp);
  const double d4 = DotOf(ac, bp);
  if (d3 >= 0.0 && d4 <= d3) return LengthOf(bp);
  const double vc = d1 * d4 - d3 * d2;
  if (vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0) return LengthOf(Minus(ap, Times(ab, d1 / (d1 - d3))));
  const Vec3 cp = Minus(p, c);
  const double d5 = DotOf(ab, cp);
  const double d6 = DotOf(ac, cp);
  if (d6 >= 0.0 && d5 <= d6) return LengthOf(cp);
  const double vb = d5 * d2 - d1 * d6;
  if (vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0) return LengthOf(Minus(ap, Times(ac, d2 / (d2 - d6))));
  const double va = d3 * d6 - d5 * d4;
  if (va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0) {
    return LengthOf(Minus(bp, Times(Minus(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6)))));
  }
  const double scale = 1.0 / (va + vb + vc);
  return LengthOf(Minus(ap, Plus(Times(ab, vb * scale), Times(ac, vc * scale))));
}

struct RampSolid {
  Aabb box;
  int axis = 0;
  double low = 0.0;
  double high = 0.0;
};

/** What one actor has baked so far, against its budget. */
struct ActorBake {
  double maxError = 0.0;
  int maxBoxes = 0;
  int maxRamps = 0;
  /** The least error of what is being emitted: a plate's thickness behind an open surface. */
  double floorError = 0.0;
  std::vector<Aabb> boxes;
  /** Each box's own distance from the source: what room it has left to grow by a float32 step. */
  std::vector<double> boxErrors;
  std::vector<RampSolid> ramps;
  double worst = 0.0;
  /** How far boxes of a BoundsRule reach from their source; never part of `worst`. */
  double boundsError = 0.0;
  int widened = 0;
  int steps = 0;
  int dropped = 0;
  bool over = false;

  void Emit(const Aabb& box, double error) {
    PushBox(box, (std::max)(error, floorError));
    worst = (std::max)(worst, boxErrors.back());
  }
  /** A box the game asked for by name: the budget still holds, the contract's error does not count it. */
  void EmitBounds(const Aabb& box, double reach) {
    PushBox(box, 0.0);
    boundsError = (std::max)(boundsError, reach);
  }
  void PushBox(const Aabb& box, double error) {
    boxes.push_back(box);
    boxErrors.push_back(error);
    if (static_cast<int>(boxes.size()) > maxBoxes) over = true;
  }
  /** One more refinement step; false once the actor is over budget. */
  bool Step() {
    steps += 1;
    if (steps > maxBoxes * kStepsPerBox) over = true;
    return !over;
  }
};

/** A convex solid: outward triangles and the planes they lie on. */
struct Convex {
  std::vector<Tri> tris;
  std::vector<int> triPlane;
  std::vector<Plane> planes;
  Aabb bounds;

  bool Inside(const Vec3& p) const {
    for (const Plane& plane : planes) {
      if (plane.Signed(p) > kInsideSlack) return false;
    }
    return true;
  }
  double Distance(const Vec3& p) const {
    if (Inside(p)) return 0.0;
    double best = kInfinity;
    for (const Tri& t : tris) best = (std::min)(best, DistanceToTriangle(p, t.a, t.b, t.c));
    return best;
  }
  /** The largest distance from any point of `box` to the solid: distance to a convex set is convex, so a corner's. */
  double ErrorOf(const Aabb& box) const {
    double worst = 0.0;
    for (int i = 0; i < 8; ++i) worst = (std::max)(worst, Distance(box.Corner(i)));
    return worst;
  }
  /** The bounds of the solid's part in `region`. */
  Aabb Tight(const Aabb& region) const {
    Aabb tight;
    Poly scratch;
    for (const Tri& t : tris) {
      for (const Vec3& p : ClipTriangle(t, region, scratch)) tight.Add(p);
    }
    for (int i = 0; i < 8; ++i) {
      if (Inside(region.Corner(i))) tight.Add(region.Corner(i));
    }
    return tight;
  }
};

Convex MakeConvex(std::vector<Tri> tris) {
  Convex shape;
  shape.tris = std::move(tris);
  shape.triPlane.reserve(shape.tris.size());
  for (const Tri& t : shape.tris) {
    shape.bounds.Add(t.a);
    shape.bounds.Add(t.b);
    shape.bounds.Add(t.c);
    int found = -1;
    for (std::size_t i = 0; i < shape.planes.size() && found < 0; ++i) {
      const Plane& p = shape.planes[i];
      if (DotOf(p.normal, t.plane.normal) > 1.0 - 1e-9 && std::fabs(p.offset - t.plane.offset) <= kWeldCm) found = static_cast<int>(i);
    }
    if (found < 0) {
      found = static_cast<int>(shape.planes.size());
      shape.planes.push_back(t.plane);
    }
    shape.triPlane.push_back(found);
  }
  return shape;
}

/** Every triangle flat on some axis, so the convex solid is its bounds, exactly. */
bool IsAxisAligned(const Convex& shape) {
  for (const Tri& t : shape.tris) {
    Aabb box;
    box.Add(t.a);
    box.Add(t.b);
    box.Add(t.c);
    if (box.Size(0) > kWeldCm && box.Size(1) > kWeldCm && box.Size(2) > kWeldCm) return false;
  }
  return true;
}

/** The largest prefix of `box` along `axis` whose tight part stays inside maxError; its upper bound, or NaN. */
double WidestSlice(const Convex& shape, const Aabb& box, int axis, double maxError) {
  const std::size_t i = static_cast<std::size_t>(axis);
  double pass = box.lo[i];
  double fail = box.hi[i];
  for (int step = 0; step < kSliceSearchSteps; ++step) {
    const double middle = (pass + fail) * 0.5;
    const Aabb tight = shape.Tight(box.Below(axis, middle));
    if (tight.Empty() || shape.ErrorOf(tight) <= maxError) pass = middle;
    else fail = middle;
  }
  return pass - box.lo[i] >= kMinSliceCm ? pass : std::numeric_limits<double>::quiet_NaN();
}

/** The worse half when `box` is cut in the middle of `axis`. */
double SplitError(const Convex& shape, const Aabb& box, int axis) {
  const double middle = (box.lo[static_cast<std::size_t>(axis)] + box.hi[static_cast<std::size_t>(axis)]) * 0.5;
  const Aabb below = shape.Tight(box.Below(axis, middle));
  const Aabb above = shape.Tight(box.Above(axis, middle));
  return (std::max)(below.Thin() ? 0.0 : shape.ErrorOf(below), above.Thin() ? 0.0 : shape.ErrorOf(above));
}

/** Covers the solid's part in `start` with boxes inside maxError: the widest slice that fits, along the axis that
 *  takes the most, and a cut in the middle only when no slice fits. A slice follows a turned wall's whole cross
 *  section, so a wall costs one box per step, never a grid of them. */
void RefineConvex(const Convex& shape, const Aabb& start, ActorBake& bake) {
  std::vector<Aabb> work{start};
  while (!work.empty() && !bake.over) {
    const Aabb region = work.back();
    work.pop_back();
    const Aabb box = shape.Tight(region);
    if (box.Thin()) continue;
    const double error = shape.ErrorOf(box);
    if (error <= bake.maxError) {
      bake.Emit(box, error);
      continue;
    }
    if (!bake.Step()) return;
    int bestAxis = -1;
    double bestAt = 0.0;
    double bestShare = 0.0;
    for (int axis = 0; axis < 3; ++axis) {
      if (box.Size(axis) < kWeldCm) continue;
      const double at = WidestSlice(shape, box, axis, bake.maxError);
      if (std::isnan(at)) continue;
      const double share = (at - box.lo[static_cast<std::size_t>(axis)]) / box.Size(axis);
      if (share > bestShare) {
        bestShare = share;
        bestAxis = axis;
        bestAt = at;
      }
    }
    if (bestAxis >= 0) {
      const Aabb slice = shape.Tight(box.Below(bestAxis, bestAt));
      if (!slice.Empty()) bake.Emit(slice, shape.ErrorOf(slice));
      work.push_back(box.Above(bestAxis, bestAt));
      continue;
    }
    int cutAxis = 0;
    double cutError = kInfinity;
    for (int axis = 0; axis < 3; ++axis) {
      if (box.Size(axis) < kWeldCm) continue;
      const double splitError = SplitError(shape, box, axis);
      if (splitError < cutError) {
        cutError = splitError;
        cutAxis = axis;
      }
    }
    const double middle = (box.lo[static_cast<std::size_t>(cutAxis)] + box.hi[static_cast<std::size_t>(cutAxis)]) * 0.5;
    work.push_back(box.Below(cutAxis, middle));
    work.push_back(box.Above(cutAxis, middle));
  }
}

/** The sloped top a convex solid can ride: z = slope[0]·x + slope[1]·y + base over `face`. */
struct TopFace {
  std::array<double, 2> slope{0.0, 0.0};
  double base = 0.0;
  std::vector<Tri> tris;
  Aabb face;
  double ZAt(double x, double y) const { return slope[0] * x + slope[1] * y + base; }
};

bool FindTop(const Convex& shape, TopFace& top) {
  std::vector<double> area(shape.planes.size(), 0.0);
  double footprint = 0.0;
  for (std::size_t i = 0; i < shape.tris.size(); ++i) {
    const Tri& t = shape.tris[i];
    const double up = t.plane.normal.z;
    if (up <= 0.0) continue;
    const double projected = AreaOf(t.a, t.b, t.c) * up;
    footprint += projected;
    area[static_cast<std::size_t>(shape.triPlane[i])] += projected;
  }
  int best = -1;
  for (std::size_t i = 0; i < area.size(); ++i) {
    const double up = shape.planes[i].normal.z;
    if (up < kMinRampNormalZ || up > 1.0 - 1e-9) continue;
    if (best < 0 || area[i] > area[static_cast<std::size_t>(best)]) best = static_cast<int>(i);
  }
  if (best < 0 || area[static_cast<std::size_t>(best)] < kMinRampFootprint * footprint) return false;
  const Plane& plane = shape.planes[static_cast<std::size_t>(best)];
  top.slope = {-plane.normal.x / plane.normal.z, -plane.normal.y / plane.normal.z};
  top.base = plane.offset / plane.normal.z;
  for (std::size_t i = 0; i < shape.tris.size(); ++i) {
    if (shape.triPlane[i] != best) continue;
    top.tris.push_back(shape.tris[i]);
    top.face.Add(shape.tris[i].a);
    top.face.Add(shape.tris[i].b);
    top.face.Add(shape.tris[i].c);
  }
  return true;
}

/** The solid's underside at (x, y): the highest of its downward planes there. */
double UndersideAt(const Convex& shape, double x, double y) {
  double under = -kInfinity;
  for (const Plane& plane : shape.planes) {
    if (plane.normal.z >= -1e-9) continue;
    under = (std::max)(under, (plane.offset - plane.normal.x * x - plane.normal.y * y) / plane.normal.z);
  }
  return under;
}

/** The ramps and leftovers of one way to cut a solid. */
struct RampPlan {
  std::vector<RampSolid> ramps;
  std::vector<Aabb> leftovers;
  double worst = 0.0;
};

/** A ramp over [from, to] of `axis`, across `strip` on the other axis, its top `raise` above the plane along `axis`.
 *  Its bottom is the underside's high point, so it stays inside the solid, and never above its own low end. */
RampSolid RampOver(const Convex& shape, const TopFace& top, int axis, double from, double to, const std::array<double, 2>& strip, double raise) {
  const int cross = 1 - axis;
  const double slope = top.slope[static_cast<std::size_t>(axis)];
  RampSolid ramp;
  ramp.axis = axis;
  ramp.low = slope * from + raise;
  ramp.high = slope * to + raise;
  double under = -kInfinity;
  for (int i = 0; i < 4; ++i) {
    const double along = (i & 1) != 0 ? to : from;
    const double across = (i & 2) != 0 ? strip[1] : strip[0];
    under = (std::max)(under, axis == 0 ? UndersideAt(shape, along, across) : UndersideAt(shape, across, along));
  }
  const double lowest = (std::min)(ramp.low, ramp.high);
  const std::size_t a = static_cast<std::size_t>(axis);
  const std::size_t c = static_cast<std::size_t>(cross);
  ramp.box.lo[a] = from;
  ramp.box.hi[a] = to;
  ramp.box.lo[c] = strip[0];
  ramp.box.hi[c] = strip[1];
  ramp.box.lo[2] = (std::min)(under, lowest);
  ramp.box.hi[2] = (std::max)(ramp.low, ramp.high);
  return ramp;
}

/** How far the ramp's body hangs under the solid at its worst: the part its flat bottom cannot follow. */
double RampHang(const Convex& shape, const RampSolid& ramp) {
  double worst = 0.0;
  for (int i = 0; i < 4; ++i) {
    const double x = ramp.box.lo[0] + ((i & 1) != 0 ? ramp.box.Size(0) : 0.0);
    const double y = ramp.box.lo[1] + ((i & 2) != 0 ? ramp.box.Size(1) : 0.0);
    worst = (std::max)(worst, UndersideAt(shape, x, y) - ramp.box.lo[2]);
  }
  return worst;
}

/** The largest distance from the ramp's body to the solid, at its eight corners. */
double RampError(const Convex& shape, const RampSolid& ramp) {
  double worst = 0.0;
  const std::size_t a = static_cast<std::size_t>(ramp.axis);
  const double span = ramp.box.hi[a] - ramp.box.lo[a];
  for (int i = 0; i < 8; ++i) {
    Vec3 corner = ramp.box.Corner(i);
    if ((i & 4) != 0) corner.z = ramp.low + (ramp.high - ramp.low) * (At(corner, ramp.axis) - ramp.box.lo[a]) / span;
    worst = (std::max)(worst, shape.Distance(corner));
  }
  return worst;
}

/** One strip of a top face: as few ramps as keep the flat bottoms hanging within reach, and what is left under and
 *  beside them. False when no count of segments does. */
bool PlanStrip(const Convex& shape, const TopFace& top, int axis, const std::array<double, 2>& strip, double maxError, Aabb stripRegion, RampPlan& plan) {
  const int cross = 1 - axis;
  const std::size_t a = static_cast<std::size_t>(axis);
  Aabb across;
  Poly scratch;
  Aabb clip = top.face;
  clip.lo[static_cast<std::size_t>(cross)] = strip[0];
  clip.hi[static_cast<std::size_t>(cross)] = strip[1];
  for (const Tri& t : top.tris) {
    for (const Vec3& p : ClipTriangle(t, clip, scratch)) across.Add(p);
  }
  if (across.Empty()) {
    plan.leftovers.push_back(stripRegion);
    return true;
  }
  const double from = across.lo[a];
  const double to = across.hi[a];
  const double crossSlope = top.slope[static_cast<std::size_t>(cross)];
  const double raise = top.base + (std::max)(crossSlope * strip[0], crossSlope * strip[1]);
  for (int segments = 1; segments <= kMaxRampSegments; ++segments) {
    std::vector<RampSolid> ramps;
    bool fits = true;
    for (int i = 0; i < segments && fits; ++i) {
      const double start = from + (to - from) * i / segments;
      const double end = from + (to - from) * (i + 1) / segments;
      ramps.push_back(RampOver(shape, top, axis, start, end, strip, raise));
      fits = RampHang(shape, ramps.back()) <= kRampHang * maxError;
    }
    if (!fits) continue;
    for (const RampSolid& ramp : ramps) {
      const double error = RampError(shape, ramp);
      if (error > maxError) return false;
      plan.worst = (std::max)(plan.worst, error);
      plan.ramps.push_back(ramp);
      Aabb under = stripRegion;
      under.lo[a] = ramp.box.lo[a];
      under.hi[a] = ramp.box.hi[a];
      under.hi[2] = ramp.box.lo[2];
      plan.leftovers.push_back(under);
    }
    plan.leftovers.push_back(stripRegion.Below(axis, from));
    plan.leftovers.push_back(stripRegion.Above(axis, to));
    return true;
  }
  return false;
}

/** Rides the solid's top with ramps along its steeper axis, in `strips` strips across the other (one, for a slope on
 *  a single axis), leaving the rest of the solid for boxes. */
bool PlanRamps(const Convex& shape, const TopFace& top, int strips, double maxError, RampPlan& plan) {
  const int axis = std::fabs(top.slope[0]) >= std::fabs(top.slope[1]) ? 0 : 1;
  const int cross = 1 - axis;
  const std::size_t c = static_cast<std::size_t>(cross);
  const double start = top.face.lo[c];
  const double end = top.face.hi[c];
  plan.leftovers.push_back(shape.bounds.Below(cross, start));
  plan.leftovers.push_back(shape.bounds.Above(cross, end));
  for (int i = 0; i < strips; ++i) {
    const std::array<double, 2> strip{start + (end - start) * i / strips, start + (end - start) * (i + 1) / strips};
    Aabb region = shape.bounds;
    region.lo[c] = strip[0];
    region.hi[c] = strip[1];
    if (!PlanStrip(shape, top, axis, strip, maxError, region, plan)) return false;
  }
  return true;
}

bool TryRamps(const Convex& shape, ActorBake& bake) {
  TopFace top;
  if (!FindTop(shape, top)) return false;
  for (int strips = 1; strips <= kMaxRampStrips; strips *= 2) {
    RampPlan plan;
    if (!PlanRamps(shape, top, strips, bake.maxError, plan)) continue;
    if (static_cast<int>(bake.ramps.size() + plan.ramps.size()) > bake.maxRamps) return false;
    bake.ramps.insert(bake.ramps.end(), plan.ramps.begin(), plan.ramps.end());
    bake.worst = (std::max)(bake.worst, plan.worst);
    for (const Aabb& leftover : plan.leftovers) RefineConvex(shape, leftover, bake);
    return true;
  }
  return false;
}

void BakeConvex(const Convex& shape, ActorBake& bake) {
  if (shape.bounds.Thin()) return;
  if (IsAxisAligned(shape)) {
    bake.Emit(shape.bounds, 0.0);
    return;
  }
  const double error = shape.ErrorOf(shape.bounds);
  if (error <= bake.maxError) {
    bake.Emit(shape.bounds, error);
    return;
  }
  if (TryRamps(shape, bake)) return;
  RefineConvex(shape, shape.bounds, bake);
}

/** A closed solid that is not convex, with an inside test by parity along +z through a grid of its triangles. */
struct Soup {
  std::vector<Tri> tris;
  Aabb bounds;
  int cellsPerSide = 1;
  std::vector<std::vector<int>> cells;

  int CellOf(double value, int axis) const {
    const double size = bounds.Size(axis);
    if (size <= 0.0) return 0;
    const int cell = static_cast<int>((value - bounds.lo[static_cast<std::size_t>(axis)]) / size * cellsPerSide);
    return (std::min)((std::max)(cell, 0), cellsPerSide - 1);
  }
  bool Inside(const Vec3& p) const {
    // Off the grid lines a mesh's edges tend to lie on, so a ray never meets one exactly.
    const double x = p.x + 1.37e-4;
    const double y = p.y + 2.11e-4;
    const std::vector<int>& cell = cells[static_cast<std::size_t>(CellOf(y, 1) * cellsPerSide + CellOf(x, 0))];
    bool inside = false;
    for (const int index : cell) {
      const Tri& t = tris[static_cast<std::size_t>(index)];
      const double d = (t.b.x - t.a.x) * (t.c.y - t.a.y) - (t.c.x - t.a.x) * (t.b.y - t.a.y);
      if (std::fabs(d) < 1e-12) continue;
      const double u = ((x - t.a.x) * (t.c.y - t.a.y) - (t.c.x - t.a.x) * (y - t.a.y)) / d;
      const double v = ((t.b.x - t.a.x) * (y - t.a.y) - (x - t.a.x) * (t.b.y - t.a.y)) / d;
      if (u < 0.0 || v < 0.0 || u + v > 1.0) continue;
      if (t.a.z + u * (t.b.z - t.a.z) + v * (t.c.z - t.a.z) > p.z) inside = !inside;
    }
    return inside;
  }
};

Soup MakeSoup(std::vector<Tri> tris) {
  Soup soup;
  soup.tris = std::move(tris);
  for (const Tri& t : soup.tris) {
    soup.bounds.Add(t.a);
    soup.bounds.Add(t.b);
    soup.bounds.Add(t.c);
  }
  soup.cellsPerSide = (std::min)(256, (std::max)(1, static_cast<int>(std::sqrt(static_cast<double>(soup.tris.size())))));
  soup.cells.resize(static_cast<std::size_t>(soup.cellsPerSide * soup.cellsPerSide));
  for (std::size_t i = 0; i < soup.tris.size(); ++i) {
    const Tri& t = soup.tris[i];
    Aabb box;
    box.Add(t.a);
    box.Add(t.b);
    box.Add(t.c);
    for (int y = soup.CellOf(box.lo[1], 1); y <= soup.CellOf(box.hi[1], 1); ++y) {
      for (int x = soup.CellOf(box.lo[0], 0); x <= soup.CellOf(box.hi[0], 0); ++x) {
        soup.cells[static_cast<std::size_t>(y * soup.cellsPerSide + x)].push_back(static_cast<int>(i));
      }
    }
  }
  return soup;
}

/** A triangle's part in a region. */
struct Patch {
  Poly points;
  int tri = 0;
};

bool OnFace(const Patch& patch, const Aabb& box) {
  for (int axis = 0; axis < 3; ++axis) {
    const std::size_t i = static_cast<std::size_t>(axis);
    bool onLow = true;
    bool onHigh = true;
    for (const Vec3& p : patch.points) {
      onLow = onLow && std::fabs(At(p, axis) - box.lo[i]) <= kWeldCm;
      onHigh = onHigh && std::fabs(At(p, axis) - box.hi[i]) <= kWeldCm;
    }
    if (onLow || onHigh) return true;
  }
  return false;
}

/** The axis-aligned face crossing `box` with the most area: a cut there follows the source exactly. */
bool FindFaceCut(const std::vector<const Patch*>& inner, const Aabb& box, int& axis, double& at) {
  double bestArea = 0.0;
  for (const Patch* patch : inner) {
    Aabb extent;
    for (const Vec3& p : patch->points) extent.Add(p);
    for (int a = 0; a < 3; ++a) {
      const std::size_t i = static_cast<std::size_t>(a);
      if (extent.Size(a) > kWeldCm) continue;
      const double value = extent.lo[i];
      if (value <= box.lo[i] + kWeldCm || value >= box.hi[i] - kWeldCm) continue;
      const double area = extent.Size((a + 1) % 3) * extent.Size((a + 2) % 3);
      if (area > bestArea) {
        bestArea = area;
        axis = a;
        at = value;
      }
    }
  }
  return bestArea > 0.0;
}

/** Whether the surface in a box bends only outward, so the solid's part there is convex. */
bool BendsOutward(const Soup& soup, const std::vector<Patch>& patches) {
  for (const Patch& a : patches) {
    const Plane& plane = soup.tris[static_cast<std::size_t>(a.tri)].plane;
    for (const Patch& b : patches) {
      for (const Vec3& p : b.points) {
        if (plane.Signed(p) > kWeldCm) return false;
      }
    }
  }
  return true;
}

/** The solid's part in `box` when that is convex: the surface there, cut off by the box's own faces. */
Convex LocalConvex(const Soup& soup, const std::vector<Patch>& patches, const Aabb& box) {
  std::vector<Tri> tris;
  for (const Patch& patch : patches) {
    const Tri& source = soup.tris[static_cast<std::size_t>(patch.tri)];
    for (std::size_t k = 1; k + 1 < patch.points.size(); ++k) {
      if (AreaOf(patch.points[0], patch.points[k], patch.points[k + 1]) < kMinArea) continue;
      tris.push_back(Tri{patch.points[0], patch.points[k], patch.points[k + 1], source.plane});
    }
  }
  Convex local = MakeConvex(std::move(tris));
  local.bounds = box;
  for (std::size_t i = 0; i < 3; ++i) {
    Vec3 axis;
    SetAt(axis, static_cast<int>(i), 1.0);
    local.planes.push_back(Plane{axis, box.hi[i]});
    local.planes.push_back(Plane{Times(axis, -1.0), -box.lo[i]});
  }
  return local;
}

/** Covers a closed solid's part in `region`: a region the surface does not cross is all solid or all empty, a cut
 *  follows any axis-aligned face (so a doorway in a straight wall stays exact), and a box is kept only when its part
 *  is convex (then it refines as a convex solid), or the box is small enough that it cannot be further than that from the surface. */
void RefineSoup(const Soup& soup, const Aabb& region, const std::vector<int>& candidates, int depth, ActorBake& bake) {
  if (!bake.Step()) return;
  std::vector<Patch> patches;
  std::vector<int> kept;
  Poly scratch;
  for (const int index : candidates) {
    Poly points = ClipTriangle(soup.tris[static_cast<std::size_t>(index)], region, scratch);
    if (points.empty()) continue;
    patches.push_back(Patch{std::move(points), index});
    kept.push_back(index);
  }
  if (patches.empty()) {
    if (soup.Inside(region.Center())) bake.Emit(region, 0.0);
    return;
  }
  Aabb box;
  for (const Patch& patch : patches) {
    for (const Vec3& p : patch.points) box.Add(p);
  }
  for (int i = 0; i < 8; ++i) {
    if (soup.Inside(region.Corner(i))) box.Add(region.Corner(i));
  }
  if (box.Thin()) return;
  std::vector<const Patch*> inner;
  for (const Patch& patch : patches) {
    if (!OnFace(patch, box)) inner.push_back(&patch);
  }
  if (inner.empty()) {
    if (soup.Inside(box.Center())) bake.Emit(box, 0.0);
    return;
  }
  int axis = 0;
  double at = 0.0;
  if (!FindFaceCut(inner, box, axis, at)) {
    if (BendsOutward(soup, patches)) {
      RefineConvex(LocalConvex(soup, patches, box), box, bake);
      return;
    }
    const double diagonal = box.Diagonal();
    if (diagonal <= bake.maxError) {
      bake.Emit(box, diagonal);
      return;
    }
    if (depth >= kMaxDepth) {
      bake.over = true;
      return;
    }
    for (int a = 1; a < 3; ++a) {
      if (box.Size(a) > box.Size(axis)) axis = a;
    }
    at = (box.lo[static_cast<std::size_t>(axis)] + box.hi[static_cast<std::size_t>(axis)]) * 0.5;
  }
  RefineSoup(soup, box.Below(axis, at), kept, depth + 1, bake);
  RefineSoup(soup, box.Above(axis, at), kept, depth + 1, bake);
}

/** A mesh with coincident points made one, and zero-area triangles counted out. */
struct Welded {
  std::vector<Vec3> points;
  std::vector<std::array<int, 3>> faces;
};

inline long long Quantized(double value) { return std::llround(value / kWeldCm); }

Welded Weld(const TriangleMesh& mesh, int& dropped) {
  Welded welded;
  std::map<std::tuple<long long, long long, long long>, int> ids;
  std::vector<int> remap(mesh.vertices.size());
  for (std::size_t i = 0; i < mesh.vertices.size(); ++i) {
    const Vec3& p = mesh.vertices[i];
    const auto key = std::make_tuple(Quantized(p.x), Quantized(p.y), Quantized(p.z));
    const auto found = ids.find(key);
    if (found != ids.end()) {
      remap[i] = found->second;
      continue;
    }
    remap[i] = static_cast<int>(welded.points.size());
    ids.emplace(key, remap[i]);
    welded.points.push_back(p);
  }
  for (std::size_t i = 0; i + 2 < mesh.indices.size(); i += 3) {
    const int a = remap[static_cast<std::size_t>(mesh.indices[i])];
    const int b = remap[static_cast<std::size_t>(mesh.indices[i + 1])];
    const int c = remap[static_cast<std::size_t>(mesh.indices[i + 2])];
    const std::size_t ia = static_cast<std::size_t>(a);
    const std::size_t ib = static_cast<std::size_t>(b);
    const std::size_t ic = static_cast<std::size_t>(c);
    if (a == b || b == c || a == c || AreaOf(welded.points[ia], welded.points[ib], welded.points[ic]) < kMinArea) {
      dropped += 1;
      continue;
    }
    welded.faces.push_back({a, b, c});
  }
  return welded;
}

int RootOf(std::vector<int>& parents, int id) {
  while (parents[static_cast<std::size_t>(id)] != id) {
    parents[static_cast<std::size_t>(id)] = parents[static_cast<std::size_t>(parents[static_cast<std::size_t>(id)])];
    id = parents[static_cast<std::size_t>(id)];
  }
  return id;
}

/** The mesh's connected parts, as lists of faces. */
std::vector<std::vector<std::array<int, 3>>> ConnectedParts(const Welded& mesh) {
  std::vector<int> parents(mesh.points.size());
  for (std::size_t i = 0; i < parents.size(); ++i) parents[i] = static_cast<int>(i);
  for (const std::array<int, 3>& f : mesh.faces) {
    parents[static_cast<std::size_t>(RootOf(parents, f[1]))] = RootOf(parents, f[0]);
    parents[static_cast<std::size_t>(RootOf(parents, f[2]))] = RootOf(parents, f[0]);
  }
  std::map<int, std::vector<std::array<int, 3>>> parts;
  for (const std::array<int, 3>& f : mesh.faces) parts[RootOf(parents, f[0])].push_back(f);
  std::vector<std::vector<std::array<int, 3>>> list;
  for (std::pair<const int, std::vector<std::array<int, 3>>>& part : parts) list.push_back(std::move(part.second));
  return list;
}

/** Every edge met exactly once each way: the part bounds a volume and its winding agrees. */
bool IsClosed(const std::vector<std::array<int, 3>>& faces) {
  std::map<std::pair<int, int>, int> edges;
  for (const std::array<int, 3>& f : faces) {
    for (std::size_t i = 0; i < 3; ++i) edges[{f[i], f[(i + 1) % 3]}] += 1;
  }
  for (const std::pair<const std::pair<int, int>, int>& edge : edges) {
    const auto reverse = edges.find({edge.first.second, edge.first.first});
    if (edge.second != 1 || reverse == edges.end() || reverse->second != 1) return false;
  }
  return true;
}

double SignedVolume(const std::vector<Vec3>& points, const std::vector<std::array<int, 3>>& faces) {
  double volume = 0.0;
  for (const std::array<int, 3>& f : faces) {
    volume += DotOf(points[static_cast<std::size_t>(f[0])], CrossOf(points[static_cast<std::size_t>(f[1])], points[static_cast<std::size_t>(f[2])]));
  }
  return volume / 6.0;
}

bool AllBelowPlanes(const std::vector<Tri>& tris) {
  if (static_cast<double>(tris.size()) * static_cast<double>(tris.size()) > kMaxConvexWork) return false;
  for (const Tri& t : tris) {
    for (const Tri& other : tris) {
      if (t.plane.Signed(other.a) > 2.0 * kWeldCm || t.plane.Signed(other.b) > 2.0 * kWeldCm || t.plane.Signed(other.c) > 2.0 * kWeldCm) return false;
    }
  }
  return true;
}

void BakeClosed(std::vector<Tri> tris, ActorBake& bake) {
  if (AllBelowPlanes(tris)) {
    BakeConvex(MakeConvex(std::move(tris)), bake);
    return;
  }
  const Soup soup = MakeSoup(std::move(tris));
  std::vector<int> all(soup.tris.size());
  for (std::size_t i = 0; i < all.size(); ++i) all[i] = static_cast<int>(i);
  RefineSoup(soup, soup.bounds, all, 0, bake);
}

/** A flat group of faces as a closed plate reaching `thickness` behind them: top, bottom and a rim on open edges. */
std::vector<Tri> PlateOf(const std::vector<Vec3>& points, const std::vector<std::array<int, 3>>& faces, const Vec3& normal, double thickness) {
  const Vec3 back = Times(normal, -thickness);
  std::vector<Tri> tris;
  std::map<std::pair<int, int>, int> edges;
  for (const std::array<int, 3>& f : faces) {
    for (std::size_t i = 0; i < 3; ++i) edges[{f[i], f[(i + 1) % 3]}] += 1;
    const Vec3& a = points[static_cast<std::size_t>(f[0])];
    const Vec3& b = points[static_cast<std::size_t>(f[1])];
    const Vec3& c = points[static_cast<std::size_t>(f[2])];
    tris.push_back(MakeTri(a, b, c));
    tris.push_back(MakeTri(Plus(a, back), Plus(c, back), Plus(b, back)));
  }
  for (const std::pair<const std::pair<int, int>, int>& edge : edges) {
    if (edges.count({edge.first.second, edge.first.first}) != 0) continue;
    const Vec3& a = points[static_cast<std::size_t>(edge.first.first)];
    const Vec3& b = points[static_cast<std::size_t>(edge.first.second)];
    tris.push_back(MakeTri(a, Plus(a, back), Plus(b, back)));
    tris.push_back(MakeTri(a, Plus(b, back), b));
  }
  return tris;
}

/** A surface with no inside: each flat group of its faces becomes a plate behind them, so what stands on the
 *  surface stands exactly where it did, and nothing fills the space the surface encloses. */
void BakeSurface(const std::vector<Vec3>& points, const std::vector<std::array<int, 3>>& faces, ActorBake& bake) {
  using PlaneKey = std::array<long long, 4>;
  std::map<PlaneKey, std::vector<std::array<int, 3>>> groups;
  for (const std::array<int, 3>& f : faces) {
    const Tri t = MakeTri(points[static_cast<std::size_t>(f[0])], points[static_cast<std::size_t>(f[1])], points[static_cast<std::size_t>(f[2])]);
    const PlaneKey key{std::llround(t.plane.normal.x * 1e4), std::llround(t.plane.normal.y * 1e4), std::llround(t.plane.normal.z * 1e4), Quantized(t.plane.offset)};
    groups[key].push_back(f);
  }
  const double thickness = (std::min)(kPlateCm, bake.maxError);
  const double floorBefore = bake.floorError;
  bake.floorError = thickness;
  for (const std::pair<const PlaneKey, std::vector<std::array<int, 3>>>& group : groups) {
    const std::array<int, 3>& f = group.second.front();
    const Tri first = MakeTri(points[static_cast<std::size_t>(f[0])], points[static_cast<std::size_t>(f[1])], points[static_cast<std::size_t>(f[2])]);
    BakeClosed(PlateOf(points, group.second, first.plane.normal, thickness), bake);
    if (bake.over) break;
  }
  bake.floorError = floorBefore;
}

void BakeMesh(const TriangleMesh& mesh, ActorBake& bake) {
  const Welded welded = Weld(mesh, bake.dropped);
  for (const std::vector<std::array<int, 3>>& part : ConnectedParts(welded)) {
    if (bake.over) return;
    if (!IsClosed(part) || SignedVolume(welded.points, part) <= 0.0) {
      BakeSurface(welded.points, part, bake);
      continue;
    }
    std::vector<Tri> tris;
    tris.reserve(part.size());
    for (const std::array<int, 3>& f : part) {
      tris.push_back(MakeTri(welded.points[static_cast<std::size_t>(f[0])], welded.points[static_cast<std::size_t>(f[1])], welded.points[static_cast<std::size_t>(f[2])]));
    }
    BakeClosed(std::move(tris), bake);
  }
}

/** The points of a hull's flat side on `plane`, in order around it, as outward triangles. */
void AddHullFace(const std::vector<Vec3>& points, const Plane& plane, std::vector<Tri>& tris) {
  std::vector<Vec3> on;
  Vec3 center;
  for (const Vec3& p : points) {
    if (std::fabs(plane.Signed(p)) > 2.0 * kWeldCm) continue;
    on.push_back(p);
    center = Plus(center, p);
  }
  if (on.size() < 3) return;
  center = Times(center, 1.0 / static_cast<double>(on.size()));
  const Vec3 u = Minus(on[0], center);
  const Vec3 v = CrossOf(plane.normal, u);
  std::sort(on.begin(), on.end(), [&](const Vec3& a, const Vec3& b) {
    return std::atan2(DotOf(Minus(a, center), v), DotOf(Minus(a, center), u) * LengthOf(plane.normal)) <
           std::atan2(DotOf(Minus(b, center), v), DotOf(Minus(b, center), u) * LengthOf(plane.normal));
  });
  for (std::size_t i = 1; i + 1 < on.size(); ++i) {
    if (AreaOf(on[0], on[i], on[i + 1]) < kMinArea) continue;
    Tri t = MakeTri(on[0], on[i], on[i + 1]);
    if (DotOf(t.plane.normal, plane.normal) < 0.0) std::swap(t.b, t.c);
    t.plane = plane;
    tris.push_back(t);
  }
}

std::vector<Vec3> WeldedPoints(const std::vector<Vec3>& points) {
  std::map<std::tuple<long long, long long, long long>, Vec3> unique;
  for (const Vec3& p : points) unique.emplace(std::make_tuple(Quantized(p.x), Quantized(p.y), Quantized(p.z)), p);
  std::vector<Vec3> list;
  list.reserve(unique.size());
  for (const auto& entry : unique) list.push_back(entry.second);
  return list;
}

/** A plane through three points that has every point on one side, facing away from them. */
bool SupportingPlane(const std::vector<Vec3>& points, const Vec3& a, const Vec3& b, const Vec3& c, Plane& plane) {
  const Vec3 n = CrossOf(Minus(b, a), Minus(c, a));
  const double length = LengthOf(n);
  if (length < 1e-9) return false;
  plane.normal = Times(n, 1.0 / length);
  plane.offset = DotOf(plane.normal, a);
  bool above = false;
  bool below = false;
  for (const Vec3& p : points) {
    const double side = plane.Signed(p);
    above = above || side > kWeldCm;
    below = below || side < -kWeldCm;
    if (above && below) return false;
  }
  if (!above && !below) return false;
  if (above) {
    plane.normal = Times(plane.normal, -1.0);
    plane.offset = -plane.offset;
  }
  return true;
}

/** Whether all points lie in one plane; `normal` is that plane's when any three span one. */
bool IsFlat(const std::vector<Vec3>& points, Vec3& normal, bool& spansPlane) {
  spansPlane = false;
  for (std::size_t i = 2; i < points.size(); ++i) {
    const Vec3 n = CrossOf(Minus(points[1], points[0]), Minus(points[i], points[0]));
    const double length = LengthOf(n);
    if (length < 1e-6) continue;
    normal = Times(n, 1.0 / length);
    spansPlane = true;
    break;
  }
  if (!spansPlane) return true;
  for (const Vec3& p : points) {
    if (std::fabs(DotOf(normal, Minus(p, points[0]))) > kWeldCm) return false;
  }
  return true;
}

void BakeFlatPolygon(const std::vector<Vec3>& points, Vec3 normal, ActorBake& bake) {
  if (normal.z < 0.0) normal = Times(normal, -1.0);
  std::vector<Tri> face;
  AddHullFace(points, Plane{normal, DotOf(normal, points[0])}, face);
  std::vector<Vec3> corners;
  std::vector<std::array<int, 3>> faces;
  for (const Tri& t : face) {
    const int at = static_cast<int>(corners.size());
    corners.push_back(t.a);
    corners.push_back(t.b);
    corners.push_back(t.c);
    faces.push_back({at, at + 1, at + 2});
  }
  TriangleMesh mesh;
  mesh.vertices = corners;
  for (const std::array<int, 3>& f : faces) mesh.indices.insert(mesh.indices.end(), f.begin(), f.end());
  BakeMesh(mesh, bake);
}

/** The hull's faces by trying every plane through three points: hulls here are small, and most planes fail fast. */
std::vector<Tri> HullFaces(const std::vector<Vec3>& points) {
  std::vector<Plane> planes;
  std::vector<Tri> tris;
  for (std::size_t i = 0; i < points.size(); ++i) {
    for (std::size_t j = i + 1; j < points.size(); ++j) {
      for (std::size_t k = j + 1; k < points.size(); ++k) {
        Plane plane;
        if (!SupportingPlane(points, points[i], points[j], points[k], plane)) continue;
        const bool seen = std::any_of(planes.begin(), planes.end(), [&](const Plane& other) {
          return DotOf(other.normal, plane.normal) > 1.0 - 1e-7 && std::fabs(other.offset - plane.offset) <= 2.0 * kWeldCm;
        });
        if (seen) continue;
        planes.push_back(plane);
        AddHullFace(points, plane, tris);
      }
    }
  }
  return tris;
}

void BakeHull(const std::vector<Vec3>& given, ActorBake& bake) {
  const std::vector<Vec3> points = WeldedPoints(given);
  if (points.size() < 3) return;
  Vec3 normal;
  bool spansPlane = false;
  if (IsFlat(points, normal, spansPlane)) {
    if (spansPlane) BakeFlatPolygon(points, normal, bake);
    return;
  }
  BakeConvex(MakeConvex(HullFaces(points)), bake);
}

/** The bounds of the triangles' part in `region`. On a closed solid that is the solid's own: a cut's extremes lie on
 *  the surface it crosses, so boxes split this way still cover everything. */
Aabb TightAround(const std::vector<Tri>& tris, const Aabb& region) {
  Aabb tight;
  Poly scratch;
  for (const Tri& t : tris) {
    for (const Vec3& p : ClipTriangle(t, region, scratch)) tight.Add(p);
  }
  return tight;
}

/** The furthest of a box's corners from the surface, which is what a report can say of any source, closed or not. */
double ReachOf(const std::vector<Tri>& tris, const Aabb& box) {
  double worst = 0.0;
  for (int i = 0; i < 8; ++i) {
    const Vec3 corner = box.Corner(i);
    double nearest = kInfinity;
    for (const Tri& t : tris) nearest = (std::min)(nearest, DistanceToTriangle(corner, t.a, t.b, t.c));
    worst = (std::max)(worst, nearest);
  }
  return worst;
}

/** A flat element has no volume for a box to bound: give it a plate's thickness behind it, as BakeSurface does. */
Aabb WithThickness(Aabb box, double maxError) {
  const double thickness = (std::min)(kPlateCm, maxError);
  for (int axis = 0; axis < 3; ++axis) {
    const std::size_t i = static_cast<std::size_t>(axis);
    if (box.Size(axis) < kWeldCm) box.lo[i] = box.hi[i] - thickness;
  }
  return box;
}

struct BoundsPiece {
  Aabb box;
  double reach = 0.0;
};

/** The worst piece's best cut in two: the axis whose halves reach least. False when no cut leaves two pieces. */
bool SplitWorstPiece(const std::vector<Tri>& tris, std::vector<BoundsPiece>& pieces) {
  std::size_t worst = 0;
  for (std::size_t i = 1; i < pieces.size(); ++i) {
    if (pieces[i].reach > pieces[worst].reach) worst = i;
  }
  if (pieces[worst].reach <= kWeldCm) return false;
  const Aabb box = pieces[worst].box;
  BoundsPiece below;
  BoundsPiece above;
  double best = kInfinity;
  for (int axis = 0; axis < 3; ++axis) {
    if (box.Size(axis) < kMinSliceCm) continue;
    const double middle = (box.lo[static_cast<std::size_t>(axis)] + box.hi[static_cast<std::size_t>(axis)]) * 0.5;
    const Aabb low = TightAround(tris, box.Below(axis, middle));
    const Aabb high = TightAround(tris, box.Above(axis, middle));
    if (low.Empty() || high.Empty()) continue;
    const double lowReach = ReachOf(tris, low);
    const double highReach = ReachOf(tris, high);
    if ((std::max)(lowReach, highReach) >= best) continue;
    best = (std::max)(lowReach, highReach);
    below = BoundsPiece{low, lowReach};
    above = BoundsPiece{high, highReach};
  }
  if (best == kInfinity) return false;
  pieces[worst] = below;
  pieces.push_back(above);
  return true;
}

/** One element as at most `shapes` boxes around it. */
void BakeBounds(const std::vector<Tri>& tris, int shapes, ActorBake& bake) {
  if (tris.empty()) return;
  Aabb all;
  for (const Tri& t : tris) {
    all.Add(t.a);
    all.Add(t.b);
    all.Add(t.c);
  }
  std::vector<BoundsPiece> pieces{BoundsPiece{all, ReachOf(tris, all)}};
  while (static_cast<int>(pieces.size()) < shapes && SplitWorstPiece(tris, pieces)) {
  }
  for (const BoundsPiece& piece : pieces) bake.EmitBounds(WithThickness(piece.box, bake.maxError), piece.reach);
}

/** A hull's faces, flat or not; empty when it has no area. */
std::vector<Tri> HullSource(const std::vector<Vec3>& given) {
  const std::vector<Vec3> points = WeldedPoints(given);
  if (points.size() < 3) return {};
  Vec3 normal;
  bool spansPlane = false;
  if (!IsFlat(points, normal, spansPlane)) return HullFaces(points);
  std::vector<Tri> face;
  if (spansPlane) AddHullFace(points, Plane{normal, DotOf(normal, points[0])}, face);
  return face;
}

std::vector<Tri> MeshSource(const TriangleMesh& mesh, int& dropped) {
  const Welded welded = Weld(mesh, dropped);
  std::vector<Tri> tris;
  tris.reserve(welded.faces.size());
  for (const std::array<int, 3>& f : welded.faces) {
    tris.push_back(MakeTri(welded.points[static_cast<std::size_t>(f[0])], welded.points[static_cast<std::size_t>(f[1])], welded.points[static_cast<std::size_t>(f[2])]));
  }
  return tris;
}

std::vector<Vec3> CornersOf(const OrientedBox& box) {
  std::vector<Vec3> corners;
  for (int i = 0; i < 8; ++i) {
    const double x = (i & 1) != 0 ? box.half.x : -box.half.x;
    const double y = (i & 2) != 0 ? box.half.y : -box.half.y;
    const double z = (i & 4) != 0 ? box.half.z : -box.half.z;
    corners.push_back(Plus(box.center, Plus(Times(box.axisX, x), Plus(Times(box.axisY, y), Times(box.axisZ, z)))));
  }
  return corners;
}

/** The first thing wrong with an actor's input, if any. */
bool FindInputFault(const ActorGeometry& actor, double limit, SkipReason& reason) {
  bool nonFinite = false;
  bool outOfRange = false;
  const auto look = [&](const Vec3& p) {
    nonFinite = nonFinite || !std::isfinite(p.x) || !std::isfinite(p.y) || !std::isfinite(p.z);
    outOfRange = outOfRange || std::fabs(p.x) > limit || std::fabs(p.y) > limit || std::fabs(p.z) > limit;
  };
  for (const OrientedBox& box : actor.boxes) {
    for (const Vec3& p : CornersOf(box)) look(p);
  }
  for (const ConvexHull& hull : actor.hulls) {
    for (const Vec3& p : hull.points) look(p);
  }
  for (const TriangleMesh& mesh : actor.meshes) {
    for (const Vec3& p : mesh.vertices) look(p);
  }
  if (nonFinite) {
    reason = SkipReason::NonFinite;
    return true;
  }
  if (outOfRange) {
    reason = SkipReason::OutOfRange;
    return true;
  }
  for (const TriangleMesh& mesh : actor.meshes) {
    const bool wholeTriangles = mesh.indices.size() % 3 == 0;
    const bool inRange = std::all_of(mesh.indices.begin(), mesh.indices.end(), [&](std::int32_t index) {
      return index >= 0 && static_cast<std::size_t>(index) < mesh.vertices.size();
    });
    if (!wholeTriangles || !inRange) {
      reason = SkipReason::BadIndex;
      return true;
    }
  }
  for (const ConvexHull& hull : actor.hulls) {
    if (WeldedPoints(hull.points).size() > kMaxHullPoints) {
      reason = SkipReason::HullTooLarge;
      return true;
    }
  }
  return false;
}

/** Rotation noise off a value (a quarter turn's 1e-14), so a turned box lands on the numbers an unturned one has. */
inline double Denoised(double value) { return std::round(value * kDenoise) / kDenoise; }
inline double ToGenex(double value, double scale) { return static_cast<double>(static_cast<float>(Denoised(value) / scale)); }

/** The next float32 above a Genex value. */
inline double NextUp(double value) { return static_cast<double>(std::nextafter(static_cast<float>(value), std::numeric_limits<float>::infinity())); }

/** How far, in engine units, this axis must grow for float32 to keep it, or 0 when it survives as it is. */
double AxisWiden(double lo, double hi, double scale) {
  const double low = ToGenex(lo, scale);
  if (low < ToGenex(hi, scale)) return 0.0;
  return NextUp(low) * scale - hi;
}

/** The same for a solid's axes, the first through `last`. */
double WidenOf(const Aabb& box, double scale, std::size_t last) {
  double widen = 0.0;
  for (std::size_t i = 0; i <= last; ++i) widen = (std::max)(widen, AxisWiden(box.lo[i], box.hi[i], scale));
  return widen;
}

/** A ramp whose height float32 cannot keep has no slope to keep either: it is a box from here. */
void FlattenThinRamps(ActorBake& bake, double scale) {
  std::vector<RampSolid> kept;
  for (const RampSolid& ramp : bake.ramps) {
    if (ToGenex(ramp.box.lo[2], scale) < ToGenex(ramp.box.hi[2], scale)) {
      kept.push_back(ramp);
      continue;
    }
    bake.boxes.push_back(ramp.box);
    bake.boxErrors.push_back(bake.worst);
  }
  bake.ramps.swap(kept);
}

/** Grows what float32 would lose by one step, while that stays inside maxError from the source. A part that cannot is a
 *  solid this far out that no float32 can hold, which is the Collapsed skip: nothing vanishes silently either way. */
bool KeepThinSolids(ActorBake& bake, const BakeOptions& options) {
  const double scale = options.unitsPerGenex;
  FlattenThinRamps(bake, scale);
  for (std::size_t i = 0; i < bake.boxes.size(); ++i) {
    const double widen = WidenOf(bake.boxes[i], scale, 2);
    if (widen <= 0.0) continue;
    if (bake.boxErrors[i] + widen > options.maxErrorCm) return false;
    bake.worst = (std::max)(bake.worst, bake.boxErrors[i] + widen);
    bake.widened += 1;
  }
  for (const RampSolid& ramp : bake.ramps) {
    const double widen = WidenOf(ramp.box, scale, 1);
    if (widen <= 0.0) continue;
    if (bake.worst + widen > options.maxErrorCm) return false;
    bake.worst += widen;
    bake.widened += 1;
  }
  return true;
}

bool SameBelowWeld(double a, double b) { return std::fabs(a - b) <= kWeldCm; }

/** Boxes that share a face exactly, or overlap on one axis with the other two equal, become one. */
bool MergeAlong(std::vector<Aabb>& boxes, int axis) {
  const std::size_t a = static_cast<std::size_t>(axis);
  const std::size_t b = static_cast<std::size_t>((axis + 1) % 3);
  const std::size_t c = static_cast<std::size_t>((axis + 2) % 3);
  const auto key = [&](const Aabb& box) {
    return std::make_tuple(Quantized(box.lo[b]), Quantized(box.hi[b]), Quantized(box.lo[c]), Quantized(box.hi[c]), box.lo[a]);
  };
  std::sort(boxes.begin(), boxes.end(), [&](const Aabb& l, const Aabb& r) { return key(l) < key(r); });
  std::vector<Aabb> merged;
  merged.reserve(boxes.size());
  for (const Aabb& box : boxes) {
    if (!merged.empty()) {
      Aabb& last = merged.back();
      const bool sameSide = SameBelowWeld(last.lo[b], box.lo[b]) && SameBelowWeld(last.hi[b], box.hi[b]) &&
                            SameBelowWeld(last.lo[c], box.lo[c]) && SameBelowWeld(last.hi[c], box.hi[c]);
      // The sort groups by quantized sides, so a box within a weld of the last one's sides can sort before or after it:
      // only boxes that really meet along the axis merge, or the merge would swallow a solid far from this one.
      if (sameSide && box.lo[a] <= last.hi[a] + kWeldCm && box.hi[a] >= last.lo[a] - kWeldCm) {
        last.lo[a] = (std::min)(last.lo[a], box.lo[a]);
        last.hi[a] = (std::max)(last.hi[a], box.hi[a]);
        continue;
      }
    }
    merged.push_back(box);
  }
  const bool changed = merged.size() != boxes.size();
  boxes.swap(merged);
  return changed;
}

bool Within(const Aabb& inner, const Aabb& outer) {
  for (std::size_t i = 0; i < 3; ++i) {
    if (inner.lo[i] < outer.lo[i] - kWeldCm || inner.hi[i] > outer.hi[i] + kWeldCm) return false;
  }
  return true;
}

void DropContained(std::vector<Aabb>& boxes) {
  std::sort(boxes.begin(), boxes.end(), [](const Aabb& l, const Aabb& r) { return std::tie(l.lo, l.hi) < std::tie(r.lo, r.hi); });
  std::vector<char> gone(boxes.size(), 0);
  for (std::size_t i = 0; i < boxes.size(); ++i) {
    for (std::size_t j = i + 1; j < boxes.size() && boxes[j].lo[0] <= boxes[i].hi[0] + kWeldCm; ++j) {
      if (gone[j] != 0 || gone[i] != 0) continue;
      if (Within(boxes[j], boxes[i])) gone[j] = 1;
      else if (Within(boxes[i], boxes[j])) gone[i] = 1;
    }
  }
  std::vector<Aabb> kept;
  for (std::size_t i = 0; i < boxes.size(); ++i) {
    if (gone[i] == 0) kept.push_back(boxes[i]);
  }
  boxes.swap(kept);
}

void MergeBoxes(std::vector<Aabb>& boxes) {
  DropContained(boxes);
  bool changed = true;
  while (changed) {
    changed = false;
    for (int axis = 0; axis < 3; ++axis) changed = MergeAlong(boxes, axis) || changed;
  }
  DropContained(boxes);
}

double SlopeOf(const RampSolid& ramp) {
  const std::size_t a = static_cast<std::size_t>(ramp.axis);
  return (ramp.high - ramp.low) / (ramp.box.hi[a] - ramp.box.lo[a]);
}

/** Ramps end to end on one plane over one strip, or side by side with the same profile, become one. */
bool MergeRampsOnce(std::vector<RampSolid>& ramps, bool endToEnd) {
  const auto key = [&](const RampSolid& r) {
    const std::size_t a = static_cast<std::size_t>(r.axis);
    const std::size_t c = 1 - a;
    const std::size_t same = endToEnd ? c : a;
    const std::size_t along = endToEnd ? a : c;
    const long long profile = endToEnd ? 0 : Quantized(r.low) * 1000003 + Quantized(r.high);
    return std::make_tuple(r.axis, Quantized(r.box.lo[2]), Quantized(r.box.lo[same]), Quantized(r.box.hi[same]), profile, r.box.lo[along]);
  };
  std::sort(ramps.begin(), ramps.end(), [&](const RampSolid& l, const RampSolid& r) { return key(l) < key(r); });
  std::vector<RampSolid> merged;
  merged.reserve(ramps.size());
  for (const RampSolid& ramp : ramps) {
    if (!merged.empty()) {
      RampSolid& last = merged.back();
      const std::size_t a = static_cast<std::size_t>(ramp.axis);
      const std::size_t c = 1 - a;
      const std::size_t same = endToEnd ? c : a;
      const std::size_t along = endToEnd ? a : c;
      const bool sameBody = last.axis == ramp.axis && SameBelowWeld(last.box.lo[2], ramp.box.lo[2]) &&
                            SameBelowWeld(last.box.lo[same], ramp.box.lo[same]) && SameBelowWeld(last.box.hi[same], ramp.box.hi[same]);
      const bool touching = SameBelowWeld(last.box.hi[along], ramp.box.lo[along]);
      const bool onePlane = endToEnd ? SameBelowWeld(last.high, ramp.low) && std::fabs(SlopeOf(last) - SlopeOf(ramp)) <= 1e-6
                                     : SameBelowWeld(last.low, ramp.low) && SameBelowWeld(last.high, ramp.high);
      if (sameBody && touching && onePlane) {
        last.box.hi[along] = ramp.box.hi[along];
        if (endToEnd) last.high = ramp.high;
        last.box.hi[2] = (std::max)(last.low, last.high);
        continue;
      }
    }
    merged.push_back(ramp);
  }
  const bool changed = merged.size() != ramps.size();
  ramps.swap(merged);
  return changed;
}

void MergeRamps(std::vector<RampSolid>& ramps) {
  bool changed = true;
  while (changed) {
    const bool lengthwise = MergeRampsOnce(ramps, true);
    const bool sideways = MergeRampsOnce(ramps, false);
    changed = lengthwise || sideways;
  }
}

std::string NumberText(double value) {
  char text[40];
  std::snprintf(text, sizeof text, "%.17g", value == 0.0 ? 0.0 : value);
  return text;
}

std::string ShortNumber(double value) {
  char text[40];
  std::snprintf(text, sizeof text, "%.3f", value);
  return text;
}

/** The rule `name` meets, its longest prefix first; "*" meets anything and loses to any real prefix. */
const BoundsRule* RuleFor(const std::string& name, const std::vector<BoundsRule>& rules) {
  const BoundsRule* best = nullptr;
  std::size_t bestLength = 0;
  for (const BoundsRule& rule : rules) {
    if (rule.prefix == "*") {
      if (best == nullptr) best = &rule;
      continue;
    }
    if (name.rfind(rule.prefix, 0) == 0 && rule.prefix.size() > bestLength) {
      best = &rule;
      bestLength = rule.prefix.size();
    }
  }
  return best;
}

/** One actor through the core; false, with `reason`, when it is skipped. */
bool BakeActor(const ActorGeometry& actor, const BakeOptions& options, ActorBake& bake, SkipReason& reason) {
  if (FindInputFault(actor, kMaxGenex * options.unitsPerGenex, reason)) return false;
  bake.maxError = options.maxErrorCm;
  bake.maxBoxes = options.maxBoxesPerActor;
  bake.maxRamps = options.maxRampsPerActor;
  const BoundsRule* rule = RuleFor(actor.name, options.boundsActors);
  for (const OrientedBox& box : actor.boxes) {
    if (bake.over) break;
    if (rule != nullptr) BakeBounds(HullSource(CornersOf(box)), rule->shapes, bake);
    else BakeHull(CornersOf(box), bake);
  }
  for (const ConvexHull& hull : actor.hulls) {
    if (bake.over) break;
    if (rule != nullptr) BakeBounds(HullSource(hull.points), rule->shapes, bake);
    else BakeHull(hull.points, bake);
  }
  for (const TriangleMesh& mesh : actor.meshes) {
    if (bake.over) break;
    if (rule != nullptr) BakeBounds(MeshSource(mesh, bake.dropped), rule->shapes, bake);
    else BakeMesh(mesh, bake);
  }
  if (bake.over) {
    reason = SkipReason::OverBudget;
    return false;
  }
  if (bake.boxes.empty() && bake.ramps.empty()) {
    reason = SkipReason::Degenerate;
    return false;
  }
  if (!KeepThinSolids(bake, options)) {
    reason = SkipReason::Collapsed;
    return false;
  }
  return true;
}

bool ValidOptions(const BakeOptions& options) {
  const auto badRule = [](const BoundsRule& rule) { return rule.prefix.empty() || rule.shapes < 1 || rule.shapes > collision_bake::kMaxBoundsShapes; };
  return std::isfinite(options.maxErrorCm) && options.maxErrorCm > 0.0 && std::isfinite(options.unitsPerGenex) && options.unitsPerGenex > 0.0 &&
         options.maxBoxesPerActor > 0 && options.maxRampsPerActor > 0 && std::none_of(options.boundsActors.begin(), options.boundsActors.end(), badRule);
}

/** Points in an actor's source, for the share a report says is missing. */
std::size_t SourceSize(const ActorGeometry& actor) {
  std::size_t size = actor.boxes.size() * 8;
  for (const ConvexHull& hull : actor.hulls) size += hull.points.size();
  for (const TriangleMesh& mesh : actor.meshes) size += mesh.vertices.size();
  return size;
}

/** Rounded to Genex float32, in one order for any input order. */
void ToWorld(const std::vector<Aabb>& boxes, const std::vector<RampSolid>& ramps, double scale,
                    std::vector<FirstpersonWorld::Box>& outBoxes, std::vector<FirstpersonWorld::Ramp>& outRamps) {
  // KeepThinSolids has already judged these: a side float32 would lose lands one step above the other.
  const auto high = [scale](const Aabb& box, std::size_t i) {
    const double low = ToGenex(box.lo[i], scale);
    const double top = ToGenex(box.hi[i], scale);
    return low < top ? top : NextUp(low);
  };
  for (const Aabb& b : boxes) {
    outBoxes.push_back({ToGenex(b.lo[0], scale), ToGenex(b.lo[1], scale), ToGenex(b.lo[2], scale), high(b, 0), high(b, 1), high(b, 2)});
  }
  for (const RampSolid& r : ramps) {
    outRamps.push_back({ToGenex(r.box.lo[0], scale), ToGenex(r.box.lo[1], scale), ToGenex(r.box.lo[2], scale),
                        high(r.box, 0), high(r.box, 1), ToGenex(r.box.hi[2], scale),
                        static_cast<double>(r.axis), ToGenex(r.low, scale), ToGenex(r.high, scale)});
  }
  std::sort(outBoxes.begin(), outBoxes.end());
  std::sort(outRamps.begin(), outRamps.end());
}

}  // namespace genex::collision_bake_detail

namespace genex::collision_bake {

namespace detail = collision_bake_detail;

BakeResult Bake(const std::vector<ActorGeometry>& actors, const BakeOptions& options) {
  BakeResult result;
  BakeReport& report = result.report;
  report.maxErrorCm = options.maxErrorCm;
  if (!detail::ValidOptions(options)) {
    report.status = BakeStatus::BadOptions;
    report.detail = "maxErrorCm and unitsPerGenex must be positive and finite, budgets positive";
    return result;
  }
  std::vector<detail::Aabb> boxes;
  std::vector<detail::RampSolid> ramps;
  std::size_t sourceSize = 0;
  std::size_t missingSize = 0;
  for (const ActorGeometry& actor : actors) {
    detail::ActorBake bake;
    SkipReason reason = SkipReason::Degenerate;
    const bool baked = detail::BakeActor(actor, options, bake, reason);
    report.droppedTriangles += bake.dropped;
    sourceSize += detail::SourceSize(actor);
    if (!baked) {
      report.skipped.push_back(SkippedActor{actor.name, reason});
      missingSize += detail::SourceSize(actor);
      continue;
    }
    const bool bounds = detail::RuleFor(actor.name, options.boundsActors) != nullptr;
    report.actors.push_back(ActorReport{actor.name, static_cast<int>(bake.boxes.size()), static_cast<int>(bake.ramps.size()), bake.worst, bounds, bake.boundsError});
    report.widenedSolids += bake.widened;
    boxes.insert(boxes.end(), bake.boxes.begin(), bake.boxes.end());
    ramps.insert(ramps.end(), bake.ramps.begin(), bake.ramps.end());
  }
  std::sort(report.actors.begin(), report.actors.end(), [](const ActorReport& a, const ActorReport& b) {
    return std::tie(a.name, a.boxes, a.ramps, a.worstErrorCm) < std::tie(b.name, b.boxes, b.ramps, b.worstErrorCm);
  });
  std::sort(report.skipped.begin(), report.skipped.end(), [](const SkippedActor& a, const SkippedActor& b) {
    return std::tie(a.name, a.reason) < std::tie(b.name, b.reason);
  });
  for (const ActorReport& actor : report.actors) {
    if (actor.worstErrorCm > report.worstErrorCm) {
      report.worstErrorCm = actor.worstErrorCm;
      report.worstActor = actor.name;
    }
    if (actor.bounds) report.boundsActors += 1;
    if (actor.bounds && actor.boundsErrorCm > report.boundsWorstCm) {
      report.boundsWorstCm = actor.boundsErrorCm;
      report.boundsWorstActor = actor.name;
    }
  }
  report.complete = report.skipped.empty();
  // A skip with no points at all still leaves the level short of something, so it never reads as nothing missing.
  if (!report.complete) report.missingShare = missingSize > 0 ? static_cast<double>(missingSize) / static_cast<double>(sourceSize) : 1.0;
  const std::size_t before = boxes.size() + ramps.size();
  detail::MergeBoxes(boxes);
  detail::MergeRamps(ramps);
  report.merged = static_cast<int>(before - boxes.size() - ramps.size());
  report.boxes = static_cast<int>(boxes.size());
  report.ramps = static_cast<int>(ramps.size());
  report.capsHold = report.boxes <= FirstpersonWorld::kMaxBoxes && report.ramps <= FirstpersonWorld::kMaxRamps;
  if (!report.capsHold) {
    report.status = BakeStatus::OverCaps;
    report.detail = "the level needs " + std::to_string(report.boxes) + " boxes and " + std::to_string(report.ramps) + " ramps; §17.7 allows " +
                    std::to_string(FirstpersonWorld::kMaxBoxes) + " and " + std::to_string(FirstpersonWorld::kMaxRamps);
    return result;
  }
  std::vector<FirstpersonWorld::Box> worldBoxes;
  std::vector<FirstpersonWorld::Ramp> worldRamps;
  detail::ToWorld(boxes, ramps, options.unitsPerGenex, worldBoxes, worldRamps);
  result.world = FirstpersonWorld::FromSolids(worldBoxes, worldRamps, &report.detail);
  if (result.world == nullptr) report.status = BakeStatus::WorldRefused;
  else if (!report.complete) report.status = BakeStatus::Incomplete;
  return result;
}

std::string WorldJson(const FirstpersonWorld& world) {
  std::string json = "{\"boxes\":[";
  const auto solid = [&json](const double* values, std::size_t count) {
    json += '[';
    for (std::size_t i = 0; i < count; ++i) {
      if (i != 0) json += ',';
      json += detail::NumberText(values[i]);
    }
    json += ']';
  };
  bool first = true;
  for (const FirstpersonWorld::Box& box : world.Boxes()) {
    if (!first) json += ",\n";
    first = false;
    solid(box.data(), box.size());
  }
  json += "],\"ramps\":[";
  first = true;
  for (const FirstpersonWorld::Ramp& ramp : world.Ramps()) {
    if (!first) json += ",\n";
    first = false;
    solid(ramp.data(), ramp.size());
  }
  json += "]}\n";
  return json;
}

bool ParseBoundsRules(const std::string& text, std::vector<BoundsRule>& rules, std::string& error) {
  std::vector<BoundsRule> read;
  std::size_t start = 0;
  while (start <= text.size()) {
    const std::size_t end = (std::min)(text.find('+', start), text.size());
    const std::string item = text.substr(start, end - start);
    const std::size_t colon = item.find(':');
    BoundsRule rule;
    rule.prefix = item.substr(0, colon);
    if (colon != std::string::npos) {
      const std::string count = item.substr(colon + 1);
      const bool digit = count.size() == 1 && count[0] >= '0' && count[0] <= '9';
      rule.shapes = digit ? count[0] - '0' : 0;
    }
    if (rule.prefix.empty() || rule.shapes < 1 || rule.shapes > kMaxBoundsShapes) {
      error = "bad bounds rule '" + item + "': use Prefix or Prefix:shapes with 1 to " + std::to_string(kMaxBoundsShapes) + " shapes";
      return false;
    }
    read.push_back(rule);
    start = end + 1;
  }
  rules = std::move(read);
  return true;
}


const char* SkipReasonName(SkipReason reason) {
  switch (reason) {
    case SkipReason::NonFinite: return "non_finite";
    case SkipReason::OutOfRange: return "out_of_range";
    case SkipReason::BadIndex: return "bad_index";
    case SkipReason::HullTooLarge: return "hull_too_large";
    case SkipReason::Degenerate: return "degenerate";
    case SkipReason::OverBudget: return "over_budget";
    case SkipReason::Collapsed: return "collapsed";
  }
  return "unknown";
}

const char* BakeStatusName(BakeStatus status) {
  switch (status) {
    case BakeStatus::Ok: return "ok";
    case BakeStatus::Incomplete: return "incomplete";
    case BakeStatus::BadOptions: return "bad_options";
    case BakeStatus::OverCaps: return "over_caps";
    case BakeStatus::WorldRefused: return "world_refused";
  }
  return "unknown";
}

std::vector<std::string> ReportLines(const BakeReport& report) {
  std::vector<std::string> lines;
  // Counts that leave out a skipped actor are not the level's: "caps hold" over a missing map would read as a pass.
  const bool shortOfSource = report.status == BakeStatus::Incomplete;
  char missing[64];
  std::snprintf(missing, sizeof missing, "%.1f%% of the source is missing", report.missingShare * 100.0);
  const std::string caps = shortOfSource ? std::string(missing) + ", so the counts are not the level's" : std::string("caps ") + (report.capsHold ? "hold" : "EXCEEDED");
  lines.push_back(std::string(BakeStatusName(report.status)) + ": " + std::to_string(report.boxes) + "/" + std::to_string(FirstpersonWorld::kMaxBoxes) + " boxes, " +
                  std::to_string(report.ramps) + "/" + std::to_string(FirstpersonWorld::kMaxRamps) + " ramps, " + caps +
                  ", worst error " + detail::ShortNumber(report.worstErrorCm) + " of " + detail::ShortNumber(report.maxErrorCm) +
                  (report.worstActor.empty() ? "" : " (" + report.worstActor + ")") + ", " + std::to_string(report.actors.size()) + " actors, " +
                  std::to_string(report.skipped.size()) + " skipped, " + std::to_string(report.merged) + " merged, " +
                  std::to_string(report.droppedTriangles) + " degenerate triangles dropped");
  if (report.boundsActors > 0) {
    lines.push_back(std::to_string(report.boundsActors) + " actors baked as bounds by request, corners up to " + detail::ShortNumber(report.boundsWorstCm) + " from their source (" + report.boundsWorstActor + "): past maxErrorCm on purpose");
  }
  if (report.widenedSolids > 0) lines.push_back(std::to_string(report.widenedSolids) + " solids too thin for float32 grew by one step");
  if (!report.detail.empty()) lines.push_back(report.detail);
  std::vector<ActorReport> worst = report.actors;
  std::stable_sort(worst.begin(), worst.end(), [](const ActorReport& a, const ActorReport& b) { return a.boxes + a.ramps > b.boxes + b.ramps; });
  if (worst.size() > static_cast<std::size_t>(detail::kReportedActors)) worst.resize(static_cast<std::size_t>(detail::kReportedActors));
  for (const ActorReport& actor : worst) {
    lines.push_back("  " + actor.name + ": " + std::to_string(actor.boxes) + " boxes, " + std::to_string(actor.ramps) + " ramps, error " + detail::ShortNumber(actor.worstErrorCm));
  }
  for (const SkippedActor& actor : report.skipped) lines.push_back("  SKIPPED " + actor.name + ": " + SkipReasonName(actor.reason));
  return lines;
}

}  // namespace genex::collision_bake
