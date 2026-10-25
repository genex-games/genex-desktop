/**
 * The Unity plugin's backend. The editor itself is reached through the plugin's MCP server
 * (`editor-mcp.ts`), which knows only its game's id; this is where Genex's own binding of a game to
 * its folder is turned into the Unity project that server reaches, where a project is made, set up
 * and opened, and where the plugin answers at Genex's moments:
 * - `find-project`: Genex runs it at the start of every turn and run of a game holding a Unity
 *   project; it keeps the project it finds in the plugin's storage (`project-folder.ts`).
 * - `engine-status`: whether a Unity 6 is installed, for the new game's engine question.
 * - `new-game`: makes the game's empty Unity project as `unity/` (`new-project.ts`), keeps it for
 *   the connector, opens it in the newest installed Unity 6, waits until that editor answers and
 *   gives it a saved first scene (`editor-life.ts`).
 * - `setup` and `undo-setup`: add Unity's Pipeline package to an existing project's manifest, or
 *   take it back out (`setup.ts`); the person confirms each.
 * - `open-editor`, `quit-editor` and `restart-editor`: open the game's project in the Unity it was
 *   saved with (`editor-open.ts`), save its editor's work and quit it (`editor-quit.ts`), or end a
 *   stalled editor first, saving what an answering one can; the person confirms a restart.
 * - `save-all`, `end-editor`, `reopen-editor`, `editor-state`, `open-for-run`, `after-run`,
 *   `scene-shots` and `editor-activity`: the steps at Genex's moments and the editor lock's probe
 *   (`editor-moments.ts`). Once a run ended, the backend looks every half minute for an editor Genex
 *   opened for a run that nobody uses any more, and closes it (`editor-idle.ts`).
 *
 * The person reaches the same project through the plugin's panel and its toolbar button, whose
 * actions answer in codes the panel words itself: `status` and `toolbar-status` only look
 * (`panel-status.ts`); `open-editor`, `setup`, `undo-setup` and `restart-editor` do what the agent's
 * tools of those names do; `get-unity` opens Unity Hub, else Unity's download page. No action makes
 * a project: that changes what a game is, which Genex snapshots around an agent's `new-game`.
 *
 * While this computer can't make Unity games yet, the agent's `show-steps` puts the Unity setup card
 * in the game's chat (`setup-steps.ts`): its `steps` action reads it, and its buttons get Unity Hub,
 * open it for the person's sign-in, install Unity 6 through Hub, or do all of it (`unity-install.ts`).
 */
import { mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MINUTE_MS } from "../../shared/duration.ts";
import { matchmakingArg, slugArg, writeMatchmaking } from "../../substrate/genex-game-settings.ts";
import { errorMessage } from "../../shared/errors.ts";
import { t } from "../../shared/i18n.ts";
import { ENGINE_PLAY_TOOLS, type EnginePlayTool } from "../../shared/engine-play.ts";
import type { Activate, PluginActivation, PluginContext } from "../../plugin-sdk/index.d.ts";
import { getUnityLaunch, systemOpener, UnitySource } from "./editor-launch.ts";
import { createComputerPlay } from "./computer-play.ts";
import { endEditor, firstSetup } from "./editor-life.ts";
import { quitEditor } from "./editor-quit.ts";
import { CLOSE_IDLE_SETTING, closeIdleEditors, IDLE_LOOK_MS } from "./editor-idle.ts";
import {
  afterRun,
  editorActivity,
  editorState,
  endForRestore,
  type Moment,
  type MomentDeps,
  openForRun,
  reopenEditor,
  saveAll,
  sceneShots,
} from "./editor-moments.ts";
import { launched, Opened, type Opening, openProject, UNKNOWN_VERSION } from "./editor-open.ts";
import { findEditors, findHub, systemEditorsEnv, type UnityEditor } from "./editors.ts";
import { createProject, NewProjectError, NewProjectRefusal } from "./new-project.ts";
import { type PanelStatus, panelStatus, toolbarStatusOf } from "./panel-status.ts";
import { systemPipelineDeps } from "./pipeline.ts";
import { systemIdleMs, systemProcesses } from "./processes.ts";
import {
  installUnityMultiplayer,
  MULTIPLAYER_PACKAGE,
  SETTINGS_FILE,
  type UnityMultiplayerState,
  unityMultiplayerState,
} from "./multiplayer.ts";
import {
  findUnityProject,
  folderInGame,
  GAME_PROJECT_FOLDER,
  rememberProject,
  type UnityProject,
} from "./project-folder.ts";
import { agentsSetting, setAgentsSetting } from "../../substrate/engine-agents.ts";
import { newestUnity6, readinessOf } from "./readiness.ts";
import { pipelineVersionOf, SetupError, SetupRefusal, setUpProject, undoSetup } from "./setup.ts";
import { readFacts, SetupAction, setupCard, skippedCard } from "./setup-steps.ts";
import { createInstaller, type InstallDeps, type Installer, systemInstallDeps } from "./unity-install.ts";

