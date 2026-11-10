// The contact policy's static world (GenexCore/GenexContactWorld.h): a port of contact-world.ts, every
// operation in its order and unfused (GENEX_FP_STRICT_BEGIN), so a cast, a room and a push-out are the
// TypeScript's bit for bit.
#include "GenexCore/GenexContactWorld.h"

#include "GenexCore/GenexConfig.h"

#include <algorithm>
#include <cmath>
#include <limits>

GENEX_FP_STRICT_BEGIN

namespace genex::contact {
namespace {

Plane P4(double nx, double ny, double nz, double e) {
  Plane p;
  p.nx = nx;
  p.ny = ny;
  p.nz = nz;
  p.e = e;
  return p;
}

/** A box grown by the hull (half side `r` on x and y, height `h` under the base): §17.7's slab. */
std::vector<Plane> GrownBox(const WorldBox& b, double r, double h) {
  return {P4(-1, 0, 0, -(b[0] - r)), P4(1, 0, 0, b[3] + r), P4(0, -1, 0, -(b[1] - r)),
          P4(0, 1, 0, b[4] + r),     P4(0, 0, 1, b[5]),     P4(0, 0, -1, -(b[2] - h))};
}

/** A ramp grown by the hull: §17.7's wedge, its top plane moved out by `r` along the slope. */
std::vector<Plane> GrownRamp(const WorldRamp& q, double r, double h) {
  const double x0 = q[0], y0 = q[1], z0 = q[2], x1 = q[3], y1 = q[4], z1 = q[5], axis = q[6], lo = q[7], hi = q[8];
  const double m0 = axis == 0 ? x0 : y0;
  const double slope = (hi - lo) / ((axis == 0 ? x1 : y1) - m0);
  const double k = 1 / std::sqrt(slope * slope + 1);
  const double e = (lo - slope * m0 + r * std::fabs(slope)) * k;
  const Plane top = axis == 0 ? P4(-slope * k, 0, k, e) : P4(0, -slope * k, k, e);
  return {P4(1, 0, 0, x1 + r), P4(-1, 0, 0, -x0 + r), P4(0, 1, 0, y1 + r), P4(0, -1, 0, -y0 + r), top, P4(0, 0, 1, z1),
          P4(0, 0, -1, -z0 + h)};
}

ContactSolid SolidOf(std::vector<Plane> planes, const double* src, double r, double h) {
  ContactSolid s;
  s.planes = std::move(planes);
  s.min = {src[0] - r, src[1] - r, src[2] - h};
  s.max = {src[3] + r, src[4] + r, src[5]};
  return s;
}

/** Whether (x, y, z) is more than `skin` inside every plane of `planes`. */
bool InsidePlanes(const std::vector<Plane>& planes, double skin, double x, double y, double z) {
  for (const Plane& p : planes) {
    if (!(p.e - (p.nx * x + p.ny * y + p.nz * z) > skin)) return false;
  }
  return true;
}

/** Whether the segment p + t·d, t in [0, len], can meet the solid's bounds. */
bool SegmentNear(const ContactSolid& s, const V3& p, const V3& d, double len) {
  for (int i = 0; i < 3; ++i) {
    const double a = p[i];
    const double b = a + d[i] * len;
    const double lo = a < b ? a : b;
    const double hi = a < b ? b : a;
    if (hi < s.min[i] - 1 || lo > s.max[i] + 1) return false;
  }
  return true;
}

bool RidesPass(const Rides* rides, const Plane& face) { return rides != nullptr && rides->Passes(face); }

/** A segment that starts within `skin` of solid `s` (inside its clearance, not inside it) is stopped at once
 *  when it goes deeper through a face it is that close to, else never. */
std::optional<CastHit> BandHit(const ContactSolid& s, double skin, const V3& p, const V3& d, const Rides* rides) {
  for (const Plane& plane : s.planes) {
    const double margin = plane.e - (plane.nx * p[0] + plane.ny * p[1] + plane.nz * p[2]);
    if (margin <= skin && plane.nx * d[0] + plane.ny * d[1] + plane.nz * d[2] < 0 && !RidesPass(rides, plane)) {
      CastHit hit;
      hit.t = 0;
      hit.face = plane;
      return hit;
    }
  }
  return std::nullopt;
}

/** Where p + t·d (t in [0, len]) comes within `skin` of solid `s`, or none when it never does. */
std::optional<CastHit> EnterSolid(const ContactSolid& s, double skin, const V3& p, const V3& d, double len, const Rides* rides) {
  if (InsidePlanes(s.planes, skin, p[0], p[1], p[2])) return std::nullopt;
  if (InsidePlanes(s.planes, -skin, p[0], p[1], p[2])) return BandHit(s, skin, p, d, rides);
  double lo = 0;
  double hi = len;
  // The entry face is the entering plane met last, even at or behind the start.
  double last = -std::numeric_limits<double>::infinity();
  const Plane* face = nullptr;
  for (const Plane& plane : s.planes) {
    const double s0 = plane.e + skin - (plane.nx * p[0] + plane.ny * p[1] + plane.nz * p[2]);
    const double sd = plane.nx * d[0] + plane.ny * d[1] + plane.nz * d[2];
    if (sd == 0) {
      if (!(s0 > 0)) return std::nullopt;
      continue;
    }
    const double t = s0 / sd;
    if (sd > 0 && t < hi) hi = t;
    if (sd < 0 && t > last) {
      last = t;
      face = &plane;
    }
  }
  if (last > lo) lo = last;
  if (face == nullptr || !(lo < hi) || RidesPass(rides, *face)) return std::nullopt;
  CastHit hit;
  hit.t = lo;
  hit.face = *face;
  return hit;
}

/** How far outside its bounds a cast still tests a solid (SegmentNear's margin). */
constexpr double kCastMargin = 1;
/** A world of fewer solids is visited whole: a grid saves nothing there. */
constexpr int kGridMinSolids = 32;
/** The grid's cells a side at most, and its smallest cell (room units). */
constexpr double kGridSide = 32;
constexpr double kGridCellMin = 64;
/** A solid on more cells than this is visited by every query instead. */
constexpr int kGridWide = 64;
/** A query whose box spans more cells than this visits every solid. */
constexpr int kGridQueryCells = 16;

/** Whether a solid's bounds are finite on x and y (a grid can place it). */
bool Placeable(const ContactSolid& s) {
  return std::isfinite(s.min[0]) && std::isfinite(s.max[0]) && std::isfinite(s.min[1]) && std::isfinite(s.max[1]);
}

/** The cell of coordinate `v` on an axis from `origin` with `n` cells (clamped: monotone in v). */
int CellOf(double v, double origin, double size, int n) {
  const double c = std::floor((v - origin) / size);
  if (c < 0) return 0;
  return c > n - 1 ? n - 1 : static_cast<int>(c);
}

struct CellRange {
  int i0, i1, j0, j1;
};

/** The cells a solid is on; none when it is on `wide`. */
std::optional<CellRange> CellsOf(const ContactSolid& s, const SolidGrid& g) {
  if (!Placeable(s)) return std::nullopt;
  const CellRange r{CellOf(s.min[0] - kCastMargin, g.x0, g.size, g.nx), CellOf(s.max[0] + kCastMargin, g.x0, g.size, g.nx),
                    CellOf(s.min[1] - kCastMargin, g.y0, g.size, g.ny), CellOf(s.max[1] + kCastMargin, g.y0, g.size, g.ny)};
  if ((r.i1 - r.i0 + 1) * (r.j1 - r.j0 + 1) > kGridWide) return std::nullopt;
  return r;
}

/** The grid of a world's solids; none for a world too small to need one, or too wide to measure. */
std::optional<SolidGrid> GridOf(const std::vector<ContactSolid>& solids) {
  int placed = 0;
  double x0 = std::numeric_limits<double>::infinity(), y0 = x0, x1 = -x0, y1 = -x0;
  for (const ContactSolid& s : solids) {
    if (!Placeable(s)) continue;
    placed += 1;
    x0 = std::min(x0, s.min[0] - kCastMargin);
    y0 = std::min(y0, s.min[1] - kCastMargin);
    x1 = std::max(x1, s.max[0] + kCastMargin);
    y1 = std::max(y1, s.max[1] + kCastMargin);
  }
  if (placed < kGridMinSolids) return std::nullopt;
  SolidGrid g;
  g.x0 = x0;
  g.y0 = y0;
  g.size = std::max({kGridCellMin, (x1 - x0) / kGridSide, (y1 - y0) / kGridSide});
  if (!std::isfinite(g.size)) return std::nullopt;
  g.nx = static_cast<int>(std::min(kGridSide, std::floor((x1 - x0) / g.size) + 1));
  g.ny = static_cast<int>(std::min(kGridSide, std::floor((y1 - y0) / g.size) + 1));
  g.cellStart.assign(static_cast<std::size_t>(g.nx * g.ny) + 1, 0);
  for (const ContactSolid& s : solids) {
    const std::optional<CellRange> r = CellsOf(s, g);
    if (!r) continue;
    for (int j = r->j0; j <= r->j1; ++j) {
      for (int i = r->i0; i <= r->i1; ++i) g.cellStart[static_cast<std::size_t>(i + j * g.nx) + 1] += 1;
    }
  }
  for (int c = 0; c < g.nx * g.ny; ++c) g.cellStart[static_cast<std::size_t>(c) + 1] += g.cellStart[static_cast<std::size_t>(c)];
  g.cellSolids.assign(static_cast<std::size_t>(g.cellStart.back()), 0);
  std::vector<int> written = g.cellStart;
  for (std::size_t k = 0; k < solids.size(); ++k) {
    const std::optional<CellRange> r = CellsOf(solids[k], g);
    if (!r) {
      g.wide.push_back(static_cast<int>(k));
      continue;
    }
    for (int j = r->j0; j <= r->j1; ++j) {
      for (int i = r->i0; i <= r->i1; ++i) {
        int& at = written[static_cast<std::size_t>(i + j * g.nx)];
        g.cellSolids[static_cast<std::size_t>(at)] = static_cast<int>(k);
        at += 1;
      }
    }
  }
  return g;
}

/** Two ascending index lists (the second from `b` up to `end`) as one, ascending, each index once. */
std::vector<int> MergeAscending(const std::vector<int>& a, const int* b, const int* end) {
  std::vector<int> out;
  out.reserve(a.size() + static_cast<std::size_t>(end - b));
  std::size_t i = 0;
  while (i < a.size() || b < end) {
    const bool fromA = b >= end || (i < a.size() && a[i] <= *b);
    const int next = fromA ? a[i] : *b;
    if (fromA) {
      i += 1;
    } else {
      b += 1;
    }
    if (out.empty() || out.back() != next) out.push_back(next);
  }
  return out;
}

/** The solids (indices, ascending) whose cells meet the x/y box [lx, hx] × [ly, hy]; none when every solid must
 *  be visited: no grid, a box not finite (NaN meets every solid), or one too large. */
std::optional<std::vector<int>> SolidsNear(const ContactWorld& world, double lx, double hx, double ly, double hy) {
  if (!world.grid || !(std::isfinite(lx) && std::isfinite(hx) && std::isfinite(ly) && std::isfinite(hy))) return std::nullopt;
  const SolidGrid& g = *world.grid;
  const int i0 = CellOf(lx, g.x0, g.size, g.nx);
  const int i1 = CellOf(hx, g.x0, g.size, g.nx);
  const int j0 = CellOf(ly, g.y0, g.size, g.ny);
  const int j1 = CellOf(hy, g.y0, g.size, g.ny);
  if ((i1 - i0 + 1) * (j1 - j0 + 1) > kGridQueryCells) return std::nullopt;
  std::vector<int> near = g.wide;
  for (int j = j0; j <= j1; ++j) {
    for (int i = i0; i <= i1; ++i) {
      const std::size_t c = static_cast<std::size_t>(i + j * g.nx);
      const int* cells = g.cellSolids.data();
      near = MergeAscending(near, cells + g.cellStart[c], cells + g.cellStart[c + 1]);
    }
  }
  return near;
}

/** How many solids `near` visits, and the solid its `m`-th visit is (none: the world's, in order). */
std::size_t Visits(const ContactWorld& world, const std::optional<std::vector<int>>& near) {
  return near ? near->size() : world.solids.size();
}
std::size_t Visit(const std::optional<std::vector<int>>& near, std::size_t m) {
  return near ? static_cast<std::size_t>((*near)[m]) : m;
}

/** A face that points up, of solid `self`, is no way out when another solid covers it (§17.7 *Starting
 *  inside*: a wall's top under the ceiling, a pocket's side wall under its roof). */
bool Covered(const ContactWorld& world, std::size_t self, double x, double y, double z, const V3& q) {
  const std::optional<std::vector<int>> near = SolidsNear(world, q[0], q[0], q[1], q[1]);
  const std::size_t n = Visits(world, near);
  for (std::size_t m = 0; m < n; ++m) {
    const std::size_t j = Visit(near, m);
    if (j == self) continue;
    const std::vector<Plane>& planes = world.solids[j].planes;
    if (InsidePlanes(planes, world.skin, q[0], q[1], q[2]) && !InsidePlanes(planes, world.skin, x, y, z)) return true;
  }
  return false;
}

/** The least deep face of `planes` but the bottom (and but an up face another solid covers): a tie keeps the
 *  earlier. [nx, ny, nz, depth]. */
std::optional<std::array<double, 4>> LeastFace(const ContactWorld& world, std::size_t i, const std::vector<Plane>& planes,
                                               double x, double y, double z) {
  std::optional<std::array<double, 4>> least;
  for (std::size_t k = 0; k + 1 < planes.size(); ++k) {
    const Plane& p = planes[k];
    const double depth = p.e - (p.nx * x + p.ny * y + p.nz * z);
    if (least && !(depth < (*least)[3])) continue;
    if (p.nz > 0 && Covered(world, i, x, y, z, V3{x + p.nx * depth, y + p.ny * depth, z + p.nz * depth})) continue;
    least = std::array<double, 4>{p.nx, p.ny, p.nz, depth};
  }
  return least;
}

/** JavaScript's Math.max of two: NaN if either is, +0 over −0. */
double DeeperOf(double a, double b) {
  if (std::isnan(a) || std::isnan(b)) return std::numeric_limits<double>::quiet_NaN();
  if (a == 0 && b == 0) return std::signbit(a) ? b : a;
  return a > b ? a : b;
}

}  // namespace

bool Rides::Passes(const Plane& face) const {
  return face.nz >= cos && face.nx * up[0] + face.ny * up[1] + face.nz * up[2] >= cos;
}

ContactWorld CompileContactWorld(const std::vector<WorldBox>& boxes, const std::vector<WorldRamp>& ramps, double r, double h,
                                 double skin) {
  ContactWorld w;
  w.skin = skin;
  for (const WorldBox& b : boxes) w.solids.push_back(SolidOf(GrownBox(b, r, h), b.data(), r, h));
  for (const WorldRamp& q : ramps) w.solids.push_back(SolidOf(GrownRamp(q, r, h), q.data(), r, h));
  w.grid = GridOf(w.solids);
  return w;
}

CastHit CastWorld(const ContactWorld& world, const V3& p, const V3& d, double len, const Rides* rides) {
  CastHit best;
  best.t = len;
  if (!(len > 0)) {
    best.t = 0;
    return best;
  }
  // The grid's solids by the segment's box at its whole length (SegmentNear's, a superset of every shorter
  // one's), in order: the very solids the full visit would test.
  const double ex = p[0] + d[0] * len;
  const double ey = p[1] + d[1] * len;
  const bool finite = std::isfinite(p[0]) && std::isfinite(p[1]) && std::isfinite(ex) && std::isfinite(ey);
  const std::optional<std::vector<int>> near =
      finite ? SolidsNear(world, std::min(p[0], ex), std::max(p[0], ex), std::min(p[1], ey), std::max(p[1], ey)) : std::nullopt;
  const std::size_t n = Visits(world, near);
  for (std::size_t m = 0; m < n; ++m) {
    const ContactSolid& s = world.solids[Visit(near, m)];
    if (!SegmentNear(s, p, d, best.t)) continue;
    const std::optional<CastHit> hit = EnterSolid(s, world.skin, p, d, best.t, rides);
    if (hit && hit->t < best.t) best = *hit;
  }
  return best;
}

double RoomAlong(const ContactWorld* world, const V3& p, const V3& d, double len, const Rides* rides) {
  if (world == nullptr) return len;
  const double t = CastWorld(*world, p, d, len, rides).t;
  return t < 0 ? 0 : t;
}

V3 SurfaceUp(const ContactWorld* world, double x, double y, double z, double trace) {
  const V3 up{0, 0, 1};
  if (world == nullptr) return up;
  const CastHit hit = CastWorld(*world, V3{x, y, z}, V3{0, 0, -1}, trace, nullptr);
  if (!hit.face || !(hit.face->nz > 0)) return up;
  return V3{hit.face->nx, hit.face->ny, hit.face->nz};
}

bool InsideWorld(const ContactWorld& world, double x, double y, double z) {
  const std::optional<std::vector<int>> near = SolidsNear(world, x, x, y, y);
  const std::size_t n = Visits(world, near);
  for (std::size_t m = 0; m < n; ++m) {
    if (InsidePlanes(world.solids[Visit(near, m)].planes, world.skin, x, y, z)) return true;
  }
  return false;
}

std::optional<std::array<double, 4>> InsideFace(const ContactWorld& world, double x, double y, double z) {
  const std::optional<std::vector<int>> near = SolidsNear(world, x, x, y, y);
  const std::size_t n = Visits(world, near);
  for (std::size_t m = 0; m < n; ++m) {
    const std::size_t i = Visit(near, m);
    const std::vector<Plane>& planes = world.solids[i].planes;
    if (InsidePlanes(planes, world.skin, x, y, z)) return LeastFace(world, i, planes, x, y, z);
  }
  return std::nullopt;
}

double UnstickBody(const ContactWorld& world, double* bx, double* by, double* bz,
                   const std::function<void(const std::array<double, 4>&)>& onFace) {
  double x = *bx;
  double y = *by;
  double z = *bz;
  double deepest = 0;
  for (int n = 0; n < kUnstickSolids; ++n) {
    const std::optional<std::array<double, 4>> face = InsideFace(world, x, y, z);
    if (!face) break;
    if (onFace) onFace(*face);
    const double depth = (*face)[3];
    deepest = DeeperOf(deepest, depth);
    x += (*face)[0] * (depth + world.skin);
    y += (*face)[1] * (depth + world.skin);
    z += (*face)[2] * (depth + world.skin);
  }
  if (deepest > 0) {
    *bx = x;
    *by = y;
    *bz = z;
  }
  return deepest;
}

}  // namespace genex::contact

GENEX_FP_STRICT_END
