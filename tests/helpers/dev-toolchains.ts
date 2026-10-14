/**
 * The one place tests learn where the developer's pinned toolchains are and whether a row that
 * needs one is required. The toolchains are an input, never an action: nothing here downloads.
 *
 * - `GENEX_DEV_TOOLCHAINS` names the folder; the default is `<repo>/.studio-dev/toolchains`.
 * - A row that needs an absent tool is skipped with `not run: <tool> absent`: the CI runner that
 *   has none of them relies on that skip for good.
 * - `GENEX_REQUIRE_TOOLCHAINS=1` turns that skip into a failure naming the tool, so a developer
 *   who has the tools cannot pass a real-build row by not running it.
 * - {@link privateEmscripten} gives one emcc run its own cache, config and Python, so the shared
 *   emsdk is never written.
 * - `needsPrewarmed(...targets)` skips (or, required, fails) a row whose destination the derived
 *   dev store has not prewarmed for its lock.
 * - The dev store's lock is per worktree ({@link devStoreLockFile}): `GENEX_DEV_STORE_LOCK`, else
 *   `<repo>/.studio-dev/dev-store-lock.json` when it exists, else the store's `current-lock.json`.
 *   One store holds every worktree's components and lock folders side by side; nothing here
 *   writes a lock file.
 * - `needsCrossPackage(target)` and `needsDocker(image)` gate the rows that read the head start's
 *   real cross packages or run a Docker image, with the same skip-or-required rule.
 * - The Rust rows: `GENEX_RUST_TOOLCHAIN_DIR` names the pinned Rust folder (sysroot, vendored
 *   crates, wasm-bindgen, binaryen; default `<repo>/.studio-dev/spike-toolchain`, which
 *   `scripts/spike/rust-wgpu/setup-toolchain.sh` fills); `needsRustTools(...names)` gates a row on
 *   its tools and `needsRustPrewarmed(...targets)` on the Rust dev store's prewarm for its own lock
 *   ({@link devStoreRustLockFile}: `GENEX_DEV_STORE_RUST_LOCK`, else
 *   `<repo>/.studio-dev/dev-store-rust-lock.json`, else the store's `current-lock.rust-wgpu.json`),
 *   with the same skip-or-required rule.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import { LOCK_FILE_OF_STACK, type ToolchainLock } from "../../src/shared/toolchain.ts";
import { shellQuote } from "../../src/substrate/shell-quote.ts";
import { crossPrewarmDigest } from "../../src/substrate/toolchain-store/locate.ts";
import { CURRENT_LOCK_FILE, isToolchainLock, LOCKS_FOLDER } from "../../src/substrate/toolchain-store/lock.ts";
import { RUST_PREWARM_FILE, RustStoreFolder } from "../../src/substrate/toolchain-store/rust-locate.ts";

/** The destinations zig cross-builds, whose prewarm the cross format also decides. */
const CROSS_DESTINATIONS: ReadonlySet<string> = new Set<string>([BuildTarget.Windows, BuildTarget.Linux]);

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));

