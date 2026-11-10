// See GenexFastRecords.h (packages/multiplayer/src/authority/fast-records.ts, in its order). The
// quantize and dequantize are the schema's arithmetic, so this file is unfused (GENEX_FP_STRICT_BEGIN).
#include "GenexCore/GenexFastRecords.h"

#include <cmath>
#include <cstring>
#include <iterator>
#include <optional>
#include <vector>

GENEX_FP_STRICT_BEGIN

namespace genex::fast {

namespace records_detail {

constexpr std::size_t kHead = 2;
constexpr std::size_t kMaskBytes = 4;
constexpr double kUint32Max = 4294967295.0;
constexpr double kUint16Max = 65535.0;
/** The schema's clamp span on a symmetric range: 2^16 − 2, so 0 lands on a step (code 32767). */
constexpr double kQSpan = 65534;
constexpr double kQZero = kQSpan / 2;
constexpr double kOrientationHalf = 1;
constexpr double kVelocityHalf = 64;

bool IsUint(double v, double max) { return std::isfinite(v) && std::floor(v) == v && v >= 0 && v <= max; }

std::size_t WidthOf(Wire wire) {
  switch (wire) {
    case Wire::F32:
    case Wire::U32: return 4;
    case Wire::U16:
    case Wire::Orientation:
    case Wire::Velocity: return 2;
    case Wire::Flag: return 0;
  }
  return 0;
}

double HalfOf(Wire wire) { return wire == Wire::Orientation ? kOrientationHalf : kVelocityHalf; }

/** A field's wire value: none at its default, nullopt-with-refusal when it cannot be written. */
struct WireValue {
  bool refused = false;
  bool present = false;
  double value = 0;
};

WireValue WireValueOf(Wire wire, double v) {
  switch (wire) {
    case Wire::F32: {
      const float f = static_cast<float>(v);
      if (!std::isfinite(f)) return {true, false, 0};
      return {false, f != 0, static_cast<double>(f)};
    }
    case Wire::U32:
      if (!IsUint(v, kUint32Max)) return {true, false, 0};
      return {false, v != 0, v};
    case Wire::U16:
      if (!IsUint(v, kUint16Max)) return {true, false, 0};
      return {false, v != 0, v};
    case Wire::Flag: return {false, v != 0, 1};
    case Wire::Orientation:
    case Wire::Velocity: {
      if (std::isnan(v)) return {true, false, 0};
      const double code = QuantizeCode(HalfOf(wire), v);
      return {false, code != kQZero, code};
    }
  }
  return {true, false, 0};
}

void PutU32(Bytes& out, std::size_t at, std::uint32_t x) {
  for (int i = 0; i < 4; i += 1) out[at + static_cast<std::size_t>(i)] = static_cast<std::uint8_t>((x >> (8 * i)) & 0xff);
}

std::uint32_t GetU32(const std::uint8_t* d, std::size_t at) {
  return static_cast<std::uint32_t>(d[at]) | (static_cast<std::uint32_t>(d[at + 1]) << 8) |
         (static_cast<std::uint32_t>(d[at + 2]) << 16) | (static_cast<std::uint32_t>(d[at + 3]) << 24);
}

void WriteField(Bytes& out, std::size_t at, Wire wire, double value) {
  if (wire == Wire::F32) {
    const float f = static_cast<float>(value);
    std::uint32_t bits = 0;
    std::memcpy(&bits, &f, sizeof bits);
    PutU32(out, at, bits);
  } else if (wire == Wire::U32) {
    PutU32(out, at, static_cast<std::uint32_t>(value));
  } else if (wire != Wire::Flag) {
    const auto x = static_cast<std::uint16_t>(value);
    out[at] = static_cast<std::uint8_t>(x & 0xff);
    out[at + 1] = static_cast<std::uint8_t>(x >> 8);
  }
}

/** One field read back: its value, or the fault that drops the record. */
Result<double> ReadField(const std::uint8_t* d, std::size_t length, std::size_t at, Wire wire) {
  Result<double> r;
  if (at + WidthOf(wire) > length) {
    r.fault = Fault::Truncated;
    return r;
  }
  r.fault = Fault::Field;
  switch (wire) {
    case Wire::Flag: r.value = 1; return r;
    case Wire::F32: {
      const std::uint32_t bits = GetU32(d, at);
      float f = 0;
      std::memcpy(&f, &bits, sizeof f);
      if (std::isfinite(f) && f != 0) r.value = static_cast<double>(f);
      return r;
    }
    case Wire::U32: {
      const double v = GetU32(d, at);
      if (v != 0) r.value = v;
      return r;
    }
    case Wire::U16:
    case Wire::Orientation:
    case Wire::Velocity: {
      const double code = static_cast<double>(d[at] | (d[at + 1] << 8));
      if (wire == Wire::U16) {
        if (code != 0) r.value = code;
        return r;
      }
      if (code != kQZero && code <= kQSpan) r.value = DequantizeCode(HalfOf(wire), code);
      return r;
    }
  }
  return r;
}

/** The UTF-16 length of strict UTF-8 `s[0, n)` (TextDecoder `fatal`), with a leading BOM dropped into
 *  `skip` (TextDecoder strips it); nullopt for malformed UTF-8. */
std::optional<std::size_t> Utf16Length(const std::uint8_t* s, std::size_t n, std::size_t* skip) {
  std::size_t units = 0;
  std::size_t i = 0;
  if (skip != nullptr) *skip = 0;
  while (i < n) {
    const std::uint8_t b = s[i];
    std::size_t extra = 0;
    std::uint8_t lo = 0x80;
    std::uint8_t hi = 0xbf;
    std::uint32_t cp = 0;
    if (b < 0x80) {
      cp = b;
    } else if (b >= 0xc2 && b <= 0xdf) {
      extra = 1;
      cp = b & 0x1f;
    } else if (b >= 0xe0 && b <= 0xef) {
      extra = 2;
      cp = b & 0x0f;
      if (b == 0xe0) lo = 0xa0;
      if (b == 0xed) hi = 0x9f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      extra = 3;
      cp = b & 0x07;
      if (b == 0xf0) lo = 0x90;
      if (b == 0xf4) hi = 0x8f;
    } else {
      return std::nullopt;
    }
    for (std::size_t k = 1; k <= extra; k += 1) {
      if (i + k >= n) return std::nullopt;
      const std::uint8_t c = s[i + k];
      const std::uint8_t min = k == 1 ? lo : 0x80;
      const std::uint8_t max = k == 1 ? hi : 0xbf;
      if (c < min || c > max) return std::nullopt;
      cp = (cp << 6) | (c & 0x3f);
    }
    const bool bom = i == 0 && cp == 0xfeff && skip != nullptr;
    if (bom) {
      *skip = extra + 1;
    } else {
      units += cp >= 0x10000 ? 2 : 1;
    }
    i += extra + 1;
  }
  return units;
}

/** `flag` is the value of the table's member-less field (the entity's `sleep`). */
template <typename Motion, typename Field, std::size_t N>
Result<Bytes> Encode(const MotionRecord& record, const Motion& motion, const Field (&fields)[N], bool flag) {
  Result<Bytes> refused;
  refused.fault = Fault::Field;
  const auto* id = reinterpret_cast<const std::uint8_t*>(record.id.data());
  const std::optional<std::size_t> units = Utf16Length(id, record.id.size(), nullptr);
  const bool idOk = units && *units >= 1 && *units <= kRecordIdMaxChars && record.id.size() <= 0xff;
  if (!idOk) return refused;
  std::uint32_t mask = 0;
  std::vector<std::pair<Wire, double>> present;
  for (std::size_t i = 0; i < N; i += 1) {
    const double v = fields[i].member == nullptr ? (flag ? 1.0 : 0.0) : motion.*(fields[i].member);
    const WireValue w = WireValueOf(fields[i].wire, v);
    if (w.refused) return refused;
    if (!w.present) continue;
    mask |= static_cast<std::uint32_t>(1u << i);
    present.emplace_back(fields[i].wire, w.value);
  }
  std::size_t size = kHead + record.id.size() + kMaskBytes;
  for (const auto& [wire, value] : present) size += WidthOf(wire);
  Bytes out(size);
  out[0] = static_cast<std::uint8_t>(record.kind);
  out[1] = static_cast<std::uint8_t>(record.id.size());
  std::memcpy(out.data() + kHead, record.id.data(), record.id.size());
  std::size_t at = kHead + record.id.size();
  PutU32(out, at, mask);
  at += kMaskBytes;
  for (const auto& [wire, value] : present) {
    WriteField(out, at, wire, value);
    at += WidthOf(wire);
  }
  Result<Bytes> ok;
  ok.value = std::move(out);
  return ok;
}

/** The present fields of `mask` read from `start` into `motion`, which must end the record exactly. */
template <typename Motion, typename Field, std::size_t N, typename SetFlag>
std::optional<Fault> ReadMotion(const std::uint8_t* d, std::size_t length, std::size_t start, std::uint32_t mask, Motion& motion,
                                const Field (&fields)[N], SetFlag setFlag) {
  std::size_t at = start;
  for (std::size_t i = 0; i < N; i += 1) {
    if ((mask & (1u << i)) == 0) continue;
    const Result<double> v = ReadField(d, length, at, fields[i].wire);
    if (!v.Ok()) return v.fault;
    if (fields[i].member == nullptr) {
      setFlag(motion);
    } else {
      motion.*(fields[i].member) = *v.value;
    }
    at += WidthOf(fields[i].wire);
  }
  if (at != length) return Fault::Trailing;
  return std::nullopt;
}

}  // namespace records_detail

namespace rd = records_detail;

double QuantizeCode(double half, double value) {
  const double v = (std::min)(half, (std::max)(-half, value));
  return std::floor(((v + half) / (2 * half)) * rd::kQSpan + 0.5);
}

double DequantizeCode(double half, double code) { return -half + (code / rd::kQSpan) * (2 * half); }

Result<Bytes> EncodeRecord(const MotionRecord& record) {
  if (record.kind == RecordKind::Entity) return rd::Encode(record, record.entity, rd::kEntityFields, record.entity.sleep);
  if (record.kind == RecordKind::Seat) return rd::Encode(record, record.seat, rd::kSeatFields, false);
  Result<Bytes> refused;
  refused.fault = Fault::Field;
  return refused;
}

Result<MotionRecord> DecodeRecord(const std::uint8_t* data, std::size_t length) {
  Result<MotionRecord> r;
  if (length < rd::kHead) {
    r.fault = Fault::Truncated;
    return r;
  }
  const std::uint8_t kind = data[0];
  if (kind != static_cast<std::uint8_t>(RecordKind::Entity) && kind != static_cast<std::uint8_t>(RecordKind::Seat)) {
    r.fault = Fault::Kind;
    return r;
  }
  const std::size_t len = data[1];
  if (rd::kHead + len > length) {
    r.fault = Fault::Truncated;
    return r;
  }
  std::size_t skip = 0;
  const std::optional<std::size_t> units = len == 0 ? std::nullopt : rd::Utf16Length(data + rd::kHead, len, &skip);
  if (!units || *units > kRecordIdMaxChars) {
    r.fault = Fault::Field;
    return r;
  }
  MotionRecord record;
  record.kind = static_cast<RecordKind>(kind);
  record.id.assign(reinterpret_cast<const char*>(data + rd::kHead + skip), len - skip);
  std::size_t at = rd::kHead + len;
  if (at + rd::kMaskBytes > length) {
    r.fault = Fault::Truncated;
    return r;
  }
  const std::uint32_t mask = rd::GetU32(data, at);
  at += rd::kMaskBytes;
  const std::size_t fieldCount = record.kind == RecordKind::Entity ? std::size(rd::kEntityFields) : std::size(rd::kSeatFields);
  if (fieldCount < 32 && (mask >> fieldCount) != 0) {
    r.fault = Fault::Flags;
    return r;
  }
  const std::optional<Fault> fault =
      record.kind == RecordKind::Entity
          ? rd::ReadMotion(data, length, at, mask, record.entity, rd::kEntityFields, [](EntityMotion& m) { m.sleep = true; })
          : rd::ReadMotion(data, length, at, mask, record.seat, rd::kSeatFields, [](SeatEcho&) {});
  if (fault) {
    r.fault = *fault;
    return r;
  }
  r.value = std::move(record);
  return r;
}

}  // namespace genex::fast

GENEX_FP_STRICT_END