/** The host services this backend calls, by their public SDK names. */
const HostService = {
  StorageRoot: "storage.root",
  EngineSteps: "game.engine.steps",
  SettingsRead: "settings.read",
} as const;

/** The plugin's tools, by the names its manifest declares. Wire values: never rename one. */
export const UnityTool = {
  FindProject: "find-project",
  EngineStatus: "engine-status",
  NewGame: "new-game",
  Setup: "setup",
  UndoSetup: "undo-setup",
  OpenEditor: "open-editor",
  RestartEditor: "restart-editor",
  QuitEditor: "quit-editor",
  SaveAll: "save-all",
  EndEditor: "end-editor",
  ReopenEditor: "reopen-editor",
  EditorState: "editor-state",
  OpenForRun: "open-for-run",
  AfterRun: "after-run",
  SceneShots: "scene-shots",
  EditorActivity: "editor-activity",
  ShowSteps: "show-steps",
  Multiplayer: "multiplayer",
} as const;
export type UnityTool = (typeof UnityTool)[keyof typeof UnityTool];

const isUnityTool = (name: string): name is UnityTool => (Object.values(UnityTool) as string[]).includes(name);

/** The panel's and the toolbar button's actions, by the names the manifest declares. Wire values: never rename one. */
export const UnityAction = {
  Status: "status",
  ToolbarStatus: "toolbar-status",
  OpenEditor: "open-editor",
  Setup: "setup",
  UndoSetup: "undo-setup",
  RestartEditor: "restart-editor",
  GetUnity: "get-unity",
  Agents: "agents",
  AgentsGoAhead: "agents-go-ahead",
  AgentsWait: "agents-wait",
  Steps: SetupAction.Steps,
  Stop: SetupAction.Stop,
  Skip: SetupAction.Skip,
  GetHub: SetupAction.GetHub,
  OpenHub: SetupAction.OpenHub,
  InstallUnity: SetupAction.InstallUnity,
  SetUp: SetupAction.SetUp,
} as const;
export type UnityAction = (typeof UnityAction)[keyof typeof UnityAction];

const isUnityAction = (name: string): name is UnityAction => (Object.values(UnityAction) as string[]).includes(name);

/**
 * What the backend reaches besides the host: the clock, the installed editors, the opener, the
 * editor's network and the computer's processes, and what installing Unity for the person reaches
 * (this computer's own unless a test stands in).
 */
export type UnityBackendDeps = MomentDeps & {
  install?: InstallDeps;
  /** Genex's Unity multiplayer package as the plugin ships it (`multiplayer/com.genex.multiplayer`). */
  multiplayerPackage?: string;
  /** Runs `look` every `ms` until the backend ends; this computer's timer unless a test stands in. */
  every?: (look: () => void, ms: number) => void;
};

/** The shipped multiplayer package, beside the built backend. */
const SHIPPED_MULTIPLAYER_PACKAGE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "multiplayer",
  MULTIPLAYER_PACKAGE,
);

/** This computer's timer, which never by itself keeps the backend running. */
const systemEvery = (look: () => void, ms: number): void => {
  setInterval(look, ms).unref();
};

/** Whether the person left closing an idle editor on: it is on unless the setting reads false. */
async function closeIdleOn(context: PluginContext): Promise<boolean> {
  const settings = await context.host(HostService.SettingsRead).catch(() => ({}) as Record<string, unknown>);
  return settings[CLOSE_IDLE_SETTING] !== false;
}

/**
 * The looks at idle editors, started at the first run's end and kept going while the backend runs;
 * one look at a time, so a slow editor never has two.
 */
function idleWatch(deps: UnityBackendDeps): (storage: string) => void {
  let watching = false;
  let looking = false;
  return (storage) => {
    if (watching) return;
    watching = true;
    (deps.every ?? systemEvery)(() => {
      if (looking) return;
      looking = true;
      void closeIdleEditors(storage, deps)
        .catch(() => undefined)
        .finally(() => {
          looking = false;
        });
    }, IDLE_LOOK_MS);
  };
}

const HUB = "Unity Hub (Add, then Add project from disk)";
/**
 * How long a restart waits for the editor it opened. Ending the old one may take half a minute
 * (a look at a stalled main thread, a clean exit, then signals), and the host ends one plugin call
 * at 190 s: the whole restart stays under that, so it never reads as failed while Unity starts.
 */
