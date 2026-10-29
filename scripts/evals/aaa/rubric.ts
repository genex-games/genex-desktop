/**
 * The AA+ rubric: measurable floors from the gen3 review's acceptance checks, each a three-valued
 * check at the lowest grade that needs it, plus the blind taste verdict. A prompt's grade is the
 * highest tier whose every check passes; an unmeasured floor never passes, and a floor resting
 * only on reconstructed facts can fail but never certify. Thresholds marked proposed in
 * docs/evals.md are the review's proposals, tuned with the owner later.
 */
import { CheckResult } from "../vocabulary.ts";
import type { AaaCapture, AaaEvidence, AaaMeasure, AaaProp, AaaSurface, FactSource } from "./evidence.ts";
import { FactSource as Source, PropOrigin } from "./evidence.ts";
import { comfortMetrics, exposureMetrics } from "./signals.ts";
import { AaaLook, type AaaPrompt, type AaaView, ViewSetting } from "./suite.ts";

/** A prompt's grade, lowest first. */
export const AaaGrade = {
  BelowAa: "below-aa",
  Aa: "aa",
  AaPlus: "aa-plus",
  AaaIsh: "aaa-ish",
} as const;
export type AaaGrade = (typeof AaaGrade)[keyof typeof AaaGrade];

/** The grades in order, lowest first. */
export const GRADE_ORDER: readonly AaaGrade[] = [AaaGrade.BelowAa, AaaGrade.Aa, AaaGrade.AaPlus, AaaGrade.AaaIsh];

/** Every floor the rubric checks. */
export const AaaFloor = {
  ViewCoverage: "view-coverage",
  CleanResolution: "clean-resolution",
  Native4k: "native-4k",
  LumaBand: "luma-band",
  Doorway: "doorway",
  Comfort: "comfort",
  ReducedMotion: "reduced-motion",
  NearMaps: "near-maps",
  TexelDensity: "texel-density",
  NoPrimitiveProps: "no-primitive-props",
  OrganicCards: "organic-cards",
  FlatCoverage: "flat-coverage",
  Taste: "taste",
} as const;
export type AaaFloor = (typeof AaaFloor)[keyof typeof AaaFloor];

/** A clean judged capture's smallest size (WP-10). */
export const CLEAN_MIN_SIZE = { width: 1600, height: 900 } as const;
/** A native 4K capture's size. */
export const NATIVE_4K_SIZE = { width: 3840, height: 2160 } as const;
/** "Near" for surfaces: within this distance every surface needs normal and ORM maps. */
export const NEAR_SURFACE_M = 10;
/** "Close-up" for props. */
export const CLOSE_PROP_M = 5;
/** Settled mean luma bands and the darkest-bin cap, by look and setting (WP-5, proposed). */
export const LUMA_BANDS: Readonly<Record<AaaLook, Record<ViewSetting, { min: number; max: number; darkMax: number }>>> =
  {
    [AaaLook.Bright]: {
      [ViewSetting.Interior]: { min: 90, max: 130, darkMax: 0.15 },
      [ViewSetting.Exterior]: { min: 90, max: 175, darkMax: 0.15 },
    },
    [AaaLook.Dark]: {
      [ViewSetting.Interior]: { min: 25, max: 95, darkMax: 0.4 },
      [ViewSetting.Exterior]: { min: 25, max: 95, darkMax: 0.4 },
    },
  };
