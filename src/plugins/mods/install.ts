/**
 * Putting a mod into a game and taking it out again. An install copies files from the mod's
 * project into one of two places Genex worked out for the game (its mods folder or its own
 * folder), keeps a copy of every file it replaces, and records every file and folder it made, so
 * Remove mod puts the game back as it was. The first install also copies the game's saves aside.
 *
 * Nothing is written through a link: a link in the copied files refuses the whole install before
 * anything is written, a link on the way to a destination refuses it, and each file lands under a
 * temporary name opened without following links and is then renamed into place. Everything kept
 * (the record, the replaced files, the saves) lives in the plugin's own storage.
 */
import { randomUUID } from "node:crypto";
import { constants as FS, type Stats } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { assertRelativePath, containedReal, isInside } from "../../substrate/paths.ts";
import { atomicWriteText, openNoFollow } from "../../substrate/fsx.ts";

/** Where in the game an install goes: the folder it loads mods from, or its own folder (a loader's files). Wire values. */
export const InstallRoot = { Mods: "mods", Game: "game" } as const;
export type InstallRoot = (typeof InstallRoot)[keyof typeof InstallRoot];
const isInstallRoot = (value: unknown): value is InstallRoot =>
  value === InstallRoot.Mods || value === InstallRoot.Game;

/** The most files one install copies. */
export const MAX_INSTALL_FILES = 5000;
/** The most bytes one install copies. */
export const MAX_INSTALL_BYTES = 2 * 1024 ** 3;
/** The most save files the first install copies aside. */
export const MAX_SAVE_FILES = 50_000;
/** The most save bytes the first install copies aside; bigger saves are left where they are, with a note. */
export const MAX_SAVE_BYTES = 2 * 1024 ** 3;

/** Why an install or a removal was refused. Wire values: the agent reads them. */
export const InstallProblem = {
  BadPath: "bad-path",
  Hidden: "hidden",
  Link: "link",
  NotThere: "not-there",
  NoMods: "no-mods-folder",
  TooMany: "too-many",
  NotAFolder: "not-a-folder",
  Unsafe: "unsafe-destination",
} as const;
export type InstallProblem = (typeof InstallProblem)[keyof typeof InstallProblem];

const MESSAGE = {
  [InstallProblem.BadPath]: "Give the path inside this project with / between folders, without .. or a leading /.",
  [InstallProblem.Hidden]: "A hidden folder (one whose name starts with a dot) can't be installed.",
  [InstallProblem.Link]: "The files hold a link; copy the real files into the project and install those.",
  [InstallProblem.NotThere]: "There is no such file or folder in this project.",
  [InstallProblem.NoMods]:
    "Genex doesn't know where this game loads mods from: install into the game's own folder (into: game).",
  [InstallProblem.TooMany]: `One install copies at most ${MAX_INSTALL_FILES} files and ${MAX_INSTALL_BYTES / 1024 ** 3} GB.`,
  [InstallProblem.NotAFolder]: "contents needs a folder: its files go in, not the folder itself.",
  [InstallProblem.Unsafe]: "Something on the way to that place is a link or a file, so Genex wrote nothing there.",
} as const satisfies Record<InstallProblem, string>;

/** A refusal: nothing was written. */
export class InstallRefused extends Error {
  readonly problem: InstallProblem;
  constructor(problem: InstallProblem) {
    super(MESSAGE[problem]);
    this.problem = problem;
  }
}

/** One file an install put in place, by its place and its `/`-separated path there; `kept` when the file it replaced is kept. */
export interface PlacedFile {
  root: InstallRoot;
  path: string;
  kept?: true;
}

/** What a project's installs put in the game, as the plugin keeps it. */
export interface InstallRecord {
  version: 1;
  game: string;
  files: PlacedFile[];
  /** The folders installs made, in the order they made them. */
  folders: Array<{ root: InstallRoot; path: string }>;
  /** The saves copied aside before the first install: when, and whether they were too big to copy. */
  saves?: { at: string; skipped?: true };
}

/** The folders an install reads and writes: the project, the plugin's folder for this project, and the game's places. */
export interface InstallPlaces {
  project: string;
  /** This project's folder in the plugin's storage: the record, kept files and saves. */
  kept: string;
  /** Each place in the game, or null where Genex knows none. */
  roots: Record<InstallRoot, string | null>;
  saves: string | null;
}

