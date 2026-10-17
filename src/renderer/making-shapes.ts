/**
 * The shapes an asset being made is drawn as (`making-art.ts` draws them): a body scan for a
 * character, the Utah teapot for a 3D model, cobblestones on a plane for a texture, and flat
 * marks with depth for an image, a video and a sound. Pure geometry in world units: solids are
 * line segments plus the faces their faint fill is cut from; marks are 2D outlines that the
 * frame extrudes.
 */

export type Vec3 = readonly [number, number, number];
export type Vec2 = readonly [number, number];
/** One line of a solid: its ends and how bright it is drawn (1 is full). */
export interface Segment {
  a: Vec3;
  b: Vec3;
  k: number;
}
/** A solid: its lines, and the faces whose union is its silhouette's fill. */
export interface Solid {
  segments: Segment[];
  faces: Vec3[][];
}
/**
 * One outline of a mark, in grid units with y up and the mark centred. Without `z` it is
 * extruded through every slice; with `z` it sits once, that far in front of the face. `face`
 * outlines make up the front face's fill (even-odd, so an inner outline is a hole).
 */
export interface MarkShape {
  points: Vec2[];
  face?: boolean;
  k?: number;
  z?: number;
}

const TAU = Math.PI * 2;
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const mix = (a: Vec3, b: Vec3, k: number): Vec3 => [
  a[0] + (b[0] - a[0]) * k,
  a[1] + (b[1] - a[1]) * k,
  a[2] + (b[2] - a[2]) * k,
];
/** A vector scaled to length one (a zero vector stays as it is). */
export function unit(a: Vec3): Vec3 {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
}

/** Lines through `points`, one per step, closed back to the first when asked. */
function link(out: Segment[], points: readonly Vec3[], closed: boolean, k: number): void {
  for (let i = 0; i + 1 < points.length; i++) out.push({ a: points[i], b: points[i + 1], k });
  if (closed && points.length > 2) out.push({ a: points[points.length - 1], b: points[0], k });
}

/** An ellipse of `n` points around `c` in the plane of `u` and `v`. */
function ellipse(c: Vec3, u: Vec3, v: Vec3, rx: number, ry: number, n: number): Vec3[] {
  return Array.from({ length: n }, (_, i) => {
    const angle = (i / n) * TAU;
    return add(c, add(mul(u, rx * Math.cos(angle)), mul(v, ry * Math.sin(angle))));
  });
}
const X: Vec3 = [1, 0, 0];
const Z: Vec3 = [0, 0, 1];
/** A level ellipse at height `y`. */
const level = (y: number, rx: number, rz: number, n: number, z = 0): Vec3[] => ellipse([0, y, z], X, Z, rx, rz, n);

/** The faces between neighbouring rings of equal size, and the two end caps. */
function bandFaces(faces: Vec3[][], rings: readonly Vec3[][]): void {
  for (let j = 0; j + 1 < rings.length; j++) {
    const n = rings[j].length;
    for (let s = 0; s < n; s++)
      faces.push([rings[j][s], rings[j][(s + 1) % n], rings[j + 1][(s + 1) % n], rings[j + 1][s]]);
  }
  if (rings.length) faces.push(rings[0], rings[rings.length - 1]);
}

/** Two directions square to a path at its `j`th point, for the rings around it. */
function across(points: readonly Vec3[], j: number): { u: Vec3; v: Vec3 } {
  const along = unit(sub(points[Math.min(points.length - 1, j + 1)], points[Math.max(0, j - 1)]));
  const up: Vec3 = Math.abs(along[1]) < 0.9 ? [0, 1, 0] : X;
  const u = unit(cross(along, up));
  return { u, v: unit(cross(along, u)) };
}

// ── The character: a body scan ─────────────────────────────────────────────────────────────

