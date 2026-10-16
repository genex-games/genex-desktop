import { channels } from "./oklch.ts";
/** Relative sRGB luminance, using the WCAG 2 contrast definition. */
export function luminance(color: string): number {
  const [r, g, b] = channels(color).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}
/** Contrast ratio from 1:1 to 21:1 for two validated opaque hex colours. */
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
