/**
 * Putting a mod into a game and taking it out again. An install copies files from the mod's
 * project into one of two places Genex worked out for the game (its mods folder or its own
 * folder), keeps a copy of every game file it replaces, and records every file it placed (with the
 * digest of what it wrote) and every folder it made, so Remove mod puts the game back as it was.
 * The first install also copies the game's saves aside.
 *
 * Every check runs before anything is written (`planInstall`): the copied files (no link, no hidden
 * file), the way to each destination (no link or file on it), each target (a file of the game, of
 * this project, or none) and the game's claims (no file another mod project placed). A failure
 * while writing undoes what this install wrote. Nothing is written through a link: each file lands
 * under a temporary name opened without following links and is renamed into place, and a source
 * file must still be the very file the check saw. Removal touches only a file that still holds
 * what the install wrote: one the game or the person changed since is left, and one it can't reach
 * safely stays recorded with its kept original. Everything kept lives in the plugin's storage.
 */
import { lstat, mkdir, readdir, readFile, realpath, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { assertRelativePath, containedReal, isInside } from "../../substrate/paths.ts";
import { atomicWriteText } from "../../substrate/fsx.ts";
import { type Claims, claimKey, readClaims, updateClaims, withGame } from "./claims.ts";
import { copyInto, digestOf, type FileId, FolderState, folderState, SourceChanged } from "./files.ts";

/** Where in the game an install goes: the folder it loads mods from, or its own folder (a loader's files). Wire values. */
export const InstallRoot = { Mods: "mods", Game: "game" } as const;
export type InstallRoot = (typeof InstallRoot)[keyof typeof InstallRoot];
const isInstallRoot = (value: unknown): value is InstallRoot =>
  value === InstallRoot.Mods || value === InstallRoot.Game;

/** The most files one install copies. */
export const MAX_INSTALL_FILES = 5000;
/** The most bytes one install copies. */
export const MAX_INSTALL_BYTES = 2 * 1024 ** 3;
/** The most save files copied aside at once. */
export const MAX_SAVE_FILES = 50_000;
/** The most save bytes copied aside at once; bigger saves are left where they are, with a note. */
export const MAX_SAVE_BYTES = 2 * 1024 ** 3;

/** Why an install or Put back saves was refused. Wire values: the agent reads them. */
export const InstallProblem = {
  BadPath: "bad-path",
  Hidden: "hidden",
  Link: "link",
  NotThere: "not-there",
  NoMods: "no-mods-folder",
  NoGameData: "no-game-data",
  TooMany: "too-many",
  NotAFolder: "not-a-folder",
  Unsafe: "unsafe-destination",
  OtherMod: "other-mod",
  SavesTooBig: "saves-too-big",
} as const;
export type InstallProblem = (typeof InstallProblem)[keyof typeof InstallProblem];

const MESSAGE = {
  [InstallProblem.BadPath]: "Give the path inside this project with / between folders, without .. or a leading /.",
  [InstallProblem.Hidden]: "A hidden folder (one whose name starts with a dot) can't be installed.",
  [InstallProblem.Link]: "The files hold a link, or changed while Genex checked them; install the real files.",
  [InstallProblem.NotThere]: "There is no such file or folder in this project, or the game's folder is gone.",
  [InstallProblem.NoMods]:
    "Genex doesn't know where this game loads mods from: install into the game's own folder (into: game).",
  [InstallProblem.NoGameData]:
    "The game hasn't made its own folders yet: ask the person to start it once, then install again.",
  [InstallProblem.TooMany]: `One install copies at most ${MAX_INSTALL_FILES} files and ${MAX_INSTALL_BYTES / 1024 ** 3} GB.`,
  [InstallProblem.NotAFolder]: "contents needs a folder: its files go in, not the folder itself.",
  [InstallProblem.Unsafe]: "Something on the way to that place is a link or a file, so Genex wrote nothing there.",
  [InstallProblem.OtherMod]:
    "Another mod project put one of these files in the game: take that mod out first (Remove mod in its project).",
  [InstallProblem.SavesTooBig]:
    "Today's saves are too big to copy aside first, so Genex left them as they are and put nothing back.",
} as const satisfies Record<InstallProblem, string>;

/** A refusal before anything was written. */
export class InstallRefused extends Error {
  readonly problem: InstallProblem;
  constructor(problem: InstallProblem) {
    super(MESSAGE[problem]);
    this.problem = problem;
  }
}

/**
 * A failure once writing began: what this install wrote was undone, except `stuck` files Remove
 * mod can still take out; with `before`, the earlier install `replace` took out stays out.
 */
export class InstallUndone extends Error {
  readonly stuck: number;
  readonly before: RemoveDone | undefined;
  constructor(cause: unknown, stuck: number, before?: RemoveDone) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.stuck = stuck;
    this.before = before;
  }
}

