/**
 * Builds the `@genex-ai/physics` npm package (Genex Physics' WebAssembly binding) offline.
 *
 *   node scripts/physics-wasm.ts [--test] [--no-opt]
 *
 * 1. cargo builds `genex-physics-wasm` for wasm32-unknown-unknown with the workspace's `wasm-physics`
 *    profile (release, opt-level 3, fat LTO), through the cargo env helper
 *    (`scripts/toolchains/rust-env.ts`: the pinned toolchain, vendored crates, `--locked`), with
 *    `GENEX_RUST_REMAP_PATHS=1` so every source path in the module is relative (`vendor/…`,
 *    `genex-rust/…`) and its bytes do not depend on where the checkout or the toolchain lives.
 * 2. The toolchain's wasm-bindgen (0.2.129) writes the ES module glue with `--target web` and its
 *    instance reset (the wrapper's new instance after a trap, CONTRACT.md §11.3); the package's
 *    `node.js` reads the `.wasm` beside it, so one glue serves Node 24 and browsers.
 * 3. wasm-opt -Oz shrinks the module, unless `--no-opt`: the toolchain's own binaryen (version_133,
 *    `tools/binaryen`, installed by setup-toolchain.sh for this host from its sha256-pinned archive)
 *    run through the env helper, which refuses a tool outside the toolchain folder, as web.sh does.
 *    The module is then refused if it holds an absolute path of this machine (the repository, the
 *    toolchain, a home folder).
 * 4. The package folder `.studio-dev/build/physics-wasm/` gets the hand-written wrapper, its types,
 *    README and the contract from `native/genex-rust/crates/genex-physics/`, the repository's MIT
 *    `LICENSE`, `THIRD-PARTY-NOTICES.md` (every crate linked into the module and its licence texts,
 *    from `cargo metadata`; `physics-wasm-notices.ts`) and `size.json` (bytes and gzip -9 bytes of
 *    the module and the JS). Then `npm pack` writes the tarball into `.studio-dev/dist/` with
 *    `<tarball>.sha256` beside it.
 *
 * `--test` builds with the `test-trap` feature into `.studio-dev/build/physics-wasm-test/` instead,
 * with the test hooks (`testing.js`) and no tarball: the package's tests
 * (`tests/conformance/physics-wasm-real.test.ts`) load that folder.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import {
  commonText,
  crateClosure,
  crateTexts,
  localPathsIn,
  type Metadata,
  noticeCrate,
  noticesMarkdown,
} from "./physics-wasm-notices.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const CRATE = "genex-physics-wasm";
const WASM_TARGET = "wasm32-unknown-unknown";
/** The workspace's cargo profile for this module: release, sized for a download (`Cargo.toml`). */
const CARGO_PROFILE = "wasm-physics";
const GLUE_NAME = "genex_physics_wasm";
const PHYSICS = path.join(REPO, "native/genex-rust/crates/genex-physics");
const JS_SOURCE = path.join(PHYSICS, "js");
const BUILD_ROOT = path.join(REPO, ".studio-dev/build");
const DIST = path.join(REPO, ".studio-dev/dist");
const GZIP_LEVEL = 9;
/** The env helper's opt-in to relative source paths (`rust-env.ts`). */
const REMAP_PATHS_ENV = { GENEX_RUST_REMAP_PATHS: "1" };
/** `cargo metadata` of the whole workspace can pass the default 1 MiB of output. */
const METADATA_MAX_BYTES = 256 * 1024 * 1024;
const NOTICES_FILE = "THIRD-PARTY-NOTICES.md";
const LICENSE_FILE = "LICENSE";
/**
 * The canonical texts for crates that ship no licence file (rapier3d, parry3d), by the file name other
 * crates use. Only Apache-2.0: an MIT text carries its own copyright line, which is no other crate's.
 */
const CANONICAL_LICENCE_FILES: [string, RegExp][] = [["Apache-2.0", /^LICENSE-APACHE$/]];
/** The features the pinned Rust's wasm32 target emits; wasm-opt must accept and keep them (web.sh's list). */
const WASM_OPT_FEATURES = [
  "--enable-bulk-memory",
  "--enable-nontrapping-float-to-int",
  "--enable-sign-ext",
  "--enable-mutable-globals",
  "--enable-reference-types",
  "--enable-multivalue",
];
/** What the package carries from `js/`; `testing.js` joins it in the test build only. */
const PACKAGE_FILES = ["package.json", "index.js", "node.js", "core.js", "index.d.ts", "README.md"];
const TEST_FILES = ["testing.js"];
const Flag = { Test: "--test", NoOpt: "--no-opt" } as const;

/** One build's choices. */
interface BuildPlan {
  test: boolean;
  optimize: boolean;
  out: string;
}

function plan(argv: string[]): BuildPlan {
  const known: string[] = Object.values(Flag);
  const unknown = argv.find((arg) => !known.includes(arg));
  if (unknown !== undefined) throw new Error(`physics-wasm: unknown argument ${unknown}`);
  const test = argv.includes(Flag.Test);
  const out = path.join(BUILD_ROOT, test ? "physics-wasm-test" : "physics-wasm");
  return { test, optimize: !argv.includes(Flag.NoOpt), out };
}

