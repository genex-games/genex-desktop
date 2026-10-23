/**
 * Packaging an Unreal game as the app its players install: `package-game` runs Epic's
 * `BuildCookRun` (build, cook, stage and pak, Shipping) for a system this computer packages for, a
 * Mac app on a Mac, a Windows program on Windows, and on Windows a Linux program too, into
 * `unreal/Builds/<Mac|Windows|Linux>/`, where Publish finds it (`main/core/native-builds.ts`). Unreal
 * makes a Mac app only on a Mac and a Windows one only on Windows; Linux it cross-compiles from
 * Windows with Epic's Linux toolchain, which the person installs (Epic's installer sets
 * `LINUX_MULTIARCH_ROOT`, read from the registry so no restart is needed) and RunUAT is handed.
 * `package-status` says how the job stands and names the app it left.
 *
 * Like `plugin-test` and `open-editor`, the job runs outside ProcessSandbox: its cook is the
 * engine's own editor (`UnrealEditor-Cmd`) on the same project the person's editor opens, loading
 * the same game code, and it needs what UnrealBuildTool's Seatbelt profile denies (AutomationTool
 * rewrites its per-user config cache for every new project, the editor its derived data, Zen store
 * and shader workers). It starts with the small environment `plugin-test` uses, in a process group
 * of its own whose whole tree ends on Stop, past its deadline or when the backend stops. On Windows
 * RunUAT.bat runs through cmd.exe with every path whole inside quotes (`quotedScriptLine`); a game
 * whose path cmd.exe can't carry is refused before anything is touched.
 *
 * Before packaging, the person's open Unreal saves its work (play is ended first), so the app is
 * what they see; an Unreal that answers but can't save leaves nothing packaged. One package runs
 * per project; what reaches an agent names paths relative to the game, never the computer's.
 */
import { spawn } from "node:child_process";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { PluginContext } from "../../plugin-sdk/index.d.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { commandInterpreter, quotedScriptLine } from "../../substrate/command-launch.ts";
import { ensureDirBelow } from "../../substrate/fsx.ts";
import { isInside } from "../../substrate/paths.ts";
import { envValue } from "../../substrate/toolchain.ts";
import { killProcessTree } from "../../substrate/process-tree.ts";
import { editorCmdPath, type ProgramOutcome, programEnv } from "./automation-tests.ts";
import { LINUX_TOOLCHAIN_VARIABLE } from "./setup.ts";
import { canCompileCpp, outputCollector, pathScrubber } from "./ubt.ts";
import type { XcodeStatus } from "./xcode.ts";

/** The two tools, by their names after `unreal__`. */
export const GamePackageToolName = { PackageGame: "package-game", PackageStatus: "package-status" } as const;
export type GamePackageToolName = (typeof GamePackageToolName)[keyof typeof GamePackageToolName];

/** Where a game's package stands: wire values `package-status` answers. */
export const GamePackageState = {
  Idle: "idle",
  Running: "running",
  Done: "done",
  Failed: "failed",
  Stopped: "stopped",
} as const;
export type GamePackageState = (typeof GamePackageState)[keyof typeof GamePackageState];

/** `package-status`'s answer: the state, one line, the app it left (relative to the game) and its first errors. */
export type GamePackageStatus = {
  state: GamePackageState;
  /** The system the app is for: `Mac` or `Windows`. */
  system: string;
  line?: string;
  app?: string;
  errors?: string[];
  seconds?: number;
};

/** How long a package may take before its process tree is ended: a first cook compiles every shader. */
export const GAME_PACKAGE_TIMEOUT_MS = 120 * MINUTE_MS;
/** How long the person's Unreal has to save before the package starts. */
const SAVE_MS = 2 * MINUTE_MS;
/** The most error lines a failed package names, and how long each may be. */
const MAX_ERRORS = 12;
const ERROR_CHARS = 400;
/** How many of a failed package's last output lines it keeps when no line reads as an error. */
const LAST_LINES = 8;

const MAC = "darwin";
const WINDOWS = "win32";

/** The systems a package is for. Wire values: `package-game`'s and `package-status`'s `system`. */
export const PackageSystem = { Mac: "mac", Windows: "windows", Linux: "linux" } as const;
export type PackageSystem = (typeof PackageSystem)[keyof typeof PackageSystem];

