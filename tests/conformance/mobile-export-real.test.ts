/**
 * The phone exports end to end with the real toolchain (M5 integration):
 *
 * - iPhone: the Rust template built for `aarch64-apple-ios-sim` by the Rust lane under the real
 *   Seatbelt build sandbox (the Simulator lane the core holds: the Simulator triple and SDK from
 *   `mobileTargetSettings`), exported through `exportIosGame` over the core's services
 *   (`iosExportDeps`), packaged and signed ad hoc by `codesign` in a sandbox of its own, and
 *   checked by `codesign --verify`.
 * Each export admits its package into a phone package store of the test's own (the store the
 * person's device launch installs from), and the admitted digest is the exported package's.
 *
 * - Android (`ANDROID_HOME`; required under `GENEX_REQUIRE_TOOLCHAINS=1`): the template built for `aarch64-linux-android` by the
 *   lane with the NDK's clang and 16 KB pages, exported through `exportAndroidGame` over
 *   `androidExportDeps`: the person's Build-Tools and android-36 platform found by the SDK probe,
 *   the dev store's JDK and bundletool, a dev APK signed with a debug key made in the test's own
 *   folder (never `~/.android`), verified by `apksigner` and `zipalign -c -P 16`. The pinned NDK
 *   is r30; the newest installed NDK stands in (recorded deviation), named by the row.
 *
 * Nothing is installed or launched on a Simulator, emulator or device (containment stage 1).
 *
 * The toolchain is the dev store's pinned sysroot (`.studio-dev/spike-toolchain`, with the iOS
 * Simulator standard library) and the genex release's vendored crates, as `rust-lane-real.test.ts`
 * uses them; Xcode with an iOS Simulator SDK is the person's. Apple silicon only; without them the
 * row skips, and `GENEX_REQUIRE_TOOLCHAINS=1` turns the skip into a failure. A cold build compiles
 * the facade's dependency graph for the Simulator (minutes).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { exportAndroidGame } from "../../src/main/core/android-export-run.ts";
import { exportIosGame } from "../../src/main/core/ios-export-run.ts";
import { packageDigest, phonePackageStore } from "../../src/main/core/device-launch.ts";
import { androidExportDeps, iosExportDeps, type MobileExportServices } from "../../src/main/core/mobile-export-deps.ts";
import { rustPayloadDir, shippedRustStage } from "../../src/main/core/rust-lane.ts";
import { execHost } from "../../src/main/core/toolchains.ts";
import { RustBuilds, type RustToolchain, rustBuildSandboxes } from "../../src/main/rust-build.ts";
import { MobileBuild, mobileTargetSettings, RUST_MOBILE_BUILDERS } from "../../src/main/rust-build-mobile.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { DeviceKind } from "../../src/shared/device-launch.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { ExportSigning, MobileArtifact } from "../../src/shared/game-export-contract.ts";
import { BuildTarget, type GameProject, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { lockOf } from "../../src/substrate/toolchain-store/lock.ts";
import { probeAndroidSdk } from "../../src/substrate/toolchain-store/android-sdk.ts";
import { probeXcodeSdks } from "../../src/substrate/toolchain-store/xcode-probe.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TOOLCHAIN_DIR = process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev", "spike-toolchain");
const VENDOR_DIR = process.env.GENEX_RUST_VENDOR_DIR ?? path.join(REPO, ".studio-dev", "rust-release", "e2e", "vendor");
const WORKSPACE = path.join(REPO, "native", "genex-rust");
const TEMPLATE = path.join(REPO, "src", "game-template-rust");
const REQUIRED = process.env.GENEX_REQUIRE_TOOLCHAINS === "1";
/** A cold build compiles the facade's whole dependency graph twice (clippy, then the build). */
const COLD_BUILD_MS = 40 * MINUTE_MS;
const LOCK = lockOf({ rust: { version: "1.99.0", sha12: "000000000000" } });
const BUNDLE_ID = "games.genex.game.00000000a5e1";
const SIMULATOR_STD = path.join("sysroot", "lib", "rustlib", "aarch64-apple-ios-sim");
const ANDROID_STD = path.join("sysroot", "lib", "rustlib", "aarch64-linux-android");

