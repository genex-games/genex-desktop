/**
 * Opening a game's Unity project for use: nothing when an editor already has it open, else the
 * editor of exactly the version the project was saved with, then a wait until its Pipeline server
 * says it is ready, and the editor kept ticking behind other windows from then on. Whether an
 * editor has the project open is read from the computer's processes, so the lock file and the
 * descriptor a killed editor left behind never stand in the way of opening it again, and the scene
 * backups it left are moved aside first, so the new editor opens without asking to recover them.
 */
import { errorMessage } from "../../shared/errors.ts";
import { EditorWait, type Opener, openProjectLaunch, waitForEditor } from "./editor-launch.ts";
import { type EditorDeps, editorRuns, type KeepPlace, keepTicking, setAsideBackups } from "./editor-life.ts";
import { type EditorsEnv, findEditors } from "./editors.ts";
import { editorStatus, PipelineProblem, serverStatus } from "./pipeline.ts";
import type { UnityProject } from "./project-folder.ts";

/** How opening a project for use ended. */
export const Opened = {
  /** An editor already has it open and its server answers. */
  Answers: "answers",
  /** An editor has it open, with no server answering: it is starting, or the project has no Pipeline package loaded. */
  SeemsOpen: "seems-open",
  /** Genex opened it and the editor answers. */
  Ready: "ready",
  /** Genex opened it and the editor is not ready within the wait. */
  NotYet: "not-yet",
  /** The Unity it was saved with is not installed. */
  NoEditor: "no-editor",
  /** The opener failed. */
  Failed: "failed",
} as const;
export type Opened = (typeof Opened)[keyof typeof Opened];

/**
 * An opening's end, with the Unity it used or lacked, why an opener failed, and where the scene
 * backups a killed editor left were moved before Unity was opened.
 */
export type Opening = { opened: Opened; version: string; installed?: string[]; why?: string; setAside?: string };

/** What opening takes besides reaching the editor: the installed editors and the opener. */
export interface OpenDeps extends EditorDeps {
  editors: EditorsEnv;
  open: Opener;
}

/** What a project's editor version reads as when its version file names none. */
export const UNKNOWN_VERSION = "an unknown version";

/** Whether an opening launched an editor that now runs, ready or not. */
export const launched = (opening: Opening): boolean =>
  opening.opened === Opened.Ready || opening.opened === Opened.NotYet;

/** Whether the project's editor is there for use after an opening: it answers. */
export const usable = (opening: Opening): boolean =>
  opening.opened === Opened.Ready || opening.opened === Opened.Answers;

/** Whether an editor's server is there for `root`, ready or not: it answers, or says it is busy. */
async function editorAnswers(root: string, deps: OpenDeps, signal?: AbortSignal): Promise<boolean> {
  const status = await serverStatus(root, deps.pipeline, signal);
  return status.ok || status.problem === PipelineProblem.Busy;
}

/** Keeps an answering editor ticking, unless its main thread is stalled: a command would only queue behind what holds it. */
async function tickIfAwake(root: string, deps: OpenDeps, signal?: AbortSignal): Promise<void> {
  if ((await editorStatus(root, deps.pipeline, { signal })).ok) await keepTicking(root, deps, signal);
}

/**
 * Opens a project in the editor of its own version unless one already has it open, then waits up
 * to `waitMs` for that editor to answer.
 */
export async function openProject(
  deps: OpenDeps,
  project: UnityProject,
  options: { signal?: AbortSignal; waitMs?: number; keep?: KeepPlace } = {},
): Promise<Opening> {
  const { root } = project;
  const version = project.editorVersion ?? UNKNOWN_VERSION;
  if (await editorAnswers(root, deps, options.signal)) {
    await tickIfAwake(root, deps, options.signal);
    return { opened: Opened.Answers, version };
  }
  if (await editorRuns(root, deps)) return { opened: Opened.SeemsOpen, version };
  const editors = await findEditors(deps.editors);
  const editor = editors.find((installed) => installed.version === project.editorVersion);
  if (!editor) return { opened: Opened.NoEditor, version, installed: editors.map((installed) => installed.version) };
  // No editor has the project open: what a killed one left would make this one ask to recover it.
  const kept = options.keep ? await setAsideBackups(root, options.keep).catch(() => undefined) : undefined;
  const setAside = kept ? { setAside: kept } : {};
  try {
    await deps.open(openProjectLaunch(editor, root, deps.editors.platform));
  } catch (error) {
    return { opened: Opened.Failed, version, why: errorMessage(error), ...setAside };
  }
  const waited = await waitForEditor(root, deps.pipeline, options);
  if (waited !== EditorWait.Ready) return { opened: Opened.NotYet, version, ...setAside };
  await tickIfAwake(root, deps, options.signal);
  return { opened: Opened.Ready, version, ...setAside };
}
