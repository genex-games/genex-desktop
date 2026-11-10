// Lifts (PROTOCOL.md §17.11 *Lifts*): where each declared platform is at a tick, and how it carries a seat that rides
// it, as pure functions of the tick; the lift slots around a tick's inputs (the carry slot with its push-out and crush,
// the impart slot), and the head slabs a seat standing on another's head steps through (§17.11 *Contact policy*
// step 6 `stand`). A port of packages/multiplayer/src/authority/lifts.ts and heads.ts, held to
// packages/netcode-bench/conformance/authority/lifts.json by core/tools/lifts_check.cpp. The host, the guest prelude and
// every SDK compute the same bits, so a client predicts a rider on a kinematic lift exactly at any ping.
//
// Pose at tick t: the path's phase `m` in whole ticks (a called lift: the ticks since its call, for one cycle); within
// a leg of `n` ticks at its tick `i`, each axis `a + ((b − a)·i)/n` (linear) or `a + (b − a)·e` with `s = i/n`,
// `e = s·s·(3 − 2s)` (smooth), in float64, then float32; a wait holds its point. A spin's yaw is
// `dir·((2π·m)/period)`, float32. A rider is carried by the move to the next tick: turned by the constant
// `δ = dir·2π/period` about the centre (§17.7's portable sine and cosine, the only trigonometry), moved by the centre's
// move, and by a conveyor's surface velocity over the tick. Pure float64 in this order, unfused (GENEX_FP_STRICT).
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexJson.h"
#include "GenexCore/GenexPhysicsPredictor.h"
#include "GenexCore/GenexContactPolicy.h"
#include "GenexCore/GenexLiftsConfig.h"
#include "GenexCore/GenexPosed.h"

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace genex::lifts {

/** A lift's pose at a tick: its centre and yaw (float32). */
struct LiftPose {
  Vec3 c{};
  double yaw = 0;
};

/** Called lifts' call ticks by id. */
using Starts = std::map<std::string, double>;

/** Lift `lift`'s pose at `tick`; `start` is a called lift's call tick (none: not called). */
GENEX_CORE_API LiftPose LiftPoseAt(const Lift& lift, double tick, std::optional<double> start = std::nullopt);
/** Every lift's pose at `tick`, in declared order. */
GENEX_CORE_API std::vector<LiftPose> LiftPoses(const LiftsPolicy& policy, double tick, const Starts* starts = nullptr);
/** A lift's turn per tick (0 for none). */
GENEX_CORE_API double SpinStep(const Lift& lift);

/** A rider's pose as the carry reads and writes it (float64; the caller writes float32). */
struct RiderPose {
  double x = 0;
  double y = 0;
  double z = 0;
  double yaw = 0;
};

/** A carried rider: its pose at the next tick and its point's velocity over the tick (u/s). */
struct Carried : RiderPose {
  Vec3 v{};
};

/** The carry of a rider on `lift` from `tick` to `tick + 1`: turned by the lift's spin about its centre, moved with
 *  the centre, then by a conveyor's surface velocity in the lift's frame at `tick + 1` over one tick; its yaw turned
 *  with the spin. `v` is the point's move over the tick: what a rider keeps on leaving (`impart: all`). */
GENEX_CORE_API Carried CarryOnLift(const Lift& lift, const RiderPose& rider, double tick, double tickHz,
                                   std::optional<double> start = std::nullopt);

/** Every lift as a posed solid at the poses given, in declared order: a box that never spins is axis-aligned, one
 *  that spins an `OBox`, a disc a disc. */
GENEX_CORE_API std::vector<PosedSolid> PosedSolidsOf(const LiftsPolicy& policy, const std::vector<LiftPose>& poses);

/** A tick's lifts as posed solids at its start (`now`) and its end (`next`). */
struct TickSolids {
  std::vector<PosedSolid> now;
  std::vector<PosedSolid> next;
};
GENEX_CORE_API TickSolids TickSolidsOf(const LiftsPolicy& policy, double tick, const Starts* starts = nullptr);

/** A seat as the slots read and write it (float32 writes): the contact policy's body (id, place, velocity, heading,
 *  tags and flags for the head slabs) and its duck. */
struct LiftSeat : contact::PolicyBody {
  double duck = 0;
};

/** A room's contact policy, for the slots' head slabs and the carry by a lower seat (§17.11 step 6 `stand` with `ride`). */
struct HeadsContext {
  const contact::ContactPolicy* policy = nullptr;
  const contact::ContactEnv* env = nullptr;
};

/** Riders carried through a chain of seats at most (a seat on a seat on a seat on a lift). */
constexpr int kRideChainMax = 4;

/** A seat a lift crushed against the world. */
struct Crush {
  std::string seat;
  std::string lift;
};

/** What the carry slot did: each seat's lift at the tick's start (−1 none), the seat it rides (its pair rule `stand`
 *  with `ride`), its carry's velocity, and the seats a lift crushed against the world. */
struct CarryReport {
  std::vector<int> bases;
  std::vector<std::optional<std::string>> on;
  std::vector<std::optional<Vec3>> v;
  std::vector<Crush> crushed;
  /** Each seat's x y z after the carry slot: `RideSlot` reads a ridden seat's walk from it. */
  std::vector<Vec3> from;
};

/** The carry slot of tick `tick`, before its inputs, on `seats` in their order (ids ascending), each changed in
 *  place, every support and carry read from the seats as they were:
 *   1. its support: the lift it stands on among the lifts posed at `tick` (`ops.Support`), or, with `heads`, the seat
 *      whose head slab it stands on (ridden when their pair rule is `stand` with `ride`);
 *   2. on lift L: carried by L to `tick + 1` (a vehicle's yaw, `turnYaw`, turned with it); riding seat S: by S's
 *      carry (a chain base first; S's walk follows in `RideSlot`, after the steps);
 *   3. every other lift it is inside at `tick + 1`, in order: moved by that lift's move at its point, then pushed out;
 *      still inside a solid: crushed by that lift.
 *  Writes x y z (yaw) as float32; the report's `from` is each seat's place as the slot left it. */
GENEX_CORE_API CarryReport CarrySlot(const LiftsPolicy& policy, std::vector<LiftSeat>& seats, double tick, double tickHz,
                                     const Starts* starts, const HullOps& ops, bool turnYaw, const TickSolids& solids,
                                     const HeadsContext* heads = nullptr);

/** The ride slot of a tick, after its inputs' steps and before its contact pass: a seat riding seat S (`report.on`)
 *  is moved in x y by S's walk this tick (S's place now less its place after the carry slot, `report.from`: every
 *  step S's inputs took, none on a held starve) and by S's own ride, base first, kRideChainMax deep, so it keeps its
 *  place on S's head. Its carry's velocity gains that move. `seats` are the carry slot's, in its order, changed in
 *  place (x y as float32); returns the report with the riders' velocities. */
GENEX_CORE_API CarryReport RideSlot(std::vector<LiftSeat>& seats, const CarryReport& report, double tickHz);

/** The impart slot of tick `tick`, after its contact pass: a seat that stood on lift L at the tick's start and no
 *  longer stands on it among the lifts posed at `tick + 1` keeps L's velocity at its point when L imparts; a seat that
 *  rode seat S and no longer stands on S's head keeps its carry's velocity. Writes vx vy vz as float32. */
GENEX_CORE_API void ImpartSlot(const LiftsPolicy& policy, std::vector<LiftSeat>& seats, const CarryReport& report, double tick,
                               const Starts* starts, const HullOps& ops, const std::vector<PosedSolid>& next,
                               const HeadsContext* heads = nullptr);

/** One seat's head slabs: the posed solids and, by the same index, the id of the seat each is the top of. */
struct HeadSlabs {
  std::vector<PosedSolid> solids;
  std::vector<std::string> lowers;
};

/** Whether a policy has any `stand` rule (its top or a pair's): a room without one has no head slabs. */
GENEX_CORE_API bool HasStand(const contact::ContactPolicy& policy);
/** Seat `lower`'s top as a slab at its place plus its velocity over `dt`: `groundTrace` thick under the top, a hull's
 *  square footprint, a box turned with its heading. */
GENEX_CORE_API PosedSolid HeadSlab(const contact::PolicyBody& lower, const contact::ContactPolicy& policy, double dt);
/** Every seat's head slabs (ids ascending in `seats`, read as they are): for seat i, the slab of each other seat it
 *  may stand on, in order, at its place plus its velocity over `dt` (0 at the tick's start for the carry slot's
 *  support; the tick's dt for the input steps). */
GENEX_CORE_API std::vector<HeadSlabs> HeadSlabsOf(const std::vector<contact::PolicyBody*>& seats, const contact::ContactPolicy& policy,
                                                  const contact::ContactEnv& env, double dt);
/** The head slabs of seat `i` alone (the same as HeadSlabsOf(seats, …)[i]). */
GENEX_CORE_API HeadSlabs HeadSlabsFor(const std::vector<contact::PolicyBody*>& seats, std::size_t i, const contact::ContactPolicy& policy,
                                      const contact::ContactEnv& env, double dt);

// ---- lifts as physics bodies (§17.11 *Lifts* step 9: a physics room's lifts are kinematic bodies) ----

/** A lift's body key in a physics room: `lift.<id>`. */
GENEX_CORE_API std::string LiftBodyKey(const std::string& id);
/** A lift's body pose at `tick`: its centre and its yaw as a quaternion about z (portable sine, float32). */
struct LiftBodyPose {
  Vec3 p{};
  std::array<double, 4> q{};
};
GENEX_CORE_API LiftBodyPose LiftBodyPoseAt(const Lift& lift, double tick, const Starts* starts = nullptr);
/** A lift's kinematic body as a physics room spawns it at `tick`: one collider `lift`, its box (a disc a 16-sided
 *  prism, its corners from the portable sine), frictionless on a conveyor. */
GENEX_CORE_API Json LiftBodySpawn(const Lift& lift, double tick, const Starts* starts = nullptr);

/** How fast a conveyor brings a body on it to its surface velocity, per second. */
constexpr double kConveyorRate = 20;

/** A dynamic body as the built-in body rules read it after the last step: its key, centre and velocity. */
struct RuleProp {
  std::string key;
  Vec3 p{};
  Vec3 v{};
};
/** A velocity a built-in body rule sets. */
struct PropNudge {
  std::string key;
  Vec3 v{};
};
/** The conveyor rule of tick `tick` (before its physics step): each dynamic body (in the order given: key order)
 *  whose centre is over a conveyor's top at `tick` (inside its footprint in its own frame, above its top by more than
 *  0 and at most `reach`; the first such conveyor in declared order) has its horizontal velocity brought toward the
 *  carry velocity of its point from `tick` to `tick + 1` by the share `min(1, kConveyorRate / tickHz)` of the
 *  difference; its vertical speed kept. */
GENEX_CORE_API std::vector<PropNudge> ConveyorNudges(const LiftsPolicy& policy, double tick, const Starts* starts, double tickHz,
                                                     const std::vector<RuleProp>& bodies, double reach);

/** A seat as the prop rule reads it: its key, feet and velocity (room units, per second). */
struct PropSeat {
  std::string key;
  double x = 0, y = 0, z = 0, vx = 0, vy = 0;
};
/** The prop rule under `headFriction: slide` (after the module's body rule, before the physics step): each dynamic
 *  body (key order) whose centre is over a seat's top (within its preset body's footprint `half`, above its top by at
 *  most the seat's height; the first such seat) has its parting from that seat, along the way from the seat's centre
 *  to its own (+x when centred), brought up to `slide.speed` by at most `slide.step`; vertical speed kept. */
GENEX_CORE_API std::vector<PropNudge> PropSlideNudges(const std::vector<PropSeat>& seats, const Vec3& half,
                                                      const std::vector<RuleProp>& bodies, const contact::PropSlide& slide);

// ---- the input's tick (§17.11 *The input's tick*, cap tick@1; TypeScript input-tick.ts) ----

/** The field's range (the predicted tick modulo this) and the slack, in seconds of ticks. */
constexpr double kInputTickMod = 65536;
constexpr double kInputTickSlackS = 0.5;
/** The field a client writes for an input it predicts at server tick `tick` (0 for a tick that is not a safe integer). */
GENEX_CORE_API double InputTickField(double tick);
/** How many ticks later than its client meant an input carrying `field` is applied at `applied`; 0 for a hostile
 *  field (none, not an integer in [0, 65536)), an applied tick that is not a safe integer, or a lag past the slack. */
GENEX_CORE_API double InputTickLag(std::optional<double> field, double applied, double tickHz);
/** A firstperson view on lift `lift` applied `lag` ticks late: `yaw` carried by the lift's turn, float32. */
GENEX_CORE_API double ViewOnLift(const Lift& lift, double yaw, double lag);

/** The room's lifts and built-in body rules for a client world's predictor (§17.11 *Lifts* step 9): each lift a
 *  kinematic body `lift.<id>`, the conveyor rule, and with `headSlide` the prop rule. */
GENEX_CORE_API std::shared_ptr<const physics::PredictLifts> MakePredictLifts(const LiftsPolicy& policy, const Starts& starts,
                                                                             std::optional<contact::PropSlide> headSlide = std::nullopt);

}  // namespace genex::lifts
