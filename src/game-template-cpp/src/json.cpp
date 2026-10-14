// The JSON reader and writer declared in json.h. raylib-free.
#include "json.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace json {

namespace {

/** Integers below this magnitude are written without a fraction or exponent, as JSON.stringify does. */
constexpr double PLAIN_INTEGER_LIMIT = 1e15;
/** Digits tried, in order, for the shortest decimal form that reads back exactly. */
constexpr int SHORTEST_PRECISION = 15;
constexpr int EXACT_PRECISION = 17;
/** What a \u escape that names half a surrogate pair becomes. */
constexpr unsigned REPLACEMENT_CHARACTER = 0xFFFD;

const Value& nullValue() {
  static const Value none;
  return none;
}

bool isDigit(char c) { return c >= '0' && c <= '9'; }

/** Append the UTF-8 bytes of `code` to `out`. */
void appendUtf8(std::string& out, unsigned code) {
  if (code < 0x80) {
    out += static_cast<char>(code);
  } else if (code < 0x800) {
    out += static_cast<char>(0xC0 | (code >> 6));
    out += static_cast<char>(0x80 | (code & 0x3F));
  } else if (code < 0x10000) {
    out += static_cast<char>(0xE0 | (code >> 12));
    out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
    out += static_cast<char>(0x80 | (code & 0x3F));
  } else {
    out += static_cast<char>(0xF0 | (code >> 18));
    out += static_cast<char>(0x80 | ((code >> 12) & 0x3F));
    out += static_cast<char>(0x80 | ((code >> 6) & 0x3F));
    out += static_cast<char>(0x80 | (code & 0x3F));
  }
}

bool isHighSurrogate(unsigned code) { return code >= 0xD800 && code <= 0xDBFF; }
bool isLowSurrogate(unsigned code) { return code >= 0xDC00 && code <= 0xDFFF; }

/** A recursive-descent reader whose recursion is bounded by the depth limit. */
class Reader {
 public:
  Reader(std::string_view text, int maxDepth) : text_(text), maxDepth_(maxDepth) {}

  Parsed run() {
    Parsed parsed;
    skipSpace();
    if (value(parsed.value, 0)) {
      skipSpace();
      if (at_ != text_.size()) fail(ParseError::Syntax);
    }
    parsed.error = error_;
    if (!parsed.ok()) parsed.value = Value();
    return parsed;
  }

 private:
  bool fail(ParseError error) {
    if (error_ == ParseError::None) error_ = error;
    return false;
  }

  bool atEnd() const { return at_ >= text_.size(); }
  char peek() const { return atEnd() ? '\0' : text_[at_]; }

  void skipSpace() {
    while (!atEnd() && (peek() == ' ' || peek() == '\t' || peek() == '\n' || peek() == '\r')) ++at_;
  }

  bool value(Value& out, int depth) {
    switch (peek()) {
      case '{':
        return object(out, depth + 1);
      case '[':
        return array(out, depth + 1);
      case '"': {
        std::string text;
        if (!string(text)) return false;
        out = Value(std::move(text));
        return true;
      }
      case 't':
        return literal("true", Value(true), out);
      case 'f':
        return literal("false", Value(false), out);
      case 'n':
        return literal("null", Value(), out);
      default:
        return number(out);
    }
  }

  bool literal(std::string_view word, Value result, Value& out) {
    if (text_.substr(at_, word.size()) != word) return fail(ParseError::Syntax);
    at_ += word.size();
    out = std::move(result);
    return true;
  }

  bool digits() {
    std::size_t start = at_;
    while (isDigit(peek())) ++at_;
    return at_ > start;
  }

  bool number(Value& out) {
    std::size_t start = at_;
    if (peek() == '-') ++at_;
    if (peek() == '0') {
      ++at_;
    } else if (!digits()) {
      return fail(ParseError::Syntax);
    }
    if (peek() == '.') {
      ++at_;
      if (!digits()) return fail(ParseError::Syntax);
    }
    if (peek() == 'e' || peek() == 'E') {
      ++at_;
      if (peek() == '+' || peek() == '-') ++at_;
      if (!digits()) return fail(ParseError::Syntax);
    }
    std::string token(text_.substr(start, at_ - start));
    out = Value(std::strtod(token.c_str(), nullptr));
    return true;
  }

