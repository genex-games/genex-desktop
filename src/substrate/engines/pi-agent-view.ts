/**
 * macOS and Linux: the folder a session's Pi is pointed at in place of the person's own.
 *
 * Pi makes a lock folder beside `auth.json` even to read it, saves a renewed sign-in into that
 * file, and keeps a lock and a cache beside its model store: a session must write where they are.
 * What Pi keeps in its folder it also loads and runs outside the sandbox, for the person and for
 * Genex's own model listing: an extension, `models.json`, `APPEND_SYSTEM.md`, and the sign-in
 * itself, where a stored key that starts with `!` is a command. Linux's sandbox grants a folder
 * whole and cannot keep a session from making an entry that is not there yet; macOS can name the
 * locks, but the sign-in a session saves is still the file the person's Pi runs. So each session
 * gets a folder of its own, `<agent>/genex/agent-<process>-<name>`, which stands for the person's:
 *
 * - `auth.json` and `models-store.json` (Pi's cache of its providers' catalogs) are copies of the
 *   person's. Nothing is copied back: a sign-in renewed in a session lasts that session, so the
 *   person's own Pi renews one that would not outlast it before the copy is made (`pi-sign-in.ts`).
 * - every other entry is a link to the person's, which a session reads and cannot write.
 *   `sessions` is granted, so transcripts stay where Pi keeps them.
 *
 * A folder is made new, before anything can write it, and is never used again: when its session
 * ends it is renamed into `<agent>/genex/work`, which no session writes, and removed there. So
 * nothing is ever built or removed through a name a session could have changed, the folder itself
 * included, and nothing one session left reaches another. The person's own Pi never reads any of
 * this. Read from Pi 1.5.2 (`dist/core/auth-storage.js`, `dist/core/models-store.js`,
 * `dist/core/resolve-config-value.js`) and proper-lockfile 4.1.2 (`realpath` on by default).
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { StudioPlatform } from "../../shared/boot.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { PI_MODEL_STORE } from "./pi-cli.ts";
import { PI_SIGN_IN } from "./pi-sign-in.ts";
import { PI_SESSIONS_DIR } from "./pi-sessions.ts";

/** Genex's own folder inside Pi's folder: the sessions' folders and the work folder beside them. */
const OWN_DIR = "genex";
const WORK_DIR = "work";
/** A session folder's name: the Genex process that made it, and a name of its own. */
const VIEW_NAME = /^agent-(\d+)-[0-9a-f-]{36}$/;
/** proper-lockfile's lock folders: `<file>.lock`, made and removed while Pi runs. */
const LOCK_SUFFIX = ".lock";
/** Pi's own mode for its folder and its sign-in file. */
const OWNER_ONLY_DIR = 0o700;
const OWNER_ONLY_FILE = 0o600;
const EMPTY_STORE = "{}";
/**
 * What has stood unchanged longer than this is removed from the work folder by any session's start.
 * A removal takes milliseconds, so that is one that never ended, or a folder a long session just
 * left, which its own close is removing too: removing twice does no harm.
 */
const WORK_LEFT_BEHIND_MS = MINUTE_MS;
/** Linux's `O_PATH`, which Node does not name (the same number on x64 and arm64): the entry itself, whatever its mode. */
const LINUX_O_PATH = 0o10000000;
/** Where Linux keeps a process's open files by number: a name for one that no rename can change. */
const LINUX_OPEN_FILES = "/proc/self/fd";
/** Opens a folder itself for reading, never one a link names. */
const HELD_FOLDER = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** A session's folder, and Pi's own folder by its real path, where the folder is. */
export interface PiView {
  dir: string;
  agent: string;
}

/** How a build tells what was left behind; this computer's clock and processes when not given. */
export interface PiViewHost {
  now?: () => number;
  /** Whether process `pid` still runs: a session folder outlives a Genex that crashed. */
  isRunning?: (pid: number) => boolean;
}

/** The session folders this process made and has not closed. */
const inUse = new Set<string>();

/**
 * Makes a session folder that stands for Pi's folder `agent` as it is now, by its real path. The
 * caller closes it when the session ends ({@link closePiView}).
 */
export async function openPiView(agent: string, host: PiViewHost = {}): Promise<PiView> {
  await mkdir(path.join(agent, PI_SESSIONS_DIR), { recursive: true, mode: OWNER_ONLY_DIR });
  const real = await realpath(agent);
  const own = await ownFolder(path.join(real, OWN_DIR));
  const work = await ownFolder(path.join(own, WORK_DIR));
  await clearLeftBehind(own, work, host);
  const view = path.join(own, `agent-${process.pid}-${randomUUID()}`);
  // In use before it is there: a session starting beside this one must not take it for left behind.
  inUse.add(view);
  try {
    // Never a folder that is there already: no session has written this one.
    await mkdir(view, { mode: OWNER_ONLY_DIR });
    for (const name of (await readdir(real)).filter(isMirrored))
      await symlink(path.join(real, name), path.join(view, name));
    // No sign-in file: none in the session's folder either. No model store: an empty one, which Pi fills.
    await copyInto(path.join(real, PI_SIGN_IN), path.join(view, PI_SIGN_IN), null);
    await copyInto(path.join(real, PI_MODEL_STORE), path.join(view, PI_MODEL_STORE), EMPTY_STORE);
  } catch (err) {
    await closePiView(view);
    throw err;
  }
  return { dir: view, agent: real };
}

