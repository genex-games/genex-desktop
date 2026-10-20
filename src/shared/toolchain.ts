/**
 * The managed, version-pinned toolchains a compiled game (C++ · raylib, Rust · wgpu) builds with:
 * what the store holds, what a game's lock names, how an install stands, and what each destination
 * needs. Browser-safe types and pure rules; the store itself is `substrate/toolchain-store/`, the
 * service `main/core/toolchains.ts`. (`substrate/toolchain.ts` is the unrelated login-PATH resolver.)
 */
import { StudioPlatform } from "./boot.ts";
import { MINUTE_MS } from "./duration.ts";
import {
  BUILD_TARGETS,
  BuildTarget,
  type CompiledStack,
  type CreatableStack,
  GameStack,
  StackDefaultSwitch,
} from "./game-project.ts";
import { TargetRefusal } from "./game-targets.ts";
import type { CrossBuildTarget } from "./native-contract.ts";

/** Every managed toolchain component, by id. Wire values (manifest, lock): never rename one. */
export const ToolchainId = {
  Cmake: "cmake",
  Ninja: "ninja",
  Emsdk: "emsdk",
  Zig: "zig",
  LlvmMingw: "llvm-mingw",
  RaylibSource: "raylib",
  AngleMac: "angle-macos",
  AngleWindows: "angle-windows",
  AngleLinux: "angle-linux",
  /** The Linux destination's X11, Wayland and xkbcommon headers and GLFW's Wayland protocol code (a local artifact). */
  LinuxSysroot: "linux-sysroot",
  /** The pinned Rust sysroot for the host: rustc, cargo, clippy, llvm-tools and the host's standard library. */
  Rust: "rust",
  /** The Rust standard library for the browser (`wasm32-unknown-unknown`). */
  RustStdWasm: "rust-std-wasm32",
  /** `wasm-bindgen` CLI: the browser build's JavaScript glue. */
  WasmBindgen: "wasm-bindgen",
  /** binaryen's `wasm-opt`: the browser build's size pass. */
  Binaryen: "binaryen",
  /** The vendored crate set every Rust game builds from offline (genex and its allowlisted closure). */
  RustVendor: "rust-vendor",
  /** The Rust standard library for the Windows destination (`x86_64-pc-windows-gnullvm`). */
  RustStdWindows: "rust-std-windows-gnullvm",
  /** The Rust standard library for the Linux destination (`x86_64-unknown-linux-gnu`). */
  RustStdLinux: "rust-std-linux-gnu",
  /** cargo-zigbuild: links a Rust Linux build against glibc 2.28 through the store's zig (never an Apple target). */
  CargoZigbuild: "cargo-zigbuild",
  /**
   * The Linux destination's software Vulkan (SwiftShader, its ICD manifest and the Vulkan loader),
   * split out of the Linux ANGLE artifact with its own recipe and lock: what a Rust Linux game ships.
   */
  SwiftShaderLinux: "swiftshader-linux",
  /**
   * The Android SDK platform {@link ANDROID_PINS}`.platform` (with platform-tools): the person's own
   * install with the SDK licence, which the store locates and never downloads.
   */
  AndroidSdk: "android-sdk",
  /** Android Build-Tools {@link ANDROID_PINS}`.buildToolsMajor`.x (aapt2, zipalign, apksigner, d8): the person's own install. */
  AndroidBuildTools: "android-build-tools",
  /** The Android NDK {@link ANDROID_PINS}`.ndk` (clang for `aarch64-linux-android`): the person's own install. */
  AndroidNdk: "android-ndk",
  /** bundletool: builds and validates the Android App Bundle. */
  Bundletool: "bundletool",
  /** The Java runtime the Android packaging tools run on: Temurin {@link JDK_PIN}, pinned in the store. */
  Jdk: "jdk",
  /** The Rust standard library for an iPhone (`aarch64-apple-ios`). */
  RustStdIos: "rust-std-ios",
  /** The Rust standard library for the iOS Simulator on Apple silicon (`aarch64-apple-ios-sim`). */
  RustStdIosSim: "rust-std-ios-sim",
  /** The Rust standard library for Android (`aarch64-linux-android`). */
  RustStdAndroid: "rust-std-android",
  /** cargo-deny: checks an approved crate's closure for advisories, licences and bans (crate requests). */
  CargoDeny: "cargo-deny",
  /** cargo-vet: reads the trusted sources' audits of an approved crate's closure, for the person's information. */
  CargoVet: "cargo-vet",
  /** The pinned RustSec advisory-db snapshot cargo-deny reads (`crate-policy.json` pins the same commit). */
  RustsecAdvisoryDb: "rustsec-advisory-db",
  /**
   * The relay client's native core (Colyseus native-sdk {@link COLYSEUS_VERSION}): upstream's
   * prebuilt static libraries, laid out one folder per native triple ({@link COLYSEUS_TRIPLES}).
   * Only an export of a `[net]` game links it ({@link RUST_NET_COMPONENTS}).
   */
  Colyseus: "colyseus",
  /** The same release's source tarball: Android's libcolyseus is built from it (upstream ships no Android prebuilt). */
  ColyseusSource: "colyseus-source",
} as const;
export type ToolchainId = (typeof ToolchainId)[keyof typeof ToolchainId];

