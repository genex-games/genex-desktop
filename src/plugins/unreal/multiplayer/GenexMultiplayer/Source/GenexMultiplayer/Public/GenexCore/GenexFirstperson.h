// The `firstperson` movement preset (PROTOCOL.md §17.7): Source-engine character movement through a
// static world of boxes and ramps, z up, the hull's feet centred at (x, y, z). Ported expression for
// expression from packages/multiplayer/src/authority/presets.ts (`stepFirstperson`,
// `firstpersonWorld`), which the authority server runs, so the reconciler's prediction matches the
// server by construction.
//
// Determinism rules, as GenexPresets.h keeps them: double arithmetic in the order §17.7 writes it,
// std::sqrt (correctly rounded) and nothing beyond + − × ÷, a float32 rounding (static_cast<float>)
// exactly where §17.7 rounds, and no floating-point contraction (GENEX_FP_STRICT_BEGIN/END around the
// whole of GenexFirstperson.cpp; never -ffast-math). Held bit for bit to
// packages/netcode-bench/conformance/authority/presets/firstperson.json by genex_presets_check
// (sdks/unreal/core/tools/presets_check.cpp, which also steps every case and a set of random large
// worlds with and without the broadphase and compares them bit for bit) and by the
// Genex.Multiplayer.Firstperson automation test under UBT's flags.
//
// Axes: the preset's x/y are the ground plane and +z is up, in the game's own units (§17.7's
// defaults are Source units, about an inch). Unreal is z-up too: a game maps Genex (x, y, z) to UE
// (X, Y, Z) times its units-per-metre scale (UGenexAuthoritySubsystem does this for its views).
//
// Allocation: building a world allocates (its tables and broadphase tree). A step never allocates once
// the calling thread has stepped a world at least that large (a per-thread candidate buffer grows to
// the largest world's solid count, once).
#pragma once

#include "GenexCore/GenexConfig.h"

#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace genex {

class Json;
struct Input;
struct PosedWorld;

/** `firstperson` parameters (§17.7's table, in its order). The real-valued ones are used as float32,
 *  the integer ones (the button masks, `substeps`, `world`) exactly. */
struct FirstpersonParams {
  /** Run speed, units/s, before the body's `cap`. */
  double maxSpeed = 250.0;
  /** Speed multiplier while walk is held. */
  double walkSpeed = 0.52;
  /** Speed multiplier while ducking (wins over walk). */
  double crouchSpeed = 0.34;
  double accelerate = 5.5;
  double airAccelerate = 12.0;
  /** Air wish speed is clamped to this before the projection (what makes air-strafing work). */
  double airMaxWishSpeed = 30.0;
  double friction = 5.2;
  /** Below this speed friction acts as if at this speed. */
  double stopSpeed = 80.0;
  /** Units/s² along −z. */
  double gravity = 800.0;
  /** The `vz` a jump sets. */
  double jumpImpulse = 301.993;
  /** Each velocity axis is clamped to ±this. */
  double maxVelocity = 3500.0;
  /** Half the side of the hull's square footprint. */
  double radius = 16.0;
  double standHeight = 72.0;
  double crouchHeight = 54.0;
  /** Seconds to duck fully, and to stand back up. */
  double duckTime = 0.4;
  /** 1: a duck can deepen in the air, lifting the feet (a crouch-jump). 0: only on the ground. */
  double airDuck = 1.0;
  /** Highest ledge walked up without a jump. */
  double stepHeight = 18.0;
  /** Least z of a ramp top's unit normal that can be stood on. */
  double standable = 0.7;
  /** How far below the feet ground is found. */
  double groundTrace = 2.5;
  /** How far above the feet ground is found (a hull sunk that far is lifted out). */
  double groundSnap = 1.0;
  /** Clearance kept from a surface (Source's DIST_EPSILON). */
  double skin = 0.03;
  /** Largest |pitch|, radians: float32(89°). */
  double pitchLimit = 1.5533430576324463;
  /** Button masks: any shared bit counts as held; 0 disables. Integers in [0, 2^24). */
  double jumpBit = 1.0;
  double duckBit = 2.0;
  double walkBit = 4.0;
  /** Sub-steps per step, an integer in [1, 8]. */
  double substeps = 2.0;
  /** 1: a jump works at `cap` 0. 0: a press at `cap` 0 is no jump (a freeze time, a kickoff's hold). */
  double capZeroJump = 1.0;
  /** Button mask of a run the room owns: while not 0 and not held, speed is jogSpeed. 0: every move runs. */
  double runBit = 0.0;
  /** Speed multiplier without runBit (duck and walk win). */
  double jogSpeed = 1.0;
  /** The collision world's hash (FirstpersonWorld::Hash), written by the sandbox: an exact u32. */
  double world = 2615243109.0;
};

