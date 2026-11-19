/**
 * What each line and each series of a chart is: a swatch beside its name. A line's swatch is drawn
 * as the line is (solid, dashed, dotted) and a series' as its fill, so nothing is told by hue alone.
 */
import type { JSX } from "react";
import type { LineTone, SeriesSlot } from "../../stats-chart.ts";

/** One entry of a legend: its name and what its swatch stands for (a line, a series, or an outlined bar). */
export type LegendItem = {
  id: string;
  label: string;
  /** The label is the creator's own words (a campaign, an event): kept out of usage recordings. */
  mask?: boolean;
} & ({ tone: LineTone } | { slot: SeriesSlot } | { outline: true });

/** A swatch for a line (`data-line`), a series (`data-series`) or an outlined bar (`data-outline`). */
function Swatch({ item }: { item: LegendItem }): JSX.Element {
  if ("tone" in item) return <span className="game-analytics-swatch" data-line={item.tone} aria-hidden="true" />;
  if ("slot" in item) return <span className="game-analytics-swatch" data-series={item.slot} aria-hidden="true" />;
  return <span className="game-analytics-swatch" data-outline="true" aria-hidden="true" />;
}

/**
 * A chart's legend. `items`: each entry's `id`, `label` and one of `tone` (a `LineTone`), `slot` (a
 * `SeriesSlot`) or `outline: true`. `LineChart` and `BarChart` draw their own; use this one when a
 * block draws its series itself or its section's head carries the legend.
 */
export function Legend({ items }: { items: readonly LegendItem[] }): JSX.Element {
  return (
    <ul className="game-analytics-legend" data-game-analytics-legend="true">
      {items.map((item) => (
        <li key={item.id} className="game-analytics-legend-item">
          <Swatch item={item} />
          <span data-analytics-mask={item.mask || undefined}>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}
