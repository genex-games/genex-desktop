// Port of sdks/rust/genex-multiplayer/src/native/mod.rs (the session, the reconnect takeover) and
// the types of src/types.rs. See GenexRelaySession.h.
#include "GenexCore/GenexRelaySession.h"

#include "GenexCore/GenexClock.h"
#include "GenexCore/GenexColyseus.h"
#include "GenexCore/GenexInterp.h"
#include "GenexCore/GenexLog.h"
#include "GenexCore/GenexMsgpack.h"
#include "GenexCore/GenexNoDelay.h"
#include "GenexCore/GenexProtocol.h"
#include "GenexCore/GenexRelayState.h"
#include "GenexCore/GenexStamp.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <deque>
#include <set>
#include <utility>

namespace genex::relay_session_detail {

namespace cm = ::genex::protocol::client_message;
namespace sm = ::genex::protocol::server_message;
namespace rc = ::genex::protocol::reconnection;

/** Well beyond any handshake: a TCP connect, a TLS handshake and the HTTP upgrade. */
constexpr double kStallTakeoverMs = 5000.0;
/** A takeover attempt whose socket has not opened after this is abandoned (never an open one). */
constexpr double kTakeoverAttemptTimeoutMs = 5000.0;
/** Stop before the relay's 30 s grace runs out (§8). */
constexpr double kReconnectGiveUpMs = 27000.0;
/** A first join whose handshake never completes (same core bug) fails after this. */
constexpr double kConnectTimeoutMs = 15000.0;
/** Chat lines kept for dedupe. */
constexpr std::size_t kChatKeep = 200;

// ---- C callback plumbing ----

enum class RawKind { Room, JoinError, Joined, State, Message, Drop, Reconnect, Leave, RoomError, Latency };

struct RawItem {
  std::uint32_t gen = 0;
  double at = 0.0;
  RawKind kind = RawKind::Joined;
  colyseus_room_t* room = nullptr;
  int code = 0;
  std::string text;
  bool hasText = false;
  Json value;
  RelayStateSnapshot snap;
};

struct Sink {
  std::deque<RawItem> raw;
  /** The session was destroyed while a callback could still arrive: rooms that show up are left. */
  bool orphaned = false;
  SessionClock clock;
};

/** Userdata of one join attempt and of the room it produced. */
struct Ctx {
  Sink* sink = nullptr;
  std::uint32_t gen = 0;
  colyseus_room_t* room = nullptr;
  bool reconnect = false;
};

void SinkPush(void* ud, RawItem item) {
  Ctx* ctx = static_cast<Ctx*>(ud);
  item.gen = ctx->gen;
  item.at = StampNowMs(ctx->sink->clock);
  ctx->sink->raw.push_back(std::move(item));
}

std::string Lossy(const char* p) { return p == nullptr ? std::string() : std::string(p); }

RawItem MakeRaw(RawKind kind) {
  RawItem item;
  item.kind = kind;
  return item;
}

void CbJoin(void* ud) { SinkPush(ud, MakeRaw(RawKind::Joined)); }

void CbState(void* ud) {
  Ctx* ctx = static_cast<Ctx*>(ud);
  RawItem item = MakeRaw(RawKind::State);
  if (ReadRelayState(ctx->room, &item.snap)) SinkPush(ud, std::move(item));
}

void CbLeave(int code, const char* reason, void* ud) {
  RawItem item = MakeRaw(RawKind::Leave);
  item.code = code;
  item.text = Lossy(reason);
  SinkPush(ud, std::move(item));
}

void CbDrop(int code, const char* reason, void* ud) {
  (void)reason;
  RawItem item = MakeRaw(RawKind::Drop);
  item.code = code;
  SinkPush(ud, std::move(item));
}

void CbReconnect(void* ud) { SinkPush(ud, MakeRaw(RawKind::Reconnect)); }

void CbRoomError(int code, const char* message, void* ud) {
  RawItem item = MakeRaw(RawKind::RoomError);
  item.code = code;
  item.text = Lossy(message);
  SinkPush(ud, std::move(item));
}

void CbMessage(const char* type, const std::uint8_t* data, std::size_t length, void* ud) {
  RawItem item = MakeRaw(RawKind::Message);
  item.text = Lossy(type);
  if (data != nullptr && length > 0) {
    std::optional<Json> decoded = DecodeMsgpack(data, length);
    if (decoded) item.value = std::move(*decoded);
  }
  SinkPush(ud, std::move(item));
}

void CbRoom(colyseus_room_t* room, void* ud) {
  Ctx* ctx = static_cast<Ctx*>(ud);
  ctx->room = room;
  if (ctx->sink->orphaned) {
    colyseus_room_leave(room, true);
    return;
  }
  // Wire the room's callbacks right here: the join handshake can arrive in this same poll.
  colyseus_room_on_join(room, CbJoin, ud);
  colyseus_room_on_state_change(room, CbState, ud);
  colyseus_room_on_leave(room, CbLeave, ud);
  colyseus_room_on_drop(room, CbDrop, ud);
  colyseus_room_on_reconnect(room, CbReconnect, ud);
  colyseus_room_on_error(room, CbRoomError, ud);
  colyseus_room_on_message_any_with_type_encoded(room, CbMessage, ud);
  // §8: one reconnect owner, the SDK, from the first millisecond; never on the queue room.
  colyseus_reconnection_options_t options{};
  options.enabled = ctx->reconnect && rc::kEnabled;
  options.max_retries = rc::kMaxRetries;
  options.min_delay_ms = rc::kMinDelayMs;
  options.max_delay_ms = rc::kMaxDelayMs;
  options.min_uptime_ms = rc::kMinUptimeMs;
  options.delay_ms = rc::kDelayMs;
  options.max_enqueued_messages = rc::kMaxEnqueuedMessages;
  colyseus_room_set_reconnection_options(room, &options);
  RawItem item = MakeRaw(RawKind::Room);
  item.room = room;
  SinkPush(ud, std::move(item));
}

void CbJoinError(int code, const char* message, void* ud) {
  RawItem item = MakeRaw(RawKind::JoinError);
  item.code = code;
  item.text = Lossy(message);
  SinkPush(ud, std::move(item));
}

void CbLatency(const char* best, double latencyMs, void* ud) {
  (void)latencyMs;
  RawItem item = MakeRaw(RawKind::Latency);
  item.hasText = best != nullptr;
  item.text = Lossy(best);
  SinkPush(ud, std::move(item));
}

// ---- the room probe (stalled-handshake takeover) ----

/** What the session can see of a room's connection, read from its public head. */
struct RoomProbe {
  /** The core's reconnect attempt counter: n while attempt n is armed or in flight. */
  int retryCount = 0;
  bool reconnecting = false;
  /** The WebSocket upgrade has completed (the transport is open), joined or not. */
  bool open = false;
};

std::uint8_t ProbeByte(const bool& field) {
  std::uint8_t byte = 0;
  std::memcpy(&byte, &field, 1);
  return byte;
}

/** Reads a room's public `struct colyseus_room` after checking its layout against the accessor
 *  functions. nullopt when they disagree, as with a core other than v0.18.10 linked in. `bool`s
 *  are read as bytes so a mismatched layout is detected, never trusted. */
std::optional<RoomProbe> ProbeRoom(colyseus_room_t* room) {
  if (room == nullptr) return std::nullopt;
  colyseus_reconnection_options_t o{};
  colyseus_room_get_reconnection_options(room, &o);
  const colyseus_reconnection_state_t& rs = room->reconnection;
  const std::uint8_t hasJoined = ProbeByte(room->has_joined);
  const std::uint8_t enabled = ProbeByte(rs.options.enabled);
  const std::uint8_t isReconnecting = ProbeByte(rs.is_reconnecting);
  const bool layoutOk = room->session_id == colyseus_room_get_session_id(room) &&
                        room->reconnection_token == colyseus_room_get_reconnection_token(room) && hasJoined <= 1 &&
                        enabled == (o.enabled ? 1 : 0) && rs.options.max_retries == o.max_retries &&
                        rs.options.min_delay_ms == o.min_delay_ms && rs.options.max_delay_ms == o.max_delay_ms &&
                        rs.options.min_uptime_ms == o.min_uptime_ms && rs.options.delay_ms == o.delay_ms &&
                        rs.options.max_enqueued_messages == o.max_enqueued_messages &&
                        isReconnecting == (colyseus_room_is_reconnecting(room) ? 1 : 0) && rs.retry_count >= 0 &&
                        rs.retry_count <= o.max_retries + 1;
  if (!layoutOk) return std::nullopt;
  RoomProbe probe;
  probe.retryCount = rs.retry_count;
  probe.reconnecting = isReconnecting == 1;
  const colyseus_transport_t* t = room->transport;
  probe.open = t != nullptr && t->is_open != nullptr && t->is_open(t);
  return probe;
}

// ---- events ----

RelayEvent Ev(RelayEventType type) {
  RelayEvent e;
  e.type = type;
  return e;
}

RelayEvent EvId(RelayEventType type, std::string id) {
  RelayEvent e = Ev(type);
  e.id = std::move(id);
  return e;
}

RelayEvent EvWarning(std::string message) {
  RelayEvent e = Ev(RelayEventType::Warning);
  e.message = std::move(message);
  return e;
}

std::optional<std::string> NonEmpty(const std::string& s) {
  if (s.empty()) return std::nullopt;
  return s;
}

const Json* FindTyped(const Json& data, const char* key, Json::Type type) {
  const Json* v = data.Find(key);
  return v != nullptr && v->GetType() == type ? v : nullptr;
}

bool IsPoseKey(const std::string& key) {
  for (const char* k : protocol::kPoseKeys) {
    if (key == k) return true;
  }
  return false;
}

std::string StreamOf(const std::string& objectId) { return "obj:" + objectId; }

enum class RoomKind { Play, Queue, Match };

enum class PhaseKind {
  /** Measuring latency to several endpoints. */
  Selecting,
  /** Matchmaking request or socket handshake in flight. */
  Connecting,
  /** Waiting in the queue room for a seat. */
  Queued,
  /** Queue dropped: search again at `t`. */
  Searching,
  Joined,
  /** Since `t`. */
  Reconnecting,
  /** §8: reconnected, waiting (<= 2 s, until `t`) for the first full state. */
  Resyncing,
  Closed,
};

struct Phase {
  PhaseKind kind = PhaseKind::Connecting;
  double t = 0.0;
};

struct RoomSlot {
  colyseus_room_t* room = nullptr;
  std::unique_ptr<Ctx> ctx;
};

struct PlayerMirror {
  RelayPlayerRaw raw;
  Json data = Json::MakeObject();
  bool posedStream = false;
};

struct ObjectMirror {
  RelayObjectRaw raw;
  Json value;
  /** Owner as this client sees it: the relay's, or `me` right after an accepted claim. */
  std::string owner;
  /** The last state this client published while owning it. */
  std::optional<Json> local;
  /** A coalesced publish waiting for the rate limit: the time the game set it. */
  std::optional<double> pending;
  double lastSent = 0.0;
};

struct PendingControl {
  Json payload;
  const char* message = "";
  const char* operation = "";
  std::string id;
  double deadline = 0.0;
};

/** Native-core v0.18.10 workaround: an EOF during a WebSocket handshake leaves the transport
 *  waiting forever, so the core's in-place reconnect stalls with no further attempts and no 4003.
 *  The core owns the reconnect (§8) for as long as it makes progress; the session steps in only
 *  when an attempt has been in flight kStallTakeoverMs (timed from the core's own backoff
 *  schedule) with a socket that never opened: it abandons that room WITHOUT consent and re-takes
 *  the held seat itself with the reconnection token, with its own backoff, until the grace is
 *  nearly spent. An OPEN socket is never abandoned: it is waiting for JOIN_ROOM. */
struct Takeover {
  std::string token;
  std::uint32_t attempt = 0;
  std::optional<double> attemptStarted;
  double nextAt = 0.0;
};

/** The core's current reconnect attempt, as seen through ProbeRoom. */
struct CoreWatch {
  int retryCount = 0;
  /** When the session first saw this retryCount: the core armed the attempt's backoff then. */
  double scheduledAt = 0.0;
};

struct Heartbeat {
  colyseus_input_handle_t* handle = nullptr;
  bool probed = false;
  double nextAt = 0.0;
  bool synced = false;
};

}  // namespace genex::relay_session_detail

