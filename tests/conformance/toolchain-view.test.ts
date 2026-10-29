/**
 * The Toolchain sheet and Settings → Toolchains per stack (`src/renderer/panels/toolchain-view.ts`):
 * a Rust · wgpu game reads its own components under its own lock, Apple's prerequisites as two rows
 * (the Command Line Tools, which Xcode also provides, and Xcode for iPhone and iPad), the harness
 * modules a Rust night refuses, and copy that never calls a Rust game's tools C++ tools. The sheet
 * itself is `.tsx`; `run-toolchain-ui.mjs` renders it.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  acceptAndroidLicenceFor,
  hostMobileToolchain,
  installMobileFor,
  type MobileToolchainSource,
  registerToolchainIpc,
} from "../../src/main/ipc/toolchain.ts";
import { assertNativeActionAllowed } from "../../src/main/dev/native-policy.ts";
import {
  ANDROID_SDK_LICENCE_SHA1,
  type AndroidSdkFound,
  AndroidSdkError,
  AndroidSdkRefusal,
} from "../../src/substrate/toolchain-store/android-sdk.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import {
  PhoneBlock,
  phoneBlockWords,
  phoneViews,
  phoneRowWords,
  missingForStack,
  prerequisiteRows,
  prerequisiteWords,
  rustSheetLines,
  sheetView,
  sheetWords,
} from "../../src/renderer/panels/toolchain-view.ts";
import { TOOLCHAIN_WORDS } from "../../src/renderer/words.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import { SetupPrerequisite, setupTargets } from "../../src/shared/stack-setup.ts";
import {
  ANDROID_PINS,
  AndroidLicence,
  type AndroidSetupStatus,
  STACK_REQUIRED_COMPONENTS,
  ToolchainError,
  ToolchainHost,
  ToolchainId,
  type ToolchainInstallJob,
  ToolchainInstallPhase,
  type ToolchainLock,
  ToolchainProblem,
  type ToolchainStatus,
  UserSideState,
  XcodeStatus,
} from "../../src/shared/toolchain.ts";
import { tmpDir } from "../helpers/tmp.ts";

const { RaylibCpp, RustWgpu } = GameStack;
/** What a Mac's Rust setup installs. Flipped (cross lanes pinned): Browser and Mac only before; Windows and Linux too now. */
const RUST_ALL: readonly ToolchainId[] = [
  ...new Set(
    [BuildTarget.Web, BuildTarget.Mac, BuildTarget.Windows, BuildTarget.Linux].flatMap(
      (target) => STACK_REQUIRED_COMPONENTS[RustWgpu][target],
    ),
  ),
];
const RUST_TARGETS = setupTargets(RustWgpu, ToolchainHost.MacArm64);

/** A lock naming `ids` at version 1. */
function lockOf(ids: readonly ToolchainId[]): ToolchainLock {
  const entries = Object.fromEntries(ids.map((id) => [id, { version: "1", sha12: "000000000000" }]));
  return { version: 1, entries, digest: "0".repeat(64) };
}

/**
 * A Mac's store holding `ids`, with the Command Line Tools and without Xcode unless said: `rustLock`
 * is the Rust stack's own current lock, `lock` stays raylib's.
 */
function mac(
  ids: readonly ToolchainId[],
  options: { clt?: boolean; xcode?: boolean; rustLock?: ToolchainLock | null; kept?: string[] } = {},
): ToolchainStatus {
  const { clt = true, xcode = false, rustLock = null, kept } = options;
  return {
    host: ToolchainHost.MacArm64,
    clt: { present: clt, version: clt ? "16.4" : null },
    xcode: { present: xcode, version: xcode ? "26.6" : null },
    installed: ids.map((id) => ({ id, version: "1", sha12: "000000000000", bytes: 1 })),
    lock: null,
    stackLocks: { [RustWgpu]: rustLock },
    job: null,
    storeBytes: 0,
    ...(kept ? { keptPreRust: kept } : {}),
  };
}

/** Every sentence the Rust sheet can show for `status`: its title, intro, rows and notes. */
function rustSheetText(status: ToolchainStatus): string[] {
  const words = sheetWords(RustWgpu);
  const rows = prerequisiteRows(status, RustWgpu).map((row) => prerequisiteWords(row, RustWgpu));
  const view = sheetView(status, null, RUST_TARGETS, RustWgpu);
  return [
    words.title,
    words.intro,
    words.unsupportedHost,
    ...rows.flatMap((row) => [row.name, row.detail]),
    ...view.components.map((id) => TOOLCHAIN_WORDS.component[id]),
    ...rustSheetLines(view),
  ];
}

