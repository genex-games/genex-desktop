/**
 * The Rust runtime's studio contract (M2.4), driven through the host's own `NativeGamePort` the
 * way `native-real.test.ts` drives a C++ game: the Rust protocol game
 * (`tests/fixtures/rust-protocol-game/src/main.rs`, a generated game's sources on the genex
 * facade, built as the facade's `rust-protocol-game` example with the dev flavour's `studio`
 * feature) is started as `spawnGame` starts a game (fd 3, its own process group, an environment of
 * exactly the studio's variables) and answers through `genex::install`.
 *
 * The rows are `cpp-runtime.test.ts`'s fd-3 rows ported to the Rust runtime: `ready` once with the
 * nonce (protocol 2, the capability receipt), captures as top-down BGRA in
 * `<state>/captures/<seq>.bgra` with the FNV-1a 64 the host recomputes and only the last eight
 * kept, `no-state-dir` for an untrustworthy `GENEX_STATE_DIR` with nothing written, `unknown-op`
 * naming the ops a native run serves, the meters, `front`/`visible` on a headless run, the ring
 * ops of a run Live does not embed, and the way out (`quit`, the studio's end of file, `fatal` on a
 * panic). Rows the C++ suite has no twin for: contract v2's `state()` (`lifecycle`, `safeArea`),
 * touch input in world pixels, saves under the run's `state/`, and touch synthesis (M3.9): a play
 * script's `touch` and `click` driven through the host's `preview.input` routing reach a
 * touch-only control on the Mac build.
 *
 * Needs the installed Rust toolchain (`scripts/spike/rust-wgpu/setup-toolchain.sh`) and the host
 * GPU (Metal on the Mac): the rows skip without them, and `GENEX_REQUIRE_TOOLCHAINS=1` turns a
 * missing toolchain into a failure. POSIX only (fd 3 and process groups).
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import {
  NATIVE_CAPTURE_FORMAT,
  NATIVE_PROTOCOL_VERSION,
  NativeRefusal,
  nativeCustomPasses,
  NativeEvent,
  NativeGpuTier,
  NativeLifecycle,
  type NativeEventMessage,
  NativeOp,
  NativeOpError,
  NativeRunMode,
  type NativeTimers,
} from "../../src/shared/native-contract.ts";
import { TouchPhase } from "../../src/shared/preview-contract.ts";
import type { GameChild, GameExit } from "../../src/substrate/spawn.ts";
import {
  NativeExitError,
  NativeGamePort,
  NativeOpRefusedError,
  fnv1a64Hex,
} from "../../src/substrate/native-game-port.ts";
import { applyPlayScript } from "../../src/harness-seed/loop/play-script.ts";
import { routePreviewInput } from "../../src/main/harness-rpc/preview.ts";
import { lineReader } from "../fixtures/rust-fake-host.mjs";
import { tmpDir } from "../helpers/tmp.ts";
// Starts real games on the GPU: the runners run this file one at a time (gpu-games.ts).
import "../helpers/gpu-games.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
/** The cargo env helper: the pinned sysroot, the vendored crates and the genex workspace manifest. */
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");
const TOOLCHAIN_CARGO = path.join(REPO, ".studio-dev", "spike-toolchain", "sysroot", "bin", "cargo");
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? path.join(REPO, ".studio-dev", "cargo-target");
const GAME = path.join(TARGET_DIR, "debug", "examples", "rust-protocol-game");
const BUILD = ["cargo", "build", "-p", "genex", "--example", "rust-protocol-game", "--features", "studio"];
/** A warm build is seconds; a cold one compiles the wgpu graph. */
const BUILD_TIMEOUT_MS = 15 * MINUTE_MS;
const BUILD_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const SUITE_TIMEOUT_MS = 20 * MINUTE_MS;
const NONCE = "rust-runtime-n0nce";
/** The protocol game's world target. */
const WORLD = { width: 96, height: 64 };
/** One tick, as the facade runs it. */
const TICK_MS = 1000 / 60;
/** Capture files a run keeps (`CAPTURES_KEPT` in genex-studio). */
const CAPTURES_KEPT = 8;
/** How long a row waits for a game to exit after it was asked to. */
const EXIT_WAIT_MS = 5 * SECOND_MS;
/** The red cube's colour in a capture: red well above green and blue (BGRA bytes). */
const RED_OVER = 60;
/** The game's own refusal codes (`VerbRefusal` in genex-studio). Wire values. */
const GameRefusal = {
  UnknownCamera: "unknown-camera",
  NoStateDir: "no-state-dir",
  BadArgument: "bad-argument",
  NoFramesService: "no-frames-service",
} as const;
/** Every op a native Rust run serves (genex-studio `Op::ALL`), and the ring's two on a Mac. */
const NATIVE_OPS = [
  NativeOp.Seed,
  NativeOp.Start,
  NativeOp.Pause,
  NativeOp.Step,
  NativeOp.State,
  NativeOp.Input,
  NativeOp.Capture,
  NativeOp.DebugCamera,
  NativeOp.Cameras,
  NativeOp.Eyes,
  NativeOp.Demos,
  NativeOp.Demo,
  NativeOp.Audio,
  NativeOp.RenderSettings,
  NativeOp.AudioLevel,
  NativeOp.Timing,
  NativeOp.Quit,
  NativeOp.Front,
  NativeOp.Visible,
] as const;
const EMBED_OPS = process.platform === "darwin" ? [NativeOp.Surface, NativeOp.Release] : [];
/** The asset tools a native run knows and answers `unavailable` until their runtime lands (`Op::ASSET_TOOLS`). */
const ASSET_TOOL_OPS = [NativeOp.BakeAssets, NativeOp.ReloadAssets] as const;

