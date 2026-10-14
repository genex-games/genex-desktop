/**
 * Toolchain locks: the component versions a game builds with, named by a digest, and each compiled
 * stack's current lock that its new games build with: raylib's `current-lock.json` (the name it
 * always had, so an older Studio still reads it) beside Rust's `current-lock.rust-wgpu.json`
 * (`LOCK_FILE_OF_STACK`). Every lock the store ever made current is also kept as a record
 * (`lock-records/<digest>.json`), so a game built on an older lock still locates it after an app
 * update moved the current one on (`retention.ts`). A lock can come from a game's own
 * `studio.json`, which an agent may write, so every reader checks its shape before a version or
 * digest becomes a path.
 */
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { type CompiledStack, GameStack } from "../../shared/game-project.ts";
import { LOCK_FILE_OF_STACK, ToolchainId, type ToolchainLock } from "../../shared/toolchain.ts";
import { atomicWriteJson, isJsonObject, readJsonIfExists, readRegularFile } from "../fsx.ts";
import { canonicalJson } from "./genex-cmake.ts";

/** The store file naming the lock new raylib games build with (unchanged since the first store). */
export const CURRENT_LOCK_FILE = LOCK_FILE_OF_STACK[GameStack.RaylibCpp];
/** The store folder holding each lock's prewarm outputs (`locks/<digest12>/`). */
export const LOCKS_FOLDER = "locks";
/** The store folder keeping every lock that was ever current (`lock-records/<digest>.json`), host-written only. */
export const LOCK_RECORDS_FOLDER = "lock-records";
/** Every compiled stack, in the order their lock files are read. */
export const COMPILED_STACKS = Object.keys(LOCK_FILE_OF_STACK) as CompiledStack[];

const LOCK_SCHEMA = 1;
/** The most of a lock record the store reads: a lock is a few hundred bytes. */
const LOCK_RECORD_MAX_BYTES = 64 * 1024;
const DIGEST = /^[0-9a-f]{64}$/;
const SHA12 = /^[0-9a-f]{12}$/;
/** A version as a folder name may hold it: no separator, no `..`, no leading dot. */
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const KNOWN_IDS: ReadonlySet<string> = new Set<string>(Object.values(ToolchainId));

/** A version a folder name may hold: no separator, no `..`, no leading dot. */
const isSafeVersion = (value: unknown): value is string =>
  typeof value === "string" && VERSION.test(value) && !value.includes("..");
const isSha12 = (value: unknown): value is string => typeof value === "string" && SHA12.test(value);
/** Whether `value` is a lock digest as the store writes it (and `studio.json` records it): sha256 in lowercase hex. */
export const isLockDigest = (value: unknown): value is string => typeof value === "string" && DIGEST.test(value);

/** A version and short digest that are safe to join into a store path. */
export function isSafePin(pin: unknown): pin is { version: string; sha12: string } {
  return isJsonObject(pin) && isSafeVersion(pin.version) && isSha12(pin.sha12);
}

/** Whether `value` is a well-formed lock whose digest matches its entries. */
export function isToolchainLock(value: unknown): value is ToolchainLock {
  if (!isJsonObject(value) || value.version !== LOCK_SCHEMA) return false;
  const { entries, digest } = value;
  if (!isLockDigest(digest) || !isJsonObject(entries)) return false;
  if (!Object.entries(entries).every(([id, pin]) => KNOWN_IDS.has(id) && isSafePin(pin))) return false;
  return lockOf(entries as ToolchainLock["entries"]).digest === digest;
}

/** The lock for `entries`: `digest` is sha256 of their canonical JSON (keys sorted), so equal entries give one digest. */
export function lockOf(entries: ToolchainLock["entries"]): ToolchainLock {
  const ids = Object.keys(entries).sort() as ToolchainId[];
  const sorted: ToolchainLock["entries"] = {};
  for (const id of ids) {
    const pin = entries[id];
    if (pin) sorted[id] = { version: pin.version, sha12: pin.sha12 };
  }
  const digest = createHash("sha256").update(canonicalJson(sorted)).digest("hex");
  return { version: LOCK_SCHEMA, entries: sorted, digest };
}

/** The lock's folder name under `locks/`: the first 12 hex of its digest. */
export function lockFolderName(lock: ToolchainLock): string {
  return lock.digest.slice(0, 12);
}

/** The store's current lock for `stack` (raylib's `current-lock.json` by default), or null when there is none or it does not parse. */
export async function readCurrentLock(
  store: string,
  stack: CompiledStack = GameStack.RaylibCpp,
): Promise<ToolchainLock | null> {
  const value = await readJsonIfExists<unknown>(path.join(store, LOCK_FILE_OF_STACK[stack])).catch(() => null);
  return isToolchainLock(value) ? value : null;
}