/** A level cross-section: height, half-width, half-depth and how far it sits forward. */
type Section = readonly [y: number, rx: number, rz: number, z?: number];
/** A limb: its centre line, and its radius (or its two radii) at each point. */
interface Limb {
  points: Vec3[];
  radii: ReadonlyArray<number | Vec2>;
}
interface Body {
  torso: readonly Section[];
  head: readonly Section[];
  neck: Vec3[];
  limbs: Limb[];
}

/** A man in an A-pose, six units tall: the sections and limbs the scan slices. */
const MAN = {
  torso: [
    [2.86, 0.2, 0.15],
    [2.98, 0.38, 0.24],
    [3.22, 0.47, 0.27, -0.02],
    [3.52, 0.42, 0.24, -0.01],
    [3.82, 0.38, 0.23],
    [4.12, 0.43, 0.25, 0.02],
    [4.42, 0.5, 0.28, 0.03],
    [4.68, 0.54, 0.26, 0.01],
    [4.86, 0.48, 0.21],
    [4.98, 0.25, 0.16],
    [5.04, 0.13, 0.13, 0.01],
  ],
  head: [
    [5.18, 0.12, 0.12, 0.08],
    [5.3, 0.23, 0.26, 0.04],
    [5.5, 0.28, 0.33, 0.01],
    [5.7, 0.29, 0.35],
    [5.88, 0.25, 0.3, -0.01],
    [5.99, 0.13, 0.16, -0.01],
  ],
  /** Where the arm leaves the torso, then each step of it: length, angle below level, and forward. */
  shoulder: [0.42, 4.76],
  arm: [
    [0.62, 0.92, 0],
    [0.55, 1.0, 0],
    [0.48, 1.08, 0.04],
    [0.4, 1.12, 0.04],
    [0.3, 1.18, 0.02],
    [0.22, 1.22, 0],
  ],
  armRadii: [0.2, 0.165, 0.12, 0.125, 0.085, [0.09, 0.065], [0.055, 0.04]],
  leg: [
    [0.2, 3.2, 0],
    [0.24, 2.5, 0.02],
    [0.22, 1.68, 0.04],
    [0.21, 1.22, -0.02],
    [0.2, 0.3, -0.02],
  ],
  legRadii: [0.27, 0.2, 0.125, 0.135, 0.075],
  foot: [
    [0.21, 0.16, -0.08],
    [0.22, 0.1, 0.2],
    [0.24, 0.07, 0.42],
  ],
  footRadii: [
    [0.08, 0.08],
    [0.09, 0.06],
    [0.07, 0.04],
  ],
} as const satisfies {
  torso: readonly Section[];
  head: readonly Section[];
  shoulder: Vec2;
  arm: readonly Vec3[];
  armRadii: ReadonlyArray<number | Vec2>;
  leg: readonly Vec3[];
  legRadii: readonly number[];
  foot: readonly Vec3[];
  footRadii: readonly Vec2[];
};

/** One arm's centre line, from the shoulder, on side `side` (−1 or 1). */
function armPoints(side: number): Vec3[] {
  const points: Vec3[] = [[MAN.shoulder[0] * side, MAN.shoulder[1], 0]];
  for (const [length, angle, forward] of MAN.arm) {
    const p = points[points.length - 1];
    points.push([p[0] + Math.cos(angle) * length * side, p[1] - Math.sin(angle) * length, p[2] + forward]);
  }
  return points;
}
const mirrored = (points: readonly Vec3[], side: number): Vec3[] => points.map((p) => [p[0] * side, p[1], p[2]]);

function manBody(): Body {
  const limbs: Limb[] = [];
  for (const side of [-1, 1]) {
    limbs.push({ points: armPoints(side), radii: MAN.armRadii });
    limbs.push({ points: mirrored(MAN.leg, side), radii: MAN.legRadii });
    limbs.push({ points: mirrored(MAN.foot, side), radii: MAN.footRadii });
  }
  return {
    torso: MAN.torso,
    head: MAN.head,
    neck: [
      [0, 5.02, 0.01],
      [0, 5.22, 0.04],
    ],
    limbs,
  };
}

