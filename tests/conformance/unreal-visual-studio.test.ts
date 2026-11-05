/**
 * Microsoft's C++ tools for Unreal on Windows, as Genex judges them: the compilers and Windows SDK
 * an engine's own Windows_SDK.json accepts, what vswhere lists and the folders hold, and the plan
 * Do it for me runs for each state. vswhere is a recording fake; the folders are a temporary
 * stand-in for Program Files (x86).
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  BuildToolsPlan,
  engineMsvcRules,
  type MsvcRules,
  parseInstances,
  parseWindowsSdk,
  sdkAccepted,
  systemVisualStudioProbes,
  toolsetAccepted,
  type VisualStudioFacts,
  type VisualStudioRunner,
  VisualStudioState,
  visualStudioChecker,
  visualStudioStatus,
} from "../../src/plugins/unreal/visual-studio.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** Unreal 5.8's Windows_SDK.json, its comment keys and the fields Genex doesn't read left in. */
const UE58_WINDOWS_SDK = `{
\t"MainVersion": "10.0.22621.0",
\t"MinVersion": "10.0.19041.0",
\t"MaxVersion": "10.9.99999.0",
\t"//02.1": "Version number is the MSVC family, which is the version in the Visual Studio folder",
\t"PreferredVisualCppVersions": ["14.50.35717-14.50.99999", "14.44.35207-14.44.99999"],
\t"BannedVisualCppVersions": ["14.50.0-14.50.35722", "14.44.0-14.44.35210", "14.40.0-14.43.99999", "14.39.0-14.39.99999"],
\t"MinimumVisualCppVersion": "14.38.33130",
\t"MinimumVisualStudio2022Version": "17.8"
}
`;
const RULES = parseWindowsSdk(UE58_WINDOWS_SDK);
const BUILD_TOOLS_PATH = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools";
const COMMUNITY_PATH = "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community";
const BUILD_TOOLS = {
  installationPath: BUILD_TOOLS_PATH,
  productId: "Microsoft.VisualStudio.Product.BuildTools",
  installationVersion: "17.14.36616.10",
};
const COMMUNITY = {
  installationPath: COMMUNITY_PATH,
  productId: "Microsoft.VisualStudio.Product.Community",
  installationVersion: "17.14.36616.10",
};

describe("the compilers and SDKs an engine builds with", () => {
  it("reads Unreal 5.8's own Windows_SDK.json", () => {
    assert.deepEqual(RULES, {
      minimumToolset: "14.38.33130",
      bannedToolsets: [
        { min: "14.50.0", max: "14.50.35722" },
        { min: "14.44.0", max: "14.44.35210" },
        { min: "14.40.0", max: "14.43.99999" },
        { min: "14.39.0", max: "14.39.99999" },
      ],
      sdkMin: "10.0.19041.0",
      sdkMax: "10.9.99999.0",
    });
  });

  const toolsets: Array<[string, boolean]> = [
    ["14.44.35211", true],
    ["14.44.35207", false],
    ["14.50.35723", true],
    ["14.50.35717", false],
    ["14.42.34433", false],
    ["14.39.33519", false],
    ["14.38.33130", true],
    ["14.37.32822", false],
    ["14.51.36014", true],
  ];
  for (const [version, accepted] of toolsets)
    it(`${accepted ? "builds with" : "refuses"} MSVC ${version}`, () => {
      assert.equal(toolsetAccepted(version, RULES), accepted);
    });

  it("builds with a Windows SDK from MinVersion to MaxVersion only", () => {
    assert.deepEqual(
      ["10.0.22621.0", "10.0.26100.0", "10.0.19041.0", "10.0.18362.0"].map((v) => sdkAccepted(v, RULES)),
      [true, true, true, false],
    );
  });

  it("judges by nothing, so refuses nothing, without the engine's rules", () => {
    assert.equal(toolsetAccepted("14.29.30133", null), true);
    assert.equal(sdkAccepted("10.0.17763.0", null), true);
  });

  const hostile: Array<[string, string]> = [
    ["not JSON", "{ MinimumVisualCppVersion: 14 "],
    ["an array", "[]"],
    [
      "a version that isn't dotted numbers",
      `{"MinimumVisualCppVersion":"14.38; rm","MinVersion":"10.0","MaxVersion":"10.9"}`,
    ],
    ["no SDK range", `{"MinimumVisualCppVersion":"14.38.33130"}`],
  ];
  for (const [shape, text] of hostile)
    it(`reads no rules from ${shape}`, () => {
      assert.equal(parseWindowsSdk(text), null);
    });

  it("leaves a malformed banned range out and keeps the rest", () => {
    const text = `{"MinimumVisualCppVersion":"14.38.33130","MinVersion":"10.0.19041.0","MaxVersion":"10.9.99999.0","BannedVisualCppVersions":["14.40.0-14.43.99999","everything",7,"14.1-"]}`;
    assert.deepEqual(parseWindowsSdk(text)?.bannedToolsets, [{ min: "14.40.0", max: "14.43.99999" }]);
  });

  it("reads the rules from the engine's folder, and none from an engine without the file", async () => {
    const engine = await tmpDir("studio-vs-engine-");
    assert.equal(await engineMsvcRules(engine), null);
    const config = path.join(engine, "Engine", "Config", "Windows");
    await mkdir(config, { recursive: true });
    await writeFile(path.join(config, "Windows_SDK.json"), UE58_WINDOWS_SDK);
    assert.deepEqual(await engineMsvcRules(engine), RULES);
  });
});

