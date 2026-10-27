/**
 * Builds Genex Physics' C ABI (`crates/genex-physics-capi`, header `include/genex_physics.h`) for every
 * host target offline, and the C tests that hold it.
 *
 *   node scripts/physics-capi.ts [--test] [--target <name>[,<name>...]]
 *
 * 1. cargo builds the crate with the workspace's `native-physics` profile (release, opt-level 3, fat
 *    LTO, one codegen unit, unwinding panics so the boundary can catch them, stripped symbols, no
 *    `target-cpu`: the sidecar's codegen, which the backend-parity rows hold to WASM) through the
 *    cargo env helper (`scripts/toolchains/rust-env.ts`) with `GENEX_RUST_REMAP_PATHS=1`. Targets:
 *    - `macos-universal`: `aarch64-apple-darwin` and `x86_64-apple-darwin` dylibs joined by `lipo`.
 *    - `linux-x64-gnu`: `cargo zigbuild --target x86_64-unknown-linux-gnu.2.28` (glibc 2.28 symbols).
 *    - `windows-x64`: `x86_64-pc-windows-gnullvm` with the toolchain's llvm-mingw, a plain C DLL
 *      that MSVC-built hosts (Unity, Unreal) load, and its import library.
 *    - `ios`: static archives for `aarch64-apple-ios` and `aarch64-apple-ios-sim` in one
 *      `GenexPhysics.xcframework` (`xcodebuild -create-xcframework`) with the header.
 *    - `android-arm64`: `aarch64-linux-android` with the NDK rust-env finds (it refuses without one).
 * 2. Each library is refused if it holds an absolute path of this machine or imports a socket call;
 *    its exported `gxph_*` symbols must be exactly the header's (the header test's list).
 * 3. `.studio-dev/build/physics-capi/` gets `<target>/...`, `include/genex_physics.h` and
 *    `PROVENANCE.json`: per artifact its sha256, bytes and target facts (glibc floor, DLL imports,
 *    install name), the buildId, and the targets whose toolchain is missing (an owner item, never a
 *    failure: a missing toolchain is recorded and the other targets still build).
 * 4. On this Mac (arm64) the C tests are compiled with the system clang against the arm64 library
 *    and run: the header test (C11 and C++17, `-Wall -Wextra -Werror -pedantic`), and the
 *    conformance runner over every §16 vector. `tests/conformance/physics-capi.test.ts` then holds
 *    the runner's per-step hashes to the WASM and native packages bit for bit.
 *
 * `--test` builds only `aarch64-apple-darwin` with the `test-panic` feature (and the panic test)
 * into `.studio-dev/build/physics-capi-test/`, which the conformance test file loads.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { localPathsIn } from "./physics-wasm-notices.ts";
import { NETWORK_CALLS, networkImports } from "./physics-native.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CRATE = "genex-physics-capi";
const LIB = "genex_physics_capi";
const CAPI = path.join(REPO, "native/genex-rust/crates/genex-physics-capi");
const HEADER = path.join(CAPI, "include/genex_physics.h");
const C_TESTS = path.join(CAPI, "tests/c");
const VECTORS = path.join(REPO, "native/genex-rust/crates/genex-physics/vectors");
const BUILD_ROOT = path.join(REPO, ".studio-dev/build");
/** The workspace's cargo profile (`native/genex-rust/Cargo.toml`), the sidecar's. */
const CARGO_PROFILE = "native-physics";
/** The env helper's opt-in (`rust-env.ts`): relative source paths. */
const BUILD_ENV = { GENEX_RUST_REMAP_PATHS: "1" };
const TEST_FEATURE = "test-panic";
/** The test build's extra export, never in the header. */
const TEST_ONLY_SYMBOLS = ["gxph_test_panic"];
const XCFRAMEWORK = "GenexPhysics.xcframework";
const PROVENANCE_FILE = "PROVENANCE.json";
const OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
/** The C tests' compiler flags: every warning an error. */
const C_FLAGS = ["-std=c11", "-Wall", "-Wextra", "-Werror", "-pedantic", "-O1"];
const CXX_FLAGS = ["-x", "c++", "-std=c++17", "-Wall", "-Wextra", "-Werror", "-pedantic", "-O1"];

