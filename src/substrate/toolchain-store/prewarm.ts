/**
 * Prewarming a lock: the raylib prebuilds, the Emscripten cache and each destination's
 * genex.cmake, built under `ProcessSandbox.run` with the network off into `.staging/<lock>/` (the
 * one writable path), checked, then swapped into `locks/<lockDigest12>/` whole. A failed prewarm
 * leaves the store as it was. This file is the one implementation of the raylib recipe:
 * `scripts/toolchains/prebuild-raylib.ts` runs the same {@link raylibPrebuild} and
 * {@link crossRaylibPrebuild}.
 *
 * `ProcessSandbox` exports `TMPDIR=<scratch>` inside every wrapped command, and the overlay denies
 * scratch, so each command here sets `TMPDIR` to `<staging>/.tmp` itself. Emscripten runs with its
 * own cache (`EM_CACHE`), config (`EM_CONFIG`) and Python (`EMSDK_PYTHON`, never the system
 * `python3`), no sanity check and no bytecode: emcc starts Python with `-E`, which ignores
 * `PYTHONDONTWRITEBYTECODE`, so it is the store's write-deny that keeps `__pycache__` out of it.
 * No command names `embuilder`, `--use-port` or a fetching `-sUSE_*` port.
 *
 * A Mac prewarm (an Apple silicon Mac whose lock holds ANGLE) needs the Command Line Tools first
 * (`xcode-select -p`, then `xcrun`, unless the caller names the SDK; without them nothing runs),
 * then builds raylib twice: GLFW over ANGLE's EGL with raylib's own CMake, and the headless variant
 * from a build-tree copy of `src/` whose `platforms/rcore_memory.c` is Genex's headless platform,
 * with its own CMake list. The record keeps that file's sha256 (`platform`), so a changed one reads
 * as stale for the Mac only.
 *
 * Windows x64 and Linux x64 (a lock that names zig and their ANGLE, and for Linux the headers'
 * sysroot) are prewarmed on an Apple silicon Mac and a Linux x64 host: `toolchain-<cross>.cmake`
 * (zig as CMake's compiler, every find_* rooted in the lock folder and the sysroot), raylib's own
 * CMake building the prebuild with zig (its caches inside the work folder, `crossBuildEnv`; Linux
 * through the wayland-scanner stand-in written beside the build), then `genex-<target>.cmake`. The
 * record keeps `cross` (`crossPrewarmDigest`: the cross format, recipe and sysroot pin), so a
 * change to them reads as stale for Windows and Linux only.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { StudioPlatform } from "../../shared/boot.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { BUILD_TARGETS, BuildTarget } from "../../shared/game-project.ts";
import {
  REQUIRED_COMPONENTS,
  ToolchainError,
  ToolchainHost,
  ToolchainId,
  type ToolchainLock,
  ToolchainProblem,
  toolchainHostOf,
} from "../../shared/toolchain.ts";
import { isInside } from "../paths.ts";
import { type RunRequest, type RunResult, type SandboxOptions, type SandboxPolicy, shellQuote } from "../spawn.ts";
import {
  buildTargetOf,
  CROSS_TARGETS,
  CrossTarget,
  crossBuildEnv,
  crossGenexCmake,
  crossRaylibConfigure,
  crossRaylibProjectInclude,
  crossTargetOf,
  crossToolchainFile,
  crossZigCacheName,
  crossWaylandScanner,
} from "./cross-targets.ts";
import {
  assertNoRefusedFlag,
  cmakePath,
  genexCmake,
  HEADLESS_PLATFORM_FILE,
  headlessPlatformPath,
  headlessRaylibCmake,
  type Recipe,
  raylibCDefinitions,
  raylibFolder,
  raylibVariant,
  type RaylibVariant,
  readHeadlessPlatform,
  readRecipe,
  recipeSha12,
  targetRecipe,
} from "./genex-cmake.ts";
import { removeEmptyStaging, STAGING_FOLDER } from "./install.ts";
import {
  anglePaths,
  COMPONENT_LAYOUT,
  CROSS_ANGLE,
  crossPathsIn,
  crossPrewarmDigest,
  EM_CACHE_FOLDER,
  EMSCRIPTEN_CONFIG_FILE,
  execXcode,
  type InstalledComponent,
  type LocatedToolchain,
  lockFolder,
  lockOutputs,
  locateComponents,
  macSdkPath,
  PREWARM_FILE,
  RAYLIB_HEADERS,
  requiredFor,
  type XcodeExec,
} from "./locate.ts";
import { isToolchainLock, LOCKS_FOLDER, storeLockPaths } from "./lock.ts";

const MESSAGE = {
  NoStore: (store: string) => `The toolchain store ${store} does not exist.`,
  BadLock: "The lock is malformed, or its digest is not its entries'.",
  NotYet: (target: string) => `Prewarming ${target} is not supported yet.`,
  NotHere: (target: string) => `Prewarming ${target} needs a Mac.`,
  Missing: (ids: readonly string[]) => `The store is missing ${ids.join(", ")} for this lock.`,
  NoRaylib: "The lock names no raylib source to prebuild.",
  NoEmscripten: "A web prebuild needs the lock's Emscripten.",
  NoClt: "Building for the Mac needs Apple's Command Line Tools, and no macOS SDK was found.",
  NoAngle: "A Mac prebuild needs the lock's ANGLE.",
  NoPlatform: (file: string) => `The headless raylib platform ${file} is missing.`,
  NoCross: (target: string) => `A ${target} prebuild needs the lock's zig and its ANGLE.`,
  NoSysroot: "A Linux prebuild needs the lock's X11 and Wayland headers' sysroot.",
  LinuxOnWindows:
    "The Linux prebuild runs GLFW's wayland-scanner stand-in, a POSIX shell script, so it is not prewarmed on Windows.",
  StepFailed: (label: string, code: number | null, detail: string) => `${label} failed (exit ${code}): ${detail}`,
  MissingOutput: (rel: string) => `The prewarm did not produce ${rel}.`,
} as const;

/** The labels of the sandbox runs a prewarm makes, in order. */
export const PrewarmStep = {
  CloneCache: "prewarm:clone-cache",
  RaylibConfigure: "prewarm:raylib-configure",
  RaylibBuild: "prewarm:raylib-build",
  RaylibInstall: "prewarm:raylib-install",
  WarmCache: "prewarm:warm-cache",
  /** The headless variant's build-tree copy of raylib's `src/`, with Genex's platform in its place. */
  HeadlessSource: "prewarm:headless-source",
} as const;
export type PrewarmStep = (typeof PrewarmStep)[keyof typeof PrewarmStep];

