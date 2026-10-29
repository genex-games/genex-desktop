/**
 * The Genex plugin's character gate (Track A): a rigged GLB that a character or creature
 * generation downloaded is checked by the import contract before it is delivered into the game,
 * and one that fails is rejected with a typed failure that says how to fix or regenerate it, so a
 * broken body never reaches the game.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { gateCharacter, missingRolesOf } from "../../src/plugins/genex/character-gate.ts";
import { CharacterFailure, CharacterRole } from "../../src/shared/character-contract.ts";
import { GenexFailureCode, GenexJobStatus, GenexOperation, type GenexJob } from "../../src/shared/genex.ts";
import { motionGlb } from "../helpers/glb.ts";
import { riggedCharacter } from "../helpers/rigged-glb.ts";
import { tmpDir } from "../helpers/tmp.ts";

function jobOf(operation: string, extra: Partial<GenexJob> = {}): GenexJob {
  return {
    id: "job",
    project: "game",
    operation,
    status: GenexJobStatus.Generated,
    files: [],
    createdAt: "2026-10-29T00:00:00Z",
    ...extra,
  };
}

async function outputWith(files: Record<string, Uint8Array>): Promise<string> {
  const dir = await tmpDir("character-gate-");
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), bytes);
  }
  return dir;
}

describe("the character gate", () => {
  it("lets a humanoid in an A-pose through, and says nothing", async () => {
    const dir = await outputWith({ "character.glb": riggedCharacter({ clips: [{ name: "Idle" }] }) });
    assert.equal(await gateCharacter(jobOf(GenexOperation.Character), dir), null);
  });

  it("rejects a body whose arms hang at its sides, naming the fix as a regeneration in an A-pose", async () => {
    const dir = await outputWith({ "character.glb": riggedCharacter({ armDrop: 3 }) });
    const failure = await gateCharacter(jobOf(GenexOperation.Creature), dir);
    assert.equal(failure?.code, GenexFailureCode.CharacterRejected);
    assert.match(failure?.providerError ?? "", /character\.glb/);
    assert.match(failure?.providerError ?? "", new RegExp(CharacterFailure.RestPose));
    assert.match(failure?.next ?? "", /a-pose/);
  });

  it("rejects a mesh with no rig and points at character.import", async () => {
    const dir = await outputWith({ "character.glb": riggedCharacter({ skinned: false }) });
    const failure = await gateCharacter(jobOf(GenexOperation.CharacterFinalize), dir);
    assert.equal(failure?.code, GenexFailureCode.CharacterRejected);
    assert.match(failure?.next ?? "", /character\.import/);
  });

  it("names every failure of every rejected body in one answer", async () => {
    const dir = await outputWith({
      "a/body.glb": riggedCharacter({ armDrop: 3, hips: 4 }),
      "b/other.glb": riggedCharacter({ without: ["Head"] }),
    });
    const failure = await gateCharacter(jobOf(GenexOperation.Character), dir);
    for (const code of [CharacterFailure.RestPose, CharacterFailure.Scale, CharacterFailure.NotHumanoid])
      assert.match(failure?.providerError ?? "", new RegExp(code), code);
  });

  it("leaves an animation-only GLB alone: it draws nothing, so it has no rig to judge", async () => {
    const dir = await outputWith({
      "character.glb": riggedCharacter({}),
      "clips/wave.glb": new Uint8Array(motionGlb("Wave", ["Hips", "Spine"])),
    });
    assert.equal(await gateCharacter(jobOf(GenexOperation.Character), dir), null);
  });

  it("does not gate a prop, an image or a model: only the lanes that make a body", async () => {
    const dir = await outputWith({ "prop.glb": riggedCharacter({ armDrop: 3 }) });
    for (const operation of [GenexOperation.Model, GenexOperation.Image, GenexOperation.ModelRig])
      assert.equal(await gateCharacter(jobOf(operation), dir), null, operation);
  });

  it("passes an output with no GLB: there is nothing to judge", async () => {
    const dir = await outputWith({ "notes.txt": new Uint8Array([1]) });
    assert.equal(await gateCharacter(jobOf(GenexOperation.Character), dir), null);
  });
});

const COVERED: ReadonlySet<CharacterRole> = new Set([CharacterRole.Idle, CharacterRole.Walk, CharacterRole.Run]);

describe("the roles a delivered body still lacks", () => {
  const all = Object.values(CharacterRole);

  it("counts the body's own clips and those of animation-only files beside it", async () => {
    const dir = await outputWith({
      "character.glb": riggedCharacter({ clips: [{ name: "Idle" }, { name: "Walk" }] }),
      "clips/run.glb": new Uint8Array(motionGlb("Run_Fwd", ["Hips", "Spine"])),
    });
    assert.deepEqual(
      await missingRolesOf(jobOf(GenexOperation.Character), dir),
      all.filter((role) => !COVERED.has(role)),
    );
  });

  it("names every role for a body with no clips", async () => {
    const dir = await outputWith({ "character.glb": riggedCharacter({}) });
    assert.deepEqual(await missingRolesOf(jobOf(GenexOperation.Creature), dir), all);
  });

  it("is null for a job that makes no body", async () => {
    const dir = await outputWith({ "prop.glb": riggedCharacter({}) });
    assert.equal(await missingRolesOf(jobOf(GenexOperation.Model), dir), null);
  });
});
