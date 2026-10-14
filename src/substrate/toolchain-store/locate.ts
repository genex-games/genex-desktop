/**
 * Finding the installed toolchain for a lock: every path a build needs, absolute and realpath'd,
 * or the components that are missing. A lock may come from a game's own `studio.json`, so every
 * version and digest is shape-checked before it becomes a path, and an absent store is an answer
 * (everything missing), never a throw.
 *
 * The store layout (a profile's `layout.toolchains`, or `$GENEX_DEV_TOOLCHAINS/dev-store` for the
 * developer's real-build tests):
 *
 * ```
 * <store>/
 *   <id>/<version>-<sha12>/     one installed component (the archive root after `strip`, or a
 *                               pinned artifact's verified copy with its manifest.json)
 *     receipt.json              { id, version, sha256, sha12, bytes, host, target,
 *                                 source: "archive" | "bundled" | "local-artifact", installedAt }
 *   locks/<lockDigest12>/       prewarm outputs for one lock, swapped in whole from .staging/
 *     genex-<target>.cmake      per destination prewarmed (web, macos, windows, linux)
 *     toolchain-<cross>.cmake   the zig CMake toolchain file of windows-x64 and linux-x64
 *     zig-cache-<cross>/global/ zig's cache from the cross prebuild (the clone source for build dirs)
 *     raylib-<variant>/{lib/libraylib.a, include/{raylib.h,rlgl.h,raymath.h}}
 *                               variant: web-es3, macos-es3-angle, macos-es3-angle-headless,
 *                               windows-x64-es3-angle, linux-x64-es3-angle
 *     em-cache/                 the prewarmed Emscripten cache (the clone source for build dirs)
 *     emscripten.config         EM_CONFIG for this lock
 *     prewarm.json              { lock, recipe: recipeSha12 (recipe.json, genex.cmake format),
 *                                 platform: the headless platform file's sha256 (null without a Mac),
 *                                 cross: crossPrewarmSha12 (the cross format and the Linux sysroot pin; null without
 *                                 Windows or Linux), outputs: string[], at }
 *   current-lock.json           the ToolchainLock new games build with (a developer's worktree may keep
 *                               its own lock file beside the shared store instead: scripts/toolchains/dev-store.ts)
 *   .staging/<lockDigest>/      the only prewarm-writable path (a per-run allowWrite overlay)
 * ```
 */
import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { StudioPlatform } from "../../shared/boot.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { ALL_BUILD_TARGETS, BuildTarget, type CompiledStack, GameStack } from "../../shared/game-project.ts";
import {
  type MobileBuildTarget,
  RUST_MOBILE_COMPONENTS,
  STACK_REQUIRED_COMPONENTS,
  ToolchainHost,
  ToolchainId,
  type ToolchainLock,
  USER_SIDE_COMPONENTS,
} from "../../shared/toolchain.ts";
import { isJsonObject } from "../fsx.ts";
import { isInside } from "../paths.ts";
import type { CrossAngle } from "../native-cross-admission.ts";
import {
  CROSS_TARGETS,
  CrossTarget,
  crossPrewarmSha12,
  crossZigCacheName,
  crossTargetOf,
  crossToolchainFileName,
} from "./cross-targets.ts";
import {
  headlessPlatformPath,
  headlessPlatformSha256,
  raylibVariants,
  readRecipe,
  type Recipe,
  recipeSha12,
} from "./genex-cmake.ts";
import type { ToolchainReceipt } from "./install.ts";
import { isSafePin, isToolchainLock, LOCKS_FOLDER, lockFolderName, readCurrentLock } from "./lock.ts";
import { TOOLCHAIN_MANIFEST } from "./manifest.ts";

const MESSAGE = {
  NoCrossAngle: (target: string) => `A ${target} build needs the lock's ANGLE for ${target}.`,
} as const;

