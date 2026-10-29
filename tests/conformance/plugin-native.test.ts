import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { PluginNativeServices } from "../../src/substrate/plugins/native.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import type { PluginManifest, PluginNativeResult } from "../../src/shared/plugins.ts";

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-plugin-")),
    game = path.join(root, "game"),
    pkg = path.join(root, "package"),
    storage = path.join(root, "storage");
  for (const dir of [game, pkg, storage]) await mkdir(dir);
  const manifest: PluginManifest = {
    apiVersion: 3,
    id: "native-example",
    version: "1.0.0",
    name: "Native example",
    publisher: "Test",
    description: "Real local shell process for public SDK boundaries",
    backend: "backend.mjs",
    capabilities: ["native-runtime"],
    tools: [],
    skills: [],
    panels: [],
    settings: [],
    actions: [{ name: "install", label: "Install", confirmation: "Download pinned runtime" }],
    nativeRuntimes: [
      {
        id: "shell",
        label: "Shell",
        candidates: ["/bin/bash"],
        version: { args: ["--version"], pattern: "version (\\d+\\.\\d+\\.\\d+)", minimum: "3.0.0" },
      },
    ],
    nativeJobs: [
      {
        id: "write",
        runtime: "shell",
        args: [
          { source: "input", name: "script" },
          { source: "output", name: "result.txt" },
        ],
        inputs: ["script"],
        values: {},
        outputs: ["result.txt"],
        timeoutMs: 2000,
        maxOutputBytes: 1000,
        maxAssetBytes: 4096,
      },
    ],
  };
  // The pins below carry no platform, so they are Apple Silicon's: this computer reads as one.
  const service = new PluginNativeServices(root, [], { platform: "darwin-arm64" }),
    binding = { project: "game", directory: game };
  const call = (method: string, args: any, signal = new AbortController().signal, source = "tool") =>
    service.call(manifest, pkg, storage, method, args, binding, { method: source, name: "install", signal }, () => {});
  return { root, game, pkg, storage, manifest, service, call, close: () => rm(root, { recursive: true, force: true }) };
}

test("native manifests require declared recipes, safe aliases, a pinned digest and user install action", async () => {
  const f = await setup();
  try {
    assert.equal(validateManifest(f.manifest).apiVersion, 3);
    const variant = () => structuredClone(f.manifest);
    let m = variant();
    m.nativeRuntimes![0]!.candidates = ["storage:../outside"];
    assert.throws(() => validateManifest(m), /path/);
    m = variant();
    m.nativeJobs![0]!.args.push({ source: "value", name: "executable" });
    assert.throws(() => validateManifest(m), /Undeclared/);
    m = variant();
    m.nativeJobs![0]!.outputs = ["a\0b"];
    assert.throws(() => validateManifest(m), /Invalid native job recipe/);
    // Reproduced by an independent agent using the SDK: asset bytes were supplied as a log cap.
    m = variant();
    m.nativeJobs![0]!.maxOutputBytes = 8 * 1024 ** 2;
    assert.throws(() => validateManifest(m), /maxOutputBytes.*process log.*256000.*maxAssetBytes/);
    m = variant();
    m.nativeJobs![0]!.maxAssetBytes = 101 * 1024 ** 2;
    assert.throws(() => validateManifest(m), /maxAssetBytes.*104857600/);
    m = variant();
    m.nativeRuntimes![0]!.install = {
      action: "no-consent",
      url: "https://example.invalid/runtime.tgz",
      sha256: "0".repeat(64),
      bytes: 1,
      unpackedBytes: 1,
      format: "tar.gz",
      entry: "bin",
      executable: "bin/tool",
      notices: ["LICENSE"],
    };
    assert.throws(() => validateManifest(m), /trusted/);
  } finally {
    await f.close();
  }
});