/** Doorway crossing: EV change per 0.5 s and overshoot caps (WP-5, proposed). */
export const DOORWAY_MAX_EV_STEP = 1;
export const DOORWAY_MAX_OVERSHOOT_EV = 0.25;
/** Camera comfort caps for a motion demo (WP-3, proposed). */
export const COMFORT_CAPS = {
  bobPeakToPeakM: 0.03,
  dominantBobHzBelow: 3,
  rollAmplitudeDeg: 1.5,
  maxAbsRollDeg: 2,
  highFrequencyShare: 0.05,
} as const;
/** Reduced motion keeps at most this share of the full bob and roll. */
export const REDUCED_MOTION_MAX_RATIO = 0.1;
/** Texel density floor on near surfaces, px/m, by grade (WP-2, proposed). */
export const TEXEL_DENSITY_FLOOR = { [AaaGrade.Aa]: 256, [AaaGrade.AaPlus]: 512, [AaaGrade.AaaIsh]: 1024 } as const;
/** Screen share drawn with flat materials, by grade (WP-2, proposed). */
export const FLAT_COVERAGE_CAP = { [AaaGrade.Aa]: 0.05, [AaaGrade.AaPlus]: 0.02 } as const;

/** One check of the rubric. */
export interface FloorCheck {
  floor: AaaFloor;
  /** The lowest grade that needs this check to pass. */
  tier: AaaGrade;
  result: CheckResult;
  /** One line per fact that decided it. */
  detail: string[];
}

/** The taste judge's verdict on a prompt: the lowest grade any family gave any view. */
export interface TasteSummary {
  grade: AaaGrade;
  /** Whether a judging family is the same family that built the game. */
  sameFamily: boolean;
  detail: string[];
}

/** A check's outcome as facts are read: any fail fails, any gap is unknown, else pass. */
class Tally {
  fails: string[] = [];
  gaps: string[] = [];
  passes: string[] = [];

  fact(ok: boolean, source: FactSource, line: string): void {
    if (!ok) this.fails.push(`${line} (${source})`);
    else if (source === Source.Reconstructed) this.gaps.push(`${line} (reconstructed: cannot certify)`);
    else this.passes.push(line);
  }

  gap(line: string): void {
    this.gaps.push(line);
  }

  check(floor: AaaFloor, tier: AaaGrade): FloorCheck {
    if (this.fails.length) return { floor, tier, result: CheckResult.Fail, detail: [...this.fails, ...this.gaps] };
    if (this.gaps.length) return { floor, tier, result: CheckResult.Unknown, detail: this.gaps };
    return { floor, tier, result: CheckResult.Pass, detail: this.passes };
  }
}

const capturesOf = (evidence: AaaEvidence, view: AaaView) =>
  evidence.captures.filter((capture) => capture.role === view.role);
const sizeOf = (capture: AaaCapture) => `${capture.width}×${capture.height}`;
const atLeast = (capture: AaaCapture, size: { width: number; height: number }) =>
  capture.width >= size.width && capture.height >= size.height;

function viewCoverage(prompt: AaaPrompt, evidence: AaaEvidence): FloorCheck {
  const tally = new Tally();
  for (const view of prompt.views) {
    const found = capturesOf(evidence, view);
    if (found.length) tally.passes.push(`${view.role}: ${found.map((c) => c.camera).join(", ")}`);
    else tally.fails.push(`${view.role}: no capture mapped to this view`);
  }
  return tally.check(AaaFloor.ViewCoverage, AaaGrade.Aa);
}

/** Per view: a capture meeting the size with the flags true passes; a flag still null is a gap. */
function sizedCaptures(
  prompt: AaaPrompt,
  evidence: AaaEvidence,
  floor: AaaFloor,
  tier: AaaGrade,
  needs: { size: { width: number; height: number }; native: boolean },
): FloorCheck {
  const tally = new Tally();
  const flagsTrue = (c: AaaCapture) => c.clean === true && (!needs.native || c.native === true);
  const flagsOpen = (c: AaaCapture) => c.clean !== false && (!needs.native || c.native !== false);
  for (const view of prompt.views) {
    const sized = capturesOf(evidence, view).filter((c) => atLeast(c, needs.size));
    const good = sized.find(flagsTrue);
    if (good) tally.fact(true, good.source, `${view.role}: ${good.camera} ${sizeOf(good)}`);
    else if (sized.some(flagsOpen))
      tally.gap(`${view.role}: ${sizeOf(sized[0] as AaaCapture)} but clean/native unknown`);
    else {
      const largest = capturesOf(evidence, view).sort((a, b) => b.width * b.height - a.width * a.height)[0];
      tally.fails.push(`${view.role}: largest clean capture ${largest ? sizeOf(largest) : "none"}`);
    }
  }
  return tally.check(floor, tier);
}

