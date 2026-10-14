// A stub game: the template's studio runtime (every src/*.cpp but main.cpp) built over
// tests/cpp/raylib_stub.h, so the runner can drive it over fd 3 exactly as the host drives a
// real game: ready, ops, captures, events, quit and EOF. It prints no row names; the runner
// checks what arrives on fd 3, what lands in GENEX_STATE_DIR and how the process exits. Its probes
// also report what the stub raylib saw (fronts, presents, the last frame's text), so a row can
// tell a call the runtime made from one it skipped.
//
//   capture_test <scenario>   basic | nowindow | capture | focus | square | sine | cpu | gpu (raylib_stub.h)
#include <string>
#include <utility>

#include "raylib.h"
#include "platform.h"
#include "studio.h"

namespace {

/** A world small enough to stay cheap and larger than the runtime's minimum side. */
constexpr Vector2 WORLD_SIZE = {96.0f, 64.0f};

/** Every DrawText() of the last world frame: `{text, x, y, size, width}`, the width as MeasureText() gives it. */
json::Value textsDrawn() {
  json::Value texts = json::Value::array();
  for (const stub::TextDraw& drawn : stub::state().texts) {
    json::Value text = json::Value::object();
    text.set("text", drawn.text);
    text.set("x", drawn.x);
    text.set("y", drawn.y);
    text.set("size", drawn.size);
    text.set("width", MeasureText(drawn.text.c_str(), drawn.size));
    texts.push(std::move(text));
  }
  return texts;
}

/** The game: a counter the ticks advance, its probes and the stub's records, two observer cameras. */
studio::Game stubGame() {
  static int ticks = 0;
  studio::Game game;
  game.title = "stub game";
  game.worldSize = WORLD_SIZE;
  game.reset = [](int) {
    ticks = 0;
    if (!stub::state().assets) return;
    studio::asset("water.png");
    studio::assetModel("fish.glb");
    studio::assetSound("audio/bite.wav");
    studio::asset("missing.png");
    const std::string logged = studio::platform::assetPath("log-only.png");
    TraceLog(LOG_INFO, "FILEIO: [%s] File loaded successfully", logged.c_str());
    TraceLog(LOG_INFO, "FILEIO: [/outside/asset.png] File loaded successfully");
  };
  game.update = [](float, const studio::Ctx&) { ++ticks; };
  game.draw = [](const Camera3D&) { studio::hud::text("score", 4, 4); };
  game.probes = [] {
    json::Value probes = json::Value::object();
    probes.set("ticks", ticks);
    probes.set("fronted", stub::state().fronted);
    probes.set("presented", stub::state().presented);
    probes.set("texts", textsDrawn());
    if (stub::state().assets) {
      json::Value loaded = json::Value::array();
      for (const std::string& file : stub::state().assetLoads) loaded.push(file);
      probes.set("loadedFiles", std::move(loaded));
    }
    return probes;
  };
  game.cameras = {{"overview", [] { return Camera3D{}; }}};
  return game;
}

}  // namespace

int main(int argc, char** argv) {
  stub::configure(argc > 1 ? argv[1] : "basic");
  studio::install(stubGame());
  return 0;
}
