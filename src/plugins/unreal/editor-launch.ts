/**
 * Open, quit and get Unreal. Open in Unreal works like double-clicking the project: the user's own
 * editor, from the installed engine the project names. Quit is Unreal's normal quit, which
 * asks about unsaved work, never a forced one. Get Unreal opens Epic's launcher, else Epic's
 * download page, a constant the panel can't change. Each is a command and an argument array handed
 * to the backend's opener, never a shell string, so tests read the exact command and nothing runs.
 * What Genex opened and when is kept in the plugin's storage, so the panel and the toolbar can say
 * "Starting" with the time since. Right after Unreal quit, its sockets still hold the project's
 * port for up to about 30 s, and an editor opened then can't start Epic's server there, so Open
 * waits for the port first. On a Mac, a project whose game module was hot-reloaded is built with
 * UnrealBuildTool before it opens, so Unreal never loads code the Source no longer matches. The
 * user's own Open of the open game's own project also brings an older Genex editor helper up to
 * date, after a snapshot of that game.
 */
import { execFile, spawn } from "node:child_process";
import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { atomicWriteJson, isJsonObject, readRegularFile } from "../../substrate/fsx.ts";
import { hotLibraryLoaded, projectModule } from "./cpp-module.ts";
import { inProjectBlock, portFree, rememberChoice, SetupStorage } from "./editor-port.ts";
import { pollUntil } from "./editor-queue.ts";
import { buildErrors } from "./editor-restart.ts";
import { isProjectPath } from "./project-file.ts";
import {
  type Engine,
  EngineMatch,
  engineMatch,
  findEngines,
  type HelperUpdate,
  helperNeedsInstall,
  inspectProject,
  installEngineText,
  type ProjectState,
  realProjectFile,
  type SetupEnv,
  type SetupOptions,
  updateHelper,
  windowsFolder,
  windowsSystemTool,
} from "./setup.ts";
import { XcodeStep } from "./engine-steps.ts";
import { type CompileOptions, type CompileResult, canCompileCpp, compileEditor } from "./ubt.ts";

/** The editor app's bundle id, from UE 5.8.3's `UnrealEditor.app/Contents/Info.plist`. */
export const EDITOR_BUNDLE_ID = "com.epicgames.UnrealEditor";
/** Epic's download page, opened when the launcher isn't installed; never taken from the panel. */
export const UNREAL_DOWNLOAD_URL = "https://www.unrealengine.com/download";
/**
 * How long Genex's own launch counts as starting when the project's log can't tell: a first start
 * prepares shaders for a few minutes, longer for big projects. The log, when there is one, decides.
 */
export const STARTING_WINDOW_MS = 20 * MINUTE_MS;
/** Right after a launch the editor's process may not be listed yet. */
const LAUNCH_GRACE_MS = 15 * SECOND_MS;
/** `open`, `osascript` and `taskkill` return once they have asked; they never wait on Unreal. */
const COMMAND_TIMEOUT_MS = 15 * SECOND_MS;
/** A Starting record is a few dozen bytes. */
const STARTING_MAX_BYTES = 4 * 1024;
/**
 * How long Open waits for the project's port to be free before it opens Unreal anyway, and how
 * often it asks: a quit editor's sockets linger on the port for about 30 s on a Mac.
 */
const PORT_FREE_WAIT_MS = 45 * SECOND_MS;
const PORT_FREE_POLL_MS = SECOND_MS;
const MAC_OPEN = "/usr/bin/open";
const MAC_OSASCRIPT = "/usr/bin/osascript";
const WINDOWS_EDITOR = "UnrealEditor.exe";
const LAUNCHER_APP = "Epic Games Launcher.app";
const LAUNCHER_FOLDERS = ["Win64", "Win32"] as const;
/** The only platform Genex builds a game's C++ module on before opening it (Xcode). */
const MAC: NodeJS.Platform = "darwin";

