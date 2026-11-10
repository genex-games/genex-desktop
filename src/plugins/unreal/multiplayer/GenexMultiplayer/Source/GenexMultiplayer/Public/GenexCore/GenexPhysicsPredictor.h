// Predicting a physics room's bodies (PROTOCOL.md §17.11): the client world, keyframe adoption,
// replay, and the drawing of predicted bodies. A port of packages/multiplayer/src/authority/
// physics-predict.ts (PhysicsPredictor, the reference implementation) and the rules it reads from
// physics-keyframe.ts, held to packages/netcode-bench/conformance/authority/physics-predict.json by
// core/tools/physics_predict_check.cpp: every adoption and every client stateHash equal (tolerance 0),
// every drawn pose within 1e-4.
//
// Transport-free: the session (or the conformance check) builds each keyframe from the room state and
// hands it the poses its own prediction made. The client world is the room's static world, the
// island-complete bodies of the client's view (spawned from their canonical descriptors), each seat's
// preset body (yours posed from your predicted entity, the others extrapolated by their velocity or,
// `inputDecay`, stepped under their decayed input) and the module's kinematic bodies (posed from the
// keyframe, never extrapolated, never compared). Every predicted tick runs the server's order: preset
// and kinematic poses, step(), the speed clamp, and on t ≡ 0 (mod K) canonicalize({ quantize: true }).
// A keyframe either matches what the world predicted for its tick (skip-on-match) or the world imports
// it (importWire), canonicalizes and replays your inputs ack+1 … sent, at most
// ceil(leadMs·tickHz/1000) + K − 1 of them; a body that moved at the replay is eased from where it was
// drawn, critically damped keeping the last correction's rate (τ 300 ms up to 0.25 m, 100 ms from 1 m; a snap over 2 m for a player or
// vehicle, 6 m else).
//
// Everything here is float64 in the TypeScript's order, unfused (GENEX_FP_STRICT_BEGIN); what the core
// computes is its own float32, so the same steps give the same stateHash after every tick. Math.hypot
// is V8's algorithm (JsHypot), not libm's. Keys compare by bytes, which is the TypeScript's UTF-16 order
// for every key below U+E000.
#pragma once

#include "GenexCore/GenexBodies.h"
#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexJson.h"
#include "GenexCore/GenexSeatContacts.h"

#include <array>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <type_traits>
#include <utility>
#include <vector>

