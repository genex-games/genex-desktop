/**
 * The workers and the background work of the Builds graph (`run-graph.ts`): a worker's records
 * (`worker_started`, `worker_finished` with its end, then the lead's verdict) folded onto its row,
 * and the jobs (`job_started`, `job_ended`) the lead's node carries. How a worker stands in the
 * game (`isolation`) is kept only as a typed field the words are chosen by: it is never shown.
 */
import { isGameEngine, type GameEngine } from "../shared/game-engine.ts";
import { isJobState, isJobStopper, JobState, type JobStopper } from "../shared/jobs.ts";
import {
  isWorkerEnd,
  isWorkerIsolation,
  isWorkerStopCode,
  isWorkerVerdict,
  WorkerEnd,
  type WorkerIsolation,
  type WorkerStopCode,
  WorkerVerdict,
} from "../shared/workers.ts";
import type { FacetNode } from "./run-graph.ts";
import { num, type Payload, record, strOrNull } from "./run-graph-parse.ts";

/** What a worker's own records say about it, on its row (`FacetNode.worker`). */
export interface WorkerInfo {
  /** the kind of worker a plugin declared, when it was one */
  type: string | null;
  /** how it stands in the game: picks the words, never shown */
  isolation: WorkerIsolation | null;
  /** the engine it works in, when it works in the game folder of one */
  in: GameEngine | null;
  /** what the lead asked it, clipped by the harness */
  task: string | null;
  /** the first sentence of its own report, when it gave one */
  summary: string | null;
  /** the chat turn that started it, when no run did */
  turn: string | null;
  /** how it ended; null while it works */
  ended: WorkerEnd | null;
  /** why it stopped short, as its end record's code: the record's own text is for the lead */
  stopCode: WorkerStopCode | null;
  /** the lead's word on what it delivered, and why */
  verdict: WorkerVerdict | null;
  note: string | null;
  /** its work is in the game: the lead added it, or it wrote it there in place and finished; a later verdict never clears it */
  merged: boolean;
}

/** One job the lead's node carries: a long process an agent of this graph started. */
export interface JobInfo {
  jobId: string;
  title: string;
  /** the worker that started it, by its title; null for the lead's own (or the chat's) */
  who: string | null;
  state: JobState;
  exitCode: number | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  stoppedBy: JobStopper | null;
}

/** The workers a graph has placed: every id that started or ended, and whether any record landed. */
export interface WorkerLedger {
  known: Set<string>;
  placed: boolean;
}

/** A graph's empty worker ledger. */
export const newWorkerLedger = (): WorkerLedger => ({ known: new Set(), placed: false });

/** The row of a worker, by its id and its title: the graph's part, after restarts are folded in. */
export type WorkerRow = (workerId: string, title: string | undefined) => FacetNode;

const workerEnd = (value: unknown): WorkerEnd | null => (isWorkerEnd(value) ? value : null);
const workerVerdict = (value: unknown): WorkerVerdict | null => (isWorkerVerdict(value) ? value : null);
/** An end's state; one the app does not know closes the job as failed. */
const jobEnd = (value: unknown): JobState =>
  isJobState(value) && value !== JobState.Running ? value : JobState.Failed;
const jobStopper = (value: unknown): JobStopper | null => (isJobStopper(value) ? value : null);

function emptyInfo(): WorkerInfo {
  return {
    type: null,
    isolation: null,
    in: null,
    task: null,
    summary: null,
    turn: null,
    ended: null,
    stopCode: null,
    verdict: null,
    note: null,
    merged: false,
  };
}

/**
 * A worker started: its row works, under the title its start gives it for the person (the
 * director may know a builder by another). A start for a worker still working (a resume) changes
 * nothing, and a row is never doubled. A start after its end (a builder started again under its
 * id after a pause) is a new attempt on the same row: nothing of the old end or the lead's word
 * on it carries over. Returns whether the record named a worker.
 */
export function onWorkerStarted(ledger: WorkerLedger, row: WorkerRow, payload: Payload): boolean {
  const workerId = strOrNull(payload.workerId);
  if (!workerId) return false;
  ledger.placed = true;
  const title = strOrNull(payload.title);
  const node = row(workerId, title ?? undefined);
  const known = ledger.known.has(workerId);
  if (known && !workerEnded(node.worker)) return true;
  ledger.known.add(workerId);
  if (title) node.title = title;
  node.worker = {
    ...emptyInfo(),
    type: strOrNull(payload.type),
    isolation: isWorkerIsolation(payload.isolation) ? payload.isolation : null,
    in: isGameEngine(payload.in) ? payload.in : null,
    task: strOrNull(payload.task),
    turn: strOrNull(payload.turn),
  };
  // A new attempt at the part: what the one before ended on is not this one's word.
  node.building = true;
  node.stoppedBecause = null;
  node.delivered = false;
  node.failed = false;
  node.satisfied = false;
  return true;
}

