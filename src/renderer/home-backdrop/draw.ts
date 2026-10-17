/**
 * Drawing home's background: the picture is shrunk to one sample per mark (a dot, a line segment, a
 * character), prepared into ink (`field.ts`), and every mark goes into one path, filled once. It
 * runs only when the frame or a setting changes, never per animation frame.
 */
import {
  coverageAt,
  coverageField,
  coverCrop,
  grainAt,
  rampCharacter,
  thresholded,
  type CoverageField,
} from "./field.ts";
import { BackdropEffect, type BackdropSettings, DotGrid } from "./settings.ts";

/** Blur is set against a drawing this wide, as in the tools it comes from; the field scales it. */
const BLUR_REFERENCE_WIDTH = 600;
/** Lines: the hairline every column keeps, a full segment's share of its column, and the gap between. */
const LINE_HAIR = 0.6;
const LINE_FILL = 0.92;
const LINE_GAP = 0.18;
/** Dots smaller than this radius are not drawn. */
const DOT_MIN_RADIUS = 0.2;
/** ASCII: a row's height for a character's size. */
const ASCII_LINE_HEIGHT = 1.2;

/** A picture the canvas can draw. */
export type BackdropSource = CanvasImageSource & { width: number; height: number };

/**
 * Where the drawing goes: the size in points the picture is cut to cover, where the canvas's corner
 * falls in it (a canvas can hold only part of the frame), pixels per point, and the ink.
 */
export interface BackdropFrame {
  width: number;
  height: number;
  origin: { x: number; y: number };
  scale: number;
  ink: string;
  inkIsLight: boolean;
  /** The monospace family ASCII is set in. */
  font: string;
}

/** The picture prepared at `columns`×`rows` samples, cut to cover the frame. */
function sampleField(
  source: BackdropSource,
  settings: BackdropSettings,
  frame: BackdropFrame,
  columns: number,
  rows: number,
): CoverageField {
  const canvas = new OffscreenCanvas(columns, rows);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return { width: columns, height: rows, values: new Float32Array(columns * rows) };
  const crop = coverCrop(source.width, source.height, frame.width, frame.height);
  context.imageSmoothingQuality = "high";
  if (settings.blur > 0) context.filter = `blur(${(settings.blur * columns) / BLUR_REFERENCE_WIDTH}px)`;
  context.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, columns, rows);
  const field = coverageField(
    context.getImageData(0, 0, columns, rows).data,
    columns,
    rows,
    settings,
    frame.inkIsLight,
  );
  if (settings.threshold > 0)
    for (let index = 0; index < field.values.length; index++)
      field.values[index] = thresholded(field.values[index] ?? 0, settings.threshold);
  return field;
}

/** Vertical lines that thicken where the picture is dark: a hairline per column, a segment per row. */
function drawLines(context: CanvasRenderingContext2D, field: CoverageField, frame: BackdropFrame): void {
  const columnWidth = frame.width / field.width;
  const rowHeight = frame.height / field.height;
  const hair = Math.min(LINE_HAIR, columnWidth * 0.3);
  const segment = rowHeight * (1 - LINE_GAP);
  for (let column = 0; column < field.width; column++) {
    const x = (column + 0.5) * columnWidth;
    context.rect(x - hair / 2, 0, hair, frame.height);
    for (let row = 0; row < field.height; row++) {
      const width = (field.values[row * field.width + column] ?? 0) * columnWidth * LINE_FILL;
      if (width > hair) context.rect(x - width / 2, row * rowHeight + (rowHeight - segment) / 2, width, segment);
    }
  }
}

/** A dot's place on the turned grid: `u` along a row, `v` down the rows. */
type GridPoint = { u: number; v: number };

/** The turned grid as the frame sees it: the angle's cosine and sine about the frame's center. */
type GridTurn = { cos: number; sin: number; cx: number; cy: number };

/**
 * One dot, drawn in the turned grid's own space so a rounded square turns with it; its size is
 * between the smallest and largest by the ink under it in the frame.
 */
function addDot(
  context: CanvasRenderingContext2D,
  field: CoverageField,
  settings: BackdropSettings,
  frame: BackdropFrame,
  { point, turn }: { point: GridPoint; turn: GridTurn },
): void {
  const { u, v } = point;
  const x = turn.cx + u * turn.cos - v * turn.sin;
  const y = turn.cy + u * turn.sin + v * turn.cos;
  const margin = settings.dotMax;
  const outside = x < -margin || y < -margin || x > frame.width + margin;
  if (outside || y > frame.height + margin) return;
  const ink = coverageAt(field, (x / frame.width) * field.width, (y / frame.height) * field.height);
  const size = settings.dotMin + ink * (settings.dotMax - settings.dotMin);
  const half = size / 2;
  if (half < DOT_MIN_RADIUS) return;
  if (settings.dotCorner >= half) {
    context.moveTo(u + half, v);
    context.arc(u, v, half, 0, Math.PI * 2);
    return;
  }
  context.roundRect(u - half, v - half, size, size, settings.dotCorner);
}

