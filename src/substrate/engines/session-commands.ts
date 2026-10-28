/**
 * A session's shell commands in Genex's own sandbox: the one place a delegated session's command
 * box is made and a command is run in it. A local session (Bonsai, OpenRouter) runs every command
 * here; Claude Code runs its commands here where its own sandbox cannot start (Windows).
 */
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { SECOND_MS } from "../../shared/duration.ts";
import { HOST_GIT_CONFIG } from "../git-policy.ts";
import { ProcessSandbox, type RunResult, type SandboxOptions } from "../spawn.ts";

/** How long the probe for a linked worktree's Git metadata may take. */
const GIT_PROBE_TIMEOUT_MS = 5 * SECOND_MS;
/** The Git a probe runs: the system's own off Windows (never a PATH a repository put first), Git for Windows' there. */
const POSIX_GIT = "/usr/bin/git";
const WINDOWS_GIT = "git";

/** The part of a {@link ProcessSandbox} a session's commands use. */
export type CommandSandbox = Pick<ProcessSandbox, "run" | "dispose">;

/** Makes a session's command sandbox; tests hand in a fake. */
export type CommandSandboxFactory = (options: SandboxOptions) => Promise<CommandSandbox>;

/** Where a session's commands may write, what they may never read or write, and their scratch. */
export interface CommandBox {
  /** The session's working folder; a linked worktree's Git metadata joins it. */
  cwd: string;
  /** Further folders the session writes (a worker's write roots). */
  writableRoots?: readonly string[];
  /** Never readable (the studio's secrets, the CLIs' sign-in homes, the never-touch list). */
  secretPaths: readonly string[];
  /** Readable, never written. */
  denyWrite: readonly string[];
  scratchDir: string;
  toolPath?: () => Promise<string>;
  platform?: NodeJS.Platform;
}

/** One command a session asked for. */
export interface SessionCommand {
  command: string;
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
  /** Denied for this run on top of the box's own lists; none when the box's own hold it. */
  denyRead?: readonly string[];
  denyWrite?: readonly string[];
  /** The sandbox label: `<engine>:<session id>`. */
  label: string;
}

/**
 * A linked worktree's index and objects, which live outside its folder: the only Git metadata a
 * session's commands may write. None when the folder is no Git checkout.
 */
export async function gitMetadataDirs(cwd: string, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  const git = platform === "win32" ? WINDOWS_GIT : POSIX_GIT;
  const dirs: string[] = [];
  for (const flag of ["--absolute-git-dir", "--git-common-dir"]) {
    const answer = await promisify(execFile)(git, [...HOST_GIT_CONFIG, "-C", cwd, "rev-parse", flag], {
      timeout: GIT_PROBE_TIMEOUT_MS,
      windowsHide: true,
    }).catch(() => null);
    if (answer) dirs.push(await realpath(path.resolve(cwd, answer.stdout.trim())));
  }
  return [...new Set(dirs)];
}

/** The session's command sandbox: its folder, its write roots and its Git metadata are its only writable places. */
export async function commandSandbox(
  box: CommandBox,
  create: CommandSandboxFactory = (options) => ProcessSandbox.create(options),
): Promise<CommandSandbox> {
  const gitMetadata = await gitMetadataDirs(box.cwd, box.platform);
  return create({
    writableRoots: [...new Set([box.cwd, ...(box.writableRoots ?? []), ...gitMetadata])],
    scratchDir: box.scratchDir,
    secretPaths: [...box.secretPaths],
    denyWrite: [...box.denyWrite],
    ...(box.toolPath ? { toolPath: box.toolPath } : {}),
  });
}

/** Run one of the session's commands in its sandbox, with no network. */
export function runSessionCommand(sandbox: CommandSandbox, call: SessionCommand): Promise<RunResult> {
  const denies = call.denyRead || call.denyWrite;
  return sandbox.run({
    command: call.command,
    cwd: call.cwd,
    signal: call.signal,
    timeoutMs: call.timeoutMs,
    maxOutputBytes: call.maxOutputBytes,
    ...(denies ? { policy: { denyRead: [...(call.denyRead ?? [])], denyWrite: [...(call.denyWrite ?? [])] } } : {}),
    label: call.label,
  });
}

/** A session's shell in Genex's sandbox: the sandbox is made at its first command and goes with the session. */
export interface SessionShell {
  run(command: string, timeoutMs: number): Promise<RunResult>;
  dispose(): Promise<void>;
}

/** What a {@link SessionShell} runs with, beyond its box: its lists, its label, its output cap and its stop. */
export interface ShellSpec {
  box: CommandBox;
  label: string;
  maxOutputBytes: number;
  signal: AbortSignal;
  create?: CommandSandboxFactory;
}

/**
 * The session's shell. Making a sandbox is not free (on Windows it joins the grant session), and
 * most sessions that may run a command never do, so it is made on the first command; a session
 * that ends while it is being made still disposes it.
 */
export function sessionShell(spec: ShellSpec): SessionShell {
  let made: Promise<CommandSandbox> | null = null;
  return {
    run: async (command, timeoutMs) => {
      made ??= commandSandbox(spec.box, spec.create);
      // No per-command denies: the box holds the session's lists, and on Windows srt-win stamps a
      // per-command deny again on every run, re-propagating the entries under its parent.
      return runSessionCommand(await made, {
        command,
        cwd: spec.box.cwd,
        signal: spec.signal,
        timeoutMs,
        maxOutputBytes: spec.maxOutputBytes,
        label: spec.label,
      });
    },
    dispose: async () => {
      const sandbox = await made?.catch(() => null);
      await sandbox?.dispose();
    },
  };
}

/** A finished command as the model reads it: its output, then how it ended. */
export function commandReport(result: RunResult): string {
  const ending = [
    `exit code ${result.code ?? "none"}`,
    ...(result.signal ? [`stopped by ${result.signal}`] : []),
    ...(result.timedOut ? ["timed out"] : []),
    ...(result.truncated ? ["output truncated"] : []),
  ].join(", ");
  return [result.stdout.trimEnd(), result.stderr.trim() ? `[stderr]\n${result.stderr.trimEnd()}` : "", `[${ending}]`]
    .filter(Boolean)
    .join("\n");
}

/** Whether a finished command failed: a nonzero exit, a signal or a timeout. */
export function commandFailed(result: RunResult): boolean {
  return result.code !== 0 || result.timedOut;
}