/** Every path a build needs for one lock, absolute and realpath'd. */
export interface LocatedToolchain {
  lock: ToolchainLock;
  cmake: string;
  ninja: string;
  /** Web only; null when the lock has no emsdk. */
  emscripten: {
    /** The Emscripten folder (`emcc`, `em++`, `emar`). */
    root: string;
    toolchainFile: string;
    python: string;
    node: string;
    config: string;
    cache: string;
  } | null;
  /** The per-lock genex.cmake for each prewarmed destination. */
  genexCmake: Partial<Record<BuildTarget, string>>;
  /** The raylib source install, when the lock names one (the prebuild recipe and compile checks read it). */
  raylibSource?: string;
  /**
   * The store's Mac ANGLE, when the lock names one: the folder, its two libraries and the digest of
   * its `manifest.json` (the lock's pin), which every run's bundle copy is checked against.
   */
  angle?: { dir: string; egl: string; gles: string; manifestSha256: string } | null;
  /** The store's zig, when the lock names one (the Windows and Linux destinations' compiler). */
  zig?: string;
  /**
   * Per cross destination prewarmed for the lock: its zig CMake toolchain file, zig's prewarmed
   * global cache (the clone source of a new build folder's), the store ANGLE the gates admit its
   * output against, and (Linux) the headers' sysroot.
   */
  cross?: Partial<
    Record<
      BuildTarget,
      {
        toolchainFile: string;
        zigCache?: string;
        angle: CrossAngle;
        sysroot?: string;
        sysrootManifestSha256?: string;
      }
    >
  >;
}

/** What a locate may be told besides the lock: the headless platform file its prewarm digest folds in. */
export interface LocateOptions {
  /** The headless raylib platform file (default: the shipped one, `headlessPlatformPath`). */
  headlessPlatform?: string;
}

/**
 * The located toolchain, or which components the lock names that the store does not hold.
 * `needsPrewarm` means every component is installed but the lock's prewarm outputs are not there,
 * or were built for another lock or from another `recipe.json` (an app update); `missing` then
 * names the components those outputs are built from. The toolchain service adds what only it
 * knows: `stale`, the lock folder records a prewarm an older Genex made; `notHosted`, a missing
 * component has no download (a local artifact the app does not bundle), so installing builds
 * nothing more.
 */
export type LocateResult =
  | { ok: true; toolchain: LocatedToolchain }
  | { ok: false; missing: ToolchainId[]; needsPrewarm?: true; stale?: true; notHosted?: true };

/** The file every install folder holds. */
export const RECEIPT_FILE = "receipt.json";
/** The file every swapped-in lock folder holds. */
export const PREWARM_FILE = "prewarm.json";
/** The Emscripten config each lock folder holds (`EM_CONFIG`). */
export const EMSCRIPTEN_CONFIG_FILE = "emscripten.config";
/** The prewarmed Emscripten cache each lock folder holds. */
export const EM_CACHE_FOLDER = "em-cache";

/** The Python and Node versions emsdk 6.0.10 bundles (the probe expects them). */
export const EMSDK_BUNDLED = { python: "3.13.3", node: "v24.19.0" } as const;

/** Where each component keeps what a build or a probe runs, inside its install folder, per host. */
export const COMPONENT_LAYOUT = {
  cmake: {
    [ToolchainHost.MacArm64]: "CMake.app/Contents/bin/cmake",
    [ToolchainHost.LinuxX64]: "bin/cmake",
    [ToolchainHost.WindowsX64]: "bin/cmake.exe",
  },
  ninja: {
    [ToolchainHost.MacArm64]: "ninja",
    [ToolchainHost.LinuxX64]: "ninja",
    [ToolchainHost.WindowsX64]: "ninja.exe",
  },
  emscripten: "install/emscripten",
  emscriptenToolchainFile: "install/emscripten/cmake/Modules/Platform/Emscripten.cmake",
  emscriptenCache: "install/emscripten/cache",
  llvm: "install/bin",
  binaryen: "install",
  python: {
    [ToolchainHost.MacArm64]: `python/python-${EMSDK_BUNDLED.python}-0/bin/python3`,
    [ToolchainHost.LinuxX64]: "python/bin/python3",
    [ToolchainHost.WindowsX64]: "python/python.exe",
  },
  node: {
    [ToolchainHost.MacArm64]: "node/bin/node",
    [ToolchainHost.LinuxX64]: "node/bin/node",
    [ToolchainHost.WindowsX64]: "node/node.exe",
  },
  zig: {
    [ToolchainHost.MacArm64]: "zig",
    [ToolchainHost.LinuxX64]: "zig",
    [ToolchainHost.WindowsX64]: "zig.exe",
  },
  /** GLFW's Wayland protocol code in the Linux sysroot, which the wayland-scanner stand-in copies. */
  linuxProtocols: "glfw-wayland",
} as const satisfies Record<string, string | Record<ToolchainHost, string>>;

