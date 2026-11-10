// Port of sdks/rust/genex-multiplayer/src/msgpack.rs. See GenexMsgpack.h.
#include "GenexCore/GenexMsgpack.h"

#include "GenexCore/GenexProtocol.h"

#include <cmath>
#include <cstring>
#include <utility>

namespace genex::msgpack_detail {

using Bytes = std::vector<std::uint8_t>;

void PushBe16(Bytes& out, std::uint16_t v) {
  out.push_back(static_cast<std::uint8_t>(v >> 8));
  out.push_back(static_cast<std::uint8_t>(v));
}

void PushBe32(Bytes& out, std::uint32_t v) {
  out.push_back(static_cast<std::uint8_t>(v >> 24));
  out.push_back(static_cast<std::uint8_t>(v >> 16));
  out.push_back(static_cast<std::uint8_t>(v >> 8));
  out.push_back(static_cast<std::uint8_t>(v));
}

void WriteUint(Bytes& out, std::uint32_t u) {
  if (u < 0x80) {
    out.push_back(static_cast<std::uint8_t>(u));
  } else if (u <= 0xff) {
    out.push_back(0xcc);
    out.push_back(static_cast<std::uint8_t>(u));
  } else if (u <= 0xffff) {
    out.push_back(0xcd);
    PushBe16(out, static_cast<std::uint16_t>(u));
  } else {
    out.push_back(0xce);
    PushBe32(out, u);
  }
}

void WriteInt(Bytes& out, std::int32_t i) {
  // Only called for i < 0.
  if (i >= -32) {
    out.push_back(static_cast<std::uint8_t>(static_cast<std::int8_t>(i)));
  } else if (i >= -128) {
    out.push_back(0xd0);
    out.push_back(static_cast<std::uint8_t>(static_cast<std::int8_t>(i)));
  } else if (i >= -32768) {
    out.push_back(0xd1);
    PushBe16(out, static_cast<std::uint16_t>(static_cast<std::int16_t>(i)));
  } else {
    out.push_back(0xd2);
    PushBe32(out, static_cast<std::uint32_t>(i));
  }
}

void WriteLen(Bytes& out, std::size_t len, std::uint8_t fix, std::uint8_t m16, std::uint8_t m32) {
  if (len < 16) {
    out.push_back(static_cast<std::uint8_t>(fix | len));
  } else if (len <= 0xffff) {
    out.push_back(m16);
    PushBe16(out, static_cast<std::uint16_t>(len));
  } else {
    out.push_back(m32);
    PushBe32(out, static_cast<std::uint32_t>(len));
  }
}

void WriteNumber(Bytes& out, double d) {
  // Integral, not -0, and inside 32 bits: the smallest integer width (msgpackr's choice too).
  if (d == std::floor(d) && !(d == 0.0 && std::signbit(d))) {
    if (d >= 0.0 && d <= 4294967295.0) {
      WriteUint(out, static_cast<std::uint32_t>(d));
      return;
    }
    if (d < 0.0 && d >= -2147483648.0) {
      WriteInt(out, static_cast<std::int32_t>(d));
      return;
    }
  }
  MsgpackWriteF64(out, d);
}

struct Encoder {
  Bytes& out;
  std::size_t nodes = 0;
  MsgpackError failure = MsgpackError::None;

  explicit Encoder(Bytes& sink) : out(sink) {}

  bool Fail(MsgpackError why) {
    failure = why;
    return false;
  }

  bool Str(const std::string& s) {
    if (s.size() > 0xffffffffu) return Fail(MsgpackError::TooLong);
    if (!IsValidUtf8(s)) return Fail(MsgpackError::InvalidUtf8);
    MsgpackWriteStr(out, s);
    return true;
  }