const radiusOf = (r: number | Vec2): Vec2 => (typeof r === "number" ? [r, r] : r);

/** A limb as rings around its centre line, `sides` points each. */
function limbRings(limb: Limb, sides: number): Vec3[][] {
  return limb.points.map((c, j) => {
    const { u, v } = across(limb.points, j);
    const [rx, ry] = radiusOf(limb.radii[j]);
    return ellipse(c, u, v, rx, ry, sides);
  });
}

/** The body's surface as faces: the base mesh the scan's fill is cut from. */
function bodyFaces(body: Body): Vec3[][] {
  const faces: Vec3[][] = [];
  bandFaces(
    faces,
    body.torso.map(([y, rx, rz, z]) => level(y, rx, rz, 10, z)),
  );
  bandFaces(
    faces,
    body.head.map(([y, rx, rz, z]) => level(y, rx, rz, 8, z)),
  );
  bandFaces(faces, limbRings({ points: body.neck, radii: [0.12, 0.12] }, 6));
  for (const limb of body.limbs) bandFaces(faces, limbRings(limb, 6));
  return faces;
}

/** A stack of sections at height `y`, between the two that hold it, or null outside them. */
function sectionAt(sections: readonly Section[], y: number): Section | null {
  for (let i = 0; i + 1 < sections.length; i++) {
    const [y0, rx0, rz0, z0 = 0] = sections[i];
    const [y1, rx1, rz1, z1 = 0] = sections[i + 1];
    if (y < y0 || y > y1) continue;
    const k = (y - y0) / (y1 - y0 || 1);
    return [y, rx0 + (rx1 - rx0) * k, rz0 + (rz1 - rz0) * k, z0 + (z1 - z0) * k];
  }
  return null;
}

/** A limb's level contour at height `y`: where its centre line crosses it, stretched along its slope. */
function limbContour(limb: Limb, y: number): Vec3[] | null {
  for (let i = 0; i + 1 < limb.points.length; i++) {
    const p = limb.points[i];
    const q = limb.points[i + 1];
    const crosses = y >= Math.min(p[1], q[1]) && y <= Math.max(p[1], q[1]) && Math.abs(q[1] - p[1]) > 1e-6;
    if (!crosses) continue;
    const k = (y - p[1]) / (q[1] - p[1]);
    const r = radiusOf(limb.radii[i])[0] + (radiusOf(limb.radii[i + 1])[0] - radiusOf(limb.radii[i])[0]) * k;
    const along = unit(sub(q, p));
    const flat = Math.hypot(along[0], along[2]) || 1;
    const u: Vec3 = [along[0] / flat, 0, along[2] / flat];
    const stretch = Math.min(3, 1 / Math.max(0.2, Math.abs(along[1])));
    return ellipse(mix(p, q, k), u, [-u[2], 0, u[0]], r * stretch, r, 10);
  }
  return null;
}

/** The scan: only level contours through every part, one every `step`. */
function scanSegments(body: Body, step: number): Segment[] {
  const segments: Segment[] = [];
  const top = body.head[body.head.length - 1][0];
  for (let y = step / 2; y < top; y += step) {
    const section = sectionAt(body.torso, y) ?? sectionAt(body.head, y);
    if (section) link(segments, level(y, section[1], section[2], 16, section[3]), true, 1);
    for (const limb of body.limbs) {
      const contour = limbContour(limb, y);
      if (contour) link(segments, contour, true, 1);
    }
  }
  return segments;
}

/** The character: a man in an A-pose as a body scan's level contours. */
export function bodyScan(): Solid {
  const body = manBody();
  return { segments: scanSegments(body, 0.2), faces: bodyFaces(body) };
}

// ── The 3D model: the Utah teapot ──────────────────────────────────────────────────────────

