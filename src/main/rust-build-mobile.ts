/**
 * The phone destinations of the Rust build lane (M2.10): the builder per phone build, the settings
 * a build of each needs, and the admission facts read back from what it produced.
 *
 * - iOS builds `aarch64-apple-ios` (a device) and `aarch64-apple-ios-sim` (the Simulator) with
 *   `IPHONEOS_DEPLOYMENT_TARGET` {@link IOS_DEPLOYMENT_TARGET} (rustc's own default is older, so
 *   LC_BUILD_VERSION would carry it) and `SDKROOT` set to the SDK `xcrun` names, never the Mac SDK.
 * - Android builds `aarch64-linux-android` with the NDK's API {@link ANDROID_API_LEVELS}`.min`
 *   clang as the linker and 16 KB pages ({@link ANDROID_PAGE_BYTES}): Google Play requires every
 *   PT_LOAD of a native library to be 16 KB aligned, and an NDK before r28 links at 4 KB. The link
 *   arguments are rustflags: cargo ignores `target.<triple>.rustflags` whenever `RUSTFLAGS` is
 *   set, which the lane always sets (`-F unsafe_code`), so they are appended to it.
 * - An export keeps its debug files outside `out/` (CRASH-7a, `substrate/rust-debug-files.ts`):
 *   iOS packs a dSYM beside the executable and ships it with the debug map stripped; Android keeps
 *   the unstripped `game` and ships the copy the toolchain's `llvm-objcopy --strip-debug` wrote
 *   (the APK's `libmain.so` is that copy), both in `<bin>.debug/<digest>/`.
 * - The facts (LC_BUILD_VERSION platform and minos, every PT_LOAD's alignment, DT_NEEDED) are only
 *   read here; admission's policies over them are M3.5's gates (`native-bundle.ts`,
 *   `native-gate-elf.ts`), which these readers sit on for the parse itself.
 *
 * The core registers {@link RUST_MOBILE_TARGET_BUILDERS} over the lane's `RUST_TARGET_BUILDERS`
 * (`rustTargetBuilders` in `core/internals.ts`) and hands it {@link mobileTargetSettings}, which
 * the lane merges into a phone build's environment, rustflags and sandbox reads. A phone build
 * still waits for its host-matrix row (M5.0) before the lane runs one. Nothing here launches a
 * Simulator, an emulator or a device: containment stage 1.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { StudioPlatform } from "../shared/boot.ts";
import { SECOND_MS } from "../shared/duration.ts";
import { errorMessage } from "../shared/errors.ts";
import { BuildTarget } from "../shared/game-project.ts";
import { NativeGpuTier, NativeRefusal, type NativeWgpuBackend } from "../shared/native-contract.ts";
import { parseMachO } from "../substrate/native-bundle.ts";
import { parseElf } from "../substrate/native-gate-elf.ts";
import type { XcodeExec } from "../substrate/toolchain-store/locate.ts";
import type { RustTargetBuilder } from "./rust-build.ts";

/** The iOS release every phone build targets (LC_BUILD_VERSION minos; Info.plist MinimumOSVersion in M5.1). */
export const IOS_DEPLOYMENT_TARGET = "16.0";
/** Android API levels: the NDK clang links against `min`; `target` and `compile` are the manifest's (M5.2). */
export const ANDROID_API_LEVELS = { min: 29, target: 36, compile: 36 } as const;
/** The page size every Android PT_LOAD is aligned to. */
export const ANDROID_PAGE_BYTES = 16 * 1024;

/** One phone build: the destination and, for iOS, a device or the Simulator. */
export const MobileBuild = {
  IosDevice: "ios-device",
  IosSimulator: "ios-simulator",
  Android: "android",
} as const;
export type MobileBuild = (typeof MobileBuild)[keyof typeof MobileBuild];

/** The SDKs `xcrun --sdk` names for an iOS build. */
export const AppleSdk = { Device: "iphoneos", Simulator: "iphonesimulator" } as const;
export type AppleSdk = (typeof AppleSdk)[keyof typeof AppleSdk];

