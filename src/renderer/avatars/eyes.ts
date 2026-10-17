/**
 * The generated avatar's eyes, drawn in 2D over the body: seven styles of lit hardware (blocks,
 * blades, PS1 shards, grille, optic, mono eye, demon). Expression lives only in each eye's own
 * shape and rhythm; nothing here is a brow, a mouth or a glint.
 */
import { AvatarBody, AvatarEyes, BlockState } from "../../shared/avatar-recipe.ts";
import {
  type AvatarFrame,
  cellsAcross,
  eyePoints,
  flare,
  flicker,
  glance,
  glow,
  litPoly,
  middle,
  noGlow,
  openness,
  type Point,
  path,
  poly,
  rand,
  SOCKET,
  shade,
} from "./draw-kit.ts";

/** Block eyes' silhouettes: `X` is a lit cell. The left eye; the right one is its mirror. */
const BLOCKS: Record<BlockState, readonly string[]> = {
  [BlockState.Steady]: ["XX", "XX", "XX"],
  [BlockState.Wide]: ["XXX", "XXX", "XXX"],
  [BlockState.Cold]: ["XXXX", "XXXX"],
  [BlockState.Slit]: ["XXXXX"],
  [BlockState.Menace]: ["XX..", "XXXX", "XXXX"],
  [BlockState.Fury]: ["X...", "XXX.", "XXXX"],
  [BlockState.Tired]: ["..XX", "XXXX", "XXXX"],
  [BlockState.Squint]: ["XXX", "XXX", "XXX"],
  [BlockState.Scan]: ["XXXXX"],
};
/** Where block eyes glance, one step every 2.4 seconds, in cells. */
const BLOCK_GLANCES = [0, 0, -1, 1, 0, -1, 1, 0] as const;
/** The three colours demon eyes burn in. */
const FIRE = ["#ff2b2b", "#ff7a1a", "#38a8ff"] as const;

/** How block eyes sit: the cell size, the grid they snap to, and their colours. */
function blockLayout(frame: AvatarFrame, width: number) {
  const { recipe, cx, cy, rad } = frame;
  const crt = recipe.body === AvatarBody.Crt;
  const cell = (2 * rad) / cellsAcross(Math.round(rad * 2));
  const want = rad * (width > 3 ? 0.085 : 0.11);
  const unit = crt ? cell * Math.max(1, Math.round(want / cell)) : Math.max(1, Math.round(want));
  const grid = crt ? cell : 1;
  const snapX = (v: number) => cx - rad + Math.round((v - (cx - rad)) / grid) * grid;
  const snapY = (v: number) => cy - rad + Math.round((v - (cy - rad)) / grid) * grid;
  const ink = blockInk(frame, crt);
  return { crt, unit, snapX, snapY, ...ink };
}

/** Block eyes' colour and the scan's bright cell: the CRT's own palette, else the body's light. */
function blockInk(frame: AvatarFrame, crt: boolean): { ink: string; lit: string } {
  const { recipe } = frame;
  if (crt) return { ink: recipe.palette[0], lit: recipe.palette[3] };
  return recipe.dark ? { ink: recipe.glow, lit: "#ffffff" } : { ink: "#0b0c12", lit: recipe.glow };
}

/** The two eyes' bitmaps: a squint shuts one, a blink leaves only the bottom row. */
function blockBitmaps(frame: AvatarFrame, shut: boolean): [readonly string[], readonly string[]] {
  const { recipe } = frame;
  const bitmap = BLOCKS[recipe.state];
  let left = bitmap;
  let right = bitmap;
  if (recipe.state === BlockState.Squint) {
    if (recipe.side > 0) right = ["XXX"];
    else left = ["XXX"];
  }
  if (shut && (bitmap[0]?.length ?? 0) <= 4) {
    left = [left.at(-1) ?? ""];
    right = [right.at(-1) ?? ""];
  }
  return [left, right];
}

/** Where a block eye was drawn: its top-left corner. */
type Placed = { left: number; top: number };

/** Draw one block eye's lit cells centred on `x`, its rows snapped to the layout's grid. */
function blitBlocks(
  frame: AvatarFrame,
  layout: ReturnType<typeof blockLayout>,
  bitmap: readonly string[],
  at: { x: number; y: number; mirror: boolean },
): Placed {
  const { unit, snapX, snapY } = layout;
  const columns = bitmap[0]?.length ?? 0;
  const left = snapX(at.x - (columns * unit) / 2);
  const top = snapY(at.y - (bitmap.length * unit) / 2);
  for (const [row, line] of bitmap.entries())
    for (let column = 0; column < columns; column++)
      if (line[at.mirror ? columns - 1 - column : column] === "X")
        frame.ctx.fillRect(left + column * unit, top + row * unit, unit, unit);
  return { left, top };
}

