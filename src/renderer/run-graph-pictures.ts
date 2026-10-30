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
/** A pixel counts as changed when one of its colour channels moved by more than this: past JPEG noise. */
const CHANGE_NOISE = 24;
/** Below this share of changed pixels, two pictures of one frame read as the same picture. */
export const UNCHANGED_SHARE = 0.002;
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

/** The demo cameras record play, not the scene: a step's pictures never include them. */
const isDemoCamera = (camera: string): boolean => camera.startsWith("demo");

/** One picture an opened step can show: the lead's named picture of its change, or one camera's. */
export interface ShotView {
  key: string;
  shot: Shot;
  /** the picture the lead named as showing what the step changed */
  changed: boolean;
}

const CHANGED_VIEW_KEY = "changed";
const cameraViewKey = (camera: string): string => `camera:${camera}`;

/** A try's pictures: the one the lead named first, then each scene camera once. */
export function shotViews(node: IterationNode): ShotView[] {
  const views: ShotView[] = node.shown ? [{ key: CHANGED_VIEW_KEY, shot: node.shown, changed: true }] : [];
  for (const shot of node.shots) {
    const key = cameraViewKey(shot.camera);
    if (isDemoCamera(shot.camera) || views.some((view) => view.key === key)) continue;
    views.push({ key, shot, changed: false });
  }
  return views;
}

/** The picture a step opens on: the one its card wears (`savePointShot`), else its first. */
export function openingView(views: readonly ShotView[], card: Shot | null): ShotView | null {
  return views.find((view) => view.shot.path === card?.path) ?? views[0] ?? null;
}

/**
 * The same picture of the step before, for the compare: that camera's, never another one's. The
 * lead's named picture is its own framing, so it has none.
 */
export function viewBefore(view: ShotView, before: IterationNode): Shot | null {
  if (view.changed) return null;
  return before.shots.find((shot) => shot.camera === view.shot.camera) ?? null;
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

/**
 * The share of pixels, 0 to 1, whose colour moved past compression noise between two frames of one
 * size: a small sprite changed counts, the same frame saved twice does not. Frames of different
 * sizes changed entirely.
 */
export function changedShare(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 1;
  let changed = 0;
  for (let at = 0; at < a.length; at += CHANNELS_PER_PIXEL) {
    for (let channel = 0; channel < COLOUR_CHANNELS; channel++) {
      if (Math.abs((a[at + channel] ?? 0) - (b[at + channel] ?? 0)) > CHANGE_NOISE) {
        changed += 1;
        break;
      }
    }
  }
  return changed / (a.length / CHANNELS_PER_PIXEL);
}

/** How a card shows two pictures of one frame: the compare, the newer alone saying nothing changed, or the newer alone. */
export const PairView = { Compare: "compare", Unchanged: "unchanged", Single: "single" } as const;
export type PairView = (typeof PairView)[keyof typeof PairView];

/**
 * How to show `now` beside `before`, two pictures of the same frame, by `share`, their measured
 * change: undefined while it is measured, null when either could not be read. Only a measured
 * change at or past `UNCHANGED_SHARE` earns the compare; below it the picture did not visibly change.
 */
export function pairView(before: string | null, now: string | null, share: number | null | undefined): PairView {
  if (!before || !now || before === now || share === undefined || share === null) return PairView.Single;
  return share < UNCHANGED_SHARE ? PairView.Unchanged : PairView.Compare;
}
