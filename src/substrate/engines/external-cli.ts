/** Host-only discovery. Never consumes a game instruction or agent-provided command. */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, readdir, realpath, stat, mkdir, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  envPath,
  envValue,
  executableNames,
  isWindows,
  isWindowsRunnable,
  pathDelimiter,
  readLoginPath,
  withEnvPath,
} from "../toolchain.ts";
import { commandLaunch } from "../command-launch.ts";
import { stopChild } from "../process-tree.ts";
import { childEnv } from "../child-env.ts";
import { atomicWriteText } from "../fsx.ts";
import type { CodingProvider, CodingCliStatus } from "../../shared/coding-cli.ts";
import { errorMessage } from "../../shared/errors.ts";
import { CodingCliState } from "../../shared/coding-cli.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { EngineId } from "../../shared/providers.ts";
export interface CliInstallation {
  status: CodingCliStatus;
  env: NodeJS.ProcessEnv;
}
export interface DiscoveryOptions {
  override?: string;
  loginPath?: string;
  /** How the login shell's PATH is read when `loginPath` is not given; tests stand in for the shell. */
  loginShell?: () => Promise<string | null>;
  home?: string;
  excludedRoots?: string[];
  env?: NodeJS.ProcessEnv;
  standardDirs?: string[];
  signal?: AbortSignal;
  /** The operating system whose file names and launchers apply; the host's by default. */
  platform?: NodeJS.Platform;
}
/** The executable each coding CLI installs as. */
const CLI_BINARY = {
  [EngineId.Codex]: "codex",
  [EngineId.ClaudeCode]: "claude",
  [EngineId.OpenCode]: "opencode",
} as const satisfies Record<CodingProvider, string>;
/** Where the user is sent to install each CLI. */
const GUIDANCE_URL = {
  [EngineId.Codex]: "https://developers.openai.com/codex/cli/",
  [EngineId.ClaudeCode]: "https://code.claude.com/docs/en/setup",
  [EngineId.OpenCode]: "https://opencode.ai/docs/",
} as const satisfies Record<CodingProvider, string>;
/** The help each CLI is asked for, and the options it must list: every one Studio passes. */
const HELP_ARGS: Record<CodingProvider, string[]> = {
  [EngineId.Codex]: ["exec", "--help"],
  [EngineId.ClaudeCode]: ["--help"],
  [EngineId.OpenCode]: ["run", "--help"],
};
const REQUIRED_FLAGS: Record<CodingProvider, string[]> = {
  [EngineId.Codex]: ["--json", "--output-schema", "--ignore-user-config", "--skip-git-repo-check"],
  [EngineId.ClaudeCode]: [
    "--input-format",
    "--output-format",
    "--strict-mcp-config",
    "--setting-sources",
    "--permission-mode",
    "--mcp-config",
    "--allowedTools",
    "--disallowedTools",
  ],
  // `opencode run` v2 lists these; a 1.x CLI advertising `--pure` or `--variant` is refused below.
  [EngineId.OpenCode]: ["--format", "--session", "--model", "--agent", "--file"],
};
/** Flags a current CLI must not list: their presence means a 1.x CLI that v2 replaced. */
const STALE_FLAGS: Record<CodingProvider, string[]> = {
  [EngineId.Codex]: [],
  [EngineId.ClaudeCode]: [],
  [EngineId.OpenCode]: ["--pure", "--variant"],
};
/** How long reading the login shell's PATH, and each `--version`/`--help` probe, may take. */
const LOGIN_PATH_TIMEOUT_MS = 8 * SECOND_MS;
const PROBE_TIMEOUT_MS = 8 * SECOND_MS;
/** A probe keeps the last this-many characters of what the CLI printed. */
const PROBE_OUTPUT_CHARS = 32_768;
/** How long a discovery result serves UI and model-list reads. */
const DIAGNOSTIC_CACHE_MS = 15 * SECOND_MS;
/** Enough of a launcher's first bytes to hold its `#!` line, or all of an npm `.cmd` shim. */
const LAUNCHER_BYTES = 4096;
/** npm's `.cmd` shim runs the `node.exe` beside it, else the first `node` on PATH. */
const CMD_SHIM_PATH_NODE = /_prog=node\b/i;