/** The glow a scan's bright cell wears: none on CRT, the body's light on a dark shell, its own on a light one. */
function scanGlow(frame: AvatarFrame, crt: boolean, lit: string): string {
  if (crt) return "transparent";
  return frame.recipe.dark ? frame.recipe.glow : lit;
}

/** Scan: one bright cell sweeping across both eyes and back. */
function scanCell(frame: AvatarFrame, layout: ReturnType<typeof blockLayout>, placed: readonly Placed[]): void {
  const { ctx, recipe, rad, t } = frame;
  const k = ((t + recipe.phase) * 7) % 18;
  const cell = Math.floor(k < 9 ? k : 18 - k);
  const eye = placed[cell < 5 ? 0 : 1];
  if (cell > 9 || !eye) return;
  ctx.fillStyle = layout.lit;
  glow(ctx, scanGlow(frame, layout.crt, layout.lit), rad * 0.2);
  ctx.fillRect(eye.left + Math.min(4, cell < 5 ? cell : cell - 5) * layout.unit, eye.top, layout.unit, layout.unit);
  noGlow(ctx);
}

/** Blocks: the CRT original. Squares only; the silhouette is the expression. */
function blockEyes(frame: AvatarFrame): void {
  const { ctx, recipe, cx, cy, rad, t } = frame;
  // The alpha the eyes are drawn at (half for a placeholder): every change here is relative to it.
  const base = ctx.globalAlpha;
  const width = BLOCKS[recipe.state][0]?.length ?? 2;
  const layout = blockLayout(frame, width);
  const { crt, unit, ink } = layout;
  const beat = Math.floor((t + recipe.phase) / 2.4);
  const dx = (BLOCK_GLANCES[(beat + recipe.seed) % BLOCK_GLANCES.length] ?? 0) * unit;
  const tick = (t + recipe.phase * 2.3) % (4.2 + (recipe.seed % 3));
  const jolt = tick < 0.12 ? unit : 0;
  const shut = openness(recipe, t) < 0.5;
  const [left, right] = blockBitmaps(frame, shut);
  const y = cy + recipe.eyeY * rad * 0.6;
  const half = ((width + 2 + (recipe.seed % 2)) * unit) / 2;
  const glowing = recipe.dark && !crt;
  ctx.fillStyle = ink;
  if (glowing) glow(ctx, ink, rad * 0.16);
  if (recipe.state === BlockState.Scan && glowing) ctx.globalAlpha = base * 0.5;
  const placed = [
    blitBlocks(frame, layout, left, { x: cx - half + dx, y, mirror: false }),
    blitBlocks(frame, layout, right, { x: cx + half + dx + jolt, y, mirror: true }),
  ];
  ctx.globalAlpha = base;
  noGlow(ctx);
  if (!shut && recipe.state === BlockState.Scan) scanCell(frame, layout, placed);
}

/** A blade's outline: a thin slanted slit tapering to a point, its inner end low. */
const bladeShape = (length: number, thick: number): Point[] => [
  [-length / 2, -thick * 0.15],
  [length * 0.18, -thick * 0.62],
  [length / 2, -thick * 0.42],
  [length * 0.4, thick * 0.5],
  [-length * 0.12, thick * 0.32],
];

/** Blades: slanted slits that flicker, with a white-hot surge every few seconds. `only` draws one side. */
function bladeEyes(frame: AvatarFrame, only: 1 | -1 | null = null): void {
  const { recipe, cx, cy, rad, t } = frame;
  const length = recipe.len * rad * 0.82;
  const thick = recipe.thick * rad * 1.75;
  const open = openness(recipe, t);
  const look = glance(recipe, t, 1.8 + (recipe.seed % 4) * 0.5);
  const surge = flare(recipe, t);
  const half = rad * (recipe.gap + 0.05);
  const ey = cy + recipe.eyeY * rad + look[1] * rad * 0.03;
  const bloom = flicker(t, recipe.seed) * (1 + surge * 1.6);
  for (const side of [-1, 1] as const) {
    if (only && only !== side) continue;
    const shape = bladeShape(only ? length * 0.8 : length, thick);
    const points = eyePoints(shape, [cx + side * half + look[0] * rad * 0.05, ey], side, recipe.tilt + 0.12, open);
    litPoly(frame, points, bloom, [0.72, 0.28 + surge * 0.25, 0.75 + surge * 0.25]);
  }
}

