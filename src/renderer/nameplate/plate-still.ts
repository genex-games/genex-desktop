/**
 * A nameplate where the GPU cannot draw: a still in the plate's own colours, the accent glowing in
 * from the right over the deep ground (a pale one on a light theme's paper), so the row still reads
 * as the person's.
 */
import type { PlateRecipe } from "../../shared/plate-recipe.ts";

/** Where the glow sits, as shares of the width and height, and how far it reaches. */
const GLOW_AT = { x: 0.78, y: 0.45, reach: 0.9 } as const;

/** The pale ground a light theme's still is drawn on. */
const PAPER = "#f7f7f9";

/** Draw the still into a 2D context `width` by `height` pixels, on `paper` for a light theme. */
export function drawStillPlate(
  ctx: CanvasRenderingContext2D,
  recipe: PlateRecipe,
  width: number,
  height: number,
  paper = false,
): void {
  const { colors } = recipe;
  const ground = ctx.createLinearGradient(0, 0, width, 0);
  ground.addColorStop(0, paper ? PAPER : colors.deep);
  ground.addColorStop(1, paper ? PAPER : colors.mid);
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, width, height);
  const glow = ctx.createRadialGradient(
    width * GLOW_AT.x,
    height * GLOW_AT.y,
    0,
    width * GLOW_AT.x,
    height * GLOW_AT.y,
    width * GLOW_AT.reach * 0.5,
  );
  glow.addColorStop(0, `${colors.acc}cc`);
  glow.addColorStop(0.45, `${colors.acc}33`);
  glow.addColorStop(1, `${colors.acc}00`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
}