const RESTART_OPEN_WAIT_MS = 2 * MINUTE_MS;
/** The plugin storage folder holding each game's Don't use Unity. */
const SKIPPED_FOLDER = path.join("unity-setup", "skipped");

const MESSAGE = {
  UnknownTool: (name: string) => `Unknown Unity tool ${name}`,
  Multiplayer: (state: UnityMultiplayerState, kept: readonly string[], manifestChanged: boolean) =>
    [
      `Genex multiplayer is in this game's Unity project: Packages/${MULTIPLAYER_PACKAGE} (Genex's package) and the Colyseus Unity SDK it runs on in Packages/manifest.json${manifestChanged ? ", which Unity fetches from Colyseus's repository when its editor next comes forward (it needs git on this Mac)" : ""}.`,
      state.slug
        ? `Its Genex project is ${state.slug} (${SETTINGS_FILE}).`
        : `It has no Genex project yet, and builds don't need one: GenexGame.Slug (Assets/Genex/GenexGame.cs) takes it from Genex's Play and from the published web page, so the copies a publish sends join their rooms with no second build. To test online in the editor or in a build you start yourself, publish first, then call unity__multiplayer again with slug (genex__publish-status names it).`,
      kept.length ? `Kept your changed ${kept.join(", ")} beside the new ones as .mine~.` : "",
      "Write the game's online play now, as the unity-multiplayer skill says (unity__skill): GenexMultiplayer.Connect or GenexMatchmaker with GameId = GenexGame.Slug (never a slug read from GenexSettings.json alone), WebGL identity from the page and native identity through GenexNativeIdentity(GenexGame.ApiUrl, slug); then check it compiles in the editor.",
    ]
      .filter(Boolean)
      .join("\n"),
  UnknownAction: (name: string) => `Unknown Unity action ${name}`,
  NotKept: (reason: string) =>
    `Genex could not keep this game's Unity project for the editor connector (${reason}), so its calls to Unity will say no project was found.`,
  NoGame: "Open a game in Genex first: a Unity project is made in a game's folder.",
  NoProject: "This game's folder holds no Unity project. Call unity__new-game to make one.",
  NoUnity6: (note: string) => `A new Unity game needs Unity 6 on this computer. ${note}`,
  [NewProjectRefusal.HasProject]:
    "This game's folder already holds a Unity project: build in it through the unity-editor tools, and call unity__setup if they can't reach it.",
  [NewProjectRefusal.PlaceTaken]: `This game's folder already has something named ${GAME_PROJECT_FOLDER}, so the new project has no place: ask the user to move or rename it.`,
  [SetupRefusal.NeedsUnity6]: (version: string) =>
    `This project was saved with Unity ${version}, and Unity's Pipeline package needs Unity 6 or later: ask the user to upgrade the project in Unity Hub first.`,
  [SetupRefusal.NoManifest]:
    "This project has no Packages/manifest.json yet: Unity writes one the first time it opens the project.",
  [SetupRefusal.Unreadable]:
    "This project's Packages/manifest.json can't be read as Unity writes it (it is no plain file of the project, or no JSON object): fix the file so it is one JSON object with a dependencies object, then call again. Only a manifest that is a link out of the project is the user's to fix.",
  [SetupRefusal.InvalidGame]: "Invalid game",
  Made: (version: string) =>
    `Made this game's Unity project in ${GAME_PROJECT_FOLDER}/ for Unity ${version}, empty but for Unity's Pipeline package, the standard built-in modules and the UI package`,
  FirstScene:
    "Its first scene is Assets/Scenes/Main.unity, with a camera and a light, and the game keeps running while Unity is behind other windows.",
  NoFirstScene: (why: string) =>
    `Its first scene could not be made (${why}): the open scene is untitled, so before anything else call create_scene with a path such as Scenes/Main.unity and template default.`,
  SetUp: (version: string) => `Added Unity's Pipeline package (${version}) to this project's Packages/manifest.json`,
  AlreadySetUp: (version: string) => `This project already asks for Unity's Pipeline package (${version})`,
  NoPipeline: "This game's Unity project has no Pipeline package yet: call unity__setup first.",
  UndoneSetup:
    "Took Unity's Pipeline package back out of this project's Packages/manifest.json; Unity removes it the next time it comes forward.",
  NothingToUndo:
    "Genex added nothing to this project's manifest that is still as it wrote it, so nothing was taken back.",
  LoadsWhenForward:
    "Unity has this project open: bring Unity to the front so it loads the package (ask the user to), then call unity-editor__list_commands.",
  NotEnded:
    "Unity could not be ended, so it was not opened again: ask the user to quit Unity, then call unity__open-editor.",
  OpenedForManifest: (version: string) =>
    `This project had no Packages/manifest.json yet, so Genex opened it in Unity ${version}, which writes one as it loads the project. Call unity__setup again in a minute or two, once Unity has opened it.`,
  StepsShown:
    "The Unity setup card is in the chat: Genex can install Unity Hub and Unity 6 for the user, who only signs in. Tell them in one line, then end your reply; the chat tells you when Unity is ready.",
  StepsDone: "Unity 6 is installed and signed in here; there is no setup card to show. Call unity__new-game.",
  StepsNoChat: "There is no chat to show the Unity setup card in.",
  SetAside: (folder: string) =>
    `Unity had kept backups of scenes that were unsaved when Unity last ended; so that it opens without asking to recover them, Genex moved them to ${folder}. Tell the user, in case that work is wanted.`,
} as const;

