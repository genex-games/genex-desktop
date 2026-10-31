/**
 * The Unreal lead's `finish` answers of its own (lead-finish.ts); a reviewer's no is
 * `../director/second-opinion-prompts.ts`'s. Model-facing: the lead reads them as written.
 */

/** `finish`'s own answers. */
export const LEAD_FINISH = {
  Accepted: "The Loop closes after this turn; end your turn.",
  NeedsSummary: "finish needs a summary of what the game holds now.",
  Ending: "The run is already ending; end your turn.",
  PersonFinished: "The person asked the run to finish: it closes after this turn; end your turn.",
  /** A review the lead asked for that gave no answer (no engine could hold a reviewer, or no time was left). */
  NoReview:
    "No reviewer could answer. Call finish again without review to close the run as you judge it, or keep working.",
} as const;
