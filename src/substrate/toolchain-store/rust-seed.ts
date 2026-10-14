/**
 * Seeding a developer profile's Rust · wgpu components from a local Rust store: the developer's
 * dev store (`scripts/toolchains/dev-store.ts --stack rust-wgpu`, its vendored set the genex crates
 * of this checkout or of a locally cut release), so a Rust game builds in an owned `studio:dev`
 * profile before any `genex` release is published. The host (`ToolchainService.seedRust`) then
 * assembles the base and prewarms in the profile's own store; only a developer build seeds.
 *
 * - The lock is read from a plain file (never through a link) and must be a well-formed Rust ·
 *   wgpu lock. Every component it names, except the vendored set, must be at the shipped recipe's
 *   pin (`rust-recipe.json`); the vendored set is held to the tree digest its install recorded.
 * - Each component is located in the source store by its receipt, refused when its folder or
 *   anything under it is a link or a special file, and digested (`treeDigest`) before any copy.
 * - Copies are clones where the disk can (`COPYFILE_FICLONE`) into the target store's own
 *   `.staging`, held to the source's digest (and the vendored tree to its recorded one), then
 *   renamed into place. A component the target already holds at its pin is kept as it is.
 * - The source is only read. Every refusal is typed (`SeedError`, `SeedRefusal`) and comes before
 *   anything is added to the target: the stores overlapping or linking into each other, the target
 *   being a store the caller forbids (the normal profile's), a bad lock, an unpinned component, a
 *   missing one, a link, or a digest that is not the recorded one.
 */
import { constants as FS } from "node:fs";
import { copyFile, lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { GameStack } from "../../shared/game-project.ts";
import {
  type ToolchainEntry,
  ToolchainError,
  type ToolchainHost,
  ToolchainId,
  type ToolchainLock,
} from "../../shared/toolchain.ts";
import { readRegularFile } from "../fsx.ts";
import { isInside } from "../paths.ts";
import { type TreeDigest, treeDigest } from "./archive.ts";
import { removeEmptyStaging, STAGING_FOLDER } from "./install.ts";
import { componentFolder, locateComponents } from "./locate.ts";
import { isToolchainLock } from "./lock.ts";
import { entrySha12, manifestEntry } from "./manifest.ts";
import { ownSeedStore, SeedError, SeedRefusal, walk } from "./prewarm-seed.ts";
import { stackOfLock } from "./retention.ts";
import { checkedVendorTree, verifyVendorTree } from "./rust-install.ts";

/** The most of a lock file the seed reads: a lock is a few hundred bytes. */
const LOCK_FILE_MAX_BYTES = 64 * 1024;
/** The staging folder one seed clones into, inside the target store's `.staging`. */
const SEED_STAGING_PREFIX = "seed-rust-";

const MESSAGE = {
  NoLockFile: (file: string) => `${file} is not a plain lock file (absent, a link or not a regular file).`,
  BadLock: (file: string) => `${file} is not a well-formed Rust · wgpu toolchain lock.`,
  NoSource: (store: string) => `The Rust store ${store} does not exist.`,
  Forbidden: (store: string) => `${store} is a store this seed must never write.`,
  Unpinned: (id: string) => `The lock names ${id} at a pin the shipped Rust recipe does not hold.`,
  Missing: (ids: readonly string[]) => `The source store is missing ${ids.join(", ")} at the lock's pins.`,
  Linked: (rel: string) => `${rel} in the source store is a link or reaches outside it.`,
  TargetLinked: (rel: string) => `${rel} in the target store is a link or not a folder.`,
  NotRegular: (detail: string) => `A component holds a link or a special file: ${detail}`,
  CopyDiffers: (id: string) => `The copy of ${id} is not the source's tree.`,
  VendorTree: (detail: string) => `The vendored crate set is not its recorded tree: ${detail}`,
} as const;

/** How a developer profile's Rust seed ended (`ToolchainService.seedRust`). Wire values (logs): never rename one. */
export const RustSeedPhase = {
  /** The components, base and prewarms were seeded and the lock made current. */
  Seeded: "seeded",
  /** The profile's store already builds the lock: nothing was done. */
  Current: "current",
  /** Refused, typed (`SeedRefusal`), with nothing added to the profile's store. */
  Refused: "refused",
  /** The components were seeded but the base failed (a typed `ToolchainProblem`); the next seed tries again. */
  Failed: "failed",
} as const;
export type RustSeedPhase = (typeof RustSeedPhase)[keyof typeof RustSeedPhase];

/** The pinned recipe entry for one component on a host; the shipped recipe's by default (a test stands one in). */
export type RustPinOf = (id: ToolchainId, host: ToolchainHost) => ToolchainEntry | null;

/** What a Rust seed is given. */
export interface RustSeedOptions {
  /** The source store, read only. */
  from: string;
  /** The developer profile's store. */
  to: string;
  lock: ToolchainLock;
  /** This computer's toolchain host: the recipe pins are its. */
  host: ToolchainHost;
  /** Stores the seed must never write, however spelled (the normal profile's). */
  forbidden?: readonly string[];
  pinOf?: RustPinOf;
}

/** What a seed did: the components it copied, and those the target already held. */
export interface RustSeedResult {
  copied: ToolchainId[];
  kept: ToolchainId[];
}

/** One component to seed: where it is in the source, and its source digest. */
interface SourceComponent {
  id: ToolchainId;
  pin: { version: string; sha12: string };
  folder: string;
  tree: TreeDigest;
  /** The vendored set's recorded tree digest, which its copy is held to again. */
  vendorTree: TreeDigest | null;
}

/**
 * The Rust lock in `file`: read as a plain file (never through a link, never a FIFO), at most a
 * few kilobytes, a well-formed lock whose digest is its entries' and whose stack is Rust · wgpu.
 * Refused `no-source` when absent or not a regular file, `bad-lock` otherwise.
 */
export async function readSeedLock(file: string): Promise<ToolchainLock> {
  const bytes = await readRegularFile(file, LOCK_FILE_MAX_BYTES).catch(() => null);
  if (!bytes) throw new SeedError(SeedRefusal.NoSource, MESSAGE.NoLockFile(file));
  let value: unknown = null;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new SeedError(SeedRefusal.BadLock, MESSAGE.BadLock(file));
  }
  if (!isRustLock(value)) throw new SeedError(SeedRefusal.BadLock, MESSAGE.BadLock(file));
  return value;
}