/** What discovery tells the user about a CLI it could not use, and why a probe or setting fails. */
const MESSAGE = {
  Install: "Install this coding CLI, then check again.",
  InvalidPath:
    "The selected path is missing, not executable, or belongs to Studio/a game. Choose an external executable or use automatic discovery.",
  MissingNode:
    "This npm launcher requires Node on your login-shell PATH. Install Node or choose a native CLI installation.",
  Ready: "External CLI detected. Authentication is checked separately. Install and update it outside Studio.",
  UnknownProvider: "Unknown coding provider",
  SettingsUninitialized: "Coding CLI settings are not initialized",
  Stopped: "Stopped",
  ProbeTimedOut: `CLI diagnostic timed out after ${PROBE_TIMEOUT_MS / SECOND_MS} seconds`,
  NoVersion: "CLI did not report a version",
  MissingOptions: (missing: string[]) => `Required CLI options are unavailable: ${missing.join(", ")}`,
  StaleOptions: (stale: string[]) =>
    `Outdated CLI options found: ${stale.join(", ")}. Update OpenCode, then check again.`,
} as const;

const diagnostics = new Map<string, { at: number; value: CliInstallation }>();
/**
 * The login shell's PATH, read once and shared by every discovery: a login shell takes seconds to
 * start (2.1–2.3 s on a developer's Mac), and every session start discovers its CLI.
 * Recheck and a settings change read it again; a read that failed is not kept.
 */
let loginPathRead: Promise<string | null> | null = null;
/**
 * A CLI's answers to `--version` and `--help`, by the exact file that gave them (its real path,
 * size, modification time and inode): an updated or replaced CLI is asked again, an unchanged one
 * is not asked before every session.
 */
const answered = new Map<string, { version: string; help: string }>();
/** Forget what discovery knows, for one provider or all; the login shell's PATH is read again either way. */
export function invalidateCodingCli(provider?: CodingProvider): void {
  for (const key of diagnostics.keys()) if (!provider || key.startsWith(`${provider}:`)) diagnostics.delete(key);
  for (const key of answered.keys()) if (!provider || key.startsWith(`${provider}\0`)) answered.delete(key);
  loginPathRead = null;
}
let settingsFile: string | undefined;
let discoveryDefaults: Pick<DiscoveryOptions, "loginPath" | "loginShell" | "home" | "env" | "standardDirs"> = {};
let excludedRoots: string[] = [process.cwd()];
export function configureCodingClis(file: string, roots: string[], discovery: typeof discoveryDefaults = {}): void {
  settingsFile = file;
  excludedRoots = roots;
  discoveryDefaults = { ...discovery };
  invalidateCodingCli();
}
function providerId(value: string): asserts value is CodingProvider {
  if (!Object.hasOwn(CLI_BINARY, value)) throw new Error(MESSAGE.UnknownProvider);
}
/**
 * The executable a coding CLI installs as (`claude`, `codex`), for callers such as the eval
 * scripts that must never spell a binary name themselves. Throws for an engine that is no coding CLI.
 */
export function codingCliBinary(provider: string): string {
  providerId(provider);
  return CLI_BINARY[provider];
}
async function overrides(): Promise<Partial<Record<CodingProvider, string>>> {
  if (!settingsFile) return {};
  try {
    return JSON.parse(await readFile(settingsFile, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}
let settingsWrite: Promise<unknown> = Promise.resolve();
export async function setCodingCliOverride(provider: CodingProvider, executable: string | null): Promise<void> {
  providerId(provider);
  if (!settingsFile) throw new Error(MESSAGE.SettingsUninitialized);
  const file = settingsFile;
  const operation = settingsWrite
    .catch(() => {})
    .then(async () => {
      const values = await overrides();
      if (executable === null) delete values[provider];
      else values[provider] = executable;
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await atomicWriteText(file, JSON.stringify(values, null, 2), { mode: 0o600 });
      invalidateCodingCli(provider);
    });
  settingsWrite = operation;
  await operation;
}
async function executable(file: string, platform: NodeJS.Platform): Promise<boolean> {
  if (isWindows(platform) && !isWindowsRunnable(file)) return false;
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
function within(file: string, root: string): boolean {
  const rel = path.relative(root, file);
  return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}
async function probe(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  platform: NodeJS.Platform,
): Promise<string> {
  signal?.throwIfAborted();
  const launch = commandLaunch(file, args, platform);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.file, launch.args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
    let output = "";
    // A `.cmd` CLI runs under cmd.exe: its Node ends only with the whole tree.
    const stop = (): void => void stopChild(child, { platform });
    const abort = (): void => {
      stop();
      reject(signal?.reason ?? new Error(MESSAGE.Stopped));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      stop();
      reject(new Error(MESSAGE.ProbeTimedOut));
    }, PROBE_TIMEOUT_MS);
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk) => {
        output = (output + chunk).slice(-PROBE_OUTPUT_CHARS);
      });
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      code === 0 ? resolve(output.trim()) : reject(new Error(output || `CLI exited ${code}`));
    });
  });
}
/** The ChatGPT app's bundle names: today's, then the one it had as the Codex app. */
const CHATGPT_APP_NAMES = ["ChatGPT.app", "Codex.app"];
/** Where macOS apps are installed: for everyone, then for this account alone. */
const macApplications = (home: string): string[] => ["/Applications", path.join(home, "Applications")];

