/**
 * `genex-ai`, typed: the one way this game asks a model while it is played. The page imports it
 * by name (`import { createAi, s } from "genex-ai"`); `index.html`'s import map points the name
 * at Studio's copy, and a TypeScript build resolves it to this declaration. How to use it, the
 * lanes and every failure code: `docs/AI.md`.
 *
 * Keep it in step with Studio's `genex-ai`: Studio's tests hold the two together.
 */
declare module "genex-ai" {
  /** What a game asks of a model. */
  export const AiOp: { readonly Ask: "ask"; readonly Say: "say"; readonly Judge: "judge"; readonly Act: "act" };
  export type AiOp = (typeof AiOp)[keyof typeof AiOp];

  /** How capable a model a call needs: `fast` for small calls, `smart` for the one a turn turns on. */
  export const AiTier: { readonly Fast: "fast"; readonly Smart: "smart" };
  export type AiTier = (typeof AiTier)[keyof typeof AiTier];

  /** `shared` when other players see the answer or a leaderboard counts it: only Genex credits answer it. */
  export const AiAuthority: { readonly Local: "local"; readonly Shared: "shared" };
  export type AiAuthority = (typeof AiAuthority)[keyof typeof AiAuthority];

  /** `ai` when the game means nothing without a model; `optional` when it plays on without one. */
  export const AiRequirement: { readonly Ai: "ai"; readonly Optional: "optional" };
  export type AiRequirement = (typeof AiRequirement)[keyof typeof AiRequirement];

  /** Where the game's grant gets its answers. The game never picks one: Genex does, with the person. */
  export const AiDoor: {
    readonly Local: "local";
    readonly OpenCode: "opencode";
    readonly Byok: "byok";
    readonly Plan: "plan";
    readonly PlanWatcher: "plan-watcher";
    readonly GenexCredits: "genex-credits";
    readonly GenexDev: "genex-dev";
    readonly Tape: "tape";
    readonly Fixture: "fixture";
  };
  export type AiDoor = (typeof AiDoor)[keyof typeof AiDoor];

  /** Where an answer came from. */
  export const AiSource: {
    readonly Local: "local";
    readonly OpenCode: "opencode";
    readonly Byok: "byok";
    readonly Plan: "plan";
    readonly PlanWatcher: "plan-watcher";
    readonly GenexCredits: "genex-credits";
    readonly GenexDev: "genex-dev";
    readonly Tape: "tape";
    readonly Fixture: "fixture";
    readonly External: "external";
  };
  export type AiSource = (typeof AiSource)[keyof typeof AiSource];

  /** How far an answer can be trusted: only `verified` may decide a leaderboard, a reward or shared state. */
  export const AiProvenance: {
    readonly Verified: "verified";
    readonly Unverified: "unverified";
    readonly Replay: "replay";
    readonly Fixture: "fixture";
  };
  export type AiProvenance = (typeof AiProvenance)[keyof typeof AiProvenance];

  /** Why a call got no answer (`docs/AI.md` says what the game does for each). */
  export const AiErrorCode: {
    readonly Off: "ai_off";
    readonly Unrecorded: "ai_unrecorded";
    readonly DirectBlocked: "ai_direct_blocked";
    readonly BadRequest: "bad_request";
    readonly TooLarge: "prompt_too_large";
    readonly InvalidSchema: "invalid_schema";
    readonly InvalidOutput: "invalid_output";
    readonly ConsentRequired: "consent_required";
    readonly ConsentDeclined: "consent_declined";
    readonly ConsentPending: "consent_pending";
    readonly NoGesture: "no_gesture";
    readonly Paused: "ai_paused";
    readonly Concurrency: "grant_concurrency";
    readonly RateLimited: "grant_rate_limited";
    readonly WaitingForPlan: "waiting_for_plan";
    readonly DoorUnavailable: "door_unavailable";
    readonly LocalLoading: "local_model_loading";
    readonly NoFunding: "no_funding";
    readonly PlatformDoor: "platform_door";
    readonly NeedsVerified: "needs_verified";
    readonly PlanNotAllowed: "plan_door_not_allowed";
    readonly OutOfCredits: "insufficient_credits";
    readonly MonthlyLimit: "monthly_limit";
    readonly Moderated: "moderated";
    readonly Timeout: "timeout";
    readonly Provider: "provider";
    readonly Canceled: "canceled";
  };
  export type AiErrorCode = (typeof AiErrorCode)[keyof typeof AiErrorCode];

  /** How a judge question is answered. */
  export const AiJudgeKind: { readonly YesNo: "yes-no"; readonly Choice: "choice"; readonly Score: "score" };
  export type AiJudgeKind = (typeof AiJudgeKind)[keyof typeof AiJudgeKind];