function lumaBand(prompt: AaaPrompt, evidence: AaaEvidence): FloorCheck {
  const tally = new Tally();
  for (const view of prompt.views) {
    const band = LUMA_BANDS[prompt.look][view.setting];
    const all = capturesOf(evidence, view);
    const clean = all.filter((c) => c.clean === true);
    if (!all.length) tally.gap(`${view.role}: no capture`);
    for (const c of clean.length ? clean : all) {
      const inBand = c.meanLuma >= band.min && c.meanLuma <= band.max && c.darkFraction <= band.darkMax;
      const line = `${view.role}/${c.camera}: luma ${c.meanLuma.toFixed(0)} (band ${band.min}-${band.max}), darkest bin ${(c.darkFraction * 100).toFixed(0)}% (cap ${band.darkMax * 100}%)`;
      tally.fact(inBand, c.source, line);
    }
  }
  return tally.check(AaaFloor.LumaBand, AaaGrade.Aa);
}

function doorway(prompt: AaaPrompt, evidence: AaaEvidence): FloorCheck {
  const tally = new Tally();
  if (!prompt.transitions.length) tally.passes.push("no doorway in this prompt");
  for (const { demo } of prompt.transitions) {
    const track = evidence.exposure.find((t) => t.demo === demo);
    if (!track) {
      tally.gap(`${demo}: no per-tick exposure track`);
      continue;
    }
    const m = exposureMetrics(track);
    const ok = m.maxEvStepPerWindow <= DOORWAY_MAX_EV_STEP && m.overshootEv <= DOORWAY_MAX_OVERSHOOT_EV;
    tally.fact(
      ok,
      track.source,
      `${demo}: ${m.maxEvStepPerWindow.toFixed(2)} EV/0.5 s, overshoot ${m.overshootEv.toFixed(2)} EV`,
    );
  }
  return tally.check(AaaFloor.Doorway, AaaGrade.Aa);
}

function comfortLine(demo: string, m: ReturnType<typeof comfortMetrics>): string {
  const hz = m.dominantBobHz === null ? "?" : m.dominantBobHz.toFixed(2);
  const high = m.highFrequencyShare === null ? "?" : `${(m.highFrequencyShare * 100).toFixed(0)}%`;
  return `${demo}: bob ${(m.bobPeakToPeakM * 100).toFixed(1)} cm p-p at ${hz} Hz, roll ±${m.rollAmplitudeDeg.toFixed(1)}° (max ${m.maxAbsRollDeg.toFixed(1)}°), >6 Hz ${high}`;
}

function comfort(prompt: AaaPrompt, evidence: AaaEvidence): FloorCheck {
  const tally = new Tally();
  for (const { demo } of prompt.motion) {
    const track = evidence.motion.find((t) => t.demo === demo && !t.reducedMotion);
    if (!track) {
      tally.gap(`${demo}: no per-tick camera track`);
      continue;
    }
    const m = comfortMetrics(track.ticks);
    const over = [
      m.bobPeakToPeakM > COMFORT_CAPS.bobPeakToPeakM,
      m.dominantBobHz !== null && m.dominantBobHz >= COMFORT_CAPS.dominantBobHzBelow,
      m.rollAmplitudeDeg > COMFORT_CAPS.rollAmplitudeDeg,
      m.maxAbsRollDeg > COMFORT_CAPS.maxAbsRollDeg,
      m.highFrequencyShare !== null && m.highFrequencyShare > COMFORT_CAPS.highFrequencyShare,
    ].some(Boolean);
    const unresolved = m.dominantBobHz === null || m.highFrequencyShare === null;
    if (!over && unresolved) tally.gap(`${comfortLine(demo, m)}; track too short or coarse to resolve`);
    else tally.fact(!over, track.source, comfortLine(demo, m));
  }
  return tally.check(AaaFloor.Comfort, AaaGrade.Aa);
}

