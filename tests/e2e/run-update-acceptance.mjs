/**
 * Update acceptance (M6.4): a Studio update moves the Rust lock on, and nothing a person made stops
 * building. Two parts, each in disposable profiles under the system temp folder (never the normal
 * profile, `~/AI Games` or another profile's store):
 *
 * 1. Release N → N+1 with a Rust game on lock N builds offline. Studio N makes a Rust game and builds
 *    it on the fixture Rust store (lock N), which the library records. Studio N+1 opens the same
 *    profile with a newer current Rust lock whose parts were never downloaded here, runs the store's
 *    sweep as Settings does (every lock a game records is kept), and builds the game again with the
 *    network refused: it builds on lock N, the judging build (`native.build`) and the web export
 *    alike, staging the genex release lock N resolves (never the one N+1 vendors), while a new game
 *    would get N+1. Live's own build paths (native prepare, the preview's web build) take the same
 *    retained lock and are held by conformance rows (`toolchain-retention.test.ts`). The negative
 *    control sweeps lock N while the game still names it and requires that build to fail, so the
 *    acceptance cannot pass vacuously.
 * 2. A fresh offline install from cached downloads works. Profile A installs the pinned Rust parts
 *    of this host from the developer's downloaded archives into the host-level download cache;
 *    profile B, fresh, installs the same parts with every download refused, from the cache alone,
 *    each archive verified again. This part needs the pinned archives under
 *    `.studio-dev/spike-toolchain/downloads` (`GENEX_RUST_TOOLCHAIN_DIR` names another folder); it
 *    is skipped without them unless `GENEX_REQUIRE_TOOLCHAINS=1`.
 *
 *   node tests/e2e/run-update-acceptance.mjs
 *   node tests/e2e/run-update-acceptance.mjs --sweep-referenced-lock
 *     the same run with Studio N+1's sweep told no game holds lock N: it must fail (the acceptance's red)
 *
 * Evidence: `.studio-dev/evidence/update-acceptance/report.json`.
 */