/** Every tool a real-build row may name, as a path under the toolchains folder (`/`-separated). */
export const DEV_TOOL = {
  cmake: "cmake-4.4.3/CMake.app/Contents/bin/cmake",
  ninja: "ninja-1.13.2/ninja",
  emsdk: "emsdk-6.0.10",
  emcc: "emsdk-6.0.10/install/emscripten/emcc",
  emsdkPython: "emsdk-6.0.10/python/python-3.13.3-0/bin/python3",
  emsdkNode: "emsdk-6.0.10/node/bin/node",
  /** Emscripten's shipped cache (a 600 MB sysroot): cloned for a run, never written. */
  emscriptenCache: "emsdk-6.0.10/install/emscripten/cache",
  /** The raylib 6.0 source, a git checkout (`dbc56a87`). */
  raylib: "raylib-6.0",
  /** The raylib 6.0 tag's source archive, as the manifest pins it. */
  raylibArchive: "downloads/raylib-6.0.tar.gz",
  zig: "zig-0.16.0/zig",
  llvmMingw: "llvm-mingw-20260922",
  /**
   * The CI-built Metal-only ANGLE every Genex build bundles (native/angle/bundle-lock.json):
   * `libEGL.dylib`, `libGLESv2.dylib`, `include/`, `manifest.json`.
   */
  angleMac: "angle-macos-arm64-metal/c5bf49e78850",
  /** The CI-built D3D11-only ANGLE for Windows, with its `manifest.json`. */
  angleWindows: "angle-windows-x64-d3d11/c5bf49e78850",
  /** The CI-built Vulkan + SwiftShader ANGLE for Linux, with its `manifest.json`. */
  angleLinux: "angle-linux-x64-vulkan/c5bf49e78850",
  /** AlmaLinux 8's X11 and Wayland headers (and link-time libraries), as the head start fetched them. */
  sysrootX11: "sysroot-linux-x64-x11",
  /** GLFW's Wayland protocol code, generated once by AlmaLinux 8's wayland-scanner. */
  glfwWayland: "glfw-wayland-fc7a27ac010b",
  /** The Linux sysroot `scripts/toolchains/linux-sysroot.ts` builds from the two above, zig and the cpal/gilrs link stubs. */
  linuxSysroot: "linux-sysroot-x64/8031a635e032",
  /** zig 0.16.0 for linux-x64, not unpacked: Linux compile checks unpack it into their own scratch. */
  zigLinuxArchive: "downloads/zig-x86_64-linux-0.16.0.tar.xz",
  sha256sums: "SHA256SUMS",
  downloads: "downloads",
  /** The store in the product's own layout, derived by `scripts/toolchains/dev-store.ts`. */
  devStore: "dev-store",
} as const;
export type DevToolName = keyof typeof DEV_TOOL;

/** Every Rust tool a real-build row may name, as a path under the Rust toolchain folder (`/`-separated). */
export const DEV_RUST_TOOL = {
  cargo: "sysroot/bin/cargo",
  rustc: "sysroot/bin/rustc",
  clippy: "sysroot/bin/cargo-clippy",
  /** The vendored crate tree every offline build resolves from. */
  vendor: "vendor",
  wasmBindgen: "tools/bin/wasm-bindgen",
  wasmOpt: "tools/binaryen/bin/wasm-opt",
  /** The pinned dist tarballs and release archives, as `setup-toolchain.sh` fetched them. */
  downloads: "downloads",
} as const;
export type DevRustToolName = keyof typeof DEV_RUST_TOOL;

/**
 * The file a tool folder must hold to count as present. The dev store is one folder for every
 * stack: a worktree that derived only the Rust stack's parts has the folder but not the C++
 * store's current lock, and every row that names `devStore` builds against that lock.
 */
const PRESENT_WHEN_HOLDING: Partial<Record<DevToolName, readonly string[]>> = {
  devStore: [CURRENT_LOCK_FILE],
};

/** A tool's path, or why the row that needs it does not run. */
export type DevToolLookup = { path: string } | { skip: string };

