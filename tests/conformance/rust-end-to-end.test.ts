/**
 * The Rust · wgpu slice end to end, host-only (no agent): a game made by the harness's
 * `game.scaffold` from the shipped Rust template, built by the core's own Rust lane behind the
 * build-lane seam, and the build it admitted spoken to over fd 3 by the host's `NativeGamePort`
 * through `capture`, the digest recomputed by the host. Contract v2 holds only when the scaffold,
 * the lane and the port agree: the lane builds a Mac game for the studio (Live, judging) in the
 * dev flavour (the facade's `studio` feature, so `genex::install` serves fd 3), never an export;
 * the port negotiates protocol 2 and reads the capability receipt. The web destination is
 * packaged by the lane (wasm-bindgen, wasm-opt, the app's own WebGPU-only shell titled for the
 * game, `size.json`), and a shell that is not a regular file in the app's resources refuses.
 *
 * Host-only rows run on the `rust-game` fixture's stub store (`src/main/dev/fixture-rust.ts`):
 * its cargo admits `tests/fixtures/rust-fd3-stub-game.mjs` for a dev-flavour native build. The
 * real rows (`GENEX_REQUIRE_TOOLCHAINS=1` makes their absence a failure) build the scaffolded
 * template with the pinned toolchain under the real lane on Apple silicon and capture it on the
 * host GPU (Metal): `.studio-dev/spike-toolchain/` (sysroot) and the genex release's vendored
 * crate set cut by `scripts/toolchains/rust-release.ts` (`GENEX_RUST_VENDOR_DIR` names one).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Duplex } from "node:stream";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createCoreRustBuilds,
  rustPayloadDir,
  shippedRustStage,
  shippedWebShell,
} from "../../src/main/core/rust-lane.ts";
import { rustTargetBuilders } from "../../src/main/core/internals.ts";
import { fixtureRustWebOutput, seedFixtureRustStore } from "../../src/main/dev/fixture-rust.ts";
import type { GameBuildGame } from "../../src/main/game-build.ts";
import {
  type RustBuildSandbox,
  RustBuilds,
  type RustToolchain,
  rustBuildSandboxes,
} from "../../src/main/rust-build.ts";
import { RustBuildRefusal } from "../../src/main/rust-build-diagnostics.ts";
import { admittedBuildLock } from "../../src/main/rust-build.ts";
import { RUST_GAME_PACKAGE } from "../../src/main/rust-manifest.ts";
import { admitRustOutput } from "../../src/substrate/native-cross-admission.ts";
import {
  parseLockClosure,
  readVendoredLicences,
  rustNotices,
  rustRuntimeSources,
} from "../../src/substrate/rust-notices.ts";
import { WEB_FILES } from "../../src/main/rust-build-web.ts";
import { CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { SECOND_MS } from "../../src/shared/duration.ts";
import { WEB_WASM_BUDGET_DEFAULT_BYTES } from "../../src/shared/game-export-contract.ts";
import { BuildTarget, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import {
  NATIVE_CAPTURE_FORMAT,
  NATIVE_PROTOCOL_VERSION,
  NativeBackend,
  NativeGpuTier,
  NativeLifecycle,
  NativeOp,
  NativeRunMode,
  type NativeTimers,
} from "../../src/shared/native-contract.ts";
import type { ToolchainLock } from "../../src/shared/toolchain.ts";
import { fnv1a64Hex, NativeGamePort } from "../../src/substrate/native-game-port.ts";
import { lockOf } from "../../src/substrate/toolchain-store/lock.ts";
import type { GameChild, GameExit, RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SKIP_UNLESS_MAC = process.platform === "darwin" ? false : "a Rust Mac build needs the Mac SDK";
const NONCE = "rust-end-to-end-nonce";
const GAME = { name: "ferris-e2e", title: 'Ferris & "the <Pond>"' } as const;
/** The template shell the app ships under its resources (`scripts/rust-payload.ts`). */
const SHELL = ["game-template-rust", "web", "shell.html"] as const;
const READY_WAIT_MS = 20 * SECOND_MS;

const isTimeout = (handle: unknown): handle is NodeJS.Timeout => typeof handle === "object" && handle !== null;
const REAL_TIMERS: NativeTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => {
    if (isTimeout(handle)) clearTimeout(handle);
  },
};