/** What a refusal says to whoever asked: an agent is told what to call or ask for, a person what to do. */
interface RefusalWords {
  NoGame: string;
  NoProject: string;
  [SetupRefusal.NeedsUnity6]: (version: string) => string;
  [SetupRefusal.NoManifest]: string;
  [SetupRefusal.Unreadable]: string;
  [SetupRefusal.InvalidGame]: string;
}

/**
 * The refusals of the panel's actions, in words for the person at it: getters, so each is said in
 * the language of the moment it is read.
 */
const PANEL_MESSAGE = {
  get NoGame() {
    return t("Open a game first: Unity works on the open game's project.");
  },
  get NoProject() {
    return t("This game has no Unity project.");
  },
  get NotSetUp() {
    return t("Set this project up first.");
  },
  [SetupRefusal.NeedsUnity6]: (version: string) =>
    t(
      "This project was saved with Unity {version}, and Genex works with Unity 6 or later. Upgrade it in Unity Hub first.",
      { version },
    ),
  get [SetupRefusal.NoManifest]() {
    return t("This project has no Packages/manifest.json yet. Open it in Unity once, then set it up again.");
  },
  get [SetupRefusal.Unreadable]() {
    return t(
      "This project's Packages/manifest.json can't be read as Unity writes it. Fix the file, then set it up again.",
    );
  },
  get [SetupRefusal.InvalidGame]() {
    return t("Invalid game");
  },
} as const satisfies RefusalWords & { NotSetUp: string };

/** The words for where an opening ended. */
const OPENING: Record<Opened, (opening: Opening) => string> = {
  [Opened.Answers]: () => "It is already open in Unity and answers.",
  [Opened.SeemsOpen]: () =>
    "Unity has this project open, but its Pipeline server does not answer yet: it is still starting, or it has not loaded the package. Call again in a moment; if it stays so, ask the user to bring Unity to the front.",
  [Opened.Ready]: () => "the editor answers now. Build through the unity-editor tools, list_commands first.",
  [Opened.NotYet]: () =>
    "Unity is not ready yet (a first start imports the project and downloads its packages): when a unity-editor call says the project is not open or Unity is busy, call again in a moment.",
  [Opened.NoEditor]: ({ version, installed = [] }: Opening) =>
    `It was saved with Unity ${version}, which isn't installed here (installed: ${installed.join(", ") || "none"}). Ask the user to open it from Unity Hub, which installs that version or asks before it changes the project's.`,
  [Opened.Failed]: ({ why = "" }: Opening) =>
    `Unity didn't open it: ${why.replace(/\.?$/, ".")} Tell the user to open the project's folder in ${HUB}.`,
};

/** What `find-project` answers: whether the game holds a project and where, or why it was not kept. */
type FindProjectAnswer = { found: boolean; folder?: string; note?: string };

const storageOf = (context: PluginContext): Promise<string> => context.host(HostService.StorageRoot);

/**
 * Finds the bound game's Unity project and keeps it for the editor connector, or forgets the one
 * kept when the folder holds none. It answers at Genex's moments too, where a thrown error would
 * hold a turn: trouble is a note, never a block.
 */
async function findProject(deps: UnityBackendDeps, context: PluginContext): Promise<FindProjectAnswer> {
  const { project: game, directory } = context;
  if (!game || !directory) return { found: false };
  try {
    const project = await findUnityProject(directory);
    await rememberProject(await storageOf(context), game, project, deps.now);
    return project ? { found: true, folder: folderInGame(project) } : { found: false };
  } catch (error) {
    return { found: false, note: MESSAGE.NotKept(errorMessage(error)) };
  }
}

/** The bound game and its folder by real path, or the refusal a call with no game gets. */
async function gameOf(context: PluginContext, words: RefusalWords = MESSAGE): Promise<{ id: string; folder: string }> {
  const { project: id, directory } = context;
  const folder = directory ? await realpath(directory).catch(() => undefined) : undefined;
  if (!id || !folder) throw new Error(words.NoGame);
  return { id, folder };
}

