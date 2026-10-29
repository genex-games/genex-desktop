/**
 * The game's own reference stills (`references/*`) put on a run that brought none. Gen3's
 * `references/` held the owner's still while its report said `referenceStills: []`, so no judge
 * compared a frame with it and no style distance was measured: a Resume, a chat-launched run and
 * a re-dispatch all arrive without frames, and only Autopilot ever read the folder.
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import { HostMethod } from "./host-methods.ts";
import { REFERENCE_MIN_STILLS, ReferenceKind } from "./run-events.ts";
import type { AnyRecord, HarnessCtx, Run } from "../types/harness.d.ts";

/** The most stills a run takes from `references/`. */
export const MAX_REFERENCE_STILLS = 12;
/** The longest side a still is read at. */
export const REFERENCE_MAX_PX = 1024;

/**
 * Loads `references/*` onto `run.reference.frames` when the run carries none, and answers the
 * notes on what was loaded and skipped. A run that brought its own frames keeps them untouched.
 */
export async function loadReferenceStills(ctx: HarnessCtx, run: Run): Promise<string[]> {
  if (!run.reference) run.reference = { name: "unnamed", shots: [] };
  if ((run.reference.frames ?? []).some((frame) => frame?.data)) return [];
  const fromDisk = await ctx
    .call(HostMethod.GameReferences, { project: run.project, max: MAX_REFERENCE_STILLS, maxPx: REFERENCE_MAX_PX })
    .catch(() => null);
  const frames = (fromDisk?.frames ?? []) as AnyRecord[];
  const notes: string[] = [];
  if (frames.length) {
    run.reference.frames = frames as NonNullable<Run["reference"]>["frames"];
    // Two stills or more make a reference; a direction keeps its kind on one.
    const enoughStills = frames.length >= REFERENCE_MIN_STILLS;
    if (run.reference.kind !== ReferenceKind.Direction || enoughStills)
      run.reference.kind = enoughStills ? ReferenceKind.Reference : run.reference.kind;
    notes.push(`loaded ${frames.length} reference still(s) from references/: ${frames.map((f) => f.label).join(", ")}`);
  }
  for (const skip of (fromDisk?.skipped ?? []) as AnyRecord[])
    notes.push(`reference skipped: ${skip.file} is ${skip.why}`);
  return notes;
}