/** Each system's package: UAT's platform, and the folder its stage makes under `Builds/`. */
const SYSTEMS: Readonly<Record<PackageSystem, { platform: string; folder: string }>> = {
  [PackageSystem.Mac]: { platform: "Mac", folder: "Mac" },
  [PackageSystem.Windows]: { platform: "Win64", folder: "Windows" },
  [PackageSystem.Linux]: { platform: "Linux", folder: "Linux" },
};
/** What each computer packages for, its own system first: Windows cross-compiles Linux with Epic's toolchain. */
const HOST_SYSTEMS: Partial<Record<NodeJS.Platform, readonly PackageSystem[]>> = {
  [MAC]: [PackageSystem.Mac],
  [WINDOWS]: [PackageSystem.Windows, PackageSystem.Linux],
};

/**
 * Epic's Linux cross-compile toolchain for each Unreal Genex makes games with, by `major.minor`
 * (Epic's "Linux development requirements" page); its installer is `<name>.exe` at
 * {@link LINUX_TOOLCHAIN_DOWNLOADS}.
 */
const LINUX_TOOLCHAINS: Readonly<Record<string, string>> = {
  "5.7": "v26_clang-20.1.8-rockylinux8",
  "5.8": "v26_clang-20.1.8-rockylinux8",
};
const LINUX_TOOLCHAIN_DOWNLOADS = "https://cdn.unrealengine.com/CrossToolchain_Linux/";
/** A trailing slash or backslash, as the installer writes the folder. */
const TRAILING_SEPARATORS = /[\\/]+$/;
/**
 * The staging folder in the project: Publish looks for apps here, and the game's history leaves it out.
 * UAT stages into it directly: its `-archive` copies a Mac app with no game content (only the program
 * UnrealBuildTool linked), while the staged app holds it all in `Contents/UE`.
 */
