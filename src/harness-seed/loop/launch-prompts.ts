/**
 * What a Loop chat is told about the build it may start: a build is allowed, not owed. A
 * delegated session reads `launchRules` in its contractor brief (chat-session.ts), a direct
 * engine reads `launchDecision` in its turn briefing (turn-prompts.ts); the decision is the same.
 * A request for research and a plan once reached a chat whose only way forward was a launch, and
 * became a seventeen-hour build of a title card.
 */
import { MAX_RUN_HOURS } from "./config.ts";
import { askUser } from "./interview-question.ts";
import { toolCall } from "./model-roles.ts";
import { NARROW_TO_THE_ASK } from "./narrow-prompts.ts";

/** The build a Loop chat may start: its launch tool, the composer's hours, stills and folder. */
export interface LaunchGrant {
  toolName: string;
  /** The composer's hours for a build; none runs it until its judges are satisfied. */
  hours?: number | null;
  /** How many stills the commission carries (its mood board). */
  frameCount?: number;
  /** The chat's folder, which the launch tool is handed. */
  project?: string;
}

/**
 * How a resumed Loop chat is told to go on: from the new message, not "finish the remaining
 * work" — its last turn may have been an answer or a plan, with no build left to finish.
 */
export const RESUME_LOOP_CHAT =
  "You are resuming your own session in this workspace — your context is restored. Continue from where you left off.";

/**
 * Before a build: what the game is and how it should look, and one question when either is
 * missing — the write-less interviewer this chat replaced asked it before every build it launched,
 * and without it a bare pitch ("make me a game, quickly") became hours of building in a style
 * nobody chose. `ask` is the question tool as the reader calls it.
 */
function askFirst(ask: string): string {
  return `Before you launch a build, know what the game is (what the player does in it) and how it should look and feel (a style, a game or film to match, or the stills). Take both from the conversation, the stills or the game already in this folder. If either is missing, do not guess: ask with ${ask} — one question that covers what is missing, up to 3 choices with your recommendation first — and end your reply; launch once they answer. Ask even when the user asks for speed: an answer costs them a click, a build in the wrong style costs hours. Never ask what they already said or showed, and ask once: after their answer, a gap in look takes your recommendation; ${NARROW_TO_THE_ASK}: a build is narrowed, never widened.`;
}

/**
 * Small talk is neither a build nor unclear: a "Hello" in a new game once came back as a question
 * card about what the game should be.
 */
const SMALL_TALK =
  "A greeting, thanks or small talk: reply in a sentence or two, like a person, and ask what they would like to make if they have not said. No tools and no question.";

/** A hurry changes how long a build runs, never whether a new game is one. */
const QUICK_IS_A_BUILD = "also when they want it fast: a quick build is still a build, and its judges still check it";

/** How long a build may run, as the chat reads it. */
function budgetWords(hours: number | null | undefined): string {
  if (typeof hours === "number" && hours > 0) return `up to ${hours} h`;
  return `until its judges are satisfied, ${MAX_RUN_HOURS} h at most`;
}

/**
 * What a delegated Loop chat adds to the contractor's rules, its tools spelled the way `engine`
 * calls them: answer, research, plan and edit here; launch only when the ask is a build.
 */
export function launchRules(engine: string | undefined, grant: LaunchGrant): string[] {
  const launch = toolCall(engine, grant.toolName);
  const ask = toolCall(engine, askUser.name);
  const frames = grant.frameCount ?? 0;
  return [
    `Loop is on: you may start a build — builders working in parallel and judges checking their work (${budgetWords(grant.hours)}). It is allowed, not required. Decide from the latest message:`,
    `- ${SMALL_TALK}`,
    "- A question, research, a plan, a design document or a review: do it yourself and answer here; put plans and documents in this folder (docs/) when they are asked for. A request for research or a plan is not a request to build — deliver it, then offer to build from it.",
    "- A contained change (a fix, a tweak, one feature): make it yourself in this folder.",
    `- Building the game or changing it substantially (a new game from a pitch, several systems at once, the look of the whole game, hours of work): call ${launch} with the goal in the user's words, what it delivers in in_scope and what it leaves out in cut — ${QUICK_IS_A_BUILD}. Reading and research first are fine; do not build the game yourself.`,
    `- If it is unclear whether they want a build, or a build would take hours they may not expect, ask with ${ask} (recommended choice first) and end your reply. Never call ${launch} in the same reply as a question, and never recommend what the user ruled out.`,
    askFirst(ask),
    `A build starts when your reply ends, from this folder exactly as you leave it: call ${launch} last, then recap in one short paragraph.`,
    frames > 0 ? `The user attached ${frames} still(s); a build's judges receive them automatically.` : "",
    grant.project ? `Pass "${grant.project}" as the tool's project argument.` : "",
  ].filter(Boolean);
}

/** The same decision for a direct engine's Loop or Autopilot briefing, which names `tool` bare. */
export function launchDecision(tool: string): string[] {
  return [
    `Decide from the latest message. ${SMALL_TALK}`,
    "Questions, research, plans, design documents and contained changes: do them yourself with your tools and answer here (put plans and documents in docs/ when asked). A request for research or a plan is not a request to build — deliver it, then offer to build from it.",
    `When the ask is to build the game or change it substantially, call ${tool} once, the goal in the user's words, what it delivers in in_scope and what it leaves out in cut — ${QUICK_IS_A_BUILD}; it starts from this folder as you leave it. If it is unclear whether they want a build, ask first.`,
    askFirst(askUser.name),
  ];
}
