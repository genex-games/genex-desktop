/**
 * How much space a game's version history takes, and clearing the side tracks Genex alone keeps
 * beside it: Rewind's saved copies (`refs/studio/chat/**`) and the tracks of runs that ended
 * (`refs/studio/runs/<run>/**`). The person's branches, tags, remotes, HEAD, worktrees and save
 * points (`refs/studio/snap/**`) are never touched, no commit is rewritten and reflogs stay, so
 * only objects nothing else reaches are removed; the only worktrees forgotten are Genex's own
 * copies under its scratch folder whose folder is gone.
 */
import { lstat, readdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { HOUR_MS, SECOND_MS } from "../shared/duration.ts";
import { type GameHistoryCleared, type GameHistorySpace, REWIND_REFS, RUN_REFS } from "../shared/game-history.ts";
import { isBelow } from "./paths.ts";
import { git, gitOrNull } from "./snapshots.ts";

const BYTES_PER_KIB = 1024;
/**
 * How old an object nothing reaches must be before clearing removes it, as git's own `gc` keeps
 * a grace: a save point, a checkpoint or the person's own commit may have just written objects it
 * has not committed yet, and those must survive a clear that runs beside it.
 */
const UNREACHABLE_GRACE_MS = HOUR_MS;
/** The `git count-objects -v` fields that measure the repository on disk, in KiB. */
const SIZE_FIELDS: ReadonlySet<string> = new Set(["size", "size-pack", "size-garbage"]);
/** What `git worktree list --porcelain` names a worktree with no commit yet. */
const NO_COMMIT = /^0+$/;
/** An object id as git prints it, at the start of a line. */
const OBJECT_ID = /^[0-9a-f]{40,64}$/;
/** The hex digits of an object id that name its loose file's folder. */
const LOOSE_FOLDER_CHARS = 2;
/** A pack index of version 2 or later: its magic number, then the version. */
const PACK_INDEX_MAGIC = 0xff744f63;
/** The fan-out table of a pack index: 256 counts of 4 bytes, the last the object count. */
const FANOUT_ENTRIES = 256;
const FANOUT_BYTES = 4;
/** Where a version-2 pack index's fan-out starts (after magic and version), and a version-1's. */
const V2_FANOUT_AT = 8;
/** A version-1 pack index entry's offset before its object id. */
const V1_OFFSET_BYTES = 4;

const MESSAGE = {
  notASideTrack: (ref: string) => `Refused to delete ${ref}: it is not one of Genex's side tracks.`,
} as const;

const NOTHING_CLEARED: GameHistoryCleared = { removedTracks: 0, freedBytes: 0 };
const NO_SPACE: GameHistorySpace = {
  totalBytes: 0,
  clearableBytes: 0,
  recentBytes: 0,
  rewindTracks: 0,
  finishedRunTracks: 0,
};

/** Where Genex makes its copies of a game (the studio's scratch folder); none forgets no worktree. */
export interface ClearOptions {
  scratch?: string;
}

/** Objects on disk: what a clear removes now, and what it keeps until the grace has passed. */
interface Measured {
  oldBytes: number;
  recentBytes: number;
}

/** The side tracks clearing would remove, by kind. */
interface SideTracks {
  rewind: string[];
  runs: string[];
}

/** The run a ref under `refs/studio/runs/` belongs to, or null for any other ref. */
function runOf(ref: string): string | null {
  if (!ref.startsWith(RUN_REFS)) return null;
  const [run, ...rest] = ref.slice(RUN_REFS.length).split("/");
  return run && rest.length > 0 ? run : null;
}

/** Whether clearing may delete `ref`: one of Rewind's, or of a run in `finishedRuns`. */
function isClearable(ref: string, finishedRuns: ReadonlySet<string>): boolean {
  if (ref.split("/").some((part) => part === "" || part === "." || part === "..")) return false;
  if (ref.startsWith(REWIND_REFS)) return true;
  const run = runOf(ref);
  return run !== null && finishedRuns.has(run);
}

/**
 * Whether `dir` is the top of a repository of its own, keeping its refs and objects in its own
 * `.git`. A folder inside another repository would otherwise read and clear the enclosing one's
 * tracks, and a linked worktree shares its main repository's, every other game's in it included.
 */
async function ownRepository(dir: string): Promise<boolean> {
  const answer = await gitOrNull(dir, ["rev-parse", "--show-toplevel", "--git-common-dir"]);
  const [top, common] = (answer ?? "").split("\n").map((line) => line.trim());
  if (!top || !common) return false;
  try {
    const [mine, its, store, own] = await Promise.all([
      realpath(dir),
      realpath(top),
      realpath(path.resolve(dir, common)),
      realpath(path.join(dir, ".git")),
    ]);
    return mine === its && store === own;
  } catch {
    return false;
  }
}

/** What nothing reaches any more and a clear would remove now: copies an earlier clear left. */
async function leftOver(dir: string): Promise<number> {
  return (await measure(dir, await unreachedLoose(dir), Date.now())).oldBytes;
}

/** The grace as git reads an expiry date. */
const graceExpiry = (): string => `${Math.round(UNREACHABLE_GRACE_MS / SECOND_MS)}.seconds.ago`;

/** Every ref of the repository, by its full name. */
async function allRefs(dir: string): Promise<string[]> {
  return (await git(dir, ["for-each-ref", "--format=%(refname)"])).split("\n").filter(Boolean);
}

async function sideTracks(dir: string, finishedRuns: ReadonlySet<string>): Promise<SideTracks> {
  const listed = await git(dir, ["for-each-ref", "--format=%(refname)", REWIND_REFS, RUN_REFS]);
  const clearable = listed.split("\n").filter((ref) => ref && isClearable(ref, finishedRuns));
  return {
    rewind: clearable.filter((ref) => ref.startsWith(REWIND_REFS)),
    runs: clearable.filter((ref) => ref.startsWith(RUN_REFS)),
  };
}

/** The repository's objects on disk, loose, packed and garbage, in bytes. */
async function totalBytes(dir: string): Promise<number> {
  let kib = 0;
  for (const line of (await git(dir, ["count-objects", "-v"])).split("\n")) {
    const [field, value] = line.split(": ");
    if (field && SIZE_FIELDS.has(field)) kib += Number(value) || 0;
  }
  return kib * BYTES_PER_KIB;
}

/** The commit each worktree of the repository has checked out. */
async function worktreeHeads(dir: string): Promise<string[]> {
  return (await git(dir, ["worktree", "list", "--porcelain"]))
    .split("\n")
    .filter((line) => line.startsWith("HEAD "))
    .map((line) => line.slice("HEAD ".length).trim())
    .filter((commit) => commit && !NO_COMMIT.test(commit));
}

/** The ids of the objects only `side` reaches: objects no other ref, HEAD or worktree reaches. */
async function onlyReachedBy(dir: string, side: readonly string[]): Promise<string[]> {
  if (side.length === 0) return [];
  const sideRefs = new Set(side);
  const others = (await allRefs(dir)).filter((ref) => !sideRefs.has(ref));
  const excluded = [...others, "HEAD", ...(await worktreeHeads(dir))].map((rev) => `^${rev}`);
  const input = `${[...side, ...excluded].join("\n")}\n`;
  const listed = await git(dir, ["rev-list", "--objects", "--ignore-missing", "--stdin"], {}, input);
  return objectIds(listed);
}

/** The loose objects nothing reaches any more, whatever their age (`prune` lists them, removing none). */
async function unreachedLoose(dir: string): Promise<string[]> {
  return objectIds(await git(dir, ["prune", "--dry-run", "--expire=now"]));
}

/** The object id at the start of each line. */
function objectIds(listing: string): string[] {
  return listing
    .split("\n")
    .map((line) => line.split(" ")[0] ?? "")
    .filter((id) => OBJECT_ID.test(id));
}

/** The object ids a pack index lists (version 1 or 2), each `idBytes` long. */
function packIndexIds(index: Buffer, idBytes: number): string[] {
  const v2 = index.length >= V2_FANOUT_AT && index.readUInt32BE(0) === PACK_INDEX_MAGIC;
  const fanout = v2 ? V2_FANOUT_AT : 0;
  const tableEnd = fanout + FANOUT_ENTRIES * FANOUT_BYTES;
  if (index.length < tableEnd) return [];
  const count = index.readUInt32BE(tableEnd - FANOUT_BYTES);
  const stride = v2 ? idBytes : V1_OFFSET_BYTES + idBytes;
  const skip = v2 ? 0 : V1_OFFSET_BYTES;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = tableEnd + i * stride + skip;
    if (at + idBytes > index.length) break;
    ids.push(index.toString("hex", at, at + idBytes));
  }
  return ids;
}