/** What one install asks for: a file or folder of the project, the place, a folder below it, and whether a folder's contents go in instead of the folder. */
export interface InstallAsk {
  from: string;
  into: InstallRoot;
  to?: string;
  contents?: boolean;
}

/** What became of the game's saves at an install. Wire values: the agent reads them. */
export const SavesKept = {
  /** Copied aside now, before the project's first install. */
  Copied: "copied",
  /** Too big to copy aside; left where they are. */
  TooBig: "too-big",
  /** Genex knows no saves folder for the game, or it is empty. */
  None: "none",
  /** Copied aside at an earlier install. */
  Before: "kept-before",
} as const;
export type SavesKept = (typeof SavesKept)[keyof typeof SavesKept];

/** What an install did. */
export interface InstallDone {
  copied: number;
  replaced: number;
  /** The folder the files went into. */
  folder: string;
  saves: SavesKept;
}

/** What a removal did. */
export interface RemoveDone {
  removed: number;
  restored: number;
}

const RECORD_FILE = "record.json";
const KEPT_FOLDER = "replaced";
const SAVES_FOLDER = "saves";
/** The saves copied aside before the first install. */
const FIRST_SAVES = "first";
/** The saves copied aside before the last restore, replaced by the next one. */
const BEFORE_RESTORE = "before-restore";
/** A file being written takes this name first, then is renamed into place. */
const PART_SUFFIX = ".genex-part";

/** A `/`-path's segments, after its shape is checked. */
function segments(rel: string): string[] {
  try {
    return assertRelativePath(rel).split("/");
  } catch {
    throw new InstallRefused(InstallProblem.BadPath);
  }
}

/** The record of what a project's installs put in place; an empty one before the first. */
export async function readRecord(kept: string, game: string): Promise<InstallRecord> {
  try {
    const record = JSON.parse(await readFile(path.join(kept, RECORD_FILE), "utf8")) as InstallRecord;
    if (record.version === 1 && Array.isArray(record.files) && Array.isArray(record.folders)) return record;
  } catch {}
  return { version: 1, game, files: [], folders: [] };
}

