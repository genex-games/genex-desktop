// In-game model calls of a native build, over plain HTTPS: the calls a player's approved budget
// admits. The player approves a game's budget on the game's Genex page before pressing Play, and
// Genex starts the game with a one-use ticket (GenexIdentity redeems it). So a live budget already
// exists for this player and this game when the game starts, and the game finds it and calls under
// it. A native build still has no approval window, and nothing here ever tries to open one.
//
// Source of truth: packages/embed-sdk/src/generation.ts (`generate` under a grant, `judge`, the
// reads, `outcome`, `billingReceipt`, `grantOutcome`, `judgeOutcome`, `poll`, `wireBody`) and
// packages/embed-protocol/src/runtime-generation.ts (`isGenerationId`, `isGenerationTerminal`,
// `runtimeConversationError`, `foldRuntimeConversation`); results have the SDK's shapes field for
// field. Every route is under `<API base>/api/runtime`:
//
//   init                 no request: who plays, as the identity holds it, and `shell` "app"
//   getGenerationModels  GET  /models
//   getActiveSpendGrant  GET  /grants/current            404 is the answer `null`
//   getSpendGrant        GET  /grants/{id}
//   stopSpendGrant       POST /grants/{id}/stop          {}
//   requestSpendGrant    GET  /grants/current            never POST /grants: the live budget, else
//                                                        `budget_not_approved`
//   generate             POST /grants/{id}/generations   then GET /generations/{id} every 750 ms
//   generateStream       the same call; its text arrives whole, as one Delta before the Result
//   judge                POST /grants/{id}/judgments     polled only while it reads `dispatching`
//   waitForGeneration    GET  /generations/{id} every 750 ms
//   getGeneration        GET  /generations/{id}
//
// What a native build cannot do answers by code, with no request: `generate` without a `grantId`
// and a sponsored `requestSpendGrant` settle `native_unsupported`, `generateStream` without one
// `stream_requires_grant`; voice and the room lends are rejected `native_unsupported`.
//
// A call with `system`, `messages` or a control (`temperature`, `topP`, `stop`, `seed`,
// `reasoningEffort`, `cacheSystem`) asks the stand once whether it takes them (`features.messages`
// of GET /models; a failed read is a no for that call only). Where it does not, the call is sent as
// ONE folded prompt with the controls dropped, the SDK's own text.
//
// Every request asks the token provider for a fresh token and reads the API base again (the
// launcher's GENEX_API_URL wins). No Origin header is sent. No token and no body is ever logged.
//
// PRACTICE (a game being developed). `genex llm practice`, which Genex's desktop app runs for a game
// being made, serves these same routes on 127.0.0.1 and stands in for the player: made-up answers,
// the maker's own AI plan, or real models under a cap the maker set. A bridge made for such a
// helper (HttpBridgeOptionsForPractice, `practice` true) sends every request there with the
// helper's own token, never the player's, and asks it what a published build may not ask anyone:
//
//   init                 no request: the local tester, a guest, and `shell` "local"
//   requestSpendGrant    POST /grants                    then GET /grants/{id} every 750 ms
//   generate, no grantId POST /generations               then GET /generations/{id} every 750 ms
//
// The helper is named by a key, `<port>.<32 hex>` (the SDK's `genex_llm_practice` value): a port on
// this computer and nothing else, so a key can point nowhere but 127.0.0.1. Only the program that
// starts a game hands it one (kPracticeEnv): the editor for a play in the editor, Genex's desktop app
// for the packaged app it starts from the game's own folder. Genex never does for a game a player
// installed. No credits are spent or taken through a helper.
//
// ASYNCHRONOUS and single-threaded, like the rest of GenexCore: a call answers its request id at
// once and settles as an event at a later drain. The waits (the 750 ms cadence, a call's timeout)
// advance on the bridge's own clock from Update (genex::Pump) and from Pending(), which
// Models::Poll() asks once a frame. Nothing is called after the bridge is destroyed.
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexHttp.h"
#include "GenexCore/GenexIdentity.h"
#include "GenexCore/GenexJson.h"
#include "GenexCore/GenexModels.h"
#include "GenexCore/GenexPump.h"

#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace genex::models {

