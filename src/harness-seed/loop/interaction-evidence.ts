/**
 * What an interaction established, as the run's record keeps it (`run_interaction_evidence`): its
 * status, who established it, and whether the studio verified it. The hands-on judge and a
 * replayed route write it from outside the director, so its shape lives here once.
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import { InteractionObjective, InteractionSource } from "./interaction-words.ts";
import { appendRun, RunEvent } from "./run-events.ts";
import type { HarnessCtx } from "../types/harness.d.ts";

/** An interaction's outcome (`run_interaction_evidence.status`), as the app reads it. */
export const InteractionStatus = { Passed: "passed", Failed: "failed", Incomplete: "incomplete" } as const;
export type InteractionStatus = (typeof InteractionStatus)[keyof typeof InteractionStatus];

/** A check's pass as an interaction status: a pass, a fail, or nothing measured. */
export function interactionStatus(pass: boolean | null | undefined): InteractionStatus {
  if (pass === true) return InteractionStatus.Passed;
  if (pass === false) return InteractionStatus.Failed;
  return InteractionStatus.Incomplete;
}

/** One interaction record. */
export interface InteractionRecord {
  head: string | null;
  label: string;
  status: InteractionStatus;
  note: string | null;
  source: InteractionSource;
  objective: InteractionObjective;
  /** The session's trace file, when it played through the computer tool. */
  trace?: string | null;
}

/** The record's payload: the trace only when there is one. */
export function interactionPayload(record: InteractionRecord): Record<string, unknown> {
  const { trace, ...rest } = record;
  return trace ? { ...rest, trace } : rest;
}

/** Write one interaction record on the run's thread; a failed write is never worth the run. */
export function appendInteraction(ctx: HarnessCtx, runId: string, record: InteractionRecord): Promise<unknown> {
  return appendRun(ctx, ctx.threadId, RunEvent.RunInteractionEvidence, interactionPayload(record), { runId }).catch(
    () => {},
  );
}

export { InteractionObjective, InteractionSource };
