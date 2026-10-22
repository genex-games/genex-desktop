/**
 * What the avatar's 2D layers draw with: a frame (the context, the recipe, where the body sits and
 * the avatar's own clock), polygons, glow, and the rhythms every eye shares (blink, glance, the
 * white-hot surge, the flicker).
 */
import type { AvatarRecipe } from "../../shared/avatar-recipe.ts";

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type Point = [number, number];

/** One avatar being drawn: the body's centre and radius in canvas pixels, at time `t` seconds. */
export interface AvatarFrame {
  ctx: Ctx2D;
  recipe: AvatarRecipe;
  cx: number;
  cy: number;
  rad: number;
  t: number;
}

/** The dark of a cut or a socket on a light shell. */
export const SOCKET = "#07080c";

/** Light bleeds around what is drawn next, `blur` canvas pixels wide. */
export function glow(ctx: Ctx2D, color: string, blur: number): void {
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
}

/** What is drawn next has no glow. */
export function noGlow(ctx: Ctx2D): void {
  ctx.shadowBlur = 0;
  ctx.shadowColor = "transparent";
}

/** A closed path through `points`. */
export function poly(ctx: Ctx2D, points: readonly Point[]): void {
  ctx.beginPath();
  for (const [index, [x, y]] of points.entries()) {
    if (index) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  ctx.closePath();
}

/** An open path through `points`. */
export function path(ctx: Ctx2D, points: readonly Point[]): void {
  ctx.beginPath();
  for (const [index, [x, y]] of points.entries()) {
    if (index) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
}

/** The points' average. */
export function middle(points: readonly Point[]): Point {
  const sum = points.reduce<Point>((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
  return [sum[0] / points.length, sum[1] / points.length];
}

/** The points scaled about their middle. */
export function scaled(points: readonly Point[], sx: number, sy: number): Point[] {
  const [mx, my] = middle(points);
  return points.map(([x, y]) => [mx + (x - mx) * sx, my + (y - my) * sy]);
}

/** A repeatable 0..1 number for `index` under `seed`. */
export function rand(index: number, seed: number): number {
  const x = Math.sin(index * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** A `#rrggbb` colour's channels, 0..1. */
export function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** A colour darkened (`k` < 1) or lit towards white (`k` > 1). */
export function shade(hex: string, k: number): string {
  const channel = (v: number) => Math.round(255 * Math.max(0, Math.min(1, k > 1 ? v + (1 - v) * (k - 1) : v * k)));
  return `rgb(${rgb(hex).map(channel).join(",")})`;
}

/** The point `r` from the centre at angle `a`. */
export const around = (cx: number, cy: number, r: number, a: number): Point => [
  cx + Math.cos(a) * r,
  cy + Math.sin(a) * r,
];

/** A quick dart to a new spot every `period` seconds, then a hold: two numbers in -1..1. */
export function glance(recipe: AvatarRecipe, t: number, period: number): Point {
  const k = (t + recipe.phase) / period;
  const step = Math.floor(k);
  const linear = Math.min(1, (k - step) * 7);
  const eased = linear * linear * (3 - 2 * linear);
  const x0 = rand(step - 1, recipe.seed) * 2 - 1;
  const x1 = rand(step, recipe.seed) * 2 - 1;
  const y0 = rand(step + 76, recipe.seed) * 2 - 1;
  const y1 = rand(step + 77, recipe.seed) * 2 - 1;
  return [x0 + (x1 - x0) * eased, y0 + (y1 - y0) * eased];
}

/** How open the eyes are: 1, dipping to a sliver for a blink every `recipe.blink` seconds. */
export function openness(recipe: AvatarRecipe, t: number): number {
  const at = (t + recipe.phase) % recipe.blink;
  return at < 0.16 ? Math.max(0.06, Math.abs(at - 0.08) / 0.08) : 1;
}

/** The surge: every few seconds the eyes flare white-hot for under a second. */
export function flare(recipe: AvatarRecipe, t: number): number {
  const period = 5.5 + (recipe.seed % 5) * 0.9;
  const x = ((t + recipe.phase * 1.7) % period) / 0.9;
  return x < 1 ? Math.sin(x * Math.PI) : 0;
}

/** A lit eye's unsteady light. */
export const flicker = (t: number, seed: number): number =>
  0.88 + 0.12 * Math.sin(t * 23 + seed) * Math.sin(t * 7.3 + seed * 2.1);

/** Local eye points (+x towards the nose) on the canvas: tilted, mirrored for side `s`, squashed to blink. */
export function eyePoints(local: readonly Point[], centre: Point, side: number, tilt: number, open: number): Point[] {
  const c = Math.cos(tilt);
  const n = Math.sin(tilt);
  return local.map(([x, y]) => [centre[0] - side * (x * c - y * n), centre[1] + (x * n + y * c) * open]);
}

/**
 * A lit eye. On a dark shell the whole shape glows with a white-hot core; on a light one it is a
 * dark cut with a thin line of light inside (a round white glint would read as a cartoon eye).
 * `core` is the core's width and height share, and its whiteness.
 */
export function litPoly(
  frame: AvatarFrame,
  points: readonly Point[],
  bloom: number,
  core: readonly [number, number, number],
): void {
  const { ctx, recipe, rad } = frame;
  if (!recipe.dark) {
    poly(ctx, points);
    ctx.fillStyle = SOCKET;
    ctx.fill();
    glow(ctx, recipe.glow, rad * 0.16 * bloom);
    poly(ctx, scaled(points, core[0] * 0.9, Math.max(0.16, core[1] * 0.7)));
    ctx.fillStyle = recipe.glow;
    ctx.fill();
    noGlow(ctx);
    return;
  }
  glow(ctx, recipe.glow, rad * 0.2 * bloom);
  poly(ctx, points);
  ctx.fillStyle = recipe.glow;
  ctx.fill();
  noGlow(ctx);
  poly(ctx, scaled(points, core[0], core[1]));
  ctx.fillStyle = `rgba(255,255,255,${core[2]})`;
  ctx.fill();
}

/** How many cells across the pixel-art bodies use at a body of `pixels` across. */
export const cellsAcross = (pixels: number): number => Math.max(12, Math.min(34, Math.round(pixels / 3)));
