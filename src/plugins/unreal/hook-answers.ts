/**
 * How the Unreal plugin's handlers answer at Genex's moments (`context.hook`): the pure builders of
 * `{block, note, pending, images}` and their words, which the person and the lead read as they did
 * when Genex's runner and checkpoint said them itself. A run (`hook.runId`) and a chat answer by
 * different policies:
 *
 * | Handler at its moment | In a run | In a chat |
 * |---|---|---|
 * | `save-all` at `checkpoint.before` | not answering, can't tell, a play, or the save refused: block; saved: nothing | a play: block; anything else: a note of what was saved or why not |
 * | `save-all` at `restore.before` | not running: nothing; busy past the wait, or a save that fails or leaves work: block | same |
 * | `end-editor` at `restore.before` | still answering after it ended everything: block | same |
 * | `reopen-editor` at `restore.after`, `crash` | starts reopening (an outdated helper updated while closed): nothing | same, after a restore only when it closed a running Unreal |
 * | `editor-state` at `health` | answers: nothing; reopening, starting, busy or can't tell: pending; reopening failed, port blocked, unlinked or gone: block | same, gone in the chat's words |
 * | `log-errors` at `run.prepare` / `checkpoint.before` | marks the log's end / notes the new errors | same |
 * | `hero-shots` at `checkpoint.after` | the hero cameras' stills as images, their tone as measures | nothing: no stills taken |
 * | `open-for-run` at `run.prepare` | opens Unreal, updates an outdated helper, exports missing facts; block when it can't | — |
 * | `editor-activity` as the lock's probe | no editor: nobody, nothing unsaved; a play counts only when neither the agent nor the queue started it | same |
 */
import type { HookAnswer, HookContext, HookImage } from "../../shared/plugin-hooks.ts";
import { EngineReadiness } from "./editor-wait.ts";

/** How many of the names left unsaved an answer lists, and how many new log errors a note names. */
const NAMED_UNSAVED = 3;
const NAMED_LOG_LINES = 3;
/** A picture's name as Genex keeps it: plain characters, at most 80. */
const IMAGE_NAME_CHARS = 80;
const NOT_NAME = /[^A-Za-z0-9 ._-]+/g;

/** What a save at a checkpoint found: the editor's state, then what the save did. Never rename a value. */
export const SaveOutcome = {
  NotAnswering: "not-answering",
  CantTell: "cant-tell",
  Playing: "playing",
  Clean: "clean",
  Saved: "saved",
  LeftUnsaved: "left-unsaved",
  Failed: "failed",
} as const;
export type SaveOutcome = (typeof SaveOutcome)[keyof typeof SaveOutcome];

/** A checkpoint's save, read: how it went, how many it saved, what it left (and whether it said it saved), or why it failed. */
export type SaveRead =
  | { outcome: typeof SaveOutcome.NotAnswering | typeof SaveOutcome.CantTell | typeof SaveOutcome.Playing }
  | { outcome: typeof SaveOutcome.Clean }
  | { outcome: typeof SaveOutcome.Saved; count: number }
  | { outcome: typeof SaveOutcome.LeftUnsaved; names: string[]; saved: boolean }
  | { outcome: typeof SaveOutcome.Failed; why: string };

/** Where the game's Unreal stands for a health check. Never rename a value. */
export const EditorHealth = {
  Answers: "answers",
  Reopening: "reopening",
  ReopenFailed: "reopen-failed",
  Starting: "starting",
  PortBlocked: "port-blocked",
  NoProject: "no-project",
  Busy: "busy",
  Gone: "gone",
  Unknown: "unknown",
} as const;
export type EditorHealth = (typeof EditorHealth)[keyof typeof EditorHealth];

/** A health check's reading: where Unreal stands, the error a failed reopen or a blocked port gave, and the project's name. */
export type HealthRead = { health: EditorHealth; error?: string; project?: string | null };