/** One file an install put in place: its place, its `/`-path there, what it wrote, and whether the file it replaced is kept. */
export interface PlacedFile {
  root: InstallRoot;
  path: string;
  size: number;
  sha256: string;
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

/** The folders an install reads and writes. */
export interface InstallPlaces {
  project: string;
  /** This project's folder in the plugin's storage: the record, kept files and saves. */
  kept: string;
  /** The game's claims file in the plugin's storage, shared by every project modding the game. */
  claims: string;
  /** This project's key in the claims. */
  owner: string;
  /** Each place in the game, or null where Genex knows none. */
  roots: Record<InstallRoot, string | null>;
  saves: string | null;
  /** How many save files and bytes are copied aside at most; {@link MAX_SAVE_FILES} and {@link MAX_SAVE_BYTES} when absent. */
  saveLimits?: { files: number; bytes: number };
  /** Runs before each file is written, after every check: a test's swap of a source. */
  beforeFile?: (index: number) => Promise<void>;
}

/**
 * What one install asks for: a file or folder of the project, the place, a folder below it, whether
 * a folder's contents go in instead of the folder, and whether what the project put in the game
 * before comes out first (a new version under another name).
 */
export interface InstallAsk {
  from: string;
  into: InstallRoot;
  to?: string;
  contents?: boolean;
  replace?: boolean;
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

/** What a removal did: files taken out, game files put back, files it couldn't reach safely (kept for later), and files the game or the person changed since (left). */
export interface RemoveDone {
  removed: number;
  restored: number;
  skipped: number;
  changed: number;
}

/** What an install did. */
export interface InstallDone {
  copied: number;
  replaced: number;
  /** The folder the files went into. */
  folder: string;
  saves: SavesKept;
  /** With `replace`: what taking the earlier install out did. */
  before?: RemoveDone;
}

/** What a target holds before an install: nothing, a file this project placed, or a file of the game's own. */
const Existing = { None: "none", Ours: "ours", Game: "game" } as const;
type Existing = (typeof Existing)[keyof typeof Existing];

/** A file the install will copy: its source (as checked), its path below the place, and what its target holds. */
interface PlannedFile {
  source: string;
  id: FileId;
  rel: string[];
  existing: Existing;
}

/** An install checked and ready to write. */
export interface InstallPlan {
  into: InstallRoot;
  /** The place's real folder, or its parent's when the place itself is still to be made. */
  root: string;
  /** The place's own folder name when it is still to be made (a mods folder the game hasn't made). */
  makeRoot: string | null;
  base: string[];
  dirs: string[][];
  files: PlannedFile[];
  /** How many of the game's own files this install replaces. */
  replaced: number;
}

const RECORD_FILE = "record.json";
const KEPT_FOLDER = "replaced";
const UNDO_FOLDER = "undo";
const SAVES_FOLDER = "saves";
/** The saves copied aside before the first install. */
const FIRST_SAVES = "first";
/** The saves copied aside before the last restore, replaced by the next one. */
const BEFORE_RESTORE = "before-restore";

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

/** A file to copy, as the walk found it: its path, its identity on disk, and its path below the destination. */
interface SourceFile {
  abs: string;
  id: FileId;
  rel: string[];
}

/** The files and folders below `dir` (a real folder of the project): hidden ones left out, a link refusing the install. */
async function walkSource(
  dir: string,
  prefix: string[],
  found: { files: SourceFile[]; dirs: string[][]; bytes: number },
) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const abs = path.join(dir, entry.name);
    const rel = [...prefix, entry.name];
    if (entry.isSymbolicLink()) throw new InstallRefused(InstallProblem.Link);
    if (entry.isDirectory()) {
      found.dirs.push(rel);
      await walkSource(abs, rel, found);
    } else if (entry.isFile()) {
      const info = await lstat(abs);
      found.bytes += info.size;
      found.files.push({ abs, id: { dev: info.dev, ino: info.ino }, rel });
    }
    if (found.files.length > MAX_INSTALL_FILES || found.bytes > MAX_INSTALL_BYTES)
      throw new InstallRefused(InstallProblem.TooMany);
  }
}

