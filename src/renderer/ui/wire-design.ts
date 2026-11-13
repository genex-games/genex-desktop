/**
 * "No design pages yet": a pencil draws a design page, the game's core loop. The page's frame, a
 * title, three steps joined by arrows in a circle and two notes appear one line after another, the
 * pencil at the line's end and lifted between lines; then the page holds, fades and is drawn again.
 * Lines only, as the other scenes are (wire-art.ts): the frame in accent, the drawing and the
 * pencil in ink, the arrows and notes in muted ink.
 */
import type { Camera, Line, Vec3, WireScene } from "./wire-art.ts";

type Vec2 = [number, number];

/** One line the pencil draws, on the page's own plane. */
interface Stroke {
  pts: Vec2[];
  c: Line["c"];
  k: number;
  /** The page's frame: it shows faintly before it is drawn. */
  ghost?: boolean;
}

/** A stroke on the pencil's track: where the way to it starts, where its line starts and where it ends. */
interface Step {
  stroke: Stroke;
  travelFrom: number;
  drawFrom: number;
  end: number;
  length: number;
}

/** One whole drawing, in seconds: the lines, then the page held, then its fade. */
export const DESIGN_LOOP = 8;
const HOLD = 1.5;
const FADE = 0.7;
const DRAWING = DESIGN_LOOP - HOLD - FADE;
/** A moment with the whole page drawn, for a still frame. */
export const DESIGN_STILL = DRAWING + HOLD / 2;

/** The page in world units: its size, how far it stands off the floor and toward the camera. */
const PAGE_WIDTH = 1.4;
const PAGE_HEIGHT = 0.98;
const PAGE_LIFT = 0.14;
const PAGE_FRONT = 0.3;
const CORNER = 0.045;
/** How strongly the frame shows before the pencil has drawn it. */
const GHOST = 0.16;
/** The way between two lines costs less of the track than a line of the same length, plus a pause. */
const TRAVEL_SHARE = 0.45;
const TRAVEL_PAUSE = 0.05;
const LINE_PAUSE = 0.04;
/** The pencil: how far it lifts between lines, its radius, and where its point ends and its body ends. */
const PEN_LIFT = 0.09;
const PEN_RADIUS = 0.045;
const PEN_POINT = 0.14;
const PEN_END = 0.62;
const PEN_SIDES = 6;
/** How far the page sways, in radians, and how fast. */
const SWAY = 0.26;
const SWAY_SPEED = 0.5;

const clamp = (x: number): number => Math.max(0, Math.min(1, x));
const sum = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scaled = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function unit(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
}

/** The page's plane: it leans back a little, and `PAGE_OUT` points off it toward the camera. */
const PAGE_RIGHT: Vec3 = [1, 0, 0];
const PAGE_UP = unit([0, 1, -0.12]);
const PAGE_OUT = cross(PAGE_RIGHT, PAGE_UP);
const PAGE_CORNER: Vec3 = [-PAGE_WIDTH / 2, PAGE_LIFT, PAGE_FRONT];
/** A point of the page in the world, `lift` off its surface. */
const onPage = (q: Vec2, lift = 0): Vec3 =>
  sum(sum(PAGE_CORNER, sum(scaled(PAGE_RIGHT, q[0]), scaled(PAGE_UP, q[1]))), scaled(PAGE_OUT, lift));

/** A rectangle with rounded corners, as one closed line. */
function roundRect(x: number, y: number, w: number, h: number, r: number): Vec2[] {
  const corners: Array<[number, number, number]> = [
    [x + w - r, y + h - r, 0],
    [x + r, y + h - r, 1],
    [x + r, y + r, 2],
    [x + w - r, y + r, 3],
  ];
  const out: Vec2[] = [];
  for (const [cx, cy, quarter] of corners)
    for (let i = 0; i <= 4; i++) {
      const angle = (quarter + i / 4) * (Math.PI / 2);
      out.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
    }
  return [...out, out[0]];
}

