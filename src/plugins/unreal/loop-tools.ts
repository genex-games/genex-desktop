/**
 * The Unreal plugin's tools for the Unreal Loop. Builders call `check-part` (the gate, no editor).
 * The Loop's runner calls the rest on the game folder: `run-part` puts a part that passes the gate
 * in the editor queue and answers at once, `part-result` reads where it stands (with its play shots
 * once done), `rollback-part` and `reload-level` take a rejected part back out of the editor, and
 * `export-reference` keeps the engine's node reference and Python names for the gate, and has the
 * editor write the template's project file (its game mode, Blueprints and input actions), whose
 * Blueprints the gate and `find-nodes` then know. A C++ part's `check-part` also compiles the
 * builder's copy with UnrealBuildTool in its sandbox (`part-compile.ts`, `ubt-sandbox.ts`), never
 * the game's own folder, whose module the open editor has loaded; `run-part` checks it without
 * compiling and hands the queue its code, which the queue copies into the game and hot-reloads.
 * `cpp-status` and `add-cpp-module` (`cpp-tools.ts`) tell the runner whether C++ compiles here and
 * add the game's C++ module. The queue watches the editor for a crash while a part is in it, and
 * after one the runner has `reopen-editor` and `editor-state` (`editor-reopen.ts`) reopen Unreal.
 *
 * The Unreal lead's save points and restarts have their own tools beside these
 * ({@link LiveLoopToolName}): `play-check` queues a play of the game with the board's checks (read
 * with `part-result`), `save-all` saves the editor's work (ending a play session first, which the
 * helper's save refuses to save under), `log-errors` reads the editor log's new error lines,
 * `end-editor` ends this project's editor for a cold restore, and `update-helper` updates the
 * project's Genex editor helper while Unreal is closed. And ({@link LeadLoopToolName})
 * `editor-activity` says whether a play session runs and how much is unsaved, before any save, and
 * `hero-shots` takes the level's hero cameras' stills for a save point's thumbnails.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginContext } from "../../plugin-sdk/index.d.ts";
import { type HookAnswer, type HookContext, HookEvent } from "../../shared/plugin-hooks.ts";
import { agentPlaying, forgetAgentPlay } from "./agent-play.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { atomicWriteJson, isJsonObject, readRegularFile } from "../../substrate/fsx.ts";
import { Severity } from "./blueprint-check.ts";
import {
  BaseClass,
  type BlueprintDecl,
  contextKey,
  GraphKind,
  type NodePins,
  projectNodes,
  type ReferenceData,
} from "./blueprint-reference.ts";
import type { addCppModule } from "./cpp-module.ts";
import { CppEditorTool, createCppTools, landPartCpp } from "./cpp-tools.ts";
import {
  type CrashCheck,
  editorLogPath,
  errorLinesSince,
  type LogErrors,
  type LogPlace,
  userHome,
} from "./editor-log.ts";
import { BUILD_TOOLSET, CaptureTool, landedShot } from "./editor-captures.ts";
import {
  endAtMoment,
  healthAtMoment,
  type MomentOps,
  openForRun,
  reopenAtMoment,
  saveAtMoment,
} from "./editor-moments.ts";
import { createReopenTools, type ProcessEnv } from "./editor-reopen.ts";
import type { EditorRestart } from "./editor-restart.ts";
import { EditorStart } from "./editor-status.ts";
import { inRun, logAnswer, probeAnswer, shotsAnswer } from "./hook-answers.ts";
import { HELPER_TOOLSET } from "./editor-port.ts";
import {
  createEditorQueue,
  type EditorPort,
  type EditorQueue,
  LOOP_TOOLSET,
  LoopTool,
  type PartCode,
  pollUntil,
} from "./editor-queue.ts";
import { OBJECT_TOOLSET } from "./editor-throttle.ts";
import { GAME_PROJECT_FOLDER } from "./game-folder.ts";
import { copyStamp, PART_NAME, readOtherParts, readPartCpp, readPartFiles } from "./part-files.ts";
import {
  CppSupport,
  checkPart,
  type OtherPart,
  type PartCpp,
  PartFile,
  type PartFiles,
  type PartProblem,
  PartProblemCode,
} from "./part-check.ts";
import { type CompileJobs, compileWaitMs, cppFingerprint, createCompileJobs, freshenSources } from "./part-compile.ts";
import { parsePartManifest } from "./part-manifest.ts";
import { type PartCheck, parsePartTest, readPartCheck } from "./part-test.ts";
import { readBlueprintGuide } from "./blueprint-guide.ts";
import { PROJECT_EXPORT, projectExported, readProjectBlueprints } from "./project-blueprints.ts";
import { checkPython, type PythonCpp, PythonProblemCode, unrealPython } from "./python-check.ts";
import { loadReference, parseReference, referencePaths, storeReference } from "./reference-store.ts";
import {
  HELPER_FOLDER,
  type HelperUpdate,
  type SetupEnv,
  type SetupOptions,
  systemSetupEnv,
  updateHelper,
} from "./setup.ts";
import { toneOf } from "./tone.ts";
import { type CompileOptions, type CompileResult, canCompileCpp, compileEditor } from "./ubt.ts";
import type { XcodeStatus } from "./xcode.ts";

/** The editor tools the Loop uses beyond the queue's own. */
export const LoopEditorTool = {
  RollbackPart: "rollback_part",
  ReloadLevel: "reload_level",
  ExportReference: "export_reference",
  ExportPythonNames: "export_python_names",
  ExportProject: "export_project",
} as const;
export type LoopEditorTool = (typeof LoopEditorTool)[keyof typeof LoopEditorTool];

/** The build toolset's tools the lead's hero shots use: the level's hero cameras, and a still from one. */
export const HeroShotTool = { ShotCameras: "shot_cameras", CaptureShot: CaptureTool.Shot } as const;
export type HeroShotTool = (typeof HeroShotTool)[keyof typeof HeroShotTool];

/** Any editor tool the Loop calls. */
export type AnyLoopTool = LoopTool | LoopEditorTool | CppEditorTool | HeroShotTool;

