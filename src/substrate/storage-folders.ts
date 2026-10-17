/**
 * Genex's own folders beside the person's games — shown builds' copies, finished runs' folders and
 * pictures — as freeing space reads and deletes them: measured on disk without following a link,
 * listed one level under a root Genex owns, and deleted one child at a time. A link is never
 * followed, measured or deleted through, and a root reached through a link lists nothing.
 */
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

/** How many entries one step of a measure reads at once. */
const MEASURE_BATCH = 64;
/** The unit `Stats.blocks` counts in. */
const BLOCK_BYTES = 512;

/** A folder directly under an owned root: its own name and its path through the root's real path. */
export interface OwnedFolder {
  name: string;
  dir: string;
  /** When its entries last changed, in ms since the epoch. */
  changedAt: number;
}

/** Whether `name` names one entry of a folder: not empty, `.`, `..` or a path. */
function isPlainSegment(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && path.basename(name) === name;
}

/** The space one entry takes on disk: its blocks where the platform counts them, else its size. */
function onDisk(stats: Stats): number {
  return Number.isFinite(stats.blocks) && stats.blocks > 0 ? stats.blocks * BLOCK_BYTES : stats.size;
}

/** A measure in progress: the files counted by identity, and the bytes so far. */
interface Tally {
  seen: Set<string>;
  bytes: number;
}

/** Count one entry into `tally` and say what is inside it to measure next (nothing for a file or a link). */
async function visit(entry: string, tally: Tally): Promise<string[]> {
  const stats = await lstat(entry).catch(() => null);
  if (!stats) return [];
  if (stats.nlink > 1 && !stats.isDirectory()) {
    const key = `${stats.dev}:${stats.ino}`;
    if (tally.seen.has(key)) return [];
    tally.seen.add(key);
  }
  tally.bytes += onDisk(stats);
  if (!stats.isDirectory()) return [];
  return (await readdir(entry).catch(() => [] as string[])).map((name) => path.join(entry, name));
}

/**
 * The space `dir` and everything under it take on disk, in bytes. A link counts as itself and is
 * never followed; a file with several names counts once.
 */
export async function diskBytes(dir: string): Promise<number> {
  const tally: Tally = { seen: new Set(), bytes: 0 };
  let level = [dir];
  while (level.length > 0) {
    const next: string[] = [];
    for (let at = 0; at < level.length; at += MEASURE_BATCH) {
      const batch = level.slice(at, at + MEASURE_BATCH);
      for (const inside of await Promise.all(batch.map((entry) => visit(entry, tally)))) next.push(...inside);
    }
    level = next;
  }
  return tally.bytes;
}

/**
 * `root/parts…` by real path when every part below `root` is a folder of its own, not a link: null
 * when it is missing or any part is a link. `root` is Genex's (the scratch or runs folder); a
 * folder below it may have been made by an agent, which could leave a link in its place.
 */
async function ownedRoot(root: string, parts: readonly string[]): Promise<string | null> {
  let current = await realpath(root).catch(() => null);
  for (const part of parts) {
    if (!current) return null;
    current = path.join(current, part);
    const stats = await lstat(current).catch(() => null);
    if (!stats?.isDirectory()) return null;
  }
  return current;
}

/** The folders directly under `root/parts…` (never a link or a file), or none when it is not Genex's own. */
export async function ownedFolders(root: string, parts: readonly string[] = []): Promise<OwnedFolder[]> {
  const base = await ownedRoot(root, parts);
  if (!base) return [];
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  const folders: OwnedFolder[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);
    const stats = await lstat(dir).catch(() => null);
    if (stats?.isDirectory()) folders.push({ name: entry.name, dir, changedAt: stats.mtimeMs });
  }
  return folders;
}

/**
 * Delete `name`, a folder directly under `root/parts…`, and say how much space it took. Nothing
 * happens to a link, a file, a name that is not one plain segment, or a folder whose root is no
 * longer Genex's own.
 */
export async function removeOwnedFolder(root: string, parts: readonly string[], name: string): Promise<number> {
  if (!isPlainSegment(name)) return 0;
  const base = await ownedRoot(root, parts);
  if (!base) return 0;
  const dir = path.join(base, name);
  const stats = await lstat(dir).catch(() => null);
  if (!stats?.isDirectory()) return 0;
  const bytes = await diskBytes(dir);
  // `rm` unlinks a link it meets and never follows it, so a link swapped in now deletes only itself.
  await rm(dir, { recursive: true, force: true });
  return bytes;
}
