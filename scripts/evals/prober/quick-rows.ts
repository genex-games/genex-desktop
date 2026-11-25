/**
 * The quick probe's rows (§8.2), computed from what the phases observed with no browser, so every
 * verdict replays in a test. Eight rows: `l1.builds_and_boots`, `l1.no_errors_60s` (the quick
 * probe's SHORT-WINDOW variant: it covers `noErrorsMs` of page time, not 60 s, and says so),
 * `l1.assets_arrived`, `l1.stayed_on_game`, `l2.enterable`, `l2.input_changes_state`,
 * `l3.visually_legible` and `l3.renderer_drew`. Each row fails only on positive evidence and says
 * `unknown` when it could not look.
 */
import { SECOND_MS } from "../../../src/shared/duration.ts";
import { CheckResult, ProbePhase, ProbeRow } from "../vocabulary.ts";
import { classifyContextLosses, ContextEventKind } from "./context-loss.ts";
import { type InstrumentSnapshot, type PageEvents, pointerLockOf, rafOf, webglContexts } from "./driver.ts";
import type { LoggedFrame } from "./frame-log.ts";
import { exposureReport } from "./frames.ts";
import type { BootVerdict } from "./phases/boot.ts";
import { appliedBaseline, isStillBaseline, type PageBaseline } from "./phases/baseline.ts";
import type { EntranceObservation } from "./phases/entrance.ts";
import type { BurstObservation } from "./phases/input.ts";
import { type Check, CheckLayer, CheckSource, type Demotion, ShotKind } from "./types.ts";
import {
  classifyFailure,
  demoteForFullscreen,
  demoteForLookInput,
  demoteForNoGameplay,
  demoteForPointerLock,
  FailureBlameKind,
  type GameplayReached,
  lookInputVerdict,
  pageRan,
  pickEvidenceSnapshot,
  POST_GESTURE_PHASES,
  rendererDefects,
  selectExposureFrames,
  shouldDemoteForCamera,
  stayedOnGame,
} from "./verdicts.ts";

/** Exposure band: inside it the frame is legible; outside it is flagged for a human, never gated. */
export const EXPOSURE_OK_MIN = 0.08;
export const EXPOSURE_OK_MAX = 0.85;
/** Below this mean, with no tonal range, a frame provably carries no visible content. */
export const EXPOSURE_BROKEN_MEAN = 0.02;
export const EXPOSURE_BROKEN_RANGE = 0.05;
const HTTP_ERROR_MIN = 400;

const ROW_LAYER: Record<string, CheckLayer> = { l1: CheckLayer.L1, l2: CheckLayer.L2, l3: CheckLayer.L3 };

/** The rows' own wording. */
const ROW_TITLE: Partial<Record<ProbeRow, string>> = {
  [ProbeRow.L1BuildsAndBoots]: "Builds and boots",
  [ProbeRow.L1NoErrors60s]: "No uncaught errors in the quick-probe window (short variant of the 60 s row)",
  [ProbeRow.L1AssetsArrived]: "Every asset arrived",
  [ProbeRow.L1StayedOnGame]: "Stayed on the game",
  [ProbeRow.L2Enterable]: "The game can be entered",
  [ProbeRow.L2InputChangesState]: "Input changes state (against a no-input baseline)",
  [ProbeRow.L3VisuallyLegible]: "Visually legible: exposure, tonal range and contrast, tiled and centre-weighted",
  [ProbeRow.L3RendererDrew]: "The renderer drew what it was asked and warned of no removed API",
};

/** A machine row. */
function row(id: ProbeRow, result: CheckResult, detail: string, value: unknown): Check {
  return {
    id,
    layer: ROW_LAYER[id.slice(0, 2)],
    title: ROW_TITLE[id] ?? id,
    result,
    source: CheckSource.Machine,
    value,
    detail,
  };
}

/** Everything the phases observed, as the rows read it. */
export interface QuickObservation {
  gameOrigin: string;
  /** Run ms when the probe finished. */
  endAtMs: number;
  /** The quick probe's error window, page-clock ms. */
  noErrorsMs: number;
  firstRenderMs: number | null;
  boot: BootVerdict;
  events: PageEvents;
  /** Every snapshot read during the run, the last one last. */
  snapshots: InstrumentSnapshot[];
  /** `null` when the canvas never drew and the entrance was never tried. */
  entrance: EntranceObservation | null;
  /** Whether the camera moved during the pre-gesture no-input idle. */
  idleMoved: boolean | null;
  /**
   * Whether the camera moved in the no-input window nearest the bursts (post-entrance when taken,
   * else the idle). Camera motion during a burst witnesses input only when this is `false`.
   */
  stillMoved: boolean | null;
  preBaseline: PageBaseline | null;
  postBaseline: PageBaseline | null;
  bursts: BurstObservation[];
  frames: LoggedFrame[];
}

