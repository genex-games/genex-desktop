/**
 * The phone exports' services as the core binds them (M5 integration): the iPhone export's
 * {@link IosExportDeps} and the Android export's {@link AndroidExportDeps} over the Rust lane, the
 * lane building the iPhone Simulator triple, the person's Xcode and Android SDK, the store's JDK
 * and bundletool, Studio's per-profile debug key and the signer's own sandboxes.
 *
 * Every tool runs in a sandbox of its own (`codesign`, `aapt2`, `zipalign`, `apksigner`,
 * `bundletool`, `jarsigner`), over a host-staged copy of the lane's admitted `out/`. Nothing here
 * launches a Simulator, an emulator or a device: exporting builds and packages (containment stage 1).
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { StudioPlatform } from "../../shared/boot.ts";
import { ExportError, ExportRefusal } from "../../shared/game-export-contract.ts";
import { DeviceKind } from "../../shared/device-launch.ts";
import { BuildTarget, destinationsOf, type GameProject, GameStack } from "../../shared/game-project.ts";
import type { MobileBuildTarget, ToolchainLock } from "../../shared/toolchain.ts";
import type { AndroidPackageTools, AndroidToolSandbox } from "../../substrate/android-package.ts";
import type { IosSigner } from "../../substrate/ios-package.ts";
import { type MobileSignSandbox, mobileSignSandboxOptions } from "../../substrate/mobile-sign.ts";
import type { MacNotice } from "../../substrate/native-export.ts";
import type { RustNotices } from "../../substrate/rust-notices.ts";
import type { RunRequest, RunResult, SandboxOptions } from "../../substrate/spawn.ts";
import {
  type AndroidSdkFound,
  androidCredentialHomes,
  androidSdkCandidates,
  probeAndroidSdk,
} from "../../substrate/toolchain-store/android-sdk.ts";
import {
  locateMobileStoreTools,
  type MobileStoreTools,
  type XcodeExec,
} from "../../substrate/toolchain-store/locate.ts";
import { probeXcodeSdks, type XcodeSdks } from "../../substrate/toolchain-store/xcode-probe.ts";
import { CppBuildPurpose } from "../cpp-build.ts";
import type { GameBuildLane, GameBuildLanes } from "../game-build.ts";
import { admittedBuildLock } from "../rust-build.ts";
import { MobileBuild } from "../rust-build-mobile.ts";
import type { AndroidExportDeps } from "./android-export-run.ts";
import type { PhonePackageStore } from "./device-launch.ts";
import { isFixtureStore, rustExportNotices } from "./rust-lane.ts";
import type { IosBuild, IosExportDeps } from "./ios-export-run.ts";
import type { ToolchainService } from "./toolchains.ts";

const MESSAGE = {
  notices: (refusal: string, detail: string) =>
    `The Android package's licence notices could not be made (${refusal}): ${detail}`,
} as const;

/** The JDK's home inside its `java` executable's path: `<home>/bin/java`. */
const JAVA_IN_HOME = ["bin", "java"] as const;

/** A sandbox one packaging or signing tool gets to itself for one run. */
export type MobileToolSandbox = AndroidToolSandbox;

/** What the phone exports reach of the core, injected. */
export interface MobileExportServices {
  /** This host, or null on a platform the studio does not build for. */
  host: StudioPlatform | null;
  /** The game's once-chosen bundle id. */
  games: { bundleIdFor(name: string): Promise<string> };
  /** The build-lane seam: the Rust lane's iPhone device build and its Android build. */
  gameBuilds: Pick<GameBuildLanes, "ensure">;
  /** The lane building the iPhone Simulator triple (`aarch64-apple-ios-sim`). */
  simulatorLane: Pick<GameBuildLane, "ensure">;
  toolchains: Pick<ToolchainService, "currentLock">;
  /** The person's Xcode (`probeXcodeSdks`). */
  xcode(): Promise<XcodeSdks>;
  /** The person's Android SDK (`probeAndroidSdk`), or null when none is found. */
  androidSdk(): Promise<AndroidSdkFound | null>;
  /**
   * The store's phone tools at `lock`, the Rust lock the game builds on (`locateMobileStoreTools`);
   * null when any is missing. A null `lock` is the store's current Rust lock.
   */
  storeTools(target: MobileBuildTarget, lock: ToolchainLock | null): Promise<MobileStoreTools | null>;
  /**
   * The export's notices for the admitted build's `Cargo.lock` (`buildLock`), read from the vendored
   * set and sysroot of `lock`, the toolchain lock the game was built on (`rustExportNotices`).
   */
  notices(target: MobileBuildTarget, buildLock: string, lock: ToolchainLock | null): Promise<RustNotices>;
  sandboxFor(options: SandboxOptions): Promise<MobileToolSandbox>;
  /** `layout.exports`. */
  exportsRoot: string;
  /** `layout.exportStaging`: host-only, on the exports' volume. */
  stagingRoot: string;
  /** `layout.signing`: the host-private folder each signer's scratch is made in. */
  signingRoot: string;
  /** The studio's protected paths (Studio's debug key folder among them). */
  secretPaths: readonly string[];
  /** Folders no packaging or signing tool writes, and no keystore or profile may come from. */
  forbiddenRoots: readonly string[];
  /** Studio's per-profile Android debug key folder (`<userData>/signing-keys/android-debug`). */
  keyHome: string;
  /** The person's home. */
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Values no exported file may hold (`StudioCore.knownSecretValues`). */
  secretValues(): string[];
  /** The host's store of admitted phone packages the person's device launch installs from. */
  phonePackages: Pick<PhonePackageStore, "admit">;
}