function reducedMotion(prompt: AaaPrompt, evidence: AaaEvidence): FloorCheck {
  const tally = new Tally();
  for (const { demo } of prompt.motion) {
    const full = evidence.motion.find((t) => t.demo === demo && !t.reducedMotion);
    const reduced = evidence.motion.find((t) => t.demo === demo && t.reducedMotion);
    if (!full || !reduced) {
      tally.gap(`${demo}: needs both a full and a reduced-motion track`);
      continue;
    }
    const a = comfortMetrics(full.ticks);
    const b = comfortMetrics(reduced.ticks);
    const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : 0);
    const worst = Math.max(ratio(b.bobPeakToPeakM, a.bobPeakToPeakM), ratio(b.rollAmplitudeDeg, a.rollAmplitudeDeg));
    const source = full.source === Source.Reconstructed ? full.source : reduced.source;
    tally.fact(worst <= REDUCED_MOTION_MAX_RATIO, source, `${demo}: reduced motion keeps ${(worst * 100).toFixed(0)}%`);
  }
  return tally.check(AaaFloor.ReducedMotion, AaaGrade.AaPlus);
}

const nearSurfaces = (surfaces: readonly AaaSurface[]) => surfaces.filter((s) => s.nearestM <= NEAR_SURFACE_M);

function nearMaps(evidence: AaaEvidence): FloorCheck {
  const tally = new Tally();
  const near = nearSurfaces(evidence.surfaces ?? []);
  if (evidence.surfaces === null) tally.gap("no surface look facts");
  else if (!near.length) tally.gap(`no surfaces reported within ${NEAR_SURFACE_M} m`);
  for (const s of near) {
    if (s.hasNormal === null || s.hasOrm === null) tally.gap(`${s.tag}: maps unknown`);
    else tally.fact(s.hasNormal && s.hasOrm, s.source, `${s.tag}: normal ${s.hasNormal}, ORM ${s.hasOrm}`);
  }
  return tally.check(AaaFloor.NearMaps, AaaGrade.Aa);
}

function texelDensity(evidence: AaaEvidence, tier: keyof typeof TEXEL_DENSITY_FLOOR): FloorCheck {
  const tally = new Tally();
  const floor = TEXEL_DENSITY_FLOOR[tier];
  const near = nearSurfaces(evidence.surfaces ?? []);
  if (!near.length) tally.gap(`no surfaces reported within ${NEAR_SURFACE_M} m`);
  for (const s of near) {
    if (s.texelDensityPxPerM === null) tally.gap(`${s.tag}: density unknown`);
    else tally.fact(s.texelDensityPxPerM >= floor, s.source, `${s.tag}: ${s.texelDensityPxPerM} px/m (floor ${floor})`);
  }
  return tally.check(AaaFloor.TexelDensity, tier);
}

const isCloseOrOrganic = (prop: AaaProp) => prop.organic || prop.nearestM <= CLOSE_PROP_M;

function noPrimitiveProps(evidence: AaaEvidence): FloorCheck {
  const tally = new Tally();
  if (evidence.props === null) tally.gap("no provenance audit");
  for (const prop of (evidence.props ?? []).filter(isCloseOrOrganic)) {
    if (prop.origin === PropOrigin.Unknown) tally.gap(`${prop.tag}: origin unknown`);
    else
      tally.fact(
        prop.origin !== PropOrigin.Primitive,
        prop.source,
        `${prop.tag}: ${prop.origin} at ${prop.nearestM} m`,
      );
  }
  return tally.check(AaaFloor.NoPrimitiveProps, AaaGrade.Aa);
}