/** A point of the page from its own 0..1 coordinates. */
const at = (u: number, v: number): Vec2 => [u * PAGE_WIDTH, v * PAGE_HEIGHT];
const line = (pts: Vec2[], c: Line["c"], k: number): Stroke => ({ pts, c, k });
const step = (u: number, v: number): Stroke =>
  line(roundRect(u * PAGE_WIDTH, v * PAGE_HEIGHT, 0.24 * PAGE_WIDTH, 0.24 * PAGE_HEIGHT, 0.018), 1, 0.95);
/** A line from `a` to `b` ending in an arrow's head, drawn without lifting the pencil. */
function arrow(a: Vec2, b: Vec2): Stroke {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const ux = (b[0] - a[0]) / length;
  const uy = (b[1] - a[1]) / length;
  const head = 0.05;
  const barb = (side: number): Vec2 => [
    b[0] - ux * head - uy * head * 0.7 * side,
    b[1] - uy * head + ux * head * 0.7 * side,
  ];
  return line([a, b, barb(1), b, barb(-1)], 2, 0.9);
}

/** The page as the pencil draws it: its frame, a title, three steps in a circle, two notes. */
const PAGE_STROKES: Stroke[] = [
  { ...line(roundRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, CORNER), 0, 1), ghost: true },
  line([at(0.08, 0.86), at(0.54, 0.86)], 1, 0.95),
  step(0.06, 0.46),
  arrow(at(0.31, 0.58), at(0.375, 0.58)),
  step(0.38, 0.46),
  arrow(at(0.63, 0.58), at(0.695, 0.58)),
  step(0.7, 0.46),
  line([at(0.82, 0.46), at(0.82, 0.34), at(0.18, 0.34)], 2, 0.9),
  arrow(at(0.18, 0.34), at(0.18, 0.45)),
  line([at(0.08, 0.2), at(0.7, 0.2)], 2, 0.8),
  line([at(0.08, 0.09), at(0.5, 0.09)], 2, 0.8),
];
/** The page's face, tinted under its lines. */
const PAGE_FACE: Vec3[] = PAGE_STROKES[0].pts.map((q) => onPage(q));

const distance = (a: Vec2, b: Vec2): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
const lengthOf = (pts: Vec2[]): number => pts.slice(1).reduce((total, q, i) => total + distance(pts[i], q), 0);
const endOf = (stroke: Stroke): Vec2 => stroke.pts[stroke.pts.length - 1];
const mix = (a: Vec2, b: Vec2, f: number): Vec2 => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];

/** The first `reach` of a line's length. */
function partOf(pts: Vec2[], reach: number): Vec2[] {
  const out: Vec2[] = [pts[0]];
  let walked = 0;
  for (let i = 1; i < pts.length; i++) {
    const length = distance(pts[i - 1], pts[i]);
    if (walked + length <= reach) {
      out.push(pts[i]);
      walked += length;
      continue;
    }
    out.push(mix(pts[i - 1], pts[i], length > 0 ? (reach - walked) / length : 0));
    break;
  }
  return out;
}

/** Every stroke's place on the pencil's track: the way to it from the line before, then the line. */
function schedule(strokes: readonly Stroke[]): Step[] {
  const steps: Step[] = [];
  let cursor = 0;
  strokes.forEach((stroke, i) => {
    const travel = i > 0 ? distance(endOf(strokes[i - 1]), stroke.pts[0]) * TRAVEL_SHARE + TRAVEL_PAUSE : 0;
    const length = lengthOf(stroke.pts);
    const drawFrom = cursor + travel;
    const end = drawFrom + length + LINE_PAUSE;
    steps.push({ stroke, travelFrom: cursor, drawFrom, end, length });
    cursor = end;
  });
  return steps;
}
const STEPS = schedule(PAGE_STROKES);
const TRACK = STEPS[STEPS.length - 1].end;

