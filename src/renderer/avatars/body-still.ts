/**
 * A generated avatar's body where the GPU cannot draw it: the same sphere in the recipe's palette,
 * lit from the upper left like the shader lights it, as a still 2D gradient. The eyes and gear
 * over it are the same either way.
 */
import type { AvatarRecipe } from "../../shared/avatar-recipe.ts";
import { type Ctx2D, rgb } from "./draw-kit.ts";

/** How light a colour reads, 0..1. */
const luma = (hex: string): number => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** Draw the body filling a `pixels`-wide square canvas. */
export function drawStillBody(ctx: Ctx2D, recipe: AvatarRecipe, pixels: number): void {
  const [light, mid, dark, deepest] = recipe.palette.toSorted((a, b) => luma(b) - luma(a));
  const r = pixels / 2;
  ctx.clearRect(0, 0, pixels, pixels);
  const shade = ctx.createRadialGradient(r * 0.62, r * 0.55, r * 0.08, r, r, r);
  shade.addColorStop(0, light ?? "#ffffff");
  shade.addColorStop(0.45, mid ?? "#cccccc");
  shade.addColorStop(0.85, dark ?? "#888888");
  shade.addColorStop(1, deepest ?? "#444444");
  ctx.beginPath();
  ctx.arc(r, r, r, 0, Math.PI * 2);
  ctx.fillStyle = recipe.dark ? reversed(ctx, r, [deepest, dark, mid]) : shade;
  ctx.fill();
}

/** A dark shell: deep in the middle with its light at the rim, as the glowing bodies read. */
function reversed(ctx: Ctx2D, r: number, [deep, dark, mid]: (string | undefined)[]): CanvasGradient {
  const rim = ctx.createRadialGradient(r * 0.8, r * 0.75, r * 0.1, r, r, r);
  rim.addColorStop(0, dark ?? "#222222");
  rim.addColorStop(0.75, deep ?? "#000000");
  rim.addColorStop(1, mid ?? "#666666");
  return rim;
}
