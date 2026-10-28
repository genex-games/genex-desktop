/**
 * The helper library every `blender__model` job can import (`src/plugins/blender/genex_bpy.py`, WP-0
 * and WP-8), in real Blender through the real wrapper: scanned maps become a PBR material, a slab is
 * bevelled and unwrapped and refuses flat colour, a set of objects bakes with curvature edge wear
 * into one atlas GLB with one UV set, a dense model decimates to a budget, and the result names the
 * materials that are flat colour. Skips with a reason on a machine without Blender; Blender runs
 * here unsandboxed (`blender-sandbox.test.ts` holds the sandbox).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, constants, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { encodePng } from "../../scripts/evals/prober/png.ts";
import { BLENDER_WRAPPER_PY, STUDIO_BLENDER_RESULT } from "../../src/plugins/blender/wrapper.ts";
import { readGlb } from "../../src/substrate/asset-import/glb.ts";
import { bumpyGrid } from "../helpers/dense-glb.ts";
import { tmpDir } from "../helpers/tmp.ts";

const exec = promisify(execFile);
const BLENDER = process.env.STUDIO_TEST_BLENDER ?? "/Applications/Blender.app/Contents/MacOS/Blender";
const HELPERS = fileURLToPath(new URL("../../src/plugins/blender/genex_bpy.py", import.meta.url));
/** A bake of two slabs on the CPU at 256 px and one sample stays well under this. */
const JOB_TIMEOUT_MS = 180_000;
const SCAN_PX = 64;

async function haveBlender(): Promise<boolean> {
  try {
    await access(BLENDER, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const SKIP = !(await haveBlender()) && `no Blender at ${BLENDER}`;

type Json = Record<string, any>;

/** A flat RGBA scan map of `rgb`, with a little noise so it is an image and not one colour. */
function scanMap(rgb: [number, number, number]): Uint8Array {
  const data = new Uint8Array(SCAN_PX * SCAN_PX * 4);
  for (let at = 0; at < SCAN_PX * SCAN_PX; at++) {
    const grain = (at * 37) % 17;
    data.set([rgb[0] + grain, rgb[1] + grain, rgb[2] + grain, 255], at * 4);
  }
  return encodePng({ width: SCAN_PX, height: SCAN_PX, data });
}

/** Run `script` through the wrapper with the helpers; `inputs` are staged under their labels, `model` as the model. */
async function model(script: string, options: { inputs?: Record<string, Uint8Array>; model?: Uint8Array } = {}) {
  const root = await tmpDir("blender-helpers-");
  const wrapper = path.join(root, "wrapper.py");
  await writeFile(wrapper, BLENDER_WRAPPER_PY);
  await writeFile(path.join(root, "script.py"), script);
  const args = [path.join(root, "script.py"), path.join(root, "model.glb"), path.join(root, "render.png"), "piece"];
  args.push("--rig", "0", "--helpers", HELPERS);
  if (options.model) {
    await writeFile(path.join(root, "source.glb"), options.model);
    args.push("--model", path.join(root, "source.glb"));
  }
  const labels = Object.keys(options.inputs ?? {});
  if (labels.length) {
    await mkdir(path.join(root, "slots"));
    args.push("--inputs", labels.join(","));
    for (const label of labels) {
      const slot = path.join(root, "slots", path.basename(label));
      await writeFile(slot, options.inputs?.[label] ?? new Uint8Array());
      args.push("--slot", slot);
    }
  }
  const run = await exec(
    BLENDER,
    ["-b", "--factory-startup", "-noaudio", "--python-exit-code", "1", "--python", wrapper, "--", ...args],
    { timeout: JOB_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
  ).catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }));
  const line = run.stdout.split("\n").find((each) => each.startsWith(STUDIO_BLENDER_RESULT));
  assert.ok(line, `a result line: ${run.stdout.slice(-2000)}`);
  const result = JSON.parse(line.slice(STUDIO_BLENDER_RESULT.length)) as Json;
  const glb = result.ok ? new Uint8Array(await readFile(path.join(root, "model.glb"))) : null;
  return { result, glb };
}

const SCANS = {
  "assets/cc0/job-a/crate_wood_diff_1k.png": scanMap([120, 80, 50]),
  "assets/cc0/job-a/crate_wood_nor_gl_1k.png": scanMap([128, 128, 255]),
  "assets/cc0/job-a/crate_wood_arm_1k.png": scanMap([255, 170, 0]),
};

describe("genex_bpy in a blender__model job", () => {
  it("bakes scanned, bevelled, worn slabs into one PBR atlas with one UV set", { skip: SKIP }, async () => {
    const { result, glb } = await model(
      [
        "import genex_bpy as gx",
        'wood = gx.pbr("wood", gx.scan(ASSET_INPUTS, "crate_wood"))',
        'seat = gx.slab("seat", (1.6, 0.4, 0.05), wood, location=(0, 0, 0.45))',
        'leg = gx.slab("leg", (0.06, 0.38, 0.45), wood, location=(0.7, 0, 0))',
        'gx.bake_atlas([seat, leg], size=256, wear=0.6, samples=1, name="bench")',
        "",
      ].join("\n"),
      { inputs: SCANS },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.untextured, []);
    assert.deepEqual(result.materials, ["bench"]);
    assert.ok(result.triangles > 2 * 12 * 4, `bevelled, not 12 triangles a box: ${result.triangles}`);
    const { json } = readGlb(glb ?? new Uint8Array());
    const [material] = json.materials as Json[];
    assert.ok(material?.pbrMetallicRoughness?.baseColorTexture, "a colour atlas");
    assert.ok(material?.pbrMetallicRoughness?.metallicRoughnessTexture, "a metallic-roughness atlas");
    assert.ok(material?.normalTexture, "a normal atlas");
    for (const mesh of json.meshes as Json[]) {
      for (const primitive of mesh.primitives as Json[]) {
        assert.ok(primitive.attributes.TEXCOORD_0 !== undefined, "the atlas UVs");
        assert.equal(primitive.attributes.TEXCOORD_1, undefined, "one UV set, the engine's");
      }
    }
  });

  it("refuses a slab of flat colour, naming why", { skip: SKIP }, async () => {
    const { result } = await model(
      [
        "import bpy, genex_bpy as gx",
        'paint = bpy.data.materials.new("paint")',
        'gx.slab("seat", (1, 1, 1), paint)',
        "",
      ].join("\n"),
    );
    assert.equal(result.ok, false);
    assert.match(String(result.error), /flat colour/);
  });

  it("names the materials no image feeds", { skip: SKIP }, async () => {
    const { result } = await model(
      [
        "import bpy",
        "bpy.ops.mesh.primitive_cube_add()",
        'paint = bpy.data.materials.new("paint")',
        "bpy.context.object.data.materials.append(paint)",
        "",
      ].join("\n"),
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.untextured, ["paint"]);
  });

  it("decimates an imported dense model to a triangle budget", { skip: SKIP }, async () => {
    const { result } = await model(
      ["import genex_bpy as gx", 'parts = gx.load(ASSET_INPUTS["model"])', "gx.decimate_to(parts, 4000)", ""].join(
        "\n",
      ),
      { model: bumpyGrid(120) },
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.triangles <= 4_200 && result.triangles >= 2_000, `${result.triangles} triangles`);
  });
});
