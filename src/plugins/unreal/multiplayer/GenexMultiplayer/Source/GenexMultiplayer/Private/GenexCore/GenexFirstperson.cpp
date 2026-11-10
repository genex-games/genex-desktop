// The `firstperson` and `vehicle` presets (PROTOCOL.md §17.7), on one set of collision procedures (the
// Hull below: support … stayOnGround, with vehicle's ground slide as slideMove's `car` branch). Source
// of truth: packages/multiplayer/src/authority/presets.ts (stepFirstperson, stepVehicle,
// firstpersonWorld, the broadphase tree), held to firstperson.json and vehicle.json. Every expression
// below is the TypeScript's in its order (C++ evaluates `a * b * c` and `a - b * c + d` left to right,
// by the same precedence, as JS does), a F32 (static_cast<float>) exactly where Math.fround appears,
// and contraction off (GENEX_FP_STRICT_BEGIN at file scope, after the includes), so no `x + vx * s`
// ever becomes one fused rounding. Each procedure's names are its own, as §17.7 says of its text.
#include "GenexCore/GenexFirstperson.h"

#include "GenexCore/GenexInput.h"
#include "GenexCore/GenexJson.h"
#include "GenexCore/GenexPosed.h"
#include "GenexCore/GenexPresets.h"
#include "GenexCore/GenexVehicle.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <string>

GENEX_FP_STRICT_BEGIN

