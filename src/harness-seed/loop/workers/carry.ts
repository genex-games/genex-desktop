/**
 * A chat turn's workers when the turn launches a Loop (the person switched the Loop on while they
 * worked, steer-switch.ts). A Loop that works in the game folder itself takes them over: its run's
 * pool is this same pool, re-scoped to the run, so they keep going and its lead — the chat's own
 * session — hears and marks them as its own (`carryPool`, then run-pool.ts `runPool`). A Loop on a
 * copy (a web game's build), or a turn with a writer in the game folder (it holds the chat's lock
 * for its life), does not take them over: the session waits for them and marks what they made
 * before it launches (SWITCH_NOTES.workersLand), and a writer in the game folder still at work is
 * waited for, so the build starts from the folder as it leaves it (`landWorkers`). Anything else
 * still at work stops, as a turn's workers always did; a copy's work stays on its ref.
 *
 * A module of its own: the chat's workers (chat-workers.ts) and the run's pool (run-pool.ts) read it,
 * and a seed upgrade keeps an older copy of either the agent edited, which never imported it.
 */
import { HostMethod } from "../host-methods.ts";
import { MINUTE_MS, SECOND_MS } from "../time.ts";
import { WorkerIsolation } from "./contract.ts";
import type { WorkerPool } from "./pool.ts";
import { isWorking, persist, recordsArtifact, type WorkerRecord, WorkerState, type WorkerScope } from "./records.ts";

/**
 * How long a carried pool waits for its run to take it before its workers stop, as a turn's would:
 * long enough for a run that waits to start (its folder busy, a sign-in checked), short enough that
 * workers whose run never came do not work on unwatched.
 */
export const CARRY_TAKE_MS = 10 * MINUTE_MS;
/** How long a launch waits for its turn's workers to finish before the rest stop and the build starts. */
export const LAND_WAIT_MS = 30 * MINUTE_MS;
/** How often a landing wait looks for a Stop, and a carried pool whether its run took it. */
const LAND_POLL_MS = SECOND_MS;

/** What becomes of a chat turn's workers as it ends: stop (the default), finish first, or carry into its build. */
export const WorkersEnd = {
  Stop: "stop",
  Land: "land",
  Carry: "carry",
} as const;
export type WorkersEnd = (typeof WorkersEnd)[keyof typeof WorkersEnd];

/** Pools a launched Loop takes over, by chat, with the turn that started them and what ends their wait. */
const carried = new Map<string, { pool: WorkerPool; turn: string; taken: () => void }>();

/** A writer works in the game folder itself: it holds the chat's lock for its life, which no run can take over. */
function writesInPlace(record: WorkerRecord): boolean {
  return isWorking(record) && record.isolation === WorkerIsolation.Lock;
}

/**
 * How this pool's workers end with a launch that takes them over when it can: carried, or landing
 * first when one of them writes in the game folder itself.
 */
export function carriedEnd(pool: WorkerPool): WorkersEnd {
  return pool.state.records.some(writesInPlace) ? WorkersEnd.Land : WorkersEnd.Carry;
}

/**
 * Hand this chat turn's pool to the Loop it launched. The run's pool takes it once it opens
 * (`takeCarriedPool`); one nobody takes within `CARRY_TAKE_MS` closes, its workers stopped.
 */
export function carryPool(threadId: string, turn: string, pool: WorkerPool): void {
  const earlier = takeCarriedPool(threadId);
  if (earlier) void earlier.pool.close().catch(() => {});
  let isTaken = false;
  carried.set(threadId, {
    pool,
    turn,
    taken: () => {
      isTaken = true;
    },
  });
  void closeUntaken(threadId, pool, () => isTaken);
}

/** Close a carried pool its run has not taken within `CARRY_TAKE_MS`; a pool taken meanwhile stops the wait. */
async function closeUntaken(threadId: string, pool: WorkerPool, taken: () => boolean): Promise<void> {
  const { clock } = pool.state.scope;
  const until = clock.now() + CARRY_TAKE_MS;
  while (!taken() && clock.now() < until) await clock.sleep(Math.min(LAND_POLL_MS, until - clock.now()));
  if (taken() || carried.get(threadId)?.pool !== pool) return;
  carried.delete(threadId);
  await pool.close().catch(() => {});
}

/** The pool a Loop launched from this chat takes over, if one waits; it is the taker's from now on. */
export function takeCarriedPool(threadId: string): { pool: WorkerPool; turn: string } | null {
  const waiting = carried.get(threadId);
  if (!waiting) return null;
  carried.delete(threadId);
  waiting.taken();
  return { pool: waiting.pool, turn: waiting.turn };
}

/** A launch that did not start: the pool it was to take over closes, its workers stopped. */
export async function closeCarriedPool(threadId: string): Promise<void> {
  const waiting = takeCarriedPool(threadId);
  await waiting?.pool.close().catch(() => {});
}

/**
 * The run takes the carried pool over: the records of the turn that started it move from the chat's
 * artifact to the run's (the chat keeps its earlier turns' workers), and from now on the pool works
 * in the run's scope — its records, its refs, its git order, its lead's news and its close.
 */
export async function adoptPool(
  carriedPool: { pool: WorkerPool; turn: string },
  scope: WorkerScope & { runId: string },
): Promise<WorkerPool> {
  const { pool, turn } = carriedPool;
  const { state } = pool;
  const chat = state.scope;
  // The chat keeps its earlier turns' workers; this turn's are the run's now. Re-scoped at once, so a
  // worker ending meanwhile records itself where it now belongs.
  const earlier = state.records.filter((record) => record.turn !== turn);
  state.records = state.records.filter((record) => record.turn === turn);
  state.scope = { ...scope, ...(chat.ask ? { ask: chat.ask } : {}) };
  await chat.ctx
    .call(HostMethod.ArtifactWrite, {
      threadId: chat.threadId,
      artifactId: recordsArtifact(chat),
      value: { workers: earlier },
    })
    .catch(() => {});
  await persist(state);
  return pool;
}

/**
 * Let a turn's writers in the game folder finish before the build its launch starts: what they
 * write lands in the folder the build starts from. They are waited for, up to `LAND_WAIT_MS` and
 * until a Stop, then the pool closes as a turn's does: anything still at work stops (a reader, a
 * copy whose work nobody is left to mark, a writer waiting on the person or past the wait). Says
 * so on the status line.
 */
export async function landWorkers(
  pool: WorkerPool,
  ctx: { readonly cancelled?: boolean; setStatus?: (status: string) => void },
): Promise<void> {
  const { clock } = pool.state.scope;
  const until = clock.now() + LAND_WAIT_MS;
  const running = () =>
    pool.state.records.filter((record) => record.state === WorkerState.Running && writesInPlace(record));
  if (running().length) ctx.setStatus?.("starting the Loop once the workers finish");
  while (running().length && !ctx.cancelled && clock.now() < until) {
    const runs = running().flatMap((record) => pool.state.runs.get(record.id) ?? []);
    await Promise.race([...runs, clock.sleep(Math.min(LAND_POLL_MS, until - clock.now()))]);
  }
  await pool.close();
}
