/**
 * A Loop the chat started that a plugin's step held back before its first turn (`run_finished`
 * with `startHeld`: Unreal wouldn't reopen, the game's code didn't build): the chat's own agent is
 * told why, in a message the transcript leaves out (`MessageOrigin.LoopHeld`), sent as the
 * person's last message was (its engine, model, effort and Loop), so it fixes what stopped it and
 * starts the Loop again and the person never has to ask. Once per message of the person's: a Loop
 * the agent starts again that is held back too waits for them, and so does one held back after the
 * person wrote again. Genex's own holds (the person using the app, Plan mode) are never `startHeld`.
 *
 * It lives on the host, not in the harness seed, so a kept older seed cannot shadow it, and it
 * decides from typed fields only: the close's `startHeld` and the queued messages' `origin`.
 */
import type { ComposerSendOptions } from "../../shared/composer.ts";
import { CustomEvent, customPayload } from "../../shared/custom-events.ts";
import type { EventEnvelope } from "../../shared/event-log.ts";
import { messageQueueState, type QueuedAction } from "../../shared/message-queue.ts";
import { isChatReport, MessageOrigin } from "../../shared/protocol.ts";
import { HELD_START_PROMPT } from "./held-start-prompts.ts";

/** What the agent is sent about a held start: the words, and the send's options. */
export interface HeldStartAsk {
  text: string;
  options: ComposerSendOptions;
}

/** The fields of the person's last message a held start's ask is sent with, as their composer sent them. */
const CARRIED = ["engine", "model", "effort", "preferences", "loop", "autopilot"] as const;

/** The person's last message's engine, model, effort and Loop, as a send's options. */
function carriedOptions(action: QueuedAction | undefined): Partial<ComposerSendOptions> {
  const options: Record<string, unknown> = {};
  for (const key of CARRIED) if (action?.[key] !== undefined) options[key] = action[key];
  return options as Partial<ComposerSendOptions>;
}

/** The queued messages of a chat, in order: whose they are (the person's, or Genex's held-start ask). */
function queuedRows(events: readonly EventEnvelope[]) {
  return [...messageQueueState(events).messages.values()].map((message) => ({
    action: message.action,
    person: !isChatReport(message.action),
    heldAsk: message.action?.origin === MessageOrigin.LoopHeld,
  }));
}

/**
 * The ask for `runId`'s held start, or null: when its close isn't `startHeld`, the chat has no
 * message of the person's before it, Genex already asked once since that message, or the person
 * wrote again after the close (their message is answered first).
 */
export function heldStartAsk(threadId: string, events: readonly EventEnvelope[], runId: string): HeldStartAsk | null {
  const at = events.findIndex((event) => customPayload(event.data, CustomEvent.RunFinished)?.runId === runId);
  const record = events[at];
  const close = record ? customPayload(record.data, CustomEvent.RunFinished) : null;
  if (close?.startHeld !== true) return null;
  if (queuedRows(events.slice(at + 1)).some((row) => row.person)) return null;
  const before = queuedRows(events.slice(0, at));
  const last = before.findLastIndex((row) => row.person);
  if (last < 0) return null;
  if (before.slice(last + 1).some((row) => row.heldAsk)) return null;
  const why = typeof close.stoppedBecause === "string" ? close.stoppedBecause : "";
  const options = { ...carriedOptions(before[last]?.action), thread: threadId, origin: MessageOrigin.LoopHeld };
  return { text: HELD_START_PROMPT(why), options };
}

/** The `run_finished` records among `events` whose start a plugin held back. */
export const heldStartRuns = (events: readonly EventEnvelope[]): string[] =>
  events.flatMap((event) => {
    const close = customPayload(event.data, CustomEvent.RunFinished);
    return close?.startHeld === true && typeof close.runId === "string" ? [close.runId] : [];
  });
