import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { isInside } from "../../substrate/paths.ts";
import type {
  Activate,
  PluginActivation,
  PluginContext,
  PluginEngineLink,
  PluginEngineRun,
  PluginReview,
} from "../../plugin-sdk/index.d.ts";
import {
  askDocuments,
  assertCreatable,
  assertTemplateAndName,
  canCreateWith,
  type CreateRequest,
  createProject,
  type DocumentsQuery,
  listTemplates,
  noEngineError,
  suggestName,
  unrealProjectsFolder,
  unverifiedEngineError,
} from "./create-project.ts";
import {
  editorCount,
  findLauncher,
  getUnreal,
  getXcodeLaunch,
  type HelperUpdateOnOpen,
  type LaunchEnv,
  type LaunchOptions,
  type OpenResult,
  openEditor,
  quitEditor,
  readStarting,
  retireStarting,
  type Starting,
  systemLaunchEnv,
} from "./editor-launch.ts";
import { projectModule } from "./cpp-module.ts";
import { editorLogPath, startCrashCheck } from "./editor-log.ts";
import {
  chosenProject,
  linkedProject,
  linkedToAGame,
  listSetUpProjects,
  rememberChoice,
  sameProject,
} from "./editor-port.ts";
import { callProjectTool } from "./editor-mcp.ts";
import { type ProcessEnv, systemProcesses } from "./editor-reopen.ts";
import { type AnyLoopTool, createLoopTools, TOOLSET_OF } from "./loop-tools.ts";
import { type UnrealSteps, unrealSteps, XcodeStep } from "./engine-steps.ts";
import { assertGameFolderFree, GAME_PROJECT_FOLDER, ignoreUnrealScratch } from "./game-folder.ts";
import { isProjectPath } from "./project-file.ts";
import { xcodeDownloadsLaunch } from "./xcode.ts";
import { EditorWait, engineReadiness, waitForEditor } from "./editor-wait.ts";
import { readinessAnswer } from "./hook-answers.ts";
import {
  answersOrBlocked,
  Connection,
  connectionOf,
  editorStart,
  loadingOf,
  startingOf,
  startingSince,
  toolbarStatus,
} from "./editor-status.ts";
import {
  findProjects,
  keepFor,
  placeOf,
  SCAN_KEEP_MS,
  type ScannedProject,
  scanProjectsFolder,
} from "./find-projects.ts";
import {
  type Engine,
  EngineMatch,
  engineMatch,
  findEngines,
  HELPER_FOLDER,
  HelperState,
  helperNeedsInstall,
  helperVersion,
  inspectProject,
  editorHasProject,
  type ProjectState,
  planSetup,
  realProjectFile,
  SetupError,
  type SetupErrorCode,
  type SetupEnv,
  type SetupOptions,
  SetupStep,
  settingsIniPath,
  setUpProject,
  systemSetupEnv,
  undoSetup,
} from "./setup.ts";

/**
 * The editor itself is reached through the plugin's MCP server. The backend answers the
 * "Set up Unreal" panel: what is installed, the user's projects and what the shown one still needs
 * (`status`), the two confirmed steps that change a project (`setup`, `undo-setup`), a new game
 * (`templates`, `create`), opening and quitting Unreal and getting it (`open-editor`,
 * `quit-editor`, `get-unreal`), and the Unreal toolbar button's word (`toolbar-status`). The
 * project the person picks or sets up in the panel is remembered in the plugin's storage, where the
 * bridge reads it to try that editor first; an open game linked to a project shows that one.
 */

/** The host services this backend calls, by their public SDK names. */
const HostService = {
  StorageRoot: "storage.root",
  EngineLink: "game.engine.link",
  EngineRead: "game.engine.read",
  EngineSteps: "game.engine.steps",
  GameSnapshot: "game.snapshot",
  GameCreate: "game.create",
  EngineRuns: "game.engine.runs",
} as const;
/** The actions plugin.json declares. */
const UnrealAction = {
  Status: "status",
  Setup: "setup",
  UndoSetup: "undo-setup",
  Templates: "templates",
  Create: "create",
  OpenEditor: "open-editor",
  QuitEditor: "quit-editor",
  GetUnreal: "get-unreal",
  ToolbarStatus: "toolbar-status",
  UseProject: "use-project",
  Steps: "steps",
  GetXcode: "get-xcode",
  StageStatus: "stage-status",
} as const;
type UnrealAction = (typeof UnrealAction)[keyof typeof UnrealAction];
const ACTION_NAMES: ReadonlySet<string> = new Set(Object.values(UnrealAction));
const isUnrealAction = (name: string): name is UnrealAction => ACTION_NAMES.has(name);
/** The tools plugin.json declares: the agent's, then the harness's own (`audience: harness`). */
const UnrealTool = {
  UseProject: "use-project",
  ShowSteps: "show-steps",
  NewGame: "new-game",
  WaitEditor: "wait-editor",
  EngineStatus: "engine-status",
} as const;
type UnrealTool = (typeof UnrealTool)[keyof typeof UnrealTool];
const TOOL_NAMES: ReadonlySet<string> = new Set(Object.values(UnrealTool));
const isUnrealTool = (name: string): name is UnrealTool => TOOL_NAMES.has(name);
/**
 * The one primary step the panel offers for what it shows: get Unreal, choose a game, quit Unreal
 * before setup, set up (which also switches a project from an older Unreal), open (which first
 * updates an older Genex editor helper), wait while it starts, use it, switch from another set-up
 * project Unreal has open, quit and reopen an editor that has the project open but doesn't answer
 * or whose own log says Epic's server couldn't listen on the project's port, or open it once Unreal
 * is free (`open-when-free`: Unreal has some other project open, which nothing here quits).
 */
export const PanelStep = {
  GetUnreal: "get-unreal",
  Choose: "choose",
  QuitFirst: "quit-first",
  SetUp: "set-up",
  Open: "open",
  Starting: "starting",
  Connected: "connected",
  Switch: "switch",
  NotAnswering: "not-answering",
  PortBlocked: "port-blocked",
  OpenWhenFree: "open-when-free",
} as const;
export type PanelStep = (typeof PanelStep)[keyof typeof PanelStep];

const GIB = 1024 ** 3;
/** Below this much free disk an Unreal project soon runs out of room (shaders, caches, builds). */
const LOW_DISK_BYTES = 20 * GIB;
/** Epic's 5.8 install size, as the Get Unreal view's step 2 says. */
const UNREAL_INSTALL_BYTES = 45 * GIB;
/** Unreal writes a project's LastOpenTime about 14 s into the start Genex launched; this much earlier is still that start. */
const FIRST_START_SKEW_MS = SECOND_MS;
/** Epic's minimum memory for the editor. */
const LOW_MEMORY_BYTES = 16 * GIB;

