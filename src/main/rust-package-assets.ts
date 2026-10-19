/**
 * The per-destination asset package of a Rust build (C-15): what `writeOutput` in `rust-build.ts`
 * copies from the stage's `assets/` into `out/assets`, and the asset index it writes beside them.
 *
 * - **Families.** A texture's family files (`rock.bc.ktx2`, the runtime's `family_file` rule:
 *   `<stem>.<family>.ktx2` beside the image a game names) go out only for the families the
 *   destination's table ({@link DESTINATION_PACKAGES}) lists. The RGBA8 family file never goes
 *   out: the runtime decodes the source image instead of reading it.
 * - **Sources.** Mac, Windows, Linux and the web keep every source image (a device without the
 *   family falls back to it). A phone drops a source once its package holds every one of the
 *   destination's families for it (owner call C6: iOS ASTC, Android ASTC and ETC2); an image
 *   without them still goes out.
 * - **Phone mips.** On a phone, a family KTX2 larger than `textureCapPx` (default
 *   {@link PHONE_MAX_TEXTURE_PX}) loses its top levels until it fits; the rest of its chain is
 *   written back unchanged. A file that is not one of the families' fixed formats goes out as it is.
 * - **Index.** `assets/genex-asset-index.json` ({@link ASSET_INDEX_FILE}) lists every packaged
 *   asset under the name a game reads it by: its id from a trusted `genex-assets.lock`, its kind and
 *   licence, the files shipped for it with their bytes and family, its dependency edges and its
 *   `boot` flag (every asset is boot until asset groups have a producer). A game's own file at that
 *   name is refused at stage ({@link reservedAssetName}).
 *
 * Only regular files and folders are walked: a link, a FIFO or anything else in the stage is left
 * out, never followed. Pure over its inputs: two packages of one stage are byte-identical.
 */
import { constants as FS } from "node:fs";
import { copyFile, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AssetLicence, type AssetLockEntry } from "../shared/asset-db.ts";
import { type AssetKind, assetKind } from "../shared/game-assets.ts";
import { BuildTarget } from "../shared/game-project.ts";
import { openNoFollow, readRegularFile } from "../substrate/fsx.ts";
import { readKtx2Header } from "../substrate/asset-import/ktx2.ts";
import { writeKtx2 } from "../substrate/asset-import/ktx2-write.ts";
import { DESTINATION_TEXTURES, KTX2_VK_FORMAT, TextureCompression } from "../substrate/asset-import/texture-table.ts";
import type { StagedImportReport } from "./rust-assets.ts";

/** The packaged asset index, at the top of `out/assets`. Reserved: a game's own file there is refused. */
export const ASSET_INDEX_FILE = "genex-asset-index.json";
/** The index format this host writes (genex's `info()` reads it). */
export const ASSET_INDEX_VERSION = 1;
/** The largest texture side a phone package keeps (`phone_max_texture_px`'s default, C-17 makes it a key). */
export const PHONE_MAX_TEXTURE_PX = 2048;
/** The largest family KTX2 the package step reads to trim its mips; a larger one goes out untrimmed. */
const TRIM_READ_MAX_BYTES = 512 * 1024 * 1024;
/** Bytes of a KTX2 header plus its level index entry size: what the trim reads the level index with. */
const KTX2_HEADER_BYTES = 80;
const KTX2_LEVEL_ENTRY_BYTES = 24;

/** Why the package step refused a build. Wire values in the lane's refusal line: never rename one. */
export const PackageRefusal = {
  /** A game file at a name the package step writes ({@link ASSET_INDEX_FILE}). */
  ReservedAssetName: "reserved-asset-name",
} as const;
export type PackageRefusal = (typeof PackageRefusal)[keyof typeof PackageRefusal];

/** Why a staged file stayed out of the package. Wire values in the receipt: never rename one. */
export const PackageDrop = {
  /** A family file of a family the destination does not pick (RGBA8 everywhere). */
  FamilyNotShipped: "family-not-shipped",
  /** A source image a phone's family files cover in full (owner call C6). */
  SourceCovered: "source-covered",
} as const;
export type PackageDrop = (typeof PackageDrop)[keyof typeof PackageDrop];