/**
 * The agent's `multiplayer`: Genex multiplayer into the game's Unity project (the package, Colyseus,
 * the game's Genex project) and the game's matchmaking in its genex.json. Arguments are checked
 * before anything is written.
 */
async function setUpMultiplayer(deps: UnityBackendDeps, context: PluginContext, args: Record<string, unknown>) {
  const { folder } = await gameOf(context);
  const { project } = await projectOf(deps, context);
  const slug = slugArg(args.slug);
  const matchmaking = matchmakingArg(args.matchmaking);
  const source = deps.multiplayerPackage ?? SHIPPED_MULTIPLAYER_PACKAGE;
  const { kept, manifestChanged } = await installUnityMultiplayer(project.root, source, slug ? { slug } : {});
  if (matchmaking) await writeMatchmaking(folder, matchmaking);
  return MESSAGE.Multiplayer(await unityMultiplayerState(project.root, source), kept, manifestChanged);
}

/** The bound game's existing Unity project, kept for the connector; refused when the game holds none. */
async function projectOf(
  deps: UnityBackendDeps,
  context: PluginContext,
  words: RefusalWords = MESSAGE,
): Promise<{ id: string; project: UnityProject }> {
  const { id, folder } = await gameOf(context, words);
  const project = await findUnityProject(folder);
  if (!project) throw new Error(words.NoProject);
  await rememberProject(await storageOf(context), id, project, deps.now);
  return { id, project };
}

/** One of Genex's moments for the bound game: its project as the folder holds it now, with no project when it holds none. */
async function momentOf(context: PluginContext): Promise<Moment> {
  const { project: game, directory } = context;
  const project = game && directory ? await findUnityProject(directory) : undefined;
  return {
    game: game ?? "",
    storage: await storageOf(context),
    project,
    ...(context.hook ? { hook: context.hook } : {}),
    signal: context.signal,
  };
}

/** The newest installed Unity 6, or the refusal that says how to get one. */
async function creatingEditor(deps: UnityBackendDeps): Promise<UnityEditor> {
  const editors = await findEditors(deps.editors);
  const editor = newestUnity6(editors);
  if (!editor) throw new Error(MESSAGE.NoUnity6(readinessOf(editors).note));
  return editor;
}

/** What a new project's first setup came to, in words. */
async function firstSceneWords(deps: UnityBackendDeps, project: UnityProject, signal: AbortSignal): Promise<string> {
  const trouble = await firstSetup(project.root, deps, signal);
  return trouble ? MESSAGE.NoFirstScene(trouble.detail ?? trouble.problem) : MESSAGE.FirstScene;
}

/** The agent's `new-game`: the game's empty Unity project as `unity/`, kept for the connector, opened and given a first scene. */
async function newGame(deps: UnityBackendDeps, context: PluginContext): Promise<string> {
  const { id, folder } = await gameOf(context);
  const editor = await creatingEditor(deps);
  const project = await createProject(folder, editor, deps.editors.platform).catch((error: unknown) => {
    throw error instanceof NewProjectError ? new Error(MESSAGE[error.code]) : error;
  });
  await rememberProject(await storageOf(context), id, project, deps.now);
  const opening = await openProject(deps, project, await openingOf(deps, context, id));
  const made = MESSAGE.Made(editor.version);
  if (opening.opened === Opened.Failed) return `${made}, but ${OPENING[Opened.Failed](opening)}`;
  if (opening.opened !== Opened.Ready) return `${made}, and Unity is opening it: ${OPENING[opening.opened](opening)}`;
  const scene = await firstSceneWords(deps, project, context.signal);
  return `${made}, and opened it in Unity: ${OPENING[Opened.Ready](opening)} ${scene}`;
}

/** What a setup that could not go on says, in words that name what to do. */
function setupRefused(error: unknown, project: UnityProject, words: RefusalWords): Error {
  if (!(error instanceof SetupError)) return error instanceof Error ? error : new Error(errorMessage(error));
  if (error.code === SetupRefusal.NeedsUnity6)
    return new Error(words[SetupRefusal.NeedsUnity6](project.editorVersion ?? UNKNOWN_VERSION), { cause: error });
  return new Error(words[error.code], { cause: error });
}

/** How an opening is asked for a call: its stop, and where scene backups a killed editor left are kept. */
async function openingOf(deps: UnityBackendDeps, context: PluginContext, game: string) {
  return { signal: context.signal, keep: { storage: await storageOf(context), game, now: deps.now } };
}

/** The words about scene backups moved aside before an opening, when some were. */
const setAsideWords = (opening: Opening): string => (opening.setAside ? ` ${MESSAGE.SetAside(opening.setAside)}` : "");

