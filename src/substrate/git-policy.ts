/** Host Git operations read file bytes without running programs selected by a repository. */
import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { SECOND_MS } from "../shared/duration.ts";

const exec = promisify(execFile);
/** A Mac's /usr/bin/git: a stand-in that runs the git of Apple's developer tools, or asks to install them. */
const MAC_GIT_STAND_IN = "/usr/bin/git";
/** The tool that names the folder macOS takes its developer tools from; macOS's own, never a stand-in. */
const XCODE_SELECT = "/usr/bin/xcode-select";
const XCODE_SELECT_TIMEOUT_MS = 5 * SECOND_MS;
const CONFIG_MAX_BYTES = 1024 * 1024;
const EXECUTABLE_KEYS = "^(filter\\..*\\.(clean|smudge|process|required)|diff\\..*\\.(textconv|command))$";
const PRIVATE_ENV_PATHS = [":(glob,exclude)**/.env", ":(glob,exclude)**/.env.*"];

/**
 * A commit's auto-maintenance runs inside the call, never in a detached process: one kept writing
 * into the harness `.git` after `StudioCore.stop()` resolved, and removing the folder failed with
 * ENOTEMPTY. (`gc.autoDetach` is the same switch for a Git older than 2.47.)
 */
const ATTACHED_MAINTENANCE = { "maintenance.autoDetach": "false", "gc.autoDetach": "false" } as const;

/** Highest-precedence settings shared by host Git callers and sandboxed Git tools. */
export const HOST_GIT_CONFIG = [
  "-c",
  "core.fsmonitor=",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.pager=cat",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
  "-c",
  "core.alternateRefsCommand=",
  // Git for Windows stops at 260 characters ("Filename too long") unless told otherwise; a game's
  // folders under %USERPROFILE% reach that. Other Gits ignore the key.
  "-c",
  "core.longpaths=true",
  ...Object.entries(ATTACHED_MAINTENANCE).flatMap(([key, value]) => ["-c", `${key}=${value}`]),
];

/** Git diff-family commands never invoke an external diff or text-conversion driver. */
export function hostGitArgs(args: readonly string[]): string[] {
  const [command, ...rest] = args;
  // Checkpoints already filter their stdin path list. Git forbids mixing that list with argv paths.
  const stdinPaths = rest.some((arg) => arg.startsWith("--pathspec-from-file="));
  if (command === "add" && !stdinPaths) return [...args, ...PRIVATE_ENV_PATHS];
  if (command && ["diff", "diff-tree", "diff-index", "show", "log"].includes(command))
    return [command, "--no-ext-diff", "--no-textconv", ...rest];
  return [...args];
}

/** Remove ambient Git routing and executable configuration; callers supply only owned overrides. */
export function hostGitEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    ...overrides,
  };
}

/** Neutralize configured content drivers, including required filters, without editing the repo. */
export async function hostGitConfig(dir: string, env = hostGitEnv()): Promise<string[]> {
  let keys: string;
  try {
    const result = await exec(
      "git",
      [...HOST_GIT_CONFIG, "-C", dir, "config", "--null", "--name-only", "--get-regexp", EXECUTABLE_KEYS],
      {
        env,
        maxBuffer: CONFIG_MAX_BYTES,
        windowsHide: true,
      },
    );
    keys = result.stdout;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return [...HOST_GIT_CONFIG];
    throw error;
  }
  const disabled = [...new Set(keys.split("\0").filter(Boolean))].flatMap((key) => [
    "-c",
    `${key}=${key.endsWith(".required") ? "false" : ""}`,
  ]);
  return [...HOST_GIT_CONFIG, ...disabled];
}

/** What {@link hostGitRuns} reads of a computer; tests hand in their own. */
export interface HostGitProbe {
  platform: NodeJS.Platform;
  /** The PATH the app runs `git` from. */
  path: string;
  /** Whether `file` exists and may run. */
  runnable(file: string): Promise<boolean>;
  /** The folder macOS takes its developer tools from (`xcode-select -p`), or null. */
  developerDir(): Promise<string | null>;
}

/** This computer as {@link hostGitRuns} reads it, under `env` (the app's own by default). */
export function thisComputersGit(env: NodeJS.ProcessEnv = process.env): HostGitProbe {
  return {
    platform: process.platform,
    path: env.PATH ?? "",
    runnable: (file) =>
      access(file, constants.X_OK).then(
        () => true,
        () => false,
      ),
    developerDir: () =>
      exec(XCODE_SELECT, ["-p"], { env, timeout: XCODE_SELECT_TIMEOUT_MS }).then(
        ({ stdout }) => stdout.trim() || null,
        () => null,
      ),
  };
}

/** The first `git` a Mac's PATH names that may run, searching absolute entries only. */
async function gitOnMacPath(probe: HostGitProbe): Promise<string | null> {
  for (const dir of probe.path.split(path.posix.delimiter).filter((entry) => path.posix.isAbsolute(entry))) {
    const git = path.posix.join(dir, "git");
    if (await probe.runnable(git)) return git;
  }
  return null;
}

/**
 * Whether this computer runs Git, asked before running it for someone who may not be a developer.
 * Off a Mac, yes: Windows and Linux report a missing Git as an error. On a Mac, only where the
 * PATH's `git` is a real one: /usr/bin/git there stands in for the git of Apple's developer tools
 * and, without them, asks the person to install them.
 */
export async function hostGitRuns(probe: HostGitProbe = thisComputersGit()): Promise<boolean> {
  if (probe.platform !== "darwin") return true;
  const git = await gitOnMacPath(probe);
  if (git !== MAC_GIT_STAND_IN) return git !== null;
  const developer = await probe.developerDir();
  return developer !== null && (await probe.runnable(path.posix.join(developer, "usr", "bin", "git")));
}

/** The folder of a Mac build's resources that holds Genex's own git (`scripts/vendor-git-for-mac.ts`). */
export const MAC_GIT_DIR = "git";

/** The `bin` folder of Genex's own git in a Mac build's `resources`: what goes on PATH. */
export function macOwnGitBin(resources: string): string {
  return path.posix.join(resources, MAC_GIT_DIR, "bin");
}

/**
 * The PATH `probe` names, with the folder of the first git in `fallback` that runs put first, when
 * the PATH's own git cannot run: on a Mac without Apple's developer tools. Unchanged off a Mac,
 * where the PATH's git runs (a Mac with the tools, or with its own git first), and where `fallback`
 * has no git that runs either.
 */
export async function pathWithGitThatRuns(probe: HostGitProbe, fallback: string): Promise<string> {
  if (probe.platform !== "darwin" || (await hostGitRuns(probe))) return probe.path;
  const other = { ...probe, path: fallback };
  const git = await gitOnMacPath(other);
  if (!git || !(await hostGitRuns(other))) return probe.path;
  const dir = path.posix.dirname(git);
  return [dir, ...probe.path.split(path.posix.delimiter).filter((entry) => entry && entry !== dir)].join(
    path.posix.delimiter,
  );
}

/**
 * Put Genex's own git (`<resources>/git/bin`) first on `env`'s PATH where the git there cannot
 * run, as on a Mac without Apple's developer tools, so host git and every PATH made from this one
 * run it. True when the PATH's git runs now.
 */
export async function ensureMacGit(
  resources: string,
  env: NodeJS.ProcessEnv = process.env,
  probe: HostGitProbe = thisComputersGit(env),
): Promise<boolean> {
  const chosen = await pathWithGitThatRuns(probe, macOwnGitBin(resources));
  if (chosen !== probe.path) env.PATH = chosen;
  return hostGitRuns({ ...probe, path: chosen });
}
