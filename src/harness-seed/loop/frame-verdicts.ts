/**
 * The frame verdicts: what the pictures of one look say about the build, from their pixel counts,
 * their draw counts and whether different cameras gave the same frame. Pure functions of the
 * look's shots, so the web evidence pass (evidence.ts) and the native one (native-evidence.ts) run
 * exactly the same verdicts on their own shots.
 *
 * Moved here out of evidence.ts, which still exports every name under its old home: a harness
 * file the in-app agent edited before the move keeps its imports (seed-upgrade.ts `SEED_MOVES`).
 */
import type { AnyRecord } from "../types/harness.d.ts";
import { demoOfFrame } from "./pass-frames.ts";

/** One photographed frame as the verdicts read it: its camera, its pixels and the surface it came off. */
export interface FrameShot {
  camera: string;
  base64?: string;
  stats?: AnyRecord | null;
  surface?: string;
  [field: string]: unknown;
}

/**
 * A look as the verdicts read it and write back to it: its `shots` (each a {@link FrameShot}),
 * the `problems` and `warnings` it owes the judge, `emptyScene` (the base is empty by
 * inspection), the `declaredViewpoints` the game names, what the page paints outside the canvas
 * (`uiEntries`, `uiPrimary`) and the game's `entry` file a fix goes in (`main.js` unless named:
 * a C++ game's is `src/main.cpp`), and `camerasOwned` (false for a part that does not own the
 * entry: a dead camera wiring is a warning for it). The verdicts leave their counts on it for the
 * phases after them.
 */
// biome-ignore lint/suspicious/noExplicitAny: each phase of a look adds the readings the phases after it read.
export type FrameLook = Record<string, any>;

/** The shots, under the name the verdicts were written with. */
type Shot = FrameShot;

/** Below this lit fraction on every camera, a build renders effectively black. */
const BLACK_LIT_FRACTION = 0.005;
/** How many of the page's UI entries a warning names. */
const MAX_UI_ENTRIES = 6;

/**
 * Whose count is this? The facade delegates `capture()` to the game, so a frame the page
 * labelled `game` — and the draw count beside it — is the build's claim about itself, not the
 * studio's read of the canvas. A verdict is only made on the studio's own reads.
 */
const claimedByGame = (shot: Shot): boolean => shot.stats?.provenance === "game";

/**
 * A frame that drew nothing is not evidence of blankness — it is evidence of no frame. It leaves
 * the blankness census and says so; but if EVERY frame drew nothing, dropping them all would
 * silently delete the verdict, so that is the verdict. Answers the frames the census counts.
 */
export function weighDraws(look: FrameLook): Shot[] {
  const { problems, shots, warnings } = look;
  const counted = shots.filter((shot: Shot) => shot.stats);
  look.counted = counted;
  const zeroDraw = counted.filter((shot: Shot) => shot.stats?.drawCalls === 0);
  look.zeroDraw = zeroDraw;
  look.claimed = claimedByGame;
  if (counted.length > 0 && zeroDraw.length === counted.length) {
    // An empty shared base draws nothing because there is nothing in it — the same exemption
    // the no-draw proof above waits for. Anywhere else it is the verdict.
    if (look.emptyScene) warnings.push("the game drew nothing for any camera");
    else if (zeroDraw.every(claimedByGame))
      warnings.push(
        "no camera frame reported a draw, and every frame is the game's own picture rather than the studio's read of the canvas — the count is the build's claim about itself, not a verdict",
      );
    else problems.push("the game drew nothing for any camera");
    return counted;
  }
  if (!zeroDraw.length) return counted;
  warnings.push(
    `${zeroDraw.length} camera frame(s) drew nothing (${zeroDraw.map((shot: Shot) => shot.camera).join(", ")}) — those frames are not evidence of blankness`,
  );
  return counted.filter((shot: Shot) => shot.stats?.drawCalls !== 0);
}

/**
 * The pictures themselves can lie to a vision judge (it politely describes a black JPEG), so the
 * pixel counts are the verdict on blankness — but only when every camera agrees: one dark angle
 * is composition, three is a build that renders nothing.
 */