/**
 * A halftone: a grid of dots, turned by its angle, every other row shifted for Ben-Day, each dot
 * strayed from its place by the noise (the same stray every time it is drawn).
 */
function drawDots(
  context: CanvasRenderingContext2D,
  source: BackdropSource,
  settings: BackdropSettings,
  frame: BackdropFrame,
): void {
  const step = settings.dotStep;
  const field = sampleField(source, settings, frame, Math.ceil(frame.width / step), Math.ceil(frame.height / step));
  const angle = (settings.dotAngle * Math.PI) / 180;
  const turn = { cos: Math.cos(angle), sin: Math.sin(angle), cx: frame.width / 2, cy: frame.height / 2 };
  const stray = step * settings.dotNoise;
  // The turned grid covers the frame's diagonal, so no corner is left bare.
  const reach = Math.ceil(Math.hypot(frame.width, frame.height) / 2 / step) + 1;
  context.save();
  context.translate(turn.cx, turn.cy);
  context.rotate(angle);
  let index = 0;
  for (let row = -reach; row <= reach; row++) {
    const shift = settings.dotGrid === DotGrid.Benday && row % 2 !== 0 ? step / 2 : 0;
    for (let column = -reach; column <= reach; column++) {
      index++;
      const u = column * step + shift + (stray ? (grainAt(index * 2) - 0.5) * stray : 0);
      const v = row * step + (stray ? (grainAt(index * 2 + 1) - 0.5) * stray : 0);
      addDot(context, field, settings, frame, { point: { u, v }, turn });
    }
  }
  context.restore();
}

/** Characters from the ramp, one per cell, set row by row in the monospace face. */
function drawAscii(
  context: CanvasRenderingContext2D,
  source: BackdropSource,
  settings: BackdropSettings,
  frame: BackdropFrame,
): void {
  const ramp = Array.from(settings.asciiCharacters);
  const columns = settings.asciiColumns;
  context.font = `100px ${frame.font}`;
  const advance = context.measureText("M").width / 100 || 0.6;
  const size = frame.width / columns / advance;
  const rowHeight = size * ASCII_LINE_HEIGHT;
  const rows = Math.ceil(frame.height / rowHeight);
  const field = sampleField(source, settings, frame, columns, rows);
  context.font = `${size}px ${frame.font}`;
  context.textBaseline = "top";
  // Small sizes round each advance, so a row is stretched to the frame's exact width.
  const set = context.measureText("M".repeat(columns)).width;
  if (set > 0) context.scale(frame.width / set, 1);
  for (let row = 0; row < rows; row++) {
    let line = "";
    for (let column = 0; column < columns; column++)
      line += rampCharacter(ramp, field.values[row * columns + column] ?? 0);
    context.fillText(line, 0, row * rowHeight + (rowHeight - size) / 2);
  }
}

/** The picture as it is, cut to cover the frame. */
function drawPicture(context: CanvasRenderingContext2D, source: BackdropSource, frame: BackdropFrame): void {
  const crop = coverCrop(source.width, source.height, frame.width, frame.height);
  context.imageSmoothingQuality = "high";
  context.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, frame.width, frame.height);
}

/** Draw `source` through the settings' effect over the whole frame, or as it is with no effect. */
export function drawBackdrop(
  context: CanvasRenderingContext2D,
  source: BackdropSource,
  settings: BackdropSettings,
  frame: BackdropFrame,
): void {
  const { scale, origin } = frame;
  context.setTransform(scale, 0, 0, scale, -origin.x * scale, -origin.y * scale);
  context.clearRect(0, 0, frame.width, frame.height);
  if (settings.effect === BackdropEffect.None) {
    drawPicture(context, source, frame);
    return;
  }
  context.fillStyle = frame.ink;
  if (settings.effect === BackdropEffect.Ascii) {
    drawAscii(context, source, settings, frame);
    return;
  }
  context.beginPath();
  if (settings.effect === BackdropEffect.Dots) drawDots(context, source, settings, frame);
  else drawLines(context, sampleField(source, settings, frame, settings.lineColumns, settings.lineRows), frame);
  context.fill();
}
