/**
 * Play-time AI as Studio carries it: a game asks for text or schema-checked JSON at play time
 * (`genex-ai`, `src/page/ai`), and main answers on one door the person chose. This module is the
 * wire both sides share: the ops, the doors and who pays through them, provenance, the error codes,
 * the one call and the one consent request a game may send, what a game may see of its grant, and
 * the hostile-input readers main runs on every message before anything else happens.
 *
 * Browser-safe: no Node or Electron imports. Every vocabulary is wire text: never rename a value.
 *
 * Money is in USD micros everywhere a program computes it ({@link MICROS_PER_CREDIT}: one Genex
 * credit is one US cent). People see Genex credits, or dollars on their own OpenRouter key; the
 * renderer converts with {@link creditsOfMicros} and never shows a per-reply or per-hour number.
 *
 * The limits mirror genex.games' own runtime stand (genex-demo `apps/api/src/config.ts` defaults and
 * `runtime-generation/validation.ts`), so a game that runs on the web runs the same here.
 */
import { EngineFailureKind } from "./engine-requests.ts";

/** The wire version of every call, answer and grant message. */
export const GAME_AI_WIRE_VERSION = 1;
/** A call's prompt, system and memory together, in UTF-8 bytes (genex.games `RUNTIME_MAX_PROMPT_BYTES`). */
export const AI_MAX_PROMPT_BYTES = 128 * 1024;
/** A call's schema, serialized, in UTF-8 bytes (genex.games `RUNTIME_MAX_SCHEMA_BYTES`). */
export const AI_MAX_SCHEMA_BYTES = 16 * 1024;
/** One player-typed field, in UTF-8 bytes. */
export const AI_MAX_UNTRUSTED_BYTES = 8 * 1024;
/** How many player-typed fields one call may carry. */
export const AI_MAX_UNTRUSTED_FIELDS = 16;
/** The output budget of a call that names none (genex.games `RUNTIME_MAX_OUTPUT_TOKENS`). */
export const AI_DEFAULT_OUTPUT_TOKENS = 512;
/** The most output tokens one call may ask for (genex.games `RUNTIME_OUTPUT_TOKENS_CAP`). */
export const AI_MAX_OUTPUT_TOKENS = 32_768;
/** The answer, JSON-encoded, in UTF-8 bytes (genex.games `RUNTIME_MAX_OUTPUT_BYTES`). */
export const AI_MAX_OUTPUT_BYTES = 256 * 1024;
/** The most characters one message from a game may carry in all, before any field is read. */
export const AI_MAX_BODY_CHARS = 200 * 1024;
/** The most JSON nodes one message from a game may hold. */
export const AI_MAX_WALK_NODES = 8192;
/** The deepest one message from a game may nest (a depth-5 schema inside a call fits). */
export const AI_MAX_WALK_DEPTH = 16;
/** A call site's name: the tape key, the bench row and the report's line. */
export const AI_SITE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** A ticket or a grant id: what the page and main name a call or a grant by. */
export const AI_ID_RE = /^[A-Za-z0-9_-]{8,100}$/;
/** One Genex credit in USD micros: a credit is one US cent. */
export const MICROS_PER_CREDIT = 10_000;

/** What a game asks of a model. Wire values: never rename one. */
export const AiOp = {
  /** Structured output: JSON that fits the call's schema. */
  Ask: "ask",
  /** Free text, streamed. */
  Say: "say",
  /** Classify a state against fixed questions (JSON). */
  Judge: "judge",
  /** Pick one tool of a fixed set (JSON). */
  Act: "act",
} as const;
export type AiOp = (typeof AiOp)[keyof typeof AiOp];

/** The messages a game's AI bridge sends, on every lane (Play preload, Create route, Play Protocol). */
export const AiBridgeOp = {
  Hello: "hello",
  /** The pill's state for the game: is AI on, and on which model. */
  Doors: "doors",
  Call: "call",
  Cancel: "cancel",
  /** The grant this game already holds, so a reload never asks again. */
  BudgetActive: "budget.active",
  /** Start AI for this game, inside a gesture: Genex picks, and asks only before plan or money is used. */
  BudgetRequest: "budget.request",
  /** The game turns its own AI off. */
  BudgetStop: "budget.stop",
} as const;
export type AiBridgeOp = (typeof AiBridgeOp)[keyof typeof AiBridgeOp];

