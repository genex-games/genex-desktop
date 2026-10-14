/**
 * The Xcode probe for iPhone builds (M5.4): Xcode's version and its iOS and Simulator SDKs read
 * from plain files (never `xcodebuild`, which can stop on Apple's licence prompt), and the gate a
 * device build and a Simulator build each pass: Xcode absent refuses both `xcode-missing`; Xcode
 * older than 26 (or an iOS SDK older than 26) refuses a device build while a Simulator build runs.
 */
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { XcodeStatus } from "../../src/shared/toolchain.ts";
import type { XcodeExec } from "../../src/substrate/toolchain-store/locate.ts";
import {
  deviceBuildRefusal,
  probeXcodeSdks,
  simulatorBuildRefusal,
  XcodeRefusal,
} from "../../src/substrate/toolchain-store/xcode-probe.ts";
import { tmpDir } from "../helpers/tmp.ts";

const plist = (version: string) =>
  `<?xml version="1.0"?>\n<plist version="1.0"><dict>\n<key>CFBundleShortVersionString</key>\n<string>${version}</string>\n</dict></plist>\n`;

interface XcodeShape {
  version: string;
  iosSdks?: readonly string[];
  simulatorSdks?: readonly string[];
}

const SDKS_OF = {
  ios: ["iPhoneOS.platform", "iPhoneOS"],
  simulator: ["iPhoneSimulator.platform", "iPhoneSimulator"],
} as const;

/** A fake Xcode bundle: its `version.plist` and an SDK folder per version (plus the unversioned link Xcode keeps). */
async function makeXcode(app: string, shape: XcodeShape): Promise<string> {
  await mkdir(path.join(app, "Contents"), { recursive: true });
  await writeFile(path.join(app, "Contents", "version.plist"), plist(shape.version));
  const kinds = [
    [SDKS_OF.ios, shape.iosSdks ?? []],
    [SDKS_OF.simulator, shape.simulatorSdks ?? []],
  ] as const;
  for (const [[platform, name], versions] of kinds) {
    const sdks = path.join(app, "Contents", "Developer", "Platforms", platform, "Developer", "SDKs");
    await mkdir(sdks, { recursive: true });
    for (const version of versions) await mkdir(path.join(sdks, `${name}${version}.sdk`), { recursive: true });
    const newest = versions.at(-1);
    if (newest) await symlink(`${name}${newest}.sdk`, path.join(sdks, `${name}.sdk`));
  }
  return app;
}

/** An `xcode-select -p` that answers `selected` (or fails), recording every program run. */
function selectExec(selected: string | null) {
  const ran: string[] = [];
  const exec: XcodeExec = async (file, args) => {
    ran.push([file, ...args].join(" "));
    if (selected === null) return { code: 2, stdout: "", stderr: "unable to get active developer directory" };
    return { code: 0, stdout: `${selected}\n`, stderr: "" };
  };
  return { ran, exec };
}

