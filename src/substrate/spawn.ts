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
import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  execFileSync,
  type SpawnOptions,
  spawn,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Duplex, type Readable, Writable } from "node:stream";
import { MINUTE_MS } from "../shared/duration.ts";
import { errorMessage } from "../shared/errors.ts";
import { type SandboxProblem, StudioPlatform } from "../shared/boot.ts";
import { ownBubblewrap } from "./linux-bubblewrap.ts";
import { BuildTarget, type CompiledStack } from "../shared/game-project.ts";
import {
  GameBoxProblem,
  NATIVE_CROSS_EXECUTABLES,
  NATIVE_GAME_MEMORY_MAX_BYTES,
  NativeError,
  NativeRefusal,
  NativeRunMode,
} from "../shared/native-contract.ts";
import { prepareGameLaunch } from "./game-sandbox-profile.ts";
import { LEAVE_GROUP_SYSCALLS } from "./seatbelt.ts";
import { type ReadSystemFile, usernsRestricted } from "./linux-apparmor.ts";
import { prepareSandbox } from "./sandbox-prepare.ts";
import {
  SandboxLaunchCode,
  SandboxLaunchError,
  SandboxUnavailableError,
  gitMissingProblem,
  type UsernsSeams,
  missingLinuxTools,
  readSystemFile,
  sandboxProblem,
  usernsCheck,
  windowsLaunchError,
  windowsProxyPortsError,
  windowsSetupProblem,
} from "./sandbox-unavailable.ts";
import { shellQuote } from "./shell-quote.ts";
import { childEnv, windowsBaseEnv } from "./child-env.ts";
import {
  credentialHomes,
  deviceToolDirs,
  HOME_SIGN_IN_STORES,
  mobileCredentialHomes,
  openCodeServicePassword,
  packagedDeviceTools,
  ROBLOX_ASSISTANT_SETTINGS,
  sandboxedCliHomes,
  withoutDeviceTools,
} from "./credential-homes.ts";
import { writeNewFile } from "./fsx.ts";
import {
  LINUX_BOX_SYSTEM,
  LinuxBoxAudio,
  type LinuxBoxSystem,
  type LinuxRunFolders,
  launchLinuxGameBox,
  linuxBoxError,
  linuxGameBoxProblem,
  linuxRunFolders,
} from "./linux-game-box.ts";
import { RunDirLayout } from "./native-bundle.ts";
import { LinuxRuntimeFile } from "./native-runtime-files.ts";
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
  type WindowsSetupGap,
  windowsDenyRead,
  windowsRunEnv,
  windowsSessionFor,
  windowsSetupGaps,
  writeCurlHome,
  writeDeniesBeyondRead,
} from "./windows-sandbox.ts";
import {
  type LauncherFileStat,
  type WindowsStartDeps,
  launcherDesktopFor,
  launcherGameExit,
  launcherMayLeaveProfile,
  launchRefusalError,
  planProfileCleanup,
  SYSTEM_ROOT,
  startWindowsGame,
  windowsGameBoxProblem,
  windowsLaunchDeps,
  WindowsLaunchRefusal,
} from "./windows-game-launch.ts";
import { DenyAccess } from "./windows-folder-ace.ts";
import { type LiveInput, openLiveInput } from "./windows-live-input.ts";

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
  /** Hold this run to its own folders in place of the sandbox's writable roots (macOS and Linux). */
  confine?: RunConfinement;
  /** Correlation label used for sandbox-violation attribution and logging. */
  label?: string;
  maxOutputBytes?: number;
  /** Which end of a stream longer than `maxOutputBytes` is kept; the head unless said. */
  keepOutput?: OutputKept;
  signal?: AbortSignal;
  /**
   * Once the command exits, end whatever it left running in its process group (POSIX): a C++
   * build runs CMake files the agent wrote, and nothing they start may outlive the build and keep
   * writing its folder. On macOS its descendants also cannot call setsid(2) or setpgid(2) to
   * leave the group ({@link keepInGroup}). Agent commands leave it off: a dev server started
   * with `&` is theirs.
   */
  reapGroup?: boolean;
}

/** Which end of a long stdout or stderr a run keeps: a long build log ends with its verdict. */
export const OutputKept = { Head: "head", Tail: "tail" } as const;
/** Which end of a long stream a run keeps. */
export type OutputKept = (typeof OutputKept)[keyof typeof OutputKept];

/**
 * The folders a confined run writes: a game's build or install writes its game and its own scratch,
 * never another game, the games folder or another build's scratch. The sandbox's deny lists still
 * hold, and so do the few folders srt itself keeps writable for every run (its own temp folder,
 * npm's and Claude's logs under `$HOME`). On Windows srt-win grants writes for the whole session,
 * so a confinement there changes nothing: the run writes what every sandboxed process there writes.
 */
export interface RunConfinement {
  /** The only folders the run may write. */
  write: readonly string[];
  /** The run's TMPDIR, a folder of its own; made before the run and writable too. */
  tmp: string;
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
  /**
   * Windows: Genex's data folder. Moved off the profile (Settings → Storage), it is as closed as
   * the profile, so the folders between it and each root it holds get the read-attributes grant.
   */
  dataRoot?: string;
  /** Extra always-readable roots (vendored toolchain, app resources); they win over {@link denyRead}. */
  readableRoots?: string[];
  /**
   * Never readable, on top of the base and secret denies, except under `readableRoots` (a build
   * sandbox denies the user's home and re-allows its own folders). Writes are not affected.
   */
  denyRead?: string[];
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
  /**
   * Windows: `create` checks only what Set up fixes (Git Bash, the sandbox user and its network
   * filter) and starts the rest behind it. srt-win's network check and folder grants took minutes
   * on a fresh PC, and the window waited on them; every launch waits for the start anyway.
   * Elsewhere the sandbox starts in `create` as before.
   */
  startInBackground?: boolean;
  /** Where the sandbox says how long each step of its start took (Windows). */
  log?: (line: string) => void;
  /**
   * Linux: the bubblewrap to run (default: the app's own copy beside its executable when there is
   * one, else the system's on PATH; substrate/linux-bubblewrap.ts says why).
   */
  bubblewrap?: string | null;
  /**
   * Test seams for Ubuntu's user-namespace check; production reads /proc, its own executable and
   * its folders. With a fake `runtime` and no `read`, nothing reads the host's /proc.
   */
  linux?: UsernsSeams;
  /**
   * `layout.nativeRuns`: the only folder a game's run directory may be in. `spawnGame` refuses a
   * `runDir` anywhere else. Absent, no game starts.
   */
  nativeRunsRoot?: string;
  /**
   * Windows: the AppContainer launcher (`<resources>/native/genex-game-launcher.exe`) every game
   * starts through. Absent, or not there, a Windows game is refused `no-game-box` (`launcher-missing`).
   */
  gameLauncher?: string;
  /** Test seams for the Windows and Linux game boxes; production finds each of these itself. */
  gameBoxSeams?: GameBoxSeams;
}