const MESSAGE = {
  UnknownAction: (name: string) => `Unknown Unreal action: ${name}`,
  UnknownTool: (name: string) => `Unknown Unreal tool: ${name}`,
  SetupQuestion: (name: string) => `Set up ${name} for Genex?`,
  SetupIntro: (name: string, file: string) => `Genex will change ${name} (${file}):`,
  UndoQuestion: (name: string) => `Undo setup for ${name}?`,
  NoGame: "Open a game in Genex first: an Unreal project is used by a game.",
  NotSetUp: (name: string) => `${name} isn't set up for Genex yet. Set it up from the Unreal button first.`,
  NoSetUpProject: "No Unreal project is set up for Genex yet. Set one up from the Unreal button first.",
  UnknownProject: (asked: string, names: string) =>
    `No set-up Unreal project is called ${asked}. The set-up projects are: ${names}.`,
  Linked: (name: string, file: string) =>
    `This game now builds in ${name} (${file}). Later Unreal calls in this game go to it.`,
  StepsShown: "The Unreal setup card is in the chat.",
  NewGame: (file: string) =>
    `Made this game's Unreal project, ${file}, set it up for Genex and linked this game to it. Unreal is opening it now; a first start can take several minutes while it prepares shaders. Don't wait for it and don't promise to check back later: end your reply now by telling the user what you will build first. Genex continues this chat by itself as soon as Unreal is ready, and from then on the Unreal tools reach this project.`,
  NewGameNotOpened: (file: string, why: string) =>
    `Made this game's Unreal project, ${file}, set it up for Genex and linked this game to it, but Unreal didn't open it: ${why.replace(/\.?$/, ".")} Tell the user to open it from the Unreal button.`,
  StepsDone: "Every recommended step is done; there is no card to show.",
  StepsNoChat: "There is no chat to show the Unreal setup card in.",
  NoLinkedProject: "This game isn't linked to an Unreal project yet.",
  LinkedNotSetUp: "This game's Unreal project isn't set up for Genex. Set it up from the Unreal button.",
  XcodeMacOnly: "Xcode is for a Mac. On Windows, Unreal builds C++ with Visual Studio.",
  [SetupStep.Engine]: (file: string, from: string, to: string) =>
    `${file}: switch from Unreal ${from} to ${to}. Content you save in ${to} won't open in ${from}. To keep a ${from} version, duplicate the project folder first.`,
  [SetupStep.Plugins]: (file: string) => `${file}: turn on Epic's ModelContextProtocol and EditorToolset plugins.`,
  [SetupStep.AutoStart]: (file: string, port: number) =>
    `${file}: start Unreal's MCP server on port ${port} whenever the project opens.`,
  [SetupStep.Helper]: (folder: string) => `${folder}: add the Genex editor helper, a few Python files.`,
  UpdateHelper: (folder: string, version: string | undefined) =>
    `${folder}: update the Genex editor helper${version ? ` to ${version}` : ""}, a few changed Python files.`,
  SetupOutro:
    "Genex keeps a copy of each file first, and Undo setup takes these changes back. A Genex editor helper file you changed is kept beside it as a .mine copy.",
  NothingToChange: (name: string) => `${name} is already set up. Nothing will change.`,
  Undo: (name: string) =>
    `Genex will take back what it added to ${name}: its plugin entries, the MCP server start-up lines and the Genex editor helper. Anything else you changed stays.`,
  KeptAfterUndo: (count: number) =>
    `Genex left ${count} ${count === 1 ? "file" : "files"} you changed in Plugins/${HELPER_FOLDER}.`,
  /** The reason of the game snapshot Open takes before it updates the helper, as Rewind lists it. */
  SnapshotBeforeUpdate: "Before Genex editor helper update",
  KeptOnUpdate: (version: string, count: number) =>
    `Genex updated the Genex editor helper to ${version} and kept ${count} ${count === 1 ? "file" : "files"} you changed beside the new ${count === 1 ? "one" : "ones"} as .mine.`,
} as const;

/**
 * What setup needs from the computer and where the shipped editor helper is; `projects` is where
 * new games go (Documents › Unreal Projects unless a test or the live run names its own folder);
 * `launch` starts Unreal, quits it or opens Epic's launcher, and tells the time (tests record);
 * `processes` lists and ends a crashed editor's processes for the Loop's reopen (none without it).
 */
export type UnrealBackendDeps = {
  env: SetupEnv;
  helper: string;
  projects?: () => Promise<string>;
  /** How Windows is asked for the Documents folder; tests stand in for PowerShell. */
  documents?: DocumentsQuery;
  launch: LaunchEnv;
  processes?: ProcessEnv;
};

type ProjectError = { code: SetupErrorCode | null; message: string };

function projectArg(args: Record<string, unknown>): string {
  return typeof args.project === "string" ? args.project.trim() : "";
}

function asProjectError(error: unknown): ProjectError {
  return { code: error instanceof SetupError ? error.code : null, message: errorMessage(error) };
}

async function setupOptions(deps: UnrealBackendDeps, context: PluginContext): Promise<SetupOptions> {
  return { env: deps.env, helper: deps.helper, storage: await context.host(HostService.StorageRoot) };
}

/** The project the panel shows, and whether it is chosen (named, the game's own or remembered) or only the most recent. */
type Shown = { shown: ProjectState | ProjectError | undefined; chosen: boolean };

/**
 * The project the panel shows: the one it names (remembered as the user's choice), else the open
 * game's own linked project, else the one chosen last while it is still there, else the most
 * recent. An empty name means none. A linked game never shows the project chosen for another game:
 * when its own project can't be read, status says why.
 */
async function shownProject(
  args: Record<string, unknown>,
  projects: ReadonlyArray<{ file: string }>,
  options: SetupOptions,
  linked: GameLink | null,
): Promise<Shown> {
  if (typeof args.project === "string") {
    const named = projectArg(args);
    const state = named ? await inspectProject(named, options).catch(asProjectError) : undefined;
    if (state && "file" in state) await rememberChoice(options.storage, realProjectFile(state));
    return { shown: state, chosen: named !== "" };
  }
  if (linked) {
    const own = await inspectProject(linked.project, options).catch(asProjectError);
    return { shown: own, chosen: "file" in own };
  }
  const chosen = await chosenProject(options.storage);
  const remembered = chosen ? await inspectProject(chosen, options).catch(() => undefined) : undefined;
  if (remembered) return { shown: remembered, chosen: true };
  const recent = projects[0]?.file;
  return { shown: recent ? await inspectProject(recent, options).catch(asProjectError) : undefined, chosen: false };
}

/**
 * What status learned about the editor: its process, the shown project's answer, Genex's launch
 * record, and the project's own log while it loads or once Epic's server couldn't listen on its port.
 */
type EditorFacts = {
  running: boolean;
  answering: boolean;
  starting: Starting | undefined;
  loading?: Starting;
  loaded?: boolean;
  portBlocked?: boolean;
};

