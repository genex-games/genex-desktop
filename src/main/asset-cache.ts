/**
 * The content-addressed import cache (game systems C-3; ideas from Bevy's asset processor: a full
 * hash over everything an import reads, and a write-ahead marker). The importer is a pure
 * function of its source bytes, settings, version, tool digests, dependency digests and texture
 * families, so that tuple's sha256 names what it wrote: an unchanged build runs no importer job.
 *
 * An entry is `<root>/<key>/`: its outputs as `<slot>.<ext>` and `receipt.json`, which lists each
 * output's size and sha256, carries the caller's line, and holds a digest of its own body. A
 * commit writes the entry in `<root>/.staging/` and renames it into place; `<key>.pending`, made
 * before the job starts, is removed only after that rename, so an interrupted import re-runs and
 * a half-written entry is never read. A lookup never follows a link and changes nothing but the
 * entry's last-used time; anything it cannot vouch for is a typed miss. Retention is LRU to a cap,
 * never evicting an entry a running build holds.
 */
import { constants as FS, createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, lutimes, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { HOUR_MS } from "../shared/duration.ts";
import { readRegularFile, writeNewFile } from "../substrate/fsx.ts";
import {
  AssetImportRefusal,
  ImportAction,
  ImportConverter,
  type ImporterStep,
  isAssetImportRefusal,
  planImport,
  runsImporter,
} from "../substrate/asset-import/import-plan.ts";
import { IMPORT_JOB_VERSION } from "../substrate/asset-import/job.ts";
import { Ktx2FamilySkip } from "../substrate/asset-import/ktx2.ts";
import { objMaterialLibrary } from "../substrate/asset-import/obj.ts";
import { readGameAsset } from "../substrate/asset-import/safe-asset.ts";
import { type EncodedTexture, parseEncodedTexture } from "../substrate/asset-import/texture-encode.ts";
import {
  familyFileName,
  TextureCompression,
  type TranscodedTexture,
  texturesForTargets,
} from "../substrate/asset-import/texture-table.ts";
import { canonicalJson } from "../substrate/toolchain-store/genex-cmake.ts";
import {
  IMPORT_INPUT_MAX_BYTES,
  IMPORT_OUTPUT_MAX_BYTES,
  type ImportedAsset,
  type ImportOutput,
  importRustAssets,
  type RustAssetImportDeps,
  type RustAssetImportRequest,
  type RustAssetImportResult,
} from "./rust-assets.ts";

/** The default size cap; a smaller one is set where disk is short. */
export const ASSET_CACHE_DEFAULT_CAP_BYTES = 4 * 1024 * 1024 * 1024;
/** The entry format this host writes and reads; another version is a miss. */
export const ASSET_CACHE_VERSION = 1;
/** The largest entry receipt read back. */
const RECEIPT_MAX_BYTES = 1024 * 1024;
/** A staging folder no commit of this process owns, older than this, is a dead commit's. */
const STAGING_STALE_MS = HOUR_MS;
/** How many files a build reads and looks up at once. */
const LOOKUP_CONCURRENCY = 8;

const RECEIPT_FILE = "receipt.json";
const PENDING_SUFFIX = ".pending";
const STAGING_DIR = ".staging";
const SHA256 = /^[0-9a-f]{64}$/;
/** An output's name in its entry: a slot and one or two extensions (`0.glb`, `1.bc.ktx2`). */
const ENTRY_FILE = /^\d{1,4}(\.[a-z0-9]{1,8}){1,2}$/;

/** Why a lookup is a miss. Wire values in logs: never rename one. */
export const AssetCacheRefusal = {
  /** The key is not a lowercase sha256: refused before any path is built. */
  BadKey: "bad-key",
  Missing: "missing",
  /** A `<key>.pending` marker: an import of this key started and never committed. */
  Pending: "pending",
  /** The entry's name is a link or a file, not a folder of its own. */
  NotFolder: "not-folder",
  /** The receipt is missing, a link, unreadable, of another version or key, or names a bad file. */
  BadReceipt: "bad-receipt",
  /** The receipt's own digest does not match its body. */
  ReceiptDigest: "receipt-digest",
  /** An output is missing, a link or not a regular file. */
  OutputNotRegular: "output-not-regular",
  /** An output's size is not the receipt's. */
  OutputSize: "output-size",
} as const;
export type AssetCacheRefusal = (typeof AssetCacheRefusal)[keyof typeof AssetCacheRefusal];

/** One open cache: its folder, cap and clock, and the keys running builds hold. */
export interface AssetCache {
  readonly root: string;
  readonly capBytes: number;
  readonly now: () => number;
  readonly holds: Map<string, number>;
  /** Staging folders of commits in flight in this process. */
  readonly staging: Set<string>;
}

/** How a cache opens. */
export interface AssetCacheOptions {
  /** A host-owned folder no sandboxed process writes (the layout's `assetCache`, `<profile>/asset-cache`). */
  root: string;
  capBytes?: number;
  /** Injectable: the LRU's clock. */
  now?: () => number;
}

/** The cache at `options.root`; nothing is read or made until it is used. */
export function openAssetCache(options: AssetCacheOptions): AssetCache {
  return {
    root: options.root,
    capBytes: options.capBytes ?? ASSET_CACHE_DEFAULT_CAP_BYTES,
    now: options.now ?? Date.now,
    holds: new Map(),
    staging: new Set(),
  };
}

/** Everything one import of one file reads: what its cache key hashes. */
export interface ImportCacheKeyInput {
  /** The source file's sha256. */
  source: string;
  converter: ImportConverter;
  /** The model name the importer writes (the file's stem). */
  name: string;
  /** The file's import settings (a `[[texture]]` row's usage), as JSON. */
  settings: unknown;
  jobVersion: number;
  /** Each importer tool's digest, by tool. */
  tools: Readonly<Record<string, string>>;
  /** Each dependency's sha256, by role (`mtl`). */
  deps: Readonly<Record<string, string>>;
  /** The texture families the build's destinations may pick. */
  families: readonly TextureCompression[];
}

/** The cache key of one import: a sha256 that ignores key and family order. */
export function importCacheKey(input: ImportCacheKeyInput): string {
  const families = [...new Set(input.families)].sort();
  const body = canonicalJson({ cache: ASSET_CACHE_VERSION, ...input, families });
  return createHash("sha256").update(body).digest("hex");
}

/** One output in an entry. */
export interface CacheEntryFile {
  name: string;
  bytes: number;
  sha256: string;
  /** Its absolute path, inside the entry. */
  path: string;
}

/** An entry a lookup vouched for. */
export interface CacheEntry {
  key: string;
  files: CacheEntryFile[];
  /** The caller's line, as committed: the caller validates it. */
  meta: unknown;
  bytes: number;
}

/** A lookup's answer. */
export type CacheLookup =
  | { ok: true; entry: CacheEntry; refusal?: undefined }
  | { ok: false; refusal: AssetCacheRefusal; entry?: undefined };

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const miss = (refusal: AssetCacheRefusal): CacheLookup => ({ ok: false, refusal });

/** `<root>/<key>` and its marker. */
function entryPaths(cache: AssetCache, key: string) {
  const dir = path.join(cache.root, key);
  return { dir, pending: `${dir}${PENDING_SUFFIX}`, receipt: path.join(dir, RECEIPT_FILE) };
}

/** A receipt's file list, or null when any line is not a well-formed output name, size and digest. */
function parseEntryFiles(value: unknown): Omit<CacheEntryFile, "path">[] | null {
  if (!Array.isArray(value)) return null;
  const files: Omit<CacheEntryFile, "path">[] = [];
  for (const line of value) {
    if (!isRecord(line)) return null;
    const { name, bytes, sha256: digest } = line;
    const valid = typeof name === "string" && ENTRY_FILE.test(name) && isCount(bytes);
    if (!valid || typeof digest !== "string" || !SHA256.test(digest)) return null;
    files.push({ name, bytes, sha256: digest });
  }
  return new Set(files.map((file) => file.name)).size === files.length ? files : null;
}

/** The receipt's body for `key`, or a refusal: its format, its key, then its own digest. */
function parseReceipt(text: string, key: string): CacheLookup | Omit<CacheEntry, "bytes"> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return miss(AssetCacheRefusal.BadReceipt);
  }
  if (!isRecord(value) || value.version !== ASSET_CACHE_VERSION || value.key !== key) {
    return miss(AssetCacheRefusal.BadReceipt);
  }
  const files = parseEntryFiles(value.files);
  if (!files || typeof value.digest !== "string") return miss(AssetCacheRefusal.BadReceipt);
  const { digest, ...body } = value;
  if (sha256(canonicalJson(body)) !== digest) return miss(AssetCacheRefusal.ReceiptDigest);
  return { key, meta: value.meta, files: files.map((file) => ({ ...file, path: "" })) };
}

