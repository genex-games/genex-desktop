// The relay session: Genex protocol 3 (packages/multiplayer/PROTOCOL.md) over the official
// Colyseus 0.18 C core, in polled mode. Port of sdks/rust/genex-multiplayer/src/native/mod.rs
// (+ state.rs, nodelay.rs, types.rs); when the two disagree, the Rust files are the reference and
// this one is the bug.
//
// Single-threaded and pumped (sdks/unreal/core/DESIGN.md): a RelaySession registers itself with
// genex::Pump when constructed, and genex::Pump::Frame polls the C core once and then calls its
// Update, which processes everything the core's callbacks queued, runs the timers (publish tick,
// §16 heartbeat, control timeouts, the reconnect watchdog) and refreshes the smoothed views. Drain
// what happened with DrainEvents() after the frame. C callbacks only copy data into a queue, so no
// room is ever freed inside its own callback.
//
// What it adds over the core (docs/knowledge/engine-sdks.md): join options (gameId, a FRESH embed
// token per join, name, extra options, `protocol` last), latency selection over several endpoints,
// typed players/shared/objects views (dynamic schema), `__t` stamping, confirmed control with
// request ids, host gating, game events, chat with history dedupe, the §8 reconnect settings and
// post-reconnect sequence, the §16 heartbeat, §10 interpolation, TCP_NODELAY on the core's sockets
// (GenexNoDelay.h), the stalled-handshake takeover (native-core v0.18.10 bug 2), matchmaking
// (queue -> seat -> match, private lobbies: ported, UNTESTED, as in Rust: the bench relay defines
// only `play`) and a session-scoped test clock skew (the conformance driver's `skew`).
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexJson.h"
#include "GenexCore/GenexPose.h"
#include "GenexCore/GenexPump.h"

#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace genex {

/** Which room to enter (§3.5). */
enum class RelayTarget {
  /** joinOrCreate('play'): the plain relay room. The default. */
  Play,
  /** Search through the matchmaking queue, then take the reserved match seat (§9.2). UNTESTED. */
  Queue,
  /** create('match'): a private lobby; its room id is the invite code. UNTESTED. */
  CreatePrivate,
  /** joinById(RelayConnectOptions::joinCode): a friend's private lobby. UNTESTED. */
  JoinById,
};

/** What a token provider returns: a fresh `embed:play` token, or why there is none. */
struct JoinToken {
  bool ok = false;
  std::string token;
  std::string error;

  static JoinToken Ok(std::string value) {
    JoinToken t;
    t.ok = true;
    t.token = std::move(value);
    return t;
  }
  static JoinToken Fail(std::string why) {
    JoinToken t;
    t.error = std::move(why);
    return t;
  }
};

/** Called right before EVERY join, create, joinById, queue join and seat (§3.2). Never cache a
 *  token across calls, never log it. */
using JoinTokenProvider = std::function<JoinToken()>;

struct RelayConnectOptions {
  /** Relay URLs (ws:// or wss://, host[:port], no path). One is used as is; with several the
   *  lowest-latency one is chosen and kept for the whole session (§3.1). */
  std::vector<std::string> endpoints;
  /** The game's slug. Must equal the token's `slug` claim. */
  std::string gameId;
  /** Display-name fallback (the token's verified name wins). */
  std::optional<std::string> name;
  RelayTarget room = RelayTarget::Play;
  /** The invite code for RelayTarget::JoinById. */
  std::string joinCode;
  /** Rate ceiling for SetMe / SetObject (per object), clamped to [1, 30]: faster calls coalesce. */
  double publishHz = 30.0;
  /** Client timeout for control requests (§7.2), clamped to [100, 60000] ms. */
  double controlTimeoutMs = 5000.0;
  /** Publish the typed pose (§6.6) from SetMe/SetPose. Experimental, off by default. */
  bool pose = false;
  /** Extra join options (an object). The relay refuses the server-owned names (§3.4); `protocol`
   *  is always this SDK's and cannot be overridden. */
  Json options = Json::MakeObject();
  /** TEST SEAM (the conformance driver's `skew`): this session's clock reads real time plus this,
   *  for its whole life, through reconnects. Never set it in a game. */
  double testSkewMs = 0.0;
};