async function writeRecord(kept: string, record: InstallRecord): Promise<void> {
  await mkdir(kept, { recursive: true });
  await atomicWriteText(path.join(kept, RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

/** A file to copy: where it is in the project and its path below the destination. */
interface SourceFile {
  abs: string;
  rel: string[];
}

/** The files and folders below `dir` (a real folder of the project), refusing a link or anything that isn't a file or folder. */
async function walkSource(dir: string, prefix: string[], files: SourceFile[], dirs: string[][], bytes: { n: number }) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = [...prefix, entry.name];
    if (entry.isSymbolicLink()) throw new InstallRefused(InstallProblem.Link);
    if (entry.isDirectory()) {
      dirs.push(rel);
      await walkSource(abs, rel, files, dirs, bytes);
    } else if (entry.isFile()) {
      bytes.n += (await lstat(abs)).size;
      files.push({ abs, rel });
    }
    if (files.length > MAX_INSTALL_FILES || bytes.n > MAX_INSTALL_BYTES)
      throw new InstallRefused(InstallProblem.TooMany);
  }
}

/** What an ask copies: each file with its path below the destination, and the folders to make there. */
async function planSource(project: string, ask: InstallAsk): Promise<{ files: SourceFile[]; dirs: string[][] }> {
  const parts = segments(ask.from);
  if (parts.some((part) => part.startsWith("."))) throw new InstallRefused(InstallProblem.Hidden);
  const named = path.join(project, ...parts);
  const info = await lstat(named).catch(() => null);
  if (!info) throw new InstallRefused(InstallProblem.NotThere);
  if (info.isSymbolicLink()) throw new InstallRefused(InstallProblem.Link);
  const real = await containedReal(project, ask.from).catch(() => null);
  if (!real) throw new InstallRefused(InstallProblem.Link);
  const name = parts[parts.length - 1] ?? "";
  if (info.isFile()) {
    if (ask.contents) throw new InstallRefused(InstallProblem.NotAFolder);
    return { files: [{ abs: real, rel: [name] }], dirs: [] };
  }
  const files: SourceFile[] = [];
  const dirs: string[][] = ask.contents ? [] : [[name]];
  await walkSource(real, ask.contents ? [] : [name], files, dirs, { n: 0 });
  return { files, dirs };
}

/** What a path names: a folder of its own, nothing, or anything else (a link, a file). */
const FolderState = { Folder: "folder", Missing: "missing", Other: "other" } as const;
type FolderState = (typeof FolderState)[keyof typeof FolderState];

/** What `dir` names, never following a link. */
async function folderState(dir: string): Promise<FolderState> {
  const info = await lstat(dir).catch(() => null);
  if (!info) return FolderState.Missing;
  return info.isDirectory() && !info.isSymbolicLink() ? FolderState.Folder : FolderState.Other;
}

/**
 * The folder `parts` names below `root` (a real folder), made where missing and recorded as made,
 * each part a folder of its own: a link or a file on the way refuses the install.
 */
async function ensureBelow(root: string, parts: string[], made: string[][]): Promise<string> {
  let dir = root;
  for (let at = 0; at < parts.length; at++) {
    dir = path.join(dir, parts[at] ?? "");
    const state = await folderState(dir);
    if (state === FolderState.Other) throw new InstallRefused(InstallProblem.Unsafe);
    if (state === FolderState.Missing) {
      await mkdir(dir);
      made.push(parts.slice(0, at + 1));
    }
  }
  return dir;
}

/** Copies one regular file (opened without following links) to `target` through a temporary name beside it. */
async function copyInto(source: string, target: string): Promise<void> {
  const input = await openNoFollow(source, FS.O_RDONLY);
  const info: Stats = await input.stat();
  if (!info.isFile()) {
    await input.close();
    throw new InstallRefused(InstallProblem.Link);
  }
  const part = `${target}.${randomUUID().slice(0, 8)}${PART_SUFFIX}`;
  const output = await openNoFollow(part, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o644).catch(async (error) => {
    await input.close();
    throw error;
  });
  try {
    await pipeline(input.createReadStream(), output.createWriteStream());
    await chmod(part, info.mode & 0o777);
    await rename(part, target);
  } catch (error) {
    await unlink(part).catch(() => {});
    throw error;
  }
}

/** The real folder of a place in the game: the mods folder is made when it is missing, the game's folder must be there. */
async function rootFolder(places: InstallPlaces, into: InstallRoot): Promise<string> {
  const named = places.roots[into];
  if (!named) throw new InstallRefused(into === InstallRoot.Mods ? InstallProblem.NoMods : InstallProblem.NotThere);
  if (into === InstallRoot.Mods) await mkdir(named, { recursive: true });
  const real = await realpath(named).catch(() => null);
  if (!real || (await folderState(real)) !== FolderState.Folder) throw new InstallRefused(InstallProblem.Unsafe);
  return real;
}

/** Copies a folder tree (a game's saves, or a copy of them) into `to`, leaving links out; false when it is too big. */
async function copyTree(from: string, to: string, count: { files: number; bytes: number }): Promise<boolean> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      if (!(await copyTree(source, target, count))) return false;
    } else if (entry.isFile()) {
      count.files++;
      count.bytes += (await lstat(source)).size;
      if (count.files > MAX_SAVE_FILES || count.bytes > MAX_SAVE_BYTES) return false;
      await copyInto(source, target);
    }
  }
  return true;
}

/** Copies the game's saves aside into `name` in the kept folder; what happened. */
async function keepSaves(places: InstallPlaces, name: string): Promise<SavesKept> {
  const saves = places.saves ? await realpath(places.saves).catch(() => null) : null;
  if (!saves || (await folderState(saves)) !== FolderState.Folder) return SavesKept.None;
  const target = path.join(places.kept, SAVES_FOLDER, name);
  await rm(target, { recursive: true, force: true });
  if (await copyTree(saves, target, { files: 0, bytes: 0 })) return SavesKept.Copied;
  await rm(target, { recursive: true, force: true });
  return SavesKept.TooBig;
}

/** A path's `/`-joined key in the record. */
const keyOf = (root: InstallRoot, parts: string[]) => `${root}:${parts.join("/")}`;

