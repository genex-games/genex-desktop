// The template's own tiny JSON reader and writer: the studio protocol, state() and probes speak
// it. No third-party JSON, no exceptions (the web build turns them off), no locale: numbers are
// read with strtod on validated text and written as the shortest form that reads back exactly.
// raylib-free: never include raylib.h here.
#pragma once

#include <cstddef>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

namespace json {

/** The six JSON kinds. */
enum class Kind { Null, Bool, Number, String, Array, Object };

/** Why a text did not parse. */
enum class ParseError { None, Syntax, TooDeep };

/** The deepest nesting a parse accepts; the protocol refuses anything deeper. */
inline constexpr int MAX_DEPTH = 32;

/** One JSON value. Objects keep their members in insertion order. */
class Value {
 public:
  struct Member;
  using Array = std::vector<Value>;
  using Object = std::vector<Member>;

  // The constructors are defined below `Member`: a body written here would need the destructor of
  // a vector of members before a member is a complete type.
  Value();
  Value(std::nullptr_t);
  Value(bool flag);
  template <typename T>
    requires(std::is_arithmetic_v<T> && !std::is_same_v<T, bool>)
  Value(T number);
  Value(const char* text);
  Value(std::string text);
  Value(std::string_view text);

  /** An empty array. */
  static Value array();
  /** An array holding `items`. */
  static Value array(Array items);
  /** An empty object. */
  static Value object();

  Kind kind() const { return kind_; }
  bool is(Kind kind) const { return kind_ == kind; }
  bool isNull() const { return kind_ == Kind::Null; }
  /** The boolean, or `fallback` for any other kind. */
  bool asBool(bool fallback = false) const { return kind_ == Kind::Bool ? flag_ : fallback; }
  /** The number, or `fallback` for any other kind. */
  double asNumber(double fallback = 0) const { return kind_ == Kind::Number ? number_ : fallback; }
  /** The string, or an empty one for any other kind. */
  const std::string& asString() const;
  /** The items of an array; empty for any other kind. */
  const Array& items() const;
  /** The members of an object; empty for any other kind. */
  const Object& members() const;
  /** The value of `key` in an object (the last one, as JSON.parse decides duplicates), or null. */
  const Value* find(std::string_view key) const;
  /** The value of `key`, or a shared null when absent or when this is not an object. */
  const Value& operator[](std::string_view key) const;
  /** Set `key` (replacing an existing one); a null becomes an object first. */
  Value& set(std::string key, Value value);
  /** Append to an array; a null becomes an array first. */
  Value& push(Value value);
  /** Compact JSON text. NaN and infinities are written as null. */
  std::string dump() const;
  /** Write compact JSON text onto `out`. */
  void dumpTo(std::string& out) const;

  friend bool operator==(const Value& a, const Value& b);

 private:
  Kind kind_ = Kind::Null;
  bool flag_ = false;
  double number_ = 0;
  std::string text_;
  Array items_;
  Object members_;
};

/** One object member. */
struct Value::Member {
  std::string key;
  Value value;
  bool operator==(const Member& other) const = default;
};

inline Value::Value() = default;
inline Value::Value(std::nullptr_t) {}
inline Value::Value(bool flag) : kind_(Kind::Bool), flag_(flag) {}
template <typename T>
  requires(std::is_arithmetic_v<T> && !std::is_same_v<T, bool>)
inline Value::Value(T number) : kind_(Kind::Number), number_(static_cast<double>(number)) {}
inline Value::Value(const char* text) : kind_(Kind::String), text_(text ? text : "") {}
inline Value::Value(std::string text) : kind_(Kind::String), text_(std::move(text)) {}
inline Value::Value(std::string_view text) : kind_(Kind::String), text_(text) {}

/** The outcome of a parse: the value when `error` is None. */
struct Parsed {
  ParseError error = ParseError::None;
  Value value;
  bool ok() const { return error == ParseError::None; }
};

/** Parse one complete JSON text (surrounding whitespace allowed), refusing nesting past `maxDepth`. */
Parsed parse(std::string_view text, int maxDepth = MAX_DEPTH);

/** `text` as a JSON string literal, quotes included. */
std::string quote(std::string_view text);

/** The shortest decimal form of `number` that reads back exactly; "null" when it is not finite. */
std::string formatNumber(double number);

}  // namespace json
