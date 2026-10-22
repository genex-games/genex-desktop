/**
 * What an Auto chat (Loop off) is told of the Loop it may start: only when the user asks in words, for
 * the hours they named. One once said "The 3-hour loop starts now" with no way to start one. A module
 * of its own, so a launch-prompts.ts an agent edited and kept still loads beside it.
 */
import { toolCall } from "./model-roles.ts";

/** The Loop start as an Auto chat is handed it: only when asked, for the hours named. */
export const AUTO_LAUNCH_WORDS =
  "Start a Loop (a build that runs on its own) — only when the user asks for one in words, never for a change you can make yourself. Pass the hours they named as hours; leave hours out when they said until done or named no time. Know first what the game is and how it should look. It starts from this folder as you leave it when your reply ends: call it once, last, then say in one line that it starts.";

/** The brief's line for an Auto chat handed `tool`, spelled the way `engine` calls it. */
export function autoLoopRule(engine: string | undefined, tool: string): string {
  const launch = toolCall(engine, tool);
  return `Loop is off. When the user asks in words for a Loop (a build that runs on its own for hours, or until it's done), call ${launch} last, with the hours they named (leave hours out for until done), then say in one line that it starts. Never say a Loop started unless that call answered that it did.`;
}