/** What one destination's package carries of a texture. */
export interface DestinationPackage {
  /** The family files it ships, best first: each one of `DESTINATION_TEXTURES`' families for it. */
  families: readonly TextureCompression[];
  /** Whether a source image stays beside family files that cover it. */
  keepSources: boolean;
  /** Whether family KTX2 mips above the phone cap are dropped. */
  trimsMips: boolean;
}

const { Bc, Astc, Etc2 } = TextureCompression;
const DESKTOP_PACKAGE: DestinationPackage = { families: [Bc], keepSources: true, trimsMips: false };

/**
 * Each destination's package (owner call C6): desktops BC and the source, phones only the families
 * their GPUs are sure to sample (iOS ASTC; Android ASTC, and ETC2 for the GPUs without ASTC), the
 * web every compressed family for the adapter to pick from, and the source.
 */
export const DESTINATION_PACKAGES = Object.freeze({
  [BuildTarget.Mac]: DESKTOP_PACKAGE,
  [BuildTarget.Windows]: DESKTOP_PACKAGE,
  [BuildTarget.Linux]: DESKTOP_PACKAGE,
  [BuildTarget.Ios]: { families: [Astc], keepSources: false, trimsMips: true },
  [BuildTarget.Android]: { families: [Astc, Etc2], keepSources: false, trimsMips: true },
  [BuildTarget.Web]: { families: [Bc, Astc, Etc2], keepSources: true, trimsMips: false },
} as const satisfies Record<BuildTarget, DestinationPackage>);

/** One file shipped for an indexed asset. */
export interface AssetIndexFile {
  /** Relative to `assets/`, `/`-separated. */
  path: string;
  /** The GPU texture family of a family file; absent for the asset's own file. */
  family?: TextureCompression;
  bytes: number;
  /** A KTX2's side in texels as shipped (after a phone's trim). */
  px?: number;
}

/** One asset in the index, under the name a game reads it by. */
export interface AssetIndexEntry {
  /** Relative to `assets/`, `/`-separated: the name a game passes (`textures/rock.png`). */
  path: string;
  /** The trusted lock's id of its source; absent before the first lock or for an edited lock. */
  id?: string;
  kind: AssetKind;
  licence: AssetLicence;
  /** Bytes shipped for it on this destination: its own file (when shipped) and its family files. */
  bytes: number;
  files: AssetIndexFile[];
  /** Ids of the entries it reads (the lock's `deps`), sorted. */
  deps: string[];
  /** Whether it is loaded before the first frame: every asset, until asset groups have a producer. */
  boot: boolean;
}

/** `assets/genex-asset-index.json`. */
export interface AssetIndex {
  version: typeof ASSET_INDEX_VERSION;
  target: BuildTarget;
  /** Sorted by path. */
  assets: AssetIndexEntry[];
}

/** A file the package left out, and why. */
export interface PackageDropped {
  file: string;
  reason: PackageDrop;
}

/** A family file a phone's cap trimmed. */
export interface PackageTrimmed {
  file: string;
  fromPx: number;
  toPx: number;
  bytesBefore: number;
  bytesAfter: number;
}

/** The package's record in the build receipt (`package`). */
export interface AssetPackageReport {
  target: BuildTarget;
  /** Bytes of every file in `out/assets`, the index included. */
  bytes: number;
  /** Files in `out/assets`, the index included. */
  files: number;
  /** Bytes per family, `source` for a family's source image and `other` for everything else. */
  bytesBy: Record<string, number>;
  dropped: PackageDropped[];
  trimmed: PackageTrimmed[];
}

/** One build's package: the stage's assets, where they go, and what the index draws on. */
export interface AssetPackageRequest {
  /** The stage's `assets/` folder (host-owned). */
  from: string;
  /** `out/assets` in the fresh output folder (made). */
  to: string;
  target: BuildTarget;
  /** The rows of the game's `genex-assets.lock` when it read as trusted; null or absent: no ids. */
  lock?: readonly AssetLockEntry[] | null;
  /** The import step's report: which staged output came from which source, for the lock's ids. */
  imported?: StagedImportReport | null;
  /** A phone's texture cap (default {@link PHONE_MAX_TEXTURE_PX}). */
  textureCapPx?: number;
}

