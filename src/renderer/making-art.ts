/**
 * The drawing on an asset card while its asset is being made: the kind's shape (`making-shapes.ts`)
 * swaying in place, built below a beam that sweeps up and down it and faint above. Lines fade with
 * depth in six alpha buckets; the faint fill is the union of the shape's faces. A still frame is
 * fully built and has no beam. Pure: `makingFrame` works out the frame, `paintMaking` draws it.
 */
import {
  accountMark,
  multiplayerMark,
  remixMark,
  bodyScan,
  cobbles,
  imageMark,
  type MarkShape,
  type Solid,
  soundMark,
  teapot,
  type Vec3,
  videoMark,
} from "./making-shapes.ts";

/** What a card draws, by the kind of asset it waits for. Also its canvas's `data-making-art`. */
export const MakingDrawing = {
  Character: "character",
  Model: "model",
  Image: "image",
  Texture: "texture",
  Video: "video",
  Sound: "sound",
  /** Not an asset: the Genex account's card, where Settings and Publish ask the person to sign in. */
  Account: "account",
  /** Not an asset: a room with two players, where Multiplayer asks for the Genex plugin. */
  Multiplayer: "multiplayer",
  /** Not an asset: the Remix fork, on Create's stage while a Play remix is made. */
  Remix: "remix",
} as const;
export type MakingDrawing = (typeof MakingDrawing)[keyof typeof MakingDrawing];

/** The drawing's area on the card, in CSS pixels, and where its subject is centred. */
export const ART_WIDTH = 160;
export const ART_HEIGHT = 112;
const CENTER_X = 80;
const CENTER_Y = 63;
/** The beam's width and how long one sweep up and back takes, in seconds. */
const BEAM_WIDTH = 76;
const SWEEP_S = 3.4;
/** How much brighter built lines are than the faint part above the beam. */
const FAINT = 0.22;
/** A mark's thickness in grid units, its slices' brightness back to front, and its pixels per unit. */
const MARK_DEPTH = 3;
const MARK_SLICES = [0.3, 0.42, 0.55, 1.15] as const;
const MARK_PX = 2.1;
/** How far the light reaches in front and behind a solid's centre, for its lines' depth fade. */
const DEPTH_REACH = 3;

/** A solid's camera: its height span, drawn height in pixels, pivot height, sway (centre, swing) and tilt. */
interface SolidSubject {
  solid: (t: number) => Solid;
  span: readonly [number, number];
  px: number;
  pivot: number;
  sway: readonly [number, number];
  pitch: number;
}
interface MarkSubject {
  mark: (t: number) => MarkShape[];
  /** A sideways nudge in grid units, so a lopsided mark looks centred. */
  nudge: number;
}
type Subject = SolidSubject | MarkSubject;

/** A drawing that does not move with time, built once. */
function once<T>(build: () => T): () => T {
  let made: T | null = null;
  return () => {
    made ??= build();
    return made;
  };
}
const scan = once(bodyScan);
const pot = once(teapot);
const image = once(imageMark);
const video = once(videoMark);
const account = once(accountMark);
const multiplayer = once(multiplayerMark);
const remix = once(remixMark);

const SUBJECTS: Record<MakingDrawing, Subject> = {
  [MakingDrawing.Character]: { solid: scan, span: [0, 6], px: 54, pivot: 3, sway: [0.22, 0.32], pitch: 0.16 },
  [MakingDrawing.Model]: { solid: pot, span: [0, 3.15], px: 30, pivot: 1.5, sway: [0.35, 0.45], pitch: 0.3 },
  [MakingDrawing.Texture]: { solid: cobbles, span: [0, 1.2], px: 15, pivot: 0.1, sway: [0.5, 0.35], pitch: 0.82 },
  [MakingDrawing.Image]: { mark: image, nudge: 0 },
  [MakingDrawing.Video]: { mark: video, nudge: 0 },
  [MakingDrawing.Sound]: { mark: soundMark, nudge: 0.6 },
  [MakingDrawing.Account]: { mark: account, nudge: 0 },
  [MakingDrawing.Multiplayer]: { mark: multiplayer, nudge: 0 },
  [MakingDrawing.Remix]: { mark: remix, nudge: 0 },
};

interface Camera {
  yaw: number;
  pitch: number;
  scale: number;
  dist: number;
  pivot: number;
}
type Point = [number, number];

function turn(p: Vec3, cam: Camera): Vec3 {
  const y = p[1] - cam.pivot;
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);
  const x1 = p[0] * cy + p[2] * sy;
  const z1 = -p[0] * sy + p[2] * cy;
  return [x1, y * cp - z1 * sp, y * sp + z1 * cp];
}
function project(r: Vec3, cam: Camera): Point {
  const k = cam.dist / (cam.dist - r[2]);
  return [CENTER_X + r[0] * cam.scale * k, CENTER_Y - r[1] * cam.scale * k];
}

