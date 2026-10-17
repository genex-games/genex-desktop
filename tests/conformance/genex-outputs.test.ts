/**
 * What a Genex generation's outputs show as. A character arrives with its rigged model, its clips,
 * the provider's unprocessed source of each and data about each clip (its trajectory, its pose
 * check). Only media is an asset, so the data is never a card of its own; and a source copy is
 * never a second card of a model its generation delivered finished. Both stay in the game.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { reconcileGeneratedAssets } from "../../src/main/game-assets.ts";
import { isGenexSourceOutput, withoutGenexSources } from "../../src/shared/genex.ts";

const GEN = "cmv6qk2br07323jl7vmcn6ku2";
const JOB = "7ad57150-cfca-4087-bba1-a6bb5d8327d6";
const named = (role: string, ext: string) => `realistic-lean-adult-man-cmv6qk2b-${role}.${ext}`;

describe("a generation's data files", () => {
  let root: string;
  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "genex-outputs-"));
    await mkdir(path.join(root, "game"));
    const output = path.join(root, "genex/projects/game/jobs", JOB, "output");
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, named("rigged-a1-glb", "glb")), "glTF-rigged");
    await writeFile(path.join(output, named("walk-trajectory-a1-json", "json")), "{}");
    await writeFile(path.join(output, named("pose-qa-a1-json", "json")), "{}");
  });
  after(() => rm(root, { recursive: true, force: true }));

  it("lists a retained output only when it is media", async () => {
    const empty = { project: "game", assets: [], truncated: false, skipped: [] };
    const job = { id: JOB, generationId: GEN, files: [], status: "downloaded", operation: "character" };
    const inventory = await reconcileGeneratedAssets(path.join(root, "game"), root, empty, [job]);
    assert.deepEqual(
      inventory.assets.map((asset) => path.basename(asset.file)),
      [named("rigged-a1-glb", "glb")],
    );
  });
});

describe("a generation's source copies", () => {
  it("reads a source by the role code in the output's name", () => {
    assert.equal(isGenexSourceOutput(`assets/genex/${JOB}/${named("source-a1-glb", "glb")}`, GEN), true);
    assert.equal(isGenexSourceOutput(named("walk-animation-a1-source-glb", "glb"), GEN), true);
    assert.equal(isGenexSourceOutput(named("animation-batch-0-613-r1-a1-source-glb", "glb"), GEN), true);
    assert.equal(isGenexSourceOutput(named("rigged-a1-glb", "glb"), GEN), false);
    assert.equal(isGenexSourceOutput(named("walk-animation-a1-glb", "glb"), GEN), false);
    assert.equal(
      isGenexSourceOutput("resource-pack-cmv6qk2b-rigged-a1-glb.glb", GEN),
      false,
      "the name before the id is not the role",
    );
    assert.equal(isGenexSourceOutput(named("source-a1-glb", "glb"), "other-generation"), false);
    assert.equal(isGenexSourceOutput(named("source-a1-glb", "glb"), undefined), false);
  });

  it("folds a source into the finished model of its generation, and keeps one that came alone", () => {
    const asset = (role: string, over: Record<string, string> = {}) => ({
      file: `assets/genex/${JOB}/${named(role, "glb")}`,
      kind: "model",
      source: "genex",
      generationId: GEN,
      ...over,
    });
    const shown = withoutGenexSources([
      asset("rigged-a1-glb"),
      asset("source-a1-glb"),
      asset("walk-animation-a1-source-glb"),
      asset("source-a1-glb", { generationId: "cmv6zzzz-alone", file: "assets/genex/x/hut-cmv6zzzz-source-a1-glb.glb" }),
      asset("source-a1-glb", { source: "blender" }),
    ]);
    assert.deepEqual(
      shown.map((file) => [path.basename(file.file), file.source]),
      [
        [named("rigged-a1-glb", "glb"), "genex"],
        ["hut-cmv6zzzz-source-a1-glb.glb", "genex"],
        [named("source-a1-glb", "glb"), "blender"],
      ],
    );
  });
});
