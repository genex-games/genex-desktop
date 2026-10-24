/**
 * A worker's clock stands still while its model provider is away. A wait for the provider — an
 * outage's ladder, a limit's reset — is no time the worker spent building, so its deadline moves
 * on by what the wait took, up to its ceiling: the run's own working deadline, since the run's
 * clock never stops. A caller that gives no ceiling keeps the deadline where it was.
 */
import type { FacetLoop } from "./state.ts";

/** What the paused clock reads and moves on the loop. */
type ClockLoop = Pick<FacetLoop, "deadline" | "deadlineCeiling" | "onDeadline" | "sleepFor"> & {
  /** The clock `sleepFor` moves and `deadline` is read on; the wall clock when the loop has none. */
  now?: () => number;
};

/** The latest the facet's deadline may move to while its provider is away. */
export function clockRoom(loop: ClockLoop): number {
  const ceiling = loop.deadlineCeiling?.() ?? loop.deadline;
  return Math.max(loop.deadline, ceiling);
}

/** Move the deadline on by `ms` the provider took, within `clockRoom`; whoever watches is told. */
export function pauseClock(loop: ClockLoop, ms: number): void {
  const next = Math.min(loop.deadline + Math.max(0, ms), clockRoom(loop));
  if (next <= loop.deadline) return;
  loop.deadline = next;
  try {
    loop.onDeadline?.(next);
  } catch {
    /* the watcher is a courtesy; the clock is the loop's */
  }
}

/** Sleep `ms` waiting for the provider, the clock paused for as long as the sleep really took. */
export async function sleepOnPausedClock(loop: ClockLoop, ms: number): Promise<void> {
  const read = () => loop.now?.() ?? Date.now();
  const from = read();
  await loop.sleepFor(ms);
  pauseClock(loop, read() - from);
}