/** The body a `firstperson` step reads (`cap` too, which it never writes) and writes. A NaN field
 *  reads as missing (0, or 1 for `cap`), as an absent key does in the TypeScript reference. */
struct FirstpersonBody {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
  double vx = 0.0;
  double vy = 0.0;
  double vz = 0.0;
  /** Aim, radians: stored only. */
  double yaw = 0.0;
  double pitch = 0.0;
  /** 0 standing, 1 fully ducked. */
  double duck = 0.0;
  /** Movement bits (firstperson_state): 1 onGround, 2 ducking, 4 jumpHeld. */
  double mstate = 0.0;
  /** Speed multiplier the room module writes (a weapon's or a wound's), [0, 4]. */
  double cap = 1.0;
};

namespace firstperson_state {
inline constexpr std::uint32_t kOnGround = 1;
inline constexpr std::uint32_t kDucking = 2;
inline constexpr std::uint32_t kJumpHeld = 4;
}  // namespace firstperson_state

namespace firstperson_detail {
struct Hull;
}

/**
 * A validated, immutable collision world (§17.7 *World*, the same for `firstperson` and `vehicle`): boxes `[minX, minY, minZ, maxX, maxY, maxZ]`,
 * then ramps `[minX, minY, minZ, maxX, maxY, maxZ, axis, lo, hi]`, every value a float32 (−0 read as
 * 0), with its 32-bit FNV-1a hash (what the room's `params.world` must equal) and, unless built
 * without, a broadphase: a packed bounding-volume tree over the solids' boxes in x, y and z that only
 * filters (the step visits its candidates in ascending solid index, and every result is bit-identical
 * to visiting every solid). Shared by pointer; never mutated after it is built.
 */
class GENEX_CORE_API FirstpersonWorld {
 public:
  using Box = std::array<double, 6>;
  using Ramp = std::array<double, 9>;

  static constexpr int kMaxBoxes = 32768;
  static constexpr int kMaxRamps = 4096;
  /** The empty world's hash: two zero counts. */
  static constexpr std::uint32_t kEmptyHash = 2615243109u;

  /** The empty world (a body in it falls until z reaches −1e9). */
  static std::shared_ptr<const FirstpersonWorld> Empty();

  /** Validates a world as a room module exports it, `{ boxes?: [[6 numbers]…], ramps?: [[9 numbers]…] }`
   *  (other keys ignored; nullptr = absent = the empty world). Refused (nullptr, and `error` says
   *  which value: "boxes[3][1] is not a float32", …) unless it has at most 32768 boxes and 4096 ramps,
   *  each exactly six or nine finite float32 values of magnitude at most 1e9, min < max on every axis,
   *  and each ramp axis 0 or 1, minZ ≤ lo, minZ ≤ hi and maxZ = max(lo, hi). */
  static std::shared_ptr<const FirstpersonWorld> FromJson(const Json* spec, std::string* error = nullptr,
                                                          bool broadphase = true);
  /** FromJson over JSON text. */
  static std::shared_ptr<const FirstpersonWorld> FromJsonText(std::string_view text, std::string* error = nullptr,
                                                              bool broadphase = true);
  /** The same rules over plain arrays (a ramp's axis as 0.0 or 1.0). */
  static std::shared_ptr<const FirstpersonWorld> FromSolids(const std::vector<Box>& boxes,
                                                            const std::vector<Ramp>& ramps,
                                                            std::string* error = nullptr, bool broadphase = true);

