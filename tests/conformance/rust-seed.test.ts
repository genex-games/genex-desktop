/**
 * A developer profile's Rust · wgpu stack from local artifacts (no published genex release): the
 * substrate's seed (`rust-seed.ts`) copies the components a dev Rust lock names from a local Rust
 * store, verified, and the toolchain service (`seedRust`) then assembles the base, prewarms and
 * writes the current Rust lock in the profile's own store. Never in a release build. The hostile
 * rows hold that a refused seed adds nothing to the target store and writes nothing to the source.
 * Stub sandbox runs stand in for rustc and cargo; nothing is compiled or downloaded.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { readCutVendor, ReleaseRefusal, ReleaseRefused } from "../../scripts/toolchains/rust-release.ts";
import { devRustSeedFrom, GAME_PREWARM_RUSTFLAGS, RustDevSeedEnv } from "../../src/main/core/rust-dev-seed.ts";
import { type HostExec, ToolchainService, type ToolchainServiceOptions } from "../../src/main/core/toolchains.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import {
  LOCK_FILE_OF_STACK,
  type ToolchainEntry,
  ToolchainHost,
  ToolchainId,
  ToolchainInstallPhase,
  type ToolchainLock,
  ToolchainProblem,
} from "../../src/shared/toolchain.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import { treeDigest } from "../../src/substrate/toolchain-store/archive.ts";
import type { InstallDeps } from "../../src/substrate/toolchain-store/install.ts";
import { componentFolder } from "../../src/substrate/toolchain-store/locate.ts";
import { lockOf, readCurrentLock } from "../../src/substrate/toolchain-store/lock.ts";
import { entrySha12, manifestEntry } from "../../src/substrate/toolchain-store/manifest.ts";
import { SeedError, SeedRefusal } from "../../src/substrate/toolchain-store/prewarm-seed.ts";
import { installRustVendor, RustBaseStep, VENDOR_TREE_FILE } from "../../src/substrate/toolchain-store/rust-install.ts";
import { locateRust, readRustBase } from "../../src/substrate/toolchain-store/rust-locate.ts";
import {
  RUST_EAGER_STORE_BUDGET_BYTES,
  type RustWarmProject,
} from "../../src/substrate/toolchain-store/rust-prewarm.ts";
import { RustSeedPhase, readSeedLock, seedRustComponents } from "../../src/substrate/toolchain-store/rust-seed.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const POSIX_ONLY = process.platform === "win32" ? { skip: "the seed's link rows are POSIX-only" } : {};
/** The recipe pins are this host's; every row stands this host in, whatever the computer is. */
const HOST = ToolchainHost.MacArm64;
const RUST_TRIPLE_MAC = "aarch64-apple-darwin";
const WASM = "wasm32-unknown-unknown";
const DEV_VENDOR = { version: "0.1.0-dev", sha12: "0123456789ab" } as const;
const NOW = Date.parse("2026-10-08T00:00:00Z");
/** The flags every game build carries, which the profile's prewarm is built with. */
const GAME_FLAGS = ["-F", "unsafe_code"];
/** Free bytes the rig's disk reports by default: room for the whole eager store. */
const ROOMY_DISK_BYTES = 64 * 1000 ** 3;

// ---------- a local Rust store at the shipped recipe's pins ----------

/** The recipe entry for `id` on the host, which every row's lock pins. */
function pinned(id: ToolchainId): ToolchainEntry {
  const entry = manifestEntry(id, HOST);
  if (!entry) throw new Error(`the Rust recipe pins no ${id} for ${HOST}`);
  return entry;
}

const pinOf = (id: ToolchainId) => ({ version: pinned(id).version, sha12: entrySha12(pinned(id)) });

