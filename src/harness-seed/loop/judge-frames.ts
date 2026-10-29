/**
 * How many frames of one build a judge could be shown. None is a blind pass: gen3 judged five
 * rounds with no image at all and kept four of them (facet/phases/verify.ts holds such a round
 * Unmeasured instead).
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import { CORNER_CAMERA, DEMO_FRAME } from "./pass-frames.ts";
import type { AnyRecord } from "../types/harness.d.ts";

/** Does a frame ride with this camera list: a named camera, or a demo's end or the drive's corner, which ride with any. */
const shownWith = (shot: AnyRecord, wanted: ReadonlySet<string> | null): boolean =>
  wanted === null ||
  wanted.has(shot.camera) ||
  String(shot.camera ?? "").startsWith(DEMO_FRAME) ||
  shot.camera === CORNER_CAMERA;

/**
 * The frames with pixels a judge could be shown of `candidate` over `cameras` (null or empty: every
 * camera), the motion strip included. The accepted build rides as `{ incumbent, evidence }`.
 */
export function framesOfBuild(
  candidate: AnyRecord | null | undefined,
  cameras: readonly string[] | null = null,
): number {
  const evidence = candidate?.incumbent ? candidate.evidence : candidate;
  if (!evidence) return 0;
  const wanted = cameras?.length ? new Set(cameras) : null;
  const shots = ((evidence.shots ?? []) as AnyRecord[]).filter((shot) => shot?.base64 && shownWith(shot, wanted));
  const motion = ((evidence.motion ?? []) as AnyRecord[]).filter((frame) => frame?.base64);
  return shots.length + motion.length;
}
