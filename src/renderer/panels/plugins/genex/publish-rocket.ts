/**
 * The "Your game is live!" celebration, as genex.games plays it after a publish: a dot-matrix pixel
 * rocket lifts off the pad, accelerates straight up and leaves, while stars pop, bloom a ring, hold
 * and shrink back to a dot. Deterministic (a seeded generator and a fixed 30 fps timeline), so every
 * publish shows the same run. Drawn in one colour on a 32-cell grid; `t` runs 0 → 1.
 */

/** The logical grid, frames per second and frame count of the run (about 4.5 s). */
export const ROCKET_GRID = 32;
export const ROCKET_FPS = 30;
export const ROCKET_FRAMES = 135;
/** The seed of the approved run. */
const SEED = 8822;
/** The rocket's sprite, its height and half its width, in cells. */
const SPRITE = ["...X...", "..XXX..", "..X.X..", "..XXX..", "..XXX..", ".XXXXX."];
const SPRITE_H = SPRITE.length;
const HALF_W = 4;
/** Where the nose starts and where it flies to (off the top), and when in the run it is gone. */
const PAD = { x: 16, y: 25 };
const SKY = { x: 16, y: -12 };
const FLIGHT_END = 0.62;
/** How the run's smoke, dust and stars are made. */
const TRAIL_DOTS = 44;
const DUST_DOTS = 6;
const STARS = 7;
const STAR_FIRST = 0.45;
const STAR_STEP = 0.075;
/** The early part of the flight that shows the wide ignition flame. */
const IGNITION_END = 0.14;

/** The rocket's cells, as offsets from its nose. */
const ROCKET: ReadonlyArray<readonly [number, number]> = SPRITE.flatMap((row, y) =>
  [...row].flatMap((cell, x) => (cell === "X" ? [[x - 3, y] as const] : [])),
);

const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((value) => value / 16));
const bayer = (x: number, y: number): number => BAYER[((y % 4) + 4) % 4][((x % 4) + 4) % 4];
const clamp01 = (t: number): number => Math.max(0, Math.min(1, t));
/** Ease-in: the rocket holds near the pad, then runs away, as a real launch does. */
const pathEase = (t: number): number => t * t;

