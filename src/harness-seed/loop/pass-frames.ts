/**
 * The frames an evidence pass takes on its own rather than by pointing the game at a viewpoint
 * with `debugCamera`: a demo's end (`demo:<name>`), the drive's corner (`drive:corner`) and the
 * view the user left the window on (`user:view`). Never asked of the game, never "not registered
 * in config.cameras", and a check on one depends on what takes it (a demo, the drive).
 *
 * A module of its own: a seed upgrade keeps a cameras.ts the agent
 * edited, and a name added there would stop every importer linking beside that older copy.
 */

/** A demo's end frame is filed as `demo:<name>`: a check on that camera waits on that demo. */
export const DEMO_FRAME = "demo:";

/**
 * The frame the evidence drive takes as a racer turns into a corner (evidence.ts `watchCorner`):
 * what a player sees in a corner — its warnings, the braking, the line — which a frame taken
 * wherever thirty seconds of driving happened to end almost never shows.
 */
export const CORNER_CAMERA = "drive:corner";

/** The view the user left the window on, as the compositor photographed it. */
const USER_VIEW = "user:view";

/** The demo a `demo:<name>` frame is the end of, or "" for any other camera. */
export function demoOfFrame(camera: unknown): string {
  const name = String(camera ?? "");
  return name.startsWith(DEMO_FRAME) ? name.slice(DEMO_FRAME.length) : "";
}

/** Is this a frame the pass takes on its own — a demo's end, the drive's corner, the user's view? */
export function isPassFrame(camera: unknown): boolean {
  return demoOfFrame(camera) !== "" || camera === CORNER_CAMERA || camera === USER_VIEW;
}
