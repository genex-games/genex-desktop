/**
 * The Godot plugin's backend. Agents build a Godot game with Godot's own command line, run in
 * Genex's native-job sandbox (`godot-run.ts`): `new-game` makes the game's project from a template,
 * `check` imports it and loads every file so Godot names each problem, `run-scene` plays a scene
 * headless, `screenshot` takes stills, and `class-reference` answers the installed version's API.
 * Genex's moments use the same: a checkpoint notes what the check found, and a run's save points
 * and its reviewer get stills (`hero-shots`). The panel and the toolbar find Godot, make a game
 * and open it in the person's own Godot editor, which Genex never drives.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { t, tc } from "../../shared/i18n.ts";
import { writeFileNoFollow } from "../../substrate/fsx.ts";
import { type HookAnswer, HookEvent, HOOK_RECORDING_MAX } from "../../shared/plugin-hooks.ts";
import { OBSERVE_CALL_MS } from "../../shared/observers.ts";
import type { Activate, PluginActivation, PluginContext, PluginReview } from "../../plugin-sdk/index.d.ts";
import { answerQuery, createReference } from "./class-reference.ts";
import {
  addWebPreset,
  copyBridge,
  templateCopyCall,
  hasWebTemplate,
  prepareWebFolder,
  templateVersion,
  WEB_EXPORT_FOLDER,
  WEB_PACK,
  webExportCall,
  webTemplates,
} from "./web-export.ts";
import { askEditor, EditorOp, liveEditor, unsavedScriptsOf } from "./editor-bridge.ts";
import { editorOpen, type EditorEnv, getGodotLaunch, openEditorLaunch, systemEditorEnv } from "./editor.ts";
import {
  findGodots,
  type GodotEnv,
  type GodotInstall,
  GodotReadiness,
  godotReadiness,
  systemGodotEnv,
  usableGodot,
  versionName,
} from "./find-godot.ts";
import {
  ExportPlatform,
  ExportTemplate,
  fetchTemplates,
  PLATFORM_TEMPLATES,
  withMacTextures,
} from "./export-templates.ts";
import { checkedCount, dataCopied, isError, MAX_PROBLEMS, problemLines, readProblems } from "./godot-output.ts";
import {
  checkCall,
  confinedRunner,
  DEFAULT_RUN_SECONDS,
  type GodotJobScope,
  type GodotRunner,
  importCall,
  MAX_RUN_SECONDS,
  playCall,
  runCall,
} from "./godot-run.ts";
import { GAME_PROJECT_FOLDER, PROJECT_FILE, projectScene } from "./game-project.ts";
import {
  createGodotInstaller,
  type GodotInstallDeps,
  type GodotInstaller,
  type GodotJob,
  GodotSetupAction,
  godotSetupCard,
  windowsJob,
} from "./godot-setup.ts";
import { linkProject, outsideGame, projectOf, requireProject } from "./project-link.ts";
import { findProjects, readProject } from "./find-projects.ts";
import { createProject, GodotTemplate } from "./new-project.ts";
import { addonState, isSetUp, setUpGame } from "./genex-addon.ts";
import {
  BRIDGE_LICENSES_FILE,
  BRIDGE_PAGE_FILE,
  type ColyseusRelease,
  colyseusRelease,
  installColyseus,
  installMultiplayer,
  type MultiplayerState,
  multiplayerState,
  usesMultiplayer,
} from "./multiplayer.ts";
import { matchmakingArg, slugArg, writeMatchmaking } from "../../substrate/genex-game-settings.ts";
import { frameAt, type KeyPress, keysEnd, MAX_PLAY_SECONDS, PLAY_FPS, readKeys, recordingShots } from "./play-input.ts";
import { MAX_STILLS, stillsAnswer, stillsForAgent, takeStills } from "./stills.ts";

/** The host services this backend calls, by their public SDK names. */
const HostService = {
  StorageRoot: "storage.root",
  GameCreate: "game.create",
  EngineSteps: "game.engine.steps",
  RuntimeDetect: "runtime.detect",
  RuntimeInstall: "runtime.install",
  RuntimeInstallation: "runtime.installation",
  RuntimeCancelInstall: "runtime.cancelInstall",
} as const;
/** The runtime the manifest declares: Genex's own Godot on Windows, which the host installs and finds. */
const GODOT_RUNTIME = { runtime: "godot" } as const;

/** The actions plugin.json declares. */
const GodotAction = {
  Status: "status",
  Create: "create",
  OpenEditor: "open-editor",
  GetGodot: "get-godot",
  ToolbarStatus: "toolbar-status",
  StageStatus: "stage-status",
  SetUp: "set-up",
  WebExport: "web-export",
  UseProject: "use-project",
  Steps: GodotSetupAction.Steps,
  InstallGodot: GodotSetupAction.Install,
  DownloadGodot: GodotSetupAction.Download,
  StopInstall: GodotSetupAction.Stop,
  Skip: GodotSetupAction.Skip,
} as const;
type GodotAction = (typeof GodotAction)[keyof typeof GodotAction];
const ACTION_NAMES: ReadonlySet<string> = new Set(Object.values(GodotAction));
const isGodotAction = (name: string): name is GodotAction => ACTION_NAMES.has(name);

/** The tools plugin.json declares: the agent's, then the harness's own (`audience: harness`). */
export const GodotTool = {
  NewGame: "new-game",
  Check: "check",
  RunScene: "run-scene",
  Screenshot: "screenshot",
  ClassReference: "class-reference",
  EngineStatus: "engine-status",
  CheckpointCheck: "checkpoint-check",
  WebExport: "web-export",
  SaveAll: "save-all",
  ReloadEditor: "reload-editor",
  KeepWebBuild: "keep-web-build",
  HeroShots: "hero-shots",
  SetUp: "set-up",
  ShowSteps: "show-steps",
  Multiplayer: "multiplayer",
  ExportTemplates: "export-templates",
} as const;
type GodotTool = (typeof GodotTool)[keyof typeof GodotTool];
const TOOL_NAMES: ReadonlySet<string> = new Set(Object.values(GodotTool));
const isGodotTool = (name: string): name is GodotTool => TOOL_NAMES.has(name);

/** The folders shipped beside the backend: Genex's GDScript and the new-game templates. */
const SCRIPTS_FOLDER = "scripts";
const TEMPLATES_FOLDER = "templates";
const ADDON_SOURCE = ["addon", "genex"];
/** Genex's multiplayer addon, and the folder of the SDK bridge, its licenses and the Colyseus license beside the backend. */
const MULTIPLAYER_ADDON_SOURCE = ["addon", "genex_multiplayer"];
const MULTIPLAYER_FOLDER = "multiplayer";
const COLYSEUS_LICENSE_FILE = "COLYSEUS-LICENSE";
/** What an observer's capture keeps free of the time Genex gives it: reading and handing back the pictures. */
const OBSERVE_MARGIN_MS = 5 * SECOND_MS;
/** The least an observer's capture is given, however little time is left: a shorter one could draw nothing. */
const MIN_OBSERVE_MS = SECOND_MS;
/** The most lines of a run's own printing an answer carries, from its end. */
const RUN_OUTPUT_LINES = 40;
/** When a screenshot is taken by default, the earliest it may be, and when a save point's and the reviewer's stills are. */
const SCREENSHOT_SECONDS = 1;
const MIN_SHOT_SECONDS = 0.1;
const HERO_SECONDS = 3;
/** The reviewer's recording: this many frames of the first hero camera, spread over these seconds of play. */
const HERO_RECORDING_FRAMES = 6;
const HERO_RECORDING_SECONDS = 6;
/** How far a file system's clock may lag Genex's when it tells a fresh export from an old one. */
const EXPORT_CLOCK_SLACK_MS = 2 * SECOND_MS;
/**
 * `web-export`'s whole call (plugin.json's `timeoutMs`, nine minutes) less the time its answer
 * takes: the template's fetch, its copy on Windows and Godot's export all fit in it.
 */