/** One program to start: what it is, its arguments, and whether it outlives the call (a GUI app on Windows). */
export type Launch = { command: string; args: string[]; detached: boolean };
/** Starts a launch: the product's opener runs it with execFile or a detached spawn; tests record it. */
export type Opener = (launch: Launch) => Promise<void>;
/** How Open waits for a project's port: whether Unreal could listen on it now, and a pause between asks. */
export type PortWait = { free: (port: number) => Promise<boolean>; sleep: (ms: number) => Promise<void> };
/** What launching needs: the opener, where Epic's launcher would be installed, the clock and the port wait (none: open at once). */
export type LaunchEnv = {
  open: Opener;
  /** `/Applications` on a Mac, Program Files (x86) on Windows. */
  applications: string;
  now: () => number;
  portWait?: PortWait;
  /** Builds a project's editor target before it opens; UnrealBuildTool's own unless a test stands in. */
  build?: (options: CompileOptions) => Promise<CompileResult>;
};
/** When Genex last opened which project in Unreal, and its port when that was still held after the wait. */
export type Starting = { project: string; at: number; busyPort?: number };
/** One launch action: setup's computer and storage, and the launch environment. */
export type LaunchOptions = SetupOptions & { launch: LaunchEnv };
/**
 * What Open in Unreal did: the project's real `.uproject`, whether it started an editor, since when
 * one starts, and how it updated the project's Genex editor helper first, when it did.
 */
export type OpenResult = { project: string; launched: boolean; at: number | null; helper?: HelperUpdate };
/**
 * A user's own Open of the open game's own project brings an older Genex editor helper up to date:
 * `snapshot` keeps the game first (a game snapshot), and the update runs only once it has. Another
 * project's Open and the Loop's restarts never pass one.
 */
export type HelperUpdateOnOpen = { snapshot: () => Promise<unknown> };
/** What an Open may do besides opening: update the helper ({@link HelperUpdateOnOpen}). */
export type OpenRequest = { helperUpdate?: HelperUpdateOnOpen };

/** Why Open in Unreal refused; the message says it in words the panel shows as they are. */
export const LaunchErrorCode = {
  NoEngine: "no-engine",
  EngineMissing: "engine-missing",
  CustomEngine: "custom-engine",
  EditorMissing: "editor-missing",
  SeveralEditors: "several-editors",
  NotQuit: "not-quit",
  NeedsSetup: "needs-setup",
  NotBuilt: "not-built",
} as const;
export type LaunchErrorCode = (typeof LaunchErrorCode)[keyof typeof LaunchErrorCode];

/** What Get Unreal opened: Epic's launcher, or Epic's download page. */
export const UnrealSource = { Launcher: "launcher", Download: "download" } as const;
export type UnrealSource = (typeof UnrealSource)[keyof typeof UnrealSource];

const MESSAGE = {
  [LaunchErrorCode.NoEngine]: installEngineText(),
  [LaunchErrorCode.EngineMissing]: (version: string) =>
    `This project needs Unreal ${version}, which isn't installed. Install it from the Epic Games Launcher, or open the project in Unreal to pick another version.`,
  [LaunchErrorCode.CustomEngine]:
    "This project uses an Unreal Engine built from source, so Genex can't tell which editor opens it. Open it from that engine.",
  [LaunchErrorCode.EditorMissing]: (version: string) =>
    `Unreal ${version}'s editor isn't where Epic's launcher says. Verify the install in the Epic Games Launcher.`,
  [LaunchErrorCode.SeveralEditors]: "Two Unreal editors are open. Quit the one you want from its own window.",
  [LaunchErrorCode.NotQuit]: "Unreal didn't close. Quit it from its own window.",
  [LaunchErrorCode.NeedsSetup]: (made: string, target: string) =>
    `This project was made with Unreal ${made}. Set it up first; that switches it to Unreal ${target}.`,
  [LaunchErrorCode.NotBuilt]: (why: string) =>
    `This game's C++ was last hot-reloaded in Unreal, so Genex builds it before opening Unreal, and the build failed: ${why}`,
  CannotBuild: (xcode: string) =>
    `This game's C++ was last hot-reloaded in Unreal, so Genex builds it before opening Unreal, but this Mac can't build C++ (Xcode: ${xcode}). Finish Xcode's setup, or open the project from Unreal.`,
} as const;
/** taskkill's exit code when no editor was there to close: already gone, not a failure. */
const TASKKILL_NOT_FOUND = 128;