/** A cubic Bézier in the profile plane. */
type Curve = readonly [Vec2, Vec2, Vec2, Vec2];
function bezier(c: Curve, t: number): Vec2 {
  const u = 1 - t;
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [
    w[0] * c[0][0] + w[1] * c[1][0] + w[2] * c[2][0] + w[3] * c[3][0],
    w[0] * c[0][1] + w[1] * c[1][1] + w[2] * c[2][1] + w[3] * c[3][1],
  ];
}

/** A turned profile: meridians down it, rings at the curves' `ringAt` points, and its faces. */
function lathe(solid: Solid, curves: readonly Curve[], ringAt: readonly number[]): void {
  const profile = curves.flatMap((c) => Array.from({ length: 6 }, (_, i) => bezier(c, i / 5)));
  for (let m = 0; m < 12; m++) {
    const angle = (m / 12) * TAU;
    link(
      solid.segments,
      profile.map(([r, y]) => [r * Math.cos(angle), y, r * Math.sin(angle)] as Vec3),
      false,
      0.85,
    );
  }
  for (const c of curves)
    for (const t of ringAt) {
      const [r, y] = bezier(c, t);
      link(solid.segments, level(y, r, r, 40), true, 1);
    }
  bandFaces(
    solid.faces,
    profile.map(([r, y]) => level(y, r, r, 16)),
  );
}

/** A tube between an inner and an outer curve (the spout, the handle), thinning from `w0` to `w1`. */
function rail(
  solid: Solid,
  inner: readonly Curve[],
  outer: readonly Curve[],
  w0: number,
  w1: number,
  rings: number,
): void {
  const at = (t: number, phi: number): Vec3 => {
    const x = Math.min(inner.length - 1e-6, t * inner.length);
    const i = Math.floor(x);
    const a = bezier(inner[i], x - i);
    const b = bezier(outer[i], x - i);
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const w = w0 + (w1 - w0) * t;
    return [m[0] + (b[0] - m[0]) * Math.cos(phi), m[1] + (b[1] - m[1]) * Math.cos(phi), w * Math.sin(phi)];
  };
  const ring = (t: number, n: number): Vec3[] => Array.from({ length: n }, (_, i) => at(t, (i / n) * TAU));
  for (let r = 0; r <= rings; r++) link(solid.segments, ring(r / rings, 14), true, 1);
  for (let j = 0; j < 5; j++)
    link(
      solid.segments,
      Array.from({ length: 19 }, (_, q) => at(q / 18, (j / 5) * TAU)),
      false,
      0.85,
    );
  bandFaces(
    solid.faces,
    Array.from({ length: 13 }, (_, r) => ring(r / 12, 10)),
  );
}

/** Newell's teapot: the body's and lid's profiles, and the spout's and handle's inner and outer curves. */
const POT = {
  body: [
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
  ],
  lid: [
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
  ],
  spout: {
    inner: [
      [
        [1.7, 0.45],
        [3.1, 0.675],
        [2.4, 1.875],
        [3.3, 2.25],
      ],
    ],
    outer: [
      [
        [1.7, 1.275],
        [2.6, 1.275],
        [2.3, 1.95],
        [2.7, 2.25],
      ],
    ],
  },
  handle: {
    inner: [
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
    ],
    outer: [
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
    ],
  },
} as const satisfies {
  body: readonly Curve[];
  lid: readonly Curve[];
  spout: { inner: readonly Curve[]; outer: readonly Curve[] };
  handle: { inner: readonly Curve[]; outer: readonly Curve[] };
};

/** The 3D model: the Utah teapot. */
export function teapot(): Solid {
  const solid: Solid = { segments: [], faces: [] };
  lathe(solid, POT.body, [0, 0.5]);
  lathe(solid, POT.lid, [0.5, 1]);
  link(solid.segments, level(0.15, 1.5, 1.5, 40), true, 1);
  rail(solid, POT.spout.inner, POT.spout.outer, 0.62, 0.24, 3);
  rail(solid, POT.handle.inner, POT.handle.outer, 0.3, 0.3, 4);
  return solid;
}