const WEB_EXPORT_BUDGET_MS = 9 * MINUTE_MS - 15 * SECOND_MS;
/** The least of that budget Godot's export is left: a template that took longer to fetch stops the call before Godot runs. */
const MIN_EXPORT_MS = MINUTE_MS;
/** How many problems a checkpoint's note names. */
const NOTED_PROBLEMS = 3;
/** The plugin storage folder holding each game's Don't use Godot. */
const SKIPPED_FOLDER = path.join("godot-setup", "skipped");
/** The most a program Genex runs while installing Godot may print. */
const RUN_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
const execFileAsync = promisify(execFile);
/** The agent's name for the new-game tool, as the engine question reads it. */
const NEW_GAME = "godot__new-game";

/**
 * The backend's words. The agent reads most of them, in English; the ones a person reads (the
 * toolbar, Live's card, Set up's question and the panel's answers) are functions, translated when said.
 */
const MESSAGE = {
  UnknownAction: (name: string) => t("Unknown Godot action: {name}", { name }),
  UnknownTool: (name: string) => `Unknown Godot tool: ${name}`,
  NoGodot:
    "Godot 4 isn't installed on this computer. Call godot__show-steps: it puts the Godot setup card in the chat, where Genex installs Godot for the user (Do it for me). Say so in one line and end your reply; the chat tells you when Godot is ready.",
  StepsShown:
    "The Godot setup card is in the chat: Genex installs Godot for the user with Do it for me. Tell them in one line, then end your reply; the chat tells you when Godot is ready.",
  StepsDone: "Godot is installed here; there is no setup card to show. Call godot__new-game.",
  StepsNoChat: "There is no chat to show the Godot setup card in.",
  NoGameOpen: "Open a game in Genex first: a Godot project is made in a game's folder.",
  /** {@link MESSAGE.NoGameOpen} as the panel shows it. */
  NoGameForPanel: () => t("Open a game in Genex first: a Godot project is made in a game's folder."),
  OutsideOnWindows: () =>
    t("On Windows, Genex builds a Godot project only inside the game's folder: choose one there, or make a new one."),
  NewGame: (template: string, version: string) =>
    `Made this game's Godot project in ${GAME_PROJECT_FOLDER}/ from the ${template.toUpperCase()} template, for Godot ${version}: main.tscn (a player that moves, and a HeroCamera in the genex_shot group) and player.gd. Build the game there in GDScript and scenes, never as a web page. After each change call godot__check; call godot__screenshot to see it. The person opens it in Godot from the Godot button.`,
  ImportFailed: (why: string) => `Godot's first import didn't finish (${why}); godot__check imports again.`,
  Checked: (count: number) => `Loaded ${count} scripts, scenes and resources.`,
  NotChecked: "Godot stopped before its check finished: the problems above are what it found.",
  TimedOut: "Godot didn't finish in time and was stopped.",
  NoStills: "Godot saved no stills: check that the scene loads (godot__check) and has a camera.",
  NoStillsBecause: (lines: readonly string[]) => `Godot saved no stills. It said: ${lines.join(" | ")}`,
  CheckNote: (count: number, lines: readonly string[]) =>
    `Godot's check found ${count} ${count === 1 ? "problem" : "problems"}: ${lines.slice(0, NOTED_PROBLEMS).join(" | ")}${count > NOTED_PROBLEMS ? ` (and ${count - NOTED_PROBLEMS} more)` : ""}`,
  Web: {
    NoTemplates: (version: string, why: string) =>
      `Godot ${version}'s Web export template isn't on this computer and Genex couldn't fetch it: ${why} If it keeps failing, tell the person to open the project in Godot (the Godot button above the game), choose Editor → Manage Export Templates and press Download and Install, then export again.`,
    Link: "The web export's folder or the project's export_presets.cfg is a link, so Genex won't write through it.",
    Failed: (lines: readonly string[]) =>
      `Godot's web export didn't finish${lines.length ? `: ${lines.join(" | ")}` : ""}. Fix what it names (godot__check helps), then export again.`,
    TimedOut: "Godot's web export didn't finish in time and was stopped.",
    NoTimeLeft:
      "Getting Godot's Web export template took most of this call's time, so Genex didn't start the export. It's in place now: export again.",
    NoTemplateCopy: (why: string) =>
      `Genex couldn't put Godot's Web export template where its sandbox reads it (${why}). Export again; if it keeps failing, install the template again in Godot (Editor → Manage Export Templates).`,
    NothingSaid: "Godot said nothing",
    Exported: () => t("Exported for the web into web/: Live's Web game tab plays it, and Publish puts it online."),
    NotKept: (why: string) => `Godot's web build in web/ wasn't refreshed (${why}); it plays the game as it was.`,
    Done: (files: number) =>
      `Exported the game for the web into ${WEB_EXPORT_FOLDER}/ (${files} files): Live's Web game tab plays it and Publish puts it online. It is Godot's build: never edit its files; export again after changing the project.`,
  },
  Editor: {
    NoAnswer:
      "Your Godot editor didn't answer Genex's ask to save, so Genex won't rewind over work open in it: save in Godot, then try again.",
    Unsaved: (scripts: number) =>
      `Your Godot editor holds ${scripts === 1 ? "a script" : `${scripts} scripts`} with changes Genex couldn't save: save ${scripts === 1 ? "it" : "them"} in Godot, then try again.`,
    NotSaved: "Your Godot editor didn't answer Genex's ask to save, so work open in it may not be in this save point.",
    UnsavedNote: (scripts: number) =>
      `${scripts === 1 ? "A script" : `${scripts} scripts`} open in Godot with unsaved changes ${scripts === 1 ? "isn't" : "aren't"} in this save point.`,
    NotReloaded:
      "Your Godot editor didn't answer Genex's ask to reload: it will offer to reload the changed files when you return to it.",
  },
  /** What the setup's actions answer the person when pressed on the other computer. */
  Setup: {
    DownloadOnWindows: () =>
      t(
        "On Windows, Genex downloads Godot itself: press Get Godot in the Godot panel, or Do it for me on the setup card.",
      ),
    DownloadIsWindows: () =>
      t("Genex downloads Godot this way on Windows only; on a Mac, Do it for me installs it in Applications."),
  },
  Templates: {
    BadPlatforms: `platforms is web, windows or mac, comma-separated (all three when left out).`,
    Ready: (version: string, platforms: readonly string[], fetched: readonly string[], windows: boolean) =>
      [
        `Godot ${version}'s export templates for ${platforms.join(", ")} are in place${fetched.length ? ` (fetched now: ${fetched.join(", ")})` : ""}.`,
        windows
          ? "They are also where Genex's sandbox (and so your shell) reads them, so Godot's command line in your shell can export with them."
          : "",
        platforms.includes(ExportPlatform.Mac)
          ? "project.godot imports ETC2/ASTC textures, as a Mac export needs. On Windows Godot exports a Mac app only as a .zip."
          : "",
        "For the web, call godot__web-export instead: it writes web/, which Live and Publish read.",
      ]
        .filter(Boolean)
        .join(" "),
  },
  SetUpQuestion: () => t("Set this Godot game up for Genex's play?"),
  SetUpDetail: (where: string) =>
    t(
      "Genex will add its addon to the project ({where}/addons/genex: a script that sleeps unless Genex starts the game, and an editor plugin that saves your open scenes before a save point and reloads them after a Rewind), list them in project.godot, write bin/play (starts the game for Genex) and mark the game in studio.json, so Genex's computer tool, playtesters and judges can play it. A Genex file you changed is kept beside the new one as .mine.",
      { where },
    ),
  Multiplayer: {
    Done: (state: MultiplayerState, notes: readonly string[]) =>
      [
        `Genex multiplayer is in this game's Godot project: addons/genex_multiplayer and its GenexMultiplayer autoload; the next web export loads Genex's SDK bridge (the Genex Web preset's head include), so the web build plays online on its Genex page.`,
        state.native
          ? "Native builds (macOS, Windows, Linux) play online too, with the Colyseus GDExtension in addons/colyseus."
          : "",
        state.slug
          ? `Its Genex project is ${state.slug} (project.godot [genex] slug).`
          : "It has no Genex project yet: after its first publish, call godot__multiplayer again with slug (genex__publish-status names it), so native builds know which game to join; the web build reads it from its Genex page.",
        ...notes,
        "Write the game's online play now, as the godot-multiplayer skill says (godot__skill): GenexMultiplayer.join with mode matchmake (or play), the slug, and native identity; then godot__check.",
      ]
        .filter(Boolean)
        .join("\n"),
    NoNative: (why: string) =>
      `Native builds can't play online yet: Genex couldn't add the Colyseus GDExtension (${why}). The web build plays online; call godot__multiplayer again to retry.`,
  },
  SetUpDone:
    "This game is set up for Genex's play: Genex's computer tool, playtesters and judges can now start it with bin/play, press keys, point, step its clock and read its state.",
  BadSeconds: `seconds is a whole number from 1 to ${MAX_RUN_SECONDS}.`,
  BadShotSeconds: `seconds is when the screenshot is taken: from ${MIN_SHOT_SECONDS} to ${MAX_PLAY_SECONDS} seconds of play.`,
  Toolbar: {
    /** The button's badge while Godot is missing: the same word Unity's and Unreal's say. */
    GetBadge: () => t("Not installed"),
    /** The button's badge while the game's project isn't set up for Genex's play. */
    SetUpBadge: () => tc("badge", "Set up"),
    Get: () => t("Get Godot 4"),
    Old: (version: string) => t("Godot {version} is older than the 4.3 Genex builds with", { version }),
    /** The product's name and version: never translated. */
    Ready: (version: string) => `Godot ${version}`,
    Open: (version: string) => t("Godot {version} has this game's project open", { version }),
    SetUp: () => t("Set this Godot game up for Genex's play"),
  },
  /** Live's card (`stage-status`): one line, a quieter hint and one step, as `shared/plugin-stage-card.ts` reads them. */
  Stage: {
    Get: () => t("Plays in Godot 4, which isn't on this computer yet."),
    GetButton: () => t("Get Godot"),
    Old: (version: string) => t("Godot {version} is older than the 4.3 Genex builds with.", { version }),
    NoProject: () => t("No Godot project in this game's folder yet."),
    NotSetUp: () => t("Plays in Godot. Set it up so Genex's playtesters and judges can play it too."),
    SetUpButton: () => t("Set up for Genex"),
    Open: (version: string) => t("Open in Godot {version}.", { version }),
    OpenHint: () => t("Your Godot reloads the files Genex changes."),
    Ready: (version: string) => t("Plays in Godot {version}.", { version }),
    OpenButton: () => t("Open in Godot"),
  },
} as const;