/** LC_BUILD_VERSION's platform as these facts name it; `other` is any platform but the two iOS ones. */
export const MachOPlatform = { Ios: "ios", IosSimulator: "ios-simulator", Other: "other" } as const;
export type MachOPlatform = (typeof MachOPlatform)[keyof typeof MachOPlatform];

/** Why a phone build has no settings. Wire values: the lane's refusal lines name them. */
export const MobileSettingsRefusal = {
  NeedsAMac: "needs-a-mac",
  SdkMissing: "sdk-missing",
  NdkMissing: "ndk-missing",
} as const;
export type MobileSettingsRefusal = (typeof MobileSettingsRefusal)[keyof typeof MobileSettingsRefusal];

/**
 * The libraries a crate's build script may name with `-l` that bionic folds into its libc, so the
 * NDK sysroot has no file for them (r27's `aarch64-linux-android` holds no `libpthread`): an empty
 * archive of each satisfies the linker and adds nothing to the binary. The vendored relay client
 * links `pthread` on Android (MP-1b).
 */
export const ANDROID_LINK_SHIMS: readonly string[] = Object.freeze(["libpthread.a"]);
/** An empty `ar` archive: the global header alone. */
const EMPTY_AR_ARCHIVE = "!<arch>\n";

/** Writes {@link ANDROID_LINK_SHIMS} into `dir` (absolute; created), replacing none that is there already. */
export async function writeAndroidLinkShims(dir: string): Promise<void> {
  if (!path.isAbsolute(dir)) throw new TypeError(`the link shim folder must be absolute: ${dir}`);
  await mkdir(dir, { recursive: true });
  for (const name of ANDROID_LINK_SHIMS) await writeFile(path.join(dir, name), EMPTY_AR_ARCHIVE, { flag: "wx" });
}

/** The rustflags that put the shim folder on the linker's search path. */
export function androidLinkShimRustflags(dir: string): string[] {
  return ["-L", `native=${dir}`];
}

/** Why a phone build's output gave no facts. */
export const MobileFactRefusal = { NotMachO: "not-macho", NotElf: "not-elf" } as const;
export type MobileFactRefusal = (typeof MobileFactRefusal)[keyof typeof MobileFactRefusal];

type ReadyBuilder = Extract<RustTargetBuilder, { ready: true }>;

/** How one phone build is made and what its output must say. */
export interface MobileBuilder {
  build: MobileBuild;
  target: BuildTarget;
  /** rustc's target triple. */
  triple: string;
  /** The SDK `SDKROOT` names, for an iOS build; null for Android. */
  appleSdk: AppleSdk | null;
  /** The LC_BUILD_VERSION platform an iOS build's executable carries; null for Android. */
  machoPlatform: MachOPlatform | null;
  /** The lane's own entry: cargo's triple and the `out/` layout. */
  lane: ReadyBuilder;
}

/**
 * Both phones build one executable named `game` with the staged assets beside it; packaging
 * (M5.1's `.app`, M5.2's APK with the game as `libmain.so`) is the export's step, not the lane's.
 */
const PHONE_OUT = { executables: ["game"], assets: true } as const;

/** The builder per phone build. */
export const RUST_MOBILE_BUILDERS = {
  [MobileBuild.IosDevice]: {
    build: MobileBuild.IosDevice,
    target: BuildTarget.Ios,
    triple: "aarch64-apple-ios",
    appleSdk: AppleSdk.Device,
    machoPlatform: MachOPlatform.Ios,
    lane: { ready: true, triple: "aarch64-apple-ios", macSdk: false, ...PHONE_OUT },
  },
  [MobileBuild.IosSimulator]: {
    build: MobileBuild.IosSimulator,
    target: BuildTarget.Ios,
    triple: "aarch64-apple-ios-sim",
    appleSdk: AppleSdk.Simulator,
    machoPlatform: MachOPlatform.IosSimulator,
    lane: { ready: true, triple: "aarch64-apple-ios-sim", macSdk: false, ...PHONE_OUT },
  },
  [MobileBuild.Android]: {
    build: MobileBuild.Android,
    target: BuildTarget.Android,
    triple: "aarch64-linux-android",
    appleSdk: null,
    machoPlatform: null,
    lane: { ready: true, triple: "aarch64-linux-android", macSdk: false, ...PHONE_OUT },
  },
} as const satisfies Record<MobileBuild, MobileBuilder>;

