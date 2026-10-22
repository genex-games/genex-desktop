/**
 * The bake step end to end on the real chain (game systems NAV-14b): the shipped template,
 * scaffolded by `game.scaffold` with one `game.nav_bake`, built in the dev flavour by the real
 * Rust lane (pinned toolchain, the release's vendored crates, Seatbelt); its admitted executable
 * started headless over fd 3 as the bake session, whose `ready` receipt advertises the bake. The
 * lane sends `bakeAssets`, reads the game's `state/bakes/nav/<name>` and lands the navmesh in the
 * admitted `out/assets/baked/nav/<name>` and the profile cache; an unchanged rebuild starts nothing.
 *
 * The cheap rows (fake sessions over a stub cargo, the hostile tables) are `rust-bake.test.ts`;
 * the session through the native run registry is its `nativeBakeSessions` rows. These rows skip
 * without the toolchain and the release's vendored crates, unless `GENEX_REQUIRE_TOOLCHAINS=1`.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { Duplex } from "node:stream";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { rustTargetBuilders } from "../../src/main/core/internals.ts";
import { rustPayloadDir, shippedRustStage } from "../../src/main/core/rust-lane.ts";
import { BAKED_ASSETS_FOLDER, type BakeSession, bakeCacheFolder } from "../../src/main/rust-bake.ts";
import { RustBuilds, type RustToolchain, rustBuildSandboxes } from "../../src/main/rust-build.ts";
import { CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { SECOND_MS } from "../../src/shared/duration.ts";
import { BakeKind, NativeOp, NativeRunMode, type NativeTimers } from "../../src/shared/native-contract.ts";
import { BuildTarget, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { admitRustOutput } from "../../src/substrate/native-cross-admission.ts";
import { NativeGamePort } from "../../src/substrate/native-game-port.ts";
import type { GameChild, GameExit } from "../../src/substrate/spawn.ts";
import { lockOf } from "../../src/substrate/toolchain-store/lock.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { metalRequired } from "../helpers/gpu-games.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TOOLCHAIN_DIR = process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev", "spike-toolchain");
const VENDOR_DIR = process.env.GENEX_RUST_VENDOR_DIR ?? path.join(REPO, ".studio-dev", "rust-release", "e2e", "vendor");
const REQUIRED = process.env.GENEX_REQUIRE_TOOLCHAINS === "1" || metalRequired();
const NONCE = "rust-bake-real-nonce";
const GAME = "market-bake";
const BAKE = "market";
/** A cold dev-flavour build compiles the facade with the studio twice: clippy, then the build. */
const COLD_BUILD_MS = 40 * 60 * SECOND_MS;
/** The lock a real build is stamped with: the lane names its build folder by it, nothing reads its pins. */
const REAL_LOCK = lockOf({ rust: { version: "1.99.0", sha12: "000000000000" } });

/** The facet the row adds to the template: a walker's nav and one offline bake of a 24 m floor. */
const NAV_FACET = `use crate::game::World;
use genex::nav::{NavArea, NavConfig, NavInput};
use genex::prelude::*;

/// A 24 m by 12 m floor, the input the build bakes.
fn floor() -> NavInput {
    let vertices = [vec3(0.0, 0.0, 0.0), vec3(24.0, 0.0, 0.0), vec3(24.0, 0.0, 12.0), vec3(0.0, 0.0, 12.0)];
    NavInput::new().with_triangles(&vertices, &[0, 2, 1, 0, 3, 2], NavArea::WALK).unwrap_or_default()
}

/// The walker's nav and the offline bake \`${BAKE}\`.
pub fn wire(game: &mut Game<World>) {
    game.navigation(NavConfig::walker(0.4, 1.8).with_tile(8.0));
    game.nav_bake("${BAKE}", |_gfx| floor());
}
`;
const FACET_WIRING = "    // ── END FACET WIRING ──";
const FACET_LINES = `    #[path = "facets/navbake.rs"] mod navbake;\n    navbake::wire(&mut game);\n${FACET_WIRING}`;

const isTimeout = (handle: unknown): handle is NodeJS.Timeout => typeof handle === "object" && handle !== null;
const REAL_TIMERS: NativeTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => {
    if (isTimeout(handle)) clearTimeout(handle);
  },
};

const children: Array<() => Promise<void>> = [];
after(async () => {
  for (const stop of children) await stop();
});

/** Why the real row cannot run here, or null. */
function realAbsent(): string | null {
  if (process.platform !== "darwin" || process.arch !== "arm64") return "an Apple silicon Mac";
  if (!existsSync(path.join(TOOLCHAIN_DIR, "sysroot", "bin", "cargo"))) return `the Rust toolchain (${TOOLCHAIN_DIR})`;
  if (!existsSync(path.join(VENDOR_DIR, "genex-0.1.0"))) return `the release's vendored crates (${VENDOR_DIR})`;
  return null;
}

function needsRealChain(): { skip?: string } {
  const missing = realAbsent();
  if (!missing) return {};
  if (REQUIRED) throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return { skip: `not run: ${missing} absent` };
}

/**
 * The admitted headless game started as `spawnGame` starts one (fd 3, its own process group, the
 * studio's variables only), as the bake session: its receipt's bakes, its state and its port.
 */
