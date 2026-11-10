// The level bake's engine-free core: collision primitives in world space in, a §17.7 collision world of
// boxes and ramps and a report out. Plain C++ under core/DESIGN.md's rules, built by CMake too and held to
// conformance/authority/collision-bake.json by genex_collision_bake_check; it lives in the Editor module so
// no shipped build carries it. The Unreal walk that feeds it is GenexCollisionBakeEditor.cpp.
//
// The contract, per primitive and for any input:
//  - The baked solids cover the source: nothing solid in the level is open in the world, so no bake leaks.
//  - No baked point is further than maxErrorCm from the source: a doorway narrows by at most maxErrorCm a
//    side, so a bounding box can never close it. A primitive that cannot meet that inside its budget is
//    skipped and named, never fattened.
//  - An axis-aligned box stays exact, a slope along x or y is a ramp, a slope on neither axis is strips of
//    ramps, and everything else is a stair of boxes. A stair's rise is at most about twice maxErrorCm, so
//    keep maxErrorCm at or under half the preset's step height and a player walks it.
//  - Touching and contained solids merge exactly, then the world is sorted, so the hash does not depend on
//    actor order. Over §17.7's caps is BakeStatus::OverCaps with the counts and no world, never a truncation.
//  - The one way past maxErrorCm is asking for it by name: an actor in BakeOptions::boundsActors becomes boxes around
//    each of its elements. They still cover the source, a doorway inside one element closes, and the report says
//    how far their corners reach (boundsWorstCm), apart from worstErrorCm, which stays the contract's number.
#pragma once

#include "GenexCore/GenexFirstperson.h"

#include <cstdint>
#include <string>
#include <vector>