export function weighBlackness(look: FrameLook, statBearing: Shot[]): void {
  const blackEverywhere =
    statBearing.length > 0 &&
    statBearing.every((shot: Shot) => shot.stats?.canvas && shot.stats.litFraction < BLACK_LIT_FRACTION);
  if (!look.emptyScene && blackEverywhere)
    look.problems.push("every camera renders effectively black (<0.5% pixels above luma 8)");
}

/** When every camera returned the same frame: an overlay, a dead camera contract, a stale picture, or one viewpoint. */
export function sameFrameEverywhere(look: FrameLook): void {
  const { canvasSourced, declaredViewpoints, problems, uiEntries, uiPrimary, warnings } = look;
  // Several viewpoints drawn on the canvas, all one picture: the camera wiring switches nothing.
  const wiringDead = declaredViewpoints.length > 1 && canvasSourced;
  if (uiPrimary) {
    warnings.push(
      `a full-screen overlay covers the game (${uiEntries.slice(0, MAX_UI_ENTRIES).join(", ") || "the page"}) — every camera frame is the same picture behind it; judge user:view`,
    );
  } else if (wiringDead && look.camerasOwned === false) {
    warnings.push(
      "every camera returned the same frame — the camera wiring is the entry owner's, not this part's: judge it on its other evidence",
    );
  } else if (wiringDead) {
    problems.push("every camera returned the same frame — debugCamera switches nothing, the cameras contract is dead");
  } else if (declaredViewpoints.length > 1) {
    warnings.push(
      "every camera returned the same frame, but the frames came off the compositor and not the canvas — the picture may be stale rather than the camera wiring dead",
    );
  } else {
    warnings.push("this build declares one viewpoint — identical frames are its design, not a dead debugCamera");
  }
}

/**
 * Different cameras returning byte-identical frames is one view wearing several labels — but
 * only when the game declares more than one viewpoint and the frames came off the canvas. A game
 * with one camera is photographed three times by the floor, and identical frames there are its
 * design; a full-screen overlay is a different sentence again.
 */
export function weighDuplicates(look: FrameLook): void {
  const { declaredViewpoints, shots, warnings } = look;
  const withPixels = shots.filter((shot: Shot) => shot.base64);
  look.withPixels = withPixels;
  look.canvasSourced = shots.every((shot: Shot) => shot.surface !== "page");
  const duplicate = shots.find((shot: Shot, index: number) =>
    shots.slice(0, index).some((other: Shot) => other.base64 && other.base64 === shot.base64),
  );
  look.duplicate = duplicate;
  if (look.emptyScene) return;
  const allSame = withPixels.length > 1 && withPixels.every((shot: Shot) => shot.base64 === withPixels[0].base64);
  if (allSame) sameFrameEverywhere(look);
  else if (duplicate && declaredViewpoints.length > 1)
    warnings.push(
      `the ${duplicate.camera} camera returned the same frame as another camera — each named camera must frame a distinct view; fix the camera wiring in ${look.entry ?? "main.js"}`,
    );
}

/**
 * The capture's own self-test: a demo's end frame that is byte for byte another frame of the same
 * pass (the title screen the default camera also shows, another demo's end, the user's view) did
 * not move the game, so a judge reading it as that demo is judging a title screen. Gen3's
 * `parity/macos/classroom` capture was the title menu. Answers the warnings it adds.
 */
export function weighDemoFrames(look: FrameLook): string[] {
  const shots: Shot[] = (look.shots ?? []).filter((shot: Shot) => shot?.base64);
  const out: string[] = [];
  for (const [index, shot] of shots.entries()) {
    if (!demoOfFrame(shot.camera)) continue;
    const twin = shots.find((other: Shot, at: number) => at !== index && other.base64 === shot.base64);
    if (!twin) continue;
    out.push(
      `${shot.camera}'s end frame is the same picture as ${twin.camera} — the demo did not move the game (a title screen or a paused game): its frame proves nothing about the demo`,
    );
  }
  look.staleDemos = out.length;
  look.warnings?.push(...out);
  return out;
}