namespace genex::firstperson_detail {

constexpr double kMaxAbs = 1e9;
constexpr double kMaskLimit = 16777216.0;
/** presets.ts TREE_FANOUT. */
constexpr int kTreeFanout = 8;
/** The values of a world at the caps, as JSON: each number, each solid, each list and the object itself. */
constexpr std::size_t kWorldJsonNodes = static_cast<std::size_t>(FirstpersonWorld::kMaxBoxes) * 7u + static_cast<std::size_t>(FirstpersonWorld::kMaxRamps) * 10u + 3u;
/** presets.ts TREE_KEY_RADIX: what a tree key multiplies its Morton code by. A world that fitted the old 13
 *  index bits keeps its tree. */
constexpr std::uint64_t kTreeKeyRadix = 8388608u;
/** A tree walk's stack: at most kTreeFanout entries a level, and a tree of 36,864 solids has 7 levels. */
constexpr int kStackSize = kTreeFanout * 16;
/** Math.fround's overflow boundary: halfway between FLT_MAX and 2^128 (ties to even round it up). */
constexpr double kF32Overflow = 3.4028235677973366e38;

double NaN() { return std::numeric_limits<double>::quiet_NaN(); }

/** Math.fround: IEEE round to nearest float32, ties to even; past the float32 range ±Infinity (a cast
 *  of an out-of-range double is undefined in C++, so it never reaches one). */
double F32(double v) {
  if (std::fabs(v) >= kF32Overflow) return v > 0 ? std::numeric_limits<double>::infinity() : -std::numeric_limits<double>::infinity();
  return static_cast<double>(static_cast<float>(v));
}

double UnsignedZero(double v) { return v == 0.0 ? 0.0 : v; }

double Clamp(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

/** Math.min / Math.max for the step's finite operands (a zero's sign never matters here, §17.7). */
double Min(double a, double b) { return b < a ? b : a; }
double Max(double a, double b) { return b > a ? b : a; }

/** Math.max of two with JavaScript's NaN rule (the posed tests' `Math.max(x, 0)`). */
double JsMax(double a, double b) { return (a != a || b != b) ? NaN() : (b > a ? b : a); }

bool IsNaN(double v) { return v != v; }

/** A body field as the step reads it: missing (NaN) or non-finite → fallback, clamped, float32. */
double BodyValue(double v, double fallback, double lo, double hi) {
  return UnsignedZero(F32(Clamp(std::isfinite(v) ? v : fallback, lo, hi)));
}

/** An angle as the step reads the previous one: missing or non-finite → 0, float32 (never wrapped). */
double BodyAngle(double v) { return UnsignedZero(F32(std::isfinite(v) ? v : 0.0)); }

/** A sub-step's stored value: clamped to ±1e9, float32, −0 as 0. */
double Stored(double v) { return UnsignedZero(F32(Clamp(v, -kMaxAbs, kMaxAbs))); }

/** A query margin: wider than any rounding of the exact tests, so the tree never drops a solid one of
 *  them could have reported (presets.ts queryMargin). */
double QueryMargin(double a, double b, double c, double d, double e, double g) {
  return 0.001 + 1e-7 * (std::fabs(a) + std::fabs(b) + std::fabs(c) + std::fabs(d) + std::fabs(e) + std::fabs(g));
}

/** The candidates of the last query (grown per thread to the largest world stepped; no allocation after). */
std::vector<std::int32_t>& CandidateBuffer() {
  thread_local std::vector<std::int32_t> buffer;
  return buffer;
}

/** What the collision procedures (§17.7: `support` … `stayOnGround`) read and write (presets.ts Hull):
 *  the world, the hull's dimensions as float32, its place and velocity, and scratch. `firstperson`
 *  (Mover) and `vehicle` (Car) step one each; a hull's height is `hull(duck)` = `standHeight +
 *  (crouchHeight − standHeight) · duck` (a vehicle hull sets both heights to its `height` and keeps
 *  `duck` 0, so that is exactly `height`). One per call. */
/** §17.7's `unit`: the hull against its preset's default radius when that is under a half (a game in other units),
 *  else 1 (a room in the defaults' units with its own hull). */
double UnitOf(double radius, double defaultRadius) {
  const double unit = radius / defaultRadius;
  return unit < 0.5 ? unit : 1.0;
}

struct Hull {
  const FirstpersonWorld& w;
  /** The tick's posed solids, indexed after the static ones (`w.count_ + j`). */
  const PosedWorld& p;
  double r = 0;
  /** §17.7's `unit` (`UnitOf`). */
  double unit = 1;
  double standHeight = 0, crouchHeight = 0, stepHeight = 0, standable = 0;
  double groundTrace = 0, groundSnap = 0, skin = 0;
  double x = 0, y = 0, z = 0, vx = 0, vy = 0, vz = 0, duck = 0;
  bool onGround = false;
  /** The sub-step's length. */
  double h = 0;
  // slab / wedge / sweep results
  double tMin = 0, tMax = 0;
  int ax = -1;
  double sg = 0, nx = 0, ny = 0, nz = 0;
  bool hit = false;
  /** How far inside the solid the hit's point started (§17.7 *Starting inside*): 0 for a hit on the way in. */
  double depth = 0;
  /** The last query's candidates, ascending; nCand of them (−1: every solid, in index order). */
  std::int32_t* cand = nullptr;
  int nCand = -1;
  /** The posed solids the last query met (their `j`), `nPosed` of them, in order. */
  std::int32_t pc[kPosedMax] = {};
  int nPosed = 0;
  /** presets.ts PLANE: one plane (or a disc's normal) shared by the posed tests, as the TypeScript shares it. */
  double pl[4] = {0, 0, 0, 0};

  Hull(const FirstpersonWorld& world, const PosedWorld* posed) : w(world), p(posed != nullptr ? *posed : PosedWorld::None()) {}

  // ---- the broadphase (only filters) ----

  /** The solids whose box, grown by the hull's radius on x and y, could meet [qx0, qx1] × [qy0, qy1] ×
   *  [qz0, qz1] (the caller grows z by what its test needs), in ascending index (every solid without
   *  a tree). Each helper's result is independent of the order anyway: a boolean, a maximum, or the
   *  least (fraction, index). */
  void Query(double qx0, double qy0, double qz0, double qx1, double qy1, double qz1) {
    QueryPosed(qx0, qy0, qz0, qx1, qy1, qz1);
    if (w.treeRef_.empty()) {
      nCand = -1;
      return;
    }
    const double margin = QueryMargin(qx0, qy0, qz0, qx1, qy1, qz1);
    const double pad = r + margin;
    // Written so a NaN bound meets every box, never none.
    const double x0 = qx0 - pad, x1 = qx1 + pad, y0 = qy0 - pad, y1 = qy1 + pad, z0 = qz0 - margin, z1 = qz1 + margin;
    const double* boxes = w.treeBoxes_.data();
    const std::int32_t* ref = w.treeRef_.data();
    const std::int32_t* levelEnd = w.treeLevelEnd_.data();
    const int levels = static_cast<int>(w.treeLevelEnd_.size());
    const std::int32_t count = levelEnd[0];
    std::int32_t stack[kStackSize];
    int n = 0;
    int top = 0;
    stack[top++] = w.treeRoot_;
    while (top > 0) {
      const std::int32_t node = stack[--top];
      const std::size_t o = static_cast<std::size_t>(node) * 6;
      if (boxes[o + 3] < x0 || boxes[o] > x1 || boxes[o + 4] < y0 || boxes[o + 1] > y1 || boxes[o + 5] < z0 ||
          boxes[o + 2] > z1) {
        continue;
      }
      if (node < count) {
        cand[n++] = ref[node];
        continue;
      }
      // A node's children run from its first to kTreeFanout on, or to the end of their level.
      const std::int32_t first = ref[node];
      std::int32_t end = first + kTreeFanout;
      for (int l = 0; l < levels; ++l) {
        if (first < levelEnd[l]) {
          end = (std::min)(end, levelEnd[l]);
          break;
        }
      }
      for (std::int32_t k = first; k < end; ++k) stack[top++] = k;
    }
    // Ascending solid index: the order a brute-force visit takes.
    std::sort(cand, cand + n);
    nCand = n;
  }

  /** The posed solids whose bounds, grown by the hull's radius on x and y, could meet the query's box (the
   *  tree's own test and margin), in order. */
  void QueryPosed(double qx0, double qy0, double qz0, double qx1, double qy1, double qz1) {
    int n = 0;
    if (p.count > 0) {
      const double margin = QueryMargin(qx0, qy0, qz0, qx1, qy1, qz1);
      const double pad = r + margin;
      const double x0 = qx0 - pad, x1 = qx1 + pad, y0 = qy0 - pad, y1 = qy1 + pad, z0 = qz0 - margin, z1 = qz1 + margin;
      for (int j = 0; j < p.count; ++j) {
        if (p.maxX[j] < x0 || p.minX[j] > x1 || p.maxY[j] < y0 || p.minY[j] > y1 || p.maxZ[j] < z0 || p.minZ[j] > z1) continue;
        pc[n++] = j;
      }
    }
    nPosed = n;
  }

  /** How many solids the last query visits, and the k-th of them: the static ones, then the posed. */
  int Visits() const { return (nCand < 0 ? w.count_ : nCand) + nPosed; }
  int SolidAt(int k) const {
    const int base = nCand < 0 ? w.count_ : nCand;
    if (k >= base) return w.count_ + pc[k - base];
    return nCand < 0 ? k : cand[k];
  }

  // ---- §17.7's procedures ----

  /** The hull's height at duck amount `level`. */
  double HullAt(double level) const { return standHeight + (crouchHeight - standHeight) * level; }

  /** `support(ramp, px, py)`: the ramp top's highest z under the footprint. */
  double Support(int i, double px, double py) const {
    const double slope = w.slope_[i];
    const double u = w.axis_[i] == 0 ? px : py;
    const double u2 = slope > 0 ? u + r : slope < 0 ? u - r : u;
    return w.lo_[i] + slope * Clamp(u2 - w.m0_[i], 0.0, w.span_[i]);
  }

  /** `overlaps(px, py, solid)`: the footprint strictly overlaps the solid's on x and y. */
  bool Overlaps(int i, double px, double py) const {
    if (i >= w.count_) return PosedOverlaps(i - w.count_, px, py);
    return px + r > w.minX_[i] && px - r < w.maxX_[i] && py + r > w.minY_[i] && py - r < w.maxY_[i];
  }

  /** A solid's top under the footprint: a box's or posed solid's flat top, a ramp's `Support`. */
  double TopOf(int i, double px, double py) const {
    if (i < w.boxCount_) return w.maxZ_[i];
    if (i < w.count_) return Support(i, px, py);
    return p.maxZ[i - w.count_];
  }

  /** A solid's bottom. */
  double MinZOf(int i) const { return i < w.count_ ? w.minZ_[i] : p.minZ[i - w.count_]; }

  /** `fits(px, py, pz, height)`: no solid overlaps the hull standing at (px, py, pz). */
  bool Fits(double px, double py, double pz, double height) {
    Query(px, py, pz, px, py, pz + height);
    const int n = Visits();
    for (int k = 0; k < n; ++k) {
      const int i = SolidAt(k);
      if (!Overlaps(i, px, py) || !(pz + height > MinZOf(i))) continue;
      const double top = TopOf(i, px, py);
      if (pz < top - 0.0001) return false;
    }
    return true;
  }

  /** `traceDown(px, py, pz, down, up)`: the highest standable top in [pz − down, pz + up] under the
   *  footprint, or NaN for none (also when a ramp too steep to stand on has a higher top there). */
  double TraceDown(double px, double py, double pz, double down, double up) {
    Query(px, py, pz - down, px, py, pz + up);
    const int n = Visits();
    double best = NaN();
    double steep = NaN();
    for (int k = 0; k < n; ++k) {
      const int i = SolidAt(k);
      if (!Overlaps(i, px, py)) continue;
      const double top = TopOf(i, px, py);
      if (!(top <= pz + up && top >= pz - down)) continue;
      if (i < w.boxCount_ || i >= w.count_ || w.topZ_[i] >= standable) {
        if (IsNaN(best) || top > best) best = top;
      } else if (IsNaN(steep) || top > steep) {
        steep = top;
      }
    }
    return steep > best ? NaN() : best;
  }

  /** `checkGround()`. */
  void CheckGround() {
    if (vz > 0.1 * unit) {
      onGround = false;
      return;
    }
    const double g = TraceDown(x, y, z, groundTrace, groundSnap);
    if (!IsNaN(g)) {
      z = g;
      onGround = true;
    } else {
      onGround = false;
    }
  }

  /** One axis of `slab`; false = the test reports no hit and stops. */
  bool SlabAxis(double pos, double d, double lo, double hi, int a) {
    if (std::fabs(d) < 0.000000001) return pos > lo && pos < hi;
    double t1 = (lo - pos) / d;
    double t2 = (hi - pos) / d;
    double sign = -1.0;
    if (t1 > t2) {
      const double swap = t1;
      t1 = t2;
      t2 = swap;
      sign = 1.0;
    }
    if (t1 >= tMin) {
      tMin = t1;
      ax = a;
      sg = sign;
    }
    if (t2 < tMax) tMax = t2;
    return !(tMin > tMax);
  }

  /** Ramp `i`'s plane `plane` grown by the hull, in `wedge`'s order (x hi, x lo, y hi, y lo, the
   *  bottom, the top, the cap): its normal (not of unit length) and its offset `e`. */
  void RampPlane(int i, int plane, double height, double& px_n, double& py_n, double& pz_n, double& e) const {
    px_n = 0.0;
    py_n = 0.0;
    pz_n = 0.0;
    switch (plane) {
      case 0:
        px_n = 1.0;
        e = w.maxX_[i] + r;
        break;
      case 1:
        px_n = -1.0;
        e = -w.minX_[i] + r;
        break;
      case 2:
        py_n = 1.0;
        e = w.maxY_[i] + r;
        break;
      case 3:
        py_n = -1.0;
        e = -w.minY_[i] + r;
        break;
      case 4:
        pz_n = -1.0;
        e = -w.minZ_[i] + height;
        break;
      case 5: {
        const double slope = w.slope_[i];
        if (w.axis_[i] == 0) {
          px_n = -slope;
        } else {
          py_n = -slope;
        }
        pz_n = 1.0;
        e = w.lo_[i] - slope * w.m0_[i] + r * std::fabs(slope);
        break;
      }
      default:  // the cap
        pz_n = 1.0;
        e = w.maxZ_[i];
        break;
    }
  }

  /** `inside(px, py, pz, i, height)` (*Starting inside*): the point is more than skin inside every
   *  face of solid `i` grown by the hull (a ramp's seven planes, each depth as `Wedge` computes it). */
  bool Inside(double px, double py, double pz, int i, double height) {
    if (i >= w.count_) return PosedInside(px, py, pz, i - w.count_, height);
    if (i < w.boxCount_) {
      return px - (w.minX_[i] - r) > skin && w.maxX_[i] + r - px > skin && py - (w.minY_[i] - r) > skin &&
             w.maxY_[i] + r - py > skin && pz - (w.minZ_[i] - height) > skin && w.maxZ_[i] - pz > skin;
    }
    for (int plane = 0; plane < 7; ++plane) {
      double px_n = 0.0, py_n = 0.0, pz_n = 0.0, e = 0.0;
      RampPlane(i, plane, height, px_n, py_n, pz_n, e);
      const double dist = px_n * px + py_n * py + pz_n * pz - e;
      const double inv = 1.0 / std::sqrt(px_n * px_n + py_n * py_n + pz_n * pz_n);
      if (!(-dist * inv > skin)) return false;
    }
    return true;
  }

  /** `covered(q, p, self)` (*Starting inside*): a solid but `self` has `q` (the point pushed out
   *  through a face of `self` that points up) inside it and not `p`, so that face is no way out. Only a
   *  solid whose box grown by the hull holds `q` can answer, so the tree bounds it: a boolean of a set, the
   *  same with every witness kept. */
  bool Covered(double qx, double qy, double qz, double px, double py, double pz, int self, double height) {
    const auto witness = [&](int j) { return j != self && Inside(qx, qy, qz, j, height) && !Inside(px, py, pz, j, height); };
    if (w.treeRef_.empty()) {
      for (int j = 0; j < w.count_; ++j) {
        if (witness(j)) return true;
      }
    } else {
      const double margin = QueryMargin(qx, qy, qz, qx, qy, qz + height);
      const double pad = r + margin;
      // Written so a NaN bound meets every box, never none.
      const double x0 = qx - pad, x1 = qx + pad, y0 = qy - pad, y1 = qy + pad, z0 = qz - margin, z1 = qz + height + margin;
      const double* boxes = w.treeBoxes_.data();
      const std::int32_t* ref = w.treeRef_.data();
      const std::int32_t* levelEnd = w.treeLevelEnd_.data();
      const int levels = static_cast<int>(w.treeLevelEnd_.size());
      const std::int32_t count = levelEnd[0];
      std::int32_t stack[kStackSize];
      int top = 0;
      stack[top++] = w.treeRoot_;
      while (top > 0) {
        const std::int32_t node = stack[--top];
        const std::size_t o = static_cast<std::size_t>(node) * 6;
        if (boxes[o + 3] < x0 || boxes[o] > x1 || boxes[o + 4] < y0 || boxes[o + 1] > y1 || boxes[o + 5] < z0 ||
            boxes[o + 2] > z1) {
          continue;
        }
        if (node < count) {
          if (witness(ref[node])) return true;
          continue;
        }
        // A node's children run from its first to kTreeFanout on, or to the end of their level.
        const std::int32_t first = ref[node];
        std::int32_t end = first + kTreeFanout;
        for (int l = 0; l < levels; ++l) {
          if (first < levelEnd[l]) {
            end = (std::min)(end, levelEnd[l]);
            break;
          }
        }
        for (std::int32_t k = first; k < end; ++k) stack[top++] = k;
      }
    }
    for (int q = w.count_; q < w.count_ + p.count; ++q) {
      if (witness(q)) return true;
    }
    return false;
  }

  /** A table of boxes' bounds: the static world's, or a tick's posed solids'. */
  struct Bounds {
    const double* minX;
    const double* minY;
    const double* minZ;
    const double* maxX;
    const double* maxY;
    const double* maxZ;
  };

  Bounds StaticBounds() const { return Bounds{w.minX_.data(), w.minY_.data(), w.minZ_.data(), w.maxX_.data(), w.maxY_.data(), w.maxZ_.data()}; }
  Bounds PosedBounds() const { return Bounds{p.minX.data(), p.minY.data(), p.minZ.data(), p.maxX.data(), p.maxY.data(), p.maxZ.data()}; }

  /** `slab`'s *Starting inside*: a point more than skin inside box `i` of `b` grown by the hull, on all six
   *  faces, is a hit at 0 on the least deep of the five faces it is pushed out through (x, then y, then
   *  the top; the low face before the high one; a tie keeps the earlier; never the bottom, nor a
   *  covered top), `depth` that face's. `self` is the solid's index among all, for `Covered`. */
  bool SlabInside(double px, double py, double pz, const Bounds& b, int i, double height, int self) {
    const double lx = px - (b.minX[i] - r);
    const double hx = b.maxX[i] + r - px;
    const double ly = py - (b.minY[i] - r);
    const double hy = b.maxY[i] + r - py;
    const double lz = pz - (b.minZ[i] - height);
    const double hz = b.maxZ[i] - pz;
    if (!(lx > skin && hx > skin && ly > skin && hy > skin && lz > skin && hz > skin)) return false;
    double d = lx, fx = -1.0, fy = 0.0, fz = 0.0;
    if (hx < d) { d = hx; fx = 1.0; fy = 0.0; fz = 0.0; }
    if (ly < d) { d = ly; fx = 0.0; fy = -1.0; fz = 0.0; }
    if (hy < d) { d = hy; fx = 0.0; fy = 1.0; fz = 0.0; }
    if (hz < d && !Covered(px, py, pz + hz, px, py, pz, self, height)) { d = hz; fx = 0.0; fy = 0.0; fz = 1.0; }
    tMin = 0.0;
    nx = fx;
    ny = fy;
    nz = fz;
    depth = d;
    return true;
  }

  /** `slab(...)`: a point against box `i` of `b` grown by the hull; on a hit, `tMin`, the normal and `depth`. */
  bool SlabIn(const Bounds& b, double px, double py, double pz, double dx, double dy, double dz, int i, double height, int self) {
    depth = 0.0;
    if (SlabInside(px, py, pz, b, i, height, self)) return true;
    tMin = 0.0;
    tMax = 1.0;
    ax = -1;
    sg = 0.0;
    if (!SlabAxis(px, dx, b.minX[i] - r, b.maxX[i] + r, 0)) return false;
    if (!SlabAxis(py, dy, b.minY[i] - r, b.maxY[i] + r, 1)) return false;
    if (!SlabAxis(pz, dz, b.minZ[i] - height, b.maxZ[i], 2)) return false;
    if (tMin >= 1.0 || ax < 0) return false;
    nx = ax == 0 ? sg : 0.0;
    ny = ax == 1 ? sg : 0.0;
    nz = ax == 2 ? sg : 0.0;
    return true;
  }

  /** `slab(...)` against static box `i`. */
  bool Slab(double px, double py, double pz, double dx, double dy, double dz, int i, double height) {
    return SlabIn(StaticBounds(), px, py, pz, dx, dy, dz, i, height, i);
  }

  /** `wedge(...)`: a point against ramp `i` grown by the hull, plane by plane; on a hit, `tMin` (its
   *  `enter`), the normal and `depth`. A point more than skin inside every plane (*Starting inside*) is
   *  a hit at 0 on the least deep plane but the bottom and a covered top or cap (a tie keeps the
   *  earlier plane); no plane test stops such a point early, so the depths are gathered along the way. */
  bool Wedge(double px, double py, double pz, double dx, double dy, double dz, int i, double height) {
    double enter = 0.0;
    double leave = 1.0;
    bool taken = false;
    bool inside = true;
    double least = std::numeric_limits<double>::infinity();
    double lx = 0.0, ly = 0.0, lz = 0.0;
    depth = 0.0;
    for (int plane = 0; plane < 7; ++plane) {
      double px_n = 0.0, py_n = 0.0, pz_n = 0.0, e = 0.0;
      RampPlane(i, plane, height, px_n, py_n, pz_n, e);
      const double dist = px_n * px + py_n * py + pz_n * pz - e;
      const double motion = px_n * dx + py_n * dy + pz_n * dz;
      const double inv = 1.0 / std::sqrt(px_n * px_n + py_n * py_n + pz_n * pz_n);
      const double planeDepth = -dist * inv;
      if (!(planeDepth > skin)) {
        inside = false;
      } else if (plane != 4 && planeDepth < least &&
                 // The top and the cap point up: the way out only when no other solid covers them.
                 !(inside && plane >= 5 &&
                   Covered(px + px_n * inv * planeDepth, py + py_n * inv * planeDepth, pz + pz_n * inv * planeDepth, px, py, pz, i, height))) {
        least = planeDepth;
        lx = px_n * inv;
        ly = py_n * inv;
        lz = pz_n * inv;
      }
      if (std::fabs(motion) < 0.000000001) {
        if (dist > 0) return false;
        continue;
      }
      // Touching: a plane the point starts on or at most skin behind is entered at once.
      const double t = motion < 0 && dist <= 0 && dist > -skin ? 0.0 : -dist / motion;
      if (motion < 0) {
        if (t >= enter) {
          enter = t;
          nx = px_n * inv;
          ny = py_n * inv;
          nz = pz_n * inv;
          taken = true;
        }
      } else {
        leave = Min(leave, t);
      }
      if (enter > leave) return false;
    }
    if (inside) {
      tMin = 0.0;
      nx = lx;
      ny = ly;
      nz = lz;
      depth = least;
      return true;
    }
    if (!taken || !(enter < 1.0) || !(leave >= 0.0)) return false;
    tMin = enter;
    return true;
  }

  // ---- posed solids: the tests (§17.7 *Posed solids*) ----
  // A posed box is a box. An obox grown by the square hull is a convex prism: its four faces pushed out by the
  // hull's support along them, the hull's four faces pushed out by the box's, its bottom and top (`OBoxPlane`'s
  // order), swept by `Wedge`'s plane method. A disc grown by the hull is two boxes (a cross) and four upright
  // cylinders of the disc's radius at the hull's corners, swept piece by piece. Every expression is
  // presets.ts's in its order.

  /** Posed obox `j`'s plane `which` grown by the hull, in order (u+, u−, v+, v−, x+, x−, y+, y−, the bottom, the
   *  top), `u` the box's heading `(cos, sin)` and `v` across it: into `pl`. */
  void OBoxPlane(int j, int which, double height) {
    const double c = p.cos[j];
    const double s = p.sin[j];
    const double cx = p.cx[j];
    const double cy = p.cy[j];
    const double hx = p.hx[j];
    const double hy = p.hy[j];
    const double reach = r * (std::fabs(c) + std::fabs(s));
    double nxp = 0.0;
    double nyp = 0.0;
    double nzp = 0.0;
    double e = 0.0;
    switch (which) {
      case 0: nxp = c; nyp = s; e = c * cx + s * cy + hx + reach; break;
      case 1: nxp = -c; nyp = -s; e = -(c * cx + s * cy) + hx + reach; break;
      case 2: nxp = -s; nyp = c; e = -s * cx + c * cy + hy + reach; break;
      case 3: nxp = s; nyp = -c; e = s * cx - c * cy + hy + reach; break;
      case 4: nxp = 1.0; e = cx + r + hx * std::fabs(c) + hy * std::fabs(s); break;
      case 5: nxp = -1.0; e = -cx + r + hx * std::fabs(c) + hy * std::fabs(s); break;
      case 6: nyp = 1.0; e = cy + r + hx * std::fabs(s) + hy * std::fabs(c); break;
      case 7: nyp = -1.0; e = -cy + r + hx * std::fabs(s) + hy * std::fabs(c); break;
      case 8: nzp = -1.0; e = -p.minZ[j] + height; break;
      default: nzp = 1.0; e = p.maxZ[j]; break;
    }
    pl[0] = nxp;
    pl[1] = nyp;
    pl[2] = nzp;
    pl[3] = e;
  }

  /** Posed solid `j`'s footprint strictly overlaps the hull's at (px, py). */
  bool PosedOverlaps(int j, double px, double py) const {
    if (!(px + r > p.minX[j] && px - r < p.maxX[j] && py + r > p.minY[j] && py - r < p.maxY[j])) return false;
    const std::uint8_t kind = p.kind[j];
    if (kind == static_cast<std::uint8_t>(PosedSolid::Kind::Box)) return true;
    const double dx = px - p.cx[j];
    const double dy = py - p.cy[j];
    if (kind == static_cast<std::uint8_t>(PosedSolid::Kind::Disc)) {
      const double ax1 = JsMax(std::fabs(dx) - r, 0.0);
      const double ay1 = JsMax(std::fabs(dy) - r, 0.0);
      return ax1 * ax1 + ay1 * ay1 < p.radius[j] * p.radius[j];
    }
    const double c = p.cos[j];
    const double s = p.sin[j];
    const double reach = r * (std::fabs(c) + std::fabs(s));
    return std::fabs(c * dx + s * dy) < p.hx[j] + reach && std::fabs(-s * dx + c * dy) < p.hy[j] + reach;
  }

  /** A disc's grown footprint: how far (px, py) is inside it (negative: outside), and the outward unit normal
   *  of its nearest side into `pl[0..1]`. */
  double DiscDepth(int j, double px, double py) {
    const double dx = px - p.cx[j];
    const double dy = py - p.cy[j];
    const double adx = std::fabs(dx);
    const double ady = std::fabs(dy);
    const double R = p.radius[j];
    if (adx <= r && ady <= r) {
      // Inside the hull-sized square at the centre: out along the axis it is furthest along (x on a tie).
      const bool alongX = adx >= ady;
      pl[0] = alongX ? (dx < 0 ? -1.0 : 1.0) : 0.0;
      pl[1] = alongX ? 0.0 : dy < 0 ? -1.0 : 1.0;
      return R + r - (alongX ? adx : ady);
    }
    const double qx = adx > r ? (dx < 0 ? -(adx - r) : adx - r) : 0.0;
    const double qy = ady > r ? (dy < 0 ? -(ady - r) : ady - r) : 0.0;
    const double len = std::sqrt(qx * qx + qy * qy);
    pl[0] = qx / len;
    pl[1] = qy / len;
    return R - len;
  }

  /** `inside` for posed solid `j`: the point is more than skin inside every face of it grown by the hull. */
  bool PosedInside(double px, double py, double pz, int j, double height) {
    const std::uint8_t kind = p.kind[j];
    if (kind == static_cast<std::uint8_t>(PosedSolid::Kind::Box)) {
      return px - (p.minX[j] - r) > skin && p.maxX[j] + r - px > skin && py - (p.minY[j] - r) > skin &&
             p.maxY[j] + r - py > skin && pz - (p.minZ[j] - height) > skin && p.maxZ[j] - pz > skin;
    }
    if (!(pz - (p.minZ[j] - height) > skin && p.maxZ[j] - pz > skin)) return false;
    if (kind == static_cast<std::uint8_t>(PosedSolid::Kind::Disc)) return DiscDepth(j, px, py) > skin;
    for (int which = 0; which < kOBoxBottom; ++which) {
      OBoxPlane(j, which, height);
      const double pnx = pl[0];
      const double pny = pl[1];
      if (!(-(pnx * px + pny * py - pl[3]) * (1.0 / std::sqrt(pnx * pnx + pny * pny)) > skin)) return false;
    }
    return true;
  }

  static constexpr int kOBoxPlanes = 10;
  static constexpr int kOBoxBottom = 8;
  static constexpr int kOBoxTop = 9;

  /** An obox's plane sweep (`Wedge`'s method over `OBoxPlane`): on a hit, `tMin`, the normal and `depth`. */
  bool OBoxSweep(double px, double py, double pz, double dx, double dy, double dz, int j, int i, double height) {
    double enter = 0.0;
    double leave = 1.0;
    bool taken = false;
    bool inside = true;
    double least = std::numeric_limits<double>::infinity();
    double lx = 0.0, ly = 0.0, lz = 0.0;
    depth = 0.0;
    for (int which = 0; which < kOBoxPlanes; ++which) {
      // `Wedge`'s arithmetic: each plane's normal made unit (a turned face's is only near it).
      OBoxPlane(j, which, height);
      const double pnx = pl[0];
      const double pny = pl[1];
      const double pnz = pl[2];
      const double dist = pnx * px + pny * py + pnz * pz - pl[3];
      const double motion = pnx * dx + pny * dy + pnz * dz;
      const double k = 1.0 / std::sqrt(pnx * pnx + pny * pny + pnz * pnz);
      const double planeDepth = -dist * k;
      if (!(planeDepth > skin)) {
        inside = false;
      } else if (which != kOBoxBottom && planeDepth < least &&
                 !(inside && which == kOBoxTop && LidCovered(px, py, pz, pnx * k, pny * k, pnz * k, planeDepth, i, height))) {
        least = planeDepth;
        lx = pnx * k;
        ly = pny * k;
        lz = pnz * k;
      }
      if (std::fabs(motion) < 0.000000001) {
        if (dist > 0) return false;
        continue;
      }
      const double t = motion < 0 && dist <= 0 && dist > -skin ? 0.0 : -dist / motion;
      if (motion < 0) {
        if (t >= enter) {
          enter = t;
          nx = pnx * k;
          ny = pny * k;
          nz = pnz * k;
          taken = true;
        }
      } else {
        leave = Min(leave, t);
      }
      if (enter > leave) return false;
    }
    if (inside) {
      tMin = 0.0;
      nx = lx;
      ny = ly;
      nz = lz;
      depth = least;
      return true;
    }
    if (!taken || !(enter < 1.0) || !(leave >= 0.0)) return false;
    tMin = enter;
    return true;
  }

  /** presets.ts lidCovered: the point pushed out through the lid `depth` along (ux, uy, uz) is inside another solid. */
  bool LidCovered(double px, double py, double pz, double ux, double uy, double uz, double d, int i, double height) {
    return Covered(px + ux * d, py + uy * d, pz + uz * d, px, py, pz, i, height);
  }

  /** An upright cylinder of radius `R` about (ox, oy), its z from `z0` to `z1`: the point's entry along the move
   *  (the circle, then z, as `Slab` takes its axes); on a hit, `tMin` and the normal. */
  bool Cylinder(double px, double py, double pz, double dx, double dy, double dz, double ox, double oy, double R, double z0, double z1) {
    tMin = 0.0;
    tMax = 1.0;
    ax = -1;
    sg = 0.0;
    const double ex = px - ox;
    const double ey = py - oy;
    const double a = dx * dx + dy * dy;
    const double c = ex * ex + ey * ey - R * R;
    if (a < 0.000000000000000001) {
      if (!(c < 0)) return false;
    } else {
      const double b = ex * dx + ey * dy;
      const double disc = b * b - a * c;
      if (disc < 0) return false;
      const double sq = std::sqrt(disc);
      const double t1 = (-b - sq) / a;
      const double t2 = (-b + sq) / a;
      if (t1 >= tMin) {
        tMin = t1;
        ax = 3;
      }
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) return false;
    }
    if (!SlabAxis(pz, dz, z0, z1, 2)) return false;
    if (tMin >= 1.0 || ax < 0) return false;
    if (ax == 3) {
      const double hx = ex + dx * tMin;
      const double hy = ey + dy * tMin;
      const double len = std::sqrt(hx * hx + hy * hy);
      nx = hx / len;
      ny = hy / len;
      nz = 0.0;
    } else {
      nx = 0.0;
      ny = 0.0;
      nz = sg;
    }
    return true;
  }

  /** A disc's sweep: *Starting inside* (its nearest side, or its top when shallower and not covered; never its
   *  bottom), else the earliest of the cross's boxes, then the corner cylinders (−x−y, +x−y, −x+y, +x+y), a tie
   *  keeping the earlier piece. */
  bool DiscSweep(double px, double py, double pz, double dx, double dy, double dz, int j, int i, double height) {
    const double R = p.radius[j];
    const double cx = p.cx[j];
    const double cy = p.cy[j];
    const double z0 = p.minZ[j] - height;
    const double z1 = p.maxZ[j];
    depth = 0.0;
    const double side = DiscDepth(j, px, py);
    const double lz = pz - z0;
    const double hz = z1 - pz;
    if (side > skin && lz > skin && hz > skin) {
      tMin = 0.0;
      if (hz < side && !Covered(px, py, pz + hz, px, py, pz, i, height)) {
        nx = 0.0;
        ny = 0.0;
        nz = 1.0;
        depth = hz;
      } else {
        nx = pl[0];
        ny = pl[1];
        nz = 0.0;
        depth = side;
      }
      return true;
    }
    bool found = false;
    double bt = 0.0, bx = 0.0, by = 0.0, bz = 0.0;
    double cminX[2] = {0, 0}, cminY[2] = {0, 0}, cminZ[2] = {0, 0}, cmaxX[2] = {0, 0}, cmaxY[2] = {0, 0}, cmaxZ[2] = {0, 0};
    cminX[0] = cx - R; cmaxX[0] = cx + R; cminY[0] = cy; cmaxY[0] = cy;
    cminX[1] = cx; cmaxX[1] = cx; cminY[1] = cy - R; cmaxY[1] = cy + R;
    const Bounds cross{cminX, cminY, cminZ, cmaxX, cmaxY, cmaxZ};
    for (int k = 0; k < 2; ++k) {
      cminZ[k] = p.minZ[j];
      cmaxZ[k] = z1;
      if (SlabIn(cross, px, py, pz, dx, dy, dz, k, height, i) && (!found || tMin < bt)) {
        found = true;
        bt = tMin;
        bx = nx;
        by = ny;
        bz = nz;
      }
    }
    for (int k = 0; k < 4; ++k) {
      const double ox = k % 2 == 0 ? cx - r : cx + r;
      const double oy = k < 2 ? cy - r : cy + r;
      if (Cylinder(px, py, pz, dx, dy, dz, ox, oy, R, z0, z1) && (!found || tMin < bt)) {
        found = true;
        bt = tMin;
        bx = nx;
        by = ny;
        bz = nz;
      }
    }
    if (!found) return false;
    tMin = bt;
    nx = bx;
    ny = by;
    nz = bz;
    depth = 0.0;
    return true;
  }

  /** `Sweep`'s test for posed solid `i` (index `w.count_ + j`). */
  bool PosedSweep(double px, double py, double pz, double dx, double dy, double dz, int i, double height) {
    const int j = i - w.count_;
    const std::uint8_t kind = p.kind[j];
    if (kind == static_cast<std::uint8_t>(PosedSolid::Kind::Box)) return SlabIn(PosedBounds(), px, py, pz, dx, dy, dz, j, height, i);
    if (kind == static_cast<std::uint8_t>(PosedSolid::Kind::OBox)) return OBoxSweep(px, py, pz, dx, dy, dz, j, i, height);
    return DiscSweep(px, py, pz, dx, dy, dz, j, i, height);
  }

  /** `sweep(px, py, pz, dx, dy, dz)`: the first solid the hull meets along the move, chosen on the raw
   *  t (a tie to the lower index); `tMin` is then that hit's fraction max(0, t − 0.0001) with `hit`
   *  and its normal, or 1 and no hit. */
  void Sweep(double px, double py, double pz, double dx, double dy, double dz) {
    const double height = HullAt(duck);
    const double ex = px + dx;
    const double ey = py + dy;
    const double ez = pz + dz;
    Query(px < ex ? px : ex, py < ey ? py : ey, pz < ez ? pz : ez, px < ex ? ex : px, py < ey ? ey : py,
          (pz < ez ? ez : pz) + height);
    const int n = Visits();
    bool found = false;
    double bestT = 0.0;
    int bestI = 0;
    double bnx = 0.0;
    double bny = 0.0;
    double bnz = 0.0;
    double bd = 0.0;
    for (int k = 0; k < n; ++k) {
      const int i = SolidAt(k);
      const bool solidHit = i < w.boxCount_ ? Slab(px, py, pz, dx, dy, dz, i, height)
                            : i < w.count_ ? Wedge(px, py, pz, dx, dy, dz, i, height)
                                           : PosedSweep(px, py, pz, dx, dy, dz, i, height);
      // The least (raw fraction, index): a tie goes to the lower index, in any visiting order.
      if (solidHit && (!found || tMin < bestT || (tMin == bestT && i < bestI))) {
        found = true;
        bestT = tMin;
        bestI = i;
        bnx = nx;
        bny = ny;
        bnz = nz;
        bd = depth;
      }
    }
    hit = found;
    if (found) {
      tMin = Max(0.0, bestT - 0.0001);
      nx = bnx;
      ny = bny;
      nz = bnz;
      depth = bd;
    } else {
      tMin = 1.0;
      depth = 0.0;
    }
  }

  /** `slideMove(T)`: move along the velocity, clipping it against what the hull hits, up to four times.
   *  With `car`, vehicle's ground slide (§17.7): after step 4 the hit's normal is read by its z, a face
   *  the car can drive on (nz ≥ standable) lifts the velocity onto it with its vx and vy unchanged, and
   *  a face too steep to drive on (0 < nz < standable) is a wall, its normal made level for steps 5–8.
   *  Without `car` (firstperson, and vehicle in the air) it is the slide exactly as written. */
  void SlideMove(double T, bool car = false) {
    double remaining = T;
    bool hasPrev = false;
    double qx = 0.0;
    double qy = 0.0;
    double qz = 0.0;
    for (int bump = 0; bump < 4 && remaining > 0.000001; ++bump) {
      if (vx * vx + vy * vy + vz * vz < 0.00000001) return;
      Sweep(x, y, z, vx * remaining, vy * remaining, vz * remaining);
      const double t = tMin;
      if (t > 0) {
        const double used = t * remaining;
        x = x + vx * used;
        y = y + vy * used;
        z = z + vz * used;
        remaining = remaining - used;
      }
      if (!hit) return;
      if (depth > 0) {
        // Started inside the solid: out through its face first (the face as hit, before the ground
        // slide levels it), then the skin as for any hit.
        x = x + nx * depth;
        y = y + ny * depth;
        z = z + nz * depth;
      }
      double hx = nx;
      double hy = ny;
      double hz = nz;
      bool lift = false;
      if (car && hz > 0) {
        if (hz >= standable) {
          lift = true;
        } else {
          const double k = 1.0 / std::sqrt(hx * hx + hy * hy);
          hx = hx * k;
          hy = hy * k;
          hz = 0.0;
        }
      }
      x = x + hx * skin;
      y = y + hy * skin;
      z = z + hz * skin;
      const double into = vx * hx + vy * hy + vz * hz;
      if (into < 0) {
        if (lift) {
          vz = vz - into / hz;
        } else {
          vx = vx + hx * -into;
          vy = vy + hy * -into;
          vz = vz + hz * -into;
        }
      }
      if (hasPrev) {
        double cx = qy * hz - qz * hy;
        double cy = qz * hx - qx * hz;
        double cz = qx * hy - qy * hx;
        const double L = cx * cx + cy * cy + cz * cz;
        if (L > 0.000001) {
          const double inv = 1.0 / std::sqrt(L);
          cx = cx * inv;
          cy = cy * inv;
          cz = cz * inv;
          const double along = vx * cx + vy * cy + vz * cz;
          vx = cx * along;
          vy = cy * along;
          vz = cz * along;
        }
      }
      hasPrev = true;
      qx = hx;
      qy = hy;
      qz = hz;
      if (vx * vx + vy * vy + vz * vz < 0.00000001) return;
    }
  }

  /** `groundMove()`: the plain slide, or the same slide from a ledge's height when that goes further
   *  (each slide vehicle's ground slide with `car`). */
  void GroundMove(bool car = false) {
    const double x0 = x, y0 = y, z0 = z;
    const double vx0 = vx, vy0 = vy, vz0 = vz;
    SlideMove(h, car);
    const double x1 = x, y1 = y, z1 = z;
    const double vx1 = vx, vy1 = vy, vz1 = vz;
    const double ax1 = x1 - x0;
    const double ay1 = y1 - y0;
    const double flat = ax1 * ax1 + ay1 * ay1;
    x = x0;
    y = y0;
    z = z0;
    vx = vx0;
    vy = vy0;
    vz = vz0;
    const double lift = stepHeight + skin;
    Sweep(x0, y0, z0, 0.0, 0.0, lift);
    const double t = tMin;
    const double zl = z0 + lift * t;
    if (t > 0 && Fits(x0, y0, zl, HullAt(duck))) {
      z = zl;
      SlideMove(h, car);
      const double g = TraceDown(x, y, z, stepHeight * 2, 0.001);
      if (!IsNaN(g)) z = g;
      const double bx = x - x0;
      const double by = y - y0;
      const double stepped = bx * bx + by * by;
      if (!IsNaN(g) && stepped > flat + 0.001 * unit * unit) {
        vz = 0.0;
        return;
      }
    }
    x = x1;
    y = y1;
    z = z1;
    vx = vx1;
    vy = vy1;
    vz = vz1;
  }

  /** `stayOnGround()`: Source's StayOnGround, down to stepHeight below the feet. */
  void StayOnGround() {
    const double g = TraceDown(x, y, z, stepHeight, groundSnap);
    if (!IsNaN(g)) {
      z = g;
      vz = 0.0;
    }
  }
};

/** One `firstperson` step's working state (presets.ts Mover): the params as float32, the body, and scratch. */
struct Mover : Hull {
  double maxSpeed = 0, walkSpeed = 0, crouchSpeed = 0, accelerate = 0, airAccelerate = 0, airMaxWishSpeed = 0;
  double friction = 0, stopSpeed = 0, gravity = 0, jumpImpulse = 0, maxVelocity = 0, duckTime = 0, cap = 1;
  bool ducking = false, jumpHeld = false;
  /** The input's jump edge, until a jump spends it. */
  bool pressed = false;
  double dirX = 0, dirY = 0, amount = 0, base = 0, wishSpeed = 0;

