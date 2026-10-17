/**
 * Reopening Unreal after it went away under the Unreal lead, as an older runner did it: it had the
 * plugin reopen it (`reopen-editor`) and asked `editor-state` until Unreal answered again. The
 * runner reopens Unreal through Genex's crash moment and waits on Genex's health check now
 * (`../hooks.ts`), so no current module calls this; it stays because an older copy of `restore.ts`
 * an agent kept imports it. Every answer is read as data.
 */
import type { AnyRecord } from "../../types/harness.d.ts";
import { CLIP_DETAIL, clip } from "../text.ts";
import { MINUTE_MS, minutes, SECOND_MS } from "../time.ts";

/** Where reopening Unreal stands, as the plugin's `editor-state` names it. */
export const ReopenState = { Idle: "idle", Reopening: "reopening", Done: "done", Failed: "failed" } as const;
export type ReopenState = (typeof ReopenState)[keyof typeof ReopenState];

/** How waiting for Unreal to reopen ended: it answers, the run was stopped or its time ran out, or it failed. */
export const ReopenEnd = { Open: "open", Stopped: "stopped", TimeUp: "time-up", Failed: "failed" } as const;
export type Reopened =
  | { end: typeof ReopenEnd.Open | typeof ReopenEnd.Stopped | typeof ReopenEnd.TimeUp }
  | { end: typeof ReopenEnd.Failed; why: string };

/** How often the editor's state is asked about while Unreal reopens, and how long reopening may take. */
export const REOPEN_POLL_MS = 5 * SECOND_MS;
export const REOPEN_TIMEOUT_MS = 6 * MINUTE_MS;
const REOPEN_STATES: ReadonlySet<string> = new Set(Object.values(ReopenState));

const MESSAGE = {
  Refused: (error: string) => `reopening Unreal was refused: ${error || "no reason given"}`,
  Failed: (error: string) => `reopening Unreal failed: ${error || "no reason given"}`,
  TimedOut: `Unreal didn't answer within ${minutes(REOPEN_TIMEOUT_MS)} minutes of reopening`,
} as const;

/** What reopening needs from the run: the plugin's two tools, its clock and whether it was stopped. */
export type ReopenSetup = {
  reopen: () => Promise<unknown>;
  state: () => Promise<unknown>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  stopped: () => boolean;
  deadline: number;
};

/** The plugin's `editor-state`, once read. */
type EditorState = { answering: boolean; reopening: { state: ReopenState; error?: string } };

const isRecord = (value: unknown): value is AnyRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** Text from the plugin on one line, cut short; "" for anything that isn't text. */
const oneLine = (value: unknown, max: number) =>
  typeof value === "string" ? clip(value.replace(/\s+/g, " ").trim(), max) : "";

/** The plugin's `editor-state` answer, or null when it isn't one. */
function readEditorState(answer: unknown): EditorState | null {
  if (!isRecord(answer) || !isRecord(answer.reopening) || !REOPEN_STATES.has(answer.reopening.state)) return null;
  const error = oneLine(answer.reopening.error, CLIP_DETAIL);
  return {
    answering: answer.answering === true,
    reopening: { state: answer.reopening.state as ReopenState, ...(error ? { error } : {}) },
  };
}

/** Whether Unreal answers again: its reopening is done, or no reopening runs and it answers. */
function isOpen(state: EditorState | null): boolean {
  if (state?.reopening.state === ReopenState.Done) return true;
  return state?.reopening.state === ReopenState.Idle && state.answering;
}

/** Asks how reopening goes until Unreal answers, it failed, the time is up or the run is stopped. */
async function waitForEditor(setup: ReopenSetup): Promise<Reopened> {
  const timeout = setup.now() + REOPEN_TIMEOUT_MS;
  const until = Math.min(timeout, setup.deadline);
  while (setup.now() < until) {
    await setup.sleep(REOPEN_POLL_MS);
    if (setup.stopped()) return { end: ReopenEnd.Stopped };
    const state = readEditorState(await setup.state().catch(() => null));
    if (state?.reopening.state === ReopenState.Failed)
      return { end: ReopenEnd.Failed, why: MESSAGE.Failed(state.reopening.error ?? "") };
    if (isOpen(state)) return { end: ReopenEnd.Open };
  }
  return until < timeout ? { end: ReopenEnd.TimeUp } : { end: ReopenEnd.Failed, why: MESSAGE.TimedOut };
}

/**
 * Has the plugin reopen Unreal after a crash and waits until it answers (at most six minutes, never
 * past the run's deadline, and not once the run is stopped). An answer that isn't `answering` is
 * waited on through `editor-state`; a refused call is a failure, and so is Unreal never answering.
 */
export async function reopenEditor(setup: ReopenSetup): Promise<Reopened> {
  let started: unknown;
  try {
    started = await setup.reopen();
  } catch (refused) {
    return {
      end: ReopenEnd.Failed,
      why: MESSAGE.Refused(oneLine((refused as Error)?.message ?? refused, CLIP_DETAIL)),
    };
  }
  if (isRecord(started) && started.answering === true) return { end: ReopenEnd.Open };
  return waitForEditor(setup);
}