/** Whether `value` is a well-formed Rust · wgpu lock that names the vendored set. */
function isRustLock(value: unknown): value is ToolchainLock {
  if (!isToolchainLock(value) || stackOfLock(value) !== GameStack.RustWgpu) return false;
  return value.entries[ToolchainId.RustVendor] !== undefined;
}

/** Refuses a lock that is not a Rust · wgpu lock naming the vendored set, or that names a component off the recipe's pins. */
function assertPinned(lock: ToolchainLock, host: ToolchainHost, pinOf: RustPinOf): void {
  if (!isRustLock(lock)) throw new SeedError(SeedRefusal.BadLock, MESSAGE.BadLock("the lock"));
  for (const [id, pin] of Object.entries(lock.entries) as Array<[ToolchainId, { version: string; sha12: string }]>) {
    if (id === ToolchainId.RustVendor) continue;
    const entry = pinOf(id, host);
    const pinned = entry !== null && entry.version === pin.version && entrySha12(entry) === pin.sha12;
    if (!pinned) throw new SeedError(SeedRefusal.Unpinned, MESSAGE.Unpinned(id));
  }
}

/** `folder`'s real path when it is exactly where it is spelled under `root` (no link on the way), else a refusal. */
async function plainFolderUnder(root: string, folder: string): Promise<string> {
  const rel = path.relative(root, folder);
  const info = await lstat(folder).catch(() => null);
  const real = info?.isDirectory() ? await realpath(folder).catch(() => null) : null;
  if (!real || real !== path.join(root, rel)) throw new SeedError(SeedRefusal.NotRegular, MESSAGE.Linked(rel));
  return real;
}

/** A tree's digest, a link or special file in it refused `not-regular`. */
async function digestOf(folder: string): Promise<TreeDigest> {
  try {
    return await treeDigest(folder);
  } catch (error) {
    if (error instanceof ToolchainError) throw new SeedError(SeedRefusal.NotRegular, MESSAGE.NotRegular(error.message));
    throw error;
  }
}

/** The vendored set's recorded tree, the source's own tree held to it. */
async function recordedVendorTree(folder: string): Promise<TreeDigest> {
  try {
    return await checkedVendorTree(folder);
  } catch (error) {
    if (error instanceof ToolchainError) throw new SeedError(SeedRefusal.TreeDigest, MESSAGE.VendorTree(error.message));
    throw error;
  }
}

/** Every component of `lock` in the source store, checked and digested; nothing is written. */
async function sourceComponents(source: string, lock: ToolchainLock): Promise<SourceComponent[]> {
  const ids = Object.keys(lock.entries) as ToolchainId[];
  const found = await locateComponents(source, lock, ids);
  if (!found.ok) throw new SeedError(SeedRefusal.Missing, MESSAGE.Missing(found.missing));
  const components: SourceComponent[] = [];
  for (const id of ids) {
    const pin = lock.entries[id];
    const located = found.components.get(id);
    if (!pin || !located) throw new SeedError(SeedRefusal.Missing, MESSAGE.Missing([id]));
    await plainFolderUnder(source, path.dirname(located.folder));
    const folder = await plainFolderUnder(source, located.folder);
    const vendorTree = id === ToolchainId.RustVendor ? await recordedVendorTree(folder) : null;
    components.push({ id, pin, folder, tree: await digestOf(folder), vendorTree });
  }
  return components;
}

