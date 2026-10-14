// Live's embedded frames, game side. An embedded run (always a Mac headless build) copies each
// presented frame into a ring of up to three IOSurfaces and hands it to the studio's frames
// service, which shows it inside Live without another copy; the studio gives a slot back with
// `release`. This header holds what is the same everywhere: the `surface` and `release`
// arguments, the ring's bookkeeping (which slot is the studio's, the generation, the frame
// sequence) and Live's pixel positions. What touches the GPU and the OS stands behind `Seam`:
// frames.cpp's Mac seam, built only where STUDIO_FRAMES is 1. Every other build leaves `surface`
// and `release` unknown ops, which the studio reads as a game that cannot embed. raylib-free.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <optional>
#include <string_view>

#include "json.h"
#include "protocol.h"

// 1 in a Mac's headless build, the only one Live embeds; 0 everywhere else.
#if defined(GENEX_HEADLESS) && defined(__APPLE__)
#define STUDIO_FRAMES 1
#else
#define STUDIO_FRAMES 0
#endif

namespace studio::frames {

/** The most slots a ring has: the studio's frames service refuses a fourth surface. */
inline constexpr int MAX_SLOTS = 3;
/** The longest ring side the studio asks for (its `NATIVE_FRAME_SIDE_MAX`). */
inline constexpr int MAX_SIDE = 4096;
/** The device-pixel ratios Live's slot may report. */
inline constexpr double MIN_DPR = 1.0;
inline constexpr double MAX_DPR = 4.0;
/** Ring generations are the studio's, counted from 1 in an unsigned 32-bit number. */
inline constexpr double MAX_GENERATION = 4294967295.0;
/**
 * The least time between two frames sent, in microseconds: twice the game's own 60 Hz and half
 * the studio's rate cap (240 a second), so verbs that draw between frames never add up to a burst
 * the studio refuses.
 */
inline constexpr std::uint64_t MIN_FRAME_INTERVAL_US = 1000000 / 120;

/** Why `surface` or `release` was refused. Wire values: the studio reads them. */
namespace Refusal {
/** An argument outside its shape: nothing was made or freed. */
inline constexpr std::string_view BadArgument = "bad-argument";
/** A generation no newer than the last one asked for: the studio's generations only grow. */
inline constexpr std::string_view StaleGeneration = "stale-generation";
/** No frames service to send to: not an embedded run, or the name is not this run's. */
inline constexpr std::string_view NoService = "no-frames-service";
/** The surfaces or their GPU bindings could not be made; there is no ring until the next `surface`. */
inline constexpr std::string_view SurfaceFailed = "surface-failed";
}  // namespace Refusal

/** A checked `surface` request: the ring's size in device pixels, its slots and its generation. */
struct SurfaceRequest {
  int width = 0;
  int height = 0;
  double dpr = 1;
  int slots = 0;
  std::uint32_t generation = 0;
};

/** A checked `release` request. */
struct ReleaseRequest {
  int slot = 0;
  std::uint32_t generation = 0;
};

/** A rectangle in ring pixels, measured from the ring's top-left corner as Live's canvas is. */
struct Rect {
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;
};

/** What one frame's copy needs: the presented screen whole, and where it lands in the slot. */
struct Blit {
  int screenWidth = 0;
  int screenHeight = 0;
  Rect into;
};

/** One finished frame as the seam sends it. */
struct Frame {
  int slot = 0;
  std::uint32_t generation = 0;
  int width = 0;
  int height = 0;
  /** Strictly increasing for the whole run, across generations. */
  std::uint64_t seq = 0;
  /** The realtime clock in microseconds, a diagnostic for the studio. */
  std::uint64_t timestampUs = 0;
};

/** What making a ring came to. */
enum class Made { Ok, NoService, Failed };
/** What sending a frame came to: the studio took the slot, nothing reached it (try again), or it is gone. */
enum class Sent { Taken, NotTaken, Gone };
/** What one present did with the frame. */
enum class Presented { NoRing, Unchanged, Skipped, Sent, Failed };

/** What the ring asks of the GPU and the studio: IOSurfaces, EGL and mach on a Mac (frames.cpp). */
class Seam {
 public:
  virtual ~Seam() = default;
  /** Make the request's surfaces and their GPU bindings; nothing is left half made when it fails. */
  virtual Made make(const SurfaceRequest& request) = 0;
  /** Copy the presented screen into `slot` as `blit` says, and wait until the GPU has finished it. */
  virtual bool draw(int slot, const Blit& blit) = 0;
  /** Hand `frame`'s slot to the studio. */
  virtual Sent send(const Frame& frame) = 0;
  /** Let every surface go: the game drops its references, the studio keeps its own. */
  virtual void drop() = 0;
};

namespace detail {

/** `value` when it is a JSON number holding a whole number in [low, high]. */
inline std::optional<double> whole(const json::Value& value, double low, double high) {
  if (!value.is(json::Kind::Number)) return std::nullopt;
  double number = value.asNumber();
  bool inRange = std::isfinite(number) && number >= low && number <= high;
  if (!inRange || std::trunc(number) != number) return std::nullopt;
  return number;
}

/** `value` when it is a finite JSON number in [low, high]. */
inline std::optional<double> between(const json::Value& value, double low, double high) {
  if (!value.is(json::Kind::Number)) return std::nullopt;
  double number = value.asNumber();
  if (!std::isfinite(number) || number < low || number > high) return std::nullopt;
  return number;
}

/** A position along `extent` from `origin` as a fraction in [0, 1]; a value that is no number reads as the middle. */
inline double fraction(double value, double origin, double extent) {
  if (!std::isfinite(value) || !(extent > 0)) return 0.5;
  return std::clamp((value - origin) / extent, 0.0, 1.0);
}

/** An action or pointer given in ring pixels (`px: true`), with `x` and `y` as fractions of `view` and `px` gone. */
inline json::Value inFrame(const json::Value& position, const Rect& view) {
  if (!position.is(json::Kind::Object) || !position["px"].asBool()) return position;
  json::Value mapped = json::Value::object();
  for (const json::Value::Member& member : position.members()) {
    if (member.key == "px") continue;
    if (member.key == "x") {
      mapped.set("x", fraction(member.value.asNumber(NAN), view.x, view.width));
    } else if (member.key == "y") {
      mapped.set("y", fraction(member.value.asNumber(NAN), view.y, view.height));
    } else {
      mapped.set(member.key, member.value);
    }
  }
  return mapped;
}

}  // namespace detail

/** `{w, h, dpr, slots, generation}` with every field present and in range, or nothing: no field is guessed. */
inline std::optional<SurfaceRequest> parseSurface(const json::Value& arg) {
  if (!arg.is(json::Kind::Object)) return std::nullopt;
  std::optional<double> width = detail::whole(arg["w"], 1, MAX_SIDE);
  std::optional<double> height = detail::whole(arg["h"], 1, MAX_SIDE);
  std::optional<double> slots = detail::whole(arg["slots"], 1, MAX_SLOTS);
  std::optional<double> generation = detail::whole(arg["generation"], 1, MAX_GENERATION);
  std::optional<double> dpr = detail::between(arg["dpr"], MIN_DPR, MAX_DPR);
  bool complete = width && height && slots && generation && dpr;
  if (!complete) return std::nullopt;
  return SurfaceRequest{static_cast<int>(*width), static_cast<int>(*height), *dpr, static_cast<int>(*slots),
                        static_cast<std::uint32_t>(*generation)};
}

/** `{slot, generation}` with both present and in range, or nothing. */
inline std::optional<ReleaseRequest> parseRelease(const json::Value& arg) {
  if (!arg.is(json::Kind::Object)) return std::nullopt;
  std::optional<double> slot = detail::whole(arg["slot"], 0, MAX_SLOTS - 1);
  std::optional<double> generation = detail::whole(arg["generation"], 1, MAX_GENERATION);
  if (!slot || !generation) return std::nullopt;
  return ReleaseRequest{static_cast<int>(*slot), static_cast<std::uint32_t>(*generation)};
}

/** Where a screen lands in a ring: the largest rectangle of its shape, centred (letterboxed). */
inline Rect fit(int screenWidth, int screenHeight, int ringWidth, int ringHeight) {
  bool sized = screenWidth > 0 && screenHeight > 0 && ringWidth > 0 && ringHeight > 0;
  if (!sized) return Rect{};
  double scale = std::min(static_cast<double>(ringWidth) / screenWidth, static_cast<double>(ringHeight) / screenHeight);
  double width = screenWidth * scale;
  double height = screenHeight * scale;
  return Rect{(ringWidth - width) / 2, (ringHeight - height) / 2, width, height};
}

/** `arg` (an `input` argument) with every position Live gives in ring pixels turned into a fraction of `view`. */
inline json::Value ringInput(const json::Value& arg, const Rect& view) {
  if (!arg.is(json::Kind::Object)) return arg;
  json::Value mapped = json::Value::object();
  for (const json::Value::Member& member : arg.members()) {
    if (member.key == "pointer") {
      mapped.set(member.key, detail::inFrame(member.value, view));
    } else if (member.key == "actions" && member.value.is(json::Kind::Array)) {
      json::Value actions = json::Value::array();
      for (const json::Value& action : member.value.items()) actions.push(detail::inFrame(action, view));
      mapped.set(member.key, std::move(actions));
    } else {
      mapped.set(member.key, member.value);
    }
  }
  return mapped;
}

/**
 * One run's ring. A slot is the game's until a frame is sent in it, then the studio's until it is
 * released; a frame with no free slot, or too soon after the last one, is skipped, never queued,
 * so the game keeps its own pace and the studio never gets a burst. The newest frame waits for the
 * next present that may send it.
 */
class Ring {
 public:
  explicit Ring(Seam& seam) : seam_(seam) {}

