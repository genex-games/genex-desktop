/**
 * What a run's lead reads of the chat in the middle of a turn (live chat, wake.ts): the user's
 * words, handed into the turn under way, and what to do with them — or, when the turn had to be
 * cut short for them, that it was. Plain facts in, text out.
 *
 * A module of its own: a seed upgrade keeps an older wake-prompts.ts the agent edited, which never
 * exported it.
 */
import { userSaysBlock } from "./wake-prompts.ts";

/** What the lead is asked to do with words that reach it mid-turn. */
const MID_TURN_ASK =
  "They wrote this in the chat while you worked. Answer them there, directly and briefly, then carry on with what you were doing unless they asked for something else. A question alone never stops or restarts a worker.";

/** The user's words as a turn under way reads them, at its next step. */
export function midTurnUserSays(words: readonly string[]): string {
  return [userSaysBlock(words), MID_TURN_ASK].join("\n");
}

/** What a lead is told when its turn was cut short to hand it the user's words. */
const CUT_SHORT =
  "YOUR LAST TURN WAS CUT SHORT so you could read what the user said. Answer them in the chat, then finish what you were doing.";

/** The message that resumes a turn cut short for the user's words: it says so, then wakes the lead with them. */
export function cutShortWake(digest: string): string {
  return [CUT_SHORT, digest].join("\n\n");
}
