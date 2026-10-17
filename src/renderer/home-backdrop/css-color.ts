/** CSS colours as the GPU takes them: any colour syntax, read back once from a one-pixel canvas. */
import type { Rgba } from "./readable-color.ts";

/** Colours remembered: the theme's and the few picked last (a colour being picked passes through many). */
const COLORS_KEPT = 64;

const colorCache = new Map<string, Rgba>();
let probe: CanvasRenderingContext2D | null = null;

/** A CSS colour as RGBA in 0..1. */
export function rgbaOf(color: string): Rgba {
  const known = colorCache.get(color);
  if (known) return known;
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe) return [0, 0, 0, 1];
  probe.fillStyle = "#000000";
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
  const rgba: Rgba = [r / 255, g / 255, b / 255, 1];
  colorCache.set(color, rgba);
  if (colorCache.size > COLORS_KEPT) colorCache.delete(colorCache.keys().next().value ?? color);
  return rgba;
}
