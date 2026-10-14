// The state machine declared in session.h. raylib-free.
#include "session.h"

#include <algorithm>
#include <cmath>
#include <complex>
#include <utility>

#include "digest.h"

namespace studio {

namespace {

/** The probe key a game uses for values that differ between runs (timings); comparisons skip it. */
constexpr std::string_view VOLATILE_KEY = "volatile";

json::Value emptyHud() {
  json::Value hud = json::Value::object();
  hud.set("items", json::Value::array());
  hud.set("crosshair", false);
  hud.set("flash", 0);
  return hud;
}

json::Value noDraws() {
  json::Value render = json::Value::object();
  render.set("drawCalls", 0);
  render.set("triangles", 0);
  return render;
}

constexpr double PI = 3.14159265358979323846;

/**
 * A mixed sample as the device plays it: clipped to full scale, and anything not finite (a broken
 * effect's output) as silence, so the level is always a finite number.
 */
double finiteSample(float sample) {
  return std::isfinite(sample) ? std::clamp(static_cast<double>(sample), -1.0, 1.0) : 0.0;
}

/** In-place radix-2 FFT; `values.size()` is a power of two. */
void fft(std::vector<std::complex<double>>& values) {
  std::size_t n = values.size();
  for (std::size_t i = 1, j = 0; i < n; ++i) {
    std::size_t bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) std::swap(values[i], values[j]);
  }
  for (std::size_t length = 2; length <= n; length <<= 1) {
    std::complex<double> step = std::polar(1.0, -2 * PI / static_cast<double>(length));
    for (std::size_t start = 0; start < n; start += length) {
      std::complex<double> turn(1.0, 0.0);
      for (std::size_t k = 0; k < length / 2; ++k) {
        std::complex<double> even = values[start + k];
        std::complex<double> odd = values[start + k + length / 2] * turn;
        values[start + k] = even + odd;
        values[start + k + length / 2] = even - odd;
        turn *= step;
      }
    }
  }
}

/** The magnitude-weighted mean frequency of `mono` (Hann-windowed, zero-padded to the window). */
double centroidOf(const std::vector<double>& mono, double sampleRateHz) {
  std::vector<std::complex<double>> bins(AUDIO_WINDOW_FRAMES);
  for (std::size_t i = 0; i < mono.size(); ++i) {
    double hann = 0.5 - 0.5 * std::cos(2 * PI * static_cast<double>(i) / static_cast<double>(mono.size()));
    bins[i] = mono[i] * hann;
  }
  fft(bins);
  double weighted = 0;
  double total = 0;
  for (std::size_t k = 1; k <= AUDIO_WINDOW_FRAMES / 2; ++k) {
    double magnitude = std::abs(bins[k]);
    weighted += magnitude * static_cast<double>(k) * sampleRateHz / static_cast<double>(AUDIO_WINDOW_FRAMES);
    total += magnitude;
  }
  return total > 0 ? weighted / total : 0;
}

}  // namespace

Session::Session(SessionHooks hooks, double stepMs) : hooks_(std::move(hooks)), stepMs_(stepMs), clock_(stepMs) {}

std::uint32_t Session::seed(std::uint32_t value) {
  seed_ = value;
  rng_.reseed(value);
  tick_ = 0;
  clock_.reset();
  input_.clear();
  last_ = TickInput();
  running_ = false;
  if (hooks_.reset) hooks_.reset(value);
  renderPending_ = true;
  return value;
}

bool Session::start() {
  running_ = true;
  clock_.reset();
  return running_;
}

bool Session::pause() {
  running_ = false;
  return running_;
}

void Session::runTick() {
  last_ = input_.next();
  if (hooks_.tick) hooks_.tick(last_, tick_);
  ++tick_;
}

StepResult Session::step(double ms) {
  int ticks = stepTicks(ms, stepMs_);
  for (int i = 0; i < ticks; ++i) runTick();
  renderPending_ = true;
  return {ticks, tick_, simulatedMs()};
}

int Session::frame(double frameMs) {
  if (!running_) return 0;
  int ticks = clock_.advance(frameMs);
  for (int i = 0; i < ticks; ++i) runTick();
  renderPending_ = true;
  return ticks;
}

std::vector<std::string> Session::inject(const Injection& injection) {
  input_.inject(injection);
  return input_.held();
}

void Session::sample(const FrameSample& sample) { input_.sample(sample); }

