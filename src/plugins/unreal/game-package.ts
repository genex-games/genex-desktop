/**
 * Packaging an Unreal game as the app its players install: `package-game` runs Epic's
 * `BuildCookRun` (build, cook, stage and pak, Shipping) for a system this computer packages for, a
 * Mac app on a Mac, a Windows program on Windows, and on Windows a Linux program too, into
 * `unreal/Builds/<Mac|Windows|Linux>/`, where Publish finds it (`main/core/native-builds.ts`). A web
 * build (`system: "web"`, Unreal's Wasm platform) is the whole site, staged in `unreal/Builds/Wasm/`
 * and then made the game's web version in `web/`, on either system by an engine that builds for the
 * web (`web-build.ts`), from a game with a C++ module, with the emsdk the person installed, its
 * content split into files a host that caps a file's size takes. Unreal
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
 * A Mac app is let onto the network once packaged (`substrate/mac-entitlements.ts`): Unreal's Shipping
 * default sandboxes it with no network, which no online game survives.
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
import { killProcessTree } from "../../substrate/process-tree.ts";
import { editorCmdPath, type ProgramOutcome } from "./automation-tests.ts";
import { uatEnv } from "./program-env.ts";
import { projectModule } from "./cpp-module.ts";
import { letAppReachNetwork, type MacSigner, systemMacSigner } from "../../substrate/mac-entitlements.ts";
import { LINUX_TOOLCHAIN_VARIABLE } from "./setup.ts";
import {
  EMSDK_VARIABLE,
  emscriptenFor,
  emsdkHolds,
  engineBuildsWeb,
  ensureWebSettings,
  GAME_WEB_FOLDER,
  HOST_LIMITS,
  HostLimit,
  holdsWebBuild,
  PROJECT_CONFIG_FOLDER,
  placeWebBuild,
  siteExcess,
  WEB_PAGE,
  WEB_PLATFORM,
  WebFolder,
  webFolderOf,
} from "./web-build.ts";
import { canCompileCpp, cmdCarries, outputCollector, pathScrubber } from "./ubt.ts";
import { type VisualStudioStatus, visualStudioLacking } from "./visual-studio.ts";
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

/** A package as its record keeps it: the state, one line, the app it left (relative to the game) and its first errors. */
export type GamePackageStatus = {
  state: GamePackageState;
  /** The system the app is for: `Mac` or `Windows`. */
  system: string;
  line?: string;
  app?: string;
  errors?: string[];
  seconds?: number;
};
/** `package-status`'s answer: the package's record, and whether it runs now (`jobRunning`, read by Genex to wake the chat when it ends). */
export type GamePackageAnswer = GamePackageStatus & { jobRunning: boolean };

/** How long a package may take before its process tree is ended: a first cook compiles every shader. */
export const GAME_PACKAGE_TIMEOUT_MS = 120 * MINUTE_MS;
/** How long the person's Unreal has to save before the package starts. */
const SAVE_MS = 2 * MINUTE_MS;
/** The most error lines a failed package names, and how long each may be. */
const MAX_ERRORS = 12;
const ERROR_CHARS = 400;
/** How many of a failed package's last output lines it keeps when no line reads as an error. */
const LAST_LINES = 8;
/** The megabyte a size is said in: 1024 × 1024 bytes, as the host counts its limits. */
const MEGABYTE_BYTES = 1024 * 1024;

const MAC = "darwin";
const WINDOWS = "win32";

/** The systems a package is for. Wire values: `package-game`'s and `package-status`'s `system`. */
export const PackageSystem = { Mac: "mac", Windows: "windows", Linux: "linux", Web: "web" } as const;
export type PackageSystem = (typeof PackageSystem)[keyof typeof PackageSystem];

/** Each system's package: UAT's platform, and the folder its stage makes under `Builds/`. */
const SYSTEMS: Readonly<Record<PackageSystem, { platform: string; folder: string }>> = {
  [PackageSystem.Mac]: { platform: "Mac", folder: "Mac" },
  [PackageSystem.Windows]: { platform: "Win64", folder: "Windows" },
  [PackageSystem.Linux]: { platform: "Linux", folder: "Linux" },
  // UAT stages the whole site into a folder it names for the platform.
  [PackageSystem.Web]: { platform: WEB_PLATFORM, folder: WEB_PLATFORM },
};
/** What each computer packages for, its own system first: Windows cross-compiles Linux with Epic's toolchain. */
const HOST_SYSTEMS: Partial<Record<NodeJS.Platform, readonly PackageSystem[]>> = {
  [MAC]: [PackageSystem.Mac, PackageSystem.Web],
  [WINDOWS]: [PackageSystem.Windows, PackageSystem.Linux, PackageSystem.Web],
};

