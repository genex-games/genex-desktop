/**
 * Live chat, as the composer reads it: while a build whose lead takes the chat runs, a message
 * goes to that lead at once and is answered in the chat (the seed's `loop/live-chat.ts`), instead
 * of waiting behind the build. The build's start says whether its lead does (`liveChat`); a run
 * on the long turn, or one whose director predates live chat, says nothing and keeps its queue.
 * A message with pictures, and one sent after the lead began wrapping up, still waits.
 */
import { CustomEvent, customPayload } from "../../shared/custom-events.ts";
import type { EventEnvelope } from "../../shared/event-log.ts";

/** Does build `runId`'s lead take the chat's messages: its latest start (a Resume starts it again) says so. */
export function leadTakesChat(events: readonly EventEnvelope[], runId: string | null): boolean {
  if (!runId) return false;
  let takes = false;
  for (const event of events) {
    const start = customPayload(event.data, CustomEvent.AutopilotStarted);
    if (start?.runId === runId) takes = start.liveChat === true;
  }
  return takes;
}