describe("the Toolchain sheet for a Rust · wgpu game", () => {
  it("with the Command Line Tools and no Xcode, the Xcode row is missing, Mac builds are covered, and no line says C++", () => {
    const status = mac([], { clt: true, xcode: false });
    const rows = prerequisiteRows(status, RustWgpu);
    assert.deepEqual(
      rows.map((row) => [row.prerequisite, row.present]),
      [
        [SetupPrerequisite.Clt, true],
        [SetupPrerequisite.Xcode, false],
      ],
    );
    assert.equal(prerequisiteWords(rows[1], RustWgpu).detail, TOOLCHAIN_WORDS.xcode.missing);
    const text = rustSheetText(status);
    assert.ok(text.length > 0);
    for (const line of text) assert.doesNotMatch(line, /C\+\+/, line);
  });

  it("Xcode alone covers Mac builds: the Command Line Tools row reads as provided by Xcode", () => {
    const status = mac([], { clt: false, xcode: true });
    const [clt, xcode] = prerequisiteRows(status, RustWgpu);
    assert.equal(clt.present, true);
    assert.equal(xcode.present, true);
    assert.equal(prerequisiteWords(clt, RustWgpu).detail, TOOLCHAIN_WORDS.clt.viaXcode);
    assert.equal(missingForStack(status, [BuildTarget.Mac], RustWgpu).clt, false);
  });

  it("neither the tools nor Xcode: Mac builds miss Apple's tools", () => {
    const status = mac([], { clt: false, xcode: false });
    assert.equal(missingForStack(status, [BuildTarget.Mac], RustWgpu).clt, true);
    assert.equal(missingForStack(status, [BuildTarget.Web], RustWgpu).clt, false);
  });

  it("lists the Rust components it lacks, never a C++ one, even with every C++ tool installed", () => {
    const cpp = [ToolchainId.Cmake, ToolchainId.Ninja, ToolchainId.Emsdk, ToolchainId.RaylibSource];
    const view = sheetView(mac(cpp), null, RUST_TARGETS, RustWgpu);
    assert.deepEqual(view.components, RUST_ALL);
    assert.equal(view.ready, false);
  });

  it("is ready once every Rust component is in and the Rust lock names them, whatever raylib's lock says", () => {
    const status = mac(RUST_ALL, { rustLock: lockOf(RUST_ALL) });
    const view = sheetView(status, null, RUST_TARGETS, RustWgpu);
    assert.deepEqual(view.components, []);
    assert.equal(view.ready, true);
  });

  it("components on disk that no Rust lock names are not ready: a build locates with the lock", () => {
    const view = sheetView(mac(RUST_ALL, { rustLock: null }), null, RUST_TARGETS, RustWgpu);
    assert.equal(view.ready, false);
  });

  it("a Rust component at another version than the Rust lock names is missing", () => {
    const lock = lockOf(RUST_ALL);
    lock.entries[ToolchainId.Rust] = { version: "2", sha12: "000000000000" };
    assert.deepEqual(missingForStack(mac(RUST_ALL, { rustLock: lock }), RUST_TARGETS, RustWgpu).components, [
      ToolchainId.Rust,
    ]);
  });

  it("this version installs no Rust tools from the sheet: Install never offers, and the sheet says why", () => {
    const status = mac([]);
    const view = sheetView(status, null, RUST_TARGETS, RustWgpu);
    assert.equal(view.canInstall, false);
    assert.ok(rustSheetLines(view).includes(TOOLCHAIN_WORDS.rust.notInstalledHere));
  });

  it("names the harness modules a Rust night refuses, and nothing when there are none", () => {
    const kept = ["loop/judge.ts", "loop/review.ts"];
    const status = mac(RUST_ALL, { rustLock: lockOf(RUST_ALL), kept });
    const view = sheetView(status, null, RUST_TARGETS, RustWgpu);
    assert.deepEqual(view.keptPreRust, kept);
    assert.deepEqual(sheetView(mac([]), null, RUST_TARGETS, RustWgpu).keptPreRust, []);
  });
});