/** The facts of a Windows PC with these instances, compilers by instance, and SDKs. */
function facts(
  instances: VisualStudioFacts["instances"],
  toolsets: Record<string, string[]>,
  sdks: string[],
  rules: MsvcRules | null = RULES,
): VisualStudioFacts {
  return { platform: "win32", instances, toolsets: new Map(Object.entries(toolsets)), sdks, rules };
}

describe("where Microsoft's C++ tools stand", () => {
  it("is not for a Mac", () => {
    assert.deepEqual(visualStudioStatus({ ...facts([], {}, []), platform: "darwin" }), {
      state: VisualStudioState.NotApplicable,
      toolset: null,
      windowsSdk: false,
    });
  });

  it("is ready with an accepted compiler and SDK, naming the newest accepted compiler", () => {
    const status = visualStudioStatus(
      facts([COMMUNITY], { [COMMUNITY_PATH]: ["14.44.35211", "14.44.35207"] }, ["10.0.22621.0"]),
    );
    assert.deepEqual(status, { state: VisualStudioState.Ready, toolset: "14.44.35211", windowsSdk: true });
  });

  it("is missing on a PC with no Visual Studio, and Do it for me installs the Build Tools", () => {
    assert.deepEqual(visualStudioStatus(facts([], {}, [])), {
      state: VisualStudioState.Missing,
      toolset: null,
      windowsSdk: false,
      plan: BuildToolsPlan.Install,
    });
  });

  it("is missing with Build Tools that lack the C++ tools, and Do it for me adds them to that install", () => {
    const status = visualStudioStatus(facts([BUILD_TOOLS], { [BUILD_TOOLS_PATH]: [] }, ["10.0.22621.0"]));
    assert.deepEqual(
      [status.state, status.plan, status.installPath],
      [VisualStudioState.Missing, BuildToolsPlan.Modify, BUILD_TOOLS_PATH],
    );
  });

  it("is missing with a good compiler but no SDK the engine builds with", () => {
    const status = visualStudioStatus(facts([COMMUNITY], { [COMMUNITY_PATH]: ["14.44.35211"] }, ["10.0.18362.0"]));
    assert.deepEqual(
      [status.state, status.toolset, status.windowsSdk, status.plan],
      [VisualStudioState.Missing, "14.44.35211", false, BuildToolsPlan.Install],
    );
  });

  it("is outdated with only refused compilers: Build Tools are updated, Visual Studio gets Build Tools beside it", () => {
    const banned = { [BUILD_TOOLS_PATH]: ["14.40.33807"], [COMMUNITY_PATH]: ["14.40.33807"] };
    const update = visualStudioStatus(facts([BUILD_TOOLS], banned, ["10.0.22621.0"]));
    assert.deepEqual(
      [update.state, update.plan, update.installPath],
      [VisualStudioState.Outdated, BuildToolsPlan.Update, BUILD_TOOLS_PATH],
    );
    const beside = visualStudioStatus(facts([COMMUNITY], banned, ["10.0.22621.0"]));
    assert.deepEqual(
      [beside.state, beside.plan, beside.installPath],
      [VisualStudioState.Outdated, "install", undefined],
    );
  });

  it("adds a compiler to Build Tools that have none, when the refused one is another product's, on their own channel", () => {
    const ltsc = { ...BUILD_TOOLS, channelId: "VisualStudio.17.Release.LTSC.17.12" };
    const toolsets = { [BUILD_TOOLS_PATH]: [], [COMMUNITY_PATH]: ["14.40.33807"] };
    const status = visualStudioStatus(facts([ltsc, COMMUNITY], toolsets, ["10.0.22621.0"]));
    assert.deepEqual(
      [status.state, status.plan, status.installPath, status.channelId],
      [VisualStudioState.Outdated, BuildToolsPlan.Modify, BUILD_TOOLS_PATH, "VisualStudio.17.Release.LTSC.17.12"],
    );
  });

  it("installs new Build Tools beside Build Tools of another release", () => {
    const old = { ...BUILD_TOOLS, installationVersion: "16.11.35208.52" };
    const status = visualStudioStatus(facts([old], { [BUILD_TOOLS_PATH]: [] }, []));
    assert.deepEqual([status.plan, status.installPath], [BuildToolsPlan.Install, undefined]);
  });
});