/**
 * Whether a project counts as set up: its plugins on, its server starting on its own port, and
 * recorded, so the bridge can find it. A Genex editor helper that is older or missing doesn't
 * undo that: the project gets its own update step instead of looking never set up.
 */
const isSetUp = (state: ProjectState | undefined): state is ProjectState =>
  Boolean(state?.plugins && state.autoStart && state.undoable);

/** Where the shown project stands, and since when it has been opening while it starts. */
function connection(deps: UnrealBackendDeps, state: ProjectState | undefined, editor: EditorFacts) {
  const now = deps.launch.now();
  const starting = state ? startingOf(editor.starting, realProjectFile(state)) : undefined;
  const { answering, running, loading, loaded, portBlocked } = editor;
  const facts = { setUp: isSetUp(state), answering, running, starting, loading, loaded, portBlocked, now };
  const current = connectionOf(facts);
  const since = startingSince(facts);
  const opening = current === Connection.Starting && since ? { at: since.at, elapsedMs: now - since.at } : null;
  return { connection: current, opening };
}

/** What decides the panel's next step: the supported engine, the shown project and where it stands. */
type StepFacts = {
  engine: Engine | undefined;
  state: ProjectState | undefined;
  match: EngineMatch | null;
  running: boolean;
  connection: Connection;
  /** Another app holds the set-up project's port while Unreal is closed, so its server couldn't start. */
  portTaken: boolean;
  /** Another set-up project whose editor answers while the shown one doesn't. */
  openProject: OpenProject | null;
  /** The shown project's own log says Epic's server couldn't listen on its port. */
  portBlocked: boolean;
  /** Unreal has the shown project itself open: it answers for it, or its own log is still open. */
  projectOpen: boolean;
  /** Its log never closed, and nothing could tell whether an editor holds it: it may be another project Unreal has open. */
  openUnsure: boolean;
};

/** A set-up project Unreal has open: its name and real `.uproject`. */
type OpenProject = { name: string; file: string };

/**
 * The other set-up project Unreal has open while the shown one runs unanswered: each project in
 * Genex's own setup records but the shown one is asked on its own port, together, and the first
 * that answers is it. Never any other port.
 */
async function openElsewhere(storage: string, shown: string, env: SetupEnv): Promise<OpenProject | null> {
  const others = (await listSetUpProjects(storage)).filter((p) => p.project !== shown);
  const answers = await Promise.all(others.map((p) => env.editorAnswers(p.port, p.project)));
  const open = others.find((_, i) => answers[i]);
  return open ? { name: open.name, file: open.project } : null;
}

/** Whether a set-up project's Genex editor helper differs from the shipped one, or is gone; never a newer one. */
const helperBehind = (state: ProjectState | undefined) => isSetUp(state) && helperNeedsInstall(state.helper);

/**
 * Whether to ask if another app holds a set-up project's port: only while Unreal is closed and
 * nothing answers, so a normal status costs no probe. Not on Windows yet, where a closed local port
 * can take a second to refuse and `portListening` would count it as held.
 */
function mayBePortTaken(
  state: ProjectState | undefined,
  editor: { running: boolean; answering: boolean },
  platform: NodeJS.Platform,
): boolean {
  const quiet = !editor.running && !editor.answering;
  return isSetUp(state) && quiet && platform !== "win32";
}

/**
 * The step for an editor that runs without the shown project answering: its port blocked, another
 * set-up project open (switch to this one), this very project open but silent (restart it), or
 * some other project open, or one that can't be told, which nothing here quits: this one opens
 * once Unreal is free.
 */
function runningStep(facts: StepFacts): PanelStep {
  if (facts.portBlocked) return PanelStep.PortBlocked;
  if (facts.openProject) return PanelStep.Switch;
  // Restart quits the editor: never one that may hold another project.
  return facts.projectOpen && !facts.openUnsure ? PanelStep.NotAnswering : PanelStep.OpenWhenFree;
}

/** The panel's one primary step for the shown project. */
function nextStep(facts: StepFacts): PanelStep {
  const { engine, state, match, running, connection: current } = facts;
  if (!engine) return PanelStep.GetUnreal;
  if (!state) return PanelStep.Choose;
  if (current === Connection.Ready) return PanelStep.Connected;
  if (current === Connection.Starting) return PanelStep.Starting;
  // Setup refuses only while Unreal has this project open; it moves a taken port and switches a project from an older Unreal.
  const needsSetup = current === Connection.SetUp || facts.portTaken || match === EngineMatch.TooOld;
  if (needsSetup) return running && facts.projectOpen ? PanelStep.QuitFirst : PanelStep.SetUp;
  // Open updates an older Genex editor helper itself, so it needs no step of its own.
  return running ? runningStep(facts) : PanelStep.Open;
}

/**
 * What the editor is doing for the shown project: how many editors run, whether its own editor
 * answers on its port, Genex's launch record, its own log while it loads, and whether Unreal has it
 * open (`projectOpen`: it answers, or its log is still open). A project that answers is no longer
 * starting, whatever Genex's record said, so the record goes.
 */
async function editorFacts(deps: UnrealBackendDeps, state: ProjectState | undefined, storage: string) {
  const { env } = deps;
  const port = state?.port ?? null;
  const project = state ? realProjectFile(state) : undefined;
  const [editors, answering, starting] = await Promise.all([
    editorCount(env),
    port !== null && project ? env.editorAnswers(port, project) : false,
    readStarting(storage),
  ]);
  const running = editors > 0;
  if (project && answering) await retireStarting(storage, project);
  const loads = state && running && !answering;
  const own = loads ? { file: realProjectFile(state), directory: state.directory, port: state.port } : undefined;
  const log = own ? await loadingOf(env, own, deps.launch.now()) : undefined;
  const projectOpen = running && (answering || log?.open === true);
  return { editors, running, answering, starting: answering ? undefined : starting, ...log, projectOpen };
}

/**
 * The computer's notes for the panel: free disk where the project is, memory, and where Xcode
 * stands. Xcode is recommended on every Mac, C++ project or not: without it Genex works in
 * Blueprints only. It is judged by the supported engine's own Xcode range. Without a supported
 * Unreal the disk must also fit the engine (`installBytes`): `diskNeedBytes` is what the disk note
 * is measured against.
 */
async function computerNotes(env: SetupEnv, state: ProjectState | undefined, engine: Engine | undefined) {
  const [freeBytes, xcode] = await Promise.all([
    // The project's disk; before one is shown, the engine's (where shaders and builds go too), else home's.
    env.freeBytes(state?.directory ?? engine?.directory ?? env.home).catch(() => null),
    env.xcode(engine?.directory),
  ]);
  const diskNeedBytes = engine ? LOW_DISK_BYTES : UNREAL_INSTALL_BYTES + LOW_DISK_BYTES;
  return {
    lowDisk: freeBytes !== null && freeBytes < diskNeedBytes,
    diskNeedBytes,
    installBytes: UNREAL_INSTALL_BYTES,
    lowMemory: env.totalMemory() < LOW_MEMORY_BYTES,
    freeBytes,
    memoryBytes: env.totalMemory(),
    xcode,
  };
}

