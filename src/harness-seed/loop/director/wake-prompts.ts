/**
 * The lines Genex itself writes to a Loop's lead (wake.ts): that its Loop started or resumed, why
 * the turn under way is its last, and that the person waits for an answer to the words that open a
 * turn. Each is marked as Genex's: what the lead can do is in its tools' descriptions, and where the
 * run stands is `run_status`'s answer. Model-facing: the lead reads them as written.
 */

/** What a Loop's goal is to its lead: all of its work, and where it ends. */
const GOAL_BOUNDS =
  "That goal is all of this Loop's work: add none the person didn't ask for, and finish once it is reached.";

/**
 * The plan the chat named as it started the Loop, as the lead reads it: the person watches it on the
 * Building card ("Step 2 of 4 · …"), where each save point ticks the next step. Nothing without one.
 */
function planLine(steps: readonly string[]): string {
  if (!steps.length) return "";
  const listed = steps.map((step, at) => `${at + 1}. ${step}`).join("\n");
  return `\nIts plan, as the person sees it on the Building card:\n${listed}\nMake one save point as each step is done, in this order: each one ticks the next step for the person. If the plan changes, name the whole plan again in save_point's steps, done steps included.`;
}

/** What Genex tells a Loop's lead. */
export const LOOP_WORDS = {
  /**
   * Said last before the person's words when they open the lead's turn (news.ts `askOf`). A lead
   * deep in a Loop read a question of theirs, looked into it and built on without a word to them
   * (castle-artillery): the standing rule to answer first was not enough at that moment.
   */
  personWaits:
    "The person wrote the message below in the chat while the Loop works, and waits there for your answer: answer it first, in a sentence or two, then go on.",
  /**
   * The Loop's first line: its goal, as the chat's session wrote it when it started the Loop, and that
   * the goal bounds the work. A Loop started to go on with a blockout and pick Fab assets drove on
   * toward a shipped build (DeathWish).
   */
  started: (goal: string, steps: readonly string[] = []) =>
    `The Loop started. Its goal: ${goal}\n${GOAL_BOUNDS}${planLine(steps)}`,
  /** A resumed Loop's first line. */
  resumed: (goal: string, steps: readonly string[] = []) =>
    `The Loop resumed after a pause; workers from before it no longer run. Its goal: ${goal}\n${GOAL_BOUNDS}${planLine(steps)}`,
  /** The wrap-up turn the person's Finish starts. */
  finishAsked: "The person asked the Loop to finish: it closes when this turn ends.",
  /** The wrap-up turn a failed turn starts. */
  turnFailed: (why: string) => `Your last turn failed${why ? ` (${why})` : ""}: the Loop closes when this turn ends.`,
} as const;
