/**
 * The harness's own view of its host: the object the bootstrap hands `createStudio`, and the ctx
 * every piece of loop and tool code is given (`loop/main.ts` scopes one per thread).
 *
 * `ctx.call(method, params)` is typed by `HarnessHostApi` (`host-api.d.ts`, generated from the
 * app's contract): a method name the host does not serve, a param it does not take, or a result
 * read as something it is not fails the typecheck. This file is yours; `host-api.d.ts` is not.
 */
import type {
  EventData,
  EventEnvelope,
  HarnessHostApi,
  HarnessHostMethod,
  MessageImage,
  ModelPreferences,
  RunSpec,
} from "./host-api.d.ts";
import type { RunInbox } from "../loop/run-inbox.ts";

/**
 * A record the harness reads without a schema — a custom event's payload, a journal it saved
 * earlier, JSON a model wrote — and so reads defensively, field by field.
 */
// biome-ignore lint/suspicious/noExplicitAny: schemaless data, read defensively at each use.
export type AnyRecord = Record<string, any>;

/** What `ctx.call(method, …)` sends. A method that takes nothing is sent `{}`, or nothing. */
export type CallParams<M extends HarnessHostMethod> = HarnessHostApi[M]["params"] extends void
  ? Record<string, never> | void
  : HarnessHostApi[M]["params"];

/** A logged event's data as the harness reads it: a custom event's payload is whatever its writer put there. */
export type HarnessEventData =
  | Exclude<EventData, { type: "custom" }>
  | { type: "custom"; event_type: string; payload?: AnyRecord };

/**
 * A logged event as the harness reads it (`events.list`). `data.type` still tells the kinds
 * apart; any other field reads without a check first, as the loop has always read the log.
 */
export type HarnessEvent = Omit<EventEnvelope, "data"> & { data: HarnessEventData & AnyRecord };

/** Results the harness reads through a looser view than the contract states. */
interface ReadAs {
  "events.list": HarnessEvent[];
  "events.inbox": Array<{ threadId: string; events: HarnessEvent[] }>;
  /**
   * An artifact is whatever JSON the harness wrote under that id (a run's journal, a staged
   * list, the director's memory); the host stores it without a schema, so reading one back is
   * as loose as the value that was written.
   */
  // biome-ignore lint/suspicious/noExplicitAny: schemaless JSON the harness itself wrote
  "artifact.read": any;
}

/** What `ctx.call(method, …)` resolves to. */
export type CallResult<M extends HarnessHostMethod> = M extends keyof ReadAs ? ReadAs[M] : HarnessHostApi[M]["result"];

/** The methods whose params may be left out: they take nothing, or only optional fields. */
export type OptionalParamsMethod = {
  [M in HarnessHostMethod]: HarnessHostApi[M]["params"] extends void
    ? M
    : {} extends HarnessHostApi[M]["params"]
      ? M
      : never;
}[HarnessHostMethod];

/** One call to the host — the only way out of the harness process. */
export interface HostCall {
  <M extends OptionalParamsMethod>(method: M, params?: CallParams<M>): Promise<CallResult<M>>;
  <M extends HarnessHostMethod>(method: M, params: CallParams<M>): Promise<CallResult<M>>;
}

/** The same call seen by code that forwards a method it does not know, like a wrapper around ctx.call. */
// biome-ignore lint/suspicious/noExplicitAny: a forwarded method has no contract to read a result by
export type ForwardedCall = (method: string, params?: unknown) => Promise<any>;

/** What the bootstrap (`harness-boot/bootstrap.mjs`, shipped in the app) hands `createStudio`. */
export interface Host {
  call: HostCall;
  notify(type: string, payload?: unknown): void;
  heartbeat(status: string): void;
  /** The harness workspace: this code's own folder. */
  workspace: string;
}

/** The ctx a unit of work runs with: scoped to one thread, with its own status line and stop flag. */
export interface HarnessCtx {
  /** The host this ctx was scoped from (main.ts `scoped`); carried, never read by the loop. */
  host?: Pick<Host, "call" | "notify" | "workspace">;
  call: HostCall;
  notify(type: string, payload?: unknown): void;
  workspace: string;
  threadId: string;
  /** The user stopped this thread's work (or the harness is shutting down). */
  readonly cancelled: boolean;
  setStatus(status: string): void;
  /** The open run's inbox, when a run is under way on this thread. */
  runInbox?: RunInbox;
}

/**
 * A run as the loop carries it: the spec the host dispatched (`run_start`), and what the loop
 * stamps on it at launch — its roles, the game it declared, the state its judges look at.
 */
export interface Run extends RunSpec {
  /** The knobs the spec names, plus the ones only tests and operations set (`outageDelays`, …). */
  budgets: RunSpec["budgets"] & AnyRecord;
  /** The state every judge looks at when the game does not boot into it (scout.ts). */
  setup?: AnyRecord | null;
  /** The declared kind of game, its traits and play script (kinds.ts). */
  game?: AnyRecord | null;
  genres?: string[];
  /** The folder brought its own game (not the studio's template). */
  ownShape?: boolean;
  preferences?: ModelPreferences;
  effort?: string;
  /** What `game.validate` said about the folder when the run was asked for. */
  readiness?: AnyRecord | null;
  /** What earlier runs on this game cost (ledger.ts), one sentence each. */
  gameLessons?: string[];
  /** The generation of an edited, older `src/hud.js` the game keeps (held-hud.ts); absent when it holds the template's. */
  heldHudGeneration?: number;
  blender?: unknown;
  optimizationDeadline?: number;
  optimizationThreadId?: string;
  [field: string]: unknown;
}

/**
 * The ctx a tool runs with: the turn's ctx plus the turn's own options — the game the chat is
 * pinned to, the candidate it may only read, the commission an interview carries.
 */
export interface ToolCtx extends HarnessCtx {
  project?: string | null;
  candidateId?: string;
  turnId?: string;
  engine?: string;
  model?: string;
  effort?: string;
  loop?: AnyRecord | null;
  autopilot?: AnyRecord | null;
  [option: string]: unknown;
}

/** What a tool answers: a sentence, or a result with the sentence in `content`. */
export interface ToolOutcome {
  ok?: boolean;
  content?: string;
  details?: AnyRecord;
  images?: MessageImage[];
  /** Ends the turn after this round: `restart` for a self-restart, `done` for a question asked. */
  stopTurn?: string;
}

/** A tool the model can call: a `tools/*.ts` module exports an array of these as `tools`. */
export interface HarnessTool {
  name: string;
  description?: string;
  parameters?: AnyRecord;
  execute(args: AnyRecord, ctx: ToolCtx): Promise<ToolOutcome | string> | ToolOutcome | string;
}