/** One seated player, as this client sees it. */
struct RelayPlayerView {
  /** Session id (changes on every reload; key persistent things by `uid`). */
  std::string id;
  std::string name;
  /** Stable per-game player id (§3.3). Opaque. */
  std::string uid;
  /** Team index, or -1. */
  int team = -1;
  /** false while the seat is held by reconnection grace. */
  bool connected = true;
  std::string avatarUrl;
  /** Game state with `__t` removed: interpolated for remote players, your last local publish for
   *  yourself. A posed player has its pose keys merged over its data. */
  Json state;
  /** The latest raw state (for game logic: hit tests, pickups), never smoothed. */
  Json stateRaw;
  double epoch = 0.0;
  bool isMe = false;
  /** The player publishes the typed pose (§6.6). */
  bool posed = false;
};

/** One shared object (§7). */
struct RelayObjectView {
  std::string id;
  /** Owner session id; empty optional when unowned. */
  std::optional<std::string> owner;
  /** +1 on every owner change. */
  double seq = 0.0;
  /** +1 on every SnapObject (hard reset). */
  double epoch = 0.0;
  /** Interpolated for remote-owned objects, your last publish for objects you own, null before
   *  the first publish. */
  Json state;
  Json stateRaw;
};

/** The answer to a claim / release / destroy (§7.2). `reason` is the relay's string, or
 *  `timeout` / `disconnected` for requests the client settled itself. */
struct GENEX_CORE_API RelayControlResult {
  std::string requestId;
  /** `claim`, `release` or `remove` (a destroy). */
  std::string operation;
  std::string id;
  bool accepted = false;
  std::optional<std::string> owner;
  double sequence = 0.0;
  std::string reason;
  std::optional<double> retryAfterMs;

  /** DRIVER.md's control result: `owner: null` for no owner, retryAfterMs only when present. */
  Json ToJson() const;
  /** `__object:result` as the relay sends it; false when a required field is missing. */
  static bool FromJson(const Json& data, RelayControlResult* out);
};

/** A chat line as the relay stamped it (§12). `at` is relay epoch ms. */
struct GENEX_CORE_API RelayChatMessage {
  double id = 0.0;
  std::string from;
  std::string name;
  std::string text;
  double at = 0.0;

  Json ToJson() const;
  static bool FromJson(const Json& data, RelayChatMessage* out);
};

enum class RelayEventType {
  /** Seated in a play or match room. `id` = own session id. */
  Joined,
  /** The join was refused (§3.4): `code` (426 = never retry), `message`. */
  JoinFailed,
  /** `id` = session id. */
  PlayerJoined,
  PlayerLeft,
  /** `owner` = the new host's session id, empty optional for none. */
  HostChanged,
  /** `id` = the shared key. */
  SharedChanged,
  /** An object appeared or changed owner: `id`, `owner`. */
  ObjectChanged,
  ObjectRemoved,
  /** `control`. */
  ControlResult,
  /** A game event from another client (§5.4): `id` = its type, `data`. */
  Message,
  /** An input forwarded to you as host (§6.4): `id` = the sender's session id, `data`. */
  Input,
  /** `flag` = open. */
  RoomOpen,
  /** `chat`. */
  Chat,
  /** The relay dropped `value` of your messages for rate (§5.1): publish less. */
  RateDrop,
  /** The relay is about to restart (§14). */
  ServerRestart,
  /** `value` = roundId. */
  MatchStart,
  /** `data`. */
  MatchEnded,
  /** `owner` = the reason, when given. */
  MatchRequeue,
  /** Matchmaking queue position: `value` = position, `value2` = size. */
  Queue,
  /** A seat reservation arrived; the session is moving into its match room. */
  Seated,
  /** The socket dropped; the SDK is reconnecting (§8). `code` = the close code of the drop. */
  Reconnecting,
  /** The post-reconnect sequence finished. */
  Reconnected,
  /** Terminal (§11): `code`, `message` = reason. Playing again needs a new session. */
  Disconnected,
  /** `message`. */
  Warning,
};