/** The words of every answer. The person and the lead read them as written. */
export const MOMENT_WORDS = {
  // A run's save point (the lead's `save_point` says "No save point: <reason>").
  NoEditor: "Unreal doesn't answer, so nothing was saved.",
  Playing: "The game is playing in the editor: stop the play session first, then save. Nothing was saved.",
  CantTell:
    "Unreal can't tell whether the game is playing, and saving would end a play session, so nothing was saved. Try again in a moment.",
  NotSaved: (problem: string) => `${problem}. No save point was made; save what is left, then try again.`,
  LeftAssets: (dirty: readonly string[]) =>
    `the editor's save left ${dirty.length} assets unsaved${dirty.length ? ` (${dirty.slice(0, NAMED_UNSAVED).join(", ")})` : ""}`,
  SaveFailed: (why: string) => `the editor's save failed: ${why}`,
  // A chat's checkpoint: the agent's checkpoint answer, and the person's line at a turn's end, so no tool is named.
  ChatPlaying:
    "The game is playing in the Unreal editor, so nothing was saved and no snapshot was taken. Stop the play session, then save again.",
  Clean: "Unreal had nothing unsaved.",
  Unknown: "Genex couldn't tell whether the game is playing in Unreal, so nothing was saved there.",
  Saved: (count: number) => `Saved ${count} unsaved ${count === 1 ? "file" : "files"} in Unreal.`,
  ChatNotSaved: (why: string) => `Unreal's work was not saved: ${why}`,
  LeftUnsaved: (names: readonly string[]) =>
    `${names.length} ${names.length === 1 ? "file" : "files"} stayed unsaved in Unreal (${names.slice(0, NAMED_UNSAVED).join(", ")}).`,
  // A restore.
  KeptOpen: (why: string) => `Genex couldn't save Unreal's work (${why}), so it left Unreal open`,
  RestoreNotSaved: (why: string): string => `${MOMENT_WORDS.KeptOpen(why)}.`,
  StayedBusy: "Unreal stayed busy and answered nothing",
  Unsaved: (dirty: readonly string[]) =>
    dirty.length ? `${dirty.slice(0, NAMED_UNSAVED).join(", ")} stayed unsaved` : "the save reported nothing saved",
  NotEnded: (why: string) => `Unreal couldn't be closed for the restore (${why}).`,
  NotReopened: (why: string) => `the Unreal plugin didn't reopen Unreal (${why})`,
  // Health.
  Reopening: "Genex is reopening Unreal.",
  ReopenFailed: (error: string) => `reopening Unreal failed: ${error || "no reason given"}`,
  Busy: "Unreal is busy: its editor runs and answers nothing yet.",
  CantTellRunning: "Genex can't tell whether Unreal is running.",
  Gone: "Unreal isn't running: it crashed or was quit.",
  NoProject: "This game isn't linked to an Unreal project.",
  Waiting: (project: string | null) =>
    `Unreal is opening ${project ?? "this game's project"}; a first start can take several minutes. This chat goes on by itself when it's ready. Stop ends the wait.`,
  NotReady: (project: string | null) =>
    `Unreal didn't finish opening ${project ?? "this game's project"}. Open it from the Unreal button above the game, then send a message to go on.`,
  // A run's start.
  NoHelper:
    "This game's Unreal project has no Genex editor helper, so the Loop can't save or capture it. Set the project up from the Unreal panel.",
  HelperUpdated: (to: string) => `Updated this game's Genex editor helper to ${to} before the Loop.`,
  HelperNotUpdated: (reason: string) =>
    `The Genex editor helper couldn't be updated (${reason}); the Loop goes on with it.`,
  NotOpened: (why: string) => `Unreal couldn't be reopened (${why}).`,
  OpenTimedOut: (minutes: number) => `Unreal didn't answer within ${minutes} minutes of reopening`,
  Stopped: "the run was stopped while Unreal reopened",
  // The log.
  LogErrors: (lines: readonly string[], since: string) => {
    const more = lines.length > NAMED_LOG_LINES ? ` (and ${lines.length - NAMED_LOG_LINES} more)` : "";
    const count = `${lines.length} new ${lines.length === 1 ? "error" : "errors"}`;
    return `Unreal's log has ${count} since the last ${since}: ${lines.slice(0, NAMED_LOG_LINES).join(" | ")}${more}`;
  },
} as const;

/** Whether a moment is part of a run (the runner's save points and restarts), not a chat's. */
export const inRun = (hook: HookContext | undefined): boolean => Boolean(hook?.runId);

