/**
 * Texture usage resolution (C-10, owner call C1): which usage (`color`, `data`, `normal`) a
 * texture is encoded as at import, and what decided it. The sources, strongest first:
 *
 * 1. a `[[texture]]` row of `genex.toml` (paths under `assets/`);
 * 2. the material slot a model samples the image from (baseColor and emissive are colour, normal
 *    is a normal map, metallic-roughness and occlusion are data; the `KHR_materials_*` slots
 *    likewise), for a GLB's own images and for the loose files a glTF references;
 * 3. the asset's provenance role: a Genex texture job's file role, a CC0 manifest row's `map`;
 * 4. the kind a Live run observed the game sample it as, as the lock recorded it.
 *
 * Nothing else: a texture none of them names is not encoded and ships as its source image, with
 * the issue `usage-unknown`. A weaker source that disagrees with the winner raises
 * `usage-conflict` (its detail is `<source>:<usage>`). A file's name never decides anything.
 * Pure: the callers read the manifest, the models, the provenance and the lock, and record the
 * result in `genex-assets.lock` through {@link usageLockFacts}.
 */
import path from "node:path";
import {
  type AssetImportSettings,
  type AssetLockEntry,
  AssetOrigin,
  type ImportIssue,
  ImportIssueCode,
  TextureUsageSource,
} from "../../shared/asset-db.ts";
import { assetFormat } from "../../shared/game-assets.ts";
import { TextureUsage } from "./basis-encoder.ts";
import { extension, index, isObject, type Json, objects } from "./gltf-json.ts";
import { isSafeAssetPath } from "./safe-asset.ts";

/** The game folder's asset folders a model and the textures it references may sit in. */
const ASSET_ROOTS = ["assets", "public/assets"] as const;
/** The folder `[[texture]]` paths are relative to. */
const TOML_TEXTURE_ROOT = "assets";
/** A URI with a scheme (`file:`, `https:`, `data:`): never a file of the game. */
const URI_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/** The extensions that name a texture's image in place of (or beside) its `source`. */
const IMAGE_SOURCE_EXTENSIONS = ["EXT_texture_webp", "KHR_texture_basisu", "EXT_texture_avif"] as const;
/** The material extensions whose texture slots this module reads. */
const MATERIAL_EXTENSION_PREFIX = "KHR_materials_";

/** A glTF material's texture slot, by its property name in the file. Wire values: the glTF spec's. */
export const MaterialSlot = {
  BaseColorTexture: "baseColorTexture",
  MetallicRoughnessTexture: "metallicRoughnessTexture",
  NormalTexture: "normalTexture",
  OcclusionTexture: "occlusionTexture",
  EmissiveTexture: "emissiveTexture",
  SpecularTexture: "specularTexture",
  SpecularColorTexture: "specularColorTexture",
  ClearcoatTexture: "clearcoatTexture",
  ClearcoatRoughnessTexture: "clearcoatRoughnessTexture",
  ClearcoatNormalTexture: "clearcoatNormalTexture",
  SheenColorTexture: "sheenColorTexture",
  SheenRoughnessTexture: "sheenRoughnessTexture",
  TransmissionTexture: "transmissionTexture",
  ThicknessTexture: "thicknessTexture",
  AnisotropyTexture: "anisotropyTexture",
  DiffuseTransmissionTexture: "diffuseTransmissionTexture",
  DiffuseTransmissionColorTexture: "diffuseTransmissionColorTexture",
  IridescenceTexture: "iridescenceTexture",
  IridescenceThicknessTexture: "iridescenceThicknessTexture",
} as const;
export type MaterialSlot = (typeof MaterialSlot)[keyof typeof MaterialSlot];

/**
 * The usage each slot samples, as the glTF spec defines its colour space (genex-render's
 * `glb_material.rs` uploads the core slots the same way; a cutout base colour is colour).
 */
