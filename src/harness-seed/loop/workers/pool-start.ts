/**
 * `worker_start`: a reader in place, a writer in its own copy made after a snapshot (the host's copy
 * rules and size cap apply where it makes it), or the one writer in place. Its session runs
 * in the background in the chat's permission mode (the host seats it by the `worker` grant), goes on
 * with what the lead steers into it, and on its end a copy's work is committed for the lead to mark.
 */
import type { AnyRecord } from "../../types/harness.d.ts";
import type { DelegateResult, WorkerType } from "../../types/host-api.d.ts";
import { type HookScope, workerEndHooks, workerStartHooks } from "../hooks.ts";
import { HostMethod } from "../host-methods.ts";
import { CLIP_DETAIL, clip, hasText } from "../text.ts";
import {
  MAX_WORKERS_AT_ONCE,
  WORKER_TITLE_CHARS,
  WorkerEnd,
  WorkerIsolation,
  WorkerRefusal,
  WorkerStopCode,
} from "./contract.ts";
import { poolWorkerId, recordWorkerFinished, recordWorkerStarted } from "./events.ts";
import { changedBetween, gameFingerprint } from "./game-change.ts";
import { holdInPlace, releaseInPlace } from "./in-place.ts";
import { commitCopy, removeCopy } from "./pool-merge.ts";
import { POOL_WORDS, workerBrief } from "./prompts.ts";
import {
  eventScope,
  gameGitWrite,
  isWorking,
  type PoolState,
  persist,
  nextWorkerId,
  runningRecords,
  threadSlug,
  type WorkerRecord,
  WorkerState,
} from "./records.ts";

/** At most this many inputs per worker. */
const MAX_WORKER_INPUTS = 16;
/** The most characters of a task a worker is handed. */
const MAX_TASK_CHARS = 20_000;
/** The isolations a lead may ask for, as it sends them. */
const ISOLATIONS: readonly string[] = Object.values(WorkerIsolation);
/** How each state a worker ends in is recorded; a worker waiting on the person has not ended. */
const END_OF: Partial<Record<WorkerState, WorkerEnd>> = {
  [WorkerState.Done]: WorkerEnd.Done,
  [WorkerState.Failed]: WorkerEnd.Failed,
  [WorkerState.Stopped]: WorkerEnd.Stopped,
};

/** What a start asks for, read from the lead's arguments; or why it cannot start. */
type StartAsk = {
  title: string;
  task: string;
  isolation: WorkerIsolation;
  type: WorkerType | null;
  research: boolean;
  inputs: string[];
};

/** A game path a lead names as an input: relative, inside the project, no climb, no control characters. */
function inputProblem(input: string): boolean {
  const segments = input.split("/");
  const climbs = segments.some((segment) => segment === ".." || segment === "." || segment === "");
  return input.startsWith("/") || input.startsWith("~") || climbs || /[\0-\x1f\\]/.test(input);
}

/** The inputs a lead names, comma-separated; or the first that is not a path inside the project. */
function inputsOf(raw: unknown): { inputs: string[] } | { refused: string } {
  const list = hasText(raw) ? raw.split(",").map((item) => item.trim()) : [];
  const inputs = list.filter(Boolean).slice(0, MAX_WORKER_INPUTS);
  const bad = inputs.find(inputProblem);
  return bad === undefined ? { inputs } : { refused: POOL_WORDS.badInput(bad) };
}

/** The type a start names, by its id among those the plugins on offer declare; null when it names none. */
function typeOf(state: PoolState, raw: unknown): { type: WorkerType | null } | { refused: string } {
  if (!hasText(raw)) return { type: null };
  const type = state.types.find((known) => known.id === raw.trim());
  if (type) return { type };
  return {
    refused: POOL_WORDS.unknownType(
      raw.trim(),
      state.types.map((known) => known.id),
    ),
  };
}

