import assert from "node:assert/strict";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  type PluginManifest,
  type PluginNativeRuntime,
  type PluginRuntimePin,
  runtimePinFor,
} from "../../src/shared/plugins.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { PluginNativeServices } from "../../src/substrate/plugins/native.ts";

const PIN: PluginRuntimePin = {
  action: "install",
  url: "https://example.invalid/runtime.zip",
  sha256: "0".repeat(64),
  bytes: 1,
  unpackedBytes: Number.MAX_SAFE_INTEGER,
  format: "zip",
  entry: "tool",
  executable: "tool/tool.exe",
  notices: ["LICENSE"],
};

/** A plugin with one runtime, a confirmed install action and a string setting naming a program. */
function manifest(runtime: Partial<PluginNativeRuntime> = {}): PluginManifest {
  return {
    apiVersion: 3,
    id: "native-example",
    version: "1.0.0",
    name: "Native example",
    publisher: "Test",
    description: "A runtime pinned per computer",
    backend: "backend.mjs",
    capabilities: ["native-runtime", "settings"],
    tools: [],
    skills: [],
    panels: [],
    settings: [
      { key: "program", label: "Program", type: "string", default: "" },
      { key: "fast", label: "Fast", type: "boolean", default: false },
    ],
    actions: [{ name: "install", label: "Install", confirmation: "Download the pinned runtime" }],
    nativeRuntimes: [
      {
        id: "tool",
        label: "Tool",
        candidates: ["setting:program"],
        version: { args: ["--version"], pattern: "(\\d+\\.\\d+\\.\\d+)", minimum: "1.0.0" },
        ...runtime,
      },
    ],
    nativeJobs: [],
  };
}

describe("A native runtime's candidates in its manifest", () => {
  const ACCEPTED = [
    "/Applications/Tool.app/Contents/MacOS/Tool",
    "programfiles:Tool Foundation/Tool */tool.exe",
    "programfilesx86:Steam/steamapps/common/Tool/tool.exe",
    "localappdata:Programs/Tool/tool.exe",
    "opens:.tool/tool.exe",
    "package:ToolFoundation.Tool/Tool/tool.exe",
    "setting:program",
  ];
  for (const candidate of ACCEPTED)
    it(`accepts ${candidate}`, () => {
      assert.deepEqual(validateManifest(manifest({ candidates: [candidate] })).nativeRuntimes?.[0]?.candidates, [
        candidate,
      ]);
    });

  const REFUSED: Array<[string, RegExp]> = [
    ["programfiles:../Windows/System32/cmd.exe", /path/i],
    ["programfiles:C:/Windows/cmd.exe", /path/i],
    ["programfiles:..\\Windows\\System32\\cmd.exe", /Runtime candidates must use/],
    ["home:x\\..\\..\\Windows/cmd.exe", /Runtime candidates must use/],
    ["localappdata:Tool/../../x.exe", /path/i],
    ["opens:blend/tool.exe", /Runtime candidates must use/],
    ["opens:.blend", /Runtime candidates must use/],
    ["opens:.blend/../../x.exe", /path/i],
    ["package:../x/tool.exe", /Runtime candidates must use/],
    ["package:Tool", /Runtime candidates must use/],
    ["programfiles:A */B */tool.exe", /one \* pattern/],
    ["programfiles:A ** B/tool.exe", /one \* pattern/],
    ["setting:fast", /string setting/],
    ["setting:missing", /string setting/],
    ["setting:../program", /Runtime candidates must use/],
    ["registry:HKLM/Software/Tool", /Runtime candidates must use/],
  ];
  for (const [candidate, error] of REFUSED)
    it(`refuses ${candidate}`, () => {
      assert.throws(() => validateManifest(manifest({ candidates: [candidate] })), error);
    });
});

