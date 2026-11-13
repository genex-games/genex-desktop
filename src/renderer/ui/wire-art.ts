/**
 * Empty-state wireframes: small 3D line scenes drawn on a 160×116 2D canvas. Strokes fade with
 * depth in six alpha buckets per colour, so a scene costs a handful of canvas paths per frame.
 * Geometry lives in world units; each scene brings its own camera. The idea's computer is opaque
 * and has its own module (`wire-computer.ts`). The Design tab's page (`wire-design.ts`) arrives
 * with that tab's own chunk and adds itself here (`addWireScene`), so the main bundle never carries it.
 */
import { computerYaw, drawComputer } from "./wire-computer.ts";

/** The scene an empty state draws; the value is also its canvas's data-wire. */
export const WireKind = {
  Idea: "idea",
  Building: "building",
  Assets: "assets",
  Harness: "harness",
  Stopped: "stopped",
  Design: "design",
} as const;
export type WireKind = (typeof WireKind)[keyof typeof WireKind];
export type Vec3 = [number, number, number];
type Vec2 = [number, number];
/** Colour slot: 0 accent, 1 ink (the moving part), 2 muted ink. `k` scales the stroke alpha. */
export type Line = { c: 0 | 1 | 2; k: number; p: Vec3[] };
export type Rgb = [number, number, number];
export interface WireColors {
  accent: Rgb;
  ink: Rgb;
  muted: Rgb;
  fill: Rgb;
  /** What the art stands on: the opaque computer's faces are painted in it. */
  page: Rgb;
}
/** How a scene is looked at: where its origin lands in the art, how large, and the depth its lines fade over (`R`). */
export interface Camera {
  yaw: number;
  pitch: number;
  scale: number;
  cx: number;
  cy: number;
  dist: number;
  tx?: number;
  ty?: number;
  tz?: number;
  y0: number;
  R: number;
}

export const WIDTH = 160;
export const HEIGHT = 116;
/** The idea → building hand-off, in seconds. */
export const HANDOFF = 1.4;
/** The idea's turn, as the computer's yaw at `t` seconds (`wire-computer.ts`). */
export const ideaSpin = computerYaw;
/** One still frame per scene under Reduce Motion. */
export const STILL: Record<WireKind, number> = {
  [WireKind.Idea]: 0,
  [WireKind.Building]: 6.3,
  [WireKind.Assets]: 6.3,
  [WireKind.Harness]: 6.3,
  [WireKind.Stopped]: 0,
  [WireKind.Design]: 0,
};

/** One moment of a scene added from outside this module: its lines, the face tinted under them, its fade and its camera. */
export interface WireScene {
  lines: Line[];
  face: Vec3[];
  fade: number;
  cam: Camera;
}
/** Scenes a lazily loaded panel brought with it, by kind. */
const addedScenes = new Map<WireKind, (t: number) => WireScene>();
/** Add a scene this module does not carry, with its still frame for Reduce Motion. */
export function addWireScene(kind: WireKind, scene: (t: number) => WireScene, still: number): void {
  addedScenes.set(kind, scene);
  STILL[kind] = still;
}

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
const easeOut = (x: number) => 1 - (1 - x) ** 3;
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

function bez(c: Vec2[], t: number): Vec2 {
  const u = 1 - t,
    a = u * u * u,
    b = 3 * u * u * t,
    d = 3 * u * t * t,
    e = t * t * t;
  return [a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0], a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1]];
}

/** A surface of revolution: meridians along the profile plus rings at chosen curve positions. */
function revolve(L: Line[], segs: Vec2[][], meridians: number, samples: number, ringTs: number[]) {
  const profile: Vec2[] = [];
  for (const s of segs) for (let i = 0; i <= samples; i++) profile.push(bez(s, i / samples));
  for (let m = 0; m < meridians; m++) {
    const a = (m / meridians) * Math.PI * 2,
      ca = Math.cos(a),
      sa = Math.sin(a);
    L.push({ c: 0, k: 1, p: profile.map((q) => [q[0] * ca, q[1], q[0] * sa]) });
  }
  for (const s of segs)
    for (const t of ringTs) {
      const q = bez(s, t),
        ring: Vec3[] = [];
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        ring.push([q[0] * Math.cos(a), q[1], q[0] * Math.sin(a)]);
      }
      L.push({ c: 0, k: 1, p: ring });
    }
}

