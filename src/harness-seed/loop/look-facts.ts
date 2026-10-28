/**
 * What the engine reports about the look, per draw tag, and the blockers the harness reads off it
 * without asking a judge. The gen3 Bodycam run (run_mvs67gsbys67) kept rounds that added a bench
 * built from twelve boxes, cone-script birches and a 3 cm slab of snow, because nothing measured
 * them: judges saw 960×540 stills and the round rule counted existence checks.
 *
 * The contract is `state().__render.look` (the Rust engine's look telemetry; snake_case or
 * camelCase): per-tag coverage, flat-material coverage, texel density, map presence and organic
 * cards, and the metered exposure. A game that reports none gets no fact blockers, and the judges'
 * tags still hold (look-bar.ts).
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import type { AnyRecord } from "../types/harness.d.ts";
import { LookBlocker } from "./look-bar.ts";

/** The share of the frame one tag may draw with an untextured constant material (review WP-2, proposed). */
export const FLAT_COVERAGE_MAX = 0.02;
/** A tag smaller than this share of the frame is not judged by its facts: too few pixels to say. */
const MIN_TAG_COVERAGE = 0.002;
/** The settled mean luma (0-255) a playable camera sits in, unless the game declares a night look (WP-5, proposed). */
export const LUMA_BAND = { min: 90, max: 130 } as const;
/** The most of the frame the darkest histogram bin may hold on a playable camera. */
export const DARKEST_BIN_MAX = 0.15;
/** How much a night or horror look may sit below the band before it is crushed, in luma. */
const NIGHT_LUMA_FLOOR = 35;
/** How many decimals a share is quoted with. */
const SHARE_DIGITS = 1;

/** One draw tag's look, as the engine reports it. */
export interface TagLook {
  /** Share of the frame the tag covers, 0-1. */
  coverage: number;
  /** Share of the frame the tag draws with an untextured constant material, 0-1. */
  flatCoverage: number;
  /** Median on-screen texel density, px per metre; null when unreported. */
  texelDensity: number | null;
  /** Triangles per square metre of surface; null when unreported. */
  triDensity: number | null;
  normalMap: boolean | null;
  ormMap: boolean | null;
  /** A tree, bush, grass or other organic thing. */
  organic: boolean;
  /** Alpha-cut cards or twig instances are drawn for it. */
  alphaCards: boolean | null;
  /** Every mesh under the tag is a primitive (box, cylinder, cone, sphere) with no authored detail. */
  primitiveOnly: boolean;
  /** The model file the tag draws (posix, relative to the game folder), when the engine names it. */
  model: string | null;
}

/** The metered exposure of the frame. */
export interface ExposureFacts {
  ev: number | null;
  targetEv: number | null;
  /** Mean luma, 0-255. */
  meanLuma: number | null;
  /** Shares of the frame per luma bin, darkest first. */
  histogram: number[];
}

/** The look a frame reports: per tag, and the exposure. */
export interface LookFacts {
  tags: Record<string, TagLook>;
  exposure: ExposureFacts | null;
}

/** A field under its snake_case or camelCase name. */
function field(raw: AnyRecord | null | undefined, camel: string): unknown {
  if (!raw) return undefined;
  const snake = camel.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return raw[camel] ?? raw[snake];
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const share = (value: unknown): number => Math.max(0, Math.min(1, num(value) ?? 0));

/** One tag's reported look, read defensively. */
function tagLookOf(raw: AnyRecord): TagLook {
  const model = field(raw, "model");
  return {
    coverage: share(field(raw, "coverage")),
    flatCoverage: share(field(raw, "flatCoverage")),
    texelDensity: num(field(raw, "texelDensity")),
    triDensity: num(field(raw, "triDensity")),
    normalMap: bool(field(raw, "normalMap")),
    ormMap: bool(field(raw, "ormMap")),
    organic: field(raw, "organic") === true,
    alphaCards: bool(field(raw, "alphaCards")),
    primitiveOnly: field(raw, "primitiveOnly") === true,
    model: typeof model === "string" && model ? model : null,
  };
}

/** The exposure a frame reports, or null when it reports none. */
function exposureOf(raw: unknown): ExposureFacts | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as AnyRecord;
  const histogram = field(record, "histogram");
  return {
    ev: num(field(record, "ev")),
    targetEv: num(field(record, "targetEv")),
    meanLuma: num(field(record, "meanLuma")),
    histogram: Array.isArray(histogram) ? histogram.map(share) : [],
  };
}

