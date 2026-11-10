// A JSON-shaped msgpack codec over genex::Json, sized to the Genex wire rules (PROTOCOL.md §1).
// Port of sdks/rust/genex-multiplayer/src/msgpack.rs (limits from protocol.rs); when the two
// disagree, the Rust file is the reference and this one is the bug.
//
// Encode:
// - A number that is integral and fits 32 bits (uint32 or int32) is written at the smallest width;
//   every other number is a float64 (0xcb). Never int64/uint64: the relay drops any payload holding
//   one. -0 is a float64 (it is not an integer). A non-finite number is refused.
// - Payloads must be JSON trees of at most protocol::limits::kMaxJsonDepth levels (the root is
//   level 1) and protocol::limits::kMaxJsonNodes values (object keys are not counted); bigger ones
//   are refused rather than sent for the relay to drop. Strings must be valid UTF-8.
// - Object members are written in the Json's insertion order.
// Decode:
// - The msgpack `undefined` extension (ext type 0, what msgpackr writes for an unset optional key)
//   reads as an ABSENT value: in a map the member is dropped, in an array it is a hole, which JSON
//   spells null (exactly the Rust codec's choice), at the root it is null. Any other extension and
//   every bin value read as null. A non-string map key becomes its JSON text (`1` → "1"); an ext-0
//   key becomes "".
// - int64/uint64 decode to the nearest double; float32 widens; a NaN/Infinity float reads as null.
// - Invalid UTF-8 and truncation are refused; nesting deeper than kMaxDecodeDepth is refused (a
//   stack bound only: the relay never sends more than 32 levels). Trailing bytes are ignored.
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexJson.h"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace genex {

enum class MsgpackError {
  None,
  TooDeep,
  TooManyNodes,
  Truncated,
  InvalidUtf8,
  /** The reserved byte 0xc1. */
  Unsupported,
  /** NaN or ±Infinity handed to the encoder. */
  NonFinite,
  /** A string or collection longer than msgpack's 32-bit length field. */
  TooLong,
};

/** Decode nesting guard (Rust MAX_DECODE_DEPTH): the root is depth 0. */
constexpr std::size_t kMaxDecodeDepth = 128;

/** "too deep", "too many nodes", … (a stable short name per error). */
GENEX_CORE_API const char* MsgpackErrorName(MsgpackError error);

/** Append the msgpack encoding of `value` to `out`. On failure returns false, leaves `out` at its
 *  original size, and fills `error` / `code` when they are not null. */
GENEX_CORE_API bool EncodeMsgpack(const Json& value, std::vector<std::uint8_t>& out,
                                  std::string* error = nullptr, MsgpackError* code = nullptr);

/** Decode one msgpack value from `data[0..size)`. Trailing bytes are ignored. */
GENEX_CORE_API std::optional<Json> DecodeMsgpack(const std::uint8_t* data, std::size_t size,
                                                 std::string* error = nullptr,
                                                 MsgpackError* code = nullptr);

/** Always a float64 (0xcb): clocks and stamps go out this way, never as a 64-bit integer. */
GENEX_CORE_API void MsgpackWriteF64(std::vector<std::uint8_t>& out, double value);

/** A msgpack string header + bytes (the caller guarantees UTF-8 and a length below 2^32). */
GENEX_CORE_API void MsgpackWriteStr(std::vector<std::uint8_t>& out, std::string_view text);

}  // namespace genex
