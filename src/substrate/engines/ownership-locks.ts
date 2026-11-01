import { createHash } from "node:crypto";
import os from "node:os";
/**
 * Recovery of the ownership locks an older build took (the Codex path's read-only files for the
 * length of a delegation, recorded before they were applied). Genex takes no locks now: a part's
 * ownership went with the classic facets. What stays is the undo of a record a build that died
 * with the app (a crash, a force-quit) left behind, so a workspace is never left unwritable by a
 * failure that had nothing to do with it. Every delegation in a folder releases such a record first.
 */
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { openNoFollow, readRegularFile } from "../fsx.ts";
import { StudioPlatform } from "../../shared/boot.ts";

const execFileAsync = promisify(execFile);

/** A marker is a list of paths; anything bigger than this is not one the studio wrote. */
const MAX_MARKER_BYTES = 4 * 1024 * 1024;

/** Legacy recovery marker: read during migration, never written by new delegations. */
const MARKER = path.join(".studio-locks.json");

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
 * Give every file a record locked back the write bits the lock took, and drop the record. Only those
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

/** Exported for the conformance suite: the marker's name, so a test can assert its cleanup. */
export const LOCK_MARKER = MARKER;
