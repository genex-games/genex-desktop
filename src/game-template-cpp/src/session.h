// The runtime's state machine: seed, start, pause, step and live frames over the fixed clock, the
// input merge and the rng, with the game reached only through two hooks; and the two meters the
// native ops read (the mixed audio's level, the frame timings). studio.cpp owns the raylib side
// (drawing, the window, the transports); everything here is testable without it. raylib-free.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <vector>

#include "clock.h"
#include "input.h"
#include "json.h"
#include "rng.h"

namespace studio {

/** The seed a game starts on before anyone calls seed(). */
inline constexpr std::uint32_t DEFAULT_SEED = 1;
/** The contract version `ready` and state() report. */
inline constexpr int CONTRACT_VERSION = 1;

/** What step(ms) did. */
struct StepResult {
  int ticks = 0;
  /** The tick count after the step (state().frame). */
  int frame = 0;
  double simulatedMs = 0;
};

/** How the session reaches the game. */
struct SessionHooks {
  /** Rebuild the world from a seed. */
  std::function<void(std::uint32_t seed)> reset;
  /** Run one fixed tick with its merged input. */
  std::function<void(const TickInput& input, int tick)> tick;
};

/** One game's simulation state. */
class Session {
 public:
  explicit Session(SessionHooks hooks, double stepMs = FIXED_STEP_MS);

  /** Reset the world on `value`, pause, clear every held and pending input, and ask for one render. */
  std::uint32_t seed(std::uint32_t value);
  /** Resume live play; answers `running`. */
  bool start();
  /** Freeze live play; answers `running` (false). */
  bool pause();
  bool running() const { return running_; }
  /** Run max(1, round(ms / stepMs)) ticks, whether or not the game is running, and ask for one render. */
  StepResult step(double ms);
  /** Live play: the ticks one rendered frame of `frameMs` is worth (none while paused). */
  int frame(double frameMs);
  /** Apply injected input; answers the keys now held. */
  std::vector<std::string> inject(const Injection& injection);
  /** Real input for the frame about to run. */
  void sample(const FrameSample& sample);
  /** Whether a render is due (after seed, step or a live frame); true once per request. */
  bool takeRender();
  /** Ask for a render (a camera change, a capture). */
  void requestRender() { renderPending_ = true; }

  int tick() const { return tick_; }
  double simulatedMs() const { return tick_ * stepMs_; }
  std::uint32_t seedValue() const { return seed_; }
  double stepMs() const { return stepMs_; }
  Rng& rng() { return rng_; }
  /** Real and injected held keys, canonical and sorted. */
  std::vector<std::string> held() const { return input_.held(); }
  /** The input the last tick ran with. */
  const TickInput& last() const { return last_; }

 private:
  void runTick();

  SessionHooks hooks_;
  double stepMs_;
  FrameClock clock_;
  InputMerger input_;
  Rng rng_;
  TickInput last_;
  std::uint32_t seed_ = DEFAULT_SEED;
  int tick_ = 0;
  bool running_ = false;
  bool renderPending_ = false;
};

/** The parts of state() only the raylib side knows. */
struct StateExtras {
  double fps = 0;
  std::string camera = "default";
  /** The game's own probe leaves; a probe never replaces a runtime key. */
  json::Value probes;
  /** `{items, crosshair, flash}`; null reports an empty HUD. */
  json::Value hud;
  /** `{drawCalls, triangles}` from the runtime's own counter. */
  json::Value render;
  /** Files raylib reported loading (TraceLog FILEIO lines). */
  json::Value assets;
  std::string error;
  json::Value player;
};

/**
 * state(): a superset of the web contract's StudioState (`version, seed, frame, simulatedMs,
 * running, fps, held, pointerLock, hud, camera, error, player`) plus `contractVersion`,
 * `volatile{fps}`, `__render`, `assets`, `checksum` and the game's probes.
 */
json::Value snapshot(const Session& session, const StateExtras& extras);

/** FNV-1a 64 (hex) of the simulation's leaves: the seed, the tick and the probes except `volatile`. */
std::string checksum(std::uint32_t seed, int tick, const json::Value& probes);

/** Stereo frames the audio level is measured over (a power of two: the centroid's FFT size). */
inline constexpr std::size_t AUDIO_WINDOW_FRAMES = 2048;

/** What `audioLevel` answers. */
struct AudioLevel {
  /** Root mean square of every sample in the window: 0 for silence, 1 for a full-scale square wave. */
  double rms = 0;
  /** Spectral centroid of the window's mono mix, in Hz; 0 for silence. */
  double centroid = 0;
};

/**
 * The last AUDIO_WINDOW_FRAMES frames the mixer played. feed() runs on the audio thread and never
 * waits: a block that arrives while level() reads is dropped, which a level reading cannot tell.
 */
class AudioMeter {
 public:
  /** Take `frames` interleaved stereo float frames. */
  void feed(const float* samples, std::size_t frames);
  /** The window's level, the centroid in Hz for a mixer running at `sampleRateHz`. */
  AudioLevel level(double sampleRateHz) const;

 private:
  mutable std::mutex mutex_;
  std::array<float, AUDIO_WINDOW_FRAMES * 2> ring_{};
  std::size_t next_ = 0;
  std::size_t filled_ = 0;
};

/** Frames the timing means are taken over (two seconds at 60 Hz). */
inline constexpr std::size_t TIMING_WINDOW_FRAMES = 120;

/** What `timing` answers: means over the last TIMING_WINDOW_FRAMES, and every frame counted. */
struct Timings {
  double frameMs = 0;
  double updateMs = 0;
  double drawMs = 0;
  long long frames = 0;
};

/** Where each rendered frame's time went, on the game's own clock. */
class FrameTiming {
 public:
  /**
   * One frame: the interval since the last one, the time its ticks took and its drawing took. A
   * frame with no interval yet (the first) passes NaN: counted, not averaged.
   */
  void record(double frameMs, double updateMs, double drawMs);
  Timings timings() const;

 private:
  struct Sample {
    double frameMs = 0;
    double updateMs = 0;
    double drawMs = 0;
  };
  std::array<Sample, TIMING_WINDOW_FRAMES> samples_{};
  std::size_t next_ = 0;
  std::size_t filled_ = 0;
  long long frames_ = 0;
};

}  // namespace studio
