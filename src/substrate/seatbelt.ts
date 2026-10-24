/**
 * What every macOS Seatbelt profile the host writes shares: the profile language's literal, the
 * syscalls that would let a process leave its group, and the user's cache folder Metal writes to.
 * Plugin jobs (`plugins/native-process.ts`) and games (`game-sandbox-profile.ts`) both read it, and
 * neither imports the other's module for it.
 */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { SECOND_MS } from "../shared/duration.ts";

/** How long the cache folder's probe may take. */
const PROBE_TIMEOUT_MS = 5 * SECOND_MS;

/** A string as an SBPL literal: JSON's escaping is the profile language's. */
export const quote = (s: string) => JSON.stringify(s);

/**
 * setsid(2) and setpgid(2), by their macOS syscall numbers: a descendant that could call them
 * would leave the job's process group, and the group is how a job is stopped.
 */
export const LEAVE_GROUP_SYSCALLS = [147, 82];

/**
 * The user's cache folder (`getconf DARWIN_USER_CACHE_DIR`), as a real path without its trailing
 * slash: where Metal keeps each application's shader cache, in a folder named by its bundle id.
 * Null where there is none (not a Mac) or it cannot be resolved.
 */
export async function darwinUserCacheDir(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  try {
    const named = (
      await promisify(execFile)("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"], { timeout: PROBE_TIMEOUT_MS })
    ).stdout.trim();
    return named ? await realpath(named) : null;
  } catch {
    return null;
  }
}
