/**
 * Where a game's Unity stands, as the plugin's panel shows it and its toolbar button says it in a
 * word. It only looks: which editors are installed, whether the game's folder holds a project and
 * that project asks for Unity's Pipeline package, whether an editor has it open, and one look at
 * that editor's main thread. Nothing is opened, saved or signalled here, so Genex may ask as often
 * as its toolbar does.
 */
import type { PluginToolbarStatus } from "../../plugin-sdk/index.d.ts";
import { t, tc } from "../../shared/i18n.ts";
import { editorRuns } from "./editor-life.ts";
import { type OpenDeps, UNKNOWN_VERSION } from "./editor-open.ts";
import { findEditors, isUnity6 } from "./editors.ts";
import { editorStatus, PipelineProblem, PLAY_STOPPED } from "./pipeline.ts";
import { folderInGame, type UnityProject } from "./project-folder.ts";
import { newestUnity6 } from "./readiness.ts";
import { pipelineVersionOf } from "./setup.ts";
import { termsAccepted } from "./software-terms.ts";

/** Where a game's Unity stands, one step at a time. Wire values the panel reads: never rename one. */
export const PanelStep = {
  /** No Unity 6 is installed, and there is no project to open either. */
  GetUnity: "get-unity",
  NoGame: "no-game",
  /** The open game's folder holds no Unity project. */
  NoProject: "no-project",
  /** The project was saved with a Unity older than 6, which Unity's Pipeline package does not run in. */
  OldProject: "old-project",
  /** The project does not ask for Unity's Pipeline package yet. */
  NotSetUp: "not-set-up",
  /** The Unity the project was saved with is not installed. */
  NoEditor: "no-editor",
  NotOpen: "not-open",
  /** An editor has the project open and does not answer yet. */
  Opening: "opening",
  Ready: "ready",
  /** The editor's server is there and its main thread runs nothing, as behind a dialog. */
  Stalled: "stalled",
  /** An editor has the project open, does not answer, and this Mac's Unity never had its Software Terms accepted. */
  Terms: "terms",
} as const;
export type PanelStep = (typeof PanelStep)[keyof typeof PanelStep];

/** What the panel shows: the step, the game's project and its Unity, and what a ready editor is doing. */
export interface PanelStatus {
  step: PanelStep;
  /** The project's folder as the game names it. */
  folder?: string;
  /** The Unity the project was saved with. */
  version?: string;
  /** The Unity versions installed here, newest first. */
  installed: string[];
  /** A ready editor plays the game. */
  playing?: boolean;
  /** A ready editor compiles or reloads scripts. */
  compiling?: boolean;
}

/** The open game as a status takes it: whether there is one, and the Unity project its folder holds. */
export interface PanelGame {
  open: boolean;
  project?: UnityProject;
}

type Step = Pick<PanelStatus, "step" | "playing" | "compiling">;

/**
 * What an open editor's main thread says: ready with what it is doing, stalled, or not answering
 * yet. One that does not answer while the terms were never accepted waits behind their window.
 */
async function openStep(root: string, deps: OpenDeps, signal?: AbortSignal): Promise<Step> {
  const look = await editorStatus(root, deps.pipeline, { signal });
  if (!look.ok) {
    if (look.problem === PipelineProblem.Stalled) return { step: PanelStep.Stalled };
    return { step: (await termsAccepted(deps.editors)) === false ? PanelStep.Terms : PanelStep.Opening };
  }
  const { playMode, compiling, reloading } = look.result;
  return {
    step: PanelStep.Ready,
    playing: playMode !== "" && playMode !== PLAY_STOPPED,
    compiling: compiling || reloading,
  };
}