/** A destination the head start cross-built on a Mac. */
export type CrossPackageTarget = typeof BuildTarget.Windows | typeof BuildTarget.Linux;
/** The head start's real cross packages, under `<repo>/.studio-dev/cross-build-work/<folder>/package`. */
const CROSS_PACKAGE_FOLDER = {
  [BuildTarget.Windows]: "windows-x64",
  [BuildTarget.Linux]: "linux-x64",
} as const satisfies Record<CrossPackageTarget, string>;
/** The per-worktree lock file, under the repository. */
const WORKTREE_LOCK = [".studio-dev", "dev-store-lock.json"] as const;
/** The per-worktree Rust lock file, under the repository. */
const WORKTREE_RUST_LOCK = [".studio-dev", "dev-store-rust-lock.json"] as const;
/** The Rust toolchain folder's default, under the repository. */
const RUST_TOOLCHAIN_DIR = [".studio-dev", "spike-toolchain"] as const;
/** How long `docker image inspect` may take before the row counts Docker as absent. */
const DOCKER_INSPECT_TIMEOUT_MS = 15_000;
/** A Docker image reference: a lowercase name (registry and path), an optional tag and an optional digest. */
const DOCKER_IMAGE = /^[a-z0-9][a-z0-9._/-]{0,199}(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/;

/** The toolchains one environment names. */
export interface DevToolchains {
  /** The toolchains folder. */
  root: string;
  /** `GENEX_REQUIRE_TOOLCHAINS=1`: an absent tool fails its row instead of skipping it. */
  required: boolean;
  devTool(name: DevToolName): DevToolLookup;
  /** `node:test` options for a row that needs `names`: `{}`, a skip naming the first absent one, or a throw when required. */
  needsTools(...names: DevToolName[]): { skip?: string };
  /** The same for destinations the dev store must have prewarmed for its lock ({@link devStoreLockFile}'s). */
  needsPrewarmed(...targets: BuildTarget[]): { skip?: string };
  /** The lock file the dev store's real rows build with. */
  lockFile(): string;
  /** That lock, or null when the file is missing, not JSON or not a well-formed lock. Reads only. */
  lock(): Promise<ToolchainLock | null>;
  /** The head start's real package for a cross destination, or why the row that needs it does not run. */
  crossPackage(target: CrossPackageTarget): DevToolLookup;
  /** `node:test` options for a row that needs those packages (throws under `GENEX_REQUIRE_TOOLCHAINS=1`). */
  needsCrossPackage(...targets: CrossPackageTarget[]): { skip?: string };
  /** `node:test` options for a row that runs `image` in Docker: the CLI answers and the image is pulled (throws when required). */
  needsDocker(image: string): { skip?: string };
  /** The pinned Rust toolchain folder (`GENEX_RUST_TOOLCHAIN_DIR`). */
  rustRoot: string;
  devRustTool(name: DevRustToolName): DevToolLookup;
  /** `node:test` options for a row that needs these Rust tools (throws when required). */
  needsRustTools(...names: DevRustToolName[]): { skip?: string };
  /** The Rust lock file the dev store's real rows build with ({@link devStoreRustLockFile}). */
  rustLockFile(): string;
  /** `node:test` options for a row that needs these destinations prewarmed in the Rust dev store (throws when required). */
  needsRustPrewarmed(...targets: BuildTarget[]): { skip?: string };
}

/** Where a devToolchains instance looks for the repository's own files (the worktree's lock, the cross packages). */
export interface DevToolchainsOptions {
  repo?: string;
}

const MESSAGE = {
  absent: (name: DevToolName) => `not run: ${name} absent`,
  required: (name: DevToolName, where: string) =>
    `GENEX_REQUIRE_TOOLCHAINS=1: ${name} absent at ${where}; populate the dev toolchains (tracker) or unset it`,
  cacheTaken: (cache: string) => `a private em-cache is used by one run only; ${cache} already exists`,
  notPrewarmed: (target: BuildTarget) => `not run: dev store has no ${target} prewarm`,
  prewarmRequired: (target: BuildTarget, lockFile: string) =>
    `GENEX_REQUIRE_TOOLCHAINS=1: the dev store has no ${target} prewarm for the lock in ${lockFile}; run scripts/toolchains/dev-store.ts or unset it`,
  crossAbsent: (target: CrossPackageTarget) => `not run: ${target} cross package absent`,
  crossRequired: (target: CrossPackageTarget, where: string) =>
    `GENEX_REQUIRE_TOOLCHAINS=1: ${target} cross package absent at ${where}; run scripts/cross-build-smoke.ts or unset it`,
  notAnImage: (image: string) => `not run: ${JSON.stringify(image)} is not an image name`,
  dockerAbsent: (image: string) => `not run: docker image ${image} absent (no docker CLI, no daemon or not pulled)`,
  rustAbsent: (name: DevRustToolName) => `not run: rust ${name} absent`,
  rustRequired: (name: DevRustToolName, where: string) =>
    `GENEX_REQUIRE_TOOLCHAINS=1: rust ${name} absent at ${where}; run scripts/spike/rust-wgpu/setup-toolchain.sh or unset it`,
  rustNotPrewarmed: (target: BuildTarget) => `not run: dev store has no Rust ${target} prewarm`,
  rustPrewarmRequired: (target: BuildTarget, lockFile: string) =>
    `GENEX_REQUIRE_TOOLCHAINS=1: the dev store has no Rust ${target} prewarm for the lock in ${lockFile}; run scripts/toolchains/dev-store.ts --stack rust-wgpu or unset it`,
  dockerRequired: (image: string) =>
    `GENEX_REQUIRE_TOOLCHAINS=1: docker image ${image} absent (no docker CLI, no daemon or not pulled); pull it or unset it`,
} as const;

/** The JSON at `file`, or null when it is missing or not JSON. */
function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The toolchains folder `env` names. */
const toolchainsRoot = (env: NodeJS.ProcessEnv) =>
  env.GENEX_DEV_TOOLCHAINS || path.join(REPO, ".studio-dev", "toolchains");

/**
 * The lock file the dev store's real rows build with: `GENEX_DEV_STORE_LOCK` when it is set, else
 * `<repo>/.studio-dev/dev-store-lock.json` when that exists (a worktree whose lock is not the
 * store's), else `<store>/current-lock.json`. Several worktrees share one store this way, and no
 * worktree's tests ever write another's lock.
 */
export function devStoreLockFile(env: NodeJS.ProcessEnv = process.env, repo: string = REPO): string {
  if (env.GENEX_DEV_STORE_LOCK) return path.resolve(env.GENEX_DEV_STORE_LOCK);
  const worktree = path.join(repo, ...WORKTREE_LOCK);
  if (existsSync(worktree)) return worktree;
  return path.join(toolchainsRoot(env), ...DEV_TOOL.devStore.split("/"), "current-lock.json");
}

/**
 * The Rust lock file the dev store's real rows build with: `GENEX_DEV_STORE_RUST_LOCK` when set,
 * else `<repo>/.studio-dev/dev-store-rust-lock.json` when that exists, else the store's
 * `current-lock.rust-wgpu.json`. Reads nothing but whether the worktree's file exists.
 */
export function devStoreRustLockFile(env: NodeJS.ProcessEnv = process.env, repo: string = REPO): string {
  if (env.GENEX_DEV_STORE_RUST_LOCK) return path.resolve(env.GENEX_DEV_STORE_RUST_LOCK);
  const worktree = path.join(repo, ...WORKTREE_RUST_LOCK);
  if (existsSync(worktree)) return worktree;
  const store = path.join(toolchainsRoot(env), ...DEV_TOOL.devStore.split("/"));
  return path.join(store, LOCK_FILE_OF_STACK[GameStack.RustWgpu]);
}

/**
 * Whether the Rust dev store prewarmed `target` for the lock in `lockFile`: that lock's
 * `locks/<digest12>/targets/<target>/rust-prewarm.json` names the same lock and destination.
 */
function rustPrewarmed(store: string, lockFile: string, target: BuildTarget): boolean {
  const lock = readJson(lockFile);
  const digest = isRecord(lock) && typeof lock.digest === "string" ? lock.digest : null;
  if (!digest) return false;
  const folder = path.join(store, LOCKS_FOLDER, digest.slice(0, 12), RustStoreFolder.Targets, target);
  const record = readJson(path.join(folder, RUST_PREWARM_FILE));
  return isRecord(record) && record.lock === digest && record.target === target && Array.isArray(record.outputs);
}

/**
 * The destinations a dev store prewarmed for the lock in `lockFile`: its digest, then
 * `locks/<digest12>/prewarm.json` for that same lock, whose outputs name `genex-<target>.cmake`.
 * Windows and Linux count only when the record names this checkout's cross format, as a locate
 * reads them; an older one is a prewarm to redo (`node scripts/toolchains/dev-store.ts`).
 */
function prewarmedTargets(store: string, lockFile: string): Set<string> {
  const lock = readJson(lockFile);
  const digest = isRecord(lock) && typeof lock.digest === "string" ? lock.digest : null;
  if (!digest) return new Set();
  const prewarm = readJson(path.join(store, "locks", digest.slice(0, 12), "prewarm.json"));
  if (!isRecord(prewarm) || prewarm.lock !== digest || !Array.isArray(prewarm.outputs)) return new Set();
  const currentCross = prewarm.cross === crossPrewarmDigest();
  const targets = prewarm.outputs.flatMap((output) => {
    const named = typeof output === "string" ? /^genex-([a-z]+)\.cmake$/.exec(output) : null;
    const target = named?.[1];
    if (!target) return [];
    return CROSS_DESTINATIONS.has(target) && !currentCross ? [] : [target];
  });
  return new Set(targets);
}

/** Whether `docker image inspect <image>` answers 0 through the docker CLI on `env`'s PATH. */
function dockerHasImage(image: string, env: NodeJS.ProcessEnv): boolean {
  try {
    execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], {
      stdio: "ignore",
      timeout: DOCKER_INSPECT_TIMEOUT_MS,
      env: { PATH: env.PATH ?? "", HOME: env.HOME ?? "" },
    });
    return true;
  } catch {
    return false;
  }
}

