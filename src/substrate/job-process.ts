/**
 * One agent job's process, as the registry (`jobs.ts`) runs it: its output piped into a log the
 * app opened (up to a size cap, then one line saying so while the job keeps running), its end
 * heard however it comes, its process group signalled, and its start time read so a later app
 * start can tell the same process from a reused id.
 */
import { type ChildProcess, execFile } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { once } from "node:events";
import { SECOND_MS } from "../shared/duration.ts";
import { isWindows } from "./toolchain.ts";
import { killProcessTree } from "./process-tree.ts";

/** How long `ps` may take to tell a process's start time. */
const PROBE_TIMEOUT_MS = 5 * SECOND_MS;

const MESSAGE = {
  logCapped: "\n[Genex: the log stopped here at its size cap; the job keeps running]\n",
} as const;

/** Reads a process's start time, to tell it from a later process given the same id. */
export interface JobProbe {
  /** The start time as `ps -o lstart=` prints it, or null when no such process runs. */
  startTime(pid: number): Promise<string | null>;
}

/** The clock jobs keep time on; tests pass one they move by hand. */
export interface JobClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Sends a signal to a process or, with a negative id, to a process group (`process.kill`). */
export type JobKill = (pid: number, signal: NodeJS.Signals) => void;

/** How a job's process ended. */
export interface JobExit {
  exitCode: number | null;
  signal: string | null;
}

/** The real clock. Its timers never hold the app open. */
export const SYSTEM_CLOCK: JobClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** `ps -o lstart= -p <pid>` on macOS and Linux; Windows has no such reading, so nothing ever matches. */
export function psProbe(platform: NodeJS.Platform = process.platform): JobProbe {
  return {
    startTime: (pid) =>
      new Promise((resolve) => {
        if (isWindows(platform)) return resolve(null);
        execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { timeout: PROBE_TIMEOUT_MS }, (error, stdout) =>
          resolve(error ? null : stdout.trim() || null),
        );
      }),
  };
}

/** Open a job's log for appending, once it is open. */
export async function openJobLog(file: string): Promise<WriteStream> {
  const log = createWriteStream(file, { flags: "a" });
  await once(log, "open");
  return log;
}

/** End a job's log and wait until everything written to it is on disk. */
export async function closeJobLog(log: WriteStream): Promise<void> {
  if (log.closed) return;
  const closed = once(log, "close").catch(() => {});
  log.end();
  await closed;
}

/**
 * Pipe a job's stdout and stderr into its log until `maxBytes`, then write one line saying the
 * log stopped and keep reading (a pipe nobody reads would stall the job). `onBytes` hears the
 * bytes written so far and whether the cap was reached.
 */
export function pipeJobOutput(
  child: ChildProcess,
  log: WriteStream,
  maxBytes: number,
  onBytes: (bytes: number, capped: boolean) => void,
): void {
  let bytes = 0;
  let capped = false;
  const take = (chunk: Buffer) => {
    if (capped) return;
    const room = maxBytes - bytes;
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (part.length > 0) log.write(part);
    bytes += part.length;
    if (chunk.length > room) {
      capped = true;
      log.write(MESSAGE.logCapped);
    }
    onBytes(bytes, capped);
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
}

/**
 * How the job's process ended: when its output closes, or when it fails to start. `onExit` runs
 * as soon as the process itself exits, before its output closes; a process it left that holds
 * the output open past `drainMs` (on `clock`) does not keep the job from ending.
 */
export function jobEnd(child: ChildProcess, onExit: () => void, clock: JobClock, drainMs: number): Promise<JobExit> {
  return new Promise((resolve) => {
    let done = false;
    let drain: unknown;
    const finish = (exit: JobExit) => {
      if (done) return;
      done = true;
      if (drain !== undefined) clock.clearTimeout(drain);
      resolve(exit);
    };
    child.once("exit", (code, signal) => {
      onExit();
      drain = clock.setTimeout(() => finish({ exitCode: code, signal }), drainMs);
    });
    child.once("close", (code, signal) => finish({ exitCode: code, signal }));
    child.once("error", () => finish({ exitCode: child.exitCode, signal: child.signalCode }));
  });
}

/** Signal a job's process group (POSIX), or end its tree (Windows). Never throws. */
export function signalJob(
  pid: number | undefined,
  signal: NodeJS.Signals,
  options: { kill?: JobKill; platform: NodeJS.Platform },
): Promise<void> {
  return killProcessTree(pid, { signal, kill: options.kill, platform: options.platform });
}

/**
 * Signal a job's process group only (POSIX), never a lone process id: after the job's own
 * process exited and was reaped, its id may belong to another process, while a group id stays
 * taken as long as any member of the group runs. Never throws.
 */
export function signalGroup(pid: number | undefined, signal: NodeJS.Signals, kill?: JobKill): void {
  if (!pid) return;
  try {
    if (kill) kill(-pid, signal);
    else process.kill(-pid, signal);
  } catch {
    /* the group is gone */
  }
}
