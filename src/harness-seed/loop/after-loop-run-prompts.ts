/**
 * What the chat's own session reads on each of its turns after a run it led, for as long as that
 * run is the chat's latest (after-loop-run.ts): the build is over, its hands are back, the run's
 * controls it keeps, spelled for its engine — and, after a finished build with Loop on, its reopen
 * (reopen-run-prompts.ts).
 */
import { toolCall } from "./model-roles.ts";
import { reopenRules, type ReopenGrant } from "./reopen-run-prompts.ts";
import { RunState } from "./run-events.ts";
import { clip, CLIP_QUOTE } from "./text.ts";
import type { AfterLoopRun } from "./after-loop-run.ts";

/**
 * This note words a finished build's reopen when the turn grants it (`reopenRules`), and no longer
 * sends a finished build's change to the composer. chat-dispatch.ts asks before it offers the reopen
 * (`servesReopen`): a kept copy from before would word the old rules.
 */
export const SERVES_REOPEN = true;

/** What the chat is told when the studio did not resume the run the session asked for. */
export const MESSAGE = {
  notResumed: (why: string) => `The build was not resumed: ${why}`,
  /** Why, when Stop came after the reply and before the run was under way again. */
  stoppedFirst: "Stop came before it started again. It stays paused.",
} as const;

/** How the run ended, in a clause: finished and landed or not, or paused and why. */
function closedWords(loopRun: AfterLoopRun): string {
  if (loopRun.state === RunState.Paused)
    return `is PAUSED${loopRun.stoppedBecause ? ` (${clip(loopRun.stoppedBecause, CLIP_QUOTE)})` : ""}`;
  if (loopRun.landed === true) return "finished, and its build is in the game folder";
  if (loopRun.landed === false) return "finished; its build was not put in the game folder";
  return "finished";
}

/** A finished run's change with Loop off (or no reopen granted): the session's own work. */
const OWN_WORK =
  "- Work the user asks for now, you do yourself, here in the game folder, like any change in this chat — no build starts for it.";

/**
 * The paused run's resume; a finished run's reopen when the turn grants it (Loop on,
 * reopen-run.ts); otherwise what a finished run's change is: the session's own work.
 */
function workRules(loopRun: AfterLoopRun, engine: string | undefined, grant: ReopenGrant | null): string[] {
  if (loopRun.state === RunState.Paused)
    return [
      `- This build is paused. When the user asks to go on with it — with new guidance or none, or with work for it — call ${toolCall(engine, "resume_run")} once, last, with their instruction as text, and edit nothing in that reply: when your reply ends the build resumes where it stopped, with the working time it had left, and you lead it again.`,
    ];
  if (grant) return reopenRules(engine, grant);
  return [OWN_WORK];
}

/**
 * The note that opens each turn of the chat's own session after its run, while that run is the
 * chat's latest: in place of "pick up where you left off" on a resumed session, after the chat so
 * far on a fresh one. `grant`: the finished build's reopen this turn offers (Loop on).
 */
export function afterLoopRunNote(
  loopRun: AfterLoopRun,
  engine: string | undefined,
  grant: ReopenGrant | null = null,
): string {
  const goal = loopRun.goal ? ` ("${clip(loopRun.goal, CLIP_QUOTE)}")` : "";
  return [
    `THE BUILD IS OVER: run ${loopRun.runId}${goal} ${closedWords(loopRun)}. You are this chat's own session, back in the game folder with your hands: the build no longer runs, and you may read and edit the game here as in any turn of this chat.`,
    "- Answer a question yourself: a question never restarts the build or starts one.",
    ...workRules(loopRun, engine, grant),
    `- The run's controls: ${toolCall(engine, "run_status")} reads where it stands; ${toolCall(engine, "show_build")} opens a build in Live without changing the game folder (integration: what the run built; live: the game folder as it is), only when the user asks to see or play it: never to show your own edits, which the stage's Reload button offers by itself; ${toolCall(engine, "land_build")} puts what the run built into the game folder — it refuses while the folder has uncommitted edits: say so, and never discard them. After either, say what it answered: open in Live, on the right, or waiting behind Reload while the user watches Live.`,
    "- Speak the user's terms: Live, Builds, the build, your game folder — never integration branch or worktree.",
  ].join("\n");
}
