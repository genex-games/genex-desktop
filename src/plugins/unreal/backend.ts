import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { agentsSetting, setAgentsSetting } from "../../substrate/engine-agents.ts";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { t } from "../../shared/i18n.ts";
import { EngineHostAction } from "../../shared/game-engine.ts";
import { isInside } from "../../substrate/paths.ts";
import { projectRayTracing, turnOffRayTracing } from "./ray-tracing.ts";
import type {
  Activate,
  PluginActivation,
  PluginContext,
  PluginEngineAssistRefusal,
  PluginEngineLink,
  PluginEngineRun,
  PluginReview,
} from "../../plugin-sdk/index.d.ts";
import {
  askDocuments,
  assertCreatable,
  BlueprintTemplate,
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
  LaunchError,
  LaunchErrorCode,
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
import { addCppModule, enableProjectPlugin, projectModule } from "./cpp-module.ts";
import {
  assertPluginName,
  planPlugin,
  PluginTemplate,
  type PluginTemplateFiles,
  readPluginTemplate,
  writePlugin,
} from "./plugin-scaffold.ts";
import { editorLogPath, startCrashCheck } from "./editor-log.ts";
import {
  chosenProject,
  linkedProject,
  linkedToAGame,
  listSetUpProjects,
  rememberChoice,
  rememberWant,
  sameProject,
  wantsUnreal,
} from "./editor-port.ts";
import { callProjectTool } from "./editor-mcp.ts";
import { type ProcessEnv, systemProcesses } from "./editor-reopen.ts";
import { pollUntil } from "./editor-queue.ts";
import { QUIT_WAIT_MS, RESTART_POLL_MS } from "./editor-restart.ts";
import { type AnyLoopTool, createLoopTools, type LoopToolsDeps, TOOLSET_OF } from "./loop-tools.ts";
import {
  type ForMeWork,
  InstallCardAction,
  launcherInstallPath,
  UnrealStepId,
  type UnrealSteps,
  unrealInstallCard,
  unrealSteps,
  XcodeStep,
} from "./engine-steps.ts";
import {
  type EpicInstallDeps,
  EpicInstallError,
  EpicInstallKind,
  EpicInstallPhase,
  hasUnrealRuntime,
  installEpicLauncher,
  installUnrealRuntime,
  systemEpicRun,
  systemFolder,
} from "./epic-install.ts";
import {
  assertGameFolderFree,
  GAME_PROJECT_FOLDER,
  ignoreUnrealScratch,
  placeTaken,
  readGameIgnore,
  undoGameProjectFolder,
} from "./game-folder.ts";
import { isProjectPath, UPROJECT_EXTENSION } from "./project-file.ts";
import { xcodeDownloadsLaunch } from "./xcode.ts";
import { EditorWait, EngineReadiness, engineReadiness, waitForEditor } from "./editor-wait.ts";
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
  adoptSetUp,
  type Engine,
  EngineMatch,
  engineMatch,
  findEngines,
  installEngineVersion,
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
  SetupErrorCode,
  type SetupEnv,
  type SetupOptions,
  SetupStep,
  settingsIniPath,
  setUpProject,
  systemSetupEnv,
  undoSetup,
  forgetSetup,
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
  EngineAssist: "game.engine.assist",
  EngineCanAssist: "game.engine.canAssist",
} as const;
/** The actions plugin.json declares. */
const UnrealAction = {
  Status: "status",
  Setup: "setup",
  /** Also what a link's Undo runs, with `ifSetUp`, when the link set its project up. */
  UndoSetup: EngineHostAction.UndoSetUp,
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
  RayTracingOff: "ray-tracing-off",
  Skip: "skip",
  ForMe: InstallCardAction.ForMe,
  StopForMe: InstallCardAction.StopForMe,
  Agents: "agents",
  AgentsGoAhead: "agents-go-ahead",
  AgentsWait: "agents-wait",
} as const;
type UnrealAction = (typeof UnrealAction)[keyof typeof UnrealAction];
const ACTION_NAMES: ReadonlySet<string> = new Set(Object.values(UnrealAction));
const isUnrealAction = (name: string): name is UnrealAction => ACTION_NAMES.has(name);
/** The tools plugin.json declares: the agent's, then the harness's own (`audience: harness`). */
const UnrealTool = {
  UseProject: "use-project",
  ShowSteps: "show-steps",
  NewGame: "new-game",
  NewPlugin: "new-plugin",
  WaitEditor: "wait-editor",
  EngineStatus: "engine-status",
  InstallUnreal: "install-unreal",
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
 * is free (`open-when-free`: Unreal has some other project open, which nothing here quits), or
 * close Unreal's crash report first (`crashed`: its reporter keeps the project's port).
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
  Crashed: "crashed",
} as const;
export type PanelStep = (typeof PanelStep)[keyof typeof PanelStep];

const GIB = 1024 ** 3;
/** The plugin storage folder holding each game's Don't use Unreal. */
const SKIPPED_FOLDER = path.join("engine-setup", "skipped");
/** Below this much free disk an Unreal project soon runs out of room (shaders, caches, builds). */
const LOW_DISK_BYTES = 20 * GIB;
/** Epic's 5.8 install size, as the Get Unreal view's step 2 says. */
const UNREAL_INSTALL_BYTES = 45 * GIB;
/** Unreal writes a project's LastOpenTime about 14 s into the start Genex launched; this much earlier is still that start. */
const FIRST_START_SKEW_MS = SECOND_MS;
/** Epic's minimum memory for the editor. */
const LOW_MEMORY_BYTES = 16 * GIB;
/** What a plugin's host project is named after it: `<Name>Host`. */
const HOST_SUFFIX = "Host";

