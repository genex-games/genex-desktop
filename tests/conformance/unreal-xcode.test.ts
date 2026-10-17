/**
 * Xcode for Unreal on a Mac: recommended to every Mac user of the Unreal plugin, since without it
 * Genex builds Blueprints only. Genex tells Missing, NotSelected, FirstLaunch, Unsupported and
 * Ready apart from probes that never prompt and never ask for a password, reads the Xcode range
 * from the engine's own Apple_SDK.json, and notices a change on the next status by itself.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  engineXcodeRange,
  parseAppleSdk,
  systemXcodeProbes,
  type XcodeFacts,
  type XcodeProbes,
  type XcodeRunner,
  XcodeState,
  xcodeChecker,
  xcodeStatus,
} from "../../src/plugins/unreal/xcode.ts";
import { tmpDir } from "../helpers/tmp.ts";

const XCODE = "/Applications/Xcode.app";
const BETA = "/Applications/Xcode-beta.app";
const CLT = "/Library/Developer/CommandLineTools";
const developer = (app: string) => `${app}/Contents/Developer`;
const RANGE = { min: "15.2.0", max: "27.9.0" };

/** UE 5.8.3's `Engine/Config/Apple/Apple_SDK.json`, `//` comment keys and all. */
const APPLE_SDK = `{
	"//1": "Xcode versions:",
		"MainVersion": "26.1.1",
		"MinVersion": "15.2.0",
		"MaxVersion": "27.9.0",
	"//2": "!!!",
	"//3": "NOTE: If you update the MaxVersion, double check the AppleVersionToLLVMVersion array below!!!",
	"//5": "The versions on Windows are iTunes versions:",
		"MinVersion_Win64": "1100.0.0.0",
		"MaxVersion_Win64": "8999.0",
		"AppleVersionToLLVMVersions": [
			"16.0.0-17.0.6",
			"27.0.0-21.1.6"
		]
}
`;

/** A Mac with Xcode 26.2 selected, launched once and its licence accepted; each row changes what it names. */
function facts(overrides: Partial<XcodeFacts> = {}): XcodeFacts {
  return {
    platform: "darwin",
    selected: developer(XCODE),
    app: XCODE,
    version: "26.2",
    firstLaunchDone: true,
    licenseAccepted: true,
    commandLineTools: true,
    range: RANGE,
    ...overrides,
  };
}

describe("where Xcode stands", () => {
  const rows: Array<[string, Partial<XcodeFacts>, XcodeState]> = [
    ["Windows", { platform: "win32", selected: null, app: null, version: null }, XcodeState.NotApplicable],
    ["Linux", { platform: "linux", selected: null, app: null, version: null }, XcodeState.NotApplicable],
    ["no Xcode, Command Line Tools only", { selected: CLT, app: null, version: null }, XcodeState.Missing],
    [
      "no Xcode and no Command Line Tools",
      { selected: null, app: null, version: null, commandLineTools: false },
      XcodeState.Missing,
    ],
    ["Xcode installed, the Command Line Tools selected", { selected: CLT }, XcodeState.NotSelected],
    ["Xcode installed, nothing selected", { selected: null }, XcodeState.NotSelected],
    ["first launch pending", { firstLaunchDone: false }, XcodeState.FirstLaunch],
    ["licence not accepted", { licenseAccepted: false }, XcodeState.FirstLaunch],
    ["ready", {}, XcodeState.Ready],
    ["a beta, selected", { selected: developer(BETA), app: BETA, version: "27.0" }, XcodeState.Ready],
    ["the lowest supported version", { version: "15.2.0" }, XcodeState.Ready],
    ["the lowest supported version, short", { version: "15.2" }, XcodeState.Ready],
    ["below the range", { version: "15.1.9" }, XcodeState.Unsupported],
    ["the highest supported version", { version: "27.9.0" }, XcodeState.Ready],
    ["the highest supported version, short", { version: "27.9" }, XcodeState.Ready],
    ["a patch above the range", { version: "27.9.1" }, XcodeState.Unsupported],
    ["above the range", { version: "28.0" }, XcodeState.Unsupported],
    ["unsupported wins over not selected", { version: "28.0", selected: CLT }, XcodeState.Unsupported],
    ["no engine range: never unsupported", { version: "28.0", range: null }, XcodeState.Ready],
  ];
  for (const [name, row, state] of rows)
    it(`${name} → ${state}`, () => {
      assert.equal(xcodeStatus(facts(row)).state, state);
    });

  it("Missing says whether Apple's Command Line Tools are there", () => {
    const withTools = xcodeStatus(facts({ selected: CLT, app: null, version: null }));
    const without = xcodeStatus(facts({ selected: null, app: null, version: null, commandLineTools: false }));
    assert.deepEqual([withTools.commandLineTools, without.commandLineTools], [true, false]);
    assert.equal(withTools.command, null);
  });

  it("NotSelected names the one command the user runs, for the app Genex found", () => {
    assert.equal(xcodeStatus(facts({ selected: CLT })).command, "sudo xcode-select -s /Applications/Xcode.app");
    const beta = xcodeStatus(facts({ selected: CLT, app: BETA, version: "27.0" }));
    assert.equal(beta.command, "sudo xcode-select -s /Applications/Xcode-beta.app");
    const spaced = xcodeStatus(facts({ selected: null, app: "/Applications/Xcode 26.app" }));
    assert.equal(spaced.command, "sudo xcode-select -s '/Applications/Xcode 26.app'");
    for (const state of [{}, { firstLaunchDone: false }, { version: "28.0" }])
      assert.equal(xcodeStatus(facts(state)).command, null, "only NotSelected has a command");
  });

  it("Unsupported says whether Xcode is too new, which the App Store can't fix, or too old", () => {
    const rows: Array<[string, string, boolean]> = [
      ["a patch above the range", "27.9.1", true],
      ["above the range", "28.0", true],
      ["below the range", "15.1.9", false],
    ];
    for (const [name, version, tooNew] of rows) assert.equal(xcodeStatus(facts({ version })).tooNew, tooNew, name);
    for (const state of [{}, { firstLaunchDone: false }, { selected: CLT }, { app: null, version: null }])
      assert.equal(xcodeStatus(facts(state)).tooNew, false, "only an Xcode above the range is too new");
  });

  it("Unsupported carries the version and the engine's range as the panel says them", () => {
    const status = xcodeStatus(facts({ version: "28.0" }));
    assert.deepEqual([status.version, status.supported], ["28.0", { min: "15.2", max: "27.9" }]);
    assert.deepEqual(xcodeStatus(facts({ range: { min: "15.0.0", max: "26.1.1" } })).supported, {
      min: "15.0",
      max: "26.1.1",
    });
  });
});

