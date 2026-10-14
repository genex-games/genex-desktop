/**
 * One bounded walk of a build's output folder, shared by the Windows and Linux bundle gates and
 * the cross run directory (plan §8.7, M4b). An agent made the folder, so the walk:
 * - lists each folder with `opendir`, one name at a time, and stops the moment the whole walk has
 *   read more names than its entry cap: a hostile folder costs at most `entries + 1` names;
 * - takes every entry's kind from `lstat` (file, folder, link, FIFO, socket or device), never
 *   `stat` and never an open, so a FIFO is never opened and a link is never followed or listed;
 * - refuses an entry deeper than its depth cap before looking at it, a listed name no folder can
 *   hold, and a folder that is not the one it looked at before listing it (swapped meanwhile);
 * - refuses, as the caller asks (all of them by default): links, FIFOs, sockets and devices, a
 *   file with another hard link, and two names one case-insensitive or Unicode-normalising disk
 *   (Windows', the Mac's) would make one file.
 * Its reads are injectable; it never writes and never throws. Entries come depth first, each
 * folder's names in UTF-16 code-unit order.
 *
 * {@link openBundleFile} opens one listed file again for its bytes: never through a link at its
 * name or in a folder above it, never blocking, and only a regular file. {@link readBundleFile}
 * reads such a file whole, when it has no other hard link and is within a size cap.
 */