namespace http_limits {
/** The gap between two reads of a call that has not ended (the SDK's `poll`). */
inline constexpr double kPollIntervalMs = 750.0;
/** How long generate, generateStream and waitForGeneration wait by default (GENERATION_WAIT_MS). */
inline constexpr double kGenerationWaitMs = 1200000.0;
/** How long a practice requestSpendGrant waits for the helper's answer by default (the SDK's 600 s). */
inline constexpr double kGrantWaitMs = 600000.0;
/** A judge call's default server wait, and what the bridge waits past it for a replay. */
inline constexpr double kJudgeWaitMs = 20000.0;
inline constexpr double kJudgeWaitMarginMs = 10000.0;
}  // namespace http_limits

/** Who plays, as `init` answers it. */
struct HttpPlayer {
  /** Somebody holds a play token (a guest does too). */
  bool signedIn = false;
  bool guest = false;
  /** The sign-in answer's `user` object; anything else reads as null. */
  Json user;
};

struct HttpBridgeOptions {
  /** Transport; null = DefaultHttp(). Must outlive the bridge. */
  IHttp* http = nullptr;
  /** Asked before EVERY request, never cached. Empty, or an answer with no token: the call ends
   *  `no_player_session`. */
  TokenProvider token;
  /** The API base, read per request (EmbedIdentity::ApiBase). Empty = Genex's, GENEX_API_URL first. */
  std::function<std::string()> apiBase;
  /** The slug the identity signs in to; `init` warns when a game names another. Empty = not checked. */
  std::function<std::string()> slug;
  /** Who plays now, for `init`. Empty = nobody: a guest with no user. */
  std::function<HttpPlayer()> player;
  /** The host's chance to sign the player in before `init` resolves: call `done` exactly once.
   *  Empty = `init` resolves at once with whoever plays; the core never signs in by itself. */
  std::function<void(std::function<void()> done)> beforeInit;
  /** Monotonic milliseconds; empty = Clock::NowMs. (Tests inject one.) */
  std::function<double()> clock;
  /** A fresh idempotency key, 8 to 100 of [A-Za-z0-9_-]; empty = a random UUID. (Tests inject one.) */
  std::function<std::string()> idempotencyKey;
  /** Register with genex::Pump while a call waits. False for a host that polls Models every frame
   *  (Pending() advances the waits too) and may run without the Colyseus core. */
  bool usePump = true;
  /** The requests go to a practice helper that stands in for the player (see PRACTICE above):
   *  requestSpendGrant and a generate with no grantId ask it, and init answers the local tester. */
  bool practice = false;
};

/** The environment variable a launcher hands a game being developed its practice helper in:
 *  `<port>.<token>`. Read once and removed (TakePracticeKey). */
inline constexpr const char* kPracticeEnv = "GENEX_LLM_PRACTICE";

/** A practice helper: its port on 127.0.0.1 and the token it made for this run (not a Genex credential). */
struct PracticeTarget {
  int port = 0;
  std::string token;
};

/** A practice key, `<port>.<token>`: a port from 1024 to 65535 with no leading zero, a dot, and 32
 *  lowercase hex characters (embed-protocol's `readPracticeKey`). Anything else is no key. */
GENEX_CORE_API std::optional<PracticeTarget> ParsePracticeKey(std::string_view key);

/** The key a launcher put in kPracticeEnv, taken: the variable is removed whatever it held, so
 *  nothing the game starts inherits it. Nothing when it was unset or not a key. */
GENEX_CORE_API std::optional<PracticeTarget> TakePracticeKey();

/** `http://127.0.0.1:<port>`: the only address a practice key can name. */
GENEX_CORE_API std::string PracticeOrigin(int port);

/** The options of a bridge over a practice helper: its origin as the API base, its token as the
 *  bearer, nobody signed in, `practice` true. */
GENEX_CORE_API HttpBridgeOptions HttpBridgeOptionsForPractice(PracticeTarget target, IHttp* http = nullptr);

/** The options of a bridge over `identity`: its token provider, API base, slug and player. The
 *  identity must outlive the bridge. */
GENEX_CORE_API HttpBridgeOptions HttpBridgeOptionsFor(EmbedIdentity& identity, IHttp* http = nullptr);

/** The SDK's `foldRuntimeConversation` on a call's body: `system`, `messages` and `prompt` as the one
 *  prompt a stand that takes no conversation is sent. A body that is only a prompt is that prompt. */
GENEX_CORE_API std::string FoldConversation(const Json& body);

/** The SDK's `runtimeConversationError`: why a body's conversation is not one a stand accepts
 *  (`invalid_request`, `invalid_messages`), or empty when it is. */
GENEX_CORE_API std::string ConversationError(const Json& body);