/** Epic's toolset that starts play. */
const EPIC_APP_TOOLSET = "EditorToolset.EditorAppToolset";
/** The toolset each editor tool the Loop calls lives in. */
export const TOOLSET_OF = {
  [LoopTool.ApplyPart]: LOOP_TOOLSET,
  [LoopTool.StartPlay]: EPIC_APP_TOOLSET,
  [LoopTool.Hold]: HELPER_TOOLSET,
  [LoopTool.CapturePlay]: LOOP_TOOLSET,
  [LoopTool.GameState]: LOOP_TOOLSET,
  [LoopTool.StopPlay]: LOOP_TOOLSET,
  [LoopTool.PlayState]: LOOP_TOOLSET,
  [LoopTool.EditorActivity]: LOOP_TOOLSET,
  [LoopTool.ProbeCharacters]: LOOP_TOOLSET,
  [LoopTool.ProbeView]: LOOP_TOOLSET,
  [LoopTool.RecompileModule]: LOOP_TOOLSET,
  [LoopTool.Settle]: HELPER_TOOLSET,
  [LoopTool.DriveRoute]: HELPER_TOOLSET,
  [LoopTool.ProbeRoute]: HELPER_TOOLSET,
  [LoopTool.PlayerState]: HELPER_TOOLSET,
  [LoopTool.GetProperties]: OBJECT_TOOLSET,
  [LoopTool.SetProperties]: OBJECT_TOOLSET,
  [LoopEditorTool.RollbackPart]: LOOP_TOOLSET,
  [LoopEditorTool.ReloadLevel]: LOOP_TOOLSET,
  [LoopEditorTool.ExportReference]: LOOP_TOOLSET,
  [LoopEditorTool.ExportPythonNames]: LOOP_TOOLSET,
  [LoopEditorTool.ExportProject]: LOOP_TOOLSET,
  [CppEditorTool.SaveAll]: LOOP_TOOLSET,
  [HeroShotTool.ShotCameras]: BUILD_TOOLSET,
  [HeroShotTool.CaptureShot]: BUILD_TOOLSET,
} as const satisfies Record<AnyLoopTool, string>;

/** The Loop's tools, by their names after `unreal__`. */
export const LoopToolName = {
  CheckPart: "check-part",
  RunPart: "run-part",
  PartResult: "part-result",
  RollbackPart: "rollback-part",
  ReloadLevel: "reload-level",
  ExportReference: "export-reference",
  BlueprintGuide: "blueprint-guide",
  FindNodes: "find-nodes",
  CppStatus: "cpp-status",
  AddCppModule: "add-cpp-module",
  ReopenEditor: "reopen-editor",
  EditorState: "editor-state",
} as const;
export type LoopToolName = (typeof LoopToolName)[keyof typeof LoopToolName];

/**
 * The Unreal lead's harness tools for saves and restarts (the seed's `UnrealLivePluginTool`),
 * by their names after `unreal__`: the checkpoint's play in the editor (read with `part-result`),
 * saving everything, the editor log's new errors, ending the game's editor, and updating the
 * project's Genex editor helper while Unreal is closed. Kept apart from {@link LoopToolName}, the
 * part tools.
 */
export const LiveLoopToolName = {
  PlayCheck: "play-check",
  SaveAll: "save-all",
  LogErrors: "log-errors",
  EndEditor: "end-editor",
  UpdateHelper: "update-helper",
} as const;
export type LiveLoopToolName = (typeof LiveLoopToolName)[keyof typeof LiveLoopToolName];

/**
 * The Unreal lead's harness tools (the seed's `LeadPluginTool`), by their names after `unreal__`:
 * what the game's editor is doing (`{pie, dirty}`: a play session runs, how many packages are
 * unsaved), which every save of the editor's work asks first, and the hero cameras' stills a save
 * point keeps as thumbnails.
 */
export const LeadLoopToolName = {
  EditorActivity: "editor-activity",
  HeroShots: "hero-shots",
} as const;
export type LeadLoopToolName = (typeof LeadLoopToolName)[keyof typeof LeadLoopToolName];

/** The Unreal plugin's harness tools for Genex's moments only, by their names after `unreal__`. */
export const MomentToolName = { OpenForRun: "open-for-run" } as const;
export type MomentToolName = (typeof MomentToolName)[keyof typeof MomentToolName];

/** The most node types one lookup answers. */
const MAX_FOUND_NODES = 40;
const BASES: ReadonlySet<string> = new Set(Object.values(BaseClass));
const GRAPHS: ReadonlySet<string> = new Set(Object.values(GraphKind));

/** The largest play shot read back. */
const MAX_SHOT_BYTES = 16 * 1024 * 1024;
/** Where the editor writes the exported reference, inside the project. */
const EXPORT_FOLDER = path.join("Saved", "Genex");

const MESSAGE = {
  NoFolder: "This call needs a game: run it from a game's chat or build.",
  NoGame: "This call needs a game.",
  BadPart: (part: string) => `${JSON.stringify(part)} is not a part name.`,
  NoEngine: "No supported Unreal is installed, so the Loop can't use the editor.",
  NotPassing: (part: string, problems: string) => `${part} doesn't pass its checks yet:\n${problems}`,
  Passes: (part: string, unverified: number) =>
    unverified ? `${part} passes (${unverified} not verified yet; the editor checks those).` : `${part} passes.`,
  Problems: (part: string, count: number, list: string) =>
    `${part} has ${count} ${count === 1 ? "problem" : "problems"} to fix before it can go to the editor:\n${list}`,
  UnknownRun: (id: string) => `There is no part run ${id}.`,
  NoProject: "This game has no Unreal project yet.",
  NoReference: "There is no node reference for this engine yet; check-part still reads the text without it.",
  NoQuery: 'find-nodes needs a query: a few words of the node\'s name, such as "set intensity".',
  BadReference: "The editor's node reference didn't have the expected shape; it was not kept.",
  Meant: (message: string, names: readonly string[]) => `${message} Did you mean ${names.join(" or ")}?`,
  StillCompiling:
    "is still compiling (a first compile takes a minute or two). Call check-part again in a minute: the compile keeps running, and that call answers with its result.",
  NoChecks:
    'play-check needs checks: an object of board ids, each {"tag": "genex:…", "exists"} or {"player", "atLeast" and/or "atMost"}.',
  TooManyChecks: (max: number) => `play-check takes at most ${max} checks.`,
  BadBoardId: (id: string) => `${JSON.stringify(id.slice(0, 48))} is not a board id.`,
  BadCheck: (id: string) =>
    `${id}: a check is {"tag": "genex:…", "exists": true or false} or {"player": field, "atLeast" and/or "atMost": number}.`,
  ChecksRefused: (problems: string[]) => `play-check queued nothing:\n${problems.join("\n")}`,
  NotAnswering: "This game's Unreal isn't answering, so Genex saved nothing.",
  CantTellUse: "This game's Unreal runs but isn't answering, so Genex can't tell whether you are using it.",
  NoSaveAnswer: "The Genex editor helper didn't answer save_all with what it saved.",
  StillPlaying: "This game's Unreal is still in a play session after Genex asked it to stop, so Genex saved nothing.",
  NoLinkedProject: "This game isn't linked to an Unreal project.",
  BadSince: "since must be a byte offset a log-errors call answered: a whole number, 0 or more.",
  HelperWhileOpen:
    "Unreal is open on this game, so Genex didn't update its editor helper. Save (save-all), end the editor (end-editor), then update.",
  NoActivityAnswer: "The Genex editor helper didn't answer editor_activity with its play state and unsaved packages.",
  BadPrefix: "hero-shots needs a prefix: the start of the hero cameras' labels, such as GX_Shot_.",
  BadMax: (most: number) => `hero-shots needs max: how many cameras to capture, a whole number from 1 to ${most}.`,
  NoCameras: "The Genex editor helper didn't answer shot_cameras with the level's hero cameras.",
} as const;