GENEX_CORE_API const char* RelayEventTypeName(RelayEventType type);

/** One event; which fields are set depends on `type` (see RelayEventType). */
struct RelayEvent {
  RelayEventType type = RelayEventType::Warning;
  std::string id;
  std::optional<std::string> owner;
  int code = 0;
  std::string message;
  Json data;
  double value = 0.0;
  double value2 = 0.0;
  bool flag = false;
  RelayControlResult control;
  RelayChatMessage chat;
};

enum class RelayError {
  None,
  /** The socket is not open; the message was dropped, not queued (§8). */
  NotConnected,
  /** A reserved or invalid game event type (§5.4). */
  ReservedType,
  /** A write to an object this session does not own. */
  NotOwner,
  /** A payload the relay would drop (size, shape, key rules). */
  InvalidPayload,
  /** Player state the stamp refused (not an object, too large). */
  State,
  /** A payload msgpack cannot carry (too deep, too many nodes, non-finite, bad UTF-8). */
  Codec,
};

/** The result of a session call: Ok(), or an error and a message. */
struct RelayStatus {
  RelayError error = RelayError::None;
  std::string message;

  bool Ok() const { return error == RelayError::None; }
  static RelayStatus Fail(RelayError why, std::string text) {
    RelayStatus s;
    s.error = why;
    s.message = std::move(text);
    return s;
  }
};

/** A parsed relay URL. */
struct RelayEndpoint {
  std::string host;
  std::string port;
  bool secure = false;
};

/** `ws://host[:port]` / `wss://host[:port]` (http/https accepted, one trailing `/`), IPv6 in
 *  brackets. nullopt for anything else (a path, a query, a bad port). */
GENEX_CORE_API std::optional<RelayEndpoint> ParseRelayEndpoint(std::string_view url);

/** The core's wait before reconnect attempt n: clamp(2^n x delay, min, max) (room.c). */
GENEX_CORE_API double RelayCoreBackoffMs(int n);

/** A Genex relay session (native). Construct it to start connecting; it is pumped by
 *  genex::Pump::Frame from then on. Host logic should run from a fixed wall-clock tick while
 *  IsHost() is true. Destroying a seated session leaves the room with consent. */
class GENEX_CORE_API RelaySession final : public IPumped {
 public:
  /** Start connecting. Returns at once; Joined (or JoinFailed) arrives from a later frame.
   *  `identity` is called right before every join. */
  RelaySession(RelayConnectOptions options, JoinTokenProvider identity);
  ~RelaySession() override;
  RelaySession(const RelaySession&) = delete;
  RelaySession& operator=(const RelaySession&) = delete;

  /** Pump only (genex::Pump::Frame). */
  void Update(double nowMs) override;

  /** The events since the last call, in order. */
  std::vector<RelayEvent> DrainEvents();

  // ---- lifecycle ----
  /** Leave the room with consent. Disconnected (code 4000) follows. */
  void Leave();
  /** The session is over (terminal close, refused join, or left). */
  bool IsClosed() const;
  /** Joined and not reconnecting. */
  bool IsConnected() const;

  // ---- own state ----
  /** Set your own player state (an object), stamped with `__t` and sent now; calls faster than
   *  publishHz coalesce (the latest wins, stamped when you set it). With options.pose the pose
   *  keys (x y z yaw vx vy vz anim) go out as the typed pose and everything else as data. */
  RelayStatus SetMe(Json state);
  /** A deliberate discontinuity (teleport, respawn): `__state:snap` (and `__pose:snap`) now. */
  RelayStatus SnapMe(Json state);
  /** The typed pose directly (needs options.pose), rate-limited like SetMe. */
  RelayStatus SetPose(PoseFields pose);

  // ---- shared (§6.2) ----
  /** Write a room-wide fact. `value` is any JSON (write null to "delete"). */
  RelayStatus SetShared(const std::string& key, const Json& value);
  /** The shared map, parsed (game keys only). */
  std::map<std::string, Json> Shared() const;
  std::optional<Json> SharedGet(const std::string& key) const;