type Call = (params: unknown) => Promise<Record<string, unknown>>;

/** The harness's substrate table, called the way `ctx.call(method, params)` reaches it. */
function rpc(api: unknown): (method: string, params: unknown) => Promise<Record<string, unknown>> {
  const table = api as Record<string, Call | undefined>;
  return async (method, params) => {
    const handler = table[method];
    assert.ok(handler, `the core serves ${method}`);
    return await handler(params);
  };
}

const children: Array<() => Promise<void>> = [];
after(async () => {
  for (const stop of children) await stop();
});

/** The admitted game started as `spawnGame` starts one: fd 3, its own process group, the studio's variables only. */
async function startGame(
  executable: string,
  extra: Record<string, string> = {},
): Promise<{ port: NativeGamePort; stateDir: string }> {
  const scratch = await realpath(await tmpDir("rust-e2e-run-"));
  const stateDir = path.join(scratch, "state");
  const home = path.join(scratch, "home");
  await Promise.all([stateDir, home].map((dir) => mkdir(dir, { recursive: true })));
  const proc = spawn(executable, [], {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    detached: true,
    cwd: scratch,
    env: { GENEX_STUDIO_FD: "3", GENEX_STUDIO_NONCE: NONCE, GENEX_STATE_DIR: stateDir, HOME: home, ...extra },
  });
  const exited = new Promise<GameExit>((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
  await once(proc, "spawn");
  proc.on("error", () => {});
  const { pid, stdout, stderr } = proc;
  const fd3 = proc.stdio[3];
  if (!(fd3 instanceof Duplex) || pid === undefined || !stdout || !stderr) throw new Error("no protocol pipe");
  const kill = (signal: NodeJS.Signals) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  };
  children.push(async () => {
    kill("SIGKILL");
    await exited;
  });
  const child: GameChild = { pid, fd3, stdout, stderr, exited, kill };
  const port = new NativeGamePort({
    child,
    nonce: NONCE,
    mode: NativeRunMode.Headless,
    stateDir,
    timers: REAL_TIMERS,
    encodeJpeg: async () => Buffer.from("jpeg"),
  });
  return { port, stateDir };
}

/** The game's `ready`, or the reason it never came within {@link READY_WAIT_MS}. */
async function readyOf(port: NativeGamePort) {
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("no ready within the wait")), READY_WAIT_MS).unref();
  });
  return await Promise.race([port.ready(), timeout]);
}

/** Scaffold through `game.scaffold`, seed the stub store, and answer the core, its RPC and the game. */
async function scaffoldedFixture() {
  const lite = await coreLite({ developmentStacks: true });
  const call = rpc(lite.api());
  const project = await call("game.scaffold", {
    name: GAME.name,
    title: GAME.title,
    kind: ProjectKind.RustWgpu,
    targets: [BuildTarget.Web, BuildTarget.Mac],
  });
  assert.equal(project.name, GAME.name);
  const lock = await seedFixtureRustStore(lite.core.layout.toolchains, { webOutput: fixtureRustWebOutput() });
  assert.ok(lock, "the stub Rust store seeded the profile's store");
  const game = (await lite.core.games.list()).find((listed) => listed.name === GAME.name);
  assert.ok(game, "the scaffolded game is in the library");
  return { ...lite, call, lock, dir: game.dir };
}

/** The `genex = …` line of the stage's host-written manifest (the build's own output, as cargo read it). */
async function stagedGenex(output: string): Promise<string | undefined> {
  const stage = output.replace(/\.out$/, ".stage");
  const lines = (await readFile(path.join(stage, "Cargo.toml"), "utf8")).split("\n");
  return lines.find((line) => line.startsWith("genex = "))?.slice("genex = ".length);
}

/**
 * The facade's two spellings: the dev flavour with the studio, an export without it. Flipped
 * (release R-2): the template switches nav, streaming and animation off, so each line names the
 * defaults it keeps. Flipped again (gate GR): audio is off too, so only physics stays. Flipped again
 * (shared physics P4): the deprecated physics-raw follows physics.
 */
