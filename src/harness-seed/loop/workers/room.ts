/**
 * Room for a worker under the chat's Settings ceiling: the host refuses a worker's delegation past
 * the most workers the person allows at once, readers and writers alike
 * (`WorkerRefusal.TooManyWorkers`, read by its code). A run's builder, single worker or typed worker
 * whose turn is refused waits for room and tries again, until its own deadline: a full chat is a
 * wait, never a broken build.
 */
import type { AnyRecord } from "../../types/harness.d.ts";
import { SECOND_MS, sleep } from "../time.ts";
import { WorkerRefusal } from "./contract.ts";

/** How long a refused builder waits before it asks for room again. */
const ROOM_WAIT_MS = 10 * SECOND_MS;

/** Whether the host refused a delegation because the chat already runs as many workers as it allows. */
export function refusedForRoom(err: unknown): boolean {
  return (err as AnyRecord | null)?.code === WorkerRefusal.TooManyWorkers;
}

/** What a wait for room reads: the time, a pause, and whether the run was stopped meanwhile. */
export interface RoomClock {
  now(): number;
  wait(ms: number): Promise<unknown>;
  stopped(): boolean | Promise<boolean>;
}

/** The real clock, never stopped: a caller with a run passes its own `stopped`. */
const REAL_ROOM_CLOCK: RoomClock = { now: () => Date.now(), wait: sleep, stopped: () => false };

/** The real clock, stopped once `stopped` says so (the run was stopped, the worker ended). */
export function stoppableRoomClock(stopped: () => boolean): RoomClock {
  return { ...REAL_ROOM_CLOCK, stopped };
}

/**
 * Run `turn`, and while the host refuses it for room, wait and run it again; past `deadline` (ms
 * since the epoch), or once the run or the worker is stopped (before the wait or after it), the
 * refusal stands and the turn never runs again.
 */
export async function withWorkerRoom<T>(
  turn: () => Promise<T>,
  deadline: number,
  clock: RoomClock = REAL_ROOM_CLOCK,
): Promise<T> {
  for (;;) {
    try {
      return await turn();
    } catch (err) {
      const inTime = refusedForRoom(err) && clock.now() + ROOM_WAIT_MS < deadline;
      if (!inTime || (await clock.stopped())) throw err;
      await clock.wait(ROOM_WAIT_MS);
      if (await clock.stopped()) throw err;
    }
  }
}
