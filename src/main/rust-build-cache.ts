/**
 * How the Rust lane's build folders share a game's compiled engine, and which of them the sweep
 * removes (`rust-build.ts` keeps the builds; this module keeps the folders).
 *
 * Every source folder of a game (the game folder, each worker worktree, each Play-latest and
 * playtest copy, the integration copy) has a build folder of its own, keyed by its real path:
 * `<root>/<game>-<sha12(source)>/<target>-<lock12>`. Cargo's units for the engine and its
 * dependencies are the same in all of them (a vendored crate's unit is keyed by its package, never
 * the folder that builds it; the game crate itself always recompiles, its stage is written fresh),
 * so a copy's first build need not compile them again:
 *
 * - Where the filesystem clones copy-on-write (APFS's `clonefile`, btrfs's and XFS's reflinks:
 *   `substrate/clone-tree.ts`), a new build folder's target is cloned from the freshest idle build
 *   of the same game, destination and lock ({@link idleDonors}): the clone costs no blocks until
 *   cargo rewrites a file, and the copies keep building in parallel.
 * - Where it does not (NTFS, ext4, and every Windows host: Node exposes no ReFS block cloning),
 *   every copy of a game builds a destination and lock in one shared target folder
 *   ({@link sharedTargetDir}), and the lane builds that game's copies one at a time.
 *
 * The sweep ({@link sweepProject}, {@link sweepShared}) removes a build folder whose source folder
 * is gone or whose lock nothing keeps (neither the current lock nor a game's recorded one the store
 * still holds), never one in use, and nothing outside the lane's root; a shared target goes once no
 * copy's build folder names it, so a stale lock's goes in the same sweep as its copies' folders.
 */
import { lstat, mkdir, readdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { HOUR_MS } from "../shared/duration.ts";
import type { TreeCloner } from "../substrate/clone-tree.ts";
import { readRegularFile } from "../substrate/fsx.ts";
import { isInside } from "../substrate/paths.ts";
import { isWindowsSafeName } from "../substrate/windows-names.ts";

/** How a host's Rust builds share compiled dependencies. Never rename a value: receipts carry it. */
export const RustTargetSharing = {
  /** Each build folder has its own target, a new one cloned copy-on-write from a sibling copy's. */
  Clone: "clone",
  /** Every copy of a game builds a destination and lock in one target folder, one build at a time. */
  Shared: "shared",
} as const;
export type RustTargetSharing = (typeof RustTargetSharing)[keyof typeof RustTargetSharing];

/** Where a build's target folder came from. Never rename a value: receipts carry it. */
export const RustTargetSeed = {
  /** The folder's own target from an earlier build (or the shared one), built on incrementally. */
  Kept: "kept",
  /** A copy-on-write clone of another copy's target: same game, destination and lock. */
  Copy: "copy",
  /** A clone of the store's prewarmed target for the lock and destination. */
  Prewarm: "prewarm",
  /** An empty target: every dependency compiles. */
  Cold: "cold",
} as const;
export type RustTargetSeed = (typeof RustTargetSeed)[keyof typeof RustTargetSeed];

/** The folder every shared target of the lane's root lives in. */
export const RUST_SHARED_FOLDER = "shared";
/** A game's folder of shared targets: `<game><suffix>`, a name no build folder of a game has. */
const SHARED_SUFFIX = "-targets";
/**
 * How long a build folder with no readable source stamp is left alone: one being made right now,
 * or by another lane on the same root, has none yet; one a crash left goes after this.
 */
export const UNSTAMPED_GRACE_MS = 6 * HOUR_MS;
/** The largest source stamp read. */
const STAMP_MAX_BYTES = 64 * 1024;
/** A game's build folder: `<game>-<sha12(source)>`. */
const PROJECT_FOLDER = /^(.+)-[0-9a-f]{12}$/;
/** A destination and lock's build folder: `<target>-<lock12>`. */
const BUILD_FOLDER = /^([a-z]+)-([0-9a-f]{12})$/;
/** Siblings named after a build folder (`<bin>.source`, `.out`, `.stage`…) are `<bin>` plus this. */
const SIBLING_DOT = ".";
/** The build folder's admitted output beside it, which a preview serves. */
const OUT_SUFFIX = ".out";
/** The host's stamp naming the source folder a build folder was made for. */
const SOURCE_SUFFIX = ".source";

/**
 * Whether builds in `root` clone copy-on-write: the host's cloner says so for the root (made
 * first); a host with none (Windows), or one that cannot say, shares.
 */
export async function rustTargetSharing(root: string, cloner: TreeCloner | null): Promise<RustTargetSharing> {
  if (cloner === null) return RustTargetSharing.Shared;
  try {
    await mkdir(root, { recursive: true });
    return (await cloner.supported(root)) ? RustTargetSharing.Clone : RustTargetSharing.Shared;
  } catch {
    return RustTargetSharing.Shared;
  }
}

/**
 * The one target folder every copy of the game whose build folders are named `<folder>-…` builds
 * `build` (`<target>-<lock12>`) in, on a host that cannot clone: `<root>/shared/<folder>-targets/<build>`.
 * Null for a game with no name of its own (`folder` null), whose copies never share.
 */
export function sharedTargetDir(root: string, folder: string | null, build: string): string | null {
  if (folder === null) return null;
  const name = `${folder}${SHARED_SUFFIX}`;
  if (!isWindowsSafeName(name) || !BUILD_FOLDER.test(build)) return null;
  return path.join(path.resolve(root), RUST_SHARED_FOLDER, name, build);
}

/** What {@link idleDonors} looks for: the new build folder, its game's folder name, and the lane's state. */
export interface DonorQuery {
  root: string;
  /** The build folder that needs a target: `<root>/<folder>-<sha12>/<target>-<lock12>`. */
  bin: string;
  /** The game's folder name every copy's build folder starts with. */
  folder: string;
  /** The lane's target folder of a build folder. */
  targetOf: (bin: string) => string;
  /** The stamp a build folder has once a build of it was admitted. */
  admittedOf: (bin: string) => string;
  /** Whether a build of that folder runs or waits now. */
  busy: (bin: string) => boolean;
}

/**
 * The build folders of the other copies of the same game, destination and lock whose target a new
 * one may clone, the most recently admitted first: each idle, a real folder with a real target,
 * reached through no link. A new folder takes the first whose clone succeeds, so one donor whose
 * target cannot clone (a link cargo left in it) does not send every new copy to the prewarm.
 */
export async function idleDonors(query: DonorQuery): Promise<string[]> {
  const root = path.resolve(query.root);
  const own = path.dirname(path.resolve(query.bin));
  const build = path.basename(query.bin);
  const found: { bin: string; at: number }[] = [];
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const project = path.join(root, name);
    if (!copyOfGame(name, query.folder) || project === own) continue;
    const bin = path.join(project, build);
    const at = await donorAdmittedAt(bin, project, query);
    if (at !== null) found.push({ bin, at });
  }
  return found.sort((a, b) => b.at - a.at).map((donor) => donor.bin);
}