/** Runs a tool through the cargo env helper (the pinned toolchain only), with `extraEnv` added. */
function rustEnv(args: string[], extraEnv: Record<string, string> = {}): void {
  execFileSync(process.execPath, [path.join(REPO, "scripts/toolchains/rust-env.ts"), "--", ...args], {
    cwd: REPO,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
}

function targetDir(): string {
  return process.env.CARGO_TARGET_DIR ?? path.join(REPO, ".studio-dev/cargo-target");
}

/** The toolchain folder the env helper uses. */
function toolchainDir(): string {
  return process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev/spike-toolchain");
}

function cargoBuild(test: boolean): string {
  const features = test ? ["--features", "test-trap"] : [];
  rustEnv(
    [
      "cargo",
      "build",
      "-p",
      CRATE,
      "--lib",
      "--target",
      WASM_TARGET,
      "--profile",
      CARGO_PROFILE,
      "--offline",
      "--locked",
      ...features,
    ],
    REMAP_PATHS_ENV,
  );
  const wasm = path.join(targetDir(), WASM_TARGET, CARGO_PROFILE, `${GLUE_NAME}.wasm`);
  if (!existsSync(wasm)) throw new Error(`physics-wasm: cargo produced no ${wasm}`);
  return wasm;
}

function bindgen(wasm: string, out: string, optimize: boolean): void {
  const glueDir = path.join(out, "wasm");
  rustEnv([
    "wasm-bindgen",
    "--target",
    "web",
    "--no-typescript",
    "--experimental-reset-state-function",
    "--out-dir",
    glueDir,
    "--out-name",
    GLUE_NAME,
    wasm,
  ]);
  if (!optimize) return;
  const module = path.join(glueDir, `${GLUE_NAME}_bg.wasm`);
  const optimized = path.join(glueDir, `${GLUE_NAME}_bg.opt.wasm`);
  rustEnv(["wasm-opt", "-Oz", ...WASM_OPT_FEATURES, module, "-o", optimized]);
  rmSync(module);
  copyFileSync(optimized, module);
  rmSync(optimized);
}

/** Refuses a module that holds an absolute path of this machine (see the header). */
function checkNoLocalPaths(out: string): void {
  const module = path.join(out, "wasm", `${GLUE_NAME}_bg.wasm`);
  const needles = [path.resolve(REPO), path.resolve(toolchainDir()), os.homedir()];
  const found = localPathsIn(readFileSync(module), needles);
  if (found.length > 0) throw new Error(`physics-wasm: ${module} holds local paths: ${found.join(", ")}`);
}

/** THIRD-PARTY-NOTICES.md for every crate the binding links in, from `cargo metadata`. */
function thirdPartyNotices(): string {
  const args = [
    "cargo",
    "metadata",
    "--format-version",
    "1",
    "--filter-platform",
    WASM_TARGET,
    "--offline",
    "--locked",
  ];
  const text = execFileSync(process.execPath, [path.join(REPO, "scripts/toolchains/rust-env.ts"), "--", ...args], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: METADATA_MAX_BYTES,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const crates = crateClosure(JSON.parse(text) as Metadata, CRATE).map((pkg) => noticeCrate(pkg, crateTexts(pkg)));
  const canonical = new Map<string, string>();
  for (const [id, pattern] of CANONICAL_LICENCE_FILES) {
    const found = commonText(crates, pattern);
    if (found !== undefined) canonical.set(id, found);
  }
  return noticesMarkdown(crates, canonical);
}

function stage(out: string, test: boolean): void {
  for (const name of [...PACKAGE_FILES, ...(test ? TEST_FILES : [])]) {
    copyFileSync(path.join(JS_SOURCE, name), path.join(out, name));
  }
  copyFileSync(path.join(PHYSICS, "CONTRACT.md"), path.join(out, "CONTRACT.md"));
  copyFileSync(path.join(REPO, LICENSE_FILE), path.join(out, LICENSE_FILE));
  writeFileSync(path.join(out, NOTICES_FILE), thirdPartyNotices());
}

/** Bytes and gzip -9 bytes of the files a page or a process loads. */
function sizes(out: string): Record<string, { bytes: number; gzipBytes: number }> {
  const loaded = ["core.js", "index.js", "node.js", `wasm/${GLUE_NAME}.js`, `wasm/${GLUE_NAME}_bg.wasm`];
  const entries = loaded.map((name) => {
    const bytes = readFileSync(path.join(out, name));
    return [name, { bytes: bytes.length, gzipBytes: gzipSync(bytes, { level: GZIP_LEVEL }).length }] as const;
  });
  return Object.fromEntries(entries);
}

/** `npm pack` into `.studio-dev/dist/`, with `<tarball>.sha256` beside it; the tarball's path. */
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
  const { test, optimize, out } = plan(process.argv.slice(2));
  const wasm = cargoBuild(test);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  bindgen(wasm, out, optimize);
  checkNoLocalPaths(out);
  stage(out, test);
  const size = sizes(out);
  writeFileSync(
    path.join(out, "size.json"),
    `${JSON.stringify({ optimized: optimize, test, files: size }, null, 2)}\n`,
  );
  console.log(`physics-wasm: ${out}`);
  console.log(JSON.stringify(size));
  if (test) return;
  const tarball = pack(out);
  console.log(`physics-wasm: ${tarball} (sha256 in ${path.basename(tarball)}.sha256)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
