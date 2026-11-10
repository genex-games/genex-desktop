// `config.lifts` (PROTOCOL.md §17.11 *Lifts*): the platforms a room module declares as data (moving platforms,
// elevators, spinners, sweepers, conveyors), each posed by an exact function of the tick (GenexLifts.h), and the
// resolved policy every SDK runs. A port of packages/multiplayer/src/authority/lifts-config.ts, held to the
// `config` rows of packages/netcode-bench/conformance/authority/lifts.json by core/tools/lifts_check.cpp: every
// resolved field, and a refusal by the path of its first bad value (with the same message).
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexContactConfig.h"
#include "GenexCore/GenexJson.h"

#include <array>
#include <optional>
#include <string>
#include <vector>

namespace genex::lifts {

/** Platforms a module may declare at most, points a path may hold, and a lift id's length. */
constexpr std::size_t kLiftsMax = 32;
constexpr std::size_t kLiftPointsMax = 16;
constexpr std::size_t kLiftIdMax = 32;
/** Every position, size and speed's magnitude at most (units, units/s). */
constexpr double kLiftValueMax = 1e6;
/** Every tick count (a leg, a wait, a phase, a spin's period) at most: about 4.6 days at 120 Hz. */
constexpr double kLiftTicksMax = 16777216.0;
/** A spin's fewest ticks a turn. */
constexpr double kLiftSpinMinPeriod = 8;

/** A point or size in room units. */
using Vec3 = std::array<double, 3>;

/** A lift's shape: a box (`half` x, y, z: axis-aligned, or turned about z when it spins) or an upright disc of
 *  `radius` and half height `discHalf`. */
enum class ShapeKind { Box, Disc };
/** How a path runs its points: out along the legs and back, or round them. */
enum class PathMode { PingPong, Loop };
/** How a leg moves between its points: at a steady speed, or starting and stopping at rest. */
enum class Ease { Linear, Smooth };
/** What a rider keeps of its lift's motion when it leaves it. */
enum class Impart { All, None };

struct Shape {
  ShapeKind kind = ShapeKind::Box;
  Vec3 half{};
  double radius = 0;
  double discHalf = 0;
};

/** A resolved path: `points` (float32), a leg's ticks and a wait's ticks per point. */
struct Path {
  std::vector<Vec3> points;
  std::vector<double> legs;
  std::vector<double> waits;
  PathMode mode = PathMode::PingPong;
  Ease ease = Ease::Linear;
  double phase = 0;
  /** The ticks of one whole cycle. */
  double period = 0;
};

/** A resolved spin: a turn every `period` ticks, `dir` 1 (counter-clockwise from above) or -1. */
struct Spin {
  double period = 0;
  int dir = 1;
  double phase = 0;
};

/** One resolved platform. */
struct Lift {
  std::string id;
  Shape shape;
  /** The centre when it has no path (else the path's first point). */
  Vec3 at{};
  std::optional<Path> path;
  std::optional<Spin> spin;
  /** A conveyor's surface velocity in its own frame (u/s). */
  std::optional<std::array<double, 2>> surface;
  Impart impart = Impart::All;
  /** Still until the module calls it; a call runs one cycle of its path. */
  bool called = false;
};

/** The resolved `config.lifts`. */
struct LiftsPolicy {
  std::vector<Lift> platforms;
  /** Whether seats ride level dynamic module bodies too. */
  bool bodies = true;
};

/** A platform refused for moving too fast: its id, its fastest point's move a tick, the most allowed (the hull
 *  radius) and the tick rate, all units a tick. */
struct LiftTooFast {
  std::string platform;
  double move = 0;
  double allowed = 0;
  double tickHz = 0;
};

/** A refused `config.lifts`: the path of the first bad value, why, and (a platform too fast) its numbers. The
 *  message is `path: why`, as lifts-config.ts's LiftsConfigError. */
struct LiftsRefusal {
  std::string path;
  std::string why;
  std::optional<LiftTooFast> fast;
  std::string Message() const { return path + ": " + why; }
};

/** The wire spelling of a mode, an ease and an impart. */
GENEX_CORE_API const char* PathModeName(PathMode m);
GENEX_CORE_API const char* EaseName(Ease e);
GENEX_CORE_API const char* ImpartName(Impart i);

/**
 * `config.lifts` resolved against the room's movement preset and tick rate (§17.11 *Lifts*). Returns the policy, or
 * nullopt with `refusal` set (the path from `path`, default `$.config.lifts`) for a value that is not an object, an
 * unknown key, an empty list or more than kLiftsMax platforms, an id that is not 1-32 of `[a-z0-9-]` or repeats, a
 * shape without its sizes, a path whose points, legs and waits do not match, a tick count that is not a whole
 * number, a phase on a called lift, a value out of range, a platform any point of which moves more than the hull
 * radius a tick (named, with its speed and the most allowed), or a room whose movement preset steps through no world.
 */
GENEX_CORE_API std::optional<LiftsPolicy> ResolveLifts(const Json& given, const contact::ContactPresetParams* preset, double tickHz,
                                                       LiftsRefusal* refusal, const std::string& path = "$.config.lifts");

}  // namespace genex::lifts
