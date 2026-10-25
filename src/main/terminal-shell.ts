/**
 * The shell a game's terminal opens. macOS and Linux: the account's login shell. Windows: Git
 * Bash (the harness and the snapshots already need Git, and its shell reads like the one on a
 * Mac): an installed Git for Windows first, then Genex's own copy in a packaged app, else Windows
 * PowerShell. Every Windows shell is named by its full path, so nothing on PATH or in the game
 * folder can stand in for it.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { StudioPlatform } from "../shared/boot.ts";
import { BUNDLED_GIT_ONLY_ENV, bundledGitRoot } from "../substrate/windows-sandbox.ts";

/** The program a terminal session runs, and its arguments. */
export interface TerminalShell {
  file: string;
  args: string[];
}

/** What choosing a shell reads, injectable so every platform is tested on any host. */
export interface TerminalShellContext {
  /** The account's shell (`os.userInfo().shell`); macOS and Linux. */
  userShell?: string | null;
  /** Where ProgramFiles, LOCALAPPDATA and SystemRoot are read on Windows. */
  env?: NodeJS.ProcessEnv;
  /** The packaged app's resources folder, holding Genex's own Git (default: `process.resourcesPath`). */
  resources?: string;
  exists?: (file: string) => boolean;
}

/** Each POSIX platform's shell when the account names none. */
const DEFAULT_SHELL: Partial<Record<NodeJS.Platform, string>> = {
  [StudioPlatform.Mac]: "/bin/zsh",
  [StudioPlatform.Linux]: "/bin/bash",
};

/**
 * Git for Windows' `bash.exe`: the machine-wide install first, then a per-user one, then Genex's
 * own Git, as the agents' sandbox finds it; only Genex's own when the environment says so.
 */
function gitBashCandidates(env: NodeJS.ProcessEnv, resources: string | undefined): string[] {
  const join = path.win32.join;
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const installed = [join(programFiles, "Git", "bin", "bash.exe")];
  if (env.LOCALAPPDATA) installed.push(join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  const bundled = bundledGitRoot(resources);
  const own = bundled ? [join(bundled, "bin", "bash.exe")] : [];
  return env[BUNDLED_GIT_ONLY_ENV] === "1" ? own : [...installed, ...own];
}

/** A shell as chosen: its interactive arguments, and those it takes before one command line to run. */
interface ShellChoice extends TerminalShell {
  once: string[];
}

function chooseShell(platform: NodeJS.Platform, context: TerminalShellContext): ShellChoice | null {
  if (platform === StudioPlatform.Windows) {
    const env = context.env ?? process.env;
    const exists = context.exists ?? existsSync;
    const bash = gitBashCandidates(env, context.resources).find((file) => exists(file));
    if (bash) return { file: bash, args: ["--login", "-i"], once: ["--login", "-c"] };
    const systemRoot = env.SystemRoot || "C:\\Windows";
    const powershell = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return { file: powershell, args: ["-NoLogo"], once: ["-NoLogo", "-Command"] };
  }
  const fallback = DEFAULT_SHELL[platform];
  if (!fallback) return null;
  return { file: context.userShell || fallback, args: ["-l"], once: ["-l", "-c"] };
}

/** The shell to open on `platform`, or null where Studio has no terminal. */
export function terminalShell(platform: NodeJS.Platform, context: TerminalShellContext = {}): TerminalShell | null {
  const choice = chooseShell(platform, context);
  return choice ? { file: choice.file, args: choice.args } : null;
}

/** The same shell running one command line and exiting (a command a chat reply offered), or null. */
export function commandShell(
  platform: NodeJS.Platform,
  command: string,
  context: TerminalShellContext = {},
): TerminalShell | null {
  const choice = chooseShell(platform, context);
  return choice ? { file: choice.file, args: [...choice.once, command] } : null;
}