/** An install under way: its place's real folder, its record, what it placed so far by key, and the folders it made. */
interface Placing {
  places: InstallPlaces;
  project: string;
  into: InstallRoot;
  root: string;
  record: InstallRecord;
  placed: Map<string, PlacedFile>;
  made: string[][];
  done: { copied: number; replaced: number };
}

/** Places one file at `rel` below the place: the game's own file there is kept first, once. */
async function placeOne(placing: Placing, file: SourceFile, rel: string[]): Promise<void> {
  // Read again just before the copy: a folder of the project swapped for a link since the walk is refused.
  const real = await realpath(file.abs).catch(() => null);
  if (!real || !isInside(placing.project, real)) throw new InstallRefused(InstallProblem.Link);
  const dir = await ensureBelow(placing.root, rel.slice(0, -1), placing.made);
  const target = path.join(dir, rel[rel.length - 1] ?? "");
  const there = await lstat(target).catch(() => null);
  if (there && (!there.isFile() || there.isSymbolicLink())) throw new InstallRefused(InstallProblem.Unsafe);
  const key = keyOf(placing.into, rel);
  if (!placing.placed.has(key)) {
    const entry: PlacedFile = { root: placing.into, path: rel.join("/") };
    if (there) {
      await keepReplaced(placing.places, placing.into, rel, target);
      entry.kept = true;
      placing.done.replaced++;
    }
    placing.placed.set(key, entry);
    placing.record.files.push(entry);
  }
  await copyInto(real, target);
  placing.done.copied++;
}

/** Copies the ask's files into the game, keeping each file it replaces and recording each it placed, even when it stops part way. */
async function placeFiles(
  places: InstallPlaces,
  target: { into: InstallRoot; root: string; base: string[] },
  record: InstallRecord,
  plan: Awaited<ReturnType<typeof planSource>>,
) {
  const { into, root, base } = target;
  const placing: Placing = {
    places,
    project: await realpath(places.project),
    into,
    root,
    record,
    placed: new Map(record.files.map((file) => [keyOf(file.root, file.path.split("/")), file])),
    made: [],
    done: { copied: 0, replaced: 0 },
  };
  try {
    const folder = await ensureBelow(root, base, placing.made);
    for (const dir of plan.dirs) await ensureBelow(root, [...base, ...dir], placing.made);
    for (const file of plan.files) await placeOne(placing, file, [...base, ...file.rel]);
    return { ...placing.done, folder };
  } finally {
    for (const parts of placing.made) record.folders.push({ root: into, path: parts.join("/") });
    await writeRecord(places.kept, record);
  }
}

/** Keeps the game's own file at `target` before an install replaces it. */
async function keepReplaced(places: InstallPlaces, root: InstallRoot, rel: string[], target: string) {
  const copy = path.join(places.kept, KEPT_FOLDER, root, ...rel);
  await mkdir(path.dirname(copy), { recursive: true });
  await copyInto(target, copy);
}

/** Installs the ask's files into the game for `game`, copying its saves aside first when this is the project's first install. */
export async function installMod(places: InstallPlaces, game: string, ask: InstallAsk): Promise<InstallDone> {
  if (!isInstallRoot(ask.into)) throw new InstallRefused(InstallProblem.BadPath);
  // Every check before anything is written: the files, the folder below the place, the place itself.
  const plan = await planSource(places.project, ask);
  const base = ask.to ? segments(ask.to) : [];
  const root = await rootFolder(places, ask.into);
  const record = await readRecord(places.kept, game);
  let saves: SavesKept = SavesKept.Before;
  if (!record.saves) {
    saves = await keepSaves(places, FIRST_SAVES);
    const skipped = saves === SavesKept.TooBig ? { skipped: true as const } : {};
    if (saves !== SavesKept.None) record.saves = { at: new Date().toISOString(), ...skipped };
  }
  return { ...(await placeFiles(places, { into: ask.into, root, base }, record, plan)), saves };
}

/** The real folder of a place for a removal, or null when it is gone (the game uninstalled). */
async function existingRoot(places: InstallPlaces, root: InstallRoot): Promise<string | null> {
  const named = places.roots[root];
  const real = named ? await realpath(named).catch(() => null) : null;
  return real && (await folderState(real)) === FolderState.Folder ? real : null;
}