  bool hex4(unsigned& code) {
    if (at_ + 4 > text_.size()) return fail(ParseError::Syntax);
    code = 0;
    for (int i = 0; i < 4; ++i) {
      char c = text_[at_++];
      unsigned digit = 0;
      if (isDigit(c)) {
        digit = static_cast<unsigned>(c - '0');
      } else if (c >= 'a' && c <= 'f') {
        digit = static_cast<unsigned>(c - 'a' + 10);
      } else if (c >= 'A' && c <= 'F') {
        digit = static_cast<unsigned>(c - 'A' + 10);
      } else {
        return fail(ParseError::Syntax);
      }
      code = code * 16 + digit;
    }
    return true;
  }

  /** A \u escape, with a following low surrogate folded in; half a pair becomes U+FFFD. */
  bool unicodeEscape(std::string& out) {
    unsigned code = 0;
    if (!hex4(code)) return false;
    bool pairFollows = isHighSurrogate(code) && text_.substr(at_, 2) == "\\u";
    if (pairFollows) {
      std::size_t mark = at_;
      at_ += 2;
      unsigned low = 0;
      if (!hex4(low)) return false;
      if (isLowSurrogate(low)) {
        appendUtf8(out, 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00));
        return true;
      }
      at_ = mark;
    }
    appendUtf8(out, isHighSurrogate(code) || isLowSurrogate(code) ? REPLACEMENT_CHARACTER : code);
    return true;
  }

  bool escape(std::string& out) {
    char c = peek();
    ++at_;
    switch (c) {
      case '"':
      case '\\':
      case '/':
        out += c;
        return true;
      case 'b':
        out += '\b';
        return true;
      case 'f':
        out += '\f';
        return true;
      case 'n':
        out += '\n';
        return true;
      case 'r':
        out += '\r';
        return true;
      case 't':
        out += '\t';
        return true;
      case 'u':
        return unicodeEscape(out);
      default:
        return fail(ParseError::Syntax);
    }
  }

  bool string(std::string& out) {
    ++at_;  // the opening quote
    for (;;) {
      if (atEnd()) return fail(ParseError::Syntax);
      char c = text_[at_++];
      if (c == '"') return true;
      if (static_cast<unsigned char>(c) < 0x20) return fail(ParseError::Syntax);
      if (c != '\\') {
        out += c;
        continue;
      }
      if (!escape(out)) return false;
    }
  }

  bool array(Value& out, int depth) {
    if (depth > maxDepth_) return fail(ParseError::TooDeep);
    ++at_;
    out = Value::array();
    skipSpace();
    if (peek() == ']') {
      ++at_;
      return true;
    }
    for (;;) {
      Value item;
      skipSpace();
      if (!value(item, depth)) return false;
      out.push(std::move(item));
      skipSpace();
      if (peek() == ']') {
        ++at_;
        return true;
      }
      if (peek() != ',') return fail(ParseError::Syntax);
      ++at_;
    }
  }

  bool member(Value& out, int depth) {
    skipSpace();
    if (peek() != '"') return fail(ParseError::Syntax);
    std::string key;
    if (!string(key)) return false;
    skipSpace();
    if (peek() != ':') return fail(ParseError::Syntax);
    ++at_;
    skipSpace();
    Value item;
    if (!value(item, depth)) return false;
    out.set(std::move(key), std::move(item));
    return true;
  }

  bool object(Value& out, int depth) {
    if (depth > maxDepth_) return fail(ParseError::TooDeep);
    ++at_;
    out = Value::object();
    skipSpace();
    if (peek() == '}') {
      ++at_;
      return true;
    }
    for (;;) {
      if (!member(out, depth)) return false;
      skipSpace();
      if (peek() == '}') {
        ++at_;
        return true;
      }
      if (peek() != ',') return fail(ParseError::Syntax);
      ++at_;
    }
  }

  std::string_view text_;
  int maxDepth_;
  std::size_t at_ = 0;
  ParseError error_ = ParseError::None;
};

