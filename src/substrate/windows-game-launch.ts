/**
 * How Genex starts a game when Genex itself runs on Windows (plan M7, D19 = C): the command,
 * arguments, environment and stdio for `genex-game-launcher.exe` (native/genex-game-launcher).
 * The launcher puts the game in a per-run AppContainer with no capabilities, grants it the run's
 * `bundle\` (read + execute) and `state\` (read + write + delete) and nothing else, holds it in a
 * kill-on-close Job Object with a memory limit, and relays the studio protocol between its own
 * fd 3 and the pipe `\\.\pipe\genex-game-<runId>` the game finds in `GENEX_STUDIO_PIPE`.
 *
 * Everything here is pure apart from the injected `realpath`, `claimRun` and `spawn`, and works
 * on Windows paths (`path.win32`) on any platform, so it is tested everywhere. As on the Mac
 * (`game-sandbox-profile.ts`), a run starts only from its own folder: `<runsRoot>\<runId>` by
 * realpath, with `bundle` and `state` its own two children, the game a plain file name in the
 * bundle that no link redirects, and one start per run folder. The launcher repeats the lexical
 * part itself (`launch_args.c`), so a mis-wired caller cannot relabel a person's own folders.
 * The launcher has been cross-compiled and its parser run, but it has never started a game: that
 * is spike S9, on a Windows runner.
 */
import { realpath as realpathFs } from "node:fs/promises";
import path from "node:path";
import {
  GameBoxProblem,
  NativeEnv,
  NativeError,
  NativeRefusal,
  NativeRunMode,
  nativeGameMemoryCapBytes,
} from "../shared/native-contract.ts";
import { writeNewFile } from "./fsx.ts";
import { isRunId, RunDirLayout } from "./native-bundle.ts";

const win = path.win32;

/** Where a run's window lives: the person's own desktop (Play), or a desktop nobody sees (agent runs). Wire values. */
export const LauncherDesktop = {
  Interactive: "interactive",
  Hidden: "hidden",
} as const;
export type LauncherDesktop = (typeof LauncherDesktop)[keyof typeof LauncherDesktop];

/** The desktop each run mode gets. */
const DESKTOP_FOR_MODE = {
  [NativeRunMode.Window]: LauncherDesktop.Interactive,
  [NativeRunMode.Headless]: LauncherDesktop.Hidden,
  /** Frames go to Live through shared images: the game needs no visible desktop (M5b). */
  [NativeRunMode.Embedded]: LauncherDesktop.Hidden,
} as const satisfies Record<NativeRunMode, LauncherDesktop>;

/** The variables only a Windows run adds to `NativeEnv`. Wire names (one home: `NativeEnv`). */
export const WindowsGameEnv = {
  /** The protocol pipe's name; the launcher sets it, never the host. */
  StudioPipe: NativeEnv.StudioPipe,
} as const;
export type WindowsGameEnv = (typeof WindowsGameEnv)[keyof typeof WindowsGameEnv];

/** Why a launch was refused before anything started. Wire values. */
export const WindowsLaunchRefusal = {
  /** The request is not an object at all. */
  Request: "invalid-request",
  RunId: "invalid-run-id",
  Launcher: "invalid-launcher",
  Path: "invalid-path",
  Unresolvable: "unresolvable-path",
  /** The run folder is not directly in the native-runs root, or the game links out of the bundle. */
  OutsideRunRoot: "outside-run-root",
  /** The run folder is not `<runsRoot>\<runId>` by name or by real path. */
  RunDir: "not-the-run-dir",
  /** The bundle and state are not the run folder's own `bundle` and `state`. */
  FolderLayout: "folder-layout",
  Exe: "invalid-exe",
  Memory: "invalid-memory-limit",
  Nonce: "invalid-nonce",
  Env: "invalid-env",
  Desktop: "invalid-desktop",
  /** This run folder has started a game already: one start per run. */
  AlreadyStarted: "already-started",
  /** The run folder could not be claimed for this start. */
  ClaimFailed: "run-claim-failed",
} as const;
export type WindowsLaunchRefusal = (typeof WindowsLaunchRefusal)[keyof typeof WindowsLaunchRefusal];