/** The stage's folder of game assets, and the package's in `out/`. */
const ASSETS_DIR = "assets";
/** The bucket a source image's bytes count in, beside the families. */
const SOURCE_BUCKET = "source";
const OTHER_BUCKET = "other";
const FAMILIES: ReadonlySet<string> = new Set(Object.values(TextureCompression));
/** Byte order, so the sort never depends on the host's locale. */
const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : Number(a.path > b.path));

/** The name a game's assets/ entry at `rel` collides with, when it is a name the package writes. */
export function reservedAssetPath(rel: string): string | null {
  return rel.toLowerCase() === ASSET_INDEX_FILE ? rel : null;
}

/**
 * The first entry at the top of the stage's `assets/` whose name the package step writes (compared
 * case-blind: a case-insensitive disk would put the index under the game's spelling), as
 * `assets/<name>`; null when there is none.
 */
export async function reservedAssetName(stage: string): Promise<string | null> {
  const names = await readdir(path.join(stage, ASSETS_DIR)).catch(() => [] as string[]);
  const found = names.sort().find((name) => reservedAssetPath(name) !== null);
  return found === undefined ? null : `${ASSETS_DIR}/${found}`;
}

/** A staged file's name split into the stem its family files share and, for a family file, its family. */
interface Named {
  path: string;
  stem: string;
  family: TextureCompression | null;
}

/** `rel`'s stem and family by the runtime's `family_file` rule (`textures/rock.bc.ktx2` → `textures/rock`, bc). */
function named(rel: string): Named {
  const slash = rel.lastIndexOf("/");
  const dot = rel.lastIndexOf(".");
  const stem = dot > slash ? rel.slice(0, dot) : rel;
  if (!rel.endsWith(".ktx2")) return { path: rel, stem, family: null };
  const inner = stem.lastIndexOf(".");
  const tag = inner > slash ? stem.slice(inner + 1) : "";
  if (!FAMILIES.has(tag)) return { path: rel, stem, family: null };
  return { path: rel, stem: stem.slice(0, inner), family: tag as TextureCompression };
}

/** The regular files under `dir`, `/`-separated, in code-unit order; links, FIFOs and linked folders left out. */
async function regularFiles(dir: string, rel = ""): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(path.join(dir, ...rel.split("/")), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await regularFiles(dir, child)));
    else if (entry.isFile()) found.push(child);
  }
  return found.sort((a, b) => (a < b ? -1 : Number(a > b)));
}

/** What the package does with each staged file. */
interface Planned {
  shipped: Named[];
  dropped: PackageDropped[];
}

/** Which staged files go out for `rules`, and why the rest stay. */
function planPackage(staged: readonly string[], rules: DestinationPackage): Planned {
  const all = staged.map(named);
  const familiesOf = new Map<string, Set<TextureCompression>>();
  for (const file of all) {
    if (file.family === null) continue;
    const held = familiesOf.get(file.stem) ?? new Set<TextureCompression>();
    held.add(file.family);
    familiesOf.set(file.stem, held);
  }
  const covered = (stem: string) => {
    const held = familiesOf.get(stem);
    return held !== undefined && rules.families.every((family) => held.has(family));
  };
  const shipped: Named[] = [];
  const dropped: PackageDropped[] = [];
  for (const file of all) {
    if (file.family !== null && !rules.families.includes(file.family)) {
      dropped.push({ file: file.path, reason: PackageDrop.FamilyNotShipped });
    } else if (file.family === null && !rules.keepSources && covered(file.stem)) {
      dropped.push({ file: file.path, reason: PackageDrop.SourceCovered });
    } else shipped.push(file);
  }
  return { shipped, dropped };
}

/** A KTX2's family and colour space by its `vkFormat`, or null for any other format. */
function familyFormat(vkFormat: number): { family: TextureCompression; srgb: boolean } | null {
  for (const family of Object.values(TextureCompression)) {
    const formats = KTX2_VK_FORMAT[family];
    if (vkFormat === formats.srgb) return { family, srgb: true };
    if (vkFormat === formats.linear) return { family, srgb: false };
  }
  return null;
}

