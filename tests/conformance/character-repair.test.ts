/**
 * Diagnose, then fix or regenerate (Track A): what to do about an engine character-check report.
 * A rig-level fault makes every clip moot, so it is one regeneration; clip-level faults swap or
 * re-make only the clips at fault; roles no clip fills are made plainly named. A passing report
 * needs nothing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CharacterCheckCause,
  CharacterCheckCode,
  type CharacterCheckDiagnostic,
  type CharacterCheckReport,
  ClipRole,
} from "../../src/shared/character-check.ts";
import { RepairAction, repairPlan } from "../../src/shared/character-repair.ts";

const NO_ROLES = Object.fromEntries(Object.values(ClipRole).map((role) => [role, role])) as Record<
  ClipRole,
  string | null
>;

function diagnostic(over: Partial<CharacterCheckDiagnostic>): CharacterCheckDiagnostic {
  return {
    code: CharacterCheckCode.LimbStretch,
    cause: CharacterCheckCause.BadRig,
    clip: "",
    role: null,
    time: 0,
    bone: null,
    value: 1,
    limit: 0.5,
    ...over,
  };
}

function report(diagnostics: CharacterCheckDiagnostic[], roles = NO_ROLES): CharacterCheckReport {
  return {
    file: "character.glb",
    profile: "meshy",
    mapped: {},
    missingBones: [],
    roles,
    diagnostics,
    pass: diagnostics.length === 0,
  };
}

const actions = (plan: ReturnType<typeof repairPlan>) => plan.steps.map((step) => step.action);

describe("the repair plan for a character-check report", () => {
  it("has no steps for a character that passes", () => {
    const plan = repairPlan(report([]));
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.steps, []);
  });

  it("regenerates once for a rig fault, whatever the clips say", () => {
    const plan = repairPlan(
      report([
        diagnostic({ code: CharacterCheckCode.BoneMissing, bone: "LeftLowerArm" }),
        diagnostic({ code: CharacterCheckCode.LimbStretch, clip: "Run", role: ClipRole.Run }),
      ]),
    );
    assert.deepEqual(actions(plan), [RepairAction.Regenerate]);
    assert.match(plan.steps[0]?.advice ?? "", /character\.import|a-pose/);
  });

  it("regenerates in a rest pose when the fault is the pose", () => {
    const plan = repairPlan(
      report([diagnostic({ code: CharacterCheckCode.TorsoCollapse, cause: CharacterCheckCause.WrongPose })]),
    );
    assert.deepEqual(actions(plan), [RepairAction.Regenerate]);
    assert.match(plan.steps[0]?.advice ?? "", /a-pose/);
  });

  it("swaps only the clips at fault when the rig is sound", () => {
    const plan = repairPlan(
      report([
        diagnostic({
          code: CharacterCheckCode.FeetSunk,
          cause: CharacterCheckCause.BoneMismatch,
          clip: "Walk",
          role: ClipRole.Walk,
        }),
        diagnostic({
          code: CharacterCheckCode.HandsOffWeapon,
          cause: CharacterCheckCause.BoneMismatch,
          clip: "Aim",
          role: ClipRole.Aim,
        }),
        diagnostic({
          code: CharacterCheckCode.FeetSunk,
          cause: CharacterCheckCause.BoneMismatch,
          clip: "Walk",
          role: ClipRole.Walk,
        }),
      ]),
    );
    assert.deepEqual(actions(plan), [RepairAction.SwapClips]);
    assert.deepEqual(plan.steps[0]?.clips, ["Walk", "Aim"]);
    assert.match(plan.steps[0]?.advice ?? "", /character\.animate/);
  });

  it("makes each missing role as a plainly named clip", () => {
    const plan = repairPlan(
      report(
        [
          diagnostic({ code: CharacterCheckCode.ClipRoleMissing, role: ClipRole.Reload }),
          diagnostic({ code: CharacterCheckCode.ClipRoleMissing, role: ClipRole.Death }),
        ],
        { ...NO_ROLES, reload: null, death: null },
      ),
    );
    assert.deepEqual(actions(plan), [RepairAction.FillRoles]);
    assert.deepEqual(plan.steps[0]?.roles, [ClipRole.Reload, ClipRole.Death]);
  });

  it("swaps bad clips and fills missing roles in one plan", () => {
    const plan = repairPlan(
      report([
        diagnostic({
          code: CharacterCheckCode.FeetFloating,
          cause: CharacterCheckCause.BoneMismatch,
          clip: "Run",
          role: ClipRole.Run,
        }),
        diagnostic({ code: CharacterCheckCode.ClipRoleMissing, role: ClipRole.Hit }),
      ]),
    );
    assert.deepEqual(actions(plan), [RepairAction.SwapClips, RepairAction.FillRoles]);
  });
});