namespace genex {

namespace relay_sd = ::genex::relay_session_detail;

// ---- types ----

Json RelayControlResult::ToJson() const {
  Json v = Json::MakeObject();
  v.Set("requestId", requestId);
  v.Set("operation", operation);
  v.Set("id", id);
  v.Set("accepted", accepted);
  v.Set("owner", owner ? Json(*owner) : Json(nullptr));
  v.Set("sequence", sequence);
  v.Set("reason", reason);
  if (retryAfterMs) v.Set("retryAfterMs", *retryAfterMs);
  return v;
}

bool RelayControlResult::FromJson(const Json& data, RelayControlResult* out) {
  const Json* requestId = relay_sd::FindTyped(data, "requestId", Json::Type::String);
  const Json* operation = relay_sd::FindTyped(data, "operation", Json::Type::String);
  const Json* id = relay_sd::FindTyped(data, "id", Json::Type::String);
  const Json* accepted = relay_sd::FindTyped(data, "accepted", Json::Type::Bool);
  const Json* reason = relay_sd::FindTyped(data, "reason", Json::Type::String);
  if (requestId == nullptr || operation == nullptr || id == nullptr || accepted == nullptr || reason == nullptr) {
    return false;
  }
  const Json* owner = data.Find("owner");
  if (owner != nullptr && !owner->IsNull() && !owner->IsString()) return false;
  const Json* sequence = data.Find("sequence");
  if (sequence != nullptr && !sequence->IsNull() && !sequence->IsNumber()) return false;
  const Json* retry = data.Find("retryAfterMs");
  if (retry != nullptr && !retry->IsNull() && !retry->IsNumber()) return false;
  RelayControlResult r;
  r.requestId = requestId->AsString();
  r.operation = operation->AsString();
  r.id = id->AsString();
  r.accepted = accepted->AsBool();
  r.reason = reason->AsString();
  if (owner != nullptr && owner->IsString()) r.owner = owner->AsString();
  if (sequence != nullptr && sequence->IsNumber()) r.sequence = sequence->AsNumber();
  if (retry != nullptr && retry->IsNumber()) r.retryAfterMs = retry->AsNumber();
  if (out != nullptr) *out = std::move(r);
  return true;
}

Json RelayChatMessage::ToJson() const {
  Json v = Json::MakeObject();
  v.Set("id", id);
  v.Set("from", from);
  v.Set("name", name);
  v.Set("text", text);
  v.Set("at", at);
  return v;
}

bool RelayChatMessage::FromJson(const Json& data, RelayChatMessage* out) {
  const Json* id = relay_sd::FindTyped(data, "id", Json::Type::Number);
  const Json* from = relay_sd::FindTyped(data, "from", Json::Type::String);
  const Json* name = relay_sd::FindTyped(data, "name", Json::Type::String);
  const Json* text = relay_sd::FindTyped(data, "text", Json::Type::String);
  const Json* at = relay_sd::FindTyped(data, "at", Json::Type::Number);
  if (id == nullptr || from == nullptr || name == nullptr || text == nullptr || at == nullptr) return false;
  if (out != nullptr) {
    out->id = id->AsNumber();
    out->from = from->AsString();
    out->name = name->AsString();
    out->text = text->AsString();
    out->at = at->AsNumber();
  }
  return true;
}

const char* RelayEventTypeName(RelayEventType type) {
  switch (type) {
    case RelayEventType::Joined: return "joined";
    case RelayEventType::JoinFailed: return "joinFailed";
    case RelayEventType::PlayerJoined: return "playerJoined";
    case RelayEventType::PlayerLeft: return "playerLeft";
    case RelayEventType::HostChanged: return "hostChanged";
    case RelayEventType::SharedChanged: return "sharedChanged";
    case RelayEventType::ObjectChanged: return "objectChanged";
    case RelayEventType::ObjectRemoved: return "objectRemoved";
    case RelayEventType::ControlResult: return "controlResult";
    case RelayEventType::Message: return "message";
    case RelayEventType::Input: return "input";
    case RelayEventType::RoomOpen: return "roomOpen";
    case RelayEventType::Chat: return "chat";
    case RelayEventType::RateDrop: return "rateDrop";
    case RelayEventType::ServerRestart: return "serverRestart";
    case RelayEventType::MatchStart: return "matchStart";
    case RelayEventType::MatchEnded: return "matchEnded";
    case RelayEventType::MatchRequeue: return "matchRequeue";
    case RelayEventType::Queue: return "queue";
    case RelayEventType::Seated: return "seated";
    case RelayEventType::Reconnecting: return "reconnecting";
    case RelayEventType::Reconnected: return "reconnected";
    case RelayEventType::Disconnected: return "disconnected";
    case RelayEventType::Warning: return "warning";
  }
  return "unknown";
}

std::optional<RelayEndpoint> ParseRelayEndpoint(std::string_view url) {
  const std::size_t sep = url.find("://");
  if (sep == std::string_view::npos) return std::nullopt;
  const std::string_view scheme = url.substr(0, sep);
  bool secure = false;
  if (scheme == "ws" || scheme == "http") {
    secure = false;
  } else if (scheme == "wss" || scheme == "https") {
    secure = true;
  } else {
    return std::nullopt;
  }
  std::string_view rest = url.substr(sep + 3);
  while (!rest.empty() && rest.back() == '/') rest.remove_suffix(1);
  if (rest.empty() || rest.find('/') != std::string_view::npos || rest.find('?') != std::string_view::npos) {
    return std::nullopt;
  }
  const std::string_view defaultPort = secure ? "443" : "80";
  std::string_view host;
  std::string_view port;
  const bool bracketed = rest.front() == '[';
  if (bracketed) {
    const std::size_t close = rest.find(']');
    if (close == std::string_view::npos) return std::nullopt;
    host = rest.substr(1, close - 1);
    const std::string_view after = rest.substr(close + 1);
    port = after.size() > 0 && after.front() == ':' ? after.substr(1) : defaultPort;
  } else {
    const std::size_t colon = rest.rfind(':');
    if (colon == std::string_view::npos) {
      host = rest;
      port = defaultPort;
    } else {
      host = rest.substr(0, colon);
      port = rest.substr(colon + 1);
    }
  }
  // port.parse::<u16>(): 1..5 ASCII digits, value <= 65535 (a leading '+' is accepted by Rust;
  // nobody writes one in a URL, so it is refused here).
  if (port.empty() || port.size() > 5) return std::nullopt;
  unsigned value = 0;
  for (const char c : port) {
    if (c < '0' || c > '9') return std::nullopt;
    value = value * 10 + static_cast<unsigned>(c - '0');
  }
  if (value > 65535) return std::nullopt;
  if (host.empty() || (host.find(':') != std::string_view::npos && !bracketed)) return std::nullopt;
  RelayEndpoint e;
  e.host = std::string(host);
  e.port = std::string(port);
  e.secure = secure;
  return e;
}

double RelayCoreBackoffMs(int n) {
  const int shift = (std::min)((std::max)(n, 0), 30);
  const long long d = (1LL << shift) * static_cast<long long>(relay_sd::rc::kDelayMs);
  const long long clamped = (std::min)((std::max)(d, static_cast<long long>(relay_sd::rc::kMinDelayMs)),
                                       static_cast<long long>(relay_sd::rc::kMaxDelayMs));
  return static_cast<double>(clamped);
}

}  // namespace genex