test("runtime discovery supports spaced symlinks and accurately reports missing and incompatible versions", {
  skip: process.platform === "win32" && "native runtimes (Blender, Bonsai) stay macOS and Linux only",
}, async () => {
  const f = await setup();
  try {
    const link = path.join(f.root, "External runtime");
    await symlink("/bin/bash", link);
    const spec = f.manifest.nativeRuntimes![0]!;
    const ready = await f.service.detect({ ...spec, candidates: [link] }, f.storage);
    assert.equal(ready.state, "ready");
    // The version this machine's bash reports (3.2 on macOS, 5.x on Linux), not one machine's.
    const bashVersion = execFileSync("/bin/bash", ["--version"], { encoding: "utf8" }).match(
      /version (\d+\.\d+\.\d+)/,
    )?.[1];
    assert.equal(ready.version, bashVersion);
    assert.equal(
      (await f.service.detect({ ...spec, candidates: [path.join(f.root, "missing")] }, f.storage)).state,
      "missing",
    );
    assert.equal(
      (await f.service.detect({ ...spec, version: { ...spec.version, minimum: "900.0.0" } }, f.storage)).state,
      "incompatible",
    );
    // A runtime that names a first release x.y (Godot's 4.3) reads as x.y.0 against the minimum.
    const twoParts = { ...spec.version, pattern: "version (\\d+\\.\\d+)" };
    const short = await f.service.detect({ ...spec, version: twoParts }, f.storage);
    assert.equal(short.state, "ready");
    assert.match(String(short.version), /^\d+\.\d+$/);
    const [major = 0, minor = 0] = String(short.version).split(".").map(Number);
    const above = `${major}.${minor + 1}.0`;
    assert.equal(
      (await f.service.detect({ ...spec, version: { ...twoParts, minimum: above } }, f.storage)).state,
      "incompatible",
    );
  } finally {
    await f.close();
  }
});

test("actual managed job stages only its input and delivers only declared outputs; restart never replays", {
  skip: process.platform !== "darwin",
}, async () => {
  const f = await setup();
  try {
    await writeFile(path.join(f.game, ".env"), "synthetic-secret");
    await writeFile(
      path.join(f.game, "script.sh"),
      `if /bin/cat '${f.game}/.env'; then exit 20; fi\nprintf 'asset' > "$1"\nprintf 'private' > "$(/usr/bin/dirname "$1")/undeclared.txt"`,
    );
    const result = (await f.call("native.run", {
      job: "write",
      inputs: { script: "script.sh" },
      values: {},
    })) as PluginNativeResult;
    assert.equal(result.state, "completed", result.stderr || result.reason);
    assert.equal(await readFile(path.join(result.output, "result.txt"), "utf8"), "asset");
    assert.deepEqual(result.files, ["result.txt"]);
    await assert.rejects(readFile(path.join(result.output, "undeclared.txt")), /ENOENT/);
    assert.ok(!result.stdout?.includes("synthetic-secret"));
    assert.deepEqual(await f.call("native.result", { id: result.id }), result);
    const saved = path.join(f.storage, "native-jobs", result.id, "job.json");
    await writeFile(saved, JSON.stringify({ ...result, state: "running" }));
    const reopened = new PluginNativeServices(f.root, []);
    const recovered = (await reopened.call(
      f.manifest,
      f.pkg,
      f.storage,
      "native.result",
      { id: result.id },
      { project: "game", directory: f.game },
      { method: "tool", name: "retrieve", signal: new AbortController().signal },
      () => {},
    )) as PluginNativeResult;
    assert.equal(recovered.state, "interrupted");
    assert.match(recovered.reason!, /not replayed/);
  } finally {
    await f.close();
  }
});

test("native jobs enforce output limits and cancel active local processes", {
  skip: process.platform !== "darwin",
}, async () => {
  const f = await setup();
  try {
    await writeFile(path.join(f.game, "large.sh"), '/usr/bin/yes x | /usr/bin/head -c 5000 > "$1"');
    const large = (await f.call("native.run", {
      job: "write",
      inputs: { script: "large.sh" },
      values: {},
    })) as PluginNativeResult;
    assert.equal(large.state, "failed");
    assert.match(large.reason!, /size limit/);
    await writeFile(path.join(f.game, "wait.sh"), "/bin/sleep 30");
    const stop = new AbortController();
    const pending = f.call("native.run", { job: "write", inputs: { script: "wait.sh" }, values: {} }, stop.signal);
    const timer = setTimeout(() => stop.abort(), 100);
    const result = (await pending) as PluginNativeResult;
    clearTimeout(timer);
    assert.equal(result.state, "cancelled");
    assert.equal(result.reason, "cancelled");
  } finally {
    await f.close();
  }
});

test("install and cancellation cannot be agent-authorized; failed preflight is durable", async () => {
  const f = await setup();
  try {
    f.manifest.nativeRuntimes![0]!.install = {
      action: "install",
      url: "https://example.invalid/runtime.tgz",
      sha256: "0".repeat(64),
      bytes: 1,
      unpackedBytes: 1,
      format: "tar.gz",
      entry: "bin",
      executable: "bin/tool",
      notices: ["LICENSE"],
    };
    await assert.rejects(f.call("runtime.install", { runtime: "shell" }), /trusted setup/);
    await assert.rejects(f.call("runtime.cancelInstall", { runtime: "shell" }), /Only a user/);
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(f.call("runtime.install", { runtime: "shell" }, stop.signal, "action"));
    const job = (await f.call("runtime.installation", { runtime: "shell" })) as any;
    assert.equal(job.active, false);
    assert.ok(["cancelled", "failed"].includes(job.phase));
  } finally {
    await f.close();
  }
});

