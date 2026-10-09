/**
 * The chat while a build of it is open (live chat). A message the person sends goes to the lead of
 * the run that owns the chat, when that lead takes the chat (director/lead-line.ts): recorded
 * delivered to the run, with a `run_steering` the lead's inbox reads, and answered by the lead in
 * the chat. Anything else waits for the build to close — the run itself, not the self-improvement
 * pass that follows it, which never holds the chat. That pass has a Stop of its own (`stopRun`):
 * the chat's next message clears the chat's, never the pass's.
 *
 * A module of its own: the loop's dispatch (main.ts), a chat turn (chat-dispatch.ts) and a run's
 * start (run-dispatch.ts) read it, and a seed upgrade keeps an older copy of any of those the agent
 * edited, which never exported these names. A run that opened no line — the long turn, the
 * classic pipeline, a kept director.ts from before live chat — keeps its messages waiting.
 */
import { leadLineOf, leadLinesChanged, type LeadLine } from "./director/lead-line.ts";
import { RunEvent } from "./run-events.ts";
import { SteerDelivery } from "./steer-delivery.ts";
import { type ActiveRun, type Studio, heldRuns } from "./studio-state.ts";
import type { LeadDoor, QueueAction } from "./message-queue.ts";
import type { HarnessCtx } from "../types/harness.d.ts";

/** A message's words, trimmed; anything else reads as none. */
const wordsOf = (action: QueueAction): string => String(action.text ?? "").trim();

/** Pictures travel with the message: the lead reads words only, so these wait for the chat. */
function carriesPictures(action: QueueAction): boolean {
  const stills = Array.isArray(action.stills) && action.stills.length > 0;
  const frames = Array.isArray(action.autopilot?.frames) && action.autopilot.frames.length > 0;
  return stills || frames || Boolean(action.attachmentsArtifact || action.imageCount);
}

/**
 * Does the lead take this message: words for the chat — never a fresh build asked for (`newRun`, a
 * New build queued before the composer dropped it), Studio's own chat, a slash command (words to the
 * session, not to the lead) or a message with pictures.
 */
function forTheLead(action: QueueAction): boolean {
  const words = wordsOf(action);
  const ownTurn = Boolean(action.newRun || action.studioThread);
  return words.length > 0 && !words.startsWith("/") && !ownTurn && !carriesPictures(action);
}

/** The build this chat's messages wait for: its run that has not closed yet. */
export function openBuildOf(studio: Studio, threadId: string): ActiveRun | undefined {
  return heldRuns(studio).find((active) => active.threadId === threadId && !active.done);
}

/**
 * The records the lead reads a message from: a steer of its run, word for word, from this message,
 * marked as the lead's (`how: "lead"`) — once heard, or back with the chat, a later run of the
 * run never tells it again (run-inbox.ts), and the chat's own `resume_run` records its words anew.
 */
function steerOf(line: LeadLine, item: QueueAction) {
  return [
    {
      event_type: RunEvent.RunSteering,
      payload: {
        runId: line.runId,
        text: wordsOf(item),
        sourceMessageId: item.messageId,
        how: SteerDelivery.Lead,
        at: new Date().toISOString(),
      },
    },
  ];
}

/** The door to the lead of this chat's open build, when that lead takes this message now. */
export function leadDoor(studio: Studio, threadId: string, action: QueueAction): LeadDoor | null {
  const build = openBuildOf(studio, threadId);
  const line = build ? leadLineOf(build.run.runId) : undefined;
  const takes = line?.threadId === threadId && line.open() && forTheLead(action);
  if (!line || !takes) return null;
  return {
    into: line.runId,
    open: () => line.open(),
    records: (item) => steerOf(line, item),
    handed: (item, giveBack) => line.hear(item, giveBack),
  };
}

/** Why the wait for a build ended: it closed, or a run's line opened or shut. */
const LINES_CHANGED = Symbol("lines changed");

/**
 * What the chat's next message waits for: the build to close — or, when the run's lead takes
 * it, the lead's door, which the queue hands it through. When a line opens or shuts and the lead
 * still does not take it, null: the queue looks again, and may hand the lead what waits behind it
 * (message-queue.ts). Without the message (a queue from before live chat), only the close. Stop
 * closes the build early; its self-improvement pass never waits.
 */
export async function chatWaitsFor(
  studio: Studio,
  threadId: string,
  next?: QueueAction,
): Promise<LeadDoor | null | undefined> {
  for (;;) {
    const build = openBuildOf(studio, threadId);
    if (!build) return undefined;
    const door = next ? leadDoor(studio, threadId, next) : null;
    if (door) return door;
    const closes = build.closed ?? build.settled;
    if (!next) {
      await closes;
      continue;
    }
    const lines = leadLinesChanged().then(() => LINES_CHANGED);
    if ((await Promise.race([closes, lines])) === LINES_CHANGED) return null;
  }
}

/** Does an open build hold this chat or its game (a legacy second chat of a game answers for its build too)? */
export function buildHolds(studio: Studio, threadId: string, project?: string | null): boolean {
  const ofGame = (active: ActiveRun): boolean => Boolean(project) && active.run?.project === project;
  return heldRuns(studio).some((active) => !active.done && (active.threadId === threadId || ofGame(active)));
}

/**
 * The run under way on this chat or game, once any run that has closed there is past its
 * self-improvement pass: a new build waits that pass out instead of being refused.
 */
export async function runUnderWay(studio: Studio, threadId: string, project: string): Promise<ActiveRun | undefined> {
  for (;;) {
    const busy = [...studio.activeRuns.values()].find((a) => a.threadId === threadId || a.run.project === project);
    if (!busy?.done) return busy;
    await busy.settled;
  }
}

/**
 * Stop reached this run: its self-improvement pass stops, and stays stopped whatever the chat does
 * next — a message clears the chat's own Stop (`studio.cancels`), never this one — and a build that
 * waited for that pass to end does not start (run-dispatch.ts).
 */
export function stopRun(active: ActiveRun): void {
  active.stopped = true;
}

/** The composer's Stop: it reaches every run of this chat — or of every chat, when none is named. */
export function stopRunsOf(studio: Studio, threadId?: string): void {
  for (const active of heldRuns(studio)) if (!threadId || active.threadId === threadId) stopRun(active);
}

/**
 * The ctx a run's self-improvement pass works with: the run's, stopped by the run's own Stop
 * (`stopRun`) as well as the chat's, so a message sent after Stop never sets the pass going again.
 */
export function passCtx(ctx: HarnessCtx, active: ActiveRun): HarnessCtx {
  const pass: HarnessCtx = { ...ctx };
  // A getter, like the ctx it copies: an object spread would freeze cancellation now.
  Object.defineProperty(pass, "cancelled", { get: () => active.stopped === true || ctx.cancelled });
  return pass;
}
