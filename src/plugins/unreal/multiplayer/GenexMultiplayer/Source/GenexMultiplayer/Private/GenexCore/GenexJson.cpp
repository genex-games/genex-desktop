// genex::Json: value type, strict parser, JS-compatible serializer. See GenexJson.h.
#include "GenexCore/GenexJson.h"

#include <charconv>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <system_error>
#include <utility>

#if defined(_WIN32)
#include <locale.h>
#include <stdlib.h>
#else
#include <locale.h>
#if defined(__APPLE__)
#include <xlocale.h>
#endif
#endif

// ---- which standard-library number conversions are usable ----
// from_chars(double): MSVC STL and libstdc++ >= 11 have it. libc++ only gained it in LLVM 20 and
// Apple marks it unavailable before macOS 26, so libc++ (Apple clang, UE's Linux toolchain) uses
// strtod under a private "C" locale instead (never the process locale: a German locale's decimal
// comma must not turn "1.5" into 1).
// to_chars(double) shortest: MSVC STL, libstdc++ >= 11, libc++ >= 14 (Apple: macOS 13.3+).
// Without it, the shortest digits come from a printf/strtod search (correct, slower).
#if defined(_MSVC_STL_VERSION)
#define GENEX_JSON_FROM_CHARS 1
#define GENEX_JSON_TO_CHARS 1
#elif defined(_GLIBCXX_RELEASE)
#if _GLIBCXX_RELEASE >= 11
#define GENEX_JSON_FROM_CHARS 1
#define GENEX_JSON_TO_CHARS 1
#endif
#elif defined(_LIBCPP_VERSION)
#if _LIBCPP_VERSION >= 14000
#if defined(__APPLE__)
#if defined(__ENVIRONMENT_MAC_OS_X_VERSION_MIN_REQUIRED__)
#if __ENVIRONMENT_MAC_OS_X_VERSION_MIN_REQUIRED__ >= 130300
#define GENEX_JSON_TO_CHARS 1
#endif
#endif
#else
#define GENEX_JSON_TO_CHARS 1
#endif
#endif
#endif
#ifndef GENEX_JSON_FROM_CHARS
#define GENEX_JSON_FROM_CHARS 0
#endif
#ifndef GENEX_JSON_TO_CHARS
#define GENEX_JSON_TO_CHARS 0
#endif