/** A tube between two Bézier rails (spout, handle), tapering from w0 to w1. */
function tube(L: Line[], inner: Vec2[][], outer: Vec2[][], w0: number, w1: number, rings: number, lines: number) {
  const at = (t: number) => {
    const segs = inner.length,
      x = Math.min(segs - 1e-6, t * segs),
      i = Math.floor(x),
      f = x - i;
    const a = bez(inner[i], f),
      b = bez(outer[i], f),
      m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return { m, v: [b[0] - m[0], b[1] - m[1]] as Vec2, w: w0 + (w1 - w0) * t };
  };
  const pt = (s: ReturnType<typeof at>, phi: number): Vec3 => [
    s.m[0] + s.v[0] * Math.cos(phi),
    s.m[1] + s.v[1] * Math.cos(phi),
    s.w * Math.sin(phi),
  ];
  for (let r = 0; r <= rings; r++) {
    const s = at(r / rings),
      ring: Vec3[] = [];
    for (let i = 0; i <= 16; i++) ring.push(pt(s, (i / 16) * Math.PI * 2));
    L.push({ c: 0, k: 1, p: ring });
  }
  for (let j = 0; j < lines; j++) {
    const phi = (j / lines) * Math.PI * 2,
      line: Vec3[] = [];
    for (let i = 0; i <= 24; i++) line.push(pt(at(i / 24), phi));
    L.push({ c: 0, k: 1, p: line });
  }
}

/** The Utah teapot's original Bézier profile: body, lid, spout rails and handle rails. */
const TEAPOT_BODY: Vec2[][] = [
  [
    [1.4, 2.4],
    [1.3375, 2.53125],
    [1.4375, 2.53125],
    [1.5, 2.4],
  ],
  [
    [1.5, 2.4],
    [1.75, 1.875],
    [2, 1.35],
    [2, 0.9],
  ],
  [
    [2, 0.9],
    [2, 0.45],
    [1.5, 0.225],
    [1.5, 0.15],
  ],
];
const TEAPOT_LID: Vec2[][] = [
  [
    [0, 3.15],
    [0.8, 3.15],
    [0, 2.85],
    [0.2, 2.7],
  ],
  [
    [0.2, 2.7],
    [0.4, 2.55],
    [1.3, 2.55],
    [1.3, 2.4],
  ],
];
const SPOUT_INNER: Vec2[][] = [
  [
    [1.7, 0.45],
    [3.1, 0.675],
    [2.4, 1.875],
    [3.3, 2.25],
  ],
];
const SPOUT_OUTER: Vec2[][] = [
  [
    [1.7, 1.275],
    [2.6, 1.275],
    [2.3, 1.95],
    [2.7, 2.25],
  ],
];
const HANDLE_INNER: Vec2[][] = [
  [
    [-1.6, 1.875],
    [-2.3, 1.875],
    [-2.7, 1.875],
    [-2.7, 1.65],
  ],
  [
    [-2.7, 1.65],
    [-2.7, 1.425],
    [-2.5, 0.975],
    [-2, 0.75],
  ],
];
const HANDLE_OUTER: Vec2[][] = [
  [
    [-1.5, 2.1],
    [-2.5, 2.1],
    [-3, 2.1],
    [-3, 1.65],
  ],
  [
    [-3, 1.65],
    [-3, 1.2],
    [-2.65, 0.7875],
    [-1.9, 0.45],
  ],
];

let teapotLines: Line[] | null = null;
/** The Utah teapot from its original Bézier profile: body, lid, base ring, spout and handle. */
function teapot(): Line[] {
  if (teapotLines) return teapotLines;
  const L: Line[] = [];
  revolve(L, TEAPOT_BODY, 20, 8, [0, 0.5]);
  revolve(L, TEAPOT_LID, 20, 8, [0.5, 1]);
  const base: Vec3[] = [];
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    base.push([1.5 * Math.cos(a), 0.15, 1.5 * Math.sin(a)]);
  }
  L.push({ c: 0, k: 1, p: base });
  tube(L, SPOUT_INNER, SPOUT_OUTER, 0.62, 0.24, 6, 6);
  tube(L, HANDLE_INNER, HANDLE_OUTER, 0.3, 0.3, 10, 6);
  teapotLines = L;
  return L;
}

