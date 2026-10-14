// The studio runtime declared in studio.h: the window, the world texture, the frame loop, the draw
// counter, the TraceLog capture and the verbs. Everything testable without raylib (the clock, the
// input merge, seed/step, the protocol envelope, the transport, save roots, the meters) lives in
// the raylib-free units. On a native destination a Genex run talks to the studio over fd 3
// (transport.h): `ready` once the first reset ran, requests answered once per frame, captures
// written as files into the run's state folder, and quit or the studio's EOF ending in exit 0.
#include "studio.h"

#include <algorithm>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <memory>
#include <optional>
#include <utility>

#include "clock.h"
#include "digest.h"
#include "frames.h"
#include "paths.h"
#include "platform.h"
#include "protocol.h"
#include "session.h"

#if defined(PLATFORM_WEB)
#include <emscripten/emscripten.h>
#else
#include <exception>
#include <filesystem>

#include "transport.h"
#endif

namespace studio {

namespace {

/** The ops this runtime answers. Wire values shared with the host: never rename one. */
namespace Op {
inline constexpr std::string_view Seed = "seed";
inline constexpr std::string_view Start = "start";
inline constexpr std::string_view Pause = "pause";
inline constexpr std::string_view Step = "step";
inline constexpr std::string_view State = "state";
inline constexpr std::string_view Input = "input";
inline constexpr std::string_view Capture = "capture";
inline constexpr std::string_view DebugCamera = "debugCamera";
inline constexpr std::string_view Cameras = "cameras";
inline constexpr std::string_view Eyes = "eyes";
inline constexpr std::string_view Demos = "demos";
inline constexpr std::string_view Demo = "demo";
inline constexpr std::string_view Audio = "audio";
#if !defined(PLATFORM_WEB)
// The ops only a native run serves.
inline constexpr std::string_view AudioLevel = "audioLevel";
inline constexpr std::string_view Timing = "timing";
inline constexpr std::string_view Quit = "quit";
inline constexpr std::string_view Front = "front";
inline constexpr std::string_view Visible = "visible";
#endif
#if STUDIO_FRAMES
// Live's embedded frames: only a Mac's headless build has the ring (frames.h).
inline constexpr std::string_view Surface = "surface";
inline constexpr std::string_view Release = "release";
#endif
}  // namespace Op

/** Why a verb was refused. Wire values. */
namespace Refusal {
inline constexpr std::string_view UnknownCamera = "unknown-camera";
inline constexpr std::string_view Busy = "busy";
#if !defined(PLATFORM_WEB)
inline constexpr std::string_view NoStateDir = "no-state-dir";
inline constexpr std::string_view CaptureFailed = "capture-failed";
#endif
}  // namespace Refusal

#if !defined(PLATFORM_WEB)
/** Why a native game is about to exit abnormally (`fatal.reason`; a raylib fatal line passes as itself). */
namespace FatalReason {
inline constexpr std::string_view WindowFailed = "window-failed";
inline constexpr std::string_view Terminate = "terminate";
}  // namespace FatalReason
#endif

/** The world texture's side is kept between these, whatever the game asks for. */
constexpr int MIN_WORLD_PX = 64;
constexpr int MAX_WORLD_PX = 4096;
/** Files one run may report having loaded; the rest are counted, not listed. */
constexpr std::size_t MAX_ASSET_CLAIMS = 256;
/** Tags the draw counter keeps apart; later ones are counted as untagged. */
constexpr std::size_t MAX_TAGS = 128;
/** The longest log line kept whole. */
constexpr int LOG_LINE_BYTES = 1024;
/** The value range seed(n) takes, as JavaScript's `n >>> 0` does. */
constexpr double SEED_RANGE = 4294967296.0;
constexpr std::string_view DEFAULT_CAMERA = "default";
constexpr std::string_view UNTAGGED = "untagged";
constexpr std::string_view HUD_TAG = "hud";
/** The fixed-size missing-asset checker: loud on purpose. */
constexpr int MISSING_TEXTURE_PX = 64;
constexpr int MISSING_TEXTURE_CHECKS = 8;
#if !defined(PLATFORM_WEB)
/** The pixel layout of a capture file (`NATIVE_CAPTURE_FORMAT`). Wire value. */
constexpr std::string_view CAPTURE_FORMAT = "bgra8";
// The capture files a native run keeps in its state folder: the host reads each one when its
// answer arrives and never deletes in state/ while the game runs, so the game drops the oldest.
// Eight, not one: a capture still being read is never the one removed.
constexpr std::uint32_t CAPTURES_KEPT = 8;
/** `audioLevel` reports rms to four decimals and the centroid in whole hertz, as the web probe does. */
constexpr double RMS_SCALE = 10000.0;
// The rate the mixer runs at, for the centroid. raylib exposes no getter, so the lane pins raylib's
// device to one rate (AUDIO_DEVICE_SAMPLE_RATE; miniaudio resamples to the hardware) and gives the
// game the same number. Without it every centroid would assume a rate, so the build stops here.
#if !defined(GENEX_AUDIO_RATE_HZ)
#error "Genex: GENEX_AUDIO_RATE_HZ is not defined. The studio's genex.cmake defines it with the rate it gives raylib's mixer; this is a toolchain problem, not the game's code."
#endif
constexpr double MIXER_RATE_HZ = GENEX_AUDIO_RATE_HZ;
/** Timings are reported to a microsecond. */
constexpr double TIMING_SCALE = 1000.0;
#endif

/** Draws and triangles, in total and per tag. */
struct Tally {
  int drawCalls = 0;
  long long triangles = 0;
  std::map<std::string, std::pair<int, long long>, std::less<>> byTag;
};

/** The one running game. */
struct Runtime {
  explicit Runtime(Game from)
      : game(std::move(from)),
        session(SessionHooks{[this](std::uint32_t seed) { onReset(seed); },
                             [this](const TickInput& input, int tick) { onTick(input, tick); }}) {}

