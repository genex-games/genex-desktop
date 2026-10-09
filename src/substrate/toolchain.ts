/**
 * The build toolchain a desktop app can actually reach.
 *
 * An app launched from Finder inherits launchd's PATH — `/usr/bin:/bin:/usr/sbin:/sbin` — not
 * the one the user's terminal has. Homebrew, nvm, Volta and Bun all live outside it, so
 * `npm run build` exits 127 (`sh: npm: command not found`), the stage stays black and every
 * judge reports a dead build. The app already knew
 * this for one binary — `engines/claude-cli.ts` hard-codes three Homebrew-ish directories to
 * find `claude` — and nothing did it for node.
 *
 * So: ask the user's login shell what its PATH is (that is where nvm and Volta put themselves),
 * add the standard install directories, and hand the result to every sandboxed process. Pure
 * functions do the deciding; the one impure part is the shell call, injectable for tests.
 *
 * Windows has no login shell: an app started from the Start menu gets Explorer's environment,
 * which can predate a Node the user just installed. There the PATH is the process's own plus the
 * machine and user PATH the registry holds now, and a tool is found under its PATHEXT names
 * (`node.exe`, `npm.cmd`).
 */
import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { SECOND_MS } from "../shared/duration.ts";
import { StudioPlatform } from "../shared/boot.ts";

/** The tools a game's build may need on PATH. `node` first: everything else rides on it. */
export const BUILD_TOOLS = ["node", "npm", "pnpm", "yarn", "bun"] as const;
export type BuildTool = (typeof BUILD_TOOLS)[number];

/** The PATH entries a GUI process is born with, and can therefore never learn anything from. */
const LAUNCHD_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
/** How long the login shell has to print its PATH. */
const LOGIN_PATH_TIMEOUT_MS = 8 * SECOND_MS;
/** How long each registry PATH query may take. */
const REGISTRY_PATH_TIMEOUT_MS = 5 * SECOND_MS;
/** How much of the login shell's output is kept: its last line is the PATH. */
const MAX_LOGIN_OUTPUT_CHARS = 65_536;
/** The login shell when the account names none: macOS's default. */
const DEFAULT_LOGIN_SHELL = "/bin/zsh";
/** The executable suffixes Windows tries when PATHEXT is unset. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
/** Where Windows keeps the PATH of the machine, then of the user; a new process gets them in that order. */
const REGISTRY_PATH_KEYS = [
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  "HKCU\\Environment",
] as const;

/** Whether `platform` is Windows, where PATH is `;`-separated and names are case-insensitive. */
export const isWindows = (platform: NodeJS.Platform): boolean => platform === StudioPlatform.Windows;

/** The path module of `platform`, so a Windows path is handled as one on any host. */
export const pathFor = (platform: NodeJS.Platform): path.PlatformPath =>
  isWindows(platform) ? path.win32 : path.posix;

/** The PATH separator of `platform`. */
export const pathDelimiter = (platform: NodeJS.Platform): string => pathFor(platform).delimiter;

/** An environment variable by name, case-insensitively as Windows reads it. */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** An environment's PATH, whatever its case (`Path` on Windows). */
export function envPath(env: NodeJS.ProcessEnv): string | undefined {
  return envValue(env, "PATH");
}

/**
 * A copy of `env` whose PATH is `value`, under the one key `PATH`: a Windows environment's `Path`
 * would otherwise sit beside it and the child would see whichever Windows picked first.
 */
export function withEnvPath(env: NodeJS.ProcessEnv, value: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, entry] of Object.entries(env)) if (key.toUpperCase() !== "PATH") out[key] = entry;
  out.PATH = value;
  return out;
}

/** The files Windows can start by name: the rest (npm's extensionless `sh` launcher, a `.ps1`) cannot be. */
const WINDOWS_RUNNABLE = /\.(?:exe|cmd|bat|com)$/i;

/** Whether Windows can start `file` itself: an `.exe`, `.cmd`, `.bat` or `.com`. */
export function isWindowsRunnable(file: string): boolean {
  return WINDOWS_RUNNABLE.test(file);
}

/**
 * The file names a command answers to on `platform`: itself on macOS and Linux; on Windows itself
 * when it already names a runnable file, else each PATHEXT suffix in order (`node.com`, `node.exe`, …).
 */
export function commandNames(command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}): string[] {
  if (!isWindows(platform) || isWindowsRunnable(command)) return [command];
  return executableNames(command, platform, env);
}

