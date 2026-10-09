import { createHash } from "node:crypto";
import os from "node:os";
/**
 * File ownership for a contractor with no edit-time hook — the Codex path.
 *
 * Claude Code enforces ownership with a `PreToolUse` hook: a Write outside the facet's files is
 * refused before it lands, with the reason in the contractor's face. Codex has no equivalent we
 * can drive from here, so the rule is written into the filesystem instead: every file the facet
 * does not own is made read-only for the length of the delegation, and restored after. The
 * failed write then comes back in the contractor's own words, from a lower layer.
 *
 * **How strong this is, honestly.** A read-only *mode* is a wall a determined contractor can
 * walk round: it owns the files, so `chmod u+w` is available to it, and the first live build to
 * meet these locks did exactly that. Two things narrow the gap — the brief says plainly that the
 * locks are the rule and not an accident, and the engine re-applies them the moment it sees a
 * `chmod` go by, which usually lands between the unlock and the write. Neither is the boundary a
 * hook gives you, and the difference is stated here rather than papered over. What
 * makes it proportionate is that a facet already builds in a worktree of its own: the damage
 * ownership exists to prevent — a stray edit destroying another facet's merged work — is impossible
 * there, and a stray edit inside the worktree is what the code review and the merge are for.
 *
 * The locks are recorded in a marker file before they are applied, so a build that dies with
 * the app (a crash, a force-quit) leaves something the next delegation can undo. Without that,
 * a workspace could be left permanently unwritable by a failure that had nothing to do with it.
 */
