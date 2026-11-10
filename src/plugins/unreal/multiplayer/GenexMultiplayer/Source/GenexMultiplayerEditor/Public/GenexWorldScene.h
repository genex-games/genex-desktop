// A level as the engine-neutral world scene (packages/multiplayer/WORLD-SCENE.md) that `genex world fit` reads: the
// writer's engine-free core, plain C++ under core/DESIGN.md's rules, built by CMake too and held by
// genex_world_scene_check. It lives in the Editor module so no shipped build carries it. The Unreal walk that feeds it
// is GenexWorldSceneEditor.cpp.
//
// The contract:
//  - Everything that collides goes in, with the channels it answers: `move` stops a hull, `shot` stops a bullet. The fit
//    decides what a hull can reach, so nothing is pruned here.
//  - An actor the format cannot hold (a value that is not finite, past the format's range, a bad index, too many hull
//    points) is refused by name with its reason, never written and never bent. A scene with a refused actor is not ok
//    unless the caller asks for it, so a file that exists is a file the reader takes.
//  - A box turned onto the world's axes in any way is written with no `axes`, so the fit keeps it exact. A sheared box is
//    a hull.
//  - Actors are sorted by name and values are the room's units, so one level writes one file on any walk order.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace genex::world_scene {

struct Point {
  double x = 0.0;
  double y = 0.0;
  double z = 0.0;
};

/** Which traces a surface answers. Neither means it is not written. */
struct Channels {
  bool move = true;
  bool shot = true;
};

enum class SurfaceKind { Box, Hull, Sphere, Capsule, Mesh, Heightfield };

/** One surface in world space, engine units. Only the fields of its `kind` are read. */
struct Surface {
  SurfaceKind kind = SurfaceKind::Box;
  Channels channels;
  std::vector<std::string> tags;
  /** Box: center and half along `axes`, three orthonormal rows. Sphere: center. */
  Point center;
  std::array<Point, 3> axes{Point{1.0, 0.0, 0.0}, Point{0.0, 1.0, 0.0}, Point{0.0, 0.0, 1.0}};
  bool hasAxes = false;
  Point half;
  /** Hull: its points. Mesh: its vertices. */
  std::vector<Point> points;
  /** Sphere and capsule. */
  double radius = 0.0;
  /** Capsule: the ends of its segment. */
  Point a;
  Point b;
  /** Mesh: three per triangle. */
  std::vector<std::uint32_t> indices;
  /** Heightfield: `heights[row * cols + col]` at `originX + col * cellX`, `originY + row * cellY`; NaN is a hole. */
  double originX = 0.0;
  double originY = 0.0;
  double cellX = 0.0;
  double cellY = 0.0;
  int cols = 0;
  int rows = 0;
  std::vector<double> heights;
};

struct SceneActor {
  std::string name;
  std::vector<std::string> tags;
  std::vector<Surface> surfaces;
};

struct SceneSpawn {
  Point at;
  std::string name;
  std::vector<std::string> tags;
};

/** The room's hull, engine units. WORLD-SCENE.md `hull`. */
struct HullSize {
  double radius = 0.0;
  double height = 0.0;
  double crouchHeight = 0.0;
  double step = 0.0;
  double jump = 0.0;
  double leap = 0.0;
};

struct SceneInput {
  /** Engine units per room unit: UGenexSettings::UnitsPerMeter. */
  double unitsPerGenex = 100.0;
  /** Engine units in a metre (Unreal: 100). The scene's `unitsPerMeter` is this over unitsPerGenex. */
  double engineUnitsPerMeter = 100.0;
  std::map<std::string, std::string> source;
  /** Left out when `hasHull` is false: the fit then scales the Source defaults. */
  bool hasHull = false;
  HullSize hull;
  std::vector<SceneActor> actors;
  std::vector<SceneSpawn> spawns;
};

/** The largest scene the JSON reader can hold in one string (a JavaScript string stops near 512 MiB). */
constexpr std::size_t kDefaultMaxSceneBytes = 480u * 1024u * 1024u;
/** The format's limits, from WORLD-SCENE.md's reader (scene.ts). */
constexpr double kMaxCoordinate = 1e9;
constexpr std::size_t kMaxNameChars = 256;
constexpr std::size_t kMaxTags = 64;
constexpr std::size_t kMaxHullPoints = 4096;
constexpr int kMaxHeightfieldSide = 16384;