/** How capable a model a call needs. */
export const AiTier = { Fast: "fast", Smart: "smart" } as const;
export type AiTier = (typeof AiTier)[keyof typeof AiTier];

/** Whether an answer stays with this player (`local`) or reaches other players (`shared`). */
export const AiAuthority = { Local: "local", Shared: "shared" } as const;
export type AiAuthority = (typeof AiAuthority)[keyof typeof AiAuthority];

/** Whether the game can run without AI; declared in `createAi()` and again at publish. */
export const AiRequirement = { Ai: "ai", Optional: "optional" } as const;
export type AiRequirement = (typeof AiRequirement)[keyof typeof AiRequirement];

/**
 * Where a call's tokens come from. Host doors run in main on this Mac; the two platform doors are
 * answered by genex.games (Genex credits, or the person's own plan through this Mac's watcher), so
 * their ledger, limits and Stop live on the server. Wire values: never rename one.
 */
export const AiDoor = {
  /** A model on this Mac: Bonsai, Ollama or a local server. Free. */
  Local: "local",
  /** OpenCode: its free models are free, the others bill the person's OpenCode account. */
  OpenCode: "opencode",
  /** The person's own OpenRouter key, billed by OpenRouter. */
  Byok: "byok",
  /** The person's Claude plan through Claude Code, in Create on their own game only. */
  Plan: "plan",
  /** The person's Claude or ChatGPT plan, queued on genex.games and answered by this Mac's watcher. */
  PlanWatcher: "plan-watcher",
  /** The player's Genex credits, dispatched and billed by genex.games. */
  GenexCredits: "genex-credits",
  /** The creator's Genex credits on the development lane (their own game's playtests). */
  GenexDev: "genex-dev",
  /** A saved playtest replayed. */
  Tape: "tape",
  /** A test fixture's answer. */
  Fixture: "fixture",
} as const;
export type AiDoor = (typeof AiDoor)[keyof typeof AiDoor];

/** The doors genex.games answers: a call on one goes through the platform lane, never through main. */
export const PLATFORM_DOORS: readonly AiDoor[] = [AiDoor.GenexCredits, AiDoor.PlanWatcher];

/** Whether a door is answered by genex.games rather than main. */
export const isPlatformDoor = (door: AiDoor): boolean => PLATFORM_DOORS.includes(door);

/** Where an answer came from, for results: a door, or a platform answer the server marks external. */
export const AiSource = { ...AiDoor, External: "external" } as const;
export type AiSource = (typeof AiSource)[keyof typeof AiSource];

/** How far an answer can be trusted. Wire values: never rename one. */
export const AiProvenance = {
  /** Genex dispatched and billed it: it may decide a leaderboard, a reward or shared state. */
  Verified: "verified",
  /** Any model the person runs or pays for themselves: it decides only their own game. */
  Unverified: "unverified",
  /** A saved playtest: agent-writable, so never verified. */
  Replay: "replay",
  Fixture: "fixture",
} as const;
export type AiProvenance = (typeof AiProvenance)[keyof typeof AiProvenance];

/** Only what Genex dispatched and billed is verified. */
export const PROVENANCE_OF = {
  [AiDoor.Local]: AiProvenance.Unverified,
  [AiDoor.OpenCode]: AiProvenance.Unverified,
  [AiDoor.Byok]: AiProvenance.Unverified,
  [AiDoor.Plan]: AiProvenance.Unverified,
  [AiDoor.PlanWatcher]: AiProvenance.Unverified,
  [AiDoor.GenexCredits]: AiProvenance.Verified,
  [AiDoor.GenexDev]: AiProvenance.Verified,
  [AiDoor.Tape]: AiProvenance.Replay,
  [AiDoor.Fixture]: AiProvenance.Fixture,
} as const satisfies Record<AiDoor, AiProvenance>;

