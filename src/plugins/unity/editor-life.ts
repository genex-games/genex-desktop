/**
 * The life of a game's Unity editor as Genex drives it: whether one has the project open, getting
 * it ready after it opens, saving its work, and ending it.
 *
 * An editor has a project open when a Unity process names it on its command line, or the Pipeline
 * descriptor in the project names a process the computer lists as a Unity editor of this project or
 * of none (`processes.ts`): a stale descriptor's id may belong to another app by now, which is
 * neither counted nor signalled. Unity's lock file is no sign: a killed editor leaves it behind.
 *
 * Saving never asks Unity to save a scene that has no name: Unity would ask for one in a system
 * save panel, which stalls the editor until a person answers and which Pipeline itself does not
 * see. Each named scene with unsaved work is saved by its own path instead, then the project's
 * assets and settings.
 *
 * Ending is a clean exit through the editor itself when its main thread answers (no "save
 * changes?" prompt: the caller saved first, or asks the ending to save, its play stopped), and a
 * signal to that project's own processes when it does not, as for an editor stalled behind a dialog. An editor ended that way, or one that
 * crashed, leaves its scene backups in the project, and the next Unity to open it asks whether to
 * recover them: they are moved into the plugin's storage before Genex opens the project again.
 */
import { cp, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import { isJsonObject } from "../../substrate/fsx.ts";
import { containedReal } from "../../substrate/paths.ts";
import {
  editorStatus,
  type EditorStatus,
  type PipelineAnswer,
  type PipelineDeps,
  PipelineProblem,
  PLAY_STOPPED,
  readDescriptor,
  runCommand,
} from "./pipeline.ts";
import { endEditors, type ProcessEnv, projectPids } from "./processes.ts";

/** How long an editor asked to exit cleanly is given before its processes are signalled. */
const CLEAN_EXIT_MS = 8 * SECOND_MS;
const EXIT_POLL_MS = SECOND_MS / 2;
/** How long one of Genex's own commands may wait for a busy editor. */
const COMMAND_WAIT_MS = 20 * SECOND_MS;
/** Where an editor keeps the scenes it backed up, relative to the project: left behind by one that was killed. */
const SCENE_BACKUPS = "Temp/__Backupscenes";
/** The folder in the plugin's storage holding what was moved out of each game's project. */
const RECOVERED_FOLDER = "recovered";
/** A game id as Genex names a game's folder: a plain folder name, never a path. */
const GAME_ID = /^[a-zA-Z0-9_-]{1,100}$/;
/** The error of a rename across two disks. */
const CROSS_DEVICE = "EXDEV";

/** The Pipeline commands Genex itself runs, by name. Wire values: Pipeline's own. */
const Command = {
  Eval: "eval",
  ListOpenScenes: "list_open_scenes",
  SaveScene: "save_scene",
  CreateScene: "create_scene",
  SetAutotick: "set_autotick",
  EditorStop: "editor_stop",
} as const;

/** The C# Genex itself runs in the editor; agents run none (`pipeline-gate.ts`). */
const Code = {
  /** Ends the editor at once, asking nothing: the caller saved what was to be kept. */
  Exit: "UnityEditor.EditorApplication.Exit(0);",
  /** Writes changed assets and project settings to disk. */
  SaveAssets: "UnityEditor.AssetDatabase.SaveAssets();",
  /** Lets the game keep running at full speed while Unity is behind other windows, and keeps the setting. */
  RunInBackground: "UnityEditor.PlayerSettings.runInBackground = true; UnityEditor.AssetDatabase.SaveAssets();",
} as const;

/** The first scene of a project Genex makes, under `Assets/`, seeded with a camera and a light. */
const FIRST_SCENE = { path: "Scenes/Main.unity", template: "default" } as const;

/** What reaching and ending an editor takes: its network and the computer's processes. */
export interface EditorDeps {
  pipeline: PipelineDeps;
  processes: ProcessEnv;
}

/** One open scene as the editor lists it: its path under the project (empty: never saved) and whether it has unsaved work. */
export interface OpenScene {
  path: string;
  dirty: boolean;
}

/** One of Genex's own commands to the editor that has `root` open. */
export const editorCommand = (
  root: string,
  deps: EditorDeps,
  command: string,
  parameters: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<PipelineAnswer> =>
  runCommand(root, { command, parameters }, deps.pipeline, { waitMs: COMMAND_WAIT_MS, signal });

/** The ids of the processes that have the project open: by their command line, and by a descriptor whose process is a Unity editor. */
export async function openPids(root: string, deps: EditorDeps): Promise<number[]> {
  const descriptor = await readDescriptor(root);
  const named = descriptor && deps.pipeline.alive(descriptor.pid) ? descriptor.pid : undefined;
  return projectPids(deps.processes, root, named);
}

/** Whether a Unity editor has the project at `root` open. */
export const editorRuns = async (root: string, deps: EditorDeps): Promise<boolean> =>
  (await openPids(root, deps)).length > 0;

/** The scenes the editor has open, or its trouble when it can't say. */
export async function openScenes(
  root: string,
  deps: EditorDeps,
  signal?: AbortSignal,
): Promise<PipelineAnswer<OpenScene[]>> {
  const answer = await editorCommand(root, deps, Command.ListOpenScenes, {}, signal);
  if (!answer.ok) return answer;
  const listed = isJsonObject(answer.result) && Array.isArray(answer.result.scenes) ? answer.result.scenes : [];
  const scenes = listed.filter(isJsonObject).map((scene) => ({
    path: typeof scene.path === "string" ? scene.path : "",
    dirty: scene.isDirty === true,
  }));
  return { ok: true, result: scenes };
}

/** What a save came to: the scenes written, the unsaved scenes that have no name, and the first trouble met. */
export interface Saved {
  saved: string[];
  /** How many scenes with unsaved work have never been saved, so Genex could not save them. */
  untitled: number;
  trouble?: Extract<PipelineAnswer, { ok: false }>;
}

/**
 * Saves the editor's work without ever making Unity ask for a file name: each named scene with
 * unsaved work by its own path, then changed assets and settings. A scene with no name is counted,
 * never saved.
 */
export async function saveWork(root: string, deps: EditorDeps, signal?: AbortSignal): Promise<Saved> {
  const scenes = await openScenes(root, deps, signal);
  if (!scenes.ok) return { saved: [], untitled: 0, trouble: scenes };
  const dirty = scenes.result.filter((scene) => scene.dirty);
  const saved: string[] = [];
  for (const scene of dirty.filter((unsaved) => unsaved.path)) {
    const answer = await editorCommand(root, deps, Command.SaveScene, { path: scene.path }, signal);
    if (!answer.ok) return { saved, untitled: 0, trouble: answer };
    saved.push(scene.path);
  }
  const assets = await editorCommand(root, deps, Command.Eval, { code: Code.SaveAssets }, signal);
  const untitled = dirty.filter((scene) => !scene.path).length;
  return { saved, untitled, ...(assets.ok ? {} : { trouble: assets }) };
}

/** Whether a look at the editor finds it in Play mode (playing or paused). */
export const isPlaying = (status: EditorStatus): boolean => status.playMode !== "" && status.playMode !== PLAY_STOPPED;

/** Ends the editor's Play mode; what a scene had while it played is lost, as when the person stops it. */
export const stopPlaying = (root: string, deps: EditorDeps, signal?: AbortSignal): Promise<PipelineAnswer> =>
  editorCommand(root, deps, Command.EditorStop, {}, signal);

/** Keeps the editor ticking while it is behind other windows, for as long as it runs; trouble is not the caller's. */
export async function keepTicking(root: string, deps: EditorDeps, signal?: AbortSignal): Promise<void> {
  await editorCommand(root, deps, Command.SetAutotick, { enable: true }, signal).catch(() => undefined);
}

/**
 * Gets a project Genex just made ready to work in: the game keeps running behind other windows,
 * and the untitled scene Unity opens a new project with gives way to a saved first scene, so no
 * later save has a file name to ask for. Answers the first trouble, if any.
 */
export async function firstSetup(
  root: string,
  deps: EditorDeps,
  signal?: AbortSignal,
): Promise<Extract<PipelineAnswer, { ok: false }> | undefined> {
  const steps: Array<[string, Record<string, unknown>]> = [
    [Command.Eval, { code: Code.RunInBackground }],
    [Command.CreateScene, { ...FIRST_SCENE }],
  ];
  for (const [command, parameters] of steps) {
    const answer = await editorCommand(root, deps, command, parameters, signal);
    if (!answer.ok) return answer;
  }
  return undefined;
}

/** Waits until no process has the project open, for at most `ms`; answers whether none is left. */
async function goneWithin(root: string, deps: EditorDeps, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += EXIT_POLL_MS) {
    if (!(await editorRuns(root, deps))) return true;
    await deps.processes.sleep(EXIT_POLL_MS);
  }
  return !(await editorRuns(root, deps));
}

/** Sends a signal to each process, passing over one that is already gone. */
function signalAll(deps: EditorDeps, pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      deps.processes.signal(pid, signal);
    } catch {
      // Gone between the look and the signal: what was asked for.
    }
  }
}