describe("the engine's Xcode range", () => {
  it("reads MinVersion and MaxVersion from Apple_SDK.json, comment keys and all", () => {
    assert.deepEqual(parseAppleSdk(APPLE_SDK), { min: "15.2.0", max: "27.9.0" });
  });

  it("is unknown for a file that isn't JSON, lacks a key or names no version", () => {
    for (const text of [
      "",
      "not json",
      "[]",
      '{"MinVersion": "15.2.0"}',
      '{"MinVersion": 15, "MaxVersion": 27}',
      '{"MinVersion": "latest", "MaxVersion": "27.9.0"}',
    ])
      assert.equal(parseAppleSdk(text), null, text);
  });

  it("comes from <engine>/Engine/Config/Apple/Apple_SDK.json; none without the file", async () => {
    const engine = await tmpDir("studio-unreal-xcode-engine-");
    assert.equal(await engineXcodeRange(engine), null);
    await mkdir(path.join(engine, "Engine", "Config", "Apple"), { recursive: true });
    await writeFile(path.join(engine, "Engine", "Config", "Apple", "Apple_SDK.json"), APPLE_SDK);
    assert.deepEqual(await engineXcodeRange(engine), RANGE);
  });
});

/** Probes over a fake Mac the test changes; each records how often it was asked. */
function fakeMac(mac: {
  selected: string | null;
  apps: string[];
  version: string | null;
  firstLaunch: boolean;
  license: boolean;
}) {
  const asked = { selected: 0, firstLaunch: 0, license: 0, range: [] as string[] };
  const probes: XcodeProbes = {
    selected: async () => {
      asked.selected++;
      return mac.selected;
    },
    apps: async () => mac.apps,
    version: async () => mac.version,
    firstLaunchDone: async () => {
      asked.firstLaunch++;
      return mac.firstLaunch;
    },
    licenseAccepted: async () => {
      asked.license++;
      return mac.license;
    },
    commandLineTools: async () => true,
    range: async (engine) => {
      asked.range.push(engine);
      return RANGE;
    },
  };
  return { asked, probes };
}

