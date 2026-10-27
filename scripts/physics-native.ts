/**
 * Builds the `@genex-ai/physics-native` npm package (Genex Physics' per-room process) offline.
 *
 *   node scripts/physics-native.ts [--target linux-x64-gnu|darwin-arm64|all] [--test]
 *
 * 1. cargo builds the `genex-physics-room` binary (`crates/genex-physics-sidecar`) for each target
 *    with the workspace's `native-physics` profile (release, opt-level 3, fat LTO, one codegen unit,
 *    unwinding panics, stripped symbols, no `target-cpu`), through the cargo env helper
 *    (`scripts/toolchains/rust-env.ts`: the pinned toolchain, vendored crates, `--locked`) with
 *    `GENEX_RUST_REMAP_PATHS=1`, so no absolute path of this machine lands in it. `darwin-arm64` is
 *    `aarch64-apple-darwin`; `linux-x64-gnu` is `cargo zigbuild --target
 *    x86_64-unknown-linux-gnu.2.28`, linked against glibc 2.28's symbols.
 * 2. Each binary is refused ({@link binaryRefusals}) if it holds an absolute path of this machine,
 *    imports a socket call (the process has no network code), or, for Linux, is not an x86_64
 *    glibc executable needing glibc ≤ 2.28 with no `DT_RPATH` and no `DT_RUNPATH`
 *    (`admitRustLinuxElf`, the export gate's reader).
 * 3. The package folder `.studio-dev/build/physics-native/` gets `native/<target>/genex-physics-room`,
 *    `binaries.json` (each binary's sha256 and bytes), the client `native.js` and `native.d.ts`,
 *    the types of `@genex-ai/physics` (`index.d.ts`) its worlds use, README and contract, the MIT
 *    `LICENSE`, `THIRD-PARTY-NOTICES.md` (every crate linked into the binaries, from `cargo
 *    metadata`; `physics-wasm-notices.ts`), `package.json` (depending on exactly the
 *    `@genex-ai/physics` version beside it) and `size.json`. A link
 *    `node_modules/@genex-ai/physics` to the WASM package folder beside it lets the folder run in
 *    place (tests, the Linux container); `npm pack` leaves it out. Then `npm pack` writes the
 *    tarball into `.studio-dev/dist/` with `<tarball>.sha256` beside it.
 *
 * `--test` builds this host's target only into `.studio-dev/build/physics-native-test/`, linked to
 * the WASM test build, with no tarball: the package's tests load that folder.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { admitRustLinuxElf } from "../src/substrate/native-gate-elf.ts";
import {
  commonText,
  crateClosure,
  crateTexts,
  localPathsIn,
  type Metadata,
  type MetadataPackage,
  noticeCrate,
  noticesMarkdown,
} from "./physics-wasm-notices.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CRATE = "genex-physics-sidecar";
const BINARY = "genex-physics-room";
/** The workspace's cargo profile for the binary (`native/genex-rust/Cargo.toml`). */
const CARGO_PROFILE = "native-physics";
const PHYSICS = path.join(REPO, "native/genex-rust/crates/genex-physics");
const JS_SOURCE = path.join(PHYSICS, "js");
const BUILD_ROOT = path.join(REPO, ".studio-dev/build");
const DIST = path.join(REPO, ".studio-dev/dist");
const GZIP_LEVEL = 9;
/** The env helper's opt-in (`rust-env.ts`): relative source paths. */
const BUILD_ENV = { GENEX_RUST_REMAP_PATHS: "1" };
const METADATA_MAX_BYTES = 256 * 1024 * 1024;
const NOTICES_FILE = "THIRD-PARTY-NOTICES.md";
const LICENSE_FILE = "LICENSE";
const BINARIES_FILE = "binaries.json";
const CANONICAL_LICENCE_FILES: [string, RegExp][] = [["Apache-2.0", /^LICENSE-APACHE$/]];
/** What the package carries from `js/`, and the name each gets. */
const PACKAGE_FILES: [string, string][] = [
  ["native-package.json", "package.json"],
  ["native.js", "native.js"],
  ["native.d.ts", "native.d.ts"],
  ["index.d.ts", "index.d.ts"],
  ["README.md", "README.md"],
];
/** The WASM package folders a build links to, by build kind. */
const WASM_FOLDER = { release: "physics-wasm", test: "physics-wasm-test" } as const;
/**
 * Calls a process with no network code never imports, by the names a Linux (`socket`) or macOS
 * (`_socket`) binary's dynamic string table spells them.
 */