/** The launcher's own failures, by the wire names `args_probe --exit-codes` prints. */
export const LauncherFailure = {
  Usage: "usage",
  ProtocolChannel: "protocol-channel",
  Profile: "profile",
  Grant: "grant",
  Pipe: "pipe",
  Job: "job",
  Desktop: "desktop",
  Spawn: "spawn",
  PipeClient: "pipe-client",
  Wait: "wait",
  Cleanup: "cleanup",
  /** The host closed fd 3, so the launcher ended the game's job: the host's own Stop. */
  Stopped: "stopped",
  /** The game exited with a code in the launcher's reserved range by itself; its own code is not reported. */
  GameReserved: "game-reserved",
} as const;
export type LauncherFailure = (typeof LauncherFailure)[keyof typeof LauncherFailure];

/** The exit codes `launch_args.h` reserves (0xE047xxxx); every other code is the game's own. */
export const LAUNCHER_EXIT_CODES = {
  [LauncherFailure.Usage]: 0xe0470001,
  [LauncherFailure.ProtocolChannel]: 0xe0470002,
  [LauncherFailure.Profile]: 0xe0470003,
  [LauncherFailure.Grant]: 0xe0470004,
  [LauncherFailure.Pipe]: 0xe0470005,
  [LauncherFailure.Job]: 0xe0470006,
  [LauncherFailure.Desktop]: 0xe0470007,
  [LauncherFailure.Spawn]: 0xe0470008,
  [LauncherFailure.PipeClient]: 0xe0470009,
  [LauncherFailure.Wait]: 0xe047000a,
  [LauncherFailure.Cleanup]: 0xe047000b,
  [LauncherFailure.Stopped]: 0xe0470010,
  [LauncherFailure.GameReserved]: 0xe0470011,
} as const satisfies Record<LauncherFailure, number>;

/** Whose exit status the launcher's was. */
export const LauncherOutcomeKind = {
  Game: "game",
  Launcher: "launcher",
} as const;
export type LauncherOutcomeKind = (typeof LauncherOutcomeKind)[keyof typeof LauncherOutcomeKind];

/** The launcher's exit, read: the game's own status, or one of the launcher's failures. */
export type LauncherOutcome =
  | { kind: typeof LauncherOutcomeKind.Game; code: number | null }
  | { kind: typeof LauncherOutcomeKind.Launcher; failure: LauncherFailure };

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
/** The smallest memory limit a job gets, in bytes (`launch_args.h` holds the same bound). */
export const GAME_MEMORY_MIN_BYTES = 256 * MIB;
/** The largest memory limit a job gets, in bytes (`launch_args.h` holds the same bound). */
export const GAME_MEMORY_MAX_BYTES = 64 * GIB;
/** The memory limit a run gets when its request names none, in bytes. */
export const DEFAULT_GAME_MEMORY_BYTES = 4 * GIB;

/**
 * The Job Object's memory limit on a PC with `ramBytes` of memory: the host's memory cap
 * (`nativeGameMemoryCapBytes`), held inside the launcher's own bounds so a very large or very
 * small PC gets the nearest limit the launcher takes, never `invalid-memory-limit`.
 */
