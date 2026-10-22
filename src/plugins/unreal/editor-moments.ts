/**
 * What the Unreal plugin's handlers do at Genex's moments (`context.hook`), over the editor
 * operations `loop-tools.ts` hands them for one game: the editor-closing and opening know-how the
 * Unreal Loop's runner held, now the plugin's. A checkpoint saves the editor's work first (never
 * ending a play session); a restore saves unless Unreal is gone, waiting while a busy editor works,
 * then ends it and reopens it on the restored files; health tells a busy or reopening Unreal from a
 * gone one (gone only after {@link GONE_CHECKS} asks in a row); a run's start opens Unreal, brings
 * an outdated Genex editor helper up to the plugin's while Unreal is closed and has the editor
 * export the template's facts when the project has none. The answers and their words are
 * `hook-answers.ts`'s. Git stays Genex's: nothing here snapshots or restores files.
 */
import { type HookAnswer, type HookContext, HookEvent } from "../../shared/plugin-hooks.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { ANSWER_CHECK_MS } from "./editor-port.ts";
import { type EditorStateAnswer, PS_TIMEOUT_MS, ReopenState } from "./editor-reopen.ts";
import { EditorStart } from "./editor-status.ts";
import {
  EditorHealth,
  type HealthRead,
  healthAnswer,
  inRun,
  MOMENT_WORDS,
  restoreBlock,
  type SaveRead,
  SaveOutcome,
  saveAnswer,
} from "./hook-answers.ts";
import type { HelperUpdate } from "./setup.ts";
import { HelperState } from "./setup.ts";

/** Unreal is gone only after this many asks in a row, this far apart, find no answer and no editor process. */
const GONE_CHECKS = 3;
const GONE_CHECK_GAP_MS = 5 * SECOND_MS;
/** How long a restore waits for a busy editor to answer again, asking this often: a build script may hold it four minutes. */
export const BUSY_WAIT_MS = 5 * MINUTE_MS;
const BUSY_POLL_MS = 15 * SECOND_MS;
/**
 * The longest one editor call under a moment may take, its session with the editor included
 * (`callProjectTool`), before the step stops waiting for it: a play session's state or its stop,
 * the editor's activity and one of the reference exports. Unreal may go on with the work; the step
 * answers in its own words within its budget.
 */
export const MOMENT_ASK_MS = 15 * SECOND_MS;
/** The longest the editor's own save may take before a restore and at a run's start, where the busy wait leaves it less. */
export const MOMENT_SAVE_CALL_MS = MINUTE_MS;
/** The longest the editor's own save may take at a checkpoint, within the checkpoint step's ceiling. */
export const CHECKPOINT_SAVE_CALL_MS = 90 * SECOND_MS;
/** How long `save-all` waits for a play session it stopped to end (it ends on a later frame), and how often it asks. */
export const PLAY_STOP_WAIT_MS = 15 * SECOND_MS;
export const PLAY_STOP_POLL_MS = 250;
/** One ask of where Unreal stands: whether it answers (`ANSWER_CHECK_MS`), then whether its editor process runs (`ps`). */
const CHECK_TAKES_MS = ANSWER_CHECK_MS + PS_TIMEOUT_MS;
/** `editor-state`: one such ask, its reopen job and its helper (read from the project's folder). */
const STATE_TAKES_MS = CHECK_TAKES_MS;
/** Where Unreal stands (`lifeOf`): up to {@link GONE_CHECKS} asks and the gaps between them. */
const LIFE_TAKES_MS = GONE_CHECKS * CHECK_TAKES_MS + (GONE_CHECKS - 1) * GONE_CHECK_GAP_MS;
/** A busy editor waited for (`lifeAfterBusy`): its window, and the last look started within it. */
const BUSY_TAKES_MS = BUSY_WAIT_MS + LIFE_TAKES_MS;
/** How long each editor call of a save may take (`MOMENT_ASK_MS`, and the save's own). */
type SaveLimits = { askMs: number; saveMs: number };
/** The save's limits before a restore and at a run's start. */
export const MOMENT_SAVE: SaveLimits = { askMs: MOMENT_ASK_MS, saveMs: MOMENT_SAVE_CALL_MS };
/** The save's limits at a checkpoint. */
export const CHECKPOINT_SAVE: SaveLimits = { askMs: MOMENT_ASK_MS, saveMs: CHECKPOINT_SAVE_CALL_MS };
/**
 * How long the editor's save may take: whether Unreal answers, whether it plays, its stop and the
 * stop's own wait with a last ask after it, then the save itself.
 */