/** What `worker_start`'s arguments ask for, or why it cannot start. */
function askOf(state: PoolState, args: AnyRecord): StartAsk | { refused: string } {
  if (!hasText(args.title) || !hasText(args.task)) return { refused: POOL_WORDS.noTask };
  const typed = typeOf(state, args.type);
  if ("refused" in typed) return typed;
  const asked = String(args.isolation ?? "").trim();
  const isolation = ISOLATIONS.includes(asked) ? (asked as WorkerIsolation) : typed.type?.isolation;
  if (!isolation) return { refused: POOL_WORDS.noIsolation };
  const read = inputsOf(args.inputs);
  if ("refused" in read) return read;
  const research = args.research === true || String(args.research ?? "").trim() === "yes";
  const title = clip(args.title.trim(), WORKER_TITLE_CHARS);
  return { title, task: clip(args.task.trim(), MAX_TASK_CHARS), isolation, type: typed.type, research, ...read };
}

/** Why a start that asks well still cannot start now: the pool is full. Whether the game folder is free, the host says (`holdInPlace`). */
function roomProblem(state: PoolState): string | null {
  const running = runningRecords(state);
  return running.length >= MAX_WORKERS_AT_ONCE ? POOL_WORDS.tooMany(running.length) : null;
}

/** A new worker's record. */
function newRecord(state: PoolState, ask: StartAsk): WorkerRecord {
  return {
    id: nextWorkerId(state),
    title: ask.title,
    task: ask.task,
    isolation: ask.isolation,
    type: ask.type?.id ?? null,
    research: ask.research,
    state: WorkerState.Running,
    worktree: null,
    base: null,
    commit: null,
    startedAt: state.scope.clock.now(),
    endedAt: null,
    error: null,
    verdict: null,
    question: null,
    turn: state.scope.turn ?? null,
  };
}

/** The copy a writer works in: a snapshot of the game first, so the copy holds the lead's work so far. */
async function makeCopy(state: PoolState, record: WorkerRecord): Promise<void> {
  const { ctx, project, runId, threadId } = state.scope;
  const reason = POOL_WORDS.snapshotReason(record.id);
  // The snapshot commits in the game folder, and the copy is made from it: one write, after the lead's.
  const copy = await gameGitWrite(state, async () => {
    const snapshot = await ctx.call(HostMethod.SnapshotCreate, { scope: "game", reason, project });
    const commit = snapshot?.git?.game;
    return ctx.call(HostMethod.SnapshotWorktree, {
      project,
      ...(commit ? { commit } : {}),
      name: `worker-${record.id}`,
      runId: runId ?? `chat-${threadSlug(threadId)}`,
    });
  });
  record.worktree = copy.path;
  record.base = copy.commit;
}

/** A copy the host would not make: its own words when it was too large, pointing at work in place. */
function copyRefusal(err: unknown): string {
  const why = String((err as Error)?.message ?? err);
  if ((err as AnyRecord | null)?.code === WorkerRefusal.CopyTooLarge) return POOL_WORDS.copyTooLarge(why);
  return POOL_WORDS.noCopy(clip(why, CLIP_DETAIL));
}

/** `worker_start`: the worker's id once it runs in the background, or why it did not start. */
export async function startWorker(state: PoolState, args: AnyRecord): Promise<string> {
  const ask = askOf(state, args);
  if ("refused" in ask) return ask.refused;
  const room = roomProblem(state);
  if (room) return room;
  const record = newRecord(state, ask);
  // Its id and room are taken at once: a start in flight beside it numbers apart and counts.
  state.records.push(record);
  // A plugin of the game may hold the worker back: nothing of it is made or written.
  const blocked = await workerStartHooks(state.scope.ctx, state.scope.game, momentScope(state), workerOf(record));
  if (blocked) {
    unreserve(state, record);
    return POOL_WORDS.startHeld(blocked);
  }
  const refused = await prepareWorkplace(state, record, ask.isolation);
  if (refused) {
    // Its start was announced: so is its end, though it never ran.
    unreserve(state, record);
    await workerEndHooks(state.scope.ctx, state.scope.game, momentScope(state), workerOf(record));
    return refused;
  }
  const prompt = workerBrief({
    identity: state.scope.identity,
    ...ask,
    typeDescription: ask.type?.description ?? null,
  });
  // Written before its session starts, so its start always comes before its end in the log.
  await recordStart(state, record);
  const work = runWorker(state, record, ask, prompt)
    .catch((err: unknown) => ended(state, record, WorkerState.Failed, failureWords(err), null, failureCode(err)))
    .finally(() => state.runs.delete(record.id));
  state.runs.set(record.id, work);
  await persist(state);
  return POOL_WORDS.started(record.id, record.isolation);
}