  // ---- events, input, chat ----
  /** A game event to every other client (§5.4). Not queued while disconnected. */
  RelayStatus Send(const std::string& type, const Json& data);
  /** Every game event type arrives as a Message event on native; this exists for parity with
   *  the web session. */
  void Listen(const std::string& type);
  /** An input to the current host (§6.4). Dropped when there is no host. */
  RelayStatus SendInput(const Json& data);
  /** Host only: close the room to (or reopen it for) new matchmaking placements (§6.5). */
  RelayStatus SetRoomOpen(bool open);
  /** Send a chat line (§12). It is shown when the relay echoes it back as a Chat event. */
  RelayStatus ChatSend(const std::string& text);
  /** Chat lines received so far, ascending by id, de-duplicated (the newest 200). */
  std::vector<RelayChatMessage> ChatMessages() const;

  // ---- objects (§7) ----
  /** Ask for ownership of object `id` (created on first claim). `requestId` receives the id the
   *  answer (a ControlResult event) will carry. */
  RelayStatus Claim(const std::string& id, std::string* requestId = nullptr);
  /** Host-authority claim: displaces an owner inside its minimum hold (host only). */
  RelayStatus ClaimAsHost(const std::string& id, std::string* requestId = nullptr);
  RelayStatus Release(const std::string& id, std::string* requestId = nullptr);
  RelayStatus Destroy(const std::string& id, std::string* requestId = nullptr);
  /** Whether this session owns object `id` (as far as it knows). */
  bool Owns(const std::string& id) const;
  /** Publish an owned object's state (an object), stamped and sent now; rate-limited per object.
   *  Idle objects: a keepalive of 2 Hz or less, never every frame (§5.1). */
  RelayStatus SetObject(const std::string& id, Json state);
  /** Publish an owned object's state now as `__object:snap` (a hard reset). */
  RelayStatus SnapObject(const std::string& id, Json state);

  // ---- views (refreshed by every Update) ----
  const std::vector<RelayPlayerView>& Players() const;
  const RelayPlayerView* Player(const std::string& id) const;
  const std::vector<RelayObjectView>& Objects() const;
  const RelayObjectView* Object(const std::string& id) const;

  /** Your session id (empty until joined). */
  const std::string& SessionId() const;
  /** The room id (a private lobby's invite code). */
  const std::string& RoomId() const;
  /** The relay URL this session uses (fixed for its life, §3.1). */
  std::optional<std::string> Endpoint() const;
  /** The elected host's session id. */
  std::optional<std::string> HostId() const;
  /** Run host simulation now (§6.3): the relay says you are host AND the socket is up AND the
   *  post-reconnect sequence has completed. */
  bool IsHost() const;

  // ---- match rooms (§9.3) ----
  std::optional<Json> MatchState() const;
  RelayStatus ReportEliminated();
  RelayStatus ReportFinish();
  RelayStatus ReportScore(double delta);

  // ---- clock (§16) ----
  /** The relay publishes its clock (the handshake advertised the heartbeat input). */
  bool HasServerClock() const;
  /** Estimated relay room clock (ms since room creation). */
  std::optional<double> ServerNow() const;
  /** Smoothed round-trip time (ms), when the relay publishes its clock. An upper bound (§16.2). */
  std::optional<double> Rtt() const;
  /** serverNow is synced: 30 heartbeats acked (sticky). */
  bool ClockSynced() const;
  /** `RoomState.clockOrigin`: relay epoch ms at room-clock zero (0 = no clock). */
  double ClockOrigin() const;
  /** Milliseconds until a relay epoch-ms deadline (§16.3): on the server clock once synced,
   *  otherwise against the local wall clock. */
  double MsUntil(double epochMs) const;
  /** Voice is browser-only (WebRTC); native sessions do not offer it. */
  bool VoiceSupported() const { return false; }

  /** The clock this session stamps `__t` and object `t` with (GenexStamp.h StampNowMs). */
  double NowMs() const;
  /** NowMs without the test skew. */
  double RealMs() const;
  double TestSkewMs() const;

  struct Impl;

 private:
  std::unique_ptr<Impl> impl_;
};

}  // namespace genex
