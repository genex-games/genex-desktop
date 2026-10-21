/**
 * The phones' contracts (M5.0): the mobile toolchain components and which of them the person
 * installs with the Android SDK licence, the Android API 36 and Xcode 26 pins, the Xcode probe's
 * status, the three mobile IPC channels' payloads and stub handlers, and the export-run dispatch's
 * iOS and Android entries, which the core binds to its phone services and the menu offers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exportAndroidGame } from "../../src/main/core/android-export-run.ts";
import { exportIosGame } from "../../src/main/core/ios-export-run.ts";
import { type ExportRunners, type MobileExportGameRequest, runExport } from "../../src/main/core/native-export-run.ts";
import { registerToolchainIpc } from "../../src/main/ipc/toolchain.ts";
import { ANDROID_API_LEVELS, IOS_DEPLOYMENT_TARGET } from "../../src/main/rust-build-mobile.ts";
import {
  EXPORT_RUNS,
  ExportError,
  ExportRefusal,
  ExportRun,
  ExportSigning,
  exportsTo,
  GpuQualification,
  MobileArtifact,
} from "../../src/shared/game-export-contract.ts";
import {
  BuildTarget,
  type ExportResult,
  type GameProject,
  GameStack,
  ProjectKind,
  type ProjectShape,
} from "../../src/shared/game-project.ts";
import {
  ANDROID_PINS,
  AndroidLicence,
  JDK_PIN,
  MOBILE_BUILD_TARGETS,
  parseAndroidLicence,
  RUST_MOBILE_COMPONENTS,
  ToolchainError,
  ToolchainId,
  ToolchainProblem,
  USER_SIDE_COMPONENTS,
  XCODE_PINS,
  XcodeStatus,
  xcodeStatusOf,
} from "../../src/shared/toolchain.ts";
import { RELEASE_URL_PREFIXES } from "../../src/substrate/toolchain-store/manifest.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { factsOfEngine } from "../../src/shared/project-facts.ts";

describe("the mobile toolchain components", () => {
  it("are appended after every older id, in their wire spellings", () => {
    // The crate checker's three ids (crate requests) follow the mobile ones, then libcolyseus's two
    // (MP-1a), then the web multiplayer bridge (MP-5a).
    const ids = Object.values(ToolchainId).slice(0, -6);
    assert.deepEqual(Object.values(ToolchainId).slice(-6), [
      "cargo-deny",
      "cargo-vet",
      "rustsec-advisory-db",
      "colyseus",
      "colyseus-source",
      "genex-mp-bridge",
    ]);
    assert.deepEqual(ids.slice(-8), [
      "android-sdk",
      "android-build-tools",
      "android-ndk",
      "bundletool",
      "jdk",
      "rust-std-ios",
      "rust-std-ios-sim",
      "rust-std-android",
    ]);
    assert.equal(ids.indexOf(ToolchainId.SwiftShaderLinux), ids.length - 9);
  });

  it("each phone needs its Rust standard libraries; Android also the SDK, build tools, NDK, bundletool and the JDK", () => {
    assert.deepEqual(RUST_MOBILE_COMPONENTS, {
      [BuildTarget.Ios]: [ToolchainId.RustStdIos, ToolchainId.RustStdIosSim],
      [BuildTarget.Android]: [
        ToolchainId.RustStdAndroid,
        ToolchainId.AndroidSdk,
        ToolchainId.AndroidBuildTools,
        ToolchainId.AndroidNdk,
        ToolchainId.Bundletool,
        ToolchainId.Jdk,
      ],
    });
  });

  it("the SDK, build tools and NDK are the person's own install with the licence: the store never downloads them", () => {
    assert.deepEqual(USER_SIDE_COMPONENTS, [
      ToolchainId.AndroidSdk,
      ToolchainId.AndroidBuildTools,
      ToolchainId.AndroidNdk,
    ]);
    for (const id of USER_SIDE_COMPONENTS) assert.deepEqual(RELEASE_URL_PREFIXES[id], [], id);
  });

  it("the JDK is Temurin 21 from Adoptium's releases (Q3 answered); bundletool and the Rust libraries from their publishers", () => {
    assert.deepEqual(JDK_PIN, { vendor: "temurin", feature: 21 });
    assert.deepEqual(RELEASE_URL_PREFIXES[ToolchainId.Jdk], [
      "https://github.com/adoptium/temurin21-binaries/releases/download/",
    ]);
    assert.deepEqual(RELEASE_URL_PREFIXES[ToolchainId.Bundletool], [
      "https://github.com/google/bundletool/releases/download/",
    ]);
    for (const id of [ToolchainId.RustStdIos, ToolchainId.RustStdIosSim, ToolchainId.RustStdAndroid])
      assert.deepEqual(RELEASE_URL_PREFIXES[id], ["https://static.rust-lang.org/dist/"], id);
  });
});

describe("the phone pins", () => {
  it("Android: platform android-36, build tools 36, compile and target SDK 36, minSdk 29, Vulkan 1.1 required", () => {
    assert.deepEqual(ANDROID_PINS, {
      platform: "android-36",
      buildToolsMajor: 36,
      compileSdk: 36,
      targetSdk: 36,
      minSdk: 29,
      ndk: "30.0.16248370",
      vulkanVersionFeature: 0x401000,
      gamesActivityAar: "4.4.0",
      androidActivityCrate: "0.6.1",
    });
    // VK_MAKE_API_VERSION(0, 1, 1, 0): what `android.hardware.vulkan.version` names for Vulkan 1.1.
    assert.equal(ANDROID_PINS.vulkanVersionFeature, (1 << 22) | (1 << 12));
    assert.equal(ANDROID_PINS.platform, `android-${ANDROID_PINS.compileSdk}`);
  });

  it("the Rust Android and iOS builds link at the pinned API levels and deployment target", () => {
    assert.deepEqual(ANDROID_API_LEVELS, {
      min: ANDROID_PINS.minSdk,
      target: ANDROID_PINS.targetSdk,
      compile: ANDROID_PINS.compileSdk,
    });
    assert.equal(IOS_DEPLOYMENT_TARGET, XCODE_PINS.deploymentTarget);
    assert.deepEqual(XCODE_PINS, { minMajor: 26, iosSdkMinMajor: 26, deploymentTarget: "16.0" });
  });
});

describe("the Xcode probe's status", () => {
  it("is ready only with Xcode 26 or later and an iOS 26 SDK; device and distribution builds need ready", () => {
    const rows: Array<[string, Parameters<typeof xcodeStatusOf>[0], XcodeStatus]> = [
      ["no Xcode", { present: false, version: null, iosSdk: null }, XcodeStatus.Absent],
      ["Xcode 16", { present: true, version: "16.4", iosSdk: "18.5" }, XcodeStatus.TooOld],
      ["a version nobody could read", { present: true, version: null, iosSdk: "26.5" }, XcodeStatus.TooOld],
      ["a version that is not a number", { present: true, version: "beta", iosSdk: "26.5" }, XcodeStatus.TooOld],
      ["Xcode 26 without an iOS SDK", { present: true, version: "26.6", iosSdk: null }, XcodeStatus.IosSdkMissing],
      ["Xcode 26 with an iOS 18 SDK", { present: true, version: "26.0", iosSdk: "18.5" }, XcodeStatus.IosSdkMissing],
      ["Xcode 26.6 with the iOS 26.5 SDK", { present: true, version: "26.6", iosSdk: "26.5" }, XcodeStatus.Ready],
      ["Xcode 27", { present: true, version: "27.0", iosSdk: "27.0" }, XcodeStatus.Ready],
    ];
    for (const [label, found, status] of rows) assert.equal(xcodeStatusOf(found), status, label);
    assert.deepEqual(Object.values(XcodeStatus), ["absent", "too-old", "ios-sdk-missing", "ready"]);
  });
});

/** The handlers `registerToolchainIpc` registers, by channel, over a core that is never reached. */
function toolchainHandlers(): Map<string, (payload: unknown) => unknown> {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const handle = (channel: string, listener: (payload: unknown) => unknown) => handlers.set(channel, listener);
  const unreachable = new Proxy(
    {},
    {
      get(_target, name) {
        throw new Error(`the core was reached: ${String(name)}`);
      },
    },
  );
  registerToolchainIpc(handle as never, { toolchains: unreachable, games: unreachable } as never);
  return handlers;
}

