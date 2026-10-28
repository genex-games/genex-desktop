import { SECOND_MS } from "../../shared/duration.ts";

/**
 * The least time between two re-reads that a window coming back to the front or a tab chosen asks
 * for: a burst of them (focus, a tab, focus again) reads once. A press that changed something reads
 * again whatever the time.
 */
export const REREAD_GAP_MS = 2 * SECOND_MS;

/** Whether a re-read asked for at `now` is due: nothing was read yet, or the last read is at least the gap old. */
export const rereadDue = (last: number | undefined, now: number): boolean =>
  last === undefined || now - last >= REREAD_GAP_MS;

/**
 * One way to re-read something from main: `createRefresher(fetch, apply)`.
 *
 * - Serialized: one read runs at a time. Requests that arrive while it runs queue exactly one
 *   follow-up read, so a burst of notifications costs two reads, and the last one is answered.
 * - Stale answers are dropped: `reset()` (a new bootstrap, a store that moved on) makes every read
 *   already in flight land nowhere.
 * - Failures are caught: a read that fails keeps the last value and ends the burst; `onError`
 *   hears it. The next notification or poll asks again.
 */
export interface Refresher {
  /** Ask for a read. Resolves when this burst of reads has settled; never rejects. */
  request(): Promise<void>;
  /** Drop every answer still in flight. */
  reset(): void;
  readonly inFlight: boolean;
}

export function createRefresher<T>(
  fetch: () => Promise<T>,
  apply: (value: T) => void,
  options: { onError?: (error: unknown) => void; publish?: (apply: () => void) => void } = {},
): Refresher {
  // `busy` gates; `running` is only what a queued request waits on. A fetch that throws before its
  // first await settles the loop synchronously, so the gate must not be the promise itself.
  let busy = false;
  let running: Promise<void> = Promise.resolve();
  let again = false;
  let generation = 0;

  const loop = async (): Promise<void> => {
    try {
      do {
        again = false;
        const version = generation;
        let value: T;
        try {
          value = await fetch();
        } catch (error) {
          if (version === generation) options.onError?.(error);
          return;
        }
        const publish = options.publish ?? immediatePublication;
        publish(() => {
          if (version === generation) apply(value);
        });
      } while (again);
    } finally {
      busy = false;
    }
  };

  return {
    request() {
      if (busy) {
        again = true;
        return running;
      }
      busy = true;
      running = loop();
      return running;
    },
    reset() {
      generation += 1;
      again = false;
    },
    get inFlight() {
      return busy;
    },
  };
}

/** Normal refreshes publish immediately; a grouped read can defer their publication together. */
export const immediatePublication = (apply: () => void): void => apply();

/** Publish parallel store reads together after the slowest one completes. */
export function createPublicationBatch(flush: (apply: () => void) => void = immediatePublication) {
  let readers = 0;
  let pending: Array<() => void> = [];
  return {
    publish(apply: () => void): void {
      if (readers) pending.push(apply);
      else apply();
    },
    async run(read: () => Promise<unknown>): Promise<void> {
      readers++;
      try {
        await read();
      } finally {
        readers--;
        if (readers === 0) {
          const ready = pending;
          pending = [];
          flush(() => {
            for (const apply of ready) apply();
          });
        }
      }
    },
  };
}