/**
 * Whether this is the project's first start: Unreal's recent list has never named it, or named it
 * only during the start Genex is opening now (Unreal lists a project about 14 s into its load).
 */
function firstStart(opened: number | null | undefined, opening: { at: number } | null): boolean {
  if (opened === null || opened === undefined) return true;
  return opening !== null && opened >= opening.at - FIRST_START_SKEW_MS;
}

/** The port the shown project's Starting record says was still held when Genex opened it, while its editor runs unanswered. */
function busyPortOf(state: ProjectState | undefined, editor: EditorFacts): number | null {
  const own = state && editor.running ? startingOf(editor.starting, realProjectFile(state)) : undefined;
  return own?.busyPort ?? null;
}

/** The steps that say what holds Unreal: set up beside it, switch from it, or open once it is free. */
const HOLDER_STEPS: ReadonlySet<PanelStep> = new Set([PanelStep.SetUp, PanelStep.Switch, PanelStep.OpenWhenFree]);

/**
 * What Unreal has open while it runs without the shown project, by name when known: the other
 * set-up project that answers, else a project whose own log an editor holds (on a Mac), never the
 * shown one. Null while no editor runs, while Unreal has the shown project itself open, and when
 * the computer can't tell.
 */
async function holderOf(
  env: SetupEnv,
  state: ProjectState | undefined,
  editor: { running: boolean; projectOpen: boolean },
  openProject: OpenProject | null,
): Promise<string | null> {
  if (!state || !editor.running || editor.projectOpen) return null;
  if (openProject) return openProject.name;
  const shown = state.name.toLowerCase();
  const names = (await env.heldProjects?.().catch(() => [])) ?? [];
  return names.find((name) => name.toLowerCase() !== shown) ?? null;
}

/**
 * Where a project stands and the one step it needs, as the panel and the Live card both read it:
 * the editor's facts, the engine match, the connection, a taken or blocked port, another set-up
 * project Unreal has open, the next step, and what holds Unreal when that step names it. Only the
 * project's own port is asked, so it stays cheap; the other set-up projects are asked only while
 * its editor runs unanswered and isn't loading.
 */
async function whereItStands(
  deps: UnrealBackendDeps,
  state: ProjectState | undefined,
  engines: Engine[],
  storage: string,
) {
  const { env } = deps;
  const port = state?.port ?? null;
  const editor = await editorFacts(deps, state, storage);
  const engine = engines.find((e) => e.supported);
  const match = state ? engineMatch(state.engine, engines) : null;
  const where = connection(deps, state, editor);
  const portTaken = port !== null && mayBePortTaken(state, editor, env.platform) && (await env.portListening(port));
  const portBlocked = editor.portBlocked === true;
  const elsewhere = isSetUp(state) && editor.running && !portBlocked && where.connection === Connection.NotOpen;
  const openProject = elsewhere ? await openElsewhere(storage, realProjectFile(state), env) : null;
  const running = editor.running;
  const next = nextStep({
    engine,
    state,
    match,
    running,
    connection: where.connection,
    portTaken,
    openProject,
    portBlocked,
    projectOpen: editor.projectOpen,
    openUnsure: !editor.answering && editor.openUnsure === true,
  });
  const holder = HOLDER_STEPS.has(next) ? await holderOf(env, state, editor, openProject) : null;
  return { port, editor, engine, match, where, portTaken, openProject, next, holder };
}

/** A run going now that is using Unreal: its game's title, its linked project, and whether it is the open game's own. */
type BusyRun = { title: string; project: string; here: boolean };

/** What Unreal has open, as a status found it: whether an editor runs, the shown project and whether it is open, and the other set-up project that answers. */
type OpenFacts = { running: boolean; shown: string | undefined; projectOpen: boolean; openProject: OpenProject | null };

/**
 * Whether a run's linked project is one Unreal has open: the shown project while Unreal has it
 * open, the other set-up project that answers, else any project whose own log is still open or
 * whose own port (from Genex's setup records) answers for it.
 */
async function runHoldsEditor(deps: UnrealBackendDeps, storage: string, run: PluginEngineRun, open: OpenFacts) {
  if (open.shown && (await sameProject(run.project, open.shown))) return open.projectOpen;
  if (open.openProject && (await sameProject(run.project, open.openProject.file))) return true;
  const record = (await listSetUpProjects(storage)).find((p) => p.project === run.project);
  return editorHasProject(deps.env, { file: run.project, directory: path.dirname(run.project) }, record?.port);
}

/**
 * The run (a Loop) going now whose game's linked project is the one Unreal has open: that editor
 * is the run's, so neither the panel nor the Live card offers to quit it. A run whose project
 * isn't open holds nothing. The open game's own run is asked first. Null when no editor runs, and
 * from a host that names no runs.
 */
async function busyRunOf(
  deps: UnrealBackendDeps,
  context: PluginContext,
  storage: string,
  open: OpenFacts,
): Promise<BusyRun | null> {
  if (!open.running) return null;
  const answer: unknown = await context.host(HostService.EngineRuns).catch(() => []);
  const runs = Array.isArray(answer) ? answer.filter(isEngineRun) : [];
  const here = (run: PluginEngineRun) => run.game === context.project;
  for (const run of [...runs.filter(here), ...runs.filter((r) => !here(r))])
    if (await runHoldsEditor(deps, storage, run, open))
      return { title: run.title, project: run.project, here: here(run) };
  return null;
}

/** What a status found Unreal has open, for {@link busyRunOf}. */
const openFacts = (
  state: ProjectState | undefined,
  editor: { running: boolean; projectOpen: boolean },
  openProject: OpenProject | null,
): OpenFacts => ({
  running: editor.running,
  shown: state ? realProjectFile(state) : undefined,
  projectOpen: editor.projectOpen,
  openProject,
});

/** Whether a host's answer is a run as `game.engine.runs` names one. */
const isEngineRun = (value: unknown): value is PluginEngineRun =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Partial<PluginEngineRun>).game === "string" &&
  typeof (value as Partial<PluginEngineRun>).title === "string" &&
  typeof (value as Partial<PluginEngineRun>).project === "string";

/**
 * The Live card's status for the open game's own project: the step it offers (the panel's, from
 * the same facts), the project, since when it opens, the other project Unreal has open, what holds
 * Unreal, how many editors run, and the run that is using Unreal.
 */