function mulberry32(start: number): () => number {
  let seed = start;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface TrailDot {
  u: number;
  back: number;
  j: number;
  fade: number;
  a: number;
}
interface DustDot {
  x: number;
  y: number;
  a: number;
  die: number;
}
interface Star {
  x: number;
  y: number;
  at: number;
  rot: number;
}
/** The run's smoke, pad dust and stars, the same every time. */
export interface RocketScene {
  trail: TrailDot[];
  dust: DustDot[];
  stars: Star[];
}

/** The seeded scene every run draws. */
export function rocketScene(): RocketScene {
  const rng = mulberry32(SEED);
  const trail = Array.from({ length: TRAIL_DOTS }, () => ({
    u: rng(),
    back: SPRITE_H + 1.5 + rng() * 3,
    j: (rng() - 0.5) * 3,
    fade: 0.18 + rng() * 0.22,
    a: 0.2 + rng() * 0.3,
  }));
  const dust = Array.from({ length: DUST_DOTS }, (_, i) => ({
    x: PAD.x + (i < DUST_DOTS / 2 ? -(2 + rng() * 3) : 2 + rng() * 3),
    y: PAD.y + SPRITE_H - 1 + Math.floor(rng() * 2),
    a: 0.2 + rng() * 0.18,
    die: 0.5 + rng() * 0.5,
  }));
  const stars = Array.from({ length: STARS }, (_, i) => ({
    x: 5 + Math.floor(rng() * 21),
    y: 4 + Math.floor(rng() * 17),
    at: STAR_FIRST + i * STAR_STEP,
    rot: rng(),
  }));
  return { trail, dust, stars };
}

/** Light one cell at `alpha`; cells off the grid are skipped. */
type Plot = (x: number, y: number, alpha?: number) => void;

function drawFlame(px: Plot, nose: { x: number; y: number }, t: number): void {
  if (t <= 0.02 || t >= FLIGHT_END - 0.02) return;
  const flicker = Math.floor(t * ROCKET_FRAMES) % 2;
  const base = nose.y + SPRITE_H;
  if (t < IGNITION_END) {
    px(nose.x - 1, base, 0.9 - 0.3 * flicker);
    px(nose.x, base, 0.7 + 0.2 * flicker);
    px(nose.x + 1, base, 0.6 + 0.3 * flicker);
    px(nose.x - flicker, base + 1, 0.5);
    return;
  }
  px(nose.x - 1 + flicker, base, 0.8);
  px(nose.x - flicker, base + 1, 0.5);
}

function drawTrail(px: Plot, scene: RocketScene, nose: { x: number; y: number }, eased: number, t: number): void {
  for (const dot of scene.trail) {
    if (dot.u > eased) continue;
    const x = PAD.x + dot.j;
    const y = PAD.y + (SKY.y - PAD.y) * dot.u + dot.back;
    const underRocket = Math.abs(x - nose.x) <= HALF_W && y > nose.y && y < nose.y + SPRITE_H + 2;
    if (underRocket) continue;
    const age = Math.max(0, t - FLIGHT_END * Math.sqrt(dot.u));
    if (bayer(Math.round(x), Math.round(y)) > age * dot.fade) px(x, y, Math.max(0.15, dot.a * (1 - age * 0.6)));
  }
}

function drawDust(px: Plot, scene: RocketScene, t: number): void {
  for (const dot of scene.dust) {
    if (t > dot.die && bayer(Math.round(dot.x), dot.y) < 0.6) continue;
    px(dot.x, dot.y, dot.a * (t < 0.1 ? t / 0.1 : 1));
  }
}

/** One star: a core that stays, arms that fade, and a ring that blooms and retracts. */
function drawStar(px: Plot, star: Star, t: number): void {
  const age = t - star.at;
  const shown = clamp01(age / 0.05);
  const arms = shown * Math.max(0, Math.min(1, 1 - (age - 0.4) / 0.45));
  const ring = shown * Math.max(0, Math.min((age - 0.04) / 0.08, 1 - (age - 0.3) / 0.3)) * 0.45;
  px(star.x, star.y, shown);
  for (const [dx, dy] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]) {
    if (arms > 0) px(star.x + dx, star.y + dy, 0.6 * arms);
    if (ring > 0) px(star.x + dx * 2, star.y + dy * 2, ring);
  }
  if (ring <= 0 || star.rot <= 0.5) return;
  for (const [dx, dy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ])
    px(star.x + dx, star.y + dy, ring * 0.7);
}

/** Draw the run at `t` (0 → 1) in `color`, one cell `cell` pixels wide. */
export function drawRocket(
  ctx: CanvasRenderingContext2D,
  cell: number,
  t: number,
  scene: RocketScene,
  color: string,
): void {
  ctx.clearRect(0, 0, ROCKET_GRID * cell, ROCKET_GRID * cell);
  ctx.fillStyle = color;
  const px: Plot = (x, y, alpha = 1) => {
    if (x < -1 || y < -1 || x >= ROCKET_GRID || y >= ROCKET_GRID) return;
    ctx.globalAlpha = alpha;
    ctx.fillRect(Math.floor(x) * cell, Math.floor(y) * cell, cell, cell);
  };
  const eased = pathEase(clamp01(t / FLIGHT_END));
  const nose = { x: PAD.x, y: PAD.y + (SKY.y - PAD.y) * eased };
  for (const [dx, dy] of ROCKET) px(nose.x + dx, nose.y + dy);
  drawFlame(px, nose, t);
  drawTrail(px, scene, nose, eased, t);
  drawDust(px, scene, t);
  for (const star of scene.stars) if (t >= star.at) drawStar(px, star, t);
  ctx.globalAlpha = 1;
}
