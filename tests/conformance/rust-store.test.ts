/**
 * The Rust · wgpu store payload (`rust-install.ts`, `rust-prewarm.ts`, `rust-locate.ts`): the
 * vendored crate tree held to its tree digest, the sysroot assembled from the pinned dist tarballs
 * and probed under a sandbox, the dependency build prewarmed per (lock, destination) with each
 * step held to the 10-minute kill line on an injected clock, artifacts located through Cargo's
 * JSON messages, copy-on-write clones of the prewarmed target folder per build or worktree, the
 * host-made naga validator, and the size receipt.
 *
 * Every group but the last runs on stubs (no cargo). The last builds a cold store from the
 * developer's pinned Rust downloads and vendored crates (`.studio-dev/spike-toolchain`, or
 * `GENEX_RUST_TOOLCHAIN_DIR`; TODO(M2.15): the dev-toolchains Rust rows) under the real
 * `ProcessSandbox` with the network off; it is required when present (`GENEX_REQUIRE_TOOLCHAINS=1`).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { layoutFor, studioBaseDenyWrites } from "../../src/main/core/layout.ts";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import {
  ArchiveFormat,
  type ToolchainEntry,
  ToolchainError,
  ToolchainHost,
  ToolchainId,
  ToolchainInstallPhase,
  type ToolchainLock,
  ToolchainProblem,
} from "../../src/shared/toolchain.ts";
import { isInside } from "../../src/substrate/paths.ts";
import { ProcessSandbox, type RunRequest, type RunResult } from "../../src/substrate/spawn.ts";
import { treeDigest } from "../../src/substrate/toolchain-store/archive.ts";
import { type InstallDeps, installComponents } from "../../src/substrate/toolchain-store/install.ts";
import { componentFolder } from "../../src/substrate/toolchain-store/locate.ts";
import { LOCKS_FOLDER, lockFolderName, lockOf, storeLockPaths } from "../../src/substrate/toolchain-store/lock.ts";
import { entrySha12, RUST_MANIFEST } from "../../src/substrate/toolchain-store/manifest.ts";
import { prewarmSandboxOptions } from "../../src/substrate/toolchain-store/prewarm.ts";
import {
  assembleSysroot,
  installRustBase,
  installRustVendor,
  RustBaseStep,
  VENDOR_TREE_FILE,
} from "../../src/substrate/toolchain-store/rust-install.ts";
import {
  type CargoMessage,
  CargoReason,
  cargoOutputs,
  locateRust,
  parseCargoMessages,
  RUST_BASE_FILE,
  RUST_DEV_PROFILE_SETTINGS,
  RUST_PREWARM_FILE,
  RUST_SIZES_FILE,
  RUST_TRIPLE,
  RustMissing,
  readRustBase,
  readRustPrewarm,
  rustCargoHome,
  rustEnv,
  rustPrewarmedTargetDir,
  rustSysroot,
  rustTargetFolder,
  rustToolsFolder,
  SYMBOLICATE_TOOL,
} from "../../src/substrate/toolchain-store/rust-locate.ts";
import {
  cloneRustTarget,
  prewarmRust,
  readWarmLock,
  RUST_EAGER_STORE_BUDGET_BYTES,
  RUST_PREWARM_STEP_TIMEOUT_MS,
  type RustPrewarmDeps,
  RustPrewarmStep,
  type RustWarmProject,
  recordRustSizes,
  rustPrewarmPlan,
  rustPrewarmPolicy,
  SYMBOLICATE_MAIN_RS,
  validateWgsl,
} from "../../src/substrate/toolchain-store/rust-prewarm.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const POSIX_ONLY = process.platform === "win32" ? { skip: "the store's sandbox rows are POSIX-only" } : {};
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const VERSION = "1.99.0";
const HOST_TRIPLE = RUST_TRIPLE[BuildTarget.Mac];
const NO_PIN = { version: "", sha12: "" };

// ---------- a fake store ----------

/** The browser's components at made-up pins. */
const WEB_PINS = {
  [ToolchainId.RustStdWasm]: { version: VERSION, sha12: "c".repeat(12) },
  [ToolchainId.WasmBindgen]: { version: "0.2.129", sha12: "d".repeat(12) },
  [ToolchainId.Binaryen]: { version: "133", sha12: "e".repeat(12) },
};

/** The cross and phone standard libraries a lock may name, with the destination each builds. */
const CROSS_STDS = [
  [ToolchainId.RustStdWindows, BuildTarget.Windows],
  [ToolchainId.RustStdLinux, BuildTarget.Linux],
  [ToolchainId.RustStdIos, BuildTarget.Ios],
  [ToolchainId.RustStdAndroid, BuildTarget.Android],
] as const;