/** `prewarm.json` in a lock's folder: what was built, from which recipe, and when. */
export interface PrewarmRecord {
  /** The lock's digest. */
  lock: string;
  /** {@link recipeSha12} of the recipe and the genex.cmake format it was built from. */
  recipe: string;
  /**
   * The sha256 of the headless platform file the Mac prebuild compiled; null when no Mac was
   * prewarmed (a web-only record from before the Mac lane has none), and then no Mac locates.
   */
  platform?: string | null;
  /**
   * `crossPrewarmDigest` of the cross format, recipe and Linux sysroot pin the Windows and Linux
   * outputs were built from; null when neither was prewarmed, and then neither locates.
   */
  cross?: string | null;
  /** Lock-folder-relative paths the prewarm produced. */
  outputs: string[];
  at: string;
}

/** What a prewarm is given: the sandbox, what it must never write, and the clock, injected. */
export interface PrewarmDeps {
  run: (request: RunRequest) => Promise<RunResult>;
  /** Folders no prewarm command may write besides the store: the games root, scratch and runs. */
  denyWrite: readonly string[];
  now?: () => number;
  signal?: AbortSignal;
  /** Each step's result as it finishes (the dev store records them as evidence). */
  onStep?: (label: string, result: RunResult) => void;
  /** The platform whose copy-on-write clone command to use, and whether a Mac prewarm can run (default: this one). */
  platform?: NodeJS.Platform;
  /**
   * The macOS SDK a Mac prewarm compiles against, or null without the Command Line Tools: a Mac
   * prewarm without it refuses `clt-missing` before any step (default: {@link macSdkPath} over `exec`).
   */
  macSdk?: () => Promise<string | null>;
  /** Runs `xcode-select -p` and `xcrun` for the default `macSdk`, outside the sandbox (default: `execFile`). */
  exec?: XcodeExec;
  /** The headless raylib platform file (default: the shipped one, `headlessPlatformPath`). */
  headlessPlatform?: string;
}

/** A prebuild or cache warm can take minutes on a cold disk; never an unbounded wait. */
const PREWARM_STEP_TIMEOUT_MS = 10 * MINUTE_MS;
const STEP_DETAIL_MAX_CHARS = 2000;

/** Per manifest host, the destinations its prewarm builds: zig cross-builds Windows and Linux from a Mac or Linux. */
const PREWARMED_BY_HOST = {
  [ToolchainHost.MacArm64]: BUILD_TARGETS,
  [ToolchainHost.LinuxX64]: [BuildTarget.Web, BuildTarget.Windows, BuildTarget.Linux],
  [ToolchainHost.WindowsX64]: [BuildTarget.Web],
} as const satisfies Record<ToolchainHost, readonly BuildTarget[]>;

/**
 * The destinations prewarm builds lock outputs for on a computer: the web everywhere; the Mac on an
 * Apple silicon Mac; Windows and Linux on an Apple silicon Mac and a Linux x64 host.
 */
export function prewarmedTargets(platform: string, arch: string): BuildTarget[] {
  const host = toolchainHostOf(platform, arch);
  return host ? [...PREWARMED_BY_HOST[host]] : [BuildTarget.Web];
}

/** The destinations prewarm builds lock outputs for on this computer. */
export const PREWARMED_TARGETS: readonly BuildTarget[] = Object.freeze(
  prewarmedTargets(process.platform, process.arch),
);

/**
 * Of `targets` (default: what this computer prewarms), the destinations whose every component
 * `lock` names: a lock without zig prewarms the web and the Mac as before, and no cross destination.
 */
export function prewarmableFor(
  lock: ToolchainLock,
  targets: readonly BuildTarget[] = PREWARMED_TARGETS,
): BuildTarget[] {
  return targets.filter((target) => REQUIRED_COMPONENTS[target].every((id) => lock.entries[id]));
}