/** A demon eye's outline: a straight upper lid and a curved lower one. */
function demonShape(length: number, thick: number): Point[] {
  const points: Point[] = [
    [-length / 2, thick * 0.05],
    [length / 2, -thick * 0.42],
  ];
  const steps = 7;
  for (let i = 1; i < steps; i++) {
    const u = i / steps;
    const a = 1 - u;
    points.push([
      a * a * (length / 2) + 2 * a * u * (length * 0.08) + u * u * (-length / 2),
      a * a * (-thick * 0.42) + 2 * a * u * (thick * 1.35) + u * u * (thick * 0.05),
    ]);
  }
  return points;
}

/** Demon: angular eyes with a vertical slit pupil that narrows when they surge. */
function demonEyes(frame: AvatarFrame): void {
  const { ctx, cx, cy, rad, t } = frame;
  const recipe = { ...frame.recipe, glow: FIRE[frame.recipe.fire] ?? FIRE[0] };
  const length = recipe.len * rad * 1.05;
  const thick = recipe.thick * rad * 1.5;
  const open = openness(recipe, t);
  const look = glance(recipe, t, 2.2 + (recipe.seed % 3) * 0.6);
  const surge = flare(recipe, t);
  const half = rad * (recipe.gap + 0.06);
  const bloom = flicker(t, recipe.seed + 3) * (1 + surge * 1.8);
  for (const side of [-1, 1] as const) {
    const points = eyePoints(
      demonShape(length, thick),
      [cx + side * half, cy + recipe.eyeY * rad],
      side,
      recipe.tilt + 0.16,
      open,
    );
    const [mx, my] = middle(points);
    const pupil = { x: mx + look[0] * length * 0.18, y: my + thick * 0.1 * open };
    const slit = Math.max(0.8, thick * (recipe.dark ? 0.13 - surge * 0.06 : 0.14 + surge * 0.1));
    ctx.save();
    if (recipe.dark) {
      glow(ctx, recipe.glow, rad * 0.2 * bloom);
      poly(ctx, points);
      ctx.fillStyle = recipe.glow;
      ctx.fill();
      noGlow(ctx);
      poly(ctx, points);
      ctx.clip();
      ellipse(ctx, pupil, length * 0.2, thick * 0.75 * open, `rgba(255,255,255,${0.55 + surge * 0.4})`);
      ellipse(ctx, pupil, slit, thick * 0.95 * open, SOCKET);
    } else {
      poly(ctx, points);
      ctx.fillStyle = SOCKET;
      ctx.fill();
      poly(ctx, points);
      ctx.clip();
      glow(ctx, recipe.glow, rad * 0.22 * bloom);
      ellipse(ctx, pupil, slit, thick * 0.9 * open, recipe.glow);
      noGlow(ctx);
      ellipse(ctx, pupil, slit * 0.35, thick * 0.6 * open, "rgba(255,255,255,0.85)");
    }
    ctx.restore();
  }
}