const saveTakes = ({ askMs, saveMs }: SaveLimits): number =>
  ANSWER_CHECK_MS + 2 * askMs + PLAY_STOP_WAIT_MS + askMs + PLAY_STOP_POLL_MS + saveMs;
const SAVE_TAKES_MS = saveTakes(MOMENT_SAVE);
/** The longest `save-all` at a checkpoint: whether Unreal answers, its activity, then the save. */
export const CHECKPOINT_SAVE_MAX_MS = ANSWER_CHECK_MS + MOMENT_ASK_MS + saveTakes(CHECKPOINT_SAVE);
/** The reference exports a run's start may ask for (the node reference, the Python names, the project file). */
const EXPORT_CALLS = 3;
/** The longest `save-all` before a restore runs: the busy wait, then the save. */
export const RESTORE_SAVE_MAX_MS = BUSY_TAKES_MS + SAVE_TAKES_MS;
/** How long a run's start waits for Unreal to open and answer, asking this often. */
const OPEN_WAIT_MS = 6 * MINUTE_MS;
const OPEN_POLL_MS = 5 * SECOND_MS;
/** How long a helper update waits for a closed editor's process to exit, asking this often. */
const EXIT_WAIT_MS = 60 * SECOND_MS;
const EXIT_POLL_MS = 2 * SECOND_MS;
/** The wait for a closed editor's process to exit (`processGone`): its window, a last `ps` and its gap. */
const EXIT_TAKES_MS = EXIT_WAIT_MS + PS_TIMEOUT_MS + EXIT_POLL_MS;
/** How long ending the editor or updating its helper may each take. */
const STEP_TAKES_MS = MINUTE_MS;
/** How long exporting the template's facts may take: each of its calls within `MOMENT_ASK_MS`. */
const EXPORT_TAKES_MS = EXPORT_CALLS * MOMENT_ASK_MS;
/** The wait for a reopened Unreal (`untilOpen`): its window, a last `editor-state` and its gap. */
const OPEN_WAIT_TAKES_MS = OPEN_WAIT_MS + STATE_TAKES_MS + OPEN_POLL_MS;
/** The longest wait for Unreal to answer at a run's start: a busy editor, then its reopen. */
const OPEN_MAX_MS = BUSY_TAKES_MS + OPEN_WAIT_TAKES_MS;
/**
 * The longest `open-for-run`: where Unreal and its helper stand, Unreal opened, its work saved, the
 * editor ended, its process gone, the helper updated, Unreal opened again and the template's facts
 * exported. Genex's ceiling for a run's start (`HOOK_CALL_MS`) stays above it, so the step always
 * answers in its own words.
 */
export const OPEN_FOR_RUN_MAX_MS =
  2 * STATE_TAKES_MS + 2 * OPEN_MAX_MS + SAVE_TAKES_MS + 2 * STEP_TAKES_MS + EXIT_TAKES_MS + EXPORT_TAKES_MS;

/** What the editor's save answered: whether it saved, and what it left unsaved. */
type Saved = { saved: boolean; dirty: string[] };