/** What an ask copies: each file with its identity and path below the destination, and the folders to make there. */
async function planSource(project: string, ask: InstallAsk): Promise<{ files: SourceFile[]; dirs: string[][] }> {
  const parts = segments(ask.from);
  if (parts.some((part) => part.startsWith("."))) throw new InstallRefused(InstallProblem.Hidden);
  const info = await lstat(path.join(project, ...parts)).catch(() => null);
  if (!info) throw new InstallRefused(InstallProblem.NotThere);
  if (info.isSymbolicLink()) throw new InstallRefused(InstallProblem.Link);
  const real = await containedReal(project, ask.from).catch(() => null);
  if (!real) throw new InstallRefused(InstallProblem.Link);
  const name = parts[parts.length - 1] ?? "";
  if (info.isFile()) {
    if (ask.contents) throw new InstallRefused(InstallProblem.NotAFolder);
    return { files: [{ abs: real, id: { dev: info.dev, ino: info.ino }, rel: [name] }], dirs: [] };
  }
  const found = { files: [] as SourceFile[], dirs: ask.contents ? [] : [[name]], bytes: 0 };
  await walkSource(real, ask.contents ? [] : [name], found);
  return found;
}

/**
 * The place's real folder: the game's must be there; a mods folder the game hasn't made yet is made
 * at write time, but only when its parent (the game's own data folder) is there, never a whole chain.
 */
async function placeRoot(places: InstallPlaces, into: InstallRoot): Promise<{ root: string; makeRoot: string | null }> {
  const named = places.roots[into];
  if (!named) throw new InstallRefused(into === InstallRoot.Mods ? InstallProblem.NoMods : InstallProblem.NotThere);
  const real = await realpath(named).catch(() => null);
  if (real) {
    if ((await folderState(real)) !== FolderState.Folder) throw new InstallRefused(InstallProblem.Unsafe);
    return { root: real, makeRoot: null };
  }
  const parent = into === InstallRoot.Mods ? await realpath(path.dirname(named)).catch(() => null) : null;
  if (!parent || (await folderState(parent)) !== FolderState.Folder)
    throw new InstallRefused(into === InstallRoot.Mods ? InstallProblem.NoGameData : InstallProblem.NotThere);
  return { root: parent, makeRoot: path.basename(named) };
}

/** Whether each existing folder on the way to `parts` below `root` is a folder of its own; missing ones are fine. */
async function wayIsSafe(root: string, parts: readonly string[]): Promise<{ safe: boolean; whole: boolean }> {
  let dir = root;
  for (const part of parts) {
    dir = path.join(dir, part);
    const state = await folderState(dir);
    if (state === FolderState.Missing) return { safe: true, whole: false };
    if (state === FolderState.Other) return { safe: false, whole: false };
  }
  return { safe: true, whole: true };
}

/** What a planned target holds now; refuses a link or a folder there, and a file another project placed. */
async function existingAt(root: string, rel: string[], ours: boolean, claimedByOther: boolean): Promise<Existing> {
  const way = await wayIsSafe(root, rel.slice(0, -1));
  if (!way.safe) throw new InstallRefused(InstallProblem.Unsafe);
  if (!way.whole) return Existing.None;
  const there = await lstat(path.join(root, ...rel)).catch(() => null);
  if (!there) return Existing.None;
  if (!there.isFile() || there.isSymbolicLink()) throw new InstallRefused(InstallProblem.Unsafe);
  if (ours) return Existing.Ours;
  if (claimedByOther) throw new InstallRefused(InstallProblem.OtherMod);
  return Existing.Game;
}

/** Every check of an install, with nothing written: the plan it would follow. */
export async function planInstall(places: InstallPlaces, game: string, ask: InstallAsk): Promise<InstallPlan> {
  if (!isInstallRoot(ask.into)) throw new InstallRefused(InstallProblem.BadPath);
  const source = await planSource(places.project, ask);
  const base = ask.to ? segments(ask.to) : [];
  const { root, makeRoot } = await placeRoot(places, ask.into);
  const lead = makeRoot ? [makeRoot] : [];
  const record = await readRecord(places.kept, game);
  const claims = await readClaims(places.claims);
  const ours = new Set(record.files.map((file) => claimKey(file.root, file.path)));
  for (const dir of [base, ...source.dirs.map((d) => [...base, ...d])])
    if (!(await wayIsSafe(root, [...lead, ...dir])).safe) throw new InstallRefused(InstallProblem.Unsafe);
  const files: PlannedFile[] = [];
  for (const file of source.files) {
    const rel = [...base, ...file.rel];
    const key = claimKey(ask.into, rel);
    const other = claims[key] !== undefined && claims[key] !== places.owner;
    const existing = await existingAt(root, [...lead, ...rel], ours.has(key), other);
    files.push({ source: file.abs, id: file.id, rel, existing });
  }
  const replaced = files.filter((file) => file.existing === Existing.Game).length;
  return { into: ask.into, root, makeRoot, base, dirs: source.dirs, files, replaced };
}