/** How much getting Godot downloads, as the engine question says it: a Mac's app, Windows's pinned zip. */
const GODOT_SIZE = { Mac: "about 150 MB", Windows: "about 86 MB" } as const;

/**
 * What the backend is given: how Godot is found and run, the person's editor, and the folders of
 * Genex's shipped scripts and templates. Tests hand in fakes for each.
 */
export type GodotBackendDeps = {
  env: GodotEnv;
  /** What installing Godot for the person on a Mac reaches; this Mac's own unless a test stands in. */
  install?: GodotInstallDeps;
  editor: EditorEnv;
  run: GodotRunner;
  scripts: string;
  templates: string;
  /** The shipped Genex addon (`addon/genex`): the Play Protocol autoload a set-up game carries. */
  addon: string;
  /**
   * Genex multiplayer: the shipped addon (`addon/genex_multiplayer`), the SDK's bridge a web export
   * loads, the Colyseus license a project's copy carries, and the Colyseus release when a test pins another.
   */
  multiplayer: {
    addon: string;
    bridge: string;
    bridgeLicenses: string;
    license: string;
    release?: ColyseusRelease;
  };
  /** The clock a call's budget is read on (`web-export`'s); the wall clock unless a test holds it. */
  now?: () => number;
};

type Handler = (args: Record<string, unknown>, context: PluginContext) => Promise<unknown>;

const textArg = (args: Record<string, unknown>, key: string) => (typeof args[key] === "string" ? args[key].trim() : "");
const storageOf = (context: PluginContext) => context.host(HostService.StorageRoot);
/** The open game's folder, where New game makes its project; undefined outside a game. */
const gameFolderOf = (context: PluginContext): string | undefined =>
  context.project && context.directory ? context.directory : undefined;

/** Genex's own Godot on Windows, as the host finds its pinned runtime; none elsewhere or when it isn't there. */
async function ownGodot(deps: GodotBackendDeps, context: PluginContext): Promise<string[]> {
  if (deps.env.platform !== "win32") return [];
  const found = await context.host(HostService.RuntimeDetect, GODOT_RUNTIME).catch(() => null);
  return found?.path ? [found.path] : [];
}

/** Every Godot on this computer, Genex's own on Windows among them, newest first. */
async function godots(deps: GodotBackendDeps, context: PluginContext): Promise<GodotInstall[]> {
  return findGodots(deps.env, await ownGodot(deps, context));
}

/** The Godot Genex uses, or why there is none in the words an agent passes on. */
async function requireGodot(deps: GodotBackendDeps, context: PluginContext): Promise<GodotInstall> {
  const install = usableGodot(await godots(deps, context));
  if (!install) throw new Error(MESSAGE.NoGodot);
  return install;
}

/** What a Godot job of this call runs under: its stop (the call's unless given), the host, the game and its project. */
function jobOf(context: PluginContext, project: string | null, signal = context.signal): GodotJobScope {
  return { signal, host: context.host, game: context.directory, project };
}

/** The engine question's words for this computer's Godot: ready to make a game with, or what it needs first. */
function readinessNote(readiness: GodotReadiness, version: string | null, platform: NodeJS.Platform): string {
  const windows = platform === "win32";
  const computer = windows ? "This PC" : "This Mac";
  const size = windows ? GODOT_SIZE.Windows : GODOT_SIZE.Mac;
  const toButton =
    "If the user picks it, don't call godot__new-game, which would refuse: call godot__show-steps, which puts the Godot setup card in the chat (Genex installs Godot for them), say so in one line and end your reply. The chat tells you when Godot is ready.";
  if (readiness === GodotReadiness.None)
    return `Godot isn't installed on this computer yet, so offer it as "Godot" with the description "Free and open source; needs Godot 4 installed first, ${size}". ${toButton}`;
  if (readiness !== GodotReadiness.Ready)
    return `${computer} has Godot ${version ?? ""}, and Genex builds with Godot 4.3 or newer in the 4 line, so offer it as "Godot 4" with the description "Needs a current Godot 4 beside your ${version ?? "Godot"}". ${toButton}`;
  return `Offer "Godot ${version ?? "4"}: builds in the Godot editor on this computer"; when the answer (or the request) is Godot, call ${NEW_GAME} with a template (2d or 3d) and a name: it makes the game's Godot project in this folder's ${GAME_PROJECT_FOLDER}/; then build the game there with the Godot tools, never as a web page.`;
}

/** `engine-status`: whether a new Godot game can be made here, and the engine card's words. */
async function engineStatus(deps: GodotBackendDeps, context: PluginContext) {
  const { readiness, version } = godotReadiness(await godots(deps, context));
  return {
    engine: readiness,
    version,
    ready: readiness === GodotReadiness.Ready,
    note: readinessNote(readiness, version, deps.env.platform),
  };
}

/** A first import, so the project's classes are known to the first check; one that fails is said, never thrown. */
async function firstImport(deps: GodotBackendDeps, install: GodotInstall, project: string, job: GodotJobScope) {
  try {
    const imported = await deps.run(install.binary, importCall(project), job);
    return imported.timedOut ? MESSAGE.ImportFailed(MESSAGE.TimedOut) : null;
  } catch (error) {
    return MESSAGE.ImportFailed(errorMessage(error));
  }
}

/** The agent's `new-game`: the game's Godot project from a template, imported once. */
async function newGame(deps: GodotBackendDeps, args: Record<string, unknown>, context: PluginContext) {
  const game = gameFolderOf(context);
  if (!game) throw new Error(MESSAGE.NoGameOpen);
  // Refused for want of Godot: the game's strip still shows the Godot button, which gets it.
  if (!usableGodot(await godots(deps, context))) await rememberWant(context);
  const install = await requireGodot(deps, context);
  const template = textArg(args, "template") || GodotTemplate.ThreeD;
  const project = await createProject(game, { template, name: textArg(args, "name") }, deps.templates);
  // A game New Godot game makes is Genex's play target from the start: nothing of the person's changes.
  await setUpGame(game, project, deps.addon, install.binary);
  const note = await firstImport(deps, install, project, jobOf(context, project));
  const made = MESSAGE.NewGame(template.toLowerCase(), versionName(install.version));
  return note ? `${made}\n${note}` : made;
}