function box(
  L: Line[],
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
  rot: number,
  c: Line["c"],
  k: number,
) {
  const co = Math.cos(rot),
    si = Math.sin(rot);
  const P = (x: number, y: number, z: number): Vec3 => [cx + x * co + z * si, cy + y, cz - x * si + z * co];
  const bot = [P(-hx, -hy, -hz), P(hx, -hy, -hz), P(hx, -hy, hz), P(-hx, -hy, hz)];
  const top = [P(-hx, hy, -hz), P(hx, hy, -hz), P(hx, hy, hz), P(-hx, hy, hz)];
  L.push({ c, k, p: [...bot, bot[0]] }, { c, k, p: [...top, top[0]] });
  for (let i = 0; i < 4; i++) L.push({ c, k, p: [bot[i], top[i]] });
}

/** The stopped game: an upright square plate, the stop sign as a slab, with its face inset. */
function stopPlate(): Line[] {
  if (stopPlateLines) return stopPlateLines;
  const L: Line[] = [];
  box(L, 0, 1.3, 0, 1.15, 1.15, 0.2, 0, 0, 1);
  const face: Vec3[] = [-0.72, 0.72].flatMap((x, i) =>
    (i ? [0.72, -0.72] : [-0.72, 0.72]).map((y): Vec3 => [x, 1.3 + y, 0.21]),
  );
  L.push({ c: 1, k: 0.85, p: [...face, face[0]] });
  stopPlateLines = L;
  return L;
}
let stopPlateLines: Line[] | null = null;

/** Where the crane picks up: its pallet. */
const PICK_ANGLE = -0.95;
/** Where the crane stacks: the jib's angle and the trolley's reach at each end of the slew. */
const DROP_ANGLE = 0.55;
const PICK_REACH = 3.0;
const DROP_REACH = 4.3;
/** The crane's loop, in seconds. */
const CRANE_LOOP = 12;
/** The mast: its height, half its width and the height of one lacing level (world units). */
const MAST_HEIGHT = 5.2;
const MAST_HALF = 0.28;
const LEVEL_STEP = 0.65;
/** The hook's heights: travelling, at the pallet, and over the stack. */
const HOOK_HIGH = MAST_HEIGHT - 1.6;
const HOOK_AT_PICK = 0.95;
const HOOK_AT_DROP = 2.55;
/** The jib: half its depth, the top chord's rise at the mast, and its length. */
const JIB_HALF = 0.22;
const JIB_RISE = 0.42;
const JIB_END = 5.6;

const MAST_CORNERS: Vec2[] = [
  [-MAST_HALF, -MAST_HALF],
  [MAST_HALF, -MAST_HALF],
  [MAST_HALF, MAST_HALF],
  [-MAST_HALF, MAST_HALF],
];
const mastRing = (y: number): Vec3[] => [...MAST_CORNERS, MAST_CORNERS[0]].map((q) => [q[0], y, q[1]]);
/** The jib's top chord height at x: it slopes from the mast down to the tip. */
const chordAt = (x: number) => MAST_HEIGHT + JIB_RISE + (0.12 - JIB_RISE) * ((x - MAST_HALF) / (JIB_END - MAST_HALF));

/** A point turned about the mast by angle a. */
function turn(p: Vec3, a: number): Vec3 {
  const co = Math.cos(a),
    si = Math.sin(a);
  return [p[0] * co + p[2] * si, p[1], -p[0] * si + p[2] * co];
}

/** Adds one line to the scene, turned with the jib when `rot` is given. */
type AddLine = (pts: Vec3[], c: Line["c"], k: number, rot?: number) => void;
const lineAdder =
  (L: Line[]): AddLine =>
  (pts, c, k, rot) =>
    L.push({ c, k, p: rot === undefined ? pts : pts.map((q) => turn(q, rot)) });

