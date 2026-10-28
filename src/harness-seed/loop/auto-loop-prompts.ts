/**
 * What a chat is told of the Loop it may start itself: only when the user asks in words, for the hours
 * they named, with the Loop switch on or off and after a run as before one: it never sends the user to
 * the switch. A module of its own, so a launch-prompts.ts an agent edited and kept still loads beside it.
 */
import { toolCall } from "./model-roles.ts";

/** The Loop start as a chat is handed it: only when asked, for the hours named. */
export const AUTO_LAUNCH_WORDS =
  "Start a Loop (a build that runs on its own) — only when the user asks for one in words (to start one, run it again or start a new one), never for a change you can make yourself. Pass the hours they named as hours, 0 when they said until done, and leave hours out when they named no time. Know first what the game is and how it should look. It starts from this folder as you leave it when your reply ends: call it once, last, then say in one line that it starts.";

/** The brief's line for a chat handed `tool`, spelled the way `engine` calls it. */
export function autoLoopRule(engine: string | undefined, tool: string): string {
  const launch = toolCall(engine, tool);
  return `You start Loops yourself: the Loop switch in the message box does not need to be on. When the user asks in words for a Loop (a build that runs on its own for hours, or until it's done) — to start one, run it again, or start a new one after the last — call ${launch} last, with the hours they named (0 for until done), then say in one line that it starts. Never say a Loop started unless that call answered that it did, and never tell the user to turn Loop on or that starting one isn't available to you.`;
}