  void onReset(std::uint32_t seed) {
    SetRandomSeed(seed);  // InitWindow seeds raylib's own generator from the clock
    if (game.reset) game.reset(static_cast<int>(seed));
  }

  void onTick(const TickInput& input, int tick) {
    if (!game.update) return;
    Ctx ctx{input.keys,
            Vector2{input.look.x, input.look.y},
            input.wheel.y,
            Vector2{input.pointer.x, input.pointer.y},
            input.pointerLock,
            input.pads,
            input.text.c_str(),
            session.rng(),
            static_cast<float>(session.stepMs() / 1000.0),
            tick};
    ticking = true;
    game.update(ctx.dt, ctx);
    ticking = false;
  }

  Game game;
  Session session;
  RenderTexture2D world{};
  std::string cameraName{DEFAULT_CAMERA};
  std::optional<Camera3D> observer;
  std::string currentTag{UNTAGGED};
  Tally tally;
  Tally lastTally;
  FpsMeter fps;
  std::vector<std::string> assets;
  std::size_t assetsUnlisted = 0;
  std::string error;
  /** The save folder, ending in its separator; "" when this destination has none. */
  std::string saveRoot;
  bool muted = false;
  bool rendering = false;
  bool ticking = false;
  /** Whether the first reset has run (the browser's waits for the save folder). */
  bool begun = false;
  protocol::Dispatcher calls;
  /** When the last frame started, on raylib's clock (ms); negative before the first. */
  double lastFrameAt = -1;
  FrameTiming timing;
  platform::GraphicsBackend backend;
#if !defined(PLATFORM_WEB)
  /** The studio's connection: a Genex run on a native destination, else null. */
  std::unique_ptr<transport::Transport> link;
  /** Quit or the studio's EOF ended the loop: exit 0 once the window is closed. */
  bool closing = false;
  /** The last focus sent, once one was. */
  std::optional<bool> focusSent;
  /** The last capture's sequence number. */
  std::uint32_t captures = 0;
#endif
};

std::unique_ptr<Runtime> active;

// ── the frame ──

Rectangle letterbox(const Runtime& rt) {
  auto screenW = static_cast<float>(GetScreenWidth());
  auto screenH = static_cast<float>(GetScreenHeight());
  auto worldW = static_cast<float>(rt.world.texture.width);
  auto worldH = static_cast<float>(rt.world.texture.height);
  float scale = std::min(screenW / worldW, screenH / worldH);
  if (!(scale > 0)) scale = 1;
  return {(screenW - worldW * scale) / 2, (screenH - worldH * scale) / 2, worldW * scale, worldH * scale};
}

Camera3D defaultCamera() {
  Camera3D camera{};
  camera.position = {6.0f, 5.0f, 8.0f};
  camera.target = {0.0f, 1.0f, 0.0f};
  camera.up = {0.0f, 1.0f, 0.0f};
  camera.fovy = 45.0f;
  camera.projection = CAMERA_PERSPECTIVE;
  return camera;
}

Camera3D currentCamera(const Runtime& rt) {
  if (rt.observer) return *rt.observer;
  return rt.game.camera ? rt.game.camera() : defaultCamera();
}

void renderWorld(Runtime& rt) {
  rt.tally = Tally{};
  rt.currentTag = UNTAGGED;
  rt.rendering = true;
  BeginTextureMode(rt.world);
  ClearBackground(rt.game.background);
  if (rt.game.draw) rt.game.draw(currentCamera(rt));
  rt.currentTag = HUD_TAG;
  hud::drawFrame(rt.world.texture.width, rt.world.texture.height);
  EndTextureMode();
  rt.rendering = false;
  rt.lastTally = rt.tally;
  frames::changed();
}

void present(Runtime& rt) {
  const Texture2D& texture = rt.world.texture;
  // A render texture is stored upside down; the negative height flips it back.
  Rectangle source{0, 0, static_cast<float>(texture.width), -static_cast<float>(texture.height)};
  BeginDrawing();
  ClearBackground(BLACK);
  DrawTexturePro(texture, source, letterbox(rt), Vector2{0, 0}, 0, WHITE);
  EndDrawing();
  // An embedded run copies what was just presented into Live's ring.
  frames::present(GetScreenWidth(), GetScreenHeight());
}

/** Draw the frame now, and show it where it can be shown: a verb answered between frames needs it on screen. */
void renderNow(Runtime& rt) {
  if (rt.rendering) return;
  renderWorld(rt);
  if (platform::canPresent()) present(rt);
  (void)rt.session.takeRender();
}

/** Whether this frame presents: when it changed or the destination presents every frame, if it can be shown. */
bool presentsFrame(bool due, bool resized) {
  bool wanted = due || resized || platform::presentsEveryFrame();
  return wanted && platform::canPresent();
}

/** The identity the game's saves go under. */
paths::GameIdentity identity(const Runtime& rt) {
  return paths::identityOf(rt.game.saveName ? rt.game.saveName : "", platform::runningBundleId());
}

// ── the studio's native connection ──

#if !defined(PLATFORM_WEB)

/** Send one event line, when the studio is listening. */
void sendEvent(Runtime& rt, std::string_view name, const json::Value& fields) {
  if (rt.link) rt.link->send(protocol::event(name, fields));
}

/** Tell the studio the game is about to exit abnormally. */
void sendFatal(Runtime& rt, std::string_view reason) {
  json::Value fields = json::Value::object();
  fields.set("reason", reason);
  sendEvent(rt, protocol::Event::Fatal, fields);
}

/** `ready`: the nonce the studio passed, the protocol, what the build is and draws on, the frame and the seed. */
void sendReady(Runtime& rt) {
  if (!rt.link) return;
  json::Value backend = json::Value::object();
  backend.set("api", rt.backend.api);
  backend.set("device", rt.backend.device.empty() ? json::Value() : json::Value(rt.backend.device));
  json::Value size = json::Value::object();
  size.set("width", rt.world.texture.width);
  size.set("height", rt.world.texture.height);
  json::Value fields = json::Value::object();
  fields.set("nonce", rt.link->nonce());
  fields.set("protocol", protocol::PROTOCOL_VERSION);
  fields.set("contractVersion", CONTRACT_VERSION);
  fields.set("build", platform::buildName());
  fields.set("backend", std::move(backend));
  fields.set("size", std::move(size));
  fields.set("seed", rt.session.seedValue());
  sendEvent(rt, protocol::Event::Ready, fields);
}

/** One `focus` event per change of the window's focus, the first frame's included. */
void reportFocus(Runtime& rt) {
  if (!rt.link || !platform::hasWindow()) return;
  bool focused = platform::focused();
  if (rt.focusSent == focused) return;
  rt.focusSent = focused;
  json::Value fields = json::Value::object();
  fields.set("focused", focused);
  sendEvent(rt, protocol::Event::Focus, fields);
}

/** Answer what the studio sent since the last frame; its EOF ends the game. */
void serveStudio(Runtime& rt) {
  if (!rt.link) return;
  transport::Served served = transport::serve(*rt.link, rt.calls);
  if (!served.ended) return;
  rt.closing = true;
  platform::requestQuit();
}

/**
 * Hold an unpaced loop to 60 Hz, waking at once for the studio's next request. An embedded run
 * sleeps the frame out instead: Live gives a slot back every frame, and each `release` must not
 * start the next frame early.
 */
void paceFrame(Runtime& rt, double frameStartMs) {
  if (!rt.link || frames::active()) {
    platform::pace(frameStartMs, nullptr);
    return;
  }
  transport::Transport& link = *rt.link;
  platform::pace(frameStartMs, [&link](double ms) { link.wait(ms); });
}

#endif

/** The first reset, then live play; the page (or the studio) learns the game is up only now. */
void begin(Runtime& rt) {
  rt.begun = true;
  rt.session.seed(DEFAULT_SEED);
  rt.session.start();  // the game runs from the moment it loads; seed() pauses it for judging
  platform::announceReady();
#if !defined(PLATFORM_WEB)
  sendReady(rt);
#endif
}

/** The interval since the last frame started, in ms (NaN for the first frame). */
double frameInterval(Runtime& rt, double startMs) {
  double interval = rt.lastFrameAt < 0 ? NAN : startMs - rt.lastFrameAt;
  rt.lastFrameAt = startMs;
  return interval;
}

void frame() {
  Runtime& rt = *active;
  if (!rt.begun) {
    if (!platform::savesReady()) return;  // the browser is still reading the save folder back
    begin(rt);
  }
  double startMs = GetTime() * 1000.0;
  double intervalMs = frameInterval(rt, startMs);
#if !defined(PLATFORM_WEB)
  serveStudio(rt);
  reportFocus(rt);
#endif
  rt.fps.frame(startMs);
  bool resized = platform::followSlot();
  rt.session.sample(platform::sampleInput(letterbox(rt)));
  double tickedFromMs = GetTime() * 1000.0;
  rt.session.frame(std::isfinite(intervalMs) ? intervalMs : 0.0);
  double tickedMs = GetTime() * 1000.0;
  bool due = rt.session.takeRender();
  if (due) renderWorld(rt);
  if (presentsFrame(due, resized)) {
    present(rt);
  } else {
    PollInputEvents();  // EndDrawing polls; a frame that presents nothing must still roll the input state
  }
  rt.timing.record(intervalMs, tickedMs - tickedFromMs, GetTime() * 1000.0 - tickedMs);
#if !defined(PLATFORM_WEB)
  paceFrame(rt, startMs);
#endif
}

// ── the draw counter ──

void count(long long triangles) {
  if (!active) return;
  Tally& tally = active->tally;
  ++tally.drawCalls;
  tally.triangles += triangles;
  bool known = tally.byTag.find(active->currentTag) != tally.byTag.end();
  std::string key = known || tally.byTag.size() < MAX_TAGS ? active->currentTag : std::string(UNTAGGED);
  auto& slot = tally.byTag[key];
  ++slot.first;
  slot.second += triangles;
}

void countModel(const Model& model) {
  for (int i = 0; i < model.meshCount; ++i) count(model.meshes[i].triangleCount);
}

json::Value tallyJson(const Tally& tally) {
  json::Value tags = json::Value::object();
  for (const auto& [name, slot] : tally.byTag) {
    json::Value entry = json::Value::object();
    entry.set("drawCalls", slot.first);
    entry.set("triangles", slot.second);
    tags.set(name, std::move(entry));
  }
  json::Value render = json::Value::object();
  render.set("drawCalls", tally.drawCalls);
  render.set("triangles", tally.triangles);
  render.set("tags", std::move(tags));
  // Only draws made through studio::draw* are counted; on the web the page's GL counters replace these.
  render.set("exact", false);
  return render;
}

// ── TraceLog capture ──

void claimAsset(std::string_view path) {
  if (!active) return;
  Runtime& rt = *active;
  std::string claim = paths::assetClaim(path, platform::assetRoot());
  if (std::find(rt.assets.begin(), rt.assets.end(), claim) != rt.assets.end()) return;
  if (rt.assets.size() < MAX_ASSET_CLAIMS) {
    rt.assets.emplace_back(std::move(claim));
  } else {
    ++rt.assetsUnlisted;
  }
}

const char* levelName(int level) {
  switch (level) {
    case LOG_DEBUG:
      return "DEBUG";
    case LOG_WARNING:
      return "WARNING";
    case LOG_ERROR:
      return "ERROR";
    case LOG_FATAL:
      return "FATAL";
    default:
      return "INFO";
  }
}

void onTraceLog(int level, const char* text, va_list args) {
  char line[LOG_LINE_BYTES];
  std::vsnprintf(line, sizeof line, text ? text : "", args);
  std::fprintf(level >= LOG_WARNING ? stderr : stdout, "%s: %s\n", levelName(level), line);
  if (active) {
    std::string_view file = paths::claimedFile(level == LOG_INFO, line, active->saveRoot);
    if (!file.empty()) claimAsset(file);
    if (level >= LOG_ERROR) active->error = line;
  }
#if !defined(PLATFORM_WEB)
  // raylib ends the process on a fatal line when no callback is set; a native game keeps that, and says why first.
  if (level == LOG_FATAL) {
    if (active) sendFatal(*active, line);
    std::exit(EXIT_FAILURE);
  }
#endif
}

// ── the verbs ──

/** `n` as JavaScript's `n >>> 0` reads it: truncated, wrapped into 0..2^32-1; NaN and infinities are 0. */
std::uint32_t seedOf(double n) {
  if (!std::isfinite(n)) return 0;
  double wrapped = std::fmod(std::trunc(n), SEED_RANGE);
  if (wrapped < 0) wrapped += SEED_RANGE;
  return static_cast<std::uint32_t>(wrapped);
}

/** An argument given as `{key: value}` or as the bare value. */
const json::Value& argument(const json::Value& arg, std::string_view key) {
  return arg.is(json::Kind::Object) ? arg[key] : arg;
}

std::optional<Camera3D> findCamera(const Runtime& rt, std::string_view name) {
  for (const NamedCamera& camera : rt.game.cameras) {
    if (camera.name == name && camera.place) return camera.place();
  }
  for (const Eye& eye : rt.game.eyes) {
    if (eye.name == name && eye.place) return eye.place();
  }
  return std::nullopt;
}

json::Value cameraNames(const Runtime& rt) {
  json::Value names = json::Value::array();
  names.push(DEFAULT_CAMERA);
  for (const NamedCamera& camera : rt.game.cameras) names.push(camera.name);
  return names;
}

json::Value eyeNames(const Runtime& rt) {
  json::Value names = json::Value::array();
  for (const Eye& eye : rt.game.eyes) names.push(eye.name);
  return names;
}

json::Value demoNames(const Runtime& rt) {
  json::Value names = json::Value::array();
  for (const Demo& demo : rt.game.demos) names.push(demo.name);
  return names;
}

json::Value unavailable(json::Value available) {
  json::Value result = json::Value::object();
  result.set("ok", false);
  result.set("available", std::move(available));
  return result;
}

/** Place a named camera ("default" gives the view back to the game); false when there is none by that name. */
bool placeCamera(Runtime& rt, std::string_view name) {
  if (name.empty() || name == DEFAULT_CAMERA) {
    rt.observer.reset();
    rt.cameraName = DEFAULT_CAMERA;
    return true;
  }
  std::optional<Camera3D> camera = findCamera(rt, name);
  if (!camera) return false;
  rt.observer = camera;
  rt.cameraName = name;
  return true;
}

json::Value stepResult(Runtime& rt, const StepResult& step) {
  json::Value result = json::Value::object();
  result.set("frame", step.frame);
  result.set("simulatedMs", step.simulatedMs);
  result.set("steppedFrames", step.ticks);
  result.set("drawCalls", rt.lastTally.drawCalls);
  return result;
}

json::Value stateOf(Runtime& rt) {
  StateExtras extras;
  extras.fps = rt.fps.fps();
  extras.camera = rt.cameraName;
  extras.probes = rt.game.probes ? rt.game.probes() : json::Value::object();
  extras.player = rt.game.player ? rt.game.player() : json::Value();
  extras.hud = hud::summary();
  extras.render = tallyJson(rt.lastTally);
  json::Value assets = json::Value::array();
  for (const std::string& path : rt.assets) assets.push(path);
  extras.assets = std::move(assets);
  extras.error = rt.error;
  return snapshot(rt.session, extras);
}

protocol::Answer seedVerb(Runtime& rt, const json::Value& arg) {
  if (rt.ticking) return protocol::refuse(Refusal::Busy);
  std::uint32_t seed = seedOf(argument(arg, "seed").asNumber(0));
  hud::reset();
  rt.fps.reset();
  rt.session.seed(seed);
  renderNow(rt);
  json::Value result = json::Value::object();
  result.set("seed", seed);
  result.set("paused", true);
  return protocol::answer(std::move(result));
}

protocol::Answer runningVerb(Runtime& rt, bool run) {
  json::Value result = json::Value::object();
  result.set("running", run ? rt.session.start() : rt.session.pause());
  return protocol::answer(std::move(result));
}

protocol::Answer stepVerb(Runtime& rt, const json::Value& arg) {
  if (rt.ticking || rt.rendering) return protocol::refuse(Refusal::Busy);
  StepResult step = rt.session.step(argument(arg, "ms").asNumber(rt.session.stepMs()));
  renderNow(rt);
  return protocol::answer(stepResult(rt, step));
}

protocol::Answer inputVerb(Runtime& rt, const json::Value& arg) {
  // Live gives an embedded run's positions in ring pixels; everywhere else they pass as they are.
  Injection injection = parseInjection(frames::input(arg, GetScreenWidth(), GetScreenHeight()));
  json::Value held = json::Value::array();
  for (const std::string& key : rt.session.inject(injection)) held.push(key);
  json::Value result = json::Value::object();
  result.set("held", std::move(held));
  result.set("ignored", injection.ignored);
  return protocol::answer(std::move(result));
}

protocol::Answer debugCameraVerb(Runtime& rt, const json::Value& arg) {
  std::string name = argument(arg, "camera").asString();
  if (!placeCamera(rt, name)) return protocol::answer(unavailable(cameraNames(rt)));
  renderNow(rt);
  json::Value result = json::Value::object();
  result.set("ok", true);
  result.set("camera", rt.cameraName);
  return protocol::answer(std::move(result));
}

#if !defined(PLATFORM_WEB)

/** A colour channel as the window shows it: composited over the black the world texture is drawn on. */
unsigned char overBlack(unsigned char channel, unsigned char alpha) {
  return static_cast<unsigned char>((channel * alpha + 127) / 255);
}

/**
 * The world texture's pixels as the window shows them, for the host: BGRA, top row first, opaque.
 * `image` is what LoadImageFromTexture reads back: RGBA rows bottom-up, as glReadPixels gives them.
 */
std::vector<unsigned char> windowPixels(const Image& image) {
  auto width = static_cast<std::size_t>(image.width);
  auto height = static_cast<std::size_t>(image.height);
  const auto* rgba = static_cast<const unsigned char*>(image.data);
  std::vector<unsigned char> bgra(width * height * 4);
  for (std::size_t row = 0; row < height; ++row) {
    const unsigned char* from = rgba + (height - 1 - row) * width * 4;
    unsigned char* to = bgra.data() + row * width * 4;
    for (std::size_t x = 0; x < width; ++x, from += 4, to += 4) {
      to[0] = overBlack(from[2], from[3]);
      to[1] = overBlack(from[1], from[3]);
      to[2] = overBlack(from[0], from[3]);
      to[3] = 255;
    }
  }
  return bgra;
}

bool writeBytes(const std::string& path, const std::vector<unsigned char>& bytes) {
  std::FILE* file = std::fopen(path.c_str(), "wb");
  if (!file) return false;
  bool whole = std::fwrite(bytes.data(), 1, bytes.size(), file) == bytes.size();
  return std::fclose(file) == 0 && whole;
}

/** Read the frame just drawn back into `<state>/captures/<seq>.bgra`; add its seq, size, format and digest. */
protocol::Answer captureFile(Runtime& rt, json::Value result) {
  std::string folder = paths::captureFolder(rt.saveRoot);
  if (folder.empty()) return protocol::refuse(Refusal::NoStateDir);
  Image image = LoadImageFromTexture(rt.world.texture);
  bool sized = image.width > 0 && image.height > 0;
  bool readable = image.data && image.format == PIXELFORMAT_UNCOMPRESSED_R8G8B8A8 && sized;
  std::vector<unsigned char> bgra = readable ? windowPixels(image) : std::vector<unsigned char>();
  int width = image.width;
  int height = image.height;
  UnloadImage(image);
  std::error_code folderError;
  std::filesystem::create_directories(folder, folderError);
  std::uint32_t seq = rt.captures + 1;
  bool written = readable && !folderError && writeBytes(paths::capturePath(rt.saveRoot, seq), bgra);
  if (!written) return protocol::refuse(Refusal::CaptureFailed);
  rt.captures = seq;
  if (seq > CAPTURES_KEPT) {
    std::error_code ignored;
    std::filesystem::remove(paths::capturePath(rt.saveRoot, seq - CAPTURES_KEPT), ignored);
  }
  result.set("seq", seq);
  result.set("width", width);
  result.set("height", height);
  result.set("format", CAPTURE_FORMAT);
  result.set("digest", hex64(fnv1a64(bgra.data(), bgra.size())));
  return protocol::answer(std::move(result));
}

#endif

/**
 * Draw the frame (from `camera` when one is named) and describe it: the web shell then reads the
 * canvas, and a native Genex run writes the capture file.
 */
protocol::Answer captureVerb(Runtime& rt, const json::Value& arg) {
  const json::Value& camera = argument(arg, "camera");
  if (camera.is(json::Kind::String) && !placeCamera(rt, camera.asString())) {
    return protocol::refuse(Refusal::UnknownCamera);
  }
  renderNow(rt);
  json::Value result = json::Value::object();
  result.set("width", rt.world.texture.width);
  result.set("height", rt.world.texture.height);
  result.set("camera", rt.cameraName);
  result.set("drawCalls", rt.lastTally.drawCalls);
#if !defined(PLATFORM_WEB)
  if (rt.link) return captureFile(rt, std::move(result));
#endif
  return protocol::answer(std::move(result));
}

protocol::Answer demoVerb(Runtime& rt, const json::Value& arg) {
  std::string name = argument(arg, "name").asString();
  auto demo = std::find_if(rt.game.demos.begin(), rt.game.demos.end(), [&](const Demo& d) { return d.name == name; });
  if (demo == rt.game.demos.end()) return protocol::answer(unavailable(demoNames(rt)));
  rt.session.pause();
  json::Value outcome = demo->run ? demo->run() : json::Value();
  rt.session.pause();  // a demo ends paused, whatever it did
  renderNow(rt);
  json::Value result = json::Value::object();
  result.set("ok", true);
  result.set("demo", name);
  result.set("result", std::move(outcome));
  return protocol::answer(std::move(result));
}

protocol::Answer audioVerb(Runtime& rt, const json::Value& arg) {
  rt.muted = argument(arg, "muted").asBool(rt.muted);
  SetMasterVolume(rt.muted ? 0.0f : 1.0f);
  json::Value result = json::Value::object();
  result.set("muted", rt.muted);
  return protocol::answer(std::move(result));
}

protocol::Answer listVerb(std::string_view key, json::Value names) {
  json::Value result = json::Value::object();
  result.set(std::string(key), std::move(names));
  return protocol::answer(std::move(result));
}

#if !defined(PLATFORM_WEB)

/** What the mixer played last, fed from the audio thread. */
AudioMeter& mixed() {
  static AudioMeter meter;
  return meter;
}

/** raylib's mixed processor: the whole pipeline's output, interleaved stereo floats. */
void onMixed(void* buffer, unsigned int frames) { mixed().feed(static_cast<const float*>(buffer), frames); }

protocol::Answer audioLevelVerb() {
  AudioLevel level = mixed().level(MIXER_RATE_HZ);
  json::Value result = json::Value::object();
  result.set("rms", std::round(level.rms * RMS_SCALE) / RMS_SCALE);
  result.set("centroid", std::round(level.centroid));
  return protocol::answer(std::move(result));
}

double milliseconds(double value) { return std::round(value * TIMING_SCALE) / TIMING_SCALE; }

protocol::Answer timingVerb(const Runtime& rt) {
  Timings timings = rt.timing.timings();
  json::Value result = json::Value::object();
  result.set("frameMs", milliseconds(timings.frameMs));
  result.set("updateMs", milliseconds(timings.updateMs));
  result.set("drawMs", milliseconds(timings.drawMs));
  result.set("frames", timings.frames);
  return protocol::answer(std::move(result));
}

/** Answer, then end the loop after this frame; the process exits 0 once the window is closed. */
protocol::Answer quitVerb(Runtime& rt) {
  rt.closing = true;
  platform::requestQuit();
  json::Value result = json::Value::object();
  result.set("quitting", true);
  return protocol::answer(std::move(result));
}

protocol::Answer frontVerb() {
  json::Value result = json::Value::object();
  result.set("fronted", platform::front());
  return protocol::answer(std::move(result));
}

protocol::Answer visibleVerb(const json::Value& arg) {
  json::Value result = json::Value::object();
  result.set("visible", platform::setVisible(argument(arg, "visible").asBool(true)));
  return protocol::answer(std::move(result));
}

/** The ops only a native run serves: the studio's process and window controls and its meters. */
void registerNativeVerbs(Runtime& rt) {
  protocol::Dispatcher& calls = rt.calls;
  calls.on(std::string(Op::AudioLevel), [](const json::Value&) { return audioLevelVerb(); });
  calls.on(std::string(Op::Timing), [&rt](const json::Value&) { return timingVerb(rt); });
  calls.on(std::string(Op::Quit), [&rt](const json::Value&) { return quitVerb(rt); });
  calls.on(std::string(Op::Front), [](const json::Value&) { return frontVerb(); });
  calls.on(std::string(Op::Visible), [](const json::Value& arg) { return visibleVerb(arg); });
#if STUDIO_FRAMES
  calls.on(std::string(Op::Surface), [](const json::Value& arg) { return frames::surface(arg); });
  calls.on(std::string(Op::Release), [](const json::Value& arg) { return frames::release(arg); });
#endif
}

#endif

void registerVerbs(Runtime& rt) {
  protocol::Dispatcher& calls = rt.calls;
  calls.on(std::string(Op::Seed), [&rt](const json::Value& arg) { return seedVerb(rt, arg); });
  calls.on(std::string(Op::Start), [&rt](const json::Value&) { return runningVerb(rt, true); });
  calls.on(std::string(Op::Pause), [&rt](const json::Value&) { return runningVerb(rt, false); });
  calls.on(std::string(Op::Step), [&rt](const json::Value& arg) { return stepVerb(rt, arg); });
  calls.on(std::string(Op::State), [&rt](const json::Value&) { return protocol::answer(stateOf(rt)); });
  calls.on(std::string(Op::Input), [&rt](const json::Value& arg) { return inputVerb(rt, arg); });
  calls.on(std::string(Op::Capture), [&rt](const json::Value& arg) { return captureVerb(rt, arg); });
  calls.on(std::string(Op::DebugCamera), [&rt](const json::Value& arg) { return debugCameraVerb(rt, arg); });
  calls.on(std::string(Op::Cameras), [&rt](const json::Value&) { return listVerb("cameras", cameraNames(rt)); });
  calls.on(std::string(Op::Eyes), [&rt](const json::Value&) { return listVerb("eyes", eyeNames(rt)); });
  calls.on(std::string(Op::Demos), [&rt](const json::Value&) { return listVerb("demos", demoNames(rt)); });
  calls.on(std::string(Op::Demo), [&rt](const json::Value& arg) { return demoVerb(rt, arg); });
  calls.on(std::string(Op::Audio), [&rt](const json::Value& arg) { return audioVerb(rt, arg); });
#if !defined(PLATFORM_WEB)
  registerNativeVerbs(rt);
#endif
}

// ── assets ──

Texture2D missingTexture() {
  Image image = GenImageChecked(MISSING_TEXTURE_PX, MISSING_TEXTURE_PX, MISSING_TEXTURE_CHECKS, MISSING_TEXTURE_CHECKS,
                                MAGENTA, BLACK);
  Texture2D texture = LoadTextureFromImage(image);
  UnloadImage(image);
  return texture;
}

/** The file behind assets/<rel>, or "" (with a warning) when it is unsafe or absent. */
std::string existingAsset(const char* rel) {
  std::string path = platform::assetPath(rel ? rel : "");
  if (!path.empty() && FileExists(path.c_str())) return path;
  TraceLog(LOG_WARNING, "STUDIO: assets/%s is not a file the game may load", rel ? rel : "");
  return {};
}

int worldSide(float requested) {
  float rounded = std::isfinite(requested) ? std::round(requested) : 0.0f;
  return std::clamp(static_cast<int>(rounded), MIN_WORLD_PX, MAX_WORLD_PX);
}

// ── starting and ending ──

#if !defined(PLATFORM_WEB)

/** An uncaught exception or other terminate: tell the studio, then end as terminate would. */
[[noreturn]] void onTerminate() {
  if (active) sendFatal(*active, FatalReason::Terminate);
  std::abort();
}

/** Open the studio's connection when the studio started this game (a Genex run). */
void connectStudio(Runtime& rt) {
  rt.link = transport::fromEnvironment(paths::processEnv());
  if (rt.link) std::set_terminate(onTerminate);
}

/** A window that did not open: no game can run, so say why and stop. */
void requireWindow(Runtime& rt) {
  if (IsWindowReady()) return;
  sendFatal(rt, FatalReason::WindowFailed);
  std::exit(EXIT_FAILURE);
}

#endif

/** The window, the mixer and the world texture, and what the studio learns about them. */
void openWindow(Runtime& rt) {
  SetConfigFlags(platform::windowFlags());
  platform::chooseWindowSystem();
  Vector2 screen = platform::initialScreenSize(rt.game.worldSize);
  InitWindow(static_cast<int>(screen.x), static_cast<int>(screen.y), rt.game.title);
#if !defined(PLATFORM_WEB)
  requireWindow(rt);
#endif
  SetExitKey(KEY_NULL);
  InitAudioDevice();
#if !defined(PLATFORM_WEB)
  AttachAudioMixedProcessor(onMixed);
#endif
  rt.world = LoadRenderTexture(worldSide(rt.game.worldSize.x), worldSide(rt.game.worldSize.y));
  SetTextureFilter(rt.world.texture, TEXTURE_FILTER_BILINEAR);
  rt.backend = platform::graphicsBackend();
  hud::cpuFallback(rt.backend.software);
}

/** A native window closed (the web never gets here): free it all; a run the studio ended exits 0. */
void shutDown(Runtime& rt) {
  UnloadRenderTexture(rt.world);
#if !defined(PLATFORM_WEB)
  DetachAudioMixedProcessor(onMixed);
  bool ended = rt.closing;
#endif
  CloseAudioDevice();
  frames::close();  // its GL objects need the context CloseWindow ends
  CloseWindow();
  active.reset();  // a transport stops its reader here
#if !defined(PLATFORM_WEB)
  if (ended) std::exit(EXIT_SUCCESS);
#endif
}

}  // namespace

void install(Game game) {
  if (active) {
    TraceLog(LOG_WARNING, "STUDIO: install() was called twice; the first game keeps running");
    return;
  }
  active = std::make_unique<Runtime>(std::move(game));
  Runtime& rt = *active;
  SetTraceLogCallback(onTraceLog);  // before InitWindow, so the backend and file lines are captured too
#if !defined(PLATFORM_WEB)
  connectStudio(rt);  // before InitWindow, so a window that fails can still be reported
#endif
  platform::prepareSaves();  // before the first reset, which may load the game's progress
  paths::SaveRoot saves = platform::saveRoot(identity(rt));
  rt.saveRoot = saves.path;
  if (!saves.ok()) TraceLog(LOG_WARNING, "STUDIO: no save folder here: studio::save() refuses until the build names the game");
  openWindow(rt);
  registerVerbs(rt);
  hud::reset();
  if (platform::savesReady()) begin(rt);  // else the first frame after the read-back does
  platform::run(frame);
  shutDown(rt);
}

void tag(const char* name) {
  if (!active) return;
  active->currentTag = name && *name ? name : std::string(UNTAGGED);
}

void drawModel(Model model, Vector3 position, float scale, Color tint) {
  countModel(model);
  DrawModel(model, position, scale, tint);
}

void drawModelEx(Model model, Vector3 position, Vector3 axis, float angle, Vector3 scale, Color tint) {
  countModel(model);
  DrawModelEx(model, position, axis, angle, scale, tint);
}

void drawMesh(Mesh mesh, Material material, Matrix transform) {
  count(mesh.triangleCount);
  DrawMesh(mesh, material, transform);
}

// The runtime claims what it loaded itself, so `state().assets` holds them even when the game
// turned raylib's informational log lines off.

Texture2D asset(const char* rel) {
  std::string path = existingAsset(rel);
  if (path.empty()) return missingTexture();
  Texture2D texture = LoadTexture(path.c_str());
  if (texture.id == 0) return missingTexture();
  claimAsset(path);
  GenTextureMipmaps(&texture);
  SetTextureFilter(texture, TEXTURE_FILTER_TRILINEAR);
  return texture;
}

Model assetModel(const char* rel) {
  std::string path = existingAsset(rel);
  if (!path.empty()) {
    Model model = LoadModel(path.c_str());
    if (model.meshCount > 0) claimAsset(path);
    return model;
  }
  Model missing = LoadModelFromMesh(GenMeshCube(1.0f, 1.0f, 1.0f));
  missing.materials[0].maps[MATERIAL_MAP_DIFFUSE].texture = missingTexture();
  return missing;
}

Sound assetSound(const char* rel) {
  std::string path = existingAsset(rel);
  if (path.empty()) return Sound{};
  Sound sound = LoadSound(path.c_str());
  if (IsSoundValid(sound)) claimAsset(path);
  return sound;
}

Shader shader(const char* vertex, const char* fragment) { return platform::loadShader(vertex, fragment); }

bool save(const char* file, const void* data, int size) {
  if (!active || !file || (!data && size > 0)) return false;
  return platform::saveFile(identity(*active), file, data, size);
}

std::string load(const char* file) {
  if (!active || !file) return {};
  return platform::loadFile(identity(*active), file).value_or(std::string());
}

json::Value advance(double ms) {
  if (!active || active->ticking || active->rendering) {
    TraceLog(LOG_WARNING, "STUDIO: advance() belongs in a demo, not inside update() or draw()");
    return json::Value();
  }
  StepResult step = active->session.step(ms);
  renderNow(*active);
  return stepResult(*active, step);
}

void inject(const Injection& input) {
  if (active) active->session.inject(input);
}

}  // namespace studio