namespace genex::relay_session_detail {

// ---- the session ----

struct SessionCore {
  RelayConnectOptions opts_;
  JoinTokenProvider identity_;
  SessionClock clock_;
  Sink* sink_ = nullptr;
  colyseus_settings_t* settings_ = nullptr;
  colyseus_client_t* client_ = nullptr;
  std::optional<std::string> endpoint_;
  std::optional<RoomSlot> current_;
  std::vector<RoomSlot> retired_;
  /** Join attempts whose matchmaking callback has not fired yet. */
  std::map<std::uint32_t, std::unique_ptr<Ctx>> pendingCtx_;
  std::uint32_t gen_ = 0;
  Phase phase_;
  bool leaving_ = false;
  std::string sessionId_;
  std::string roomId_;
  RoomKind roomKind_ = RoomKind::Play;
  bool joinedOnce_ = false;
  std::size_t searchAttempt_ = 0;
  double connectStarted_ = 0.0;
  std::optional<Takeover> takeover_;
  std::optional<CoreWatch> coreWatch_;
  bool probeWarned_ = false;
  bool noDelayWarned_ = false;
  /** The relay's TCP port, to find the core's sockets for TCP_NODELAY; 0 = unknown. */
  std::uint16_t relayPort_ = 0;

  std::map<std::string, PlayerMirror> players_;
  std::map<std::string, ObjectMirror> objects_;
  std::map<std::string, std::string> shared_;
  std::string host_;
  std::string matchText_;
  double clockOrigin_ = 0.0;
  Interpolator interp_;
  std::vector<RelayPlayerView> playerViews_;
  std::vector<RelayObjectView> objectViews_;

  std::optional<Json> me_;
  /** A coalesced SetMe waiting for the rate limit: the time the game set it. */
  std::optional<double> mePending_;
  double lastPublish_ = 0.0;
  std::string lastDataText_;
  double lastDataSent_ = 0.0;
  std::optional<PoseFields> posePending_;
  std::optional<VelocityMemory> poseMemory_;

  std::map<std::string, PendingControl> pending_;
  std::string requestPrefix_;
  std::uint64_t requestCounter_ = 0;
  std::map<double, RelayChatMessage> chat_;
  Heartbeat heartbeat_;
  std::uint64_t rng_ = 1;
  std::uint64_t droppedOffline_ = 0;
  std::vector<RelayEvent> events_;

  double Now() const { return StampNowMs(clock_); }

  // ---- lifecycle ----

  std::uint64_t NextRandom() {
    // xorshift64*
    std::uint64_t x = rng_;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    rng_ = x;
    return x * 0x2545F4914F6CDD1DULL;
  }

  void* NewCtx(bool reconnect) {
    ++gen_;
    std::unique_ptr<Ctx> ctx(new Ctx());
    ctx->sink = sink_;
    ctx->gen = gen_;
    ctx->reconnect = reconnect;
    void* ptr = ctx.get();
    pendingCtx_[gen_] = std::move(ctx);
    return ptr;
  }

  void Start() {
    double seedClock = Now();
    std::uint64_t bits = 0;
    std::memcpy(&bits, &seedClock, sizeof bits);
    const std::uint64_t addr = static_cast<std::uint64_t>(reinterpret_cast<std::uintptr_t>(sink_));
    rng_ = (bits ^ ((addr << 17) | (addr >> 47))) | 1;
    char prefix[16];
    std::snprintf(prefix, sizeof prefix, "ue%08x", static_cast<unsigned>(NextRandom() & 0xffffffffu));
    requestPrefix_ = prefix;
    opts_.publishHz = (std::min)((std::max)(opts_.publishHz, 1.0), 30.0);
    if (!std::isfinite(opts_.publishHz)) opts_.publishHz = 30.0;
    opts_.controlTimeoutMs = (std::min)((std::max)(opts_.controlTimeoutMs, 100.0), protocol::kControlTimeoutMaxMs);
    if (!std::isfinite(opts_.controlTimeoutMs)) opts_.controlTimeoutMs = protocol::kControlTimeoutMs;
    if (!opts_.options.IsObject()) opts_.options = Json::MakeObject();
    if (opts_.endpoints.empty()) {
      FailJoin(0, "no relay endpoint given");
    } else if (opts_.endpoints.size() == 1) {
      UseEndpoint(opts_.endpoints[0]);
    } else {
      SelectEndpoint();
    }
  }

  void SelectEndpoint() {
    phase_.kind = PhaseKind::Selecting;
    std::vector<const char*> ptrs;
    ptrs.reserve(opts_.endpoints.size());
    for (const std::string& url : opts_.endpoints) ptrs.push_back(url.c_str());
    const std::string& first = opts_.endpoints.front();
    colyseus_latency_options_t options{};
    options.ping_count = 2;
    options.timeout_ms = 1500;
    options.use_secure = first.rfind("wss", 0) == 0 || first.rfind("https", 0) == 0;
    options.tls_skip_verification = false;
    options.ca_pem_data = nullptr;
    options.ca_pem_len = 0;
    void* ud = NewCtx(false);
    colyseus_select_by_latency(ptrs.data(), ptrs.size(), &options, CbLatency, ud);
  }

  void UseEndpoint(const std::string& url) {
    std::optional<RelayEndpoint> parsed = ParseRelayEndpoint(url);
    if (!parsed) {
      FailJoin(0, "unsupported relay URL `" + url + "` (expected ws://host[:port] or wss://host[:port])");
      return;
    }
    relayPort_ = static_cast<std::uint16_t>(std::stoul(parsed->port));
    settings_ = colyseus_settings_create();
    colyseus_settings_set_address(settings_, parsed->host.c_str());
    colyseus_settings_set_port(settings_, parsed->port.c_str());
    colyseus_settings_set_secure(settings_, parsed->secure);
    client_ = colyseus_client_create(settings_);
    endpoint_ = url;
    StartJoin(opts_.room);
  }

  bool JoinOptions(std::string* text, std::string* error) {
    JoinToken token = identity_ ? identity_() : JoinToken::Fail("no identity provider");
    if (!token.ok) {
      *error = token.error;
      return false;
    }
    Json o = Json::MakeObject();
    o.Set(protocol::join_option::kGameId, opts_.gameId);
    o.Set(protocol::join_option::kEmbedToken, std::move(token.token));
    if (opts_.name) o.Set(protocol::join_option::kName, *opts_.name);
    for (const JsonMember& member : opts_.options.Members()) o.Set(member.key, member.value);
    // Last, so nothing can misreport it (§2).
    o.Erase(protocol::join_option::kProtocol);
    o.Set(protocol::join_option::kProtocol, protocol::kProtocolVersion);
    *text = o.Dump();
    if (text->find('\0') != std::string::npos) {
      *error = "join options contain a NUL byte";
      return false;
    }
    return true;
  }

  void StartJoin(RelayTarget target) {
    std::string options;
    std::string error;
    if (!JoinOptions(&options, &error)) {
      FailJoin(protocol::join_error::kAuthRequired, "identity provider failed: " + error);
      return;
    }
    RoomKind kind = RoomKind::Match;
    if (target == RelayTarget::Queue) kind = RoomKind::Queue;
    if (target == RelayTarget::Play) kind = RoomKind::Play;
    void* ud = NewCtx(kind != RoomKind::Queue);
    roomKind_ = kind;
    phase_.kind = PhaseKind::Connecting;
    connectStarted_ = Now();
    switch (target) {
      case RelayTarget::Play:
        colyseus_client_join_or_create(client_, protocol::room_type::kPlay, options.c_str(), CbRoom, CbJoinError, ud);
        break;
      case RelayTarget::Queue:
        colyseus_client_join_or_create(client_, protocol::room_type::kQueue, options.c_str(), CbRoom, CbJoinError, ud);
        break;
      case RelayTarget::CreatePrivate:
        colyseus_client_create_room(client_, protocol::room_type::kMatch, options.c_str(), CbRoom, CbJoinError, ud);
        break;
      case RelayTarget::JoinById:
        colyseus_client_join_by_id(client_, opts_.joinCode.c_str(), options.c_str(), CbRoom, CbJoinError, ud);
        break;
    }
  }

  void ConsumeSeat(const Json& reservation) {
    const std::string json = reservation.Dump();
    void* ud = NewCtx(true);
    roomKind_ = RoomKind::Match;
    phase_.kind = PhaseKind::Connecting;
    connectStarted_ = Now();
    colyseus_client_consume_seat_reservation_json(client_, json.c_str(), CbRoom, CbJoinError, ud);
  }

  void FailJoin(int code, std::string message) {
    phase_.kind = PhaseKind::Closed;
    RelayEvent e = Ev(RelayEventType::JoinFailed);
    e.code = code;
    e.message = std::move(message);
    events_.push_back(std::move(e));
  }

  void Leave() {
    leaving_ = true;
    if (current_) {
      colyseus_room_leave(current_->room, true);
    } else if (phase_.kind != PhaseKind::Closed) {
      Close(protocol::close_code::kConsented, "left");
    }
  }

  void RetireCurrent(bool consentedLeave) {
    if (current_) {
      if (consentedLeave) colyseus_room_leave(current_->room, true);  // its on_leave frees it later
      retired_.push_back(std::move(*current_));
      current_.reset();
    }
    const bool synced = heartbeat_.synced;
    heartbeat_ = Heartbeat();
    heartbeat_.synced = synced;
  }

  /** Drop the current room without consent. Used only on a room whose socket is not open:
   *  colyseus_room_leave(room, false) then sends nothing, cancels the core's retries and reports
   *  on_leave at once, and the slot is freed when that arrives. */
  void AbandonCurrent() {
    if (current_) colyseus_room_leave(current_->room, false);
    RetireCurrent(false);
  }