/** The only platform Unreal C++ is compiled on (Xcode). */
const MAC: NodeJS.Platform = "darwin";
/** The largest module rules file read into a compile's fingerprint. */
const MAX_RULES_BYTES = 64 * 1024;
const SOURCE_FOLDER = "Source";
const RULES_SUFFIX = ".Build.cs";
/** A part that lists no C++ never asks Xcode. */
const NO_CPP: CppSupportFound = { support: CppSupport.NoXcode, app: null };
/** Python's problems that don't fail a part: the check couldn't run, or the name may come from C++. */
const UNVERIFIED_PYTHON: ReadonlySet<PythonProblemCode> = new Set([
  PythonProblemCode.Unavailable,
  PythonProblemCode.Unverified,
]);

/** The most checks one play-check reads, and a board id's shape: `harness:spawn-facing`, `feature:<id>:<n>`. */
const MAX_PLAY_CHECKS = 40;
const BOARD_ID = /^(?=.{1,96}$)[A-Za-z][A-Za-z0-9-]*(?::[A-Za-z0-9-]+){0,3}$/;
/** How long a play-check waits for the person working in the editor before it fails as owner-busy. */
const PLAY_CHECK_OWNER_WAIT_MS = 3 * MINUTE_MS;
/** How long `save-all` waits for a play session it stopped to end (it ends on a later frame), and how often it asks. */
const PLAY_STOP_WAIT_MS = 15 * SECOND_MS;
const PLAY_STOP_POLL_MS = 250;
/** A hero still: its size, how long Lumen and the fog settle first, and how many one call captures at most. */
const HERO_SHOT_WIDTH = 960;
const HERO_SHOT_HEIGHT = 540;
const HERO_SHOT_DELAY_S = 2;
const MAX_HERO_SHOTS = 8;
/** The start of the hero cameras' labels Genex's skill has the agent place (`gx.shot_camera`). */
const HERO_CAMERA_PREFIX = "GX_Shot_";
/** No still is asked for once a hero-shots call has run this long: its caller's save point is waiting. */
const HERO_SHOTS_WAIT_MS = MINUTE_MS;
/** A hero cameras' prefix: the start of a label, in label characters. */
const HERO_PREFIX = /^[A-Za-z0-9_]{1,32}$/;
/** How many log offsets `log-errors` remembers the log's file of, to tell a log Unreal started anew. */
const MAX_LOG_PLACES = 256;
/** How many games' log marks `log-errors` keeps at once. */
const MAX_LOG_MARKS = 256;
/** How many new log lines a checkpoint's note counts. */
const MAX_MOMENT_LOG_LINES = 20;

/** The Genex editor helper this plugin ships, beside its backend: in the build and in the source. */
const SHIPPED_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), HELPER_FOLDER);