/** One frame, ready to paint: lines by alpha bucket, the fill's polygons, a mark's face, the beam. */
export interface MakingFrame {
  /** Six buckets, faintest first; each holds line ends as x1, y1, x2, y2, … */
  lines: number[][];
  /** The faint fill: polygons wound one way, so their union fills once. */
  fill: Point[][];
  /** A mark's front face: polygons filled even-odd, so inner outlines are holes. */
  face: Point[][];
  /** The beam's height in the drawing, or null for a still frame. */
  beam: number | null;
  /** The fill is brighter below this height; a still frame is built all over. */
  builtFrom: number;
}

/** A line in the frame before it is bucketed: its ends and its brightness before the beam. */
interface Drawn {
  p: Point;
  q: Point;
  alpha: number;
}

/** A polygon turned to wind one way, so a nonzero fill of many of them is their union. */
function wound(points: Point[]): Point[] {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    area += x0 * y1 - x1 * y0;
  }
  return area < 0 ? points.reverse() : points;
}

function solidLines(solid: Solid, cam: Camera): Drawn[] {
  return solid.segments.map(({ a, b, k }) => {
    const ra = turn(a, cam);
    const rb = turn(b, cam);
    const depth = Math.max(0, Math.min(1, ((ra[2] + rb[2]) / 2 + DEPTH_REACH) / (2 * DEPTH_REACH)));
    return { p: project(ra, cam), q: project(rb, cam), alpha: (0.3 + 0.7 * depth) * k };
  });
}

/** A mark's outlines through its slices, back to front, and its front face. */
function markLines(shapes: readonly MarkShape[], nudge: number, cam: Camera): { drawn: Drawn[]; face: Point[][] } {
  const drawn: Drawn[] = [];
  const face: Point[][] = [];
  const at = (x: number, y: number, z: number): Point => project(turn([x + nudge, y, z], cam), cam);
  for (const shape of shapes) {
    const slices =
      shape.z === undefined
        ? MARK_SLICES.map((w, i): [number, number] => [
            -MARK_DEPTH / 2 + (MARK_DEPTH * i) / (MARK_SLICES.length - 1),
            w,
          ])
        : [[MARK_DEPTH / 2 + shape.z, 1] as [number, number]];
    for (const [z, weight] of slices) {
      const points = shape.points.map(([x, y]) => at(x, y, z));
      for (let i = 0; i < points.length; i++)
        drawn.push({ p: points[i], q: points[(i + 1) % points.length], alpha: 0.72 * weight * (shape.k ?? 1) });
    }
    if (shape.face) face.push(shape.points.map(([x, y]) => at(x, y, MARK_DEPTH / 2)));
  }
  return { drawn, face };
}

/** The frame's lines into six alpha buckets: full below the beam, faint above it. */
function bucket(drawn: readonly Drawn[], beam: number): number[][] {
  const lines: number[][] = [[], [], [], [], [], []];
  for (const { p, q, alpha } of drawn) {
    const shown = alpha * ((p[1] + q[1]) / 2 >= beam ? 1 : FAINT);
    if (shown < 0.03) continue;
    lines[Math.min(5, Math.floor(shown * 6))].push(p[0], p[1], q[0], q[1]);
  }
  return lines;
}

/** Where the beam is at `t`: easing from just below the drawing to just above it and back. */
function beamAt(drawn: readonly Drawn[], t: number): number {
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const { p, q } of drawn) {
    top = Math.min(top, p[1], q[1]);
    bottom = Math.max(bottom, p[1], q[1]);
  }
  if (!Number.isFinite(top)) return 0;
  const phase = 0.5 - 0.5 * Math.cos((t / SWEEP_S) * Math.PI * 2);
  return bottom + 2 - (bottom - top + 4) * phase;
}

/** The drawing at `t` seconds; `still` is the built drawing at rest, with no beam. */
export function makingFrame(drawing: MakingDrawing, t: number, still: boolean): MakingFrame {
  const subject = SUBJECTS[drawing];
  const time = Number.isFinite(t) ? t : 0;
  if ("mark" in subject) {
    const cam = { yaw: 0.42 * Math.sin(time * 0.55 + subject.nudge), pitch: 0.24, scale: MARK_PX, dist: 60, pivot: 0 };
    const { drawn, face } = markLines(subject.mark(time), subject.nudge, cam);
    return framed(drawn, [], face, time, still);
  }
  const cam = {
    yaw: subject.sway[0] + subject.sway[1] * Math.sin(time * 0.5),
    pitch: subject.pitch,
    scale: subject.px / (subject.span[1] - subject.span[0]),
    dist: 30,
    pivot: subject.pivot,
  };
  const solid = subject.solid(time);
  const fill = solid.faces.map((poly) => wound(poly.map((p) => project(turn(p, cam), cam))));
  return framed(solidLines(solid, cam), fill, [], time, still);
}

