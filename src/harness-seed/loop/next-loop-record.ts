/**
 * The new Loop a user's ask to finish carries ("stop it and start a new one"), as the lead passes it
 * to `wrap_up` (wrap-up.ts) and the `run_control` record keeps it; next-loop.ts starts it once the
 * run has closed. Pure: no launch here, so the lead's tools can read it without the chat's dispatch.
 */
import { hoursNamed } from "./config.ts";
import { EventKind, RunEvent } from "./run-events.ts";
import { RunControlAction } from "./run-inbox.ts";
import type { AnyRecord, HarnessEvent } from "../types/harness.d.ts";

/** The new Loop a finish ask carries: what to build, the bar, and its hours (null: until done). */
export interface NextLoop {
  goal: string;
  direction: string;
  hours: number | null;
}

/** A finish ask's new Loop from what the lead passed, or null when it names no goal. */
export function nextLoopFrom(args: AnyRecord): NextLoop | null {
  const goal = typeof args.next_goal === "string" ? args.next_goal.trim() : "";
  if (!goal) return null;
  const direction = typeof args.next_direction === "string" ? args.next_direction.trim() : "";
  const hours = hoursNamed(args.next_hours);
  return { goal, direction: direction || goal, hours: hours > 0 ? hours : null };
}

/** The events that open a run again (a resume, a reopen): an ask to finish before them is spent. */
const OPENED: ReadonlySet<string> = new Set([RunEvent.RunRegistered, RunEvent.RunStarted]);

/**
 * The new Loop the ask to finish of `runId`'s latest opening carries in `events`, once that run has
 * finished; null when none was asked, the run paused (a Stop, a limit: its resume is what goes on), or
 * it opened again since (a resume or reopen starts nothing an earlier ask carried).
 */
export function nextLoopOf(events: readonly HarnessEvent[], runId: string): NextLoop | null {
  let fold: NextFold = { next: null, finished: false };
  for (const event of events) {
    const data = event?.data;
    if (data?.type === EventKind.Custom && data.payload?.runId === runId)
      fold = foldNext(fold, data.event_type, data.payload);
  }
  return fold.finished ? fold.next : null;
}

/** What a run's events say so far: the new Loop its latest ask carries, and whether it has finished. */
type NextFold = { next: NextLoop | null; finished: boolean };

/** The fold after one of the run's events. */
function foldNext(fold: NextFold, eventType: string, payload: AnyRecord): NextFold {
  if (OPENED.has(eventType)) return { next: null, finished: false };
  if (eventType === RunEvent.RunFinished) return { ...fold, finished: true };
  if (eventType === RunEvent.AutopilotPaused) return { ...fold, finished: false };
  if (asksToFinish(eventType, payload)) return { ...fold, next: isNextLoop(payload.next) ? payload.next : null };
  return fold;
}

/** Whether an event is the ask to finish `wrap_up` records. */
const asksToFinish = (eventType: string, payload: AnyRecord): boolean =>
  eventType === RunEvent.RunControl && payload.action === RunControlAction.Finish;

/** Whether a recorded value is a new Loop as `nextLoopFrom` writes it. */
function isNextLoop(value: unknown): value is NextLoop {
  const next = value as Partial<NextLoop> | null;
  return typeof next?.goal === "string" && next.goal.length > 0 && typeof next.direction === "string";
}
