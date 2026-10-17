/** Colours a live background draws in, kept readable on the page they are drawn over. */

/** A colour as red, green, blue and alpha in 0..1. */
export type Rgba = [number, number, number, number];

/**
 * On a dark page a colour must be at least this bright to show (the theme's accent already is, so
 * it is drawn as it is); on a light one at most this bright.
 */
const GLOW_FLOOR = 0.2;
const INK_CEILING = 0.55;

/** A colour's brightness, 0..1. */
export const lumaOf = ([r, g, b]: Rgba): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * A colour that reads on its page, in its own hue: one too dark to glow on a dark page is brought
 * to full strength and then lifted towards white; one too light to show on a light page is darkened.
 */
export function readableColor(color: Rgba, darkPage: boolean): Rgba {
  const [r, g, b] = color;
  const level = lumaOf(color);
  if (!darkPage) {
    if (level <= INK_CEILING) return color;
    const keep = INK_CEILING / level;
    return [r * keep, g * keep, b * keep, 1];
  }
  if (level >= GLOW_FLOOR) return color;
  const peak = Math.max(r, g, b, 0.001);
  const full: Rgba = [r / peak, g / peak, b / peak, 1];
  const fullLevel = lumaOf(full);
  if (fullLevel >= GLOW_FLOOR) return full;
  const lift = (GLOW_FLOOR - fullLevel) / (1 - fullLevel);
  return [full[0] + (1 - full[0]) * lift, full[1] + (1 - full[1]) * lift, full[2] + (1 - full[2]) * lift, 1];
}