export const NETWORK_CALLS = ["socket", "connect", "bind", "listen", "accept", "getaddrinfo", "sendto", "recvfrom"];

/** The binaries this script builds, by package folder name. */
export const NativeTarget = { LinuxX64Gnu: "linux-x64-gnu", DarwinArm64: "darwin-arm64" } as const;
export type NativeTarget = (typeof NativeTarget)[keyof typeof NativeTarget];
const ALL = "all";

/** How each target is built: its triple (as cargo's target folder names it) and cargo's subcommand. */
const TARGETS: Record<NativeTarget, { triple: string; cargoTarget: string; subcommand: string }> = {
  [NativeTarget.LinuxX64Gnu]: {
    triple: "x86_64-unknown-linux-gnu",
    cargoTarget: "x86_64-unknown-linux-gnu.2.28",
    subcommand: "zigbuild",
  },
  [NativeTarget.DarwinArm64]: {
    triple: "aarch64-apple-darwin",
    cargoTarget: "aarch64-apple-darwin",
    subcommand: "build",
  },
};

const Flag = { Test: "--test", Target: "--target" } as const;

/** One build's choices. */
interface BuildPlan {
  test: boolean;
  targets: NativeTarget[];
  out: string;
}

/** This host's target, or undefined where no binary is built for it. */
function hostTarget(): NativeTarget | undefined {
  if (process.platform === "darwin" && process.arch === "arm64") return NativeTarget.DarwinArm64;
  if (process.platform === "linux" && process.arch === "x64") return NativeTarget.LinuxX64Gnu;
  return undefined;
}

function isTarget(value: string): value is NativeTarget {
  return (Object.values(NativeTarget) as string[]).includes(value);
}

function plan(argv: string[]): BuildPlan {
  const test = argv.includes(Flag.Test);
  const at = argv.indexOf(Flag.Target);
  const named = at < 0 ? undefined : argv[at + 1];
  const rest = argv.filter((arg, index) => arg !== Flag.Test && index !== at && index !== at + 1);
  if (rest.length > 0) throw new Error(`physics-native: unknown argument ${rest[0]}`);
  const host = hostTarget();
  const fallback = test ? host : ALL;
  const choice = named ?? fallback;
  if (choice === undefined) throw new Error("physics-native: no binary is built for this host; name --target");
  const targets = choice === ALL ? Object.values(NativeTarget) : [choice];
  for (const target of targets) {
    if (!isTarget(target)) throw new Error(`physics-native: unknown target ${target}`);
  }
  const out = path.join(BUILD_ROOT, test ? "physics-native-test" : "physics-native");
  return { test, targets: targets as NativeTarget[], out };
}

function rustEnvArgs(args: string[]): string[] {
  return [path.join(REPO, "scripts/toolchains/rust-env.ts"), "--", ...args];
}

function targetDir(): string {
  return process.env.CARGO_TARGET_DIR ?? path.join(REPO, ".studio-dev/cargo-target");
}

function toolchainDir(): string {
  return process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev/spike-toolchain");
}

