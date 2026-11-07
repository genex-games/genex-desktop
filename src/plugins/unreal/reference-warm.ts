/**
 * The engine's node reference exported once per engine, ahead of the first lookup. The export makes
 * throwaway Blueprints, so the editor refuses it during play, and it took longer than a moment's
 * 15 s ask on Windows: `find-nodes` then failed ten times in a row through a day of building. So
 * Genex starts it in the background whenever it sees the game's Unreal answer (`editor-status`,
 * `open-editor`, a Loop's start), with a limit of its own, and lookups and the gate read the copy
 * it keeps, during play too. One export per engine runs at a time; lookups that find none kept
 * share the running one, and one that failed is tried again in the background only a while later.
 */
import { MINUTE_MS } from "../../shared/duration.ts";

/** How long a failed background export waits before the next one starts. */
export const REFERENCE_RETRY_MS = 2 * MINUTE_MS;

/** The exports of each engine's reference: the running one, and when the last one failed. */
export type ReferenceExports = ReturnType<typeof createReferenceExports>;

/** How an export ended for a caller that waited a while: done, failed with why, or still running (undefined). */
export type ExportEnd = { failure?: unknown } | undefined;

/** The exports by key (plugin storage and engine version), on the backend's clock. */
export function createReferenceExports(now: () => number) {
  const running = new Map<string, Promise<unknown>>();
  const failedAt = new Map<string, number>();
  const start = (key: string, run: () => Promise<unknown>): Promise<unknown> => {
    const known = running.get(key);
    if (known) return known;
    const started = run().then(
      (value) => {
        failedAt.delete(key);
        return value;
      },
      (failure: unknown) => {
        failedAt.set(key, now());
        throw failure;
      },
    );
    running.set(key, started);
    // A waiter may stop waiting before it ends; its failure is then the next caller's to read.
    started
      .catch(() => undefined)
      .finally(() => {
        if (running.get(key) === started) running.delete(key);
      });
    return started;
  };
  return {
    /** The export of `key` a lookup waits for: the one running, else `run` started now. */
    start,
    /** Starts `run` in the background, unless one runs or the last failed under {@link REFERENCE_RETRY_MS} ago. */
    warm(key: string, run: () => Promise<unknown>): void {
      const failed = failedAt.get(key);
      if (running.has(key) || (failed !== undefined && now() - failed < REFERENCE_RETRY_MS)) return;
      start(key, run).catch(() => undefined);
    },
  };
}

/**
 * How `running` ended within `limitMs` on the injected clock: done, or failed with why; undefined
 * when the wait (or `signal`, the caller's) ended first, and it goes on in the background.
 */
export async function endWithin(
  running: Promise<unknown>,
  sleep: (ms: number, signal: AbortSignal) => Promise<void>,
  limitMs: number,
  signal: AbortSignal,
): Promise<ExportEnd> {
  const stop = new AbortController();
  const ended = running.then(
    (): ExportEnd => ({}),
    (failure: unknown): ExportEnd => ({ failure }),
  );
  // A wait stopped once the export ended may reject: that is its end, not a failure.
  const waited = sleep(limitMs, AbortSignal.any([stop.signal, signal])).then(
    () => undefined,
    () => undefined,
  );
  try {
    return await Promise.race([ended, waited]);
  } finally {
    stop.abort();
  }
}
