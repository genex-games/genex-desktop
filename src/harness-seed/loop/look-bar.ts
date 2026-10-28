/**
 * The look a run is held to, whatever its stack (web, C++ or Rust). The Bodycam rerun (2026-10-28)
 * asked for a photoreal body-cam game: its judges named `[primitive]` about nineteen times and
 * none of it held anything back, so its builders greyboxed and never replaced the greybox — stick
 * trees, untextured poles, a box car, cube snow, a black viewmodel, crushed shadows and a bright
 * blue sky while it snowed, in the person's Live window.
 *
 * Two rules live here, so every judge and the director read one table:
 *  - the look blockers: artefact classes (judge/artefact-classes.md) that keep a facet from
 *    `satisfied`, a finisher from its finish and a ship review from `ship`, in code;
 *  - the art pass: a run whose ask sets a visual bar plans every area's assets and where each one
 *    comes from — a Genex plugin generation, a scan, a Blender script — before a builder starts,
 *    with code-built geometry the last resort.
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import type { AnyRecord, Run } from "../types/harness.d.ts";

/**
 * The artefact classes a finished look may not show. A judge tags a defect with its class
 * (`[primitive] the car is a grey box — eye:spawn`); a tagged one of these holds the work open
 * whichever list the judge put it in.
 */
export const LookBlocker = {
  /** An untextured box, cylinder or capsule standing in for a prop, tree, pole, vehicle or character. */
  Primitive: "primitive",
  /** A first-person viewmodel (hands, weapon, tool) drawn unlit or as a black silhouette. */
  DarkViewmodel: "dark-viewmodel",
  /** Shadows crushed to pure black: no fill, no bounce, no detail inside them. */
  CrushedShadow: "crushed-shadow",
  /** Particles (snow, rain, sparks, dust) drawn as cubes or hard-edged quads with no soft edge. */
  PlaceholderParticles: "placeholder-particles",
  /** A sky or light that contradicts the ask's weather or time of day. */
  SkyContradicts: "sky-contradicts",
  /** A tiled texture whose repeat reads at play distance. */
  VisibleTiling: "visible-tiling",
  /** A scene camera that would not pass as a screenshot from a shipped game of its genre. */
  NotShipped: "not-shipped",
} as const;
export type LookBlocker = (typeof LookBlocker)[keyof typeof LookBlocker];

const BLOCKING: ReadonlySet<string> = new Set(Object.values(LookBlocker));

/** Every `[class]` tag in a defect's words, lower-cased. */
function classTags(text: unknown): string[] {
  return [...String(text ?? "").matchAll(/\[([a-z-]+)\]/gi)].map((match) => (match[1] ?? "").toLowerCase());
}

/** Does this defect name a look blocker? */
export const blocksLook = (text: unknown): boolean => classTags(text).some((tag) => BLOCKING.has(tag));

/** The defects among `texts` that hold the look open, in their order. */
export const lookBlockersIn = (texts: readonly unknown[]): string[] =>
  texts.filter(blocksLook).map((text) => String(text));

/**
 * Words in the ask that set a visual bar. The person's request is the one place that bar is
 * written; reference stills (a typed field) set it too.
 */
const LOOK_WORDS =
  /\b(photo-?real(istic)?|realistic|realism|aaa|beautiful|gorgeous|stunning|cinematic|life-?like|high[- ]fidelity|next[- ]gen)\b/i;

/** Does this run's ask set a visual bar: reference stills, or a brief asking for a finished look? */
export function asksForLook(run: Pick<Run, "goal" | "reference"> & { asks?: unknown }): boolean {
  const stills = (run.reference?.frames ?? []).filter((frame) => frame?.data).length;
  if (stills > 0) return true;
  const asks = Array.isArray(run.asks) ? run.asks.map(String) : [];
  const words = [run.goal, run.reference?.name, run.reference?.notes, ...asks].filter(Boolean).join(" ");
  return LOOK_WORDS.test(words);
}

/** The genre a shipped-look question names: the declared kind, else the first genre. */
export function genreOf(run: Pick<Run, "game" | "genres">): string | null {
  const kind = typeof run.game?.kind === "string" ? run.game.kind : "";
  return kind || run.genres?.[0] || null;
}

