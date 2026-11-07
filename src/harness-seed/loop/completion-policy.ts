/**
 * What a run's budgets say ends it (`budgets.completionPolicy`): the copy of the app's
 * `shared/run-state.ts` vocabulary, held equal to it by `seed-contracts.test.ts`. A Loop the person
 * gave a time to (loop/work-time.ts) writes `duration`; one with no time names none.
 */

/** What ends a run: the goal reached, or the time the person asked for. Persisted: never rename a value. */
export const CompletionPolicy = {
  Goal: "goal",
  Duration: "duration",
} as const;
export type CompletionPolicy = (typeof CompletionPolicy)[keyof typeof CompletionPolicy];