/** Where the jib points, how far out the trolley is, how high the hook hangs, and whether it carries a block. */
interface CranePose {
  th: number;
  tx: number;
  hy: number;
  attached: boolean;
}
const atPick = (hy: number, attached: boolean): CranePose => ({ th: PICK_ANGLE, tx: PICK_REACH, hy, attached });
const atDrop = (hy: number, attached: boolean): CranePose => ({ th: DROP_ANGLE, tx: DROP_REACH, hy, attached });
/** Part way (k) through a slew between the pallet and the stack, hook high. */
function slewing(k: number, toDrop: boolean, attached: boolean): CranePose {
  const [fromTh, toTh] = toDrop ? [PICK_ANGLE, DROP_ANGLE] : [DROP_ANGLE, PICK_ANGLE];
  const [fromTx, toTx] = toDrop ? [PICK_REACH, DROP_REACH] : [DROP_REACH, PICK_REACH];
  return { th: lerp(fromTh, toTh, k), tx: lerp(fromTx, toTx, k), hy: HOOK_HIGH, attached };
}

/** The crane's pose u seconds into its loop: lower, lift, slew, lower, release, raise, slew back. */
function cranePose(u: number): CranePose {
  if (u < 1.4) return atPick(lerp(HOOK_HIGH, HOOK_AT_PICK, ease(u / 1.4)), false);
  if (u < 1.8) return atPick(HOOK_AT_PICK, true);
  if (u < 3.2) return atPick(lerp(HOOK_AT_PICK, HOOK_HIGH, ease((u - 1.8) / 1.4)), true);
  if (u < 5.6) return slewing(ease((u - 3.2) / 2.4), true, true);
  if (u < 7.0) return atDrop(lerp(HOOK_HIGH, HOOK_AT_DROP, ease((u - 5.6) / 1.4)), true);
  if (u < 7.4) return atDrop(HOOK_AT_DROP, false);
  if (u < 8.6) return atDrop(lerp(HOOK_AT_DROP, HOOK_HIGH, ease((u - 7.4) / 1.2)), false);
  if (u < 11.0) return slewing(ease((u - 8.6) / 2.4), false, false);
  return atPick(HOOK_HIGH, false);
}

/** Mast: four legs, a ring every level and alternating lacing, on a base pad. */
function craneMast(add: AddLine) {
  const H = MAST_HEIGHT;
  for (const q of MAST_CORNERS)
    add(
      [
        [q[0], 0, q[1]],
        [q[0], H, q[1]],
      ],
      0,
      0.9,
    );
  const levels = Math.round(H / LEVEL_STEP);
  for (let i = 0; i <= levels; i++) add(mastRing(i * LEVEL_STEP), 0, 0.55);
  for (let i = 0; i < levels; i++) {
    const y0 = i * LEVEL_STEP,
      y1 = y0 + LEVEL_STEP;
    MAST_CORNERS.forEach((a, j) => {
      const b = MAST_CORNERS[(j + 1) % 4];
      const rising: Vec3[] = [
        [a[0], y0, a[1]],
        [b[0], y1, b[1]],
      ];
      const falling: Vec3[] = [
        [b[0], y0, b[1]],
        [a[0], y1, a[1]],
      ];
      add(i % 2 ? rising : falling, 0, 0.45);
    });
  }
  add(
    [
      [-0.7, 0.02, -0.7],
      [0.7, 0.02, -0.7],
      [0.7, 0.02, 0.7],
      [-0.7, 0.02, 0.7],
      [-0.7, 0.02, -0.7],
    ],
    2,
    0.8,
  );
}

/** Jib: two bottom chords, the sloping top chord and its lacing, all turned to th. */
function craneJib(add: AddLine, th: number) {
  const H = MAST_HEIGHT,
    s = MAST_HALF,
    jz = JIB_HALF;
  add(
    [
      [s, H, -jz],
      [JIB_END, H, -jz],
    ],
    0,
    1,
    th,
  );
  add(
    [
      [s, H, jz],
      [JIB_END, H, jz],
    ],
    0,
    1,
    th,
  );
  add(
    [
      [s, H + JIB_RISE, 0],
      [JIB_END, H + 0.12, 0],
    ],
    0,
    1,
    th,
  );
  for (let x = s; x <= JIB_END + 1e-6; x += 0.55)
    add(
      [
        [x, H, -jz],
        [x, chordAt(x), 0],
        [x, H, jz],
      ],
      0,
      0.7,
      th,
    );
}

