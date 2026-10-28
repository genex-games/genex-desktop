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
import { commandLaunch, isCommandScript, npmShimScript } from "../command-launch.ts";
import { stopChild } from "../process-tree.ts";
import { childEnv } from "../child-env.ts";
import { atomicWriteText } from "../fsx.ts";
import type { CodingProvider, CodingCliStatus } from "../../shared/coding-cli.ts";
import { errorMessage } from "../../shared/errors.ts";
import { CodingCliState } from "../../shared/coding-cli.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { EngineId } from "../../shared/providers.ts";
import { OpenCodeDialect, OpenCodeVersionProblem, openCodeRelease } from "./opencode-cli.ts";
import { GROK_MIN_VERSION, grokTooOld } from "./grok-cli.ts";
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
  /** Each try's allowance for one `--version`/`--help` probe ({@link PROBE_TIMEOUTS_MS} by default). */
  probeTimeoutsMs?: readonly number[];
}
/**
 * The executable each coding CLI installs as. Cursor's installer links both `agent` and its older
 * name `cursor-agent`; Grok Build installs an `agent` too, so only the unambiguous name is looked for.
 */
const CLI_BINARY = {
  [EngineId.Codex]: "codex",
  [EngineId.ClaudeCode]: "claude",
  [EngineId.OpenCode]: "opencode",
  [EngineId.Grok]: "grok",
  [EngineId.Cursor]: "cursor-agent",
} as const satisfies Record<CodingProvider, string>;
/** Whose variables each CLI's own process keeps (`childEnv`'s vendor). */
const CLI_VENDOR = {
  [EngineId.Codex]: "codex",
  [EngineId.ClaudeCode]: "claude",
  [EngineId.OpenCode]: "opencode",
  [EngineId.Grok]: "grok",
  [EngineId.Cursor]: "cursor",
} as const satisfies Record<CodingProvider, string>;
/** Where the user is sent to install each CLI. */
const GUIDANCE_URL = {
  [EngineId.Codex]: "https://developers.openai.com/codex/cli/",
  [EngineId.ClaudeCode]: "https://code.claude.com/docs/en/setup",
  [EngineId.OpenCode]: "https://opencode.ai/docs/",
  [EngineId.Grok]: "https://docs.x.ai/build/overview",
  [EngineId.Cursor]: "https://cursor.com/docs/cli/installation",
} as const satisfies Record<CodingProvider, string>;
/** The help each CLI is asked for, and the options it must list: every one Studio passes. */
const HELP_ARGS: Record<CodingProvider, string[]> = {
  [EngineId.Codex]: ["exec", "--help"],
  [EngineId.ClaudeCode]: ["--help"],
  [EngineId.OpenCode]: ["run", "--help"],
  [EngineId.Grok]: ["--help"],
  [EngineId.Cursor]: ["--help"],
};
const REQUIRED_FLAGS: Record<Exclude<CodingProvider, typeof EngineId.OpenCode>, string[]> = {
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
  // Its help lists these; `grok.ts` also passes `--no-wait-for-background`, which only its manual names.
  [EngineId.Grok]: [
    "--prompt-file",
    "--output-format",
    "--resume",
    "--model",
    "--reasoning-effort",
    "--always-approve",
    "--allow",
    "--tools",
    "--disallowed-tools",
    "--disable-web-search",
    "--sandbox",
    "--cwd",
  ],
  [EngineId.Cursor]: ["--print", "--output-format", "--resume", "--model", "--force", "--trust", "--sandbox", "--mode"],
};
/**
 * `opencode run`'s options by the command line its version speaks: 1.18 lists every one (an older
 * 1.x without `--variant` or `--pure` is refused); 2.x runs each session on a private server.
 */
const OPENCODE_FLAGS: Record<OpenCodeDialect, string[]> = {
  [OpenCodeDialect.V1]: ["--format", "--session", "--model", "--agent", "--file", "--variant", "--pure", "--dir"],
  [OpenCodeDialect.V2]: ["--format", "--session", "--model", "--file", "--standalone"],
};
/** How long reading the login shell's PATH may take. */
const LOGIN_PATH_TIMEOUT_MS = 8 * SECOND_MS;
/**
 * Each try's allowance for a `--version`/`--help` probe. A probe that runs out of time is asked once
 * more with the longer one: a CLI's first start just after it was installed or updated waits while
 * Windows scans the new program, and on a slow PC (2 CPUs) that took more than 8 s, so a working
 * CLI was called incompatible.
 */
