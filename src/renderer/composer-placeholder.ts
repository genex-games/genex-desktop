/**
 * The composer's one-line instruction. An empty box is what a first launch is read from, and
 * about 53 characters is what the composer shows on one line at the default chat width, so every
 * sentence here must fit (tests/conformance/door.test.ts), and so must its translations.
 */
import { t } from "../shared/i18n.ts";

/** Characters the composer shows on one line at the default chat width, with a margin of one. */
export const COMPOSER_LINE_CHARS = 52;

/**
 * While a build runs, a message waits for it to settle (message-queue.ts `beforeProcess`), and the
 * box says so. The build smoke reads it.
 */
export const QUEUE_PLACEHOLDER = t("Sends when the build finishes…");

/**
 * While a build whose lead takes the chat runs (live chat, `chat/live-chat.ts`), a message goes to
 * that lead at once and it answers in the chat; the box must not say it waits.
 */
export const LEAD_PLACEHOLDER = t("Talk to the lead while it builds…");

/** What the box asks while Add's Plan mode is on: the next message gets a plan to review first. */
export const PLAN_PLACEHOLDER = t("Describe what to plan…");

/** What home asks: its first message starts a game, and a chat with no game yet asks the same. */
export const HOME_PLACEHOLDER = t("What do you want to make?");

/** What the chat asks for when nothing is running: the most specific task wins. */
export function chatPlaceholder(state: { revisingPlan: boolean; studio: boolean; draft: boolean }): string {
  // An intake question takes its typed answer in its own card, so it does not change these words.
  if (state.revisingPlan) return t("Describe the changes to the plan…");
  if (state.studio) return t("Ask about Harness…");
  return state.draft ? HOME_PLACEHOLDER : t("Ask for a change…");
}

/** Only an active build overrides the contextual instruction: by its queue, or by its lead when that takes the chat. */
export function composerPlaceholder(coordinating: boolean, contextual: string, leadListens = false): string {
  if (!coordinating) return contextual;
  return leadListens ? LEAD_PLACEHOLDER : QUEUE_PLACEHOLDER;
}
