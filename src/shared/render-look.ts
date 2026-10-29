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

import { EFFECTIVE_PRESETS, type EffectivePreset } from "./render-quality.ts";

/** The version `__render.look` and `__render.exposure` carry; a reader refuses another. */
export const RENDER_LOOK_VERSION = 1;

/**
 * A look feature `__render.look.features` reports drawn or not. Wire values. The harness compares
 * rounds by them: a round that turns one off on the same preset removed a feature instead of
 * fixing the check that failed with it.
 */
export const LookFeature = {
  /** The fog as a lit volume: the sun's shadows carve shafts in it, local lights glow in it. */
  VolumetricFog: "volumetric-fog",
  /** Any fog (the volume or the plain height fog). */
  Fog: "fog",
  Shadows: "shadows",
  SpotShadows: "spot-shadows",
  PointShadows: "point-shadows",
  ContactShadows: "contact-shadows",
  Ao: "ao",
  /** Screen-space global illumination. */
  Ssgi: "ssgi",
  /** Screen-space reflections. */
  Ssr: "ssr",
  Bloom: "bloom",
  Taa: "taa",
  /** Image-based lighting from the environment. */
  Ibl: "ibl",
  LocalExposure: "local-exposure",
  AutoExposure: "auto-exposure",
  DepthOfField: "depth-of-field",
  MotionBlur: "motion-blur",
} as const;
export type LookFeature = (typeof LookFeature)[keyof typeof LookFeature];

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
  /** Model paths drawn under the tag, as the game named them to `gfx.assets().model`, first-draw order, at most 64. */
  models: string[];
  /** Every draw under the tag is an engine primitive (a cube, a sphere, a group of them): no imported or built model. */
  primitiveOnly: boolean;
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
  /**
   * The preset the frame drew (a capture's pinned settings, so a device's fallback never shows);
   * absent from an engine that predates it.
   */
  preset?: EffectivePreset;
  /** Every look feature, true where the frame draws it (the game asks and the preset draws it); absent with `preset`. */
  features?: Record<LookFeature, boolean>;
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

/** One point of `state().__render.exposureTrace`: a Live read-back of the exposure. */
export interface ExposureTracePoint {
  /** Simulated seconds of the frame it describes. */
  t: number;
  appliedEv: number;
  meteredEv: number | null;
}

/** The longest `__render.exposureTrace` (ten seconds of read-backs every fourth frame, with room). */
export const EXPOSURE_TRACE_MAX = 600;

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
/** The most model paths one tag lists. */
const MODELS_PER_TAG_MAX = 64;

const isPreset = (value: unknown): value is EffectivePreset =>
  typeof value === "string" && (EFFECTIVE_PRESETS as readonly string[]).includes(value);

/** Whether `value` holds exactly every look feature, each a boolean. */
function isLookFeatures(value: unknown): value is Record<LookFeature, boolean> {
  if (!isRecord(value)) return false;
  const names = Object.values(LookFeature) as string[];
  const keys = Object.keys(value);
  return keys.length === names.length && keys.every((key) => names.includes(key) && typeof value[key] === "boolean");
}

/** Whether `value`'s optional preset and features are absent or in their shape. */
function featuresInShape(value: Record<string, unknown>): boolean {
  const presetOk = value.preset === undefined || isPreset(value.preset);
  return presetOk && (value.features === undefined || isLookFeatures(value.features));
}

/** Whether `value` is one tag's facts in its shape. */
function isLookTagFacts(value: unknown): value is LookTagFacts {
  if (!isRecord(value)) return false;
  const shares = [value.coverage, value.flatCoverage, value.normalMapShare, value.ormShare, value.alphaCardShare];
  const densities = [value.texelsPerMetre, value.pixelsPerMetre, value.trianglesPerSquareMetre];
  const models =
    Array.isArray(value.models) &&
    value.models.length <= MODELS_PER_TAG_MAX &&
    value.models.every((path) => typeof path === "string");
  const listed = models && typeof value.primitiveOnly === "boolean";
  return shares.every(isShare) && densities.every(isPositiveOrNull) && isCount(value.draws) && listed;
}

/** One tag's facts copied with only its fields. */
function lookTagCopy(facts: LookTagFacts): LookTagFacts {
  const { coverage, flatCoverage, texelsPerMetre, pixelsPerMetre, trianglesPerSquareMetre } = facts;
  const { normalMapShare, ormShare, alphaCardShare, draws, models, primitiveOnly } = facts;
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
    models: [...models],
    primitiveOnly,
  };
}

/** Whether `value` is a `__render.look` in its shape. */
export function isRenderLookFacts(value: unknown): value is RenderLookFacts {
  if (!isRecord(value) || value.version !== RENDER_LOOK_VERSION) return false;
  const { grid, tags } = value;
  const gridOk = Array.isArray(grid) && grid.length === 2 && grid.every((side) => isCount(side) && side > 0);
  if (!gridOk || !isShare(value.coverage) || !isShare(value.flatCoverage) || !isRecord(tags)) return false;
  if (!featuresInShape(value)) return false;
  const facts = Object.values(tags);
  return facts.length <= LOOK_TAGS_MAX && facts.every(isLookTagFacts);
}

/** A checked `__render.look` copied with only its fields, or null outside its shape. */
export function parseRenderLookFacts(value: unknown): RenderLookFacts | null {
  if (!isRenderLookFacts(value)) return null;
  const tags: Record<string, LookTagFacts> = {};
  for (const [tag, facts] of Object.entries(value.tags)) tags[tag] = lookTagCopy(facts);
  const { grid, coverage, flatCoverage, preset, features } = value;
  const facts: RenderLookFacts = {
    version: RENDER_LOOK_VERSION,
    grid: [grid[0], grid[1]],
    coverage,
    flatCoverage,
    tags,
  };
  if (preset !== undefined) facts.preset = preset;
  if (features !== undefined) facts.features = { ...features };
  return facts;
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

/** A checked `__render.exposureTrace` copied point by point, or null outside its shape. */
export function parseExposureTrace(value: unknown): ExposureTracePoint[] | null {
  if (!Array.isArray(value) || value.length > EXPOSURE_TRACE_MAX) return null;
  const points: ExposureTracePoint[] = [];
  for (const point of value) {
    if (
      !isRecord(point) ||
      !isFiniteNumber(point.t) ||
      !isFiniteNumber(point.appliedEv) ||
      !isEvOrNull(point.meteredEv)
    )
      return null;
    points.push({ t: point.t, appliedEv: point.appliedEv, meteredEv: point.meteredEv });
  }
  return points;
}
