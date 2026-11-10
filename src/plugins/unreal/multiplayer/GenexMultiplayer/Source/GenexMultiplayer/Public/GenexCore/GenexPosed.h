// Posed solids (PROTOCOL.md §17.7 *Posed solids*) and the hull's questions about them (§17.11 *Lifts*): a solid
// posed for one tick beside the static world (a lift at its pose, a head slab), which the `firstperson` and
// `vehicle` steps collide with, and what the lift slots ask of a preset's hull among them: the posed solid it
// stands on, whether it is inside one, and the push-out. A port of presets.ts (`PosedSolid`, `posedWorld`,
// `hullOps` and the posed tests in `sweep`), held to packages/netcode-bench/conformance/authority/lifts.json by
// core/tools/lifts_check.cpp. The arithmetic lives in GenexFirstperson.cpp, on the collision procedures it shares
// with the static world.
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexFirstperson.h"
#include "GenexCore/GenexVehicle.h"

#include <array>
#include <cstdint>
#include <optional>
#include <vector>

namespace genex {

/** A solid posed for one tick: an axis-aligned box `[min, max]`; a box of half extents `half` about centre `c`
 *  turned about z by the angle whose sine and cosine are given (`OBox`); or an upright disc of `radius` about `c`,
 *  `half[2]` its half height (`Disc`). Visited after the static solids, in order, never by the broad phase. */
struct PosedSolid {
  enum class Kind : std::uint8_t { Box = 0, OBox = 1, Disc = 2 };
  Kind kind = Kind::Box;
  std::array<double, 3> min{};
  std::array<double, 3> max{};
  std::array<double, 3> c{};
  /** An obox's half extents (x, y, z); a disc's z is its half height. */
  std::array<double, 3> half{};
  double sin = 0;
  double cos = 1;
  double radius = 0;

  static PosedSolid MakeBox(const std::array<double, 3>& lo, const std::array<double, 3>& hi);
  static PosedSolid MakeOBox(const std::array<double, 3>& centre, const std::array<double, 3>& halves, double sine, double cosine);
  static PosedSolid MakeDisc(const std::array<double, 3>& centre, double r, double halfHeight);
};

/** Posed solids a tick may hold at most (32 lifts and a head slab for each of 64 seats). */
inline constexpr int kPosedMax = 96;

/** The step's view of a tick's posed solids: one flat table per field. `min*` and `max*` are each solid's bounds
 *  on x, y and z (an obox's or a disc's box around it). */
struct GENEX_CORE_API PosedWorld {
  int count = 0;
  std::vector<std::uint8_t> kind;
  std::vector<double> minX, minY, minZ, maxX, maxY, maxZ;
  std::vector<double> cx, cy, hx, hy, sin, cos, radius;

  /** A tick's posed solids compiled for the step, in the order given; none (a refusal, as presets.ts throws a
   *  RangeError) for more than kPosedMax. */
  static std::optional<PosedWorld> Make(const std::vector<PosedSolid>& solids);
  /** No posed solids. */
  static const PosedWorld& None();
};

/** A seat's body as the lift slots read it. */
struct HullBody {
  double x = 0;
  double y = 0;
  double z = 0;
  double vz = 0;
  double duck = 0;
};

/** What the lift slots ask of a preset's hull, against the world and a tick's posed solids. */
class GENEX_CORE_API HullOps {
 public:
  /** The `firstperson` preset's hull among `world` (kept by reference: it must outlive the ops). */
  static HullOps ForFirstperson(const FirstpersonParams& params, const FirstpersonWorld& world);
  /** The `vehicle` preset's hull among `world`. */
  static HullOps ForVehicle(const VehicleParams& params, const FirstpersonWorld& world);

  /** The posed solid (its index) the hull stands on: the highest standable top under it in
   *  [z − groundTrace, z + groundSnap] (`checkGround`'s test) when that top is a posed solid's (the first such in
   *  order), else −1; −1 too while rising (`vz > 0.1 · unit`), and for more than kPosedMax solids (refused). */
  int Support(const HullBody& body, const std::vector<PosedSolid>& solids) const;
  /** Whether the hull is more than skin inside posed solid `k` (§17.7 *Starting inside*'s `inside`). */
  bool Inside(const HullBody& body, const std::vector<PosedSolid>& solids, int k) const;

  /** The place §17.7 *Starting inside* leaves the hull in; `inside`: still inside some solid. */
  struct Pushed {
    double x = 0;
    double y = 0;
    double z = 0;
    bool inside = false;
  };
  /** §17.7 *Starting inside* as `slideMove` applies it, with no move: up to four times, out through the face a
   *  zero-length sweep reports, by its depth then skin. */
  Pushed PushOut(const HullBody& body, const std::vector<PosedSolid>& solids) const;

 private:
  HullOps() = default;
  const FirstpersonWorld* world_ = nullptr;
  bool vehicle_ = false;
  double r_ = 0, standHeight_ = 0, crouchHeight_ = 0, stepHeight_ = 0, standable_ = 0;
  double groundTrace_ = 0, groundSnap_ = 0, skin_ = 0;
};

}  // namespace genex