/** The toolchains `env` names; `options.repo` is the repository whose own files the lock and packages are read from. */
export function devToolchains(env: NodeJS.ProcessEnv = process.env, options: DevToolchainsOptions = {}): DevToolchains {
  const root = toolchainsRoot(env);
  const repo = options.repo ?? REPO;
  const required = env.GENEX_REQUIRE_TOOLCHAINS === "1";
  const where = (name: DevToolName) => path.join(root, ...DEV_TOOL[name].split("/"));
  const present = (name: DevToolName) => existsSync(path.join(where(name), ...(PRESENT_WHEN_HOLDING[name] ?? [])));
  const devTool = (name: DevToolName): DevToolLookup =>
    present(name) ? { path: where(name) } : { skip: MESSAGE.absent(name) };
  const needsTools = (...names: DevToolName[]): { skip?: string } => {
    const absent = names.find((name) => !present(name));
    if (absent === undefined) return {};
    if (required) throw new Error(MESSAGE.required(absent, where(absent)));
    return { skip: MESSAGE.absent(absent) };
  };
  const lockFile = () => devStoreLockFile(env, repo);
  const needsPrewarmed = (...targets: BuildTarget[]): { skip?: string } => {
    const prewarmed = prewarmedTargets(where("devStore"), lockFile());
    const absent = targets.find((target) => !prewarmed.has(target));
    if (absent === undefined) return {};
    if (required) throw new Error(MESSAGE.prewarmRequired(absent, lockFile()));
    return { skip: MESSAGE.notPrewarmed(absent) };
  };
  const lock = (): Promise<ToolchainLock | null> => {
    const value = readJson(lockFile());
    return Promise.resolve(isToolchainLock(value) ? value : null);
  };
  const packageAt = (target: CrossPackageTarget) =>
    path.join(repo, ".studio-dev", "cross-build-work", CROSS_PACKAGE_FOLDER[target], "package");
  const crossPackage = (target: CrossPackageTarget): DevToolLookup =>
    existsSync(packageAt(target)) ? { path: packageAt(target) } : { skip: MESSAGE.crossAbsent(target) };
  const needsCrossPackage = (...targets: CrossPackageTarget[]): { skip?: string } => {
    const absent = targets.find((target) => !existsSync(packageAt(target)));
    if (absent === undefined) return {};
    if (required) throw new Error(MESSAGE.crossRequired(absent, packageAt(absent)));
    return { skip: MESSAGE.crossAbsent(absent) };
  };
  const needsDocker = (image: string): { skip?: string } => {
    if (!DOCKER_IMAGE.test(image)) return { skip: MESSAGE.notAnImage(image) };
    if (dockerHasImage(image, env)) return {};
    if (required) throw new Error(MESSAGE.dockerRequired(image));
    return { skip: MESSAGE.dockerAbsent(image) };
  };
  return {
    root,
    required,
    devTool,
    needsTools,
    needsPrewarmed,
    lockFile,
    lock,
    crossPackage,
    needsCrossPackage,
    needsDocker,
    ...rustRows(env, repo, where("devStore")),
  };
}

