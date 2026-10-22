/**
 * Steps as one bar of segments with their names under it (`step-bar.ts`): done segments filled,
 * the one under way crossed by a light so a long step never looks stuck, the rest to come.
 */
import type { JSX } from "react";
import type { StepSegment } from "./step-bar.ts";
import { StepState } from "./step-bar.ts";

/** The steps as one bar, `label` and `valueText` telling a screen reader what it measures and where it stands. */
export function StepBar({
  steps,
  label,
  valueText,
}: {
  steps: readonly StepSegment[];
  /** What the bar measures, for a screen reader. */
  label: string;
  /** Where it stands now, in words. */
  valueText: string;
}): JSX.Element {
  const at = steps.findIndex((step) => step.state === StepState.Current);
  return (
    <div className="step-bar-group">
      <div
        className="step-bar"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={Math.max(at, 0)}
        aria-valuetext={valueText}
      >
        {steps.map((step) => (
          <span key={step.key} data-state={step.state} />
        ))}
      </div>
      <div className="step-bar-labels" aria-hidden>
        {steps.map((step) => (
          <span key={step.key} data-state={step.state}>
            {step.label}
          </span>
        ))}
      </div>
    </div>
  );
}