  /** §17.7's hash: FNV-1a over the counts (LE u32) and every value (LE binary32). */
  std::uint32_t Hash() const { return hash_; }
  const std::vector<Box>& Boxes() const { return boxes_; }
  const std::vector<Ramp>& Ramps() const { return ramps_; }
  int SolidCount() const { return count_; }
  bool Broadphase() const { return !treeRef_.empty(); }
  /** The order a broadphase's tree keeps `bounds` in, leaves first (each a box, or a ramp's box): what every
   *  port's tree is held to, at any size (firstperson-large.json). */
  static std::vector<int> TreeOrder(const std::vector<Box>& bounds);
  /** The same solids, with or without the broadphase (the brute-force reference for a differential test). */
  std::shared_ptr<const FirstpersonWorld> WithBroadphase(bool broadphase) const;

  FirstpersonWorld(const FirstpersonWorld&) = delete;
  FirstpersonWorld& operator=(const FirstpersonWorld&) = delete;
  ~FirstpersonWorld();

 private:
  FirstpersonWorld() = default;
  void Compile(bool broadphase);
  void BuildTree();
  friend struct firstperson_detail::Hull;

  std::vector<Box> boxes_;
  std::vector<Ramp> ramps_;
  std::uint32_t hash_ = kEmptyHash;
  int boxCount_ = 0;
  int count_ = 0;
  // The step's flat tables, indexed by solid (boxes first); the ramp ones are 0 for a box.
  std::vector<double> minX_, minY_, minZ_, maxX_, maxY_, maxZ_;
  std::vector<std::uint8_t> axis_;
  std::vector<double> lo_, hi_, m0_, span_, slope_, topZ_;
  // The tree (presets.ts Tree): six bounds per entry, solids first in tree order, then each level's
  // nodes to the root (last); ref = a solid's index, or a node's first child; levelEnd per level.
  std::vector<double> treeBoxes_;
  std::vector<std::int32_t> treeRef_;
  std::vector<std::int32_t> treeLevelEnd_;
  std::int32_t treeRoot_ = -1;
};

using FirstpersonWorldPtr = std::shared_ptr<const FirstpersonWorld>;

namespace presets {

/** The `firstperson` preset's name. Preset names are append-only. */
inline constexpr char kFirstperson[] = "firstperson";
/** FIRSTPERSON_DEFAULTS. */
inline constexpr FirstpersonParams kFirstpersonDefaults{};

/** Whether `params` is acceptable for firstperson (presets.ts presetParamsValid): absent (nullptr), or a
 *  JSON object whose every key is a firstperson parameter with a number in its range (an integer one
 *  an integer). */
GENEX_CORE_API bool FirstpersonParamsValid(const Json* params);
/** firstperson parameters from a room's `preset.params` (nullptr: absent): defaults for anything unset
 *  or invalid, key by key. */
GENEX_CORE_API FirstpersonParams ResolveFirstpersonParams(const Json* params);

/**
 * One fixed `firstperson` step (§17.7) through `world`. Pure: returns the next x y z vx vy vz yaw pitch
 * duck mstate (and the body's cap, unchanged). The input is applied as handed: moveX/moveY are WORLD
 * axes, a NaN input field is unusable (an axis 0, an angle kept, buttons 0). `world` must be the world
 * whose hash is `params.world` for the result to be the server's; the step does not compare them.
 */
GENEX_CORE_API FirstpersonBody StepFirstperson(const FirstpersonBody& body, double moveX, double moveY, double yaw,
                                               double pitch, double buttons, double dt,
                                               const FirstpersonParams& params, const FirstpersonWorld& world,
                                               const PosedWorld* posed = nullptr);
/** One fixed step under an input (already sanitized as the server sanitizes it, for a prediction). `posed`: the
 *  tick's posed solids (GenexPosed.h; §17.7 *Posed solids*), visited after the static world's. */
GENEX_CORE_API FirstpersonBody StepFirstperson(const FirstpersonBody& body, const Input& input, double dt,
                                               const FirstpersonParams& params, const FirstpersonWorld& world,
                                               const PosedWorld* posed = nullptr);

}  // namespace presets

}  // namespace genex