/** The artifacts this script builds, by folder name. */
export const CapiTarget = {
  MacosUniversal: "macos-universal",
  LinuxX64Gnu: "linux-x64-gnu",
  WindowsX64: "windows-x64",
  Ios: "ios",
  AndroidArm64: "android-arm64",
} as const;
export type CapiTarget = (typeof CapiTarget)[keyof typeof CapiTarget];

/** One cargo build: the triple cargo names its folder after, what to pass `--target`, the subcommand. */
interface Slice {
  triple: string;
  cargoTarget: string;
  subcommand: "build" | "zigbuild" | "rustc";
  /** rustc flags for this crate's own compile and link (`cargo rustc -- …`), none for the others. */
  rustcFlags?: string[];
}

const slice = (triple: string, subcommand: Slice["subcommand"] = "build", cargoTarget = triple): Slice => ({
  triple,
  cargoTarget,
  subcommand,
});
/**
 * The Windows DLL links its C runtime statically: without `+crt-static` the gnullvm std imports
 * `libunwind.dll`, which Windows does not ship and a host would have to find beside its own exe.
 * `#[link]`'s `cfg(target_feature = "crt-static")` is read at the final link, so the flag on this
 * crate alone is enough (rust-env's `CARGO_ENCODED_RUSTFLAGS` would override a target's rustflags).
 */
const WINDOWS: Slice = {
  ...slice("x86_64-pc-windows-gnullvm", "rustc"),
  rustcFlags: ["-C", "target-feature=+crt-static"],
};
/** DLLs the Windows library may never import: runtimes that would have to ship beside it. */
const REFUSED_DLL_IMPORTS = ["libunwind.dll", "libc++.dll", "libwinpthread-1.dll"];
const DARWIN_ARM64 = slice("aarch64-apple-darwin");

/** Each artifact's cargo builds. */
const SLICES: Record<CapiTarget, Slice[]> = {
  [CapiTarget.MacosUniversal]: [DARWIN_ARM64, slice("x86_64-apple-darwin")],
  [CapiTarget.LinuxX64Gnu]: [slice("x86_64-unknown-linux-gnu", "zigbuild", "x86_64-unknown-linux-gnu.2.28")],
  [CapiTarget.WindowsX64]: [WINDOWS],
  [CapiTarget.Ios]: [slice("aarch64-apple-ios"), slice("aarch64-apple-ios-sim")],
  [CapiTarget.AndroidArm64]: [slice("aarch64-linux-android")],
};

/** The file cargo writes for a slice: the dynamic library, or the static archive for iOS. */
function cargoFile(triple: string): string {
  if (triple.endsWith("-apple-darwin")) return `lib${LIB}.dylib`;
  if (triple.includes("-apple-ios")) return `lib${LIB}.a`;
  if (triple.includes("windows")) return `${LIB}.dll`;
  return `lib${LIB}.so`;
}

const Flag = { Test: "--test", Target: "--target" } as const;

/** One run's choices. */
interface BuildPlan {
  test: boolean;
  targets: CapiTarget[];
  out: string;
}

function isTarget(value: string): value is CapiTarget {
  return (Object.values(CapiTarget) as string[]).includes(value);
}

function plan(argv: string[]): BuildPlan {
  const test = argv.includes(Flag.Test);
  const at = argv.indexOf(Flag.Target);
  const named = at < 0 ? undefined : argv[at + 1];
  const rest = argv.filter((arg, index) => arg !== Flag.Test && index !== at && index !== at + 1);
  if (rest.length > 0) throw new Error(`physics-capi: unknown argument ${rest[0]}`);
  if (test && named !== undefined) throw new Error("physics-capi: --test builds this Mac's arm64 library only");
  const targets = named === undefined ? Object.values(CapiTarget) : named.split(",");
  for (const target of targets) {
    if (!isTarget(target)) throw new Error(`physics-capi: unknown target ${target}`);
  }
  const out = path.join(BUILD_ROOT, test ? "physics-capi-test" : "physics-capi");
  return { test, targets: targets as CapiTarget[], out };
}

