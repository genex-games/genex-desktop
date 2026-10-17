/** What the host answers the chat's own session about a worker tool call it did not forward (`worker-tools.ts`). Model-facing. */

/** The host's own answers to a worker tool call. */
export const WORKER_TOOL_ANSWER = {
  writersWaitForPlan:
    "The chat is in Plan: writers start once the person approves your plan. Put this worker in it. Readers (isolation read, with no type) can start now.",
  mergesWaitForPlan:
    "The chat is in Plan: a worker's work is merged once the person approves your plan. Put the merge in it; marking work rejected can happen now.",
  landingWaitsForPlan:
    "The chat is in Plan: the build lands in the game once the person approves your plan. Put the landing in it, or finish with land=no now.",
  runChatUnknown:
    "Genex could not find the chat this run was started in, so it cannot tell whether that chat is planning: this waits until it can. Readers can start now.",
  unavailable: (name: string) =>
    `the studio's loop code predates workers — ${name} is unavailable until the harness is upgraded`,
  failed: (name: string, why: string) => `${name} failed: ${why}`,
} as const;
