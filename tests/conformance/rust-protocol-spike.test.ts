/**
 * The Rust runtime's studio protocol (M0a.3 spike): genex-studio's fd-3 transport, verb dispatcher
 * and Stop, proven against the host's own code. The spike game (`native/genex-rust/crates/
 * genex-studio/examples/studio-spike.rs`, built here with the pinned spike toolchain) is started by
 * the fake host (`tests/fixtures/rust-fake-host.mjs`) exactly as `spawnGame` starts a game, and
 * spoken to by the real `NativeGamePort` and stopped by the real `NativeRuns`, as
 * `native-real.test.ts` does for the C++ game: the handshake, every v1 verb, the capture file
 * contract and the stop escalation within `NATIVE_STOP_BUDGET_MS`. Each hostile row is refused
 * with its v1 typed code and leaves no side effect; no row leaves a process in the game's group.
 *
 * The game box (the Seatbelt profile around the Rust game) is M0b's. The rows need the installed
 * spike toolchain (`scripts/spike/rust-wgpu/setup-toolchain.sh`): they skip without it, and
 * `GENEX_REQUIRE_SPIKE_TOOLCHAIN=1` turns that skip into a failure. POSIX only (fd 3 and groups).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import {
  NATIVE_LINE_MAX_BYTES,
  NATIVE_QUIT_GRACE_MS,
  NATIVE_READY_TIMEOUT_MS,
  NATIVE_STOP_BUDGET_MS,
  NATIVE_TERM_GRACE_MS,
  NativeError,
  NativeEvent,
  type NativeEventMessage,
  NativeOp,
  NativeRefusal,
  NativeRunMode,
  NativeRunState,
  type NativeRunStatus,
  type NativeTimers,
} from "../../src/shared/native-contract.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { witnessOf } from "../../src/main/harness-rpc/preview.ts";
import { NativeRuns, type NativeRunsOptions } from "../../src/main/core/native-runs.ts";
import { NativeExitError, NativeGamePort, NativeOpRefusedError } from "../../src/substrate/native-game-port.ts";
import type { GameChild, GameSpawnRequest } from "../../src/substrate/spawn.ts";
import { groupAlive, lineReader, startGame } from "../fixtures/rust-fake-host.mjs";
import { tmpDir } from "../helpers/tmp.ts";
// Starts real games on the GPU: the runners run this file one at a time (gpu-games.ts).
import "../helpers/gpu-games.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
/** The cargo env helper: the pinned sysroot, the vendored crates and the genex workspace manifest. */
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");
const SPIKE_CARGO = path.join(REPO, ".studio-dev", "spike-toolchain", "sysroot", "bin", "cargo");
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? path.join(REPO, ".studio-dev", "cargo-target");
const SPIKE_GAME = path.join(TARGET_DIR, "debug", "examples", "studio-spike");
/** The pond sample's dev flavour: the genex facade's `Runtime` served by genex-studio (feature `studio`). */
const POND_GAME = path.join(TARGET_DIR, "debug", "pond");
/** The pond's world target (`pond_game::WORLD_SIZE`). */
const POND_WORLD = { width: 960, height: 540 };
/** A warm build is seconds; a cold one compiles genex-core too. */
const BUILD_TIMEOUT_MS = 10 * MINUTE_MS;
const BUILD_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const NONCE = "rust-spike-n0nce";
/** The spike game's world target (its default). */
const WORLD = { width: 64, height: 36 };
/** One fake-clock step while a real process runs, and the real pause after it for its I/O to land. */
const FAKE_STEP_MS = 250;
const REAL_PAUSE_MS = 25;
/** How long a row polls for a real process to leave its group after its exit. */
const GROUP_EMPTY_WAIT_MS = 2000;
const GROUP_POLL_MS = 20;
/** The game's own refusal codes (`VerbRefusal` in genex-studio). Wire values. */
const GameRefusal = {
  UnknownCamera: "unknown-camera",
  CaptureTooLarge: "capture-too-large",
  LineTooLong: "line-too-long",
} as const;

