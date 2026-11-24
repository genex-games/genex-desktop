/**
 * Bars per day: one series plain, or several stacked with a legend; and a histogram over named
 * buckets. The per-day bars are drawn on canvas (`stats-chart.ts`) with a readout under the pointer
 * or the arrow keys and a table that says the same in text; the histogram is plain DOM, every
 * bucket's value written over its bar.
 */
import type { JSX } from "react";
import { useRef } from "react";
import { formatList } from "../../../../shared/i18n.ts";
import { useRedraw } from "../../StatsCharts.tsx";
import { bandAt, type BarSeries, type ChartMark, drawBars, plotBox, stackTotals } from "../../stats-chart.ts";
import { ChartTable, useChartCursor } from "./chart-frame.tsx";
import { cssVars } from "./css.ts";
import { DASH } from "./format.ts";
import { bucketHeights } from "./geometry.ts";
import { Legend, type LegendItem } from "./Legend.tsx";
import { KIT_WORDS } from "./words.ts";

/** The chart's height when none is given, in CSS pixels. */
const BAR_CHART_HEIGHT = 220;
/** The key of the table's column that sums stacked series. */
const TOTAL_COLUMN = "total";

/** What a bar chart shows. */
export interface BarChartProps {
  /** Names the chart in `data-game-analytics-chart`. */
  id: string;
  /** What the chart shows, in a sentence: the caption of its table and the plot's name. */
  label: string;
  /** One series for plain bars, several to stack them (the first at the foot): each `id`, `label`, `slot` (a `SeriesSlot`, see `CHANNEL_SLOT`, `OS_SLOT`) and a number per day. */
  series: readonly BarSeries[];
  /** Each day's name: `periodLabels(window)`. */
  labels: readonly string[];
  /** A value as the axis, the readout and the table write it. */
  format: (value: number) => string;
  /** The table's first column heading; "Day" when left out. */
  place?: string;
  /** Marks on days: `marksOf(annotations, periodDays(window))`. */
  marks?: readonly ChartMark[];
  /** The days named under the plot; a few dates when left out. */
  ticks?: readonly number[];
  /** Whether the axis keeps whole steps; left out, it does when every value is a whole number, as counts are. */
  whole?: boolean;
  /** The plot's height in CSS pixels; 220 when left out. */
  height?: number;
  /** False hides the legend the chart draws for stacked series, when the section's head carries it. */
  legend?: boolean;
  /**
   * A number per day drawn under the baseline as an outlined bar, on the stack's scale: the players
   * who left, beside the ones who are there. It is no part of the total, and reads as a negative.
   */
  below?: { id: string; label: string; values: readonly number[] };
}

/** The chart's text equivalent: a column per series, their total when stacked, and what hangs under the baseline. */
function tableOf(props: BarChartProps): {
  columns: { id: string; label: string }[];
  rows: { place: string; cells: string[]; mark: string }[];
} {
  const { series, labels, format, below, marks = [] } = props;
  const stacked = series.length > 1;
  const totals = stackTotals(series.map((entry) => entry.values));
  return {
    columns: [
      ...series.map((entry) => ({ id: entry.id, label: entry.label })),
      ...(stacked ? [{ id: TOTAL_COLUMN, label: KIT_WORDS.total }] : []),
      ...(below ? [{ id: below.id, label: below.label }] : []),
    ],
    rows: labels.map((place, index) => ({
      place,
      cells: [
        ...series.map((entry) => format(entry.values[index] ?? 0)),
        ...(stacked ? [format(totals[index] ?? 0)] : []),
        ...(below ? [format(-(below.values[index] ?? 0))] : []),
      ],
      mark: formatList(marks.filter((mark) => mark.index === index).map((mark) => mark.label)),
    })),
  };
}

/** The legend's entries: each stacked series, then what hangs under the baseline. */
function legendOf({ series, below }: BarChartProps): LegendItem[] {
  return [
    ...series.map((entry) => ({ id: entry.id, label: entry.label, slot: entry.slot })),
    ...(below ? [{ id: below.id, label: below.label, outline: true as const }] : []),
  ];
}

/** A bar chart over days; see `BarChartProps` for each prop. */
export function BarChart(props: BarChartProps): JSX.Element {
  const { id, label, series, labels, format, below, marks = [] } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const cursor = useChartCursor(labels.length, (x, width, height) => bandAt(x, plotBox(width, height), labels.length));
  useRedraw(canvas, (element) =>
    drawBars(element, {
      series,
      labels,
      hovered: cursor.hovered,
      format,
      marks,
      ticks: props.ticks,
      whole: props.whole,
      totalLabel: KIT_WORDS.total,
      below,
    }),
  );
  const legend = legendOf(props);
  const table = tableOf(props);
  return (
    <figure className="game-analytics-chart" data-game-analytics-chart={id} data-chart="bar">
      {props.legend !== false && legend.length > 1 && <Legend items={legend} />}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the arrow keys read the chart's values, as the pointer does */}
      <div className="game-analytics-plot" role="img" aria-label={label} tabIndex={0} {...cursor.handlers}>
        <canvas
          ref={canvas}
          className="game-analytics-canvas"
          style={{ height: props.height ?? BAR_CHART_HEIGHT }}
          aria-hidden="true"
        />
      </div>
      <ChartTable
        label={label}
        place={props.place ?? KIT_WORDS.day}
        columns={table.columns}
        rows={table.rows}
        marks={marks.length > 0 ? KIT_WORDS.marks : undefined}
      />
    </figure>
  );
}

/** One bucket of a histogram: its name under the bar, its value (null when unknown), and a quiet line over the value. */
export interface HistogramBucket {
  id: string;
  label: string;
  value: number | null;
  note?: string;
}

/**
 * A histogram over named buckets (play lengths, days a week, levels). Props: `id` names it in
 * `data-game-analytics-histogram`; `label` says what it shows, for assistive technology; `buckets`
 * in order; `format` writes a bucket's value over its bar. The tallest bucket is picked out
 * (`data-peak`), and every value is text, so the bars are only a picture of it.
 */
export function Histogram({
  id,
  label,
  buckets,
  format,
}: {
  id: string;
  label: string;
  buckets: readonly HistogramBucket[];
  format: (value: number) => string;
}): JSX.Element {
  const heights = bucketHeights(buckets.map((bucket) => bucket.value));
  const tallest = Math.max(0, ...heights);
  const peak = tallest > 0 ? heights.indexOf(tallest) : -1;
  return (
    <ol className="game-analytics-histogram" aria-label={label} data-game-analytics-histogram={id}>
      {buckets.map((bucket, index) => (
        <li
          key={bucket.id}
          className="game-analytics-bucket"
          data-game-analytics-bucket={bucket.id}
          data-peak={index === peak || undefined}
        >
          {bucket.note && <span className="game-analytics-bucket-note">{bucket.note}</span>}
          <span className="game-analytics-bucket-value">{bucket.value === null ? DASH : format(bucket.value)}</span>
          <span
            className="game-analytics-bucket-bar"
            aria-hidden="true"
            style={cssVars({ "--game-analytics-share": heights[index] ?? 0 })}
          />
          <span className="game-analytics-bucket-label">{bucket.label}</span>
        </li>
      ))}
    </ol>
  );
}