/** An import, then Genex's check: every problem Godot named, and how many files it loaded. */
async function runCheck(deps: GodotBackendDeps, install: GodotInstall, project: string, job: GodotJobScope) {
  const imported = await deps.run(install.binary, importCall(project), job);
  const checked = await deps.run(install.binary, checkCall(project, deps.scripts), job);
  const problems = readProblems(`${imported.output}\n${checked.output}`);
  return { problems, checked: checkedCount(checked.output), timedOut: imported.timedOut || checked.timedOut };
}

/** The agent's `check`: errors and warnings by file and line, at most {@link MAX_PROBLEMS} of each. */
async function check(deps: GodotBackendDeps, context: PluginContext) {
  const project = await requireProject(context);
  const result = await runCheck(deps, await requireGodot(deps, context), project, jobOf(context, project));
  const errors = result.problems.filter(isError);
  const warnings = result.problems.filter((p) => !isError(p));
  return {
    ok: errors.length === 0 && result.checked !== null,
    errors: problemLines(errors.slice(0, MAX_PROBLEMS)),
    warnings: problemLines(warnings.slice(0, MAX_PROBLEMS)),
    ...(errors.length > MAX_PROBLEMS ? { moreErrors: errors.length - MAX_PROBLEMS } : {}),
    summary: checkSummary(result),
  };
}

/** One line on how a check went: cut off, stopped short, or how much it loaded. */
function checkSummary(result: { checked: number | null; timedOut: boolean }): string {
  if (result.timedOut) return MESSAGE.TimedOut;
  return result.checked === null ? MESSAGE.NotChecked : MESSAGE.Checked(result.checked);
}

/** `checkpoint-check`, Genex's check at a checkpoint: a note of what Godot found, never a block; nothing when all is well or Godot is missing. */
async function checkAtMoment(deps: GodotBackendDeps, context: PluginContext): Promise<HookAnswer> {
  if (context.hook?.on !== HookEvent.CheckpointBefore) return {};
  const project = await projectOf(context);
  const install = usableGodot(await godots(deps, context));
  if (!project || !install) return {};
  const result = await runCheck(deps, install, project, jobOf(context, project)).catch(() => null);
  const errors = result?.problems.filter(isError) ?? [];
  return errors.length ? { note: MESSAGE.CheckNote(errors.length, problemLines(errors)) } : {};
}

/**
 * `save-all` before a checkpoint or a restore: the person's open Godot editor saves its scenes and
 * the scripts it can. A checkpoint notes what stayed unsaved; a restore, which would replace those
 * files, waits for the person instead (a block) when the editor didn't answer or kept work unsaved.
 * Nothing without an editor that has the project open.
 */
async function saveAll(deps: GodotBackendDeps, context: PluginContext): Promise<HookAnswer> {
  const project = await projectOf(context);
  if (!project || !(await liveEditor(project, deps.editor))) return {};
  const answer = await askEditor(project, EditorOp.Save, deps.editor, context.signal);
  const restoring = context.hook?.on === HookEvent.RestoreBefore;
  const left = answer ? unsavedScriptsOf(answer) : 0;
  if (restoring && !answer) return { block: MESSAGE.Editor.NoAnswer };
  if (restoring && left) return { block: MESSAGE.Editor.Unsaved(left) };
  if (!answer) return { note: MESSAGE.Editor.NotSaved };
  return left ? { note: MESSAGE.Editor.UnsavedNote(left) } : {};
}

/** `reload-editor` after a restore: the person's open Godot editor reads its files again and reloads its open scenes. */
async function reloadEditor(deps: GodotBackendDeps, context: PluginContext): Promise<HookAnswer> {
  if (context.hook?.on !== HookEvent.RestoreAfter) return {};
  const project = await projectOf(context);
  if (!project || !(await liveEditor(project, deps.editor))) return {};
  const answer = await askEditor(project, EditorOp.Reload, deps.editor, context.signal);
  return answer ? {} : { note: MESSAGE.Editor.NotReloaded };
}

/**
 * `web-export`: Godot's Web export of the game's project into `web/`, with the person's Web template
 * for this Godot. Refused before Godot runs when the template is missing. Answers how many files it wrote.
 */
async function webExport(deps: GodotBackendDeps, context: PluginContext): Promise<number> {
  const now = deps.now ?? Date.now;
  const deadline = now() + WEB_EXPORT_BUDGET_MS;
  const game = gameFolderOf(context);
  if (!game) throw new Error(MESSAGE.NoGameOpen);
  const project = await requireProject(context);
  const install = await requireGodot(deps, context);
  // The fetch leaves the export its least: a slower one is stopped, never Godot's export cut short.
  const fetching = AbortSignal.any([context.signal, AbortSignal.timeout(WEB_EXPORT_BUDGET_MS - MIN_EXPORT_MS)]);
  await ensureTemplates(deps, install, [ExportTemplate.Web], fetching).catch((error: unknown) => {
    context.signal.throwIfAborted();
    throw new Error(MESSAGE.Web.NoTemplates(versionName(install.version), errorMessage(error)));
  });
  const multiplayer = await usesMultiplayer(project);
  await addWebPreset(project, MESSAGE.Web.Link, { multiplayer });
  const folder = await prepareWebFolder(game, MESSAGE.Web.Link);
  const templates = webTemplates(deps.env.dataHome, install).folder;
  const userTemp = await deps.env.userTemp();
  const call = webExportCall(project, folder, {
    folder: templates,
    version: templateVersion(install.version),
    userTemp,
  });
  const job = jobOf(context, project);
  // Windows: the sandbox user's Godot reads templates in its own data folder, so the person's goes there first.
  if (deps.env.platform === "win32") await placeTemplate(deps, install, project, job);
  const left = deadline - now();
  if (left < MIN_EXPORT_MS) throw new Error(MESSAGE.Web.NoTimeLeft);
  const started = Date.now();
  // A Windows job may wait its turn first: the runner reads the budget again when it starts.
  const budget = { until: deadline, now, least: MIN_EXPORT_MS, refusal: MESSAGE.Web.NoTimeLeft };
  const exporting = { ...call, timeoutMs: Math.min(call.timeoutMs, left) };
  const result = await deps.run(install.binary, exporting, { ...job, budget });
  if (result.timedOut) throw new Error(MESSAGE.Web.TimedOut);
  const pack = await stat(path.join(folder, WEB_PACK)).catch(() => null);
  const written = pack !== null && pack.mtimeMs >= started - EXPORT_CLOCK_SLACK_MS;
  const errors = readProblems(result.output).filter(isError);
  if (!written) throw new Error(MESSAGE.Web.Failed(problemLines(errors.slice(0, NOTED_PROBLEMS))));
  if (multiplayer) await copyBridge(folder, deps.multiplayer, MESSAGE.Web.Link);
  return (await readdir(folder)).filter((name) => !name.startsWith(".")).length;
}

/** Windows: the person's Web template put in the sandbox user's own data folder, or why it couldn't be, before Godot exports. */
async function placeTemplate(
  deps: GodotBackendDeps,
  install: GodotInstall,
  project: string,
  job: GodotJobScope,
  name: string = ExportTemplate.Web,
) {
  const call = templateCopyCall(project, deps.scripts, deps.env.dataHome, install, name);
  const copy = await deps.run(install.binary, call, job);
  const placed = dataCopied(copy.output);
  if (copy.timedOut) throw new Error(MESSAGE.Web.NoTemplateCopy(MESSAGE.TimedOut));
  if (!placed.copied) throw new Error(MESSAGE.Web.NoTemplateCopy(placed.why || MESSAGE.Web.NothingSaid));
}

/**
 * The templates asked for in the person's templates folder for the Godot in use: there already, or
 * fetched now from Godot's own release (`export-templates.ts`); answers the ones fetched.
 */
function ensureTemplates(
  deps: GodotBackendDeps,
  install: GodotInstall,
  names: readonly ExportTemplate[],
  signal: AbortSignal,
) {
  const { folder } = webTemplates(deps.env.dataHome, install);
  return fetchTemplates((deps.install ?? systemInstallDeps(deps.env)).fetch, install, folder, names, signal);
}