const TMP_FOLDER = ".tmp";
const BUILD_FOLDER = ".build";
const WARM_FOLDER = ".warm";
/** Clang's module cache for the Mac prebuilds, under `<work>/.tmp` (the home folder's is not writable there). */
const MODULE_CACHE_FOLDER = "clang-module-cache";
/** zig's local cache for the cross prebuilds, under `<work>/.tmp` (`crossBuildEnv`). */
const ZIG_CACHE_FOLDER = "zig";
/** Beside a cross prebuild's build folder: raylib's project include and the wayland-scanner stand-in. */
const INCLUDE_SUFFIX = ".include.cmake";
const SCANNER_SUFFIX = ".wayland-scanner";
/** The wayland-scanner stand-in runs as a program: owner-writable, everyone may read and run it. */
const SCANNER_MODE = 0o755;
/** Beside a headless variant's build folder: its copy of raylib's `src/`, and the folder of its CMake list. */
const SOURCE_SUFFIX = ".src";
const LIST_SUFFIX = ".cmake";
/** A tiny raylib program: linking it warms the cache with everything a game's link needs. */
const WARM_SOURCE =
  '#include "raylib.h"\nint main(void) { InitWindow(16, 16, "genex prewarm"); CloseWindow(); return 0; }\n';

/**
 * The options of the sandbox prewarm (and an install's probes) run in: its own, never the core's
 * shared one. A per-run overlay only adds to a sandbox's writable roots, and the shared sandbox
 * writes workspaces, exports and every game folder and write-denies the whole store (which beats
 * the staging allow beneath it); with no writable root, {@link prewarmPolicy}'s staging folder and
 * this sandbox's own scratch are all a prewarm command can write.
 */
export function prewarmSandboxOptions(scratchDir: string, secretPaths: readonly string[]): SandboxOptions {
  return { writableRoots: [], scratchDir, secretPaths: [...secretPaths] };
}

/**
 * The sandbox overlay every prewarm command runs with: write only `.staging/<lockDigest>`, never
 * the games, scratch or runs folders, and never the store's installs, lock folders, any stack's
 * current lock or the lock records.
 * The store itself is not denied whole: a deny wins over an allow beneath it in both backends, so
 * the staging folder inside it would be denied too; a caller's deny that holds the staging (the
 * checkout around a developer's dev store) is dropped for the same reason.
 */
export function prewarmPolicy(store: string, lockDigest: string, denyWrite: readonly string[]): Partial<SandboxPolicy> {
  const staging = path.join(store, STAGING_FOLDER, lockDigest);
  return {
    allowedDomains: [],
    allowWrite: [staging],
    denyWrite: [
      ...denyWrite.filter((deny) => !isInside(deny, staging)),
      ...Object.values(ToolchainId).map((id) => path.join(store, id)),
      path.join(store, LOCKS_FOLDER),
      ...storeLockPaths(store),
    ],
  };
}

/** The environment every emcc run needs: its own cache, config and Python, no sanity check, no bytecode. */
export function emscriptenEnv(emscripten: NonNullable<LocatedToolchain["emscripten"]>): Record<string, string> {
  return {
    EM_CACHE: emscripten.cache,
    EM_CONFIG: emscripten.config,
    EMSDK_PYTHON: emscripten.python,
    EMCC_SKIP_SANITY_CHECK: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
}

/** `EM_CONFIG` for an emsdk install: its LLVM, Binaryen and Node. */
export function emscriptenConfig(emsdkFolder: string, node: string): string {
  const at = (rel: string) => JSON.stringify(path.join(emsdkFolder, ...rel.split("/")));
  return [
    `LLVM_ROOT = ${at(COMPONENT_LAYOUT.llvm)}`,
    `BINARYEN_ROOT = ${at(COMPONENT_LAYOUT.binaryen)}`,
    `NODE_JS = ${JSON.stringify(node)}`,
    "",
  ].join("\n");
}

/** A command that keeps its temporary files in `tmp` (the sandbox's own `TMPDIR` is denied here). */
function withTmp(tmp: string, argv: readonly string[]): string {
  const dir = shellQuote(tmp);
  return `export TMPDIR=${dir} TMP=${dir} TEMP=${dir}; ${argv.map(shellQuote).join(" ")}`;
}

/** The copy-on-write clone of a folder: `cp -c` (APFS clonefile) on a Mac, `--reflink=auto` on Linux. */
export function cloneArgv(platform: NodeJS.Platform, from: string, to: string): string[] {
  const flags = platform === StudioPlatform.Mac ? ["-c", "-R"] : ["-R", "--reflink=auto"];
  return ["cp", ...flags, from, to];
}

/** A C definition as `CMAKE_C_FLAGS` carries it: its quotes escaped, so the build's shell hands the compiler a C string. */
function cDefinitionFlag(definition: string): string {
  return `-D${definition.replaceAll('"', '\\"')}`;
}

/** raylib's own CMake definitions for a variant: the recipe's, every `SUPPORT_*` flag stated, offline. */
function raylibDefinitions(recipe: Recipe, variant: RaylibVariant): string[] {
  const cFlags = [...recipe.flags.compile, ...raylibCDefinitions(recipe, variant).map(cDefinitionFlag)];
  assertNoRefusedFlag(recipe, cFlags);
  const support = Object.keys(recipe.raylibConfig).sort();
  return [
    ...Object.entries(variant.cmake).map(([name, value]) => `-D${name}=${value}`),
    "-DFETCHCONTENT_FULLY_DISCONNECTED=ON",
    `-DCMAKE_C_FLAGS=${cFlags.join(" ")}`,
    ...support.map((flag) => `-D${flag}=${recipe.raylibConfig[flag] ? "ON" : "OFF"}`),
  ];
}

/** Where a raylib prebuild goes (`out`) and the folder its build and temporary files use (`work`). */
export interface PrebuildFolders {
  out: string;
  work: string;
}

/** What a Mac prebuild is given besides the toolchain. */
export interface PrebuildOptions {
  /** The macOS SDK a Mac variant compiles against (`CMAKE_OSX_SYSROOT`). */
  sdk?: string;
  /** The headless platform file a headless variant compiles in place of raylib's (`headless.replaces`). */
  platform?: string;
}

/** A prebuild: the files the host writes first (a headless variant's CMake list, a cross one's include and scanner), then the sandbox runs. */
export interface PrebuildPlan {
  /** `mode` for a file the build runs (the wayland-scanner stand-in). */
  files: Array<{ path: string; text: string; mode?: number }>;
  steps: RunRequest[];
}

/**
 * The Mac-only configure words: the SDK and, for raylib's own CMake, ANGLE's headers on every C
 * compile (a CMake list item, so never a path with `;`; the headless list names them itself).
 */
function macConfigure(variant: RaylibVariant, located: LocatedToolchain, options: PrebuildOptions): string[] {
  if (variant.target !== BuildTarget.Mac) return [];
  if (!options.sdk) throw new ToolchainError(ToolchainProblem.CltMissing, MESSAGE.NoClt);
  const sysroot = `-DCMAKE_OSX_SYSROOT=${options.sdk}`;
  if (!variant.angle || variant.headless) return [sysroot];
  if (!located.angle) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoAngle);
  const include = path.join(located.angle.dir, "include");
  cmakePath(include);
  return [sysroot, `-DCMAKE_C_STANDARD_INCLUDE_DIRECTORIES=${include}`];
}