/** The editor operations a moment uses, for one game; each may throw. */
export type MomentOps = {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  signal: AbortSignal;
  /** Whether the game's Unreal answers now; a failed ask is a no. */
  answers(): Promise<boolean>;
  /** Whether the project's editor process runs; null when that can't be told. */
  running(): Promise<boolean | null>;
  /** The editor's activity; throws when it can't say. */
  activity(): Promise<{ pie: boolean; dirty: number }>;
  /** Whether a checkpoint's save may end the play under way: the agent's own, or a run's while agents may use Unreal as the person plays. */
  mayEndPlay(): Promise<boolean>;
  /** Saves the editor's work (a play session ended first), each editor call within its moment's limit; throws its refusal. */
  save(): Promise<Saved>;
  /** Ends the project's editor; throws when it couldn't. */
  end(): Promise<unknown>;
  /** Starts reopening the game's Unreal in the background, updating an outdated helper while it is closed when asked. */
  reopen(updateHelper: boolean): Promise<unknown>;
  /** `editor-state`: whether Unreal answers and runs, how reopening goes, and the project's helper. */
  state(): Promise<EditorStateAnswer>;
  /** Where Genex's own start of the project stands; null when no set-up project is linked. */
  start(): Promise<EditorStart | null>;
  /** The project's name, or null without a linked project. */
  projectName(): Promise<string | null>;
  updateHelper(): Promise<HelperUpdate>;
  /** Whether the editor exported the template's facts for the project. */
  exported(): Promise<boolean>;
  /** Has the editor export the template's facts, each call within `MOMENT_ASK_MS`. */
  exportReference(): Promise<unknown>;
  /** This game's memory that a restore's `end-editor` closed a running Unreal: set, then taken once by its `reopen-editor`. */
  restoreClosed: { mark(): void; take(): boolean };
};

/** Where the game's Unreal stands once asked: it answers, is busy, is gone, or nobody can tell. */
const Life = { Answers: "answers", Busy: "busy", Gone: "gone", Unknown: "unknown" } as const;
type Life = (typeof Life)[keyof typeof Life];

/** A health check's reading of each. */
const LIFE_HEALTH = {
  [Life.Answers]: EditorHealth.Answers,
  [Life.Busy]: EditorHealth.Busy,
  [Life.Gone]: EditorHealth.Gone,
  [Life.Unknown]: EditorHealth.Unknown,
} as const satisfies Record<Life, EditorHealth>;

/** Waits `ms` unless the call was stopped; whether it may go on. */
async function paused(ops: MomentOps, ms: number): Promise<boolean> {
  if (ops.signal.aborted) return false;
  await ops.sleep(ms, ops.signal).catch(() => undefined);
  return !ops.signal.aborted;
}

/**
 * Where Unreal stands: it answers within {@link GONE_CHECKS} asks; it is busy as soon as an ask finds
 * its process running; else gone when the last ask found none of it, and unknown when that can't be told.
 */
async function lifeOf(ops: MomentOps): Promise<Life> {
  for (let check = 1; ; check += 1) {
    if (await ops.answers()) return Life.Answers;
    const running = await ops.running().catch(() => null);
    if (running === true) return Life.Busy;
    if (check >= GONE_CHECKS || !(await paused(ops, GONE_CHECK_GAP_MS)))
      return running === false ? Life.Gone : Life.Unknown;
  }
}

/**
 * Where Unreal stands once a busy editor answers again, or {@link BUSY_WAIT_MS} has gone by: no
 * look starts past that window, so the wait ends within it and one last look.
 */
async function lifeAfterBusy(ops: MomentOps): Promise<Life> {
  const ends = ops.now() + BUSY_WAIT_MS;
  let life = await lifeOf(ops);
  while (life === Life.Busy && ops.now() + BUSY_POLL_MS <= ends && (await paused(ops, BUSY_POLL_MS)))
    life = await lifeOf(ops);
  return life;
}

/** The editor's save, read: what it saved and left, or why it failed. */
async function saving(ops: MomentOps, dirty: number): Promise<SaveRead> {
  try {
    const saved = await ops.save();
    if (saved.saved && saved.dirty.length === 0) return { outcome: SaveOutcome.Saved, count: dirty };
    return { outcome: SaveOutcome.LeftUnsaved, names: saved.dirty, saved: saved.saved };
  } catch (failure) {
    return { outcome: SaveOutcome.Failed, why: errorMessage(failure) };
  }
}

