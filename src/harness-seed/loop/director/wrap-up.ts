/**
 * The user's ask to finish a running build (`wrap_up`). Their words reach the lead in the chat,
 * and only the lead can tell an ask to finish from a question: it records the ask, quoting them,
 * as the same `run_control` the app's own door writes (`requestRunFinish`). From then no worker or
 * round starts; each running worker ends the round it is in (workers.ts `workerStopAsk`), the
 * lead brings in what they keep, and once no loop worker runs the studio starts the wrap-up
 * (wake-schedule.ts `afterTurn`). A resume registers the run again and voids the ask, as it voids
 * the app's (run-inbox.ts `finishRequested`), so nothing here is journaled.
 */
import { HostMethod } from "../host-methods.ts";
import { WorkerMode } from "../outcomes.ts";
import { EventKind, RunEvent } from "../run-events.ts";
import { RunControlAction } from "../run-inbox.ts";
import { runNow } from "./cap-lines.ts";
import { closeUnderWay } from "./close-latch.ts";
import { waitDigest } from "./digests.ts";
import { leadsOpenLoop } from "./open/active-work.ts";
import { WRAP_UP_WORDS } from "./wrap-up-prompts.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { LoopRun, Worker } from "./loop-run.ts";

/** The fewest characters of the user's own words that stand for their message (`userQuoted`). */
const MIN_USER_QUOTE_CHARS = 8;

/** The user's ask as the run keeps it: when the lead recorded it, and their words. */
export interface FinishAsk {
  at: number;
  words: string;
}

/**
 * Did the user write `quote` in a message delivered into this run? The lead reads what they meant;
 * this only checks the words are theirs, as `plan`'s scope_instruction is checked (goals.ts).
 */
export async function userQuoted(inbox: LoopRun["inbox"], quote: unknown): Promise<boolean> {
  const words = typeof quote === "string" ? quote.trim() : "";
  if (words.length < MIN_USER_QUOTE_CHARS) return false;
  const said = await inbox.steering(undefined, false);
  return said.some((text) => text.includes(words));
}

/**
 * Has anybody asked this run to finish: the lead for the user (kept on the run, so no read is
 * needed once it did), or the app's own door?
 */
export async function finishAsked(loopRun: Pick<LoopRun, "inbox" | "state">): Promise<boolean> {
  if (loopRun.state?.finishAsk) return true;
  return loopRun.inbox.finishing().catch(() => false);
}

/** A running worker as the answer names it: a loop worker with the round it is in and its time left, a single session as one. */
function runningWords(worker: Worker, now: number): string {
  if (worker.mode !== WorkerMode.Loop) return WRAP_UP_WORDS.session(worker.id);
  const line = waitDigest(worker, now);
  return WRAP_UP_WORDS.worker(worker.id, line.round, line.minutesLeft);
}

/**
 * What the lead is told once the ask is on record: who still works, and what comes next — the
 * wrap-up once no loop worker runs, so at once when only single sessions do.
 */
function askedAnswer(loopRun: LoopRun, now: number): string {
  if (leadsOpenLoop(loopRun)) return WRAP_UP_WORDS.openLoop;
  const running = loopRun.runningWorkers();
  const named = running.map((worker) => runningWords(worker, now));
  if (running.some((worker) => worker.mode === WorkerMode.Loop)) return WRAP_UP_WORDS.running(named);
  return named.length ? WRAP_UP_WORDS.sessionsOnly(named) : WRAP_UP_WORDS.nothingRunning;
}

/** `wrap_up`: record the user's ask to finish, once, in their words. */
export async function wrapUp(loopRun: LoopRun, args: AnyRecord): Promise<string> {
  const { ctx, inbox, run, state, threadId } = loopRun;
  if (state.finish || closeUnderWay(state)) return WRAP_UP_WORDS.closing;
  const now = runNow(loopRun);
  if (await finishAsked(loopRun)) return `${WRAP_UP_WORDS.already} ${askedAnswer(loopRun, now)}`;
  if (!(await userQuoted(inbox, args.user_asked))) return WRAP_UP_WORDS.notQuoted;
  await ctx.call(HostMethod.EventsAppend, {
    threadId,
    batch: [
      {
        type: EventKind.Custom,
        event_type: RunEvent.RunControl,
        payload: { runId: run.runId, action: RunControlAction.Finish, at: new Date(now).toISOString() },
      },
    ],
  });
  state.finishAsk = { at: now, words: String(args.user_asked).trim() };
  return askedAnswer(loopRun, now);
}
