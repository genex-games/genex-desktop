// Genex relay protocol 3 (and authority protocol 4) constants: a port of
// packages/multiplayer/src/protocol.ts and sdks/rust/genex-multiplayer/src/protocol.rs.
// packages/multiplayer/PROTOCOL.md is normative; § numbers refer to it. When this file and
// protocol.ts disagree, protocol.ts is what the relay runs: fix this file.
//
// Header-only. Names are kCamelCase (never UPPER_SNAKE: UE and Windows headers own many such
// macros), message names are NUL-terminated `const char*` so they convert to FString directly.
#pragma once

#include "GenexCore/GenexConfig.h"

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace genex::protocol {

// ---- §2 versioning ----

/** The protocol relay rooms (`play`, `queue`, `match`) speak: the `protocol` join option. */
inline constexpr int kProtocolVersion = 3;
/** The oldest protocol the relay still seats (protocol 3 is a hard cut). */
inline constexpr int kMinProtocolVersion = 3;
/** The protocol an authority room (§17) speaks. */
inline constexpr int kAuthorityProtocolVersion = 4;
inline constexpr int kAuthorityMinProtocolVersion = 4;

/** The inclusive range of `protocol` values one room type accepts. (`lowest`/`highest`, never
 *  `min`/`max`: Windows headers define those as macros.) */
struct ProtocolWindow {
  int lowest;
  int highest;
};
inline constexpr ProtocolWindow kRelayWindow{kMinProtocolVersion, kProtocolVersion};
inline constexpr ProtocolWindow kAuthorityWindow{kAuthorityMinProtocolVersion, kAuthorityProtocolVersion};

/** Whether a `protocol` value lies inside `window` (an integer number, nothing else). */
inline bool InProtocolWindow(double sent, ProtocolWindow window) {
  return sent == std::floor(sent) && sent >= window.lowest && sent <= window.highest;
}

// ---- §3 connection ----

/** Colyseus room types. Every game shares them; games are isolated by the `gameId` filter. */
namespace room_type {
inline constexpr const char* kPlay = "play";
inline constexpr const char* kQueue = "queue";
inline constexpr const char* kMatch = "match";
/** Server-authoritative room (§17), served by the authority cluster, never by a relay. */
inline constexpr const char* kAuthority = "authority";
}  // namespace room_type

/** Join option keys (every room type). */
namespace join_option {
/** The game's slug. Must equal the embed token's `slug` claim. */
inline constexpr const char* kGameId = "gameId";
/** A fresh `embed:play` JWT. Required: there is no anonymous join. */
inline constexpr const char* kEmbedToken = "embedToken";
/** Display-name fallback when the token carries none. */
inline constexpr const char* kName = "name";
/** kProtocolVersion (or kAuthorityProtocolVersion). Required. */
inline constexpr const char* kProtocol = "protocol";
/** Authority rooms only (§17.10 *Joining*): the capabilities this client implements, at most
 *  caps::kMaxCaps strings of at most caps::kMaxCapChars characters; absent = []. */
inline constexpr const char* kCaps = "caps";
/** Authority rooms only (§17.2 *Choosing a room*): the pool this join asks for; absent = the game's one pool. */
inline constexpr const char* kMatchKey = "matchKey";
/** Authority rooms only: `true` on a `create` makes a private room, reached only by its code. */
inline constexpr const char* kPrivate = "private";
}  // namespace join_option

/** Authority join capabilities (§17.10 *Joining*; protocol.ts AuthorityCaps). */
namespace caps {
/** Decodes and draws §17.10's physics bodies (GenexBodies.h). A physics room refuses a join without it
 *  with 426 (`physics@1 required`). */
inline constexpr const char* kPhysics = "physics@1";
/** Predicts a predicting room's bodies (§17.11, GenexPhysicsPredictor.h): sent beside physics@1 when the
 *  game gave a physics core and did not turn prediction off. */
inline constexpr const char* kPhysicsPredict = "physics@2";
/** Reconciles a predicting room's repeated inputs (§17.11 *Input pacing*, GenexInputRepeat.h): the room
 *  repeats a starved seat's held input and writes `inRep`, `inStarve` and `inBuf` for it. */
inline constexpr const char* kInputRepeat = "repeat@1";
/** Speaks the fast channel (§17.12, GenexFastSeat.h): sent when the game gave a datagram socket opener
 *  (AuthorityOptions::fast). */
inline constexpr const char* kFast = "fast@1";
/** The seat can come back to the fast channel after a fallback (§17.12 *Return to the channel*). */
inline constexpr const char* kFastReturn = "fast-return@1";
inline constexpr int kMaxCaps = 16;
inline constexpr int kMaxCapChars = 32;
}  // namespace caps

/** Join options only the relay may set; a client sending any of them is refused (400). */
inline constexpr const char* kServerOwnedJoinOptions[] = {"clients", "preset", "winCondition", "config",
                                                          "matchmade"};
/** The authority room's server-owned options (§17.2): the relay's plus the admission's. */
inline constexpr const char* kAuthorityServerOwnedJoinOptions[] = {
    "clients", "preset",  "winCondition", "config", "matchmade", "moduleSha",
    "tickHz",  "maxPlayers", "lagComp",   "seed",   "units",     "leaseId", "region"};

/** Join refusal codes (§3.4): the matchmaking error's `code`. */
namespace join_error {
/** A server-owned option was sent. */
inline constexpr int kBadOption = 400;
/** No token, an invalid/expired token, or a revoked session. */
inline constexpr int kAuthRequired = 401;
/** Token for another game, or the room's guest cap is full. */
inline constexpr int kForbidden = 403;
/** A join by code entered through another region than the room's: try the next region. */
inline constexpr int kWrongRegion = 421;
/** `protocol` missing or outside the window. Never retry; the game needs an update. */
inline constexpr int kProtocolUnsupported = 426;
// authority rooms only (§17.2); a relay room never answers these
/** The owner is not entitled to server-authoritative rooms. Terminal. */
inline constexpr int kNotEntitled = 402;
/** The owner's room quota, concurrency cap or credits refused a NEW room. */
inline constexpr int kRoomQuota = 429;
/** No published room module on this channel, or it could not be loaded. */
inline constexpr int kModuleUnavailable = 424;
/** No authority server can take the room right now. Retry later. */
inline constexpr int kAuthorityCapacity = 503;
}  // namespace join_error

/** A preview (staging) build's rooms are keyed `preview--<slug>` by the relay (§3.4). The client
 *  always sends the plain slug as `gameId`. */
inline constexpr const char* kStagingRoomPrefix = "preview--";

/** The room key the relay files a join under. */
inline std::string RoomKeyFor(std::string_view slug, bool staging) {
  std::string key = staging ? std::string(kStagingRoomPrefix) : std::string();
  key.append(slug.data(), slug.size());
  return key;
}

/** The game slug behind a room key (the key itself for a live room). */
inline std::string SlugOfRoomKey(std::string_view key) {
  const std::string_view prefix(kStagingRoomPrefix);
  if (key.substr(0, prefix.size()) == prefix) key.remove_prefix(prefix.size());
  return std::string(key);
}

// ---- §5 messages ----

/** Client → relay message types (§5.2). */
namespace client_message {
inline constexpr const char* kState = "state";
inline constexpr const char* kStateSnap = "__state:snap";
inline constexpr const char* kShared = "shared";
inline constexpr const char* kClaim = "claim";
inline constexpr const char* kRelease = "release";
inline constexpr const char* kDestroy = "destroy";
inline constexpr const char* kObject = "obj";
inline constexpr const char* kObjectSnap = "__object:snap";
inline constexpr const char* kInput = "__input";
inline constexpr const char* kRoomOpen = "__room:open";
inline constexpr const char* kChat = "__chat";
inline constexpr const char* kChatHistoryRequest = "__chat:history:request";
inline constexpr const char* kVoiceIceRequest = "__voice:ice:request";
inline constexpr const char* kVoiceJoin = "__voice:join";
inline constexpr const char* kVoiceLeave = "__voice:leave";
inline constexpr const char* kVoiceSignal = "__voice:signal";
// match rooms only: self-reports, accepted only from an active seat
inline constexpr const char* kMatchEliminated = "match:eliminated";
inline constexpr const char* kMatchScore = "match:score";
inline constexpr const char* kMatchFinish = "match:finish";
// optional typed pose (§6.6)
inline constexpr const char* kPose = "__pose";
inline constexpr const char* kPoseSnap = "__pose:snap";
}  // namespace client_message

/** Relay → client message types (§5.3). */
namespace server_message {
inline constexpr const char* kObjectResult = "__object:result";
inline constexpr const char* kInput = "__input";
inline constexpr const char* kRoomOpen = "__room:open";
inline constexpr const char* kChat = "__chat";
inline constexpr const char* kChatHistory = "__chat:history";
inline constexpr const char* kVoiceIce = "__voice:ice";
inline constexpr const char* kVoiceSignal = "__voice:signal";
inline constexpr const char* kVoiceRejected = "__voice:rejected";
inline constexpr const char* kRateDrop = "rate:drop";
inline constexpr const char* kServerRestart = "server:restart";
// match rooms only
inline constexpr const char* kMatchStart = "match:start";
inline constexpr const char* kMatchEnded = "match:ended";
inline constexpr const char* kMatchRequeue = "match:requeue";
// queue room only
inline constexpr const char* kQueue = "queue";
inline constexpr const char* kSeat = "seat";
}  // namespace server_message

/** Prefixes a game event may not use (§5.4). */
inline constexpr const char* kReservedEventPrefixes[] = {"__", "match:", "server:", "rate:"};
/** Exact names a game event may not use (§5.4). */
inline constexpr const char* kReservedEventTypes[] = {"state",   "shared", "claim", "release",
                                                      "destroy", "obj",    "queue", "seat"};

/** Shared-map keys with this prefix are refused from clients (§5.2). */
inline constexpr const char* kReservedSharedPrefix = "__";
/** The key a sender stamps into its own `PlayerState.data` JSON: its send clock in ms (§6.1). */
inline constexpr const char* kSendTimeKey = "__t";

/** The `PlayerState` pose keys, in schema order (§6.6). */
inline constexpr const char* kPoseKeys[] = {"x", "y", "z", "yaw", "vx", "vy", "vz", "anim"};

// ---- §5.1 rate lanes ----

struct RateLane {
  const char* name;
  double rate;
  double burst;
  double softZone;
};
inline constexpr RateLane kRateLanes[] = {
    {"state", 30, 60, 0}, {"control", 40, 80, 0}, {"input", 60, 120, 0}, {"bulk", 120, 240, 60},
    {"chat", 2, 5, 0},    {"voice", 25, 60, 0},   {"pose", 30, 60, 0},
};
/** `bulk` and `input` additionally share this bucket. */
inline constexpr double kGlobalRateRate = 180;
inline constexpr double kGlobalRateBurst = 360;
/** Colyseus's per-socket ceiling: past it the socket CLOSES (4002). */
inline constexpr int kMaxMessagesPerSecond = 1200;

// ---- §11 close codes ----

namespace close_code {
// reconnectable (the seat is held for the grace window)
inline constexpr int kGoingAway = 1001;
inline constexpr int kNoStatus = 1005;
inline constexpr int kAbnormal = 1006;
/** Colyseus: the server is going down, come back. The one >= 4000 code that is not terminal. */
inline constexpr int kMayTryReconnect = 4010;
// terminal
inline constexpr int kNormal = 1000;
/** A deliberate leave (Colyseus CONSENTED); also the match room's requeue boot (MATCH_BOOT). */
inline constexpr int kConsented = 4000;
inline constexpr int kMatchBoot = 4000;
inline constexpr int kServerShutdown = 4001;
/** Colyseus: protocol error, or the socket exceeded kMaxMessagesPerSecond. */
inline constexpr int kWithError = 4002;
/** Colyseus SDK: every reconnection attempt failed (the grace expired). */
inline constexpr int kFailedToReconnect = 4003;
/** The player's session was revoked. Do not rejoin with it. */
inline constexpr int kRevoked = 4401;
/** A newer session of the same player took the seat. */
inline constexpr int kSuperseded = 4409;
// authority rooms only (§17.6), terminal
/** The operator or the platform halted the room. */
inline constexpr int kModuleHalted = 4500;
/** The game's room module broke its limits or threw; the room is gone. */
inline constexpr int kModuleFault = 4501;

/** Codes the SDK reconnects from (§8, §11). Everything else is terminal. */
constexpr bool IsReconnectable(int code) {
  return code == kGoingAway || code == kNoStatus || code == kAbnormal || code == kMayTryReconnect;
}
}  // namespace close_code

// ---- §5 limits (sizes are JS string lengths, i.e. UTF-16 code units; a UTF-8 byte length under
//      a limit is always within it) ----

namespace limits {
inline constexpr std::size_t kRoomMaxClients = 64;
inline constexpr std::size_t kMaxNameChars = 64;
inline constexpr std::size_t kMaxAvatarUrlChars = 512;
inline constexpr std::size_t kMaxUidChars = 64;
/** `state` / `__state:snap` payload (the JSON text). */
inline constexpr std::size_t kMaxStateBytes = 16 * 1024;
inline constexpr std::size_t kMaxSharedKeyChars = 256;
inline constexpr std::size_t kMaxSharedValueBytes = 64 * 1024;
/** Distinct game keys a room's `shared` map may ever hold. */
inline constexpr std::size_t kMaxSharedKeys = 256;
inline constexpr std::size_t kMaxObjectIdChars = 128;
/** An object's `d` as stored (JSON text). */
inline constexpr std::size_t kMaxObjectStateBytes = 64 * 1024;
/** Live objects per room. */
inline constexpr std::size_t kMaxObjects = 128;
inline constexpr std::size_t kMaxRequestIdChars = 96;
/** Game events and `__input`: the payload's JSON encoding. */
inline constexpr std::size_t kMaxEventBytes = 16 * 1024;
inline constexpr std::size_t kMaxEventTypeChars = 128;
/** JSON payload shape bounds. The msgpack encoder counts the root as level 1 (the Rust codec). */
inline constexpr std::size_t kMaxJsonDepth = 32;
inline constexpr std::size_t kMaxJsonNodes = 4096;
/** Code points per chat line after normalization. */
inline constexpr std::size_t kMaxChatChars = 500;
inline constexpr std::size_t kChatHistoryMax = 50;
inline constexpr std::size_t kChatHistoryMaxBytes = 8 * 1024;
inline constexpr std::size_t kMaxVoiceParticipants = 6;
inline constexpr std::size_t kMaxVoiceSignalBytes = 8 * 1024;
/** `match:score` delta is clamped to ±this. */
inline constexpr double kMaxScoreDelta = 1000;
/** Results kept per session for request-id replay, and how long. */
inline constexpr std::size_t kControlResultsPerSession = 128;
inline constexpr double kControlResultTtlMs = 60000;
/** Open preset `teams` knob range (0 = no teams). */
inline constexpr int kMaxTeams = 8;
/** `__pose` `anim` string (§6.6). */
inline constexpr std::size_t kMaxAnimChars = 64;
/** Every `__pose` number must be finite with |v| <= this. */
inline constexpr double kMaxPoseAbs = 1e9;
}  // namespace limits

// ---- relay timing defaults (relay env knobs; clients must not hard-depend on them) ----

namespace relay_timing {
inline constexpr double kPatchIntervalMs = 1000.0 / 30.0;
inline constexpr double kReconnectGraceS = 30;
inline constexpr double kGoingAwayGraceS = 5;
inline constexpr double kHostFailoverGraceMs = 1500;
inline constexpr double kMinOwnershipHoldMs = 300;
inline constexpr double kShutdownDrainMs = 3000;
inline constexpr double kRequeueGraceMs = 5000;
inline constexpr double kSeatReservationS = 15;
inline constexpr double kQueueTickMs = 1000;
inline constexpr double kRevocationSweepMs = 30000;
}  // namespace relay_timing

// ---- §17 authority timing defaults ----

namespace authority_timing {
inline constexpr int kTickHz = 30;
inline constexpr double kRenderDelayMs = 100;
inline constexpr double kMaxRewindMs = 500;
inline constexpr int kInputBuffer = 32;
inline constexpr double kPatchIntervalMs = 50;
}  // namespace authority_timing

// ---- §8 reconnection: the settings every client applies (`ClientReconnection`) ----

namespace reconnection {
inline constexpr bool kEnabled = true;
inline constexpr int kMinUptimeMs = 0;
inline constexpr int kDelayMs = 125;
inline constexpr int kMinDelayMs = 100;
inline constexpr int kMaxDelayMs = 4000;
inline constexpr int kMaxRetries = 9;
inline constexpr int kMaxEnqueuedMessages = 0;
/** After the SDK reports reconnected, wait at most this for the first state decode. */
inline constexpr double kFirstStateTimeoutMs = 2000;
}  // namespace reconnection

/** Control request client timeouts (§7.2). */
inline constexpr double kControlTimeoutMs = 5000;
inline constexpr double kControlTimeoutMaxMs = 60000;

// ---- §7 object ownership ----

namespace object_control {
inline constexpr const char* kOpClaim = "claim";
inline constexpr const char* kOpRelease = "release";
inline constexpr const char* kOpRemove = "remove";
inline constexpr const char* kReasonAccepted = "accepted";
inline constexpr const char* kReasonAlreadyOwner = "already-owner";
inline constexpr const char* kReasonHeld = "held";
inline constexpr const char* kReasonRateLimited = "rate-limited";
inline constexpr const char* kReasonNotOwner = "not-owner";
inline constexpr const char* kReasonCapacity = "capacity";
inline constexpr const char* kReasonInvalid = "invalid";
inline constexpr const char* kReasonMissing = "missing";
inline constexpr const char* kReasonHostAuthority = "host-authority";
inline constexpr const char* kReasonNotHost = "not-host";
/** `authority: 'host'` on a claim (host-only). */
inline constexpr const char* kAuthorityHost = "host";
}  // namespace object_control

// ---- §10 interpolation defaults (`Interpolation`) ----

namespace interpolation {
inline constexpr double kRatio = 1.5;
inline constexpr double kJitterSafety = 1.25;
inline constexpr double kMinMs = 90;
inline constexpr double kMaxMs = 300;
inline constexpr double kDefaultMs = 100;
inline constexpr double kEase = 0.1;
inline constexpr std::size_t kClockWindow = 80;
inline constexpr double kClockWindowMs = 5000;
inline constexpr std::size_t kClockWindowMax = 4096;
inline constexpr std::size_t kIntervalWindow = 30;
inline constexpr double kMinGapMs = 5;
inline constexpr double kMaxGapMs = 2000;
inline constexpr double kHistoryMs = 1500;
inline constexpr double kMaxExtrapMs = 250;
inline constexpr double kRotExtrapMs = 150;
inline constexpr double kSmoothTauPosMs = 30;
inline constexpr double kSmoothTauRotMs = 70;
inline constexpr double kPoisonGuardMs = 2000;
inline constexpr double kRebaseAfterGapMs = 1000;
inline constexpr double kMaxHostTickDtMs = 250;
/** The jitter term applies once a stream holds this many (arrival − send) values (Rust port). */
inline constexpr std::size_t kJitterMinSamples = 8;
}  // namespace interpolation

// ---- §16 server clock heartbeat (`ClockSync`) ----

namespace clock_sync {
inline constexpr double kHeartbeatHz = 10;
inline constexpr double kMinHeartbeatHz = 5;
inline constexpr double kMaxHeartbeatHz = 20;
inline constexpr double kHeartbeatDither = 0.15;
inline constexpr int kRelayBuffer = 4;
inline constexpr int kWarmupAcks = 30;
}  // namespace clock_sync

// ---- helpers ----

/** UTF-16 code units of a (valid) UTF-8 string: what every JS-side length limit counts. */
inline std::size_t Utf16Length(std::string_view utf8) {
  std::size_t units = 0;
  for (const char ch : utf8) {
    const unsigned char b = static_cast<unsigned char>(ch);
    if (b < 0x80 || (b >= 0xC0 && b < 0xF0)) {
      units += 1;
    } else if (b >= 0xF0) {
      units += 2;
    }
    // 0x80..0xBF: continuation byte, already counted with its lead.
  }
  return units;
}

/** Whether `type` belongs to the relay rather than the game (§5.4). */
inline bool IsReservedEventType(std::string_view type) {
  for (const char* exact : kReservedEventTypes) {
    if (type == exact) return true;
  }
  for (const char* prefix : kReservedEventPrefixes) {
    const std::string_view p(prefix);
    if (type.substr(0, p.size()) == p) return true;
  }
  return false;
}

/** Whether `type` may be sent as a game event: 1..kMaxEventTypeChars UTF-16 units, not reserved. */
inline bool IsSendableEventType(std::string_view type) {
  const std::size_t units = Utf16Length(type);
  return units > 0 && units <= limits::kMaxEventTypeChars && !IsReservedEventType(type);
}

/** The rate lane a client message spends (§5.1); game events and anything unhandled: "bulk". */
inline const char* MessageLane(std::string_view type) {
  struct Row {
    const char* type;
    const char* lane;
  };
  static constexpr Row kRows[] = {
      {client_message::kState, "state"},
      {client_message::kStateSnap, "state"},
      {client_message::kShared, "bulk"},
      {client_message::kClaim, "control"},
      {client_message::kRelease, "control"},
      {client_message::kDestroy, "control"},
      {client_message::kObject, "bulk"},
      {client_message::kObjectSnap, "bulk"},
      {client_message::kInput, "input"},
      {client_message::kRoomOpen, "control"},
      {client_message::kChat, "chat"},
      {client_message::kChatHistoryRequest, "control"},
      {client_message::kVoiceIceRequest, "voice"},
      {client_message::kVoiceJoin, "voice"},
      {client_message::kVoiceLeave, "voice"},
      {client_message::kVoiceSignal, "voice"},
      {client_message::kMatchEliminated, "bulk"},
      {client_message::kMatchScore, "bulk"},
      {client_message::kMatchFinish, "bulk"},
      {client_message::kPose, "pose"},
      {client_message::kPoseSnap, "pose"},
  };
  for (const Row& row : kRows) {
    if (type == row.type) return row.lane;
  }
  return "bulk";
}

}  // namespace genex::protocol
