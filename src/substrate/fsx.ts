/**
 * Filesystem primitives for the event store.
 *
 * Two invariants the whole substrate leans on:
 *  - **Atomicity.** Every JSON file appears complete or not at all: write to a temp file in the
 *    same directory, fsync, rename. A `kill -9` during an append can therefore never leave a
 *    half-written event behind — the store is always loadable.
 *  - **Single writer.** All mutations funnel through one in-process async lock (Exo uses an
 *    AsyncMutex for the same reason), so the optimistic head check cannot interleave.
 */
import { constants as FS, type Stats } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { StudioPlatform } from "../shared/boot.ts";
import { SECOND_MS } from "../shared/duration.ts";
import { errorMessage } from "../shared/errors.ts";

/** `readRegularFile` reads in chunks of at most this many bytes. */
const READ_CHUNK_BYTES = 64 * 1024;
/**
 * How often a rename over an existing file is tried on Windows, and the wait between tries: a
 * reader (or a virus scanner) holding the target open refuses it for a moment.
 */
const REPLACE_ATTEMPTS = 8;
const REPLACE_RETRY_MS = 50;
/** The codes Windows refuses a rename with while another handle holds the target. */
const TRANSIENT_REPLACE = new Set(["EPERM", "EACCES", "EBUSY"]);
/**
 * How long a new folder's rename keeps trying on Windows, and the first wait between tries (each
 * wait grows by it): OneDrive, an antivirus or the search indexer can hold a new folder's files
 * for seconds, longer than {@link REPLACE_ATTEMPTS} allows a single file.
 */
const FOLDER_RENAME_BUDGET_MS = 30 * SECOND_MS;
const FOLDER_RENAME_STEP_MS = 100;

const MESSAGE = {
  DanglingLink: (file: string) => `refused: ${file} is a symlink to something that does not exist`,
  BrokenLink: (file: string) => `refused: ${file} is a symlink that cannot be followed`,
  Link: (file: string) => `refused: ${file} is a link`,
  NotAFolder: (dir: string) => `refused: ${dir} is a link or a file, not a folder`,
  TooLarge: (file: string, maxBytes: number) => `${file} is larger than ${maxBytes} bytes`,
  NotRegular: (file: string) => `${file} is not a regular file`,
  InvalidJson: (file: string, cause: unknown) =>
    `${file} is not valid JSON (${errorMessage(cause)}). Studio left it unchanged: fix or remove it, then try again.`,
  NotAnObject: "not an object",
} as const;

/** A plain JSON object: not null, not an array. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The real path `target` would have: the nearest ancestor that exists, realpathed, plus the part
 * that does not exist yet (which therefore holds no link). For containment checks on paths the
 * caller is about to create. A dangling link on the way is not "a part that does not exist yet":
 * creating through it lands wherever it points once that appears, so it is refused (M2).
 */
