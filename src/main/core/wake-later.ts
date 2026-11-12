/**
 * `wake_later`: the chat's own session sets a timer and ends its turn, and Genex starts the chat's
 * next turn when it is due, with the agent's note. An agent waiting for something outside it (a
 * download or an install in a launcher, an app starting) otherwise waits inside its turn, with a
 * sleep, a wait action or a loop of looks, and the person's words reach it only at its next step.
 * With its turn ended, what the person sends meanwhile is answered at once.
 *
 * - **One per chat.** A new timer replaces the chat's earlier one, and `seconds: 0` cancels it. It
 *   runs {@link WAKE_LATER_MIN_MS} to {@link WAKE_LATER_MAX_MS}; a time asked outside is clamped,
 *   and the answer says so.
 * - **The wake.** One hidden message (`MessageOrigin.WakeLater`) on the chat's last model, as a
 *   job's end wakes the chat (`job-wake.ts`): it starts the chat's next turn, or joins the one
 *   running.
 * - **What ends it.** Its wake, the person's Stop in the chat, the agent, and Genex quitting:
 *   nothing is kept on disk. The person writing does not: the turn answering them may set a new one
 *   or cancel it.
 * - **Who has it.** The chat's own session (`projectTools`): a Loop's lead is woken by its own loop
 *   (`wake-schedule.ts`), its workers answer to it, and a local model's turn has no project tools.
 */
import { HOUR_MS, SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { type LiveToolSpec, numberArg } from "../../shared/engine-requests.ts";
import type { WatchSchedule } from "./job-wake.ts";
import { WAKE_LATER_ANSWER, WAKE_LATER_PROMPT, WakeLaterFit, wakeLaterTool } from "./wake-later-prompts.ts";

/** The shortest timer: waking a model more often than this checks nothing new. */
export const WAKE_LATER_MIN_MS = 10 * SECOND_MS;
/** The longest timer: a longer wait is set again when it wakes. */
export const WAKE_LATER_MAX_MS = HOUR_MS;
/** The longest note a timer keeps, in characters; the rest is cut. */
export const WAKE_LATER_NOTE_MAX_CHARS = 300;

/** `wake_later` as a session is handed it. */
export const WAKE_LATER_TOOL: LiveToolSpec = wakeLaterTool(
  WAKE_LATER_MIN_MS / SECOND_MS,
  WAKE_LATER_MAX_MS / SECOND_MS,
);

const MESSAGE = {
  notWoken: (threadId: string, error: unknown) =>
    `[core] the chat ${threadId} wasn't woken by its wake_later timer: ${errorMessage(error)}`,
} as const;

/** What the timers need of the host: the chat's wake, the timer and the clock, and the log. */
export interface WakeLaterDeps {
  /** Starts the chat's next turn with Genex's words (or joins its running turn). */
  wake(threadId: string, project: string, text: string): Promise<void>;
  schedule: WatchSchedule;
  now(): number;
  log(line: string): void;
}

/** A timer as it was set: how long it runs, whether the time asked was clamped, and whether it replaced one. */
export interface WakeLaterSet {
  ms: number;
  clamped: boolean;
  replaced: boolean;
}

/** One chat's timer: its game, the agent's note, when it was set, and what calls it off. */
interface Timer {
  project: string;
  note: string;
  setAt: number;
  cancel: () => void;
}

/** A note as one plain line, cut to {@link WAKE_LATER_NOTE_MAX_CHARS}. */
const plainNote = (note: string): string => note.replace(/\s+/g, " ").trim().slice(0, WAKE_LATER_NOTE_MAX_CHARS);

/** Every chat's timer (module comment). */
export class WakeLaterTimers {
  readonly #deps: WakeLaterDeps;
  readonly #timers = new Map<string, Timer>();

  constructor(deps: WakeLaterDeps) {
    this.#deps = deps;
  }

  /** How many chats have a timer now. */
  get size(): number {
    return this.#timers.size;
  }

  /** Set chat `threadId`'s timer `ms` from now, clamped to the bounds, in place of its earlier one. */
  set(threadId: string, project: string, ms: number, note: string): WakeLaterSet {
    const replaced = this.cancel(threadId);
    const runs = Math.min(WAKE_LATER_MAX_MS, Math.max(WAKE_LATER_MIN_MS, Math.round(ms)));
    const timer: Timer = { project, note: plainNote(note), setAt: this.#deps.now(), cancel: () => {} };
    this.#timers.set(threadId, timer);
    timer.cancel = this.#deps.schedule(() => void this.#fire(threadId, timer), runs);
    return { ms: runs, clamped: ms < WAKE_LATER_MIN_MS || ms > WAKE_LATER_MAX_MS, replaced };
  }

  /** Call off chat `threadId`'s timer; whether it had one. */
  cancel(threadId: string): boolean {
    const timer = this.#timers.get(threadId);
    if (!timer) return false;
    this.#timers.delete(threadId);
    timer.cancel();
    return true;
  }

  /** Call off every timer with no wake: the core stops. */
  dispose(): void {
    for (const threadId of [...this.#timers.keys()]) this.cancel(threadId);
  }

  async #fire(threadId: string, timer: Timer): Promise<void> {
    if (this.#timers.get(threadId) !== timer) return;
    this.#timers.delete(threadId);
    const secondsAgo = Math.round((this.#deps.now() - timer.setAt) / SECOND_MS);
    await this.#deps
      .wake(threadId, timer.project, WAKE_LATER_PROMPT.due(secondsAgo, timer.note))
      .catch((error: unknown) => this.#deps.log(MESSAGE.notWoken(threadId, error)));
  }
}

/** Where a `wake_later` call comes from: its game and the chat it wakes (the host's finding). */
export interface WakeLaterCall {
  project: string;
  threadId?: string | undefined;
}

/** `wake_later` as the chat's own session calls it: set, replace or cancel the chat's timer. */
export function callWakeLater(timers: WakeLaterTimers, args: Record<string, unknown>, call: WakeLaterCall): string {
  if (!call.threadId) return WAKE_LATER_ANSWER.noChat;
  const seconds = numberArg(args.seconds);
  if (seconds === undefined)
    return WAKE_LATER_ANSWER.noSeconds(WAKE_LATER_MIN_MS / SECOND_MS, WAKE_LATER_MAX_MS / SECOND_MS);
  if (seconds <= 0) return timers.cancel(call.threadId) ? WAKE_LATER_ANSWER.cancelled : WAKE_LATER_ANSWER.noneToCancel;
  const note = typeof args.note === "string" ? args.note : "";
  const set = timers.set(call.threadId, call.project, seconds * SECOND_MS, note);
  return WAKE_LATER_ANSWER.set(set.ms / SECOND_MS, fitOf(set), set.replaced);
}

/** How the time asked was fitted to the bounds. */
function fitOf(set: WakeLaterSet): WakeLaterFit {
  if (!set.clamped) return WakeLaterFit.Asked;
  return set.ms === WAKE_LATER_MIN_MS ? WakeLaterFit.Shortest : WakeLaterFit.Longest;
}