/** The Rust rows of {@link devToolchains}: the pinned Rust folder's tools and the Rust dev store's prewarm. */
function rustRows(
  env: NodeJS.ProcessEnv,
  repo: string,
  store: string,
): Pick<DevToolchains, "rustRoot" | "devRustTool" | "needsRustTools" | "rustLockFile" | "needsRustPrewarmed"> {
  const rustRoot = env.GENEX_RUST_TOOLCHAIN_DIR || path.join(repo, ...RUST_TOOLCHAIN_DIR);
  const required = env.GENEX_REQUIRE_TOOLCHAINS === "1";
  const where = (name: DevRustToolName) => path.join(rustRoot, ...DEV_RUST_TOOL[name].split("/"));
  const devRustTool = (name: DevRustToolName): DevToolLookup =>
    existsSync(where(name)) ? { path: where(name) } : { skip: MESSAGE.rustAbsent(name) };
  const needsRustTools = (...names: DevRustToolName[]): { skip?: string } => {
    const absent = names.find((name) => !existsSync(where(name)));
    if (absent === undefined) return {};
    if (required) throw new Error(MESSAGE.rustRequired(absent, where(absent)));
    return { skip: MESSAGE.rustAbsent(absent) };
  };
  const rustLockFile = () => devStoreRustLockFile(env, repo);
  const needsRustPrewarmed = (...targets: BuildTarget[]): { skip?: string } => {
    const absent = targets.find((target) => !rustPrewarmed(store, rustLockFile(), target));
    if (absent === undefined) return {};
    if (required) throw new Error(MESSAGE.rustPrewarmRequired(absent, rustLockFile()));
    return { skip: MESSAGE.rustNotPrewarmed(absent) };
  };
  return { rustRoot, devRustTool, needsRustTools, rustLockFile, needsRustPrewarmed };
}

