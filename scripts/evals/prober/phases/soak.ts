/**
 * THE SOAK: a seeded autoplay stream for `SPEC_SOAK_MS` (keys 70%, hover moves 20%, clicks 10%, each
 * through its guard), frames denser in the first minute, and the page-side series pulled after every
 * step. ONE CONSTANT PER WINDOW (Rule 1): the soak and both rows it feeds read `SPEC_SOAK_MS`, because
 * a soak shorter than its check leaves `l1.survives_5min` unknown in every bundle. A soak
 * the budget shortened is allowed, and both rows then say `unknown` rather than inherit a verdict.
 *
 * A guard that refuses an input still consumes its RNG draws, so the seeded trace is the same whether
 * or not a guard fired. The look phase draws nothing from this stream.
 */
import { MINUTE_MS, SECOND_MS } from "../../../../src/shared/duration.ts";
import type { ProbeSample } from "../instrument.ts";
import { samplerResolutionMs } from "./series.ts";

/** The soak the L1 and L2 five-minute rows are defined against. */
export const SPEC_SOAK_MS = 5 * MINUTE_MS;
/** The seeded autoplay stream's default seed, recorded on every result. */
export const DEFAULT_SOAK_SEED = 20260830;
/** The soft-lock windows the soak is cut into, and the fewest readings a window needs. */
export const SOAK_WINDOW_MS = 20 * SECOND_MS;
export const MIN_WINDOW_SAMPLES = 3;
/** The pause after every autoplay action. */
export const SOAK_STEP_MS = 700;
/** Frames every 5 s in the first minute (the minute a game shows whether it runs), then every 15 s. */
export const SOAK_EARLY_CAPTURE_MS = 5 * SECOND_MS;
export const SOAK_EARLY_WINDOW_MS = MINUTE_MS;
export const SOAK_FRAME_INTERVAL_MS = 15 * SECOND_MS;
/** A soak past its length by this much (or by the soak itself, if shorter) is stopped. */
export const SOAK_OVERRUN_MS = 2 * MINUTE_MS;
/** Consecutive unanswered series reads that mean the page's main thread stopped. */
export const SOAK_HANG_STREAK = 2;
/** The key hold: a floor plus a seeded spread. */
export const SOAK_HOLD_MIN_MS = 220;
export const SOAK_HOLD_SPREAD_MS = 400;
/** Steps per hover move. */
export const SOAK_MOVE_STEPS = 6;
/** The share of draws that press a key, and that move the pointer; the rest click. */
export const SOAK_KEY_SHARE = 0.7;
export const SOAK_MOVE_SHARE = 0.9;
/** The keys autoplay draws from. */
export const SOAK_KEYS = [
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "Space",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "ShiftLeft",
] as const;
/** The stillness floor is this share of the baseline's p95, above the absolute floor. */
export const STILLNESS_SHARE = 0.25;
/** At least this share of windows must show change for the soak to count as alive. */
export const MIN_CHANGE_SHARE = 0.8;
/** The fewest windows a soft-lock verdict stands on. */
export const MIN_SOAK_WINDOWS = 3;
/** Gaps longer than this are a paused document, not the sampler's resolution. */
export const SOAK_RESOLUTION_MAX_GAP_MS = 30 * SECOND_MS;
/** A sampler coarser than this share of a window cannot tell stopped from slow. */
export const COARSE_WINDOW_SHARE = 1 / 8;

const UINT32 = 4294967296;
const MULBERRY_STEP = 0x6d2b79f5;

/** A seeded uniform RNG in [0, 1): mulberry32, so a trace replays from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + MULBERRY_STEP) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  };
}

/** What the soak needs from the browser. */
export interface SoakDeps {
  /** Run-clock ms. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  viewport: { width: number; height: number };
  /** A key through the focus guard; whether it went out. */
  press: (key: string, holdMs: number) => Promise<boolean>;
  /** A hover move; whether it went out. */
  move: (x: number, y: number, steps: number) => Promise<boolean>;
  /** A click through the chrome guard; whether it went out. */
  click: (x: number, y: number) => Promise<boolean>;
  capture: (label: string) => Promise<boolean>;
  /** Pull the page-side series; `false` when the page did not answer. */
  pullSeries: () => Promise<boolean>;
}

