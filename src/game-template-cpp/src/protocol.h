// The studio protocol's framing and envelope, shared by both transports: a native game reads NDJSON
// requests from the descriptor the studio passed (transport.h's reader thread), and the web build's
// exports answer the same envelope. One JSON object per line, at most 1 MiB, nested at most 32
// deep. Requests are `{id, op, arg?}`; replies are `{id, ok:true, op, result}` or
// `{id, ok:false, op, error, available?}`; events are `{event, ...}`. raylib-free.
#pragma once

#include <cstddef>
#include <functional>
#include <map>
#include <string>
#include <string_view>
#include <vector>

#include "json.h"

namespace studio::protocol {

/** The longest line either side may send, newline excluded. */
inline constexpr std::size_t MAX_LINE_BYTES = 1024 * 1024;
/** The deepest nesting a request may have, its own object included. */
inline constexpr int MAX_DEPTH = json::MAX_DEPTH;

/** The protocol version `ready` states; the host refuses any other. */
inline constexpr int PROTOCOL_VERSION = 1;

/** What a game sends on its own, unasked. Wire values: never rename one. */
namespace Event {
/** The game is up: `{nonce, protocol, contractVersion, build, backend, size, seed}`. */
inline constexpr std::string_view Ready = "ready";
/** The game is about to exit abnormally: `{reason}`. */
inline constexpr std::string_view Fatal = "fatal";
/** The game's window gained or lost focus: `{focused}`. */
inline constexpr std::string_view Focus = "focus";
}  // namespace Event

/** The graphics path `ready.backend.api` reports (a diagnostic: the host's own gate decides). Wire values. */
namespace Backend {
inline constexpr std::string_view MetalAngle = "metal-angle";
inline constexpr std::string_view D3d11Angle = "d3d11-angle";
inline constexpr std::string_view VulkanAngle = "vulkan-angle";
inline constexpr std::string_view WebGl2 = "webgl2";
inline constexpr std::string_view Unknown = "unknown";
}  // namespace Backend

/** Why a line was refused. Wire values: the host reads them, so never rename one. */
namespace Refusal {
inline constexpr std::string_view LineTooLong = "line-too-long";
inline constexpr std::string_view BadJson = "bad-json";
inline constexpr std::string_view TooDeep = "too-deep";
inline constexpr std::string_view NotAnObject = "not-an-object";
inline constexpr std::string_view MissingId = "missing-id";
inline constexpr std::string_view UnknownOp = "unknown-op";
}  // namespace Refusal

/** Where request bytes come from: a file descriptor, a pipe, or a test's chunks. */
class ByteSource {
 public:
  virtual ~ByteSource() = default;
  /** Up to `capacity` bytes into `into`: the count, 0 at the end, negative on an error (also the end). */
  virtual long read(char* into, std::size_t capacity) = 0;
};

/** What the next framed line was. */
enum class LineStatus { Line, TooLong, End };

/** One framed line, or why there is none. */
struct NextLine {
  LineStatus status = LineStatus::End;
  std::string text;
};

/**
 * NDJSON framing over a byte source. A line past the cap is reported once as TooLong and its
 * bytes are dropped up to the next newline, so one hostile line cannot grow the buffer or end
 * the conversation. A trailing CR is stripped, blank lines are skipped, and a last line with no
 * newline is still delivered at the end.
 */
class LineReader {
 public:
  explicit LineReader(ByteSource& source, std::size_t cap = MAX_LINE_BYTES);
  NextLine next();

 private:
  bool fill();
  ByteSource& source_;
  std::size_t cap_;
  std::string pending_;
  bool dropping_ = false;
  bool ended_ = false;
};

/** A handler's answer: a result, or an error code for `{ok:false}`. */
struct Answer {
  bool ok = true;
  json::Value result;
  std::string error;
};

/** Answer with `result`. */
Answer answer(json::Value result);
/** Answer `{ok:false, error}`. */
Answer refuse(std::string_view error);

/** One op's handler: it receives the request's `arg` (null when absent). */
using Handler = std::function<Answer(const json::Value& arg)>;

/** Routes request lines to handlers by op and writes the reply line. */
class Dispatcher {
 public:
  /** Register (or replace) the handler for `op`. */
  void on(std::string op, Handler handler);
  /** Every registered op, sorted: what an unknown op is answered with. */
  std::vector<std::string> ops() const;
  /** Whether `op` has a handler. */
  bool has(std::string_view op) const;
  /** The reply line (no newline) to one request line. */
  std::string handle(std::string_view line) const;
  /** The reply line to a request the framing dropped for its length. */
  std::string lineTooLong() const;
  /** Call `op` directly with an already-parsed argument, as the web exports do. */
  std::string call(std::string_view op, const json::Value& arg) const;

 private:
  std::map<std::string, Handler, std::less<>> handlers_;
};

/** An event line (no newline): `{"event": name}` plus `fields`' members. */
std::string event(std::string_view name, const json::Value& fields);

}  // namespace studio::protocol
