/**
 * The assets a C++ game's build takes (the web build packs them into `index.data`, the Mac build
 * copies them into `out/assets`), copied by the host into a folder of its own beside the build
 * folder (`<bin>.assets`, which no sandboxed process can write) before each build. emcc's file
 * packager and CMake's copy read whatever they are pointed at: aimed at the game's `assets/` they
 * take a dotfile such as `assets/.env` and follow a link out of the game. The copy holds only
 * regular files, none of the names an export leaves out (`excludedFromExport`) and no `.md` note;
 * a link anywhere under `assets/` fails the build, as it fails an export.
 *
 * A file is copied when its size, modification time or inode changed, and keeps its source's
 * times. The link that packs the stage re-runs only for a dependency newer than its output, which
 * a copy with an older time (unzip, tar x, cp -p) or a removed file never is, so beside the stage
 * the host keeps a stamp (`<stage>.stamp`) listing what it holds, rewritten whenever the stage
 * changed and never otherwise: genex.cmake makes the link depend on it. Each source file is
 * opened without following a link and must be the very file the walk listed, so swapping a
 * folder for a link mid-copy reads nothing outside the game.
 */
import type { Stats } from "node:fs";
import { constants as FS } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, utimes } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { atomicWriteText, openNoFollow, readRegularFile } from "../substrate/fsx.ts";
import { excludedFromExport } from "../substrate/game-export.ts";

const MESSAGE = {
  linked: (rel: string) => `${rel} is a link: a build takes only the game's own files, so nothing was built`,
  changed: (rel: string) => `${rel} changed while it was being copied for the build; build again`,
} as const;

/** The folder of a game a build takes: mounted at `/assets` in the web page, `Resources/assets` in a Mac game. */
const ASSETS_FOLDER = "assets";
/** Notes beside the assets (`assets/README.md`) are never packed. */
const NOTE = /\.md$/i;
/** A copy in progress, beside its final name, renamed into place once whole. */
const PART_SUFFIX = ".genex-part";
/** The most of a stamp the host reads back; a bigger one reads as none, and the stage is copied afresh. */
const STAMP_MAX_BYTES = 16 * 1024 * 1024;

/** One file a build takes: its `/`-joined path under `assets/` and what the walk saw. */
interface AssetFile {
  rel: string;
  stat: Stats;
}

/**
 * Make `staged` hold exactly the files of `<source>/assets` a build may take, rewrite
 * `stamp` when that changed what it holds, and answer how many files it holds. Throws (nothing
 * run yet) when a link is found under `assets/`.
 */
export async function stageAssets(source: string, staged: string, stamp: string): Promise<number> {
  const wanted = await assetFiles(path.join(source, ASSETS_FOLDER));
  await ownStage(staged);
  const previous = await readStamp(stamp);
  const listed = new Set((previous ?? "").split("\n"));
  const byRel = new Map(wanted.map((file) => [file.rel, file]));
  let changed = false;
  for (const rel of await stagedFiles(staged)) {
    const kept = byRel.get(rel);
    const current = await lstat(path.join(staged, ...rel.split("/"))).catch(() => null);
    if (kept && current?.isFile() && isCurrentCopy(current, kept, listed)) byRel.delete(rel);
    else {
      await rm(path.join(staged, ...rel.split("/")), { recursive: true, force: true });
      changed = true;
    }
  }
  for (const file of byRel.values()) {
    await copyAsset(source, staged, file);
    changed = true;
  }
  const listing = stampText(wanted);
  if (changed || listing !== previous) await atomicWriteText(stamp, listing);
  return wanted.length;
}

/** One staged file's line in the stamp: its path, and its source's size, modification time and inode. */
function stampLine(file: AssetFile): string {
  return [file.rel, file.stat.size, Math.trunc(file.stat.mtimeMs), file.stat.ino].join("\t");
}

/** The stamp of a stage holding `files`, one line each, by path. */
function stampText(files: readonly AssetFile[]): string {
  return files
    .map(stampLine)
    .sort()
    .map((line) => `${line}\n`)
    .join("");
}

