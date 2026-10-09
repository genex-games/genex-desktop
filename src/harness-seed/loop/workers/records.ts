/**
 * The worker pool's state: what one pool works with (its scope), one record per worker, where each
 * stands, and the pool's bookkeeping kept beside the records (the running sessions, queued steers,
 * the log cursor its questions are read after). The pool's records persist in the chat's artifact
 * `chat-workers`, so a later turn of the same chat opens with them.
 */
import type { AnyRecord, HarnessCtx } from "../../types/harness.d.ts";
import type { WorkerType } from "../../types/host-api.d.ts";
import type { FactRef, FolderHolds } from "../folder-facts.ts";
import type { Where } from "../git.ts";
import { HostMethod } from "../host-methods.ts";
import { sleep } from "../time.ts";
import type { WorkerIsolation, WorkerQuestion, WorkerStopCode, WorkerVerdict } from "./contract.ts";
import type { WorkerEventScope } from "./events.ts";

/** Where a worker stands. Persisted in the chat's artifact: never rename a value. */
export const WorkerState = {
  Running: "running",
  Done: "done",
  Failed: "failed",
  Stopped: "stopped",
  WaitingForPerson: "waiting_for_person",
} as const;
export type WorkerState = (typeof WorkerState)[keyof typeof WorkerState];

/** The artifact a chat's worker records persist in. */
export const CHAT_WORKERS_ARTIFACT = "chat-workers";

/** The pool's time: injectable, so a test never waits for real. */
export interface PoolClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** The real clock. */
export const REAL_CLOCK: PoolClock = { now: () => Date.now(), sleep };

/** What one pool works with: the chat (and its turn, or a run) it serves, its engine, and the game. */
export interface WorkerScope {
  ctx: HarnessCtx;
  project: string;
  /** The chat its workers answer to: their questions wait there. */
  threadId: string;
  /** The run whose lead started them, when a run's lead did. */
  runId?: string;
  /** The chat turn (its message id) whose lead started them, when the chat's own session did. */
  turn?: string;
  /** The person's request that turn answers: its workers' start records keep it. */
  ask?: string;
  engine: string;
  model?: string;
  effort?: string;
  /**
   * The run's Genex credit cap, when its lead has one: every worker's paid jobs are refused at it
   * and counted toward it, as the lead's own are.
   */
  creditCap?: number;
  /** The game's folder, absolute: where in-place workers work, and how Stop reaches them. */
  gameDir: string;
  /** Where the lead works, which a copy's work merges into. */
  leadFolder: Where;
  /** Who runs a worker's session: Genex, the project's folder and what it holds (every brief opens with it). */
  identity: { folderLabel: string; facts: readonly FactRef[]; holds?: FolderHolds | null };
  clock: PoolClock;
  /** The artifact its records persist in: a run's pool keeps its own (`runWorkersArtifact`); a chat's, `chat-workers`. */
  artifactId?: string;
  /** Told when a worker ends, so a run's lead hears of it with the rest of its news. */
  onEnded?: (record: WorkerRecord) => void;
  /**
   * Chains a git write to the game folder after the lead's own there (the Unreal lead's landings,
   * save points and restores): two at once fight over the game's one index. With none, it runs at once.
   */
  gitWrite?: <T>(write: () => Promise<T>) => Promise<T>;
}

/** A git write to the game folder, chained after the lead's own when its scope chains them (`gitWrite`). */
export function gameGitWrite<T>(state: PoolState, write: () => Promise<T>): Promise<T> {
  const chain = state.scope.gitWrite;
  return chain ? chain(write) : write();
}

/** One worker, as the pool keeps it and the chat's artifact persists it. */
export interface WorkerRecord {
  id: string;
  title: string;
  task: string;
  isolation: WorkerIsolation;
  type: string | null;
  research: boolean;
  state: WorkerState;
  /** Its copy of the game, while it has one. */
  worktree: string | null;
  /** The commit its copy was made at. */
  base: string | null;
  /** Its copy's work, committed: what `worker_mark used` merges. */
  commit: string | null;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
  /** Why it stopped short, as the code its end record carries for the app; absent in older records. */
  stopCode?: WorkerStopCode | null;
  verdict: WorkerVerdict | null;
  /** The lead's note with its verdict. */
  note?: string | null;
  /** The question it waits on the person for, in words; null when none waits. */
  question: string | null;
  /** The chat turn that started it. */
  turn: string | null;
}