/** How a sentence about an opening goes on after what was just done to the project. */
function afterChange(done: string, opening: Opening, changed: boolean): string {
  const alreadyOpen = opening.opened === Opened.Answers || opening.opened === Opened.SeemsOpen;
  if (changed && alreadyOpen) return `${done}. ${MESSAGE.LoadsWhenForward}`;
  if (opening.opened === Opened.Failed) return `${done}, but ${OPENING[Opened.Failed](opening)}`;
  const aside = setAsideWords(opening);
  if (launched(opening))
    return `${done} and opened the project in Unity ${opening.version}: ${OPENING[opening.opened](opening)}${aside}`;
  return `${done}. ${OPENING[opening.opened](opening)}${aside}`;
}

/** Where a setup of the bound game's project writes and keeps its record. */
async function setupPlace(context: PluginContext, id: string, project: UnityProject) {
  return { root: project.root, editorVersion: project.editorVersion, storage: await storageOf(context), game: id };
}

/** What a setup came to: whether the manifest changed, the package's version, and how opening the project ended. */
type SetUp = { changed: boolean; version: string; opening: Opening };

/** A setup, once the person confirmed: the Pipeline package in the project's manifest, then the project open. */
async function setUpAndOpen(deps: UnityBackendDeps, context: PluginContext, words: RefusalWords): Promise<SetUp> {
  const { id, project } = await projectOf(deps, context, words);
  const place = await setupPlace(context, id, project);
  const { changed, version } = await setUpProject(place, deps.now).catch((error: unknown) => {
    throw setupRefused(error, project, words);
  });
  return { changed, version, opening: await openProject(deps, project, await openingOf(deps, context, id)) };
}

/**
 * Opens a project Unity never opened, so that Unity writes its manifest, without waiting: a project
 * with no Pipeline package never answers Genex.
 */
async function openForManifest(deps: UnityBackendDeps, context: PluginContext): Promise<string> {
  const { id, project } = await projectOf(deps, context);
  const opening = await openProject(deps, project, { ...(await openingOf(deps, context, id)), waitMs: 0 });
  const refused = opening.opened === Opened.NoEditor || opening.opened === Opened.Failed;
  if (refused) return `${MESSAGE[SetupRefusal.NoManifest]} ${OPENING[opening.opened](opening)}`;
  return `${MESSAGE.OpenedForManifest(opening.version)}${setAsideWords(opening)}`;
}

/** Whether a setup was refused because Unity never wrote the project's manifest. */
const noManifest = (error: unknown): boolean =>
  error instanceof Error && error.cause instanceof SetupError && error.cause.code === SetupRefusal.NoManifest;

/**
 * The agent's `setup`: what it came to, in words. A project Unity never opened has no manifest to
 * add the package to: Genex opens it (setup's confirmation covers opening it), and Unity writes one.
 */
async function setup(deps: UnityBackendDeps, context: PluginContext): Promise<string> {
  try {
    const { changed, version, opening } = await setUpAndOpen(deps, context, MESSAGE);
    return afterChange(changed ? MESSAGE.SetUp(version) : MESSAGE.AlreadySetUp(version), opening, changed);
  } catch (error) {
    if (!noManifest(error)) throw error;
    return openForManifest(deps, context);
  }
}

/** An undo of setup, once the person confirmed: exactly the line setup added, taken back. */
async function undoSetUp(
  deps: UnityBackendDeps,
  context: PluginContext,
  words: RefusalWords,
): Promise<{ changed: boolean }> {
  const { id, project } = await projectOf(deps, context, words);
  return undoSetup(await setupPlace(context, id, project)).catch((error: unknown) => {
    throw setupRefused(error, project, words);
  });
}

/** The agent's `undo-setup`: what it came to, in words. */
async function undo(deps: UnityBackendDeps, context: PluginContext): Promise<string> {
  const { changed } = await undoSetUp(deps, context, MESSAGE);
  return changed ? MESSAGE.UndoneSetup : MESSAGE.NothingToUndo;
}

/** What an opening the agent asked for came to, in words. */
function openedWords(opening: Opening, did: string): string {
  const said = launched(opening)
    ? `${did} in Unity ${opening.version}: ${OPENING[opening.opened](opening)}`
    : OPENING[opening.opened](opening);
  return `${said}${setAsideWords(opening)}`;
}

/** The agent's `open-editor`: the game's project open in its own Unity, once it has the Pipeline package. */
async function openEditor(deps: UnityBackendDeps, context: PluginContext): Promise<string> {
  const { id, project } = await projectOf(deps, context);
  if (!(await pipelineVersionOf(project.root).catch(() => undefined))) return MESSAGE.NoPipeline;
  const opening = await openProject(deps, project, await openingOf(deps, context, id));
  return openedWords(opening, "Opened this game's Unity project");
}