function targetDir(): string {
  return process.env.CARGO_TARGET_DIR ?? path.join(REPO, ".studio-dev/cargo-target");
}

function toolchainDir(): string {
  return process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev/spike-toolchain");
}

/** The prefix of rust-env's refusal line on stderr (`rust-env.ts`). */
const REFUSAL_PREFIX = "genex-rust-env-refusal: ";
/** The refusal code for a missing target toolchain (rust-std, the NDK, llvm-mingw, zig). */
const TOOL_MISSING = "tool-missing";

/** rust-env's refusal of a run (its code and detail), when it refused one. */
export function rustEnvRefusal(stderr: string): { code: string; detail: string } | undefined {
  const line = stderr.split("\n").find((text) => text.startsWith(REFUSAL_PREFIX));
  if (line === undefined) return undefined;
  return JSON.parse(line.slice(REFUSAL_PREFIX.length)) as { code: string; detail: string };
}

/** A toolchain this target needs is not installed (rust-env refused): an owner item, not a failure. */
class MissingToolchain extends Error {}

/** Builds one slice; the path of what cargo wrote. */
function cargoBuild(target: Slice, features: string[]): string {
  const args = ["cargo", target.subcommand, "-p", CRATE, "--lib", "--target", target.cargoTarget];
  const featureArgs = features.length > 0 ? ["--features", features.join(",")] : [];
  const rustc = target.rustcFlags ? ["--", ...target.rustcFlags] : [];
  const command = [...args, ...featureArgs, "--profile", CARGO_PROFILE, "--offline", "--locked", ...rustc];
  try {
    execFileSync(process.execPath, [path.join(REPO, "scripts/toolchains/rust-env.ts"), "--", ...command], {
      cwd: REPO,
      stdio: ["ignore", "inherit", "pipe"],
      env: { ...process.env, ...BUILD_ENV },
      maxBuffer: OUTPUT_MAX_BYTES,
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? "";
    process.stderr.write(stderr);
    const refusal = rustEnvRefusal(stderr);
    if (refusal?.code === TOOL_MISSING) throw new MissingToolchain(refusal.detail);
    throw error;
  }
  const built = path.join(targetDir(), target.triple, CARGO_PROFILE, cargoFile(target.triple));
  if (!existsSync(built)) throw new Error(`physics-capi: cargo produced no ${built}`);
  return built;
}

/** Runs a tool and gives its stdout. */
function tool(command: string, args: string[], cwd = REPO): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: OUTPUT_MAX_BYTES });
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The highest `GLIBC_x.y` a Linux library's version needs name, or null. */
export function maxGlibc(bytes: Uint8Array): string | null {
  const text = Buffer.from(bytes).toString("latin1");
  const versions = [...text.matchAll(/GLIBC_(\d+)\.(\d+)(?:\.(\d+))?/g)].map((m) =>
    m.slice(1).map((n) => Number(n ?? 0)),
  );
  if (versions.length === 0) return null;
  versions.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const [major, minor, patch] = versions[versions.length - 1];
  return patch ? `${major}.${minor}.${patch}` : `${major}.${minor}`;
}

/** The DLLs a Windows library imports, from `llvm-objdump -p`. */
function dllImports(file: string): string[] {
  const objdump = path.join(toolchainDir(), "tools/llvm-mingw/bin/llvm-objdump");
  const text = tool(objdump, ["-p", file]);
  return [...text.matchAll(/DLL Name: (\S+)/g)].map((m) => m[1].toLowerCase()).sort();
}

/** The `gxph_*` symbols a library exports: a DLL's export table, an ELF's dynamic symbols, a Mach-O's exports. */
export function exportedSymbols(file: string): string[] {
  const names = file.endsWith(".dll") ? peExports(file) : nmExports(file);
  return [...new Set(names.filter((name) => name.startsWith("gxph_")))].sort();
}