export function jobMemoryBytes(ramBytes: number): number {
  const cap = nativeGameMemoryCapBytes(ramBytes);
  return Math.min(GAME_MEMORY_MAX_BYTES, Math.max(GAME_MEMORY_MIN_BYTES, cap));
}
/** The longest path the launcher accepts, in UTF-16 units: MAX_PATH less its terminator. */
const PATH_MAX_UNITS = 259;
/** The game's file name in the bundle. */
const EXE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EXE_SUFFIX = ".exe";
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
/** A variable the host may hand the game: `GENEX_*`, in upper case. */
const GAME_ENV_NAME = /^GENEX_[A-Z0-9_]{1,64}$/;
const GAME_ENV_VALUE_MAX_UNITS = 4096;
/** Variables the plan sets itself; a caller's `env` may not replace them. */
const RESERVED_GAME_ENV: ReadonlySet<string> = new Set([
  WindowsGameEnv.StudioPipe,
  NativeEnv.Nonce,
  NativeEnv.StateDir,
  NativeEnv.StudioFd,
]);
/** A local absolute path: a drive letter and a backslash. */
const DRIVE_PATH = /^[A-Za-z]:\\/;
/** A unit no Windows path may hold: control characters, `/` and the reserved symbols (`:` only after the drive). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
const FORBIDDEN_PATH_UNIT = /[\u0000-\u001f\u007f/<>"|?*:]/;
/** The claim file's mode: the host's alone. */
const CLAIM_FILE_MODE = 0o600;
const PIPE_PREFIX = "\\\\.\\pipe\\genex-game-";
const PROFILE_PREFIX = "genex.game.";
/** The variable Windows itself needs in any process's environment; the launcher keeps the host's. */
export const SYSTEM_ROOT = "SystemRoot";

/** The launcher's flags, as `launch_args.c` reads them. */
const LauncherFlag = {
  RunId: "--run-id",
  Bundle: "--bundle",
  State: "--state",
  Exe: "--exe",
  Pipe: "--pipe",
  MemoryBytes: "--memory-bytes",
  Desktop: "--desktop",
  DeleteProfile: "--delete-profile",
} as const;

/** fd 3 is the protocol; `overlapped` lets the launcher read and write it from two threads at once. */
const LAUNCHER_STDIO = ["ignore", "pipe", "pipe", "overlapped"] as const;

/** A value for a log line: text quoted, a number as written, anything else by its type; never a throw. */
function shown(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  return `a ${value === null ? "null" : typeof value}`;
}

const MESSAGE = {
  request: (request: unknown) => `the launch request is ${shown(request)}, not an object`,
  runId: (runId: unknown) => `run id ${shown(runId)} is not 12-32 lowercase hexadecimal digits`,
  launcher: (launcher: unknown) => `the launcher ${shown(launcher)} is not a local absolute .exe path`,
  path: (what: string, value: unknown) => `${what} ${shown(value)} is not a local absolute Windows folder`,
  unresolvable: (what: string, value: string) => `${what} ${JSON.stringify(value)} does not resolve`,
  outside: (what: string) => `${what} resolves outside the native-runs folder`,
  runDir: "a game starts only from its own run folder, <native-runs>\\<run id>",
  layout: "the bundle and state folders must be the run folder's own bundle and state",
  exe: (exe: unknown) => `the game ${shown(exe)} is not a plain .exe file name`,
  memory: (bytes: unknown) => `memory limit ${shown(bytes)} is not a whole number of bytes in the allowed range`,
  nonce: "the nonce is not 16-128 characters of [A-Za-z0-9_-]",
  env: (name: string) => `the game variable ${JSON.stringify(name)} is not a GENEX_* name the host may set`,
  envShape: "the game's variables are not an object of text values",
  desktop: (desktop: unknown) => `desktop ${shown(desktop)} is not interactive or hidden`,
  alreadyStarted: "this run folder has started a game already",
  claim: "the run folder could not be claimed for this start",
  launcherFailed: (failure: LauncherFailure) => `the game launcher failed (${failure})`,
} as const;

/** One game run, as the host asks for it. */
export interface WindowsGameLaunchRequest {
  /** `genex-game-launcher.exe` in Genex's resources. */
  launcher: string;
  runId: string;
  /** The run folder, `<runsRoot>\<runId>`: it holds the bundle and state folders, side by side. */
  runDir: string;
  /** `<runDir>\bundle`: the game, ANGLE and assets, read and executed by the game. */
  bundle: string;
  /** `<runDir>\state`: the only folder the game writes. */
  state: string;
  /** The game's file name in the bundle, such as `game.exe`. */
  exe: string;
  desktop: LauncherDesktop;
  /** Echoed in the game's `ready`. */
  nonce: string;
  /** The job's memory limit, {@link DEFAULT_GAME_MEMORY_BYTES} when absent. */
  memoryBytes?: number;
  /** More variables for the game: `GENEX_*` names only, none the plan sets itself. */
  env?: Readonly<Record<string, string>>;
}