function organicCards(evidence: AaaEvidence): FloorCheck {
  const tally = new Tally();
  if (evidence.props === null) tally.gap("no provenance audit");
  for (const prop of (evidence.props ?? []).filter((p) => p.organic)) {
    if (prop.hasCards === null) tally.gap(`${prop.tag}: cards unknown`);
    else tally.fact(prop.hasCards, prop.source, `${prop.tag}: cards or twigs ${prop.hasCards}`);
  }
  return tally.check(AaaFloor.OrganicCards, AaaGrade.AaPlus);
}

function flatCoverage(measure: AaaMeasure | null, tier: keyof typeof FLAT_COVERAGE_CAP): FloorCheck {
  const tally = new Tally();
  const cap = FLAT_COVERAGE_CAP[tier];
  if (measure === null) tally.gap("flat-material coverage not measured");
  else
    tally.fact(
      measure.value <= cap,
      measure.source,
      `flat materials ${(measure.value * 100).toFixed(1)}% (cap ${cap * 100}%)`,
    );
  return tally.check(AaaFloor.FlatCoverage, tier);
}

const gradeIndex = (grade: AaaGrade) => GRADE_ORDER.indexOf(grade);

function tasteCheck(taste: TasteSummary | null, tier: AaaGrade): FloorCheck {
  if (taste === null) return { floor: AaaFloor.Taste, tier, result: CheckResult.Unknown, detail: ["no taste verdict"] };
  const ok = gradeIndex(taste.grade) >= gradeIndex(tier);
  const detail = [`judged ${taste.grade}${taste.sameFamily ? " (same family as the builder)" : ""}`, ...taste.detail];
  return { floor: AaaFloor.Taste, tier, result: ok ? CheckResult.Pass : CheckResult.Fail, detail };
}

/** Every check of the rubric for one prompt's evidence and taste verdict. */
export function rubricChecks(prompt: AaaPrompt, evidence: AaaEvidence, taste: TasteSummary | null): FloorCheck[] {
  return [
    viewCoverage(prompt, evidence),
    sizedCaptures(prompt, evidence, AaaFloor.CleanResolution, AaaGrade.Aa, { size: CLEAN_MIN_SIZE, native: false }),
    lumaBand(prompt, evidence),
    doorway(prompt, evidence),
    comfort(prompt, evidence),
    nearMaps(evidence),
    texelDensity(evidence, AaaGrade.Aa),
    noPrimitiveProps(evidence),
    flatCoverage(evidence.flatCoverage, AaaGrade.Aa),
    sizedCaptures(prompt, evidence, AaaFloor.Native4k, AaaGrade.AaPlus, { size: NATIVE_4K_SIZE, native: true }),
    reducedMotion(prompt, evidence),
    organicCards(evidence),
    texelDensity(evidence, AaaGrade.AaPlus),
    flatCoverage(evidence.flatCoverage, AaaGrade.AaPlus),
    tasteCheck(taste, AaaGrade.AaPlus),
    texelDensity(evidence, AaaGrade.AaaIsh),
    tasteCheck(taste, AaaGrade.AaaIsh),
  ];
}

/** The highest grade whose checks (its own and every lower tier's) all pass. */
export function gradeOf(checks: readonly FloorCheck[]): AaaGrade {
  let grade: AaaGrade = AaaGrade.BelowAa;
  for (const tier of GRADE_ORDER.slice(1)) {
    const needed = checks.filter((check) => check.tier === tier);
    if (!needed.every((check) => check.result === CheckResult.Pass)) break;
    grade = tier;
  }
  return grade;
}

/** The checks that keep a prompt from the grade above the one it got. */
export function blockersOf(checks: readonly FloorCheck[], grade: AaaGrade): FloorCheck[] {
  const next = GRADE_ORDER[gradeIndex(grade) + 1];
  if (next === undefined) return [];
  return checks.filter((check) => check.tier === next && check.result !== CheckResult.Pass);
}