/**
 * The folder `parts` names below `root`, made where missing and recorded as made, each part a
 * folder of its own: a link or a file on the way (swapped in since the check) refuses it.
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

/** One step a writing install took, enough to undo it: the entry it recorded, and what the target held before. */
interface Step {
  entry: PlacedFile;
  target: string;
  was: Existing;
  /** A copy of this project's earlier file, put back if the install is undone. */
  undo?: string;
  /** The entry the record held before, for a file this project had placed. */
  previous?: PlacedFile;
}

/** An install under way. */
interface Writing {
  places: InstallPlaces;
  plan: InstallPlan;
  /** The place's real folder once made. */
  root: string;
  record: InstallRecord;
  made: string[][];
  steps: Step[];
}

/** Where a kept copy of the game's own file at `rel` lives. */
const keptCopy = (places: InstallPlaces, root: InstallRoot, rel: string) =>
  path.join(places.kept, KEPT_FOLDER, root, ...rel.split("/"));

/** Copies `target` to `copy`, making its folder. */
async function keepCopy(target: string, copy: string): Promise<void> {
  await mkdir(path.dirname(copy), { recursive: true });
  await copyInto(target, copy);
}

/** Writes one planned file, keeping what it replaces first. */
async function writeOne(writing: Writing, file: PlannedFile): Promise<void> {
  const { places, plan, record } = writing;
  const dir = await ensureBelow(writing.root, file.rel.slice(0, -1), writing.made);
  const target = path.join(dir, file.rel[file.rel.length - 1] ?? "");
  const rel = file.rel.join("/");
  const at = record.files.findIndex((entry) => entry.root === plan.into && entry.path === rel);
  const previous = at >= 0 ? record.files[at] : undefined;
  const step: Step = { entry: { root: plan.into, path: rel, size: 0, sha256: "" }, target, was: file.existing };
  if (previous) {
    // This project placed the file before: its kept original (if any) stays the game's.
    step.previous = previous;
    if (previous.kept) step.entry.kept = true;
  }
  if (file.existing === Existing.Game) {
    await keepCopy(target, keptCopy(places, plan.into, rel));
    step.entry.kept = true;
  } else if (file.existing === Existing.Ours) {
    step.undo = path.join(places.kept, UNDO_FOLDER, plan.into, ...file.rel);
    await keepCopy(target, step.undo);
  }
  writing.steps.push(step);
  const written = await copyInto(file.source, target, file.id).catch((error: unknown) => {
    throw error instanceof SourceChanged ? new InstallRefused(InstallProblem.Link) : error;
  });
  Object.assign(step.entry, written);
  if (at >= 0) record.files[at] = step.entry;
  else record.files.push(step.entry);
}

/** Undoes one written step; false when it couldn't, so its entry stays recorded for Remove mod. */
async function undoStep(writing: Writing, step: Step): Promise<boolean> {
  const { places, plan, record } = writing;
  try {
    if (step.was === Existing.Game) await copyInto(keptCopy(places, plan.into, step.entry.path), step.target);
    else if (step.was === Existing.Ours && step.undo) await copyInto(step.undo, step.target);
    else await unlink(step.target).catch(() => {});
  } catch {
    return false;
  }
  const at = record.files.indexOf(step.entry);
  if (at >= 0 && step.previous) record.files[at] = step.previous;
  else if (at >= 0) record.files.splice(at, 1);
  if (step.was === Existing.Game) await rm(keptCopy(places, plan.into, step.entry.path), { force: true });
  return true;
}

/** Undoes what a failed install wrote, newest first, and the folders it made; how many files it couldn't undo. */
async function undoWriting(writing: Writing): Promise<number> {
  let stuck = 0;
  for (const step of [...writing.steps].reverse()) if (!(await undoStep(writing, step))) stuck++;
  for (const parts of [...writing.made].reverse()) await rmdir(path.join(writing.root, ...parts)).catch(() => {});
  if (writing.plan.makeRoot) await rmdir(writing.root).catch(() => {});
  return stuck;
}

