#include "GenexWorldScene.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <utility>

namespace genex::world_scene_detail {

using world_scene::Channels;
using world_scene::ExportOptions;
using world_scene::ExportReport;
using world_scene::ExportStatus;
using world_scene::Point;
using world_scene::RefuseReason;
using world_scene::RefusedActor;
using world_scene::SceneActor;
using world_scene::SceneInput;
using world_scene::SceneSpawn;
using world_scene::Surface;
using world_scene::SurfaceKind;

/** Within this share of a side, a corner is where a box's corner should be: a rotation's float noise, far under any
 *  distance a player can feel, and far over what a real turn of a real wall comes to. */
constexpr double kOnAxisShare = 1e-6;
/** Below this length (engine units) an edge is no edge. */
constexpr double kNoLength = 1e-9;
constexpr const char* kMovableTag = "movable";
constexpr const char* kUnnamed = "unnamed";
constexpr std::size_t kLargestListed = 10;

Point Minus(const Point& a, const Point& b) { return Point{a.x - b.x, a.y - b.y, a.z - b.z}; }
Point Scaled(const Point& a, double by) { return Point{a.x * by, a.y * by, a.z * by}; }
double Dot(const Point& a, const Point& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
double Length(const Point& a) { return std::sqrt(Dot(a, a)); }
Point Cross(const Point& a, const Point& b) { return Point{a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x}; }

/** Which world axis (0, 1, 2) `unit` lies along, or -1. */
int WorldAxisOf(const Point& unit) {
  const double x = std::fabs(unit.x);
  const double y = std::fabs(unit.y);
  const double z = std::fabs(unit.z);
  if (x >= 1.0 - kOnAxisShare && y <= kOnAxisShare && z <= kOnAxisShare) return 0;
  if (y >= 1.0 - kOnAxisShare && x <= kOnAxisShare && z <= kOnAxisShare) return 1;
  if (z >= 1.0 - kOnAxisShare && x <= kOnAxisShare && y <= kOnAxisShare) return 2;
  return -1;
}

double& Component(Point& p, int axis) { return axis == 0 ? p.x : axis == 1 ? p.y : p.z; }

/** Fills `surface` as the box of unit `axes` and half lengths `halves`, with no axes when they are the world's. */
void SetBox(Surface& surface, const Point& center, const std::array<Point, 3>& axes, const std::array<double, 3>& halves) {
  surface.kind = SurfaceKind::Box;
  surface.center = center;
  surface.points.clear();
  const std::array<int, 3> on{WorldAxisOf(axes[0]), WorldAxisOf(axes[1]), WorldAxisOf(axes[2])};
  const bool onWorld = on[0] >= 0 && on[1] >= 0 && on[2] >= 0 && on[0] != on[1] && on[1] != on[2] && on[0] != on[2];
  if (onWorld) {
    surface.hasAxes = false;
    for (std::size_t i = 0; i < 3; ++i) Component(surface.half, on[i]) = halves[i];
    return;
  }
  surface.hasAxes = true;
  surface.axes = axes;
  surface.half = Point{halves[0], halves[1], halves[2]};
}

/** A JSON string. Control characters as \u00XX; everything else (UTF-8 included) as it is. */
void AppendString(std::string& out, const std::string& text) {
  out += '"';
  for (const char c : text) {
    const unsigned char byte = static_cast<unsigned char>(c);
    if (c == '"' || c == '\\') {
      out += '\\';
      out += c;
    } else if (byte < 0x20) {
      char escaped[8];
      std::snprintf(escaped, sizeof escaped, "\\u%04x", static_cast<unsigned>(byte));
      out += escaped;
    } else {
      out += c;
    }
  }
  out += '"';
}

/** The shortest text that reads back as exactly `value`: a float32 of it rounds the same as the direct bake's. */
void AppendNumber(std::string& out, double value) {
  if (value == 0.0) {
    out += '0';
    return;
  }
  char text[40];
  std::snprintf(text, sizeof text, "%.15g", value);
  if (std::strtod(text, nullptr) != value) std::snprintf(text, sizeof text, "%.17g", value);
  out += text;
}

void AppendPoint(std::string& out, const Point& p, double perUnit) {
  out += '[';
  AppendNumber(out, p.x / perUnit);
  out += ',';
  AppendNumber(out, p.y / perUnit);
  out += ',';
  AppendNumber(out, p.z / perUnit);
  out += ']';
}

constexpr char kBase64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

void AppendBase64(std::string& out, const unsigned char* bytes, std::size_t count) {
  out.reserve(out.size() + (count + 2) / 3 * 4);
  std::size_t i = 0;
  for (; i + 2 < count; i += 3) {
    const unsigned word = (static_cast<unsigned>(bytes[i]) << 16) | (static_cast<unsigned>(bytes[i + 1]) << 8) | bytes[i + 2];
    out += kBase64[(word >> 18) & 63];
    out += kBase64[(word >> 12) & 63];
    out += kBase64[(word >> 6) & 63];
    out += kBase64[word & 63];
  }
  if (count - i == 2) {
    const unsigned word = (static_cast<unsigned>(bytes[i]) << 16) | (static_cast<unsigned>(bytes[i + 1]) << 8);
    out += kBase64[(word >> 18) & 63];
    out += kBase64[(word >> 12) & 63];
    out += kBase64[(word >> 6) & 63];
    out += '=';
  } else if (count - i == 1) {
    const unsigned word = static_cast<unsigned>(bytes[i]) << 16;
    out += kBase64[(word >> 18) & 63];
    out += kBase64[(word >> 12) & 63];
    out += "==";
  }
}

/** Little-endian, whatever the host: the four bytes of a float32 or a u32. */
void PutWord(unsigned char* to, std::uint32_t word) {
  to[0] = static_cast<unsigned char>(word & 0xff);
  to[1] = static_cast<unsigned char>((word >> 8) & 0xff);
  to[2] = static_cast<unsigned char>((word >> 16) & 0xff);
  to[3] = static_cast<unsigned char>((word >> 24) & 0xff);
}

std::uint32_t FloatBits(float value) {
  std::uint32_t bits = 0;
  std::memcpy(&bits, &value, sizeof bits);
  return bits;
}

void AppendFloats(std::string& out, const std::vector<float>& values) {
  std::vector<unsigned char> bytes(values.size() * 4);
  for (std::size_t i = 0; i < values.size(); ++i) PutWord(bytes.data() + i * 4, FloatBits(values[i]));
  out += "{\"f32le\":\"";
  AppendBase64(out, bytes.data(), bytes.size());
  out += "\"}";
}

void AppendIndices(std::string& out, const std::vector<std::uint32_t>& values) {
  std::vector<unsigned char> bytes(values.size() * 4);
  for (std::size_t i = 0; i < values.size(); ++i) PutWord(bytes.data() + i * 4, values[i]);
  out += "{\"u32le\":\"";
  AppendBase64(out, bytes.data(), bytes.size());
  out += "\"}";
}

/** What a reader takes as a name: not empty, at most the limit, the end kept (a path's end tells instances apart), and
 *  the cut on a UTF-8 character's first byte. */
std::string ReaderName(const std::string& name) {
  if (name.empty()) return kUnnamed;
  if (name.size() <= world_scene::kMaxNameChars) return name;
  std::size_t from = name.size() - world_scene::kMaxNameChars;
  while (from < name.size() && (static_cast<unsigned char>(name[from]) & 0xC0) == 0x80) ++from;
  return name.substr(from);
}

void AppendTags(std::string& out, const std::vector<std::string>& tags) {
  std::vector<std::string> kept;
  for (const std::string& tag : tags) {
    if (kept.size() == world_scene::kMaxTags) break;
    if (!tag.empty()) kept.push_back(ReaderName(tag));
  }
  if (kept.empty()) return;
  out += ",\"tags\":[";
  for (std::size_t i = 0; i < kept.size(); ++i) {
    if (i != 0) out += ',';
    AppendString(out, kept[i]);
  }
  out += ']';
}

/** Why a value cannot go in the format, in room units: none, not finite, or past its range. */
bool CheckValue(double value, double perUnit, bool& nonFinite, bool& outOfRange) {
  if (!std::isfinite(value)) {
    nonFinite = true;
    return false;
  }
  if (std::fabs(value / perUnit) > world_scene::kMaxCoordinate) {
    outOfRange = true;
    return false;
  }
  return true;
}

struct ValueCheck {
  double perUnit = 1.0;
  bool nonFinite = false;
  bool outOfRange = false;
  void Value(double value) { CheckValue(value, perUnit, nonFinite, outOfRange); }
  void Vec(const Point& p) {
    Value(p.x);
    Value(p.y);
    Value(p.z);
  }
};

/** Why this surface cannot go in the format, or false. */
bool SurfaceRefused(const Surface& s, double perUnit, RefuseReason& reason) {
  ValueCheck check;
  check.perUnit = perUnit;
  switch (s.kind) {
    case SurfaceKind::Box:
      check.Vec(s.center);
      check.Vec(s.half);
      if (s.hasAxes) {
        for (const Point& axis : s.axes) {
          ValueCheck unit;
          unit.Vec(axis);
          check.nonFinite = check.nonFinite || unit.nonFinite;
        }
      }
      break;
    case SurfaceKind::Hull:
      if (s.points.size() > world_scene::kMaxHullPoints) {
        reason = RefuseReason::HullTooLarge;
        return true;
      }
      for (const Point& p : s.points) check.Vec(p);
      break;
    case SurfaceKind::Sphere:
      check.Vec(s.center);
      check.Value(s.radius);
      break;
    case SurfaceKind::Capsule:
      check.Vec(s.a);
      check.Vec(s.b);
      check.Value(s.radius);
      break;
    case SurfaceKind::Mesh:
      if (s.indices.size() % 3 != 0 || std::any_of(s.indices.begin(), s.indices.end(), [&s](std::uint32_t i) { return i >= s.points.size(); })) {
        reason = RefuseReason::BadIndex;
        return true;
      }
      for (const Point& p : s.points) check.Vec(p);
      break;
    case SurfaceKind::Heightfield: {
      const bool sides = s.cols >= 2 && s.rows >= 2 && s.cols <= world_scene::kMaxHeightfieldSide && s.rows <= world_scene::kMaxHeightfieldSide;
      const bool filled = sides && s.heights.size() == static_cast<std::size_t>(s.cols) * static_cast<std::size_t>(s.rows);
      if (!filled || !std::isfinite(s.cellX) || !std::isfinite(s.cellY) || s.cellX <= 0.0 || s.cellY <= 0.0) {
        reason = RefuseReason::BadHeightfield;
        return true;
      }
      check.Value(s.originX);
      check.Value(s.originY);
      check.Value(s.cellX);
      check.Value(s.cellY);
      // NaN is a hole. Only an infinity is not a height.
      for (const double h : s.heights) {
        if (!std::isnan(h)) check.Value(h);
      }
      break;
    }
  }
  if (check.nonFinite) {
    reason = RefuseReason::NonFinite;
    return true;
  }
  if (check.outOfRange) {
    reason = RefuseReason::OutOfRange;
    return true;
  }
  return false;
}

/** Nothing to collide with: a reader would refuse it, and leaving it out changes nothing. */
bool SurfaceEmpty(const Surface& s) {
  if (!s.channels.move && !s.channels.shot) return true;
  switch (s.kind) {
    case SurfaceKind::Hull:
      return s.points.empty();
    case SurfaceKind::Sphere:
    case SurfaceKind::Capsule:
      return !(s.radius > 0.0) && !std::isnan(s.radius);
    case SurfaceKind::Mesh:
      return s.indices.empty();
    case SurfaceKind::Box:
    case SurfaceKind::Heightfield:
      return false;
  }
  return false;
}

void AppendChannels(std::string& out, const Channels& channels) {
  if (channels.move && channels.shot) return;
  out += channels.move ? ",\"channels\":[\"move\"]" : ",\"channels\":[\"shot\"]";
}

void AppendSurface(std::string& out, const Surface& s, double perUnit) {
  switch (s.kind) {
    case SurfaceKind::Box:
      out += "{\"kind\":\"box\",\"center\":";
      AppendPoint(out, s.center, perUnit);
      if (s.hasAxes) {
        out += ",\"axes\":[";
        AppendPoint(out, s.axes[0], 1.0);
        out += ',';
        AppendPoint(out, s.axes[1], 1.0);
        out += ',';
        AppendPoint(out, s.axes[2], 1.0);
        out += ']';
      }
      out += ",\"half\":";
      AppendPoint(out, s.half, perUnit);
      break;
    case SurfaceKind::Hull:
      out += "{\"kind\":\"hull\",\"points\":[";
      for (std::size_t i = 0; i < s.points.size(); ++i) {
        if (i != 0) out += ',';
        AppendPoint(out, s.points[i], perUnit);
      }
      out += ']';
      break;
    case SurfaceKind::Sphere:
      out += "{\"kind\":\"sphere\",\"center\":";
      AppendPoint(out, s.center, perUnit);
      out += ",\"radius\":";
      AppendNumber(out, s.radius / perUnit);
      break;
    case SurfaceKind::Capsule:
      out += "{\"kind\":\"capsule\",\"a\":";
      AppendPoint(out, s.a, perUnit);
      out += ",\"b\":";
      AppendPoint(out, s.b, perUnit);
      out += ",\"radius\":";
      AppendNumber(out, s.radius / perUnit);
      break;
    case SurfaceKind::Mesh: {
      std::vector<float> vertices;
      vertices.reserve(s.points.size() * 3);
      for (const Point& p : s.points) {
        vertices.push_back(static_cast<float>(p.x / perUnit));
        vertices.push_back(static_cast<float>(p.y / perUnit));
        vertices.push_back(static_cast<float>(p.z / perUnit));
      }
      out += "{\"kind\":\"mesh\",\"vertices\":";
      AppendFloats(out, vertices);
      out += ",\"indices\":";
      AppendIndices(out, s.indices);
      break;
    }
    case SurfaceKind::Heightfield: {
      std::vector<float> heights;
      heights.reserve(s.heights.size());
      for (const double h : s.heights) heights.push_back(static_cast<float>(h / perUnit));
      out += "{\"kind\":\"heightfield\",\"origin\":[";
      AppendNumber(out, s.originX / perUnit);
      out += ',';
      AppendNumber(out, s.originY / perUnit);
      out += "],\"cell\":[";
      AppendNumber(out, s.cellX / perUnit);
      out += ',';
      AppendNumber(out, s.cellY / perUnit);
      out += "],\"cols\":";
      out += std::to_string(s.cols);
      out += ",\"rows\":";
      out += std::to_string(s.rows);
      out += ",\"heights\":";
      AppendFloats(out, heights);
      break;
    }
  }
  AppendChannels(out, s.channels);
  AppendTags(out, s.tags);
  out += '}';
}

bool HasTag(const std::vector<std::string>& tags, const char* tag) {
  return std::find(tags.begin(), tags.end(), tag) != tags.end();
}

/** One actor as the file will hold it, its text kept per surface so the size guard can drop triangles without a rewrite. */
struct WrittenActor {
  std::string name;
  std::vector<std::string> tags;
  std::vector<std::string> surfaces;
  /** Parallel to `surfaces`: only a bullet stops on it and it is triangles. The first thing to go when a scene is too big. */
  std::vector<bool> shotOnlyMesh;
  /** A sort key when names repeat: the text itself, so the walk's order cannot show. */
  std::string text;
  std::size_t Bytes() const { return text.size(); }
};

void Compose(WrittenActor& actor) {
  actor.text = "{\"name\":";
  AppendString(actor.text, actor.name);
  AppendTags(actor.text, actor.tags);
  actor.text += ",\"surfaces\":[";
  for (std::size_t i = 0; i < actor.surfaces.size(); ++i) {
    if (i != 0) actor.text += ',';
    actor.text += actor.surfaces[i];
  }
  actor.text += "]}";
}

void CountSurface(ExportReport& report, const Surface& s) {
  switch (s.kind) {
    case SurfaceKind::Box:
      report.boxes += 1;
      break;
    case SurfaceKind::Hull:
      report.hulls += 1;
      break;
    case SurfaceKind::Sphere:
      report.spheres += 1;
      break;
    case SurfaceKind::Capsule:
      report.capsules += 1;
      break;
    case SurfaceKind::Mesh:
      report.meshes += 1;
      report.triangles += s.indices.size() / 3;
      break;
    case SurfaceKind::Heightfield:
      report.heightfields += 1;
      report.heightSamples += s.heights.size();
      break;
  }
}

/** Writes one actor, or names it refused. False when it holds nothing a reader should see. */
bool WriteActor(const SceneActor& actor, double perUnit, ExportReport& report, WrittenActor& out) {
  const std::string name = ReaderName(actor.name);
  std::vector<const Surface*> kept;
  for (const Surface& surface : actor.surfaces) {
    if (SurfaceEmpty(surface)) continue;
    RefuseReason reason = RefuseReason::NonFinite;
    if (SurfaceRefused(surface, perUnit, reason)) {
      report.refused.push_back(RefusedActor{name, reason});
      return false;
    }
    kept.push_back(&surface);
  }
  if (kept.empty()) return false;

  out.name = name;
  out.tags = actor.tags;
  const bool actorMovable = HasTag(actor.tags, kMovableTag);
  bool anyMovable = actorMovable;
  for (const Surface* surface : kept) {
    std::string text;
    AppendSurface(text, *surface, perUnit);
    out.surfaces.push_back(std::move(text));
    out.shotOnlyMesh.push_back(surface->kind == SurfaceKind::Mesh && !surface->channels.move);
    CountSurface(report, *surface);
    const bool movable = actorMovable || HasTag(surface->tags, kMovableTag);
    anyMovable = anyMovable || movable;
    if (surface->channels.move && !movable) report.moveSurfaces += 1;
    if (surface->channels.shot && !movable) report.shotSurfaces += 1;
  }
  if (anyMovable) report.movable.push_back(name);
  Compose(out);
  return true;
}

/** Drops `shot`-only triangles, the largest actor's first, until the scene fits. */
void DropShotTriangles(std::vector<WrittenActor>& actors, std::size_t& total, std::size_t limit, ExportReport& report) {
  std::vector<std::size_t> order(actors.size());
  for (std::size_t i = 0; i < order.size(); ++i) order[i] = i;
  std::stable_sort(order.begin(), order.end(), [&actors](std::size_t a, std::size_t b) { return actors[a].Bytes() > actors[b].Bytes(); });
  for (const std::size_t i : order) {
    if (total <= limit) return;
    WrittenActor& actor = actors[i];
    if (std::find(actor.shotOnlyMesh.begin(), actor.shotOnlyMesh.end(), true) == actor.shotOnlyMesh.end()) continue;
    std::vector<std::string> surfaces;
    std::vector<bool> flags;
    for (std::size_t k = 0; k < actor.surfaces.size(); ++k) {
      if (actor.shotOnlyMesh[k]) continue;
      surfaces.push_back(std::move(actor.surfaces[k]));
      flags.push_back(false);
    }
    actor.surfaces = std::move(surfaces);
    actor.shotOnlyMesh = std::move(flags);
    const std::size_t before = actor.text.size();
    if (actor.surfaces.empty()) {
      actor.text.clear();
    } else {
      Compose(actor);
    }
    total -= before - actor.text.size();
    report.shotDropped.push_back(actor.name);
  }
}

std::string SpawnText(const SceneSpawn& spawn, double perUnit, std::size_t index) {
  std::string out = "{\"at\":";
  AppendPoint(out, spawn.at, perUnit);
  out += ",\"name\":";
  AppendString(out, spawn.name.empty() ? "Spawn_" + std::to_string(index) : ReaderName(spawn.name));
  AppendTags(out, spawn.tags);
  out += '}';
  return out;
}

/** The head of the file: everything but the actors and the spawns. */
std::string HeadText(const SceneInput& input, double perUnit) {
  std::string out = "{\"format\":\"genex-world-scene\",\"version\":1,\"unitsPerMeter\":";
  AppendNumber(out, input.engineUnitsPerMeter / perUnit);
  if (!input.source.empty()) {
    out += ",\"source\":{";
    bool first = true;
    for (const auto& [key, value] : input.source) {
      if (value.empty()) continue;
      if (!first) out += ',';
      first = false;
      AppendString(out, key);
      out += ':';
      AppendString(out, ReaderName(value));
    }
    out += '}';
  }
  if (input.hasHull) {
    out += ",\"hull\":{\"radius\":";
    AppendNumber(out, input.hull.radius / perUnit);
    out += ",\"height\":";
    AppendNumber(out, input.hull.height / perUnit);
    out += ",\"crouchHeight\":";
    AppendNumber(out, input.hull.crouchHeight / perUnit);
    out += ",\"step\":";
    AppendNumber(out, input.hull.step / perUnit);
    out += ",\"jump\":";
    AppendNumber(out, input.hull.jump / perUnit);
    out += ",\"leap\":";
    AppendNumber(out, input.hull.leap / perUnit);
    out += '}';
  }
  out += ",\n\"actors\":[\n";
  return out;
}

void ListLargest(const std::vector<WrittenActor>& actors, ExportReport& report) {
  for (const WrittenActor& actor : actors) {
    if (!actor.text.empty()) report.largest.push_back(world_scene::ActorBytes{actor.name, actor.Bytes()});
  }
  std::stable_sort(report.largest.begin(), report.largest.end(), [](const world_scene::ActorBytes& a, const world_scene::ActorBytes& b) { return a.bytes > b.bytes; });
  if (report.largest.size() > kLargestListed) report.largest.resize(kLargestListed);
}

void SortRefused(std::vector<RefusedActor>& refused) {
  std::stable_sort(refused.begin(), refused.end(), [](const RefusedActor& a, const RefusedActor& b) { return a.name < b.name; });
}

}  // namespace genex::world_scene_detail

namespace genex::world_scene {

using namespace genex::world_scene_detail;

bool SurfaceFromBoxCorners(const std::array<Point, 8>& corners, Surface& out) {
  const std::array<Point, 3> edges{Minus(corners[1], corners[0]), Minus(corners[2], corners[0]), Minus(corners[4], corners[0])};
  const std::array<double, 3> lengths{Length(edges[0]), Length(edges[1]), Length(edges[2])};
  const int flat = (lengths[0] <= kNoLength ? 1 : 0) + (lengths[1] <= kNoLength ? 1 : 0) + (lengths[2] <= kNoLength ? 1 : 0);
  if (flat >= 2) return false;
  std::array<Point, 3> axes{};
  for (std::size_t i = 0; i < 3; ++i) {
    if (lengths[i] > kNoLength) axes[i] = Scaled(edges[i], 1.0 / lengths[i]);
  }
  // A box of no thickness has no third edge to read: its axis is the normal of the other two.
  if (lengths[0] <= kNoLength) axes[0] = Cross(axes[1], axes[2]);
  if (lengths[1] <= kNoLength) axes[1] = Cross(axes[2], axes[0]);
  if (lengths[2] <= kNoLength) axes[2] = Cross(axes[0], axes[1]);
  const double square01 = std::fabs(Dot(axes[0], axes[1]));
  const double square12 = std::fabs(Dot(axes[1], axes[2]));
  const double square02 = std::fabs(Dot(axes[0], axes[2]));
  if (square01 > kOnAxisShare || square12 > kOnAxisShare || square02 > kOnAxisShare) {
    out.kind = SurfaceKind::Hull;
    out.points.assign(corners.begin(), corners.end());
    return true;
  }
  const Point center{(corners[0].x + corners[7].x) * 0.5, (corners[0].y + corners[7].y) * 0.5, (corners[0].z + corners[7].z) * 0.5};
  SetBox(out, center, axes, {lengths[0] * 0.5, lengths[1] * 0.5, lengths[2] * 0.5});
  return true;
}

void SimplifyHull(Surface& surface) {
  if (surface.kind != SurfaceKind::Hull || surface.points.size() < 8) return;
  Point low = surface.points.front();
  Point high = low;
  for (const Point& p : surface.points) {
    low = Point{(std::min)(low.x, p.x), (std::min)(low.y, p.y), (std::min)(low.z, p.z)};
    high = Point{(std::max)(high.x, p.x), (std::max)(high.y, p.y), (std::max)(high.z, p.z)};
  }
  const Point size = Minus(high, low);
  const double slack = Length(size) * kOnAxisShare;
  unsigned seen = 0;
  for (const Point& p : surface.points) {
    const auto side = [slack](double value, double lo, double hi) { return std::fabs(value - lo) <= slack ? 0 : (std::fabs(value - hi) <= slack ? 1 : -1); };
    const int x = side(p.x, low.x, high.x);
    const int y = side(p.y, low.y, high.y);
    const int z = side(p.z, low.z, high.z);
    if (x < 0 || y < 0 || z < 0) return;
    seen |= 1u << (x | (y << 1) | (z << 2));
  }
  if (seen != 0xffu || size.x <= kNoLength || size.y <= kNoLength || size.z <= kNoLength) return;
  surface.kind = SurfaceKind::Box;
  surface.hasAxes = false;
  surface.center = Point{(low.x + high.x) * 0.5, (low.y + high.y) * 0.5, (low.z + high.z) * 0.5};
  surface.half = Scaled(size, 0.5);
  surface.points.clear();
}

bool MeshFromGrid(const std::vector<Point>& grid, int cols, int rows, const std::vector<std::uint8_t>& holes, Surface& out) {
  if (cols < 2 || rows < 2) return false;
  const std::size_t width = static_cast<std::size_t>(cols);
  const std::size_t height = static_cast<std::size_t>(rows);
  const std::size_t quads = (width - 1) * (height - 1);
  if (grid.size() != width * height || (!holes.empty() && holes.size() != quads)) return false;
  out.kind = SurfaceKind::Mesh;
  out.points = grid;
  out.indices.clear();
  out.indices.reserve(quads * 6);
  for (std::size_t row = 0; row + 1 < height; ++row) {
    for (std::size_t col = 0; col + 1 < width; ++col) {
      if (!holes.empty() && holes[row * (width - 1) + col] != 0) continue;
      const std::uint32_t a = static_cast<std::uint32_t>(row * width + col);
      const std::uint32_t b = a + 1;
      const std::uint32_t c = a + static_cast<std::uint32_t>(width);
      const std::uint32_t d = c + 1;
      const std::uint32_t faces[6] = {a, c, d, a, d, b};
      out.indices.insert(out.indices.end(), faces, faces + 6);
    }
  }
  return true;
}

ExportResult Export(const SceneInput& input, const ExportOptions& options) {
  ExportResult result;
  ExportReport& report = result.report;
  const bool goodUnits = std::isfinite(input.unitsPerGenex) && input.unitsPerGenex > 0.0 && std::isfinite(input.engineUnitsPerMeter) && input.engineUnitsPerMeter > 0.0;
  if (!goodUnits) {
    report.status = ExportStatus::BadInput;
    report.detail = "units are not positive finite numbers";
    return result;
  }
  const double perUnit = input.unitsPerGenex;  // Divided, not multiplied by its inverse: the direct bake's rounding, so a box lands on the same float32.

  std::vector<WrittenActor> actors;
  actors.reserve(input.actors.size());
  for (const SceneActor& actor : input.actors) {
    WrittenActor written;
    if (WriteActor(actor, perUnit, report, written)) actors.push_back(std::move(written));
  }
  report.actors = static_cast<int>(actors.size());

  std::vector<std::string> spawns;
  for (std::size_t i = 0; i < input.spawns.size(); ++i) {
    const SceneSpawn& spawn = input.spawns[i];
    ValueCheck check;
    check.perUnit = perUnit;
    check.Vec(spawn.at);
    if (check.nonFinite || check.outOfRange) {
      const RefuseReason reason = check.nonFinite ? RefuseReason::NonFinite : RefuseReason::OutOfRange;
      report.refused.push_back(RefusedActor{ReaderName(spawn.name), reason});
      continue;
    }
    spawns.push_back(SpawnText(spawn, perUnit, i));
  }
  report.spawns = static_cast<int>(spawns.size());
  std::stable_sort(spawns.begin(), spawns.end());
  std::stable_sort(report.movable.begin(), report.movable.end());
  SortRefused(report.refused);

  if (!report.refused.empty() && !options.allowRefused) {
    report.status = ExportStatus::Refused;
    report.detail = std::to_string(report.refused.size()) + " actors cannot go in a scene";
    return result;
  }
  if (report.moveSurfaces == 0) {
    report.status = ExportStatus::NoSurfaces;
    report.detail = "nothing in this level stops a hull and stays put";
    return result;
  }
  if (spawns.empty()) {
    report.status = ExportStatus::NoSpawns;
    report.detail = "no spawn: a fit starts from where a hull can start";
    return result;
  }

  const std::string head = HeadText(input, perUnit);
  // Everything but the actors' own text; the separators are counted per actor.
  std::size_t total = head.size();
  for (const std::string& spawn : spawns) total += spawn.size() + 2;
  total += std::strlen("],\n\"spawns\":[\n\n]}\n");
  for (const WrittenActor& actor : actors) total += actor.Bytes() + 2;

  if (total > options.maxBytes) DropShotTriangles(actors, total, options.maxBytes, report);
  std::stable_sort(report.shotDropped.begin(), report.shotDropped.end());
  ListLargest(actors, report);
  if (total > options.maxBytes) {
    report.status = ExportStatus::TooLarge;
    report.bytes = total;
    report.detail = "the scene is " + std::to_string(total) + " bytes, over " + std::to_string(options.maxBytes);
    return result;
  }

  std::stable_sort(actors.begin(), actors.end(), [](const WrittenActor& a, const WrittenActor& b) { return a.name != b.name ? a.name < b.name : a.text < b.text; });
  result.text.reserve(total);
  result.text += head;
  bool first = true;
  for (const WrittenActor& actor : actors) {
    if (actor.text.empty()) continue;
    if (!first) result.text += ",\n";
    first = false;
    result.text += actor.text;
  }
  result.text += "\n],\n\"spawns\":[\n";
  for (std::size_t i = 0; i < spawns.size(); ++i) {
    if (i != 0) result.text += ",\n";
    result.text += spawns[i];
  }
  result.text += "\n]}\n";
  report.bytes = result.text.size();
  return result;
}

const char* RefuseReasonName(RefuseReason reason) {
  switch (reason) {
    case RefuseReason::NonFinite:
      return "non_finite";
    case RefuseReason::OutOfRange:
      return "out_of_range";
    case RefuseReason::BadIndex:
      return "bad_index";
    case RefuseReason::HullTooLarge:
      return "hull_too_large";
    case RefuseReason::BadHeightfield:
      return "bad_heightfield";
  }
  return "unknown";
}

const char* ExportStatusName(ExportStatus status) {
  switch (status) {
    case ExportStatus::Ok:
      return "ok";
    case ExportStatus::BadInput:
      return "bad_input";
    case ExportStatus::NoSurfaces:
      return "no_surfaces";
    case ExportStatus::NoSpawns:
      return "no_spawns";
    case ExportStatus::Refused:
      return "refused";
    case ExportStatus::TooLarge:
      return "too_large";
  }
  return "unknown";
}

std::vector<std::string> ReportLines(const ExportReport& report) {
  std::vector<std::string> lines;
  lines.push_back(std::string(ExportStatusName(report.status)) + ": " + std::to_string(report.actors) + " actors, " + std::to_string(report.boxes) + " boxes, " + std::to_string(report.hulls) + " hulls, " +
                  std::to_string(report.spheres + report.capsules) + " round, " + std::to_string(report.meshes) + " meshes (" + std::to_string(report.triangles) + " triangles), " +
                  std::to_string(report.heightfields) + " heightfields (" + std::to_string(report.heightSamples) + " samples), " + std::to_string(report.moveSurfaces) + " stop a hull, " +
                  std::to_string(report.shotSurfaces) + " stop a bullet, " + std::to_string(report.spawns) + " spawns, " + std::to_string(report.bytes) + " bytes" + (report.detail.empty() ? "" : ": " + report.detail));
  for (const RefusedActor& refused : report.refused) lines.push_back("  REFUSED: " + refused.name + " (" + RefuseReasonName(refused.reason) + ")");
  for (const std::string& name : report.movable) lines.push_back("  MOVABLE, named and not in a static world: " + name);
  for (const std::string& name : report.shotDropped) lines.push_back("  SHOT TRIANGLES LEFT OUT to fit the size, its shot world is its simple collision: " + name);
  if (report.status == ExportStatus::TooLarge) {
    for (const ActorBytes& actor : report.largest) lines.push_back("  LARGEST: " + actor.name + " (" + std::to_string(actor.bytes) + " bytes)");
  }
  return lines;
}

}  // namespace genex::world_scene
