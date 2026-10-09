/** Host Git operations read file bytes without running programs selected by a repository. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
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
  "core.longpaths=true",
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