namespace genex::json_detail {

const std::string& EmptyString() {
  static const std::string empty;
  return empty;
}
const std::vector<Json>& EmptyItems() {
  static const std::vector<Json> empty;
  return empty;
}
const std::vector<JsonMember>& EmptyMembers() {
  static const std::vector<JsonMember> empty;
  return empty;
}
const Json& NullValue() {
  static const Json null;
  return null;
}

// ---- UTF-8 ----

/** Length of the well-formed UTF-8 sequence at p (Unicode Table 3-7), or 0 when it is not one. */
std::size_t Utf8SequenceLength(const unsigned char* p, std::size_t avail) {
  if (avail == 0) return 0;
  const unsigned char b0 = p[0];
  if (b0 < 0x80) return 1;
  auto cont = [&](std::size_t i, unsigned char lo, unsigned char hi) {
    return i < avail && p[i] >= lo && p[i] <= hi;
  };
  if (b0 >= 0xC2 && b0 <= 0xDF) return cont(1, 0x80, 0xBF) ? 2 : 0;
  if (b0 == 0xE0) return cont(1, 0xA0, 0xBF) && cont(2, 0x80, 0xBF) ? 3 : 0;
  if ((b0 >= 0xE1 && b0 <= 0xEC) || b0 == 0xEE || b0 == 0xEF) {
    return cont(1, 0x80, 0xBF) && cont(2, 0x80, 0xBF) ? 3 : 0;
  }
  if (b0 == 0xED) return cont(1, 0x80, 0x9F) && cont(2, 0x80, 0xBF) ? 3 : 0;
  if (b0 == 0xF0) return cont(1, 0x90, 0xBF) && cont(2, 0x80, 0xBF) && cont(3, 0x80, 0xBF) ? 4 : 0;
  if (b0 >= 0xF1 && b0 <= 0xF3) {
    return cont(1, 0x80, 0xBF) && cont(2, 0x80, 0xBF) && cont(3, 0x80, 0xBF) ? 4 : 0;
  }
  if (b0 == 0xF4) return cont(1, 0x80, 0x8F) && cont(2, 0x80, 0xBF) && cont(3, 0x80, 0xBF) ? 4 : 0;
  return 0;
}

void AppendUtf8(std::string& out, std::uint32_t cp) {
  if (cp < 0x80) {
    out.push_back(static_cast<char>(cp));
  } else if (cp < 0x800) {
    out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else if (cp < 0x10000) {
    out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  } else {
    out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
    out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
  }
}

// ---- number text → double ----

/** strtod under a private "C" locale (locale-independent, correctly rounded on glibc, Apple and
 *  the UCRT). `text` must be NUL-terminated. */
double CLocaleStrtod(const char* text, char** end) {
#if defined(_WIN32)
  static const _locale_t cLocale = _create_locale(LC_NUMERIC, "C");
  return _strtod_l(text, end, cLocale);
#else
  static const locale_t cLocale = newlocale(LC_NUMERIC_MASK, "C", static_cast<locale_t>(0));
  if (cLocale == static_cast<locale_t>(0)) return std::strtod(text, end);
  const locale_t previous = uselocale(cLocale);
  const double value = std::strtod(text, end);
  uselocale(previous);
  return value;
#endif
}

/** Convert a token that already matched the JSON number grammar. False on overflow (|x| would be
 *  Infinity); underflow yields the correctly rounded subnormal or a signed zero. */
bool NumberFromToken(std::string_view token, double& out) {
#if GENEX_JSON_FROM_CHARS
  double value = 0.0;
  const std::from_chars_result r = std::from_chars(token.data(), token.data() + token.size(), value);
  if (r.ec == std::errc() && r.ptr == token.data() + token.size()) {
    if (!std::isfinite(value)) return false;
    out = value;
    return true;
  }
  // result_out_of_range: overflow, or an underflow some implementations report instead of
  // returning the subnormal. Let strtod decide which, below.
#endif
  std::string copy(token);
  char* end = nullptr;
  const double parsed = CLocaleStrtod(copy.c_str(), &end);
  if (end != copy.c_str() + copy.size()) return false;
  if (!std::isfinite(parsed)) return false;
  out = parsed;
  return true;
}

// ---- double → shortest round-trip digits ----

/** Shortest decimal digits `digits` (no leading/trailing zeros) and exponent `n` with
 *  value = 0.d1d2… × 10^n, for a finite value > 0. Portable search: printf %.{p}e for p = 0..16
 *  until strtod gives the value back. Exposed (not static) so the offline check can compare it
 *  with the to_chars path. */
void ShortestDigitsPortable(double value, std::string& digits, int& n) {
  char buf[64];
  for (int precision = 0; precision <= 16; ++precision) {
    std::snprintf(buf, sizeof buf, "%.*e", precision, value);
    // Rebuild "d.ddde±x" with a '.' whatever the process locale's decimal point is.
    std::string mantissa;
    int exponent = 0;
    const char* p = buf;
    for (; *p != '\0' && *p != 'e' && *p != 'E'; ++p) {
      if (*p >= '0' && *p <= '9') mantissa.push_back(*p);
    }
    if (*p == 'e' || *p == 'E') exponent = std::atoi(p + 1);
    std::string canonical;
    canonical.push_back(mantissa[0]);
    if (mantissa.size() > 1) {
      canonical.push_back('.');
      canonical.append(mantissa, 1, std::string::npos);
    }
    canonical.push_back('e');
    canonical.append(std::to_string(exponent));
    char* end = nullptr;
    if (precision == 16 || CLocaleStrtod(canonical.c_str(), &end) == value) {
      while (mantissa.size() > 1 && mantissa.back() == '0') mantissa.pop_back();
      digits = mantissa;
      n = exponent + 1;
      return;
    }
  }
}

void ShortestDigits(double value, std::string& digits, int& n) {
#if GENEX_JSON_TO_CHARS
  char buf[64];
  const std::to_chars_result r = std::to_chars(buf, buf + sizeof buf, value, std::chars_format::scientific);
  if (r.ec == std::errc()) {
    digits.clear();
    const char* p = buf;
    for (; p < r.ptr && *p != 'e'; ++p) {
      if (*p != '.') digits.push_back(*p);
    }
    int exponent = 0;
    if (p < r.ptr) {
      ++p;
      bool negative = false;
      if (p < r.ptr && (*p == '+' || *p == '-')) {
        negative = *p == '-';
        ++p;
      }
      for (; p < r.ptr; ++p) exponent = exponent * 10 + (*p - '0');
      if (negative) exponent = -exponent;
    }
    while (digits.size() > 1 && digits.back() == '0') digits.pop_back();
    n = exponent + 1;
    return;
  }
#endif
  ShortestDigitsPortable(value, digits, n);
}

// ---- parser ----

struct Parser {
  std::string_view text;
  const JsonLimits& limits;
  std::size_t pos = 0;
  std::size_t nodes = 0;
  const char* reason = nullptr;
  std::size_t reasonAt = 0;

  Parser(std::string_view input, const JsonLimits& bounds) : text(input), limits(bounds) {}

  bool Fail(const char* why) {
    if (reason == nullptr) {
      reason = why;
      reasonAt = pos;
    }
    return false;
  }
  bool AtEnd() const { return pos >= text.size(); }
  unsigned char Peek() const { return static_cast<unsigned char>(text[pos]); }

  void SkipWhitespace() {
    while (!AtEnd()) {
      const char c = text[pos];
      if (c != ' ' && c != '\t' && c != '\n' && c != '\r') break;
      ++pos;
    }
  }

  bool Literal(const char* word) {
    const std::size_t len = std::strlen(word);
    if (text.size() - pos < len || text.compare(pos, len, word) != 0) return Fail("invalid literal");
    pos += len;
    return true;
  }

  bool Hex4(std::uint32_t& out) {
    if (text.size() - pos < 4) return Fail("truncated \\u escape");
    std::uint32_t v = 0;
    for (int i = 0; i < 4; ++i) {
      const char c = text[pos + static_cast<std::size_t>(i)];
      v <<= 4;
      if (c >= '0' && c <= '9') {
        v |= static_cast<std::uint32_t>(c - '0');
      } else if (c >= 'a' && c <= 'f') {
        v |= static_cast<std::uint32_t>(c - 'a' + 10);
      } else if (c >= 'A' && c <= 'F') {
        v |= static_cast<std::uint32_t>(c - 'A' + 10);
      } else {
        return Fail("invalid \\u escape");
      }
    }
    pos += 4;
    out = v;
    return true;
  }

  bool String(std::string& out) {
    // At the opening quote.
    ++pos;
    while (true) {
      if (AtEnd()) return Fail("unterminated string");
      const unsigned char c = Peek();
      if (c == '"') {
        ++pos;
        return true;
      }
      if (c < 0x20) return Fail("control character in string");
      if (c == '\\') {
        ++pos;
        if (AtEnd()) return Fail("unterminated string");
        const char e = text[pos++];
        switch (e) {
          case '"':
            out.push_back('"');
            break;
          case '\\':
            out.push_back('\\');
            break;
          case '/':
            out.push_back('/');
            break;
          case 'b':
            out.push_back('\b');
            break;
          case 'f':
            out.push_back('\f');
            break;
          case 'n':
            out.push_back('\n');
            break;
          case 'r':
            out.push_back('\r');
            break;
          case 't':
            out.push_back('\t');
            break;
          case 'u': {
            std::uint32_t cp = 0;
            if (!Hex4(cp)) return false;
            if (cp >= 0xDC00 && cp <= 0xDFFF) return Fail("lone low surrogate");
            if (cp >= 0xD800 && cp <= 0xDBFF) {
              if (text.size() - pos < 2 || text[pos] != '\\' || text[pos + 1] != 'u') {
                return Fail("lone high surrogate");
              }
              pos += 2;
              std::uint32_t low = 0;
              if (!Hex4(low)) return false;
              if (low < 0xDC00 || low > 0xDFFF) return Fail("lone high surrogate");
              cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
            }
            AppendUtf8(out, cp);
            break;
          }
          default:
            --pos;
            return Fail("invalid escape");
        }
        continue;
      }
      if (c < 0x80) {
        out.push_back(static_cast<char>(c));
        ++pos;
        continue;
      }
      const std::size_t len =
          Utf8SequenceLength(reinterpret_cast<const unsigned char*>(text.data()) + pos, text.size() - pos);
      if (len == 0) return Fail("invalid UTF-8");
      out.append(text.data() + pos, len);
      pos += len;
    }
  }

  bool Number(double& out) {
    const std::size_t start = pos;
    auto digit = [&]() { return !AtEnd() && text[pos] >= '0' && text[pos] <= '9'; };
    if (!AtEnd() && text[pos] == '-') ++pos;
    if (!digit()) return Fail("invalid number");
    if (text[pos] == '0') {
      ++pos;
      if (digit()) return Fail("leading zero");
    } else {
      while (digit()) ++pos;
    }
    if (!AtEnd() && text[pos] == '.') {
      ++pos;
      if (!digit()) return Fail("invalid number");
      while (digit()) ++pos;
    }
    if (!AtEnd() && (text[pos] == 'e' || text[pos] == 'E')) {
      ++pos;
      if (!AtEnd() && (text[pos] == '+' || text[pos] == '-')) ++pos;
      if (!digit()) return Fail("invalid number");
      while (digit()) ++pos;
    }
    if (!NumberFromToken(text.substr(start, pos - start), out)) {
      pos = start;
      return Fail("number out of range");
    }
    return true;
  }

  bool Value(Json& out, std::size_t depth) {
    if (depth > limits.maxDepth) return Fail("nesting too deep");
    if (++nodes > limits.maxNodes) return Fail("too many values");
    if (AtEnd()) return Fail("unexpected end of input");
    const char c = text[pos];
    switch (c) {
      case 'n':
        if (!Literal("null")) return false;
        out = Json();
        return true;
      case 't':
        if (!Literal("true")) return false;
        out = Json(true);
        return true;
      case 'f':
        if (!Literal("false")) return false;
        out = Json(false);
        return true;
      case '"': {
        std::string s;
        if (!String(s)) return false;
        out = Json(std::move(s));
        return true;
      }
      case '[': {
        ++pos;
        out = Json::MakeArray();
        SkipWhitespace();
        if (!AtEnd() && text[pos] == ']') {
          ++pos;
          return true;
        }
        while (true) {
          SkipWhitespace();
          Json item;
          if (!Value(item, depth + 1)) return false;
          out.Push(std::move(item));
          SkipWhitespace();
          if (AtEnd()) return Fail("unterminated array");
          if (text[pos] == ',') {
            ++pos;
            continue;
          }
          if (text[pos] == ']') {
            ++pos;
            return true;
          }
          return Fail("expected ',' or ']'");
        }
      }
      case '{': {
        ++pos;
        out = Json::MakeObject();
        SkipWhitespace();
        if (!AtEnd() && text[pos] == '}') {
          ++pos;
          return true;
        }
        while (true) {
          SkipWhitespace();
          if (AtEnd() || text[pos] != '"') return Fail("expected a string key");
          std::string key;
          if (!String(key)) return false;
          SkipWhitespace();
          if (AtEnd() || text[pos] != ':') return Fail("expected ':'");
          ++pos;
          SkipWhitespace();
          Json member;
          if (!Value(member, depth + 1)) return false;
          out.Set(key, std::move(member));
          SkipWhitespace();
          if (AtEnd()) return Fail("unterminated object");
          if (text[pos] == ',') {
            ++pos;
            continue;
          }
          if (text[pos] == '}') {
            ++pos;
            return true;
          }
          return Fail("expected ',' or '}'");
        }
      }
      default:
        if (c == '-' || (c >= '0' && c <= '9')) {
          double v = 0.0;
          if (!Number(v)) return false;
          out = Json(v);
          return true;
        }
        return Fail("unexpected character");
    }
  }
};

// ---- serializer ----

void DumpValue(const Json& value, std::string& out) {
  switch (value.GetType()) {
    case Json::Type::Null:
      out.append("null");
      return;
    case Json::Type::Bool:
      out.append(value.AsBool() ? "true" : "false");
      return;
    case Json::Type::Number:
      AppendJsonNumber(out, value.AsNumber());
      return;
    case Json::Type::String:
      AppendJsonString(out, value.AsString());
      return;
    case Json::Type::Array: {
      out.push_back('[');
      bool first = true;
      for (const Json& item : value.Items()) {
        if (!first) out.push_back(',');
        first = false;
        DumpValue(item, out);
      }
      out.push_back(']');
      return;
    }
    case Json::Type::Object: {
      out.push_back('{');
      bool first = true;
      for (const JsonMember& m : value.Members()) {
        if (!first) out.push_back(',');
        first = false;
        AppendJsonString(out, m.key);
        out.push_back(':');
        DumpValue(m.value, out);
      }
      out.push_back('}');
      return;
    }
  }
}

}  // namespace genex::json_detail

namespace genex {

Json::Json() = default;
Json::Json(std::nullptr_t) {}
Json::Json(bool value) : type_(Type::Bool), bool_(value) {}
Json::Json(NumberTag, double value) : type_(Type::Number), number_(value) {}
Json::Json(const char* value) : type_(Type::String), string_(value != nullptr ? value : "") {}
Json::Json(std::string_view value) : type_(Type::String), string_(value) {}
Json::Json(std::string value) : type_(Type::String), string_(std::move(value)) {}

Json Json::MakeArray() {
  Json j;
  j.type_ = Type::Array;
  return j;
}

Json Json::MakeObject() {
  Json j;
  j.type_ = Type::Object;
  return j;
}

const std::string& Json::AsString() const {
  return type_ == Type::String ? string_ : json_detail::EmptyString();
}

std::size_t Json::Size() const {
  if (type_ == Type::Array) return array_.size();
  if (type_ == Type::Object) return object_.size();
  return 0;
}

void Json::BecomeObject() {
  if (type_ == Type::Object) return;
  *this = MakeObject();
}

void Json::BecomeArray() {
  if (type_ == Type::Array) return;
  *this = MakeArray();
}

void Json::RebuildIndex() {
  index_.clear();
  if (object_.size() <= kJsonIndexThreshold) return;
  for (std::size_t i = 0; i < object_.size(); ++i) index_.emplace(object_[i].key, i);
}

void Json::IndexInsert(std::size_t position) {
  if (object_.size() <= kJsonIndexThreshold) return;
  if (index_.empty()) {
    RebuildIndex();
  } else {
    index_.emplace(object_[position].key, position);
  }
}

const Json* Json::Find(std::string_view key) const {
  if (type_ != Type::Object) return nullptr;
  if (!index_.empty()) {
    const auto it = index_.find(key);
    return it == index_.end() ? nullptr : &object_[it->second].value;
  }
  for (const JsonMember& m : object_) {
    if (m.key == key) return &m.value;
  }
  return nullptr;
}

Json* Json::Find(std::string_view key) {
  return const_cast<Json*>(static_cast<const Json*>(this)->Find(key));
}

Json& Json::operator[](std::string_view key) {
  BecomeObject();
  if (Json* existing = Find(key)) return *existing;
  object_.push_back(JsonMember{std::string(key), Json()});
  IndexInsert(object_.size() - 1);
  return object_.back().value;
}

Json& Json::Set(std::string_view key, Json value) {
  Json& slot = (*this)[key];
  slot = std::move(value);
  return slot;
}

bool Json::Erase(std::string_view key) {
  if (type_ != Type::Object) return false;
  for (std::size_t i = 0; i < object_.size(); ++i) {
    if (object_[i].key == key) {
      object_.erase(object_.begin() + static_cast<std::ptrdiff_t>(i));
      RebuildIndex();
      return true;
    }
  }
  return false;
}

const std::vector<JsonMember>& Json::Members() const {
  return type_ == Type::Object ? object_ : json_detail::EmptyMembers();
}

Json& Json::Push(Json value) {
  BecomeArray();
  array_.push_back(std::move(value));
  return array_.back();
}

const Json& Json::At(std::size_t index) const {
  if (type_ != Type::Array || index >= array_.size()) return json_detail::NullValue();
  return array_[index];
}

Json* Json::AtMut(std::size_t index) {
  if (type_ != Type::Array || index >= array_.size()) return nullptr;
  return &array_[index];
}

const std::vector<Json>& Json::Items() const {
  return type_ == Type::Array ? array_ : json_detail::EmptyItems();
}

bool Json::Equals(const Json& other) const {
  if (type_ != other.type_) return false;
  switch (type_) {
    case Type::Null:
      return true;
    case Type::Bool:
      return bool_ == other.bool_;
    case Type::Number:
      return number_ == other.number_;
    case Type::String:
      return string_ == other.string_;
    case Type::Array:
      if (array_.size() != other.array_.size()) return false;
      for (std::size_t i = 0; i < array_.size(); ++i) {
        if (!array_[i].Equals(other.array_[i])) return false;
      }
      return true;
    case Type::Object:
      if (object_.size() != other.object_.size()) return false;
      for (const JsonMember& m : object_) {
        const Json* theirs = other.Find(m.key);
        if (theirs == nullptr || !m.value.Equals(*theirs)) return false;
      }
      return true;
  }
  return false;
}

std::string Json::Dump() const {
  std::string out;
  DumpTo(out);
  return out;
}

void Json::DumpTo(std::string& out) const { json_detail::DumpValue(*this, out); }

std::optional<Json> Json::Parse(std::string_view text, std::string* error, const JsonLimits& limits) {
  json_detail::Parser parser(text, limits);
  if (text.size() > limits.maxBytes) {
    if (error != nullptr) *error = "text exceeds " + std::to_string(limits.maxBytes) + " bytes";
    return std::nullopt;
  }
  Json root;
  parser.SkipWhitespace();
  bool ok = parser.Value(root, 1);
  if (ok) {
    parser.SkipWhitespace();
    if (!parser.AtEnd()) ok = parser.Fail("trailing characters");
  }
  if (!ok) {
    if (error != nullptr) {
      *error = std::string(parser.reason != nullptr ? parser.reason : "invalid JSON") + " at byte " +
               std::to_string(parser.reasonAt);
    }
    return std::nullopt;
  }
  return root;
}

bool IsValidUtf8(std::string_view text) {
  const unsigned char* p = reinterpret_cast<const unsigned char*>(text.data());
  std::size_t i = 0;
  while (i < text.size()) {
    if (p[i] < 0x80) {
      ++i;
      continue;
    }
    const std::size_t len = json_detail::Utf8SequenceLength(p + i, text.size() - i);
    if (len == 0) return false;
    i += len;
  }
  return true;
}

void AppendJsonNumber(std::string& out, double value) {
  if (!std::isfinite(value)) {
    out.append("null");
    return;
  }
  if (value == 0.0) {
    out.push_back('0');  // JSON.stringify(-0) === "0"
    return;
  }
  if (value < 0) {
    out.push_back('-');
    value = -value;
  }
  // ECMAScript Number::toString(10): value = 0.digits × 10^n, k = digit count.
  std::string digits;
  int n = 0;
  json_detail::ShortestDigits(value, digits, n);
  const int k = static_cast<int>(digits.size());
  if (k <= n && n <= 21) {
    out.append(digits);
    out.append(static_cast<std::size_t>(n - k), '0');
  } else if (0 < n && n <= 21) {
    out.append(digits, 0, static_cast<std::size_t>(n));
    out.push_back('.');
    out.append(digits, static_cast<std::size_t>(n), std::string::npos);
  } else if (-6 < n && n <= 0) {
    out.append("0.");
    out.append(static_cast<std::size_t>(-n), '0');
    out.append(digits);
  } else {
    const int e = n - 1;
    out.push_back(digits[0]);
    if (k > 1) {
      out.push_back('.');
      out.append(digits, 1, std::string::npos);
    }
    out.push_back('e');
    out.push_back(e >= 0 ? '+' : '-');
    out.append(std::to_string(e >= 0 ? e : -e));
  }
}

void AppendJsonString(std::string& out, std::string_view text) {
  static const char kHex[] = "0123456789abcdef";
  out.push_back('"');
  const unsigned char* p = reinterpret_cast<const unsigned char*>(text.data());
  std::size_t i = 0;
  while (i < text.size()) {
    const unsigned char c = p[i];
    if (c >= 0x80) {
      const std::size_t len = json_detail::Utf8SequenceLength(p + i, text.size() - i);
      if (len == 0) {
        out.append("\xEF\xBF\xBD");  // U+FFFD for each invalid byte
        ++i;
      } else {
        out.append(text.data() + i, len);
        i += len;
      }
      continue;
    }
    switch (c) {
      case '"':
        out.append("\\\"");
        break;
      case '\\':
        out.append("\\\\");
        break;
      case '\b':
        out.append("\\b");
        break;
      case '\f':
        out.append("\\f");
        break;
      case '\n':
        out.append("\\n");
        break;
      case '\r':
        out.append("\\r");
        break;
      case '\t':
        out.append("\\t");
        break;
      default:
        if (c < 0x20) {
          out.append("\\u00");
          out.push_back(kHex[c >> 4]);
          out.push_back(kHex[c & 0x0F]);
        } else {
          out.push_back(static_cast<char>(c));
        }
        break;
    }
    ++i;
  }
  out.push_back('"');
}

}  // namespace genex