describe("checking Xcode on each status", () => {
  it("asks nothing off a Mac", async () => {
    const { asked, probes } = fakeMac({ selected: null, apps: [], version: null, firstLaunch: false, license: false });
    const status = await xcodeChecker("win32", probes)("C:\\UE_5.8");
    assert.equal(status.state, XcodeState.NotApplicable);
    assert.deepEqual(asked, { selected: 0, firstLaunch: 0, license: 0, range: [] });
  });

  it("judges the selected Xcode first, else the first one in Applications", async () => {
    const mac = { selected: developer(BETA), apps: [XCODE, BETA], version: "27.0", firstLaunch: true, license: true };
    const { probes } = fakeMac(mac);
    const check = xcodeChecker("darwin", probes);
    assert.deepEqual([(await check(undefined)).app, (await check(undefined)).state], [BETA, XcodeState.Ready]);
    mac.selected = CLT;
    assert.deepEqual([(await check(undefined)).app, (await check(undefined)).state], [XCODE, XcodeState.NotSelected]);
  });

  it("reads the range from the engine it is given, and none without one", async () => {
    const mac = { selected: developer(XCODE), apps: [XCODE], version: "28.0", firstLaunch: true, license: true };
    const { asked, probes } = fakeMac(mac);
    const check = xcodeChecker("darwin", probes);
    assert.equal((await check(undefined)).state, XcodeState.Ready);
    assert.equal((await check("/Users/Shared/Epic Games/UE_5.8")).state, XcodeState.Unsupported);
    assert.deepEqual(asked.range, ["/Users/Shared/Epic Games/UE_5.8"]);
  });

  it("with the selected Xcode too new, a second Xcode in range is the one to select", async () => {
    const SIDE = "/Applications/Xcode_27.app";
    const versions: Record<string, string> = { [XCODE]: "28.0", [SIDE]: "27.1" };
    const mac = { selected: developer(XCODE), apps: [XCODE, SIDE], version: null, firstLaunch: true, license: true };
    const { probes } = fakeMac(mac);
    const check = xcodeChecker("darwin", { ...probes, version: async (app) => versions[app] ?? null });
    const status = await check("/Users/Shared/Epic Games/UE_5.8");
    assert.deepEqual([status.state, status.app, status.version], [XcodeState.NotSelected, SIDE, "27.1"]);
    assert.equal(status.command, `sudo xcode-select -s ${SIDE}`);
    const alone = await xcodeChecker("darwin", { ...probes, apps: async () => [XCODE], version: async () => "28.0" })(
      "/Users/Shared/Epic Games/UE_5.8",
    );
    assert.deepEqual([alone.state, alone.tooNew], [XcodeState.Unsupported, true], "no other Xcode: still too new");
  });

  it("notices a first launch finishing, then stops asking xcodebuild about that Xcode", async () => {
    const mac = { selected: developer(XCODE), apps: [XCODE], version: "26.2", firstLaunch: false, license: true };
    const { asked, probes } = fakeMac(mac);
    const check = xcodeChecker("darwin", probes);
    assert.equal((await check(undefined)).state, XcodeState.FirstLaunch);
    assert.equal((await check(undefined)).state, XcodeState.FirstLaunch);
    mac.firstLaunch = true;
    assert.equal((await check(undefined)).state, XcodeState.Ready);
    const before = { ...asked };
    assert.equal((await check(undefined)).state, XcodeState.Ready);
    assert.deepEqual([asked.firstLaunch, asked.license], [before.firstLaunch, before.license], "done stays done");
    assert.equal(asked.selected, before.selected + 1, "the selection is asked on every status");
    mac.version = "26.3";
    mac.license = false;
    assert.equal((await check(undefined)).state, XcodeState.FirstLaunch, "an updated Xcode is asked again");
  });

  it("notices Xcode installed and removed", async () => {
    const mac = { selected: CLT, apps: [] as string[], version: null, firstLaunch: true, license: true };
    const { probes } = fakeMac(mac);
    const check = xcodeChecker("darwin", probes);
    assert.equal((await check(undefined)).state, XcodeState.Missing);
    Object.assign(mac, { apps: [XCODE], version: "26.2" });
    assert.equal((await check(undefined)).state, XcodeState.NotSelected);
    mac.selected = developer(XCODE);
    assert.equal((await check(undefined)).state, XcodeState.Ready);
    Object.assign(mac, { selected: CLT, apps: [], version: null });
    assert.equal((await check(undefined)).state, XcodeState.Missing);
  });
});

