/**
 * Putting the camera back on the horizon after a gesture that may have pitched it. The directions
 * and ack drags go DOWN-and-right; never undone, they leave a drag-to-look game's camera aimed at
 * the ground, and the judge scores the game on frames of its own floor.
 *
 * CLOSED-LOOP, not a blind inverse leg: drag sensitivity differs by an order of magnitude between
 * games, so the camera is read between attempts and the restore stops as soon as pitch is inside the
 * target. Every outcome is recorded, because a restore that silently failed is the defect it fixes.
 */
import type { CameraSample } from "../instrument.ts";
import { cameraHeadingDeg, cameraPitchDeg, restoreDragTargetY } from "../verdicts.ts";

/** Where a restored camera may rest: looser than the ruin limit, since the goal is recognisable frames. */
export const PITCH_RESTORE_TARGET_DEG = 20;
/** Attempts before the restore gives up and says so. */
export const PITCH_RESTORE_ATTEMPTS = 3;
/** The restore drag's length, as a share of the viewport height. */
export const PITCH_RESTORE_DRAG_SHARE = 0.18;
/** A pitch change under this is a drag the game did not read as look input. */
export const PITCH_UNMOVED_DEG = 0.5;
/** How long the camera gets to settle after a restore drag. */
export const PITCH_SETTLE_MS = 200;

/** How a restore ended. */
export const PitchRestore = {
  NoReading: "no-reading",
  AlreadyLevel: "already-level",
  Unmoved: "unmoved",
  Restored: "restored",
  GaveUp: "gave-up",
} as const;
export type PitchRestore = (typeof PitchRestore)[keyof typeof PitchRestore];

/** What the restore did. */
export interface PitchRestoreResult {
  outcome: PitchRestore;
  attempts: number;
  fromDeg: number | null;
  toDeg: number | null;
}

/** What the restore needs from the browser, so a fake camera can stand in for it. */
export interface PitchRestoreDeps {
  viewportHeight: number;
  readCamera: () => Promise<CameraSample | null>;
  /** A vertical drag of `dyPx` from the viewport centre; resolves whether it went out. */
  drag: (dyPx: number) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
}

/** The heading of a reading, `null` without one. */
export function headingOf(sample: CameraSample | null): number | null {
  return sample ? cameraHeadingDeg(sample) : null;
}

/** The pitch of a reading, `null` without one. */
export function pitchOf(sample: CameraSample | null): number | null {
  return sample ? cameraPitchDeg(sample) : null;
}

/** Drag the camera back towards the horizon, reading it between attempts. */
export async function restoreCameraPitch(deps: PitchRestoreDeps): Promise<PitchRestoreResult> {
  const before = pitchOf(await deps.readCamera());
  if (before === null) return { outcome: PitchRestore.NoReading, attempts: 0, fromDeg: null, toDeg: null };
  if (Math.abs(before) <= PITCH_RESTORE_TARGET_DEG) {
    return { outcome: PitchRestore.AlreadyLevel, attempts: 0, fromDeg: before, toDeg: before };
  }
  const dragPx = Math.floor(deps.viewportHeight * PITCH_RESTORE_DRAG_SHARE);
  let pitch = before;
  for (let attempt = 1; attempt <= PITCH_RESTORE_ATTEMPTS; attempt++) {
    // Only the vertical axis: heading is not what any verdict here preserves.
    await deps.drag(restoreDragTargetY(0, dragPx, pitch));
    await deps.sleep(PITCH_SETTLE_MS);
    const now = pitchOf(await deps.readCamera());
    if (now === null) return { outcome: PitchRestore.NoReading, attempts: attempt, fromDeg: before, toDeg: null };
    // No movement at all: this game does not read a drag as look input, so there is nothing to undo.
    if (Math.abs(now - pitch) < PITCH_UNMOVED_DEG) {
      return { outcome: PitchRestore.Unmoved, attempts: attempt, fromDeg: before, toDeg: now };
    }
    pitch = now;
    if (Math.abs(pitch) <= PITCH_RESTORE_TARGET_DEG) {
      return { outcome: PitchRestore.Restored, attempts: attempt, fromDeg: before, toDeg: pitch };
    }
  }
  return { outcome: PitchRestore.GaveUp, attempts: PITCH_RESTORE_ATTEMPTS, fromDeg: before, toDeg: pitch };
}