/** How an ending treats the editor's work: saved first when it answers (`save`), on the call's stop. */
export type EndOptions = { save?: boolean; signal?: AbortSignal };

/**
 * Ends the editor that has the project at `root` open: a clean exit through the editor when its
 * main thread answers, else (or when that leaves it running) a signal to the project's own
 * processes. It saves nothing unless asked to (`save`), and then only an editor that answers, its
 * play stopped first; what it can't save is lost with it. Answers whether none is left; a project
 * no editor has open is ended.
 */
export async function endEditor(root: string, deps: EditorDeps, options: EndOptions = {}): Promise<boolean> {
  if (!(await editorRuns(root, deps))) return true;
  const look = await editorStatus(root, deps.pipeline);
  if (look.ok) {
    if (options.save) await saveBeforeEnd(root, deps, look.result, options.signal);
    // The editor is gone before it can answer, so no answer is the expected one.
    await runCommand(root, { command: Command.Eval, parameters: { code: Code.Exit } }, deps.pipeline, {
      waitMs: 0,
    }).catch(() => undefined);
    if (await goneWithin(root, deps, CLEAN_EXIT_MS)) return true;
  }
  if (await endEditors(deps.processes, root)) return goneOrSignalled(root, deps);
  return false;
}

/** Saves what an answering editor can before it ends: its play stopped, then its work; trouble is the ending's loss. */
async function saveBeforeEnd(root: string, deps: EditorDeps, status: EditorStatus, signal?: AbortSignal) {
  if (isPlaying(status)) await stopPlaying(root, deps, signal).catch(() => undefined);
  await saveWork(root, deps, signal).catch(() => undefined);
}

