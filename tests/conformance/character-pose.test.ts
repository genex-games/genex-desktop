/**
 * Bodies are generated in a rig-friendly pose (Track A): a one-shot character or creature the
 * agent did not give a pose is asked for an A-pose, because arms hanging at the sides or raised
 * overhead cannot be retargeted onto the engine's humanoid map. A pose the agent chose stays.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cliArgsFor } from "../../src/plugins/genex/request.ts";
import { tmpDir } from "../helpers/tmp.ts";

async function argsOf(operation: string, options: Record<string, string | number | boolean>, id?: string) {
  const root = await tmpDir("character-pose-");
  const dir = await tmpDir("character-pose-job-");
  return (await cliArgsFor({ operation, prompt: "a courier", options, ...(id ? { id } : {}) }, root, dir, false)).args;
}

const poseOf = (args: string[]) => args[args.indexOf("--pose") + 1];

describe("the pose a generated body is asked for", () => {
  it("defaults a one-shot creature and a direct character to an A-pose", async () => {
    assert.equal(poseOf(await argsOf("creature", {})), "a-pose");
    assert.equal(poseOf(await argsOf("character", { "direct-text": true })), "a-pose");
  });

  it("keeps the pose the agent chose", async () => {
    assert.equal(poseOf(await argsOf("creature", { pose: "t-pose" })), "t-pose");
    assert.equal(poseOf(await argsOf("character", { "direct-text": true, pose: "t-pose" })), "t-pose");
  });

  it("leaves lanes that take no pose alone: the guided concept, a preview, a model, an animation", async () => {
    for (const [operation, options] of [
      ["character", {}],
      ["character.preview", {}],
      ["model", {}],
      ["character.animate", {}],
      ["creature.animate", {}],
    ] as const)
      assert.ok(!(await argsOf(operation, { ...options })).includes("--pose"), operation);
  });
});