// ── 2D outlines: marks and stones ──────────────────────────────────────────────────────────

function arc(cx: number, cy: number, r: number, a0: number, a1: number, n: number): Vec2[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const angle = a0 + ((a1 - a0) * i) / n;
    return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
  });
}
/** A rounded rectangle centred on (cx, cy). */
export function roundedRect(cx: number, cy: number, w: number, h: number, r: number): Vec2[] {
  const x = w / 2 - r;
  const y = h / 2 - r;
  const q = Math.PI / 2;
  return [
    ...arc(cx + x, cy + y, r, 0, q, 6),
    ...arc(cx - x, cy + y, r, q, 2 * q, 6),
    ...arc(cx - x, cy - y, r, 2 * q, 3 * q, 6),
    ...arc(cx + x, cy - y, r, 3 * q, 4 * q, 6),
  ];
}
const disc = (cx: number, cy: number, r: number): Vec2[] => arc(cx, cy, r, 0, TAU, 18).slice(0, -1);

/** A polygon with each corner rounded by a quadratic curve `r` along both its edges. */
export function rounded(points: readonly Vec2[], r: number | readonly number[], steps = 4): Vec2[] {
  const out: Vec2[] = [];
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[(i + n - 1) % n];
    const c = points[i];
    const q = points[(i + 1) % n];
    const radius = typeof r === "number" ? r : r[i];
    const lp = Math.hypot(p[0] - c[0], p[1] - c[1]) || 1;
    const lq = Math.hypot(q[0] - c[0], q[1] - c[1]) || 1;
    const a = Math.min(radius, lp / 2) / lp;
    const b = Math.min(radius, lq / 2) / lq;
    const s: Vec2 = [c[0] + (p[0] - c[0]) * a, c[1] + (p[1] - c[1]) * a];
    const e: Vec2 = [c[0] + (q[0] - c[0]) * b, c[1] + (q[1] - c[1]) * b];
    for (let j = 0; j <= steps; j++) {
      const t = j / steps;
      const u = 1 - t;
      out.push([u * u * s[0] + 2 * u * t * c[0] + t * t * e[0], u * u * s[1] + 2 * u * t * c[1] + t * t * e[1]]);
    }
  }
  return out;
}

/** A thick arc with round ends, as one outline: a sound wave. */
function wave(R: number, half: number, w: number): Vec2[] {
  const end = (angle: number): Vec2 => [-0.4 + R * Math.cos(angle), R * Math.sin(angle)];
  const [x1, y1] = end(half);
  const [x0, y0] = end(-half);
  return [
    ...arc(-0.4, 0, R + w, -half, half, 14),
    ...arc(x1, y1, w, half, half + Math.PI, 6).slice(1, -1),
    ...arc(-0.4, 0, R - w, half, -half, 14),
    ...arc(x0, y0, w, -half + Math.PI, -half + TAU, 6).slice(1, -1),
  ];
}

/** An outline pulled `d` towards its centre. */
function inset(points: readonly Vec2[], d: number): Vec2[] {
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cy = points.reduce((s, p) => s + p[1], 0) / points.length;
  return points.map(([x, y]) => {
    const l = Math.hypot(x - cx, y - cy) || 1;
    return [x - ((x - cx) / l) * d, y - ((y - cy) / l) * d];
  });
}