/**
 * What the lane registers for the two phone destinations at the M2c merge: a Genex iOS build is a
 * device build (the Simulator build is the export's and CI's).
 */
export const RUST_MOBILE_TARGET_BUILDERS = {
  [BuildTarget.Ios]: RUST_MOBILE_BUILDERS[MobileBuild.IosDevice].lane,
  [BuildTarget.Android]: RUST_MOBILE_BUILDERS[MobileBuild.Android].lane,
} as const satisfies Partial<Record<BuildTarget, RustTargetBuilder>>;

/** What was found on this host for a phone build. */
export interface MobileToolchainFound {
  /** The iOS SDK `xcrun` named for the build's {@link AppleSdk} ({@link appleSdkPath}). */
  sdkRoot: string | null;
  /** The pinned Android NDK's root folder in the person's SDK, or null when it is not installed. */
  ndk: string | null;
  host: NodeJS.Platform;
}

/** A phone build's settings, or why it has none. */
export type MobileSettings =
  | {
      ok: true;
      /** Set over the lane's environment. */
      env: Record<string, string>;
      /** Appended to the lane's `RUSTFLAGS`, in order. */
      rustflags: string[];
      /** Folders the build sandbox reads besides the lane's own. */
      reads: string[];
    }
  | { ok: false; code: MobileSettingsRefusal; detail: string };

const MESSAGE = {
  NeedsAMac: (build: MobileBuild) => `${build} builds need a Mac with Xcode`,
  SdkMissing: (sdk: AppleSdk) =>
    `no ${sdk} SDK: Xcode (not only the Command Line Tools) must be installed and selected`,
  NdkMissing: "no Android NDK: the store's NDK is not installed",
} as const;

/** The NDK's prebuilt host folder: one per host OS (the macOS one is universal). */
const NDK_HOST = { darwin: "darwin-x86_64", linux: "linux-x86_64", win32: "windows-x86_64" } as const;

/** A folder path a setting may carry: absolute, one line, no NUL. */
const usableFolder = (dir: string | null): dir is string =>
  dir !== null && dir !== "" && path.isAbsolute(dir) && !/[\n\r\0]/.test(dir);

/** The NDK's API-level clang for aarch64 on `host`. */
export function androidNdkClang(ndk: string, host: NodeJS.Platform): string {
  const prebuilt = host === "win32" || host === "linux" ? NDK_HOST[host] : NDK_HOST.darwin;
  const clang = `aarch64-linux-android${ANDROID_API_LEVELS.min}-clang`;
  return path.join(ndk, "toolchains", "llvm", "prebuilt", prebuilt, "bin", clang);
}

/** The link arguments that align every PT_LOAD to {@link ANDROID_PAGE_BYTES}, as rustflags. */
function androidPageRustflags(): string[] {
  return ["max-page-size", "common-page-size"].flatMap((name) => [
    "-C",
    `link-arg=-Wl,-z,${name}=${ANDROID_PAGE_BYTES}`,
  ]);
}

function androidSettings(found: MobileToolchainFound): MobileSettings {
  if (!usableFolder(found.ndk))
    return { ok: false, code: MobileSettingsRefusal.NdkMissing, detail: MESSAGE.NdkMissing };
  const clang = androidNdkClang(found.ndk, found.host);
  const bin = path.dirname(clang);
  return {
    ok: true,
    env: {
      CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER: clang,
      CC_aarch64_linux_android: clang,
      AR_aarch64_linux_android: path.join(bin, "llvm-ar"),
    },
    rustflags: androidPageRustflags(),
    reads: [found.ndk],
  };
}