import { constants as FS, type Stats } from "node:fs";
import { type FileHandle, lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../shared/errors.ts";
import { openNoFollow } from "./fsx.ts";

/** How every bundle file is opened: read-only, never blocking (a FIFO), never as a controlling terminal. */
const OPEN_FLAGS = FS.O_RDONLY | FS.O_NONBLOCK | FS.O_NOCTTY;
/** Characters no listed name holds: the separators this host's paths split at, and NUL. */
const SEPARATOR_OR_NUL = process.platform === "win32" ? /[/\\\0]/ : /[/\0]/;

/** How much of a folder {@link walkBundle} reads before refusing it. */
export interface WalkLimits {
  /** Entries (files, folders and the rest) read in all, below the root. */
  entries: number;
  /** Path segments an entry may have: a top-level name has one. */
  depth: number;
}

/** The caps both gates walk with. */
export const BUNDLE_WALK_LIMITS: WalkLimits = { entries: 10_000, depth: 32 };

/** What one entry is, as `lstat` says. */
export const WalkKind = {
  File: "file",
  Directory: "directory",
  Symlink: "symlink",
  Fifo: "fifo",
  Socket: "socket",
  /** A character or block device, or any other special node. */
  Device: "device",
} as const;
export type WalkKind = (typeof WalkKind)[keyof typeof WalkKind];

/** Why a walk (or an open) stopped. */
export const WalkProblem = {
  /** The root is missing or not a folder. */
  NotAFolder: "not-a-folder",
  /** A folder could not be listed or an entry looked at; a file could not be opened. */
  Unreadable: "unreadable",
  TooManyEntries: "too-many-entries",
  TooDeep: "too-deep",
  /** A folder was not the one looked at before it was listed. */
  Swapped: "swapped",
  /** A listed name (or a path asked for) that no folder can hold: empty, `.`, `..`, a separator or NUL. */
  BadName: "bad-name",
  Symlink: "symlink",
  /** A FIFO, socket or device (or, opened, anything but a regular file). */
  Special: "special",
  HardLink: "hard-link",
  /** A name that only case or Unicode form tells from another in its folder. */
  CaseTwin: "case-twin",
} as const;
export type WalkProblem = (typeof WalkProblem)[keyof typeof WalkProblem];

/** One entry below the root, as `lstat` described it when the walk looked. */
export interface WalkEntry {
  /** `/`-separated, relative to the root. */
  path: string;
  kind: WalkKind;
  /** Hard links (`nlink`). */
  links: number;
  size: number;
  /** The node the walk saw: an open of `path` must find this very file. */
  dev: number;
  ino: number;
}

/** An open folder listing: one name at a time, so a huge folder is never read whole. */
export interface FolderListing {
  read(): Promise<{ name: string } | null>;
  close(): Promise<void>;
}

/** The reads a walk makes; Node's by default, replaced in tests to stage a swap or count the reads. */
export interface BundleReads {
  lstat: (file: string) => Promise<Stats>;
  opendir: (dir: string) => Promise<FolderListing>;
}

/** Node's own `lstat` and `opendir`. */
export const NODE_BUNDLE_READS: BundleReads = { lstat, opendir };

/** What a walk refuses besides its caps, a swapped folder and an impossible name. */
export interface WalkRefusals {
  symlinks: boolean;
  /** FIFOs, sockets and devices. */
  specials: boolean;
  /** Regular files with more than one link. */
  hardLinks: boolean;
  /** Two names in one folder that only case or Unicode form tells apart. */
  caseTwins: boolean;
}

/** Refuse none of {@link WalkRefusals}: report every entry and let the caller judge it. */
export const WALK_REPORT_ONLY: WalkRefusals = { symlinks: false, specials: false, hardLinks: false, caseTwins: false };

/** How {@link walkBundle} walks: its caps, its reads and what it refuses (everything by default). */
export interface WalkOptions {
  limits?: Partial<WalkLimits>;
  reads?: BundleReads;
  refuse?: Partial<WalkRefusals>;
}

/** A refused walk or open: why, the path it is about (`.` for the root) and a sentence for logs. */
export interface WalkRefused {
  ok: false;
  problem: WalkProblem;
  path: string;
  detail: string;
}

/** A walk's answer: every entry, or the first refusal. */
export type BundleWalk = { ok: true; entries: WalkEntry[] } | WalkRefused;

/** A bundle file opened by {@link openBundleFile}: the caller reads it and closes the handle. */
export interface OpenedBundleFile {
  ok: true;
  handle: FileHandle;
  info: Stats;
}

const MESSAGE = {
  NotAFolder: (root: string) => `${root} is not a folder`,
  Unreadable: (where: string, why: string) => `${where} cannot be read: ${why}`,
  TooMany: (cap: number) => `the folder holds more than ${cap} entries`,
  TooDeep: (where: string, cap: number) => `${where} is more than ${cap} folders deep`,
  Swapped: (where: string) => `${where} changed while it was being listed`,
  BadName: (where: string) => `${JSON.stringify(where)} is not a name a folder holds`,
  Link: (where: string) => `${where} is a link or is reached through one`,
  Special: (where: string) => `${where} is not a regular file or folder`,
  HardLink: (where: string) => `${where} has another hard link`,
  CaseTwin: (where: string) => `${JSON.stringify(where)} is another entry's name on a disk that ignores case`,
  TooLarge: (where: string, cap: number) => `${where} is larger than the ${cap} bytes read of it`,
} as const;

/** The message each policy refusal carries. */
const POLICY_MESSAGE = {
  [WalkProblem.Symlink]: MESSAGE.Link,
  [WalkProblem.Special]: MESSAGE.Special,
  [WalkProblem.HardLink]: MESSAGE.HardLink,
} as const;

const SPECIAL_KINDS: ReadonlySet<WalkKind> = new Set([WalkKind.Fifo, WalkKind.Socket, WalkKind.Device]);

const refused = (problem: WalkProblem, where: string, detail: string): WalkRefused => ({
  ok: false,
  problem,
  path: where,
  detail,
});

/** A refusal inside the walk, caught at {@link walkBundle}'s boundary. */
class WalkStop extends Error {
  readonly refusal: WalkRefused;

  constructor(refusal: WalkRefused) {
    super(refusal.detail);
    this.name = "WalkStop";
    this.refusal = refusal;
  }
}

const stop = (problem: WalkProblem, where: string, detail: string) => new WalkStop(refused(problem, where, detail));

/** One walk's settings and progress. */
interface Walk {
  root: string;
  limits: WalkLimits;
  reads: BundleReads;
  refuse: WalkRefusals;
  /** Names read so far, in every folder. */
  names: number;
  entries: WalkEntry[];
}

const sameNode = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;

/** Whether `after` is still the folder `before` described: a folder, not a link, the same node. */
function isSameFolder(before: Stats, after: Stats | null): boolean {
  if (!after?.isDirectory() || after.isSymbolicLink()) return false;
  return sameNode(before, after);
}
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : Number(a > b));

