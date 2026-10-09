/**
 * Memory admission before a round. `worker_start`
 * checks free memory once, when the worker's window opens; a round hours later starts a build
 * and three game loads on whatever the machine has left, and a window the OS kills mid-pass
 * costs the round. A worker whose machine is short of memory waits for it at the round's
 * boundary instead. It records that once, and while it waits its status line and its loop's
 * phase (what the director's `run_status` shows) say why it is idle. A stop, a wrap-up or the
 * user's cancel ends the wait at the next poll. A capacity call that fails never holds a round:
 * it says nothing about the machine.
 */
import { HostMethod } from "../host-methods.ts";
import { RunEvent } from "../run-events.ts";
import { SECOND_MS } from "../time.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { FacetLoop } from "./state.ts";

/** A running worker's round needs this much free memory (a new worker's window needs MIN_FREE_MB). */
export const ROUND_MIN_FREE_MB = 512;
/** How often a waiting round asks the machine again. */
export const MACHINE_PRESSURE_POLL_MS = 15 * SECOND_MS;

/** The loop's phase while it waits, as the director's digest reads it beside "building" and "verifying". */
const WAITING_PHASE = "waiting for memory";

/** What admission reads off the loop: its host, clock, deadline, run log and stop signals. */
type AdmissionLoop = Pick<
  FacetLoop,
  "appendRun" | "ctx" | "deadline" | "facet" | "finishRequested" | "iterationsThisRound" | "run" | "sleepFor"
> &
  Partial<Pick<FacetLoop, "emitLoopState">> & {
    /** The clock `sleepFor` moves and `deadline` is read on; the wall clock when the loop has none. */
    now?: () => number;
  };

/** Free memory as the host reports it, or null when it says nothing (an older host, a failed call). */
async function freeMemoryMb(ctx: AdmissionLoop["ctx"]): Promise<number | null> {
  try {
    const capacity = (await ctx.call(HostMethod.PreviewCapacity, {})) as AnyRecord | null;
    const freeMb = capacity?.memory?.freeMb;
    return typeof freeMb === "number" && Number.isFinite(freeMb) ? freeMb : null;
  } catch {
    return null;
  }
}

/** Is the machine short of memory for a round, as far as anybody can tell? */
function underPressure(freeMb: number | null): freeMb is number {
  return freeMb !== null && freeMb < ROUND_MIN_FREE_MB;
}

/**
 * Has somebody asked this worker to stop: the user's cancel, the director's worker_stop or the
 * run wrapping up? The same answer openRound's finish gate reads; a probe that fails is no stop.
 */
async function stopAsked(loop: AdmissionLoop): Promise<boolean> {
  if (loop.ctx.cancelled) return true;
  return Boolean(await loop.finishRequested(loop.iterationsThisRound).catch(() => false));
}

/** Can the facet wait one more poll and still have time left after it, with nobody asking it to stop? */
async function canWaitAnotherPoll(loop: AdmissionLoop): Promise<boolean> {
  const now = loop.now?.() ?? Date.now();
  if (now + MACHINE_PRESSURE_POLL_MS >= loop.deadline) return false;
  return !(await stopAsked(loop));
}

/** Say why the worker is idle: its status line, and the loop's phase the director reads. */
function sayWaiting(loop: AdmissionLoop, iteration: number, freeMb: number): void {
  const { ctx, facet, run } = loop;
  // One literal, so the status gate (words.test.ts) reads it like every other status.
  ctx.setStatus(
    `run ${run.runId} · ${facet.title} — waiting for memory (${Math.round(freeMb)} MB free, a round needs ${ROUND_MIN_FREE_MB} MB)`,
  );
  try {
    loop.emitLoopState?.(WAITING_PHASE, iteration);
  } catch {
    /* the watcher is a courtesy; the wait is the work */
  }
}

/**
 * Wait while the machine has less than ROUND_MIN_FREE_MB free, the facet's clock allows another
 * poll and nobody has asked it to stop. Records one FacetMachinePressure per wait; the round's
 * own gates (a stop, the clock) decide what happens after it.
 */
export async function admitRound(loop: AdmissionLoop, iteration: number): Promise<void> {
  let freeMb = await freeMemoryMb(loop.ctx);
  if (!underPressure(freeMb) || !(await canWaitAnotherPoll(loop))) return;
  sayWaiting(loop, iteration, freeMb);
  await loop
    .appendRun(RunEvent.FacetMachinePressure, {
      runId: loop.run.runId,
      facetId: loop.facet.id,
      iteration,
      freeMb,
      needMb: ROUND_MIN_FREE_MB,
    })
    .catch(() => {});
  do {
    await loop.sleepFor(MACHINE_PRESSURE_POLL_MS);
    freeMb = await freeMemoryMb(loop.ctx);
  } while (underPressure(freeMb) && (await canWaitAnotherPoll(loop)));
}
