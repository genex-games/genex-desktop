/**
 * The host's profile leg for native runs and Rust web pages (game-systems PROF-6):
 * `preview.profile` on a native lease answers a schema-1 sample (frame time from the game's frame
 * counter over a host-timed window, draws and triangles from its last drawn frame) instead of "no
 * profiler"; `preview.frameProfile` on a native and a Rust web lease answers the game's
 * `ProfileReport` v2 through the parser, which refuses an over-cap answer; a game that does not
 * serve the verb answers `unavailable` with its reason; the Live channel `studio:native.profile`
 * reads the run the person sees. Time is a fake clock: no row waits out a window.
 */
import assert from "node:assert/strict";
import { Duplex, PassThrough } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { describe, it } from "node:test";
import { answerNativeProfile } from "../../src/main/ipc/native-profile.ts";
import {
  FrameProfileAction,
  GpuTimeSource,
  GpuTimingMode,
  NodeTimingState,
  PROFILE_REPORT_FRAMES_MAX,
  ProfileUnavailableReason,
} from "../../src/shared/frame-profile.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import {
  NativeEvent,
  NativeLifecycle,
  NativeOp,
  NativeOpError,
  NativeRunMode,
  NativeRunState,
  type NativeTimers,
} from "../../src/shared/native-contract.ts";
import { SampleBackend } from "../../src/shared/optimization.ts";
import {
  NativeGamePort,
  NativeLeasePort,
  type NativeLeaseOptions,
  NativeOpRefusedError,
} from "../../src/substrate/native-game-port.ts";
import { previewFrameProfile, ProfileAnswerRefusedError } from "../../src/substrate/native-profile.ts";
import type { GameChild } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

const NONCE = "n0nce-profile";
const REVISION = { snapshotId: null, commit: "c0ffee", tree: "7ree" };
const SAMPLE_MS = 2000;
const TIMING_FRAMES = 1000;
/** Frames a 2 s window at 60 fps counts. */
const WINDOW_FRAMES = 120;

/** A clock that only moves when the row says so. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  const timers: NativeTimers = {
    now: () => now,
    setTimeout: (run, ms) => {
      seq += 1;
      due.set(seq, { at: now + ms, run });
      return seq;
    },
    clearTimeout: (handle) => {
      if (typeof handle === "number") due.delete(handle);
    },
  };
  return {
    timers,
    move: (ms: number) => {
      now += ms;
    },
  };
}

type Handler = (arg: unknown) => { result: unknown } | { error: string };

/** A game in memory that answers each op with its handler (or `unknown-op`), recording what it was sent. */
function answeringGame(handlers: Partial<Record<string, Handler>>) {
  const toGame = new PassThrough();
  const fromGame = new PassThrough();
  const sent: Array<{ op: string; arg?: unknown }> = [];
  const signals: string[] = [];
  let buffered = "";
  toGame.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
      const request = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      sent.push({ op: request.op, arg: request.arg });
      const handler = handlers[request.op];
      const answer = handler ? handler(request.arg) : { error: NativeOpError.UnknownOp };
      const reply = { id: request.id, op: request.op };
      const line =
        "result" in answer
          ? { ...reply, ok: true, result: answer.result }
          : { ...reply, ok: false, error: answer.error };
      fromGame.write(`${JSON.stringify(line)}\n`);
    }
  });
  const child: GameChild = {
    pid: 4343,
    fd3: Duplex.from({ readable: fromGame, writable: toGame }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exited: new Promise(() => {}),
    kill: (signal) => {
      signals.push(signal);
    },
  };
  return { child, sent, signals, ready: (value: unknown) => fromGame.write(`${JSON.stringify(value)}\n`) };
}

const V2_READY = {
  event: NativeEvent.Ready,
  nonce: NONCE,
  protocol: 2,
  contractVersion: 2,
  build: "dev-1",
  backend: { api: "metal", device: "Apple M4" },
  size: { width: 64, height: 64 },
  seed: 0,
  receipt: {
    tier: "core",
    backend: "metal",
    adapter: "Apple M4",
    nativeEnhanced: [],
    extensionApi: 1,
    customPassApi: 1,
  },
};

const SUMMARY = {
  v: 1,
  on: true,
  frames: 120,
  cpu: { p50: 6.1, p95: 9.8 },
  gpu: { p50: 4.2, p95: 5.0, source: GpuTimeSource.Timestamps },
  top: [{ scope: "enemy_ai", game: true, p95: 1.1 }],
  counters: { enemies: 42 },
  memory: [{ class: "streamed-meshes", bytes: 41943040, budget: 67108864 }],
  hitches: { count: 3, last: 4411 },
  nodes: NodeTimingState.Off,
  dropped: { scopes: 0, counters: 0, frames: 0 },
};