  Mover(const FirstpersonWorld& world, const PosedWorld* posed) : Hull(world, posed) {}

  /** `friction()`. */
  void ApplyFriction() {
    const double speed = std::sqrt(vx * vx + vy * vy);
    if (speed < 0.1 * unit) {
      vx = 0.0;
      vy = 0.0;
      return;
    }
    const double control = speed < stopSpeed ? stopSpeed : speed;
    const double drop = control * friction * h;
    const double keep = Max(0.0, speed - drop) / speed;
    vx = vx * keep;
    vy = vy * keep;
  }

  /** `accelerate()`. */
  void GroundAccelerate() {
    const double add = wishSpeed - (vx * dirX + vy * dirY);
    if (add <= 0) return;
    // maxSpeed, not base: cap never weakens the push.
    double a = accelerate * h * Max(wishSpeed, maxSpeed);
    if (a > add) a = add;
    vx = vx + a * dirX;
    vy = vy + a * dirY;
  }

  /** `airAccelerate()`. */
  void AirAccelerate() {
    const double add = Min(wishSpeed, airMaxWishSpeed) - (vx * dirX + vy * dirY);
    if (add <= 0) return;
    double a = airAccelerate * wishSpeed * h;
    if (a > add) a = add;
    vx = vx + a * dirX;
    vy = vy + a * dirY;
  }