describe("the Toolchain sheet keeps its C++ words and rows for a C++ game", () => {
  it("a C++ sheet is titled for C++ games and lists only the Command Line Tools as Apple's prerequisite", () => {
    assert.equal(sheetWords(RaylibCpp).title, TOOLCHAIN_WORDS.title);
    assert.deepEqual(
      prerequisiteRows(mac([]), RaylibCpp).map((row) => row.prerequisite),
      [SetupPrerequisite.Clt],
    );
  });

  it("a C++ sheet never reads the Rust lock or the harness modules", () => {
    const status = mac([], { rustLock: lockOf(RUST_ALL), kept: ["loop/judge.ts"] });
    const view = sheetView(status, null, setupTargets(RaylibCpp, ToolchainHost.MacArm64));
    assert.deepEqual(view.keptPreRust, []);
    // Flipped (cross lanes pinned): zig and the Linux headers serve both stacks' Linux builds, so the row names the Rust-only ones.
    const cpp: readonly ToolchainId[] = Object.values(STACK_REQUIRED_COMPONENTS[RaylibCpp]).flat();
    const rustOnly = RUST_ALL.filter((id) => !cpp.includes(id));
    assert.ok(!view.components.some((id) => rustOnly.includes(id)));
  });

  it("the C++ sheet's Command Line Tools row reads the tools probe alone, as it always did", () => {
    const [clt] = prerequisiteRows(mac([], { clt: false, xcode: true }), RaylibCpp);
    assert.equal(clt.present, false);
  });
});

/** The person's Android SDK as the host probed it: every part at its pin, the licence not yet accepted unless said. */
function androidSetup(overrides: Partial<AndroidSetupStatus> = {}): AndroidSetupStatus {
  return {
    sdk: true,
    licenceAccepted: false,
    parts: {
      [ToolchainId.AndroidSdk]: UserSideState.Ready,
      [ToolchainId.AndroidBuildTools]: UserSideState.Ready,
      [ToolchainId.AndroidNdk]: UserSideState.OtherVersion,
    },
    ...overrides,
  };
}

/** A Mac with Xcode at `xcodeStatus` and the person's Android SDK as `android` says. */
function phoneMac(
  ids: readonly ToolchainId[],
  options: { xcodeStatus?: XcodeStatus; android?: AndroidSetupStatus; downloads?: readonly ToolchainId[] } = {},
): ToolchainStatus {
  const { xcodeStatus = XcodeStatus.Ready, android = androidSetup(), downloads = [] } = options;
  return {
    ...mac(ids, { xcode: xcodeStatus !== XcodeStatus.Absent }),
    xcode: { present: xcodeStatus !== XcodeStatus.Absent, version: "26.6", iosSdk: "26.5", status: xcodeStatus },
    android,
    downloads: downloads.map((id) => ({ id, version: "1", bytes: 40 * 1024 * 1024, diskBytes: 80 * 1024 * 1024 })),
  };
}

const IOS_STORE = [ToolchainId.RustStdIos, ToolchainId.RustStdIosSim];
const ANDROID_STORE = [ToolchainId.RustStdAndroid, ToolchainId.Bundletool, ToolchainId.Jdk];