/** What the soak did. */
export interface SoakRun {
  plannedMs: number;
  ranMs: number;
  seed: number;
  crashed: boolean;
  crashReason: string | null;
  actions: { keys: number; moves: number; clicks: number; refused: number };
  framesEarly: number;
  framesLate: number;
}

/** One seeded autoplay action; the draws are taken whether or not the input goes out. */
async function autoplayStep(deps: SoakDeps, rng: () => number, run: SoakRun): Promise<void> {
  const pick = rng();
  if (pick < SOAK_KEY_SHARE) {
    const key = SOAK_KEYS[Math.floor(rng() * SOAK_KEYS.length)];
    const holdMs = SOAK_HOLD_MIN_MS + Math.floor(rng() * SOAK_HOLD_SPREAD_MS);
    if (await deps.press(key, holdMs)) run.actions.keys++;
    else run.actions.refused++;
    return;
  }
  const x = Math.floor(rng() * deps.viewport.width);
  const y = Math.floor(rng() * deps.viewport.height);
  if (pick < SOAK_MOVE_SHARE) {
    if (await deps.move(x, y, SOAK_MOVE_STEPS)) run.actions.moves++;
    return;
  }
  if (await deps.click(x, y)) run.actions.clicks++;
  else run.actions.refused++;
}

/** Capture on the early cadence in the first minute, then the late one. */
async function maybeCapture(deps: SoakDeps, run: SoakRun, startedMs: number, last: { atMs: number }) {
  const early = deps.now() - startedMs < SOAK_EARLY_WINDOW_MS;
  const every = early ? SOAK_EARLY_CAPTURE_MS : SOAK_FRAME_INTERVAL_MS;
  if (deps.now() - last.atMs <= every) return;
  last.atMs = deps.now();
  if (!(await deps.capture(early ? "soak-early" : "soak"))) return;
  if (early) run.framesEarly++;
  else run.framesLate++;
}

/** Run the seeded autoplay for `soakMs` of run time, with a hard stop past it. */
export async function soakPhase(deps: SoakDeps, soakMs: number, seed: number): Promise<SoakRun> {
  const rng = mulberry32(seed);
  const startedMs = deps.now();
  const deadline = startedMs + soakMs + Math.min(SOAK_OVERRUN_MS, soakMs);
  const run: SoakRun = {
    plannedMs: soakMs,
    ranMs: 0,
    seed,
    crashed: false,
    crashReason: null,
    actions: { keys: 0, moves: 0, clicks: 0, refused: 0 },
    framesEarly: 0,
    framesLate: 0,
  };
  const last = { atMs: Number.NEGATIVE_INFINITY };
  let unanswered = 0;
  while (deps.now() - startedMs < soakMs && deps.now() < deadline) {
    await autoplayStep(deps, rng, run);
    await deps.sleep(SOAK_STEP_MS);
    await maybeCapture(deps, run, startedMs, last);
    unanswered = (await deps.pullSeries()) ? 0 : unanswered + 1;
    if (unanswered >= SOAK_HANG_STREAK) {
      run.crashed = true;
      run.crashReason = "the page's main thread stopped answering during autoplay";
      break;
    }
  }
  run.ranMs = deps.now() - startedMs;
  return run;
}

/** How many soak windows showed change above the stillness floor, and how finely the sampler saw. */
export interface SoakWindows {
  windows: number;
  withChange: number;
  resolutionMs: number | null;
}

/** Cut the soak's samples into windows and count the ones that moved past `stillness`. */
export function soakWindows(
  samples: readonly ProbeSample[],
  fromT: number,
  toT: number,
  stillness: number,
): SoakWindows {
  const soak = samples.filter((s) => s.t >= fromT && s.t <= toT);
  let windows = 0;
  let withChange = 0;
  for (let w = fromT; w < toT; w += SOAK_WINDOW_MS) {
    const inWindow = soak.filter((s) => s.t >= w && s.t < w + SOAK_WINDOW_MS);
    if (inWindow.length < MIN_WINDOW_SAMPLES) continue;
    windows++;
    if (Math.max(...inWindow.map((s) => s.d)) > stillness) withChange++;
  }
  return { windows, withChange, resolutionMs: samplerResolutionMs(soak, SOAK_RESOLUTION_MAX_GAP_MS) };
}
