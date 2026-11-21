/**
 * The prober's shared shapes: one row of a scorecard, what the browser reported (network, console)
 * and the frames it wrote. Ported from genex-demo's `prober/types.ts`, cut to what the ported pure
 * modules and the quick probe read; the full scorecard arrives with the per-phase prober (M3).
 *
 * One rule governs every shape: `unknown` is a first-class result. A check that could not run says
 * so; nothing quietly passes because the measurement was unavailable, and nothing collapses several
 * independent facts into one boolean.
 */
import type { CheckResult, ProbePhase, ProbeRow } from "../vocabulary.ts";
import type { ExposureReport } from "./frames.ts";
import { PROBE_NETWORK_POLICY_DIGEST } from "./network-policy.ts";

/**
 * The prober's version pin (`grading.proberVersion`); a change here is a regrade (§10.6). One value
 * covers the quick and the full prober: calibration and regrade reuse both gate on this one pin, and
 * a grade's kind is its own pin (`probe.quick`, `soakMs`; a calibration records which prober it ran).
 * `.2` is the full prober's arrival (directions, ack, soak, audio and phone rows on desktop); `.3`
 * holds the page to the preview's network policy, whose CDN-list digest rides on the end (Rule 8:
 * network is an explicit pin), so a change of allowed hosts is a recalibration and a regrade too;
 * `.4` never asks the browser for pointer lock, which takes the real cursor on macOS (the page's
 * request engages the synthetic lock at once instead of after the browser's refusal), and gives a
 * baseline that never changed the fine change floor (`STILL_CHANGE_DIFF`).
 */
export const PROBER_VERSION = `genex-prober/6+desktop.4+cdn.${PROBE_NETWORK_POLICY_DIGEST}`;

/** The layer a row gates: L1 fails the floor, L2 is play, L3 flags for a human and never gates. */
export const CheckLayer = {
  L1: "L1",
  L2: "L2",
  L3: "L3",
} as const;
export type CheckLayer = (typeof CheckLayer)[keyof typeof CheckLayer];

/** Who answers a row: the machine, or a judge reading the evidence. */
export const CheckSource = {
  Machine: "machine",
  Judge: "judge",
} as const;
export type CheckSource = (typeof CheckSource)[keyof typeof CheckSource];

/**
 * What a frame photographed: a full-page screenshot (canvas plus DOM HUD, what the judge reads), a
 * screenshot of the largest canvas element (no DOM), or a canvas readback inside the page.
 */
export const ShotKind = {
  Page: "page",
  Element: "element",
  Canvas: "canvas",
} as const;
export type ShotKind = (typeof ShotKind)[keyof typeof ShotKind];

/** One row of a scorecard. */
export interface Check {
  id: ProbeRow;
  layer: CheckLayer;
  /** The row's own wording, so a scorecard reads next to the plan. */
  title: string;
  result: CheckResult;
  source: CheckSource;
  /** The measurement; never a bare boolean when several numbers went into the verdict. */
  value: unknown;
  /** Why this result, in a sentence a human can check against the evidence. */
  detail: string;
  /**
   * Whether this row may decide its layer's gate; absent means yes. `false` is for a row that went
   * `unknown` because this substrate cannot measure it (frame rate on a software rasteriser), as
   * opposed to one the game left unanswered, and for a row that can never fail by construction.
   */
  gates?: boolean;
}

/** One request the browser made, as the driver recorded it. */
export interface NetworkEntry {
  url: string;
  method: string;
  status: number | null;
  resourceType: string;
  /** The browser's failure text for a request that never got a response; `null` otherwise. */
  failure: string | null;
  startedAtMs: number;
}

/** One console line the page wrote. */
export interface ConsoleEntry {
  atMs: number;
  type: string;
  text: string;
}

/** One frame written to the evidence folder. */
export interface FrameRecord {
  file: string;
  /** Milliseconds after the page was opened. */
  atMs: number;
  phase: ProbePhase;
  label: string;
  source?: ShotKind;
  width?: number;
  height?: number;
}

/** The result a verdict helper hands back when it may move a row. */
export interface Demotion {
  readonly result: CheckResult;
  readonly why: string | null;
}

/** One analysed frame's exposure, for the legibility and dark-phase rows. */
export interface ExposureSample {
  file: string;
  phase: ProbePhase;
  report: ExposureReport;
}
