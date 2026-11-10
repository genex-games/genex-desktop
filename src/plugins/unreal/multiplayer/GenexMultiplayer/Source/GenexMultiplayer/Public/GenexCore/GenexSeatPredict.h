// Predicted seats (PROTOCOL.md §17.11 *Drawing other seats* `predicted`, *Seat contacts*): the Rocket League
// model, where the client predicts every seat on its own clock. A port of
// packages/multiplayer/src/authority/seat-predict.ts (SeatWorld, seatOffset), held to
// packages/netcode-bench/conformance/carball/carball-seat-predict.json by
// core/tools/carball_seat_predict_check.cpp (`passes` bit for bit, `draws` within the file's tolerance).
//
// Each other seat's entity is stepped from the latest state by the room's movement preset under its last
// applied input (held, `remotePredict: 'hold'`; or decayed, `inputDecay`; or moved by its velocity,
// `extrapolate`), and after each tick's steps the room module's seat contact pass runs on every seat, yours
// included, in the server's order. Your own entity's prediction takes its contacts from this world, the client
// world's preset bodies their poses, and the session draws other seats from it at the input your entity is
// drawn at, with a critically damped offset for each correction (SeatOffsetNext). Pure and transport-free:
// GenexAuthoritySession.cpp feeds it.
//
// Differences from the TypeScript, by shape only: a pass is shared (std::shared_ptr) so an offset can still
// read the pass it was measured in after a newer one started (the TypeScript keeps the object alive the same
// way); the decay uses std::exp (the vectors' `draws` allow for an exp's last bits).
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexPhysicsPredictor.h"
#include "GenexCore/GenexSeatContacts.h"

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace genex {

/**
 * A seat contact pass: what the room module does to every seat's entity after each tick's preset steps
 * (car-ball's pairs, pile passes and world passes), as a pure function of them all, ids ascending, changing
 * their fields in place. The module must run this very function. Without one, a session runs the pair rule
 * once on every pair, ids ascending.
 */
using SeatPassRule = std::function<void(std::vector<ContactBody>& seats)>;

/** Another seat's entity in the latest state: its preset fields (`body`), its life, and its last applied
 *  input (§17.11 *State*; none where the room writes none: moved by its velocity). */
struct HeldSeat {
  std::string id;
  double epoch = 0.0;
  std::map<std::string, double> body;
  std::optional<physics::RemoteInput> input;
};

/** One fixed step of a seat's entity under `input` (the room preset's own step), mutating `body`. */
using SeatStep = std::function<void(std::map<std::string, double>& body, const physics::RemoteInput& input, double dt)>;

/** A predicted seat after one tick: position, heading (radians) and velocity (room units, per second). */
struct SeatPose {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double yaw = 0.0;
  double vx = 0.0;
  double vy = 0.0;
  double vz = 0.0;
};

/** How fast a predicted seat's pose moves at an input: room units and radians per ms. */
struct SeatRate {
  double vx = 0.0;
  double vy = 0.0;
  double vz = 0.0;
  double vyaw = 0.0;
};

/** A predicted seat at an input: its pose there and how fast its predicted track moves there. */
struct SeatMotion {
  SeatPose pose;
  SeatRate rate;
};

/** A seat in the pass it was drawn from (`before`) and in the pass after it (`after`), at one input both passes
 *  stepped: what a new pass changed. */
struct SeatChange {
  SeatMotion before;
  SeatMotion after;
};

/** Other seats keep being predicted through a stall (no new state) this long past the lead cap, ms, then hold. */
constexpr double kStallPredictMs = 500.0;
/** τ of another seat's drawn correction, ms, and while it touches your entity in the prediction (a bump lands
 *  where it is drawn); past kSeatSnapMetres (times the room's units per metre) or at a new life it snaps
 *  (physics-keyframe.ts PredictSmoothing SEAT_TAU_MS, SEAT_CONTACT_TAU_MS, SEAT_SNAP_METRES). */
constexpr double kSeatTauMs = 70.0;
constexpr double kSeatContactTauMs = 100.0;
constexpr double kSeatSnapMetres = 6.0;
/** A seat drawn moving faster than kSeatMovingUnitsPerMs is never pulled back against that motion while its
 *  prediction goes on that way; once drawn slower for kSeatHoldMs it returns from rest. Other seats are drawn at
 *  an input moved on with the frame's time and pulled toward yours at 1 / kSeatClockTauMs, taken at once past
 *  kSeatClockSnapInputs (PredictSmoothing SEAT_HOLD_MS, SEAT_MOVING_UNITS_PER_MS, SEAT_CLOCK_TAU_MS,
 *  SEAT_CLOCK_SNAP_INPUTS). */
constexpr double kSeatHoldMs = 120.0;
constexpr double kSeatMovingUnitsPerMs = 0.2;
constexpr double kSeatClockTauMs = 100.0;
constexpr double kSeatClockSnapInputs = 1.5;

/** How other seats move between states (`physDesc.remotePredict`, `remoteDecayMs`). */
struct SeatRemote {
  physics::RemotePredict predict = physics::RemotePredict::Hold;
  double decayMs = 50.0;
};

/** What a SeatWorld runs: the module's rules and the session's view of the latest state. */
struct SeatWorldOptions {
  /** The room module's seat contact rule, on two seats (`a` the lower id). */
  ContactRule rule;
  /** The room module's whole contact pass; none: the rule once on every pair. */
  SeatPassRule pass;
  /** Every other seat in the latest state. */
  std::function<std::vector<HeldSeat>()> others;
  /** The room preset's step, or none when this client has none (seats are then extrapolated). */
  std::function<SeatStep()> step;
  /** The room module's seat rule, run on each other seat before each of its steps. */
  physics::SeatRule seatRule;
  /** How other seats move between states. */
  std::function<SeatRemote()> remote;
  /** How far past a state other seats are predicted at most, ms (the lead cap and kStallPredictMs). */
  std::function<double()> maxAheadMs;
};

/** One pass: the seats stepped from one state, tick by tick, as your inputs ack + 1, ack + 2, … were. */
struct SeatPass {
  std::uint64_t id = 0;
  double ack = 0.0;
  double stateTick = 0.0;
  double tickHz = 60.0;
  /** The last of your inputs applied, and the ticks the seats were stepped. */
  double last = 0.0;
  double ticks = 0.0;
  /** The seats, ids ascending. */
  std::vector<HeldSeat> seats;
  /** Each seat's pose after the tick your input `seq` was applied on (seq `ack`: the state's), by seq. */
  std::map<std::int64_t, std::vector<std::pair<std::string, SeatPose>>> poses;
  /** The seats touching your entity in the tick of input `seq` (before the contact pass). */
  std::map<std::int64_t, std::set<std::string>> touching;
  /** Your entity after the contact pass of the tick of input `seq`. */
  std::map<std::int64_t, ContactBody> own;
  /** Your entity as that tick's pass was given it (after your step, before any contact). */
  std::map<std::int64_t, ContactBody> ownIn;

  /** Seat `seat`'s pose after the tick of input `seq`, or null. */
  const SeatPose* PoseAt(std::int64_t seq, const std::string& seat) const;
};

/**
 * The other seats predicted from the latest state, as your own entity's prediction steps your inputs.
 * Apply after your input `seq` was stepped into your entity: a new pass starts when the state's ack or tick
 * changed, or `seq` is not after the last input applied (a replay), and the other seats are stepped to that
 * input's tick, then the contact pass runs on all of them and yours.
 */
class GENEX_CORE_API SeatWorld {
 public:
  explicit SeatWorld(SeatWorldOptions options);

  /**
   * After your input `seq` was stepped into `own` (the state of tick `stateTick` having consumed your inputs
   * through `ack`): the other seats stepped to that input's tick and the contact pass run on every seat. Your
   * fields the pass changed are written back as float32 (the entity's wire type).
   */
  void Apply(double seq, double ack, double stateTick, ContactBody& own, double tickHz);

  /** Where seat `id` is at your input `seq` (fractional: between two inputs), in `pass` (default the current
   *  one): between the two ticks around it, moved on by its velocity past the last one stepped (at most a
   *  tick). None for a seat the pass does not have. */
  std::optional<SeatPose> PoseAt(const std::string& id, double seq, const SeatPass* pass = nullptr) const;

  /** Seat `id` at your input `seq` in `pass` (default the current one): its pose and the slope of its predicted
   *  track over the half inputs either side, per ms of your inputs' ticks. */
  std::optional<SeatMotion> MotionAt(const std::string& id, double seq, const SeatPass* pass = nullptr) const;

  /** What the current pass changed for seat `id` from pass `from` (the one it was last drawn from): the seat in
   *  both at your input `seq`, or at `from`'s last stepped input when `seq` is past it. None when `from` is the
   *  current pass. */
  std::optional<SeatChange> ChangeAt(const std::string& id, double seq, const SeatPass* from) const;

  /** Whether seat `id` touches your entity in the tick of your input nearest `seq`. */
  bool TouchingAt(const std::string& id, double seq) const;

  /** How fast seat `id` moves in the latest state (the server's car, the pass's first pose), room units per ms
   *  (seat-predict.ts stateRate); none for a seat the current pass does not have. */
  std::optional<SeatRate> StateRate(const std::string& id) const;

  /** How soon seat `id` touches your entity from your input `seq`, ms (seat-predict.ts touchAheadMs, §17.11
   *  *Touching*): 0 when the pass's own contact test had the two touching in the tick of an input from `seq` to
   *  the one after it; else the first of kSeatTouchSamples steps along kSeatClockTauMs at which the room's contact
   *  rule touches your entity there with the seat moved on from it at the two's relative velocity; None when it
   *  does not (not touching). */
  std::optional<double> TouchAheadMs(const std::string& id, double seq) const;

  /** The current pass (null before the first). */
  std::shared_ptr<const SeatPass> Current() const { return current_; }

  /** The seats a pass found touching your entity in an input it was already stepped through that the input's
   *  live step did not have touching it, since the last call, ids ascending, and forgets them (seat-predict.ts
   *  takeMissed, §17.11 *Seat contacts*): the session re-predicts your inputs from the state. */
  std::vector<std::string> TakeMissed();

 private:
  void NoteMissed(const SeatPass& pass, std::int64_t seq);
  std::shared_ptr<SeatPass> Start(double ack, double stateTick, double tickHz);
  void Tick(SeatPass& pass, double i, ContactBody* own, bool write);
  void Move(SeatPass& pass, HeldSeat& seat, double i);
  void Extend(SeatPass& old, const SeatPass& now, double seq);
  void ContactPass(std::vector<ContactBody>& all) const;
  bool Touches(const ContactBody& mine, const ContactBody& b) const;

  SeatWorldOptions options_;
  std::uint64_t serial_ = 0;
  std::shared_ptr<SeatPass> current_;
  /** The passes before it, newest first (kRecentPasses): stepped on with the current one's ticks, so a seat last
   *  drawn from one of them is compared with the current pass at an input both stepped. */
  std::vector<std::shared_ptr<SeatPass>> recent_;
  /** The seats touching your entity in the tick each of your inputs was stepped live in, by input. */
  std::map<std::int64_t, std::set<std::string>> applied_;
  std::set<std::string> missed_;
};

/** The input other seats are drawn at (fractional) and the frame's time (ms). */
struct SeatClock {
  double seq = 0.0;
  double at = 0.0;
};

/**
 * The input other seats are drawn at this frame (seat-predict.ts seatClock): last frame's moved on by the time
 * since at the room's tick rate, then pulled toward the input your entity is drawn at (`raw`) by a share
 * 1 − e^(−dt / kSeatClockTauMs), never back; more than kSeatClockSnapInputs off (a reset, a stall), it is `raw`.
 */
GENEX_CORE_API SeatClock SeatClockNext(const SeatClock* known, double raw, double at, double tickHz);

/** TouchAheadMs tries the seat this many steps along kSeatClockTauMs of the two's relative motion. */
constexpr int kSeatTouchSamples = 8;

/** A seat's share of the way from the seat clock's input to your entity's exact one this frame (seat-predict.ts
 *  seatTouchShare, §17.11 *Touching*): last frame's moved toward 1 while the seat touches yours and toward 0 when it
 *  does not, by dt / kSeatClockTauMs, within [0, 1]; a seat without a share yet (`known` None) takes its target. */
GENEX_CORE_API double SeatTouchShare(std::optional<double> known, bool touching, double dtMs);

/** A drawn seat's correction: the offset (room units, radians) from its predicted pose to where it is drawn
 *  and how fast that offset is moving (per ms), the pass it was measured in and the seat's life. */
struct SeatOffset {
  std::shared_ptr<const SeatPass> pass;
  double epoch = 0.0;
  double dx = 0.0;
  double dy = 0.0;
  double dz = 0.0;
  double dyaw = 0.0;
  double vx = 0.0;
  double vy = 0.0;
  double vz = 0.0;
  double vyaw = 0.0;
  /** The predicted position it was drawn from (in that pass), the way the drawn seat was last seen moving (a unit
   *  vector, 0 before it moved) and how long it has been drawn slower than kSeatMovingUnitsPerMs since. */
  double ax = 0.0;
  double ay = 0.0;
  double az = 0.0;
  double hx = 0.0;
  double hy = 0.0;
  double hz = 0.0;
  double stillMs = 0.0;
  /** A new pass found it stopping late: slower along that way, at the same input, than the pass it was drawn from
   *  by more than kSeatMovingUnitsPerMs; kept while it is drawn stopped, decided again by each pass that arrives
   *  while it is drawn moving. */
  bool stopFound = false;
};

/** τ of a seat's correction (ms): kSeatContactTauMs while it touches your entity, else kSeatTauMs. */
inline double SeatTauMs(bool touching) { return touching ? kSeatContactTauMs : kSeatTauMs; }

/**
 * A seat's correction this frame (seat-predict.ts seatOffset): last frame's offset `known` brought `dtMs` closer to
 * 0 by a critically damped return at the seat's τ, plus what a new pass changed (`change`, SeatWorld::ChangeAt):
 * the offset takes the change of where it is and its rate the change of how fast it moves, so the drawn seat keeps
 * its place and velocity on that frame; the return never pulls it back against its drawn motion while its
 * prediction goes that way (keepCourse), nor while the server's car (`server`, its velocity in the latest state,
 * SeatWorld::StateRate) still moves that way. `now` is the seat in this pass at the drawn input. A new life (epoch),
 * no `known`, or an offset over `snapUnits` starts at 0.
 */
GENEX_CORE_API SeatOffset SeatOffsetNext(const SeatOffset* known, const std::shared_ptr<const SeatPass>& pass, double epoch,
                                         const std::optional<SeatChange>& change, const SeatMotion& now, double dtMs, bool touching,
                                         double snapUnits, const std::optional<SeatRate>& server = std::nullopt);

}  // namespace genex