async function stageStatus(deps: UnrealBackendDeps, context: PluginContext, scanned: () => Promise<ScannedProject[]>) {
  const options = await setupOptions(deps, context);
  const engines = await findEngines(deps.env);
  const linked = await gameLink(context);
  const state = linked ? await inspectProject(linked.project, options).catch(() => undefined) : undefined;
  const { where, openProject, next, editor, portTaken, holder } = await whereItStands(
    deps,
    state,
    engines,
    options.storage,
  );
  // Only while it starts does the card say a first start takes minutes, so only then is the recent list read.
  const starting = state && next === PanelStep.Starting;
  const sources = { env: deps.env, engines, storage: options.storage };
  const opened = starting ? await openedOf(state, { ...sources, scanned: await scanned() }) : undefined;
  return {
    next,
    project: state ? { name: state.name, file: realProjectFile(state) } : null,
    opening: where.opening,
    openProject,
    holder,
    editors: editor.editors,
    busyRun: await busyRunOf(deps, context, options.storage, openFacts(state, editor, openProject)),
    firstStart: Boolean(starting) && firstStart(opened, where.opening),
    portTaken,
  };
}

/** When Unreal's recent list last named the project as opened; undefined when it never did. */
async function openedOf(state: ProjectState, sources: Parameters<typeof findProjects>[0]) {
  return (await findProjects(sources)).find((p) => p.file === realProjectFile(state))?.opened;
}

/** The projects the panel lists, each marked when it lies outside the open game's folder (no Loop or Rewind there). */
async function listedProjects(projects: Array<{ file: string }>, context: PluginContext) {
  const game = gameFolderOf(context);
  if (!game) return projects.map((p) => ({ ...p, outside: false }));
  const folder = await realOr(game);
  return Promise.all(projects.map(async (p) => ({ ...p, outside: !isInside(folder, await realOr(p.file)) })));
}

async function status(
  deps: UnrealBackendDeps,
  args: Record<string, unknown>,
  context: PluginContext,
  scanned: () => Promise<ScannedProject[]>,
) {
  const options = await setupOptions(deps, context);
  const { env } = deps;
  const engines = await findEngines(env);
  const projects = await findProjects({ env, engines, storage: options.storage, scanned: await scanned() });
  const linked = await gameLink(context);
  const { shown, chosen } = await shownProject(args, projects, options, linked);
  const state = shown && "file" in shown ? shown : undefined;
  const { port, editor, engine, match, where, portTaken, openProject, next, holder } = await whereItStands(
    deps,
    state,
    engines,
    options.storage,
  );
  const { running, answering, editors } = editor;
  const opened = state ? projects.find((p) => p.file === realProjectFile(state))?.opened : undefined;
  const real = state ? realProjectFile(state) : undefined;
  return {
    engine: engine ?? null,
    engines,
    projects: await listedProjects(projects, context),
    port,
    project: state,
    projectError: state ? undefined : shown,
    chosen,
    engineMatch: match,
    // The panel reads these instead of spelling the setup vocabularies' wire values itself.
    setUp: isSetUp(state),
    helperOutdated: helperBehind(state),
    /** The shown project's Genex editor helper is newer than the shipped one, so setup leaves it as it is. */
    helperNewer: state?.helper === HelperState.Newer,
    firstStart: firstStart(opened, where.opening),
    /** Whether Epic's launcher is installed, asked only while no supported Unreal is (the Get Unreal view); else null. */
    launcher: engine ? null : Boolean(await findLauncher(env.platform, deps.launch.applications)),
    engineMissing: match === EngineMatch.Missing,
    editor: { running, answering, editors },
    /** Unreal has the shown project itself open, so setup and undo wait for it to quit. */
    projectOpen: editor.projectOpen,
    /** A run (a Loop) going now whose project Unreal has open, so nothing here quits it; else null. */
    busyRun: await busyRunOf(deps, context, options.storage, openFacts(state, editor, openProject)),
    /** Whether a Genex game builds in the shown project, so the panel says to open that game to use it. */
    owned: real ? await linkedToAGame(options.storage, real) : false,
    /** Whether a game is open in Genex, and the project it builds in (null while it has none). */
    game: Boolean(context.project),
    linked,
    ...where,
    portTaken,
    openProject,
    /** What Unreal has open instead of the shown project, by name, when known and the step names it; else null. */
    holder,
    /** The port Genex found still held when it opened this project, while its editor runs unanswered; else null. */
    busyPort: busyPortOf(state, editor),
    next,
    ...(await computerNotes(env, state, engine)),
  };
}

/** What setup does to the project's Genex editor helper: updates an older one to the shipped version, else adds it. */
async function helperChange(state: ProjectState, helper: string): Promise<string> {
  const folder = path.join("Plugins", HELPER_FOLDER);
  if (state.helper !== HelperState.Outdated) return MESSAGE[SetupStep.Helper](folder);
  return MESSAGE.UpdateHelper(folder, await helperVersion(helper));
}

async function describeSetup(file: string, options: SetupOptions): Promise<PluginReview> {
  const state = await inspectProject(file, options);
  const { steps, port, engine } = await planSetup(file, options);
  if (steps.length === 0) return { message: MESSAGE.NothingToChange(state.name) };
  const helperLine = await helperChange(state, options.helper);
  const lines = steps.map((step) => {
    if (step === SetupStep.Engine)
      return MESSAGE[step](path.basename(state.file), engine?.from ?? state.engine, engine?.to ?? "");
    if (step === SetupStep.Plugins) return MESSAGE[step](path.basename(state.file));
    if (step === SetupStep.AutoStart) return MESSAGE[step](settingsIniPath(options.env), port);
    return helperLine;
  });
  const detail = [MESSAGE.SetupIntro(state.name, state.file), ...lines.map((line) => `• ${line}`), MESSAGE.SetupOutro];
  return { message: MESSAGE.SetupQuestion(state.name), detail: detail.join("\n") };
}

/** The folder new games go in. */
async function projectsFolder(deps: UnrealBackendDeps): Promise<string> {
  if (deps.projects) return deps.projects();
  return unrealProjectsFolder(deps.env.platform, await documentsOf(deps));
}

/** Each backend's Windows Documents folder: its first clean answer, kept; a failed lookup is asked again next time. */
const knownDocuments = new WeakMap<UnrealBackendDeps, string>();

/**
 * The user's Documents folder, looked up once per backend on Windows (PowerShell is slow to start),
 * so the New game form, Create and the folder scan always agree; home's Documents elsewhere or
 * while the lookup fails.
 */
async function documentsOf(deps: UnrealBackendDeps): Promise<string> {
  const { env } = deps;
  const fallback = (env.platform === "win32" ? path.win32 : path.posix).join(env.home, "Documents");
  if (env.platform !== "win32") return fallback;
  const known = knownDocuments.get(deps) ?? (await askDocuments(deps.documents));
  if (known) knownDocuments.set(deps, known);
  return known ?? fallback;
}

const textArg = (args: Record<string, unknown>, key: string) => (typeof args[key] === "string" ? args[key].trim() : "");

