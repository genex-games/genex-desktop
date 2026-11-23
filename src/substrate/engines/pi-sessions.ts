/**
 * Where Pi keeps a session, and how a turn continues one.
 *
 * Pi files a session under the folder it was started in (`<agent>/sessions/--<folder>--/
 * <timestamp>_<id>.jsonl`), and `--session-id` looks only in the current folder's: an id made
 * elsewhere starts an empty session under the same id. A chat's turns do not all run from one
 * folder (a build runs in the game, a Plan or read-only turn in a folder of its own), so the turn
 * that follows one from another folder forks the session into its own (`--fork`), which copies the
 * history and gives it a new id. Read from Pi 1.5.2 (`dist/main.js`, `dist/core/session-manager.js`).
 */
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { StudioPlatform } from "../../shared/boot.ts";

/** The folder of Pi's own folder that Pi files its sessions in. */
export const PI_SESSIONS_DIR = "sessions";
/** What Pi accepts as a session id; anything else is never looked up. */
const SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
/** Enough of a session file to hold its first line, the header. */
const HEADER_BYTES = 16_384;

/** A session's file, and the folder it was made in (its header's `cwd`). */
export interface PiSessionFile {
  file: string;
  cwd: string;
}

/**
 * The first line of `file` as a session header naming `id`, or null. Only a regular file is opened:
 * a session writes this folder, and a pipe left under a session's name would hold the open forever.
 */
async function headerCwd(file: string, id: string): Promise<string | null> {
  const entry = await lstat(file).catch(() => null);
  if (!entry?.isFile()) return null;
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(HEADER_BYTES), 0, HEADER_BYTES, 0);
    const header: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0] ?? "");
    if (!header || typeof header !== "object") return null;
    const { type, id: named, cwd } = header as Record<string, unknown>;
    const isSession = type === "session" && named === id;
    return isSession && typeof cwd === "string" && path.isAbsolute(cwd) ? cwd : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** Orders session files newest first: a file's name starts with its timestamp, compared as plain text. */
function newerName(a: string, b: string): number {
  const [left, right] = [path.basename(a), path.basename(b)];
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

/**
 * The newest file of session `id` under Pi's sessions folder, by its name and its own header;
 * null when there is none, or `id` is not one Pi would take.
 */
export async function findPiSession(sessionsRoot: string, id: string): Promise<PiSessionFile | null> {
  if (!SESSION_ID.test(id)) return null;
  const folders = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
  const suffix = `_${id}.jsonl`;
  const named: string[] = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const dir = path.join(sessionsRoot, folder.name);
    const files = await readdir(dir).catch(() => []);
    named.push(...files.filter((name) => name.endsWith(suffix)).map((name) => path.join(dir, name)));
  }
  for (const file of named.sort(newerName)) {
    const cwd = await headerCwd(file, id);
    if (cwd) return { file, cwd };
  }
  return null;
}

/** Whether two folders are one, as Pi compares the folder a session was made in. */
export function samePiFolder(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const spelled = (dir: string) => {
    const resolved = path.resolve(dir);
    return platform === StudioPlatform.Windows ? resolved.toLowerCase() : resolved;
  };
  return spelled(a) === spelled(b);
}

/**
 * The options that continue session `id` in `runDir`: Pi's own resume where the session lives in
 * that folder (or nowhere yet), a fork of its file where it was last used from another.
 */
export function piSessionArgs(id: string, found: PiSessionFile | null, runDir: string): string[] {
  if (!found || samePiFolder(found.cwd, runDir)) return ["--session-id", id];
  return ["--fork", found.file];
}
