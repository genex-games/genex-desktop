// genex::Json: the JSON value every GenexCore payload is built from (msgpack messages, player
// `data`, object `d`, shared values). Port target: the serde_json::Value shapes in
// sdks/rust/genex-multiplayer/src/msgpack.rs; the text semantics follow JavaScript's JSON.parse /
// JSON.stringify, because the relay and every peer are JS.
//
// - One number kind: a finite double (like a JS number). Integers are exact up to 2^53.
// - Strings are UTF-8 `std::string`s.
// - Objects keep insertion order (like a JS object with string keys, minus JS's integer-key
//   reordering) and look keys up in O(log n) once they grow past a few members: up to
//   kJsonIndexThreshold members a linear scan is cheapest; past it a sorted index is kept.
// - Setting an existing key replaces its value in place (it keeps its original position).
//
// Parse() is strict RFC 8259 with hard limits (depth, node count, text size), see Parse below.
// No exceptions: Parse returns std::nullopt and an error string.
#pragma once

#include "GenexCore/GenexConfig.h"

#include <cstddef>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

namespace genex {

class Json;
struct JsonMember;

/** Bounds Parse() enforces. Anything past them is refused, never truncated. */
struct JsonLimits {
  /** Nesting depth: a scalar at the root is depth 1, `[1]` is depth 2. */
  std::size_t maxDepth = 64;
  /** Values parsed (every scalar, array and object counts one; object keys do not). */
  std::size_t maxNodes = 100000;
  /** Input text size in bytes. */
  std::size_t maxBytes = 8u * 1024u * 1024u;
};

/** Objects with more members than this keep a sorted key index. */
constexpr std::size_t kJsonIndexThreshold = 8;

class GENEX_CORE_API Json {
 public:
  enum class Type : std::uint8_t { Null, Bool, Number, String, Array, Object };

  Json();
  Json(std::nullptr_t);
  Json(bool value);
  /** Any arithmetic type but bool: stored as a double. Non-finite values are kept, but Dump()
   *  writes them as `null` (JSON.stringify) and the msgpack encoder refuses them. */
  template <typename T,
            std::enable_if_t<std::is_arithmetic<T>::value && !std::is_same<T, bool>::value, int> = 0>
  Json(T value) : Json(NumberTag{}, static_cast<double>(value)) {}
  Json(const char* value);
  Json(std::string_view value);
  Json(std::string value);
  // Copy/move/destroy are the implicit ones (rule of zero): they are only instantiated where they
  // are used, after JsonMember is complete.

  static Json MakeArray();
  static Json MakeObject();

  Type GetType() const { return type_; }
  bool IsNull() const { return type_ == Type::Null; }
  bool IsBool() const { return type_ == Type::Bool; }
  bool IsNumber() const { return type_ == Type::Number; }
  bool IsString() const { return type_ == Type::String; }
  bool IsArray() const { return type_ == Type::Array; }
  bool IsObject() const { return type_ == Type::Object; }

  /** The value, or `fallback` when this is not that type. */
  bool AsBool(bool fallback = false) const { return type_ == Type::Bool ? bool_ : fallback; }
  double AsNumber(double fallback = 0.0) const { return type_ == Type::Number ? number_ : fallback; }
  /** The string, or an empty string when this is not a string. */
  const std::string& AsString() const;

  /** Members of an array or an object; 0 for anything else. */
  std::size_t Size() const;

  // ---- objects ----
  /** The member's value, or nullptr (also when this is not an object). */
  const Json* Find(std::string_view key) const;
  Json* Find(std::string_view key);
  bool Contains(std::string_view key) const { return Find(key) != nullptr; }
  /** Insert-or-get. A null value becomes an empty object first; any other non-object value is
   *  REPLACED by an empty object (there are no exceptions to report the misuse with). */
  Json& operator[](std::string_view key);
  /** Set `key` to `value` (replacing in place when present). Same conversion rule as operator[]. */
  Json& Set(std::string_view key, Json value);
  /** Remove `key`; false when absent. O(n). */
  bool Erase(std::string_view key);
  /** The members in insertion order (empty for a non-object). */
  const std::vector<JsonMember>& Members() const;

  // ---- arrays ----
  /** Append. A null value becomes an empty array first; any other non-array value is replaced. */
  Json& Push(Json value);
  /** The element, or a shared null for an out-of-range index or a non-array. */
  const Json& At(std::size_t index) const;
  const Json& operator[](std::size_t index) const { return At(index); }
  /** Mutable element; nullptr when out of range or not an array. */
  Json* AtMut(std::size_t index);
  /** The elements (empty for a non-array). */
  const std::vector<Json>& Items() const;

  /** Deep equality. Numbers compare with ==, objects ignore member order (as JSON does). */
  bool Equals(const Json& other) const;
  friend bool operator==(const Json& a, const Json& b) { return a.Equals(b); }
  friend bool operator!=(const Json& a, const Json& b) { return !a.Equals(b); }

  /** Compact JSON text, as JSON.stringify would write it: numbers in JavaScript's shortest
   *  round-trip form (`1e+21`, `1e-7`, `0.1`, `-0` → `0`), NaN/Infinity → `null`, strings with
   *  `"`, `\` and control characters escaped and everything else kept as UTF-8 (an invalid UTF-8
   *  sequence in a hand-built string is written as U+FFFD, so the output is always valid UTF-8). */
  std::string Dump() const;
  void DumpTo(std::string& out) const;

  /** Strict RFC 8259 parse of one value surrounded by optional whitespace.
   *  Refused: trailing commas, comments, NaN/Infinity, leading zeros, `+1`, `.5`, `1.`, a byte
   *  order mark, raw control characters in strings, invalid escapes, lone UTF-16 surrogates in
   *  `\u` escapes (pairs become one UTF-8 code point), invalid or overlong UTF-8, trailing text,
   *  anything past `limits`, and a number whose magnitude overflows a double (`1e400`: JSON.parse
   *  gives Infinity, but a Json must stay finite for the wire). A number that underflows parses
   *  to (signed) zero, as in JS. Duplicate keys: the LAST value wins and the key keeps its FIRST
   *  position (JSON.parse semantics). On failure returns nullopt and, when `error` is not null,
   *  stores "<reason> at byte <offset>". */
  static std::optional<Json> Parse(std::string_view text, std::string* error = nullptr,
                                   const JsonLimits& limits = JsonLimits());

 private:
  struct NumberTag {};
  Json(NumberTag, double value);
  void BecomeObject();
  void BecomeArray();
  void RebuildIndex();
  void IndexInsert(std::size_t position);

  Type type_ = Type::Null;
  bool bool_ = false;
  double number_ = 0.0;
  std::string string_;
  std::vector<Json> array_;
  std::vector<JsonMember> object_;
  // key → position in object_, kept only while object_.size() > kJsonIndexThreshold.
  std::map<std::string, std::size_t, std::less<>> index_;
};

struct JsonMember {
  std::string key;
  Json value;
};

/** Whether `text` is well-formed UTF-8 (no overlongs, no surrogates, nothing past U+10FFFF). */
GENEX_CORE_API bool IsValidUtf8(std::string_view text);

/** Append JSON-number text for `value` exactly as JavaScript's Number#toString writes it
 *  (non-finite values append `null`, -0 appends `0`). */
GENEX_CORE_API void AppendJsonNumber(std::string& out, double value);

/** Append `text` as a quoted, escaped JSON string (JSON.stringify's escaping). */
GENEX_CORE_API void AppendJsonString(std::string& out, std::string_view text);

}  // namespace genex