/** Where a game's project stands: its setup first, then the editor that has it open, then the Unity to open it with. */
async function projectStep(
  deps: OpenDeps,
  project: UnityProject,
  installed: readonly string[],
  signal?: AbortSignal,
): Promise<Step> {
  const setUp = await pipelineVersionOf(project.root).catch(() => undefined);
  if (!setUp) return { step: isUnity6(project.editorVersion) ? PanelStep.NotSetUp : PanelStep.OldProject };
  if (await editorRuns(project.root, deps)) return openStep(project.root, deps, signal);
  const hasOwn = project.editorVersion !== undefined && installed.includes(project.editorVersion);
  return { step: hasOwn ? PanelStep.NotOpen : PanelStep.NoEditor };
}

/** Where `game`'s Unity stands now. */
export async function panelStatus(deps: OpenDeps, game: PanelGame, signal?: AbortSignal): Promise<PanelStatus> {
  const editors = await findEditors(deps.editors);
  const installed = editors.map((editor) => editor.version);
  const { project } = game;
  if (!project) {
    if (!newestUnity6(editors)) return { step: PanelStep.GetUnity, installed };
    return { step: game.open ? PanelStep.NoProject : PanelStep.NoGame, installed };
  }
  const version = project.editorVersion ? { version: project.editorVersion } : {};
  return {
    ...(await projectStep(deps, project, installed, signal)),
    folder: folderInGame(project),
    ...version,
    installed,
  };
}

/** The quiet tone of a word that asks for nothing. */
const MUTED = "info" as const satisfies PluginToolbarStatus["tone"];

/**
 * The toolbar button's word and tooltip at each step, drawn as a dot (green once Ready, amber while
 * Starting) whose word only screen readers hear; Stalled and Waiting for you stay words, as they ask
 * for the person.
 * The button shows only on a game with a Unity project, so the steps before one never reach it;
 * the plugin page's Editor row reads the same word.
 */
const WORD: Record<PanelStep, (version: string) => PluginToolbarStatus> = {
  [PanelStep.GetUnity]: () => ({
    badge: t("Not installed"),
    tone: MUTED,
    dot: true,
    title: t("Unity 6 isn't installed: see how to get it"),
  }),
  [PanelStep.NoGame]: () => ({ tone: MUTED, title: t("Open a game to use Unity") }),
  [PanelStep.NoProject]: () => ({ tone: MUTED, title: t("This game has no Unity project") }),
  [PanelStep.OldProject]: (version) => ({
    badge: t("Not set up"),
    tone: MUTED,
    dot: true,
    title: t("This project was saved with Unity {version}: Genex works with Unity 6 or later", { version }),
  }),
  [PanelStep.NotSetUp]: () => ({
    badge: t("Not set up"),
    tone: MUTED,
    dot: true,
    title: t("Set up this game's Unity project"),
  }),
  [PanelStep.NoEditor]: (version) => ({
    badge: t("Not open"),
    tone: MUTED,
    dot: true,
    title: t("Unity {version} isn't installed: this project was saved with it", { version }),
  }),
  [PanelStep.NotOpen]: () => ({ badge: t("Not open"), tone: MUTED, dot: true, title: t("Unity isn't open") }),
  [PanelStep.Opening]: () => ({ badge: t("Starting"), tone: "warn", dot: true, title: t("Unity is starting") }),
  [PanelStep.Ready]: () => ({ badge: t("Ready"), tone: "ok", dot: true, title: t("Unity is open and answers") }),
  [PanelStep.Stalled]: () => ({
    badge: t("Stalled"),
    tone: "warn",
    attention: true,
    title: t("Unity isn't answering: a dialog may be waiting in it"),
  }),
  [PanelStep.Terms]: () => ({
    badge: tc("editor", "Waiting for you"),
    tone: "warn",
    attention: true,
    title: t("Unity is waiting for you to accept its Software Terms in its window"),
  }),
};

/** The toolbar button's status for where a game's Unity stands. */
export const toolbarStatusOf = (status: PanelStatus): PluginToolbarStatus =>
  WORD[status.step](status.version ?? UNKNOWN_VERSION);