  /** The `surface` op: a new generation replaces the ring, and its first frame goes out at the next present. */
  protocol::Answer surface(const json::Value& arg) {
    std::optional<SurfaceRequest> request = parseSurface(arg);
    if (!request) return protocol::refuse(Refusal::BadArgument);
    if (request->generation <= asked_) return protocol::refuse(Refusal::StaleGeneration);
    asked_ = request->generation;
    end();
    Made made = seam_.make(*request);
    if (made == Made::NoService) return protocol::refuse(Refusal::NoService);
    if (made != Made::Ok) return protocol::refuse(Refusal::SurfaceFailed);
    ring_ = *request;
    open_ = true;
    changed_ = true;
    json::Value result = json::Value::object();
    result.set("generation", ring_.generation);
    result.set("width", ring_.width);
    result.set("height", ring_.height);
    result.set("slots", ring_.slots);
    return protocol::answer(std::move(result));
  }

  /** The `release` op: the studio gives back a slot; one of an older generation, or not the studio's, is ignored. */
  protocol::Answer release(const json::Value& arg) {
    std::optional<ReleaseRequest> request = parseRelease(arg);
    if (!request) return protocol::refuse(Refusal::BadArgument);
    bool current = open_ && request->generation == ring_.generation && request->slot < ring_.slots;
    if (current) held_ &= ~bit(request->slot);
    return protocol::answer(json::Value::object());
  }