/** What the tools need from the computer and the editor. */
export type LoopToolsDeps = {
  platform: NodeJS.Platform;
  /** The supported engine's version and folder, or undefined without one. */
  engine(): Promise<{ version: string; directory: string } | undefined>;
  /** The game's linked project file in the plugin's storage, or undefined. */
  project(storage: string, game: string): Promise<string | undefined>;
  /** Where Xcode stands against the engine in `engineDir` (C++ compiles only when Ready on a Mac), and its app. */
  xcode(engineDir: string | undefined): Promise<Pick<XcodeStatus, "state"> & Partial<Pick<XcodeStatus, "app">>>;
  /** Compiles a game copy's editor target; UnrealBuildTool's own unless a test stands in. */
  compile?(options: CompileOptions): Promise<CompileResult>;
  /** Writes a Blueprint project's C++ module; `addCppModule` unless a test stands in. */
  addModule?: typeof addCppModule;
  /**
   * Calls an editor tool on the game's own editor; answers its return value (parsed when JSON). A
   * call that blocks the editor longer than most (a hot reload) names its own `timeoutMs`.
   */
  editorCall(
    storage: string,
    game: string,
    tool: AnyLoopTool,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown>;
  editorAnswers(storage: string, game: string): Promise<boolean>;
  /** How many editors run, and quitting and opening the game's, for adding its C++ module and reopening it. */
  restart: EditorRestart;
  /** Starts watching the game's editor for a crash (its log and its process); without it the queue sees none. */
  watchCrash?(storage: string, game: string): Promise<CrashCheck>;
  /** This computer's processes, for ending a crashed editor and its crash reporter; without them none is ended. */
  processes?: ProcessEnv;
  now(): number;
  /** Waits `ms`; ends early (and may reject) when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** The account's home, where Unreal writes a Mac project's log; `userHome()` unless a test stands in. */
  home?: string;
  /** What setup reads and writes for a game's project: this computer and the shipped helper unless a test stands in. */
  setup?(storage: string): SetupOptions;
  /** Updates a project's Genex editor helper; `updateHelper` unless a test stands in. */
  updateHelper?: typeof updateHelper;
  /** Where Genex's own start of the game's set-up project stands (the toolbar's Starting); null without one. */
  starting?(storage: string, game: string): Promise<EditorStart | null>;
};

type Handler = (args: Record<string, unknown>, context: PluginContext, storage: string) => Promise<unknown>;
type Engine = { version: string; directory: string };
/**
 * What a C++ part's compile needs once its checks pass: the engine, the Xcode app, the copy's
 * project file (by real path), the module and the part's C++.
 */
type CompileTarget = {
  engineDir: string;
  xcodeApp: string | null;
  projectFile: string;
  module: string;
  folder: string;
  files: PartCpp["files"];
};
/** Whether this computer compiles C++, and the Xcode app it would use. */
type CppSupportFound = { support: CppSupport; app: string | null };

const text = (args: Record<string, unknown>, key: string) => (typeof args[key] === "string" ? args[key].trim() : "");

/** One problem as a line of the gate's answer (`- <file>:<line>: <message>`); its message already names what it meant. */
function where(problem: PartProblem): string {
  const at = problem.line ? `${problem.file}:${problem.line}` : problem.file;
  return `- ${at}: ${problem.message}`;
}

/** The game's linked project file, or undefined without a game or a link that reads. */
async function linkedProject(deps: LoopToolsDeps, storage: string, game: string | undefined) {
  // A link that can't be read leaves the gate checking against the parts alone, as before an export.
  return game ? await deps.project(storage, game).catch(() => undefined) : undefined;
}

/** The template's Blueprints the editor exported for the game's linked project; [] without a game or file. */
async function templateBlueprints(deps: LoopToolsDeps, storage: string, game: string | undefined) {
  return readProjectBlueprints(await linkedProject(deps, storage, game));
}

/** Whether this computer compiles the game's C++ (a Mac whose Xcode is ready for the engine), and with which Xcode. */
async function cppSupportOf(deps: LoopToolsDeps, engine: Engine | undefined): Promise<CppSupportFound> {
  if (deps.platform !== MAC) return { support: CppSupport.NotMac, app: null };
  const xcode = await deps.xcode(engine?.directory).catch(() => undefined);
  const support = xcode && canCompileCpp(xcode, deps.platform) ? CppSupport.Ready : CppSupport.NoXcode;
  return { support, app: xcode?.app ?? null };
}

/** The C++ classes part.json lists, or none when it doesn't read. */
function listedCpp(manifest: unknown): string[] {
  const parsed = manifest === undefined ? undefined : parsePartManifest(manifest);
  return parsed?.ok ? parsed.part.cpp : [];
}

/** apply.py's problems from Unreal's own Python, with the game's module and every part's C++ classes. */
async function pythonProblems(
  deps: LoopToolsDeps,
  storage: string,
  engine: Engine,
  apply: string,
  cpp: PythonCpp | undefined,
): Promise<PartProblem[]> {
  const names = referencePaths(storage, engine.version).python;
  const known = await stat(names).then(
    () => names,
    () => null,
  );
  const env = { python: unrealPython(engine.directory, deps.platform), names: known, ...(cpp ? { cpp } : {}) };
  return (await checkPython(env, apply)).map((p) => ({
    file: PartFile.Apply,
    line: p.line,
    code: PartProblemCode.Apply,
    severity: UNVERIFIED_PYTHON.has(p.code) ? Severity.Unverified : Severity.Error,
    // The Blueprint checker names its suggestions in its message; Python's are named here.
    message: p.suggestions?.length ? MESSAGE.Meant(p.message, p.suggestions) : p.message,
    ...(p.suggestions?.length ? { suggestions: p.suggestions } : {}),
  }));
}

/** What check-part does with a C++ part's compile: run it in the copy, or leave it to the editor in the game's own folder. */
type CompilePlan = { target: CompileTarget } | { inGame: true } | undefined;

/** The copy's project file by real path, or undefined when `directory` is the game's own project folder. */
async function copyProjectFile(directory: string, linked: string): Promise<string | undefined> {
  const [unreal, game] = await Promise.all([
    realpath(path.join(directory, GAME_PROJECT_FOLDER)).catch(() => undefined),
    realpath(path.dirname(linked)).catch(() => undefined),
  ]);
  // The game's own folder is the open editor's project, whose module it has loaded and compiles.
  if (unreal === undefined || unreal === game) return undefined;
  return path.join(unreal, path.basename(linked));
}

/**
 * Where a C++ part compiles, when its own checks found nothing wrong with its C++: the builder's
 * copy, or nowhere in the game's own folder (the editor compiles it there); else undefined.
 */
async function compilePlan(
  directory: string,
  listed: string[],
  cpp: PartCpp | undefined,
  context: { engine: Engine | undefined; linked: string | undefined; found: CppSupportFound; errors: PartProblem[] },
): Promise<CompilePlan> {
  const cppFails = context.errors.some((p) => p.code === PartProblemCode.Cpp);
  const nothingToCompile = listed.length === 0 || cppFails || context.found.support !== CppSupport.Ready;
  const { engine, linked } = context;
  const module = cpp?.module;
  const folder = cpp?.folder;
  const located = engine !== undefined && linked !== undefined && module !== undefined && folder !== undefined;
  if (nothingToCompile || !located) return undefined;
  const projectFile = await copyProjectFile(directory, linked);
  if (projectFile === undefined) return { inGame: true };
  const files = cpp?.files ?? {};
  return { target: { engineDir: engine.directory, xcodeApp: context.found.app, projectFile, module, folder, files } };
}

/** A part's problems from the gate's own checks and Unreal's Python, with Xcode's probe run beside the Python. */
async function gateProblems(deps: LoopToolsDeps, storage: string, read: GateRead) {
  const { part, files, engine, linked, others, cpp, listed } = read;
  const reference: ReferenceData | null = engine ? await loadReference(storage, engine.version) : null;
  // Xcode's probe and apply.py's check take seconds each, so they run at once.
  const [found, python] = await Promise.all([
    listed.length > 0 ? cppSupportOf(deps, engine) : Promise.resolve(NO_CPP),
    engine && files.apply !== undefined
      ? pythonProblems(deps, storage, engine, files.apply, pythonCpp(cpp, listed, others))
      : Promise.resolve([]),
  ]);
  const checked = { ...files, ...(cpp ? { cpp } : {}) };
  const result = checkPart(part, checked, reference, others, await readProjectBlueprints(linked), {
    cppSupport: found.support,
  });
  return { found, problems: [...result.problems, ...python] };
}

/** What the gate reads of a part and its game before checking it. */
type GateRead = {
  part: string;
  files: PartFiles;
  engine: Engine | undefined;
  linked: string | undefined;
  others: OtherPart[];
  cpp: PartCpp | undefined;
  listed: string[];
};

/**
 * The gate's answer for a part in `directory`, with its Python checked by Unreal's own Python and,
 * for a C++ part that passes its own C++ checks, what to compile it with (check-part does).
 */
async function gate(deps: LoopToolsDeps, storage: string, directory: string, part: string, game?: string) {
  const { dir, files } = await readPartFiles(directory, part);
  const engine = await deps.engine();
  const linked = await linkedProject(deps, storage, game);
  const others = await readOtherParts(directory);
  const cpp = linked ? await readPartCpp(part, { copy: directory, project: linked }) : undefined;
  const listed = listedCpp(files.manifest);
  const read: GateRead = { part, files, engine, linked, others, cpp, listed };
  const { found, problems } = await gateProblems(deps, storage, read);
  const errors = problems.filter((p) => p.severity === Severity.Error);
  const plan = await compilePlan(directory, listed, cpp, { engine, linked, found, errors });
  const unverified = problems.length - errors.length;
  return { dir, files, ok: errors.length === 0, errors, unverified, plan, code: partCode(directory, read) };
}

/**
 * What the queue needs of a C++ part: the copy whose code it brings in, the game's project, its
 * module and the classes part.json lists; undefined for a Blueprint-only part.
 */
function partCode(copy: string, read: Pick<GateRead, "listed" | "cpp" | "linked">): PartCode | undefined {
  const module = read.cpp?.module;
  if (read.listed.length === 0 || module === undefined || read.linked === undefined) return undefined;
  return { copy, project: read.linked, module, classes: read.listed };
}

/** The game's module and every part's C++ classes, for apply.py's check; undefined in a Blueprint game. */
function pythonCpp(cpp: PartCpp | undefined, listed: string[], others: OtherPart[]): PythonCpp | undefined {
  if (cpp?.module === undefined) return undefined;
  const classes = [...new Set([...listed, ...others.flatMap((o) => o.cpp ?? [])])];
  return { module: cpp.module, classes };
}

/**
 * A C++ part's compile in the builder's copy, waited for at most what check-part's call has left
 * since `started` ({@link compileWaitMs}): each error at its file (relative to the copy) and line,
 * one problem for a failure without errors, or one saying it is still compiling. The job is keyed
 * by the copy's project and a fingerprint of what the build reads, so the next call picks up its
 * result.
 */
async function compileProblems(
  deps: LoopToolsDeps,
  jobs: CompileJobs,
  directory: string,
  part: string,
  target: CompileTarget,
  started: number,
): Promise<PartProblem[]> {
  const { projectFile, module, engineDir, xcodeApp } = target;
  const rulesFile = path.join(path.dirname(projectFile), SOURCE_FOLDER, module, `${module}${RULES_SUFFIX}`);
  const rules = await readRegularFile(rulesFile, MAX_RULES_BYTES).then(String, () => "");
  const tree = await copyStamp({ copy: directory, project: projectFile }, { module, part });
  const compile = deps.compile ?? compileEditor;
  // The part's files by full path: the copy's real folder holds `unreal/`, which holds the project.
  const copy = path.dirname(path.dirname(projectFile));
  const sources = Object.keys(target.files).map((inner) => path.join(copy, target.folder, inner));
  const start = async (signal: AbortSignal, previousEnd: number | undefined) => {
    await freshenSources(sources, previousEnd, deps);
    return compile({ engineDir, projectFile, module, xcodeApp, signal });
  };
  const hash = cppFingerprint({ part, files: target.files, buildRules: rules, engineDir, tree });
  const wait = (signal: AbortSignal) => deps.sleep(compileWaitMs(deps.now() - started), signal);
  const result = await jobs.result(projectFile, hash, start, wait);
  const problem = (file: string, message: string, line?: number): PartProblem => ({
    file,
    ...(line ? { line } : {}),
    code: PartProblemCode.Compile,
    severity: Severity.Error,
    message,
  });
  if (!result) return [problem(target.folder, MESSAGE.StillCompiling)];
  if (result.ok) return [];
  if (result.errors.length === 0) return [problem(target.folder, result.summary)];
  // UBT names a file inside the project relative to it, and one outside by its base name only.
  const fileOf = (file: string) => (file.includes("/") ? `${GAME_PROJECT_FOLDER}/${file}` : file || target.folder);
  return result.errors.map((e) => problem(fileOf(e.file), e.message, e.line));
}

/** The one editor queue the Loop's tools share, made on first use for the plugin's storage. */
function sharedQueue(deps: LoopToolsDeps): (storage: string) => EditorQueue {
  let queue: EditorQueue | undefined;
  const { watchCrash } = deps;
  return (storage) => {
    queue ??= createEditorQueue({
      editor: (game): EditorPort => ({
        answering: () => deps.editorAnswers(storage, game),
        call: (tool, args, timeoutMs) => deps.editorCall(storage, game, tool, args, timeoutMs),
        ...(watchCrash ? { watchCrash: () => watchCrash(storage, game) } : {}),
      }),
      landCpp: landPartCpp,
      now: deps.now,
      sleep: deps.sleep,
      fileReady: async (file) => (await stat(file).catch(() => null))?.isFile() === true,
      readShot: async (file) => {
        const info = await stat(file);
        if (info.size > MAX_SHOT_BYTES) throw new Error(`${file} is too large`);
        return (await readFile(file)).toString("base64");
      },
    });
    return queue;
  };
}

/** The Loop's tools over one queue; `call` answers a tool by its name. */
export function createLoopTools(deps: LoopToolsDeps) {
  const queueFor = sharedQueue(deps);
  const game = gameOf;
  const folder = (context: PluginContext) => {
    if (!context.directory) throw new Error(MESSAGE.NoFolder);
    return context.directory;
  };
  const partArg = (args: Record<string, unknown>) => {
    const part = text(args, "part");
    if (!PART_NAME.test(part)) throw new Error(MESSAGE.BadPart(part));
    return part;
  };

  const compiles = createCompileJobs(deps.now);
  const cpp = createCppTools(deps);
  const set: SetDeps = { ...deps, setup: deps.setup ?? systemSetup() };
  const reopen = createReopenTools(set);
  const moments = momentTools(set, queueFor, reopen);

  const handlers: Record<LoopToolName, Handler> = {
    [LoopToolName.CheckPart]: async (args, context, storage) => {
      // The call's clock: its compile wait ends in time for the answer to reach the caller.
      const started = deps.now();
      const part = partArg(args);
      const directory = folder(context);
      const { plan, ...checked } = await gate(deps, storage, directory, part, context.project);
      const compiled =
        plan && "target" in plan ? await compileProblems(deps, compiles, directory, part, plan.target, started) : [];
      const errors = [...checked.errors, ...compiled];
      // In the game's own folder the C++ isn't compiled here: it counts as not verified yet.
      const unverified = checked.unverified + (plan && "inGame" in plan ? 1 : 0);
      if (errors.length === 0) return MESSAGE.Passes(part, unverified);
      return MESSAGE.Problems(part, errors.length, errors.map(where).join("\n"));
    },
    [LoopToolName.RunPart]: async (args, context, storage) => {
      const part = partArg(args);
      const checked = await gate(deps, storage, folder(context), part, context.project);
      if (!checked.ok) throw new Error(MESSAGE.NotPassing(part, checked.errors.map(where).join("\n")));
      const test = parsePartTest(checked.files.test);
      if (!test.ok) throw new Error(MESSAGE.NotPassing(part, test.problems.join("\n")));
      const script = path.join(checked.dir, PartFile.Apply);
      const job = {
        game: game(context),
        part,
        script,
        test: test.test,
        ...(checked.code ? { cpp: checked.code } : {}),
      };
      return { id: queueFor(storage).enqueue(job) };
    },
    [LoopToolName.PartResult]: async (args, _context, storage) => {
      const id = text(args, "id");
      const run = queueFor(storage).status(id);
      if (!run) throw new Error(MESSAGE.UnknownRun(id));
      return run;
    },
    [LoopToolName.RollbackPart]: async (args, context, storage) =>
      deps.editorCall(storage, game(context), LoopEditorTool.RollbackPart, { part: partArg(args) }),
    [LoopToolName.ReloadLevel]: async (_args, context, storage) =>
      deps.editorCall(storage, game(context), LoopEditorTool.ReloadLevel, {}),
    [LoopToolName.ExportReference]: (_args, context, storage) => exportReference(deps, storage, game(context)),
    [LoopToolName.BlueprintGuide]: async () => {
      const engine = await deps.engine();
      if (!engine) throw new Error(MESSAGE.NoEngine);
      return readBlueprintGuide(engine.directory, engine.version);
    },
    [LoopToolName.FindNodes]: async (args, context, storage) =>
      findNodes(deps, storage, args, await templateBlueprints(deps, storage, context.project)),
    [LoopToolName.CppStatus]: (_args, context, storage) => cpp.status(storage, game(context)),
    [LoopToolName.AddCppModule]: (_args, context, storage) => cpp.add(storage, game(context)),
    ...restartHandlers(reopen, moments),
  };
  const every: Record<AnyLoopToolName, Handler> = {
    ...handlers,
    ...liveHandlers(set, queueFor, reopen, moments),
    ...leadHandlers(set, moments),
    [MomentToolName.OpenForRun]: async (_args, context, storage) => openForRun(moments.ops(context, storage)),
  };
  return {
    has: (name: string): name is AnyLoopToolName => Object.hasOwn(every, name),
    call: (name: AnyLoopToolName, args: Record<string, unknown>, context: PluginContext, storage: string) =>
      every[name](args, context, storage),
  };
}

/** Any of the Loop's tools: the part tools, the harness's, the lead's and the moments' own. */
export type AnyLoopToolName = LoopToolName | LiveLoopToolName | LeadLoopToolName | MomentToolName;

/** The tools' dependencies with setup's chosen: a test's, or this computer's. */
type SetDeps = LoopToolsDeps & { setup(storage: string): SetupOptions };

/** This computer's setup for a project: its env, read once when first needed, and the shipped helper. */
function systemSetup(): (storage: string) => SetupOptions {
  let env: SetupEnv | undefined;
  return (storage) => {
    env ??= systemSetupEnv();
    return { env, helper: SHIPPED_HELPER, storage };
  };
}

/** The calling game; throws without one. */
const gameOf = (context: PluginContext) => {
  if (!context.project) throw new Error(MESSAGE.NoGame);
  return context.project;
};

/** The game's linked project file; throws without one. */
async function linkedOrThrow(deps: LoopToolsDeps, storage: string, game: string): Promise<string> {
  const project = await deps.project(storage, game);
  if (!project) throw new Error(MESSAGE.NoLinkedProject);
  return project;
}

/** The reopen job's tools: reopening Unreal and where it stands, each answering a moment in its own terms. */
function restartHandlers(
  reopen: ReturnType<typeof createReopenTools>,
  moments: MomentTools,
): Pick<Record<LoopToolName, Handler>, typeof LoopToolName.ReopenEditor | typeof LoopToolName.EditorState> {
  return {
    [LoopToolName.ReopenEditor]: (_args, context, storage) =>
      context.hook
        ? reopenAtMoment(moments.ops(context, storage), context.hook)
        : reopen.reopen(storage, gameOf(context)),
    [LoopToolName.EditorState]: (_args, context, storage) =>
      context.hook
        ? healthAtMoment(moments.ops(context, storage), context.hook)
        : reopen.state(storage, gameOf(context)),
  };
}

/** The lead's save and restart tools over the part tools' queue and reopen jobs. */
function liveHandlers(
  deps: SetDeps,
  queueFor: (storage: string) => EditorQueue,
  reopen: ReturnType<typeof createReopenTools>,
  moments: MomentTools,
): Record<LiveLoopToolName, Handler> {
  return {
    [LiveLoopToolName.PlayCheck]: async (args, context, storage) => {
      const job = { game: gameOf(context), checks: readPlayChecks(args.checks), ownerWaitMs: PLAY_CHECK_OWNER_WAIT_MS };
      return { id: queueFor(storage).enqueuePlayCheck(job) };
    },
    [LiveLoopToolName.SaveAll]: async (_args, context, storage) =>
      context.hook
        ? saveAtMoment(moments.ops(context, storage), context.hook)
        : saveAll(deps, storage, gameOf(context)),
    [LiveLoopToolName.LogErrors]: async (args, context, storage) =>
      context.hook
        ? moments.log(storage, gameOf(context), context.hook)
        : moments.readLog(storage, gameOf(context), sinceOf(args)),
    [LiveLoopToolName.EndEditor]: async (_args, context, storage) =>
      context.hook ? endAtMoment(moments.ops(context, storage)) : reopen.end(storage, gameOf(context)),
    [LiveLoopToolName.UpdateHelper]: async (_args, context, storage) =>
      updateGameHelper(deps, storage, gameOf(context)),
  };
}

/** The lead's tools: the editor's activity (the editor lock's probe), and the hero cameras' stills. */
function leadHandlers(deps: SetDeps, moments: MomentTools): Record<LeadLoopToolName, Handler> {
  return {
    [LeadLoopToolName.EditorActivity]: async (_args, context, storage) => moments.probe(storage, gameOf(context)),
    [LeadLoopToolName.HeroShots]: async (args, context, storage) =>
      context.hook
        ? moments.shots(storage, gameOf(context), context.hook)
        : heroShots(deps, storage, gameOf(context), heroAsk(args)),
  };
}

/** The moments' tools: one game's editor operations, the log's per-game marks, the probe and the stills. */
type MomentTools = ReturnType<typeof momentTools>;

/**
 * What the handlers do at Genex's moments, over the part tools' queue and reopen jobs: each game's
 * editor operations (`editor-moments.ts`), where each game's log stood at its run's start or last
 * checkpoint (lost with a backend restart: the next checkpoint reads from then), the editor lock's
 * probe, and the hero cameras' stills as pictures.
 */
function momentTools(
  deps: SetDeps,
  queueFor: (storage: string) => EditorQueue,
  reopen: ReturnType<typeof createReopenTools>,
) {
  const readLog = createLogReader(deps);
  const marks = new Map<string, number>();
  const mark = (game: string, offset: number) => {
    if (!marks.has(game) && marks.size >= MAX_LOG_MARKS) marks.delete(marks.keys().next().value ?? "");
    marks.set(game, offset);
  };
  const log = async (storage: string, game: string, hook: HookContext): Promise<HookAnswer> => {
    if (hook.on !== HookEvent.RunPrepare && hook.on !== HookEvent.CheckpointBefore) return {};
    const since = hook.on === HookEvent.CheckpointBefore ? marks.get(game) : undefined;
    const read = await readLog(storage, game, since).catch(() => null);
    if (!read) return {};
    mark(game, read.offset);
    return since === undefined ? {} : logAnswer(read.lines.slice(0, MAX_MOMENT_LOG_LINES), hook);
  };
  // Only a run's save points carry thumbnails: a chat's checkpoint would capture stills nobody reads.
  const shots = async (storage: string, game: string, hook: HookContext): Promise<HookAnswer> => {
    if (!inRun(hook)) return {};
    if (!(await deps.editorAnswers(storage, game).catch(() => false))) return {};
    return shotsAnswer((await heroShots(deps, storage, game, heroAsk({}))).shots);
  };
  const probe = async (storage: string, game: string) => {
    if (!(await deps.editorAnswers(storage, game).catch(() => false))) {
      if (await nobodyIn(deps, reopen, storage, game)) return probeAnswer(null, false, false);
      throw new Error(MESSAGE.CantTellUse);
    }
    const asked = deps.now();
    const activity = await readActivity(deps, storage, game);
    // The agent's play ended some other way than its own stop: its marker would claim the next play.
    if (activity && !activity.pie) await forgetAgentPlay(storage, game, asked);
    return probeAnswer(activity, await agentPlaying(storage, game, deps.now()), queueFor(storage).busy(game));
  };
  const closed = new Set<string>();
  const ops = (context: PluginContext, storage: string): MomentOps => {
    const key = `${storage}\0${gameOf(context)}`;
    const restoreClosed = {
      mark: () => {
        if (closed.size >= MAX_LOG_MARKS) closed.clear();
        closed.add(key);
      },
      take: () => closed.delete(key),
    };
    return { ...editorOps(deps, reopen, context, storage), restoreClosed };
  };
  return { readLog, log, shots, probe, ops };
}

/**
 * Whether nobody can be using the game's Unreal, which doesn't answer: the game has no linked
 * project, no editor process of it runs, or Genex is still opening it (it answers nobody yet).
 */
async function nobodyIn(
  deps: SetDeps,
  reopen: ReturnType<typeof createReopenTools>,
  storage: string,
  game: string,
): Promise<boolean> {
  if (!(await deps.project(storage, game).catch(() => undefined))) return true;
  if ((await reopen.running(storage, game)) === false) return true;
  return (await deps.starting?.(storage, game).catch(() => null)) === EditorStart.Starting;
}

/** One game's editor operations for a moment's handler. */
function editorOps(
  deps: SetDeps,
  reopen: ReturnType<typeof createReopenTools>,
  context: PluginContext,
  storage: string,
): Omit<MomentOps, "restoreClosed"> {
  const game = gameOf(context);
  const linked = () => deps.project(storage, game).catch(() => undefined);
  return {
    now: deps.now,
    sleep: deps.sleep,
    signal: context.signal,
    answers: () => deps.editorAnswers(storage, game).catch(() => false),
    running: () => reopen.running(storage, game),
    activity: () => readActivity(deps, storage, game),
    save: () => saveAll(deps, storage, game),
    end: () => reopen.end(storage, game),
    reopen: (helper) => reopen.reopen(storage, game, helper),
    state: () => reopen.state(storage, game),
    start: async () => (deps.starting ? deps.starting(storage, game) : null),
    projectName: async () => {
      const project = await linked();
      return project ? path.parse(project).name : null;
    },
    updateHelper: () => updateGameHelper(deps, storage, game),
    exported: async () => projectExported(await linked()),
    exportReference: () => exportReference(deps, storage, game),
  };
}

/**
 * What the game's open editor is doing: whether it is in a play session, and how many packages it
 * holds unsaved; throws when the helper answers anything else, so no caller reads an editor it
 * can't see as idle.
 */
async function readActivity(deps: LoopToolsDeps, storage: string, game: string) {
  const answer = await deps.editorCall(storage, game, LoopTool.EditorActivity, {});
  const reply = isJsonObject(answer) ? answer : {};
  if (typeof reply.pie !== "boolean" || !Array.isArray(reply.dirty)) throw new Error(MESSAGE.NoActivityAnswer);
  return { pie: reply.pie, dirty: reply.dirty.length };
}

/**
 * What `hero-shots` is asked: the cameras' prefix (`GX_Shot_` when absent) and how many (all it
 * takes, {@link MAX_HERO_SHOTS}, when absent); throws on anything else.
 */
function heroAsk(args: Record<string, unknown>): { prefix: string; max: number } {
  const { prefix = HERO_CAMERA_PREFIX, max = MAX_HERO_SHOTS } = args;
  if (typeof prefix !== "string" || !HERO_PREFIX.test(prefix)) throw new Error(MESSAGE.BadPrefix);
  const whole = typeof max === "number" && Number.isSafeInteger(max);
  if (!whole || max < 1 || max > MAX_HERO_SHOTS) throw new Error(MESSAGE.BadMax(MAX_HERO_SHOTS));
  return { prefix, max };
}

/** The level's hero cameras whose labels start with `prefix`, by label, at most `max`. */
async function heroCameras(deps: LoopToolsDeps, storage: string, game: string, ask: { prefix: string; max: number }) {
  const answer = await deps.editorCall(storage, game, HeroShotTool.ShotCameras, {});
  const cameras = isJsonObject(answer) ? answer.cameras : undefined;
  if (!Array.isArray(cameras)) throw new Error(MESSAGE.NoCameras);
  return cameras
    .filter((label): label is string => typeof label === "string" && label.startsWith(ask.prefix))
    .slice(0, ask.max);
}

/** One hero camera's still once it landed in the project's captures folder, or null when it never did. */
async function heroShot(
  deps: LoopToolsDeps,
  target: { storage: string; game: string; project: string },
  camera: string,
) {
  const args = { camera, width: HERO_SHOT_WIDTH, height: HERO_SHOT_HEIGHT, delay_s: HERO_SHOT_DELAY_S };
  const answer = await deps.editorCall(target.storage, target.game, HeroShotTool.CaptureShot, args).catch(() => null);
  if (!isJsonObject(answer) || answer.queued !== true) return null;
  const clock = { now: deps.now, sleep: (ms: number, signal: AbortSignal) => deps.sleep(ms, signal) };
  const read = await landedShot(CaptureTool.Shot, answer, target.project, clock, new AbortController().signal);
  if ("why" in read) return null;
  return { name: camera, file: read.file, data: read.bytes.toString("base64"), tone: toneOf(read.image) };
}

/**
 * `hero-shots`: a still from each of the level's hero cameras (labels starting with `prefix`, at
 * most `max`), one at a time (each pilots the level viewport), as PNG data with its tone numbers.
 * A still that never lands in the project's own captures folder is left out, and none is asked for
 * once the call has run {@link HERO_SHOTS_WAIT_MS}. A level without hero cameras has no shots.
 */
async function heroShots(deps: LoopToolsDeps, storage: string, game: string, ask: { prefix: string; max: number }) {
  const project = await linkedOrThrow(deps, storage, game);
  if (!(await deps.editorAnswers(storage, game).catch(() => false))) throw new Error(MESSAGE.NotAnswering);
  const ends = deps.now() + HERO_SHOTS_WAIT_MS;
  const shots: Array<NonNullable<Awaited<ReturnType<typeof heroShot>>>> = [];
  for (const camera of await heroCameras(deps, storage, game, ask)) {
    if (deps.now() >= ends) break;
    const shot = await heroShot(deps, { storage, game, project }, camera);
    if (shot) shots.push(shot);
  }
  return { shots };
}

/**
 * A play-check's checks as the board keys them, each `{tag, exists}` with a whole `genex:` tag or
 * `{player, atLeast and/or atMost}`; throws naming every bad one, so nothing is queued.
 */
function readPlayChecks(raw: unknown): Record<string, PartCheck> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(MESSAGE.NoChecks);
  const entries = Object.entries(raw);
  const problems: string[] = entries.length > MAX_PLAY_CHECKS ? [MESSAGE.TooManyChecks(MAX_PLAY_CHECKS)] : [];
  const checks: Record<string, PartCheck> = {};
  for (const [id, value] of entries) {
    const check = readPartCheck(value);
    if (!BOARD_ID.test(id)) problems.push(MESSAGE.BadBoardId(id));
    else if (!check || "actor" in check) problems.push(MESSAGE.BadCheck(id));
    else checks[id] = check;
  }
  if (problems.length > 0) throw new Error(MESSAGE.ChecksRefused(problems));
  return checks;
}

