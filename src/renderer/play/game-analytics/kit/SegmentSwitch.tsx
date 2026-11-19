/**
 * A segmented control for one choice of a small closed set (a breakdown, an attribution, a
 * retention mode): a radio group in the track and the selected look of the Stats period switch.
 * Tab reaches the chosen option; the arrows, Home and End move along the row and choose.
 */
import type { JSX, KeyboardEvent } from "react";
import { isRovingKey, RovingAxis, rovingTarget } from "../../../ui/roving-focus.ts";

/** One option: its `value` (a vocabulary's wire value), its `label`, and `mask` when the label is the creator's own words. */
export interface SegmentOption<Value extends string> {
  value: Value;
  label: string;
  mask?: boolean;
}

/**
 * Props: `id` names the switch in `data-game-analytics-switch` (each option carries its value in
 * `data-game-analytics-option`); `label` says what is being chosen, for assistive technology;
 * `options` in order; `value` the chosen one; `onChange` gets the newly chosen value.
 */
export function SegmentSwitch<Value extends string>({
  id,
  label,
  options,
  value,
  onChange,
}: {
  id: string;
  label: string;
  options: readonly SegmentOption<Value>[];
  value: Value;
  onChange: (value: Value) => void;
}): JSX.Element {
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (!isRovingKey(event.key, RovingAxis.Both)) return;
    const next = rovingTarget(event.key, index, options.length, RovingAxis.Both);
    const target = next === null ? undefined : options[next];
    if (!target || next === null) return;
    event.preventDefault();
    onChange(target.value);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };
  return (
    <div className="game-analytics-segments" role="radiogroup" aria-label={label} data-game-analytics-switch={id}>
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          className="game-analytics-segment"
          data-game-analytics-option={option.value}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => move(event, index)}
        >
          <span data-analytics-mask={option.mask || undefined}>{option.label}</span>
        </button>
      ))}
    </div>
  );
}