/** What a restart came to: whether the editor ended, and how opening the project again ended when it did. */
type Restarted = { ended: boolean; opening?: Opening };

/**
 * A restart, once the person confirmed: the game's editor ended, its work saved first when it
 * answers (its play stopped), a stalled one included (its unsaved work is lost), and its project
 * opened again. An editor that would not end gets no second one beside it.
 */
async function endAndOpen(deps: UnityBackendDeps, context: PluginContext, words: RefusalWords): Promise<Restarted> {
  const { id, project } = await projectOf(deps, context, words);
  if (!(await endEditor(project.root, deps, { save: true, signal: context.signal }))) return { ended: false };
  const options = { ...(await openingOf(deps, context, id)), waitMs: RESTART_OPEN_WAIT_MS };
  return { ended: true, opening: await openProject(deps, project, options) };
}

/** The agent's `restart-editor`: what it came to, in words. */
async function restartEditor(deps: UnityBackendDeps, context: PluginContext): Promise<string> {
  const { opening } = await endAndOpen(deps, context, MESSAGE);
  return opening ? openedWords(opening, "Ended Unity and opened this game's project again") : MESSAGE.NotEnded;
}

/** The panel's `status`: where the open game's Unity stands; a folder that can't be read holds no project. */
async function statusFor(deps: UnityBackendDeps, context: PluginContext): Promise<PanelStatus> {
  const { project: game, directory } = context;
  const open = Boolean(game && directory);
  const project = directory && open ? await findUnityProject(directory).catch(() => undefined) : undefined;
  return panelStatus(deps, { open, project }, context.signal);
}

/** The panel's `open-editor`: the game's set-up project open in its own Unity. */
async function openForPerson(deps: UnityBackendDeps, context: PluginContext): Promise<Opening> {
  const { id, project } = await projectOf(deps, context, PANEL_MESSAGE);
  if (!(await pipelineVersionOf(project.root).catch(() => undefined))) throw new Error(PANEL_MESSAGE.NotSetUp);
  return openProject(deps, project, await openingOf(deps, context, id));
}

/** The panel's `get-unity`: Unity Hub when it is installed, else Unity's download page; nothing the panel sends chooses which. */
async function getUnity(deps: UnityBackendDeps): Promise<{ opened: UnitySource }> {
  const hub = await findHub(deps.editors);
  await deps.open(getUnityLaunch(deps.editors.platform, hub));
  return { opened: hub ? UnitySource.Hub : UnitySource.Download };
}

/** Where a game's Don't use Unity is kept: one empty file per game, in the plugin's storage. */
async function skipFile(context: PluginContext): Promise<string> {
  const { id } = await gameOf(context);
  return path.join(await storageOf(context), SKIPPED_FOLDER, encodeURIComponent(id));
}

/** The setup card for this computer now, with the install under way; closed once the person chose Don't use Unity here. */
async function stepsOf(deps: UnityBackendDeps, installer: Installer, context: PluginContext) {
  const card = setupCard(await readFacts(deps.editors, await installer.job()));
  const skipped = await stat(await skipFile(context)).then(
    () => true,
    () => false,
  );
  return skipped && card.open ? skippedCard(card) : card;
}

/** The agent's `show-steps`: the Unity setup card in the game's chat, while a step is open; it takes back Don't use Unity. */
async function showSteps(deps: UnityBackendDeps, installer: Installer, context: PluginContext): Promise<string> {
  await rm(await skipFile(context), { force: true });
  if (!(await stepsOf(deps, installer, context)).open) return MESSAGE.StepsDone;
  return (await context.host(HostService.EngineSteps)) ? MESSAGE.StepsShown : MESSAGE.StepsNoChat;
}

/** Don't use Unity: stops what Genex is doing and closes the card for this game, which tells the agent. */
async function skip(installer: Installer, context: PluginContext): Promise<void> {
  const file = await skipFile(context);
  await installer.stop();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "");
}

/** The setup card's buttons and its own reading, over one installer. */
function setupActions(deps: UnityBackendDeps, installer: (context: PluginContext) => Promise<Installer>) {
  return {
    [UnityAction.Steps]: async (context: PluginContext) => stepsOf(deps, await installer(context), context),
    [UnityAction.GetHub]: async (context: PluginContext) => (await installer(context)).getHub(),
    [UnityAction.OpenHub]: async (context: PluginContext) => (await installer(context)).openHub(),
    [UnityAction.InstallUnity]: async (context: PluginContext) => (await installer(context)).installEditor(),
    [UnityAction.SetUp]: async (context: PluginContext) => (await installer(context)).setUp(),
    [UnityAction.Stop]: async (context: PluginContext) => (await installer(context)).stop(),
    [UnityAction.Skip]: async (context: PluginContext) => skip(await installer(context), context),
  };
}

