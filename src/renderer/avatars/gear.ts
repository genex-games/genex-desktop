/**
 * The generated avatar's gear, flat-shaded like a PS1 model in gunmetal or bone with a hot rim in
 * the body's light: horns, blades, spikes and a mast behind the body; a scar or a sigil marked on
 * the shell; a jack or a headset in front of it.
 */
import { AvatarGear } from "../../shared/avatar-recipe.ts";
import {
  type AvatarFrame,
  around,
  type Ctx2D,
  glow,
  noGlow,
  type Point,
  path,
  poly,
  rand,
  SOCKET,
} from "./draw-kit.ts";

/** Gear materials: lit facet and shadow facet. Gunmetal twice, so bone is the rarer one. */
const METALS = [
  ["#6a6e84", "#262833"],
  ["#6a6e84", "#262833"],
  ["#e6dcc6", "#9a8d74"],
] as const;
const GUNMETAL = METALS[0];
/** The mast's LED, lit and dark. */
const LED = { on: "#ff2a3a", off: "#5a1016" } as const;

/** The material a recipe's gear is made of: bone for one seed in three. */
const materialOf = (frame: AvatarFrame) => (frame.recipe.seed % 3 === 0 ? METALS[2] : GUNMETAL);

/** A tapering limb along a centre line: a lit facet, a shadow facet and a glowing rim on the lit edge. */
function limb(
  frame: AvatarFrame,
  line: readonly Point[],
  widths: readonly number[],
  metal: readonly [string, string],
): void {
  const { ctx, recipe, rad } = frame;
  const lit: Point[] = [];
  const dark: Point[] = [];
  for (const [i, [x, y]] of line.entries()) {
    const next = line[Math.min(line.length - 1, i + 1)] ?? [x, y];
    const before = line[Math.max(0, i - 1)] ?? [x, y];
    const dx = next[0] - before[0];
    const dy = next[1] - before[1];
    const length = Math.hypot(dx, dy) || 1;
    const w = widths[i] ?? 0;
    lit.push([x - (dy / length) * w, y + (dx / length) * w]);
    dark.push([x + (dy / length) * w, y - (dx / length) * w]);
  }
  poly(ctx, [...line, ...lit.toReversed()]);
  ctx.fillStyle = metal[0];
  ctx.fill();
  poly(ctx, [...line, ...dark.toReversed()]);
  ctx.fillStyle = metal[1];
  ctx.fill();
  path(ctx, lit);
  glow(ctx, recipe.glow, rad * 0.12);
  ctx.lineWidth = Math.max(1, rad * 0.022);
  ctx.strokeStyle = recipe.glow;
  ctx.globalAlpha = 0.85;
  ctx.stroke();
  ctx.globalAlpha = 1;
  noGlow(ctx);
}

/** One horn on side `side`, curling as the recipe says. */
function horn(frame: AvatarFrame, side: -1 | 1): void {
  const { recipe, cx, cy, rad } = frame;
  const turn = ([-0.12, -0.3, 0.1][recipe.curl] ?? 0) * side;
  const segment = rad * ([0.2, 0.17, 0.2][recipe.curl] ?? 0.2);
  let angle = -Math.PI / 2 + side * 0.72;
  let point = around(cx, cy, rad * 0.86, angle);
  const line: Point[] = [point];
  for (let i = 0; i < 4; i++) {
    angle += turn;
    point = [point[0] + Math.cos(angle) * segment, point[1] + Math.sin(angle) * segment];
    line.push(point);
  }
  limb(
    frame,
    line,
    [0.2, 0.16, 0.11, 0.055, 0].map((w) => w * rad),
    materialOf(frame),
  );
}

/** Two swept-back blades on each side. */
function blades(frame: AvatarFrame): void {
  const { cx, cy, rad } = frame;
  for (const side of [-1, 1] as const)
    for (const k of [0, 1]) {
      const a = -Math.PI / 2 + side * (1.02 + k * 0.3);
      const base = around(cx, cy, rad * 0.9, a);
      const up = a - side * 0.32;
      const length = rad * (0.78 - k * 0.24);
      const line: Point[] = [
        base,
        [base[0] + Math.cos(up) * length * 0.5, base[1] + Math.sin(up) * length * 0.5],
        [base[0] + Math.cos(up) * length, base[1] + Math.sin(up) * length],
      ];
      limb(frame, line, [rad * 0.12, rad * 0.075, 0], GUNMETAL);
    }
}

/** A crown of five spikes. */
function spikes(frame: AvatarFrame): void {
  const { cx, cy, rad } = frame;
  for (const [j, height] of [0.22, 0.34, 0.44, 0.34, 0.22].entries()) {
    const a = -Math.PI / 2 + (j - 2) * 0.36;
    const line: Point[] = [
      around(cx, cy, rad * 0.88, a),
      around(cx, cy, rad * 0.9 + rad * height * 0.5, a),
      around(cx, cy, rad * 0.9 + rad * height, a),
    ];
    limb(frame, line, [rad * 0.12, rad * 0.07, 0], materialOf(frame));
  }
}

