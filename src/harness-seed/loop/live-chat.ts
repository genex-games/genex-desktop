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
import { attachedPicturesLine } from "./live-chat-prompts.ts";
import { WRAPPING_UP_NOTE } from "./steer-switch-prompts.ts";
import { RunEvent } from "./run-events.ts";
import { SteerDelivery } from "./steer-delivery.ts";
import { type ActiveRun, type Studio, heldRuns } from "./studio-state.ts";
import type { LeadDoor, QueueAction } from "./message-queue.ts";
import type { HarnessCtx } from "../types/harness.d.ts";

/** A message's words, trimmed; anything else reads as none. */
const wordsOf = (action: QueueAction): string => String(action.text ?? "").trim();

/** The game's folder the chat saves a message's pictures in (`references`, relative to the game). */
const REFERENCES_FOLDER = "references";

/**
 * How many pictures travel with a message that the chat saves in the game: the ones the composer
 * attached (`pickedImages`; the rest of its stills are files its words already name), else its
 * stills, a commission's frames, or the log's count.
 */
function pictureCount(action: QueueAction): number {
  if (typeof action.pickedImages === "number" && action.pickedImages >= 0) return action.pickedImages;
  if (Array.isArray(action.stills) && action.stills.length) return action.stills.length;
  if (Array.isArray(action.autopilot?.frames) && action.autopilot.frames.length) return action.autopilot.frames.length;
  const counted = Number(action.imageCount);
  if (Number.isInteger(counted) && counted > 0) return counted;
  return action.attachmentsArtifact ? 1 : 0;
}

/** A file the chat saved in the game's references folder: a plain path inside it, never out of it. */
const isSavedReference = (file: unknown): file is string =>
  typeof file === "string" && file.startsWith(`${REFERENCES_FOLDER}/`) && !file.split("/").includes("..");

/**
 * A message's pictures as the files the chat saved them to in the game, which the lead reads: none
 * for a message without pictures, null when one of them was not saved (it waits for the chat).
 */
function savedPictures(action: QueueAction): string[] | null {
  const count = pictureCount(action);
  if (count === 0) return [];
  // Every file its pictures are saved as (a picture sent before included); an older app's added ones only.
  const files = Array.isArray(action.pictureFiles) ? action.pictureFiles : action.references;
  const saved = Array.isArray(files) ? files.filter(isSavedReference) : [];
  return saved.length >= count ? saved : null;
}

/** What the lead reads of a message: its words, and where the pictures it carries were saved. */
function leadWordsOf(action: QueueAction): string {
  const pictures = savedPictures(action) ?? [];
  if (!pictures.length) return wordsOf(action);
  return [wordsOf(action), attachedPicturesLine(pictures)].filter(Boolean).join("\n\n");
}

/**
 * Does the lead take this message: words or saved pictures for the chat — never a fresh build asked
 * for (`newRun`, a New build queued before the composer dropped it), Studio's own chat, a slash
 * command (words to the session, not to the lead) or a picture the chat did not save in the game.
 */
function forTheLead(action: QueueAction): boolean {
  const words = wordsOf(action);
  const pictures = savedPictures(action);
  const ownTurn = Boolean(action.newRun || action.studioThread);
  const said = words.length > 0 || Boolean(pictures?.length);
  return said && pictures !== null && !words.startsWith("/") && !ownTurn;
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
function steerOf(line: LeadLine, item: QueueAction, wrapping: boolean) {
  const words = leadWordsOf(item);
  return [
    {
      event_type: RunEvent.RunSteering,
      payload: {
        runId: line.runId,
        text: wrapping ? `${words}\n\n${WRAPPING_UP_NOTE}` : words,
        sourceMessageId: item.messageId,
        how: SteerDelivery.Lead,
        // Told, not delivered: the chat answers it once the run closes (the chat reads it here all the same).
        ...(wrapping ? { kept: true } : {}),
        at: new Date().toISOString(),
      },
    },
  ];
}

/**
 * This copy's door keeps what a lead in its wrap-up is told (`LeadDoor.keeps`): a wrap-up only goes
 * on hearing the chat when this and the queue both do (director/wake.ts), else its line shuts.
 */
export const DOOR_KEEPS_IN_WRAP_UP = true;

/**
 * The door to the lead of this chat's open build, when that lead takes this message now. In its
 * wrap-up the lead still hears it, but the chat keeps it to answer once the run has closed (`keeps`):
 * the build is ending, and new work is the chat's. A message the lead was told so has no door again.
 */
export function leadDoor(studio: Studio, threadId: string, action: QueueAction): LeadDoor | null {
  const build = openBuildOf(studio, threadId);
  const line = build ? leadLineOf(build.run.runId) : undefined;
  const takes = line?.threadId === threadId && line.open() && forTheLead(action);
  if (!line || !takes) return null;
  // A kept older lead-line.ts has no wrap-up: its line shuts instead.
  const wrapping = typeof line.wrapping === "function" && line.wrapping();
  if (wrapping && action.toldLead === line.runId) return null;
  return {
    into: line.runId,
    open: () => line.open(),
    records: (item) => steerOf(line, item, wrapping),
    handed: (item, giveBack) => line.hear(item, giveBack),
    ...(wrapping ? { keeps: true } : {}),
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
  active.stops = (active.stops ?? 0) + 1;
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
