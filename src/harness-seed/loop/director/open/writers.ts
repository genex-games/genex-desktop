/**
 * Who besides the lead may write in the game folder while its turn works: the run's writers in place
 * (its pool's workers with isolation lock), the jobs they start (build output, logs: `writesBeside`),
 * and Genex bringing the project's app back. The lead's own jobs are its own acts, and a worker in a
 * copy or a reader writes nothing there. A content change made while any of them ran is not read as
 * the lead's own work by itself (`between.ts`); a claim waits for a writer in place, the lead's rewind
 * or restart waits for it to end, and a way back to a save point stops it first, saying so.
 */
import { WorkerIsolation, WorkerTool } from "../../workers/contract.ts";
import { runningRecords, type WorkerRecord, WorkerState } from "../../workers/records.ts";
import type { LoopRun } from "../loop-run.ts";
import { activeWork } from "./active-work.ts";
import type { OpenLoop, TurnStart } from "./contract.ts";

/** The run's writers in place at work now: its pool's workers that write in the game folder under its lock. */
export function writersInPlace(open: OpenLoop): WorkerRecord[] {
  if (!open.pool) return [];
  return runningRecords(open.pool.state).filter((record) => record.isolation === WorkerIsolation.Lock);
}

/** The writers in place that may write now: at work, not waiting on the person. */
const writingNow = (open: OpenLoop): WorkerRecord[] =>
  writersInPlace(open).filter((record) => record.state === WorkerState.Running);

/** The writers in place waiting on the person: none of them writes until the person answers. */
const waitingNow = (open: OpenLoop): WorkerRecord[] =>
  writersInPlace(open).filter((record) => record.state === WorkerState.WaitingForPerson);

/** How many of the pool's workers the lead has marked used or rejected. */
const markedCount = (open: OpenLoop): number =>
  (open.pool?.state.records ?? []).filter((record) => record.verdict !== null).length;

/**
 * Reads who of the pool's workers waits on the person from the chat's log now: what a turn's edge
 * holds against the turn never rests on the lead's own last `worker_status`.
 */
export async function readWaiting(open: OpenLoop): Promise<void> {
  await open.pool?.readQuestions().catch(() => {});
}

/** What the lead's turn begins with (`TurnStart`), from the last read of the run's jobs and the workers' questions. */
export function turnStartOf(open: OpenLoop): TurnStart {
  return {
    records: open.pool?.state.records.length ?? 0,
    marked: markedCount(open),
    writers: writingNow(open).map((record) => record.id),
    waiting: waitingNow(open).map((record) => record.id),
    writerJobs: open.writerJobsRunning,
    writerJobEndSeq: open.writerJobEndSeq,
    recovering: Boolean(open.recovering),
    recoveries: open.recoveries,
    restores: open.restores,
  };
}

/**
 * Whether a writer in place may have written at any time since the turn began: one at work then, one
 * started since, one at work now, or one that waited on the person then and no longer does.
 */
function writerWorked(open: OpenLoop, from: TurnStart): boolean {
  const records = open.pool?.state.records ?? [];
  const startedSince = records.slice(from.records).some((record) => record.isolation === WorkerIsolation.Lock);
  const answered = from.waiting.some(
    (id) => records.find((record) => record.id === id)?.state !== WorkerState.WaitingForPerson,
  );
  return from.writers.length > 0 || startedSince || writingNow(open).length > 0 || answered;
}

/** Whether a job that writes beside the lead ran at any time since the turn began: running then or now, or ended since. */
const writerJobRan = (open: OpenLoop, from: TurnStart): boolean =>
  from.writerJobs > 0 || open.writerJobsRunning > 0 || open.writerJobEndSeq > from.writerJobEndSeq;

/** Whether Genex was bringing the project's app back at any time since the turn began, or took the folder back. */
const recoveredSince = (open: OpenLoop, from: TurnStart): boolean =>
  from.recovering || Boolean(open.recovering) || open.recoveries !== from.recoveries || open.restores !== from.restores;

/**
 * Whether anyone but the lead may have written in the game folder since its turn began (`from`): a
 * writer in place, a job of one, or Genex bringing the project's app back. The run's jobs and the
 * workers' questions are read again first. Without a start to hold it to, nobody else is known to have.
 */
export async function othersWrote(loopRun: LoopRun, open: OpenLoop, from: TurnStart | null): Promise<boolean> {
  await activeWork(loopRun, open.clock.now(), { fresh: true });
  await readWaiting(open);
  if (!from) return false;
  return writerWorked(open, from) || writerJobRan(open, from) || recoveredSince(open, from);
}

/**
 * Whether the only ones besides the lead who may have written since its turn began are jobs that ended
 * writers in place left running (`OpenLoop.leftoverJobs`): no writer in place at work, no recovery. A
 * save point of the lead's own beside those counts as its work: the lead holds them now.
 */
export function onlyLeftovers(open: OpenLoop, from: TurnStart | null): boolean {
  if (!from || writerWorked(open, from) || recoveredSince(open, from)) return false;
  return open.writerJobsRunning === open.leftoverJobs.length;
}

/**
 * Whether someone besides the lead may still write in the game folder: a writer in place at work (not
 * waiting on the person), a job of one running, or Genex bringing the project's app back.
 */
export const othersWriting = (open: OpenLoop): boolean =>
  writingNow(open).length > 0 || open.writerJobsRunning > 0 || Boolean(open.recovering);

/** Whether the lead marked a worker used or rejected since its turn began: its own act, a merge among them. */
export function markedSince(open: OpenLoop, from: TurnStart | null): boolean {
  return from !== null && markedCount(open) > from.marked;
}

/**
 * Stops the run's writers in place before Genex takes the folder back (`worker_stop`, the reason on
 * each one's end record): their edits would otherwise land on files the restore replaced. Answers
 * the ids of those it stopped.
 */
export async function stopWritersInPlace(open: OpenLoop, why: string): Promise<string[]> {
  const ids = writersInPlace(open).map((record) => record.id);
  for (const id of ids) await open.pool?.call(WorkerTool.Stop, { id, why }).catch(() => "");
  return ids;
}
