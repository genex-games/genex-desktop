/**
 * The stats pages' charts, drawn on canvas with thin marks. The account's Stats page: the
 * plays-per-day line over a soft fill with three gridlines, a few dates and, on hover, a crosshair
 * and a tooltip; and the sparklines beside the tiles and in the per-game table, the latest week in
 * the accent and the days before it soft. A game's analytics: several lines over days or over days
 * since the first play (this period, a dashed one for the period before, a dotted one for similar
 * games) that break where a value is missing, bars per day stacked by series, and marks on the days
 * a campaign or a version began. The geometry is pure and exported; the colours come from the page's
 * CSS (`--stats-*` in `people.css`), so both themes draw right.
 */
import { AnnotationKind } from "../../shared/game-analytics.ts";

/** How a line is drawn: this period's, the period before's (dashed), similar games' (dotted). */
export const LineTone = { Main: "main", Before: "before", Similar: "similar" } as const;
export type LineTone = (typeof LineTone)[keyof typeof LineTone];

/**
 * A series' place in the palette (`--stats-series-*`): six hues in a fixed order, and a grey for
 * "everything else". A thing keeps its slot on every chart, so it keeps its colour.
 */
export const SeriesSlot = {
  First: "1",
  Second: "2",
  Third: "3",
  Fourth: "4",
  Fifth: "5",
  Sixth: "6",
  Rest: "rest",
} as const;
export type SeriesSlot = (typeof SeriesSlot)[keyof typeof SeriesSlot];

/** The chart's colours, read from the canvas's CSS custom properties. */
export interface ChartColors {
  line: string;
  soft: string;
  fill: string;
  grid: string;
  ink: string;
  text: string;
  surface: string;
  edge: string;
  crosshair: string;
  /** The shadow under the tooltip's card. */
  shadow: string;
  /** The period before's line, and similar games'. */
  before: string;
  similar: string;
  /** The fill of each stacked series. */
  series: Record<SeriesSlot, string>;
  /** The line and dot of a mark on a day. */
  marks: Record<AnnotationKind, string>;
}

/** The area chart's margins, in CSS pixels: room for the values on the left and the dates below. */
export const AREA_MARGIN = { left: 46, right: 10, top: 12, bottom: 26 } as const;
/** Every day is labelled when each has at least this many pixels; else a few. */
const ROOMY_DAY_PX = 56;
/** The sparkline's latest stretch, in days, drawn in the accent. */
const SPARK_RECENT_DAYS = 8;
const MONO = '"Geist Mono", ui-monospace, monospace';
/** How many steps a value axis aims for, and the steps it may take: 1, 2, 2.5, 5 or 10 times a power of ten. */
const AXIS_STEPS = 4;
const NICE_STEPS = [1, 2, 2.5, 5, 10];
/** A plot under this height, in pixels, gets half as many gridlines. */
const SHORT_PLOT_PX = 150;
/** The share of a day's band left empty beside its bar, and the widest a bar gets, in pixels. */
const BAR_GAP_SHARE = 0.28;
const BAR_MAX_PX = 28;
/** The gap between two stacked parts, and the radius of a bar's top, in pixels. */
const SEGMENT_GAP_PX = 1;
const BAR_RADIUS_PX = 3;
/** A row of marks' labels over the plot: its height, how many rows there may be, the gap beside a label. */
const MARK_LANE_PX = 16;
const MARK_LANES = 2;
const MARK_GAP_PX = 6;
/** The readout's row height, padding and swatch width, in pixels. */
const READOUT_ROW_PX = 18;
const READOUT_PAD_PX = 10;
const READOUT_SWATCH_PX = 16;
const DASHES: Record<LineTone, number[]> = {
  [LineTone.Main]: [],
  [LineTone.Before]: [5, 4],
  [LineTone.Similar]: [1, 4],
};
const LINE_WIDTHS: Record<LineTone, number> = {
  [LineTone.Main]: 2,
  [LineTone.Before]: 1.5,
  [LineTone.Similar]: 1.5,
};
/** The order lines are drawn in, the one that matters most last and so on top. */
const TONE_ORDER: readonly LineTone[] = [LineTone.Similar, LineTone.Before, LineTone.Main];

/** The colours the page's CSS gives `element` (`--stats-*`, set in `people.css` for both themes). */
export function chartColors(element: Element): ChartColors {
  const style = getComputedStyle(element);
  const read = (name: string) => style.getPropertyValue(`--stats-${name}`).trim();
  return {
    line: read("line"),
    soft: read("soft"),
    fill: read("fill"),
    grid: read("grid"),
    ink: read("ink"),
    text: read("text"),
    surface: read("surface"),
    edge: read("edge"),
    crosshair: read("crosshair"),
    shadow: read("shadow"),
    before: read("before"),
    similar: read("similar"),
    series: {
      [SeriesSlot.First]: read("series-1"),
      [SeriesSlot.Second]: read("series-2"),
      [SeriesSlot.Third]: read("series-3"),
      [SeriesSlot.Fourth]: read("series-4"),
      [SeriesSlot.Fifth]: read("series-5"),
      [SeriesSlot.Sixth]: read("series-6"),
      [SeriesSlot.Rest]: read("series-rest"),
    },
    marks: {
      [AnnotationKind.Campaign]: read("mark-campaign"),
      [AnnotationKind.Version]: read("mark-version"),
    },
  };
}

