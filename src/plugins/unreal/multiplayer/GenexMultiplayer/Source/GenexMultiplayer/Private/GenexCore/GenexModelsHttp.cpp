// The model calls of a native build over HTTPS: a port of packages/embed-sdk/src/generation.ts's
// calls under a standing budget, with the rules of packages/embed-protocol/src/runtime-generation.ts
// they read. See GenexCore/GenexModelsHttp.h.
#include "GenexCore/GenexModelsHttp.h"

#include "GenexCore/GenexClock.h"
#include "GenexCore/GenexLog.h"
#include "GenexCore/GenexUrl.h"

#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <random>
#include <utility>

namespace genex::models_http_detail {

constexpr std::string_view kRuntimePath = "/api/runtime";
/** embed-sdk's own code for "this could not be asked at all", and the two a door of its own falls back to. */
constexpr std::string_view kUnavailable = "generation_unavailable";
constexpr std::string_view kJudgeUnavailable = "judge_unavailable";
constexpr std::string_view kGrantUnavailable = "grant_unavailable";
constexpr std::string_view kInvalidRequest = "invalid_request";
constexpr std::string_view kNoPlayerSession = "no_player_session";
constexpr std::string_view kWaitTimeout = "wait_timeout";
constexpr std::string_view kStreamAborted = "stream_aborted";
/** A practice key's port (one a helper binds without privileges) and its token's length. */
constexpr int kPracticePortMin = 1024;
constexpr int kPracticePortMax = 65535;
constexpr std::size_t kPracticeTokenChars = 32;

/** The sentence a player reads when the game asks for a budget they have not approved. */
constexpr std::string_view kBudgetNotApprovedMessage = "Set an AI budget for this game on its Genex page, then start the game again.";

/** A ceiling's upper bound (the SDK's validEstimateCoins), and JavaScript's largest safe integer. */
constexpr double kMaxCredits = 1000000.0;
constexpr double kMaxSafeInteger = 9007199254740991.0;
/** A judge call: its questions, a question's name, its server wait, an idempotency key. */
constexpr std::size_t kMaxJudgeQuestions = 64;
constexpr std::size_t kMaxJudgeNameChars = 64;
constexpr double kMinJudgeTimeoutMs = 1000.0;
constexpr double kMaxJudgeTimeoutMs = 20000.0;
constexpr std::size_t kMinKeyChars = 8;
constexpr std::size_t kMaxKeyChars = 100;
/** An id as the API mints it (isGenerationId): 1 to 128 of [A-Za-z0-9_-]. */
constexpr std::size_t kMaxIdChars = 128;
/** A token longer than this is no token (GenexIdentity's own bound). */
constexpr std::size_t kMaxTokenBytes = 8 * 1024;

/** The fields that make a call more than one block of text (the SDK's RICH_FIELDS). */
constexpr std::string_view kRichFields[] = {"system", "messages", "temperature", "topP", "stop", "seed", "reasoningEffort", "cacheSystem"};
/** The fixed words a folded conversation is written with (foldRuntimeConversation). */
constexpr std::string_view kFoldInstructions = "Instructions:\n";
constexpr std::string_view kFoldRequest = "Request:\n";
constexpr std::string_view kFoldConversation = "Conversation:\n";
constexpr std::string_view kFoldClosing = "Answer the last User message as the Assistant.";
constexpr std::string_view kFoldGap = "\n\n";
constexpr std::string_view kFoldUser = "User: ";
constexpr std::string_view kFoldAssistant = "Assistant: ";
constexpr std::string_view kRoleUser = "user";
constexpr std::string_view kRoleAssistant = "assistant";

/** The calls a page's bridge has and this build does not: voice (no microphone, no speaker) and the room lends. */
constexpr std::string_view kPageOnlyCalls[] = {
    "voiceCatalog", "voiceRecordStart", "voiceRecordCancel", "voiceRecordStopAndTranscribe", "speakerCreate",        "speakerSay",
    "speakerFeed",  "speakerEnd",       "speakerStop",       "speakerDispose",               "lendSpendGrantToRoom", "returnSpendGrantFromRoom",
};

bool IsAsciiLetter(char c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'); }
bool IsAsciiAlnum(char c) { return IsAsciiLetter(c) || (c >= '0' && c <= '9'); }

/** isGenerationId (and isGrantId, which is the same rule). */
bool IsId(std::string_view text) {
  if (text.empty() || text.size() > kMaxIdChars) return false;
  for (const char c : text) {
    if (!IsAsciiAlnum(c) && c != '_' && c != '-') return false;
  }
  return true;
}

bool IsId(const Json* value) { return value != nullptr && value->IsString() && IsId(std::string_view(value->AsString())); }

/** encodeURIComponent: everything but its unreserved characters as %XX. */
std::string EncodeSegment(std::string_view text) {
  static const char kHex[] = "0123456789ABCDEF";
  static constexpr std::string_view kUnreserved = "-_.!~*'()";
  std::string out;
  for (const char c : text) {
    if (IsAsciiAlnum(c) || kUnreserved.find(c) != std::string_view::npos) {
      out.push_back(c);
      continue;
    }
    const unsigned char b = static_cast<unsigned char>(c);
    out.push_back('%');
    out.push_back(kHex[b >> 4]);
    out.push_back(kHex[b & 0x0f]);
  }
  return out;
}

/** Number.isSafeInteger. */
bool IsSafeInteger(const Json* value) {
  if (value == nullptr || !value->IsNumber()) return false;
  const double n = value->AsNumber();
  return std::isfinite(n) && std::floor(n) == n && std::fabs(n) <= kMaxSafeInteger;
}

/** The SDK's validCount: a whole number from `least` to `most`. */
bool IsCount(const Json* value, double least, double most) { return IsSafeInteger(value) && value->AsNumber() >= least && value->AsNumber() <= most; }

/** Whether JavaScript reads a value as true (`view.error ? … : …`); an absent one is not. */
bool Truthy(const Json* value) {
  if (value == nullptr) return false;
  switch (value->GetType()) {
    case Json::Type::Null: return false;
    case Json::Type::Bool: return value->AsBool();
    case Json::Type::Number: return value->AsNumber() != 0.0 && !std::isnan(value->AsNumber());
    case Json::Type::String: return !value->AsString().empty();
    case Json::Type::Array:
    case Json::Type::Object: return true;
  }
  return false;
}

/** Whether a field is a string with exactly this text. */
bool IsText(const Json* value, std::string_view text) { return value != nullptr && value->IsString() && value->AsString() == text; }

/** A string's length as JavaScript counts it (UTF-16 units), for valid UTF-8. */
std::size_t Utf16Length(std::string_view text) {
  std::size_t units = 0;
  for (const char c : text) {
    const unsigned char b = static_cast<unsigned char>(c);
    if ((b & 0xC0) == 0x80) continue;
    units += b >= 0xF0 ? 2 : 1;
  }
  return units;
}

/** Whether a code point is one String.prototype.trim removes (WhiteSpace and LineTerminator). */
bool IsJsSpace(std::uint32_t c) {
  if ((c >= 0x09 && c <= 0x0D) || c == 0x20 || c == 0xA0 || c == 0x1680) return true;
  if (c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000 || c == 0xFEFF) return true;
  return c >= 0x2000 && c <= 0x200A;
}

/** `!text.trim()`: nothing in it but what trim removes. The text is valid UTF-8 (it was parsed as JSON). */
bool IsBlank(std::string_view text) {
  std::size_t i = 0;
  while (i < text.size()) {
    const unsigned char lead = static_cast<unsigned char>(text[i]);
    std::size_t extra = 0;
    std::uint32_t code = lead;
    if (lead >= 0xF0) {
      extra = 3;
      code = lead & 0x07u;
    } else if (lead >= 0xE0) {
      extra = 2;
      code = lead & 0x0Fu;
    } else if (lead >= 0xC0) {
      extra = 1;
      code = lead & 0x1Fu;
    }
    if (i + extra >= text.size() && extra > 0) return false;
    for (std::size_t k = 1; k <= extra; ++k) code = (code << 6) | (static_cast<unsigned char>(text[i + k]) & 0x3Fu);
    if (!IsJsSpace(code)) return false;
    i += extra + 1;
  }
  return true;
}

/** One turn of a conversation the model reads. */
struct Turn {
  bool user = true;
  std::string content;
};

/** The SDK's runtimeTurns: `messages`, then `prompt` (when it is not empty) as the last user turn. Entries that
 *  are no turn are skipped: ConversationError refuses them before anything is folded. */
std::vector<Turn> Turns(const Json& body, std::string_view prompt) {
  std::vector<Turn> turns;
  const Json* messages = body.Find("messages");
  if (messages != nullptr && messages->IsArray()) {
    for (const Json& entry : messages->Items()) {
      const Json* role = entry.Find("role");
      const Json* content = entry.Find("content");
      if (role == nullptr || content == nullptr || !content->IsString()) continue;
      turns.push_back(Turn{!IsText(role, kRoleAssistant), content->AsString()});
    }
  }
  if (!prompt.empty()) turns.push_back(Turn{true, std::string(prompt)});
  return turns;
}

/** Whether one entry of `messages` is a turn: exactly a `role` of user or assistant and a `content` that says
 *  something. */
bool IsTurn(const Json& entry) {
  if (!entry.IsObject() || entry.Size() != 2) return false;
  const Json* role = entry.Find("role");
  const Json* content = entry.Find("content");
  const bool known = IsText(role, kRoleUser) || IsText(role, kRoleAssistant);
  return known && content != nullptr && content->IsString() && !IsBlank(content->AsString());
}

bool HasRichFields(const Json& body) {
  for (const std::string_view key : kRichFields) {
    if (body.Contains(key)) return true;
  }
  return false;
}

/** The SDK's wireBody for a stand that takes no conversation: one folded prompt, the rich fields dropped. */
Json Folded(Json body) {
  std::string prompt = models::FoldConversation(body);
  for (const std::string_view key : kRichFields) body.Erase(key);
  body.Set("prompt", std::move(prompt));
  return body;
}

/** The SDK's ceilingField: the body field of a call's ceiling, or the code it is refused with. */
struct Ceiling {
  std::string error;
  const char* key = "maxCredits";
  double value = 0.0;
};

Ceiling CeilingOf(const Json& options) {
  Ceiling out;
  const Json* credits = options.Find("maxCredits");
  const Json* coins = options.Find("estimateCoins");
  const bool differ = credits != nullptr && coins != nullptr && credits->AsNumber() != coins->AsNumber();
  if (credits != nullptr && !IsCount(credits, 0.0, kMaxCredits)) {
    out.error = "invalid_max_credits";
  } else if (coins != nullptr && !IsCount(coins, 0.0, kMaxCredits)) {
    out.error = "invalid_estimate_coins";
  } else if ((credits == nullptr && coins == nullptr) || differ) {
    out.error = "invalid_max_credits";
  } else if (credits != nullptr) {
    out.value = credits->AsNumber();
  } else {
    out.key = "estimateCoins";
    out.value = coins->AsNumber();
  }
  return out;
}

bool IsTerminal(const Json* status) {
  static constexpr std::string_view kTerminal[] = {"succeeded", "failed", "unknown", "canceled", "expired"};
  if (status == nullptr || !status->IsString()) return false;
  for (const std::string_view name : kTerminal) {
    if (status->AsString() == name) return true;
  }
  return false;
}

/** Copy `key` from a view into a result when the view has it (`view.x !== undefined`). */
void CopyField(const Json& view, Json& result, std::string_view key, std::string_view as = std::string_view()) {
  if (const Json* value = view.Find(key)) result.Set(as.empty() ? key : as, *value);
}

/** Copy `key` when JavaScript reads it as true (`view.error ? { error } : {}`). */
void CopyTruthy(const Json& view, Json& result, std::string_view key) {
  const Json* value = view.Find(key);
  if (Truthy(value)) result.Set(key, *value);
}

/** The SDK's `outcome` (with `billingReceipt`): a call's end, or nothing while it still runs. */
std::optional<Json> Outcome(const Json& view) {
  static constexpr std::string_view kReceipt[] = {
      "billingStatus", "currency", "maxCredits", "reservedCredits", "chargedCredits", "reservedCoins", "reservedDisplayUsdCents", "chargedCoins", "chargedDisplayUsdCents",
  };
  const Json* status = view.Find("status");
  if (!IsTerminal(status)) return std::nullopt;
  Json result = Json::MakeObject();
  result.Set("status", *status);
  CopyField(view, result, "id", "generationId");
  for (const std::string_view key : kReceipt) CopyField(view, result, key);
  if (status->AsString() == "succeeded") {
    CopyField(view, result, "output");
    CopyField(view, result, "source");
    CopyTruthy(view, result, "modelProvenance");
  }
  CopyTruthy(view, result, "error");
  CopyTruthy(view, result, "contentBlocked");
  return result;
}

/** The SDK's `judgeOutcome`: a judgment's end as its generation's view shows it. */
std::optional<Json> JudgeOutcome(const Json& view) {
  const Json* status = view.Find("status");
  if (!IsTerminal(status)) return std::nullopt;
  Json result = Json::MakeObject();
  result.Set("status", status->AsString() == "expired" ? Json("failed") : *status);
  CopyField(view, result, "id", "generationId");
  if (status->AsString() == "succeeded") CopyField(view, result, "output", "answers");
  CopyTruthy(view, result, "error");
  return result;
}

/** The SDK's `grantOutcome`: what asking for a budget answers for a budget's view, or nothing while it awaits the
 *  player's answer. */
std::optional<Json> GrantOutcome(const Json& view) {
  static constexpr std::string_view kLive[] = {"active", "suspended_insufficient_funds", "waiting_for_plan"};
  const Json* status = view.Find("status");
  if (status == nullptr || !status->IsString()) return std::nullopt;
  const std::string& name = status->AsString();
  std::string_view answer;
  for (const std::string_view live : kLive) {
    if (name == live) answer = "active";
  }
  if (name == "stopped") answer = "canceled";
  if (name == "expired") answer = "expired";
  if (name == "exhausted") answer = "failed";
  if (answer.empty()) return std::nullopt;
  Json result = Json::MakeObject();
  result.Set("status", answer);
  CopyField(view, result, "id", "grantId");
  result.Set("grant", view);
  if (name == "exhausted") result.Set("error", "grant_limit_reached");
  return result;
}

/** A judge question's name: a letter, then letters, digits and `_`, 64 at most. */
bool IsQuestionName(const std::string& name) {
  if (name.empty() || name.size() > kMaxJudgeNameChars || !IsAsciiLetter(name[0])) return false;
  for (const char c : name) {
    if (!IsAsciiAlnum(c) && c != '_') return false;
  }
  return true;
}

/** Whether `questions` is one to 64 named questions of a known type. */
bool AreQuestions(const Json* questions) {
  if (questions == nullptr || !questions->IsObject()) return false;
  if (questions->Size() < 1 || questions->Size() > kMaxJudgeQuestions) return false;
  for (const JsonMember& question : questions->Members()) {
    if (!IsQuestionName(question.key)) return false;
  }
  for (const JsonMember& question : questions->Members()) {
    const Json* type = question.value.Find("type");
    if (!IsText(type, "choice") && !IsText(type, "score") && !IsText(type, "noul")) return false;
  }
  return true;
}

/** The SDK's invalidJudgeOptions: the code a judge call is refused with before the network, or empty. */
std::string InvalidJudgeOptions(const Json& options) {
  const Json* grantId = options.Find("grantId");
  if (grantId == nullptr || grantId->IsNull()) return "judge_requires_grant";
  if (!IsId(grantId)) return "invalid_grant_id";
  if (!options.Contains("state") || !AreQuestions(options.Find("questions"))) return std::string(kInvalidRequest);
  const Json* timeout = options.Find("timeoutMs");
  if (timeout != nullptr && !IsCount(timeout, kMinJudgeTimeoutMs, kMaxJudgeTimeoutMs)) return "invalid_timeout";
  const Json* key = options.Find("idempotencyKey");
  if (key != nullptr) {
    const std::size_t length = key->IsString() ? Utf16Length(key->AsString()) : 0;
    if (length < kMinKeyChars || length > kMaxKeyChars) return "invalid_idempotency_key";
  }
  return std::string();
}

/** A token fit for an Authorization header: printable ASCII with no space, bounded (a CR/LF would split the
 *  header). */
bool IsHeaderToken(const std::string& token) {
  if (token.empty() || token.size() > kMaxTokenBytes) return false;
  for (const char c : token) {
    const unsigned char b = static_cast<unsigned char>(c);
    if (b < 0x21 || b > 0x7e) return false;
  }
  return true;
}

/** A random UUID (version 4) as text: 36 of [0-9a-f-], what the SDK's crypto.randomUUID() gives a call with no
 *  key. A key separates one call from the next; it is no secret. */
std::string RandomUuid() {
  static std::mt19937_64 generator([] {
    const std::uint64_t steady = static_cast<std::uint64_t>(std::chrono::steady_clock::now().time_since_epoch().count());
    const std::uint64_t wall = static_cast<std::uint64_t>(std::chrono::system_clock::now().time_since_epoch().count());
    std::seed_seq seed{static_cast<std::uint32_t>(steady), static_cast<std::uint32_t>(steady >> 32), static_cast<std::uint32_t>(wall),
                       static_cast<std::uint32_t>(wall >> 32)};
    return std::mt19937_64(seed);
  }());
  static const char kHex[] = "0123456789abcdef";
  const std::uint64_t bits[2] = {generator(), generator()};
  std::string out;
  for (int i = 0; i < 32; ++i) {
    if (i == 8 || i == 12 || i == 16 || i == 20) out.push_back('-');
    unsigned nibble = static_cast<unsigned>((bits[i / 16] >> ((i % 16) * 4)) & 0x0fu);
    if (i == 12) nibble = 4u;
    if (i == 16) nibble = 8u | (nibble & 0x03u);
    out.push_back(kHex[nibble]);
  }
  return out;
}

Json FailedResult(std::string_view code, std::string_view reason = {}, std::string_view at = {}) {
  Json result = Json::MakeObject();
  result.Set("status", "failed");
  result.Set("error", code);
  // Which rule a refusal broke and where, when Genex said (`invalid_schema`): for the game's maker to read.
  if (!reason.empty()) result.Set("reason", reason);
  if (!at.empty()) result.Set("at", at);
  return result;
}

/** The first argument of a call as its options, or nullptr when it is no JSON object. */
const Json* OptionsOf(const Json& args) { return args.At(0).IsObject() ? &args.At(0) : nullptr; }

/** A call's waiting time: the number it gave, else the default. */
double TimeoutOf(const Json* value, double fallback) {
  return value != nullptr && value->IsNumber() && std::isfinite(value->AsNumber()) ? value->AsNumber() : fallback;
}

/** A read's path for its one id, or the code the id is refused with. */
struct IdRoute {
  std::string path;
  bool post = false;
  std::string_view error;
};

IdRoute RouteOf(std::string_view call, const Json& id) {
  IdRoute route;
  const bool generation = call == "getGeneration";
  if (!IsId(&id)) {
    route.error = generation ? "invalid_generation_id" : "invalid_grant_id";
    return route;
  }
  const std::string segment = EncodeSegment(id.AsString());
  route.post = call == "stopSpendGrant";
  route.path = generation ? "/generations/" + segment : "/grants/" + segment + (route.post ? "/stop" : "");
  return route;
}

}  // namespace genex::models_http_detail

namespace genex::models {

std::optional<PracticeTarget> ParsePracticeKey(std::string_view key) {
  namespace detail = models_http_detail;
  const std::size_t dot = key.find('.');
  if (dot == std::string_view::npos) return std::nullopt;
  const std::string_view port = key.substr(0, dot);
  const std::string_view token = key.substr(dot + 1);
  // `^[1-9][0-9]{3,4}$`, then 1024..65535.
  if (port.size() < 4 || port.size() > 5 || port.front() == '0') return std::nullopt;
  int number = 0;
  for (const char c : port) {
    if (c < '0' || c > '9') return std::nullopt;
    number = number * 10 + (c - '0');
  }
  if (number < detail::kPracticePortMin || number > detail::kPracticePortMax) return std::nullopt;
  if (token.size() != detail::kPracticeTokenChars) return std::nullopt;
  for (const char c : token) {
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return std::nullopt;
  }
  PracticeTarget target;
  target.port = number;
  target.token = std::string(token);
  return target;
}

std::optional<PracticeTarget> TakePracticeKey() {
  const std::optional<std::string> key = GetEnv(kPracticeEnv);
  // Removed whatever it held, before anything the game starts can inherit it.
  UnsetEnv(kPracticeEnv);
  if (!key) return std::nullopt;
  return ParsePracticeKey(*key);
}

std::string PracticeOrigin(int port) { return "http://127.0.0.1:" + std::to_string(port); }

HttpBridgeOptions HttpBridgeOptionsForPractice(PracticeTarget target, IHttp* http) {
  HttpBridgeOptions options;
  options.http = http;
  options.practice = true;
  // The helper's own token and address, and nothing of the player's: no Genex credential goes to it.
  options.token = [token = target.token](TokenCallback done) {
    if (done) done(true, token, IdentityError());
  };
  options.apiBase = [origin = PracticeOrigin(target.port)] { return origin; };
  return options;
}

HttpBridgeOptions HttpBridgeOptionsFor(EmbedIdentity& identity, IHttp* http) {
  EmbedIdentity* self = &identity;
  HttpBridgeOptions options;
  options.http = http;
  options.token = identity.Provider();
  options.apiBase = [self] { return self->ApiBase(); };
  options.slug = [self] { return self->Slug(); };
  options.player = [self] {
    HttpPlayer player;
    player.signedIn = self->HasToken();
    player.guest = self->IsGuest();
    player.user = self->User();
    return player;
  };
  return options;
}

std::string FoldConversation(const Json& body) {
  namespace detail = models_http_detail;
  const Json* instructionField = body.Find("system");
  const std::string instruction = instructionField != nullptr && instructionField->IsString() ? instructionField->AsString() : std::string();
  const Json* promptField = body.Find("prompt");
  const std::string_view prompt = promptField != nullptr && promptField->IsString() ? std::string_view(promptField->AsString()) : std::string_view();
  const std::vector<detail::Turn> turns = detail::Turns(body, prompt);
  if (instruction.empty() && turns.size() <= 1) return turns.empty() ? std::string() : turns[0].content;
  std::string out;
  const auto part = [&out](std::string_view head, std::string_view text) {
    if (!out.empty()) out.append(detail::kFoldGap);
    out.append(head);
    out.append(text);
  };
  if (!instruction.empty()) part(detail::kFoldInstructions, instruction);
  if (turns.size() == 1) part(detail::kFoldRequest, turns[0].content);
  if (turns.size() > 1) {
    std::string spoken;
    for (const detail::Turn& turn : turns) {
      if (!spoken.empty()) spoken.append(detail::kFoldGap);
      spoken.append(turn.user ? detail::kFoldUser : detail::kFoldAssistant);
      spoken.append(turn.content);
    }
    part(detail::kFoldConversation, spoken);
    part(detail::kFoldClosing, std::string_view());
  }
  return out;
}

std::string ConversationError(const Json& body) {
  namespace detail = models_http_detail;
  const Json* instruction = body.Find("system");
  if (instruction != nullptr && (!instruction->IsString() || detail::IsBlank(instruction->AsString()))) return std::string(detail::kInvalidRequest);
  const Json* prompt = body.Find("prompt");
  if (prompt != nullptr && !prompt->IsString()) return std::string(detail::kInvalidRequest);
  const Json* messages = body.Find("messages");
  if (messages != nullptr) {
    if (!messages->IsArray() || messages->Size() == 0) return "invalid_messages";
    for (const Json& entry : messages->Items()) {
      if (!detail::IsTurn(entry)) return "invalid_messages";
    }
  }
  // The prompt counts as a turn only when it says something.
  const bool spoken = prompt != nullptr && !detail::IsBlank(prompt->AsString());
  const std::vector<detail::Turn> turns = detail::Turns(body, spoken ? std::string_view(prompt->AsString()) : std::string_view());
  if (turns.empty()) return std::string(detail::kInvalidRequest);
  bool ordered = turns.front().user && turns.back().user;
  for (std::size_t i = 1; i < turns.size(); ++i) ordered = ordered && turns[i].user != turns[i - 1].user;
  return ordered ? std::string() : std::string("invalid_messages");
}

HttpBridge::HttpBridge(HttpBridgeOptions options) : options_(std::move(options)), alive_(std::make_shared<int>(0)) {
  http_ = options_.http != nullptr ? options_.http : &DefaultHttp();
}

HttpBridge::~HttpBridge() {
  if (registered_) Pump::Unregister(this);
}

bool HttpBridge::Supported() const { return true; }

double HttpBridge::Now() const { return options_.clock ? options_.clock() : Clock::NowMs(); }

std::string HttpBridge::NewKey() const { return options_.idempotencyKey ? options_.idempotencyKey() : models_http_detail::RandomUuid(); }

std::string HttpBridge::GenerationErrorMessage(const std::string* code) const {
  if (code != nullptr && *code == kBudgetNotApproved) return std::string(models_http_detail::kBudgetNotApprovedMessage);
  return NativeErrorMessage(code);
}

// ---- requests ----

void HttpBridge::Request(std::string method, std::string path, std::optional<Json> body, std::string_view fallback, ReplyDone done) {
  namespace detail = models_http_detail;
  const std::weak_ptr<int> alive = alive_;
  const std::string code(fallback);
  // A fresh token for this request, never one kept from the last.
  TokenCallback withToken = [this, alive, verb = std::move(method), route = std::move(path), payload = std::move(body), code,
                             finish = std::move(done)](bool ok, const std::string& token, const IdentityError&) {
    if (alive.expired()) return;
    Reply reply;
    reply.code = code;
    if (!ok || !detail::IsHeaderToken(token)) {
      Log(LogLevel::Debug, "genex models: no player session; nothing sent to " + route);
      reply.noSession = true;
      reply.code = std::string(detail::kNoPlayerSession);
      finish(std::move(reply));
      return;
    }
    const std::string base = options_.apiBase ? ResolveApiBase(options_.apiBase(), std::nullopt) : ApiBaseFromEnvironment(kDefaultApiBase);
    const std::optional<ParsedUrl> parsed = ParseUrl(base);
    if (!parsed || (parsed->scheme != "http" && parsed->scheme != "https")) {
      Log(LogLevel::Warning, "genex models: the API base is not an http(s) URL; nothing sent to " + route);
      finish(std::move(reply));
      return;
    }
    HttpRequest request;
    request.method = verb;
    request.url = base + std::string(detail::kRuntimePath) + route;
    // No Origin, ever: the bearer is the whole credential.
    request.headers.push_back(HttpHeader{"Authorization", "Bearer " + token});
    request.headers.push_back(HttpHeader{"Accept", "application/json"});
    if (payload) {
      request.headers.push_back(HttpHeader{"Content-Type", "application/json"});
      request.body = payload->Dump();
    }
    Log(LogLevel::Debug, "genex models: " + verb + " " + route);
    http_->Send(std::move(request), [alive, verb, route, code, onReply = finish](HttpResponse response) {
      if (alive.expired()) return;
      Reply answer;
      answer.code = code;
      const bool arrived = response.transportError.empty();
      if (arrived) answer.status = response.status;
      std::optional<Json> json = arrived ? Json::Parse(response.body) : std::nullopt;
      if (response.IsSuccess()) {
        // The SDK's `response.json().catch(() => ({}))`.
        answer.ok = true;
        answer.body = json ? std::move(*json) : Json::MakeObject();
      } else {
        const Json* error = json ? json->Find("error") : nullptr;
        if (error != nullptr && error->IsString()) answer.code = error->AsString();
        // Optional, beside the code: which rule broke and where. Kept only in their own shape.
        const Json* reason = json ? json->Find("reason") : nullptr;
        if (reason != nullptr && reason->IsString() && IsRefusalReason(reason->AsString())) answer.reason = reason->AsString();
        const Json* at = json ? json->Find("at") : nullptr;
        if (at != nullptr && at->IsString() && IsRefusalReason(at->AsString())) answer.at = at->AsString();
        // The status only: an answer's body is the server's text, and is never logged.
        Log(LogLevel::Info, "genex models: " + verb + " " + route + " failed (" + std::to_string(answer.status) + ")");
      }
      onReply(std::move(answer));
    });
  };
  if (!options_.token) {
    withToken(false, std::string(), IdentityError());
    return;
  }
  options_.token(std::move(withToken));
}

void HttpBridge::Get(std::string path, std::string_view fallback, ReplyDone done) {
  Request("GET", std::move(path), std::nullopt, fallback, std::move(done));
}

void HttpBridge::Post(std::string path, Json body, std::string_view fallback, ReplyDone done) {
  Request("POST", std::move(path), std::move(body), fallback, std::move(done));
}

// ---- events ----

void HttpBridge::Resolve(int id, std::string_view call, Json result) {
  Json event = Json::MakeObject();
  event.Set("type", "result");
  event.Set("id", id);
  event.Set("call", call);
  event.Set("result", std::move(result));
  queue_.Push(std::move(event));
}

void HttpBridge::Reject(int id, std::string_view call, const Reply& refused) { Reject(id, call, refused.code, refused.status, refused.reason, refused.at); }

void HttpBridge::Reject(int id, std::string_view call, std::string_view code, int httpStatus, std::string_view reason, std::string_view at) {
  // Never lost: a read that failed says why in the log, as a call that failed does (Settle).
  Log(LogLevel::Warning, FailureLogLine(call, code, httpStatus, reason, at, true));
  Json event = Json::MakeObject();
  event.Set("type", "rejected");
  event.Set("id", id);
  event.Set("call", call);
  event.Set("error", code);
  queue_.Push(std::move(event));
}

HttpBridge::Op* HttpBridge::FindOp(int id) {
  const auto found = ops_.find(id);
  return found != ops_.end() ? &found->second : nullptr;
}

void HttpBridge::Settle(int id, Json result, int httpStatus) {
  const auto found = ops_.find(id);
  if (found == ops_.end()) return;
  Op op = std::move(found->second);
  ops_.erase(found);
  SetWaiting();
  // A stream's text arrives whole: one Delta, so a game written for streaming shows it.
  const Json* output = result.Find("output");
  const bool succeeded = models_http_detail::IsText(result.Find("status"), "succeeded");
  if (op.stream && succeeded && output != nullptr && output->IsString() && !output->AsString().empty()) {
    Json delta = Json::MakeObject();
    delta.Set("type", "delta");
    delta.Set("id", id);
    delta.Set("text", *output);
    delta.Set("soFar", *output);
    queue_.Push(std::move(delta));
  }
  // THE CODE IS NEVER LOST. A call that ended with one writes one Warning line: the call, the code, the HTTP status
  // of a refusal, which rule broke when Genex said, and what the game's maker changes. A game that shows only a
  // sentence, or nothing, still leaves why in the log. Nothing of the prompt, the token or an answer's text is in it
  // (FailureLogLine keeps a code only in a code's shape and a reason only in a reason's).
  const Json* error = result.Find("error");
  if (!succeeded && error != nullptr && error->IsString()) {
    const auto said = [&result](std::string_view key) {
      const Json* value = result.Find(key);
      return value != nullptr && value->IsString() ? value->AsString() : std::string();
    };
    Log(LogLevel::Warning, FailureLogLine(op.call, error->AsString(), httpStatus, said("reason"), said("at")));
  }
  Resolve(id, op.call, std::move(result));
}

void HttpBridge::Fail(int id, std::string_view code) { Settle(id, models_http_detail::FailedResult(code)); }

void HttpBridge::Fail(int id, const Reply& refused) {
  Settle(id, models_http_detail::FailedResult(refused.code, refused.reason, refused.at), refused.status);
}

int HttpBridge::Pending() {
  Advance();
  return static_cast<int>(queue_.Size());
}

std::string HttpBridge::DrainEventsJson() {
  std::string text = queue_.Dump();
  queue_ = Json::MakeArray();
  return text;
}

bool HttpBridge::Cancel(int request) {
  const Op* op = FindOp(request);
  if (op == nullptr || !op->stream) return false;
  // The waiting stops; the call itself goes on and is charged as usual (the SDK's `signal`).
  Json result = Json::MakeObject();
  result.Set("status", "pending");
  if (!op->generationId.empty()) result.Set("generationId", op->generationId);
  result.Set("error", models_http_detail::kStreamAborted);
  Settle(request, std::move(result));
  return true;
}

// ---- calls ----

int HttpBridge::Call(std::string_view method, std::string_view argsJson) {
  namespace detail = models_http_detail;
  const int id = ++next_;
  const std::string call(method);
  for (const std::string_view pageOnly : detail::kPageOnlyCalls) {
    if (method != pageOnly) continue;
    Reject(id, call, kNativeUnsupported);
    return id;
  }
  std::optional<Json> parsed = argsJson.empty() ? std::optional<Json>(Json::MakeArray()) : Json::Parse(argsJson);
  const bool settles = method == "generate" || method == "generateStream" || method == "judge" || method == "requestSpendGrant" || method == "waitForGeneration";
  const bool reads = method == "getGenerationModels" || method == "getActiveSpendGrant" || method == "getSpendGrant" || method == "stopSpendGrant" || method == "getGeneration";
  const bool known = settles || reads || method == "init";
  if (!known || !parsed || !parsed->IsArray()) {
    Reject(id, call, detail::kInvalidRequest);
    return id;
  }
  if (method == "init") {
    Init(id, *parsed);
    return id;
  }
  if (settles) {
    Op op;
    op.call = call;
    op.stream = method == "generateStream";
    op.judge = method == "judge";
    ops_.emplace(id, std::move(op));
  }
  // A call made while `init` still settles waits for it, as a page's bridge makes it wait.
  AfterInit([this, id, call, args = std::move(*parsed)] { Start(id, call, args); });
  return id;
}

void HttpBridge::Start(int id, const std::string& call, const Json& args) {
  namespace detail = models_http_detail;
  if (call == "getGenerationModels") return Read(id, call, "/models", false);
  if (call == "getActiveSpendGrant") return ActiveGrant(id);
  if (call == "requestSpendGrant") return RequestGrant(id, args);
  if (call == "generate" || call == "generateStream") return Generate(id, args);
  if (call == "judge") return Judge(id, args);
  if (call == "waitForGeneration") return WaitFor(id, args);
  const detail::IdRoute route = detail::RouteOf(call, args.At(0));
  if (!route.error.empty()) return Reject(id, call, route.error);
  Read(id, call, route.path, route.post);
}

void HttpBridge::AfterInit(std::function<void()> run) {
  if (inits_ > 0) {
    afterInit_.push_back(std::move(run));
    return;
  }
  run();
}

void HttpBridge::Init(int id, const Json& args) {
  const Json* gameId = args.At(0).Find("gameId");
  const std::string slug = options_.slug ? options_.slug() : std::string();
  if (gameId != nullptr && gameId->IsString() && !slug.empty() && gameId->AsString() != slug) {
    Log(LogLevel::Warning, "genex models: init names the game '" + gameId->AsString() + "', but the player signs in to '" + slug + "'");
  }
  inits_ += 1;
  const std::weak_ptr<int> alive = alive_;
  const std::shared_ptr<bool> answered = std::make_shared<bool>(false);
  std::function<void()> finish = [this, alive, answered, id] {
    if (alive.expired() || *answered) return;
    *answered = true;
    const HttpPlayer player = options_.player ? options_.player() : HttpPlayer();
    // A guest's answer may carry no account at all: that reads as no user.
    const bool named = player.signedIn && player.user.IsObject() && player.user.Size() > 0;
    Json result = Json::MakeObject();
    if (options_.practice) {
      // The SDK's local test identity: nobody is signed in while a game is being made.
      Json tester = Json::MakeObject();
      tester.Set("id", "local:test");
      tester.Set("name", "Local Tester");
      result.Set("user", std::move(tester));
      result.Set("guest", true);
      result.Set("shell", "local");
    } else {
      result.Set("user", named ? player.user : Json());
      result.Set("guest", !player.signedIn || player.guest);
      result.Set("shell", "app");
    }
    Resolve(id, "init", std::move(result));
    inits_ -= 1;
    if (inits_ > 0) return;
    std::vector<std::function<void()>> waiting;
    waiting.swap(afterInit_);
    for (const std::function<void()>& run : waiting) run();
  };
  // A practice helper has nobody to sign in.
  if (!options_.beforeInit || options_.practice) {
    finish();
    return;
  }
  options_.beforeInit(std::move(finish));
}

void HttpBridge::Read(int id, const std::string& call, std::string path, bool post) {
  namespace detail = models_http_detail;
  ReplyDone done = [this, id, call](Reply reply) {
    if (reply.ok) return Resolve(id, call, std::move(reply.body));
    Reject(id, call, reply);
  };
  if (post) return Post(std::move(path), Json::MakeObject(), detail::kUnavailable, std::move(done));
  Get(std::move(path), detail::kUnavailable, std::move(done));
}

void HttpBridge::ActiveGrant(int id) {
  namespace detail = models_http_detail;
  Get("/grants/current", detail::kUnavailable, [this, id](Reply reply) {
    const std::string_view call = "getActiveSpendGrant";
    // `grant_not_found` is the answer "none".
    if (reply.status == 404) return Resolve(id, call, Json());
    if (!reply.ok) return Reject(id, call, reply);
    if (!detail::IsId(reply.body.Find("id"))) return Reject(id, call, "invalid_grant_response");
    Resolve(id, call, std::move(reply.body));
  });
}

void HttpBridge::RequestGrant(int id, const Json& args) {
  namespace detail = models_http_detail;
  const Json* options = detail::OptionsOf(args);
  if (options == nullptr) return Fail(id, detail::kInvalidRequest);
  // A budget the game's creator pays is asked for at a door this build does not use.
  const Json* sponsored = options->Find("sponsored");
  if (sponsored != nullptr && sponsored->IsBool() && sponsored->AsBool()) return Fail(id, kNativeUnsupported);
  // A practice helper stands in for the player, so it is asked.
  if (options_.practice) return AskForGrant(id, *options);
  // There is no approval window to open, so no budget is ever asked for (never POST /grants): the answer is the
  // budget the player approved on the game's Genex page, or that there is none.
  Get("/grants/current", detail::kGrantUnavailable, [this, id](Reply reply) {
    if (reply.status == 404) return Fail(id, kBudgetNotApproved);
    if (!reply.ok) return Fail(id, reply);
    if (!detail::IsId(reply.body.Find("id"))) return Fail(id, "invalid_grant_response");
    std::optional<Json> answer = detail::GrantOutcome(reply.body);
    if (!answer) return Fail(id, kBudgetNotApproved);
    Settle(id, std::move(*answer));
  });
}

void HttpBridge::AskForGrant(int id, const Json& options) {
  namespace detail = models_http_detail;
  // The options as written, without the wait's own; the helper answers what the player would.
  static constexpr std::string_view kNotSent[] = {"timeoutMs", "sponsored"};
  Json body = Json::MakeObject();
  for (const JsonMember& member : options.Members()) {
    bool sent = true;
    for (const std::string_view key : kNotSent) sent = sent && member.key != key;
    if (sent) body.Set(member.key, member.value);
  }
  const Json* key = options.Find("idempotencyKey");
  if (key == nullptr || key->IsNull()) body.Set("idempotencyKey", NewKey());
  const double timeoutMs = detail::TimeoutOf(options.Find("timeoutMs"), http_limits::kGrantWaitMs);
  Post("/grants", std::move(body), detail::kGrantUnavailable, [this, id, timeoutMs](Reply reply) {
    Op* op = FindOp(id);
    if (op == nullptr) return;
    if (!reply.ok) return Fail(id, reply);
    if (!detail::IsId(reply.body.Find("id"))) return Fail(id, "invalid_grant_response");
    if (std::optional<Json> answer = detail::GrantOutcome(reply.body)) return Settle(id, std::move(*answer));
    op->grant = true;
    op->generationId = reply.body.Find("id")->AsString();
    StartPoll(id, timeoutMs);
  });
}

std::string HttpBridge::InvalidGeneration(const Json& options, bool stream) const {
  namespace detail = models_http_detail;
  // Without a budget a call opens the approval window, which a native build does not have. A practice
  // helper stands in for it, for a call that is not a stream (`stream_requires_grant` everywhere).
  const Json* grant = options.Find("grantId");
  const bool oneTime = grant == nullptr || grant->IsNull();
  if (oneTime && stream) return "stream_requires_grant";
  if (oneTime && !options_.practice) return std::string(kNativeUnsupported);
  const detail::Ceiling ceiling = detail::CeilingOf(options);
  if (!ceiling.error.empty()) return ceiling.error;
  const Json* tokens = options.Find("maxOutputTokens");
  if (tokens != nullptr && !detail::IsCount(tokens, 1.0, detail::kMaxSafeInteger)) return "invalid_max_output_tokens";
  // A conversation the server would refuse is refused before it could be folded into a prompt nobody checked.
  const std::string malformed = detail::HasRichFields(options) ? ConversationError(options) : std::string();
  if (!malformed.empty()) return malformed;
  if (oneTime) return std::string();
  return detail::IsId(grant) ? std::string() : std::string("invalid_grant_id");
}

void HttpBridge::Generate(int id, const Json& args) {
  namespace detail = models_http_detail;
  const Op* op = FindOp(id);
  if (op == nullptr) return;
  const Json* options = detail::OptionsOf(args);
  if (options == nullptr) return Fail(id, detail::kInvalidRequest);
  const std::string invalid = InvalidGeneration(*options, op->stream);
  if (!invalid.empty()) return Fail(id, invalid);

  // The options as written, without what is the wait's, the route's and the budget's own.
  static constexpr std::string_view kNotSent[] = {"timeoutMs", "idempotencyKey", "grantId", "maxCredits", "estimateCoins", "allowExternal"};
  Json body = Json::MakeObject();
  for (const JsonMember& member : options->Members()) {
    bool sent = true;
    for (const std::string_view key : kNotSent) sent = sent && member.key != key;
    if (sent) body.Set(member.key, member.value);
  }
  const detail::Ceiling ceiling = detail::CeilingOf(*options);
  body.Set(ceiling.key, ceiling.value);
  const Json* key = options->Find("idempotencyKey");
  body.Set("idempotencyKey", key != nullptr && !key->IsNull() ? *key : Json(NewKey()));
  // Empty: a one-time call, which only a practice helper is asked for.
  const Json* budget = options->Find("grantId");
  const std::string grantId = budget != nullptr && budget->IsString() ? budget->AsString() : std::string();
  const double timeoutMs = detail::TimeoutOf(options->Find("timeoutMs"), http_limits::kGenerationWaitMs);

  if (!detail::HasRichFields(body)) return SendGeneration(id, grantId, timeoutMs, std::move(body));
  // More than one block of text: sent as written only to a stand that says it takes that.
  TakesMessages([this, id, grantId, timeoutMs, wire = std::move(body)](bool yes, bool noSession) {
    if (FindOp(id) == nullptr) return;
    if (noSession) return Fail(id, detail::kNoPlayerSession);
    SendGeneration(id, grantId, timeoutMs, yes ? wire : detail::Folded(wire));
  });
}

void HttpBridge::SendGeneration(int id, const std::string& grantId, double timeoutMs, Json body) {
  namespace detail = models_http_detail;
  const std::string path = grantId.empty() ? std::string("/generations") : "/grants/" + detail::EncodeSegment(grantId) + "/generations";
  Post(path, std::move(body), detail::kUnavailable, [this, id, grantId, timeoutMs](Reply reply) {
    Op* op = FindOp(id);
    if (op == nullptr) return;
    if (!reply.ok) return Fail(id, reply);
    const Json& view = reply.body;
    const bool ofBudget = grantId.empty() || detail::IsText(view.Find("grantId"), grantId);
    if (!detail::IsId(view.Find("id")) || !ofBudget) return Fail(id, "invalid_generation_response");
    op->generationId = view.Find("id")->AsString();
    if (std::optional<Json> ended = detail::Outcome(view)) return Settle(id, std::move(*ended));
    StartPoll(id, timeoutMs);
  });
}

void HttpBridge::TakesMessages(std::function<void(bool, bool)> done) {
  namespace detail = models_http_detail;
  if (takesMessages_) return done(*takesMessages_, false);
  messagesWaiters_.push_back(std::move(done));
  if (askingMessages_) return;
  askingMessages_ = true;
  Get("/models", detail::kUnavailable, [this](Reply reply) {
    askingMessages_ = false;
    bool yes = false;
    if (reply.ok) {
      // Only `true` is a yes. An answer is kept; a read that failed is a no for these calls only.
      const Json* features = reply.body.Find("features");
      const Json* messages = features != nullptr ? features->Find("messages") : nullptr;
      yes = messages != nullptr && messages->IsBool() && messages->AsBool();
      takesMessages_ = yes;
    }
    std::vector<std::function<void(bool, bool)>> waiters;
    waiters.swap(messagesWaiters_);
    for (const std::function<void(bool, bool)>& waiter : waiters) waiter(yes, reply.noSession);
  });
}

void HttpBridge::Judge(int id, const Json& args) {
  namespace detail = models_http_detail;
  if (FindOp(id) == nullptr) return;
  const Json* options = detail::OptionsOf(args);
  if (options == nullptr) return Fail(id, detail::kInvalidRequest);
  const std::string invalid = detail::InvalidJudgeOptions(*options);
  if (!invalid.empty()) return Fail(id, invalid);
  const std::string grantId = options->Find("grantId")->AsString();
  const Json* key = options->Find("idempotencyKey");
  const Json* timeout = options->Find("timeoutMs");
  Json body = Json::MakeObject();
  body.Set("idempotencyKey", key != nullptr ? *key : Json(NewKey()));
  body.Set("state", *options->Find("state"));
  body.Set("questions", *options->Find("questions"));
  if (timeout != nullptr) body.Set("timeoutMs", *timeout);
  const double waitMs = detail::TimeoutOf(timeout, http_limits::kJudgeWaitMs) + http_limits::kJudgeWaitMarginMs;
  Post("/grants/" + detail::EncodeSegment(grantId) + "/judgments", std::move(body), detail::kJudgeUnavailable, [this, id, grantId, waitMs](Reply reply) {
    Op* op = FindOp(id);
    if (op == nullptr) return;
    if (!reply.ok) return Fail(id, reply);
    const Json& view = reply.body;
    if (!detail::IsId(view.Find("generationId")) || !detail::IsText(view.Find("grantId"), grantId)) return Fail(id, "invalid_judgment_response");
    if (detail::IsText(view.Find("status"), "dispatching")) {
      // A replay of a call another request is still answering: wait for it.
      op->generationId = view.Find("generationId")->AsString();
      if (const Json* billing = view.Find("billing")) op->billing = *billing;
      return StartPoll(id, waitMs);
    }
    Json result = Json::MakeObject();
    detail::CopyField(view, result, "status");
    detail::CopyField(view, result, "generationId");
    detail::CopyField(view, result, "billing");
    detail::CopyTruthy(view, result, "answers");
    detail::CopyTruthy(view, result, "error");
    detail::CopyTruthy(view, result, "source");
    Settle(id, std::move(result));
  });
}

void HttpBridge::WaitFor(int id, const Json& args) {
  namespace detail = models_http_detail;
  Op* op = FindOp(id);
  if (op == nullptr) return;
  if (!detail::IsId(&args.At(0))) return Fail(id, "invalid_generation_id");
  op->generationId = args.At(0).AsString();
  op->endsWithoutSession = true;
  StartPoll(id, detail::TimeoutOf(&args.At(1), http_limits::kGenerationWaitMs));
}

// ---- the wait ----

void HttpBridge::StartPoll(int id, double timeoutMs) {
  Op* op = FindOp(id);
  if (op == nullptr) return;
  const double now = Now();
  op->polling = true;
  op->deadlineMs = now + timeoutMs;
  op->nextReadAtMs = now;
  SetWaiting();
  Step(id);
}

void HttpBridge::Step(int id) {
  namespace detail = models_http_detail;
  Op* op = FindOp(id);
  if (op == nullptr || !op->polling || op->readInFlight) return;
  const double now = Now();
  if (now >= op->deadlineMs) {
    // Waiting time only: the call is not cancelled, and waitForGeneration resumes it.
    Json result = Json::MakeObject();
    result.Set("status", "pending");
    result.Set(op->grant ? "grantId" : "generationId", op->generationId);
    result.Set("error", detail::kWaitTimeout);
    if (op->billing) result.Set("billing", *op->billing);
    return Settle(id, std::move(result));
  }
  if (now < op->nextReadAtMs) return;
  op->readInFlight = true;
  const std::string route = (op->grant ? "/grants/" : "/generations/") + detail::EncodeSegment(op->generationId);
  Get(route, op->grant ? detail::kGrantUnavailable : detail::kUnavailable, [this, id](Reply reply) {
    Op* read = FindOp(id);
    if (read == nullptr) return;
    read->readInFlight = false;
    const bool first = read->endsWithoutSession;
    read->endsWithoutSession = false;
    if (reply.noSession && first) return Fail(id, detail::kNoPlayerSession);
    std::optional<Json> ended;
    if (reply.ok && read->grant) ended = detail::GrantOutcome(reply.body);
    else if (reply.ok) ended = read->judge ? detail::JudgeOutcome(reply.body) : detail::Outcome(reply.body);
    if (ended) return Settle(id, std::move(*ended));
    // Still running, or a read that failed: a failed read is not a failed generation.
    read->nextReadAtMs = Now() + http_limits::kPollIntervalMs;
  });
}

void HttpBridge::Advance() {
  std::vector<int> waiting;
  for (const auto& entry : ops_) {
    if (entry.second.polling && !entry.second.readInFlight) waiting.push_back(entry.first);
  }
  for (const int id : waiting) Step(id);
}

void HttpBridge::Update(double /*nowMs*/) {
  // The bridge's own clock drives the waits (the pump's `nowMs` is the same clock in a game).
  Advance();
}

void HttpBridge::SetWaiting() {
  if (!options_.usePump) return;
  bool waiting = false;
  for (const auto& entry : ops_) waiting = waiting || entry.second.polling;
  if (waiting && !registered_) {
    registered_ = true;
    Pump::Register(this);
  } else if (!waiting && registered_) {
    registered_ = false;
    Pump::Unregister(this);
  }
}

}  // namespace genex::models
