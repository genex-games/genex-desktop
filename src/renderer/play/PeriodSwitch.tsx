/**
 * The period switch of the Stats page and of a game's analytics page: 7, 30 or 90 days as a small
 * segmented row with one tab stop; the arrow keys move along it and choose.
 */
import type { JSX, KeyboardEvent } from "react";
import { STATS_PERIODS, type StatsPeriod } from "../../shared/play-stats.ts";
import { PLAY_WORDS } from "../words.ts";

const WORDS = PLAY_WORDS.stats;
/** The attribute the Stats page's period buttons carry. */
const STATS_ATTRIBUTE = "data-stats-period";

/** The period switch; `attribute` names the data attribute each button carries its days in. */
export function PeriodSwitch({
  period,
  onChange,
  attribute = STATS_ATTRIBUTE,
}: {
  period: StatsPeriod;
  onChange: (period: StatsPeriod) => void;
  attribute?: `data-${string}`;
}): JSX.Element {
  const keys = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const moves: Record<string, number> = { ArrowLeft: index - 1, ArrowRight: index + 1 };
    const next = STATS_PERIODS[moves[event.key] ?? -1];
    if (next === undefined) return;
    event.preventDefault();
    onChange(next);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[${attribute}="${next}"]`)?.focus();
  };
  return (
    <div className="stats-periods" role="tablist" aria-label={WORDS.periodLabel}>
      {STATS_PERIODS.map((days, index) => (
        <button
          key={days}
          type="button"
          role="tab"
          aria-selected={days === period}
          tabIndex={days === period ? 0 : -1}
          {...{ [attribute]: days }}
          className="stats-period"
          onClick={() => onChange(days)}
          onKeyDown={(event) => keys(event, index)}
        >
          {WORDS.period(days)}
        </button>
      ))}
    </div>
  );
}