  /** Set TCP_NODELAY on the core's relay sockets; say so when none was found. */
  void ApplyNoDelayNow() {
    if (relayPort_ == 0) return;
    const std::optional<std::size_t> set = ApplyNoDelay(relayPort_);
    if (!set) {
      if (!noDelayWarned_) {
        noDelayWarned_ = true;
        events_.push_back(EvWarning(
            "TCP_NODELAY cannot be set on this platform's relay socket: state may arrive in bursts"));
      }
    } else if (*set == 0) {
      events_.push_back(EvWarning("found no relay socket (port " + std::to_string(relayPort_) +
                                  ") to set TCP_NODELAY on: state may arrive in bursts"));
    }
  }

  void FreeRetired(std::uint32_t gen) {
    for (std::size_t i = 0; i < retired_.size(); ++i) {
      if (retired_[i].ctx->gen == gen) {
        // Free the room while its Ctx is still alive: colyseus_room_free closes the transport,
        // which reports on_leave synchronously with that Ctx as userdata.
        RoomSlot slot = std::move(retired_[i]);
        retired_.erase(retired_.begin() + static_cast<std::ptrdiff_t>(i));
        colyseus_room_free(slot.room);
        return;
      }
    }
  }

  void Close(int code, std::string reason) {
    if (phase_.kind == PhaseKind::Closed) return;
    phase_.kind = PhaseKind::Closed;
    std::map<std::string, PendingControl> pending = std::move(pending_);
    pending_.clear();
    for (auto& entry : pending) {
      RelayEvent e = Ev(RelayEventType::ControlResult);
      e.control.requestId = entry.first;
      e.control.operation = entry.second.operation;
      e.control.id = entry.second.id;
      e.control.accepted = false;
      e.control.reason = "disconnected";
      events_.push_back(std::move(e));
    }
    RelayEvent e = Ev(RelayEventType::Disconnected);
    e.code = code;
    e.message = std::move(reason);
    events_.push_back(std::move(e));
  }

  // ---- update ----

  void Update() {
    std::deque<RawItem> raw;
    raw.swap(sink_->raw);
    for (RawItem& item : raw) Process(item);
    const double now = Now();
    RunTimers(now);
    RefreshViews(now);
  }

  void Process(RawItem& item) {
    const std::uint32_t gen = item.gen;
    // A plain flag + value, not std::optional<uint32_t>: GCC 12 -O2 reports a false
    // -Wmaybe-uninitialized on the optional's payload, which -Werror turns into a failed build.
    const bool hasCurrent = static_cast<bool>(current_);
    const std::uint32_t currentGen = hasCurrent ? current_->ctx->gen : 0u;
    if (item.kind == RawKind::Room) {
      auto it = pendingCtx_.find(gen);
      if (it != pendingCtx_.end()) {
        RoomSlot slot;
        slot.room = item.room;
        slot.ctx = std::move(it->second);
        pendingCtx_.erase(it);
        if (gen == gen_ && phase_.kind != PhaseKind::Closed) {
          current_ = std::move(slot);
        } else {
          // A stale attempt's room: leave it; freed on its on_leave.
          colyseus_room_leave(slot.room, true);
          retired_.push_back(std::move(slot));
        }
      }
      return;
    }
    if (item.kind == RawKind::Latency) {
      pendingCtx_.erase(gen);
      // Left while choosing: Leave() already closed the session. Rust's `Raw::Latency =>
      // use_endpoint` has no guard here and would ask for a token and join after Disconnected.
      if (phase_.kind == PhaseKind::Closed || leaving_) return;
      UseEndpoint(item.hasText ? item.text : opts_.endpoints[0]);
      return;
    }
    if (item.kind == RawKind::JoinError) {
      const bool ours = gen == gen_;
      pendingCtx_.erase(gen);
      if (hasCurrent && currentGen == gen) RetireCurrent(false);
      FreeRetired(gen);
      if (ours && takeover_) {
        TakeoverAttemptFailed(item.code, item.text);
      } else if (ours) {
        OnJoinError(item.code, item.text);
      }
      return;
    }
    if (!hasCurrent || currentGen != gen) {
      if (item.kind == RawKind::Leave) FreeRetired(gen);
      return;
    }
    const bool takingOver = takeover_.has_value() && phase_.kind == PhaseKind::Reconnecting;
    switch (item.kind) {
      case RawKind::Joined:
        if (takingOver) {
          OnTakeoverJoined(item.at);
        } else {
          OnJoined();
        }
        break;
      case RawKind::Leave:
      case RawKind::RoomError:
        if (takingOver) {
          RetireCurrent(false);
          FreeRetired(gen);
          TakeoverAttemptFailed(0, item.text);
        } else if (item.kind == RawKind::Leave) {
          OnLeave(gen, item.code, item.text);
        } else if (phase_.kind == PhaseKind::Connecting) {
          RetireCurrent(false);
          FreeRetired(gen);
          OnJoinError(item.code, item.text);
        } else {
          events_.push_back(EvWarning("room error " + std::to_string(item.code) + ": " + item.text));
        }
        break;
      case RawKind::State:
        OnState(std::move(item.snap), item.at);
        break;
      case RawKind::Message:
        OnMessage(item.text, std::move(item.value));
        break;
      case RawKind::Drop:
        if (roomKind_ != RoomKind::Queue && !leaving_) {
          if (phase_.kind != PhaseKind::Reconnecting) {
            phase_.kind = PhaseKind::Reconnecting;
            phase_.t = item.at;
            coreWatch_.reset();
          }
          RelayEvent e = Ev(RelayEventType::Reconnecting);
          e.code = item.code;
          events_.push_back(std::move(e));
        }
        break;
      case RawKind::Reconnect:
        if (phase_.kind == PhaseKind::Reconnecting) {
          // §8 step 2, done before the snapshot lands so its samples seed the rebased history.
          if (item.at - phase_.t > protocol::interpolation::kRebaseAfterGapMs) interp_.RebaseAll();
        }
        if (leaving_) {
          if (current_) colyseus_room_leave(current_->room, true);
          return;
        }
        phase_.kind = PhaseKind::Resyncing;
        phase_.t = item.at + rc::kFirstStateTimeoutMs;
        break;
      case RawKind::Room:
      case RawKind::Latency:
      case RawKind::JoinError:
        break;
    }
  }

  void ReconnectWatchdog(double now, double since) {
    if (leaving_) return;
    if (now - since > kReconnectGiveUpMs) {
      takeover_.reset();
      RetireCurrent(true);
      Close(protocol::close_code::kFailedToReconnect, "reconnection failed");
      return;
    }
    if (!takeover_) {
      if (!current_) return;
      colyseus_room_t* room = current_->room;
      const std::optional<RoomProbe> probe = ProbeRoom(room);
      if (!probe) {
        WarnProbeUnavailable();
        return;
      }
      if (!probe->reconnecting) return;
      const bool fresh = !coreWatch_ || coreWatch_->retryCount != probe->retryCount;
      if (fresh) {
        CoreWatch w;
        w.retryCount = probe->retryCount;
        // The first attempt was armed by the drop itself.
        w.scheduledAt = coreWatch_ ? now : since;
        coreWatch_ = w;
      }
      const double attemptStarted = coreWatch_->scheduledAt + RelayCoreBackoffMs(coreWatch_->retryCount);
      if (probe->open || now - attemptStarted < kStallTakeoverMs) return;
      const std::string token = Lossy(colyseus_room_get_reconnection_token(room));
      if (token.empty()) return;
      char text[256];
      std::snprintf(text, sizeof text,
                    "reconnect attempt %d has had no open socket for %.0f ms (a native-core handshake stall); "
                    "re-taking the held seat",
                    coreWatch_->retryCount, now - attemptStarted);
      events_.push_back(EvWarning(text));
      AbandonCurrent();
      Takeover t;
      t.token = token;
      t.nextAt = now;
      takeover_ = std::move(t);
    }
    if (!takeover_) return;
    if (takeover_->attemptStarted) {
      if (now - *takeover_->attemptStarted <= kTakeoverAttemptTimeoutMs) return;
      // Only this attempt's own room, and only while its socket has not opened. With no room yet
      // the matchmake request is still out; the give-up above bounds the wait.
      if (!current_ || current_->ctx->gen != gen_) return;
      const std::optional<RoomProbe> p = ProbeRoom(current_->room);
      if (!p || p->open) return;
      AbandonCurrent();
      TakeoverAttemptFailed(0, "reconnect attempt timed out");
    } else if (now >= takeover_->nextAt) {
      void* ud = NewCtx(true);
      colyseus_client_reconnect(client_, takeover_->token.c_str(), CbRoom, CbJoinError, ud);
      takeover_->attempt += 1;
      takeover_->attemptStarted = now;
    }
  }

  void WarnProbeUnavailable() {
    if (probeWarned_) return;
    probeWarned_ = true;
    events_.push_back(EvWarning(
        "the linked Colyseus core is not v0.18.10's layout: a stalled reconnect cannot be detected and ends at the "
        "27 s give-up"));
  }

  void TakeoverAttemptFailed(int code, const std::string& message) {
    if (code >= 4000) {
      // The relay no longer holds the seat.
      takeover_.reset();
      Close(protocol::close_code::kFailedToReconnect, message);
      return;
    }
    if (takeover_) {
      takeover_->attemptStarted.reset();
      const std::uint32_t shift = (std::min)(takeover_->attempt, 3u);
      takeover_->nextAt = Now() + (std::min)(250.0 * static_cast<double>(1u << shift), 2000.0);
    }
  }

  void OnTakeoverJoined(double at) {
    if (!current_) return;
    const std::string sid = Lossy(colyseus_room_get_session_id(current_->room));
    const std::string rid = Lossy(colyseus_room_get_id(current_->room));
    if (sid != sessionId_) {
      events_.push_back(EvWarning("reconnected into session " + sid + ", expected " + sessionId_));
      sessionId_ = sid;
    }
    roomId_ = rid;
    takeover_.reset();
    if (phase_.kind == PhaseKind::Reconnecting && at - phase_.t > protocol::interpolation::kRebaseAfterGapMs) {
      interp_.RebaseAll();
    }
    phase_.kind = PhaseKind::Resyncing;
    phase_.t = at + rc::kFirstStateTimeoutMs;
  }