/** A pool's records and what it keeps beside them while it is open. */
export interface PoolState {
  scope: WorkerScope;
  records: WorkerRecord[];
  types: WorkerType[];
  /** Each running worker's sessions, settled when it has ended. */
  runs: Map<string, Promise<void>>;
  /** What the lead said to a worker that its next session leg reads first. */
  steers: Map<string, string[]>;
  /** The chat's log is read for questions after this event. */
  cursor: string | null;
  /** The pool's workers' questions still pending, by request, oldest first. */
  pending: Map<string, WorkerQuestion>;
  /** The pool closed: a worker that has not started its session never starts it. */
  closing: boolean;
  /** Copies the close hands back once their sessions end (a session still writing at the close). */
  handingBack: Map<string, Promise<void>>;
}

/**
 * Where a worker's records go: the pool's chat and run, or the chat turn that started the worker
 * (an earlier turn's, for a worker that turn left to mark), with the request the turn answers.
 */
export function eventScope(state: PoolState, record: WorkerRecord): WorkerEventScope {
  const { ctx, threadId, project, runId, turn, ask } = state.scope;
  const belongs = runId ? { runId } : { turn: record.turn ?? turn ?? null };
  return { ctx, threadId, project, ...belongs, ...(ask ? { ask } : {}) };
}

/** The records that are still working (or waiting on the person). */
export function runningRecords(state: PoolState): WorkerRecord[] {
  return state.records.filter(isWorking);
}

/** Whether a worker is still at work: running, or waiting on the person. */
export function isWorking(record: WorkerRecord): boolean {
  return record.state === WorkerState.Running || record.state === WorkerState.WaitingForPerson;
}

/** One worker by id, or undefined. */
export function recordOf(state: PoolState, id: unknown): WorkerRecord | undefined {
  return state.records.find((record) => record.id === String(id ?? ""));
}

/** Where a worker works: its copy, or the game folder. */
export function cwdOf(state: PoolState, record: WorkerRecord): string {
  return record.worktree ?? state.scope.gameDir;
}

/** The next worker id in this chat: one past every id its records hold. */
export function nextWorkerId(state: PoolState): string {
  const numbers = state.records.map((record) => Number(/^w(\d+)$/.exec(record.id)?.[1] ?? 0));
  return `w${Math.max(0, ...numbers) + 1}`;
}

/** The chat's thread spelled for a ref or a folder name: letters, digits, `-` and `_` only. */
export function threadSlug(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9_-]/g, "-").slice(-64) || "chat";
}

/** The artifact a run's pool keeps its records in, apart from the chat's own. */
export function runWorkersArtifact(runId: string): string {
  return `run-workers-${runId}`;
}

/**
 * Where a copy worker's work is kept once its scope closes: a ref in the game's repository, among
 * the run's refs for a run's worker and the chat's for a chat turn's.
 */
export function keptRef(state: PoolState, id: string): string {
  const { runId, threadId } = state.scope;
  if (runId) return `refs/studio/runs/${runId}/pool/${id}`;
  return `refs/studio/chat/${threadSlug(threadId)}/workers/${id}`;
}

/** The artifact this pool's records persist in. */
export function recordsArtifact(scope: WorkerScope): string {
  return scope.artifactId ?? CHAT_WORKERS_ARTIFACT;
}

/** The records persisted in the chat's artifact, read back; anything unreadable reads as none. */
export function readRecords(value: unknown): WorkerRecord[] {
  const list = (value as AnyRecord | null)?.workers;
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is WorkerRecord => typeof item?.id === "string" && typeof item?.state === "string");
}

/** Persist the chat's worker records, so a later turn's pool opens with them; a failure is not the lead's. */
export async function persist(state: PoolState): Promise<void> {
  const { ctx, threadId } = state.scope;
  const value = { workers: state.records };
  const artifactId = recordsArtifact(state.scope);
  await ctx.call(HostMethod.ArtifactWrite, { threadId, artifactId, value }).catch(() => {});
}
