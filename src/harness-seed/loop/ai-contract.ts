/**
 * Play-time AI as the harness reads it: why a game's AI call got no answer (`AiErrorCode`), why a
 * schema is refused (`AiSchemaProblem`, what `ai.schemaCheck` answers) and the bounds of the host's
 * `ai.*` runs. The app keeps the same words in `shared/game-ai.ts`, `shared/game-ai-schema.ts`,
 * `shared/game-ai-tape.ts` and `shared/game-ai-check.ts` (tests/conformance/seed-contracts.test.ts
 * holds them together). A replay, a recording, a bench and a check never reach the network: the host
 * runs them on tapes and this Mac's models, on a run budget it creates and the harness cannot raise.
 *
 * Also the AI vendors a game may not call directly (`shared/ai-vendors.ts`): the hosts Play refuses and
 * the key shapes Publish refuses, which `ai-no-direct-model-calls` looks for in a build.
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
/** A call site's name (`site:` in a game's call): a tape key's part and a bench row. */
export const AI_SITE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** A demo's name, which is its tape's file name (`ai/tapes/<demo>.jsonl`) without the extension. */
export const TAPE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** A demo's tape folder in the game, and a tape's extension (`ai/tapes/<demo>.jsonl`). */
export const AI_TAPES_DIR = "ai/tapes";
export const AI_TAPE_EXTENSION = ".jsonl";

/** What a harness replay answers a demo's calls with (`ai.replay`'s `answers`). Wire values: never rename one. */
export const AiReplayAnswers = {
  /** The demo's tape: a call it has no line for is `ai_unrecorded`, and the game's fallback plays. */
  Tape: "tape",
  /** No answer at all: every call is refused `ai_off`, as when the person turns AI off. */
  None: "none",
  /** The worst answers the game's shapes allow: numbers at their bounds, the longest strings, the fullest lists. */
  Edge: "edge",
} as const;
export type AiReplayAnswers = (typeof AiReplayAnswers)[keyof typeof AiReplayAnswers];

/** What a harness AI check measures (`loop/ai-checks.ts`, kind `ai`). Plans and boards keep the value: never rename one. */
export const AiCheckTest = {
  ReplayDeterministic: "replay-deterministic",
  TapeCoversDemos: "tape-covers-demos",
  HandlesNoAnswer: "handles-no-answer",
  OutputClamped: "output-clamped",
  DisclosureShown: "disclosure-shown",
  NoDirectModelCalls: "no-direct-model-calls",
  BudgetInGesture: "budget-in-gesture",
} as const;
export type AiCheckTest = (typeof AiCheckTest)[keyof typeof AiCheckTest];

/**
 * Whether a game can run without AI (`createAi({ requires })`, and a plan's `ai`): an AI-only game
 * pauses behind Studio's "needs AI" state when no answer comes. Wire values: never rename one.
 */
export const AiRequirement = { Ai: "ai", Optional: "optional" } as const;
export type AiRequirement = (typeof AiRequirement)[keyof typeof AiRequirement];

// ── AI vendors a game may not call directly ─────────────────────────────────────────────────

/** The vendors. Wire values: never rename one. */
export const AiVendor = {
  OpenAi: "openai",
  Anthropic: "anthropic",
  Google: "google",
  OpenRouter: "openrouter",
  Mistral: "mistral",
  Groq: "groq",
  Together: "together",
  Fireworks: "fireworks",
  DeepSeek: "deepseek",
  Xai: "xai",
  Cohere: "cohere",
  Perplexity: "perplexity",
  Replicate: "replicate",
  Fal: "fal",
} as const;
export type AiVendor = (typeof AiVendor)[keyof typeof AiVendor];

/** How a row's host matches. Wire values: never rename one. */
export const AiHostMatch = {
  /** The host itself only. */
  Exact: "exact",
  /** The host and any subdomain of it. */
  Subdomains: "subdomains",
  /** The host and any one-label regional prefix joined by a dash. */
  Regional: "regional",
} as const;
export type AiHostMatch = (typeof AiHostMatch)[keyof typeof AiHostMatch];

/** One API host and how it matches. */
export interface AiVendorHost {
  vendor: AiVendor;
  host: string;
  match: AiHostMatch;
}

