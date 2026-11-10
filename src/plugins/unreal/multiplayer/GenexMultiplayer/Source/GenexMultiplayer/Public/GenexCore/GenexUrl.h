// URL rules and join options shared by the relay and authority sessions.
//
// Sources of truth:
// - IsLoopbackUrl: sdks/unity/Runtime/Core/Authority/GenexAuthoritySession.cs `IsLoopbackUrl`
//   (identical to Godot genex_authority.gd `is_loopback_url`); every row of Unity's
//   Tests~/GenexSmoke/AuthorityEdge.cs Offline table and Godot's authority_unit.gd LOOPBACK_TABLE
//   holds (sdks/unreal/core/tools/offline_urls.cpp).
// - PickAuthorityUrl: Unity `PickUrl` (an explicit url wins; one of urls is used directly; several
//   are RACED by latency; else GENEX_AUTHORITY_URL; else refused). Godot's `_pick_url` takes the
//   first of several instead; Unity's is the newer measured behaviour (engine-sdks.md: "raced
//   `Urls`" is one of Unity's verified authority-edge rows) and the C core has the same race
//   (colyseus_select_by_latency), so Unity's rule is the port.
// - PickRelayUrl: the Rust crate's endpoints (one = direct, several = colyseus_select_by_latency),
//   with an explicit url first as Godot's native_backend.gd `_pick_url`. No environment fallback.
// - BuildJoinOptions: Godot native_backend.gd / authority_native.gd `_join_options` (extras minus
//   the server-owned names, then gameId, embedToken, name capped, protocol LAST), cross-checked with
//   the Rust crate's `join_options` (protocol last) and Unity's `BuildJoinOptions`.
// - ParseUrl: the Rust crate's `parse_endpoint` (ws/wss/http/https, default ports 80/443), which
//   this extends with a path (an API base may have one) and makes stricter (see ParseUrl).
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexJson.h"

#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace genex {

// ---- URLs ----

struct ParsedUrl {
  /** "ws", "wss", "http" or "https" (lowercase; nothing else parses). */
  std::string scheme;
  /** The host as written; an IPv6 literal keeps its brackets (`[::1]`), the form
   *  colyseus_settings_set_address takes. */
  std::string host;
  /** 1..65535; 80 or 443 when the URL names none. */
  int port = 0;
  /** wss or https. */
  bool secure = false;
  /** Whether the URL spelled the port out. */
  bool explicitPort = false;
  /** "" or "/…", query included (a trailing "/" alone is kept as "/"). */
  std::string path;

  /** `scheme://host[:port]`, the port written only when the URL had one. */
  std::string Origin() const;
};

/**
 * Parse an absolute ws/wss/http/https URL. Refused (nullopt, `error` filled when not null): any
 * other scheme or an upper-case one (as the Rust crate), no host, a userinfo (`user@host`), a port
 * that is not 1..65535 digits, a ':' in a host that is not a bracketed IPv6 literal, a fragment, and
 * any space or control character. Stricter than Rust's parse_endpoint, which also accepted a
 * userinfo inside the host and port 0, and refused every path.
 */
GENEX_CORE_API std::optional<ParsedUrl> ParseUrl(std::string_view url, std::string* error = nullptr);

/** Whether `url` names this machine: ws/wss (lowercase) on 127.0.0.1, localhost or [::1], with no
 *  userinfo. Exactly Unity's/Godot's rule, look-alike hosts and `http://` refused. */
GENEX_CORE_API bool IsLoopbackUrl(std::string_view url);

// ---- the launcher's environment ----

/** Studio's local authority server (PROTOCOL.md §17; Godot/Unity `GENEX_AUTHORITY_URL`). */
inline constexpr const char* kAuthorityUrlEnv = "GENEX_AUTHORITY_URL";
/** The placeholder credential a LOOPBACK authority server is joined with when the game supplied no
 *  token provider (embed-sdk's local test mode sends the same; a real server refuses it). */
inline constexpr const char* kLocalAuthorityToken = "local:test";

/** The process environment variable `name`, or nullopt when it is not set (an empty value is
 *  returned as ""). Windows: _dupenv_s; elsewhere getenv. */