describe("the Toolchain sheet's phone rows (M5.5)", () => {
  it("a Rust sheet on a Mac lists the iPhone's Rust rows and Android's SDK parts, NDK, Java runtime and bundletool", () => {
    const [ios, android, ...rest] = phoneViews(phoneMac([]), RustWgpu);
    assert.equal(rest.length, 0);
    assert.equal(ios?.target, BuildTarget.Ios);
    assert.deepEqual(
      ios?.rows.map((row) => row.id),
      IOS_STORE,
    );
    assert.equal(ios?.xcode, XcodeStatus.Ready);
    assert.equal(android?.target, BuildTarget.Android);
    assert.deepEqual(
      android?.rows.map((row) => [row.id, row.personSide, row.state]),
      [
        [ToolchainId.RustStdAndroid, false, UserSideState.Missing],
        [ToolchainId.AndroidSdk, true, UserSideState.Ready],
        [ToolchainId.AndroidBuildTools, true, UserSideState.Ready],
        [ToolchainId.AndroidNdk, true, UserSideState.OtherVersion],
        [ToolchainId.Bundletool, false, UserSideState.Missing],
        [ToolchainId.Jdk, false, UserSideState.Missing],
      ],
    );
  });

  it("a C++ sheet, a computer the host did not probe for Android, or no host lists no phone it cannot set up", () => {
    assert.deepEqual(phoneViews(phoneMac([]), RaylibCpp), []);
    const { android: _, ...unprobed } = phoneMac([]);
    assert.deepEqual(
      phoneViews(unprobed, RustWgpu).map((view) => view.target),
      [BuildTarget.Ios],
    );
    assert.deepEqual(phoneViews({ ...phoneMac([]), host: null }, RustWgpu), []);
    const linux = { ...phoneMac([]), host: ToolchainHost.LinuxX64 };
    assert.deepEqual(
      phoneViews(linux, RustWgpu).map((view) => view.target),
      [BuildTarget.Android],
      "iPhone builds need a Mac",
    );
  });

  it("the licence control shows only for a found SDK whose licence is not accepted; Android's install waits for it", () => {
    const view = (android: AndroidSetupStatus, downloads: readonly ToolchainId[] = ANDROID_STORE) =>
      phoneViews(phoneMac([], { android, downloads }), RustWgpu).find((each) => each.target === BuildTarget.Android);
    const noSdk = view(androidSetup({ sdk: false }));
    assert.deepEqual([noSdk?.licence.offered, noSdk?.canInstall, noSdk?.block], [false, false, PhoneBlock.SdkMissing]);
    const unaccepted = view(androidSetup());
    assert.deepEqual(
      [unaccepted?.licence.offered, unaccepted?.canInstall, unaccepted?.block],
      [true, false, PhoneBlock.Licence],
    );
    const accepted = view(androidSetup({ licenceAccepted: true }));
    assert.deepEqual([accepted?.licence.offered, accepted?.canInstall, accepted?.block], [false, true, null]);
    const unpublished = view(androidSetup({ licenceAccepted: true }), []);
    assert.deepEqual([unpublished?.canInstall, unpublished?.block], [false, PhoneBlock.NotPublished]);
    const said = [noSdk, unaccepted, accepted, unpublished].map((each) => (each ? phoneBlockWords(each) : undefined));
    const { phones } = TOOLCHAIN_WORDS;
    assert.deepEqual(said, [phones.sdkMissing, phones.licenceNeeded, null, phones.notPublished]);
  });

  it("the iPhone's install waits for Xcode 26 with its iOS SDK, and is ready once its Rust libraries are in", () => {
    const ios = (status: ToolchainStatus) => phoneViews(status, RustWgpu)[0];
    for (const xcodeStatus of [XcodeStatus.Absent, XcodeStatus.TooOld, XcodeStatus.IosSdkMissing]) {
      const view = ios(phoneMac([], { xcodeStatus, downloads: IOS_STORE }));
      assert.deepEqual([view?.canInstall, view?.block], [false, PhoneBlock.Xcode], xcodeStatus);
      assert.equal(view && phoneBlockWords(view), TOOLCHAIN_WORDS.phones.xcode[xcodeStatus], "Xcode's own line");
    }
    assert.equal(ios(phoneMac([], { downloads: IOS_STORE }))?.canInstall, true);
    const running: ToolchainInstallJob = {
      phase: ToolchainInstallPhase.Downloading,
      entry: null,
      completed: 0,
      total: 1,
      startedAt: "2026-10-07T00:00:00.000Z",
    };
    const busy = phoneViews({ ...phoneMac([], { downloads: IOS_STORE }), job: running }, RustWgpu)[0];
    assert.equal(busy?.canInstall, false, "never while an install runs");
    const done = ios(phoneMac(IOS_STORE));
    assert.deepEqual([done?.ready, done?.canInstall], [true, false]);
  });

  it("a row says its size, that Android's own installer fetches a person-side part, or which version is there", () => {
    const views = phoneViews(phoneMac([], { downloads: [ToolchainId.RustStdIos] }), RustWgpu);
    const detail = (id: ToolchainId) => {
      const row = views.flatMap((view) => view.rows).find((each) => each.id === id);
      assert.ok(row, id);
      return phoneRowWords(row).detail;
    };
    assert.equal(detail(ToolchainId.RustStdIos), TOOLCHAIN_WORDS.size(40 * 1024 * 1024));
    assert.equal(detail(ToolchainId.RustStdIosSim), TOOLCHAIN_WORDS.unavailable);
    assert.equal(
      detail(ToolchainId.AndroidNdk),
      TOOLCHAIN_WORDS.phones.userSide[UserSideState.OtherVersion](ANDROID_PINS.ndk),
    );
    assert.ok(detail(ToolchainId.AndroidNdk).includes(ANDROID_PINS.ndk));
    assert.equal(detail(ToolchainId.Jdk), TOOLCHAIN_WORDS.unavailable);
    for (const row of views.flatMap((view) => view.rows)) assert.doesNotMatch(phoneRowWords(row).name, /C\+\+/);
  });
});

