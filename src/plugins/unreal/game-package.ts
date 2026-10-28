/**
 * Packaging an Unreal game as the app its players install: `package-game` runs Epic's
 * `BuildCookRun` (build, cook, stage and pak, Shipping) for this computer's system, a Mac
 * app on a Mac and a Windows program on Windows, into `unreal/Builds/<Mac|Windows>/`, where Publish
 * finds it (`main/core/native-builds.ts`). Unreal makes no app for another system, so each system's
 * app is packaged on a computer of its own. `package-status` says how the job stands and names the
 * app it left.
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
/** What each system packages for: UAT's platform, and the folder its stage makes under `Builds/`. */
const TARGETS: Partial<Record<NodeJS.Platform, { platform: string; folder: string }>> = {
  [MAC]: { platform: "Mac", folder: "Mac" },
  [WINDOWS]: { platform: "Win64", folder: "Windows" },
};
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

const MESSAGE = {
  NoGame: "This call needs a game: run it from a game's chat or build.",
  NoProject: "This game isn't linked to an Unreal project yet: make or link one first.",
  OutsideGame: "This game's Unreal project isn't inside its folder; Genex packages a project in unreal/.",
  NoEngine: "No supported Unreal is installed, so Genex can't package the game.",
  Unsupported: "Genex packages Unreal games on a Mac or on Windows.",
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

/** How RunUAT is started: the program, its arguments, and whether they are one prepared command line. */
export type UatLaunch = { file: string; args: string[]; verbatim: boolean };

/** What the tools need from the computer, the editor and the clock. */
export type GamePackageDeps = {
  platform: NodeJS.Platform;
  engine(): Promise<{ version: string; directory: string } | undefined>;
  project(storage: string, game: string): Promise<string | undefined>;
  xcode(engineDir: string | undefined): Promise<Pick<XcodeStatus, "state">>;
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
  system: { platform: string; folder: string };
};

/** A path inside the game as an agent reads it: relative, with `/`. */
const shownIn = (gameDir: string, file: string) => path.relative(gameDir, file).split(path.sep).join("/");

/** Only an error's code (ENOENT, EACCES): its message names an absolute path. */
function errorCode(failure: unknown): string {
  const code = (failure as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "unknown";
}

/**
 * BuildCookRun's arguments: Shipping for this computer's system, built, cooked, staged into paks
 * and staged under `stagingDir`, the cook run by the engine's own command-line editor (a project
 * with no editor target of its own has none to build).
 */
export function buildCookRunArgs(o: {
  projectFile: string;
  stagingDir: string;
  engineDir: string;
  platform: NodeJS.Platform;
}): string[] {
  const target = TARGETS[o.platform];
  if (!target) throw new Error(MESSAGE.Unsupported);
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
      env: uatEnv(),
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

/** The call's game and its linked project inside the game's folder, by real path, with the engine for this system. */
async function targetOf(deps: GamePackageDeps, storage: string, context: PluginContext): Promise<Target> {
  const game = context.project;
  if (!game || !context.directory) throw new Error(MESSAGE.NoGame);
  const system = TARGETS[deps.platform];
  if (!system) throw new Error(MESSAGE.Unsupported);
  const linked = await deps.project(storage, game);
  if (!linked) throw new Error(MESSAGE.NoProject);
  const [gameDir, projectFile] = await Promise.all([realpath(context.directory), realpath(linked)]);
  if (!isInside(gameDir, projectFile)) throw new Error(MESSAGE.OutsideGame);
  const engine = await deps.engine();
  if (!engine) throw new Error(MESSAGE.NoEngine);
  return { game, gameDir, projectFile, projectDir: path.dirname(projectFile), engineDir: engine.directory, system };
}

/** Refuses what the package can't run with: no Xcode on a Mac, a path cmd.exe can't carry on Windows. */
async function assertRunnable(deps: GamePackageDeps, target: Target): Promise<void> {
  if (deps.platform === WINDOWS) {
    if (!carried([target.engineDir, target.projectFile])) throw new Error(MESSAGE.Uncarried);
    return;
  }
  const xcode = await deps.xcode(target.engineDir);
  if (!canCompileCpp(xcode, deps.platform)) throw new Error(MESSAGE.NoXcode(xcode.state));
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

/** The app the stage holds: the Mac's one `.app`, or Windows' starter `.exe` at the package's root. */
async function appIn(dir: string, platform: NodeJS.Platform): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const wanted = platform === WINDOWS ? EXE_EXTENSION : APP_EXTENSION;
  const found = entries.find((entry) => {
    const plain = platform === WINDOWS ? entry.isFile() : entry.isDirectory();
    return plain && entry.name.toLowerCase().endsWith(wanted);
  });
  return found ? path.join(dir, found.name) : undefined;
}

/** The package job: BuildCookRun to its end, read as the app it left or the errors that stopped it. */
async function runPackage(
  deps: GamePackageDeps,
  target: Target,
  dirs: { staging: string; dir: string },
  signal: AbortSignal,
) {
  const args = buildCookRunArgs({
    projectFile: target.projectFile,
    stagingDir: dirs.staging,
    engineDir: target.engineDir,
    platform: deps.platform,
  });
  const launch = uatLaunch(target.engineDir, args, deps.platform);
  const started = deps.now();
  const outcome = await (deps.runUat ?? systemRunUat)(launch, { signal, timeoutMs: GAME_PACKAGE_TIMEOUT_MS }).catch(
    (failure: unknown) => {
      throw new PackageFailed(MESSAGE.NotStarted(errorCode(failure)), []);
    },
  );
  const seconds = Math.round((deps.now() - started) / SECOND_MS);
  if (signal.aborted) throw new Error(MESSAGE.Stopped);
  if (outcome.timedOut) throw new PackageFailed(MESSAGE.TimedOut, [], seconds);
  const app = outcome.code === 0 && SUCCEEDED.test(outcome.output) ? await appIn(dirs.dir, deps.platform) : undefined;
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

/** Whether a plain folder or file is at `file` (never a link). */
const isPlain = async (file: string) => {
  const info = await lstat(file).catch(() => null);
  return info !== null && !info.isSymbolicLink();
};

/** The two tools over one record per project: `package-game` starts or stops the job, `package-status` reads it. */
export function createGamePackageTools(deps: GamePackageDeps) {
  const records = new Map<string, GamePackageStatus>();
  const stops = new Map<string, AbortController>();
  deps.stopped?.addEventListener("abort", () => {
    for (const stop of stops.values()) stop.abort();
  });
  const systemName = () => TARGETS[deps.platform]?.folder ?? "";

  /** `package-game`: `stop` ends the running package; else saves Unreal's work and starts one unless one runs. */
  async function start(args: Args, context: PluginContext, storage: string) {
    const target = await targetOf(deps, storage, context);
    const key = target.projectFile;
    if (args.stop === true) {
      const stop = stops.get(key);
      stop?.abort();
      return { stopped: stop !== undefined };
    }
    if (stops.has(key)) return { started: true, system: target.system.folder };
    await assertRunnable(deps, target);
    const stop = new AbortController();
    if (deps.stopped?.aborted) stop.abort();
    // Reserved before the save: no second call starts beside this one meanwhile.
    stops.set(key, stop);
    const before = records.get(key);
    records.set(key, { state: GamePackageState.Running, system: target.system.folder });
    let dirs: { staging: string; dir: string };
    try {
      if (context.signal?.aborted) throw new Error(MESSAGE.Stopped);
      await saveFirst(deps, storage, target.game);
      dirs = await freshStage(target);
    } catch (failure) {
      stops.delete(key);
      if (before) records.set(key, before);
      else records.delete(key);
      throw failure;
    }
    void runPackage(deps, target, dirs, stop.signal)
      .then(
        (done): GamePackageStatus => ({ state: GamePackageState.Done, system: target.system.folder, ...done }),
        (failure: unknown): GamePackageStatus => {
          const state = stop.signal.aborted ? GamePackageState.Stopped : GamePackageState.Failed;
          const failed = failure instanceof PackageFailed ? failure : undefined;
          return {
            state,
            system: target.system.folder,
            line: errorMessage(failure),
            ...(failed?.errors.length ? { errors: failed.errors } : {}),
            ...(failed?.seconds === undefined ? {} : { seconds: failed.seconds }),
          };
        },
      )
      .then((record) => {
        if (stops.get(key) === stop) records.set(key, record);
      })
      .finally(() => {
        if (stops.get(key) === stop) stops.delete(key);
      });
    return { started: true, system: target.system.folder };
  }

  /** `package-status`: the job's record; after a restart, the app found in this system's build folder. */
  async function status(_args: Args, context: PluginContext, storage: string): Promise<GamePackageStatus> {
    const target = await targetOf(deps, storage, context);
    const record = records.get(target.projectFile);
    if (record) return record;
    const dir = path.join(target.projectDir, BUILDS_FOLDER, target.system.folder);
    const app = (await isPlain(dir)) ? await appIn(dir, deps.platform) : undefined;
    return {
      state: GamePackageState.Idle,
      system: systemName(),
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