/** A repeatable stream of numbers in [0, 1). */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/** A convex polygon cut down to the side of the bisector between `site` and `other` nearer `site`. */
function clipToward(poly: readonly Vec2[], site: Vec2, other: Vec2): Vec2[] {
  const m = [(site[0] + other[0]) / 2, (site[1] + other[1]) / 2];
  const d = [other[0] - site[0], other[1] - site[1]];
  const side = (p: Vec2): number => (p[0] - m[0]) * d[0] + (p[1] - m[1]) * d[1];
  const out: Vec2[] = [];
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k];
    const b = poly[(k + 1) % poly.length];
    const sa = side(a);
    const sb = side(b);
    if (sa <= 0) out.push(a);
    if (sa * sb < 0) out.push([a[0] + (b[0] - a[0]) * (sa / (sa - sb)), a[1] + (b[1] - a[1]) * (sa / (sa - sb))]);
  }
  return out;
}

/** A stone: its rounded outline and the point it grew from. */
export interface Stone {
  outline: Vec2[];
  site: Vec2;
}
/** Stones filling a square of half-size `half`: an `n`×`n` jittered Voronoi, each cell shrunk by `gap` and rounded. */
export function stones(half: number, n: number, seed: number, gap: number, r: number): Stone[] {
  const random = seeded(seed);
  const cell = (2 * half) / n;
  const sites: Vec2[] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      sites.push([
        -half + cell * (i + 0.5 + (random() - 0.5) * 0.75),
        -half + cell * (j + 0.5 + (random() - 0.5) * 0.75),
      ]);
  return sites.map((site) => {
    let cellPoly: Vec2[] = [
      [-half, -half],
      [half, -half],
      [half, half],
      [-half, half],
    ];
    for (const other of sites) if (other !== site) cellPoly = clipToward(cellPoly, site, other);
    return { outline: rounded(inset(cellPoly, gap), r, 3), site };
  });
}

/** The image: a rounded frame with a sun and two mountains inside. */
export function imageMark(): MarkShape[] {
  const mountains: Vec2[] = [
    [-9.8, -5.0],
    [-9.8, -0.4],
    [-3.2, 4.6],
    [1.6, -0.6],
    [4.0, 1.1],
    [9.8, -3.6],
    [9.8, -5.0],
    [8.6, -7.3],
    [-8.6, -7.3],
  ];
  return [
    { points: roundedRect(0, 0, 24, 19, 4.6), face: true },
    { points: roundedRect(0, 0, 19.6, 14.6, 2.4), face: true },
    { points: disc(4.9, 3.4, 1.9), face: true },
    { points: rounded(mountains, [0.01, 0.6, 1.4, 0.9, 1.0, 0.6, 0.01, 2.0, 2.0]), face: true },
  ];
}

/** The video: a rounded badge with the play triangle cut out of it. */
export function videoMark(): MarkShape[] {
  const play: Vec2[] = [
    [-2.5, 3.7],
    [-2.5, -3.7],
    [3.9, 0],
  ];
  return [
    { points: roundedRect(0, 0, 24, 16.8, 4.8), face: true },
    { points: rounded(play, 1.1), face: true },
  ];
}

/** How bright a sound wave is at `t`: each one swells in turn, the outer one after the inner. */
function swell(t: number, order: number): number {
  const p = (t * 0.9 - order * 0.28) % 1.4;
  if (p < 0) return 0.35;
  return 0.45 + 0.85 * Math.max(0, Math.sin(Math.min(1, p) * Math.PI));
}

/** The sound: a speaker and two waves leaving it, swelling in turn. */
export function soundMark(t: number): MarkShape[] {
  const speaker: Vec2[] = [
    [-11, 3.3],
    [-6.4, 3.3],
    [-1.6, 8.2],
    [-1.6, -8.2],
    [-6.4, -3.3],
    [-11, -3.3],
  ];
  return [
    { points: rounded(speaker, [1.3, 0.9, 1.3, 1.3, 0.9, 1.3]), face: true },
    { points: wave(4.6, 0.82, 1.15), face: true, k: swell(t, 0) },
    { points: wave(9.2, 0.82, 1.15), face: true, k: swell(t, 1) },
  ];
}

const PLANE_STONES = stones(1.9, 4, 7, 0.07, 0.24);
const STONE_HEIGHTS = (() => {
  const random = seeded(9);
  return PLANE_STONES.map(() => 0.1 + 0.07 * random());
})();