const PROBE_TIMEOUTS_MS = [8 * SECOND_MS, 45 * SECOND_MS] as const;
/** A probe keeps the last this-many characters of what the CLI printed. */
const PROBE_OUTPUT_CHARS = 32_768;
/** How long a discovery result serves UI and model-list reads. */
const DIAGNOSTIC_CACHE_MS = 15 * SECOND_MS;
/** Enough of a launcher's first bytes to hold its `#!` line, or all of an npm `.cmd` shim. */
const LAUNCHER_BYTES = 4096;
/** npm's `.cmd` shim runs the `node.exe` beside it, else the first `node` on PATH. */
const CMD_SHIM_PATH_NODE = /_prog=node\b/i;
/** A file inside an npm package, whose version tells an update apart: npm resets its files' times. */
const IN_NODE_MODULES = /[\\/]node_modules[\\/]/;
/** The file beside the overrides that keeps the CLIs' answers between launches. */
const ANSWERS_FILE = "coding-cli-answers.json";
/** What a Windows PowerShell 5 `Set-Content -Encoding utf8` puts before a file's text. */
const BYTE_ORDER_MARK = /^\uFEFF/;

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
  ProbeTimedOut: (ms: number) => `CLI diagnostic timed out after ${ms / SECOND_MS} seconds`,
  NoVersion: "CLI did not report a version",
  MissingOptions: (missing: string[]) => `Required CLI options are unavailable: ${missing.join(", ")}`,
  OpenCodeUnreadable: "Genex can't tell which OpenCode version this is. Install a released OpenCode, then check again.",
  OpenCodeTooOld:
    "This OpenCode is too old for Genex. Update OpenCode (Genex runs 1.18, and 2.x from 2.0.20), then check again.",
  OpenCodeTooNew: (major: number | null) =>
    `Genex doesn't run OpenCode ${major ?? ""}.x yet. Install OpenCode 2.x or 1.18, then check again.`,
  GrokTooOld: `This Grok Build is too old: xAI serves ${GROK_MIN_VERSION} or later. Update it, then check again.`,
} as const;

const diagnostics = new Map<string, { at: number; value: CliInstallation }>();
/** Unsigned UI readers can share discovery without sharing another caller's Stop signal. */
const diagnosticReads = new Map<string, Promise<CliInstallation>>();
/** Only the latest request for a selection may replace its cached diagnostic. */
const diagnosticOwners = new Map<string, symbol>();
const discoveryGenerations = new Map<CodingProvider, number>();
let answersRevision = 0;

function discoveryGeneration(provider: CodingProvider): number {
  return discoveryGenerations.get(provider) ?? 0;
}
/**
 * The login shell's PATH, read once and shared by every discovery: a login shell takes seconds to
 * start (2.1–2.3 s on a developer's Mac), and every session start discovers its CLI.
 * Recheck and a settings change read it again; a read that failed is not kept.
 */
let loginPathRead: Promise<string | null> | null = null;
/**
 * A CLI's answers to `--version` and `--help`, by the exact file that gave them (its real path,
 * size, modification time and inode, and its npm package's version): an updated or replaced CLI
 * is asked again, an unchanged one is not asked before every session. Kept on disk beside the
 * overrides, so a relaunch does not ask every CLI again either.
 */
const answered = new Map<string, CliAnswers>();
/** What a CLI said when asked: its version line and its help. */
interface CliAnswers {
  version: string;
  help: string;
}
/** Forget what discovery knows, for one provider or all; the login shell's PATH is read again either way. */
export function invalidateCodingCli(provider?: CodingProvider): void {
  forget(provider);
  void keepAnswers();
}
function forget(provider?: CodingProvider): void {
  const providers = provider ? [provider] : (Object.keys(CLI_BINARY) as CodingProvider[]);
  for (const id of providers) discoveryGenerations.set(id, discoveryGeneration(id) + 1);
  forgetEntries(diagnostics, provider, ":");
  forgetEntries(diagnosticReads, provider, ":");
  forgetEntries(diagnosticOwners, provider, ":");
  forgetEntries(answered, provider, "\0");
  answersRevision++;
  loginPathRead = null;
}