/**
 * A Windows PC's Program Files (x86) in a temporary folder: vswhere answers `vswhere` (or fails),
 * each instance's MSVC folder holds `toolsets` (with cl.exe unless named in `noCompiler`), and the
 * Windows Kits hold `sdks` (with their headers unless named in `noHeaders`).
 */
async function windowsPc(layout: {
  vswhere?: (root: string) => string | Error;
  toolsets?: string[];
  noCompiler?: string[];
  sdks?: string[];
  noHeaders?: string[];
}) {
  const root = await tmpDir("studio-vs-pc-");
  const programFilesX86 = path.join(root, "Program Files (x86)");
  const instance = path.join(root, "BuildTools");
  for (const version of layout.toolsets ?? []) {
    const bin = path.join(instance, "VC", "Tools", "MSVC", version, "bin", "Hostx64", "x64");
    await mkdir(bin, { recursive: true });
    if (!layout.noCompiler?.includes(version)) await writeFile(path.join(bin, "cl.exe"), "MZ");
  }
  for (const version of layout.sdks ?? []) {
    const include = path.join(programFilesX86, "Windows Kits", "10", "Include", version);
    await mkdir(layout.noHeaders?.includes(version) ? include : path.join(include, "um"), { recursive: true });
  }
  const calls: Array<{ file: string; args: string[] }> = [];
  const runner: VisualStudioRunner = async (file, args) => {
    calls.push({ file, args: [...args] });
    const answer = layout.vswhere ? layout.vswhere(instance) : new Error("not found");
    if (answer instanceof Error) throw answer;
    return { stdout: answer };
  };
  return { probes: systemVisualStudioProbes({ programFilesX86 }, runner), calls, instance, programFilesX86 };
}

const vswhereListing = (installationPath: string) =>
  JSON.stringify([
    { ...BUILD_TOOLS, installationPath, isComplete: true, displayName: "Visual Studio Build Tools 2022" },
  ]);