  void OnJoinError(int code, const std::string& message) {
    if (code == protocol::join_error::kProtocolUnsupported) {
      events_.push_back(EvWarning("the relay refused protocol " + std::to_string(protocol::kProtocolVersion) +
                                  " (426): this build of the Genex Unreal plugin is too old for it; update and rebuild"));
    }
    // A queue search that failed for a transient reason searches again; a refusal never does.
    const bool refusal = code >= 400 && code < 500;
    if (opts_.room == RelayTarget::Queue && !refusal && !leaving_) {
      ScheduleSearch();
      return;
    }
    FailJoin(code, message);
  }

  void OnJoined() {
    if (!current_) return;
    const std::string sid = Lossy(colyseus_room_get_session_id(current_->room));
    const std::string rid = Lossy(colyseus_room_get_id(current_->room));
    if (roomKind_ == RoomKind::Queue) {
      phase_.kind = PhaseKind::Queued;
      searchAttempt_ = 0;
      return;
    }
    sessionId_ = sid;
    roomId_ = rid;
    phase_.kind = PhaseKind::Joined;
    joinedOnce_ = true;
    ApplyNoDelayNow();
    events_.push_back(EvId(RelayEventType::Joined, sid));
    // §12: history after the listener exists.
    SendValue(cm::kChatHistoryRequest, Json::MakeObject());
    // Requests made before the join was confirmed.
    ResendPending();
    if (me_ || posePending_) mePending_ = Now();
  }

  void OnLeave(std::uint32_t gen, int code, const std::string& reason) {
    const RoomKind kind = roomKind_;
    RetireCurrent(false);
    FreeRetired(gen);
    if (kind == RoomKind::Queue && !leaving_ && phase_.kind != PhaseKind::Closed) {
      // §9.2 step 3: a dropped search searches again with backoff.
      ScheduleSearch();
      return;
    }
    Close(code, reason);
  }

  void ScheduleSearch() {
    static constexpr double kBackoff[3] = {1000.0, 2000.0, 4000.0};
    const double delay = kBackoff[(std::min)(searchAttempt_, static_cast<std::size_t>(2))];
    ++searchAttempt_;
    phase_.kind = PhaseKind::Searching;
    phase_.t = Now() + delay;
  }

  // ---- state ----

  void OnState(RelayStateSnapshot snap, double at) {
    if (roomKind_ == RoomKind::Queue) return;
    ApplySnapshot(std::move(snap), at);
    if (!heartbeat_.probed) {
      heartbeat_.probed = true;
      // §16.2 Detect: the handshake's INPUT_REFLECTION is parsed by the time state arrives.
      // NULL vtable = synthesize from the handshake (NULL when the relay publishes no clock).
      colyseus_input_handle_t* handle =
          current_ ? colyseus_room_input(current_->room, nullptr, nullptr) : nullptr;
      if (handle != nullptr) {
        heartbeat_.handle = handle;
        heartbeat_.nextAt = at;
      }
    }
    if (phase_.kind == PhaseKind::Resyncing) FinishResync();
  }

  /** §8 post-reconnect steps 3-6 (the snapshot diff already reconciled the mirrors). */
  void FinishResync() {
    phase_.kind = PhaseKind::Joined;
    ApplyNoDelayNow();
    ResendPending();
    SendValue(cm::kChatHistoryRequest, Json::MakeObject());
    if (me_ || posePending_) mePending_ = Now();
    events_.push_back(Ev(RelayEventType::Reconnected));
    if (droppedOffline_ > 0) {
      events_.push_back(EvWarning(std::to_string(droppedOffline_) +
                                  " game event(s)/input(s) were dropped while reconnecting (they are never queued)"));
      droppedOffline_ = 0;
    }
  }

  void ApplySnapshot(RelayStateSnapshot snap, double at) {
    const std::string me = sessionId_;

    // players
    std::set<std::string> seen;
    for (auto& entry : snap.players) {
      const std::string& pid = entry.first;
      RelayPlayerRaw& p = entry.second;
      seen.insert(pid);
      const bool joining = players_.find(pid) == players_.end();
      PlayerMirror& m = players_[pid];
      const bool dataChanged = joining || p.data != m.raw.data;
      const bool epochChanged = !joining && p.epoch != m.raw.epoch;
      const bool poseChanged = p.poseT != m.raw.poseT;
      std::optional<double> sendTime;
      if (dataChanged) {
        PlayerData parsed = ParsePlayerData(p.data);
        m.data = std::move(parsed.state);
        sendTime = parsed.sendTime;
      }
      if (pid != me) {
        if (p.posed && !m.posedStream) {
          m.posedStream = true;
          interp_.SetPosed(pid, true);
        }
        if (epochChanged) interp_.ResetEpoch(pid);
        if (p.posed) {
          if (p.poseT != 0.0 && (poseChanged || epochChanged)) {
            interp_.Push(pid, pid, p.poseT, PoseMap(p.pose, p.anim), at);
          }
        } else if (sendTime && (dataChanged || epochChanged)) {
          interp_.Push(pid, pid, *sendTime, m.data, at);
        }
      }
      m.raw = std::move(p);
      if (joining) events_.push_back(EvId(RelayEventType::PlayerJoined, pid));
    }
    for (auto it = players_.begin(); it != players_.end();) {
      if (seen.count(it->first) != 0) {
        ++it;
        continue;
      }
      const std::string gone = it->first;
      it = players_.erase(it);
      interp_.RemoveStream(gone);
      interp_.RemoveSender(gone);
      events_.push_back(EvId(RelayEventType::PlayerLeft, gone));
    }

    // objects (§7.3 rules, in order)
    seen.clear();
    for (auto& entry : snap.objects) {
      const std::string& oid = entry.first;
      RelayObjectRaw& o = entry.second;
      seen.insert(oid);
      const std::string stream = StreamOf(oid);
      const bool known = objects_.find(oid) != objects_.end();
      ObjectMirror& m = objects_[oid];
      const bool seqChanged = known && o.seq != m.raw.seq;
      const bool epochChanged = known && o.epoch != m.raw.epoch;
      const bool tChanged = o.t != m.raw.t;
      if (!known || o.d != m.raw.d) {
        std::optional<Json> parsed = ParseJsonText(o.d);
        m.value = parsed ? std::move(*parsed) : Json();
      }
      const std::string prevOwner = std::move(m.owner);
      m.owner.clear();
      const bool ownerChanged = !known || o.owner != m.raw.owner;
      const bool mineNow = !o.owner.empty() && o.owner == me;
      // 1. Ownership moved: soft handoff. Leaving us, the bridge starts from our own last publish.
      if (seqChanged && !mineNow) {
        if (prevOwner == me && !me.empty()) {
          const Json held = m.local ? *m.local : m.value;
          if (held.IsObject()) interp_.Hold(stream, held, at);
        }
        interp_.SoftHandoff(stream);
      }
      if (!mineNow) {
        m.local.reset();
        m.pending.reset();
      }
      // 2. Hard reset.
      if (epochChanged) interp_.ResetEpoch(stream);
      // 3. A sample from the current owner (never fed to our own objects).
      if (!mineNow && o.t != 0.0 && (tChanged || epochChanged) && m.value.IsObject()) {
        interp_.Push(stream, o.owner, o.t, m.value, at);
      }
      // 4. t == 0: the resting pose; the view falls back to the raw value.
      m.owner = o.owner;
      const std::optional<std::string> owner = NonEmpty(o.owner);
      m.raw = std::move(o);
      if (ownerChanged) {
        RelayEvent e = EvId(RelayEventType::ObjectChanged, oid);
        e.owner = owner;
        events_.push_back(std::move(e));
      }
    }
    for (auto it = objects_.begin(); it != objects_.end();) {
      if (seen.count(it->first) != 0) {
        ++it;
        continue;
      }
      const std::string gone = it->first;
      it = objects_.erase(it);
      interp_.RemoveStream(StreamOf(gone));
      events_.push_back(EvId(RelayEventType::ObjectRemoved, gone));
    }

    // host
    if (snap.host != host_) {
      host_ = snap.host;
      RelayEvent e = Ev(RelayEventType::HostChanged);
      e.owner = NonEmpty(host_);
      events_.push_back(std::move(e));
    }
    // shared (keys are never removed)
    for (auto& entry : snap.shared) {
      auto it = shared_.find(entry.first);
      if (it == shared_.end() || it->second != entry.second) {
        shared_[entry.first] = entry.second;
        events_.push_back(EvId(RelayEventType::SharedChanged, entry.first));
      }
    }
    matchText_ = std::move(snap.matchText);
    clockOrigin_ = snap.clockOrigin;
  }

  // ---- messages ----

