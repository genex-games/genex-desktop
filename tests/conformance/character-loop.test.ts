/**
 * The character verification loop (Track A): the agent builds the game, the engine's character
 * check reports, and `nextStep` decides what happens next from the report and what the loop has
 * already spent: pass, the one Genex call that repairs the worst fault, or a stop with a clear
 * report once an attempt or credit cap is reached. Studio keeps the caps, not the agent's goodwill.
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
import { type LoopLedger, LoopStatus, LoopStop, nextStep, ROLE_ACTIONS } from "../../src/shared/character-loop.ts";

const ROLES = Object.fromEntries(Object.values(ClipRole).map((role) => [role, role])) as Record<
  ClipRole,
  string | null
>;
const CAPS = { attempts: 3, credits: 100 };
const FRESH: LoopLedger = { attempts: 0, credits: 0 };
const WHO = { id: "gen-1", model: "assets/genex/hero/character.glb", prompt: "a soldier" };

function finding(over: Partial<CharacterCheckDiagnostic>): CharacterCheckDiagnostic {
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
const report = (diagnostics: CharacterCheckDiagnostic[], roles = ROLES): CharacterCheckReport => ({
  file: WHO.model,
  profile: "meshy",
  mapped: {},
  missingBones: [],
  roles,
  diagnostics,
  pass: diagnostics.length === 0,
});

describe("the character loop's next step", () => {
  it("passes a character the check passes, with nothing to call", () => {
    assert.deepEqual(nextStep(report([]), FRESH, CAPS, WHO), { status: LoopStatus.Pass });
  });

  it("fills a missing role with character.animate and a plain action for that role", () => {
    const step = nextStep(
      report([finding({ code: CharacterCheckCode.ClipRoleMissing, role: ClipRole.Reload })], {
        ...ROLES,
        reload: null,
      }),
      FRESH,
      CAPS,
      WHO,
    );
    assert.equal(step.status, LoopStatus.Act);
    if (step.status !== LoopStatus.Act) return;
    assert.deepEqual(step.call, { operation: "character.animate", id: "gen-1", prompt: ROLE_ACTIONS[ClipRole.Reload] });
  });

  it("replaces a broken clip by asking for its role again", () => {
    const step = nextStep(
      report([
        finding({
          code: CharacterCheckCode.FeetSunk,
          cause: CharacterCheckCause.BoneMismatch,
          clip: "Walk",
          role: ClipRole.Walk,
        }),
      ]),
      FRESH,
      CAPS,
      WHO,
    );
    assert.equal(step.status === LoopStatus.Act && step.call.prompt, ROLE_ACTIONS[ClipRole.Walk]);
  });

  it("re-imports a bad rig through Uthana first, and regenerates in an A-pose once that was tried", () => {
    const bad = report([finding({ code: CharacterCheckCode.BoneMissing, bone: "LeftHand" })]);
    const first = nextStep(bad, FRESH, CAPS, WHO);
    assert.deepEqual(first.status === LoopStatus.Act && first.call, {
      operation: "character.import",
      prompt: WHO.model,
    });
    const second = nextStep(bad, { attempts: 1, credits: 10, reimported: true }, CAPS, WHO);
    assert.deepEqual(second.status === LoopStatus.Act && second.call, {
      operation: "character",
      prompt: "a soldier",
      options: { "direct-text": true, pose: "a-pose" },
    });
  });

  it("regenerates, not re-imports, when the fault is the pose", () => {
    const step = nextStep(
      report([finding({ code: CharacterCheckCode.TorsoCollapse, cause: CharacterCheckCause.WrongPose })]),
      FRESH,
      CAPS,
      WHO,
    );
    assert.equal(step.status === LoopStatus.Act && step.call.operation, "character");
  });

  it("stops at the attempt cap and reports what still fails", () => {
    const step = nextStep(
      report([
        finding({
          code: CharacterCheckCode.FeetFloating,
          clip: "Run",
          role: ClipRole.Run,
          cause: CharacterCheckCause.BoneMismatch,
        }),
      ]),
      { attempts: 3, credits: 30 },
      CAPS,
      WHO,
    );
    assert.equal(step.status, LoopStatus.Stop);
    if (step.status !== LoopStatus.Stop) return;
    assert.equal(step.reason, LoopStop.Attempts);
    assert.match(step.summary, /feet-floating/);
    assert.match(step.summary, /Run/);
  });

  it("stops at the credit cap, with the reason named", () => {
    const step = nextStep(
      report([finding({ code: CharacterCheckCode.ClipRoleMissing, role: ClipRole.Death })], { ...ROLES, death: null }),
      { attempts: 1, credits: 100 },
      CAPS,
      WHO,
    );
    assert.equal(step.status === LoopStatus.Stop && step.reason, LoopStop.Credits);
  });

  it("a passing report passes even when the caps are spent", () => {
    assert.equal(nextStep(report([]), { attempts: 9, credits: 999 }, CAPS, WHO).status, LoopStatus.Pass);
  });
});