describe("the mobile IPC channels' payloads, and their handlers without a mobile source (a fixture profile)", () => {
  it("the licence payload names the Android SDK licence and nothing else", () => {
    assert.deepEqual(Object.values(AndroidLicence), ["android-sdk-license"]);
    assert.equal(parseAndroidLicence({ licence: AndroidLicence.Sdk }), AndroidLicence.Sdk);
    for (const value of [undefined, null, {}, { licence: "android-sdk-preview-license" }, { licence: 1 }, []])
      assert.throws(() => parseAndroidLicence(value), JSON.stringify(value) ?? "?");
  });

  it("installMobile checks its phone and, with no mobile source (fixture or smoke profile), installs nothing: not-hosted", async () => {
    const install = toolchainHandlers().get("studio:toolchain.installMobile");
    assert.ok(install);
    for (const target of MOBILE_BUILD_TARGETS)
      await assert.rejects(
        async () => install({ target }),
        (error: unknown) => error instanceof ToolchainError && error.problem === ToolchainProblem.NotHosted,
        target,
      );
    for (const payload of [undefined, {}, { target: BuildTarget.Mac }, { target: [BuildTarget.Ios] }])
      await assert.rejects(
        async () => install(payload),
        (error: unknown) => !(error instanceof ToolchainError),
        JSON.stringify(payload) ?? "?",
      );
  });

  it("acceptAndroidLicence records nothing with no mobile source (fixture or smoke profile), and refuses another licence", async () => {
    const accept = toolchainHandlers().get("studio:toolchain.acceptAndroidLicence");
    assert.ok(accept);
    await assert.rejects(async () => accept({ licence: AndroidLicence.Sdk }), /not available in this build/);
    await assert.rejects(async () => accept({ licence: "other" }), /licence/);
  });
});

