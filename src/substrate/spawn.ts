/**
 * Sandboxed process spawn (no Docker; containment via Anthropic's
 * sandbox-runtime, Seatbelt on macOS).
 *
 * **Every agent-originated process goes through here.** The harness itself is plain Node and can
 * import `fs` and `child_process`; containment holds because it is started through
 * `spawnLongLived` under the Seatbelt profile, and every child it or an agent starts inherits
 * that profile. That keeps the property true even after the agent has rewritten all of its own
 * tools. Host RPC arguments are therefore not pre-contained: a path-taking method validates its
 * own paths.
 *
 * Verified against @anthropic-ai/sandbox-runtime 0.0.73:
 *  - `SandboxManager.initialize(config)` is a **singleton**; per-run policy goes through the
 *    `customConfig` argument of `wrapWithSandboxArgv`.
 *  - `network.deniedDomains` and `filesystem.denyWrite` are **required** by the config schema
 *    (not optional as one might assume) — always fill them.
 *  - `wrapWithSandboxArgv()` returns `{ argv, env }`, which we spawn without a shell.
 *
 * On Windows the backend is srt-win under Git Bash, with session-wide grants and the environment
 * in an env file; `windows-sandbox.ts` holds those rules and the one grant session.
 */
import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { Readable } from "node:stream";
import { MINUTE_MS } from "../shared/duration.ts";
import { errorMessage } from "../shared/errors.ts";
import { StudioPlatform } from "../shared/boot.ts";
import { prepareSandbox } from "./sandbox-prepare.ts";
import {
  SandboxLaunchCode,
  SandboxLaunchError,
  SandboxUnavailableError,
  gitMissingProblem,
  missingLinuxTools,
  sandboxProblem,
  windowsLaunchError,
  windowsSetupProblem,
} from "./sandbox-unavailable.ts";
import { childEnv, windowsBaseEnv } from "./child-env.ts";
import { credentialHomes, sandboxedCliHomes } from "./credential-homes.ts";
import { isInside } from "./paths.ts";
import { envValue } from "./toolchain.ts";
import {
  SRT_WIN_EXEC_FAILED_EXIT,
  type WindowsGrants,
  type WindowsSandboxSession,
  findGitBash,
  gitRootOf,
  grantableToolDirs,
  insideWindowsPath,
  keepWindowsDenies,
  longPath,
  mixedPath,
  renderEnvFile,
  srtWinExecFailure,
  srtWinPath,
  windowsDenyRead,
  windowsRunEnv,
  windowsSessionFor,
  writeCurlHome,
  writeDeniesBeyondRead,
} from "./windows-sandbox.ts";

// Linux launches this native helper through a shell, which cannot traverse Electron's asar.
// The runtime's automatic lookup returns its virtual archive path even when the file is unpacked.
const sandboxPackage =
  process.platform === "linux"
    ? path.dirname(createRequire(import.meta.url).resolve("@anthropic-ai/sandbox-runtime/package.json"))
    : "";
