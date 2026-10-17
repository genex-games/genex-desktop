/**
 * The Unreal lead's `finish` answers of its own (lead-finish.ts); what a reviewer's check answers is
 * `../finish-check-prompts.ts`'s. A module of its own, so a lead-prompts.ts the agent kept from
 * before needs no new name. Model-facing: the lead reads them as written.
 */

/** `finish`'s own answers. */
export const LEAD_FINISH = {
  Accepted: "Accepted: the Loop closes after this turn; end your turn.",
  NeedsSummary: "finish needs a summary of what the game holds now.",
  Ending: "The run is already ending; end your turn.",
  PersonFinished: "The person asked the run to finish: it closes after this turn; end your turn.",
  NoReviewer:
    "No engine here can hold a reviewer to check your claim, so the run ends without a yes after this turn; end your turn.",
  NoTimeLeft:
    "The Loop's time ends too soon for a reviewer to check your claim, so it is not counted and the run ends at its time. Make sure NOTES.md says what you built and what you did not test, then end your turn.",
} as const;
