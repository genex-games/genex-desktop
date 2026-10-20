/**
 * The game-facing types of `genex-ai`: what a game asks (`ask`, `say`, `judge`, `act`), the
 * ticket it gets back, the result `drain()` hands it, and the status `state().ai` copies. Mirrored
 * for builder agents in `src/game-template/src/ai.d.ts`; `tests/conformance/genex-ai-surface.test.ts`
 * holds the two together.
 */
import type {
  AiAuthority,
  AiBudgetView,
  AiDoor,
  AiErrorCode,
  AiOp,
  AiProvenance,
  AiRequirement,
  AiSource,
  AiTier,
} from "../../shared/game-ai.ts";
import type { AiLane } from "../../shared/game-ai-lane.ts";
import type { AiMemory } from "./memory.ts";
import type { Infer, Schema } from "./schema.ts";

/** Why a call got no answer, as a fallback function reads it. */
export interface AiFailure {
  code: AiErrorCode;
  site: string;
  /** When the code says to wait (a plan resting, a rate limit), how long; else null. */
  retryAfterMs: number | null;
}

/** What every call names. */
export interface CallBase<T> {
  /** The call site's stable name: its key in the saved playtest and its row in the bench. */
  site: string;
  /** Static words the model reads first (the world's rules, a persona): the same on every call. */
  system?: string;
  /** What the game composes for this call. Never text the player typed: that goes in `untrusted`. */
  prompt: string;
  /** Player-typed text by name, fenced on every lane as text the model must never obey. */
  untrusted?: Readonly<Record<string, string>>;
  /** A rolling memory the call carries (`ai.memory()`). */
  memory?: AiMemory;
  tier?: AiTier;
  /** `shared` when other players see the answer or a leaderboard counts it: only Genex credits answer it. */
  authority?: AiAuthority;
  /** The most output tokens the answer may take. */
  maxOutputTokens?: number;
  /** Published games only: the call's ceiling in Genex credits, from the bench. */
  maxCredits?: number;
  /** What the game plays when no answer comes: a value, or one made from the failure. */
  fallback?: T | ((failure: AiFailure) => T);
}

/** Structured output: JSON that fits `schema`. */
export interface AskRequest<S extends Schema> extends CallBase<Infer<S>> {
  schema: S;
}

/** Free text, streamed (`ticket.partial()`). */
export interface SayRequest extends CallBase<string> {
  /** The longest answer the game keeps, in characters; the rest is cut. */
  maxChars?: number;
}

/** How a judge question is answered. Wire values: never rename one. */
export const AiJudgeKind = {
  /** A probability from 0 to 1 that the answer is yes. */
  YesNo: "yes-no",
  /** The name of one of the question's options. */
  Choice: "choice",
  /** A level from 0 (the lowest) to `levels.length - 1`. */
  Score: "score",
} as const;
export type AiJudgeKind = (typeof AiJudgeKind)[keyof typeof AiJudgeKind];

/** One question a judge call answers about the game's state. */
export type JudgeQuestion =
  | { kind: typeof AiJudgeKind.YesNo; instructions: string; yes?: string; no?: string }
  | { kind: typeof AiJudgeKind.Choice; instructions: string; options: Readonly<Record<string, string>> }
  | { kind: typeof AiJudgeKind.Score; instructions: string; levels: readonly string[] };

/** A judge call's questions, by name. */
export type JudgeQuestions = Readonly<Record<string, JudgeQuestion>>;

/** The answer to one question. */
export type JudgeAnswer<Q extends JudgeQuestion> = Q extends { kind: typeof AiJudgeKind.Choice; options: infer O }
  ? keyof O & string
  : number;

/** A judge call's answers, by question. */
export type JudgeAnswers<Q extends JudgeQuestions> = { [K in keyof Q]: JudgeAnswer<Q[K]> };

/** Classify the game's state against fixed questions. */
export interface JudgeRequest<Q extends JudgeQuestions>
  extends Omit<CallBase<JudgeAnswers<Q>>, "system" | "prompt" | "memory"> {
  questions: Q;
  /** The state the questions are about: plain JSON. */
  state: unknown;
  /** Extra words the judge reads before the questions. */
  prompt?: string;
}

/** One tool an act call may pick, and the shape of its arguments. */
export interface ToolSpec<S extends Schema = Schema> {
  description: string;
  args: S;
}

/** An act call's tools, by name. */
export type ToolSet = Readonly<Record<string, ToolSpec>>;

/** The tool an act call picked, with its arguments. */
export type ToolCall<T extends ToolSet> = { [K in keyof T & string]: { tool: K; args: Infer<T[K]["args"]> } }[keyof T &
  string];

/** Pick exactly one tool of a fixed set. */
export interface ActRequest<T extends ToolSet> extends CallBase<ToolCall<T>> {
  tools: T;
}

