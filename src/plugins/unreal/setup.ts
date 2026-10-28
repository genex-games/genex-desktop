/**
 * Set up Unreal: everything Genex needs from a user's Unreal project, applied in one step so nobody
 * edits a .uproject or an ini by hand. Each piece is what had to be done by hand before:
 * - Epic's ModelContextProtocol and EditorToolset plugins on in the .uproject, and Epic's other
 *   toolsets agents make games with added beside them;
 * - the MCP server starting on the project's own port whenever the project opens, from the
 *   project's per-user `Saved/Config/<Platform>Editor/EditorPerProjectUserSettings.ini`, which
 *   Unreal keeps when it rewrites that file on exit; the port is chosen once (`editor-port.ts`);
 * - the Genex editor helper copied into the project's `Plugins/` folder.
 * Engines and recent projects come from Epic's own lists. Setup refuses while Unreal Editor runs
 * (it rewrites the project's settings when it closes), never writes through a link, keeps a copy
 * of each file before its first change, and records what it changed, so Undo takes back exactly
 * that and keeps whatever the user changed since.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { cp, lstat, readdir, readFile, realpath, rm, rmdir, statfs } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SECOND_MS } from "../../shared/duration.ts";
import { t } from "../../shared/i18n.ts";
import {
  atomicWriteJson,
  atomicWriteText,
  isJsonObject,
  readJsonIfExists,
  readRegularFile,
} from "../../substrate/fsx.ts";
import { containedReal } from "../../substrate/paths.ts";
import { envValue } from "../../substrate/toolchain.ts";
import { crashReporterHolds, editorHoldsLog, heldProjectNames } from "./editor-holds.ts";
import { type EditorLog, editorLogPath, readEditorLog } from "./editor-log.ts";
import { loadEpicText } from "./epic-files.ts";
import { isProjectPath, projectName } from "./project-file.ts";
import {
  choosePort,
  editorAnswers,
  editorEndpoint,
  editorServes,
  inProjectBlock,
  listSetUpProjects,
  PROJECT_PORT_RANGE,
  parsePort,
  portListening,
  rememberAnswers,
  SetupStorage,
} from "./editor-port.ts";
import { systemXcodeCheck, type XcodeCheck } from "./xcode.ts";

/** The oldest engine Genex works with: Epic's MCP server ships from 5.8. */
const MIN_ENGINE = { major: 5, minor: 8 } as const;

/** The Unreal version Genex makes projects with and asks a newcomer to install ({@link MIN_ENGINE}). */
export const installEngineVersion = () => `${MIN_ENGINE.major}.${MIN_ENGINE.minor}`;

/**
 * What to do when no Unreal Genex works with is installed: where to get it (the Unreal button
 * shows the steps and notices the install), read by the user in the panel and by agents, who pass
 * it on. Named after the version Genex makes projects with ({@link MIN_ENGINE}).
 */
export const installEngineText = () =>
  t(
    "Unreal Engine {version} isn't on this computer yet. The Unreal button above the game shows how to get it free from Epic, and notices when it's installed.",
    { version: installEngineVersion() },
  );
/** Epic's plugins the bridge talks to, in the order setup adds them: a project without them on isn't set up. */
const MCP_PLUGINS = ["ModelContextProtocol", "EditorToolset"] as const;
/**
 * Epic's other toolsets agents make games with, added after {@link MCP_PLUGINS}, for the editor only:
 * UI widgets, effects, AI (state trees, behavior trees), animation and sequences, procedural content,
 * physics assets, gameplay tags and automation tests. Not Epic's AllToolsets: its GameFeaturesToolset
 * makes every editor start log a load error, and its other toolsets serve no game Genex makes. A
 * toolset the project already names, on or off, stays as the user left it, and one Genex added that
 * the user took out again stays out.
 */
const TOOLSET_PLUGINS = [
  "UMGToolSet",
  "NiagaraToolsets",
  "StateTreeToolset",
  "AIModuleToolset",
  "AnimationAssistantToolset",
  "PCGToolset",
  "PhysicsToolsets",
  "GameplayTagsToolset",
  "AutomationTestToolset",
] as const;
/** The section of the per-user project settings that starts Epic's MCP server. */
const MCP_SECTION = "[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]";
const AutoStartKey = { Start: "bAutoStartServer", Port: "ServerPortNumber" } as const;
const SETTINGS_INI = "EditorPerProjectUserSettings.ini";
/** The Genex editor helper's folder, in this plugin and in a project's Plugins folder. */
export const HELPER_FOLDER = "GenexEditorHelper";
/** What Python leaves beside the helper's modules; never part of the shipped helper. */
const PYTHON_CACHE = "__pycache__";
/**
 * The helper's plugin descriptor: people read its `VersionName` as its version, and its whole-number
 * `Version` says which of two helpers is newer.
 */
const HELPER_DESCRIPTOR = `${HELPER_FOLDER}.uplugin`;
/** The helper's descriptor in a project, relative to the project folder, `/`-separated. */
const PROJECT_HELPER_DESCRIPTOR = ["Plugins", HELPER_FOLDER, HELPER_DESCRIPTOR].join("/");
const HELPER_DESCRIPTOR_MAX_BYTES = 64 * 1024;
/** A version as the helper's descriptor writes it: dotted numbers, never anything else. */
const HELPER_VERSION = /^\d{1,4}(?:\.\d{1,4}){0,3}$/;
const RECENT_PROJECTS_CAP = 12;
const RECORD_KEY_CHARS = 16;
const COMMAND_TIMEOUT_MS = 5 * SECOND_MS;
/** An install record of Epic's launcher is a few KB; one far bigger isn't one. */
const LAUNCHER_RECORD_MAX_BYTES = 64 * 1024;
/** The install records read at most: a launcher with every Epic game and plugin installed keeps a few hundred. */
const LAUNCHER_RECORDS_CAP = 1000;
const LAUNCHER_RECORD = ".item";
const RECENT_LINE = /^RecentlyOpenedProjectFiles=\(ProjectName="([^"]+)",LastOpenTime=([\d.-]+)\)/;
const ENGINE_APP = /^UE_(\d+)\.(\d+)$/;
const ENGINE_BUILD = /^\d+\.\d+\.\d+/;
const LINE_BREAK = /\r?\n/;

/**
 * Whether the project's copy of the editor helper matches the one this plugin ships, differs from
 * it, is newer (its descriptor names a higher `Version`, so setup leaves it), or is missing.
 */
export const HelperState = { Current: "current", Outdated: "outdated", Newer: "newer", Missing: "missing" } as const;
export type HelperState = (typeof HelperState)[keyof typeof HelperState];

/** Whether setup puts the shipped helper in: a project's copy that is missing or outdated, never a newer one. */
export const helperNeedsInstall = (state: HelperState) =>
  state === HelperState.Missing || state === HelperState.Outdated;

/** How a project's engine (its `EngineAssociation`) compares with the engines on this computer. */
export const EngineMatch = { Installed: "installed", TooOld: "too-old", Missing: "missing", Custom: "custom" } as const;
export type EngineMatch = (typeof EngineMatch)[keyof typeof EngineMatch];

/** The changes setup still has to make in a project. */
export const SetupStep = { Engine: "engine", Plugins: "plugins", AutoStart: "auto-start", Helper: "helper" } as const;
export type SetupStep = (typeof SetupStep)[keyof typeof SetupStep];