  void OnMessage(const std::string& kind, Json data) {
    if (kind == sm::kObjectResult) {
      OnControlResult(data);
    } else if (kind == sm::kInput) {
      if (IsHost()) {
        RelayEvent e = Ev(RelayEventType::Input);
        const Json* from = data.Find("from");
        e.id = from != nullptr ? from->AsString() : std::string();
        const Json* d = data.Find("d");
        e.data = d != nullptr ? *d : Json();
        events_.push_back(std::move(e));
      }
    } else if (kind == sm::kRoomOpen) {
      RelayEvent e = Ev(RelayEventType::RoomOpen);
      const Json* open = data.Find("open");
      e.flag = open != nullptr ? open->AsBool(true) : true;
      events_.push_back(std::move(e));
    } else if (kind == sm::kChat) {
      RelayChatMessage line;
      if (RelayChatMessage::FromJson(data, &line)) MergeChat(std::move(line));
    } else if (kind == sm::kChatHistory) {
      const Json* lines = data.Find("messages");
      if (lines != nullptr && lines->IsArray()) {
        for (const Json& item : lines->Items()) {
          RelayChatMessage line;
          if (RelayChatMessage::FromJson(item, &line)) MergeChat(std::move(line));
        }
      }
    } else if (kind == sm::kRateDrop) {
      RelayEvent e = Ev(RelayEventType::RateDrop);
      const Json* dropped = data.Find("dropped");
      e.value = dropped != nullptr ? dropped->AsNumber(0.0) : 0.0;
      events_.push_back(std::move(e));
    } else if (kind == sm::kServerRestart) {
      events_.push_back(Ev(RelayEventType::ServerRestart));
    } else if (kind == sm::kMatchStart) {
      RelayEvent e = Ev(RelayEventType::MatchStart);
      const Json* round = data.Find("roundId");
      e.value = round != nullptr ? round->AsNumber(0.0) : 0.0;
      events_.push_back(std::move(e));
    } else if (kind == sm::kMatchEnded) {
      RelayEvent e = Ev(RelayEventType::MatchEnded);
      e.data = std::move(data);
      events_.push_back(std::move(e));
    } else if (kind == sm::kMatchRequeue) {
      RelayEvent e = Ev(RelayEventType::MatchRequeue);
      const Json* reason = data.Find("reason");
      if (reason != nullptr && reason->IsString()) e.owner = reason->AsString();
      events_.push_back(std::move(e));
      // §9.2 step 4: leave with consent and search again within 5 s.
      if (opts_.room == RelayTarget::Queue && !leaving_) {
        ResetRoomView();
        RetireCurrent(true);
        StartJoin(RelayTarget::Queue);
      }
    } else if (kind == sm::kQueue) {
      RelayEvent e = Ev(RelayEventType::Queue);
      const Json* position = data.Find("position");
      const Json* size = data.Find("size");
      e.value = position != nullptr ? position->AsNumber(0.0) : 0.0;
      e.value2 = size != nullptr ? size->AsNumber(0.0) : 0.0;
      events_.push_back(std::move(e));
    } else if (kind == sm::kSeat) {
      if (roomKind_ == RoomKind::Queue) {
        const Json* reservation = data.Find("reservation");
        if (reservation != nullptr) {
          const Json copy = *reservation;
          events_.push_back(Ev(RelayEventType::Seated));
          RetireCurrent(true);
          ConsumeSeat(copy);
        }
      }
    } else if (kind == sm::kVoiceIce || kind == sm::kVoiceSignal || kind == sm::kVoiceRejected) {
      // Voice is browser-only.
    } else if (protocol::IsReservedEventType(kind)) {
      // A relay message this client does not handle.
    } else {
      RelayEvent e = EvId(RelayEventType::Message, kind);
      e.data = std::move(data);
      events_.push_back(std::move(e));
    }
  }

  void ResetRoomView() {
    for (auto& entry : players_) {
      interp_.RemoveStream(entry.first);
      interp_.RemoveSender(entry.first);
      events_.push_back(EvId(RelayEventType::PlayerLeft, entry.first));
    }
    players_.clear();
    for (auto& entry : objects_) {
      interp_.RemoveStream(StreamOf(entry.first));
      events_.push_back(EvId(RelayEventType::ObjectRemoved, entry.first));
    }
    objects_.clear();
    shared_.clear();
    if (!host_.empty()) {
      host_.clear();
      events_.push_back(Ev(RelayEventType::HostChanged));
    }
    matchText_.clear();
  }

  void MergeChat(RelayChatMessage line) {
    // Rust keys by `id as i64`; ids are integers the relay counts up, so the double is exact.
    const double key = std::trunc(line.id);
    if (chat_.find(key) != chat_.end()) return;
    RelayEvent e = Ev(RelayEventType::Chat);
    e.chat = line;
    chat_[key] = std::move(line);
    events_.push_back(std::move(e));
    while (chat_.size() > kChatKeep) chat_.erase(chat_.begin());
  }

  void OnControlResult(const Json& data) {
    RelayControlResult result;
    if (!RelayControlResult::FromJson(data, &result)) return;
    if (pending_.erase(result.requestId) == 0) return;
    if (result.accepted) {
      const std::string me = sessionId_;
      if (result.operation == protocol::object_control::kOpClaim) {
        ObjectMirror& m = objects_[result.id];
        if (m.owner != me) {
          m.owner = me;
          interp_.SoftHandoff(StreamOf(result.id));
        }
      } else if (result.operation == protocol::object_control::kOpRelease) {
        auto it = objects_.find(result.id);
        if (it != objects_.end()) {
          it->second.owner.clear();
          it->second.local.reset();
          it->second.pending.reset();
        }
      }
    }
    RelayEvent e = Ev(RelayEventType::ControlResult);
    e.control = std::move(result);
    events_.push_back(std::move(e));
  }

  // ---- timers ----

  void RunTimers(double now) {
    switch (phase_.kind) {
      case PhaseKind::Connecting:
        if (now - connectStarted_ > kConnectTimeoutMs) {
          RetireCurrent(true);
          OnJoinError(0, "timed out waiting for the relay handshake");
        }
        break;
      case PhaseKind::Reconnecting:
        ReconnectWatchdog(now, phase_.t);
        break;
      case PhaseKind::Resyncing:
        if (now >= phase_.t) FinishResync();
        break;
      case PhaseKind::Searching:
        if (now >= phase_.t) StartJoin(RelayTarget::Queue);
        break;
      case PhaseKind::Selecting:
      case PhaseKind::Queued:
      case PhaseKind::Joined:
      case PhaseKind::Closed:
        break;
    }
    // Control request timeouts (§7.2).
    for (auto it = pending_.begin(); it != pending_.end();) {
      if (now < it->second.deadline) {
        ++it;
        continue;
      }
      RelayEvent e = Ev(RelayEventType::ControlResult);
      e.control.requestId = it->first;
      e.control.operation = it->second.operation;
      e.control.id = it->second.id;
      e.control.accepted = false;
      e.control.reason = "timeout";
      events_.push_back(std::move(e));
      it = pending_.erase(it);
    }
    if (!SocketOpen() || phase_.kind != PhaseKind::Joined) return;
    // §16.2 heartbeat, on wall-clock deadlines (never once per rendered frame).
    if (heartbeat_.handle != nullptr && now >= heartbeat_.nextAt) {
      colyseus_input_handle_send(heartbeat_.handle);
      const double base = 1000.0 / protocol::clock_sync::kHeartbeatHz;
      const double unit = static_cast<double>(NextRandom()) / static_cast<double>(UINT64_MAX);
      const double dither = unit * 2.0 - 1.0;
      const double next = (std::min)((std::max)(base * (1.0 + dither * protocol::clock_sync::kHeartbeatDither),
                                                1000.0 / protocol::clock_sync::kMaxHeartbeatHz),
                                     1000.0 / protocol::clock_sync::kMinHeartbeatHz);
      heartbeat_.nextAt = now + next;
      if (colyseus_input_handle_last_processed(heartbeat_.handle) >= protocol::clock_sync::kWarmupAcks) {
        heartbeat_.synced = true;
      }
    }
    // Publishes the rate limit coalesced, stamped with the time the game set them.
    const double interval = PublishInterval();
    if (mePending_ && now - lastPublish_ >= interval) PublishMe(*mePending_);
    std::vector<std::pair<std::string, double>> due;
    for (const auto& entry : objects_) {
      if (entry.second.pending && now - entry.second.lastSent >= interval) {
        due.emplace_back(entry.first, *entry.second.pending);
      }
    }
    for (const auto& item : due) PublishObject(item.first, item.second);
  }

  double PublishInterval() const { return 1000.0 / opts_.publishHz; }

  /** Send your pose (when posing) and `data`, stamped `t`: the time the game set them (§6.1). */
  void PublishMe(double t) {
    lastPublish_ = Now();
    mePending_.reset();
    if (posePending_) {
      VelocityMemory memory;
      const PoseFields pose =
          DeriveVelocity(*posePending_, t, poseMemory_ ? &*poseMemory_ : nullptr, &memory);
      posePending_.reset();
      poseMemory_ = memory;
      SendPose(cm::kPose, pose, t);
    }
    if (!me_) return;
    const Json data = DataPart(*me_);
    std::string text = data.Dump();
    // A posed player sends `data` only when it changes, plus a slow keepalive (§6.6).
    if (opts_.pose && text == lastDataText_ && t - lastDataSent_ < 2000.0) return;
    StampedState stamped;
    if (StampState(data, t, &stamped)) {
      if (SendValue(cm::kState, Json(stamped.text)).Ok()) {
        lastDataText_ = std::move(text);
        lastDataSent_ = t;
      }
    }
  }

  /** Publish now when the rate limit allows, else coalesce (the latest state wins). */
  void RequestPublishMe() {
    const double now = Now();
    if (now - lastPublish_ >= PublishInterval() && SocketOpen()) {
      PublishMe(now);
    } else {
      mePending_ = now;
    }
  }

  void PublishObject(const std::string& id, double t) {
    auto it = objects_.find(id);
    if (it == objects_.end()) return;
    ObjectMirror& m = it->second;
    m.pending.reset();
    m.lastSent = Now();
    if (m.owner != sessionId_) return;
    if (m.local) {
      Json payload = Json::MakeObject();
      payload.Set("id", id);
      payload.Set("d", *m.local);
      payload.Set("t", t);
      SendValue(cm::kObject, payload);
    }
  }

  // ---- views ----