async function headlessSession(out: string, sessions: { opened: number }): Promise<BakeSession> {
  sessions.opened += 1;
  const scratch = await realpath(await tmpDir("rust-bake-real-run-"));
  const state = path.join(scratch, "state");
  const home = path.join(scratch, "home");
  await Promise.all([state, home].map((dir) => mkdir(dir, { recursive: true })));
  const env = { GENEX_STUDIO_FD: "3", GENEX_STUDIO_NONCE: NONCE, GENEX_STATE_DIR: state, HOME: home };
  const proc = spawn(path.join(out, "game"), [], {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    detached: true,
    cwd: scratch,
    env: { ...env, GENEX_HEADLESS: "1" },
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
  const close = async () => {
    kill("SIGKILL");
    await exited;
  };
  children.push(close);
  const child: GameChild = { pid, fd3, stdout, stderr, exited, kill };
  const port = new NativeGamePort({
    child,
    nonce: NONCE,
    mode: NativeRunMode.Headless,
    stateDir: state,
    timers: REAL_TIMERS,
    encodeJpeg: async () => Buffer.from("jpeg"),
  });
  const ready = await port.ready();
  return {
    bakes: ready.receipt?.bakes ?? [],
    state,
    bake: (ref) => port.call(NativeOp.BakeAssets, ref),
    close,
  };
}

/** The template scaffolded with the nav facet, and the real lane with the bake step over the pinned toolchain. */
async function bakingTemplateLane(sessions: { opened: number }) {
  const lite = await coreLite({ developmentStacks: true });
  const api = lite.core.api();
  await api["game.scaffold"]({ name: GAME, title: "Market", kind: ProjectKind.RustWgpu, targets: [BuildTarget.Mac] });
  const game = (await lite.core.games.list()).find((listed) => listed.name === GAME);
  await lite.close();
  assert.ok(game?.shape);
  await mkdir(path.join(game.dir, "src", "facets"), { recursive: true });
  await writeFile(path.join(game.dir, "src", "facets", "navbake.rs"), NAV_FACET);
  const main = path.join(game.dir, "src", "main.rs");
  const source = await readFile(main, "utf8");
  assert.ok(source.includes(FACET_WIRING), "the template's facet wiring block");
  await writeFile(main, source.replace(FACET_WIRING, FACET_LINES));
  const resources = await realpath(await tmpDir("rust-bake-real-resources-"));
  const payload = rustPayloadDir(resources);
  await mkdir(payload, { recursive: true });
  for (const file of ["Cargo.lock", "clippy.toml"])
    await writeFile(path.join(payload, file), await readFile(path.join(REPO, "native", "genex-rust", file)));
  const toolchainDir = await realpath(TOOLCHAIN_DIR);
  const vendor = await realpath(VENDOR_DIR);
  const toolchain: RustToolchain = {
    bin: path.join(toolchainDir, "sysroot", "bin"),
    vendor,
    clippyConf: payload,
    reads: [toolchainDir, vendor, payload],
  };
  const home = await realpath(await tmpDir("rust-bake-real-builds-"));
  const assetCache = path.join(home, "asset-cache");
  const lane = new RustBuilds({
    root: path.join(home, "rust-builds"),
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
    admit: admitRustOutput,
    bakes: {
      cache: (project) => bakeCacheFolder(assetCache, project),
      open: async (run) => await headlessSession(run.out, sessions),
      opensFor: (target) => target === BuildTarget.Mac,
    },
  });
  const asked = {
    project: GAME,
    dir: game.dir,
    shape: game.shape,
    destinations: { stack: GameStack.RustWgpu, targets: [BuildTarget.Mac] },
    lock: REAL_LOCK,
  };
  return { lane, asked, home, assetCache, gameDir: game.dir };
}

describe("the real chain: a scaffolded game's nav bake lands in the stage, never the game folder", () => {
  it("bakes the advertised navmesh in a headless session after the dev build; an unchanged rebuild starts nothing", {
    ...needsRealChain(),
    timeout: COLD_BUILD_MS,
  }, async () => {
    const sessions = { opened: 0 };
    const { lane, asked, home, assetCache, gameDir } = await bakingTemplateLane(sessions);
    const started = Date.now();
    const built = await lane.ensure(asked, BuildTarget.Mac, CppBuildPurpose.Judging);
    console.log(`real dev build with the bake step: ${Date.now() - started} ms`);
    assert.equal(built.ok, true, JSON.stringify(built.problem));
    assert.equal(sessions.opened, 1, "one headless session for the cache miss");
    const out = String(built.output);
    const baked = path.join(out, "assets", BAKED_ASSETS_FOLDER, BakeKind.Nav, BAKE);
    const navmesh = await readFile(baked);
    assert.ok(navmesh.length > 0, "the navmesh bytes");
    console.log(`baked ${BAKE}: ${navmesh.length} B`);
    const shipped = built.rust?.receipt?.outputs.map((file) => file.path) ?? [];
    assert.ok(shipped.includes(`assets/${BAKED_ASSETS_FOLDER}/${BakeKind.Nav}/${BAKE}`), "admitted with the build");
    assert.equal(existsSync(path.join(gameDir, "assets", BAKED_ASSETS_FOLDER)), false, "never in the game folder");
    assert.equal(existsSync(bakeCacheFolder(assetCache, GAME)), true, "the profile cache holds the entry");

    const again = await lane.ensure(asked, BuildTarget.Mac, CppBuildPurpose.Judging);
    assert.equal(again.ok, true, JSON.stringify(again.problem));
    assert.equal(sessions.opened, 1, "an unchanged rebuild starts no session");
    const rebuilt = path.join(String(again.output), "assets", BAKED_ASSETS_FOLDER, BakeKind.Nav, BAKE);
    assert.deepEqual(await readFile(rebuilt), navmesh);
    await removeTree(home);
  });
});