/** Builds one target's binary; its path. */
function cargoBuild(target: NativeTarget): string {
  const { cargoTarget, subcommand, triple } = TARGETS[target];
  const args = ["cargo", subcommand, "-p", CRATE, "--bin", BINARY, "--target", cargoTarget, "--profile", CARGO_PROFILE];
  execFileSync(process.execPath, rustEnvArgs([...args, "--offline", "--locked"]), {
    cwd: REPO,
    stdio: "inherit",
    env: { ...process.env, ...BUILD_ENV },
  });
  const binary = path.join(targetDir(), triple, CARGO_PROFILE, BINARY);
  if (!existsSync(binary)) throw new Error(`physics-native: cargo produced no ${binary}`);
  return binary;
}

/** The names of `calls` a binary's bytes import (each as a whole NUL-delimited string, plain or `_`-prefixed). */
export function networkImports(bytes: Uint8Array, calls: readonly string[] = NETWORK_CALLS): string[] {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  return calls.filter((name) => text.includes(`\0${name}\0`) || text.includes(`\0_${name}\0`));
}

/**
 * Why a built binary must not ship, or none: an absolute path of this machine (`needles`, and any
 * home folder), a socket call imported, and for Linux anything `admitRustLinuxElf` refuses (not
 * x86_64 glibc, glibc above 2.28, a `DT_RPATH`) or any `DT_RUNPATH` at all.
 */
export function binaryRefusals(bytes: Uint8Array, target: NativeTarget, needles: readonly string[]): string[] {
  const found: string[] = [];
  const paths = localPathsIn(bytes, needles);
  if (paths.length > 0) found.push(`local paths: ${paths.join(", ")}`);
  const network = networkImports(bytes);
  if (network.length > 0) found.push(`network calls: ${network.join(", ")}`);
  if (target !== NativeTarget.LinuxX64Gnu) return found;
  const admitted = admitRustLinuxElf(bytes);
  if (!admitted.ok) {
    found.push(`elf: ${admitted.problem}: ${admitted.detail}`);
    return found;
  }
  if (admitted.image.runpath.length > 0) found.push(`elf: a DT_RUNPATH (${admitted.image.runpath.join(", ")})`);
  return found;
}

/** The highest glibc version a Linux binary needs, or null (for the build's log). */
function maxGlibc(bytes: Uint8Array): string | null {
  const admitted = admitRustLinuxElf(bytes);
  return admitted.ok ? admitted.maxGlibc : null;
}