/** A dev Rust lock: the recipe's Rust, browser std, wasm-bindgen and binaryen, and a dev vendored set. */
function devLock(): ToolchainLock {
  return lockOf({
    [ToolchainId.Rust]: pinOf(ToolchainId.Rust),
    [ToolchainId.RustStdWasm]: pinOf(ToolchainId.RustStdWasm),
    [ToolchainId.WasmBindgen]: pinOf(ToolchainId.WasmBindgen),
    [ToolchainId.Binaryen]: pinOf(ToolchainId.Binaryen),
    [ToolchainId.RustVendor]: DEV_VENDOR,
  });
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, ...rel.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

async function writeReceipt(folder: string, id: ToolchainId, pin: { version: string; sha12: string }) {
  const receipt = {
    id,
    version: pin.version,
    sha256: pin.sha12.padEnd(64, "0"),
    sha12: pin.sha12,
    bytes: 1,
    host: id === ToolchainId.RustVendor || id === ToolchainId.RustStdWasm ? null : HOST,
    target: null,
    source: "archive",
    installedAt: "2026-10-08T00:00:00.000Z",
  };
  await writeFile(path.join(folder, "receipt.json"), `${JSON.stringify(receipt)}\n`);
}

/** A source store holding every component `devLock` names (fake bytes), as `dev-store.ts --stack rust-wgpu` leaves it. */
async function sourceStore(root: string): Promise<{ store: string; lock: ToolchainLock }> {
  const store = path.join(root, "dev-store");
  const lock = devLock();
  const rust = componentFolder(store, ToolchainId.Rust, pinOf(ToolchainId.Rust));
  await writeTree(rust, {
    "rustc/bin/rustc": "#!/bin/sh\n",
    "rustc/manifest.in": "file:bin/rustc\n",
    "cargo/bin/cargo": "#!/bin/sh\n",
    "cargo/manifest.in": "file:bin/cargo\n",
    "clippy/bin/cargo-clippy": "#!/bin/sh\n",
    [`llvm-tools/lib/rustlib/${RUST_TRIPLE_MAC}/bin/llvm-objcopy`]: "objcopy",
    [`rust-std/lib/rustlib/${RUST_TRIPLE_MAC}/lib/libstd.rlib`]: "std",
    "rust-std/manifest.in": "dir:lib/rustlib\n",
  });
  for (const tool of ["rustc/bin/rustc", "cargo/bin/cargo", "clippy/bin/cargo-clippy"])
    await chmod(path.join(rust, ...tool.split("/")), 0o755);
  await writeReceipt(rust, ToolchainId.Rust, pinOf(ToolchainId.Rust));
  const wasm = componentFolder(store, ToolchainId.RustStdWasm, pinOf(ToolchainId.RustStdWasm));
  await writeTree(wasm, { [`lib/rustlib/${WASM}/lib/libstd.rlib`]: "wasm std" });
  await writeReceipt(wasm, ToolchainId.RustStdWasm, pinOf(ToolchainId.RustStdWasm));
  for (const id of [ToolchainId.WasmBindgen, ToolchainId.Binaryen]) {
    const folder = componentFolder(store, id, pinOf(id));
    await writeTree(folder, { "bin/wasm-bindgen": "tool", "bin/wasm-opt": "tool" });
    await writeReceipt(folder, id, pinOf(id));
  }
  const vendor = componentFolder(store, ToolchainId.RustVendor, DEV_VENDOR);
  await writeTree(vendor, {
    "vendor/genex-0.1.0/src/lib.rs": "// genex from this checkout\n",
    "vendor/genex-0.1.0/Cargo.toml": '[package]\nname = "genex"\nversion = "0.1.0"\n',
    "vendor/glam-0.33.0/src/lib.rs": "// glam\n",
  });
  await writeReceipt(vendor, ToolchainId.RustVendor, DEV_VENDOR);
  const tree = await treeDigest(path.join(vendor, "vendor"));
  await writeFile(path.join(vendor, VENDOR_TREE_FILE), `${JSON.stringify(tree)}\n`);
  return { store, lock };
}

/** Every path under `root` with its bytes' sha256 (links as their target text), or `absent`. */
async function snapshot(root: string): Promise<string> {
  const top = await lstat(root).catch(() => null);
  if (!top) return "absent";
  if (top.isSymbolicLink()) return "link";
  const lines: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    const file = path.join(entry.parentPath, entry.name);
    const rel = path.relative(root, file);
    if (entry.isFile())
      lines.push(
        `${rel} ${createHash("sha256")
          .update(await readFile(file))
          .digest("hex")}`,
      );
    else lines.push(`${rel} ${entry.isDirectory() ? "dir" : "other"}`);
  }
  return lines.sort().join("\n");
}

async function rejectsSeed(promise: Promise<unknown>, refusal: SeedRefusal): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SeedError, String(error));
    assert.equal(error.refusal, refusal, error.message);
    return true;
  });
}

// ---------- stub sandbox runs: rustc and cargo answer as the pinned ones would ----------

