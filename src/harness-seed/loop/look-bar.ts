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
  /** A prop, wall or ground drawn in one untextured flat colour: no albedo, normal or roughness detail. */
  FlatMaterial: "flat-material",
  /** A tree or bush built from cones, cylinders or sticks with no leaf or twig cards. */
  StickTree: "stick-tree",
  /** Snow, sand or dust drawn as a separate box or slab laid on a prop or the ground. */
  SlabSnow: "slab-snow",
  /** An asset delivered from a lesser source than the art pass planned (a box script where a model was planned). */
  ArtSourceMismatch: "art-source-mismatch",
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
  /** A Poly Haven or ambientCG scan (CC0): a PBR texture set or an HDRI sky. */
  Scan: "scan",
  /** A CC0 model (Poly Haven, a curated pack), decimated to its tier's budget on import. */
  Cc0Model: "cc0-model",
  /**
   * A modular Blender kit: walls, floors, trims and shells built by a bpy script and textured with
   * scans. Never a hero asset, a prop or anything organic on a run with a visual bar: gen3's bench,
   * birches, bins and garages were box and cone scripts under the old `blender` source.
   */
  BlenderKit: "blender-kit",
  /** Geometry built in the game's code. A bpy script of untouched primitives counts as this. */
  Code: "code",
} as const;
export type ArtSource = (typeof ArtSource)[keyof typeof ArtSource];

/** The old single Blender source: a plan that still writes it is read as a modular kit. */
const LEGACY_BLENDER = "blender";

/** What an art-pass asset is, which decides the sources it may come from. */
export const ArtKind = {
  /** A movable object seen up close: furniture, a bench, a bin, a vehicle, a weapon. */
  Prop: "prop",
  /** Trees, bushes, grass, anything grown. */
  Organic: "organic",
  /** The modular shell: walls, floors, ceilings, trims, building blocks. */
  Structure: "structure",
  /** A surface: a PBR texture set or a decal. */
  Surface: "surface",
  /** A person or creature. */
  Character: "character",
  /** Sky, weather and the light's mood. */
  Atmosphere: "atmosphere",
} as const;
export type ArtKind = (typeof ArtKind)[keyof typeof ArtKind];

/** The kinds a modular Blender kit may never make on a run with a visual bar. */
const NOT_A_KIT: ReadonlySet<string> = new Set([ArtKind.Prop, ArtKind.Organic, ArtKind.Character]);

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

/** The most draw tags one art-pass asset names. */
const MAX_ASSET_TAGS = 8;

/** One planned asset. */
export interface ArtAsset {
  area: string;
  tier: ArtTier;
  asset: string;
  source: ArtSource;
  /** What it is, which decides its sources (`ArtKind`). */
  kind?: ArtKind;
  /** The draw tags the game draws it under: the provenance audit follows them to their files. */
  tags?: string[];
  /** Why code builds it: required for `code`, the last resort, and for a Blender kit (the scans it wears). */
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
  /** An asset on a run with a visual bar that does not say what it is (`kind`). */
  KindMissing: "kind-missing",
  /** A Blender kit planned for a hero asset, a prop, a character or something organic on a run with a visual bar. */
  KitNotForHero: "kit-not-for-hero",
  /** A Blender kit that does not say which scans it wears. */
  KitWithoutWhy: "kit-without-why",
  /** A re-plan adds a part and keeps the old art pass, which plans nothing for it. */
  AreaUnplanned: "area-unplanned",
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

const isOneOf = (vocabulary: Readonly<Record<string, string>>, value: string): boolean =>
  Object.values(vocabulary).includes(value);

/** The source a row names, with the old `blender` read as a kit. */
function sourceOf(raw: unknown): string {
  const said = String(raw ?? "").trim();
  return said === LEGACY_BLENDER ? ArtSource.BlenderKit : said;
}

/** The draw tags a row names: strings, trimmed, at most `MAX_ASSET_TAGS`. */
function tagsOf(raw: unknown): string[] {
  if (typeof raw === "string") return tagsOf([raw]);
  const listed: unknown[] = Array.isArray(raw) ? raw : [];
  return [...new Set(listed.map((tag) => clipField(tag)).filter(Boolean))].slice(0, MAX_ASSET_TAGS);
}

/** One listed asset, or null when it is not one. */
function assetOf(raw: AnyRecord): ArtAsset | null {
  const area = clipField(raw?.area);
  const asset = clipField(raw?.asset);
  const tier = String(raw?.tier ?? "").trim() as ArtTier;
  const source = sourceOf(raw?.source) as ArtSource;
  const kind = String(raw?.kind ?? "").trim();
  const known = isOneOf(ArtTier, tier) && isOneOf(ArtSource, source);
  const kindRead = !kind || isOneOf(ArtKind, kind);
  if (!area || !asset || !known || !kindRead) return null;
  const why = clipField(raw?.why);
  const tags = tagsOf(raw?.tags);
  return {
    area,
    tier,
    asset,
    source,
    ...(kind ? { kind: kind as ArtKind } : {}),
    ...(tags.length ? { tags } : {}),
    ...(why ? { why } : {}),
  };
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
  const kitProblem = lookBar ? kitRefusal(assets) : null;
  if (kitProblem) return { problem: kitProblem };
  const generations = assets.filter((asset) => GENEX_SOURCES.has(asset.source)).length;
  return { art: { assets, generations } };
}

/**
 * What a run with a visual bar refuses about its kits: an asset that does not say what it is, a
 * Blender kit planned for a hero, a prop, a character or something grown, and a kit that does not
 * name the scans it wears.
 */
function kitRefusal(assets: readonly ArtAsset[]): ArtProblem | null {
  const unkinded = assets.filter((asset) => !asset.kind).map((asset) => asset.asset);
  if (unkinded.length) return { code: ArtRefusal.KindMissing, names: unkinded };
  const kits = assets.filter((asset) => asset.source === ArtSource.BlenderKit);
  const heroKits = kits
    .filter((asset) => asset.tier === ArtTier.Hero || NOT_A_KIT.has(asset.kind ?? ""))
    .map((asset) => asset.asset);
  if (heroKits.length) return { code: ArtRefusal.KitNotForHero, names: heroKits };
  const bareKits = kits.filter((asset) => !asset.why).map((asset) => asset.asset);
  return bareKits.length ? { code: ArtRefusal.KitWithoutWhy, names: bareKits } : null;
}

/**
 * The parts a re-plan adds that the art pass it keeps plans nothing for: on a run with a visual
 * bar, a plan that adds a part and omits `art` must give the pass again with the new area in it.
 * Gen3's 16:45 re-plan added the yard, and its assets were planned by nobody.
 */
export function unplannedParts(previousWorkers: readonly string[], workers: readonly string[]): string[] {
  const before = new Set(previousWorkers);
  return workers.filter((id) => !before.has(id));
}

/** The art pass a run carries, when its plan gave one. */
export function runArtPass(run: { readonly [field: string]: unknown } | null | undefined): ArtPass | null {
  const art = run?.art as ArtPass | null | undefined;
  return Array.isArray(art?.assets) && art.assets.length ? art : null;
}