  /** The period a published game's call estimate is per. */
  export const AiGrantPeriod: { readonly Minute: "minute"; readonly Hour: "hour"; readonly Session: "session" };
  export type AiGrantPeriod = (typeof AiGrantPeriod)[keyof typeof AiGrantPeriod];

  // ── schemas ──────────────────────────────────────────────────────────────────────────────

  /** A schema of the closed dialect: no `$ref`, `pattern`, `anyOf` or `format`, every object closed, five deep at most. */
  export interface AiOutputSchema {
    type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
    description?: string;
    title?: string;
    properties?: Record<string, AiOutputSchema>;
    required?: string[];
    additionalProperties?: false;
    items?: AiOutputSchema;
    enum?: Array<string | number | boolean | null>;
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    minItems?: number;
    maxItems?: number;
  }

  /** A schema that admits values of type `T` (built with `s`); `~admits` is never there at run time. */
  export type Schema<T = unknown> = AiOutputSchema & { readonly "~admits"?: T };
  /** The type of value a schema admits. */
  export type Infer<S> = S extends Schema<infer T> ? T : never;
  export type Shape = Readonly<Record<string, Schema>>;
  export type InferShape<P extends Shape> = { [K in keyof P]: Infer<P[K]> };

  export interface StringOptions {
    /** The longest the string may be, in characters: bound every string a model writes. */
    max?: number;
    min?: number;
    description?: string;
  }

  /** The schema builders. A shape the dialect refuses is refused at the call (`invalid_schema`), never thrown. */
  export const s: {
    readonly string: (options?: StringOptions) => Schema<string>;
    readonly int: (min: number, max: number, description?: string) => Schema<number>;
    readonly number: (min: number, max: number, description?: string) => Schema<number>;
    readonly bool: (description?: string) => Schema<boolean>;
    readonly oneOf: <const V extends readonly string[]>(values: V, description?: string) => Schema<V[number]>;
    readonly list: <S extends Schema>(item: S, max: number, min?: number) => Schema<Infer<S>[]>;
    readonly object: <P extends Shape>(properties: P, description?: string) => Schema<InferShape<P>>;
    readonly describe: <S extends Schema>(schema: S, description: string) => S;
  };

  /** Why a schema is refused (the code `ai_schema_check` explains), or null when the dialect takes it. */
  export function checkSchema(schema: unknown): string | null;

  // ── calls ────────────────────────────────────────────────────────────────────────────────

  /** One remembered line. */
  export interface AiMemoryLine {
    role: string;
    text: string;
  }

  /** A memory as it saves with the game. */
  export interface AiMemorySnapshot {
    v: 1;
    name: string;
    lines: AiMemoryLine[];
  }

  /** A rolling memory calls can carry (`ai.memory()`), saved with the game. */
  export interface AiMemory {
    readonly name: string;
    readonly keep: number;
    remember(role: string, text: string): void;
    lines(): readonly AiMemoryLine[];
    text(): string | null;
    snapshot(): AiMemorySnapshot;
    /** A save the player may have edited: false, and nothing changes, when it does not read. */
    restore(snapshot: unknown): boolean;
    /** Ask the model to fold everything into one line, applied on a later `drain()`. */
    compact(site: string): void;
    clear(): void;
  }

  /** Why a call got no answer, as a fallback function reads it. */
  export interface AiFailure {
    code: AiErrorCode;
    site: string;
    retryAfterMs: number | null;
  }

  /** What every call names. */
  export interface CallBase<T> {
    /** The call site's stable name: its key in the saved playtest and its row in the bench. */
    site: string;
    /** Static words the model reads first: the same on every call. */
    system?: string;
    /** What the game composes. Never text the player typed: that goes in `untrusted`. */
    prompt: string;
    /** Player-typed text by name, fenced on every lane as text the model must never obey. */
    untrusted?: Readonly<Record<string, string>>;
    memory?: AiMemory;
    tier?: AiTier;
    authority?: AiAuthority;
    maxOutputTokens?: number;
    /** Published games only: the call's ceiling in Genex credits, from the bench. */
    maxCredits?: number;
    /** What the game plays when no answer comes. Without one, a failure arrives with `value: null`. */
    fallback?: T | ((failure: AiFailure) => T);
  }

  export interface AskRequest<S extends Schema> extends CallBase<Infer<S>> {
    schema: S;
  }

  export interface SayRequest extends CallBase<string> {
    maxChars?: number;
  }

