/**
 * The Rust fixture kit (`src/main/dev/fixture-rust.ts`): the `rust-game` and `rust-mobile-game`
 * fixtures' games and their stub Rust store, read back through the store's own locate and built
 * through the real Rust lane (`RustBuilds`) with the real staging (`stageRustGame`): a forced
 * error renders the stub's JSON diagnostic as the first problem, a web build is packaged by the
 * lane's web branch into the committed wasm-bindgen output behind the app's shell, and no real
 * cargo and no network take part. The committed output itself
 * (`tests/fixtures/rust-wasm/`) answers the Rust web shell's page contract. Also the dev-toolchains
 * helper's Rust rows (`tests/helpers/dev-toolchains.ts`).
 *
 * These rows build through a lane they construct with the product's locate and web shell
 * (`core/rust-lane.ts`) and the registered builders (`rustTargetBuilders`). The stub tools are
 * POSIX shell scripts.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FIXTURE_GENEX_VERSION,
  FIXTURE_RUST_FORCE_ERROR,
  FIXTURE_RUST_FORCED_ERROR,
  FIXTURE_RUST_MOBILE_GAME,
  FIXTURE_RUST_WEB_FILES,
  FIXTURE_RUSTC_IDENTITY,
  fixtureRustWebOutput,
  RustFixtureKind,
  seedFixtureRustStore,
  seedRustFixture,
} from "../../src/main/dev/fixture-rust.ts";
import { crateRequestsFor } from "../../src/main/crate-requests.ts";
import { FixtureName, isFixtureName } from "../../src/main/dev/fixture-kit.ts";
import { FIXTURE_RUST_GAME, FIXTURE_STORE_MARKER } from "../../src/main/dev/fixture-toolchains.ts";
import type { GameBuildGame } from "../../src/main/game-build.ts";
import {
  RustBuilds,
  type RustBuildSandbox,
  type RustBuildSandboxSpec,
  type RustStage,
  rustBuildSandboxes,
} from "../../src/main/rust-build.ts";
import { RustBuildRefusal, RustDiagnosticTool } from "../../src/main/rust-build-diagnostics.ts";
import { rustTargetBuilders } from "../../src/main/core/internals.ts";
import { shippedWebShell, storeRustLocate } from "../../src/main/core/rust-lane.ts";
import { WEB_FILES, webShellPage } from "../../src/main/rust-build-web.ts";
import { stageRustGame } from "../../src/main/rust-stage.ts";
import { BuildProblemCode, CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { CrateCheckEngine, CrateNotice, CrateRefusal, CrateRequestState } from "../../src/shared/crate-requests.ts";
import { BuildTarget, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import { readCurrentLock } from "../../src/substrate/toolchain-store/lock.ts";
import { locateRust, RUST_TRIPLE, RustMissing } from "../../src/substrate/toolchain-store/rust-locate.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { DEV_RUST_TOOL, devToolchains } from "../helpers/dev-toolchains.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const COMMITTED = path.join(REPO, "tests", "fixtures", "rust-wasm");
const SKIP_ON_WINDOWS = process.platform === "win32" ? "the stub tools are POSIX shell scripts" : false;
const SKIP_UNLESS_MAC = process.platform === "darwin" ? false : "the Seatbelt sandbox is macOS's";
/** A Rust Mac build (and its locate) needs a Mac: the Linux runner's Rust lane builds no Mac app. */
const MAC_HERE = process.platform === "darwin" ? [BuildTarget.Mac] : [];
const SKIP_UNLESS_MAC_BUILD = process.platform === "darwin" ? false : "a Rust Mac build needs a Mac";
const MAC_SDK = "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk";

/** `request` run by /bin/sh with this process's environment plus `env` (as srt adds its proxy settings). */
async function runShell(request: RunRequest, env: Record<string, string>): Promise<RunResult> {
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", request.command], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env, ...env },
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
      const durationMs = Date.now() - started;
      const facts = { timedOut: false, truncated: false, sandboxed: false };
      resolve({ code, signal, stdout, stderr, durationMs, ...facts, command: request.command, cwd: request.cwd });
    });
  });
}

