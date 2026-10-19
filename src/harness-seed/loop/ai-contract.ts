/**
 * Play-time AI as the harness reads it: why a game's AI call got no answer (`AiErrorCode`), why a
 * schema is refused (`AiSchemaProblem`, what `ai.schemaCheck` answers) and the bounds of the host's
 * `ai.*` runs. The app keeps the same words in `shared/game-ai.ts`, `shared/game-ai-schema.ts`,
 * `shared/game-ai-tape.ts` and `shared/game-ai-check.ts` (tests/conformance/seed-contracts.test.ts
 * holds them together). A replay, a recording, a bench and a check never reach the network: the host
 * runs them on tapes and this Mac's models, on a run budget it creates and the harness cannot raise.
 */

/** Why a game's AI call got no answer. Wire values: never rename one. */
export const AiErrorCode = {
  /** AI is off for this game, everywhere, or in this context (an agent's preview). */
  Off: "ai_off",
  /** Replaying, and the saved playtest has no answer for this call. */
  Unrecorded: "ai_unrecorded",
  /** The game called an AI vendor directly; only `genex-ai` reaches a model. */
  DirectBlocked: "ai_direct_blocked",
  BadRequest: "bad_request",
  TooLarge: "prompt_too_large",
  InvalidSchema: "invalid_schema",
  /** The answer did not fit the game's shape, after the one repair. Never charged. */
  InvalidOutput: "invalid_output",
  /** The game has no grant yet: it asks inside a gesture, and Genex shows its card if it must. */
  ConsentRequired: "consent_required",
  ConsentDeclined: "consent_declined",
  ConsentPending: "consent_pending",
  /** A grant was asked for outside a person's gesture. */
  NoGesture: "no_gesture",
  /** The game reached the person's daily alert, or triggered top-ups too often: it waits for them. */
  Paused: "ai_paused",
  Concurrency: "grant_concurrency",
  RateLimited: "grant_rate_limited",
  /** The person's plan reached its keep-for-building line; `retryAfterMs` says when it rests no more. */
  WaitingForPlan: "waiting_for_plan",
  DoorUnavailable: "door_unavailable",
  LocalLoading: "local_model_loading",
  /** The grant's door may not be used in this context. */
  NoFunding: "no_funding",
  /** The grant's door is answered by genex.games: the game calls through the platform lane. */
  PlatformDoor: "platform_door",
  /** A leaderboard or shared answer needs a verified door (Genex credits). */
  NeedsVerified: "needs_verified",
  PlanNotAllowed: "plan_door_not_allowed",
  /** genex.games' own code for a balance that cannot pay. */
  OutOfCredits: "insufficient_credits",
  /** The person's own OpenRouter monthly limit is reached. */
  MonthlyLimit: "monthly_limit",
  /** Text other players would see was refused by moderation before it was broadcast. */
  Moderated: "moderated",
  Timeout: "timeout",
  Provider: "provider",
  Canceled: "canceled",
} as const;
export type AiErrorCode = (typeof AiErrorCode)[keyof typeof AiErrorCode];

/** Why a schema is refused (`ai.schemaCheck`). Wire values: never rename one. */
export const AiSchemaProblem = {
  NotObject: "not-object",
  TooDeep: "too-deep",
  UnknownType: "unknown-type",
  UnknownKeyword: "unknown-keyword",
  BadAnnotation: "bad-annotation",
  BadEnum: "bad-enum",
  ObjectShape: "object-shape",
  BadPropertyName: "bad-property-name",
  BadRequired: "bad-required",
  MisplacedKeyword: "misplaced-keyword",
  BadBound: "bad-bound",
} as const;
export type AiSchemaProblem = (typeof AiSchemaProblem)[keyof typeof AiSchemaProblem];

/** The most seeds one `ai.replay` runs. */
export const AI_REPLAY_MAX_SEEDS = 8;
/** The most calls one `ai.record` run may make. */
export const AI_RECORD_MAX_CALLS = 200;
/** The most samples one `ai.bench` takes of a site. */
export const AI_BENCH_MAX_SAMPLES = 5;
/** A demo's name, which is its tape's file name (`ai/tapes/<demo>.jsonl`) without the extension. */
export const TAPE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