/** Writes a checked plan, undoing it all when a step fails; the record and the claims are saved either way. */
async function writePlan(places: InstallPlaces, plan: InstallPlan, record: InstallRecord): Promise<{ folder: string }> {
  // Every file this install will write is claimed before the first is: the check in the plan and
  // this claim run in one turn of the game's queue.
  await updateClaims(places.claims, (claims) => {
    for (const file of plan.files) claims[claimKey(plan.into, file.rel)] = places.owner;
  });
  const root = plan.makeRoot ? await ensureBelow(plan.root, [plan.makeRoot], []) : plan.root;
  const writing: Writing = { places, plan, root, record, made: [], steps: [] };
  try {
    const folder = await ensureBelow(root, plan.base, writing.made);
    for (const dir of plan.dirs) await ensureBelow(root, [...plan.base, ...dir], writing.made);
    for (const [index, file] of plan.files.entries()) {
      await places.beforeFile?.(index);
      await writeOne(writing, file);
    }
    for (const parts of writing.made) record.folders.push({ root: plan.into, path: parts.join("/") });
    return { folder };
  } catch (error) {
    const stuck = await undoWriting(writing);
    throw error instanceof InstallRefused && !stuck ? error : new InstallUndone(error, stuck);
  } finally {
    await rm(path.join(places.kept, UNDO_FOLDER), { recursive: true, force: true });
    await writeRecord(places.kept, record);
    await updateClaims(places.claims, (claims) => settleClaims(claims, places.owner, plan, record));
  }
}

/** After an install: every file the record holds is this project's; a planned one it undid is let go. */
function settleClaims(claims: Claims, owner: string, plan: InstallPlan, record: InstallRecord): void {
  const held = new Set(record.files.map((file) => claimKey(file.root, file.path)));
  for (const file of plan.files) {
    const key = claimKey(plan.into, file.rel);
    if (!held.has(key) && claims[key] === owner) delete claims[key];
  }
  for (const key of held) claims[key] = owner;
}

/** A copy of saves under way: how much it copied, and how much it may. */
interface SavesCopy {
  files: number;
  bytes: number;
  limits: { files: number; bytes: number };
}

/** Copies a folder tree (a game's saves, or a copy of them) into `to`, leaving links out; false when it is too big. */
async function copyTree(from: string, to: string, count: SavesCopy): Promise<boolean> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      if (!(await copyTree(source, target, count))) return false;
    } else if (entry.isFile()) {
      count.files++;
      count.bytes += (await lstat(source)).size;
      if (count.files > count.limits.files || count.bytes > count.limits.bytes) return false;
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
  const limits = places.saveLimits ?? { files: MAX_SAVE_FILES, bytes: MAX_SAVE_BYTES };
  if (await copyTree(saves, target, { files: 0, bytes: 0, limits })) return SavesKept.Copied;
  await rm(target, { recursive: true, force: true });
  return SavesKept.TooBig;
}

/**
 * Installs the ask's files into the game for `game`. Every check runs first (nothing written on a
 * refusal); with `replace`, what the project placed before then comes out, the new files are checked
 * again and written; the saves are copied aside before the project's first install; a failure while
 * writing undoes this install.
 */
export function installMod(places: InstallPlaces, game: string, ask: InstallAsk): Promise<InstallDone> {
  return withGame(places.claims, () => installNow(places, game, ask));
}

