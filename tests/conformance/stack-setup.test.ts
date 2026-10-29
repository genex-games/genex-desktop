/**
 * Per-stack setup (`shared/stack-setup.ts`): which destinations a stack's managed setup prepares
 * on each host, whether its lane runs there at all, and which separate prerequisites (Apple's
 * Command Line Tools or Xcode, the Android SDK with its licence accepted by a person, a JDK) a
 * set of destinations still lacks. The C++ · raylib rows are a characterization of
 * `cppSetupTargets`, which now reads the same table.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { cppSetupTargets } from "../../src/shared/cpp-setup.ts";
import { ALL_BUILD_TARGETS, BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import {
  EMPTY_PREREQUISITES,
  laneBuilderReady,
  laneRunsOn,
  missingPrerequisites,
  type SetupPrerequisites,
  SetupPrerequisite,
  setupTargets,
} from "../../src/shared/stack-setup.ts";
import { rustCrossPinned, ToolchainHost, toolchainHostOf } from "../../src/shared/toolchain.ts";

const HOSTS = [...Object.values(ToolchainHost), null] as const;
const present = { present: true, version: "1" } as const;

describe("what a stack's setup prepares on each host", () => {
  it("prepares nothing for Rust on an Intel Mac, which has no pinned toolchain host", () => {
    assert.deepEqual(setupTargets(GameStack.RustWgpu, toolchainHostOf("darwin", "x64")), []);
  });

  it("prepares Browser, Mac, Windows and Linux for Rust on an Apple-silicon Mac, Browser, Windows and Linux on Linux, nothing on Windows", () => {
    // Flipped (cross lanes pinned): the recipe pins the cross components, so both cross builders register.
    assert.deepEqual(setupTargets(GameStack.RustWgpu, ToolchainHost.MacArm64), [
      BuildTarget.Web,
      BuildTarget.Mac,
      BuildTarget.Windows,
      BuildTarget.Linux,
    ]);
    assert.deepEqual(setupTargets(GameStack.RustWgpu, ToolchainHost.WindowsX64), []);
    assert.deepEqual(setupTargets(GameStack.RustWgpu, ToolchainHost.LinuxX64), [
      BuildTarget.Web,
      BuildTarget.Windows,
      BuildTarget.Linux,
    ]);
  });

  it("offers a Rust cross destination exactly when the recipe pins its components", () => {
    for (const target of [BuildTarget.Windows, BuildTarget.Linux])
      assert.equal(laneBuilderReady(GameStack.RustWgpu, target), rustCrossPinned(target), target);
    for (const target of ALL_BUILD_TARGETS) assert.equal(laneBuilderReady(GameStack.RaylibCpp, target), true, target);
  });

  it("prepares the same raylib destinations as before on every host (characterization)", () => {
    assert.deepEqual(setupTargets(GameStack.RaylibCpp, ToolchainHost.MacArm64), [
      BuildTarget.Web,
      BuildTarget.Mac,
      BuildTarget.Windows,
      BuildTarget.Linux,
    ]);
    assert.deepEqual(setupTargets(GameStack.RaylibCpp, ToolchainHost.LinuxX64), [
      BuildTarget.Web,
      BuildTarget.Windows,
      BuildTarget.Linux,
    ]);
    assert.deepEqual(setupTargets(GameStack.RaylibCpp, ToolchainHost.WindowsX64), []);
    for (const host of HOSTS)
      assert.deepEqual(cppSetupTargets(host), setupTargets(GameStack.RaylibCpp, host), String(host));
  });

  it("prepares nothing for a Three.js game anywhere: it has no managed toolchain", () => {
    for (const host of HOSTS) assert.deepEqual(setupTargets(GameStack.ThreeJs, host), [], String(host));
  });

  it("runs a compiled lane on a Mac and Linux, never on Windows yet, and no lane for Three.js", () => {
    for (const stack of [GameStack.RaylibCpp, GameStack.RustWgpu]) {
      assert.equal(laneRunsOn(stack, StudioPlatform.Mac), true, stack);
      assert.equal(laneRunsOn(stack, StudioPlatform.Linux), true, stack);
      assert.equal(laneRunsOn(stack, StudioPlatform.Windows), false, stack);
      assert.equal(laneRunsOn(stack, "freebsd"), false, stack);
    }
    for (const platform of Object.values(StudioPlatform)) assert.equal(laneRunsOn(GameStack.ThreeJs, platform), false);
  });
});

describe("the separate prerequisites a set of destinations lacks", () => {
  it("asks for the Command Line Tools for Mac, Xcode for iOS, and the Android SDK, its licence and a JDK for Android", () => {
    assert.deepEqual(missingPrerequisites(EMPTY_PREREQUISITES, [BuildTarget.Mac]), [SetupPrerequisite.Clt]);
    assert.deepEqual(missingPrerequisites(EMPTY_PREREQUISITES, [BuildTarget.Ios]), [SetupPrerequisite.Xcode]);
    assert.deepEqual(missingPrerequisites(EMPTY_PREREQUISITES, [BuildTarget.Android]), [
      SetupPrerequisite.AndroidSdk,
      SetupPrerequisite.AndroidLicence,
      SetupPrerequisite.Jdk,
    ]);
    for (const target of [BuildTarget.Web, BuildTarget.Windows, BuildTarget.Linux])
      assert.deepEqual(missingPrerequisites(EMPTY_PREREQUISITES, [target]), [], target);
  });

  it("names each missing prerequisite once, in table order, whatever order the destinations come in", () => {
    const all = [BuildTarget.Android, BuildTarget.Ios, BuildTarget.Mac, BuildTarget.Mac];
    assert.deepEqual(missingPrerequisites(EMPTY_PREREQUISITES, all), Object.values(SetupPrerequisite));
  });

  it("an installed SDK still lacks the licence until a person accepts it", () => {
    const sdkOnly: SetupPrerequisites = {
      ...EMPTY_PREREQUISITES,
      android: { sdk: present, licenceAccepted: false, jdk: present },
    };
    assert.deepEqual(missingPrerequisites(sdkOnly, [BuildTarget.Android]), [SetupPrerequisite.AndroidLicence]);
    const accepted: SetupPrerequisites = { ...sdkOnly, android: { ...sdkOnly.android, licenceAccepted: true } };
    assert.deepEqual(missingPrerequisites(accepted, [BuildTarget.Android]), []);
  });

  it("Xcode stands in for the Command Line Tools, never the other way round", () => {
    const xcode: SetupPrerequisites = { ...EMPTY_PREREQUISITES, xcode: present };
    assert.deepEqual(missingPrerequisites(xcode, [BuildTarget.Mac, BuildTarget.Ios]), []);
    const clt: SetupPrerequisites = { ...EMPTY_PREREQUISITES, clt: present };
    assert.deepEqual(missingPrerequisites(clt, [BuildTarget.Mac, BuildTarget.Ios]), [SetupPrerequisite.Xcode]);
  });
});
