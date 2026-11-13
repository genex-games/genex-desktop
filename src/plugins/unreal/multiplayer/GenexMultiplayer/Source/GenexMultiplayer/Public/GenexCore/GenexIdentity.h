// Native play identity (CLI_INTEGRATION.md §6b): the three doors that end in the same `embed:play`
// token a browser holds, its refresh, and the token provider every join reads.
//
// Sources of truth: sdks/rust/genex-multiplayer/src/native/identity.rs (doors, refresh policy,
// colyseus_urls, the GENEX_API_URL rule), sdks/godot/addons/genex_multiplayer/identity.gd (the
// relayUrls/authorityUrls adoption, the device wait loop, the 401 → session over), cross-checked
// with sdks/unity/Runtime/Core/GenexNativeIdentity.cs.
//
//   door 1 guest:        POST /api/embed/guest-session { slug }
//   door 2 launcher:     GENEX_EMBED_TICKET (read ONCE, then removed) → POST /api/embed/session { ticket }
//   door 3 device code:  POST /api/embed/device { slug } → player approves → POST /api/embed/device/token
//   refresh:             POST /api/embed/session/refresh   Authorization: Bearer <embedToken>
//
// GENEX_API_URL (a launcher's gateway) replaces the game's API base for every call, read per
// request; empty or whitespace is unset. No Origin header is ever sent. Tokens and tickets are never
// logged, persisted or put in a URL.
//
// ASYNCHRONOUS and single-threaded: every call returns at once and answers through its callback, on
// the thread that pumps GenexCore (from the IHttp's answer, or from Update for the device wait).
// A callback may be called from inside the call that started it (a synchronous IHttp); callbacks
// are never called after the EmbedIdentity is destroyed. A callback may destroy the identity.
#pragma once

#include "GenexCore/GenexAuthorityRegions.h"
#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexHttp.h"
#include "GenexCore/GenexJson.h"
#include "GenexCore/GenexPump.h"
#include "GenexCore/GenexUrl.h"

#include <cstddef>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace genex {

/** The environment variable a launcher hands a single-use ticket in (§6b door 2). */
inline constexpr const char* kTicketEnv = "GENEX_EMBED_TICKET";
/** Genex's API as the launcher names it (§6b); wins over the game's API base. */
inline constexpr const char* kApiUrlEnv = "GENEX_API_URL";
inline constexpr const char* kDefaultApiBase = "https://api.genex.games";

namespace identity_limits {
/** Refresh a token this old (Rust REFRESH_AFTER_MS; tokens live 15 minutes, the browser rolls ~10). */
inline constexpr double kRefreshAfterMs = 9.0 * 60000.0;
/** A token this old is expired for sure (Rust TOKEN_LIFETIME_MS). */
inline constexpr double kTokenLifetimeMs = 15.0 * 60000.0;
/** A refresh refused with 503 keeps the current token while it is younger than lifetime − this. */
inline constexpr double kExpiryMarginMs = 30000.0;
/** Device sign-in defaults (§6b: expiresIn 600, interval 3) and the bounds a server value is held to. */
inline constexpr double kDeviceIntervalS = 3.0;
inline constexpr double kDeviceExpiresInS = 600.0;
inline constexpr double kMinDeviceIntervalS = 1.0;  // Godot maxf(1.0, interval)
inline constexpr double kMaxDeviceIntervalS = 60.0;
inline constexpr double kMaxDeviceExpiresInS = 3600.0;
/** A sign-in answer larger than this is refused unread. */
inline constexpr std::size_t kMaxAnswerBytes = 64 * 1024;
/** An embedToken / deviceCode longer than this, or holding anything but printable ASCII, is refused. */
inline constexpr std::size_t kMaxTokenBytes = 8 * 1024;
/** Error messages copied from an answer body are cut to this many bytes. */
inline constexpr std::size_t kMaxErrorMessageBytes = 200;
}  // namespace identity_limits

struct IdentityError {
  /** HTTP status; 0 = transport or local failure. */
  int status = 0;
  /** The API's `error` (else `status`) string when it sent one, else the body or a local message. */
  std::string message;

  /** The identity is over (`401 session_expired`, or a spent ticket): start again with a door. */
  bool IsExpired() const { return status == 401; }
  /** "identity request failed (<status>): <message>". */
  std::string Describe() const;
};

using IdentityCallback = std::function<void(bool ok, const IdentityError& error)>;
using TokenCallback = std::function<void(bool ok, const std::string& token, const IdentityError& error)>;
/** Hands a token fit for a join right now to its callback. Called before EVERY join attempt. */
using TokenProvider = std::function<void(TokenCallback done)>;

/** The URLs of a sign-in answer: `colyseus.urls` (else `colyseus.url`) and `colyseus.authorityUrls`;
 *  only non-empty strings count, and a value that is not a list is no list (Rust colyseus_urls). */