function ok(stdout: string): RunResult {
  return {
    code: 0,
    signal: null,
    stdout,
    stderr: "",
    durationMs: 1,
    timedOut: false,
    truncated: false,
    sandboxed: true,
    command: "",
    cwd: "",
  };
}

const plain = (command: string) => command.replaceAll("'", "");
const json = (value: unknown) => `${JSON.stringify(value)}\n`;

/** The base probes and the prewarm's cargo steps; each cargo step writes one dependency rlib and names it. */
async function stubRun(request: RunRequest): Promise<RunResult> {
  const command = plain(request.command);
  if (request.label === RustBaseStep.Probe) {
    const sysroot = path.join(request.cwd, "sysroot");
    if (command.includes("--print sysroot")) return ok(`${sysroot}\n`);
    if (command.includes("--print target-libdir")) return ok(`${path.join(sysroot, "lib", "rustlib", WASM, "lib")}\n`);
    if (command.includes("bin/cargo --version")) return ok(`cargo ${pinOf(ToolchainId.Rust).version} (fake)\n`);
    return ok(`rustc ${pinOf(ToolchainId.Rust).version} (fake)\n`);
  }
  const triple = /--target (\S+)/.exec(command)?.[1] ?? "host";
  const rlib = path.join(request.env?.CARGO_TARGET_DIR ?? "", triple, "debug", "deps", "libglam-1.rlib");
  await mkdir(path.dirname(rlib), { recursive: true });
  await writeFile(rlib, "rlib");
  const artifact = {
    reason: "compiler-artifact",
    package_id: "registry+https://github.com/rust-lang/crates.io-index#glam@0.33.0",
    target: { kind: ["lib"], name: "glam" },
    filenames: [rlib],
    executable: null,
    fresh: false,
  };
  return ok(json(artifact) + json({ reason: "build-finished", success: true }));
}

const WARM: RustWarmProject = {
  manifest: '[package]\nname = "genex-warm"\nversion = "0.0.0"\nedition = "2024"\n',
  lock: "# lock\n",
  sources: { "src/main.rs": "fn main() {}\n" },
};

interface Rig {
  root: string;
  source: string;
  lock: ToolchainLock;
  lockFile: string;
  profileStore: string;
  normalStore: string;
  sandboxes: number;
  runs: RunRequest[];
  service: ToolchainService;
}

/**
 * A developer profile's service over an empty store, seeded from a local Rust store; `overrides`
 * change any option, and `intoNormal` points the service at the store the seed is told is the normal one.
 */
async function rig(overrides: Partial<ToolchainServiceOptions> = {}, intoNormal = false): Promise<Rig> {
  const root = await realpath(await tmpDir("rust-seed-"));
  const { store: source, lock } = await sourceStore(root);
  const lockFile = path.join(root, "worktree", ".studio-dev", "dev-store-rust-lock.json");
  await mkdir(path.dirname(lockFile), { recursive: true });
  await writeFile(lockFile, `${JSON.stringify(lock)}\n`);
  const normalStore = path.join(root, "normal", "toolchains");
  const profileStore = intoNormal ? normalStore : path.join(root, "profile", "toolchains");
  const exec: HostExec = async () => ({ code: 0, stdout: "", stderr: "" });
  const state: Rig = {
    root,
    source,
    lock,
    lockFile,
    profileStore,
    normalStore,
    sandboxes: 0,
    runs: [],
    service: null as unknown as ToolchainService,
  };
  state.service = new ToolchainService({
    store: profileStore,
    host: HOST,
    emit: () => {},
    run: async () => {
      throw new Error("the seed runs only in its own sandbox");
    },
    exec,
    probeClt: async () => ({ present: false, version: null }),
    prewarmSandbox: async () => {
      state.sandboxes += 1;
      return {
        run: async (request) => {
          state.runs.push(request);
          return stubRun(request);
        },
        dispose: async () => {},
      };
    },
    prewarmDenyWrite: [path.join(root, "games")],
    releaseBuild: false,
    now: () => NOW,
    freeBytes: async () => ROOMY_DISK_BYTES,
    rustSeed: {
      from: source,
      lockFile,
      forbidden: [normalStore],
      warmProject: async () => WARM,
      rustflags: GAME_FLAGS,
    },
    ...overrides,
  });
  return state;
}

// ---------- the service: a dev profile builds Rust from local artifacts ----------