/** Drop only the invalidated provider's entries, or the whole cache when settings are replaced. */
function forgetEntries<T>(entries: Map<string, T>, provider: CodingProvider | undefined, delimiter: string): void {
  for (const key of entries.keys()) if (!provider || key.startsWith(`${provider}${delimiter}`)) entries.delete(key);
}
/** Where the answers are kept, beside the overrides; none before the app configures discovery. */
function answersFile(): string | undefined {
  return settingsFile ? path.join(path.dirname(settingsFile), ANSWERS_FILE) : undefined;
}
function isAnswers(value: unknown): value is CliAnswers {
  const answers = value as Partial<CliAnswers> | null;
  return typeof answers?.version === "string" && typeof answers.help === "string";
}
let answersWrite: Promise<unknown> = Promise.resolve();
/** Settles once the kept answers are read; every lookup waits for it. */
let answersRead: Promise<void> = Promise.resolve();
/** Read the answers a previous launch kept, after any write still on its way. */
function loadAnswers(): void {
  const file = answersFile();
  const revision = answersRevision;
  answersRead = file ? answersWrite.catch(() => {}).then(() => readKeptAnswers(file, revision)) : Promise.resolve();
}
/** The kept answers, beside any learned meanwhile; a missing or damaged file keeps none. */
async function readKeptAnswers(file: string, revision: number): Promise<void> {
  try {
    const kept: unknown = JSON.parse(await readFile(file, "utf8"));
    const staleOrInvalid = revision !== answersRevision || typeof kept !== "object" || kept === null;
    if (staleOrInvalid) return;
    for (const [identity, answers] of Object.entries(kept))
      if (isAnswers(answers) && !answered.has(identity)) answered.set(identity, answers);
  } catch {
    // Nothing kept, or nothing readable: every CLI is asked again.
  }
}
/** Keep the answers for the next launch, one write after another; settles when this one is on disk. */
function keepAnswers(): Promise<unknown> {
  const file = answersFile();
  if (!file) return Promise.resolve();
  const text = JSON.stringify(Object.fromEntries(answered));
  answersWrite = answersWrite
    .catch(() => {})
    .then(async () => {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await atomicWriteText(file, text, { mode: 0o600 });
    })
    .catch(() => {});
  return answersWrite;
}
let settingsFile: string | undefined;
let discoveryDefaults: Pick<DiscoveryOptions, "loginPath" | "loginShell" | "home" | "env" | "standardDirs"> = {};
let excludedRoots: string[] = [process.cwd()];
export function configureCodingClis(file: string, roots: string[], discovery: typeof discoveryDefaults = {}): void {
  settingsFile = file;
  excludedRoots = roots;
  discoveryDefaults = { ...discovery };
  forget();
  loadAnswers();
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
/**
 * The saved CLI paths. A file that cannot be read as them (a BOM is read past; a damaged, empty or
 * unreadable file is not) saves none, so every CLI is still found automatically: a throw here failed
 * every provider's discovery, and Settings called Claude Code and Codex uninstalled.
 */
async function overrides(): Promise<Partial<Record<CodingProvider, string>>> {
  if (!settingsFile) return {};
  try {
    const saved: unknown = JSON.parse((await readFile(settingsFile, "utf8")).replace(BYTE_ORDER_MARK, ""));
    if (typeof saved !== "object" || saved === null || Array.isArray(saved)) return {};
    const paths = Object.entries(saved).filter(
      (entry): entry is [CodingProvider, string] => Object.hasOwn(CLI_BINARY, entry[0]) && typeof entry[1] === "string",
    );
    return Object.fromEntries(paths);
  } catch {
    return {};
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
      forget(provider);
      await keepAnswers();
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
/** A probe that ran out of its allowance, which a longer one may still answer. */
class ProbeTimeout extends Error {}

/** One probe, asked again with the next allowance each time it runs out of time; the last timeout throws. */
async function probe(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  context: Pick<CheckContext, "signal" | "platform" | "probeTimeoutsMs">,
): Promise<string> {
  const allowances = context.probeTimeoutsMs.length > 0 ? context.probeTimeoutsMs : PROBE_TIMEOUTS_MS;
  for (const [i, timeoutMs] of allowances.entries()) {
    try {
      return await probeOnce(file, args, env, context, timeoutMs);
    } catch (error) {
      const last = i === allowances.length - 1;
      if (last || !(error instanceof ProbeTimeout)) throw error;
    }
  }
  throw new ProbeTimeout(MESSAGE.ProbeTimedOut(0));
}

async function probeOnce(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  { signal, platform }: Pick<CheckContext, "signal" | "platform">,
  timeoutMs: number,
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
      reject(new ProbeTimeout(MESSAGE.ProbeTimedOut(timeoutMs)));
    }, timeoutMs);
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
 * `~/.claude/local` install (reached only through a shell alias), Grok Build's `~/.grok/bin`, pnpm,
 * mise and asdf shims, the Node versions of nvm and fnm, newest first, and last the copies the Claude
 * and ChatGPT apps ship. On Windows: Claude Code's, Codex's and Grok Build's native installers, npm's global prefix,
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
    path.join(home, ".grok/bin"),
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
    // Grok Build's own installer (install.ps1) copies `grok.exe` here.
    join(home, ".grok", "bin"),
    // Cursor's installer (install.ps1) puts its launchers here and adds the folder to the user's PATH.
    join(localAppData, "cursor-agent"),
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
 * executable on the login shell's PATH (the process's on Windows, under its PATHEXT names) that
 * runs and speaks the flags we need. One that cannot run (an old copy left on the PATH) yields to a
 * working one further along; with none working, the first one found says why.
 */
export async function discoverCodingCli(
  provider: CodingProvider,
  options: DiscoveryOptions = {},
): Promise<CliInstallation> {
  providerId(provider);
  const generation = discoveryGeneration(provider);
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
  const found = await externalExecutables(candidates, await excludedRealRoots(options), { manual, platform });
  if (!found.length) {
    if (options.override !== undefined) {
      status.state = CodingCliState.InvalidPath;
      status.path = options.override;
      status.detail = MESSAGE.InvalidPath;
    }
    return { status, env };
  }
  let first: CodingCliStatus | undefined;
  for (const selected of found) {
    const checked: CodingCliStatus = { ...status, path: selected };
    const probeTimeoutsMs = options.probeTimeoutsMs ?? PROBE_TIMEOUTS_MS;
    const context = { dirs, env, signal: options.signal, platform, generation, probeTimeoutsMs };
    await checkSelectedCli(provider, selected, context, checked);
    if (checked.state === CodingCliState.Ready) return { status: checked, env };
    first ??= checked;
  }
  return { status: first ?? status, env };
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
  try {
    const launched = await launchedFile(file, platform);
    if (launched === null) return null;
    const real = await realpath(launched);
    const info = await stat(real, { bigint: true });
    return [provider, real, info.size, info.mtimeNs, info.ino, await packageRelease(real)].join("\0");
  } catch {
    return null;
  }
}

/**
 * The file a launcher runs. A Windows `.cmd` shim stays the same file when the package it starts
 * is updated, so npm's shim stands for its script; another command script names nothing (null).
 */
async function launchedFile(file: string, platform: NodeJS.Platform): Promise<string | null> {
  if (!isCommandScript(file, platform)) return file;
  return npmShimScript(await launcherHead(file), file);
}

/** The npm package a CLI's file belongs to, as `name@version`; empty outside a package. */
async function packageRelease(file: string): Promise<string> {
  if (!IN_NODE_MODULES.test(file)) return "";
  for (let dir = path.dirname(file); path.basename(dir) !== "node_modules"; dir = path.dirname(dir)) {
    const manifest = await readFile(path.join(dir, "package.json"), "utf8").catch(() => null);
    if (manifest !== null) return releaseOf(manifest);
    if (path.dirname(dir) === dir) break;
  }
  return "";
}

/** A package manifest's `name@version`, or the manifest itself when it cannot be read as one. */
function releaseOf(manifest: string): string {
  try {
    const { name, version } = JSON.parse(manifest) as { name?: unknown; version?: unknown };
    return `${String(name)}@${String(version)}`;
  } catch {
    return manifest;
  }
}

/** What checking a selected CLI needs: its search folders, launch environment, stop signal and platform. */
interface CheckContext {
  dirs: string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal | undefined;
  platform: NodeJS.Platform;
  generation: number;
  probeTimeoutsMs: readonly number[];
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

/** The candidates that are executable files outside Studio and every game, in order, each file once. */
async function externalExecutables(
  candidates: string[],
  roots: string[],
  selection: { manual: boolean; platform: NodeJS.Platform },
): Promise<string[]> {
  const found = new Map<string, string>();
  for (const candidate of candidates) {
    const runnable = path.isAbsolute(candidate) && (await executable(candidate, selection.platform));
    if (!runnable) continue;
    const target = await realpath(candidate);
    if (!found.has(target) && !belongsToStudioOrGame(candidate, target, roots, selection.manual))
      found.set(target, candidate);
  }
  return [...found.values()];
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
  const { platform } = context;
  // M6: a version and a help text need no credential; the CLI is asked with none.
  const probeEnv = childEnv(context.env, { base: "contractor", vendor: CLI_VENDOR[provider] });
  const identity = await cliIdentity(provider, file, platform);
  await answersRead;
  const known = identity ? answered.get(identity) : undefined;
  status.version = known?.version ?? (await probe(file, ["--version"], probeEnv, context)).split("\n")[0]?.trim();
  if (!status.version) throw new Error(MESSAGE.NoVersion);
  const required = requiredFlags(provider, status.version);
  const help = known?.help ?? (await probe(file, HELP_ARGS[provider], probeEnv, context));
  const missing = required.filter((flag) => !help.includes(flag));
  if (missing.length) throw new Error(MESSAGE.MissingOptions(missing));
  const keepNewAnswer = identity && !known && context.generation === discoveryGeneration(provider);
  if (keepNewAnswer) {
    answered.set(identity, { version: status.version, help });
    // A discovery ends with its answers on disk, never with a write still landing in the folder.
    await keepAnswers();
  }
}
/**
 * The options a CLI must list: OpenCode's by the command line its version speaks; throws for a
 * version it cannot run, and for a Grok Build older than xAI serves.
 */
function requiredFlags(provider: CodingProvider, version: string): string[] {
  if (provider === EngineId.Grok && grokTooOld(version)) throw new Error(MESSAGE.GrokTooOld);
  if (provider !== EngineId.OpenCode) return REQUIRED_FLAGS[provider];
  const release = openCodeRelease(version);
  if ("problem" in release) throw new Error(openCodeVersionMessage(release.problem, release.major));
  return OPENCODE_FLAGS[release.dialect];
}
/** What to do about an OpenCode version Genex does not run. */
function openCodeVersionMessage(problem: OpenCodeVersionProblem, major: number | null): string {
  if (problem === OpenCodeVersionProblem.TooNew) return MESSAGE.OpenCodeTooNew(major);
  if (problem === OpenCodeVersionProblem.TooOld) return MESSAGE.OpenCodeTooOld;
  return MESSAGE.OpenCodeUnreadable;
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
  const generation = discoveryGeneration(provider);
  const selected = override ?? (await overrides())[provider];
  const key = `${provider}:${override === undefined ? "saved" : "explicit"}:${selected ?? "automatic"}`;
  const cached = diagnostics.get(key);
  const cacheFresh = cached !== undefined && Date.now() - cached.at < DIAGNOSTIC_CACHE_MS;
  const current = generation === discoveryGeneration(provider);
  const useCache = !refresh && cacheFresh && current;
  if (useCache) return copyInstallation(cached.value);
  const shared = !refresh && signal === undefined && current;
  const existing = shared ? diagnosticReads.get(key) : undefined;
  if (existing) return copyInstallation(await existing);
  const owner = Symbol();
  if (current) {
    diagnosticOwners.set(key, owner);
    diagnosticReads.delete(key);
  }
  const read = resolveUncachedCli(provider, override, selected, signal).then((value) => {
    const latest = diagnosticOwners.get(key) === owner && generation === discoveryGeneration(provider);
    if (latest) diagnostics.set(key, { at: Date.now(), value });
    return value;
  });
  if (shared) diagnosticReads.set(key, read);
  try {
    return copyInstallation(await read);
  } finally {
    if (diagnosticReads.get(key) === read) diagnosticReads.delete(key);
    if (diagnosticOwners.get(key) === owner) diagnosticOwners.delete(key);
  }
}

/** Keep cached and shared answers private from consumers that adjust their status or environment. */
function copyInstallation(value: CliInstallation): CliInstallation {
  return { status: { ...value.status }, env: { ...value.env } };
}

/** One uncached discovery, including fallback only for a broken persisted override. */
async function resolveUncachedCli(
  provider: CodingProvider,
  override: string | undefined,
  selected: string | undefined,
  signal: AbortSignal | undefined,
): Promise<CliInstallation> {
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
  return value;
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