describe("what this PC has, as the probes read it", () => {
  it("asks Microsoft's vswhere by its full path for every product, as JSON", async () => {
    const pc = await windowsPc({ vswhere: vswhereListing });
    assert.deepEqual(await pc.probes.instances(), [{ ...BUILD_TOOLS, installationPath: pc.instance }]);
    assert.deepEqual(pc.calls, [
      {
        file: path.win32.join(pc.programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe"),
        args: ["-products", "*", "-format", "json", "-utf8", "-nologo"],
      },
    ]);
  });

  it("finds no instance where vswhere isn't installed", async () => {
    const pc = await windowsPc({});
    assert.deepEqual(await pc.probes.instances(), []);
  });

  it("counts a compiler only with its x64 cl.exe, newest first", async () => {
    const pc = await windowsPc({
      toolsets: ["14.38.33130", "14.44.35211", "14.50.35723"],
      noCompiler: ["14.50.35723"],
    });
    assert.deepEqual(await pc.probes.toolsets(pc.instance), ["14.44.35211", "14.38.33130"]);
  });

  it("counts an SDK only with its headers, newest first", async () => {
    const pc = await windowsPc({ sdks: ["10.0.19041.0", "10.0.22621.0", "10.0.26100.0"], noHeaders: ["10.0.26100.0"] });
    assert.deepEqual(await pc.probes.sdks(), ["10.0.22621.0", "10.0.19041.0"]);
  });

  const listings: Array<[string, string]> = [
    ["garbage", "Error: not a listing"],
    ["an object, not a list", JSON.stringify({ installationPath: "C:\\VS" })],
    ["a relative path", JSON.stringify([{ ...BUILD_TOOLS, installationPath: "..\\..\\Users\\me" }])],
    ["a missing product id", JSON.stringify([{ installationPath: "C:\\VS", installationVersion: "17.14" }])],
  ];

  it("keeps an instance's channel only when it is a Visual Studio 2022 channel's name", () => {
    const listed = (channelId: string) => parseInstances(JSON.stringify([{ ...BUILD_TOOLS, channelId }]))[0]?.channelId;
    assert.equal(listed("VisualStudio.17.Release"), "VisualStudio.17.Release");
    for (const hostile of ["VisualStudio.17.Release --remove x", "VisualStudio.18.Stable", "x"])
      assert.equal(listed(hostile), undefined, hostile);
  });
  for (const [shape, stdout] of listings)
    it(`lists no instance from ${shape}`, () => {
      assert.deepEqual(parseInstances(stdout), []);
    });
});

describe("the check, asked on each status", () => {
  it("asks nothing off Windows", async () => {
    const never = async () => assert.fail("a Mac asks nothing about Visual Studio");
    const check = visualStudioChecker("darwin", { instances: never, toolsets: never, sdks: never, rules: never });
    assert.equal((await check("/Users/Shared/Epic Games/UE_5.8")).state, VisualStudioState.NotApplicable);
  });

  it("judges this PC by the engine's rules, and notices an install on the next status", async () => {
    const pc = await windowsPc({ vswhere: vswhereListing, toolsets: ["14.40.33807"], sdks: ["10.0.22621.0"] });
    const engine = await tmpDir("studio-vs-engine-");
    const config = path.join(engine, "Engine", "Config", "Windows");
    await mkdir(config, { recursive: true });
    await writeFile(path.join(config, "Windows_SDK.json"), UE58_WINDOWS_SDK);
    const check = visualStudioChecker("win32", pc.probes);
    assert.equal((await check(engine)).state, VisualStudioState.Outdated, "14.40 is banned in 5.8");
    assert.equal((await check(undefined)).state, VisualStudioState.Ready, "with no engine to judge by, any compiler");
    const bin = path.join(pc.instance, "VC", "Tools", "MSVC", "14.44.35211", "bin", "Hostx64", "x64");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "cl.exe"), "MZ");
    assert.deepEqual(await check(engine), {
      state: VisualStudioState.Ready,
      toolset: "14.44.35211",
      windowsSdk: true,
    });
  });
});