/** The phone destinations. */
export type MobileBuildTarget = typeof BuildTarget.Ios | typeof BuildTarget.Android;

/** The phone destinations, iPhone first. */
export const MOBILE_BUILD_TARGETS: readonly MobileBuildTarget[] = Object.freeze([BuildTarget.Ios, BuildTarget.Android]);

/** Whether `value` names a phone destination. */
export function isMobileBuildTarget(value: unknown): value is MobileBuildTarget {
  return value === BuildTarget.Ios || value === BuildTarget.Android;
}

/** The hosts the manifest keys tool entries by. */
export const ToolchainHost = { MacArm64: "darwin-arm64", WindowsX64: "win32-x64", LinuxX64: "linux-x64" } as const;
export type ToolchainHost = (typeof ToolchainHost)[keyof typeof ToolchainHost];

const TOOLCHAIN_HOSTS: ReadonlySet<string> = new Set<ToolchainHost>(Object.values(ToolchainHost));
const isToolchainHost = (value: string): value is ToolchainHost => TOOLCHAIN_HOSTS.has(value);

/** The manifest host a computer is (`process.platform`, `process.arch`), or null where no toolchain is pinned (an Intel Mac). */
export function toolchainHostOf(platform: string, arch: string): ToolchainHost | null {
  const host = `${platform}-${arch}`;
  return isToolchainHost(host) ? host : null;
}

/**
 * Whether the studio installs C++ toolchains and runs C++ builds on `platform`. Not on Windows
 * yet: its sandbox grants a write to the whole session, never to one run, so a build's own folder
 * or a prewarm's staging would be writable by every agent command meanwhile.
 */
export function cppLaneRunsOn(platform: string): boolean {
  return platform !== StudioPlatform.Windows;
}

/**
 * The platforms each compiled stack's build lane runs on. Never Windows yet, for either stack: its
 * sandbox cannot grant a write to one build (a Rust game waits for the signed launcher too). An
 * Intel Mac is a Mac here, but {@link toolchainHostOf} names no toolchain host for it, so no
 * stack's setup prepares anything there.
 */
export const LANE_PLATFORMS = {
  [GameStack.RaylibCpp]: [StudioPlatform.Mac, StudioPlatform.Linux],
  [GameStack.RustWgpu]: [StudioPlatform.Mac, StudioPlatform.Linux],
} as const satisfies Record<CompiledStack, readonly StudioPlatform[]>;

/** The manifest host whose toolchain the studio installs on this computer: {@link toolchainHostOf} where the lane runs, else null. */
export function servedToolchainHost(platform: string, arch: string): ToolchainHost | null {
  return cppLaneRunsOn(platform) ? toolchainHostOf(platform, arch) : null;
}

/**
 * The manifest host where Rust · wgpu is a new game's default: its lane runs here and the store
 * pins a toolchain for it (an Apple-silicon Mac, the Linux Studio on x64). Null on Windows, an
 * Intel Mac and any other computer, where Three.js stays the default.
 */
export function rustDefaultHost(platform: string, arch: string): ToolchainHost | null {
  const lanes: readonly string[] = LANE_PLATFORMS[GameStack.RustWgpu];
  return lanes.includes(platform) ? toolchainHostOf(platform, arch) : null;
}

/** Why a new game starts on the stack {@link defaultStackFor} picked. Wire values: never rename one. */
export const StackDefaultReason = {
  /** Rust · wgpu: the switch is host-conditional and its lane runs here. */
  HostLane: "host-lane",
  /** Three.js: the switch was reverted (Rust · wgpu stays creatable when chosen). */
  SwitchReverted: "switch-reverted",
  /** Three.js: no Rust lane runs on this computer (Windows, an Intel Mac). */
  NoLaneHere: "no-lane-here",
  /** Three.js: offline with no Rust toolchain installed yet, so nothing could build a Rust game. */
  ToolchainOffline: TargetRefusal.ToolchainOffline,
} as const;
export type StackDefaultReason = (typeof StackDefaultReason)[keyof typeof StackDefaultReason];

/** What the default stack reads about this computer. */
export interface StackDefaultHost {
  /** `process.platform`. */
  platform: string;
  /** `process.arch`. */
  arch: string;
  /** Whether the toolchain's downloads can be reached now. */
  online: boolean;
  /** Whether the Rust toolchain is already installed in this profile's store. */
  rustToolchainReady: boolean;
}

/** A new game's default stack and why: never C++ · raylib, whose creation is retired. */
export interface StackDefault {
  stack: CreatableStack;
  why: StackDefaultReason;
}

/**
 * The stack a new game starts on (the create dialog's preselection, an intake that names no
 * stack). Host-conditional: Rust · wgpu where {@link rustDefaultHost} names this computer, unless
 * it is offline with no Rust toolchain installed (an offline first launch: `toolchain-offline`,
 * Three.js offered). Reverted: Three.js on every computer.
 */
