import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { PluginContext, PluginHostCall, PluginNativeResult } from "../../src/plugin-sdk/index.d.ts";
import { activate } from "../../src/plugins/blender/backend.ts";
import { STUDIO_BLENDER_RESULT } from "../../src/plugins/blender/wrapper.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { tmpDir } from "../helpers/tmp.ts";

async function fixture() {
  const output = await tmpDir("blender-fbx-");
  for (const file of ["render.png", "render-front.png"]) await writeFile(path.join(output, file), "render");
  const calls: Array<{ method: string; args: any }> = [];
  const host: PluginHostCall = async (method: string, args?: any): Promise<any> => {
    calls.push({ method, args });
    if (method === "native.run") {
      const fbx = args.job.endsWith("-fbx");
      return {
        id: "11111111-1111-4111-8111-111111111111",
        recipe: args.job,
        runtime: "blender",
        state: "completed",
        project: "game",
        output,
        files: ["model.glb", ...(fbx ? ["model.fbx"] : []), "render.png", "render-front.png"],
        stdout: `${STUDIO_BLENDER_RESULT}${JSON.stringify({ ok: true, glbBytes: 10, ...(fbx ? { fbxBytes: 20 } : {}), renders: [] })}`,
        createdAt: "2026-10-09T00:00:00Z",
      } satisfies PluginNativeResult;
    }
    if (method === "assets.deliver") return ["Assets/Generated/blender/job/model.fbx"];
    if (method === "jobs.write") return true;
    assert.fail(`Unexpected host call: ${method}`);
  };
  const context: PluginContext = { signal: new AbortController().signal, callId: 1, host };
  const plugin = await activate({ call: host });
  assert.ok(plugin.tool);
  return { tool: plugin.tool, context, calls };
}

test("Blender keeps GLB as default and selects an explicit FBX recipe for models and transforms", async () => {
  for (const [args, recipe] of [
    [{ name: "cube" }, "model"],
    [{ name: "cube", format: "glb", model: "assets/source.glb" }, "transform"],
    [{ name: "cube", format: "fbx" }, "model-fbx"],
    [{ name: "cube", format: "fbx", model: "Assets/source.glb" }, "transform-fbx"],
  ] as const) {
    const f = await fixture();
    const result = (await f.tool("model", args, f.context)) as { guidance: string; stats: { fbxBytes?: number } };
    assert.equal(f.calls[0]?.args.job, recipe);
    assert.deepEqual(f.calls[0]?.args.inputs, {
      script: "assets/src/cube.py",
      ...("model" in args ? { model: args.model } : {}),
    });
    if (recipe.endsWith("-fbx")) {
      assert.equal(result.stats.fbxBytes, 20);
      assert.match(result.guidance, /model\.fbx.*Unity/);
    } else {
      assert.equal(result.stats.fbxBytes, undefined);
      assert.match(result.guidance, /GLTFLoader/);
    }
    assert.equal(f.calls.at(-1)?.method, "jobs.write");
  }
});

test("an unsupported Blender format starts no native job or delivery", async () => {
  for (const format of ["obj", "FBX", "../model.fbx", ""]) {
    const f = await fixture();
    await assert.rejects(f.tool("model", { name: "cube", format }, f.context), /format/);
    assert.deepEqual(f.calls, []);
  }
});

test("reviewed FBX launch recipes declare both models and preserve the transform input position", async () => {
  const manifest = validateManifest(JSON.parse(await readFile("src/plugins/blender/plugin.json", "utf8")));
  for (const id of ["model-fbx", "transform-fbx"]) {
    const recipe = manifest.nativeJobs?.find((job) => job.id === id);
    assert.ok(recipe, id);
    assert.deepEqual(recipe.outputs, ["model.glb", "model.fbx", "render.png", "render-front.png"]);
    const flag = recipe.args.indexOf("--fbx");
    assert.ok(flag > 0, id);
    assert.deepEqual(recipe.args[flag + 1], { source: "output", name: "model.fbx" });
    if (id === "transform-fbx") assert.deepEqual(recipe.args[flag - 1], { source: "input", name: "model" });
  }
});
