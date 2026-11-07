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
  netFxSdkAccepted,
  parseInstances,
  parseNetFxSdks,
  parseWindowsSdk,
  productVersionOf,
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

/** The facts of a Windows PC with these instances, compilers by instance, Windows SDKs and .NET Framework SDKs. */
function facts(
  instances: VisualStudioFacts["instances"],
  toolsets: Record<string, string[]>,
  sdks: string[],
  rules: MsvcRules | null = RULES,
  netFxSdks: string[] = ["4.8"],
): VisualStudioFacts {
  return { platform: "win32", instances, toolsets: new Map(Object.entries(toolsets)), sdks, netFxSdks, rules };
}

describe("where Microsoft's C++ tools stand", () => {
  it("is not for a Mac", () => {
    assert.deepEqual(visualStudioStatus({ ...facts([], {}, []), platform: "darwin" }), {
      state: VisualStudioState.NotApplicable,
      toolset: null,
      windowsSdk: false,
      netFxSdk: false,
    });
  });

  it("is ready with an accepted compiler and SDK, naming the newest accepted compiler", () => {
    const status = visualStudioStatus(
      facts([COMMUNITY], { [COMMUNITY_PATH]: ["14.44.35211", "14.44.35207"] }, ["10.0.22621.0"]),
    );
    assert.deepEqual(status, {
      state: VisualStudioState.Ready,
      toolset: "14.44.35211",
      windowsSdk: true,
      netFxSdk: true,
    });
  });

  it("is missing without a .NET Framework SDK of 4.6 or later, every editor build's need, and Do it for me adds it", () => {
    const good = { [BUILD_TOOLS_PATH]: ["14.44.35211"] };
    for (const netFx of [[], ["4.5.2"]]) {
      const status = visualStudioStatus(facts([BUILD_TOOLS], good, ["10.0.22621.0"], RULES, netFx));
      assert.deepEqual(
        [status.state, status.toolset, status.windowsSdk, status.netFxSdk, status.plan, status.installPath],
        [VisualStudioState.Missing, "14.44.35211", true, false, BuildToolsPlan.Modify, BUILD_TOOLS_PATH],
        netFx.join() || "none",
      );
    }
  });

  it("is outdated on a PC whose only compiler the engine bans and with no .NET Framework SDK: the update comes first", () => {
    const status = visualStudioStatus(
      facts([BUILD_TOOLS], { [BUILD_TOOLS_PATH]: ["14.44.35207"] }, ["10.0.22621.0"], RULES, []),
    );
    assert.deepEqual(
      [status.state, status.toolset, status.netFxSdk, status.plan],
      [VisualStudioState.Outdated, null, false, BuildToolsPlan.Update],
    );
  });

  it("is missing on a PC with no Visual Studio, and Do it for me installs the Build Tools", () => {
    assert.deepEqual(visualStudioStatus(facts([], {}, [], RULES, [])), {
      state: VisualStudioState.Missing,
      toolset: null,
      windowsSdk: false,
      netFxSdk: false,
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
 * each instance's MSVC folder holds `toolsets` (with cl.exe unless named in `noCompiler`, naming the
 * version `compilerVersions` gives it, else none), and the Windows Kits hold `sdks` (with their
 * headers unless named in `noHeaders`).
 */
async function windowsPc(layout: {
  vswhere?: (root: string) => string | Error;
  toolsets?: string[];
  noCompiler?: string[];
  /** The product version a toolset folder's cl.exe names, by the folder's name. */
  compilerVersions?: Record<string, string>;
  sdks?: string[];
  noHeaders?: string[];
  /** What reg.exe answers for each registry key; a key not named isn't there. */
  registry?: Record<string, string>;
}) {
  const root = await tmpDir("studio-vs-pc-");
  const programFilesX86 = path.join(root, "Program Files (x86)");
  const instance = path.join(root, "BuildTools");
  for (const version of layout.toolsets ?? []) {
    const bin = path.join(instance, "VC", "Tools", "MSVC", version, "bin", "Hostx64", "x64");
    await mkdir(bin, { recursive: true });
    const productVersion = layout.compilerVersions?.[version];
    const program = productVersion ? programNaming(productVersion) : "MZ";
    if (!layout.noCompiler?.includes(version)) await writeFile(path.join(bin, "cl.exe"), program);
  }
  for (const version of layout.sdks ?? []) {
    const include = path.join(programFilesX86, "Windows Kits", "10", "Include", version);
    await mkdir(layout.noHeaders?.includes(version) ? include : path.join(include, "um"), { recursive: true });
  }
  const calls: Array<{ file: string; args: string[] }> = [];
  const runner: VisualStudioRunner = async (file, args) => {
    calls.push({ file, args: [...args] });
    const answer =
      file === REG_EXE ? registryAnswer(layout.registry, args[1]) : vswhereAnswer(layout.vswhere, instance);
    if (answer instanceof Error) throw answer;
    return { stdout: answer };
  };
  const probes = systemVisualStudioProbes({ programFilesX86, regExe: REG_EXE }, runner);
  return { probes, calls, instance, programFilesX86 };
}

/** cl.exe's file version, which counts the compiler (19.x) where its product version counts the toolset (14.x). */
const CL_FILE_VERSION = "19.44.35229";

/** A VS_FIXEDFILEINFO naming `productVersion` and `fileVersion` (major.minor.build). */
function versionBlock(productVersion: string, fileVersion = CL_FILE_VERSION, structVersion = 0x00010000): Buffer {
  const block = Buffer.alloc(52);
  block.writeUInt32LE(0xfeef04bd, 0);
  block.writeUInt32LE(structVersion, 4);
  for (const [at, version] of [
    [8, fileVersion],
    [16, productVersion],
  ] as const) {
    const [major = 0, minor = 0, build = 0] = version.split(".").map(Number);
    block.writeUInt32LE(((major << 16) | minor) >>> 0, at);
    block.writeUInt32LE((build << 16) >>> 0, at + 4);
  }
  return block;
}

/**
 * A Windows program as Microsoft's linker lays one out, cut short: its header, code in which the
 * signature's four bytes happen to stand, and the version block among its resources.
 */
const programNaming = (productVersion: string) =>
  Buffer.concat([
    Buffer.from("MZ"),
    Buffer.alloc(62),
    versionBlock("1.2.3", "1.2.3", 0),
    Buffer.alloc(32),
    versionBlock(productVersion),
  ]);

const vswhereAnswer = (vswhere: ((root: string) => string | Error) | undefined, instance: string) =>
  vswhere ? vswhere(instance) : new Error("not found");

/** reg.exe's answer for `key`: its listing, or the error reg.exe exits with for a key that isn't there. */
const registryAnswer = (registry: Record<string, string> | undefined, key: string | undefined) =>
  (key && registry?.[key]) ?? new Error("ERROR: The system was unable to find the specified registry key or value.");

const REG_EXE = "C:\\Windows\\System32\\reg.exe";
const NETFX_WOW = "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Microsoft SDKs\\NETFXSDK";
const NETFX_NATIVE = "HKLM\\SOFTWARE\\Microsoft\\Microsoft SDKs\\NETFXSDK";
/** reg query's answer on a PC with the .NET Framework 4.8 SDK, as Windows prints it (CRLF). */
const NETFX_48 = [
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Microsoft SDKs\\NETFXSDK\\4.8",
  "    KitsInstallationFolder    REG_SZ    C:\\Program Files (x86)\\Windows Kits\\NETFXSDK\\4.8\\",
  "",
  "End of search: 1 match(es) found.",
  "",
].join("\r\n");

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

  it("names a compiler by its cl.exe's own product version, which Microsoft's updates raise in place, as UnrealBuildTool does", async () => {
    // A real PC on 2026-11-07: the folder still says 14.44.35207 (which 5.8 bans), cl.exe's product
    // version says 14.44.35229 and its file version 19.44.35229.
    const pc = await windowsPc({
      toolsets: ["14.44.35207", "14.38.33130"],
      compilerVersions: { "14.44.35207": "14.44.35229" },
    });
    assert.deepEqual(await pc.probes.toolsets(pc.instance), ["14.44.35229", "14.38.33130"], "no version: the folder's");
  });

  const versionBlocks: Array<[string, Buffer, string | null]> = [
    ["a program with no version block", Buffer.from("MZ not a resource"), null],
    ["the signature's bytes in code only", Buffer.concat([Buffer.from("MZ"), versionBlock("1.2.3", "1.2.3", 0)]), null],
    ["cl.exe's block, its product version, not its 19.x file version", programNaming("14.44.35229"), "14.44.35229"],
    ["a block whose product version's major part is 0", versionBlock("0.44.35229"), null],
    ["a block cut short before its product version ends", versionBlock("14.44.35229").subarray(0, 20), null],
  ];
  for (const [shape, program, version] of versionBlocks)
    it(`reads ${version ?? "no version"} from ${shape}`, () => {
      assert.equal(productVersionOf(program), version);
    });

  it("asks reg.exe by its full path for the .NET Framework SDKs under both registry views, as UnrealBuildTool looks", async () => {
    const pc = await windowsPc({ registry: { [NETFX_WOW]: NETFX_48 } });
    assert.deepEqual(await pc.probes.netFxSdks(), ["4.8"]);
    assert.deepEqual(pc.calls, [
      { file: REG_EXE, args: ["query", NETFX_WOW, "/s", "/v", "KitsInstallationFolder"] },
      { file: REG_EXE, args: ["query", NETFX_NATIVE, "/s", "/v", "KitsInstallationFolder"] },
    ]);
    assert.deepEqual(await (await windowsPc({})).probes.netFxSdks(), [], "no key: none, and no error");
  });

  it("reads a .NET Framework SDK version only from its own key with an install folder", () => {
    const listing = (lines: string[]) => lines.join("\r\n");
    const rows: Array<[string, string, string[]]> = [
      ["the 4.8 SDK", NETFX_48, ["4.8"]],
      [
        "two versions, newest first",
        listing([
          "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Microsoft SDKs\\NETFXSDK\\4.6.1",
          "    KitsInstallationFolder    REG_SZ    C:\\Kits\\4.6.1\\",
          "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Microsoft SDKs\\NETFXSDK\\4.8.1",
          "    KitsInstallationFolder    REG_SZ    C:\\Kits\\4.8.1\\",
        ]),
        ["4.8.1", "4.6.1"],
      ],
      [
        "a subkey's folder, not the version's",
        listing([
          "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Microsoft SDKs\\NETFXSDK\\4.8\\WinSDK-NetFx40Tools",
          "    KitsInstallationFolder    REG_SZ    C:\\Kits\\4.8\\",
        ]),
        [],
      ],
      [
        "a version key with an empty folder",
        listing([
          "HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Microsoft SDKs\\NETFXSDK\\4.8",
          "    KitsInstallationFolder    REG_SZ    ",
        ]),
        [],
      ],
      ["garbage", "ERROR: Invalid syntax.", []],
    ];
    for (const [label, output, versions] of rows) assert.deepEqual(parseNetFxSdks(output), versions, label);
    assert.deepEqual(["4.5.2", "4.6", "4.8.1"].map(netFxSdkAccepted), [false, true, true], "4.6 and later, as UBT");
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
    const check = visualStudioChecker("darwin", {
      instances: never,
      toolsets: never,
      sdks: never,
      netFxSdks: never,
      rules: never,
    });
    assert.equal((await check("/Users/Shared/Epic Games/UE_5.8")).state, VisualStudioState.NotApplicable);
  });

  it("judges this PC by the engine's rules, and notices an install on the next status", async () => {
    const pc = await windowsPc({
      vswhere: vswhereListing,
      toolsets: ["14.40.33807"],
      sdks: ["10.0.22621.0"],
      registry: { [NETFX_WOW]: NETFX_48 },
    });
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
      netFxSdk: true,
    });
  });

  it("sees a PC whose banned-looking folder holds an updated compiler as lacking only the .NET Framework SDK", async () => {
    // A real PC on 2026-11-07: Build Tools 17.14, MSVC folder 14.44.35207 with cl.exe 14.44.35229, the
    // Windows 11 SDK and no NETFXSDK key. Do it for me adds the SDK; nothing needs an update.
    const pc = await windowsPc({
      vswhere: vswhereListing,
      toolsets: ["14.44.35207"],
      compilerVersions: { "14.44.35207": "14.44.35229" },
      sdks: ["10.0.22621.0"],
    });
    const status = await visualStudioChecker("win32", { ...pc.probes, rules: async () => RULES })(
      "D:\\Epic Games\\UE_5.8",
    );
    assert.deepEqual(status, {
      state: VisualStudioState.Missing,
      toolset: "14.44.35229",
      windowsSdk: true,
      netFxSdk: false,
      plan: BuildToolsPlan.Modify,
      installPath: pc.instance,
    });
  });
});
