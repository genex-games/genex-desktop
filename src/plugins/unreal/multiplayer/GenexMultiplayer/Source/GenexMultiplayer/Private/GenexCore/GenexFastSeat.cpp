// See GenexFastSeat.h (packages/multiplayer/src/authority/fast-session.ts, in its order).
#include "GenexCore/GenexFastSeat.h"

#include "GenexCore/GenexColyseus.h"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <random>
#include <string_view>

namespace genex::fast {

namespace seat_detail {

namespace aw = ::genex::authority_wire;

/** An entity motion field of the schema struct, by its record name; nullptr for any other name. */
float* EntityFloat(aw::AuthorityEntity& e, std::string_view f) {
  if (f == "x") return &e.x;
  if (f == "y") return &e.y;
  if (f == "z") return &e.z;
  if (f == "vx") return &e.vx;
  if (f == "vy") return &e.vy;
  if (f == "vz") return &e.vz;
  if (f == "yaw") return &e.yaw;
  if (f == "pitch") return &e.pitch;
  if (f == "duck") return &e.duck;
  if (f == "spin") return &e.spin;
  if (f == "fuel") return &e.fuel;
  return nullptr;
}

double* EntityDouble(aw::AuthorityEntity& e, std::string_view f) {
  if (f == "epoch") return &e.epoch;
  if (f == "mstate") return &e.mstate;
  if (f == "qx") return &e.qx;
  if (f == "qy") return &e.qy;
  if (f == "qz") return &e.qz;
  if (f == "qw") return &e.qw;
  if (f == "lvx") return &e.lvx;
  if (f == "lvy") return &e.lvy;
  if (f == "lvz") return &e.lvz;
  if (f == "avx") return &e.avx;
  if (f == "avy") return &e.avy;
  if (f == "avz") return &e.avz;
  if (f == "rest") return &e.rest;
  return nullptr;
}

float* PlayerFloat(aw::AuthorityPlayer& p, std::string_view f) {
  if (f == "inMoveX") return &p.inMoveX;
  if (f == "inMoveY") return &p.inMoveY;
  if (f == "inMoveZ") return &p.inMoveZ;
  if (f == "inYaw") return &p.inYaw;
  if (f == "inPitch") return &p.inPitch;
  return nullptr;
}

double* PlayerDouble(aw::AuthorityPlayer& p, std::string_view f) {
  if (f == "inButtons") return &p.inButtons;
  if (f == "inRep") return &p.inRep;
  if (f == "inStarve") return &p.inStarve;
  if (f == "inBuf") return &p.inBuf;
  return nullptr;
}

double* RootDouble(aw::AuthorityRoomState& s, std::string_view f) {
  if (f == "tick") return &s.tick;
  if (f == "keyframe") return &s.keyframe;
  return nullptr;
}

/** One held field's place: what it reads and how a value is written (float32 fields as float32). */
struct Place {
  float* f = nullptr;
  double* d = nullptr;
  bool* b = nullptr;
  double Get() const {
    if (f != nullptr) return static_cast<double>(*f);
    if (d != nullptr) return *d;
    return b != nullptr && *b ? 1.0 : 0.0;
  }
  void Set(double v) const {
    if (f != nullptr) *f = static_cast<float>(v);
    if (d != nullptr) *d = v;
    if (b != nullptr) *b = v != 0;
  }
  bool Valid() const { return f != nullptr || d != nullptr || b != nullptr; }
};

Place PlaceOf(void* ref, RecordKind kind, bool root, std::string_view field) {
  Place p;
  if (root) {
    p.d = RootDouble(*static_cast<aw::AuthorityRoomState*>(ref), field);
  } else if (kind == RecordKind::Entity) {
    aw::AuthorityEntity& e = *static_cast<aw::AuthorityEntity*>(ref);
    p.f = EntityFloat(e, field);
    p.d = p.f == nullptr ? EntityDouble(e, field) : nullptr;
    if (field == "sleep") p.b = &e.sleep;
  } else {
    aw::AuthorityPlayer& pl = *static_cast<aw::AuthorityPlayer*>(ref);
    p.f = PlayerFloat(pl, field);
    p.d = p.f == nullptr ? PlayerDouble(pl, field) : nullptr;
  }
  return p;
}

void* Lookup(aw::AuthorityRoomState* state, RecordKind kind, const std::string& id) {
  colyseus_map_schema_t* map = kind == RecordKind::Entity ? state->entities : state->players;
  return map == nullptr ? nullptr : colyseus_map_schema_get(map, id.c_str());
}

template <typename Fn>
void ForEachIn(colyseus_map_schema_t* map, Fn fn) {
  if (map == nullptr) return;
  colyseus_map_schema_foreach(
      map,
      [](const char* key, void* value, void* userdata) {
        if (key != nullptr && value != nullptr) (*static_cast<Fn*>(userdata))(std::string(key), value);
      },
      &fn);
}

/** The schema field a seat record's field writes (`inAck` is no schema field). */
bool IsSchemaField(RecordKind kind, std::string_view field) { return kind == RecordKind::Entity || field != "inAck"; }

}  // namespace seat_detail

namespace sd = seat_detail;

// ---------------- MotionGuard ----------------

bool MotionGuard::Current(authority_wire::AuthorityRoomState* state, void* ref, const Held& h) const {
  if (state == nullptr) return false;
  if (h.root) return ref == state;
  return sd::Lookup(state, h.kind, h.id) == ref;
}

void MotionGuard::Hold(void* ref, RecordKind kind, bool root, const std::string& id, const char* field, double value) {
  const sd::Place place = sd::PlaceOf(ref, kind, root, field);
  if (!place.Valid()) return;
  Held& h = held_[ref];
  h.kind = kind;
  h.root = root;
  h.id = id;
  const auto known = h.fields.find(field);
  if (known == h.fields.end()) {
    h.fields[field] = HeldField{value, place.Get()};
  } else {
    known->second.fast = value;
  }
  place.Set(value);
  // A float32 field holds what the struct holds, so the comparison with the WebSocket's is exact.
  h.fields[field].fast = place.Get();
}

void MotionGuard::WriteRecord(authority_wire::AuthorityRoomState* state, const MotionRecord& record) {
  void* ref = sd::Lookup(state, record.kind, record.id);
  if (ref == nullptr) return;
  ForEachMotionField(record, [&](const char* name, double value) {
    if (sd::IsSchemaField(record.kind, name)) Hold(ref, record.kind, false, record.id, name, value);
  });
}

void MotionGuard::Write(authority_wire::AuthorityRoomState* state, const std::vector<MotionRecord>& changed, double tick) {
  if (state == nullptr) return;
  for (const MotionRecord& record : changed) WriteRecord(state, record);
  // The root's tick, and `keyframe` in a room that writes keyframes (it patches only on keyframes).
  const auto root = held_.find(state);
  const bool keyframes = state->keyframe != 0 || (root != held_.end() && root->second.fields.count("keyframe") > 0);
  Hold(state, RecordKind::Entity, true, std::string(), "tick", tick);
  if (keyframes) Hold(state, RecordKind::Entity, true, std::string(), "keyframe", tick);
}

double MotionGuard::WebSocketTick(const authority_wire::AuthorityRoomState* state) const {
  if (state == nullptr) return 0;
  const auto root = held_.find(const_cast<authority_wire::AuthorityRoomState*>(state));
  if (root == held_.end()) return state->tick;
  const auto tick = root->second.fields.find("tick");
  return tick != root->second.fields.end() ? tick->second.ws : state->tick;
}

void SettleAckTrail::Snapshot(double tick, int ack) {
  const int last = trail_.empty() ? floor_ : trail_.back().ack;
  if (ack <= last) return;
  trail_.push_back({tick, ack});
  if (trail_.size() > kSettleAckTrail) trail_.erase(trail_.begin(), trail_.end() - static_cast<std::ptrdiff_t>(kSettleAckTrail));
}

int SettleAckTrail::Through(double tick) {
  std::size_t kept = 0;
  while (kept < trail_.size() && trail_[kept].tick <= tick) {
    floor_ = (std::max)(floor_, trail_[kept].ack);
    kept += 1;
  }
  trail_.erase(trail_.begin(), trail_.begin() + static_cast<std::ptrdiff_t>(kept));
  return floor_;
}

void SettleAckTrail::Reset(int floor) {
  trail_.clear();
  floor_ = floor;
}

void MotionGuard::Expose(authority_wire::AuthorityRoomState* state) {
  for (auto it = held_.begin(); it != held_.end();) {
    if (!Current(state, it->first, it->second)) {
      it = held_.erase(it);
      continue;
    }
    for (const auto& [field, f] : it->second.fields) {
      if (f.ws != f.fast) sd::PlaceOf(it->first, it->second.kind, it->second.root, field).Set(f.ws);
    }
    ++it;
  }
  exposed_ = true;
}

void MotionGuard::Cover(authority_wire::AuthorityRoomState* state, const FastClient* client) {
  for (auto it = held_.begin(); it != held_.end();) {
    if (!Current(state, it->first, it->second)) {
      it = held_.erase(it);
      continue;
    }
    for (auto& [field, f] : it->second.fields) {
      const sd::Place place = sd::PlaceOf(it->first, it->second.kind, it->second.root, field);
      // Exposed, the struct showed the WebSocket's value: whatever the decode left there is its latest.
      if (exposed_) f.ws = place.Get();
      place.Set(f.fast);
    }
    ++it;
  }
  exposed_ = false;
  if (client == nullptr || state == nullptr) return;
  // An entity or seat a patch added while the channel holds its record starts at the record.
  const auto adopt = [&](RecordKind kind, colyseus_map_schema_t* map) {
    sd::ForEachIn(map, [&](const std::string& id, void* ref) {
      if (held_.count(ref) > 0) return;
      const MotionRecord* record = client->MotionOf(kind, id);
      if (record != nullptr) WriteRecord(state, *record);
    });
  };
  adopt(RecordKind::Entity, state->entities);
  adopt(RecordKind::Seat, state->players);
}

bool MotionGuard::Release(authority_wire::AuthorityRoomState* state) {
  bool changed = false;
  // PROTOCOL.md §17.12 *Downlink*: a physics room sent no entity motion by WebSocket while the channel
  // was live and sends all of it again after the fallback; until then an entity keeps the channel's.
  const bool resent = state != nullptr && state->physics != nullptr && state->physics[0] != '\0';
  for (const auto& [ref, h] : held_) {
    if (!Current(state, ref, h)) continue;
    if (resent && !h.root && h.kind == RecordKind::Entity) continue;
    for (const auto& [field, f] : h.fields) {
      const sd::Place place = sd::PlaceOf(ref, h.kind, h.root, field);
      if (place.Get() == f.ws) continue;
      place.Set(f.ws);
      changed = true;
    }
  }
  held_.clear();
  exposed_ = false;
  return changed;
}

void MotionGuard::Forget() {
  held_.clear();
  exposed_ = false;
}

// ---------------- FastSeat ----------------

namespace {

/** The backoff's attempt after the server's `__fast:off`: the first retry 4 to 8 s on. */
constexpr int kRetryAfterServerOff = 3;

double DefaultRandom() {
  static std::mt19937_64 generator(static_cast<std::uint64_t>(std::chrono::steady_clock::now().time_since_epoch().count()));
  return std::uniform_real_distribution<double>(0.0, 1.0)(generator);
}

}  // namespace

FastSeat::FastSeat(FastSeatHost host) : host_(std::move(host)) {
  if (!host_.random) host_.random = DefaultRandom;
}

FastSeat::~FastSeat() {
  if (client_ != nullptr) client_->Close();
  if (probe_ != nullptr) probe_->Close();
}

void FastSeat::ScheduleRetry() {
  if (!hostReturns_ || !host_.open) return;
  retryAt_ = host_.now() + RetryDelayMs(attempt_, host_.random());
  attempt_ += 1;
}

int FastSeat::SettleAck() {
  if (client_ == nullptr) return Ack();
  return (std::min)(Ack(), settle_.Through(guard_.WebSocketTick(host_.state())));
}

int FastSeat::Ack() const {
  const int sent = host_.sentCount();
  if (client_ != nullptr) return (std::min)(sent, fastAck_);
  const int lastProcessed = host_.lastProcessed();
  if (!fallback_) return lastProcessed;
  const int ws = lastProcessed - fallback_->wsBefore;
  return ws > 0 ? (std::max)(fallback_->ack, fallback_->at + ws) : fallback_->ack;
}

void FastSeat::FallBack(FallbackReason reason) {
  if (fallback_) return;
  if (liveSince_ && host_.now() - *liveSince_ >= kReturnStableMs) attempt_ = 0;
  // The server sent it away: it has its reasons, so no quick return.
  if (reason == FallbackReason::Server) attempt_ = (std::max)(attempt_, kRetryAfterServerOff);
  liveSince_.reset();
  status_.fallbacks += 1;
  const double base = client_ != nullptr ? linkSeqBase_ : host_.seqBase();
  const int sent = host_.sentCount();
  // The handle sent every input by WebSocket too (never muted, GenexFastSeat.h), so the server counts the
  // fallback's WebSocket inputs on from all of them.
  fallback_ = Fallback{sent, sent, Ack()};
  if (client_ != nullptr) client_->Close();
  client_.reset();
  early_.clear();
  status_.live = false;
  status_.fallback = reason;
  Json off = Json::MakeObject();
  off.Set("last", Json(base + static_cast<double>(sent)));
  host_.send(kOffMessage, off);
  // From here every field comes by WebSocket, which sends a field only when it changes.
  if (guard_.Release(host_.state())) host_.statePass();
  ScheduleRetry();
}

void FastSeat::OffChannel(FallbackReason reason) {
  if (!status_.fallback) status_.fallbacks += 1;
  status_.fallback = reason;
}

void FastSeat::AbandonProbe(FallbackReason reason) {
  if (probe_ == nullptr) return;
  probe_->Close();
  probe_.reset();
  OffChannel(reason);
  Json off = Json::MakeObject();
  off.Set("last", Json(host_.seqBase() + static_cast<double>(host_.sentCount())));
  host_.send(kOffMessage, off);
  ScheduleRetry();
}

void FastSeat::StartProbe(const std::optional<BindMessage>& bind) {
  // The ask that brought this was answered: the climb is for what fails.
  attempt_ = (std::max)(0, attempt_ - 1);
  hostReturns_ = true;
  if (probe_ != nullptr) probe_->Close();
  probe_.reset();
  probeApplied_ = 0;
  // A seat new to the channel was on the WebSocket all along: no input of its was dropped.
  if (!fallback_) fallback_ = Fallback{0, 0, 0};
  early_.clear();
  if (!bind) {
    OffChannel(FallbackReason::Unreachable);
    ScheduleRetry();
    return;
  }
  boundUrl_ = bind->url;
  FastClientOptions o;
  o.bind = *bind;
  o.tickHz = host_.tickHz();
  o.open = host_.open;
  o.now = host_.now;
  o.onSnapshot = [this](const FastSnapshot& s) { ProbeApplied(s); };
  probe_ = FastClient::Open(std::move(o));
  if (probe_ == nullptr) {
    OffChannel(FallbackReason::Unreachable);
    ScheduleRetry();
    return;
  }
  retryAt_.reset();
  probe_->Keepalive();
}

void FastSeat::ProbeApplied(const FastSnapshot& s) {
  // Past the swap this is the channel's client, and its snapshots are the channel's.
  if (client_ != nullptr) {
    Applied(s);
    return;
  }
  probeApplied_ += 1;
  if (probeApplied_ < kReturnProof || probe_ == nullptr) return;
  const int sent = host_.sentCount();
  const double base = host_.seqBase();
  fastAck_ = Ack();
  // Off the channel the ack and the WebSocket's list agree.
  settle_.Reset(fastAck_);
  client_ = std::move(probe_);
  linkSeqBase_ = base;
  fallback_.reset();
  retryAt_.reset();
  liveSince_ = host_.now();
  status_.live = true;
  status_.fallback.reset();
  if (status_.fallbacks > 0) status_.returns += 1;
  Json on = Json::MakeObject();
  on.Set("last", Json(base + static_cast<double>(sent)));
  host_.send(kOnMessage, on);
  // The first snapshot written on this binding, so all of it.
  FastSnapshot whole = s;
  whole.changed = client_->AllRecords();
  Applied(whole);
}

void FastSeat::Applied(const FastSnapshot& s) {
  if (client_ == nullptr) return;
  status_.snapshots += 1;
  const MotionRecord* mine = client_->MotionOf(RecordKind::Seat, host_.sessionId());
  const double own = mine != nullptr ? mine->seat.inAck : 0;
  const double sent = host_.sentCount();
  const int acked = static_cast<int>((std::max)(0.0, (std::min)(sent, own - linkSeqBase_)));
  double rtt = -1;
  if (acked > fastAck_) {
    const std::optional<double> at = client_->SentAt(linkSeqBase_ + acked);
    if (at) rtt = host_.now() - *at;
    fastAck_ = acked;
  }
  settle_.Snapshot(s.tick, fastAck_);
  // The room clock the server sent it at, as a WebSocket patch's TIMED prefix gives it: the tick's nominal
  // instant would read up to a step early, by however late the server ran that step.
  host_.sample(s.sent, rtt);
  guard_.Write(host_.state(), s.changed, s.tick);
  host_.statePass();
}

void FastSeat::Bind(const Json& message) {
  const Json* asProbe = message.IsObject() ? message.Find("probe") : nullptr;
  const bool probing = asProbe != nullptr && asProbe->AsBool();
  if (!host_.open || client_ != nullptr || (fallback_ && !probing)) return;
  if (!host_.stateCurrent()) {
    pendingBind_ = message;
    return;
  }
  pendingBind_.reset();
  const std::optional<BindMessage> bind = FastBindOf(message);
  if (probing) return StartProbe(bind);
  if (!bind) return FallBack(FallbackReason::Unreachable);
  boundUrl_ = bind->url;
  hostReturns_ = bind->rev >= kBindRev;
  FastClientOptions o;
  o.bind = *bind;
  o.tickHz = host_.tickHz();
  o.open = host_.open;
  o.now = host_.now;
  o.onSnapshot = [this](const FastSnapshot& s) { Applied(s); };
  client_ = FastClient::Open(std::move(o));
  if (client_ == nullptr) return FallBack(FallbackReason::Unreachable);
  linkSeqBase_ = host_.seqBase();
  // The server dropped every WebSocket input this socket sent before the binding, unstepped: the first
  // datagram carries them all again.
  fastAck_ = 0;
  settle_.Reset(0);
  status_.live = true;
  liveSince_ = host_.now();
  for (const FastInput& s : early_) client_->Queue({linkSeqBase_ + s.seq, s.tick, s.input, s.render});
  early_.clear();
  client_->Flush();
  client_->Keepalive();
}

void FastSeat::OnBind(const Json& message) { Bind(message); }

void FastSeat::OnServerOff() {
  if (!host_.open) return;
  FallBack(FallbackReason::Server);
}

void FastSeat::OnState() {
  if (pendingBind_ && host_.stateCurrent()) {
    const Json message = *pendingBind_;
    Bind(message);
  }
}

void FastSeat::Sent(int seq, double tick, const Input& input, double render) {
  if (!host_.open || fallback_) return;
  if (client_ != nullptr) {
    client_->Queue({linkSeqBase_ + seq, tick, input, render});
    return;
  }
  early_.push_back({static_cast<double>(seq), tick, input, render});
  const auto cap = static_cast<std::size_t>(SeqAheadMax(host_.tickHz()));
  if (early_.size() > cap) early_.erase(early_.begin(), early_.end() - static_cast<std::ptrdiff_t>(cap));
}

void FastSeat::Flush() {
  if (client_ != nullptr) client_->Flush();
}

void FastSeat::Poll() {
  if (client_ != nullptr) {
    client_->Framed();
    const std::optional<FallbackReason> reason = client_->Due();
    if (reason) FallBack(*reason);
    if (client_ != nullptr) client_->Keepalive();
  }
  if (probe_ != nullptr) {
    probe_->Framed();
    const std::optional<FallbackReason> reason = probe_->Due();
    if (reason) AbandonProbe(*reason);
    if (probe_ != nullptr) probe_->Keepalive();
  }
  if (retryAt_ && probe_ == nullptr && fallback_ && host_.now() >= *retryAt_) {
    host_.send(kAgainMessage, Json::MakeObject());
    ScheduleRetry();
  }
}

void FastSeat::Receive() {
  if (client_ != nullptr) client_->Poll();
  // A swap moves it to client_ while it reads, which outlives the read.
  if (probe_ != nullptr) probe_->Poll();
}

const FastInput* FastSeat::InputAt(int seq) const {
  return client_ == nullptr ? nullptr : client_->InputAt(linkSeqBase_ + seq);
}

void FastSeat::Dropped() {
  boundUrl_.clear();
  if (client_ != nullptr) client_->Close();
  client_.reset();
  if (probe_ != nullptr) probe_->Close();
  probe_.reset();
  probeApplied_ = 0;
  retryAt_.reset();
  attempt_ = 0;
  liveSince_.reset();
  hostReturns_ = false;
  guard_.Forget();
  fallback_.reset();
  fastAck_ = 0;
  early_.clear();
  pendingBind_.reset();
  status_.live = false;
  status_.fallback.reset();
}

}  // namespace genex::fast