/** The backend over the clock, the installed editors, the opener, the editor's network and the processes a test may stand in for. */
export function createUnityBackend(deps: UnityBackendDeps): PluginActivation {
  const play = createComputerPlay(deps);
  let installing: Installer | undefined;
  let storage = "";
  // Unity's own install goes on across calls, kept in the plugin's storage, which every call names alike.
  const installerOf = async (context: PluginContext): Promise<Installer> => {
    storage = await storageOf(context);
    installing ??= createInstaller(deps.install ?? systemInstallDeps(deps.editors, deps.open), async () => storage);
    return installing;
  };
  const watchIdle = idleWatch(deps);
  const atMoment =
    <T>(handler: (moment: Moment, momentDeps: MomentDeps) => Promise<T>) =>
    async (context: PluginContext) =>
      handler(await momentOf(context), deps);
  const tools: Record<UnityTool, (context: PluginContext, args: Record<string, unknown>) => Promise<unknown>> = {
    [UnityTool.FindProject]: (context) => findProject(deps, context),
    [UnityTool.EngineStatus]: async () => readinessOf(await findEditors(deps.editors)),
    [UnityTool.NewGame]: (context) => newGame(deps, context),
    [UnityTool.Setup]: (context) => setup(deps, context),
    [UnityTool.UndoSetup]: (context) => undo(deps, context),
    [UnityTool.OpenEditor]: (context) => openEditor(deps, context),
    [UnityTool.RestartEditor]: (context) => restartEditor(deps, context),
    [UnityTool.QuitEditor]: atMoment(quitEditor),
    [UnityTool.SaveAll]: atMoment(saveAll),
    [UnityTool.EndEditor]: atMoment(endForRestore),
    [UnityTool.ReopenEditor]: atMoment(reopenEditor),
    [UnityTool.EditorState]: atMoment(editorState),
    [UnityTool.OpenForRun]: atMoment(openForRun),
    [UnityTool.AfterRun]: async (context) => {
      const moment = await momentOf(context);
      const answer = await afterRun(moment, deps, await closeIdleOn(context));
      watchIdle(moment.storage);
      return answer;
    },
    [UnityTool.SceneShots]: atMoment(sceneShots),
    [UnityTool.EditorActivity]: atMoment(editorActivity),
    [UnityTool.ShowSteps]: async (context) => showSteps(deps, await installerOf(context), context),
    [UnityTool.Multiplayer]: (context, args) => setUpMultiplayer(deps, context, args),
  };
  // An action takes nothing from its arguments: the open game's own project is all it acts on.
  const actions: Record<UnityAction, (context: PluginContext) => Promise<unknown>> = {
    [UnityAction.Status]: (context) => statusFor(deps, context),
    [UnityAction.ToolbarStatus]: async (context) => toolbarStatusOf(await statusFor(deps, context)),
    [UnityAction.OpenEditor]: (context) => openForPerson(deps, context),
    [UnityAction.Setup]: (context) => setUpAndOpen(deps, context, PANEL_MESSAGE),
    [UnityAction.UndoSetup]: (context) => undoSetUp(deps, context, PANEL_MESSAGE),
    [UnityAction.RestartEditor]: (context) => endAndOpen(deps, context, PANEL_MESSAGE),
    [UnityAction.GetUnity]: () => getUnity(deps),
    [UnityAction.Agents]: async (context) => agentsSetting(await storageOf(context)),
    [UnityAction.AgentsGoAhead]: async (context) => setAgentsSetting(await storageOf(context), true),
    [UnityAction.AgentsWait]: async (context) => setAgentsSetting(await storageOf(context), false),
    ...setupActions(deps, installerOf),
  };
  return {
    async tool(name, args, context) {
      if ((ENGINE_PLAY_TOOLS as readonly string[]).includes(name))
        return play(name as EnginePlayTool, args, context, await storageOf(context));
      if (!isUnityTool(name)) throw new Error(MESSAGE.UnknownTool(name));
      return tools[name](context, args);
    },
    async action(name, _args, context) {
      if (!isUnityAction(name)) throw new Error(MESSAGE.UnknownAction(name));
      return actions[name](context);
    },
  };
}

/** This computer's own clock, editors, opener, network and processes. */
export const systemBackendDeps = (): UnityBackendDeps => ({
  now: () => new Date(),
  editors: systemEditorsEnv(),
  open: systemOpener,
  pipeline: systemPipelineDeps,
  processes: systemProcesses(),
  idleMs: () => systemIdleMs(),
});

export const activate: Activate = () => createUnityBackend(systemBackendDeps());