void appendQuoted(std::string& out, std::string_view text) {
  out += '"';
  for (char c : text) {
    switch (c) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\b':
        out += "\\b";
        break;
      case '\f':
        out += "\\f";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          char escaped[8];
          std::snprintf(escaped, sizeof escaped, "\\u%04x", static_cast<unsigned>(static_cast<unsigned char>(c)));
          out += escaped;
        } else {
          out += c;
        }
    }
  }
  out += '"';
}

}  // namespace

Value Value::array() { return array(Array()); }

Value Value::array(Array items) {
  Value value;
  value.kind_ = Kind::Array;
  value.items_ = std::move(items);
  return value;
}

Value Value::object() {
  Value value;
  value.kind_ = Kind::Object;
  return value;
}

const std::string& Value::asString() const {
  static const std::string empty;
  return kind_ == Kind::String ? text_ : empty;
}

const Value::Array& Value::items() const {
  static const Array empty;
  return kind_ == Kind::Array ? items_ : empty;
}

const Value::Object& Value::members() const {
  static const Object empty;
  return kind_ == Kind::Object ? members_ : empty;
}

const Value* Value::find(std::string_view key) const {
  if (kind_ != Kind::Object) return nullptr;
  for (auto member = members_.rbegin(); member != members_.rend(); ++member) {
    if (member->key == key) return &member->value;
  }
  return nullptr;
}

const Value& Value::operator[](std::string_view key) const {
  const Value* found = find(key);
  return found ? *found : nullValue();
}

Value& Value::set(std::string key, Value value) {
  if (kind_ != Kind::Object) *this = object();
  for (Member& member : members_) {
    if (member.key == key) {
      member.value = std::move(value);
      return member.value;
    }
  }
  members_.push_back(Member{std::move(key), std::move(value)});
  return members_.back().value;
}

Value& Value::push(Value value) {
  if (kind_ != Kind::Array) *this = array();
  items_.push_back(std::move(value));
  return items_.back();
}

void Value::dumpTo(std::string& out) const {
  switch (kind_) {
    case Kind::Null:
      out += "null";
      return;
    case Kind::Bool:
      out += flag_ ? "true" : "false";
      return;
    case Kind::Number:
      out += formatNumber(number_);
      return;
    case Kind::String:
      appendQuoted(out, text_);
      return;
    case Kind::Array:
      out += '[';
      for (std::size_t i = 0; i < items_.size(); ++i) {
        if (i > 0) out += ',';
        items_[i].dumpTo(out);
      }
      out += ']';
      return;
    case Kind::Object:
      out += '{';
      for (std::size_t i = 0; i < members_.size(); ++i) {
        if (i > 0) out += ',';
        appendQuoted(out, members_[i].key);
        out += ':';
        members_[i].value.dumpTo(out);
      }
      out += '}';
      return;
  }
}

std::string Value::dump() const {
  std::string out;
  dumpTo(out);
  return out;
}

bool operator==(const Value& a, const Value& b) {
  if (a.kind_ != b.kind_) return false;
  switch (a.kind_) {
    case Kind::Null:
      return true;
    case Kind::Bool:
      return a.flag_ == b.flag_;
    case Kind::Number:
      return a.number_ == b.number_;
    case Kind::String:
      return a.text_ == b.text_;
    case Kind::Array:
      return a.items_ == b.items_;
    case Kind::Object:
      return a.members_ == b.members_;
  }
  return false;
}

Parsed parse(std::string_view text, int maxDepth) { return Reader(text, maxDepth).run(); }

std::string quote(std::string_view text) {
  std::string out;
  appendQuoted(out, text);
  return out;
}

std::string formatNumber(double number) {
  if (!std::isfinite(number)) return "null";
  if (number == 0) return "0";
  char buffer[40];
  if (std::trunc(number) == number && std::fabs(number) < PLAIN_INTEGER_LIMIT) {
    std::snprintf(buffer, sizeof buffer, "%.0f", number);
    return buffer;
  }
  for (int precision = SHORTEST_PRECISION; precision <= EXACT_PRECISION; ++precision) {
    std::snprintf(buffer, sizeof buffer, "%.*g", precision, number);
    if (std::strtod(buffer, nullptr) == number) break;
  }
  return buffer;
}

}  // namespace json