/** Why the row cannot run here, or null. */
function absent(): string | null {
  if (process.platform !== "darwin" || process.arch !== "arm64") return "an Apple silicon Mac";
  for (const need of ["sysroot/bin/cargo", "sysroot/bin/cargo-clippy", SIMULATOR_STD])
    if (!existsSync(path.join(TOOLCHAIN_DIR, need))) return `the Rust toolchain (${path.join(TOOLCHAIN_DIR, need)})`;
  if (!existsSync(path.join(VENDOR_DIR, "genex-0.1.0"))) return `the release's vendored crates (${VENDOR_DIR})`;
  return null;
}

function needsToolchain(): { skip?: string } {
  const missing = absent();
  if (!missing) return {};
  if (REQUIRED) throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return { skip: `not run: ${missing} absent` };
}

/** The app's Rust payload as the core ships it: the workspace's lock line and the store's clippy.toml. */
async function payloadIn(resources: string): Promise<string> {
  const payload = rustPayloadDir(resources);
  await mkdir(payload, { recursive: true });
  for (const file of ["Cargo.lock", "clippy.toml"])
    await writeFile(path.join(payload, file), await readFile(path.join(WORKSPACE, file)));
  return payload;
}

/** The template as a created game made for the browser and both phones. */
async function templateGame(parent: string): Promise<GameProject> {
  const dir = path.join(parent, "pond");
  await cp(TEMPLATE, dir, { recursive: true });
  for (const file of [path.join(dir, "genex.toml"), path.join(dir, "src", "main.rs")])
    await writeFile(file, (await readFile(file, "utf8")).replaceAll("__GAME_TITLE__", "Pond"));
  return {
    name: "pond",
    dir,
    title: "Pond",
    shape: {
      entry: "index.html",
      main: "src/main.rs",
      build: null,
      install: null,
      own: false,
      kind: ProjectKind.RustWgpu,
      serve: ".",
    },
    destinations: { stack: GameStack.RustWgpu, targets: [BuildTarget.Web, BuildTarget.Ios, BuildTarget.Android] },
  } as unknown as GameProject;
}

/** The phone lanes as the core holds them, over the dev store's sysroot and the release's crates. */
async function phoneLane(
  root: string,
  home: string,
  options: { folder: string; ndk?: string; simulator?: boolean },
): Promise<RustBuilds> {
  const toolchainDir = realpathSync(TOOLCHAIN_DIR);
  const vendor = await realpath(VENDOR_DIR);
  const payload = await payloadIn(path.join(root, "resources"));
  const toolchain: RustToolchain = {
    bin: path.join(toolchainDir, "sysroot", "bin"),
    vendor,
    clippyConf: payload,
    reads: [toolchainDir, vendor, payload],
  };
  const settings = mobileTargetSettings(process.platform, execHost, {
    ...(options.simulator ? { ios: MobileBuild.IosSimulator } : {}),
    ...(options.ndk ? { ndk: async () => options.ndk ?? null } : {}),
  });
  const builders = options.simulator
    ? { [BuildTarget.Ios]: RUST_MOBILE_BUILDERS[MobileBuild.IosSimulator].lane }
    : { [BuildTarget.Android]: RUST_MOBILE_BUILDERS[MobileBuild.Android].lane };
  return new RustBuilds({
    root: path.join(root, "app-data", "rust-builds", options.folder),
    sandbox: rustBuildSandboxes({ secretPaths: [], enabled: true, denyRead: [os.homedir(), home] }),
    locate: async () => ({ ok: true, toolchain }),
    currentLock: async () => LOCK,
    stage: shippedRustStage(payload),
    emit: () => {},
    platform: process.platform,
    cores: 8,
    denyWrite: [],
    writeLock: async () => {},
    builders,
    targetSettings: (target) => settings(target),
  });
}