const DEV_FACADE = '{ version = "=0.1.0", default-features = false, features = ["studio", "physics", "physics-raw"] }';
const EXPORT_FACADE = '{ version = "=0.1.0", default-features = false, features = ["physics", "physics-raw"] }';
/** A web build's facade: the web shell's crate under the facade's name, never the studio feature (flipped with R-2, GR and P4). */
const WEB_FACADE =
  '{ package = "genex-platform-web", version = "=0.1.0", default-features = false, features = ["physics", "physics-raw"] }';

describe("host-only: game.scaffold → the core's Rust lane → fd 3 → capture", { skip: SKIP_UNLESS_MAC }, () => {
  it("builds the scaffolded game in the dev flavour, which serves protocol 2 and a capture the host verifies", async () => {
    const { call, lock } = await scaffoldedFixture();
    const built = await call("native.build", { project: GAME.name, target: BuildTarget.Mac });
    assert.equal(built.ok, true, JSON.stringify(built.problem));
    assert.equal(built.lock, lock.digest.slice(0, 12));
    const output = String(built.output);
    assert.equal(await stagedGenex(output), DEV_FACADE);
    const { port, stateDir } = await startGame(path.join(output, "game"));
    const ready = await readyOf(port);
    assert.equal(ready.protocol, NATIVE_PROTOCOL_VERSION);
    assert.equal(ready.receipt?.tier, NativeGpuTier.Core);
    assert.equal(ready.receipt?.backend, ready.backend.api);
    const state = (await port.studioState()) as Record<string, unknown>;
    assert.equal(state.lifecycle, NativeLifecycle.Resumed);
    const shot = await port.call(NativeOp.Capture, {});
    assert.equal(shot.format, NATIVE_CAPTURE_FORMAT);
    const bytes = await readFile(path.join(stateDir, "captures", `${shot.seq}.bgra`));
    assert.equal(bytes.length, shot.width * shot.height * 4);
    assert.equal(fnv1a64Hex(bytes), shot.digest, "the host's digest of the file is the game's");
  });

  it("exports the web build packaged by the lane: the app's shell titled for the game, the bound module and size.json", async () => {
    const { core } = await scaffoldedFixture();
    const out = path.join(await tmpDir("rust-e2e-export-"), "out");
    await core.exportPublicCopy(GAME.name, out);
    const page = await readFile(path.join(out, WEB_FILES.page), "utf8");
    assert.ok(page.includes("Ferris &amp; &quot;the &lt;Pond&gt;&quot;"), "the title, HTML-escaped");
    assert.ok(!page.includes("__GAME_TITLE__"));
    for (const file of [WEB_FILES.module, WEB_FILES.wasm]) assert.ok(existsSync(path.join(out, file)), file);
    const size = JSON.parse(await readFile(path.join(out, WEB_FILES.size), "utf8")) as Record<string, unknown>;
    assert.equal(size.optimized, true, "an export runs wasm-opt");
    assert.equal(size.withinBudget, true);
  });
});

// ── The lane alone, over the stub store and a resources folder of the test's own ──────────────

/** `request` run by /bin/sh: the lane's commands without containment. */
async function runShell(request: RunRequest): Promise<RunResult> {
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", request.command], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const facts = { timedOut: false, truncated: false, sandboxed: false, durationMs: Date.now() - started };
      resolve({ code, signal, stdout, stderr, ...facts, command: request.command, cwd: request.cwd });
    });
  });
}

const openSandbox = async (): Promise<RustBuildSandbox> => ({ run: runShell, dispose: async () => {} });

/** The core's lane over `store` and `resources`, the Mac SDK answered without running `xcrun`. */
async function laneOver(store: string, resources: string) {
  return createCoreRustBuilds({
    root: path.join(await realpath(await tmpDir("rust-e2e-builds-")), "rust-builds"),
    store,
    resources,
    sandbox: openSandbox,
    emit: () => {},
    platform: "darwin",
    cores: 8,
    denyWrite: [store],
    writeLock: async () => {},
    builders: rustTargetBuilders(),
    exec: async (file) =>
      file.endsWith("xcode-select")
        ? { code: 0, stdout: "/Library/Developer/CommandLineTools\n", stderr: "" }
        : { code: 0, stdout: "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk\n", stderr: "" },
  });
}

