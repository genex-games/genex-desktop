/**
 * What a run was commissioned to do: reach its verified outcomes (a goal commission) or spend its
 * hours (a duration commission). Every part of the run that decides whether to keep working
 * asks here. A module no earlier harness had, so no part the agent kept can shadow these names.
 */
import { CompletionPolicy } from "../completion-policy.ts";
import { ReferenceKind } from "../run-events.ts";
import type { Run } from "../../types/harness.d.ts";

/** Resolve legacy records without confusing a visual reference with an explicit completion policy. */
export function durationCommission(run: Pick<Run, "reference"> & { budgets?: Run["budgets"] }): boolean {
  if (run.budgets?.completionPolicy) return run.budgets.completionPolicy === CompletionPolicy.Duration;
  if (run.budgets?.untilSatisfied) return false;
  return run.reference?.kind === ReferenceKind.Direction;
}

/** New goal commissions and legacy until-satisfied runs use stable acceptance. */
export function goalCommission(run: Pick<Run, "budgets">): boolean {
  return (
    run.budgets?.completionPolicy === CompletionPolicy.Goal ||
    (!run.budgets?.completionPolicy && run.budgets?.untilSatisfied === true)
  );
}
