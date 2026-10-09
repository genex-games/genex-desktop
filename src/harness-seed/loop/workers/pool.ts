/**
 * Genex's one worker pool, behind the six worker tools: `worker_start` (pool-start.ts),
 * `worker_status` and `worker_wait` (each worker's line, a question it waits on the person for
 * read from the chat's log), `worker_steer` and `worker_stop` (reaching only that worker, by
 * `engine.interrupt`/`engine.abort` with its id), `worker_mark` (pool-merge.ts), and the close at
 * the end of the scope that opened it: running workers stopped, a copy's work kept on a ref for a
 * later turn's `worker_mark`, the records persisted in the chat's artifact. Depth is one: a worker
 * is never offered these tools.
 */
import type { AnyRecord } from "../../types/harness.d.ts";
import type { EventEnvelope } from "../../types/host-api.d.ts";
import { HostMethod } from "../host-methods.ts";
import { hasText } from "../text.ts";
import { MINUTE_MS, SECOND_MS } from "../time.ts";
import { MAX_WORKER_WAIT_S, WORKER_QUESTION_PENDING, WorkerIsolation, WorkerStopCode, WorkerTool } from "./contract.ts";
import { commitCopy, keepWork, markWorker, removeCopy } from "./pool-merge.ts";
import { ended, scopeEnd, startWorker } from "./pool-start.ts";
import { POOL_WORDS } from "./prompts.ts";
import { questionOf, questionText } from "./questions.ts";
import {
  cwdOf,
  isWorking,
  type PoolState,
  persist,
  readRecords,
  recordOf,
  recordsArtifact,
  runningRecords,
  type WorkerRecord,
  type WorkerScope,
  WorkerState,
} from "./records.ts";

/** How often `worker_wait` looks at the chat's log for a worker's question. */
const QUESTION_POLL_MS = 2 * SECOND_MS;
/** `worker_wait`'s seconds when the lead names none. */
const DEFAULT_WAIT_S = 60;
/** At the close, the workers still at work have this long to stop before they are left as stopped. */
const SETTLE_WAIT_MS = 30 * SECOND_MS;
/**
 * A stop is sent again this far apart while the worker's session has not ended, at most this many
 * times: one that reached the host before the session registered aborted nothing.
 */
const ABORT_RETRY_MS = 2 * SECOND_MS;
const ABORT_RESENDS = 5;

/** A pool open for one scope: the six tools, and its close. */
export interface WorkerPool {
  readonly state: PoolState;
  /** One worker tool call, answered in words. */
  call(name: string, args: AnyRecord): Promise<string>;
  /** The scope ended: running workers stop, a copy's work is kept, the records persist. */
  close(): Promise<void>;
}

/** Open a pool: the chat's earlier workers, the kinds the plugins on offer declare, and the log read from now. */
export async function openPool(scope: WorkerScope): Promise<WorkerPool> {
  const { ctx, threadId, project } = scope;
  const saved = await ctx
    .call(HostMethod.ArtifactRead, { threadId, artifactId: recordsArtifact(scope) })
    .catch(() => null);
  const types = await ctx.call(HostMethod.PluginsWorkerTypes, { project }).catch(() => []);
  const cursor = await ctx.call(HostMethod.EventsHead, { threadId }).catch(() => null);
  const state: PoolState = {
    scope,
    records: readRecords(saved),
    types: Array.isArray(types) ? types : [],
    runs: new Map(),
    steers: new Map(),
    cursor: typeof cursor === "string" ? cursor : null,
    pending: new Map(),
    closing: false,
    handingBack: new Map(),
  };
  // A worker an earlier scope left at work (its harness restarted under it) works no more.
  for (const record of runningRecords(state))
    await ended(state, record, WorkerState.Stopped, POOL_WORDS.turnEnded, null, scopeEnd(state));
  // One that scope's close stopped, whose session outlived the wait and never ended, ends as stopped.
  for (const record of unendedStops(state)) await ended(state, record, record.state, record.error);
  return { state, call: (name, args) => callTool(state, name, args), close: () => closePool(state) };
}

/** The workers a close stopped whose end was never recorded: no longer working, with no end time. */
const unendedStops = (state: PoolState): WorkerRecord[] =>
  state.records.filter((record) => !isWorking(record) && record.endedAt === null);

/** One worker tool call, by the name the lead's engine sent. */
function callTool(state: PoolState, name: string, args: AnyRecord): Promise<string> {
  switch (name) {
    case WorkerTool.Start:
      return startWorker(state, args);
    case WorkerTool.Status:
      return statusOf(state, args.id);
    case WorkerTool.Wait:
      return waitWorkers(state, args);
    case WorkerTool.Steer:
      return steerWorker(state, args);
    case WorkerTool.Stop:
      return stopWorker(state, args);
    case WorkerTool.Mark:
      return markWorker(state, args);
    default:
      return Promise.resolve(POOL_WORDS.unknownTool(name));
  }
}

