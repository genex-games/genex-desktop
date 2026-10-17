/**
 * The harness's copy of Genex's one worker model: the tools a lead runs workers with, how a worker
 * stands in the project, the lead's word on what one delivered, the codes a refused worker's call
 * carries and the event a worker's question is recorded as. The app's copy is `shared/workers.ts`
 * (and `DelegationRefusal`, `SnapshotRefusal`, `CustomEvent.ToolPermission`, `CustomEvent.WorkerStarted`);
 * `seed-contracts.test.ts` holds the two together. Wire values: never rename one. It imports nothing,
 * so every worker module can read it while any other module is still loading.
 */

/** The tools a lead runs its workers with, by the names its engine sends. */
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
 * worker at a time per game.
 */
export const WorkerIsolation = { Read: "read", Copy: "copy", Lock: "lock" } as const;
export type WorkerIsolation = (typeof WorkerIsolation)[keyof typeof WorkerIsolation];

/** The lead's word on what a worker delivered: the digest stops repeating it. */
export const WorkerVerdict = { Used: "used", Rejected: "rejected" } as const;
export type WorkerVerdict = (typeof WorkerVerdict)[keyof typeof WorkerVerdict];

/** The most workers a lead's pool runs at once. Depth is one: a worker never starts workers of its own. */
export const MAX_WORKERS_AT_ONCE = 8;

/**
 * Why the host refused a worker's call (the error's `code`): past the most workers the person's
 * Settings allow, or a copy too large to make (work in the game folder itself instead).
 */
export const WorkerRefusal = { TooManyWorkers: "too_many_workers", CopyTooLarge: "copy-too-large" } as const;
export type WorkerRefusal = (typeof WorkerRefusal)[keyof typeof WorkerRefusal];

/** The custom event a worker's question to the person is recorded as, in the chat's log. */
export const WORKER_QUESTION_EVENT = "tool_permission";

/** A worker's question still waiting for the person's answer (the event's `state`); settled ones say how. */
export const WORKER_QUESTION_PENDING = "pending";

/** What the pool reads of a worker's question: which one it is, where it stands, whose it is and what it asks. */
export interface WorkerQuestion {
  requestId: string;
  state: string;
  worker?: { id: string };
  /** The engine's own sentence, e.g. "Claude wants to run npm install". */
  title?: string;
  /** The one thing to decide on: the command, the file path, the URL or host. */
  subject?: string;
}

/** The longest `worker_wait`, in seconds: the director's own `wait` cap (`director/budgets.ts` `MAX_WAIT_S`). */
export const MAX_WORKER_WAIT_S = 240;
/** The most characters of a worker's title the graph and the chat show. */
export const WORKER_TITLE_CHARS = 80;

/**
 * The records a worker leaves on the chat's log: one when it starts, one when it ends and one more
 * with the lead's verdict. The app's `CustomEvent.WorkerStarted`/`WorkerFinished`; kept here, not in
 * the shipped `RunEvent`, so a kept older `run-events.ts` never leaves them undefined.
 */
export const WorkerEvent = { Started: "worker_started", Finished: "worker_finished" } as const;
export type WorkerEvent = (typeof WorkerEvent)[keyof typeof WorkerEvent];

/** How a worker ended, as its end record says. */
export const WorkerEnd = { Done: "done", Failed: "failed", Stopped: "stopped" } as const;
export type WorkerEnd = (typeof WorkerEnd)[keyof typeof WorkerEnd];

/**
 * Why a worker stopped short, as its end record names it (`stopCode`): the app words each itself,
 * and never shows `stoppedBecause`, which is written for the lead. The app's `WorkerStopCode`.
 */
export const WorkerStopCode = {
  HostRefused: "host_refused",
  TurnEnded: "turn_ended",
  RunEnded: "run_ended",
  StoppedByLead: "stopped_by_lead",
  Error: "error",
} as const;
export type WorkerStopCode = (typeof WorkerStopCode)[keyof typeof WorkerStopCode];

/** What a pool worker's id is prefixed with in its records, apart from every id a lead names itself. */
export const POOL_WORKER_PREFIX = "pool.";
/** The most characters of a worker's task its start record keeps. */
export const WORKER_TASK_CHARS = 300;
/** The most characters of the person's request a chat turn's worker's start record keeps. */
export const WORKER_ASK_CHARS = 300;
/** The most characters of a worker's own summary its end record keeps (its first sentence). */
export const WORKER_SUMMARY_CHARS = 160;
