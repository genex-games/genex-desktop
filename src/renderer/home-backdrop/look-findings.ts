/**
 * What stands out in a made background's moments, measured on their pixels for the model that
 * improves it (`shader-look.ts` draws them): almost nothing drawn, nothing moving, most of the
 * screen lit, or a middle busier than the edges, where home's title and prompt sit; and a frame
 * too slow to draw. Light is a pixel's distance from the page, so it reads the same in both themes.
 */
import { LookFinding } from "../../shared/backdrop-shader.ts";
import { lumaOf, type Rgba } from "./readable-color.ts";

/** A pixel this far from the page counts as drawn, and this far as lit. */
const DRAWN_LIGHT = 0.08;
const LIT_LIGHT = 0.35;
/**
 * Less than this share drawn is empty; more than this share lit glares. Home draws a background
 * faintly, so a filter showing a bright picture's light is fine: glaring is nearly all of it lit.
 */
const EMPTY_SHARE = 0.02;
const GLARING_SHARE = 0.75;
/** Moments whose light differs less than this on average look the same. */
const STILL_CHANGE = 0.003;
/** The middle is busy when its detail passes the edges' by this much (a picture's subject alone stays under it), and is at least this. */
const BUSY_RATIO = 2;
const BUSY_DETAIL = 0.01;
/** The middle box, and the frame within which the edges begin, as shares of the size. */
const MIDDLE = [0.3, 0.7] as const;
const EDGES = [0.2, 0.8] as const;
/** A frame slower than this to draw at the measured size is slow, in milliseconds. */
export const SLOW_FRAME_MS = 3;

/** Each pixel's light: its distance from the page's brightness (`lumaOf`'s weights), 0..1. */
function lightOf(pixels: Uint8Array | Uint8ClampedArray, page: Rgba): Float32Array {
  const base = lumaOf(page);
  const light = new Float32Array(pixels.length / 4);
  for (let i = 0; i < light.length; i++) {
    const luma = (0.2126 * pixels[i * 4] + 0.7152 * pixels[i * 4 + 1] + 0.0722 * pixels[i * 4 + 2]) / 255;
    light[i] = Math.abs(luma - base);
  }
  return light;
}

const within = (share: number, [low, high]: readonly [number, number]): boolean => share >= low && share < high;

/** The average change of light to the next pixel across and down, in the middle box and outside the edge frame. */
function detail(light: Float32Array, [width, height]: readonly [number, number]): { middle: number; edges: number } {
  const sum = { middle: 0, edges: 0 };
  const count = { middle: 0, edges: 0 };
  for (let y = 0; y < height - 1; y++)
    for (let x = 0; x < width - 1; x++) {
      const at = y * width + x;
      const change = Math.abs(light[at + 1] - light[at]) + Math.abs(light[at + width] - light[at]);
      const across = x / width;
      const down = y / height;
      if (within(across, MIDDLE) && within(down, MIDDLE)) {
        sum.middle += change;
        count.middle++;
      } else if (!within(across, EDGES) || !within(down, EDGES)) {
        sum.edges += change;
        count.edges++;
      }
    }
  return { middle: sum.middle / Math.max(1, count.middle), edges: sum.edges / Math.max(1, count.edges) };
}

const share = (light: Float32Array, above: number): number =>
  light.filter((value) => value > above).length / light.length;

/** The mean change of light between one moment and the next. */
function change(moments: readonly Float32Array[]): number {
  let total = 0;
  for (let m = 1; m < moments.length; m++) {
    let sum = 0;
    for (let i = 0; i < moments[m].length; i++) sum += Math.abs(moments[m][i] - moments[m - 1][i]);
    total += sum / moments[m].length;
  }
  return total / Math.max(1, moments.length - 1);
}

/** What stands out in `frames` (RGBA moments of `size` drawn over `page`) and a frame's cost in milliseconds. */
export function lookFindings(
  frames: readonly (Uint8Array | Uint8ClampedArray)[],
  size: readonly [number, number],
  page: Rgba,
  frameMs: number,
): LookFinding[] {
  const found: LookFinding[] = [];
  const moments = frames.map((pixels) => lightOf(pixels, page));
  const drawn = moments.reduce((sum, light) => sum + share(light, DRAWN_LIGHT), 0) / Math.max(1, moments.length);
  if (moments.length && drawn < EMPTY_SHARE) found.push(LookFinding.Empty);
  else if (moments.length > 1 && change(moments) < STILL_CHANGE) found.push(LookFinding.Still);
  const lit = moments.reduce((sum, light) => sum + share(light, LIT_LIGHT), 0) / Math.max(1, moments.length);
  if (lit > GLARING_SHARE) found.push(LookFinding.Glaring);
  const last = moments.at(-1);
  const { middle, edges } = last ? detail(last, size) : { middle: 0, edges: 0 };
  if (middle > BUSY_DETAIL && middle > edges * BUSY_RATIO) found.push(LookFinding.BusyCentre);
  if (frameMs > SLOW_FRAME_MS) found.push(LookFinding.Slow);
  return found;
}