/**
 * The objects of packs written within the grace. A clear never drops these: git takes an object
 * nothing reaches out of such a pack as a loose object with the pack's time, which the grace keeps.
 */
async function recentlyPacked(objects: string, idBytes: number, since: number): Promise<Set<string>> {
  const packs = path.join(objects, "pack");
  const recent = new Set<string>();
  for (const name of await readdir(packs).catch(() => [] as string[])) {
    if (!name.endsWith(".pack")) continue;
    const written = (await lstat(path.join(packs, name)).catch(() => null))?.mtimeMs ?? 0;
    if (written <= since) continue;
    const index = await readFile(path.join(packs, name.replace(/\.pack$/, ".idx"))).catch(() => null);
    for (const id of index ? packIndexIds(index, idBytes) : []) recent.add(id);
  }
  return recent;
}

/**
 * The disk size of these objects, split by whether a clear removes them now or only once the grace
 * has passed: a loose object by its own time, a packed one by its pack's, as git's `prune` and
 * `repack` decide.
 */
async function measure(dir: string, ids: readonly string[], now: number): Promise<Measured> {
  const measured: Measured = { oldBytes: 0, recentBytes: 0 };
  if (ids.length === 0) return measured;
  const since = now - UNREACHABLE_GRACE_MS;
  const objects = path.resolve(dir, (await git(dir, ["rev-parse", "--git-path", "objects"])).trim());
  const sizes = await git(
    dir,
    ["cat-file", "--batch-check=%(objectname) %(objectsize:disk)"],
    {},
    `${ids.join("\n")}\n`,
  );
  let packed: Set<string> | undefined;
  for (const line of sizes.split("\n")) {
    const [id = "", size = ""] = line.split(" ");
    const bytes = Number(size);
    if (!OBJECT_ID.test(id) || !Number.isFinite(bytes)) continue;
    const loose = path.join(objects, id.slice(0, LOOSE_FOLDER_CHARS), id.slice(LOOSE_FOLDER_CHARS));
    const looseAt = (await lstat(loose).catch(() => null))?.mtimeMs;
    packed ??= looseAt === undefined ? await recentlyPacked(objects, id.length / 2, since) : undefined;
    const recent = looseAt === undefined ? (packed?.has(id) ?? false) : looseAt > since;
    if (recent) measured.recentBytes += bytes;
    else measured.oldBytes += bytes;
  }
  return measured;
}