/**
 * The file names `tool` answers to on `platform`: itself on macOS and Linux, and on Windows each
 * PATHEXT suffix in order (`node.com`, `node.exe`, …).
 */
export function executableNames(tool: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}): string[] {
  if (!isWindows(platform)) return [tool];
  const extensions = (envValue(env, "PATHEXT") || DEFAULT_PATHEXT).split(";").filter(Boolean);
  return extensions.map((extension) => `${tool}${extension.toLowerCase()}`);
}

/**
 * Where package managers install themselves, in the order a shell would find them. On macOS nvm
 * and Volta are version-managed and live under $HOME, which is why the login shell is asked
 * first — these are the fallback for the case where the shell cannot be read at all.
 */
export function candidateDirs(
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (isWindows(platform)) return windowsCandidateDirs(home, env);
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.posix.join(home, ".local", "bin"),
    path.posix.join(home, ".volta", "bin"),
    path.posix.join(home, ".bun", "bin"),
    path.posix.join(home, "n", "bin"),
  ];
}

/** The Node installer's folder, npm's global prefix, pnpm, Volta, Bun and Scoop on Windows. */
function windowsCandidateDirs(home: string, env: NodeJS.ProcessEnv): string[] {
  const join = path.win32.join;
  const appData = envValue(env, "APPDATA") || join(home, "AppData", "Roaming");
  const localAppData = envValue(env, "LOCALAPPDATA") || join(home, "AppData", "Local");
  const programFiles = envValue(env, "ProgramFiles") || "C:\\Program Files";
  return [
    join(programFiles, "nodejs"),
    join(appData, "npm"),
    join(localAppData, "pnpm"),
    join(localAppData, "Volta", "bin"),
    join(home, ".bun", "bin"),
    join(home, "scoop", "shims"),
  ];
}

/** A PATH entry without its trailing separators; a bare root (`/`, `C:\`) keeps its own. */
function trimEntry(entry: string, platform: NodeJS.Platform): string {
  const trimmed = entry.trim();
  const trailing = isWindows(platform) ? /[\\/]+$/ : /\/+$/;
  const dir = trimmed.replace(trailing, "");
  const bareRoot = !dir || (isWindows(platform) && /^[a-z]:$/i.test(dir));
  return bareRoot ? trimmed : dir;
}

/**
 * One PATH out of several, in that order of trust, with duplicates and empty segments dropped
 * (compared case-insensitively on Windows). On macOS the login shell comes first: it is the PATH
 * the user's own `npm run build` would have used.
 */
export function mergePathsFor(platform: NodeJS.Platform, ...sources: Array<string | null | undefined>): string {
  const delimiter = pathDelimiter(platform);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const entry of (source ?? "").split(delimiter)) {
      const dir = trimEntry(entry, platform);
      const key = isWindows(platform) ? dir.toLowerCase() : dir;
      if (!dir || seen.has(key)) continue;
      seen.add(key);
      out.push(dir);
    }
  }
  return out.join(delimiter);
}

/** `mergePathsFor` with the `:` separator of macOS and Linux. */
export function mergePaths(...sources: Array<string | null | undefined>): string {
  return mergePathsFor(StudioPlatform.Mac, ...sources);
}

/**
 * Whether a PATH carries anything the app was not launched with — the login shell's own entries.
 * Windows has no launchd PATH to tell apart: any entry counts.
 */
export function hasLoginEntries(resolved: string, platform: NodeJS.Platform = process.platform): boolean {
  if (isWindows(platform)) return resolved.split(pathDelimiter(platform)).some(Boolean);
  return resolved.split(":").some((dir) => dir && !LAUNCHD_PATH.includes(dir));
}

export interface Toolchain {
  /** PATH for every sandboxed process the studio starts. */
  path: string;
  /** Absolute path of each tool that was found, so a preflight can say what is missing. */
  found: Partial<Record<BuildTool, string>>;
  /** True when the login shell answered; false means only the candidate directories are in (always on Windows). */
  fromLoginShell: boolean;
}