/**
 * The key two names share when a case-insensitive or Unicode-normalising disk makes them one
 * file: NFC, then upper case (as NTFS's upcase table compares; `ς` and `σ` meet there).
 */
export function foldedName(name: string): string {
  return name.normalize("NFC").toUpperCase();
}

/** Whether a folder can hold `name` as one entry: not empty, not a path step, no separator or NUL. */
function isEntryName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !SEPARATOR_OR_NUL.test(name);
}

function kindOf(info: Stats): WalkKind {
  if (info.isSymbolicLink()) return WalkKind.Symlink;
  if (info.isDirectory()) return WalkKind.Directory;
  if (info.isFile()) return WalkKind.File;
  if (info.isFIFO()) return WalkKind.Fifo;
  if (info.isSocket()) return WalkKind.Socket;
  return WalkKind.Device;
}

/** The refusal the caller's policy gives an entry of `kind`, or null. */
function policyProblem(refuse: WalkRefusals, kind: WalkKind, links: number): keyof typeof POLICY_MESSAGE | null {
  if (kind === WalkKind.Symlink) return refuse.symlinks ? WalkProblem.Symlink : null;
  if (SPECIAL_KINDS.has(kind)) return refuse.specials ? WalkProblem.Special : null;
  const hardLinked = kind === WalkKind.File && links > 1;
  return hardLinked && refuse.hardLinks ? WalkProblem.HardLink : null;
}

/** A folder's names, read one at a time and refused once the walk has read more than its cap. */
async function readNames(walk: Walk, dir: string, where: string): Promise<string[]> {
  const listing = await walk.reads.opendir(dir).catch((error: unknown) => {
    throw stop(WalkProblem.Unreadable, where, MESSAGE.Unreadable(where, errorMessage(error)));
  });
  const names: string[] = [];
  try {
    for (let next = await listing.read(); next !== null; next = await listing.read()) {
      if (walk.names >= walk.limits.entries) {
        throw stop(WalkProblem.TooManyEntries, where, MESSAGE.TooMany(walk.limits.entries));
      }
      walk.names += 1;
      names.push(next.name);
    }
  } catch (error) {
    if (error instanceof WalkStop) throw error;
    throw stop(WalkProblem.Unreadable, where, MESSAGE.Unreadable(where, errorMessage(error)));
  } finally {
    await listing.close().catch(() => {});
  }
  return names.sort(byCodeUnit);
}

/** Refuses the first sorted name no folder holds, then (when asked) the first that folds onto an earlier one. */
function checkNames(walk: Walk, segments: readonly string[], names: readonly string[]): void {
  const folded = new Set<string>();
  for (const name of names) {
    const where = [...segments, name].join("/");
    if (!isEntryName(name)) throw stop(WalkProblem.BadName, where, MESSAGE.BadName(where));
    if (!walk.refuse.caseTwins) continue;
    const key = foldedName(name);
    if (folded.has(key)) throw stop(WalkProblem.CaseTwin, where, MESSAGE.CaseTwin(where));
    folded.add(key);
  }
}

/** Lists the folder `before` described, refusing it if it is not that folder once listed, then walks its entries. */
async function walkFolder(walk: Walk, segments: readonly string[], before: Stats): Promise<void> {
  const where = segments.join("/") || ".";
  const dir = path.join(walk.root, ...segments);
  const names = await readNames(walk, dir, where);
  const after = await walk.reads.lstat(dir).catch(() => null);
  if (!isSameFolder(before, after)) throw stop(WalkProblem.Swapped, where, MESSAGE.Swapped(where));
  checkNames(walk, segments, names);
  for (const name of names) await walkEntry(walk, [...segments, name]);
}