/** The platforms an agent's `export-templates` names: web, windows, mac, comma-separated; all three when none. */
function platformsArg(value: unknown): ExportPlatform[] {
  const all = Object.values(ExportPlatform);
  if (value === undefined || value === "") return all;
  const asked = String(value)
    .split(",")
    .map((word) => word.trim().toLowerCase())
    .filter(Boolean);
  const known = (word: string): word is ExportPlatform => (all as readonly string[]).includes(word);
  if (asked.length === 0 || !asked.every(known)) throw new Error(MESSAGE.Templates.BadPlatforms);
  return [...new Set(asked)] as ExportPlatform[];
}

/**
 * The agent's `export-templates`: Godot's templates for the platforms named, fetched into the
 * person's templates folder when missing; on Windows also put where the sandbox user's Godot (and
 * the agent's own shell) reads them; and for a Mac export, project.godot importing ETC2/ASTC.
 */
async function exportTemplates(deps: GodotBackendDeps, args: Record<string, unknown>, context: PluginContext) {
  const project = await requireProject(context);
  const install = await requireGodot(deps, context);
  const platforms = platformsArg(args.platforms);
  const names = platforms.flatMap((platform) => PLATFORM_TEMPLATES[platform]);
  const fetched = await ensureTemplates(deps, install, names, context.signal);
  const windows = deps.env.platform === "win32";
  const job = jobOf(context, project);
  if (windows) for (const name of names) await placeTemplate(deps, install, project, job, name);
  if (platforms.includes(ExportPlatform.Mac)) await importMacTextures(project);
  return MESSAGE.Templates.Ready(versionName(install.version), platforms, fetched, windows);
}

/** project.godot set to import ETC2/ASTC textures, never through a link. */
async function importMacTextures(project: string): Promise<void> {
  const file = path.join(project, PROJECT_FILE);
  const settings = await readFile(file, "utf8");
  const next = withMacTextures(settings);
  if (next !== settings) await writeFileNoFollow(file, next);
}

/** The most of a project's files `keep-web-build` looks at for the newest change. */
const NEWEST_SCAN_FILES = 5000;

/** When the project's own files last changed (ms), Godot's `.godot` cache and hidden files left out; looks at no more than {@link NEWEST_SCAN_FILES}. */
async function newestChange(project: string): Promise<number> {
  let newest = 0;
  let seen = 0;
  const folders = [project];
  while (folders.length > 0 && seen < NEWEST_SCAN_FILES) {
    const folder = folders.pop() ?? project;
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith(".")) continue;
      const where = path.join(folder, entry.name);
      if (entry.isDirectory()) folders.push(where);
      if (!entry.isFile()) continue;
      seen += 1;
      newest = Math.max(newest, (await stat(where).catch(() => null))?.mtimeMs ?? 0);
    }
  }
  return newest;
}

/**
 * `keep-web-build` at the end of each turn and after a restore: Godot's web build in `web/` made
 * again when the project changed since the last one, so Live's Web game tab and Publish always have
 * the game as it is. Nothing without a project, a usable Godot or its Web template, which it never
 * fetches itself (Do it for me and `web-export` do); a failure is a note, never a block.
 */
async function keepWebBuild(deps: GodotBackendDeps, context: PluginContext): Promise<HookAnswer> {
  const on = context.hook?.on;
  if (on !== HookEvent.TurnEnd && on !== HookEvent.RestoreAfter) return {};
  const game = gameFolderOf(context);
  const project = game ? await projectOf(context) : null;
  const install = usableGodot(await godots(deps, context));
  if (!game || !project || !install) return {};
  if (!(await hasWebTemplate(deps.env.dataHome, install))) return {};
  const pack = await stat(path.join(game, WEB_EXPORT_FOLDER, WEB_PACK)).catch(() => null);
  if (pack && pack.mtimeMs >= (await newestChange(project))) return {};
  try {
    await webExport(deps, context);
    return {};
  } catch (error) {
    return { note: MESSAGE.Web.NotKept(errorMessage(error)) };
  }
}

/** The seconds a run asks for: a whole number from 1 to {@link MAX_RUN_SECONDS}, or the default when absent. */
function runSeconds(args: Record<string, unknown>): number {
  if (args.seconds === undefined || args.seconds === "") return DEFAULT_RUN_SECONDS;
  const seconds = Number(args.seconds);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_RUN_SECONDS) throw new Error(MESSAGE.BadSeconds);
  return seconds;
}

/** The lines a run printed itself, without Godot's own banner and problems, from the end. */
function ownOutput(output: string): string[] {
  const lines = output.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("Godot Engine v"));
  return lines.filter((line) => !/^\s/.test(line) && !/^[A-Z ]*(ERROR|WARNING): /.test(line)).slice(-RUN_OUTPUT_LINES);
}

/** The agent's `run-scene`: a headless play of a scene, with keys pressed when asked, what it printed and what went wrong. */
async function runScene(deps: GodotBackendDeps, args: Record<string, unknown>, context: PluginContext) {
  const project = await requireProject(context);
  const seconds = runSeconds(args);
  const keys = readKeys(textArg(args, "keys"));
  const scene = await projectScene(project, textArg(args, "scene"));
  const install = await requireGodot(deps, context);
  const job = jobOf(context, project);
  await deps.run(install.binary, importCall(project), job);
  const call = keys.length ? keysPlay(project, deps.scripts, scene, seconds, keys) : runCall(project, scene, seconds);
  const ran = await deps.run(install.binary, call, job);
  const errors = readProblems(ran.output).filter(isError);
  return {
    scene: scene || "main scene",
    seconds,
    ...(keys.length ? { keys: textArg(args, "keys") } : {}),
    errors: problemLines(errors.slice(0, MAX_PROBLEMS)),
    output: ownOutput(ran.output),
    ...(ran.timedOut ? { summary: MESSAGE.TimedOut } : {}),
  };
}

/** A headless play with keys: as long as the run asks, or until the last key lets go. */
function keysPlay(project: string, scripts: string, scene: string, seconds: number, keys: KeyPress[]) {
  const frames = Math.max(seconds * PLAY_FPS, keysEnd(keys));
  return playCall(project, scripts, { scene, frames, keys, shots: [], out: null, most: 1, hero: false });
}

/** The most stills an agent asks for: a whole number from 1 to {@link MAX_STILLS}, else all of them. */
const stillCount = (args: Record<string, unknown>) => {
  const asked = Number(args.max);
  return Number.isInteger(asked) && asked >= 1 ? Math.min(asked, MAX_STILLS) : MAX_STILLS;
};

/** The moment a screenshot is taken, in seconds of play: from a tenth of a second to a minute, else the default. */
function shotSeconds(args: Record<string, unknown>): number {
  if (args.seconds === undefined || args.seconds === "") return SCREENSHOT_SECONDS;
  const seconds = Number(args.seconds);
  if (!Number.isFinite(seconds) || seconds < MIN_SHOT_SECONDS || seconds > MAX_PLAY_SECONDS)
    throw new Error(MESSAGE.BadShotSeconds);
  return seconds;
}

/** How many frames of a recording a screenshot adds: 2 to {@link HOOK_RECORDING_MAX}, else none. */
function recordingCount(args: Record<string, unknown>): number {
  const asked = Number(args.frames);
  return Number.isInteger(asked) && asked >= 2 ? Math.min(asked, HOOK_RECORDING_MAX) : 0;
}

/** Why a capture saved nothing: Godot's own errors when it printed any, else where to look. */
function noStills(output: string): string {
  const errors = readProblems(output).filter(isError);
  return errors.length ? MESSAGE.NoStillsBecause(problemLines(errors.slice(0, NOTED_PROBLEMS))) : MESSAGE.NoStills;
}

/** The agent's `screenshot`: stills at a moment of play (after keys, when asked), and a recording up to it; the model sees them. */
async function screenshot(deps: GodotBackendDeps, args: Record<string, unknown>, context: PluginContext) {
  const project = await requireProject(context);
  const seconds = shotSeconds(args);
  const keys = readKeys(textArg(args, "keys"));
  const scene = await projectScene(project, textArg(args, "scene"));
  const install = await requireGodot(deps, context);
  const storage = await storageOf(context);
  const job = jobOf(context, project);
  await deps.run(install.binary, importCall(project), job);
  const count = recordingCount(args);
  const request = {
    scene,
    at: frameAt(seconds),
    recording: count ? recordingShots(seconds, count) : [],
    keys,
    most: stillCount(args),
    hero: false,
  };
  const taken = await takeStills({ ...deps, storage }, install, project, request, job);
  if (taken.stills.length === 0) throw new Error(noStills(taken.output));
  return stillsForAgent(taken);
}