test("an agent's install tool the person confirms starts the pinned download and answers at once", async () => {
  const f = await setup();
  try {
    // More than any disk holds, so the download stops at its space check, before any network.
    f.manifest.nativeRuntimes![0]!.install = {
      action: "install",
      url: "https://example.invalid/runtime.tgz",
      sha256: "0".repeat(64),
      bytes: 1,
      unpackedBytes: Number.MAX_SAFE_INTEGER,
      format: "tar.gz",
      entry: "bin",
      executable: "bin/tool",
      notices: ["LICENSE"],
    };
    await assert.rejects(f.call("runtime.install", { runtime: "shell" }), /trusted setup/, "no install tool: refused");
    f.manifest.tools.push({
      name: "install",
      description: "Download the pinned runtime",
      parameters: { type: "object", properties: {} },
    });
    await assert.rejects(f.call("runtime.install", { runtime: "shell" }), /trusted setup/, "no card: refused");
    f.manifest.tools[0]!.confirmation = "Download the pinned runtime";
    assert.equal(validateManifest(f.manifest).apiVersion, 3);
    assert.deepEqual(await f.call("runtime.install", { runtime: "shell" }), { started: true });
    // The person's own action joins the download under way, or starts it again: either ends the same.
    await assert.rejects(f.call("runtime.install", { runtime: "shell" }, new AbortController().signal, "action"));
    const job = (await f.call("runtime.installation", { runtime: "shell" })) as any;
    assert.equal(job.active, false);
    assert.equal(job.phase, "failed");
  } finally {
    await f.close();
  }
});

test("asset size limits include prior worker deliveries after host restart", async () => {
  const { PluginServices } = await import("../../src/substrate/plugins/services.ts");
  const f = await setup();
  try {
    const second = path.join(f.root, "worker-two");
    await mkdir(second);
    const source = path.join(f.storage, "output");
    await mkdir(source);
    await writeFile(path.join(source, "asset.txt"), "12345");
    const create = () => {
      const service = new PluginServices(f.root, { "native-example": f.storage }, async () => null);
      service.assetLimits = () => ({ fileBytes: 8, projectBytes: 8 });
      return service;
    };
    const args = { output: source, jobId: "11111111-1111-4111-8111-111111111111" };
    const first = await create().call("native-example", "assets.deliver", args, { project: "game", directory: f.game });
    assert.deepEqual(
      await create().call("native-example", "assets.deliver", args, { project: "game", directory: f.game }),
      first,
      "same completed job reuses identical files after restart without double-counting quota",
    );
    await assert.rejects(
      create().call(
        "native-example",
        "assets.deliver",
        { ...args, jobId: "22222222-2222-4222-8222-222222222222" },
        { project: "game", directory: second },
      ),
      /across this project's workspaces/,
    );
    await rm(path.join(f.game, "assets"), { recursive: true });
    assert.equal(
      (
        (await create().call("native-example", "assets.deliver", args, {
          project: "game",
          directory: second,
        })) as string[]
      ).length,
      1,
      "deleted files release capacity",
    );
  } finally {
    await f.close();
  }
});

test("SDK retrieval preserves changed game assets, restores missing files and rejects symlinks", async () => {
  const { PluginServices } = await import("../../src/substrate/plugins/services.ts");
  const f = await setup();
  try {
    const source = path.join(f.storage, "output");
    await mkdir(path.join(source, "nested"), { recursive: true });
    await writeFile(path.join(source, "asset.txt"), "original");
    await writeFile(path.join(source, "nested", "image.png"), "image");
    const service = new PluginServices(f.root, { "native-example": f.storage }, async () => null);
    const args = { output: source, jobId: "11111111-1111-4111-8111-111111111111" },
      binding = { project: "game", directory: f.game };
    const first = (await service.call("native-example", "assets.deliver", args, binding)) as string[];
    const destination = path.join(f.game, "assets/native-example", args.jobId),
      asset = path.join(destination, "asset.txt");
    await rm(path.join(destination, "nested", "image.png"));
    assert.deepEqual(await service.call("native-example", "assets.deliver", args, binding), first);
    assert.equal(await readFile(path.join(destination, "nested", "image.png"), "utf8"), "image");
    await writeFile(asset, "user changed this");
    await assert.rejects(service.call("native-example", "assets.deliver", args, binding), /differs.*not overwrite/);
    assert.equal(await readFile(asset, "utf8"), "user changed this");
    await rm(asset);
    await symlink(path.join(source, "asset.txt"), asset);
    await assert.rejects(service.call("native-example", "assets.deliver", args, binding), /symlink/);
  } finally {
    await f.close();
  }
});