  export type JudgeQuestion =
    | { kind: typeof AiJudgeKind.YesNo; instructions: string; yes?: string; no?: string }
    | { kind: typeof AiJudgeKind.Choice; instructions: string; options: Readonly<Record<string, string>> }
    | { kind: typeof AiJudgeKind.Score; instructions: string; levels: readonly string[] };
  export type JudgeQuestions = Readonly<Record<string, JudgeQuestion>>;
  export type JudgeAnswer<Q extends JudgeQuestion> = Q extends {
    kind: typeof AiJudgeKind.Choice;
    options: infer O;
  }
    ? keyof O & string
    : number;
  export type JudgeAnswers<Q extends JudgeQuestions> = { [K in keyof Q]: JudgeAnswer<Q[K]> };

  export interface JudgeRequest<Q extends JudgeQuestions>
    extends Omit<CallBase<JudgeAnswers<Q>>, "system" | "prompt" | "memory"> {
    questions: Q;
    state: unknown;
    prompt?: string;
  }

  export interface ToolSpec<S extends Schema = Schema> {
    description: string;
    args: S;
  }
  export type ToolSet = Readonly<Record<string, ToolSpec>>;
  export type ToolCall<T extends ToolSet> = {
    [K in keyof T & string]: { tool: K; args: Infer<T[K]["args"]> };
  }[keyof T & string];

  export interface ActRequest<T extends ToolSet> extends CallBase<ToolCall<T>> {
    tools: T;
  }

  /** A call on its way. */
  export interface AiTicket<T> {
    readonly id: string;
    readonly site: string;
    /** A `say` answer's text so far. */
    partial(): string | null;
    result(): AiResult<T> | null;
    /** Stop waiting: it arrives as `canceled`, with no fallback. */
    cancel(): boolean;
  }

  /** What `drain()` hands the game. */
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
        frame: number;
      }
    | {
        ticket: string;
        site: string;
        op: AiOp;
        ok: false;
        value: T | null;
        code: AiErrorCode;
        fallback: boolean;
        source: null;
        provenance: null;
        frame: number;
      };

  /** A published game's terms on genex.games. */
  export interface PlatformOptions {
    models?: Partial<Record<AiTier, string>>;
    maxCredits?: number;
    callsPerPeriod?: number;
    period?: AiGrantPeriod;
    judgeCallsPerPeriod?: number;
    allowPlan?: boolean;
    sdk?: unknown;
  }

  export interface CreateAiOptions {
    /** Every call site the game uses. */
    sites?: readonly string[];
    requires?: AiRequirement;
    platform?: PlatformOptions;
  }

  /** A grant as the game may see it: no model, no price. */
  export interface AiBudgetView {
    id: string;
    status: "active" | "waiting_for_plan" | "paused" | "off" | "replaced";
    door: AiDoor;
    spentMicros: number;
    planUsedPercent: number | null;
    planResetsAt: string | null;
  }

  /** The game's AI as `__studio.state().ai` reports it. */
  export interface AiStatus {
    lane: "off" | "tape" | "mock" | "edge" | "host" | "platform" | null;
    requires: AiRequirement;
    on: boolean;
    door: AiDoor | null;
    frame: number;
    pending: number;
    calls: number;
    answered: number;
    fallbacks: number;
    misses: number;
    refused: Partial<Record<AiErrorCode, number>>;
    needsAi: AiErrorCode | null;
    disclosed: boolean;
    tape: string | null;
  }

  export interface AiDisclosure {
    text: string;
    anchor: "top-right";
  }

  /** The game's AI. */
  export interface GameAi {
    /** Await before the first frame: replay is frame-exact only once the saved playtest is loaded. */
    ready(): Promise<void>;
    ask<S extends Schema>(request: AskRequest<S>): AiTicket<Infer<S>>;
    say(request: SayRequest): AiTicket<string>;
    judge<Q extends JudgeQuestions>(request: JudgeRequest<Q>): AiTicket<JudgeAnswers<Q>>;
    act<T extends ToolSet>(request: ActRequest<T>): AiTicket<ToolCall<T>>;
    memory(name: string, options?: { keep?: number }): AiMemory;
    /** Once per `update()`: the only way answers enter the game. */
    drain(): readonly AiResult[];
    activeBudget(): Promise<AiBudgetView | null>;
    /** Inside a click or key handler only. */
    requestBudget(options?: { tiers?: readonly AiTier[] }): Promise<AiBudgetView | null>;
    stopBudget(): Promise<void>;
    status(): AiStatus;
    /** The "AI-generated" chip; drawing it marks the disclosure shown. */
    disclosure(): AiDisclosure;
  }

  /** Start the game's AI, once, at boot. */
  export function createAi(options?: CreateAiOptions): GameAi;
}