/** Every run's environment: Emscripten's for the web, clang's module cache kept in `<work>/.tmp` for the Mac. */
function prebuildEnv(variant: RaylibVariant, located: LocatedToolchain, tmp: string): Record<string, string> {
  if (variant.target === BuildTarget.Web && located.emscripten) return emscriptenEnv(located.emscripten);
  if (variant.target === BuildTarget.Mac) return { CLANG_MODULE_CACHE_PATH: path.join(tmp, MODULE_CACHE_FOLDER) };
  return {};
}

/**
 * The headless variant's own parts: the sandbox run that copies raylib's `src/` into the build
 * tree with the platform file in place of `headless.replaces`, and the CMake list it configures.
 */
function headlessParts(
  variantName: string,
  located: LocatedToolchain,
  recipe: Recipe,
  paths: { source: string; build: string; tmp: string; platform?: string },
): { copy: string; list: { path: string; text: string }; listDir: string } {
  const headless = raylibVariant(recipe, variantName).headless;
  if (!headless || !paths.platform)
    throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoPlatform(HEADLESS_PLATFORM_FILE));
  if (!located.angle) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoAngle);
  const tree = `${paths.build}${SOURCE_SUFFIX}`;
  const listDir = `${paths.build}${LIST_SUFFIX}`;
  const replaced = path.join(tree, ...headless.replaces.split("/"));
  const copy = `${withTmp(paths.tmp, ["cp", "-R", path.join(paths.source, "src"), tree])} && ${["cp", paths.platform, replaced].map(shellQuote).join(" ")}`;
  const angleInclude = path.join(located.angle.dir, "include");
  const text = headlessRaylibCmake({ source: tree, angleInclude, variant: variantName, recipe });
  return { copy, list: { path: path.join(listDir, "CMakeLists.txt"), text }, listDir };
}

/**
 * The command that installs a raylib build into `out`: `lib/libraylib.a` from where raylib's
 * CMake (or the headless list) leaves it, and the three headers from raylib's `src/`.
 */
function installCommand(cmake: string, at: { source: string; build: string; out: string; tmp: string }): string {
  const headers = RAYLIB_HEADERS.map((header) => path.join(at.source, "src", header));
  const library = path.join(at.build, "raylib", "libraylib.a");
  return [
    withTmp(at.tmp, [cmake, "-E", "make_directory", path.join(at.out, "lib"), path.join(at.out, "include")]),
    [cmake, "-E", "copy", library, path.join(at.out, "lib", "libraylib.a")].map(shellQuote).join(" "),
    [cmake, "-E", "copy", ...headers, path.join(at.out, "include")].map(shellQuote).join(" "),
  ].join(" && ");
}

/**
 * The fixed-argv sandbox runs that build one raylib variant into `folders.out` (configure, build,
 * install `lib/libraylib.a` and the three headers), and for a headless variant the build-tree copy
 * first and the CMake list the host writes. The build folder is `<work>/.build/<out's name>` and
 * temporary files go to `<work>/.tmp`; both folders are all the runs write.
 */
