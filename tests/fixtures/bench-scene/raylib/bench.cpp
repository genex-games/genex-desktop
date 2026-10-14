// The matched performance scene on raylib (M2.12c): the raylib-cpp v1 baseline's half of the
// pair `tests/fixtures/bench-scene/rust/bench.rs` is the genex half of. The same scene from the
// same numbers: the ground, the water, the dock's planks, the rod with its line and bobber, and
// `fish` spheres on the orbits bench.rs computes from the tick; no physics, no randomness, no
// assets, no HUD.
//
//   bench <scene.json>
//
// It renders into an offscreen target of the world size inside a hidden window with vsync off,
// runs `frames` frames of one tick each, and waits for the GPU (glFinish) after every frame, so a
// frame's time is its CPU work plus GPU completion, as the genex half measures it. It prints one
// JSON line in the genex half's format (`genex-bench/1`, stack `raylib-cpp`) with the scene it
// read echoed back.
//
// Build it against the raylib the C++ · raylib toolchain store pins (Genex's own lane builds the
// same raylib), for example, with that store's clang and raylib on the include and library paths:
//
//   clang++ -std=c++17 -O2 bench.cpp -lraylib -framework Cocoa -framework IOKit -o bench
//
// then hand the record it prints to the performance row: GENEX_RAYLIB_BENCH_RECORD=<file>.
// The scene file is read with a minimal reader of exactly the keys bench.rs reads.
#include <raylib.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

extern "C" void glFinish(void);

namespace {

struct Scene {
  int width = 0;
  int height = 0;
  int frames = 0;
  int fish = 0;
  float fishRadius = 0;
  int rings = 1;
  int planks = 0;
  float eye[3] = {0, 0, 0};
  float target[3] = {0, 0, 0};
  float fovy = 45;
  int captures = 0;
};

const Color kGround = {64, 112, 52, 255};
const Color kWater = {38, 92, 128, 255};
const Color kPlank = {140, 100, 60, 255};
const Color kRod = {112, 74, 40, 255};
const Color kLine = {230, 230, 220, 255};
const Color kBobber = {220, 40, 40, 255};
const Color kFish[3] = {{232, 196, 64, 255}, {240, 240, 232, 255}, {96, 168, 96, 255}};
const float kTau = 6.28318530717958647692f;

// The numbers after `"key":` in `text` (a list's numbers in order; one for a scalar).
std::vector<double> numbersOf(const std::string& text, const std::string& key) {
  std::vector<double> found;
  const std::string needle = "\"" + key + "\"";
  size_t at = text.find(needle);
  if (at == std::string::npos) return found;
  at = text.find(':', at) + 1;
  const bool list = text.find_first_not_of(" \t\r\n", at) == text.find('[', at);
  const size_t end = list ? text.find(']', at) : text.find_first_of(",}", at);
  std::string slice = text.substr(at, end - at);
  std::replace(slice.begin(), slice.end(), '[', ' ');
  std::replace(slice.begin(), slice.end(), ',', ' ');
  std::istringstream in(slice);
  double value = 0;
  while (in >> value) found.push_back(value);
  return found;
}

double numberOf(const std::string& text, const std::string& key) {
  const std::vector<double> found = numbersOf(text, key);
  return found.empty() ? 0.0 : found[0];
}

Scene sceneOf(const std::string& text) {
  Scene scene;
  const std::vector<double> world = numbersOf(text, "worldSize");
  scene.width = static_cast<int>(world.at(0));
  scene.height = static_cast<int>(world.at(1));
  scene.frames = static_cast<int>(numberOf(text, "frames"));
  scene.fish = static_cast<int>(numberOf(text, "fish"));
  scene.fishRadius = static_cast<float>(numberOf(text, "fishRadius"));
  scene.rings = static_cast<int>(numberOf(text, "schoolRings"));
  scene.planks = static_cast<int>(numberOf(text, "planks"));
  const std::vector<double> eye = numbersOf(text, "eye");
  const std::vector<double> target = numbersOf(text, "target");
  for (int i = 0; i < 3; i++) {
    scene.eye[i] = static_cast<float>(eye.at(i));
    scene.target[i] = static_cast<float>(target.at(i));
  }
  scene.fovy = static_cast<float>(numberOf(text, "fovy"));
  scene.captures = static_cast<int>(numberOf(text, "captures"));
  return scene;
}

// Fish `index` at `tick`, as bench.rs places it.
Vector3 fishAt(const Scene& scene, int index, long tick) {
  const int ring = index % scene.rings;
  const int perRing = (scene.fish + scene.rings - 1) / scene.rings;
  const int slot = index / scene.rings;
  const float radius = 3.0f + 1.1f * static_cast<float>(ring);
  const float speed = 0.004f + 0.0015f * static_cast<float>(ring);
  const float angle = kTau * static_cast<float>(slot) / static_cast<float>(perRing) + speed * static_cast<float>(tick);
  return {radius * std::cos(angle), -0.3f + 0.08f * std::sin(angle * 3.0f), radius * std::sin(angle)};
}

void draw(const Scene& scene, long tick) {
  DrawCubeV({0.0f, -0.6f, 0.0f}, {40.0f, 1.0f, 40.0f}, kGround);
  DrawCubeV({0.0f, -0.05f, 0.0f}, {24.0f, 0.1f, 24.0f}, kWater);
  for (int plank = 0; plank < scene.planks; plank++) {
    DrawCubeV({0.0f, 0.1f, 8.0f - 0.3f * static_cast<float>(plank)}, {2.4f, 0.08f, 0.26f}, kPlank);
  }
  const Vector3 tip = {0.0f, 2.6f, 7.5f};
  const Vector3 bobber = {0.0f, 0.05f, 2.0f};
  DrawCubeV({0.0f, 1.3f, 8.4f}, {0.12f, 2.6f, 0.12f}, kRod);
  DrawSphere(bobber, 0.2f, kBobber);
  DrawLine3D(tip, bobber, kLine);
  for (int index = 0; index < scene.fish; index++) {
    DrawSphere(fishAt(scene, index, tick), scene.fishRadius, kFish[index % 3]);
  }
}

double msSince(std::chrono::steady_clock::time_point since) {
  return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - since).count();
}