struct SignInUrls {
  std::vector<std::string> relay;
  std::vector<std::string> authority;
  /** `colyseus.authorityRegions` (PROTOCOL.md §17.1 *Regions*), read as every SDK reads them (regions::Normalize);
   *  empty when the answer names none. */
  std::vector<regions::Region> authorityRegions;
  /** `colyseus.authorityHome` (PROTOCOL.md §17.1 *Regions*), the player's region by geography: empty unless it is a
   *  non-empty string naming one of authorityRegions. */
  std::string authorityHome;
};
GENEX_CORE_API SignInUrls ColyseusUrls(const Json& answer);

/** `launcher` (GENEX_API_URL's value) trimmed when it is non-blank, else `gameBase`; then any
 *  trailing '/' removed. Pure (Rust pick_api_base, Unity ResolveApiBase). */
GENEX_CORE_API std::string ResolveApiBase(std::string_view gameBase, const std::optional<std::string>& launcher);
/** ResolveApiBase with GENEX_API_URL read from the process environment now. */
GENEX_CORE_API std::string ApiBaseFromEnvironment(std::string_view gameBase);

/** Read GENEX_EMBED_TICKET and remove it from this process's environment, whatever it held. Call it
 *  FIRST at startup (the ticket lives 60 s), before any thread starts. nullopt when unset or empty;
 *  a second call always answers nullopt. */
GENEX_CORE_API std::optional<std::string> TakeLaunchTicket();

/** What to show for a device sign-in. The device code itself (the secret) stays inside the identity. */
struct DeviceCodeInfo {
  std::string userCode;
  std::string verificationUri;
  std::string verificationUriComplete;
  double expiresInS = identity_limits::kDeviceExpiresInS;
  double intervalS = identity_limits::kDeviceIntervalS;
  /** `{ id, slug, title }` when the API sent it, else null. */
  Json project;
};

enum class DevicePollStatus {
  /** Not yet: poll again after `intervalS`. */
  Pending,
  /** The token is held. */
  Approved,
  /** The player refused: stop, offer a guest. */
  Denied,
  /** Expired or already collected (410), or the wait ran out: start again. */
  Expired,
  /** This poll failed (transport, 5xx, a bad answer): the code is kept; `error` says why. */
  Failed,
};

GENEX_CORE_API const char* DevicePollStatusName(DevicePollStatus status);

using DeviceStartCallback = std::function<void(bool ok, const DeviceCodeInfo& info, const IdentityError& error)>;
using DevicePollCallback = std::function<void(DevicePollStatus status, const IdentityError& error)>;

/** A play identity for ONE game: the current `embed:play` token and its refresh. */
class GENEX_CORE_API EmbedIdentity final : public IPumped {
 public:
  struct Options {
    /** The game's API base; GENEX_API_URL replaces it when set. */
    std::string apiBase = kDefaultApiBase;
    /** The game's slug (doors 1 and 3). */
    std::string slug;
    /** Transport; null = DefaultHttp(). Must outlive this identity. */
    IHttp* http = nullptr;
    /** Monotonic milliseconds; empty = Clock::NowMs. (Tests inject one.) */
    std::function<double()> clock;
  };

  explicit EmbedIdentity(Options options);
  ~EmbedIdentity() override;
  EmbedIdentity(const EmbedIdentity&) = delete;
  EmbedIdentity& operator=(const EmbedIdentity&) = delete;

  /** Door 1: a save-less production guest for a PUBLISHED game (404 for a draft). */
  void SignInAsGuest(IdentityCallback done);
  /** Door 1's preview form: a save-less guest on a draft's PREVIEW (the staging channel, the API's public door
   *  for a preview, `probe`), how a native test client joins a game that is not published. The token only
   *  reaches the preview's own rooms; a game with no preview answers 404. */
  void SignInAsPreviewGuest(IdentityCallback done);
  /** Door 2 from the environment: TakeLaunchTicket(), then RedeemTicket. False (and `done` is never
   *  called) when the game was not launched by Genex. */
  bool SignInFromLauncher(IdentityCallback done);
  /** Door 2: redeem a launcher ticket. A 401 means spent or expired: fall back to a guest or device. */
  void RedeemTicket(std::string ticket, IdentityCallback done);

  /** Door 3, step 1: start a device sign-in. Show `userCode` and `verificationUri`. Replaces any
   *  device sign-in in progress (a running wait ends Failed "cancelled"). */
  void StartDeviceSignIn(DeviceStartCallback done);
  /** Door 3, step 2: poll once. Call no faster than `intervalS`. */
  void PollDeviceSignIn(DevicePollCallback done);
  /** Door 3, step 2 as a loop (Godot device_wait): wait `intervalS`, poll, repeat until Approved,
   *  Denied or Expired (a failed poll is retried, the code's `expiresIn` bounds the whole wait).
   *  Driven by Update: the identity registers itself with genex::Pump while it waits. */
  void WaitForDeviceSignIn(DevicePollCallback done);
  /** Forget the device sign-in; a running wait ends Failed with message "cancelled". */
  void CancelDeviceSignIn();
  bool HasDeviceSignIn() const { return device_.has_value(); }
  const DeviceCodeInfo* DeviceInfo() const { return device_ ? &device_->info : nullptr; }

