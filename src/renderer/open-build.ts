/**
 * Opening one build's graph from anywhere. The chat's result card for a build names its run; the
 * stage shows that run on Builds, and its status line offers the way back to the latest one. A step
 * of the chat's Building card names itself: Builds opens that step's row.
 */
export const OPEN_BUILD_EVENT = "studio:open-build";
/** A step of the running build was pressed in the chat: Builds opens its row. */
export const OPEN_BUILD_STEP_EVENT = "studio:open-build-step";

export function openBuildGraph(runId: string): void {
  window.dispatchEvent(new CustomEvent<{ runId: string }>(OPEN_BUILD_EVENT, { detail: { runId } }));
}

/** The step the chat asked for while Builds was not on show: it opens once Builds is. */
let waiting: string | null = null;

/** Ask Builds to open the row of one step of the chat's Building card, by the card's id for it. */
export function openBuildStep(stepId: string): void {
  waiting = stepId;
  window.dispatchEvent(new Event(OPEN_BUILD_STEP_EVENT));
}

/** The step the chat asked for, once: null when none waits. */
export function takeBuildStep(): string | null {
  const step = waiting;
  waiting = null;
  return step;
}
