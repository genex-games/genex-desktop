/**
 * Seeding a developer profile's prewarm from the normal profile's: the host clones (copy-on-write
 * where the disk can) one lock folder the normal store already prewarmed into the developer
 * store's own staging, verifies every copied file against the normal store's digest manifest, and
 * swaps it in. The normal store is only ever read: nothing is written beneath it, and a developer
 * store that is the normal store, lies inside it or holds a link into it is refused before
 * anything is copied. Never the reverse: no developer output reaches a normal profile.
 *
 * The manifest (`prewarm-manifests/<digest12>.json`) is written by the host that prewarmed the
 * lock, right after its swap, and lists every folder and every file's size and sha256 under
 * `locks/<digest12>/`, with a digest over its own fields. Outputs that name the source store's
 * own path are not relocatable and are refused (`not-relocatable`): the developer profile then
 * prewarms them itself.
 */
import { createHash } from "node:crypto";
import { constants as FS } from "node:fs";
import { copyFile, lstat, mkdir, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import type { ToolchainLock } from "../../shared/toolchain.ts";
import { atomicWriteJson, isJsonObject, openNoFollow, readRegularFile, realpathNearest } from "../fsx.ts";
import { isInside } from "../paths.ts";
import { isPlainPath } from "./artifact.ts";
import { canonicalJson } from "./genex-cmake.ts";
import { LOCKS_FOLDER, lockFolderName } from "./lock.ts";

/** The store folder of prewarm manifests, one per prewarmed lock folder (`<digest12>.json`). */
export const PREWARM_MANIFESTS_FOLDER = "prewarm-manifests";
/** The staging folder a seed is cloned into, inside the developer store's own `.staging`. */
const SEED_STAGING = ".staging";
const MANIFEST_SCHEMA = 1;
/** The most of a manifest the host reads: tens of thousands of cache files fit well inside. */
const MANIFEST_MAX_BYTES = 64 * 1024 * 1024;
/** How much of a copied file is read at once while it is hashed and searched. */
const READ_CHUNK_BYTES = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

/** Why a seed was refused. Wire values (logs): never rename one. */
export const SeedRefusal = {
  /** The developer store is the normal store, or one lies inside the other. */
  SameStore: "same-store",
  /** The developer store, its `locks` or its `.staging` is a link or reaches outside itself. */
  LinkedStore: "linked-store",
  /** The normal store has no manifest for the lock (or no lock folder). */
  NoManifest: "no-manifest",
  /** The manifest's digest is not its fields'. */
  ManifestDigest: "manifest-digest",
  /** The manifest is not a manifest, or names a path that is not plain. */
  ManifestShape: "manifest-shape",
  /** The manifest is another lock's. */
  WrongLock: "wrong-lock",
  /** A link, a FIFO or another special file in the source folder. */
  NotRegular: "not-regular",
  /** The source folder holds a file the manifest does not list, or lacks one it lists. */
  Unlisted: "unlisted",
  /** A copied file's size or sha256 is not the manifest's. */
  FileDigest: "file-digest",
  /** An output names the normal store's own path, so a copy elsewhere would still use the normal store. */
  NotRelocatable: "not-relocatable",
  /** A Rust seed (`rust-seed.ts`) asked of a release build: only a developer build seeds. */
  ReleaseBuild: "release-build",
  /** A Rust seed's source store or lock file is absent. */
  NoSource: "no-source",
  /** A Rust seed's lock file is a link, not a lock, malformed or not a Rust · wgpu lock. */
  BadLock: "bad-lock",
  /** A Rust seed's lock names a component at a pin the shipped recipe does not hold. */
  Unpinned: "unpinned",
  /** The source store lacks a component the lock names, at its pin. */
  Missing: "missing",
  /** A component's tree is not its recorded digest, or its copy is not its source's. */
  TreeDigest: "tree-digest",
} as const;
export type SeedRefusal = (typeof SeedRefusal)[keyof typeof SeedRefusal];

/** A refused seed: its typed reason beside the sentence. */
export class SeedError extends Error {
  readonly refusal: SeedRefusal;

  constructor(refusal: SeedRefusal, message: string) {
    super(message);
    this.name = "SeedError";
    this.refusal = refusal;
  }
}

const MESSAGE = {
  SameStore: "The developer store is the normal profile's store, or one lies inside the other.",
  LinkedStore: (what: string) => `${what} is a link or reaches outside the developer store.`,
  NoManifest: (digest12: string) => `The normal store has no prewarm manifest for lock ${digest12}.`,
  ManifestDigest: "The prewarm manifest's digest is not its contents'.",
  ManifestShape: "The prewarm manifest does not list folders and files as a manifest does.",
  WrongLock: "The prewarm manifest is another lock's.",
  NotRegular: (rel: string) => `${rel} is a link, a FIFO or another special file.`,
  Unlisted: (rel: string) => `${rel} is not where the prewarm manifest says.`,
  FileDigest: (rel: string) => `${rel} does not match its prewarm manifest size and sha256.`,
  NotRelocatable: (rel: string) => `${rel} names the normal store's own path.`,
} as const;

/** One listed file. */
interface ManifestFile {
  size: number;
  sha256: string;
}

/** `prewarm-manifests/<digest12>.json`: what one prewarmed lock folder holds. */
export interface PrewarmManifest {
  version: typeof MANIFEST_SCHEMA;
  /** The full lock digest the folder was prewarmed for. */
  lock: string;
  /** Every folder under the lock folder, `/`-separated, parents first. */
  folders: string[];
  files: Record<string, ManifestFile>;
  /** sha256 of the canonical JSON of the fields above. */
  digest: string;
}

/** A store's manifest file for `lock`. */
export function prewarmManifestFile(store: string, lock: ToolchainLock): string {
  return path.join(store, PREWARM_MANIFESTS_FOLDER, `${lockFolderName(lock)}.json`);
}

/** The digest a manifest's fields give. */
function manifestDigest(fields: Omit<PrewarmManifest, "digest">): string {
  return createHash("sha256").update(canonicalJson(fields)).digest("hex");
}

/** Every folder and regular file under `root`, walked without following a link; a link or special file throws (`not-regular`). */
export async function walk(root: string, rel = ""): Promise<{ folders: string[]; files: string[] }> {
  const found = { folders: [] as string[], files: [] as string[] };
  const at = rel ? path.join(root, ...rel.split("/")) : root;
  for (const entry of (await readdir(at, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.folders.push(child);
      const inner = await walk(root, child);
      found.folders.push(...inner.folders);
      found.files.push(...inner.files);
    } else if (entry.isFile()) found.files.push(child);
    else throw new SeedError(SeedRefusal.NotRegular, MESSAGE.NotRegular(child));
  }
  return found;
}

/** The size and sha256 of the regular file `file`, read without following a link, and whether it holds `needles`. */
async function scan(file: string, needles: readonly Buffer[]): Promise<(ManifestFile & { names: boolean }) | null> {
  const handle = await openNoFollow(file, FS.O_RDONLY | FS.O_NONBLOCK).catch(() => null);
  if (!handle) return null;
  try {
    if (!(await handle.stat()).isFile()) return null;
    const hash = createHash("sha256");
    const keep = Math.max(0, ...needles.map((needle) => needle.length - 1));
    let tail = Buffer.alloc(0);
    let size = 0;
    let names = false;
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      size += bytesRead;
      const window = Buffer.concat([tail, chunk]);
      names ||= needles.some((needle) => window.includes(needle));
      tail = keep > 0 ? Buffer.from(window.subarray(Math.max(0, window.length - keep))) : Buffer.alloc(0);
    }
    return { size, sha256: hash.digest("hex"), names };
  } finally {
    await handle.close();
  }
}

/**
 * Writes the manifest of `store`'s prewarmed folder for `lock` (the normal profile's host, after
 * its prewarm swapped the folder in). Throws when the folder holds a link or a special file: such
 * outputs are never seeded.
 */
export async function writePrewarmManifest(store: string, lock: ToolchainLock): Promise<PrewarmManifest> {
  const folder = path.join(store, LOCKS_FOLDER, lockFolderName(lock));
  const { folders, files: names } = await walk(folder);
  const files: Record<string, ManifestFile> = {};
  for (const rel of names) {
    const found = await scan(path.join(folder, ...rel.split("/")), []);
    if (!found) throw new SeedError(SeedRefusal.NotRegular, MESSAGE.NotRegular(rel));
    files[rel] = { size: found.size, sha256: found.sha256 };
  }
  const fields = { version: MANIFEST_SCHEMA, lock: lock.digest, folders, files } as const;
  const manifest: PrewarmManifest = { ...fields, digest: manifestDigest(fields) };
  await atomicWriteJson(prewarmManifestFile(store, lock), manifest);
  return manifest;
}

/** One `files` value, shape-checked. */
const isListedFile = (value: unknown): value is ManifestFile =>
  isJsonObject(value) &&
  Number.isSafeInteger(value.size) &&
  (value.size as number) >= 0 &&
  typeof value.sha256 === "string" &&
  SHA256.test(value.sha256);

/** Whether `value` has a manifest's shape, every path plain. */
function isManifestShape(value: unknown): value is PrewarmManifest {
  if (!isJsonObject(value) || value.version !== MANIFEST_SCHEMA) return false;
  const { lock, folders, files, digest } = value;
  if (typeof lock !== "string" || typeof digest !== "string" || !Array.isArray(folders) || !isJsonObject(files))
    return false;
  const plainFolders = folders.every((rel) => typeof rel === "string" && isPlainPath(rel));
  return plainFolders && Object.entries(files).every(([rel, fact]) => isPlainPath(rel) && isListedFile(fact));
}

/** The normal store's manifest for `lock`, read without following a link and checked whole. */
async function readManifest(from: string, lock: ToolchainLock): Promise<PrewarmManifest> {
  const bytes = await readRegularFile(prewarmManifestFile(from, lock), MANIFEST_MAX_BYTES).catch(() => null);
  if (!bytes) throw new SeedError(SeedRefusal.NoManifest, MESSAGE.NoManifest(lockFolderName(lock)));
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new SeedError(SeedRefusal.ManifestShape, MESSAGE.ManifestShape);
  }
  if (!isManifestShape(parsed)) throw new SeedError(SeedRefusal.ManifestShape, MESSAGE.ManifestShape);
  const { digest, ...fields } = parsed;
  if (manifestDigest(fields) !== digest) throw new SeedError(SeedRefusal.ManifestDigest, MESSAGE.ManifestDigest);
  if (parsed.lock !== lock.digest) throw new SeedError(SeedRefusal.WrongLock, MESSAGE.WrongLock);
  return parsed;
}