/**
 * The stamp the last staging wrote; null when there is none or it is not a regular file, so it is
 * written (the link depends on it existing, even for a stage that holds nothing).
 */
async function readStamp(stamp: string): Promise<string | null> {
  return readRegularFile(stamp, STAMP_MAX_BYTES).then(
    (bytes) => bytes.toString("utf8"),
    () => null,
  );
}

/** Whether `copy` is still `source`'s: same size and time, and the stamp's lines list the very file it was copied from. */
function isCurrentCopy(copy: Stats, source: AssetFile, listed: ReadonlySet<string>): boolean {
  return sameContent(copy, source.stat) && listed.has(stampLine(source));
}

/** Every regular file under `root` a build may take; none when there is no `assets/` folder. */
async function assetFiles(root: string): Promise<AssetFile[]> {
  const top = await lstat(root).catch(() => null);
  if (top?.isSymbolicLink()) throw new Error(MESSAGE.linked(ASSETS_FOLDER));
  if (!top?.isDirectory()) return [];
  const found: AssetFile[] = [];
  await walk(root, "", found);
  return found;
}

async function walk(root: string, rel: string, found: AssetFile[]): Promise<void> {
  for (const entry of await readdir(path.join(root, ...rel.split("/").filter(Boolean)), { withFileTypes: true })) {
    if (excludedFromExport(entry.name)) continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(MESSAGE.linked(`${ASSETS_FOLDER}/${child}`));
    if (entry.isDirectory()) await walk(root, child, found);
    else if (entry.isFile() && !NOTE.test(entry.name))
      found.push({ rel: child, stat: await lstat(path.join(root, ...child.split("/"))) });
  }
}

/** The staging folder as a real folder: anything else at its name (a file, a link) is removed first. */
async function ownStage(staged: string): Promise<void> {
  const found = await lstat(staged).catch(() => null);
  if (found?.isDirectory()) return;
  if (found) await rm(staged, { recursive: true, force: true });
  await mkdir(staged, { recursive: true });
}

/** The `/`-joined path of every entry under `staged` that is not a folder (links included, never followed). */
async function stagedFiles(staged: string): Promise<string[]> {
  const entries = await readdir(staged, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(staged, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
}

/**
 * Whether a staged copy still matches its source: same size and modification time to the
 * millisecond (setting a time keeps less than the nanoseconds a file system records).
 */
function sameContent(copy: Stats, source: Stats): boolean {
  return copy.size === source.size && Math.trunc(copy.mtimeMs) === Math.trunc(source.mtimeMs);
}

/** Whether `opened` is the file the walk listed (same device and inode, still a regular file). */
function isListedFile(opened: Stats, listed: Stats): boolean {
  return opened.isFile() && opened.dev === listed.dev && opened.ino === listed.ino;
}

/**
 * Copy one asset into the stage: opened without following a link, checked to be the file the walk
 * listed, written beside its final name and renamed into place with the source's times.
 */
async function copyAsset(source: string, staged: string, file: AssetFile): Promise<void> {
  const from = path.join(source, ASSETS_FOLDER, ...file.rel.split("/"));
  const to = path.join(staged, ...file.rel.split("/"));
  const part = `${to}${PART_SUFFIX}`;
  await mkdir(path.dirname(to), { recursive: true });
  const input = await openNoFollow(from, FS.O_RDONLY | FS.O_NONBLOCK);
  try {
    if (!isListedFile(await input.stat(), file.stat)) throw new Error(MESSAGE.changed(`${ASSETS_FOLDER}/${file.rel}`));
    await rm(part, { force: true });
    const output = await open(part, "wx");
    await pipeline(input.createReadStream({ autoClose: false }), output.createWriteStream());
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  } finally {
    await input.close();
  }
  await utimes(part, file.stat.atimeMs / 1000, file.stat.mtimeMs / 1000);
  // A folder the stage kept at this name (the source's `x/` became a file `x`) gives way.
  if ((await lstat(to).catch(() => null))?.isDirectory()) await rm(to, { recursive: true, force: true });
  await rename(part, to);
}