describe("a developer profile's Rust stack seeded from a local Rust store", POSIX_ONLY, () => {
  it("installs the vendored set (genex from this checkout) and every pinned part, assembles the base, prewarms the web and makes the lock current", async () => {
    const r = await rig();
    const sourceBefore = await snapshot(r.source);
    const outcome = await r.service.seedRust();
    assert.equal(outcome?.phase, RustSeedPhase.Seeded, JSON.stringify(outcome));
    assert.equal((await readCurrentLock(r.profileStore, GameStack.RustWgpu))?.digest, r.lock.digest);
    const vendor = componentFolder(r.profileStore, ToolchainId.RustVendor, DEV_VENDOR);
    assert.equal(
      await readFile(path.join(vendor, "vendor", "genex-0.1.0", "src", "lib.rs"), "utf8"),
      "// genex from this checkout\n",
    );
    assert.deepEqual((await readRustBase(r.profileStore, r.lock))?.triples, [RUST_TRIPLE_MAC, WASM]);
    const web = await locateRust(r.profileStore, r.lock, BuildTarget.Web, { rustflags: GAME_FLAGS });
    assert.ok(web.ok, JSON.stringify(web));
    assert.ok(web.located.vendor.startsWith(await realpath(r.profileStore)), "the profile builds from its own copy");
    const mac = await locateRust(r.profileStore, r.lock, BuildTarget.Mac, { prewarm: false });
    assert.ok(mac.ok, "the Mac builds from the base (no Command Line Tools here, so no Mac prewarm)");
    assert.equal(await snapshot(r.source), sourceBefore, "the source store is only read");
    assert.equal(await snapshot(r.normalStore), "absent");
  });

  it("is idempotent: a profile already on the lock seeds nothing and opens no sandbox", async () => {
    const r = await rig();
    await r.service.seedRust();
    const before = { sandboxes: r.sandboxes, store: await snapshot(r.profileStore) };
    const again = await r.service.seedRust();
    assert.equal(again?.phase, RustSeedPhase.Current);
    assert.equal(r.sandboxes, before.sandboxes);
    assert.equal(await snapshot(r.profileStore), before.store);
  });

  it("the Rust lock a build asks for waits for a seed in flight", async () => {
    const r = await rig();
    const seeding = r.service.seedRust();
    const lock = await r.service.currentLock(GameStack.RustWgpu);
    assert.equal(lock?.digest, r.lock.digest);
    await seeding;
  });

  it("a disk without room for the eager store fails typed disk-space before anything is added; with room the next seed seeds", async () => {
    let free = RUST_EAGER_STORE_BUDGET_BYTES - 1;
    const asked: string[] = [];
    const r = await rig({
      freeBytes: async (dir) => {
        asked.push(dir);
        return free;
      },
    });
    const sourceBefore = await snapshot(r.source);
    const full = await r.service.seedRust();
    assert.equal(full?.phase, RustSeedPhase.Failed, JSON.stringify(full));
    assert.equal(full?.phase === RustSeedPhase.Failed ? full.problem : null, ToolchainProblem.DiskSpace);
    assert.equal(await snapshot(r.profileStore), "absent", "nothing was added to the profile's store");
    assert.equal(r.sandboxes, 0, "no probe or prewarm ran");
    assert.equal(await snapshot(r.source), sourceBefore);
    assert.ok(asked.length > 0 && asked.every((dir) => existsSync(dir)), "free space is read on a folder that exists");
    free = ROOMY_DISK_BYTES;
    assert.equal((await r.service.seedRust())?.phase, RustSeedPhase.Seeded);
  });

  it("without a seed source the service seeds nothing", async () => {
    const r = await rig({ rustSeed: undefined });
    assert.equal(await r.service.seedRust(), null);
    assert.equal(await snapshot(r.profileStore), "absent");
  });
});

// ---------- hostile inputs: refused, nothing added to the target, nothing written to the source ----------

/** Runs a refused service seed and holds that neither store changed and no sandbox opened. */
async function refusedService(r: Rig, refusal: SeedRefusal): Promise<void> {
  const before = { source: await snapshot(r.source), target: await snapshot(r.profileStore) };
  const outcome = await r.service.seedRust();
  assert.equal(outcome?.phase, RustSeedPhase.Refused, JSON.stringify(outcome));
  assert.equal(outcome?.phase === RustSeedPhase.Refused ? outcome.refusal : null, refusal);
  assert.equal(await snapshot(r.source), before.source, "the source is untouched");
  assert.equal(await snapshot(r.profileStore), before.target, "nothing was added to the profile's store");
  assert.equal(r.sandboxes, 0, "no probe or prewarm ran");
  assert.equal(existsSync(path.join(r.profileStore, LOCK_FILE_OF_STACK[GameStack.RustWgpu])), false);
}

