/**
 * The character import contract (Track A, plan-2): what a rigged GLB from `genex__asset` must be
 * for the Rust stack to play it without hand fixes. `characterVerdict` reads the importer's facts
 * and rest pose and says pass or the typed reasons it fails, plus which move roles the rig's own
 * clips already cover so the rest can be filled. A failing character never reaches the game.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CharacterFailure, CharacterRole, characterVerdict, clipRole } from "../../src/shared/character-contract.ts";
import { characterFacts, restPoseOf } from "../../src/substrate/asset-import/character-facts.ts";
import { riggedCharacter } from "../helpers/rigged-glb.ts";

const ALL_ROLES = ["Idle", "Walk", "Run", "Crouch", "Aim", "Fire", "Reload", "Hit", "Death"] as const;
const FULL_SET = ["Idle", "Walk_Fwd", "Run_Fwd", "Crouch_Idle", "Aim_Rifle", "Fire", "Reload", "Hit_React", "Death"];

function verdictOf(options: Parameters<typeof riggedCharacter>[0]) {
  const bytes = riggedCharacter(options);
  return characterVerdict(characterFacts(bytes), restPoseOf(bytes));
}
const codes = (verdict: ReturnType<typeof verdictOf>) => verdict.failures.map((failure) => failure.code);

describe("clip roles", () => {
  it("reads a role from a clip's name, however the rig spells it", () => {
    const table: Array<[string, CharacterRole | null]> = [
      ["Idle", CharacterRole.Idle],
      ["idle_loop", CharacterRole.Idle],
      ["Walk_Fwd", CharacterRole.Walk],
      ["Armature|Running", CharacterRole.Run],
      ["Sprint", CharacterRole.Run],
      ["Crouch_Idle", CharacterRole.Crouch],
      ["Aim_Rifle", CharacterRole.Aim],
      ["Shoot", CharacterRole.Fire],
      ["Reloading", CharacterRole.Reload],
      ["Hit_React", CharacterRole.Hit],
      ["Death_01", CharacterRole.Death],
      ["Dance_Loop", null],
      ["", null],
    ];
    for (const [name, role] of table) assert.equal(clipRole(name), role, name);
  });

  it("reads a crouched idle as crouch and a walk-and-aim as neither idle nor walk by accident", () => {
    assert.equal(clipRole("Crouch_Walk"), CharacterRole.Crouch);
    assert.equal(clipRole("Idle_Aim"), CharacterRole.Aim);
  });
});

describe("the character verdict", () => {
  it("passes a humanoid in an A-pose with all nine roles and names nothing to fill", () => {
    const verdict = verdictOf({ clips: FULL_SET.map((name) => ({ name })) });
    assert.deepEqual(verdict.failures, []);
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.missingRoles, []);
    assert.equal(verdict.roles[CharacterRole.Walk], "Walk_Fwd");
  });

  it("passes a T-pose and lists the roles the rig's own clips leave to fill", () => {
    const verdict = verdictOf({ armDrop: 90, clips: [{ name: "Idle" }, { name: "Walk" }] });
    assert.equal(verdict.ok, true, JSON.stringify(verdict.failures));
    assert.deepEqual(
      verdict.missingRoles,
      ALL_ROLES.map((key) => CharacterRole[key]).filter((role) => role !== "idle" && role !== "walk"),
    );
  });

  it("passes a rig with no clips at all, every role left to fill", () => {
    const verdict = verdictOf({});
    assert.equal(verdict.ok, true, JSON.stringify(verdict.failures));
    assert.equal(verdict.missingRoles.length, ALL_ROLES.length);
  });

  it("fails a rig that is not a humanoid, naming the core bones it lacks", () => {
    const verdict = verdictOf({ without: ["LeftLowerLeg", "Head"] });
    assert.equal(verdict.ok, false);
    assert.deepEqual(codes(verdict), [CharacterFailure.NotHumanoid]);
    assert.match(verdict.failures[0]?.detail ?? "", /Head.*LeftLowerLeg|LeftLowerLeg.*Head/);
  });

  it("tolerates missing toes and the upper chest: they are not core bones", () => {
    assert.equal(verdictOf({ without: ["LeftToes", "RightToes", "UpperChest"] }).ok, true);
  });

  it("fails a mesh with a skeleton nothing is skinned to", () => {
    const bytes = riggedCharacter({ skinned: false });
    assert.deepEqual(
      characterVerdict(characterFacts(bytes), restPoseOf(bytes)).failures.map((f) => f.code),
      [CharacterFailure.NotRigged],
    );
  });

  it("fails arms hanging at the sides and arms raised overhead: neither is a rest pose a retarget can use", () => {
    for (const armDrop of [5, 160]) {
      const verdict = verdictOf({ armDrop });
      assert.deepEqual(codes(verdict), [CharacterFailure.RestPose], `armDrop ${armDrop}`);
      assert.match(verdict.failures[0]?.detail ?? "", new RegExp(`${armDrop}`));
    }
  });

  it("accepts the whole A-to-T range", () => {
    for (const armDrop of [30, 45, 60, 90, 100]) assert.equal(verdictOf({ armDrop }).ok, true, `armDrop ${armDrop}`);
  });

  it("fails a giant and a doll: a skeleton must stand a person-sized way off the ground", () => {
    for (const hips of [0.1, 4]) {
      const verdict = verdictOf({ hips });
      assert.deepEqual(codes(verdict), [CharacterFailure.Scale], `hips ${hips}`);
    }
  });

  it("reports every failure at once, so one regeneration can fix them all", () => {
    const verdict = verdictOf({ armDrop: 5, hips: 4 });
    assert.deepEqual(codes(verdict).sort(), [CharacterFailure.RestPose, CharacterFailure.Scale].sort());
  });

  it("fails a file with no rig at all", () => {
    assert.deepEqual(
      characterVerdict(null, null).failures.map((f) => f.code),
      [CharacterFailure.NotRigged],
    );
  });
});