export function raylibPrebuild(
  variantName: string,
  located: LocatedToolchain,
  recipe: Recipe,
  folders: PrebuildFolders,
  options: PrebuildOptions = {},
): PrebuildPlan {
  const source = located.raylibSource;
  if (!source) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoRaylib);
  const variant = raylibVariant(recipe, variantName);
  const web = variant.target === BuildTarget.Web;
  if (web && !located.emscripten) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoEmscripten);
  const { out: outDir, work } = folders;
  const tmp = path.join(work, TMP_FOLDER);
  const build = path.join(work, BUILD_FOLDER, path.basename(outDir));
  const toolchain = web && located.emscripten ? [`-DCMAKE_TOOLCHAIN_FILE=${located.emscripten.toolchainFile}`] : [];
  const common = { cwd: work, env: prebuildEnv(variant, located, tmp), timeoutMs: PREWARM_STEP_TIMEOUT_MS };
  const cmake = located.cmake;
  const mac = macConfigure(variant, located, options);
  const headless = variant.headless
    ? headlessParts(variantName, located, recipe, { source, build, tmp, ...options })
    : null;
  const definitions = headless
    ? [
        ...Object.entries(variant.cmake).map(([name, value]) => `-D${name}=${value}`),
        "-DFETCHCONTENT_FULLY_DISCONNECTED=ON",
      ]
    : raylibDefinitions(recipe, variant);
  const configure = [
    cmake,
    "-S",
    headless?.listDir ?? source,
    "-B",
    build,
    "-G",
    "Ninja",
    `-DCMAKE_MAKE_PROGRAM=${located.ninja}`,
    ...toolchain,
    ...definitions,
    ...mac,
  ];
  const install = installCommand(cmake, { source, build, out: outDir, tmp });
  const copy = headless ? [{ ...common, label: PrewarmStep.HeadlessSource, command: headless.copy }] : [];
  return {
    files: headless ? [headless.list] : [],
    steps: [
      ...copy,
      { ...common, label: PrewarmStep.RaylibConfigure, command: withTmp(tmp, configure) },
      { ...common, label: PrewarmStep.RaylibBuild, command: withTmp(tmp, [cmake, "--build", build]) },
      { ...common, label: PrewarmStep.RaylibInstall, command: install },
    ],
  };
}

/** What a cross prebuild is told about the host it runs on. */
export interface CrossPrebuildOptions {
  /** The host platform (default: this one): the Linux prebuild's scanner never runs on Windows. */
  platform?: NodeJS.Platform;
}

/** The cross destination's located parts a prebuild needs, or a typed refusal naming what is missing. */
function crossParts(target: CrossTarget, located: LocatedToolchain, platform: NodeJS.Platform) {
  const buildTarget = buildTargetOf(target);
  const parts = located.cross?.[buildTarget];
  const source = located.raylibSource;
  if (!source) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoRaylib);
  if (!located.zig || !parts) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoCross(buildTarget));
  if (target !== CrossTarget.LinuxX64) return { source, parts, sysroot: null };
  if (platform === StudioPlatform.Windows)
    throw new ToolchainError(ToolchainProblem.UnsupportedHost, MESSAGE.LinuxOnWindows);
  if (!parts.sysroot) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoSysroot);
  return { source, parts, sysroot: parts.sysroot };
}

/**
 * The runs that build a cross destination's raylib prebuild into `folders.out` with zig, through
 * raylib's own CMake and the lock's `toolchain-<cross>.cmake` (`located.cross`): the host first
 * writes raylib's project include (GLFW's ANGLE library names, ANGLE's and the sysroot's headers)
 * and, for Linux, the executable wayland-scanner stand-in over the sysroot's protocol code, both
 * beside the build folder `<work>/.build/<out's name>`; every run keeps zig's global cache in
 * `<work>/zig-cache-<cross>` (a lock output) and its local cache and temporary files in `<work>/.tmp`.
 */
export function crossRaylibPrebuild(
  target: CrossTarget,
  located: LocatedToolchain,
  recipe: Recipe,
  folders: PrebuildFolders,
  options: CrossPrebuildOptions = {},
): PrebuildPlan {
  const { source, parts, sysroot } = crossParts(target, located, options.platform ?? process.platform);
  const { out, work } = folders;
  const tmp = path.join(work, TMP_FOLDER);
  const build = path.join(work, BUILD_FOLDER, path.basename(out));
  const projectInclude = `${build}${INCLUDE_SUFFIX}`;
  const angle = parts.angle.dir;
  const files: PrebuildPlan["files"] = [
    {
      path: projectInclude,
      text: crossRaylibProjectInclude(target, {
        lock: located.lock,
        zig: located.zig,
        angle,
        ...(sysroot ? { sysroot } : {}),
      }),
    },
  ];
  const waylandScanner = sysroot ? `${build}${SCANNER_SUFFIX}` : undefined;
  if (sysroot && waylandScanner) {
    const protocols = path.join(sysroot, ...COMPONENT_LAYOUT.linuxProtocols.split("/"));
    files.push({ path: waylandScanner, text: crossWaylandScanner(protocols), mode: SCANNER_MODE });
  }
  const { cmake, ninja } = located;
  const toolchainFile = parts.toolchainFile;
  const args = { source, build, ninja, toolchainFile, projectInclude, angle, recipe };
  const configure = [cmake, ...crossRaylibConfigure(target, waylandScanner ? { ...args, waylandScanner } : args)];
  const common = {
    cwd: work,
    // The global cache (the target's libc and libc++) stays in the lock folder for new build
    // folders to start from; the local one, raylib's own objects, goes with `.tmp`.
    env: crossBuildEnv(path.join(work, crossZigCacheName(target)), undefined, path.join(tmp, ZIG_CACHE_FOLDER)),
    timeoutMs: PREWARM_STEP_TIMEOUT_MS,
  };
  return {
    files,
    steps: [
      { ...common, label: PrewarmStep.RaylibConfigure, command: withTmp(tmp, configure) },
      { ...common, label: PrewarmStep.RaylibBuild, command: withTmp(tmp, [cmake, "--build", build]) },
      { ...common, label: PrewarmStep.RaylibInstall, command: installCommand(cmake, { source, build, out, tmp }) },
    ],
  };
}

/** What one prewarm works with. */
interface Prewarming {
  root: string;
  lock: ToolchainLock;
  staging: string;
  final: string;
  recipe: Recipe;
  deps: PrewarmDeps;
  policy: Partial<SandboxPolicy>;
  /** The headless platform file's bytes for a Mac prewarm (null otherwise), whose sha256 the record keeps. */
  platform: Buffer | null;
  /** The macOS SDK a Mac prewarm compiles against. */
  sdk: string | null;
}