bool Session::takeRender() {
  bool due = renderPending_;
  renderPending_ = false;
  return due;
}

void AudioMeter::feed(const float* samples, std::size_t frames) {
  std::unique_lock<std::mutex> lock(mutex_, std::try_to_lock);
  if (!lock.owns_lock() || !samples) return;
  for (std::size_t i = 0; i < frames; ++i) {
    ring_[next_ * 2] = samples[i * 2];
    ring_[next_ * 2 + 1] = samples[i * 2 + 1];
    next_ = (next_ + 1) % AUDIO_WINDOW_FRAMES;
  }
  filled_ = std::min(AUDIO_WINDOW_FRAMES, filled_ + frames);
}

AudioLevel AudioMeter::level(double sampleRateHz) const {
  std::vector<double> mono;
  double squares = 0;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    std::size_t first = (next_ + AUDIO_WINDOW_FRAMES - filled_) % AUDIO_WINDOW_FRAMES;
    for (std::size_t i = 0; i < filled_; ++i) {
      std::size_t frame = (first + i) % AUDIO_WINDOW_FRAMES;
      double left = finiteSample(ring_[frame * 2]);
      double right = finiteSample(ring_[frame * 2 + 1]);
      squares += left * left + right * right;
      mono.push_back((left + right) / 2);
    }
  }
  if (mono.empty()) return {};
  return {std::sqrt(squares / static_cast<double>(mono.size() * 2)), centroidOf(mono, sampleRateHz)};
}

void FrameTiming::record(double frameMs, double updateMs, double drawMs) {
  ++frames_;
  if (!std::isfinite(frameMs) || !std::isfinite(updateMs) || !std::isfinite(drawMs)) return;
  samples_[next_] = Sample{frameMs, updateMs, drawMs};
  next_ = (next_ + 1) % TIMING_WINDOW_FRAMES;
  filled_ = std::min(TIMING_WINDOW_FRAMES, filled_ + 1);
}

Timings FrameTiming::timings() const {
  Timings out;
  out.frames = frames_;
  if (filled_ == 0) return out;
  for (std::size_t i = 0; i < filled_; ++i) {
    out.frameMs += samples_[i].frameMs;
    out.updateMs += samples_[i].updateMs;
    out.drawMs += samples_[i].drawMs;
  }
  auto count = static_cast<double>(filled_);
  out.frameMs /= count;
  out.updateMs /= count;
  out.drawMs /= count;
  return out;
}

std::string checksum(std::uint32_t seed, int tick, const json::Value& probes) {
  json::Value leaves = json::Value::object();
  leaves.set("seed", seed);
  leaves.set("frame", tick);
  json::Value kept = json::Value::object();
  for (const json::Value::Member& member : probes.members()) {
    if (member.key != VOLATILE_KEY) kept.set(member.key, member.value);
  }
  leaves.set("probes", std::move(kept));
  return hex64(fnv1a64(leaves.dump()));
}

json::Value snapshot(const Session& session, const StateExtras& extras) {
  json::Value state = json::Value::object();
  state.set("version", CONTRACT_VERSION);
  state.set("contractVersion", CONTRACT_VERSION);
  state.set("seed", session.seedValue());
  state.set("frame", session.tick());
  state.set("simulatedMs", session.simulatedMs());
  state.set("running", session.running());
  state.set("fps", extras.fps);
  json::Value held = json::Value::array();
  for (const std::string& key : session.held()) held.push(key);
  state.set("held", std::move(held));
  state.set("pointerLock", session.last().pointerLock);
  state.set("hud", extras.hud.isNull() ? emptyHud() : extras.hud);
  state.set("camera", extras.camera);
  state.set("error", extras.error.empty() ? json::Value() : json::Value(extras.error));
  state.set("player", extras.player);
  json::Value volatileValues = json::Value::object();
  volatileValues.set("fps", extras.fps);
  state.set("volatile", std::move(volatileValues));
  state.set("__render", extras.render.isNull() ? noDraws() : extras.render);
  state.set("assets", extras.assets.isNull() ? json::Value::array() : extras.assets);
  state.set("checksum", checksum(session.seedValue(), session.tick(), extras.probes));
  for (const json::Value::Member& member : extras.probes.members()) {
    if (!state.find(member.key)) state.set(member.key, member.value);
  }
  return state;
}

}  // namespace studio