/** Looks at one entry (refused past the depth cap before any look) and walks into it when it is a folder. */
async function walkEntry(walk: Walk, segments: readonly string[]): Promise<void> {
  const where = segments.join("/");
  if (segments.length > walk.limits.depth) {
    throw stop(WalkProblem.TooDeep, where, MESSAGE.TooDeep(where, walk.limits.depth));
  }
  const info = await walk.reads.lstat(path.join(walk.root, ...segments)).catch((error: unknown) => {
    throw stop(WalkProblem.Unreadable, where, MESSAGE.Unreadable(where, errorMessage(error)));
  });
  const kind = kindOf(info);
  const problem = policyProblem(walk.refuse, kind, info.nlink);
  if (problem !== null) throw stop(problem, where, POLICY_MESSAGE[problem](where));
  walk.entries.push({ path: where, kind, links: info.nlink, size: info.size, dev: info.dev, ino: info.ino });
  if (kind === WalkKind.Directory) await walkFolder(walk, segments, info);
}

/** The walk's settings: the options' values where given, the defaults elsewhere. */
function settings(root: string, options: WalkOptions): Walk {
  const { limits, refuse } = options;
  return {
    root,
    limits: {
      entries: limits?.entries ?? BUNDLE_WALK_LIMITS.entries,
      depth: limits?.depth ?? BUNDLE_WALK_LIMITS.depth,
    },
    reads: options.reads ?? NODE_BUNDLE_READS,
    refuse: {
      symlinks: refuse?.symlinks ?? true,
      specials: refuse?.specials ?? true,
      hardLinks: refuse?.hardLinks ?? true,
      caseTwins: refuse?.caseTwins ?? true,
    },
    names: 0,
    entries: [],
  };
}

/**
 * Every entry below `root`, read without following a link or opening anything, within the caps;
 * or the first refusal. Never writes, never throws.
 */
export async function walkBundle(root: string, options: WalkOptions = {}): Promise<BundleWalk> {
  const walk = settings(root, options);
  try {
    const top = await walk.reads.lstat(root).catch(() => null);
    if (top?.isSymbolicLink()) return refused(WalkProblem.Symlink, ".", MESSAGE.Link(root));
    if (!top?.isDirectory()) return refused(WalkProblem.NotAFolder, ".", MESSAGE.NotAFolder(root));
    await walkFolder(walk, [], top);
    return { ok: true, entries: walk.entries };
  } catch (error) {
    if (error instanceof WalkStop) return error.refusal;
    return refused(WalkProblem.Unreadable, ".", MESSAGE.Unreadable(root, errorMessage(error)));
  }
}

/** How {@link openBundleFile} opens: the root's real path when the caller has it, and the look at each folder above the file. */
export interface OpenBundleFileOptions {
  realRoot?: string;
  /** Node's `lstat` by default; a test stages a folder swapped for a link after this look. */
  lstat?: BundleReads["lstat"];
}

/** Refuses a path whose folders are not plain folders under the root, looked at before anything is opened. */
async function folderProblem(
  root: string,
  segments: readonly string[],
  where: string,
  look: BundleReads["lstat"],
): Promise<WalkRefused | null> {
  for (let depth = 1; depth < segments.length; depth++) {
    const info = await look(path.join(root, ...segments.slice(0, depth))).catch(() => null);
    if (info?.isSymbolicLink()) return refused(WalkProblem.Symlink, where, MESSAGE.Link(where));
    if (!info?.isDirectory()) return refused(WalkProblem.Unreadable, where, MESSAGE.Unreadable(where, "no folder"));
  }
  return null;
}

/**
 * Null when the opened `handle` is the regular file now at `file`, reached through no link:
 * the name still names the handle's node, and its real path is the root's real path joined with
 * the segments. Else the refusal.
 */
