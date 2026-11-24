/**
 * Lines over days, or over days since the first play: this period's line, a dashed one for the
 * period before, a dotted one for similar games. A line breaks where a value is missing, marks
 * stand on the days a campaign or a version began, and the pointer or the arrow keys read every
 * series' value at one place. Drawn on canvas (`stats-chart.ts`); a table says the same in text.
 */
import type { JSX } from "react";
import { useRef } from "react";
import { formatList } from "../../../../shared/i18n.ts";
import { useRedraw } from "../../StatsCharts.tsx";
import { type ChartMark, drawLines, indexAt, type LineSeries, plotBox } from "../../stats-chart.ts";
import { ChartTable, useChartCursor } from "./chart-frame.tsx";
import { DASH } from "./format.ts";
import { Legend } from "./Legend.tsx";
import { KIT_WORDS } from "./words.ts";

/** The chart's height when none is given, in CSS pixels. */
const LINE_CHART_HEIGHT = 240;

/** What a line chart shows. */
export interface LineChartProps {
  /** Names the chart in `data-game-analytics-chart`. */
  id: string;
  /** What the chart shows, in a sentence: the caption of its table and the plot's name. */
  label: string;
  /** The lines: each `id`, `label`, `tone` (`LineTone.Main`, `Before`, `Similar`) and a value per place, null for a gap. */
  series: readonly LineSeries[];
  /** Each place's name: a date (`periodLabels(window)`) or "Day 7". */
  labels: readonly string[];
  /**
   * A value as the readout and the table write it, and the axis unless `axisFormat` is given:
   * `formatNumber`, `formatPercent`, `formatDuration`.
   */
  format: (value: number) => string;
  /** A step of the value axis, when the axis rounds more than the readout: `formatAxisPercent` for a rate. */
  axisFormat?: (value: number) => string;
  /** The table's first column heading; "Day" when left out. */
  place?: string;
  /** Marks on places: `marksOf(annotations, periodDays(window))`. */
  marks?: readonly ChartMark[];
  /** The places named under the plot; a few dates when left out. */
  ticks?: readonly number[];
  /** Places whose value on the main line is written on the plot. */
  callouts?: readonly number[];
  /** The axis's top when it must not follow the data. */
  top?: number;
  /** Whether the axis keeps whole steps; left out, it does when every value is a whole number, as counts are. */
  whole?: boolean;
  /** A soft fill under the main line. */
  fill?: boolean;
  /** The plot's height in CSS pixels; 240 when left out. */
  height?: number;
  /** False hides the legend the chart draws for two lines or more, when the section's head carries it. */
  legend?: boolean;
}

/** A line chart; see `LineChartProps` for each prop. */
export function LineChart(props: LineChartProps): JSX.Element {
  const { id, label, series, labels, format, marks = [] } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const cursor = useChartCursor(labels.length, (x, width, height) => indexAt(x, plotBox(width, height), labels.length));
  useRedraw(canvas, (element) =>
    drawLines(element, {
      series,
      labels,
      hovered: cursor.hovered,
      format: (value) => (value === null ? DASH : format(value)),
      axisFormat: props.axisFormat,
      marks,
      ticks: props.ticks,
      callouts: props.callouts,
      top: props.top,
      whole: props.whole,
      fill: props.fill,
    }),
  );
  const rows = labels.map((place, index) => ({
    place,
    cells: series.map((line) => {
      const value = line.values[index] ?? null;
      return value === null ? "" : format(value);
    }),
    mark: formatList(marks.filter((mark) => mark.index === index).map((mark) => mark.label)),
  }));
  return (
    <figure className="game-analytics-chart" data-game-analytics-chart={id} data-chart="line">
      {props.legend !== false && series.length > 1 && (
        <Legend items={series.map((line) => ({ id: line.id, label: line.label, tone: line.tone }))} />
      )}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the arrow keys read the chart's values, as the pointer does */}
      <div className="game-analytics-plot" role="img" aria-label={label} tabIndex={0} {...cursor.handlers}>
        <canvas
          ref={canvas}
          className="game-analytics-canvas"
          style={{ height: props.height ?? LINE_CHART_HEIGHT }}
          aria-hidden="true"
        />
      </div>
      <ChartTable
        label={label}
        place={props.place ?? KIT_WORDS.day}
        columns={series.map((line) => ({ id: line.id, label: line.label }))}
        rows={rows}
        marks={marks.length > 0 ? KIT_WORDS.marks : undefined}
      />
    </figure>
  );
}