/** Whether `a` and `b` overlap: one is the other or lies inside it. */
const overlaps = (a: string, b: string) => isInside(a, b) || isInside(b, a);

/**
 * The developer store's real root, after refusing one that is the normal store, overlaps it, is a
 * link itself, or has a `locks` or `.staging` that is a link or reaches outside it.
 */
export async function ownSeedStore(to: string, normal: string): Promise<string> {
  const top = await lstat(to).catch(() => null);
  if (top?.isSymbolicLink()) throw new SeedError(SeedRefusal.LinkedStore, MESSAGE.LinkedStore(to));
  // Checked before the folder is made, so a store named inside the normal one creates nothing there.
  const planned = await realpathNearest(to).catch(() => {
    throw new SeedError(SeedRefusal.LinkedStore, MESSAGE.LinkedStore(to));
  });
  if (overlaps(planned, normal) || overlaps(path.resolve(to), normal))
    throw new SeedError(SeedRefusal.SameStore, MESSAGE.SameStore);
  await mkdir(to, { recursive: true });
  const root = await realpath(to);
  if (overlaps(root, normal)) throw new SeedError(SeedRefusal.SameStore, MESSAGE.SameStore);
  for (const name of [LOCKS_FOLDER, SEED_STAGING]) {
    const at = path.join(root, name);
    const info = await lstat(at).catch(() => null);
    if (!info) continue;
    const real = await realpath(at).catch(() => at);
    const contained = info.isDirectory() && !info.isSymbolicLink() && isInside(root, real) && !overlaps(real, normal);
    if (!contained) throw new SeedError(SeedRefusal.LinkedStore, MESSAGE.LinkedStore(at));
  }
  return root;
}