function needsGame(): { skip?: string } {
  if (process.platform === "win32") return { skip: "not run: fd 3 and process groups are POSIX" };
  if (!existsSync(TOOLCHAIN_CARGO)) {
    if (process.env.GENEX_REQUIRE_TOOLCHAINS === "1") {
      throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: no Rust toolchain at ${TOOLCHAIN_CARGO}`);
    }
    return { skip: "not run: the Rust toolchain is not installed" };
  }
  if (process.platform !== "darwin") return { skip: "not run: the game renders on the host GPU (Metal on the Mac)" };
  return {};
}

const isTimeout = (handle: unknown): handle is NodeJS.Timeout => typeof handle === "object" && handle !== null;
const REAL_TIMERS: NativeTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => {
    if (isTimeout(handle)) clearTimeout(handle);
  },
};

/** The studio's variables for a run whose `state/` is `stateDir`; `GENEX_STATE_DIR` as given (absent for undefined). */
function studioEnv(stateDir: string | undefined, home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GENEX_STUDIO_FD: "3", GENEX_STUDIO_NONCE: NONCE, HOME: home, ...extra };
  if (stateDir !== undefined) env.GENEX_STATE_DIR = stateDir;
  return env;
}

interface Spawned {
  child: GameChild;
  stateDir: string;
  /** The folder the game runs in, which it must never write. */
  cwd: string;
  stop(): Promise<void>;
}

interface Run extends Spawned {
  port: NativeGamePort;
  events: NativeEventMessage[];
}

interface StartOptions {
  /** `GENEX_STATE_DIR` as given; null leaves it out. The run's own `state/` is made either way. */
  state?: string | null;
  env?: Record<string, string>;
}

const started: Spawned[] = [];

/** The protocol game started as `spawnGame` starts one: fd 3, its own process group, the studio's variables only. */
async function spawnGame(options: StartOptions): Promise<Spawned> {
  const scratch = await realpath(await tmpDir("rust-runtime-"));
  const stateDir = path.join(scratch, "state");
  const cwd = path.join(scratch, "cwd");
  const home = path.join(scratch, "home");
  await Promise.all([stateDir, cwd, home].map((dir) => mkdir(dir, { recursive: true })));
  const given = options.state === undefined ? stateDir : (options.state ?? undefined);
  const proc = spawn(GAME, [], {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    detached: true,
    cwd,
    env: studioEnv(given, home, options.env),
  });
  const exited = new Promise<GameExit>((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
  await once(proc, "spawn");
  proc.on("error", () => {});
  const fd3 = proc.stdio[3];
  const pid = proc.pid;
  const { stdout, stderr } = proc;
  const piped = fd3 instanceof Duplex && stdout !== null && stderr !== null;
  if (!piped || pid === undefined) throw new Error("the game has no protocol pipe");
  const kill = (signal: NodeJS.Signals) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error.code === "ESRCH" || error.code === "EPERM")))
        throw error;
    }
  };
  const child: GameChild = { pid, fd3, stdout, stderr, exited, kill };
  const spawned: Spawned = {
    child,
    stateDir,
    cwd,
    stop: async () => {
      kill("SIGKILL");
      await exited;
    },
  };
  started.push(spawned);
  return spawned;
}

/** The protocol game with the host's port on it. */
async function startRun(options: StartOptions = {}): Promise<Run> {
  const spawned = await spawnGame(options);
  const { child, stateDir } = spawned;
  const port = new NativeGamePort({
    child,
    nonce: NONCE,
    mode: NativeRunMode.Headless,
    stateDir,
    timers: REAL_TIMERS,
    encodeJpeg: async () => Buffer.from("jpeg"),
  });
  const events: NativeEventMessage[] = [];
  port.onEvent((event) => events.push(event));
  return { ...spawned, port, events };
}

/** The protocol game with no port: the row writes requests the port would never send and reads the raw replies. */
async function startRaw(options: StartOptions = {}) {
  const spawned = await spawnGame(options);
  const lines = lineReader(spawned.child.fd3);
  // Contract v2: the facade says `starting` after each boot step, then `ready` once.
  let first = await lines.next();
  while (first.event === NativeEvent.Starting) first = await lines.next();
  assert.equal(first.event, NativeEvent.Ready);
  let id = 0;
  /** The game's reply to one request line. */
  const ask = async (request: Record<string, unknown>): Promise<Record<string, unknown>> => {
    id += 1;
    spawned.child.fd3.write(`${JSON.stringify({ id, ...request })}\n`);
    const reply = await lines.next();
    assert.equal(reply.id, id, "replies come in order");
    return reply;
  };
  return { ...spawned, ask };
}

/** The game's `{ok: false}` code for a call it refused. */
async function refusedWith(call: Promise<unknown>): Promise<string> {
  const error = await call.then(
    () => null,
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof NativeOpRefusedError, `refused by the game, got ${String(error)}`);
  return error.gameError;
}

async function captureFiles(stateDir: string): Promise<string[]> {
  return (await readdir(path.join(stateDir, "captures")).catch(() => [])).sort();
}

async function stateOf(run: Run): Promise<Record<string, unknown>> {
  const state = await run.port.studioState();
  assert.ok(typeof state === "object" && state !== null, "state() is an object");
  return state as Record<string, unknown>;
}

async function exitOf(run: Run): Promise<GameExit> {
  const timeout = sleep(EXIT_WAIT_MS).then(() => null);
  const exit = await Promise.race([run.child.exited, timeout]);
  assert.ok(exit, "the game exited in time");
  return exit;
}

/** The fraction of a top-down BGRA frame's rows above and below the middle that hold the red cube. */
function redRows(bgra: Buffer, width: number, height: number): { above: number; below: number } {
  const redRow = (row: number) => {
    for (let x = 0; x < width; x++) {
      const at = (row * width + x) * 4;
      const [blue, green, red] = [bgra[at] ?? 0, bgra[at + 1] ?? 0, bgra[at + 2] ?? 0];
      if (red > green + RED_OVER && red > blue + RED_OVER) return true;
    }
    return false;
  };
  let above = 0;
  let below = 0;
  for (let row = 0; row < height; row++) {
    if (!redRow(row)) continue;
    if (row < height / 2) above++;
    else below++;
  }
  return { above, below };
}

const NEEDS = needsGame();

before(async () => {
  if (NEEDS.skip) return;
  await execFileAsync(process.execPath, [RUST_ENV, "--", ...BUILD, "--offline", "--locked"], {
    cwd: REPO,
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: BUILD_OUTPUT_MAX_BYTES,
  });
});

after(async () => {
  for (const run of started) await run.stop();
});

describe("the Rust runtime over fd 3: ready and contract v2", { ...NEEDS, timeout: SUITE_TIMEOUT_MS }, () => {
  it("sends ready once, with the nonce, protocol 2, the receipt, the world size and the seed", async () => {
    const run = await startRun();
    const ready = await run.port.ready();
    assert.equal(ready.nonce, NONCE);
    assert.equal(ready.protocol, NATIVE_PROTOCOL_VERSION);
    assert.equal(ready.contractVersion, NATIVE_PROTOCOL_VERSION);
    assert.deepEqual(ready.size, WORLD);
    assert.equal(ready.seed, 1);
    assert.match(ready.build, /^genex-rust\/macos\/headless$/);
    assert.equal(ready.receipt?.tier, NativeGpuTier.Core);
    assert.equal(ready.receipt?.backend, ready.backend.api, "backend.api names the receipt's backend");
    await run.port.call(NativeOp.State);
    assert.equal(run.events.filter((event) => event.event === NativeEvent.Ready).length, 1, "one ready");
    assert.equal(run.port.failure, null);
  });

  it("answers state() with lifecycle and safeArea, the checksum, the probes and the renderer's tally", async () => {
    const run = await startRun();
    await run.port.ready();
    await run.port.call(NativeOp.Seed, { seed: 7 });
    const state = await stateOf(run);
    assert.equal(state.lifecycle, NativeLifecycle.Resumed);
    assert.deepEqual(state.safeArea, { top: 0, left: 0, bottom: 0, right: 0 });
    assert.equal(state.contractVersion, NATIVE_PROTOCOL_VERSION);
    assert.match(String(state.checksum), /^[0-9a-f]{16}$/);
    assert.equal(state.x, 0);
    assert.equal(state.running, false, "seed pauses the game");
    const volatile = state.volatile as Record<string, unknown>;
    assert.ok("fps" in volatile && "ticksSeen" in volatile, "volatile probes beside fps");
    const render = state.__render as { drawCalls: number; triangles: number; tags: Record<string, unknown> };
    assert.equal(render.drawCalls, 1);
    assert.equal(render.triangles, 12, "a cube is twelve triangles");
    assert.deepEqual(render.tags.marker, { drawCalls: 1, triangles: 12 });
  });

  it("seeds and steps deterministically: the same seed and steps replay the same checksum", async () => {
    const run = await startRun();
    await run.port.ready();
    assert.deepEqual(await run.port.call(NativeOp.Seed, { seed: 7 }), { seed: 7, paused: true });
    const stepped = await run.port.call(NativeOp.Step, { ms: 1000 });
    assert.deepEqual([stepped.steppedFrames, stepped.frame, stepped.drawCalls], [60, 60, 1]);
    const first = await stateOf(run);
    await run.port.call(NativeOp.Seed, { seed: 7 });
    await run.port.call(NativeOp.Step, { ms: 1000 });
    assert.equal((await stateOf(run)).checksum, first.checksum);
    await run.port.call(NativeOp.Seed, { seed: 8 });
    await run.port.call(NativeOp.Step, { ms: 1000 });
    assert.notEqual((await stateOf(run)).checksum, first.checksum, "another seed is another run");
  });
});

describe("the Rust runtime over fd 3: the HUD and custom passes", { ...NEEDS, timeout: SUITE_TIMEOUT_MS }, () => {
  it("names a widget the UI drew in hud.items and paints it into the capture", async () => {
    const run = await startRun();
    await run.port.ready();
    await run.port.call(NativeOp.Seed, { seed: 3 });
    const plain = await run.port.call(NativeOp.Capture, {});
    assert.deepEqual((await stateOf(run)).hud, { items: [], crosshair: false, flash: 0 });
    await run.port.call(NativeOp.Input, { actions: [{ type: "down", keys: ["KeyH"] }] });
    await run.port.call(NativeOp.Step, { ms: TICK_MS });
    const hud = (await stateOf(run)).hud as { items: string[] };
    assert.deepEqual(hud.items, ["Shop"], "a check finds the button by its label");
    const shown = await run.port.call(NativeOp.Capture, {});
    assert.notEqual(shown.digest, plain.digest, "the HUD is in the capture, as the player sees it");
  });

  it("reports what the GPU encoded under volatile.gpu, apart from the logical drawCalls, once a frame is drawn", async () => {
    const run = await startRun();
    await run.port.ready();
    await run.port.call(NativeOp.Step, { ms: TICK_MS });
    await run.port.call(NativeOp.Capture, {});
    const state = await stateOf(run);
    const gpu = (state.volatile as Record<string, unknown>).gpu as Record<string, unknown> | undefined;
    assert.ok(gpu, `volatile.gpu after a drawn frame: ${JSON.stringify(state.volatile)}`);
    for (const key of ["encoderDraws", "dispatches", "passes"])
      assert.ok(Number.isInteger(gpu[key]) && Number(gpu[key]) >= 0, `${key}: ${JSON.stringify(gpu)}`);
    assert.ok(Number(gpu.passes) >= 1, "the world pass at least");
  });

  it("says in its capture which camera it drew from, and the provenance keeps the game's word", async () => {
    const run = await startRun();
    await run.port.ready();
    const shot = await run.port.screenshotWithStats();
    assert.equal(shot.provenance.camera, "default");
  });

  it("lists a refused custom pass in volatile.customPasses with gpu-pass-invalid, and draws on without it", async () => {
    const run = await startRun();
    await run.port.ready();
    const passes = nativeCustomPasses(await stateOf(run));
    assert.deepEqual(passes, [{ name: "broken", stage: "post", running: false, code: NativeRefusal.GpuPassInvalid }]);
    const stepped = await run.port.call(NativeOp.Step, { ms: TICK_MS });
    assert.equal(stepped.drawCalls, 1, "a refused pass is no draw");
    const render = (await stateOf(run)).__render as { tags: Record<string, unknown> };
    assert.equal(render.tags.custom, undefined, "and no custom-tagged draw");
    await run.port.call(NativeOp.Capture, {});
    assert.equal(run.port.failure, null);
  });
});

describe("the Rust runtime over fd 3: verbs", { ...NEEDS, timeout: SUITE_TIMEOUT_MS }, () => {
  it("takes keys and touches, places cameras and eyes, runs demos paused, and answers the meters", async () => {
    const run = await startRun();
    await run.port.ready();
    await run.port.call(NativeOp.Seed, { seed: 1 });
    await run.port.input([{ type: "down", keys: ["KeyD"] }]);
    await run.port.call(NativeOp.Step, { ms: 6 * TICK_MS });
    await run.port.input([{ type: "up", keys: ["KeyD"] }]);
    assert.equal((await stateOf(run)).x, 6, "KeyD held for six ticks");
    const touch = { type: "touch", phase: TouchPhase.Start, id: 5, x: 40, y: 20 } as const;
    await run.port.call(NativeOp.Input, { actions: [touch] });
    await run.port.call(NativeOp.Step, { ms: TICK_MS });
    assert.deepEqual((await stateOf(run)).touch, { id: 5, phase: "Began", x: 40, y: 20 }, "a touch in world pixels");
    assert.deepEqual(await run.port.call(NativeOp.Cameras), { cameras: ["default", "top"] });
    assert.deepEqual(await run.port.call(NativeOp.Eyes), { eyes: ["eye:spawn"] });
    assert.deepEqual(await run.port.call(NativeOp.Demos), { demos: ["walk", "crash"] });
    assert.deepEqual(await run.port.call(NativeOp.DebugCamera, { camera: "sky" }), {
      ok: false,
      available: ["default", "top"],
    });
    assert.deepEqual(await run.port.call(NativeOp.DebugCamera, { camera: "eye:spawn" }), {
      ok: true,
      camera: "eye:spawn",
    });
    assert.equal((await stateOf(run)).camera, "eye:spawn");
    await run.port.call(NativeOp.DebugCamera, { camera: "default" });
    await run.port.call(NativeOp.Start);
    const walked = await run.port.call(NativeOp.Demo, { name: "walk" });
    assert.deepEqual(walked, { ok: true, demo: "walk", result: { x: 12 } });
    assert.equal((await stateOf(run)).running, false, "a demo ends paused");
    assert.deepEqual(await run.port.call(NativeOp.Demo, { name: "fly" }), { ok: false, available: ["walk", "crash"] });
    assert.deepEqual(await run.port.call(NativeOp.Audio, { muted: true }), { muted: true });
    assert.deepEqual(await run.port.call(NativeOp.AudioLevel), { rms: 0, centroid: 0 });
    assert.ok((await run.port.call(NativeOp.Timing)).frames >= 1, "live frames were timed");
    assert.deepEqual(await run.port.call(NativeOp.Front), { fronted: false }, "a headless run has no window");
    assert.deepEqual(await run.port.call(NativeOp.Visible, { visible: true }), { visible: true });
    assert.equal(run.port.failure, null);
  });

  // GA round 2: a held key on a native run went down and up in one tick (the runtime leaves timed
  // actions to the host, which sent them on as they were). The port now plays the hold itself.
  it("a hold through the port keeps its key down on a live run for the hold's ticks, not one", async () => {
    const run = await startRun();
    await run.port.ready();
    const before = Number((await stateOf(run)).x);
    await run.port.input([{ type: "hold", keys: ["KeyD"], ms: 500 }]);
    const moved = Number((await stateOf(run)).x) - before;
    // 500 ms is 30 ticks at 60 Hz; a third of them leaves room for a loaded machine, one tick is the defect.
    assert.ok(moved >= 10, `KeyD was held for ${moved} ticks`);
    assert.equal(run.port.failure, null);
  });

  it("a positioned click through the port reaches an egui button on a live run, and one beside it does not", async () => {
    const run = await startRun();
    await run.port.ready();
    // The fixture's Shop button covers world pixels (8, 8) to (48, 28) of its 96 x 64 world.
    const shop = { x: 28 / 96, y: 18 / 64 };
    await run.port.input([
      { type: "tap", keys: ["KeyH"] },
      { type: "wait", ms: 100 },
      { type: "click", ...shop },
      { type: "wait", ms: 100 },
      { type: "click", x: 0.75, y: 0.75 },
      { type: "wait", ms: 100 },
    ]);
    const state = await stateOf(run);
    assert.deepEqual((state.hud as { items: string[] }).items, ["Shop"]);
    assert.equal(state.shopClicks, 1, "the click on the button, not the one on the scene");
  });

  it("answers an op it does not serve with unknown-op and the ops a native run serves", async () => {
    const run = await startRaw();
    const reply = await run.ask({ op: "teleport" });
    assert.equal(reply.error, NativeOpError.UnknownOp);
    assert.deepEqual(reply.available, [...NATIVE_OPS, ...EMBED_OPS, ...ASSET_TOOL_OPS].sort());
    const timed = await run.ask({ op: NativeOp.Input, arg: { actions: [{ type: "hold", keys: ["KeyD"], ms: 100 }] } });
    assert.deepEqual(timed.result, { held: [], ignored: 1 }, "a timed action is the host's to expand");
  });
});

describe("the Rust runtime over fd 3: captures", { ...NEEDS, timeout: SUITE_TIMEOUT_MS }, () => {
  it("captures top-down BGRA into <state>/captures/<seq>.bgra with the FNV-1a 64 the host recomputes", async () => {
    const run = await startRun();
    await run.port.ready();
    const shot = await run.port.call(NativeOp.Capture, {});
    assert.deepEqual(
      [shot.seq, shot.width, shot.height, shot.format],
      [1, WORLD.width, WORLD.height, NATIVE_CAPTURE_FORMAT],
    );
    const bytes = await readFile(path.join(run.stateDir, "captures", "1.bgra"));
    assert.equal(bytes.length, WORLD.width * WORLD.height * 4);
    assert.equal(fnv1a64Hex(bytes), shot.digest);
    const red = redRows(bytes, WORLD.width, WORLD.height);
    assert.ok(red.above > 0 && red.below === 0, `the cube above the middle, top row first: ${JSON.stringify(red)}`);
    const stats = (await run.port.screenshotWithStats()).stats;
    assert.ok(stats.litFraction > 0, "a non-blank capture the host read");
    const top = await run.port.call(NativeOp.Capture, { camera: "top" });
    assert.notEqual(top.digest, shot.digest, "the top camera draws another frame");
    assert.equal(await refusedWith(run.port.call(NativeOp.Capture, { camera: "sky" })), GameRefusal.UnknownCamera);
  });

  it("keeps only its last eight capture files: the host never deletes in state/ while the game runs", async () => {
    const run = await startRun();
    await run.port.ready();
    for (let shots = 0; shots < CAPTURES_KEPT + 2; shots++) await run.port.call(NativeOp.Capture, {});
    assert.deepEqual(await captureFiles(run.stateDir), [
      "10.bgra",
      "3.bgra",
      "4.bgra",
      "5.bgra",
      "6.bgra",
      "7.bgra",
      "8.bgra",
      "9.bgra",
    ]);
  });

  it("refuses capture with no-state-dir when GENEX_STATE_DIR is absent, empty, relative or climbs, and writes nothing", async () => {
    for (const state of [null, "", "state", "/tmp/../tmp/x/../../.."]) {
      const run = await startRun({ state });
      await run.port.ready();
      assert.equal(await refusedWith(run.port.call(NativeOp.Capture, {})), GameRefusal.NoStateDir, String(state));
      assert.deepEqual(await readdir(run.cwd), [], "nothing in the working folder");
      assert.deepEqual(await captureFiles(run.stateDir), []);
      assert.equal(run.port.failure, null, "the game keeps running");
    }
  });
});

describe("the Rust runtime over fd 3: saves", { ...NEEDS, timeout: SUITE_TIMEOUT_MS }, () => {
  it("saves under the run's state/ and loads the save back on the next seed", async () => {
    const run = await startRun();
    await run.port.ready();
    await run.port.call(NativeOp.Seed, { seed: 1 });
    await run.port.input([{ type: "down", keys: ["KeyD"] }]);
    await run.port.call(NativeOp.Step, { ms: 3 * TICK_MS });
    await run.port.input([
      { type: "up", keys: ["KeyD"] },
      { type: "tap", keys: ["KeyS"] },
    ]);
    await run.port.call(NativeOp.Step, { ms: TICK_MS });
    assert.equal(await readFile(path.join(run.stateDir, "progress", "best.txt"), "utf8"), "3");
    assert.deepEqual((await stateOf(run)).saves, { written: 1, loaded: "" });
    await run.port.call(NativeOp.Seed, { seed: 2 });
    assert.deepEqual((await stateOf(run)).saves, { written: 0, loaded: "3" }, "the reset loaded the save");
  });

  it("without a trustworthy state folder a save is refused and nothing is written anywhere", async () => {
    const run = await startRun({ state: "relative/state" });
    await run.port.ready();
    await run.port.input([{ type: "tap", keys: ["KeyS"] }]);
    await run.port.call(NativeOp.Step, { ms: TICK_MS });
    assert.deepEqual((await stateOf(run)).saves, { written: 0, loaded: "" });
    assert.deepEqual(await readdir(run.cwd), []);
    assert.deepEqual(await readdir(run.stateDir), []);
  });
});

describe("the Rust runtime over fd 3: Live's ring ops on a run Live does not embed", {
  ...NEEDS,
  timeout: SUITE_TIMEOUT_MS,
}, () => {
  it("refuses hostile surface arguments before it looks for a frames service, and makes no ring", async () => {
    const run = await startRaw();
    const hostile: unknown[] = [
      {},
      { w: 0, h: 64, dpr: 1, slots: 3, generation: 1 },
      { w: 96, h: 64, dpr: 9, slots: 3, generation: 1 },
      { w: 96, h: 64, dpr: 1, slots: 4, generation: 1 },
      { w: 96, h: 64, dpr: 1, slots: 3, generation: 0 },
    ];
    for (const arg of [...hostile, undefined, [96, 64]]) {
      const reply = await run.ask({ op: NativeOp.Surface, arg });
      assert.equal(reply.error, GameRefusal.BadArgument, JSON.stringify(arg));
    }
    const state = await run.ask({ op: NativeOp.State });
    assert.equal((state.result as Record<string, unknown>).seed, 1, "the game keeps running");
  });

  it("answers surface with no frames service when it is not embedded or the service is not its run's", async () => {
    const environments: Array<Record<string, string>> = [
      {},
      { GENEX_FRAMES_SERVICE: "games.genex.frames.not-this-run-0000" },
    ];
    for (const env of environments) {
      const run = await startRun({ env });
      await run.port.ready();
      const arg = { w: 96, h: 64, dpr: 1, slots: 3, generation: 1 };
      assert.equal(await refusedWith(run.port.call(NativeOp.Surface, arg)), GameRefusal.NoFramesService);
      assert.deepEqual(await run.port.call(NativeOp.Release, { slot: 0, generation: 1 }), {});
      assert.equal((await stateOf(run)).seed, 1, "the game keeps running");
    }
  });
});

describe("the Rust runtime over fd 3: the way out", { ...NEEDS, timeout: SUITE_TIMEOUT_MS }, () => {
  it("answers quit, then exits 0", async () => {
    const run = await startRun();
    await run.port.ready();
    assert.deepEqual(await run.port.call(NativeOp.Quit), { quitting: true });
    assert.deepEqual(await exitOf(run), { code: 0, signal: null });
  });

  it("exits 0 when the studio closes fd 3", async () => {
    const run = await startRun();
    await run.port.ready();
    run.child.fd3.end();
    assert.deepEqual(await exitOf(run), { code: 0, signal: null });
  });

  it("sends fatal and exits non-zero when the game panics", async () => {
    const run = await startRun();
    await run.port.ready();
    const crashed = await run.port.call(NativeOp.Demo, { name: "crash" }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(crashed instanceof NativeExitError, `the call ends with the game, got ${String(crashed)}`);
    assert.deepEqual(
      run.events.filter((event) => event.event === NativeEvent.Fatal),
      [{ event: NativeEvent.Fatal, reason: "terminate" }],
    );
    assert.notEqual((await exitOf(run)).code, 0);
  });
});

describe("the Rust runtime over fd 3: touch synthesis", { ...NEEDS, timeout: SUITE_TIMEOUT_MS }, () => {
  /** A harness ctx whose preview calls reach the run the way the host's preview RPC routes them. */
  const hostCtx = (run: Run) => ({
    cancelled: false,
    call: async (method: string, payload: Record<string, unknown> = {}) => {
      if (method === "preview.input") return routePreviewInput(run.port, payload.actions as never);
      if (method === "preview.call") return run.port.studioCall(String(payload.method), payload.arg);
      throw new Error(`unexpected ${method}`);
    },
  });

  /** A seeded, paused run with the play-script ctx on it. */
  async function touchRun() {
    const run = await startRun();
    await run.port.ready();
    await run.port.call(NativeOp.Seed, { seed: 1 });
    return { run, ctx: hostCtx(run) };
  }

  it("a play script's touch tap changes the touch-only probe; a key tap and a hold do not", async () => {
    const { run, ctx } = await touchRun();
    await applyPlayScript(
      ctx as never,
      [
        { type: "tap", keys: ["space"] },
        { type: "hold", keys: ["KeyD"], ms: 100 },
      ],
      { clock: "step" },
    );
    assert.equal((await stateOf(run)).taps, 0, "no key reaches the touch control");
    const played = await applyPlayScript(ctx as never, [{ type: "touch", x: 48, y: 32 }], { clock: "step" });
    assert.equal(played.refused, 0, "a contract v2 run takes the touch");
    const state = await stateOf(run);
    assert.equal(state.taps, 1, "one tap, measured by the probe");
    assert.deepEqual(state.touch, { id: 1, phase: "Ended", x: 48, y: 32 }, "the script's finger, in world pixels");
    assert.equal(run.port.failure, null);
  });

  it("a play script's swipe lifts where it ends", async () => {
    const { run, ctx } = await touchRun();
    await applyPlayScript(ctx as never, [{ type: "touch", x: 10, y: 50, toX: 80, toY: 10, ms: 200 }], {
      clock: "step",
    });
    const state = await stateOf(run);
    assert.equal(state.taps, 1);
    assert.deepEqual(state.touch, { id: 1, phase: "Ended", x: 80, y: 10 });
  });

  it("a play script's click reaches the touch-only control as touch 0: desktop mouse-to-touch emulation", async () => {
    const { run, ctx } = await touchRun();
    await applyPlayScript(ctx as never, [{ type: "click", x: 0.5, y: 0.5 }], { clock: "step" });
    const state = await stateOf(run);
    assert.equal(state.taps, 1, "Mouse1 is touch 0");
    assert.equal(state.touch, null, "and no script finger: touch 0 is the mouse's");
  });
});
