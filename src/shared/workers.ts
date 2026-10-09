/**
 * Genex's one worker model, as the app and the harness both name it: the tools a lead runs workers
 * with, how a worker stands in the project, the lead's word on what one delivered, the kinds of
 * worker a plugin declares, and the records a worker leaves when it starts and ends. Renderer-safe
 * (no Node). The harness's copy is `loop/workers/contract.ts`, held to this one by
 * `seed-contracts.test.ts`.
 */
import type { RunScope } from "./custom-events.ts";
import type { GameEngine } from "./game-engine.ts";

/** The tools a lead runs its workers with, by the names its engine sends: never rename a value. */
export const WorkerTool = {
  Start: "worker_start",
  Status: "worker_status",
  Wait: "worker_wait",
  Steer: "worker_steer",
  Stop: "worker_stop",
  Mark: "worker_mark",
} as const;
export type WorkerTool = (typeof WorkerTool)[keyof typeof WorkerTool];

/**
 * How a worker stands in the project: `read` works in place and writes nothing; `copy` writes in a
 * copy of its own and hands its work back for the lead to merge; `lock` writes in place, one such
 * worker at a time per game. Manifests and journals keep them: never rename a value.
 */
export const WorkerIsolation = { Read: "read", Copy: "copy", Lock: "lock" } as const;
export type WorkerIsolation = (typeof WorkerIsolation)[keyof typeof WorkerIsolation];

/** The lead's word on what a worker delivered: the digest stops repeating it. Never rename a value. */
export const WorkerVerdict = { Used: "used", Rejected: "rejected" } as const;
export type WorkerVerdict = (typeof WorkerVerdict)[keyof typeof WorkerVerdict];

/** The most workers a lead's pool runs at once. Depth is one: a worker never starts workers of its own. */
export const MAX_WORKERS_AT_ONCE = 8;

/**
 * A kind of worker a plugin declares (`PluginManifest.workerTypes`), as the registry hands it to a
 * lead: `tools` are agent names (`<plugin>__<tool>`) or name prefixes (`<plugin>__`) a worker of
 * this kind is offered.
 */
export interface WorkerType {
  pluginId: string;
  id: string;
  description: string;
  tools: string[];
  isolation: WorkerIsolation;
}

/**
 * What the harness asks for when it starts a worker: its id and title, the run or the chat turn it
 * belongs to, and whether it may search the web as a reader. Honoured only by the host's own
 * finding; a grant it cannot confirm leaves the session unattended.
 */
export interface WorkerGrant {
  id: string;
  title: string;
  /** The run whose lead started it: a run started in this game's open chat, still running. */
  runId?: string;
  /** The chat message whose turn started it: the one the chat's own session answers now. */
  turn?: string;
  /** It may search and read the web even as a reader. */
  research?: boolean;
}

/** The key an in-place worker's delegation runs under, so it never shares the game folder's lock. */
export const workerLockKey = (cwd: string, id: string): string => `${cwd}#worker:${id}`;

const WORKER_TOOLS: ReadonlySet<string> = new Set(Object.values(WorkerTool));
const WORKER_ISOLATIONS: ReadonlySet<string> = new Set(Object.values(WorkerIsolation));

/** Whether `name` is one of the worker tools. */
export const isWorkerTool = (name: unknown): name is WorkerTool => typeof name === "string" && WORKER_TOOLS.has(name);

/** Whether `value` is a worker isolation. */
export const isWorkerIsolation = (value: unknown): value is WorkerIsolation =>
  typeof value === "string" && WORKER_ISOLATIONS.has(value);

/** How a worker ended, as its `worker_finished` record says. Persisted: never rename a value. */
export const WorkerEnd = { Done: "done", Failed: "failed", Stopped: "stopped" } as const;
export type WorkerEnd = (typeof WorkerEnd)[keyof typeof WorkerEnd];

/**
 * Why a worker stopped short, as its end record names it (`worker_finished.stopCode`): the host
 * refused its session (the chat's Settings allow no more workers at once), the chat turn or the run
 * that started it ended, the lead stopped it, or its session went wrong. The app words each itself;
 * the record's `stoppedBecause` is the harness's text for the lead and is never shown. Persisted:
 * never rename a value.
 */
export const WorkerStopCode = {
  HostRefused: "host_refused",
  TurnEnded: "turn_ended",
  RunEnded: "run_ended",
  StoppedByLead: "stopped_by_lead",
  Error: "error",
} as const;
export type WorkerStopCode = (typeof WorkerStopCode)[keyof typeof WorkerStopCode];