/** Each compiled stack's current lock that the store holds; a stack with none is absent. */
export async function readCurrentLocks(store: string): Promise<Partial<Record<CompiledStack, ToolchainLock>>> {
  const locks: Partial<Record<CompiledStack, ToolchainLock>> = {};
  for (const stack of COMPILED_STACKS) {
    const lock = await readCurrentLock(store, stack);
    if (lock) locks[stack] = lock;
  }
  return locks;
}

/** `bytes` as JSON, or null when they are not JSON. */
function parsedJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/** The record file of the lock named by `digest` (a checked lock digest). */
export function lockRecordFile(store: string, digest: string): string {
  return path.join(store, LOCK_RECORDS_FOLDER, `${digest}.json`);
}

/**
 * Records `lock` under `lock-records/` (atomically; one already there is the same lock by its
 * name). A lock whose digest is not its entries' is never recorded: no reader would accept it.
 */
export async function recordLock(store: string, lock: ToolchainLock): Promise<void> {
  if (!isToolchainLock(lock)) return;
  await atomicWriteJson(lockRecordFile(store, lock.digest), lock);
}

/**
 * The lock `digest` names, read back: a stack's current lock, else its record. Null when the
 * digest is malformed, nothing records it, or the record is not that lock (renamed or edited).
 */
export async function readRecordedLock(store: string, digest: unknown): Promise<ToolchainLock | null> {
  if (!isLockDigest(digest)) return null;
  const current = Object.values(await readCurrentLocks(store)).find((lock) => lock.digest === digest);
  if (current) return current;
  // Read without following a link: a record is a plain file only the host writes.
  const bytes = await readRegularFile(lockRecordFile(store, digest), LOCK_RECORD_MAX_BYTES).catch(() => null);
  const value = bytes ? parsedJson(bytes) : null;
  return isToolchainLock(value) && value.digest === digest ? value : null;
}

/** `file` absolute, its folder realpath'd when it exists (the file itself need not). */
async function resolvedFile(file: string): Promise<string> {
  const absolute = path.resolve(file);
  const folder = await realpath(path.dirname(absolute)).catch(() => path.dirname(absolute));
  return path.join(folder, path.basename(absolute));
}

/** Whether two resolved paths name one file by spelling (case folded where the disk usually folds it). */
function sameSpelling(left: string, right: string): boolean {
  const folds = process.platform === "darwin" || process.platform === "win32";
  return folds ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** Whether `file` is `own` however spelled, a link to it or a hard link of it. */
async function isSameFile(own: string, file: string): Promise<boolean> {
  const [left, right] = await Promise.all([resolvedFile(own), resolvedFile(file)]);
  if (sameSpelling(left, right)) return true;
  const [ownInfo, fileInfo] = await Promise.all([stat(own).catch(() => null), stat(file).catch(() => null)]);
  return ownInfo !== null && fileInfo !== null && ownInfo.dev === fileInfo.dev && ownInfo.ino === fileInfo.ino;
}

/**
 * Whether writing `file` would write one of `store`'s own current-lock files (any stack's): its
 * path however spelled (`.`/`..` segments, a linked folder, its name in another case where the
 * disk folds case), a link to it or a hard link of it, whether or not it exists yet. A
 * developer's worktree keeps its own lock beside the shared store and refuses such a file;
 * nothing is written to ask.
 */
export async function isStoreLockFile(store: string, file: string): Promise<boolean> {
  for (const stack of COMPILED_STACKS)
    if (await isSameFile(path.join(store, LOCK_FILE_OF_STACK[stack]), file)) return true;
  return false;
}

/** The paths only the host writes about locks: every stack's current-lock file and the lock records. */
export function storeLockPaths(store: string): string[] {
  return [
    ...COMPILED_STACKS.map((stack) => path.join(store, LOCK_FILE_OF_STACK[stack])),
    path.join(store, LOCK_RECORDS_FOLDER),
  ];
}

/**
 * Makes `lock` the stack's current lock (raylib's `current-lock.json` by default), atomically,
 * after recording it, so a game built on it can still read it back once a later lock replaces it.
 * Another stack's lock file is never touched.
 */
export async function writeCurrentLock(
  store: string,
  lock: ToolchainLock,
  stack: CompiledStack = GameStack.RaylibCpp,
): Promise<void> {
  await recordLock(store, lock);
  await atomicWriteJson(path.join(store, LOCK_FILE_OF_STACK[stack]), lock);
}

/**
 * The store-relative folders any of `locks` names: each component's `<id>/<version>-<sha12>` and
 * each lock's `locks/<digest12>`. What pruning keeps; pass the current lock too.
 */
export function referencedVersions(locks: readonly ToolchainLock[]): ReadonlySet<string> {
  const kept = new Set<string>();
  for (const lock of locks) {
    kept.add(`${LOCKS_FOLDER}/${lockFolderName(lock)}`);
    for (const [id, pin] of Object.entries(lock.entries)) if (pin) kept.add(`${id}/${pin.version}-${pin.sha12}`);
  }
  return kept;
}