import assert from "node:assert/strict";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { rustPayloadDir, shippedGenexRelease } from "../../src/main/core/rust-lane.ts";
import { fixtureRustWebOutput, seedFixtureRustStore } from "../../src/main/dev/fixture-rust.ts";
import { WEB_FILES } from "../../src/main/rust-build-web.ts";
import { StudioCore } from "../../src/main/studio-core.ts";
import { BuildTarget, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { ToolchainHost, ToolchainId, ToolchainInstallPhase, toolchainHostOf } from "../../src/shared/toolchain.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { installComponents, readReceipts } from "../../src/substrate/toolchain-store/install.ts";
import { lockOf, readRecordedLock, writeCurrentLock } from "../../src/substrate/toolchain-store/lock.ts";
import { RUST_MANIFEST } from "../../src/substrate/toolchain-store/manifest.ts";
import { prewarmSandboxOptions } from "../../src/substrate/toolchain-store/prewarm.ts";
import { makeResources } from "../helpers/resources.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = path.join(ROOT, ".studio-dev", "evidence", "update-acceptance");
const SPIKE = process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(ROOT, ".studio-dev", "spike-toolchain");
const REQUIRED = process.env.GENEX_REQUIRE_TOOLCHAINS === "1";
/** The red run: Studio N+1's sweep is told no game holds lock N. */
const SWEEP_REFERENCED = process.argv.includes("--sweep-referenced-lock");
const GAME = { title: "Update Pond", targets: [BuildTarget.Web, BuildTarget.Mac] };
/** The Rust pin the update ships: newer than the fixture's, never downloaded in this profile. */
const NEXT_RUST = { version: "1.100.0", sha12: "0a1b2c3d4e5f" };
/** The vendored crate set the update ships: a genex release lock N's build must never stage. */
const NEXT_VENDOR = { version: "0.0.99", sha12: "9f8e7d6c5b4a" };
/** The Rust parts a fresh profile installs on this host (the sysroot, the browser's std, wasm-bindgen, binaryen). */
const INSTALLED_IDS = new Set([
  ToolchainId.Rust,
  ToolchainId.RustStdWasm,
  ToolchainId.WasmBindgen,
  ToolchainId.Binaryen,
]);
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const BUILD_TIMEOUT_MS = 5 * 60 * 1000;
const TERABYTE = 1024 ** 4;

const report = { startedAt: new Date().toISOString(), host: `${process.platform}-${process.arch}`, checks: [] };
const cleanup = [];
after(async () => {
  for (const step of cleanup.reverse()) await step().catch(() => {});
  report.failed = report.checks.filter((check) => !check.ok).length;
  await mkdir(EVIDENCE, { recursive: true });
  await writeFile(path.join(EVIDENCE, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
});

/** Records one acceptance check and asserts it. */
function check(name, ok, detail) {
  report.checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  assert.ok(
    ok,
    `${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`,
  );
}

/** A temp folder of this run's own, removed when it ends; its real path. */
async function ownedDir(prefix) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** One Studio version on `profile`: a real core up to `init()`, no harness, engines or account. */
async function openStudio(profile, resources) {
  const gamesRoot = path.join(profile, "games");
  await mkdir(gamesRoot, { recursive: true });
  const core = new StudioCore({
    paths: { userData: path.join(profile, "userData"), resources },
    gamesRoot,
    engines: [],
    executionPolicy: { allowedProjectRoot: gamesRoot, runBackgroundImprovement: false },
    improvementIdle: { idleMs: 0, minGapMs: 0 },
    sandbox: false,
    execPath: process.execPath,
  });
  await core.init();
  cleanup.push(() => core.stop());
  const api = core.api();
  const call = (method, params) => api[method](params);
  return { core, call };
}

/** Runs `step` with every download refused; answers its result and the downloads it tried. */
async function offline(step) {
  const real = globalThis.fetch;
  const tried = [];
  globalThis.fetch = async (url) => {
    tried.push(String(url));
    throw new TypeError("offline: the update acceptance refuses every download");
  };
  try {
    return { result: await step(), tried };
  } finally {
    globalThis.fetch = real;
  }
}

/** Studio N: a Rust game made through the person's Create game, built on the fixture store's lock N. */
async function releaseN(profile, resources) {
  const { core, call } = await openStudio(profile, resources);
  const game = await core.createGame(GAME.title, { stack: GameStack.RustWgpu, targets: GAME.targets });
  check("Studio N makes a Rust · wgpu game", game.shape?.kind === ProjectKind.RustWgpu, game.name);
  const lockN = await seedFixtureRustStore(core.layout.toolchains, { webOutput: fixtureRustWebOutput() });
  check("Studio N's store holds Rust lock N", lockN !== null);
  const built = await call("native.build", { project: game.name, target: BuildTarget.Mac });
  check("Studio N builds the game", built.ok === true, built.problem);
  const recorded = (await core.games.presentation(game.name)).native?.lock;
  check("the library records lock N for the game", recorded === lockN.digest);
  await core.stop();
  return { name: game.name, lockN };
}

/** Studio N+1 on the same profile: a newer current Rust lock, then the store's sweep. */
async function updateToNext(profile, resources, lockN, sweptGames) {
  const studio = await openStudio(profile, resources);
  const store = studio.core.layout.toolchains;
  const next = lockOf({ ...lockN.entries, [ToolchainId.Rust]: NEXT_RUST, [ToolchainId.RustVendor]: NEXT_VENDOR });
  await writeCurrentLock(store, next, GameStack.RustWgpu);
  const games = sweptGames ?? (await studio.core.games.nativeLocks());
  const swept = await studio.core.toolchains.prune(games);
  return { ...studio, store, next, swept };
}

/** The genex release the Mac build's stage on `lock` pins (`genex = "=x"` or `{ version = "=x", … }`), or "". */
async function stagedGenex(buildRoot, lock) {
  const stage = `${BuildTarget.Mac}-${lock.digest.slice(0, 12)}.stage`;
  for (const project of await readdir(buildRoot)) {
    const manifest = await readFile(path.join(buildRoot, project, stage, "Cargo.toml"), "utf8").catch(() => null);
    const line = manifest?.split("\n").find((entry) => entry.startsWith("genex = "));
    const version = line?.match(/"=([^"]+)"/)?.[1];
    if (version) return version;
  }
  return "";
}

const fixtureHost =
  process.platform === "darwin" ? {} : { skip: "the fixture Rust store's Mac build is the Mac lane's" };

describe("release N → N+1: a Rust game on lock N builds offline", { timeout: BUILD_TIMEOUT_MS }, () => {
  it(
    "builds on lock N after the update and its sweep, its judging build and its web export, downloading nothing",
    fixtureHost,
    async () => {
      const resources = await makeResources();
      const profile = await ownedDir("genex-update-acceptance-");
      const { name, lockN } = await releaseN(profile, resources);
      const { core, call, store, next, swept } = await updateToNext(
        profile,
        resources,
        lockN,
        SWEEP_REFERENCED ? [] : undefined,
      );
      check("Studio N+1's sweep ran", swept.refused === undefined, swept);
      check(
        "the sweep kept lock N while a game references it",
        JSON.stringify(await readRecordedLock(store, lockN.digest)) === JSON.stringify(lockN),
      );
      check(
        "a new game would build on N+1",
        (await core.toolchains.currentLock(GameStack.RustWgpu))?.digest === next.digest,
      );
      const judged = await offline(() => call("native.build", { project: name, target: BuildTarget.Mac }));
      check(
        "the game's judging build (native.build) runs offline after the update",
        judged.result.ok === true,
        judged.result.problem,
      );
      check(
        "it builds on lock N, the one it recorded",
        judged.result.lock === lockN.digest.slice(0, 12),
        judged.result.lock,
      );
      const pinned = await stagedGenex(core.layout.rustBuilds, lockN);
      const shipped = await shippedGenexRelease(rustPayloadDir(resources));
      check(
        "its stage pins the genex release lock N resolves, never the one N+1 vendors",
        pinned === shipped && pinned !== NEXT_VENDOR.version,
        pinned,
      );
      const out = path.join(profile, "export");
      const exported = await offline(() => core.exportPublicCopy(name, out));
      check("its web export builds offline on lock N", existsSync(path.join(out, WEB_FILES.page)), exported.result);
      check("nothing tried to download", [...judged.tried, ...exported.tried].length === 0, [
        ...judged.tried,
        ...exported.tried,
      ]);
      const status = await core.toolchains.status();
      check("no install job started", status.job === null, status.job);
    },
  );

  it("negative control: lock N swept while the game names it fails the offline build", fixtureHost, async () => {
    const resources = await makeResources();
    const profile = await ownedDir("genex-update-control-");
    const { name, lockN } = await releaseN(profile, resources);
    const { call, store, swept } = await updateToNext(profile, resources, lockN, []);
    check(
      "control: the sweep told no game holds lock N removed it",
      swept.refused === undefined && (await readRecordedLock(store, lockN.digest)) === null,
    );
    const rebuilt = await offline(() => call("native.build", { project: name, target: BuildTarget.Mac }));
    check(
      "control: the acceptance's build check fails without lock N",
      rebuilt.result.ok === false,
      rebuilt.result.problem?.reason,
    );
  });
});

/** This host's pinned Rust parts and the downloaded archive of each, or why they are not here. */
function pinnedDownloads() {
  const host = toolchainHostOf(process.platform, process.arch);
  if (host !== ToolchainHost.MacArm64 && host !== ToolchainHost.LinuxX64)
    return { absent: "a host the Rust store pins" };
  const entries = RUST_MANIFEST.filter(
    (entry) => INSTALLED_IDS.has(entry.id) && (entry.host === host || entry.host === null),
  );
  const served = {};
  for (const archive of entries.flatMap((entry) => entry.archives)) {
    const file = path.join(SPIKE, "downloads", path.basename(archive.url));
    if (!existsSync(file)) return { absent: file };
    served[archive.url] = file;
  }
  return { entries, served };
}

/** `node:test` options: run with the archives here; else skip, or fail when they are required. */
function installGate(found) {
  if (!found.absent) return {};
  if (REQUIRED) throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${found.absent} absent`);
  return { skip: `not run: ${found.absent} absent` };
}

/** A fetch that serves the developer's downloaded archives by their pinned URL, counting each. */
function fileFetch(served, fetched) {
  return async (url) => {
    fetched.push(url);
    const file = served[url];
    if (!file) return new Response("absent", { status: 404 });
    const body = Readable.toWeb(createReadStream(file));
    return new Response(body, { status: 200, headers: { "content-length": String(statSync(file).size) } });
  };
}

/** The receipts a store holds, by what they pin. */
async function pins(store) {
  return (await readReceipts(store)).map((receipt) => `${receipt.id}@${receipt.version}:${receipt.sha256}`).sort();
}

describe("a fresh offline install from cached downloads", () => {
  const found = pinnedDownloads();
  const gate = installGate(found);

  it("installs the pinned Rust parts in a fresh profile from the shared cache with every download refused", {
    ...gate,
    timeout: INSTALL_TIMEOUT_MS,
  }, async () => {
    const root = await ownedDir("genex-offline-install-");
    const cache = path.join(root, "cache", "toolchain-downloads");
    const sandbox = await ProcessSandbox.create(prewarmSandboxOptions(path.join(root, "scratch"), []));
    cleanup.push(() => sandbox.dispose());
    const deps = (fetch) => ({
      fetch,
      run: (request) => sandbox.run(request),
      freeBytes: async () => TERABYTE,
      onJob: () => {},
      downloadCache: cache,
    });
    const archives = found.entries.flatMap((entry) => entry.archives).length;
    const fetched = [];
    const first = await installComponents(
      path.join(root, "profile-a", "toolchains"),
      found.entries,
      deps(fileFetch(found.served, fetched)),
    );
    check(
      "profile A installs online, filling the shared cache",
      first.phase === ToolchainInstallPhase.Installed,
      first,
    );
    check("profile A downloads each pinned archive once", fetched.length === archives, fetched.length);
    const refused = [];
    const fresh = await installComponents(
      path.join(root, "profile-b", "toolchains"),
      found.entries,
      deps(async (url) => {
        refused.push(url);
        throw new TypeError("offline");
      }),
    );
    check("a fresh profile installs offline from the cache", fresh.phase === ToolchainInstallPhase.Installed, fresh);
    check("the offline install asked for no download", refused.length === 0, refused);
    const [a, b] = [
      await pins(path.join(root, "profile-a", "toolchains")),
      await pins(path.join(root, "profile-b", "toolchains")),
    ];
    check(
      "both profiles hold the same pinned parts",
      a.length === found.entries.length && JSON.stringify(a) === JSON.stringify(b),
      { a, b },
    );
  });
});
