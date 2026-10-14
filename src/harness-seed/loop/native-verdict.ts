/**
 * Additive native verdicts live here so fresh director parts still link beside an older
 * verdict.ts that a seed upgrade preserved for the agent's edits.
 */
import type { CheckEvidence } from "./checks.ts";
import { TargetRefusal } from "./native-contract.ts";
import type { NotLandedReason, VerdictRule } from "./verdict.ts";

/**
 * A failed native check reads the same on a Rust · wgpu game as on a raylib one: these verdicts
 * name no stack, so a Rust night may rely on them.
 */
export const SERVES_RUST = true;

/** The literal table is inferred independently of the verdict module's derived types. */
const NATIVE_VERDICT = {
  Rule: "native-check-failed",
  NotLanded: "final-check-failed",
} as const;

/** Native-check wire values, independent of an older verdict module's runtime vocabulary. */
export const NativeVerdict: typeof NATIVE_VERDICT = NATIVE_VERDICT satisfies {
  Rule: VerdictRule;
  NotLanded: NotLandedReason;
};

/** Distinguish a failed native check from a load failure, using the caller's existing fallback. */
export function failedObservationRule(
  evidence: Pick<CheckEvidence, "parity"> & { loadError?: string | null; crashed?: boolean },
  fallback: VerdictRule,
): VerdictRule {
  if (evidence.loadError || evidence.crashed || evidence.parity?.refusal === TargetRefusal.NoJudgingTarget)
    return fallback;
  if (evidence.parity?.pass === false) return NativeVerdict.Rule;
  return fallback;
}