#if defined(PLATFORM_WEB)
namespace {

/** One web verb: the reply envelope as text, valid until the next call (ccall copies it at once). */
const char* webCall(std::string_view op, const char* argText) {
  static std::string reply;
  if (!studio::active) {
    reply = R"({"id":null,"ok":false,"op":null,"error":"not-installed"})";
    return reply.c_str();
  }
  if (!studio::active->begun) {
    reply = R"({"id":null,"ok":false,"op":null,"error":"starting"})";
    return reply.c_str();
  }
  json::Parsed parsed = json::parse(argText ? argText : "null");
  reply = studio::active->calls.call(op, parsed.ok() ? parsed.value : json::Value());
  return reply.c_str();
}

}  // namespace

// The web transport: web/shell.html wraps each of these into the same-named window.__studio verb.
extern "C" {
EMSCRIPTEN_KEEPALIVE const char* studio_seed(const char* arg) { return webCall(studio::Op::Seed, arg); }
EMSCRIPTEN_KEEPALIVE const char* studio_start(const char* arg) { return webCall(studio::Op::Start, arg); }
EMSCRIPTEN_KEEPALIVE const char* studio_pause(const char* arg) { return webCall(studio::Op::Pause, arg); }
EMSCRIPTEN_KEEPALIVE const char* studio_step(const char* arg) { return webCall(studio::Op::Step, arg); }
EMSCRIPTEN_KEEPALIVE const char* studio_state(const char* arg) { return webCall(studio::Op::State, arg); }
EMSCRIPTEN_KEEPALIVE const char* studio_input(const char* arg) { return webCall(studio::Op::Input, arg); }
EMSCRIPTEN_KEEPALIVE const char* studio_capture(const char* arg) { return webCall(studio::Op::Capture, arg); }
EMSCRIPTEN_KEEPALIVE const char* studio_debug_camera(const char* arg) {
  return webCall(studio::Op::DebugCamera, arg);
}
EMSCRIPTEN_KEEPALIVE const char* studio_cameras(const char* arg) { return webCall(studio::Op::Cameras, arg); }
EMSCRIPTEN_KEEPALIVE const char* studio_eyes(const char* arg) { return webCall(studio::Op::Eyes, arg); }
EMSCRIPTEN_KEEPALIVE const char* studio_demos(const char* arg) { return webCall(studio::Op::Demos, arg); }
EMSCRIPTEN_KEEPALIVE const char* studio_demo(const char* arg) { return webCall(studio::Op::Demo, arg); }
EMSCRIPTEN_KEEPALIVE const char* studio_audio(const char* arg) { return webCall(studio::Op::Audio, arg); }
}
#endif
