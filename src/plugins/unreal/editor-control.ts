/**
 * The agent's own hold on this game's Unreal Editor, so a chat never hands the person a step Genex
 * can take. `open-editor` opens the game's linked project, answering at once while it opens in the
 * background: what is left of a crashed editor of it and its crash reporter is ended first, and an
 * editor of it that runs without answering is ended only when the agent asks for a `restart` (it
 * may be busy, and its unsaved work is lost), or at once when its own log says Epic's server
 * couldn't listen on the game's port. `quit-editor` saves every unsaved level and asset in it, then
 * sends Unreal's own quit and waits for it to close; it never terminates or kills an editor, so
 * work made after the save, or a question Unreal asks before quitting, is never lost. `editor-status` answers what the
 * Loop's `editor-state` does (a hooked tool, the harness's alone), waiting up to `seconds` for an
 * opening to end. Opening and quitting need the game's editor lock (`needs: ["editor"]` in the
 * manifest), so none runs while the Loop holds the editor.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import { PortBlockedError } from "./editor-log.ts";
import { pollUntil } from "./editor-queue.ts";
import { type EditorStateAnswer, type ReopenAnswer, ReopenState } from "./editor-reopen.ts";
import { QUIT_WAIT_MS } from "./editor-restart.ts";
import { EditorStart } from "./editor-status.ts";
import { WAIT_EDITOR_MAX_MS } from "./editor-wait.ts";

/** The agent's editor tools, by their names after `unreal__`. */
export const EditorControlToolName = {
  OpenEditor: "open-editor",
  QuitEditor: "quit-editor",
  EditorStatus: "editor-status",
} as const;
export type EditorControlToolName = (typeof EditorControlToolName)[keyof typeof EditorControlToolName];

/**
 * `open-editor`'s answer: Unreal already answers, Genex started opening it (`started`), Unreal is
 * already opening it (`starting`), or its editor runs without answering and was left alone (`busy`).
 */
export type OpenEditorAnswer = ReopenAnswer | { starting: true } | { busy: true; next: string };
/** `quit-editor`'s answer: how many of the project's editor and crash-reporter processes ended. */
export type QuitEditorAnswer = { closed: true };

/** How often `quit-editor` looks whether Unreal closed. */
const QUIT_POLL_MS = 2 * SECOND_MS;
/** How often a waiting `editor-status` looks again. */
const STATE_POLL_MS = 3 * SECOND_MS;

const MESSAGE = {
  NoProject:
    "This game isn't linked to an Unreal project yet. Call unreal__use-project with its .uproject path (or unreal__new-game to make one), then call this again.",
  Busy: "This game's Unreal runs but doesn't answer yet: it may be busy (a long script, shaders, a level loading) or hung behind a dialog. Call unreal__editor-status with seconds to wait for it; if it still doesn't answer, call unreal__open-editor with restart: true, which ends it (work not saved in it is lost) and opens it again.",
  NotAnswering:
    "This game's Unreal runs but doesn't answer, so Genex can't save its work and didn't quit it. Call unreal__editor-status with seconds to wait for it; if it still doesn't answer, unreal__open-editor with restart: true ends it (work not saved in it is lost) and opens it again.",
  Unsaved: (names: string) => `Unreal didn't save ${names}, so Genex left it open.`,
  NotQuit: `Genex saved this game's work and asked Unreal to quit, but it is still open after ${QUIT_WAIT_MS / SECOND_MS} s: it may be asking a question, or another Unreal editor is open (Genex quits only when one is). Call unreal__quit-editor again in a moment; if it stays open, ask the user to look at Unreal.`,
} as const;
/** The most unsaved packages a refusal names. */
const MAX_UNSAVED_NAMED = 5;

/** What the agent's editor tools need: the game's project, its editor, Genex's start of it, the reopen jobs, a save and the clock. */
export type EditorControlDeps = {
  project(storage: string, game: string): Promise<string | undefined>;
  /** Whether the game's editor answers; throws {@link PortBlockedError} when its log says it never will. */
  editorAnswers(storage: string, game: string): Promise<boolean>;
  /** Where Genex's own start of the game's project stands; null without one. */
  starting?(storage: string, game: string): Promise<EditorStart | null>;
  /** Sets the game's linked project up here when this profile has no set-up record of it; may quit Unreal first. */
  setUp?(storage: string, game: string): Promise<void>;
  /** Saves every unsaved level and asset in the game's open editor (a play session ended first); what stayed unsaved. */
  save(storage: string, game: string): Promise<{ dirty: string[] }>;
  /** Unreal's own quit for the project (the panel's Quit); refuses with two editors open. */
  quit(storage: string, project: string): Promise<unknown>;
  reopen: {
    open(storage: string, game: string): Promise<ReopenAnswer>;
    state(storage: string, game: string): Promise<EditorStateAnswer>;
    running(storage: string, game: string): Promise<boolean | null>;
  };
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
};

