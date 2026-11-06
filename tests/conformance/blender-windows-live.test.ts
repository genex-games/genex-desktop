// Local Blender on Windows for real: its manifest's pinned zip (about 400 MB, downloaded) installs, and a
// model job and a compose job run in the process sandbox through PluginNativeServices as the app wires
// them. Windows only, and opt-in (`STUDIO_NETWORK_TESTS=1`, the Windows workflow's `network` input): it
// reaches download.blender.org.
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { it } from "node:test";
import { BLENDER_WRAPPER_PY } from "../../src/plugins/blender/wrapper.ts";
import type { PluginNativeResult } from "../../src/shared/plugins.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { PluginNativeServices } from "../../src/substrate/plugins/native.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

const TREE_PY = `
import bpy
bpy.ops.mesh.primitive_cylinder_add(radius=0.3, depth=1.2, location=(0, 0, 0.6))
body = bpy.context.active_object
mat = bpy.data.materials.new("bark")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.4, 0.25, 0.1, 1)
body.data.materials.append(mat)
`;

/** A module a compose job hands the script as an extra input: it imports it by name. */
const PARTS_PY = `
import bpy
def post(height):
    bpy.ops.mesh.primitive_cube_add(size=0.4, location=(0, 0, height / 2))
    bpy.context.active_object.scale.z = height / 0.4
`;

/**
 * A lantern from that module, which also makes temp folders as a script may: Python's mkdtemp on
 * Windows asks for a folder only its owner opens, which the job's sandbox once refused every time.
 */
const LANTERN_PY = `
import tempfile, parts
parts.post(1.5)
tempfile.mkdtemp(prefix="lantern-")
with tempfile.TemporaryDirectory():
    pass
`;

it("installs Blender and runs a model job and a compose job sandboxed on Windows", {
  skip:
    (process.platform !== "win32" || process.env.STUDIO_NETWORK_TESTS !== "1") &&
    "Windows with STUDIO_NETWORK_TESTS=1 only",
  timeout: 20 * 60_000,
}, async () => {
  const root = await tmpDir("bwin-");
  const work = path.join(root, "native-work"),
    runtimes = path.join(root, "native-runtimes"),
    pkg = path.join(root, "package"),
    storage = path.join(root, "storage"),
    game = path.join(root, "game");
  for (const dir of [work, runtimes, pkg, storage, path.join(game, "assets", "src")])
    await mkdir(dir, { recursive: true });
  await writeFile(path.join(pkg, "wrapper.py"), BLENDER_WRAPPER_PY);
  await writeFile(path.join(game, "assets", "src", "tree.py"), TREE_PY);
  await writeFile(path.join(game, "assets", "src", "parts.py"), PARTS_PY);
  await writeFile(path.join(game, "assets", "src", "lantern.py"), LANTERN_PY);
  const manifest = validateManifest(
    JSON.parse(await readFile(new URL("../../src/plugins/blender/plugin.json", import.meta.url), "utf8")),
  );
  const sandbox = await ProcessSandbox.create({
    writableRoots: [game, work],
    scratchDir: path.join(root, "scratch"),
    secretPaths: [],
    readableRoots: [runtimes],
  });
  try {
    const service = new PluginNativeServices(root, [], {
      settings: async () => ({}),
      windows: { sandbox: () => sandbox, work, runtimes },
    });
    const binding = { project: "game", directory: game };
    const call = (method: string, args: unknown, source = "action") =>
      service.call(
        manifest,
        pkg,
        storage,
        method,
        args,
        binding,
        { method: source, name: "install", signal: new AbortController().signal },
        (e) => void e,
      );
    const t0 = Date.now();
    const installed = await call("runtime.install", { runtime: "blender" });
    console.log("install", Date.now() - t0, "ms", JSON.stringify(installed));
    const ready = (await call("runtime.detect", { runtime: "blender" }, "tool")) as {
      state: string;
      version?: string;
      path?: string;
    };
    console.log("after install", JSON.stringify(ready));
    assert.equal(ready.state, "ready");
    const t1 = Date.now();
    const job = (await call(
      "native.run",
      { job: "model", inputs: { script: "assets/src/tree.py" }, values: { name: "tree", rig: "0" } },
      "tool",
    )) as PluginNativeResult;
    console.log(
      "job",
      Date.now() - t1,
      "ms",
      JSON.stringify({ ...job, stdout: job.stdout?.slice(-2500), stderr: job.stderr?.slice(-2500) }),
    );
    assert.equal(job.state, "completed", job.stderr || job.reason);
    for (const file of ["model.glb", "render.png", "render-front.png"])
      console.log(file, (await stat(path.join(job.output, file))).size);
    assert.match(job.stdout ?? "", /"renderer": "(workbench|cycles-cpu)"/);

    // A compose job: the extra input is copied under its own name into a temp folder of the job's,
    // and the script makes temp folders of its own.
    const script = "assets/src/lantern.py";
    const slots = Object.fromEntries(
      Array.from({ length: 9 }, (_, slot) => [`input${slot + 1}`, slot === 0 ? "assets/src/parts.py" : script]),
    );
    const composed = (await call(
      "native.run",
      {
        job: "compose",
        inputs: { script, ...slots },
        values: { name: "lantern", rig: "0", inputs: "assets/src/parts.py" },
      },
      "tool",
    )) as PluginNativeResult;
    console.log(
      "compose",
      JSON.stringify({ ...composed, stdout: composed.stdout?.slice(-2500), stderr: composed.stderr?.slice(-2500) }),
    );
    assert.equal(composed.state, "completed", composed.stdout || composed.stderr || composed.reason);
    assert.deepEqual([...composed.files].sort(), ["model.glb", "render-front.png", "render.png"]);
  } finally {
    await sandbox.dispose();
  }
});