/** The texture: cobblestones laid on a plane, a slow swell lifting them in turn. */
export function cobbles(t: number): Solid {
  const solid: Solid = { segments: [], faces: [] };
  PLANE_STONES.forEach(({ outline, site }, i) => {
    const h = STONE_HEIGHTS[i] + 0.2 * Math.max(0, Math.sin(site[0] * 1.3 + site[1] * 0.9 - t * 1.6));
    const base = outline.map(([x, z]): Vec3 => [x, 0, z]);
    const top = inset(outline, 0.06).map(([x, z]): Vec3 => [x, h, z]);
    link(solid.segments, base, true, 0.45);
    link(solid.segments, top, true, 1.1);
    for (let j = 0; j < top.length; j += 3) solid.segments.push({ a: base[j], b: top[j], k: 0.4 });
    solid.faces.push(top);
  });
  link(
    solid.segments,
    roundedRect(0, 0, 4.1, 4.1, 0.3).map(([x, z]): Vec3 => [x, -0.02, z]),
    true,
    0.3,
  );
  return solid;
}

/** The Genex account: a rounded card with a person on it and two lines of a name beside them. */
export function accountMark(): MarkShape[] {
  const shoulders: Vec2[] = arc(-5.4, -6.2, 5.0, 0, Math.PI, 14);
  return [
    { points: roundedRect(0, 0, 26, 18, 4.6), face: true },
    { points: disc(-5.4, 2.4, 2.7), face: true },
    { points: rounded(shoulders, 0.6, 3), face: true },
    { points: roundedRect(5.4, 2.6, 9.4, 2.4, 1.2), face: true },
    { points: roundedRect(4.2, -2.2, 7, 2.4, 1.2), face: true, k: 0.8 },
  ];
}

/** A person's head and shoulders, centred on x, the shoulders' base at y. */
function person(x: number, y: number, size: number, k = 1): MarkShape[] {
  const head = disc(x, y + size * 1.62, size * 0.54);
  const shoulders = rounded(arc(x, y, size, 0, Math.PI, 16), size * 0.12, 3);
  return [
    { points: head, face: true, k },
    { points: shoulders, face: true, k },
  ];
}

/** A ring: an outline with a hole `width` wide, for the even-odd face. */
function ring(cx: number, cy: number, r: number, width: number): MarkShape[] {
  return [
    { points: disc(cx, cy, r), face: true },
    { points: disc(cx, cy, r - width).reverse(), face: true },
  ];
}

/** Remix: the Remix button's fork, three rings joined by a U and its stem, one game two ways on. */
export function remixMark(): MarkShape[] {
  const pipe: Vec2[] = [
    [-8.2, 3.3],
    [-8.2, -1.2],
    [-1.2, -1.2],
    [-1.2, -4.4],
    [1.2, -4.4],
    [1.2, -1.2],
    [8.2, -1.2],
    [8.2, 3.3],
    [5.8, 3.3],
    [5.8, 1.2],
    [-5.8, 1.2],
    [-5.8, 3.3],
  ];
  return [
    { points: rounded(pipe, [0.2, 2.6, 0.5, 0.2, 0.2, 0.5, 2.6, 0.2, 0.2, 0.9, 0.9, 0.2]), face: true },
    ...ring(-7, 5.9, 2.6, 1.25),
    ...ring(7, 5.9, 2.6, 1.25),
    ...ring(0, -7, 2.6, 1.25),
  ];
}

/** Multiplayer: a room, drawn as the account card's sibling, with two players on it. */
export function multiplayerMark(): MarkShape[] {
  return [
    { points: roundedRect(0, 0, 27, 18, 4.6), face: true },
    ...person(-5.2, -6.6, 4.3),
    ...person(5.2, -6.6, 4.3, 0.85),
  ];
}