/** One scene camera's shipped-look answer, as a judge's JSON gives it. */
export interface ShippedLook {
  camera: string;
  passes: boolean;
  why: string;
}

/** How much of a judge's reason a not-shipped defect quotes. */
const SHIPPED_WHY_CHARS = 200;

/**
 * The cameras a judge said would not pass as a shipped game's screenshot. `cameras`, when given,
 * are the only cameras an answer may name; an answer that is not a list, or a camera it did not
 * answer, adds nothing.
 */
export function notShippedLooks(raw: unknown, cameras: ReadonlySet<string> | null = null): ShippedLook[] {
  const answers = Array.isArray(raw) ? raw : [];
  const out: ShippedLook[] = [];
  for (const entry of answers as AnyRecord[]) {
    const camera = typeof entry?.camera === "string" ? entry.camera.trim() : "";
    const unknownCamera = !camera || (cameras !== null && !cameras.has(camera));
    const answered = out.some((look) => look.camera === camera);
    if (unknownCamera || answered || entry.passes !== false) continue;
    const why =
      String(entry.why ?? "")
        .trim()
        .slice(0, SHIPPED_WHY_CHARS) || "it reads as unfinished";
    out.push({ camera, passes: false, why });
  }
  return out;
}

/** A camera that would not pass, as a `[not-shipped]` defect naming it. */
export const notShippedText = (look: ShippedLook): string =>
  `[${LookBlocker.NotShipped}] would not pass as a shipped game's screenshot: ${look.why} — ${look.camera}`;

/** The cameras a judge said would not pass, as `[not-shipped]` defects. */
export const notShippedDefects = (raw: unknown, cameras: ReadonlySet<string> | null = null): string[] =>
  notShippedLooks(raw, cameras).map(notShippedText);

/** Where an art-pass asset comes from. Code-built geometry is the last resort and says why. */
export const ArtSource = {
  /** A Genex plugin generation: a textured 3D model. */
  GenexModel: "genex-model",
  /** A Genex plugin generation: a PBR texture set. */
  GenexTexture: "genex-texture",
  /** A Genex plugin generation: a rigged character. */
  GenexCharacter: "genex-character",
  /** A Poly Haven or ambientCG scan (CC0). */
  Scan: "scan",
  /** A Blender bpy script the builder runs. */
  Blender: "blender",
  /** Geometry built in the game's code. */
  Code: "code",
} as const;
export type ArtSource = (typeof ArtSource)[keyof typeof ArtSource];

/** How near the camera an asset sits: every tier is planned. */
export const ArtTier = {
  /** Close to the camera: first-person hands and weapon, the props within a few metres. */
  Hero: "hero",
  /** At play distance: buildings, vehicles, trees, furniture. */
  Mid: "mid",
  /** Ground cover and scatter: grass, debris, snow drifts, litter. */
  Scatter: "scatter",
  /** Sky, weather and the light's mood. */
  Sky: "sky",
} as const;
export type ArtTier = (typeof ArtTier)[keyof typeof ArtTier];

/** The sources that spend a Genex generation. */
const GENEX_SOURCES: ReadonlySet<string> = new Set([
  ArtSource.GenexModel,
  ArtSource.GenexTexture,
  ArtSource.GenexCharacter,
]);

/** The most assets one art pass lists. */
export const MAX_ART_ASSETS = 40;
/** How much of one field an art-pass asset keeps. */
const ART_FIELD_CHARS = 160;
/** The plan's word for a run with no visual bar. */
export const ART_NONE = "none";

/** One planned asset. */
export interface ArtAsset {
  area: string;
  tier: ArtTier;
  asset: string;
  source: ArtSource;
  /** Why code builds it: required for `code`, the last resort. */
  why?: string;
}

/** The art pass a plan carries: every asset, and the Genex generations reserved for them. */
export interface ArtPass {
  assets: ArtAsset[];
  /** How many Genex generations the pass reserves: one per asset whose source is a Genex generation. */
  generations: number;
}

