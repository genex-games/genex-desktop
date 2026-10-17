/**
 * A builder's copy of the game's C++ Source folder against the game's own, for the gate: a part
 * changes only its own C++ folder, since only that folder lands in the game, and a copy that
 * compiles with other changes would not compile there. A builder writes the copy, so the walk
 * never follows a link (a link counts as itself), is capped, and only reads files of equal size to
 * compare them. Nothing here writes.
 */
import { lstat, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { readRegularFile } from "../../substrate/fsx.ts";

/** How much of a Source folder is compared: entries, folder depth and the largest file read. */
const MAX_ENTRIES = 5000;
const MAX_DEPTH = 8;
const MAX_COMPARE_BYTES = 1024 * 1024;
/** The most changed paths named; the first ones say enough. */
const MAX_NAMED = 20;
/** What Finder leaves in any folder it showed; never compared or read. */
export const FINDER_FILE = ".DS_Store";
/** What a walk reports when the copy has more entries than it compares: the whole Source. */
const WHOLE_TREE = "";
/**
 * What the open editor or a build writes into the game and its .gitignore leaves out, so a builder's
 * copy (a git worktree) never has it: Python caches anywhere, and a plugin's own build folders.
 */
const PYTHON_CACHE = "__pycache__";
const PYTHON_COMPILED = ".pyc";
const PLUGIN_BUILD_FOLDERS: ReadonlySet<string> = new Set(["Intermediate", "Binaries"]);

/** One entry of a tree: a file by its size and when it was written, a link by its target, anything else by its kind. */
type Entry =
  | { kind: "file"; size: number; written: number }
  | { kind: "link"; target: string }
  | { kind: "folder" | "other" };

/** What to compare: the folder left out of both trees, and the folder whose files may be missing in the copy. */
export type TreeCompare = {
  /** A `/`-separated folder (the part's own), excluded with everything under it. */
  except?: string;
  /** A `/`-separated folder (the parts' folder) whose files the game may have and the copy not yet. */
  landing?: string;
  /** Whether a file the game has and the copy lacks counts as changed. */
  missing: boolean;
};

const under = (relative: string, folder: string | undefined) =>
  folder !== undefined && (relative === folder || relative.startsWith(`${folder}/`));

/** Whether a name in a folder at `depth` (0 for the tree's own entries) is generated, never compared. */
const generated = (name: string, depth: number) =>
  name === PYTHON_CACHE || name.endsWith(PYTHON_COMPILED) || (depth === 1 && PLUGIN_BUILD_FOLDERS.has(name));

/** A walk of one tree: every entry by its `/`-separated path, and whether it saw all of them. */
type Walk = { root: string; except: string | undefined; entries: Map<string, Entry>; complete: boolean };

/** Adds the entries of `folder`, and of the folders in it down to the depth cap, to `walk`. */
async function walkFolder(walk: Walk, folder: string, depth: number): Promise<void> {
  if (depth >= MAX_DEPTH) {
    walk.complete = false;
    return;
  }
  const names = await readdir(path.join(walk.root, folder)).catch(() => [] as string[]);
  for (const name of names.sort()) {
    const relative = folder ? `${folder}/${name}` : name;
    if (name === FINDER_FILE || generated(name, depth) || under(relative, walk.except)) continue;
    if (walk.entries.size >= MAX_ENTRIES) {
      walk.complete = false;
      return;
    }
    const entry = await entryAt(path.join(walk.root, relative));
    walk.entries.set(relative, entry);
    if (entry.kind === "folder") await walkFolder(walk, relative, depth + 1);
  }
}

/** Every entry under `root`, never through a link; `complete` is false past the caps. */
async function walkTree(root: string, except: string | undefined): Promise<Walk> {
  const walk: Walk = { root, except, entries: new Map(), complete: true };
  await walkFolder(walk, "", 0);
  return walk;
}

async function entryAt(file: string): Promise<Entry> {
  const info = await lstat(file).catch(() => null);
  if (!info) return { kind: "other" };
  if (info.isSymbolicLink()) return { kind: "link", target: await readlink(file) };
  if (info.isDirectory()) return { kind: "folder" };
  return info.isFile() ? { kind: "file", size: info.size, written: info.mtimeMs } : { kind: "other" };
}

/** Whether two files have the same bytes; a file that can't be read plainly within the cap (a link, a folder, a missing one) differs. */
export async function sameBytes(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([
      readRegularFile(a, MAX_COMPARE_BYTES),
      readRegularFile(b, MAX_COMPARE_BYTES),
    ]);
    return left.equals(right);
  } catch {
    return false;
  }
}

/** Whether the copy's entry is the game's: same kind, same link target, a file with the same bytes. */
async function sameEntry(copy: string, game: string, relative: string, mine: Entry, theirs: Entry | undefined) {
  if (!theirs || theirs.kind !== mine.kind) return false;
  if (mine.kind === "link") return theirs.kind === "link" && theirs.target === mine.target;
  if (mine.kind !== "file") return false;
  const sameSize = theirs.kind === "file" && theirs.size === mine.size;
  return sameSize && sameBytes(path.join(copy, relative), path.join(game, relative));
}

/**
 * The paths (relative to the Source folders, `/`-separated) where the copy differs from the game:
 * every entry it added or changed outside `except`, and with `missing` every file it lacks outside
 * `landing` (another part may land in the game after the copy was made). "" stands for the whole
 * Source when the copy has more than the walk compares. At most {@link MAX_NAMED}.
 */
export async function changedSource(copy: string, game: string, compare: TreeCompare): Promise<string[]> {
  if ((await lstat(copy).catch(() => null))?.isSymbolicLink()) return [WHOLE_TREE];
  const [mine, theirs] = await Promise.all([walkTree(copy, compare.except), walkTree(game, compare.except)]);
  const changed: string[] = mine.complete ? [] : [WHOLE_TREE];
  for (const [relative, entry] of mine.entries) {
    if (changed.length >= MAX_NAMED) return changed;
    // A folder is compared by what it holds: a new empty one changes no C++.
    if (entry.kind === "folder") continue;
    if (!(await sameEntry(copy, game, relative, entry, theirs.entries.get(relative)))) changed.push(relative);
  }
  if (!compare.missing) return changed;
  for (const [relative, entry] of theirs.entries) {
    const lost = entry.kind !== "folder" && !mine.entries.has(relative) && !under(relative, compare.landing);
    if (lost && changed.length < MAX_NAMED) changed.push(relative);
  }
  return changed;
}

/**
 * A stamp of everything under `folder` but `except` (a `/`-separated folder in it), never through a
 * link: each entry's path with a file's size and write time, a link's target or a folder's kind.
 * Cheap (no file is read), and it changes when anything the walk sees is added, removed, rewritten
 * or touched.
 */
export async function treeStamp(folder: string, except?: string): Promise<string> {
  if ((await lstat(folder).catch(() => null))?.isSymbolicLink()) return `link:${await readlink(folder)}`;
  const walk = await walkTree(folder, except);
  return JSON.stringify([walk.complete, [...walk.entries]]);
}
