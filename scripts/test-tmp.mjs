import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Test runs' own temp folders: `gt-<owner pid>-XXXXXX`, named after the process that removes the
 * folder when it ends. A run killed before its cleanup (SIGKILL, an agent's time limit) leaves its
 * folder behind; the next run removes every folder whose owner is gone, or that sat unchanged for
 * a day, when a reused process id would keep it alive. A folder from before owners were named
 * (`gt-XXXXXX`) is removed only after that day.
 */

/** A test run's temp folder prefix. */
export const TEST_TMP_PREFIX = "gt-";
/** How long a test temp folder may sit unchanged before it is taken for abandoned whatever its owner. */
export const STALE_TEST_TMP_MS = 24 * 60 * 60 * 1000;
/** `gt-<pid>-…`: a folder whose owner is named. */
const OWNED = /^gt-(\d+)-[^/\\]+$/;
/** `gt-XXXXXX`: a folder made before owners were named. */
const UNOWNED = /^gt-[^-/\\]+$/;
/** What `process.kill(pid, 0)` throws for a process that exists but is not ours to signal. */
const NOT_PERMITTED = "EPERM";

/** Whether a process with this id runs: one that exists but is someone else's still runs. */
export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === NOT_PERMITTED;
  }
}

/**
 * Makes a test run's temp folder owned by `pid`: in `/tmp` off Windows, shorter than macOS's
 * per-user temp folder, so the paths tests build under it (Unix sockets limited to 104 bytes,
 * command lines that list many of them) stay short; in `fallback` where `/tmp` is not writable (a
 * sandboxed session) and on Windows.
 */
export function makeTestTmp({ pid = process.pid, fallback = os.tmpdir(), platform = process.platform } = {}) {
  const prefix = `${TEST_TMP_PREFIX}${pid}-`;
  if (platform !== "win32")
    try {
      return fs.mkdtempSync(path.join("/tmp", prefix));
    } catch {}
  return fs.mkdtempSync(path.join(fallback, prefix));
}

/** Whether `name` (a folder of `stat`) is a test temp folder nobody will remove: its owner is gone, or it sat a day. */
function abandoned(name, stat, { now, alive }) {
  const old = now - stat.mtimeMs >= STALE_TEST_TMP_MS;
  const owner = OWNED.exec(name)?.[1];
  if (owner !== undefined) return old || !alive(Number(owner));
  return UNOWNED.test(name) && old;
}

/** Removes `folder` when it is a real folder of this user and abandoned; answers whether it did. */
function removeIfAbandoned(folder, options) {
  try {
    const stat = fs.lstatSync(folder);
    if (!stat.isDirectory() || (options.uid !== undefined && stat.uid !== options.uid)) return false;
    if (!abandoned(path.basename(folder), stat, options)) return false;
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
    return true;
  } catch {
    return false;
  }
}

/** The test temp folders directly in `parent`; none where it can't be read. */
function testTmpIn(parent) {
  try {
    return fs
      .readdirSync(parent)
      .filter((name) => name.startsWith(TEST_TMP_PREFIX))
      .map((name) => path.join(parent, name));
  } catch {
    return [];
  }
}

/**
 * Removes the abandoned test temp folders directly in each of `parents`. Only real folders of this
 * user are removed: a link of that name is never followed or removed, nor a file, nor another
 * user's folder. Answers the folders removed; one that can't be read or removed is passed over.
 */
export function sweepTestTmp(parents, { now = Date.now(), alive = processAlive, uid = process.getuid?.() } = {}) {
  const options = { now, alive, uid };
  return [...new Set(parents)].flatMap(testTmpIn).filter((folder) => removeIfAbandoned(folder, options));
}

/** Where test temp folders are made: `/tmp` off Windows, and the temp folder the run inherited. */
export function testTmpParents(inherited = os.tmpdir(), platform = process.platform) {
  return platform === "win32" ? [inherited] : ["/tmp", inherited];
}

/** Whether `dir` is a test run's own temp folder, so a test inside it is already part of a run that removes it. */
export const isTestTmp = (dir) => path.basename(dir).startsWith(TEST_TMP_PREFIX);