/**
 * Where the Rust components keep what a build or a probe runs, inside their install folders. The
 * dist tarballs each carry their own `manifest.in`, so the `rust` component unpacks one folder per
 * tarball (`manifest.ts` `RUST_PARTS`); the lane assembles its sysroot from them.
 */
export const RUST_COMPONENT_LAYOUT = {
  rustc: "rustc/bin/rustc",
  cargo: "cargo/bin/cargo",
  clippy: "clippy/bin/cargo-clippy",
  /** The host's standard library (`lib/rustlib/<host triple>/lib` beneath it). */
  hostStd: "rust-std/lib/rustlib",
  /** The browser's standard library, unpacked at the `rust-std-wasm32` component's root. */
  wasmStd: "lib/rustlib/wasm32-unknown-unknown/lib",
  wasmBindgen: "wasm-bindgen",
  wasmOpt: "bin/wasm-opt",
} as const satisfies Record<string, string>;

/**
 * Where the store's phone components keep what a lane or a probe runs, inside their install
 * folders: the JDK's home unpacks at its component's root (a Mac archive's `Contents/Home`
 * stripped), bundletool is its one jar, and each Rust standard library at its component's root.
 */
export const MOBILE_COMPONENT_LAYOUT = {
  java: {
    [ToolchainHost.MacArm64]: "bin/java",
    [ToolchainHost.LinuxX64]: "bin/java",
    [ToolchainHost.WindowsX64]: "bin/java.exe",
  },
  bundletool: "bundletool.jar",
  std: {
    [ToolchainId.RustStdIos]: "lib/rustlib/aarch64-apple-ios/lib",
    [ToolchainId.RustStdIosSim]: "lib/rustlib/aarch64-apple-ios-sim/lib",
    [ToolchainId.RustStdAndroid]: "lib/rustlib/aarch64-linux-android/lib",
  },
} as const;

/** The components a destination's prewarm outputs are built from (what `missing` names when they are absent). */
const PREWARMED_FROM = {
  [BuildTarget.Web]: [ToolchainId.Emsdk, ToolchainId.RaylibSource],
  [BuildTarget.Mac]: [ToolchainId.RaylibSource, ToolchainId.AngleMac],
  [BuildTarget.Windows]: [ToolchainId.RaylibSource, ToolchainId.Zig, ToolchainId.AngleWindows],
  [BuildTarget.Linux]: [ToolchainId.RaylibSource, ToolchainId.Zig, ToolchainId.AngleLinux, ToolchainId.LinuxSysroot],
  // raylib prewarms no mobile destination: no host matrix row lists one.
  [BuildTarget.Ios]: [],
  [BuildTarget.Android]: [],
} as const satisfies Record<BuildTarget, readonly ToolchainId[]>;

/** The raylib headers every prebuild installs. */
export const RAYLIB_HEADERS = ["raylib.h", "rlgl.h", "raymath.h"] as const;

/** The libraries a Mac ANGLE install holds, which every Mac game imports at link time. */
export const ANGLE_LIBRARIES = { egl: "libEGL.dylib", gles: "libGLESv2.dylib" } as const;

/** The ANGLE build each cross destination links and ships. */
export const CROSS_ANGLE = {
  [CrossTarget.WindowsX64]: ToolchainId.AngleWindows,
  [CrossTarget.LinuxX64]: ToolchainId.AngleLinux,
} as const satisfies Record<CrossTarget, ToolchainId>;