  /** One sub-step (§17.7's nine). `pressed` is the input's jump edge, spent by a jump. */
  bool airDuck = true;
  double jogSpeed = 1.0;
  bool jogging = false;

  void SubStep(bool duckDown, bool walk) {
    // 1. duck()
    const double rate = h / duckTime;
    if (duckDown && !onGround && !airDuck) {
      // The hold stays as it is: no duck starts or deepens in the air.
    } else if (duckDown) {
      const double next = Min(1.0, duck + rate);
      // In the air the hull shrinks from below: its top stays put.
      if (!onGround) z = z + (HullAt(duck) - HullAt(next));
      duck = next;
      ducking = true;
    } else if (duck > 0) {
      const double next = Max(0.0, duck - rate);
      const double zn = onGround ? z : z - (HullAt(next) - HullAt(duck));
      if (Fits(x, y, zn, HullAt(next))) {
        duck = next;
        z = zn;
        if (duck == 0) ducking = false;
      }
    }
    // 2.
    const bool was = onGround;
    CheckGround();
    if (onGround && !was) vz = 0.0;
    // 3.
    base = maxSpeed * cap;
    const double target = ducking ? base * crouchSpeed : walk ? base * walkSpeed : jogging ? base * jogSpeed : base;
    wishSpeed = amount * target;
    // 4.
    if (onGround) {
      if (pressed) {
        vz = jumpImpulse;
        onGround = false;
        pressed = false;
        AirAccelerate();
      } else {
        ApplyFriction();
        GroundAccelerate();
        vz = 0.0;
      }
    } else {
      AirAccelerate();
    }
    // 5.
    const bool falling = !onGround;
    if (falling) vz = vz - gravity * h * 0.5;
    // 6.
    vx = Clamp(vx, -maxVelocity, maxVelocity);
    vy = Clamp(vy, -maxVelocity, maxVelocity);
    vz = Clamp(vz, -maxVelocity, maxVelocity);
    // 7.
    if (onGround) {
      GroundMove();
      StayOnGround();
    } else {
      SlideMove(h);
    }
    // 8.
    CheckGround();
    if (falling && !onGround) {
      vz = vz - gravity * h * 0.5;
    } else if (onGround) {
      vz = 0.0;
    }
    // 9.
    x = Stored(x);
    y = Stored(y);
    z = Stored(z);
    vx = Stored(vx);
    vy = Stored(vy);
    vz = Stored(vz);
    duck = UnsignedZero(F32(duck));
  }
};

/** `toward(v, target, d)`, `d ≥ 0`: `v` moved by at most `d` toward `target`, never past it. */
double Toward(double v, double target, double d) { return v < target ? Min(target, v + d) : v > target ? Max(target, v - d) : v; }

/** `wrap(v)`: topdown's step 5 for a usable value (−float32(π) for float32(π), −0 as 0). */
double Wrap(double v) {
  const std::optional<double> wrapped = presets::WrappedAngle(v);
  return wrapped ? *wrapped : 0.0;
}

/** One `vehicle` step's working state (presets.ts Car): the params as float32, the input, the body. */
struct Car : Hull {
  double maxSpeed = 0, accel = 0, brake = 0, coast = 0, boostAccel = 0, boostMaxSpeed = 0, boostBurn = 0;
  double grip = 0, driftGrip = 0, turnRate = 0, turnSpeed = 0, spinAccel = 0, airTurnRate = 0, airSpinAccel = 0;
  double gravity = 0, jumpImpulse = 0, maxVelocity = 0, cap = 1;
  double steer = 0, throttle = 0;
  bool boost = false, drift = false;
  double yaw = 0, spin = 0, fuel = 0;
  bool jumpHeld = false;
  /** The input's jump edge, until a jump spends it. */
  bool pressed = false;
  bool boosting = false;
  /** Sub-step step 2: the heading's cosine and sine, the speed along it and across it (+90°). */
  double c = 1, s = 0, f = 0, l = 0;