/** Removes a session folder once its session has ended, with everything the session left in it. */
export async function closePiView(view: string): Promise<void> {
  inUse.delete(view);
  await takeOut(view, path.join(path.dirname(view), WORK_DIR));
}

/**
 * Makes `dir`, one of Genex's two folders in Pi's folder, when it is not there; an error when the
 * name holds anything but a folder. Everything a session left is removed through these two, so a
 * link under either name would have Genex remove what it names.
 */
async function ownFolder(dir: string): Promise<string> {
  await mkdir(dir, { mode: OWNER_ONLY_DIR }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "EEXIST") throw err;
  });
  if (!(await lstat(dir)).isDirectory())
    throw new Error(`${dir} is not a folder: Genex keeps Pi sessions' folders there`);
  return dir;
}

/** An entry of Pi's folder a session reads through a link: all but the two it gets a copy of, Pi's locks and Genex's own folder. */
function isMirrored(name: string): boolean {
  if (name === OWN_DIR || name === PI_SIGN_IN || name === PI_MODEL_STORE) return false;
  return !name.endsWith(LOCK_SUFFIX);
}

/**
 * Makes `entry` a copy of `source` as it is now, the owner's alone. The bytes are copied and never
 * read as anything else. Where there is no `source`, `entry` holds `missing`, or is not made when
 * there is none; a `source` that is there and cannot be read is an error, not a missing sign-in.
 */
async function copyInto(source: string, entry: string, missing: string | null): Promise<void> {
  const content = await readFile(source).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err;
    return missing;
  });
  if (content === null) return;
  await writeFile(entry, content, { flag: "wx", mode: OWNER_ONLY_FILE });
}

/** The process a session folder's name says made it, or null for any other name. */
function madeBy(name: string): number | null {
  const made = VIEW_NAME.exec(name);
  return made ? Number(made[1]) : null;
}

/** Whether process `pid` still runs; one this user may not signal runs too. */
function processRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes the session folders nobody runs on any more (their Genex is gone, or this one closed
 * them and could not remove them then) and what a removal that never ended left in the work folder.
 */
async function clearLeftBehind(own: string, work: string, host: PiViewHost): Promise<void> {
  const isRunning = host.isRunning ?? processRuns;
  for (const name of await readdir(own)) {
    const pid = madeBy(name);
    if (pid === null) continue;
    const view = path.join(own, name);
    const isLive = pid === process.pid ? inUse.has(view) : isRunning(pid);
    if (!isLive) await takeOut(view, work);
  }
  const at = (host.now ?? Date.now)();
  for (const name of await readdir(work)) {
    const left = path.join(work, name);
    const made = await lstat(left).catch(() => null);
    if (made && at - made.mtimeMs > WORK_LEFT_BEHIND_MS) await removeTree(left);
  }
}

/**
 * Takes `entry` out of where sessions run: renamed into the work folder, where no session reaches
 * it, and removed there. A rename moves the name itself, whatever a session made of it. One that
 * cannot be moved now stays for the next session's start to take out.
 */
async function takeOut(entry: string, work: string): Promise<void> {
  const out = path.join(work, randomUUID());
  const move = () =>
    rename(entry, out).then(
      () => true,
      () => false,
    );
  // A session can leave its folder closed to its owner, and a closed folder cannot change parents.
  const moved = (await move()) || ((await ownAgain(entry)) && (await move()));
  if (moved) await removeTree(out);
}

/**
 * Gives the owner back `dir` when it is a folder; false for anything else. Never what a link names,
 * even one put there between the look and the change: the mode is set on the folder in hand, not on
 * a name. Linux can hold a folder whatever its mode. macOS cannot hold one closed to reading, and
 * has no call that sets a folder's mode without following a link (Node's `lchmod` opens for
 * writing, which no folder allows): only such a folder is changed by name, after a look.
 */
async function ownAgain(dir: string): Promise<boolean> {
  const isLinux = process.platform === StudioPlatform.Linux;
  const flags = isLinux ? LINUX_O_PATH | constants.O_NOFOLLOW : HELD_FOLDER;
  const held = await open(dir, flags).catch(() => null);
  if (!held) return !isLinux && ownAgainByName(dir);
  try {
    if (!(await held.stat()).isDirectory()) return false;
    // An `O_PATH` handle takes no change itself: the folder is named by the handle's number.
    if (isLinux) await chmod(path.join(LINUX_OPEN_FILES, String(held.fd)), OWNER_ONLY_DIR).catch(() => {});
    else await held.chmod(OWNER_ONLY_DIR).catch(() => {});
    return true;
  } finally {
    await held.close();
  }
}

/** {@link ownAgain} for a folder that cannot be opened: by its name, when the name holds a folder. */
async function ownAgainByName(dir: string): Promise<boolean> {
  const entry = await lstat(dir).catch(() => null);
  if (!entry?.isDirectory()) return false;
  await chmod(dir, OWNER_ONLY_DIR).catch(() => {});
  return true;
}

/** Removes `dir`, a tree in the work folder, whatever modes a session left on its folders. */
async function removeTree(dir: string): Promise<void> {
  const remove = () =>
    rm(dir, { recursive: true, force: true }).then(
      () => true,
      () => false,
    );
  if (await remove()) return;
  await ownTree(dir);
  // What still cannot be removed waits in the work folder for a later start.
  await remove();
}

/** Gives the owner back every folder of the tree at `dir`, following no link. */
async function ownTree(dir: string): Promise<void> {
  if (!(await ownAgain(dir))) return;
  for (const name of await readdir(dir).catch(() => [])) await ownTree(path.join(dir, name));
}