  bool Value(const Json& value, std::size_t depth) {
    if (depth > protocol::limits::kMaxJsonDepth) return Fail(MsgpackError::TooDeep);
    if (++nodes > protocol::limits::kMaxJsonNodes) return Fail(MsgpackError::TooManyNodes);
    switch (value.GetType()) {
      case Json::Type::Null:
        out.push_back(0xc0);
        return true;
      case Json::Type::Bool:
        out.push_back(value.AsBool() ? 0xc3 : 0xc2);
        return true;
      case Json::Type::Number: {
        const double d = value.AsNumber();
        if (!std::isfinite(d)) return Fail(MsgpackError::NonFinite);
        WriteNumber(out, d);
        return true;
      }
      case Json::Type::String:
        return Str(value.AsString());
      case Json::Type::Array: {
        const std::vector<Json>& items = value.Items();
        if (items.size() > 0xffffffffu) return Fail(MsgpackError::TooLong);
        WriteLen(out, items.size(), 0x90, 0xdc, 0xdd);
        for (const Json& item : items) {
          if (!Value(item, depth + 1)) return false;
        }
        return true;
      }
      case Json::Type::Object: {
        const std::vector<JsonMember>& members = value.Members();
        if (members.size() > 0xffffffffu) return Fail(MsgpackError::TooLong);
        WriteLen(out, members.size(), 0x80, 0xde, 0xdf);
        for (const JsonMember& m : members) {
          if (!Str(m.key)) return false;
          if (!Value(m.value, depth + 1)) return false;
        }
        return true;
      }
    }
    return true;
  }
};

/** A decoded value, or the `undefined` extension (absent). */
struct Read {
  bool present = true;
  Json value;
};

struct Decoder {
  const std::uint8_t* bytes;
  std::size_t size;
  std::size_t pos = 0;
  MsgpackError failure = MsgpackError::None;
  std::uint8_t unsupportedByte = 0;

  Decoder(const std::uint8_t* data, std::size_t length) : bytes(data), size(length) {}

  bool Fail(MsgpackError why) {
    failure = why;
    return false;
  }

  bool Take(std::size_t n, const std::uint8_t*& at) {
    if (n > size - pos) return Fail(MsgpackError::Truncated);
    at = bytes + pos;
    pos += n;
    return true;
  }

  bool U8(std::uint8_t& v) {
    const std::uint8_t* at = nullptr;
    if (!Take(1, at)) return false;
    v = at[0];
    return true;
  }

  bool Be(std::size_t n, std::uint64_t& v) {
    const std::uint8_t* at = nullptr;
    if (!Take(n, at)) return false;
    v = 0;
    for (std::size_t i = 0; i < n; ++i) v = (v << 8) | at[i];
    return true;
  }

  bool Str(std::size_t len, Json& out) {
    const std::uint8_t* at = nullptr;
    if (!Take(len, at)) return false;
    const std::string_view text(reinterpret_cast<const char*>(at), len);
    if (!IsValidUtf8(text)) return Fail(MsgpackError::InvalidUtf8);
    out = Json(text);
    return true;
  }

  /** Length prefix of a bin/ext family member: 0 = 8-bit, 1 = 16-bit, 2 = 32-bit. */
  bool LenOf(int width, std::size_t& len) {
    std::uint64_t v = 0;
    const std::size_t n = width == 0 ? 1 : width == 1 ? 2 : 4;
    if (!Be(n, v)) return false;
    len = static_cast<std::size_t>(v);
    return true;
  }

  bool Ext(std::size_t len, Read& out) {
    std::uint8_t kind = 0;
    if (!U8(kind)) return false;
    const std::uint8_t* at = nullptr;
    if (!Take(len, at)) return false;
    out.present = kind != 0;
    out.value = Json();
    return true;
  }

  static Json Float(double f) { return std::isfinite(f) ? Json(f) : Json(); }

  bool Array(std::size_t len, std::size_t depth, Json& out) {
    out = Json::MakeArray();
    for (std::size_t i = 0; i < len; ++i) {
      Read item;
      if (!Value(depth + 1, item)) return false;
      out.Push(item.present ? std::move(item.value) : Json());
    }
    return true;
  }

  bool Map(std::size_t len, std::size_t depth, Json& out) {
    out = Json::MakeObject();
    for (std::size_t i = 0; i < len; ++i) {
      Read key;
      if (!Value(depth + 1, key)) return false;
      std::string name;
      if (!key.present) {
        name.clear();
      } else if (key.value.IsString()) {
        name = key.value.AsString();
      } else {
        name = key.value.Dump();
      }
      Read member;
      if (!Value(depth + 1, member)) return false;
      if (member.present) out.Set(name, std::move(member.value));
    }
    return true;
  }