/** Each output is a regular file of the receipt's size at its name in the entry. */
async function checkOutputs(dir: string, files: CacheEntryFile[]): Promise<AssetCacheRefusal | null> {
  for (const file of files) {
    file.path = path.join(dir, file.name);
    const info = await lstat(file.path).catch(() => null);
    if (!info?.isFile()) return AssetCacheRefusal.OutputNotRegular;
    if (info.size !== file.bytes) return AssetCacheRefusal.OutputSize;
  }
  return null;
}

/** The entry at `key`, checked, ignoring any marker; reads only, never through a link. */
async function readEntry(cache: AssetCache, key: string): Promise<CacheLookup> {
  const paths = entryPaths(cache, key);
  const info = await lstat(paths.dir).catch(() => null);
  if (!info) return miss(AssetCacheRefusal.Missing);
  if (!info.isDirectory()) return miss(AssetCacheRefusal.NotFolder);
  const text = await readRegularFile(paths.receipt, RECEIPT_MAX_BYTES).catch(() => null);
  if (!text) return miss(AssetCacheRefusal.BadReceipt);
  const parsed = parseReceipt(text.toString("utf8"), key);
  if ("ok" in parsed) return parsed;
  const refusal = await checkOutputs(paths.dir, parsed.files);
  if (refusal) return miss(refusal);
  const bytes = parsed.files.reduce((sum, file) => sum + file.bytes, 0);
  return { ok: true, entry: { ...parsed, bytes } };
}