/** How much of a step's line is drawn with the pencil at `cursor` on the track: none, a part, or all of it. */
function drawnPart(one: Step, cursor: number): Vec2[] | null {
  if (cursor >= one.end) return one.stroke.pts;
  if (cursor <= one.drawFrom) return null;
  return partOf(one.stroke.pts, ((cursor - one.drawFrom) / (one.end - one.drawFrom)) * one.length);
}

/** Where the pencil's point is at `cursor`: at the end of the line it draws, or lifted on the way to the next. */
function penAt(cursor: number): { tip: Vec2; lift: number } {
  const index = STEPS.findIndex((one) => cursor < one.end);
  if (index < 0) return { tip: endOf(STEPS[STEPS.length - 1].stroke), lift: 0 };
  const one = STEPS[index];
  const part = drawnPart(one, cursor);
  if (part) return { tip: part[part.length - 1], lift: 0 };
  if (index === 0) return { tip: one.stroke.pts[0], lift: 0 };
  const share = (cursor - one.travelFrom) / (one.drawFrom - one.travelFrom || 1);
  return {
    tip: mix(endOf(STEPS[index - 1].stroke), one.stroke.pts[0], share),
    lift: Math.sin(share * Math.PI) * PEN_LIFT,
  };
}

/** The pencil with its point at `point`: six edges, a cone to the point and its end, in ink. */
function pencil(point: Vec3, strength: number): Line[] {
  const axis = unit([0.42, 0.7, 0.58]);
  const side = unit(cross(axis, [0, 1, 0]));
  const other = cross(axis, side);
  const around = (along: number, angle: number): Vec3 =>
    sum(
      sum(point, scaled(axis, along)),
      sum(scaled(side, Math.cos(angle) * PEN_RADIUS), scaled(other, Math.sin(angle) * PEN_RADIUS)),
    );
  const lines: Line[] = [];
  const cap: Vec3[] = [];
  for (let i = 0; i <= PEN_SIDES; i++) {
    const angle = (i / PEN_SIDES) * Math.PI * 2;
    cap.push(around(PEN_END, angle));
    if (i === PEN_SIDES) break;
    lines.push({ c: 1, k: 0.95 * strength, p: [around(PEN_POINT, angle), around(PEN_END, angle)] });
    lines.push({ c: 1, k: 0.8 * strength, p: [around(PEN_POINT, angle), point] });
  }
  lines.push({ c: 1, k: 0.95 * strength, p: cap });
  return lines;
}

/** The scene at `t` seconds: the same `t` gives the same page, and a `t` that is no number gives its first moment. */
export function designScene(t: number): WireScene {
  const time = Number.isFinite(t) ? t : 0;
  const moment = ((time % DESIGN_LOOP) + DESIGN_LOOP) % DESIGN_LOOP;
  const fade = 1 - clamp((moment - DRAWING - HOLD) / FADE);
  const cursor = clamp(moment / DRAWING) * TRACK;
  const lines: Line[] = [];
  for (const one of STEPS) {
    const { stroke } = one;
    const drawn = drawnPart(one, cursor);
    if (drawn) lines.push({ c: stroke.c, k: stroke.k * fade, p: drawn.map((q) => onPage(q)) });
    if (stroke.ghost && drawn !== stroke.pts)
      lines.push({ c: stroke.c, k: GHOST * fade, p: stroke.pts.map((q) => onPage(q)) });
  }
  const pen = penAt(cursor);
  lines.push(...pencil(onPage(pen.tip, pen.lift), fade));
  return { lines, face: PAGE_FACE, fade, cam: designCamera(time) };
}

/** The page's camera at `t`: it sways a little, as the other standing subjects do. */
function designCamera(t: number): Camera {
  return {
    yaw: SWAY * Math.sin(t * SWAY_SPEED),
    pitch: 0.3,
    scale: 44,
    cx: 80,
    cy: 88,
    dist: 7,
    y0: 0,
    R: 0.6,
  };
}
