import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { realpathSync } from "node:fs";
import { SECOND_MS } from "../../src/shared/duration.ts";

/**
 * The errors Node's own `rm` tries again (its `maxRetries`): on Windows, a folder another process
 * holds open. In the Windows suite that is every few seconds: a sandboxed test file's srt-win
 * entries are inheritable, re-propagated through every folder under the one they are on (for
 * `.docker`, the runner's whole profile, `%TEMP%` included), each held open meanwhile.
 */
const HELD_OPEN = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EMFILE", "ENFILE"]);
/** The pause between two removals of a held folder. */
const REMOVE_RETRY_MS = SECOND_MS / 2;
/**
 * How long a removal waits for a held folder in all: several walks of a busy `%TEMP%` in a row.
 * A folder held longer than this is held by something the test left running.
 */
export const REMOVE_PATIENCE_MS = 30 * SECOND_MS;

/** What {@link removeTree} removes with and waits with; its own test passes fakes. */
export interface RemoveTreeDeps {
  rm?: (dir: string) => Promise<void>;
  sleep?: (ms: number) => Promise<unknown>;
}

const created: string[] = [];
const closers: Array<() => Promise<void>> = [];

/**
 * Temp dir that is removed when the test file finishes. On Windows it is spelled by its long
 * name, as the app's own folders are: `os.tmpdir()` can carry an 8.3 name (`RUNNER~1`).
 */
export async function tmpDir(prefix = "studio-test-"): Promise<string> {
  const made = await mkdtemp(path.join(os.tmpdir(), prefix));
  const dir = process.platform === "win32" ? realpathSync.native(made) : made;
  created.push(dir);
  return dir;
}

/**
 * Remove a test's folder and everything in it, waiting while another process holds part of it
 * open (Windows refuses to remove such a folder) for up to {@link REMOVE_PATIENCE_MS}.
 */
export async function removeTree(dir: string, deps: RemoveTreeDeps = {}): Promise<void> {
  const remove = deps.rm ?? ((target: string) => rm(target, { recursive: true, force: true }));
  const wait = deps.sleep ?? sleep;
  for (let waited = 0; ; waited += REMOVE_RETRY_MS) {
    try {
      return await remove(dir);
    } catch (error) {
      if (!heldOpen(error) || waited >= REMOVE_PATIENCE_MS) throw error;
      await wait(REMOVE_RETRY_MS);
    }
  }
}

/**
 * Remove `dirs` one at a time, newest first. A folder made inside another one (a core-lite's temp
 * folder under a test's own, reached through a link) goes before its parent: removing both at once
 * raced over the same files, and the macOS release regression failed with EINVAL.
 */
export async function removeAll(dirs: readonly string[], deps: RemoveTreeDeps = {}): Promise<void> {
  for (const dir of [...dirs].reverse()) await removeTree(dir, deps);
}

/** Is this a removal error another process holding the folder open explains? */
function heldOpen(error: unknown): boolean {
  return error instanceof Error && "code" in error && HELD_OPEN.has(String(error.code));
}

/**
 * Something that has to be shut down before the temp directories go — a rig whose studio is
 * still writing into one. This file's hook is registered the moment the helper is imported,
 * which is before any test file's own `after`, so a studio left to a file-level hook was being
 * stopped only after its workspace had been deleted underneath it: the removal failed with
 * ENOTEMPTY and the stop then never finished.
 */
export function closeBeforeCleanup(close: () => Promise<void>): void {
  closers.push(close);
}

after(async () => {
  for (const close of closers.splice(0)) await close().catch(() => {});
  await removeAll(created.splice(0));
});