/** Whether the game's editor answers, or why it never will: its port is blocked. */
async function answerOf(deps: EditorControlDeps, storage: string, game: string): Promise<boolean | "blocked"> {
  try {
    return await deps.editorAnswers(storage, game);
  } catch (failure) {
    return failure instanceof PortBlockedError ? "blocked" : false;
  }
}

/** The game's linked project; throws, telling the agent how to link one, without it. */
async function linkedProject(deps: EditorControlDeps, storage: string, game: string): Promise<string> {
  const project = await deps.project(storage, game).catch(() => undefined);
  if (!project) throw new Error(MESSAGE.NoProject);
  return project;
}

/**
 * `open-editor`: nothing when Unreal answers or is opening the project; an editor of it that runs
 * without answering is left alone unless `restart` (or its port is blocked); otherwise the reopen
 * job ends what is left of it and opens the project.
 */
async function openEditor(deps: EditorControlDeps, storage: string, game: string, restart: boolean) {
  await linkedProject(deps, storage, game);
  // A project another Genex profile set up is recorded here first, so Genex can reach it once open.
  await deps.setUp?.(storage, game);
  const answers = await answerOf(deps, storage, game);
  if (answers === true) return { answering: true } as const;
  const start = (await deps.starting?.(storage, game).catch(() => null)) ?? null;
  const blocked = answers === "blocked" || start === EditorStart.PortBlocked;
  if (!restart && start === EditorStart.Starting) return { starting: true } as const;
  const running = await deps.reopen.running(storage, game);
  const mayEnd = restart || blocked || running === false;
  if (!mayEnd) return { busy: true, next: MESSAGE.Busy } as const;
  return deps.reopen.open(storage, game);
}

/**
 * `quit-editor`: saves the game's editor, then sends Unreal's own quit and waits up to
 * {@link QUIT_WAIT_MS} for it to close. Nothing is sent to an editor that doesn't answer (its work
 * can't be saved) or whose work stayed unsaved; one still open after the wait is left open.
 */
async function quitEditor(deps: EditorControlDeps, storage: string, game: string): Promise<QuitEditorAnswer> {
  const project = await linkedProject(deps, storage, game);
  const closed = async () => (await deps.reopen.running(storage, game)) === false;
  if ((await answerOf(deps, storage, game)) !== true) {
    if (await closed()) return { closed: true };
    throw new Error(MESSAGE.NotAnswering);
  }
  const { dirty } = await deps.save(storage, game);
  if (dirty.length > 0) throw new Error(MESSAGE.Unsaved(dirty.slice(0, MAX_UNSAVED_NAMED).join(", ")));
  await deps.quit(storage, project).catch(() => {
    throw new Error(MESSAGE.NotQuit);
  });
  if (!(await pollUntil(deps, closed, QUIT_POLL_MS, QUIT_WAIT_MS))) throw new Error(MESSAGE.NotQuit);
  return { closed: true };
}

/** The seconds an `editor-status` call waits, whole and at most {@link WAIT_EDITOR_MAX_MS}; anything else is 0. */
function waitMsOf(args: Record<string, unknown>): number {
  const seconds = Number(args.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(Math.floor(seconds) * SECOND_MS, WAIT_EDITOR_MAX_MS);
}

/** Whether an opening has ended: Unreal answers, the reopen failed, or nothing opens it any more. */
async function settled(deps: EditorControlDeps, storage: string, game: string, state: EditorStateAnswer) {
  if (state.reopening.state === ReopenState.Failed) return true;
  // A reopen job ends once it sees Unreal answer: its own end, not only the answer, is waited for.
  if (state.reopening.state === ReopenState.Reopening) return false;
  if (state.answering) return true;
  return (await deps.starting?.(storage, game).catch(() => null)) !== EditorStart.Starting;
}

/**
 * The agent's `editor-status`: where the game's Unreal stands, after waiting up to `seconds` for an
 * opening to end (Unreal answers, its reopen fails, or nothing opens it any more).
 */
async function waitState(
  deps: EditorControlDeps,
  storage: string,
  game: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<EditorStateAnswer> {
  const ends = deps.now() + waitMsOf(args);
  for (;;) {
    const state = await deps.reopen.state(storage, game);
    if (deps.now() >= ends || signal.aborted || (await settled(deps, storage, game, state))) return state;
    await deps.sleep(STATE_POLL_MS, signal).catch(() => undefined);
  }
}

/** The agent's editor tools over the reopen jobs: open, quit, and a state that can wait. */
export function createEditorControl(deps: EditorControlDeps) {
  return {
    open: (storage: string, game: string, args: Record<string, unknown>): Promise<OpenEditorAnswer> =>
      openEditor(deps, storage, game, args.restart === true),
    quit: (storage: string, game: string) => quitEditor(deps, storage, game),
    state: (storage: string, game: string, args: Record<string, unknown>, signal: AbortSignal) =>
      waitState(deps, storage, game, args, signal),
  };
}
