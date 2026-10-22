/**
 * One agent job's process, as the registry (`jobs.ts`) runs it: its output piped into a log the
 * app opened (up to a size cap, then one line saying so while the job keeps running), its end
 * heard however it comes, its process group signalled, and its start time read so a later app
 * start can tell the same process from a reused id.
 */
import { type ChildProcess, type ExecFileException, execFile } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { once } from "node:events";
import type { Writable } from "node:stream";
import { SECOND_MS } from "../shared/duration.ts";
import path from "node:path";
import { envValue, isWindows } from "./toolchain.ts";
import { windowsPowerShellEnv } from "./child-env.ts";
import { killProcessTree, type TreeKillCommand } from "./process-tree.ts";

/** How long `ps` may take to tell a process's start time. */
const PROBE_TIMEOUT_MS = 5 * SECOND_MS;
/**
 * Windows PowerShell's own start can take several seconds on a busy PC, most of all while the app
 * itself is starting, which is when left jobs are checked: a read cut short there left the job running.
 */
const WINDOWS_PROBE_TIMEOUT_MS = 20 * SECOND_MS;

const MESSAGE = {
  logCapped: "\n[Genex: the log stopped here at its size cap; the job keeps running]\n",
  logFailed: "Job log write failed",
} as const;

/** Reads a process's start time, to tell it from a later process given the same id. */
export interface JobProbe {
  /**
   * The start time as `ps -o lstart=` prints it (Windows: as a round-trip UTC time to the 100 ns
   * tick), or null when no such process runs. Rejects when the time could not be read at all (the
   * reader timed out or did not start), which says nothing about the process.
   */
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

/** Runs `taskkill` to end a job's tree on Windows (`process-tree.ts`); injectable for tests. */
export type JobEndTree = (command: TreeKillCommand) => Promise<void>;

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

/**
 * The command reading `pid`'s start time: `ps -o lstart= -p <pid>` on macOS and Linux; on Windows,
 * Windows PowerShell by its full path asking for the process's start time.
 */
export function startTimeCommand(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; env?: NodeJS.ProcessEnv } {
  if (!isWindows(platform)) return { file: "/bin/ps", args: ["-o", "lstart=", "-p", String(pid)] };
  const systemRoot = envValue(env, "SystemRoot") || "C:\\Windows";
  const script = `(Get-Process -Id ${Math.trunc(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`;
  return {
    file: path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoProfile", "-NonInteractive", "-Command", script],
    env: windowsPowerShellEnv(env),
  };
}

/** Whether the reader ran to its end and answered with a failing exit code: no such process. */
function exitedWithCode(error: ExecFileException): boolean {
  return typeof error.code === "number" && !error.killed;
}

/** Reads a start time by {@link startTimeCommand}; null when the process is gone. */
export function psProbe(platform: NodeJS.Platform = process.platform): JobProbe {
  const timeout = isWindows(platform) ? WINDOWS_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS;
  return {
    startTime: (pid) =>
      new Promise((resolve, reject) => {
        const { file, args, env } = startTimeCommand(pid, platform);
        execFile(file, args, { timeout, windowsHide: true, env }, (error, stdout) => {
          if (error && !exitedWithCode(error)) return reject(error);
          resolve(error ? null : stdout.trim() || null);
        });
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
export async function closeJobLog(log: Writable): Promise<void> {
  if (log.closed) return;
  const closed = once(log, "close").catch(() => {});
  log.end();
  await closed;
}

/**
 * Pipe a job's stdout and stderr into its log until `maxBytes`, then write one line saying the
 * log stopped and keep reading (a pipe nobody reads would stall the job). `onBytes` hears the
 * bytes written so far and whether the cap was reached. A slow disk pauses both pipes until
 * the writer drains; after the cap, output is discarded without pausing the job. The returned
 * predicate tells the exit watcher when a slow writer still owns buffered output.
 */
export function pipeJobOutput(
  child: ChildProcess,
  log: Writable,
  maxBytes: number,
  onBytes: (bytes: number, capped: boolean) => void,
): () => boolean {
  let bytes = 0;
  let capped = false;
  let paused = false;
  const streams = [child.stdout, child.stderr];
  const resume = () => {
    if (!paused) return;
    paused = false;
    for (const stream of streams) stream?.resume();
  };
  const detach = () => {
    log.off("drain", resume);
    log.off("finish", detach);
    log.off("close", detach);
    log.off("error", failed);
    for (const stream of streams) stream?.off("data", take);
    resume();
  };
  const failed = (error: Error) => {
    detach();
    console.error(MESSAGE.logFailed, error);
  };
  const take = (chunk: Buffer) => {
    const unavailable = capped || log.destroyed || log.writableEnded;
    if (unavailable) return;
    const room = maxBytes - bytes;
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
    const writable = part.length === 0 || log.write(part);
    bytes += part.length;
    if (chunk.length > room) {
      capped = true;
      log.write(MESSAGE.logCapped);
    }
    const needsPause = !writable && !capped && !paused;
    if (needsPause) {
      paused = true;
      for (const stream of streams) stream?.pause();
      log.once("drain", resume);
    }
    onBytes(bytes, capped);
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  log.once("finish", detach);
  log.once("close", detach);
  log.once("error", failed);
  return () => {
    const finished = capped || log.destroyed || log.writableEnded;
    if (finished) return false;
    return paused || log.writableLength > 0 || streams.some((stream) => (stream?.readableLength ?? 0) > 0);
  };
}

/**
 * How the job's process ended: when its output closes, or when it fails to start. `onExit` runs
 * as soon as the process itself exits, before its output closes; a process it left that holds
 * the output open past `drainMs` (on `clock`) does not keep the job from ending. Output still
 * waiting for the log's writer is drained first, rather than mistaken for an idle orphan pipe.
 */
export function jobEnd(
  child: ChildProcess,
  onExit: () => void,
  clock: JobClock,
  drainMs: number,
  isDraining?: () => boolean,
): Promise<JobExit> {
  return new Promise((resolve) => {
    let done = false;
    let drain: unknown;
    const finish = (exit: JobExit) => {
      if (done) return;
      done = true;
      if (drain !== undefined) clock.clearTimeout(drain);
      resolve(exit);
    };
    const finishOrWait = (exit: JobExit) => {
      if (done) return;
      if (isDraining?.()) {
        drain = clock.setTimeout(() => finishOrWait(exit), drainMs);
        return;
      }
      finish(exit);
    };
    child.once("exit", (code, signal) => {
      onExit();
      drain = clock.setTimeout(() => finishOrWait({ exitCode: code, signal }), drainMs);
    });
    child.once("close", (code, signal) => finish({ exitCode: code, signal }));
    child.once("error", () => finish({ exitCode: child.exitCode, signal: child.signalCode }));
  });
}

/** Signal a job's process group (POSIX), or end its tree (Windows). Never throws. */
export function signalJob(
  pid: number | undefined,
  signal: NodeJS.Signals,
  options: { kill?: JobKill; endTree?: JobEndTree; platform: NodeJS.Platform },
): Promise<void> {
  return killProcessTree(pid, { signal, kill: options.kill, run: options.endTree, platform: options.platform });
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