/** The game's own Rust lock: its recorded one while the store keeps it, else the current one. */
function gameLock(services: MobileExportServices, game: GameProject): Promise<ToolchainLock | null> {
  return services.toolchains.currentLock(GameStack.RustWgpu, game.name);
}

/** The game as the lane builds it for an export, at its own Rust lock ({@link gameLock}). */
async function laneGame(services: MobileExportServices, game: GameProject) {
  const lock = await gameLock(services, game);
  const { name: project, dir, shape } = game;
  return { project, dir, shape, destinations: destinationsOf(game), lock };
}

/**
 * The lane's admitted iPhone build for `build`: the Simulator's on the Simulator lane, a device's
 * through the seam (purpose `export`); null when it failed or left no receipt.
 */
async function iosBuild(
  services: MobileExportServices,
  game: GameProject,
  build: MobileBuild,
): Promise<IosBuild | null> {
  const asked = await laneGame(services, game);
  const outcome =
    build === MobileBuild.IosSimulator
      ? await services.simulatorLane.ensure(asked, BuildTarget.Ios, CppBuildPurpose.Export)
      : (await services.gameBuilds.ensure(asked, BuildTarget.Ios, CppBuildPurpose.Export)).outcome;
  const outputs = outcome?.rust?.receipt?.outputs;
  if (!outcome?.ok || !outcome.output || !outputs) return null;
  return { out: outcome.output, outputs, buildLock: admittedBuildLock(outcome.output) };
}

/**
 * One signer run in a sandbox of its own: it writes only the run's staging folder, with a private
 * scratch in the host's signing folder, every studio secret denied.
 */