/**
 * A checkpoint's save: never during a play session it may not end (the save ends one it may) or of
 * an editor that can't say whether one runs.
 * A run saves even with nothing unsaved (as its save points did); a chat saves only what is unsaved.
 */
async function checkpointSave(ops: MomentOps, hook: HookContext): Promise<SaveRead> {
  if (!(await ops.answers())) return { outcome: SaveOutcome.NotAnswering };
  const activity = await ops.activity().catch(() => null);
  if (!activity) return { outcome: SaveOutcome.CantTell };
  if (activity.pie && !(await ops.mayEndPlay().catch(() => false))) return { outcome: SaveOutcome.Playing };
  if (activity.dirty === 0 && !inRun(hook)) return { outcome: SaveOutcome.Clean };
  return saving(ops, activity.dirty);
}

/** Why the editor's work isn't all saved before a restore, or null when it is. */
async function unsavedWork(ops: MomentOps): Promise<string | null> {
  try {
    const saved = await ops.save();
    return !saved.saved || saved.dirty.length > 0 ? MOMENT_WORDS.Unsaved(saved.dirty) : null;
  } catch (failure) {
    return errorMessage(failure);
  }
}

/** Whether the game is linked to an Unreal project: a folder whose `.uproject` isn't linked has no Unreal of Genex's to save or end. */
async function linked(ops: MomentOps): Promise<boolean> {
  return (await ops.projectName().catch(() => null)) !== null;
}

/**
 * `save-all` before a restore: an editor that isn't there (or a game with no linked project) has
 * nothing to save; a busy one is waited for, and one that stays busy, or whose save fails or leaves
 * work, blocks the restore (Unreal stays open).
 */
async function restoreSave(ops: MomentOps): Promise<HookAnswer> {
  if (!(await linked(ops))) return {};
  const life = await lifeAfterBusy(ops);
  if (life === Life.Busy) return restoreBlock(MOMENT_WORDS.StayedBusy);
  if (life !== Life.Answers) return {};
  const unsaved = await unsavedWork(ops);
  return unsaved ? restoreBlock(unsaved) : {};
}

/** `save-all` at a moment: before a restore, or at a checkpoint by the run's or the chat's policy. */
export async function saveAtMoment(ops: MomentOps, hook: HookContext): Promise<HookAnswer> {
  if (hook.on === HookEvent.RestoreBefore) return restoreSave(ops);
  return saveAnswer(await checkpointSave(ops, hook), hook);
}

/** Whether the game's Unreal is up: it answers, or its editor process runs. */
async function editorUp(ops: MomentOps): Promise<boolean> {
  return (await ops.answers()) || (await ops.running().catch(() => null)) === true;
}

/**
 * `end-editor` before a restore: blocked when Unreal couldn't be closed (it still answers, or a
 * process outlived the kill). An Unreal it closed is remembered, so the restore reopens only that;
 * a mark an earlier restore left (stopped or blocked before its after steps) is forgotten first,
 * so no later restore reopens an Unreal the person closed since. A game with no linked project has
 * no Unreal to end: its restore goes on.
 */
export async function endAtMoment(ops: MomentOps): Promise<HookAnswer> {
  ops.restoreClosed.take();
  if (!(await linked(ops))) return {};
  try {
    const wasUp = await editorUp(ops);
    await ops.end();
    if (wasUp) ops.restoreClosed.mark();
    return {};
  } catch (failure) {
    return { block: MOMENT_WORDS.NotEnded(errorMessage(failure)) };
  }
}

/**
 * Whether `reopen-editor` reopens at this moment: always after a crash and after a run's restore
 * (the run works in Unreal), and after any other restore (the person's Rewind among them) only
 * when that restore closed a running Unreal: a closed one stays closed. A restore of a game with no
 * linked project closed nothing, so nothing reopens.
 */