describe("the core's iPhone Simulator export with the real toolchain (macOS)", () => {
  it("builds the template on the Simulator lane, packages it and signs it ad hoc in codesign's sandbox", {
    ...needsToolchain(),
    timeout: 2 * COLD_BUILD_MS,
  }, async () => {
    const xcode = await probeXcodeSdks({ exec: execHost, platform: process.platform });
    if (xcode.simulatorSdk === null) {
      if (REQUIRED) assert.fail("GENEX_REQUIRE_TOOLCHAINS=1: Xcode with an iOS Simulator SDK absent");
      return;
    }
    const root = await realpath(await tmpDir("mobile-export-real-"));
    const games = path.join(root, "games");
    const exportsRoot = path.join(root, "exports");
    const stagingRoot = path.join(root, "export-staging");
    for (const dir of [games, exportsRoot, stagingRoot]) await mkdir(dir, { recursive: true, mode: 0o700 });
    const game = await templateGame(games);
    const lane = await phoneLane(root, games, { folder: "ios-simulator", simulator: true });
    const notImplemented = async (): Promise<never> => assert.fail("the Simulator export uses only its own lane");
    const services: MobileExportServices = {
      host: StudioPlatform.Mac,
      games: { bundleIdFor: async () => BUNDLE_ID },
      gameBuilds: { ensure: notImplemented },
      simulatorLane: lane,
      toolchains: { currentLock: async () => LOCK },
      xcode: async () => xcode,
      androidSdk: async () => null,
      storeTools: async () => null,
      notices: async () => ({ ok: true, notices: [] }),
      sandboxFor: (options) => ProcessSandbox.create(options),
      exportsRoot,
      stagingRoot,
      signingRoot: path.join(root, "signing"),
      secretPaths: [path.join(root, "secrets")],
      forbiddenRoots: [games],
      keyHome: path.join(root, "signing-keys", "android-debug"),
      home: root,
      env: {},
      secretValues: () => [],
      phonePackages: phonePackageStore(path.join(root, "phone-packages")),
    };
    const result = await exportIosGame(
      {
        destination: BuildTarget.Ios,
        game,
        targetDir: path.join(exportsRoot, "pond.ios"),
        signing: { kind: ExportSigning.AdHoc },
        artifact: MobileArtifact.SimulatorApp,
        person: false,
      },
      iosExportDeps(services),
    );
    assert.equal(result.destination, BuildTarget.Ios);
    const app = result.artifact ?? "";
    assert.ok(app.endsWith(".app"), app);
    await execFileAsync("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", app]);
    const { stdout: info } = await execFileAsync("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      path.join(app, "Info.plist"),
    ]);
    const parsed = JSON.parse(info) as Record<string, unknown>;
    assert.equal(parsed.CFBundleIdentifier, BUNDLE_ID);
    assert.deepEqual(parsed.CFBundleSupportedPlatforms, ["iPhoneSimulator"]);
    assert.equal(parsed.MinimumOSVersion, "16.0");
    const admitted = await phonePackageStore(path.join(root, "phone-packages")).digestOf(
      game.name,
      BuildTarget.Ios,
      DeviceKind.Simulator,
    );
    assert.equal(admitted, await packageDigest(app, BuildTarget.Ios), "the device launch installs the exported app");
  });
});

/** The person's SDK (`ANDROID_HOME`, opt-in) and its newest NDK, or why the Android row does not run. */
function androidHere(): { sdk: string; ndk: string } | string {
  const sdk = process.env.ANDROID_HOME;
  const why = absent();
  if (why) return why;
  if (!sdk || !existsSync(path.join(sdk, "ndk"))) return "ANDROID_HOME with an NDK";
  const newest = readdirSync(path.join(sdk, "ndk")).sort().at(-1);
  if (!newest) return "an installed NDK";
  for (const need of ["tools/jdk/Contents/Home/bin/java", "tools/bundletool/bundletool.jar", ANDROID_STD])
    if (!existsSync(path.join(TOOLCHAIN_DIR, need))) return `the dev store's ${need}`;
  return { sdk: realpathSync(sdk), ndk: realpathSync(path.join(sdk, "ndk", newest)) };
}

const android = androidHere();