  Car(const FirstpersonWorld& world, const PosedWorld* posed) : Hull(world, posed) {}

  /** `drive()`: throttle, brake, coast and boost along the heading, grip across it, the yaw rate. */
  void Drive() {
    // 1.
    const double top = maxSpeed * cap;
    const double t = boosting ? 1.0 : throttle;
    const double target = t * top;
    // 2. The forward speed.
    double fw = f;
    if (t == 0) {
      fw = Toward(fw, 0.0, coast * h);
    } else if ((t > 0 && fw < 0) || (t < 0 && fw > 0)) {
      fw = Toward(fw, 0.0, brake * h);
    } else if (std::fabs(fw) < std::fabs(target)) {
      fw = Toward(fw, target, accel * h);
    } else if (!boosting) {
      fw = Toward(fw, target, coast * h);
    }
    // 3.
    if (boosting) {
      const double boostTop = boostMaxSpeed * cap;
      if (fw < boostTop) fw = Min(boostTop, fw + boostAccel * h);
    }
    // 4.
    const double lw = Toward(l, 0.0, (drift ? driftGrip : grip) * h);
    // 5. Reverse steering is mirrored.
    double want = steer * turnRate * Min(1.0, std::fabs(fw) / turnSpeed);
    if (fw < 0) want = -want;
    spin = Toward(spin, want, spinAccel * h);
    // 6. The velocity rebuilt on the axes it was measured on.
    vx = fw * c - lw * s;
    vy = fw * s + lw * c;
    vz = 0.0;
    f = fw;
    l = lw;
  }

  /** `air()`: steering by the air rules, and boost along the level heading. */
  void Air() {
    spin = Toward(spin, steer * airTurnRate, airSpinAccel * h);
    if (boosting) {
      const double boostTop = boostMaxSpeed * cap;
      if (f < boostTop) {
        const double a = Min(boostAccel * h, boostTop - f);
        vx = vx + a * c;
        vy = vy + a * s;
      }
    }
  }

  /** One sub-step (§17.7's eleven). */
  void SubStep() {
    // 1.
    const bool was = onGround;
    CheckGround();
    if (onGround && !was) vz = 0.0;
    // 2.
    const presets::SinCos sc = presets::PSinCos(yaw);
    c = sc.cos;
    s = sc.sin;
    f = vx * c + vy * s;
    l = vy * c - vx * s;
    // 3. The sub-step that empties the tank still boosts.
    boosting = boost && fuel > 0;
    if (boosting) fuel = Max(0.0, fuel - boostBurn * h);
    // 4.
    if (onGround && pressed) {
      vz = jumpImpulse;
      onGround = false;
      pressed = false;
    }
    // 5. The sub-step that jumps steers by the air rules.
    if (onGround) {
      Drive();
    } else {
      Air();
    }
    // 6.
    const bool falling = !onGround;
    if (falling) vz = vz - gravity * h * 0.5;
    // 7.
    vx = Clamp(vx, -maxVelocity, maxVelocity);
    vy = Clamp(vy, -maxVelocity, maxVelocity);
    vz = Clamp(vz, -maxVelocity, maxVelocity);
    // 8.
    yaw = Wrap(yaw + spin * h);
    // 9. On the ground each slide is the car's ground slide; a wall clips the velocity, nothing bounces.
    if (onGround) {
      GroundMove(true);
      StayOnGround();
    } else {
      SlideMove(h);
    }
    // 10.
    CheckGround();
    if (falling && !onGround) {
      vz = vz - gravity * h * 0.5;
    } else if (onGround) {
      vz = 0.0;
    }
    // 11.
    x = Stored(x);
    y = Stored(y);
    z = Stored(z);
    vx = Stored(vx);
    vy = Stored(vy);
    vz = Stored(vz);
    spin = UnsignedZero(F32(spin));
    fuel = UnsignedZero(F32(fuel));
  }
};

// ---- the world: validation, hash, tables, tree ----

template <typename P>
struct ParamRangeOf {
  const char* key;
  double P::*field;
  double min;
  double max;
  bool positive;
  bool integer;
};
using ParamRange = ParamRangeOf<FirstpersonParams>;
using VehicleRange = ParamRangeOf<VehicleParams>;

/** presets.ts FIRSTPERSON_RANGE, in §17.7's order. */
constexpr ParamRange kRange[] = {
    {"maxSpeed", &FirstpersonParams::maxSpeed, 0, 10000, false, false},
    {"walkSpeed", &FirstpersonParams::walkSpeed, 0, 1, false, false},
    {"crouchSpeed", &FirstpersonParams::crouchSpeed, 0, 1, false, false},
    {"accelerate", &FirstpersonParams::accelerate, 0, 1000, false, false},
    {"airAccelerate", &FirstpersonParams::airAccelerate, 0, 1000, false, false},
    {"airMaxWishSpeed", &FirstpersonParams::airMaxWishSpeed, 0, 10000, false, false},
    {"friction", &FirstpersonParams::friction, 0, 1000, false, false},
    {"stopSpeed", &FirstpersonParams::stopSpeed, 0, 10000, false, false},
    {"gravity", &FirstpersonParams::gravity, 0, 100000, false, false},
    {"jumpImpulse", &FirstpersonParams::jumpImpulse, 0, 100000, false, false},
    {"maxVelocity", &FirstpersonParams::maxVelocity, 0, 100000, false, false},
    {"radius", &FirstpersonParams::radius, 0, 10000, true, false},
    {"standHeight", &FirstpersonParams::standHeight, 0, 10000, true, false},
    {"crouchHeight", &FirstpersonParams::crouchHeight, 0, 10000, true, false},
    {"duckTime", &FirstpersonParams::duckTime, 0, 100, true, false},
    {"airDuck", &FirstpersonParams::airDuck, 0, 1, false, true},
    {"stepHeight", &FirstpersonParams::stepHeight, 0, 10000, false, false},
    {"standable", &FirstpersonParams::standable, 0, 1, false, false},
    {"groundTrace", &FirstpersonParams::groundTrace, 0, 10000, false, false},
    {"groundSnap", &FirstpersonParams::groundSnap, 0, 10000, false, false},
    {"skin", &FirstpersonParams::skin, 0, 100, false, false},
    {"pitchLimit", &FirstpersonParams::pitchLimit, 0, 1.5707963705062866, false, false},
    {"jumpBit", &FirstpersonParams::jumpBit, 0, kMaskLimit - 1, false, true},
    {"duckBit", &FirstpersonParams::duckBit, 0, kMaskLimit - 1, false, true},
    {"walkBit", &FirstpersonParams::walkBit, 0, kMaskLimit - 1, false, true},
    {"substeps", &FirstpersonParams::substeps, 1, 8, false, true},
    {"capZeroJump", &FirstpersonParams::capZeroJump, 0, 1, false, true},
    {"runBit", &FirstpersonParams::runBit, 0, kMaskLimit - 1, false, true},
    {"jogSpeed", &FirstpersonParams::jogSpeed, 0, 1, false, false},
    {"world", &FirstpersonParams::world, 0, 4294967295.0, false, true},
};

/** presets.ts VEHICLE_RANGE, in §17.7's order. */
constexpr VehicleRange kVehicleRange[] = {
    {"maxSpeed", &VehicleParams::maxSpeed, 0, 100000, false, false},
    {"accel", &VehicleParams::accel, 0, 100000, false, false},
    {"brake", &VehicleParams::brake, 0, 100000, false, false},
    {"coast", &VehicleParams::coast, 0, 100000, false, false},
    {"boostAccel", &VehicleParams::boostAccel, 0, 100000, false, false},
    {"boostMaxSpeed", &VehicleParams::boostMaxSpeed, 0, 100000, false, false},
    {"boostBurn", &VehicleParams::boostBurn, 0, 1000, false, false},
    {"grip", &VehicleParams::grip, 0, 100000, false, false},
    {"driftGrip", &VehicleParams::driftGrip, 0, 100000, false, false},
    {"turnRate", &VehicleParams::turnRate, 0, 100, false, false},
    {"turnSpeed", &VehicleParams::turnSpeed, 0, 100000, true, false},
    {"spinAccel", &VehicleParams::spinAccel, 0, 10000, false, false},
    {"airTurnRate", &VehicleParams::airTurnRate, 0, 100, false, false},
    {"airSpinAccel", &VehicleParams::airSpinAccel, 0, 10000, false, false},
    {"gravity", &VehicleParams::gravity, 0, 100000, false, false},
    {"jumpImpulse", &VehicleParams::jumpImpulse, 0, 100000, false, false},
    {"maxVelocity", &VehicleParams::maxVelocity, 0, 100000, false, false},
    {"radius", &VehicleParams::radius, 0, 10000, true, false},
    {"height", &VehicleParams::height, 0, 10000, true, false},
    {"stepHeight", &VehicleParams::stepHeight, 0, 10000, false, false},
    {"standable", &VehicleParams::standable, 0, 1, false, false},
    {"groundTrace", &VehicleParams::groundTrace, 0, 10000, false, false},
    {"groundSnap", &VehicleParams::groundSnap, 0, 10000, false, false},
    {"skin", &VehicleParams::skin, 0, 100, false, false},
    {"jumpBit", &VehicleParams::jumpBit, 0, kMaskLimit - 1, false, true},
    {"boostBit", &VehicleParams::boostBit, 0, kMaskLimit - 1, false, true},
    {"driftBit", &VehicleParams::driftBit, 0, kMaskLimit - 1, false, true},
    {"substeps", &VehicleParams::substeps, 1, 8, false, true},
    {"capZeroJump", &VehicleParams::capZeroJump, 0, 1, false, true},
    {"world", &VehicleParams::world, 0, 4294967295.0, false, true},
};

template <typename P, std::size_t N>
const ParamRangeOf<P>* RangeIn(const ParamRangeOf<P> (&table)[N], std::string_view key) {
  for (const ParamRangeOf<P>& range : table) {
    if (key == range.key) return &range;
  }
  return nullptr;
}

/** presets.ts presetParamsValid for one value: a finite number in [min, max], an integer when the
 *  range says so, and, for a range that excludes 0, nonzero as the step uses it (float32: 1e-46 is 0). */
template <typename P>
bool InRange(const Json* value, const ParamRangeOf<P>& range) {
  if (value == nullptr || !value->IsNumber()) return false;
  const double v = value->AsNumber();
  if (!std::isfinite(v) || v < range.min || v > range.max) return false;
  if (range.integer && v != std::floor(v)) return false;
  return !range.positive || (v > 0.0 && F32(v) > 0.0);
}

template <typename P, std::size_t N>
bool ParamsValid(const ParamRangeOf<P> (&table)[N], const Json* params) {
  if (params == nullptr) return true;
  if (!params->IsObject()) return false;
  for (const JsonMember& member : params->Members()) {
    const ParamRangeOf<P>* range = RangeIn(table, member.key);
    if (range == nullptr || !InRange(&member.value, *range)) return false;
  }
  return true;
}

template <typename P, std::size_t N>
P ResolveParams(const ParamRangeOf<P> (&table)[N], const P& defaults, const Json* params) {
  P out = defaults;
  if (params == nullptr || !params->IsObject()) return out;
  for (const ParamRangeOf<P>& range : table) {
    const Json* value = params->Find(range.key);
    if (InRange(value, range)) out.*range.field = value->AsNumber();
  }
  return out;
}

/** `v`'s low 10 bits spread to every third bit (the Morton code's one axis). */
std::uint32_t Spread3(std::uint32_t v) {
  std::uint32_t x = v & 0x3ffu;
  x = (x | (x << 16)) & 0x030000ffu;
  x = (x | (x << 8)) & 0x0300f00fu;
  x = (x | (x << 4)) & 0x030c30c3u;
  x = (x | (x << 2)) & 0x09249249u;
  return x;
}

std::uint32_t Cell(double v, double lo, double hi) {
  return hi > lo ? static_cast<std::uint32_t>(Min(1023.0, std::floor(((v - lo) / (hi - lo)) * 1024.0))) : 0u;
}

/** One validated value (presets.ts worldValue); false and `error` set when refused. */
bool WorldValue(double v, const std::string& path, double& out, std::string* error) {
  if (!std::isfinite(v)) {
    if (error != nullptr) *error = "firstperson world: " + path + " is not a finite number";
    return false;
  }
  if (F32(v) != v) {
    if (error != nullptr) *error = "firstperson world: " + path + " is not a float32";
    return false;
  }
  if (std::fabs(v) > kMaxAbs) {
    if (error != nullptr) *error = "firstperson world: " + path + " is past ±1000000000";
    return false;
  }
  out = UnsignedZero(v);
  return true;
}

bool Refuse(std::string* error, const std::string& path, const std::string& message) {
  if (error != nullptr) *error = "firstperson world: " + path + " " + message;
  return false;
}

template <std::size_t N>
bool CheckSolid(std::array<double, N>& v, const std::string& path, std::string* error) {
  for (std::size_t i = 0; i < N; ++i) {
    if (!WorldValue(v[i], path + "[" + std::to_string(i) + "]", v[i], error)) return false;
  }
  if (!(v[0] < v[3] && v[1] < v[4] && v[2] < v[5])) return Refuse(error, path, "needs min < max on every axis");
  if constexpr (N == 9) {
    if (v[6] != 0.0 && v[6] != 1.0) return Refuse(error, path + "[6]", "is not an axis (0 or 1)");
    const double minZ = v[2], maxZ = v[5], lo = v[7], hi = v[8];
    if (!(minZ <= lo && minZ <= hi)) return Refuse(error, path, "needs minZ ≤ lo and minZ ≤ hi");
    if (maxZ != Max(lo, hi)) return Refuse(error, path, "needs maxZ = max(lo, hi)");
  }
  return true;
}

/** A JSON solid list (presets.ts solidList + solidValues): absent = none. */
template <std::size_t N>
bool ReadSolids(const Json* list, const char* key, int max, std::vector<std::array<double, N>>& out,
                std::string* error) {
  out.clear();
  if (list == nullptr) return true;
  if (!list->IsArray()) return Refuse(error, key, "is not an array");
  if (list->Size() > static_cast<std::size_t>(max)) return Refuse(error, key, "holds more than " + std::to_string(max));
  out.reserve(list->Size());
  for (std::size_t s = 0; s < list->Size(); ++s) {
    const Json& raw = list->At(s);
    const std::string path = std::string(key) + "[" + std::to_string(s) + "]";
    if (!raw.IsArray() || raw.Size() != N) return Refuse(error, path, "is not an array of " + std::to_string(N) + " numbers");
    std::array<double, N> v{};
    for (std::size_t i = 0; i < N; ++i) {
      const Json& value = raw.At(i);
      if (!value.IsNumber()) {
        return Refuse(error, path + "[" + std::to_string(i) + "]", "is not a finite number");
      }
      v[i] = value.AsNumber();
    }
    out.push_back(v);
  }
  return true;
}

void AppendU32(std::uint32_t& hash, std::uint32_t word) {
  for (int b = 0; b < 4; ++b) {
    hash = (hash ^ ((word >> (8 * b)) & 0xffu)) * 16777619u;
  }
}

std::uint32_t F32Bits(double v) {
  const float f = static_cast<float>(v);
  std::uint32_t bits = 0;
  std::memcpy(&bits, &f, sizeof bits);
  return bits;
}

/** 32-bit FNV-1a over the counts (LE u32), then every box's six values and every ramp's nine (LE
 *  binary32), over values already validated (float32, −0 read as 0). */
std::uint32_t WorldHash(const std::vector<FirstpersonWorld::Box>& boxes, const std::vector<FirstpersonWorld::Ramp>& ramps) {
  std::uint32_t hash = 2166136261u;
  AppendU32(hash, static_cast<std::uint32_t>(boxes.size()));
  AppendU32(hash, static_cast<std::uint32_t>(ramps.size()));
  for (const FirstpersonWorld::Box& b : boxes) {
    for (double v : b) AppendU32(hash, F32Bits(v));
  }
  for (const FirstpersonWorld::Ramp& r : ramps) {
    for (double v : r) AppendU32(hash, F32Bits(v));
  }
  return hash;
}

}  // namespace genex::firstperson_detail