/**
 * Where installers put these CLIs when the login shell does not say (a slow or broken shell profile,
 * or an install whose PATH line was never added). Settings has no manual path picker, so this list
 * is the whole answer: native installers, Homebrew, npm prefixes, Volta, Bun, Claude Code's legacy
 * `~/.claude/local` install (reached only through a shell alias), pnpm, mise and asdf shims, the
 * Node versions of nvm and fnm, newest first, and last the copies the Claude and ChatGPT apps ship.
 * On Windows: Claude Code's and Codex's native installers, npm's global prefix,
 * the Node installer's folder, pnpm, Volta, Bun and Scoop.
 */
export async function standardCliDirs(
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  applications: string[] = macApplications(home),
): Promise<string[]> {
  if (isWindows(platform)) return windowsCliDirs(home, env);
  const mac = platform === "darwin";
  const fnmRoots = [".fnm", mac ? "Library/Application Support/fnm" : ".local/share/fnm"].map((dir) =>
    path.join(home, dir, "node-versions"),
  );
  const fnm = await Promise.all(fnmRoots.map((root) => nodeVersionBins(root, "installation/bin")));
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".local/bin"),
    path.join(home, ".claude/local"),
    path.join(home, ".npm-global/bin"),
    path.join(home, ".volta/bin"),
    path.join(home, ".bun/bin"),
    path.join(home, ".codex/bin"),
    path.join(home, ".opencode/bin"),
    path.join(home, mac ? "Library/pnpm" : ".local/share/pnpm"),
    path.join(home, ".local/share/mise/shims"),
    path.join(home, ".asdf/shims"),
    ...(await nodeVersionBins(path.join(home, ".nvm/versions/node"), "bin")),
    ...fnm.flat(),
    "/usr/bin",
    "/bin",
    ...(mac ? await desktopAppCliDirs(home, applications) : []),
  ];
}
/**
 * The CLIs the desktop apps ship, searched last so that one the person installed always wins. The
 * Claude app keeps Claude Code under Application Support, one folder per version and build; the
 * ChatGPT app (named Codex before) carries a Codex launcher that runs the copy inside it.
 */
