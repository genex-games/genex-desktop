/**
 * The words an interaction result is recorded with (`run_interaction_evidence`): who established it
 * and what it rests on — the app's `InteractionSource` and `InteractionObjective`
 * (`src/shared/run-summary.ts`), word for word, held equal by `seed-contracts.test.ts`.
 *
 * A file of its own, not `run-events.ts`: an agent-edited copy of that file is kept across seed
 * upgrades, and a name it predates would stop the harness loading.
 */
/** Who established an interaction result (`run_interaction_evidence.source`): the app's `InteractionSource`, word for word. */
export const InteractionSource = {
  IndependentPlaytester: "independent-playtester",
  HandsOnJudge: "hands-on-judge",
  RouteReplay: "route-replay",
} as const;
export type InteractionSource = (typeof InteractionSource)[keyof typeof InteractionSource];

/** Whether an interaction result rests on the studio's check of the game's state or the model's word: the app's `InteractionObjective`. */
export const InteractionObjective = {
  StudioVerified: "studio-verified",
  ModelSaid: "model-said",
} as const;
export type InteractionObjective = (typeof InteractionObjective)[keyof typeof InteractionObjective];