/**
 * How the pill words what a model costs: in the words of the way it is paid. Wire values: never
 * rename one.
 */
export const AiFunding = {
  /** Nobody pays: a model on this Mac, or a free OpenCode model. */
  Free: "free",
  /** The person's Claude or ChatGPT plan: no extra cost, a share of its window. */
  Plan: "plan",
  /** Genex credits. */
  Credits: "credits",
  /** Billed by the provider to the person's own key or account. */
  Key: "key",
  /** A saved playtest, replayed: costs nothing. */
  Playtest: "playtest",
} as const;
export type AiFunding = (typeof AiFunding)[keyof typeof AiFunding];

/** Who pays through a door; OpenCode depends on the model, which the row says (`free`). */
const FUNDING_OF = {
  [AiDoor.Local]: AiFunding.Free,
  [AiDoor.OpenCode]: AiFunding.Key,
  [AiDoor.Byok]: AiFunding.Key,
  [AiDoor.Plan]: AiFunding.Plan,
  [AiDoor.PlanWatcher]: AiFunding.Plan,
  [AiDoor.GenexCredits]: AiFunding.Credits,
  [AiDoor.GenexDev]: AiFunding.Credits,
  [AiDoor.Tape]: AiFunding.Playtest,
  [AiDoor.Fixture]: AiFunding.Playtest,
} as const satisfies Record<AiDoor, AiFunding>;

/** How a model on `door` is paid for; a model the catalog marks free costs nothing on any door that bills. */
export function fundingOf(door: AiDoor, free: boolean): AiFunding {
  const funding = FUNDING_OF[door];
  return free && funding === AiFunding.Key ? AiFunding.Free : funding;
}

/** Whether using a door spends the person's plan or money: those are asked about once per game first. */
export const needsConsent = (door: AiDoor, free: boolean): boolean => {
  const funding = fundingOf(door, free);
  return funding === AiFunding.Plan || funding === AiFunding.Credits || funding === AiFunding.Key;
};

/** Why a call got no answer. Wire values: never rename one. */
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

const ERROR_CODES: ReadonlySet<string> = new Set(Object.values(AiErrorCode));
/** Whether a value is one of the error codes. */
export const isAiErrorCode = (value: unknown): value is AiErrorCode =>
  typeof value === "string" && ERROR_CODES.has(value);

/** What a door's engine failure answers a game with: a limit waits, a lost sign-in or an outage is a door down. */
export const AI_CODE_OF_FAILURE = {
  [EngineFailureKind.RateLimit]: AiErrorCode.RateLimited,
  [EngineFailureKind.UsageLimit]: AiErrorCode.WaitingForPlan,
  [EngineFailureKind.Auth]: AiErrorCode.DoorUnavailable,
  [EngineFailureKind.Unavailable]: AiErrorCode.DoorUnavailable,
  [EngineFailureKind.ContextThreshold]: AiErrorCode.TooLarge,
  [EngineFailureKind.ContextOverflow]: AiErrorCode.TooLarge,
  [EngineFailureKind.Aborted]: AiErrorCode.Canceled,
  [EngineFailureKind.Timeout]: AiErrorCode.Timeout,
  [EngineFailureKind.Other]: AiErrorCode.Provider,
} as const satisfies Record<EngineFailureKind, AiErrorCode>;

/** Where a game's grant stands. Wire values: never rename one. */
export const AiGrantStatus = {
  Active: "active",
  /** Its plan is resting until its window resets. */
  WaitingForPlan: "waiting_for_plan",
  /** Held at the person's daily alert or after two top-ups in a day, until they say go on. */
  Paused: "paused",
  /** The person turned AI off for the game. */
  Off: "off",
  /** Another model took its place; a game holds one live grant at a time. */
  Replaced: "replaced",
} as const;
export type AiGrantStatus = (typeof AiGrantStatus)[keyof typeof AiGrantStatus];

