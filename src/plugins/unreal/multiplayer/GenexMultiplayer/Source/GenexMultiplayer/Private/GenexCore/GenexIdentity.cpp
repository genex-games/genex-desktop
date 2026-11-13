// Native play identity: a port of sdks/rust/genex-multiplayer/src/native/identity.rs (doors,
// refresh policy, colyseus_urls, pick_api_base) with Godot identity.gd's URL adoption, 401 handling
// and device wait loop, cross-checked with Unity GenexNativeIdentity.cs. See GenexCore/GenexIdentity.h.
#include "GenexCore/GenexIdentity.h"

#include "GenexCore/GenexClock.h"
#include "GenexCore/GenexLog.h"
#include "GenexCore/GenexProtocol.h"

#include <algorithm>
#include <cmath>
#include <string>
#include <utility>

namespace genex::identity_detail {

bool IsSpace(char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == '\f' || c == '\v'; }

std::string_view Trim(std::string_view text) {
  while (!text.empty() && IsSpace(text.front())) text.remove_prefix(1);
  while (!text.empty() && IsSpace(text.back())) text.remove_suffix(1);
  return text;
}

/** A credential the API minted: printable ASCII with no space (a JWT, a device code), bounded. A
 *  CR/LF would split the Authorization header it is later sent in. */
bool IsCredentialText(const Json* value) {
  if (value == nullptr || !value->IsString()) return false;
  const std::string& text = value->AsString();
  if (text.empty() || text.size() > identity_limits::kMaxTokenBytes) return false;
  for (const char c : text) {
    const unsigned char b = static_cast<unsigned char>(c);
    if (b < 0x21 || b > 0x7e) return false;
  }
  return true;
}

/** Server text fit for an error message: bounded, valid UTF-8, never cut inside a character. */
std::string Clip(std::string_view text) {
  if (!IsValidUtf8(text)) return std::string("(unreadable body)");
  if (text.size() <= identity_limits::kMaxErrorMessageBytes) return std::string(text);
  std::size_t end = identity_limits::kMaxErrorMessageBytes;
  while (end > 0 && (static_cast<unsigned char>(text[end]) & 0xC0) == 0x80) --end;
  return std::string(text.substr(0, end));
}

JsonLimits AnswerLimits() {
  JsonLimits limits;
  limits.maxDepth = protocol::limits::kMaxJsonDepth;
  limits.maxNodes = protocol::limits::kMaxJsonNodes;
  limits.maxBytes = identity_limits::kMaxAnswerBytes;
  return limits;
}

std::vector<std::string> NonEmptyStrings(const Json* list) {
  std::vector<std::string> out;
  if (list == nullptr || !list->IsArray()) return out;
  for (const Json& item : list->Items()) {
    if (item.IsString() && !item.AsString().empty()) out.push_back(item.AsString());
  }
  return out;
}

std::string StringField(const Json& object, const char* key) {
  const Json* value = object.Find(key);
  return value != nullptr && value->IsString() ? value->AsString() : std::string();
}

/** A server-sent poll interval in seconds, held to [kMinDeviceIntervalS, kMaxDeviceIntervalS]. */
double Interval(const Json* value, double fallback) {
  if (value == nullptr || !value->IsNumber() || !std::isfinite(value->AsNumber())) return fallback;
  const double s = value->AsNumber();
  return (std::min)((std::max)(s, identity_limits::kMinDeviceIntervalS), identity_limits::kMaxDeviceIntervalS);
}

/** A server-sent device-code lifetime in seconds: positive, at most kMaxDeviceExpiresInS. */
double ExpiresIn(const Json* value) {
  if (value == nullptr || !value->IsNumber() || !std::isfinite(value->AsNumber()) || value->AsNumber() <= 0) {
    return identity_limits::kDeviceExpiresInS;
  }
  return (std::min)(value->AsNumber(), identity_limits::kMaxDeviceExpiresInS);
}

IdentityError Local(const char* message) {
  IdentityError e;
  e.message = message;
  return e;
}

}  // namespace genex::identity_detail