/** Counter-jib, the slewing ring, the counterweight and the apex ties. */
function craneCounterJib(add: AddLine, th: number) {
  const H = MAST_HEIGHT,
    s = MAST_HALF,
    jz = JIB_HALF;
  add(
    [
      [-s, H, -jz],
      [-2.4, H, -jz],
    ],
    0,
    1,
    th,
  );
  add(
    [
      [-s, H, jz],
      [-2.4, H, jz],
    ],
    0,
    1,
    th,
  );
  for (let x = -s; x >= -2.4 - 1e-6; x -= 0.6)
    add(
      [
        [x, H, -jz],
        [x, H, jz],
      ],
      0,
      0.6,
      th,
    );
  add(mastRing(H), 0, 0.8, th);
  const weight: Line[] = [];
  box(weight, -2.1, H - 0.28, 0, 0.3, 0.28, 0.3, 0, 0, 0.9);
  for (const line of weight) add(line.p, 0, 0.9, th);
  const apex: Vec3 = [0, H + 1.4, 0];
  for (const q of MAST_CORNERS) add([[q[0], H, q[1]], apex], 0, 0.8, th);
  add([apex, [3.6, chordAt(3.6), 0]], 2, 0.9, th);
  add([apex, [-2.3, H, 0]], 2, 0.9, th);
}

/** Trolley, cables and hook: the moving part, in ink. */
function craneHook(add: AddLine, { th, tx, hy }: CranePose) {
  const H = MAST_HEIGHT;
  const trolley: Line[] = [];
  box(trolley, tx, H - 0.08, 0, 0.18, 0.08, 0.2, 0, 0, 1);
  for (const line of trolley) add(line.p, 0, 1, th);
  add(
    [
      [tx, H - 0.16, -0.06],
      [tx, hy + 0.1, -0.06],
    ],
    2,
    0.9,
    th,
  );
  add(
    [
      [tx, H - 0.16, 0.06],
      [tx, hy + 0.1, 0.06],
    ],
    2,
    0.9,
    th,
  );
  const hook: Line[] = [];
  box(hook, tx, hy, 0, 0.1, 0.1, 0.1, 0, 1, 1);
  for (const line of hook) add(line.p, 1, 1, th);
}

/** The block on the hook and its four slings. */
function craneLoad(add: AddLine, { th, tx, hy }: CranePose) {
  const load: Line[] = [];
  box(load, tx, hy - 0.55, 0, 0.4, 0.4, 0.4, 0, 1, 1);
  for (const line of load) add(line.p, 1, 1, th);
  for (const q of [
    [-0.4, -0.4],
    [0.4, -0.4],
    [0.4, 0.4],
    [-0.4, 0.4],
  ] as Vec2[])
    add(
      [
        [tx, hy - 0.1, 0],
        [tx + q[0], hy - 0.15, q[1]],
      ],
      2,
      0.8,
      th,
    );
}

/** How visible the block just stacked (fading as the next one comes) and the fresh block on the pallet are. */
function blockFades(u: number): { placed: number; fresh: number } {
  let placed = 0,
    fresh = 0;
  if (u >= 7.0 && u < 8.6) placed = 1;
  else if (u >= 8.6 && u < 11.0) placed = 1 - (u - 8.6) / 2.4;
  if (u < 1.4 || u >= 11.0) fresh = 1;
  else if (u >= 8.6) fresh = (u - 8.6) / 2.4;
  return { placed, fresh };
}

/**
 * A tower crane on one 12 s loop: the hook lowers, lifts the fresh block from the pallet, slews,
 * stacks it and returns. The first-launch welcome draws the same crane as its Workers.
 */