/** Whether the game's editor is in a play session; an editor that can't say is taken as not playing. */
async function inPlay(deps: LoopToolsDeps, storage: string, game: string): Promise<boolean> {
  const state = await deps.editorCall(storage, game, LoopTool.PlayState, {}).catch(() => undefined);
  return isJsonObject(state) && state.pie === true;
}

/**
 * Ends a play session the editor is in (the builder's own test, say), which the helper's save
 * refuses to save under, and waits until it has ended; throws when it doesn't.
 */
async function stopPlayFirst(deps: LoopToolsDeps, storage: string, game: string): Promise<void> {
  if (!(await inPlay(deps, storage, game))) return;
  await deps.editorCall(storage, game, LoopTool.StopPlay, {});
  const ended = async () => !(await inPlay(deps, storage, game));
  if (!(await pollUntil(deps, ended, PLAY_STOP_POLL_MS, PLAY_STOP_WAIT_MS))) throw new Error(MESSAGE.StillPlaying);
}

/**
 * `save-all`: a play session ended first, then the helper saves every unsaved level and asset;
 * throws its refusal, or when Unreal doesn't answer or stays in play.
 */
async function saveAll(deps: LoopToolsDeps, storage: string, game: string) {
  if (!(await deps.editorAnswers(storage, game).catch(() => false))) throw new Error(MESSAGE.NotAnswering);
  await stopPlayFirst(deps, storage, game);
  const answer = await deps.editorCall(storage, game, CppEditorTool.SaveAll, {});
  const reply = isJsonObject(answer) ? answer : {};
  if (reply.error !== undefined) throw new Error(String(reply.error));
  if (typeof reply.saved !== "boolean" || !Array.isArray(reply.dirty)) throw new Error(MESSAGE.NoSaveAnswer);
  const dirty = reply.dirty.filter((name): name is string => typeof name === "string");
  return { saved: reply.saved, dirty, ms: typeof reply.ms === "number" ? reply.ms : 0 };
}