/** Refuses a source folder that does not hold exactly the manifest's files and folders. */
async function assertSourceListed(source: string, manifest: PrewarmManifest): Promise<void> {
  const info = await lstat(source).catch(() => null);
  if (!info?.isDirectory()) throw new SeedError(SeedRefusal.NoManifest, MESSAGE.NoManifest(path.basename(source)));
  const { folders, files } = await walk(source);
  const listed = new Set(Object.keys(manifest.files));
  const extra = files.find((rel) => !listed.has(rel)) ?? folders.find((rel) => !manifest.folders.includes(rel));
  if (extra !== undefined) throw new SeedError(SeedRefusal.Unlisted, MESSAGE.Unlisted(extra));
  const present = new Set(files);
  const missing = [...listed].find((rel) => !present.has(rel));
  if (missing !== undefined) throw new SeedError(SeedRefusal.Unlisted, MESSAGE.Unlisted(missing));
}

/** Clones each listed file into `staging` and holds the copy to its listed size and sha256 and to relocatability. */
async function cloneVerified(
  source: string,
  staging: string,
  manifest: PrewarmManifest,
  needles: readonly Buffer[],
): Promise<void> {
  for (const rel of manifest.folders) await mkdir(path.join(staging, ...rel.split("/")), { recursive: true });
  for (const [rel, listed] of Object.entries(manifest.files)) {
    const to = path.join(staging, ...rel.split("/"));
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(path.join(source, ...rel.split("/")), to, FS.COPYFILE_EXCL | FS.COPYFILE_FICLONE);
    const copied = await scan(to, needles);
    if (!copied) throw new SeedError(SeedRefusal.NotRegular, MESSAGE.NotRegular(rel));
    if (copied.size !== listed.size || copied.sha256 !== listed.sha256)
      throw new SeedError(SeedRefusal.FileDigest, MESSAGE.FileDigest(rel));
    if (copied.names) throw new SeedError(SeedRefusal.NotRelocatable, MESSAGE.NotRelocatable(rel));
  }
}