/**
 * `hero-shots`: the main scene's stills a few seconds into play (or at the moment and after the keys
 * the game names itself), as pictures. At a checkpoint only a run's save point takes them (a chat's
 * checkpoint keeps none); as the viewport observer they come with a short recording and must land
 * within the time Genex gives; a plain call answers them as the agent's screenshot does. Nothing when
 * the game has no project or this computer no Godot.
 */
async function heroShots(deps: GodotBackendDeps, context: PluginContext): Promise<unknown> {
  if (context.hook && (context.hook.on !== HookEvent.CheckpointAfter || !context.hook.runId)) return {};
  const project = await projectOf(context);
  const install = usableGodot(await godots(deps, context));
  if (!project || !install) return {};
  const taken = takeHeroShots(deps, context, install, project);
  // A save point's or the observer's pictures are never a reason to fail it, as a checkpoint's check isn't.
  if (context.hook || context.observe)
    return taken.then((shots) => stillsAnswer(shots, Boolean(context.observe))).catch(() => ({}));
  return stillsForAgent(await taken);
}

/** The main scene's hero stills, after an import, and a short recording unless a moment asks. */
async function takeHeroShots(deps: GodotBackendDeps, context: PluginContext, install: GodotInstall, project: string) {
  const signal = context.observe ? observeSignal(context.signal, context.observe.withinMs) : context.signal;
  const job = jobOf(context, project, signal);
  const storage = await storageOf(context);
  // A fresh project's assets are imported first, or its stills would show them missing.
  await deps.run(install.binary, importCall(project), job);
  const recording = context.hook ? [] : recordingShots(HERO_RECORDING_SECONDS, HERO_RECORDING_FRAMES);
  const request = { scene: "", at: frameAt(HERO_SECONDS), recording, keys: [], most: MAX_STILLS, hero: true };
  return takeStills({ ...deps, storage }, install, project, request, job);
}

/** An observer's call ends with the turn or once the time Genex gives it, less what keeping the pictures takes, runs out. */
function observeSignal(turn: AbortSignal, withinMs: number | undefined): AbortSignal {
  const left = Math.max(MIN_OBSERVE_MS, (withinMs ?? OBSERVE_CALL_MS) - OBSERVE_MARGIN_MS);
  return AbortSignal.any([turn, AbortSignal.timeout(left)]);
}

/** The agent's `class-reference`: the installed Godot's API for a class, or the names that hold a word. */
function classReference(deps: GodotBackendDeps): Handler {
  const reference = createReference(deps.run);
  return async (args, context) => {
    const install = await requireGodot(deps, context);
    const job = jobOf(context, await projectOf(context));
    const index = await reference(install, await storageOf(context), job);
    return answerQuery(index, textArg(args, "query"), versionName(install.version));
  };
}

/**
 * The projects the panel offers under Change project: the person's Godot projects (`find-projects.ts`)
 * and the game's own, each once, with whether the game uses it now and whether it lies outside the
 * game's folder (Rewind and Loops can't reach it there).
 */
async function chooserProjects(deps: GodotBackendDeps, context: PluginContext, project: string | null) {
  const found = await findProjects(deps.env.home, deps.env.dataHome);
  const own = project && !found.some((p) => p.folder === project) ? await readProject(project) : undefined;
  const game = gameFolderOf(context);
  const offered = await Promise.all(
    [...(own ? [own] : []), ...found].map(async (p) => ({
      ...p,
      shown: shownPath(p.folder, deps.env.home),
      inUse: p.folder === project,
      outside: game ? await outsideGame(game, p.folder) : false,
    })),
  );
  // Windows offers only projects inside the game (`useProject`), and the one in use wherever it is.
  return deps.env.platform === "win32" ? offered.filter((p) => !p.outside || p.inUse) : offered;
}

/** A folder as the panel shows it: from `~` when it is in the home folder, else as it is. */
const shownPath = (folder: string, home: string) =>
  folder.startsWith(`${home}${path.sep}`) ? `~${folder.slice(home.length)}` : folder;

/** How the panel shows a project's place: inside the game its folder there (`godot/`), outside it from `~`. */
const placeShown = (place: { path: string; outside: boolean }, home: string) =>
  place.outside ? shownPath(place.path, home) : `${place.path}/`;

/** The game's project as the panel names it: its folder inside the game ("." at the root), or its absolute folder outside. */
async function projectPlace(context: PluginContext, project: string): Promise<{ path: string; outside: boolean }> {
  const game = gameFolderOf(context);
  if (!game || (await outsideGame(game, project))) return { path: project, outside: Boolean(game) };
  return { path: path.relative(await realpath(game).catch(() => game), project) || ".", outside: false };
}

/** The Colyseus GDExtension into the project from the release kept in the plugin's storage; why it couldn't be, or null. */
async function addNative(deps: GodotBackendDeps, context: PluginContext, project: string): Promise<string | null> {
  try {
    const fetching = deps.install ?? systemInstallDeps(deps.env);
    const storage = await storageOf(context);
    const { release: pinned } = deps.multiplayer;
    const release = await colyseusRelease(fetching, storage, context.signal, pinned, deps.env.platform);
    await installColyseus(project, release, deps.multiplayer.license);
    return null;
  } catch (error) {
    return MESSAGE.Multiplayer.NoNative(errorMessage(error));
  }
}

/**
 * The agent's `multiplayer`: Genex multiplayer into the game's Godot project (the addon, its
 * autoload, the game's Genex project), the native GDExtension, the game's matchmaking in its
 * genex.json and Genex's Web preset loading the SDK bridge. Arguments are checked before anything
 * is written; a native part that couldn't be added is a note, never a refusal.
 */
async function setUpMultiplayer(deps: GodotBackendDeps, args: Record<string, unknown>, context: PluginContext) {
  const game = gameFolderOf(context);
  if (!game) throw new Error(MESSAGE.NoGameOpen);
  const project = await requireProject(context);
  const slug = slugArg(args.slug);
  const matchmaking = matchmakingArg(args.matchmaking);
  const kept = await installMultiplayer(project, deps.multiplayer.addon, slug ? { slug } : {});
  if (matchmaking) await writeMatchmaking(game, matchmaking);
  await addWebPreset(project, MESSAGE.Web.Link, { multiplayer: true });
  const notes = [await addNative(deps, context, project)];
  if (kept.length) notes.push(`Kept your changed ${kept.join(", ")} beside the new ones as .mine.`);
  const install = usableGodot(await godots(deps, context));
  // The extension and the addon's classes register in Godot's import.
  if (install) notes.push(await firstImport(deps, install, project, jobOf(context, project)));
  const state = await multiplayerState(project, deps.multiplayer.addon);
  return MESSAGE.Multiplayer.Done(
    state,
    notes.filter((note): note is string => Boolean(note)),
  );
}

/**
 * The panel's status: the Godot Genex uses, every Godot found, Genex's install of Godot under way,
 * the open game's project and the projects to choose from.
 */
async function status(deps: GodotBackendDeps, setup: Setup, context: PluginContext) {
  const installs = await godots(deps, context);
  const install = usableGodot(installs);
  const project = await projectOf(context);
  const place = project ? await projectPlace(context, project) : null;
  return {
    ...godotReadiness(installs),
    /** Whether this computer is a Mac, or a Windows PC, where Get Godot is Genex's own download (`download-godot`); Genex builds Godot games on no other. */
    mac: deps.env.platform === "darwin",
    windows: deps.env.platform === "win32",
    installing: await setup.job(context),
    godot: install
      ? { version: versionName(install.version), binary: install.binary, mono: install.version.mono }
      : null,
    installs: installs.map((i) => ({ version: i.version.text, binary: i.binary, supported: i.supported })),
    game: Boolean(gameFolderOf(context)),
    project: place?.path ?? null,
    projectShown: place ? placeShown(place, deps.env.home) : null,
    webTemplates: install ? await hasWebTemplate(deps.env.dataHome, install) : false,
    projectName: project ? ((await readProject(project))?.name ?? path.basename(project)) : null,
    outside: place?.outside ?? false,
    editorOpen: project ? await editorOpen(deps.editor, project) : false,
    setup: project && context.directory ? await addonState(context.directory, project, deps.addon) : null,
    projects: await chooserProjects(deps, context, project),
  };
}

