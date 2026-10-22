/**
 * A few named steps shown as one bar of segments, each done, under way or still to come (`StepBar`):
 * the Genex publish and a Play remix say their progress with it.
 */

/** Where a step stands on the bar. */
export const StepState = { Done: "done", Current: "current", Next: "next" } as const;
export type StepState = (typeof StepState)[keyof typeof StepState];

/** One segment of the bar and the name under it. */
export interface StepSegment {
  key: string;
  label: string;
  state: StepState;
}

/** The step at `index` when the one at `at` is under way: those before it done, those after it to come. */
export function stepStateAt(index: number, at: number): StepState {
  if (index < at) return StepState.Done;
  return index === at ? StepState.Current : StepState.Next;
}