  bool Value(std::size_t depth, Read& out) {
    if (depth > kMaxDecodeDepth) return Fail(MsgpackError::TooDeep);
    std::uint8_t b = 0;
    if (!U8(b)) return false;
    out.present = true;
    std::uint64_t v = 0;
    std::size_t len = 0;
    if (b <= 0x7f) {
      out.value = Json(static_cast<double>(b));
      return true;
    }
    if (b >= 0xe0) {
      out.value = Json(static_cast<double>(static_cast<std::int8_t>(b)));
      return true;
    }
    if (b >= 0x80 && b <= 0x8f) return Map(b & 0x0f, depth, out.value);
    if (b >= 0x90 && b <= 0x9f) return Array(b & 0x0f, depth, out.value);
    if (b >= 0xa0 && b <= 0xbf) return Str(b & 0x1f, out.value);
    switch (b) {
      case 0xc0:
        out.value = Json();
        return true;
      case 0xc2:
        out.value = Json(false);
        return true;
      case 0xc3:
        out.value = Json(true);
        return true;
      case 0xc4:
      case 0xc5:
      case 0xc6: {
        const std::uint8_t* at = nullptr;
        if (!LenOf(b - 0xc4, len) || !Take(len, at)) return false;
        out.value = Json();
        return true;
      }
      case 0xc7:
      case 0xc8:
      case 0xc9:
        if (!LenOf(b - 0xc7, len)) return false;
        return Ext(len, out);
      case 0xca: {
        if (!Be(4, v)) return false;
        const std::uint32_t bits = static_cast<std::uint32_t>(v);
        float f = 0.0f;
        std::memcpy(&f, &bits, sizeof f);
        out.value = Float(static_cast<double>(f));
        return true;
      }
      case 0xcb: {
        if (!Be(8, v)) return false;
        double d = 0.0;
        std::memcpy(&d, &v, sizeof d);
        out.value = Float(d);
        return true;
      }
      case 0xcc:
        if (!Be(1, v)) return false;
        out.value = Json(static_cast<double>(v));
        return true;
      case 0xcd:
        if (!Be(2, v)) return false;
        out.value = Json(static_cast<double>(v));
        return true;
      case 0xce:
        if (!Be(4, v)) return false;
        out.value = Json(static_cast<double>(v));
        return true;
      case 0xcf:
        if (!Be(8, v)) return false;
        out.value = Json(static_cast<double>(v));
        return true;
      case 0xd0:
        if (!Be(1, v)) return false;
        out.value = Json(static_cast<double>(static_cast<std::int8_t>(static_cast<std::uint8_t>(v))));
        return true;
      case 0xd1:
        if (!Be(2, v)) return false;
        out.value = Json(static_cast<double>(static_cast<std::int16_t>(static_cast<std::uint16_t>(v))));
        return true;
      case 0xd2:
        if (!Be(4, v)) return false;
        out.value = Json(static_cast<double>(static_cast<std::int32_t>(static_cast<std::uint32_t>(v))));
        return true;
      case 0xd3:
        if (!Be(8, v)) return false;
        out.value = Json(static_cast<double>(static_cast<std::int64_t>(v)));
        return true;
      case 0xd4:
        return Ext(1, out);
      case 0xd5:
        return Ext(2, out);
      case 0xd6:
        return Ext(4, out);
      case 0xd7:
        return Ext(8, out);
      case 0xd8:
        return Ext(16, out);
      case 0xd9:
        if (!Be(1, v)) return false;
        return Str(static_cast<std::size_t>(v), out.value);
      case 0xda:
        if (!Be(2, v)) return false;
        return Str(static_cast<std::size_t>(v), out.value);
      case 0xdb:
        if (!Be(4, v)) return false;
        return Str(static_cast<std::size_t>(v), out.value);
      case 0xdc:
        if (!Be(2, v)) return false;
        return Array(static_cast<std::size_t>(v), depth, out.value);
      case 0xdd:
        if (!Be(4, v)) return false;
        return Array(static_cast<std::size_t>(v), depth, out.value);
      case 0xde:
        if (!Be(2, v)) return false;
        return Map(static_cast<std::size_t>(v), depth, out.value);
      case 0xdf:
        if (!Be(4, v)) return false;
        return Map(static_cast<std::size_t>(v), depth, out.value);
      default:
        // 0xc1, the one byte msgpack never assigns.
        unsupportedByte = b;
        return Fail(MsgpackError::Unsupported);
    }
  }
};

std::string Describe(MsgpackError code, std::uint8_t byte) {
  switch (code) {
    case MsgpackError::TooDeep:
      return "payload nests deeper than " + std::to_string(protocol::limits::kMaxJsonDepth);
    case MsgpackError::TooManyNodes:
      return "payload has more than " + std::to_string(protocol::limits::kMaxJsonNodes) + " nodes";
    case MsgpackError::Truncated:
      return "msgpack payload is truncated";
    case MsgpackError::InvalidUtf8:
      return "msgpack string is not UTF-8";
    case MsgpackError::Unsupported: {
      static const char kHex[] = "0123456789abcdef";
      std::string s = "unsupported msgpack byte 0x";
      s.push_back(kHex[byte >> 4]);
      s.push_back(kHex[byte & 0x0f]);
      return s;
    }
    case MsgpackError::NonFinite:
      return "payload holds a NaN or Infinity";
    case MsgpackError::TooLong:
      return "string or collection longer than 2^32-1";
    case MsgpackError::None:
      return "";
  }
  return "";
}

}  // namespace genex::msgpack_detail