/** The panel's Use this project: links the open game to the chosen Godot project, wherever it is. */
async function useProject(deps: GodotBackendDeps, args: Record<string, unknown>, context: PluginContext) {
  const game = gameFolderOf(context);
  if (!game) throw new Error(MESSAGE.NoGameForPanel());
  const folder = textArg(args, "folder");
  // Windows's sandbox writes only inside the game's folder, so a project there is the only one Genex can build.
  if (deps.env.platform === "win32" && (await outsideGame(game, folder))) throw new Error(MESSAGE.OutsideOnWindows());
  return { linked: await linkProject(context, folder) };
}

/**
 * The panel's and the agent's Set up: the game's existing Godot project made Genex's play target
 * (the addon, its autoload, the launcher, studio.json's runtime), after the person confirms.
 */
async function setUp(deps: GodotBackendDeps, context: PluginContext) {
  const game = gameFolderOf(context);
  if (!game) throw new Error(MESSAGE.NoGameOpen);
  const project = await requireProject(context);
  const install = usableGodot(await godots(deps, context));
  // A project outside the game is set up only as the one it is linked to (`projectOf` found it so).
  const linked = await outsideGame(game, project);
  const kept = await setUpGame(game, project, deps.addon, install?.binary ?? null, { linked });
  if (install) await firstImport(deps, install, project, jobOf(context, project));
  return { setup: await addonState(game, project, deps.addon), kept };
}

/** What Set up will change, for the person to confirm. */
async function describeSetUp(context: PluginContext): Promise<PluginReview> {
  const game = gameFolderOf(context);
  const project = game ? await projectOf(context) : null;
  if (!game || !project) return {};
  const where = (await projectPlace(context, project)).path;
  return { message: MESSAGE.SetUpQuestion(), detail: MESSAGE.SetUpDetail(where) };
}

/** The folder in the plugin's storage where a game whose chat chose Godot before it could be made is remembered. */
const WANTS_FOLDER = "wants";
/** A game id as it names a file: a plain folder name, never a path. */
const GAME_ID = /^[a-zA-Z0-9_-]{1,100}$/;

/** The calling game's want record, or undefined outside a game (or for a name that isn't plain). */
async function wantFile(context: PluginContext): Promise<string | undefined> {
  if (!context.project || !GAME_ID.test(context.project)) return undefined;
  return path.join(await storageOf(context), WANTS_FOLDER, `${context.project}.json`);
}

/** Remembers that the calling game's chat chose Godot before it could be made here; written once. */
async function rememberWant(context: PluginContext): Promise<void> {
  const file = await wantFile(context);
  if (!file || (await stat(file).catch(() => null))) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileNoFollow(file, `${JSON.stringify({ at: new Date().toISOString() })}\n`);
}

/** Whether the calling game's chat chose Godot before it could be made (its strip shows the Godot button). */
async function wantsGodot(context: PluginContext): Promise<boolean> {
  const file = await wantFile(context);
  return file ? (await stat(file).catch(() => null))?.isFile() === true : false;
}

/**
 * The Godot toolbar button's status, `shown` on a game whose chat chose Godot before its project
 * could be made (the button is scoped to Godot projects): see {@link buttonStatus}.
 */
async function toolbarStatus(deps: GodotBackendDeps, context: PluginContext) {
  const [status, wanted] = await Promise.all([buttonStatus(deps, context), wantsGodot(context)]);
  return wanted ? { ...status, shown: true } : status;
}

/** The toolbar button's word: get Godot, too old, or its version and whether it has this game open. */
async function buttonStatus(deps: GodotBackendDeps, context: PluginContext) {
  const installs = await godots(deps, context);
  const install = usableGodot(installs);
  if (!install) {
    const older = installs[0];
    const title = older ? MESSAGE.Toolbar.Old(versionName(older.version)) : MESSAGE.Toolbar.Get();
    return { badge: MESSAGE.Toolbar.GetBadge(), tone: "info", dot: true, title };
  }
  const version = versionName(install.version);
  const game = gameFolderOf(context);
  const project = game ? await projectOf(context) : null;
  if (game && project && !isSetUp(await addonState(game, project, deps.addon)))
    return { badge: MESSAGE.Toolbar.SetUpBadge(), tone: "warn", title: MESSAGE.Toolbar.SetUp() };
  const open = project ? await editorOpen(deps.editor, project) : false;
  return open ? { tone: "ok", title: MESSAGE.Toolbar.Open(version) } : { title: MESSAGE.Toolbar.Ready(version) };
}

/**
 * Live's card for this game: where it stands in Godot, and its one step (get Godot, set the project
 * up for Genex's play, or open it in the person's Godot).
 */
async function stageStatus(deps: GodotBackendDeps, context: PluginContext) {
  const installs = await godots(deps, context);
  const install = usableGodot(installs);
  const older = installs[0];
  if (!install && older) return { line: MESSAGE.Stage.Old(versionName(older.version)), button: getButton() };
  if (!install) return { line: MESSAGE.Stage.Get(), button: getButton() };
  const game = gameFolderOf(context);
  const project = game ? await projectOf(context) : null;
  if (!game || !project) return { line: MESSAGE.Stage.NoProject() };
  if (!isSetUp(await addonState(game, project, deps.addon)))
    return {
      line: MESSAGE.Stage.NotSetUp(),
      button: { label: MESSAGE.Stage.SetUpButton(), action: GodotAction.SetUp },
    };
  const version = versionName(install.version);
  if (await editorOpen(deps.editor, project))
    return { line: MESSAGE.Stage.Open(version), hint: MESSAGE.Stage.OpenHint() };
  return {
    line: MESSAGE.Stage.Ready(version),
    button: { label: MESSAGE.Stage.OpenButton(), action: GodotAction.OpenEditor },
  };
}

/** The card's Get Godot: the plugin's own panel, where the download and the choice of an install are. */
const getButton = () => ({ label: MESSAGE.Stage.GetButton(), panel: true });

/** The panel's Create: the open game's project, or a new Genex game for it when none is open. */
async function create(deps: GodotBackendDeps, args: Record<string, unknown>, context: PluginContext) {
  const install = await requireGodot(deps, context);
  const name = textArg(args, "name");
  const request = { template: textArg(args, "template") || GodotTemplate.ThreeD, name };
  const made = gameFolderOf(context) ? null : await context.host(HostService.GameCreate, { title: name });
  const game = gameFolderOf(context) ?? made?.directory;
  if (!game) throw new Error(MESSAGE.NoGameForPanel());
  const project = await createProject(game, request, deps.templates);
  await setUpGame(game, project, deps.addon, install.binary);
  const note = await firstImport(deps, install, project, { ...jobOf(context, project), game });
  return { project, game: made ? { project: made.project } : null, ...(note ? { note } : {}) };
}

/** The panel's Open in Godot: the open game's project in the person's own editor. */
async function openInEditor(deps: GodotBackendDeps, context: PluginContext) {
  const project = await requireProject(context);
  await deps.editor.open(openEditorLaunch(await requireGodot(deps, context), project));
  return { opened: project };
}

/** Where a game's Don't use Godot is kept: one empty file per game, in the plugin's storage. */
async function skipFile(context: PluginContext): Promise<string> {
  if (!context.project) throw new Error(MESSAGE.NoGameOpen);
  return path.join(await storageOf(context), SKIPPED_FOLDER, encodeURIComponent(context.project));
}

/** How Do it for me installs Godot here: Genex's own install on a Mac, the host's pinned download on Windows. */
type Setup = {
  job(context: PluginContext): Promise<GodotJob | null>;
  install(context: PluginContext): Promise<void>;
  stop(context: PluginContext): Promise<void>;
};

/** A Mac's: the installer that copies Godot into Applications. */
const macSetup = (installer: GodotInstaller): Setup => ({
  job: async () => installer.job(),
  install: async () => installer.install(),
  stop: () => installer.stop(),
});

