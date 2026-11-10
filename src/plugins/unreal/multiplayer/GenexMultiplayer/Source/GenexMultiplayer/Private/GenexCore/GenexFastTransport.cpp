// See GenexFastTransport.h (packages/multiplayer/src/authority/fast-transport.ts, in its order).
#include "GenexCore/GenexFastTransport.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <map>
#include <set>

namespace genex::fast {

namespace transport_detail {

constexpr std::size_t kUplinkHeader = 29;
constexpr std::size_t kSnapshotHeader = 29;
constexpr std::size_t kPayload = 24;
constexpr std::uint8_t kSlotSame = 1;
constexpr std::uint8_t kSlotTickSame = 2;
constexpr std::uint8_t kSlotTickNext = 4;
constexpr std::uint8_t kSlotFlags = kSlotSame | kSlotTickSame | kSlotTickNext;
/** A slot's `back` when it carries no render time (unstamped, or more than 254 ms behind the header's). */
constexpr std::uint8_t kBackNone = 255;
/** An action: seq uint32, tick uint16, render uint32, then the payload. */
constexpr std::size_t kActionHead = 10;
constexpr double kUint32Max = 4294967295.0;
constexpr double kUint16Max = 65535.0;
constexpr double kTickMod = 65536.0;
constexpr std::uint8_t kKeyframe = 1;

/** JavaScript's Number.isInteger(v) && 0 <= v <= max. */
bool IsUint(double v, double max) { return std::isfinite(v) && std::floor(v) == v && v >= 0 && v <= max; }

int TicksOf(double ms, double tickHz) {
  const double hz = std::isfinite(tickHz) && tickHz > 0 ? tickHz : 0;
  return static_cast<int>(std::ceil((ms * hz) / 1000));
}

/** JavaScript's ToUint32 (what a bitwise operator does to a number). */
std::uint32_t ToUint32(double v) {
  if (!std::isfinite(v)) return 0;
  const double m = std::fmod(std::trunc(v), 4294967296.0);
  return static_cast<std::uint32_t>(m < 0 ? m + 4294967296.0 : m);
}

/** JavaScript's `%` then a positive modulus: ((a % m) + m) % m. */
double PositiveMod(double a, double m) { return std::fmod(std::fmod(a, m) + m, m); }

void PutU16(Bytes& out, std::size_t at, double v) {
  const auto x = static_cast<std::uint16_t>(v);
  out[at] = static_cast<std::uint8_t>(x & 0xff);
  out[at + 1] = static_cast<std::uint8_t>(x >> 8);
}

void PutU32(Bytes& out, std::size_t at, std::uint32_t x) {
  for (int i = 0; i < 4; i += 1) out[at + static_cast<std::size_t>(i)] = static_cast<std::uint8_t>((x >> (8 * i)) & 0xff);
}

void PutF32(Bytes& out, std::size_t at, double v) {
  const float f = static_cast<float>(v);
  std::uint32_t bits = 0;
  std::memcpy(&bits, &f, sizeof bits);
  PutU32(out, at, bits);
}

std::uint32_t GetU32(const std::uint8_t* d, std::size_t at) {
  return static_cast<std::uint32_t>(d[at]) | (static_cast<std::uint32_t>(d[at + 1]) << 8) |
         (static_cast<std::uint32_t>(d[at + 2]) << 16) | (static_cast<std::uint32_t>(d[at + 3]) << 24);
}

std::uint16_t GetU16(const std::uint8_t* d, std::size_t at) {
  return static_cast<std::uint16_t>(d[at] | (d[at + 1] << 8));
}

double GetF32(const std::uint8_t* d, std::size_t at) {
  const std::uint32_t bits = GetU32(d, at);
  float f = 0;
  std::memcpy(&f, &bits, sizeof f);
  return static_cast<double>(f);
}

std::size_t WritePayload(Bytes& out, std::size_t at, const Input& p) {
  PutF32(out, at, p.moveX);
  PutF32(out, at + 4, p.moveY);
  PutF32(out, at + 8, p.moveZ);
  PutF32(out, at + 12, p.yaw);
  PutF32(out, at + 16, p.pitch);
  PutU32(out, at + 20, ToUint32(p.buttons));
  return at + kPayload;
}

Input ReadPayload(const std::uint8_t* d, std::size_t at) {
  return Input::FromRaw(GetF32(d, at), GetF32(d, at + 4), GetF32(d, at + 8), GetF32(d, at + 12), GetF32(d, at + 16),
                        static_cast<double>(GetU32(d, at + 20)));
}

Bytes PayloadBits(const Input& p) {
  Bytes b(kPayload);
  WritePayload(b, 0, p);
  return b;
}

bool FiniteAsF32(double v) { return std::isfinite(static_cast<float>(v)); }

bool ValidPayload(const Input& p) {
  return FiniteAsF32(p.moveX) && FiniteAsF32(p.moveY) && FiniteAsF32(p.moveZ) && FiniteAsF32(p.yaw) && FiniteAsF32(p.pitch) &&
         IsUint(p.buttons, kUint32Max);
}

bool ValidInput(const FastInput& s) {
  return IsUint(s.seq, kUint32Max) && s.seq >= 1 && IsUint(s.tick, kTickMod - 1) && IsUint(s.render, kUint32Max) &&
         ValidPayload(s.input);
}

/** A slot's `back` against the header's render time `render` (the newest of the window's). */
std::uint8_t BackOf(double render, const FastInput& s) {
  if (s.render == 0 || render - s.render >= kBackNone) return kBackNone;
  return static_cast<std::uint8_t>(render - s.render);
}

/** The render time a slot's `back` stands for (0: unstamped). */
double RenderOf(double render, std::uint8_t back) {
  if (back == kBackNone || render - back <= 0) return 0;
  return render - back;
}

bool ValidUplink(const Uplink& u) {
  const auto& window = u.window;
  const auto& actions = u.actions;
  if (!IsUint(u.sid, kUint32Max) || !IsKey(u.key) || !IsUint(u.ackSnap, kUint32Max)) return false;
  // An empty uplink (§17.12 *Keepalive*): the header alone.
  if (window.empty()) return u.fresh == 0 && actions.empty();
  if (window.size() > static_cast<std::size_t>(kInputRedundancyMax) ||
      actions.size() > static_cast<std::size_t>(kMaxActions)) {
    return false;
  }
  if (!IsUint(u.fresh, static_cast<double>(window.size())) || u.fresh < 1) return false;
  for (const FastInput& s : actions) {
    if (!ValidInput(s)) return false;
  }
  for (const FastInput& s : window) {
    if (!ValidInput(s)) return false;
  }
  for (std::size_t i = 1; i < window.size(); i += 1) {
    if (window[i].seq != window[i - 1].seq + 1) return false;
  }
  for (std::size_t i = 0; i < actions.size(); i += 1) {
    const double next = i + 1 < actions.size() ? actions[i + 1].seq : window[0].seq;
    if (!(actions[i].seq < next)) return false;
  }
  return true;
}

std::uint8_t SlotFlags(const FastInput* previous, const FastInput& s) {
  if (previous == nullptr) return 0;
  std::uint8_t flags = PayloadBits(previous->input) == PayloadBits(s.input) ? kSlotSame : 0;
  if (s.tick == previous->tick) {
    flags |= kSlotTickSame;
  } else if (s.tick == std::fmod(previous->tick + 1, kTickMod)) {
    flags |= kSlotTickNext;
  }
  return flags;
}

/** The common checks of every datagram: size, version, kind, header length. */
std::optional<Fault> Frame(const std::uint8_t* d, std::size_t length, Kind kind, std::size_t header) {
  if (length > kMaxDatagramBytes) return Fault::Oversized;
  if (length < 2) return Fault::Truncated;
  if (d[0] != kFastVersion) return Fault::Version;
  if (d[1] != static_cast<std::uint8_t>(kind)) return Fault::Kind;
  if (length < header) return Fault::Truncated;
  return std::nullopt;
}

template <typename T>
Result<T> Fail(Fault fault) {
  Result<T> r;
  r.fault = fault;
  return r;
}

template <typename T>
Result<T> Ok(T value) {
  Result<T> r;
  r.value = std::move(value);
  return r;
}

struct Slot {
  FastInput input;
  std::size_t at = 0;
};

Result<Slot> ReadSlot(const std::uint8_t* d, std::size_t length, std::size_t start, const FastInput* previous, double seq,
                      double render) {
  if (start >= length) return Fail<Slot>(Fault::Truncated);
  const std::uint8_t flags = d[start];
  const std::uint8_t tickBits = flags & (kSlotTickSame | kSlotTickNext);
  const bool unknownBit = (flags & ~kSlotFlags) != 0;
  const bool bothTickBits = tickBits == (kSlotTickSame | kSlotTickNext);
  const bool firstWithFlag = previous == nullptr && flags != 0;
  if (unknownBit || bothTickBits || firstWithFlag) return Fail<Slot>(Fault::Flags);
  std::size_t at = start + 1;
  double tick = 0;
  if (previous != nullptr && tickBits == kSlotTickSame) {
    tick = previous->tick;
  } else if (previous != nullptr && tickBits == kSlotTickNext) {
    tick = std::fmod(previous->tick + 1, kTickMod);
  } else {
    if (at + 2 > length) return Fail<Slot>(Fault::Truncated);
    tick = GetU16(d, at);
    at += 2;
  }
  if (at + 1 > length) return Fail<Slot>(Fault::Truncated);
  const double slotRender = RenderOf(render, d[at]);
  at += 1;
  if (previous != nullptr && (flags & kSlotSame) != 0) return Ok(Slot{{seq, tick, previous->input, slotRender}, at});
  if (at + kPayload > length) return Fail<Slot>(Fault::Truncated);
  return Ok(Slot{{seq, tick, ReadPayload(d, at), slotRender}, at + kPayload});
}

/** Actions then window slots, to the byte; the fault that drops the datagram, else none. */
std::optional<Fault> ReadBody(const std::uint8_t* d, std::size_t length, int actionCount, int count, double first, Uplink& out) {
  const double render = GetU32(d, 25);
  std::size_t at = kUplinkHeader;
  for (int i = 0; i < actionCount; i += 1) {
    if (at + kActionHead + kPayload > length) return Fault::Truncated;
    const double seq = GetU32(d, at);
    const bool outOfOrder = seq < 1 || seq >= first || (i > 0 && seq <= out.actions.back().seq);
    if (outOfOrder) return Fault::Order;
    out.actions.push_back({seq, static_cast<double>(GetU16(d, at + 4)), ReadPayload(d, at + kActionHead),
                           static_cast<double>(GetU32(d, at + 6))});
    at += kActionHead + kPayload;
  }
  for (int i = 0; i < count; i += 1) {
    const Result<Slot> slot = ReadSlot(d, length, at, i == 0 ? nullptr : &out.window.back(), first + i, render);
    if (!slot.Ok()) return slot.fault;
    out.window.push_back(slot.value->input);
    at = slot.value->at;
  }
  if (at != length) return Fault::Trailing;
  return std::nullopt;
}

std::optional<Bytes> BodyBytes(const SnapshotBody& body) {
  for (double k : body.removed) {
    if (!IsUint(k, kUint16Max)) return std::nullopt;
  }
  for (const KeyedRecord& r : body.records) {
    if (!IsUint(r.key, kUint16Max) || r.bytes.size() > kMaxRecordBytes) return std::nullopt;
  }
  if (body.removed.size() > 0xffff || body.records.size() > 0xffff) return std::nullopt;
  std::size_t size = 4 + 2 * body.removed.size();
  for (const KeyedRecord& r : body.records) size += 4 + r.bytes.size();
  Bytes out(size);
  PutU16(out, 0, static_cast<double>(body.removed.size()));
  std::size_t at = 2;
  for (double k : body.removed) {
    PutU16(out, at, k);
    at += 2;
  }
  PutU16(out, at, static_cast<double>(body.records.size()));
  at += 2;
  for (const KeyedRecord& r : body.records) {
    PutU16(out, at, r.key);
    PutU16(out, at + 2, static_cast<double>(r.bytes.size()));
    std::copy(r.bytes.begin(), r.bytes.end(), out.begin() + static_cast<std::ptrdiff_t>(at + 4));
    at += 4 + r.bytes.size();
  }
  return out;
}

bool ValidHead(const SnapshotHead& h) {
  return IsUint(h.sid, kUint32Max) && IsUint(h.snap, kUint32Max) && h.snap >= 1 && IsUint(h.base, kUint32Max) &&
         h.base < h.snap && IsUint(h.tick, kUint32Max) && IsUint(h.inputAck, kUint32Max) && IsUint(h.sent, kUint32Max);
}

Records ByKey(Records records) {
  std::stable_sort(records.begin(), records.end(), [](const KeyedRecord& a, const KeyedRecord& b) { return a.key < b.key; });
  return records;
}

bool SameHead(const PartialSnapshot& p, const Fragment& f) {
  return p.base == f.base && p.tick == f.tick && p.inputAck == f.inputAck && p.sent == f.sent && p.keyframe == f.keyframe &&
         p.frags == f.frags;
}

/** A complete set (§17.12 *Applying a snapshot*): `hadSet` says whether it was gathered in rx.partials
 *  (at `index`), so a fault answers the very rx given only when it was not. */
ReceiveResult ApplyComplete(ClientRx& rx, bool hadSet, std::size_t index, const PartialSnapshot& set) {
  ReceiveResult result;
  const auto drop = [&](Fault fault) {
    if (hadSet) rx.partials.erase(rx.partials.begin() + static_cast<std::ptrdiff_t>(index));
    result.fault = fault;
    return result;
  };
  Bytes whole;
  for (const std::optional<Bytes>& c : set.chunks) whole.insert(whole.end(), c->begin(), c->end());
  const Result<SnapshotBody> body = ParseBody(whole.data(), whole.size());
  if (!body.Ok()) return drop(Fault::Body);
  const HeldSnapshot* base = nullptr;
  if (!set.keyframe) {
    for (const HeldSnapshot& h : rx.history) {
      if (h.snap == set.base) {
        base = &h;
        break;
      }
    }
    if (base == nullptr) return drop(Fault::Base);
  }
  if (set.keyframe && !body.value->removed.empty()) return drop(Fault::Body);
  HeldSnapshot held{set.snap, set.tick, set.inputAck, set.sent, ApplyBody(base != nullptr ? base->records : Records(), *body.value)};
  rx.history.push_back(std::move(held));
  if (rx.history.size() > kSnapshotHistory) {
    rx.history.erase(rx.history.begin(), rx.history.end() - static_cast<std::ptrdiff_t>(kSnapshotHistory));
  }
  std::vector<PartialSnapshot> partials;
  for (std::size_t i = 0; i < rx.partials.size(); i += 1) {
    if (hadSet && i == index) continue;
    if (rx.partials[i].snap > set.snap) partials.push_back(std::move(rx.partials[i]));
  }
  rx.partials = std::move(partials);
  rx.newest = set.snap;
  result.applied = set.snap;
  return result;
}

}  // namespace transport_detail

namespace td = transport_detail;

const char* FaultName(Fault fault) {
  switch (fault) {
    case Fault::Oversized: return "oversized";
    case Fault::Truncated: return "truncated";
    case Fault::Trailing: return "trailing";
    case Fault::Version: return "version";
    case Fault::Kind: return "kind";
    case Fault::Session: return "session";
    case Fault::Key: return "key";
    case Fault::Count: return "count";
    case Fault::Fresh: return "fresh";
    case Fault::Actions: return "actions";
    case Fault::Flags: return "flags";
    case Fault::Order: return "order";
    case Fault::Field: return "field";
    case Fault::Ahead: return "ahead";
    case Fault::Fragment: return "fragment";
    case Fault::Mismatch: return "mismatch";
    case Fault::Duplicate: return "duplicate";
    case Fault::Keyframe: return "keyframe";
    case Fault::Body: return "body";
    case Fault::Base: return "base";
    case Fault::Stale: return "stale";
  }
  return "field";
}

const char* AcceptKindName(AcceptKind kind) {
  switch (kind) {
    case AcceptKind::Fresh: return "fresh";
    case AcceptKind::Recovered: return "recovered";
    case AcceptKind::Fill: return "fill";
  }
  return "fresh";
}

int InputRedundancyTicks(double tickHz) {
  return (std::min)(kInputRedundancyMax, (std::max)(kInputRedundancyMin, td::TicksOf(kInputRedundancyMs, tickHz)));
}

int GapFillMax(double tickHz) { return td::TicksOf(kGapFillMs, tickHz); }

int SeqAheadMax(double tickHz) { return td::TicksOf(kSeqAheadMs, tickHz); }

std::string ToHex(const std::uint8_t* data, std::size_t length) {
  static const char kDigits[] = "0123456789abcdef";
  std::string out;
  out.reserve(length * 2);
  for (std::size_t i = 0; i < length; i += 1) {
    out.push_back(kDigits[data[i] >> 4]);
    out.push_back(kDigits[data[i] & 0x0f]);
  }
  return out;
}

std::string ToHex(const Bytes& bytes) { return ToHex(bytes.data(), bytes.size()); }

Bytes FromHex(std::string_view hex) {
  const auto digit = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  if (hex.size() % 2 != 0) return Bytes();
  Bytes out(hex.size() / 2);
  for (std::size_t i = 0; i < out.size(); i += 1) {
    const int hi = digit(hex[2 * i]);
    const int lo = digit(hex[2 * i + 1]);
    if (hi < 0 || lo < 0) return Bytes();
    out[i] = static_cast<std::uint8_t>((hi << 4) | lo);
  }
  return out;
}

bool IsKey(std::string_view key) {
  if (key.size() != 2 * kKeyBytes) return false;
  return std::all_of(key.begin(), key.end(), [](char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'); });
}

bool IsPress(const Input* previous, const Input& input) {
  const std::uint32_t before = previous == nullptr ? 0 : td::ToUint32(previous->buttons);
  return (td::ToUint32(input.buttons) & ~before) != 0;
}

// ---- the uplink ----

double RetryDelayMs(int attempt, double unit) {
  const double full = (std::min)(kRetryMaxMs, kRetryBaseMs * std::pow(2.0, (std::min)(attempt, 16)));
  return full / 2 + (full / 2) * unit;
}

Result<Bytes> EncodeUplink(const Uplink& u) {
  if (!td::ValidUplink(u)) return td::Fail<Bytes>(Fault::Field);
  Bytes out(kMaxDatagramBytes);
  out[0] = kFastVersion;
  out[1] = static_cast<std::uint8_t>(Kind::Uplink);
  td::PutU32(out, 2, static_cast<std::uint32_t>(u.sid));
  const Bytes key = FromHex(u.key);
  std::copy(key.begin(), key.end(), out.begin() + 6);
  td::PutU32(out, 14, static_cast<std::uint32_t>(u.ackSnap));
  td::PutU32(out, 18, u.window.empty() ? 0U : static_cast<std::uint32_t>(u.window.back().seq));
  out[22] = static_cast<std::uint8_t>(u.window.size());
  out[23] = static_cast<std::uint8_t>(u.fresh);
  out[24] = static_cast<std::uint8_t>(u.actions.size());
  double render = 0;
  for (const FastInput& s : u.window) render = (std::max)(render, s.render);
  td::PutU32(out, 25, static_cast<std::uint32_t>(render));
  std::size_t at = td::kUplinkHeader;
  for (const FastInput& a : u.actions) {
    td::PutU32(out, at, static_cast<std::uint32_t>(a.seq));
    td::PutU16(out, at + 4, a.tick);
    td::PutU32(out, at + 6, static_cast<std::uint32_t>(a.render));
    at = td::WritePayload(out, at + td::kActionHead, a.input);
  }
  for (std::size_t i = 0; i < u.window.size(); i += 1) {
    const FastInput& s = u.window[i];
    const std::uint8_t flags = td::SlotFlags(i == 0 ? nullptr : &u.window[i - 1], s);
    out[at] = flags;
    at += 1;
    if ((flags & (td::kSlotTickSame | td::kSlotTickNext)) == 0) {
      td::PutU16(out, at, s.tick);
      at += 2;
    }
    out[at] = td::BackOf(render, s);
    at += 1;
    if ((flags & td::kSlotSame) == 0) at = td::WritePayload(out, at, s.input);
  }
  out.resize(at);
  return td::Ok(std::move(out));
}

Result<Uplink> DecodeUplink(const std::uint8_t* data, std::size_t length, const Binding& binding) {
  if (const std::optional<Fault> framed = td::Frame(data, length, Kind::Uplink, td::kUplinkHeader)) {
    return td::Fail<Uplink>(*framed);
  }
  const double sid = td::GetU32(data, 2);
  if (sid != binding.sid) return td::Fail<Uplink>(Fault::Session);
  const std::string key = ToHex(data + 6, kKeyBytes);
  if (key != binding.key) return td::Fail<Uplink>(Fault::Key);
  const double newest = td::GetU32(data, 18);
  const int count = data[22];
  const int fresh = data[23];
  const int actionCount = data[24];
  // An empty uplink (§17.12 *Keepalive*): every other field zero, nothing after the header. A `count` of 0
  // with anything else set stays the fault it was.
  if (count == 0 && newest == 0 && fresh == 0 && actionCount == 0 && td::GetU32(data, 25) == 0) {
    if (length != td::kUplinkHeader) return td::Fail<Uplink>(Fault::Trailing);
    Uplink empty;
    empty.sid = sid;
    empty.key = key;
    empty.ackSnap = td::GetU32(data, 14);
    empty.fresh = 0;
    return td::Ok(std::move(empty));
  }
  if (count < 1 || count > kInputRedundancyMax || newest < count) return td::Fail<Uplink>(Fault::Count);
  if (fresh < 1 || fresh > count) return td::Fail<Uplink>(Fault::Fresh);
  if (actionCount > kMaxActions) return td::Fail<Uplink>(Fault::Actions);
  Uplink u;
  u.sid = sid;
  u.key = key;
  u.ackSnap = td::GetU32(data, 14);
  u.fresh = fresh;
  if (const std::optional<Fault> read = td::ReadBody(data, length, actionCount, count, newest - count + 1, u)) {
    return td::Fail<Uplink>(*read);
  }
  return td::Ok(std::move(u));
}

Uplink UplinkFor(const FastInput* sent, std::size_t count, const UplinkOptions& o) {
  const auto n = static_cast<std::size_t>(InputRedundancyTicks(o.tickHz));
  const std::size_t from = count > n ? count - n : 0;
  Uplink u;
  u.sid = o.sid;
  u.key = o.key;
  u.ackSnap = o.ackSnap;
  u.window.assign(sent + from, sent + count);
  const double first = u.window.empty() ? std::numeric_limits<double>::infinity() : u.window.front().seq;
  for (std::size_t i = 0; i < count && u.actions.size() < static_cast<std::size_t>(kMaxActions); i += 1) {
    const FastInput& s = sent[i];
    const bool held = s.seq > o.inputAck && s.seq < first;
    if (held && IsPress(i > 0 ? &sent[i - 1].input : nullptr, s.input)) u.actions.push_back(s);
  }
  u.fresh = (std::min)(o.fresh, static_cast<double>(u.window.size()));
  return u;
}

// ---- the render-time stamp ----

double RenderStamp(std::optional<double> serverNow, double renderDelay, double rtt) {
  if (!serverNow || !std::isfinite(*serverNow)) return 0;
  // floor(x + 0.5): whole ms, the same on every port (half up, never to even).
  const double now = (std::min)(td::kUint32Max, (std::max)(0.0, std::floor(*serverNow + 0.5)));
  const double lead = renderDelay + (std::isfinite(rtt) ? rtt : 0.0) / 2;
  const double delta = std::isfinite(lead) ? (std::min)(td::kUint16Max, (std::max)(0.0, std::floor(lead + 0.5))) : 0.0;
  return now > delta ? now - delta : 0;
}

// ---- the server's dedup ----

AcceptResult AcceptUplink(const SeatRx& seat, const Uplink& u, const AcceptOptions& o) {
  AcceptResult r;
  r.seat = seat;
  if (u.window.empty()) {
    if (u.ackSnap > seat.ackSnap && u.ackSnap <= o.snapSent) r.seat.ackSnap = u.ackSnap;
    return r;
  }
  const double newest = u.window.back().seq;
  if (newest - seat.last > SeqAheadMax(o.tickHz)) {
    r.fault = Fault::Ahead;
    return r;
  }
  const double firstFresh = newest - u.fresh + 1;
  const double fillMax = GapFillMax(o.tickHz);
  double last = seat.last;
  std::optional<Input> held = seat.input;
  const auto take = [&](const FastInput& s) {
    if (s.seq <= last) return;
    const double gap = s.seq - last - 1;
    if (gap > fillMax) {
      r.skipped += gap;
    } else {
      for (double g = last + 1; g < s.seq; g += 1) {
        r.accepted.push_back(
            {g, td::PositiveMod(s.tick - (s.seq - g), td::kTickMod), held.value_or(Input()), AcceptKind::Fill, s.render});
      }
    }
    Input input;
    SanitizeInto(s.input.moveX, s.input.moveY, s.input.moveZ, s.input.yaw, s.input.pitch, s.input.buttons, input);
    r.accepted.push_back({s.seq, s.tick, input, s.seq >= firstFresh ? AcceptKind::Fresh : AcceptKind::Recovered, s.render});
    last = s.seq;
    held = input;
  };
  for (const FastInput& s : u.actions) take(s);
  for (const FastInput& s : u.window) take(s);
  const bool ackForward = u.ackSnap > seat.ackSnap && u.ackSnap <= o.snapSent;
  const double ackSnap = ackForward ? u.ackSnap : seat.ackSnap;
  if (r.accepted.empty() && ackSnap == seat.ackSnap) return r;
  r.seat = SeatRx{last, held, ackSnap};
  r.changed = true;
  return r;
}

// ---- snapshots ----

SnapshotBody DiffSnapshot(const Records* base, const Records& next) {
  SnapshotBody body;
  if (base == nullptr) {
    body.records = td::ByKey(next);
    return body;
  }
  std::map<double, const Bytes*> old;
  for (const KeyedRecord& r : *base) old[r.key] = &r.bytes;
  std::set<double> keys;
  for (const KeyedRecord& r : next) keys.insert(r.key);
  for (const KeyedRecord& r : *base) {
    if (keys.count(r.key) == 0) body.removed.push_back(r.key);
  }
  std::sort(body.removed.begin(), body.removed.end());
  Records changed;
  for (const KeyedRecord& r : next) {
    const auto before = old.find(r.key);
    if (before == old.end() || *before->second != r.bytes) changed.push_back(r);
  }
  body.records = td::ByKey(std::move(changed));
  return body;
}

double DeltaBase(const std::vector<double>& held, double ackSnap) {
  return ackSnap > 0 && std::find(held.begin(), held.end(), ackSnap) != held.end() ? ackSnap : 0;
}

Result<std::vector<Bytes>> EncodeSnapshot(const SnapshotHead& head, const SnapshotBody& body) {
  const std::optional<Bytes> bytes = td::BodyBytes(body);
  const bool keyframeBody = head.base != 0 || body.removed.empty();
  if (!bytes || !td::ValidHead(head) || !keyframeBody) return td::Fail<std::vector<Bytes>>(Fault::Field);
  const std::size_t room = kMaxDatagramBytes - td::kSnapshotHeader;
  const std::size_t frags = (std::max)(static_cast<std::size_t>(1), (bytes->size() + room - 1) / room);
  if (frags > static_cast<std::size_t>(kMaxFragments)) return td::Fail<std::vector<Bytes>>(Fault::Oversized);
  std::vector<Bytes> out;
  for (std::size_t i = 0; i < frags; i += 1) {
    const std::size_t begin = (std::min)(i * room, bytes->size());
    const std::size_t end = (std::min)((i + 1) * room, bytes->size());
    Bytes d(td::kSnapshotHeader + (end - begin));
    d[0] = kFastVersion;
    d[1] = static_cast<std::uint8_t>(Kind::Snapshot);
    td::PutU32(d, 2, static_cast<std::uint32_t>(head.sid));
    td::PutU32(d, 6, static_cast<std::uint32_t>(head.snap));
    td::PutU32(d, 10, static_cast<std::uint32_t>(head.base));
    td::PutU32(d, 14, static_cast<std::uint32_t>(head.tick));
    td::PutU32(d, 18, static_cast<std::uint32_t>(head.inputAck));
    d[22] = head.base == 0 ? td::kKeyframe : 0;
    d[23] = static_cast<std::uint8_t>(i);
    d[24] = static_cast<std::uint8_t>(frags);
    td::PutU32(d, 25, static_cast<std::uint32_t>(head.sent));
    std::copy(bytes->begin() + static_cast<std::ptrdiff_t>(begin), bytes->begin() + static_cast<std::ptrdiff_t>(end),
              d.begin() + static_cast<std::ptrdiff_t>(td::kSnapshotHeader));
    out.push_back(std::move(d));
  }
  return td::Ok(std::move(out));
}

Result<Fragment> DecodeFragment(const std::uint8_t* data, std::size_t length, double sid) {
  if (const std::optional<Fault> framed = td::Frame(data, length, Kind::Snapshot, td::kSnapshotHeader)) {
    return td::Fail<Fragment>(*framed);
  }
  if (td::GetU32(data, 2) != sid) return td::Fail<Fragment>(Fault::Session);
  Fragment f;
  f.snap = td::GetU32(data, 6);
  f.base = td::GetU32(data, 10);
  const std::uint8_t flags = data[22];
  f.frag = data[23];
  f.frags = data[24];
  if (f.frags < 1 || f.frags > kMaxFragments || f.frag >= f.frags) return td::Fail<Fragment>(Fault::Fragment);
  const bool keyframeAgrees = (flags & ~td::kKeyframe) == 0 && (flags == td::kKeyframe) == (f.base == 0);
  if (!keyframeAgrees || f.snap < 1 || f.base >= f.snap) return td::Fail<Fragment>(Fault::Keyframe);
  f.tick = td::GetU32(data, 14);
  f.inputAck = td::GetU32(data, 18);
  f.sent = td::GetU32(data, 25);
  f.keyframe = flags == td::kKeyframe;
  f.chunk.assign(data + td::kSnapshotHeader, data + length);
  return td::Ok(std::move(f));
}

Result<SnapshotBody> ParseBody(const std::uint8_t* data, std::size_t length) {
  if (length < 2) return td::Fail<SnapshotBody>(Fault::Body);
  SnapshotBody body;
  const int removedCount = td::GetU16(data, 0);
  std::size_t at = 2;
  for (int i = 0; i < removedCount; i += 1) {
    if (at + 2 > length) return td::Fail<SnapshotBody>(Fault::Body);
    const double k = td::GetU16(data, at);
    if (i > 0 && k <= body.removed.back()) return td::Fail<SnapshotBody>(Fault::Body);
    body.removed.push_back(k);
    at += 2;
  }
  if (at + 2 > length) return td::Fail<SnapshotBody>(Fault::Body);
  const int count = td::GetU16(data, at);
  at += 2;
  for (int i = 0; i < count; i += 1) {
    if (at + 4 > length) return td::Fail<SnapshotBody>(Fault::Body);
    const double key = td::GetU16(data, at);
    const std::size_t len = td::GetU16(data, at + 2);
    const bool bad = len > kMaxRecordBytes || at + 4 + len > length || (i > 0 && key <= body.records.back().key);
    if (bad) return td::Fail<SnapshotBody>(Fault::Body);
    body.records.push_back({key, Bytes(data + at + 4, data + at + 4 + len)});
    at += 4 + len;
  }
  if (at != length) return td::Fail<SnapshotBody>(Fault::Body);
  return td::Ok(std::move(body));
}

Records ApplyBody(const Records& base, const SnapshotBody& body) {
  const std::set<double> gone(body.removed.begin(), body.removed.end());
  std::map<double, KeyedRecord> out;
  for (const KeyedRecord& r : base) {
    if (gone.count(r.key) == 0) out[r.key] = r;
  }
  for (const KeyedRecord& r : body.records) out[r.key] = r;
  Records records;
  records.reserve(out.size());
  for (auto& [key, r] : out) records.push_back(std::move(r));
  return records;
}

ReceiveResult ReceiveFragment(ClientRx& rx, const std::uint8_t* data, std::size_t length, double sid) {
  ReceiveResult result;
  Result<Fragment> decoded = DecodeFragment(data, length, sid);
  if (!decoded.Ok()) {
    result.fault = decoded.fault;
    return result;
  }
  Fragment& f = *decoded.value;
  if (f.snap <= rx.newest) {
    result.fault = Fault::Stale;
    return result;
  }
  std::size_t index = rx.partials.size();
  for (std::size_t i = 0; i < rx.partials.size(); i += 1) {
    if (rx.partials[i].snap == f.snap) index = i;
  }
  const bool hadSet = index < rx.partials.size();
  if (hadSet && !td::SameHead(rx.partials[index], f)) {
    result.fault = Fault::Mismatch;
    return result;
  }
  const auto frag = static_cast<std::size_t>(f.frag);
  if (hadSet && rx.partials[index].chunks[frag].has_value()) {
    result.fault = Fault::Duplicate;
    return result;
  }
  PartialSnapshot gathered;
  if (hadSet) {
    gathered = rx.partials[index];
  } else {
    gathered = PartialSnapshot{f.snap, f.base, f.tick, f.inputAck, f.sent, f.keyframe, f.frags,
                               std::vector<std::optional<Bytes>>(static_cast<std::size_t>(f.frags))};
  }
  gathered.chunks[frag] = std::move(f.chunk);
  const bool incomplete =
      std::any_of(gathered.chunks.begin(), gathered.chunks.end(), [](const std::optional<Bytes>& c) { return !c.has_value(); });
  if (!incomplete) return td::ApplyComplete(rx, hadSet, index, gathered);
  if (hadSet) {
    rx.partials[index] = std::move(gathered);
  } else {
    rx.partials.push_back(std::move(gathered));
  }
  std::stable_sort(rx.partials.begin(), rx.partials.end(),
                   [](const PartialSnapshot& a, const PartialSnapshot& b) { return a.snap < b.snap; });
  if (rx.partials.size() > kReassemblySlots) {
    rx.partials.erase(rx.partials.begin(), rx.partials.end() - static_cast<std::ptrdiff_t>(kReassemblySlots));
  }
  return result;
}

}  // namespace genex::fast