  /** Roll the token now. A 401 ends the identity (token dropped, onSessionExpired). Concurrent calls
   *  share one request. */
  void Refresh(IdentityCallback done);
  /** A token fit for a join right now, refreshed first when it is kRefreshAfterMs old. A refresh
   *  refused with 503 keeps the current token while it is still valid (Rust `token()`). */
  void GetToken(TokenCallback done);
  /** GetToken as a TokenProvider for the sessions. Safe to call after the identity is gone (it then
   *  answers an error). */
  TokenProvider Provider();
  /** Forget the token and URLs locally (nothing is sent). */
  void SignOut();

  bool HasToken() const { return !token_.empty(); }
  /** Signed in through door 1. */
  bool IsGuest() const { return isGuest_; }
  /** The relay URLs of the last sign-in answer (Godot relay_urls; kept when an answer has none). */
  const std::vector<std::string>& RelayUrls() const { return relayUrls_; }
  /** The authority cluster's URLs (`colyseus.authorityUrls`); empty where a stand runs none. */
  const std::vector<std::string>& AuthorityUrls() const { return authorityUrls_; }
  /** The authority cluster by region (`colyseus.authorityRegions`, §17.1 *Regions*): pass them as
   *  AuthorityOptions::regions beside urls. Empty where a stand names none. */
  const std::vector<regions::Region>& AuthorityRegions() const { return authorityRegions_; }
  /** The player's home region (`colyseus.authorityHome`, §17.1 *Regions*), the region nearest the player by
   *  geography: pass it as AuthorityOptions::home beside regions. Empty where the answer names none of AuthorityRegions. */
  const std::string& AuthorityHome() const { return authorityHome_; }
  /** The `user` object of the last sign-in answer ({} when none). */
  const Json& User() const { return user_; }
  /** The `project` object of the last sign-in answer (null when none). */
  const Json& Project() const { return project_; }
  /** The API base the next request goes to (GENEX_API_URL when set, else Options::apiBase). */
  std::string ApiBase() const;
  const std::string& Slug() const { return options_.slug; }

  /** Called after a door or a refresh stored a new token. */
  std::function<void()> onTokenChanged;
  /** Called when a refresh answered 401: the identity is over. */
  std::function<void()> onSessionExpired;

  /** Advances a device wait (Pump::Frame calls it while one runs). */
  void Update(double nowMs) override;

 private:
  struct Answer;
  struct Device {
    std::string code;
    DeviceCodeInfo info;
    double deadlineMs = 0.0;
  };

  double Now() const;
  void Post(const char* path, Json body, const std::string& bearer, std::function<void(Answer)> handler);
  void SignInWith(const char* path, Json body, bool guest, IdentityCallback done);
  bool Adopt(const Json& answer, bool guest, IdentityError* error);
  void FinishRefresh(bool ok, const IdentityError& error);
  void FinishWait(DevicePollStatus status, const IdentityError& error);
  void SetWaiting(bool waiting);

  Options options_;
  IHttp* http_ = nullptr;
  std::shared_ptr<int> alive_;
  std::string token_;
  double mintedAtMs_ = 0.0;
  /** Bumped by every adopt and sign-out, so a refresh answer for an older token is ignored. */
  unsigned generation_ = 0;
  bool isGuest_ = false;
  std::vector<std::string> relayUrls_;
  std::vector<std::string> authorityUrls_;
  std::vector<regions::Region> authorityRegions_;
  std::string authorityHome_;
  Json user_ = Json::MakeObject();
  Json project_;
  std::vector<IdentityCallback> refreshWaiters_;
  bool refreshing_ = false;
  std::optional<Device> device_;
  unsigned deviceGeneration_ = 0;
  DevicePollCallback waitDone_;
  bool waiting_ = false;
  bool waitPollInFlight_ = false;
  double nextPollAtMs_ = 0.0;
  bool registered_ = false;
};

using JoinOptionsCallback = std::function<void(std::optional<Json> options, const IdentityError& error)>;

/**
 * The join options of ONE attempt (call it again for every attempt, §3.2): asks `provider` for a
 * fresh token and hands BuildJoinOptions' result to `done`. Without a provider, an AUTHORITY join to
 * a loopback `url` (IsLoopbackUrl) carries kLocalAuthorityToken (Unity/Godot); any other join without
 * one carries no token (a relay or a real server then refuses it with 401). A provider error, or a
 * refused build, answers nullopt.
 */
GENEX_CORE_API void RequestJoinOptions(RoomProtocol room, const JoinSpec& spec, std::string_view url,
                                       const TokenProvider& provider, JoinOptionsCallback done);

}  // namespace genex