double percentile(const std::vector<double>& sorted, double p) {
  if (sorted.empty()) return 0.0;
  const size_t rank = static_cast<size_t>(std::lround((p / 100.0) * static_cast<double>(sorted.size() - 1)));
  return sorted[std::min(rank, sorted.size() - 1)];
}

}  // namespace

int main(int argc, char** argv) {
  const auto processStart = std::chrono::steady_clock::now();
  if (argc < 2) {
    std::fprintf(stderr, "usage: bench <scene.json>\n");
    return 2;
  }
  std::ifstream file(argv[1]);
  std::stringstream buffer;
  buffer << file.rdbuf();
  const std::string text = buffer.str();
  const Scene scene = sceneOf(text);

  SetTraceLogLevel(LOG_WARNING);
  SetConfigFlags(FLAG_WINDOW_HIDDEN);
  auto started = std::chrono::steady_clock::now();
  InitWindow(scene.width, scene.height, "bench");
  SetTargetFPS(0);
  const double gpuOpenMs = msSince(started);
  started = std::chrono::steady_clock::now();
  RenderTexture2D target = LoadRenderTexture(scene.width, scene.height);
  const double pipelineMs = msSince(started);
  Camera3D camera = {};
  camera.position = {scene.eye[0], scene.eye[1], scene.eye[2]};
  camera.target = {scene.target[0], scene.target[1], scene.target[2]};
  camera.up = {0.0f, 1.0f, 0.0f};
  camera.fovy = scene.fovy;
  camera.projection = CAMERA_PERSPECTIVE;

  long tick = 0;
  auto frame = [&]() {
    BeginTextureMode(target);
    ClearBackground({20, 24, 32, 255});
    BeginMode3D(camera);
    draw(scene, tick);
    EndMode3D();
    EndTextureMode();
    glFinish();
  };
  frame();
  const double firstFrameMs = msSince(processStart);
  std::vector<double> times;
  for (int i = 0; i < scene.frames; i++) {
    started = std::chrono::steady_clock::now();
    tick += 1;
    frame();
    times.push_back(msSince(started));
  }
  std::vector<double> captures;
  for (int i = 0; i < scene.captures; i++) {
    started = std::chrono::steady_clock::now();
    Image image = LoadImageFromTexture(target.texture);
    captures.push_back(msSince(started));
    UnloadImage(image);
  }
  std::sort(times.begin(), times.end());
  std::sort(captures.begin(), captures.end());
  // The scene object is echoed as read: from its opening brace to its closing one.
  std::printf(
      "{\"format\":\"genex-bench/1\",\"stack\":\"raylib-cpp\",\"scene\":%s,\"adapter\":\"%s\",\"frames\":%d,"
      "\"gpuOpenMs\":%.3f,\"pipelineCompileMs\":%.3f,\"firstFrameMs\":%.3f,"
      "\"frameMs\":{\"p50\":%.4f,\"p95\":%.4f,\"max\":%.4f},\"captureMs\":{\"p50\":%.4f,\"p95\":%.4f}}\n",
      text.substr(text.find('{'), text.rfind('}') - text.find('{') + 1).c_str(), "raylib", scene.frames, gpuOpenMs,
      pipelineMs, firstFrameMs, percentile(times, 50), percentile(times, 95), times.empty() ? 0.0 : times.back(),
      percentile(captures, 50), percentile(captures, 95));
  UnloadRenderTexture(target);
  CloseWindow();
  return 0;
}