namespace genex::physics {

// ---- the core, as the predictor calls it (the structural subset of contract 1.1) ----

/** A call's answer: ok, or a refusal (the core's code, or one of the boundary's). */
struct CoreResult {
  bool ok = false;
  std::string code;
  std::string detail;
  static CoreResult Ok() {
    CoreResult r;
    r.ok = true;
    return r;
  }
  static CoreResult Refused(std::string why, std::string what = std::string()) {
    CoreResult r;
    r.code = std::move(why);
    r.detail = std::move(what);
    return r;
  }
};

/** §17.7's static world: rows of 6 (box) and 9 (ramp) numbers. */
struct StaticWorld {
  std::vector<std::vector<double>> boxes;
  std::vector<std::vector<double>> ramps;
  bool Empty() const { return boxes.empty() && ramps.empty(); }
};

/** step()'s answer: ok and the bodies that escaped (§8.2), in key order. */
struct StepResult {
  CoreResult result;
  std::vector<std::string> escaped;
};

/** exportChanged(since, { rest: true }): 15 float32 per key (p, q, v, w, sleeping, rest). */
struct ExportRows {
  std::vector<std::string> keys;
  std::vector<float> data;
};

/** exportBodyState(key, { rest: true }), as the core's JSON reply parses (float64 of its text). */
struct NetStateRest {
  double p[3] = {0.0, 0.0, 0.0};
  double q[4] = {0.0, 0.0, 0.0, 1.0};
  double v[3] = {0.0, 0.0, 0.0};
  double w[3] = {0.0, 0.0, 0.0};
  bool sleeping = false;
  double rest = 0.0;
};

/** One world of the game's core. */
class GENEX_CORE_API PredictWorld {
 public:
  virtual ~PredictWorld() = default;
  virtual double Tick() = 0;
  virtual CoreResult AddStaticWorld(const StaticWorld& world) = 0;
  virtual CoreResult Spawn(const Json& desc) = 0;
  virtual CoreResult Remove(const std::string& key) = 0;
  virtual CoreResult AddJoint(const Json& desc) = 0;
  virtual CoreResult RemoveJoint(const std::string& key) = 0;
  virtual CoreResult SetMotor(const std::string& key, const Json& motor) = 0;
  virtual CoreResult SetVelocity(const std::string& key, const double linvel[3], const double angvel[3]) = 0;
  virtual CoreResult SetNextKinematicPose(const std::string& key, const double p[3], const double q[4]) = 0;
  /** 15 numbers per key (§20.2); rows of any other length are refused before the core sees them. */
  virtual CoreResult ImportWire(const std::vector<std::string>& keys, const std::vector<float>& rows) = 0;
  virtual CoreResult Canonicalize(bool quantize) = 0;
  virtual StepResult Step() = 0;
  /** The empty export when the core's reply does not hold 15 numbers per key. */
  virtual ExportRows ExportChangedRest(double sinceTick) = 0;
  virtual std::optional<NetStateRest> ExportBodyStateRest(const std::string& key) = 0;
  /** 16 hex digits, '' for no world. */
  virtual std::string StateHash() = 0;
  virtual std::string PhysicsHash() = 0;
};

/** The game's loaded core. */
class GENEX_CORE_API PredictCore {
 public:
  virtual ~PredictCore() = default;
  virtual std::string BuildId() = 0;
  /** A world from its WorldDesc (§4), or nullptr with `refused` set. */
  virtual std::unique_ptr<PredictWorld> CreateWorld(const Json& desc, CoreResult* refused) = 0;
};

// ---- the room's physDesc (§17.11 *State*) ----

/** How a client moves other players' preset bodies between keyframes (module.ts RemotePredict): by their velocity,
 *  by their last input repeated and decayed (`inputDecay`), or by their last input held (`hold`, the Rocket League
 *  model: the room preset's step under that input every tick). */
enum class RemotePredict : std::uint8_t { Extrapolate, InputDecay, Hold };

/** A preset body's collider as the host spawns it. */
struct PresetBodyShape {
  double half[3] = {0.0, 0.0, 0.0};
  bool events = false;
};

struct PhysDesc {
  /** The contract's world description, as the server created the world. */
  Json world;
  /** K: a keyframe is the state after every tick t ≡ 0 (mod K). */
  int keyframeTicks = 1;
  double maxLinear = 64.0;
  double maxAngular = 64.0;
  std::optional<PresetBodyShape> presetBody;
  RemotePredict remotePredict = RemotePredict::Extrapolate;
  double remoteDecayMs = 50.0;
  double leadMs = 250.0;
};

/** physDesc's text read as parsePhysDesc reads it; nullopt when it is not one (knobs a server before
 *  them did not send take their defaults). */
GENEX_CORE_API std::optional<PhysDesc> ParsePhysDesc(const std::string& text);
/** The same from an already parsed value. */
GENEX_CORE_API std::optional<PhysDesc> PhysDescOf(const Json& raw);

// ---- keyframes, as the session (or a conformance case) gives them ----

inline constexpr std::size_t kWireRowStride = 15;
using WireRow = std::array<double, kWireRowStride>;

/** A module body in the client's view at the keyframe. */
struct KeyframeBody {
  std::string key;
  /** The canonical descriptor with its shapes inlined (C§20.5), or none: drawn, never predicted. */
  std::optional<Json> desc;
  WireRow row{};
  /** Its entity's epoch: a respawned body is never a sample of the canary. */
  std::optional<double> epoch;
};

/** A body the client knows but that is out of its view: where it last was (for islands only). */
struct KeyframeOutside {
  std::string key;
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double radius = 0.0;
};

/** A seat's last applied input (`AuthorityPlayer`'s in* fields). */
struct RemoteInput {
  double moveX = 0.0;
  double moveY = 0.0;
  double moveZ = 0.0;
  double yaw = 0.0;
  double pitch = 0.0;
  double buttons = 0.0;
};

/** A seat's own entity (its preset body's pose). */
struct KeyframeSeat {
  std::string key;
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double vx = 0.0;
  double vy = 0.0;
  double vz = 0.0;
  double epoch = 0.0;
  bool own = false;
  std::optional<RemoteInput> input;
  /** The entity's fields a RemoteStep reads (x, y, z at least); absent: x, y, z. */
  std::map<std::string, double> body;
};

/** A joint, its descriptor and the motor last set. */
struct KeyframeJoint {
  std::string key;
  Json desc;
  std::optional<Json> motor;
};

/** One keyframe: the room state after tick `tick`, and how many of your inputs it had consumed. */
struct PredictKeyframe {
  double tick = 0.0;
  double ack = 0.0;
  std::vector<KeyframeBody> bodies;
  std::vector<KeyframeOutside> outside;
  std::vector<KeyframeJoint> joints;
  std::vector<KeyframeSeat> seats;
};

/** `inputDecay`: one fixed step of a remote seat's entity under `input`, mutating `body` (x, y, z read). */
using RemoteStep = std::function<void(std::map<std::string, double>& body, const RemoteInput& input, double dt)>;
/** Your predicted entity's position after input `seq` (room units), or nullopt when unknown; the same
 *  shape gives your predicted velocity (room units per second) to Adopt's `ownVelocity`. */
using OwnPoseOf = std::function<std::optional<bodies::Vec3>(double seq)>;

// ---- the room module's rules, run in the client world (§17.11 *Body rules*, *Seat rules*) ----

/** A seat's entity at one predicted tick, as a body rule reads it: position (room units) and velocity
 *  (room units per second). */
struct RuleSeat {
  std::string key;
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double vx = 0.0;
  double vy = 0.0;
  double vz = 0.0;
  /** The heading, radians, where the seat's body carries one (the contact pass reads it); 0 else. */
  double yaw = 0.0;
};

/** A simulated dynamic body's state after the previous tick's step (room units, per second). */
struct RuleBody {
  bodies::Vec3 p;
  bodies::Vec3 v;
};

/** What a body rule reads at a predicted tick: every seat's entity at that tick (key order) and a
 *  simulated dynamic body's state (none for any other key). `seats` and `body` are valid only during
 *  the call. */
struct RuleTick {
  double tick = 0.0;
  const std::vector<RuleSeat>* seats = nullptr;
  std::function<std::optional<RuleBody>(const std::string&)> body;
};

/** A velocity a body rule sets (room units per second), as the module's setVelocity would. */
struct RuleVelocity {
  std::string key;
  bodies::Vec3 v;
};

/**
 * A body rule (§17.11 *Body rules*): what the room module does each tick to its dynamic bodies'
 * velocities from the seats' entities and the bodies' states (a scripted hit on a ball), as a pure
 * function. The client world runs it before every predicted step and sets each velocity it returns,
 * in its order, on the simulated dynamic body it names (any other key is ignored; a velocity the core
 * refuses, NaN or past float32, changes nothing).
 */
using BodyRule = std::function<std::vector<RuleVelocity>(const RuleTick&)>;

/**
 * A seat rule (§17.11 *Seat rules*, seat-contacts.ts's AuthoritySeatRule): what the room module does
 * to a seat's own entity at a tick it announced in advance (a kickoff releasing held cars), changing
 * its fields in place before that tick's input step. The session runs it on your own entity before each
 * predicted input, with that input's sequence `seq` (a rule keyed to one of your inputs: an input fired at
 * `s` was applied on `tick − (seq − s)`); the predictor runs it on each other seat's body before each of
 * its inputDecay steps, at the keyframe's tick + j, with no sequence. Made from a callable taking
 * (seat, tick) or (seat, tick, std::optional<double> seq).
 */
class SeatRule {
 public:
  using Fn = std::function<void(std::map<std::string, double>& seat, double tick)>;
  using SeqFn = std::function<void(std::map<std::string, double>& seat, double tick, std::optional<double> seq)>;
  SeatRule() = default;
  SeatRule(std::nullptr_t) {}
  template <class F, std::enable_if_t<!std::is_same_v<std::decay_t<F>, SeatRule> && !std::is_same_v<std::decay_t<F>, std::nullptr_t>, int> = 0>
  SeatRule(F f) {
    if constexpr (std::is_invocable_v<F&, std::map<std::string, double>&, double, std::optional<double>>) {
      withSeq_ = SeqFn(std::move(f));
    } else {
      plain_ = Fn(std::move(f));
    }
  }
  explicit operator bool() const { return static_cast<bool>(plain_) || static_cast<bool>(withSeq_); }
  /** Runs the rule: `seq` is your input's sequence, std::nullopt on another seat's step. */
  void operator()(std::map<std::string, double>& seat, double tick, std::optional<double> seq = std::nullopt) const {
    if (withSeq_) withSeq_(seat, tick, seq);
    else if (plain_) plain_(seat, tick);
  }