/** A Rust game naming the browser and both phones, as the library lists it. */
function rustGame(): GameProject {
  return {
    name: "pond",
    title: "Pond",
    dir: "/x/games/pond",
    createdAt: "2026-10-07T00:00:00.000Z",
    pathLabel: "~/AI Games/pond",
    library: true,
    facts: factsOfEngine(GameEngine.Web),
    shape: { kind: ProjectKind.RustWgpu } as ProjectShape,
    built: false,
    destinations: { stack: GameStack.RustWgpu, targets: [BuildTarget.Web, BuildTarget.Ios, BuildTarget.Android] },
  };
}

/** Runners whose phone exports record the request they were handed. */
function phoneRunners(asked: MobileExportGameRequest[]): ExportRunners {
  const receipt = (request: MobileExportGameRequest): ExportResult => ({
    dir: request.targetDir,
    files: 1,
    included: [],
    excluded: [],
    destination: request.destination,
  });
  const none = async (): Promise<ExportResult> => assert.fail("not a phone export");
  return {
    browserFolder: none,
    compiledWeb: none,
    macApp: none,
    desktopArchive: none,
    iosApp: async (request) => {
      asked.push(request);
      return receipt(request);
    },
    androidPackage: async (request) => {
      asked.push(request);
      return receipt(request);
    },
  };
}

describe("the export-run dispatch's phone entries", () => {
  it("a Rust game's iOS and Android entries name their phone runs, which the menu offers", () => {
    assert.equal(EXPORT_RUNS[GameStack.RustWgpu][BuildTarget.Ios], ExportRun.IosApp);
    assert.equal(EXPORT_RUNS[GameStack.RustWgpu][BuildTarget.Android], ExportRun.AndroidPackage);
    // Flipped (M5.9): the core binds both runs, so the menu offers them.
    for (const target of MOBILE_BUILD_TARGETS) assert.equal(exportsTo(GameStack.RustWgpu, target), true, target);
  });

  it("the phone export modules refuse lane-missing without the core's services, before anything is built or written", async () => {
    // Flipped (M5.9): the dispatch always has both runners; a module handed no services still refuses.
    const runs = [exportIosGame, exportAndroidGame];
    for (const [index, destination] of MOBILE_BUILD_TARGETS.entries()) {
      const request: MobileExportGameRequest = {
        destination,
        game: rustGame(),
        targetDir: "/x/e",
        signing: { kind: destination === BuildTarget.Ios ? ExportSigning.AdHoc : ExportSigning.AndroidDebug },
        artifact: destination === BuildTarget.Ios ? MobileArtifact.SimulatorApp : MobileArtifact.ApkDev,
        person: true,
      };
      await assert.rejects(
        runs[index](request),
        (error: unknown) => error instanceof ExportError && error.code === ExportRefusal.LaneMissing,
        destination,
      );
    }
  });

  it("hands a phone run its destination, the default signing and the artifact that signing makes", async () => {
    const asked: MobileExportGameRequest[] = [];
    const runners = phoneRunners(asked);
    const game = rustGame();
    const ios = await runExport(runners, { game, destination: BuildTarget.Ios, targetDir: "/x/i", person: false });
    const android = await runExport(runners, {
      game,
      destination: BuildTarget.Android,
      targetDir: "/x/a",
      person: false,
    });
    assert.deepEqual(
      asked.map(({ destination, signing, artifact, person }) => ({ destination, signing, artifact, person })),
      [
        {
          destination: BuildTarget.Ios,
          signing: { kind: ExportSigning.AdHoc },
          artifact: MobileArtifact.SimulatorApp,
          person: false,
        },
        {
          destination: BuildTarget.Android,
          signing: { kind: ExportSigning.AndroidDebug },
          artifact: MobileArtifact.ApkDev,
          person: false,
        },
      ],
    );
    // A phone export's GPU path has not run on a real phone yet.
    assert.equal(ios.gpuQualification, GpuQualification.Untested);
    assert.equal(android.gpuQualification, GpuQualification.Untested);
  });
});