describe("the service refuses hostile seeds with no side effect", POSIX_ONLY, () => {
  it("a release (packaged) build never seeds, even when a source is named", async () => {
    const r = await rig({ releaseBuild: true });
    await refusedService(r, SeedRefusal.ReleaseBuild);
  });

  it("a lock file that is a link is refused (never read through)", async () => {
    const r = await rig();
    const real = `${r.lockFile}.real`;
    await writeFile(real, await readFile(r.lockFile));
    await rm(r.lockFile);
    await symlink(real, r.lockFile);
    await refusedService(r, SeedRefusal.NoSource);
  });

  it("a target store that is the normal profile's is refused", async () => {
    const r = await rig({}, true);
    await refusedService(r, SeedRefusal.SameStore);
  });
});

/** A seed of `lock` into `to` from `from` that must be refused with `refusal`, changing neither store. */
async function refusedSeed(
  options: { from: string; to: string; lock: ToolchainLock; forbidden?: string[] },
  refusal: SeedRefusal,
  watch: readonly string[] = [],
): Promise<void> {
  const watched = [options.from, options.to, ...watch];
  const before = await Promise.all(watched.map(snapshot));
  await rejectsSeed(seedRustComponents({ ...options, host: HOST }), refusal);
  assert.deepEqual(await Promise.all(watched.map(snapshot)), before, "no store changed");
}