/** A filled upright ellipse. */
function ellipse(ctx: AvatarFrame["ctx"], at: { x: number; y: number }, rx: number, ry: number, fill: string): void {
  ctx.beginPath();
  ctx.ellipse(at.x, at.y, Math.max(0, rx), Math.max(0, ry), 0, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

/** Now and then a shard's corner slips one cell sideways: the PS1's wobbling vertices. */
function wobbleNudge(wobble: number, index: number, seed: number): number {
  if (rand(wobble * 13 + index, seed) >= 0.18) return 0;
  return rand(wobble + index * 7, seed) < 0.5 ? -1 : 1;
}

/** The small canvas PS1 shards are drawn on before they are blown up, pixel for pixel. */
let lowRes: OffscreenCanvas | null = null;

/** The three flat-shaded faces of a shard, as vertex indices and a light level. */
const SHARD_FACES = [
  [0, 1, 3, 1.45],
  [3, 1, 2, 1],
  [0, 3, 2, 0.62],
] as const;

/** PS1 shards: low-poly flat-shaded triangles, drawn small with their corners snapped to a wobbling grid. */
function shardEyes(frame: AvatarFrame): void {
  const { ctx, recipe, cx, cy, rad, t } = frame;
  const length = recipe.len * rad * 1.1;
  const thick = recipe.thick * rad * 2.2;
  const open = openness(recipe, t);
  const look = glance(recipe, t, 2 + (recipe.seed % 3) * 0.5);
  const surge = flare(recipe, t);
  const pixel = Math.max(1, Math.round(rad / 26));
  const cells = Math.ceil(ctx.canvas.width / pixel);
  lowRes ??= new OffscreenCanvas(cells, cells);
  if (lowRes.width !== cells) {
    lowRes.width = cells;
    lowRes.height = cells;
  }
  const lo = lowRes.getContext("2d");
  if (!lo) return;
  lo.clearRect(0, 0, cells, cells);
  const wobble = Math.floor((t + recipe.phase) * 6);
  const half = rad * (recipe.gap + 0.07);
  const ey = cy + recipe.eyeY * rad;
  const snap = ([x, y]: Point, index: number): Point => [
    Math.round(x / pixel) + wobbleNudge(wobble, index, recipe.seed),
    Math.round(y / pixel),
  ];
  const local: Point[] = [
    [-length / 2, -thick * 0.42],
    [length / 2, thick * 0.12],
    [-length * 0.18, thick * 0.5],
    [-length * 0.06, -thick * 0.08],
  ];
  for (const side of [-1, 1] as const) {
    const placed = eyePoints(
      local,
      [cx + side * half + look[0] * rad * 0.04, ey + look[1] * rad * 0.02],
      side,
      recipe.tilt + 0.1,
      open,
    );
    const corners = placed.map((point, index) => snap(point, index + (side > 0 ? 4 : 0)));
    for (const [a, b, c, light] of SHARD_FACES) {
      const level = a === 0 && b === 1 ? light + surge * 0.4 : light;
      poly(lo, [corners[a] ?? [0, 0], corners[b] ?? [0, 0], corners[c] ?? [0, 0]]);
      lo.fillStyle = shardFill(frame, level);
      lo.fill();
    }
  }
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  glow(ctx, recipe.glow, rad * 0.18 * (1 + surge));
  ctx.drawImage(lowRes, 0, 0, cells, cells, 0, 0, cells * pixel, cells * pixel);
  ctx.restore();
  noGlow(ctx);
}

/** A shard face's colour: lit faces in the body's light, the rest dark on a light shell. */
function shardFill(frame: AvatarFrame, level: number): string {
  if (frame.recipe.dark || level > 1.2) return shade(frame.recipe.glow, level);
  return level < 0.8 ? SOCKET : "#1d1e28";
}

/** Grille: a short stack of level vents with light behind them, and a sweep running down it. */
function grilleEyes(frame: AvatarFrame): void {
  const { ctx, recipe, cx, cy, rad, t } = frame;
  // The alpha the eyes are drawn at (half for a placeholder): every change here is relative to it.
  const base = ctx.globalAlpha;
  const length = recipe.len * rad * 0.78;
  const vents = recipe.slats + 1;
  const step = rad * 0.072;
  const open = openness(recipe, t);
  const surge = flare(recipe, t);
  const half = rad * (recipe.gap + 0.03);
  const top = cy + recipe.eyeY * rad - (step * vents) / 2 + step * 0.2;
  const sweep = (((t + recipe.phase) * 2.6) % (vents + 3)) - 1;
  for (const side of [-1, 1] as const) {
    const ex = cx + side * half;
    for (let i = 0; i < vents; i++) {
      const y = top + i * step * open;
      const alpha = Math.min(1, 0.45 + 0.55 * Math.max(0, 1 - Math.abs(i - sweep)) + surge * 0.5);
      const height = Math.max(1, step * 0.52 * open);
      const vent: Point[] = [
        [ex - length / 2, y],
        [ex + length / 2, y],
        [ex + length / 2, y + height],
        [ex - length / 2, y + height],
      ];
      ctx.globalAlpha = base * (recipe.dark ? alpha : 1);
      if (recipe.dark) {
        glow(ctx, recipe.glow, rad * 0.14 * (1 + surge));
        poly(ctx, vent);
        ctx.fillStyle = alpha > 0.9 ? shade(recipe.glow, 1.5) : recipe.glow;
        ctx.fill();
      } else {
        poly(ctx, vent);
        ctx.fillStyle = SOCKET;
        ctx.fill();
        ctx.globalAlpha = base * alpha;
        glow(ctx, recipe.glow, rad * 0.12 * (1 + surge));
        ctx.fillStyle = recipe.glow;
        ctx.fillRect(ex - length / 2 + height * 0.4, y + height * 0.3, length - height * 0.8, height * 0.4);
      }
      noGlow(ctx);
      ctx.globalAlpha = base;
    }
  }
}

/** Optic: one plain slit, and on the other side a square implant whose brackets hunt and lock. */
function opticEyes(frame: AvatarFrame): void {
  const { ctx, recipe, cx, cy, rad, t } = frame;
  bladeEyes(frame, recipe.side === 1 ? -1 : 1);
  const size = rad * 0.3;
  const ex = cx + recipe.side * rad * (recipe.gap + 0.05);
  const ey = cy + recipe.eyeY * rad;
  const look = glance(recipe, t, 1.4 + (recipe.seed % 3) * 0.4);
  const open = openness(recipe, t);
  const locked = (t + recipe.phase) % 3.4 < 0.45;
  const reach = size * 0.5 * (locked ? 0.92 : 1.2 + 0.1 * Math.sin(t * 2.4 + recipe.phase));
  const arm = size * 0.24;
  ctx.fillStyle = SOCKET;
  ctx.fillRect(ex - size / 2, ey - size / 2, size, size);
  ctx.lineWidth = Math.max(1, rad * 0.018);
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.strokeRect(ex - size / 2, ey - size / 2, size, size);
  const core = size * 0.3;
  const kx = ex + look[0] * size * 0.2;
  const ky = ey + look[1] * size * 0.2;
  glow(ctx, recipe.glow, rad * 0.25);
  ctx.fillStyle = recipe.glow;
  ctx.fillRect(kx - core / 2, ky - (core / 2) * open, core, core * open);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(kx - core / 6, ky - (core / 6) * open, core / 3, (core / 3) * open);
  noGlow(ctx);
  ctx.strokeStyle = locked ? "#ffffff" : recipe.glow;
  ctx.lineWidth = Math.max(1.2, rad * 0.03);
  ctx.lineCap = "butt";
  glow(ctx, recipe.glow, rad * 0.12);
  for (const [qx, qy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    const x = ex + qx * reach;
    const y = ey + qy * reach;
    path(ctx, [
      [x - qx * arm, y],
      [x, y],
      [x, y - qy * arm],
    ]);
    ctx.stroke();
  }
  noGlow(ctx);
}

/** Mono eye: one flat mechanical aperture whose six or eight blades turn and close to blink. */
function monoEye(frame: AvatarFrame): void {
  const { ctx, recipe, cx, cy, rad, t } = frame;
  const look = glance(recipe, t, 2.4 + (recipe.seed % 3) * 0.6);
  const open = openness(recipe, t);
  const surge = flare(recipe, t);
  const blades = recipe.sides;
  const ex = cx + look[0] * rad * 0.07;
  const ey = cy + recipe.eyeY * rad + look[1] * rad * 0.03;
  const ring = (r: number, a0: number): Point[] =>
    Array.from({ length: blades }, (_, i) => {
      const a = a0 + (i / blades) * Math.PI * 2;
      return [ex + Math.cos(a) * r, ey + Math.sin(a) * r] as Point;
    });
  const outer = rad * 0.31;
  poly(ctx, ring(outer, Math.PI / blades));
  ctx.fillStyle = SOCKET;
  ctx.fill();
  ctx.lineJoin = "miter";
  ctx.lineWidth = Math.max(1, rad * 0.022);
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.stroke();
  const aperture = (0.5 + 0.16 * Math.sin(t * 1.1 + recipe.phase) + surge * 0.18) * Math.max(0.1, open);
  const turn = (t + recipe.phase) * 0.35;
  const iris = ring(outer * 0.82 * aperture, turn);
  glow(ctx, recipe.glow, rad * 0.28 * (1 + surge));
  poly(ctx, iris);
  ctx.fillStyle = recipe.glow;
  ctx.fill();
  noGlow(ctx);
  ctx.strokeStyle = SOCKET;
  ctx.lineWidth = Math.max(1, rad * 0.024);
  for (const [i, [x, y]] of iris.entries()) {
    const a = turn + (i / blades) * Math.PI * 2 + 0.9;
    path(ctx, [
      [x, y],
      [ex + Math.cos(a) * outer * 0.86, ey + Math.sin(a) * outer * 0.86],
    ]);
    ctx.stroke();
  }
  poly(ctx, ring(outer * 0.82 * aperture * 0.34, turn));
  ctx.fillStyle = `rgba(255,255,255,${0.8 + surge * 0.2})`;
  ctx.fill();
}

/** Each style's drawing. */
const DRAW: Record<AvatarEyes, (frame: AvatarFrame) => void> = {
  [AvatarEyes.Blocks]: blockEyes,
  [AvatarEyes.Blades]: (frame) => bladeEyes(frame),
  [AvatarEyes.Shards]: shardEyes,
  [AvatarEyes.Grille]: grilleEyes,
  [AvatarEyes.Optic]: opticEyes,
  [AvatarEyes.Mono]: monoEye,
  [AvatarEyes.Demon]: demonEyes,
};

/** Draw the recipe's eyes. */
export function drawEyes(frame: AvatarFrame): void {
  DRAW[frame.recipe.eyes](frame);
}