/** Exactly what to spawn. */
export interface WindowsGameLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  stdio: typeof LAUNCHER_STDIO;
  pipeName: string;
  profileName: string;
  /** The real run folder, which a start claims before it spawns. */
  runDir: string;
}

/** A refusal: its typed code and a sentence for the log. */
export interface WindowsLaunchRefused {
  ok: false;
  refusal: WindowsLaunchRefusal;
  detail: string;
}

/** A checked launch ready to spawn, or why it was refused. */
export type WindowsLaunchPlan = { ok: true; launch: WindowsGameLaunch } | WindowsLaunchRefused;

/** What planning reads: the native-runs root, the host's environment (for `SystemRoot`) and the file system's realpath. */
export interface WindowsLaunchDeps {
  /** `layout.nativeRuns`: every run folder is `<runsRoot>\<runId>`. */
  runsRoot: string;
  hostEnv: Readonly<Record<string, string | undefined>>;
  realpath(target: string): Promise<string>;
}

/** The options a launcher spawn gets. */
export interface LauncherSpawnOptions {
  env: Record<string, string>;
  stdio: typeof LAUNCHER_STDIO;
  windowsHide: true;
}

/** Planning plus the claim and the spawn that start the launcher. */
export interface WindowsStartDeps<Child> extends WindowsLaunchDeps {
  /** Creates `file` only if nothing exists there yet: false when something did (the run started before). */
  claimRun(file: string): Promise<boolean>;
  spawn(command: string, args: string[], options: LauncherSpawnOptions): Child;
}

/**
 * Creates `file` empty, only when nothing at all is at its name; false when something is. Windows'
 * `CREATE_NEW` follows a link left at the name and creates its target, so the claim goes through
 * `writeNewFile`, which refuses a link (a dangling one included) before and after the open.
 */
function claimByExclusiveCreate(file: string): Promise<boolean> {
  return writeNewFile(file, "", CLAIM_FILE_MODE);
}

/** The file-system deps a Windows host plans and claims with; the caller adds its `spawn`. */
export function windowsLaunchDeps(runsRoot: string): Omit<WindowsStartDeps<never>, "spawn"> {
  return { runsRoot, hostEnv: process.env, realpath: (target) => realpathFs(target), claimRun: claimByExclusiveCreate };
}

const refuse = (refusal: WindowsLaunchRefusal, detail: string): WindowsLaunchRefused => ({
  ok: false,
  refusal,
  detail,
});

/** ASCII case folding, as the launcher compares paths: anything wider stays distinct, so a mismatch refuses. */
const fold = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const samePath = (a: string, b: string): boolean => fold(a) === fold(b);

/** One path segment Windows keeps as written: not empty, `.` or `..`, and not ending in a dot or space. */
function plainSegment(segment: string): boolean {
  if (!segment || segment === "." || segment === "..") return false;
  return !segment.endsWith(".") && !segment.endsWith(" ");
}

/** A local absolute path the launcher accepts: `X:\a\b`, no share, no device namespace, no trailing separator. */
export function isLocalWindowsPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > PATH_MAX_UNITS || !DRIVE_PATH.test(value)) return false;
  const segments = value.slice(3).split("\\");
  return segments.every((segment) => plainSegment(segment) && !FORBIDDEN_PATH_UNIT.test(segment));
}

/** The run's protocol pipe. */
export const launcherPipeName = (runId: string): string => `${PIPE_PREFIX}${runId}`;
/** The run's AppContainer profile. */
export const launcherProfileName = (runId: string): string => `${PROFILE_PREFIX}${runId}`;
/** The launcher desktop for a run mode. */
export const launcherDesktopFor = (mode: NativeRunMode): LauncherDesktop => DESKTOP_FOR_MODE[mode];

/** A run id as `native-bundle.ts` names run folders (`isRunId`): 12-32 lowercase hex digits. */
const validRunId = (value: unknown): value is string => typeof value === "string" && isRunId(value);
const isDesktop = (value: unknown): value is LauncherDesktop => Object.values<unknown>(LauncherDesktop).includes(value);