/** How a person agreed to a game's grant. Wire values: never rename one. */
export const AiConsent = {
  /** A free model started with no tap; only the pill's 4-second note said so. */
  Silent: "silent",
  /** The first-use card's Play. */
  Card: "card",
  /** A pick in the pill's model menu. */
  Menu: "menu",
  /** Settings → Play-time AI. */
  Settings: "settings",
} as const;
export type AiConsent = (typeof AiConsent)[keyof typeof AiConsent];

/** What a game plays on: Play (a published game) or Create (the person's own game in Studio). */
export const AiGameKind = { Play: "play", Create: "create" } as const;
export type AiGameKind = (typeof AiGameKind)[keyof typeof AiGameKind];

/**
 * A game as AI grants, the ledger and reports key it: `play:<genex.games project id>` (never the
 * slug, which can be renamed or reused) or `create:<library name>`. Main derives it; a page never
 * names it.
 */
export type AiGameKey = `${AiGameKind}:${string}`;

const GAME_KEY_RE = /^(play|create):([^\p{Cc}/\\]{1,128})$/u;
const DOT_SEGMENTS: ReadonlySet<string> = new Set([".", ".."]);

/** A game key as main accepts it from the renderer, or null. */
export function readAiGameKey(raw: unknown): AiGameKey | null {
  if (typeof raw !== "string") return null;
  const match = GAME_KEY_RE.exec(raw);
  const id = match?.[2];
  if (!match || id === undefined || DOT_SEGMENTS.has(id) || id.trim() !== id) return null;
  return match[1] === AiGameKind.Play ? `${AiGameKind.Play}:${id}` : `${AiGameKind.Create}:${id}`;
}

/** The key of a published game, by its genex.games project id. */
export const playGameKey = (projectId: string): AiGameKey => `${AiGameKind.Play}:${projectId}`;
/** The key of a game in the person's library, by its name. */
export const createGameKey = (project: string): AiGameKey => `${AiGameKind.Create}:${project}`;

/** A model on one door: the engine that runs it (`EngineId`, or `genex` for the platform) and its id. */
export interface AiModelRef {
  door: AiDoor;
  engine: string;
  model: string;
}

/** Tokens a provider reported for one call. */
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

/** One call from a game, as main accepts it: exact keys, every string bounded. */
export interface AiCallRequest {
  v: typeof GAME_AI_WIRE_VERSION;
  op: AiOp;
  site: string;
  ticket: string;
  grantId: string;
  system: string | null;
  prompt: string;
  untrusted: Record<string, string>;
  memory: string | null;
  /** The closed dialect of `game-ai-schema.ts`; null exactly for `say`. */
  schema: unknown;
  tier: AiTier;
  authority: AiAuthority;
  maxOutputTokens: number;
  stream: boolean;
}

/** What main answers a call with: a value and where it came from, or why there is none. */
export type AiCallAnswer =
  | {
      v: typeof GAME_AI_WIRE_VERSION;
      ok: true;
      ticket: string;
      value: unknown;
      source: AiSource;
      provenance: AiProvenance;
      latencyMs: number;
      cached: boolean;
    }
  | {
      v: typeof GAME_AI_WIRE_VERSION;
      ok: false;
      ticket: string;
      code: AiErrorCode;
      retryAfterMs: number | null;
    };

/** A game asking to start AI, inside a gesture. It names its need; Genex picks the model and the payer. */
export interface AiGrantRequest {
  v: typeof GAME_AI_WIRE_VERSION;
  requires: AiRequirement;
  /** The tiers its calls use, each once. */
  tiers: AiTier[];
}

/**
 * A grant as the game may see it: no account, no model id, no price list. Spend and plan share are
 * computed by main or the server, never by the page.
 */
export interface AiBudgetView {
  id: string;
  status: AiGrantStatus;
  door: AiDoor;
  /** Spent through this grant, in USD micros. */
  spentMicros: number;
  /** On a plan: the share of its current window used, 0–100; null on any other door. */
  planUsedPercent: number | null;
  /** On a plan: when its window resets (ISO); null on any other door or when unknown. */
  planResetsAt: string | null;
}

/** Credits for an amount in micros, rounded up: a spend is never shown smaller than it was. */
export const creditsOfMicros = (micros: number): number =>
  Number.isFinite(micros) && micros > 0 ? Math.ceil(micros / MICROS_PER_CREDIT) : 0;