import { constants, type Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { allowedFile, specOf, entryFiles } from "../ownership.ts";
import type { Ownership } from "../ownership.ts";
import { openNoFollow, readRegularFile } from "../fsx.ts";
import { StudioPlatform } from "../../shared/boot.ts";

const execFileAsync = promisify(execFile);

/** A marker is a list of paths; anything bigger than this is not one the studio wrote. */
const MAX_MARKER_BYTES = 4 * 1024 * 1024;

/** Legacy recovery marker: read during migration, never written by new delegations. */
const MARKER = path.join(".studio-locks.json");

/** Never walked: version control, vendored packages, and the studio's own bridge. */
const SKIP_DIRS = new Set([".git", "node_modules", ".studio", "dist", "build"]);

/**
 * Never locked, whatever the ownership says. Two kinds of file live here.
 *
 * A LOCKFILE and `.npmrc` are rewritten by `npm install`, which a build step runs as a matter
 * of course; they are present in every real repository and they are what actually breaks a
 * build when they are read-only — an EACCES from a package manager reads as a broken machine,
 * not as a rule. The rest are build artefacts and bundler caches a build regenerates.
 *
 * WHAT THIS MECHANISM IS. The walk sees files that already exist, so this is the set of
 * pre-existing artefacts the locks leave alone. Directories are never chmodded, so a build can
 * always CREATE a file anywhere — including inside a directory whose current contents are
 * locked. The locks are a rule the builder can read, not a sandbox.
 */
const NEVER_LOCK: ReadonlyArray<RegExp> = [
  /^(?:.*\/)?package-lock\.json$/,
  /^(?:.*\/)?npm-shrinkwrap\.json$/,
  /^(?:.*\/)?yarn\.lock$/,
  /^(?:.*\/)?pnpm-lock\.yaml$/,
  /^(?:.*\/)?bun\.lockb?$/,
  /^(?:.*\/)?\.npmrc$/,
  /^(?:.*\/)?[^/]+\.tsbuildinfo$/,
  /(?:^|\/)\.vite\//,
  /(?:^|\/)\.parcel-cache\//,
  /(?:^|\/)\.turbo\//,
  /(?:^|\/)\.next\//,
  /(?:^|\/)\.nuxt\//,
  /(?:^|\/)\.svelte-kit\//,
  /(?:^|\/)\.cache\//,
];

/**
 * Is this file one the locks must leave writable? `neverLock` names directory PREFIXES (or
 * exact paths) matched against the accumulated relative path — a shape's serve directory may
 * be nested (`packages/game/out`), so matching the last path segment would never see it.
 */
export function neverLocked(rel: string, neverLock: readonly string[] = []): boolean {
  const file = String(rel ?? "");
  if (NEVER_LOCK.some((re) => re.test(file))) return true;
  return neverLock.some((raw) => {
    const prefix = String(raw ?? "")
      .trim()
      .replace(/^\.\//, "")
      .replace(/\/+$/, "");
    if (!prefix || prefix === ".") return false;
    return file === prefix || file.startsWith(`${prefix}/`);
  });
}

/**
 * The host's ownership-lock records, in a folder beside the engine homes and never inside one: any
 * folder in a Codex home reads as a sign-in (`hasCredentials`), and Codex runs with that home. The
 * app keeps its engine homes side by side in one folder no agent may read; Codex and OpenCode share it.
 */
export const LOCK_RECOVERY_DIR = "ownership-locks";

export interface LockRecord {
  facetId: string;
  at: string;
  files: Array<{ file: string; mode: number }>;
}

/**
 * Make every file the facet does not own read-only. Returns the marker's contents so a caller
 * can release exactly what it took, and nothing else.
 */
export async function lockUnowned(cwd: string, ownership: Ownership, recoveryRoot?: string): Promise<LockRecord> {
  await releaseStaleLocks(cwd, recoveryRoot);
  const root = path.resolve(cwd);
  const record: LockRecord = { facetId: ownership.facetId, at: new Date().toISOString(), files: [] };
  for await (const rel of walk(root, "")) {
    if (neverLocked(rel, ownership.neverLock ?? [])) continue;
    if (allowedFile(rel, specOf(ownership), ownership.ownsMain)) continue;
    const full = path.join(root, rel);
    let mode: number;
    try {
      mode = (await stat(full)).mode & 0o7777;
    } catch {
      continue;
    }
    // Already read-only for its owner: nothing of ours to undo later, so nothing to record.
    if ((mode & 0o200) === 0) continue;
    record.files.push({ file: rel, mode });
  }
  if (!record.files.length) return record;
  // Marker first: a crash between here and the last chmod must still be undoable. Created fresh
  // and exclusively: whatever sits at that name is the contractor's, possibly a link to anywhere.
  await rm(path.join(root, MARKER), { force: true, recursive: true });
  await writeFile(await recoveryFile(root, recoveryRoot), JSON.stringify(record), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  for (const entry of record.files) await chmodInside(root, entry.file, (mode) => mode & ~0o222);
  return record;
}

/**
 * Give every locked file back the write bits the lock took, and drop the marker. Only those
 * bits: the marker sits in the contractor's workspace, so its `mode` is a claim, not an order.
 * A marker read from disk gives back at most the owner's write bit ({@link readMarker}).
 */
export async function releaseLocks(cwd: string, record: LockRecord | null, recoveryRoot?: string): Promise<void> {
  const root = path.resolve(cwd);
  const files = record?.files ?? (await readMarker(root, recoveryRoot))?.files ?? [];
  for (const entry of files) {
    const taken = Number(entry?.mode) & 0o222;
    await chmodInside(root, entry?.file, (mode) => mode | taken);
  }
  await rm(path.join(root, MARKER), { force: true }).catch(() => {});
  await rm(await recoveryFile(root, recoveryRoot), { force: true }).catch(() => {});
}

/**
 * Change one workspace file's mode, and only a file that really is in the workspace (PH-2). The
 * marker and every file it names are the contractor's to rewrite, and this runs in the studio,
 * outside every sandbox: a path that climbs out, a link, or a file under a linked folder is
 * skipped. The mode is changed through a handle opened without following links, so the file
 * checked is the file changed.
 */
async function chmodInside(root: string, rel: unknown, next: (mode: number) => number): Promise<void> {
  if (typeof rel !== "string" || !rel || path.isAbsolute(rel)) return;
  const full = path.resolve(root, rel);
  const outside = (from: string, to: string) => {
    const relative = path.relative(from, to);
    return !relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  };
  if (outside(root, full)) return;
  try {
    const [realRoot, realParent] = await Promise.all([realpath(root), realpath(path.dirname(full))]);
    if (realParent !== realRoot && outside(realRoot, realParent)) return;
    let handle: FileHandle;
    try {
      // Non-blocking: a FIFO planted under a locked name must not hold this open forever (M4).
      // Never through a link, on Windows too, where there is no O_NOFOLLOW (`openNoFollow`).
      handle = await openNoFollow(full, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (err) {
      // A file its owner cannot read (mode 0o200 locked to 0o000) cannot be opened; check by
      // name instead. Everything else — a link (ELOOP), a missing file — is not ours to touch.
      if ((err as NodeJS.ErrnoException).code !== "EACCES") return;
      await chmodByName(full, next);
      return;
    }
    try {
      const info = await handle.stat();
      if (info.isFile()) await handle.chmod(next(info.mode & 0o7777));
    } finally {
      await handle.close();
    }
  } catch {
    /* gone, or not ours */
  }
}

/**
 * Change the mode of a regular file that cannot be opened, by name and never through a link (L4).
 * macOS: `chmod -h` is lchmod(2), so a link swapped in after the lstat has its own mode changed,
 * never its target's (Node's lchmod opens the file first, which is exactly what EACCES ruled out;
 * `full` is absolute: no option). Linux and Windows have no lchmod (GNU chmod has no `-h`, and
 * Windows' chmod only sets the read-only attribute): the path is changed right after the lstat
 * found a regular file there.
 */
async function chmodByName(
  full: string,
  next: (mode: number) => number,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const info = await lstat(full);
  if (!info.isFile()) return;
  const mode = next(info.mode & 0o7777);
  if (platform === StudioPlatform.Mac) await execFileAsync("/bin/chmod", ["-h", mode.toString(8), full]);
  else await chmod(full, mode);
}

/** Undo a marker left behind by a build that never got to release its own locks. */
export async function releaseStaleLocks(cwd: string, recoveryRoot?: string): Promise<boolean> {
  const stale = await readMarker(path.resolve(cwd), recoveryRoot);
  if (!stale) return false;
  await releaseLocks(cwd, stale, recoveryRoot);
  return true;
}

async function recoveryFile(root: string, recoveryRoot?: string): Promise<string> {
  const directory = recoveryRoot ?? path.join(os.tmpdir(), `genex-ownership-${os.userInfo().username}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid ownership recovery directory");
  const key = createHash("sha256")
    .update(await realpath(root))
    .digest("hex");
  return path.join(directory, `${key}.json`);
}

async function readMarker(root: string, recoveryRoot?: string): Promise<LockRecord | null> {
  const host = await recoveryFile(root, recoveryRoot);
  return (await readRecord(host, 0o222)) ?? readRecord(path.join(root, MARKER), 0o200);
}

async function readRecord(file: string, writeBits: number): Promise<LockRecord | null> {
  try {
    // Not through a link, not a FIFO, not unbounded (M4): the marker is the contractor's to replace.
    const parsed = JSON.parse((await readRegularFile(file, MAX_MARKER_BYTES)).toString("utf8")) as LockRecord;
    if (!Array.isArray(parsed?.files)) return null;
    // Legacy game markers are untrusted and regain only owner write. Host records
    // preserve all write bits taken by this lock, including crash recovery.
    return {
      ...parsed,
      files: parsed.files.map((entry) => ({ file: entry?.file, mode: Number(entry?.mode) & writeBits })),
    };
  } catch {
    return null;
  }
}

/** Every file under `root`, as workspace-relative paths with forward slashes. */
async function* walk(root: string, prefix: string): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(root, rel);
    } else if (entry.isFile() && rel !== MARKER) {
      yield rel;
    }
  }
}

/** Exported for the conformance suite: the marker's name, so a test can assert its cleanup. */
export const LOCK_MARKER = MARKER;

/** Put the locks back — what the engine does the moment it sees the contractor try a `chmod`. */
export async function reapplyLocks(cwd: string, record: LockRecord | null): Promise<void> {
  const root = path.resolve(cwd);
  for (const entry of record?.files ?? []) await chmodInside(root, entry.file, (mode) => mode & ~0o222);
}

/**
 * The sentence the contractor reads, so a locked file is a rule and not a puzzle to solve.
 * Two wordings, for the two worlds a worker builds in (M4.6): the studio's own template has a
 * FACET WIRING block in its entry, and a game the user brought has no such thing — its entry
 * belongs to whoever owns it, whole. The Claude side says the same in `ownershipReason`.
 */
export function ownershipBriefing(ownership: Ownership): string {
  const entry = entryFiles(ownership);
  if (ownership.template === false) {
    const seam = ownership.owns.length ? ownership.owns.join(", ") : "the files this part of the game needs";
    return [
      `FILE OWNERSHIP — this game is the user's own, and your seam in it is ${seam}${ownership.ownsMain ? `, plus ${entry.main}, ${entry.studio} and index.html` : `, plus its own NOTES file. ${entry.main}, ${entry.studio} and index.html belong to whoever owns the entry`}.`,
      "Files outside it that already exist have been made read-only on purpose. That is the rule, not a mistake and not a permissions bug:",
      "do not `chmod` it away, do not `sudo`, do not copy-edit-replace. If the work genuinely needs a file outside your seam, say so in your summary and",
      "leave it alone — the studio will re-lock anything you unlock, and an edit you sneak past it is an edit the reviewer will revert.",
      "Lockfiles, build output and bundler caches are left writable, so `npm install` and the game's own build still run.",
    ].join(" ");
  }
  const owns = ownership.owns.length ? ownership.owns.join(", ") : "the files for this facet";
  return [
    `FILE OWNERSHIP — this facet owns ${owns}${ownership.ownsMain ? `, plus ${entry.main}, ${entry.studio} and index.html` : `, plus its own NOTES file and the FACET WIRING block of ${entry.main}`}.`,
    "Every other file in this workspace has been made read-only on purpose. That is the rule, not a mistake and not a permissions bug:",
    "do not `chmod` it away, do not `sudo`, do not copy-edit-replace. If you believe you need a file you do not own, say so in your summary and",
    "leave it alone — the studio will re-lock anything you unlock, and an edit you sneak past it is an edit the reviewer will revert.",
  ].join(" ");
}