async function desktopAppCliDirs(home: string, applications: string[]): Promise<string[]> {
  const claude = path.join(home, "Library/Application Support/Claude/claude-code");
  const builds = await Promise.all(
    (await versionsNewestFirst(claude)).map(async (version) =>
      (await entryNames(path.join(claude, version))).map((build) =>
        path.join(claude, version, build, "claude.app/Contents/MacOS"),
      ),
    ),
  );
  const chatgpt = applications.flatMap((dir) =>
    CHATGPT_APP_NAMES.map((app) => path.join(dir, app, "Contents/Resources/codex-cli/bin")),
  );
  return [...builds.flat(), ...chatgpt];
}
/** Each Node version's `bin` under a version manager's `root`, newest first; none without the manager. */
async function nodeVersionBins(root: string, bin: string): Promise<string[]> {
  return (await versionsNewestFirst(root)).map((version) => path.join(root, version, bin));
}
/** The `1.2.3` or `v1.2.3` folders in `dir`, newest first; none when `dir` cannot be read. */
async function versionsNewestFirst(dir: string): Promise<string[]> {
  const versions = (await entryNames(dir)).filter((name) => /^v?\d+\.\d+\.\d+$/.test(name));
  return versions.sort(newestVersionFirst);
}
/** The names in `dir`; none when it is missing or unreadable. */
async function entryNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
/** Where the coding CLIs install themselves on Windows, native installers first. */
function windowsCliDirs(home: string, env: NodeJS.ProcessEnv): string[] {
  const join = path.win32.join;
  const variable = (name: string, fallback: string): string => envValue(env, name) || fallback;
  const appData = variable("APPDATA", join(home, "AppData", "Roaming"));
  const localAppData = variable("LOCALAPPDATA", join(home, "AppData", "Local"));
  return [
    join(home, ".local", "bin"),
    // Codex's own installer (install.ps1) puts its launcher here and adds it to the user's PATH,
    // which a Studio already running never sees.
    join(localAppData, "Programs", "OpenAI", "Codex", "bin"),
    join(appData, "npm"),
    join(variable("ProgramFiles", "C:\\Program Files"), "nodejs"),
    join(localAppData, "pnpm"),
    join(localAppData, "Volta", "bin"),
    join(home, ".bun", "bin"),
    join(home, "scoop", "shims"),
  ];
}
/** Sort order for `v24.1.0`- and `2.1.286`-style names: the newest version first. */
function newestVersionFirst(a: string, b: string): number {
  const left = a.replace(/^v/, "").split(".").map(Number);
  const right = b.replace(/^v/, "").split(".").map(Number);
  for (const [index, part] of right.entries()) {
    const difference = part - (left[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/** The CLI's own version number for display ("2.1.280 (Claude Code)" → "2.1.280"). */
export function cliVersion(raw?: string): string | undefined {
  if (!raw) return undefined;
  return /\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?/.exec(raw)?.[0] ?? raw.split(/\s+/)[0];
}

/**
 * Find a provider's CLI on this computer — the override when one is set, else the first external
 * executable on the login shell's PATH (the process's on Windows, under its PATHEXT names) — and
 * check that it runs and speaks the flags we need.
 */
export async function discoverCodingCli(
  provider: CodingProvider,
  options: DiscoveryOptions = {},
): Promise<CliInstallation> {
  providerId(provider);
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const parent = options.env ?? process.env;
  const dirs = await cliSearchDirs(options, parent, home, platform);
  const env = withEnvPath(parent, dirs.join(pathDelimiter(platform)));
  const manual = options.override !== undefined;
  const status: CodingCliStatus = {
    provider,
    state: CodingCliState.Missing,
    selection: manual ? "manual" : "automatic",
    detail: MESSAGE.Install,
    guidanceUrl: GUIDANCE_URL[provider],
  };
  const names = executableNames(CLI_BINARY[provider], platform, env);
  const automatic = dirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
  const candidates = options.override !== undefined ? [options.override] : automatic;
  const selected = await firstExternalExecutable(candidates, await excludedRealRoots(options), { manual, platform });
  if (!selected) {
    if (options.override !== undefined) {
      status.state = CodingCliState.InvalidPath;
      status.path = options.override;
      status.detail = MESSAGE.InvalidPath;
    }
    return { status, env };
  }
  status.path = selected;
  await checkSelectedCli(provider, selected, { dirs, env, signal: options.signal, platform }, status);
  return { status, env };
}

/** The folders searched for a CLI: the login shell's PATH, then ours, then the usual install folders. */
async function cliSearchDirs(
  options: DiscoveryOptions,
  parent: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform,
): Promise<string[]> {
  const loginPath = options.loginPath ?? (await sharedLoginPath(options, platform));
  options.signal?.throwIfAborted();
  const delimiter = pathDelimiter(platform);
  return [
    ...new Set(
      [
        ...(loginPath ?? "").split(delimiter),
        ...(envPath(parent) ?? "").split(delimiter),
        ...(options.standardDirs ?? (await standardCliDirs(home, platform, parent))),
      ].filter((p) => path.isAbsolute(p)),
    ),
  ];
}

/** The login shell's PATH from the one shared read; a caller's Stop ends its own wait, not the read. */
async function sharedLoginPath(options: DiscoveryOptions, platform: NodeJS.Platform): Promise<string | null> {
  options.signal?.throwIfAborted();
  if (!loginPathRead) {
    const shell = options.loginShell ?? (() => readLoginPath(LOGIN_PATH_TIMEOUT_MS, undefined, platform));
    const read: Promise<string | null> = shell()
      .catch(() => null)
      .then((value) => {
        if (value === null && loginPathRead === read) loginPathRead = null;
        return value;
      });
    loginPathRead = read;
  }
  return untilStopped(loginPathRead, options.signal);
}

/** `promise`'s answer, or null as soon as `signal` stops the wait. */
function untilStopped<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | null> {
  if (!signal) return promise;
  return new Promise((resolve) => {
    const stop = (): void => resolve(null);
    signal.addEventListener("abort", stop, { once: true });
    void promise.then((value) => {
      signal.removeEventListener("abort", stop);
      resolve(value);
    });
  });
}

/** The exact file a launcher runs, as a cache key; null when it cannot be told (then nothing is reused). */
async function cliIdentity(provider: CodingProvider, file: string, platform: NodeJS.Platform): Promise<string | null> {
  // A Windows `.cmd` shim stays the same file when the package it starts is updated.
  if (isWindows(platform)) return null;
  try {
    const real = await realpath(file);
    const info = await stat(real, { bigint: true });
    return [provider, real, info.size, info.mtimeNs, info.ino].join("\0");
  } catch {
    return null;
  }
}

/** What checking a selected CLI needs: its search folders, launch environment, stop signal and platform. */
interface CheckContext {
  dirs: string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal | undefined;
  platform: NodeJS.Platform;
}

/** Whether the chosen CLI can run here and speaks what we need; the verdict lands in `status`. */
async function checkSelectedCli(
  provider: CodingProvider,
  selected: string,
  context: CheckContext,
  status: CodingCliStatus,
): Promise<void> {
  try {
    // A launcher using env node needs the same login-shell PATH at invocation time.
    const runtimeProblem = await launcherProblem(selected, context.dirs, context.platform);
    if (runtimeProblem) {
      status.state = CodingCliState.MissingRuntime;
      status.detail = runtimeProblem;
      return;
    }
    await checkCliCapabilities(provider, selected, context, status);
    status.state = CodingCliState.Ready;
    status.detail = MESSAGE.Ready;
  } catch (error) {
    context.signal?.throwIfAborted();
    status.state = CodingCliState.Incompatible;
    status.detail = `${status.version ?? "Unknown version"}: ${errorMessage(error)}`;
  }
}

/** The roots discovery must never pick an executable from, resolved through their links. */
async function excludedRealRoots(options: DiscoveryOptions): Promise<string[]> {
  return Promise.all(
    (options.excludedRoots ?? excludedRoots).map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return path.resolve(root);
      }
    }),
  );
}

/** The first candidate that is an executable file outside Studio and every game. */
async function firstExternalExecutable(
  candidates: string[],
  roots: string[],
  selection: { manual: boolean; platform: NodeJS.Platform },
): Promise<string | undefined> {
  for (const candidate of candidates) {
    const runnable = path.isAbsolute(candidate) && (await executable(candidate, selection.platform));
    if (!runnable) continue;
    const target = await realpath(candidate);
    if (!belongsToStudioOrGame(candidate, target, roots, selection.manual)) return candidate;
  }
  return undefined;
}

/**
 * Never select Studio's dependencies, packaged resources, or game-local installations. A global
 * npm prefix (`lib/node_modules`, `share/node_modules`) is an installation, not a dependency;
 * a manual choice may point into `node_modules` on purpose. Windows paths are read with `/`.
 */
function belongsToStudioOrGame(candidate: string, target: string, roots: string[], manual: boolean): boolean {
  const slashed = target.replaceAll("\\", "/");
  const dependency = !manual && slashed.includes("/node_modules/") && !/\/(?:lib|share)\/node_modules\//.test(slashed);
  const insideExcluded = roots.some((root) => within(target, root) || within(candidate, root));
  const packaged = /(?:app\.asar(?:\.unpacked)?|claude-agent-sdk-[^/]+)\//.test(slashed);
  return dependency || insideExcluded || packaged;
}

/** Whether a `node` (by its platform's names) is in any of `dirs`. */
async function nodeIn(dirs: string[], platform: NodeJS.Platform): Promise<boolean> {
  const names = executableNames("node", platform);
  const files = dirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
  return (await Promise.all(files.map((file) => executable(file, platform)))).some(Boolean);
}

/**
 * Why a launcher script cannot start: its `env node` (an npm `.cmd` shim's `node` on Windows) is
 * not on the PATH, or its interpreter is gone.
 */
async function launcherProblem(file: string, dirs: string[], platform: NodeJS.Platform): Promise<string | null> {
  if (isWindows(platform)) return windowsLauncherProblem(file, dirs, platform);
  const shebang = (await launcherHead(file)).split("\n")[0] ?? "";
  const needsNode = /^#!.*\/env\s+(?:-S\s+)?node\b/.test(shebang);
  if (needsNode && !(await nodeIn(dirs, platform))) return MESSAGE.MissingNode;
  const interpreter = /^#!\s*(\/\S+)/.exec(shebang)?.[1];
  if (interpreter && !(await executable(interpreter, platform))) {
    return `Launcher interpreter is missing or not executable: ${interpreter}`;
  }
  return null;
}

/** Windows has no `#!`: only an npm `.cmd` shim needs a Node, beside it or on the PATH. */
async function windowsLauncherProblem(file: string, dirs: string[], platform: NodeJS.Platform): Promise<string | null> {
  if (!/\.cmd$/i.test(file) || !CMD_SHIM_PATH_NODE.test(await launcherHead(file))) return null;
  const found = await nodeIn([path.dirname(file), ...dirs], platform);
  return found ? null : MESSAGE.MissingNode;
}

/** A launcher's first bytes: where a script names its interpreter. */
async function launcherHead(file: string): Promise<string> {
  const handle = await open(file, "r");
  const bytes = Buffer.alloc(LAUNCHER_BYTES);
  try {
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead).toString();
  } finally {
    await handle.close();
  }
}