 private:
  Fn plain_;
  SeqFn withSeq_;
};

/**
 * A kinematic rule (§17.11 *Kinematic rules*, physics-predict.ts PredictKinematicRule): where the room module poses
 * one of its kinematic bodies (a door, a platform, a moving floor) at tick `tick`, as a pure function of the body's
 * key and the tick (its keyframed schedule), or std::nullopt for a body it does not pose. The module issues
 * setNextKinematicPose(key, rule(key, t + 1)) in its step of tick t; the client world does the same before every
 * predicted step and draws the body as a predicted one, also outside the simulated set.
 */
using KinematicRule = std::function<std::optional<bodies::Pose>(const std::string& key, double tick)>;

/** §17.11 *Kinematic rules* (physics-predict.ts ruledPoseAt): where `rule` poses `key` at room-clock instant `at` on
 *  the server's own timeline (its pose for tick T stands at `tickOrigin + T / tickHz`), between the two ticks around
 *  `at`; nullopt when the rule does not pose `key`. What a client draws for a ruled body whenever the predictor does
 *  not draw it (no core, cpu, any fallback level), in place of §17.10's extrapolation. */
GENEX_CORE_API std::optional<bodies::Pose> RuledPoseAt(const KinematicRule& rule, const std::string& key, double at,
                                                       double tickHz, double tickOrigin);

/** A ruled body outside the simulated set follows the world's timeline at a rate within this share of the room
 *  clock's (§17.11 *Kinematic rules*): a 3-tick shift is absorbed in 30 ticks. */
inline constexpr double kRuledSlew = 0.1;
/** Past this many ticks off the world's timeline the ruled clock snaps to it. */
inline constexpr double kRuledSnapTicks = 30.0;

// ---- budgets and fallbacks (§17.11 *Budgets*, *Fallback levels*) ----

inline constexpr double kResimBudgetDesktopMs = 4.0;
inline constexpr double kResimBudgetMobileMs = 5.0;
/** The simulated set's sizes: the next one that chooses fewer bodies is taken when replays run over
 *  budget; with none left, `cpu`. */
inline constexpr int kPredictSetSizes[] = {128, 64, 32};
/** The rolling window of replay costs (the clock around the rebuild and replay only): the latest this
 *  many replays, judged once it holds kBudgetMinSamples. */
inline constexpr std::size_t kBudgetWindow = 60;
inline constexpr std::size_t kBudgetMinSamples = 20;
/** Over budget: the window's median over the budget, or its p90 over this many budgets. */
inline constexpr double kBudgetP90Factor = 2.0;
/** Calm: the window's p90 (or a probe) at or under this share of the budget. */
inline constexpr double kBudgetCalmShare = 0.5;
/** In `cpu`, one keyframe in this many ms is adopted by a full replay (a probe, never drawn). */
inline constexpr double kCpuProbeMs = 500.0;
/** Calm probes in a row that turn prediction on again. */
inline constexpr int kCpuCalmProbes = 4;
inline constexpr std::size_t kCanaryWindow = 500;
inline constexpr double kCanaryMaxMismatch = 0.02;
inline constexpr std::size_t kCanaryMinSamples = 200;
inline constexpr std::size_t kHashesKeptDefault = 600;

/** The set size (an index of kPredictSetSizes) to shrink to from `current` when the last choice took
 *  `chosen` bodies: the next size under `chosen` (one at or over it would choose the same bodies), or
 *  nullopt when none is left (nextPredictSetSize). */
GENEX_CORE_API std::optional<std::size_t> NextPredictSetSize(std::size_t current, double chosen);

/** Why bodies are (not) predicted; names are the TypeScript's `PredictStatus` values. Cpu: replays run
 *  over budget at the smallest set that helps; drawn §17.10's way, the world kept for a probe every
 *  kCpuProbeMs, on again after kCpuCalmProbes calm ones. */
enum class PredictStatus : std::uint8_t { On, Off, Loading, Unavailable, Mismatch, SelfTest, Diverged, Cpu };
GENEX_CORE_API const char* PredictStatusName(PredictStatus status);

/** A dynamic body as the built-in body rules read it after the last step: its key, centre and velocity. */
struct RuleProp {
  std::string key;
  bodies::Vec3 p;
  bodies::Vec3 v;
};

/** A room's declared lifts and built-in body rules as a client world runs them (§17.11 *Lifts* step 9, *Contact
 *  policy* `headFriction: slide`), behind an interface so the predictor links without the lifts module (the Godot
 *  extension builds the predictor alone). Made by `lifts::MakePredictLifts`. */
class PredictLifts {
 public:
  virtual ~PredictLifts() = default;
  /** How many lift bodies (`lift.<id>`) the client world holds. */
  virtual std::size_t Count() const = 0;
  virtual std::string Key(std::size_t i) const = 0;
  /** Lift i's body as the world spawns it at `tick`. */
  virtual Json Spawn(std::size_t i, double tick) const = 0;
  /** Lift i's body pose at `tick`: centre and quaternion (float32). */
  virtual void Pose(std::size_t i, double tick, double p[3], double q[4]) const = 0;
  /** Whether a built-in body rule runs: a conveyor, or the prop rule. */
  virtual bool HasRules() const = 0;
  /** The built-in rules of tick `tick` after the module's: the conveyor rule, then the prop rule, on the dynamic
   *  bodies as the last step left them (key order), with the seats (key order) and the preset body's half. */
  virtual std::vector<RuleVelocity> Rules(double tick, double tickHz, const std::vector<RuleSeat>& seats, const std::vector<RuleProp>& props,
                                          const double half[3]) const = 0;
};

struct PredictorOptions {
  PhysDesc desc;
  StaticWorld staticWorld;
  std::string physicsHash;
  double tickHz = 60.0;
  double budgetMs = kResimBudgetDesktopMs;
  /** Replays are timed on this clock, ms (default: genex::Clock). */
  std::function<double()> clock;
  /** How a remote seat steps under its decayed input (inputDecay rooms); none: extrapolated. */
  RemoteStep remoteStep;
  /** The lead cap, ms (default physDesc.leadMs). */
  std::optional<double> leadMs;
  /** How many of the latest per-tick stateHashes `Hashes()` keeps (0: all). */
  std::size_t hashesKept = kHashesKeptDefault;
  /** The room module's body rule; none: module commands arrive as corrections. */
  BodyRule bodyRule;
  /** The room module's seat rule, run on each other seat's body before each of its inputDecay steps. */
  SeatRule seatRule;
  /** The room module's kinematic rule (§17.11 *Kinematic rules*); none: every module kinematic body holds the
   *  keyframe's pose and is drawn from the server's states. */
  KinematicRule kinematicRule;
  /** Another seat's entity after the tick of your input `seq`, as the session's seat prediction has it (§17.11
   *  *Drawing other seats* `predicted`: stepped under its held input with the room's contact pass); when it
   *  answers, it poses that seat's preset body, else the seat is moved as `remotePredict` says. */
  std::function<std::optional<RuleSeat>(const std::string& key, double seq)> seatPose;
  /** The room's seat contact pass (§17.11 *Contact policy*, the declared one or the module's), run on each predicted
   *  tick's seats in id order before they pose their preset bodies, on ticks where the session's seat prediction
   *  posed none of them (that prediction runs the pass itself). */
  std::function<void(std::vector<ContactBody>& seats)> contactPass;
  /** The room's declared lifts (§17.11 *Lifts* step 9), else none: each a kinematic body `lift.<id>` of the client
   *  world posed at P(t + 1) in each predicted tick t, and the built-in conveyor rule after the module's body rule. */
  std::shared_ptr<const PredictLifts> lifts;
};

/** What one keyframe's adoption did. */
struct AdoptReport {
  enum class Kind : std::uint8_t { None, Match, Replay };
  /** The first check a keyframe failed, in Compare's order (none: it matched, or it was a probe). */
  enum class Miss : std::uint8_t { None, NoPrediction, Rows, BodySet, AckLate, Joints, Seats };
  Kind kind = Kind::None;
  Miss miss = Miss::None;
  int replayed = 0;
  double ms = 0.0;
  int pure = 0;
  int mismatched = 0;
};
GENEX_CORE_API const char* AdoptKindName(AdoptReport::Kind kind);

struct TickHash {
  double tick = 0.0;
  std::string hash;
};

/** A key → value map that iterates in insertion order, as a JavaScript Map does (a set on a present
 *  key keeps its place; a delete then a set appends). */
template <typename V>
class InsertionMap {
 public:
  std::size_t Size() const { return items_.size(); }
  bool Has(const std::string& key) const { return Index(key) != npos(); }
  V* Get(const std::string& key) {
    const std::size_t i = Index(key);
    return i == npos() ? nullptr : &items_[i].second;
  }
  const V* Get(const std::string& key) const {
    const std::size_t i = Index(key);
    return i == npos() ? nullptr : &items_[i].second;
  }
  void Set(const std::string& key, V value) {
    const std::size_t i = Index(key);
    if (i == npos()) {
      items_.emplace_back(key, std::move(value));
    } else {
      items_[i].second = std::move(value);
    }
  }
  bool Delete(const std::string& key) {
    const std::size_t i = Index(key);
    if (i == npos()) return false;
    items_.erase(items_.begin() + static_cast<std::ptrdiff_t>(i));
    return true;
  }
  void Clear() { items_.clear(); }
  const std::vector<std::pair<std::string, V>>& Items() const { return items_; }
  std::vector<std::pair<std::string, V>>& Items() { return items_; }