/**
 * How much space `dir`'s history takes; how much of it a clear frees now: what only Rewind and runs
 * in `finishedRuns` hold, and copies an earlier clear could not free yet, once older than the
 * grace; and how much of that is too recent to free before a later clear.
 */
export async function historySpace(dir: string, finishedRuns: ReadonlySet<string>): Promise<GameHistorySpace> {
  if (!(await ownRepository(dir))) return NO_SPACE;
  // git's own clock decides what a clear removes (`graceExpiry`), so the measure reads the same one.
  const now = Date.now();
  const side = await sideTracks(dir, finishedRuns);
  const held = await measure(dir, await onlyReachedBy(dir, [...side.rewind, ...side.runs]), now);
  const left = await measure(dir, await unreachedLoose(dir), now);
  return {
    totalBytes: await totalBytes(dir),
    clearableBytes: held.oldBytes + left.oldBytes,
    recentBytes: held.recentBytes + left.recentBytes,
    rewindTracks: side.rewind.length,
    finishedRunTracks: side.runs.length,
  };
}

/** `scratch` as written and as resolved through its links: a worktree's recorded path may be either. */
async function scratchRoots(scratch: string | undefined): Promise<string[]> {
  if (!scratch) return [];
  const written = path.resolve(scratch);
  const real = await realpath(written).catch(() => written);
  return [...new Set([written, real])];
}