describe("the Xcode probe", () => {
  it("reads the selected Xcode's version and the newest iOS and Simulator SDKs, running only xcode-select -p", async () => {
    const app = await makeXcode(path.join(await tmpDir("xcode-"), "Xcode.app"), {
      version: "26.6",
      iosSdks: ["26.0", "26.5"],
      simulatorSdks: ["26.5"],
    });
    const { ran, exec } = selectExec(path.join(app, "Contents", "Developer"));
    const found = await probeXcodeSdks({ exec, platform: "darwin", defaultApp: "/nonexistent/Xcode.app" });
    assert.deepEqual(found, {
      present: true,
      version: "26.6",
      iosSdk: "26.5",
      simulatorSdk: "26.5",
      status: XcodeStatus.Ready,
    });
    assert.deepEqual(ran, ["/usr/bin/xcode-select -p"], "never xcodebuild, xcrun or a shim");
  });

  it("reads Xcode 26's layout, where the versioned SDK name links to the unversioned folder in the same SDKs folder", async () => {
    const app = await makeXcode(path.join(await tmpDir("xcode-"), "Xcode.app"), { version: "26.6" });
    for (const [platform, name] of [SDKS_OF.ios, SDKS_OF.simulator]) {
      const sdks = path.join(app, "Contents", "Developer", "Platforms", platform, "Developer", "SDKs");
      await mkdir(path.join(sdks, `${name}.sdk`));
      await symlink(`${name}.sdk`, path.join(sdks, `${name}26.5.sdk`));
    }
    const found = await probeXcodeSdks({ exec: selectExec(null).exec, platform: "darwin", defaultApp: app });
    assert.equal(found.iosSdk, "26.5");
    assert.equal(found.simulatorSdk, "26.5");
    assert.equal(found.status, XcodeStatus.Ready);
  });

  it("falls back to the default Xcode when the Command Line Tools are selected", async () => {
    const app = await makeXcode(path.join(await tmpDir("xcode-"), "Xcode.app"), { version: "26.0", iosSdks: ["26.0"] });
    const { exec } = selectExec("/Library/Developer/CommandLineTools");
    const found = await probeXcodeSdks({ exec, platform: "darwin", defaultApp: app });
    assert.equal(found.version, "26.0");
    assert.equal(found.iosSdk, "26.0");
    assert.equal(found.simulatorSdk, null);
  });

  it("finds no Xcode off a Mac, or where there is none", async () => {
    const { ran, exec } = selectExec(null);
    const absent = { present: false, version: null, iosSdk: null, simulatorSdk: null, status: XcodeStatus.Absent };
    assert.deepEqual(await probeXcodeSdks({ exec, platform: "linux", defaultApp: "/nonexistent" }), absent);
    assert.deepEqual(ran, [], "nothing runs off a Mac");
    assert.deepEqual(await probeXcodeSdks({ exec, platform: "darwin", defaultApp: "/nonexistent/Xcode.app" }), absent);
  });

  describe("hostile layouts: a version or SDK reached through a link, or an unreadable plist, counts as none", () => {
    it("version.plist that is a link", async () => {
      const base = await tmpDir("xcode-");
      const app = path.join(base, "Xcode.app");
      await mkdir(path.join(app, "Contents"), { recursive: true });
      await writeFile(path.join(base, "fake.plist"), plist("26.6"));
      await symlink(path.join(base, "fake.plist"), path.join(app, "Contents", "version.plist"));
      const found = await probeXcodeSdks({ exec: selectExec(null).exec, platform: "darwin", defaultApp: app });
      assert.equal(found.present, false);
    });

    it("an SDK folder that is only a link (to a folder outside Xcode)", async () => {
      const base = await tmpDir("xcode-");
      const app = await makeXcode(path.join(base, "Xcode.app"), { version: "26.6" });
      const outside = path.join(base, "iPhoneOS26.5.sdk");
      await mkdir(outside);
      const sdks = path.join(app, "Contents", "Developer", "Platforms", "iPhoneOS.platform", "Developer", "SDKs");
      await symlink(outside, path.join(sdks, "iPhoneOS26.5.sdk"));
      const found = await probeXcodeSdks({ exec: selectExec(null).exec, platform: "darwin", defaultApp: app });
      assert.equal(found.iosSdk, null);
      assert.equal(found.status, XcodeStatus.IosSdkMissing);
    });

    it("an SDK link to a folder elsewhere inside the bundle, outside its SDKs folder", async () => {
      const app = await makeXcode(path.join(await tmpDir("xcode-"), "Xcode.app"), { version: "26.6" });
      const elsewhere = path.join(app, "Contents", "Resources", "planted.sdk");
      await mkdir(elsewhere, { recursive: true });
      const sdks = path.join(app, "Contents", "Developer", "Platforms", "iPhoneOS.platform", "Developer", "SDKs");
      await symlink(elsewhere, path.join(sdks, "iPhoneOS26.5.sdk"));
      const found = await probeXcodeSdks({ exec: selectExec(null).exec, platform: "darwin", defaultApp: app });
      assert.equal(found.iosSdk, null);
    });

    it("a plist with no readable version", async () => {
      const app = path.join(await tmpDir("xcode-"), "Xcode.app");
      await mkdir(path.join(app, "Contents"), { recursive: true });
      await writeFile(path.join(app, "Contents", "version.plist"), "<plist></plist>");
      const found = await probeXcodeSdks({ exec: selectExec(null).exec, platform: "darwin", defaultApp: app });
      assert.equal(found.present, true);
      assert.equal(found.version, null);
      assert.equal(found.status, XcodeStatus.TooOld);
    });
  });
});

describe("the iPhone build gate", () => {
  const none = { present: false, version: null, iosSdk: null, simulatorSdk: null };

  it("Xcode absent: xcode-missing for a device and a Simulator build", () => {
    assert.equal(deviceBuildRefusal(none), XcodeRefusal.XcodeMissing);
    assert.equal(simulatorBuildRefusal(none), XcodeRefusal.XcodeMissing);
  });

  it("Xcode 25: xcode-too-old for a device build, while a Simulator build still runs", () => {
    const xcode25 = { present: true, version: "25.4", iosSdk: "25.4", simulatorSdk: "25.4" };
    assert.equal(deviceBuildRefusal(xcode25), XcodeRefusal.XcodeTooOld);
    assert.equal(simulatorBuildRefusal(xcode25), null);
  });

  it("Xcode 26 without the iOS 26 SDK: ios-sdk-missing for a device build", () => {
    assert.equal(
      deviceBuildRefusal({ present: true, version: "26.1", iosSdk: null, simulatorSdk: "26.1" }),
      XcodeRefusal.IosSdkMissing,
    );
  });

  it("no Simulator SDK: simulator-sdk-missing for a Simulator build only", () => {
    const deviceOnly = { present: true, version: "26.6", iosSdk: "26.5", simulatorSdk: null };
    assert.equal(simulatorBuildRefusal(deviceOnly), XcodeRefusal.SimulatorSdkMissing);
    assert.equal(deviceBuildRefusal(deviceOnly), null);
  });

  it("Xcode 26.6 with iOS 26.5: both run", () => {
    const ready = { present: true, version: "26.6", iosSdk: "26.5", simulatorSdk: "26.5" };
    assert.equal(deviceBuildRefusal(ready), null);
    assert.equal(simulatorBuildRefusal(ready), null);
  });
});
