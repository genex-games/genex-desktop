/**
 * What a Loop's lead reads because it IS its chat's own session (lead-session.ts): the chat so far
 * when its session is a fresh one, and the first line of a fresh session that carries the run.
 */
import { clipMarked } from "../text.ts";

/** How many of the chat's latest messages a fresh lead is told, and at most how much of their text. */
export const CHAT_SO_FAR_MESSAGES = 20;
export const CHAT_SO_FAR_CHARS = 18_000;
/** At most this much of any one message. */
const CHAT_MESSAGE_CHARS = 4_000;

/** One message of the chat, as a fresh lead is told it. */
export interface ChatLine {
  role: string;
  content: string;
}

/**
 * The chat so far, for a lead whose session is not the chat's own after all — the chat had none on
 * this engine and model, or it could not be resumed: the latest messages, oldest first, clipped.
 */
export function chatSoFar(lines: readonly ChatLine[]): string {
  const said = lines
    .slice(-CHAT_SO_FAR_MESSAGES)
    .map((line) => `${line.role}: ${clipMarked(line.content, CHAT_MESSAGE_CHARS)}`)
    .join("\n")
    .slice(-CHAT_SO_FAR_CHARS);
  if (!said.trim()) return "";
  return `THE CHAT SO FAR (its latest messages, oldest first) — this chat's own session could not carry on here, so this session is new and this is the conversation the build came from:\n${said}`;
}

/** The first line of a lead's fresh session (wake-prompts.ts `freshStart`): the run follows. */
export const LEAD_FRESH_START = (why: string) =>
  `YOUR EARLIER SESSION WAS LOST (${why}) — this is a fresh one. Your notes and the run so far are below: carry on from where the run stands.`;