/**
 * The entry at `key`, or why it is a miss. A hit is marked used (the receipt's time, for the LRU);
 * a miss changes nothing.
 */
export async function lookupEntry(cache: AssetCache, key: string): Promise<CacheLookup> {
  if (!SHA256.test(key)) return miss(AssetCacheRefusal.BadKey);
  const paths = entryPaths(cache, key);
  if (await lstat(paths.pending).catch(() => null)) return miss(AssetCacheRefusal.Pending);
  const found = await readEntry(cache, key);
  if (found.ok) {
    const at = new Date(cache.now());
    await lutimes(paths.receipt, at, at).catch(() => {});
  }
  return found;
}

/** Mark `key` in flight before its import starts: the write-ahead marker. */
export async function beginEntry(cache: AssetCache, key: string): Promise<void> {
  if (!SHA256.test(key)) throw new Error(`not a cache key: ${JSON.stringify(key)}`);
  const { pending } = entryPaths(cache, key);
  await mkdir(cache.root, { recursive: true });
  // `rm` removes a link planted at the name, never what it names; the create is exclusive.
  await rm(pending, { force: true });
  await writeNewFile(pending, "");
}

/** Drop `key`'s marker without an entry: its import ended with nothing worth keeping. */
export async function abandonEntry(cache: AssetCache, key: string): Promise<void> {
  if (SHA256.test(key)) await rm(entryPaths(cache, key).pending, { force: true });
}

/** One file to commit: its path, and the digest it must have when one is known. */
export type CacheFileInput = string | { path: string; sha256: string };

/** A file's sha256, streamed. */
async function fileDigest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** `.glb` of `out/3.glb`, `.bc.ktx2` of `out/3.bc.ktx2`; a safe suffix or `.bin`. */
function entryFileName(slot: number, source: string): string {
  const base = path.basename(source).toLowerCase();
  const dot = base.indexOf(".");
  const name = `${slot}${dot >= 0 ? base.slice(dot) : ""}`;
  return ENTRY_FILE.test(name) ? name : `${slot}.bin`;
}

/** Copy one output into the staging folder (a clone where the disk can), checked. */
async function stageFile(staging: string, slot: number, input: CacheFileInput): Promise<Omit<CacheEntryFile, "path">> {
  const from = typeof input === "string" ? input : input.path;
  const info = await lstat(from);
  if (!info.isFile() || info.size > IMPORT_OUTPUT_MAX_BYTES) throw new Error(`not a cacheable file: ${from}`);
  const name = entryFileName(slot, from);
  const to = path.join(staging, name);
  await copyFile(from, to, FS.COPYFILE_EXCL | FS.COPYFILE_FICLONE);
  const [digest, copied] = await Promise.all([fileDigest(to), lstat(to)]);
  if (typeof input !== "string" && digest !== input.sha256) throw new Error(`digest changed: ${from}`);
  return { name, bytes: copied.size, sha256: digest };
}