export interface ToolchainDeps {
  /** Ask the user's login shell for its PATH. Returns null when it cannot be read. Never asked on Windows. */
  loginPath?: () => Promise<string | null>;
  /** Windows: the machine and user PATH the registry holds now. Returns null when it cannot be read. */
  registryPath?: () => Promise<string | null>;
  /** Is this file an executable? */
  executable?: (file: string) => Promise<boolean>;
  home?: string;
  envPath?: string | undefined;
  /** The operating system to resolve for; the host's by default. */
  platform?: NodeJS.Platform;
  /** Where PATH, and on Windows APPDATA, LOCALAPPDATA, ProgramFiles and PATHEXT, are read. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the toolchain once. `-lic` (login **and** interactive) is the same incantation
 * `claude-cli.ts` and `codex-cli.ts` already use to find their binaries: nvm and Volta hook
 * themselves into `.zshrc`, which a non-interactive login shell never reads. Windows has no
 * login shell to ask: null, at once.
 */
export async function readLoginPath(
  timeoutMs = LOGIN_PATH_TIMEOUT_MS,
  signal?: AbortSignal,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  signal?.throwIfAborted();
  if (isWindows(platform)) return null;
  let shell = DEFAULT_LOGIN_SHELL;
  try {
    shell = os.userInfo().shell || shell;
  } catch {
    /* Standard macOS fallback. */
  }
  // Fixed commands only; never accept shell instructions from a game or agent.
  const command = path.basename(shell) === "fish" ? "string join : $PATH" : 'echo "$PATH"';
  return new Promise((resolve) => {
    const child = spawn(shell, ["-lic", command], { stdio: ["ignore", "pipe", "pipe"] });
    let done = false;
    let out = "";
    let timer: ReturnType<typeof setTimeout>;
    const abort = (): void => {
      child.kill("SIGKILL");
      settle(null);
    };
    const settle = (value: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    timer = setTimeout(abort, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      out = (out + chunk.toString("utf8")).slice(-MAX_LOGIN_OUTPUT_CHARS);
    });
    child.stderr.resume();
    child.on("error", () => settle(null));
    child.on("close", () => settle(out.trim().split("\n").filter(Boolean).at(-1) ?? null));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

/** `%NAME%` references expanded from `env`, case-insensitively; an unknown name stays as written. */
export function expandWindowsVariables(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%;]+)%/g, (whole, name: string) => envValue(env, name) ?? whole);
}

/** The `Path` value out of `reg query <key> /v Path` output, or null when the key has none. */
export function parseRegistryPath(output: string): string | null {
  const row = /^\s+Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(output);
  return row?.[1]?.trim() || null;
}

/** One registry key's PATH, or null when `reg.exe` cannot answer in time. */
function queryRegistryPath(regExe: string, key: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      regExe,
      ["query", key, "/v", "Path"],
      { timeout: REGISTRY_PATH_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error ? null : parseRegistryPath(String(stdout))),
    );
  });
}

/**
 * Windows: the machine PATH, then the user's, as the registry holds them now, with `%VARS%`
 * expanded. `reg.exe` is named by its full path so a PATH entry can never stand in for it.
 */
export async function readRegistryPath(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const systemRoot = envValue(env, "SystemRoot") || "C:\\Windows";
  const regExe = path.win32.join(systemRoot, "System32", "reg.exe");
  const values = await Promise.all(REGISTRY_PATH_KEYS.map((key) => queryRegistryPath(regExe, key)));
  const found = values.filter((value): value is string => value !== null);
  return found.length ? expandWindowsVariables(found.join(";"), env) : null;
}

/** The PATH sources in order of trust: the login shell, then ours, on macOS; ours, then the registry's, on Windows. */
async function pathSources(deps: ToolchainDeps, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  const own = deps.envPath === undefined ? envPath(env) : deps.envPath;
  if (isWindows(platform)) {
    const registry = await (deps.registryPath ?? (() => readRegistryPath(env)))().catch(() => null);
    return { login: null, sources: [own, registry] };
  }
  const login = await (deps.loginPath ?? (() => readLoginPath(undefined, undefined, platform)))().catch(() => null);
  return { login, sources: [login, own] };
}

export async function resolveToolchain(deps: ToolchainDeps = {}): Promise<Toolchain> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  const isExecutable = deps.executable ?? executable;
  const { login, sources } = await pathSources(deps, platform, env);
  const present: string[] = [];
  for (const dir of candidateDirs(home, platform, env))
    if (await isExecutable(dir).catch(() => false)) present.push(dir);
  const launchd = isWindows(platform) ? [] : LAUNCHD_PATH;
  const resolved = mergePathsFor(platform, ...sources, ...present, ...launchd);

  const dirs = resolved.split(pathDelimiter(platform));
  const found: Partial<Record<BuildTool, string>> = {};
  for (const tool of BUILD_TOOLS) {
    const names = executableNames(tool, platform, env);
    const file = await firstExecutable(dirs, names, isExecutable, pathFor(platform));
    if (file) found[tool] = file;
  }
  return { path: resolved, found, fromLoginShell: typeof login === "string" && login.length > 0 };
}