/** Whether each of the folders `parts` names below `root` is a folder of its own: never write through a link. */
async function plainWay(root: string, parts: string[]): Promise<boolean> {
  let dir = root;
  for (const part of parts) {
    dir = path.join(dir, part);
    if ((await folderState(dir)) !== FolderState.Folder) return false;
  }
  return true;
}

/** Takes one placed file out: the kept original goes back, or the file goes. */
async function takeOut(places: InstallPlaces, root: string, file: PlacedFile, done: RemoveDone): Promise<void> {
  const parts = file.path.split("/");
  if (!(await plainWay(root, parts.slice(0, -1)))) return;
  const target = path.join(root, ...parts);
  if (!isInside(root, target)) return;
  const there = await lstat(target).catch(() => null);
  if (there && (there.isSymbolicLink() || !there.isFile())) return;
  if (file.kept) {
    await copyInto(path.join(places.kept, KEPT_FOLDER, file.root, ...parts), target);
    done.restored++;
  } else if (there) {
    await unlink(target);
    done.removed++;
  }
}

/** Takes every file the project's installs placed out of the game and puts back each file they replaced; the saves stay as they are. */
export async function removeMod(places: InstallPlaces, game: string): Promise<RemoveDone> {
  const record = await readRecord(places.kept, game);
  const done: RemoveDone = { removed: 0, restored: 0 };
  const roots = {
    [InstallRoot.Mods]: await existingRoot(places, InstallRoot.Mods),
    [InstallRoot.Game]: await existingRoot(places, InstallRoot.Game),
  };
  for (const file of [...record.files].reverse()) {
    const root = roots[file.root];
    if (root) await takeOut(places, root, file, done);
  }
  for (const folder of [...record.folders].reverse()) {
    const root = roots[folder.root];
    const parts = folder.path.split("/");
    // Only an empty folder goes: rmdir refuses one the game or the person put something in since.
    if (root && (await plainWay(root, parts))) await rmdir(path.join(root, ...parts)).catch(() => {});
  }
  await rm(path.join(places.kept, KEPT_FOLDER), { recursive: true, force: true });
  await writeRecord(places.kept, { ...record, files: [], folders: [] });
  return done;
}

/** Whether the project has anything in the game now. */
export async function hasInstalled(kept: string, game: string): Promise<boolean> {
  return (await readRecord(kept, game)).files.length > 0;
}

/** Copies the saves kept before the first install back over the game's saves, first copying today's aside; false when none are kept. */
export async function restoreSaves(places: InstallPlaces, game: string): Promise<boolean> {
  const record = await readRecord(places.kept, game);
  const first = path.join(places.kept, SAVES_FOLDER, FIRST_SAVES);
  const kept = record.saves && !record.saves.skipped && (await folderState(first)) === FolderState.Folder;
  if (!kept || !places.saves) return false;
  await keepSaves(places, BEFORE_RESTORE);
  await mkdir(places.saves, { recursive: true });
  const saves = await realpath(places.saves);
  if ((await folderState(saves)) !== FolderState.Folder) throw new InstallRefused(InstallProblem.Unsafe);
  await copyBack(first, saves);
  return true;
}

/** Copies a kept folder back over `target`, made when missing; a link or a file in its place is left alone. */
async function copyFolderBack(source: string, target: string): Promise<void> {
  const state = await folderState(target);
  if (state === FolderState.Other) return;
  if (state === FolderState.Missing) await mkdir(target);
  await copyBack(source, target);
}

/** Copies a kept file back over `target`, unless a link or something other than a file is there. */
async function copyFileBack(source: string, target: string): Promise<void> {
  const there = await lstat(target).catch(() => null);
  if (there && (there.isSymbolicLink() || !there.isFile())) return;
  await copyInto(source, target);
}

/** Copies a kept tree back over `to`, never through a link in `to`. */
async function copyBack(from: string, to: string): Promise<void> {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyFolderBack(source, target);
    else if (entry.isFile()) await copyFileBack(source, target);
  }
}

/** When the saves were copied aside, or null when none are kept. */
export async function keptSavesAt(kept: string, game: string): Promise<string | null> {
  const saves = (await readRecord(kept, game)).saves;
  return saves && !saves.skipped ? saves.at : null;
}