function validMemory(bytes: unknown): boolean {
  return (
    Number.isSafeInteger(bytes) && Number(bytes) >= GAME_MEMORY_MIN_BYTES && Number(bytes) <= GAME_MEMORY_MAX_BYTES
  );
}

function validExeName(exe: unknown): exe is string {
  if (typeof exe !== "string" || !EXE_NAME.test(exe)) return false;
  return fold(exe).endsWith(EXE_SUFFIX) && exe.length > EXE_SUFFIX.length;
}

const validLauncher = (launcher: unknown): boolean =>
  isLocalWindowsPath(launcher) && validExeName(win.basename(launcher));

/** A plain object (no array, no class instance), as JSON parameters make one. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Whether one caller variable is a `GENEX_*` name the host may set, with a text value the launcher can pass. */
function allowedVariable(name: string, value: unknown): boolean {
  if (!GAME_ENV_NAME.test(name) || RESERVED_GAME_ENV.has(name) || typeof value !== "string") return false;
  return !value.includes("\u0000") && value.length <= GAME_ENV_VALUE_MAX_UNITS;
}

/** The caller's variables, refused when they are not an object of allowed `GENEX_*` text values. */
function envRefusal(env: unknown): WindowsLaunchRefused | null {
  if (env === undefined) return null;
  if (!isPlainObject(env)) return refuse(WindowsLaunchRefusal.Env, MESSAGE.envShape);
  const bad = Object.entries(env).find(([name, value]) => !allowedVariable(name, value));
  return bad ? refuse(WindowsLaunchRefusal.Env, MESSAGE.env(bad[0])) : null;
}

/**
 * The run's folders, lexically: three local paths, the run folder named for the run, and the
 * bundle and state its own `bundle` and `state` (case-blind, as NTFS names them).
 */
function folderRefusal(request: WindowsGameLaunchRequest): WindowsLaunchRefused | null {
  const folders = { "run folder": request.runDir, bundle: request.bundle, state: request.state };
  for (const [what, folder] of Object.entries(folders)) {
    if (!isLocalWindowsPath(folder)) return refuse(WindowsLaunchRefusal.Path, MESSAGE.path(what, folder));
  }
  if (win.basename(request.runDir) !== request.runId) return refuse(WindowsLaunchRefusal.RunDir, MESSAGE.runDir);
  const ownBundle = samePath(request.bundle, win.join(request.runDir, RunDirLayout.Bundle));
  const ownState = samePath(request.state, win.join(request.runDir, RunDirLayout.State));
  if (!ownBundle || !ownState) return refuse(WindowsLaunchRefusal.FolderLayout, MESSAGE.layout);
  return null;
}

/** The checks that need no file system, in the order the launcher makes them. */
function lexicalRefusal(request: WindowsGameLaunchRequest): WindowsLaunchRefused | null {
  if (!isPlainObject(request)) return refuse(WindowsLaunchRefusal.Request, MESSAGE.request(request));
  if (!validRunId(request.runId)) return refuse(WindowsLaunchRefusal.RunId, MESSAGE.runId(request.runId));
  if (!validLauncher(request.launcher))
    return refuse(WindowsLaunchRefusal.Launcher, MESSAGE.launcher(request.launcher));
  const folders = folderRefusal(request);
  if (folders) return folders;
  if (!validExeName(request.exe)) return refuse(WindowsLaunchRefusal.Exe, MESSAGE.exe(request.exe));
  const memory = request.memoryBytes ?? DEFAULT_GAME_MEMORY_BYTES;
  if (!validMemory(memory)) return refuse(WindowsLaunchRefusal.Memory, MESSAGE.memory(memory));
  if (typeof request.nonce !== "string" || !NONCE.test(request.nonce)) {
    return refuse(WindowsLaunchRefusal.Nonce, MESSAGE.nonce);
  }
  const env = envRefusal(request.env);
  if (env) return env;
  if (!isDesktop(request.desktop)) return refuse(WindowsLaunchRefusal.Desktop, MESSAGE.desktop(request.desktop));
  return null;
}

