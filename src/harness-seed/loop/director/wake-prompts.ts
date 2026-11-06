/**
 * The lines Genex itself writes to a Loop's lead (wake.ts): that its Loop started or resumed, why
 * the turn under way is its last, and that the person waits for an answer to the words that open a
 * turn. Each is marked as Genex's: what the lead can do is in its tools' descriptions, and where the
 * run stands is `run_status`'s answer. Model-facing: the lead reads them as written.
 */

/** What Genex tells a Loop's lead. */
export const LOOP_WORDS = {
  /**
   * Said last before the person's words when they open the lead's turn (news.ts `askOf`). A lead
   * deep in a Loop read a question of theirs, looked into it and built on without a word to them
   * (castle-artillery): the standing rule to answer first was not enough at that moment.
   */
  personWaits:
    "The person wrote the message below in the chat while the Loop works, and waits there for your answer: answer it first, in a sentence or two, then go on.",
  /** The Loop's first line: its goal, as the chat's session wrote it when it started the Loop. */
  started: (goal: string) => `The Loop started. Its goal: ${goal}`,
  /** A resumed Loop's first line. */
  resumed: (goal: string) => `The Loop resumed after a pause; workers from before it no longer run. Its goal: ${goal}`,
  /** The wrap-up turn the person's Finish starts. */
  finishAsked: "The person asked the Loop to finish: it closes when this turn ends.",
  /** The wrap-up turn a failed turn starts. */
  turnFailed: (why: string) => `Your last turn failed${why ? ` (${why})` : ""}: the Loop closes when this turn ends.`,
} as const;
