/**
 * How soon a plugin's backend may start again after it ended. A backend that ends once starts
 * again on the next call, as it always did. One that keeps ending soon after its last end (on
 * Windows shutting down, every call forked a backend that died at once: 85 ends in 3 s) waits a
 * pause that doubles with each end, so the ends stop forking new backends meanwhile.
 * Kept free of processes, with an injectable clock, so a test decides when time passes.
 */
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";

/** Two ends at most this far apart are one streak; a longer quiet starts the count again. */
const STREAK_WINDOW_MS = MINUTE_MS;
/** The pause after a backend's second end in a streak; each end after it doubles it. */
const FIRST_PAUSE_MS = SECOND_MS;
/** The longest pause, however long the streak. */
const LONGEST_PAUSE_MS = 30 * SECOND_MS;

/** One plugin's ends in a row: how many, and when the last was. */
interface Streak {
  ends: number;
  at: number;
}

/** The pause before the next start after `ends` ends in a row: none after the first. */
function pauseAfter(ends: number): number {
  if (ends < 2) return 0;
  return Math.min(FIRST_PAUSE_MS * 2 ** (ends - 2), LONGEST_PAUSE_MS);
}

/** Each plugin's streak of backend ends, and the pause it asks before the next start. */
export function createRestartPause(now: () => number = Date.now) {
  const streaks = new Map<string, Streak>();
  return {
    /** The plugin's backend ended now. */
    ended(id: string): void {
      const at = now();
      const last = streaks.get(id);
      const inStreak = last !== undefined && at - last.at <= STREAK_WINDOW_MS;
      streaks.set(id, { ends: inStreak ? last.ends + 1 : 1, at });
    },
    /** How long the plugin's backend must still wait before it starts again, in ms; 0 starts it now. */
    remaining(id: string): number {
      const last = streaks.get(id);
      if (!last) return 0;
      return Math.max(0, last.at + pauseAfter(last.ends) - now());
    },
    /** Start the plugin's count again: the person turned it on or loaded it anew. */
    forget(id: string): void {
      streaks.delete(id);
    },
  };
}

/** What {@link createRestartPause} answers. */
export type RestartPause = ReturnType<typeof createRestartPause>;