/** The levels of a plain (never supercompressed) KTX2, level 0 first; null when the index does not fit the file. */
function ktx2Levels(bytes: Uint8Array, count: number): Uint8Array[] | null {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (KTX2_HEADER_BYTES + count * KTX2_LEVEL_ENTRY_BYTES > bytes.byteLength) return null;
  const levels: Uint8Array[] = [];
  for (let level = 0; level < count; level++) {
    const entry = KTX2_HEADER_BYTES + level * KTX2_LEVEL_ENTRY_BYTES;
    const offset = Number(data.getBigUint64(entry, true));
    const length = Number(data.getBigUint64(entry + 8, true));
    if (offset + length > bytes.byteLength) return null;
    levels.push(bytes.subarray(offset, offset + length));
  }
  return levels;
}

/**
 * `bytes` (a family KTX2) with its top levels dropped until its side is at most `capPx`; null when
 * it already fits or is not a plain, square, full-chain file of a family's fixed format.
 */
export function trimKtx2(bytes: Uint8Array, capPx: number): { bytes: Uint8Array; fromPx: number; toPx: number } | null {
  const header = readKtx2Header(bytes);
  const plainSquare = header?.supercompression === 0 && header.width === header.height;
  if (!header || !plainSquare) return null;
  const format = familyFormat(header.vkFormat);
  const fullChain = header.levels === Math.log2(header.width) + 1;
  if (!format || !fullChain || header.width <= capPx) return null;
  const levels = ktx2Levels(bytes, header.levels);
  if (!levels) return null;
  let drop = 0;
  while (header.width >> drop > capPx && drop + 1 < levels.length) drop++;
  const side = header.width >> drop;
  const out = writeKtx2({ compression: format.family, srgb: format.srgb, side, levels: levels.slice(drop) });
  return { bytes: out, fromPx: header.width, toPx: side };
}

/** One shipped file written into `to`: copied, or for a phone's oversized family KTX2, trimmed. */
async function shipFile(
  request: AssetPackageRequest,
  rules: DestinationPackage,
  file: Named,
  trimmed: PackageTrimmed[],
): Promise<AssetIndexFile> {
  const from = path.join(request.from, ...file.path.split("/"));
  const to = path.join(request.to, ...file.path.split("/"));
  await mkdir(path.dirname(to), { recursive: true });
  const size = (await lstat(from)).size;
  if (file.family === null || !rules.trimsMips) {
    await copyFile(from, to);
    return { path: file.path, ...(file.family ? { family: file.family } : {}), bytes: size, ...(await pxOf(to, file)) };
  }
  const bytes = await readRegularFile(from, TRIM_READ_MAX_BYTES).catch(() => null);
  const cut = bytes ? trimKtx2(bytes, request.textureCapPx ?? PHONE_MAX_TEXTURE_PX) : null;
  if (!cut) {
    await copyFile(from, to);
    return { path: file.path, family: file.family, bytes: size, ...(await pxOf(to, file)) };
  }
  await writeFile(to, cut.bytes);
  trimmed.push({
    file: file.path,
    fromPx: cut.fromPx,
    toPx: cut.toPx,
    bytesBefore: size,
    bytesAfter: cut.bytes.length,
  });
  return { path: file.path, family: file.family, bytes: cut.bytes.length, px: cut.toPx };
}

/** A shipped KTX2's side, read from its header (never through a link); nothing for any other file. */
async function pxOf(file: string, named: Named): Promise<{ px?: number }> {
  if (!named.path.endsWith(".ktx2")) return {};
  const handle = await openNoFollow(file, FS.O_RDONLY | FS.O_NONBLOCK).catch(() => null);
  if (!handle) return {};
  try {
    const head = new Uint8Array(KTX2_HEADER_BYTES);
    const { bytesRead } = await handle.read(head, 0, KTX2_HEADER_BYTES, 0);
    const header = readKtx2Header(head.subarray(0, bytesRead));
    return header ? { px: header.width } : {};
  } finally {
    await handle.close();
  }
}

/** The game-relative source each shipped `assets/` name came from (a converted OBJ's GLB → the OBJ). */
function sourcesOf(imported: StagedImportReport | null | undefined): Map<string, string> {
  const sources = new Map<string, string>();
  for (const row of imported?.files ?? []) {
    if (row.output) sources.set(row.output.file, row.file);
  }
  return sources;
}

