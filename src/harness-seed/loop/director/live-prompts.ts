/**
 * What a run's lead reads of the chat in the middle of a turn (live chat, wake.ts): the user's
 * words, handed into the turn under way, and what to do with them — or, when the turn had to be
 * cut short for them, that it was. Plain facts in, text out.
 *
 * A module of its own: a seed upgrade keeps an older wake-prompts.ts the agent edited, which never
 * exported it.
 */
import { DirectorTool } from "./tool-specs.ts";
import { userSaysBlock } from "./wake-prompts.ts";

/**
 * What the lead does with the user's words, whether its turn reads them or was cut for them: a stop
 * is a wrap-up, never lost under "carry on" or "finish what you were doing". Built when asked, so
 * the tool's name is read only once every module has loaded.
 */
const actOnWords = (otherwise: string): string =>
  `An ask to stop or finish the build is ${DirectorTool.WrapUp}, quoting their words (with next_goal when they also want a new Loop after it); act on anything else they ask; otherwise ${otherwise}. A question alone never stops or restarts a worker.`;

/** The user's words as a turn under way reads them, at its next step. */
export function midTurnUserSays(words: readonly string[]): string {
  const ask = `They wrote this in the chat while you worked. Answer them there, directly and briefly. ${actOnWords("carry on with what you were doing")}`;
  return [userSaysBlock(words), ask].join("\n");
}

/** The message that resumes a turn cut short for the user's words: it says so, then wakes the lead with them. */
export function cutShortWake(digest: string): string {
  const cut = `YOUR LAST TURN WAS CUT SHORT so you could read what the user said. Answer them in the chat. ${actOnWords("finish what you were doing")}`;
  return [cut, digest].join("\n\n");
}