/** A refusal with a code for the panel and a message it shows as it is. */
export class LaunchError extends Error {
  readonly code: LaunchErrorCode;
  constructor(code: LaunchErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const run = promisify(execFile);
const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? path.win32 : path.posix);
const quoted = (text: string) => `"${text}"`;

/** The engine's editor: the Mac app bundle, or the Windows executable. */
export function editorApp(engine: Engine, platform: NodeJS.Platform): string {
  const binaries = pathFor(platform).join(engine.directory, "Engine", "Binaries");
  return platform === "win32"
    ? path.win32.join(binaries, "Win64", WINDOWS_EDITOR)
    : path.posix.join(binaries, "Mac", "UnrealEditor.app");
}

/**
 * Opens a project in the engine's editor. A Mac opens a new editor (`open -n`; without it a
 * running Unreal would only come forward and ignore the project). Windows starts the executable
 * detached, the project as its one argument.
 */
export function openEditorLaunch(engine: Engine, file: string, platform: NodeJS.Platform): Launch {
  const app = editorApp(engine, platform);
  if (platform === "win32") return { command: app, args: [file], detached: true };
  return { command: MAC_OPEN, args: ["-n", "-a", app, "--args", file], detached: false };
}

/** An AppleScript string literal of `text`. */
const appleScriptString = (text: string) => `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
 * Unreal's normal quit: the quit Apple event, which Unreal handles like Quit in its Dock menu, so
 * it asks about unsaved work. AppleScript sends it by the editor's bundle id, only while the
 * editor runs, and doesn't wait for the answer. The `tell` is compiled only then (`run script`):
 * compiling a `tell` to an app that isn't running starts that app. On Windows, taskkill without
 * /F, by its full path, asks UnrealEditor.exe to close the same way.
 */
export function quitEditorLaunch(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): Launch {
  if (platform === "win32")
    return {
      command: windowsSystemTool(env, "System32", "taskkill.exe"),
      args: ["/IM", WINDOWS_EDITOR],
      detached: false,
    };
  const app = `application id ${quoted(EDITOR_BUNDLE_ID)}`;
  const quit = ["ignoring application responses", `tell ${app} to quit`, "end ignoring"].join("\n");
  const script = [`if ${app} is running then`, `run script ${appleScriptString(quit)}`, "end if"];
  return { command: MAC_OSASCRIPT, args: script.flatMap((line) => ["-e", line]), detached: false };
}

/** Where Epic's launcher is installed, in the order Genex looks. */
export function launcherPaths(platform: NodeJS.Platform, applications: string): string[] {
  if (platform !== "win32") return [path.posix.join(applications, LAUNCHER_APP)];
  const binaries = path.win32.join(applications, "Epic Games", "Launcher", "Portal", "Binaries");
  return LAUNCHER_FOLDERS.map((folder) => path.win32.join(binaries, folder, "EpicGamesLauncher.exe"));
}

/** Opens Epic's launcher when it was found, else Epic's download page in the user's browser. */
export function getUnrealLaunch(
  platform: NodeJS.Platform,
  launcher: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Launch {
  if (platform === "win32")
    return launcher
      ? { command: launcher, args: [], detached: true }
      : { command: windowsSystemTool(env, "explorer.exe"), args: [UNREAL_DOWNLOAD_URL], detached: true };
  return { command: MAC_OPEN, args: launcher ? ["-a", launcher] : [UNREAL_DOWNLOAD_URL], detached: false };
}

/** Xcode's page in the Mac App Store. */
const XCODE_APP_STORE_URL = "macappstore://apps.apple.com/app/xcode/id497799835";

/**
 * The steps card's Xcode buttons: Xcode's App Store page, or the Xcode app the probes found
 * (`app`, never a path from the caller) so it can finish its own setup. Without an app, Open falls
 * back to the App Store page.
 */
export function getXcodeLaunch(step: XcodeStep, app: string | null): Launch {
  const opensApp = step === XcodeStep.Open && app !== null;
  return { command: MAC_OPEN, args: opensApp ? ["-a", app] : [XCODE_APP_STORE_URL], detached: false };
}

/** Whether `target` is itself an app bundle (Mac) or a program (Windows), not a link to one. */
async function isInstalledApp(target: string, platform: NodeJS.Platform): Promise<boolean> {
  const info = await lstat(target).catch(() => null);
  return Boolean(platform === "win32" ? info?.isFile() : info?.isDirectory());
}

/** Epic's launcher where it is installed, or undefined. */
export async function findLauncher(platform: NodeJS.Platform, applications: string): Promise<string | undefined> {
  for (const candidate of launcherPaths(platform, applications))
    if (await isInstalledApp(candidate, platform)) return candidate;
  return undefined;
}

/**
 * The installed engine that opens a project: the one its `EngineAssociation` names, or for a
 * project made with an older engine the newest supported one, which offers to convert it.
 */
export async function engineFor(association: string, engines: Engine[], platform: NodeJS.Platform): Promise<Engine> {
  const newest = engines.find((e) => e.supported);
  if (!newest) throw new LaunchError(LaunchErrorCode.NoEngine, MESSAGE[LaunchErrorCode.NoEngine]);
  const match = engineMatch(association, engines);
  // Unreal opens a project named on its command line in place, without asking to convert it; only setup switches it.
  if (match === EngineMatch.TooOld)
    throw new LaunchError(LaunchErrorCode.NeedsSetup, MESSAGE[LaunchErrorCode.NeedsSetup](association, newest.version));
  if (match === EngineMatch.Custom)
    throw new LaunchError(LaunchErrorCode.CustomEngine, MESSAGE[LaunchErrorCode.CustomEngine]);
  if (match === EngineMatch.Missing)
    throw new LaunchError(LaunchErrorCode.EngineMissing, MESSAGE[LaunchErrorCode.EngineMissing](association));
  const named = engines.find((e) => e.version === association && e.supported);
  const engine = match === EngineMatch.Installed && named ? named : newest;
  if (!(await isInstalledApp(editorApp(engine, platform), platform)))
    throw new LaunchError(LaunchErrorCode.EditorMissing, MESSAGE[LaunchErrorCode.EditorMissing](engine.build));
  return engine;
}

/** A started program the opener lets go of. */
type Spawned = { once: (event: "error" | "spawn", listener: (error?: Error) => void) => unknown; unref: () => void };
/** How the opener starts programs; tests record instead. */
export type OpenerRunners = {
  execFile: (
    file: string,
    args: readonly string[],
    options: { timeout: number; windowsHide: boolean },
  ) => Promise<unknown>;
  spawn: (
    file: string,
    args: readonly string[],
    options: { detached: true; stdio: "ignore"; windowsHide?: boolean },
  ) => Spawned;
};
const SYSTEM_RUNNERS: OpenerRunners = {
  execFile: run,
  spawn: (file, args, options) => spawn(file, [...args], options),
};

/**
 * The product's opener: execFile for a command that returns, its console hidden (the backend has
 * none, so Windows would give taskkill a window of its own), and a detached spawn for an app that
 * stays, never hidden: Unreal, Epic's launcher and Explorer would open their windows hidden too.
 */
export async function systemOpener(launch: Launch, runners: OpenerRunners = SYSTEM_RUNNERS): Promise<void> {
  if (!launch.detached) {
    await runners.execFile(launch.command, launch.args, { timeout: COMMAND_TIMEOUT_MS, windowsHide: true });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = runners.spawn(launch.command, launch.args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** This computer's opener, launcher folder and clock. */
export function systemLaunchEnv(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): LaunchEnv {
  const applications =
    platform === "win32" ? windowsFolder(env, "ProgramFiles(x86)", "Program Files (x86)") : "/Applications";
  return {
    open: (launch) => systemOpener(launch),
    applications,
    now: () => Date.now(),
    portWait: { free: (port) => portFree(port, platform), sleep: (ms) => sleep(ms) },
  };
}

const startingFile = (storage: string) => path.join(storage, SetupStorage.Starting);

/** Whether a stored value is a Starting record: a `.uproject` and a whole time in ms. */
const isStarting = (value: unknown): value is Starting =>
  isJsonObject(value) && isProjectPath(value.project) && Number.isSafeInteger(value.at);

/**
 * The Starting record, or undefined when there is none or it can't be trusted (a link, not JSON,
 * odd fields); a held port is kept only when it is one of Genex's.
 */
export async function readStarting(storage: string): Promise<Starting | undefined> {
  try {
    const value: unknown = JSON.parse((await readRegularFile(startingFile(storage), STARTING_MAX_BYTES)).toString());
    if (!isStarting(value)) return undefined;
    const busy = inProjectBlock(value.busyPort) ? { busyPort: value.busyPort } : {};
    return { project: value.project, at: value.at, ...busy };
  } catch {
    return undefined;
  }
}

/** Keeps when Genex opened which project. */
export async function recordStarting(storage: string, starting: Starting): Promise<void> {
  await atomicWriteJson(startingFile(storage), starting);
}

/** Forgets the Starting record: Unreal is quitting. */
export async function clearStarting(storage: string): Promise<void> {
  await rm(startingFile(storage), { force: true });
}

/**
 * Forgets the Starting record once its project has answered: "Starting" means opened by Genex and
 * not answering yet, so an editor that later switches project or stops answering is not starting.
 */
export async function retireStarting(storage: string, project: string): Promise<void> {
  if ((await readStarting(storage))?.project === project) await clearStarting(storage);
}

/** How long ago a Starting record was made, or undefined when it is from the future. */
function startingAge(starting: Starting | undefined, now: number): number | undefined {
  const age = starting ? now - starting.at : undefined;
  return age !== undefined && age >= 0 ? age : undefined;
}

/** Whether Genex launched this record's project so lately that its editor may not be listed yet. */
export function justLaunched(starting: Starting | undefined, now: number): boolean {
  const age = startingAge(starting, now);
  return age !== undefined && age < LAUNCH_GRACE_MS;
}

/**
 * Whether Unreal is still starting the project Genex opened: within the first seconds of the
 * launch (its process may not be listed yet), or while an editor runs and the window lasts.
 */
export function stillStarting(starting: Starting | undefined, running: boolean, now: number): boolean {
  const age = startingAge(starting, now);
  if (age === undefined) return false;
  const launching = age < LAUNCH_GRACE_MS;
  const preparing = running && age < STARTING_WINDOW_MS;
  return launching || preparing;
}

/** Whether the project's editor is already up or on its way, so a second press opens nothing. */
async function alreadyOpening(
  project: string,
  port: number | null,
  options: LaunchOptions,
): Promise<OpenResult | undefined> {
  const { env, storage, launch } = options;
  if (port !== null && (await env.editorAnswers(port, project))) {
    await retireStarting(storage, project);
    return { project, launched: false, at: null };
  }
  const starting = await readStarting(storage);
  if (starting?.project !== project) return undefined;
  const running = await env.editorRunning();
  return stillStarting(starting, running, launch.now()) ? { project, launched: false, at: starting.at } : undefined;
}

/**
 * The project's port when it is still held after waiting up to {@link PORT_FREE_WAIT_MS} for
 * Unreal to be able to listen there, else undefined. Only a port of Genex's block is waited for.
 */
async function heldPort(port: number | null, launch: LaunchEnv): Promise<number | undefined> {
  const wait = launch.portWait;
  if (!wait || !inProjectBlock(port)) return undefined;
  const clock = { now: launch.now, sleep: wait.sleep };
  const freed = await pollUntil(clock, () => wait.free(port), PORT_FREE_POLL_MS, PORT_FREE_WAIT_MS);
  return freed ? undefined : port;
}

/**
 * Brings a set-up project's older (or missing) Genex editor helper up to date before a user's Open,
 * only while no Unreal editor runs: the game snapshot first, then the update. A snapshot that
 * fails means no update, and an update setup refuses writes nothing; the project opens either way.
 */
async function updateBeforeOpen(
  state: ProjectState,
  options: LaunchOptions,
  update: HelperUpdateOnOpen | undefined,
): Promise<HelperUpdate | undefined> {
  // Only a project Genex set up (it has a record) gets its helper updated; a newer helper stays.
  const behind = state.undoable && helperNeedsInstall(state.helper);
  if (!update || !behind) return undefined;
  if ((await editorCount(options.env)) > 0) return undefined;
  try {
    await update.snapshot();
    return await updateHelper(realProjectFile(state), options);
  } catch {
    return undefined;
  }
}

/**
 * On a Mac, builds the game's C++ module with UnrealBuildTool when the project's last editor ran a
 * hot-reloaded library of it, so Unreal opens on code built from the Source; a Blueprint project,
 * a cold build and other computers build nothing. Throws NotBuilt, with the build's first errors.
 */
async function buildIfHotReloaded(project: string, engine: Engine, options: LaunchOptions): Promise<void> {
  const { env, launch } = options;
  const module = env.platform === MAC ? await projectModule(project) : undefined;
  if (!module || !(await hotLibraryLoaded(project, module))) return;
  const notBuilt = (why: string) => new LaunchError(LaunchErrorCode.NotBuilt, MESSAGE[LaunchErrorCode.NotBuilt](why));
  const xcode = await env.xcode(engine.directory);
  if (!canCompileCpp(xcode, env.platform)) throw notBuilt(MESSAGE.CannotBuild(xcode.state));
  const build = launch.build ?? compileEditor;
  const result = await build({ engineDir: engine.directory, projectFile: project, module, xcodeApp: xcode.app });
  if (!result.ok) throw notBuilt(`${result.summary}${buildErrors(result)}`);
}

/**
 * Opens a project in the user's own Unreal, like double-clicking it, unless its editor already
 * answers or is still starting. Everything is checked before anything starts or is written. A
 * user's Open (`helperUpdate`) first updates an older Genex editor helper while no editor runs; on
 * a Mac, a hot-reloaded game module is built first. It waits for the project's port to be free,
 * and opens anyway once the wait runs out (Unreal may still manage), keeping that port in the
 * Starting record so status can say why. After the launch, Genex keeps when it opened the project
 * and makes it the panel's chosen one.
 */
export async function openEditor(file: string, options: LaunchOptions, request: OpenRequest = {}): Promise<OpenResult> {
  const { env, storage, launch } = options;
  const state = await inspectProject(file, options);
  const project = realProjectFile(state);
  const engine = await engineFor(state.engine, await findEngines(env), env.platform);
  const opening = await alreadyOpening(project, state.port, options);
  if (opening) return opening;
  const helper = await updateBeforeOpen(state, options, request.helperUpdate);
  await buildIfHotReloaded(project, engine, options);
  const busyPort = await heldPort(state.port, launch);
  await launch.open(openEditorLaunch(engine, project, env.platform));
  const at = launch.now();
  await recordStarting(storage, { project, at, ...(busyPort === undefined ? {} : { busyPort }) });
  await rememberChoice(storage, project);
  return { project, launched: true, at, ...(helper ? { helper } : {}) };
}

/** How many editors run, from the count when the computer gives one, else from whether one runs. */
export async function editorCount(env: SetupEnv): Promise<number> {
  if (env.editorCount) return env.editorCount();
  return (await env.editorRunning()) ? 1 : 0;
}

/** The exit code of a program that failed, as execFile reports it; undefined when it never ran. */
const exitCode = (error: unknown) => (error instanceof Error && "code" in error ? error.code : undefined);

/**
 * Asks the running Unreal to quit the normal way. With two editors open the quit could reach
 * either, so it refuses and sends nothing. Afterwards, whether or not Unreal took the request, it
 * forgets the Starting record of the project the panel names, never another project's.
 */
export async function quitEditor(project: string, options: LaunchOptions): Promise<{ quitting: boolean }> {
  const { env, launch } = options;
  const editors = await editorCount(env);
  if (editors > 1) throw new LaunchError(LaunchErrorCode.SeveralEditors, MESSAGE[LaunchErrorCode.SeveralEditors]);
  if (editors === 0) return { quitting: false };
  try {
    await launch.open(quitEditorLaunch(env.platform));
    return { quitting: true };
  } catch (error) {
    if (exitCode(error) === TASKKILL_NOT_FOUND) return { quitting: false };
    throw new LaunchError(LaunchErrorCode.NotQuit, MESSAGE[LaunchErrorCode.NotQuit]);
  } finally {
    await forgetStartingOf(project, options);
  }
}

/** Forgets the Starting record when it names the project the panel quit, never another project's. */
async function forgetStartingOf(project: string, options: LaunchOptions): Promise<void> {
  if (!project) return;
  const state = await inspectProject(project, options).catch(() => undefined);
  if (state) await retireStarting(options.storage, realProjectFile(state));
}

/** Opens Epic's launcher, else Epic's download page; nothing the panel sends changes which. */
export async function getUnreal(env: Pick<SetupEnv, "platform">, launch: LaunchEnv): Promise<{ opened: UnrealSource }> {
  const launcher = await findLauncher(env.platform, launch.applications);
  await launch.open(getUnrealLaunch(env.platform, launcher));
  return { opened: launcher ? UnrealSource.Launcher : UnrealSource.Download };
}