/** An install, its game's queue held: checks, the claims taken for every file it will write, then the writes. */
async function installNow(places: InstallPlaces, game: string, ask: InstallAsk): Promise<InstallDone> {
  let plan = await planInstall(places, game, ask);
  const before = ask.replace ? await removeNow(places, game) : undefined;
  if (before)
    plan = await planInstall(places, game, ask).catch((error: unknown) => {
      throw new InstallUndone(error, 0, before);
    });
  const record = await readRecord(places.kept, game);
  let saves: SavesKept = SavesKept.Before;
  if (!record.saves) {
    saves = await keepSaves(places, FIRST_SAVES);
    const skipped = saves === SavesKept.TooBig ? { skipped: true as const } : {};
    if (saves !== SavesKept.None) record.saves = { at: new Date().toISOString(), ...skipped };
  }
  const { folder } = await writePlan(places, plan, record).catch((error: unknown) => {
    if (!before) throw error;
    throw new InstallUndone(error, error instanceof InstallUndone ? error.stuck : 0, before);
  });
  const copied = plan.files.length;
  return { copied, replaced: plan.replaced, folder, saves, ...(before ? { before } : {}) };
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

/** What taking one placed file out did. */
const Outcome = {
  Removed: "removed",
  Restored: "restored",
  Skipped: "skipped",
  Changed: "changed",
  Gone: "gone",
} as const;
type Outcome = (typeof Outcome)[keyof typeof Outcome];

/** Takes one placed file out: the kept original goes back, or the file goes; a file changed since, or out of safe reach, stays. */
async function takeOut(places: InstallPlaces, root: string | null, file: PlacedFile): Promise<Outcome> {
  if (!root) return Outcome.Gone;
  const parts = file.path.split("/");
  const target = path.join(root, ...parts);
  if (!isInside(root, target) || !(await plainWay(root, parts.slice(0, -1)))) return Outcome.Skipped;
  const there = await lstat(target).catch(() => null);
  if (there && (there.isSymbolicLink() || !there.isFile())) return Outcome.Skipped;
  if (there && (await digestOf(target)) !== file.sha256) return Outcome.Changed;
  if (file.kept) {
    await copyInto(keptCopy(places, file.root, file.path), target);
    return Outcome.Restored;
  }
  if (there) await unlink(target);
  return there ? Outcome.Removed : Outcome.Gone;
}

/** Removes the folders installs made once they are empty, newest first; those still there stay recorded. */
async function removeFolders(record: InstallRecord, roots: Record<InstallRoot, string | null>) {
  const left: InstallRecord["folders"] = [];
  for (const folder of [...record.folders].reverse()) {
    const root = roots[folder.root];
    const parts = folder.path.split("/");
    // Only an empty folder goes: rmdir refuses one the game or the person put something in since.
    if (root && (await plainWay(root, parts))) await rmdir(path.join(root, ...parts)).catch(() => {});
    if (root && (await folderState(path.join(root, ...parts))) === FolderState.Folder) left.unshift(folder);
  }
  return left;
}

/**
 * Takes every file the project's installs placed out of the game and puts back each game file they
 * replaced. A file the game or the person changed since is left as it is and forgotten; one it
 * can't reach safely (a link on the way) stays recorded with its kept original, for a later Remove
 * mod. The saves stay as they are.
 */
export function removeMod(places: InstallPlaces, game: string): Promise<RemoveDone> {
  return withGame(places.claims, () => removeNow(places, game));
}

/** A removal, its game's queue held. */
async function removeNow(places: InstallPlaces, game: string): Promise<RemoveDone> {
  const record = await readRecord(places.kept, game);
  const done: RemoveDone = { removed: 0, restored: 0, skipped: 0, changed: 0 };
  const roots = {
    [InstallRoot.Mods]: await existingRoot(places, InstallRoot.Mods),
    [InstallRoot.Game]: await existingRoot(places, InstallRoot.Game),
  };
  const kept: PlacedFile[] = [];
  const released: string[] = [];
  for (const file of [...record.files].reverse()) {
    const outcome = await takeOut(places, roots[file.root], file);
    if (outcome === Outcome.Skipped) {
      kept.unshift(file);
      done.skipped++;
      continue;
    }
    if (outcome !== Outcome.Gone) done[outcome]++;
    released.push(claimKey(file.root, file.path));
    if (file.kept) await rm(keptCopy(places, file.root, file.path), { force: true });
  }
  const folders = await removeFolders(record, roots);
  await writeRecord(places.kept, { ...record, files: kept, folders });
  await updateClaims(places.claims, (claims) => {
    for (const key of released) if (claims[key] === places.owner) delete claims[key];
  });
  return done;
}

/** Whether the project has anything in the game now. */
export async function hasInstalled(kept: string, game: string): Promise<boolean> {
  return (await readRecord(kept, game)).files.length > 0;
}

/**
 * Copies the saves kept before the first install back over the game's saves. Today's saves are
 * copied aside first; when they are too big to copy, nothing is put back (refused). False when no
 * saves are kept.
 */
export async function restoreSaves(places: InstallPlaces, game: string): Promise<boolean> {
  const record = await readRecord(places.kept, game);
  const first = path.join(places.kept, SAVES_FOLDER, FIRST_SAVES);
  const kept = record.saves && !record.saves.skipped && (await folderState(first)) === FolderState.Folder;
  if (!kept || !places.saves) return false;
  if ((await keepSaves(places, BEFORE_RESTORE)) === SavesKept.TooBig)
    throw new InstallRefused(InstallProblem.SavesTooBig);
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