function framed(drawn: Drawn[], fill: Point[][], face: Point[][], t: number, still: boolean): MakingFrame {
  if (still) return { lines: bucket(drawn, Number.NEGATIVE_INFINITY), fill, face, beam: null, builtFrom: 0 };
  const beam = beamAt(drawn, t);
  return { lines: bucket(drawn, beam), fill, face, beam, builtFrom: beam };
}

// ── Painting ───────────────────────────────────────────────────────────────────────────────

export type Rgb = readonly [number, number, number];
/** The drawing's colours: its lines and fill, and the beam's light. */
export interface MakingColors {
  ink: Rgb;
  beam: Rgb;
}
const rgba = ([r, g, b]: Rgb, a: number): string => `rgba(${r}, ${g}, ${b}, ${a})`;
/** The fill's alpha below the beam and above it; a mark's face is a touch brighter. */
const FILL_ALPHA = { built: 0.09, faint: 0.04 } as const;
const FACE_ALPHA = { built: 0.1, faint: 0.06 } as const;

function polygons(ctx: CanvasRenderingContext2D, polys: readonly Point[][]): void {
  ctx.beginPath();
  for (const poly of polys) {
    const [first, ...rest] = poly;
    if (!first) continue;
    ctx.moveTo(first[0], first[1]);
    for (const [x, y] of rest) ctx.lineTo(x, y);
    ctx.closePath();
  }
}
function strokeBucket(ctx: CanvasRenderingContext2D, ends: readonly number[]): void {
  ctx.beginPath();
  for (let i = 0; i + 3 < ends.length; i += 4) {
    ctx.moveTo(ends[i], ends[i + 1]);
    ctx.lineTo(ends[i + 2], ends[i + 3]);
  }
  ctx.stroke();
}

/** The fill and face: faint all over, then brighter where the beam has passed. */
function paintFill(ctx: CanvasRenderingContext2D, frame: MakingFrame, ink: Rgb): void {
  const layer = (
    alpha: { built: number; faint: number },
    key: "built" | "faint",
    polys: Point[][],
    rule: CanvasFillRule,
  ) => {
    if (!polys.length) return;
    polygons(ctx, polys);
    ctx.fillStyle = rgba(ink, alpha[key]);
    ctx.fill(rule);
  };
  layer(FILL_ALPHA, "faint", frame.fill, "nonzero");
  layer(FACE_ALPHA, "faint", frame.face, "evenodd");
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, frame.builtFrom, ART_WIDTH, ART_HEIGHT);
  ctx.clip();
  layer(FILL_ALPHA, "built", frame.fill, "nonzero");
  layer(FACE_ALPHA, "built", frame.face, "evenodd");
  ctx.restore();
}

/** The beam: a soft band and a bright line, both fading out at their ends. */
function paintBeam(ctx: CanvasRenderingContext2D, y: number, light: Rgb): void {
  const left = CENTER_X - BEAM_WIDTH / 2;
  const glow = ctx.createLinearGradient(left, 0, left + BEAM_WIDTH, 0);
  glow.addColorStop(0, rgba(light, 0));
  glow.addColorStop(0.5, rgba(light, 1));
  glow.addColorStop(1, rgba(light, 0));
  ctx.fillStyle = glow;
  ctx.globalAlpha = 0.16;
  ctx.fillRect(left, y - 3, BEAM_WIDTH, 6);
  ctx.globalAlpha = 1;
  ctx.fillRect(left, y - 0.5, BEAM_WIDTH, 1);
}

/** Paint a frame onto a canvas whose backing store is `scale` times the drawing's size. */
export function paintMaking(
  ctx: CanvasRenderingContext2D,
  frame: MakingFrame,
  colors: MakingColors,
  scale: number,
): void {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, ART_WIDTH, ART_HEIGHT);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  paintFill(ctx, frame, colors.ink);
  // The brightest lines glow: drawn once more, wider and blurred, under the rest.
  ctx.save();
  // A canvas filter blurs in the backing store's pixels, so the radius follows its scale.
  ctx.filter = `blur(${1.5 * scale}px)`;
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = rgba(colors.ink, 0.55);
  strokeBucket(ctx, [...frame.lines[4], ...frame.lines[5]]);
  ctx.restore();
  ctx.lineWidth = 0.95;
  frame.lines.forEach((ends, i) => {
    if (!ends.length) return;
    ctx.strokeStyle = rgba(colors.ink, (i + 0.5) / 6);
    strokeBucket(ctx, ends);
  });
  if (frame.beam !== null) paintBeam(ctx, frame.beam, colors.beam);
}