/**
 * Windows's: the host's install of the pinned Godot (`download-godot`, which the person confirmed),
 * awaited to its end, its record the card's progress; a failure is on that record, never thrown here.
 */
const windowsSetup = (deps: GodotBackendDeps, fetching: TemplateFetches): Setup => ({
  job: async (context) =>
    windowsJob(await context.host(HostService.RuntimeInstallation, GODOT_RUNTIME).catch(() => null)),
  install: async (context) => {
    await context.host(HostService.RuntimeInstall, GODOT_RUNTIME).catch(() => undefined);
    // With Godot, its Web template, so the game plays in Live and publishes without a trip to Godot's editor.
    const installed = usableGodot(await godots(deps, context));
    if (!installed) return;
    const stop = new AbortController();
    fetching.add(stop);
    try {
      const signal = AbortSignal.any([context.signal, stop.signal]);
      await ensureTemplates(deps, installed, [ExportTemplate.Web], signal).catch(() => undefined);
    } finally {
      fetching.delete(stop);
    }
  },
  stop: async (context) => {
    for (const fetch of fetching) fetch.abort();
    await context.host(HostService.RuntimeCancelInstall, GODOT_RUNTIME).catch(() => undefined);
  },
});

/** The Web template fetches Windows's Do it for me has under way, which its Stop stops too. */
type TemplateFetches = Set<AbortController>;

/** Godot's setup card for this computer now, the install under way, and the game's Don't use Godot. */
async function setupSteps(deps: GodotBackendDeps, setup: Setup, context: PluginContext) {
  const install = usableGodot(await godots(deps, context));
  const skipped = await stat(await skipFile(context)).then(
    () => true,
    () => false,
  );
  return godotSetupCard(install, await setup.job(context), skipped, deps.env.platform);
}

/** The agent's `show-steps`: Godot's setup card in the game's chat while Godot is missing; it takes back Don't use Godot. */
async function showSteps(deps: GodotBackendDeps, setup: Setup, context: PluginContext): Promise<string> {
  await rm(await skipFile(context), { force: true });
  if (!(await setupSteps(deps, setup, context)).open) return MESSAGE.StepsDone;
  return (await context.host(HostService.EngineSteps)) ? MESSAGE.StepsShown : MESSAGE.StepsNoChat;
}

/** Don't use Godot: stops an install under way and closes the card for this game, which tells the agent. */
async function skip(setup: Setup, context: PluginContext): Promise<void> {
  const file = await skipFile(context);
  await setup.stop(context);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileNoFollow(file, "");
}

/** This Mac's own network and programs for installing Godot into its Applications. */
function systemInstallDeps(env: GodotEnv): GodotInstallDeps {
  return {
    fetch: globalThis.fetch,
    applications: env.applications,
    trash: path.join(env.home, ".Trash"),
    run: async (command, args, timeoutMs, signal) => {
      const options = { timeout: timeoutMs, maxBuffer: RUN_OUTPUT_MAX_BYTES, signal };
      const done = await execFileAsync(command, args, options);
      return { out: done.stdout, err: done.stderr };
    },
  };
}

/** The backend with the computer, runner and editor it is given; tests hand in fakes. */
export function createGodotBackend(deps: GodotBackendDeps): PluginActivation {
  let installing: GodotInstaller | undefined;
  let storageRoot = "";
  const windows = deps.env.platform === "win32";
  const fetching: TemplateFetches = new Set();
  // The install goes on across calls; every call names the same plugin storage.
  const setupOf = async (context: PluginContext): Promise<Setup> => {
    if (windows) return windowsSetup(deps, fetching);
    storageRoot = await storageOf(context);
    installing ??= createGodotInstaller(deps.install ?? systemInstallDeps(deps.env), async () => storageRoot);
    return macSetup(installing);
  };
  // Each computer's Do it for me is its own action: Windows's download is confirmed by the person first.
  const doItForMe =
    (own: boolean, refusal: () => string): Handler =>
    async (_args, context) => {
      if (!own) throw new Error(refusal());
      await (await setupOf(context)).install(context);
    };
  const actions: Record<GodotAction, Handler> = {
    [GodotAction.Steps]: async (_args, context) => setupSteps(deps, await setupOf(context), context),
    [GodotAction.InstallGodot]: doItForMe(!windows, MESSAGE.Setup.DownloadOnWindows),
    [GodotAction.DownloadGodot]: doItForMe(windows, MESSAGE.Setup.DownloadIsWindows),
    [GodotAction.StopInstall]: async (_args, context) => (await setupOf(context)).stop(context),
    [GodotAction.Skip]: async (_args, context) => skip(await setupOf(context), context),
    [GodotAction.Status]: async (_args, context) => status(deps, await setupOf(context), context),
    [GodotAction.Create]: (args, context) => create(deps, args, context),
    [GodotAction.OpenEditor]: (_args, context) => openInEditor(deps, context),
    [GodotAction.GetGodot]: async () => {
      if (windows) throw new Error(MESSAGE.Setup.DownloadOnWindows());
      await deps.editor.open(getGodotLaunch());
      return { opened: true };
    },
    [GodotAction.ToolbarStatus]: (_args, context) => toolbarStatus(deps, context),
    [GodotAction.StageStatus]: (_args, context) => stageStatus(deps, context),
    [GodotAction.SetUp]: (_args, context) => setUp(deps, context),
    [GodotAction.UseProject]: (args, context) => useProject(deps, args, context),
    [GodotAction.WebExport]: async (_args, context) => {
      await webExport(deps, context);
      return { note: MESSAGE.Web.Exported() };
    },
  };
  const tools: Record<GodotTool, Handler> = {
    [GodotTool.NewGame]: (args, context) => newGame(deps, args, context),
    [GodotTool.Check]: (_args, context) => check(deps, context),
    [GodotTool.RunScene]: (args, context) => runScene(deps, args, context),
    [GodotTool.Screenshot]: (args, context) => screenshot(deps, args, context),
    [GodotTool.ClassReference]: classReference(deps),
    [GodotTool.EngineStatus]: (_args, context) => engineStatus(deps, context),
    [GodotTool.CheckpointCheck]: (_args, context) => checkAtMoment(deps, context),
    [GodotTool.WebExport]: async (_args, context) => MESSAGE.Web.Done(await webExport(deps, context)),
    [GodotTool.SaveAll]: (_args, context) => saveAll(deps, context),
    [GodotTool.KeepWebBuild]: (_args, context) => keepWebBuild(deps, context),
    [GodotTool.ReloadEditor]: (_args, context) => reloadEditor(deps, context),
    [GodotTool.HeroShots]: (_args, context) => heroShots(deps, context),
    [GodotTool.SetUp]: async (_args, context) => {
      await setUp(deps, context);
      return MESSAGE.SetUpDone;
    },
    [GodotTool.ShowSteps]: async (_args, context) => showSteps(deps, await setupOf(context), context),
    [GodotTool.Multiplayer]: (args, context) => setUpMultiplayer(deps, args, context),
    [GodotTool.ExportTemplates]: (args, context) => exportTemplates(deps, args, context),
  };
  return {
    async action(name, args, context) {
      if (!isGodotAction(name)) throw new Error(MESSAGE.UnknownAction(name));
      return actions[name](args, context);
    },
    async tool(name, args, context) {
      if (!isGodotTool(name)) throw new Error(MESSAGE.UnknownTool(name));
      return tools[name](args, context);
    },
    async review(name, _args, context): Promise<PluginReview> {
      return name === GodotAction.SetUp ? describeSetUp(context) : {};
    },
  };
}

export const activate: Activate = () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return createGodotBackend({
    env: systemGodotEnv(),
    editor: systemEditorEnv(),
    run: confinedRunner(),
    scripts: path.join(here, SCRIPTS_FOLDER),
    templates: path.join(here, TEMPLATES_FOLDER),
    addon: path.join(here, ...ADDON_SOURCE),
    multiplayer: {
      addon: path.join(here, ...MULTIPLAYER_ADDON_SOURCE),
      bridge: path.join(here, MULTIPLAYER_FOLDER, BRIDGE_PAGE_FILE),
      bridgeLicenses: path.join(here, MULTIPLAYER_FOLDER, BRIDGE_LICENSES_FILE),
      license: path.join(here, MULTIPLAYER_FOLDER, COLYSEUS_LICENSE_FILE),
    },
  });
};