async function signerRun(services: MobileExportServices, request: RunRequest): Promise<RunResult> {
  await mkdir(services.signingRoot, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(path.join(services.signingRoot, "scratch-"));
  try {
    const staging = request.cwd ?? services.stagingRoot;
    const options = mobileSignSandboxOptions({
      staging,
      scratch,
      secretPaths: services.secretPaths,
      denyWrite: services.forbiddenRoots,
    });
    const sandbox = await services.sandboxFor(options);
    try {
      return await sandbox.run(request);
    } finally {
      await sandbox.dispose();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The iPhone export's services over the core's own (`exportIosGame`). */
export function iosExportDeps(services: MobileExportServices): IosExportDeps {
  const sandbox: MobileSignSandbox = { run: (request) => signerRun(services, request) };
  const signer: IosSigner = { sandbox, forbiddenRoots: services.forbiddenRoots, home: services.home };
  return {
    host: services.host,
    games: services.games,
    build: (game, build) => iosBuild(services, game, build),
    xcode: () => services.xcode(),
    // The notices come from the lock the game was built on, so they name the crates it shipped.
    notices: async (game, built) => services.notices(BuildTarget.Ios, built.buildLock, await gameLock(services, game)),
    signer,
    stagingRoot: services.stagingRoot,
    exportsRoot: services.exportsRoot,
    secretValues: () => services.secretValues(),
    admitSimulatorApp: (project, app) =>
      services.phonePackages.admit(project, BuildTarget.Ios, [DeviceKind.Simulator], app),
  };
}

/**
 * The Android packaging tools on this host: Build-Tools and the pinned platform from the person's
 * SDK, the JDK and bundletool from the store at `lock` (the game's own Rust lock; null, the current
 * one); null when any is missing (the export refuses `toolchain-unusable` before anything is built).
 */
export async function androidPackageTools(
  services: MobileExportServices,
  lock: ToolchainLock | null = null,
): Promise<AndroidPackageTools | null> {
  const [sdk, store] = await Promise.all([
    services.androidSdk().catch(() => null),
    services.storeTools(BuildTarget.Android, lock).catch(() => null),
  ]);
  const buildTools = sdk?.buildTools?.dir;
  if (!buildTools || !sdk?.platformJar || !store?.java || !store.bundletool) return null;
  return {
    aapt2: path.join(buildTools, "aapt2"),
    zipalign: path.join(buildTools, "zipalign"),
    apksigner: path.join(buildTools, "apksigner"),
    androidJar: sdk.platformJar,
    javaHome: javaHomeOf(store.java),
    bundletoolJar: store.bundletool,
  };
}

/** The JDK home a `java` executable sits in (`<home>/bin/java`). */
function javaHomeOf(java: string): string {
  return path.resolve(java, ...JAVA_IN_HOME.map(() => ".."));
}

/** The Android export's notices at the game's own Rust lock, refused `missing-notice` when a licence text is missing. */
async function androidNotices(services: MobileExportServices, game: GameProject, output: string): Promise<MacNotice[]> {
  const notices = await services.notices(
    BuildTarget.Android,
    admittedBuildLock(output),
    await gameLock(services, game),
  );
  if (!notices.ok) throw new ExportError(ExportRefusal.MissingNotice, MESSAGE.notices(notices.refusal, notices.detail));
  return notices.notices;
}

/**
 * The Android export's services over the core's own (`exportAndroidGame`); none on a host the
 * studio does not build for, where the export refuses `lane-missing` before anything runs.
 */
export function androidExportDeps(services: MobileExportServices): AndroidExportDeps | undefined {
  const { host } = services;
  if (host === null) return undefined;
  return {
    gameBuilds: services.gameBuilds,
    toolchains: services.toolchains,
    games: services.games,
    tools: async (game) => androidPackageTools(services, await gameLock(services, game)),
    notices: (game, output) => androidNotices(services, game, output),
    packaging: {
      sandboxFor: (options) => services.sandboxFor(options),
      stagingRoot: services.stagingRoot,
      secretPaths: services.secretPaths,
      denyWrite: services.forbiddenRoots,
      signer: {
        host,
        home: services.home,
        env: services.env,
        forbiddenRoots: services.forbiddenRoots,
        keyHome: services.keyHome,
      },
    },
    secretValues: () => services.secretValues(),
    exportsRoot: services.exportsRoot,
    admitDevApk: (project, apk) =>
      services.phonePackages.admit(project, BuildTarget.Android, [DeviceKind.Emulator, DeviceKind.Phone], apk),
  };
}

/** What the host's phone probes read: the store, this platform, the person's home and environment. */
export interface HostPhoneProbeInput {
  /** The profile's toolchain store (`layout.toolchains`). */
  store: string;
  platform: NodeJS.Platform;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Runs `xcode-select -p` outside every sandbox, never a shim that opens Apple's installer. */
  exec: XcodeExec;
  /** The store's current Rust lock: the phone tools' lock when the export names none. */
  currentLock(): Promise<ToolchainLock | null>;
  /** Studio's protected paths (`~/.genex`, the secrets, Studio's debug key folder): no SDK is taken from one. */
  protectedPaths: readonly string[];
}

/**
 * The person's Android SDK where `ANDROID_HOME`, `ANDROID_SDK_ROOT` or Android Studio keep it,
 * never one in or around a credential home (`~/.android`) or one of Studio's protected paths: the
 * SDK found here grants its NDK and Build-Tools as readable roots to the lane's and the packaging
 * tools' sandboxes.
 */
export function hostAndroidSdk(input: Pick<HostPhoneProbeInput, "platform" | "home" | "env" | "protectedPaths">) {
  return () =>
    probeAndroidSdk({
      candidates: androidSdkCandidates(input.env, input.home, input.platform),
      forbiddenRoots: [...androidCredentialHomes(input.home, input.env), ...input.protectedPaths],
      platform: input.platform,
    });
}

/**
 * The phone exports' probes over this host: the Xcode probe, the person's Android SDK, the store's
 * phone tools at the game's Rust lock, and the notices from the admitted build's lock and the
 * game's Rust lock (none over a development fixture's stand-in store, which holds no licence texts).
 */
export function hostPhoneProbes(
  input: HostPhoneProbeInput,
): Pick<MobileExportServices, "xcode" | "androidSdk" | "storeTools" | "notices"> {
  return {
    xcode: () => probeXcodeSdks({ exec: input.exec, platform: input.platform }),
    androidSdk: hostAndroidSdk(input),
    storeTools: async (target, gameLock) => {
      const lock = gameLock ?? (await input.currentLock());
      if (!lock) return null;
      const found = await locateMobileStoreTools(input.store, lock, target);
      return found.ok ? found.tools : null;
    },
    notices: async (target, buildLock, lock) => {
      if (await isFixtureStore(input.store)) return { ok: true, notices: [] };
      return rustExportNotices({ store: input.store, buildLock, target, ...(lock ? { lock } : {}) });
    },
  };
}