/** The index entries of the shipped files: one per asset a game names, its family files with it. */
function indexEntries(
  shipped: readonly AssetIndexFile[],
  dropped: readonly PackageDropped[],
  request: AssetPackageRequest,
): AssetIndexEntry[] {
  const lockByPath = new Map((request.lock ?? []).map((row) => [row.path, row]));
  const sources = sourcesOf(request.imported);
  const familyStems = new Set(shipped.filter((file) => file.family).map((file) => named(file.path).stem));
  // A source and its family files are one asset; a file with no family files is one of its own.
  const keyOf = (rel: string) => {
    const name = named(rel);
    return name.family !== null || familyStems.has(name.stem) ? name.stem : rel;
  };
  const groups = new Map<string, { own: string | null; files: AssetIndexFile[] }>();
  const groupOf = (rel: string) => {
    const key = keyOf(rel);
    const group = groups.get(key) ?? { own: null, files: [] };
    groups.set(key, group);
    return group;
  };
  const covered = dropped.filter((row) => row.reason === PackageDrop.SourceCovered).map((row) => row.file);
  for (const file of covered) groupOf(file).own ??= file;
  for (const file of shipped) {
    const group = groupOf(file.path);
    if (!file.family) group.own ??= file.path;
    group.files.push(file);
  }
  const entries: AssetIndexEntry[] = [];
  for (const [stem, group] of groups) {
    const asset = group.own ?? group.files[0]?.path ?? stem;
    const game = `${ASSETS_DIR}/${asset}`;
    const row = lockByPath.get(sources.get(game) ?? game);
    entries.push({
      path: asset,
      ...(row ? { id: row.id } : {}),
      kind: row?.kind ?? assetKind(asset),
      licence: row?.licence ?? AssetLicence.Unknown,
      bytes: group.files.reduce((sum, file) => sum + file.bytes, 0),
      files: [...group.files].sort(byPath),
      deps: [...(row?.deps ?? [])].sort(),
      boot: true,
    });
  }
  return entries.sort(byPath);
}

/** The receipt's bytes per bucket: each family, the sources that have family files, and the rest. */
function bytesBy(files: readonly AssetIndexFile[], entries: readonly AssetIndexEntry[], index: number) {
  const totals: Record<string, number> = {};
  const add = (bucket: string, bytes: number) => {
    totals[bucket] = (totals[bucket] ?? 0) + bytes;
  };
  const withFamilies = new Set(entries.filter((entry) => entry.files.some((file) => file.family)).map((e) => e.path));
  for (const file of files)
    add(file.family ?? (withFamilies.has(file.path) ? SOURCE_BUCKET : OTHER_BUCKET), file.bytes);
  add(OTHER_BUCKET, index);
  return totals;
}

/**
 * The destination's package: the stage's `assets/` copied into `to` by {@link DESTINATION_PACKAGES}
 * (family files filtered, covered phone sources dropped, phone mips trimmed) and the asset index
 * written beside them. Answers the receipt's record.
 */
export async function packageAssets(request: AssetPackageRequest): Promise<AssetPackageReport> {
  const rules: DestinationPackage = DESTINATION_PACKAGES[request.target];
  await mkdir(request.to, { recursive: true });
  const staged = (await regularFiles(request.from)).filter((rel) => reservedAssetPath(rel) === null);
  const { shipped, dropped } = planPackage(staged, rules);
  const trimmed: PackageTrimmed[] = [];
  const files: AssetIndexFile[] = [];
  for (const file of shipped) files.push(await shipFile(request, rules, file, trimmed));
  const assets = indexEntries(files, dropped, request);
  const index: AssetIndex = { version: ASSET_INDEX_VERSION, target: request.target, assets };
  const text = `${JSON.stringify(index)}\n`;
  await writeFile(path.join(request.to, ASSET_INDEX_FILE), text);
  const indexBytes = Buffer.byteLength(text);
  return {
    target: request.target,
    bytes: files.reduce((sum, file) => sum + file.bytes, indexBytes),
    files: files.length + 1,
    bytesBy: bytesBy(files, assets, indexBytes),
    dropped,
    trimmed,
  };
}

/** Whether every family a destination's package lists is one its texture table may pick. */
export function packageFamiliesListed(target: BuildTarget): boolean {
  const table: readonly TextureCompression[] = DESTINATION_TEXTURES[target];
  return DESTINATION_PACKAGES[target].families.every((family) => table.includes(family));
}