/** A worker that did not start leaves the pool's records. */
function unreserve(state: PoolState, record: WorkerRecord): void {
  const at = state.records.indexOf(record);
  if (at >= 0) state.records.splice(at, 1);
}

/**
 * Where the worker works, made ready: the game folder held for a writer in place (and how it
 * stood then: its end says whether it changed, `recordEnd`), or its copy. Why not, or null.
 */
async function prepareWorkplace(
  state: PoolState,
  record: WorkerRecord,
  isolation: WorkerRecord["isolation"],
): Promise<string | null> {
  if (isolation === WorkerIsolation.Lock) {
    const held = await holdInPlace(state, record);
    if ("refused" in held) return held.refused;
    record.where = held.where;
    record.gameTree = await gameFingerprint(state.scope.ctx, state.scope.project);
  }
  if (isolation === WorkerIsolation.Copy) {
    try {
      await makeCopy(state, record);
    } catch (err) {
      return copyRefusal(err);
    }
    // The pool closed while the copy was being made: no session starts, and the copy, empty, goes.
    if (state.closing) await removeCopy(state, record);
  }
  return null;
}

/** A pool's moment: its game, chat and run, or the chat turn it serves. */
function momentScope(state: PoolState): HookScope {
  const { project, threadId, runId, turn } = state.scope;
  if (runId) return { project, threadId, runId };
  return { project, threadId, ...(turn ? { turn } : {}) };
}

/** A worker as Genex's moments name it. */
const workerOf = (record: WorkerRecord) => ({ id: record.id, title: record.title, type: record.type });

/** A worker's start on the chat's log, under its pool id: where it works in place, when it holds a plugin's lock. */
function recordStart(state: PoolState, record: WorkerRecord): Promise<void> {
  const { id, title, isolation, task, type, where } = record;
  const worker = { workerId: poolWorkerId(id), title, isolation, task, type, ...(where ? { where } : {}) };
  return recordWorkerStarted(eventScope(state, record), worker, state.scope.clock.now());
}

/**
 * A worker's end on the chat's log: how it ended, why, its first sentence, whether its copy holds
 * work, and whether it finished work it wrote in place in the game folder (in the game already:
 * only when the folder changed while it worked).
 */
function recordEnd(state: PoolState, record: WorkerRecord, summary: string | null): Promise<void> {
  const end = END_OF[record.state];
  if (!end) return Promise.resolve();
  const delivered = record.isolation === WorkerIsolation.Copy && Boolean(record.commit);
  const inGame = record.isolation === WorkerIsolation.Lock && end === WorkerEnd.Done && record.changedGame === true;
  const worker = { workerId: poolWorkerId(record.id), title: record.title, state: end, stoppedBecause: record.error };
  const ended = { ...worker, stopCode: record.stopCode ?? null, summary, delivered, inGame };
  return recordWorkerFinished(eventScope(state, record), ended, state.scope.clock.now());
}

/** The host refused a worker's session: the chat's Settings allow no more workers at once. */
const hostRefused = (err: unknown): boolean => (err as AnyRecord | null)?.code === WorkerRefusal.TooManyWorkers;

/** Why a worker's session did not run or went wrong: a refusal the host gave it, in its words. */
function failureWords(err: unknown): string {
  const why = clip(String((err as Error)?.message ?? err), CLIP_DETAIL);
  return hostRefused(err) ? POOL_WORDS.hostRefused(why) : why;
}

/** The same, as the code the app words. */
const failureCode = (err: unknown): WorkerStopCode =>
  hostRefused(err) ? WorkerStopCode.HostRefused : WorkerStopCode.Error;