/** One raylib prebuild's files in a lock folder. */
const prebuildOutputs = (variant: string) => [
  ...RAYLIB_HEADERS.map((header) => `raylib-${variant}/include/${header}`),
  `raylib-${variant}/lib/libraylib.a`,
];

/** A destination's prewarm outputs, lock-folder-relative and `/`-separated. */
export function lockOutputs(target: BuildTarget, recipe: Recipe = readRecipe()): string[] {
  const cross = crossTargetOf(target);
  if (cross) return crossOutputs(target, cross);
  const emscripten = target === BuildTarget.Web ? [EM_CACHE_FOLDER, EMSCRIPTEN_CONFIG_FILE] : [];
  const prebuilds = raylibVariants(recipe, target).flatMap(prebuildOutputs);
  return [...emscripten, `genex-${target}.cmake`, ...prebuilds].sort();
}

/** A cross destination's prewarm outputs: its module, its zig toolchain file and cache, and its raylib prebuild. */
function crossOutputs(target: BuildTarget, cross: CrossTarget): string[] {
  const prebuild = prebuildOutputs(CROSS_TARGETS[cross].raylib);
  return [`genex-${target}.cmake`, crossToolchainFileName(cross), crossZigCacheName(cross), ...prebuild].sort();
}

/** The Linux sysroot's pin in the shipped manifest: its `manifest.json` sha256, or null without one. */
function linuxSysrootPin(): string | null {
  const entry = TOOLCHAIN_MANIFEST.find((item) => item.id === ToolchainId.LinuxSysroot);
  return entry?.local?.manifestSha256 ?? null;
}

/**
 * What `prewarm.json` records for a lock's Windows and Linux outputs (`cross`): the cross format
 * and recipe (`crossFormatSha12`) with the shipped Linux sysroot pin, so a change to any of them
 * reads as a prewarm to redo for those destinations only.
 */
export function crossPrewarmDigest(recipe: Recipe = readRecipe()): string {
  return crossPrewarmSha12(recipe, linuxSysrootPin());
}

/** The install folder of `id` at a lock's pin. */
export function componentFolder(store: string, id: ToolchainId, pin: { version: string; sha12: string }): string {
  return path.join(store, id, `${pin.version}-${pin.sha12}`);
}

/** A lock's prewarm folder. */
export function lockFolder(store: string, lock: ToolchainLock): string {
  return path.join(store, LOCKS_FOLDER, lockFolderName(lock));
}

const HOSTS: ReadonlySet<unknown> = new Set<unknown>([null, ...Object.values(ToolchainHost)]);
const isReceiptHost = (value: unknown) => HOSTS.has(value);