/** A call on its way. */
export interface AiTicket<T> {
  readonly id: string;
  readonly site: string;
  /** A `say` answer's text so far while it streams; null before any arrives and on other ops. */
  partial(): string | null;
  /** The call's result once `drain()` released it; null before. */
  result(): AiResult<T> | null;
  /** Stop waiting for the answer: it arrives as `canceled`, with no fallback. False once it is released. */
  cancel(): boolean;
}

/** What `drain()` hands the game: the answer, or why there is none and the fallback played. */
export type AiResult<T = unknown> =
  | {
      ticket: string;
      site: string;
      op: AiOp;
      ok: true;
      value: T;
      code: null;
      fallback: false;
      source: AiSource;
      provenance: AiProvenance;
      /** The drain it was released on. */
      frame: number;
    }
  | {
      ticket: string;
      site: string;
      op: AiOp;
      ok: false;
      /** The fallback, or null when the call had none (or was canceled). */
      value: T | null;
      code: AiErrorCode;
      fallback: boolean;
      source: null;
      provenance: null;
      frame: number;
    };

/** How a game started its AI, and what it asks of a published game's Genex credits. */
export interface CreateAiOptions {
  /** Every call site the game uses; a call naming another is refused `bad_request`. */
  sites?: readonly string[];
  /** `ai` when the game means nothing without a model; `optional` (the default) when it plays on. */
  requires?: AiRequirement;
  /** A published game's terms on genex.games (the platform lane). */
  platform?: PlatformOptions;
}

/** The period a published game's call estimate is per. Wire values (genex.games' own): never rename one. */
export const AiGrantPeriod = { Minute: "minute", Hour: "hour", Session: "session" } as const;
export type AiGrantPeriod = (typeof AiGrantPeriod)[keyof typeof AiGrantPeriod];

/** A published game's terms on genex.games: what the player's grant sheet shows and bounds. */
export interface PlatformOptions {
  /** The genex.games model id each tier calls; omitted, Genex's featured models are used. */
  models?: Partial<Record<AiTier, string>>;
  /** The most one call may cost, in Genex credits (`genex llm bench`). */
  maxCredits?: number;
  /** The honest guess of calls the game makes per `period`. */
  callsPerPeriod?: number;
  period?: AiGrantPeriod;
  /** The honest guess of judge calls per `period`; omitted, the grant does not cover `judge`. */
  judgeCallsPerPeriod?: number;
  /** Let the player answer from their own Claude or ChatGPT plan (never for a leaderboard). */
  allowPlan?: boolean;
  /** `@genex-ai/embed-sdk` as the game imports it, for a game that bundles its own copy. */
  sdk?: unknown;
}

/** The game's AI as `state().ai` reports it: JSON, and the same for the same seed and steps. */
export interface AiStatus {
  /** Where answers come from; null until `ready()`. */
  lane: AiLane | null;
  requires: AiRequirement;
  /** AI can answer here (a hint or main said so). */
  on: boolean;
  /** The door the game's grant names; null without one. */
  door: AiDoor | null;
  /** Drains so far. */
  frame: number;
  /** Calls made and not yet released by `drain()`. */
  pending: number;
  calls: number;
  answered: number;
  fallbacks: number;
  /** Calls the saved playtest had no answer for. */
  misses: number;
  /** Refusals by code (`no_gesture` counts grants asked for outside a click or key). */
  refused: Partial<Record<AiErrorCode, number>>;
  /** An AI-only game got a refusal it cannot play past: Studio shows its "needs AI" state. */
  needsAi: AiErrorCode | null;
  /** The game drew `ai.disclosure()`. */
  disclosed: boolean;
  /** The saved playtest that answers, by demo; null on other lanes. */
  tape: string | null;
}

/** The HUD chip a game draws once it uses AI. */
export interface AiDisclosure {
  text: string;
  anchor: "top-right";
}

/** The one way a game asks a model at play time. */
export interface GameAi {
  /** Settles the lane and loads the saved playtest, so replay is frame-exact. Await it before the first frame. */
  ready(): Promise<void>;
  ask<S extends Schema>(request: AskRequest<S>): AiTicket<Infer<S>>;
  say(request: SayRequest): AiTicket<string>;
  judge<Q extends JudgeQuestions>(request: JudgeRequest<Q>): AiTicket<JudgeAnswers<Q>>;
  act<T extends ToolSet>(request: ActRequest<T>): AiTicket<ToolCall<T>>;
  /** A rolling memory calls can carry, saved with the game. */
  memory(name: string, options?: { keep?: number }): AiMemory;
  /** Once per `update()`: the only way answers enter the game. */
  drain(): readonly AiResult[];
  /** The grant the person already gave this game, so a reload never asks again. */
  activeBudget(): Promise<AiBudgetView | null>;
  /** Start AI for the game, inside a click or key handler: Genex picks, and asks only before plan or money. */
  requestBudget(options?: { tiers?: readonly AiTier[] }): Promise<AiBudgetView | null>;
  /** The game turns its own AI off. */
  stopBudget(): Promise<void>;
  status(): AiStatus;
  /** The "AI-generated" chip; drawing it marks the disclosure shown. */
  disclosure(): AiDisclosure;
}