function report(frames: number) {
  return {
    v: 2,
    engine: "rust-wgpu",
    destination: "mac",
    deviceClass: "desktop-high",
    frames: Array.from({ length: frames }, (_, index) => ({
      index,
      cpuMs: 6,
      gpuMs: 4,
      intervalMs: 16.7,
      scopes: [{ scope: "tick", game: false, depth: 0, startUs: 0, us: 1500 }],
      gpu: [{ node: "world", ms: 2 }],
    })),
    hitches: [{ frame: 3, cause: "cpu", thresholdMs: 16.7, top: [{ scope: "enemy_ai", us: 11000 }] }],
    memory: [],
    counters: {},
    gpuSource: GpuTimeSource.Timestamps,
    truncated: false,
  };
}

/** A Rust game that counts `fps` frames a second on the row's clock, draws 12 calls and serves `profile` as `profile` says. */
function rustGame(clock: ReturnType<typeof fakeClock>, profile: Handler, fps = 60) {
  return answeringGame({
    [NativeOp.Start]: () => ({ result: { running: true } }),
    [NativeOp.Timing]: () => ({
      result: {
        frameMs: 16.7,
        updateMs: 1.2,
        drawMs: 3.4,
        frames: TIMING_FRAMES + Math.floor((clock.timers.now() * fps) / 1000),
      },
    }),
    [NativeOp.Pause]: () => ({ result: { running: false } }),
    [NativeOp.State]: () => ({
      result: {
        frame: 9,
        lifecycle: NativeLifecycle.Resumed,
        safeArea: { top: 0, left: 0, bottom: 0, right: 0 },
        __render: { drawCalls: 12, triangles: 3456, tags: {}, exact: false },
      },
    }),
    [NativeOp.Profile]: profile,
  });
}

async function portFor(game: ReturnType<typeof answeringGame>, clock: ReturnType<typeof fakeClock>) {
  const port = new NativeGamePort({
    child: game.child,
    nonce: NONCE,
    mode: NativeRunMode.Headless,
    stateDir: await tmpDir("native-profile-state-"),
    timers: clock.timers,
    project: "pond",
    encodeJpeg: async () => Buffer.from("jpeg"),
  });
  game.ready(V2_READY);
  await port.ready();
  return port;
}

/** A lease that holds `port`'s run. */
async function leaseOf(port: NativeGamePort | null) {
  const start: NativeLeaseOptions["start"] = async (request) => ({
    status: {
      project: request.project,
      runId: "run1",
      target: request.target,
      state: NativeRunState.Ready,
      mode: request.mode,
      pid: 1,
      backend: null,
      refusal: null,
      problem: null,
      exit: null,
      owner: null,
      startedAt: new Date(0).toISOString(),
      endedAt: null,
    },
    port: port ?? (await Promise.reject(new Error("no run"))),
  });
  const lease = new NativeLeasePort({ start, stop: async () => {}, target: BuildTarget.Mac });
  if (port) await lease.load("pond");
  return lease;
}

