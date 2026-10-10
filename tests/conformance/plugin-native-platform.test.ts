import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { mkdir, writeFile, readFile, symlink, copyFile } from "node:fs/promises";
import { nativeRuntimeForPlatform, type PluginNativeRuntime } from "../../src/shared/plugins.ts";
import { PluginNativeServices } from "../../src/substrate/plugins/native.ts";
import { runtimeCandidates } from "../../src/substrate/plugins/native-platform.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { tmpDir } from "../helpers/tmp.ts";

const legacy: PluginNativeRuntime = {
  id: "blender",
  label: "Blender",
  candidates: ["/Applications/Blender.app/Contents/MacOS/Blender"],
  version: { args: ["--version"], pattern: "Blender (\\d+\\.\\d+\\.\\d+)", minimum: "4.2.0" },
};

test("platform selection preserves legacy declarations and never falls back across architectures", () => {
  assert.deepEqual(nativeRuntimeForPlatform(legacy, "darwin", "arm64"), legacy);
  const runtime = {
    ...legacy,
    platforms: [{ platform: "win32", arch: "x64", candidates: ["storage:blender.exe"] }],
  } as PluginNativeRuntime;
  assert.deepEqual(nativeRuntimeForPlatform(runtime, "win32", "x64")?.candidates, ["storage:blender.exe"]);
  assert.equal(nativeRuntimeForPlatform(runtime, "win32", "arm64"), undefined);
  assert.equal(nativeRuntimeForPlatform(runtime, "linux", "x64"), undefined);
});

test("declared Windows version folders are discovered newest first without traversing links or unrelated folders", async () => {
  const root = await tmpDir("native-platform-");
  const foundation = path.join(root, "Blender Foundation");
  for (const name of ["Blender 4.2", "Blender 5.2", "Something else"]) {
    await mkdir(path.join(foundation, name), { recursive: true });
    await writeFile(path.join(foundation, name, "blender.exe"), "fixture");
  }
  const outside = path.join(root, "other-runtime");
  await mkdir(outside);
  await writeFile(path.join(outside, "blender.exe"), "outside fixture");
  await symlink(outside, path.join(foundation, "Blender 99.0"), "junction");
  const found = await runtimeCandidates(["program-files:Blender Foundation/Blender */blender.exe"], {
    home: root,
    studio: root,
    storage: root,
    programFiles: root,
  });
  assert.deepEqual(found, [
    path.join(foundation, "Blender 5.2", "blender.exe"),
    path.join(foundation, "Blender 4.2", "blender.exe"),
  ]);
  assert.deepEqual(
    await runtimeCandidates(["program-files:Blender Foundation/Blender */blender.exe"], {
      home: root,
      studio: root,
      storage: root,
    }),
    [],
  );
});

test("native manifests validate every platform and pinned archive even on a different host", () => {
  const manifest = {
    apiVersion: 3,
    id: "example",
    version: "1.0.0",
    name: "Example",
    publisher: "Test",
    description: "Test",
    backend: "backend.mjs",
    capabilities: ["native-runtime"],
    tools: [],
    skills: [],
    panels: [],
    settings: [],
    actions: [{ name: "install", label: "Install", confirmation: "Download runtime" }],
    nativeRuntimes: [
      {
        ...legacy,
        platforms: [{ platform: "win32", arch: "x64", candidates: ["C:/Program Files/Blender/blender.exe"] }],
      },
    ],
    nativeJobs: [],
  };
  assert.equal(validateManifest(manifest).nativeRuntimes?.[0]?.platforms?.[0]?.platform, "win32");
  for (const candidate of [
    "program-files:../outside/blender.exe",
    "program-files:.. /outside/blender.exe",
    "C:/Windows/../bad.exe",
    "program-files:Blender */*/blender.exe",
    "program-files:Blender/*",
  ]) {
    const bad = structuredClone(manifest);
    bad.nativeRuntimes[0].platforms[0].candidates = [candidate];
    assert.throws(() => validateManifest(bad), /path|candidate/i, candidate);
  }
  const duplicate = structuredClone(manifest);
  duplicate.nativeRuntimes[0].platforms.push(duplicate.nativeRuntimes[0].platforms[0]);
  assert.throws(() => validateManifest(duplicate), /platform/i);
});

test("actual host detection probes the selected executable and exposes only that host's install", async () => {
  const root = await tmpDir("native-platform-detect-");
  const manifest = JSON.parse(
    await readFile(new URL("../../src/plugins/blender/plugin.json", import.meta.url), "utf8"),
  );
  const runtime = validateManifest(manifest).nativeRuntimes?.[0];
  assert.ok(runtime);
  const selected = nativeRuntimeForPlatform(runtime, process.platform, process.arch);
  const service = new PluginNativeServices(root, []);
  const probe = await service.detect(
    {
      ...legacy,
      candidates: [process.execPath],
      version: { args: ["--version"], pattern: "v(\\d+\\.\\d+\\.\\d+)", minimum: "24.0.0" },
    },
    root,
  );
  assert.equal(probe.state, "ready");
  assert.equal(probe.version, process.versions.node);
  const status = await service.detect(runtime, root);
  assert.deepEqual(status.install, selected?.install);
  if (process.platform === "win32") assert.equal(status.install?.format, "zip");
  if (!selected) assert.equal(status.state, "incompatible");
});

test("Windows discovery prefers its managed private runtime over external candidates", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await tmpDir("native-platform-private-");
  const managed = path.join(root, "runtimes", "node", "tool.exe");
  await mkdir(path.dirname(managed), { recursive: true });
  await copyFile(process.execPath, managed);
  const runtime: PluginNativeRuntime = {
    id: "node",
    label: "Node",
    candidates: [process.execPath],
    version: { args: ["--version"], pattern: "v(\\d+\\.\\d+\\.\\d+)", minimum: "24.0.0" },
    install: {
      action: "install",
      url: "https://example.invalid/runtime.zip",
      sha256: "0".repeat(64),
      bytes: 1,
      unpackedBytes: 1,
      format: "zip",
      entry: "tool.exe",
      executable: "tool.exe",
      notices: [],
    },
  };
  const status = await new PluginNativeServices(root, []).detect(runtime, root);
  assert.equal(status.state, "ready");
  assert.equal(status.path, managed);
});