function rustGame(dir: string, lock: ToolchainLock): GameBuildGame {
  const shape = {
    entry: "index.html",
    main: "src/main.rs",
    build: null,
    install: null,
    own: false,
    kind: ProjectKind.RustWgpu,
    serve: ".",
  };
  const destinations = { stack: GameStack.RustWgpu, targets: [BuildTarget.Web, BuildTarget.Mac] };
  return { project: GAME.name, dir, shape, destinations, lock };
}

/** Replaces the app's shell with a hostile stand-in. */
type Plant = (file: string) => Promise<void>;

const HOSTILE_SHELLS: ReadonlyArray<readonly [string, Plant]> = [
  ["absent", async (file) => rm(file)],
  [
    "a link to a real page",
    async (file) => {
      const real = `${file}.real`;
      await writeFile(real, "<!doctype html><title>__GAME_TITLE__</title>");
      await rm(file);
      await symlink(real, file);
    },
  ],
  [
    "a folder",
    async (file) => {
      await rm(file);
      await mkdir(file);
    },
  ],
  ["empty", async (file) => writeFile(file, "")],
];

describe("the core's Rust lane: flavours and the web branch (stub store)", { skip: SKIP_UNLESS_MAC }, () => {
  it("a judging build asks for the facade's studio feature; an export never links it", async () => {
    const { lock, dir, resources, core } = await scaffoldedFixture();
    const lane = await laneOver(core.layout.toolchains, resources);
    const judging = await lane.ensure(rustGame(dir, lock), BuildTarget.Mac, CppBuildPurpose.Judging);
    assert.equal(judging.ok, true, JSON.stringify(judging.problem));
    assert.equal(await stagedGenex(String(judging.output)), DEV_FACADE);
    const exported = await lane.ensure(rustGame(dir, lock), BuildTarget.Mac, CppBuildPurpose.Export);
    assert.equal(exported.ok, true, JSON.stringify(exported.problem));
    assert.equal(await stagedGenex(String(exported.output)), EXPORT_FACADE);
    const web = await lane.ensure(rustGame(dir, lock), BuildTarget.Web, CppBuildPurpose.Judging);
    assert.equal(web.ok, true, JSON.stringify(web.problem));
    assert.equal(
      await stagedGenex(String(web.output)),
      WEB_FACADE,
      "the web facade hands the game to the page; never fd 3",
    );
    assert.ok(web.rust?.receipt?.web, "the receipt carries the web branch's block");
    assert.equal(web.rust?.receipt?.web?.optimized, false, "a judging build skips wasm-opt");
  });

  for (const [what, plant] of HOSTILE_SHELLS) {
    it(`refuses a web build whose app shell is ${what}, serving nothing`, async () => {
      const { lock, dir, core } = await scaffoldedFixture();
      const resources = await realpath(await tmpDir("rust-e2e-resources-"));
      const payload = rustPayloadDir(resources);
      await mkdir(payload, { recursive: true });
      for (const file of ["Cargo.lock", "clippy.toml"])
        await writeFile(path.join(payload, file), await readFile(path.join(REPO, "native", "genex-rust", file)));
      const shell = path.join(resources, ...SHELL);
      await mkdir(path.dirname(shell), { recursive: true });
      await writeFile(shell, await readFile(path.join(REPO, "src", ...SHELL)));
      await plant(shell);
      const lane = await laneOver(core.layout.toolchains, resources);
      const web = await lane.ensure(rustGame(dir, lock), BuildTarget.Web, CppBuildPurpose.Export);
      assert.equal(web.ok, false);
      assert.equal(web.output, null);
      assert.equal(web.rust?.refusal, RustBuildRefusal.WebShellMissing, JSON.stringify(web.rust));
    });
  }

  it("registers the web and phone builders over the lane's table", () => {
    const builders = rustTargetBuilders();
    for (const target of [BuildTarget.Mac, BuildTarget.Web, BuildTarget.Ios, BuildTarget.Android])
      assert.equal(builders[target].ready, true, target);
    for (const target of [BuildTarget.Windows, BuildTarget.Linux]) assert.equal(builders[target].ready, false, target);
  });
});

// ── The real chain: the pinned toolchain, the release's vendored crates, Seatbelt, Metal ──────