const toolchainOptions = (): { skip?: string } => {
  if (process.platform === "win32") return { skip: "not run: fd 3 and process groups are POSIX" };
  if (existsSync(SPIKE_CARGO)) return {};
  if (process.env.GENEX_REQUIRE_SPIKE_TOOLCHAIN === "1") {
    throw new Error(`GENEX_REQUIRE_SPIKE_TOOLCHAIN=1: no spike toolchain at ${SPIKE_CARGO}`);
  }
  return { skip: "not run: the spike toolchain is not installed" };
};
const NEEDS_TOOLCHAIN = toolchainOptions();
/** The pond renders headless on the host GPU: Metal, so its rows run on a Mac. */
const NEEDS_POND_GPU: { skip?: string } =
  NEEDS_TOOLCHAIN.skip || process.platform === "darwin"
    ? NEEDS_TOOLCHAIN
    : { skip: "not run: the pond renders on the host GPU (Metal on the Mac)" };

const isTimeout = (handle: unknown): handle is NodeJS.Timeout => typeof handle === "object" && handle !== null;

/** The real clock. */
const REAL_TIMERS: NativeTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => {
    if (isTimeout(handle)) clearTimeout(handle);
  },
};

/** A clock the row moves by hand, while the real process behind it runs in real time. */
function fakeClock() {
  let now = 0;
  const due: Array<{ at: number; run: () => void }> = [];
  const timers: NativeTimers = {
    now: () => now,
    setTimeout: (run, ms) => {
      const timer = { at: now + ms, run };
      due.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      const index = due.findIndex((timer) => timer === handle);
      if (index >= 0) due.splice(index, 1);
    },
  };
  /** Moves the clock one step, runs what fell due, and lets real I/O land. */
  const step = async () => {
    now += FAKE_STEP_MS;
    due.sort((a, b) => a.at - b.at);
    while (due[0] && due[0].at <= now) due.shift()?.run();
    await sleep(REAL_PAUSE_MS);
  };
  return { timers, step, now: () => now };
}

/** Whether the game's group emptied within `GROUP_EMPTY_WAIT_MS` (a reaped game's group goes at once). */
async function groupEmptied(pgid: number): Promise<boolean> {
  for (let waited = 0; waited < GROUP_EMPTY_WAIT_MS; waited += GROUP_POLL_MS) {
    if (!groupAlive(pgid)) return true;
    await sleep(GROUP_POLL_MS);
  }
  return !groupAlive(pgid);
}

async function captureFiles(stateDir: string): Promise<string[]> {
  const names = await readdir(path.join(stateDir, "captures")).catch(() => []);
  return names.sort();
}

/** One spike game started by the fake host and a port on it. */
interface SpikeRun {
  port: NativeGamePort;
  child: GameChild;
  pid: number;
  stateDir: string;
  /** SIGKILL to the group if it still runs; then the group must be empty. */
  stop(): Promise<void>;
}

/** One spike game started by the fake host with no port: the row reads and writes fd 3 itself. */
async function rawGame(args: string[] = []) {
  const stateDir = await realpath(await tmpDir("rust-spike-raw-"));
  const game = await startGame({ exe: SPIKE_GAME, args, nonce: NONCE, stateDir });
  const lines = lineReader(game.child.fd3);
  const send = (request: Record<string, unknown>) => game.child.fd3.write(`${JSON.stringify(request)}\n`);
  const stop = async () => {
    game.child.kill("SIGKILL");
    await game.exited;
    assert.ok(await groupEmptied(game.pid), "nothing left in the game's group");
  };
  return { child: game.child, lines, send, stop };
}

async function spikeGame(
  options: { args?: string[]; gameNonce?: string; timers?: NativeTimers; exe?: string } = {},
): Promise<SpikeRun> {
  const stateDir = await realpath(await tmpDir("rust-spike-state-"));
  const exe = options.exe ?? SPIKE_GAME;
  const game = await startGame({ exe, args: options.args, nonce: options.gameNonce ?? NONCE, stateDir });
  const port = new NativeGamePort({
    child: game.child,
    nonce: NONCE,
    mode: NativeRunMode.Headless,
    stateDir,
    timers: options.timers ?? REAL_TIMERS,
    encodeJpeg: async () => Buffer.from("jpeg"),
  });
  const stop = async () => {
    game.child.kill("SIGKILL");
    await game.exited;
    assert.ok(await groupEmptied(game.pid), "nothing left in the game's group");
  };
  return { port, child: game.child, pid: game.pid, stateDir, stop };
}