  void RefreshViews(double now) {
    const std::string& me = sessionId_;
    std::vector<RelayPlayerView> players;
    players.reserve(players_.size());
    for (const auto& entry : players_) {
      const std::string& pid = entry.first;
      const PlayerMirror& m = entry.second;
      const bool isMe = pid == me;
      const bool posed = m.raw.posed;
      Json raw = m.data;
      if (!raw.IsObject()) raw = Json::MakeObject();
      if (posed) {
        const Json pose = PoseMap(m.raw.pose, m.raw.anim);
        for (const JsonMember& member : pose.Members()) raw.Set(member.key, member.value);
      }
      RelayPlayerView view;
      if (isMe) {
        view.state = me_ ? *me_ : raw;
      } else {
        std::optional<Json> sampled = interp_.Sample(pid, now);
        if (sampled && posed) {
          Json merged = m.data.IsObject() ? m.data : Json::MakeObject();
          for (const JsonMember& member : sampled->Members()) merged.Set(member.key, member.value);
          view.state = std::move(merged);
        } else if (sampled) {
          view.state = std::move(*sampled);
        } else {
          view.state = raw;
        }
      }
      view.id = pid;
      view.name = m.raw.name;
      view.uid = m.raw.uid;
      view.team = static_cast<int>(m.raw.team);
      view.connected = m.raw.connected;
      view.avatarUrl = m.raw.avatarUrl;
      view.stateRaw = std::move(raw);
      view.epoch = m.raw.epoch;
      view.isMe = isMe;
      view.posed = posed;
      players.push_back(std::move(view));
    }
    std::vector<RelayObjectView> objects;
    objects.reserve(objects_.size());
    for (const auto& entry : objects_) {
      const ObjectMirror& m = entry.second;
      const bool mine = !me.empty() && m.owner == me;
      RelayObjectView view;
      if (mine) {
        view.state = m.local ? *m.local : m.value;
      } else {
        std::optional<Json> sampled = interp_.Sample(StreamOf(entry.first), now);
        view.state = sampled ? std::move(*sampled) : m.value;
      }
      view.id = entry.first;
      view.owner = NonEmpty(m.owner);
      view.seq = m.raw.seq;
      view.epoch = m.raw.epoch;
      view.stateRaw = m.value;
      objects.push_back(std::move(view));
    }
    playerViews_ = std::move(players);
    objectViews_ = std::move(objects);
  }

  // ---- sending ----

  bool SocketOpen() const { return current_ && colyseus_room_is_connected(current_->room); }

  RelayStatus SendValue(const char* kind, const Json& value) {
    std::vector<std::uint8_t> bytes;
    std::string error;
    if (!EncodeMsgpack(value, bytes, &error)) return RelayStatus::Fail(RelayError::Codec, error);
    if (!SocketOpen() || roomKind_ == RoomKind::Queue) {
      return RelayStatus::Fail(RelayError::NotConnected, "not connected: message dropped");
    }
    colyseus_room_send_encoded(current_->room, kind, bytes.data(), bytes.size());
    return RelayStatus();
  }

  Json DataPart(const Json& state) const {
    if (!opts_.pose || !state.IsObject()) return state;
    Json out = Json::MakeObject();
    for (const JsonMember& member : state.Members()) {
      if (!IsPoseKey(member.key)) out.Set(member.key, member.value);
    }
    return out;
  }

  static std::optional<PoseFields> PosePart(const Json& state) {
    if (!state.IsObject()) return std::nullopt;
    const auto n = [&state](const char* key) -> std::optional<double> {
      const Json* v = state.Find(key);
      if (v == nullptr || !v->IsNumber() || !ValidPoseNumber(v->AsNumber())) return std::nullopt;
      return v->AsNumber();
    };
    PoseFields fields;
    fields.x = n("x");
    fields.y = n("y");
    fields.z = n("z");
    fields.yaw = n("yaw");
    fields.vx = n("vx");
    fields.vy = n("vy");
    fields.vz = n("vz");
    const Json* anim = state.Find("anim");
    if (anim != nullptr && anim->IsString()) fields.anim = anim->AsString();
    if (fields.IsEmpty()) return std::nullopt;
    return fields;
  }

  RelayStatus SendPose(const char* kind, const PoseFields& pose, double t) {
    if (!pose.IsValid()) {
      return RelayStatus::Fail(RelayError::InvalidPayload, "pose values must be finite, |v| <= 1e9, anim <= 64 chars");
    }
    Json v = pose.ToJson();
    v.Set("t", t);
    return SendValue(kind, v);
  }

  RelayStatus SendCounted(const char* kind, const Json& data) {
    RelayStatus r = SendValue(kind, data);
    if (r.error == RelayError::NotConnected && joinedOnce_) ++droppedOffline_;
    return r;
  }

  // ---- objects ----

  RelayStatus Control(const char* message, const char* operation, const std::string& id, bool hostAuthority,
                      std::string* requestIdOut) {
    const std::size_t units = protocol::Utf16Length(id);
    if (units == 0 || units > protocol::limits::kMaxObjectIdChars) {
      return RelayStatus::Fail(RelayError::InvalidPayload, "object id must be 1..=128 chars");
    }
    ++requestCounter_;
    const std::string requestId = requestPrefix_ + "-" + std::to_string(requestCounter_);
    Json payload = Json::MakeObject();
    payload.Set("id", id);
    payload.Set("requestId", requestId);
    if (hostAuthority) payload.Set("authority", protocol::object_control::kAuthorityHost);
    PendingControl p;
    p.payload = payload;
    p.message = message;
    p.operation = operation;
    p.id = id;
    p.deadline = Now() + opts_.controlTimeoutMs;
    pending_[requestId] = std::move(p);
    if (phase_.kind == PhaseKind::Joined) SendValue(message, payload);
    if (requestIdOut != nullptr) *requestIdOut = requestId;
    return RelayStatus();
  }

  void ResendPending() {
    std::vector<std::pair<const char*, Json>> msgs;
    for (const auto& entry : pending_) msgs.emplace_back(entry.second.message, entry.second.payload);
    for (const auto& msg : msgs) SendValue(msg.first, msg.second);
  }

  bool Owns(const std::string& id) const {
    if (sessionId_.empty()) return false;
    const auto it = objects_.find(id);
    return it != objects_.end() && it->second.owner == sessionId_;
  }

  RelayStatus CheckObjectWrite(const std::string& id, const Json& state) const {
    if (!Owns(id)) return RelayStatus::Fail(RelayError::NotOwner, "this session does not own object `" + id + "`");
    if (!state.IsObject()) return RelayStatus::Fail(RelayError::InvalidPayload, "object state must be a JSON object");
    if (state.Dump().size() > protocol::limits::kMaxObjectStateBytes) {
      return RelayStatus::Fail(RelayError::InvalidPayload, "object state over 64 KiB");
    }
    return RelayStatus();
  }

  bool IsHost() const {
    return phase_.kind == PhaseKind::Joined && !sessionId_.empty() && host_ == sessionId_ && SocketOpen();
  }

  colyseus_room_clock_t* RoomClock() const {
    if (!current_ || heartbeat_.handle == nullptr) return nullptr;
    return colyseus_room_get_clock(current_->room);
  }

  void Destroy() {
    // Not inside any callback: callbacks never call user code.
    if (current_ && phase_.kind != PhaseKind::Closed) {
      // A consented leave frees the seat at once instead of holding it for the grace.
      colyseus_room_leave(current_->room, true);
    }
    if (current_) {
      colyseus_room_free(current_->room);
      current_.reset();
    }
    for (RoomSlot& slot : retired_) colyseus_room_free(slot.room);
    retired_.clear();
    if (pendingCtx_.empty()) {
      if (client_ != nullptr) colyseus_client_free(client_);
      if (settings_ != nullptr) colyseus_settings_free(settings_);
      delete sink_;
    } else {
      // A matchmaking request is still in flight and will call back into the sink and its ctx:
      // leak them (and the client it runs on) rather than free under it. The callback sees
      // `orphaned` and leaves any room it gets.
      sink_->orphaned = true;
      for (auto& entry : pendingCtx_) {
        Ctx* leaked = entry.second.release();
        (void)leaked;
      }
      pendingCtx_.clear();
    }
    client_ = nullptr;
    settings_ = nullptr;
    sink_ = nullptr;
  }
};

}  // namespace genex::relay_session_detail

