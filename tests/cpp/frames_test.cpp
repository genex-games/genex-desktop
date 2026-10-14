// Rows for src/frames.h: the embedded run's frame ring as the studio drives it (`surface`,
// `release`, one present per frame), its hostile arguments, and Live's input positions. The Mac's
// IOSurfaces, EGL and mach messages stand behind the ring's seam; here a recording seam stands in,
// so every row runs on any host compiler. Run with no argument for every row, or with a row name.
#include "frames.h"

#include <cassert>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <string>
#include <utility>
#include <vector>

#include "input.h"
#include "json.h"
#include "protocol.h"

namespace {

using studio::frames::Blit;
using studio::frames::Frame;
using studio::frames::Made;
using studio::frames::Presented;
using studio::frames::Rect;
using studio::frames::Ring;
using studio::frames::Sent;
using studio::frames::SurfaceRequest;
namespace Refusal = studio::frames::Refusal;

/** The headless screen every row presents: the starter's world size. */
constexpr int SCREEN_W = 960;
constexpr int SCREEN_H = 540;
/** A realtime clock reading in microseconds, and one 60 Hz frame on it. */
constexpr std::uint64_t T0 = 1'790'000'000'000'000ULL;
constexpr std::uint64_t FRAME_US = 16'667;

/** The realtime clock a row presents on: each reading one frame after the last. */
struct Clock {
  std::uint64_t at = T0;
  std::uint64_t next() {
    at += FRAME_US;
    return at;
  }
};

/** A seam that records what the ring asked of it and answers as the row sets it up. */
class Recording : public studio::frames::Seam {
 public:
  Made made = Made::Ok;
  bool drawn = true;
  Sent sent = Sent::Taken;
  std::vector<SurfaceRequest> makes;
  std::vector<std::pair<int, Blit>> draws;
  std::vector<Frame> sends;
  int drops = 0;