/**
 * Ask the CLI for its version (recorded on `status` as soon as it answers) and its help, and
 * check the help names every option Studio passes; throws what is missing.
 */
async function checkCliCapabilities(
  provider: CodingProvider,
  file: string,
  context: CheckContext,
  status: CodingCliStatus,
): Promise<void> {
  const { signal, platform } = context;
  // M6: a version and a help text need no credential; the CLI is asked with none.
  const probeEnv = childEnv(context.env, { base: "contractor", vendor: CLI_BINARY[provider] });
  const identity = await cliIdentity(provider, file, platform);
  const known = identity ? answered.get(identity) : undefined;
  status.version =
    known?.version ?? (await probe(file, ["--version"], probeEnv, signal, platform)).split("\n")[0]?.trim();
  if (!status.version) throw new Error(MESSAGE.NoVersion);
  const help = known?.help ?? (await probe(file, HELP_ARGS[provider], probeEnv, signal, platform));
  const missing = REQUIRED_FLAGS[provider].filter((flag) => !help.includes(flag));
  if (missing.length) throw new Error(MESSAGE.MissingOptions(missing));
  const stale = (STALE_FLAGS[provider] ?? []).filter((flag) => help.includes(flag));
  if (stale.length) throw new Error(MESSAGE.StaleOptions(stale));
  if (identity && !known) answered.set(identity, { version: status.version, help });
}
/** Brief cache for UI/model-list reads only. Sessions and explicit Recheck bypass it. */
export async function resolveCodingCli(
  provider: CodingProvider,
  override?: string,
  signal?: AbortSignal,
  refresh = false,
): Promise<CliInstallation> {
  providerId(provider);
  signal?.throwIfAborted();
  const selected = override ?? (await overrides())[provider];
  const key = `${provider}:${selected ?? "automatic"}`;
  const cached = diagnostics.get(key);
  const cacheFresh = cached !== undefined && Date.now() - cached.at < DIAGNOSTIC_CACHE_MS;
  if (!refresh && cacheFresh) return { status: { ...cached.value.status }, env: { ...cached.value.env } };
  let value = await discoverCodingCli(provider, { ...discoveryDefaults, override: selected, signal });
  // A persisted override that stopped working (moved, deleted, outdated) must not strand the user:
  // Settings has no path picker, so an automatic installation that works takes over.
  const savedOverrideBroken =
    override === undefined && selected !== undefined && value.status.state !== CodingCliState.Ready;
  if (savedOverrideBroken) {
    const automatic = await discoverCodingCli(provider, { ...discoveryDefaults, signal });
    if (automatic.status.state === CodingCliState.Ready || value.status.state === CodingCliState.InvalidPath)
      value = automatic;
  }
  diagnostics.set(key, { at: Date.now(), value });
  return { status: { ...value.status }, env: { ...value.env } };
}
export async function requireCodingCli(
  provider: CodingProvider,
  override?: string,
  signal?: AbortSignal,
  refresh = true,
): Promise<CliInstallation & { path: string }> {
  const result = await resolveCodingCli(provider, override, signal, refresh);
  if (result.status.state !== CodingCliState.Ready || !result.status.path) throw new Error(result.status.detail);
  return { ...result, path: result.status.path };
}