class GENEX_CORE_API HttpBridge final : public Bridge, public IPumped {
 public:
  explicit HttpBridge(HttpBridgeOptions options);
  ~HttpBridge() override;
  HttpBridge(const HttpBridge&) = delete;
  HttpBridge& operator=(const HttpBridge&) = delete;

  /** True: calls under a budget the player approved can work in this build. */
  bool Supported() const override;
  int Call(std::string_view method, std::string_view argsJson) override;
  /** A generateStream that has not settled stops being waited for: it settles `pending` with
   *  `stream_aborted` (and its `generationId` once known) and true is answered. False for anything
   *  else: a started call is never cancelled. */
  bool Cancel(int request) override;
  /** Advances the waits, then answers how many events wait. */
  int Pending() override;
  std::string DrainEventsJson() override;
  /** `budget_not_approved` has its own sentence; any other code reads as NativeErrorMessage's. */
  std::string GenerationErrorMessage(const std::string* code) const override;

  /** Advances the waits on the bridge's own clock (Pump::Frame calls it while a call waits). */
  void Update(double nowMs) override;

 private:
  /** One answer of the API, or why there is none. */
  struct Reply {
    /** A 2xx answer: `body` is its JSON ({} when it is not JSON). */
    bool ok = false;
    /** The HTTP status; 0 when no answer arrived or nothing was sent. */
    int status = 0;
    /** No token was to be had, so nothing was sent. */
    bool noSession = false;
    Json body;
    /** When not ok: the body's `error`, else the caller's fallback code. */
    std::string code;
  };
  using ReplyDone = std::function<void(Reply)>;

  /** A call that settles with a `status` and has not settled yet. */
  struct Op {
    std::string call;
    bool stream = false;
    bool judge = false;
    /** A practice requestSpendGrant waiting for the helper's answer: `generationId` holds the budget's id. */
    bool grant = false;
    /** The first read of a waitForGeneration: no token there ends the call. */
    bool endsWithoutSession = false;
    std::string generationId;
    bool polling = false;
    bool readInFlight = false;
    double deadlineMs = 0.0;
    double nextReadAtMs = 0.0;
    /** A dispatching judgment's `billing`, carried into a wait that runs out. */
    std::optional<Json> billing;
  };

  double Now() const;
  std::string NewKey() const;
  void Request(std::string method, std::string path, std::optional<Json> body, std::string_view fallback, ReplyDone done);
  void Get(std::string path, std::string_view fallback, ReplyDone done);
  void Post(std::string path, Json body, std::string_view fallback, ReplyDone done);

  void Resolve(int id, std::string_view call, Json result);
  void Reject(int id, std::string_view call, std::string_view code);
  /** End an Op: the stream's text as one Delta when it succeeded, then its Result. */
  void Settle(int id, Json result);
  void Fail(int id, std::string_view code);
  Op* FindOp(int id);

  /** `run` now, or once every `init` still settling has settled. */
  void AfterInit(std::function<void()> run);
  void Init(int id, const Json& args);
  /** One call that is not `init`, its arguments a JSON array. */
  void Start(int id, const std::string& call, const Json& args);
  void Read(int id, const std::string& call, std::string path, bool post);
  void ActiveGrant(int id);
  void RequestGrant(int id, const Json& args);
  /** Practice: ask the helper for the budget (POST /grants), then wait for its answer. */
  void AskForGrant(int id, const Json& options);
  /** The code a generate or generateStream is refused with before anything is asked, or empty. */
  std::string InvalidGeneration(const Json& options, bool stream) const;
  void Generate(int id, const Json& args);
  void SendGeneration(int id, const std::string& grantId, double timeoutMs, Json body);
  void Judge(int id, const Json& args);
  void WaitFor(int id, const Json& args);
  /** Whether the stand takes `system`, `messages` and the controls; `noSession` when it could not
   *  be asked for want of a token. */
  void TakesMessages(std::function<void(bool yes, bool noSession)> done);

  void StartPoll(int id, double timeoutMs);
  void Step(int id);
  void Advance();
  void SetWaiting();

  HttpBridgeOptions options_;
  IHttp* http_ = nullptr;
  std::shared_ptr<int> alive_;
  int next_ = 0;
  Json queue_ = Json::MakeArray();
  std::map<int, Op> ops_;
  int inits_ = 0;
  std::vector<std::function<void()>> afterInit_;
  /** The stand's answer about conversations, once it gave one. */
  std::optional<bool> takesMessages_;
  bool askingMessages_ = false;
  std::vector<std::function<void(bool, bool)>> messagesWaiters_;
  bool registered_ = false;
};

}  // namespace genex::models
