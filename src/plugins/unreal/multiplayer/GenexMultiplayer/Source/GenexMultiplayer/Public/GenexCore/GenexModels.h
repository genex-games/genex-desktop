// In-game model calls: an NPC that answers in its own words, a judge that reads what the player
// typed. The PLAYER pays and approves, on a Genex surface the game cannot draw or skip; the game
// holds no provider key. The calls are @genex-ai/embed-sdk's, under the same names and with the
// same result shapes, so what is written for a TypeScript game applies.
//
// That surface is a Genex web page, and an Unreal game ships as a native build, where there is no
// approval window. The player approves the game's budget on its Genex page before starting it, so
// calls under that budget work here: GenerateStream, Generate with a `grantId`, Judge and the reads
// go to the API over HTTPS (GenexCore/GenexModelsHttp.h, the bridge the Unreal subsystem builds
// Models over). What needs the window does not: a one-time Generate settles `native_unsupported`
// and RequestSpendGrant answers the budget the player already approved, or `budget_not_approved`.
// How a call is carried is the Bridge below (the engine bridge's "Model calls", sdks/rust/BRIDGE.md).
// Models() with no bridge reaches no network: every call resolves `native_unsupported` at the next
// Poll(). Bodies are opaque JSON in both directions: an option, a result field or an error code
// this file has never heard of crosses untouched.
//
// This file is engine-free and holds no clock and no network. Held to the TypeScript bridge's shared
// vectors (packages/multiplayer/test/vectors/models-bridge.json) by genex_models_check.
#pragma once

#include "GenexCore/GenexConfig.h"
#include "GenexCore/GenexJson.h"

#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace genex::models {

/** The code of a call a native build cannot make at all: one that needs the Genex approval window, or a bridge that
 *  reaches no network (the default one). */
inline constexpr std::string_view kNativeUnsupported = "native_unsupported";
/** RequestSpendGrant in a native build when the player has no live budget in this game: budgets are approved on
 *  the game's Genex page, before the game starts. */
inline constexpr std::string_view kBudgetNotApproved = "budget_not_approved";

/** One thing a bridge reported since the last Poll() (BRIDGE.md, "Model calls", Events). */
struct Event {
  enum class Type {
    /** The call settled: `result` is what the JavaScript call resolves with. For Generate, GenerateStream, Judge,
     *  RequestSpendGrant and WaitForGeneration an object with `status` (and `error` when it failed); for a read, the
     *  view (null from GetActiveSpendGrant when there is no live budget). */
    Result,
    /** A read the JavaScript call rejects (GetGenerationModels, GetGeneration, GetSpendGrant, GetActiveSpendGrant,
     *  StopSpendGrant, Init): `error` is the code. */
    Rejected,
    /** GenerateStream: `text` arrived since the last poll, `soFar` is all of it. Provisional. */
    Delta,
    /** GenerateStream with a JSON answer: the schema's first string property (`name`) as far as written (`text`). */
    PartialField,
    /** The call opens the Genex approval window and a browser needs a click, tap or key press for that:
     *  `waiting` is true while it waits for the player's next one, false once it has run or given up. */
    Gesture,
  };
  Type type = Type::Result;
  int id = 0;
  /** The JavaScript name of the call ("generate", "getSpendGrant"). */
  std::string call;
  Json result;
  std::string error;
  std::string text;
  std::string soFar;
  std::string name;
  bool waiting = false;
};

/** One drain as events. A reader skips what it cannot read and keeps the rest: text that is not a JSON array is no
 *  events; an entry is skipped when its `type` is unknown, its `id` is not a positive whole number, or a field its
 *  type needs is missing or of another type (BRIDGE.md). */
GENEX_CORE_API std::vector<Event> ReadEvents(std::string_view drainJson);

/** The platform's sentence for a code (embed-sdk's generationErrorMessage, the whole table: GenexModelsSentences.cpp).
 *  A code the table does not name, or none (nullptr), reads as the general one. */
GENEX_CORE_API std::string NativeErrorMessage(const std::string* code);

/** Whether the table has a sentence of its own for `code`: it is one of the platform's codes, not a server's free text. */
GENEX_CORE_API bool HasErrorSentence(std::string_view code);

/** Whether `text` has a code's shape: lower-case words joined by underscores, at most 64 characters and three digits
 *  (`provider_http_429`). What a log may repeat of an answer's `error`: a prompt, a token or a sentence never has it. */
GENEX_CORE_API bool IsErrorCode(std::string_view text);