/** A runner that answers like this Mac's tools and records each call; nothing runs. */
function recordingRunner(answers: { selected: string | null; firstLaunchExit: number; licenseExit: number }) {
  const calls: Array<{ file: string; args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
  const failed = (code: number) => Object.assign(new Error(`exit ${code}`), { code });
  const runner: XcodeRunner = async (file, args, options) => {
    calls.push({ file, args, env: options.env });
    assert.ok(options.timeout > 0, "every probe has a timeout");
    if (file === "/usr/bin/xcode-select") {
      if (answers.selected === null) throw failed(2);
      return { stdout: `${answers.selected}\n` };
    }
    if (file === "/usr/bin/plutil") return { stdout: "26.2\n" };
    const exit = args.includes("-checkFirstLaunchStatus") ? answers.firstLaunchExit : answers.licenseExit;
    if (exit !== 0) throw failed(exit);
    return { stdout: "" };
  };
  return { calls, runner };
}

/** A fake Mac's folders: Applications with Xcode, a beta and lookalikes, and the Command Line Tools. */
async function fakeFolders() {
  const root = await tmpDir("studio-unreal-xcode-mac-");
  const applications = path.join(root, "Applications");
  const commandLineTools = path.join(root, "Library", "Developer", "CommandLineTools");
  for (const app of ["Xcode-beta.app", "Xcode.app", "Xcode_15.4.app", "Safari.app"])
    await mkdir(path.join(applications, app, "Contents", "Developer"), { recursive: true });
  await writeFile(path.join(applications, "Xcode-old.app"), "not an app");
  await writeFile(path.join(applications, "Xcode.xip"), "an archive");
  return { root, applications, commandLineTools };
}

describe("the probes on a Mac", () => {
  it("never run sudo or a shell: each is a program by its full path with an argument array", async () => {
    const folders = await fakeFolders();
    await mkdir(folders.commandLineTools, { recursive: true });
    const app = path.join(folders.applications, "Xcode.app");
    const { calls, runner } = recordingRunner({ selected: developer(app), firstLaunchExit: 0, licenseExit: 0 });
    const check = xcodeChecker("darwin", systemXcodeProbes(runner, { PATH: "/usr/bin" }, folders));
    const status = await check(undefined);
    assert.deepEqual([status.state, status.app, status.version], [XcodeState.Ready, app, "26.2"]);
    assert.ok(calls.length >= 4);
    for (const call of calls) {
      assert.ok(path.isAbsolute(call.file), call.file);
      assert.ok(!/(^|\/)(sudo|sh|bash|zsh|env|osascript)$/.test(call.file), call.file);
      assert.ok(!call.args.includes("sudo") && !call.args.includes("-c"), call.args.join(" "));
    }
    const xcodebuild = calls.filter((c) => c.file === path.join(developer(app), "usr", "bin", "xcodebuild"));
    assert.deepEqual(
      xcodebuild.map((c) => c.args),
      [["-checkFirstLaunchStatus"], ["-license", "check"]],
    );
    for (const call of xcodebuild)
      assert.equal(call.env?.DEVELOPER_DIR, developer(app), "asks that Xcode, not the selected one");
  });

  it("lists Xcode apps in Applications, Xcode.app first, never a file or another app", async () => {
    const folders = await fakeFolders();
    const { runner } = recordingRunner({ selected: null, firstLaunchExit: 0, licenseExit: 0 });
    const apps = await systemXcodeProbes(runner, {}, folders).apps();
    assert.deepEqual(
      apps,
      ["Xcode.app", "Xcode-beta.app", "Xcode_15.4.app"].map((name) => path.join(folders.applications, name)),
    );
  });

  it("reads xcodebuild's exit codes: 69 is a first launch or licence still to do", async () => {
    const folders = await fakeFolders();
    const app = path.join(folders.applications, "Xcode.app");
    const pending = recordingRunner({ selected: developer(app), firstLaunchExit: 69, licenseExit: 69 });
    const probes = systemXcodeProbes(pending.runner, {}, folders);
    assert.deepEqual([await probes.firstLaunchDone(app), await probes.licenseAccepted(app)], [false, false]);
    const done = systemXcodeProbes(
      recordingRunner({ selected: null, firstLaunchExit: 0, licenseExit: 0 }).runner,
      {},
      folders,
    );
    assert.deepEqual([await done.firstLaunchDone(app), await done.licenseAccepted(app)], [true, true]);
  });

  it("counts a selection only while its folder is there, and the Command Line Tools by their folder", async () => {
    const folders = await fakeFolders();
    const gone = recordingRunner({
      selected: "/Applications/Removed.app/Contents/Developer",
      firstLaunchExit: 0,
      licenseExit: 0,
    });
    assert.equal(await systemXcodeProbes(gone.runner, {}, folders).selected(), null);
    const failing = recordingRunner({ selected: null, firstLaunchExit: 0, licenseExit: 0 });
    const probes = systemXcodeProbes(failing.runner, {}, folders);
    assert.equal(await probes.selected(), null);
    assert.equal(await probes.commandLineTools(), false);
    await mkdir(folders.commandLineTools, { recursive: true });
    assert.equal(await probes.commandLineTools(), true);
  });
});
