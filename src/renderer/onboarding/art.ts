/**
 * The first-launch art, in the empty states' wireframe language (see ui/wire-art.ts).
 *
 * Welcome: the sent prompt streams letter by letter onto the Planner's sheet, where a pen writes it
 * down with three tasks and ticks them off; the Workers' crane stacks blocks; the Reviewers' screen
 * plays the prompt's game (a space shooter), a scan passes and a stamp lands. Every second round the
 * stamp is a ✕: the screen glitches, redraws, is scanned again and passes.
 * Connect: the Claude Code and Codex marks, extruded, rocking over their buttons; OpenRouter's and
 * OpenCode's screens each show their own mark the same way, alone.
 * Local: a chip whose pins and layers fill while a model downloads.
 *
 * Everything is drawn in CSS pixels of a fixed logical size; the caller scales for the display.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import { crane } from "../ui/wire-art.ts";
import {
  CLAUDE_CODE_MARK,
  CODEX_MARK,
  OPENCODE_MARK,
  OPENROUTER_MARK,
  type ProviderMark,
} from "../ui/provider-marks.ts";

export type Rgb = [number, number, number];
/** Theme colours: accent, ink (the moving part), muted ink, pass and warning. */
export interface Palette {
  accent: Rgb;
  ink: Rgb;
  muted: Rgb;
  green: Rgb;
  orange: Rgb;
  /** The plan's sheet, when the theme sets one (`artPaper`); unset, it is ink at {@link SHEET_INK}. */
  paper?: Rgb;
  /** An unconnected mark's face, when the theme sets one (`artMark`); unset, ink at {@link MARK_FACE_INK}. */
  markFace?: Rgb;
}
/** How much ink the plan's sheet and an unconnected mark's face carry when the theme sets no colour. */
export const SHEET_INK = 0.07;
export const MARK_FACE_INK = 0.06;
/** The composer's text style, so the streamed letters leave exactly where the typed ones stood. */
export interface TextStyle {
  font: string;
  spacing: string;
}

type Vec3 = [number, number, number];
type Tone = 0 | 1 | 2 | 3 | 4;
interface Line {
  c: Tone;
  k: number;
  p: Vec3[];
  fade?: Vec3;
  flat?: boolean;
}
interface Fill {
  c: Tone;
  a: number;
  p: Vec3[];
  /** The plan's sheet: drawn in the theme's paper colour when it sets one. */
  paper?: true;
}
interface Dot {
  c: Tone;
  a: number;
  p: Vec3;
  r: number;
}
interface Scene {
  L: Line[];
  F: Fill[];
  D: Dot[];
}
interface Camera {
  yaw: number;
  pitch: number;
  scale: number;
  cx: number;
  cy: number;
  dist: number;
  tx: number;
  ty: number;
  tz: number;
  R: number;
}
type Glow = [x: number, y: number, r: number, a: number, color?: Rgb];