/** Whether `text` reads as what Genex says beside a refusal's code: its `reason` (a short fixed code or phrase, such as
 *  `ref_not_supported`) or its `at` (a place, such as `schema.properties.mood`): 1 to 300 characters of letters,
 *  digits, spaces and `_.,:$#-`. Anything else in an answer is not kept and never logged. */
GENEX_CORE_API bool IsRefusalReason(std::string_view text);

/** For the game's MAKER, never for a player: what to change when a call ends with `code`, or empty for a code nobody
 *  fixes in the game. Written after the code in the log line of a failed call. */
GENEX_CORE_API std::string_view ErrorMakerNote(std::string_view code);

/** The log line of a call that ended with a code: the call, the code (when it has a code's shape), the HTTP status
 *  (0: none), the reason and the place (each when it reads as Genex's) and the maker's note. Nothing else of a request
 *  or an answer. */
GENEX_CORE_API std::string FailureLogLine(std::string_view call, std::string_view code, int httpStatus, std::string_view reason, std::string_view at = {},
                                          bool rejected = false);

/** How the calls reach a page. This build's is the native one; a test passes its own. */
class GENEX_CORE_API Bridge {
 public:
  virtual ~Bridge();
  /** Whether model calls can work at all here. */
  virtual bool Supported() const = 0;
  /** One call by its JavaScript name, its arguments as one JSON array. Answers the request id (0: none). */
  virtual int Call(std::string_view method, std::string_view argsJson) = 0;
  /** Stop waiting for a gesture, or stop reading a stream. Never cancels a started call. */
  virtual bool Cancel(int request) = 0;
  /** How many events wait for the next drain. */
  virtual int Pending() = 0;
  /** Every event since the last drain, as a JSON array. */
  virtual std::string DrainEventsJson() = 0;
  /** The platform's sentence for an error code (nullptr: none). */
  virtual std::string GenerationErrorMessage(const std::string* code) const = 0;
};

/** The game's door to the model calls. One per game is enough; it holds no connection. */
class GENEX_CORE_API Models {
 public:
  /** Over a bridge that reaches no network: every call resolves kNativeUnsupported at the next Poll(). */
  Models();
  /** Over a bridge of the caller's own (never null: a null one is replaced by the native bridge). */
  explicit Models(std::unique_ptr<Bridge> bridge);
  ~Models();
  Models(const Models&) = delete;
  Models& operator=(const Models&) = delete;

  /** Whether model calls can work at all over this bridge: true over the HTTP bridge (calls under a budget the
   *  player approved), false with no bridge. When false, leave the feature's entry point out and play authored
   *  content. */
  bool Supported() const;

  /** Wait for the player (guest or signed in); `gameId` is the game's slug. Resolves with `user`, `guest` and
   *  `shell`. */
  int Init(std::string_view gameId);
  /** The stand's models, featured first. */
  int GetGenerationModels();
  /** One call. With `grantId` the player's budget admits it; without one it opens the Genex approval window, which
   *  a native build does not have (kNativeUnsupported). */
  int Generate(const Json& options);
  /** The same call under a budget, answered as it is written: Delta and PartialField events, then the Result. */
  int GenerateStream(const Json& options);
  /** The budget's classifier: typed questions about the game's own state. */
  int Judge(const Json& options);
  /** Ask the player for a standing budget. In a native build nothing is asked: the answer is the budget the player
   *  approved on the game's Genex page, or kBudgetNotApproved. */
  int RequestSpendGrant(const Json& options);
  /** The budget's live state and counters: the one source for an in-game readout. */
  int GetSpendGrant(std::string_view grantId);
  /** The player's live budget in this game; resolves null when there is none. */
  int GetActiveSpendGrant();
  /** The game's own stop: no further calls are admitted, what is in flight settles. */
  int StopSpendGrant(std::string_view grantId);
  /** Re-attach to a call already started. `timeoutMs` above 0 is how long to wait, never a cancellation. */
  int WaitForGeneration(std::string_view generationId, double timeoutMs = 0.0);
  /** The call's view as the server holds it. */
  int GetGeneration(std::string_view generationId);

  /** Stop waiting for a gesture, or stop reading a stream; false for anything else. */
  bool Cancel(int request);
  /** The platform's player-facing sentence for an error code (nullptr: none): show it, or an in-fiction line keyed
   *  off the same code, never the raw code. */
  std::string GenerationErrorMessage(const std::string* code) const;
  /** Call once per frame: everything that settled or arrived since the last call, oldest first. */
  std::vector<Event> Poll();

 private:
  int Start(std::string_view method, Json args);
  std::unique_ptr<Bridge> bridge_;
};

}  // namespace genex::models