async function reopensAt(ops: MomentOps, hook: HookContext): Promise<boolean> {
  if (hook.on !== HookEvent.RestoreAfter) return true;
  const closed = ops.restoreClosed.take();
  return closed || (inRun(hook) && (await linked(ops)));
}

/** `reopen-editor` after a restore or a crash: starts reopening (health says how it goes); a refusal is a note. */
export async function reopenAtMoment(ops: MomentOps, hook: HookContext): Promise<HookAnswer> {
  if (!(await reopensAt(ops, hook))) return {};
  try {
    await ops.reopen(true);
    return {};
  } catch (failure) {
    return { note: MOMENT_WORDS.NotReopened(errorMessage(failure)) };
  }
}

/** Where Unreal stands when it doesn't answer: Genex is opening it, its port is blocked, or busy, gone or unknown. */
async function silentHealth(ops: MomentOps, project: string | null): Promise<HealthRead> {
  const start = await ops.start().catch(() => null);
  if (start === null && project === null) return { health: EditorHealth.NoProject };
  if (start === EditorStart.Starting) return { health: EditorHealth.Starting, project };
  if (start === EditorStart.PortBlocked) return { health: EditorHealth.PortBlocked, project };
  return { health: LIFE_HEALTH[await lifeOf(ops)], project };
}

/** Where Unreal stands for a health check. */
async function healthOf(ops: MomentOps): Promise<HealthRead> {
  const state = await ops.state();
  if (state.reopening.state === ReopenState.Reopening) return { health: EditorHealth.Reopening };
  if (state.answering) return { health: EditorHealth.Answers };
  if (state.reopening.state === ReopenState.Failed)
    return { health: EditorHealth.ReopenFailed, error: state.reopening.error ?? "" };
  return silentHealth(ops, await ops.projectName().catch(() => null));
}

/** `editor-state` at `health`: quiet while Unreal answers, pending while it may yet, blocked once it can't. */
export async function healthAtMoment(ops: MomentOps, hook: HookContext): Promise<HookAnswer> {
  return healthAnswer(await healthOf(ops), hook);
}

/** Waits until Unreal answers (its reopen done), up to {@link OPEN_WAIT_MS}; why it didn't, or null once it does. */
async function untilOpen(ops: MomentOps): Promise<string | null> {
  const ends = ops.now() + OPEN_WAIT_MS;
  while (ops.now() < ends) {
    const state = await ops.state();
    if (state.reopening.state === ReopenState.Failed) return MOMENT_WORDS.ReopenFailed(state.reopening.error ?? "");
    const reopened = state.reopening.state === ReopenState.Done || state.reopening.state === ReopenState.Idle;
    if (state.answering && reopened) return null;
    if (!(await paused(ops, OPEN_POLL_MS))) return MOMENT_WORDS.Stopped;
  }
  return MOMENT_WORDS.OpenTimedOut(OPEN_WAIT_MS / MINUTE_MS);
}

/**
 * Unreal answers before the run's first turn, or is reopened: a busy one is waited for (and left
 * open, its work unsaved, when it stays busy); one that is gone is reopened and waited for. The
 * reason it couldn't be opened, or null.
 */
async function ensureOpen(ops: MomentOps): Promise<string | null> {
  const life = await lifeAfterBusy(ops);
  if (life === Life.Answers) return null;
  if (life === Life.Busy) return MOMENT_WORDS.RestoreNotSaved(MOMENT_WORDS.StayedBusy);
  // A Stop (or Genex's ceiling) ends the step here: nothing is opened after it.
  if (ops.signal.aborted) return MOMENT_WORDS.StoppedBeforeOpen;
  try {
    await ops.reopen(false);
  } catch (failure) {
    return MOMENT_WORDS.NotOpened(errorMessage(failure));
  }
  const why = await untilOpen(ops);
  return why === null ? null : MOMENT_WORDS.NotOpened(why);
}

