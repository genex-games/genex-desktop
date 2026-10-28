/**
 * What the harness measures itself, over time and per playable camera, without asking a judge.
 * Gen3 shipped a classroom that settled at mean luma 28, a doorway nobody watched cross and a
 * sprint camera rolling ±5.8° at 3.7 Hz with an 8.9 cm bob at 7.5 Hz: its six "motion" frames were
 * stills 5.6 s apart, and the pose it logged was never read.
 *
 * - the luminance band: every playable camera's settled frame (look-facts.ts `lumaBandDefect`);
 * - `demo:doorway`: the per-tick exposure trace the engine keeps (`__render.exposure_trace`), held
 *   to a smooth transition with no overshoot;
 * - `demo:sprint-run`: the per-tick camera pose the demo returns (`{ ok, trace }`, the rig's probe
 *   row `state().volatile.camera` collected each tick, or the eye's height and roll for a camera
 *   of the game's own), held to the comfort caps the engine's first-person rig enforces.
 *
 * Each finding is a tagged blocking defect; a round that adds one is not kept (facet/phases/taste.ts).
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import type { AnyRecord } from "../types/harness.d.ts";
import { LookBlocker, runArtPass, ArtTier } from "./look-bar.ts";
import { lumaBandDefect } from "./look-facts.ts";
import { DEFAULT_CAMERA } from "./cameras.ts";

/** The demo that walks the player through a doorway from a lit room into a dark one, or back. */
export const DOORWAY_DEMO = "doorway";
/** The demo that sprints the player straight ahead for a few seconds. */
export const SPRINT_DEMO = "sprint-run";
/** The window an exposure change is measured over, in seconds. */
const EXPOSURE_WINDOW_S = 0.5;
/** The most EV the exposure may move inside that window (review WP-5, proposed). */
export const MAX_EV_PER_WINDOW = 1;
/** The most EV the exposure may pass its settled value by on the way there. */
export const MAX_OVERSHOOT_EV = 0.25;
/** The share of a trace's end that counts as settled. */
const SETTLED_TAIL = 0.15;
/** The least trace a check reads, in seconds: less says nothing about a transition or a gait. */
const MIN_TRACE_S = 1;

/**
 * The comfort caps of a sprint: the engine's first-person rig's own (`genex::camera` rig.rs
 * `BOB_ROLL_MAX_DEG`, `ROLL_TOTAL_MAX_DEG`, `BOB_PEAK_TO_PEAK_MAX`, `CADENCE_MAX_HZ`), so a game on
 * the rig passes and a hand-rolled camera is held to the same numbers. Keep them equal.
 */
export const COMFORT_CAPS = {
  /** Peak roll away from its mean, in degrees. */
  rollDeg: 1.2,
  /** Peak roll from level, the steady lean included, in degrees. */
  rollTotalDeg: 2,
  /** Vertical bob, peak to peak, in metres, after the slope is removed. */
  bobM: 0.028,
  /** The bob's dominant frequency, in Hz: one bob per step at the rig's highest cadence. */
  bobHz: 2.8,
  /** The share of bob or roll energy above `HIGH_HZ` (review WP-3, proposed). */
  highShare: 0.05,
} as const;
/** How far past a cap a measured trace may sit before it is a finding: sampling, not the rig. */
const MEASURE_SLACK = 1.05;
/** Above this frequency camera motion reads as shake, not gait. */
export const HIGH_HZ = 6;
/** Frequencies below this are drift, not a bob. */
const MIN_BOB_HZ = 0.3;

/** The harness's own eye cameras (`eye:spawn`, `eye:here`, …). */
const EYE_PREFIX = "eye:";

/** The cameras a player plays through: the default and the harness's eyes. Demos, crops and the page are not. */
const isPlayable = (camera: unknown): boolean =>
  camera === DEFAULT_CAMERA || (typeof camera === "string" && camera.startsWith(EYE_PREFIX));