namespace genex {

struct RelaySession::Impl : relay_sd::SessionCore {};

// ---- RelaySession ----

RelaySession::RelaySession(RelayConnectOptions options, JoinTokenProvider identity) : impl_(new Impl()) {
  // Register first: it latches polled mode, which must precede the first colyseus client.
  Pump::Register(this);
  impl_->opts_ = std::move(options);
  impl_->identity_ = std::move(identity);
  impl_->clock_.skewMs = std::isfinite(impl_->opts_.testSkewMs) ? impl_->opts_.testSkewMs : 0.0;
  impl_->sink_ = new relay_sd::Sink();
  impl_->sink_->clock = impl_->clock_;
  impl_->Start();
}

RelaySession::~RelaySession() {
  Pump::Unregister(this);
  impl_->Destroy();
}

void RelaySession::Update(double nowMs) {
  (void)nowMs;  // the session reads its own (possibly skewed) clock
  impl_->Update();
}

std::vector<RelayEvent> RelaySession::DrainEvents() {
  std::vector<RelayEvent> out = std::move(impl_->events_);
  impl_->events_.clear();
  return out;
}

void RelaySession::Leave() { impl_->Leave(); }

bool RelaySession::IsClosed() const { return impl_->phase_.kind == relay_sd::PhaseKind::Closed; }

bool RelaySession::IsConnected() const { return impl_->phase_.kind == relay_sd::PhaseKind::Joined && impl_->SocketOpen(); }

RelayStatus RelaySession::SetMe(Json state) {
  Impl& s = *impl_;
  if (!state.IsObject()) return RelayStatus::Fail(RelayError::State, StampErrorName(StampError::NotAnObject));
  if (state.Contains(protocol::kSendTimeKey)) {
    s.events_.push_back(relay_sd::EvWarning("`__t` is reserved for the send clock; it is overwritten"));
  }
  StampError error = StampError::None;
  if (!StampState(s.DataPart(state), 1.0, nullptr, &error)) {
    return RelayStatus::Fail(RelayError::State, StampErrorName(error));
  }
  if (s.opts_.pose) {
    std::optional<PoseFields> p = relay_sd::SessionCore::PosePart(state);
    if (p) s.posePending_ = std::move(*p);
  }
  s.me_ = std::move(state);
  s.RequestPublishMe();
  return RelayStatus();
}

RelayStatus RelaySession::SnapMe(Json state) {
  Impl& s = *impl_;
  const double now = s.Now();
  const Json data = s.DataPart(state);
  StampedState stamped;
  StampError error = StampError::None;
  if (!StampState(data, now, &stamped, &error)) return RelayStatus::Fail(RelayError::State, StampErrorName(error));
  if (s.opts_.pose) {
    std::optional<PoseFields> p = relay_sd::SessionCore::PosePart(state);
    if (p) {
      VelocityMemory memory;
      const PoseFields derived = DeriveVelocity(*p, now, nullptr, &memory);
      s.poseMemory_ = memory;
      s.posePending_.reset();
      RelayStatus r = s.SendPose(protocol::client_message::kPoseSnap, derived, now);
      if (!r.Ok()) return r;
    }
  }
  RelayStatus r = s.SendValue(protocol::client_message::kStateSnap, Json(stamped.text));
  if (!r.Ok()) return r;
  s.lastDataText_ = data.Dump();
  s.lastDataSent_ = now;
  s.me_ = std::move(state);
  s.mePending_.reset();
  s.lastPublish_ = now;
  return RelayStatus();
}

RelayStatus RelaySession::SetPose(PoseFields pose) {
  Impl& s = *impl_;
  if (!s.opts_.pose) return RelayStatus::Fail(RelayError::InvalidPayload, "typed pose is off: set RelayConnectOptions::pose");
  if (!pose.IsValid()) {
    return RelayStatus::Fail(RelayError::InvalidPayload, "pose values must be finite, |v| <= 1e9, anim <= 64 chars");
  }
  s.posePending_ = std::move(pose);
  s.RequestPublishMe();
  return RelayStatus();
}

RelayStatus RelaySession::SetShared(const std::string& key, const Json& value) {
  const std::size_t units = protocol::Utf16Length(key);
  if (units == 0 || units > protocol::limits::kMaxSharedKeyChars ||
      key.rfind(protocol::kReservedSharedPrefix, 0) == 0) {
    return RelayStatus::Fail(RelayError::InvalidPayload, "shared key `" + key + "`: 1..=256 chars, no `__` prefix");
  }
  const std::string text = value.Dump();
  if (text.size() > protocol::limits::kMaxSharedValueBytes) {
    return RelayStatus::Fail(RelayError::InvalidPayload, "shared value over 64 KiB");
  }
  Json payload = Json::MakeObject();
  payload.Set("key", key);
  payload.Set("value", text);
  return impl_->SendValue(protocol::client_message::kShared, payload);
}

std::map<std::string, Json> RelaySession::Shared() const {
  std::map<std::string, Json> out;
  for (const auto& entry : impl_->shared_) {
    std::optional<Json> v = ParseJsonText(entry.second);
    out[entry.first] = v ? std::move(*v) : Json();
  }
  return out;
}

std::optional<Json> RelaySession::SharedGet(const std::string& key) const {
  const auto it = impl_->shared_.find(key);
  if (it == impl_->shared_.end()) return std::nullopt;
  return ParseJsonText(it->second);
}

RelayStatus RelaySession::Send(const std::string& type, const Json& data) {
  if (!protocol::IsSendableEventType(type)) {
    return RelayStatus::Fail(RelayError::ReservedType, "`" + type + "` is a reserved message type");
  }
  if (data.Dump().size() > protocol::limits::kMaxEventBytes) {
    return RelayStatus::Fail(RelayError::InvalidPayload, "event payload over 16 KiB");
  }
  return impl_->SendCounted(type.c_str(), data);
}

void RelaySession::Listen(const std::string& type) { (void)type; }

RelayStatus RelaySession::SendInput(const Json& data) {
  if (data.Dump().size() > protocol::limits::kMaxEventBytes) {
    return RelayStatus::Fail(RelayError::InvalidPayload, "input payload over 16 KiB");
  }
  return impl_->SendCounted(protocol::client_message::kInput, data);
}

RelayStatus RelaySession::SetRoomOpen(bool open) {
  if (!impl_->IsHost()) return RelayStatus::Fail(RelayError::InvalidPayload, "only the host may open or close the room");
  Json payload = Json::MakeObject();
  payload.Set("open", open);
  return impl_->SendValue(protocol::client_message::kRoomOpen, payload);
}

RelayStatus RelaySession::ChatSend(const std::string& text) {
  Json payload = Json::MakeObject();
  payload.Set("text", text);
  return impl_->SendValue(protocol::client_message::kChat, payload);
}

std::vector<RelayChatMessage> RelaySession::ChatMessages() const {
  std::vector<RelayChatMessage> out;
  out.reserve(impl_->chat_.size());
  for (const auto& entry : impl_->chat_) out.push_back(entry.second);
  return out;
}

RelayStatus RelaySession::Claim(const std::string& id, std::string* requestId) {
  return impl_->Control(protocol::client_message::kClaim, protocol::object_control::kOpClaim, id, false, requestId);
}

RelayStatus RelaySession::ClaimAsHost(const std::string& id, std::string* requestId) {
  return impl_->Control(protocol::client_message::kClaim, protocol::object_control::kOpClaim, id, true, requestId);
}

RelayStatus RelaySession::Release(const std::string& id, std::string* requestId) {
  return impl_->Control(protocol::client_message::kRelease, protocol::object_control::kOpRelease, id, false, requestId);
}

RelayStatus RelaySession::Destroy(const std::string& id, std::string* requestId) {
  return impl_->Control(protocol::client_message::kDestroy, protocol::object_control::kOpRemove, id, false, requestId);
}

bool RelaySession::Owns(const std::string& id) const { return impl_->Owns(id); }

RelayStatus RelaySession::SetObject(const std::string& id, Json state) {
  Impl& s = *impl_;
  RelayStatus writable = s.CheckObjectWrite(id, state);
  if (!writable.Ok()) return writable;
  const double now = s.Now();
  relay_sd::ObjectMirror& m = s.objects_[id];
  m.local = std::move(state);
  if (now - m.lastSent >= s.PublishInterval()) {
    s.PublishObject(id, now);
  } else {
    m.pending = now;
  }
  return RelayStatus();
}

RelayStatus RelaySession::SnapObject(const std::string& id, Json state) {
  Impl& s = *impl_;
  RelayStatus writable = s.CheckObjectWrite(id, state);
  if (!writable.Ok()) return writable;
  const double now = s.Now();
  Json payload = Json::MakeObject();
  payload.Set("id", id);
  payload.Set("d", state);
  payload.Set("t", now);
  RelayStatus r = s.SendValue(protocol::client_message::kObjectSnap, payload);
  if (!r.Ok()) return r;
  auto it = s.objects_.find(id);
  if (it != s.objects_.end()) {
    it->second.local = std::move(state);
    it->second.pending.reset();
    it->second.lastSent = now;
  }
  return RelayStatus();
}

const std::vector<RelayPlayerView>& RelaySession::Players() const { return impl_->playerViews_; }

const RelayPlayerView* RelaySession::Player(const std::string& id) const {
  for (const RelayPlayerView& p : impl_->playerViews_) {
    if (p.id == id) return &p;
  }
  return nullptr;
}

const std::vector<RelayObjectView>& RelaySession::Objects() const { return impl_->objectViews_; }

const RelayObjectView* RelaySession::Object(const std::string& id) const {
  for (const RelayObjectView& o : impl_->objectViews_) {
    if (o.id == id) return &o;
  }
  return nullptr;
}

const std::string& RelaySession::SessionId() const { return impl_->sessionId_; }

const std::string& RelaySession::RoomId() const { return impl_->roomId_; }

std::optional<std::string> RelaySession::Endpoint() const { return impl_->endpoint_; }

std::optional<std::string> RelaySession::HostId() const { return relay_sd::NonEmpty(impl_->host_); }

bool RelaySession::IsHost() const { return impl_->IsHost(); }

std::optional<Json> RelaySession::MatchState() const { return ParseJsonText(impl_->matchText_); }

RelayStatus RelaySession::ReportEliminated() {
  return impl_->SendValue(protocol::client_message::kMatchEliminated, Json::MakeObject());
}

RelayStatus RelaySession::ReportFinish() {
  return impl_->SendValue(protocol::client_message::kMatchFinish, Json::MakeObject());
}

RelayStatus RelaySession::ReportScore(double delta) {
  Json payload = Json::MakeObject();
  payload.Set("delta", delta);
  return impl_->SendValue(protocol::client_message::kMatchScore, payload);
}

bool RelaySession::HasServerClock() const { return impl_->heartbeat_.handle != nullptr; }

std::optional<double> RelaySession::ServerNow() const {
  colyseus_room_clock_t* c = impl_->RoomClock();
  if (c == nullptr) return std::nullopt;
  return colyseus_room_clock_server_now(c);
}

std::optional<double> RelaySession::Rtt() const {
  colyseus_room_clock_t* c = impl_->RoomClock();
  if (c == nullptr) return std::nullopt;
  const double r = colyseus_room_clock_smoothed_rtt(c);
  if (!(r > 0.0)) return std::nullopt;
  return r;
}

bool RelaySession::ClockSynced() const { return impl_->heartbeat_.synced; }

double RelaySession::ClockOrigin() const { return impl_->clockOrigin_; }

double RelaySession::MsUntil(double epochMs) const {
  if (impl_->heartbeat_.synced && impl_->clockOrigin_ > 0.0) {
    const std::optional<double> serverNow = ServerNow();
    if (serverNow) return epochMs - impl_->clockOrigin_ - *serverNow;
  }
  return epochMs - Clock::EpochMs();
}

double RelaySession::NowMs() const { return impl_->Now(); }

double RelaySession::RealMs() const { return StampRealMs(impl_->clock_); }

double RelaySession::TestSkewMs() const { return impl_->clock_.skewMs; }

}  // namespace genex
