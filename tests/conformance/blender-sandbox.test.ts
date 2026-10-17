/**
 * Blender under the studio's own sandbox — AG-930 M0.
 *
 * Real Blender, real Seatbelt: the whole point of the runner is that Blender (which srt cannot
 * host) still runs contained. Skips with a reason on a Mac without Blender; every other machine
 * proves the boundary from both sides — a script that models exports and renders, a script that
 * raises exits 1, a write outside the allow-list is refused, a runaway is killed as a tree.
 */
import assert from "node:assert/strict";
import { access, constants, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { runNativeProcess } from "../../src/substrate/plugins/native-process.ts";
import {
  BLENDER_RENDER_SIZE,
  BLENDER_WRAPPER_PY,
  STUDIO_BLENDER_RESULT,
  frontRenderPath,
} from "../../src/plugins/blender/wrapper.ts";
import { decodePng, encodePng } from "../../scripts/evals/prober/png.ts";
import { tmpDir } from "../helpers/tmp.ts";

const BLENDER = process.env.STUDIO_TEST_BLENDER ?? "/Applications/Blender.app/Contents/MacOS/Blender";

async function haveBlender(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    await access(BLENDER, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const SKIP = !(await haveBlender()) && `no Blender at ${BLENDER}`;

function resultLine(stdout: string): Record<string, unknown> | null {
  const line = stdout
    .split("\n")
    .reverse()
    .find((l) => l.startsWith(STUDIO_BLENDER_RESULT));
  return line ? (JSON.parse(line.slice(STUDIO_BLENDER_RESULT.length)) as Record<string, unknown>) : null;
}

async function setup(): Promise<{
  root: string;
  ws: string;
  assets: string;
  out: string;
  scratch: string;
  wrapper: string;
}> {
  const root = await tmpDir("studio-blender-");
  const ws = path.join(root, "ws");
  const assets = path.join(ws, "assets");
  const out = path.join(root, "runs", "run_x", "facet_a", "blender");
  const scratch = path.join(root, "scratch");
  await mkdir(path.join(assets, "src"), { recursive: true });
  await mkdir(out, { recursive: true });
  await mkdir(scratch, { recursive: true });
  const wrapper = path.join(scratch, "wrapper.py");
  await writeFile(wrapper, BLENDER_WRAPPER_PY);
  return { root, ws, assets, out, scratch, wrapper };
}

/** Keep the original geometry/error/timeout assertions while exercising the new generic runner. */
async function runBlender(p: {
  binary: string;
  script: string;
  args: string[];
  cwd: string;
  allowWrite: string[];
  denyRead: string[];
  scratch: string;
  timeoutMs: number;
}) {
  const start = Date.now();
  const bundle = p.binary.includes(".app/") ? p.binary.slice(0, p.binary.indexOf(".app/") + 4) : path.dirname(p.binary);
  const result = await runNativeProcess({
    binary: p.binary,
    args: ["-b", "--factory-startup", "-noaudio", "--python-exit-code", "1", "--python", p.script, "--", ...p.args],
    cwd: p.cwd,
    scratch: p.scratch,
    reads: [bundle, p.cwd],
    writes: p.allowWrite,
    denyRead: p.denyRead,
    gpu: true,
    signal: new AbortController().signal,
    timeoutMs: p.timeoutMs,
    maxOutputBytes: 64000,
  });
  return { ...result, durationMs: Date.now() - start, timedOut: result.reason === "timeout" };
}

const MODEL_PY = `
import bpy
bpy.ops.mesh.primitive_cylinder_add(radius=0.3, depth=1.2, location=(0, 0, 0.6))
body = bpy.context.active_object
mat = bpy.data.materials.new("bark")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.4, 0.25, 0.1, 1)
body.data.materials.append(mat)
bpy.ops.mesh.primitive_ico_sphere_add(radius=0.8, subdivisions=2, location=(0, 0, 1.6))
crown = bpy.context.active_object
leaf = bpy.data.materials.new("leaf")
leaf.use_nodes = True
leaf.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.1, 0.5, 0.15, 1)
crown.data.materials.append(leaf)
`;

describe("blender under the studio's sandbox (AG-930)", () => {
  it("the generic native profile is deny-by-default, scopes reads and writes, and denies network", {
    skip: process.platform !== "darwin",
  }, async () => {
    const root = await tmpDir("native-profile-");
    const result = await runNativeProcess({
      binary: "/bin/echo",
      args: ["ready"],
      cwd: root,
      scratch: root,
      reads: [],
      writes: [],
      denyRead: ["/Users/fixture/secrets"],
      signal: new AbortController().signal,
      timeoutMs: 5000,
      maxOutputBytes: 4096,
    });
    assert.equal(result.code, 0, result.reason);
    assert.match(result.stdout, /ready/);
    const text = await readFile(path.join(root, "native.sb"), "utf8");
    assert.match(text, /^\(version 1\)\n\(deny default\)/);
    assert.match(text, /\(deny network\*\)/);
    assert.match(text, /\(deny file-read\*/);
    assert.ok(!text.includes("(allow file-read*)"), "no unrestricted file reads");
  });

  it("models, exports a GLB into assets/ and renders a PNG into the run folder", { skip: SKIP }, async () => {
    const { ws, assets, out, scratch, wrapper } = await setup();
    const script = path.join(assets, "src", "tree.py");
    await writeFile(script, MODEL_PY);
    const glb = path.join(assets, "tree.glb");
    const png = path.join(out, "tree-1.png");
    const result = await runBlender({
      binary: BLENDER,
      script: wrapper,
      args: [script, glb, png, "tree"],
      cwd: ws,
      allowWrite: [assets, out],
      denyRead: [],
      scratch,
      timeoutMs: 60_000,
    });
    const parsed = resultLine(result.stdout);
    assert.ok(
      parsed && parsed.ok === true,
      `result line: ${JSON.stringify(parsed)}\nstderr: ${result.stderr.slice(-800)}\nstdout: ${result.stdout.slice(-800)}`,
    );
    assert.equal(result.code, 0);
    assert.equal(parsed.meshCount, 2);
    const meshes = parsed.meshes as Array<{ name: string; polygons: number; triangles: number; materials: string[] }>;
    assert.deepEqual(
      meshes.map((m) => [m.name, m.materials]),
      [
        ["Cylinder", ["bark"]],
        ["Icosphere", ["leaf"]],
      ],
      "the result names what is inside the file: object names and their materials",
    );
    assert.deepEqual(parsed.materials, ["bark", "leaf"]);
    assert.ok((parsed.polygons as number) > 50);
    assert.ok(
      (parsed.triangles as number) >= (parsed.polygons as number),
      "triangles are counted beside polygons (an n-gon is n-2 of them)",
    );
    assert.equal(
      parsed.triangles,
      meshes.reduce((sum, m) => sum + m.triangles, 0),
    );
    assert.equal(meshes[1]!.triangles, meshes[1]!.polygons, "an icosphere is all triangles");
    const bytes = await readFile(glb);
    assert.ok(bytes.length > 1024 && bytes.subarray(0, 4).toString("latin1") === "glTF", "a real GLB was written");
    const front = frontRenderPath(png);
    assert.deepEqual(parsed.renders, [png, front]);
    for (const file of [png, front]) {
      const image = await readFile(file);
      assert.equal(image.subarray(1, 4).toString("latin1"), "PNG", `a real PNG was rendered: ${file}`);
      assert.deepEqual(
        [image.readUInt32BE(16), image.readUInt32BE(20)],
        [...BLENDER_RENDER_SIZE],
        `${file} is ${BLENDER_RENDER_SIZE.join("×")}`,
      );
    }
    assert.ok(result.durationMs < 20_000, `${result.durationMs} ms`);
  });

  it("framing leaves a thin tail out: a cube with a long thin cable is framed on the cube", {
    skip: SKIP,
  }, async () => {
    const { ws, assets, out, scratch, wrapper } = await setup();
    const script = path.join(assets, "src", "kettle.py");
    await writeFile(
      script,
      `
import bpy
bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.5))
bpy.context.active_object.name = "Body"
bpy.ops.mesh.primitive_cylinder_add(radius=0.004, depth=20.0, location=(0, 0, -10.0))
bpy.context.active_object.name = "Cable"
`,
    );
    const png = path.join(out, "kettle-1.png");
    const result = await runBlender({
      binary: BLENDER,
      script: wrapper,
      args: [script, path.join(assets, "kettle.glb"), png, "kettle"],
      cwd: ws,
      allowWrite: [assets, out],
      denyRead: [],
      scratch,
      timeoutMs: 60_000,
    });
    const parsed = resultLine(result.stdout);
    assert.ok(
      parsed && parsed.ok === true,
      `result line: ${JSON.stringify(parsed)}\nstderr: ${result.stderr.slice(-800)}`,
    );
    const size = parsed.size as number[];
    const framed = parsed.framedSize as number[];
    assert.ok(size[2]! > 19, `the asset itself is ${size[2]} tall — the cable is in the file`);
    assert.ok(
      Math.abs(framed[2]! - 1) < 0.01 && Math.abs(framed[0]! - 1) < 0.01,
      `the frame is the cube: ${framed.join(" × ")}`,
    );
    const meshes = parsed.meshes as Array<{ name: string; materials: string[] }>;
    assert.deepEqual(
      meshes.map((m) => [m.name, m.materials]),
      [
        ["Body", []],
        ["Cable", []],
      ],
      "a mesh without a material says so",
    );
    assert.deepEqual(parsed.materials, []);
    await readFile(frontRenderPath(png));
  });

  it("counts each material slot's faces and triangles, an empty slot as none", { skip: SKIP }, async () => {
    const { ws, assets, out, scratch, wrapper } = await setup();
    const script = path.join(assets, "src", "crate.py");
    // A cube of six quads: two faces on the second slot, none on the third.
    await writeFile(
      script,
      [
        "import bpy",
        "bpy.ops.mesh.primitive_cube_add(size=1)",
        "cube = bpy.context.active_object",
        "for name in ('wood', 'iron', 'paint'):",
        "    cube.data.materials.append(bpy.data.materials.new(name))",
        "for face in cube.data.polygons[:2]:",
        "    face.material_index = 1",
        "",
      ].join("\n"),
    );
    const result = await runBlender({
      binary: BLENDER,
      script: wrapper,
      args: [script, path.join(assets, "crate.glb"), path.join(out, "crate-1.png"), "crate"],
      cwd: ws,
      allowWrite: [assets, out],
      denyRead: [],
      scratch,
      timeoutMs: 60_000,
    });
    const parsed = resultLine(result.stdout);
    assert.ok(parsed?.ok === true, `result line: ${JSON.stringify(parsed)}\nstderr: ${result.stderr.slice(-800)}`);
    const [mesh] = parsed.meshes as Array<{ slots?: unknown }>;
    assert.deepEqual(mesh?.slots, [
      { slot: 0, material: "wood", polygons: 4, triangles: 8 },
      { slot: 1, material: "iron", polygons: 2, triangles: 4 },
      { slot: 2, material: "paint", polygons: 0, triangles: 0 },
    ]);
  });

  it("a script that raises exits 1 with the traceback in the result line", { skip: SKIP }, async () => {
    const { ws, assets, out, scratch, wrapper } = await setup();
    const script = path.join(assets, "src", "bad.py");
    await writeFile(script, "import bpy\nraise RuntimeError('no such primitive')\n");
    const result = await runBlender({
      binary: BLENDER,
      script: wrapper,
      args: [script, path.join(assets, "bad.glb"), path.join(out, "bad-1.png"), "bad"],
      cwd: ws,
      allowWrite: [assets, out],
      denyRead: [],
      scratch,
      timeoutMs: 60_000,
    });
    const parsed = resultLine(result.stdout);
    assert.equal(result.code, 1, "--python-exit-code 1 turns the exception into a non-zero exit");
    assert.ok(parsed && parsed.ok === false);
    assert.match(String(parsed.error), /no such primitive/);
  });

  it("a script cannot write outside the allow-list, and cannot reach the network", { skip: SKIP }, async () => {
    const { root, ws, assets, out, scratch, wrapper } = await setup();
    const outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    const script = path.join(assets, "src", "escape.py");
    await writeFile(
      script,
      `
import bpy, socket
errors = []
try:
    open(${JSON.stringify(path.join(outside, "x.txt"))}, "w").write("escaped")
except Exception as e:
    errors.append("write: " + type(e).__name__ + " " + str(e))
try:
    s = socket.create_connection(("1.1.1.1", 443), timeout=3)
    s.close()
except Exception as e:
    errors.append("net: " + type(e).__name__)
raise RuntimeError(" | ".join(errors))
`,
    );
    const result = await runBlender({
      binary: BLENDER,
      script: wrapper,
      args: [script, path.join(assets, "escape.glb"), path.join(out, "escape-1.png"), "escape"],
      cwd: ws,
      allowWrite: [assets, out],
      denyRead: [],
      scratch,
      timeoutMs: 60_000,
    });
    const parsed = resultLine(result.stdout);
    assert.ok(parsed && parsed.ok === false, JSON.stringify(parsed));
    assert.match(String(parsed.error), /write: PermissionError/, "the write outside the allow-list is refused");
    assert.match(String(parsed.error), /net: /, "the socket is refused");
    await assert.rejects(readFile(path.join(outside, "x.txt")), "nothing escaped");
  });

  it("a runaway script is killed as a process tree at the timeout", { skip: SKIP }, async () => {
    const { ws, assets, out, scratch, wrapper } = await setup();
    const script = path.join(assets, "src", "sleep.py");
    await writeFile(script, "import time\ntime.sleep(60)\n");
    const result = await runBlender({
      binary: BLENDER,
      script: wrapper,
      args: [script, path.join(assets, "sleep.glb"), path.join(out, "sleep-1.png"), "sleep"],
      cwd: ws,
      allowWrite: [assets, out],
      denyRead: [],
      scratch,
      timeoutMs: 3_000,
    });
    assert.equal(result.timedOut, true);
    assert.ok(result.pid);
    assert.throws(() => process.kill(result.pid!, 0), "the process is gone");
  });

  it("renders a shader's Base Color in colour, and a textured material by its image", { skip: SKIP }, async () => {
    const { ws, assets, out, scratch, wrapper } = await setup();
    const script = path.join(assets, "src", "pair.py");
    await writeFile(script, PAIR_PY);
    const png = path.join(out, "pair-1.png");
    const result = await runBlender({
      binary: BLENDER,
      script: wrapper,
      args: [script, path.join(assets, "pair.glb"), png, "pair"],
      cwd: ws,
      allowWrite: [assets, out],
      denyRead: [],
      scratch,
      timeoutMs: 60_000,
    });
    const parsed = resultLine(result.stdout);
    assert.ok(parsed?.ok === true, `result line: ${JSON.stringify(parsed)}\nstderr: ${result.stderr.slice(-800)}`);
    for (const file of [png, frontRenderPath(png)]) {
      const frame = decodePng(await readFile(file));
      assert.ok(share(frame, isRed) > 0.01, `${path.basename(file)} shows the red material in red`);
      assert.ok(share(frame, isBlue) > 0.01, `${path.basename(file)} shows the textured material's blue image`);
    }
  });

  it("reads extra inputs only as staged: a shared module imports by name, an image by its game path", {
    skip: SKIP,
  }, async () => {
    const { root, assets, out, scratch, wrapper } = await setup();
    const staged = path.join(root, "job", "inputs");
    await mkdir(staged, { recursive: true });
    const script = path.join(staged, "script.py");
    await writeFile(script, PANEL_PY);
    await writeFile(path.join(staged, "input1.py"), "PANEL = (2.0, 0.2, 3.0)\n");
    const orange = {
      width: 4,
      height: 4,
      data: new Uint8Array(4 * 4 * 4).fill(255).map((v, i) => (i % 4 === 2 ? 0 : i % 4 === 1 ? 128 : v)),
    };
    await writeFile(path.join(staged, "input2.png"), encodePng(orange));
    const slots = ["input1.py", "input2.png", ...Array(7).fill("script.py")].flatMap((file) => [
      "--slot",
      path.join(staged, file),
    ]);
    const result = await runBlender({
      binary: BLENDER,
      script: wrapper,
      args: [
        script,
        path.join(assets, "panel.glb"),
        path.join(out, "panel-1.png"),
        "panel",
        "--rig",
        "0",
        "--inputs",
        "assets/src/kit_common.py,assets/genex/job-a/rust.png",
        ...slots,
      ],
      cwd: staged,
      allowWrite: [assets, out],
      denyRead: [],
      scratch,
      timeoutMs: 60_000,
    });
    const parsed = resultLine(result.stdout);
    assert.ok(parsed?.ok === true, `result line: ${JSON.stringify(parsed)}\nstderr: ${result.stderr.slice(-800)}`);
    const size = (parsed.size as number[]).map((n) => Math.round(n * 100) / 100);
    assert.deepEqual(size, [4, 0.4, 6], "the module's numbers shaped the mesh");
    assert.deepEqual(parsed.materials, ["Rust"]);
  });

  it("exports an armature and its action only when asked to", { skip: SKIP }, async () => {
    const { ws, assets, out, scratch, wrapper } = await setup();
    const script = path.join(assets, "src", "arm.py");
    await writeFile(script, RIGGED_PY);
    const run = async (rig: string) => {
      const glb = path.join(assets, `arm-${rig}.glb`);
      const result = await runBlender({
        binary: BLENDER,
        script: wrapper,
        args: [script, glb, path.join(out, `arm-${rig}.png`), "arm", "--rig", rig],
        cwd: ws,
        allowWrite: [assets, out],
        denyRead: [],
        scratch,
        timeoutMs: 60_000,
      });
      const parsed = resultLine(result.stdout);
      assert.ok(parsed?.ok === true, `result line: ${JSON.stringify(parsed)}\nstderr: ${result.stderr.slice(-800)}`);
      return { parsed, gltf: glbJson(await readFile(glb)) };
    };
    const still = await run("0");
    assert.deepEqual(still.parsed.armatures, [{ name: "Armature", bones: 2 }], "the result names the armature");
    assert.deepEqual(still.parsed.actions, ["Swing"]);
    assert.equal(still.parsed.rig, false);
    assert.equal(still.gltf.skins, undefined, "a plain export carries no skin");
    assert.equal(still.gltf.animations, undefined, "nor any animation");
    const rigged = await run("1");
    assert.equal(rigged.parsed.rig, true);
    assert.equal(rigged.gltf.skins?.length, 1, "the mesh keeps its skin");
    assert.equal(rigged.gltf.skins?.[0]?.joints?.length, 2, "with both bones");
    assert.ok(
      rigged.gltf.animations?.some((a: { name?: string }) => a.name === "Swing"),
      `the action is a clip: ${JSON.stringify(rigged.gltf.animations?.map((a: { name?: string }) => a.name))}`,
    );
  });

  it("applies a rig's centimetre armature scale to its bones and clips, so every bone is in metres", {
    skip: SKIP,
  }, async () => {
    const { ws, assets, out, scratch, wrapper } = await setup();
    const script = path.join(assets, "src", "cm.py");
    await writeFile(script, CENTIMETRE_RIG_PY);
    const glb = path.join(assets, "cm.glb");
    const result = await runBlender({
      binary: BLENDER,
      script: wrapper,
      args: [script, glb, path.join(out, "cm.png"), "cm", "--rig", "1"],
      cwd: ws,
      allowWrite: [assets, out],
      denyRead: [],
      scratch,
      timeoutMs: 60_000,
    });
    const parsed = resultLine(result.stdout);
    assert.ok(parsed?.ok === true, `result line: ${JSON.stringify(parsed)}\nstderr: ${result.stderr.slice(-800)}`);
    assert.deepEqual(parsed.armatures, [{ name: "Armature", bones: 2, appliedScale: 0.01 }]);
    const bytes = await readFile(glb);
    const gltf = glbJson(bytes);
    const root = gltf.skins[0].joints[0];
    assert.equal(rootChainScale(gltf, root).toFixed(3), "1.000", "no scale left above or on the root bone");
    assert.equal(
      gltf.nodes[gltf.skins[0].joints[1]].translation[1].toFixed(2),
      "1.00",
      "the second bone sits a metre up",
    );
    const moves = rootTranslations(gltf, bytes, root);
    assert.equal(Math.max(...moves.map(Math.abs)).toFixed(2), "0.50", "the clip moves the root half a metre");
  });
});

/** The product of the uniform scales of a node and every node above it. */
function rootChainScale(gltf: Record<string, any>, node: number): number {
  const parents = new Map<number, number>();
  gltf.nodes.forEach((n: { children?: number[] }, i: number) => {
    for (const child of n.children ?? []) parents.set(child, i);
  });
  let product = 1;
  for (let at: number | undefined = node; at !== undefined; at = parents.get(at))
    product *= (gltf.nodes[at].scale ?? [1, 1, 1])[0];
  return product;
}

/** Every component of the translation keys a GLB's clips give `node`. */
function rootTranslations(gltf: Record<string, any>, bytes: Buffer, node: number): number[] {
  const json = bytes.readUInt32LE(12);
  const bin = bytes.subarray(20 + json + 8);
  const values: number[] = [];
  for (const clip of gltf.animations ?? [])
    for (const channel of clip.channels)
      if (channel.target.node === node && channel.target.path === "translation") {
        const accessor = gltf.accessors[clip.samplers[channel.sampler].output];
        const view = gltf.bufferViews[accessor.bufferView];
        const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
        for (let i = 0; i < accessor.count * 3; i++) values.push(bin.readFloatLE(start + i * 4));
      }
  return values;
}

/** Two cubes: one whose Principled Base Color is red, one whose Base Color is a blue image. */
const PAIR_PY = `
import bpy
bpy.ops.mesh.primitive_cube_add(size=1, location=(-0.8, 0, 0.5))
red = bpy.data.materials.new("Red")
red.use_nodes = True
red.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.9, 0.03, 0.03, 1)
bpy.context.active_object.data.materials.append(red)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0.8, 0, 0.5))
image = bpy.data.images.new("Blue", 8, 8)
image.pixels[:] = [0.03, 0.06, 0.9, 1.0] * 64
image.pack()
blue = bpy.data.materials.new("Blue")
blue.use_nodes = True
texture = blue.node_tree.nodes.new("ShaderNodeTexImage")
texture.image = image
blue.node_tree.links.new(texture.outputs["Color"], blue.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
bpy.context.active_object.data.materials.append(blue)
`;

/** A panel sized by a shared module and painted with an image, both read from ASSET_INPUTS. */
const PANEL_PY = `
import bpy
import kit_common
assert set(ASSET_INPUTS) == {"assets/src/kit_common.py", "assets/genex/job-a/rust.png"}, sorted(ASSET_INPUTS)
bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 0))
panel = bpy.context.active_object
panel.scale = kit_common.PANEL
image = bpy.data.images.load(ASSET_INPUTS["assets/genex/job-a/rust.png"])
assert image.name == "rust.png", image.name
rust = bpy.data.materials.new("Rust")
rust.use_nodes = True
texture = rust.node_tree.nodes.new("ShaderNodeTexImage")
texture.image = image
rust.node_tree.links.new(texture.outputs["Color"], rust.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
panel.data.materials.append(rust)
`;

/** A two-bone arm skinning a box, with an action named Swing that bends the second bone. */
const RIGGED_PY = `
import bpy
bpy.ops.object.armature_add(location=(0, 0, 0))
arm = bpy.context.active_object
arm.name = "Armature"
bpy.ops.object.mode_set(mode="EDIT")
root = arm.data.edit_bones[0]
root.name = "Root"
root.head, root.tail = (0, 0, 0), (0, 0, 1)
tip = arm.data.edit_bones.new("Tip")
tip.head, tip.tail, tip.parent = (0, 0, 1), (0, 0, 2), root
bpy.ops.object.mode_set(mode="OBJECT")
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 1))
box = bpy.context.active_object
box.scale = (0.3, 0.3, 1.0)
box.parent = arm
for bone in ("Root", "Tip"):
    group = box.vertex_groups.new(name=bone)
    group.add([v.index for v in box.data.vertices if (v.co.z > 0) == (bone == "Tip")], 1.0, "REPLACE")
box.modifiers.new("Armature", "ARMATURE").object = arm
action = bpy.data.actions.new("Swing")
arm.animation_data_create()
arm.animation_data.action = action
pose = arm.pose.bones["Tip"]
pose.rotation_mode = "XYZ"
for frame, angle in ((1, 0.0), (20, 1.2)):
    pose.rotation_euler = (angle, 0, 0)
    pose.keyframe_insert("rotation_euler", frame=frame)
`;

/** The share of a frame's pixels that pass `test`. */
function share(
  frame: { width: number; height: number; data: Uint8Array },
  test: (r: number, g: number, b: number) => boolean,
) {
  let hits = 0;
  for (let i = 0; i < frame.data.length; i += 4)
    if (test(frame.data[i]!, frame.data[i + 1]!, frame.data[i + 2]!)) hits++;
  return hits / (frame.width * frame.height);
}
const isRed = (r: number, g: number, b: number) => r > g + 60 && r > b + 60;
const isBlue = (r: number, g: number, b: number) => b > r + 60 && b > g + 40;

/** A GLB's JSON chunk. */
function glbJson(bytes: Buffer): Record<string, any> {
  const length = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + length).toString("utf8"));
}

/** A two-bone rig made in centimetres under an armature scaled 0.01 (as Genex's Meshy rigs come), with a clip that lifts the root 50 cm. */
const CENTIMETRE_RIG_PY = `
import bpy
bpy.ops.object.armature_add(location=(0, 0, 0))
arm = bpy.context.active_object
arm.name = "Armature"
bpy.ops.object.mode_set(mode="EDIT")
root = arm.data.edit_bones[0]
root.name = "Root"
root.head, root.tail = (0, 0, 0), (0, 0, 100)
tip = arm.data.edit_bones.new("Tip")
tip.head, tip.tail, tip.parent = (0, 0, 100), (0, 0, 200), root
bpy.ops.object.mode_set(mode="OBJECT")
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 100))
box = bpy.context.active_object
box.scale = (30, 30, 200)
box.parent = arm
for bone in ("Root", "Tip"):
    group = box.vertex_groups.new(name=bone)
    group.add([v.index for v in box.data.vertices if (v.co.z > 0) == (bone == "Tip")], 1.0, "REPLACE")
box.modifiers.new("Armature", "ARMATURE").object = arm
arm.scale = (0.01, 0.01, 0.01)
action = bpy.data.actions.new("Lift")
arm.animation_data_create()
arm.animation_data.action = action
pose = arm.pose.bones["Root"]
for frame, up in ((1, 0.0), (20, 50.0)):
    pose.location = (0, up, 0)
    pose.keyframe_insert("location", frame=frame)
`;