/** The open game's link as the panel reads it: its project's real `.uproject` and its name. */
type GameLink = { project: string; name: string };

/** The calling game's link as the panel shows it, or null without a game or a link. */
async function gameLink(context: PluginContext): Promise<GameLink | null> {
  if (!context.project) return null;
  const link = await context.host(HostService.EngineRead).catch(() => null);
  return link ? { project: link.project, name: link.name } : null;
}

/** The game's own project as the editor queue reaches it: linked, set up, with its port. */
async function gameEditor(storage: string, game: string) {
  const file = await linkedProject(storage, game);
  if (!file) throw new Error(MESSAGE.NoLinkedProject);
  const recorded = (await listSetUpProjects(storage)).find((p) => p.project === file);
  if (!recorded) throw new Error(MESSAGE.LinkedNotSetUp);
  return recorded;
}

/** An editor answer as the Loop reads it: the Genex editor helper answers JSON text. */
function parsedAnswer(answer: unknown): unknown {
  if (typeof answer !== "string") return answer;
  try {
    return JSON.parse(answer);
  } catch {
    return answer;
  }
}

/**
 * A watch of the game's editor for a crash from now on: its own log, where Unreal writes it, and
 * whether an editor process still runs; its C++ module picks the frame a crash names.
 */
async function gameCrashCheck(deps: UnrealBackendDeps, storage: string, game: string) {
  const { project } = await gameEditor(storage, game);
  const log = editorLogPath({ file: project, directory: path.dirname(project) }, deps.env.home, deps.env.platform);
  const module = await projectModule(project).catch(() => undefined);
  return startCrashCheck(log, project, { running: deps.env.editorRunning, ...(module ? { module } : {}) });
}

/** The Loop's tools over the real editor; adding a game's C++ module and reopening it quit and open Unreal as the panel does. */
function loopTools(deps: UnrealBackendDeps) {
  const launch = (storage: string): LaunchOptions => ({
    env: deps.env,
    helper: deps.helper,
    storage,
    launch: deps.launch,
  });
  return createLoopTools({
    platform: deps.env.platform,
    engine: async () => (await findEngines(deps.env)).find((e) => e.supported),
    project: (storage, game) => linkedProject(storage, game),
    xcode: (engineDir) => deps.env.xcode(engineDir),
    editorCall: async (storage, game, tool: AnyLoopTool, args, timeoutMs) => {
      const call = { toolset: TOOLSET_OF[tool], tool, args, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
      return parsedAnswer(await callProjectTool(await gameEditor(storage, game), call));
    },
    // An editor whose log says Epic's server couldn't listen on the game's port throws, ending the wait.
    editorAnswers: async (storage, game) => {
      const editor = await gameEditor(storage, game).catch(() => undefined);
      return editor ? answersOrBlocked(deps.env, editor) : false;
    },
    restart: {
      editors: () => editorCount(deps.env),
      quit: (storage, project) => quitEditor(project, launch(storage)),
      open: (storage, project) => openEditor(project, launch(storage)),
      forget: (storage, project) => retireStarting(storage, project),
    },
    watchCrash: (storage, game) => gameCrashCheck(deps, storage, game),
    // A game whose project isn't set up has no start of Genex's to read.
    starting: async (storage, game) => {
      const editor = await gameEditor(storage, game).catch(() => undefined);
      return editor ? editorStart(deps.env, storage, editor, deps.launch.now()) : null;
    },
    ...(deps.processes ? { processes: deps.processes } : {}),
    now: deps.launch.now,
    sleep: (ms, signal) => sleep(ms, undefined, signal ? { signal } : undefined),
  });
}

/** The supported engine and where Xcode stands against it. */
async function engineAndXcode(env: SetupEnv) {
  const engine = (await findEngines(env)).find((e) => e.supported);
  return { engine, xcode: await env.xcode(engine?.directory) };
}

/** The steps card for a game using `state` (none yet when undefined), read now. */
async function stepsFor(env: SetupEnv, state: ProjectState | undefined): Promise<UnrealSteps> {
  const { engine, xcode } = await engineAndXcode(env);
  return unrealSteps(state?.name ?? null, engine?.version ?? "", xcode);
}

/** A set-up project's state, or why it can't be linked. */
async function setUpState(file: string, options: SetupOptions): Promise<ProjectState> {
  const state = await inspectProject(file, options);
  const { name } = state;
  if (!isSetUp(state)) throw new Error(MESSAGE.NotSetUp(name));
  return state;
}

/** Links the calling game to a set-up project through the host, which shows it in the chat with Undo. */
async function linkGame(deps: UnrealBackendDeps, file: string, context: PluginContext): Promise<PluginEngineLink> {
  if (!context.project) throw new Error(MESSAGE.NoGame);
  const state = await setUpState(file, await setupOptions(deps, context));
  return context.host(HostService.EngineLink, { project: realProjectFile(state) });
}

/** The project a game uses now: its link, else the panel's choice; undefined when neither is set up. */
async function gameProject(deps: UnrealBackendDeps, context: PluginContext): Promise<ProjectState | undefined> {
  const options = await setupOptions(deps, context);
  const linked = context.project ? await context.host(HostService.EngineRead) : null;
  const file = linked?.project ?? (await chosenProject(options.storage));
  const state = file ? await inspectProject(file, options).catch(() => undefined) : undefined;
  return isSetUp(state) ? state : undefined;
}

/** A project the agent names: a `.uproject` path, or a set-up project's name in any case. */
async function namedProject(asked: string, storage: string): Promise<string> {
  const wanted = asked.toLowerCase();
  if (isProjectPath(asked)) return asked;
  const setUp = await listSetUpProjects(storage);
  if (setUp.length === 0) throw new Error(MESSAGE.NoSetUpProject);
  const found = setUp.find((p) => p.name.toLowerCase() === wanted);
  if (!found) throw new Error(MESSAGE.UnknownProject(wanted, setUp.map((p) => p.name).join(", ")));
  return found.project;
}

/**
 * Opens Xcode's App Store page, the Xcode app the probes found, or Apple's developer downloads;
 * never a path or address from the caller.
 */
async function getXcode(deps: UnrealBackendDeps, args: Record<string, unknown>) {
  if (deps.env.platform !== "darwin") throw new Error(MESSAGE.XcodeMacOnly);
  if (args.step === XcodeStep.Downloads) {
    await deps.launch.open(xcodeDownloadsLaunch());
    return { opened: XcodeStep.Downloads };
  }
  const step = args.step === XcodeStep.Open ? XcodeStep.Open : XcodeStep.Install;
  const { xcode } = await engineAndXcode(deps.env);
  await deps.launch.open(getXcodeLaunch(step, xcode.app));
  return { opened: step };
}

/** The seconds a `wait-editor` call asks for, as a whole number from 0; anything else is 0, a look. */
function waitSeconds(args: Record<string, unknown>): number {
  const seconds = Number(args.seconds);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
}

/**
 * The harness's `wait-editor`: waits up to `seconds` for the game's own linked, set-up project's
 * editor to answer, and says where it stands (`EditorWait`) and which project it is.
 */
async function waitEditor(deps: UnrealBackendDeps, args: Record<string, unknown>, context: PluginContext) {
  const { storage } = await setupOptions(deps, context);
  const linked = await gameLink(context);
  const editor = linked ? (await listSetUpProjects(storage)).find((p) => p.project === linked.project) : undefined;
  if (!editor) return { state: EditorWait.NoProject, project: null };
  const { env, launch } = deps;
  const state = await waitForEditor(
    {
      answers: () => answersOrBlocked(env, editor).catch(() => false),
      start: () => editorStart(env, storage, editor, launch.now()),
      now: launch.now,
      sleep: (ms, signal) => sleep(ms, undefined, signal ? { signal } : undefined),
    },
    waitSeconds(args) * SECOND_MS,
    context.signal,
  );
  return { state, project: editor.name };
}

/** The agent's `show-steps`: the card in its chat while a step is open. */
async function showSteps(deps: UnrealBackendDeps, context: PluginContext): Promise<string> {
  const steps = await stepsFor(deps.env, await gameProject(deps, context));
  if (!steps.open) return MESSAGE.StepsDone;
  return (await context.host(HostService.EngineSteps)) ? MESSAGE.StepsShown : MESSAGE.StepsNoChat;
}

/**
 * The New game form's choices: the template cards, a free name, and where the game will be saved
 * (`folder`, and `place` as the panel names it, such as Documents › Unreal Projects). Cards come
 * only from an engine whose creation steps Genex compared with Epic's; with only a newer one,
 * `newestUnverified` names it so the panel can say to use Unreal's own dialog.
 */
async function templates(deps: UnrealBackendDeps, context: PluginContext) {
  const engines = await findEngines(deps.env);
  const engine = engines.find(canCreateWith);
  const newest = engines.find((e) => e.supported);
  const inGame = gameFolderOf(context);
  const folder = inGame ? path.join(inGame, GAME_PROJECT_FOLDER) : await projectsFolder(deps);
  const place = await placeOf(folder, deps.env.home);
  return {
    templates: engine ? await listTemplates(engine) : [],
    newestUnverified: !engine && newest ? newest.version : null,
    name: await suggestName(folder, deps.env.platform),
    folder,
    place,
    /** No game is open: Create also makes a Genex game for the project, as `<game>/unreal/`. */
    newGame: !inGame,
  };
}

/** The open Genex game's folder, where New game makes its project; undefined outside a game. */
const gameFolderOf = (context: PluginContext): string | undefined =>
  context.project && context.directory ? context.directory : undefined;

/** A Genex game the host made for a new Unreal project: its name and its folder. */
type MadeGame = { project: string; directory: string };

const isMadeGame = (value: unknown): value is MadeGame =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Partial<MadeGame>).project === "string" &&
  typeof (value as Partial<MadeGame>).directory === "string";