namespace genex::collision_bake {

struct Vec3 {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

/** A box turned any way: `center` ± `half` along its three axes (unit, as an engine's rotation gives them). */
struct OrientedBox {
  Vec3 center;
  Vec3 axisX{1.0, 0.0, 0.0};
  Vec3 axisY{0.0, 1.0, 0.0};
  Vec3 axisZ{0.0, 0.0, 1.0};
  Vec3 half;
};

/** The convex hull of `points` (at most 512 after welding). */
struct ConvexHull {
  std::vector<Vec3> points;
};

/** Triangles, three `indices` each. Connected parts are judged alone: a closed part wound outward is solid,
 *  anything else (open, or wound inward: a room) is a surface, baked as plates behind its faces. */
struct TriangleMesh {
  std::vector<Vec3> vertices;
  std::vector<std::int32_t> indices;
};

/** One actor's collision in world space, engine units. Reports name it by `name`. */
struct ActorGeometry {
  std::string name;
  std::vector<OrientedBox> boxes;
  std::vector<ConvexHull> hulls;
  std::vector<TriangleMesh> meshes;
};

/** Actors whose names start with `prefix` ("*" is every actor) become at most `shapes` boxes per element: the
 *  game's choice for a prop whose shape no one feels, when its exact stair costs too many of the world's solids. */
struct BoundsRule {
  std::string prefix;
  int shapes = 1;
};

/** The most boxes one element may ask for: past this, give the prop simple collision instead. */
constexpr int kMaxBoundsShapes = 8;

struct BakeOptions {
  /** How far a baked point may be from the source, in engine units (Unreal: centimetres). */
  double maxErrorCm = 5.0;
  /** Engine units per Genex unit: UGenexSettings::UnitsPerMeter. */
  double unitsPerGenex = 100.0;
  /** One actor's stair past this many boxes or ramps is skipped as OverBudget. */
  int maxBoxesPerActor = 1024;
  int maxRampsPerActor = 128;
  /** The actors that may leave maxErrorCm, by name; the longest prefix an actor meets is its rule. */
  std::vector<BoundsRule> boundsActors;
};

enum class BakeStatus {
  /** Every actor is in the world and the caps hold. */
  Ok,
  /** There is a world and the caps hold, but an actor was skipped: the world is not the level, and capsHold says nothing
   *  about the level. `skipped` names them and `missingShare` says how much. */
  Incomplete,
  /** maxErrorCm or unitsPerGenex is not a positive finite number, or a budget is not positive. */
  BadOptions,
  /** More boxes or ramps than §17.7 allows: `boxes` and `ramps` say how many; there is no world. */
  OverCaps,
  /** §17.7 refused the result: `detail` says why. A bug in the bake, never an input's fault. */
  WorldRefused,
};

enum class SkipReason {
  NonFinite,
  /** Past §17.7's 1e9 Genex units. */
  OutOfRange,
  /** A triangle index outside its vertices. */
  BadIndex,
  /** A hull of more than 512 points. */
  HullTooLarge,
  /** Nothing with area: a point, a line, all zero-area triangles. */
  Degenerate,
  /** More solids than its budget at this maxErrorCm: raise one or the other, or give it simpler collision. */
  OverBudget,
  /** A solid too thin to survive float32 at its coordinates. */
  Collapsed,
};

/** An actor's share of the bake, before solids merge across actors. */
struct ActorReport {
  std::string name;
  int boxes = 0;
  int ramps = 0;
  double worstErrorCm = 0.0;
  /** How far this actor's boxes reach from its source, at their corners, when a BoundsRule met it. */
  bool bounds = false;
  double boundsErrorCm = 0.0;
};

struct SkippedActor {
  std::string name;
  SkipReason reason = SkipReason::Degenerate;
};

struct BakeReport {
  BakeStatus status = BakeStatus::Ok;
  /** The world's counts after merging, whether or not they fit. */
  int boxes = 0;
  int ramps = 0;
  bool capsHold = true;
  double maxErrorCm = 0.0;
  double worstErrorCm = 0.0;
  std::string worstActor;
  int droppedTriangles = 0;
  /** Solids removed by merging. */
  int merged = 0;
  /** By name, so a report reads the same for any actor order. */
  std::vector<ActorReport> actors;
  std::vector<SkippedActor> skipped;
  /** Nothing was skipped: the same fact as status Incomplete. capsHold counts only what was baked. */
  bool complete = true;
  /** The share of the source's points in skipped actors, 0 to 1. */
  double missingShare = 0.0;
  /** Actors baked as bounds, and the furthest any of them reaches from its source. */
  int boundsActors = 0;
  double boundsWorstCm = 0.0;
  std::string boundsWorstActor;
  /** Solids thinner than float32 at their coordinates, grown by one float32 step inside maxErrorCm. */
  int widenedSolids = 0;
  std::string detail;
};

struct BakeResult {
  BakeReport report;
  /** Null unless report.status is Ok. */
  FirstpersonWorldPtr world;
};

/** Bakes `actors` into a §17.7 world in Genex units: each value is engine units over unitsPerGenex rounded to
 *  float32, UGenexAuthoritySubsystem::FromUnrealSolids's conversion, so an asset filled with
 *  ToUnrealSolids hashes to world->Hash(). */
BakeResult Bake(const std::vector<ActorGeometry>& actors, const BakeOptions& options);

/** The world as a room module's `world` export, `{"boxes":[…],"ramps":[…]}`: every number the exact float32
 *  value, so FirstpersonWorld::FromJsonText and the server's firstpersonWorld hash it the same. */
std::string WorldJson(const FirstpersonWorld& world);

/** `text` as bound rules, "*+Exp_Wrecks:3+Props_Desk:2": one prefix per rule, an optional `:shapes`. False, with
 *  `error`, for an empty prefix or a count outside 1 to kMaxBoundsShapes. */
bool ParseBoundsRules(const std::string& text, std::vector<BoundsRule>& rules, std::string& error);

/** snake_case names for a skip and a status, as collision-bake.json spells them. */
const char* SkipReasonName(SkipReason reason);
const char* BakeStatusName(BakeStatus status);

/** The report for a log: a summary line, the ten worst actors, every skipped actor. */
std::vector<std::string> ReportLines(const BakeReport& report);

}  // namespace genex::collision_bake