/** A lock naming the Rust components at made-up pins. */
function rustLock(withWasm = true): ToolchainLock {
  return lockOf({
    [ToolchainId.Rust]: { version: VERSION, sha12: "a".repeat(12) },
    [ToolchainId.RustVendor]: { version: "0.1.0", sha12: "b".repeat(12) },
    ...(withWasm ? WEB_PINS : {}),
  });
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, ...rel.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

/** A receipt as `install.ts` writes it. */
async function writeReceipt(folder: string, id: ToolchainId, version: string, sha12: string): Promise<void> {
  const receipt = {
    id,
    version,
    sha256: sha12.padEnd(64, "0"),
    sha12,
    bytes: 1,
    host: ToolchainHost.MacArm64,
    target: null,
    source: "archive",
    installedAt: "2026-10-06T00:00:00.000Z",
  };
  await writeFile(path.join(folder, "receipt.json"), `${JSON.stringify(receipt)}\n`);
}

/** The fake parts the Rust dist tarballs unpack into, a fake browser std and a fake vendored tree, installed. */
async function fakeRustStore(withWasm = true): Promise<{ root: string; store: string; lock: ToolchainLock }> {
  const root = await realpath(await tmpDir("rust-store-"));
  const store = path.join(root, "toolchains");
  const lock = rustLock(withWasm);
  const pins = lock.entries;
  const rust = componentFolder(store, ToolchainId.Rust, pins[ToolchainId.Rust] ?? NO_PIN);
  await writeTree(rust, {
    "rustc/bin/rustc": "#!/bin/sh\n",
    "rustc/lib/librustc_driver.dylib": "driver",
    "rustc/manifest.in": "file:bin/rustc\n",
    "cargo/bin/cargo": "#!/bin/sh\n",
    "cargo/manifest.in": "file:bin/cargo\n",
    "clippy/bin/cargo-clippy": "#!/bin/sh\n",
    "clippy/bin/clippy-driver": "#!/bin/sh\n",
    [`llvm-tools/lib/rustlib/${HOST_TRIPLE}/bin/llvm-objcopy`]: "objcopy",
    [`rust-std/lib/rustlib/${HOST_TRIPLE}/lib/libstd.rlib`]: "std",
    "rust-std/manifest.in": "dir:lib/rustlib\n",
  });
  for (const tool of ["rustc/bin/rustc", "cargo/bin/cargo", "clippy/bin/cargo-clippy"])
    await chmod(path.join(rust, ...tool.split("/")), 0o755);
  await writeReceipt(rust, ToolchainId.Rust, VERSION, "a".repeat(12));
  const vendorPin = pins[ToolchainId.RustVendor] ?? NO_PIN;
  const vendor = componentFolder(store, ToolchainId.RustVendor, vendorPin);
  await writeTree(vendor, {
    "vendor/glam-0.33.0/src/lib.rs": "// glam\n",
    "vendor/glam-0.33.0/Cargo.toml": "[package]\n",
  });
  await writeReceipt(vendor, ToolchainId.RustVendor, vendorPin.version, vendorPin.sha12);
  const tree = await treeDigest(path.join(vendor, "vendor"));
  await writeFile(path.join(vendor, VENDOR_TREE_FILE), `${JSON.stringify(tree)}\n`);
  if (withWasm) {
    const wasm = componentFolder(store, ToolchainId.RustStdWasm, pins[ToolchainId.RustStdWasm] ?? NO_PIN);
    await writeTree(wasm, { "lib/rustlib/wasm32-unknown-unknown/lib/libstd.rlib": "wasm std", "manifest.in": "x\n" });
    await writeReceipt(wasm, ToolchainId.RustStdWasm, VERSION, "c".repeat(12));
    for (const id of [ToolchainId.WasmBindgen, ToolchainId.Binaryen] as const) {
      const pin = WEB_PINS[id];
      const folder = componentFolder(store, id, pin);
      await writeTree(folder, { tool: "tool" });
      await writeReceipt(folder, id, pin.version, pin.sha12);
    }
  }
  return { root, store, lock };
}

/** A sandbox command line without its shell quotes, for matching. */
const plain = (command: string) => command.replaceAll("'", "");

function ok(stdout: string, durationMs = 1): RunResult {
  const run = { sandboxed: true, command: "", cwd: "" };
  return { code: 0, signal: null, stdout, stderr: "", durationMs, timedOut: false, truncated: false, ...run };
}

/** A stub sandbox run for the base probes: rustc and cargo answer as the pinned ones would. */
function probeRun(calls: RunRequest[], override?: (request: RunRequest) => RunResult | null) {
  return async (request: RunRequest): Promise<RunResult> => {
    calls.push(request);
    const special = override?.(request);
    if (special) return special;
    const sysroot = path.join(request.cwd, "sysroot");
    const command = plain(request.command);
    if (command.includes("--print sysroot")) return ok(`${sysroot}\n`);
    const libdir = / --print target-libdir --target (\S+)/.exec(command)?.[1];
    if (libdir) return ok(`${path.join(sysroot, "lib", "rustlib", libdir, "lib")}\n`);
    if (command.includes("bin/cargo --version")) return ok(`cargo ${VERSION} (fake 2026-10-01)\n`);
    return ok(`rustc ${VERSION} (fake 2026-10-01)\n`);
  };
}

/** A fake store with the base (sysroot and CARGO_HOME) installed through stub probes. */
async function withBase(): Promise<{ root: string; store: string; lock: ToolchainLock }> {
  const fake = await fakeRustStore();
  await installRustBase(fake.store, fake.lock, { run: probeRun([]), denyWrite: [path.join(fake.root, "games")] });
  return fake;
}

/** The cargo profile every Live and judging build passes (K6, R-7, OPT, MK), which a prewarm must match. */
const LIVE_PROFILE = [
  "profile.dev.opt-level=1",
  'profile.dev.package."*".opt-level=3',
  'profile.dev.debug="line-tables-only"',
  'profile.dev.package."*".debug-assertions=false',
  'profile.dev.package."*".overflow-checks=false',
];

const WARM: RustWarmProject = {
  manifest: '[package]\nname = "genex-warm"\nversion = "0.0.0"\nedition = "2024"\n\n[dependencies]\nglam = "=0.33.0"\n',
  lock: "# lock\n",
  sources: { "src/main.rs": "fn main() {}\n" },
};

/** One Cargo JSON line. */
const json = (value: unknown) => `${JSON.stringify(value)}\n`;

interface CargoStub {
  clock?: { now: number };
  stepMs?: number;
  outside?: string;
  skipWrite?: boolean;
  code?: number;
}

/** The files one stub cargo step writes and names. */
function stubArtifacts(targetDir: string, triple: string) {
  const deps = path.join(targetDir, triple, "debug", "deps");
  return {
    rlib: path.join(deps, "libglam-1.rlib"),
    dylib: path.join(targetDir, "debug", "deps", "libserde_derive-2.dylib"),
    outDir: path.join(targetDir, triple, "debug", "build", "wgpu-3", "out"),
  };
}

/** The Cargo JSON a stub step prints for `files`. */
function stubMessages(files: ReturnType<typeof stubArtifacts>, rlib: string): string {
  const crate = (name: string) => `registry+https://github.com/rust-lang/crates.io-index#${name}`;
  return [
    "not json: Compiling glam\n",
    json({
      reason: CargoReason.CompilerArtifact,
      package_id: crate("glam@0.33.0"),
      target: { kind: ["lib"], name: "glam" },
      filenames: [rlib],
      executable: null,
      fresh: false,
    }),
    json({
      reason: CargoReason.CompilerArtifact,
      package_id: crate("serde_derive@1.0.0"),
      target: { kind: ["proc-macro"], name: "serde_derive" },
      filenames: [files.dylib],
      executable: null,
      fresh: false,
    }),
    json({ reason: CargoReason.BuildScriptExecuted, package_id: crate("wgpu@30.0.1"), out_dir: files.outDir }),
    json({ reason: CargoReason.BuildFinished, success: true }),
  ].join("");
}

/**
 * A stub cargo: each step writes a dependency rlib, a proc-macro dylib and a build script's out
 * dir into the run's CARGO_TARGET_DIR and prints the Cargo JSON messages naming them.
 */
function cargoRun(calls: RunRequest[], options: CargoStub = {}) {
  return async (request: RunRequest): Promise<RunResult> => {
    calls.push(request);
    if (options.clock) options.clock.now += options.stepMs ?? 0;
    if (options.code !== undefined)
      return { ...ok(""), code: options.code, stderr: "error[E0425]: cannot find value `x`\n" };
    const triple = /--target (\S+)/.exec(plain(request.command))?.[1] ?? "host";
    const files = stubArtifacts(request.env?.CARGO_TARGET_DIR ?? "", triple);
    if (!options.skipWrite) {
      for (const file of [files.rlib, files.dylib]) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, file.endsWith(".rlib") ? "rlib" : "dylib");
      }
      await mkdir(files.outDir, { recursive: true });
      await writeFile(path.join(files.outDir, "gen.rs"), "// generated\n");
    }
    return ok(stubMessages(files, options.outside ?? files.rlib));
  };
}

function prewarmDeps(root: string, run: RustPrewarmDeps["run"], extra: Partial<RustPrewarmDeps> = {}): RustPrewarmDeps {
  return { run, denyWrite: [path.join(root, "games")], tools: false, ...extra };
}

