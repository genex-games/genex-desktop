import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { realpath } from "node:fs/promises";
import { NativePlatform, NativeRuntimeState, runtimeCandidatesFor } from "../../src/shared/plugins.ts";
import { PluginNativeServices } from "../../src/substrate/plugins/native.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A Local Models-style Python runtime, with separate candidates for each operating system. */
function manifest() {
  return {
    apiVersion: 3,
    id: "platform-models",
    version: "1.0.0",
    name: "Platform models",
    publisher: "Test",
    description: "Native platform discovery fixture",
    backend: "backend.mjs",
    capabilities: ["native-runtime"],
    tools: [],
    skills: [],
    panels: [],
    settings: [{ key: "program", label: "Runtime program", type: "string", default: "" }],
    actions: [],
    nativeJobs: [],
    nativeRuntimes: [
      {
        id: "python",
        label: "Local Models Python",
        candidates: ["home:Genex-Local-Models/hunyuan/python.exe"],
        version: { args: ["--version"], pattern: "Python (\\d+\\.\\d+\\.\\d+)", minimum: "3.11.0" },
        platforms: [
          {
            platform: "win32-x64",
            candidates: ["storage:runtimes/hunyuan/python.exe", "setting:program"],
          },
        ],
      },
    ],
  };
}

describe("platform-specific native runtime candidates", () => {
  it("retains the declared Windows candidates after manifest validation", () => {
    const raw = manifest();
    const parsed = validateManifest(raw);
    assert.deepEqual(parsed.nativeRuntimes?.[0]?.platforms, raw.nativeRuntimes[0]?.platforms);
  });

  it("chooses only the matching target and keeps the fallback for hosts without a declaration", () => {
    const raw = manifest();
    raw.nativeRuntimes[0].platforms.push({
      platform: "darwin-arm64",
      candidates: ["home:Genex-Local-Models/qwen.app/Contents/bin/python3.11"],
    });
    const runtime = validateManifest(raw).nativeRuntimes?.[0];
    assert.ok(runtime);
    assert.deepEqual(
      runtimeCandidatesFor(runtime, NativePlatform.WindowsX64),
      raw.nativeRuntimes[0].platforms[0].candidates,
    );
    assert.deepEqual(
      runtimeCandidatesFor(runtime, NativePlatform.MacArm64),
      raw.nativeRuntimes[0].platforms[1].candidates,
    );
    assert.deepEqual(runtimeCandidatesFor(runtime, NativePlatform.WindowsArm64), raw.nativeRuntimes[0].candidates);
    assert.deepEqual(runtimeCandidatesFor({ candidates: ["storage:old-runtime"] }, NativePlatform.WindowsX64), [
      "storage:old-runtime",
    ]);
  });

  it("clones the platform lists instead of retaining mutable manifest input", () => {
    const raw = manifest();
    const parsed = validateManifest(raw);
    raw.nativeRuntimes[0].platforms[0].candidates.push("storage:changed.exe");
    assert.equal(parsed.nativeRuntimes?.[0]?.platforms?.[0]?.candidates.length, 2);
  });

  const malformed = [
    null,
    {},
    "win32",
    [null],
    [{ platform: "linux-x64", candidates: ["storage:python"] }],
    [{ platform: "darwin-x64", candidates: ["storage:python"] }],
    [{ platform: "win32-other", candidates: ["storage:python"] }],
    [{ platform: "win32-x64", candidates: [] }],
    [{ platform: "win32-x64", candidates: [7] }],
    [{ platform: ["win32-x64"], candidates: ["storage:python"] }],
    [{ platform: "win32", arch: "x64", candidates: ["storage:python"] }],
    [{ platform: "win32-x64", candidates: Array(17).fill("storage:python") }],
    Array(5).fill({ platform: "win32-x64", candidates: ["storage:python"] }),
    Array(2).fill({ platform: "win32-x64", candidates: ["storage:python"] }),
  ];
  for (const [index, platforms] of malformed.entries())
    it(`refuses malformed or duplicate platform candidates (${index})`, () => {
      const raw = manifest();
      assert.throws(() => validateManifest({ ...raw, nativeRuntimes: [{ ...raw.nativeRuntimes[0], platforms }] }));
    });

  for (const candidate of [
    "D:python.exe",
    "D:/../python.exe",
    "D:/models/./python.exe",
    "D:/models//python.exe",
    "D:/models/python.exe:stream",
    "\\\\server\\share\\python.exe",
    "\\\\?\\D:\\python.exe",
    "D:/models/py\u0000thon.exe",
    "storage:../python.exe",
    "setting:undeclared",
  ])
    it(`refuses an unsafe Windows platform path: ${JSON.stringify(candidate)}`, () => {
      const raw = manifest();
      raw.nativeRuntimes[0].platforms[0].candidates = [candidate];
      assert.throws(() => validateManifest(raw));
    });

  it("keeps Windows drive paths out of top-level and platform candidate declarations", () => {
    const raw = manifest();
    raw.nativeRuntimes[0].candidates = ["D:/python.exe"];
    assert.throws(() => validateManifest(raw));
    raw.nativeRuntimes[0].candidates = ["storage:python"];
    raw.nativeRuntimes[0].platforms[0].platform = "darwin-arm64";
    raw.nativeRuntimes[0].platforms[0].candidates = ["D:/python.exe"];
    assert.throws(() => validateManifest(raw));
  });

  it("discovers a runtime through the matching target's setting without requiring the fallback binary", async () => {
    const root = await tmpDir("native-platform-");
    const raw = manifest();
    raw.nativeRuntimes[0].candidates = ["storage:missing-fallback"];
    raw.nativeRuntimes[0].platforms[0].candidates = ["setting:program"];
    raw.nativeRuntimes[0].version = { args: ["--version"], pattern: "v(\\d+\\.\\d+\\.\\d+)", minimum: "24.0.0" };
    const runtime = validateManifest(raw).nativeRuntimes?.[0];
    assert.ok(runtime);
    const service = new PluginNativeServices(root, [], { platform: NativePlatform.WindowsX64 });
    const result = await service.detect(runtime, root, { settings: { program: process.execPath } });
    assert.equal(result.state, NativeRuntimeState.Ready);
    assert.equal(result.path, await realpath(process.execPath));
  });

  it("does not probe fallback or another target when a matching declaration exists but is missing", async () => {
    const root = await tmpDir("native-platform-missing-");
    const raw = manifest();
    raw.nativeRuntimes[0].candidates = ["setting:program"];
    raw.nativeRuntimes[0].platforms[0].candidates = ["storage:missing"];
    raw.nativeRuntimes[0].platforms.push({ platform: "darwin-arm64", candidates: ["setting:program"] });
    const runtime = validateManifest(raw).nativeRuntimes?.[0];
    assert.ok(runtime);
    const service = new PluginNativeServices(root, [], { platform: NativePlatform.WindowsX64 });
    const result = await service.detect(runtime, root, { settings: { program: process.execPath } });
    assert.equal(result.state, NativeRuntimeState.Missing);
  });
});
