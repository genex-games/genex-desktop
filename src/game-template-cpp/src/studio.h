// The studio contract, C++ side: what a game hands the studio (studio::Game) and what its update()
// reads (studio::Ctx). src/main.cpp calls studio::install({...}) once; the runtime then owns the
// window, the fixed-step clock, the world texture, the one input path and the verbs the studio
// calls on every destination: seed, start, pause, step, state, input, capture, debugCamera,
// cameras, eyes, demos, demo and audio (docs/CONTRACT.md has the tables). Never remove a verb:
// a build the studio cannot drive is a black screen for every critic.
#pragma once

#include <functional>
#include <string>
#include <string_view>
#include <vector>

#include "hud.h"
#include "input.h"
#include "json.h"
#include "raylib.h"
#include "rng.h"

namespace studio {

/** What update() reads; game code reads nothing else. */
struct Ctx {
  /** Held, pressed and released keys by DOM code ("KeyW", "Space"), mouse buttons as "Mouse1".."Mouse3". */
  const Input& keys;
  /** Mouse movement since the last tick, in pixels: real only while the pointer is locked, or injected. */
  Vector2 look;
  /** Wheel movement since the last tick. */
  float wheel;
  /** Cursor position as a fraction of the frame, y down. */
  Vector2 pointer;
  bool pointerLock;
  /** Up to four gamepads in the standard mapping. */
  const Pads& pads;
  /** Text committed this tick (typing or IME), UTF-8, often empty. */
  const char* text;
  /** The only randomness a simulation may use: seeded by seed(). */
  Rng& rng;
  /** The fixed tick, in seconds (1/60). */
  float dt;
  int tick;
};

/** A named observer camera: it moves the view, never the simulation. */
struct NamedCamera {
  std::string name;
  std::function<Camera3D()> place;
};

/** A player-eye camera ("eye:spawn", "eye:here"): where the player would look from. */
struct Eye {
  std::string name;
  std::function<Camera3D()> place;
};

/** A scripted drive a generic walk cannot reach; it ends paused and may return data its checks read. */
struct Demo {
  std::string name;
  std::function<json::Value()> run;
};

/** Everything a game hands the studio. Only `draw` is needed for a first frame. */
struct Game {
  const char* title = "Genex game";
  /** Rebuild the world from a seed (the runtime has already called SetRandomSeed(seed)). */
  std::function<void(int seed)> reset;
  /** One fixed tick. */
  std::function<void(float dt, const Ctx& ctx)> update;
  /** Draw the world into the world texture, seen from `camera` (call BeginMode3D yourself; 2D games ignore it). */
  std::function<void(const Camera3D& camera)> draw;
  /** The game's own view: the camera draw() gets when no observer camera is placed. */
  std::function<Camera3D()> camera;
  /** The game's probe leaves, one per mechanic: what state().<name> checks read. */
  std::function<json::Value()> probes;
  /** Where the player is: `{x, y, z, yaw?}`, or null for a game without one. */
  std::function<json::Value()> player;
  std::vector<NamedCamera> cameras;
  std::vector<Eye> eyes;
  std::vector<Demo> demos;
  /** The fixed world texture's size; the window letterboxes it. */
  Vector2 worldSize = {960, 540};
  Color background = {18, 20, 28, 255};
  /** The folder saves go under on Windows and Linux (letters, digits, space, `_`, `-`, `.`); null takes the name the studio's build gives the game. */
  const char* saveName = nullptr;
};

/** Start the runtime; required in src/main.cpp. Never returns on the web; returns when a native window closes. */
void install(Game game);

/** Tag what the following draws belong to, for the draw counter (`state().__render.tags`). */
void tag(const char* name);
/** Draw a model and count it. */
void drawModel(Model model, Vector3 position, float scale, Color tint);
/** Draw a model with rotation and scale, and count it. */
void drawModelEx(Model model, Vector3 position, Vector3 axis, float angle, Vector3 scale, Color tint);
/** Draw a mesh and count it. */
void drawMesh(Mesh mesh, Material material, Matrix transform);

/** A texture from assets/<rel>; a missing or unsafe path gives a visible magenta checker, never a crash. */
Texture2D asset(const char* rel);
/** A model from assets/<rel> (GLB/glTF without Draco, OBJ, IQM, M3D, VOX). */
Model assetModel(const char* rel);
/** A sound from assets/<rel> (WAV, OGG, MP3, QOA). */
Sound assetSound(const char* rel);
/** A shader from source strings written without a `#version` line; null keeps raylib's default stage. */
Shader shader(const char* vertex, const char* fragment);

/** Save `size` bytes as `file` under this destination's save folder. */
bool save(const char* file, const void* data, int size);
/** Read `file` back from the save folder; empty when it is not there. */
std::string load(const char* file);

/** For demos: run the simulation `ms` forward exactly as step(ms) does, and draw the frame. */
json::Value advance(double ms);
/** For demos: inject input exactly as the `input` verb does. */
void inject(const Injection& input);

}  // namespace studio