/** `log-errors`' `since`: absent, or a byte offset (a whole number, 0 or more); anything else is refused. */
function sinceOf(args: Record<string, unknown>): number | undefined {
  const { since } = args;
  if (since === undefined) return undefined;
  if (typeof since !== "number" || !Number.isSafeInteger(since) || since < 0) throw new Error(MESSAGE.BadSince);
  return since;
}

/**
 * `log-errors` over the game's own editor log. Each offset it answers is remembered with the log's
 * file, so a later read from it knows a log Unreal started anew since, even one already longer.
 */
function createLogReader(deps: LoopToolsDeps) {
  const places = new Map<string, number>();
  const placeOf = (project: string, offset: number) => `${project}\n${offset}`;
  const placeAt = (project: string, offset: number): LogPlace => {
    const ino = places.get(placeOf(project, offset));
    return ino === undefined ? { offset } : { offset, ino };
  };
  return async (storage: string, game: string, since: number | undefined): Promise<LogErrors> => {
    const project = await linkedOrThrow(deps, storage, game);
    const directory = path.dirname(project);
    const file = editorLogPath({ file: project, directory }, deps.home ?? userHome(), deps.platform);
    const read = await errorLinesSince(file, project, since === undefined ? undefined : placeAt(project, since));
    if (read.ino !== null) {
      if (places.size >= MAX_LOG_PLACES) places.delete(places.keys().next().value ?? "");
      places.set(placeOf(project, read.offset), read.ino);
    }
    return { offset: read.offset, lines: read.lines, more: read.more, rotated: read.rotated };
  };
}