async function runStep(context: Prewarming, request: RunRequest): Promise<void> {
  const { deps } = context;
  // A build tool's helpers (a compiler server, a stray child) die with the step's process group.
  const result = await deps.run({ ...request, policy: context.policy, signal: deps.signal, reapGroup: true });
  deps.onStep?.(request.label ?? "", result);
  deps.signal?.throwIfAborted();
  if (result.code === 0 && !result.timedOut) return;
  const detail = (result.stderr || result.stdout).slice(-STEP_DETAIL_MAX_CHARS);
  throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.StepFailed(request.label ?? "", result.code, detail));
}

/**
 * The toolchain a prebuild in `work` runs with: the installed components, with Emscripten's
 * config and cache being `work`'s own copies (a prewarm's staging folder, or the prebuild
 * script's output folder), the store's ANGLE when the lock holds one, and zig with each cross
 * destination whose ANGLE it holds (its toolchain file named in `work`, where the caller writes it).
 */
export async function toolchainIn(
  work: string,
  lock: ToolchainLock,
  components: ReadonlyMap<ToolchainId, InstalledComponent>,
): Promise<LocatedToolchain> {
  const part = (id: ToolchainId) => components.get(id)?.folder ?? "";
  const emsdk = components.get(ToolchainId.Emsdk);
  const angle = components.get(ToolchainId.AngleMac);
  const zig = components.get(ToolchainId.Zig);
  const angled = BUILD_TARGETS.filter((target) => {
    const name = crossTargetOf(target);
    return name !== null && components.has(CROSS_ANGLE[name]);
  });
  const cross = await crossPathsIn(work, angled, components);
  const host = emsdk?.receipt.host ?? components.get(ToolchainId.Cmake)?.receipt.host;
  const layoutHost = host ?? ToolchainHost.MacArm64;
  const inEmsdk = (rel: string) => path.join(part(ToolchainId.Emsdk), ...rel.split("/"));
  return {
    lock,
    cmake: path.join(part(ToolchainId.Cmake), ...COMPONENT_LAYOUT.cmake[layoutHost].split("/")),
    ninja: path.join(part(ToolchainId.Ninja), ...COMPONENT_LAYOUT.ninja[layoutHost].split("/")),
    emscripten: emsdk
      ? {
          root: inEmsdk(COMPONENT_LAYOUT.emscripten),
          toolchainFile: inEmsdk(COMPONENT_LAYOUT.emscriptenToolchainFile),
          python: inEmsdk(COMPONENT_LAYOUT.python[layoutHost]),
          node: inEmsdk(COMPONENT_LAYOUT.node[layoutHost]),
          config: path.join(work, EMSCRIPTEN_CONFIG_FILE),
          cache: path.join(work, EM_CACHE_FOLDER),
        }
      : null,
    genexCmake: {},
    raylibSource: part(ToolchainId.RaylibSource),
    angle: angle ? await anglePaths(angle) : null,
    ...(zig ? { zig: path.join(zig.folder, ...COMPONENT_LAYOUT.zig[zig.receipt.host ?? layoutHost].split("/")) } : {}),
    ...(cross ? { cross } : {}),
  };
}

/**
 * The run that clones emsdk's shipped cache into `located`'s own (copy-on-write where the disk
 * can), keeping temporary files in `<work>/.tmp`.
 */
export function cacheCloneRequest(
  located: LocatedToolchain,
  emsdkFolder: string,
  work: string,
  platform: NodeJS.Platform,
): RunRequest {
  const emscripten = located.emscripten;
  if (!emscripten) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoEmscripten);
  const shipped = path.join(emsdkFolder, ...COMPONENT_LAYOUT.emscriptenCache.split("/"));
  const clone = cloneArgv(platform, shipped, emscripten.cache);
  return {
    label: PrewarmStep.CloneCache,
    cwd: work,
    timeoutMs: PREWARM_STEP_TIMEOUT_MS,
    command: withTmp(path.join(work, TMP_FOLDER), clone),
  };
}

/** Writes a prebuild's files (host-side, in staging), then runs its steps under the sandbox. */
async function runPrebuild(context: Prewarming, plan: PrebuildPlan): Promise<void> {
  for (const file of plan.files) {
    await mkdir(path.dirname(file.path), { recursive: true });
    await writeFile(file.path, file.text, { mode: file.mode });
  }
  for (const request of plan.steps) await runStep(context, request);
}

/** Where a variant's prebuild lands once the lock folder is swapped in. */
function finalPrebuild(context: Prewarming, variant: string): { lib: string; include: string } {
  const folder = path.join(context.final, `raylib-${variant}`);
  return { lib: path.join(folder, "lib", "libraylib.a"), include: path.join(folder, "include") };
}