/** Micros for whole credits. */
export const microsOfCredits = (credits: number): number =>
  Number.isFinite(credits) && credits > 0 ? Math.floor(credits) * MICROS_PER_CREDIT : 0;

// ── hostile-input readers ──────────────────────────────────────────────────────────────────

/** Keys that would reach an object's prototype when a reader copies them. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** A plain object: `{}` or `Object.create(null)`, never an array, a class instance or a proxy-like host object. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** How large a JSON tree a walk accepts: its nodes, its depth and its characters (strings and keys). */
export interface JsonBounds {
  nodes: number;
  depth: number;
  chars: number;
}

/** The bounds of one message from a game. */
export const AI_MESSAGE_BOUNDS: JsonBounds = {
  nodes: AI_MAX_WALK_NODES,
  depth: AI_MAX_WALK_DEPTH,
  chars: AI_MAX_BODY_CHARS,
};

/** How much of its bounds a walk has left. */
interface WalkBudget {
  nodes: number;
  chars: number;
  depth: number;
}

function walkArray(value: unknown[], budget: WalkBudget, depth: number): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !walk(value[index], budget, depth + 1)) return false;
  }
  return true;
}

function walkRecord(value: Record<string, unknown>, budget: WalkBudget, depth: number): boolean {
  for (const key of Object.keys(value)) {
    budget.chars -= key.length;
    if (FORBIDDEN_KEYS.has(key) || budget.chars < 0 || !walk(value[key], budget, depth + 1)) return false;
  }
  return true;
}

function walk(value: unknown, budget: WalkBudget, depth: number): boolean {
  budget.nodes -= 1;
  if (depth > budget.depth || budget.nodes < 0) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") {
    budget.chars -= value.length;
    return budget.chars >= 0;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return Object.getPrototypeOf(value) === Array.prototype && walkArray(value, budget, depth);
  return isPlainRecord(value) && walkRecord(value, budget, depth);
}

/**
 * True when a structured-clone value is a plain JSON tree inside `bounds` (a game message's by
 * default): cycles, deep nesting, huge or sparse arrays, non-finite numbers, class instances and
 * prototype keys are refused before anything serializes it. Never throws.
 */
export function isBoundedJson(value: unknown, bounds: JsonBounds = AI_MESSAGE_BOUNDS): boolean {
  return walk(value, { nodes: bounds.nodes, chars: bounds.chars, depth: bounds.depth }, 0);
}

/** A record's own keys are exactly `keys`. */
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** A value of a vocabulary, or null. */
export function readMember<V extends string>(vocabulary: Readonly<Record<string, V>>, raw: unknown): V | null {
  return Object.values(vocabulary).find((member) => member === raw) ?? null;
}

const encoder = new TextEncoder();

/** UTF-8 bytes of a string. */
export const utf8Bytes = (text: string): number => encoder.encode(text).length;

/**
 * Whether the strings (nulls skipped) together fit in `max` UTF-8 bytes. Every UTF-16 unit is one
 * to three bytes, so lengths alone settle most cases and only a close call is encoded, and never a
 * string longer than the cap.
 */
export function fitsBytes(texts: ReadonlyArray<string | null>, max: number): boolean {
  const present = texts.filter((text): text is string => text !== null);
  const units = present.reduce((sum, text) => sum + text.length, 0);
  if (units > max) return false;
  if (units * 3 <= max) return true;
  return present.reduce((sum, text) => sum + utf8Bytes(text), 0) <= max;
}

const textOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";

/** The player-typed fields, bounded and keyed like call sites, or null. */
function readUntrusted(raw: unknown): Record<string, string> | null {
  if (!isPlainRecord(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length > AI_MAX_UNTRUSTED_FIELDS) return null;
  const fields: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!AI_SITE_RE.test(key) || typeof value !== "string") return null;
    if (!fitsBytes([value], AI_MAX_UNTRUSTED_BYTES)) return null;
    fields[key] = value;
  }
  return fields;
}

