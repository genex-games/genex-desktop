/**
 * What the Unity plugin's handlers do at Genex's moments (`context.hook`), over the editor of one
 * game. Git stays Genex's: nothing here snapshots or restores files.
 *
 * | Handler at its moment | In a run (`hook.runId`) | In a chat |
 * |---|---|---|
 * | `save-all` at `checkpoint.before` | Unity not open: nothing; the agent's own play, or the person's while agents may use Unity as they play: stopped, then saved; the person's play otherwise, an editor that can't be asked, a save that fails or an unsaved scene with no name: block | the agent's play: stopped; the person's play: block; anything else it can't save: a note |
 * | `save-all` at `restore.before` | as in a run, but a play is stopped first: the restore closes the editor anyway | same |
 * | `end-editor` at `restore.before` | ends the editor and remembers it did; still running after that: block | same |
 * | `reopen-editor` at `restore.after` | reopens only when `end-editor` closed one for this restore | same |
 * | `reopen-editor` at `crash` | ends what is left of the editor, then opens the project again | same |
 * | `editor-state` at `health` | answers: nothing; starting, reloading or busy: pending; not running: block; a main thread that ran nothing for two minutes: block when nobody is at the computer, pending while somebody is (the dialog may be theirs) | same |
 * | `open-for-run` at `run.prepare` | opens Unity and waits, remembering when Genex opened it; a project that is not set up, or an editor that does not answer: block | — |
 * | `after-run` at `run.end` | an editor Genex opened for the run starts its idle time, after which it may be closed (`editor-idle.ts`) | — |
 * | `scene-shots` at `checkpoint.after`, and as the `viewport` observer | the main camera's still as an image; one flat colour (a scene built only when Play starts): no image, a note | nothing: no still taken |
 * | `editor-activity` as the lock's probe | no editor: nobody, nothing unsaved; a play counts only when the agent did not start it (its play kept while it starts and while it is seen running), and not while agents may use Unity as the person plays (said once per game: `wentAhead`); an editor that can't be asked: can't tell, but nobody when it is stalled and the computer was left alone | same |
 */
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import type { PluginHookAnswer, PluginHookContext } from "../../plugin-sdk/index.d.ts";
import { HookEvent } from "../../shared/plugin-hooks.ts";
import { atomicWriteJson, isJsonObject, readJsonIfExists } from "../../substrate/fsx.ts";
import { decodePng } from "../../substrate/png.ts";
import { agentPlaying, agentPlayStarting, forgetAgentPlay, sawAgentPlay } from "./agent-play.ts";
import { agentsSetting, firstWentAhead } from "../../substrate/engine-agents.ts";
import { editorCommand, editorRuns, endEditor, openScenes, saveWork } from "./editor-life.ts";
import { runEnded, runGoesOn, rememberLaunch } from "./editor-idle.ts";
import { launched, type OpenDeps, Opened, type Opening, openProject, usable } from "./editor-open.ts";
import { editorStatus, PIPELINE_PACKAGE, PipelineProblem, PLAY_STOPPED } from "./pipeline.ts";
import type { UnityProject } from "./project-folder.ts";
import { pipelineVersionOf } from "./setup.ts";

/** How long a main thread may run nothing before a health check fails: longer than any import a game's edits cause. */
export const STALL_GRACE_MS = 2 * MINUTE_MS;
/** How long the computer is left alone before a stalled editor counts as nobody's: a person steps away for less. */
export const AWAY_AFTER_MS = 5 * MINUTE_MS;
/** How long a moment waits for an editor it reopened: a step is given about a minute. */
const REOPEN_WAIT_MS = 45 * SECOND_MS;
/** How long a run's start waits for the editor it opened. */
const RUN_OPEN_WAIT_MS = 150 * SECOND_MS;
/** The still a checkpoint and the reviewer get. */
const STILL = { source: "camera", width: 1280, height: 720 } as const;
const CAPTURE = "capture_game_view";
const STOP_PLAY = "editor_stop";
/** The folders in the plugin's storage holding each game's record of an editor closed for a restore, and of a stall. */
const Records = { Restore: "restore", Health: "health" } as const;
/** A game id as Genex names a game's record: a plain folder name, never a path. */
const GAME_ID = /^[a-zA-Z0-9_-]{1,100}$/;
/** How far a channel may stray from the first pixel's and still be the same flat colour: a dither, not a picture. */
const FLAT_TOLERANCE = 2;