/** The web prewarm: cache clone, config, raylib, genex-web.cmake, then a warming link. */
async function prewarmWeb(context: Prewarming, located: LocatedToolchain, emsdkFolder: string): Promise<void> {
  const { staging, recipe } = context;
  const emscripten = located.emscripten;
  if (!emscripten) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoEmscripten);
  await mkdir(path.join(staging, WARM_FOLDER), { recursive: true });
  await writeFile(path.join(staging, WARM_FOLDER, "warm.c"), WARM_SOURCE);
  await runStep(context, cacheCloneRequest(located, emsdkFolder, staging, context.deps.platform ?? process.platform));
  await writeFile(emscripten.config, emscriptenConfig(emsdkFolder, emscripten.node));
  const variant = targetRecipe(recipe, BuildTarget.Web).raylib;
  const folders = { out: path.join(staging, raylibFolder(recipe, BuildTarget.Web)), work: staging };
  await runPrebuild(context, raylibPrebuild(variant, located, recipe, folders));
  await writeFile(
    path.join(staging, `genex-${BuildTarget.Web}.cmake`),
    genexCmake(BuildTarget.Web, { lock: context.lock, raylib: finalPrebuild(context, variant), recipe }),
  );
  await runStep(context, warmRequest(context, emscripten, folders.out));
}

/**
 * The Mac prewarm: the windowed raylib over ANGLE, the headless one from the build-tree copy
 * (the platform file staged first, so the bytes the record's digest names are the ones built),
 * then genex-macos.cmake naming both prebuilds' final paths and the store's own ANGLE.
 */
async function prewarmMac(context: Prewarming, located: LocatedToolchain): Promise<void> {
  const { staging, recipe, sdk, platform } = context;
  const mac = targetRecipe(recipe, BuildTarget.Mac);
  const { headless } = mac;
  if (!sdk) throw new ToolchainError(ToolchainProblem.CltMissing, MESSAGE.NoClt);
  if (!headless || !platform)
    throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoPlatform(HEADLESS_PLATFORM_FILE));
  if (!located.angle) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoAngle);
  const staged = path.join(staging, BUILD_FOLDER, HEADLESS_PLATFORM_FILE);
  await mkdir(path.dirname(staged), { recursive: true });
  await writeFile(staged, platform);
  for (const variant of [mac.raylib, headless.raylib]) {
    const folders = { out: path.join(staging, `raylib-${variant}`), work: staging };
    await runPrebuild(context, raylibPrebuild(variant, located, recipe, folders, { sdk, platform: staged }));
  }
  await writeFile(
    path.join(staging, `genex-${BuildTarget.Mac}.cmake`),
    genexCmake(BuildTarget.Mac, {
      lock: context.lock,
      raylib: finalPrebuild(context, mac.raylib),
      headless: finalPrebuild(context, headless.raylib),
      angle: located.angle.dir,
      recipe,
    }),
  );
}

/**
 * A cross destination's prewarm: `toolchain-<cross>.cmake` (rooted in the final lock folder, and the
 * sysroot for Linux), the raylib prebuild with zig through it, then `genex-<target>.cmake` naming the
 * prebuild's final paths and the store's own ANGLE.
 */
async function prewarmCross(context: Prewarming, located: LocatedToolchain, cross: CrossTarget): Promise<void> {
  const { staging, final, recipe, lock } = context;
  const target = buildTargetOf(cross);
  const parts = located.cross?.[target];
  if (!located.zig || !parts) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoCross(target));
  const sysroot = parts.sysroot === undefined ? {} : { sysroot: parts.sysroot };
  await writeFile(parts.toolchainFile, crossToolchainFile(cross, { lock, zig: located.zig, root: final, ...sysroot }));
  const variant = CROSS_TARGETS[cross].raylib;
  const folders = { out: path.join(staging, `raylib-${variant}`), work: staging };
  const options = { platform: context.deps.platform ?? process.platform };
  await runPrebuild(context, crossRaylibPrebuild(cross, located, recipe, folders, options));
  await writeFile(
    path.join(staging, `genex-${target}.cmake`),
    crossGenexCmake(cross, { lock, raylib: finalPrebuild(context, variant), angle: parts.angle.dir, recipe }),
  );
}

function warmRequest(
  context: Prewarming,
  emscripten: NonNullable<LocatedToolchain["emscripten"]>,
  prebuild: string,
): RunRequest {
  const warm = path.join(context.staging, WARM_FOLDER);
  const web = targetRecipe(context.recipe, BuildTarget.Web);
  const argv = [
    path.join(emscripten.root, "emcc"),
    "-v",
    "-O2",
    ...context.recipe.flags.compile,
    ...web.definitions.map((definition) => `-D${definition}`),
    `-I${path.join(prebuild, "include")}`,
    path.join(warm, "warm.c"),
    path.join(prebuild, "lib", "libraylib.a"),
    "-o",
    path.join(warm, "index.html"),
    ...web.link,
  ];
  return {
    label: PrewarmStep.WarmCache,
    cwd: warm,
    env: emscriptenEnv(emscripten),
    timeoutMs: PREWARM_STEP_TIMEOUT_MS,
    command: withTmp(path.join(context.staging, TMP_FOLDER), argv),
  };
}

/** Every expected output is in staging (the library not empty); the scratch folders are removed. */
async function checkOutputs(context: Prewarming, targets: readonly BuildTarget[]): Promise<string[]> {
  const outputs = [...new Set(targets.flatMap((target) => lockOutputs(target, context.recipe)))].sort();
  for (const rel of outputs) {
    const info = await lstat(path.join(context.staging, ...rel.split("/"))).catch(() => null);
    const empty = rel.endsWith(".a") && (info?.size ?? 0) === 0;
    if (!info || empty) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.MissingOutput(rel));
  }
  for (const folder of [BUILD_FOLDER, TMP_FOLDER, WARM_FOLDER])
    await rm(path.join(context.staging, folder), { recursive: true, force: true });
  return outputs;
}