/** What the agent's tools answer and throw, which the agent reads: English. */
const MESSAGE = {
  UnknownTool: (name: string) => `Unknown Unreal tool: ${name}`,
  NoGame: "Open a game in Genex first: an Unreal project is used by a game.",
  NoSetUpProject:
    "No Unreal project is set up for Genex yet. Give unreal__use-project the project's .uproject path: it sets the project up and links it.",
  UnknownProject: (asked: string, names: string) =>
    `No set-up Unreal project is called ${asked}. The set-up projects are: ${names}. For another project, give its .uproject path.`,
  Linked: (name: string, file: string) =>
    `This game now builds in ${name} (${file}). Later Unreal calls in this game go to it.`,
  SetUpAndLinked: (name: string, file: string) =>
    `Set up ${name} for Genex and linked this game to it (${file}); the chat shows both with one Undo. Later Unreal calls in this game go to it.`,
  SetUpReopened: (name: string, file: string) =>
    `Unreal had ${name} open, so Genex quit it (Unreal asked about any unsaved work itself), set it up for Genex and linked this game to it (${file}); the chat shows both with one Undo. Unreal is opening ${name} again: call unreal__editor-status with seconds until it answers. Later Unreal calls in this game go to it.`,
  SetUpNotReopened: (name: string, file: string, why: string) =>
    `Unreal had ${name} open, so Genex quit it, set it up for Genex and linked this game to it (${file}); the chat shows both with one Undo. Unreal didn't open it again: ${why.replace(/\.?$/, ".")} Call unreal__open-editor.`,
  SetUpNotClosed: (name: string) =>
    `Genex asked Unreal to quit ${name} so it can set it up, but it is still open after ${QUIT_WAIT_MS / SECOND_MS} s: Unreal may be asking whether to save changes. Ask the user to answer it in Unreal, then call unreal__use-project again.`,
  SetUpLooped: (title: string, name: string) =>
    `${title}'s Loop is using ${name} in Unreal, so Genex didn't quit it to set it up. Call unreal__use-project again once that Loop has ended.`,
  SetUpNotQuitForRun: (name: string) =>
    `${name} isn't set up for Genex here, and Unreal has ${name} open, so Genex didn't quit it at the Loop's start. Call unreal__use-project with its .uproject path (it quits Unreal, sets the project up and opens it again), then start the Loop again.`,
  SetUpTwoEditors: (name: string) =>
    `Two Unreal editors are open, so Genex can't tell which one to quit to set up ${name}. Ask the user to quit the one that has ${name} open, then call unreal__use-project again.`,
  SetUpRefused: (name: string, why: string) => `Genex couldn't set up ${name}: ${why}`,
  SetUpSwitchesEngine: (name: string, from: string, to: string) =>
    `${name} was made in Unreal ${from}, and switching it to ${to} is the user's choice. Ask the user to press Set up in the Unreal panel, then call unreal__use-project again.`,
  StepsShown: "The Unreal setup card is in the chat.",
  InstallCardShown: (version: string) =>
    `The Unreal setup card is in the chat, and the Unreal button is above the game: its Do it for me gets Epic's launcher and installs Unreal ${version} in it with computer control (only the user signs in to Epic). Call unreal__install-unreal to start that yourself, or tell them in one line; then end your reply. The chat tells you when Unreal is installed.`,
  /** The task Do it for me hands the game's chat: one plain line, at most 300 characters. */
  InstallTask: (version: string) =>
    `Install Unreal Engine ${version} in the Epic Games Launcher Genex opened: Unreal Engine › Library › + beside Engine Versions › ${version} (not a newer one) › Install, default folder. If Epic asks to sign in or anything else, stop and ask the person.`,
  ForMeLauncher: (version: string) =>
    `Genex is downloading Epic's launcher from Epic and installing it (Windows asks the person for permission); the setup card shows where it stands. End your reply now. Once the card says the launcher is installed, call unreal__install-unreal again to install Unreal ${version} in it.`,
  ForMeDownloadPage:
    "Epic's download page is open in the person's browser: on this computer they install Epic's launcher themselves. Tell them in one line and end your reply; once it is installed, call unreal__install-unreal again.",
  ForMeEngine: (version: string) =>
    `Genex opened the Epic Games Launcher and handed the install to this chat: the message "Unreal Engine asks: Install Unreal Engine ${version}…" is done by the turn that answers it, with the desktop tool on the launcher. End your reply now. Unreal is about 45 GB; the chat tells you when it is installed.`,
  ForMeEngineRefused: (version: string, reason: string) =>
    `Genex couldn't hand the install to this chat (${reason}). The Epic Games Launcher is open: tell the person in one line to install Unreal ${version} there (Library, + beside Engine Versions, ${version}, Install), then end your reply; the chat tells you when it is installed.`,
  ForMeRuntime:
    "Genex is installing Microsoft's Visual C++ runtime, which Unreal's editor needs, from Unreal's own copy (Windows asks the person for permission). End your reply now; the chat tells you when it is done.",
  ForMeRuntimeYourself:
    "Unreal's editor needs Microsoft's Visual C++ runtime, which isn't on this computer, and Genex can't install it here. Ask the person to run vc_redist.x64.exe from Unreal's Engine/Extras/Redist/en-us folder.",
  ForMeRunning: (words: string) => `Do it for me is already installing; the card says: ${words} End your reply now.`,
  ForMeDone: (version: string) =>
    `Unreal ${version} and everything it needs are on this computer: call unreal__new-game if this game has no Unreal project yet.`,
  ForMeStuck: (words: string) =>
    `Do it for me stopped; the card says: ${words} Tell the person in one line, and offer to try again with unreal__install-unreal.`,
  NoRuntime:
    "Unreal's editor needs Microsoft's Visual C++ runtime, which isn't on this computer, so Genex made no project: Unreal couldn't open it. Call unreal__install-unreal, which installs the runtime from Unreal's own copy (Windows asks the person for permission), end your reply, and call new-game again once the chat says it is done.",
  ButtonOut: (version: string) =>
    `The Unreal button is now above the game. Ask the user to press it: it shows how to get Unreal Engine ${version} free from Epic and notices when it's installed. They send a message once it is.`,
  NewGame: (file: string) =>
    `Made this game's Unreal project, ${file}, set it up for Genex and linked this game to it. Unreal is opening it now; a first start can take several minutes while it prepares shaders. Don't wait for it and don't promise to check back later: end your reply now by telling the user what you will build first. Genex continues this chat by itself as soon as Unreal is ready, and from then on the Unreal tools reach this project.`,
  NewGameNotOpened: (file: string, why: string) =>
    `Made this game's Unreal project, ${file}, set it up for Genex and linked this game to it, but Unreal didn't open it: ${why.replace(/\.?$/, ".")} Call unreal__open-editor to open it.`,
  NewPlugin: (name: string, host: string) =>
    `Made ${name} in unreal/Plugins/${name}/, inside the host project ${host}. Build it with plugin-build, then write tests and package it.`,
  StepsDone: "Every recommended step is done; there is no card to show.",
  StepsNoChat: "There is no chat to show the Unreal setup card in.",
  NoLinkedProject: "This game isn't linked to an Unreal project yet.",
  LinkedNotSetUp:
    "This game's Unreal project isn't set up for Genex here. Call unreal__open-editor: it sets the project up (quitting Unreal first when it has it open) and opens it.",
  /** The reason of the game snapshot Open takes before it updates the helper or adds Epic's toolsets, as Rewind lists it; kept in the snapshot as written. */
  SnapshotBeforeUpdate: "Before Genex updated the Unreal project",
} as const;

/**
 * What a person reads: the panel's errors and notes, and Studio's confirmation (`review`) before
 * setup, undo and turning ray tracing off.
 */