const TAU = Math.PI * 2;
function clamp(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
const ease = (x: number) => {
  const k = clamp(x);
  return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
};
const easeOut = (x: number) => 1 - Math.pow(1 - clamp(x), 3);
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const rgba = (c: Rgb, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${clamp(a).toFixed(3)})`;
const tones = (P: Palette): Rgb[] => [P.accent, P.ink, P.muted, P.green, P.orange];
function hex(color: string): Rgb {
  const n = parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const shade = (c: Rgb, k: number): Rgb => [Math.round(c[0] * k), Math.round(c[1] * k), Math.round(c[2] * k)];

/** The welcome stage, the connect art and the local chip, in CSS pixels. */
export const STAGE = { width: 760, height: 380 } as const;
export const MARKS = { width: 640, height: 200 } as const;
export const CHIP = { width: 400, height: 210 } as const;
/** Where the composer's first letter sits on the stage (its left edge and middle). */
export const PROMPT_ORIGIN = { x: 138, y: 155 } as const;
/** When a still frame of the welcome's second state is shown: everything has arrived. */
export const WELCOME_STILL = 4.8;
/** How long the second state plays before the prompt types again. */
export const GRAPH_MS = 15 * SECOND_MS;

function project(p: Vec3, cam: Camera): Vec3 {
  const x = p[0] - cam.tx,
    y = p[1] - cam.ty,
    z = p[2] - cam.tz;
  const cy = Math.cos(cam.yaw),
    sy = Math.sin(cam.yaw);
  const x1 = x * cy + z * sy,
    z1 = -x * sy + z * cy;
  const cp = Math.cos(cam.pitch),
    sp = Math.sin(cam.pitch);
  const y2 = y * cp - z1 * sp,
    z2 = y * sp + z1 * cp;
  const k = cam.dist / (cam.dist - z2);
  return [cam.cx + x1 * cam.scale * k, cam.cy - y2 * cam.scale * k, z2];
}
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const lerp3 = (a: Vec3, b: Vec3, k: number): Vec3 => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)];
const scene = (): Scene => ({ L: [], F: [], D: [] });

const EDGES = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
] as const;
const FACES = [
  [0, 1, 2, 3],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [1, 2, 6, 5],
  [2, 3, 7, 6],
  [3, 0, 4, 7],
] as const;
function boxPts(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, rot: number): Vec3[] {
  const co = Math.cos(rot),
    si = Math.sin(rot);
  const P = (x: number, y: number, z: number): Vec3 => [cx + x * co + z * si, cy + y, cz - x * si + z * co];
  return [
    P(-hx, -hy, -hz),
    P(hx, -hy, -hz),
    P(hx, -hy, hz),
    P(-hx, -hy, hz),
    P(-hx, hy, -hz),
    P(hx, hy, -hz),
    P(hx, hy, hz),
    P(-hx, hy, hz),
  ];
}
const boxEdges = (v: Vec3[]): Vec3[][] => EDGES.map(([a, b]) => [v[a]!, v[b]!]);
function box(S: Scene, c: Tone, k: number, v: Vec3[], fc: Tone, fa: number) {
  for (const e of boxEdges(v)) S.L.push({ c, k, p: e });
  if (fa > 0) for (const f of FACES) S.F.push({ c: fc, a: fa, p: f.map((i) => v[i]!) });
}
function ringH(cx: number, y: number, cz: number, r: number, n: number): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * TAU;
    pts.push([cx + r * Math.cos(a), y, cz + r * Math.sin(a)]);
  }
  return pts;
}
function square(S: Scene, c: Tone, k: number, cx: number, y: number, cz: number, hx: number, hz: number, rot: number) {
  const v = boxPts(cx, y, cz, hx, 0, hz, rot);
  S.L.push({ c, k, p: [v[0]!, v[1]!, v[2]!, v[3]!, v[0]!] });
}
/** A grid of muted lines that fades out with distance from its centre. */
function floor(S: Scene, cx: number, cz: number, hx: number, hz: number, step: number, R: number, k: number) {
  const fade: Vec3 = [cx, cz, R];
  for (let x = -hx; x <= hx + 1e-6; x += step) {
    const pts: Vec3[] = [];
    for (let z = -hz; z <= hz + 1e-6; z += step / 2) pts.push([cx + x, 0, cz + z]);
    S.L.push({ c: 2, k, p: pts, fade });
  }
  for (let z = -hz; z <= hz + 1e-6; z += step) {
    const pts: Vec3[] = [];
    for (let x = -hx; x <= hx + 1e-6; x += step / 2) pts.push([cx + x, 0, cz + z]);
    S.L.push({ c: 2, k, p: pts, fade });
  }
}
/** The part of a polyline between fractions u0 and u1 of its length. */
function subPath(pts: Vec3[], u0: number, u1: number): Vec3[] {
  const lens = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += len(sub(pts[i]!, pts[i - 1]!));
    lens.push(total);
  }
  const a = clamp(u0) * total,
    b = clamp(u1) * total;
  if (b - a < 1e-4) return [];
  const at = (d: number): Vec3 => {
    for (let j = 1; j < pts.length; j++) {
      if (d <= lens[j]! || j === pts.length - 1)
        return lerp3(pts[j - 1]!, pts[j]!, clamp((d - lens[j - 1]!) / (lens[j]! - lens[j - 1]! || 1)));
    }
    return pts[0]!;
  };
  const out = [at(a)];
  for (let i = 1; i < pts.length - 1; i++) if (lens[i]! > a && lens[i]! < b) out.push(pts[i]!);
  out.push(at(b));
  return out;
}

const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const norm3 = (a: Vec3): Vec3 => mul3(a, 1 / len(a));
const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const rotY = (v: Vec3, a: number): Vec3 => [
  v[0] * Math.cos(a) + v[2] * Math.sin(a),
  v[1],
  -v[0] * Math.sin(a) + v[2] * Math.cos(a),
];

/** The sheet in world units: its size, folded corner, how far it leans back and turns, and its height. */
const SHEET = { width: 1.9, height: 2.3, fold: 0.24, tilt: 0.95, yaw: -0.3, lift: 1.1 } as const;
/** The three tasks' rows, in sheet units from its centre (up is +). */
const TASK_ROWS = [0.3, -0.12, -0.54] as const;
/** How long the sheet's outline takes to draw itself. */
const SHEET_BORN = 0.3;
/** When the pen lifts off for good: the whole plan is written in about a second and a half. */
const WRITE_END = 1.52;
/** A task's box ticks, one row after another, once the plan is written. */
const readyAt = (row: number) => 1.58 + 0.1 * row;
/** Where a finished page rests: every task ticked, the lights gone, the pen lifted. */
const PLANNER_REST = 3;

type Uv = [number, number];
/** One stroke on the sheet: its points, how far along the line it runs (`from`–`to`, in u) and its ink. */
interface Stroke {
  pts: Uv[];
  from: number;
  to: number;
  c: Tone;
  k: number;
}
/** One line of the plan: its strokes, where it runs on the sheet, and when the pen passes along it. */
interface PlanLine {
  strokes: Stroke[];
  u0: number;
  u1: number;
  v: number;
  t0: number;
  t1: number;
}

/** Handwriting: a run of cursive loops (a prolate trochoid) per word, in sheet units. */
function handwriting(u0: number, u1: number, v: number, size: number, seed: number): Uv[][] {
  const out: Uv[][] = [];
  let u = u0;
  for (let word = 0; u < u1 - 0.06; word++) {
    const wide = Math.min(u1 - u, 0.14 + 0.2 * rnd(seed + word * 7));
    const a = size * 0.42,
      b = size * (0.85 + 0.35 * rnd(seed + word * 3));
    const pts: Uv[] = [];
    for (let th = 0; a * th - b * Math.sin(th) < wide; th += 0.32)
      pts.push([u + a * th - b * Math.sin(th), v + b * Math.cos(th) * 0.9 - b * 0.9]);
    if (pts.length > 1) out.push(pts);
    u += wide + 0.06;
  }
  return out;
}
const boxGlyph = (cu: number, cv: number, h: number): Uv[] => [
  [cu - h, cv + h],
  [cu + h, cv + h],
  [cu + h, cv - h],
  [cu - h, cv - h],
  [cu - h, cv + h],
];
const shipGlyph = (cu: number, cv: number): Uv[] => [
  [cu, cv + 0.11],
  [cu + 0.09, cv - 0.08],
  [cu, cv - 0.03],
  [cu - 0.09, cv - 0.08],
  [cu, cv + 0.11],
];
function ringGlyph(cu: number, cv: number, rx: number, ry: number, n: number, bump: (j: number) => number): Uv[] {
  const pts: Uv[] = [];
  for (let j = 0; j <= n; j++) {
    const a = (j / n) * TAU;
    pts.push([cu + rx * bump(j) * Math.cos(a), cv + ry * bump(j) * Math.sin(a)]);
  }
  return pts;
}
const rockGlyph = (cu: number, cv: number) => ringGlyph(cu, cv, 0.09, 0.09, 9, (j) => 0.78 + 0.4 * rnd((j % 9) + 40));
const zeroGlyph = (cu: number, cv: number) => ringGlyph(cu, cv, 0.028, 0.05, 14, () => 1);

/** A stroke in its ink, with the stretch of the line it covers. */
function stroke(pts: Uv[], c: Tone, k: number): Stroke {
  const us = pts.map((q) => q[0]);
  return { pts, from: Math.min(...us), to: Math.max(...us), c, k };
}
/** Each task's piece: a ship, an asteroid, and the score's three zeros. */
function taskPieces(row: number, v: number): Uv[][] {
  if (row === 0) return [shipGlyph(-0.43, v)];
  if (row === 1) return [rockGlyph(-0.43, v)];
  return [-0.07, 0, 0.07].map((du) => zeroGlyph(-0.43 + du, v));
}
/** When the pen passes along each line: the title, three tasks and the arrow, with short hops between. */
const LINE_TIMES: Array<[number, number]> = [
  [0.25, 0.55],
  [0.61, 0.81],
  [0.87, 1.07],
  [1.13, 1.33],
  [1.39, WRITE_END],
];

let LINES: PlanLine[] | null = null;
/** Everything the pen writes, line by line: the idea as a title, three tasks, and an arrow to the workers. */
function planLines(): PlanLine[] {
  if (LINES) return LINES;
  const title = [
    ...handwriting(-0.75, 0.55, 0.82, 0.05, 11).map((w) => stroke(w, 1, 0.85)),
    stroke(
      [
        [-0.75, 0.64],
        [0.2, 0.64],
      ],
      1,
      0.85,
    ),
  ];
  const lengths = [0.55, 0.72, 0.4];
  const tasks = TASK_ROWS.map((v, row) => [
    stroke(boxGlyph(-0.68, v, 0.065), 2, 0.95),
    ...taskPieces(row, v).map((pts) => stroke(pts, 0, 0.95)),
    ...handwriting(-0.24, -0.24 + lengths[row]!, v + 0.02, 0.036, 23 + row * 5).map((w) => stroke(w, 1, 0.85)),
  ]);
  const arrowTo: Uv[] = [
    [0.5, -0.84],
    [0.62, -0.92],
    [0.5, -1.0],
  ];
  const arrow = [
    stroke(
      [
        [0.1, -0.92],
        [0.62, -0.92],
      ],
      0,
      0.95,
    ),
    stroke(arrowTo, 0, 0.95),
  ];
  const groups = [title, ...tasks, arrow];
  const rows = [0.82, ...TASK_ROWS, -0.92];
  LINES = groups.map((strokes, i) => ({
    strokes,
    u0: Math.min(...strokes.map((s) => s.from)),
    u1: Math.max(...strokes.map((s) => s.to)),
    v: rows[i]!,
    t0: LINE_TIMES[i]![0],
    t1: LINE_TIMES[i]![1],
  }));
  return LINES;
}
/** How far along a line the pen has come by `p`, in u; it eases in and out of each line. */
const lineFront = (line: PlanLine, p: number) => lerp(line.u0, line.u1, ease((p - line.t0) / (line.t1 - line.t0)));

/** Where the sheet is in the world: a point on it (`w` lifts off its face), its normal and its width axis. */
interface Sheet {
  at: (u: number, v: number, w?: number) => Vec3;
  on: (pts: Uv[], w?: number) => Vec3[];
  normal: Vec3;
  across: Vec3;
  /** The sheet's outline, with the folded corner. */
  outline: Vec3[];
}
function sheetAt(bob: number): Sheet {
  const across = rotY([1, 0, 0], SHEET.yaw),
    back = rotY([0, 0, -1], SHEET.yaw),
    up: Vec3 = [0, 1, 0];
  const upSheet = add3(mul3(up, Math.cos(SHEET.tilt)), mul3(back, Math.sin(SHEET.tilt)));
  const normal = add3(mul3(up, Math.sin(SHEET.tilt)), mul3(back, -Math.cos(SHEET.tilt)));
  const centre: Vec3 = [0, SHEET.lift + bob, 0];
  const at = (u: number, v: number, w = 0) =>
    add3(add3(add3(centre, mul3(across, u)), mul3(upSheet, v)), mul3(normal, w));
  const hw = SHEET.width / 2,
    hh = SHEET.height / 2,
    fold = SHEET.fold;
  const outline = [at(-hw, -hh), at(hw, -hh), at(hw, hh - fold), at(hw - fold, hh), at(-hw, hh), at(-hw, -hh)];
  return { at, on: (pts, w = 0.004) => pts.map(([u, v]) => at(u, v, w)), normal, across, outline };
}
/** How solid the sheet's face is by `p`: it fills in over the second half of the outline drawing. */
const sheetSolid = (p: number) => clamp((clamp(p / SHEET_BORN) - 0.5) / 0.5);

/** The sheet itself: its outline drawing on, then its translucent face, folded corner and ruled lines. */
function sheetLines(S: Scene, sheet: Sheet, p: number) {
  const hw = SHEET.width / 2,
    hh = SHEET.height / 2,
    fold = SHEET.fold,
    { at, outline } = sheet;
  const born = clamp(p / SHEET_BORN);
  const drawn = born < 1 ? subPath(outline, 0, ease(born)) : outline;
  if (drawn.length > 1) S.L.push({ c: 0, k: 0.95, p: drawn });
  const f = sheetSolid(p);
  if (f <= 0) return;
  const corner = [at(hw, hh - fold), at(hw - fold, hh - fold), at(hw - fold, hh)];
  S.F.push({ c: 1, a: f, p: outline.slice(0, 5), paper: true }, { c: 0, a: 0.12 * f, p: corner });
  S.L.push({ c: 0, k: 0.75 * f, p: corner });
  for (const v of [...TASK_ROWS.map((r) => r - 0.1), -0.72])
    S.L.push({ c: 2, k: 0.2 * f, p: [at(-hw + 0.12, v), at(hw - 0.12, v)] });
}

/** What the pen has written by `p`: each stroke shows as far as the pen has passed along its line. */
function writtenInk(S: Scene, sheet: Sheet, p: number) {
  for (const line of planLines()) {
    if (p <= line.t0) continue;
    const front = lineFront(line, p);
    for (const s of line.strokes) {
      const f = clamp((front - s.from) / Math.max(0.02, s.to - s.from));
      if (f <= 0) continue;
      const pts = sheet.on(s.pts);
      const part = f < 1 ? subPath(pts, 0, f) : pts;
      if (part.length > 1) S.L.push({ c: s.c, k: s.k, p: part });
    }
  }
}

/** Ready: each task's box fills and ticks, and a light leaves its row towards the workers, once. */
function readyRows(S: Scene, sheet: Sheet, p: number) {
  TASK_ROWS.forEach((v, row) => {
    const q = clamp((p - readyAt(row)) / 0.18);
    if (q > 0) {
      const box = sheet.on(boxGlyph(-0.68, v, 0.065), 0.006);
      S.F.push({ c: 0, a: 0.45 * q, p: box.slice(0, 4) });
      S.L.push({ c: 0, k: q, p: box });
      S.L.push({
        c: 0,
        k: q,
        p: sheet.on(
          [
            [-0.71, v],
            [-0.685, v - 0.03],
            [-0.64, v + 0.035],
          ],
          0.008,
        ),
      });
    }
    const hu = (p - readyAt(row) - 0.05) / 0.7;
    if (hu < 0 || hu >= 1) return;
    const from = sheet.at(SHEET.width / 2, v);
    const light = subPath([from, add3(from, [1.9, 0, 0])], hu - 0.25, hu);
    if (light.length > 1) S.L.push({ c: 0, k: 0.9 * (1 - hu), p: light });
  });
}

/**
 * Where the pen would be at `p`: coming down onto the title, along the line it writes, hopping to
 * the next line, or rising away after the arrow. `writing` while it is on a line.
 */
function penPath(sheet: Sheet, p: number): { tip: Vec3; writing: boolean } {
  const lines = planLines();
  const on = (u: number, v: number) => sheet.at(u, v, 0.004);
  const first = lines[0]!,
    last = lines[lines.length - 1]!;
  if (p <= first.t0) {
    const e = ease(clamp((p - 0.05) / (first.t0 - 0.05)));
    return { tip: add3(on(first.u0, first.v), mul3(sheet.normal, 0.5 * (1 - e))), writing: false };
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!,
      next = lines[i + 1];
    if (p <= line.t1) return { tip: on(lineFront(line, p), line.v), writing: true };
    if (next && p < next.t0) {
      const e = ease((p - line.t1) / (next.t0 - line.t1));
      const hop = lerp3(on(line.u1, line.v), on(next.u0, next.v), e);
      return { tip: add3(hop, mul3(sheet.normal, 0.09 * Math.sin(Math.PI * e))), writing: false };
    }
  }
  const e = easeOut(clamp((p - WRITE_END) / 0.6));
  const end = on(last.u1, last.v);
  return { tip: add3(end, add3(mul3(sheet.normal, 0.45 * e), mul3(sheet.across, 0.35 * e))), writing: false };
}

/** The pen's tip averaged over ±90 ms, so it sweeps through the returns between lines instead of snapping. */
function smoothTip(sheet: Sheet, p: number): Vec3 {
  let sum: Vec3 = [0, 0, 0];
  for (let j = -6; j <= 6; j++) sum = add3(sum, penPath(sheet, Math.max(0, p + j * 0.015)).tip);
  return mul3(sum, 1 / 13);
}

/** A wireframe pen, leaning back from its tip; a dot of accent where it touches the page. */
function pen(S: Scene, sheet: Sheet, tip: Vec3, k: number, writing: boolean) {
  const dir = norm3(add3(add3(mul3(sheet.normal, 0.62), [0, 0.55, 0]), mul3(sheet.across, 0.42)));
  const e1 = norm3(cross3(dir, [0, 1, 0])),
    e2 = cross3(dir, e1),
    r = 0.05;
  const along = (d: number) => add3(tip, mul3(dir, d));
  const ring = (c: Vec3) => {
    const pts: Vec3[] = [];
    for (let i = 0; i <= 14; i++) {
      const a = (i / 14) * TAU;
      pts.push(add3(c, add3(mul3(e1, r * Math.cos(a)), mul3(e2, r * Math.sin(a)))));
    }
    return pts;
  };
  const base = along(0.2),
    cap = along(1.15),
    clip = along(0.95);
  const sides = [0, 1, 2].map((i) => {
    const a = (i / 3) * TAU + 0.4;
    return add3(mul3(e1, r * Math.cos(a)), mul3(e2, r * Math.sin(a)));
  });
  for (const s of sides)
    S.L.push({ c: 1, k: 0.95 * k, p: [tip, add3(base, s)] }, { c: 1, k: 0.95 * k, p: [add3(base, s), add3(cap, s)] });
  S.L.push(
    { c: 1, k: 0.95 * k, p: ring(base) },
    { c: 1, k: 0.95 * k, p: ring(cap) },
    { c: 2, k: 0.7 * k, p: ring(along(0.3)) },
  );
  S.L.push({ c: 2, k: 0.8 * k, p: [add3(clip, mul3(e1, r)), add3(add3(clip, mul3(e1, r + 0.035)), mul3(dir, 0.12))] });
  const [s0, s1] = [sides[0]!, sides[1]!];
  S.F.push({ c: 1, a: 0.06 * k, p: [tip, add3(base, s0), add3(cap, s0), add3(cap, s1), add3(base, s1)] });
  if (writing) S.D.push({ c: 0, a: k, p: tip, r: 1.8 });
}

/** The sheet bobs gently in midair, `time` seconds in. */
const plannerSheet = (time: number) => sheetAt(0.035 * Math.sin(1.3 * time));

/**
 * Planner: a sheet in midair that a pen writes the plan on, once, `p` seconds in: the idea as a
 * title, three tasks (a box, the piece, a few words) and an arrow, in about a second and a half;
 * then the boxes tick one by one, a light leaves each row towards the workers, and the page stays.
 */
function planner(p: number, time: number): Scene {
  const S = scene();
  const sheet = plannerSheet(time);
  sheetLines(S, sheet, p);
  writtenInk(S, sheet, p);
  readyRows(S, sheet, p);
  const resting = p > WRITE_END ? 1 - 0.55 * clamp((p - WRITE_END) / 0.6) : 1;
  const k = clamp((p - 0.05) / 0.2) * resting;
  if (k > 0.01) pen(S, sheet, smoothTip(sheet, p), k, penPath(sheet, p).writing);
  return S;
}

/** Workers: the app's own crane. */
const workers = (t: number): Scene => ({
  L: crane(t).map((line) => ({ c: line.c, k: line.k, p: line.p })),
  F: [],
  D: [],
});

function rnd(i: number) {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
let ICO: { v: Vec3[]; e: Array<[number, number]> } | null = null;
function icosahedron() {
  if (ICO) return ICO;
  const g = (1 + Math.sqrt(5)) / 2;
  const raw: Vec3[] = [
    [-1, g, 0],
    [1, g, 0],
    [-1, -g, 0],
    [1, -g, 0],
    [0, -1, g],
    [0, 1, g],
    [0, -1, -g],
    [0, 1, -g],
    [g, 0, -1],
    [g, 0, 1],
    [-g, 0, -1],
    [-g, 0, 1],
  ];
  const faces = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  const seen = new Set<string>(),
    e: Array<[number, number]> = [];
  for (const f of faces)
    for (const [a, b] of [
      [f[0]!, f[1]!],
      [f[1]!, f[2]!],
      [f[2]!, f[0]!],
    ] as const) {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (!seen.has(key)) {
        seen.add(key);
        e.push([a, b]);
      }
    }
  return (ICO = {
    v: raw.map((p) => {
      const l = len(p);
      return [p[0] / l, p[1] / l, p[2] / l] as Vec3;
    }),
    e,
  });
}
function orient(p: Vec3, spin: number, tilt: number, r: number, c: Vec3): Vec3 {
  const y = p[1] * Math.cos(tilt) - p[2] * Math.sin(tilt),
    z = p[1] * Math.sin(tilt) + p[2] * Math.cos(tilt);
  const x = p[0] * Math.cos(spin) + z * Math.sin(spin),
    z2 = -p[0] * Math.sin(spin) + z * Math.cos(spin);
  return [c[0] + x * r, c[1] + y * r, c[2] + z2 * r];
}

/** The game's scrolling floor grid and its drifting stars. */
function spaceField(I: Scene, t: number) {
  for (let i = 0; i < 9; i++) {
    const gz = -3 + ((i / 9 + t * 0.5) % 1) * 4.5;
    I.L.push({
      c: 2,
      k: 0.5,
      p: [
        [-2.2, -0.7, gz],
        [2.2, -0.7, gz],
      ],
    });
  }
  for (let i = -4; i <= 4; i++)
    I.L.push({
      c: 2,
      k: 0.4,
      p: [
        [i * 0.5, -0.7, -3],
        [i * 0.5, -0.7, 1.5],
      ],
    });
  for (let i = 0; i < 20; i++) {
    I.D.push({
      c: 1,
      a: 0.3 + 0.5 * rnd(i + 230),
      p: [-2.5 + 5 * rnd(i + 260), -0.3 + 2.1 * rnd(i + 290), -3.5 + ((rnd(i + 200) + t * 0.35) % 1) * 5],
      r: 0.8,
    });
  }
}

/** The ship weaving and banking, its engine glow and its shots flying ahead; returns its height. */
function ship(I: Scene, t: number): number {
  const sx = 0.55 * Math.sin(t * 1.1),
    bank = -0.5 * Math.cos(t * 1.1),
    sy = 0.05 * Math.sin(t * 2.3),
    sz = 0.9;
  const cb = Math.cos(bank),
    sb = Math.sin(bank);
  const Sh = (x: number, y: number, z: number): Vec3 => [sx + x * cb - y * sb, sy + x * sb + y * cb, sz + z];
  const nose = Sh(0, 0, -0.38),
    wl = Sh(-0.32, -0.02, 0.12),
    wr = Sh(0.32, -0.02, 0.12),
    fin = Sh(0, 0.12, 0.1),
    tail = Sh(0, -0.05, 0.14);
  I.L.push(
    { c: 0, k: 1, p: [nose, wl, tail, wr, nose] },
    { c: 0, k: 1, p: [nose, fin, wl] },
    { c: 0, k: 1, p: [fin, wr] },
    { c: 0, k: 0.8, p: [fin, tail] },
  );
  I.F.push({ c: 0, a: 0.18, p: [nose, wl, tail, wr] });
  I.D.push({ c: 4, a: 0.6 + 0.4 * Math.sin(t * 30), p: Sh(0, 0.02, 0.18), r: 1.8 });
  for (let i = 0; i < 3; i++) {
    const u = (t * 2 + i / 3) % 1,
      tf = t - u * 0.5,
      bx = 0.55 * Math.sin(tf * 1.1),
      bz = sz - 0.45 - u * 3.5;
    I.L.push({
      c: 0,
      k: 1 - u * 0.6,
      p: [
        [bx, sy, bz],
        [bx, sy, bz - 0.25],
      ],
    });
  }
  return sy;
}

/** Four asteroids tumbling towards the ship, fading in and out at the ends of their run. */
function asteroids(I: Scene, t: number) {
  const ico = icosahedron();
  for (let i = 0; i < 4; i++) {
    const ph = (rnd(i + 300) + t * 0.28) % 1,
      ar = 0.16 + 0.14 * rnd(i + 390);
    const ac: Vec3 = [-1.3 + 2.6 * rnd(i + 330), -0.2 + 0.9 * rnd(i + 360), -3 + ph * 4.2];
    const P = ico.v.map((p) => orient(p, t * (0.8 + i * 0.3), t * 0.6 + i, ar, ac));
    const fade = Math.min(1, ph * 4, (1 - ph) * 6);
    for (const [a, b] of ico.e) I.L.push({ c: 2, k: 0.9 * fade, p: [P[a]!, P[b]!] });
  }
}

/** The asteroid ahead bursting, once every 2.6 s, at the ship's height `sy`. */
function blast(I: Scene, t: number, sy: number) {
  const ec = t % 2.6,
    ek = ec / 0.6;
  if (ek < 1) {
    const ex = 0.55 * Math.sin((t - ec) * 1.1),
      ez = -1.5;
    for (let j = 0; j < 8; j++) {
      const ea = (j / 8) * TAU + 0.3,
        r0 = 0.08 + 0.35 * easeOut(ek),
        r1 = r0 + 0.12,
        dz = 0.1 * Math.sin(j);
      I.L.push({
        c: 4,
        k: 1 - ek,
        p: [
          [ex + r0 * Math.cos(ea), sy + r0 * Math.sin(ea), ez + dz],
          [ex + r1 * Math.cos(ea), sy + r1 * Math.sin(ea), ez + dz],
        ],
      });
    }
    I.D.push({ c: 1, a: 1 - ek, p: [ex, sy, ez], r: 2.5 * (1 - ek) + 0.5 });
  }
}

/** The prompt's game: a ship weaves through tumbling asteroids and blasts the one ahead. */
function space(t: number): Scene & { cam: Camera } {
  const I = scene();
  spaceField(I, t);
  const sy = ship(I, t);
  asteroids(I, t);
  blast(I, t, sy);
  return {
    ...I,
    cam: {
      yaw: 0.12 * Math.sin(t * 0.3),
      pitch: 0.28,
      scale: 0.75,
      cx: 0,
      cy: 0.1,
      dist: 5,
      tx: 0,
      ty: 0.2,
      tz: 0,
      R: 2.5,
    },
  };
}

/** Liang–Barsky: the part of segment ab inside the rectangle, or null. */
function clipSeg(
  a: [number, number],
  b: [number, number],
  u0: number,
  u1: number,
  v0: number,
  v1: number,
): [[number, number], [number, number]] | null {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const edges: Array<[p: number, q: number]> = [
    [-dx, a[0] - u0],
    [dx, u1 - a[0]],
    [-dy, a[1] - v0],
    [dy, v1 - a[1]],
  ];
  const span = { t0: 0, t1: 1 };
  for (const [p, q] of edges) if (!clipEdge(p, q, span)) return null;
  return [
    [a[0] + span.t0 * dx, a[1] + span.t0 * dy],
    [a[0] + span.t1 * dx, a[1] + span.t1 * dy],
  ];
}

/** One edge of the clip rectangle: narrows the kept span of the segment, or rejects it (false). */
function clipEdge(p: number, q: number, span: { t0: number; t1: number }): boolean {
  if (p === 0) return !(q < 0);
  const r = q / p;
  if (p < 0) {
    if (r > span.t1) return false;
    if (r > span.t0) span.t0 = r;
    return true;
  }
  if (r < span.t0) return false;
  if (r < span.t1) span.t1 = r;
  return true;
}

/** A stamp on the Judges' screen: when it lands and leaves, in seconds of its round, and whether it passes. */
interface Stamp {
  at: number;
  out: number;
  ok: boolean;
}
const PASSING_ROUND: readonly Stamp[] = [{ at: 2.3, out: 5.2, ok: true }];
const FAILING_ROUND: readonly Stamp[] = [
  { at: 2.3, out: 3.3, ok: false },
  { at: 5.5, out: 7.2, ok: true },
];

/** Where a round of the Judges' screen is. */
interface JudgeBeat {
  /** Seconds into the round. */
  f: number;
  stamps: readonly Stamp[];
  /** The scan line's height on the screen (0 to 1), or -1 with no scan. */
  scanV: number;
  glitch: boolean;
  /** How much of the game is drawn, left to right (0 to 1). */
  reveal: number;
  /** The screen frame's tone: accent, green on a pass, orange while it fails. */
  frameC: Tone;
}

/** A failing round after its first scan: the glitch, the redraw, a second scan and the green frame. */
function failingBeat(beat: JudgeBeat): void {
  const { f } = beat;
  if (f >= 2.3 && f < 3.3) {
    beat.glitch = true;
    beat.frameC = 4;
  }
  if (f >= 3.3 && f < 4.1) beat.reveal = ease((f - 3.3) / 0.8);
  if (f >= 4.2 && f < 5.4) beat.scanV = 1 - (f - 4.2) / 1.2;
  if (f >= 5.5 && f < 6.1) beat.frameC = 3;
}

/** The round `t` falls in: 14 s cycles of a passing round (6 s) and a failing one (8 s). */
function judgeBeat(t: number): JudgeBeat {
  const cyc = ((t % 14) + 14) % 14,
    fail = cyc >= 6,
    f = fail ? cyc - 6 : cyc;
  const beat: JudgeBeat = {
    f,
    stamps: fail ? FAILING_ROUND : PASSING_ROUND,
    scanV: -1,
    glitch: false,
    reveal: 1,
    frameC: 0,
  };
  if (f >= 0.6 && f < 2.2) beat.scanV = 1 - (f - 0.6) / 1.6;
  if (fail) failingBeat(beat);
  else if (f >= 2.3 && f < 2.9) beat.frameC = 3;
  return beat;
}

/** The monitor: its glass, the front and back frames and the edges between them, and its stand. */
function monitor(S: Scene, frameC: Tone) {
  const X0 = -1.7,
    X1 = 1.7,
    Y0 = 0.45,
    Y1 = 2.55;
  const front: Vec3[] = [
    [X0, Y0, 0.04],
    [X1, Y0, 0.04],
    [X1, Y1, 0.04],
    [X0, Y1, 0.04],
  ];
  const back: Vec3[] = [
    [X0, Y0, -0.04],
    [X1, Y0, -0.04],
    [X1, Y1, -0.04],
    [X0, Y1, -0.04],
  ];
  S.F.push({ c: 0, a: 0.05, p: front });
  S.L.push({ c: frameC, k: 0.95, p: [...front, front[0]!] }, { c: 2, k: 0.5, p: [...back, back[0]!] });
  for (let i = 0; i < 4; i++) S.L.push({ c: 2, k: 0.5, p: [front[i]!, back[i]!] });
  S.L.push({
    c: 2,
    k: 0.7,
    p: [
      [0, Y0, -0.04],
      [0, 0.04, -0.04],
    ],
  });
  square(S, 2, 0.7, 0, 0.02, -0.04, 0.55, 0.26, 0);
}

/** A point on the screen's face, from its lower-left corner (0 to 1 across and up). */
const onScreen = (u: number, v: number): Vec3 => [-1.6 + 3.2 * u, 0.55 + 1.9 * v, 0.045];
/** The game's picture on the screen: its middle's height and its half-width and half-height. */
const PICTURE = { middle: 1.5, halfWidth: 1.57, halfHeight: 0.92 } as const;
/** A point of the game's projected picture, placed on the screen. */
const inPicture = (x: number, y: number): Vec3 => [x, PICTURE.middle - y, 0.045];

/** One of the game's lines, projected, jittered while it glitches and clipped to the picture drawn so far. */
function gameLine(S: Scene, ln: Line, idx: number, cam: Camera, t: number, glitch: boolean, right: number) {
  const { halfWidth: HX, halfHeight: HY } = PICTURE;
  const jit = glitch ? 0.14 * Math.sin(idx * 12.9 + t * 47) : 0,
    col = glitch ? 4 : ln.c;
  let prev: [number, number] | null = null,
    pz = 0;
  for (const point of ln.p) {
    const q = project(point, cam),
      cur: [number, number] = [q[0] + jit, q[1]];
    const cl = prev ? clipSeg(prev, cur, -HX, right, -HY, HY) : null;
    if (cl) {
      const d = clamp(((q[2] + pz) / 2 + cam.R) / (2 * cam.R));
      S.L.push({
        c: col,
        k: ln.k * (0.45 + 0.55 * d),
        p: [inPicture(cl[0][0], cl[0][1]), inPicture(cl[1][0], cl[1][1])],
        flat: true,
      });
    }
    prev = cur;
    pz = q[2];
  }
}

/** The game, played with its own camera on the screen: glitched while it fails, redrawn left to right after. */
function gameOnScreen(S: Scene, t: number, beat: JudgeBeat) {
  const { halfWidth: HX, halfHeight: HY } = PICTURE;
  const right = -HX + 2 * HX * beat.reveal;
  const G = space(t),
    cam = G.cam;
  const inside = (q: Vec3) => q[0] > -HX && q[0] < right && q[1] > -HY && q[1] < HY;
  G.L.forEach((ln, idx) => gameLine(S, ln, idx, cam, t, beat.glitch, right));
  if (!beat.glitch)
    for (const fl of G.F) {
      const q = fl.p.map((p) => project(p, cam));
      if (q.every(inside)) S.F.push({ c: fl.c, a: fl.a, p: q.map((v) => inPicture(v[0], v[1])) });
    }
  for (const dd of G.D) {
    const q = project(dd.p, cam);
    if (inside(q)) S.D.push({ c: beat.glitch ? 4 : dd.c, a: dd.a, p: inPicture(q[0], q[1]), r: dd.r });
  }
}

/** The scan line and the fainter one trailing it. */
function scanLine(S: Scene, scanV: number) {
  if (scanV < 0) return;
  S.L.push({ c: 0, k: 1, p: [onScreen(0, scanV), onScreen(1, scanV)] });
  if (scanV + 0.04 <= 1) S.L.push({ c: 0, k: 0.35, p: [onScreen(0, scanV + 0.04), onScreen(1, scanV + 0.04)] });
}

/** A stamp landing on the screen, `f` seconds into its round: a ring with a tick or a cross, fading as it leaves. */
function stamp(S: Scene, f: number, ev: Stamp) {
  if (f < ev.at) return;
  const p = clamp((f - ev.at) / 0.25);
  const fo = f > ev.out ? clamp(1 - (f - ev.out) / 0.5) : 1;
  const al = Math.min(1, p * 1.4) * fo;
  if (al < 0.01) return;
  const sc = 1 + 0.7 * (1 - easeOut(p)),
    cx = 1.18,
    cy = 0.95,
    cz = 0.12,
    r = 0.26 * sc,
    c: Tone = ev.ok ? 3 : 4;
  const ring: Vec3[] = [];
  for (let m = 0; m <= 32; m++) {
    const an = (m / 32) * TAU;
    ring.push([cx + r * Math.cos(an), cy + r * Math.sin(an), cz]);
  }
  S.L.push({ c, k: al, p: ring });
  S.F.push({ c: 0, a: 0.5 * al, p: ring.slice(0, 32) }, { c, a: 0.2 * al, p: ring.slice(0, 32) });
  const P = (x: number, y: number): Vec3 => [cx + x * sc, cy + y * sc, cz];
  if (ev.ok) S.L.push({ c, k: al, p: [P(-0.11, 0), P(-0.03, -0.08), P(0.12, 0.09)] });
  else S.L.push({ c, k: al, p: [P(-0.09, -0.09), P(0.09, 0.09)] }, { c, k: al, p: [P(-0.09, 0.09), P(0.09, -0.09)] });
}

/**
 * Judges: the screen plays the build, a scan sweeps it and a stamp lands. Every second round the
 * stamp is a ✕: the screen glitches, redraws, is scanned again and passes. The game is its own
 * 3D scene, projected with its own camera onto the screen.
 */
function judges(t: number): Scene {
  const S = scene();
  const beat = judgeBeat(t);
  monitor(S, beat.frameC);
  S.L.push({ c: 2, k: 0.3, p: [onScreen(0, 0), onScreen(1, 0), onScreen(1, 1), onScreen(0, 1), onScreen(0, 0)] });
  gameOnScreen(S, t, beat);
  scanLine(S, beat.scanV);
  for (const ev of beat.stamps) stamp(S, beat.f, ev);
  return S;
}

/** The letters' flight runs 12% slower than the first cut (the owner asked for 10–15%). */
const FLIGHT = 1.12;
/** Where the letters land: the title line of the Planner's sheet, as drawn. */
const INBOX = { x: 115, y: 147 };
const centres = new Map<string, number[]>();
/** Each letter's centre along the prompt, measured the way the composer lays the text out. */
function letterCentres(ctx: CanvasRenderingContext2D, text: string, style: TextStyle): number[] {
  const key = `${style.font}|${style.spacing}|${text}`;
  let out = centres.get(key);
  if (out) return out;
  out = [];
  let before = 0;
  for (let i = 0; i < text.length; i++) {
    const after = ctx.measureText(text.slice(0, i + 1)).width;
    out.push(PROMPT_ORIGIN.x + (before + after) / 2);
    before = after;
  }
  if (centres.size > 32) centres.clear();
  centres.set(key, out);
  return out;
}
/** The sent prompt leaves the composer letter by letter and lands on the Planner's sheet. */
function streamText(ctx: CanvasRenderingContext2D, text: string, time: number, style: TextStyle, P: Palette) {
  const t = time / FLIGHT;
  if (!text || t > 1.3) return;
  ctx.save();
  ctx.font = style.font;
  ctx.letterSpacing = style.spacing;
  ctx.textBaseline = "middle";
  const x = letterCentres(ctx, text, style);
  ctx.letterSpacing = "0px";
  ctx.textAlign = "center";
  const y0 = PROMPT_ORIGIN.y;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === " ") continue;
    const p = clamp((t - 0.02 - i * 0.011) / 0.5);
    if (p >= 1) continue;
    const sx = x[i]!,
      mx = (sx + INBOX.x) / 2,
      my = Math.min(y0, INBOX.y) - 40 - 14 * Math.sin(i * 1.7);
    const bez = (k: number): [number, number] => {
      const a = 1 - k;
      return [a * a * sx + 2 * a * k * mx + k * k * INBOX.x, a * a * y0 + 2 * a * k * my + k * k * INBOX.y];
    };
    const e = ease(p),
      pos = bez(e),
      al = p < 0.7 ? 1 : 1 - (p - 0.7) / 0.3,
      mix = clamp(e * 1.6);
    for (let k = 1; k <= 3 && p > 0; k++) {
      const tp = bez(ease(clamp(p - k * 0.06)));
      ctx.fillStyle = rgba(P.accent, al * (0.5 - k * 0.14));
      ctx.fillRect(tp[0] - 0.75, tp[1] - 0.75, 1.5, 1.5);
    }
    const sc = 1 - 0.65 * e;
    ctx.save();
    ctx.translate(pos[0], pos[1]);
    ctx.scale(sc, sc);
    ctx.fillStyle = rgba(
      [lerp(P.ink[0], P.accent[0], mix), lerp(P.ink[1], P.accent[1], mix), lerp(P.ink[2], P.accent[2], mix)],
      al,
    );
    ctx.fillText(ch, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

/** How many alpha steps the strokes are batched by. */
const ALPHA_STEPS = 8;

/** A segment's alpha: nearer is brighter (a flat line keeps its own), and a faded line dims towards its edge. */
function segmentAlpha(line: Line, from: Vec3, to: Vec3, fromW: Vec3, toW: Vec3, cam: Camera): number {
  const a = line.flat ? line.k : (0.3 + 0.7 * clamp(((from[2] + to[2]) / 2 + cam.R) / (2 * cam.R))) * line.k;
  if (!line.fade) return a;
  const mx = (toW[0] + fromW[0]) / 2 - line.fade[0],
    mz = (toW[2] + fromW[2]) / 2 - line.fade[1];
  return a * Math.pow(clamp(1 - Math.sqrt(mx * mx + mz * mz) / line.fade[2]), 1.6);
}

/** Add one line's visible segments, projected, to the buckets of their tone and alpha step. */
function bucketLine(buckets: Map<string, number[]>, line: Line, cam: Camera) {
  let prev: Vec3 | null = null,
    prevW: Vec3 | null = null;
  for (const w of line.p) {
    const q = project(w, cam);
    const a = prev && prevW ? segmentAlpha(line, prev, q, prevW, w, cam) : 0;
    if (prev && a > 0.02) {
      const key = `${line.c}:${Math.max(0, Math.min(ALPHA_STEPS - 1, Math.floor(a * ALPHA_STEPS)))}`;
      let b = buckets.get(key);
      if (!b) {
        b = [];
        buckets.set(key, b);
      }
      b.push(prev[0], prev[1], q[0], q[1]);
    }
    prev = q;
    prevW = w;
  }
}

/** Nearer segments are brighter; faded lines dim towards their edge. Batched per colour and alpha step. */
function strokeAll(ctx: CanvasRenderingContext2D, L: Line[], cam: Camera, T: Rgb[]) {
  const buckets = new Map<string, number[]>();
  for (const line of L) if (line.k > 0.01) bucketLine(buckets, line, cam);
  for (const [key, b] of buckets) {
    const [c, step] = key.split(":").map(Number) as [number, number];
    ctx.strokeStyle = rgba(T[c]!, (step + 0.5) / ALPHA_STEPS);
    ctx.beginPath();
    for (let m = 0; m < b.length; m += 4) {
      ctx.moveTo(b[m]!, b[m + 1]!);
      ctx.lineTo(b[m + 2]!, b[m + 3]!);
    }
    ctx.stroke();
  }
}
/** A face's fill: its tone, or for the plan's sheet the theme's paper, else faint ink. */
function faceFill(f: Fill, T: Rgb[], P: Palette): string {
  if (!f.paper) return rgba(T[f.c] ?? P.ink, f.a);
  return P.paper ? rgba(P.paper, f.a) : rgba(P.ink, SHEET_INK * f.a);
}
function layer(ctx: CanvasRenderingContext2D, ground: Scene | null, S: Scene, cam: Camera, glows: Glow[], P: Palette) {
  const T = tones(P);
  ctx.lineWidth = 1;
  for (const [x, y, r, a, color] of glows) {
    if (!(a > 0)) continue;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, 0.3);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    g.addColorStop(0, rgba(color ?? P.accent, a));
    g.addColorStop(1, rgba(color ?? P.accent, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
  if (ground) strokeAll(ctx, ground.L, cam, T);
  const faces = S.F.map((f) => {
    const q = f.p.map((p) => project(p, cam));
    return { f, q, z: q.reduce((sum, v) => sum + v[2], 0) / q.length };
  }).sort((a, b) => a.z - b.z);
  for (const { f, q } of faces) {
    if (f.a <= 0.005) continue;
    ctx.fillStyle = faceFill(f, T, P);
    ctx.beginPath();
    ctx.moveTo(q[0]![0], q[0]![1]);
    for (let i = 1; i < q.length; i++) ctx.lineTo(q[i]![0], q[i]![1]);
    ctx.closePath();
    ctx.fill();
  }
  strokeAll(ctx, S.L, cam, T);
  for (const d of S.D) {
    if (d.a <= 0.01) continue;
    const q = project(d.p, cam);
    ctx.fillStyle = rgba(T[d.c]!, d.a);
    ctx.beginPath();
    ctx.arc(q[0], q[1], d.r, 0, TAU);
    ctx.fill();
  }
}
/** A scene faded in by `m`. */
function faded(S: Scene, m: number): Scene {
  return {
    L: S.L.map((l) => ({ ...l, k: l.k * m })),
    F: S.F.map((f) => ({ ...f, a: f.a * m })),
    D: S.D.map((d) => ({ ...d, a: d.a * m })),
  };
}

/**
 * The welcome's three roles stand in a row, each on the same floor: one grid seen from one angle,
 * fading out towards its edge, and one glow, all on one ground line. Each role's own camera
 * shares the floor's pitch and puts its origin on the floor's centre, so it stands on it.
 */
const GROUND_Y = 222;
const PITCH = 0.34;
const ROLE_X = { planner: 127, workers: 380, reviewers: 633 } as const;
const floorCam = (cx: number): Camera => ({
  yaw: 0.5,
  pitch: PITCH,
  scale: 40,
  cx,
  cy: GROUND_Y,
  dist: 12,
  tx: 0,
  ty: 0,
  tz: 0,
  R: 2.4,
});
let FLOOR: Scene | null = null;
/** A role's floor: its glow, then its grid. */
function roleFloor(ctx: CanvasRenderingContext2D, cx: number, m: number, P: Palette) {
  if (m <= 0) return;
  if (!FLOOR) {
    FLOOR = scene();
    floor(FLOOR, 0, 0, 2.6, 2.6, 0.4, 2.3, 0.5);
  }
  layer(ctx, faded(FLOOR, m), scene(), floorCam(cx), [[cx, GROUND_Y + 2, 54, 0.26 * m]], P);
}
/** A role's own scene over its floor, faded in by `m`. */
function standing(ctx: CanvasRenderingContext2D, S: Scene, cam: Camera, m: number, P: Palette) {
  if (m > 0) layer(ctx, null, faded(S, m), cam, [], P);
}

const CAM_O: Camera = {
  yaw: 0.55,
  pitch: PITCH,
  scale: 45,
  cx: ROLE_X.planner,
  cy: GROUND_Y,
  dist: 12,
  tx: 0,
  ty: 0,
  tz: 0,
  R: 1.6,
};
const CAM_C: Camera = {
  yaw: 0.2,
  pitch: PITCH,
  scale: 14.4,
  cx: ROLE_X.workers,
  cy: GROUND_Y,
  dist: 40,
  tx: 1.5,
  ty: 0,
  tz: 0,
  R: 4.5,
};
const CAM_J: Camera = {
  yaw: -0.38,
  pitch: PITCH,
  scale: 34.2,
  cx: ROLE_X.reviewers,
  cy: GROUND_Y,
  dist: 12,
  tx: 0,
  ty: 0,
  tz: 0,
  R: 1.8,
};
/** When each role arrives in the second state, in seconds; its label follows. */
export const ROLE_AT = { planner: 0.4, workers: 2.5, reviewers: 4.2 } as const;
/** Each role's art fades in over half a second, a little before its label. */
const ARRIVE = { planner: 0, workers: 2.2, reviewers: 3.9 } as const;

/** The Planner's page starts as the letters leave, and plays once. */
const PLANNER_START = 0.35;

/** The welcome's second state, `t` seconds after the prompt was sent; a still frame shows it finished. */
export function drawWelcome(
  ctx: CanvasRenderingContext2D,
  t: number,
  prompt: string,
  style: TextStyle,
  P: Palette,
  still = false,
) {
  const shown = {
    planner: clamp(t / 0.35),
    workers: clamp((t - ARRIVE.workers) / 0.5),
    reviewers: clamp((t - ARRIVE.reviewers) / 0.5),
  };
  const p = still ? PLANNER_REST : Math.max(0, t - PLANNER_START);
  roleFloor(ctx, ROLE_X.planner, shown.planner, P);
  roleFloor(ctx, ROLE_X.workers, shown.workers, P);
  roleFloor(ctx, ROLE_X.reviewers, shown.reviewers, P);
  standing(ctx, planner(p, t), CAM_O, shown.planner, P);
  standing(ctx, workers(t), CAM_C, shown.workers, P);
  standing(ctx, judges(Math.max(0, t - ROLE_AT.reviewers)), CAM_J, shown.reviewers, P);
  streamText(ctx, prompt, t, style, P);
}

/**
 * The Planner and its floor, cut out of the welcome stage: where it sits there, in CSS pixels,
 * with room for the pen above the page and the floor's faded edges (tests/conformance/onboarding.test.ts).
 */
export const PLANNER_VIEW = { x: 44, y: 92, width: 176, height: 168 } as const;

/**
 * The Planner on its own, `t` seconds after it appeared: its floor fades in, the pen writes the
 * page once, and then the page floats where it is. A still frame shows the page finished.
 * Drawn in the welcome stage's coordinates; the caller crops it to `PLANNER_VIEW`.
 */
export function drawPlanner(ctx: CanvasRenderingContext2D, t: number, P: Palette, still = false) {
  const shown = still ? 1 : clamp(t / 0.35);
  const p = still ? PLANNER_REST : Math.max(0, t - PLANNER_START);
  roleFloor(ctx, ROLE_X.planner, shown, P);
  standing(ctx, planner(p, still ? 0 : t), CAM_O, shown, P);
}

/** Values that follow a state glide instead of jumping; a still frame (tg 0) takes the target. */
const memo = new Map<string, { v: number; t: number }>();
function approach(key: string, target: number, tg: number): number {
  const m = memo.get(key);
  // A still frame, or a clock that went back, takes the target at once.
  const jumps = tg <= 0 || (m !== undefined && tg < m.t);
  if (!m || jumps) {
    memo.set(key, { v: target, t: tg });
    return target;
  }
  m.v += (target - m.v) * (1 - Math.exp(-Math.min(0.1, tg - m.t) * 7));
  m.t = tg;
  return m.v;
}

/** How a subscription's mark looks: waiting, signing in, connected, or its app missing. */
export const MarkState = { Idle: "idle", Busy: "busy", On: "on", Missing: "missing" } as const;
export type MarkState = (typeof MarkState)[keyof typeof MarkState];
/** Whose mark it is. */
export const Provider = { Claude: "claude", Codex: "codex" } as const;
export type Provider = (typeof Provider)[keyof typeof Provider];
/** Both marks, left to right. */
export const MARK_PROVIDERS: readonly Provider[] = [Provider.Claude, Provider.Codex];
/** The metered providers' marks, each alone on its own screen. */
export const MeteredMark = { OpenRouter: "openrouter", OpenCode: "opencode" } as const;
export type MeteredMark = (typeof MeteredMark)[keyof typeof MeteredMark];
const METERED_MARKS: Record<MeteredMark, ProviderMark> = {
  [MeteredMark.OpenRouter]: OPENROUTER_MARK,
  [MeteredMark.OpenCode]: OPENCODE_MARK,
};

const MARK_CAM: Camera = { yaw: 0, pitch: 0.32, scale: 44, cx: 320, cy: 100, dist: 16, tx: 0, ty: 1.3, tz: 0, R: 2.5 };
/** The mark's thickness, in units of its 24-unit grid. */
const DEPTH = 3.2;
const paths = new Map<string, Path2D>();
const markPath = (mark: ProviderMark) => {
  const known = paths.get(mark.path);
  if (known) return known;
  const path = new Path2D(mark.path);
  paths.set(mark.path, path);
  return path;
};

type Affine = [number, number, number, number, number, number];

/** One mark in one frame: its state and glide values, where it stands, and the maps from its 24-unit grid to the canvas. */
interface MarkFrame {
  ctx: CanvasRenderingContext2D;
  state: MarkState;
  tg: number;
  age: number;
  /** 0 for the left mark, 1 for the right: offsets its sway so the two never move together. */
  idx: number;
  P: Palette;
  lit: number;
  busy: number;
  /** The mark's centre in the scene, and projected onto the canvas. */
  c: Vec3;
  q: Vec3;
  /** One depth slice as a 2D affine map from the mark's grid (y down) to the canvas; +z is nearer. */
  at: (z: number) => Affine;
  path: Path2D;
  /** The mark's outline moved to one depth slice. */
  moved: (z: number) => Path2D;
  face: Rgb;
  deep: Rgb;
  /** The face's fill at alpha `k`: its one colour, or a gradient through the mark's colours. */
  faceFill: (k: number) => string | CanvasGradient;
}

function markFrame(
  ctx: CanvasRenderingContext2D,
  id: Provider | MeteredMark,
  mark: ProviderMark,
  state: MarkState,
  tg: number,
  age: number,
  x: number,
  P: Palette,
): MarkFrame {
  const idx = id === Provider.Claude ? 0 : 1;
  const lit = approach(`lit-${id}`, state === MarkState.On ? 1 : 0, tg);
  const busy = approach(`busy-${id}`, state === MarkState.Busy ? 1 : 0, tg);
  const pop = age >= 0 && age < 0.6 ? 1 + 0.14 * Math.sin((age / 0.6) * Math.PI) : 1;
  const c: Vec3 = [
    approach(`x-${id}`, (x - MARK_CAM.cx) / MARK_CAM.scale, tg),
    1.5 + 0.16 * lit + 0.06 * Math.sin(tg * 1.3 + idx * 2),
    0,
  ];
  const q = project(c, MARK_CAM);
  const u = (MARK_CAM.scale * (MARK_CAM.dist / (MARK_CAM.dist - q[2])) * 1.9 * pop) / 24;
  const yaw = 0.5 * Math.sin(tg * 0.55 + idx * 1.7);
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw),
    cp = Math.cos(MARK_CAM.pitch),
    sp = Math.sin(MARK_CAM.pitch);
  const at = (z: number): Affine => {
    const a = u * cy,
      b = -u * sp * sy,
      d = u * cp;
    return [a, b, 0, d, q[0] - 12 * a + u * sy * z, q[1] - 12 * b - 12 * d + u * sp * cy * z];
  };
  const path = markPath(mark);
  const moved = (z: number) => {
    const out = new Path2D();
    out.addPath(path, new DOMMatrix(at(z)));
    return out;
  };
  const brand = mark.colors.map(hex),
    face = brand[0]!,
    deep = brand[Math.floor(brand.length / 2)]!;
  const faceFill = (k: number) => {
    if (brand.length === 1) return rgba(face, k);
    const g = ctx.createLinearGradient(0, 0, 0, 24);
    brand.forEach((color, i) => g.addColorStop(i / (brand.length - 1), rgba(color, k)));
    return g;
  };
  return { ctx, state, tg, age, idx, P, lit, busy, c, q, at, path, moved, face, deep, faceFill };
}

/** The pad the mark hovers over, and its glow: the accent, or the mark's colour once connected. */
function markPad(f: MarkFrame) {
  const { c, q, lit, busy, P } = f;
  const pad = scene();
  const ringK = lerp(f.state === MarkState.Missing ? 0.2 : 0.4 + 0.2 * busy, 0.9, lit);
  pad.L.push(
    { c: lit > 0.5 ? 0 : 2, k: ringK, p: ringH(c[0], 0.05, 0, 0.8, 56) },
    { c: lit > 0.5 ? 0 : 2, k: ringK * 0.6, p: ringH(c[0], 0.05, 0, 0.55, 48) },
  );
  layer(
    f.ctx,
    null,
    pad,
    MARK_CAM,
    [[q[0], MARK_CAM.cy + 56, 80, 0.07 + 0.19 * lit, lit > 0.5 ? f.deep : P.accent]],
    P,
  );
}

/** An unconnected mark's face: the theme's own colour, else faint ink (the accent while signing in). */
function markFaceFill(P: Palette, busy: number, off: number): string {
  if (P.markFace) return rgba(P.markFace, off * (1 - busy));
  return rgba(busy > 0.5 ? P.accent : P.ink, off * (MARK_FACE_INK + 0.08 * busy));
}

/** Unlit: stacked outlines, back to front, a faint face, and a scan up and down it while signing in. */
function unlitMark(f: MarkFrame) {
  const { ctx, tg, busy, P, at, path } = f;
  const off = 1 - f.lit;
  if (!(off > 0.01)) return;
  const missing = f.state === MarkState.Missing;
  const pulse = 0.55 + 0.45 * Math.cos(tg * 4);
  const line = busy > 0.5 ? P.accent : P.ink;
  if (missing) ctx.setLineDash([2, 3]);
  const slices = 6,
    base = missing ? 0.35 : 1;
  for (let i = 0; i < slices; i++) {
    const front = i === slices - 1;
    ctx.strokeStyle = rgba(
      line,
      off * base * (front ? lerp(0.62, 0.9 * pulse, busy) : 0.08 + 0.18 * (i / (slices - 1))),
    );
    ctx.stroke(f.moved(-DEPTH / 2 + (DEPTH * i) / (slices - 1)));
  }
  ctx.setLineDash([]);
  ctx.save();
  ctx.transform(...at(DEPTH / 2));
  ctx.fillStyle = markFaceFill(P, busy, off);
  ctx.fill(path, "evenodd");
  if (P.markFace && busy > 0.01) {
    // A theme's own face fades out as the accent tint of signing in comes up.
    ctx.fillStyle = rgba(P.accent, off * (MARK_FACE_INK + 0.08) * busy);
    ctx.fill(path, "evenodd");
  }
  if (busy > 0.01) {
    // Signing in: a scan passes up and down the face.
    ctx.clip(path, "evenodd");
    const y = 12 + 11 * Math.sin(tg * 2.2);
    const g = ctx.createLinearGradient(0, y - 3, 0, y + 3);
    g.addColorStop(0, rgba(P.accent, 0));
    g.addColorStop(0.5, rgba(P.accent, 0.55 * busy * off));
    g.addColorStop(1, rgba(P.accent, 0));
    ctx.fillStyle = g;
    ctx.fillRect(-2, y - 3, 28, 6);
  }
  ctx.restore();
}

/** A sheen crossing the lit face: as it connects, and now and then after. */
function sheen(f: MarkFrame) {
  const { ctx, age, tg } = f;
  const sweep = age >= 0 && age < 1.2 ? age / 1.2 : ((tg + f.idx * 3.5) % 7) / 1.4;
  if (!(sweep < 1)) return;
  ctx.clip(f.path, "evenodd");
  const x = -8 + 40 * ease(sweep);
  const g = ctx.createLinearGradient(x - 5, 0, x + 5, 0);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.5, "rgba(255,255,255,0.38)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(-4, -4, 32, 32);
}

/** Lit: a solid extrusion in the mark's colour, darker towards the back, then its face. */
function litMark(f: MarkFrame) {
  const { ctx, lit, at, path } = f;
  if (!(lit > 0.01)) return;
  ctx.globalAlpha = lit;
  const slices = 16;
  for (let i = 0; i < slices; i++) {
    ctx.save();
    ctx.transform(...at(-DEPTH / 2 + (DEPTH * i) / slices));
    ctx.fillStyle = rgba(shade(f.deep, 0.32 + 0.3 * (i / slices)), 1);
    ctx.fill(path, "evenodd");
    ctx.restore();
  }
  ctx.save();
  ctx.transform(...at(DEPTH / 2));
  ctx.fillStyle = f.faceFill(1);
  ctx.fill(path, "evenodd");
  sheen(f);
  ctx.restore();
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 0.75;
  ctx.stroke(f.moved(DEPTH / 2));
  ctx.globalAlpha = 1;
}

/** The ring that bursts out of the mark in the moment it connects. */
function connectBurst(f: MarkFrame) {
  const { age, c } = f;
  if (!(age >= 0 && age < 0.9)) return;
  const burst = scene(),
    r = 1.0 + 0.9 * easeOut(age / 0.9),
    pts: Vec3[] = [];
  for (let b = 0; b <= 40; b++) {
    const an = (b / 40) * TAU;
    pts.push([c[0] + r * Math.cos(an), c[1] + r * Math.sin(an), 0]);
  }
  burst.L.push({ c: 1, k: 1 - age / 0.9, p: pts, flat: true });
  layer(f.ctx, null, burst, MARK_CAM, [], { ...f.P, ink: f.face });
}

/**
 * One extruded mark. Unlit it is a stack of outlines (muted, or accent while signing in, with a
 * scan passing over it; dashed when the app is missing). Connected it fills in: solid sides in
 * the mark's own colour, darker towards the back, its face in the mark's colours, lifted a little
 * and glowing; the moment it connects it pops, a ring bursts out and a sheen crosses the face.
 */
function drawMark(
  ctx: CanvasRenderingContext2D,
  id: Provider | MeteredMark,
  mark: ProviderMark,
  state: MarkState,
  tg: number,
  age: number,
  x: number,
  P: Palette,
) {
  const f = markFrame(ctx, id, mark, state, tg, age, x, P);
  markPad(f);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.lineJoin = "round";
  unlitMark(f);
  litMark(f);
  ctx.restore();
  connectBurst(f);
}

/**
 * Both marks, each centred over `x` (its button's centre on the canvas, in pixels); `ages` is how
 * long ago each one connected (negative: not in this visit).
 */
export function drawMarks(
  ctx: CanvasRenderingContext2D,
  states: Record<Provider, MarkState>,
  tg: number,
  ages: Record<Provider, number>,
  x: Record<Provider, number>,
  P: Palette,
) {
  drawMark(ctx, Provider.Claude, CLAUDE_CODE_MARK, states.claude, tg, ages.claude, x.claude, P);
  drawMark(ctx, Provider.Codex, CODEX_MARK, states.codex, tg, ages.codex, x.codex, P);
}

/**
 * One metered provider's mark, alone in the middle of the marks' canvas; `age` is how long ago it
 * connected (negative: not in this visit).
 */
export function drawMeteredMark(
  ctx: CanvasRenderingContext2D,
  id: MeteredMark,
  state: MarkState,
  tg: number,
  age: number,
  P: Palette,
) {
  drawMark(ctx, id, METERED_MARKS[id], state, tg, age, MARKS.width / 2, P);
}

/** What the local model's chip shows: waiting, downloading, or the model ready. */
export const ChipState = { Idle: "idle", Downloading: "downloading", Ready: "ready" } as const;
export type ChipState = (typeof ChipState)[keyof typeof ChipState];

/** The chip's size: half its body's width, its body's thickness, and half its die's width. */
const CHIP_BODY = { H: 1.25, T: 0.14, D: 0.5 } as const;

/** One frame of the chip. */
interface ChipFrame {
  S: Scene;
  tg: number;
  busy: boolean;
  ready: boolean;
  /** How far the ready cube has glided in (0 to 1). */
  done: number;
  /** How many of the 24 pins are lit. */
  lit: number;
  breathe: number;
}

/** Pins lit: all once ready, the download's share of them while it runs, none while waiting. */
function litPins(busy: boolean, ready: boolean, progress: number): number {
  if (ready) return 24;
  if (busy) return Math.round((progress / 100) * 24);
  return 0;
}

/** The die's outline: its tone and strength, breathing while it waits or downloads. */
function dieOutline(f: ChipFrame): { c: Tone; k: number } {
  if (f.busy) return { c: 0, k: 0.85 + 0.15 * f.breathe };
  if (f.ready) return { c: 0, k: 0.95 };
  return { c: 2, k: 0.55 + 0.3 * f.breathe };
}

/** How brightly the floor glows under the chip. */
function chipGlow(busy: boolean, ready: boolean): number {
  if (ready) return 0.24;
  if (busy) return 0.16;
  return 0.1;
}

/**
 * Where data runs along trace `k`: in along lit traces while downloading, out along all of them
 * once ready, and along a few of them while the chip waits. `u` is the packet's position (-1: none).
 */
function traceFlow(f: ChipFrame, k: number, on: boolean): { u: number; kk: number } {
  const phase = rnd(k + 500);
  if (f.busy && on) return { u: 1 - ((f.tg * 0.9 + phase) % 1), kk: 0.9 };
  if (f.ready) return { u: (f.tg * 0.45 + phase) % 1, kk: 0.7 };
  if (!f.busy && k % 4 === 1) return { u: (f.tg * 0.3 + phase) % 1, kk: 0.6 };
  return { u: -1, kk: 0.9 };
}

/** The chip's four sides, as maps from a pin's place along its side and out from the middle to the scene. */
const PIN_SIDES: ReadonlyArray<(a: number, b: number, y: number) => Vec3> = [
  (a, b, y) => [a, y, -b],
  (a, b, y) => [b, y, a],
  (a, b, y) => [-a, y, b],
  (a, b, y) => [-b, y, -a],
];

/** Pin `j` of its side (`k` of all 24): the pin, its trace to the die, and any data running along it. */
function chipPin(f: ChipFrame, at: (a: number, b: number, y: number) => Vec3, j: number, k: number) {
  const { S } = f;
  const { H, D } = CHIP_BODY;
  const top = CHIP_BODY.T + 0.001;
  const s = (-1 + ((j + 0.5) / 6) * 2) * 0.95,
    t = s * 0.42,
    bend = D + 0.16,
    on = k < f.lit;
  S.L.push({ c: on ? 0 : 2, k: on ? 1 : 0.5, p: [at(s, H, 0.03), at(s, H + 0.26, 0.03)] });
  const trace = [at(t, D, top), at(t, bend, top), at(s, bend + Math.abs(s - t), top), at(s, H, top)];
  S.L.push({ c: on ? 0 : 2, k: on ? 0.55 : 0.3, p: trace });
  const { u, kk } = traceFlow(f, k, on);
  if (!(u >= 0)) return;
  const pulse = subPath(trace, u - 0.14, u);
  if (pulse.length > 1) S.L.push({ c: 0, k: kk, p: pulse });
}

/** Six pins a side, each joined to the die by a trace that leaves straight and bends 45°. */
function chipPins(f: ChipFrame) {
  let k = 0;
  for (const at of PIN_SIDES) for (let j = 0; j < 6; j++, k++) chipPin(f, at, j, k);
}

/** The model over the die: its height, half-size, and how far it has turned. */
interface ModelPlace {
  cy: number;
  h: number;
  spin: number;
}

/** A dashed ghost of the model, waiting (`ghost` is how much of it shows). */
function ghostModel(S: Scene, { cy, h, spin }: ModelPlace, ghost: number) {
  for (const [a, b] of boxEdges(boxPts(0, cy, 0, h, h, h, spin))) {
    for (let i = 0; i < 5; i += 2)
      S.L.push({ c: 2, k: 0.55 * ghost, p: [lerp3(a, b, i / 5), lerp3(a, b, (i + 1) / 5)] });
  }
}

/** The model built up a layer per eighth of the download, with bits pouring into the die. */
function buildingModel(S: Scene, { cy, h, spin }: ModelPlace, tg: number, progress: number) {
  const layers = Math.floor(progress / 12.5);
  for (let i = 0; i < layers; i++) {
    const newest = i === layers - 1;
    square(S, newest ? 1 : 0, newest ? 1 : 0.5, 0, cy - h + (i + 0.5) * ((2 * h) / 8), 0, h, h, spin);
  }
  for (let i = 0; i < 16; i++) {
    const p = (tg * 0.7 + rnd(i + 600)) % 1;
    S.D.push({
      c: 0,
      a: 0.9 * (1 - p * p),
      p: [(rnd(i + 620) - 0.5) * 0.5, 2.4 - p * 2.15, (rnd(i + 640) - 0.5) * 0.5],
      r: 1.1,
    });
  }
}

/** The model: a dashed ghost while it waits, built up in layers while it downloads, solid once ready. */
function chipModel(f: ChipFrame, progress: number) {
  const { S, tg, busy, done } = f;
  const place: ModelPlace = { cy: 1.05, h: 0.36, spin: tg * 0.5 };
  const { cy, h, spin } = place;
  const ghost = busy ? 0 : 1 - done;
  if (ghost > 0.01) ghostModel(S, place, ghost);
  if (busy) buildingModel(S, place, tg, progress);
  if (done > 0.01) {
    box(S, 1, 0.95 * done, boxPts(0, cy + 0.08 * Math.sin(tg * 1.3), 0, h, h, h, spin), 0, 0.14 * done);
    S.L.push({
      c: 0,
      k: 0.6 * done,
      p: [
        [0, CHIP_BODY.T + 0.08, 0],
        [0, cy - h, 0],
      ],
    });
  }
}

/**
 * A chip on a fading floor, turning a little. Idle, data runs out along a few of its traces, a scan
 * passes over it and a ghost of the model turns above the die, waiting. Downloading, bits pour
 * into the die, pins and traces light one by one with data flowing in, and the model is built up
 * layer by layer inside the ghost. Ready, the model is a solid cube over a fully lit chip.
 */
export function drawChip(ctx: CanvasRenderingContext2D, state: ChipState, progress: number, tg: number, P: Palette) {
  const cam: Camera = {
    yaw: 0.62 + 0.22 * Math.sin(tg * 0.35),
    pitch: 0.55,
    scale: 56,
    cx: 200,
    cy: 112,
    dist: 18,
    tx: 0,
    ty: 0.5,
    tz: 0,
    R: 2.4,
  };
  const G = scene(),
    S = scene();
  floor(G, 0, 0, 4, 4, 0.5, 3.4, 0.45);
  const busy = state === ChipState.Downloading,
    ready = state === ChipState.Ready;
  const f: ChipFrame = {
    S,
    tg,
    busy,
    ready,
    done: approach("chip-ready", ready ? 1 : 0, tg),
    lit: litPins(busy, ready, progress),
    breathe: 0.5 + 0.5 * Math.sin(tg * 2),
  };
  const { H, T, D } = CHIP_BODY;
  const top = T + 0.001;
  box(S, 2, 0.75, boxPts(0, T / 2, 0, H, T / 2, H, 0), 0, 0.05);
  const die = dieOutline(f);
  box(
    S,
    die.c,
    die.k,
    boxPts(0, T + 0.04, 0, D, 0.04, D, 0),
    0,
    busy ? 0.1 + 0.06 * Math.sin(tg * 6) : 0.06 + 0.1 * f.done,
  );
  chipPins(f);
  if (!busy && !ready) {
    const v = (tg * 0.22) % 1,
      z = -H + 2 * H * v;
    S.L.push({
      c: 0,
      k: 0.45 * Math.sin(v * Math.PI),
      p: [
        [-H, top, z],
        [H, top, z],
      ],
    });
  }
  chipModel(f, progress);
  layer(ctx, G, S, cam, [[200, 128, 150, chipGlow(busy, ready)]], P);
}