export function crane(t: number): Line[] {
  const L: Line[] = [];
  const add = lineAdder(L);
  const u = ((t % CRANE_LOOP) + CRANE_LOOP) % CRANE_LOOP;
  const pose = cranePose(u);
  craneMast(add);
  craneJib(add, pose.th);
  craneCounterJib(add, pose.th);
  craneHook(add, pose);
  const pB = turn([DROP_REACH, 0, 0], DROP_ANGLE),
    pA = turn([PICK_REACH, 0, 0], PICK_ANGLE);
  box(L, pB[0], 0.4, pB[2], 0.4, 0.4, 0.4, DROP_ANGLE, 0, 0.75);
  box(L, pB[0], 1.2, pB[2], 0.4, 0.4, 0.4, DROP_ANGLE, 0, 0.75);
  add(
    [
      [pA[0] - 0.55, 0.02, pA[2] - 0.55],
      [pA[0] + 0.55, 0.02, pA[2] - 0.55],
      [pA[0] + 0.55, 0.02, pA[2] + 0.55],
      [pA[0] - 0.55, 0.02, pA[2] + 0.55],
      [pA[0] - 0.55, 0.02, pA[2] - 0.55],
    ],
    2,
    0.7,
  );
  if (pose.attached) craneLoad(add, pose);
  const { placed, fresh } = blockFades(u);
  if (placed > 0.01) box(L, pB[0], 2.0, pB[2], 0.4, 0.4, 0.4, DROP_ANGLE, 1, placed);
  if (fresh > 0.01) box(L, pA[0], 0.4, pA[2], 0.4, 0.4, 0.4, PICK_ANGLE, 1, fresh);
  return L;
}

/** Sweeps a round tube of radius r (icon units) along a 2D icon polyline mapped into the world by W. */
function sweep(
  L: Line[],
  pts: Vec2[],
  W: (x: number, y: number, z: number) => Vec3,
  r: number,
  sc: number,
  c: Line["c"],
  k: number,
  lines: number,
) {
  if (pts.length < 2) return;
  const n = pts.length,
    frames: [Vec2, Vec2][] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)],
      b = pts[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0],
      dy = b[1] - a[1],
      len = Math.hypot(dx, dy) || 1;
    frames.push([pts[i], [-dy / len, dx / len]]);
  }
  const at = (f: [Vec2, Vec2], ph: number) =>
    W(f[0][0] + f[1][0] * r * Math.cos(ph), f[0][1] + f[1][1] * r * Math.cos(ph), r * sc * Math.sin(ph));
  frames.forEach((f, i) => {
    if (i % 2) return;
    const ring: Vec3[] = [];
    for (let j = 0; j <= 10; j++) ring.push(at(f, (j / 10) * Math.PI * 2));
    L.push({ c, k: k * 0.7, p: ring });
  });
  for (let j = 0; j < lines; j++) {
    const ph = (j / lines) * Math.PI * 2 + Math.PI / 4;
    L.push({ c, k, p: frames.map((f) => at(f, ph)) });
  }
}