describe("the Android licence and the phones' installs are the person's", () => {
  it("no harness host method reaches the toolchain, and both channels are refused in a fixture profile", () => {
    assert.ok(!Object.values(HostMethod).some((method) => method.startsWith("toolchain.")));
    for (const channel of ["studio:toolchain.acceptAndroidLicence", "studio:toolchain.installMobile"] as const) {
      assert.throws(() => assertNativeActionAllowed(true, channel), channel);
      assert.doesNotThrow(() => assertNativeActionAllowed(false, channel));
    }
  });
});

/** An SDK found at `root`, its licence accepted or not. */
function sdkAt(root: string, licenceAccepted: boolean): AndroidSdkFound {
  return {
    root,
    licenceAccepted,
    platformJar: null,
    platforms: [],
    buildTools: null,
    buildToolsVersions: [],
    ndk: null,
    ndkVersions: [],
    sdkmanager: null,
  };
}

/** Xcode 26.6 with the iOS 26.5 SDK, as the probe reads it. */
const XCODE_READY = { present: true, version: "26.6", iosSdk: "26.5", simulatorSdk: "26.5", status: XcodeStatus.Ready };
/** An `xcode-select` that names no Xcode. */
const NO_XCODE = async () => ({ code: 2, stdout: "", stderr: "" });

/** A mobile source over `sdk` whose install and licence record count their calls. */
function countingSource(sdk: AndroidSdkFound | null) {
  const calls = { install: 0, record: 0 };
  const source: MobileToolchainSource = {
    xcode: async () => XCODE_READY,
    androidSdk: async () => sdk,
    recordLicence: async () => {
      calls.record += 1;
    },
    install: async () => {
      calls.install += 1;
      return { phase: ToolchainInstallPhase.Preflight, entry: null, completed: 0, total: 1, startedAt: "now" };
    },
  };
  return { calls, source };
}

const sdkRefusal = (code: AndroidSdkRefusal) => (error: unknown) =>
  error instanceof AndroidSdkError && error.code === code;