const lastOf = <T>(list: readonly T[]): T | null => (list.length ? list[list.length - 1] : null);

/** Whether the page ran at all, optionally over a window (see `pageRan`). */
function ran(o: QuickObservation, windowMs?: number) {
  const raf = rafOf(lastOf(o.snapshots));
  return pageRan({
    rafFrames: raf.distinctFrames,
    requests: o.events.network.length,
    lastRafPageMs: raf.lastT,
    windowMs,
  });
}

/** `l1.builds_and_boots`: the boot verdict, demoted when WebGL drew but no view matrix was ever uploaded. */
export function bootRow(o: QuickObservation): Check {
  const snap = lastOf(o.snapshots);
  const contexts = webglContexts(snap);
  const demote =
    o.boot.result === CheckResult.Pass && shouldDemoteForCamera({ webglContexts: contexts, camera: snap?.camera });
  if (!demote) return row(ProbeRow.L1BuildsAndBoots, o.boot.result, o.boot.detail, { firstRenderMs: o.firstRenderMs });
  return row(
    ProbeRow.L1BuildsAndBoots,
    CheckResult.Fail,
    `Pixels rendered and ${contexts} WebGL context(s) were created, but not one view matrix was ever uploaded — something was on screen (a loading or title screen has pixels); the game's scene never drew.`,
    { firstRenderMs: o.firstRenderMs, camera: snap?.camera ?? null },
  );
}

/** Uncaught errors, unhandled rejections and fatal context losses inside the window, page clock. */
function errorsInWindow(o: QuickObservation) {
  const snap = lastOf(o.snapshots);
  const within = (t: number) => t <= o.noErrorsMs;
  if (!snap) {
    const uncaught = o.events.pageErrors.filter((e) => within(e.atMs)).length;
    return { uncaught, rejections: 0, contextLost: 0 };
  }
  const events = (snap.contextLost ?? []).filter((e) => e.kind !== ContextEventKind.CreationError);
  const fatal = classifyContextLosses(events, rafOf(snap).lastT).fatal;
  return {
    uncaught: (snap.errors ?? []).filter((e) => within(e.t)).length,
    rejections: (snap.rejections ?? []).filter((e) => within(e.t)).length,
    contextLost: fatal.filter((e) => within(e.t)).length,
  };
}

/** `l1.no_errors_60s`, short-window variant: the window is `noErrorsMs`, named in the detail. */
export function noErrorsRow(o: QuickObservation): Check {
  const counts = errorsInWindow(o);
  const seconds = Math.round(o.noErrorsMs / SECOND_MS);
  const window = `the quick probe's first ${seconds}s of page time (a short-window variant of the 60 s row)`;
  const value = { windowMs: o.noErrorsMs, quickWindow: true, ...counts };
  if (counts.uncaught + counts.rejections + counts.contextLost > 0) {
    return row(
      ProbeRow.L1NoErrors60s,
      CheckResult.Fail,
      `${counts.uncaught} uncaught error(s), ${counts.rejections} unhandled rejection(s) and ${counts.contextLost} unsurvived WebGL context loss(es) in ${window}.`,
      value,
    );
  }
  const page = ran(o, o.noErrorsMs);
  if (!page.ran) {
    return row(ProbeRow.L1NoErrors60s, CheckResult.Unknown, `No error in ${window}, but ${page.why}.`, value);
  }
  return row(
    ProbeRow.L1NoErrors60s,
    CheckResult.Pass,
    `No uncaught error, rejection or fatal context loss in ${window}.`,
    value,
  );
}

/** `l1.assets_arrived`: no failed request blamed on the game, on a page that ran. */
export function assetsRow(o: QuickObservation): Check {
  const failed = o.events.network.filter((e) => e.failure !== null || (e.status ?? 0) >= HTTP_ERROR_MIN);
  const succeeded = new Set(o.events.network.filter((e) => !failed.includes(e)).map((e) => e.url));
  const blamed = failed.filter((e) => classifyFailure(e.url, o.gameOrigin, succeeded).blame === FailureBlameKind.Asset);
  const value = { requests: o.events.network.length, failed: failed.length, blamed: blamed.map((e) => e.url) };
  if (blamed.length) {
    return row(
      ProbeRow.L1AssetsArrived,
      CheckResult.Fail,
      `${blamed.length} failed asset request(s); first: ${blamed[0].url}`,
      value,
    );
  }
  const page = ran(o);
  if (!page.ran) {
    return row(ProbeRow.L1AssetsArrived, CheckResult.Unknown, `No game-blamed failure, but ${page.why}.`, value);
  }
  const ignored = failed.length ? ` ${failed.length} benign failure(s) were ignored.` : "";
  return row(
    ProbeRow.L1AssetsArrived,
    CheckResult.Pass,
    `${o.events.network.length} requests and no game-blamed failure.${ignored}`,
    value,
  );
}