describe("seedRustComponents: hostile-input table", POSIX_ONLY, () => {
  it("refuses overlapping stores: the same store, a target inside the source and a source inside the target", async () => {
    const root = await realpath(await tmpDir("rust-seed-hostile-"));
    const { store, lock } = await sourceStore(root);
    await refusedSeed({ from: store, to: store, lock }, SeedRefusal.SameStore);
    await refusedSeed({ from: store, to: path.join(store, "nested"), lock }, SeedRefusal.SameStore);
    await refusedSeed({ from: store, to: root, lock }, SeedRefusal.SameStore);
  });

  it("refuses a target that is a link, a target whose .staging or component folder links outside it", async () => {
    const root = await realpath(await tmpDir("rust-seed-hostile-"));
    const { store, lock } = await sourceStore(root);
    const outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "keep.txt"), "mine\n");
    const linkedStore = path.join(root, "linked-store");
    await symlink(outside, linkedStore);
    await refusedSeed({ from: store, to: linkedStore, lock }, SeedRefusal.LinkedStore, [outside]);
    const staged = path.join(root, "staged-store");
    await mkdir(staged);
    await symlink(outside, path.join(staged, ".staging"));
    await refusedSeed({ from: store, to: staged, lock }, SeedRefusal.LinkedStore, [outside]);
    const component = path.join(root, "component-store");
    await mkdir(component);
    await symlink(outside, path.join(component, ToolchainId.RustVendor));
    await refusedSeed({ from: store, to: component, lock }, SeedRefusal.LinkedStore, [outside]);
  });

  it("refuses a target that is a forbidden (normal) store, however it is spelled", async () => {
    const root = await realpath(await tmpDir("rust-seed-hostile-"));
    const { store, lock } = await sourceStore(root);
    const normal = path.join(root, "normal");
    await mkdir(normal);
    await refusedSeed({ from: store, to: normal, lock, forbidden: [normal] }, SeedRefusal.SameStore);
    const spelled = path.join(root, "alias");
    await symlink(normal, spelled);
    await refusedSeed(
      { from: store, to: path.join(normal, "inner"), lock, forbidden: [spelled] },
      SeedRefusal.SameStore,
    );
  });

  it("refuses a lock that is not a Rust lock, or names a part off the recipe's pins", async () => {
    const root = await realpath(await tmpDir("rust-seed-hostile-"));
    const { store, lock } = await sourceStore(root);
    const to = path.join(root, "profile");
    const raylib = lockOf({ [ToolchainId.Cmake]: { version: "4.4.3", sha12: "a".repeat(12) } });
    await refusedSeed({ from: store, to, lock: raylib }, SeedRefusal.BadLock);
    const offPin = lockOf({ ...lock.entries, [ToolchainId.Rust]: { version: "1.99.0", sha12: "f".repeat(12) } });
    await refusedSeed({ from: store, to, lock: offPin }, SeedRefusal.Unpinned);
  });

  it("refuses a source missing a component, and a source store that does not exist", async () => {
    const root = await realpath(await tmpDir("rust-seed-hostile-"));
    const { store, lock } = await sourceStore(root);
    const to = path.join(root, "profile");
    const other = lockOf({
      ...lock.entries,
      [ToolchainId.RustVendor]: { version: "0.1.0-dev", sha12: "f".repeat(12) },
    });
    await refusedSeed({ from: store, to, lock: other }, SeedRefusal.Missing);
    await refusedSeed({ from: path.join(root, "nowhere"), to, lock }, SeedRefusal.NoSource);
  });

  it("refuses a source component that is a link, or holds a link escaping it", async () => {
    const root = await realpath(await tmpDir("rust-seed-hostile-"));
    const { store, lock } = await sourceStore(root);
    const to = path.join(root, "profile");
    const outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret"), "not a toolchain file\n");
    const bindgen = componentFolder(store, ToolchainId.WasmBindgen, pinOf(ToolchainId.WasmBindgen));
    await symlink(path.join(outside, "secret"), path.join(bindgen, "bin", "escape"));
    await refusedSeed({ from: store, to, lock }, SeedRefusal.NotRegular, [outside]);

    const second = await realpath(await tmpDir("rust-seed-hostile-"));
    const fresh = await sourceStore(second);
    const binaryen = componentFolder(fresh.store, ToolchainId.Binaryen, pinOf(ToolchainId.Binaryen));
    const moved = path.join(second, "binaryen-elsewhere");
    await rename(binaryen, moved);
    await symlink(moved, binaryen);
    await refusedSeed(
      { from: fresh.store, to: path.join(second, "profile"), lock: fresh.lock },
      SeedRefusal.NotRegular,
    );
  });

  it("refuses a vendored set whose tree is not the digest its install recorded", async () => {
    const root = await realpath(await tmpDir("rust-seed-hostile-"));
    const { store, lock } = await sourceStore(root);
    const vendor = componentFolder(store, ToolchainId.RustVendor, DEV_VENDOR);
    await writeFile(path.join(vendor, "vendor", "glam-0.33.0", "src", "lib.rs"), "// tampered after install\n");
    await refusedSeed({ from: store, to: path.join(root, "profile"), lock }, SeedRefusal.TreeDigest);
  });
});

describe("readSeedLock: the lock file is a plain Rust lock", POSIX_ONLY, () => {
  it("reads a dev Rust lock and refuses a link, a missing file, bad JSON, a tampered digest, a path-escaping pin and a raylib lock", async () => {
    const root = await realpath(await tmpDir("rust-seed-lock-"));
    const lock = devLock();
    const file = path.join(root, "lock.json");
    await writeFile(file, JSON.stringify(lock));
    assert.equal((await readSeedLock(file)).digest, lock.digest);
    const link = path.join(root, "link.json");
    await symlink(file, link);
    await rejectsSeed(readSeedLock(link), SeedRefusal.NoSource);
    await rejectsSeed(readSeedLock(path.join(root, "absent.json")), SeedRefusal.NoSource);
    const cases: Array<[string, unknown]> = [
      ["not-json", "{"],
      ["tampered", { ...lock, digest: "0".repeat(64) }],
      [
        "escape",
        lockOf({ ...lock.entries, [ToolchainId.RustVendor]: { version: "../../../etc", sha12: DEV_VENDOR.sha12 } }),
      ],
      ["raylib", lockOf({ [ToolchainId.Cmake]: { version: "4.4.3", sha12: "a".repeat(12) } })],
      ["no-vendor", lockOf({ [ToolchainId.Rust]: pinOf(ToolchainId.Rust) })],
    ];
    for (const [name, value] of cases) {
      const at = path.join(root, `${name}.json`);
      await writeFile(at, typeof value === "string" ? value : JSON.stringify(value));
      await rejectsSeed(readSeedLock(at), SeedRefusal.BadLock);
    }
  });
});

// ---------- a locally cut release tree as the dev store's vendored set ----------

