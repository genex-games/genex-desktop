/**
 * A status a card asks a plugin for while it shows (the Live stage's cards, the chat's setup card):
 * asked now and every `everyMs`, one ask at a time. A tick that finds an ask still out is skipped,
 * so a slow plugin is never asked twice at once and its answers land in the order they were asked.
 * Once stopped (the card went, or moved to another game) no answer lands and nothing more is asked.
 */
import { createRefresher } from "./state/refresher.ts";

/** The timers a poll runs on; tests pass their own. */
export interface PollTimers {
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const browserTimers: PollTimers = {
  setInterval: (run, ms) => globalThis.setInterval(run, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

/** A running poll: ask again now (after a press), or stop for good. */
export interface StatusPoll {
  /** Ask now; with an ask still out, once more after it. Resolves when the answer has landed. */
  refresh(): Promise<void>;
  stop(): void;
}

/**
 * Asks `ask` now and every `everyMs` until stopped, handing each answer to `apply`. `ask` answers
 * its own failures (a card shows "no answer" as it likes); a failure it throws lands nowhere.
 */
export function startStatusPoll<T>(
  ask: () => Promise<T>,
  apply: (answer: T) => void,
  everyMs: number,
  timers: PollTimers = browserTimers,
): StatusPoll {
  let stopped = false;
  const reads = createRefresher(ask, (answer) => {
    if (!stopped) apply(answer);
  });
  const timer = timers.setInterval(() => {
    if (!stopped && !reads.inFlight) void reads.request();
  }, everyMs);
  void reads.request();
  return {
    refresh: () => (stopped ? Promise.resolve() : reads.request()),
    stop() {
      if (stopped) return;
      stopped = true;
      reads.reset();
      timers.clearInterval(timer);
    },
  };
}