const WORDS = {
  CantAsk: "Unity doesn't answer, so its unsaved work can't be saved.",
  Stalled:
    "Unity's main thread runs nothing (a dialog nobody answered, or a long import), so its unsaved work can't be saved.",
  Playing: "Unity is in Play mode, and scenes can't be saved until play stops.",
  SaveFailed: (why: string) => `Unity couldn't save its work: ${why}`,
  Untitled: (count: number) =>
    `${count === 1 ? "A scene" : `${count} scenes`} with unsaved work in Unity ${count === 1 ? "has" : "have"} never been saved, so Genex can't save ${count === 1 ? "it" : "them"}: save with save_scene and a path under Assets/.`,
  Saved: (count: number) => `Saved ${count === 1 ? "1 scene" : `${count} scenes`} in Unity.`,
  NotEnded: "Unity couldn't be closed for the restore, so the game's files stay as they are.",
  StillOpening: "Unity is opening the project again and is not ready yet.",
  NotReopened: (why: string) => `Unity wasn't opened again (${why}): open the game's project in Unity.`,
  Gone: "Unity isn't running: it crashed or was quit.",
  Busy: "Unity is starting, reloading its scripts or importing.",
  StallPending: "Unity's main thread is not answering: a long import, or a dialog nobody answered.",
  StallAttended:
    "Unity's main thread is not answering, and someone is at this computer: if Unity shows a dialog, answer it.",
  StallFailed: (minutes: number) =>
    `Unity's main thread has run nothing for ${minutes} minutes: a dialog nobody answered, or the editor hangs.`,
  NoProject: "This game's folder holds no Unity project.",
  NotSetUp: `This game's Unity project has no Pipeline package (${PIPELINE_PACKAGE}), so agents can't reach its editor: set it up with unity__setup first.`,
  NotReady: "Unity didn't answer after it was opened, so the run can't work in it.",
  NoEditor: (version: string) => `Unity ${version}, which this project was saved with, isn't installed here.`,
  SetAside: (folder: string) =>
    `Unity's backups of the scenes that were unsaved when it last ended were moved to ${folder}, so that it opens without asking to recover them.`,
  EmptyStill:
    "No picture of this save point: the main camera saw one flat colour, since outside Play mode the scene shows nothing of the game. Build the level into the scene with an Assets/Editor script run by run_script, so its camera sees the game.",
} as const;

/** What a handler works on: the game, the plugin's storage, the game's project and the moment. */
export interface Moment {
  game: string;
  storage: string;
  project: UnityProject | undefined;
  hook?: PluginHookContext;
  signal: AbortSignal;
}

/** What the handlers reach: the editor, the installed editors, the opener, the clock and how long the computer has been left alone. */
export interface MomentDeps extends OpenDeps {
  now: () => Date;
  /** How long since anyone touched the keyboard or pointer; undefined where the computer can't say. */
  idleMs: () => Promise<number | undefined>;
}

/**
 * Whether nobody is at the computer: it was left alone for {@link AWAY_AFTER_MS}. Where that can't
 * be read, somebody may be there. A stalled editor may be behind a dialog the person themselves has
 * open, so only an unattended one is Genex's to end.
 */
async function nobodyThere(deps: MomentDeps): Promise<boolean> {
  const idle = await deps.idleMs().catch(() => undefined);
  return idle !== undefined && idle >= AWAY_AFTER_MS;
}

const inRun = (moment: Moment): boolean => moment.hook?.runId !== undefined;
const at = (moment: Moment, on: HookEvent): boolean => moment.hook?.on === on;

/** The first words of a trouble an opener or a command gave, as a reason fits. */
const reasonOf = (text: string | undefined): string => (text ?? "").replace(/\s+/g, " ").slice(0, 160);

const recordFile = (moment: Moment, folder: string): string | null =>
  GAME_ID.test(moment.game) ? path.join(moment.storage, folder, `${moment.game}.json`) : null;

async function writeRecord(moment: Moment, folder: string, record: Record<string, unknown>): Promise<void> {
  const file = recordFile(moment, folder);
  if (!file) return;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWriteJson(file, record);
}