/** The look facts a game state carries (`__render.look`), or null when it carries none. */
export function lookFactsOf(state: AnyRecord | null | undefined): LookFacts | null {
  const look = (state?.__render as AnyRecord | undefined)?.look as AnyRecord | undefined;
  if (!look || typeof look !== "object") return null;
  const tags: Record<string, TagLook> = {};
  const rawTags = look.tags && typeof look.tags === "object" ? (look.tags as Record<string, AnyRecord>) : {};
  for (const [tag, raw] of Object.entries(rawTags)) {
    if (raw && typeof raw === "object") tags[tag] = tagLookOf(raw);
  }
  return { tags, exposure: exposureOf(look.exposure) };
}

/** A blocker read off the facts: its class and the tag it names, and the defect as a judge would write it. */
export interface FactBlocker {
  blocker: LookBlocker;
  tag: string;
  text: string;
}

const percent = (value: number): string => `${(value * 100).toFixed(SHARE_DIGITS)}%`;

/** The blockers one tag's look shows. */
function tagBlockers(tag: string, look: TagLook): FactBlocker[] {
  if (look.coverage < MIN_TAG_COVERAGE) return [];
  const out: FactBlocker[] = [];
  const add = (blocker: LookBlocker, what: string) =>
    out.push({ blocker, tag, text: `[${blocker}] ${tag}: ${what} — engine look facts` });
  if (look.primitiveOnly) add(LookBlocker.Primitive, "every mesh is an untouched primitive");
  if (look.flatCoverage > FLAT_COVERAGE_MAX)
    add(LookBlocker.FlatMaterial, `${percent(look.flatCoverage)} of the frame in an untextured flat material`);
  const stick = look.organic && look.alphaCards === false;
  if (stick) add(LookBlocker.StickTree, "organic, drawn with no leaf or twig cards");
  return out;
}

/** Every blocker the facts show, tag by tag. */
export function factBlockers(facts: LookFacts | null): FactBlocker[] {
  if (!facts) return [];
  return Object.entries(facts.tags).flatMap(([tag, look]) => tagBlockers(tag, look));
}

const blockerKey = (blocker: FactBlocker): string => `${blocker.blocker}\u0000${blocker.tag}`;

/**
 * The blockers the challenger's facts show that the incumbent's do not: what the round added. A
 * challenger with no facts adds nothing by facts; an incumbent with none had nothing, so every
 * challenger blocker is new.
 */
export function addedFactBlockers(
  challenger: AnyRecord | null | undefined,
  incumbent: AnyRecord | null | undefined,
): string[] {
  const before = new Set(factBlockers(lookFactsOf(incumbent)).map(blockerKey));
  return factBlockers(lookFactsOf(challenger))
    .filter((blocker) => !before.has(blockerKey(blocker)))
    .map((blocker) => blocker.text);
}

/** What a playable camera's exposure is held to: the band, or a night look's floor. */
export interface LumaRule {
  /** The game declares a night or horror look: the band's floor drops, crushed blacks still fail. */
  night: boolean;
}

/**
 * A playable camera's settled exposure against the luminance band, as a blocking defect, or null
 * when it sits inside (or reports nothing). Gen3's classroom settled at mean luma 28 with 41% of
 * the frame in the darkest bin, and `[crushed-shadow]` never stopped a keep.
 */
export function lumaBandDefect(camera: string, exposure: ExposureFacts | null, rule: LumaRule): string | null {
  const luma = exposure?.meanLuma ?? null;
  if (luma === null) return null;
  const darkest = exposure?.histogram[0] ?? 0;
  const floor = rule.night ? NIGHT_LUMA_FLOOR : LUMA_BAND.min;
  const crushed = darkest > DARKEST_BIN_MAX && !rule.night;
  if (luma < floor || crushed)
    return `[${LookBlocker.CrushedShadow}] ${camera} settles at mean luma ${Math.round(luma)} with ${percent(darkest)} of the frame in the darkest bin (band ${floor}-${LUMA_BAND.max}, darkest ≤ ${percent(DARKEST_BIN_MAX)}) — ${camera}`;
  if (luma > LUMA_BAND.max && !rule.night)
    return `[blown] ${camera} settles at mean luma ${Math.round(luma)}, above the band's ${LUMA_BAND.max} — ${camera}`;
  return null;
}