async function rejectsWith(promise: Promise<unknown>, problem: ToolchainProblem, pattern?: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ToolchainError, String(error));
    assert.equal(error.problem, problem, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

// ---------- where the outputs live ----------

describe("rust store: prewarm outputs are the host's, never an agent's", () => {
  it("every Rust store output sits under a folder every sandboxed process is denied writing", async () => {
    const userData = await realpath(await tmpDir("rust-layout-"));
    const layout = layoutFor(userData, path.join(userData, "downloads"));
    const lock = rustLock();
    const denied = studioBaseDenyWrites(layout, []);
    const outputs = [
      rustSysroot(layout.toolchains, lock),
      rustCargoHome(layout.toolchains, lock),
      rustToolsFolder(layout.toolchains, lock),
      ...Object.values(BuildTarget).flatMap((target) => [
        rustTargetFolder(layout.toolchains, lock, target),
        rustPrewarmedTargetDir(layout.toolchains, lock, target),
      ]),
    ];
    for (const output of outputs)
      assert.ok(
        denied.some((deny) => isInside(deny, output)),
        `${output} is not under any of ${denied.join(", ")}`,
      );
  });

  it("a prewarm step writes only its staging folder: never installs, lock folders or lock files", async () => {
    const { root, store, lock } = await fakeRustStore();
    const staging = path.join(store, ".staging", `${lock.digest}-${BuildTarget.Mac}`);
    const games = path.join(root, "games");
    const policy = rustPrewarmPolicy(store, staging, [games]);
    assert.deepEqual(policy.allowedDomains, []);
    assert.deepEqual(policy.allowWrite, [staging]);
    const denied = [
      games,
      path.join(store, LOCKS_FOLDER),
      ...Object.values(ToolchainId).map((id) => path.join(store, id)),
      ...storeLockPaths(store),
    ];
    for (const folder of denied) assert.ok(policy.denyWrite?.includes(folder), `${folder} is denied`);
  });

  it("a caller's deny that holds the store (a dev store inside the checkout) never denies the staging folder", async () => {
    const { root, store, lock } = await fakeRustStore();
    const staging = path.join(store, ".staging", `${lock.digest}-${BuildTarget.Mac}`);
    const games = path.join(root, "games");
    const policy = rustPrewarmPolicy(store, staging, [root, games]);
    const covering = (policy.denyWrite ?? []).filter((deny) => isInside(deny, staging));
    assert.deepEqual(covering, [], "a deny beats the staging allow beneath it");
    const denied = [
      games,
      path.join(store, LOCKS_FOLDER),
      ...Object.values(ToolchainId).map((id) => path.join(store, id)),
    ];
    for (const folder of denied) assert.ok(policy.denyWrite?.includes(folder), `${folder} is still denied`);
  });

  it(
    "under the real sandbox an agent writes its clone of the prewarmed target folder, never the prewarm itself",
    POSIX_ONLY,
    async () => {
      const { root, store, lock } = await withBase();
      await prewarmRust(store, lock, BuildTarget.Mac, WARM, prewarmDeps(root, cargoRun([])));
      const worktree = path.join(root, "workspaces", "games", "pond", ".worktrees", "facet-1");
      await mkdir(worktree, { recursive: true });
      const clone = path.join(worktree, "target");
      await cloneRustTarget(store, lock, BuildTarget.Mac, clone);
      const layout = { ...layoutFor(root, path.join(root, "downloads")), toolchains: store };
      const sandbox = await ProcessSandbox.create({
        writableRoots: [path.join(root, "workspaces")],
        scratchDir: path.join(root, "agent-scratch"),
        secretPaths: [],
        denyWrite: studioBaseDenyWrites(layout, []),
      });
      after(() => sandbox.dispose());
      const prewarmed = rustPrewarmedTargetDir(store, lock, BuildTarget.Mac);
      const rel = path.join(HOST_TRIPLE, "debug", "deps", "libglam-1.rlib");
      const q = (value: string) => `'${value}'`;
      const outcome = await sandbox.run({
        command: [
          `echo agent > ${q(path.join(clone, rel))} && echo clone-written;`,
          `echo agent > ${q(path.join(prewarmed, rel))} && echo prewarm-written;`,
          `echo agent > ${q(path.join(prewarmed, "planted"))} && echo prewarm-planted;`,
          "true",
        ].join(" "),
        cwd: worktree,
      });
      assert.equal(outcome.sandboxed, true);
      assert.deepEqual(outcome.stdout.trim().split("\n"), ["clone-written"], outcome.stderr);
      assert.equal(await readFile(path.join(prewarmed, rel), "utf8"), "rlib", "the prewarm output is unchanged");
      assert.equal(existsSync(path.join(prewarmed, "planted")), false);
    },
  );
});

// ---------- the vendored crate tree ----------

/** A gzipped tarball of `folder`'s `vendor/`, made by the machine's tar. */
async function vendorTarGz(folder: string, out: string): Promise<{ bytes: number; sha256: string }> {
  await execFileAsync("tar", ["-czf", out, "-C", folder, "vendor"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(out)) hash.update(chunk as Buffer);
  return { bytes: statSync(out).size, sha256: hash.digest("hex") };
}

/** Fetch serving files from disk by URL. */
function fileFetch(served: Record<string, string>): InstallDeps["fetch"] {
  return async (url: string) => {
    const file = served[url];
    if (!file) return new Response("absent", { status: 404 });
    const body = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
    return new Response(body, { status: 200, headers: { "content-length": String(statSync(file).size) } });
  };
}

function installDeps(fetch: InstallDeps["fetch"], run: InstallDeps["run"] = async () => ok("")): InstallDeps {
  return { fetch, run, freeBytes: async () => 1024 ** 4, onJob: () => {} };
}

const VENDOR_URL = "https://github.com/genex-games/genex-desktop/releases/download/genex-0.1.0/rust-vendor.tar.gz";

async function vendorEntry(
  root: string,
  files: Record<string, string>,
): Promise<{ entry: ToolchainEntry; archive: string }> {
  const source = path.join(root, "vendor-source");
  await writeTree(path.join(source, "vendor"), files);
  const archive = path.join(root, "rust-vendor.tar.gz");
  const { bytes, sha256 } = await vendorTarGz(source, archive);
  const entry: ToolchainEntry = {
    id: ToolchainId.RustVendor,
    version: "0.1.0",
    host: null,
    target: null,
    licence: "per crate (inventory)",
    archives: [{ url: VENDOR_URL, bytes, sha256, format: ArchiveFormat.TarGz, strip: 0, into: "" }],
  };
  return { entry, archive };
}

describe("rust store: the vendored crate tree", () => {
  it("the tree digest names every file's path, size, bytes and executable bit", async () => {
    const root = await tmpDir("tree-");
    await writeTree(root, { "b/x.rs": "x", "a.rs": "a" });
    const first = await treeDigest(root);
    assert.equal(first.files, 2);
    assert.equal(first.bytes, 2);
    assert.match(first.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(await treeDigest(root), first, "stable");
    await writeFile(path.join(root, "a.rs"), "A");
    const edited = await treeDigest(root);
    assert.notEqual(edited.sha256, first.sha256, "a changed byte changes it");
    await chmod(path.join(root, "a.rs"), 0o755);
    if (process.platform !== "win32")
      assert.notEqual((await treeDigest(root)).sha256, edited.sha256, "the x bit counts");
  });

  it("a tree holding a link is never digested", POSIX_ONLY, async () => {
    const root = await tmpDir("tree-link-");
    await writeTree(root, { "a.rs": "a" });
    await symlink("/etc/hosts", path.join(root, "hosts"));
    await rejectsWith(treeDigest(root), ToolchainProblem.Integrity, /hosts/);
  });

  it("installs the vendored archive when its unpacked tree matches the pinned tree digest", POSIX_ONLY, async () => {
    const root = await realpath(await tmpDir("vendor-ok-"));
    const files = { "glam-0.33.0/src/lib.rs": "// glam\n", "glam-0.33.0/.cargo-checksum.json": "{}" };
    const { entry, archive } = await vendorEntry(root, files);
    const pin = await treeDigest(path.join(root, "vendor-source", "vendor"));
    const store = path.join(root, "toolchains");
    const job = await installRustVendor(store, entry, pin, installDeps(fileFetch({ [VENDOR_URL]: archive })));
    assert.equal(job.phase, ToolchainInstallPhase.Installed, JSON.stringify(job));
    const folder = componentFolder(store, ToolchainId.RustVendor, { version: entry.version, sha12: entrySha12(entry) });
    assert.equal(await readFile(path.join(folder, "vendor", "glam-0.33.0", "src", "lib.rs"), "utf8"), "// glam\n");
    assert.deepEqual(JSON.parse(await readFile(path.join(folder, VENDOR_TREE_FILE), "utf8")), pin);
  });

  it(
    "a tampered vendored tree (not the pinned tree digest) refuses install and leaves no folder",
    POSIX_ONLY,
    async () => {
      const root = await realpath(await tmpDir("vendor-tampered-"));
      const { entry, archive } = await vendorEntry(root, {
        "glam-0.33.0/src/lib.rs": "// glam, with a planted line\n",
      });
      const reviewed = await tmpDir("vendor-reviewed-");
      await writeTree(reviewed, { "glam-0.33.0/src/lib.rs": "// glam\n" });
      const pin = await treeDigest(reviewed);
      const store = path.join(root, "toolchains");
      const job = await installRustVendor(store, entry, pin, installDeps(fileFetch({ [VENDOR_URL]: archive })));
      assert.equal(job.phase, ToolchainInstallPhase.Failed);
      assert.equal(job.problem, ToolchainProblem.Integrity);
      assert.equal(existsSync(path.join(store, ToolchainId.RustVendor)), false, "no vendored folder is left");
      assert.equal(existsSync(path.join(store, ".staging")), false, "no staging is left");
    },
  );

  it("the base install re-checks the installed tree: one edited after install refuses the base", async () => {
    const { root, store, lock } = await fakeRustStore();
    const vendor = componentFolder(store, ToolchainId.RustVendor, lock.entries[ToolchainId.RustVendor] ?? NO_PIN);
    await writeFile(path.join(vendor, "vendor", "glam-0.33.0", "src", "lib.rs"), "// planted\n");
    await rejectsWith(
      installRustBase(store, lock, { run: probeRun([]), denyWrite: [path.join(root, "games")] }),
      ToolchainProblem.Integrity,
    );
    assert.equal(existsSync(rustSysroot(store, lock)), false);
  });
});

// ---------- the sysroot ----------

describe("rust store: the sysroot", () => {
  it("assembles one sysroot from the dist parts, without their manifests", async () => {
    const root = await tmpDir("sysroot-");
    const readme = "share/doc/rust/README.md";
    await writeTree(path.join(root, "rustc"), { "bin/rustc": "rustc", "manifest.in": "m", [readme]: "r" });
    await writeTree(path.join(root, "std"), {
      "lib/rustlib/x/lib/libstd.rlib": "std",
      "manifest.in": "m2",
      [readme]: "r",
    });
    const into = path.join(root, "sysroot");
    await assembleSysroot([path.join(root, "rustc"), path.join(root, "std")], into);
    assert.equal(await readFile(path.join(into, "bin", "rustc"), "utf8"), "rustc");
    assert.equal(await readFile(path.join(into, "lib", "rustlib", "x", "lib", "libstd.rlib"), "utf8"), "std");
    assert.equal(existsSync(path.join(into, "manifest.in")), false);
  });

  it("refuses two parts that disagree about one file, and a part holding a link", POSIX_ONLY, async () => {
    const root = await tmpDir("sysroot-bad-");
    await writeTree(path.join(root, "a"), { "bin/rustc": "one" });
    await writeTree(path.join(root, "b"), { "bin/rustc": "two" });
    await rejectsWith(
      assembleSysroot([path.join(root, "a"), path.join(root, "b")], path.join(root, "s1")),
      ToolchainProblem.Integrity,
      /bin\/rustc/,
    );
    await symlink("/usr/bin/true", path.join(root, "a", "bin", "linked"));
    await rejectsWith(
      assembleSysroot([path.join(root, "a")], path.join(root, "s2")),
      ToolchainProblem.Integrity,
      /linked/,
    );
  });

  it("installs the base: the sysroot with the browser's std and a CARGO_HOME on the vendored tree, probed sandboxed", async () => {
    const { root, store, lock } = await fakeRustStore();
    const calls: RunRequest[] = [];
    const games = path.join(root, "games");
    const record = await installRustBase(store, lock, { run: probeRun(calls), denyWrite: [games] });
    const sysroot = rustSysroot(store, lock);
    assert.equal(await readFile(path.join(sysroot, "bin", "rustc"), "utf8"), "#!/bin/sh\n");
    assert.ok(existsSync(path.join(sysroot, "lib", "rustlib", HOST_TRIPLE, "lib", "libstd.rlib")));
    assert.ok(existsSync(path.join(sysroot, "lib", "rustlib", "wasm32-unknown-unknown", "lib", "libstd.rlib")));
    assert.deepEqual(record.triples, [HOST_TRIPLE, RUST_TRIPLE[BuildTarget.Web]]);
    const config = await readFile(path.join(rustCargoHome(store, lock), "config.toml"), "utf8");
    const vendor = componentFolder(store, ToolchainId.RustVendor, lock.entries[ToolchainId.RustVendor] ?? NO_PIN);
    assert.ok(config.includes(JSON.stringify(path.join(vendor, "vendor"))), config);
    assert.match(config, /offline = true/);
    assert.ok(calls.length >= 3, "rustc, cargo and the sysroot are probed");
    for (const call of calls) {
      assert.equal(call.label, RustBaseStep.Probe);
      assert.deepEqual(call.policy?.allowedDomains, []);
      assert.ok(call.policy?.denyWrite?.includes(games));
      assert.ok(call.policy?.allowWrite?.every((folder) => isInside(path.join(store, ".staging"), folder)));
    }
    assert.equal(existsSync(path.join(store, ".staging")), false);
  });

  it("merges every cross and phone standard library the lock names into the sysroot, each probed", async () => {
    const { root, store, lock } = await fakeRustStore();
    const entries = { ...lock.entries };
    for (const [id, target] of CROSS_STDS) {
      const pin = { version: VERSION, sha12: createHash("sha256").update(id).digest("hex").slice(0, 12) };
      const folder = componentFolder(store, id, pin);
      await writeTree(folder, { [`lib/rustlib/${RUST_TRIPLE[target]}/lib/libstd.rlib`]: id, "manifest.in": "x\n" });
      await writeReceipt(folder, id, pin.version, pin.sha12);
      entries[id] = pin;
    }
    const iosSim = { version: VERSION, sha12: "f".repeat(12) };
    const sim = componentFolder(store, ToolchainId.RustStdIosSim, iosSim);
    await writeTree(sim, { "lib/rustlib/aarch64-apple-ios-sim/lib/libstd.rlib": "sim", "manifest.in": "x\n" });
    await writeReceipt(sim, ToolchainId.RustStdIosSim, VERSION, iosSim.sha12);
    const all = lockOf({ ...entries, [ToolchainId.RustStdIosSim]: iosSim });
    const calls: RunRequest[] = [];
    const record = await installRustBase(store, all, { run: probeRun(calls), denyWrite: [path.join(root, "games")] });
    const sysroot = rustSysroot(store, all);
    const triples = [...CROSS_STDS.map(([, target]) => RUST_TRIPLE[target]), "aarch64-apple-ios-sim"];
    for (const triple of triples)
      assert.ok(existsSync(path.join(sysroot, "lib", "rustlib", triple, "lib", "libstd.rlib")), triple);
    assert.deepEqual([...record.triples].sort(), [HOST_TRIPLE, RUST_TRIPLE[BuildTarget.Web], ...triples].sort());
    assert.equal(record.triples[0], HOST_TRIPLE, "the host's first");
    const probed = calls.map((call) => / --target (\S+)/.exec(plain(call.command))?.[1]).filter(Boolean);
    assert.deepEqual(probed.sort(), [RUST_TRIPLE[BuildTarget.Web], ...triples].sort());
  });

  it("a probe that finds another sysroot refuses the base and swaps nothing in", async () => {
    const { root, store, lock } = await fakeRustStore();
    const run = probeRun([], (request) =>
      plain(request.command).includes("--print sysroot") ? ok("/Users/someone/.rustup/toolchains/stable\n") : null,
    );
    await rejectsWith(
      installRustBase(store, lock, { run, denyWrite: [path.join(root, "games")] }),
      ToolchainProblem.Probe,
    );
    assert.equal(existsSync(rustSysroot(store, lock)), false);
    assert.equal(existsSync(path.join(store, ".staging")), false);
  });
});

// ---------- prewarm ----------

describe("rust store: prewarm per (lock, destination)", () => {
  it("prewarms the host's own destination and the web eagerly, the rest lazily", () => {
    assert.deepEqual(rustPrewarmPlan(ToolchainHost.MacArm64), {
      eager: [BuildTarget.Mac, BuildTarget.Web],
      lazy: [BuildTarget.Ios, BuildTarget.Android, BuildTarget.Windows, BuildTarget.Linux],
    });
    assert.deepEqual(rustPrewarmPlan(ToolchainHost.LinuxX64), {
      eager: [BuildTarget.Linux, BuildTarget.Web],
      lazy: [BuildTarget.Windows, BuildTarget.Android],
    });
    assert.deepEqual(rustPrewarmPlan(ToolchainHost.WindowsX64), { eager: [], lazy: [] });
    assert.deepEqual(rustPrewarmPlan(null), { eager: [], lazy: [] });
  });

  it("a tools prewarm also builds the naga validator and the crash symbolicator offline, staging both in the tools folder", async () => {
    const { root, store, lock } = await withBase();
    const calls: RunRequest[] = [];
    const sources: Record<string, string> = {};
    const warm = cargoRun(calls);
    const tools: ReadonlySet<string> = new Set([
      RustPrewarmStep.NagaLockfile,
      RustPrewarmStep.NagaBuild,
      RustPrewarmStep.SymbolicateLockfile,
      RustPrewarmStep.SymbolicateBuild,
    ]);
    const run = async (request: RunRequest): Promise<RunResult> => {
      if (!tools.has(request.label ?? "")) return warm(request);
      calls.push(request);
      const manifest = /--manifest-path (\S+)/.exec(plain(request.command))?.[1] ?? "";
      const name = path.basename(path.dirname(manifest));
      sources[name] = await readFile(path.join(path.dirname(manifest), "src", "main.rs"), "utf8");
      if (!plain(request.command).includes(" build ")) return ok("");
      const exe = path.join(request.env?.CARGO_TARGET_DIR ?? "", "release", name);
      await mkdir(path.dirname(exe), { recursive: true });
      await writeFile(exe, "#!/bin/sh\n");
      const message = { reason: CargoReason.CompilerArtifact, package_id: `path+file:///t#${name}@0.0.0` };
      return ok(json({ ...message, target: { kind: ["bin"], name }, filenames: [exe], executable: exe, fresh: false }));
    };
    await prewarmRust(store, lock, BuildTarget.Mac, WARM, prewarmDeps(root, run, { tools: true }));
    assert.deepEqual(
      calls.map((call) => call.label),
      [RustPrewarmStep.Check, RustPrewarmStep.Build, ...tools],
    );
    for (const call of calls.filter((call) => tools.has(call.label ?? ""))) {
      assert.match(plain(call.command), /--offline/);
      assert.deepEqual(call.policy?.allowedDomains, []);
      if (plain(call.command).includes(" build ")) assert.match(plain(call.command), /--locked/);
    }
    assert.equal(sources[SYMBOLICATE_TOOL], SYMBOLICATE_MAIN_RS);
    const located = await locateRust(store, lock, BuildTarget.Mac);
    assert.ok(located.ok, JSON.stringify(located));
    assert.equal(located.located.symbolicate, path.join(rustToolsFolder(store, lock), SYMBOLICATE_TOOL));
    assert.ok(located.located.nagaCheck);
  });

  it("builds the dependency closure offline and locked under the sandbox, locating artifacts through Cargo's JSON", async () => {
    const { root, store, lock } = await withBase();
    const calls: RunRequest[] = [];
    const clock = { now: Date.parse("2026-10-06T00:00:00Z") };
    const run = cargoRun(calls, { clock, stepMs: 90 * SECOND_MS });
    const deps = prewarmDeps(root, run, { now: () => clock.now, rustflags: ["-Dwarnings"] });
    const record = await prewarmRust(store, lock, BuildTarget.Web, WARM, deps);
    assert.deepEqual(
      calls.map((call) => call.label),
      [RustPrewarmStep.Check, RustPrewarmStep.Build],
    );
    const staging = path.join(store, ".staging", `${lock.digest}-${BuildTarget.Web}`);
    for (const call of calls) {
      assert.match(plain(call.command), /--offline/);
      assert.match(plain(call.command), /--locked/);
      assert.match(plain(call.command), /--target wasm32-unknown-unknown/);
      assert.match(plain(call.command), /--message-format=json/);
      // The lane's dev profile (K6, OPT), exactly, or a game's build cloning this folder rebuilds every dependency.
      const profile = [...plain(call.command).matchAll(/--config (profile\.\S+)/g)].map((match) => match[1]);
      assert.deepEqual(profile, LIVE_PROFILE, call.label);
      assert.equal(call.timeoutMs, RUST_PREWARM_STEP_TIMEOUT_MS);
      assert.deepEqual(call.policy?.allowedDomains, []);
      assert.deepEqual(call.policy?.allowWrite, [staging]);
      assert.ok(isInside(staging, call.env?.CARGO_TARGET_DIR ?? "/"), "the target folder is in staging");
      assert.ok(isInside(staging, call.env?.CARGO_HOME ?? "/"), "CARGO_HOME is the run's own");
      assert.equal(call.env?.CARGO_ENCODED_RUSTFLAGS, "-Dwarnings");
      assert.equal(call.env?.RUSTC_WRAPPER, "");
      assert.ok(call.env?.RUSTC?.startsWith(rustSysroot(store, lock)));
    }
    assert.equal(record.lock, lock.digest);
    assert.equal(record.triple, "wasm32-unknown-unknown");
    assert.deepEqual(record.rustflags, ["-Dwarnings"]);
    assert.deepEqual(
      record.steps.map((step) => [step.label, step.ms]),
      [
        [RustPrewarmStep.Check, 90 * SECOND_MS],
        [RustPrewarmStep.Build, 90 * SECOND_MS],
      ],
    );
    assert.ok(record.outputs.includes("wasm32-unknown-unknown/debug/deps/libglam-1.rlib"), record.outputs.join(", "));
    assert.ok(record.outputs.includes("debug/deps/libserde_derive-2.dylib"));
    assert.ok(record.outputs.includes("wasm32-unknown-unknown/debug/build/wgpu-3/out"));
    assert.equal(record.units, 3);
    assert.deepEqual(record.profile, LIVE_PROFILE);
    const located = await locateRust(store, lock, BuildTarget.Web, { rustflags: ["-Dwarnings"] });
    assert.ok(located.ok, JSON.stringify(located));
    assert.equal(located.located.targetDir, rustPrewarmedTargetDir(store, lock, BuildTarget.Web));
    assert.equal(existsSync(path.join(store, ".staging")), false);
    const stale = await locateRust(store, lock, BuildTarget.Web, { rustflags: ["-Dclippy::all"] });
    assert.equal(stale.ok, false, "other flags are another dependency build");
  });

  it("a prewarm built with another cargo profile (the dependencies at opt-level 1, before OPT; with their debug assertions, before MK) is stale: it is prewarmed again", async () => {
    const { root, store, lock } = await withBase();
    const record = await prewarmRust(store, lock, BuildTarget.Web, WARM, prewarmDeps(root, cargoRun([])));
    assert.ok((await locateRust(store, lock, BuildTarget.Web)).ok, "the record as written locates");
    const file = path.join(rustTargetFolder(store, lock, BuildTarget.Web), RUST_PREWARM_FILE);
    const older = ['profile.dev.package."*".opt-level=1', 'profile.dev.debug="line-tables-only"'];
    const checked = LIVE_PROFILE.filter(
      (setting) => !setting.includes("-assertions=") && !setting.includes("-checks="),
    );
    for (const profile of [older, checked, [...LIVE_PROFILE].reverse(), [...LIVE_PROFILE, "profile.dev.lto=true"]]) {
      await writeFile(file, JSON.stringify({ ...record, profile }));
      const located = await locateRust(store, lock, BuildTarget.Web);
      assert.deepEqual(located.ok ? [] : located.missing, [RustMissing.Prewarm], JSON.stringify(profile));
    }
  });

  it("a cold step that runs past 10 minutes fails the receipt, even when cargo finished; nothing is swapped in", async () => {
    const { root, store, lock } = await withBase();
    const clock = { now: 0 };
    const slow = cargoRun([], { clock, stepMs: RUST_PREWARM_STEP_TIMEOUT_MS + 1 });
    await rejectsWith(
      prewarmRust(store, lock, BuildTarget.Mac, WARM, prewarmDeps(root, slow, { now: () => clock.now })),
      ToolchainProblem.Prewarm,
      /10 minutes/,
    );
    assert.equal(existsSync(rustTargetFolder(store, lock, BuildTarget.Mac)), false);
    assert.equal(existsSync(path.join(store, ".staging")), false);
    const atLimit = cargoRun([], { clock, stepMs: RUST_PREWARM_STEP_TIMEOUT_MS });
    const deps = prewarmDeps(root, atLimit, { now: () => clock.now });
    const record = await prewarmRust(store, lock, BuildTarget.Mac, WARM, deps);
    assert.ok(record.steps.every((step) => step.ms === RUST_PREWARM_STEP_TIMEOUT_MS));
  });

  it("a step the sandbox timed out, or a failing cargo, refuses with what cargo said", async () => {
    const { root, store, lock } = await withBase();
    const timedOut = async (): Promise<RunResult> => ({ ...ok(""), code: null, signal: "SIGKILL", timedOut: true });
    await rejectsWith(
      prewarmRust(store, lock, BuildTarget.Mac, WARM, prewarmDeps(root, timedOut)),
      ToolchainProblem.Prewarm,
      /10 minutes/,
    );
    await rejectsWith(
      prewarmRust(store, lock, BuildTarget.Mac, WARM, prewarmDeps(root, cargoRun([], { code: 101 }))),
      ToolchainProblem.Prewarm,
      /E0425/,
    );
    assert.equal(existsSync(rustTargetFolder(store, lock, BuildTarget.Mac)), false);
  });

  it("refuses an artifact Cargo reports outside the target folder, and one Cargo reports but never wrote", async () => {
    const { root, store, lock } = await withBase();
    const outside = path.join(root, "elsewhere", "libglam.rlib");
    await rejectsWith(
      prewarmRust(store, lock, BuildTarget.Mac, WARM, prewarmDeps(root, cargoRun([], { outside }))),
      ToolchainProblem.Prewarm,
      /outside/,
    );
    await rejectsWith(
      prewarmRust(store, lock, BuildTarget.Mac, WARM, prewarmDeps(root, cargoRun([], { skipWrite: true }))),
      ToolchainProblem.Prewarm,
      /did not leave it/,
    );
    assert.equal(existsSync(rustTargetFolder(store, lock, BuildTarget.Mac)), false);
  });

  it("refuses a destination whose standard library the lock does not name, and a store without the base", async () => {
    const { root, store, lock } = await withBase();
    await rejectsWith(
      prewarmRust(store, lock, BuildTarget.Android, WARM, prewarmDeps(root, cargoRun([]))),
      ToolchainProblem.Prewarm,
      /aarch64-linux-android/,
    );
    const bare = await fakeRustStore();
    await rejectsWith(
      prewarmRust(bare.store, bare.lock, BuildTarget.Mac, WARM, prewarmDeps(bare.root, cargoRun([]))),
      ToolchainProblem.Prewarm,
      /sysroot/,
    );
  });

  it("a destination prewarmed later keeps the ones already there", async () => {
    const { root, store, lock } = await withBase();
    await prewarmRust(store, lock, BuildTarget.Mac, WARM, prewarmDeps(root, cargoRun([])));
    await prewarmRust(store, lock, BuildTarget.Web, WARM, prewarmDeps(root, cargoRun([])));
    assert.ok((await locateRust(store, lock, BuildTarget.Mac)).ok);
    assert.ok((await locateRust(store, lock, BuildTarget.Web)).ok);
  });
});

// ---------- copy-on-write clones ----------

describe("rust store: a clone of the prewarmed target folder per build or worktree", () => {
  it("clones every file with its own inode and its timestamps", async () => {
    const { root, store, lock } = await withBase();
    await prewarmRust(store, lock, BuildTarget.Mac, WARM, prewarmDeps(root, cargoRun([])));
    const source = rustPrewarmedTargetDir(store, lock, BuildTarget.Mac);
    const rel = path.join(HOST_TRIPLE, "debug", "deps", "libglam-1.rlib");
    const past = new Date("2026-01-01T00:00:00Z");
    await utimes(path.join(source, rel), past, past);
    const to = path.join(root, "rust-builds", "run-1", "target");
    await mkdir(path.dirname(to), { recursive: true });
    const cloned = await cloneRustTarget(store, lock, BuildTarget.Mac, to);
    assert.ok(cloned.files >= 3);
    const [a, b] = await Promise.all([stat(path.join(source, rel)), stat(path.join(to, rel))]);
    assert.notEqual(a.ino, b.ino, "a clone, never a hard link into the store");
    assert.equal(b.mtimeMs, a.mtimeMs);
    await writeFile(path.join(to, rel), "rebuilt");
    assert.equal(await readFile(path.join(source, rel), "utf8"), "rlib");
  });

  it(
    "refuses an existing destination, one inside the store, an unprewarmed destination and a prewarm holding a link",
    POSIX_ONLY,
    async () => {
      const { root, store, lock } = await withBase();
      await prewarmRust(store, lock, BuildTarget.Mac, WARM, prewarmDeps(root, cargoRun([])));
      const taken = path.join(root, "taken");
      await mkdir(taken);
      await rejectsWith(cloneRustTarget(store, lock, BuildTarget.Mac, taken), ToolchainProblem.Prewarm, /exists/);
      await rejectsWith(
        cloneRustTarget(store, lock, BuildTarget.Mac, path.join(store, "clone")),
        ToolchainProblem.Prewarm,
        /store/,
      );
      await rejectsWith(
        cloneRustTarget(store, lock, BuildTarget.Web, path.join(root, "web")),
        ToolchainProblem.Prewarm,
        /web/,
      );
      await symlink("/etc", path.join(rustPrewarmedTargetDir(store, lock, BuildTarget.Mac), "etc"));
      await rejectsWith(
        cloneRustTarget(store, lock, BuildTarget.Mac, path.join(root, "c2")),
        ToolchainProblem.Prewarm,
        /etc/,
      );
      assert.equal(existsSync(path.join(root, "c2")), false, "a refused clone leaves nothing");
    },
  );
});

// ---------- sizes ----------

describe("rust store: the size receipt", () => {
  it("records each part's bytes once and whether the eager store is within budget", async () => {
    const { root, store, lock } = await withBase();
    await prewarmRust(store, lock, BuildTarget.Mac, WARM, prewarmDeps(root, cargoRun([])));
    await prewarmRust(store, lock, BuildTarget.Web, WARM, prewarmDeps(root, cargoRun([])));
    const sizes = await recordRustSizes(store, lock, [BuildTarget.Mac, BuildTarget.Web]);
    assert.equal(sizes.budgetBytes, RUST_EAGER_STORE_BUDGET_BYTES);
    assert.ok((sizes.targets[BuildTarget.Mac] ?? 0) > 0 && (sizes.targets[BuildTarget.Web] ?? 0) > 0);
    assert.equal(sizes.sysrootBytes, 0, "the sysroot shares the installed parts' bytes");
    assert.ok(sizes.componentBytes > 0);
    const parts = sizes.componentBytes + sizes.sysrootBytes + sizes.cargoHomeBytes + sizes.toolsBytes;
    const targets = (sizes.targets[BuildTarget.Mac] ?? 0) + (sizes.targets[BuildTarget.Web] ?? 0);
    assert.equal(sizes.eagerBytes, parts + targets);
    assert.equal(sizes.withinBudget, true);
    const file = path.join(store, LOCKS_FOLDER, lockFolderName(lock), RUST_SIZES_FILE);
    assert.equal(JSON.parse(await readFile(file, "utf8")).eagerBytes, sizes.eagerBytes);
    const tight = await recordRustSizes(store, lock, [BuildTarget.Mac], { budgetBytes: 1 });
    assert.equal(tight.withinBudget, false);
  });
});

// ---------- cargo messages ----------

describe("rust store: Cargo's JSON messages", () => {
  it("reads artifacts and build-script out dirs, skipping lines that are not messages", () => {
    const artifact = {
      reason: CargoReason.CompilerArtifact,
      package_id: "a",
      target: { kind: ["lib"], name: "a" },
      filenames: ["/t/debug/deps/liba.rlib"],
      executable: null,
      fresh: true,
    };
    const messages = parseCargoMessages(
      [
        "warning: plain text",
        json(artifact),
        json({ reason: CargoReason.BuildScriptExecuted, package_id: "b", out_dir: "/t/debug/build/b-1/out" }),
        "{broken json",
        json({ reason: "unknown-future-reason" }),
        json({ reason: CargoReason.BuildFinished, success: true }),
      ].join("\n"),
    );
    assert.equal(messages.length, 3);
    assert.deepEqual(cargoOutputs(messages, "/t"), {
      outputs: ["debug/build/b-1/out", "debug/deps/liba.rlib"],
      units: 2,
    });
    const outside = json({ reason: CargoReason.BuildScriptExecuted, package_id: "c", out_dir: "/elsewhere/out" });
    assert.throws(
      () => cargoOutputs(parseCargoMessages(outside), "/t"),
      (error: unknown) => error instanceof ToolchainError && /outside/.test(error.message),
    );
  });

  it("points cargo at the store's sysroot and CARGO_HOME only, offline", async () => {
    const { root, store, lock } = await withBase();
    await prewarmRust(store, lock, BuildTarget.Mac, WARM, prewarmDeps(root, cargoRun([])));
    const located = await locateRust(store, lock, BuildTarget.Mac);
    assert.ok(located.ok);
    const env = rustEnv(located.located);
    assert.equal(env.CARGO_HOME, rustCargoHome(store, lock));
    assert.equal(env.RUSTC, path.join(rustSysroot(store, lock), "bin", "rustc"));
    assert.equal(env.CARGO_NET_OFFLINE, "true");
    assert.equal(env.PATH?.split(path.delimiter)[0], path.join(rustSysroot(store, lock), "bin"));
    assert.equal(env.RUSTUP_TOOLCHAIN, "");
  });
});

describe("Rust store records", () => {
  it("a base or prewarm record whose fields are outside their shape reads as absent, never as a record", async () => {
    const { root, store, lock } = await withBase();
    await prewarmRust(store, lock, BuildTarget.Mac, WARM, prewarmDeps(root, cargoRun([])));
    const baseFile = path.join(store, LOCKS_FOLDER, lockFolderName(lock), RUST_BASE_FILE);
    const prewarmFile = path.join(rustTargetFolder(store, lock, BuildTarget.Mac), RUST_PREWARM_FILE);
    const base = JSON.parse(await readFile(baseFile, "utf8")) as Record<string, unknown>;
    const prewarm = JSON.parse(await readFile(prewarmFile, "utf8")) as Record<string, unknown>;
    assert.ok(await readRustBase(store, lock), "the record as written reads");
    assert.ok(await readRustPrewarm(store, lock, BuildTarget.Mac), "the record as written reads");
    const badBases: Record<string, unknown>[] = [
      { triples: [42] },
      { triples: ["not-a-triple"] },
      { vendor: null },
      { vendor: { sha256: "x", files: "1", bytes: 0 } },
      { at: 7 },
    ];
    for (const bad of badBases) {
      await writeFile(baseFile, JSON.stringify({ ...base, ...bad }));
      assert.equal(await readRustBase(store, lock), null, JSON.stringify(bad));
    }
    const badPrewarms: Record<string, unknown>[] = [
      { outputs: [1] },
      { outputs: "a" },
      { triple: "x86_64-unknown-linux-gnu" },
      { steps: [{ label: "a", ms: "1" }] },
      { rustflags: [1] },
      { profile: [1] },
      { profile: undefined },
      { units: -1 },
      { bytes: "big" },
    ];
    for (const bad of badPrewarms) {
      await writeFile(prewarmFile, JSON.stringify({ ...prewarm, ...bad }));
      assert.equal(await readRustPrewarm(store, lock, BuildTarget.Mac), null, JSON.stringify(bad));
    }
  });
});

// ---------- real toolchain: a cold store, two offline builds ----------

const SPIKE = process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev", "spike-toolchain");
const REQUIRED = process.env.GENEX_REQUIRE_TOOLCHAINS === "1";

/** The pinned Rust components this host installs: the sysroot, the browser's std, wasm-bindgen and binaryen. */
function realEntries(): ToolchainEntry[] {
  const own = (entry: ToolchainEntry) => entry.host === ToolchainHost.MacArm64 || entry.host === null;
  const ids: ReadonlySet<string> = new Set([
    ToolchainId.Rust,
    ToolchainId.RustStdWasm,
    ToolchainId.WasmBindgen,
    ToolchainId.Binaryen,
  ]);
  return RUST_MANIFEST.filter((entry) => ids.has(entry.id) && own(entry));
}

/** `{}` when the pinned Rust downloads and the vendored tree are here; else a skip, or a throw when required. */
function needsRustToolchain(): { skip?: string } {
  const wanted = realEntries()
    .flatMap((entry) => entry.archives)
    .map((archive) => path.join(SPIKE, "downloads", path.basename(archive.url)));
  wanted.push(path.join(SPIKE, "vendor"));
  const appleSilicon = process.platform === "darwin" && process.arch === "arm64";
  const absent = appleSilicon ? wanted.find((file) => !existsSync(file)) : "an Apple silicon Mac";
  if (!absent) return {};
  if (REQUIRED) throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${absent} absent; run setup-toolchain.sh or unset it`);
  return { skip: `not run: ${absent} absent` };
}

/** The warm project: a slice of the vendored closure with build scripts and proc macros, for the Mac and the web. */
const REAL_WARM_MANIFEST = `[package]
name = "genex-warm"
version = "0.0.0"
edition = "2024"
publish = false

[dependencies]
glam = { version = "0.33", features = ["bytemuck", "serde"] }
bytemuck = { version = "1", features = ["derive"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
log = "0.4"

[target.'cfg(not(target_arch = "wasm32"))'.dependencies]
wgpu = { version = "=30.0.1", default-features = false, features = ["std", "parking_lot", "metal", "wgsl"] }

[target.'cfg(target_arch = "wasm32")'.dependencies]
wgpu = { version = "=30.0.1", default-features = false, features = ["std", "parking_lot", "webgpu", "wgsl", "fragile-send-sync-non-atomic-wasm"] }
`;

const REAL_GAME = (tag: string) => `#[derive(serde::Serialize, bytemuck::Pod, bytemuck::Zeroable, Clone, Copy)]
#[repr(C)]
struct Vertex {
    p: [f32; 3],
}
fn main() {
    let v = Vertex { p: glam::Vec3::new(1.0, 2.0, 3.0).to_array() };
    let limits = wgpu::Limits::defaults();
    println!("${tag} {} {}", serde_json::to_string(&v).unwrap(), limits.max_bind_groups);
}
`;

/** The package ids of `messages`' artifacts cargo compiled rather than found fresh. */
function rebuiltPackages(messages: readonly CargoMessage[]): string[] {
  return messages.flatMap((message) =>
    message.reason === CargoReason.CompilerArtifact && !message.fresh ? [message.packageId] : [],
  );
}

/** The executable `messages` name. */
function executableOf(messages: readonly CargoMessage[]): string {
  for (const message of messages)
    if (message.reason === CargoReason.CompilerArtifact && message.executable) return message.executable;
  return "";
}

describe("rust store: a cold store from the pinned downloads, then two offline builds (real toolchain)", () => {
  const gate = needsRustToolchain();
  const state = { root: "", store: "", lock: lockOf({}), sandbox: null as ProcessSandbox | null };
  before(async () => {
    if (gate.skip) return;
    state.root = await realpath(await tmpDir("rust-real-"));
    state.store = path.join(state.root, "toolchains");
    state.sandbox = await ProcessSandbox.create(prewarmSandboxOptions(path.join(state.root, "prewarm-scratch"), []));
  });
  after(async () => {
    await state.sandbox?.dispose();
    if (state.root) await rm(state.root, { recursive: true, force: true });
  });
  const run = (request: RunRequest) => {
    if (!state.sandbox) throw new Error("no sandbox");
    return state.sandbox.run(request);
  };
  const games = () => [path.join(state.root, "games")];

  it("installs the sysroot and the vendored crates from the pinned archives, probing under the sandbox", {
    ...gate,
    timeout: 20 * MINUTE_MS,
  }, async () => {
    const entries = realEntries();
    const served: Record<string, string> = {};
    for (const archive of entries.flatMap((entry) => entry.archives))
      served[archive.url] = path.join(SPIKE, "downloads", path.basename(archive.url));
    const job = await installComponents(state.store, entries, installDeps(fileFetch(served), run));
    assert.equal(job.phase, ToolchainInstallPhase.Installed, JSON.stringify(job));
    const archive = path.join(state.root, "rust-vendor.tar.gz");
    const { bytes, sha256 } = await vendorTarGz(SPIKE, archive);
    const vendor: ToolchainEntry = {
      id: ToolchainId.RustVendor,
      version: "0.0.0-dev",
      host: null,
      target: null,
      licence: "per crate",
      archives: [{ url: VENDOR_URL, bytes, sha256, format: ArchiveFormat.TarGz, strip: 0, into: "" }],
    };
    const pin = await treeDigest(path.join(SPIKE, "vendor"));
    const vendorJob = await installRustVendor(
      state.store,
      vendor,
      pin,
      installDeps(fileFetch({ [VENDOR_URL]: archive }), run),
    );
    await rm(archive, { force: true });
    assert.equal(vendorJob.phase, ToolchainInstallPhase.Installed, JSON.stringify(vendorJob));
    const pins = [...entries, vendor].map((entry) => [entry.id, { version: entry.version, sha12: entrySha12(entry) }]);
    state.lock = lockOf(Object.fromEntries(pins));
    const base = await installRustBase(state.store, state.lock, { run, denyWrite: games() });
    assert.deepEqual(base.triples, [HOST_TRIPLE, RUST_TRIPLE[BuildTarget.Web]]);
  });

  it("prewarms the Mac and the web eagerly (each step under 10 minutes) with the naga validator, sizes within budget", {
    ...gate,
    timeout: 40 * MINUTE_MS,
  }, async () => {
    const project: RustWarmProject = {
      manifest: REAL_WARM_MANIFEST,
      lock: null,
      sources: { "src/main.rs": "fn main() {}\n" },
    };
    const mac = await prewarmRust(state.store, state.lock, BuildTarget.Mac, project, {
      run,
      denyWrite: games(),
      tools: true,
    });
    const web = await prewarmRust(state.store, state.lock, BuildTarget.Web, project, { run, denyWrite: games() });
    for (const record of [mac, web]) {
      assert.ok(record.units > 20, `${record.target}: ${record.units} dependency units`);
      for (const step of record.steps)
        assert.ok(step.ms <= RUST_PREWARM_STEP_TIMEOUT_MS, `${step.label}: ${step.ms} ms`);
    }
    const sizes = await recordRustSizes(state.store, state.lock, [BuildTarget.Mac, BuildTarget.Web]);
    assert.equal(sizes.withinBudget, true, JSON.stringify(sizes));
    console.log(`rust-store receipt: ${JSON.stringify({ sizes, steps: [...mac.steps, ...web.steps] })}`);
  });

  it("two offline builds from two clones of the prewarmed Mac target folder compile only the game crate", {
    ...gate,
    timeout: 20 * MINUTE_MS,
  }, async () => {
    const located = await locateRust(state.store, state.lock, BuildTarget.Mac);
    assert.ok(located.ok, JSON.stringify(located));
    const warmLock = (await readWarmLock(state.store, state.lock, BuildTarget.Mac)) ?? "";
    for (const tag of ["first", "second"]) {
      const build = path.join(state.root, "rust-builds", tag);
      const game = path.join(build, "game");
      await writeTree(game, {
        "Cargo.toml": REAL_WARM_MANIFEST,
        "Cargo.lock": warmLock,
        "src/main.rs": REAL_GAME(tag),
      });
      const targetDir = path.join(build, "target");
      await cloneRustTarget(state.store, state.lock, BuildTarget.Mac, targetDir);
      const home = path.join(build, "cargo-home");
      await mkdir(home, { recursive: true });
      await writeFile(
        path.join(home, "config.toml"),
        await readFile(path.join(rustCargoHome(state.store, state.lock), "config.toml")),
      );
      const tmp = path.join(build, "tmp");
      await mkdir(tmp, { recursive: true });
      const env = { ...rustEnv(located.located), CARGO_HOME: home, CARGO_TARGET_DIR: targetDir, TMPDIR: tmp };
      const manifest = path.join(game, "Cargo.toml");
      // The lane's dev profile, as every Live build passes it (K6).
      const profile = RUST_DEV_PROFILE_SETTINGS.map((setting) => `--config '${setting}'`).join(" ");
      const result = await run({
        command: `'${located.located.cargo}' build --offline --locked --manifest-path '${manifest}' --target ${HOST_TRIPLE} --message-format=json-render-diagnostics ${profile}`,
        cwd: build,
        env,
        timeoutMs: RUST_PREWARM_STEP_TIMEOUT_MS,
        policy: { allowedDomains: [], allowWrite: [build] },
      });
      assert.equal(result.code, 0, result.stderr.slice(-4000));
      const messages = parseCargoMessages(result.stdout);
      const rebuilt = rebuiltPackages(messages).filter((id) => !id.includes("genex-warm"));
      assert.deepEqual(rebuilt, [], "every dependency comes fresh from the clone");
      const out = await execFileAsync(executableOf(messages));
      assert.match(out.stdout, new RegExp(`^${tag} \\{"p":\\[1\\.0,2\\.0,3\\.0\\]\\} \\d+`));
    }
  });

  it("the naga validator accepts WebGPU-core WGSL and refuses a broken one with its line", {
    ...gate,
    timeout: 5 * MINUTE_MS,
  }, async () => {
    const located = await locateRust(state.store, state.lock, BuildTarget.Mac);
    assert.ok(located.ok && located.located.nagaCheck, JSON.stringify(located));
    const shaders = path.join(state.root, "shaders");
    await writeTree(shaders, {
      "good.wgsl": "@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\n",
      "bad.wgsl": "@fragment fn main() -> @location(0) vec4<f32> {\n  return vec4<f32>(1.0) +;\n}\n",
    });
    assert.deepEqual(await validateWgsl(located.located, path.join(shaders, "good.wgsl"), [], run), { ok: true });
    const bad = await validateWgsl(located.located, path.join(shaders, "bad.wgsl"), [], run);
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.line, 2, JSON.stringify(bad));
  });
});