function cargoMetadata(triple: string): Metadata {
  const args = ["cargo", "metadata", "--format-version", "1", "--filter-platform", triple, "--offline", "--locked"];
  const text = execFileSync(process.execPath, rustEnvArgs(args), {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: METADATA_MAX_BYTES,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(text) as Metadata;
}

/** THIRD-PARTY-NOTICES.md for every crate any built binary links in. */
function thirdPartyNotices(targets: NativeTarget[]): string {
  const byId = new Map<string, MetadataPackage>();
  for (const target of targets) {
    for (const pkg of crateClosure(cargoMetadata(TARGETS[target].triple), CRATE)) byId.set(pkg.id, pkg);
  }
  const ordered = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const crates = ordered.map((pkg) => noticeCrate(pkg, crateTexts(pkg)));
  const canonical = new Map<string, string>();
  for (const [id, pattern] of CANONICAL_LICENCE_FILES) {
    const found = commonText(crates, pattern);
    if (found !== undefined) canonical.set(id, found);
  }
  return noticesMarkdown(crates, canonical);
}

/** The package manifest, held to depend on exactly the WASM package's version. */
function manifest(): Record<string, unknown> {
  const native = JSON.parse(readFileSync(path.join(JS_SOURCE, "native-package.json"), "utf8"));
  const physics = JSON.parse(readFileSync(path.join(JS_SOURCE, "package.json"), "utf8"));
  const dependency = native.dependencies?.[physics.name];
  if (dependency !== physics.version || native.version !== physics.version) {
    throw new Error(
      `physics-native: the package must be ${physics.version} and depend on exactly ${physics.name}@${physics.version}`,
    );
  }
  return native;
}

function stage(plan: BuildPlan, binaries: Map<NativeTarget, string>): void {
  manifest();
  for (const [from, to] of PACKAGE_FILES) copyFileSync(path.join(JS_SOURCE, from), path.join(plan.out, to));
  copyFileSync(path.join(PHYSICS, "CONTRACT.md"), path.join(plan.out, "CONTRACT.md"));
  copyFileSync(path.join(REPO, LICENSE_FILE), path.join(plan.out, LICENSE_FILE));
  writeFileSync(path.join(plan.out, NOTICES_FILE), thirdPartyNotices(plan.targets));
  const listed: Record<string, { sha256: string; bytes: number }> = {};
  for (const [target, binary] of binaries) {
    const folder = path.join(plan.out, "native", target);
    mkdirSync(folder, { recursive: true });
    const placed = path.join(folder, BINARY);
    copyFileSync(binary, placed);
    chmodSync(placed, 0o755);
    const bytes = readFileSync(placed);
    listed[target] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  }
  writeFileSync(path.join(plan.out, BINARIES_FILE), `${JSON.stringify(listed, null, 2)}\n`);
  const modules = path.join(plan.out, "node_modules", "@genex-ai");
  mkdirSync(modules, { recursive: true });
  symlinkSync(
    path.join("..", "..", "..", plan.test ? WASM_FOLDER.test : WASM_FOLDER.release),
    path.join(modules, "physics"),
  );
}

function sizes(out: string, targets: NativeTarget[]): Record<string, { bytes: number; gzipBytes: number }> {
  const loaded = ["native.js", ...targets.map((target) => `native/${target}/${BINARY}`)];
  const entries = loaded.map((name) => {
    const bytes = readFileSync(path.join(out, name));
    return [name, { bytes: bytes.length, gzipBytes: gzipSync(bytes, { level: GZIP_LEVEL }).length }] as const;
  });
  return Object.fromEntries(entries);
}

function pack(out: string): string {
  mkdirSync(DIST, { recursive: true });
  const npm = path.join(path.dirname(process.execPath), "npm");
  const report = execFileSync(npm, ["pack", "--json", "--offline", "--pack-destination", DIST], {
    cwd: out,
    encoding: "utf8",
  });
  const [packed] = JSON.parse(report) as { filename: string }[];
  const tarball = path.join(DIST, path.basename(packed.filename));
  const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  writeFileSync(`${tarball}.sha256`, `${digest}  ${path.basename(tarball)}\n`);
  return tarball;
}

function main(): void {
  const built = plan(process.argv.slice(2));
  const needles = [path.resolve(REPO), path.resolve(toolchainDir()), os.homedir()];
  const binaries = new Map<NativeTarget, string>();
  for (const target of built.targets) {
    const binary = cargoBuild(target);
    const bytes = readFileSync(binary);
    const refusals = binaryRefusals(bytes, target, needles);
    if (refusals.length > 0) throw new Error(`physics-native: ${binary} refused: ${refusals.join("; ")}`);
    const glibc = target === NativeTarget.LinuxX64Gnu ? ` (needs glibc ${maxGlibc(bytes)})` : "";
    console.log(`physics-native: ${target} ${bytes.length} bytes${glibc}`);
    binaries.set(target, binary);
  }
  rmSync(built.out, { recursive: true, force: true });
  mkdirSync(built.out, { recursive: true });
  stage(built, binaries);
  const size = sizes(built.out, built.targets);
  writeFileSync(path.join(built.out, "size.json"), `${JSON.stringify({ test: built.test, files: size }, null, 2)}\n`);
  console.log(`physics-native: ${built.out}`);
  console.log(JSON.stringify(size));
  if (built.test) return;
  const tarball = pack(built.out);
  console.log(`physics-native: ${tarball} (sha256 in ${path.basename(tarball)}.sha256)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