const TOOLCHAIN_DIR = process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev", "spike-toolchain");
const VENDOR_DIR = process.env.GENEX_RUST_VENDOR_DIR ?? path.join(REPO, ".studio-dev", "rust-release", "e2e", "vendor");
const REQUIRED = process.env.GENEX_REQUIRE_TOOLCHAINS === "1";
/** A cold dev-flavour build compiles the facade with the studio (wgpu, naga, rapier, egui) twice: clippy, then the build. */
const COLD_BUILD_MS = 40 * 60 * SECOND_MS;
/** The lock a real build is stamped with: the lane names its build folder by it, nothing reads its pins. */
const REAL_LOCK = lockOf({ rust: { version: "1.99.0", sha12: "000000000000" } });
/** The share of the default web budget a new game's export may use: "comfortably under" (pass-1 gate). */
const NEW_GAME_BUDGET_SHARE = 0.9;

/** Why the real rows cannot run here, or null. */
function realAbsent(): string | null {
  if (process.platform !== "darwin" || process.arch !== "arm64") return "an Apple silicon Mac";
  for (const need of ["sysroot/bin/cargo", "sysroot/bin/cargo-clippy"])
    if (!existsSync(path.join(TOOLCHAIN_DIR, need))) return `the Rust toolchain (${path.join(TOOLCHAIN_DIR, need)})`;
  if (!existsSync(path.join(VENDOR_DIR, "genex-0.1.0")))
    return `the release's vendored crates (${VENDOR_DIR}; rust-release.ts tree --out .studio-dev/rust-release/e2e)`;
  return null;
}

/** `node:test` options: skip without the toolchain, unless required. */
function needsRealChain(): { skip?: string } {
  const missing = realAbsent();
  if (!missing) return {};
  if (REQUIRED) throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return { skip: `not run: ${missing} absent` };
}

/**
 * The shipped template scaffolded for `targets` and the real lane over the pinned toolchain, the
 * release's vendored crates and the app's web tools and shell, under Seatbelt.
 */
async function realTemplateLane(targets: BuildTarget[]) {
  const { core } = await coreLite({ developmentStacks: true });
  const rpcCall = rpc(core.api());
  await rpcCall("game.scaffold", { name: GAME.name, title: "Ferris", kind: ProjectKind.RustWgpu, targets });
  const game = (await core.games.list()).find((listed) => listed.name === GAME.name);
  assert.ok(game);
  const resources = await realpath(await tmpDir("rust-e2e-real-resources-"));
  const payload = rustPayloadDir(resources);
  await mkdir(payload, { recursive: true });
  for (const file of ["Cargo.lock", "clippy.toml"])
    await writeFile(path.join(payload, file), await readFile(path.join(REPO, "native", "genex-rust", file)));
  const toolchainDir = await realpath(TOOLCHAIN_DIR);
  const vendor = await realpath(VENDOR_DIR);
  const web = {
    wasmBindgen: path.join(toolchainDir, "tools", "bin", "wasm-bindgen"),
    wasmOpt: path.join(toolchainDir, "tools", "binaryen", "bin", "wasm-opt"),
  };
  const toolchain: RustToolchain = {
    bin: path.join(toolchainDir, "sysroot", "bin"),
    vendor,
    clippyConf: payload,
    reads: [toolchainDir, vendor, payload],
    web,
  };
  const root = path.join(await realpath(await tmpDir("rust-e2e-real-builds-")), "rust-builds");
  const lane = new RustBuilds({
    root,
    sandbox: rustBuildSandboxes({ secretPaths: [], enabled: true }),
    locate: async () => ({ ok: true, toolchain }),
    currentLock: async () => REAL_LOCK,
    stage: shippedRustStage(payload),
    emit: () => {},
    platform: process.platform,
    cores: 8,
    denyWrite: [],
    writeLock: async () => {},
    builders: rustTargetBuilders(),
    webShell: shippedWebShell(path.join(REPO, "src")),
    // The app's admission (M3.5): the real Mac image passes its policy, and a dev build may serve the studio.
    admit: admitRustOutput,
  });
  const asked: GameBuildGame = {
    project: GAME.name,
    dir: game.dir,
    shape: game.shape ?? rustGame(game.dir, REAL_LOCK).shape,
    destinations: { stack: GameStack.RustWgpu, targets },
    lock: REAL_LOCK,
  };
  return { lane, asked, root, vendor, toolchainDir };
}