export const MATERIAL_SLOT_USAGE = Object.freeze({
  [MaterialSlot.BaseColorTexture]: TextureUsage.Color,
  [MaterialSlot.MetallicRoughnessTexture]: TextureUsage.Data,
  [MaterialSlot.NormalTexture]: TextureUsage.Normal,
  [MaterialSlot.OcclusionTexture]: TextureUsage.Data,
  [MaterialSlot.EmissiveTexture]: TextureUsage.Color,
  [MaterialSlot.SpecularTexture]: TextureUsage.Data,
  [MaterialSlot.SpecularColorTexture]: TextureUsage.Color,
  [MaterialSlot.ClearcoatTexture]: TextureUsage.Data,
  [MaterialSlot.ClearcoatRoughnessTexture]: TextureUsage.Data,
  [MaterialSlot.ClearcoatNormalTexture]: TextureUsage.Normal,
  [MaterialSlot.SheenColorTexture]: TextureUsage.Color,
  [MaterialSlot.SheenRoughnessTexture]: TextureUsage.Data,
  [MaterialSlot.TransmissionTexture]: TextureUsage.Data,
  [MaterialSlot.ThicknessTexture]: TextureUsage.Data,
  [MaterialSlot.AnisotropyTexture]: TextureUsage.Data,
  [MaterialSlot.DiffuseTransmissionTexture]: TextureUsage.Data,
  [MaterialSlot.DiffuseTransmissionColorTexture]: TextureUsage.Color,
  [MaterialSlot.IridescenceTexture]: TextureUsage.Data,
  [MaterialSlot.IridescenceThicknessTexture]: TextureUsage.Data,
} satisfies Record<MaterialSlot, TextureUsage>);

/**
 * The usage of each provenance role, by the origin whose vocabulary it is: a Genex texture job's
 * file `role` (what `npx genex texture` labels each map) and a CC0 manifest row's `map` (Poly
 * Haven's map names). A role an origin does not list decides nothing.
 */
export const PROVENANCE_ROLE_USAGE: Readonly<Partial<Record<AssetOrigin, Readonly<Record<string, TextureUsage>>>>> =
  Object.freeze({
    [AssetOrigin.Genex]: Object.freeze({
      basecolor: TextureUsage.Color,
      normal: TextureUsage.Normal,
      roughness: TextureUsage.Data,
    }),
    [AssetOrigin.Cc0]: Object.freeze({
      diff: TextureUsage.Color,
      nor_gl: TextureUsage.Normal,
      nor_dx: TextureUsage.Normal,
      arm: TextureUsage.Data,
      rough: TextureUsage.Data,
      ao: TextureUsage.Data,
      metal: TextureUsage.Data,
      disp: TextureUsage.Data,
    }),
  });

/** Usages in the order one source's own disagreement is settled: a normal map, then colour, then data. */
const USAGE_ORDER: readonly TextureUsage[] = [TextureUsage.Normal, TextureUsage.Color, TextureUsage.Data];
const USAGES: ReadonlySet<string> = new Set(Object.values(TextureUsage));

/** Whether `value` is a texture usage (`color`, `data`, `normal`). */
export const isTextureUsage = (value: unknown): value is TextureUsage => typeof value === "string" && USAGES.has(value);

/** One `[[texture]]` row: a path under `assets/` and its usage. */
export interface TextureRow {
  path: string;
  usage: TextureUsage;
}

/** Who made an asset, and the role its maker gave it. */
export interface TextureProvenance {
  origin: AssetOrigin;
  role: string;
}

/** What each source says about one texture; a source with nothing to say is left out. */
export interface TextureUsageFacts {
  /** Posix path relative to the game folder (the lock's path). */
  path: string;
  toml?: TextureUsage;
  /** Every slot any model samples this image from. */
  slots?: readonly string[];
  provenance?: TextureProvenance;
  observed?: TextureUsage;
}

/** One texture's usage and what decided it; both null when nothing did (not encoded). */
export interface TextureUsageResolution {
  path: string;
  usage: TextureUsage | null;
  source: TextureUsageSource | null;
  issues: ImportIssue[];
}

/** What every source says about a game's textures, each by the lock's path (rows by theirs). */
export interface TextureUsageInputs {
  toml?: readonly TextureRow[];
  slots?: ReadonlyMap<string, readonly string[]>;
  provenance?: ReadonlyMap<string, TextureProvenance>;
  observed?: ReadonlyMap<string, TextureUsage>;
}

/** One source's claim. */
interface Claim {
  source: TextureUsageSource;
  usage: TextureUsage;
}