struct ExportOptions {
  /** Write the scene without the actors it refused. */
  bool allowRefused = false;
  /** Past this, `shot`-only triangles go first, largest actor first; then the scene is refused. */
  std::size_t maxBytes = kDefaultMaxSceneBytes;
};

enum class ExportStatus {
  Ok,
  /** A value in the input itself is unusable: unitsPerGenex is not a positive finite number, say. */
  BadInput,
  /** Nothing that stops a hull and stays put: an empty level, a level of movable actors. */
  NoSurfaces,
  /** Spawns are where the fit's reach starts, so a level with none cannot be fitted. */
  NoSpawns,
  /** Actors were refused and the caller did not allow it: `refused` names them. */
  Refused,
  /** Over `maxBytes` with every `shot`-only triangle gone: `largest` names the biggest actors. */
  TooLarge,
};

enum class RefuseReason {
  NonFinite,
  /** Past the format's ±1e9 room units: a huge scale. */
  OutOfRange,
  BadIndex,
  /** A hull of more than kMaxHullPoints. */
  HullTooLarge,
  /** A heightfield not 2 to kMaxHeightfieldSide on a side, whose heights do not fill it, or whose cell is not above zero. */
  BadHeightfield,
};

struct RefusedActor {
  std::string name;
  RefuseReason reason = RefuseReason::NonFinite;
};

struct ActorBytes {
  std::string name;
  std::size_t bytes = 0;
};

struct ExportReport {
  ExportStatus status = ExportStatus::Ok;
  int actors = 0;
  int boxes = 0;
  int hulls = 0;
  int spheres = 0;
  int capsules = 0;
  int meshes = 0;
  int heightfields = 0;
  std::size_t triangles = 0;
  std::size_t heightSamples = 0;
  /** Surfaces that answer `move` and are not tagged movable: what the static world can be made of. */
  int moveSurfaces = 0;
  int shotSurfaces = 0;
  int spawns = 0;
  /** Named `movable`: written with the tag, never part of a static world. */
  std::vector<std::string> movable;
  /** By name, so a report reads the same for any walk order. */
  std::vector<RefusedActor> refused;
  /** Actors whose `shot`-only triangles went to stay under maxBytes: their shot world falls back to simple collision. */
  std::vector<std::string> shotDropped;
  /** The ten largest actors, largest first. */
  std::vector<ActorBytes> largest;
  std::size_t bytes = 0;
  std::string detail;
};

struct ExportResult {
  ExportReport report;
  /** The scene as JSON. Empty unless report.status is Ok. */
  std::string text;
};

/** A box given by its eight corners (corner i has +x half when i & 1, +y when i & 2, +z when i & 4). On the world's axes
 *  in any turn or mirror it has no axes; turned, it has them; sheared (a turned element under a non-uniform scale), it is
 *  a hull of the corners. Flat in one axis stays a box; a line or a point returns false: there is nothing to collide with. */
bool SurfaceFromBoxCorners(const std::array<Point, 8>& corners, Surface& out);

/** A hull whose points are just the corners of their bounding box is that box, so the fit keeps it exact. */
void SimplifyHull(Surface& surface);

/** A grid of `cols` by `rows` points (row by row) as triangles, without the quads `holes` marks ((cols - 1) * (rows - 1)
 *  bytes, or empty for none): a heightfield that is turned or has real holes. False, with `out` untouched, on a bad size. */
bool MeshFromGrid(const std::vector<Point>& grid, int cols, int rows, const std::vector<std::uint8_t>& holes, Surface& out);

/** Reads the actors, refuses what the format cannot hold, sorts and writes. Never throws for any input. */
ExportResult Export(const SceneInput& input, const ExportOptions& options);

const char* RefuseReasonName(RefuseReason reason);
const char* ExportStatusName(ExportStatus status);

/** The report for a log: a summary line, then every refused actor, movable actor and shot fallback, by name. */
std::vector<std::string> ReportLines(const ExportReport& report);

}  // namespace genex::world_scene
