/** Keyframe tracks over film frames, and the camera that zooms over the app. */
import { Easing } from "remotion";

export type Ease = (t: number) => number;

/** Arrivals settle; camera moves start and stop softly; the cursor glides like a hand. */
export const EASE = Easing.bezier(0.22, 1, 0.36, 1);
export const EASE_IN_OUT = Easing.bezier(0.65, 0, 0.35, 1);
export const CURSOR_EASE = Easing.bezier(0.45, 0, 0.2, 1);

/**
 * A keyframe track: `values[i]` at film frame `at[i]`, eased between each pair of keyframes as a
 * CSS animation does (Remotion's `interpolate` eases the whole range instead).
 */
export function keys(frame: number, at: readonly number[], values: readonly number[], ease: Ease = EASE): number {
  if (frame <= at[0]) return values[0];
  for (let i = 1; i < at.length; i++) {
    if (frame > at[i]) continue;
    const span = at[i] - at[i - 1];
    const t = span === 0 ? 1 : (frame - at[i - 1]) / span;
    return values[i - 1] + (values[i] - values[i - 1]) * ease(t);
  }
  return values[values.length - 1];
}

/**
 * Where the camera looks at frame `f`: the app point (`x`, `y`) at the film's centre, zoomed `z`.
 * `dip` pulls the camera back during the move into this shot (0.3 = 30 % wider halfway), so a long
 * pan between two close-ups shows where it is going instead of whipping across.
 */
export interface Shot {
  f: number;
  x: number;
  y: number;
  z: number;
  dip?: number;
}

/** The camera between its shots: one soft move per pair, zoom eased in log space so it feels even. */
export function camera(frame: number, shots: readonly Shot[]): { x: number; y: number; z: number } {
  const first = shots[0];
  if (frame <= first.f) return first;
  for (let i = 1; i < shots.length; i++) {
    const to = shots[i];
    if (frame > to.f) continue;
    const from = shots[i - 1];
    const u = EASE_IN_OUT((frame - from.f) / (to.f - from.f));
    const zoom = Math.exp(Math.log(from.z) + (Math.log(to.z) - Math.log(from.z)) * u);
    return {
      x: from.x + (to.x - from.x) * u,
      y: from.y + (to.y - from.y) * u,
      z: zoom * (1 - (to.dip ?? 0) * Math.sin(Math.PI * u)),
    };
  }
  return shots[shots.length - 1];
}