function iosSettings(build: MobileBuild, sdk: AppleSdk, found: MobileToolchainFound): MobileSettings {
  if (found.host !== StudioPlatform.Mac)
    return { ok: false, code: MobileSettingsRefusal.NeedsAMac, detail: MESSAGE.NeedsAMac(build) };
  if (!usableFolder(found.sdkRoot))
    return { ok: false, code: MobileSettingsRefusal.SdkMissing, detail: MESSAGE.SdkMissing(sdk) };
  return {
    ok: true,
    env: { IPHONEOS_DEPLOYMENT_TARGET: IOS_DEPLOYMENT_TARGET, SDKROOT: found.sdkRoot },
    rustflags: [],
    reads: [found.sdkRoot],
  };
}

/** The environment, rustflags and sandbox reads a `build` needs on this host, or why it cannot be made. */
export function mobileBuildSettings(build: MobileBuild, found: MobileToolchainFound): MobileSettings {
  const { appleSdk } = RUST_MOBILE_BUILDERS[build];
  return appleSdk === null ? androidSettings(found) : iosSettings(build, appleSdk, found);
}

/** The phone build the lane makes for each phone destination: a device build (the Simulator's has a lane of its own). */
const LANE_BUILD = { [BuildTarget.Ios]: MobileBuild.IosDevice, [BuildTarget.Android]: MobileBuild.Android } as const;

/** Which iPhone build a lane makes, and where the Android NDK is found. */
export interface MobileTargetSettingsOptions {
  /** The iPhone build this lane makes (default: a device build; the export's Simulator lane passes the Simulator's). */
  ios?: typeof MobileBuild.IosDevice | typeof MobileBuild.IosSimulator;
  /** The pinned NDK's root in the person's Android SDK (`probeAndroidSdk`), or null; absent: none. */
  ndk?: () => Promise<string | null>;
}

/**
 * The lane's `targetSettings`: a phone destination's {@link mobileBuildSettings} on this host
 * (the iOS SDK `xcrun` names for the lane's iPhone build; the pinned NDK in the person's Android
 * SDK, without which an Android build refuses `ndk-missing`); null for every other destination.
 */
export function mobileTargetSettings(
  platform: NodeJS.Platform,
  exec: XcodeExec,
  options: MobileTargetSettingsOptions = {},
): (target: BuildTarget) => Promise<MobileSettings | null> {
  return async (target) => {
    if (target !== BuildTarget.Ios && target !== BuildTarget.Android) return null;
    const build = target === BuildTarget.Ios ? (options.ios ?? LANE_BUILD[target]) : LANE_BUILD[target];
    const sdk = RUST_MOBILE_BUILDERS[build].appleSdk;
    const sdkRoot = sdk === null ? null : await appleSdkPath(exec, sdk, platform).catch(() => null);
    const ndk = sdk === null && options.ndk ? await options.ndk().catch(() => null) : null;
    return mobileBuildSettings(build, { sdkRoot, ndk, host: platform });
  };
}

const XCODE_SELECT = "/usr/bin/xcode-select";
const XCRUN = "/usr/bin/xcrun";
const XCODE_PROBE_TIMEOUT_MS = 10 * SECOND_MS;

/**
 * The iOS SDK `xcrun` names for `sdk`, or null without Xcode or off a Mac. `xcode-select -p` runs
 * first and `xcrun` only once it names a developer folder (as `macSdkPath` does): never a shim
 * that can open Apple's installer dialog.
 */
export async function appleSdkPath(
  exec: XcodeExec,
  sdk: AppleSdk,
  platform: NodeJS.Platform | string = process.platform,
): Promise<string | null> {
  if (platform !== StudioPlatform.Mac) return null;
  const selected = await exec(XCODE_SELECT, ["-p"], { timeoutMs: XCODE_PROBE_TIMEOUT_MS });
  if (selected.code !== 0 || selected.stdout.trim() === "") return null;
  const answer = await exec(XCRUN, ["--sdk", sdk, "--show-sdk-path"], { timeoutMs: XCODE_PROBE_TIMEOUT_MS });
  const found = answer.stdout.trim();
  return answer.code === 0 && usableFolder(found) ? found : null;
}