describe("A native runtime's pinned downloads", () => {
  it("pins one download per computer; a pin with no platform is Apple Silicon's", () => {
    const mac = { ...PIN, format: "dmg" as const };
    const x64 = { ...PIN, platform: "win32-x64" as const };
    const arm = { ...PIN, platform: "win32-arm64" as const };
    const runtime = validateManifest(manifest({ install: mac, installs: [x64, arm] })).nativeRuntimes?.[0];
    assert.ok(runtime);
    assert.equal(runtimePinFor(runtime, "darwin-arm64"), runtime.install);
    assert.equal(runtimePinFor(runtime, "win32-x64")?.platform, "win32-x64");
    assert.equal(runtimePinFor(runtime, "win32-arm64")?.platform, "win32-arm64");
    assert.equal(runtimePinFor(runtime, "darwin-x64"), undefined, "an Intel Mac has none");
    assert.equal(runtimePinFor(runtime, "linux-x64"), undefined);
  });

  const REFUSED: Array<[string, Partial<PluginNativeRuntime>, RegExp]> = [
    [
      "two pins for one computer",
      {
        installs: [
          { ...PIN, platform: "win32-x64" },
          { ...PIN, platform: "win32-x64" },
        ],
      },
      /platform of its own/,
    ],
    [
      "a platform-less pin beside an Apple Silicon one",
      { install: PIN, installs: [{ ...PIN, platform: "darwin-arm64" }] },
      /platform of its own/,
    ],
    ["a computer Genex doesn't know", { installs: [{ ...PIN, platform: "linux-x64" as never }] }, /Invalid pinned/],
    [
      "an archive Genex doesn't unpack",
      { installs: [{ ...PIN, format: "7z" as never, platform: "win32-x64" }] },
      /Invalid pinned/,
    ],
    [
      "a plain http download",
      { installs: [{ ...PIN, url: "http://example.invalid/t.zip", platform: "win32-x64" }] },
      /Invalid pinned/,
    ],
    ["more than four pins", { installs: Array.from({ length: 5 }, () => ({ ...PIN })) }, /Invalid pinned/],
    ["installs that aren't a list", { installs: PIN as never }, /Invalid pinned/],
    [
      "an executable outside the archive",
      { installs: [{ ...PIN, executable: "../tool.exe", platform: "win32-x64" }] },
      /path/i,
    ],
    [
      "an executable a Windows path leads out of the archive",
      { installs: [{ ...PIN, executable: "tool\\..\\..\\x.exe", platform: "win32-x64" }] },
      /Invalid pinned/,
    ],
  ];
  for (const [label, runtime, error] of REFUSED)
    it(`refuses ${label}`, () => {
      assert.throws(() => validateManifest(manifest(runtime)), error);
    });

  it("Local Blender pins Blender for Apple Silicon and for Windows x64 and arm64", async () => {
    const blender = validateManifest(
      JSON.parse(await readFile(new URL("../../src/plugins/blender/plugin.json", import.meta.url), "utf8")),
    ).nativeRuntimes?.[0];
    assert.ok(blender);
    for (const platform of ["darwin-arm64", "win32-x64", "win32-arm64"])
      assert.ok(runtimePinFor(blender, platform), platform);
    assert.match(runtimePinFor(blender, "win32-x64")?.executable ?? "", /windows-x64\/blender\.exe$/);
  });
});

describe("Installing a native runtime on this computer", () => {
  async function service(platform: string) {
    const root = await mkdtemp(path.join(os.tmpdir(), "native-pins-"));
    const m = manifest({ installs: [{ ...PIN, platform: "win32-x64" }] });
    m.tools.push({
      name: "install",
      description: "Download the runtime",
      parameters: { type: "object", properties: {} },
      confirmation: "Download the runtime",
    });
    const native = new PluginNativeServices(root, [], { platform, settings: async () => ({}) });
    const binding = { project: "game", directory: root };
    const call = (method: string, source = "tool") =>
      native.call(
        m,
        root,
        root,
        method,
        { runtime: "tool" },
        binding,
        {
          method: source,
          name: "install",
          signal: new AbortController().signal,
        },
        () => {},
      );
    return { call, close: () => rm(root, { recursive: true, force: true }) };
  }

  it("answers the download pinned for this computer, and none where none is pinned", async () => {
    const pc = await service("win32-x64");
    const mac = await service("darwin-arm64");
    try {
      const here = (await pc.call("runtime.detect")) as { download?: unknown; state: string };
      assert.equal(here.state, "missing");
      assert.deepEqual(here.download, { action: "install", url: PIN.url, bytes: PIN.bytes });
      const there = (await mac.call("runtime.detect")) as { download?: unknown };
      assert.equal(there.download, undefined);
    } finally {
      await pc.close();
      await mac.close();
    }
  });

  it("refuses to install on a computer with no pinned download, before any download starts", async () => {
    const mac = await service("darwin-arm64");
    try {
      await assert.rejects(mac.call("runtime.install"), /no download of Tool for this computer/);
      assert.equal(await mac.call("runtime.installation"), null, "nothing was started");
    } finally {
      await mac.close();
    }
  });

  it("starts the download pinned for this computer once the person confirmed it", async () => {
    const pc = await service("win32-x64");
    try {
      assert.deepEqual(await pc.call("runtime.install"), { started: true });
      // The person's own action joins it; the pin is larger than any disk, so both end at the space check.
      await assert.rejects(pc.call("runtime.install", "action"));
      const job = (await pc.call("runtime.installation")) as { active: boolean; phase: string };
      assert.equal(job.active, false);
      assert.equal(job.phase, "failed");
    } finally {
      await pc.close();
    }
  });
});