/** The receipt in an install folder, or null when it is absent or not a receipt. */
export async function readReceipt(folder: string): Promise<ToolchainReceipt | null> {
  const value = await readFile(path.join(folder, RECEIPT_FILE), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  if (!isJsonObject(value)) return null;
  const fields = ["id", "version", "sha256", "sha12", "source", "installedAt"] as const;
  const strings = fields.every((field) => typeof value[field] === "string");
  const shaped = strings && typeof value.bytes === "number" && isReceiptHost(value.host);
  return shaped ? (value as unknown as ToolchainReceipt) : null;
}

/** The components a `stack` game's `targets` need (raylib's by default), deduplicated, in the table's order. */
export function requiredFor(
  targets: readonly BuildTarget[],
  stack: CompiledStack = GameStack.RaylibCpp,
): ToolchainId[] {
  const table = STACK_REQUIRED_COMPONENTS[stack];
  const wanted = ALL_BUILD_TARGETS.filter((target) => targets.includes(target));
  return [...new Set(wanted.flatMap((target): readonly ToolchainId[] => table[target]))];
}

/** One installed component, as a lock names it. */
export interface InstalledComponent {
  folder: string;
  receipt: ToolchainReceipt;
}

/** The install folders of `ids` at `lock`'s pins under an already realpath'd `root`, or which are missing. */
export async function locateComponents(
  root: string,
  lock: ToolchainLock,
  ids: readonly ToolchainId[],
): Promise<{ ok: true; components: Map<ToolchainId, InstalledComponent> } | { ok: false; missing: ToolchainId[] }> {
  const components = new Map<ToolchainId, InstalledComponent>();
  const missing: ToolchainId[] = [];
  for (const id of ids) {
    const found = await installedComponent(root, lock, id);
    if (found) components.set(id, found);
    else missing.push(id);
  }
  return missing.length ? { ok: false, missing } : { ok: true, components };
}

async function installedComponent(
  root: string,
  lock: ToolchainLock,
  id: ToolchainId,
): Promise<InstalledComponent | null> {
  const pin = lock.entries[id];
  if (!isSafePin(pin)) return null;
  const folder = componentFolder(root, id, pin);
  const receipt = await readReceipt(folder);
  const matches = receipt?.id === id && receipt.version === pin.version && receipt.sha12 === pin.sha12;
  return matches && receipt ? { folder, receipt } : null;
}

/** The host whose layout an install uses: its receipt's, else this computer's. */
function layoutHost(component: InstalledComponent): ToolchainHost {
  return component.receipt.host ?? ToolchainHost.MacArm64;
}

/** `rel` under `folder`, realpath'd; throws when it does not exist. */
async function real(folder: string, rel: string): Promise<string> {
  return realpath(path.join(folder, ...rel.split("/")));
}

async function emscriptenPaths(emsdk: InstalledComponent, lockDir: string): Promise<LocatedToolchain["emscripten"]> {
  const host = layoutHost(emsdk);
  return {
    root: await real(emsdk.folder, COMPONENT_LAYOUT.emscripten),
    toolchainFile: await real(emsdk.folder, COMPONENT_LAYOUT.emscriptenToolchainFile),
    python: await real(emsdk.folder, COMPONENT_LAYOUT.python[host]),
    node: await real(emsdk.folder, COMPONENT_LAYOUT.node[host]),
    config: await real(lockDir, EMSCRIPTEN_CONFIG_FILE),
    cache: await real(lockDir, EM_CACHE_FOLDER),
  };
}

/**
 * Whether the lock folder's `prewarm.json` records this lock, built from the shipped recipe and
 * genex.cmake format (`recipe` is their {@link recipeSha12}) and, when `targets` include the Mac,
 * from the headless platform file there is now (`platform`): only the Mac compiles that file, so
 * only a Mac locate reads it, and a change to it never makes the web stale.
 */
async function prewarmIsCurrent(
  lockDir: string,
  lock: ToolchainLock,
  targets: readonly BuildTarget[],
  options: LocateOptions,
): Promise<boolean> {
  const record = await readFile(path.join(lockDir, PREWARM_FILE), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => null);
  const recorded = isJsonObject(record) && record.lock === lock.digest && record.recipe === recipeSha12(readRecipe());
  if (!recorded) return false;
  const cross = targets.some((target) => crossTargetOf(target) !== null);
  if (cross && record.cross !== crossPrewarmDigest()) return false;
  if (!targets.includes(BuildTarget.Mac)) return true;
  const platform = await headlessPlatformSha256(options.headlessPlatform ?? headlessPlatformPath());
  return platform !== null && record.platform === platform;
}

/** Whether the lock folder holds every prewarm output of `targets`, built for `lock` from the shipped recipe. */
async function prewarmed(
  lockDir: string,
  lock: ToolchainLock,
  targets: readonly BuildTarget[],
  options: LocateOptions,
): Promise<boolean> {
  if (!(await prewarmIsCurrent(lockDir, lock, targets, options))) return false;
  const wanted = targets.flatMap((target) => lockOutputs(target));
  const present = await Promise.all(
    wanted.map((rel) =>
      stat(path.join(lockDir, ...rel.split("/"))).then(
        () => true,
        () => false,
      ),
    ),
  );
  return present.every(Boolean);
}

/** The store's Mac ANGLE install: its folder, its two libraries and its receipt's manifest digest, realpath'd. */
export async function anglePaths(angle: InstalledComponent): Promise<NonNullable<LocatedToolchain["angle"]>> {
  const dir = await realpath(angle.folder);
  return {
    dir,
    egl: await real(dir, ANGLE_LIBRARIES.egl),
    gles: await real(dir, ANGLE_LIBRARIES.gles),
    manifestSha256: angle.receipt.sha256,
  };
}

/** A cross destination's store ANGLE: its folder, realpath'd, and its receipt's manifest digest (the lock's pin). */
export async function crossAngle(angle: InstalledComponent): Promise<CrossAngle> {
  return { dir: await realpath(angle.folder), manifestSha256: angle.receipt.sha256 };
}

/** What a cross destination builds with, besides the lock folder's module: its toolchain file, ANGLE and (Linux) sysroot. */
type CrossPaths = NonNullable<LocatedToolchain["cross"]>[BuildTarget];

/**
 * Each cross destination in `targets`: its toolchain file in `folder` (the lock folder, or a
 * prebuild's work folder), its ANGLE and, for Linux, the sysroot; null when `targets` has none.
 * Throws when a component it needs is not in `components`.
 */
export async function crossPathsIn(
  folder: string,
  targets: readonly BuildTarget[],
  components: ReadonlyMap<ToolchainId, InstalledComponent>,
  resolve: (folder: string, rel: string) => Promise<string> = async (at, rel) => path.join(at, rel),
): Promise<LocatedToolchain["cross"] | null> {
  const cross: NonNullable<LocatedToolchain["cross"]> = {};
  for (const target of targets) {
    const name = crossTargetOf(target);
    if (!name) continue;
    const angle = components.get(CROSS_ANGLE[name]);
    if (!angle) throw new Error(MESSAGE.NoCrossAngle(target));
    const sysroot = name === CrossTarget.LinuxX64 ? components.get(ToolchainId.LinuxSysroot) : undefined;
    const paths: CrossPaths = {
      toolchainFile: await resolve(folder, crossToolchainFileName(name)),
      zigCache: await resolve(folder, crossZigCacheName(name)),
      angle: await crossAngle(angle),
      ...(sysroot ? { sysroot: await realpath(sysroot.folder), sysrootManifestSha256: sysroot.receipt.sha256 } : {}),
    };
    cross[target] = paths;
  }
  return Object.keys(cross).length > 0 ? cross : null;
}

async function located(
  root: string,
  lock: ToolchainLock,
  targets: readonly BuildTarget[],
  components: Map<ToolchainId, InstalledComponent>,
): Promise<LocatedToolchain> {
  const lockDir = await realpath(lockFolder(root, lock));
  const cmake = components.get(ToolchainId.Cmake);
  const ninja = components.get(ToolchainId.Ninja);
  const emsdk = components.get(ToolchainId.Emsdk);
  const raylib = components.get(ToolchainId.RaylibSource);
  const angle = components.get(ToolchainId.AngleMac);
  const zig = components.get(ToolchainId.Zig);
  if (!cmake || !ninja) throw new Error("cmake and ninja are required for every destination");
  const genexCmake: Partial<Record<BuildTarget, string>> = {};
  for (const target of targets) genexCmake[target] = await real(lockDir, `genex-${target}.cmake`);
  const mac = angle && targets.includes(BuildTarget.Mac);
  const cross = await crossPathsIn(lockDir, targets, components, real);
  return {
    lock,
    cmake: await real(cmake.folder, COMPONENT_LAYOUT.cmake[layoutHost(cmake)]),
    ninja: await real(ninja.folder, COMPONENT_LAYOUT.ninja[layoutHost(ninja)]),
    emscripten: emsdk && targets.includes(BuildTarget.Web) ? await emscriptenPaths(emsdk, lockDir) : null,
    genexCmake,
    ...(raylib ? { raylibSource: await realpath(raylib.folder) } : {}),
    ...(mac ? { angle: await anglePaths(angle) } : {}),
    ...(zig ? { zig: await real(zig.folder, COMPONENT_LAYOUT.zig[layoutHost(zig)]) } : {}),
    ...(cross ? { cross } : {}),
  };
}

/**
 * The paths `targets` need under `lock`, or what is missing. A lock whose digest is not its
 * entries' (a game's `studio.json` naming old pins beside the current digest) locates nothing.
 */
export async function locateToolchain(
  store: string,
  lock: ToolchainLock,
  targets: readonly BuildTarget[],
  options: LocateOptions = {},
): Promise<LocateResult> {
  const required = requiredFor(targets);
  const root = await realpath(store).catch(() => null);
  if (!root || !isToolchainLock(lock)) return { ok: false, missing: required };
  const found = await locateComponents(root, lock, required);
  if (!found.ok) return found;
  const derived = [...new Set(targets.flatMap((target): readonly ToolchainId[] => PREWARMED_FROM[target]))];
  if (!(await prewarmed(lockFolder(root, lock), lock, targets, options)))
    return { ok: false, missing: derived, needsPrewarm: true };
  try {
    return { ok: true, toolchain: await located(root, lock, targets, found.components) };
  } catch {
    return { ok: false, missing: derived, needsPrewarm: true };
  }
}

/** The lock new `stack` games build with (raylib's `current-lock.json` by default), or null before its first install. */
export async function currentLock(
  store: string,
  stack: CompiledStack = GameStack.RaylibCpp,
): Promise<ToolchainLock | null> {
  return readCurrentLock(store, stack);
}

/**
 * The install folders a `stack` game's `targets` need under `lock` (a recorded older lock as much
 * as the current one), or which are missing; a malformed lock or an absent store locates nothing.
 * What each destination builds with beyond its components (prewarm outputs, the assembled sysroot)
 * is the stack's own lane's to locate.
 */
export async function locateStackComponents(
  store: string,
  lock: ToolchainLock,
  stack: CompiledStack,
  targets: readonly BuildTarget[],
): Promise<{ ok: true; components: Map<ToolchainId, InstalledComponent> } | { ok: false; missing: ToolchainId[] }> {
  const required = requiredFor(targets, stack);
  const root = await realpath(store).catch(() => null);
  if (!root || !isToolchainLock(lock)) return { ok: false, missing: required };
  return locateComponents(root, lock, required);
}

// ---------- the Command Line Tools ----------

/** A fixed host program run without a shell and outside the sandbox; never throws: a failure is its exit code. */
export type XcodeExec = (
  file: string,
  args: readonly string[],
  options?: { timeoutMs?: number },
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** `xcode-select -p` prints the selected developer folder; it never opens Apple's installer. */
const XCODE_SELECT = "/usr/bin/xcode-select";
/** `xcrun --show-sdk-path`, asked only once a developer folder is selected. */
const XCRUN = "/usr/bin/xcrun";
const XCODE_PROBE_TIMEOUT_MS = 10 * SECOND_MS;

/** The exit code `execFile` reports: 0 without an error, null when the program did not exit on its own. */
function exitCode(error: { code?: unknown } | null): number | null {
  if (!error) return 0;
  return typeof error.code === "number" ? error.code : null;
}

/** {@link XcodeExec} over `execFile`. */
export const execXcode: XcodeExec = (file, args, options = {}) =>
  new Promise((resolve) => {
    execFile(file, [...args], { encoding: "utf8", timeout: options.timeoutMs }, (error, stdout, stderr) => {
      resolve({ code: exitCode(error), stdout: String(stdout), stderr: String(stderr) });
    });
  });

/**
 * The macOS SDK a Mac build compiles against (`CMAKE_OSX_SYSROOT`), or null without the Command
 * Line Tools (or Xcode) or off a Mac. `xcode-select -p` runs first and `xcrun` only once it names
 * a developer folder: never clang, git or python3, whose shims can open Apple's installer dialog.
 */
export async function macSdkPath(
  exec: XcodeExec,
  platform: NodeJS.Platform | string = process.platform,
): Promise<string | null> {
  if (platform !== StudioPlatform.Mac) return null;
  const selected = await exec(XCODE_SELECT, ["-p"], { timeoutMs: XCODE_PROBE_TIMEOUT_MS });
  if (selected.code !== 0 || selected.stdout.trim() === "") return null;
  const sdk = await exec(XCRUN, ["--sdk", "macosx", "--show-sdk-path"], { timeoutMs: XCODE_PROBE_TIMEOUT_MS });
  const found = sdk.stdout.trim();
  const usable = sdk.code === 0 && path.isAbsolute(found) && !found.includes("\n");
  return usable ? found : null;
}

// ---------- the phones' store components ----------

/** The store's phone tools for one destination, realpath'd inside the store. */
export interface MobileStoreTools {
  /** The store JDK's `java` (Android only). */
  java: string | null;
  /** `bundletool.jar` (Android only). */
  bundletool: string | null;
  /** Each Rust standard library's install folder the destination builds with. */
  std: string[];
}

/** The Rust standard libraries' ids. */
type MobileStdId = keyof typeof MOBILE_COMPONENT_LAYOUT.std;
const isMobileStd = (id: ToolchainId): id is MobileStdId => Object.hasOwn(MOBILE_COMPONENT_LAYOUT.std, id);

/** The store-held components a phone destination needs: {@link RUST_MOBILE_COMPONENTS} less the person's SDK parts. */
export function mobileStoreComponents(target: MobileBuildTarget): ToolchainId[] {
  return RUST_MOBILE_COMPONENTS[target].filter((id) => !USER_SIDE_COMPONENTS.includes(id));
}

/** The file a store phone component's tool is, relative to its folder; null for one that has none. */
function mobileToolRel(id: ToolchainId, component: InstalledComponent): string | null {
  if (id === ToolchainId.Jdk) return MOBILE_COMPONENT_LAYOUT.java[layoutHost(component)];
  if (id === ToolchainId.Bundletool) return MOBILE_COMPONENT_LAYOUT.bundletool;
  return isMobileStd(id) ? MOBILE_COMPONENT_LAYOUT.std[id] : null;
}

/** `rel` under `folder` realpath'd inside `root`, or null when it is absent or a link leads out of the store. */
async function realInside(root: string, folder: string, rel: string): Promise<string | null> {
  const found = await real(folder, rel).catch(() => null);
  return found !== null && isInside(root, found) ? found : null;
}

/**
 * What one store phone component gives its lane: its tool (java, bundletool) or, for a standard
 * library, its install folder, realpath'd inside the store; null when it is absent from the lock
 * or the store, or its tool links out of the store.
 */
async function locateMobileComponent(root: string, lock: ToolchainLock, id: ToolchainId): Promise<string | null> {
  const component = await installedComponent(root, lock, id);
  const rel = component ? mobileToolRel(id, component) : null;
  if (!component || rel === null) return null;
  const tool = await realInside(root, component.folder, rel);
  if (tool === null || !isMobileStd(id)) return tool;
  return realpath(component.folder);
}

/**
 * The store's tools a phone destination's lane runs under `lock` (java and bundletool for
 * Android, the standard libraries for both), each realpath'd inside the store, or which components
 * are missing: absent from the lock or the store, or with a tool that links out of the store. The
 * person's SDK parts are never here: `android-sdk.ts` finds those.
 */
export async function locateMobileStoreTools(
  store: string,
  lock: ToolchainLock,
  target: MobileBuildTarget,
): Promise<{ ok: true; tools: MobileStoreTools } | { ok: false; missing: ToolchainId[] }> {
  const ids = mobileStoreComponents(target);
  const root = await realpath(store).catch(() => null);
  if (!root || !isToolchainLock(lock)) return { ok: false, missing: ids };
  const tools: MobileStoreTools = { java: null, bundletool: null, std: [] };
  const missing: ToolchainId[] = [];
  for (const id of ids) {
    const found = await locateMobileComponent(root, lock, id);
    if (found === null) missing.push(id);
    else if (id === ToolchainId.Jdk) tools.java = found;
    else if (id === ToolchainId.Bundletool) tools.bundletool = found;
    else tools.std.push(found);
  }
  return missing.length ? { ok: false, missing } : { ok: true, tools };
}