/** The lane's sandbox, run without containment: every request recorded, `env` added as srt adds its proxy. */
function openSandboxes(env: Record<string, string> = {}) {
  const requests: RunRequest[] = [];
  const specs: RustBuildSandboxSpec[] = [];
  const sandbox = async (spec: RustBuildSandboxSpec): Promise<RustBuildSandbox> => {
    specs.push(spec);
    return {
      run: async (request) => {
        requests.push(request);
        return await runShell(request, env);
      },
      dispose: async () => {},
    };
  };
  return { sandbox, requests, specs };
}

/** A proxy that records every request reaching it: a build that went online would show here. */
async function recordingProxy(): Promise<{ url: string; reached: string[]; close: () => Promise<void> }> {
  const reached: string[] = [];
  const server: Server = createServer((request, response) => {
    reached.push(request.url ?? "");
    response.writeHead(502).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { url: `http://127.0.0.1:${port}`, reached, close };
}

/** The checkout's Rust payload folder (lock line and `clippy.toml`), as a package ships it under resources. */
const PAYLOAD = path.join(REPO, "native", "genex-rust");

/** The real staging at the fixture's genex release, as the lane's `stage`. */
const stage: RustStage = async (game, into, target, flavour) => {
  const pins = { genexVersion: FIXTURE_GENEX_VERSION, baseLock: null };
  const staged = await stageRustGame({ source: game.dir, stage: into, target, pins, flavour });
  if (!staged.ok) return { ok: false, code: staged.code, detail: staged.detail };
  const dependencies = ["genex", ...staged.manifest.crates.map((crate) => crate.name)];
  return { ok: true, dependencies, title: staged.manifest.title };
};

/** The checkout's resources as a package lays them out: the template's shell is the app's web page. */
const RESOURCES = path.join(REPO, "src");

/** The Rust fixture seeded into a fresh core: its library, its store and the store's Rust lock. */
async function fixtureCore(kind: RustFixtureKind = RustFixtureKind.Game) {
  const { core } = await coreLite({ gamesRoot: await realpath(await tmpDir("fixture-rust-games-")) });
  await seedRustFixture(core, kind);
  const store = core.layout.toolchains;
  const lock = await readCurrentLock(store, GameStack.RustWgpu);
  assert.ok(lock, "the fixture made its lock the Rust stack's current one");
  return { core, store, lock };
}

/** A game of the library as the lane takes it. */
function buildGame(dir: string, project: string, targets: readonly BuildTarget[]): GameBuildGame {
  const shape = {
    entry: "index.html",
    main: "src/main.rs",
    build: null,
    install: null,
    own: false,
    kind: ProjectKind.RustWgpu,
    serve: ".",
  };
  return { project, dir, shape, destinations: { stack: GameStack.RustWgpu, targets: [...targets] } };
}

/** A Rust lane over `store` with the given sandbox, the real staging, the app's shell and the registered builders. */
function fixtureLane(store: string, root: string, sandbox: (spec: RustBuildSandboxSpec) => Promise<RustBuildSandbox>) {
  return new RustBuilds({
    root,
    sandbox,
    locate: storeRustLocate(store, PAYLOAD),
    currentLock: () => readCurrentLock(store, GameStack.RustWgpu),
    stage,
    emit: () => {},
    platform: "darwin",
    cores: 8,
    denyWrite: [store],
    writeLock: async () => {},
    builders: rustTargetBuilders(),
    webShell: shippedWebShell(RESOURCES),
    exec: async (file) =>
      file.endsWith("xcode-select")
        ? { code: 0, stdout: "/Library/Developer/CommandLineTools\n", stderr: "" }
        : { code: 0, stdout: `${MAC_SDK}\n`, stderr: "" },
  });
}

/** A fresh folder for a lane's builds, outside the store and the games. */
async function buildRoot(): Promise<string> {
  return path.join(await realpath(await tmpDir("fixture-rust-builds-")), "rust-builds");
}

/** The fixture's desktop game, as the library lists it. */
async function ferris(core: Awaited<ReturnType<typeof fixtureCore>>["core"]) {
  const game = (await core.games.list()).find((listed) => listed.name === FIXTURE_RUST_GAME.name);
  assert.ok(game, "the Rust game is in the library");
  return buildGame(game.dir, game.name, FIXTURE_RUST_GAME.targets);
}

/** Appends a line using {@link FIXTURE_RUST_FORCE_ERROR} to the game's `src/main.rs`; answers its line and column. */
async function forceError(dir: string): Promise<{ line: number; column: number }> {
  const main = path.join(dir, "src", "main.rs");
  const text = (await readFile(main, "utf8")).replace(/\n*$/, "\n");
  const added = `const _FORCED: i32 = ${FIXTURE_RUST_FORCE_ERROR};`;
  await writeFile(main, `${text}${added}\n`);
  return { line: text.split("\n").length, column: added.indexOf(FIXTURE_RUST_FORCE_ERROR) + 1 };
}

/** The names under `dir`, recursively, `/`-joined and sorted (links named, never followed). */
async function listing(dir: string, rel = ""): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    names.push(child);
    if (entry.isDirectory()) names.push(...(await listing(dir, child)));
  }
  return names.sort();
}