const WORKER_ENDS: ReadonlySet<string> = new Set(Object.values(WorkerEnd));
const WORKER_STOP_CODES: ReadonlySet<string> = new Set(Object.values(WorkerStopCode));

/** Whether `value` is why a worker stopped short. */
export const isWorkerStopCode = (value: unknown): value is WorkerStopCode =>
  typeof value === "string" && WORKER_STOP_CODES.has(value);
const WORKER_VERDICTS: ReadonlySet<string> = new Set(Object.values(WorkerVerdict));

/** Whether `value` is how a worker ended. */
export const isWorkerEnd = (value: unknown): value is WorkerEnd => typeof value === "string" && WORKER_ENDS.has(value);

/** Whether `value` is a lead's verdict on a worker. */
export const isWorkerVerdict = (value: unknown): value is WorkerVerdict =>
  typeof value === "string" && WORKER_VERDICTS.has(value);

/**
 * What a pool worker's id is prefixed with on the graph and in its records: the dot keeps it apart
 * from every id a lead names itself (`director/args.ts` `slug` keeps those to `[a-z0-9-_]`).
 */
export const POOL_WORKER_PREFIX = "pool.";

/** A pool worker's id on the graph and in its records. */
export const poolWorkerId = (id: string): string => `${POOL_WORKER_PREFIX}${id}`;

/** The most characters of a worker's task its start record keeps. */
export const WORKER_TASK_CHARS = 300;
/** The most characters of the person's request a chat turn's worker's start record keeps. */
export const WORKER_ASK_CHARS = 300;
/** The most characters of a worker's title the graph and the chat show, and a host's lock names its holder by. */
export const WORKER_TITLE_CHARS = 80;
/** The most characters of a worker's id (or kind) a lock or a moment names it by. */
export const WORKER_ID_CHARS = 80;
/** A worker's id or kind as a lock or a moment names it: letters, digits, `.`, `_` and `-`. */
export const WORKER_ID = new RegExp(`^[A-Za-z0-9._-]{1,${WORKER_ID_CHARS}}$`);
const CONTROL_CHARS = /\p{Cc}/u;

/** Whether a value is a worker's id (or kind) as a lock or a moment names it. */
export const isWorkerId = (value: unknown): value is string => typeof value === "string" && WORKER_ID.test(value);

/** Whether a value is a worker's title a person could read: one line of 1 to `WORKER_TITLE_CHARS` characters. */
export const isWorkerTitle = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= WORKER_TITLE_CHARS && !CONTROL_CHARS.test(value);

/** What a lock or a moment refuses a worker it can't name by: the words of `isWorkerId` and `isWorkerTitle`. */
export const WORKER_NAMING = `A worker is named by an id of letters, digits, '.', '_' and '-' (at most ${WORKER_ID_CHARS}), and a title of one line of at most ${WORKER_TITLE_CHARS} characters`;
/** The most characters of a worker's own summary its end record keeps (its first sentence). */
export const WORKER_SUMMARY_CHARS = 160;

/**
 * A worker a lead started (`worker_started`), in a run (`runId`) or in a chat turn (`turn`, with
 * the person's request as `ask`). Written by the harness; every field optional, as an older or an
 * agent-edited writer may leave any out. `isolation` picks the words the app shows, never shown
 * itself; `where` names the app a worker writing in place works in, by the label of the plugin
 * lock it holds (at most `LOCK_LABEL_CHARS`), and wins over `in`, the engine an older record named.
 */
export interface WorkerStartedPayload extends RunScope {
  workerId?: string;
  title?: string;
  isolation?: WorkerIsolation;
  type?: string;
  task?: string;
  in?: GameEngine;
  where?: string;
  turn?: string;
  ask?: string;
  at?: string;
}

/**
 * A worker's end (`worker_finished`: `state`, why it stopped as the harness's text for the lead and
 * as the code the app words (`stopCode`), its first sentence, whether it delivered work to hand
 * back, and `inGame` when it finished work it wrote in place in the game folder), or the lead's
 * later verdict on it (`verdict`, `note`, and `merged` when its work was added to the game), a
 * second record without `state`. Every field optional.
 */
export interface WorkerFinishedPayload extends RunScope {
  workerId?: string;
  title?: string;
  state?: WorkerEnd;
  stoppedBecause?: string | null;
  stopCode?: WorkerStopCode;
  summary?: string;
  delivered?: boolean;
  inGame?: boolean;
  verdict?: WorkerVerdict;
  note?: string | null;
  merged?: boolean;
  turn?: string;
  at?: string;
}