 private:
  static constexpr std::size_t npos() { return static_cast<std::size_t>(-1); }
  std::size_t Index(const std::string& key) const {
    for (std::size_t i = 0; i < items_.size(); ++i) {
      if (items_[i].first == key) return i;
    }
    return npos();
  }
  std::vector<std::pair<std::string, V>> items_;
};

/**
 * One room's predictor. Adopt() each keyframe, Advance() once per input you send (with your predicted
 * pose after it), and Draw() a body at render time; StateHash() reads the client world.
 */
class GENEX_CORE_API PhysicsPredictor {
 public:
  PhysicsPredictor(std::shared_ptr<PredictCore> core, PredictorOptions options);
  ~PhysicsPredictor();
  PhysicsPredictor(const PhysicsPredictor&) = delete;
  PhysicsPredictor& operator=(const PhysicsPredictor&) = delete;

  PredictStatus Status() const { return status_; }
  /** Whether bodies are predicted now (else the session draws them §17.10's way). */
  bool Predicting() const { return status_ == PredictStatus::On || status_ == PredictStatus::Loading; }
  /** Whether the predictor stopped for good (its world freed): every status but on, loading and cpu,
   *  which probes its way back. */
  bool Stopped() const { return !world_; }
  /** How many times the budget turned prediction off (to cpu), and on again. */
  int Fallbacks() const { return fallbacks_; }
  int Recoveries() const { return recoveries_; }
  /** Whether `key` is a body this predictor draws (only while on). */
  bool Draws(const std::string& key) const;
  /** The client world's stateHash, '' without a world. */
  std::string StateHash();
  /** Stops predicting for good (a fallback, or the session ended). */
  void Stop(PredictStatus status);