/** `update-helper`: the project's Genex editor helper brought up to the plugin's, only while this game's Unreal is closed. */
async function updateGameHelper(deps: SetDeps, storage: string, game: string): Promise<HelperUpdate> {
  const project = await linkedOrThrow(deps, storage, game);
  if (await deps.editorAnswers(storage, game).catch(() => false)) throw new Error(MESSAGE.HelperWhileOpen);
  return (deps.updateHelper ?? updateHelper)(project, deps.setup(storage));
}

/**
 * The node types whose names hold every word of `query`, from the engine's reference: the
 * Blueprint's own context first (`base` and `graph`), then the common ones, then the template's
 * Blueprints' casts and members; pins where known.
 */
async function findNodes(
  deps: LoopToolsDeps,
  storage: string,
  args: Record<string, unknown>,
  template: readonly BlueprintDecl[],
) {
  const words = text(args, "query").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error(MESSAGE.NoQuery);
  const engine = await deps.engine();
  const reference = engine ? await loadReference(storage, engine.version) : null;
  if (!reference) throw new Error(MESSAGE.NoReference);
  const base = text(args, "base");
  const graph = text(args, "graph");
  const known = BASES.has(base) && GRAPHS.has(graph);
  const own = known ? (reference.contexts[contextKey(base as BaseClass, graph as GraphKind)] ?? []) : [];
  const templatePins = new Map<string, NodePins>(projectNodes(template));
  const matches = [...new Set([...own, ...reference.common, ...templatePins.keys()])].filter((typeId) =>
    words.every((word) => typeId.toLowerCase().includes(word)),
  );
  const nodes = matches.slice(0, MAX_FOUND_NODES).map((typeId) => {
    const pins = reference.pins[typeId] ?? templatePins.get(typeId);
    return pins ? { typeId, pins } : { typeId };
  });
  return { nodes, more: matches.length > MAX_FOUND_NODES };
}