  /** The world was drawn again: the next present has a frame to send. */
  void changed() { changed_ = true; }

  /**
   * Right after the screen was presented at `timestampUs` (the realtime clock): send it in a free
   * slot when it changed, at most one frame per call and per MIN_FRAME_INTERVAL_US.
   */
  Presented present(int screenWidth, int screenHeight, std::uint64_t timestampUs) {
    if (!open_) return Presented::NoRing;
    if (!changed_) return Presented::Unchanged;
    int slot = freeSlot();
    if (slot < 0 || tooSoon(timestampUs)) return Presented::Skipped;
    Blit blit{screenWidth, screenHeight, fit(screenWidth, screenHeight, ring_.width, ring_.height)};
    if (!seam_.draw(slot, blit)) return Presented::Failed;
    Frame frame{slot, ring_.generation, ring_.width, ring_.height, ++seq_, timestampUs};
    Sent sent = seam_.send(frame);
    if (sent == Sent::Gone) {
      end();
      return Presented::Failed;
    }
    if (sent == Sent::NotTaken) return Presented::Skipped;
    held_ |= bit(slot);
    changed_ = false;
    lastSentUs_ = timestampUs;
    return Presented::Sent;
  }

  /** The `input` argument as the merge reads it: with a ring, Live's ring pixels become fractions of the frame. */
  json::Value input(const json::Value& arg, int screenWidth, int screenHeight) const {
    if (!open_) return arg;
    return ringInput(arg, fit(screenWidth, screenHeight, ring_.width, ring_.height));
  }