/** `l1.stayed_on_game`, with no bounce allowed. */
export function stayedRow(o: QuickObservation): Check {
  const pick = pickEvidenceSnapshot(o.snapshots, o.gameOrigin);
  const verdict = stayedOnGame({
    navigations: o.events.navigations,
    gameOrigin: o.gameOrigin,
    foreignSnapshots: pick.foreign,
    sameOriginSnapshots: pick.sameOrigin,
    endAtMs: o.endAtMs,
  });
  return row(ProbeRow.L1StayedOnGame, verdict.result, verdict.detail, { excursions: verdict.excursions });
}

/** `l2.enterable`. */
export function enterableRow(o: QuickObservation): Check {
  if (!o.entrance) {
    return row(
      ProbeRow.L2Enterable,
      CheckResult.Unknown,
      "The canvas never drew, so the entrance was never tried.",
      null,
    );
  }
  const { enterable, verdict } = o.entrance;
  return row(ProbeRow.L2Enterable, enterable.result, enterable.why, {
    entrance: verdict.by,
    doorObserved: verdict.doorObserved,
  });
}

/** Whether gameplay was reached: the precondition every input-side fail and every evidence frame needs. */
export function quickGameplay(o: QuickObservation): GameplayReached {
  if (!o.entrance) return { reached: false, why: "the canvas never drew" };
  const postGestureFrames = o.frames.filter(
    (f) => f.record.source !== ShotKind.Element && POST_GESTURE_PHASES.has(f.record.phase),
  ).length;
  return gameplayReachedFor(o.entrance, postGestureFrames);
}

function gameplayReachedFor(entrance: EntranceObservation, postGestureFrames: number): GameplayReached {
  const { verdict } = entrance;
  if (verdict.confirmed) return { reached: true, why: `the entrance was confirmed (${verdict.why})` };
  if (postGestureFrames === 0) return { reached: false, why: "no page frame was captured in any post-gesture phase" };
  if (!verdict.doorObserved) return { reached: true, why: "no door was observed — a game with no entrance to confirm" };
  return { reached: false, why: verdict.why };
}

/** The raw input verdict before any door demotion. */
function inputVerdict(o: QuickObservation): { result: CheckResult; detail: string } {
  const sent = o.bursts.filter((b) => b.sent);
  if (!sent.length)
    return { result: CheckResult.Unknown, detail: "No input went out: every key was refused by the focus guard." };
  const camera = o.stillMoved === false ? sent.find((b) => b.cameraMoved === true) : undefined;
  if (camera)
    return { result: CheckResult.Pass, detail: `The engine's camera moved during the ${camera.input} burst.` };
  const sampled = sent.filter((b) => b.samples > 0 && b.maxDiff !== null);
  if (sampled.length < 2) {
    return {
      result: CheckResult.Unknown,
      detail: `Only ${sampled.length} of ${sent.length} input burst(s) held a page-side sample, so there is no response signal to judge.`,
    };
  }
  const baseline = o.preBaseline ? appliedBaseline(o.preBaseline, o.postBaseline) : null;
  if (!baseline?.usable) {
    return {
      result: CheckResult.Unknown,
      detail: "No usable no-input baseline was taken, so no response can be measured against one.",
    };
  }
  const best = Math.max(...sampled.map((b) => b.maxDiff ?? 0));
  const against = `the ${baseline.name} baseline (${baseline.samples} readings, threshold ${baseline.changeThreshold.toFixed(4)})`;
  if (best > baseline.changeThreshold) {
    return { result: CheckResult.Pass, detail: `Input moved the frame by ${best.toFixed(4)} against ${against}.` };
  }
  const why = isStillBaseline(baseline)
    ? "nothing on screen changed without input, and no input changed it by more than the threshold"
    : "whatever moves on screen was already moving without input";
  return {
    result: CheckResult.Fail,
    detail: `The biggest response to any input (${best.toFixed(4)}) did not clear ${against}; ${why}.`,
  };
}

/** Apply the door demotions in order; each only ever turns a fail into unknown. */
function demoteInput(o: QuickObservation, first: { result: CheckResult; detail: string }) {
  const lock = pointerLockOf(lastOf(o.snapshots));
  const steps: Array<(r: CheckResult) => Demotion> = [
    (r) => demoteForPointerLock(r, lock),
    (r) => demoteForLookInput(r, lookInputVerdict(lock)),
    (r) =>
      o.entrance?.verdict.confirmed
        ? { result: r, why: null }
        : demoteForFullscreen(r, lastOf(o.snapshots)?.fullscreen),
    (r) => demoteForNoGameplay(r, quickGameplay(o)),
  ];
  let { result, detail } = first;
  for (const step of steps) {
    const moved = step(result);
    if (moved.why === null) continue;
    result = moved.result;
    detail = `${detail} ${moved.why}`;
  }
  return { result, detail };
}

