/**
 * The two five-minute rows the soak feeds, computed with no browser.
 *
 * `l1.survives_5min`: a crash (the main thread stopped answering) fails at any soak length; a soak
 * shorter than `SPEC_SOAK_MS` is otherwise `unknown`, whichever reason shortened it, and its heap
 * growth is only reported; over the full soak an unbounded JS heap fails; a heap Chromium
 * reported as one quantised value is `unknown` (a constant series carries no growth signal, and a
 * pass on it would be a pass on nothing). The heap is `performance.memory`: JS only, so a GPU-side
 * leak is invisible to it, and the detail says so.
 *
 * `l2.no_soft_lock_5min`: state must keep changing, above a STILLNESS floor (a quarter of the
 * baseline's p95), not the much higher input threshold, in most soak windows. A sampler too coarse
 * for its windows cannot tell stopped from slow and says `unknown`. Only a fail decided by the
 * stillness measurement is routed through the door demotions: a crash happened whichever side of a
 * door the page sat on.
 */
import { SECOND_MS } from "../../../../src/shared/duration.ts";
import { CheckResult, ProbeRow } from "../../vocabulary.ts";
import { linearSlope } from "../frames.ts";
import type { Check } from "../types.ts";
import {
  demoteForFullscreen,
  demoteForLookInput,
  demoteForNoGameplay,
  demoteForPointerLock,
  type FullscreenState,
  type GameplayReached,
  type LookInputVerdict,
  type PointerLockState,
} from "../verdicts.ts";
import { MIN_CHANGE_DIFF, type PageBaseline } from "./baseline.ts";
import { applyDemotions, machineRow } from "./row.ts";
import {
  COARSE_WINDOW_SHARE,
  MIN_CHANGE_SHARE,
  MIN_SOAK_WINDOWS,
  SOAK_WINDOW_MS,
  type SoakRun,
  type SoakWindows,
  SPEC_SOAK_MS,
  STILLNESS_SHARE,
} from "./soak.ts";

/** A heap growing faster than this (bytes per second of page time)… */
export const HEAP_SLOPE_LIMIT = 100 * 1024;
/** …and ending past this multiple of its settled start is unbounded. */
export const HEAP_GROWTH_LIMIT = 1.6;
/** The heap needs this many samples, and more than one distinct value, to be a measurement. */
export const MIN_HEAP_SAMPLES = 4;
/** The first share of the heap series is boot allocation, not a leak. */
export const HEAP_SETTLE_SHARE = 0.25;

const KIB = 1024;
const seconds = (ms: number) => (ms / SECOND_MS).toFixed(0);

/** The stillness floor a soak window must clear to count as change. */
export function stillnessThreshold(baseline: PageBaseline): number {
  return Math.max(MIN_CHANGE_DIFF, baseline.pageP95Diff * STILLNESS_SHARE);
}

/** The heap series' growth, when it is a measurement at all. */
export interface HeapGrowth {
  available: boolean;
  samples: number;
  distinctValues: number;
  slopeBytesPerSec: number | null;
  firstBytes: number | null;
  lastBytes: number | null;
  unbounded: boolean;
  note: string;
}

/** Read the instrument's heap record: settled slope and first-to-last growth. */
export function heapGrowth(
  heap: { available?: boolean; samples?: Array<{ t: number; used: number }>; note?: string } | undefined,
): HeapGrowth {
  const samples = heap?.samples ?? [];
  const distinctValues = new Set(samples.map((s) => s.used)).size;
  const available = Boolean(heap?.available) && samples.length >= MIN_HEAP_SAMPLES && distinctValues > 1;
  const settled = samples.slice(Math.floor(samples.length * HEAP_SETTLE_SHARE));
  const slope = available
    ? linearSlope(
        settled.map((s) => s.t / SECOND_MS),
        settled.map((s) => s.used),
      )
    : null;
  const firstBytes = settled.length ? settled[0].used : null;
  const lastBytes = settled.length ? settled[settled.length - 1].used : null;
  const grew = firstBytes !== null && lastBytes !== null && lastBytes > firstBytes * HEAP_GROWTH_LIMIT;
  return {
    available,
    samples: samples.length,
    distinctValues,
    slopeBytesPerSec: slope,
    firstBytes,
    lastBytes,
    unbounded: available && slope !== null && slope > HEAP_SLOPE_LIMIT && grew,
    note: heap?.note ?? "performance.memory unavailable",
  };
}