/** What a test may hand the Windows and Linux game boxes instead of letting them look for themselves. */
export interface GameBoxSeams {
  /** Starts the launcher or bubblewrap (default: Node's `spawn`). */
  spawn?: (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** Windows: the launcher file's kind, never following a link; null when there is none (default: `lstatSync`). */
  launcherStat?: (file: string) => LauncherFileStat | null;
  /** Windows: planning's realpath, the run claim and the host environment (default: `windowsLaunchDeps`). */
  windows?: Partial<Omit<WindowsStartDeps<ChildProcess>, "spawn" | "runsRoot">>;
  /** Linux: bubblewrap's absolute path (default: {@link BWRAP}). */
  bwrap?: string;
  /** Linux: `bwrap --version`'s output, or null when it does not run (default: runs it, once). */
  bwrapVersion?: () => string | null;
  /** Linux: the session's environment (default: this process's). */
  session?: Readonly<Record<string, string | undefined>>;
  /**
   * Linux: the per-run Wayland socket the host made through the compositor's
   * `wp_security_context_manager_v1`, or null when the compositor offers none (`wayland-unrestricted`).
   * Absent, this build has no such helper and windowed play is refused `wayland-helper-missing`
   * (today: no build ships one).
   */
  waylandContext?: (runId: string) => Promise<string | null>;
  /** Linux: the render nodes a run is granted (default: `/dev/dri/renderD*`). */
  renderNodes?: () => Promise<string[]>;
  /** Linux: the file system and uid the box planner checks against (default: this process's). */
  linuxSystem?: LinuxBoxSystem;
}

/** What `spawnGame` starts: one assembled, admitted bundle under a host-written game profile. */
export interface GameSpawnRequest {
  runId: string;
  /** `<layout.nativeRuns>/<runId>`: host-only (0700); `profile.sb` is written here (0600). */
  runDir: string;
  /**
   * `<runDir>/bundle/Game.app/Contents/MacOS/game`, realpath'd: the only program the profile lets
   * start. A Windows or Linux run's is `<runDir>/bundle/game.exe` or `<runDir>/bundle/game`.
   */
  exe: string;
  /** `<runDir>/bundle` (read-only to the game). */
  bundle: string;
  /** `<runDir>/state` (the only writable path). */
  state: string;
  mode: NativeRunMode;
  nonce: string;
  /**
   * The frames service the host checked in for this run (`NATIVE_FRAMES_SERVICE_PREFIX` + `runId`):
   * required for an embedded run, which may look up this one name, and refused for any other mode.
   * The game reads it from `GENEX_FRAMES_SERVICE`.
   */
  frames?: string;
  /** The admitted build's stack: how a Linux box draws and whether it has a headless build. Absent: C++ · raylib. */
  stack?: CompiledStack;
}

/** How a started game ended. */
export interface GameExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The game box failed on its own (Windows: the launcher's own failure): the run is refused, not crashed. */
  refused?: NativeError;
}

/**
 * A started game: its own process group; fd 3 is the protocol pipe (stdio[3]); stdin is ignored. On
 * Windows the child is the launcher, which relays fd 3 to the game's pipe and holds the game in a
 * kill-on-close Job Object.
 */
export interface GameChild {
  pid: number;
  /** The protocol pipe, NDJSON both ways. */
  fd3: Duplex;
  stdout: Readable;
  stderr: Readable;
  /** Resolves once the process is reaped. */
  exited: Promise<GameExit>;
  /**
   * Signal the game's process group; nothing once the game has been reaped. Windows: SIGTERM closes
   * fd 3 (the launcher's own Stop ends the job), any other signal ends the launcher, whose job then
   * ends the game; no process group is ever signalled.
   */
  kill(signal: NodeJS.Signals): void;
}

/** A test's fake runtime reads no host /proc: an Ubuntu 24.04 host would otherwise look restricted. */
const NO_SYSTEM_FILES: ReadSystemFile = () => null;

/** What a test may hand the Windows backend instead of letting it look for itself. */
export interface WindowsSeams {
  /** Git Bash's `bash.exe` (default: {@link findGitBash}). */
  bash?: string | null;
  /** The grant session (default: the process's one session for the runtime). */
  session?: WindowsSandboxSession;
  /** The real user's profile folder (default: the home folder). */
  profile?: string;
  /** What of the Windows sandbox is not set up yet (default: {@link windowsSetupGaps}). */
  setupGaps?: () => Promise<WindowsSetupGap[]>;
}

/** The data folder spelled by its long name on Windows, as the grants are; null when none was given. */
function longDataRoot(dataRoot: string | undefined, platform: NodeJS.Platform): string | null {
  return dataRoot ? longPath(dataRoot, platform) : null;
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
> &
  Partial<Pick<typeof import("@anthropic-ai/sandbox-runtime").SandboxManager, "getProxyPort">>;

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
/**
 * Marks srt's outer `bash -c` as a nested shell. A top-level `bash -c` (SHLVL unset) whose stdin
 * is a socket, as node's stdio pipes are, takes itself for an rshd login and reads ~/.bashrc:
 * that shell runs outside the sandbox, so the user's rc file would run before every command and
 * whatever it printed would lead the command's output.
 */
const NESTED_SHELL_ENV = { SHLVL: "1" } as const;
/** The shell a command runs under when the sandbox is off (tests of the fallback path only). */
const UNSANDBOXED_SHELL = "/bin/sh";
/** A write to a child's stdin after it closed its end: the child chose not to read, its exit decides. */
const CLOSED_PIPE_CODES: ReadonlySet<string> = new Set(["EPIPE", "ECONNRESET"]);

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
  NoGameBox: (platform: string) => `this ${platform} computer has no game box yet: a native game cannot start here`,
  NoRunsRoot: "this sandbox was given no native-runs folder, so no game starts",
  NoProtocolPipe: "the game started without its protocol pipe",
  GroupRuleUnplaced: "sandbox-runtime's Seatbelt profile was not where Genex adds its process-group rule",
  BridgeRuleUnplaced: "sandbox-runtime's Seatbelt profile was not where Genex closes the device bridges",
  NoGameBoxFor: (platform: string, box: GameBoxProblem) =>
    `this ${platform} computer has no game box for this run (${box}): a native game cannot start here`,
  NotTheGame: (exe: string) => `a Windows game starts only its bundle's own game.exe, not ${JSON.stringify(exe)}`,
} as const;

/** Where sandbox-runtime's macOS command passes its profile, and the line every profile starts with. */
const SANDBOX_EXEC_PROFILE = "/usr/bin/sandbox-exec -p ";
const PROFILE_HEAD = "(version 1)";
/** The quote sandbox-runtime's own `quote` puts around the profile, and how a `'` inside it reads. */
const PROFILE_QUOTE = "'";
const QUOTED_QUOTE = `'"'"'`;
/** sandbox-runtime's loopback grant under `allowLocalBinding`, and the same grant a port deny can narrow. */
const LOOPBACK_OUTBOUND_RULE = '(allow network-outbound (remote ip "localhost:*"))';
const LOOPBACK_RULE = '(allow network* (remote ip "localhost:*"))';
/** The adb server's port. */
const ADB_SERVER_PORT = 5037;
/** The emulators' console and adb ports: a pair per instance, from the first to the sixteenth. */
const EMULATOR_FIRST_PORT = 5554;
const EMULATOR_LAST_PORT = 5585;
/**
 * The emulators' gRPC control endpoints (input, installs, screenshots): 8554 for the first and up,
 * one per instance. Sized like the console range, so an instance a person moved stays covered.
 */
const EMULATOR_GRPC_FIRST_PORT = 8554;
const EMULATOR_GRPC_LAST_PORT = 8585;
/** Every port a device bridge answers on: no agent command connects to one (C1). */
const DEVICE_BRIDGE_PORTS: readonly number[] = [
  ADB_SERVER_PORT,
  ...portRange(EMULATOR_FIRST_PORT, EMULATOR_LAST_PORT),
  ...portRange(EMULATOR_GRPC_FIRST_PORT, EMULATOR_GRPC_LAST_PORT),
];
/** setsid(2) and setpgid(2) refused: a reaped run's descendants stay in the group it ends (as a game's do). */
const KEEP_IN_GROUP_RULE = `(deny syscall-unix (syscall-number ${LEAVE_GROUP_SYSCALLS.join(" ")}))`;

/**
 * sandbox-runtime's macOS argv with {@link KEEP_IN_GROUP_RULE} added to its Seatbelt profile, for
 * a run that reaps its group once it exits (`reapGroup`): killing the group alone misses a
 * descendant that left it. Throws when the profile is not where 0.0.73 puts it, so a changed
 * runtime refuses the build rather than running it without the rule.
 */
export function keepInGroup(argv: readonly string[]): string[] {
  const slot = profileSlot(argv);
  if (!slot) throw new Error(MESSAGE.GroupRuleUnplaced);
  return withRules(argv, slot, [KEEP_IN_GROUP_RULE]);
}

/** `first` to `last`, both included. */
function portRange(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
}

/**
 * The argv slot holding sandbox-runtime's quoted Seatbelt profile, where the profile's head ends,
 * and where its closing quote is (the command after it is the agent's, never the profile).
 */
interface ProfileSlot {
  at: number;
  headEnd: number;
  end: number;
}

/** Where {@link SANDBOX_EXEC_PROFILE} passes the profile in `argv`, as 0.0.73 quotes it; null when it is not there. */
function profileSlot(argv: readonly string[]): ProfileSlot | null {
  const at = argv.findIndex((arg) => arg.includes(SANDBOX_EXEC_PROFILE));
  const wrapped = argv[at] ?? "";
  const start = wrapped.indexOf(SANDBOX_EXEC_PROFILE) + SANDBOX_EXEC_PROFILE.length;
  const quoted = wrapped.startsWith(`${PROFILE_QUOTE}${PROFILE_HEAD}`, start);
  if (at < 0 || !quoted) return null;
  const headEnd = start + PROFILE_QUOTE.length + PROFILE_HEAD.length;
  const end = closingQuote(wrapped, headEnd);
  return end < 0 ? null : { at, headEnd, end };
}

/** The index of the `'` that closes a quoted profile, from `from`: a `'"'"'` is a quote inside it. */
function closingQuote(wrapped: string, from: number): number {
  let at = wrapped.indexOf(PROFILE_QUOTE, from);
  while (at >= 0 && wrapped.startsWith(QUOTED_QUOTE, at)) at = wrapped.indexOf(PROFILE_QUOTE, at + QUOTED_QUOTE.length);
  return at;
}

/**
 * `argv` with `rules` added right after the profile's head, where a rule's place does not weaken
 * it. Inside the single quotes every byte is literal, so only a `'` in a rule (a path holding one)
 * is written as sandbox-runtime's own `quote` writes it.
 */
function withRules(argv: readonly string[], slot: ProfileSlot, rules: readonly string[]): string[] {
  const wrapped = argv[slot.at] ?? "";
  const text = rules.map((rule) => `\n${rule.replaceAll(PROFILE_QUOTE, QUOTED_QUOTE)}`).join("");
  const ruled = `${wrapped.slice(0, slot.headEnd)}${text}${wrapped.slice(slot.headEnd)}`;
  return argv.map((arg, index) => (index === slot.at ? ruled : arg));
}

/**
 * sandbox-runtime's macOS argv with the device bridges closed (C1): no connection to the adb
 * server's port or an emulator's console, adb or gRPC port on a loopback address (IPv4 or IPv6),
 * whatever else localhost allows, and no program started from `toolDirs` (a read deny does not
 * stop a compiled program: exec maps it without a file read). Measured on macOS 26 (2026-10-07):
 * no later deny narrows sandbox-runtime's `network-outbound` grant to `localhost:*`, while the
 * same grant written for `network*` yields to a port deny in either order. So that grant is
 * rewritten inside the profile only (`loopback`: the run allows local binding, and the grant must
 * be there), then the denies are added. Throws when the profile or the grant is not where 0.0.73
 * puts them, so a changed runtime refuses every command rather than run one with the bridges open.
 */
export function closeDeviceBridges(
  argv: readonly string[],
  loopback: boolean,
  toolDirs: readonly string[] = [],
): string[] {
  const slot = profileSlot(argv);
  if (!slot) throw new Error(MESSAGE.BridgeRuleUnplaced);
  const wrapped = argv[slot.at] ?? "";
  const profile = wrapped.slice(slot.headEnd, slot.end);
  if (loopback && !profile.includes(LOOPBACK_OUTBOUND_RULE)) throw new Error(MESSAGE.BridgeRuleUnplaced);
  const rewritten = `${wrapped.slice(0, slot.headEnd)}${profile.replaceAll(LOOPBACK_OUTBOUND_RULE, LOOPBACK_RULE)}${wrapped.slice(slot.end)}`;
  const opened = argv.map((arg, index) => (index === slot.at ? rewritten : arg));
  return withRules(opened, slot, [...DEVICE_BRIDGE_PORTS.map(deviceBridgeDeny), ...toolDirs.map(deviceToolExecDeny)]);
}

/** The Seatbelt deny for one device-bridge port, on every loopback address (`localhost` is 127.0.0.1 and ::1). */
function deviceBridgeDeny(port: number): string {
  return `(deny network-outbound (remote ip "localhost:${port}"))`;
}

/** `dir` by its real path, as Seatbelt matches an exec; as given when it does not exist (yet). */
function realPathOrSelf(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** The Seatbelt deny on starting any program under `dir`, a path as sandbox-runtime writes one. */
function deviceToolExecDeny(dir: string): string {
  return `(deny process-exec (subpath ${JSON.stringify(dir)}))`;
}

/** Where bubblewrap is on every distribution Genex supports. */
const BWRAP = "/usr/bin/bwrap";
/** How long `bwrap --version` may take. */
const BWRAP_PROBE_TIMEOUT_MS = 5_000;
/** The folder a Linux host's GPU render nodes are in, and their names. */
const DRI_FOLDER = "/dev/dri";
const RENDER_NODE_NAME = /^renderD[0-9]{1,3}$/;

/**
 * Refuse, with the typed setup problem, a platform or machine the sandbox cannot run on: the
 * window then offers the fix instead of the app quitting. Missing Linux tools are looked up on
 * PATH only after sandbox-runtime's own check fails; with every tool there, Linux checks Ubuntu's
 * user-namespace restriction, which sandbox-runtime does not. On Windows the dependency check runs
 * srt-win probes of its own, so it is skipped here and asked only when a start fails
 * ({@link asWindowsSetupProblem}).
 */
function assertSandboxReady(
  runtime: Pick<SandboxRuntime, "isSupportedPlatform" | "checkDependencies">,
  platform: NodeJS.Platform = process.platform,
  linux: UsernsSeams = {},
): void {
  const supported = runtime.isSupportedPlatform();
  const checked = supported && platform !== StudioPlatform.Windows;
  const dependencyErrors = checked ? runtime.checkDependencies().errors : [];
  const onLinux = platform === StudioPlatform.Linux;
  const missingTools = onLinux && dependencyErrors.length ? missingLinuxTools() : [];
  const restricted =
    onLinux && checked && dependencyErrors.length === 0 && usernsRestricted(linux.read ?? readSystemFile);
  const userns = restricted ? usernsCheck(linux) : undefined;
  const problem = sandboxProblem({ platform, supported, dependencyErrors, missingTools, userns });
  if (problem) throw new SandboxUnavailableError(problem);
}

/** A Windows `initialize` error as the setup problem the window shows, when it is one. */
function asSetupProblem(error: unknown): unknown {
  const setup = windowsSetupProblem(error, [errorMessage(error)]);
  return setup ? new SandboxUnavailableError(setup) : error;
}

/** The Windows setup problem for what is not set up yet, carrying what Set up does; null when nothing is missing. */
function windowsGapProblem(gaps: readonly WindowsSetupGap[]): SandboxProblem | null {
  return sandboxProblem({
    platform: StudioPlatform.Windows,
    supported: true,
    dependencyErrors: gaps.map((gap) => gap.detail),
    missingTools: [],
    windowsNeeds: [...new Set(gaps.map((gap) => gap.need))],
  });
}

/**
 * A failed Windows start as the setup problem the window shows, when it is one: by the error's
 * code, else by what is not set up yet, whose refusal `initialize` throws untyped. A failure the
 * check does not explain, or a check that fails itself, stays the error it was.
 */
async function asWindowsSetupProblem(error: unknown, setupGaps: () => Promise<WindowsSetupGap[]>): Promise<unknown> {
  const typed = asSetupProblem(error);
  if (typed !== error) return typed;
  const problem = windowsGapProblem(await setupGaps().catch((): WindowsSetupGap[] => []));
  return problem ? new SandboxUnavailableError(problem) : error;
}

/** What a launch needs from a run or a long-lived start. */
type LaunchRequest = Pick<
  RunRequest,
  "command" | "cwd" | "env" | "label" | "policy" | "stdin" | "reapGroup" | "confine"
> & {
  /** A process that outlives this call (the harness): Windows sets the folder grants above its roots again first. */
  longLived?: boolean;
};

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
  /** Windows: srt-win does not pass stdin on, so a run's input reaches the command only through its stdin file. */
  stdinInFile?: boolean;
}

/** One stream's kept text: its first or its last `maxChars` characters. */
interface KeptStream {
  add(text: string): void;
  text(): string;
}

/** Keep the first `maxChars` characters of a stream; `onClip` hears that some were dropped. */
function keptHead(maxChars: number, onClip: () => void): KeptStream {
  let kept = "";
  return {
    add(text) {
      if (kept.length + text.length > maxChars) onClip();
      if (kept.length < maxChars) kept = (kept + text).slice(0, maxChars);
    },
    text: () => kept,
  };
}

/**
 * Keep the last `maxChars` characters of a stream. The text is trimmed only once it holds twice
 * the cap, so a long log costs a copy per `maxChars` of output, not one per chunk.
 */
function keptTail(maxChars: number, onClip: () => void): KeptStream {
  let kept = "";
  return {
    add(text) {
      kept += text;
      if (kept.length > maxChars) onClip();
      if (kept.length > 2 * maxChars) kept = kept.slice(-maxChars);
    },
    text: () => kept.slice(-maxChars),
  };
}

/** Collect a child's stdout and stderr as text, each clipped at `maxChars` from the end `keep` names. */
function captureOutput(
  child: { stdout: Readable; stderr: Readable },
  maxChars: number,
  keep: OutputKept,
): { stdout: string; stderr: string; truncated: boolean } {
  let truncated = false;
  const onClip = () => {
    truncated = true;
  };
  const kept = keep === OutputKept.Tail ? keptTail : keptHead;
  const stdout = kept(maxChars, onClip);
  const stderr = kept(maxChars, onClip);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text: string) => stdout.add(text));
  child.stderr.on("data", (text: string) => stderr.add(text));
  return {
    get stdout() {
      return stdout.text();
    },
    get stderr() {
      return stderr.text();
    },
    get truncated() {
      return truncated;
    },
  };
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
  const openCodeService = openCodeServicePassword(env, home);
  if (platform === StudioPlatform.Windows)
    return [...windowsDenyRead(home, env), openCodeService, ...credentialHomes()];
  const linuxStores =
    platform === StudioPlatform.Linux ? LINUX_SECRET_STORES.map((parts) => path.join(home, ...parts)) : [];
  return [
    ...HOME_SIGN_IN_STORES.map((parts) => path.join(home, ...parts)),
    openCodeService,
    ...linuxStores,
    // SEC-3: the coding CLIs' sign-in homes, wherever the environment has moved them.
    ...credentialHomes(),
  ];
}