describe("the Rust fixtures' stub store, through the store's own locate", { skip: SKIP_ON_WINDOWS }, () => {
  it("are named fixtures; rust-game locates the Mac and the web, not the phones", async () => {
    assert.ok(isFixtureName(FixtureName.RustGame));
    assert.ok(isFixtureName(FixtureName.RustMobileGame));
    const { store, lock } = await fixtureCore();
    for (const target of [...MAC_HERE, BuildTarget.Web]) {
      const found = await locateRust(store, lock, target, { rustflags: ["-F", "unsafe_code"] });
      assert.ok(found.ok, `${target}: ${JSON.stringify(found)}`);
    }
    for (const target of [BuildTarget.Ios, BuildTarget.Android])
      assert.deepEqual(await locateRust(store, lock, target), { ok: false, missing: [RustMissing.Base] }, target);
  });

  it("rust-mobile-game adds ferris-pocket for the browser and the phones and prewarms both phones", async () => {
    const { core, store, lock } = await fixtureCore(RustFixtureKind.Mobile);
    const names = (await core.games.list()).map((game) => game.name).sort();
    assert.deepEqual(names, [FIXTURE_RUST_GAME.name, FIXTURE_RUST_MOBILE_GAME.name].sort());
    for (const target of [...MAC_HERE, BuildTarget.Web, BuildTarget.Ios, BuildTarget.Android]) {
      const found = await locateRust(store, lock, target);
      assert.ok(found.ok, `${target}: ${JSON.stringify(found)}`);
      assert.equal(found.located.triple, RUST_TRIPLE[target]);
    }
  });

  it("lists one crate request in each state the person's card shows, decided ones with their engine", async () => {
    const { core } = await fixtureCore();
    const listed = await crateRequestsFor(core).list(FIXTURE_RUST_GAME.name);
    assert.deepEqual(
      listed.map((view) => [view.name, view.state, view.refusal, view.check?.notice ?? null]),
      [
        ["glam", CrateRequestState.Pending, CrateRefusal.CheckerUnavailable, null],
        ["hecs", CrateRequestState.Pending, null, null],
        ["fresh", CrateRequestState.Vendored, null, CrateNotice.Unaudited],
        ["smallvec", CrateRequestState.Refused, CrateRefusal.Advisory, null],
        ["wrapper", CrateRequestState.Refused, CrateRefusal.Licence, null],
        ["glow", CrateRequestState.Refused, CrateRefusal.Banned, null],
        ["tidy", CrateRequestState.Vendored, null, null],
      ],
    );
    assert.ok(listed.filter((view) => view.check).every((view) => view.check?.engine === CrateCheckEngine.CargoDeny));
    await seedRustFixture(core, RustFixtureKind.Game);
    assert.equal((await crateRequestsFor(core).list()).length, 7, "a reseed keeps the ledger as it is");
  });

  it("reseeding is idempotent: the same lock, the same games, once each", async () => {
    const { core, store, lock } = await fixtureCore();
    await seedRustFixture(core, RustFixtureKind.Game);
    assert.deepEqual(await readCurrentLock(store, GameStack.RustWgpu), lock);
    const named = (await core.games.list()).filter((game) => game.name === FIXTURE_RUST_GAME.name);
    assert.equal(named.length, 1);
  });

  it("never writes a store it did not seed: a foreign folder or a link is left exactly as it was", async () => {
    const parent = await realpath(await tmpDir("fixture-rust-hostile-"));
    const foreign = path.join(parent, "foreign");
    await mkdir(foreign);
    await writeFile(path.join(foreign, "current-lock.json"), "{}\n");
    const target = path.join(parent, "target");
    await mkdir(target);
    const linked = path.join(parent, "linked");
    await symlink(target, linked, "dir");
    const markedTarget = path.join(parent, "marked");
    await mkdir(markedTarget);
    await writeFile(path.join(markedTarget, FIXTURE_STORE_MARKER), "");
    const linkedMarked = path.join(parent, "linked-marked");
    await symlink(markedTarget, linkedMarked, "dir");
    const cases = [
      { name: "a folder holding another store", store: foreign },
      { name: "a link to an empty folder", store: linked },
      { name: "a link to a fixture's store", store: linkedMarked },
    ];
    for (const { name, store } of cases) {
      const before = await listing(parent);
      const lock = await seedFixtureRustStore(store, { webOutput: fixtureRustWebOutput() });
      assert.equal(lock, null, name);
      assert.deepEqual(await listing(parent), before, `${name}: nothing written`);
    }
    assert.equal((await lstat(linked)).isSymbolicLink(), true);
  });
});

