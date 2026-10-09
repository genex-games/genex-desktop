/**
 * Who established an interaction result and what it rests on: the app's `InteractionSource` and
 * `InteractionObjective`, word for word. A file of its own, not run-events.ts: a seed upgrade may
 * keep an older run-events.ts the agent edited, which has neither, and every file importing them
 * from there would stop loading.
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