/**
 * Windows' deny for one device-tool folder: every entry at its top (each file, and each subfolder
 * with all it holds), or the folder itself when it is empty or unreadable. srt-win puts an
 * inheritable deny on each target's parent and rewrites that parent's ACL for every target, which
 * walks the parent's whole tree; for the folder itself that parent is the SDK root, whose NDKs and
 * platforms outran srt-win's 60 s limit on every sandbox start (161 s for `platform-tools` on
 * GitHub's runner in a CI run). Its entries put that walk on the tool folder (0.2 s and 5 s).
 */
function windowsDeviceToolDenies(dir: string): string[] {
  try {
    const entries = readdirSync(dir).map((name) => path.join(dir, name));
    return entries.length > 0 ? entries : [dir];
  } catch {
    return [dir];
  }
}

/**
 * C1: the phone keys and sign-ins ({@link mobileCredentialHomes}) and the SDK folders that drive a
 * device ({@link deviceToolDirs}), which no agent process reads. Beside {@link baseDenyRead}, not
 * in it: that list also becomes Claude Code's permission rules, whose one settings argument must
 * fit a Windows command line. On Windows only the ones that exist: srt-win would make a
 * placeholder for a missing deny path; and a tool folder is denied by its entries
 * ({@link windowsDeviceToolDenies}).
 */