/** Renames staging over the lock folder, putting a previous one back if the rename fails. */
async function swapLockFolder(staging: string, final: string): Promise<void> {
  await mkdir(path.dirname(final), { recursive: true });
  const previous = `${staging}.previous`;
  const hadPrevious = await lstat(final).then(
    () => true,
    () => false,
  );
  if (hadPrevious) await rename(final, previous);
  try {
    await rename(staging, final);
  } catch (error) {
    if (hadPrevious) await rename(previous, final);
    throw error;
  }
  if (hadPrevious) await rm(previous, { recursive: true, force: true });
}

/**
 * Refuses a destination no prewarm here can build: one neither the recipe nor the cross table
 * knows, the Mac off a Mac, or Linux on Windows (its scanner stand-in is a POSIX shell script).
 */
function assertPrewarmable(targets: readonly BuildTarget[], recipe: Recipe, platform: NodeJS.Platform): void {
  const unknown = targets.find((target) => !recipe.targets[target] && crossTargetOf(target) === null);
  if (unknown) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NotYet(unknown));
  if (targets.includes(BuildTarget.Mac) && platform !== StudioPlatform.Mac)
    throw new ToolchainError(ToolchainProblem.UnsupportedHost, MESSAGE.NotHere(BuildTarget.Mac));
  if (targets.includes(BuildTarget.Linux) && platform === StudioPlatform.Windows)
    throw new ToolchainError(ToolchainProblem.UnsupportedHost, MESSAGE.LinuxOnWindows);
}

/**
 * Everything checked before a step runs: the store, the lock, the destinations, the components,
 * and for the Mac the Command Line Tools and the headless platform file.
 */
async function prepare(store: string, lock: ToolchainLock, targets: readonly BuildTarget[], deps: PrewarmDeps) {
  const root = await realpath(store).catch(() => {
    throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoStore(store));
  });
  if (!isToolchainLock(lock)) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.BadLock);
  const recipe = readRecipe();
  assertPrewarmable(targets, recipe, deps.platform ?? process.platform);
  const found = await locateComponents(root, lock, requiredFor(targets));
  if (!found.ok) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.Missing(found.missing));
  const { sdk, platform } = await macParts(targets, deps);
  const context: Prewarming = {
    root,
    lock,
    staging: path.join(root, STAGING_FOLDER, lock.digest),
    final: lockFolder(root, lock),
    recipe,
    deps,
    policy: prewarmPolicy(root, lock.digest, deps.denyWrite),
    platform,
    sdk,
  };
  return { context, components: found.components };
}

/**
 * A Mac prewarm's SDK and headless platform bytes, each refused before any step when missing;
 * nothing is asked or read for a prewarm without the Mac.
 */
async function macParts(
  targets: readonly BuildTarget[],
  deps: PrewarmDeps,
): Promise<{ sdk: string | null; platform: Buffer | null }> {
  if (!targets.includes(BuildTarget.Mac)) return { sdk: null, platform: null };
  const platformName = deps.platform ?? process.platform;
  const macSdk = deps.macSdk ?? (() => macSdkPath(deps.exec ?? execXcode, platformName));
  const sdk = await macSdk();
  if (!sdk) throw new ToolchainError(ToolchainProblem.CltMissing, MESSAGE.NoClt);
  const file = deps.headlessPlatform ?? headlessPlatformPath();
  const platform = await readHeadlessPlatform(file);
  if (!platform) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoPlatform(file));
  return { sdk, platform };
}

/** The cross destinations among `targets`, in the table's order. */
function crossTargets(targets: readonly BuildTarget[]): CrossTarget[] {
  return Object.values(CrossTarget).filter((cross) => targets.includes(buildTargetOf(cross)));
}

/** The sha256 of the headless platform bytes this prewarm built from, or null when it built no Mac. */
function recordedPlatform(context: Prewarming): string | null {
  return context.platform && createHash("sha256").update(context.platform).digest("hex");
}

/** Prewarms `lock` for `targets`; answers the record it swapped in. */
export async function prewarm(
  store: string,
  lock: ToolchainLock,
  targets: readonly BuildTarget[],
  deps: PrewarmDeps,
): Promise<PrewarmRecord> {
  const { context, components } = await prepare(store, lock, targets, deps);
  const { staging } = context;
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.join(staging, TMP_FOLDER), { recursive: true });
  try {
    const located = await toolchainIn(staging, lock, components);
    if (targets.includes(BuildTarget.Web))
      await prewarmWeb(context, located, components.get(ToolchainId.Emsdk)?.folder ?? "");
    if (targets.includes(BuildTarget.Mac)) await prewarmMac(context, located);
    for (const cross of crossTargets(targets)) await prewarmCross(context, located, cross);
    const record: PrewarmRecord = {
      lock: lock.digest,
      recipe: recipeSha12(context.recipe),
      platform: recordedPlatform(context),
      cross: crossTargets(targets).length > 0 ? crossPrewarmDigest(context.recipe) : null,
      outputs: await checkOutputs(context, targets),
      at: new Date((deps.now ?? Date.now)()).toISOString(),
    };
    await writeFile(path.join(staging, PREWARM_FILE), `${JSON.stringify(record, null, 2)}\n`);
    await swapLockFolder(staging, context.final);
    await removeEmptyStaging(context.root);
    return record;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    await removeEmptyStaging(context.root);
    deps.signal?.throwIfAborted();
    if (error instanceof ToolchainError) throw error;
    throw new ToolchainError(ToolchainProblem.Prewarm, String(error));
  }
}