/** Put a complete staging folder at `<root>/<key>`; an entry already there that checks out wins. */
async function placeEntry(cache: AssetCache, key: string, staging: string): Promise<void> {
  const { dir } = entryPaths(cache, key);
  try {
    await rename(staging, dir);
    return;
  } catch {
    if ((await readEntry(cache, key)).ok) return;
  }
  // What is there is no entry of ours: a link is removed as a link, never followed.
  await rm(dir, { recursive: true, force: true });
  await rename(staging, dir);
}

/**
 * Commit `files` and the caller's `meta` as `key`'s entry: staged, then renamed into place, then
 * the marker removed. Null, with nothing left behind but the marker's removal, when it fails.
 */
export async function commitEntry(
  cache: AssetCache,
  key: string,
  files: readonly CacheFileInput[],
  meta: unknown,
): Promise<CacheEntry | null> {
  if (!SHA256.test(key)) return null;
  const staging = path.join(cache.root, STAGING_DIR, `${key}-${randomUUID()}`);
  cache.staging.add(staging);
  try {
    await mkdir(staging, { recursive: true });
    const staged = [];
    for (const [slot, file] of files.entries()) staged.push(await stageFile(staging, slot, file));
    const body = { version: ASSET_CACHE_VERSION, key, files: staged, meta };
    const receipt = path.join(staging, RECEIPT_FILE);
    await writeNewFile(receipt, JSON.stringify({ ...body, digest: sha256(canonicalJson(body)) }));
    const at = new Date(cache.now());
    await lutimes(receipt, at, at);
    await placeEntry(cache, key, staging);
    await abandonEntry(cache, key);
    const found = await readEntry(cache, key);
    return found.ok ? found.entry : null;
  } catch {
    await abandonEntry(cache, key);
    return null;
  } finally {
    cache.staging.delete(staging);
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** Hold `keys` for a running build: eviction skips them until the returned release runs. */
export function holdEntries(cache: AssetCache, keys: readonly string[]): () => void {
  for (const key of keys) cache.holds.set(key, (cache.holds.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) {
      const left = (cache.holds.get(key) ?? 1) - 1;
      if (left > 0) cache.holds.set(key, left);
      else cache.holds.delete(key);
    }
  };
}

/** What one eviction pass did. */
export interface EvictionReport {
  /** Keys removed, least recently used first. */
  evicted: string[];
  freedBytes: number;
  /** Bytes of the entries left, held ones included. */
  keptBytes: number;
}

/** An entry eviction may weigh: its key, size and last use. */
interface Candidate {
  key: string;
  bytes: number;
  usedAt: number;
  pinned: boolean;
}

/** Every entry the cache wrote, with its size and last use; links, strays and broken entries are skipped. */
async function listCandidates(cache: AssetCache): Promise<Candidate[]> {
  const names = await readdir(cache.root, { withFileTypes: true }).catch(() => []);
  const keys = new Set(names.filter((entry) => entry.isDirectory() && SHA256.test(entry.name)).map((e) => e.name));
  const pending = new Set(names.filter((entry) => entry.name.endsWith(PENDING_SUFFIX)).map((e) => e.name));
  const candidates: Candidate[] = [];
  for (const key of keys) {
    const found = await readEntry(cache, key);
    const used = found.ok ? await lstat(entryPaths(cache, key).receipt).catch(() => null) : null;
    if (!found.ok || !used) continue;
    const pinned = cache.holds.has(key) || pending.has(`${key}${PENDING_SUFFIX}`);
    candidates.push({ key, bytes: found.entry.bytes, usedAt: used.mtimeMs, pinned });
  }
  return candidates;
}

/** Remove staging folders a dead commit left: older than the stale age and not in flight here. */
async function sweepStaging(cache: AssetCache): Promise<void> {
  const root = path.join(cache.root, STAGING_DIR);
  const names = await readdir(root).catch(() => []);
  for (const name of names) {
    const dir = path.join(root, name);
    const info = await lstat(dir).catch(() => null);
    const stale = info !== null && cache.now() - info.mtimeMs > STAGING_STALE_MS;
    if (stale && !cache.staging.has(dir)) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Evict least recently used entries until the cache fits its cap; held and in-flight entries stay. */
export async function evictEntries(cache: AssetCache): Promise<EvictionReport> {
  await sweepStaging(cache);
  const candidates = await listCandidates(cache);
  let keptBytes = candidates.reduce((sum, entry) => sum + entry.bytes, 0);
  const order = candidates
    .filter((entry) => !entry.pinned)
    .sort((a, b) => a.usedAt - b.usedAt || (a.key < b.key ? -1 : 1));
  const evicted: string[] = [];
  let freedBytes = 0;
  for (const entry of order) {
    if (keptBytes <= cache.capBytes) break;
    await rm(entryPaths(cache, entry.key).dir, { recursive: true, force: true });
    evicted.push(entry.key);
    freedBytes += entry.bytes;
    keptBytes -= entry.bytes;
  }
  return { evicted, freedBytes, keptBytes };
}

// --- The import step through the cache -----------------------------------------------------------

/** An import with what its cache key needs beyond the files. */
export interface CachedImportRequest extends RustAssetImportRequest {
  /** Each importer tool's digest, by tool: a new tool build re-imports. */
  tools: Readonly<Record<string, string>>;
  /** A file's import settings (its `[[texture]]` row), as JSON; none by default. */
  settingsFor?(file: string): unknown;
}

/** An import served from the cache where it could be, the misses run as one job. */
export interface CachedImportResult {
  /** Each file's outcome, in request order; outputs of hits and committed misses live in the cache. */
  files: ImportedAsset[];
  hits: number;
  misses: number;
  /** The one importer job, when any file missed; the caller removes its folder. */
  job?: RustAssetImportResult;
  /** Let eviction have this build's entries again, once their outputs are placed. */
  release(): void;
}

/** A cached import's line: the outcome, with outputs as slots of the entry. */
interface CachedLine {
  action: ImportAction;
  converter: ImportConverter;
  refusal?: AssetImportRefusal;
  output?: number;
  families?: { slot: number; compression: TextureCompression }[];
  textures?: TranscodedTexture[];
  familiesSkipped?: Ktx2FamilySkip;
  /** An encoded loose texture's record (C-12). */
  texture?: EncodedTexture;
}

/** A guard for one vocabulary's values. */
const oneOf =
  <T>(values: readonly T[]) =>
  (value: unknown): value is T =>
    (values as readonly unknown[]).includes(value);
const isAction = oneOf(Object.values(ImportAction));
const isConverter = oneOf(Object.values(ImportConverter));
const isFamily = oneOf(Object.values(TextureCompression));
const isSkip = oneOf(Object.values(Ktx2FamilySkip));

const isSlot = (value: unknown, files: number): value is number => isCount(value) && value < files;

function isTexture(value: unknown): value is TranscodedTexture {
  if (!isRecord(value)) return false;
  const { compression, format, bytes, sha256: digest } = value;
  const counts = isCount(format) && isCount(bytes);
  return counts && isFamily(compression) && typeof digest === "string" && SHA256.test(digest);
}

/** A line's family slots, each inside the entry; null for anything else. */
function parseFamilies(value: unknown, files: number): NonNullable<CachedLine["families"]> | null {
  if (!Array.isArray(value)) return null;
  const families: NonNullable<CachedLine["families"]> = [];
  for (const family of value) {
    if (!isRecord(family) || !isSlot(family.slot, files) || !isFamily(family.compression)) return null;
    families.push({ slot: family.slot, compression: family.compression });
  }
  return families;
}

/** The optional fields of an output line, checked; null when one is malformed. */
function parseOutputFields(meta: Record<string, unknown>, files: number): Partial<CachedLine> | null {
  const { families, textures, familiesSkipped, texture } = meta;
  const parsedFamilies = families === undefined ? undefined : parseFamilies(families, files);
  const texturesValid = textures === undefined || (Array.isArray(textures) && textures.every(isTexture));
  const skipValid = familiesSkipped === undefined || isSkip(familiesSkipped);
  const encoded = texture === undefined ? undefined : parseEncodedTexture(texture);
  if (parsedFamilies === null || !texturesValid || !skipValid || encoded === null) return null;
  return {
    ...(parsedFamilies ? { families: parsedFamilies } : {}),
    ...(Array.isArray(textures) ? { textures: textures.filter(isTexture) } : {}),
    ...(isSkip(familiesSkipped) ? { familiesSkipped } : {}),
    ...(encoded ? { texture: encoded } : {}),
  };
}

/** A committed line, checked against the vocabularies and the entry's file count; null for anything else. */
function parseCachedLine(meta: unknown, files: number): CachedLine | null {
  if (!isRecord(meta) || !isAction(meta.action) || !isConverter(meta.converter)) return null;
  const { action, converter, refusal, output } = meta;
  if (refusal !== undefined) {
    const kept = isAssetImportRefusal(refusal) && refusal !== AssetImportRefusal.ImporterFailed && files === 0;
    return kept ? { action, converter, refusal } : null;
  }
  if (!isSlot(output, files)) return null;
  const fields = parseOutputFields(meta, files);
  return fields ? { action, converter, output, ...fields } : null;
}

/** `assets/ship.obj` → `assets/ship.glb`: the name an output takes beside its source. */
function besideSource(file: string, ext: string): string {
  const dot = file.lastIndexOf(".");
  return `${dot > file.lastIndexOf("/") ? file.slice(0, dot) : file}.${ext}`;
}

const outputOf = (entryFile: CacheEntryFile, file: string): ImportOutput => ({
  path: entryFile.path,
  file,
  bytes: entryFile.bytes,
  sha256: entryFile.sha256,
});

/** A hit as the import step's outcome, every output named beside the file's current path. */
function fromLine(file: string, step: ImporterStep, line: CachedLine, entry: CacheEntry): ImportedAsset | null {
  const base: ImportedAsset = { file, action: line.action, converter: line.converter };
  if (line.refusal) return { ...base, refusal: line.refusal };
  const output = line.output === undefined ? undefined : entry.files[line.output];
  if (!output) return null;
  const families = line.families?.map((family) => {
    const stored = entry.files[family.slot];
    return stored ? outputOf(stored, familyFileName(file, family.compression)) : null;
  });
  if (families?.includes(null)) return null;
  return {
    ...base,
    output: outputOf(output, besideSource(file, step.output)),
    ...(line.textures ? { textures: line.textures } : {}),
    ...(families ? { families: families as ImportOutput[] } : {}),
    ...(line.familiesSkipped ? { familiesSkipped: line.familiesSkipped } : {}),
    ...(line.texture ? { texture: line.texture } : {}),
  };
}

/** What to commit for an import's outcome, or null when it is not worth keeping (an importer failure). */
function toLine(imported: ImportedAsset): { files: CacheFileInput[]; meta: CachedLine } | null {
  const { action, converter, refusal, output } = imported;
  if (!converter) return null;
  if (refusal === AssetImportRefusal.ImporterFailed) return null;
  if (refusal) return { files: [], meta: { action, converter, refusal } };
  if (!output) return null;
  const families = imported.families ?? [];
  const familyLines: NonNullable<CachedLine["families"]> = [];
  for (const [at, family] of families.entries()) {
    const compression = Object.values(TextureCompression).find((c) => familyFileName(imported.file, c) === family.file);
    if (!compression) return null;
    familyLines.push({ slot: at + 1, compression });
  }
  const meta: CachedLine = {
    action,
    converter,
    output: 0,
    ...(imported.families ? { families: familyLines } : {}),
    ...(imported.textures ? { textures: imported.textures } : {}),
    ...(imported.familiesSkipped ? { familiesSkipped: imported.familiesSkipped } : {}),
    ...(imported.texture ? { texture: imported.texture } : {}),
  };
  const files = [output, ...families].map((item) => ({ path: item.path, sha256: item.sha256 }));
  return { files, meta };
}

/** The import outcome with its outputs moved to their committed copies in the entry. */
function withEntryPaths(imported: ImportedAsset, entry: CacheEntry): ImportedAsset {
  const at = (slot: number, item: ImportOutput) => ({ ...item, path: entry.files[slot]?.path ?? item.path });
  return {
    ...imported,
    ...(imported.output ? { output: at(0, imported.output) } : {}),
    ...(imported.families ? { families: imported.families.map((family, slot) => at(slot + 1, family)) } : {}),
  };
}

/** How one file resolved before any job: an outcome, or a miss to import. */
type Resolved = { done: ImportedAsset } | { miss: { file: string; key: string } };

/** An OBJ's material library digest, when it names a safe one that is there. */
async function objDeps(gameRoot: string, file: string, bytes: Uint8Array): Promise<Record<string, string>> {
  const library = objMaterialLibrary(new TextDecoder().decode(bytes));
  if (!library) return {};
  const dir = path.posix.dirname(file);
  const read = await readGameAsset(gameRoot, dir === "." ? library : `${dir}/${library}`, IMPORT_INPUT_MAX_BYTES);
  return read.ok ? { mtl: sha256(read.bytes) } : {};
}

/** One file: its plan, then (for an importer file) its key, held, and looked up. */
async function resolveFile(
  cache: AssetCache,
  request: CachedImportRequest,
  file: string,
  held: Array<() => void>,
): Promise<Resolved> {
  const usage = request.usages?.get(file);
  const step = planImport(request.stack, file, usage);
  if (!runsImporter(step))
    return { done: { file, action: step.action, ...(step.refusal ? { refusal: step.refusal } : {}) } };
  const read = await readGameAsset(request.gameRoot, file, IMPORT_INPUT_MAX_BYTES);
  if (!read.ok)
    return { done: { file, action: ImportAction.Refuse, converter: step.converter, refusal: read.refusal } };
  const key = importCacheKey({
    source: sha256(read.bytes),
    converter: step.converter,
    name: path.posix.basename(file, path.posix.extname(file)),
    // An encoded texture's usage is part of what it reads: a new usage re-imports it.
    settings: request.settingsFor?.(file) ?? (step.converter === ImportConverter.TextureEncode ? { usage } : {}),
    jobVersion: IMPORT_JOB_VERSION,
    tools: request.tools,
    deps: step.converter === ImportConverter.ObjToGlb ? await objDeps(request.gameRoot, file, read.bytes) : {},
    families: texturesForTargets(request.targets),
  });
  held.push(holdEntries(cache, [key]));
  const found = await lookupEntry(cache, key);
  const line = found.ok ? parseCachedLine(found.entry.meta, found.entry.files.length) : null;
  const hit = found.ok && line ? fromLine(file, step, line, found.entry) : null;
  return hit ? { done: hit } : { miss: { file, key } };
}

/** `run` over `items`, at most `limit` at once, answers in order. */
async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (let at = next++; at < items.length; at = next++) results[at] = await run(items[at] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Commit each miss's outcome under its key; answer the outcomes with committed paths where it worked. */
async function storeMisses(
  cache: AssetCache,
  misses: readonly { at: number; file: string; key: string }[],
  job: RustAssetImportResult,
): Promise<Map<number, ImportedAsset>> {
  const stored = new Map<number, ImportedAsset>();
  for (const [index, missed] of misses.entries()) {
    const imported = job.files[index] ?? {
      file: missed.file,
      action: ImportAction.Refuse,
      refusal: AssetImportRefusal.ImporterFailed,
    };
    const line = toLine(imported);
    const entry = line ? await commitEntry(cache, missed.key, line.files, line.meta) : null;
    if (!line) await abandonEntry(cache, missed.key);
    stored.set(missed.at, entry ? withEntryPaths(imported, entry) : imported);
  }
  return stored;
}

/**
 * Import `request.files` through the cache: every file is planned and keyed, hits are served from
 * their entries, and the misses run as one importer job (`run`, `importRustAssets` by default)
 * whose outcomes are committed. Every key the build touched stays held until `release`.
 */
export async function importWithCache(
  cache: AssetCache,
  deps: RustAssetImportDeps,
  request: CachedImportRequest,
  run: typeof importRustAssets = importRustAssets,
): Promise<CachedImportResult> {
  const held: Array<() => void> = [];
  const release = () => {
    for (const free of held.splice(0)) free();
  };
  try {
    const resolved = await mapLimited(request.files, LOOKUP_CONCURRENCY, (file) =>
      resolveFile(cache, request, file, held),
    );
    const misses = resolved.flatMap((item, at) => ("miss" in item ? [{ at, ...item.miss }] : []));
    const files = new Map(resolved.flatMap((item, at) => ("done" in item ? [[at, item.done] as const] : [])));
    const ordered = () => request.files.map((_, at) => files.get(at)).filter((item) => item !== undefined);
    if (!misses.length) return { files: ordered(), hits: held.length, misses: 0, release };
    for (const missed of misses) await beginEntry(cache, missed.key);
    const job = await run(deps, { ...request, files: misses.map((missed) => missed.file) });
    for (const [at, imported] of await storeMisses(cache, misses, job)) files.set(at, imported);
    await evictEntries(cache).catch(() => null);
    return { files: ordered(), hits: held.length - misses.length, misses: misses.length, job, release };
  } catch (error) {
    release();
    throw error;
  }
}