  Made make(const SurfaceRequest& request) override {
    makes.push_back(request);
    return made;
  }
  bool draw(int slot, const Blit& blit) override {
    draws.emplace_back(slot, blit);
    return drawn;
  }
  Sent send(const Frame& frame) override {
    sends.push_back(frame);
    return sent;
  }
  void drop() override { ++drops; }
};

json::Value surfaceArg(double w, double h, double generation, double slots = 3, double dpr = 1) {
  json::Value arg = json::Value::object();
  arg.set("w", w);
  arg.set("h", h);
  arg.set("dpr", dpr);
  arg.set("slots", slots);
  arg.set("generation", generation);
  return arg;
}

json::Value releaseArg(double slot, double generation) {
  json::Value arg = json::Value::object();
  arg.set("slot", slot);
  arg.set("generation", generation);
  return arg;
}

/** Open generation `generation` of `w` x `h`; the answer must be the ring the host asked for. */
void open(Ring& ring, int w, int h, std::uint32_t generation) {
  studio::protocol::Answer answer = ring.surface(surfaceArg(w, h, generation));
  assert(answer.ok);
  assert(answer.result["generation"].asNumber() == generation);
  assert(answer.result["width"].asNumber() == w);
  assert(answer.result["height"].asNumber() == h);
  assert(answer.result["slots"].asNumber() == 3);
}

/** The screen was presented one frame after the last, with nothing new drawn: what the ring did. */
Presented present(Ring& ring, Clock& clock) { return ring.present(SCREEN_W, SCREEN_H, clock.next()); }

/** A world frame was drawn, then presented one frame after the last: what the ring did with it. */
Presented frame(Ring& ring, Clock& clock) {
  ring.changed();
  return present(ring, clock);
}

/** Release `slot` of `generation`; the answer is `{}` whether or not it freed anything. */
void release(Ring& ring, int slot, std::uint32_t generation) {
  studio::protocol::Answer answer = ring.release(releaseArg(slot, generation));
  assert(answer.ok);
  assert(answer.result.is(json::Kind::Object) && answer.result.members().empty());
}

/** Whether `frames`' sequence numbers strictly increase. */
bool increasing(const std::vector<Frame>& frames) {
  for (std::size_t i = 1; i < frames.size(); ++i) {
    if (frames[i].seq <= frames[i - 1].seq) return false;
  }
  return true;
}

void freeToHeld() {
  Recording seam;
  Ring ring(seam);
  Clock clock;
  assert(present(ring, clock) == Presented::NoRing);
  open(ring, 960, 540, 1);
  assert(seam.makes.size() == 1 && seam.makes[0].slots == 3 && seam.makes[0].generation == 1);
  // The first frame of a new ring goes out without waiting for a redraw.
  assert(present(ring, clock) == Presented::Sent);
  assert(present(ring, clock) == Presented::Unchanged);
  assert(frame(ring, clock) == Presented::Sent);
  std::uint64_t third = clock.at + FRAME_US;
  assert(frame(ring, clock) == Presented::Sent);
  assert(seam.sends.size() == 3);
  for (int slot = 0; slot < 3; ++slot) {
    const Frame& sent = seam.sends[static_cast<std::size_t>(slot)];
    assert(sent.slot == slot);
    assert(sent.generation == 1 && sent.width == 960 && sent.height == 540);
    assert(sent.seq == static_cast<std::uint64_t>(slot) + 1);
    assert(seam.draws[static_cast<std::size_t>(slot)].first == slot);
  }
  assert(seam.sends[2].timestampUs == third);
  assert(ring.heldMask() == 0b111);
}

void fullRingSkips() {
  Recording seam;
  Ring ring(seam);
  Clock clock;
  open(ring, 640, 360, 1);
  for (int i = 0; i < 3; ++i) assert(frame(ring, clock) == Presented::Sent);
  // No slot is free: the frame is skipped, nothing is drawn or sent, and no burst follows.
  assert(frame(ring, clock) == Presented::Skipped);
  assert(frame(ring, clock) == Presented::Skipped);
  assert(seam.sends.size() == 3 && seam.draws.size() == 3);
  release(ring, 1, 1);
  assert(ring.heldMask() == 0b101);
  // The newest frame goes out once, in the freed slot, and the one after waits again.
  assert(present(ring, clock) == Presented::Sent);
  assert(present(ring, clock) == Presented::Unchanged);
  assert(frame(ring, clock) == Presented::Skipped);
  assert(seam.sends.size() == 4 && seam.sends[3].slot == 1);
  assert(seam.sends[3].seq == 4);
  assert(increasing(seam.sends));
}

void tooSoon() {
  Recording seam;
  Ring ring(seam);
  open(ring, 960, 540, 1);
  assert(ring.present(SCREEN_W, SCREEN_H, T0) == Presented::Sent);
  // Verbs that draw between frames: a slot is free, but the studio would see a burst.
  ring.changed();
  assert(ring.present(SCREEN_W, SCREEN_H, T0 + 1000) == Presented::Skipped);
  assert(ring.present(SCREEN_W, SCREEN_H, T0 + studio::frames::MIN_FRAME_INTERVAL_US - 1) == Presented::Skipped);
  assert(seam.sends.size() == 1 && seam.draws.size() == 1);
  // The waiting frame goes once the interval has passed, and a clock set back never holds one.
  assert(ring.present(SCREEN_W, SCREEN_H, T0 + studio::frames::MIN_FRAME_INTERVAL_US) == Presented::Sent);
  ring.changed();
  assert(ring.present(SCREEN_W, SCREEN_H, T0 - 1'000'000) == Presented::Sent);
  assert(seam.sends.size() == 3 && increasing(seam.sends));
}

void releaseCurrentGenerationOnly() {
  Recording seam;
  Ring ring(seam);
  Clock clock;
  open(ring, 960, 540, 7);
  assert(frame(ring, clock) == Presented::Sent);
  assert(ring.heldMask() == 0b001);
  release(ring, 0, 8);
  release(ring, 0, 6);
  assert(ring.heldMask() == 0b001);
  // A slot this generation never sent, and the slot of the right generation.
  release(ring, 2, 7);
  assert(ring.heldMask() == 0b001);
  release(ring, 0, 7);
  assert(ring.heldMask() == 0);
  assert(frame(ring, clock) == Presented::Sent);
  assert(seam.sends.back().slot == 0 && seam.sends.back().seq == 2);
}

void staleReleaseIgnored() {
  Recording seam;
  Ring ring(seam);
  Clock clock;
  open(ring, 960, 540, 1);
  assert(frame(ring, clock) == Presented::Sent);
  open(ring, 640, 360, 2);
  assert(frame(ring, clock) == Presented::Sent);
  assert(seam.sends.back().generation == 2 && seam.sends.back().slot == 0);
  // The old ring's slot 0 comes back late: the new ring's slot 0 stays the host's.
  release(ring, 0, 1);
  assert(ring.heldMask() == 0b001);
  assert(frame(ring, clock) == Presented::Sent);
  assert(seam.sends.back().slot == 1);
}

void newGenerationFreesAll() {
  Recording seam;
  Ring ring(seam);
  Clock clock;
  open(ring, 960, 540, 1);
  for (int i = 0; i < 3; ++i) assert(frame(ring, clock) == Presented::Sent);
  assert(ring.heldMask() == 0b111);
  open(ring, 1280, 720, 2);
  assert(seam.makes.size() == 2 && seam.makes[1].generation == 2 && seam.makes[1].width == 1280);
  assert(seam.drops == 1);
  assert(ring.heldMask() == 0);
  assert(ring.generation() == 2);
  assert(present(ring, clock) == Presented::Sent);
  const Frame& first = seam.sends.back();
  assert(first.slot == 0 && first.generation == 2 && first.width == 1280 && first.height == 720);
  assert(first.seq == 4);
  assert(increasing(seam.sends));
}

void staleGeneration() {
  Recording seam;
  Ring ring(seam);
  open(ring, 960, 540, 5);
  for (double generation : {5.0, 4.0, 1.0}) {
    studio::protocol::Answer answer = ring.surface(surfaceArg(960, 540, generation));
    assert(!answer.ok && answer.error == Refusal::StaleGeneration);
  }
  assert(seam.makes.size() == 1 && ring.generation() == 5);
}

void hostileSurface() {
  const double nan = std::numeric_limits<double>::quiet_NaN();
  const double inf = std::numeric_limits<double>::infinity();
  std::vector<json::Value> hostile = {
      surfaceArg(960, 540, 1, 4),
      surfaceArg(960, 540, 1, 0),
      surfaceArg(960, 540, 1, 2.5),
      surfaceArg(0, 540, 1),
      surfaceArg(960, 0, 1),
      surfaceArg(8193, 540, 1),
      surfaceArg(4097, 540, 1),
      surfaceArg(-960, 540, 1),
      surfaceArg(960.5, 540, 1),
      surfaceArg(960, 540, 0),
      surfaceArg(960, 540, -1),
      surfaceArg(960, 540, 1.5),
      surfaceArg(960, 540, 4294967296),
      surfaceArg(960, 540, 1, 3, nan),
      surfaceArg(960, 540, 1, 3, inf),
      surfaceArg(960, 540, 1, 3, 0),
      surfaceArg(960, 540, 1, 3, 0.5),
      surfaceArg(960, 540, 1, 3, 5),
      surfaceArg(nan, 540, 1),
      surfaceArg(960, inf, 1),
      json::Value(),
      json::Value("960x540"),
      json::Value(3),
      json::Value::array(),
      json::Value::object(),
  };
  json::Value text = surfaceArg(960, 540, 1);
  text.set("w", "960");
  hostile.push_back(text);
  json::Value flag = surfaceArg(960, 540, 1);
  flag.set("generation", true);
  hostile.push_back(flag);
  json::Value missing = json::Value::object();
  missing.set("w", 960);
  missing.set("h", 540);
  missing.set("generation", 1);
  hostile.push_back(missing);
  Recording seam;
  Ring ring(seam);
  Clock clock;
  for (const json::Value& arg : hostile) {
    studio::protocol::Answer answer = ring.surface(arg);
    assert(!answer.ok && answer.error == Refusal::BadArgument);
  }
  assert(seam.makes.empty() && seam.drops == 0);
  assert(frame(ring, clock) == Presented::NoRing);
  assert(seam.draws.empty() && seam.sends.empty());
  // The largest ring the studio may ask for passes.
  studio::protocol::Answer largest = ring.surface(surfaceArg(4096, 4096, 4294967295.0, 1, 4));
  assert(largest.ok && seam.makes.size() == 1 && seam.makes[0].slots == 1);
}

void hostileRelease() {
  Recording seam;
  Ring ring(seam);
  Clock clock;
  open(ring, 960, 540, 1);
  assert(frame(ring, clock) == Presented::Sent);
  std::vector<json::Value> hostile = {
      releaseArg(3, 1),   releaseArg(-1, 1), releaseArg(0.5, 1), releaseArg(0, 0),      releaseArg(0, -1),
      releaseArg(0, 1.5), json::Value(),     json::Value("0"),   json::Value::object(),
  };
  json::Value text = releaseArg(0, 1);
  text.set("slot", "0");
  hostile.push_back(text);
  for (const json::Value& arg : hostile) {
    studio::protocol::Answer answer = ring.release(arg);
    assert(!answer.ok && answer.error == Refusal::BadArgument);
  }
  assert(ring.heldMask() == 0b001);
}

void sendNotTaken() {
  Recording seam;
  Ring ring(seam);
  Clock clock;
  open(ring, 960, 540, 1);
  seam.sent = Sent::NotTaken;
  // The host's queue was full: nothing reached it, the slot stays the game's, the frame is retried.
  assert(present(ring, clock) == Presented::Skipped);
  assert(ring.heldMask() == 0);
  seam.sent = Sent::Taken;
  assert(present(ring, clock) == Presented::Sent);
  assert(seam.sends.size() == 2 && seam.sends[0].slot == 0 && seam.sends[1].slot == 0);
  assert(increasing(seam.sends));
  assert(ring.heldMask() == 0b001);
}

void hostGone() {
  Recording seam;
  Ring ring(seam);
  Clock clock;
  open(ring, 960, 540, 1);
  seam.sent = Sent::Gone;
  assert(present(ring, clock) == Presented::Failed);
  assert(seam.drops == 1);
  assert(frame(ring, clock) == Presented::NoRing);
  seam.sent = Sent::Taken;
  open(ring, 960, 540, 2);
  assert(present(ring, clock) == Presented::Sent);
  assert(seam.sends.back().seq == 2);
}

void drawFailed() {
  Recording seam;
  Ring ring(seam);
  Clock clock;
  open(ring, 960, 540, 1);
  seam.drawn = false;
  assert(present(ring, clock) == Presented::Failed);
  assert(seam.sends.empty() && ring.heldMask() == 0);
  seam.drawn = true;
  assert(present(ring, clock) == Presented::Sent);
  assert(seam.sends.size() == 1 && seam.sends[0].slot == 0);
}

void noService() {
  Recording seam;
  Ring ring(seam);
  Clock clock;
  seam.made = Made::NoService;
  studio::protocol::Answer none = ring.surface(surfaceArg(960, 540, 1));
  assert(!none.ok && none.error == Refusal::NoService);
  seam.made = Made::Failed;
  studio::protocol::Answer failed = ring.surface(surfaceArg(960, 540, 2));
  assert(!failed.ok && failed.error == Refusal::SurfaceFailed);
  assert(frame(ring, clock) == Presented::NoRing);
  assert(!ring.active());
  // A later generation may still succeed.
  seam.made = Made::Ok;
  open(ring, 960, 540, 3);
  assert(ring.active());
  assert(present(ring, clock) == Presented::Sent);
}

void closeDrops() {
  Recording seam;
  Ring ring(seam);
  Clock clock;
  open(ring, 960, 540, 1);
  assert(frame(ring, clock) == Presented::Sent);
  ring.close();
  assert(seam.drops == 1 && !ring.active());
  assert(frame(ring, clock) == Presented::NoRing);
  ring.close();
  assert(seam.drops == 1);
}

bool near(double a, double b) { return std::fabs(a - b) < 1e-9; }

bool rectIs(const Rect& rect, double x, double y, double width, double height) {
  return near(rect.x, x) && near(rect.y, y) && near(rect.width, width) && near(rect.height, height);
}

void fitsTheScreen() {
  using studio::frames::fit;
  assert(rectIs(fit(960, 540, 960, 540), 0, 0, 960, 540));
  assert(rectIs(fit(960, 540, 640, 360), 0, 0, 640, 360));
  assert(rectIs(fit(960, 540, 800, 800), 0, 175, 800, 450));
  assert(rectIs(fit(540, 960, 800, 800), 175, 0, 450, 800));
  assert(rectIs(fit(0, 540, 800, 800), 0, 0, 0, 0));
  assert(rectIs(fit(960, 540, 0, 800), 0, 0, 0, 0));
  // The blit gets the screen whole and where it lands in the ring.
  Recording seam;
  Ring ring(seam);
  open(ring, 800, 800, 1);
  Clock clock;
  assert(present(ring, clock) == Presented::Sent);
  const Blit& blit = seam.draws[0].second;
  assert(blit.screenWidth == SCREEN_W && blit.screenHeight == SCREEN_H);
  assert(rectIs(blit.into, 0, 175, 800, 450));
}

json::Value positioned(const char* type, double x, double y, bool px) {
  json::Value action = json::Value::object();
  action.set("type", type);
  action.set("x", x);
  action.set("y", y);
  if (px) action.set("px", true);
  return action;
}

json::Value actions(std::vector<json::Value> list) {
  json::Value arg = json::Value::object();
  arg.set("actions", json::Value::array(std::move(list)));
  return arg;
}

void inputInRingPixels() {
  Recording seam;
  Ring ring(seam);
  json::Value moved = actions({positioned("move", 400, 400, true)});
  // Without a ring, pixel positions stay as they came (the input merge ignores them).
  assert(ring.input(moved, SCREEN_W, SCREEN_H) == moved);
  open(ring, 800, 800, 1);
  json::Value mapped = ring.input(moved, SCREEN_W, SCREEN_H);
  const json::Value& move = mapped["actions"].items()[0];
  assert(move["type"].asString() == "move" && !move.find("px"));
  assert(near(move["x"].asNumber(), 0.5) && near(move["y"].asNumber(), 0.5));
  // The ring letterboxes the screen: its top bar is above the frame, a fraction never leaves 0..1.
  json::Value edges = actions(
      {positioned("click", 0, 175, true), positioned("move", 800, 10, true), positioned("move", 0.25, 0.75, false)});
  json::Value mappedEdges = ring.input(edges, SCREEN_W, SCREEN_H);
  const json::Value::Array& items = mappedEdges["actions"].items();
  assert(near(items[0]["x"].asNumber(), 0) && near(items[0]["y"].asNumber(), 0));
  assert(near(items[1]["x"].asNumber(), 1) && near(items[1]["y"].asNumber(), 0));
  assert(items[2] == edges["actions"].items()[2]);
  json::Value pointer = json::Value::object();
  json::Value at = json::Value::object();
  at.set("x", 200);
  at.set("y", 400);
  at.set("px", true);
  pointer.set("pointer", at);
  studio::Injection injection = studio::parseInjection(ring.input(pointer, SCREEN_W, SCREEN_H));
  assert(injection.hasPointer && near(injection.pointer.x, 0.25) && near(injection.pointer.y, 0.5));
  studio::Injection clicked = studio::parseInjection(mapped);
  assert(clicked.hasPointer && clicked.ignored == 0);
  // Hostile pixel positions read as no position, never as NaN.
  json::Value hostile = actions({positioned("move", std::numeric_limits<double>::quiet_NaN(), 10, true)});
  studio::Injection dropped = studio::parseInjection(ring.input(hostile, SCREEN_W, SCREEN_H));
  assert(!dropped.hasPointer || (std::isfinite(dropped.pointer.x) && std::isfinite(dropped.pointer.y)));
}

struct Row {
  const char* name;
  void (*run)();
};

const Row ROWS[] = {
    {"free-to-held", freeToHeld},
    {"full-ring-skips", fullRingSkips},
    {"too-soon", tooSoon},
    {"release-current-generation-only", releaseCurrentGenerationOnly},
    {"stale-release-ignored", staleReleaseIgnored},
    {"new-generation-frees-all", newGenerationFreesAll},
    {"stale-generation", staleGeneration},
    {"hostile-surface", hostileSurface},
    {"hostile-release", hostileRelease},
    {"send-not-taken", sendNotTaken},
    {"host-gone", hostGone},
    {"draw-failed", drawFailed},
    {"no-service", noService},
    {"close-drops", closeDrops},
    {"fits-the-screen", fitsTheScreen},
    {"input-in-ring-pixels", inputInRingPixels},
};

}  // namespace

int main(int argc, char** argv) {
  int ran = 0;
  for (const Row& row : ROWS) {
    if (argc > 1 && std::strcmp(argv[1], row.name) != 0) continue;
    row.run();
    std::printf("ok %s\n", row.name);
    ++ran;
  }
  if (ran > 0) return 0;
  std::fprintf(stderr, "no row named %s\n", argc > 1 ? argv[1] : "(none)");
  return 2;
}