export function phoneDenyRead(
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const tools = deviceToolDirs(env, home, platform);
  if (platform !== StudioPlatform.Windows)
    return [...mobileCredentialHomes(env, home, platform), ...tools, ...packagedDeviceTools(platform)];
  const phone = [
    ...mobileCredentialHomes(env, home, platform),
    ...tools.filter((dir) => existsSync(dir)).flatMap(windowsDeviceToolDenies),
    ...packagedDeviceTools(platform),
  ];
  return phone.filter((p) => existsSync(p));
}

/**
 * Paths no agent process may write on `platform`, on top of the caller's list: the coding CLIs'
 * sign-in homes and Roblox Studio's Assistant settings (which switch its MCP server).
 */
export function baseDenyWrite(
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const localAppData = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  const assistant =
    platform === StudioPlatform.Windows
      ? path.join(localAppData, ...ROBLOX_ASSISTANT_SETTINGS.windows)
      : path.join(home, ...ROBLOX_ASSISTANT_SETTINGS.mac);
  return [...credentialHomes(), assistant];
}

/** `.claude` in any case, as a sandbox glob: macOS's file system does not tell the cases apart. */
const CLAUDE_FOLDER_GLOB = "[.][cC][lL][aA][uU][dD][eE]";
/** What {@link literalGlob} rewrites character by character. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this rewrites
const GLOB_OR_CONTROL = /[*?[\x00-\x1f]/g;

/**
 * `dir`, a path to deny, as the literal start of a macOS sandbox glob (never for an allow: it only
 * widens). sandbox-runtime reads any path holding `*`,
 * `?`, `[` or `]` as a glob and has no escape (`globToRegex` doubles a backslash), so `[` becomes
 * the class `[[]`, a lone `]` is already literal, and `[_]` breaks `globToRegex`'s own
 * `__GLOBSTAR` placeholders. `*`, `?` and an ASCII control character (which the profile's JSON
 * string escapes into a form Seatbelt does not read back) become `?`: any one byte other than
 * `/`, which only widens a deny.
 */
