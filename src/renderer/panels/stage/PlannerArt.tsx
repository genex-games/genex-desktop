/**
 * The welcome's lead plan sheet on the stage: a pen writes the plan on a sheet once, then the page floats
 * where it is. Smaller than in the welcome, and drawn at the empty states' frame rate.
 */
import { useState, type JSX } from "react";
import { SECOND_MS } from "../../../shared/duration.ts";
import { ArtCanvas, type Draw } from "../../onboarding/ArtCanvas.tsx";
import { drawPlanner, PLANNER_VIEW } from "../../onboarding/art.ts";

/** CSS pixels per pixel of the welcome stage. */
const SCALE = 1.05;
/** The page only floats once it is written, so it needs no more frames than the empty states. */
const FPS = 30;
const WIDTH = Math.round(PLANNER_VIEW.width * SCALE);
const HEIGHT = Math.round(PLANNER_VIEW.height * SCALE);

/**
 * The lead writing its plan page from `since` (a wall-clock time, so a stage that is drawn again
 * picks the page up where it was), else from the moment it mounts.
 */
export function PlannerArt({ since }: { since?: number }): JSX.Element {
  const [mounted] = useState(Date.now);
  const from = since ?? mounted;
  const draw: Draw = (ctx, palette, now) => {
    ctx.scale(SCALE, SCALE);
    ctx.translate(-PLANNER_VIEW.x, -PLANNER_VIEW.y);
    if (now === null) drawPlanner(ctx, 0, palette, true);
    else drawPlanner(ctx, Math.max(0, Date.now() - from) / SECOND_MS, palette);
  };
  return <ArtCanvas width={WIDTH} height={HEIGHT} draw={draw} fps={FPS} />;
}