/** Why the heap half could not be answered. */
function heapUnknownDetail(soak: SoakRun, heap: HeapGrowth): string {
  if (heap.samples >= MIN_HEAP_SAMPLES && heap.distinctValues <= 1) {
    return `Survived ${seconds(soak.ranMs)}s with no crash, but Chromium reported one quantised usedJSHeapSize for all ${heap.samples} samples, so there is no growth signal to read.`;
  }
  return `Survived ${seconds(soak.ranMs)}s with no crash, but heap growth could not be measured: ${heap.note}.`;
}

/** `l1.survives_5min`. `shortenedWhy` names the budget's reason when it cut the soak. */
export function survivesRow(soak: SoakRun | null, heap: HeapGrowth, shortenedWhy: string | null): Check {
  const id = ProbeRow.L1Survives5min;
  const jsOnly =
    " Heap figures are performance.memory, the JS heap only: GPU textures, WASM memory and decoded audio are invisible to it.";
  if (!soak) return machineRow(id, CheckResult.Unknown, "The canvas never drew, so no soak ran.", { heap });
  const value = {
    soakMs: soak.ranMs,
    requiredMs: SPEC_SOAK_MS,
    crashed: soak.crashed,
    crashReason: soak.crashReason,
    heap,
  };
  if (soak.crashed) {
    const detail = `The page stopped responding after ${seconds(soak.ranMs)}s: ${soak.crashReason}.`;
    return machineRow(id, CheckResult.Fail, detail, value);
  }
  const ratio = (heap.lastBytes ?? 0) / (heap.firstBytes ?? 1);
  const growth = `JS heap grew at ${((heap.slopeBytesPerSec ?? 0) / KIB).toFixed(0)} KB/s and ended ${ratio.toFixed(2)}x its settled baseline.`;
  // A heap read over less than the specified soak is no leak verdict: the page's garbage may not
  // have met a major collection yet (the prober's own fixture climbs 3x in 30s while instrumented,
  // then ends the full soak below where it settled).
  if (soak.ranMs < SPEC_SOAK_MS) {
    const why = shortenedWhy
      ? `: ${shortenedWhy}. That is the probe's own budget, not a verdict on the game's stability`
      : "";
    const seen = heap.unbounded ? ` ${growth}` : "";
    const detail = `No crash, but the soak ran ${seconds(soak.ranMs)}s, not the ${seconds(SPEC_SOAK_MS)}s the check specifies${why}.${seen}`;
    return machineRow(id, CheckResult.Unknown, detail, value);
  }
  if (heap.unbounded) return machineRow(id, CheckResult.Fail, `${growth}${jsOnly}`, value);
  if (!heap.available) return machineRow(id, CheckResult.Unknown, `${heapUnknownDetail(soak, heap)}${jsOnly}`, value);
  const detail = `Survived ${seconds(soak.ranMs)}s with no crash; settled JS heap slope ${((heap.slopeBytesPerSec ?? 0) / KIB).toFixed(1)} KB/s.${jsOnly}`;
  return machineRow(id, CheckResult.Pass, detail, value);
}

/** The doors a stillness fail is demoted through. */
export interface SoftLockDoors {
  pointerLock: PointerLockState;
  lookInput: LookInputVerdict;
  fullscreen: FullscreenState;
  entranceConfirmed: boolean;
  gameplay: GameplayReached;
}