  /**
   * Adopts a keyframe. `sent` is your last input's sequence; `ownPose` your predicted position after
   * each of them, `ownVelocity` your predicted velocity (a body rule reads it; none: your entity's
   * keyframe velocity). In cpu only a probe adopts (one keyframe every kCpuProbeMs of `now`).
   */
  AdoptReport Adopt(const PredictKeyframe& kf, double sent, const OwnPoseOf& ownPose, double now,
                    const OwnPoseOf& ownVelocity = OwnPoseOf());
  void Advance(double seq, double now);
  std::optional<bodies::Pose> Draw(const std::string& key, double now) const;

  /** The client stateHash after each predicted tick, newest last. */
  const std::vector<TickHash>& Hashes() const { return hashes_; }
  /** The lead cap: inputs past a keyframe's ack the world steps at most. */
  int LeadMax() const { return leadMax_; }

 private:
  struct Simulated {
    std::string type;
    std::string desc;
  };
  struct JointText {
    std::string desc;
    std::string motor;
  };
  struct WantedJoint {
    std::string desc;
    std::string motor;
    const KeyframeJoint* parsed = nullptr;
  };
  struct Drawn {
    bodies::Vec3 p;
    bodies::Quat q;
    bodies::Vec3 lv;
    bodies::Vec3 av;
    bool sleep = false;
    bodies::Vec3 dp;
    /** The position correction's rate when it started, room units per ms (§17.11 *Drawing*). */
    bodies::Vec3 dv;
    bodies::Quat dq;
    double since = 0.0;
    double tau = 300.0;
    double snap = 6.0;
  };
  /** A body as drawn at an instant: its pose and its correction's rate then (units per ms). */
  struct DrawnAt {
    bodies::Pose pose;
    bodies::Vec3 rate;
  };
  struct Base {
    double tick = 0.0;
    double ack = 0.0;
  };
  /** inputDecay: a remote seat's body as last stepped, `j` ticks from the keyframe seat it was held
   *  as (`from`: the serial HoldSeat gave it; the TypeScript compares the seat object's identity). */
  struct RemoteBody {
    std::uint64_t from = 0;
    double j = 0.0;
    std::map<std::string, double> body;
  };

