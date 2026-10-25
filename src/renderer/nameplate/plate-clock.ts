/**
 * When the nameplate painter draws, as plain rules over a plate's state: a lit plate on screen moves
 * (unless it is a 2D still, motion is reduced or resting, or a modal covers it), and a plate on
 * screen with a frame owed paints once. Nothing due, the painter's clock sleeps.
 */
import { SECOND_MS } from "../../shared/duration.ts";

/** A frame at most this often: 30 a second. */
export const FRAME_MS = SECOND_MS / 30;
/**
 * How early a frame may come: timestamps jitter around the display's own beat, and a strict
 * 33.3 ms gate alternates two and three beats on a 60 Hz screen.
 */
const FRAME_SLACK_MS = 2;

/** What the painter knows about one plate this frame. */
export interface PlateClockState {
  /** On screen. */
  visible: boolean;
  /** A frame is owed (a new look, a theme change, just lit). */
  dirty: boolean;
  /** Lit: its clock may run. */
  animating: boolean;
  /** Drawn as a 2D still, which looks the same at every moment. */
  still: boolean;
  /** Reduce Motion is on. */
  reduced: boolean;
  /** The app's motion rests (idle, out of sight). */
  resting: boolean;
  /** A modal covers it. */
  covered: boolean;
}

/** Whether a plate's clock runs this frame. */
export const plateMoves = (plate: PlateClockState): boolean =>
  plate.animating && plate.visible && !plate.still && !plate.reduced && !plate.resting && !plate.covered;

/** Whether a plate paints this frame: on screen, and owed a frame or moving. */
export const plateDue = (plate: PlateClockState): boolean => plate.visible && (plate.dirty || plateMoves(plate));

/** Whether enough time has passed since the last frame (0: none yet) for another. */
export const frameDue = (now: number, last: number): boolean => !last || now - last >= FRAME_MS - FRAME_SLACK_MS;