/** What an iOS build's executable says about where it runs. */
export interface MachOMobileFacts {
  /** LC_BUILD_VERSION's (or LC_VERSION_MIN_IPHONEOS's) platform; null when it carries neither. */
  platform: MachOPlatform | null;
  /** The minimum OS release, `major.minor[.patch]`; null when it carries no version command. */
  minos: string | null;
  /** Every imported library, in file order. */
  dylibs: string[];
  /** LC_DYLD_ENVIRONMENT settings. */
  environment: string[];
}

/** What an Android build's ELF file says to the loader. */
export interface ElfMobileFacts {
  /** `e_machine` (AArch64 is 183). */
  machine: number;
  /** Every PT_LOAD's `p_align`, in file order. */
  loadAlignments: number[];
  /** DT_NEEDED, in file order. */
  needed: string[];
}

/** Facts read back from a build's output, or why the file gave none. */
export type MobileFactsRead<T> = { ok: true; facts: T } | { ok: false; code: MobileFactRefusal; detail: string };

/** Mach-O's numbers for the commands and platforms read here. */
const MachO = {
  HeaderBytes: 32,
  BuildVersion: 0x32,
  BuildVersionBytes: 24,
  VersionMinIphoneos: 0x25,
  VersionMinBytes: 16,
  PlatformIos: 2,
  PlatformIosSimulator: 7,
} as const;

/** Mach-O's packed version (xxxx.yy.zz) as text, the patch only when it is not zero. */
function machoVersionText(packed: number): string {
  const [major, minor, patch] = [packed >>> 16, (packed >>> 8) & 0xff, packed & 0xff];
  return patch === 0 ? `${major}.${minor}` : `${major}.${minor}.${patch}`;
}

function platformOf(value: number): MachOPlatform {
  if (value === MachO.PlatformIos) return MachOPlatform.Ios;
  if (value === MachO.PlatformIosSimulator) return MachOPlatform.IosSimulator;
  return MachOPlatform.Other;
}

class VersionCommandError extends Error {}

/**
 * The platform and minos the load commands name. `parseMachO` has already checked that every
 * command fits the header's command area, so the walk only checks each version command's own size.
 */
function readVersion(bytes: Uint8Array): Pick<MachOMobileFacts, "platform" | "minos"> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(16, true);
  let at = MachO.HeaderBytes;
  for (let index = 0; index < count; index++) {
    const cmd = view.getUint32(at, true);
    const size = view.getUint32(at + 4, true);
    if (cmd === MachO.BuildVersion) {
      if (size < MachO.BuildVersionBytes) throw new VersionCommandError("LC_BUILD_VERSION is shorter than its fields");
      return {
        platform: platformOf(view.getUint32(at + 8, true)),
        minos: machoVersionText(view.getUint32(at + 12, true)),
      };
    }
    if (cmd === MachO.VersionMinIphoneos) {
      if (size < MachO.VersionMinBytes)
        throw new VersionCommandError("LC_VERSION_MIN_IPHONEOS is shorter than its fields");
      return { platform: MachOPlatform.Ios, minos: machoVersionText(view.getUint32(at + 8, true)) };
    }
    at += size;
  }
  return { platform: null, minos: null };
}

/** The facts of an iOS build's thin arm64 executable, or `not-macho` for anything else; never throws. */
export function machOMobileFacts(bytes: Uint8Array): MobileFactsRead<MachOMobileFacts> {
  try {
    const image = parseMachO(bytes);
    return { ok: true, facts: { ...readVersion(bytes), dylibs: image.dylibs, environment: image.environment } };
  } catch (error) {
    return { ok: false, code: MobileFactRefusal.NotMachO, detail: errorMessage(error) };
  }
}

/** ELF64's numbers for the program header fields read here. */
const Elf = { PhoffAt: 32, PhnumAt: 56, ProgramHeaderBytes: 56, AlignAt: 48, Load: 1 } as const;

/** Every PT_LOAD's `p_align`; `parseElf` has already checked the program header table's bounds. */
function loadAlignments(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const phoff = Number(view.getBigUint64(Elf.PhoffAt, true));
  const count = view.getUint16(Elf.PhnumAt, true);
  const alignments: number[] = [];
  for (let index = 0; index < count; index++) {
    const at = phoff + index * Elf.ProgramHeaderBytes;
    if (view.getUint32(at, true) === Elf.Load) alignments.push(Number(view.getBigUint64(at + Elf.AlignAt, true)));
  }
  return alignments;
}