GENEX_CORE_API std::optional<std::string> GetEnv(const char* name);
/** Set `name` (setenv; Windows _putenv_s). Call it before other threads start. */
GENEX_CORE_API bool SetEnv(const char* name, const char* value);
/** Remove `name` (unsetenv; Windows _putenv_s(name, ""), which removes it). */
GENEX_CORE_API bool UnsetEnv(const char* name);

// ---- which server to join ----

enum class UrlPickKind {
  /** Join `url`. */
  Direct,
  /** Measure `urls` (colyseus_select_by_latency) and join the fastest. */
  Race,
  /** Nothing to join: `error` says why. */
  Refused,
};

struct UrlPick {
  UrlPickKind kind = UrlPickKind::Refused;
  std::string url;
  std::vector<std::string> urls;
  std::string error;
};

/** Relay: a non-empty `url` wins; else the non-empty entries of `urls` (one = Direct, several =
 *  Race); else Refused. Empty entries are skipped (a stricter choice than the sources, which would
 *  probe an empty URL and fail). */
GENEX_CORE_API UrlPick PickRelayUrl(std::string_view url, const std::vector<std::string>& urls);

/** Authority: as PickRelayUrl, then `env` (the value of GENEX_AUTHORITY_URL; empty = unset), then
 *  Refused. */
GENEX_CORE_API UrlPick PickAuthorityUrl(std::string_view url, const std::vector<std::string>& urls,
                                        const std::optional<std::string>& env);

/** PickAuthorityUrl with `env` read from the process environment. */
GENEX_CORE_API UrlPick PickAuthorityUrlFromEnv(std::string_view url, const std::vector<std::string>& urls);

// ---- join options ----

enum class RoomProtocol {
  /** `play` / `queue` / `match` relay rooms: protocol 3, the relay's server-owned options. */
  Relay,
  /** `authority` rooms: protocol 4, the authority server's server-owned options (§17.2). */
  Authority,
};

struct JoinSpec {
  /** The game's slug (required). */
  std::string gameId;
  /** Display-name fallback ("" = none). Capped at protocol::limits::kMaxNameChars. */
  std::string name;
  /** Extra options (an object; anything else is ignored). Server-owned names and the protocol's
   *  own keys are dropped from it, never sent. */
  Json extra = Json::MakeObject();
  /** Authority rooms: the `caps` option (§17.10 *Joining*), written just before `protocol`; a `caps`
   *  in `extra` is then dropped. nullopt sends none (absent = []). */
  std::optional<std::vector<std::string>> caps;
};

/** Whether `key` is a server-owned join option of that room type (sending it is a 400). */
GENEX_CORE_API bool IsServerOwnedJoinOption(RoomProtocol room, std::string_view key);

/** `name` cut to protocol::limits::kMaxNameChars UTF-16 units (what the relay counts), never inside a
 *  code point: a character that would straddle the limit is left out. "" for invalid UTF-8. */
GENEX_CORE_API std::string CapDisplayName(std::string_view name);

/** A JSON value fit for the wire, as Godot util.gd `sanitize`: non-finite numbers become 0, and
 *  a container on level protocol::limits::kMaxJsonDepth (the root is level 1) becomes null, so the
 *  value always msgpack-encodes within the depth bound. */
GENEX_CORE_API Json SanitizeJoinValue(const Json& value);

/**
 * The join options of ONE attempt, in this order: the extras (sanitized, minus server-owned names
 * and minus gameId/embedToken/name/protocol, and caps when `spec.caps` is set), `gameId`, `embedToken`
 * (only when `token` is not empty: Unity's rule; Godot sends ""), `name` (capped; absent when empty),
 * `caps` (when `spec.caps` is set), and `protocol` LAST
 * (3 or 4: PROTOCOL.md §2, nothing can misreport it). Every number in it msgpack-encodes as float64
 * or an integer that fits 32 bits (GenexMsgpack never writes int64). Refused (nullopt) for an empty
 * or non-UTF-8 gameId. Build it again for every attempt with a fresh token (§3.2): the result must
 * never be cached past its join.
 */
GENEX_CORE_API std::optional<Json> BuildJoinOptions(RoomProtocol room, const JoinSpec& spec,
                                                    std::string_view token, std::string* error = nullptr);

}  // namespace genex