/** The raw soft-lock verdict before any door demotion; `byStillness` marks the only demotable fail. */
function softLockVerdict(soak: SoakRun, w: SoakWindows): { result: CheckResult; detail: string; byStillness: boolean } {
  const share = w.windows ? w.withChange / w.windows : 0;
  const counted = `${w.withChange}/${w.windows} autoplay windows`;
  if (soak.crashed) {
    return {
      result: CheckResult.Fail,
      detail: `The page did not survive the autoplay soak: ${soak.crashReason}.`,
      byStillness: false,
    };
  }
  if (w.windows < MIN_SOAK_WINDOWS) {
    const detail = `Only ${w.windows} complete ${seconds(SOAK_WINDOW_MS)}s window(s) of autoplay were observed (soak ${seconds(soak.ranMs)}s); the check asks for ${seconds(SPEC_SOAK_MS)}s.`;
    return { result: CheckResult.Unknown, detail, byStillness: false };
  }
  const coarse = w.resolutionMs !== null && w.resolutionMs > SOAK_WINDOW_MS * COARSE_WINDOW_SHARE;
  if (coarse && share < MIN_CHANGE_SHARE) {
    const detail = `${counted} showed change, but the sampler resolved only ${(w.resolutionMs ?? 0).toFixed(0)}ms per reading against a ${seconds(SOAK_WINDOW_MS)}s window: a slow render loop is indistinguishable from a soft-lock at that resolution.`;
    return { result: CheckResult.Unknown, detail, byStillness: false };
  }
  if (share >= MIN_CHANGE_SHARE) {
    const full = soak.ranMs >= SPEC_SOAK_MS;
    const detail = full
      ? `State kept changing in ${counted} across the full ${seconds(SPEC_SOAK_MS)}s.`
      : `State kept changing in ${counted}, but only ${seconds(soak.ranMs)}s of the ${seconds(SPEC_SOAK_MS)}s were run.`;
    return { result: full ? CheckResult.Pass : CheckResult.Unknown, detail, byStillness: false };
  }
  const detail = `Only ${counted} showed any state change above the stillness floor: the game stops responding partway through.`;
  return { result: CheckResult.Fail, detail, byStillness: true };
}

/** `l2.no_soft_lock_5min`. */
export function softLockRow(
  soak: SoakRun | null,
  w: SoakWindows,
  baseline: PageBaseline | null,
  doors: SoftLockDoors,
): Check {
  const id = ProbeRow.L2NoSoftLock5min;
  if (!soak || !baseline) return machineRow(id, CheckResult.Unknown, "The canvas never drew, so no soak ran.", null);
  const stillness = stillnessThreshold(baseline);
  const value = {
    soakMs: soak.ranMs,
    requiredMs: SPEC_SOAK_MS,
    windowMs: SOAK_WINDOW_MS,
    ...w,
    seed: soak.seed,
    baseline: baseline.name,
    stillness,
  };
  const raw = softLockVerdict(soak, w);
  const steps = raw.byStillness
    ? [
        (r: CheckResult) => demoteForPointerLock(r, doors.pointerLock),
        (r: CheckResult) => demoteForLookInput(r, doors.lookInput),
        // A confirmed entrance means a refused fullscreen request did not keep the probe out.
        (r: CheckResult) =>
          doors.entranceConfirmed ? { result: r, why: null } : demoteForFullscreen(r, doors.fullscreen),
        (r: CheckResult) => demoteForNoGameplay(r, doors.gameplay),
      ]
    : [];
  const { result, detail } = applyDemotions(raw, steps);
  const floor = ` The stillness floor (${stillness.toFixed(4)}) is a quarter of the p95 of the ${baseline.name} baseline. Autoplay is a seeded stream (seed ${soak.seed}), so the trace replays.`;
  return machineRow(id, result, `${detail}${floor}`, value);
}