/** Why an art pass was refused, by code. */
export const ArtRefusal = {
  /** The ask sets a visual bar and the plan gave no art pass (or said none). */
  Missing: "missing",
  NotJson: "not-json",
  /** Not a list, empty, or longer than `MAX_ART_ASSETS`. */
  NotList: "not-list",
  /** An asset without its area, its words, a known tier or a known source. */
  BadAsset: "bad-asset",
  /** A tier no asset covers. */
  TierMissing: "tier-missing",
  /** Code-built geometry with no reason it cannot come from a generation, a scan or Blender. */
  CodeWithoutWhy: "code-without-why",
} as const;
export type ArtRefusal = (typeof ArtRefusal)[keyof typeof ArtRefusal];

/** A refused art pass: its code and what it names. */
export interface ArtProblem {
  code: ArtRefusal;
  names: string[];
}

const clipField = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .slice(0, ART_FIELD_CHARS);

/** One listed asset, or null when it is not one. */
function assetOf(raw: AnyRecord): ArtAsset | null {
  const area = clipField(raw?.area);
  const asset = clipField(raw?.asset);
  const tier = String(raw?.tier ?? "").trim() as ArtTier;
  const source = String(raw?.source ?? "").trim() as ArtSource;
  const known =
    (Object.values(ArtTier) as string[]).includes(tier) && (Object.values(ArtSource) as string[]).includes(source);
  if (!area || !asset || !known) return null;
  const why = clipField(raw?.why);
  return why ? { area, tier, asset, source, why } : { area, tier, asset, source };
}

/** The listed assets, or what is wrong with them. */
function readAssets(raw: unknown): { assets: ArtAsset[] } | { problem: ArtProblem } {
  let listed: unknown = raw;
  if (typeof raw === "string") {
    try {
      listed = JSON.parse(raw);
    } catch {
      return { problem: { code: ArtRefusal.NotJson, names: [] } };
    }
  }
  const tooMany = Array.isArray(listed) && listed.length > MAX_ART_ASSETS;
  if (!Array.isArray(listed) || !listed.length || tooMany) return { problem: { code: ArtRefusal.NotList, names: [] } };
  const assets: ArtAsset[] = [];
  for (const [index, entry] of listed.entries()) {
    const asset = assetOf((entry ?? {}) as AnyRecord);
    if (!asset) return { problem: { code: ArtRefusal.BadAsset, names: [String(index + 1)] } };
    assets.push(asset);
  }
  return { assets };
}

/**
 * The plan's `art` argument read against the run: an art pass, `null` for a run with no visual
 * bar that gave none, or the refusal. A run whose ask sets a bar must list every tier's assets, and
 * code-built geometry says why.
 */
export function readArtPass(raw: unknown, lookBar: boolean): { art: ArtPass | null } | { problem: ArtProblem } {
  const said = typeof raw === "string" ? raw.trim() : raw;
  const none = said === undefined || said === null || said === "" || String(said).toLowerCase() === ART_NONE;
  if (none) return lookBar ? { problem: { code: ArtRefusal.Missing, names: [] } } : { art: null };
  const read = readAssets(said);
  if ("problem" in read) return read;
  const { assets } = read;
  const covered = new Set(assets.map((asset) => asset.tier));
  const missing = Object.values(ArtTier).filter((tier) => !covered.has(tier));
  if (missing.length) return { problem: { code: ArtRefusal.TierMissing, names: missing } };
  const unexplained = assets
    .filter((asset) => asset.source === ArtSource.Code && !asset.why)
    .map((asset) => asset.asset);
  if (unexplained.length) return { problem: { code: ArtRefusal.CodeWithoutWhy, names: unexplained } };
  const generations = assets.filter((asset) => GENEX_SOURCES.has(asset.source)).length;
  return { art: { assets, generations } };
}

/** The art pass a run carries, when its plan gave one. */
export function runArtPass(run: { readonly [field: string]: unknown } | null | undefined): ArtPass | null {
  const art = run?.art as ArtPass | null | undefined;
  return Array.isArray(art?.assets) && art.assets.length ? art : null;
}