export const BUILDS_FOLDER = "Builds";
const BATCH_FILES = ["Engine", "Build", "BatchFiles"];
const SUCCEEDED = /\bBUILD SUCCESSFUL\b/;
/** A line UAT, UBT or the cook prints for an error. */
const ERROR_LINE = /(\berror\b|Error:|ERROR:|\(Error_)/;
/** Lines that say "error" and are not one: counts and summaries. */
const NOT_AN_ERROR = /\b0 error|Success - 0 error|warning\(s\)/i;
/** What cmd.exe's quoting can't carry in a path: a quote, `%`, `!` or a control character. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const UNCARRIED = /["%!\x00-\x1f]/;
/** A network share or a device path: never handed to cmd.exe. */
const NETWORK_PATH = /^(?:\\\\|\/\/)/;
/**
 * What Windows' RunUAT.bat and UnrealBuildTool read beyond the small environment: where programs and
 * shared data are (Visual Studio's installer, the shared derived data), the processor and the
 * account's names. None is a credential.
 */
const WINDOWS_UAT_ENV = [
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "SystemDrive",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
] as const;
const APP_EXTENSION = ".app";
const EXE_EXTENSION = ".exe";
const SH_EXTENSION = ".sh";

const MESSAGE = {
  NoGame: "This call needs a game: run it from a game's chat or build.",
  NoProject: "This game isn't linked to an Unreal project yet: make or link one first.",
  OutsideGame: "This game's Unreal project isn't inside its folder; Genex packages a project in unreal/.",
  NoEngine: "No supported Unreal is installed, so Genex can't package the game.",
  Unsupported: "Genex packages Unreal games on a Mac or on Windows.",
  CannotPackage: (asked: string) =>
    `This computer can't package ${asked ? `"${asked.slice(0, 24)}"` : "that"}: Genex packages a Mac app on a Mac, and Windows and Linux apps on Windows (system: "windows" or "linux").`,
  NoToolchainKnown: (version: string) =>
    `Genex doesn't know Epic's Linux toolchain for Unreal ${version} yet, so it can't package for Linux here.`,
  NeedsToolchain: (version: string, name: string, url: string) =>
    `Packaging for Linux on Windows needs Epic's free Linux cross-compile toolchain for Unreal ${version} (${name}). Give the user this link to download and run Epic's installer, then package again: ${url} (Genex finds it without a restart). Genex packaged nothing.`,
  Busy: (folder: string) =>
    `A ${folder} package of this game is running: wait for it (package-status), or stop it, then package again.`,
  NoXcode: (state: string) =>
    `Packaging an Unreal game on a Mac needs Xcode (Xcode: ${state}). Call unreal__show-steps so the user can install it, then package again.`,
  Uncarried:
    "Genex won't package here: the game's path holds a quote, % or !, which cmd.exe can't carry, or is on a network share. Move the game to a plain local folder.",
  NotAFolder: (where: string) => `${where} isn't a plain folder in the project, so Genex packaged nothing.`,
  NotSaved: (why: string) =>
    `Unreal couldn't save its open work (${why}), so Genex packaged nothing: the app would miss it. Save in Unreal, or quit it, then package again.`,
  Packaged: (system: string, seconds: number) => `The ${system} app was packaged in ${seconds} s.`,
  NoApp: (system: string) => `BuildCookRun said it succeeded, but no ${system} app is in the build folder.`,
  Failed: (count: number) =>
    count === 0 ? "BuildCookRun failed." : `BuildCookRun failed: ${count} error line${count === 1 ? "" : "s"}.`,
  TimedOut: `The package was stopped after ${GAME_PACKAGE_TIMEOUT_MS / MINUTE_MS} minutes.`,
  Stopped: "Stopped.",
  NotStarted: (code: string) => `AutomationTool couldn't start (${code}).`,
} as const;

/** Runs RunUAT to its end; ends its whole tree when `signal` aborts or the deadline passes. Tests stand in. */
export type RunUat = (
  launch: UatLaunch,
  options: { signal: AbortSignal; timeoutMs: number },
) => Promise<ProgramOutcome>;

/**
 * How RunUAT is started: the program, its arguments, whether they are one prepared command line, and
 * what its environment adds to the small one (a Linux package's toolchain).
 */
export type UatLaunch = { file: string; args: string[]; verbatim: boolean; env?: Record<string, string> };

/** What the tools need from the computer, the editor and the clock. */
export type GamePackageDeps = {
  platform: NodeJS.Platform;
  engine(): Promise<{ version: string; directory: string } | undefined>;
  project(storage: string, game: string): Promise<string | undefined>;
  xcode(engineDir: string | undefined): Promise<Pick<XcodeStatus, "state">>;
  /** Windows: `LINUX_MULTIARCH_ROOT` as Epic's installer set it, or undefined; none means no toolchain. */
  linuxToolchain?(): Promise<string | undefined>;
  /** Whether the game's own Unreal answers now. */
  editorAnswers(storage: string, game: string): Promise<boolean>;
  /** Saves the game's open Unreal (ending play first): whether all of it saved, and what didn't. */
  save(storage: string, game: string, timeoutMs: number): Promise<{ saved: boolean; dirty: string[] }>;
  now(): number;
  /** RunUAT's runner; the product's own unless a test stands in. */
  runUat?: RunUat;
  /** Aborts once the backend stops: a running package ends with it. */
  stopped?: AbortSignal;
};

type Args = Record<string, unknown>;
/** The call's game, its real folder, the linked project inside it by real path, and the engine. */
type Target = {
  game: string;
  gameDir: string;
  projectFile: string;
  projectDir: string;
  engineDir: string;
  engineVersion: string;
  system: { id: PackageSystem; platform: string; folder: string };
};

/** A path inside the game as an agent reads it: relative, with `/`. */
const shownIn = (gameDir: string, file: string) => path.relative(gameDir, file).split(path.sep).join("/");

/** Only an error's code (ENOENT, EACCES): its message names an absolute path. */
function errorCode(failure: unknown): string {
  const code = (failure as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "unknown";
}

/** The system `asked` names when this computer (`platform`) packages for it; its own system when none is asked. */
export function packageSystemOf(platform: NodeJS.Platform, asked?: unknown): PackageSystem {
  const systems = HOST_SYSTEMS[platform];
  if (!systems) throw new Error(MESSAGE.Unsupported);
  if (asked === undefined) return systems[0] ?? PackageSystem.Mac;
  const known = systems.find((system) => system === asked);
  if (!known) throw new Error(MESSAGE.CannotPackage(typeof asked === "string" ? asked : ""));
  return known;
}

/** Epic's Linux toolchain for Unreal `version` (`major.minor`): its name and its installer; null when unknown. */
export function linuxToolchainFor(version: string): { name: string; url: string } | null {
  if (!Object.hasOwn(LINUX_TOOLCHAINS, version)) return null;
  const name = LINUX_TOOLCHAINS[version] ?? "";
  return { name, url: `${LINUX_TOOLCHAIN_DOWNLOADS}${name}.exe` };
}

/**
 * BuildCookRun's arguments: Shipping for `system` (this computer's own when none), built, cooked,
 * staged into paks and staged under `stagingDir`, the cook run by this computer's own command-line
 * editor (a project with no editor target of its own has none to build).
 */
export function buildCookRunArgs(o: {
  projectFile: string;
  stagingDir: string;
  engineDir: string;
  platform: NodeJS.Platform;
  system?: PackageSystem;
}): string[] {
  const target = SYSTEMS[packageSystemOf(o.platform, o.system)];
  return [
    "BuildCookRun",
    `-project=${o.projectFile}`,
    `-platform=${target.platform}`,
    "-clientconfig=Shipping",
    "-build",
    "-cook",
    "-stage",
    "-pak",
    `-stagingdirectory=${o.stagingDir}`,
    `-unrealexe=${editorCmdPath(o.engineDir, o.platform)}`,
    "-nocompileeditor",
    "-nop4",
    "-utf8output",
    "-unattended",
  ];
}

/** How RunUAT starts on `platform`: RunUAT.sh itself on a Mac, RunUAT.bat through cmd.exe on Windows. */
export function uatLaunch(
  engineDir: string,
  args: readonly string[],
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
): UatLaunch {
  if (platform !== WINDOWS)
    return { file: path.posix.join(engineDir, ...BATCH_FILES, "RunUAT.sh"), args: [...args], verbatim: false };
  const line = quotedScriptLine(path.win32.join(engineDir, ...BATCH_FILES, "RunUAT.bat"), args);
  return { file: commandInterpreter(env), args: ["/d", "/v:off", "/s", "/c", `"${line}"`], verbatim: true };
}

/** RunUAT's environment: the small one `plugin-test` uses and, on Windows, the system's folders and names. */
export function uatEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const kept = programEnv(env, platform);
  if (platform !== WINDOWS) return kept;
  for (const name of WINDOWS_UAT_ENV) {
    const value = envValue(env, name);
    if (value !== undefined) kept[name] = value;
  }
  return kept;
}

/** The product's runner: no shell, the small environment, a process group of its own, output within the cap. */
export const systemRunUat: RunUat = (launch, { signal, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(launch.file, launch.args, {
      env: { ...uatEnv(), ...launch.env },
      detached: true,
      windowsHide: true,
      windowsVerbatimArguments: launch.verbatim,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = outputCollector();
    child.stdout?.on("data", output.add);
    child.stderr?.on("data", output.add);
    let timedOut = false;
    const stop = () => void killProcessTree(child.pid);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const settle = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    };
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    child.once("error", (error) => {
      settle();
      reject(error);
    });
    child.once("close", (code) => {
      settle();
      resolve({ code, output: output.text(), timedOut });
    });
  });

/** The lines of a failed package worth reading: its error lines, else its last lines, scrubbed of the computer's paths. */
export function packageErrors(output: string, scrub: (text: string) => string): string[] {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const errors = lines.filter((line) => ERROR_LINE.test(line) && !NOT_AN_ERROR.test(line));
  const chosen = errors.length > 0 ? [...new Set(errors)].slice(0, MAX_ERRORS) : lines.slice(-LAST_LINES);
  return chosen.map((line) => scrub(line).slice(0, ERROR_CHARS));
}

/** Whether cmd.exe can carry every path RunUAT.bat is handed. */
const carried = (paths: readonly string[]) => paths.every((p) => !UNCARRIED.test(p) && !NETWORK_PATH.test(p));

/**
 * The call's game and its linked project inside the game's folder, by real path, with the engine,
 * for the system `asked` (this computer's own when none).
 */
async function targetOf(
  deps: GamePackageDeps,
  storage: string,
  context: PluginContext,
  asked: unknown,
): Promise<Target> {
  const game = context.project;
  if (!game || !context.directory) throw new Error(MESSAGE.NoGame);
  const id = packageSystemOf(deps.platform, asked);
  const system = { id, ...SYSTEMS[id] };
  const linked = await deps.project(storage, game);
  if (!linked) throw new Error(MESSAGE.NoProject);
  const [gameDir, projectFile] = await Promise.all([realpath(context.directory), realpath(linked)]);
  if (!isInside(gameDir, projectFile)) throw new Error(MESSAGE.OutsideGame);
  const engine = await deps.engine();
  if (!engine) throw new Error(MESSAGE.NoEngine);
  return {
    game,
    gameDir,
    projectFile,
    projectDir: path.dirname(projectFile),
    engineDir: engine.directory,
    engineVersion: engine.version,
    system,
  };
}

/**
 * Refuses what the package can't run with: no Xcode on a Mac, a path cmd.exe can't carry on Windows,
 * a Linux package without Epic's toolchain for this Unreal. Answers what RunUAT's environment adds.
 */
async function assertRunnable(deps: GamePackageDeps, target: Target): Promise<Record<string, string>> {
  if (deps.platform === WINDOWS) {
    if (!carried([target.engineDir, target.projectFile])) throw new Error(MESSAGE.Uncarried);
    if (target.system.id !== PackageSystem.Linux) return {};
    return { [LINUX_TOOLCHAIN_VARIABLE]: await linuxToolchainRoot(deps, target.engineVersion) };
  }
  const xcode = await deps.xcode(target.engineDir);
  if (!canCompileCpp(xcode, deps.platform)) throw new Error(MESSAGE.NoXcode(xcode.state));
  return {};
}

/**
 * The folder of Epic's Linux toolchain for Unreal `version`, as Epic's installer set it: a plain local
 * folder (never a link, a network share, or a path cmd.exe can't carry) named for that version's
 * toolchain. Anything else is refused with the installer's link for the agent to give the person.
 */
async function linuxToolchainRoot(deps: GamePackageDeps, version: string): Promise<string> {
  const wanted = linuxToolchainFor(version);
  if (!wanted) throw new Error(MESSAGE.NoToolchainKnown(version));
  const set = (await deps.linuxToolchain?.().catch(() => undefined)) ?? "";
  const folder = set.replace(TRAILING_SEPARATORS, "");
  const named = path.win32.basename(folder) === wanted.name || path.basename(folder) === wanted.name;
  const plain = path.isAbsolute(folder) && carried([folder]) && named;
  const info = plain ? await lstat(folder).catch(() => null) : null;
  if (!info?.isDirectory() || info.isSymbolicLink())
    throw new Error(MESSAGE.NeedsToolchain(version, wanted.name, wanted.url));
  return set;
}

/** Saves the person's open Unreal first; one that doesn't answer has nothing unsaved to lose. */
async function saveFirst(deps: GamePackageDeps, storage: string, game: string): Promise<void> {
  if (!(await deps.editorAnswers(storage, game).catch(() => false))) return;
  const saved = await deps.save(storage, game, SAVE_MS).catch((failure: unknown) => {
    throw new Error(MESSAGE.NotSaved(errorMessage(failure)));
  });
  if (!saved.saved || saved.dirty.length > 0) throw new Error(MESSAGE.NotSaved(saved.dirty.join(", ") || "unsaved"));
}

/**
 * This system's staging folder made empty (`Builds/<Mac|Windows>`), every folder on the way a real
 * folder of the project's (never a link), and the folder UAT stages into, by real path.
 */
async function freshStage(target: Target): Promise<{ staging: string; dir: string }> {
  const refused = () => {
    throw new Error(MESSAGE.NotAFolder(shownIn(target.gameDir, path.join(target.projectDir, BUILDS_FOLDER))));
  };
  const staging = await ensureDirBelow(target.projectDir, [BUILDS_FOLDER]).catch(refused);
  // Checked again right before the removal: a folder swapped for a link since is never emptied.
  if ((await ensureDirBelow(target.projectDir, [BUILDS_FOLDER]).catch(refused)) !== staging) refused();
  await rm(path.join(staging, target.system.folder), { recursive: true, force: true });
  const dir = await ensureDirBelow(staging, [target.system.folder]).catch(refused);
  return { staging, dir };
}

/** What names a system's app at its package's root: the Mac's `.app`, Windows' starter `.exe`, Linux's starter `.sh`. */
const APP_AT_ROOT: Readonly<Record<PackageSystem, { extension: string; folder: boolean }>> = {
  [PackageSystem.Mac]: { extension: APP_EXTENSION, folder: true },
  [PackageSystem.Windows]: { extension: EXE_EXTENSION, folder: false },
  [PackageSystem.Linux]: { extension: SH_EXTENSION, folder: false },
};

/** The app the stage holds for `system`: the one entry at its package's root that starts the game. */
async function appIn(dir: string, system: PackageSystem): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const wanted = APP_AT_ROOT[system];
  const found = entries.find((entry) => {
    const plain = wanted.folder ? entry.isDirectory() : entry.isFile();
    return plain && entry.name.toLowerCase().endsWith(wanted.extension);
  });
  return found ? path.join(dir, found.name) : undefined;
}

/** The package job: BuildCookRun to its end, read as the app it left or the errors that stopped it. */
async function runPackage(
  deps: GamePackageDeps,
  target: Target,
  dirs: { staging: string; dir: string },
  run: { signal: AbortSignal; env: Record<string, string> },
) {
  const { signal } = run;
  const args = buildCookRunArgs({
    projectFile: target.projectFile,
    stagingDir: dirs.staging,
    engineDir: target.engineDir,
    platform: deps.platform,
    system: target.system.id,
  });
  const launch = {
    ...uatLaunch(target.engineDir, args, deps.platform),
    ...(Object.keys(run.env).length > 0 ? { env: run.env } : {}),
  };
  const started = deps.now();
  const outcome = await (deps.runUat ?? systemRunUat)(launch, { signal, timeoutMs: GAME_PACKAGE_TIMEOUT_MS }).catch(
    (failure: unknown) => {
      throw new PackageFailed(MESSAGE.NotStarted(errorCode(failure)), []);
    },
  );
  const seconds = Math.round((deps.now() - started) / SECOND_MS);
  if (signal.aborted) throw new Error(MESSAGE.Stopped);
  if (outcome.timedOut) throw new PackageFailed(MESSAGE.TimedOut, [], seconds);
  const app =
    outcome.code === 0 && SUCCEEDED.test(outcome.output) ? await appIn(dirs.dir, target.system.id) : undefined;
  if (app) return { line: MESSAGE.Packaged(target.system.folder, seconds), app: shownIn(target.gameDir, app), seconds };
  const scrub = await pathScrubber(target.projectDir, target.engineDir);
  const errors = packageErrors(outcome.output, scrub);
  const succeeded = outcome.code === 0 && SUCCEEDED.test(outcome.output);
  const line = succeeded ? MESSAGE.NoApp(target.system.folder) : MESSAGE.Failed(errors.length);
  throw new PackageFailed(line, errors, seconds);
}

/** A package that failed with lines to read. */
class PackageFailed extends Error {
  readonly errors: string[];
  readonly seconds: number | undefined;
  constructor(message: string, errors: string[], seconds?: number) {
    super(message);
    this.name = "PackageFailed";
    this.errors = errors;
    this.seconds = seconds;
  }
}

/** A package that ended without its app, as `package-status` answers it: stopped, or failed with its lines. */
function failedRecord(target: Target, failure: unknown, stopped: boolean): GamePackageStatus {
  const failed = failure instanceof PackageFailed ? failure : undefined;
  return {
    state: stopped ? GamePackageState.Stopped : GamePackageState.Failed,
    system: target.system.folder,
    line: errorMessage(failure),
    ...(failed?.errors.length ? { errors: failed.errors } : {}),
    ...(failed?.seconds === undefined ? {} : { seconds: failed.seconds }),
  };
}

/** Whether a plain folder or file is at `file` (never a link). */
const isPlain = async (file: string) => {
  const info = await lstat(file).catch(() => null);
  return info !== null && !info.isSymbolicLink();
};

/** The two tools over one record per project: `package-game` starts or stops the job, `package-status` reads it. */
export function createGamePackageTools(deps: GamePackageDeps) {
  /** Each project's last package of each system, keyed by {@link recordKey}. */
  const records = new Map<string, GamePackageStatus>();
  /** The package running in each project, at most one, and the system it is for. */
  const stops = new Map<string, { stop: AbortController; folder: string }>();
  deps.stopped?.addEventListener("abort", () => {
    for (const running of stops.values()) running.stop.abort();
  });
  const recordKey = (target: Target) => `${target.projectFile}\n${target.system.id}`;

  /** `package-game` with `stop`: ends the game's running package, whatever system it is for. */
  async function stopRunning(context: PluginContext, storage: string) {
    const running = stops.get((await targetOf(deps, storage, context, undefined)).projectFile);
    running?.stop.abort();
    return { stopped: running !== undefined };
  }

  /**
   * `package-game`: `stop` ends the running package; else saves Unreal's work and starts one for
   * `system` (this computer's own when none) unless one runs.
   */
  async function start(args: Args, context: PluginContext, storage: string) {
    if (args.stop === true) return stopRunning(context, storage);
    const target = await targetOf(deps, storage, context, args.system);
    const key = target.projectFile;
    const running = stops.get(key);
    if (running?.folder === target.system.folder) return { started: true, system: target.system.folder };
    if (running) throw new Error(MESSAGE.Busy(running.folder));
    const env = await assertRunnable(deps, target);
    const stop = new AbortController();
    if (deps.stopped?.aborted) stop.abort();
    // Reserved before the save: no second call starts beside this one meanwhile.
    stops.set(key, { stop, folder: target.system.folder });
    const dirs = await prepare(target, context, storage);
    follow(target, dirs, { stop, env });
    return { started: true, system: target.system.folder };
  }

  /**
   * Marks `target`'s package running, saves Unreal's work and empties its staging folder; on a failure
   * gives the game back its earlier record and its slot, then throws.
   */
  async function prepare(target: Target, context: PluginContext, storage: string) {
    const record = recordKey(target);
    const before = records.get(record);
    records.set(record, { state: GamePackageState.Running, system: target.system.folder });
    try {
      if (context.signal?.aborted) throw new Error(MESSAGE.Stopped);
      await saveFirst(deps, storage, target.game);
      return await freshStage(target);
    } catch (failure) {
      stops.delete(target.projectFile);
      if (before) records.set(record, before);
      else records.delete(record);
      throw failure;
    }
  }

  /** Runs the package in the background, keeping how it ended while it is still this game's package. */
  function follow(
    target: Target,
    dirs: { staging: string; dir: string },
    run: { stop: AbortController; env: Record<string, string> },
  ): void {
    const key = target.projectFile;
    const ours = () => stops.get(key)?.stop === run.stop;
    void runPackage(deps, target, dirs, { signal: run.stop.signal, env: run.env })
      .then(
        (done): GamePackageStatus => ({ state: GamePackageState.Done, system: target.system.folder, ...done }),
        (failure: unknown) => failedRecord(target, failure, run.stop.signal.aborted),
      )
      .then((ended) => {
        if (ours()) records.set(recordKey(target), ended);
      })
      .finally(() => {
        if (ours()) stops.delete(key);
      });
  }

  /**
   * `package-status`: the job's record for `system` (this computer's own when none); after a restart,
   * the app found in that system's build folder.
   */
  async function status(args: Args, context: PluginContext, storage: string): Promise<GamePackageStatus> {
    const target = await targetOf(deps, storage, context, args.system);
    const record = records.get(recordKey(target));
    if (record) return record;
    const dir = path.join(target.projectDir, BUILDS_FOLDER, target.system.folder);
    const app = (await isPlain(dir)) ? await appIn(dir, target.system.id) : undefined;
    return {
      state: GamePackageState.Idle,
      system: target.system.folder,
      ...(app ? { app: shownIn(target.gameDir, app) } : {}),
    };
  }

  return {
    handlers: {
      [GamePackageToolName.PackageGame]: start,
      [GamePackageToolName.PackageStatus]: status,
    } satisfies Record<GamePackageToolName, (args: Args, context: PluginContext, storage: string) => Promise<unknown>>,
  };
}