  std::vector<const KeyframeBody*> Choose(const PredictKeyframe& kf);
  AdoptReport Compare(const PredictKeyframe& kf, const std::vector<const KeyframeBody*>& chosen,
                      const std::set<std::string>& respawned);
  bool SameJoints(const PredictKeyframe& kf) const;
  bool SameSeats(const PredictKeyframe& kf, const std::map<std::string, WireRow>& predicted) const;
  void NoteCanary(int pure, int mismatched);
  void JudgeBudget(double ms);
  void FallBack();
  void JudgeProbe(double ms, double now);
  void HoldSeat(const KeyframeSeat& seat);
  InsertionMap<WantedJoint> JointsOf(const PredictKeyframe& kf) const;
  std::vector<const KeyframeSeat*> SeatsOf(const PredictKeyframe& kf) const;
  void PresetPosition(double x, double y, double z, double out[3]) const;
  bool Rebuild(const PredictKeyframe& kf, const std::vector<const KeyframeBody*>& chosen);
  bool RebuildSeats(const PredictKeyframe& kf);
  void StepOnce();
  RuleSeat SeatAt(const KeyframeSeat& s, double seq, double j);
  /** The room's contact pass on this tick's seats (copies, ids ascending), their poses and velocities taken from what
   *  it left (§17.11 *Contact policy*: the replay runs the server's pass). */
  void PassSeats(std::vector<RuleSeat>& seats);
  void ApplyBodyRule(double tick, std::vector<RuleSeat>& seats);
  void Clamp(double since);
  std::map<std::string, WireRow> RowsNow();
  void Prune(double tick);
  void ReadDrawn(double since);
  void ReadAll();
  std::map<std::string, DrawnAt> SnapshotDrawn(double now) const;
  double SnapOf(const std::string& key) const;
  /** After a replay: each body that moved starts a correction from where it was drawn; one in `respawned` (a new
   *  life) snaps. */
  void Ease(const std::map<std::string, DrawnAt>& before, double now, const std::set<std::string>& respawned);
  double Now() const;