const WORDS = {
  UnknownAction: (name: string) => t("Unknown Unreal action: {name}", { name }),
  NoGame: () => t("Open a game in Genex first: an Unreal project is used by a game."),
  NotSetUp: (name: string) => t("{name} isn't set up for Genex yet. Set it up first.", { name }),
  XcodeMacOnly: () => t("Xcode is for a Mac. On Windows, Unreal builds C++ with Visual Studio."),
  SetupQuestion: (name: string) => t("Set up {name} for Genex?", { name }),
  SetupIntro: (name: string, file: string) => t("Genex will change {name} ({file}):", { name, file }),
  UndoQuestion: (name: string) => t("Undo setup for {name}?", { name }),
  RayTracingQuestion: (name: string) => t("Turn off ray tracing in {name}?", { name }),
  RayTracingDetail: (name: string) =>
    t(
      "Genex will set r.RayTracing=False in {name}'s Config/DefaultEngine.ini. On a Mac, Unreal 5.8 can crash while it renders a ray-traced game behind another app. Lumen keeps lighting the level in software, and you can turn ray tracing back on in Project Settings. Unreal uses the change from its next start.",
      { name },
    ),
  [SetupStep.Engine]: (file: string, from: string, to: string) =>
    t(
      "{file}: switch from Unreal {from} to {to}. Content you save in {to} won't open in {from}. To keep a {from} version, duplicate the project folder first.",
      { file, from, to },
    ),
  /** The plugin step names only what it still changes: Epic's MCP plugins, its toolsets, or both. */
  [SetupStep.Plugins]: (file: string, pluginsOn: boolean, toolsetsIn: boolean) => {
    if (pluginsOn)
      return t("{file}: add Epic's toolsets for UI, effects, AI, animation, procedural content and physics.", { file });
    if (toolsetsIn) return t("{file}: turn on Epic's ModelContextProtocol and EditorToolset plugins.", { file });
    return t(
      "{file}: turn on Epic's ModelContextProtocol and EditorToolset plugins, and add Epic's toolsets for UI, effects, AI, animation, procedural content and physics.",
      { file },
    );
  },
  [SetupStep.AutoStart]: (file: string, port: number) =>
    t("{file}: start Unreal's MCP server on port {port} whenever the project opens.", { file, port }),
  [SetupStep.Helper]: (folder: string) => t("{folder}: add the Genex editor helper, a few Python files.", { folder }),
  UpdateHelper: (folder: string, version: string | undefined) =>
    version
      ? t("{folder}: update the Genex editor helper to {version}, a few changed Python files.", { folder, version })
      : t("{folder}: update the Genex editor helper, a few changed Python files.", { folder }),
  SetupOutro: () =>
    t(
      "Genex keeps a copy of each file first, and Undo setup takes these changes back. A Genex editor helper file you changed is kept beside it as a .mine copy.",
    ),
  NothingToChange: (name: string) => t("{name} is already set up. Nothing will change.", { name }),
  Undo: (name: string) =>
    t(
      "Genex will take back what it added to {name}: its plugin entries, the MCP server start-up lines and the Genex editor helper. Anything else you changed stays.",
      { name },
    ),
  KeptAfterUndo: (count: number) =>
    t(
      "{count, plural, one {Genex left # file you changed in Plugins/{folder}.} other {Genex left # files you changed in Plugins/{folder}.}}",
      { count, folder: HELPER_FOLDER },
    ),
  KeptOnUpdate: (version: string, count: number) =>
    t(
      "{count, plural, one {Genex updated the Genex editor helper to {version} and kept # file you changed beside the new one as .mine.} other {Genex updated the Genex editor helper to {version} and kept # files you changed beside the new ones as .mine.}}",
      { version, count },
    ),
} as const;

/** Where Epic's launcher installs an engine version, as the person clicks it there. */
const engineClicks = (version: string) => ({ version, clicks: launcherInstallPath(version) });

/** Where each install Do it for me runs stands, in the person's words; a stop says its own. */
const PHASE_WORDS: Record<EpicInstallKind, Partial<Record<EpicInstallPhase, () => string>>> = {
  [EpicInstallKind.Launcher]: {
    [EpicInstallPhase.Downloading]: () => t("Downloading the Epic Games Launcher from Epic…"),
    [EpicInstallPhase.Checking]: () => t("Checking that Epic signed the installer…"),
    [EpicInstallPhase.Installing]: () => t("Installing the Epic Games Launcher. Choose Yes when Windows asks."),
    [EpicInstallPhase.Done]: () => t("The Epic Games Launcher is installed. Sign in to Epic in it."),
  },
  [EpicInstallKind.Runtime]: {
    [EpicInstallPhase.Checking]: () => t("Checking that Microsoft signed Unreal's runtime installer…"),
    [EpicInstallPhase.Installing]: () => t("Installing Microsoft's Visual C++ runtime. Choose Yes when Windows asks."),
    [EpicInstallPhase.Done]: () => t("Microsoft's Visual C++ runtime is installed."),
  },
};

/** What Do it for me says to the person about each press. */
const FOR_ME_WORDS = {
  Failed: () => t("The installer stopped before it finished. Try again."),
  DownloadPage: () => t("Epic's download page is opening in your browser."),
  EngineStarted: () =>
    t(
      "This game's chat is installing Unreal in the Epic Games Launcher. If Genex asks you something first, answer it in this game's chat, and sign in to Epic if the launcher asks.",
    ),
  EngineUnavailable: (version: string) =>
    t(
      "Genex can't click in the launcher on this computer. Install Unreal {version} yourself: {clicks}.",
      engineClicks(version),
    ),
  EngineDeclined: (version: string) =>
    t("Nothing was clicked. Install Unreal {version} yourself in the launcher: {clicks}.", engineClicks(version)),
  EngineNoChat: (version: string) =>
    t(
      "Open a game first, so its chat can install Unreal for you, or install Unreal {version} yourself in the launcher: {clicks}.",
      engineClicks(version),
    ),
  EngineNotStarted: (version: string) =>
    t(
      "Genex didn't click anything. Install Unreal {version} yourself in the launcher: {clicks}.",
      engineClicks(version),
    ),
  RuntimeYourself: () =>
    t(
      "Run vc_redist.x64.exe from Unreal's Engine › Extras › Redist › en-us folder to install Microsoft's Visual C++ runtime.",
    ),
  AllThere: (version: string) => t("Unreal {version} and everything it needs are on this computer.", { version }),
  Stopped: () => t("Stopped."),
  NothingToStop: () => t("Nothing is installing."),
} as const;

/** The engine step's refusals in the person's words; any other reads as not started. */
const ENGINE_REFUSED: Partial<Record<PluginEngineAssistRefusal, (version: string) => string>> = {
  unavailable: FOR_ME_WORDS.EngineUnavailable,
  declined: FOR_ME_WORDS.EngineDeclined,
  "no-chat": FOR_ME_WORDS.EngineNoChat,
};

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
  /** Aborts once the backend stops: its running jobs (a plugin's build, tests and package) end with it. */
  stopped?: AbortSignal;
  /** The programs a plugin's build, tests and package and a game's package run; UBT, the headless editor and UAT unless a test stands in. */
  programs?: Pick<LoopToolsDeps, "compile" | "runProgram" | "runCommand" | "prepareSandbox" | "runUat">;
  /**
   * What Do it for me installs Epic's launcher and Microsoft's runtime with on Windows (the network,
   * PowerShell's signature check, the installers); without it, the launcher's step opens Epic's
   * download page and the runtime is the person's to install.
   */
  install?: EpicInstallDeps;
  /** Whether Windows has the Visual C++ runtime Unreal's editor loads; counted as there without it. */
  runtime?: () => Promise<boolean>;
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
  /** Unreal crashed: its crash reporter holds the set-up project's port until the report is closed. */
  crashed: boolean;
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
  // Setup would move the port and a restart couldn't take it back: the report has to close first.
  if (facts.crashed) return PanelStep.Crashed;
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

const MAC: NodeJS.Platform = "darwin";

/** Whether the shown project ray-traces on a Mac, where UE 5.8 then crashes behind another app (`ray-tracing.ts`). */
async function rayTracingRisk(env: SetupEnv, state: ProjectState | undefined): Promise<boolean> {
  return env.platform === MAC && state !== undefined && (await projectRayTracing(realProjectFile(state)));
}

/** Turns hardware ray tracing off in a project Genex knows (`ray-tracing-off`). */
async function rayTracingOff(file: string, options: SetupOptions): Promise<{ rayTracing: false }> {
  const state = await inspectProject(file, options);
  await turnOffRayTracing(realProjectFile(state));
  return { rayTracing: false };
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

/** Whether Unreal's crash reporter holds the set-up project's port while its editor doesn't answer: Unreal crashed. */
async function crashReporterOn(env: SetupEnv, state: ProjectState | undefined, editor: { answering: boolean }) {
  const port = isSetUp(state) ? state.port : null;
  if (port === null || editor.answering || !env.crashReporterHolds) return false;
  return (await env.crashReporterHolds(port).catch(() => undefined)) === true;
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
  const crashed = await crashReporterOn(env, state, editor);
  const portTaken =
    !crashed && port !== null && mayBePortTaken(state, editor, env.platform) && (await env.portListening(port));
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
    crashed,
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
    launcher: engine ? null : Boolean(await findLauncher(env.platform, deps.launch)),
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
    /** Whether to offer turning ray tracing off: the shown project ray-traces, on a Mac. */
    rayTracingRisk: await rayTracingRisk(env, state),
    ...(await computerNotes(env, state, engine)),
  };
}