function nmExports(file: string): string[] {
  const nm = path.join(toolchainDir(), "sysroot/lib/rustlib/aarch64-apple-darwin/bin/llvm-nm");
  const dynamic = file.endsWith(".so") ? ["--dynamic"] : [];
  const text = tool(nm, [...dynamic, "--extern-only", "--defined-only", "--just-symbol-name", file]);
  return text.split("\n").map((line) => line.trim().replace(/^_/, ""));
}

function peExports(file: string): string[] {
  const objdump = path.join(toolchainDir(), "tools/llvm-mingw/bin/llvm-objdump");
  const table = tool(objdump, ["-p", file]).split("Export Table:")[1] ?? "";
  return [...table.matchAll(/^\s+\d+\s+0x[0-9a-f]+\s+(\S+)$/gm)].map((m) => m[1]);
}

/** Why a library must not ship: a local path, or a socket call imported. */
function libraryRefusals(file: string, needles: readonly string[]): string[] {
  const bytes = readFileSync(file);
  const found: string[] = [];
  const paths = localPathsIn(bytes, needles);
  if (paths.length > 0) found.push(`local paths: ${paths.join(", ")}`);
  // A static archive (iOS) carries all of std's object code, `std::net` included, for the app's
  // link to drop; only a linked library's imports say what it calls.
  const archive = file.endsWith(".a");
  const network = archive ? [] : networkImports(bytes, NETWORK_CALLS);
  if (network.length > 0) found.push(`network calls: ${network.join(", ")}`);
  return found;
}

/** One artifact's provenance row. */
interface Provenance {
  files: Record<string, { sha256: string; bytes: number }>;
  facts: Record<string, unknown>;
}

function record(out: string, files: string[], facts: Record<string, unknown> = {}): Provenance {
  const listed: Provenance["files"] = {};
  for (const file of files) {
    listed[path.relative(out, file)] = { sha256: sha256(file), bytes: readFileSync(file).length };
  }
  return { files: listed, facts };
}

/** Builds one artifact into `out/<target>/`; its provenance. */
function buildTarget(target: CapiTarget, out: string, features: string[]): Provenance {
  const folder = path.join(out, target);
  mkdirSync(folder, { recursive: true });
  const built = SLICES[target].map((s) => ({ slice: s, file: cargoBuild(s, features) }));
  if (target === CapiTarget.MacosUniversal) return macosUniversal(out, folder, built);
  if (target === CapiTarget.Ios) return iosXcframework(out, folder, built);
  const [{ file }] = built;
  const placed = path.join(folder, path.basename(file));
  copyFileSync(file, placed);
  if (target === CapiTarget.LinuxX64Gnu) return record(out, [placed], { glibc: maxGlibc(readFileSync(placed)) });
  if (target === CapiTarget.WindowsX64) {
    const importLib = path.join(path.dirname(file), `lib${LIB}.dll.a`);
    const placedImport = path.join(folder, path.basename(importLib));
    copyFileSync(importLib, placedImport);
    const imports = dllImports(placed);
    const refused = imports.filter((dll) => REFUSED_DLL_IMPORTS.includes(dll));
    if (refused.length > 0) throw new Error(`physics-capi: ${placed} imports ${refused.join(", ")}`);
    return record(out, [placed, placedImport], { imports });
  }
  return record(out, [placed]);
}

function macosUniversal(out: string, folder: string, built: { slice: Slice; file: string }[]): Provenance {
  const slices = built.map(({ slice: s, file }) => {
    const copy = path.join(folder, `${s.triple}.dylib`);
    copyFileSync(file, copy);
    return copy;
  });
  const universal = path.join(folder, `lib${LIB}.dylib`);
  tool("lipo", ["-create", ...slices, "-output", universal]);
  const archs = tool("lipo", ["-archs", universal]).trim();
  const installName = tool("otool", ["-D", universal]).trim().split("\n").pop() ?? "";
  for (const copy of slices) rmSync(copy);
  return record(out, [universal], { archs, installName });
}