const isOutputTokens = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= AI_MAX_OUTPUT_TOKENS;

const CALL_KEYS = [
  "v",
  "op",
  "site",
  "ticket",
  "grantId",
  "system",
  "prompt",
  "untrusted",
  "memory",
  "schema",
  "tier",
  "authority",
  "maxOutputTokens",
  "stream",
] as const satisfies readonly (keyof AiCallRequest)[];

/** The schema is null exactly for `say`, and a schema fits its byte cap. */
function schemaFits(op: AiOp, schema: unknown): boolean {
  if ((op === AiOp.Say) !== (schema === null)) return false;
  return schema === null || fitsBytes([JSON.stringify(schema)], AI_MAX_SCHEMA_BYTES);
}

const isText = (value: unknown, shape: RegExp): value is string => typeof value === "string" && shape.test(value);

/** A prompt with words in it. */
const isPrompt = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/**
 * A call from untrusted game code as main accepts it, or null. The tree is walked under its bounds
 * first, then rebuilt field by field: no field is cast, and nothing the game sent beyond the
 * listed keys survives. Pure; never throws.
 */
export function readAiCallRequest(raw: unknown): AiCallRequest | null {
  if (!isBoundedJson(raw) || !isPlainRecord(raw) || !hasExactKeys(raw, CALL_KEYS)) return null;
  const { v, site, ticket, grantId, system, prompt, memory, schema, maxOutputTokens, stream } = raw;
  const op = readMember(AiOp, raw.op);
  const tier = readMember(AiTier, raw.tier);
  const authority = readMember(AiAuthority, raw.authority);
  const untrusted = readUntrusted(raw.untrusted);
  if (!op || !tier || !authority || !untrusted || v !== GAME_AI_WIRE_VERSION) return null;
  if (!isText(site, AI_SITE_RE) || !isText(ticket, AI_ID_RE) || !isText(grantId, AI_ID_RE)) return null;
  if (!isPrompt(prompt) || !textOrNull(system) || !textOrNull(memory)) return null;
  if (!fitsBytes([system, prompt, memory], AI_MAX_PROMPT_BYTES) || !schemaFits(op, schema)) return null;
  if (!isOutputTokens(maxOutputTokens) || typeof stream !== "boolean") return null;
  return {
    v: GAME_AI_WIRE_VERSION,
    op,
    site,
    ticket,
    grantId,
    system,
    prompt,
    untrusted,
    memory,
    schema,
    tier,
    authority,
    maxOutputTokens,
    stream,
  };
}

const GRANT_KEYS = ["v", "requires", "tiers"] as const satisfies readonly (keyof AiGrantRequest)[];

/** The tiers a grant request names: one to all of them, each once. */
function readTiers(raw: unknown): AiTier[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > Object.keys(AiTier).length) return null;
  const tiers: AiTier[] = [];
  for (const item of raw) {
    const tier = readMember(AiTier, item);
    if (!tier || tiers.includes(tier)) return null;
    tiers.push(tier);
  }
  return tiers;
}

/** A grant request from untrusted game code as main accepts it, or null. Pure; never throws. */
export function readAiGrantRequest(raw: unknown): AiGrantRequest | null {
  if (!isBoundedJson(raw) || !isPlainRecord(raw) || !hasExactKeys(raw, GRANT_KEYS)) return null;
  const requires = readMember(AiRequirement, raw.requires);
  const tiers = readTiers(raw.tiers);
  if (raw.v !== GAME_AI_WIRE_VERSION || !requires || !tiers) return null;
  return { v: GAME_AI_WIRE_VERSION, requires, tiers };
}

/** A ticket from untrusted game code (a Cancel), or null. */
export const readAiTicket = (raw: unknown): string | null => (isText(raw, AI_ID_RE) ? raw : null);

/** A refusal for a ticket. */
export const refusedAnswer = (ticket: string, code: AiErrorCode, retryAfterMs: number | null = null): AiCallAnswer => ({
  v: GAME_AI_WIRE_VERSION,
  ok: false,
  ticket,
  code,
  retryAfterMs,
});