/** Refuses a target store that is, holds or lies inside a forbidden store. */
async function assertAllowed(to: string, forbidden: readonly string[]): Promise<void> {
  const target = path.resolve(to);
  const realTarget = await realpath(to).catch(() => target);
  for (const store of forbidden) {
    const spellings = [path.resolve(store), await realpath(store).catch(() => path.resolve(store))];
    const overlaps = spellings.some((spelled) =>
      [target, realTarget].some((own) => isInside(own, spelled) || isInside(spelled, own)),
    );
    if (overlaps) throw new SeedError(SeedRefusal.SameStore, MESSAGE.Forbidden(to));
  }
}

/** Refuses an id folder in the target that is a link or not a folder (a rename would follow it out). */
async function assertTargetFolders(root: string, ids: readonly ToolchainId[]): Promise<void> {
  for (const id of ids) {
    const info = await lstat(path.join(root, id)).catch(() => null);
    if (info && (info.isSymbolicLink() || !info.isDirectory()))
      throw new SeedError(SeedRefusal.LinkedStore, MESSAGE.TargetLinked(id));
  }
}

/** Whether the target already holds `component` at its pin, with its tree the source's. */
async function holdsAlready(root: string, component: SourceComponent): Promise<boolean> {
  const folder = componentFolder(root, component.id, component.pin);
  const info = await lstat(folder).catch(() => null);
  if (!info?.isDirectory()) return false;
  const tree = await treeDigest(folder).catch(() => null);
  return tree !== null && tree.sha256 === component.tree.sha256 && tree.files === component.tree.files;
}

/** Clones `component` into `staging`, file by file (never a link), and holds the copy to its source's digest. */
async function cloneVerified(component: SourceComponent, staging: string): Promise<void> {
  const { folders, files } = await walk(component.folder);
  await mkdir(staging, { recursive: true });
  for (const rel of folders) await mkdir(path.join(staging, ...rel.split("/")), { recursive: true });
  for (const rel of files)
    await copyFile(
      path.join(component.folder, ...rel.split("/")),
      path.join(staging, ...rel.split("/")),
      FS.COPYFILE_EXCL | FS.COPYFILE_FICLONE,
    );
  const copied = await digestOf(staging);
  const same = copied.sha256 === component.tree.sha256 && copied.files === component.tree.files;
  if (!same) throw new SeedError(SeedRefusal.TreeDigest, MESSAGE.CopyDiffers(component.id));
  if (!component.vendorTree) return;
  try {
    await verifyVendorTree(staging, component.vendorTree);
  } catch (error) {
    if (error instanceof ToolchainError) throw new SeedError(SeedRefusal.TreeDigest, MESSAGE.VendorTree(error.message));
    throw error;
  }
}

/**
 * Clones every component the target lacks into `staging` and verifies each, then renames them all
 * into place: a copy that differs leaves the target as it was.
 */
async function copyComponents(root: string, components: readonly SourceComponent[], staging: string) {
  const result: RustSeedResult = { copied: [], kept: [] };
  const missing: SourceComponent[] = [];
  for (const component of components) {
    if (await holdsAlready(root, component)) result.kept.push(component.id);
    else missing.push(component);
  }
  for (const component of missing) await cloneVerified(component, path.join(staging, component.id));
  for (const component of missing) {
    const final = componentFolder(root, component.id, component.pin);
    await mkdir(path.dirname(final), { recursive: true });
    await rm(final, { recursive: true, force: true });
    await rename(path.join(staging, component.id), final);
    result.copied.push(component.id);
  }
  return result;
}

/**
 * Seeds `to` with every component `lock` names from the store `from` (read only), each verified as
 * the module header says; refused, typed, with nothing added to `to` when any check fails. The
 * caller assembles the base, prewarms and writes the current lock.
 */
export async function seedRustComponents(options: RustSeedOptions): Promise<RustSeedResult> {
  const { lock, host, forbidden = [], pinOf = manifestEntry } = options;
  assertPinned(lock, host, pinOf);
  const source = await realpath(options.from).catch(() => null);
  if (!source) throw new SeedError(SeedRefusal.NoSource, MESSAGE.NoSource(options.from));
  await assertAllowed(options.to, [...forbidden]);
  const components = await sourceComponents(source, lock);
  const root = await ownSeedStore(options.to, source);
  await assertAllowed(root, [...forbidden]);
  await assertTargetFolders(
    root,
    components.map((component) => component.id),
  );
  const staging = path.join(root, STAGING_FOLDER, `${SEED_STAGING_PREFIX}${lock.digest.slice(0, 12)}`);
  await rm(staging, { recursive: true, force: true });
  try {
    return await copyComponents(root, components, staging);
  } finally {
    await rm(staging, { recursive: true, force: true });
    await removeEmptyStaging(root);
  }
}
