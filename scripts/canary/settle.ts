// Wait for a machine to go quiet before a start is timed. Writing a lived-in profile creates tens of
// thousands of new files, and Windows Search and the antivirus then scan them for minutes; a first
// start timed in that storm measured the scan, not Genex (a 2-core VM sat at 100% CPU while the
// harness seed's first commit waited on it).
import os from "node:os";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import type { WaitClock } from "./links.ts";

/** Below this share of all CPUs busy, a sample counts as quiet. */
export const IDLE_BELOW = 0.3;
/** How long each sample measures. */
export const SAMPLE_MS = 5 * SECOND_MS;
/** Quiet samples in a row that make the machine settled: half a minute. */
export const QUIET_SAMPLES = 6;
/** How long to wait at most; past it the start is timed anyway, and the line says so. */
export const SETTLE_CAP_MS = 15 * MINUTE_MS;

/** How a settle wait ended: quiet or not, after how long, and the last sample's busy share. */
export interface Settled {
  idle: boolean;
  waitedMs: number;
  lastBusy: number | null;
}

/** Wait until `QUIET_SAMPLES` samples in a row are under `IDLE_BELOW`, or `capMs` has passed. */
export async function waitForIdle(
  busy: () => Promise<number>,
  clock: WaitClock,
  { capMs = SETTLE_CAP_MS, quietSamples = QUIET_SAMPLES, idleBelow = IDLE_BELOW } = {},
): Promise<Settled> {
  const started = clock.now();
  let quiet = 0;
  let lastBusy: number | null = null;
  for (;;) {
    const waitedMs = clock.now() - started;
    if (quiet >= quietSamples) return { idle: true, waitedMs, lastBusy };
    if (waitedMs >= capMs) return { idle: false, waitedMs, lastBusy };
    lastBusy = await busy();
    quiet = lastBusy < idleBelow ? quiet + 1 : 0;
  }
}

/** Busy and total CPU time over every core so far. */
function cpuTimes(): { busy: number; total: number } {
  let busy = 0;
  let total = 0;
  for (const { times } of os.cpus()) {
    const all = times.user + times.nice + times.sys + times.irq + times.idle;
    total += all;
    busy += all - times.idle;
  }
  return { busy, total };
}

/** The machine's busy share over `ms`, measured across every core (no localized counter names). */
export function cpuBusy(clock: WaitClock, ms: number = SAMPLE_MS): () => Promise<number> {
  return async () => {
    const before = cpuTimes();
    await clock.sleep(ms);
    const after = cpuTimes();
    const total = after.total - before.total;
    return total > 0 ? (after.busy - before.busy) / total : 0;
  };
}

/** The line a run prints about its wait. */
export function settledLine({ idle, waitedMs, lastBusy }: Settled): string {
  const seconds = Math.round(waitedMs / SECOND_MS);
  if (idle) return `machine settled: idle after ${seconds} s`;
  const share = lastBusy === null ? "" : ` (${Math.round(lastBusy * 100)}% CPU)`;
  return `machine still busy after ${seconds} s${share}; the start is timed anyway`;
}
