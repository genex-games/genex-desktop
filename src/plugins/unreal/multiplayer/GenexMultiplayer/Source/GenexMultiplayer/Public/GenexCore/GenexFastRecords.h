// The fast channel's motion records (PROTOCOL.md §17.12 *Motion records*): the bytes one entity or one
// seat writes in a snapshot record. A record is `kind` uint8, `idLen` uint8 and that many UTF-8 bytes of
// the id, a `mask` uint32 naming the fields present, then each present field in table order. A field at
// its default (0, false) is left out, so the encoding is canonical. The quantized body fields are the
// schema's own uint16 codes (clamp, symmetric range, span 2^16 − 2, half-up), so a fast seat decodes
// exactly the value a WebSocket seat decodes.
//
// Port of packages/multiplayer/src/authority/fast-records.ts, held to the `records` and record hostile
// rows of packages/multiplayer/test/vectors/fast-transport.json by genex_fast_transport_check. Pure.
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexFastTransport.h"

#include <cstddef>
#include <cstdint>
#include <string>

namespace genex::fast {

/** What a record describes, the first byte. */
enum class RecordKind : std::uint8_t { Entity = 1, Seat = 2 };

/** An entity's motion fields (AuthorityEntity, §17.3, §17.7, §17.10), each at its default when absent. */
struct EntityMotion {
  double x = 0, y = 0, z = 0, vx = 0, vy = 0, vz = 0, yaw = 0, pitch = 0, duck = 0, spin = 0, fuel = 0;
  double epoch = 0, mstate = 0;
  double qx = 0, qy = 0, qz = 0, qw = 0;
  double lvx = 0, lvy = 0, lvz = 0, avx = 0, avy = 0, avz = 0;
  bool sleep = false;
  double rest = 0;
};

/** A seat's input echo and pacing counters (AuthorityPlayer `in*`, §17.11), each 0 when absent. */
struct SeatEcho {
  double inMoveX = 0, inMoveY = 0, inMoveZ = 0, inYaw = 0, inPitch = 0;
  double inButtons = 0, inRep = 0, inStarve = 0, inBuf = 0;
  /** The receiving seat's own record only: its last input the server consumed as of this snapshot. */
  double inAck = 0;
};

/** One motion record: an entity's (`entity`) or a seat's (`seat`), by its id; the other part is unused. */
struct MotionRecord {
  RecordKind kind = RecordKind::Entity;
  std::string id;
  EntityMotion entity;
  SeatEcho seat;
};

/** The longest id a record carries, in characters (UTF-16 code units, as the reference counts them). */
constexpr std::size_t kRecordIdMaxChars = 64;

/** The schema's quantize on a symmetric clamped range of half-width `half`: the uint16 code. */
GENEX_CORE_API double QuantizeCode(double half, double value);
/** The schema's dequantize: the value a decoder reads for `code`. */
GENEX_CORE_API double DequantizeCode(double half, double code);

/** The record's bytes; refuses (`field`) what it cannot carry. */
GENEX_CORE_API Result<Bytes> EncodeRecord(const MotionRecord& record);

/** Reads one record to the byte; any fault drops it. Every field left out reads as its default. */
GENEX_CORE_API Result<MotionRecord> DecodeRecord(const std::uint8_t* data, std::size_t length);

/** Calls `fn(name, value)` for every motion field of `record`'s kind in table order (sleep as 0 or 1). */
template <typename Fn>
void ForEachMotionField(const MotionRecord& record, Fn fn);

// ---- the field tables (appended only, never reordered) ----

namespace records_detail {
/** How a field is written. */
enum class Wire : std::uint8_t { F32, U32, U16, Orientation, Velocity, Flag };
struct EntityField {
  const char* name;
  Wire wire;
  double EntityMotion::*member;  // nullptr for `sleep`
};
struct SeatField {
  const char* name;
  Wire wire;
  double SeatEcho::*member;
};
inline constexpr EntityField kEntityFields[] = {
    {"x", Wire::F32, &EntityMotion::x},
    {"y", Wire::F32, &EntityMotion::y},
    {"z", Wire::F32, &EntityMotion::z},
    {"vx", Wire::F32, &EntityMotion::vx},
    {"vy", Wire::F32, &EntityMotion::vy},
    {"vz", Wire::F32, &EntityMotion::vz},
    {"yaw", Wire::F32, &EntityMotion::yaw},
    {"pitch", Wire::F32, &EntityMotion::pitch},
    {"duck", Wire::F32, &EntityMotion::duck},
    {"spin", Wire::F32, &EntityMotion::spin},
    {"fuel", Wire::F32, &EntityMotion::fuel},
    {"epoch", Wire::U32, &EntityMotion::epoch},
    {"mstate", Wire::U32, &EntityMotion::mstate},
    {"qx", Wire::Orientation, &EntityMotion::qx},
    {"qy", Wire::Orientation, &EntityMotion::qy},
    {"qz", Wire::Orientation, &EntityMotion::qz},
    {"qw", Wire::Orientation, &EntityMotion::qw},
    {"lvx", Wire::Velocity, &EntityMotion::lvx},
    {"lvy", Wire::Velocity, &EntityMotion::lvy},
    {"lvz", Wire::Velocity, &EntityMotion::lvz},
    {"avx", Wire::Velocity, &EntityMotion::avx},
    {"avy", Wire::Velocity, &EntityMotion::avy},
    {"avz", Wire::Velocity, &EntityMotion::avz},
    {"sleep", Wire::Flag, nullptr},
    {"rest", Wire::U16, &EntityMotion::rest},
};
inline constexpr SeatField kSeatFields[] = {
    {"inMoveX", Wire::F32, &SeatEcho::inMoveX},     {"inMoveY", Wire::F32, &SeatEcho::inMoveY},
    {"inMoveZ", Wire::F32, &SeatEcho::inMoveZ},     {"inYaw", Wire::F32, &SeatEcho::inYaw},
    {"inPitch", Wire::F32, &SeatEcho::inPitch},     {"inButtons", Wire::U32, &SeatEcho::inButtons},
    {"inRep", Wire::U32, &SeatEcho::inRep},         {"inStarve", Wire::U32, &SeatEcho::inStarve},
    {"inBuf", Wire::U32, &SeatEcho::inBuf},         {"inAck", Wire::U32, &SeatEcho::inAck},
};
}  // namespace records_detail

template <typename Fn>
void ForEachMotionField(const MotionRecord& record, Fn fn) {
  if (record.kind == RecordKind::Entity) {
    for (const records_detail::EntityField& f : records_detail::kEntityFields) {
      fn(f.name, f.member == nullptr ? (record.entity.sleep ? 1.0 : 0.0) : record.entity.*(f.member));
    }
    return;
  }
  for (const records_detail::SeatField& f : records_detail::kSeatFields) fn(f.name, record.seat.*(f.member));
}

}  // namespace genex::fast
