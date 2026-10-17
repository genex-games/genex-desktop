/**
 * What the runner's background jobs that restart Unreal share (`cpp-tools.ts` adds the game's C++
 * module, `editor-reopen.ts` reopens a crashed editor): quitting and opening the game's project as
 * the panel's Quit and Open do, waiting until the project answers again, naming a failed build's
 * first errors, and keeping one job per project with its state, error and time for the runner to read.
 */
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { isJsonObject } from "../../substrate/fsx.ts";
import { PortBlockedError } from "./editor-log.ts";
import { pollUntil } from "./editor-queue.ts";
import type { CompileResult } from "./ubt.ts";

/**
 * How many Unreal editors run, and quitting and opening a project's, as the panel's Quit and Open
 * do; `forget` drops Genex's record that it is opening the project, which would keep Open from
 * opening a project whose editor is gone.
 */
export type EditorRestart = {
  editors(): Promise<number>;
  quit(storage: string, project: string): Promise<unknown>;
  open(storage: string, project: string): Promise<unknown>;
  forget?(storage: string, project: string): Promise<void>;
};

/** What waiting for a game's editor needs: whether it answers, the restart, and the clock. */
export type RestartDeps = {
  editorAnswers(storage: string, game: string): Promise<boolean>;
  restart: EditorRestart;
  now(): number;
  sleep(ms: number): Promise<void>;
};

/** One job's game: the plugin's storage, the game and its linked project's `.uproject`. */
export type RestartTarget = { storage: string; game: string; project: string };

/** How often a job looks at Unreal, and how long it waits for the project to answer once opened. */
export const RESTART_POLL_MS = 2 * SECOND_MS;
export const OPEN_WAIT_MS = 5 * MINUTE_MS;
/** How long a job waits for Unreal to close. */
export const QUIT_WAIT_MS = 90 * SECOND_MS;
/** How many of a failed build's errors a job's error names. */
const MAX_BUILD_ERRORS = 3;
/** The most unsaved packages a refusal names. */
const MAX_UNSAVED_NAMED = 5;

/** What closing Unreal for a build says when it can't: each job words it for what it was about to do. */
export type CloseWords = {
  otherEditor: string;
  notSaved(why: string): string;
  noSaveAnswer: string;
  unsaved(names: string): string;
  notClosed: string;
  /** The call was stopped before Unreal was asked to quit. */
  stopped?: string;
};

/** Saves every unsaved level and asset through `save` (the Genex editor helper's save_all); throws why it couldn't. */
async function saveAll(save: () => Promise<unknown>, words: CloseWords): Promise<void> {
  const answer = await save().catch((failure: unknown) => ({ error: errorMessage(failure) }));
  const reply = isJsonObject(answer) ? answer : {};
  if (reply.error !== undefined) throw new Error(words.notSaved(String(reply.error)));
  if (!Array.isArray(reply.dirty)) throw new Error(words.notSaved(words.noSaveAnswer));
  const unsaved = reply.dirty.filter((name): name is string => typeof name === "string");
  if (unsaved.length > 0) throw new Error(words.unsaved(unsaved.slice(0, MAX_UNSAVED_NAMED).join(", ")));
}

/**
 * Closes Unreal for a build when this game's editor is open: saves its work, quits it the normal
 * way and waits until no editor runs. Answers whether it was open; refuses an editor that runs
 * without this game's project answering (its work can't be saved, and it may be another project's).
 * A `signal` that aborts before the quit is asked for stops it there, Unreal left open.
 */
export async function closeForBuild(
  deps: RestartDeps,
  target: RestartTarget,
  save: () => Promise<unknown>,
  words: CloseWords,
  signal?: AbortSignal,
): Promise<boolean> {
  const stopped = () => {
    if (signal?.aborted) throw new Error(words.stopped ?? words.notClosed);
  };
  stopped();
  const answers = await deps.editorAnswers(target.storage, target.game).catch(() => false);
  if (!answers) {
    if ((await deps.restart.editors()) > 0) throw new Error(words.otherEditor);
    return false;
  }
  stopped();
  await saveAll(save, words);
  stopped();
  await deps.restart.quit(target.storage, target.project);
  const closed = await pollUntil(deps, async () => (await deps.restart.editors()) === 0, RESTART_POLL_MS, QUIT_WAIT_MS);
  if (!closed) throw new Error(words.notClosed);
  return true;
}

/** Whether the game's editor answers; a failed ask is a no, but an editor that can never answer ends the wait. */
export async function answering(deps: RestartDeps, target: Omit<RestartTarget, "project">): Promise<boolean> {
  try {
    return await deps.editorAnswers(target.storage, target.game);
  } catch (failure) {
    if (failure instanceof PortBlockedError) throw failure;
    return false;
  }
}

/**
 * Opens the game's project in Unreal (once its port is free) and waits until it answers; throws
 * `notAnswering` when it doesn't within {@link OPEN_WAIT_MS}, or at once when Epic's server couldn't
 * listen on the game's port.
 */
export async function openAndWait(deps: RestartDeps, target: RestartTarget, notAnswering: string): Promise<void> {
  await deps.restart.open(target.storage, target.project);
  const answers = () => answering(deps, target);
  if (!(await pollUntil(deps, answers, RESTART_POLL_MS, OPEN_WAIT_MS))) throw new Error(notAnswering);
}

/** A failed build's first errors, each on a line of its own. */
export function buildErrors(result: Pick<CompileResult, "errors">): string {
  const lines = result.errors
    .slice(0, MAX_BUILD_ERRORS)
    .map((e) => (e.file ? `${e.file}:${e.line}: ${e.message}` : e.message));
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

/** A background job as the runner reads it: its state, why it failed, and how long it took once done. */
export type JobRecord<State extends string> = { state: State; error?: string; seconds?: number };
/** The wire values of a job's three moving states. */
export type JobStates<State extends string> = { running: State; done: State; failed: State };

/**
 * Runs `work` in the background as `key`'s job: recorded running at once, then done with its
 * seconds or failed with why.
 */
export function runJob<State extends string>(
  jobs: Map<string, JobRecord<State>>,
  key: string,
  states: JobStates<State>,
  now: () => number,
  work: () => Promise<void>,
): void {
  jobs.set(key, { state: states.running });
  const started = now();
  void work().then(
    () => jobs.set(key, { state: states.done, seconds: Math.round((now() - started) / SECOND_MS) }),
    (failure: unknown) => jobs.set(key, { state: states.failed, error: errorMessage(failure) }),
  );
}