/** The game's `{ok: false}` code for a call that was refused. */
async function refusedWith(call: Promise<unknown>): Promise<string> {
  const error = await call.then(
    () => null,
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof NativeOpRefusedError, `refused by the game, got ${String(error)}`);
  return error.gameError;
}

/** The host's typed refusal a call rejected with. */
async function nativeRefusal(call: Promise<unknown>): Promise<NativeRefusal> {
  const error = await call.then(
    () => null,
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof NativeError, `a NativeError, got ${String(error)}`);
  return error.refusal;
}

before(async () => {
  if (NEEDS_TOOLCHAIN.skip) return;
  await execFileAsync(
    process.execPath,
    [RUST_ENV, "--", "cargo", "build", "-p", "genex-studio", "--example", "studio-spike", "--offline", "--locked"],
    { cwd: REPO, timeout: BUILD_TIMEOUT_MS, maxBuffer: BUILD_OUTPUT_MAX_BYTES },
  );
});

describe("the Rust spike game over the host's NativeGamePort: handshake and verbs", NEEDS_TOOLCHAIN, () => {
  it("is ready with this run's nonce, seeds and steps deterministically, and quits with exit 0", async () => {
    const run = await spikeGame();
    try {
      const ready = await run.port.ready();
      assert.equal(ready.nonce, NONCE);
      assert.equal(ready.protocol, 1);
      assert.equal(ready.contractVersion, 1);
      assert.deepEqual(ready.size, WORLD);
      assert.equal(ready.seed, 1);
      assert.match(ready.build, /^genex-rust-spike\//);
      assert.deepEqual(await run.port.call(NativeOp.Seed, { seed: 7 }), { seed: 7, paused: true });
      const stepped = await run.port.call(NativeOp.Step, { ms: 1000 });
      assert.equal(stepped.steppedFrames, 60);
      assert.equal(stepped.frame, 60);
      const first = (await run.port.studioState()) as Record<string, unknown>;
      assert.equal(first.seed, 7);
      assert.equal(first.frame, 60);
      assert.equal(first.running, false, "seed pauses the game");
      assert.match(String(first.checksum), /^[0-9a-f]{16}$/);
      await run.port.call(NativeOp.Seed, { seed: 7 });
      await run.port.call(NativeOp.Step, { ms: 1000 });
      const replay = (await run.port.studioState()) as Record<string, unknown>;
      assert.equal(replay.checksum, first.checksum, "the same seed and steps replay the same state");
      await run.port.call(NativeOp.Seed, { seed: 8 });
      await run.port.call(NativeOp.Step, { ms: 1000 });
      const other = (await run.port.studioState()) as Record<string, unknown>;
      assert.notEqual(other.checksum, first.checksum, "another seed is another run");
      assert.deepEqual(await run.port.call(NativeOp.Quit), { quitting: true });
      assert.deepEqual(await run.child.exited, { code: 0, signal: null });
      assert.ok(await groupEmptied(run.pid), "nothing left in the game's group");
    } finally {
      await run.stop();
    }
  });

  it("takes input, places cameras and eyes, runs demos paused, and answers the meters", async () => {
    const run = await spikeGame();
    try {
      await run.port.ready();
      await run.port.call(NativeOp.Seed, { seed: 7 });
      const applied = await run.port.input([{ type: "down", keys: ["KeyD"] }]);
      assert.deepEqual(applied, { ok: true, applied: 1, ...WORLD });
      await run.port.call(NativeOp.Step, { ms: 100 });
      assert.equal(((await run.port.studioState()) as Record<string, unknown>).x, 6, "KeyD held for six ticks");
      await run.port.input([{ type: "up", keys: ["KeyD"] }]);
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
      assert.equal(((await run.port.studioState()) as Record<string, unknown>).camera, "eye:spawn");
      await run.port.call(NativeOp.DebugCamera, { camera: null });
      await run.port.call(NativeOp.Start);
      const walked = await run.port.call(NativeOp.Demo, { name: "walk" });
      assert.equal(walked.ok, true);
      assert.equal(walked.demo, "walk");
      const afterDemo = (await run.port.studioState()) as Record<string, unknown>;
      assert.equal(afterDemo.running, false, "a demo ends paused");
      assert.deepEqual(await run.port.call(NativeOp.Demo, { name: "fly" }), {
        ok: false,
        available: ["walk", "crash"],
      });
      assert.deepEqual(await run.port.call(NativeOp.Audio, { muted: true }), { muted: true });
      assert.deepEqual(await run.port.call(NativeOp.AudioLevel), { rms: 0, centroid: 0 });
      const timing = await run.port.call(NativeOp.Timing);
      assert.ok(timing.frames >= 1, "live frames were timed");
      assert.deepEqual(await run.port.call(NativeOp.Front), { fronted: false });
      assert.deepEqual(await run.port.call(NativeOp.Visible, { visible: true }), { visible: true });
      assert.equal(run.port.failure, null);
    } finally {
      await run.stop();
    }
  });
});

describe("the Rust spike game over the host's NativeGamePort: captures and fatal", NEEDS_TOOLCHAIN, () => {
  it("writes captures the host reads and digest-checks, per camera, keeping the last eight", async () => {
    const run = await spikeGame();
    try {
      await run.port.ready();
      const shot = await run.port.screenshotWithStats();
      assert.equal(shot.stats.width, WORLD.width);
      assert.equal(shot.stats.height, WORLD.height);
      assert.ok(shot.stats.litFraction > 0, "a non-blank capture");
      const own = await run.port.call(NativeOp.Capture, {});
      const top = await run.port.call(NativeOp.Capture, { camera: "top" });
      assert.notEqual(top.digest, own.digest, "the top camera draws another frame");
      assert.equal(await refusedWith(run.port.call(NativeOp.Capture, { camera: "sky" })), GameRefusal.UnknownCamera);
      for (let shots = 0; shots < 8; shots++) await run.port.screenshotWithStats();
      assert.deepEqual(
        await captureFiles(run.stateDir),
        ["10.bgra", "11.bgra", "4.bgra", "5.bgra", "6.bgra", "7.bgra", "8.bgra", "9.bgra"],
        "the last eight captures are kept",
      );
    } finally {
      await run.stop();
    }
  });

  it("a panic sends fatal before the game exits", async () => {
    const run = await spikeGame();
    try {
      const events: NativeEventMessage[] = [];
      run.port.onEvent((event) => events.push(event));
      await run.port.ready();
      const crashed = await run.port.call(NativeOp.Demo, { name: "crash" }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(crashed instanceof NativeExitError, `the call ends with the game, got ${String(crashed)}`);
      assert.deepEqual(
        events.filter((event) => event.event === NativeEvent.Fatal),
        [{ event: NativeEvent.Fatal, reason: "terminate" }],
      );
      assert.notEqual((await run.child.exited).code, 0);
      assert.equal(run.port.status().crashed, true);
    } finally {
      await run.stop();
    }
  });
});

describe("hostile protocol input on a raw fd 3", NEEDS_TOOLCHAIN, () => {
  it("a request line past NATIVE_LINE_MAX_BYTES is answered line-too-long and runs nothing", async () => {
    const run = await rawGame();
    try {
      assert.equal((await run.lines.next()).event, NativeEvent.Ready);
      run.send({ id: 1, op: NativeOp.Seed, arg: { seed: 9, pad: "x".repeat(NATIVE_LINE_MAX_BYTES) } });
      run.send({ id: 2, op: NativeOp.State });
      assert.deepEqual(await run.lines.next(), { id: null, ok: false, op: null, error: GameRefusal.LineTooLong });
      const state = await run.lines.next();
      assert.equal(state.id, 2);
      assert.equal((state.result as Record<string, unknown>).seed, 1, "the long line's seed never ran");
    } finally {
      await run.stop();
    }
  });

  it("a verb sent before ready waits and is answered after ready, in order, as v1's transport does", async () => {
    const run = await rawGame(["--boot-ms", "1500"]);
    try {
      run.send({ id: 1, op: NativeOp.Seed, arg: { seed: 9 } });
      run.send({ id: 2, op: NativeOp.State });
      assert.equal((await run.lines.next()).event, NativeEvent.Ready, "ready comes first");
      assert.deepEqual(await run.lines.next(), {
        id: 1,
        ok: true,
        op: NativeOp.Seed,
        result: { seed: 9, paused: true },
      });
      const state = await run.lines.next();
      assert.equal(state.id, 2);
      assert.equal((state.result as Record<string, unknown>).seed, 9, "the early seed ran after ready");
    } finally {
      await run.stop();
    }
  });

  it("a process the game spawns does not inherit the studio's descriptor 3", async () => {
    const run = await rawGame(["--probe-child-fd"]);
    try {
      assert.equal((await run.lines.next()).event, NativeEvent.Ready);
      run.send({ id: 1, op: NativeOp.State });
      const state = await run.lines.next();
      assert.equal((state.result as Record<string, unknown>).childFd3, "closed", "fd 3 is close-on-exec");
    } finally {
      await run.stop();
    }
  });
});

describe("hostile protocol input through the host's NativeGamePort", NEEDS_TOOLCHAIN, () => {
  it("the host refuses to send a request past NATIVE_LINE_MAX_BYTES, and the game is untouched", async () => {
    const run = await spikeGame();
    try {
      await run.port.ready();
      const tooLong = await run.port.call(NativeOp.Demo, { name: "x".repeat(NATIVE_LINE_MAX_BYTES) }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(tooLong instanceof Error && !(tooLong instanceof NativeError), "refused before anything is sent");
      assert.equal(((await run.port.studioState()) as Record<string, unknown>).seed, 1);
      assert.equal(run.port.failure, null);
    } finally {
      await run.stop();
    }
  });

  it("a ready for another nonce is refused bad-handshake and the game is killed", async () => {
    const run = await spikeGame({ gameNonce: "another-run" });
    try {
      assert.equal(await nativeRefusal(run.port.ready()), NativeRefusal.BadHandshake);
      assert.equal(run.port.failure, NativeRefusal.BadHandshake);
      assert.equal((await run.child.exited).signal, "SIGKILL");
      assert.ok(await groupEmptied(run.pid), "nothing left in the game's group");
      assert.deepEqual(await captureFiles(run.stateDir), []);
    } finally {
      await run.stop();
    }
  });

  it("a nonce past MAX_NONCE_BYTES opens no transport: no ready, refused ready-timeout", async () => {
    const clock = fakeClock();
    const run = await spikeGame({ gameNonce: "n".repeat(257), timers: clock.timers });
    try {
      const handshake = run.port.ready();
      while (clock.now() <= NATIVE_READY_TIMEOUT_MS && run.port.failure === null) await clock.step();
      assert.equal(await nativeRefusal(handshake), NativeRefusal.ReadyTimeout);
      assert.equal((await run.child.exited).signal, "SIGKILL");
    } finally {
      await run.stop();
    }
  });

  it("through the port, a verb sent before ready resolves after ready", async () => {
    const run = await spikeGame({ args: ["--boot-ms", "1500"] });
    try {
      const early = run.port.call(NativeOp.Seed, { seed: 9 });
      await run.port.ready();
      assert.deepEqual(await early, { seed: 9, paused: true });
      assert.equal(((await run.port.studioState()) as Record<string, unknown>).seed, 9, "the early seed ran");
      assert.equal(run.port.failure, null);
    } finally {
      await run.stop();
    }
  });

  // The game refuses a frame wider than NATIVE_CAPTURE_MAX_PX before it writes anything. A reply
  // that declared such a side would be the host's to refuse (reply-invalid, before any file read):
  // native-contract.test.ts holds that row over the host's validator.
  it("a capture side past NATIVE_CAPTURE_MAX_PX is refused capture-too-large by the game and writes nothing", async () => {
    const run = await spikeGame({ args: ["--oversize-capture"] });
    try {
      await run.port.ready();
      assert.equal(await refusedWith(run.port.screenshotWithStats()), GameRefusal.CaptureTooLarge);
      assert.deepEqual(await captureFiles(run.stateDir), []);
      assert.equal(run.port.failure, null, "the game keeps running");
      assert.equal(((await run.port.studioState()) as Record<string, unknown>).seed, 1);
    } finally {
      await run.stop();
    }
  });

  it("a reply past NATIVE_LINE_MAX_BYTES is refused reply-too-large and the game is killed", async () => {
    const run = await spikeGame({ args: ["--probe-bytes", String(2 * NATIVE_LINE_MAX_BYTES)] });
    try {
      await run.port.ready();
      assert.equal(await nativeRefusal(run.port.studioState()), NativeRefusal.ReplyTooLarge);
      assert.equal((await run.child.exited).signal, "SIGKILL");
      assert.ok(await groupEmptied(run.pid), "nothing left in the game's group");
    } finally {
      await run.stop();
    }
  });

  it("the studio's end of file ends the game with exit 0", async () => {
    const run = await spikeGame();
    try {
      await run.port.ready();
      run.child.fd3.end();
      assert.deepEqual(await run.child.exited, { code: 0, signal: null });
    } finally {
      await run.stop();
    }
  });
});

describe("the pond, a genex facade game, over the host's NativeGamePort", NEEDS_POND_GPU, () => {
  before(async () => {
    if (NEEDS_POND_GPU.skip) return;
    await execFileAsync(
      process.execPath,
      [RUST_ENV, "--", "cargo", "build", "-p", "pond", "--bin", "pond", "--offline", "--locked"],
      {
        cwd: REPO,
        timeout: BUILD_TIMEOUT_MS,
        maxBuffer: BUILD_OUTPUT_MAX_BYTES,
      },
    );
  });

  it("is ready, steps deterministically with the counters preview.witness reads, and quits with exit 0", async () => {
    const run = await spikeGame({ exe: POND_GAME });
    try {
      const ready = await run.port.ready();
      assert.equal(ready.nonce, NONCE);
      assert.deepEqual(ready.size, POND_WORLD);
      assert.equal(ready.seed, 1);
      assert.match(ready.build, /^genex-rust\//);
      assert.deepEqual(await run.port.call(NativeOp.Seed, { seed: 7 }), { seed: 7, paused: true });
      const witness = await witnessOf(run.port, 1000);
      assert.deepEqual([witness.frameBefore, witness.frameAfter], [0, 60]);
      assert.ok(witness.drawCalls > 0, "the step answers the pond's draw calls");
      const first = (await run.port.studioState()) as Record<string, unknown>;
      assert.equal(first.running, false, "seed pauses the game");
      assert.match(String(first.checksum), /^[0-9a-f]{16}$/);
      assert.ok(typeof first.fishing === "object" && first.fishing !== null, "the pond's own probe is in state()");
      await run.port.call(NativeOp.Seed, { seed: 7 });
      await run.port.call(NativeOp.Step, { ms: 1000 });
      const replay = (await run.port.studioState()) as Record<string, unknown>;
      assert.equal(replay.checksum, first.checksum, "the same seed and steps replay the same state");
      assert.deepEqual(await run.port.call(NativeOp.Demos), { demos: ["cast", "shop"] });
      const cast = await run.port.call(NativeOp.Demo, { name: "cast" });
      assert.equal(cast.ok, true);
      assert.equal(((await run.port.studioState()) as Record<string, unknown>).running, false, "a demo ends paused");
      assert.deepEqual(await run.port.call(NativeOp.Quit), { quitting: true });
      assert.deepEqual(await run.child.exited, { code: 0, signal: null });
      assert.ok(await groupEmptied(run.pid), "nothing left in the game's group");
    } finally {
      await run.stop();
    }
  });

  it("writes GPU captures the host reads and digest-checks, and refuses an unknown camera", async () => {
    const run = await spikeGame({ exe: POND_GAME });
    try {
      await run.port.ready();
      const shot = await run.port.screenshotWithStats();
      assert.deepEqual([shot.stats.width, shot.stats.height], [POND_WORLD.width, POND_WORLD.height]);
      assert.ok(shot.stats.litFraction > 0, "a non-blank capture");
      assert.equal(await refusedWith(run.port.call(NativeOp.Capture, { camera: "sky" })), GameRefusal.UnknownCamera);
      assert.deepEqual(await run.port.call(NativeOp.DebugCamera, { camera: "sky" }), {
        ok: false,
        available: ["default"],
      });
      assert.deepEqual(await captureFiles(run.stateDir), ["1.bgra"]);
      assert.equal(run.port.failure, null);
    } finally {
      await run.stop();
    }
  });
});

describe("Stop of the Rust spike game through the host's NativeRuns", NEEDS_TOOLCHAIN, () => {
  let root: string;
  before(async () => {
    root = path.join(await realpath(await tmpDir("rust-spike-runs-")), "native-runs");
    await mkdir(root, { recursive: true, mode: 0o700 });
  });

  /** A registry whose runs are the spike game in a fresh run dir, signals noted at the clock's time. */
  function registry(timers: NativeTimers, now: () => number, args: string[] = [], exe = SPIKE_GAME) {
    const statuses: NativeRunStatus[] = [];
    const signals: Array<[NodeJS.Signals, number]> = [];
    const options: NativeRunsOptions = {
      root,
      prepare: async (request) => {
        const runDir = path.join(root, request.runId);
        const state = path.join(runDir, "state");
        await mkdir(state, { recursive: true });
        return { runId: request.runId, runDir, exe, bundle: runDir, state, bundleId: null };
      },
      spawn: async (request: GameSpawnRequest) => {
        const game = await startGame({ exe: request.exe, args, nonce: request.nonce, stateDir: request.state });
        return {
          ...game.child,
          kill: (signal) => {
            signals.push([signal, now()]);
            game.child.kill(signal);
          },
        };
      },
      connect: (child, io) => new NativeGamePort({ ...io, child, encodeJpeg: async (bgra) => Buffer.from(bgra) }),
      emit: (event) => {
        if (event.type === UiEvent.NativeStatus) statuses.push(event.payload);
      },
      timers,
    };
    return { runs: new NativeRuns(options), statuses, signals };
  }

  it("quit ends a ready game with exit 0 inside the quit grace and empties its group", async () => {
    const { runs, statuses, signals } = registry(REAL_TIMERS, Date.now);
    const run = await runs.start({ project: "pond", target: BuildTarget.Mac, mode: NativeRunMode.Headless });
    const pid = run.status.pid;
    assert.ok(pid);
    assert.equal(run.status.state, NativeRunState.Ready);
    const from = Date.now();
    await runs.stop(run.status.runId);
    assert.ok(Date.now() - from < NATIVE_QUIT_GRACE_MS, "reaped before any signal was due");
    assert.deepEqual(signals, [], "quit alone ended it");
    assert.equal(statuses.at(-1)?.state, NativeRunState.Stopped);
    assert.deepEqual(statuses.at(-1)?.exit, { code: 0, signal: null });
    assert.ok(await groupEmptied(pid), "nothing left in the game's group");
  });

  it("a game that ignores quit and SIGTERM is sent SIGKILL after both graces and reaped inside the budget", async () => {
    const clock = fakeClock();
    const { runs, statuses, signals } = registry(clock.timers, clock.now, ["--stubborn"]);
    const run = await runs.start({ project: "pond", target: BuildTarget.Mac, mode: NativeRunMode.Headless });
    const pid = run.status.pid;
    assert.ok(pid);
    const from = clock.now();
    let stopped = false;
    const stopping = runs.stop(run.status.runId).then(() => {
      stopped = true;
    });
    while (!stopped && clock.now() - from <= 2 * NATIVE_STOP_BUDGET_MS) await clock.step();
    await stopping;
    const [term, kill] = signals;
    assert.deepEqual(
      signals.map(([signal]) => signal),
      ["SIGTERM", "SIGKILL"],
    );
    assert.ok(term && term[1] - from >= NATIVE_QUIT_GRACE_MS, "SIGTERM only after the quit grace");
    assert.ok(kill && kill[1] - from >= NATIVE_QUIT_GRACE_MS + NATIVE_TERM_GRACE_MS, "SIGKILL only after both graces");
    assert.ok(clock.now() - from <= NATIVE_STOP_BUDGET_MS + FAKE_STEP_MS, "reaped inside NATIVE_STOP_BUDGET_MS");
    const last = statuses.at(-1);
    assert.equal(last?.state, NativeRunState.Killed);
    assert.equal(last?.exit?.signal, "SIGKILL", "reaped by the kernel inside the reap margin");
    assert.ok(await groupEmptied(pid), "nothing left in the game's group");
  });
  it("the pond (a genex facade game) quits inside the quit grace and empties its group", NEEDS_POND_GPU, async () => {
    const { runs, statuses, signals } = registry(REAL_TIMERS, Date.now, [], POND_GAME);
    const run = await runs.start({ project: "pond", target: BuildTarget.Mac, mode: NativeRunMode.Headless });
    const pid = run.status.pid;
    assert.ok(pid);
    assert.equal(run.status.state, NativeRunState.Ready);
    const from = Date.now();
    await runs.stop(run.status.runId);
    assert.ok(Date.now() - from < NATIVE_QUIT_GRACE_MS, "reaped before any signal was due");
    assert.deepEqual(signals, [], "quit alone ended it");
    assert.deepEqual(statuses.at(-1)?.exit, { code: 0, signal: null });
    assert.ok(await groupEmptied(pid), "nothing left in the game's group");
  });
});