/**
 * A new Genex game for a New Unreal project made with no game open, titled after it, so the
 * project sits in the game's `unreal/` folder where Loops and Rewind reach it. Undefined when the
 * host makes no games for plugins: the project then goes in Documents › Unreal Projects.
 */
async function madeGame(context: PluginContext, title: string): Promise<MadeGame | undefined> {
  const made = await context.host(HostService.GameCreate, { title }).catch(() => undefined);
  return isMadeGame(made) ? made : undefined;
}

/** The new project's request from the action's arguments: an allowlisted template, a variant and a name. */
function newProjectRequest(deps: UnrealBackendDeps, engine: Engine, args: Record<string, unknown>) {
  const variant = textArg(args, "variant");
  return {
    engine,
    template: textArg(args, "template"),
    name: textArg(args, "name"),
    ...(variant ? { variant } : {}),
    platform: deps.env.platform,
  };
}

/**
 * Where a new project goes: the open game's folder, else a Genex game made for it (its name and
 * template are checked first, so a refusal makes no game), else Documents › Unreal Projects.
 */
async function projectHome(
  deps: UnrealBackendDeps,
  context: PluginContext,
  request: Omit<CreateRequest, "parent">,
): Promise<{ game: string | undefined; made: MadeGame | null }> {
  const inGame = gameFolderOf(context);
  if (inGame) return { game: inGame, made: null };
  await assertTemplateAndName(request);
  const made = await madeGame(context, request.name);
  return { game: made?.directory, made: made ?? null };
}

/**
 * Makes a new game from a template (and variant) and sets it up at once, recorded like any setup
 * so Undo works. It goes in a Genex game's folder as `unreal/` (the game's ignore file gains
 * Unreal's scratch folders) and becomes that game's project: the open game's, or with none open a
 * game the host makes for it; only a host that makes none leaves it in Documents › Unreal Projects.
 * No confirmation: nothing else that exists changes. It becomes the panel's chosen project.
 */
async function create(deps: UnrealBackendDeps, args: Record<string, unknown>, context: PluginContext) {
  const engines = await findEngines(deps.env);
  const engine = engines.find(canCreateWith);
  const newest = engines.find((e) => e.supported);
  if (!newest) throw noEngineError();
  if (!engine) throw unverifiedEngineError(newest.version);
  const asked = newProjectRequest(deps, engine, args);
  const { game, made } = await projectHome(deps, context, asked);
  const request: CreateRequest = {
    ...asked,
    parent: game ?? (await projectsFolder(deps)),
    ...(game ? { folder: GAME_PROJECT_FOLDER } : {}),
  };
  if (game) {
    // Everything is checked before the game's ignore file gains a line: a refusal changes nothing.
    await assertGameFolderFree(game);
    await assertCreatable(request);
    await ignoreUnrealScratch(game);
  }
  const file = await createProject(request);
  const options = await setupOptions(deps, context);
  const state = await setUpProject(file, options, { newProject: true });
  const project = realProjectFile(state);
  await rememberChoice(options.storage, project);
  // A new project made for a Genex game is that game's project from now on.
  if (context.project) await context.host(HostService.EngineLink, { project });
  else if (made) await context.host(HostService.EngineLink, { project, game: made.project });
  return { project: file, state, game: made ? { project: made.project } : null };
}

/** A path by its real path, or as it is when it can't be resolved. */
const realOr = (file: string) => realpath(file).catch(() => file);

/**
 * How a user's own Open updates an older Genex editor helper: only for the open game's own linked
 * project, with a snapshot of that game first, since its snapshot is what holds the project's
 * folder. Any other project (none is open, or the game is linked to another) keeps its helper.
 */