const begin = {
  action: "begin" as const,
  runId: "run-opt",
  stageId: "optimization",
  scenarioId: "default",
  handle: "h1",
  expectedRevision: REVISION,
  warmupMs: 0,
  sampleMs: SAMPLE_MS,
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

/** begin, start, then a read once the window has passed: the read's answer. */
async function sampleWindow(lease: NativeLeasePort, clock: ReturnType<typeof fakeClock>, windowMs = SAMPLE_MS) {
  const armed = await lease.profile(begin);
  const sessionId = field(armed, "sessionId");
  assert.equal(typeof sessionId, "string", `a session begins: ${JSON.stringify(armed)}`);
  await lease.profile({ action: "start", sessionId: String(sessionId) });
  clock.move(windowMs);
  const read = await lease.profile({ action: "read", sessionId: String(sessionId) });
  await lease.profile({ action: "end", sessionId: String(sessionId) });
  return { armed, read };
}

describe("preview.profile on a native lease", () => {
  it("answers a schema-1 sample with frameMs, drawCalls and triangles instead of 'no profiler'", async () => {
    const clock = fakeClock();
    const game = rustGame(clock, () => ({ error: NativeOpError.Unavailable }));
    const lease = await leaseOf(await portFor(game, clock));
    assert.equal(typeof lease.profile, "function", "a native lease has a profiler");
    const { read } = await sampleWindow(lease, clock);
    assert.equal(field(read, "state"), "finished");
    const sample = field(read, "sample");
    assert.equal(field(sample, "schemaVersion"), 1);
    assert.equal(field(sample, "backend"), SampleBackend.Native);
    const metrics = field(sample, "metrics");
    const value = (name: string) => field(field(metrics, name), "value");
    assert.ok(
      Math.abs(Number(value("frameMs")) - SAMPLE_MS / WINDOW_FRAMES) < 1e-9,
      "frame time is the window over its frames",
    );
    assert.ok(Math.abs(Number(value("fps")) - 60) < 1e-9);
    assert.equal(value("drawCalls"), 12);
    assert.equal(value("triangles"), 3456);
    assert.equal(value("gameFrameMs"), 16.7);
    assert.deepEqual(field(sample, "intervals"), {
      count: WINDOW_FRAMES,
      elapsedMs: SAMPLE_MS,
      minMs: null,
      maxMs: null,
    });
    assert.deepEqual(field(sample, "revision"), REVISION);
    assert.equal(field(sample, "handle"), "h1");
    assert.equal(value("cpuP95Ms"), undefined, "no summary metrics from a game that serves no profile");
  });

  it("adds the summary's CPU and GPU percentiles and hitches when the game serves its profile", async () => {
    const clock = fakeClock();
    const game = rustGame(clock, () => ({ result: SUMMARY }));
    const lease = await leaseOf(await portFor(game, clock));
    const { armed, read } = await sampleWindow(lease, clock);
    assert.equal(field(field(armed, "capabilities"), "frameProfile"), true);
    const metrics = field(field(read, "sample"), "metrics");
    assert.equal(field(field(metrics, "cpuP95Ms"), "value"), 9.8);
    assert.equal(field(field(metrics, "gpuP50Ms"), "value"), 4.2);
    assert.equal(field(field(metrics, "hitches"), "value"), 3);
  });

  it("a window with too few frames has no frame time, and says why", async () => {
    const clock = fakeClock();
    const game = rustGame(clock, () => ({ error: NativeOpError.Unavailable }), 5);
    const lease = await leaseOf(await portFor(game, clock));
    const { read } = await sampleWindow(lease, clock);
    const frameMs = field(field(field(read, "sample"), "metrics"), "frameMs");
    assert.deepEqual([field(frameMs, "value"), field(frameMs, "reason")], [null, "insufficient live render frames"]);
  });

  it("reads 'sampling' before the window closes, and a call into the game during it voids the session", async () => {
    const clock = fakeClock();
    const game = rustGame(clock, () => ({ error: NativeOpError.Unavailable }));
    const lease = await leaseOf(await portFor(game, clock));
    const armed = await lease.profile(begin);
    const sessionId = String(field(armed, "sessionId"));
    await lease.profile({ action: "start", sessionId });
    clock.move(SAMPLE_MS / 2);
    assert.equal(field(await lease.profile({ action: "read", sessionId }), "state"), "sampling");
    await lease.studioCall(NativeOp.Pause);
    clock.move(SAMPLE_MS);
    const read = await lease.profile({ action: "read", sessionId });
    assert.equal(field(read, "state"), "unavailable");
    assert.equal(field(read, "sample"), null);
  });

  it("one session at a time, and a window outside its bounds is refused before anything is sent", async () => {
    const clock = fakeClock();
    const game = rustGame(clock, () => ({ error: NativeOpError.Unavailable }));
    const lease = await leaseOf(await portFor(game, clock));
    await assert.rejects(lease.profile({ ...begin, sampleMs: 5 }), /invalid profile duration/);
    assert.deepEqual(game.sent, [], "nothing reached the game");
    await lease.profile(begin);
    await assert.rejects(lease.profile(begin), /too many profile sessions/);
  });
});

describe("preview.frameProfile", () => {
  it("on a native lease answers the game's ProfileReport v2, asked with the request", async () => {
    const clock = fakeClock();
    const game = rustGame(clock, () => ({ result: report(3) }));
    const lease = await leaseOf(await portFor(game, clock));
    const answer = await previewFrameProfile(lease, { action: FrameProfileAction.Report, frames: 3 });
    assert.equal(field(answer, "v"), 2);
    assert.equal((field(answer, "frames") as unknown[]).length, 3);
    assert.deepEqual(game.sent.at(-1), { op: NativeOp.Profile, arg: { action: FrameProfileAction.Report, frames: 3 } });
  });

  it("on a Rust web lease answers the page's ProfileReport v2 through __studio.profile", async () => {
    const calls: Array<[string, unknown]> = [];
    const page = {
      studioCall: async (method: string, arg?: unknown) => {
        calls.push([method, arg]);
        return report(2);
      },
    };
    const answer = await previewFrameProfile(page, { action: FrameProfileAction.Report });
    assert.equal(field(answer, "v"), 2);
    assert.deepEqual(calls, [[NativeOp.Profile, { action: FrameProfileAction.Report }]]);
  });

  it("refuses an over-cap report by the parser, never passes it through, and the game keeps running", async () => {
    const clock = fakeClock();
    const game = rustGame(clock, () => ({ result: report(PROFILE_REPORT_FRAMES_MAX + 1) }));
    const lease = await leaseOf(await portFor(game, clock));
    await assert.rejects(previewFrameProfile(lease, { action: FrameProfileAction.Report }), ProfileAnswerRefusedError);
    assert.deepEqual(game.signals, [], "the game was not ended");
    const page = { studioCall: async () => report(PROFILE_REPORT_FRAMES_MAX + 1) };
    await assert.rejects(previewFrameProfile(page, { action: FrameProfileAction.Report }), ProfileAnswerRefusedError);
  });

  it("answers unavailable with the reason: unknown-op, not served, a page with no verb, a lease with no run", async () => {
    const clock = fakeClock();
    const rows: Array<[string, ProfileUnavailableReason, Parameters<typeof previewFrameProfile>[0]]> = [
      [
        "an export (unknown-op)",
        ProfileUnavailableReason.UnknownOp,
        await leaseOf(await portFor(answeringGame({}), clock)),
      ],
      [
        "a game that serves no profile yet",
        ProfileUnavailableReason.NotServed,
        await leaseOf(
          await portFor(
            rustGame(clock, () => ({ error: NativeOpError.Unavailable })),
            clock,
          ),
        ),
      ],
      [
        "a page with no profile verb",
        ProfileUnavailableReason.NotServed,
        { studioCall: async () => ({ __missing: true }) },
      ],
      [
        "a Rust export page (unknown-op)",
        ProfileUnavailableReason.UnknownOp,
        { studioCall: async () => Promise.reject(new NativeOpRefusedError(NativeOp.Profile, NativeOpError.UnknownOp)) },
      ],
      ["a lease that holds no run", ProfileUnavailableReason.NoRun, await leaseOf(null)],
    ];
    for (const [row, reason, port] of rows) {
      const answer = await previewFrameProfile(port, { action: FrameProfileAction.Summary });
      assert.deepEqual(answer, { state: "unavailable", reason }, row);
    }
  });

  it("an arm asks for the mode and answers the mode in force", async () => {
    const clock = fakeClock();
    const game = rustGame(clock, (arg) => ({ result: { mode: field(arg, "mode") } }));
    const lease = await leaseOf(await portFor(game, clock));
    const answer = await previewFrameProfile(lease, { action: FrameProfileAction.Arm, mode: GpuTimingMode.Nodes });
    assert.deepEqual(answer, { mode: GpuTimingMode.Nodes });
  });
});

describe("studio:native.profile (Live)", () => {
  it("reads the run the person sees, embedded first, and answers no-run when none runs", async () => {
    const clock = fakeClock();
    const game = rustGame(clock, () => ({ result: SUMMARY }));
    const port = await portFor(game, clock);
    const asked: Array<NativeRunMode | undefined> = [];
    const runs = {
      portOf: (_project: string, mode?: NativeRunMode) => {
        asked.push(mode);
        return mode === NativeRunMode.Embedded ? port : null;
      },
    };
    const answer = await answerNativeProfile({ nativeRuns: runs }, "pond", { action: FrameProfileAction.Summary });
    assert.deepEqual(answer, SUMMARY);
    assert.equal(asked[0], NativeRunMode.Embedded);
    const none = { portOf: () => null };
    const idle = await answerNativeProfile({ nativeRuns: none }, "pond", { action: FrameProfileAction.Summary });
    assert.deepEqual(idle, { state: "unavailable", reason: ProfileUnavailableReason.NoRun });
  });

  it("reads a Rust web game Live shows when no native run is shown, and never another game's page", async () => {
    const none = { portOf: () => null };
    const page = (project: string) => ({
      status: () => ({ project }),
      studioCall: async () => SUMMARY,
    });
    const shown = await answerNativeProfile({ nativeRuns: none, livePreview: () => page("pond") }, "pond", {
      action: FrameProfileAction.Summary,
    });
    assert.deepEqual(shown, SUMMARY);
    const other = await answerNativeProfile({ nativeRuns: none, livePreview: () => page("other") }, "pond", {
      action: FrameProfileAction.Summary,
    });
    assert.deepEqual(other, { state: "unavailable", reason: ProfileUnavailableReason.NoRun });
    await tick();
  });
});