/**
 * Epic's Linux cross-compile toolchain for each Unreal Genex makes games with, by `major.minor`
 * (Epic's "Linux development requirements" page); its installer is `<name>.exe` at
 * {@link LINUX_TOOLCHAIN_DOWNLOADS}.
 */
const LINUX_TOOLCHAINS: Readonly<Record<string, string>> = {
  "5.7": "v26_clang-20.1.8-rockylinux8",
  "5.8": "v26_clang-20.1.8-rockylinux8",
  "5.9": "v26_clang-20.1.8-rockylinux8",
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
    `This computer can't package ${asked ? `"${asked.slice(0, 24)}"` : "that"}: Genex packages a Mac app on a Mac, Windows and Linux apps on Windows (system: "windows" or "linux"), and a web build on either (system: "web").`,
  NoToolchainKnown: (version: string) =>
    `Genex doesn't know Epic's Linux toolchain for Unreal ${version} yet, so it can't package for Linux here.`,
  NeedsToolchain: (version: string, name: string, url: string) =>
    `Packaging for Linux on Windows needs Epic's free Linux cross-compile toolchain for Unreal ${version} (${name}). Give the user this link to download and run Epic's installer, then package again: ${url} (Genex finds it without a restart). Genex packaged nothing.`,
  Busy: (folder: string) =>
    `A ${folder} package of this game is running: wait for it (package-status), or stop it, then package again.`,
  NoXcode: (state: string) =>
    `Packaging an Unreal game on a Mac needs Xcode (Xcode: ${state}). Call unreal__show-steps so the user can install it, then package again.`,
  NeedsBuildTools: (state: string) =>
    `This game has C++, which packaging it for Windows compiles with Microsoft's Visual Studio Build Tools (Visual Studio: ${state}). Call unreal__install-unreal, which installs them (Windows asks the user for permission), end your reply, and package again once the chat says they are installed. Genex packaged nothing.`,
  Uncarried:
    "Genex won't package here: the game's path holds a quote, % or !, which cmd.exe can't carry, or is on a network share. Move the game to a plain local folder.",
  NotAFolder: (where: string) => `${where} isn't a plain folder in the project, so Genex packaged nothing.`,
  NotSaved: (why: string) =>
    `Unreal couldn't save its open work (${why}), so Genex packaged nothing: the app would miss it. Save in Unreal, or quit it, then package again.`,
  NoWebPlatform: (version: string) =>
    `Unreal ${version} on this computer can't build for the web: its install has no web (Wasm) platform, which Unreal has from 5.9 in installs that include it. Genex packaged nothing; say so to the user and offer this computer's own app instead.`,
  WebNeedsCpp:
    "A web build needs the game's C++ module: Unreal builds web games from C++ projects only. Call unreal__add-cpp-module (the user confirms it), then package again. Genex packaged nothing.",
  NeedsEmsdk: (version: string) =>
    `A web build needs emscripten ${version}, exactly, in an emsdk folder this computer names. Give the user these steps: clone https://github.com/emscripten-core/emsdk to a plain local folder, run "emsdk install ${version}" and "emsdk activate ${version}" in it, and set the ${EMSDK_VARIABLE} environment variable to that folder; then package again. Genex packaged nothing.`,
  WebFolderTaken:
    "The game's web/ folder holds other files, and a web build is the game's whole web/ folder. Move or remove what is in web/ (ask the user first), then package again. Genex packaged nothing.",
  NoWebSettings: (config: string, code: string) =>
    `Genex couldn't write the web build's settings into ${config}/ (${code}). The folders and config files there have to be the project's own plain ones, which Genex can read and write, never links. Genex packaged nothing.`,
  Packaged: (system: string, seconds: number) => `The ${system} app was packaged in ${seconds} s.`,
  WebPackaged: (seconds: number) => `The web build was made in ${seconds} s.`,
  /** What of a web build is past what Genex's hosting takes as a rule, in a sentence that stands alone. */
  PastHostLimits: (what: string) => `The site is past Genex hosting's usual limits: ${what}.`,
  /** The largest file past the file limit, and how many `others` are past it too: splitting one alone wouldn't do. */
  FileTooLarge: (file: string, megabytes: number, most: number, others: number) => {
    const largest = `${file} is ${megabytes} MB, and a file may be ${most} MB at most`;
    if (others === 0) return largest;
    return others === 1 ? `${largest} (1 more file is past that)` : `${largest} (${others} more files are past that)`;
  },
  SiteTooLarge: (megabytes: number, most: number) =>
    `it is ${megabytes} MB in all, and a game may be ${most} MB at most`,
  TooManyFiles: (files: number, most: number) => `it has ${files} files, and a game may have ${most} at most`,
  /** The site was made, but `web/` came to hold other files meanwhile, so it stays where Unreal staged it. */
  WebStaged: (seconds: number) =>
    `The web build was made in ${seconds} s, but the game's web/ folder now holds other files, so the site stays in the build folder.`,
  NoApp: (system: string) => `BuildCookRun said it succeeded, but no ${system} app is in the build folder.`,
  Failed: (count: number) =>
    count === 0 ? "BuildCookRun failed." : `BuildCookRun failed: ${count} error line${count === 1 ? "" : "s"}.`,
  TimedOut: `The package was stopped after ${GAME_PACKAGE_TIMEOUT_MS / MINUTE_MS} minutes.`,
  Stopped: "Stopped.",
  NotStarted: (code: string) => `AutomationTool couldn't start (${code}).`,
  NoNetwork: (why: string) =>
    `The Mac app was packaged, but Genex couldn't let it reach the network (${why}): Unreal's Shipping sandbox would keep it offline, so package again.`,
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
  /** The installed engine `game` is packaged with: its project's own, else the newest supported one. */
  engine(storage: string, game: string): Promise<{ version: string; directory: string } | undefined>;
  project(storage: string, game: string): Promise<string | undefined>;
  xcode(engineDir: string | undefined): Promise<Pick<XcodeStatus, "state">>;
  /** Where Microsoft's C++ tools stand on Windows, which a game with C++ is packaged with; none off Windows. */
  visualStudio?(engineDir: string | undefined): Promise<Pick<VisualStudioStatus, "state">>;
  /** Windows: `LINUX_MULTIARCH_ROOT` as Epic's installer set it, or undefined; none means no toolchain. */
  linuxToolchain?(): Promise<string | undefined>;
  /** The emsdk folder this computer names for Unreal's web builds (`EMSDK_VARIABLES`), or undefined. */
  emsdk?(): Promise<string | undefined>;
  /** Whether the game's own Unreal answers now. */
  editorAnswers(storage: string, game: string): Promise<boolean>;
  /** Saves the game's open Unreal (ending play first): whether all of it saved, and what didn't. */
  save(storage: string, game: string, timeoutMs: number): Promise<{ saved: boolean; dirty: string[] }>;
  now(): number;
  /** RunUAT's runner; the product's own unless a test stands in. */
  runUat?: RunUat;
  /** Reads and re-signs a packaged Mac app's entitlements; the computer's codesign unless a test stands in. */
  macSigner?: MacSigner;
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
 * What a web build asks of BuildCookRun beyond an app's: IoStore containers, as Epic's own command
 * line for the platform has; the package step, the only one that writes the page's file list
 * (`wasm-manifest.json`, without which the page never starts) and moves the files no host may serve
 * (the symbol map, UAT's manifests) out of the site; no Brotli copy beside each file, which
 * helps only on a host that serves it in the file's place, and Genex's serve each file as it is;
 * and chunk lists from the cook, without which the game's whole content is one file however the
 * project's config says to split it (`ensureWebSettings`), too large for a host that caps a file.
 */
const WEB_ONLY_ARGS = ["-iostore", "-package", "-WasmNoBrotli", "-manifests"] as const;

/**
 * What an app asks of BuildCookRun beyond a web build's: its paks compressed and no debug files
 * staged beside the program. The staged app is what players download, so both make it smaller;
 * a web build's files are compressed by the host that serves them.
 */
const APP_ONLY_ARGS = ["-compressed", "-nodebuginfo"] as const;

/**
 * BuildCookRun's arguments: Shipping for `system` (this computer's own when none), built, cooked,
 * staged into paks (an app's compressed, with no debug files) and staged under `stagingDir`, the cook run by this computer's own command-line
 * editor (a project with no editor target of its own has none to build).
 */
export function buildCookRunArgs(o: {
  projectFile: string;
  stagingDir: string;
  engineDir: string;
  platform: NodeJS.Platform;
  system?: PackageSystem;
}): string[] {
  const system = packageSystemOf(o.platform, o.system);
  const target = SYSTEMS[system];
  return [
    "BuildCookRun",
    `-project=${o.projectFile}`,
    `-platform=${target.platform}`,
    "-clientconfig=Shipping",
    "-build",
    "-cook",
    "-stage",
    "-pak",
    ...(system === PackageSystem.Web ? WEB_ONLY_ARGS : APP_ONLY_ARGS),
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
  const engine = await deps.engine(storage, game);
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
  const windows = deps.platform === WINDOWS;
  if (windows && !cmdCarries([target.engineDir, target.projectFile])) throw new Error(MESSAGE.Uncarried);
  if (target.system.id === PackageSystem.Web) return assertWeb(deps, target);
  if (windows) {
    if (target.system.id !== PackageSystem.Linux) return assertBuildTools(deps, target);
    return { [LINUX_TOOLCHAIN_VARIABLE]: await linuxToolchainRoot(deps, target.engineVersion) };
  }
  const xcode = await deps.xcode(target.engineDir);
  if (!canCompileCpp({ xcode }, deps.platform)) throw new Error(MESSAGE.NoXcode(xcode.state));
  return {};
}

/**
 * Refuses a web build this computer can't make, each with what would let it: an engine whose install
 * builds for the web, the game's C++ module (Unreal builds web games from C++ projects only), and an
 * emsdk folder with exactly the emscripten that engine names, which RunUAT is handed in the first
 * variable Unreal's build tool reads; and a `web/` folder in the game that holds other files. Emscripten compiles the game, so neither Xcode nor Microsoft's
 * tools are asked for.
 */
async function assertWeb(deps: GamePackageDeps, target: Target): Promise<Record<string, string>> {
  const wanted = (await engineBuildsWeb(target.engineDir)) ? await emscriptenFor(target.engineDir) : undefined;
  if (!wanted) throw new Error(MESSAGE.NoWebPlatform(target.engineVersion));
  if (!(await projectModule(target.projectFile).catch(() => undefined))) throw new Error(MESSAGE.WebNeedsCpp);
  if ((await webFolderOf(target.gameDir)) === WebFolder.Taken) throw new Error(MESSAGE.WebFolderTaken);
  const root = ((await deps.emsdk?.().catch(() => undefined)) ?? "").replace(TRAILING_SEPARATORS, "");
  const carried = deps.platform !== WINDOWS || cmdCarries([root]);
  if (!carried || !(await emsdkHolds(root, wanted))) throw new Error(MESSAGE.NeedsEmsdk(wanted));
  return { [EMSDK_VARIABLE]: root };
}

/**
 * Refuses a Windows package of a game with C++ while Microsoft's C++ tools aren't ready: a game in
 * Blueprints is packaged from the engine's own binaries without them, and a computer that can't tell
 * is let through. Adds nothing to RunUAT's environment.
 */
async function assertBuildTools(deps: GamePackageDeps, target: Target): Promise<Record<string, string>> {
  if (!(await projectModule(target.projectFile).catch(() => undefined))) return {};
  const tools = await deps.visualStudio?.(target.engineDir).catch(() => undefined);
  if (tools && visualStudioLacking(tools)) throw new Error(MESSAGE.NeedsBuildTools(tools.state));
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
  const plain = path.isAbsolute(folder) && cmdCarries([folder]) && named;
  const info = plain ? await lstat(folder).catch(() => null) : null;
  if (!info?.isDirectory() || info.isSymbolicLink())
    throw new Error(MESSAGE.NeedsToolchain(version, wanted.name, wanted.url));
  return set;
}

/**
 * What Genex's hosts need of a web build, set in the project's own config before the cook reads it:
 * they send no isolation headers, so the page adds them itself, and they take no file past a size,
 * so the content comes in several. A config Genex can't write as a plain file of the project's own
 * refuses the package, by its folder inside the game and the failure's code alone.
 */
async function webSettings(target: Target): Promise<void> {
  try {
    await ensureWebSettings(target.projectDir);
  } catch (failure) {
    const config = shownIn(target.gameDir, path.join(target.projectDir, PROJECT_CONFIG_FOLDER));
    throw new Error(MESSAGE.NoWebSettings(config, errorCode(failure)));
  }
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
  [PackageSystem.Web]: { extension: WEB_PAGE, folder: false },
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
  if (app && target.system.id === PackageSystem.Web) return webPackaged(target, dirs.dir, app, seconds);
  if (app) {
    if (target.system.id === PackageSystem.Mac) await networkedMacApp(deps, app, seconds);
    return { line: MESSAGE.Packaged(target.system.folder, seconds), app: shownIn(target.gameDir, app), seconds };
  }
  const scrub = await pathScrubber(target.projectDir, target.engineDir);
  const errors = packageErrors(outcome.output, scrub);
  const succeeded = outcome.code === 0 && SUCCEEDED.test(outcome.output);
  const line = succeeded ? MESSAGE.NoApp(target.system.folder) : MESSAGE.Failed(errors.length);
  throw new PackageFailed(line, errors, seconds);
}

/**
 * A finished web build made the game's web version (`web/`), named by its page; left staged when
 * `web/` is taken. Its line also says what of the site is past the host's usual limits, so that is
 * known before an upload is tried.
 */
async function webPackaged(target: Target, staged: string, page: string, seconds: number) {
  // A staged page without its file list never starts, and as web/ it would read as someone else's folder.
  if (!(await holdsWebBuild(staged))) throw new PackageFailed(MESSAGE.NoApp(target.system.folder), [], seconds);
  const placed = await placeWebBuild(target.gameDir, staged);
  const made = placed ? MESSAGE.WebPackaged(seconds) : MESSAGE.WebStaged(seconds);
  const past = await pastHostLimits(target, path.dirname(placed ?? page));
  return { line: [made, ...past].join(" "), app: shownIn(target.gameDir, placed ?? page), seconds };
}

/** How many megabytes (of 1024 × 1024 bytes) `bytes` are, rounded up: a file a byte past a limit reads as past it. */
const megabytes = (bytes: number) => Math.ceil(bytes / MEGABYTE_BYTES);

/** What of the site in `site` is past the host's usual limits (`siteExcess`), in one sentence; none when it is inside them all. */
async function pastHostLimits(target: Target, site: string): Promise<string[]> {
  const excess = await siteExcess(site);
  if (excess.length === 0) return [];
  const said = excess.map((over) => {
    if (over.limit === HostLimit.Files) return MESSAGE.TooManyFiles(over.amount, HOST_LIMITS.Files);
    if (over.limit === HostLimit.Site)
      return MESSAGE.SiteTooLarge(megabytes(over.amount), megabytes(HOST_LIMITS.SiteBytes));
    const file = shownIn(target.gameDir, path.join(site, over.file ?? ""));
    return MESSAGE.FileTooLarge(file, megabytes(over.amount), megabytes(HOST_LIMITS.FileBytes), over.others ?? 0);
  });
  return [MESSAGE.PastHostLimits(said.join("; "))];
}

/** Lets the packaged Mac app reach the network, or fails the package: an app that stays offline is not offered to Publish. */
async function networkedMacApp(deps: GamePackageDeps, app: string, seconds: number): Promise<void> {
  await letAppReachNetwork(app, deps.macSigner ?? systemMacSigner).catch((failure: unknown) => {
    throw new PackageFailed(MESSAGE.NoNetwork(errorMessage(failure)), [], seconds);
  });
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
      if (target.system.id === PackageSystem.Web) await webSettings(target);
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
  async function status(args: Args, context: PluginContext, storage: string): Promise<GamePackageAnswer> {
    const target = await targetOf(deps, storage, context, args.system);
    const record = records.get(recordKey(target));
    if (record) return { ...record, jobRunning: record.state === GamePackageState.Running };
    const web = target.system.id === PackageSystem.Web;
    const ours = web && (await webFolderOf(target.gameDir)) === WebFolder.Ours;
    // A web build is the game's own web/ folder; an app stays in its system's build folder.
    const dir = ours
      ? path.join(target.gameDir, GAME_WEB_FOLDER)
      : path.join(target.projectDir, BUILDS_FOLDER, target.system.folder);
    const app = (await isPlain(dir)) ? await appIn(dir, target.system.id) : undefined;
    // After a restart the build's own line is gone: a web build still says what the host won't take.
    const past = web && app ? await pastHostLimits(target, path.dirname(app)) : [];
    return {
      state: GamePackageState.Idle,
      system: target.system.folder,
      ...(app ? { app: shownIn(target.gameDir, app) } : {}),
      ...(past.length > 0 ? { line: past.join(" ") } : {}),
      jobRunning: false,
    };
  }

  return {
    handlers: {
      [GamePackageToolName.PackageGame]: start,
      [GamePackageToolName.PackageStatus]: status,
    } satisfies Record<GamePackageToolName, (args: Args, context: PluginContext, storage: string) => Promise<unknown>>,
  };
}