const packagedSeccomp = sandboxPackage.includes(`app.asar${path.sep}`)
  ? path.join(
      sandboxPackage.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`),
      "vendor",
      "seccomp",
      process.arch,
      "apply-seccomp",
    )
  : undefined;

export interface SandboxPolicy {
  /** Domains reachable through srt's filtering proxy. Empty = no outbound network. */
  allowedDomains: string[];
  /** localhost binding/connecting (Ollama, the game bundle server). */
  allowLocalBinding: boolean;
  allowWrite: string[];
  allowRead: string[];
  denyRead: string[];
  denyWrite: string[];
}

export interface RunRequest {
  /** Shell command line. Executed inside the sandbox, without an outer shell of ours. */
  command: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
  /** Per-run policy overlay (e.g. opening `registry.npmjs.org` for one install). */
  policy?: Partial<SandboxPolicy>;
  /** Correlation label used for sandbox-violation attribution and logging. */
  label?: string;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  sandboxed: boolean;
  command: string;
  cwd: string;
}

export interface SandboxOptions {
  /** Writable roots: the harness workspace and the games root. */
  writableRoots: string[];
  /**
   * Dedicated scratch directory. It becomes `TMPDIR` for every spawned process, so tools that
   * need temp files keep working **without** opening the shared system temp dir — which is a
   * cross-application area, not the agent's business.
   */
  scratchDir: string;
  /** Never readable by agent processes (safeStorage blobs, engine credential homes). */
  secretPaths: string[];
  /**
   * Readable but never writable by agent processes, on top of the secret paths — the frozen
   * judge rubrics live here (R4: the critic's yardstick is not the agent's to bend).
   */
  denyWrite?: string[];
  /**
   * The sign-in home of the one CLI that runs inside this sandbox (OpenCode keeps its sign-ins and
   * sessions there). Only such a home exactly (`sandboxedCliHomes`) is exempted: it is left out of
   * the credential denies and made writable for this sandbox alone, while every other sandbox still
   * denies it and a secret path or another CLI's home named here stays denied.
   */
  ownHome?: readonly string[];
  /** Set false only in unit tests that assert the fallback path. */
  enabled?: boolean;
  /** Extra always-readable roots (vendored toolchain, app resources). */
  readableRoots?: string[];
  /**
   * PATH for every process started here. A Finder-launched app inherits launchd's PATH, which
   * has no Homebrew, nvm, Volta or Bun in it — so `npm run build` exited 127 and no build the
   * studio ran could ever have worked (substrate/toolchain.ts). Resolved lazily and once.
   */
  toolPath?: () => Promise<string>;
  /** Test seam: a fake of sandbox-runtime's process-wide `SandboxManager`. */
  runtime?: SandboxRuntime;
  /** Test seam: the platform whose sandbox backend this instance drives (default: this one). */
  platform?: NodeJS.Platform;
  /** Test seams for the Windows backend; production finds each of these itself. */
  windows?: WindowsSeams;
}

/** What a test may hand the Windows backend instead of letting it look for itself. */
export interface WindowsSeams {
  /** Git Bash's `bash.exe` (default: {@link findGitBash}). */
  bash?: string | null;
  /** The grant session (default: the process's one session for the runtime). */
  session?: WindowsSandboxSession;
  /** The real user's profile folder (default: the home folder). */
  profile?: string;
}

/** The part of sandbox-runtime's `SandboxManager` this file drives. */
export type SandboxRuntime = Pick<
  typeof import("@anthropic-ai/sandbox-runtime").SandboxManager,
  | "isSupportedPlatform"
  | "checkDependencies"
  | "initialize"
  | "reset"
  | "updateConfig"
  | "wrapWithSandboxArgv"
  | "annotateStderrWithSandboxFailures"
>;

/** What an initialized Windows backend keeps for its launches. */
interface WindowsBackend {
  session: WindowsSandboxSession;
  bash: string;
  /** Read grants beyond the policy's: the Electron install, toolchain folders, a per-user Git. */
  read: string[];
  /** The folder holding the curl config every run points `CURL_HOME` at. */
  curlHome: string;
  /** The real user's profile, where a missing deny path outside every grant is unreadable anyway. */
  profile: string;
}

/** How much of each of a run's stdout and stderr is kept, in characters. */
const DEFAULT_MAX_OUTPUT_CHARS = 256 * 1024;
/** How long a run may take before its process tree is killed. */
const DEFAULT_TIMEOUT_MS = 10 * MINUTE_MS;
/** The shell srt runs a wrapped command under on macOS. */
const SANDBOX_SHELL = "/bin/bash";
/** The shell a command runs under when the sandbox is off (tests of the fallback path only). */
const UNSANDBOXED_SHELL = "/bin/sh";

/** The enabled macOS and Linux sandboxes sharing one sandbox-runtime, and its reset in flight. */
interface RuntimeHold {
  holders: Set<ProcessSandbox>;
  released: Promise<void>;
}

/**
 * sandbox-runtime is one per process and holds the process open until it is reset: its proxy
 * servers, and on Linux its socat bridge processes. The last sandbox out resets it, as Windows'
 * grant session does for its members.
 */
const runtimeHolds = new WeakMap<SandboxRuntime, RuntimeHold>();

function runtimeHold(runtime: SandboxRuntime): RuntimeHold {
  let hold = runtimeHolds.get(runtime);
  if (!hold) {
    hold = { holders: new Set(), released: Promise.resolve() };
    runtimeHolds.set(runtime, hold);
  }
  return hold;
}

const MESSAGE = {
  NotInitialized: "sandbox-runtime is not initialized",
  EmptyArgv: "sandbox-runtime returned an empty command",
} as const;

/**
 * Refuse, with the typed setup problem, a platform or machine the sandbox cannot run on: the
 * window then offers the fix instead of the app quitting. Missing Linux tools are looked up on
 * PATH only after sandbox-runtime's own check fails. On Windows the dependency check runs srt-win
 * probes of its own, so it is skipped: `initialize` reports a missing setup with a typed code.
 */
function assertSandboxReady(
  runtime: Pick<SandboxRuntime, "isSupportedPlatform" | "checkDependencies">,
  platform: NodeJS.Platform = process.platform,
): void {
  const supported = runtime.isSupportedPlatform();
  const checked = supported && platform !== StudioPlatform.Windows;
  const dependencyErrors = checked ? runtime.checkDependencies().errors : [];
  const missingTools = platform === StudioPlatform.Linux && dependencyErrors.length ? missingLinuxTools() : [];
  const problem = sandboxProblem({ platform, supported, dependencyErrors, missingTools });
  if (problem) throw new SandboxUnavailableError(problem);
}

/** A Windows `initialize` error as the setup problem the window shows, when it is one. */
function asSetupProblem(error: unknown): unknown {
  const setup = windowsSetupProblem(error, [errorMessage(error)]);
  return setup ? new SandboxUnavailableError(setup) : error;
}

/** What a launch needs from a run or a long-lived start. */
type LaunchRequest = Pick<RunRequest, "command" | "cwd" | "env" | "label" | "policy" | "stdin">;

/** How one process starts: the program, its arguments, its environment, and whether srt wraps it. */
interface LaunchPlan {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  sandboxed: boolean;
  /** The working folder to spawn in (Windows: without 8.3 short names). */
  cwd: string;
  /** Windows: gives the grant session back and removes the env file once the process is gone. */
  release?: () => void;
}

/** Collect a child's stdout and stderr as text, each clipped at `maxChars`. */
function captureOutput(
  child: { stdout: Readable; stderr: Readable },
  maxChars: number,
): { stdout: string; stderr: string; truncated: boolean } {
  const output = { stdout: "", stderr: "", truncated: false };
  const clip = (buf: Buffer, current: string): string => {
    if (current.length >= maxChars) {
      output.truncated = true;
      return current;
    }
    const next = current + buf.toString("utf8");
    if (next.length > maxChars) {
      output.truncated = true;
      return next.slice(0, maxChars);
    }
    return next;
  };
  child.stdout.on("data", (buf: Buffer) => {
    output.stdout = clip(buf, output.stdout);
  });
  child.stderr.on("data", (buf: Buffer) => {
    output.stderr = clip(buf, output.stderr);
  });
  return output;
}

/**
 * Linux desktop secret stores under the home folder: GNOME Keyring, GnuPG, KWallet and the NSS
 * certificate database. sandbox-runtime skips an absent deny path, so listing them all is safe.
 */
const LINUX_SECRET_STORES = [
  [".local", "share", "keyrings"],
  [".gnupg"],
  [".local", "share", "kwalletd"],
  [".config", "kwalletrc"],
  [".pki"],
] as const;

/**
 * Paths that must never be readable by an agent process on `platform`, on top of the caller's
 * list. Windows has its own list ({@link windowsDenyRead}): srt-win creates a placeholder for a
 * missing deny path, so the macOS folders must not be sent there.
 */
export function baseDenyRead(
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string[] {
  if (platform === StudioPlatform.Windows) return [...windowsDenyRead(home, env), ...credentialHomes()];
  const linuxStores =
    platform === StudioPlatform.Linux ? LINUX_SECRET_STORES.map((parts) => path.join(home, ...parts)) : [];
  return [
    path.join(home, ".ssh"),
    path.join(home, "Library", "Keychains"),
    path.join(home, ".aws"),
    path.join(home, ".config", "gh"),
    path.join(home, ".netrc"),
    ...linuxStores,
    // SEC-3: the coding CLIs' sign-in homes, wherever the environment has moved them.
    ...credentialHomes(),
  ];
}

/** `.claude` in any case, as a sandbox glob: macOS's file system does not tell the cases apart. */
const CLAUDE_FOLDER_GLOB = "[.][cC][lL][aA][uU][dD][eE]";
/** What {@link literalGlob} rewrites character by character. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rewrites
const GLOB_OR_CONTROL = /[*?[\x00-\x1f]/g;

/**
 * `dir` as the literal start of a macOS sandbox glob. sandbox-runtime reads any path holding `*`,
 * `?`, `[` or `]` as a glob and has no escape (`globToRegex` doubles a backslash), so `[` becomes
 * the class `[[]`, a lone `]` is already literal, and `[_]` breaks `globToRegex`'s own
 * `__GLOBSTAR` placeholders. `*`, `?` and an ASCII control character (which the profile's JSON
 * string escapes into a form Seatbelt does not read back) become `?`: any one byte other than
 * `/`, which only widens a deny.
 */
function literalGlob(dir: string): string {
  const escaped = dir.replace(GLOB_OR_CONTROL, (character) => (character === "[" ? "[[]" : "?"));
  return escaped.replaceAll("__GLOBSTAR", "[_]_GLOBSTAR");
}

/**
 * Claude Code's `.claude` folder in every game, as write denies for the harness and its commands:
 * a session started in a game loads its settings and hooks from there, so no agent process may
 * plant them. On macOS a glob per folder (every game under the games root, made later too, and
 * each game kept elsewhere) in any case, existing or not, with the folder's own path escaped
 * ({@link literalGlob}). sandbox-runtime expands a glob, and srt-win makes a placeholder for a
 * missing path, so on Windows (and Linux) only the folders that exist now are named; there the
 * host's own refusals (`game.write`, landing, promotion) stand alone for a folder not made yet.
 */
export function claudeFolderDenyWrites(
  gamesRoot: string,
  gameDirs: readonly string[],
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string[] {
  if (platform !== StudioPlatform.Mac) {
    const folders = [...new Set(gameDirs.map((dir) => path.join(path.resolve(dir), ".claude")))];
    return folders.filter((folder) => exists(folder));
  }
  const root = path.resolve(gamesRoot);
  const others = gameDirs.map((dir) => path.resolve(dir)).filter((dir) => path.dirname(dir) !== root);
  const games = [path.join(literalGlob(root), "*"), ...others.map(literalGlob)];
  return [...new Set(games.map((game) => path.join(game, CLAUDE_FOLDER_GLOB)))];
}

/**
 * The named homes a sandbox may exempt: exactly the sign-in home of a CLI that runs inside the
 * studio's sandbox, never a secret path, another CLI's home, a parent folder or a relative path.
 */
function ownCredentialHomes(named: readonly string[], secretPaths: readonly string[]): string[] {
  const homes = sandboxedCliHomes();
  return named
    .filter((dir) => path.isAbsolute(dir))
    .map((dir) => path.resolve(dir))
    .filter((dir) => homes.includes(dir) && !secretPaths.includes(dir));
}

export class ProcessSandbox {
  readonly policy: SandboxPolicy;
  readonly enabled: boolean;
  readonly scratchDir: string;
  #manager: SandboxRuntime | null = null;
  #runtime: SandboxRuntime | null = null;
  /** Domains opened by runs in flight, with how many runs hold each open (PH-3). */
  #opened = new Map<string, number>();
  #initialized = false;
  #initError: Error | null = null;
  #toolPath: (() => Promise<string>) | null = null;
  #resolvedToolPath: Promise<string> | null = null;
  readonly #platform: NodeJS.Platform;
  #seams: WindowsSeams = {};
  #windows: WindowsBackend | null = null;

  private constructor(policy: SandboxPolicy, enabled: boolean, scratchDir: string, platform: NodeJS.Platform) {
    this.policy = policy;
    this.enabled = enabled;
    this.scratchDir = scratchDir;
    this.#platform = platform;
  }

  static async create(options: SandboxOptions): Promise<ProcessSandbox> {
    const platform = options.platform ?? process.platform;
    await mkdir(options.scratchDir, { recursive: true });
    // Windows: the long path, since srt-win and Git Credential Manager trip over 8.3 short names.
    const scratchDir = longPath(options.scratchDir, platform);
    const own = ownCredentialHomes(options.ownHome ?? [], options.secretPaths);
    const notOwn = (dir: string) => !own.includes(dir);
    const policy: SandboxPolicy = {
      allowedDomains: [],
      allowLocalBinding: true,
      allowWrite: [...options.writableRoots, scratchDir, ...own],
      allowRead: options.readableRoots ?? [],
      denyRead: [...baseDenyRead(os.homedir(), platform).filter(notOwn), ...options.secretPaths],
      denyWrite: [...credentialHomes().filter(notOwn), ...options.secretPaths, ...(options.denyWrite ?? [])],
    };
    const sandbox = new ProcessSandbox(policy, options.enabled ?? true, scratchDir, platform);
    sandbox.#toolPath = options.toolPath ?? null;
    sandbox.#runtime = options.runtime ?? null;
    sandbox.#seams = options.windows ?? {};
    if (sandbox.enabled) await sandbox.#initialize();
    return sandbox;
  }

  /**
   * PATH for the processes this sandbox starts, resolved on first use and remembered. A caller
   * that passes its own `env.PATH` still wins — this is the floor, not a policy.
   */
  async toolPath(): Promise<string | null> {
    if (!this.#toolPath) return null;
    this.#resolvedToolPath ??= this.#toolPath().catch(() => process.env.PATH ?? "");
    return this.#resolvedToolPath;
  }

  get initError(): Error | null {
    return this.#initError;
  }

  /**
   * Open another folder the agent may write. Idempotent, and a no-op when `dir` already sits
   * inside a writable root (the default library covers `~/AI Games/...`).
   */
  allowWrite(dir: string): void {
    const resolved = path.resolve(dir);
    const already = this.policy.allowWrite.some((root) => isInside(root, resolved));
    if (already) return;
    this.policy.allowWrite.push(resolved);
    // Windows: grants change only between commands, so the session queues a regrant instead.
    if (this.#windows) this.#windows.session.update(this, this.#windowsGrants(this.#windows));
    else this.#pushConfig();
  }

  /**
   * Deny writing more paths from the next process on (a game's `.claude` folder, once the game is
   * adopted). A process already running keeps the policy it started with.
   */
  denyWrite(paths: readonly string[]): void {
    const added = paths.filter((p) => !this.policy.denyWrite.includes(p));
    if (!added.length) return;
    this.policy.denyWrite.push(...added);
    if (this.#windows) this.#windows.session.update(this, this.#windowsGrants(this.#windows));
    else this.#pushConfig();
  }

  /**
   * This instance is done: on Windows it leaves the shared grant session, which takes back the
   * folders only it needed. On macOS and Linux the last sandbox out resets sandbox-runtime; its
   * proxies, and on Linux its socat bridges, would otherwise outlive every sandbox and keep the
   * process alive. Safe to call twice.
   */
  async dispose(): Promise<void> {
    if (this.#windows) {
      this.#windows.session.leave(this);
      return;
    }
    const runtime = this.#manager;
    const hold = runtime ? runtimeHolds.get(runtime) : undefined;
    if (!runtime || !hold?.holders.delete(this) || hold.holders.size > 0) return;
    // A sandbox created meanwhile joins before it waits for this, and so keeps the runtime.
    hold.released = hold.released.then(async () => {
      if (hold.holders.size === 0) await runtime.reset().catch(() => {});
    });
    await hold.released;
  }

  async #initialize(): Promise<void> {
    if (this.#initialized) return;
    try {
      const SandboxManager = this.#runtime ?? (await import("@anthropic-ai/sandbox-runtime")).SandboxManager;
      assertSandboxReady(SandboxManager, this.#platform);
      if (this.#platform === StudioPlatform.Windows) await this.#initializeWindows(SandboxManager);
      else await this.#initializeRuntime(SandboxManager);
      this.#manager = SandboxManager;
      this.#initialized = true;
    } catch (err) {
      this.#initError = err as Error;
      throw err;
    }
  }

  async #initializeRuntime(SandboxManager: SandboxRuntime): Promise<void> {
    const hold = runtimeHold(SandboxManager);
    // Join first, then let a reset the last sandbox out already started finish.
    hold.holders.add(this);
    await hold.released;
    const config = this.toRuntimeConfig(this.policy);
    await SandboxManager.initialize(config).catch((error: unknown) => {
      hold.holders.delete(this);
      throw asSetupProblem(error);
    });
    // `SandboxManager` is a process-wide singleton: a second instance's `initialize` does not
    // necessarily replace the first one's policy. Push the config explicitly, and — more
    // importantly — pass this instance's policy as a per-spawn overlay (see `#overlay`), so an
    // instance is always authoritative for the processes it starts.
    SandboxManager.updateConfig?.(config);
  }

  /**
   * Windows: find Git Bash, create the write roots (srt-win silently drops a grant on a missing
   * folder), work out the read grants and join the process's grant session, which initializes
   * sandbox-runtime on the first join.
   */
  async #initializeWindows(runtime: SandboxRuntime): Promise<void> {
    const bash = this.#seams.bash === undefined ? await findGitBash() : this.#seams.bash;
    if (!bash) throw new SandboxUnavailableError(gitMissingProblem());
    const profile = longPath(this.#seams.profile ?? os.homedir(), this.#platform);
    await Promise.all(this.policy.allowWrite.map((dir) => mkdir(dir, { recursive: true })));
    const toolDirs = [(await this.toolPath()) ?? "", process.env.PATH ?? ""].flatMap((value) => value.split(";"));
    const gitRoot = gitRootOf(bash);
    const read = [
      path.dirname(longPath(process.execPath, this.#platform)),
      ...grantableToolDirs(toolDirs, profile, this.policy.denyRead),
      ...(insideWindowsPath(profile, gitRoot) ? [gitRoot] : []),
    ];
    const session = this.#seams.session ?? windowsSessionFor(runtime, { profile, srtWin: srtWinPath() });
    const backend = { session, bash, read, profile, curlHome: await writeCurlHome(this.scratchDir) };
    await session
      .join(this, { grants: this.#windowsGrants(backend), config: this.#windowsSessionConfig() })
      .catch((error: unknown) => {
        throw asSetupProblem(error);
      });
    this.#windows = backend;
  }

  /**
   * What this instance needs the sandbox user to write and read, as long paths: a root spelled
   * with an 8.3 name (`RUNNER~1`) would not look like it sits in the profile, and the folders
   * above it would get no read-attributes grant.
   */
  #windowsGrants(backend: Pick<WindowsBackend, "read">): WindowsGrants {
    return this.#longGrants({
      write: this.policy.allowWrite,
      read: [...this.policy.allowRead, ...backend.read],
    });
  }

  #longGrants(grants: WindowsGrants): WindowsGrants {
    const long = (dir: string) => longPath(dir, this.#platform);
    return { write: grants.write.map(long), read: grants.read.map(long) };
  }

  /**
   * This instance's share of the session config: its network (with every domain a run in flight
   * opened) and its deny paths. The session applies every instance's denies to all of them: srt-win
   * stamps a deny for the sandbox user, so a per-command one binds every running command anyway.
   */
  #windowsSessionConfig(): import("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfig {
    const config = this.toRuntimeConfig({
      ...this.policy,
      allowedDomains: [...this.policy.allowedDomains, ...this.#opened.keys()],
    });
    return { ...config, windows: { srtWin: { path: srtWinPath() } } };
  }

  toRuntimeConfig(policy: SandboxPolicy): import("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfig {
    return {
      ...(packagedSeccomp ? { seccomp: { applyPath: packagedSeccomp } } : {}),
      network: {
        allowedDomains: policy.allowedDomains,
        deniedDomains: [],
        allowLocalBinding: policy.allowLocalBinding,
      },
      filesystem: {
        allowWrite: policy.allowWrite,
        denyWrite: policy.denyWrite,
        allowRead: policy.allowRead,
        denyRead: policy.denyRead,
      },
    } as import("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfig;
  }

  /**
   * Start a long-lived process inside the sandbox and hand back the child for stdio wiring.
   * This is how the harness runtime itself is launched: the agent's own code gets exactly the
   * same containment as any tool it spawns.
   */
  async spawnLongLived(request: {
    command: string;
    cwd: string;
    env?: Record<string, string>;
    label?: string;
    policy?: Partial<SandboxPolicy>;
  }): Promise<{ child: ChildProcess; sandboxed: boolean }> {
    // Held open until the process is gone, as `run` holds it for the length of a run.
    const close = await this.#openDomains(request.policy);
    try {
      const plan = await this.#launchPlan(request);
      const done = () => {
        plan.release?.();
        close();
      };
      const child = this.#start(plan);
      child.once("close", done);
      child.once("error", done);
      return { child, sandboxed: plan.sandboxed };
    } catch (err) {
      close();
      throw err;
    }
  }

  /**
   * Start a planned process. On POSIX it gets its own process group so a runaway tree can be
   * killed wholesale (no cgroups without Docker, per D7's accepted losses — the watchdog kills, it
   * does not throttle). On Windows srt-win's job object holds the tree, and a detached child
   * would open a console window.
   */
  #spawn(plan: LaunchPlan): ChildProcessWithoutNullStreams {
    return spawn(plan.file, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: this.#platform !== StudioPlatform.Windows,
      windowsHide: true,
    });
  }

  /**
   * Spawn `plan`; when `spawn` itself throws (no child ever existed, so no close or error event
   * will), hand the plan's hold on the grant session and its files back first.
   */
  #start(plan: LaunchPlan): ChildProcessWithoutNullStreams {
    try {
      return this.#spawn(plan);
    } catch (error) {
      plan.release?.();
      throw error;
    }
  }

  /**
   * How to start `request`: wrapped by srt under this instance's policy when the sandbox is on,
   * else a plain `/bin/sh -c`. Either way the child gets the allow-listed environment.
   */
  async #launchPlan(request: LaunchRequest, signal?: AbortSignal): Promise<LaunchPlan> {
    if (!this.enabled) return this.#unsandboxedPlan(request);
    if (!this.#initialized) await this.#initialize();
    const manager = this.#manager;
    if (!manager) throw new Error(MESSAGE.NotInitialized);
    if (this.#windows) return this.#windowsLaunchPlan(manager, this.#windows, request, signal);
    const wrapped = await prepareSandbox(
      () =>
        manager.wrapWithSandboxArgv(
          this.#withScratchTmp(request.command),
          process.platform === "darwin" ? SANDBOX_SHELL : undefined,
          this.#overlay(request.policy ?? {}),
          signal,
          request.cwd,
          { commandId: request.label ?? request.command, commandText: request.command },
        ),
      { signal },
    );
    const [file, ...args] = wrapped.argv;
    if (!file) throw new Error(MESSAGE.EmptyArgv);
    return { file, args, env: await this.#env(wrapped.env, request.env), sandboxed: true, cwd: request.cwd };
  }

  /**
   * The sandbox off (tests only): a plain `/bin/sh -c`, or Git Bash on Windows with the basics a
   * Windows program needs to start and the env file's `MSYS_NO_PATHCONV=1`.
   */
  async #unsandboxedPlan(request: LaunchRequest): Promise<LaunchPlan> {
    const own = await this.#env(process.env, request.env);
    const plan = { args: ["-c", request.command], sandboxed: false, cwd: request.cwd };
    if (this.#platform !== StudioPlatform.Windows) return { ...plan, file: UNSANDBOXED_SHELL, env: own };
    const bash = this.#seams.bash === undefined ? await findGitBash() : this.#seams.bash;
    if (!bash) throw new SandboxUnavailableError(gitMissingProblem());
    const pathValue = own.PATH ?? envValue(process.env, "PATH") ?? "";
    const env = { ...windowsBaseEnv(process.env, this.#platform), ...own, PATH: pathValue, MSYS_NO_PATHCONV: "1" };
    return { ...plan, file: bash, env };
  }

  /**
   * Windows: hold the grant session for the life of the process, refuse a per-run write or read
   * the session does not grant, hand the environment over in an env file the command sources and
   * deletes first, and run it under Git Bash.
   */
  async #windowsLaunchPlan(
    manager: SandboxRuntime,
    backend: WindowsBackend,
    request: LaunchRequest,
    signal?: AbortSignal,
  ): Promise<LaunchPlan> {
    const patch = request.policy ?? {};
    const needed = this.#longGrants({ write: patch.allowWrite ?? [], read: patch.allowRead ?? [] });
    const release = await backend.session.acquire(signal);
    const files: string[] = [];
    const removeFiles = () => Promise.all(files.map((file) => rm(file, { force: true })));
    try {
      if (!backend.session.covers(needed))
        throw new SandboxLaunchError(SandboxLaunchCode.NotGranted, [...needed.write, ...needed.read].join(", "));
      const cwd = longPath(request.cwd, this.#platform);
      const command = `${await this.#runPrelude(backend, request, files)} ${request.command}`;
      const wrapped = await manager
        .wrapWithSandboxArgv(command, backend.bash, this.#windowsOverlay(backend, patch), signal, cwd, {
          commandId: request.label ?? request.command,
          commandText: request.command,
        })
        .catch((error: unknown) => {
          throw windowsLaunchError(error) ?? error;
        });
      const [file, ...args] = wrapped.argv;
      if (!file) throw new Error(MESSAGE.EmptyArgv);
      const done = () => {
        release();
        void removeFiles();
      };
      return { file, args, env: wrapped.env, sandboxed: true, cwd, release: done };
    } catch (err) {
      release();
      await removeFiles();
      throw err;
    }
  }

  /**
   * What a Windows command runs first: source its env file, and read a run's stdin from a file
   * (srt-win does not pass stdin through). Each file is deleted as soon as it is open or read;
   * `files` collects them for the host to remove too.
   */
  async #runPrelude(backend: WindowsBackend, request: LaunchRequest, files: string[]): Promise<string> {
    const envFile = await this.#writeEnvFile(backend, request.env);
    files.push(envFile);
    const env = shellQuote(mixedPath(envFile));
    const steps = [`. ${env}; rm -f ${env};`];
    if (request.stdin !== undefined) {
      const stdinFile = path.join(this.scratchDir, `.stdin-${randomUUID()}`);
      files.push(stdinFile);
      await writeFile(stdinFile, request.stdin, { mode: 0o600 });
      const input = shellQuote(mixedPath(stdinFile));
      steps.push(`exec 0< ${input}; rm -f ${input};`);
    }
    return steps.join(" ");
  }

  /** Write one run's env file into the scratch folder; readable by its owner only. */
  async #writeEnvFile(backend: WindowsBackend, own: Record<string, string> | undefined): Promise<string> {
    const env = await this.#env(process.env, own);
    const vars = windowsRunEnv({ env, own: own ?? {}, scratch: this.scratchDir, curlHome: backend.curlHome });
    const file = path.join(this.scratchDir, `.env-${randomUUID()}.sh`);
    await writeFile(file, renderEnvFile({ vars, toolPath: env.PATH ?? "" }), { mode: 0o600 });
    return file;
  }

  /**
   * A Windows run's own config: its network and the run's own denies (the instance's are the
   * session's). Grants are the session's too (srt-win refuses a per-command grant), and a deny
   * path that does not exist is dropped where it is unreadable anyway (in the profile, outside
   * every grant), so srt-win never creates a placeholder there.
   */
  #windowsOverlay(
    backend: WindowsBackend,
    patch: Partial<SandboxPolicy>,
  ): import("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfig {
    const applied = backend.session.applied ?? { write: [], read: [] };
    const scope = { roots: [...applied.write, ...applied.read], profile: backend.profile };
    const denyRead = keepWindowsDenies(patch.denyRead ?? [], scope);
    const config = this.toRuntimeConfig({
      ...this.policy,
      allowedDomains: [...this.policy.allowedDomains, ...(patch.allowedDomains ?? [])],
      allowWrite: [],
      allowRead: [],
      denyRead,
      denyWrite: writeDeniesBeyondRead(keepWindowsDenies(patch.denyWrite ?? [], scope), denyRead),
    });
    return config;
  }

  /** Run a command to completion inside the sandbox. */
  async run(request: RunRequest): Promise<RunResult> {
    const close = await this.#openDomains(request.policy);
    try {
      return await this.#runInside(request);
    } finally {
      close();
    }
  }

  /**
   * PH-3: open a run's extra domains at the filtering proxy for as long as the run lasts. The
   * proxy judges every request against sandbox-runtime's process-wide config, never the per-spawn
   * overlay, so the overlay alone never opened anything. Openings are counted, so overlapping
   * runs never close one another's, and every change pushes the whole effective config.
   *
   * Process-wide also means any other sandboxed process running meanwhile can reach the domain.
   * The one caller is the package install the user pressed a button for, against the npm
   * registry; that exposure is accepted (see "Residual risks" in docs/agent/architecture.md).
   */
  async #openDomains(policy: Partial<SandboxPolicy> | undefined): Promise<() => void> {
    const extra = [...new Set(policy?.allowedDomains ?? [])].filter(
      (domain) => !this.policy.allowedDomains.includes(domain),
    );
    if (!this.enabled || !extra.length) return () => {};
    if (!this.#initialized) await this.#initialize();
    for (const domain of extra) this.#opened.set(domain, (this.#opened.get(domain) ?? 0) + 1);
    this.#pushConfig();
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      for (const domain of extra) {
        const left = (this.#opened.get(domain) ?? 1) - 1;
        if (left > 0) this.#opened.set(domain, left);
        else this.#opened.delete(domain);
      }
      this.#pushConfig();
    };
  }

  /** This instance's policy, plus every domain a run in flight has opened, into the runtime. */
  #pushConfig(): void {
    if (this.#windows) {
      this.#windows.session.network(this, this.#windowsSessionConfig());
      return;
    }
    this.#manager?.updateConfig?.(
      this.toRuntimeConfig({ ...this.policy, allowedDomains: [...this.policy.allowedDomains, ...this.#opened.keys()] }),
    );
  }

  async #runInside(request: RunRequest): Promise<RunResult> {
    const started = Date.now();
    const plan = await this.#launchPlan(request, request.signal);

    const child = this.#start(plan);
    return await new Promise<RunResult>((resolve, reject) => {
      const output = captureOutput(child, request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_CHARS);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killChild(child, this.#platform);
      }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      const onAbort = () => killChild(child, this.#platform);
      request.signal?.addEventListener("abort", onAbort, { once: true });
      const settle = () => {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        plan.release?.();
      };

      child.on("error", (err) => {
        settle();
        reject(err);
      });

      child.on("close", (code, signal) => {
        settle();
        const failure = this.#windowsExecFailure(plan, code, output.stderr);
        if (failure) {
          reject(failure);
          return;
        }
        resolve({
          code,
          signal,
          stdout: output.stdout,
          stderr: this.#annotateStderr(request, plan.sandboxed, output.stderr),
          durationMs: Date.now() - started,
          timedOut,
          truncated: output.truncated,
          sandboxed: plan.sandboxed,
          command: request.command,
          cwd: request.cwd,
        });
      });

      if (request.stdin !== undefined) child.stdin.end(request.stdin);
      else child.stdin.end();
    });
  }

  /**
   * Windows: srt-win's own launch failure (exit 16 with its typed error line, such as a working
   * folder on a mapped drive) as a launch error; the command never started. Null otherwise.
   */
  #windowsExecFailure(plan: LaunchPlan, code: number | null, stderr: string): SandboxLaunchError | null {
    const srtFailed = this.#windows !== null && plan.sandboxed && code === SRT_WIN_EXEC_FAILED_EXIT;
    if (!srtFailed) return null;
    const failure = srtWinExecFailure(stderr);
    return failure ? windowsLaunchError(failure) : null;
  }

  /** A sandboxed run's stderr, with srt's note on any sandbox violation it caused. */
  #annotateStderr(request: RunRequest, sandboxed: boolean, stderr: string): string {
    if (!sandboxed || !this.#manager) return stderr;
    return this.#manager.annotateStderrWithSandboxFailures(request.label ?? request.command, stderr);
  }

  /**
   * SEC-2: what a child starts with. The harness and every command it runs are agent-directed,
   * so the studio's own environment (whatever credentials its shell exported) is allow-listed
   * down to the toolchain basics; the child's own variables are the caller's to pass.
   */
  async #env(parent: NodeJS.ProcessEnv, own: Record<string, string> | undefined): Promise<Record<string, string>> {
    return childEnv(parent, {
      base: "sandbox",
      set: { ...this.#tmpEnv(), ...(await this.#pathEnv()), ...(own ?? {}) },
    });
  }

  /** The resolved toolchain PATH, or nothing when this sandbox was given no resolver. */
  async #pathEnv(): Promise<Record<string, string>> {
    const resolved = await this.toolPath();
    return resolved ? { PATH: resolved } : {};
  }

  /** Point every temp-file convention at the agent's own scratch dir. */
  #tmpEnv(): Record<string, string> {
    return { TMPDIR: this.scratchDir, TMP: this.scratchDir, TEMP: this.scratchDir };
  }

  /**
   * srt assigns its own `TMPDIR` (`/tmp/claude`) *inside* the wrapped argv, so an env override
   * cannot win — the assignment has to happen in the command itself. Verified against 0.0.73.
   */
  #withScratchTmp(command: string): string {
    const dir = shellQuote(this.scratchDir);
    return `export TMPDIR=${dir} TMP=${dir} TEMP=${dir}; ${command}`;
  }

  #overlay(patch: Partial<SandboxPolicy>): import("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfig {
    return this.toRuntimeConfig({
      ...this.policy,
      ...patch,
      allowedDomains: [...this.policy.allowedDomains, ...(patch.allowedDomains ?? [])],
      allowWrite: [...this.policy.allowWrite, ...(patch.allowWrite ?? [])],
      allowRead: [...this.policy.allowRead, ...(patch.allowRead ?? [])],
      // Deny lists are never weakened by a per-run overlay.
      denyRead: [...this.policy.denyRead, ...(patch.denyRead ?? [])],
      denyWrite: [...this.policy.denyWrite, ...(patch.denyWrite ?? [])],
    });
  }
}

/** Single-quote a value for POSIX shells. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * End a sandboxed child and everything it started. On Windows killing the srt-win broker ends
 * the job object that holds the whole tree (verified in the W0 spike); elsewhere the child leads
 * its own process group.
 */
export function killChild(child: Pick<ChildProcess, "pid" | "kill">, platform: string = process.platform): void {
  if (platform !== StudioPlatform.Windows) {
    killTree(child.pid);
    return;
  }
  try {
    child.kill();
  } catch {
    /* already gone */
  }
}

/** SIGKILL a process group (POSIX), falling back to the process itself. */
export function killTree(pid: number | undefined, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}