/** The real paths planning acts on. */
interface RealFolders {
  run: string;
  bundle: string;
  state: string;
}

/** Resolves one path, refusing when it does not resolve or resolves to a path the launcher would refuse. */
async function resolve(
  deps: WindowsLaunchDeps,
  what: string,
  target: string,
): Promise<{ real: string } | WindowsLaunchRefused> {
  let real: unknown;
  try {
    real = await deps.realpath(target);
  } catch {
    return refuse(WindowsLaunchRefusal.Unresolvable, MESSAGE.unresolvable(what, target));
  }
  if (!isLocalWindowsPath(real)) return refuse(WindowsLaunchRefusal.Path, MESSAGE.path(what, real));
  return { real };
}

/** The real run folder: directly in the real native-runs root, named for the run, and no link itself. */
async function realRunDir(
  request: WindowsGameLaunchRequest,
  deps: WindowsLaunchDeps,
): Promise<string | WindowsLaunchRefused> {
  if (!isLocalWindowsPath(deps.runsRoot))
    return refuse(WindowsLaunchRefusal.Path, MESSAGE.path("native-runs folder", deps.runsRoot));
  const root = await resolve(deps, "native-runs folder", deps.runsRoot);
  if ("ok" in root) return root;
  const parent = await resolve(deps, "run folder's parent", win.dirname(request.runDir));
  if ("ok" in parent) return parent;
  if (!samePath(parent.real, root.real))
    return refuse(WindowsLaunchRefusal.OutsideRunRoot, MESSAGE.outside("run folder"));
  const run = await resolve(deps, "run folder", request.runDir);
  if ("ok" in run) return run;
  if (!samePath(run.real, win.join(root.real, request.runId)))
    return refuse(WindowsLaunchRefusal.RunDir, MESSAGE.runDir);
  return run.real;
}

/** One of the run folder's own children by realpath: exactly `<real run>\<name>`, no link to anywhere else. */
async function ownFolder(
  deps: WindowsLaunchDeps,
  run: string,
  name: string,
  target: string,
): Promise<string | WindowsLaunchRefused> {
  const folder = await resolve(deps, name, target);
  if ("ok" in folder) return folder;
  if (!samePath(folder.real, win.join(run, name))) return refuse(WindowsLaunchRefusal.FolderLayout, MESSAGE.layout);
  return folder.real;
}

/** The run's three folders by realpath, each the one the run's layout names. */
async function realFolders(
  request: WindowsGameLaunchRequest,
  deps: WindowsLaunchDeps,
): Promise<RealFolders | WindowsLaunchRefused> {
  const run = await realRunDir(request, deps);
  if (typeof run !== "string") return run;
  const bundle = await ownFolder(deps, run, RunDirLayout.Bundle, request.bundle);
  if (typeof bundle !== "string") return bundle;
  const state = await ownFolder(deps, run, RunDirLayout.State, request.state);
  if (typeof state !== "string") return state;
  return { run, bundle, state };
}

/** The game must be the bundle's own file by that exact name: no link may lead it anywhere else. */
async function gameRefusal(
  request: WindowsGameLaunchRequest,
  bundle: string,
  deps: WindowsLaunchDeps,
): Promise<WindowsLaunchRefused | null> {
  const expected = win.join(bundle, request.exe);
  if (expected.length > PATH_MAX_UNITS) return refuse(WindowsLaunchRefusal.Path, MESSAGE.path("game", expected));
  const game = await resolve(deps, "game", expected);
  if ("ok" in game) return game;
  if (!samePath(game.real, expected)) return refuse(WindowsLaunchRefusal.OutsideRunRoot, MESSAGE.outside("game"));
  return null;
}

/** The launcher's own environment: `SystemRoot` from the host, then what the game gets (the launcher adds the pipe). */
function launcherEnv(
  request: WindowsGameLaunchRequest,
  state: string,
  hostEnv: WindowsLaunchDeps["hostEnv"],
): Record<string, string> {
  const systemRoot = hostEnv[SYSTEM_ROOT];
  return {
    ...(typeof systemRoot === "string" && systemRoot ? { [SYSTEM_ROOT]: systemRoot } : {}),
    [NativeEnv.Nonce]: request.nonce,
    [NativeEnv.StateDir]: state,
    ...request.env,
  };
}