const CUT_URL = "https://github.com/genex-games/genex-desktop/releases/download/genex-0.1.0/rust-vendor.tar.gz";

/** A cut folder as `rust-release.ts cut --out` leaves it: `rust-vendor.tar.gz` and a `release.json` naming its digests. */
async function localCut(root: string, files: Record<string, string>) {
  const source = path.join(root, "cut-source");
  await writeTree(path.join(source, "vendor"), files);
  const tree = await treeDigest(path.join(source, "vendor"));
  const dir = path.join(root, "cut");
  await mkdir(dir, { recursive: true });
  const archive = path.join(dir, "rust-vendor.tar.gz");
  await execFileAsync("tar", ["-czf", archive, "-C", source, "vendor"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const bytes = await readFile(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const archiveEntry = { url: CUT_URL, bytes: bytes.length, sha256, format: "tar.gz", strip: 0, into: "" };
  const record = {
    schema: 1,
    genex: "0.1.0",
    tag: "genex-0.1.0",
    vendor: { file: "rust-vendor.tar.gz", url: CUT_URL, sha256, bytes: bytes.length, files: tree.files, tree },
    inventorySha256: "0".repeat(64),
    workspaceLockSha256: "0".repeat(64),
    recipeEntry: {
      id: ToolchainId.RustVendor,
      version: "0.1.0",
      host: null,
      target: null,
      licence: "MIT",
      archives: [archiveEntry],
      tree,
    },
    locks: {},
  };
  await writeFile(path.join(dir, "release.json"), JSON.stringify(record));
  return { dir, archive, record, tree };
}

async function rejectsRelease(promise: Promise<unknown>, code: ReleaseRefusal): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ReleaseRefused, String(error));
    assert.equal(error.code, code, error.message);
    return true;
  });
}

/** A fetch answering only the cut's URL, from its archive on disk. */
function cutFetch(url: string, file: string): InstallDeps["fetch"] {
  return async (asked: string) => {
    if (asked !== url) return new Response("absent", { status: 404 });
    const bytes = await readFile(file);
    return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
  };
}

const cutInstallDeps = (fetch: InstallDeps["fetch"]): InstallDeps => ({
  fetch,
  run: async () => ok(""),
  freeBytes: async () => 1024 ** 4,
  onJob: () => {},
});