/** A failure's message, ending as a sentence does. */
function sentence(why: string): string {
  const text = why.trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** A run's save point: blocked unless the editor's work was saved, else nothing to say. */
function runSave(read: SaveRead): HookAnswer {
  switch (read.outcome) {
    case SaveOutcome.NotAnswering:
      return { block: MOMENT_WORDS.NoEditor };
    case SaveOutcome.CantTell:
      return { block: MOMENT_WORDS.CantTell };
    case SaveOutcome.Playing:
      return { block: MOMENT_WORDS.Playing };
    case SaveOutcome.LeftUnsaved:
      // As the runner did: only a save that said it saved nothing refuses the save point.
      return read.saved ? {} : { block: MOMENT_WORDS.NotSaved(MOMENT_WORDS.LeftAssets(read.names)) };
    case SaveOutcome.Failed:
      return { block: MOMENT_WORDS.NotSaved(MOMENT_WORDS.SaveFailed(read.why)) };
    default:
      return {};
  }
}

/** A chat's checkpoint: blocked only by a play session; anything else is a note of what was saved. */
function chatSave(read: SaveRead): HookAnswer {
  switch (read.outcome) {
    case SaveOutcome.Playing:
      return { block: MOMENT_WORDS.ChatPlaying };
    case SaveOutcome.NotAnswering:
    case SaveOutcome.CantTell:
      return { note: MOMENT_WORDS.Unknown };
    case SaveOutcome.Clean:
      return { note: MOMENT_WORDS.Clean };
    case SaveOutcome.Saved:
      return { note: MOMENT_WORDS.Saved(read.count) };
    case SaveOutcome.LeftUnsaved:
      return { note: MOMENT_WORDS.LeftUnsaved(read.names) };
    case SaveOutcome.Failed:
      return { note: MOMENT_WORDS.ChatNotSaved(sentence(read.why)) };
    default:
      return {};
  }
}

/** `save-all`'s answer at a checkpoint, by the run's policy or the chat's. */
export function saveAnswer(read: SaveRead, hook: HookContext | undefined): HookAnswer {
  return inRun(hook) ? runSave(read) : chatSave(read);
}

/** Why a restore may not go on: Unreal's work couldn't be saved, so it stays open. */
export const restoreBlock = (why: string): HookAnswer => ({ block: MOMENT_WORDS.RestoreNotSaved(why) });

/** The new error lines of Unreal's log at a checkpoint, as a note; nothing when there are none. */
export function logAnswer(lines: readonly string[], hook: HookContext | undefined): HookAnswer {
  if (lines.length === 0) return {};
  return { note: MOMENT_WORDS.LogErrors(lines, inRun(hook) ? "save point" : "checkpoint") };
}

/** One still as `hero-shots` takes it: the camera, its PNG data and its tone numbers. */
export type HeroStill = { name: string; data: string; tone?: object };

/** A still's tone numbers as a picture's measures: the finite numbers only. */
function measuresOf(tone: object | undefined): Record<string, number> | undefined {
  if (!tone) return undefined;
  const kept = Object.entries(tone).filter((entry): entry is [string, number] => Number.isFinite(entry[1]));
  return kept.length ? Object.fromEntries(kept) : undefined;
}

/** The hero cameras' stills as a moment's pictures, each named for its camera, its tone as measures. */
export function shotsAnswer(shots: readonly HeroStill[]): HookAnswer {
  const images: HookImage[] = shots.map((shot) => {
    const name = shot.name.replace(NOT_NAME, "-").slice(0, IMAGE_NAME_CHARS) || "shot";
    const measures = measuresOf(shot.tone);
    return measures ? { name, data: shot.data, measures } : { name, data: shot.data };
  });
  return images.length ? { images } : {};
}

/** The words a gone Unreal or one with no project gets: the runner's, or the chat's wait's. */
function goneAnswer(read: HealthRead, hook: HookContext | undefined): HookAnswer {
  const project = read.project ?? null;
  if (read.health === EditorHealth.NoProject)
    return { block: inRun(hook) ? MOMENT_WORDS.NoProject : MOMENT_WORDS.NotReady(null) };
  return { block: inRun(hook) ? MOMENT_WORDS.Gone : MOMENT_WORDS.NotReady(project) };
}

/** `editor-state`'s answer at `health`: quiet while Unreal answers, pending while it may, blocked once it can't. */
export function healthAnswer(read: HealthRead, hook: HookContext | undefined): HookAnswer {
  switch (read.health) {
    case EditorHealth.Answers:
      return {};
    case EditorHealth.Reopening:
      return { pending: MOMENT_WORDS.Reopening };
    case EditorHealth.ReopenFailed:
      return { block: MOMENT_WORDS.ReopenFailed(read.error ?? "") };
    case EditorHealth.Starting:
      return { pending: MOMENT_WORDS.Waiting(read.project ?? null) };
    case EditorHealth.PortBlocked:
      return { block: read.error ?? MOMENT_WORDS.NotReady(read.project ?? null) };
    case EditorHealth.Busy:
      return { pending: MOMENT_WORDS.Busy };
    case EditorHealth.Unknown:
      return { pending: MOMENT_WORDS.CantTellRunning };
    default:
      return goneAnswer(read, hook);
  }
}

/** What the editor is doing, as the Genex editor helper says: a play session, and how many packages are unsaved. */
export type EditorActivity = { pie: boolean; dirty: number };

/**
 * The editor lock's probe: whether the person is using the game's editor (a play session neither the
 * agent nor the plugin's own queue started) and how much is unsaved; `pie` and `dirty` stay for the
 * callers that read them. No editor running: nobody, nothing unsaved.
 */
export function probeAnswer(activity: EditorActivity | null, agentPlay: boolean, queueBusy: boolean) {
  if (!activity) return { personActive: false, unsaved: 0, pie: false, dirty: 0 };
  const personActive = activity.pie && !agentPlay && !queueBusy;
  return { personActive, unsaved: activity.dirty, pie: activity.pie, dirty: activity.dirty };
}

/** Where this computer's Unreal stands for making a new game, as `engine-status` reads it. */
export type Readiness = { engine: EngineReadiness; version: string | null };

/** The tool that makes a new Unreal game, as the host serves it to agents. */
const NEW_GAME = "unreal__new-game";
const OPTION = `"Unreal Engine: plays in the Unreal editor on this computer"`;

/** What to do when the user picks Unreal before Genex can make its project: never new-game, the Unreal button instead. */
const toUnrealButton = (how: string) =>
  `If the user picks it, don't call ${NEW_GAME}, which would refuse: tell them to press the Unreal button above the game, which shows how to ${how} and notices when it's installed, and to send a message once it is.`;

/** How the engine question offers Unreal beside an Unreal that makes no new games here. */
const beside = (version: string) =>
  `offer it as "Unreal Engine 5.8" with the description "Needs 5.8 installed beside your ${version}, about 45 GB".`;

/** The engine question's words for this computer's Unreal: ready to make a game with, or what it needs first. */
function readinessNote(readiness: Readiness): string {
  const version = readiness.version ?? "";
  if (readiness.engine === EngineReadiness.None)
    return `Unreal Engine isn't installed on this computer yet, so offer it as "Unreal Engine" with the description "Plays in Epic's free editor on this computer; needs a 45 GB install first". ${toUnrealButton("get Unreal 5.8 free from Epic")}`;
  if (readiness.engine === EngineReadiness.NewerOnly)
    return `This computer has Unreal ${version}, and Genex makes new Unreal projects with 5.8 only, so ${beside(version)} ${toUnrealButton(`install 5.8 beside ${version} in the Epic Games Launcher`)}`;
  if (readiness.engine === EngineReadiness.OlderOnly)
    return `This computer has Unreal ${version}, older than the 5.8 Genex makes Unreal games with, so ${beside(version)} ${toUnrealButton("get 5.8 free from Epic")}`;
  return `Offer ${OPTION}; when the answer (or the request) is Unreal Engine, call ${NEW_GAME} with a template and a name: it makes the game's Unreal project in this folder, links this game to it and opens it in Unreal; then build the game there through the Unreal tools, never as a web page.`;
}

/** `engine-status`'s answer: the readiness and version, whether a new Unreal game can be made here, and the card's words. */
export function readinessAnswer(readiness: Readiness) {
  return { ...readiness, ready: readiness.engine === EngineReadiness.Ready, note: readinessNote(readiness) };
}