function iosXcframework(out: string, folder: string, built: { slice: Slice; file: string }[]): Provenance {
  const headers = path.join(folder, "include");
  mkdirSync(headers, { recursive: true });
  copyFileSync(HEADER, path.join(headers, path.basename(HEADER)));
  const libraries = built.flatMap(({ slice: s, file }) => {
    const sliceFolder = path.join(folder, s.triple);
    mkdirSync(sliceFolder, { recursive: true });
    const copy = path.join(sliceFolder, path.basename(file));
    copyFileSync(file, copy);
    return ["-library", copy, "-headers", headers];
  });
  const framework = path.join(folder, XCFRAMEWORK);
  tool("xcodebuild", ["-create-xcframework", ...libraries, "-output", framework]);
  for (const { slice: s } of built) rmSync(path.join(folder, s.triple), { recursive: true });
  rmSync(headers, { recursive: true });
  return record(out, filesUnder(framework));
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

/** Compiles one C test against the library in `libDir`; the executable. */
function compileC(source: string, libDir: string, out: string, flags: string[]): string {
  const executable = path.join(out, "tests", path.basename(source, ".c") + (flags === CXX_FLAGS ? "-cxx" : ""));
  mkdirSync(path.dirname(executable), { recursive: true });
  tool("clang", [...flags, "-I", C_TESTS, source, "-L", libDir, `-l${LIB}`, `-Wl,-rpath,${libDir}`, "-o", executable]);
  return executable;
}

/** Builds and runs the C tests on this Mac against the arm64 library in `libDir`; the header's names. */
function cTests(libDir: string, out: string, test: boolean): string[] {
  const header = compileC(path.join(C_TESTS, "header_test.c"), libDir, out, C_FLAGS);
  const headerCxx = compileC(path.join(C_TESTS, "header_test.c"), libDir, out, CXX_FLAGS);
  compileC(path.join(C_TESTS, "conformance.c"), libDir, out, C_FLAGS);
  if (test) compileC(path.join(C_TESTS, "panic_test.c"), libDir, out, C_FLAGS);
  const declared = tool(header, [])
    .split("\n")
    .filter((line) => line.startsWith("declared "));
  tool(headerCxx, []);
  return declared.map((line) => line.slice("declared ".length)).sort();
}

/** The library's `gxph_*` exports must be exactly the header's (plus the test build's own). */
function checkSymbols(library: string, declared: string[], test: boolean): void {
  const allowed = new Set([...declared, ...(test ? TEST_ONLY_SYMBOLS : [])]);
  const exported = exportedSymbols(library);
  const undeclared = exported.filter((name) => !allowed.has(name));
  const missing = [...allowed].filter((name) => !exported.includes(name));
  if (undeclared.length + missing.length > 0) {
    throw new Error(
      `physics-capi: ${library}: exported but not declared ${undeclared}; declared but not exported ${missing}`,
    );
  }
}

/** Runs the conformance runner over every vector; throws on any problem. */
function vectorPaths(): string[] {
  return readdirSync(VECTORS)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(VECTORS, name));
}

/** The runner's transcript over every vector (`runner` and its leading arguments); throws on any problem. */
function transcript(runner: string[]): string {
  const [command, ...args] = runner;
  const lines = tool(command, [...args, ...vectorPaths()]);
  const outcomes = lines
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { name: string; problems: string[] });
  const failed = outcomes.filter((outcome) => outcome.problems.length > 0);
  if (failed.length > 0) throw new Error(`physics-capi: conformance: ${JSON.stringify(failed, null, 2)}`);
  return lines;
}

/** Runs the conformance runner over every vector; throws on any problem. */
function conformance(out: string): string {
  const lines = transcript([path.join(out, "tests", "conformance")]);
  return `${lines.trim().split("\n").length} vectors`;
}

/**
 * The universal library's x86_64 slice under Rosetta: the runner built for x86_64 must write the
 * arm64 runner's transcript byte for byte (every pin, every step's stateHash). Skipped without Rosetta.
 */