/** A field under its snake_case or camelCase name. */
function field(raw: AnyRecord, camel: string): unknown {
  const snake = camel.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return raw[camel] ?? raw[snake];
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** A per-tick trace's samples with a time and every named field a number, in time order. */
function samplesOf(raw: unknown, names: readonly string[]): Array<Record<string, number>> {
  if (!Array.isArray(raw)) return [];
  const out: Array<Record<string, number>> = [];
  for (const entry of raw as AnyRecord[]) {
    if (!entry || typeof entry !== "object") continue;
    const sample: Record<string, number> = {};
    for (const name of ["t", ...names]) {
      const value = num(field(entry, name));
      if (value === null) break;
      sample[name] = value;
    }
    if (Object.keys(sample).length === names.length + 1) out.push(sample);
  }
  return out.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
}

const spanOf = (samples: ReadonlyArray<Record<string, number>>): number =>
  samples.length > 1 ? (samples.at(-1)?.t ?? 0) - (samples[0]?.t ?? 0) : 0;

const fixed = (value: number, digits = 1): string => value.toFixed(digits);

/** One exposure sample's EV: the applied one (what the screen shows), else the metered one, else `ev`. */
function evOf(entry: unknown): AnyRecord | null {
  if (!entry || typeof entry !== "object") return null;
  const raw = entry as AnyRecord;
  return { t: raw.t, ev: num(raw.appliedEv) ?? num(raw.meteredEv) ?? num(raw.ev) };
}

/** The fastest EV move inside any `EXPOSURE_WINDOW_S`, and how far the trace passed its settled EV. */
export function exposureMotion(trace: unknown): { maxStep: number; overshoot: number; span: number } | null {
  const samples = samplesOf(Array.isArray(trace) ? trace.map(evOf) : null, ["ev"]);
  const span = spanOf(samples);
  if (span < MIN_TRACE_S) return null;
  let maxStep = 0;
  for (const [i, from] of samples.entries()) {
    for (const to of samples.slice(i + 1)) {
      if ((to.t ?? 0) - (from.t ?? 0) > EXPOSURE_WINDOW_S) break;
      maxStep = Math.max(maxStep, Math.abs((to.ev ?? 0) - (from.ev ?? 0)));
    }
  }
  const tail = samples.slice(Math.floor(samples.length * (1 - SETTLED_TAIL)));
  const settled = tail.reduce((sum, sample) => sum + (sample.ev ?? 0), 0) / Math.max(1, tail.length);
  const start = samples[0]?.ev ?? settled;
  const rising = settled >= start;
  const passed = samples.map((sample) => ((sample.ev ?? 0) - settled) * (rising ? 1 : -1));
  return { maxStep, overshoot: Math.max(0, ...passed), span };
}

/** `demo:doorway`'s exposure trace as a blocking defect, or null when it is smooth (or there is none). */
export function doorwayDefect(state: AnyRecord | null | undefined): string | null {
  const render = state?.__render as AnyRecord | undefined;
  const motion = exposureMotion(render ? field(render, "exposureTrace") : null);
  if (!motion) return null;
  const jumps = motion.maxStep > MAX_EV_PER_WINDOW;
  const overshoots = motion.overshoot > MAX_OVERSHOOT_EV;
  if (!jumps && !overshoots) return null;
  const what = [
    jumps ? `EV moves ${fixed(motion.maxStep)} inside ${EXPOSURE_WINDOW_S} s (at most ${MAX_EV_PER_WINDOW})` : "",
    overshoots ? `passes its settled EV by ${fixed(motion.overshoot, 2)} (at most ${MAX_OVERSHOOT_EV})` : "",
  ]
    .filter(Boolean)
    .join(" and ");
  return `[${LookBlocker.ExposurePump}] demo:${DOORWAY_DEMO}: crossing the doorway the exposure ${what} — demo:${DOORWAY_DEMO}`;
}

/** The power of a uniformly sampled signal at each frequency bin above zero, with the bin's frequency. */
function spectrum(values: readonly number[], dt: number): Array<{ hz: number; power: number }> {
  const n = values.length;
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const out: Array<{ hz: number; power: number }> = [];
  for (let k = 1; k <= Math.floor(n / 2); k++) {
    let re = 0;
    let im = 0;
    for (const [i, value] of values.entries()) {
      const angle = (2 * Math.PI * k * i) / n;
      re += (value - mean) * Math.cos(angle);
      im -= (value - mean) * Math.sin(angle);
    }
    out.push({ hz: k / (n * dt), power: re * re + im * im });
  }
  return out;
}

/** The share of a spectrum's power above `HIGH_HZ`. */
function highShareOf(bins: ReadonlyArray<{ hz: number; power: number }>): number {
  const total = bins.reduce((sum, bin) => sum + bin.power, 0);
  if (total <= 0) return 0;
  return bins.filter((bin) => bin.hz > HIGH_HZ).reduce((sum, bin) => sum + bin.power, 0) / total;
}

/** A sprint's camera motion, as the comfort caps read it. */
export interface ComfortReading {
  rollDeg: number;
  rollTotalDeg: number;
  bobM: number;
  bobHz: number;
  highShare: number;
}

/** A signal with its straight-line slope removed (the player climbs a ramp; that is not bob). */
function detrended(times: readonly number[], values: readonly number[]): number[] {
  const n = values.length;
  const meanT = times.reduce((sum, t) => sum + t, 0) / n;
  const meanV = values.reduce((sum, v) => sum + v, 0) / n;
  let cov = 0;
  let varT = 0;
  for (const [i, t] of times.entries()) {
    cov += (t - meanT) * ((values[i] ?? 0) - meanV);
    varT += (t - meanT) ** 2;
  }
  const slope = varT > 0 ? cov / varT : 0;
  return values.map((value, i) => value - meanV - slope * ((times[i] ?? 0) - meanT));
}

/**
 * One pose sample: the eye's height (`y`), or the engine rig's own bob offset (`bobM`, its probe row
 * `state().volatile.camera`), with its roll.
 */
function poseOf(entry: unknown): AnyRecord | null {
  if (!entry || typeof entry !== "object") return null;
  const raw = entry as AnyRecord;
  return { t: raw.t, y: num(raw.y) ?? num(raw.bobM) ?? num(raw.bob_m), rollDeg: num(field(raw, "rollDeg")) };
}

/**
 * Where a sprint's pose trace is: the demo's own result (`{ ok, trace }`: the demo steps the game and
 * collects the rig's probe row each tick), else the end state's `__camera.trace`.
 */
function sprintTrace(state: AnyRecord | null | undefined, result: AnyRecord | null | undefined): unknown {
  if (Array.isArray(result?.trace)) return result.trace;
  return fieldOf(state?.__camera, "trace");
}

/** The rig's own cadence at the demo's end (`state().volatile.camera.cadenceHz`), when the game probes it. */
function rigCadence(state: AnyRecord | null | undefined): number | null {
  const camera = (state?.volatile as AnyRecord | undefined)?.camera as AnyRecord | undefined;
  return camera ? num(field(camera, "cadenceHz")) : null;
}

/** The comfort reading of a per-tick camera pose trace, or null when it is too short to read. */
export function comfortReading(trace: unknown): ComfortReading | null {
  const samples = samplesOf(Array.isArray(trace) ? trace.map(poseOf) : null, ["y", "rollDeg"]);
  const span = spanOf(samples);
  if (span < MIN_TRACE_S || samples.length < 8) return null;
  const dt = span / (samples.length - 1);
  const times = samples.map((sample) => sample.t ?? 0);
  const bob = detrended(
    times,
    samples.map((sample) => sample.y ?? 0),
  );
  const rolls = samples.map((sample) => sample.rollDeg ?? 0);
  const rollMean = rolls.reduce((sum, roll) => sum + roll, 0) / rolls.length;
  const bobBins = spectrum(bob, dt).filter((bin) => bin.hz >= MIN_BOB_HZ);
  const rollBins = spectrum(rolls, dt).filter((bin) => bin.hz >= MIN_BOB_HZ);
  const dominant = bobBins.reduce((best, bin) => (bin.power > best.power ? bin : best), { hz: 0, power: 0 });
  return {
    rollDeg: Math.max(...rolls.map((roll) => Math.abs(roll - rollMean))),
    rollTotalDeg: Math.max(...rolls.map((roll) => Math.abs(roll))),
    bobM: Math.max(...bob) - Math.min(...bob),
    bobHz: dominant.hz,
    highShare: Math.max(highShareOf(bobBins), highShareOf(rollBins)),
  };
}

/** What a sprint reading passes its caps by, in words; empty when it is inside every cap. */
function overCaps(reading: ComfortReading | null, cadence: number | null): string[] {
  const past = (value: number, cap: number) => value > cap * MEASURE_SLACK;
  const cadenceOver = cadence !== null && past(cadence, COMFORT_CAPS.bobHz);
  if (!reading) return cadenceOver ? [`steps at ${fixed(cadence ?? 0)} Hz (cap ${COMFORT_CAPS.bobHz} Hz)`] : [];
  return [
    past(reading.rollDeg, COMFORT_CAPS.rollDeg)
      ? `roll ±${fixed(reading.rollDeg)}° (cap ${COMFORT_CAPS.rollDeg}°)`
      : "",
    past(reading.rollTotalDeg, COMFORT_CAPS.rollTotalDeg)
      ? `rolls ${fixed(reading.rollTotalDeg)}° from level (cap ${COMFORT_CAPS.rollTotalDeg}°)`
      : "",
    past(reading.bobM, COMFORT_CAPS.bobM)
      ? `bob ${fixed(reading.bobM * 100)} cm peak to peak (cap ${fixed(COMFORT_CAPS.bobM * 100)} cm)`
      : "",
    past(reading.bobHz, COMFORT_CAPS.bobHz) ? `bob at ${fixed(reading.bobHz)} Hz (cap ${COMFORT_CAPS.bobHz} Hz)` : "",
    past(reading.highShare, COMFORT_CAPS.highShare)
      ? `${Math.round(reading.highShare * 100)}% of the motion above ${HIGH_HZ} Hz (cap ${COMFORT_CAPS.highShare * 100}%)`
      : "",
  ].filter(Boolean);
}

/**
 * `demo:sprint-run` against the comfort caps, as a blocking defect, or null: its pose trace (the
 * demo's result, else the end state's), or with no trace the rig's own cadence.
 */
export function comfortDefect(state: AnyRecord | null | undefined, result: AnyRecord | null = null): string | null {
  const over = overCaps(comfortReading(sprintTrace(state, result)), rigCadence(state));
  if (!over.length) return null;
  return `[${LookBlocker.UncomfortableCamera}] demo:${SPRINT_DEMO}: the sprint camera ${over.join(", ")} — demo:${SPRINT_DEMO}`;
}

/** Does the run declare a night or horror look: its art pass's sky row says so (`night: true`). */
export function declaresNight(run: { readonly [field: string]: unknown } | null | undefined): boolean {
  return (runArtPass(run)?.assets ?? []).some((asset) => asset.tier === ArtTier.Sky && asset.night === true);
}

/** One blocking finding the harness measured: what it is about, its words, and how bad (higher is worse). */
export interface Measured {
  key: string;
  text: string;
  severity: number;
}

/** How much worse a finding the accepted build already had must get to count as the round's own. */
const WORSE_BY = 0.1;

/** What a measured defect is about, its class and subject (`[class] subject: …`): two rounds compare by it, not by its numbers. */
export const measuredKey = (text: string): string => text.split(": ")[0] ?? text;

/** A finding with no measure of its own: present or not. */
const flat = (text: string): Measured => ({ key: measuredKey(text), text, severity: 1 });

/**
 * The findings a round added: those the accepted build did not have (`before`, by key, with its
 * severity), and those it had that the round made worse by more than `WORSE_BY`. Gen3's light facet
 * took a dim classroom (luma 67) to a crushed one (28): the same finding, and the round's own.
 */
export function addedMeasured(now: readonly Measured[], before: Readonly<Record<string, number>>): string[] {
  return now
    .filter((finding) => {
      const was = before[finding.key];
      return was === undefined || finding.severity > was * (1 + WORSE_BY);
    })
    .map((finding) => finding.text);
}

/** Every playable camera outside the luminance band, as blocking findings: the darker, the worse. */
export function lumaBandDefects(evidence: AnyRecord | null | undefined, night: boolean): Measured[] {
  const out: Measured[] = [];
  for (const shot of (evidence?.shots ?? []) as AnyRecord[]) {
    const stats = shot?.stats as AnyRecord | undefined;
    if (!isPlayable(shot?.camera) || typeof stats?.meanLuma !== "number") continue;
    const histogram = Array.isArray(stats.histogram) ? (stats.histogram as number[]) : [];
    const defect = lumaBandDefect(String(shot.camera), { meanLuma: stats.meanLuma, histogram }, { night });
    if (defect?.startsWith(`[${LookBlocker.CrushedShadow}]`))
      out.push({ key: measuredKey(defect), text: defect, severity: Math.max(1, 255 - stats.meanLuma) });
  }
  return out;
}

/**
 * Everything the harness measures on one build that blocks: the luminance band on a run with a
 * visual bar, and on any run the doorway's exposure and the sprint's comfort when the game runs those demos.
 */
export function measuredBlockers(
  run: { readonly [field: string]: unknown } | null | undefined,
  evidence: AnyRecord | null | undefined,
  lookBar: boolean,
): Measured[] {
  const states = (evidence?.demoStates ?? {}) as Record<string, AnyRecord>;
  const doorway = exposureMotion(fieldOf(states[DOORWAY_DEMO]?.__render, "exposureTrace"));
  const results = (evidence?.demos ?? {}) as Record<string, AnyRecord>;
  const sprint = comfortReading(sprintTrace(states[SPRINT_DEMO], results[SPRINT_DEMO]));
  const doorwayText = doorwayDefect(states[DOORWAY_DEMO]);
  const sprintText = comfortDefect(states[SPRINT_DEMO], results[SPRINT_DEMO] ?? null);
  return [
    ...(lookBar ? lumaBandDefects(evidence, declaresNight(run)) : []),
    ...(doorwayText && doorway ? [{ ...flat(doorwayText), severity: doorway.maxStep + doorway.overshoot }] : []),
    ...(sprintText ? [{ ...flat(sprintText), severity: sprint ? comfortSeverity(sprint) : 1 }] : []),
  ];
}

/** A field of a record that may be missing, under either name. */
const fieldOf = (raw: unknown, camel: string): unknown =>
  raw && typeof raw === "object" ? field(raw as AnyRecord, camel) : undefined;

/** How far past its caps a sprint is: the worst ratio of reading to cap. */
const comfortSeverity = (reading: ComfortReading): number =>
  Math.max(
    reading.rollDeg / COMFORT_CAPS.rollDeg,
    reading.rollTotalDeg / COMFORT_CAPS.rollTotalDeg,
    reading.bobM / COMFORT_CAPS.bobM,
    reading.bobHz / COMFORT_CAPS.bobHz,
    reading.highShare / COMFORT_CAPS.highShare,
  );

/** Findings without a measure of their own (the provenance audit's), as measured ones. */
export const presentOnly = (texts: readonly string[]): Measured[] => texts.map(flat);