async function readRecord(moment: Moment, folder: string): Promise<Record<string, unknown> | undefined> {
  const file = recordFile(moment, folder);
  const record = file ? await readJsonIfExists<unknown>(file).catch(() => null) : null;
  return isJsonObject(record) ? record : undefined;
}

async function forgetRecord(moment: Moment, folder: string): Promise<void> {
  const file = recordFile(moment, folder);
  if (file) await rm(file, { force: true });
}

/** Work Genex could not save: a block where the moment must not go on without it, a note in a chat's checkpoint. */
function unsaved(moment: Moment, reason: string): PluginHookAnswer {
  const strict = inRun(moment) || at(moment, HookEvent.RestoreBefore);
  return strict ? { block: reason } : { note: reason };
}

/** Whether a save may end the editor's play: a restore's, the agent's own play, or a run's while agents may use Unity as the person plays. */
async function playMayEnd(moment: Moment, deps: MomentDeps): Promise<boolean> {
  if (at(moment, HookEvent.RestoreBefore)) return true;
  if (await agentPlaying(moment.storage, moment.game, deps.now().getTime())) return true;
  return inRun(moment) && (await agentsSetting(moment.storage)).whilePlaying;
}

/** Ends the editor's play, and with it any record that the play was the agent's. */
async function stopPlay(moment: Moment, root: string, deps: MomentDeps): Promise<void> {
  await editorCommand(root, deps, STOP_PLAY, {}, moment.signal);
  await forgetAgentPlay(moment.storage, moment.game);
}

/** `save-all`: the editor's work written to disk before Genex snapshots or restores the game's files. */
export async function saveAll(moment: Moment, deps: MomentDeps): Promise<PluginHookAnswer> {
  const root = moment.project?.root;
  if (!root || !(await editorRuns(root, deps))) return {};
  const look = await editorStatus(root, deps.pipeline, { signal: moment.signal });
  if (!look.ok) return unsaved(moment, look.problem === PipelineProblem.Stalled ? WORDS.Stalled : WORDS.CantAsk);
  const playing = look.result.playMode !== "" && look.result.playMode !== PLAY_STOPPED;
  // A restore closes the editor anyway, the agent's own play is its to end, and a run's save point
  // may end the person's while agents may use Unity as they play: the play ends first, so what was
  // edited before it is saved. Otherwise the person's play is theirs to stop.
  if (playing && !(await playMayEnd(moment, deps))) return { block: WORDS.Playing };
  if (playing) await stopPlay(moment, root, deps);
  const saved = await saveWork(root, deps, moment.signal);
  if (saved.trouble) return unsaved(moment, WORDS.SaveFailed(reasonOf(saved.trouble.detail ?? saved.trouble.problem)));
  if (saved.untitled > 0) return unsaved(moment, WORDS.Untitled(saved.untitled));
  return saved.saved.length > 0 && !inRun(moment) ? { note: WORDS.Saved(saved.saved.length) } : {};
}

/** `end-editor`: the editor ended before a restore puts other files under it, remembered so it is opened again after. */
export async function endForRestore(moment: Moment, deps: MomentDeps): Promise<PluginHookAnswer> {
  const root = moment.project?.root;
  if (!root || !(await editorRuns(root, deps))) return {};
  if (!(await endEditor(root, deps))) return { block: WORDS.NotEnded };
  await writeRecord(moment, Records.Restore, { root, closedAt: deps.now().toISOString() });
  return {};
}

/** How a moment asks for an opening: its stop, its wait, and where scene backups a killed editor left are kept. */
const openingAt = (moment: Moment, deps: MomentDeps, waitMs: number) => ({
  signal: moment.signal,
  waitMs,
  keep: { storage: moment.storage, game: moment.game, now: deps.now },
});

/** Why reopening did not get the editor back, if it did not. */
function notBack(opening: Opening): string {
  if (usable(opening)) return "";
  if (opening.opened === Opened.NoEditor) return WORDS.NotReopened(WORDS.NoEditor(opening.version));
  if (opening.opened === Opened.Failed) return WORDS.NotReopened(reasonOf(opening.why));
  return WORDS.StillOpening;
}

/** What reopening came to: a note where it did not get the editor back, or moved a killed editor's scene backups aside. */
function reopened(opening: Opening): PluginHookAnswer {
  const aside = opening.setAside ? WORDS.SetAside(opening.setAside) : "";
  const note = [notBack(opening), aside].filter(Boolean).join(" ");
  return note ? { note } : {};
}

