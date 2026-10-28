/**
 * Roblox Studio's own logs, read for two things only: whether the person has signed in, and whether
 * a publish went through. Studio writes a line when a sign-in finishes (the person's own or its
 * automatic one) and when a publish succeeds (a first one or an update). Genex reads only Studio's
 * logs written since it began waiting, and never follows a link out of the folder.
 */
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { envValue } from "../../substrate/toolchain.ts";
import { isMacPath, isWindowsPath } from "./studio-locate.ts";

/** The line Studio's log holds once a sign-in has finished. */
export const SIGNED_IN_MARK = "[FLog::StudioKeyEvents] login [end][success]";
/**
 * The line Studio's log holds once a publish has gone through. Roblox's own record of the place
 * (`GetProductInfo().Updated`) is no proof of an update: in a Team Create place it moves when
 * Studio saves, minutes apart from the publish, and not when a publish finds nothing new to save.
 */
export const PUBLISHED_MARK = "[FLog::PublishSessionStateController] Go to PublishSuccessful";
/** How much of a log's end one look for a publish reads: many minutes of Studio's busiest logging. */
const MAX_TAIL_BYTES = 4 * 1024 * 1024;
/** Studio's own log, by name (the installer's and the player's are passed over). */
const STUDIO_LOG = /_Studio_[0-9A-Za-z]+(?:_last)?\.log$/;
/** At most this much of one log is read in one look; the rest waits for the next. */
const MAX_READ_BYTES = 4 * 1024 * 1024;

/** Where Studio keeps its logs on this computer; undefined where Genex can't tell. */
export function studioLogFolder(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string | undefined {
  if (platform === "darwin" && isMacPath(home)) return path.posix.join(home, "Library", "Logs", "Roblox");
  const local = platform === "win32" ? envValue(env, "LOCALAPPDATA") : undefined;
  if (local && isWindowsPath(local)) return path.win32.join(local, "Roblox", "logs");
  return undefined;
}

/** How far one log has been read, and its last bytes, so a mark split between two looks is found. */
interface ReadSoFar {
  offset: number;
  tail: string;
}

/** Whether what `file` gained since the last look holds the mark; a plain file written since `since` only. */
async function markSinceLastLook(file: string, since: number, seen: Map<string, ReadSoFar>): Promise<boolean> {
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile() || info.mtimeMs < since) return false;
  const last = seen.get(file) ?? { offset: 0, tail: "" };
  // A log shorter than what was read is a new one under the same name: read it from its start.
  const from = info.size < last.offset ? 0 : last.offset;
  const length = Math.min(info.size - from, MAX_READ_BYTES);
  if (length <= 0) return false;
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return false;
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, from);
    const text = (from === 0 ? "" : last.tail) + buffer.subarray(0, bytesRead).toString("latin1");
    seen.set(file, { offset: from + bytesRead, tail: text.slice(-SIGNED_IN_MARK.length) });
    return text.includes(SIGNED_IN_MARK);
  } finally {
    await handle.close();
  }
}

/** Studio's logs in `folder`, by name; none for a missing or linked folder. */
async function studioLogs(folder: string | undefined): Promise<string[]> {
  if (!folder) return [];
  const info = await lstat(folder).catch(() => undefined);
  if (!info?.isDirectory()) return [];
  const names = await readdir(folder).catch(() => [] as string[]);
  return names
    .filter((each) => STUDIO_LOG.test(each))
    .sort()
    .map((name) => path.join(folder, name));
}

/**
 * A look that answers whether a Studio log in `folder` written since `since` records a finished
 * sign-in. Each look reads only what the logs gained; a missing or linked folder answers no.
 */
export function signInWatch(folder: string | undefined, since: number): () => Promise<boolean> {
  const seen = new Map<string, ReadSoFar>();
  return async () => {
    for (const file of await studioLogs(folder)) if (await markSinceLastLook(file, since, seen)) return true;
    return false;
  };
}

/** The end of a plain log file written since `since`, at most {@link MAX_TAIL_BYTES}; empty otherwise. */
async function tailSince(file: string, since: number): Promise<string> {
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile() || info.mtimeMs < since) return "";
  const length = Math.min(info.size, MAX_TAIL_BYTES);
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return "";
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, info.size - length);
    return buffer.subarray(0, bytesRead).toString("latin1");
  } finally {
    await handle.close();
  }
}

/** Whether a log line is the publish mark, stamped (its leading UTC time) at or after `since`. */
function publishedLine(line: string, since: number): boolean {
  if (!line.includes(PUBLISHED_MARK)) return false;
  const stamped = Date.parse(line.slice(0, line.indexOf(",")));
  return stamped >= since;
}

/**
 * Whether a Studio log in `folder` records a publish that went through at or after `since` (the
 * press). Reads the end of each log written since then; a missing or linked folder answers no.
 */
export async function publishedSince(folder: string | undefined, since: number): Promise<boolean> {
  for (const file of await studioLogs(folder)) {
    const tail = await tailSince(file, since);
    if (tail.split("\n").some((line) => publishedLine(line, since))) return true;
  }
  return false;
}