/** Waits, up to {@link EXIT_WAIT_MS}, until the closed editor's process has exited: its files can't be updated while it runs. */
async function processGone(ops: MomentOps): Promise<void> {
  const ends = ops.now() + EXIT_WAIT_MS;
  while (ops.now() < ends && (await ops.running().catch(() => null)) === true) {
    if (!(await paused(ops, EXIT_POLL_MS))) return;
  }
}

/**
 * The project's Genex editor helper brought up to the plugin's: Unreal saved (a save that fails
 * leaves it open and the helper as it was), closed, its process gone, the update, and Unreal
 * reopened. What the person is told, and why Unreal couldn't be reopened after, if it couldn't. A
 * Stop updates nothing after it, but an Unreal the step closed is still reopened, as a restore's
 * after steps reopen what its before steps closed: a run that ends leaves the editor open.
 */
async function updateClosed(ops: MomentOps): Promise<{ note: string; reopenFailed: string | null }> {
  const unsaved = await unsavedWork(ops);
  const closed = unsaved
    ? { note: MOMENT_WORDS.HelperNotUpdated(MOMENT_WORDS.KeptOpen(unsaved)), ended: false }
    : await closedUpdate(ops);
  if (!ops.signal.aborted) return { note: closed.note, reopenFailed: await ensureOpen(ops) };
  return { note: closed.ended ? await reopenAfterStop(ops, closed.note) : closed.note, reopenFailed: null };
}

/** An Unreal the step closed, reopened after a Stop with no helper update and no wait: the note, or why it couldn't start. */
async function reopenAfterStop(ops: MomentOps, note: string): Promise<string> {
  try {
    await ops.reopen(false);
    return note;
  } catch (failure) {
    return MOMENT_WORDS.NotReopened(errorMessage(failure));
  }
}

/** Ends Unreal, waits for its process to exit and updates the helper: what the person is told, and whether Unreal was ended. */
async function closedUpdate(ops: MomentOps): Promise<{ note: string; ended: boolean }> {
  // A Stop during the save before it: Unreal is neither closed nor updated.
  if (ops.signal.aborted) return { note: MOMENT_WORDS.StoppedBeforeClose, ended: false };
  try {
    await ops.end();
  } catch (failure) {
    return { note: MOMENT_WORDS.HelperNotUpdated(errorMessage(failure)), ended: false };
  }
  try {
    await processGone(ops);
    // A Stop while Unreal closed or its process exited: the helper stays as it was, even if the process still runs.
    if (ops.signal.aborted) return { note: MOMENT_WORDS.StoppedAfterClose, ended: true };
    const updated = await ops.updateHelper();
    return { note: MOMENT_WORDS.HelperUpdated(updated.to), ended: true };
  } catch (failure) {
    return { note: MOMENT_WORDS.HelperNotUpdated(errorMessage(failure)), ended: true };
  }
}

/**
 * `open-for-run` at a run's start: Unreal open, with the plugin's Genex editor helper and the
 * template's facts exported. Blocked when Unreal can't be opened or the project has no helper (the
 * Loop can't save or capture it). No snapshot is taken before a helper update: the update replaces
 * only the helper's folder, which the game's history holds.
 */
export async function openForRun(ops: MomentOps): Promise<HookAnswer> {
  // Unreal answers Genex only through its helper: a project without one is told so before any open.
  const before = await ops.state().catch(() => null);
  if (before?.helper === HelperState.Missing) return { block: MOMENT_WORDS.NoHelper };
  const unopened = await ensureOpen(ops);
  if (unopened) return { block: unopened };
  const { helper } = await ops.state();
  if (helper === HelperState.Missing) return { block: MOMENT_WORDS.NoHelper };
  const update = helper === HelperState.Outdated ? await updateClosed(ops) : null;
  if (update?.reopenFailed) return { block: update.reopenFailed, note: update.note };
  if (update && ops.signal.aborted) return { note: update.note };
  // A project that never exported its facts has the editor export them once; a failed export is the gate's to live with.
  if (!(await ops.exported().catch(() => false))) await ops.exportReference().catch(() => undefined);
  return update ? { note: update.note } : {};
}