describe("readCutVendor: a locally cut genex release, digest-verified", POSIX_ONLY, () => {
  const GENEX = { "genex-0.1.0/src/lib.rs": "// genex as cut\n", "genex-0.1.0/.cargo-checksum.json": "{}" };

  it("installs the cut's vendored set through the store's own verified install", async () => {
    const root = await realpath(await tmpDir("rust-cut-"));
    const cut = await localCut(root, GENEX);
    const vendor = await readCutVendor(cut.dir);
    assert.deepEqual(vendor.pin, cut.tree);
    const store = path.join(root, "dev-store");
    const job = await installRustVendor(
      store,
      vendor.entry,
      vendor.pin,
      cutInstallDeps(cutFetch(CUT_URL, vendor.archive)),
    );
    assert.equal(job.phase, ToolchainInstallPhase.Installed, JSON.stringify(job));
    const folder = componentFolder(store, ToolchainId.RustVendor, {
      version: "0.1.0",
      sha12: entrySha12(vendor.entry),
    });
    assert.equal(
      await readFile(path.join(folder, "vendor", "genex-0.1.0", "src", "lib.rs"), "utf8"),
      "// genex as cut\n",
    );
  });

  it("an archive whose tree is not the recorded one installs nothing", async () => {
    const root = await realpath(await tmpDir("rust-cut-"));
    const cut = await localCut(root, GENEX);
    const planted = await localCut(path.join(root, "planted"), { "genex-0.1.0/src/lib.rs": "// planted\n" });
    const record = { ...cut.record, vendor: { ...planted.record.vendor, tree: cut.tree } };
    record.recipeEntry = { ...planted.record.recipeEntry, tree: cut.tree };
    await writeFile(path.join(cut.dir, "release.json"), JSON.stringify(record));
    await writeFile(cut.archive, await readFile(planted.archive));
    const vendor = await readCutVendor(cut.dir);
    const store = path.join(root, "dev-store");
    const job = await installRustVendor(
      store,
      vendor.entry,
      vendor.pin,
      cutInstallDeps(cutFetch(CUT_URL, vendor.archive)),
    );
    assert.equal(job.phase, ToolchainInstallPhase.Failed);
    assert.equal(existsSync(path.join(store, ToolchainId.RustVendor)), false, "no vendored folder is left");
  });

  it("refuses a linked record or archive, a path in the record, a tampered archive, a record that disagrees with itself and an off-host URL", async () => {
    const root = await realpath(await tmpDir("rust-cut-"));
    const make = async (name: string) => localCut(path.join(root, name), GENEX);
    const linkedRecord = await make("linked-record");
    const elsewhere = path.join(root, "elsewhere.json");
    await rename(path.join(linkedRecord.dir, "release.json"), elsewhere);
    await symlink(elsewhere, path.join(linkedRecord.dir, "release.json"));
    await rejectsRelease(readCutVendor(linkedRecord.dir), ReleaseRefusal.CutUnreadable);
    const linkedArchive = await make("linked-archive");
    await rename(linkedArchive.archive, path.join(root, "elsewhere.tar.gz"));
    await symlink(path.join(root, "elsewhere.tar.gz"), linkedArchive.archive);
    await rejectsRelease(readCutVendor(linkedArchive.dir), ReleaseRefusal.CutUnreadable);
    const escaping = await make("escaping");
    const escaped = { ...escaping.record, vendor: { ...escaping.record.vendor, file: "../rust-vendor.tar.gz" } };
    await writeFile(path.join(escaping.dir, "release.json"), JSON.stringify(escaped));
    await rejectsRelease(readCutVendor(escaping.dir), ReleaseRefusal.CutUnreadable);
    const tampered = await make("tampered");
    const bytes = await readFile(tampered.archive);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    await writeFile(tampered.archive, bytes);
    await rejectsRelease(readCutVendor(tampered.dir), ReleaseRefusal.CutDigest);
    const disagreeing = await make("disagreeing");
    const other = { ...disagreeing.record.recipeEntry.archives[0], sha256: "f".repeat(64) };
    const split = { ...disagreeing.record, recipeEntry: { ...disagreeing.record.recipeEntry, archives: [other] } };
    await writeFile(path.join(disagreeing.dir, "release.json"), JSON.stringify(split));
    await rejectsRelease(readCutVendor(disagreeing.dir), ReleaseRefusal.CutDigest);
    const offHost = await make("off-host");
    const moved = { ...offHost.record.recipeEntry.archives[0], url: "https://example.com/rust-vendor.tar.gz" };
    const away = { ...offHost.record, recipeEntry: { ...offHost.record.recipeEntry, archives: [moved] } };
    await writeFile(path.join(offHost.dir, "release.json"), JSON.stringify(away));
    await rejectsRelease(readCutVendor(offHost.dir), ReleaseRefusal.OffHostUrl);
  });
});

// ---------- where an owned developer launch seeds from ----------

describe("devRustSeedFrom: an owned developer launch's Rust seed source", () => {
  it("defaults to the checkout's dev store and worktree lock, never writing the normal profile's store", () => {
    const seed = devRustSeedFrom({ env: {}, checkout: "/repo", appData: "/home/Library/Application Support" });
    assert.deepEqual(seed, {
      from: path.join("/repo", ".studio-dev", "toolchains", "dev-store"),
      lockFile: path.join("/repo", ".studio-dev", "dev-store-rust-lock.json"),
      forbidden: [
        path.join("/home/Library/Application Support", "Genex", "toolchains"),
        path.join("/home/Library/Application Support", "AI Game Studio", "toolchains"),
      ],
    });
  });

  it("follows the developer's toolchains folder and lock file, and is off when the launch says so", () => {
    const env = { [RustDevSeedEnv.Toolchains]: "/tools", [RustDevSeedEnv.Lock]: "/locks/rust.json" };
    const seed = devRustSeedFrom({ env, checkout: "/repo", appData: "/app" });
    assert.equal(seed?.from, path.join("/tools", "dev-store"));
    assert.equal(seed?.lockFile, path.resolve("/locks/rust.json"));
    assert.equal(devRustSeedFrom({ env: { [RustDevSeedEnv.Seed]: "0" }, checkout: "/repo", appData: "/app" }), null);
  });

  it("the profile's prewarm carries the flags an untrusted game build does", () => {
    assert.deepEqual(GAME_PREWARM_RUSTFLAGS, ["-F", "unsafe_code"]);
  });
});