/** A round top for a chart whose largest value is `max`: 1, 2, 2.5 or 5 times a power of ten. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 10;
  const power = 10 ** Math.floor(Math.log10(max));
  const share = max / power;
  const step = [1, 2, 2.5, 5].find((candidate) => share <= candidate) ?? 10;
  return step * power;
}

/** Which days get a date under the chart: every day with room for them, else the ends and a few between. */
export function labelledDays(count: number, plotWidth: number): number[] {
  if (count <= 1) return [0];
  const last = count - 1;
  if (count <= 7 && plotWidth / last >= ROOMY_DAY_PX) return Array.from({ length: count }, (_, day) => day);
  if (count <= 7) return [0, Math.round(last / 2), last];
  return [0, Math.round(last / 3), Math.round((2 * last) / 3), last];
}

/** The day under a pointer `x` pixels from the plot's left edge, `width` wide. */
export function dayAt(x: number, width: number, count: number): number {
  const day = Math.round(
    ((x - AREA_MARGIN.left) / Math.max(1, width - AREA_MARGIN.left - AREA_MARGIN.right)) * (count - 1),
  );
  return Math.max(0, Math.min(count - 1, day));
}

/** The canvas sized to its box at the screen's density, cleared, and its CSS size. */
function prepared(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; width: number; height: number } | null {
  const ctx = canvas.getContext("2d");
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!ctx || width === 0 || height === 0) return null;
  const density = Math.min(2, globalThis.devicePixelRatio || 1);
  const pixels = [Math.round(width * density), Math.round(height * density)] as const;
  if (canvas.width !== pixels[0]) canvas.width = pixels[0];
  if (canvas.height !== pixels[1]) canvas.height = pixels[1];
  ctx.setTransform(density, 0, 0, density, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

/** A path through points. */
function trace(ctx: CanvasRenderingContext2D, points: readonly (readonly [number, number])[]): void {
  ctx.beginPath();
  for (const [index, [x, y]] of points.entries()) {
    if (index) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
}

/** What the area chart draws. */
export interface AreaInput {
  data: readonly number[];
  /** Each day's date as the axis and tooltip show it. */
  labels: readonly string[];
  /** The hovered day, or null. */
  hovered: number | null;
  /** The tooltip's value line for a count, e.g. "1,240 plays". */
  valueLine: (count: number) => string;
  /** Values on the axis, e.g. "1.2k". */
  axisValue: (count: number) => string;
}

/** The axis: three gridlines with their values, and the dates under the plot. */
function drawAxes(
  ctx: CanvasRenderingContext2D,
  colors: ChartColors,
  frame: { width: number; height: number; max: number; x: (day: number) => number; y: (v: number) => number },
  input: AreaInput,
): void {
  ctx.font = `11px ${MONO}`;
  ctx.fillStyle = colors.ink;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (const share of [0, 0.5, 1]) {
    const y = Math.round(frame.y(frame.max * share)) + 0.5;
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    trace(ctx, [
      [AREA_MARGIN.left, y],
      [frame.width - AREA_MARGIN.right, y],
    ]);
    ctx.stroke();
    ctx.fillText(input.axisValue(frame.max * share), AREA_MARGIN.left - 10, y);
  }
  ctx.textBaseline = "alphabetic";
  const plotWidth = frame.width - AREA_MARGIN.left - AREA_MARGIN.right;
  const days = labelledDays(input.data.length, plotWidth);
  for (const [index, day] of days.entries()) {
    ctx.textAlign = "center";
    if (index === 0) ctx.textAlign = "left";
    if (index === days.length - 1 && index > 0) ctx.textAlign = "right";
    ctx.fillText(input.labels[day] ?? "", frame.x(day), frame.height - 6);
  }
}

/** The hovered day's tooltip: its date and its value, in a white card beside the point. */
function drawTooltip(
  ctx: CanvasRenderingContext2D,
  colors: ChartColors,
  at: { x: number; y: number; width: number; height: number },
  lines: readonly [string, string],
): void {
  ctx.font = `12px ${MONO}`;
  const boxWidth = Math.max(ctx.measureText(lines[0]).width, ctx.measureText(lines[1]).width) + 20;
  const boxHeight = 46;
  const left = at.x + 12 + boxWidth > at.width - AREA_MARGIN.right ? at.x - 12 - boxWidth : at.x + 12;
  const top = Math.max(AREA_MARGIN.top, Math.min(at.y - boxHeight / 2, at.height - AREA_MARGIN.bottom - boxHeight));
  ctx.shadowColor = colors.shadow;
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = colors.surface;
  ctx.beginPath();
  ctx.roundRect(left, top, boxWidth, boxHeight, 8);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.strokeStyle = colors.edge;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.textAlign = "left";
  ctx.fillStyle = colors.ink;
  ctx.fillText(lines[0], left + 10, top + 18);
  ctx.fillStyle = colors.text;
  ctx.fillText(lines[1], left + 10, top + 36);
}

/** The plays-per-day chart: a 2px line over a soft fill, the hovered (else latest) day marked. */
export function drawArea(canvas: HTMLCanvasElement, input: AreaInput): void {
  const ready = prepared(canvas);
  const count = input.data.length;
  if (!ready || count === 0) return;
  const { ctx, width, height } = ready;
  const colors = chartColors(canvas);
  const max = niceMax(Math.max(...input.data) * 1.08);
  const span = Math.max(1, count - 1);
  const x = (day: number) => AREA_MARGIN.left + ((width - AREA_MARGIN.left - AREA_MARGIN.right) * day) / span;
  const y = (value: number) => AREA_MARGIN.top + (height - AREA_MARGIN.top - AREA_MARGIN.bottom) * (1 - value / max);
  drawAxes(ctx, colors, { width, height, max, x, y }, input);
  const points = input.data.map((value, day) => [x(day), y(value)] as const);
  const fill = ctx.createLinearGradient(0, AREA_MARGIN.top, 0, height - AREA_MARGIN.bottom);
  fill.addColorStop(0, colors.fill);
  fill.addColorStop(1, "transparent");
  trace(ctx, [...points, [x(count - 1), y(0)], [x(0), y(0)]]);
  ctx.fillStyle = fill;
  ctx.fill();
  trace(ctx, points);
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
  const marked = input.hovered ?? count - 1;
  const [px, py] = points[marked] ?? [0, 0];
  if (input.hovered !== null) {
    ctx.strokeStyle = colors.crosshair;
    ctx.lineWidth = 1;
    trace(ctx, [
      [Math.round(px) + 0.5, AREA_MARGIN.top],
      [Math.round(px) + 0.5, height - AREA_MARGIN.bottom],
    ]);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(px, py, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = colors.line;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = colors.surface;
  ctx.stroke();
  if (input.hovered === null) return;
  const lines = [input.labels[marked] ?? "", input.valueLine(input.data[marked] ?? 0)] as const;
  drawTooltip(ctx, colors, { x: px, y: py, width, height }, lines);
}

/** A sparkline: the earlier days soft, the latest week in the accent, a dot on the latest day; a missing day is a gap. */
export function drawSpark(canvas: HTMLCanvasElement, data: readonly (number | null)[]): void {
  const ready = prepared(canvas);
  const known = data.filter((value): value is number => value !== null);
  if (!ready || known.length === 0) return;
  const { ctx, width, height } = ready;
  const colors = chartColors(canvas);
  const low = Math.min(...known);
  const high = Math.max(...known);
  const span = Math.max(1, data.length - 1);
  const x = (day: number) => 2 + ((width - 6) * day) / span;
  const y = (value: number) => 3 + (height - 6) * (1 - (value - low) / (high - low || 1));
  const points = data.map((value, day) => [x(day), y(value ?? low)] as const);
  const cut = Math.max(0, data.length - SPARK_RECENT_DAYS);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const [start, end] of lineRuns(data)) {
    if (start < cut) {
      trace(ctx, points.slice(start, Math.min(end, cut) + 1));
      ctx.strokeStyle = colors.soft;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (end >= cut) {
      trace(ctx, points.slice(Math.max(start, cut), end + 1));
      ctx.strokeStyle = colors.line;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
  const [lastX, lastY] = points[data.findLastIndex((value) => value !== null)] ?? [0, 0];
  ctx.beginPath();
  ctx.arc(lastX, lastY, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = colors.line;
  ctx.fill();
}

// ---------------------------------------------------------------------------------------------
// A game's analytics: the pure geometry of its line and bar charts, then their drawing.
// ---------------------------------------------------------------------------------------------

/** The plot inside a chart's margins, in CSS pixels. */
export interface PlotBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The plot of a `width` × `height` canvas inside `margin`; never smaller than a pixel. */
export function plotBox(
  width: number,
  height: number,
  margin: { left: number; right: number; top: number; bottom: number } = AREA_MARGIN,
): PlotBox {
  return {
    left: margin.left,
    top: margin.top,
    width: Math.max(1, width - margin.left - margin.right),
    height: Math.max(1, height - margin.top - margin.bottom),
  };
}

/** A value axis: its top and the values that get a gridline, lowest first. */
export interface AxisScale {
  top: number;
  ticks: number[];
  /** How far the axis runs under zero, for a chart with bars that hang from the baseline. */
  bottom?: number;
}

/** A number without the dust floating-point sums leave behind. */
const tidy = (value: number): number => Number(value.toPrecision(12));

/** The gridline values of `count` steps of `step`, from zero. */
const tickList = (step: number, count: number): number[] =>
  Array.from({ length: count + 1 }, (_, index) => tidy(step * index));

/** The smallest round step that is at least `raw`; a whole number when the values are counts. */
function niceStep(raw: number, whole: boolean): number {
  const power = 10 ** Math.floor(Math.log10(raw));
  const fits = NICE_STEPS.map((nice) => tidy(nice * power)).filter((step) => step >= tidy(raw));
  const step = fits.find((candidate) => !whole || Number.isInteger(candidate)) ?? 1;
  return whole ? Math.max(1, step) : step;
}

/**
 * The value axis for a chart whose largest value is `max`: about `steps` even steps of a round
 * size, the top the first gridline at or over `max`. `whole` keeps the steps whole, for counts.
 * With nothing to show the axis runs to 1 (or to `steps` for counts).
 */
export function axisScale(max: number, steps = AXIS_STEPS, whole = false): AxisScale {
  if (!(max > 0) || !Number.isFinite(max)) {
    const top = whole ? steps : 1;
    return { top, ticks: tickList(top / steps, steps) };
  }
  const step = niceStep(max / steps, whole);
  const count = Math.max(1, Math.ceil(tidy(max / step)));
  return { top: tidy(step * count), ticks: tickList(step, count) };
}

/**
 * The axis of a chart that stacks up to `maxUp` over its baseline and hangs down to `maxDown` under
 * it: both sides share one step, so a bar over the line and one under it compare by eye.
 */
export function divergingScale(
  maxUp: number,
  maxDown: number,
  steps = AXIS_STEPS,
  whole = false,
): AxisScale & { bottom: number } {
  const over = axisScale(Math.max(maxUp, maxDown), steps, whole);
  if (!(maxDown > 0)) return { ...axisScale(maxUp, steps, whole), bottom: 0 };
  const step = over.ticks[1] ?? over.top;
  const up = Math.max(1, Math.ceil(tidy(maxUp / step)));
  const down = Math.ceil(tidy(maxDown / step));
  return {
    top: tidy(step * up),
    bottom: tidy(step * down),
    ticks: Array.from({ length: up + down + 1 }, (_, index) => tidy(step * (index - down))),
  };
}

/** Whether every value is a whole number: counts, whose axis should not step by halves. */
export function allWhole(values: readonly number[]): boolean {
  return values.every((value) => Number.isInteger(value));
}

/** The x of point `index` of `count`, the first at the plot's left edge and the last at its right. */
export function pointX(index: number, count: number, box: PlotBox): number {
  return box.left + (box.width * index) / Math.max(1, count - 1);
}

/**
 * The y of `value` on an axis that runs to `top` at the plot's head from zero at its foot, or from
 * `bottom` under zero when bars hang from the baseline.
 */
export function valueY(value: number, top: number, box: PlotBox, bottom = 0): number {
  return box.top + (box.height * (top - value)) / (top + bottom);
}

/** The stretches of `values` with no gap, as first and last index: a line is drawn through each alone. */
export function lineRuns(values: readonly (number | null)[]): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (const [index, value] of values.entries()) {
    if (value !== null && start < 0) start = index;
    if (value === null && start >= 0) {
      runs.push([start, index - 1]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, values.length - 1]);
  return runs;
}

/** Each value's point on the plot, null where the value is missing. */
export function linePoints(
  values: readonly (number | null)[],
  top: number,
  box: PlotBox,
): (readonly [number, number] | null)[] {
  return values.map((value, index) =>
    value === null ? null : ([pointX(index, values.length, box), valueY(value, top, box)] as const),
  );
}

/** The point nearest a pointer `x` pixels from the canvas's left edge, held to the series. */
export function indexAt(x: number, box: PlotBox, count: number): number {
  if (count <= 1) return 0;
  const index = Math.round(((x - box.left) / box.width) * (count - 1));
  return Math.max(0, Math.min(count - 1, index));
}

/** Where each of `count` bars stands: one per equal band of the plot, centred in it. */
export function barBands(count: number, box: PlotBox): { x: number; width: number }[] {
  const band = box.width / Math.max(1, count);
  const width = Math.min(BAR_MAX_PX, band * (1 - BAR_GAP_SHARE));
  return Array.from({ length: count }, (_, index) => ({ x: box.left + band * index + (band - width) / 2, width }));
}

/** The bar whose band a pointer `x` pixels from the canvas's left edge is over, held to the series. */
export function bandAt(x: number, box: PlotBox, count: number): number {
  const index = Math.floor(((x - box.left) / box.width) * count);
  return Math.max(0, Math.min(count - 1, index));
}

/** Each day's total over every series; a series that is short counts nothing for the days it lacks. */
export function stackTotals(series: readonly (readonly number[])[]): number[] {
  const length = Math.max(0, ...series.map((values) => values.length));
  return Array.from({ length }, (_, index) => series.reduce((sum, values) => sum + (values[index] ?? 0), 0));
}

/** One day's bar: where it stands, its total, and its parts from the foot up. */
export interface StackedBar {
  x: number;
  width: number;
  total: number;
  /** `series` is the part's index in the input; a part of nothing is left out. */
  segments: { series: number; y: number; height: number }[];
}

/**
 * Every day's bar on an axis that runs to `top` (and `bottom` under the baseline), the first series
 * at the foot.
 */
export function stackedBars(
  series: readonly (readonly number[])[],
  top: number,
  box: PlotBox,
  bottom = 0,
): StackedBar[] {
  const totals = stackTotals(series);
  return barBands(totals.length, box).map(({ x, width }, index) => {
    let foot = valueY(0, top, box, bottom);
    const segments: StackedBar["segments"] = [];
    for (const [part, values] of series.entries()) {
      const value = values[index] ?? 0;
      if (!(value > 0)) continue;
      const height = (box.height * value) / (top + bottom);
      foot -= height;
      segments.push({ series: part, y: foot, height });
    }
    return { x, width, total: totals[index] ?? 0, segments };
  });
}

/** Each day's bar that hangs from the baseline, on the scale of the bars stacked over it. */
export function hangingBars(
  values: readonly number[],
  top: number,
  bottom: number,
  box: PlotBox,
): { x: number; width: number; y: number; height: number }[] {
  const y = valueY(0, top, box, bottom);
  return barBands(values.length, box).map(({ x, width }, index) => ({
    x,
    width,
    y,
    height: (box.height * Math.max(0, values[index] ?? 0)) / (top + bottom),
  }));
}

/** The x of each mark, by `at`; null for a mark that is not on one of the chart's `count` places. */
export function markXs(indexes: readonly number[], count: number, at: (index: number) => number): (number | null)[] {
  return indexes.map((index) => {
    const onChart = Number.isInteger(index) && index >= 0 && index < count;
    return onChart ? at(index) : null;
  });
}

/**
 * Where each mark's label goes: to the right of its line, or to the left when it would leave the
 * plot, in the first of two rows where it clears the label before it. Null for one that fits in
 * neither: its line stays, and the readout and the table still name it. Marks come in order.
 */
export function markLanes(
  labels: readonly { x: number; width: number }[],
  box: PlotBox,
): ({ left: number; lane: number } | null)[] {
  const ends = Array.from({ length: MARK_LANES }, () => Number.NEGATIVE_INFINITY);
  return labels.map(({ x, width }) => {
    const leaves = x + MARK_GAP_PX + width > box.left + box.width;
    const left = leaves ? x - MARK_GAP_PX - width : x + MARK_GAP_PX;
    const lane = ends.findIndex((end) => left >= end + MARK_GAP_PX);
    if (lane < 0) return null;
    ends[lane] = left + width;
    return { left, lane };
  });
}

/** A mark on a chart: the place it stands on, what it is about, and its label in full. */
export interface ChartMark {
  index: number;
  kind: AnnotationKind;
  label: string;
}

/** One line of a line chart; a null value is a gap. */
export interface LineSeries {
  id: string;
  /** Its name in the legend, the readout and the table. */
  label: string;
  tone: LineTone;
  values: readonly (number | null)[];
}

/** What the line chart draws. */
export interface LineInput {
  series: readonly LineSeries[];
  /** Each place's name as the axis and the readout show it: a date, or "Day 7". */
  labels: readonly string[];
  /** The place under the pointer, or null. */
  hovered: number | null;
  /** A value as the readout and the callouts write it, and the axis unless `axisFormat` is given; null is missing. */
  format: (value: number | null) => string;
  /** A step of the value axis, when the axis rounds more than the readout: whole percents for a rate. */
  axisFormat?: (value: number) => string;
  marks?: readonly ChartMark[];
  /** The places that get a label under the plot; a few dates when left out. */
  ticks?: readonly number[];
  /** Places whose value on the main line is written on the plot. */
  callouts?: readonly number[];
  /** The axis's top when it is fixed; else a round one over the largest value. */
  top?: number;
  /** Whether the axis keeps whole steps, as counts need; told from the values when left out. */
  whole?: boolean;
  /** A soft fill under the main line. */
  fill?: boolean;
}

/** One series of a bar chart, a number per day. */
export interface BarSeries {
  id: string;
  label: string;
  slot: SeriesSlot;
  values: readonly number[];
}

/** What the bar chart draws. */
export interface BarInput {
  /** One series draws plain bars; more are stacked, the first at the foot. */
  series: readonly BarSeries[];
  labels: readonly string[];
  hovered: number | null;
  format: (value: number) => string;
  marks?: readonly ChartMark[];
  ticks?: readonly number[];
  /** Whether the axis keeps whole steps, as counts need; told from the values when left out. */
  whole?: boolean;
  /** The readout's last row over stacked series, e.g. "Total". */
  totalLabel?: string;
  /**
   * A number per day that hangs under the baseline as an outlined bar, on the stack's scale: what
   * left, beside what is there. It is no part of the day's total.
   */
  below?: { label: string; values: readonly number[] };
}

/** What both charts share once their canvas is ready. */
interface Frame {
  ctx: CanvasRenderingContext2D;
  colors: ChartColors;
  box: PlotBox;
  width: number;
  height: number;
}

/** A row of the readout: a swatch, a name and, for a series, its value. */
interface ReadoutRow {
  swatch: ((ctx: CanvasRenderingContext2D, x: number, y: number) => void) | null;
  label: string;
  value: string;
}

/** The marks that stand on the chart, each with its x. */
function placedMarks(
  marks: readonly ChartMark[],
  count: number,
  at: (index: number) => number,
): { mark: ChartMark; x: number }[] {
  const xs = markXs(
    marks.map((mark) => mark.index),
    count,
    at,
  );
  return marks.flatMap((mark, index) => {
    const x = xs[index];
    return x === null || x === undefined ? [] : [{ mark, x }];
  });
}

/** The canvas ready to draw on, with a plot that leaves a row over it for each row of marks' labels. */
function framed(canvas: HTMLCanvasElement, hasMarks: boolean): Frame | null {
  const ready = prepared(canvas);
  if (!ready) return null;
  const top = AREA_MARGIN.top + (hasMarks ? MARK_LANES * MARK_LANE_PX : 0);
  const box = plotBox(ready.width, ready.height, { ...AREA_MARGIN, top });
  return { ...ready, colors: chartColors(canvas), box };
}

/** The value axis: a gridline and its value at each step. */
function drawGrid(frame: Frame, scale: AxisScale, format: (value: number) => string): void {
  const { ctx, colors, box } = frame;
  ctx.font = `11px ${MONO}`;
  ctx.fillStyle = colors.ink;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  for (const tick of scale.ticks) {
    const y = Math.round(valueY(tick, scale.top, box, scale.bottom)) + 0.5;
    // The baseline of a chart with bars under it is drawn stronger than the gridlines.
    ctx.strokeStyle = tick === 0 && scale.bottom ? colors.crosshair : colors.grid;
    trace(ctx, [
      [box.left, y],
      [box.left + box.width, y],
    ]);
    ctx.stroke();
    ctx.fillText(format(tick), box.left - 10, y);
  }
  ctx.textBaseline = "alphabetic";
}

/** The names under the plot, each centred on its place and kept inside the plot. */
function drawTicks(
  frame: Frame,
  labels: readonly string[],
  ticks: readonly number[],
  at: (index: number) => number,
): void {
  const { ctx, colors, box, height } = frame;
  ctx.font = `11px ${MONO}`;
  ctx.fillStyle = colors.ink;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  for (const index of ticks) {
    const text = labels[index];
    if (text === undefined) continue;
    const wide = ctx.measureText(text).width;
    const left = Math.max(box.left, Math.min(at(index) - wide / 2, box.left + box.width - wide));
    ctx.fillText(text, left, height - 6);
  }
}

/** Each mark: a dashed line down the plot and, where it fits, a dot and its label over it. */
function drawMarks(frame: Frame, placed: readonly { mark: ChartMark; x: number }[]): void {
  const { ctx, colors, box } = frame;
  ctx.font = `11px ${MONO}`;
  const lanes = markLanes(
    placed.map(({ mark, x }) => ({ x, width: ctx.measureText(mark.label).width + 10 })),
    box,
  );
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  for (const [index, { mark, x }] of placed.entries()) {
    const color = colors.marks[mark.kind];
    const line = Math.round(x) + 0.5;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    trace(ctx, [
      [line, box.top - 4],
      [line, box.top + box.height],
    ]);
    ctx.stroke();
    ctx.setLineDash([]);
    const lane = lanes[index];
    if (!lane) continue;
    const middle = box.top - 6 - MARK_LANE_PX * lane.lane - MARK_LANE_PX / 2;
    ctx.beginPath();
    // A campaign's dot is filled and a version's is a ring, so the two read apart without their colours.
    ctx.arc(lane.left + 3, middle, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    if (mark.kind === AnnotationKind.Campaign) ctx.fill();
    else ctx.stroke();
    ctx.fillStyle = colors.ink;
    ctx.fillText(mark.label, lane.left + 10, middle);
  }
  ctx.textBaseline = "alphabetic";
}

/** The hovered place's readout: its name, then a row per series and per mark, in a card beside it. */
function drawReadout(frame: Frame, at: { x: number; y: number }, title: string, rows: readonly ReadoutRow[]): void {
  const { ctx, colors, box } = frame;
  ctx.font = `12px ${MONO}`;
  const gap = 14;
  const rowWidth = (row: ReadoutRow): number =>
    (row.swatch ? READOUT_SWATCH_PX : 0) +
    ctx.measureText(row.label).width +
    (row.value ? gap + ctx.measureText(row.value).width : 0);
  const inner = Math.max(ctx.measureText(title).width, ...rows.map(rowWidth));
  const boxWidth = inner + READOUT_PAD_PX * 2;
  const boxHeight = READOUT_ROW_PX * (rows.length + 1) + READOUT_PAD_PX;
  const right = box.left + box.width;
  const left = at.x + 12 + boxWidth > right ? Math.max(0, at.x - 12 - boxWidth) : at.x + 12;
  const top = Math.max(box.top, Math.min(at.y - boxHeight / 2, box.top + box.height - boxHeight));
  ctx.shadowColor = colors.shadow;
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = colors.surface;
  ctx.beginPath();
  ctx.roundRect(left, top, boxWidth, boxHeight, 8);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.strokeStyle = colors.edge;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.stroke();
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = colors.ink;
  ctx.fillText(title, left + READOUT_PAD_PX, top + READOUT_ROW_PX);
  for (const [index, row] of rows.entries()) {
    const baseline = top + READOUT_ROW_PX * (index + 2);
    const start = left + READOUT_PAD_PX;
    row.swatch?.(ctx, start, baseline - 4);
    ctx.textAlign = "left";
    ctx.fillStyle = row.value ? colors.ink : colors.text;
    ctx.fillText(row.label, start + (row.swatch ? READOUT_SWATCH_PX : 0), baseline);
    ctx.textAlign = "right";
    ctx.fillStyle = colors.text;
    ctx.fillText(row.value, left + boxWidth - READOUT_PAD_PX, baseline);
  }
  ctx.textAlign = "left";
}

/** The colour a line of `tone` is drawn in. */
const toneColor = (colors: ChartColors, tone: LineTone): string => {
  if (tone === LineTone.Before) return colors.before;
  return tone === LineTone.Similar ? colors.similar : colors.line;
};

/** Set the context to stroke a line of `tone`. */
function strokeAs(ctx: CanvasRenderingContext2D, colors: ChartColors, tone: LineTone): void {
  ctx.strokeStyle = toneColor(colors, tone);
  ctx.lineWidth = LINE_WIDTHS[tone];
  ctx.setLineDash(DASHES[tone]);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
}

/** A dot of the line's colour ringed in the surface, so it reads over the line. */
function drawDot(frame: Frame, x: number, y: number, radius: number, color: string): void {
  const { ctx, colors } = frame;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.strokeStyle = colors.surface;
  ctx.stroke();
}

/** One series: a line through each stretch that has no gap, a dot for a value that stands alone. */
function drawSeries(frame: Frame, series: LineSeries, top: number, fill: boolean): void {
  const { ctx, colors, box } = frame;
  const points = linePoints(series.values, top, box);
  const foot = box.top + box.height;
  for (const [start, end] of lineRuns(series.values)) {
    const run = points.slice(start, end + 1).filter((point) => point !== null);
    const first = run[0];
    const last = run.at(-1);
    if (!first || !last) continue;
    if (fill && run.length > 1) {
      const wash = ctx.createLinearGradient(0, box.top, 0, foot);
      wash.addColorStop(0, colors.fill);
      wash.addColorStop(1, "transparent");
      trace(ctx, [...run, [last[0], foot], [first[0], foot]]);
      ctx.fillStyle = wash;
      ctx.fill();
    }
    if (run.length === 1) {
      drawDot(frame, first[0], first[1], 3, toneColor(colors, series.tone));
      continue;
    }
    strokeAs(ctx, colors, series.tone);
    trace(ctx, run);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** The main line's value written over the places asked for. */
function drawCallouts(frame: Frame, main: LineSeries, top: number, input: LineInput): void {
  const { ctx, colors, box } = frame;
  ctx.font = `11px ${MONO}`;
  ctx.textBaseline = "alphabetic";
  for (const index of input.callouts ?? []) {
    const value = main.values[index];
    if (value === null || value === undefined) continue;
    const x = pointX(index, input.labels.length, box);
    const y = valueY(value, top, box);
    drawDot(frame, x, y, 3.5, colors.line);
    const text = input.format(value);
    const wide = ctx.measureText(text).width;
    ctx.fillStyle = colors.text;
    ctx.textAlign = "left";
    ctx.fillText(text, Math.max(box.left, Math.min(x - wide / 2, box.left + box.width - wide)), y - 9);
  }
}

/** The hovered place of a line chart: a crosshair, a dot on each line and the readout. */
function drawLineHover(frame: Frame, input: LineInput, top: number, marks: readonly ChartMark[]): void {
  const { ctx, colors, box } = frame;
  const hovered = input.hovered;
  if (hovered === null) return;
  const x = pointX(hovered, input.labels.length, box);
  ctx.strokeStyle = colors.crosshair;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  trace(ctx, [
    [Math.round(x) + 0.5, box.top],
    [Math.round(x) + 0.5, box.top + box.height],
  ]);
  ctx.stroke();
  let anchor = box.top + box.height / 2;
  const rows: ReadoutRow[] = [];
  for (const series of input.series) {
    const value = series.values[hovered] ?? null;
    if (value !== null) {
      const y = valueY(value, top, box);
      drawDot(frame, x, y, 4, toneColor(colors, series.tone));
      if (series.tone === LineTone.Main) anchor = y;
    }
    rows.push({
      swatch: (context, left, middle) => {
        strokeAs(context, colors, series.tone);
        trace(context, [
          [left, middle],
          [left + READOUT_SWATCH_PX - 5, middle],
        ]);
        context.stroke();
        context.setLineDash([]);
      },
      label: series.label,
      value: input.format(value),
    });
  }
  for (const mark of marks) if (mark.index === hovered) rows.push({ swatch: null, label: mark.label, value: "" });
  drawReadout(frame, { x, y: anchor }, input.labels[hovered] ?? "", rows);
}

/** A line chart's value axis in `box`: up to its fixed top when it has one, else round steps over its largest value. */
function lineScale(input: LineInput, box: PlotBox): AxisScale {
  const values = input.series.flatMap((series) => series.values).filter((value) => value !== null);
  const steps = box.height < SHORT_PLOT_PX ? AXIS_STEPS / 2 : AXIS_STEPS;
  if (input.top !== undefined) return { top: input.top, ticks: tickList(input.top / steps, steps) };
  return axisScale(Math.max(0, ...values), steps, input.whole ?? allWhole(values));
}

/**
 * A line chart: a value axis, a few names under the plot, each series through the places it has a
 * value for, marks on their days, and under the pointer a crosshair with every series' value.
 */
export function drawLines(canvas: HTMLCanvasElement, input: LineInput): void {
  const count = input.labels.length;
  const marks = input.marks ?? [];
  const frame = framed(canvas, marks.length > 0);
  if (!frame || count === 0) return;
  const { box } = frame;
  const scale = lineScale(input, box);
  const at = (index: number): number => pointX(index, count, box);
  drawGrid(frame, scale, input.axisFormat ?? input.format);
  drawTicks(frame, input.labels, input.ticks ?? labelledDays(count, box.width), at);
  drawMarks(frame, placedMarks(marks, count, at));
  for (const tone of TONE_ORDER) {
    for (const series of input.series) {
      if (series.tone === tone) drawSeries(frame, series, scale.top, tone === LineTone.Main && input.fill === true);
    }
  }
  const main = input.series.find((series) => series.tone === LineTone.Main);
  if (main) drawCallouts(frame, main, scale.top, input);
  drawLineHover(frame, input, scale.top, marks);
}

/** One day's bar: its parts in their series' colours, a hairline apart, the top one rounded. */
function drawBar(frame: Frame, bar: StackedBar, series: readonly BarSeries[], dimmed: boolean): void {
  const { ctx, colors } = frame;
  ctx.globalAlpha = dimmed ? 0.45 : 1;
  for (const [index, segment] of bar.segments.entries()) {
    const slot = series[segment.series]?.slot ?? SeriesSlot.Rest;
    const isTop = index === bar.segments.length - 1;
    const gap = isTop || segment.height <= SEGMENT_GAP_PX * 2 ? 0 : SEGMENT_GAP_PX;
    const radius = isTop ? Math.min(BAR_RADIUS_PX, bar.width / 2, segment.height) : 0;
    ctx.fillStyle = colors.series[slot];
    ctx.beginPath();
    ctx.roundRect(bar.x, segment.y + gap, bar.width, segment.height - gap, [radius, radius, 0, 0]);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** An outlined bar: what is not there, beside the filled bars of what is. */
function strokeOutline(
  ctx: CanvasRenderingContext2D,
  colors: ChartColors,
  x: number,
  y: number,
  width: number,
  height: number,
): void {
  if (height < 1) return;
  const inset = 0.75;
  const radius = Math.min(BAR_RADIUS_PX, width / 2, height / 2);
  ctx.strokeStyle = colors.before;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.roundRect(x + inset, y + inset, width - inset * 2, Math.max(1, height - inset * 2), [0, 0, radius, radius]);
  ctx.stroke();
}

/** The hovered day of a bar chart: each series' value, their total when there are several, and the day's marks. */
function drawBarHover(frame: Frame, input: BarInput, bar: StackedBar, marks: readonly ChartMark[]): void {
  const { colors, box } = frame;
  const hovered = input.hovered;
  if (hovered === null) return;
  const rows: ReadoutRow[] = input.series.map((series) => ({
    swatch: (context, left, middle) => {
      context.fillStyle = colors.series[series.slot];
      context.beginPath();
      context.roundRect(left, middle - 4, 8, 8, 2);
      context.fill();
    },
    label: series.label,
    value: input.format(series.values[hovered] ?? 0),
  }));
  if (input.series.length > 1 && input.totalLabel) {
    rows.push({ swatch: null, label: input.totalLabel, value: input.format(bar.total) });
  }
  if (input.below) {
    rows.push({
      swatch: (context, left, middle) => strokeOutline(context, colors, left, middle - 4, 8, 8),
      label: input.below.label,
      value: input.format(-(input.below.values[hovered] ?? 0)),
    });
  }
  for (const mark of marks) if (mark.index === hovered) rows.push({ swatch: null, label: mark.label, value: "" });
  const top = bar.segments.at(-1)?.y ?? box.top + box.height;
  drawReadout(frame, { x: bar.x + bar.width, y: top }, input.labels[hovered] ?? "", rows);
}

/**
 * A bar chart: a bar per day on a value axis, one series plain or several stacked, marks on their
 * days, and under the pointer the day's bar picked out with its values.
 */
export function drawBars(canvas: HTMLCanvasElement, input: BarInput): void {
  const count = input.labels.length;
  const marks = input.marks ?? [];
  const frame = framed(canvas, marks.length > 0);
  if (!frame || count === 0) return;
  const { box } = frame;
  const series = input.series.map((entry) => entry.values.slice(0, count));
  const under = (input.below?.values ?? []).slice(0, count);
  const steps = box.height < SHORT_PLOT_PX ? AXIS_STEPS / 2 : AXIS_STEPS;
  const whole = input.whole ?? allWhole([...series.flat(), ...under]);
  const scale = divergingScale(Math.max(0, ...stackTotals(series)), Math.max(0, ...under), steps, whole);
  const bars = stackedBars(series, scale.top, box, scale.bottom);
  const bands = barBands(count, box);
  const at = (index: number): number => (bands[index]?.x ?? box.left) + (bands[index]?.width ?? 0) / 2;
  drawGrid(frame, scale, input.format);
  drawTicks(frame, input.labels, input.ticks ?? labelledDays(count, box.width), at);
  drawMarks(frame, placedMarks(marks, count, at));
  for (const [index, bar] of bars.entries()) {
    drawBar(frame, bar, input.series, input.hovered !== null && input.hovered !== index);
  }
  for (const bar of hangingBars(under, scale.top, scale.bottom, box)) {
    strokeOutline(frame.ctx, frame.colors, bar.x, bar.y, bar.width, bar.height);
  }
  const hovered = input.hovered === null ? undefined : bars[input.hovered];
  if (hovered) drawBarHover(frame, input, hovered, marks);
}
