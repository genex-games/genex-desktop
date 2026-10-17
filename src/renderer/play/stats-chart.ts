/**
 * The stats page's charts, drawn on canvas in one accent hue with thin marks: the plays-per-day
 * line over a soft fill with three gridlines, a few dates and, on hover, a crosshair and a tooltip;
 * and the sparklines beside the tiles and in the per-game table, the latest week in the accent and
 * the days before it soft. Colours come from the page's CSS, so both themes draw right.
 */

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
}

/** The area chart's margins, in CSS pixels: room for the values on the left and the dates below. */
export const AREA_MARGIN = { left: 46, right: 10, top: 12, bottom: 26 } as const;
/** Every day is labelled when each has at least this many pixels; else a few. */
const ROOMY_DAY_PX = 56;
/** The sparkline's latest stretch, in days, drawn in the accent. */
const SPARK_RECENT_DAYS = 8;
const MONO = '"Geist Mono", ui-monospace, monospace';

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
  ctx.shadowColor = "rgba(16,17,18,0.12)";
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

/** A sparkline: the earlier days soft, the latest week in the accent, a dot on today. */
export function drawSpark(canvas: HTMLCanvasElement, data: readonly number[]): void {
  const ready = prepared(canvas);
  if (!ready || data.length === 0) return;
  const { ctx, width, height } = ready;
  const colors = chartColors(canvas);
  const low = Math.min(...data);
  const high = Math.max(...data);
  const span = Math.max(1, data.length - 1);
  const x = (day: number) => 2 + ((width - 6) * day) / span;
  const y = (value: number) => 3 + (height - 6) * (1 - (value - low) / (high - low || 1));
  const points = data.map((value, day) => [x(day), y(value)] as const);
  const cut = Math.max(0, data.length - SPARK_RECENT_DAYS);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (cut > 0) {
    trace(ctx, points.slice(0, cut + 1));
    ctx.strokeStyle = colors.soft;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  trace(ctx, points.slice(cut));
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 2;
  ctx.stroke();
  const [lastX, lastY] = points.at(-1) ?? [0, 0];
  ctx.beginPath();
  ctx.arc(lastX, lastY, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = colors.line;
  ctx.fill();
}