async function openedProblem(
  handle: FileHandle,
  file: string,
  expected: () => Promise<string>,
  where: string,
): Promise<{ info: Stats } | WalkRefused> {
  const info = await handle.stat();
  if (!info.isFile()) return refused(WalkProblem.Special, where, MESSAGE.Special(where));
  const named = await lstat(file);
  const same = !named.isSymbolicLink() && sameNode(info, named) && (await realpath(file)) === (await expected());
  return same ? { info } : refused(WalkProblem.Symlink, where, MESSAGE.Link(where));
}

/**
 * Opens the regular file at `relative` (`/`-separated) under `root` for reading: never through a
 * link at its name or in a folder above it (each folder is looked at first, and after the open the
 * name must still be the handle's node at the real path the root and segments spell), never
 * blocking on a FIFO, never a folder or device. The caller reads it, judges its link count, and
 * closes the handle. Never throws.
 */
export async function openBundleFile(
  root: string,
  relative: string,
  options: OpenBundleFileOptions = {},
): Promise<OpenedBundleFile | WalkRefused> {
  const segments = relative.split("/");
  if (!segments.every(isEntryName)) return refused(WalkProblem.BadName, relative, MESSAGE.BadName(relative));
  const folders = await folderProblem(root, segments, relative, options.lstat ?? lstat);
  if (folders) return folders;
  const file = path.join(root, ...segments);
  let handle: FileHandle;
  try {
    handle = await openNoFollow(file, OPEN_FLAGS);
  } catch (error) {
    const link = (error as NodeJS.ErrnoException).code === "ELOOP";
    if (link) return refused(WalkProblem.Symlink, relative, MESSAGE.Link(relative));
    return refused(WalkProblem.Unreadable, relative, MESSAGE.Unreadable(relative, errorMessage(error)));
  }
  const expected = async () => path.join(options.realRoot ?? (await realpath(root)), ...segments);
  const checked = await openedProblem(handle, file, expected, relative).catch(
    (error: unknown): WalkRefused =>
      refused(WalkProblem.Unreadable, relative, MESSAGE.Unreadable(relative, errorMessage(error))),
  );
  if ("info" in checked) return { ok: true, handle, info: checked.info };
  await handle.close().catch(() => {});
  return checked;
}

/** How {@link readBundleFile} reads: as {@link openBundleFile} opens, and at most `maxBytes`. */
export interface ReadBundleFileOptions extends OpenBundleFileOptions {
  maxBytes: number;
}

/** Up to `size` bytes of `handle` from its start; fewer when the file ends first. */
async function readFromStart(handle: FileHandle, size: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(size);
  let total = 0;
  while (total < size) {
    const { bytesRead } = await handle.read(bytes, total, size - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return bytes.subarray(0, total);
}

/**
 * The bytes of the regular file at `relative` under `root`, opened as {@link openBundleFile} opens
 * it (no link at its name or above it, never blocking), when it has no other hard link and is at
 * most `maxBytes` long; else the refusal. Reads no more than the size it had when opened. Never
 * throws and never writes.
 */
export async function readBundleFile(
  root: string,
  relative: string,
  options: ReadBundleFileOptions,
): Promise<{ ok: true; bytes: Uint8Array } | WalkRefused> {
  const opened = await openBundleFile(root, relative, options);
  if (!opened.ok) return opened;
  const { handle, info } = opened;
  try {
    if (info.nlink > 1) return refused(WalkProblem.HardLink, relative, MESSAGE.HardLink(relative));
    if (info.size > options.maxBytes)
      return refused(WalkProblem.Unreadable, relative, MESSAGE.TooLarge(relative, options.maxBytes));
    return { ok: true, bytes: await readFromStart(handle, info.size) };
  } catch (error) {
    return refused(WalkProblem.Unreadable, relative, MESSAGE.Unreadable(relative, errorMessage(error)));
  } finally {
    await handle.close().catch(() => {});
  }
}
