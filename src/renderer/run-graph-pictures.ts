/**
 * Which picture a save point wears on the Builds graph. The lead names the picture that shows what
 * it changed (`shown`): that is the save point's own. A save point without one wears the camera
 * whose frame changed most since the save point before it, so a run's save points read as what
 * each one did rather than the same first camera every time; a camera new since then changed most
 * of all. The first save point, or one whose frames are not measured yet, wears `thumbShot`'s.
 *
 * Pure: the pixels are read by `panels/run-stills.ts`, which hands the differences in.
 */
import { type IterationNode, type Shot, thumbShot } from "./run-graph.ts";

/** How much a frame changed when its camera is new since the save point before. */
const NEW_CAMERA_CHANGE = 1;
/** The colour channels compared per pixel (red, green, blue); the fourth, alpha, is not. */
const COLOUR_CHANNELS = 3;
const CHANNELS_PER_PIXEL = 4;
const CHANNEL_MAX = 255;

/** One camera both save points looked through: its picture then and now. */
export interface CameraPair {
  camera: string;
  before: string;
  now: string;
}

/** The cameras a save point shares with the one before it, to measure: none when it names its own picture. */
export function camerasToCompare(node: IterationNode, earlier: IterationNode | null | undefined): CameraPair[] {
  if (node.shown || !earlier) return [];
  const before = new Map(earlier.shots.map((shot) => [shot.camera, shot.path]));
  return node.shots.flatMap((shot) => {
    const path = before.get(shot.camera);
    return path ? [{ camera: shot.camera, before: path, now: shot.path }] : [];
  });
}

/**
 * The save point's picture: the one the lead named, else the camera that changed most since
 * `earlier` (a new camera first, then the largest measured change, the first camera on a tie),
 * else `thumbShot`'s while nothing is measured.
 */
export function savePointShot(
  node: IterationNode,
  earlier: IterationNode | null | undefined,
  changes: ReadonlyMap<string, number>,
): Shot | null {
  if (node.shown) return node.shown;
  if (!earlier) return thumbShot(node);
  const seen = new Set(earlier.shots.map((shot) => shot.camera));
  const changeOf = (shot: Shot): number | undefined =>
    seen.has(shot.camera) ? changes.get(shot.camera) : NEW_CAMERA_CHANGE;
  let best: Shot | null = null;
  let most = -1;
  for (const shot of node.shots) {
    const change = changeOf(shot);
    if (change === undefined || change <= most) continue;
    best = shot;
    most = change;
  }
  return best ?? thumbShot(node);
}

/**
 * How different two frames of one size are, 0 (the same) to 1: the mean difference of their colour
 * channels. Frames of different sizes are as different as can be.
 */
export function frameDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 1;
  let total = 0;
  let channels = 0;
  for (let at = 0; at < a.length; at += CHANNELS_PER_PIXEL) {
    for (let channel = 0; channel < COLOUR_CHANNELS; channel++) {
      total += Math.abs((a[at + channel] ?? 0) - (b[at + channel] ?? 0));
      channels += 1;
    }
  }
  return total / (channels * CHANNEL_MAX);
}