/** Where a tool is found first along `dirs`, under any of its `names`, as a shell would find it; null when nowhere. */
async function firstExecutable(
  dirs: string[],
  names: string[],
  isExecutable: (file: string) => Promise<boolean>,
  paths: path.PlatformPath,
): Promise<string | null> {
  for (const dir of dirs) {
    for (const name of names) {
      const file = paths.join(dir, name);
      if (await isExecutable(file).catch(() => false)) return file;
    }
  }
  return null;
}

/** Memoised: the login shell is asked once per app run, not once per build. */
let cached: Promise<Toolchain> | null = null;
export function toolchain(deps?: ToolchainDeps): Promise<Toolchain> {
  if (!cached || deps) cached = resolveToolchain(deps ?? {});
  return cached;
}

/**
 * Ask the login shell again. A user who saw "exit 127" and installed Node in Terminal is
 * pressing Try again *because* the machine changed; answering from a PATH resolved at boot
 * fails with the identical three lines and the stage stays broken until the app restarts.
 */
export function resetToolchain(): void {
  cached = null;
}

async function executable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface PackageCommands {
  /** npm | pnpm | yarn | bun — whichever lockfile the folder carries. */
  manager: "npm" | "pnpm" | "yarn" | "bun";
  /** What the user's "Install packages" button runs. */
  install: string;
  /**
   * How that manager adds a named package to the game (`genex__package`), before the quoted name:
   * saved exactly, so package.json records Studio's pin rather than a caret range.
   */
  add: string;
  /** How to run the package's `build` script with that manager. */
  build: string;
}

const NPM_COMMANDS: PackageCommands = {
  manager: "npm",
  install: "npm install",
  add: "npm install --save-exact",
  build: "npm run build",
};
const PNPM_COMMANDS: PackageCommands = {
  manager: "pnpm",
  install: "pnpm install",
  add: "pnpm add --save-exact",
  build: "pnpm run build",
};
const YARN_COMMANDS: PackageCommands = {
  manager: "yarn",
  install: "yarn install",
  add: "yarn add --exact",
  build: "yarn build",
};
const BUN_COMMANDS: PackageCommands = {
  manager: "bun",
  install: "bun install",
  add: "bun add --exact",
  build: "bun run build",
};

const LOCKFILES: Array<{ file: string; commands: PackageCommands }> = [
  { file: "pnpm-lock.yaml", commands: PNPM_COMMANDS },
  { file: "yarn.lock", commands: YARN_COMMANDS },
  { file: "bun.lockb", commands: BUN_COMMANDS },
  { file: "bun.lock", commands: BUN_COMMANDS },
  { file: "package-lock.json", commands: NPM_COMMANDS },
  { file: "npm-shrinkwrap.json", commands: NPM_COMMANDS },
];

/**
 * Which package manager a folder is built with, from its lockfile. `npm run build` in a pnpm
 * workspace installs a second, divergent node_modules; running the manager the lockfile names
 * is the difference between the user's build and ours.
 */
export function packageCommands(files: string[]): PackageCommands {
  for (const row of LOCKFILES) if (files.includes(row.file)) return row.commands;
  return NPM_COMMANDS;
}

/**
 * The only command lines the studio's one network exemption may ever wrap. `studio.json` lives
 * inside the user's game folder — a downloaded game ships one, and a contractor can write one
 * mid-run — so a recorded `install` is honoured only when it is a package manager's own
 * install, never `npm install && curl … | sh`.
 */
export const INSTALL_COMMANDS: readonly string[] = [...new Set(LOCKFILES.map((row) => row.commands.install))];

/** Whether a command line is one of those four literals. */
export function isInstallCommand(command: unknown): boolean {
  return typeof command === "string" && INSTALL_COMMANDS.includes(command.trim());
}

/** The same, read off disk. */
export async function packageCommandsIn(dir: string): Promise<PackageCommands> {
  const files = (await readdir(dir).catch(() => [] as string[])) as string[];
  return packageCommands(files);
}