/** The launcher's argv for a checked request and its real folders. */
function launcherArgs(request: WindowsGameLaunchRequest, folders: RealFolders): string[] {
  return [
    LauncherFlag.RunId,
    request.runId,
    LauncherFlag.Bundle,
    folders.bundle,
    LauncherFlag.State,
    folders.state,
    LauncherFlag.Exe,
    request.exe,
    LauncherFlag.Pipe,
    launcherPipeName(request.runId),
    LauncherFlag.MemoryBytes,
    String(request.memoryBytes ?? DEFAULT_GAME_MEMORY_BYTES),
    LauncherFlag.Desktop,
    request.desktop,
  ];
}

/**
 * Checks one run and writes the launcher's invocation. Lexical checks come first and touch
 * nothing; then the root, the run folder, its two folders and the game are resolved, and only
 * real paths reach argv. Nothing is created: {@link startWindowsGame} claims the run.
 */
export async function planWindowsGameLaunch(
  request: WindowsGameLaunchRequest,
  deps: WindowsLaunchDeps,
): Promise<WindowsLaunchPlan> {
  const lexical = lexicalRefusal(request);
  if (lexical) return lexical;
  const folders = await realFolders(request, deps);
  if ("ok" in folders) return folders;
  const game = await gameRefusal(request, folders.bundle, deps);
  if (game) return game;
  const launch: WindowsGameLaunch = {
    command: request.launcher,
    args: launcherArgs(request, folders),
    env: launcherEnv(request, folders.state, deps.hostEnv),
    stdio: LAUNCHER_STDIO,
    pipeName: launcherPipeName(request.runId),
    profileName: launcherProfileName(request.runId),
    runDir: folders.run,
  };
  return { ok: true, launch };
}

/** Claims the run folder for this one start: refused when a start claimed it before or the claim fails. */
async function claimRefusal<Child>(
  runDir: string,
  deps: WindowsStartDeps<Child>,
): Promise<WindowsLaunchRefused | null> {
  let claimed: boolean;
  try {
    claimed = await deps.claimRun(win.join(runDir, RunDirLayout.Claim));
  } catch {
    return refuse(WindowsLaunchRefusal.ClaimFailed, MESSAGE.claim);
  }
  return claimed ? null : refuse(WindowsLaunchRefusal.AlreadyStarted, MESSAGE.alreadyStarted);
}

/** Plans, claims the run folder (one start per run), then spawns the launcher hidden; a refusal spawns nothing. */
export async function startWindowsGame<Child>(
  request: WindowsGameLaunchRequest,
  deps: WindowsStartDeps<Child>,
): Promise<{ ok: true; launch: WindowsGameLaunch; child: Child } | WindowsLaunchRefused> {
  const plan = await planWindowsGameLaunch(request, deps);
  if (!plan.ok) return plan;
  const claim = await claimRefusal(plan.launch.runDir, deps);
  if (claim) return claim;
  const { command, args, env, stdio } = plan.launch;
  const child = deps.spawn(command, args, { env, stdio, windowsHide: true });
  return { ok: true, launch: plan.launch, child };
}

/**
 * The launcher's `--delete-profile` call for a run whose launcher could not clean up (it was
 * killed rather than stopped by closing fd 3). Deleting an absent profile succeeds.
 */
export function planProfileCleanup(
  launcher: string,
  runId: string,
): { ok: true; command: string; args: string[] } | WindowsLaunchRefused {
  if (!validRunId(runId)) return refuse(WindowsLaunchRefusal.RunId, MESSAGE.runId(runId));
  if (!validLauncher(launcher)) return refuse(WindowsLaunchRefusal.Launcher, MESSAGE.launcher(launcher));
  return { ok: true, command: launcher, args: [LauncherFlag.DeleteProfile, LauncherFlag.RunId, runId] };
}

const FAILURE_BY_CODE: ReadonlyMap<number, LauncherFailure> = new Map(
  Object.values(LauncherFailure).map((failure) => [LAUNCHER_EXIT_CODES[failure], failure]),
);