/** What a seed did: whether it added the lock folder, and where that folder is. */
export interface SeedResult {
  seeded: boolean;
  folder: string;
}

/**
 * Seeds `to` (a developer profile's store) with the prewarm outputs `from` (the normal profile's
 * store) holds for `lock`: refused, typed ({@link SeedError}), with nothing added to `to` and
 * nothing written to `from`, when the stores overlap or link into each other, when the manifest is
 * missing, malformed, another lock's or not its own digest's, when the source folder holds a link,
 * an unlisted file or lacks a listed one, or when a copy differs or names the normal store. A lock
 * folder `to` already holds is kept as it is (`seeded: false`).
 */
export async function seedPrewarm(options: { from: string; to: string; lock: ToolchainLock }): Promise<SeedResult> {
  const { lock } = options;
  const normal = await realpath(options.from).catch(() => null);
  if (!normal) throw new SeedError(SeedRefusal.NoManifest, MESSAGE.NoManifest(lockFolderName(lock)));
  const root = await ownSeedStore(options.to, normal);
  const folder = path.join(root, LOCKS_FOLDER, lockFolderName(lock));
  if (await lstat(folder).catch(() => null)) return { seeded: false, folder };
  const manifest = await readManifest(normal, lock);
  const source = path.join(normal, LOCKS_FOLDER, lockFolderName(lock));
  await assertSourceListed(source, manifest);
  const staging = path.join(root, SEED_STAGING, `seed-${lock.digest}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    const needles = [...new Set([normal, path.resolve(options.from)])].map((spelling) => Buffer.from(spelling));
    await cloneVerified(source, staging, manifest, needles);
    await mkdir(path.join(root, LOCKS_FOLDER), { recursive: true });
    await rename(staging, folder);
    return { seeded: true, folder };
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rmdir(path.join(root, SEED_STAGING)).catch(() => {});
  }
}