/**
 * `reopen-editor`: after a restore, the editor `end-editor` closed is opened again on the restored
 * files (a restore that closed none opens none); after a failed health check, what is left of the
 * editor is ended first, a stalled one included, and the project opened again.
 */
export async function reopenEditor(moment: Moment, deps: MomentDeps): Promise<PluginHookAnswer> {
  const { project } = moment;
  if (!project) return {};
  if (at(moment, HookEvent.RestoreAfter)) {
    const closed = await readRecord(moment, Records.Restore);
    await forgetRecord(moment, Records.Restore);
    if (closed?.root !== project.root) return {};
  }
  if (at(moment, HookEvent.Crash)) await endEditor(project.root, deps);
  await forgetRecord(moment, Records.Health);
  return reopened(await openProject(deps, project, openingAt(moment, deps, REOPEN_WAIT_MS)));
}

/** When the game's editor was first seen stalled, kept between checks; now, when it was not stalled before. */
async function stalledSince(moment: Moment, now: number): Promise<number> {
  const since = (await readRecord(moment, Records.Health))?.stalledSince;
  if (typeof since === "number" && since <= now) return since;
  await writeRecord(moment, Records.Health, { stalledSince: now });
  return now;
}

/** `editor-state`: quiet while Unity answers, pending while it may, blocked once it is gone or stalled for good. */
export async function editorState(moment: Moment, deps: MomentDeps): Promise<PluginHookAnswer> {
  const root = moment.project?.root;
  if (!root) return { block: WORDS.NoProject };
  if (!(await editorRuns(root, deps))) return { block: WORDS.Gone };
  const look = await editorStatus(root, deps.pipeline, { signal: moment.signal });
  if (look.ok) {
    await forgetRecord(moment, Records.Health);
    return {};
  }
  if (look.problem !== PipelineProblem.Stalled) return { pending: WORDS.Busy };
  const now = deps.now().getTime();
  const stalledFor = now - (await stalledSince(moment, now));
  if (stalledFor < STALL_GRACE_MS) return { pending: WORDS.StallPending };
  // The dialog that holds the editor may be the person's own: only an unattended editor is ended.
  if (!(await nobodyThere(deps))) return { pending: WORDS.StallAttended };
  return { block: WORDS.StallFailed(Math.round(stalledFor / MINUTE_MS)) };
}

/** `open-for-run`: the game's editor open and answering before a run's first turn, or the run told why not. */
export async function openForRun(moment: Moment, deps: MomentDeps): Promise<PluginHookAnswer> {
  const { project } = moment;
  if (!project) return {};
  if (!(await pipelineVersionOf(project.root).catch(() => undefined))) return { block: WORDS.NotSetUp };
  const opening = await openProject(deps, project, openingAt(moment, deps, RUN_OPEN_WAIT_MS));
  // Only an editor Genex opened for a run is ever closed after one (`editor-idle.ts`).
  if (launched(opening)) await rememberLaunch(moment.storage, moment.game, project.root);
  else await runGoesOn(moment.storage, moment.game, project.root);
  if (usable(opening)) return opening.setAside ? { note: WORDS.SetAside(opening.setAside) } : {};
  if (opening.opened === Opened.NoEditor) return { block: WORDS.NoEditor(opening.version) };
  if (opening.opened === Opened.Failed) return { block: WORDS.NotReopened(reasonOf(opening.why)) };
  return { block: WORDS.NotReady };
}

/** `after-run`: the editor Genex opened for this run starts its idle time, unless the person turned closing off. */
export async function afterRun(moment: Moment, deps: MomentDeps, closeIdle: boolean): Promise<PluginHookAnswer> {
  await runEnded(moment.storage, moment.game, deps.now().getTime(), closeIdle);
  return {};
}

/** Whether an editor that plays nothing may still be entering the agent's play: it reloads, or the play was just asked for. */
const playMayBeStarting = async (moment: Moment, reloading: boolean, now: number): Promise<boolean> =>
  reloading || (await agentPlayStarting(moment.storage, moment.game, now));