/**
 * The administrative folders of Genex's own copies whose folder is gone: a linked worktree under
 * the scratch folder, not locked, whose `.git` file no longer exists. Any other worktree, the
 * person's on a drive that is not mounted now among them, is never forgotten.
 */
async function goneCopies(dir: string, scratch: string | undefined): Promise<string[]> {
  const roots = await scratchRoots(scratch);
  if (roots.length === 0) return [];
  const admin = path.resolve(dir, (await git(dir, ["rev-parse", "--git-path", "worktrees"])).trim());
  const gone: string[] = [];
  for (const entry of await readdir(admin, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const own = path.join(admin, entry.name);
    if ((await lstat(path.join(own, "locked")).catch(() => null)) !== null) continue;
    const recorded = (await readFile(path.join(own, "gitdir"), "utf8").catch(() => "")).trim();
    if (!recorded) continue;
    const gitFile = path.resolve(own, recorded);
    const ours = roots.some((root) => isBelow(root, path.dirname(gitFile)));
    if (ours && (await lstat(gitFile).catch(() => null)) === null) gone.push(own);
  }
  return gone;
}

/**
 * Delete Rewind's tracks and those of runs in `finishedRuns` in one transaction, forget Genex's
 * own copies under `scratch` whose folder is gone, then remove the objects nothing reaches any more
 * and that are older than `UNREACHABLE_GRACE_MS`, as `gc` would: also what an earlier clear left
 * for being too recent. Never `gc`, `worktree prune` or a reflog expiry: a reflog keeps what it
 * reaches, and a worktree of the person's whose folder is missing now keeps its commits.
 */
export async function clearSideTracks(
  dir: string,
  finishedRuns: ReadonlySet<string>,
  options: ClearOptions = {},
): Promise<GameHistoryCleared> {
  if (!(await ownRepository(dir))) return NOTHING_CLEARED;
  const side = await sideTracks(dir, finishedRuns);
  const refs = [...side.rewind, ...side.runs];
  for (const ref of refs) if (!isClearable(ref, finishedRuns)) throw new Error(MESSAGE.notASideTrack(ref));
  const gone = await goneCopies(dir, options.scratch);
  const nothingToDo = refs.length === 0 && gone.length === 0;
  if (nothingToDo && (await leftOver(dir)) === 0) return NOTHING_CLEARED;
  const before = await totalBytes(dir);
  if (refs.length > 0) await git(dir, ["update-ref", "--stdin"], {}, refs.map((ref) => `delete ${ref}\n`).join(""));
  for (const own of gone) await rm(own, { recursive: true, force: true });
  const expiry = graceExpiry();
  // -A keeps a packed object nothing reaches loose while it is younger than the grace, so the
  // prune that follows decides about it like any other loose object.
  await git(dir, ["repack", "-A", "-d", "-q", `--unpack-unreachable=${expiry}`]);
  await git(dir, ["prune", `--expire=${expiry}`]);
  return { removedTracks: refs.length, freedBytes: Math.max(0, before - (await totalBytes(dir))) };
}
