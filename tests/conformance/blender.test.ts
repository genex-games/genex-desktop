/** Public-plugin integration tests. Native Blender and sandbox tests run separately. */
import assert from "node:assert/strict";
import { chmod, cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { customEvents, startRig, type Rig } from "../helpers/studio-rig.ts";
import { tmpDir } from "../helpers/tmp.ts";

const rigs: Rig[] = [];
after(async () => {
  await Promise.all(rigs.map((rig) => rig.stop().catch(() => {})));
});

/**
 * A fake Blender: answers `-b --version`, and for a real call writes a `glTF`-prefixed file
 * and a PNG-magic file where the wrapper's `--` arguments say, then prints the result line.
 * `BIG=1` in its own folder makes the "glb" report an oversize byte count.
 */
async function fakeBlender(
  app: string,
  version: string,
  options: { glbBytes?: number; fail?: string } = {},
): Promise<string> {
  const binary = path.join(app, "Contents", "MacOS", "Blender");
  await mkdir(path.dirname(binary), { recursive: true });
  const script = [
    "#!/bin/sh",
    `if [ "$1" = "-b" ] && [ "$2" = "--version" ]; then echo "Blender ${version}"; exit 0; fi`,
    "# argv: -b --factory-startup -noaudio --python-exit-code 1 --python <wrapper> -- <script> <glb> <png> <slug>",
    'while [ "$1" != "--" ]; do shift; done; shift',
    "SCRIPT=$1; GLB=$2; PNG=$3; SLUG=$4",
    options.fail ? `echo 'STUDIO_BLENDER_RESULT {"ok": false, "error": ${JSON.stringify(options.fail)}}'; exit 1` : "",
    'printf "glTF\\002\\000\\000\\000fake-binary-body" > "$GLB"',
    options.glbBytes ? `dd if=/dev/zero bs=${options.glbBytes} count=1 >> "$GLB" 2>/dev/null` : "",
    'printf "\\211PNG\\r\\n\\032\\nfake" > "$PNG"',
    'printf "\\211PNG\\r\\n\\032\\nfake" > "${PNG%.png}-front.png"',
    `echo 'STUDIO_BLENDER_RESULT {"ok": true, "meshes": [{"name": "Body", "polygons": 200, "triangles": 400, "materials": ["Fur"]}, {"name": "Tail", "polygons": 120, "triangles": 240, "materials": ["Fur"]}], "meshCount": 2, "polygons": 320, "triangles": 640, "size": [1.0, 0.5, 1.2], "framedSize": [1.0, 0.5, 1.2], "materials": ["Fur"], "glbBytes": ${options.glbBytes ?? 4096}, "renders": ["$PNG", "\${PNG%.png}-front.png"], "seconds": 0.4}'`,
    "exit 0",
    "",
  ].join("\n");
  await writeFile(binary, script);
  await chmod(binary, 0o755);
  return binary;
}

describe("Blender through the public plugin API", () => {
  it("is independently enabled, persists removal, and exposes no private core Blender RPC", async () => {
    const rig = await startRig();
    rigs.push(rig);
    assert.equal(rig.core.plugins.enabled("blender"), true);
    assert.equal((rig.core.api() as Record<string, unknown>)["blender.status"], undefined);
    await rig.core.plugins.setEnabled("blender", false);
    assert.ok(!rig.core.plugins.tools().some((t) => t.name.startsWith("blender__")));
    await rig.core.plugins.setEnabled("blender", true);
    await rig.core.plugins.remove("blender");
    const state = JSON.parse(
      await readFile(path.join(rig.core.layout.engineHomes, "plugins", "installed.json"), "utf8"),
    );
    assert.equal(state.blender.removed, true);
    assert.equal(state.blender.enabled, false);
    assert.ok(!rig.core.plugins.guidance().includes("[blender/"));
  });

  it("binds tools to the worker, returns images/files, enforces ceilings and keeps failures local", async () => {
    const rig = await startRig();
    rigs.push(rig);
    const source = path.join(await tmpDir("blender-plugin-"), "package");
    await cp(path.join(rig.core.options.paths.resources, "plugins", "blender"), source, { recursive: true });
    const binary = await fakeBlender(path.join(await tmpDir("blender-runtime-"), "Blender.app"), "5.2.1");
    const manifest = JSON.parse(await readFile(path.join(source, "plugin.json"), "utf8"));
    manifest.nativeRuntimes[0].candidates = [binary];
    for (const platform of manifest.nativeRuntimes[0].platforms ?? []) platform.candidates = [binary];
    manifest.nativeJobs[0].gpu = false;
    await writeFile(path.join(source, "plugin.json"), JSON.stringify(manifest));
    // Studio's own blender with a fake runtime: a local folder can no longer take a bundled id.
    await rig.core.plugins.installLocal(source, "bundled", manifest.capabilities);
    const requests: DelegateRequest[] = [];
    let act: ((request: DelegateRequest) => Promise<void>) | undefined;
    rig.core.engines.register({
      id: "fake-delegate",
      label: "Fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        requests.push(request);
        await act?.(request);
        return { ok: true, engine: "fake-delegate", summary: "fixture", turns: 1, usage: {} };
      },
    } as never);
    const project = await rig.core.games.scaffold("modelworld");
    const threadId = await rig.core.createGameThread("modelworld");
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    const delegate = (extra: Record<string, unknown> = {}) =>
      api["engine.delegate"]!({ engine: "fake-delegate", project: "modelworld", threadId, prompt: "build", ...extra });
    await delegate();
    assert.ok(requests.at(-1)!.liveTools?.some((t) => t.name === "blender__model"));
    await delegate({ readOnly: true });
    assert.ok(!requests.at(-1)!.liveTools?.some((t) => t.name === "blender__model"));
    // Flipped (step 1): a Loop chat that may launch a build is a full contractor: it models like
    // the Auto chat.
    await delegate({
      interviewTools: [{ name: "interview", description: "x", parameters: { type: "object", properties: {} } }],
    });
    assert.ok(requests.at(-1)!.liveTools?.some((t) => t.name === "blender__model"));
    await rig.core.plugins.setEnabled("blender", false);
    await delegate();
    assert.ok(!requests.at(-1)!.liveTools?.some((t) => t.name === "blender__model"));
    await rig.core.plugins.setEnabled("blender", true);
    const worktree = path.join(rig.core.layout.scratch, "worktrees", "modelworld-creatures");
    await mkdir(path.join(worktree, "assets", "src"), { recursive: true });
    await writeFile(path.join(worktree, "assets", "src", "dog.py"), "import bpy\n");
    let last: any;
    const invoke = async (request: DelegateRequest, args: Record<string, unknown>) => {
      let value;
      try {
        value = await request.onLiveTool!("blender__model", args);
      } catch (error) {
        return { record: { ok: false, error: String(error) }, images: [] };
      }
      const text = typeof value === "string" ? value : value.text;
      return { record: JSON.parse(text), images: typeof value === "string" ? [] : value.images };
    };
    act = async (request) => {
      assert.equal(path.resolve(request.cwd), path.resolve(worktree));
      for (const args of [
        { name: "Dog!" },
        { name: "missing" },
        { name: "dog", script: "../outside.py" },
        { name: "dog", script: ".env" },
      ]) {
        const value = await invoke(request, args);
        assert.equal(value.record.ok, false, JSON.stringify(args));
      }
      last = await invoke(request, { name: "dog" });
      assert.equal(
        last.record.provider,
        "Local Blender",
        JSON.stringify({
          last,
          native: await rig.core.plugins.action(
            "blender",
            "status",
            {},
            { project: "modelworld", directory: worktree },
          ),
        }),
      );
      assert.equal(last.record.runtimeVersion, "5.2.1");
      assert.equal(last.record.stats.meshCount, 2);
      assert.equal(last.record.stats.triangles, 640);
      assert.equal(last.images.length, 2, "both inspection renders ride the same provider tool contract");
      assert.match(last.record.guidance, /GLTFLoader/);
      assert.ok(last.record.files.some((f: string) => f.endsWith("/model.glb")));
      for (const file of last.record.files) assert.ok((await stat(path.join(worktree, file))).size > 0);
      await assert.rejects(
        stat(path.join(project.dir, last.record.files[0])),
        "delivery goes to the worker, not the live folder",
      );
    };
    await delegate({
      cwd: worktree,
      selfCapture: { project: "modelworld", root: worktree, runId: "run_x", facetId: "creatures", iteration: 2 },
      computer: false,
    });
    const firstId = last.record.jobId;
    await delegate({ cwd: worktree });
    assert.notEqual(last.record.jobId, firstId, "new operations retain independent identities/files");
    const deliveries = customEvents(await rig.core.store.listEvents(threadId), "asset_delivered");
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[0]!.source, "blender");
    assert.equal(deliveries[0]!.runId, "run_x");
    assert.equal(deliveries[0]!.workspace, "build", "a worker delivery waits for its build to land");
    const delivered = (deliveries[0]!.files as Array<{ file: string }>).map((f) => f.file);
    assert.deepEqual(
      await rig.core.presentProjectAssets({ project: "modelworld", files: delivered }),
      [],
      "chat never offers a preview of a file the game folder lacks",
    );
    await mkdir(path.dirname(path.join(project.dir, delivered[0]!)), { recursive: true });
    await writeFile(path.join(project.dir, delivered[0]!), "landed");
    assert.deepEqual(
      await rig.core.presentProjectAssets({
        project: "modelworld",
        files: [delivered[0]!, "../outside.glb", "assets/missing.glb"],
      }),
      [delivered[0]!],
    );
    assert.ok(
      (deliveries[0]!.files as Array<{ bytes: number }>).every((f) => f.bytes > 0),
      "stats use actual worker directory",
    );
    assert.ok(rig.events.some((e) => e.type === "asset.delivered"));

    // Models above the former 4 MiB threshold remain deliverable. The generic native service enforces the aggregate job cap.
    await fakeBlender(path.dirname(path.dirname(path.dirname(binary))), "5.2.1", { glbBytes: 5 * 1024 ** 2 });
    act = async (request) => {
      last = await invoke(request, { name: "dog" });
      assert.equal(last.record.status, "downloaded");
    };
    await delegate({ cwd: worktree });
    assert.equal(
      customEvents(await rig.core.store.listEvents(threadId), "asset_delivered").length,
      3,
      "the 5 MiB model is delivered",
    );
    await fakeBlender(path.dirname(path.dirname(path.dirname(binary))), "5.2.1", {
      fail: "NameError: x is not defined — ECONNREFUSED fetch failed",
    });
    act = async (request) => {
      last = await invoke(request, { name: "dog" });
      assert.equal(last.record.ok, false);
      assert.match(last.record.error, /Blender job/);
    };
    await delegate({ cwd: worktree });
    assert.equal(customEvents(await rig.core.store.listEvents(threadId), "asset_delivered").length, 3);

    await fakeBlender(path.dirname(path.dirname(path.dirname(binary))), "5.2.1");
    await writeFile(
      path.join(worktree, "studio.json"),
      JSON.stringify({ entry: "dist/index.html", main: "src/main.ts", build: "npm run build" }),
    );
    act = async (request) => {
      last = await invoke(request, { name: "dog" });
      assert.ok(last.record.files.every((f: string) => f.startsWith("public/assets/blender/")));
    };
    await delegate({ cwd: worktree });
  });
});