// ── questions ────────────────────────────────────────────────────────────────────────────────

/**
 * Read the chat's log since the last look, keeping each question by its request: a worker with any
 * question pending waits for the person (its line says its newest one), and it goes on only once
 * every one of them is settled.
 */
async function readQuestions(state: PoolState): Promise<void> {
  const { ctx, threadId } = state.scope;
  const after = state.cursor ?? undefined;
  const events: EventEnvelope[] = await ctx.call(HostMethod.EventsList, { threadId, after }).catch(() => []);
  for (const event of events) {
    state.cursor = event.id;
    const question = questionOf(event);
    if (!question || !recordOf(state, question.worker?.id)) continue;
    if (question.state === WORKER_QUESTION_PENDING) state.pending.set(question.requestId, question);
    else state.pending.delete(question.requestId);
  }
  for (const record of runningRecords(state)) {
    const asked = [...state.pending.values()].filter((question) => question.worker?.id === record.id).at(-1);
    record.question = asked ? questionText(asked) : null;
    record.state = asked ? WorkerState.WaitingForPerson : WorkerState.Running;
  }
}

// ── status and wait ──────────────────────────────────────────────────────────────────────────

/** What follows a worker's state in its line: its question, its work to mark, its verdict or why it ended. */
function extraOf(record: WorkerRecord): string {
  if (record.state === WorkerState.WaitingForPerson && record.question) return POOL_WORDS.waiting(record.question);
  if (record.verdict) return POOL_WORDS.marked(record.verdict);
  if (record.state === WorkerState.Failed) return POOL_WORDS.failedWith(record.error ?? "");
  if (record.state === WorkerState.Stopped) return POOL_WORDS.stoppedBy(record.error ?? POOL_WORDS.stoppedByLead);
  if (record.state !== WorkerState.Done) return "";
  if (record.isolation !== WorkerIsolation.Copy) return record.error ?? "";
  return record.commit ? POOL_WORDS.ready(record.id) : POOL_WORDS.nothingChanged;
}

/** One worker's line. */
function lineOf(state: PoolState, record: WorkerRecord): string {
  const minutes = Math.round(((record.endedAt ?? state.scope.clock.now()) - record.startedAt) / MINUTE_MS);
  const { id, title, isolation } = record;
  return POOL_WORDS.status({ id, title, isolation, state: record.state, minutes, extra: extraOf(record) });
}

/** `worker_status`: one worker's line, or every worker's. */
async function statusOf(state: PoolState, id: unknown): Promise<string> {
  await readQuestions(state);
  const listed = hasText(id) ? state.records.filter((record) => record.id === id) : state.records;
  if (hasText(id) && !listed.length) return POOL_WORDS.unknown(id);
  if (!listed.length) return POOL_WORDS.none;
  return listed.map((record) => lineOf(state, record)).join("\n");
}

/** `worker_wait`'s seconds as a whole number from 1 to the cap. */
function waitSeconds(raw: unknown): number {
  const seconds = Math.floor(Number(raw ?? DEFAULT_WAIT_S));
  return Number.isFinite(seconds) ? Math.min(MAX_WORKER_WAIT_S, Math.max(1, seconds)) : DEFAULT_WAIT_S;
}

/** Where the workers a wait watches stand, as one string: a change wakes the wait. */
function standing(records: readonly WorkerRecord[]): string {
  return records.map((record) => `${record.id}:${record.state}:${record.question ?? ""}`).join("|");
}

/**
 * `worker_wait`: until the worker named (or any worker) ends or waits on the person, or the seconds
 * pass; answers where they stand then.
 */
async function waitWorkers(state: PoolState, args: AnyRecord): Promise<string> {
  const id = [args.id, args.worker].find(hasText) ?? null;
  if (id && !recordOf(state, id)) return POOL_WORDS.unknown(id);
  const { clock } = state.scope;
  const deadline = clock.now() + waitSeconds(args.seconds) * SECOND_MS;
  const watched = () => (id ? state.records.filter((record) => record.id === id) : runningRecords(state));
  // A question asked since the lead last looked wakes the wait at once.
  const before = standing(watched());
  await readQuestions(state);
  while (standing(watched()) === before && clock.now() < deadline && watched().some(isWorking)) {
    const runs = watched().flatMap((record) => state.runs.get(record.id) ?? []);
    await Promise.race([...runs, clock.sleep(Math.min(QUESTION_POLL_MS, deadline - clock.now()))]);
    await readQuestions(state);
  }
  return statusOf(state, id);
}