/** Why setup or undo refused; the message says it in words the panel shows as they are. */
export const SetupErrorCode = {
  NotProjectFile: "not-project-file",
  NoProject: "no-project",
  BadProjectFile: "bad-project-file",
  Link: "link",
  EditorRunning: "editor-running",
  NothingToUndo: "nothing-to-undo",
  NoFreePort: "no-free-port",
  NotSetUp: "not-set-up",
} as const;
export type SetupErrorCode = (typeof SetupErrorCode)[keyof typeof SetupErrorCode];

/** Setup's refusals, in the person's words: the panel shows them as they are. */
const MESSAGE = {
  NotProjectFile: () => t("Choose a project's .uproject file by its full path."),
  NoProject: () => t("There's no Unreal project file at that path."),
  BadProjectFile: () => t("This .uproject file isn't valid JSON, so Genex won't change it."),
  Link: (where: string) =>
    t("{where} in this project links somewhere else, so Genex won't write through it.", { where }),
  EditorRunning: () => t("Quit Unreal Editor first. It rewrites the project's settings when it closes."),
  NothingToUndo: () => t("Genex hasn't set up this project, so there's nothing to undo."),
  NoFreePort: () =>
    t(
      "Genex found no free port for Unreal's MCP server: other apps hold every port from {first} to {last}. Quit some of them and try again.",
      { first: PROJECT_PORT_RANGE.first, last: PROJECT_PORT_RANGE.last },
    ),
  NotSetUp: () => t("Genex hasn't set up this project, so it has no Genex editor helper to update. Set it up first."),
} as const;

/** A copy of a helper file the user changed, kept beside it when setup puts the shipped one back. */
const MINE_SUFFIX = ".mine";
/** How many `.mine` copies of one file setup keeps before it stops looking for a free name. */
const MINE_COPIES_CAP = 100;