/** Own-key lookup, so `__proto__` or `toString` never reads as a slot or a role. */
function own<T>(table: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return table && Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The usages the slots sample, each once, in {@link USAGE_ORDER}. */
function slotUsages(slots: readonly string[]): TextureUsage[] {
  const found = new Set(slots.map((slot) => own<TextureUsage>(MATERIAL_SLOT_USAGE, slot)));
  return USAGE_ORDER.filter((usage) => found.has(usage));
}

/** Every claim, strongest source first; a source's own disagreement in {@link USAGE_ORDER}. */
function claimsOf(facts: TextureUsageFacts): Claim[] {
  const claims: Claim[] = [];
  if (facts.toml) claims.push({ source: TextureUsageSource.Toml, usage: facts.toml });
  for (const usage of slotUsages(facts.slots ?? [])) claims.push({ source: TextureUsageSource.MaterialSlot, usage });
  const role = facts.provenance && own(PROVENANCE_ROLE_USAGE[facts.provenance.origin], facts.provenance.role);
  if (role) claims.push({ source: TextureUsageSource.Provenance, usage: role });
  if (facts.observed) claims.push({ source: TextureUsageSource.Observed, usage: facts.observed });
  return claims;
}

/** The usage the strongest source gives one texture, with a conflict for each weaker one that disagrees. */
export function resolveTextureUsage(facts: TextureUsageFacts): TextureUsageResolution {
  const [winner, ...rest] = claimsOf(facts);
  if (!winner) return { path: facts.path, usage: null, source: null, issues: [{ code: ImportIssueCode.UsageUnknown }] };
  const issues = rest
    .filter((claim) => claim.usage !== winner.usage)
    .map((claim) => ({ code: ImportIssueCode.UsageConflict, detail: `${claim.source}:${claim.usage}` }));
  return { path: facts.path, usage: winner.usage, source: winner.source, issues };
}

/** The `[[texture]]` rows by the lock's path (`assets/<row path>`). */
export function tomlTextureUsages(rows: readonly TextureRow[]): Map<string, TextureUsage> {
  return new Map(rows.map((row) => [`${TOML_TEXTURE_ROOT}/${row.path}`, row.usage]));
}

/** Every texture of `paths` resolved from what the sources say, in the order given. */
export function resolveTextureUsages(paths: readonly string[], inputs: TextureUsageInputs): TextureUsageResolution[] {
  const toml = tomlTextureUsages(inputs.toml ?? []);
  return paths.map((file) =>
    resolveTextureUsage({
      path: file,
      toml: toml.get(file),
      slots: inputs.slots?.get(file),
      provenance: inputs.provenance?.get(file),
      observed: inputs.observed?.get(file),
    }),
  );
}

/** What the lock records for a resolved texture: its usage and source (when one decided), and the issues. */
export function usageLockFacts(resolved: TextureUsageResolution): {
  settings: AssetImportSettings;
  issues: ImportIssue[];
} {
  const settings: AssetImportSettings = {};
  if (resolved.usage !== null && resolved.source !== null) {
    settings.usage = resolved.usage;
    settings.usageSource = resolved.source;
  }
  return { settings, issues: resolved.issues };
}

/** The Live observations a lock recorded (rows an observation decided), for the next import's step 4. */
export function observedUsages(entries: readonly AssetLockEntry[]): Map<string, TextureUsage> {
  const observed = new Map<string, TextureUsage>();
  for (const entry of entries) {
    const { usage, usageSource } = entry.settings;
    if (usageSource === TextureUsageSource.Observed && isTextureUsage(usage)) observed.set(entry.path, usage);
  }
  return observed;
}

/** Whether `file` is an image the importer encodes (a PNG, JPEG or WebP: the format table's raster textures). */
export function isEncodableTexture(file: string): boolean {
  const format = assetFormat(file);
  return format?.raster === true && format.texture === true;
}

/** Whether a `[[texture]]` row may name `file`: a safe asset path under `assets/` to an image the importer encodes. */
export function isTextureRowPath(file: string): boolean {
  return isSafeAssetPath(file) && isEncodableTexture(file);
}

// ── Material slots of a glTF ────────────────────────────────────────────────────────────────────

/** The images a texture samples: its `source` and any image an extension names in its place. */
function textureImages(texture: Json, imageCount: number): number[] {
  const named = [texture.source, ...IMAGE_SOURCE_EXTENSIONS.map((name) => extension(texture, name)?.source)];
  return named.map(index).filter((image): image is number => image !== null && image < imageCount);
}

/** The objects of a material that hold texture slots: the material, its PBR block, its KHR_materials_* extensions. */
function slotHolders(material: Json): Json[] {
  const holders = [material];
  if (isObject(material.pbrMetallicRoughness)) holders.push(material.pbrMetallicRoughness);
  const extensions = isObject(material.extensions) ? material.extensions : {};
  for (const [name, block] of Object.entries(extensions)) {
    if (name.startsWith(MATERIAL_EXTENSION_PREFIX) && isObject(block)) holders.push(block);
  }
  return holders;
}

/** Every (texture index, slot) a material samples. */
function materialSlots(material: Json): Array<[number, MaterialSlot]> {
  const found: Array<[number, MaterialSlot]> = [];
  for (const holder of slotHolders(material)) {
    for (const slot of Object.values(MaterialSlot)) {
      const info = holder[slot];
      const texture = isObject(info) ? index(info.index) : null;
      if (texture !== null) found.push([texture, slot]);
    }
  }
  return found;
}

/**
 * The slots each image of a glTF document is sampled from, by image index in index order, each
 * image's slots sorted and once. A malformed index or an unknown extension's slot names nothing.
 */
export function gltfImageSlots(json: unknown): Map<number, MaterialSlot[]> {
  if (!isObject(json)) return new Map();
  const images = Array.isArray(json.images) ? json.images.length : 0;
  const textures: unknown[] = Array.isArray(json.textures) ? json.textures : [];
  const byImage = new Map<number, Set<MaterialSlot>>();
  for (const material of objects(json.materials)) {
    for (const [at, slot] of materialSlots(material)) {
      const texture = textures[at];
      const sampled = isObject(texture) ? textureImages(texture, images) : [];
      for (const image of sampled) byImage.set(image, (byImage.get(image) ?? new Set()).add(slot));
    }
  }
  return new Map(
    [...byImage.entries()].sort(([a], [b]) => a - b).map(([image, slots]) => [image, [...slots].sort(byText)]),
  );
}

/** The asset folder a game-relative path sits in, or null. */
function assetRootOf(file: string): string | null {
  return ASSET_ROOTS.find((root) => file.startsWith(`${root}/`)) ?? null;
}

/** An image URI resolved against the model's folder, or null when it is not a plain file inside `root`. */
function referencedPath(modelPath: string, root: string, uri: unknown): string | null {
  if (typeof uri !== "string" || uri === "" || URI_SCHEME.test(uri) || uri.startsWith("/")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    return null;
  }
  if (/[\\\0]/.test(decoded)) return null;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(modelPath), decoded));
  const inside = joined.startsWith(`${root}/`) && isSafeAssetPath(joined);
  return inside ? joined : null;
}