namespace genex {

const char* MsgpackErrorName(MsgpackError error) {
  switch (error) {
    case MsgpackError::None:
      return "none";
    case MsgpackError::TooDeep:
      return "too deep";
    case MsgpackError::TooManyNodes:
      return "too many nodes";
    case MsgpackError::Truncated:
      return "truncated";
    case MsgpackError::InvalidUtf8:
      return "invalid utf-8";
    case MsgpackError::Unsupported:
      return "unsupported";
    case MsgpackError::NonFinite:
      return "non-finite";
    case MsgpackError::TooLong:
      return "too long";
  }
  return "unknown";
}

bool EncodeMsgpack(const Json& value, std::vector<std::uint8_t>& out, std::string* error, MsgpackError* code) {
  const std::size_t start = out.size();
  msgpack_detail::Encoder encoder(out);
  const bool ok = encoder.Value(value, 1);
  if (code != nullptr) *code = ok ? MsgpackError::None : encoder.failure;
  if (!ok) {
    out.resize(start);
    if (error != nullptr) *error = msgpack_detail::Describe(encoder.failure, 0);
  }
  return ok;
}

std::optional<Json> DecodeMsgpack(const std::uint8_t* data, std::size_t size, std::string* error,
                                  MsgpackError* code) {
  msgpack_detail::Decoder decoder(data, size);
  msgpack_detail::Read root;
  if (data == nullptr && size != 0) {
    decoder.failure = MsgpackError::Truncated;
  } else if (decoder.Value(0, root)) {
    if (code != nullptr) *code = MsgpackError::None;
    return root.present ? std::move(root.value) : Json();
  }
  if (code != nullptr) *code = decoder.failure;
  if (error != nullptr) *error = msgpack_detail::Describe(decoder.failure, decoder.unsupportedByte);
  return std::nullopt;
}

void MsgpackWriteF64(std::vector<std::uint8_t>& out, double value) {
  std::uint64_t bits = 0;
  std::memcpy(&bits, &value, sizeof bits);
  out.push_back(0xcb);
  for (int shift = 56; shift >= 0; shift -= 8) out.push_back(static_cast<std::uint8_t>(bits >> shift));
}

void MsgpackWriteStr(std::vector<std::uint8_t>& out, std::string_view text) {
  const std::size_t len = text.size();
  if (len < 32) {
    out.push_back(static_cast<std::uint8_t>(0xa0 | len));
  } else if (len <= 0xff) {
    out.push_back(0xd9);
    out.push_back(static_cast<std::uint8_t>(len));
  } else if (len <= 0xffff) {
    out.push_back(0xda);
    msgpack_detail::PushBe16(out, static_cast<std::uint16_t>(len));
  } else {
    out.push_back(0xdb);
    msgpack_detail::PushBe32(out, static_cast<std::uint32_t>(len));
  }
  out.insert(out.end(), text.begin(), text.end());
}

}  // namespace genex