describe("studio:toolchain.installMobile and acceptAndroidLicence", () => {
  it("installMobile refuses licence-not-accepted, typed, before anything installs or downloads", async () => {
    const { calls, source } = countingSource(sdkAt("/x/sdk", false));
    await assert.rejects(
      installMobileFor(source, BuildTarget.Android),
      sdkRefusal(AndroidSdkRefusal.LicenceNotAccepted),
    );
    const missing = countingSource(null);
    await assert.rejects(
      installMobileFor(missing.source, BuildTarget.Android),
      sdkRefusal(AndroidSdkRefusal.SdkMissing),
    );
    assert.deepEqual([calls.install, missing.calls.install], [0, 0], "nothing installed or downloaded");
  });

  it("with the licence accepted, Android's install goes to the store; the iPhone's never waits on Android's licence", async () => {
    const { calls, source } = countingSource(sdkAt("/x/sdk", true));
    assert.equal((await installMobileFor(source, BuildTarget.Android)).phase, ToolchainInstallPhase.Preflight);
    const ios = countingSource(null);
    await installMobileFor(ios.source, BuildTarget.Ios);
    assert.deepEqual([calls.install, ios.calls.install], [1, 1]);
  });

  it("acceptAndroidLicence records the licence in the person's own SDK, once; without an SDK it records nothing", async () => {
    const home = await tmpDir("android-home-");
    const sdk = path.join(home, "sdk");
    await mkdir(path.join(sdk, "platforms"), { recursive: true });
    const source = hostMobileToolchain({
      env: { ANDROID_HOME: sdk },
      exec: NO_XCODE,
      home,
      platform: "darwin",
      protectedPaths: [],
    });
    assert.equal((await source.androidSdk())?.licenceAccepted, false);
    assert.equal(await acceptAndroidLicenceFor(source, AndroidLicence.Sdk), true);
    assert.equal(await acceptAndroidLicenceFor(source, AndroidLicence.Sdk), true);
    const record = await readFile(path.join(sdk, "licenses", AndroidLicence.Sdk), "utf8");
    assert.equal(record, `${ANDROID_SDK_LICENCE_SHA1}\n`, "the hash once");
    assert.equal((await source.androidSdk())?.licenceAccepted, true);
    // With the licence accepted, the store still has no published download of the phones' parts.
    await assert.rejects(
      installMobileFor(source, BuildTarget.Android),
      (error: unknown) => error instanceof ToolchainError && error.problem === ToolchainProblem.NotHosted,
    );
    const { calls, source: none } = countingSource(null);
    await assert.rejects(acceptAndroidLicenceFor(none, AndroidLicence.Sdk), sdkRefusal(AndroidSdkRefusal.SdkMissing));
    assert.equal(calls.record, 0);
  });

  it("no SDK is taken from in or around one of Studio's protected paths: nothing is read or recorded there", async () => {
    const home = await tmpDir("android-protected-");
    const genex = path.join(home, ".genex");
    const keyHome = path.join(home, "userData", "signing-keys", "android-debug");
    const rows: Array<[string, string]> = [
      ["an SDK holding ~/.genex", home],
      ["an SDK inside Studio's debug key folder", path.join(keyHome, "sdk")],
      ["an SDK holding the debug key folder", path.join(home, "userData")],
    ];
    for (const [label, sdk] of rows) {
      await mkdir(path.join(sdk, "platforms"), { recursive: true });
      const source = hostMobileToolchain({
        env: { ANDROID_HOME: sdk },
        exec: NO_XCODE,
        home: path.join(home, "person"),
        platform: "darwin",
        protectedPaths: [genex, keyHome],
      });
      await mkdir(genex, { recursive: true });
      await mkdir(keyHome, { recursive: true });
      assert.equal(await source.androidSdk(), null, label);
      await assert.rejects(
        acceptAndroidLicenceFor(source, AndroidLicence.Sdk),
        sdkRefusal(AndroidSdkRefusal.SdkMissing),
      );
      assert.equal(
        await readFile(path.join(sdk, "licenses", AndroidLicence.Sdk), "utf8").catch(() => null),
        null,
        label,
      );
    }
  });

  it("the status carries the SDK's parts and whether its licence is accepted, never its path", async () => {
    const home = await tmpDir("android-status-");
    const sdk = path.join(home, "Library", "Android", "sdk");
    await mkdir(path.join(sdk, "platforms", ANDROID_PINS.platform), { recursive: true });
    await writeFile(path.join(sdk, "platforms", ANDROID_PINS.platform, "android.jar"), "jar");
    const handlers = new Map<string, (payload: unknown) => unknown>();
    const handle = (channel: string, listener: (payload: unknown) => unknown) => handlers.set(channel, listener);
    const core = {
      toolchains: { status: async () => mac([]), plan: async () => ({}) },
      games: { nativeLocks: async () => [] },
    };
    registerToolchainIpc(
      handle as never,
      core as never,
      undefined,
      hostMobileToolchain({ env: {}, exec: NO_XCODE, home, platform: "darwin", protectedPaths: [] }),
    );
    const status = (await handlers.get("studio:toolchain.status")?.(undefined)) as ToolchainStatus;
    assert.deepEqual(status.android, {
      sdk: true,
      licenceAccepted: false,
      parts: {
        [ToolchainId.AndroidSdk]: UserSideState.Ready,
        [ToolchainId.AndroidBuildTools]: UserSideState.Missing,
        [ToolchainId.AndroidNdk]: UserSideState.Missing,
      },
    });
    assert.ok(!JSON.stringify(status).includes(home), "no path reaches the window");
  });

  it("the status carries Xcode's iOS SDK and status from the phones' probe; a failed probe keeps the plain one", async () => {
    const statusOf = async (source: MobileToolchainSource) => {
      const handlers = new Map<string, (payload: unknown) => unknown>();
      const handle = (channel: string, listener: (payload: unknown) => unknown) => handlers.set(channel, listener);
      const core = {
        toolchains: { status: async () => mac([], { xcode: true }), plan: async () => ({}) },
        games: { nativeLocks: async () => [] },
      };
      registerToolchainIpc(handle as never, core as never, undefined, source);
      return (await handlers.get("studio:toolchain.status")?.(undefined)) as ToolchainStatus;
    };
    const { source } = countingSource(null);
    const probed = await statusOf(source);
    assert.deepEqual(probed.xcode, { present: true, version: "26.6", iosSdk: "26.5", status: XcodeStatus.Ready });
    assert.equal(probed.android?.sdk, false, "no SDK found");
    const failing = await statusOf({ ...source, xcode: async () => Promise.reject(new Error("probe failed")) });
    assert.equal(failing.xcode?.present, true);
    assert.equal(failing.xcode?.status, undefined);
  });
});
