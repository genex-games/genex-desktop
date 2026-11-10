// The static world as the contact policy sees it (PROTOCOL.md §17.11 *Contact policy*): §17.7's boxes and
// ramps grown by a seat's hull into convex solids of planes, a cast along a straight line through them (a
// body's room before a wall, and whether a way is free), the surface under a point (a seat's support up) and
// §17.7's *Starting inside* push-out (a body the contacts drove into a wall put back out). Pure float64 in a
// fixed order, no trigonometry. A port of packages/multiplayer/src/authority/contact-world.ts, held to
// packages/netcode-bench/conformance/authority/contact-policy.json by core/tools/contact_policy_check.cpp.
#pragma once

#include "GenexCore/GenexConfig.h"

#include <array>
#include <functional>
#include <optional>
#include <vector>

namespace genex::contact {

/** A 3-vector, room units. */
using V3 = std::array<double, 3>;

/** One face of a grown solid: a point p is inside it when `n · p < e` (n of unit length). */
struct Plane {
  double nx = 0;
  double ny = 0;
  double nz = 0;
  double e = 0;
};

/** A grown solid: its planes (a box's six, a ramp's seven, the bottom last) and its bounds. */
struct ContactSolid {
  std::vector<Plane> planes;
  V3 min{};
  V3 max{};
};

/** A world's solids on an x/y grid, so a cast or a point query visits the solids whose footprint it can reach
 *  rather than every one: cell (i, j) covers [x0 + i·size, x0 + (i + 1)·size) on x (the edge cells reach on to the
 *  world's ends), and holds every solid whose bounds grown by the cast's margin meet it, ascending; a solid on too
 *  many cells is on `wide` alone, which every query visits. Only where a query visits solids changes, never what
 *  it answers (§17.7 lets a port skip what cannot). */
struct SolidGrid {
  double x0 = 0;
  double y0 = 0;
  double size = 0;
  int nx = 0;
  int ny = 0;
  /** Cell (i, j) is c = i + j·nx: its solids are `cellSolids` from `cellStart[c]` up to `cellStart[c + 1]`. */
  std::vector<int> cellStart;
  std::vector<int> cellSolids;
  /** The solids too wide for the cells (a floor, a map-long wall), ascending. */
  std::vector<int> wide;
};

/** A world compiled for one hull: every solid grown by it, and the clearance kept from a surface. */
struct ContactWorld {
  std::vector<ContactSolid> solids;
  /** A point is inside a solid only when it is more than this inside every plane (the preset's skin). */
  double skin = 0;
  /** The solids by where they stand (none: a query visits every solid). */
  std::optional<SolidGrid> grid;
};

/** A box `[x0 y0 z0 x1 y1 z1]` and a ramp `[x0 y0 z0 x1 y1 z1 axis lo hi]` as §17.7's world gives them. */
using WorldBox = std::array<double, 6>;
using WorldRamp = std::array<double, 9>;

/** Solids one push-out may move a body out of in turn (a corner is two walls and the floor). */
constexpr int kUnstickSolids = 4;

/** The world grown by a hull of half side `r` and height `h` (§17.7's `slab` and `wedge`): boxes first, then
 *  ramps, each solid's bottom face last. A point closer than `skin` to a face is outside. */
GENEX_CORE_API ContactWorld CompileContactWorld(const std::vector<WorldBox>& boxes, const std::vector<WorldRamp>& ramps,
                                                double r, double h, double skin);

/** Faces a cast passes through: the surface a seat rides (its preset follows it), never a wall. A face is
 *  ridden when its z is at least `cos` and its dot with `up` is at least `cos`. */
struct Rides {
  V3 up{0, 0, 1};
  double cos = 0.7;
  bool Passes(const Plane& face) const;
};

/** Where a line first enters a solid: the distance along it and the face it crosses (none: it did not). */
struct CastHit {
  double t = 0;
  std::optional<Plane> face;
};

/** The first solid of `world` the segment from `p` along unit `d` meets within `len`: the distance to where it
 *  comes within skin of it, and that face; `{len, none}` when it is clear. A solid `p` is already inside is
 *  skipped, and so is one the segment would enter through a face `rides` passes. */
GENEX_CORE_API CastHit CastWorld(const ContactWorld& world, const V3& p, const V3& d, double len, const Rides* rides);

/** How far a body's base at `p` can move along unit `d` before a grown solid, clamped to [0, len]; faces
 *  `rides` passes do not stop it. A null world gives `len`. */
GENEX_CORE_API double RoomAlong(const ContactWorld* world, const V3& p, const V3& d, double len, const Rides* rides);

/** The support up of a body whose base is at (x, y, z) (§17.11 step 1): the normal of the first face a cast
 *  straight down meets within `trace`, else world up. */
GENEX_CORE_API V3 SurfaceUp(const ContactWorld* world, double x, double y, double z, double trace);

/** The face a body at (x, y, z) is pushed out of the first solid it is inside through, as [nx, ny, nz,
 *  depth]; none when it is clear. */
GENEX_CORE_API std::optional<std::array<double, 4>> InsideFace(const ContactWorld& world, double x, double y, double z);

/** Whether (x, y, z) is inside any solid of `world`. */
GENEX_CORE_API bool InsideWorld(const ContactWorld& world, double x, double y, double z);

/** A body's base the contacts left inside the world, pushed back out with the skin's clearance (x y z changed
 *  in place), up to kUnstickSolids solids in turn; the deepest push (0: it was clear). `onFace` hears each face
 *  it is pushed out through ([nx, ny, nz, depth]). */
GENEX_CORE_API double UnstickBody(const ContactWorld& world, double* x, double* y, double* z,
                                  const std::function<void(const std::array<double, 4>&)>& onFace = nullptr);

}  // namespace genex::contact