/** The facts of an Android build's ELF64 file, or `not-elf` for anything else; never throws. */
export function elfMobileFacts(bytes: Uint8Array): MobileFactsRead<ElfMobileFacts> {
  try {
    const image = parseElf(bytes);
    return { ok: true, facts: { machine: image.machine, loadAlignments: loadAlignments(bytes), needed: image.needed } };
  } catch (error) {
    return { ok: false, code: MobileFactRefusal.NotElf, detail: errorMessage(error) };
  }
}

/**
 * The events a phone shell writes to its lifecycle log (`genex-self-test/lifecycle.ndjson`, the
 * mobile shell's `log` records) that a smoke reads. Wire values: the Rust shell writes them.
 */
export const MobileLifecycleEvent = {
  /** The shell could not start: no window, no surface, no event loop (`code`, `detail`). */
  Failed: "failed",
  /** The GPU is below WebGPU core: the typed refusal record (`code`, `detail`). */
  GpuUnsupported: NativeRefusal.GpuUnsupported,
  /** The device opened: its capability `receipt`, as JSON text or an object. */
  Gpu: "gpu",
  /**
   * The designed refusal screen after a refusal: whether it is `shown`, the typed `code` its last
   * line names and the colours it is drawn in (`background`, `ink`, `codeInk`, sRGB bytes).
   */
  RefusalScreen: "refusal-screen",
  /**
   * The first frame presented on a surface: the world frames `rendered` so far and the `window` it
   * went to (pixels). An admitted adapter is not a drawn frame: a smoke waits for this one.
   */
  FramePresented: "frame-presented",
} as const;
export type MobileLifecycleEvent = (typeof MobileLifecycleEvent)[keyof typeof MobileLifecycleEvent];

/** What a CI smoke of a phone shell found in its lifecycle log. Wire values: the workflows print them. */
export const ShellSmoke = {
  /** The receipt names a WebGPU-core adapter on the expected backend. */
  Adapter: "adapter",
  /** The shell refused the GPU with the typed record (the reason goes in the summary). */
  GpuUnsupported: NativeRefusal.GpuUnsupported,
  /** The shell logged a failure (no window, no surface, no event loop). */
  Failed: "failed",
  /** The receipt names another backend or tier. */
  WrongAdapter: "wrong-adapter",
  /** The log has neither a receipt nor a refusal: the app never reached its GPU, or crashed. */
  NoOutcome: "no-outcome",
} as const;
export type ShellSmoke = (typeof ShellSmoke)[keyof typeof ShellSmoke];

/** A smoke's verdict: passing outcomes are a core adapter or the typed refusal. */
export interface ShellSmokeVerdict {
  pass: boolean;
  outcome: ShellSmoke;
  /** The adapter's name, the refusal's detail or the failure's code and detail. */
  detail: string;
}

type LogEvent = Record<string, unknown>;

function logEvents(ndjson: string): LogEvent[] {
  const events: LogEvent[] = [];
  for (const line of ndjson.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) events.push(value as LogEvent);
    } catch {
      // A line cut off by a crash says nothing.
    }
  }
  return events;
}

/** The receipt an event carries: the shell logs it as JSON text. */
function receiptOf(event: LogEvent): LogEvent | null {
  const raw = event.receipt;
  if (typeof raw !== "string") return raw && typeof raw === "object" ? (raw as LogEvent) : null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as LogEvent) : null;
  } catch {
    return null;
  }
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** An sRGB colour as a phone shell logs it: three bytes. */
export type Rgb = readonly [number, number, number];

/** The refusal screen a phone shell drew, from its lifecycle log. */
export interface RefusalScreenFacts {
  /** Whether the platform could draw it (the loop stays up to keep it on screen). */
  shown: boolean;
  /** The typed code the screen's last line names. */
  code: string;
  /** The code of the refusal record the same log holds ("" when it holds none). */
  recordCode: string;
  background: Rgb;
  ink: Rgb;
  codeInk: Rgb;
}

