/**
 * One close and one finish at a time for a director's run. The lead's `finish` (a claim's check
 * takes minutes) and the harness's own close of a run its lead left open (the clock, a session the
 * engine ended) can overlap: the close is latched as it starts, so a second asker waits for the one
 * under way instead of landing again, and a check that finds the run closing records no answer. A
 * finish is latched from its first line, so a lead's parallel call cannot start a second one.
 *
 * Kept per run state in memory: a run's close happens in the process that runs it. A module of its
 * own, so the shipped parts that read it (integrate.ts, director.ts) need no new name from a module
 * an agent may have kept.
 */
import type { AnyRecord } from "../../types/harness.d.ts";

/** The close under way of each run, by its state. */
const CLOSES = new WeakMap<object, Promise<AnyRecord>>();
/** The runs whose lead's `finish` is under way, by their state. */
const FINISHING = new WeakSet<object>();

/** Whether the run's close has started (it may still be running). */
export function closeUnderWay(state: object): boolean {
  return CLOSES.has(state);
}

/**
 * The run's one close: the one under way when there is one, else `start`'s, latched before it
 * begins. A close that fails before its run is finished lets go of the latch, so a later close (the
 * harness's own, of a run its lead left open) tries again rather than reading the same failure; an
 * asker that joined it while it ran tries once more the same way (`joined`).
 */
export function latchClose(
  state: object & { finished?: unknown },
  start: () => Promise<AnyRecord>,
): Promise<AnyRecord> {
  const under = CLOSES.get(state);
  if (under) return joined(state, under, start);
  const close = start();
  CLOSES.set(state, close);
  close.catch(() => {
    if (!state.finished && CLOSES.get(state) === close) CLOSES.delete(state);
  });
  return close;
}

/**
 * A close this asker joined while it ran: its landing, or, when it fails before its run is finished
 * (the latch has let it go by then), a close of this asker's own, latched as any close is.
 */
function joined(
  state: object & { finished?: unknown },
  under: Promise<AnyRecord>,
  start: () => Promise<AnyRecord>,
): Promise<AnyRecord> {
  return under.catch((error: unknown) => {
    if (state.finished) throw error;
    return latchClose(state, start);
  });
}

/**
 * Waits for the run's close under way, whatever it comes to (nothing to wait for when none started):
 * a teardown never ends the run while its close still writes how it ended.
 */
export async function closeSettled(state: object): Promise<void> {
  await CLOSES.get(state)?.catch(() => {});
}

/** Take the run's finish: false when one is already under way. */
export function holdFinish(state: object): boolean {
  if (FINISHING.has(state)) return false;
  FINISHING.add(state);
  return true;
}

/** Whether the run's lead's `finish` is under way (its claim being checked, or its close). */
export function finishUnderWay(state: object): boolean {
  return FINISHING.has(state);
}

/** Let the run's finish go (it answered without closing, or its close ended). */
export function releaseFinish(state: object): void {
  FINISHING.delete(state);
}
