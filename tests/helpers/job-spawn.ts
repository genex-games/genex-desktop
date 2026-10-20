/**
 * Agent jobs without the sandbox, started as `ProcessSandbox.spawnLongLived` starts them with the
 * sandbox off: the command under the platform's POSIX shell (`/bin/sh`, Git Bash on Windows, see
 * `posix-shell.ts`), in a process group of its own off Windows. Windows has no process groups: a
 * job's stop ends its tree with `taskkill /T /F` (`killProcessTree`), and a detached child would
 * open a console window, so there it is started attached and hidden, as the sandbox starts it.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { JobSpawn } from "../../src/substrate/jobs.ts";
import { killProcessTree } from "../../src/substrate/process-tree.ts";
import { posixShell } from "./posix-shell.ts";

const WINDOWS = process.platform === "win32";

/** Start `command` under the platform's POSIX shell, leading its own group off Windows. */
export async function spawnShell(
  command: string,
  options: { cwd?: string; stdio?: "pipe" | "ignore" } = {},
): Promise<ChildProcess> {
  return spawn(await posixShell(), ["-c", command], {
    cwd: options.cwd,
    stdio: options.stdio ?? "pipe",
    detached: !WINDOWS,
    windowsHide: true,
    // Git Bash would rewrite a path-like argument; the sandbox's env file turns that off too.
    env: WINDOWS ? { ...process.env, MSYS_NO_PATHCONV: "1" } : process.env,
  });
}

/** A job spawn that runs each command under the platform's shell, telling `onRequest` of each first. */
export function shellJobSpawn(onRequest?: (request: Parameters<JobSpawn>[0]) => void): JobSpawn {
  return async (request) => {
    onRequest?.(request);
    return { child: await spawnShell(request.command, { cwd: request.cwd }), sandboxed: false };
  };
}

/**
 * A job spawn that never runs the command: each job is a Node process that exits at once, its own
 * group's leader off Windows. `onRequest` hears each request first.
 */
export function exitingJobSpawn(onRequest?: (request: Parameters<JobSpawn>[0]) => void): JobSpawn {
  return async (request) => {
    onRequest?.(request);
    const child = spawn(process.execPath, ["-e", ""], { detached: !WINDOWS, stdio: "pipe", windowsHide: true });
    return { child, sandboxed: false };
  };
}

/** A test's cleanup: end what `pid` started, its group off Windows, its tree there. Never throws. */
export function endTree(pid: number | undefined): Promise<void> {
  return killProcessTree(pid, { signal: "SIGKILL" });
}