export function defaultStackFor(setting: StackDefaultSwitch, host: StackDefaultHost): StackDefault {
  if (setting === StackDefaultSwitch.ThreeJs)
    return { stack: GameStack.ThreeJs, why: StackDefaultReason.SwitchReverted };
  if (rustDefaultHost(host.platform, host.arch) === null) {
    return { stack: GameStack.ThreeJs, why: StackDefaultReason.NoLaneHere };
  }
  const offlineFirstLaunch = !host.online && !host.rustToolchainReady;
  if (offlineFirstLaunch) return { stack: GameStack.ThreeJs, why: StackDefaultReason.ToolchainOffline };
  return { stack: GameStack.RustWgpu, why: StackDefaultReason.HostLane };
}

/** Archive formats the store extracts (its own extractor; the plugin table stays `dmg`/`tar.gz`). */
export const ArchiveFormat = { TarGz: "tar.gz", TarXz: "tar.xz", Zip: "zip" } as const;
export type ArchiveFormat = (typeof ArchiveFormat)[keyof typeof ArchiveFormat];

/** One pinned download. `sha256: null` means unpinned: the store refuses to install it. */
export interface ToolchainArchive {
  url: string;
  bytes: number;
  sha256: string | null;
  format: ArchiveFormat;
  /** Leading path components to drop, as `tar --strip-components`. */
  strip: number;
  /** The subfolder of the install root it extracts to; `""` for the root (emsdk: `install`, `node`, `python`). */
  into: string;
}

/** Why a pinned component has no download yet. Wire values: never rename one. */
export const ToolchainUnhosted = {
  /** Genex built and verified it (a CI artifact or a local build), but has published no download yet. */
  NotPublished: "not-published",
} as const;
export type ToolchainUnhosted = (typeof ToolchainUnhosted)[keyof typeof ToolchainUnhosted];

/**
 * A component Genex builds itself, pinned by its folder's `manifest.json` (which lists every file's
 * path, size and sha256). Installation verifies a bundled copy, a developer's local folder or
 * its separately pinned published archive. An entry with `local` has `archives: []`.
 */
export interface ToolchainLocalArtifact {
  /** sha256 of the artifact folder's `manifest.json`: the entry's digest; its first 12 hex are the sha12. */
  manifestSha256: string;
  /** The `manifest.json` size. */
  manifestBytes: number;
  /** How many files `manifest.json` lists, and their total size. */
  files: number;
  bytes: number;
  reason: ToolchainUnhosted;
  /**
   * The one archive a fresh store fetches the folder from, once it is published (the Linux sysroot):
   * checked against `sha256` and `bytes`, extracted by the store's own reader, then verified file by
   * file against the `manifest.json` pin before it is swapped in. `url` stays null until the owner
   * publishes the archive; until then nothing is fetched (`reason`).
   */
  fetch?: { url: string | null; sha256: string; bytes: number; format: ArchiveFormat };
}

/** One manifest entry: a tool for a host, or a per-destination artifact (host null). */
export interface ToolchainEntry {
  id: ToolchainId;
  version: string;
  host: ToolchainHost | null;
  target: BuildTarget | null;
  archives: ToolchainArchive[];
  licence: string;
  /** A component pinned by its local folder's manifest, with no download (`archives` is empty). */
  local?: ToolchainLocalArtifact;
}

/** The versions a game was built with; `digest` is sha256 of the canonical JSON of `entries`. */
export interface ToolchainLock {
  version: 1;
  entries: Partial<Record<ToolchainId, { version: string; sha12: string }>>;
  digest: string;
}