  /** End the ring (the studio is gone, or the game is closing). */
  void close() { end(); }

  /** Whether a ring is open: the run is embedded and Live is taking its frames. */
  bool active() const { return open_; }
  /** The open ring's generation, 0 when there is none. */
  std::uint32_t generation() const { return open_ ? ring_.generation : 0; }
  /** The slots the studio holds, one bit each. */
  unsigned heldMask() const { return held_; }

 private:
  static unsigned bit(int slot) { return 1u << static_cast<unsigned>(slot); }

  /** Whether `timestampUs` falls within MIN_FRAME_INTERVAL_US of the last frame sent; a clock set back holds none. */
  bool tooSoon(std::uint64_t timestampUs) const {
    bool sentBefore = lastSentUs_ != 0;
    return sentBefore && timestampUs >= lastSentUs_ && timestampUs - lastSentUs_ < MIN_FRAME_INTERVAL_US;
  }

  int freeSlot() const {
    for (int slot = 0; slot < ring_.slots; ++slot) {
      if ((held_ & bit(slot)) == 0) return slot;
    }
    return -1;
  }

  void end() {
    if (!open_) return;
    seam_.drop();
    open_ = false;
    held_ = 0;
  }

  Seam& seam_;
  SurfaceRequest ring_;
  bool open_ = false;
  bool changed_ = false;
  unsigned held_ = 0;
  /** The newest generation the studio asked for, made or not. */
  std::uint32_t asked_ = 0;
  std::uint64_t seq_ = 0;
  /** When the last frame went out (the realtime clock); 0 before the first. */
  std::uint64_t lastSentUs_ = 0;
};

#if STUDIO_FRAMES
// This run's ring over the Mac seam (frames.cpp). studio.cpp is the only caller, on the main thread,
// where raylib's GL context is current.

/** The `surface` op. */
protocol::Answer surface(const json::Value& arg);
/** The `release` op. */
protocol::Answer release(const json::Value& arg);
/** The world was drawn again. */
void changed();
/** Right after EndDrawing: send the screen in a free slot when it changed. */
void present(int screenWidth, int screenHeight);
/** Whether Live is taking this run's frames: its loop then keeps its own 60 Hz. */
bool active();
/** The `input` argument with Live's ring-pixel positions as fractions of the frame. */
json::Value input(const json::Value& arg, int screenWidth, int screenHeight);
/** Let the ring go while the GL context still exists (before CloseWindow). */
void close();
#else
// No ring here: the runtime's calls do nothing.
inline void changed() {}
inline void present(int, int) {}
inline bool active() { return false; }
inline json::Value input(const json::Value& arg, int, int) { return arg; }
inline void close() {}
#endif

}  // namespace studio::frames