/** What the editor lock's probe answers: whether the person is using the editor, and how much is unsaved. */
export type Activity = { personActive: boolean; unsaved: number; wentAhead?: true } | Record<string, never>;

/**
 * `editor-activity`: the person is using the editor while it plays a game the agent did not start;
 * unsaved is the open scenes with unsaved work. An editor that can't be asked answers nothing, so
 * Genex can't tell.
 */
export async function editorActivity(moment: Moment, deps: MomentDeps): Promise<Activity> {
  const root = moment.project?.root;
  if (!root || !(await editorRuns(root, deps))) return { personActive: false, unsaved: 0 };
  const look = await editorStatus(root, deps.pipeline, { signal: moment.signal });
  // A stalled editor nobody is at is Genex's to get back; with somebody there, the dialog may be theirs.
  if (!look.ok && look.problem === PipelineProblem.Stalled && (await nobodyThere(deps)))
    return { personActive: false, unsaved: 0 };
  if (!look.ok) return {};
  const playing = look.result.playMode !== "" && look.result.playMode !== PLAY_STOPPED;
  const now = deps.now().getTime();
  const agents = await agentPlaying(moment.storage, moment.game, now);
  if (playing && agents) await sawAgentPlay(moment.storage, moment.game, now);
  // The agent's play ended some other way than its own stop: the next play is the person's. One
  // it just asked for may not have begun, since entering Play reloads the scripts first.
  if (!playing && agents && !(await playMayBeStarting(moment, look.result.reloading, now)))
    await forgetAgentPlay(moment.storage, moment.game);
  const scenes = await openScenes(root, deps, moment.signal);
  if (!scenes.ok) return {};
  const unsaved = scenes.result.filter((scene) => scene.dirty).length;
  if (!(playing && !agents)) return { personActive: false, unsaved };
  return personPlaying(moment, unsaved);
}

/**
 * The person plays: agents wait for them, unless they may use Unity as the person plays; then the
 * first time for this game the answer says so (`wentAhead`), and the chat tells the person once.
 */
async function personPlaying(moment: Moment, unsaved: number): Promise<Activity> {
  if (!(await agentsSetting(moment.storage)).whilePlaying) return { personActive: true, unsaved };
  if (!(await firstWentAhead(moment.storage, moment.game))) return { personActive: false, unsaved };
  return { personActive: false, unsaved, wentAhead: true };
}

/** A capture's camera, as the still is named: `camera:Main Camera` is `Main Camera`. */
const stillName = (source: unknown): string =>
  typeof source === "string" && source.includes(":") ? source.slice(source.indexOf(":") + 1) : "Game view";

/**
 * Whether a PNG still is one flat colour, give or take a dither: a camera that sees nothing but its
 * own background. A still that can't be read is not called flat.
 */
export function isFlatStill(png: Uint8Array): boolean {
  let rgb: Uint8Array;
  try {
    rgb = decodePng(png).rgb;
  } catch {
    return false;
  }
  for (let at = 3; at < rgb.length; at++)
    if (Math.abs((rgb[at] ?? 0) - (rgb[at % 3] ?? 0)) > FLAT_TOLERANCE) return false;
  return true;
}

/**
 * `scene-shots`: the main camera's still, for a run's save point and for the reviewer of its
 * finish (the `viewport` observer). A chat's checkpoint takes none; an editor that is not there, or
 * a scene with no camera, answers none. A still of one flat colour is a scene that builds itself
 * only when Play starts: it answers a note saying so, never a blank card.
 */
export async function sceneShots(moment: Moment, deps: MomentDeps): Promise<PluginHookAnswer> {
  const root = moment.project?.root;
  const ofChat = moment.hook !== undefined && !inRun(moment);
  if (!root || ofChat || !(await editorRuns(root, deps))) return {};
  if (!(await editorStatus(root, deps.pipeline, { signal: moment.signal })).ok) return {};
  const shot = await editorCommand(root, deps, CAPTURE, { ...STILL }, moment.signal);
  const data = shot.ok && isJsonObject(shot.result) ? shot.result.base64 : undefined;
  if (typeof data !== "string" || !data) return {};
  if (isFlatStill(Buffer.from(data, "base64"))) return { note: WORDS.EmptyStill };
  const source = shot.ok && isJsonObject(shot.result) ? shot.result.source : undefined;
  return { images: [{ name: stillName(source), data }] };
}