function rosettaConformance(out: string, libDir: string): string {
  const rosetta = spawnSync("arch", ["-x86_64", "/usr/bin/true"]);
  if (rosetta.status !== 0) return "x86_64 slice not run (no Rosetta)";
  const runner = path.join(out, "tests", "conformance-x86_64");
  const source = path.join(C_TESTS, "conformance.c");
  tool("clang", [
    "-arch",
    "x86_64",
    ...C_FLAGS,
    "-I",
    C_TESTS,
    source,
    "-L",
    libDir,
    `-l${LIB}`,
    `-Wl,-rpath,${libDir}`,
    "-o",
    runner,
  ]);
  const x86 = transcript(["arch", "-x86_64", runner]);
  const arm = transcript([path.join(out, "tests", "conformance")]);
  if (x86 !== arm) throw new Error("physics-capi: the x86_64 slice's transcript differs from arm64's");
  return "x86_64 slice under Rosetta: transcript equal to arm64's byte for byte";
}

function buildTest(built: BuildPlan): void {
  const library = cargoBuild(DARWIN_ARM64, [TEST_FEATURE]);
  const libDir = path.join(built.out, "lib");
  mkdirSync(libDir, { recursive: true });
  const placed = path.join(libDir, path.basename(library));
  copyFileSync(library, placed);
  const declared = cTests(libDir, built.out, true);
  checkSymbols(placed, declared, true);
  console.log(`physics-capi: test build ${placed}; header test passed; ${conformance(built.out)} replayed`);
}

function buildRelease(built: BuildPlan): void {
  const needles = [path.resolve(REPO), path.resolve(toolchainDir()), os.homedir()];
  const artifacts: Record<string, Provenance> = {};
  const missing: Record<string, string> = {};
  for (const target of built.targets) {
    try {
      artifacts[target] = buildTarget(target, built.out, []);
    } catch (error) {
      if (!(error instanceof MissingToolchain)) throw error;
      missing[target] = error.message;
      console.log(`physics-capi: ${target} not built: ${error.message}`);
      continue;
    }
    for (const file of Object.keys(artifacts[target].files)) {
      const refusals = libraryRefusals(path.join(built.out, file), needles);
      if (refusals.length > 0) throw new Error(`physics-capi: ${file} refused: ${refusals.join("; ")}`);
    }
    console.log(`physics-capi: ${target}: ${JSON.stringify(artifacts[target])}`);
  }
  mkdirSync(path.join(built.out, "include"), { recursive: true });
  copyFileSync(HEADER, path.join(built.out, "include", path.basename(HEADER)));
  const tests = hostTests(built, artifacts);
  const provenance = {
    crate: CRATE,
    abiVersion: abiVersion(),
    profile: CARGO_PROFILE,
    header: record(built.out, [path.join(built.out, "include", path.basename(HEADER))]).files,
    artifacts,
    missingToolchains: missing,
    tests,
  };
  writeFileSync(path.join(built.out, PROVENANCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`physics-capi: ${path.join(built.out, PROVENANCE_FILE)}`);
}

/** The header test and conformance runner against the shipped macOS library, run on this Mac. */
function hostTests(built: BuildPlan, artifacts: Record<string, Provenance>): string {
  if (!artifacts[CapiTarget.MacosUniversal] || process.arch !== "arm64")
    return "not run: no macOS library for this host";
  const libDir = path.join(built.out, CapiTarget.MacosUniversal);
  const library = path.join(libDir, `lib${LIB}.dylib`);
  const declared = cTests(libDir, built.out, false);
  for (const target of Object.keys(artifacts)) {
    const libraries = Object.keys(artifacts[target].files).filter((file) => /\.(dylib|so|dll)$/.test(file));
    for (const file of libraries) checkSymbols(path.join(built.out, file), declared, false);
  }
  const replayed = `${conformance(built.out)} replayed on ${library}`;
  return `header test passed (C11, C++17); ${replayed}; ${rosettaConformance(built.out, libDir)}`;
}

/** The header's `GXPH_ABI_VERSION`, as the header test's library reports it. */
function abiVersion(): number {
  const match = /#define GXPH_ABI_VERSION (\d+)u/.exec(readFileSync(HEADER, "utf8"));
  return Number(match?.[1] ?? 0);
}

function main(): void {
  const built = plan(process.argv.slice(2));
  rmSync(built.out, { recursive: true, force: true });
  mkdirSync(built.out, { recursive: true });
  if (built.test) {
    buildTest(built);
    return;
  }
  buildRelease(built);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