namespace genex {

namespace fpd = firstperson_detail;

FirstpersonWorld::~FirstpersonWorld() = default;

std::shared_ptr<const FirstpersonWorld> FirstpersonWorld::Empty() {
  static const std::shared_ptr<const FirstpersonWorld> empty = FromSolids({}, {});
  return empty;
}

std::shared_ptr<const FirstpersonWorld> FirstpersonWorld::FromSolids(const std::vector<Box>& boxes,
                                                                      const std::vector<Ramp>& ramps,
                                                                      std::string* error, bool broadphase) {
  if (boxes.size() > static_cast<std::size_t>(kMaxBoxes)) {
    fpd::Refuse(error, "boxes", "holds more than " + std::to_string(kMaxBoxes));
    return nullptr;
  }
  if (ramps.size() > static_cast<std::size_t>(kMaxRamps)) {
    fpd::Refuse(error, "ramps", "holds more than " + std::to_string(kMaxRamps));
    return nullptr;
  }
  std::shared_ptr<FirstpersonWorld> world(new FirstpersonWorld());
  world->boxes_ = boxes;
  world->ramps_ = ramps;
  for (std::size_t i = 0; i < world->boxes_.size(); ++i) {
    if (!fpd::CheckSolid(world->boxes_[i], "boxes[" + std::to_string(i) + "]", error)) return nullptr;
  }
  for (std::size_t i = 0; i < world->ramps_.size(); ++i) {
    if (!fpd::CheckSolid(world->ramps_[i], "ramps[" + std::to_string(i) + "]", error)) return nullptr;
  }
  world->hash_ = fpd::WorldHash(world->boxes_, world->ramps_);
  world->Compile(broadphase);
  return world;
}

std::shared_ptr<const FirstpersonWorld> FirstpersonWorld::FromJson(const Json* spec, std::string* error, bool broadphase) {
  if (spec == nullptr) return broadphase ? Empty() : Empty()->WithBroadphase(false);
  if (!spec->IsObject()) {
    fpd::Refuse(error, "$", "is not an object");
    return nullptr;
  }
  std::vector<Box> boxes;
  std::vector<Ramp> ramps;
  if (!fpd::ReadSolids(spec->Find("boxes"), "boxes", kMaxBoxes, boxes, error)) return nullptr;
  if (!fpd::ReadSolids(spec->Find("ramps"), "ramps", kMaxRamps, ramps, error)) return nullptr;
  return FromSolids(boxes, ramps, error, broadphase);
}

std::shared_ptr<const FirstpersonWorld> FirstpersonWorld::FromJsonText(std::string_view text, std::string* error,
                                                                        bool broadphase) {
  // The reader's default limit is for messages: a full world is a value for each number, its solid and its list.
  JsonLimits limits;
  limits.maxNodes = (std::max)(limits.maxNodes, fpd::kWorldJsonNodes);
  std::string parseError;
  const std::optional<Json> spec = Json::Parse(text, &parseError, limits);
  if (!spec) {
    if (error != nullptr) *error = "firstperson world: not JSON: " + parseError;
    return nullptr;
  }
  return FromJson(&*spec, error, broadphase);
}

std::shared_ptr<const FirstpersonWorld> FirstpersonWorld::WithBroadphase(bool broadphase) const {
  std::shared_ptr<FirstpersonWorld> world(new FirstpersonWorld());
  world->boxes_ = boxes_;
  world->ramps_ = ramps_;
  world->hash_ = hash_;
  world->Compile(broadphase);
  return world;
}

void FirstpersonWorld::Compile(bool broadphase) {
  boxCount_ = static_cast<int>(boxes_.size());
  count_ = boxCount_ + static_cast<int>(ramps_.size());
  const std::size_t n = static_cast<std::size_t>(count_);
  for (std::vector<double>* table : {&minX_, &minY_, &minZ_, &maxX_, &maxY_, &maxZ_, &lo_, &hi_, &m0_, &span_, &slope_, &topZ_}) {
    table->assign(n, 0.0);
  }
  axis_.assign(n, 0);
  for (int i = 0; i < count_; ++i) {
    const double* s = i < boxCount_ ? boxes_[static_cast<std::size_t>(i)].data()
                                    : ramps_[static_cast<std::size_t>(i - boxCount_)].data();
    minX_[i] = s[0];
    minY_[i] = s[1];
    minZ_[i] = s[2];
    maxX_[i] = s[3];
    maxY_[i] = s[4];
    maxZ_[i] = s[5];
    if (i < boxCount_) continue;
    const double axis = s[6];
    const double m0 = axis == 0.0 ? s[0] : s[1];
    const double m1 = axis == 0.0 ? s[3] : s[4];
    const double span = m1 - m0;
    const double slope = (s[8] - s[7]) / span;
    axis_[i] = axis == 0.0 ? 0 : 1;
    lo_[i] = s[7];
    hi_[i] = s[8];
    m0_[i] = m0;
    span_[i] = span;
    slope_[i] = slope;
    topZ_[i] = 1.0 / std::sqrt(1.0 + slope * slope);
  }
  treeBoxes_.clear();
  treeRef_.clear();
  treeLevelEnd_.clear();
  treeRoot_ = -1;
  if (broadphase && count_ > 0) BuildTree();
}

namespace firstperson_detail {
/** presets.ts leafOrder: every solid's index, by the Morton code of its box's centre over the world's
 *  extent, ties by index. */
template <typename Bound>
std::vector<int> LeafOrder(int n, const Bound& bound) {
  double x0 = std::numeric_limits<double>::infinity(), y0 = x0, z0 = x0;
  double x1 = -x0, y1 = -x0, z1 = -x0;
  for (int i = 0; i < n; ++i) {
    x0 = Min(x0, bound(i, 0));
    y0 = Min(y0, bound(i, 1));
    z0 = Min(z0, bound(i, 2));
    x1 = Max(x1, bound(i, 3));
    y1 = Max(y1, bound(i, 4));
    z1 = Max(z1, bound(i, 5));
  }
  // A key per solid: its centre's Morton code (10 bits an axis) above its index, so a plain numeric
  // sort orders them and keeps the index.
  std::vector<std::uint64_t> keys(static_cast<std::size_t>(n));
  for (int i = 0; i < n; ++i) {
    const std::uint32_t cx = Cell((bound(i, 0) + bound(i, 3)) / 2, x0, x1);
    const std::uint32_t cy = Cell((bound(i, 1) + bound(i, 4)) / 2, y0, y1);
    const std::uint32_t cz = Cell((bound(i, 2) + bound(i, 5)) / 2, z0, z1);
    const std::uint64_t code = Spread3(cx) | (Spread3(cy) << 1) | (Spread3(cz) << 2);
    keys[static_cast<std::size_t>(i)] = code * kTreeKeyRadix + static_cast<std::uint64_t>(i);
  }
  std::sort(keys.begin(), keys.end());
  std::vector<int> order(static_cast<std::size_t>(n));
  for (int k = 0; k < n; ++k) order[static_cast<std::size_t>(k)] = static_cast<int>(keys[static_cast<std::size_t>(k)] % kTreeKeyRadix);
  return order;
}
}  // namespace firstperson_detail

std::vector<int> FirstpersonWorld::TreeOrder(const std::vector<Box>& bounds) {
  return fpd::LeafOrder(static_cast<int>(bounds.size()), [&](int i, int k) { return bounds[static_cast<std::size_t>(i)][static_cast<std::size_t>(k)]; });
}

/** presets.ts buildTree: the solids in LeafOrder, then packed level by level. */
void FirstpersonWorld::BuildTree() {
  const int n = count_;
  const double* const tables[] = {minX_.data(), minY_.data(), minZ_.data(), maxX_.data(), maxY_.data(), maxZ_.data()};
  const std::vector<int> order = fpd::LeafOrder(n, [&](int i, int k) { return tables[k][i]; });
  std::vector<int> sizes{n};
  while (sizes.back() > 1) sizes.push_back((sizes.back() + fpd::kTreeFanout - 1) / fpd::kTreeFanout);
  int total = 0;
  for (int s : sizes) total += s;
  treeBoxes_.assign(static_cast<std::size_t>(total) * 6, 0.0);
  treeRef_.assign(static_cast<std::size_t>(total), 0);
  treeLevelEnd_.assign(sizes.size(), 0);
  for (int k = 0; k < n; ++k) {
    const int i = order[static_cast<std::size_t>(k)];
    const std::size_t o = static_cast<std::size_t>(k) * 6;
    treeBoxes_[o] = minX_[i];
    treeBoxes_[o + 1] = minY_[i];
    treeBoxes_[o + 2] = minZ_[i];
    treeBoxes_[o + 3] = maxX_[i];
    treeBoxes_[o + 4] = maxY_[i];
    treeBoxes_[o + 5] = maxZ_[i];
    treeRef_[static_cast<std::size_t>(k)] = i;
  }
  treeLevelEnd_[0] = n;
  int from = 0;
  int at = n;
  for (std::size_t level = 1; level < sizes.size(); ++level) {
    const int end = treeLevelEnd_[level - 1];
    for (int child = from; child < end; child += fpd::kTreeFanout) {
      const int last = (std::min)(child + fpd::kTreeFanout, end);
      double a = std::numeric_limits<double>::infinity(), b = a, c = a, d = -a, e = -a, g = -a;
      for (int k = child; k < last; ++k) {
        const std::size_t o = static_cast<std::size_t>(k) * 6;
        a = fpd::Min(a, treeBoxes_[o]);
        b = fpd::Min(b, treeBoxes_[o + 1]);
        c = fpd::Min(c, treeBoxes_[o + 2]);
        d = fpd::Max(d, treeBoxes_[o + 3]);
        e = fpd::Max(e, treeBoxes_[o + 4]);
        g = fpd::Max(g, treeBoxes_[o + 5]);
      }
      const std::size_t o = static_cast<std::size_t>(at) * 6;
      treeBoxes_[o] = a;
      treeBoxes_[o + 1] = b;
      treeBoxes_[o + 2] = c;
      treeBoxes_[o + 3] = d;
      treeBoxes_[o + 4] = e;
      treeBoxes_[o + 5] = g;
      treeRef_[static_cast<std::size_t>(at)] = child;
      ++at;
    }
    from = end;
    treeLevelEnd_[level] = at;
  }
  treeRoot_ = total - 1;
}

namespace presets {

bool FirstpersonParamsValid(const Json* params) { return fpd::ParamsValid(fpd::kRange, params); }

FirstpersonParams ResolveFirstpersonParams(const Json* params) {
  return fpd::ResolveParams(fpd::kRange, kFirstpersonDefaults, params);
}

bool VehicleParamsValid(const Json* params) { return fpd::ParamsValid(fpd::kVehicleRange, params); }

VehicleParams ResolveVehicleParams(const Json* params) {
  return fpd::ResolveParams(fpd::kVehicleRange, kVehicleDefaults, params);
}

FirstpersonBody StepFirstperson(const FirstpersonBody& body, double moveX, double moveY, double yaw, double pitch,
                                double buttons, double dt, const FirstpersonParams& params,
                                const FirstpersonWorld& world, const PosedWorld* posed) {
  std::vector<std::int32_t>& candidates = fpd::CandidateBuffer();
  if (candidates.size() < static_cast<std::size_t>(world.SolidCount())) candidates.resize(static_cast<std::size_t>(world.SolidCount()));
  const std::uint32_t mstate = static_cast<std::uint32_t>(Mask(body.mstate)) &
                               (firstperson_state::kOnGround | firstperson_state::kDucking | firstperson_state::kJumpHeld);
  fpd::Mover m(world, posed);
  m.cand = candidates.data();
  m.maxSpeed = fpd::F32(params.maxSpeed);
  m.walkSpeed = fpd::F32(params.walkSpeed);
  m.crouchSpeed = fpd::F32(params.crouchSpeed);
  m.accelerate = fpd::F32(params.accelerate);
  m.airAccelerate = fpd::F32(params.airAccelerate);
  m.airMaxWishSpeed = fpd::F32(params.airMaxWishSpeed);
  m.friction = fpd::F32(params.friction);
  m.stopSpeed = fpd::F32(params.stopSpeed);
  m.gravity = fpd::F32(params.gravity);
  m.jumpImpulse = fpd::F32(params.jumpImpulse);
  m.maxVelocity = fpd::F32(params.maxVelocity);
  m.r = fpd::F32(params.radius);
  m.unit = fpd::UnitOf(m.r, 16.0);
  m.standHeight = fpd::F32(params.standHeight);
  m.crouchHeight = fpd::F32(params.crouchHeight);
  m.duckTime = fpd::F32(params.duckTime);
  m.airDuck = params.airDuck != 0;
  m.jogSpeed = fpd::F32(params.jogSpeed);
  m.stepHeight = fpd::F32(params.stepHeight);
  m.standable = fpd::F32(params.standable);
  m.groundTrace = fpd::F32(params.groundTrace);
  m.groundSnap = fpd::F32(params.groundSnap);
  m.skin = fpd::F32(params.skin);
  m.x = fpd::BodyValue(body.x, 0.0, -fpd::kMaxAbs, fpd::kMaxAbs);
  m.y = fpd::BodyValue(body.y, 0.0, -fpd::kMaxAbs, fpd::kMaxAbs);
  m.z = fpd::BodyValue(body.z, 0.0, -fpd::kMaxAbs, fpd::kMaxAbs);
  m.vx = fpd::BodyValue(body.vx, 0.0, -fpd::kMaxAbs, fpd::kMaxAbs);
  m.vy = fpd::BodyValue(body.vy, 0.0, -fpd::kMaxAbs, fpd::kMaxAbs);
  m.vz = fpd::BodyValue(body.vz, 0.0, -fpd::kMaxAbs, fpd::kMaxAbs);
  m.duck = fpd::BodyValue(body.duck, 0.0, 0.0, 1.0);
  m.cap = fpd::BodyValue(body.cap, 1.0, 0.0, 4.0);
  m.onGround = (mstate & firstperson_state::kOnGround) != 0;
  m.ducking = (mstate & firstperson_state::kDucking) != 0;
  m.jumpHeld = (mstate & firstperson_state::kJumpHeld) != 0;
  // 1. The wish direction, in world axes.
  const double mx = Axis(moveX);
  const double my = Axis(moveY);
  const double len = std::sqrt(mx * mx + my * my);
  if (len > 0.0001) {
    m.dirX = mx / len;
    m.dirY = my / len;
    m.amount = fpd::Min(len, 1.0);
  }
  // 2.
  const std::uint32_t held = static_cast<std::uint32_t>(Mask(buttons));
  const bool jump = (held & static_cast<std::uint32_t>(params.jumpBit)) != 0;
  const bool duckDown = (held & static_cast<std::uint32_t>(params.duckBit)) != 0;
  const bool walk = (held & static_cast<std::uint32_t>(params.walkBit)) != 0;
  m.jogging = params.runBit != 0 && (held & static_cast<std::uint32_t>(params.runBit)) == 0;
  // 3.
  const double step = StepSeconds(dt, kMaxDtSeconds);
  m.h = step / params.substeps;
  // 4.
  const std::optional<double> wrappedYaw = WrappedAngle(yaw);
  const double nextYaw = wrappedYaw ? *wrappedYaw : fpd::BodyAngle(body.yaw);
  const double pitchLimit = fpd::F32(params.pitchLimit);
  const std::optional<double> wrappedPitch = WrappedAngle(pitch);
  const double nextPitch =
      fpd::UnsignedZero(fpd::Clamp(wrappedPitch ? *wrappedPitch : fpd::BodyAngle(body.pitch), -pitchLimit, pitchLimit));
  // 5. The jump edge, once per input, then the sub-steps.
  if (step > 0) {
    m.pressed = jump && !m.jumpHeld && (params.capZeroJump != 0 || m.cap != 0);
    m.jumpHeld = jump;
    const int substeps = static_cast<int>(params.substeps);
    for (int i = 0; i < substeps; ++i) m.SubStep(duckDown, walk);
  }
  // 6.
  FirstpersonBody next;
  next.x = m.x;
  next.y = m.y;
  next.z = m.z;
  next.vx = m.vx;
  next.vy = m.vy;
  next.vz = m.vz;
  next.yaw = nextYaw;
  next.pitch = nextPitch;
  next.duck = m.duck;
  next.mstate = (m.onGround ? 1.0 : 0.0) + (m.ducking ? 2.0 : 0.0) + (m.jumpHeld ? 4.0 : 0.0);
  next.cap = body.cap;
  return next;
}

FirstpersonBody StepFirstperson(const FirstpersonBody& body, const Input& input, double dt,
                                const FirstpersonParams& params, const FirstpersonWorld& world, const PosedWorld* posed) {
  return StepFirstperson(body, input.moveX, input.moveY, input.yaw, input.pitch, input.buttons, dt, params, world, posed);
}

VehicleBody StepVehicle(const VehicleBody& body, double moveX, double moveY, double buttons, double dt,
                        const VehicleParams& params, const FirstpersonWorld& world, const PosedWorld* posed) {
  std::vector<std::int32_t>& candidates = fpd::CandidateBuffer();
  if (candidates.size() < static_cast<std::size_t>(world.SolidCount())) candidates.resize(static_cast<std::size_t>(world.SolidCount()));
  const std::uint32_t mstate = static_cast<std::uint32_t>(Mask(body.mstate)) & (vehicle_state::kOnGround | vehicle_state::kJumpHeld);
  fpd::Car m(world, posed);
  m.cand = candidates.data();
  const double height = fpd::F32(params.height);
  m.r = fpd::F32(params.radius);
  m.unit = fpd::UnitOf(m.r, 50.0);
  m.standHeight = height;
  m.crouchHeight = height;
  m.stepHeight = fpd::F32(params.stepHeight);
  m.standable = fpd::F32(params.standable);
  m.groundTrace = fpd::F32(params.groundTrace);
  m.groundSnap = fpd::F32(params.groundSnap);
  m.skin = fpd::F32(params.skin);
  m.maxSpeed = fpd::F32(params.maxSpeed);
  m.accel = fpd::F32(params.accel);
  m.brake = fpd::F32(params.brake);
  m.coast = fpd::F32(params.coast);
  m.boostAccel = fpd::F32(params.boostAccel);
  m.boostMaxSpeed = fpd::F32(params.boostMaxSpeed);
  m.boostBurn = fpd::F32(params.boostBurn);
  m.grip = fpd::F32(params.grip);
  m.driftGrip = fpd::F32(params.driftGrip);
  m.turnRate = fpd::F32(params.turnRate);
  m.turnSpeed = fpd::F32(params.turnSpeed);
  m.spinAccel = fpd::F32(params.spinAccel);
  m.airTurnRate = fpd::F32(params.airTurnRate);
  m.airSpinAccel = fpd::F32(params.airSpinAccel);
  m.gravity = fpd::F32(params.gravity);
  m.jumpImpulse = fpd::F32(params.jumpImpulse);
  m.maxVelocity = fpd::F32(params.maxVelocity);
  // 1. Steer is −moveX (positive turns toward +yaw), the negation after the sanitizing; neither axis
  // is normalized against the other.
  m.steer = fpd::UnsignedZero(-Axis(moveX));
  m.throttle = Axis(moveY);
  // 2.
  const std::uint32_t held = static_cast<std::uint32_t>(Mask(buttons));
  const bool jump = (held & static_cast<std::uint32_t>(params.jumpBit)) != 0;
  m.boost = (held & static_cast<std::uint32_t>(params.boostBit)) != 0;
  m.drift = (held & static_cast<std::uint32_t>(params.driftBit)) != 0;
  // 3.
  const double step = StepSeconds(dt, kMaxDtSeconds);
  m.h = step / params.substeps;
  // 4. The yaw as read, wrapped; past ±1e9 (a float32 past its range reads as ±Infinity), 0.
  const double readYaw = fpd::BodyAngle(body.yaw);
  m.yaw = std::fabs(readYaw) <= fpd::kMaxAbs ? fpd::Wrap(readYaw) : 0.0;
  m.x = fpd::BodyValue(body.x, 0.0, -fpd::kMaxAbs, fpd::kMaxAbs);
  m.y = fpd::BodyValue(body.y, 0.0, -fpd::kMaxAbs, fpd::kMaxAbs);
  m.z = fpd::BodyValue(body.z, 0.0, -fpd::kMaxAbs, fpd::kMaxAbs);
  m.vx = fpd::BodyValue(body.vx, 0.0, -fpd::kMaxAbs, fpd::kMaxAbs);
  m.vy = fpd::BodyValue(body.vy, 0.0, -fpd::kMaxAbs, fpd::kMaxAbs);
  m.vz = fpd::BodyValue(body.vz, 0.0, -fpd::kMaxAbs, fpd::kMaxAbs);
  m.spin = fpd::BodyValue(body.spin, 0.0, -1000.0, 1000.0);
  m.fuel = fpd::BodyValue(body.fuel, 0.0, 0.0, 1.0);
  m.cap = fpd::BodyValue(body.cap, 1.0, 0.0, 4.0);
  m.duck = 0.0;
  m.onGround = (mstate & vehicle_state::kOnGround) != 0;
  m.jumpHeld = (mstate & vehicle_state::kJumpHeld) != 0;
  // 5. The jump edge, once per input, then the sub-steps.
  if (step > 0) {
    m.pressed = jump && !m.jumpHeld && (params.capZeroJump != 0 || m.cap != 0);
    m.jumpHeld = jump;
    const int substeps = static_cast<int>(params.substeps);
    for (int i = 0; i < substeps; ++i) m.SubStep();
  }
  // 6.
  VehicleBody next;
  next.x = m.x;
  next.y = m.y;
  next.z = m.z;
  next.vx = m.vx;
  next.vy = m.vy;
  next.vz = m.vz;
  next.yaw = m.yaw;
  next.spin = m.spin;
  next.fuel = m.fuel;
  next.mstate = (m.onGround ? 1.0 : 0.0) + (m.jumpHeld ? 4.0 : 0.0);
  next.cap = body.cap;
  return next;
}

VehicleBody StepVehicle(const VehicleBody& body, const Input& input, double dt, const VehicleParams& params,
                        const FirstpersonWorld& world, const PosedWorld* posed) {
  return StepVehicle(body, input.moveX, input.moveY, input.buttons, dt, params, world, posed);
}

}  // namespace presets

// ---- posed solids and the hull's questions about them (GenexCore/GenexPosed.h) ----

PosedSolid PosedSolid::MakeBox(const std::array<double, 3>& lo, const std::array<double, 3>& hi) {
  PosedSolid s;
  s.kind = Kind::Box;
  s.min = lo;
  s.max = hi;
  return s;
}

PosedSolid PosedSolid::MakeOBox(const std::array<double, 3>& centre, const std::array<double, 3>& halves, double sine, double cosine) {
  PosedSolid s;
  s.kind = Kind::OBox;
  s.c = centre;
  s.half = halves;
  s.sin = sine;
  s.cos = cosine;
  return s;
}

PosedSolid PosedSolid::MakeDisc(const std::array<double, 3>& centre, double r, double halfHeight) {
  PosedSolid s;
  s.kind = Kind::Disc;
  s.c = centre;
  s.radius = r;
  s.half = {0, 0, halfHeight};
  return s;
}

std::optional<PosedWorld> PosedWorld::Make(const std::vector<PosedSolid>& solids) {
  if (solids.size() > static_cast<std::size_t>(kPosedMax)) return std::nullopt;
  const std::size_t n = solids.size();
  PosedWorld w;
  w.count = static_cast<int>(n);
  w.kind.assign(n, 0);
  for (std::vector<double>* t : {&w.minX, &w.minY, &w.minZ, &w.maxX, &w.maxY, &w.maxZ, &w.cx, &w.cy, &w.hx, &w.hy, &w.sin, &w.cos, &w.radius}) {
    t->assign(n, 0.0);
  }
  for (std::size_t i = 0; i < n; ++i) {
    const PosedSolid& s = solids[i];
    if (s.kind == PosedSolid::Kind::Box) {
      w.kind[i] = static_cast<std::uint8_t>(PosedSolid::Kind::Box);
      w.minX[i] = s.min[0];
      w.minY[i] = s.min[1];
      w.minZ[i] = s.min[2];
      w.maxX[i] = s.max[0];
      w.maxY[i] = s.max[1];
      w.maxZ[i] = s.max[2];
      continue;
    }
    w.cx[i] = s.c[0];
    w.cy[i] = s.c[1];
    w.minZ[i] = s.c[2] - s.half[2];
    w.maxZ[i] = s.c[2] + s.half[2];
    if (s.kind == PosedSolid::Kind::Disc) {
      w.kind[i] = static_cast<std::uint8_t>(PosedSolid::Kind::Disc);
      w.radius[i] = s.radius;
      w.minX[i] = s.c[0] - s.radius;
      w.maxX[i] = s.c[0] + s.radius;
      w.minY[i] = s.c[1] - s.radius;
      w.maxY[i] = s.c[1] + s.radius;
      continue;
    }
    w.kind[i] = static_cast<std::uint8_t>(PosedSolid::Kind::OBox);
    w.hx[i] = s.half[0];
    w.hy[i] = s.half[1];
    w.sin[i] = s.sin;
    w.cos[i] = s.cos;
    const double ac = std::fabs(s.cos);
    const double as = std::fabs(s.sin);
    const double ex = s.half[0] * ac + s.half[1] * as;
    const double ey = s.half[0] * as + s.half[1] * ac;
    w.minX[i] = s.c[0] - ex;
    w.maxX[i] = s.c[0] + ex;
    w.minY[i] = s.c[1] - ey;
    w.maxY[i] = s.c[1] + ey;
  }
  return w;
}

const PosedWorld& PosedWorld::None() {
  static const PosedWorld none = *PosedWorld::Make({});
  return none;
}

HullOps HullOps::ForFirstperson(const FirstpersonParams& params, const FirstpersonWorld& world) {
  HullOps h;
  h.world_ = &world;
  h.vehicle_ = false;
  h.r_ = fpd::F32(params.radius);
  h.standHeight_ = fpd::F32(params.standHeight);
  h.crouchHeight_ = fpd::F32(params.crouchHeight);
  h.stepHeight_ = fpd::F32(params.stepHeight);
  h.standable_ = fpd::F32(params.standable);
  h.groundTrace_ = fpd::F32(params.groundTrace);
  h.groundSnap_ = fpd::F32(params.groundSnap);
  h.skin_ = fpd::F32(params.skin);
  return h;
}

HullOps HullOps::ForVehicle(const VehicleParams& params, const FirstpersonWorld& world) {
  HullOps h;
  h.world_ = &world;
  h.vehicle_ = true;
  h.r_ = fpd::F32(params.radius);
  h.standHeight_ = fpd::F32(params.height);
  h.crouchHeight_ = fpd::F32(params.height);
  h.stepHeight_ = fpd::F32(params.stepHeight);
  h.standable_ = fpd::F32(params.standable);
  h.groundTrace_ = fpd::F32(params.groundTrace);
  h.groundSnap_ = fpd::F32(params.groundSnap);
  h.skin_ = fpd::F32(params.skin);
  return h;
}

namespace {

/** A hull standing at `body` among `world` and `posed`, as presets.ts hullOps lays it. */
void LayHull(fpd::Hull& m, const HullBody& body, double r, double standHeight, double crouchHeight, double stepHeight, double standable,
             double groundTrace, double groundSnap, double skin, bool vehicle) {
  std::vector<std::int32_t>& candidates = fpd::CandidateBuffer();
  if (candidates.size() < static_cast<std::size_t>(m.w.SolidCount())) candidates.resize(static_cast<std::size_t>(m.w.SolidCount()));
  m.cand = candidates.data();
  m.r = r;
  m.unit = fpd::UnitOf(r, vehicle ? 50.0 : 16.0);
  m.standHeight = standHeight;
  m.crouchHeight = crouchHeight;
  m.stepHeight = stepHeight;
  m.standable = standable;
  m.groundTrace = groundTrace;
  m.groundSnap = groundSnap;
  m.skin = skin;
  m.x = body.x;
  m.y = body.y;
  m.z = body.z;
  m.vz = body.vz;
  m.duck = vehicle ? 0.0 : body.duck;
}

}  // namespace

int HullOps::Support(const HullBody& body, const std::vector<PosedSolid>& solids) const {
  const std::optional<PosedWorld> made = PosedWorld::Make(solids);
  if (!made) return -1;
  const PosedWorld& posed = *made;
  fpd::Hull m(*world_, &posed);
  LayHull(m, body, r_, standHeight_, crouchHeight_, stepHeight_, standable_, groundTrace_, groundSnap_, skin_, vehicle_);
  if (m.vz > 0.1 * m.unit) return -1;
  const double g = m.TraceDown(m.x, m.y, m.z, m.groundTrace, m.groundSnap);
  if (g != g) return -1;
  for (int j = 0; j < posed.count; ++j) {
    if (posed.maxZ[static_cast<std::size_t>(j)] == g && m.PosedOverlaps(j, m.x, m.y)) return j;
  }
  return -1;
}

bool HullOps::Inside(const HullBody& body, const std::vector<PosedSolid>& solids, int k) const {
  const std::optional<PosedWorld> made = PosedWorld::Make(solids);
  if (!made) return false;
  const PosedWorld& posed = *made;
  fpd::Hull m(*world_, &posed);
  LayHull(m, body, r_, standHeight_, crouchHeight_, stepHeight_, standable_, groundTrace_, groundSnap_, skin_, vehicle_);
  return m.Inside(m.x, m.y, m.z, world_->SolidCount() + k, m.HullAt(m.duck));
}

HullOps::Pushed HullOps::PushOut(const HullBody& body, const std::vector<PosedSolid>& solids) const {
  const std::optional<PosedWorld> made = PosedWorld::Make(solids);
  if (!made) return Pushed{body.x, body.y, body.z, false};
  const PosedWorld& posed = *made;
  fpd::Hull m(*world_, &posed);
  LayHull(m, body, r_, standHeight_, crouchHeight_, stepHeight_, standable_, groundTrace_, groundSnap_, skin_, vehicle_);
  for (int k = 0; k < 4; ++k) {
    m.Sweep(m.x, m.y, m.z, 0.0, 0.0, 0.0);
    if (!m.hit) break;
    m.x = m.x + m.nx * m.depth;
    m.y = m.y + m.ny * m.depth;
    m.z = m.z + m.nz * m.depth;
    m.x = m.x + m.nx * m.skin;
    m.y = m.y + m.ny * m.skin;
    m.z = m.z + m.nz * m.skin;
  }
  const double height = m.HullAt(m.duck);
  bool inside = false;
  const int all = world_->SolidCount() + posed.count;
  for (int i = 0; i < all && !inside; ++i) inside = m.Inside(m.x, m.y, m.z, i, height);
  Pushed out;
  out.x = m.x;
  out.y = m.y;
  out.z = m.z;
  out.inside = inside;
  return out;
}

}  // namespace genex

GENEX_FP_STRICT_END