/** A bent mast with a cross-bar and a blinking red LED. */
function mast(frame: AvatarFrame): void {
  const { ctx, recipe, cx, cy, rad, t } = frame;
  const a = -Math.PI / 2 + recipe.side * 0.5;
  const base = around(cx, cy, rad * 0.9, a);
  const knee: Point = [base[0] + Math.cos(a) * rad * 0.3, base[1] + Math.sin(a) * rad * 0.3];
  const top: Point = [knee[0], knee[1] - rad * 0.3];
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  ctx.strokeStyle = GUNMETAL[0];
  ctx.lineWidth = Math.max(2, rad * 0.06);
  path(ctx, [base, knee, top]);
  ctx.stroke();
  ctx.lineWidth = Math.max(1, rad * 0.025);
  path(ctx, [
    [top[0] - rad * 0.1, top[1] + rad * 0.09],
    [top[0] + rad * 0.1, top[1] + rad * 0.09],
  ]);
  ctx.stroke();
  const on = Math.floor((t + recipe.phase) * 1.6) % 2 === 0;
  const led = rad * 0.08;
  ctx.fillStyle = on ? LED.on : LED.off;
  if (on) glow(ctx, LED.on, rad * 0.3);
  ctx.fillRect(top[0] - led / 2, top[1] - led, led, led);
  noGlow(ctx);
}

/** Gear behind the body, drawn before it. */
export function drawBackGear(frame: AvatarFrame): void {
  const gear = frame.recipe.gear;
  if (gear === AvatarGear.Horns) {
    horn(frame, -1);
    horn(frame, 1);
  }
  if (gear === AvatarGear.Blades) blades(frame);
  if (gear === AvatarGear.Spikes) spikes(frame);
  if (gear === AvatarGear.Mast) mast(frame);
}

/** A glowing fissure from the crown past one eye, with a short branch. */
function scar(frame: AvatarFrame): void {
  const { ctx, recipe, cx, cy, rad, t } = frame;
  const side = recipe.side;
  const pulse = 0.65 + 0.35 * Math.sin(t * 2.2 + recipe.phase);
  let x = cx + side * rad * 0.5;
  let y = cy - rad * 0.95;
  const trunk: Point[] = [[x, y]];
  for (let i = 1; i < 7; i++) {
    x += (i % 2 ? 1 : -1) * rad * (0.05 + rand(i, recipe.seed) * 0.06) + side * rad * 0.02;
    y += rad * 0.21;
    trunk.push([x, y]);
  }
  const fork = trunk[2] ?? [x, y];
  const branch: Point[] = [
    fork,
    [fork[0] + side * rad * 0.14, fork[1] + rad * 0.05],
    [fork[0] + side * rad * 0.24, fork[1] + rad * 0.16],
  ];
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, rad, 0, Math.PI * 2);
  ctx.clip();
  ctx.lineJoin = "miter";
  ctx.lineCap = "butt";
  for (const [line, weight] of [
    [trunk, 1],
    [branch, 0.6],
  ] as const) {
    crackStroke(ctx, line, weight, { rad, glow: recipe.glow, pulse });
  }
  ctx.restore();
}

/** One line of the scar: a dark cut, its glow, and a white-hot thread down the middle. */
function crackStroke(
  ctx: Ctx2D,
  line: readonly Point[],
  weight: number,
  look: { rad: number; glow: string; pulse: number },
): void {
  path(ctx, line);
  ctx.strokeStyle = SOCKET;
  ctx.lineWidth = look.rad * 0.1 * weight;
  ctx.stroke();
  glow(ctx, look.glow, look.rad * 0.3 * look.pulse);
  ctx.strokeStyle = look.glow;
  ctx.lineWidth = look.rad * 0.045 * weight;
  ctx.stroke();
  noGlow(ctx);
  ctx.strokeStyle = `rgba(255,255,255,${0.8 * look.pulse})`;
  ctx.lineWidth = look.rad * 0.01 * weight;
  ctx.stroke();
}

/** A glowing triangle-and-cross mark on the forehead. */
function sigil(frame: AvatarFrame): void {
  const { ctx, recipe, cx, cy, rad, t } = frame;
  const pulse = 0.6 + 0.4 * Math.sin(t * 1.7 + recipe.phase);
  const sy = cy - rad * 0.6;
  const r = rad * 0.15;
  glow(ctx, recipe.glow, rad * 0.2 * pulse);
  ctx.lineJoin = "miter";
  ctx.lineWidth = Math.max(1.2, rad * 0.04);
  ctx.strokeStyle = recipe.glow;
  poly(ctx, [
    [cx, sy - r],
    [cx + r, sy + r * 0.7],
    [cx - r, sy + r * 0.7],
  ]);
  ctx.stroke();
  path(ctx, [
    [cx, sy - r * 1.8],
    [cx, sy + r * 1.5],
  ]);
  ctx.stroke();
  path(ctx, [
    [cx - r * 1.5, sy - r * 0.2],
    [cx + r * 1.5, sy - r * 0.2],
  ]);
  ctx.globalAlpha = 0.6;
  ctx.stroke();
  ctx.globalAlpha = 1;
  noGlow(ctx);
}