const seg = (a: Vec2, b: Vec2, n: number): Vec2[] =>
  Array.from({ length: n + 1 }, (_, j) => [a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
/** One rounded scan-frame corner: a short straight, a quarter arc of radius 3, a short straight. */
function corner(start: Vec2, center: Vec2, from: number, end: Vec2): Vec2[] {
  const arc: Vec2[] = [];
  for (let i = 0; i <= 8; i++) {
    const a = from + (i / 8) * (Math.PI / 2);
    arc.push([center[0] + 3 * Math.cos(a), center[1] + 3 * Math.sin(a)]);
  }
  return [...seg(start, arc[0], 3), ...arc.slice(1), ...seg(arc[arc.length - 1], end, 3).slice(1)];
}
const FRAME: Vec2[][] = [
  corner([4, 8.5], [7, 7], Math.PI, [8.5, 4]),
  corner([15.5, 4], [17, 7], Math.PI * 1.5, [20, 8.5]),
  corner([20, 15.5], [17, 17], 0, [15.5, 20]),
  corner([8.5, 20], [7, 17], Math.PI * 0.5, [4, 15.5]),
];
const CODE: [Vec2, Vec2][] = [
  [
    [8.5, 9],
    [13, 9],
  ],
  [
    [10.5, 12],
    [15.5, 12],
  ],
  [
    [8.5, 15],
    [12, 15],
  ],
];
const DECODE_CYCLE = 4.5,
  SCAN = 1.1,
  SCAN_TOP = 7,
  SCAN_SPAN = 10;

/**
 * The Harness glyph (Decode) in 3D: the scan frame's corners in accent, three lines of code in ink.
 * Every 4.5 s a scan line sweeps down and each line writes itself back in from the left as it passes.
 */
function decode(t: number): Line[] {
  const L: Line[] = [],
    sc = 0.2,
    r = 0.45;
  const W = (x: number, y: number, z: number): Vec3 => [(x - 12) * sc, (21 - y) * sc + 0.3, z];
  const cyc = ((t % DECODE_CYCLE) + DECODE_CYCLE) % DECODE_CYCLE;
  for (const pts of FRAME) sweep(L, pts, W, r, sc, 0, 1, 4);
  for (const [a, b] of CODE) {
    const start = ((a[1] - SCAN_TOP) / SCAN_SPAN) * SCAN;
    const written = cyc < start ? 1 : easeOut(clamp((cyc - start) / 0.45));
    if (written < 0.02) continue;
    const end: Vec2 = [a[0] + (b[0] - a[0]) * written, a[1]];
    sweep(L, seg(a, end, 2), W, r, sc, 1, 1, 4);
  }
  const scan = cyc / SCAN;
  if (scan < 1) {
    const y = SCAN_TOP + SCAN_SPAN * scan,
      k = Math.min(clamp(scan / 0.1), clamp((1 - scan) / 0.1));
    if (k > 0.02) sweep(L, seg([6.5, y], [17.5, y], 2), W, 0.3, sc, 1, k, 3);
  }
  return L;
}

function project(p: Vec3, cam: Camera): Vec3 {
  const x = p[0] - (cam.tx ?? 0),
    y = p[1] - (cam.ty ?? 0) - cam.y0,
    z = p[2] - (cam.tz ?? 0);
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

const rgba = (c: Rgb, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;

/** Alpha buckets per colour: each is one canvas path per frame. */
const DEPTH_BUCKETS = 6;

/** Each projected segment as x0,y0,x1,y1 runs, sorted by colour and then by depth-scaled alpha. */
function bucketSegments(L: Line[], cam: Camera): number[][][] {
  const N = DEPTH_BUCKETS,
    buckets: number[][][] = [0, 1, 2].map(() => Array.from({ length: N }, () => []));
  for (const line of L) {
    if (!line.k) continue;
    let prev: Vec3 | null = null;
    for (const point of line.p) {
      const q = project(point, cam);
      if (prev) {
        const d = clamp(((prev[2] + q[2]) / 2 + cam.R) / (2 * cam.R));
        const bucket = Math.max(0, Math.min(N - 1, Math.floor((0.25 + 0.75 * d) * line.k * N)));
        buckets[line.c][bucket].push(prev[0], prev[1], q[0], q[1]);
      }
      prev = q;
    }
  }
  return buckets;
}

/** Nearer segments are brighter: 25–100% of each line's alpha, batched into six paths per colour. */
function strokeLines(ctx: CanvasRenderingContext2D, L: Line[], cam: Camera, colors: WireColors) {
  const N = DEPTH_BUCKETS;
  const tones = [colors.accent, colors.ink, colors.muted];
  bucketSegments(L, cam).forEach((byDepth, c) => {
    const ceiling = c === 2 ? 0.7 : 1;
    byDepth.forEach((b, i) => {
      if (!b.length) return;
      ctx.strokeStyle = rgba(tones[c], ((i + 0.5) / N) * ceiling);
      ctx.beginPath();
      for (let j = 0; j < b.length; j += 4) {
        ctx.moveTo(b[j], b[j + 1]);
        ctx.lineTo(b[j + 2], b[j + 3]);
      }
      ctx.stroke();
    });
  });
}

/** How strongly an added scene's face is tinted under its lines. */
const FACE_TINT = 0.07;

/** An added scene: its face tinted, then its lines. */
function drawScene(ctx: CanvasRenderingContext2D, scene: WireScene, colors: WireColors) {
  const { cam } = scene;
  ctx.fillStyle = rgba(colors.fill, FACE_TINT * scene.fade);
  ctx.beginPath();
  scene.face.forEach((point, i) => {
    const q = project(point, cam);
    if (i === 0) ctx.moveTo(q[0], q[1]);
    else ctx.lineTo(q[0], q[1]);
  });
  ctx.closePath();
  ctx.fill();
  strokeLines(ctx, scene.lines, cam, colors);
}

/** The crane's camera takes in the whole site. */
const CRANE_CAM: Camera = {
  yaw: 0.2,
  pitch: 0.3,
  scale: 10,
  cx: 52,
  cy: 80,
  dist: 40,
  tx: 0,
  ty: 0,
  tz: 0,
  y0: 0,
  R: 4.5,
};

/** What a canvas should show: one scene at time t, or the hand-off `s` seconds in (from the computer's yaw). */
export type WireFrame = { kind: WireKind; t: number } | { kind: "handoff"; s: number; spin: number };

export function drawWire(ctx: CanvasRenderingContext2D, frame: WireFrame, colors: WireColors, scale: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.lineWidth = 0.9;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (frame.kind === "handoff") return drawHandoff(ctx, frame.s, frame.spin, colors);
  const t = frame.t;
  if (frame.kind === WireKind.Idea)
    return drawComputer(ctx, { yaw: ideaSpin(t), t, boot: null, alpha: 1 }, colors, colors.page);
  if (frame.kind === WireKind.Building) return strokeLines(ctx, crane(t), CRANE_CAM, colors);
  const added = addedScenes.get(frame.kind);
  if (added) return drawScene(ctx, added(t), colors);
  if (frame.kind === WireKind.Stopped)
    return strokeLines(
      ctx,
      stopPlate(),
      { yaw: 0.55 + 0.12 * Math.sin(t * 0.5), pitch: 0.3, scale: 21, cx: 80, cy: 74, dist: 24, y0: 0, R: 1.4 },
      colors,
    );
  if (frame.kind === WireKind.Assets)
    return strokeLines(
      ctx,
      teapot(),
      { yaw: 0.6 + t * 0.35, pitch: 0.4, scale: 12.5, cx: 80, cy: 76, dist: 26, y0: 0, R: 3.2 },
      colors,
    );
  strokeLines(
    ctx,
    decode(t),
    {
      yaw: 0.45 * Math.sin(t * 0.5),
      pitch: 0.2,
      scale: 15,
      cx: 80,
      cy: 76,
      dist: 24,
      y0: -0.1 * Math.sin(t * 1.3),
      R: 1,
    },
    colors,
  );
}

/**
 * The idea's computer hands over to the crane: it turns to face you (0–0.6 s) as its screen boots
 * (0.15–0.9 s), then fades (0.8–1.2 s) while the crane rises out of the floor behind a scan line
 * (0.7–1.4 s).
 */
function drawHandoff(ctx: CanvasRenderingContext2D, s: number, spin0: number, colors: WireColors) {
  const front = Math.round(spin0 / (2 * Math.PI)) * 2 * Math.PI;
  const settle = ease(clamp(s / 0.6));
  const boot = s < 0.15 ? null : easeOut(clamp((s - 0.15) / 0.75));
  const rise = ease(clamp((s - 0.7) / 0.7));
  if (rise > 0) {
    const Y = 100 - 94 * rise;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, Y, WIDTH, HEIGHT - Y);
    ctx.clip();
    strokeLines(ctx, crane(0), CRANE_CAM, colors);
    ctx.restore();
    if (rise < 1) {
      ctx.strokeStyle = rgba(colors.accent, 0.45 * Math.sin(Math.PI * rise));
      ctx.beginPath();
      ctx.moveTo(34, Y);
      ctx.lineTo(126, Y);
      ctx.stroke();
    }
  }
  const pose = { yaw: lerp(spin0, front, settle), t: 0, boot, alpha: 1 - clamp((s - 0.8) / 0.4) };
  drawComputer(ctx, pose, colors, colors.page);
}
