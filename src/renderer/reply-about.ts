/**
 * A reply about something on the Builds graph goes through the chat's one composer. The stage
 * names what the reply is about; the chat holds it as a chip above the prompt and sends the next
 * message as a note to that build (the steering inbox), not as a chat turn.
 */
import { t } from "../shared/i18n.ts";

/** Which part of a run a note is pinned to; none of it means the whole build. */
export interface NoteTarget {
  facetId?: string;
  iteration?: number;
  camera?: string;
}

export interface ReplyAbout {
  threadId: string;
  runId: string;
  /** What the chip and the sent note are called: "Tall mountain · try 5". */
  label: string;
  placeholder: string;
  target?: NoteTarget;
  /** Whether the run is still working: a note steers its next round, otherwise its next build. */
  active: boolean;
}

export const REPLY_ABOUT_EVENT = "studio:reply-about";

export function replyAbout(about: ReplyAbout): void {
  window.dispatchEvent(new CustomEvent<ReplyAbout>(REPLY_ABOUT_EVENT, { detail: about }));
}

/** Where a sent note went, in the words of the toast that confirms it. */
export function noteSentWords(about: Pick<ReplyAbout, "active" | "target">): string {
  if (!about.active) return t("Sent — it will steer the next run on this game");
  return about.target?.facetId
    ? t("Sent — it goes into this part's next round")
    : t("Sent — every part gets it with its next round");
}

/**
 * A note is stored in the conversation as `[USER FEEDBACK on facet …] text` — the harness reads
 * that prefix. The chat shows the words the user wrote and names what they were about instead.
 */
export function splitFeedback(content: string): { text: string } | null {
  const match = /^\[USER FEEDBACK(?: on [^\]]*)?\]\s?/.exec(content);
  return match ? { text: content.slice(match[0].length) } : null;
}
