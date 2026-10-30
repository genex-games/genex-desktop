/**
 * Diagnose, then fix or regenerate (Track A): what to do about the engine's character-check report
 * (`character-check.ts`). A fault in the rig, or in the pose it was made in, makes every clip moot,
 * so it is one regeneration; a fault in a clip alone swaps just that clip; a role no clip fills is
 * made as a plainly named clip. Regenerating and making clips spend credits, so the plan says what
 * to call and the agent asks for it through the usual quote. Browser-safe.
 */
import {
  type CharacterCheckCause,
  CharacterCheckCause as Cause,
  CharacterCheckCode,
  type CharacterCheckDiagnostic,
  type CharacterCheckReport,
  type ClipRole,
} from "./character-check.ts";

/** What one step of a repair does. Wire values. */
export const RepairAction = {
  /** Make the body again, in a rest pose the engine can retarget. */
  Regenerate: "regenerate",
  /** Replace the named clips with clips made for this rig. */
  SwapClips: "swap-clips",
  /** Make a clip for each role no clip fills. */
  FillRoles: "fill-roles",
} as const;
export type RepairAction = (typeof RepairAction)[keyof typeof RepairAction];

/** One step of a repair plan. */
export interface RepairStep {
  action: RepairAction;
  /** The clips to replace, for {@link RepairAction.SwapClips}. */
  clips: string[];
  /** The roles to make, for {@link RepairAction.FillRoles}. */
  roles: ClipRole[];
  /** The call to make, in the Genex plugin's words. */
  advice: string;
}

/** A repair plan: empty for a character that passes. */
export interface RepairPlan {
  ok: boolean;
  steps: RepairStep[];
}

/** The causes that spoil the rig itself rather than one clip. */
const RIG_CAUSES: ReadonlySet<CharacterCheckCause> = new Set([Cause.BadRig, Cause.WrongPose]);

const MESSAGE = {
  Regenerate:
    "Make the body again with operation character or creature and options pose a-pose (or take a humanoid model through character.import for a Uthana rig); its clips cannot be saved.",
  SwapClips: (clips: readonly string[]) =>
    `Replace ${clips.join(", ")} with clips made for this rig: operation character.animate (or animations.search for a catalog clip), one plainly named clip each.`,
  FillRoles: (roles: readonly ClipRole[]) =>
    `Make a clip for each of ${roles.join(", ")} with operation character.animate, named plainly (for example "Reload"), then check again.`,
} as const;

/** Whether a finding spoils the rig for every clip: a missing bone, or a rig-level fault (no clip) caused by the rig or its pose. A missing role is neither. */
const spoilsRig = (finding: CharacterCheckDiagnostic): boolean => {
  if (finding.code === CharacterCheckCode.ClipRoleMissing) return false;
  return finding.code === CharacterCheckCode.BoneMissing || (finding.clip === "" && RIG_CAUSES.has(finding.cause));
};

/** The first occurrence of each value, in order. */
const distinct = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** The plan for `report`: one regeneration for a rig fault, else clip swaps and role fills. */
export function repairPlan(report: CharacterCheckReport): RepairPlan {
  if (report.pass || !report.diagnostics.length) return { ok: true, steps: [] };
  if (report.diagnostics.some(spoilsRig))
    return {
      ok: false,
      steps: [{ action: RepairAction.Regenerate, clips: [], roles: [], advice: MESSAGE.Regenerate }],
    };
  const steps: RepairStep[] = [];
  const clips = distinct(
    report.diagnostics
      .filter((finding) => finding.code !== CharacterCheckCode.ClipRoleMissing && finding.clip !== "")
      .map((finding) => finding.clip),
  );
  if (clips.length) steps.push({ action: RepairAction.SwapClips, clips, roles: [], advice: MESSAGE.SwapClips(clips) });
  const roles = distinct(
    report.diagnostics.flatMap((finding) =>
      finding.code === CharacterCheckCode.ClipRoleMissing && finding.role ? [finding.role] : [],
    ),
  );
  if (roles.length) steps.push({ action: RepairAction.FillRoles, clips: [], roles, advice: MESSAGE.FillRoles(roles) });
  return { ok: false, steps };
}