/** Whether `name` is a build folder of a copy of the game named `folder`: `<folder>-<12 hex>`, exactly. */
function copyOfGame(name: string, folder: string): boolean {
  return PROJECT_FOLDER.exec(name)?.[1] === folder;
}

/** When the donor's last build was admitted, or null when it is busy, never admitted, or reached through a link. */
async function donorAdmittedAt(bin: string, project: string, query: DonorQuery): Promise<number | null> {
  if (query.busy(bin)) return null;
  const folders = [project, bin, query.targetOf(bin)];
  const found = await Promise.all(folders.map((dir) => lstat(dir).catch(() => null)));
  if (!found.every((info) => info?.isDirectory())) return null;
  const stamp = await lstat(query.admittedOf(bin)).catch(() => null);
  return stamp?.isFile() ? stamp.mtimeMs : null;
}

/** What the sweep must leave whatever its stamps say. */
export interface SweepGuard {
  /** The lock digests' first 12 characters whose folders stay; null: none goes for its lock alone. */
  keep: ReadonlySet<string> | null;
  /** Whether a build of that build folder runs, waits, or lends its target now. */
  busy: (bin: string) => boolean;
  /** Folders the app serves from now (a preview's `<bin>.out`): a build folder serving one stays. */
  served: readonly string[];
  /** The sweep's clock, for {@link UNSTAMPED_GRACE_MS}. */
  now: number;
}

/** A build folder's source, as the host's stamp beside it names it. */
const SourceState = { There: "there", Gone: "gone", Unknown: "unknown" } as const;
type SourceState = (typeof SourceState)[keyof typeof SourceState];

/**
 * One game folder's sweep: each build folder whose source is gone (or unknown past the grace) or
 * whose lock `keep` does not name goes, with everything named after it beside it, unless it is
 * busy or served. A folder that cannot be removed (a Windows file lock, a permission) is skipped,
 * its stamp kept for the next sweep. An empty game folder goes too. Answers how many went.
 */
export async function sweepProject(project: string, guard: SweepGuard): Promise<number> {
  let removed = 0;
  const names = await readdir(project).catch(() => [] as string[]);
  for (const name of names) {
    const digest = BUILD_FOLDER.exec(name)?.[2];
    if (!digest) continue;
    const bin = path.join(project, name);
    if (!(await sweepable(bin, digest, guard))) continue;
    if (await removeBuild(project, name, names)) removed++;
  }
  await rmdir(project).catch(() => {});
  return removed;
}