/** `l2.input_changes_state`. */
export function inputRow(o: QuickObservation): Check {
  const value = { bursts: o.bursts, preBaseline: o.preBaseline, postBaseline: o.postBaseline };
  if (!o.entrance)
    return row(
      ProbeRow.L2InputChangesState,
      CheckResult.Unknown,
      "The canvas never drew, so no input was sent.",
      value,
    );
  const { result, detail } = demoteInput(o, inputVerdict(o));
  return row(ProbeRow.L2InputChangesState, result, detail, value);
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** `l3.visually_legible`: exposure three ways over gameplay frames; a flag for a human, never a gate. */
export function legibleRow(o: QuickObservation): Check {
  const candidates = o.frames.map((f) => ({ ...f.record, raw: f.raw }));
  const selection = selectExposureFrames(candidates, o.firstRenderMs);
  if (selection.why !== null) {
    return row(
      ProbeRow.L3VisuallyLegible,
      CheckResult.Unknown,
      `Not enough gameplay frames to measure exposure: ${selection.why}.`,
      null,
    );
  }
  const reports = selection.chosen.map((f) => exposureReport(f.raw));
  const cw = median(reports.map((r) => r.centreWeightedMean));
  const range = median(reports.map((r) => r.tonalRange));
  const contrast = median(reports.map((r) => r.contrast));
  const value = {
    frames: reports.length,
    medianCentreWeightedMean: cw,
    medianTonalRange: range,
    medianContrast: contrast,
  };
  const figures = `centre-weighted mean ${cw.toFixed(3)}, tonal range ${range.toFixed(3)}, RMS contrast ${contrast.toFixed(3)}`;
  if (cw < EXPOSURE_BROKEN_MEAN && range < EXPOSURE_BROKEN_RANGE) {
    return row(ProbeRow.L3VisuallyLegible, CheckResult.Fail, `The frames carry no visible content: ${figures}.`, value);
  }
  if (cw >= EXPOSURE_OK_MIN && cw <= EXPOSURE_OK_MAX) {
    return row(ProbeRow.L3VisuallyLegible, CheckResult.Pass, `Inside the legible band: ${figures}.`, value);
  }
  return row(
    ProbeRow.L3VisuallyLegible,
    CheckResult.Unknown,
    `Outside the ${EXPOSURE_OK_MIN}–${EXPOSURE_OK_MAX} band but not empty (${figures}): deliberately moody and broken look the same to a number, so this is flagged for a human.`,
    value,
  );
}

/** `l3.renderer_drew`: no rejected draw call and no removed three.js API, on a page that ran. */
export function rendererDrewRow(o: QuickObservation): Check {
  const defects = rendererDefects(o.events.console);
  const value = { lines: defects.count, distinct: defects.distinct };
  if (defects.count > 0) {
    const listed = defects.distinct.map((t) => `"${t.slice(0, 160)}"`).join("; ");
    return row(
      ProbeRow.L3RendererDrew,
      CheckResult.Fail,
      `${defects.count} console line(s), ${defects.distinct.length} distinct: ${listed}.`,
      value,
    );
  }
  const page = ran(o);
  if (!page.ran) return row(ProbeRow.L3RendererDrew, CheckResult.Unknown, `The page did not run (${page.why}).`, value);
  return row(
    ProbeRow.L3RendererDrew,
    CheckResult.Pass,
    "No draw call was rejected and no removed three.js API was named.",
    value,
  );
}

/** All eight quick rows, in `QUICK_PROBE_ROWS` order. */
export function quickRows(o: QuickObservation): Check[] {
  return [
    bootRow(o),
    noErrorsRow(o),
    assetsRow(o),
    stayedRow(o),
    enterableRow(o),
    inputRow(o),
    legibleRow(o),
    rendererDrewRow(o),
  ];
}

/** The frames a grader may see: gameplay frames after the entrance and first render, on the game's origin. */
export function evidenceFrames(o: QuickObservation): LoggedFrame[] {
  if (!quickGameplay(o).reached) return [];
  const gameplay = (f: LoggedFrame) =>
    f.record.phase === ProbePhase.Entrance || POST_GESTURE_PHASES.has(f.record.phase);
  return o.frames.filter((f) => gameplay(f) && f.ref.origin === o.gameOrigin);
}