/** After the listed processes ended: ends the Unity editor only its descriptor names, as on Windows, whose list names no project. */
async function goneOrSignalled(root: string, deps: EditorDeps): Promise<boolean> {
  const left = await openPids(root, deps);
  if (left.length === 0) return true;
  signalAll(deps, left, "SIGTERM");
  return goneWithin(root, deps, CLEAN_EXIT_MS);
}

/** Where the plugin keeps what it moved out of a game's project, and for which game. */
export interface KeepPlace {
  storage: string;
  game: string;
  now: () => Date;
}

/** A folder to another place: a rename, or a copy and a removal where the two are on different disks. */
async function moveFolder(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== CROSS_DEVICE) throw error;
    await cp(from, to, { recursive: true });
    await rm(from, { recursive: true, force: true });
  }
}

/**
 * Moves the scene backups an editor left when it was killed or crashed out of the project, into
 * the plugin's storage (`recovered/<game>/<time>/`): with them there, the next Unity to open the
 * project asks whether to recover them, in a dialog nobody may be there to answer. Only for a
 * project no editor has open (an open editor's backups are its own), and only a folder of the
 * project itself, never through a link out of it. Answers where they are kept, if any were.
 */
export async function setAsideBackups(root: string, keep: KeepPlace): Promise<string | undefined> {
  if (!GAME_ID.test(keep.game)) return undefined;
  const backups = await containedReal(root, SCENE_BACKUPS).catch(() => undefined);
  if (!backups) return undefined;
  const stamp = keep.now().toISOString().replace(/[:.]/g, "-");
  const kept = path.join(keep.storage, RECOVERED_FOLDER, keep.game, stamp);
  await mkdir(path.dirname(kept), { recursive: true, mode: 0o700 });
  await moveFolder(backups, kept);
  return kept;
}

/** Whether a trouble means the editor's main thread runs nothing, as behind a dialog. */
export const isStalled = (answer: PipelineAnswer): boolean => !answer.ok && answer.problem === PipelineProblem.Stalled;