/** Where an install stands. Sent to the renderer: never rename a value. */
export const ToolchainInstallPhase = {
  Preflight: "preflight",
  Downloading: "downloading",
  Verifying: "verifying",
  Extracting: "extracting",
  Probing: "probing",
  Prewarming: "prewarming",
  Installed: "installed",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;
export type ToolchainInstallPhase = (typeof ToolchainInstallPhase)[keyof typeof ToolchainInstallPhase];

/** Why an install failed; the renderer words each one. Never rename a value. */
export const ToolchainProblem = {
  Unpinned: "unpinned",
  NotHttps: "not-https",
  Download: "download",
  Integrity: "integrity",
  Archive: "archive",
  DiskSpace: "disk-space",
  Probe: "probe",
  Prewarm: "prewarm",
  CltMissing: "clt-missing",
  UnsupportedHost: "unsupported-host",
  /** An install that needed a component Genex has pinned but not published (`ToolchainEntry.local`). */
  NotHosted: "not-hosted",
  /** This copy of Genex was built without a component it ships with (ANGLE, `resources/angle`). */
  NotBundled: "not-bundled",
} as const;
export type ToolchainProblem = (typeof ToolchainProblem)[keyof typeof ToolchainProblem];

/** The one install job, running or finished. */
export interface ToolchainInstallJob {
  phase: ToolchainInstallPhase;
  problem?: ToolchainProblem;
  entry: ToolchainId | null;
  completed: number;
  total: number;
  startedAt: string;
  finishedAt?: string;
  /** Setup finished while these destinations still need a component or a separate OS prerequisite. */
  unavailable?: BuildTarget[];
}

const ENDED_INSTALL_PHASES: ReadonlySet<ToolchainInstallPhase> = new Set([
  ToolchainInstallPhase.Installed,
  ToolchainInstallPhase.Failed,
  ToolchainInstallPhase.Cancelled,
]);

/** Whether `job` is still running (it has not ended installed, failed or cancelled). */
export function isInstallRunning(job: Pick<ToolchainInstallJob, "phase"> | null): boolean {
  return job !== null && !ENDED_INSTALL_PHASES.has(job.phase);
}

/** One pinned download for this computer, for the Toolchain sheet's sizes. */
export interface ToolchainDownload {
  id: ToolchainId;
  version: string;
  /** What it downloads. */
  bytes: number;
  /** The disk its install may take while it unpacks, as the install's own check counts it. */
  diskBytes: number;
  /** It comes with Genex (ANGLE): copied from the app's resources, never downloaded (`bytes` is 0). */
  bundled?: true;
}

/** Whether a destination's prewarm outputs are current for the lock. Sent to the renderer: never rename a value. */
export const PrewarmState = {
  Ready: "ready",
  /** Built for another lock, another recipe.json, an older genex.cmake format or another headless platform file. */
  Stale: "stale",
  Missing: "missing",
} as const;
export type PrewarmState = (typeof PrewarmState)[keyof typeof PrewarmState];

/** Where a part the person installs ({@link USER_SIDE_COMPONENTS}) stands on this computer. Sent to the renderer: never rename a value. */
export const UserSideState = {
  Ready: "ready",
  /** Installed, but not at the pinned version (another NDK revision, Build-Tools of another major, another platform). */
  OtherVersion: "other-version",
  Missing: "missing",
} as const;
export type UserSideState = (typeof UserSideState)[keyof typeof UserSideState];

/** The parts of the Android SDK the person installs under its licence. */
export type UserSideComponent =
  | typeof ToolchainId.AndroidSdk
  | typeof ToolchainId.AndroidBuildTools
  | typeof ToolchainId.AndroidNdk;

/** The person's Android SDK as the Toolchain sheet reads it (`studio:toolchain.status`): never a path. */
export interface AndroidSetupStatus {
  /** An SDK was found where the person keeps one. */
  sdk: boolean;
  /** The SDK's licence record names the current Android SDK licence: only a person's press in the sheet writes it. */
  licenceAccepted: boolean;
  /** Each part the person installs under that licence. */
  parts: Record<UserSideComponent, UserSideState>;
}

/** What Settings → Toolchains, the Toolchain sheet and the create dialog read. */
export interface ToolchainStatus {
  host: ToolchainHost | null;
  clt: { present: boolean; version: string | null };
  installed: Array<{ id: ToolchainId; version: string; sha12: string; bytes: number }>;
  lock: ToolchainLock | null;
  job: ToolchainInstallJob | null;
  storeBytes: number;
  /** This computer's pinned downloads, for the sheet's sizes. */
  downloads?: ToolchainDownload[];
  /** Free bytes on the store's disk; null when the disk could not be asked. */
  freeBytes?: number | null;
  /** What an install keeps free beyond its downloads' `diskBytes`. */
  reserveBytes?: number;
  /** Per destination this host builds, whether its prewarm is current for the current lock. */
  prewarm?: Partial<Record<BuildTarget, PrewarmState>>;
  /** Pinned components this host needs that have no download yet, and why. */
  unhosted?: Array<{ id: ToolchainId; reason: ToolchainUnhosted }>;
  /**
   * Xcode, found beside the Command Line Tools: iPhone and iPad builds need it, Mac builds take
   * either. `iosSdk` and `status` ({@link xcodeStatusOf}) come with the Xcode probe (M5.4).
   */
  xcode?: { present: boolean; version: string | null; iosSdk?: string | null; status?: XcodeStatus };
  /** Each compiled stack's current lock (`LOCK_FILE_OF_STACK`); `lock` stays raylib's for older readers. */
  stackLocks?: Partial<Record<CompiledStack, ToolchainLock | null>>;
  /** Harness modules the agent kept from before Rust games: a Rust night refuses them until each is re-taken. */
  keptPreRust?: string[];
  /** The person's Android SDK and its licence, where the host probes them (the phones' setup). */
  android?: AndroidSetupStatus;
}

/** Why "Remove old versions" kept every version. Sent to the renderer: never rename a value. */
export const ToolchainPruneRefusal = {
  /** An install or another prune is running. */
  Busy: "busy",
  /** No install has written a current lock yet. */
  NoLock: "no-lock",
  /** A game records a lock the store cannot read back, or nobody said which locks the games hold. */
  UnknownGameLock: "unknown-game-lock",
  /** The store is not this profile's own (the `cpp-game` fixture's link to the developer's store). */
  Shared: "shared",
} as const;
export type ToolchainPruneRefusal = (typeof ToolchainPruneRefusal)[keyof typeof ToolchainPruneRefusal];

/** What a prune did: how many folders and bytes it removed, or why it removed nothing. */
export interface ToolchainPruneResult {
  removed: number;
  bytes: number;
  refused?: ToolchainPruneRefusal;
}

/**
 * What each destination needs installed (the CLT is separate: `CLT_TARGETS`). Every raylib
 * prebuild, the Windows and Linux ones included, is built by prewarm in the lock folder from the
 * raylib source, so no destination names a prebuilt raylib component.
 */
export const REQUIRED_COMPONENTS = {
  [BuildTarget.Web]: [ToolchainId.Cmake, ToolchainId.Ninja, ToolchainId.Emsdk, ToolchainId.RaylibSource],
  [BuildTarget.Mac]: [ToolchainId.Cmake, ToolchainId.Ninja, ToolchainId.RaylibSource, ToolchainId.AngleMac],
  [BuildTarget.Windows]: [
    ToolchainId.Cmake,
    ToolchainId.Ninja,
    ToolchainId.Zig,
    ToolchainId.RaylibSource,
    ToolchainId.AngleWindows,
  ],
  [BuildTarget.Linux]: [
    ToolchainId.Cmake,
    ToolchainId.Ninja,
    ToolchainId.Zig,
    ToolchainId.RaylibSource,
    ToolchainId.AngleLinux,
    ToolchainId.LinuxSysroot,
  ],
  // raylib builds no mobile destination: no host matrix row ever lists one.
  [BuildTarget.Ios]: [],
  [BuildTarget.Android]: [],
} as const satisfies Record<BuildTarget, readonly ToolchainId[]>;

/** A compiled stack's components per destination; a destination its lane does not build yet needs nothing listed. */
export type StackComponents = Readonly<Record<BuildTarget, readonly ToolchainId[]>>;

/**
 * What a Rust · wgpu cross destination needs beyond the host's Rust sysroot and the vendored
 * crates: its standard library and linker (llvm-mingw for `x86_64-pc-windows-gnullvm`; zig with
 * cargo-zigbuild for glibc 2.28), and on Linux the sysroot pkg-config reads and the SwiftShader
 * the game ships. The Rust cross specs (`cross-targets.ts` `RUST_CROSS_TARGETS`) read this table.
 */
export const RUST_CROSS_COMPONENTS = {
  [BuildTarget.Windows]: [ToolchainId.RustStdWindows, ToolchainId.LlvmMingw],
  [BuildTarget.Linux]: [
    ToolchainId.RustStdLinux,
    ToolchainId.Zig,
    ToolchainId.CargoZigbuild,
    ToolchainId.LinuxSysroot,
    ToolchainId.SwiftShaderLinux,
  ],
} as const satisfies Record<CrossBuildTarget, readonly ToolchainId[]>;

/**
 * What a Rust · wgpu phone destination needs beyond the host's Rust sysroot and the vendored
 * crates: the iPhone's and the Simulator's standard libraries (Xcode is a prerequisite outside the
 * store, `stack-setup.ts`), and on Android its standard library, the person's SDK, Build-Tools
 * and NDK ({@link USER_SIDE_COMPONENTS}), bundletool and the store's JDK. The mobile lanes read
 * this table (M5.1, M5.2, M5.4).
 */
export const RUST_MOBILE_COMPONENTS = {
  [BuildTarget.Ios]: [ToolchainId.RustStdIos, ToolchainId.RustStdIosSim],
  [BuildTarget.Android]: [
    ToolchainId.RustStdAndroid,
    ToolchainId.AndroidSdk,
    ToolchainId.AndroidBuildTools,
    ToolchainId.AndroidNdk,
    ToolchainId.Bundletool,
    ToolchainId.Jdk,
  ],
} as const satisfies Record<MobileBuildTarget, readonly ToolchainId[]>;

/** The Colyseus native-sdk release the vendored relay client binds (its reconnect takeover reads this release's struct layout). */
export const COLYSEUS_VERSION = "0.18.10";

/** The upstream release assets the store pins. Wire values (recipe file names): never rename one. */
export const ColyseusAsset = {
  /** Apple: one xcframework with the macOS (universal), iPhone and iOS Simulator slices. */
  Xcframework: "Colyseus.xcframework.zip",
  /** Linux x86_64: the core and its companion archives under `lib/`. */
  LinuxX64: "colyseus-linux-x86_64.tar.gz",
  /** Windows x86_64 (MinGW ABI): the same archives as `<name>.lib` under `lib/`. */
  WindowsX64: "colyseus-windows-x86_64.zip",
  /** The source tree, for the Android build (MP-1b). */
  Source: "colyseus-source-v0.18.10.tar.gz",
} as const;
export type ColyseusAsset = (typeof ColyseusAsset)[keyof typeof ColyseusAsset];

/**
 * Each asset's pin: size and sha256 as GitHub's release digest states them and as the downloaded
 * bytes hashed (2026-10-20); `into` is the folder of the `colyseus` component it unpacks to.
 */
export const COLYSEUS_ASSETS = {
  [ColyseusAsset.Xcframework]: {
    bytes: 27694569,
    sha256: "66eb6f4ebd662e81f20e63a3c42c515159f523246238055ff55fdf6d09b09982",
    into: "apple",
  },
  [ColyseusAsset.LinuxX64]: {
    bytes: 4848504,
    sha256: "74170d62ab47d65fc5898226856e95f7a34016541f9b15408cc841848633dc91",
    into: "linux",
  },
  [ColyseusAsset.WindowsX64]: {
    bytes: 3762440,
    sha256: "8073572579d7ff30caf6ef2bee6efcb1ffc302e34dad2489e7e21d0302923aab",
    into: "windows",
  },
  [ColyseusAsset.Source]: {
    bytes: 39198211,
    sha256: "a90950b6871dcba9f32e31e71ecb3e914c851e015b62b7534fe31aac6d60a325",
    into: "",
  },
} as const satisfies Record<ColyseusAsset, { bytes: number; sha256: string; into: string }>;

/** The release download of `asset`. */
export function colyseusAssetUrl(asset: ColyseusAsset): string {
  return `https://github.com/colyseus/native-sdk/releases/download/v${COLYSEUS_VERSION}/${asset}`;
}

/** The native triples a `[net]` game links libcolyseus for. Wire values (store folder names): never rename one. */
export const ColyseusTriple = {
  Mac: "aarch64-apple-darwin",
  Ios: "aarch64-apple-ios",
  IosSim: "aarch64-apple-ios-sim",
  Linux: "x86_64-unknown-linux-gnu",
  Windows: "x86_64-pc-windows-gnullvm",
  Android: "aarch64-linux-android",
} as const;
export type ColyseusTriple = (typeof ColyseusTriple)[keyof typeof ColyseusTriple];

/**
 * Where each prebuilt triple's libraries sit in its unpacked asset: the folder, and the file
 * suffix upstream gives them (`.a`, or `.lib` in the MinGW zip; the store renames each to
 * `lib<name>.a`, the name the crate's build script and a GNU-style linker look for). Android has
 * no prebuilt: it is built from {@link ColyseusAsset}`.Source` (MP-1b).
 */
export const COLYSEUS_TRIPLES = {
  [ColyseusTriple.Mac]: {
    asset: ColyseusAsset.Xcframework,
    folder: "Colyseus.xcframework/macos-arm64_x86_64",
    suffix: ".a",
  },
  [ColyseusTriple.Ios]: { asset: ColyseusAsset.Xcframework, folder: "Colyseus.xcframework/ios-arm64", suffix: ".a" },
  [ColyseusTriple.IosSim]: {
    asset: ColyseusAsset.Xcframework,
    folder: "Colyseus.xcframework/ios-arm64_x86_64-simulator",
    suffix: ".a",
  },
  [ColyseusTriple.Linux]: { asset: ColyseusAsset.LinuxX64, folder: "lib", suffix: ".a" },
  [ColyseusTriple.Windows]: { asset: ColyseusAsset.WindowsX64, folder: "lib", suffix: ".lib" },
  [ColyseusTriple.Android]: { asset: ColyseusAsset.Source, folder: "", suffix: ".a" },
} as const satisfies Record<ColyseusTriple, { asset: ColyseusAsset; folder: string; suffix: string }>;

/**
 * The static libraries of a prebuilt, in link order: the core first, then its companions (a Linux
 * or Windows asset ships them split; the xcframework merges them into the core). The crate's
 * build script links each one present.
 */
export const COLYSEUS_LIBRARIES: readonly string[] = Object.freeze([
  "colyseus",
  "http_zig",
  "strutil_zig",
  "system_certs_zig",
  "msgpack_builder",
  "msgpack_reader",
  "wslay",
  "mbedtls",
  "mbedx509",
  "mbedcrypto",
]);

/**
 * What an export of a `[net]` game needs per destination beyond the destination's own components
 * (Live, judges and captures link no network code, so no other build needs them): libcolyseus for
 * every native destination, built from source for Android, nothing for the browser (its relay
 * client is the JS bridge).
 */
export const RUST_NET_COMPONENTS = {
  [BuildTarget.Web]: [],
  [BuildTarget.Mac]: [ToolchainId.Colyseus],
  [BuildTarget.Windows]: [ToolchainId.Colyseus],
  [BuildTarget.Linux]: [ToolchainId.Colyseus],
  [BuildTarget.Ios]: [ToolchainId.Colyseus],
  [BuildTarget.Android]: [ToolchainId.ColyseusSource],
} as const satisfies StackComponents;

/**
 * The components a person installs with the Android SDK and its licence, never an agent and never
 * the store's downloader: the store finds them where the person put them and pins their versions.
 */
export const USER_SIDE_COMPONENTS: readonly ToolchainId[] = Object.freeze([
  ToolchainId.AndroidSdk,
  ToolchainId.AndroidBuildTools,
  ToolchainId.AndroidNdk,
]);

/** The JDK the store pins for the Android packaging tools (Q3 answered 2026-10-06: Temurin 21, no gate). */
export const JDK_PIN = { vendor: "temurin", feature: 21 } as const;

/**
 * The Android pins (2026-10-06). `minSdk` 29 is Android 10: the commonly cited CDD rule that 64-bit
 * devices launching with Android 10 support Vulkan 1.1 (unverified here; the runtime adapter check
 * is the real gate). `vulkanVersionFeature` is the required `android.hardware.vulkan.version`
 * `uses-feature` value, `VK_MAKE_API_VERSION(0, 1, 1, 0)`. GameActivity's AAR and the
 * android-activity crate it pairs with are pinned together. Play's target-API floor rises each
 * August: the quarterly lane moves `targetSdk`, `compileSdk`, `platform` and Build-Tools together.
 */
export const ANDROID_PINS = {
  platform: "android-36",
  buildToolsMajor: 36,
  compileSdk: 36,
  targetSdk: 36,
  minSdk: 29,
  ndk: "30.0.16248370",
  vulkanVersionFeature: 0x401000,
  gamesActivityAar: "4.4.0",
  androidActivityCrate: "0.6.1",
} as const;

/**
 * The Xcode pins: device and distribution builds need Xcode 26 or later with the iOS 26 SDK (App
 * Store Connect's requirement since 2026-04-28); every iOS build sets
 * `IPHONEOS_DEPLOYMENT_TARGET` to `deploymentTarget`. Mac builds take the Command Line Tools.
 */
export const XCODE_PINS = { minMajor: 26, iosSdkMinMajor: 26, deploymentTarget: "16.0" } as const;

/** What the Xcode probe found, for iPhone builds. Sent to the renderer: never rename a value. */
export const XcodeStatus = {
  /** No Xcode: iPhone builds are unavailable (Mac builds take the Command Line Tools). */
  Absent: "absent",
  /** Xcode older than {@link XCODE_PINS}`.minMajor`, or a version the probe could not read. */
  TooOld: "too-old",
  /** Xcode is new enough, but its iOS SDK is missing or older than {@link XCODE_PINS}`.iosSdkMinMajor`. */
  IosSdkMissing: "ios-sdk-missing",
  /** Xcode and its iOS SDK meet the pins: device and distribution builds may run. */
  Ready: "ready",
} as const;
export type XcodeStatus = (typeof XcodeStatus)[keyof typeof XcodeStatus];

/** What the Xcode probe reports: whether Xcode is there, its version and its iOS SDK's version. */
export interface XcodeFound {
  present: boolean;
  version: string | null;
  iosSdk: string | null;
}

/** A dotted version's major number, or null when it does not start with one. */
function majorOf(version: string | null): number | null {
  const major = /^(\d+)(?:\.|$)/.exec(version ?? "")?.[1];
  return major === undefined ? null : Number(major);
}

/** Whether a dotted version's major is at least `min`; an unreadable version is not. */
const atLeast = (version: string | null, min: number): boolean => (majorOf(version) ?? -1) >= min;

/** The Xcode probe's status against {@link XCODE_PINS}. */
export function xcodeStatusOf(found: XcodeFound): XcodeStatus {
  if (!found.present) return XcodeStatus.Absent;
  if (!atLeast(found.version, XCODE_PINS.minMajor)) return XcodeStatus.TooOld;
  if (!atLeast(found.iosSdk, XCODE_PINS.iosSdkMinMajor)) return XcodeStatus.IosSdkMissing;
  return XcodeStatus.Ready;
}

/** The licences a person accepts in the Toolchain sheet (`studio:toolchain.acceptAndroidLicence`). Wire values: never rename one. */
export const AndroidLicence = {
  /** The Android SDK licence the platform, Build-Tools and the NDK are installed under (`licenses/android-sdk-license`). */
  Sdk: "android-sdk-license",
} as const;
export type AndroidLicence = (typeof AndroidLicence)[keyof typeof AndroidLicence];

const ANDROID_LICENCES: ReadonlySet<string> = new Set<AndroidLicence>(Object.values(AndroidLicence));

const MESSAGE = {
  badLicence: "Licence refused: name the Android SDK licence the sheet showed.",
} as const;

const isAndroidLicence = (value: unknown): value is AndroidLicence =>
  typeof value === "string" && ANDROID_LICENCES.has(value);

/** The licence a `studio:toolchain.acceptAndroidLicence` payload names; throws for anything else. */
export function parseAndroidLicence(payload: unknown): AndroidLicence {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error(MESSAGE.badLicence);
  const { licence }: Record<string, unknown> = { ...payload };
  if (!isAndroidLicence(licence)) throw new Error(MESSAGE.badLicence);
  return licence;
}

/**
 * What a Rust · wgpu game needs per destination. Browser and Mac only so far: the Windows and Linux
 * rows join {@link RUST_CROSS_COMPONENTS} (with the host's Rust and the vendored crates) once
 * their lanes pin those components in `rust-recipe.json`, and the mobile ones with theirs. Until
 * then the lane refuses Windows and Linux `target-unbuilt` and setup offers neither
 * ({@link rustCrossPinned}).
 */
const RUST_REQUIRED_COMPONENTS = {
  [BuildTarget.Web]: [
    ToolchainId.Rust,
    ToolchainId.RustStdWasm,
    ToolchainId.WasmBindgen,
    ToolchainId.Binaryen,
    ToolchainId.RustVendor,
  ],
  [BuildTarget.Mac]: [ToolchainId.Rust, ToolchainId.RustVendor],
  [BuildTarget.Windows]: [],
  [BuildTarget.Linux]: [],
  [BuildTarget.Ios]: [],
  [BuildTarget.Android]: [],
} as const satisfies StackComponents;

/**
 * The crate checker's components: installed in the store on demand, when the person approves the
 * first crate request, and kept out of every build lock (a build never reads them).
 */
export const CRATE_CHECK_COMPONENTS = Object.freeze([
  ToolchainId.CargoDeny,
  ToolchainId.CargoVet,
  ToolchainId.RustsecAdvisoryDb,
] as const);

/** What each compiled stack needs per destination: raylib's is {@link REQUIRED_COMPONENTS}. */
export const STACK_REQUIRED_COMPONENTS = {
  [GameStack.RaylibCpp]: REQUIRED_COMPONENTS,
  [GameStack.RustWgpu]: RUST_REQUIRED_COMPONENTS,
} as const satisfies Record<CompiledStack, StackComponents>;

/**
 * Whether the Rust recipe pins every component `target`'s cross build needs (`required` is the Rust
 * row of {@link STACK_REQUIRED_COMPONENTS}): the lane registers that destination's builder, and
 * setup offers it, only then.
 */
export function rustCrossPinned(
  target: CrossBuildTarget,
  required: StackComponents = STACK_REQUIRED_COMPONENTS[GameStack.RustWgpu],
): boolean {
  const listed: readonly string[] = required[target];
  return RUST_CROSS_COMPONENTS[target].every((id) => listed.includes(id));
}

/**
 * The store's current-lock file per compiled stack, side by side in one store folder: raylib keeps
 * the name it always had, so an older Studio still reads its lock.
 */
export const LOCK_FILE_OF_STACK = {
  [GameStack.RaylibCpp]: "current-lock.json",
  [GameStack.RustWgpu]: "current-lock.rust-wgpu.json",
} as const satisfies Record<CompiledStack, string>;

/**
 * How long one shell command of a game's agent session may run when the call names no timeout, per
 * stack: a compiled build (CMake and Ninja, or cargo) takes minutes. The Rust row is the C++ one
 * until the Rust lane measures its own. The engines' compiled sessions read this table
 * (`studio-tool-prompts.ts`); the harness seed keeps a copy in `tools/game-tools.ts`, held equal by
 * seed-contracts.test.ts.
 */
export const COMMAND_TIMEOUT_MS = {
  [GameStack.ThreeJs]: 2 * MINUTE_MS,
  [GameStack.RaylibCpp]: 10 * MINUTE_MS,
  [GameStack.RustWgpu]: 10 * MINUTE_MS,
} as const satisfies Record<GameStack, number>;

/** Destinations that need Apple's Command Line Tools. */
export const CLT_TARGETS: readonly BuildTarget[] = Object.freeze([BuildTarget.Mac]);

/** Whether the store holds `id` at the version the lock names, or at any version when the lock names none. */
function isInstalled(status: ToolchainStatus, id: ToolchainId): boolean {
  const locked = status.lock?.entries[id];
  return status.installed.some(
    (item) => item.id === id && (!locked || (item.version === locked.version && item.sha12 === locked.sha12)),
  );
}

/** What `targets` lack before they build: the CLT, components, and destinations whose prewarm must be redone. */
export interface MissingToolchain {
  clt: boolean;
  /** Components not installed at the lock's version (deduplicated, table order). */
  components: ToolchainId[];
  /** Destinations whose components are all installed but whose prewarm is stale or missing: an Install redoes it. */
  prewarm: BuildTarget[];
}

/** What is missing for `targets`: whether the CLT is, which components, and which destinations need prewarming again. */
export function missingFor(status: ToolchainStatus, targets: readonly BuildTarget[]): MissingToolchain {
  const wanted = BUILD_TARGETS.filter((target) => targets.includes(target));
  const needed = [...new Set(wanted.flatMap((target): readonly ToolchainId[] => REQUIRED_COMPONENTS[target]))];
  const installed = (target: BuildTarget) => REQUIRED_COMPONENTS[target].every((id) => isInstalled(status, id));
  const unprewarmed = (target: BuildTarget) => {
    const state = status.prewarm?.[target];
    return state === PrewarmState.Stale || state === PrewarmState.Missing;
  };
  return {
    clt: !status.clt.present && wanted.some((target) => CLT_TARGETS.includes(target)),
    components: needed.filter((id) => !isInstalled(status, id)),
    prewarm: wanted.filter((target) => installed(target) && unprewarmed(target)),
  };
}

/** A toolchain failure with its typed reason beside the sentence, so no reader matches English. */
export class ToolchainError extends Error {
  readonly problem: ToolchainProblem;

  constructor(problem: ToolchainProblem, message: string) {
    super(message);
    this.name = "ToolchainError";
    this.problem = problem;
  }
}