/** One leg of a worker's session: its brief or what the lead steered, in a new session or `resume`d. */
function delegateLeg(
  state: PoolState,
  record: WorkerRecord,
  ask: StartAsk,
  leg: { prompt: string; resume: string | null },
): Promise<DelegateResult> {
  const { ctx, engine, model, effort, project, threadId, runId, turn, creditCap } = state.scope;
  const belongs = runId ? { runId } : { turn };
  return ctx.call(HostMethod.EngineDelegate, {
    engine,
    project,
    threadId,
    prompt: leg.prompt,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(creditCap === undefined ? {} : { creditCap }),
    ...(leg.resume ? { resume: leg.resume } : {}),
    ...(record.worktree ? { cwd: record.worktree } : {}),
    ...(record.isolation === WorkerIsolation.Read ? { readOnly: true } : {}),
    ...(ask.type ? { toolAllow: [...ask.type.tools] } : {}),
    worker: { id: record.id, title: record.title, ...belongs, research: record.research },
  });
}

/** A worker's sessions: its brief, then each steer the lead queued while it worked, in the same session. */
async function runWorker(state: PoolState, record: WorkerRecord, ask: StartAsk, prompt: string): Promise<void> {
  if (state.closing) return ended(state, record, WorkerState.Stopped, POOL_WORDS.turnEnded, null, scopeEnd(state));
  // Stopped while its copy was being made: no session starts.
  if (!isWorking(record)) return ended(state, record, record.state, record.error);
  let result = await delegateLeg(state, record, ask, { prompt, resume: null });
  for (let steer = takeSteer(state, record); steer && result.sessionId; steer = takeSteer(state, record))
    result = await delegateLeg(state, record, ask, { prompt: steer, resume: result.sessionId });
  if (record.isolation === WorkerIsolation.Copy) await commitCopy(state, record);
  if (!isWorking(record)) return ended(state, record, record.state, record.error);
  if (!result.ok) {
    const why = clip(result.errorText || result.summary || result.stopReason || "", CLIP_DETAIL);
    return ended(state, record, WorkerState.Failed, why, null, WorkerStopCode.Error);
  }
  return ended(state, record, WorkerState.Done, null, result.summary ?? null);
}

/** What the lead steered into a running worker, all of it, for its next leg; null when nothing waits. */
function takeSteer(state: PoolState, record: WorkerRecord): string | null {
  const queued = state.steers.get(record.id) ?? [];
  state.steers.delete(record.id);
  return isWorking(record) && queued.length ? queued.join("\n\n") : null;
}

/** Why a worker stops when its pool's scope ends: the run's end, else the chat turn's. */
export const scopeEnd = (state: PoolState): WorkerStopCode =>
  state.scope.runId ? WorkerStopCode.RunEnded : WorkerStopCode.TurnEnded;

/**
 * A worker's end: where it stands and why (the lead's words, and `code`, the app's: by default what
 * a stop already set), persisted and recorded with its own summary when it gave one.
 */
export async function ended(
  state: PoolState,
  record: WorkerRecord,
  next: WorkerState,
  why: string | null,
  summary: string | null = null,
  code: WorkerStopCode | null = record.stopCode ?? null,
): Promise<void> {
  record.state = next;
  record.error = why;
  record.stopCode = next === WorkerState.Done ? null : code;
  record.question = null;
  record.endedAt = state.scope.clock.now();
  // Before the folder is free for another writer: did this one change it?
  if (record.isolation === WorkerIsolation.Lock && next === WorkerState.Done)
    record.changedGame = changedBetween(record.gameTree, await gameFingerprint(state.scope.ctx, state.scope.project));
  await persist(state);
  // The game folder is free for the next writer in place, in any pool of the game.
  await releaseInPlace(state, record);
  await recordEnd(state, record, summary);
  if (END_OF[record.state])
    await workerEndHooks(state.scope.ctx, state.scope.game, momentScope(state), workerOf(record));
  state.scope.onEnded?.(record);
}
