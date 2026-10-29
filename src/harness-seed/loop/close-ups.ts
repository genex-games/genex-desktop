/**
 * Close-ups for the art director: the region of a frame where the nearest props stand, cut from
 * the full-size capture so a judge sees texels, bevels and edges instead of a 960×540 thumbnail.
 * Gen3's judges re-cut the same small frame 125 times and never saw a bench's box edges.
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import { HostMethod } from "./host-methods.ts";
import { DEFAULT_CAMERA } from "./cameras.ts";
import type { AnyRecord, HarnessCtx, Run } from "../types/harness.d.ts";

/** The lower middle of a frame, where a first- or third-person view puts its nearest props: [x0, y0, x1, y1]. */
export const CLOSE_UP_CROP: [number, number, number, number] = [0.25, 0.45, 0.75, 0.95];
/** The most close-ups one look carries. */
export const MAX_CLOSE_UPS = 3;
/** The harness eye nearest the player's own view. */
const PLAYER_EYE = "eye:here";

/** The cameras a look's close-ups come from: the parts' hero cameras first, then the default view and the player's eye. */
export function closeUpCameras(heroes: readonly string[], shots: readonly AnyRecord[]): string[] {
  const shown = new Set(shots.filter((shot) => shot?.base64 && shot.path).map((shot) => String(shot.camera)));
  return [...new Set([...heroes, DEFAULT_CAMERA, PLAYER_EYE])]
    .filter((camera) => shown.has(camera))
    .slice(0, MAX_CLOSE_UPS);
}

/**
 * The close-ups of one look, as frames a judge is shown (`{ camera, base64 }`), cut by the host
 * from each camera's saved capture. A crop the host cannot make is left out.
 */
export async function closeUps(
  ctx: HarnessCtx,
  {
    run,
    evidence,
    heroes,
    label,
    handle = null,
  }: { run: Run; evidence: AnyRecord; heroes: readonly string[]; label: string; handle?: string | null },
): Promise<AnyRecord[]> {
  const shots = (Array.isArray(evidence.shots) ? evidence.shots : []) as AnyRecord[];
  const out: AnyRecord[] = [];
  for (const camera of closeUpCameras(heroes, shots)) {
    const shot = shots.find((candidate) => candidate.camera === camera && candidate.path);
    const crop = await ctx
      .call(HostMethod.PreviewCrop, {
        runId: run.runId,
        path: shot?.path,
        crop: CLOSE_UP_CROP,
        label: `${label}/close-ups/${camera.replace(/[^a-z0-9-_]+/gi, "-")}`,
        ...(handle ? { handle } : {}),
      })
      .catch(() => null);
    if (crop?.base64) out.push({ camera, base64: crop.base64 });
  }
  return out;
}