async function helperUpdateFor(
  file: string,
  storage: string,
  context: PluginContext,
): Promise<HelperUpdateOnOpen | undefined> {
  const linked = await linkedProject(storage, context.project);
  if (!context.project || !linked || (await realOr(linked)) !== (await realOr(file))) return undefined;
  const reason = MESSAGE.SnapshotBeforeUpdate;
  return { snapshot: () => context.host(HostService.GameSnapshot, { reason }) };
}

/** A user's own Open in Unreal: the panel's, the stage's and the agent's New game; never the Loop's restarts. */
async function openForUser(deps: UnrealBackendDeps, file: string, context: PluginContext) {
  const options = await launchOptions(deps, context);
  const helperUpdate = await helperUpdateFor(file, options.storage, context);
  const opened = await openEditor(file, options, helperUpdate ? { helperUpdate } : {});
  return { ...opened, ...updateNote(opened) };
}

/** What the panel says after an Open that kept files the user changed in the helper, as its `note`. */
function updateNote(opened: OpenResult): { note: string } | Record<string, never> {
  const kept = opened.helper?.kept.length ?? 0;
  return opened.helper && kept > 0 ? { note: MESSAGE.KeptOnUpdate(opened.helper.to, kept) } : {};
}

/**
 * The agent's `new-game`: New game exactly as the panel makes it from an open game (in the game's
 * folder as `unreal/`, set up, linked to the game), then opened in Unreal. Only from an open game:
 * the agent never makes a project in Documents › Unreal Projects. A project made but not opened
 * stays made and linked, and the answer says why Unreal didn't open.
 */
async function newGame(deps: UnrealBackendDeps, args: Record<string, unknown>, context: PluginContext) {
  if (!gameFolderOf(context)) throw new Error(MESSAGE.NoGame);
  const made = await create(deps, args, context);
  const opened = await openForUser(deps, made.project, context).then(
    () => undefined,
    (error: unknown) => errorMessage(error),
  );
  // The setup card in the chat while a step (Xcode, for C++) is still open.
  if ((await stepsFor(deps.env, made.state)).open) await context.host(HostService.EngineSteps);
  const project = realProjectFile(made.state);
  return opened === undefined ? MESSAGE.NewGame(project) : MESSAGE.NewGameNotOpened(project, opened);
}

/** Undoes setup; `note` says how many helper files the user changed were left in place. */
async function undo(file: string, options: SetupOptions) {
  const state = await undoSetup(file, options);
  return { ...state, note: state.kept.length > 0 ? MESSAGE.KeptAfterUndo(state.kept.length) : null };
}

/** Sets the project up and makes it the chosen one, which the bridge tries first. */
async function setUp(file: string, options: SetupOptions): Promise<ProjectState> {
  const state = await setUpProject(file, options);
  await rememberChoice(options.storage, realProjectFile(state));
  return state;
}

type ActionHandler = (args: Record<string, unknown>, context: PluginContext) => Promise<unknown>;
type ToolHandler = (args: Record<string, unknown>, context: PluginContext) => Promise<unknown>;

async function launchOptions(deps: UnrealBackendDeps, context: PluginContext): Promise<LaunchOptions> {
  return { ...(await setupOptions(deps, context)), launch: deps.launch };
}

/** The backend with the computer, helper and launcher it is given; tests hand in fakes. */
export function createUnrealBackend(deps: UnrealBackendDeps): PluginActivation {
  // One scan of the Unreal Projects folder answers the panel's refreshes for a few seconds.
  const scanned = keepFor(SCAN_KEEP_MS, deps.launch.now, async () => scanProjectsFolder(await projectsFolder(deps)));
  const actions: Record<UnrealAction, ActionHandler> = {
    [UnrealAction.Status]: (args, context) => status(deps, args, context, scanned),
    [UnrealAction.Setup]: async (args, context) => setUp(projectArg(args), await setupOptions(deps, context)),
    [UnrealAction.UndoSetup]: async (args, context) => undo(projectArg(args), await setupOptions(deps, context)),
    [UnrealAction.Templates]: (_args, context) => templates(deps, context),
    [UnrealAction.Create]: (args, context) => create(deps, args, context),
    [UnrealAction.OpenEditor]: (args, context) => openForUser(deps, projectArg(args), context),
    [UnrealAction.QuitEditor]: async (args, context) =>
      quitEditor(projectArg(args), await launchOptions(deps, context)),
    [UnrealAction.GetUnreal]: () => getUnreal(deps.env, deps.launch),
    [UnrealAction.ToolbarStatus]: async (_args, context) =>
      toolbarStatus(deps.env, (await setupOptions(deps, context)).storage, deps.launch.now(), context.project),
    [UnrealAction.UseProject]: (args, context) => linkGame(deps, projectArg(args), context),
    [UnrealAction.Steps]: async (_args, context) => stepsFor(deps.env, await gameProject(deps, context)),
    [UnrealAction.GetXcode]: (args) => getXcode(deps, args),
    [UnrealAction.StageStatus]: (_args, context) => stageStatus(deps, context, scanned),
  };
  const loop = loopTools(deps);
  const tools: Record<UnrealTool, ToolHandler> = {
    [UnrealTool.UseProject]: async (args, context) => {
      const storage = (await setupOptions(deps, context)).storage;
      const link = await linkGame(deps, await namedProject(textArg(args, "project"), storage), context);
      return MESSAGE.Linked(link.name, link.project);
    },
    [UnrealTool.ShowSteps]: (_args, context) => showSteps(deps, context),
    [UnrealTool.NewGame]: (args, context) => newGame(deps, args, context),
    [UnrealTool.WaitEditor]: (args, context) => waitEditor(deps, args, context),
    [UnrealTool.EngineStatus]: async () => readinessAnswer(engineReadiness(await findEngines(deps.env))),
  };
  return {
    async action(name, args, context) {
      if (!isUnrealAction(name)) throw new Error(MESSAGE.UnknownAction(name));
      return actions[name](args, context);
    },
    async tool(name, args, context) {
      if (loop.has(name)) return loop.call(name, args, context, (await setupOptions(deps, context)).storage);
      if (!isUnrealTool(name)) throw new Error(MESSAGE.UnknownTool(name));
      return tools[name](args, context);
    },
    async review(name, args, context): Promise<PluginReview> {
      const options = await setupOptions(deps, context);
      if (name === UnrealAction.Setup) return describeSetup(projectArg(args), options);
      if (name === UnrealAction.UndoSetup) {
        const project = (await inspectProject(projectArg(args), options)).name;
        return { message: MESSAGE.UndoQuestion(project), detail: MESSAGE.Undo(project) };
      }
      return {};
    },
  };
}

export const activate: Activate = () => {
  const env = systemSetupEnv();
  return createUnrealBackend({
    env,
    helper: path.join(path.dirname(fileURLToPath(import.meta.url)), HELPER_FOLDER),
    launch: systemLaunchEnv(),
    processes: systemProcesses(env.home),
  });
};
