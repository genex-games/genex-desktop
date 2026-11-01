/**
 * The game's Genex cover, made as a step of its own once a build lands, never by the agent in the
 * middle of building: when a run's close lands its build (`run_finished` with `landed`), the chat's
 * own agent is asked to make the cover in one message the transcript leaves out
 * (`MessageOrigin.CoverStep`), sent with the person's last message's engine, model and effort but
 * never their Loop, so the step starts no build. The cover's rules stay in the Genex plugin's
 * `cover` skill, read only then. Once per landed run, and never ahead of a message the person wrote
 * after the close. The host asks for any game while the Genex plugin is on (studio-core.ts).
 *
 * It lives on the host, not in the harness seed, so a kept older seed cannot shadow it, and it
 * decides from typed fields only: the close's `landed` and execution status, and the queue's `origin`.
 */
import type { ComposerSendOptions } from "../../shared/composer.ts";
import { CustomEvent, customPayload, type RunFinishedPayload } from "../../shared/custom-events.ts";
import type { EventEnvelope } from "../../shared/event-log.ts";
import { messageQueueState, type QueuedAction } from "../../shared/message-queue.ts";
import { isChatReport, MessageOrigin } from "../../shared/protocol.ts";
import { ExecutionStatus } from "../../shared/run-state.ts";
import { COVER_STEP_PROMPT } from "./cover-step-prompts.ts";

/** What the agent is sent for a landed build's cover: the words, and the send's options. */
export interface CoverStepAsk {
  text: string;
  options: ComposerSendOptions;
}

/** The fields of the person's last message the cover step is sent with: never its Loop or Autopilot. */
const CARRIED = ["engine", "model", "effort", "preferences"] as const;

/** The person's last message's engine, model and effort, as a send's options. */
function carriedOptions(action: QueuedAction | undefined): Partial<ComposerSendOptions> {
  const options: Record<string, unknown> = {};
  for (const key of CARRIED) if (action?.[key] !== undefined) options[key] = action[key];
  return options as Partial<ComposerSendOptions>;
}

/** The queued messages of a chat, in order: the person's, and Genex's own cover asks. */
function queuedRows(events: readonly EventEnvelope[]) {
  return [...messageQueueState(events).messages.values()].map((message) => ({
    action: message.action,
    person: !isChatReport(message.action),
    coverAsk: message.action?.origin === MessageOrigin.CoverStep,
  }));
}

/** Whether a run's close put a finished build in the game folder: landed, and not a pause. */
function landedBuild(close: Partial<RunFinishedPayload> | null | undefined): boolean {
  const paused = close?.paused === true || close?.executionStatus === ExecutionStatus.Paused;
  return close?.landed === true && !paused;
}

/**
 * The cover ask for `runId`'s close, or null: when it landed no build, the chat has no message of
 * the person's before it, the person wrote again after the close (their message is answered
 * first), or Genex already asked for this close's cover.
 */
export function coverStepAsk(threadId: string, events: readonly EventEnvelope[], runId: string): CoverStepAsk | null {
  const at = events.findIndex((event) => customPayload(event.data, CustomEvent.RunFinished)?.runId === runId);
  const record = events[at];
  if (!record || !landedBuild(customPayload(record.data, CustomEvent.RunFinished))) return null;
  const after = queuedRows(events.slice(at + 1));
  if (after.some((row) => row.person || row.coverAsk)) return null;
  const before = queuedRows(events.slice(0, at));
  const last = before.findLastIndex((row) => row.person);
  if (last < 0) return null;
  const options = { ...carriedOptions(before[last]?.action), thread: threadId, origin: MessageOrigin.CoverStep };
  return { text: COVER_STEP_PROMPT, options };
}

/** The `run_finished` records among `events` that landed a build. */
export const coverStepRuns = (events: readonly EventEnvelope[]): string[] =>
  events.flatMap((event) => {
    const close = customPayload(event.data, CustomEvent.RunFinished);
    return landedBuild(close) && typeof close?.runId === "string" ? [close.runId] : [];
  });