const current = devToolchains();
/** The toolchains folder this process's environment names. */
export const DEV_TOOLCHAINS = current.root;
/** A tool's path under {@link DEV_TOOLCHAINS}, or the skip reason. */
export const devTool = current.devTool;
/** `node:test` options for a row that needs these tools (throws under `GENEX_REQUIRE_TOOLCHAINS=1`). */
export const needsTools = current.needsTools;
/** `node:test` options for a row that needs these destinations prewarmed in the dev store (throws when required). */
export const needsPrewarmed = current.needsPrewarmed;
/** The lock the dev store's real rows build with ({@link devStoreLockFile}), or null; reads only. */
export const devStoreLock = current.lock;
/** The head start's real cross package for a destination, or the skip reason. */
export const devCrossPackage = current.crossPackage;
/** `node:test` options for a row that needs the head start's real cross packages (throws when required). */
export const needsCrossPackage = current.needsCrossPackage;
/** `node:test` options for a row that runs a Docker image (throws when required). */
export const needsDocker = current.needsDocker;
/** The pinned Rust toolchain folder this process's environment names. */
export const DEV_RUST_TOOLCHAIN = current.rustRoot;
/** A Rust tool's path under {@link DEV_RUST_TOOLCHAIN}, or the skip reason. */
export const devRustTool = current.devRustTool;
/** `node:test` options for a row that needs these Rust tools (throws under `GENEX_REQUIRE_TOOLCHAINS=1`). */
export const needsRustTools = current.needsRustTools;
/** `node:test` options for a row that needs these destinations prewarmed in the Rust dev store (throws when required). */
export const needsRustPrewarmed = current.needsRustPrewarmed;

/** The path of a tool a caller has already required. */
function present(tools: DevToolchains, name: DevToolName): string {
  const found = tools.devTool(name);
  if ("skip" in found) throw new Error(found.skip);
  return found.path;
}

/**
 * The environment for one emcc run: a fresh `EM_CACHE` under `dir`, cloned from emsdk's shipped
 * cache (`cp -c` on a Mac, `cp --reflink=auto` on Linux), an `EM_CONFIG` written here,
 * `EMCC_SKIP_SANITY_CHECK=1` and `PYTHONDONTWRITEBYTECODE=1`. `EMSDK_PYTHON` is emsdk's own Python
 * behind a `-B` wrapper: emcc starts Python with `-E`, which ignores every `PYTHON*` variable, so
 * without it Python writes `__pycache__` into the shipped emsdk. Never the system `python3`, whose
 * Command Line Tools shim can open Apple's installer dialog.
 */
export async function privateEmscripten(dir: string, tools: DevToolchains = current): Promise<Record<string, string>> {
  const emsdk = present(tools, "emsdk");
  const python = present(tools, "emsdkPython");
  const node = present(tools, "emsdkNode");
  const shipped = present(tools, "emscriptenCache");
  await mkdir(dir, { recursive: true });
  const cache = path.join(dir, "em-cache");
  if (existsSync(cache)) throw new Error(MESSAGE.cacheTaken(cache));
  const clone = process.platform === "darwin" ? ["-c", "-R"] : ["-R", "--reflink=auto"];
  await execFileAsync("/bin/cp", [...clone, shipped, cache]);
  const config = path.join(dir, "emscripten.config");
  const install = path.join(emsdk, "install");
  await writeFile(
    config,
    [
      `LLVM_ROOT = ${JSON.stringify(path.join(install, "bin"))}`,
      `BINARYEN_ROOT = ${JSON.stringify(install)}`,
      `NODE_JS = ${JSON.stringify(node)}`,
      "",
    ].join("\n"),
  );
  const wrapper = path.join(dir, "python3");
  await writeFile(wrapper, `#!/bin/sh\nexec ${shellQuote(python)} -B "$@"\n`, { mode: 0o755 });
  return {
    EM_CACHE: cache,
    EM_CONFIG: config,
    EMSDK_PYTHON: wrapper,
    EMCC_SKIP_SANITY_CHECK: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
}