/** A worker's row has reached its end, or the lead's word on it. */
const workerEnded = (info: WorkerInfo | undefined): boolean =>
  info !== undefined && (info.ended !== null || info.verdict !== null);

/**
 * A worker ended, or the lead gave its verdict on one: an end with no start on the page still
 * makes its row. Later fields win; a field the record leaves out keeps what was there, so a
 * verdict keeps the earlier end and an end never clears what `director_worker` set. Returns
 * whether the record named a worker.
 */
export function onWorkerFinished(ledger: WorkerLedger, row: WorkerRow, payload: Payload): boolean {
  const workerId = strOrNull(payload.workerId);
  if (!workerId) return false;
  ledger.placed = true;
  ledger.known.add(workerId);
  const node = row(workerId, strOrNull(payload.title) ?? undefined);
  node.worker ??= emptyInfo();
  const state = workerEnd(payload.state);
  if (state) endWorker(node, node.worker, state, payload);
  foldVerdict(node, node.worker, payload);
  return true;
}

function endWorker(node: FacetNode, info: WorkerInfo, state: WorkerEnd, payload: Payload): void {
  const done = state === WorkerEnd.Done;
  info.ended = state;
  info.stopCode = isWorkerStopCode(payload.stopCode) ? payload.stopCode : null;
  node.building = false;
  node.failed = state === WorkerEnd.Failed;
  if (done) node.satisfied = true;
  if (!done) node.delivered = false;
  else if (payload.delivered === true) node.delivered = true;
  node.stoppedBecause = strOrNull(payload.stoppedBecause) ?? node.stoppedBecause ?? state;
}

/** What an end or a verdict says beside the end itself: the report's sentence and the lead's word. */
function foldVerdict(node: FacetNode, info: WorkerInfo, payload: Payload): void {
  info.summary = strOrNull(payload.summary) ?? info.summary;
  info.note = strOrNull(payload.note) ?? info.note;
  const verdict = workerVerdict(payload.verdict);
  if (verdict) info.verdict = verdict;
  // Added by the lead, or written in place by the worker itself: either way its work is in the game,
  // and a rejection after that takes nothing out, as on the worker's chat line.
  if (payload.merged === true || payload.inGame === true) info.merged = true;
  // A worker the lead did not use stopped there, for the lead's reason.
  if (verdict === WorkerVerdict.Rejected && info.note && !info.merged) node.stoppedBecause = info.note;
}

/** A job of the graph, made the first time a record names it. */
function jobOf(jobs: Map<string, JobInfo>, jobId: string, payload: Payload): JobInfo {
  const job = jobs.get(jobId) ?? {
    jobId,
    title: "",
    who: null,
    state: JobState.Running,
    exitCode: null,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    stoppedBy: null,
  };
  jobs.set(jobId, job);
  job.title = strOrNull(payload.title) ?? job.title;
  job.who = strOrNull(record(payload.worker)?.title) ?? job.who;
  return job;
}

/** A job started (`job_started`). Returns whether the record named a job. */
export function onJobStarted(jobs: Map<string, JobInfo>, payload: Payload): boolean {
  const jobId = strOrNull(payload.jobId);
  if (!jobId) return false;
  const job = jobOf(jobs, jobId, payload);
  job.startedAt = strOrNull(payload.startedAt) ?? job.startedAt;
  return true;
}

/** A job ended (`job_ended`); one whose start is not on the page is still a job. Returns whether it named one. */
export function onJobEnded(jobs: Map<string, JobInfo>, payload: Payload): boolean {
  const jobId = strOrNull(payload.jobId);
  if (!jobId) return false;
  const job = jobOf(jobs, jobId, payload);
  job.state = jobEnd(payload.state);
  job.exitCode = num(payload.exitCode);
  job.endedAt = strOrNull(payload.endedAt) ?? job.endedAt;
  job.durationMs = num(payload.durationMs) ?? job.durationMs;
  job.stoppedBy = jobStopper(payload.stoppedBy);
  return true;
}