/**
 * The slots each loose image a glTF at `modelPath` references is sampled from, by the image's
 * game-relative path in path order. A reference that is not a plain relative file inside the
 * model's own asset folder (a scheme, an absolute path, a climb out, a backslash, a NUL) is
 * dropped, and so is every reference of a model outside an asset folder. Nothing is read.
 */
export function referencedImageSlots(modelPath: string, json: unknown): Map<string, MaterialSlot[]> {
  const root = isSafeAssetPath(modelPath) ? assetRootOf(modelPath) : null;
  if (root === null || !isObject(json)) return new Map();
  const images = Array.isArray(json.images) ? json.images : [];
  const byPath = new Map<string, Set<MaterialSlot>>();
  for (const [image, slots] of gltfImageSlots(json)) {
    const entry = images[image];
    const file = isObject(entry) ? referencedPath(modelPath, root, entry.uri) : null;
    if (file === null) continue;
    const known = byPath.get(file) ?? new Set();
    for (const slot of slots) known.add(slot);
    byPath.set(file, known);
  }
  return new Map(
    [...byPath.entries()].sort(([a], [b]) => byText(a, b)).map(([file, slots]) => [file, [...slots].sort(byText)]),
  );
}

/** Every model's references merged: each path's slots from all of them, sorted and once. */
export function mergeImageSlots(maps: Iterable<ReadonlyMap<string, readonly string[]>>): Map<string, string[]> {
  const merged = new Map<string, Set<string>>();
  for (const map of maps) {
    for (const [file, slots] of map) merged.set(file, new Set([...(merged.get(file) ?? []), ...slots]));
  }
  return new Map(
    [...merged.entries()].sort(([a], [b]) => byText(a, b)).map(([file, slots]) => [file, [...slots].sort(byText)]),
  );
}

/** Byte order, so a sort never depends on the host's locale. */
function byText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