// ── steer and stop ───────────────────────────────────────────────────────────────────────────

/** `worker_steer`: words for one running worker, read now (its session is interrupted and resumed) or as it goes on. */
async function steerWorker(state: PoolState, args: AnyRecord): Promise<string> {
  const record = recordOf(state, args.id);
  if (!record) return POOL_WORDS.unknown(String(args.id ?? ""));
  if (!isWorking(record)) return POOL_WORDS.notRunning(record.id, record.state);
  if (!hasText(args.text)) return POOL_WORDS.noText;
  state.steers.set(record.id, [...(state.steers.get(record.id) ?? []), args.text.trim()]);
  const params = { cwd: cwdOf(state, record), worker: record.id };
  const answer = await state.scope.ctx.call(HostMethod.EngineInterrupt, params).catch(() => null);
  return answer?.interrupted === true ? POOL_WORDS.steered(record.id) : POOL_WORDS.steerQueued(record.id);
}

/** Stop one worker's session: it is stopped first, so its end reads as a stop, never a failure. */
async function abortWorker(
  state: PoolState,
  record: WorkerRecord,
  why: string,
  code: WorkerStopCode,
): Promise<boolean> {
  record.state = WorkerState.Stopped;
  record.error = why;
  record.stopCode = code;
  record.question = null;
  return sendAbort(state, record);
}

/** The host's abort for one worker's session, by its folder and id: whether it found the session. */
async function sendAbort(state: PoolState, record: WorkerRecord): Promise<boolean> {
  const params = { cwd: cwdOf(state, record), worker: record.id };
  const answer = await state.scope.ctx.call(HostMethod.EngineAbort, params).catch(() => null);
  return (answer?.aborted ?? 0) > 0;
}

/**
 * Wait for a stopped worker's session to end, sending the stop again while the host found none to
 * stop and the session has not ended: one that reached the host before its session registered
 * aborted nothing (and it takes no further leg).
 */
async function untilEnded(state: PoolState, record: WorkerRecord, found: boolean): Promise<void> {
  const run = state.runs.get(record.id);
  let done = run === undefined;
  void run?.finally(() => {
    done = true;
  });
  for (let sent = 0, stopped = found; !done && !stopped && sent < ABORT_RESENDS; sent += 1) {
    await Promise.race([run, state.scope.clock.sleep(ABORT_RETRY_MS)]);
    if (!done) stopped = await sendAbort(state, record);
  }
  await run;
}

/** `worker_stop`: that worker alone stops; a copy's work so far is committed for `worker_mark`. */
async function stopWorker(state: PoolState, args: AnyRecord): Promise<string> {
  const record = recordOf(state, args.id);
  if (!record) return POOL_WORDS.unknown(String(args.id ?? ""));
  if (!isWorking(record)) return POOL_WORDS.notRunning(record.id, record.state);
  const why = hasText(args.why) ? args.why.trim() : POOL_WORDS.stoppedByLead;
  const found = await abortWorker(state, record, why, WorkerStopCode.StoppedByLead);
  await untilEnded(state, record, found);
  return POOL_WORDS.stopped(record.id);
}

// ── the close ────────────────────────────────────────────────────────────────────────────────

/**
 * The scope ended: running workers are stopped and given a while to settle; every copy's work is
 * committed, kept on its ref unless the lead already marked it, and the copy removed; the records
 * persist for a later turn. A session still going after the wait may still write in its copy: that
 * copy is handed back once the session ends.
 */
async function closePool(state: PoolState): Promise<void> {
  state.closing = true;
  const why = state.scope.runId ? POOL_WORDS.runEnded : POOL_WORDS.turnEnded;
  for (const record of runningRecords(state)) await abortWorker(state, record, why, scopeEnd(state));
  const runs = [...state.runs.values()];
  await Promise.race([Promise.all(runs), state.scope.clock.sleep(SETTLE_WAIT_MS)]);
  for (const record of state.records) {
    if (!record.worktree) continue;
    const run = state.runs.get(record.id);
    if (run)
      state.handingBack.set(
        record.id,
        run.then(() => handBack(state, record)).catch(() => {}),
      );
    else await handBack(state, record);
  }
  // A turn that started no worker leaves the chat's records as they were.
  if (state.records.length) await persist(state);
}

/** A copy worker's work handed back at the close: committed, kept on its ref unless marked, the copy removed. */
async function handBack(state: PoolState, record: WorkerRecord): Promise<void> {
  await commitCopy(state, record);
  if (!record.verdict) await keepWork(state, record);
  await removeCopy(state, record);
  await persist(state);
}
