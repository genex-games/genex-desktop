/**
 * Lock retention: a game keeps building on the lock it recorded after an app update moves a
 * stack's current lock on, until an explicit port rebuilds it on the new one. Its components, its
 * prewarm folder and its lock record stay while any game references the lock; only a lock no game
 * and no stack's current lock names is swept. The store reads an old lock back from its record
 * (`lock.ts` `readRecordedLock`); a game naming a lock the store cannot read back stops every
 * sweep (`unknown-game-lock`), so nothing it may need is ever removed. A recorded Rust lock whose
 * toolchain the store no longer holds ({@link installedRustLock}) is no lock a game builds on: the
 * game falls back to the current lock, and the build lane's sweep keeps none of its folders.
 */
import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { type CompiledStack, GameStack } from "../../shared/game-project.ts";
import { ToolchainId, type ToolchainLock, ToolchainPruneRefusal } from "../../shared/toolchain.ts";
import { LOCK_RECORDS_FOLDER, lockFolderName, readCurrentLock, readRecordedLock } from "./lock.ts";
import { PREWARM_MANIFESTS_FOLDER } from "./prewarm-seed.ts";
import { readRustBase } from "./rust-locate.ts";

/** A lock record's file name: the full digest. */
const RECORD_NAME = /^([0-9a-f]{64})\.json$/;
/** A prewarm manifest's file name: the lock folder's digest12. */
const MANIFEST_NAME = /^([0-9a-f]{12})\.json$/;

/** The stack a lock serves: a Rust lock always pins the Rust sysroot; any other lock is raylib's. */
export function stackOfLock(lock: ToolchainLock): CompiledStack {
  return lock.entries[ToolchainId.Rust] ? GameStack.RustWgpu : GameStack.RaylibCpp;
}

/**
 * The lock a game of `stack` builds on: the one it recorded (`recorded`, a lock digest from the
 * host's own record of its last build) while the store can read it back, it is that stack's and,
 * for a Rust lock, the store still holds its toolchain ({@link installedRustLock}); else the
 * stack's current lock; null before the stack's first install.
 */
export async function lockForGame(
  store: string,
  stack: CompiledStack,
  recorded: unknown,
): Promise<ToolchainLock | null> {
  const own =
    stack === GameStack.RustWgpu ? await installedRustLock(store, recorded) : await readRecordedLock(store, recorded);
  if (own && stackOfLock(own) === stack) return own;
  return readCurrentLock(store, stack);
}

/**
 * The Rust lock `digest` names while the store still holds its toolchain: read back (a current
 * lock or its record), a Rust lock, and its sysroot assembled and probed (`rust-base.json` in its
 * lock folder). Null otherwise: a lock whose folder was removed builds nothing.
 */
export async function installedRustLock(store: string, digest: unknown): Promise<ToolchainLock | null> {
  const lock = await readRecordedLock(store, digest);
  if (!lock || stackOfLock(lock) !== GameStack.RustWgpu) return null;
  return (await readRustBase(store, lock)) ? lock : null;
}

/** The digests among `digests` whose Rust lock the store still holds ({@link installedRustLock}). */
export async function installedRustLocks(store: string, digests: readonly string[]): Promise<string[]> {
  const installed: string[] = [];
  for (const digest of new Set(digests)) if (await installedRustLock(store, digest)) installed.push(digest);
  return installed;
}

/**
 * Every lock a sweep must keep: each stack's current lock and every lock a game records, read back
 * through `recorded`. Refused `no-lock` before any stack has a current lock, and
 * `unknown-game-lock` when nobody said which locks the games hold or one cannot be read back.
 */
export async function retainedLocks(
  current: readonly ToolchainLock[],
  games: readonly string[] | undefined,
  recorded: (digest: string) => Promise<ToolchainLock | null>,
): Promise<ToolchainLock[] | ToolchainPruneRefusal> {
  if (current.length === 0) return ToolchainPruneRefusal.NoLock;
  if (!games) return ToolchainPruneRefusal.UnknownGameLock;
  const kept = new Map(current.map((lock) => [lock.digest, lock]));
  for (const digest of games) {
    if (kept.has(digest)) continue;
    const lock = await recorded(digest);
    if (!lock) return ToolchainPruneRefusal.UnknownGameLock;
    kept.set(digest, lock);
  }
  return [...kept.values()];
}

/** The plain files directly in `folder` whose names match `pattern`, with the digest each names. */
async function namedFiles(folder: string, pattern: RegExp): Promise<Array<{ file: string; digest: string }>> {
  const names = await readdir(folder).catch((): string[] => []);
  const found: Array<{ file: string; digest: string }> = [];
  for (const name of names) {
    const digest = pattern.exec(name)?.[1];
    if (!digest) continue;
    const file = path.join(folder, name);
    const info = await lstat(file).catch(() => null);
    if (info?.isFile()) found.push({ file, digest });
  }
  return found;
}

/**
 * Removes the lock records and prewarm manifests of every lock `kept` does not name, beside the
 * folders `pruneStore` removes; anything else in those folders is left as it is.
 */
export async function sweepLockRecords(
  store: string,
  kept: readonly ToolchainLock[],
): Promise<{ removed: number; bytes: number }> {
  const digests = new Set(kept.map((lock) => lock.digest));
  const folders = new Set(kept.map((lock) => lockFolderName(lock)));
  const records = await namedFiles(path.join(store, LOCK_RECORDS_FOLDER), RECORD_NAME);
  const manifests = await namedFiles(path.join(store, PREWARM_MANIFESTS_FOLDER), MANIFEST_NAME);
  const stale = [
    ...records.filter(({ digest }) => !digests.has(digest)),
    ...manifests.filter(({ digest }) => !folders.has(digest)),
  ];
  let bytes = 0;
  for (const { file } of stale) {
    bytes += (await lstat(file).catch(() => null))?.size ?? 0;
    await rm(file, { force: true });
  }
  return { removed: stale.length, bytes };
}
