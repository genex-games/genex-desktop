/**
 * What the engine reports about the look, per draw tag, and the blockers the harness reads off it
 * without asking a judge. The gen3 Bodycam run (run_mvs67gsbys67) kept rounds that added a bench
 * built from twelve boxes, cone-script birches and a 3 cm slab of snow, because nothing measured
 * them: judges saw 960×540 stills and the round rule counted existence checks.
 *
 * The contract is `state().__render.look` (the Rust engine's look telemetry, version 1): per-tag
 * coverage, flat-material coverage, texel and pixel density, and the shares of normal maps, ORM
 * maps and alpha cards. Which tags are organic is the art pass's word (`kind`), not the engine's. A game that reports none gets no fact blockers, and the judges'
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

/**
 * One draw tag's look, as the engine reports it (the aaa-lighting contract, `src/shared/render-look.ts`
 * `LookTagFacts`, version 1). `models` and `primitiveOnly` are the harness's asks beyond version 1:
 * read when present, and absent today.
 */
export interface TagLook {
  /** Share of the whole screen the tag covers after occlusion, 0-1. */
  coverage: number;
  /** Share of the whole screen where the tag's nearest surface is a flat material (no base-colour or emissive map). */
  flatCoverage: number;
  /** Median base-colour texels per metre over its visible cells; null when untextured. */
  texelsPerMetre: number | null;
  /** Median screen pixels per metre at its visible cells; null when unseen. */
  pixelsPerMetre: number | null;
  trianglesPerSquareMetre: number | null;
  /** Shares of the tag's visible cells with a normal map, an ORM map and an alpha-cut card. */
  normalMapShare: number;
  ormShare: number;
  alphaCardShare: number;
  draws: number;
  /** The model files the tag draws (posix, relative to the game folder), when the engine names them. */
  models: string[];
  /** Every mesh under the tag is an untouched primitive, when the engine says so. */
  primitiveOnly: boolean;
}

/** The look a frame reports, per tag. */
export interface LookFacts {
  tags: Record<string, TagLook>;
  /** Share of the screen any flat material covers, tagged or not. */
  flatCoverage: number;
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const share = (value: unknown): number => Math.max(0, Math.min(1, num(value) ?? 0));

/** The model files a tag names: `models`, or a lone `model`. */
function modelsOf(raw: AnyRecord): string[] {
  const listed = Array.isArray(raw.models) ? raw.models : [raw.model];
  return listed.filter((model): model is string => typeof model === "string" && model.length > 0);
}

/** One tag's reported look, read defensively. */
function tagLookOf(raw: AnyRecord): TagLook {
  return {
    coverage: share(raw.coverage),
    flatCoverage: share(raw.flatCoverage),
    texelsPerMetre: num(raw.texelsPerMetre),
    pixelsPerMetre: num(raw.pixelsPerMetre),
    trianglesPerSquareMetre: num(raw.trianglesPerSquareMetre),
    normalMapShare: share(raw.normalMapShare),
    ormShare: share(raw.ormShare),
    alphaCardShare: share(raw.alphaCardShare),
    draws: num(raw.draws) ?? 0,
    models: modelsOf(raw),
    primitiveOnly: raw.primitiveOnly === true,
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
  return { tags, flatCoverage: share(look.flatCoverage) };
}

/** A blocker read off the facts: its class and the tag it names, and the defect as a judge would write it. */
export interface FactBlocker {
  blocker: LookBlocker;
  tag: string;
  text: string;
}

const percent = (value: number): string => `${(value * 100).toFixed(SHARE_DIGITS)}%`;

/** The blockers one tag's look shows; `organic` is whether the art pass plans it as something grown. */
function tagBlockers(tag: string, look: TagLook, organic: boolean): FactBlocker[] {
  if (look.coverage < MIN_TAG_COVERAGE) return [];
  const out: FactBlocker[] = [];
  const add = (blocker: LookBlocker, what: string) =>
    out.push({ blocker, tag, text: `[${blocker}] ${tag}: ${what} — engine look facts` });
  if (look.primitiveOnly) add(LookBlocker.Primitive, "every mesh is an untouched primitive");
  if (look.flatCoverage > FLAT_COVERAGE_MAX)
    add(LookBlocker.FlatMaterial, `${percent(look.flatCoverage)} of the frame in an untextured flat material`);
  const stick = organic && look.alphaCardShare === 0;
  if (stick) add(LookBlocker.StickTree, "organic, drawn with no leaf or twig cards");
  return out;
}

/** Every blocker the facts show, tag by tag; `organic` names the tags the art pass plans as grown things. */
export function factBlockers(facts: LookFacts | null, organic: ReadonlySet<string> = new Set()): FactBlocker[] {
  if (!facts) return [];
  return Object.entries(facts.tags).flatMap(([tag, look]) => tagBlockers(tag, look, organic.has(tag)));
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
  organic: ReadonlySet<string> = new Set(),
): string[] {
  const before = new Set(factBlockers(lookFactsOf(incumbent), organic).map(blockerKey));
  return factBlockers(lookFactsOf(challenger), organic)
    .filter((blocker) => !before.has(blockerKey(blocker)))
    .map((blocker) => blocker.text);
}

/** A captured frame's luma, as the studio measures it (`PixelStats`): the band reads the pixels, not the engine's EV. */
export interface FrameLuma {
  /** Mean luma, 0-255. */
  meanLuma: number | null;
  /** Shares of the frame per luma bin, darkest first. */
  histogram: number[];
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
export function lumaBandDefect(camera: string, exposure: FrameLuma | null, rule: LumaRule): string | null {
  const luma = exposure?.meanLuma ?? null;
  if (luma === null) return null;
  const darkest = exposure?.histogram[0] ?? 0;
  const floor = rule.night ? NIGHT_LUMA_FLOOR : LUMA_BAND.min;
  const crushed = darkest > DARKEST_BIN_MAX && !rule.night;
  if (luma < floor || crushed)
    return `[${LookBlocker.CrushedShadow}] ${camera}: settles at mean luma ${Math.round(luma)} with ${percent(darkest)} of the frame in the darkest bin (band ${floor}-${LUMA_BAND.max}, darkest ≤ ${percent(DARKEST_BIN_MAX)}) — ${camera}`;
  if (luma > LUMA_BAND.max && !rule.night)
    return `[blown] ${camera}: settles at mean luma ${Math.round(luma)}, above the band's ${LUMA_BAND.max} — ${camera}`;
  return null;
}