namespace genex {

struct EmbedIdentity::Answer {
  /** A 2xx whose body is a JSON object. */
  bool ok = false;
  Json json;
  IdentityError error;
};

std::string IdentityError::Describe() const {
  return "identity request failed (" + std::to_string(status) + "): " + message;
}

const char* DevicePollStatusName(DevicePollStatus status) {
  switch (status) {
    case DevicePollStatus::Pending: return "pending";
    case DevicePollStatus::Approved: return "approved";
    case DevicePollStatus::Denied: return "denied";
    case DevicePollStatus::Expired: return "expired";
    case DevicePollStatus::Failed: return "failed";
  }
  return "failed";
}

SignInUrls ColyseusUrls(const Json& answer) {
  SignInUrls out;
  const Json* colyseus = answer.Find("colyseus");
  if (colyseus == nullptr || !colyseus->IsObject()) return out;
  out.relay = identity_detail::NonEmptyStrings(colyseus->Find("urls"));
  if (out.relay.empty()) {
    const Json* url = colyseus->Find("url");
    if (url != nullptr && url->IsString() && !url->AsString().empty()) out.relay.push_back(url->AsString());
  }
  out.authority = identity_detail::NonEmptyStrings(colyseus->Find("authorityUrls"));
  out.authorityRegions = regions::Normalize(colyseus->Find("authorityRegions"), nullptr);
  // A home is a non-empty string naming a listed region; Normalize keeps no region without a name.
  const Json* home = colyseus->Find("authorityHome");
  const bool named = home != nullptr && home->IsString() && !home->AsString().empty();
  const auto listed = [&](const regions::Region& r) { return r.name == home->AsString(); };
  if (named && std::any_of(out.authorityRegions.begin(), out.authorityRegions.end(), listed)) out.authorityHome = home->AsString();
  return out;
}

std::string ResolveApiBase(std::string_view gameBase, const std::optional<std::string>& launcher) {
  std::string_view base = gameBase;
  if (launcher) {
    const std::string_view trimmed = identity_detail::Trim(*launcher);
    if (!trimmed.empty()) base = trimmed;
  }
  while (!base.empty() && base.back() == '/') base.remove_suffix(1);
  return std::string(base);
}

std::string ApiBaseFromEnvironment(std::string_view gameBase) { return ResolveApiBase(gameBase, GetEnv(kApiUrlEnv)); }

std::optional<std::string> TakeLaunchTicket() {
  std::optional<std::string> ticket = GetEnv(kTicketEnv);
  // Removed whatever it held, before anything else can read or inherit it (§6b).
  UnsetEnv(kTicketEnv);
  if (!ticket || ticket->empty()) return std::nullopt;
  return ticket;
}

// ---- EmbedIdentity ----

EmbedIdentity::EmbedIdentity(Options options)
    : options_(std::move(options)), alive_(std::make_shared<int>(0)) {
  http_ = options_.http != nullptr ? options_.http : &DefaultHttp();
}

EmbedIdentity::~EmbedIdentity() {
  if (registered_) Pump::Unregister(this);
}

double EmbedIdentity::Now() const { return options_.clock ? options_.clock() : Clock::NowMs(); }

std::string EmbedIdentity::ApiBase() const { return ApiBaseFromEnvironment(options_.apiBase); }

void EmbedIdentity::Post(const char* path, Json body, const std::string& bearer,
                         std::function<void(Answer)> handler) {
  const std::string base = ApiBase();
  const std::optional<ParsedUrl> parsed = ParseUrl(base);
  if (!parsed || (parsed->scheme != "http" && parsed->scheme != "https")) {
    Log(LogLevel::Warning, std::string("genex identity: the API base is not an http(s) URL; nothing sent to ") + path);
    Answer answer;
    answer.error = identity_detail::Local("bad API URL");
    handler(std::move(answer));
    return;
  }
  HttpRequest request;
  request.method = "POST";
  request.url = base + path;
  request.headers.push_back(HttpHeader{"Content-Type", "application/json"});
  request.headers.push_back(HttpHeader{"Accept", "application/json"});
  // No Origin, ever (§6b): every credential travels in the body or as this bearer.
  if (!bearer.empty()) request.headers.push_back(HttpHeader{"Authorization", "Bearer " + bearer});
  request.body = body.Dump();
  Log(LogLevel::Debug, std::string("genex identity: POST ") + path);

  const std::weak_ptr<int> alive = alive_;
  const std::string where(path);
  http_->Send(std::move(request), [alive, where, onAnswer = std::move(handler)](HttpResponse response) {
    if (alive.expired()) return;
    Answer answer;
    if (!response.transportError.empty()) {
      answer.error.status = 0;
      answer.error.message = identity_detail::Clip(response.transportError);
    } else if (response.status >= 200 && response.status < 300) {
      std::optional<Json> json;
      if (response.body.size() > identity_limits::kMaxAnswerBytes) {
        answer.error = identity_detail::Local("answer too large");
      } else if (!(json = Json::Parse(response.body, nullptr, identity_detail::AnswerLimits()))) {
        answer.error = identity_detail::Local("non-JSON response");
      } else if (!json->IsObject()) {
        answer.error = identity_detail::Local("answer is not a JSON object");
      } else {
        answer.ok = true;
        answer.json = std::move(*json);
      }
    } else {
      answer.error.status = response.status;
      std::optional<Json> json;
      if (response.body.size() <= identity_limits::kMaxAnswerBytes) {
        json = Json::Parse(response.body, nullptr, identity_detail::AnswerLimits());
      }
      std::string code;
      if (json && json->IsObject()) {
        code = identity_detail::StringField(*json, "error");
        if (code.empty()) code = identity_detail::StringField(*json, "status");
        answer.json = std::move(*json);
      }
      if (code.empty()) code = response.body;
      answer.error.message = identity_detail::Clip(code);
      if (answer.error.message.empty()) answer.error.message = "HTTP " + std::to_string(response.status);
    }
    if (!answer.ok) {
      // The status only: an answer body is the server's text, and is never logged.
      Log(LogLevel::Info, "genex identity: " + where + " failed (" + std::to_string(answer.error.status) + ")");
    }
    onAnswer(std::move(answer));
  });
}

bool EmbedIdentity::Adopt(const Json& answer, bool guest, IdentityError* error) {
  const Json* token = answer.Find("embedToken");
  if (!identity_detail::IsCredentialText(token)) {
    if (error != nullptr) *error = identity_detail::Local("the answer carried no usable embedToken");
    return false;
  }
  token_ = token->AsString();
  mintedAtMs_ = Now();
  ++generation_;
  isGuest_ = guest;
  const Json* user = answer.Find("user");
  user_ = user != nullptr && user->IsObject() ? *user : Json::MakeObject();
  const Json* project = answer.Find("project");
  project_ = project != nullptr && project->IsObject() ? *project : Json();
  const Json* colyseus = answer.Find("colyseus");
  if (colyseus != nullptr && colyseus->IsObject()) {
    SignInUrls urls = ColyseusUrls(answer);
    if (!urls.relay.empty()) relayUrls_ = std::move(urls.relay);
    authorityUrls_ = std::move(urls.authority);
    authorityRegions_ = std::move(urls.authorityRegions);
    authorityHome_ = std::move(urls.authorityHome);
  }
  return true;
}

void EmbedIdentity::SignInWith(const char* path, Json body, bool guest, IdentityCallback done) {
  Post(path, std::move(body), std::string(), [this, guest, callback = std::move(done)](Answer answer) {
    IdentityError error = answer.error;
    const bool ok = answer.ok && Adopt(answer.json, guest, &error);
    // Copies: either callback may destroy this identity.
    const std::function<void()> changed = ok ? onTokenChanged : std::function<void()>();
    const IdentityCallback finish = callback;
    if (changed) changed();
    if (finish) finish(ok, ok ? IdentityError() : error);
  });
}

void EmbedIdentity::SignInAsGuest(IdentityCallback done) {
  Json body = Json::MakeObject();
  body.Set("slug", options_.slug);
  SignInWith("/api/embed/guest-session", std::move(body), true, std::move(done));
}

void EmbedIdentity::SignInAsPreviewGuest(IdentityCallback done) {
  Json body = Json::MakeObject();
  body.Set("slug", options_.slug);
  body.Set("probe", true);
  body.Set("channel", "staging");
  SignInWith("/api/embed/guest-session", std::move(body), true, std::move(done));
}

bool EmbedIdentity::SignInFromLauncher(IdentityCallback done) {
  std::optional<std::string> ticket = TakeLaunchTicket();
  if (!ticket) return false;
  RedeemTicket(std::move(*ticket), std::move(done));
  return true;
}

void EmbedIdentity::RedeemTicket(std::string ticket, IdentityCallback done) {
  if (ticket.empty()) {
    if (done) done(false, identity_detail::Local("no ticket"));
    return;
  }
  Json body = Json::MakeObject();
  body.Set("ticket", std::move(ticket));
  SignInWith("/api/embed/session", std::move(body), false, std::move(done));
}

// ---- door 3 ----

void EmbedIdentity::StartDeviceSignIn(DeviceStartCallback done) {
  // Ending a running wait calls its callback here, and that callback may destroy the identity.
  const std::weak_ptr<int> alive = alive_;
  CancelDeviceSignIn();
  if (alive.expired()) return;
  const unsigned generation = deviceGeneration_;
  Json body = Json::MakeObject();
  body.Set("slug", options_.slug);
  Post("/api/embed/device", std::move(body), std::string(), [this, generation, callback = std::move(done)](Answer answer) {
    const DeviceStartCallback finish = callback;
    DeviceCodeInfo info;
    if (generation != deviceGeneration_) {
      if (finish) finish(false, info, identity_detail::Local("cancelled"));
      return;
    }
    if (!answer.ok) {
      if (finish) finish(false, info, answer.error);
      return;
    }
    const Json& v = answer.json;
    const Json* code = v.Find("deviceCode");
    if (!identity_detail::IsCredentialText(code)) {
      if (finish) finish(false, info, identity_detail::Local("the answer carried no usable deviceCode"));
      return;
    }
    info.userCode = identity_detail::StringField(v, "userCode");
    info.verificationUri = identity_detail::StringField(v, "verificationUri");
    info.verificationUriComplete = identity_detail::StringField(v, "verificationUriComplete");
    info.expiresInS = identity_detail::ExpiresIn(v.Find("expiresIn"));
    info.intervalS = identity_detail::Interval(v.Find("interval"), identity_limits::kDeviceIntervalS);
    const Json* project = v.Find("project");
    if (project != nullptr && project->IsObject()) info.project = *project;
    Device device;
    device.code = code->AsString();
    device.info = info;
    device.deadlineMs = Now() + info.expiresInS * 1000.0;
    device_ = std::move(device);
    if (finish) finish(true, info, IdentityError());
  });
}

void EmbedIdentity::PollDeviceSignIn(DevicePollCallback done) {
  if (!device_) {
    if (done) done(DevicePollStatus::Failed, identity_detail::Local("no device sign-in"));
    return;
  }
  const unsigned generation = deviceGeneration_;
  Json body = Json::MakeObject();
  body.Set("deviceCode", device_->code);
  Post("/api/embed/device/token", std::move(body), std::string(), [this, generation, callback = std::move(done)](Answer answer) {
    const DevicePollCallback finish = callback;
    if (generation != deviceGeneration_ || !device_) {
      if (finish) finish(DevicePollStatus::Failed, identity_detail::Local("cancelled"));
      return;
    }
    DevicePollStatus status = DevicePollStatus::Failed;
    IdentityError error = answer.error;
    std::function<void()> changed;
    if (answer.error.status == 410) {
      device_.reset();
      status = DevicePollStatus::Expired;
    } else if (answer.ok) {
      const std::string state = identity_detail::StringField(answer.json, "status");
      if (state == "approved") {
        device_.reset();
        if (Adopt(answer.json, false, &error)) {
          status = DevicePollStatus::Approved;
          changed = onTokenChanged;
        }
      } else if (state == "denied") {
        device_.reset();
        status = DevicePollStatus::Denied;
      } else if (state == "expired") {
        device_.reset();
        status = DevicePollStatus::Expired;
      } else {
        status = DevicePollStatus::Pending;
        device_->info.intervalS = identity_detail::Interval(answer.json.Find("interval"), device_->info.intervalS);
      }
    }
    if (status != DevicePollStatus::Failed) error = IdentityError();
    if (changed) changed();
    if (finish) finish(status, error);
  });
}

void EmbedIdentity::WaitForDeviceSignIn(DevicePollCallback done) {
  if (waiting_) {
    // The ended wait's callback may destroy the identity.
    const std::weak_ptr<int> alive = alive_;
    FinishWait(DevicePollStatus::Failed, identity_detail::Local("cancelled"));
    if (alive.expired()) return;
  }
  if (!device_) {
    if (done) done(DevicePollStatus::Failed, identity_detail::Local("no device sign-in"));
    return;
  }
  waitDone_ = std::move(done);
  waiting_ = true;
  waitPollInFlight_ = false;
  nextPollAtMs_ = Now() + device_->info.intervalS * 1000.0;
  SetWaiting(true);
}

void EmbedIdentity::Update(double /*nowMs*/) {
  // The identity's own clock drives the wait (the pump's `nowMs` is the same clock in a game).
  if (!waiting_ || waitPollInFlight_) return;
  if (!device_) {
    FinishWait(DevicePollStatus::Failed, identity_detail::Local("no device sign-in"));
    return;
  }
  const double now = Now();
  if (now >= device_->deadlineMs) {
    device_.reset();
    ++deviceGeneration_;
    FinishWait(DevicePollStatus::Expired, identity_detail::Local("the device code expired"));
    return;
  }
  if (now < nextPollAtMs_) return;
  waitPollInFlight_ = true;
  const std::weak_ptr<int> alive = alive_;
  PollDeviceSignIn([this, alive](DevicePollStatus status, const IdentityError& error) {
    if (alive.expired()) return;
    waitPollInFlight_ = false;
    if (!waiting_) return;
    if (status == DevicePollStatus::Approved || status == DevicePollStatus::Denied ||
        status == DevicePollStatus::Expired || !device_) {
      FinishWait(status, error);
      return;
    }
    // Pending, or a failed poll (transient: Godot keeps polling): wait another interval.
    nextPollAtMs_ = Now() + device_->info.intervalS * 1000.0;
  });
}

void EmbedIdentity::CancelDeviceSignIn() {
  const bool had = device_.has_value();
  device_.reset();
  if (had || waiting_) ++deviceGeneration_;
  if (waiting_) {
    waitPollInFlight_ = false;
    FinishWait(DevicePollStatus::Failed, identity_detail::Local("cancelled"));
  }
}

void EmbedIdentity::FinishWait(DevicePollStatus status, const IdentityError& error) {
  waiting_ = false;
  SetWaiting(false);
  DevicePollCallback finish = std::move(waitDone_);
  waitDone_ = DevicePollCallback();
  if (finish) finish(status, error);
}

void EmbedIdentity::SetWaiting(bool waiting) {
  if (waiting && !registered_) {
    registered_ = true;
    Pump::Register(this);
  } else if (!waiting && registered_) {
    registered_ = false;
    Pump::Unregister(this);
  }
}

// ---- refresh and the token ----

void EmbedIdentity::Refresh(IdentityCallback done) {
  if (token_.empty()) {
    if (done) done(false, identity_detail::Local("no token to refresh"));
    return;
  }
  refreshWaiters_.push_back(std::move(done));
  if (refreshing_) return;
  refreshing_ = true;
  const unsigned generation = generation_;
  Post("/api/embed/session/refresh", Json::MakeObject(), token_, [this, generation](Answer answer) {
    refreshing_ = false;
    std::vector<IdentityCallback> waiters;
    waiters.swap(refreshWaiters_);
    bool ok = false;
    IdentityError error = answer.error;
    std::function<void()> signal;
    if (generation != generation_) {
      // A door or a sign-out replaced the token this refresh rolled: its answer is stale.
      ok = !token_.empty();
      error = ok ? IdentityError() : identity_detail::Local("signed out");
    } else if (answer.ok) {
      const Json* token = answer.json.Find("embedToken");
      if (identity_detail::IsCredentialText(token)) {
        token_ = token->AsString();
        mintedAtMs_ = Now();
        ++generation_;
        ok = true;
        error = IdentityError();
        signal = onTokenChanged;
      } else {
        error = identity_detail::Local("the refresh answer carried no usable embedToken");
      }
    } else if (answer.error.status == 401) {
      // The identity is over (Godot: session_expired). Start again with a door.
      token_.clear();
      ++generation_;
      signal = onSessionExpired;
    }
    // Copies above: any callback may destroy this identity.
    if (signal) signal();
    for (const IdentityCallback& waiter : waiters) {
      if (waiter) waiter(ok, error);
    }
  });
}

void EmbedIdentity::GetToken(TokenCallback done) {
  if (!done) return;
  if (token_.empty()) {
    done(false, std::string(), identity_detail::Local("sign in first (ticket, guest or device code)"));
    return;
  }
  if (Now() - mintedAtMs_ < identity_limits::kRefreshAfterMs) {
    const std::string token = token_;
    done(true, token, IdentityError());
    return;
  }
  const std::weak_ptr<int> alive = alive_;
  Refresh([this, alive, callback = std::move(done)](bool ok, const IdentityError& error) {
    const TokenCallback finish = callback;
    if (alive.expired()) {
      finish(false, std::string(), identity_detail::Local("identity destroyed"));
      return;
    }
    // Rust token(): a 503 on refresh keeps the current token while it is still valid.
    const bool keep = !ok && error.status == 503 && !token_.empty() &&
                      Now() - mintedAtMs_ < identity_limits::kTokenLifetimeMs - identity_limits::kExpiryMarginMs;
    if (ok || keep) {
      const std::string token = token_;
      finish(true, token, IdentityError());
    } else {
      finish(false, std::string(), error);
    }
  });
}

TokenProvider EmbedIdentity::Provider() {
  const std::weak_ptr<int> alive = alive_;
  EmbedIdentity* self = this;
  return [alive, self](TokenCallback done) {
    if (alive.expired()) {
      if (done) done(false, std::string(), identity_detail::Local("identity destroyed"));
      return;
    }
    self->GetToken(std::move(done));
  };
}

void EmbedIdentity::SignOut() {
  token_.clear();
  ++generation_;
  isGuest_ = false;
  relayUrls_.clear();
  authorityUrls_.clear();
  authorityRegions_.clear();
  authorityHome_.clear();
  user_ = Json::MakeObject();
  project_ = Json();
}

// ---- join options ----

void RequestJoinOptions(RoomProtocol room, const JoinSpec& spec, std::string_view url,
                        const TokenProvider& provider, JoinOptionsCallback done) {
  if (!done) return;
  std::string why;
  if (!BuildJoinOptions(room, spec, std::string_view(), &why)) {
    done(std::nullopt, identity_detail::Local(why.c_str()));
    return;
  }
  if (!provider) {
    const std::string_view token =
        room == RoomProtocol::Authority && IsLoopbackUrl(url) ? std::string_view(kLocalAuthorityToken) : std::string_view();
    done(BuildJoinOptions(room, spec, token), IdentityError());
    return;
  }
  // A fresh token for this attempt (§3.2): never cached here.
  provider([room, spec, done](bool ok, const std::string& token, const IdentityError& error) {
    if (!ok) {
      done(std::nullopt, error);
      return;
    }
    done(BuildJoinOptions(room, spec, token), IdentityError());
  });
}

}  // namespace genex