/** What setup does to the project's Genex editor helper: updates an older one to the shipped version, else adds it. */
async function helperChange(state: ProjectState, helper: string): Promise<string> {
  const folder = path.join("Plugins", HELPER_FOLDER);
  if (state.helper !== HelperState.Outdated) return WORDS[SetupStep.Helper](folder);
  return WORDS.UpdateHelper(folder, await helperVersion(helper));
}

async function describeSetup(file: string, options: SetupOptions): Promise<PluginReview> {
  const state = await inspectProject(file, options);
  const { steps, port, engine } = await planSetup(file, options);
  if (steps.length === 0) return { message: WORDS.NothingToChange(state.name) };
  const helperLine = await helperChange(state, options.helper);
  const lines = steps.map((step) => {
    if (step === SetupStep.Engine)
      return WORDS[step](path.basename(state.file), engine?.from ?? state.engine, engine?.to ?? "");
    if (step === SetupStep.Plugins) return WORDS[step](path.basename(state.file), state.plugins, state.toolsets);
    if (step === SetupStep.AutoStart) return WORDS[step](settingsIniPath(options.env), port);
    return helperLine;
  });
  const detail = [WORDS.SetupIntro(state.name, state.file), ...lines.map((line) => `• ${line}`), WORDS.SetupOutro()];
  return { message: WORDS.SetupQuestion(state.name), detail: detail.join("\n") };
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

/** This profile's set-up record of a project, by its real `.uproject`. */
const recordOf = async (storage: string, file: string) =>
  (await listSetUpProjects(storage)).find((p) => p.project === file);

/**
 * The game's own project as the editor queue reaches it: linked, set up, with its port. A project
 * another Genex profile set up (its record is in that profile's storage) is recorded here at once
 * when its files are set up (`adoptSetUp`), touching nothing in it.
 */
async function gameEditor(deps: UnrealBackendDeps, storage: string, game: string) {
  const file = await linkedProject(storage, game);
  if (!file) throw new Error(MESSAGE.NoLinkedProject);
  const recorded = await recordOf(storage, file);
  if (recorded) return recorded;
  await adoptSetUp(file, { env: deps.env, helper: deps.helper, storage }).catch(() => undefined);
  const adopted = await recordOf(storage, file);
  if (!adopted) throw new Error(MESSAGE.LinkedNotSetUp);
  return adopted;
}

/**
 * Sets the game's linked project up in this profile when it has no set-up record here (another
 * profile set it up, or nobody did): recorded as it is when its files are set up, else set up as
 * `use-project` does, quitting Unreal first when it has the project open. Nothing without a link.
 */
async function setUpLinked(deps: UnrealBackendDeps, storage: string, game: string, mayQuit: boolean): Promise<void> {
  const file = await linkedProject(storage, game);
  if (!file || (await recordOf(storage, file))) return;
  const options: LaunchOptions = { env: deps.env, helper: deps.helper, storage, launch: deps.launch };
  if (await adoptSetUp(file, options)) return;
  const policy = mayQuit ? MAY_QUIT : null;
  await setUpForLink(deps, file, options, (await inspectProject(file, options)).name, policy);
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
  const { project } = await gameEditor(deps, storage, game);
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
    editorCall: async (storage, game, tool: AnyLoopTool, args, timeoutMs, signal) => {
      const call = { toolset: TOOLSET_OF[tool], tool, args, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
      return parsedAnswer(await callProjectTool(await gameEditor(deps, storage, game), call, undefined, signal));
    },
    // An editor whose log says Epic's server couldn't listen on the game's port throws, ending the wait.
    editorAnswers: async (storage, game) => {
      const editor = await gameEditor(deps, storage, game).catch(() => undefined);
      return editor ? answersOrBlocked(deps.env, editor) : false;
    },
    restart: {
      editors: () => editorCount(deps.env),
      quit: (storage, project) => quitEditor(project, launch(storage)),
      open: (storage, project) => openEditor(project, launch(storage)),
      forget: (storage, project) => retireStarting(storage, project),
    },
    watchCrash: (storage, game) => gameCrashCheck(deps, storage, game),
    setUpLinked: (storage, game, mayQuit) => setUpLinked(deps, storage, game, mayQuit),
    // A game whose project isn't set up has no start of Genex's to read.
    starting: async (storage, game) => {
      const editor = await gameEditor(deps, storage, game).catch(() => undefined);
      return editor ? editorStart(deps.env, storage, editor, deps.launch.now()) : null;
    },
    ...(deps.processes ? { processes: deps.processes } : {}),
    ...(deps.stopped ? { stopped: deps.stopped } : {}),
    ...deps.programs,
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
  if (!isSetUp(state)) throw new Error(WORDS.NotSetUp(name));
  return state;
}

/** Links the calling game to a set-up project through the host, which shows it in the chat with Undo. */
async function linkGame(deps: UnrealBackendDeps, file: string, context: PluginContext): Promise<PluginEngineLink> {
  if (!context.project) throw new Error(WORDS.NoGame());
  const state = await setUpState(file, await setupOptions(deps, context));
  return context.host(HostService.EngineLink, { project: realProjectFile(state) });
}

/**
 * Sets a project up as the panel's Set up does, unasked; undefined while Unreal has it open. A
 * project from an older Unreal is left to the user, whose panel warns before it switches the
 * engine: nothing changes. A refusal says why in one line the agent can act on.
 */
async function setUpOnce(file: string, options: SetupOptions, name: string): Promise<ProjectState | undefined> {
  try {
    const { engine } = await planSetup(file, options);
    if (engine) throw new Error(MESSAGE.SetUpSwitchesEngine(name, engine.from, engine.to));
    return await setUpProject(file, options);
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    if (error.code === SetupErrorCode.EditorRunning) return undefined;
    throw new Error(MESSAGE.SetUpRefused(name, error.message));
  }
}

/**
 * Quits the Unreal that has the project open, the normal way (Unreal asks about unsaved work
 * itself: a project not set up has no Genex editor helper to save through), and waits until no
 * editor runs; refuses, in words the agent acts on, two editors or one that stays open.
 */
async function quitForSetUp(deps: UnrealBackendDeps, file: string, options: LaunchOptions, name: string) {
  try {
    await quitEditor(file, options);
  } catch (error) {
    const several = error instanceof LaunchError && error.code === LaunchErrorCode.SeveralEditors;
    throw new Error(several ? MESSAGE.SetUpTwoEditors(name) : MESSAGE.SetUpNotClosed(name));
  }
  const clock = { now: deps.launch.now, sleep: (ms: number) => sleep(ms) };
  const closed = await pollUntil(clock, async () => (await editorCount(deps.env)) === 0, RESTART_POLL_MS, QUIT_WAIT_MS);
  if (!closed) throw new Error(MESSAGE.SetUpNotClosed(name));
}

/**
 * Whether a set-up may quit the Unreal that has the project open: never (a Loop's start, where the
 * agent links the project itself), or once `check` found nothing that holds it (it throws why).
 */
type QuitPolicy = { check: () => Promise<void> } | null;

/** Any quit is fine: the caller holds the game's editor lock. */
const MAY_QUIT: QuitPolicy = { check: async () => {} };

/**
 * Refuses while a run going now (a Loop, which holds that game's editor lock) has `file` as its
 * project: `use-project` needs no lock of its own, which would reach every game, web games too.
 */
async function refuseWhileLooped(context: PluginContext, file: string, name: string): Promise<void> {
  const answer: unknown = await context.host(HostService.EngineRuns).catch(() => []);
  const runs = Array.isArray(answer) ? answer.filter(isEngineRun) : [];
  for (const run of runs)
    if (await sameProject(file, run.project)) throw new Error(MESSAGE.SetUpLooped(run.title, name));
}

/** A project set up for a link, and whether Genex quit Unreal to set it up (so it opens it again). */
type SetUpForLink = { state: ProjectState; quit: boolean };

/**
 * Sets a project up for the agent's `use-project`, unasked (the chat's Undo takes it back with the
 * link). While Unreal has it open, Unreal is quit first; a set-up refused after that opens the
 * project again, so the person's Unreal comes back as it was.
 */
async function setUpForLink(
  deps: UnrealBackendDeps,
  file: string,
  options: LaunchOptions,
  name: string,
  policy: QuitPolicy,
): Promise<SetUpForLink> {
  const first = await setUpOnce(file, options, name);
  if (first) return { state: first, quit: false };
  if (!policy) throw new Error(MESSAGE.SetUpNotQuitForRun(name));
  await policy.check();
  await quitForSetUp(deps, file, options, name);
  const again = await setUpOnce(file, options, name).catch(async (error: unknown) => {
    await openEditor(file, options).catch(() => undefined);
    throw error;
  });
  if (!again) throw new Error(MESSAGE.SetUpNotClosed(name));
  return { state: again, quit: true };
}

/** What linking a project came to: the link, whether it set the project up, and how reopening Unreal went when it quit it. */
type UsedProject = { link: PluginEngineLink; setUp: boolean; reopen?: { opened: true } | { why: string } };

/**
 * The agent's `use-project`: links the calling game to `file`, setting the project up first when
 * it isn't. A project Genex had never set up is set up on the link (`setUp`), so the chat's one
 * Undo takes both back; when the host refuses the link, that set-up is taken back at once.
 */
async function useProject(deps: UnrealBackendDeps, file: string, context: PluginContext): Promise<UsedProject> {
  if (!context.project) throw new Error(MESSAGE.NoGame);
  const options = await launchOptions(deps, context);
  const state = await inspectProject(file, options);
  // Read before the set-up check, which narrows `state` away once it says no.
  const { name, undoable } = state;
  // Set up already, here or by another Genex profile whose record this one adopts as it is.
  const ready = isSetUp(state) ? state : await adoptSetUp(file, options);
  if (isSetUp(ready)) {
    const link = await context.host(HostService.EngineLink, { project: realProjectFile(ready) });
    return { link, setUp: false };
  }
  const made = await setUpForLink(deps, file, options, name, { check: () => refuseWhileLooped(context, file, name) });
  const setUp = !undoable;
  const project = realProjectFile(made.state);
  let link: PluginEngineLink;
  try {
    link = await context.host(HostService.EngineLink, { project, ...(setUp ? { setUp } : {}) });
  } catch (error) {
    if (setUp) await undoSetup(file, options).catch(() => undefined);
    if (made.quit) await openEditor(file, options).catch(() => undefined);
    throw error;
  }
  if (!made.quit) return { link, setUp };
  const reopen = await openEditor(project, options).then(
    () => ({ opened: true }) as const,
    (error: unknown) => ({ why: errorMessage(error) }),
  );
  return { link, setUp, reopen };
}

/** The agent's `use-project` answer: linked, set up and linked, or set up after Genex quit Unreal and how its reopen went. */
function usedWords({ link, setUp, reopen }: UsedProject): string {
  if (reopen && "why" in reopen) return MESSAGE.SetUpNotReopened(link.name, link.project, reopen.why);
  if (reopen) return MESSAGE.SetUpReopened(link.name, link.project);
  return setUp ? MESSAGE.SetUpAndLinked(link.name, link.project) : MESSAGE.Linked(link.name, link.project);
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
  if (deps.env.platform !== "darwin") throw new Error(WORDS.XcodeMacOnly());
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

/** Whether this computer has an Unreal Genex makes new games with. */
const canMakeGames = async (deps: UnrealBackendDeps): Promise<boolean> =>
  engineReadiness(await findEngines(deps.env)).engine === EngineReadiness.Ready;

/**
 * Remembers that the calling game's chat chose Unreal while it can't be made here yet, so the
 * game's stage strip shows the Unreal button (which shows how to get Unreal) from the turn's end.
 */
async function rememberChoiceOfUnreal(deps: UnrealBackendDeps, context: PluginContext): Promise<void> {
  const storage = (await setupOptions(deps, context)).storage;
  await rememberWant(storage, context.project, deps.launch.now());
}

/** Where a game's Don't use Unreal is kept: one empty file per game, in the plugin's storage. */
async function skipFile(deps: UnrealBackendDeps, context: PluginContext): Promise<string> {
  if (!context.project) throw new Error(WORDS.NoGame());
  const { storage } = await setupOptions(deps, context);
  return path.join(storage, SKIPPED_FOLDER, encodeURIComponent(context.project));
}

/** What Do it for me runs next. Never leaves the backend. */
const ForMeStep = { Launcher: "launcher", Engine: "engine", Runtime: "runtime", Done: "done" } as const;
type ForMeStep = (typeof ForMeStep)[keyof typeof ForMeStep];
/**
 * Why a press of Do it for me started nothing of its own: the person's to do here (Epic's download
 * page, the runtime by hand), an install already running, or the chat not started for an unnamed
 * reason. The assist's own refusals pass through as they are. Wire values of the card's answer.
 */
const ForMeMiss = {
  DownloadPage: "download-page",
  Yourself: "yourself",
  Running: "running",
  NotStarted: "not-started",
} as const;
type ForMeMiss = (typeof ForMeMiss)[keyof typeof ForMeMiss];

/**
 * One install Do it for me runs: what it installs, where it stands in the person's words, and its
 * Stop; `stopped` once the person pressed it, so the agent isn't told of a stop they asked for.
 */
type ForMeJob = {
  kind: EpicInstallKind;
  phase: EpicInstallPhase;
  message: string;
  controller: AbortController;
  stopped?: boolean;
};
/** The one install this backend runs at a time; the last one stays, so its card can say how it ended. */
type ForMeSlot = { job?: ForMeJob };
/** What a press of Do it for me did: the step it ran, whether that started, why not, in the person's words. */
type ForMeAnswer = {
  step: ForMeStep;
  started: boolean;
  message: string;
  reason?: ForMeMiss | PluginEngineAssistRefusal;
};

const isRunning = (job: ForMeJob | undefined): job is ForMeJob =>
  job !== undefined && job.phase !== EpicInstallPhase.Done && job.phase !== EpicInstallPhase.Failed;

/** Whether Genex installs the launcher and the runtime itself here: Windows, with the installers to hand. */
const installsHere = (deps: UnrealBackendDeps): deps is UnrealBackendDeps & { install: EpicInstallDeps } =>
  deps.env.platform === "win32" && deps.install !== undefined;

/** Whether Unreal's editor has the Windows runtime it loads; counted as there where nothing can tell. */
const runtimeReady = async (deps: UnrealBackendDeps): Promise<boolean> =>
  deps.env.platform !== "win32" || !deps.runtime || (await deps.runtime());

/** The step Do it for me runs next, read now. */
async function nextForMe(deps: UnrealBackendDeps): Promise<ForMeStep> {
  if (await canMakeGames(deps)) return (await runtimeReady(deps)) ? ForMeStep.Done : ForMeStep.Runtime;
  return (await findLauncher(deps.env.platform, deps.launch)) ? ForMeStep.Engine : ForMeStep.Launcher;
}

/**
 * Starts an install Do it for me runs, answering at once: the card follows it through the slot. The
 * launcher, once installed, is opened for the person's sign-in.
 */
function startInstall(
  deps: UnrealBackendDeps,
  slot: ForMeSlot,
  kind: EpicInstallKind,
  install: (options: { signal: AbortSignal; onPhase: (phase: EpicInstallPhase) => void }) => Promise<void>,
): ForMeJob {
  const phase = kind === EpicInstallKind.Launcher ? EpicInstallPhase.Downloading : EpicInstallPhase.Checking;
  const job: ForMeJob = { kind, phase, message: PHASE_WORDS[kind][phase]?.() ?? "", controller: new AbortController() };
  const note = (next: EpicInstallPhase, message = PHASE_WORDS[kind][next]?.() ?? job.message) => {
    job.phase = next;
    job.message = message;
  };
  slot.job = job;
  void install({ signal: job.controller.signal, onPhase: note })
    .then(async () => {
      // Opened before the card says done, so whoever sees it done finds the launcher on its way.
      if (kind === EpicInstallKind.Launcher) await getUnreal(deps.env, deps.launch).catch(() => undefined);
      note(EpicInstallPhase.Done);
    })
    .catch((error: unknown) =>
      note(EpicInstallPhase.Failed, error instanceof EpicInstallError ? error.message : FOR_ME_WORDS.Failed()),
    );
  return job;
}

/** The launcher: installed by Genex on Windows, else Epic's download page opened for the person. */
async function launcherForMe(deps: UnrealBackendDeps, slot: ForMeSlot): Promise<ForMeAnswer> {
  if (!installsHere(deps)) {
    await getUnreal(deps.env, deps.launch);
    return {
      step: ForMeStep.Launcher,
      started: false,
      message: FOR_ME_WORDS.DownloadPage(),
      reason: ForMeMiss.DownloadPage,
    };
  }
  const { install } = deps;
  const job = startInstall(deps, slot, EpicInstallKind.Launcher, (options) => installEpicLauncher(install, options));
  return { step: ForMeStep.Launcher, started: true, message: job.message };
}

/**
 * Unreal itself: the launcher opened, then the install handed to the game's chat, whose answering
 * turn clicks it with the person's computer control. Refused, the launcher stays open for the person.
 */
async function engineForMe(deps: UnrealBackendDeps, context: PluginContext): Promise<ForMeAnswer> {
  const version = installEngineVersion();
  await getUnreal(deps.env, deps.launch).catch(() => undefined);
  const answer = await context.host(HostService.EngineAssist, { task: MESSAGE.InstallTask(version) });
  if (answer.started) return { step: ForMeStep.Engine, started: true, message: FOR_ME_WORDS.EngineStarted() };
  const words = answer.reason ? ENGINE_REFUSED[answer.reason] : undefined;
  const message = words ? words(version) : FOR_ME_WORDS.EngineNotStarted(version);
  return { step: ForMeStep.Engine, started: false, message, reason: answer.reason ?? ForMeMiss.NotStarted };
}

/** Microsoft's runtime, from the installed engine's own copy, on Windows. */
async function runtimeForMe(deps: UnrealBackendDeps, slot: ForMeSlot): Promise<ForMeAnswer> {
  const engine = (await findEngines(deps.env)).find(canCreateWith);
  if (!installsHere(deps) || !engine)
    return {
      step: ForMeStep.Runtime,
      started: false,
      message: FOR_ME_WORDS.RuntimeYourself(),
      reason: ForMeMiss.Yourself,
    };
  const { install } = deps;
  const run = (options: { signal: AbortSignal; onPhase: (phase: EpicInstallPhase) => void }) =>
    installUnrealRuntime(install, engine.directory, options);
  const job = startInstall(deps, slot, EpicInstallKind.Runtime, run);
  return { step: ForMeStep.Runtime, started: true, message: job.message };
}

/**
 * Do it for me, on the install card and as the agent's `install-unreal`: the next step Genex can do
 * now, each as its own press. An install already running is answered in words, not run again.
 */
async function doItForMe(deps: UnrealBackendDeps, context: PluginContext, slot: ForMeSlot): Promise<ForMeAnswer> {
  if (isRunning(slot.job))
    return { step: ForMeStep.Done, started: false, message: slot.job.message, reason: ForMeMiss.Running };
  const step = await nextForMe(deps);
  if (step === ForMeStep.Launcher) return launcherForMe(deps, slot);
  if (step === ForMeStep.Engine) return engineForMe(deps, context);
  if (step === ForMeStep.Runtime) return runtimeForMe(deps, slot);
  return { step, started: false, message: FOR_ME_WORDS.AllThere(installEngineVersion()) };
}

/** Stop: ends the download or check under way; an installer Windows already runs finishes on its own. */
function stopForMe(slot: ForMeSlot): { stopped: boolean; message: string } {
  if (!isRunning(slot.job)) return { stopped: false, message: FOR_ME_WORDS.NothingToStop() };
  slot.job.stopped = true;
  slot.job.controller.abort();
  return { stopped: true, message: FOR_ME_WORDS.Stopped() };
}

/** What the agent's `install-unreal` reads of a press: English, naming what to do next. */
function forMeSays(answer: ForMeAnswer): string {
  const version = installEngineVersion();
  if (answer.reason === ForMeMiss.Running) return MESSAGE.ForMeRunning(answer.message);
  if (answer.step === ForMeStep.Launcher)
    return answer.started ? MESSAGE.ForMeLauncher(version) : MESSAGE.ForMeDownloadPage;
  if (answer.step === ForMeStep.Engine)
    return answer.started ? MESSAGE.ForMeEngine(version) : MESSAGE.ForMeEngineRefused(version, answer.reason ?? "");
  if (answer.step === ForMeStep.Runtime) return answer.started ? MESSAGE.ForMeRuntime : MESSAGE.ForMeRuntimeYourself;
  return MESSAGE.ForMeDone(version);
}

/** The step a running install shows on the card. */
const workOf = (job: ForMeJob): ForMeWork => ({
  step: job.kind === EpicInstallKind.Launcher ? UnrealStepId.GetLauncher : UnrealStepId.InstallRuntime,
  message: job.message,
});

/**
 * The card the chat reads: in a game with no Unreal project, the install card while no Unreal that
 * makes games is here, or its Windows runtime is missing (or once they came, when this game's chat
 * chose Unreal: closed, so the agent is told); otherwise the Xcode card. Do it for me shows where it
 * can do the next step, and a stopped install is told to the agent once.
 */
async function cardFor(deps: UnrealBackendDeps, context: PluginContext, slot: ForMeSlot): Promise<UnrealSteps> {
  const project = await gameProject(deps, context);
  if (project || !context.project) return stepsFor(deps.env, project);
  const installed = await canMakeGames(deps);
  const { storage } = await setupOptions(deps, context);
  if (installed && !(await wantsUnreal(storage, context.project))) return stepsFor(deps.env, project);
  const launcher = Boolean(await findLauncher(deps.env.platform, deps.launch));
  const skipped = await stat(await skipFile(deps, context)).then(
    () => true,
    () => false,
  );
  const canAssist = await context.host(HostService.EngineCanAssist).catch(() => false);
  const forMe = { launcher: installsHere(deps), engine: canAssist === true, runtime: installsHere(deps) };
  const { job } = slot;
  const card = unrealInstallCard({
    launcher,
    version: installEngineVersion(),
    installed,
    skipped,
    runtime: !installed || (await runtimeReady(deps)),
    forMe,
    ...(isRunning(job) ? { working: workOf(job) } : {}),
  });
  const stuck = job?.phase === EpicInstallPhase.Failed && !job.stopped;
  return stuck ? { ...card, stuckSays: MESSAGE.ForMeStuck(job.message) } : card;
}

/** Whether a new game made here opens: an Unreal that makes games, with the Windows runtime its editor loads. */
const readyToMake = async (deps: UnrealBackendDeps): Promise<boolean> =>
  (await canMakeGames(deps)) && (await runtimeReady(deps));

/**
 * Refuses a new game whose editor couldn't start for want of Microsoft's runtime, before anything
 * is made; the game's chat chose Unreal, so its strip shows the Unreal button, whose card installs it.
 */
async function refuseWithoutRuntime(deps: UnrealBackendDeps, context: PluginContext): Promise<void> {
  if (await runtimeReady(deps)) return;
  await rememberChoiceOfUnreal(deps, context);
  throw new Error(MESSAGE.NoRuntime);
}

/** Don't use Unreal: closes the install card for this game, which tells the agent. */
async function skip(deps: UnrealBackendDeps, context: PluginContext): Promise<void> {
  const file = await skipFile(deps, context);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "");
}

/**
 * The agent's `show-steps`: the card in its chat while a step is open. In a game with no Unreal
 * project while no Unreal that makes games is installed, it shows the install card and brings the
 * Unreal button out too, taking back the game's Don't use Unreal.
 */
async function showSteps(deps: UnrealBackendDeps, context: PluginContext): Promise<string> {
  const project = await gameProject(deps, context);
  if (!project && context.project && !(await readyToMake(deps))) {
    await rememberChoiceOfUnreal(deps, context);
    await rm(await skipFile(deps, context), { force: true });
    const shown = await context.host(HostService.EngineSteps);
    return shown ? MESSAGE.InstallCardShown(installEngineVersion()) : MESSAGE.ButtonOut(installEngineVersion());
  }
  const steps = await stepsFor(deps.env, project);
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

/** The engine New game makes projects with: the newest verified one, else why there is none. */
async function creatingEngine(deps: UnrealBackendDeps): Promise<Engine> {
  const engines = await findEngines(deps.env);
  const engine = engines.find(canCreateWith);
  const newest = engines.find((e) => e.supported);
  if (!newest) throw noEngineError();
  if (!engine) throw unverifiedEngineError(newest.version);
  return engine;
}

/**
 * Makes a new game from a template (and variant) and sets it up at once, recorded like any setup
 * so Undo works. It goes in a Genex game's folder as `unreal/` (the game's ignore file gains
 * Unreal's scratch folders) and becomes that game's project: the open game's, or with none open a
 * game the host makes for it; only a host that makes none leaves it in Documents › Unreal Projects.
 * No confirmation: nothing else that exists changes. It becomes the panel's chosen project.
 */
async function create(deps: UnrealBackendDeps, args: Record<string, unknown>, context: PluginContext) {
  const made = await makeProject(deps, args, context);
  await adoptNewProject(context, made);
  return { project: made.file, state: made.state, game: made.made ? { project: made.made.project } : null };
}

/** A project {@link makeProject} made and set up, not yet the panel's choice nor any game's. */
type MadeProject = {
  file: string;
  state: ProjectState;
  /** Its real `.uproject`. */
  project: string;
  storage: string;
  /** The Genex game the host made for it, when none was open. */
  made: MadeGame | null;
};

/** {@link create} up to its project made and set up; the caller adopts it. */
async function makeProject(
  deps: UnrealBackendDeps,
  args: Record<string, unknown>,
  context: PluginContext,
): Promise<MadeProject> {
  const engine = await creatingEngine(deps);
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
  return { file, state, project: realProjectFile(state), storage: options.storage, made };
}

/**
 * Makes a new project its game's project (the open game's, or the one the host made for it), then
 * the panel's choice: a link that is refused leaves the person's earlier choice as it was.
 */
async function adoptNewProject(context: PluginContext, made: MadeProject) {
  await linkNewProject(context, made);
  await rememberChoice(made.storage, made.project);
}

/** Makes a new project its game's project (the open game's, or the one the host made for it); a refused link links nothing. */
async function linkNewProject(context: PluginContext, { project, made }: MadeProject) {
  // A new project made for a Genex game is that game's project from now on.
  if (context.project) await context.host(HostService.EngineLink, { project });
  else if (made) await context.host(HostService.EngineLink, { project, game: made.project });
}

/** A path by its real path, or as it is when it can't be resolved. */
const realOr = (file: string) => realpath(file).catch(() => file);

/**
 * How a user's own Open updates an older Genex editor helper or adds Epic's toolsets: only for the open game's own linked
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
  return opened.helper && kept > 0 ? { note: WORDS.KeptOnUpdate(opened.helper.to, kept) } : {};
}

/**
 * The agent's `new-game`: New game exactly as the panel makes it from an open game (in the game's
 * folder as `unreal/`, set up, linked to the game), then opened in Unreal. Only from an open game:
 * the agent never makes a project in Documents › Unreal Projects. A project made but not opened
 * stays made and linked, and the answer says why Unreal didn't open.
 */
async function newGame(deps: UnrealBackendDeps, args: Record<string, unknown>, context: PluginContext) {
  if (!gameFolderOf(context)) throw new Error(MESSAGE.NoGame);
  // Refused below for want of Unreal: the game's strip still shows the Unreal button, which gets it.
  if (!(await canMakeGames(deps))) await rememberChoiceOfUnreal(deps, context);
  else await refuseWithoutRuntime(deps, context);
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

/**
 * The agent's `new-plugin`: an Unreal plugin with its host project, in an open game with no Unreal
 * project yet. Every check comes first (the plugin's name against the engine's own modules and
 * plugins, the template, the game's folder); then New game's Blank project named `<Name>Host` (set
 * up with the Genex editor helper), the host's own C++ module, the plugin in `unreal/Plugins/<Name>/`
 * from Epic's template, enabled in the host's .uproject, and last the host linked to the game. It
 * opens nothing: the plugin is built first.
 */
async function newPlugin(deps: UnrealBackendDeps, args: Record<string, unknown>, context: PluginContext) {
  const game = gameFolderOf(context);
  if (!game) throw new Error(MESSAGE.NoGame);
  if (!(await canMakeGames(deps))) await rememberChoiceOfUnreal(deps, context);
  const engine = await creatingEngine(deps);
  const name = await assertPluginName(textArg(args, "name"), engine.directory);
  const template = await readPluginTemplate(engine.directory, args.template ?? PluginTemplate.Window);
  await assertGameFolderFree(game);
  const host = `${name}${HOST_SUFFIX}`;
  const state = await makePluginHost(deps, context, { game, engine, name, host, template });
  // The setup card in the chat while a step (Xcode, which builds the plugin) is still open.
  if ((await stepsFor(deps.env, state)).open) await context.host(HostService.EngineSteps);
  return MESSAGE.NewPlugin(name, host);
}

/** What {@link makePluginHost} makes: the plugin `name` from `template` in a host project `host` in `game`. */
type PluginHostRequest = {
  game: string;
  engine: Engine;
  name: string;
  host: string;
  template: PluginTemplateFiles;
};

/**
 * The host project, its C++ module and the plugin, then the link: the game takes the host as its
 * project only once all of it is written, and the link is the last step a failure undoes. A step
 * that fails (the link included: the host takes its own records back) removes the game's `unreal`
 * folder (free when the call began, so whatever is there is this call's, unless a refusal says the
 * place was taken), setup's record of the host and the lines the game's ignore file gained. Once
 * linked, the host stays: a panel choice that can't be saved leaves the earlier one.
 */
async function makePluginHost(deps: UnrealBackendDeps, context: PluginContext, request: PluginHostRequest) {
  const { game, engine, name, host, template } = request;
  const ignore = await readGameIgnore(game);
  let made: MadeProject;
  try {
    made = await makeProject(deps, { template: BlueprintTemplate.Blank, name: host }, context);
    await addCppModule(made.project, { engineDir: engine.directory, engineVersion: engine.version });
    await writePlugin(await planPlugin(path.dirname(made.project), name, template));
    await enableProjectPlugin(made.project, name);
    // A turn stopped while the host was written links nothing: the host goes with the rest.
    context.signal.throwIfAborted();
    await linkNewProject(context, made);
  } catch (error) {
    await undoPluginHost(deps, context, { game, host, ignore }, error);
    throw error;
  }
  await rememberChoice(made.storage, made.project).catch(() => undefined);
  return made.state;
}

/**
 * Undoes a {@link makePluginHost} that failed with `error` before its link held: setup's record of
 * the host, the game's `unreal` folder and its ignore file's new lines. Nothing when the refusal
 * says the place was taken: what is there is the person's.
 */
async function undoPluginHost(
  deps: UnrealBackendDeps,
  context: PluginContext,
  { game, host, ignore }: { game: string; host: string; ignore: string | null },
  error: unknown,
) {
  if (placeTaken(error)) return;
  const file = path.join(game, GAME_PROJECT_FOLDER, `${host}${UPROJECT_EXTENSION}`);
  await forgetSetup(file, (await setupOptions(deps, context)).storage).catch(() => undefined);
  await undoGameProjectFolder(game, error, ignore);
}

/** Whether Genex holds a set-up record of `file`; a project that is gone or can't be read holds none. */
const recorded = async (file: string, options: SetupOptions): Promise<boolean> =>
  (await inspectProject(file, options).catch(() => undefined))?.undoable === true;

/**
 * Undoes setup; `note` says how many helper files the user changed were left in place. A link's
 * Undo asks `ifSetUp`: a project no longer set up then has nothing to undo (null), not a refusal.
 */
async function undo(file: string, options: SetupOptions, ifSetUp = false) {
  if (ifSetUp && !(await recorded(file, options))) return null;
  const state = await undoSetup(file, options);
  return { ...state, note: state.kept.length > 0 ? WORDS.KeptAfterUndo(state.kept.length) : null };
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
  const forMe: ForMeSlot = {};
  const actions: Record<UnrealAction, ActionHandler> = {
    [UnrealAction.Status]: (args, context) => status(deps, args, context, scanned),
    [UnrealAction.Setup]: async (args, context) => setUp(projectArg(args), await setupOptions(deps, context)),
    [UnrealAction.UndoSetup]: async (args, context) =>
      undo(projectArg(args), await setupOptions(deps, context), args.ifSetUp === true),
    [UnrealAction.Templates]: (_args, context) => templates(deps, context),
    [UnrealAction.Create]: (args, context) => create(deps, args, context),
    [UnrealAction.OpenEditor]: (args, context) => openForUser(deps, projectArg(args), context),
    [UnrealAction.QuitEditor]: async (args, context) =>
      quitEditor(projectArg(args), await launchOptions(deps, context)),
    [UnrealAction.GetUnreal]: () => getUnreal(deps.env, deps.launch),
    [UnrealAction.ToolbarStatus]: async (_args, context) =>
      toolbarStatus(deps.env, (await setupOptions(deps, context)).storage, deps.launch.now(), context.project),
    [UnrealAction.UseProject]: (args, context) => linkGame(deps, projectArg(args), context),
    [UnrealAction.Steps]: async (_args, context) => cardFor(deps, context, forMe),
    [UnrealAction.Skip]: async (_args, context) => skip(deps, context),
    [UnrealAction.ForMe]: (_args, context) => doItForMe(deps, context, forMe),
    [UnrealAction.StopForMe]: async () => stopForMe(forMe),
    [UnrealAction.GetXcode]: (args) => getXcode(deps, args),
    [UnrealAction.StageStatus]: (_args, context) => stageStatus(deps, context, scanned),
    [UnrealAction.RayTracingOff]: async (args, context) =>
      rayTracingOff(projectArg(args), await setupOptions(deps, context)),
    [UnrealAction.Agents]: async (_args, context) => agentsSetting((await setupOptions(deps, context)).storage),
    [UnrealAction.AgentsGoAhead]: async (_args, context) =>
      setAgentsSetting((await setupOptions(deps, context)).storage, true),
    [UnrealAction.AgentsWait]: async (_args, context) =>
      setAgentsSetting((await setupOptions(deps, context)).storage, false),
  };
  const loop = loopTools(deps);
  const tools: Record<UnrealTool, ToolHandler> = {
    [UnrealTool.UseProject]: async (args, context) => {
      const storage = (await setupOptions(deps, context)).storage;
      return usedWords(await useProject(deps, await namedProject(textArg(args, "project"), storage), context));
    },
    [UnrealTool.ShowSteps]: (_args, context) => showSteps(deps, context),
    [UnrealTool.NewGame]: (args, context) => newGame(deps, args, context),
    [UnrealTool.NewPlugin]: (args, context) => newPlugin(deps, args, context),
    [UnrealTool.WaitEditor]: (args, context) => waitEditor(deps, args, context),
    [UnrealTool.EngineStatus]: async () => readinessAnswer(engineReadiness(await findEngines(deps.env))),
    [UnrealTool.InstallUnreal]: async (_args, context) => forMeSays(await doItForMe(deps, context, forMe)),
  };
  return {
    async action(name, args, context) {
      if (!isUnrealAction(name)) throw new Error(WORDS.UnknownAction(name));
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
        return { message: WORDS.UndoQuestion(project), detail: WORDS.Undo(project) };
      }
      if (name === UnrealAction.RayTracingOff) {
        const project = (await inspectProject(projectArg(args), options)).name;
        return { message: WORDS.RayTracingQuestion(project), detail: WORDS.RayTracingDetail(project) };
      }
      return {};
    },
  };
}

/**
 * Aborts when Genex stops this backend's process (it quits, or the plugin is turned off): every
 * running job ends its process group on that abort. A SIGTERM then ends the process as it would
 * have with no listener, so Genex never waits out its grace for it.
 */
export function backendStopped(): AbortSignal {
  const stopped = new AbortController();
  const stop = () => stopped.abort();
  process.once("SIGTERM", () => {
    stop();
    process.kill(process.pid, "SIGTERM");
  });
  process.once("disconnect", stop);
  return stopped.signal;
}

export const activate: Activate = () => {
  const env = systemSetupEnv();
  return createUnrealBackend({
    env,
    helper: path.join(path.dirname(fileURLToPath(import.meta.url)), HELPER_FOLDER),
    launch: systemLaunchEnv(),
    processes: systemProcesses(env.home),
    stopped: backendStopped(),
    install: { platform: process.platform, env: process.env, fetch, run: systemEpicRun, tempRoot: os.tmpdir() },
    runtime: () => hasUnrealRuntime(systemFolder(process.env)),
  });
};