/** Throws the editor's refusal (`{error}`), so a file left from an earlier export is never read. */
function refused(answer: unknown) {
  const error = answer && typeof answer === "object" ? (answer as { error?: unknown }).error : undefined;
  if (error !== undefined) throw new Error(String(error));
}

/**
 * Has the editor write the template's project file (`project-blueprints.ts` reads it); its counts,
 * or `{error}`: the node reference is kept either way.
 */
async function exportProject(deps: LoopToolsDeps, storage: string, game: string, file: string) {
  try {
    const answer = await deps.editorCall(storage, game, LoopEditorTool.ExportProject, { file });
    const counts = answer && typeof answer === "object" ? (answer as Record<string, unknown>) : {};
    if (counts.error !== undefined) return { error: String(counts.error) };
    return { blueprints: counts.blueprints, more: counts.more, inputActions: counts.inputActions };
  } catch (failure) {
    return { error: errorMessage(failure) };
  }
}

/** Asks the game's editor for the node reference and the Python names, and keeps them per engine. */
async function exportReference(deps: LoopToolsDeps, storage: string, game: string) {
  const engine = await deps.engine();
  if (!engine) throw new Error(MESSAGE.NoEngine);
  const project = await deps.project(storage, game);
  if (!project) throw new Error(MESSAGE.NoProject);
  const out = path.join(path.dirname(project), EXPORT_FOLDER);
  const nodesFile = path.join(out, "reference.json");
  const namesFile = path.join(out, "python-names.json");
  // Every parameter is passed: Unreal's schema marks even the defaulted ones required.
  refused(await deps.editorCall(storage, game, LoopEditorTool.ExportReference, { file: nodesFile, pins: "" }));
  refused(await deps.editorCall(storage, game, LoopEditorTool.ExportPythonNames, { file: namesFile }));
  const nodes = parseReference(JSON.parse(await readFile(nodesFile, "utf8")));
  if (!nodes) throw new Error(MESSAGE.BadReference);
  const names: unknown = JSON.parse(await readFile(namesFile, "utf8"));
  await storeReference(storage, engine.version, nodes);
  await atomicWriteJson(referencePaths(storage, engine.version).python, names);
  const stored = await loadReference(storage, engine.version);
  const template = await exportProject(deps, storage, game, path.join(path.dirname(project), PROJECT_EXPORT));
  return {
    engine: engine.version,
    nodes: stored ? stored.common.length : 0,
    stored: stored !== null,
    project: template,
  };
}