const isByte = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;

function rgbOf(value: unknown): Rgb | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [r, g, b] = value as unknown[];
  return isByte(r) && isByte(g) && isByte(b) ? [r, g, b] : null;
}

/** A refusal screen's facts from a record or a log event, or null when any is missing or malformed. */
export function refusalScreenFacts(value: unknown): RefusalScreenFacts | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const facts = value as Record<string, unknown>;
  const [background, ink, codeInk] = [rgbOf(facts.background), rgbOf(facts.ink), rgbOf(facts.codeInk)];
  const typed = typeof facts.shown === "boolean" && typeof facts.code === "string";
  if (!typed || background === null || ink === null || codeInk === null) return null;
  const recordCode = text(facts.recordCode);
  return { shown: facts.shown === true, code: text(facts.code), recordCode, background, ink, codeInk };
}

/**
 * The refusal screen a phone shell's lifecycle log says it drew: its newest `refusal-screen` event
 * (a resize, rotation or resume draws and logs it again) with the code of the log's refusal
 * record, or null when the log holds no well-formed one.
 */
export function refusalScreenOf(ndjson: string): RefusalScreenFacts | null {
  const events = logEvents(ndjson);
  const record = events.find((event) => event.event === MobileLifecycleEvent.GpuUnsupported);
  const screen = events.filter((event) => event.event === MobileLifecycleEvent.RefusalScreen).at(-1);
  if (screen === undefined) return null;
  return refusalScreenFacts({ ...screen, recordCode: text(record?.code) });
}

/** The first frame a phone shell presented, from its lifecycle log. */
export interface FirstFrameFacts {
  /** World frames rendered when it was presented (at least one). */
  rendered: number;
  /** The window it was presented to, in pixels. */
  window: readonly [number, number];
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * The first well-formed `frame-presented` event of a phone shell's lifecycle log (a frame of a
 * rendered world, to a window of a size), or null when the shell presented none.
 */
export function firstFrameOf(ndjson: string): FirstFrameFacts | null {
  for (const event of logEvents(ndjson)) {
    if (event.event !== MobileLifecycleEvent.FramePresented || !isCount(event.rendered)) continue;
    const window = Array.isArray(event.window) ? (event.window as unknown[]) : [];
    const [width, height] = window;
    if (window.length === 2 && isCount(width) && isCount(height))
      return { rendered: event.rendered, window: [width, height] };
  }
  return null;
}

/**
 * The verdict on a phone shell's lifecycle log (`genex-self-test/lifecycle.ndjson`) from a CI
 * smoke run: it passes on a WebGPU-core adapter on `backend` in the receipt, or on the typed
 * `gpu-unsupported` refusal (an emulator or Simulator below core is a recorded result, not a
 * failure); a failure event, another backend or tier, or neither fails it.
 */
export function shellSmokeVerdict(ndjson: string, backend: NativeWgpuBackend): ShellSmokeVerdict {
  for (const event of logEvents(ndjson)) {
    if (event.event === MobileLifecycleEvent.Failed)
      return { pass: false, outcome: ShellSmoke.Failed, detail: `${text(event.code)}: ${text(event.detail)}` };
    if (event.event === MobileLifecycleEvent.GpuUnsupported)
      return { pass: true, outcome: ShellSmoke.GpuUnsupported, detail: text(event.detail) };
    const receipt = event.event === MobileLifecycleEvent.Gpu ? receiptOf(event) : null;
    if (!receipt) continue;
    const core = receipt.tier === NativeGpuTier.Core && receipt.backend === backend;
    const detail = `${text(receipt.adapter)} (${text(receipt.backend)}, ${text(receipt.tier)})`;
    return { pass: core, outcome: core ? ShellSmoke.Adapter : ShellSmoke.WrongAdapter, detail };
  }
  return { pass: false, outcome: ShellSmoke.NoOutcome, detail: "no gpu receipt and no gpu-unsupported record" };
}