describe("the core's Android export with the real toolchain (macOS, ANDROID_HOME)", () => {
  const skip = typeof android === "string" ? `not run: ${android} absent` : false;
  if (skip && REQUIRED) throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${android}`);

  it("builds the template on the Android lane and packages a dev APK signed with Studio's debug key", {
    skip,
    timeout: 2 * COLD_BUILD_MS,
  }, async () => {
    if (typeof android === "string") return;
    console.log(`NDK stand-in for the pinned r30: ${path.basename(android.ndk)}`);
    const root = await realpath(await tmpDir("mobile-export-android-real-"));
    const games = path.join(root, "games");
    const exportsRoot = path.join(root, "exports");
    const stagingRoot = path.join(root, "export-staging");
    for (const dir of [games, exportsRoot, stagingRoot]) await mkdir(dir, { recursive: true, mode: 0o700 });
    const game = await templateGame(games);
    const lane = await phoneLane(root, games, { folder: "android", ndk: android.ndk });
    const toolchainDir = realpathSync(TOOLCHAIN_DIR);
    const keyHome = path.join(root, "signing-keys", "android-debug");
    const services: MobileExportServices = {
      host: StudioPlatform.Mac,
      games: { bundleIdFor: async () => BUNDLE_ID },
      gameBuilds: {
        ensure: async (asked, target, purpose) => ({
          stack: GameStack.RustWgpu,
          target,
          purpose,
          refusal: null,
          outcome: await lane.ensure(asked, target, purpose),
        }),
      },
      simulatorLane: { ensure: async () => assert.fail("an Android export never builds the Simulator") },
      toolchains: { currentLock: async () => LOCK },
      xcode: async () => assert.fail("an Android export never asks Xcode"),
      androidSdk: () => probeAndroidSdk({ candidates: [android.sdk], forbiddenRoots: [], platform: process.platform }),
      storeTools: async () => ({
        java: path.join(toolchainDir, "tools", "jdk", "Contents", "Home", "bin", "java"),
        bundletool: path.join(toolchainDir, "tools", "bundletool", "bundletool.jar"),
        std: [],
      }),
      notices: async () => ({ ok: true, notices: [] }),
      sandboxFor: (options) => ProcessSandbox.create(options),
      exportsRoot,
      stagingRoot,
      signingRoot: path.join(root, "signing"),
      secretPaths: [path.join(root, "secrets"), keyHome],
      forbiddenRoots: [games],
      keyHome,
      home: root,
      env: {},
      secretValues: () => [],
      phonePackages: phonePackageStore(path.join(root, "phone-packages")),
    };
    const deps = androidExportDeps(services);
    const result = await exportAndroidGame(
      {
        destination: BuildTarget.Android,
        game,
        targetDir: path.join(exportsRoot, "pond.android"),
        signing: { kind: ExportSigning.AndroidDebug },
        artifact: MobileArtifact.ApkDev,
        person: false,
      },
      deps,
    );
    const apk = result.artifact ?? "";
    assert.ok(apk.endsWith("-debug.apk"), apk);
    const sdk = await probeAndroidSdk({ candidates: [android.sdk], forbiddenRoots: [], platform: process.platform });
    const buildTools = sdk?.buildTools?.dir ?? "";
    const env = { ...process.env, JAVA_HOME: path.join(toolchainDir, "tools", "jdk", "Contents", "Home") };
    await execFileAsync(path.join(buildTools, "zipalign"), ["-c", "-P", "16", "4", apk], { env });
    const verify = await execFileAsync(
      path.join(buildTools, "apksigner"),
      ["verify", "--min-sdk-version", "29", "--print-certs", apk],
      { env },
    );
    assert.match(verify.stdout, /CN=Genex Debug/);
    const store = phonePackageStore(path.join(root, "phone-packages"));
    const exported = await packageDigest(apk, BuildTarget.Android);
    for (const device of [DeviceKind.Emulator, DeviceKind.Phone])
      assert.equal(await store.digestOf(game.name, BuildTarget.Android, device), exported, device);
    const marker = JSON.parse(await readFile(path.join(exportsRoot, "pond.android", ".studio-export.json"), "utf8"));
    assert.equal(marker.artifact, MobileArtifact.ApkDev);
  });
});
