/**
 * The kit every game analytics report is drawn with. A report imports from here, never from the
 * files beside it. Only the page's header (`page-view.ts` and `page-dates.ts`, kept free of React)
 * and the Stats page's day labels take their words straight from `format.ts`, so a day and an
 * "ago" are written one way everywhere. What there is, by job:
 *
 * - Layout: `ReportSection` (a titled block with a hint, controls and a footnote),
 *   `ReportColumns` (sections side by side), `EmptyNote` (a block with nothing to show yet),
 *   `MiniStats` (small numbers in a row), `TermList` (terms and what they mean).
 * - Numbers: `MetricTiles` and `MetricTile` (label, value, change, note, sparkline; a button when
 *   it picks the chart's measure), `DeltaMark` with `DeltaKind` (a change in percent, in points or
 *   in a unit).
 * - Choices: `SegmentSwitch` (one of a small closed set).
 * - Charts: `LineChart` (this period, the one before, similar games; gaps; marks), `BarChart`
 *   (per day, plain or stacked), `Histogram` (named buckets), `Heatmap` (weekday by hour),
 *   `CohortTable` (the retention triangle), `FunnelSteps`, `BarList`, `Legend`.
 * - Tables: `DataTable` with `ColumnKind` columns.
 * - Writing numbers: everything in `format.ts`. A missing value is `DASH`, never zero.
 * - Sums: `ratio`, `share`, `difference`, `funnelFlow`, `barShares`, `weekRows`, `marksOf`, and the canvas
 *   charts' geometry from `stats-chart.ts`.
 * - Colours: `SeriesSlot` with `CHANNEL_SLOT` and `OS_SLOT`, so a thing keeps its colour on every
 *   chart; `LineTone` for a line's kind.
 *
 * Styles are `game-analytics-*` in `styles/game-analytics.css`; a report's own layout goes in its
 * `styles/game-analytics-<report>.css`.
 */
export type { BarSeries, ChartMark, LineSeries } from "../../stats-chart.ts";
export { LineTone, SeriesSlot } from "../../stats-chart.ts";
export type { BarChartProps, HistogramBucket } from "./BarChart.tsx";
export { BarChart, Histogram } from "./BarChart.tsx";
export type { DataColumn, DataTableProps } from "./DataTable.tsx";
export { ColumnKind, DataTable } from "./DataTable.tsx";
export type { BarListItem, FunnelStepItem } from "./FunnelSteps.tsx";
export { BarList, FunnelSteps } from "./FunnelSteps.tsx";
export {
  DASH,
  DURATION_DIGITS,
  difference,
  formatAgo,
  formatAxisPercent,
  formatCompact,
  formatDay,
  formatDayRange,
  formatDayTime,
  formatDuration,
  formatHour,
  formatHours,
  formatNex,
  formatNexAmount,
  formatNexPerPlayer,
  formatNumber,
  formatPercent,
  formatPoints,
  formatSeconds,
  formatSigned,
  formatSignedDuration,
  formatWeekday,
  POINT_DIGITS,
  periodLabels,
  ratio,
  roundsToZero,
  share,
  weekdayName,
} from "./format.ts";
export type { FunnelFlow } from "./geometry.ts";
export { barShares, bucketHeights, funnelFlow, heatLevel, marksOf, weekRows } from "./geometry.ts";
export type { CohortRow } from "./Heatmap.tsx";
export { CohortTable, Heatmap } from "./Heatmap.tsx";
export type { LegendItem } from "./Legend.tsx";
export { Legend } from "./Legend.tsx";
export type { LineChartProps } from "./LineChart.tsx";
export { LineChart } from "./LineChart.tsx";
export type { MetricDelta, MetricTileProps } from "./MetricTile.tsx";
export { DeltaKind, DeltaMark, MetricTile, MetricTiles } from "./MetricTile.tsx";
export type { MiniStat } from "./ReportSection.tsx";
export { EmptyNote, MiniStats, ReportColumns, ReportSection, TermList } from "./ReportSection.tsx";
export type { SegmentOption } from "./SegmentSwitch.tsx";
export { SegmentSwitch } from "./SegmentSwitch.tsx";
export { CHANNEL_SLOT, OS_SLOT } from "./series.ts";
