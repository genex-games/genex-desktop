/**
 * The engine's look facts and exposure telemetry: what a Rust game's `state().__render.look` and
 * `state().__render.exposure` report about the frame last drawn (AAA review WP-2, WP-5). The Rust
 * side writes them (`native/genex-rust/crates/genex/src/look_facts.rs`, `genex-render`'s
 * `post/exposure.rs`); the harness reads them to hold a round to the look bar. Display only:
 * outside the checksum, never compared between runs or devices.
 *
 * Look facts come from a coarse CPU coverage raster of the world draws (no GPU, the same on every
 * device): each cell holds the nearest draw's tag and material, so a share is a share of the screen
 * after occlusion. Exposure telemetry is read back from the GPU a few frames late.
 */

/** The version `__render.look` and `__render.exposure` carry; a reader refuses another. */
export const RENDER_LOOK_VERSION = 1;

/** `__render.look.tags[tag]`: one tag's surfaces as the frame showed them. */
export interface LookTagFacts {
  /** Share of the screen (0..1) where this tag's draws are the nearest surface. */
  coverage: number;
  /**
   * Share of the screen (0..1) where this tag is nearest with a flat material: no base-colour or
   * emissive map (a coloured box). Custom (Level-2) materials never count as flat.
   */
  flatCoverage: number;
  /** Median base-colour texels per world metre over its visible cells; null when none is textured. */
  texelsPerMetre: number | null;
  /** Median screen pixels per world metre at its visible cells (output resolution); null when unseen. */
  pixelsPerMetre: number | null;
  /** Coverage-weighted mean of mesh triangles per square metre of drawn surface; null when unseen. */
  trianglesPerSquareMetre: number | null;
  /** Share (0..1) of its visible cells drawn with a normal map. */
  normalMapShare: number;
  /** Share (0..1) of its visible cells drawn with an occlusion-roughness-metallic or metal-rough map. */
  ormShare: number;
  /** Share (0..1) of its visible cells drawn with an alpha-cutout or double-sided card material. */
  alphaCardShare: number;
  /** Meshes the tag handed the renderer this frame, seen or not (a model's parts each count). */
  draws: number;
}

/** `state().__render.look`: the frame's look facts. */
export interface RenderLookFacts {
  version: typeof RENDER_LOOK_VERSION;
  /** The coverage raster's cells across and down (about 160 across, the frame's aspect). */
  grid: [number, number];
  /** Share of the screen (0..1) any world draw covers; the rest is sky or the clear colour. */
  coverage: number;
  /** Share of the screen (0..1) covered by flat materials, tagged or not. */
  flatCoverage: number;
  /** Per tag (`frame.tag(name)`); untagged draws count only in the totals above. */
  tags: Record<string, LookTagFacts>;
}

/** Auto or manual exposure, as the look set it. Wire values (`[render.look] exposure`). */
export const ExposureModeWire = {
  Manual: "manual",
  Auto: "auto",
} as const;
export type ExposureModeWire = (typeof ExposureModeWire)[keyof typeof ExposureModeWire];

/** What the engine warns about the look's exposure. Typed, never prose. Wire values. */
export const ExposureWarning = {
  /**
   * `ev_min` is raised above the default while doorway adaptation is on: a dark room meters at
   * the floor, so the exposure stops brightening and the room stays dark however fast it adapts.
   */
  EvMinRaisedWithDoorwayAdaptation: "ev-min-raised-with-doorway-adaptation",
  /** Doorway adaptation is on under manual exposure, where nothing adapts: it does nothing. */
  DoorwayAdaptationUnderManual: "doorway-adaptation-under-manual",
} as const;
export type ExposureWarning = (typeof ExposureWarning)[keyof typeof ExposureWarning];

/** Bins of `__render.exposure.histogram` (the GPU's 128 summed down, a fixed count on every preset). */
export const EXPOSURE_TELEMETRY_BINS = 16;