describe("a Rust fixture build through the lane (stub cargo, real staging)", { skip: SKIP_ON_WINDOWS }, () => {
  it("a forced error renders the stub's JSON diagnostic as the first problem line", {
    skip: SKIP_UNLESS_MAC_BUILD,
  }, async () => {
    const { core, store } = await fixtureCore();
    const game = await ferris(core);
    const at = await forceError(game.dir);
    const { sandbox, requests } = openSandboxes();
    const lane = fixtureLane(store, await buildRoot(), sandbox);
    const outcome = await lane.ensure(game, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, false);
    const { code, message, file } = FIXTURE_RUST_FORCED_ERROR;
    assert.equal(outcome.problem?.reason, BuildProblemCode.CommandFailed);
    assert.deepEqual(outcome.problem?.lines.slice(0, 2), [
      `error[${code}]: ${message}`,
      ` --> ${file}:${at.line}:${at.column}`,
    ]);
    assert.deepEqual(outcome.rust?.diagnostics[0], {
      tool: RustDiagnosticTool.Rustc,
      code,
      file,
      line: at.line,
      column: at.column,
      message,
      notes: [],
    });
    assert.equal(outcome.rust?.refusal, null);
    // No real cargo: every command the lane ran is a stub of the fixture's store, from an empty environment.
    const sysroot = path.join(await realpath(store), "locks");
    assert.ok(requests.length >= 3, `${requests.length} commands`);
    for (const request of requests) {
      assert.match(request.command, /^exec '\/usr\/bin\/env' '-i' /);
      assert.ok(request.command.includes(sysroot), request.command);
    }
  });

  it("a web build packs the committed wasm behind the app's shell, the stub's identity in its receipt, with no request online", async () => {
    const { core, store } = await fixtureCore();
    const game = await ferris(core);
    const proxy = await recordingProxy();
    try {
      const proxied = { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, https_proxy: proxy.url, http_proxy: proxy.url };
      const { sandbox, specs } = openSandboxes(proxied);
      const lane = fixtureLane(store, await buildRoot(), sandbox);
      const outcome = await lane.ensure(game, BuildTarget.Web, CppBuildPurpose.Live);
      assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
      const committed = await readFile(path.join(COMMITTED, FIXTURE_RUST_WEB_FILES.wasm));
      assert.deepEqual(await readFile(path.join(outcome.output ?? "", WEB_FILES.wasm)), committed);
      assert.ok(
        !(await lstat(path.join(outcome.output ?? "", "game.wasm")).catch(() => null)),
        "cargo's module is not served",
      );
      assert.equal(outcome.rust?.receipt?.compiler.commitHash, FIXTURE_RUSTC_IDENTITY.commitHash);
      assert.equal(outcome.rust?.receipt?.triple, RUST_TRIPLE[BuildTarget.Web]);
      assert.deepEqual(
        specs.map((spec) => spec.allowedDomains),
        [[]],
      );
      assert.deepEqual(proxy.reached, [], "nothing reached for the network");
    } finally {
      await proxy.close();
    }
  });

  it("under the real Seatbelt sandbox (no domain), the web build and the forced error behave the same", {
    skip: SKIP_UNLESS_MAC,
  }, async () => {
    const { core, store } = await fixtureCore();
    const game = await ferris(core);
    const lane = fixtureLane(store, await buildRoot(), rustBuildSandboxes({ secretPaths: [], enabled: true }));
    const built = await lane.ensure(game, BuildTarget.Web, CppBuildPurpose.Live);
    assert.equal(built.ok, true, JSON.stringify(built.problem));
    await forceError(game.dir);
    const failed = await lane.ensure(game, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(failed.rust?.diagnostics[0]?.code, FIXTURE_RUST_FORCED_ERROR.code);
  });

  it("a web build never reads the checkout: the core's build sandbox denies the home folder a checkout sits in", {
    skip: SKIP_UNLESS_MAC,
  }, async () => {
    // The product denies `os.homedir()` (studio-core's Rust lane); the checkout stands for it here,
    // so the row holds wherever the test's temporary folders are. The stub tools read only the store.
    const { core, store } = await fixtureCore();
    const game = await ferris(core);
    const sandbox = rustBuildSandboxes({ secretPaths: [], denyRead: [REPO], enabled: true });
    const lane = fixtureLane(store, await buildRoot(), sandbox);
    const built = await lane.ensure(game, BuildTarget.Web, CppBuildPurpose.Live);
    assert.equal(built.ok, true, JSON.stringify(built.problem));
  });

  it("the lane's web branch serves the committed module and wasm through the store's stub wasm-bindgen, titled by the game", async () => {
    const { core, store } = await fixtureCore();
    const game = await ferris(core);
    const { sandbox } = openSandboxes();
    const lane = fixtureLane(store, await buildRoot(), sandbox);
    const outcome = await lane.ensure(game, BuildTarget.Web, CppBuildPurpose.Live);
    assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
    const served = outcome.output ?? "";
    for (const name of [FIXTURE_RUST_WEB_FILES.module, FIXTURE_RUST_WEB_FILES.wasm])
      assert.deepEqual(await fetchServed(served, name), await readFile(path.join(COMMITTED, name)), name);
    const shell = await readFile(path.join(RESOURCES, "game-template-rust", "web", "shell.html"), "utf8");
    const page = await fetchServed(served, WEB_FILES.page);
    assert.equal(page.toString("utf8"), webShellPage(shell, FIXTURE_RUST_GAME.title));
  });
});

/** `name` from a static server over `dir`, as a page loads it. */
async function fetchServed(dir: string, name: string): Promise<Buffer> {
  const server = createServer(async (request, response) => {
    const file = path.join(dir, path.basename(request.url ?? "/"));
    const body = await readFile(file).catch(() => null);
    if (!body) response.writeHead(404).end();
    else response.writeHead(200).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/${name}`);
    assert.equal(response.status, 200, name);
    return Buffer.from(await response.arrayBuffer());
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The committed module's exports the Rust web shell calls. */
interface FixtureModule {
  initSync(options: { module: BufferSource }): unknown;
  studio_boot(canvas: unknown): string;
  studio_call(op: string, arg: string): string;
  studio_frame(ms: number): void;
}

describe("the committed wasm-bindgen output (tests/fixtures/rust-wasm)", () => {
  it("answers the Rust web shell's page contract: boot, the verbs' envelopes, and frames only while running", async () => {
    const game = (await import(
      pathToFileURL(path.join(COMMITTED, FIXTURE_RUST_WEB_FILES.module)).href
    )) as FixtureModule;
    game.initSync({ module: await readFile(path.join(COMMITTED, FIXTURE_RUST_WEB_FILES.wasm)) });
    assert.deepEqual(JSON.parse(game.studio_boot(null)).ok, true);
    const call = (op: string, arg: unknown = null) => JSON.parse(game.studio_call(op, JSON.stringify(arg)));
    assert.deepEqual(call("seed", { seed: 7 }), { id: null, ok: true, op: "seed", result: { seed: 7 } });
    game.studio_frame(100);
    assert.equal(call("state").result.frame, 0, "paused: a frame moves nothing");
    assert.deepEqual(call("step", { ms: 50 }).result, { steppedFrames: 3, drawCalls: 0 });
    call("start");
    game.studio_frame(1000 / 60);
    assert.equal(call("state").result.frame, 4);
    assert.deepEqual(call("nope"), { id: null, ok: false, op: "nope", error: "unknown-op" });
  });

  it("lists exactly the web lane's output files beside its README and the crate", async () => {
    const names = (await readdir(COMMITTED)).sort();
    assert.deepEqual(names, [...Object.values(FIXTURE_RUST_WEB_FILES), "README.md", "crate"].sort());
  });
});

describe("dev toolchains: the Rust rows", () => {
  /** A Rust toolchain folder holding `present` (each a DEV_RUST_TOOL name). */
  async function rustFolder(present: Array<keyof typeof DEV_RUST_TOOL>): Promise<string> {
    const root = await realpath(await tmpDir("dev-rust-tools-"));
    for (const name of present) {
      const file = path.join(root, ...DEV_RUST_TOOL[name].split("/"));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "");
    }
    return root;
  }

  it("finds each Rust tool under GENEX_RUST_TOOLCHAIN_DIR; an absent one skips, or fails when required", async () => {
    const root = await rustFolder(["cargo", "rustc"]);
    const tools = devToolchains({ GENEX_RUST_TOOLCHAIN_DIR: root });
    assert.equal(tools.rustRoot, root);
    assert.deepEqual(tools.devRustTool("cargo"), { path: path.join(root, ...DEV_RUST_TOOL.cargo.split("/")) });
    assert.deepEqual(tools.needsRustTools("cargo", "rustc"), {});
    assert.deepEqual(tools.needsRustTools("cargo", "vendor"), { skip: "not run: rust vendor absent" });
    const required = devToolchains({ GENEX_RUST_TOOLCHAIN_DIR: root, GENEX_REQUIRE_TOOLCHAINS: "1" });
    assert.throws(() => required.needsRustTools("vendor"), /GENEX_REQUIRE_TOOLCHAINS=1: rust vendor absent/);
  });

  it("defaults to the worktree's spike toolchain folder", () => {
    const repo = "/nowhere/repo";
    assert.equal(devToolchains({}, { repo }).rustRoot, path.join(repo, ".studio-dev", "spike-toolchain"));
  });

  it("reads the Rust dev store's prewarm for its own lock file, never another worktree's", async () => {
    const toolchains = await realpath(await tmpDir("dev-rust-store-"));
    const repo = await realpath(await tmpDir("dev-rust-repo-"));
    const store = path.join(toolchains, "dev-store");
    const lock = await seedFixtureRustStore(store, { webOutput: fixtureRustWebOutput() });
    assert.ok(lock);
    const env = { GENEX_DEV_TOOLCHAINS: toolchains };
    const tools = devToolchains(env, { repo });
    // Without its own lock file a worktree reads the store's current Rust lock.
    assert.equal(tools.rustLockFile(), path.join(store, "current-lock.rust-wgpu.json"));
    assert.deepEqual(tools.needsRustPrewarmed(BuildTarget.Mac, BuildTarget.Web), {});
    assert.deepEqual(tools.needsRustPrewarmed(BuildTarget.Ios), {
      skip: `not run: dev store has no Rust ${BuildTarget.Ios} prewarm`,
    });
    const own = path.join(repo, ".studio-dev", "dev-store-rust-lock.json");
    await mkdir(path.dirname(own), { recursive: true });
    await writeFile(own, `${JSON.stringify({ ...lock, digest: "f".repeat(64) })}\n`);
    assert.equal(devToolchains(env, { repo }).rustLockFile(), own);
    assert.deepEqual(devToolchains(env, { repo }).needsRustPrewarmed(BuildTarget.Mac), {
      skip: `not run: dev store has no Rust ${BuildTarget.Mac} prewarm`,
    });
    const required = devToolchains({ ...env, GENEX_REQUIRE_TOOLCHAINS: "1" }, { repo });
    assert.throws(() => required.needsRustPrewarmed(BuildTarget.Mac), /GENEX_REQUIRE_TOOLCHAINS=1: the dev store/);
  });
});

/** The target-unbuilt refusal stays the lane's until a builder registers: the stand-in is this file's alone. */
describe("without the stand-in, the lane still refuses the web", { skip: SKIP_ON_WINDOWS }, () => {
  it("refuses `target-unbuilt` and runs nothing", async () => {
    const { core, store } = await fixtureCore();
    const game = await ferris(core);
    const { sandbox, requests } = openSandboxes();
    const lane = new RustBuilds({ ...fixtureLane(store, await buildRoot(), sandbox).options, builders: {} });
    const outcome = await lane.ensure(game, BuildTarget.Web, CppBuildPurpose.Live);
    assert.equal(outcome.rust?.refusal, RustBuildRefusal.TargetUnbuilt);
    assert.equal(requests.length, 0);
  });
});