/** Marks on the shell itself (a scar, a sigil), drawn over the body at every size. */
export function drawSkinGear(frame: AvatarFrame): void {
  if (frame.recipe.gear === AvatarGear.Scar) scar(frame);
  if (frame.recipe.gear === AvatarGear.Sigil) sigil(frame);
}

/** A cable jack in the side, its lead running off the bottom, with a status light. */
function jack(frame: AvatarFrame): void {
  const { ctx, recipe, cx, cy, rad, t } = frame;
  const side = recipe.side;
  const a = side > 0 ? 0.32 : Math.PI - 0.32;
  const normal: Point = [Math.cos(a), Math.sin(a)];
  const socket = around(cx, cy, rad * 0.9, a);
  const plug: Point = [socket[0] + normal[0] * rad * 0.2, socket[1] + normal[1] * rad * 0.2];
  ctx.lineCap = "butt";
  ctx.strokeStyle = GUNMETAL[1];
  ctx.lineWidth = rad * 0.075;
  ctx.beginPath();
  ctx.moveTo(plug[0], plug[1]);
  ctx.bezierCurveTo(
    plug[0] + normal[0] * rad * 0.3,
    plug[1] + normal[1] * rad * 0.3,
    plug[0] + side * rad * 0.12,
    cy + rad,
    plug[0] - side * rad * 0.05,
    ctx.canvas.height + 2,
  );
  ctx.stroke();
  ctx.strokeStyle = GUNMETAL[0];
  ctx.lineWidth = rad * 0.025;
  ctx.stroke();
  const w = rad * 0.13;
  ctx.save();
  ctx.translate((socket[0] + plug[0]) / 2, (socket[1] + plug[1]) / 2);
  ctx.rotate(a);
  ctx.fillStyle = GUNMETAL[0];
  ctx.fillRect(-rad * 0.14, -w / 2, rad * 0.28, w);
  ctx.fillStyle = GUNMETAL[1];
  ctx.fillRect(-rad * 0.14, 0, rad * 0.28, w / 2);
  const on = Math.floor((t + recipe.phase) * 3) % 3 !== 0;
  ctx.fillStyle = on ? recipe.glow : "#222";
  if (on) glow(ctx, recipe.glow, rad * 0.2);
  ctx.fillRect(rad * 0.02, -w * 0.18, rad * 0.06, w * 0.36);
  noGlow(ctx);
  ctx.restore();
}

/** A headset: an angular ear plate, a boom to the mouth, and a level meter. */
function headset(frame: AvatarFrame): void {
  const { ctx, recipe, cx, cy, rad, t } = frame;
  const side = recipe.side;
  const x = cx + side * rad * 0.94;
  const y = cy - rad * 0.05;
  const hw = rad * 0.15;
  const hh = rad * 0.32;
  const plate: Point[] = [
    [x - hw, y - hh + hw * 0.6],
    [x - hw * 0.4, y - hh],
    [x + hw * 0.4, y - hh],
    [x + hw, y - hh + hw * 0.6],
    [x + hw, y + hh - hw * 0.6],
    [x + hw * 0.4, y + hh],
    [x - hw * 0.4, y + hh],
    [x - hw, y + hh - hw * 0.6],
  ];
  ctx.lineCap = "butt";
  ctx.strokeStyle = GUNMETAL[0];
  ctx.lineWidth = Math.max(2, rad * 0.05);
  path(ctx, [
    [x - side * hw * 0.5, y + hh * 0.7],
    [cx + side * rad * 0.62, cy + rad * 0.55],
    [cx + side * rad * 0.34, cy + rad * 0.6],
  ]);
  ctx.stroke();
  ctx.fillStyle = GUNMETAL[1];
  ctx.fillRect(cx + side * rad * 0.34 - rad * 0.05, cy + rad * 0.6 - rad * 0.03, rad * 0.1, rad * 0.06);
  poly(ctx, plate);
  ctx.fillStyle = GUNMETAL[1];
  ctx.fill();
  poly(ctx, [...plate.slice(0, 5), [x, y + hh * 0.2]]);
  ctx.fillStyle = GUNMETAL[0];
  ctx.fill();
  const level = 0.5 + 0.5 * Math.abs(Math.sin(t * 5 + recipe.phase)) * Math.abs(Math.sin(t * 2.3));
  const bar = hh * 1.1 * level;
  glow(ctx, recipe.glow, rad * 0.15);
  ctx.fillStyle = recipe.glow;
  ctx.fillRect(x - rad * 0.018, y + hh * 0.55 - bar, rad * 0.036, bar);
  noGlow(ctx);
}

/** Gear in front of the body, drawn after the eyes. */
export function drawFrontGear(frame: AvatarFrame): void {
  if (frame.recipe.gear === AvatarGear.Jack) jack(frame);
  if (frame.recipe.gear === AvatarGear.Headset) headset(frame);
}