/** `state().__render.exposure`: what the exposure metered and drew, read back from the GPU. */
export interface ExposureTelemetry {
  version: typeof RENDER_LOOK_VERSION;
  mode: ExposureModeWire;
  /** The scene EV (`log2(luminance / 0.18)`) auto exposure metered; null under manual or before the first read-back. */
  meteredEv: number | null;
  /** The EV it adapts towards (metered, held to `evMin..=evMax`, less the look's curve); null as `meteredEv`. */
  targetEv: number | null;
  /** The EV the frame was drawn at: its exposure is `2^(compensation - appliedEv)`. */
  appliedEv: number;
  /** The look's `ev_compensation`. */
  compensation: number;
  /** The look's metering limits. */
  evMin: number;
  evMax: number;
  /** Share of the metered samples (0..1, summing to 1) per bin over `histogramEv`; empty under manual. */
  histogram: number[];
  /** The scene EV range the histogram covers, low and high edge. */
  histogramEv: [number, number];
  /** Whether the frame adapted at the doorway boost (the camera just crossed a room's box). */
  doorwayBoost: boolean;
  /** Frames between the metered frame and the one `state()` describes (the read-back's lag). */
  ageFrames: number;
  warnings: ExposureWarning[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isShare = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const isPositiveOrNull = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isEvOrNull = (value: unknown): value is number | null => value === null || isFiniteNumber(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const isWarning = (value: unknown): value is ExposureWarning =>
  typeof value === "string" && (Object.values(ExposureWarning) as string[]).includes(value);
const isMode = (value: unknown): value is ExposureModeWire =>
  typeof value === "string" && (Object.values(ExposureModeWire) as string[]).includes(value);

/** The most tags `__render.look` lists (the renderer's tag cap). */
const LOOK_TAGS_MAX = 256;

/** Whether `value` is one tag's facts in its shape. */
function isLookTagFacts(value: unknown): value is LookTagFacts {
  if (!isRecord(value)) return false;
  const shares = [value.coverage, value.flatCoverage, value.normalMapShare, value.ormShare, value.alphaCardShare];
  const densities = [value.texelsPerMetre, value.pixelsPerMetre, value.trianglesPerSquareMetre];
  return shares.every(isShare) && densities.every(isPositiveOrNull) && isCount(value.draws);
}

/** One tag's facts copied with only its fields. */
function lookTagCopy(facts: LookTagFacts): LookTagFacts {
  const { coverage, flatCoverage, texelsPerMetre, pixelsPerMetre, trianglesPerSquareMetre } = facts;
  const { normalMapShare, ormShare, alphaCardShare, draws } = facts;
  return {
    coverage,
    flatCoverage,
    texelsPerMetre,
    pixelsPerMetre,
    trianglesPerSquareMetre,
    normalMapShare,
    ormShare,
    alphaCardShare,
    draws,
  };
}

/** Whether `value` is a `__render.look` in its shape. */
export function isRenderLookFacts(value: unknown): value is RenderLookFacts {
  if (!isRecord(value) || value.version !== RENDER_LOOK_VERSION) return false;
  const { grid, tags } = value;
  const gridOk = Array.isArray(grid) && grid.length === 2 && grid.every((side) => isCount(side) && side > 0);
  if (!gridOk || !isShare(value.coverage) || !isShare(value.flatCoverage) || !isRecord(tags)) return false;
  const facts = Object.values(tags);
  return facts.length <= LOOK_TAGS_MAX && facts.every(isLookTagFacts);
}

/** A checked `__render.look` copied with only its fields, or null outside its shape. */
export function parseRenderLookFacts(value: unknown): RenderLookFacts | null {
  if (!isRenderLookFacts(value)) return null;
  const tags: Record<string, LookTagFacts> = {};
  for (const [tag, facts] of Object.entries(value.tags)) tags[tag] = lookTagCopy(facts);
  const { grid, coverage, flatCoverage } = value;
  return { version: RENDER_LOOK_VERSION, grid: [grid[0], grid[1]], coverage, flatCoverage, tags };
}

/** Whether `value` is a `__render.exposure` in its shape. */
export function isExposureTelemetry(value: unknown): value is ExposureTelemetry {
  if (!isRecord(value) || value.version !== RENDER_LOOK_VERSION || !isMode(value.mode)) return false;
  const { histogram, histogramEv, warnings } = value;
  const evs = isEvOrNull(value.meteredEv) && isEvOrNull(value.targetEv);
  const limits = [value.appliedEv, value.compensation, value.evMin, value.evMax].every(isFiniteNumber);
  const binsOk =
    Array.isArray(histogram) &&
    (histogram.length === 0 || histogram.length === EXPOSURE_TELEMETRY_BINS) &&
    histogram.every(isShare);
  const rangeOk = Array.isArray(histogramEv) && histogramEv.length === 2 && histogramEv.every(isFiniteNumber);
  const flagsOk = typeof value.doorwayBoost === "boolean" && isCount(value.ageFrames);
  const warningsOk = Array.isArray(warnings) && warnings.every(isWarning);
  return evs && limits && binsOk && rangeOk && flagsOk && warningsOk;
}

/** A checked `__render.exposure` copied with only its fields, or null outside its shape. */
export function parseExposureTelemetry(value: unknown): ExposureTelemetry | null {
  if (!isExposureTelemetry(value)) return null;
  const { mode, meteredEv, targetEv, appliedEv, compensation, evMin, evMax, histogram, histogramEv } = value;
  const { doorwayBoost, ageFrames, warnings } = value;
  return {
    version: RENDER_LOOK_VERSION,
    mode,
    meteredEv,
    targetEv,
    appliedEv,
    compensation,
    evMin,
    evMax,
    histogram: [...histogram],
    histogramEv: [histogramEv[0], histogramEv[1]],
    doorwayBoost,
    ageFrames,
    warnings: [...warnings],
  };
}