export function literalGlob(dir: string): string {
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
 * Claude Code's own folder in each of `folders`, as write denies spelled as
 * {@link claudeFolderDenyWrites} spells a game's: a later session there loads the settings and hooks
 * it holds. A worker's box and a job's box deny it in every folder they write.
 */
export function claudeFoldersIn(folders: readonly string[]): string[] {
  const resolved = [...new Set(folders.map((folder) => path.resolve(folder)))];
  return [...new Set(resolved.flatMap((folder) => claudeFolderDenyWrites(path.dirname(folder), [folder])))];
}

/** The policy a sandbox holds every process it starts to (`ProcessSandbox.create`). */
function sandboxPolicy(options: SandboxOptions, platform: NodeJS.Platform, scratchDir: string): SandboxPolicy {
  const own = ownCredentialHomes(options.ownHome ?? [], options.secretPaths);
  const notOwn = (dir: string) => !own.includes(dir);
  return {
    allowedDomains: [],
    allowLocalBinding: true,
    allowWrite: [...options.writableRoots, scratchDir, ...own],
    allowRead: options.readableRoots ?? [],
    denyRead: [
      ...baseDenyRead(os.homedir(), platform).filter(notOwn),
      ...phoneDenyRead(os.homedir(), platform),
      ...options.secretPaths,
      ...(options.denyRead ?? []),
    ],
    denyWrite: [
      ...baseDenyWrite(os.homedir(), platform).filter(notOwn),
      ...options.secretPaths,
      ...(options.denyWrite ?? []),
    ],
  };
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
  /** The start in flight, shared by every caller that needs it; cleared when it fails, so the next one tries again. */
  #starting: Promise<void> | null = null;
  #initError: Error | null = null;
  #log: ((line: string) => void) | null = null;
  /** Linux: the bubblewrap sandbox-runtime runs, when not the system's on PATH. */
  #bubblewrap: string | null = null;
  #toolPath: (() => Promise<string>) | null = null;
  #resolvedToolPath: Promise<string> | null = null;
  readonly #platform: NodeJS.Platform;
  #seams: WindowsSeams = {};
  #linux: UsernsSeams = {};
  #windows: WindowsBackend | null = null;
  /** `layout.nativeRuns`, the only folder a game's run directory may be in; null starts no game. */
  #nativeRunsRoot: string | null = null;
  /** Games this sandbox started that have not exited: `dispose` kills their groups. */
  readonly #games = new Set<ChildProcess>();
  /** Windows: the AppContainer launcher every game starts through, when this build has one. */
  #gameLauncher: string | null = null;
  #boxSeams: GameBoxSeams = {};
  /** Linux: `bwrap --version`'s output, asked once (undefined until asked). */
  #bwrapVersion: string | null | undefined;
  /** The Android SDK folders that drive a device: never on a child's PATH (C1). */
  #deviceTools: string[] = [];
  /** macOS: those folders and the packaged device tools, by real path, where no agent process starts a program (C1). */
  #deviceToolExec: string[] = [];
  #dataRoot: string | null = null;

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
    const sandbox = new ProcessSandbox(
      sandboxPolicy(options, platform, scratchDir),
      options.enabled ?? true,
      scratchDir,
      platform,
    );
    sandbox.#configure(options, platform);
    if (!sandbox.enabled) return sandbox;
    if (options.startInBackground && platform === StudioPlatform.Windows) await sandbox.#startInBackground();
    else await sandbox.#initialize();
    return sandbox;
  }

  /** What `create` hands the instance beyond its policy: its seams, its game box's folders and helpers. */
  #configure(options: SandboxOptions, platform: NodeJS.Platform): void {
    this.#toolPath = options.toolPath ?? null;
    this.#runtime = options.runtime ?? null;
    this.#seams = options.windows ?? {};
    this.#linux = { read: options.runtime ? NO_SYSTEM_FILES : undefined, ...options.linux };
    this.#nativeRunsRoot = options.nativeRunsRoot ?? null;
    this.#gameLauncher = options.gameLauncher ?? null;
    this.#boxSeams = options.gameBoxSeams ?? {};
    this.#deviceTools = deviceToolDirs(process.env, os.homedir(), platform);
    this.#deviceToolExec = [...this.#deviceTools, ...packagedDeviceTools(platform)].map(realPathOrSelf);
    this.#dataRoot = longDataRoot(options.dataRoot, platform);
    this.#log = options.log ?? null;
    this.#bubblewrap = platform === StudioPlatform.Linux ? (options.bubblewrap ?? ownBubblewrap()) : null;
  }

  /**
   * PATH for the processes this sandbox starts, resolved on first use and remembered. A caller
   * that passes its own `env.PATH` still wins — this is the floor, not a policy.
   */
  networkProxy(): { host: string; port: number } | null {
    const port = this.#manager?.getProxyPort?.();
    return this.#initialized && port && Number.isInteger(port) && port > 0 && port <= 65535
      ? { host: "127.0.0.1", port }
      : null;
  }

  async toolPath(): Promise<string | null> {
    if (!this.#toolPath) return null;
    this.#resolvedToolPath ??= this.#toolPath().catch(() => process.env.PATH ?? "");
    return this.#resolvedToolPath;
  }

  get initError(): Error | null {
    return this.#initError;
  }

  /** Wait for sandbox initialization before booting or recovering code that must run inside it. */
  async ensureReady(): Promise<void> {
    if (this.enabled) await this.#initialize();
  }

  /**
   * Start one admitted game bundle under its own host-written game profile, in a process group of
   * its own, with fd 3 as the protocol pipe and nothing of this process's environment (an embedded
   * run also gets its frames service). Refused with `NativeError(NoGameBox)` where this host has no
   * game box, and `NativeError(Unsupported)` for a frames service that is not the run's own,
   * spawning nothing.
   */
  async spawnGame(request: GameSpawnRequest): Promise<GameChild> {
    const box = this.gameBox(request.mode, request.stack);
    if (box) throw new NativeError(NativeRefusal.NoGameBox, MESSAGE.NoGameBoxFor(this.#platform, box), null, box);
    if (!this.#nativeRunsRoot) throw new NativeError(NativeRefusal.Unsupported, MESSAGE.NoRunsRoot);
    if (this.#platform === StudioPlatform.Windows) return this.#spawnWindowsGame(request, this.#nativeRunsRoot);
    if (this.#platform === StudioPlatform.Linux) return this.#spawnLinuxGame(request, this.#nativeRunsRoot);
    const launch = await prepareGameLaunch(request, this.#nativeRunsRoot);
    // fd 3 is the fourth stdio slot; `detached` makes the game lead a process group of its own,
    // which the profile keeps it in (setsid and setpgid are denied) and every stop signals whole.
    const child = spawn(launch.file, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      detached: true,
    });
    return this.#gameChild(child);
  }

  /**
   * Windows: the AppContainer launcher (`windows-game-launch.ts`), planned and checked by realpath,
   * the run claimed once, then spawned hidden with fd 3 as its relay to the game's pipe.
   */
  async #spawnWindowsGame(request: GameSpawnRequest, root: string): Promise<GameChild> {
    const exe = NATIVE_CROSS_EXECUTABLES[BuildTarget.Windows];
    if (request.exe !== path.win32.join(request.bundle, exe)) {
      throw launchRefusalError({
        ok: false,
        refusal: WindowsLaunchRefusal.Exe,
        detail: MESSAGE.NotTheGame(request.exe),
      });
    }
    const boxSpawn = this.#boxSpawn();
    const deps: WindowsStartDeps<ChildProcess> = {
      ...windowsLaunchDeps(root),
      ...this.#boxSeams.windows,
      // Node takes a mutable stdio list; the plan's is a fixed tuple.
      spawn: (command, args, options) => boxSpawn(command, args, { ...options, stdio: [...options.stdio] }),
    };
    const started = await startWindowsGame(
      {
        launcher: this.#gameLauncher ?? "",
        runId: request.runId,
        runDir: request.runDir,
        bundle: request.bundle,
        state: request.state,
        exe,
        desktop: launcherDesktopFor(request.mode),
        nonce: request.nonce,
        memoryBytes: NATIVE_GAME_MEMORY_MAX_BYTES,
      },
      deps,
    );
    if (!started.ok) throw launchRefusalError(started);
    const cleanup = () => this.#deleteLauncherProfile(started.launch.command, request.runId, started.launch.env);
    return this.#launcherChild(started.child, cleanup);
  }

  /**
   * A launcher that was killed or crashed (not stopped through fd 3, `launcherMayLeaveProfile`)
   * cannot delete its run's AppContainer profile: the launcher's own `--delete-profile` does, once,
   * with only `SystemRoot`. Its outcome changes nothing (deleting an absent profile succeeds; a
   * leftover profile holds no grants).
   */
  #deleteLauncherProfile(launcher: string, runId: string, env: Record<string, string>): void {
    const plan = planProfileCleanup(launcher, runId);
    if (!plan.ok) return;
    const systemRoot = env[SYSTEM_ROOT];
    const options: SpawnOptions = {
      env: systemRoot ? { [SYSTEM_ROOT]: systemRoot } : {},
      stdio: "ignore",
      windowsHide: true,
    };
    try {
      this.#boxSpawn()(plan.command, plan.args, options).on("error", () => {});
    } catch {
      /* the launcher is gone: nothing to clean up with */
    }
  }

  /**
   * The launcher as the game's child: its exit read through `launcherGameExit`, its stops through
   * fd 3 and the job, and its profile deleted after any exit the launcher did not report itself.
   */
  async #launcherChild(child: ChildProcess, cleanup: () => void): Promise<GameChild> {
    const game = await this.#gameChild(child);
    const reaped = () => child.exitCode !== null || child.signalCode !== null;
    const kill = (signal: NodeJS.Signals) => {
      if (reaped()) return;
      if (signal === "SIGTERM") {
        game.fd3.end();
        return;
      }
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };
    const exited = game.exited.then((exit) => {
      if (launcherMayLeaveProfile(exit)) cleanup();
      return launcherGameExit(exit);
    });
    return { ...game, exited, kill };
  }

  /**
   * Linux: the run folders checked against the native-runs root, then the bubblewrap box planned
   * (`linux-game-box.ts`), the run claimed once, and bubblewrap spawned with the seccomp program on fd 4.
   */
  async #spawnLinuxGame(request: GameSpawnRequest, root: string): Promise<GameChild> {
    const seams = this.#boxSeams;
    const system = seams.linuxSystem ?? LINUX_BOX_SYSTEM;
    const checked = await linuxRunFolders(request, root, system);
    if (!checked.ok) throw linuxBoxError(checked);
    const { folders } = checked;
    const windowed = request.mode === NativeRunMode.Window;
    const waylandContext = windowed ? ((await seams.waylandContext?.(request.runId)) ?? null) : null;
    const launched = await launchLinuxGameBox(
      seams.bwrap ?? BWRAP,
      {
        mode: request.mode,
        bundle: folders.bundle,
        exe: folders.exe,
        state: folders.state,
        nonce: request.nonce,
        renderNodes: await (seams.renderNodes ?? renderNodes)(),
        softwareIcd: path.join(folders.bundle, LinuxRuntimeFile.SwiftShaderIcd),
        waylandContext,
        audio: LinuxBoxAudio.Muted,
        session: seams.session ?? process.env,
        ...(request.stack ? { stack: request.stack } : {}),
      },
      { system, spawn: this.#boxSpawn(), claim: () => claimLinuxRun(folders) },
    );
    if (!launched.ok) throw linuxBoxError(launched);
    return this.#gameChild(launched.child);
  }

  /** The spawn the Windows and Linux boxes start their one process with. */
  #boxSpawn(): (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess {
    return this.#boxSeams.spawn ?? ((file, args, options) => spawn(file, args, options));
  }

  /** A started game as its caller holds it, tracked until it exits so `dispose` can end it. */
  async #gameChild(child: ChildProcess): Promise<GameChild> {
    this.#games.add(child);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => {
        this.#games.delete(child);
        resolve({ code, signal });
      });
    });
    try {
      await once(child, "spawn");
    } catch (error) {
      this.#games.delete(child);
      throw error;
    }
    // Once started, a child reports an error only for a signal it could not deliver; the game's
    // stops signal its group through `killTree`, which tolerates that, so it must not crash the host.
    child.on("error", () => {});
    const fd3 = child.stdio[3];
    const { pid, stdout, stderr } = child;
    if (!(fd3 instanceof Duplex) || pid === undefined || !stdout || !stderr) {
      killTree(child.pid);
      throw new Error(MESSAGE.NoProtocolPipe);
    }
    // Once the game is reaped its pid can be given to an unrelated process: a stop's later signal
    // (SIGKILL after SIGTERM's grace) must then reach nothing, as Node's own `child.kill` does.
    const kill = (signal: NodeJS.Signals) => {
      if (child.exitCode === null && child.signalCode === null) killTree(pid, signal);
    };
    return { pid, fd3, stdout, stderr, exited, kill };
  }

  /**
   * Kill every game this sandbox started that is still running, and wait for each to be reaped: a
   * POSIX game's whole process group; on Windows the launcher through its own handle, whose Job
   * Object ends the game (a kill by pid would read as the game's own exit 1).
   */
  async #stopGames(): Promise<void> {
    const running = [...this.#games].filter((game) => game.exitCode === null && game.signalCode === null);
    const reaped = running.map((game) => once(game, "exit").catch(() => {}));
    for (const game of running) killChild(game, this.#platform);
    await Promise.all(reaped);
  }

  /**
   * Whether this host has a game box for its own OS for a `mode` run (Play's window by default): what
   * Play and a judging target need. A Mac always has one; elsewhere `gameBox` says why not.
   */
  gameBoxAvailable(mode: NativeRunMode = NativeRunMode.Window): boolean {
    return this.gameBox(mode) === null;
  }

  /**
   * Why this host has no game box for a `mode` run, or null. A Mac always has one (the Seatbelt game
   * profile). Windows needs the launcher in this build's resources; Linux needs bubblewrap 0.8 or
   * newer, user namespaces, a Wayland session and a per-run security context. Neither has a
   * windowless build, so an agent's headless run is `no-headless-build` there, except a Rust game's
   * on Linux (`stack`; absent: C++ · raylib), whose one binary runs headless in the box.
   */
  gameBox(mode: NativeRunMode, stack?: CompiledStack): GameBoxProblem | null {
    if (this.#platform === StudioPlatform.Mac) return null;
    if (this.#platform === StudioPlatform.Windows) return windowsGameBoxProblem(mode, this.#launcherStat());
    if (this.#platform !== StudioPlatform.Linux) return GameBoxProblem.BoxRefused;
    return linuxGameBoxProblem({
      mode,
      bwrapVersion: () => this.#bubblewrapVersion(),
      usernsRestricted: () => usernsRestricted(this.#linux.read ?? readSystemFile),
      session: this.#boxSeams.session ?? process.env,
      securityContext: this.#boxSeams.waylandContext !== undefined,
      ...(stack ? { stack } : {}),
    });
  }

  /** Windows: the launcher file's kind, never following a link; null when this build has none. */
  #launcherStat(): LauncherFileStat | null {
    const launcher = this.#gameLauncher;
    if (!launcher) return null;
    if (this.#boxSeams.launcherStat) return this.#boxSeams.launcherStat(launcher);
    try {
      return lstatSync(launcher);
    } catch {
      return null;
    }
  }

  /** Linux: `bwrap --version`'s output, asked once per sandbox (a host program, never a game). */
  #bubblewrapVersion(): string | null {
    if (this.#bwrapVersion !== undefined) return this.#bwrapVersion;
    const probe = this.#boxSeams.bwrapVersion ?? (() => bubblewrapVersionText(this.#boxSeams.bwrap ?? BWRAP));
    this.#bwrapVersion = probe();
    return this.#bwrapVersion;
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
   * Open another folder the agent may read: a native runtime the person installed in their own
   * profile, which srt-win's sandbox user cannot read otherwise. Idempotent, and a no-op when `dir`
   * already sits inside a readable or writable root.
   */
  allowRead(dir: string): void {
    const resolved = path.resolve(dir);
    const roots = [...this.policy.allowRead, ...this.policy.allowWrite];
    if (roots.some((root) => isInside(root, resolved))) return;
    this.policy.allowRead.push(resolved);
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
   * process alive. Games it started are killed first (`#stopGames`). Safe to call twice.
   */
  async dispose(): Promise<void> {
    await this.#stopGames();
    // A start in flight joins the session; it leaves only after that.
    await this.#starting?.catch(() => {});
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
    this.#starting ??= this.#boot().catch((error: unknown) => {
      this.#starting = null;
      throw error;
    });
    await this.#starting;
  }

  /**
   * Windows: refuse now what Set up fixes, so the window still opens on the setup screen, and
   * start the rest behind it. A start that fails there is tried again by the first launch, which
   * reports its error.
   */
  async #startInBackground(): Promise<void> {
    const runtime = this.#runtime ?? (await import("@anthropic-ai/sandbox-runtime")).SandboxManager;
    assertSandboxReady(runtime, this.#platform);
    const bash = this.#seams.bash === undefined ? await findGitBash() : this.#seams.bash;
    if (!bash) throw new SandboxUnavailableError(gitMissingProblem());
    const gaps = await (this.#seams.setupGaps ?? windowsSetupGaps)().catch((): WindowsSetupGap[] => []);
    const problem = windowsGapProblem(gaps);
    if (problem) throw new SandboxUnavailableError(problem);
    const started = performance.now();
    this.#initialize().then(
      () => this.#log?.(`started in the background in ${Math.round(performance.now() - started)} ms`),
      (error: unknown) => this.#log?.(`background start failed: ${errorMessage(error)}`),
    );
  }

  async #boot(): Promise<void> {
    try {
      const SandboxManager = this.#runtime ?? (await import("@anthropic-ai/sandbox-runtime")).SandboxManager;
      assertSandboxReady(SandboxManager, this.#platform, this.#linux);
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
    const installDir = path.dirname(longPath(process.execPath, this.#platform));
    const read = [
      installDir,
      ...grantableToolDirs(toolDirs, profile, this.policy.denyRead),
      ...(insideWindowsPath(profile, gitRoot) ? [gitRoot] : []),
    ];
    const session =
      this.#seams.session ??
      windowsSessionFor(runtime, {
        profile,
        srtWin: srtWinPath(),
        installDir,
        ...(this.#dataRoot ? { dataRoot: this.#dataRoot } : {}),
        ...(this.#log ? { log: this.#log } : {}),
      });
    const backend = { session, bash, read, profile, curlHome: await writeCurlHome(this.scratchDir) };
    await session
      .join(this, { grants: this.#windowsGrants(backend), config: this.#windowsSessionConfig() })
      .catch(async (error: unknown) => {
        throw (
          windowsProxyPortsError(error) ??
          (await asWindowsSetupProblem(error, this.#seams.setupGaps ?? windowsSetupGaps))
        );
      });
    this.#windows = backend;
    // A folder or deny added while the session started (a start in the background) joins it now.
    session.update(this, this.#windowsGrants(backend));
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
      ...(this.#bubblewrap ? { bwrapPath: this.#bubblewrap } : {}),
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
    /**
     * All of the process's input, sent once and then closed. Pass it here rather than writing to
     * the child: on Windows srt-win does not pass stdin on, so only the run's stdin file carries it.
     */
    stdin?: string;
    /**
     * Input the caller keeps writing for the life of the process (the Play Protocol's requests):
     * write it to the answer's `input`, never to `child.stdin`, which srt-win does not pass on.
     */
    liveInput?: boolean;
  }): Promise<{ child: ChildProcess; sandboxed: boolean; input: Writable }> {
    // Held open until the process is gone, as `run` holds it for the length of a run.
    const close = await this.#openDomains(request.policy);
    let live: LiveInput | null = null;
    try {
      live = request.liveInput ? await this.#liveInput(request.command) : null;
      const launch = live ? { ...request, ...this.#relayed(live, request.env) } : request;
      const plan = await this.#launchPlan({ ...launch, longLived: true });
      const relay = live;
      const done = () => {
        plan.release?.();
        close();
        void relay?.close();
      };
      const child = this.#start(plan);
      child.once("close", done);
      child.once("error", done);
      if (request.stdin !== undefined) {
        // A process that exits before reading its input lands EPIPE here; its exit already says so.
        child.stdin.on("error", () => {});
        child.stdin.end(plan.stdinInFile ? undefined : request.stdin);
      }
      if (relay) void relay.connect(() => child.exitCode === null && child.signalCode === null);
      return { child, sandboxed: plan.sandboxed, input: relay?.input ?? child.stdin };
    } catch (err) {
      close();
      await live?.close();
      throw err;
    }
  }

  /** Windows, sandboxed: the relay a process's live input goes through. Null elsewhere: stdin carries it. */
  async #liveInput(command: string): Promise<LiveInput | null> {
    await this.ensureReady();
    const backend = this.#windows;
    if (!this.enabled || !backend) return null;
    return openLiveInput({ command, shell: backend.bash, scratchDir: this.scratchDir });
  }

  /** The relay in place of the caller's command, by the studio's own Node, its variables beside the caller's. */
  #relayed(live: LiveInput, env: Record<string, string> | undefined): { command: string; env: Record<string, string> } {
    const node = shellQuote(mixedPath(longPath(process.execPath, this.#platform)));
    const file = shellQuote(mixedPath(live.file));
    return { command: `export ELECTRON_RUN_AS_NODE=1; exec ${node} ${file}`, env: { ...env, ...live.env } };
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
    const tmp = await this.#runTmp(request);
    const wrapped = await prepareSandbox(
      () =>
        manager.wrapWithSandboxArgv(
          this.#withTmp(request.command, tmp),
          process.platform === "darwin" ? SANDBOX_SHELL : undefined,
          this.#overlay(request.policy ?? {}, request.confine),
          signal,
          request.cwd,
          { commandId: request.label ?? request.command, commandText: request.command },
        ),
      { signal },
    );
    const ruled = this.#bridgesClosed(wrapped.argv, request.policy ?? {});
    const reaped = request.reapGroup && this.#platform === StudioPlatform.Mac;
    const [file, ...args] = reaped ? keepInGroup(ruled) : ruled;
    if (!file) throw new Error(MESSAGE.EmptyArgv);
    const env = { ...(await this.#env(wrapped.env, request.env, tmp)), ...NESTED_SHELL_ENV };
    return { file, args, env, sandboxed: true, cwd: request.cwd };
  }

  /**
   * macOS: `argv` with the device bridges closed ({@link closeDeviceBridges}). Required of the real
   * runtime; a test's fake runtime gets the rules only when its argv carries a Seatbelt profile.
   */
  #bridgesClosed(argv: string[], patch: Partial<SandboxPolicy>): string[] {
    if (this.#platform !== StudioPlatform.Mac) return argv;
    if (this.#runtime && !argv.some((arg) => arg.includes(SANDBOX_EXEC_PROFILE))) return argv;
    return closeDeviceBridges(argv, mergeOverlay(this.policy, patch).allowLocalBinding, this.#deviceToolExec);
  }

  /**
   * The sandbox off (tests only): a plain `/bin/sh -c`, or Git Bash on Windows with the basics a
   * Windows program needs to start and the env file's `MSYS_NO_PATHCONV=1`.
   */
  async #unsandboxedPlan(request: LaunchRequest): Promise<LaunchPlan> {
    const own = await this.#env(process.env, request.env, await this.#runTmp(request));
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
      if (request.longLived) await backend.session.refreshAncestors();
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
      return { file, args, env: wrapped.env, sandboxed: true, cwd, release: done, stdinInFile: true };
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
   * every grant), so srt-win never creates a placeholder there. So is one Genex already denies
   * for the session: srt-win would stamp it again for the command, walking its parent folder.
   */
  #windowsOverlay(
    backend: WindowsBackend,
    patch: Partial<SandboxPolicy>,
  ): import("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfig {
    const applied = backend.session.applied ?? { write: [], read: [] };
    const scope = { roots: [...applied.write, ...applied.read], profile: backend.profile };
    const kept = (paths: readonly string[] | undefined, access: DenyAccess) =>
      backend.session.withoutOwnDenies(keepWindowsDenies(paths ?? [], scope), access);
    const denyRead = kept(patch.denyRead, DenyAccess.Read);
    const config = this.toRuntimeConfig({
      ...this.policy,
      allowedDomains: [...this.policy.allowedDomains, ...(patch.allowedDomains ?? [])],
      allowWrite: [],
      allowRead: [],
      denyRead,
      denyWrite: writeDeniesBeyondRead(kept(patch.denyWrite, DenyAccess.Write), denyRead),
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

  /**
   * Put this instance's policy, with every domain its runs in flight opened, back into the
   * process-wide runtime: another instance's `initialize` (a prewarm's own sandbox) replaced it.
   */
  refreshConfig(): void {
    if (this.enabled && this.#initialized) this.#pushConfig();
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
      const output = captureOutput(
        child,
        request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_CHARS,
        request.keepOutput ?? OutputKept.Head,
      );

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

      // On exit, not close: a process left in the group may hold the output pipes open.
      if (request.reapGroup && this.#platform !== StudioPlatform.Windows) child.once("exit", () => killTree(child.pid));

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

      // A child that exits before reading its input closes the pipe under the write (EPIPE): the
      // run still settles on its exit code and output. Any other stdin failure ends the run.
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (CLOSED_PIPE_CODES.has(error.code ?? "")) return;
        // The kill brings the close, which settles the run's timer and plan.
        killChild(child, this.#platform);
        reject(error);
      });
      // The prelude swaps a Windows command's stdin for its file: input sent down the pipe as well
      // would race the swap and fail with EPIPE once the command's end of the pipe is closed.
      const piped = plan.stdinInFile ? undefined : request.stdin;
      if (piped !== undefined) child.stdin.end(piped);
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
  async #env(
    parent: NodeJS.ProcessEnv,
    own: Record<string, string> | undefined,
    tmp: string = this.scratchDir,
  ): Promise<Record<string, string>> {
    const env = childEnv(parent, {
      base: "sandbox",
      set: { ...tmpEnv(tmp), ...(await this.#pathEnv()), ...(own ?? {}) },
    });
    // C1: whoever set PATH (the floor or the caller), the device tools are not on it.
    const delimiter = this.#platform === StudioPlatform.Windows ? ";" : ":";
    for (const key of Object.keys(env))
      if (key.toUpperCase() === "PATH") env[key] = withoutDeviceTools(env[key] ?? "", this.#deviceTools, delimiter);
    return env;
  }

  /** The resolved toolchain PATH, or nothing when this sandbox was given no resolver. */
  async #pathEnv(): Promise<Record<string, string>> {
    const resolved = await this.toolPath();
    return resolved ? { PATH: resolved } : {};
  }

  /**
   * A run's temp folder: its confinement's own, or the agent's scratch dir. A confinement's folders
   * are made first: srt on Linux leaves out a writable folder that is not there yet.
   */
  async #runTmp(request: LaunchRequest): Promise<string> {
    if (!request.confine) return this.scratchDir;
    const { write, tmp } = request.confine;
    await Promise.all([...write, tmp].map((dir) => mkdir(dir, { recursive: true })));
    return tmp;
  }

  /**
   * srt assigns its own `TMPDIR` (`/tmp/claude`) *inside* the wrapped argv, so an env override
   * cannot win — the assignment has to happen in the command itself. Verified against 0.0.73.
   */
  #withTmp(command: string, tmp: string): string {
    const dir = shellQuote(tmp);
    return `export TMPDIR=${dir} TMP=${dir} TEMP=${dir}; ${command}`;
  }

  /**
   * A run's own config: the sandbox's, widened by the run's patch ({@link mergeOverlay}), or — for
   * a confined run — with the confinement's folders as its only writable ones. srt takes a per-spawn
   * `allowWrite` in place of the process-wide one.
   */
  #overlay(
    patch: Partial<SandboxPolicy>,
    confine?: RunConfinement,
  ): import("@anthropic-ai/sandbox-runtime").SandboxRuntimeConfig {
    const base = confine ? { ...this.policy, allowWrite: [...confine.write, confine.tmp] } : this.policy;
    return this.toRuntimeConfig(mergeOverlay(base, patch));
  }
}

/**
 * A run's policy over the instance's: domains and allow lists added, deny lists a union, and every
 * overlay `allowWrite` that is a write deny (the instance's or the run's own) or lies inside one
 * dropped. Seatbelt lets a deny win whatever is allowed; bubblewrap mounts a writable folder inside
 * a read-only one and the write goes through, so the merge makes the deny win on every platform.
 */
export function mergeOverlay(base: SandboxPolicy, patch: Partial<SandboxPolicy>): SandboxPolicy {
  const denyWrite = [...base.denyWrite, ...(patch.denyWrite ?? [])];
  const lifts = (dir: string) => denyWrite.some((deny) => isInside(deny, dir));
  return {
    ...base,
    ...patch,
    allowedDomains: [...base.allowedDomains, ...(patch.allowedDomains ?? [])],
    allowWrite: [...base.allowWrite, ...(patch.allowWrite ?? []).filter((dir) => !lifts(dir))],
    allowRead: [...base.allowRead, ...(patch.allowRead ?? [])],
    // Deny lists are never weakened by a per-run overlay.
    denyRead: [...base.denyRead, ...(patch.denyRead ?? [])],
    denyWrite,
  };
}

/** `bwrap --version`'s output, or null when it does not run. */
function bubblewrapVersionText(bwrap: string): string | null {
  try {
    return execFileSync(bwrap, ["--version"], {
      encoding: "utf8",
      timeout: BWRAP_PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
      env: {},
    });
  } catch {
    return null;
  }
}

/** Point every temp-file convention at `dir`. */
const tmpEnv = (dir: string): Record<string, string> => ({ TMPDIR: dir, TMP: dir, TEMP: dir });

/** This host's GPU render nodes, `/dev/dri/renderD*`; none when the folder cannot be read. */
async function renderNodes(): Promise<string[]> {
  const names = await readdir(DRI_FOLDER).catch(() => [] as string[]);
  return names.filter((name) => RENDER_NODE_NAME.test(name)).map((name) => path.posix.join(DRI_FOLDER, name));
}

/**
 * Claims a Linux run for its one start: `launch.claim` created exclusively in the run folder (never
 * through a link), then the game's HOME made in `state/`. False when a start claimed it before.
 */
async function claimLinuxRun(folders: LinuxRunFolders): Promise<boolean> {
  if (!(await writeNewFile(path.join(folders.runDir, RunDirLayout.Claim), "", 0o600))) return false;
  const home = path.join(folders.state, RunDirLayout.Home);
  await mkdir(home, { mode: 0o700 }).catch(async (error: NodeJS.ErrnoException) => {
    const info = error.code === "EEXIST" ? await lstat(home) : null;
    if (!info?.isDirectory() || info.isSymbolicLink()) throw error;
  });
  return true;
}

/** POSIX quoting, kept where `ProcessSandbox`'s callers have always imported it from. */
export { shellQuote };

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