/**
 * Reads the launcher's exit code: one of its reserved codes, or the game's own status. Node gives
 * a Windows exit code unsigned; a signed 32-bit reading of the same code is read the same.
 */
export function classifyLauncherExit(code: number | null): LauncherOutcome {
  if (typeof code !== "number") return { kind: LauncherOutcomeKind.Game, code: null };
  const failure = FAILURE_BY_CODE.get(code >>> 0);
  if (failure) return { kind: LauncherOutcomeKind.Launcher, failure };
  return { kind: LauncherOutcomeKind.Game, code };
}

// ── the host's side: whether it has a box, its refusals and the launcher's exit ───────────────

/** What the host needs to know of the launcher's file: a regular file, not a link. */
export interface LauncherFileStat {
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

/**
 * Why a Windows host has no box for a `mode` run: no windowless build exists for Windows
 * (`no-headless-build`), or no launcher ships in this build's resources, as a regular file of its
 * own (`launcher-missing`). Null: the box runs.
 */
export function windowsGameBoxProblem(mode: NativeRunMode, launcher: LauncherFileStat | null): GameBoxProblem | null {
  if (mode !== NativeRunMode.Window) return GameBoxProblem.NoHeadlessBuild;
  const regular = launcher?.isFile() === true && !launcher.isSymbolicLink();
  return regular ? null : GameBoxProblem.LauncherMissing;
}

/**
 * A refused Windows start, or a launcher that failed on its own, as `spawnGame` and the run read it:
 * `no-game-box` with `box-refused`, keeping the launch refusal or the launcher failure.
 */
export class WindowsBoxError extends NativeError {
  /** The planner's refusal, or the launcher's own failure. */
  readonly reason: WindowsLaunchRefusal | LauncherFailure;

  constructor(reason: WindowsLaunchRefusal | LauncherFailure, message: string) {
    super(NativeRefusal.NoGameBox, message, null, GameBoxProblem.BoxRefused);
    this.name = "WindowsBoxError";
    this.reason = reason;
  }
}

/** The typed error for a launch refusal. */
export function launchRefusalError(refused: WindowsLaunchRefused): WindowsBoxError {
  return new WindowsBoxError(refused.refusal, refused.detail);
}

/** How a launcher's exit reads as the game's: the game's own status, or the box's refusal. */
export interface LauncherGameExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The launcher failed on its own: the run is refused, not crashed. */
  refused?: WindowsBoxError;
}

/**
 * Whether a launcher's exit may have left its run's AppContainer profile behind. The launcher
 * deletes the profile before it reports any status, so only an exit read as the game's own can:
 * a launcher killed by its handle (a signal), by pid (Windows reports exit 1 and no signal) or
 * crashed never ran its own deletion. Deleting an absent profile succeeds, so a real game exit
 * that also matches costs one more `--delete-profile`.
 */
export function launcherMayLeaveProfile(exit: { code: number | null; signal: NodeJS.Signals | null }): boolean {
  return classifyLauncherExit(exit.code).kind === LauncherOutcomeKind.Game;
}

/**
 * The launcher's exit read as the game's ({@link classifyLauncherExit}): `stopped` (the host closed
 * fd 3) is a clean exit, `game-reserved` stays a non-zero exit (a crash), any other launcher failure
 * is the box refusing, and every other code or a signal is the game's own.
 */
export function launcherGameExit(exit: { code: number | null; signal: NodeJS.Signals | null }): LauncherGameExit {
  const outcome = classifyLauncherExit(exit.code);
  if (outcome.kind === LauncherOutcomeKind.Game) return { code: exit.code, signal: exit.signal };
  if (outcome.failure === LauncherFailure.Stopped) return { code: 0, signal: null };
  if (outcome.failure === LauncherFailure.GameReserved) return { code: exit.code, signal: exit.signal };
  const refused = new WindowsBoxError(outcome.failure, MESSAGE.launcherFailed(outcome.failure));
  return { code: exit.code, signal: exit.signal, refused };
}