/** A refusal with a code for the panel and a message it shows as it is. */
export class SetupError extends Error {
  readonly code: SetupErrorCode;
  constructor(code: SetupErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Where setup looks and what it asks the computer; tests hand in a fake home. */
export type SetupEnv = {
  home: string;
  platform: NodeJS.Platform;
  /** Windows' ProgramData folder, where Epic's launcher keeps its list of engines. */
  programData: string;
  editorRunning: () => Promise<boolean>;
  /** How many editors run; without it, one while `editorRunning` says so. */
  editorCount?: () => Promise<number>;
  /** Whether anything accepts connections on a port (setup's choice of a free one). */
  portListening: (port: number) => Promise<boolean>;
  /**
   * Whether Unreal's crash reporter holds a port (a crashed editor's reporter keeps its sockets);
   * undefined, or absent, when this computer can't tell.
   */
  crashReporterHolds?: (port: number) => Promise<boolean | undefined>;
  /**
   * Whether Epic's Unreal MCP completes an `initialize` on a port, and, given a project's real
   * `.uproject`, whether that editor has this project open (the Genex editor helper names it).
   */
  editorAnswers: (port: number, project?: string) => Promise<boolean>;
  /** Where Xcode stands on a Mac, judged by the range of the engine installed in the folder it is given. */
  xcode: XcodeCheck;
  freeBytes: (dir: string) => Promise<number>;
  totalMemory: () => number;
  /** A folder's entries, as readdir names them; tests stand in for Windows, which calls a placeholder a link. */
  readEntries?: ReadEntries;
  /**
   * What a project's own Unreal log says (its real `.uproject` and folder, and its port to ask
   * whether Epic's server couldn't listen there); undefined without one.
   */
  editorLog?: (project: { file: string; directory: string; port?: number }) => Promise<EditorLog | undefined>;
  /**
   * The projects a running Unreal Editor has open, by name, as far as this computer can tell (by
   * the project logs an editor holds, on a Mac); none when it can't.
   */
  heldProjects?: () => Promise<string[]>;
};

/** A folder's entries with readdir's own types, which only the names are trusted from. */
export type ReadEntries = (
  dir: string,
) => Promise<Array<Pick<Dirent, "name" | "isFile" | "isDirectory" | "isSymbolicLink">>>;
/** readdir with its types, the way the computer answers. */
export const readEntries: ReadEntries = (dir) => readdir(dir, { withFileTypes: true });

/** One setup call: the computer, the shipped helper and the plugin's storage. */
export type SetupOptions = { env: SetupEnv; helper: string; storage: string };

/**
 * What updating a project's Genex editor helper did: the project's helper version before (null when
 * it had none that reads), the shipped version, and the `.mine` copy kept of each helper file the
 * user had changed, relative to the project folder and `/`-separated.
 */
export type HelperUpdate = { from: string | null; to: string; kept: string[] };

/** An engine Epic's launcher installed. */
export type Engine = { version: string; build: string; directory: string; supported: boolean };
/** A project the engine's own Recent Projects list names. */
export type RecentProject = { file: string; name: string; opened: string };

/** What a project has and still needs. */
export type ProjectState = {
  file: string;
  name: string;
  directory: string;
  /** The project's real `.uproject`: the real folder and the file's own name on disk. */
  real: string;
  /** The `EngineAssociation` the project names, as written. */
  engine: string;
  cpp: boolean;
  plugins: boolean;
  /**
   * Each of Epic's toolsets for games ({@link TOOLSET_PLUGINS}) is named in the .uproject, or Genex
   * added it and the user took it out again.
   */
  toolsets: boolean;
  autoStart: boolean;
  /** The port Epic's MCP server starts on when the project opens; null while it doesn't start. */
  port: number | null;
  helper: HelperState;
  ready: boolean;
  undoable: boolean;
};

type Project = { file: string; name: string; directory: string };
type UProject = Record<string, unknown>;
/**
 * What setup changed, so Undo takes back exactly that; each part keeps its state from before Genex.
 * `port` is the project's own port, which the bridge reads from here; undo removes the record.
 * `ini.fileExisted` and `helper.pluginsExisted` say whether the settings file and the Plugins
 * folder were there before Genex; a record without them keeps both on undo.
 */
type SetupRecord = {
  project: string;
  port?: number;
  uproject: { added: string[]; enabled: string[] };
  ini?: { sectionExisted: boolean; previous: Record<string, string | null>; fileExisted?: boolean };
  /** `installed`: each helper file setup wrote, relative to the helper folder, with the sha256 of its bytes. */
  helper?: { existed: boolean; pluginsExisted?: boolean; installed?: Record<string, string> };
  /** The `EngineAssociation` a project from an older Unreal had, and the one setup switched it to. */
  engine?: { previous: string; switched: string };
};

/** A switch of a project from an older Unreal to the newest supported one: from and to, as `EngineAssociation` values. */
export type EngineSwitch = { from: string; to: string };
type IniSection = { start: number; end: number };

/** Runs a program to its end with execFile's options; tests record instead. */
export type Runner = (
  file: string,
  args: readonly string[],
  options: { timeout: number; windowsHide: boolean },
) => Promise<{ stdout: string }>;

const run: Runner = promisify(execFile);
const isWindows = (env: SetupEnv) => env.platform === "win32";
const lower = (text: string) => text.toLowerCase();
const WINDOWS_ROOT = "C:\\Windows";

/** Windows' own folder, from the env a plugin backend gets. */
const systemRoot = (env: NodeJS.ProcessEnv) => envValue(env, "SystemRoot") || WINDOWS_ROOT;

/**
 * A Windows system program by its full path under SystemRoot, so neither PATH nor the current
 * folder can stand in for it.
 */
export function windowsSystemTool(env: NodeJS.ProcessEnv, ...parts: string[]): string {
  return path.win32.join(systemRoot(env), ...parts);
}

/**
 * A Windows folder a variable names (ProgramData, ProgramFiles(x86)); without it, the folder of
 * that name at the root of Windows' own drive.
 */
export function windowsFolder(env: NodeJS.ProcessEnv, variable: string, name: string): string {
  return envValue(env, variable) || path.win32.join(path.win32.parse(systemRoot(env)).root, name);
}

/**
 * What each project's own log says, where Unreal writes it under `home` on `platform`. A log that
 * never closed counts as open only while an editor still holds it, when this computer can tell (a
 * Mac, by lsof through `runner`): one an editor left behind when it crashed is not open.
 */
export function systemEditorLog(
  home: string,
  platform: NodeJS.Platform,
  runner: Runner = run,
): NonNullable<SetupEnv["editorLog"]> {
  const held = editorHoldsLog(platform, runner);
  return (project) => readEditorLog(editorLogPath(project, home, platform), project.file, project.port, held);
}

/** The computer this runs on; `env` and `runner` let a test stand in for Windows, `now` is the clock. */
export function systemSetupEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  runner: Runner = run,
  now: () => number = Date.now,
): SetupEnv {
  const home = os.homedir();
  return {
    home,
    editorLog: systemEditorLog(home, platform, runner),
    heldProjects: () => heldProjectNames(platform, runner, home),
    platform,
    programData: windowsFolder(env, "ProgramData", "ProgramData"),
    editorRunning: async () => (await editorProcesses(platform, env, runner)) > 0,
    editorCount: () => editorProcesses(platform, env, runner),
    portListening,
    crashReporterHolds: (port) => crashReporterHolds(port, platform, runner),
    editorAnswers: rememberAnswers((port, project) => {
      const endpoint = editorEndpoint(String(port));
      return project === undefined ? editorAnswers(endpoint) : editorServes(endpoint, project);
    }, now),
    xcode: systemXcodeCheck(platform, env),
    freeBytes: async (dir) => {
      const disk = await statfs(dir);
      return disk.bavail * disk.bsize;
    },
    totalMemory: () => os.totalmem(),
  };
}

const WINDOWS_EDITOR = "UnrealEditor.exe";

/** How to ask whether an editor runs: pgrep on a Mac, tasklist by its full path on Windows. */
export function editorProcessCommand(platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  if (platform === "win32")
    return {
      file: windowsSystemTool(env, "System32", "tasklist.exe"),
      args: ["/FI", `IMAGENAME eq ${WINDOWS_EDITOR}`, "/NH"],
    };
  return { file: "/usr/bin/pgrep", args: ["-x", "UnrealEditor"] };
}

/** How many editors tasklist's answer lists; its "no tasks" note and an empty answer list none. */
export function tasklistEditors(stdout: string): number {
  return stdout.split(LINE_BREAK).filter((line) => lower(line.trim()).startsWith(lower(WINDOWS_EDITOR))).length;
}

/** Whether tasklist's answer lists the editor. */
export const tasklistShowsEditor = (stdout: string) => tasklistEditors(stdout) > 0;

/** How many editor processes run: pgrep's pids, one per line, or tasklist's rows. */
async function editorProcesses(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, runner: Runner): Promise<number> {
  // windowsHide: the backend has no console, so tasklist would otherwise flash a window of its own.
  const options = { timeout: COMMAND_TIMEOUT_MS, windowsHide: true };
  const { file, args } = editorProcessCommand(platform, env);
  // pgrep exits 1 when nothing matches, which execFile reports as a failure.
  const listed = await runner(file, args, options).catch(() => null);
  const stdout = listed?.stdout ?? "";
  if (platform === "win32") return tasklistEditors(stdout);
  return stdout.split(LINE_BREAK).filter((line) => line.trim() !== "").length;
}

function epicFolder(env: SetupEnv): string {
  return isWindows(env)
    ? path.join(env.home, "AppData", "Local")
    : path.join(env.home, "Library", "Application Support", "Epic");
}

function editorConfigFolder(env: SetupEnv): string {
  return isWindows(env) ? "WindowsEditor" : "MacEditor";
}

/** Where Epic's launcher keeps its own files: ProgramData on Windows, Application Support on a Mac. */
function launcherData(env: SetupEnv): string {
  return isWindows(env) ? path.join(env.programData, "Epic") : epicFolder(env);
}

function launcherList(env: SetupEnv): string {
  return path.join(launcherData(env), "UnrealEngineLauncher", "LauncherInstalled.dat");
}

/** The folder of the launcher's install records: one `<id>.item` per install, kept up to date by the launcher. */
function launcherRecords(env: SetupEnv): string {
  return path.join(launcherData(env), "EpicGamesLauncher", "Data", "Manifests");
}

function engineSettings(env: SetupEnv, version: string): string {
  return path.join(
    epicFolder(env),
    "UnrealEngine",
    version,
    "Saved",
    "Config",
    editorConfigFolder(env),
    "EditorSettings.ini",
  );
}

/** The per-user settings file setup writes, relative to the project folder. */
export function settingsIniPath(env: SetupEnv): string {
  return path.join("Saved", "Config", editorConfigFolder(env), SETTINGS_INI);
}

const helperTarget = (project: Project) => path.join(project.directory, "Plugins", HELPER_FOLDER);

async function isDirectory(dir: string): Promise<boolean> {
  return (await lstat(dir).catch(() => null))?.isDirectory() ?? false;
}

async function isFile(file: string): Promise<boolean> {
  return (await lstat(file).catch(() => null))?.isFile() ?? false;
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function isSupported(major: number, minor: number): boolean {
  return major > MIN_ENGINE.major || (major === MIN_ENGINE.major && minor >= MIN_ENGINE.minor);
}

/**
 * The engine an entry of the launcher's list or one of its install records names; undefined for
 * anything else (a game, one of Epic's plugins). The list spells the build `AppVersion`, a record
 * `AppVersionString`.
 */
function engineFrom(item: unknown): Engine | undefined {
  if (!isJsonObject(item) || typeof item.InstallLocation !== "string") return undefined;
  const app = ENGINE_APP.exec(String(item.AppName ?? ""));
  if (!app) return undefined;
  const [major, minor] = [Number(app[1]), Number(app[2])];
  const version = `${major}.${minor}`;
  const build = ENGINE_BUILD.exec(String(item.AppVersion ?? item.AppVersionString ?? ""))?.[0] ?? version;
  return { version, build, directory: item.InstallLocation, supported: isSupported(major, minor) };
}

/** Whether an install record says the launcher is still installing (or updating) what it names. */
const stillInstalling = (item: unknown) => isJsonObject(item) && item.bIsIncompleteInstall === true;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function installationList(text: string): unknown[] {
  const parsed = parseJson(text);
  return isJsonObject(parsed) && Array.isArray(parsed.InstallationList) ? parsed.InstallationList : [];
}

/**
 * The launcher's install records, read as Epic writes them (any byte order mark), each a plain file
 * of a record's size: a link, a folder or anything bigger is skipped unread.
 */
async function installRecords(env: SetupEnv): Promise<unknown[]> {
  const folder = launcherRecords(env);
  const names = (await readdir(folder).catch(() => [] as string[]))
    .filter((name) => lower(name).endsWith(LAUNCHER_RECORD))
    .sort()
    .slice(0, LAUNCHER_RECORDS_CAP);
  const records: unknown[] = [];
  for (const name of names) {
    const bytes = await readRegularFile(path.join(folder, name), LAUNCHER_RECORD_MAX_BYTES).catch(() => null);
    if (bytes) records.push(parseJson(loadEpicText(bytes)));
  }
  return records;
}

/** One spelling of an engine's folder: Windows and macOS ignore case in names. */
const folderKey = (directory: string) => lower(path.resolve(directory));

/**
 * The engines Epic's launcher installed and that are still there, newest first. They come from its
 * install records and its list (`LauncherInstalled.dat`): the Windows launcher of 2025 on records
 * engines only in the first and leaves the list empty, so a freshly installed Unreal is there alone.
 * A folder both name is listed once, from its record, the launcher's current word; one whose record
 * says it is still installing or updating is not an engine yet.
 */
export async function findEngines(env: SetupEnv): Promise<Engine[]> {
  const listed = installationList(await readFile(launcherList(env), "utf8").catch(() => ""));
  const seen = new Set<string>();
  const engines: Engine[] = [];
  for (const item of [...(await installRecords(env)), ...listed]) {
    const engine = engineFrom(item);
    if (!engine || seen.has(folderKey(engine.directory))) continue;
    seen.add(folderKey(engine.directory));
    if (!stillInstalling(item) && (await isDirectory(engine.directory))) engines.push(engine);
  }
  return engines.sort((a, b) => compareVersions(b.build, a.build));
}

/** Projects each installed engine opened lately, from its own Recent Projects list, newest first. */
export async function recentProjects(env: SetupEnv, engines: Engine[]): Promise<RecentProject[]> {
  const found = new Map<string, RecentProject>();
  for (const engine of engines) {
    const text = await readFile(engineSettings(env, engine.version), "utf8").catch(() => "");
    for (const line of text.split(LINE_BREAK)) {
      const match = RECENT_LINE.exec(line);
      if (!match) continue;
      const [, file, opened] = match;
      const known = found.get(file);
      if (known && known.opened >= opened) continue;
      if (isProjectPath(file) && (await isFile(file))) found.set(file, { file, name: projectName(file), opened });
    }
  }
  return [...found.values()].sort((a, b) => b.opened.localeCompare(a.opened)).slice(0, RECENT_PROJECTS_CAP);
}

/** How a project's engine compares with the installed ones. */
export function engineMatch(association: string, engines: Engine[]): EngineMatch {
  const named = /^(\d+)\.(\d+)$/.exec(association);
  if (!named) return EngineMatch.Custom;
  if (!isSupported(Number(named[1]), Number(named[2]))) return EngineMatch.TooOld;
  return engines.some((e) => e.version === association) ? EngineMatch.Installed : EngineMatch.Missing;
}

/**
 * The project at `file`, by its one real spelling: the folder's real path and the file's own name
 * on disk, so another case of the same name (macOS and Windows ignore case) is the same project.
 */
async function resolveProject(file: string): Promise<Project> {
  if (!isProjectPath(file)) throw new SetupError(SetupErrorCode.NotProjectFile, MESSAGE.NotProjectFile());
  if (!(await isFile(file))) throw new SetupError(SetupErrorCode.NoProject, MESSAGE.NoProject());
  const directory = await realpath(path.dirname(file));
  // A plain file (checked above), so realpath only gives its name the case it has on disk.
  const real = await realpath(file);
  if (path.dirname(real) !== directory) throw new SetupError(SetupErrorCode.NotProjectFile, MESSAGE.NotProjectFile());
  return { file: real, name: projectName(real), directory };
}

async function readUProject(project: Project): Promise<{ json: UProject; text: string }> {
  const text = await readFile(project.file, "utf8");
  try {
    const json: unknown = JSON.parse(text);
    if (isJsonObject(json)) return { json, text };
  } catch {}
  throw new SetupError(SetupErrorCode.BadProjectFile, MESSAGE.BadProjectFile());
}

/** JSON in the layout Unreal writes (tabs), keeping the file's own line endings. */
function formatLike(original: string, value: unknown): string {
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const body = JSON.stringify(value, null, "\t").replaceAll("\n", eol);
  return /\r?\n$/.test(original) ? body + eol : body;
}

function pluginEntry(json: UProject, name: string): Record<string, unknown> | undefined {
  const plugins = Array.isArray(json.Plugins) ? json.Plugins : [];
  return plugins.filter(isJsonObject).find((p) => lower(String(p.Name)) === lower(name));
}

const pluginsOn = (json: UProject) => MCP_PLUGINS.every((name) => pluginEntry(json, name)?.Enabled === true);
/** Whether Genex added this plugin before: a toolset it added that the user took out again stays out. */
const addedBefore = (record: SetupRecord | null, name: string) =>
  record?.uproject.added.some((added) => lower(added) === lower(name)) === true;

/** The toolsets the project doesn't name and Genex never added to it: the ones setup still adds. */
const toolsetsMissing = (json: UProject, record: SetupRecord | null) =>
  TOOLSET_PLUGINS.filter((name) => pluginEntry(json, name) === undefined && !addedBefore(record, name));

function addOnce(list: string[], name: string) {
  if (!list.includes(name)) list.push(name);
}

/** An editor-only entry for one of Epic's plugins, as setup adds it. */
const editorPlugin = (name: string) => ({ Name: name, Enabled: true, TargetAllowList: ["Editor"] });

/** Turns Epic's plugins on and adds its toolsets, recording which it added and which it switched on. */
function enablePlugins(json: UProject, record: SetupRecord): boolean {
  if (pluginsOn(json) && toolsetsMissing(json, record).length === 0) return false;
  if (!Array.isArray(json.Plugins)) json.Plugins = [];
  for (const name of MCP_PLUGINS) {
    const entry = pluginEntry(json, name);
    if (entry?.Enabled === true) continue;
    if (entry) {
      entry.Enabled = true;
      addOnce(record.uproject.enabled, name);
    } else {
      (json.Plugins as unknown[]).push(editorPlugin(name));
      addOnce(record.uproject.added, name);
    }
  }
  addToolsets(json, record);
  return true;
}

/** Adds each of Epic's toolsets still missing, recording it; the names it added. */
function addToolsets(json: UProject, record: SetupRecord): string[] {
  if (!Array.isArray(json.Plugins)) json.Plugins = [];
  const missing = toolsetsMissing(json, record);
  for (const name of missing) {
    (json.Plugins as unknown[]).push(editorPlugin(name));
    addOnce(record.uproject.added, name);
  }
  return missing;
}

function restorePlugins(json: UProject, record: SetupRecord): void {
  if (!Array.isArray(json.Plugins)) return;
  const added = new Set(record.uproject.added.map(lower));
  json.Plugins = json.Plugins.filter((p) => !(isJsonObject(p) && added.has(lower(String(p.Name)))));
  for (const name of record.uproject.enabled) {
    const entry = pluginEntry(json, name);
    if (entry) entry.Enabled = false;
  }
}

const eolOf = (text: string) => (text.includes("\r\n") ? "\r\n" : "\n");
const splitLines = (text: string) => (text === "" ? [] : text.split(LINE_BREAK));

function findSection(lines: string[]): IniSection | undefined {
  const start = lines.findIndex((line) => line.trim() === MCP_SECTION);
  if (start < 0) return undefined;
  const next = lines.findIndex((line, i) => i > start && line.trim().startsWith("["));
  return { start, end: next < 0 ? lines.length : next };
}

function findKey(lines: string[], section: IniSection, key: string): number {
  for (let i = section.start + 1; i < section.end; i++) if (lines[i].startsWith(`${key}=`)) return i;
  return -1;
}

/** Sets one key in the section, adding it after the section's last setting; returns its old value. */
function putKey(lines: string[], section: IniSection, key: string, value: string): string | null {
  const at = findKey(lines, section, key);
  if (at >= 0) {
    const previous = lines[at].slice(key.length + 1);
    lines[at] = `${key}=${value}`;
    return previous;
  }
  let last = section.end - 1;
  while (last > section.start && lines[last].trim() === "") last--;
  lines.splice(last + 1, 0, `${key}=${value}`);
  section.end++;
  return null;
}

function autoStartValues(port: number): Record<string, string> {
  return { [AutoStartKey.Start]: "True", [AutoStartKey.Port]: String(port) };
}

/** The settings text with Epic's MCP server starting on `port`, and what the section held before. */
function withAutoStart(
  text: string,
  port: number,
): { text: string; sectionExisted: boolean; previous: Record<string, string | null> } {
  const lines = splitLines(text);
  const values = autoStartValues(port);
  const section = findSection(lines);
  if (!section) {
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const block = [MCP_SECTION, ...Object.entries(values).map(([key, value]) => `${key}=${value}`), ""];
    const separated = lines.length > 0 ? [...lines, "", ...block] : block;
    return { text: separated.join(eolOf(text)), sectionExisted: false, previous: {} };
  }
  const previous: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(values)) previous[key] = putKey(lines, section, key, value);
  return { text: lines.join(eolOf(text)), sectionExisted: true, previous };
}

function withoutAutoStart(text: string, ini: NonNullable<SetupRecord["ini"]>): string {
  const lines = splitLines(text);
  const section = findSection(lines);
  if (!section) return text;
  if (!ini.sectionExisted) {
    lines.splice(section.start, section.end - section.start);
    return lines.join(eolOf(text));
  }
  for (const [key, value] of Object.entries(ini.previous)) {
    if (value !== null) {
      putKey(lines, section, key, value);
      continue;
    }
    const at = findKey(lines, section, key);
    if (at < 0) continue;
    lines.splice(at, 1);
    section.end--;
  }
  return lines.join(eolOf(text));
}

/** The MCP section's value for `key`, trimmed; "" when the section or the key is missing. */
function sectionValue(text: string, key: string): string {
  const lines = splitLines(text);
  const section = findSection(lines);
  const at = section ? findKey(lines, section, key) : -1;
  return at < 0 ? "" : lines[at].slice(key.length + 1).trim();
}

/** The port the settings give Epic's MCP server, whether or not it starts by itself. */
const settingsPort = (text: string) => parsePort(sectionValue(text, AutoStartKey.Port));

/** The port Epic's MCP server starts on when the project opens; undefined when it doesn't start by itself. */
function autoStartPort(text: string): number | undefined {
  return lower(sectionValue(text, AutoStartKey.Start)) === "true" ? settingsPort(text) : undefined;
}

/** The settings file's text, or "" when it is missing or not a plain file. */
async function readSettings(file: string): Promise<string> {
  return (await isFile(file)) ? readFile(file, "utf8") : "";
}

async function shippedHelperFiles(helper: string): Promise<string[]> {
  const entries = await readdir(helper, { recursive: true, withFileTypes: true });
  return entries
    .filter(
      (entry) => entry.isFile() && !path.relative(helper, entry.parentPath).split(path.sep).includes(PYTHON_CACHE),
    )
    .map((entry) => path.relative(helper, path.join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * A helper descriptor, `relative` (`/`-separated) inside `root`, read by its real path and capped in
 * size; undefined when it is missing, leads out of `root`, is too big or isn't a JSON object.
 */
async function readHelperDescriptor(root: string, relative: string): Promise<Record<string, unknown> | undefined> {
  try {
    const file = await containedReal(root, relative);
    const descriptor: unknown = JSON.parse((await readRegularFile(file, HELPER_DESCRIPTOR_MAX_BYTES)).toString("utf8"));
    return isJsonObject(descriptor) ? descriptor : undefined;
  } catch {
    return undefined;
  }
}

/** A descriptor's `VersionName` when it is plain dotted numbers; else undefined. */
function versionName(descriptor: Record<string, unknown> | undefined): string | undefined {
  const version = descriptor?.VersionName;
  return typeof version === "string" && HELPER_VERSION.test(version) ? version : undefined;
}

/** The shipped helper's version from its descriptor's `VersionName`; undefined unless it is plain dotted numbers. */
export async function helperVersion(helper: string): Promise<string | undefined> {
  return versionName(await readHelperDescriptor(helper, HELPER_DESCRIPTOR));
}

/** The project's helper version, read as {@link helperVersion} reads the shipped one; null without one. */
async function projectHelperVersion(project: Project): Promise<string | null> {
  return versionName(await readHelperDescriptor(project.directory, PROJECT_HELPER_DESCRIPTOR)) ?? null;
}

/** Whether a descriptor's `Version` is one Unreal compares: a whole number, never negative. */
const isVersionNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Whether the project's helper is newer than the shipped one: its descriptor names a higher
 * `Version`. Never without a whole-number `Version` in both, so a missing or garbled descriptor
 * leaves the choice to the bytes.
 */
async function projectHelperNewer(project: Project, helper: string): Promise<boolean> {
  const [theirs, shipped] = await Promise.all([
    readHelperDescriptor(project.directory, PROJECT_HELPER_DESCRIPTOR),
    readHelperDescriptor(helper, HELPER_DESCRIPTOR),
  ]);
  const [their, ours] = [theirs?.Version, shipped?.Version];
  if (!isVersionNumber(their) || !isVersionNumber(ours)) return false;
  return their > ours;
}

async function helperState(project: Project, helper: string): Promise<HelperState> {
  const target = helperTarget(project);
  if (!(await isDirectory(target))) return HelperState.Missing;
  if (await projectHelperNewer(project, helper)) return HelperState.Newer;
  for (const file of await shippedHelperFiles(helper)) {
    const theirs = (await isFile(path.join(target, file))) ? await readFile(path.join(target, file)) : null;
    if (!theirs?.equals(await readFile(path.join(helper, file)))) return HelperState.Outdated;
  }
  return HelperState.Current;
}

/** Refuses when any existing part of a path setup writes to, from the project folder down, is a link. */
async function assertNoLinks(project: Project, relativePaths: string[]): Promise<void> {
  for (const relative of relativePaths) {
    let current = project.directory;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      const info = await lstat(current).catch(() => null);
      if (!info) break;
      if (info.isSymbolicLink())
        throw new SetupError(SetupErrorCode.Link, MESSAGE.Link(path.relative(project.directory, current)));
    }
  }
}

/** What a folder holds below it, by path relative to it, typed by lstat. */
type Walked = { files: string[]; folders: string[]; links: string[] };

/**
 * Everything below `root`, typed by lstat rather than by readdir: on Windows readdir calls every
 * reparse point a link, OneDrive's plain placeholders too, while lstat calls only real links and
 * junctions links. Folders come deepest last; links are named, never followed.
 */
async function walk(root: string, read: ReadEntries): Promise<Walked> {
  const walked: Walked = { files: [], folders: [], links: [] };
  const pending = [root];
  for (let dir = pending.shift(); dir !== undefined; dir = pending.shift())
    for (const { name } of await read(dir)) {
      const full = path.join(dir, name);
      const info = await lstat(full).catch(() => null);
      const relative = path.relative(root, full);
      if (info?.isSymbolicLink()) walked.links.push(relative);
      else if (info?.isDirectory()) {
        walked.folders.push(relative);
        pending.push(full);
      } else if (info?.isFile()) walked.files.push(relative);
    }
  return walked;
}

/** Refuses when a helper file's path, or anything inside the project's helper folder, is a link. */
async function assertHelperWritable(project: Project, options: SetupOptions): Promise<void> {
  const helperFiles = (await shippedHelperFiles(options.helper)).map((file) =>
    path.join("Plugins", HELPER_FOLDER, file),
  );
  await assertNoLinks(project, helperFiles);
  const target = helperTarget(project);
  if (!(await isDirectory(target))) return;
  const [link] = (await walk(target, options.env.readEntries ?? readEntries)).links;
  if (link !== undefined)
    throw new SetupError(SetupErrorCode.Link, MESSAGE.Link(path.join("Plugins", HELPER_FOLDER, link)));
}

async function assertWritable(project: Project, options: SetupOptions): Promise<void> {
  await assertNoLinks(project, [settingsIniPath(options.env)]);
  await assertHelperWritable(project, options);
}

async function assertEditorClosed(env: SetupEnv): Promise<void> {
  if (await env.editorRunning()) throw new SetupError(SetupErrorCode.EditorRunning, MESSAGE.EditorRunning());
}

/**
 * Whether a running Unreal Editor has this project open: the project's own log is still open, or
 * its own port answers for it. Without its log to read, any running editor might have it open.
 * The caller knows an editor runs; this never asks for the editor's process.
 */
export async function editorHasProject(
  env: SetupEnv,
  project: { file: string; directory: string },
  port: number | null | undefined,
): Promise<boolean> {
  if (!env.editorLog) return true;
  const log = await env.editorLog({ file: project.file, directory: project.directory }).catch(() => undefined);
  if (log?.open) return true;
  return typeof port === "number" && (await env.editorAnswers(port, project.file).catch(() => false));
}

/**
 * Refuses while Unreal Editor has this project open: it rewrites the project's settings when it
 * closes. Another project open in Unreal holds none of the files setup and undo write.
 */
async function assertProjectClosed(env: SetupEnv, project: Project, port: number | null | undefined): Promise<void> {
  const open = (await env.editorRunning()) && (await editorHasProject(env, project, port));
  if (open) throw new SetupError(SetupErrorCode.EditorRunning, MESSAGE.EditorRunning());
}

const recordFolder = (storage: string, project: Project) =>
  path.join(
    storage,
    SetupStorage.Folder,
    createHash("sha256").update(project.file).digest("hex").slice(0, RECORD_KEY_CHARS),
  );

async function readRecord(folder: string): Promise<SetupRecord | null> {
  return readJsonIfExists<SetupRecord>(path.join(folder, SetupStorage.Record));
}

/**
 * The port the project's editor will serve on after setup: its own (recorded, else in its
 * settings) while usable, else a free one from Genex's block that no other set-up project holds.
 */
async function projectPort(
  project: Project,
  settings: string,
  record: SetupRecord | null,
  options: SetupOptions,
): Promise<number> {
  const others = (await listSetUpProjects(options.storage)).filter((p) => p.project !== project.file);
  const port = await choosePort({
    project: project.file,
    current: record?.port ?? settingsPort(settings),
    taken: new Set(others.map((p) => p.port)),
    listening: options.env.portListening,
  });
  if (port === undefined) throw new SetupError(SetupErrorCode.NoFreePort, MESSAGE.NoFreePort());
  return port;
}

/** Keeps the project's copy of `relative` under `before/`, unless an earlier setup already did. */
async function keepCopy(folder: string, project: Project, relative: string): Promise<void> {
  const source = path.join(project.directory, relative);
  const copy = path.join(folder, "before", relative);
  if ((await lstat(copy).catch(() => null)) || !(await lstat(source).catch(() => null))) return;
  await cp(source, copy, { recursive: true, verbatimSymlinks: true });
}

/** The project's real `.uproject` path, as setup records it and the bridge, the list and the toolbar compare it. */
export const realProjectFile = (state: Pick<ProjectState, "real">) => state.real;

/** Whether a setup record names no port, or the same port the settings start Epic's server on. */
const recordAgrees = (record: SetupRecord | null, port: number) => record?.port === undefined || record.port === port;

/**
 * What a project has and still needs, read without changing anything. Its server starts by itself
 * only on a port in Genex's block: a port outside it (Epic's 8000) may be another project's, so
 * setup moves it.
 */
export async function inspectProject(file: string, options: SetupOptions): Promise<ProjectState> {
  const project = await resolveProject(file);
  const { json } = await readUProject(project);
  const settings = await readSettings(path.join(project.directory, settingsIniPath(options.env)));
  const record = await readRecord(recordFolder(options.storage, project));
  const port = autoStartPort(settings) ?? null;
  const state = {
    ...project,
    real: project.file,
    // The path as the user chose it, so the panel can tell which project this is; writes use the real one.
    file,
    engine: typeof json.EngineAssociation === "string" ? json.EngineAssociation : "",
    cpp: Array.isArray(json.Modules) && json.Modules.length > 0,
    plugins: pluginsOn(json),
    toolsets: toolsetsMissing(json, record).length === 0,
    autoStart: inProjectBlock(port) && recordAgrees(record, port),
    port,
    helper: await helperState(project, options.helper),
    undoable: record !== null,
  };
  const ready = state.plugins && state.toolsets && state.autoStart && !helperNeedsInstall(state.helper);
  return { ...state, ready };
}

/**
 * The switch setup makes for a project from an older Unreal: to the newest supported engine on
 * this computer. Nothing for a project of a supported, missing or source-built engine.
 */
async function engineSwitch(association: string, env: SetupEnv): Promise<EngineSwitch | undefined> {
  const engines = await findEngines(env);
  const newest = engines.find((e) => e.supported);
  if (!newest || engineMatch(association, engines) !== EngineMatch.TooOld) return undefined;
  return { from: association, to: newest.version };
}

/** Switches a project from an older Unreal in its descriptor and records from what; whether it did. */
async function switchEngine(json: UProject, record: SetupRecord, env: SetupEnv): Promise<boolean> {
  const association = typeof json.EngineAssociation === "string" ? json.EngineAssociation : "";
  const engine = await engineSwitch(association, env);
  if (!engine) return false;
  json.EngineAssociation = engine.to;
  record.engine = { previous: engine.from, switched: engine.to };
  return true;
}

/**
 * The changes setup would make in a project now, in the order it makes them, the port it would use,
 * and the Unreal it would switch a project from an older one to.
 */
export async function planSetup(
  file: string,
  options: SetupOptions,
): Promise<{ steps: SetupStep[]; port: number; engine?: EngineSwitch }> {
  const state = await inspectProject(file, options);
  const project = await resolveProject(file);
  const settings = await readSettings(path.join(project.directory, settingsIniPath(options.env)));
  const port = await projectPort(project, settings, await readRecord(recordFolder(options.storage, project)), options);
  const engine = await engineSwitch(state.engine, options.env);
  const steps: Array<[boolean, SetupStep]> = [
    [engine !== undefined, SetupStep.Engine],
    [!state.plugins || !state.toolsets, SetupStep.Plugins],
    [!state.autoStart || state.port !== port, SetupStep.AutoStart],
    [helperNeedsInstall(state.helper), SetupStep.Helper],
  ];
  return { steps: steps.filter(([needed]) => needed).map(([, step]) => step), port, engine };
}

/**
 * Sets a project up for Genex. Setting up a ready project changes none of its files, but records
 * it and its port the first time, so the bridge finds a project that was set up by hand. It
 * refuses only while Unreal has this very project open; an editor with another project open
 * doesn't hold it back. A project Genex has just made (`newProject`) cannot be open in Unreal.
 */
export async function setUpProject(
  file: string,
  options: SetupOptions,
  { newProject = false }: { newProject?: boolean } = {},
): Promise<ProjectState> {
  const project = await resolveProject(file);
  const { json, text } = await readUProject(project);
  await assertWritable(project, options);
  const folder = recordFolder(options.storage, project);
  const kept = await readRecord(folder);
  const record: SetupRecord = kept ?? { project: project.file, uproject: { added: [], enabled: [] } };
  const settingsFile = path.join(project.directory, settingsIniPath(options.env));
  const settings = await readSettings(settingsFile);
  if (!newProject) await assertProjectClosed(options.env, project, kept?.port ?? settingsPort(settings));
  const port = await projectPort(project, settings, kept, options);
  const engine = await switchEngine(json, record, options.env);
  const plugins = enablePlugins(json, record);
  const autoStart = withAutoStart(settings, port);
  record.ini ??= {
    sectionExisted: autoStart.sectionExisted,
    previous: autoStart.previous,
    fileExisted: await isFile(settingsFile),
  };
  // A newer helper stays as it is: setup never takes a project's helper back to an older one.
  const helper = helperNeedsInstall(await helperState(project, options.helper));
  record.helper ??= {
    existed: await isDirectory(helperTarget(project)),
    pluginsExisted: await isDirectory(path.dirname(helperTarget(project))),
  };
  const installed = record.helper.installed ?? {};
  const descriptor = plugins || engine;
  const changes = descriptor || autoStart.text !== settings || helper;
  if (kept?.port === port && !changes) return inspectProject(file, options);
  record.port = port;

  for (const relative of [
    path.basename(project.file),
    settingsIniPath(options.env),
    path.join("Plugins", HELPER_FOLDER),
  ])
    await keepCopy(folder, project, relative);
  // What setup is about to write, recorded first, so an undo after a failed install still knows it.
  if (helper) record.helper.installed = { ...installed, ...(await shippedHashes(options.helper)) };
  await atomicWriteJson(path.join(folder, SetupStorage.Record), record);
  if (descriptor) await atomicWriteText(project.file, formatLike(text, json));
  if (autoStart.text !== settings) await atomicWriteText(settingsFile, autoStart.text);
  // On the first setup `before/` holds the helper as it was; later, a file the user changed is kept as `.mine`.
  if (helper) await installHelper(project, options.helper, kept ? installed : undefined);
  return inspectProject(file, options);
}

/**
 * Records a project whose files are already set up (another Genex profile on this computer set it
 * up, and its set-up record stays in that profile's storage) without writing a byte of the project
 * or asking for Unreal to be closed: Epic's plugins and toolsets on, its server starting on a port
 * of Genex's block that no other project set up here holds, and a Genex editor helper in it (an
 * outdated one is updated by the usual Open). The record names what this profile changed: nothing,
 * so an Undo only forgets it. Answers the project's state once recorded (an already recorded one as
 * it is), or undefined while it still needs setup's changes.
 */
export async function adoptSetUp(file: string, options: SetupOptions): Promise<ProjectState | undefined> {
  const state = await inspectProject(file, options);
  if (state.undoable) return state;
  const { port } = state;
  const filesSetUp = state.plugins && state.toolsets && state.autoStart && state.helper !== HelperState.Missing;
  if (!filesSetUp || port === null) return undefined;
  const others = await listSetUpProjects(options.storage);
  if (others.some((other) => other.project !== state.real && other.port === port)) return undefined;
  const project = await resolveProject(file);
  const record: SetupRecord = { project: project.file, port, uproject: { added: [], enabled: [] } };
  await atomicWriteJson(path.join(recordFolder(options.storage, project), SetupStorage.Record), record);
  return inspectProject(file, options);
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Each file of the shipped helper with the sha256 of its bytes. */
async function shippedHashes(helper: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const file of await shippedHelperFiles(helper)) hashes[file] = sha256(await readFile(path.join(helper, file)));
  return hashes;
}

/** A free name beside `file` for the user's own copy of it. */
async function mineName(file: string): Promise<string | undefined> {
  for (let n = 1; n <= MINE_COPIES_CAP; n++) {
    const candidate = `${file}${MINE_SUFFIX}${n === 1 ? "" : n}`;
    if (!(await lstat(candidate).catch(() => null))) return candidate;
  }
  return undefined;
}

/**
 * Before setup overwrites a helper file, keeps the user's version as `<file>.mine` when its bytes
 * are neither the shipped file's nor what setup wrote last time: the user changed it. Answers the
 * copy's path, or undefined when nothing was kept.
 */
async function keepUsersVersion(
  file: string,
  shipped: Buffer,
  installed: string | undefined,
): Promise<string | undefined> {
  if (!(await isFile(file))) return undefined;
  const theirs = sha256(await readFile(file));
  if (theirs === sha256(shipped) || theirs === installed) return undefined;
  const mine = await mineName(file);
  if (mine) await cp(file, mine, { errorOnExist: true, force: false });
  return mine;
}

/**
 * Writes the shipped helper; with `installed` (a later setup or an update), keeps any file the user
 * changed first. Answers the `.mine` copies it kept.
 */
async function installHelper(project: Project, helper: string, installed?: Record<string, string>): Promise<string[]> {
  const kept: string[] = [];
  for (const file of await shippedHelperFiles(helper)) {
    const target = path.join(helperTarget(project), file);
    const shipped = await readFile(path.join(helper, file));
    const mine = installed ? await keepUsersVersion(target, shipped, installed[file]) : undefined;
    if (mine) kept.push(mine);
    await atomicWriteText(target, shipped.toString("utf8"));
  }
  return kept;
}

/**
 * Records the shipped helper as installed before it is written, so undo takes it back out; the
 * first time Genex touches the helper, it also keeps the helper as it was.
 */
async function recordHelperInstall(folder: string, project: Project, record: SetupRecord, helper: string) {
  if (!record.helper) {
    const target = helperTarget(project);
    record.helper = { existed: await isDirectory(target), pluginsExisted: await isDirectory(path.dirname(target)) };
    await keepCopy(folder, project, path.join("Plugins", HELPER_FOLDER));
  }
  record.helper.installed = { ...record.helper.installed, ...(await shippedHashes(helper)) };
  await atomicWriteJson(path.join(folder, SetupStorage.Record), record);
}

/** A path inside the project as the user reads it: relative to the project folder, `/`-separated. */
const projectRelative = (project: Project, file: string) =>
  path.relative(project.directory, file).split(path.sep).join("/");

/**
 * Brings a set-up project's Genex editor helper up to the shipped one, touching nothing outside
 * `Plugins/GenexEditorHelper`: never the .uproject, never an ini. A helper file the user changed is
 * kept beside the new one as `<file>.mine`; a current or newer helper is left as it is. Refuses,
 * writing nothing, while Unreal Editor runs, for a project Genex hasn't set up, and when any path
 * the helper is written to is a link.
 */
export async function updateHelper(file: string, options: SetupOptions): Promise<HelperUpdate> {
  const project = await resolveProject(file);
  await assertHelperWritable(project, options);
  await assertEditorClosed(options.env);
  const folder = recordFolder(options.storage, project);
  const record = await readRecord(folder);
  if (!record) throw new SetupError(SetupErrorCode.NotSetUp, MESSAGE.NotSetUp());
  const versions = { from: await projectHelperVersion(project), to: (await helperVersion(options.helper)) ?? "" };
  if (!helperNeedsInstall(await helperState(project, options.helper))) return { ...versions, kept: [] };
  // What Genex wrote last time: a file still holding it was never changed by the user.
  const installed = record.helper?.installed ?? {};
  await recordHelperInstall(folder, project, record, options.helper);
  const kept = await installHelper(project, options.helper, installed);
  return { ...versions, kept: kept.map((mine) => projectRelative(project, mine)) };
}

/**
 * Adds Epic's toolsets for games to a set-up project that lacks them (one Genex set up before it
 * added them), touching nothing but the .uproject, and records them so undo takes them back out.
 * Refuses, writing nothing, while Unreal Editor runs and for a project Genex hasn't set up.
 * Answers the toolsets it added: none when the project names them all.
 */
export async function addToolsetPlugins(file: string, options: SetupOptions): Promise<string[]> {
  const project = await resolveProject(file);
  await assertEditorClosed(options.env);
  const folder = recordFolder(options.storage, project);
  const record = await readRecord(folder);
  if (!record) throw new SetupError(SetupErrorCode.NotSetUp, MESSAGE.NotSetUp());
  const { json, text } = await readUProject(project);
  const added = addToolsets(json, record);
  if (added.length === 0) return [];
  await keepCopy(folder, project, path.basename(project.file));
  // Recorded first, so an undo after a failed write still knows what to take out.
  await atomicWriteJson(path.join(folder, SetupStorage.Record), record);
  await atomicWriteText(project.file, formatLike(text, json));
  return added;
}

/** Removes a folder only while it is empty: anything the user put there since keeps it. */
async function removeIfEmpty(dir: string): Promise<void> {
  await rmdir(dir).catch(() => undefined);
}

/**
 * Takes the helper back out without removing anything the user made: each file setup wrote goes
 * only while its bytes are still the ones setup wrote, Python's caches go, and folders go only once
 * empty. A helper that was there before setup gets back each of its files that is now missing.
 * Returns the helper files left because the user changed them.
 */
async function restoreHelper(
  project: Project,
  folder: string,
  record: SetupRecord,
  options: SetupOptions,
): Promise<string[]> {
  if (!record.helper) return [];
  const target = helperTarget(project);
  const read = options.env.readEntries ?? readEntries;
  const installed = record.helper.installed ?? (await shippedHashes(options.helper));
  const kept: string[] = [];
  for (const [relative, hash] of Object.entries(installed)) {
    const file = path.join(target, relative);
    if (!(await isFile(file))) continue;
    if (sha256(await readFile(file)) === hash) await rm(file, { force: true });
    else kept.push(relative);
  }
  const walked = (await isDirectory(target)) ? await walk(target, read) : { files: [], folders: [], links: [] };
  for (const cache of walked.folders.filter((dir) => path.basename(dir) === PYTHON_CACHE))
    await rm(path.join(target, cache), { recursive: true, force: true });
  for (const dir of walked.folders.reverse()) await removeIfEmpty(path.join(target, dir));
  await removeIfEmpty(target);
  if (record.helper.existed)
    await cp(path.join(folder, "before", "Plugins", HELPER_FOLDER), target, { recursive: true, force: false });
  else if (record.helper.pluginsExisted === false) await removeIfEmpty(path.dirname(target));
  return kept;
}

/**
 * Takes the MCP section back out of the project's settings; a file setup made that holds nothing
 * else afterwards goes too, while one Unreal or the user has written to since stays.
 */
async function restoreSettings(project: Project, record: SetupRecord, env: SetupEnv): Promise<void> {
  const settingsFile = path.join(project.directory, settingsIniPath(env));
  const settings = await readSettings(settingsFile);
  const withoutSection = record.ini ? withoutAutoStart(settings, record.ini) : settings;
  const madeBySetup = record.ini?.fileExisted === false && withoutSection.trim() === "";
  if (madeBySetup) await rm(settingsFile, { force: true });
  else if (withoutSection !== settings) await atomicWriteText(settingsFile, withoutSection);
}

/**
 * Forgets setup's record of the project at `file` (its port, its copies of what setup replaced)
 * without touching the project: for a project Genex made and is about to remove. Nothing when the
 * project isn't there.
 */
export async function forgetSetup(file: string, storage: string): Promise<void> {
  const project = await resolveProject(file).catch(() => null);
  if (project) await rm(recordFolder(storage, project), { recursive: true, force: true });
}

/**
 * Takes back what setup added and nothing else: the user's own later changes stay. `kept` names
 * the helper files left in place because the user changed them.
 */
export async function undoSetup(file: string, options: SetupOptions): Promise<ProjectState & { kept: string[] }> {
  const project = await resolveProject(file);
  const folder = recordFolder(options.storage, project);
  const record = await readRecord(folder);
  if (!record) throw new SetupError(SetupErrorCode.NothingToUndo, MESSAGE.NothingToUndo());
  const { json, text } = await readUProject(project);
  await assertWritable(project, options);
  await assertProjectClosed(options.env, project, record.port);

  restorePlugins(json, record);
  // Back to its own Unreal, unless the user has since moved it to yet another one.
  if (record.engine && json.EngineAssociation === record.engine.switched)
    json.EngineAssociation = record.engine.previous;
  const restored = formatLike(text, json);
  if (restored !== text) await atomicWriteText(project.file, restored);
  await restoreSettings(project, record, options.env);
  const kept = await restoreHelper(project, folder, record, options);
  await rm(folder, { recursive: true, force: true });
  return { ...(await inspectProject(file, options)), kept };
}