  PredictStatus status_ = PredictStatus::Loading;
  std::shared_ptr<PredictCore> core_;
  PhysDesc desc_;
  double tickHz_ = 60.0;
  double innerDt_ = 0.0;
  double lengthUnit_ = 1.0;
  double worldExtent_ = 0.0;
  int leadMax_ = 0;
  double budgetMs_ = kResimBudgetDesktopMs;
  std::function<double()> clock_;
  RemoteStep remoteStep_;
  std::function<std::optional<RuleSeat>(const std::string& key, double seq)> seatPose_;
  std::function<void(std::vector<ContactBody>& seats)> contactPass_;
  /** Whether the seat SeatAt last gave came from the session's seat prediction. */
  bool posedBySeats_ = false;
  std::size_t hashesKept_ = kHashesKeptDefault;
  std::unique_ptr<PredictWorld> world_;
  std::optional<Base> base_;
  double seq_ = 0.0;
  InsertionMap<Simulated> simulated_;
  InsertionMap<KeyframeSeat> seats_;
  InsertionMap<WireRow> kinematic_;
  InsertionMap<JointText> joints_;
  std::map<double, std::map<std::string, WireRow>> ring_;
  std::set<std::string> pure_;
  std::map<std::string, Drawn> drawn_;
  std::map<std::string, std::string> kinds_;
  OwnPoseOf ownPose_;
  OwnPoseOf ownVelocity_;
  BodyRule bodyRule_;
  SeatRule seatRule_;
  KinematicRule kinematicRule_;
  std::shared_ptr<const PredictLifts> lifts_;
  /** Whether the client world holds the lifts' bodies (spawned at the first rebuild). */
  bool liftsSpawned_ = false;
  /** The room's lift bodies brought to the keyframe: spawned once, each with its wire row at P(tick + 1), still;
   *  false when the core refused one. */
  bool RebuildLifts(double tick, std::vector<std::string>& keys, std::vector<float>& rows);
  /** The simulated dynamic bodies (key order) as the built-in body rules read them, when one runs. */
  std::optional<std::vector<RuleProp>> BuiltInProps();
  /** The built-in body rules after the module's: the conveyor rule, then the prop rule. */
  void ApplyBuiltInRules(double tick, const std::vector<RuleSeat>& seats, const std::vector<RuleProp>& props);
  /** The room module's body rule on this tick's seats (sorted by key). */
  void ApplyModuleRule(double tick, std::vector<RuleSeat>& seats);
  /** Whether the kinematic rule poses module kinematic body `key` (at the world's tick). */
  bool Ruled(const std::string& key) const;
  /** A body the kinematic rule poses that the world does not simulate: drawn by the rule on the world's timeline. */
  bool RuledElsewhere(const std::string& key) const;
  /** A ruled body outside the world as drawn at `now`: the rule's pose at the ruled clock's tick. */
  std::optional<bodies::Pose> RuledDrawn(const std::string& key, double now) const;
  /** The ruled clock at `now` (physics-predict.ts ruledTick): it runs with the room clock and slews toward the
   *  world's timeline (the last stepped tick plus one, toward the next by the time since that step, at most one
   *  tick) by at most kRuledSlew of the time passed, so a replay that moves the timeline (the server ran a tick
   *  without your input, or took two in one) is absorbed without a jump or a reversal; past kRuledSnapTicks it
   *  snaps. Nullopt before the first keyframe. */
  std::optional<double> RuledTick(double now) const;
  struct RuledClock {
    double at = 0.0;
    double tick = 0.0;
  };
  /** The fractional tick ruled bodies outside the simulated set are drawn at: the world's timeline, slewed so a
   *  replay that moves it never jumps or reverses them. Drawing moves it, hence mutable. */
  mutable std::optional<RuledClock> ruledClock_;
  /** Each held seat's serial (a new one each time a keyframe's seat is held: the memo's identity). */
  std::map<std::string, std::uint64_t> seatSerial_;
  std::uint64_t nextSeatSerial_ = 0;
  std::map<std::string, RemoteBody> remoteBodies_;
  std::size_t setSize_ = 0;
  /** The latest replay costs, ms (the budget's rolling window). */
  std::deque<double> costs_;
  /** In cpu: when the last probe ran (the `now` Adopt is given), and calm probes in a row. */
  double probedAt_ = -std::numeric_limits<double>::infinity();
  int calmProbes_ = 0;
  /** How many bodies the last choice could take (every island-complete body). */
  double chosenCount_ = 0.0;
  int fallbacks_ = 0;
  int recoveries_ = 0;
  double steppedAt_ = 0.0;
  std::deque<bool> canary_;
  std::map<std::string, double> epochs_;
  std::set<std::string> chosenKeys_;
  std::vector<TickHash> hashes_;
};

// ---- the shared rules (physics-keyframe.ts), exposed for the session and the checks ----

/** Math.fround: the float32 nearest `v` (ties to even), ±Infinity past float32's range, NaN kept. */
GENEX_CORE_API double Fround(double v);

/** Math.hypot as V8 computes it (max-scaled Kahan sum), so a port picks the same islands. */
GENEX_CORE_API double JsHypot(double a, double b, double c);
/** The uint16 a quantized field sends for `v` over [min, max]: out of range clamps, NaN is 0. */
GENEX_CORE_API double QuantizeBodyValue(double v, double min, double max);
/** One inner step as the core computes it: fround(fround(dt) / substeps). */
GENEX_CORE_API double InnerDtOf(double dt, double substeps);
/** min(65535, floor(rest / innerDt + 0.5)); NaN or negative is 0. */
GENEX_CORE_API double RestStepsOf(double rest, double innerDt);
/** A body's bounding radius about its origin, from its (inlined) descriptor. */
GENEX_CORE_API double BodyRadiusOf(const Json& desc);
/** Where a body of the state stands out of view in a keyframe (session.ts keyframeOf), or none when it is
 *  in the keyframe: `listed` its entity's position when the state lists it, `motionKnown` false when the
 *  fast channel's newest snapshot does not carry its record (§17.12 *Client*: its motion is another
 *  keyframe's), `lastSeen` where a keyframe last had it in view. Out of view, it stands at its last seen,
 *  else where it is listed, else at the origin. */
GENEX_CORE_API std::optional<bodies::Vec3> OutOfViewAt(const std::optional<bodies::Vec3>& listed, bool motionKnown,
                                                       const std::optional<bodies::Vec3>& lastSeen);
/** inputDecay's weight on the j-th tick after a keyframe (j ≥ 1). */
GENEX_CORE_API double RemoteInputWeight(double j, double tickHz, double decayMs);
/** The share of a correction still drawn `age` ms after it started (§17.11 *Drawing*): critically damped from
 *  rest, (1 + age/τ)·e^(−age/τ), so the frame it starts on draws the body where it was drawn. */
GENEX_CORE_API double CorrectionShare(double age, double tauMs);
/** A replay's correction of one axis `age` ms after it started from offset `o0` (room units) and rate `r0` (units
 *  per ms), critically damped at τ/2 (§17.11 *Drawing*): {offset, rate}. A new correction keeps the last one's rate. */
GENEX_CORE_API std::pair<double, double> CorrectionAt(double o0, double r0, double age, double tauMs);
/** A correction's τ (ms) by its size in metres. */
GENEX_CORE_API double CorrectionTauMs(double metres);
/** The metres past which a body of physics `kind` snaps (2 for player and vehicle, 6 else). */
GENEX_CORE_API double SnapMetresOf(const std::string* kind);
/**
 * §17.11 *Drawing* (physics-keyframe.ts DrawHandoff): a body that moves between the predictor's drawing (the client
 * world's timeline, ahead) and §17.10's (the server's present), because it entered or left the simulated set, starts
 * a correction from where it was last drawn, eased like a replay's (τ by its size, snapped past `snapMetres`), so it
 * never jumps by its velocity times the lead. A new epoch never eases. One per drawn body, kept by the session.
 */
class GENEX_CORE_API DrawHandoff {
 public:
  /** The pose to draw at room-clock `now` (ms) for `pose`, drawn by the predictor (`predicted`) or not. */
  bodies::Pose Draw(const bodies::Pose& pose, bool predicted, double epoch, double now, double snapMetres, double lengthUnit);

 private:
  struct Last {
    bodies::Pose pose;
    bool predicted = false;
    double epoch = 0.0;
  };
  struct Offset {
    bodies::Vec3 dp;
    bodies::Quat dq;
    double since = 0.0;
    double tau = 300.0;
  };
  void StartFrom(const bodies::Pose& from, const bodies::Pose& to, double now, double snapMetres, double lengthUnit);
  bodies::Pose Apply(const bodies::Pose& pose, double now) const;
  std::optional<Last> last_;
  std::optional<Offset> offset_;
};

/** A wire row of a body entity's decoded fields (§17.11: re-quantized, which gives the integers sent). */
GENEX_CORE_API WireRow WireRowOfFields(const bodies::BodyFields& fields, double rest);

/**
 * Whether the core keeps the promise prediction rests on (§17.11 level 2): a world stepped, then
 * canonicalized with `quantize`, and a second world built from the same descriptors that imports its
 * wire rows and canonicalizes, step on with equal stateHashes. False also when the core refuses any of it.
 */
GENEX_CORE_API bool SelfTestPredictCore(PredictCore& core);

}  // namespace genex::physics