export async function realpathNearest(target: string): Promise<string> {
  const rest: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(await realpath(current), ...rest);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const parent = path.dirname(current);
      const notYetThere = code === "ENOENT" || code === "ENOTDIR";
      // A link that does not resolve, whatever the reason: dangling, a loop, or on Windows a file
      // link to a folder (EPERM). Creating through it would land wherever it leads.
      if ((await lstat(current).catch(() => null))?.isSymbolicLink()) {
        const message = notYetThere ? MESSAGE.DanglingLink(current) : MESSAGE.BrokenLink(current);
        throw Object.assign(new Error(message), { code: "ELOOP" });
      }
      if (!notYetThere || parent === current) throw err;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** The error an open through a link gets: ELOOP, as `O_NOFOLLOW` gives it. */
function linkRefused(file: string): NodeJS.ErrnoException {
  return Object.assign(new Error(MESSAGE.Link(file)), { code: "ELOOP" });
}

/** Whether two stats describe the same file: device and file index. */
const sameFile = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;

/**
 * Open `file` with `flags`, never through a link: ELOOP when `file` is one. macOS and Linux refuse
 * the link in the open itself (`O_NOFOLLOW`). Windows has no such flag (Node's constant is
 * undefined there), so the name is `lstat`ed first, and after the open the name must still be a
 * non-link naming the very file the handle holds; a link swapped in between is refused. `O_TRUNC`
 * is applied only after that check, so a planted link never gets its target emptied.
 * `noFollow` is the platform's flag, injectable so the Windows path is tested on any host.
 */
export async function openNoFollow(
  file: string,
  flags: number,
  mode?: number,
  noFollow: number | undefined = FS.O_NOFOLLOW,
): Promise<FileHandle> {
  if (noFollow) return open(file, flags | noFollow, mode);
  const before = await lstat(file).catch(() => null);
  if (before?.isSymbolicLink()) throw linkRefused(file);
  const truncate = (flags & FS.O_TRUNC) !== 0;
  const handle = await open(file, truncate ? flags & ~FS.O_TRUNC : flags, mode);
  try {
    const [opened, named] = await Promise.all([handle.stat(), lstat(file)]);
    if (named.isSymbolicLink() || !sameFile(opened, named)) throw linkRefused(file);
    if (truncate) await handle.truncate(0);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Write `data` to `file`, created or truncated, never through a link planted at that name (ELOOP). */
export async function writeFileNoFollow(file: string, data: string | Uint8Array): Promise<void> {
  const handle = await openNoFollow(file, FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC, 0o666);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

/**
 * Write `data` as `name` in `dir`, a folder {@link ensureDirBelow} made in a folder a box can write
 * (the runs folder). The name is opened without following a link and without emptying what is
 * there; only once the handle is the very file `name` names in `dir`, and `dir` still resolves to
 * itself, is it emptied and written. A folder on the way swapped for a link after the check is
 * refused (ELOOP) and nothing is written through it, nor any file emptied. `between` runs after the
 * caller's check and before the open: a test's swap.
 */
export async function writeFileInDir(
  dir: string,
  name: string,
  data: string | Uint8Array,
  between?: () => Promise<void>,
): Promise<void> {
  await between?.();
  const file = path.join(dir, name);
  const handle = await openNoFollow(file, FS.O_WRONLY | FS.O_CREAT, 0o666);
  try {
    const [opened, named, real] = await Promise.all([
      handle.stat(),
      lstat(file).catch(() => null),
      realpath(dir).catch(() => null),
    ]);
    const placed = real === dir && named !== null && !named.isSymbolicLink() && sameFile(opened, named);
    if (!placed) throw linkRefused(file);
    await handle.truncate(0);
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

/**
 * Create `name` in `dir` (a folder {@link ensureDirBelow} made) and write `data`, refusing a name
 * already there (a file or a link: EEXIST) and a `dir` swapped for a link after its check (ELOOP,
 * the file it made through the link removed again). `between` runs before the open: a test's swap.
 */
export async function createFileInDir(
  dir: string,
  name: string,
  data: string | Uint8Array,
  between?: () => Promise<void>,
): Promise<void> {
  await between?.();
  const file = path.join(dir, name);
  const handle = await openNoFollow(file, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o666);
  let placed = false;
  try {
    placed = (await realpath(dir).catch(() => null)) === dir;
    if (placed) await handle.writeFile(data);
  } finally {
    await handle.close();
  }
  if (placed) return;
  await unlink(file).catch(() => {});
  throw linkRefused(file);
}

/** Why {@link readRegularFile} refused: not a regular file (a FIFO, a socket, a device), or too big. */
export class NotARegularFileError extends Error {
  readonly code: "ENOTREG" | "EFBIG";
  constructor(file: string, code: "ENOTREG" | "EFBIG", maxBytes: number) {
    super(code === "EFBIG" ? MESSAGE.TooLarge(file, maxBytes) : MESSAGE.NotRegular(file));
    this.name = "NotARegularFileError";
    this.code = code;
  }
}

/**
 * The bytes of a file someone else can write into (a contractor's workspace), read safely: never
 * through a link, never blocking on a FIFO (opened non-blocking, then required to be a regular
 * file), and never more than `maxBytes` (M4). A blocked open holds a libuv thread; four of them
 * stall every file operation in the process.
 */
export async function readRegularFile(file: string, maxBytes: number): Promise<Buffer> {
  const handle = await openNoFollow(file, FS.O_RDONLY | FS.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new NotARegularFileError(file, "ENOTREG", maxBytes);
    if (info.size > maxBytes) throw new NotARegularFileError(file, "EFBIG", maxBytes);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > maxBytes) throw new NotARegularFileError(file, "EFBIG", maxBytes);
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

/**
 * The folder `parts` names below `root`, made where missing, by real path: each part on the way
 * must be a folder of its own, never a link (to anywhere, inside `root` too) or a file, which is
 * refused (ELOOP) before anything is made through it. For a host that writes in a folder its agents
 * can write too (the runs folder); answers the real path of the folder.
 */
export async function ensureDirBelow(root: string, parts: readonly string[]): Promise<string> {
  let dir = await realpath(root);
  for (const part of parts) {
    dir = path.join(dir, part);
    await mkdir(dir).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "EEXIST") throw err;
    });
    const info = await lstat(dir);
    if (!info.isDirectory()) throw Object.assign(new Error(MESSAGE.NotAFolder(dir)), { code: "ELOOP" });
  }
  if ((await realpath(dir)) !== dir) throw Object.assign(new Error(MESSAGE.NotAFolder(dir)), { code: "ELOOP" });
  return dir;
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Write JSON atomically: temp file in the same directory → fsync → rename. */
export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** How {@link replaceFile} renames; the defaults are this platform's own. */
export interface ReplaceOptions {
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => Promise<void>;
  /** The wait between tries on Windows (default {@link REPLACE_RETRY_MS}). */
  retryDelayMs?: number;
}

/** How {@link renameFolder} renames, waits and looks; the defaults are this platform's own. */
export interface RenameFolderOptions {
  platform?: NodeJS.Platform;
  rename?: (from: string, to: string) => Promise<void>;
  sleep?: (ms: number) => Promise<unknown>;
  exists?: (target: string) => Promise<boolean>;
}

const somethingAt = async (target: string) => Boolean(await lstat(target).catch(() => null));

/**
 * Renames a folder to `to`, which must not exist. On Windows a refusal while another app holds a
 * file inside it (EPERM, EACCES, EBUSY) is tried again with growing waits for up to
 * {@link FOLDER_RENAME_BUDGET_MS}, never once something has appeared at `to`; anything else, and
 * every error elsewhere, fails at once with the rename's own error.
 */
export async function renameFolder(from: string, to: string, options: RenameFolderOptions = {}): Promise<void> {
  const move = options.rename ?? rename;
  const wait = options.sleep ?? sleep;
  const exists = options.exists ?? somethingAt;
  const windows = (options.platform ?? process.platform) === StudioPlatform.Windows;
  let waited = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      return await move(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      const transient = windows && TRANSIENT_REPLACE.has(code) && waited < FOLDER_RENAME_BUDGET_MS;
      if (!transient || (await exists(to))) throw error;
      const ms = Math.min(FOLDER_RENAME_STEP_MS * attempt, FOLDER_RENAME_BUDGET_MS - waited);
      await wait(ms);
      waited += ms;
    }
  }
}

/**
 * Rename `from` over `to`. On Windows a refusal while another handle holds `to` (EPERM, EACCES,
 * EBUSY) is tried again a few times; anything else, and every error elsewhere, fails at once.
 */
export async function replaceFile(from: string, to: string, options: ReplaceOptions = {}): Promise<void> {
  const move = options.rename ?? rename;
  const windows = (options.platform ?? process.platform) === StudioPlatform.Windows;
  for (let attempt = 1; ; attempt++) {
    try {
      return await move(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      const transient = windows && TRANSIENT_REPLACE.has(code) && attempt < REPLACE_ATTEMPTS;
      if (!transient) throw error;
      await sleep((options.retryDelayMs ?? REPLACE_RETRY_MS) * attempt);
    }
  }
}

/**
 * Write `text` to `file` so it appears complete or not at all: a fresh temp file beside it
 * (created exclusively, so nothing planted there is written through), fsync, rename. `mode` is
 * the new file's permission (`0o600` for anything holding a secret or a session); the folder is
 * created when missing, with the caller's own `mkdir` first when it needs a mode of its own.
 */
export async function atomicWriteText(file: string, text: string, options: { mode?: number } = {}): Promise<void> {
  const dir = path.dirname(file);
  await ensureDir(dir);
  // Temp name must live in the same directory so that rename(2) is atomic (same filesystem).
  const tmp = path.join(dir, `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const handle = await open(tmp, "wx", options.mode);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await replaceFile(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

export async function readJsonIfExists<T>(file: string): Promise<T | null> {
  try {
    return await readJson<T>(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** A config file Studio was about to update but could not parse; it is left exactly as it is. */
export class UnreadableConfig extends Error {
  readonly file: string;
  constructor(file: string, cause: unknown) {
    super(MESSAGE.InvalidJson(file, cause));
    this.name = "UnreadableConfig";
    this.file = file;
  }
}

/**
 * Read a JSON object Studio is about to modify and write back. A missing file reads as `null`
 * (the caller starts from `{}`); a file that does not parse throws {@link UnreadableConfig} so the
 * caller never replaces someone's edits with a fresh copy.
 */
export async function readJsonForUpdate<T extends object>(file: string): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new UnreadableConfig(file, err);
  }
  if (!isJsonObject(value)) throw new UnreadableConfig(file, new Error(MESSAGE.NotAnObject));
  return value as T;
}

/**
 * List `*.json` entries of a directory, sorted. Temp files (`.tmp-*`) and anything else are
 * ignored, which is what makes a crash mid-append invisible to readers.
 */
export async function listJsonFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries.filter((e) => e.endsWith(".json") && !e.startsWith(".")).sort();
}

export async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

/** Serialises async sections. One instance per store = single-writer discipline. */
export class AsyncLock {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn, fn);
    // Keep the chain alive even when a section rejects.
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export async function writeFileAtomicIfChanged(file: string, text: string): Promise<boolean> {
  try {
    if ((await readFile(file, "utf8")) === text) return false;
  } catch {
    /* fall through to write */
  }
  await atomicWriteText(file, text);
  return true;
}

export { writeFile };