describe("the real chain: game.scaffold → the lane (pinned toolchain, Seatbelt) → fd 3 → a Metal capture", () => {
  const options = needsRealChain();

  it("builds the scaffolded template in the dev flavour, which states protocol 2 on Metal and captures what it drew", {
    ...options,
    timeout: COLD_BUILD_MS,
  }, async () => {
    const { lane, asked, root, vendor, toolchainDir } = await realTemplateLane([BuildTarget.Mac]);
    const built = await lane.ensure(asked, BuildTarget.Mac, CppBuildPurpose.Judging);
    assert.equal(built.ok, true, JSON.stringify(built.problem));
    console.log(`real dev-flavour build steps: ${JSON.stringify(built.rust?.receipt?.steps)}`);
    const output = String(built.output);
    assert.equal(await stagedGenex(output), DEV_FACADE);
    const { port, stateDir } = await startGame(path.join(output, "game"), { GENEX_HEADLESS: "1" });
    const ready = await readyOf(port);
    assert.equal(ready.protocol, NATIVE_PROTOCOL_VERSION);
    assert.equal(ready.receipt?.tier, NativeGpuTier.Core);
    assert.equal(ready.receipt?.backend, NativeBackend.Metal);
    const shot = await port.call(NativeOp.Capture, {});
    const bytes = await readFile(path.join(stateDir, "captures", `${shot.seq}.bgra`));
    assert.equal(bytes.length, shot.width * shot.height * 4);
    assert.equal(fnv1a64Hex(bytes), shot.digest);
    assert.ok(distinctPixels(bytes) > 1, "the starter drew more than a clear colour");

    // The export flavour of the same game: admitted with no studio transport in it, and every crate
    // of its lock and every runtime part of the Mac row has a licence in the real vendored set.
    const exported = await lane.ensure(asked, BuildTarget.Mac, CppBuildPurpose.Export);
    assert.equal(exported.ok, true, JSON.stringify(exported.problem));
    const lock = await readFile(admittedBuildLock(String(exported.output)), "utf8");
    const closure = parseLockClosure(lock);
    assert.ok(closure.ok, JSON.stringify(closure));
    const licences = await readVendoredLicences([vendor], closure.crates);
    const runtime = await rustRuntimeSources({
      sysroot: path.join(toolchainDir, "sysroot"),
      vendorDirs: [vendor],
      crates: closure.crates,
    });
    const notices = rustNotices({ target: BuildTarget.Mac, lock, roots: [RUST_GAME_PACKAGE], licences, runtime });
    assert.ok(notices.ok, JSON.stringify(notices));
    await rm(root, { recursive: true, force: true });
  });

  // Pass-1 gate: a new game's web export went past 4 MB gzip on cargo's default release profile.
  // The export now builds for size, and a new game stays under the default budget with no warning.
  it("exports the scaffolded template for the web, built for size, under the default 4 MB budget with no warning", {
    ...options,
    timeout: COLD_BUILD_MS,
  }, async (t) => {
    const { lane, asked, root } = await realTemplateLane([BuildTarget.Web]);
    const exported = await lane.ensure(asked, BuildTarget.Web, CppBuildPurpose.Export);
    assert.equal(exported.ok, true, JSON.stringify(exported.problem));
    const web = exported.rust?.receipt?.web;
    assert.ok(web, "the receipt records the web packaging");
    t.diagnostic(`template web export: wasm ${web.wasmBytes} bytes, gzip -9 ${web.gzipBytes} bytes`);
    assert.equal(web.optimized, true);
    assert.equal(web.gzipBudgetBytes, WEB_WASM_BUDGET_DEFAULT_BYTES);
    assert.ok(web.gzipBytes <= WEB_WASM_BUDGET_DEFAULT_BYTES * NEW_GAME_BUDGET_SHARE, `gzip ${web.gzipBytes}`);
    assert.equal(web.warning, null);
    await rm(root, { recursive: true, force: true });
  });
});

/** How many distinct BGRA values a capture holds (a blank frame holds one). */
function distinctPixels(bytes: Buffer): number {
  const seen = new Set<number>();
  for (let at = 0; at + 4 <= bytes.length && seen.size < 64; at += 4) seen.add(bytes.readUInt32LE(at));
  return seen.size;
}