/** Every vendor API host a game is refused. */
export const AI_VENDOR_HOSTS: readonly AiVendorHost[] = [
  { vendor: AiVendor.OpenAi, host: "openai.com", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.OpenAi, host: "openai.azure.com", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Anthropic, host: "anthropic.com", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Anthropic, host: "claude.ai", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Google, host: "generativelanguage.googleapis.com", match: AiHostMatch.Exact },
  { vendor: AiVendor.Google, host: "aiplatform.googleapis.com", match: AiHostMatch.Regional },
  { vendor: AiVendor.OpenRouter, host: "openrouter.ai", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Mistral, host: "mistral.ai", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Groq, host: "groq.com", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Together, host: "together.xyz", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Together, host: "together.ai", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Fireworks, host: "fireworks.ai", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.DeepSeek, host: "deepseek.com", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Xai, host: "x.ai", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Cohere, host: "cohere.ai", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Cohere, host: "cohere.com", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Perplexity, host: "perplexity.ai", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Replicate, host: "replicate.com", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Fal, host: "fal.run", match: AiHostMatch.Subdomains },
  { vendor: AiVendor.Fal, host: "fal.ai", match: AiHostMatch.Subdomains },
];

/** A hostname as compared: lowercase, without a trailing root dot. */
function canonicalHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "");
}

/** The host of a URL or a bare hostname (with or without a port), or null when there is none. */
function hostOf(target: string): string | null {
  const text = target.trim();
  if (!text) return null;
  try {
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    return url.hostname ? canonicalHost(url.hostname) : null;
  } catch {
    return null;
  }
}

/** One DNS label: what a regional prefix may be. */
const LABEL = /^[a-z0-9-]+$/;

/** Whether a host is a row's host, or one the row's match takes. */
function matchesRow(host: string, row: AiVendorHost): boolean {
  if (host === row.host) return true;
  if (row.match === AiHostMatch.Subdomains) return host.endsWith(`.${row.host}`);
  if (row.match !== AiHostMatch.Regional || !host.endsWith(`-${row.host}`)) return false;
  return LABEL.test(host.slice(0, -row.host.length - 1));
}

/** The vendor whose API a URL or hostname reaches, or null. Never throws. */
export function aiVendorOfHost(target: string): AiVendor | null {
  const host = hostOf(target);
  if (!host) return null;
  return AI_VENDOR_HOSTS.find((row) => matchesRow(host, row))?.vendor ?? null;
}

/** One vendor key shape: a pattern with the `g` flag that matches a whole key and nothing shorter. */
export interface AiKeyShape {
  vendor: AiVendor;
  pattern: RegExp;
}

/** Vendor key shapes, most specific first. */
export const AI_KEY_SHAPES: readonly AiKeyShape[] = [
  { vendor: AiVendor.Anthropic, pattern: /(?<![\w-])sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,}(?![\w-])/g },
  { vendor: AiVendor.OpenRouter, pattern: /(?<![\w-])sk-or-v1-[a-f0-9]{64}(?![\w-])/g },
  { vendor: AiVendor.OpenAi, pattern: /(?<![\w-])sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}(?![\w-])/g },
  { vendor: AiVendor.OpenAi, pattern: /(?<![\w-])sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}(?![\w-])/g },
  { vendor: AiVendor.Google, pattern: /(?<![\w-])AIza[0-9A-Za-z_-]{35}(?![\w-])/g },
  { vendor: AiVendor.Groq, pattern: /(?<![\w-])gsk_[A-Za-z0-9]{52}(?![\w-])/g },
  { vendor: AiVendor.Xai, pattern: /(?<![\w-])xai-[A-Za-z0-9]{80}(?![\w-])/g },
  { vendor: AiVendor.Perplexity, pattern: /(?<![\w-])pplx-[A-Za-z0-9]{48}(?![\w-])/g },
  { vendor: AiVendor.Replicate, pattern: /(?<![\w-])r8_[A-Za-z0-9]{37}(?![\w-])/g },
  { vendor: AiVendor.Fireworks, pattern: /(?<![\w-])fw_[A-Za-z0-9]{24}(?![\w-])/g },
  { vendor: AiVendor.DeepSeek, pattern: /(?<![\w-])sk-[a-f0-9]{32}(?![\w-])/g },
];

/** A key found in text: whose shape, and where. The key itself is never kept. */
export interface AiKeyHit {
  vendor: AiVendor;
  index: number;
}

/** Every vendor key in `text`, in order, each reported once by the most specific shape that matches it. */
export function findAiKeys(text: string): AiKeyHit[] {
  const hits: Array<AiKeyHit & { end: number }> = [];
  for (const shape of AI_KEY_SHAPES) {
    for (const match of text.matchAll(shape.pattern)) {
      const index = match.index;
      const end = index + match[0].length;
      if (hits.some((hit) => index < hit.end && end > hit.index)) continue;
      hits.push({ vendor: shape.vendor, index, end });
    }
  }
  return hits.sort((a, b) => a.index - b.index).map(({ vendor, index }) => ({ vendor, index }));
}