/** Whether the sweep may remove the build folder `bin` of the lock `digest`. */
async function sweepable(bin: string, digest: string, guard: SweepGuard): Promise<boolean> {
  if (guard.busy(bin) || servedFrom(bin, guard.served)) return false;
  const oldLock = guard.keep !== null && !guard.keep.has(digest);
  const source = await sourceState(bin);
  if (source === SourceState.Unknown) return !(await youngerThanGrace(bin, guard.now));
  return oldLock || source === SourceState.Gone;
}

/** Whether a served folder is the build folder or its admitted output (`<bin>.out`), or lies inside either. */
function servedFrom(bin: string, served: readonly string[]): boolean {
  return served.some((dir) => isInside(bin, dir) || isInside(`${bin}${OUT_SUFFIX}`, dir));
}

/** The build folder's source: there, gone, or unknown (no readable stamp, or no real folder). */
async function sourceState(bin: string): Promise<SourceState> {
  if (!(await lstat(bin).catch(() => null))?.isDirectory()) return SourceState.Unknown;
  const stamp = await readRegularFile(`${bin}${SOURCE_SUFFIX}`, STAMP_MAX_BYTES).catch(() => null);
  if (!stamp?.length) return SourceState.Unknown;
  const there = (await lstat(stamp.toString("utf8")).catch(() => null)) !== null;
  return there ? SourceState.There : SourceState.Gone;
}

/** Whether `bin` (the entry itself, never through a link) changed within the grace. */
async function youngerThanGrace(bin: string, now: number): Promise<boolean> {
  const info = await lstat(bin).catch(() => null);
  return info !== null && now - info.mtimeMs < UNSTAMPED_GRACE_MS;
}

/**
 * Removes the build folder `name` of `project` and every sibling named after it, the source stamp
 * last, each entry itself (a link is removed, never followed). False when any part stays.
 */
async function removeBuild(project: string, name: string, names: readonly string[]): Promise<boolean> {
  const stamp = `${name}${SOURCE_SUFFIX}`;
  const parts = names.filter((other) => other === name || other.startsWith(`${name}${SIBLING_DOT}`));
  const ordered = [...parts.filter((part) => part !== stamp), ...parts.filter((part) => part === stamp)];
  for (const part of ordered) {
    if (!(await removeEntry(path.join(project, part)))) return false;
  }
  return true;
}

/**
 * The shared targets' sweep: a game's shared target for a destination and lock goes once no copy
 * of the game has that build folder and no build holds it. Nothing is followed through a link.
 */
export async function sweepShared(root: string, held: (dir: string) => boolean): Promise<number> {
  const shared = path.join(path.resolve(root), RUST_SHARED_FOLDER);
  if (!(await lstat(shared).catch(() => null))?.isDirectory()) return 0;
  const projects = await readdir(path.resolve(root)).catch(() => [] as string[]);
  let removed = 0;
  for (const name of await readdir(shared).catch(() => [] as string[])) {
    const game = path.join(shared, name);
    if (!name.endsWith(SHARED_SUFFIX) || !(await lstat(game).catch(() => null))?.isDirectory()) continue;
    const folder = name.slice(0, -SHARED_SUFFIX.length);
    const copies = projects.filter((project) => copyOfGame(project, folder));
    removed += await sweepGameShared(root, game, copies, held);
  }
  await rmdir(shared).catch(() => {});
  return removed;
}

/** One game's shared targets: each that no copy in `copies` builds and no build holds goes; then the empty folder. */
async function sweepGameShared(
  root: string,
  game: string,
  copies: readonly string[],
  held: (dir: string) => boolean,
): Promise<number> {
  let removed = 0;
  for (const build of await readdir(game).catch(() => [] as string[])) {
    const dir = path.join(game, build);
    if (!BUILD_FOLDER.test(build) || held(dir) || (await anyCopyBuilds(root, copies, build))) continue;
    if (await removeEntry(dir)) removed++;
  }
  await rmdir(game).catch(() => {});
  return removed;
}

/** Removes `dir` (the entry itself, never through a link); false when any of it stays. */
async function removeEntry(dir: string): Promise<boolean> {
  return await rm(dir, { recursive: true, force: true }).then(
    () => true,
    () => false,
  );
}

/** Whether any of a game's copies has the build folder `build` (a real folder or anything else at its name). */
async function anyCopyBuilds(root: string, copies: readonly string[], build: string): Promise<boolean> {
  const found = await Promise.all(copies.map((project) => lstat(path.join(root, project, build)).catch(() => null)));
  return found.some((info) => info !== null);
}
