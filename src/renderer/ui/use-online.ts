/**
 * Whether this Mac has a network connection, as the browser knows it, news of it coming back, and a
 * failed read tried again by itself.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";

/** How long a failed read waits before it tries again by itself, failure after failure: soon, then once a minute. */
export const TRY_AGAIN_WAITS_MS: readonly number[] = [3 * SECOND_MS, 10 * SECOND_MS, 30 * SECOND_MS, MINUTE_MS];
/**
 * How many of those tries a failure stays out of sight for, the screen still loading: past them
 * (about 10 s, with main's own tries of each read) the failure and its Try again show, and the
 * tries go on.
 */
export const QUIET_TRIES = 1;

const listen = (changed: () => void): (() => void) => {
  window.addEventListener("online", changed);
  window.addEventListener("offline", changed);
  return () => {
    window.removeEventListener("online", changed);
    window.removeEventListener("offline", changed);
  };
};

/**
 * Whether the Mac is online. False means no network at all; true can still mean a server that does
 * not answer, which reads as an ordinary failure.
 */
export const useOnline = (): boolean =>
  useSyncExternalStore(
    listen,
    () => navigator.onLine,
    () => true,
  );

/** Run `onBack` each time the connection comes back; the latest `onBack` runs, without listening again. */
export function useBackOnline(onBack: () => void): void {
  const latest = useRef(onBack);
  latest.current = onBack;
  useEffect(() => {
    const back = () => latest.current();
    window.addEventListener("online", back);
    return () => window.removeEventListener("online", back);
  }, []);
}

/** What a failed read's tries again need of the window: a timer, its events, and whether it is online. */
export interface TryAgainClock {
  /** Run `run` after `ms`; answers the cancel. */
  after(ms: number, run: () => void): () => void;
  /** Run `run` on each `event`; answers the stop. */
  on(event: "online" | "focus", run: () => void): () => void;
  online(): boolean;
}

/** The window's own clock and events. */
const WINDOW_CLOCK: TryAgainClock = {
  after: (ms, run) => {
    const timer = window.setTimeout(run, ms);
    return () => window.clearTimeout(timer);
  },
  on: (event, run) => {
    window.addEventListener(event, run);
    return () => window.removeEventListener(event, run);
  },
  online: () => navigator.onLine,
};

/**
 * A read's failures in a row, and its tries again while one is shown: `watch` waits the next of
 * `waits` (the last once they run out) and tries again, unless the Mac is offline, and tries at once
 * when it comes back online or the window comes forward; `reset` starts the waits over, as `readOf`
 * does when another read (a tab, a search) takes the failed one's place.
 */
export function failedRead(
  clock: TryAgainClock,
  waits: readonly number[] = TRY_AGAIN_WAITS_MS,
  tried: (tries: number) => void = () => {},
) {
  let tries = 0;
  let reading: string | undefined;
  return {
    /** Try `again` while the read stays failed; answers the stop, for when it no longer is. */
    watch(again: () => void): () => void {
      const waitMs = waits[Math.min(tries, waits.length - 1)] ?? MINUTE_MS;
      const stops = [
        clock.after(waitMs, () => {
          if (!clock.online()) return;
          tries += 1;
          tried(tries);
          again();
        }),
        clock.on("online", again),
        clock.on("focus", again),
      ];
      return () => {
        for (const stop of stops) stop();
      };
    },
    /** The read succeeded: the next failure waits the first wait again, out of sight again. */
    reset(): void {
      tries = 0;
      tried(tries);
    },
    /** The read now on screen: another one than before starts the waits over, out of sight again. */
    readOf(of: string | undefined): void {
      if (of === reading) return;
      reading = of;
      this.reset();
    },
  };
}

/**
 * Whether a failed read's notice shows after `tries` tries again by itself: offline at once (the
 * offline notice), else once its quiet tries are spent; until then the screen shows it loading.
 */
export const failureShown = (tries: number, online: boolean): boolean => !online || tries >= QUIET_TRIES;

/** Where a read stands for `useTriesAgain`: failed, or read (the waits start over). */
export interface ReadStanding {
  failed: boolean;
  read: boolean;
  /** Which read it is (a tab, a search): another one starts its waits over, out of sight again. */
  of?: string;
}

/**
 * Try a read that failed again by itself, so a failure that passes (a network not up yet as Genex
 * starts, a server restarting) is never left on screen until someone presses Try again
 * (`failedRead`, over the window's own clock). Answers whether the failure shows: until its quiet
 * tries are spent the screen keeps loading (`failureShown`).
 */
export function useTriesAgain(standing: ReadStanding, retry: () => void): boolean {
  const latest = useRef(retry);
  latest.current = retry;
  const [tries, setTries] = useState(0);
  const [reads] = useState(() => failedRead(WINDOW_CLOCK, TRY_AGAIN_WAITS_MS, setTries));
  const online = useOnline();
  const { failed, read, of } = standing;
  useEffect(() => {
    if (read) reads.reset();
  }, [reads, read]);
  useEffect(() => reads.readOf(of), [reads, of]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: another read arms its own first wait.
  useEffect(() => (failed ? reads.watch(() => latest.current()) : undefined), [reads, failed, of]);
  return failed && failureShown(tries, online);
}
