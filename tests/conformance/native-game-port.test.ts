/**
 * The native game port (C++ · raylib): the host's side of the fd-3 protocol. Every line a game
 * sends is untrusted; a line too long, one outside its op's shape, a malformed event or a ready
 * for another run ends the game (SIGKILL to its group) with a typed refusal, and every waiting
 * call rejects with it. Captures are read from a host-derived path, their size checked before any
 * read and their digest recomputed on the BGRA before a JPEG exists. Time is a fake clock: no row
 * waits out a NATIVE_* constant.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { setTimeout as sleep, setImmediate as tick } from "node:timers/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { captureSurface } from "../../src/main/core/capture.ts";
import { GameStack } from "../../src/shared/game-project.ts";
import { CaptureSurface } from "../../src/shared/preview-contract.ts";
import {
  BootStage,
  NATIVE_CALL_TIMEOUT_MS,
  NATIVE_CAPTURE_MAX_BYTES,
  NATIVE_CAPTURE_MAX_PX,
  NATIVE_LINE_MAX_BYTES,
  NATIVE_READY_TIMEOUT_MS,
  NATIVE_START_MAX_MS,
  NATIVE_STDERR_LINE_MAX_CHARS,
  NativeError,
  NativeEvent,
  NativeOp,
  NativeRefusal,
  NativeRunMode,
  NativeRunState,
  type NativeTimers,
} from "../../src/shared/native-contract.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { captureProvenanceOf } from "../../src/shared/build-preview.ts";
import { CaptureExposure, SettingsSource } from "../../src/shared/render-quality.ts";
import {
  fnv1a64Hex,
  NATIVE_LOG_REPEAT_FLUSH_MS,
  NativeExitError,
  NativeGamePort,
  NativeLeasePort,
  type NativeLeaseOptions,
  type NativeLeaseRun,
  NativeOpRefusedError,
  type NativePortIo,
} from "../../src/substrate/native-game-port.ts";
import { NATIVE_INPUT_TICK_MS } from "../../src/substrate/native-input-plan.ts";
import type { GameChild } from "../../src/substrate/spawn.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FAKE_GAME = fileURLToPath(new URL("../fixtures/native-fake-game.mjs", import.meta.url));
const NONCE = "n0nce-for-this-run";
const POSIX_ONLY = process.platform === "win32" ? "not run: the planted links and FIFOs are POSIX" : false;

const isTimeout = (handle: unknown): handle is NodeJS.Timeout => typeof handle === "object" && handle !== null;

/** The real clock, for the rows that drive a real process. */
const REAL_TIMERS: NativeTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => {
    if (isTimeout(handle)) clearTimeout(handle);
  },
};

/** A clock that only moves when the row says so, running every timer that falls due on the way. */
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
  const settle = async () => {
    for (let round = 0; round < 5; round++) await tick();
  };
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      await settle();
      const next = [...due.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      const first = next[0];
      if (!first) break;
      due.delete(first[0]);
      now = first[1].at;
      first[1].run();
    }
    now = until;
    await settle();
  };
  return { timers, advance, settle };
}

/** A game in memory: the host's fd 3 is a duplex over two pipes; signals are recorded. */
function memoryGame() {
  const toGame = new PassThrough();
  const fromGame = new PassThrough();
  const stderr = new PassThrough();
  const stdout = new PassThrough();
  let reap: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    reap = done;
  });
  const signals: NodeJS.Signals[] = [];
  const requests: Array<{ id: number; op: string; arg?: unknown }> = [];
  let buffered = "";
  toGame.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
      requests.push(JSON.parse(buffered.slice(0, end)));
      buffered = buffered.slice(end + 1);
    }
  });
  const child: GameChild = {
    pid: 4242,
    fd3: Duplex.from({ readable: fromGame, writable: toGame }),
    stdout,
    stderr,
    exited,
    kill: (signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") setImmediate(() => reap({ code: null, signal }));
    },
  };
  return {
    child,
    signals,
    requests,
    reap,
    stderr,
    send: (value: unknown) => fromGame.write(`${JSON.stringify(value)}\n`),
    raw: (text: string | Buffer) => fromGame.write(text),
    killed: () => signals.includes("SIGKILL"),
  };
}

function readyEvent(overrides: Record<string, unknown> = {}) {
  return {
    event: NativeEvent.Ready,
    nonce: NONCE,
    protocol: 1,
    contractVersion: 1,
    build: "test",
    backend: { api: "metal-angle", device: "Apple M4" },
    size: { width: 64, height: 64 },
    seed: 0,
    ...overrides,
  };
}

/** A Rust · wgpu game's capability receipt and the ready fields that go with it (contract v2). */
const V2_RECEIPT = {
  tier: "core",
  backend: "metal",
  adapter: "Apple M4",
  nativeEnhanced: ["subgroup"],
  extensionApi: 1,
  customPassApi: 1,
};
const V2_READY = {
  protocol: 2,
  contractVersion: 2,
  backend: { api: "metal", device: "Apple M4" },
  receipt: V2_RECEIPT,
};

interface Rig {
  port: NativeGamePort;
  game: ReturnType<typeof memoryGame>;
  clock: ReturnType<typeof fakeClock>;
  encoded: Buffer[];
  reads: string[];
  stateDir: string;
}

async function rig(options: { mode?: NativeRunMode; ready?: boolean; io?: Partial<NativePortIo> } = {}): Promise<Rig> {
  const game = memoryGame();
  const clock = fakeClock();
  const encoded: Buffer[] = [];
  const reads: string[] = [];
  const stateDir = await tmpDir("native-port-state-");
  const port = new NativeGamePort({
    child: game.child,
    nonce: NONCE,
    mode: options.mode ?? NativeRunMode.Headless,
    stateDir,
    timers: clock.timers,
    project: "pong",
    encodeJpeg: async (bgra) => {
      encoded.push(Buffer.from(bgra));
      return Buffer.from("jpeg");
    },
    ...options.io,
  });
  if (options.ready !== false) {
    game.send(readyEvent());
    await port.ready();
  }
  return { port, game, clock, encoded, reads, stateDir };
}

/** The request the host wrote last, once it is there. */
async function lastRequest(r: Rig) {
  await r.clock.settle();
  const request = r.game.requests.at(-1);
  assert.ok(request, "the host sent a request");
  return request;
}

async function refusalOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (error: unknown) => (error instanceof NativeError ? error.refusal : `untyped: ${String(error)}`),
  );
}

/** Every entry under `dir` (links not followed): its kind, and a regular file's bytes. */
async function listing(dir: string): Promise<string[]> {
  const entries: string[] = [];
  for (const name of (await readdir(dir, { recursive: true })).sort()) {
    const file = path.join(dir, name);
    const info = await lstat(file);
    if (info.isFile()) entries.push(`${name} file ${(await readFile(file)).toString("hex")}`);
    else if (info.isDirectory()) entries.push(`${name} dir`);
    else entries.push(`${name} ${info.isSymbolicLink() ? "link" : "other"}`);
  }
  return entries;
}

/** A BGRA picture: `pixels` repeated `count` times. */
function bgra(pixel: [number, number, number, number], count: number): Buffer {
  return Buffer.concat(Array.from({ length: count }, () => Buffer.from(pixel)));
}

describe("calls made while the game starts", () => {
  // Pass-1 gate: Lakeside started under load was killed unresponsive while dev control polled its
  // state: the game answers nothing before its ready (its requests wait in its queue), yet the
  // call's deadline ran from the send, so a start slower than the call timeout ended the game.
  it("a call made while the game starts is sent at its ready, and its deadline runs from there", async () => {
    const r = await rig({ ready: false });
    const state = refusalOf(r.port.studioState());
    await r.clock.advance(NATIVE_CALL_TIMEOUT_MS + 5_000);
    assert.equal(r.game.killed(), false, "a start slower than the call timeout is not unresponsive");
    assert.deepEqual(r.game.requests, [], "nothing is sent before the ready");
    r.game.send(readyEvent());
    await r.port.ready();
    const request = await lastRequest(r);
    assert.equal(request.op, NativeOp.State, "the call goes out at the ready");
    await r.clock.advance(NATIVE_CALL_TIMEOUT_MS - 1);
    assert.equal(r.game.killed(), false, "its deadline runs from the ready");
    await r.clock.advance(1);
    assert.equal(await state, NativeRefusal.Unresponsive, "and an unanswered call still ends the game");
  });

  it("a call made while the game starts shares the start's fate when no ready comes", async () => {
    const r = await rig({ ready: false });
    const state = refusalOf(r.port.studioState());
    await r.clock.advance(NATIVE_READY_TIMEOUT_MS);
    assert.equal(await state, NativeRefusal.ReadyTimeout);
    assert.ok(r.game.killed());
  });
});

// Pass-1 gate: Lakeside's Live boot under load (its own world layout and pass pipelines, compiled
// cold in the game box) passed the 20 s ready deadline while every boot step was progressing.
describe("a start that says it is still starting", () => {
  const STEP_MS = NATIVE_READY_TIMEOUT_MS - 1_000;

  it("each `starting` gives the ready deadline again from there, up to the start's cap", async () => {
    const r = await rig({ ready: false });
    const ready = refusalOf(r.port.ready());
    let elapsed = 0;
    while (elapsed + STEP_MS < NATIVE_START_MAX_MS) {
      await r.clock.advance(STEP_MS);
      elapsed += STEP_MS;
      assert.equal(r.game.killed(), false, `still starting at ${elapsed} ms`);
      r.game.send({ event: NativeEvent.Starting });
      await r.clock.settle();
    }
    await r.clock.advance(NATIVE_START_MAX_MS - elapsed);
    assert.equal(await ready, NativeRefusal.ReadyTimeout, "never past the cap, however often it says so");
    assert.ok(r.game.killed());
  });

  it("a game that stops saying it is starting meets the ready deadline from its last word", async () => {
    const r = await rig({ ready: false });
    const ready = refusalOf(r.port.ready());
    await r.clock.advance(STEP_MS);
    r.game.send({ event: NativeEvent.Starting });
    await r.clock.settle();
    await r.clock.advance(NATIVE_READY_TIMEOUT_MS - 1);
    assert.equal(r.game.killed(), false);
    await r.clock.advance(1);
    assert.equal(await ready, NativeRefusal.ReadyTimeout);
  });

  // Owner decision D11: Live shows where the boot is (pipelines n of m) while it waits.
  it("a `starting` that names its stage reaches the run's listeners with its progress", async () => {
    const r = await rig({ ready: false });
    const heard: unknown[] = [];
    r.port.onEvent((event) => heard.push(event));
    r.game.send({ event: NativeEvent.Starting, stage: BootStage.Pipelines, done: 3, total: 9 });
    await r.clock.settle();
    assert.deepEqual(heard, [
      { event: NativeEvent.Starting, progress: { stage: BootStage.Pipelines, done: 3, total: 9 } },
    ]);
    assert.equal(r.game.killed(), false);
  });

  it("a ready after `starting` is the handshake as ever, and `starting` after it is reply-invalid", async () => {
    const r = await rig({ ready: false });
    r.game.send({ event: NativeEvent.Starting });
    r.game.send(readyEvent(V2_READY));
    await r.port.ready();
    await r.clock.advance(NATIVE_START_MAX_MS);
    assert.equal(r.game.killed(), false, "the ready ended every start deadline");
    r.game.send({ event: NativeEvent.Starting });
    await r.clock.settle();
    assert.equal(r.port.failure, NativeRefusal.ReplyInvalid);
    assert.ok(r.game.killed());
  });
});

describe("the handshake", () => {
  it("a game that never says ready is killed ready-timeout", async () => {
    const r = await rig({ ready: false });
    const ready = refusalOf(r.port.ready());
    await r.clock.advance(NATIVE_READY_TIMEOUT_MS - 1);
    assert.equal(r.game.killed(), false, "not before the timeout");
    await r.clock.advance(1);
    assert.equal(await ready, NativeRefusal.ReadyTimeout);
    assert.ok(r.game.killed(), "SIGKILL to the group");
  });

  it("a ready with another run's nonce, or another protocol, is bad-handshake and the game is killed", async () => {
    // Protocol 2 is contract v2 (a Rust game) since M2.0; a protocol neither side speaks is still refused.
    for (const wrong of [{ nonce: "someone-else" }, { protocol: 3 }, { protocol: 0 }]) {
      const r = await rig({ ready: false });
      r.game.send(readyEvent(wrong));
      assert.equal(await refusalOf(r.port.ready()), NativeRefusal.BadHandshake, JSON.stringify(wrong));
      assert.ok(r.game.killed());
    }
  });

  it("contract v2: a Rust game's ready states protocol 2 with its receipt, and the port answers it", async () => {
    const r = await rig({ ready: false });
    r.game.send(readyEvent(V2_READY));
    const ready = await r.port.ready();
    assert.equal(ready.protocol, 2);
    assert.deepEqual(ready.receipt, V2_RECEIPT);
    assert.equal(r.game.killed(), false);
  });

  it("contract v2: a protocol 2 ready without its receipt, or with a GL backend, is reply-invalid", async () => {
    for (const wrong of [{ receipt: undefined }, { receipt: { ...V2_RECEIPT, backend: "gl" } }]) {
      const r = await rig({ ready: false });
      r.game.send(readyEvent({ ...V2_READY, ...wrong }));
      assert.equal(await refusalOf(r.port.ready()), NativeRefusal.ReplyInvalid, JSON.stringify(wrong));
      assert.ok(r.game.killed());
    }
  });

  it("contract v2: a protocol 2 game's state() must carry lifecycle and safe area; a protocol 1 game's need not", async () => {
    const v2 = await rig({ ready: false });
    v2.game.send(readyEvent(V2_READY));
    await v2.port.ready();
    const good = v2.port.studioState();
    const first = await lastRequest(v2);
    const state = { phase: "play", lifecycle: "resumed", safeArea: { top: 0, left: 0, bottom: 34, right: 0 } };
    v2.game.send({ id: first.id, ok: true, op: "state", result: state });
    assert.deepEqual(await good, state);
    const bad = refusalOf(v2.port.studioState());
    const second = await lastRequest(v2);
    v2.game.send({ id: second.id, ok: true, op: "state", result: { phase: "play" } });
    assert.equal(await bad, NativeRefusal.ReplyInvalid);
    assert.ok(v2.game.killed());

    const v1 = await rig();
    const plain = v1.port.studioState();
    const request = await lastRequest(v1);
    v1.game.send({ id: request.id, ok: true, op: "state", result: { phase: "play" } });
    assert.deepEqual(await plain, { phase: "play" });
    assert.equal(v1.game.killed(), false);
  });

  it("a game that exits before ready rejects with its exit, never bad-handshake: the host refused nothing", async () => {
    for (const exit of [
      { code: 1, signal: null },
      { code: null, signal: "SIGSEGV" as const },
      { code: 0, signal: null },
    ]) {
      const r = await rig({ ready: false });
      const ready = r.port.ready().then(
        () => null,
        (error: unknown) => error,
      );
      r.game.reap(exit);
      const error = await ready;
      assert.ok(error instanceof NativeExitError, `${JSON.stringify(exit)}: ${String(error)}`);
      assert.equal(error instanceof NativeError, false, "an exit is no refusal");
      assert.deepEqual(error.exit, exit);
      assert.equal(error.ready, false);
      assert.equal(r.port.failure, null, "the host ended nothing");
    }
  });

  it("a call waiting when the game exits, or made after, rejects with the exit, never unresponsive", async () => {
    const r = await rig();
    const waiting = r.port.studioState().then(
      () => null,
      (error: unknown) => error,
    );
    await lastRequest(r);
    r.game.reap({ code: 0, signal: null });
    const error = await waiting;
    assert.ok(error instanceof NativeExitError, String(error));
    assert.deepEqual(error.exit, { code: 0, signal: null });
    assert.equal(error.ready, true);
    const after = await r.port.studioState().then(
      () => null,
      (later: unknown) => later,
    );
    assert.ok(after instanceof NativeExitError, String(after));
    assert.equal(r.port.status().unresponsive, false);
  });

  it("readiness is the ready event's, never a page probe", async () => {
    const r = await rig({ ready: false });
    assert.equal((await r.port.readySnapshot())?.ready, false);
    r.game.send(readyEvent());
    await r.port.ready();
    const snapshot = await r.port.readySnapshot();
    assert.equal(snapshot?.ready, true);
    assert.equal(snapshot?.attached, true);
  });
});

describe("untrusted lines", () => {
  it("a 2 MiB reply is reply-too-large: the game is killed and the call rejects", async () => {
    const r = await rig();
    const state = refusalOf(r.port.studioState());
    const request = await lastRequest(r);
    r.game.raw(`{"id":${request.id},"ok":true,"op":"state","result":{"x":"${"a".repeat(2 * 1024 * 1024)}"}}\n`);
    assert.equal(await state, NativeRefusal.ReplyTooLarge);
    assert.ok(r.game.killed());
  });

  it("a line past the limit is refused before its newline ever arrives", async () => {
    const r = await rig();
    const state = refusalOf(r.port.studioState());
    r.game.raw("b".repeat(NATIVE_LINE_MAX_BYTES + 1));
    assert.equal(await state, NativeRefusal.ReplyTooLarge);
    assert.ok(r.game.killed());
  });

  it("a wrong id, a non-object, an op mismatch or a result outside its shape is reply-invalid", async () => {
    const lines: Array<[string, (id: number) => string]> = [
      ["an id nobody asked", (id) => JSON.stringify({ id: id + 7, ok: true, op: "state", result: {} })],
      ["a non-object", () => "[1,2,3]"],
      ["a bare number", () => "42"],
      ["not JSON", () => "{nope"],
      ["another op's answer", (id) => JSON.stringify({ id, ok: true, op: "timing", result: {} })],
      ["a state that is no object", (id) => JSON.stringify({ id, ok: true, op: "state", result: "fine" })],
      ["no ok at all", (id) => JSON.stringify({ id, op: "state", result: {} })],
    ];
    for (const [label, line] of lines) {
      const r = await rig();
      const state = refusalOf(r.port.studioState());
      const request = await lastRequest(r);
      r.game.raw(`${line(request.id)}\n`);
      assert.equal(await state, NativeRefusal.ReplyInvalid, label);
      assert.ok(r.game.killed(), label);
    }
  });

  it("a result that fails isNativeResult for its op is reply-invalid", async () => {
    const r = await rig();
    const step = refusalOf(r.port.studioCall("step", 16));
    const request = await lastRequest(r);
    assert.deepEqual(request.arg, { ms: 16 }, "a page's step(ms) is the op's {ms}");
    r.game.send({ id: request.id, ok: true, op: "step", result: { frame: -1 } });
    assert.equal(await step, NativeRefusal.ReplyInvalid);
    assert.ok(r.game.killed());
  });

  it("an op the game refuses rejects unsupported and the game keeps running", async () => {
    const r = await rig();
    const demos = refusalOf(r.port.studioCall("demos"));
    const request = await lastRequest(r);
    r.game.send({ id: request.id, ok: false, op: "demos", error: "unknown op" });
    assert.equal(await demos, NativeRefusal.Unsupported);
    assert.equal(r.game.killed(), false);
  });

  it("a GPU code the game answers is the refusal, typed; the game keeps running and its words are kept", async () => {
    const cases = [
      { error: NativeRefusal.DeviceLost, expected: NativeRefusal.DeviceLost },
      { error: NativeRefusal.GpuHang, expected: NativeRefusal.GpuHang },
      { error: NativeRefusal.GpuPassInvalid, expected: NativeRefusal.GpuPassInvalid },
      { error: "unknown op", expected: NativeRefusal.Unsupported },
      { error: "DEVICE-LOST", expected: NativeRefusal.Unsupported },
      { error: NativeRefusal.ReplyInvalid, expected: NativeRefusal.Unsupported },
    ];
    for (const { error, expected } of cases) {
      const r = await rig({ ready: false });
      r.game.send(readyEvent(V2_READY));
      await r.port.ready();
      const capture = r.port.call(NativeOp.Capture).then(
        () => null,
        (rejected: unknown) => rejected,
      );
      const request = await lastRequest(r);
      r.game.send({ id: request.id, ok: false, op: NativeOp.Capture, error });
      const rejected = await capture;
      assert.ok(rejected instanceof NativeOpRefusedError, error);
      assert.equal(rejected.refusal, expected, error);
      assert.equal(rejected.gameError, error);
      assert.equal(r.game.killed(), false, `${error}: the game keeps running`);
    }
    // Only the ops the game does GPU work inside answer a renderer code; `surface` stays declined.
    const r = await rig({ ready: false });
    r.game.send(readyEvent(V2_READY));
    await r.port.ready();
    const surface = refusalOf(r.port.call(NativeOp.Surface, { w: 64, h: 64, dpr: 1, slots: 3, generation: 1 }));
    const request = await lastRequest(r);
    r.game.send({ id: request.id, ok: false, op: NativeOp.Surface, error: NativeRefusal.DeviceLost });
    assert.equal(await surface, NativeRefusal.Unsupported);
  });

  it("a call nobody answers is unresponsive after the call timeout", async () => {
    const r = await rig();
    const state = refusalOf(r.port.studioState());
    await r.clock.advance(NATIVE_CALL_TIMEOUT_MS);
    assert.equal(await state, NativeRefusal.Unresponsive);
    assert.ok(r.game.killed());
  });

  it("contract v2: a step or capture past its deadline is gpu-hang; a state, or any protocol 1 call, stays unresponsive", async () => {
    const cases = [
      { protocol: 2, op: NativeOp.Step, expected: NativeRefusal.GpuHang },
      { protocol: 2, op: NativeOp.Capture, expected: NativeRefusal.GpuHang },
      { protocol: 2, op: NativeOp.State, expected: NativeRefusal.Unresponsive },
      { protocol: 1, op: NativeOp.Step, expected: NativeRefusal.Unresponsive },
      { protocol: 1, op: NativeOp.Capture, expected: NativeRefusal.Unresponsive },
    ];
    for (const { protocol, op, expected } of cases) {
      const r = await rig({ ready: false });
      r.game.send(readyEvent(protocol === 2 ? V2_READY : {}));
      await r.port.ready();
      const call = refusalOf(r.port.call(op));
      await r.clock.advance(NATIVE_CALL_TIMEOUT_MS);
      assert.equal(await call, expected, `protocol ${protocol} ${op}`);
      assert.equal(r.port.failure, expected);
      assert.ok(r.game.killed());
    }
  });

  it("ids increase with every call", async () => {
    const r = await rig();
    void r.port.studioState().catch(() => {});
    void r.port.studioCall("cameras").catch(() => {});
    await r.clock.settle();
    const [first, second] = r.game.requests;
    assert.ok(first && second && second.id > first.id);
    r.port.kill(NativeRefusal.Unresponsive);
  });
});

describe("what the port does not do", () => {
  it("evaluate rejects unsupported and the game keeps running", async () => {
    const r = await rig();
    assert.equal(await refusalOf(r.port.evaluate()), NativeRefusal.Unsupported);
    assert.equal(r.game.killed(), false);
    const state = r.port.studioState();
    const request = await lastRequest(r);
    r.game.send({ id: request.id, ok: true, op: "state", result: { tick: 3 } });
    assert.deepEqual(await state, { tick: 3 }, "the game still answers");
  });

  it("renderSettings through preview.call is the game's op, a read or a change, as on a web page", async () => {
    const answer = {
      preset: "medium",
      requested: "medium",
      deviceClass: "desktop-mid",
      detectedClass: "desktop-mid",
      features: {},
      renderScaleLock: null,
      frameBudgetMs: 4,
      scale: 1,
    };
    for (const [arg, sent] of [
      [undefined, {}],
      [{}, {}],
      // A game reads no `set` in anything else, and ignores members it does not know.
      ["low", {}],
      [{ set: { preset: "low", extra: 1 } }, { set: { preset: "low" } }],
      [
        { set: { frameBudgetMs: 4, preset: "medium", features: { bloom: false } } },
        { set: { frameBudgetMs: 4, preset: "medium", features: { bloom: false } } },
      ],
      [
        { set: { preset: null, features: null, deviceClass: null, renderScaleLock: null, frameBudgetMs: null } },
        { set: { preset: null, features: null, deviceClass: null, renderScaleLock: null, frameBudgetMs: null } },
      ],
    ] as const) {
      const r = await rig();
      const call = r.port.studioCall("renderSettings", arg);
      const request = await lastRequest(r);
      assert.equal(request.op, "renderSettings");
      assert.deepEqual(request.arg, sent, JSON.stringify(arg));
      r.game.send({ id: request.id, ok: true, op: "renderSettings", result: answer });
      assert.deepEqual(await call, answer);
    }
  });

  it("renderSettings outside its shape is refused with the game's own code, sending nothing", async () => {
    const rows: ReadonlyArray<[unknown, string]> = [
      [{ set: { preset: "insane" } }, "unknown-preset"],
      [{ set: { deviceClass: "toaster" } }, "unknown-device-class"],
      [{ set: { features: { raytracing: true } } }, "unknown-render-feature"],
      [{ set: "low" }, "bad-argument"],
      [{ set: { preset: 3 } }, "bad-argument"],
      [{ set: { features: { bloom: "off" } } }, "bad-argument"],
      [{ set: { frameBudgetMs: "4" } }, "bad-argument"],
      [{ set: { renderScaleLock: Number.NaN } }, "bad-argument"],
      [{ set: null }, "bad-argument"],
      [{ set: { renderScaleLock: 0.25 } }, "invalid-render-scale"],
      [{ set: { frameBudgetMs: 0.5 } }, "invalid-frame-budget"],
    ];
    for (const [arg, code] of rows) {
      const r = await rig();
      const refused = await r.port.studioCall("renderSettings", arg).then(
        () => null,
        (error: unknown) => (error instanceof NativeOpRefusedError ? error.gameError : `untyped: ${String(error)}`),
      );
      assert.equal(refused, code, JSON.stringify(arg));
      await r.clock.settle();
      assert.equal(r.game.requests.length, 0, `nothing is sent for ${JSON.stringify(arg)}`);
    }
  });

  it("a page verb the protocol does not have answers {__missing}, sending nothing", async () => {
    const r = await rig();
    assert.deepEqual(await r.port.studioCall("eye", "front"), { __missing: true });
    await r.clock.settle();
    assert.equal(r.game.requests.length, 0);
  });

  /** Answers every `input` request as the runtime would, recording each message's actions and the clock. */
  function inputGame(r: Rig) {
    const sent: Array<{ at: number; actions: unknown }> = [];
    let answered = 0;
    const answer = async () => {
      await r.clock.settle();
      for (const request of r.game.requests.slice(answered)) {
        answered += 1;
        if (request.op !== NativeOp.Input) continue;
        sent.push({ at: r.clock.timers.now(), actions: (request.arg as { actions: unknown }).actions });
        r.game.send({ id: request.id, ok: true, op: NativeOp.Input, result: { held: [], ignored: 0 } });
      }
      await r.clock.settle();
    };
    /** Runs the clock in `step` ms beats for `ms`, answering on the way. */
    const run = async (ms: number, step = 1) => {
      for (let spent = 0; spent < ms; spent += step) {
        await answer();
        await r.clock.advance(step);
      }
      await answer();
    };
    return { sent, run };
  }

  it("a hold keeps its keys down for its whole duration: down, the pause, then up (the runtime leaves timed actions to the host)", async () => {
    const r = await rig();
    const game = inputGame(r);
    let done = false;
    const played = r.port.input([{ type: "hold", keys: ["ArrowRight"], ms: 3000 }]).then((answer) => {
      done = true;
      return answer;
    });
    await game.run(2990, 10);
    assert.deepEqual(game.sent, [{ at: 0, actions: [{ type: "down", keys: ["ArrowRight"] }] }], "still held");
    assert.equal(done, false, "the call answers when the hold ends");
    await game.run(20, 10);
    assert.deepEqual(game.sent.at(-1), { at: 3000, actions: [{ type: "up", keys: ["ArrowRight"] }] });
    assert.deepEqual(await played, { ok: true, applied: 1, width: 64, height: 64 });
  });

  it("wait pauses between messages, actions between timed ones travel together, and a positioned click hovers a tick before it taps", async () => {
    const r = await rig();
    const game = inputGame(r);
    const played = r.port.input([
      { type: "down", keys: ["KeyD"] },
      { type: "tap", keys: ["Space"] },
      { type: "wait", ms: 1000 },
      { type: "up", keys: ["KeyD"] },
      { type: "click", x: 0.25, y: 0.5, button: "left" },
    ]);
    await game.run(1100, 1);
    assert.deepEqual(
      game.sent.map((message) => message.actions),
      [
        [
          { type: "down", keys: ["KeyD"] },
          { type: "tap", keys: ["Space"] },
        ],
        [{ type: "up", keys: ["KeyD"] }],
        [{ type: "move", x: 0.25, y: 0.5 }],
        [{ type: "click", button: "left" }],
      ],
    );
    const [first, up, move, click] = game.sent.map((message) => message.at);
    assert.equal(first, 0);
    assert.ok((up ?? 0) >= 1000, `the wait holds the next message back: ${up}`);
    assert.ok((click ?? 0) - (move ?? 0) >= NATIVE_INPUT_TICK_MS, "the pointer lands a tick before the press");
    assert.equal((await played).applied, 5);
  });

  it("a drag presses where it starts, glides over several ticks and releases where it ends", async () => {
    const r = await rig();
    const game = inputGame(r);
    const played = r.port.input([{ type: "drag", fromX: 0, fromY: 0, x: 0.6, y: 0.3 }]);
    await game.run(300, 1);
    await played;
    const kinds = game.sent.map((message) => (message.actions as Array<{ type: string }>).map((a) => a.type).join(","));
    assert.deepEqual(kinds, ["move", "mousedown", "move", "move", "move", "move", "move", "move", "mouseup"]);
    assert.deepEqual(
      game.sent.at(-2)?.actions,
      [{ type: "move", x: 0.6, y: 0.3 }],
      "the glide ends where the drag does",
    );
    const times = game.sent.map((message) => message.at);
    assert.ok(
      times.every((at, i) => i === 0 || at > (times[i - 1] ?? 0)),
      `one message per tick: ${times}`,
    );
  });

  it("a position outside 0..1 without px is pixels, as the web preview reads it: it travels with px, and fractions stay fractions", async () => {
    const r = await rig();
    const game = inputGame(r);
    const played = r.port.input([
      { type: "click", x: 130, y: 236 },
      { type: "move", x: 0.5, y: 2 },
      { type: "move", x: 0.25, y: 0.75 },
      { type: "drag", fromX: 10, fromY: 0.5, x: 0.5, y: 0.5 },
    ]);
    await game.run(400, 1);
    await played;
    const sent = game.sent.map((message) => message.actions);
    assert.deepEqual(sent.slice(0, 3), [
      [{ type: "move", x: 130, y: 236, px: true }],
      [{ type: "click" }],
      [
        { type: "move", x: 0.5, y: 2, px: true },
        { type: "move", x: 0.25, y: 0.75 },
      ],
    ]);
    const glide = sent.slice(3).flat() as Array<{ type: string; px?: boolean }>;
    const moves = glide.filter((action) => action.type === "move");
    assert.ok(moves.length > 1 && moves.every((action) => action.px === true), "a drag in pixels glides in pixels");
  });

  it("input outside its shape is refused before anything is sent", async () => {
    const r = await rig();
    await assert.rejects(r.port.input([{ type: "move", x: Number.NaN, y: 1 }]));
    await r.clock.settle();
    assert.equal(r.game.requests.length, 0);
  });
});

describe("captures", () => {
  /** The capture answer for `pixels`, and the file the game would have written. */
  async function captured(r: Rig, file: Buffer, declared: { width: number; height: number; digest?: string }) {
    const shot = r.port.screenshotWithStats(80);
    const request = await lastRequest(r);
    assert.equal(request.op, NativeOp.Capture);
    await mkdir(path.join(r.stateDir, "captures"), { recursive: true });
    await writeFile(path.join(r.stateDir, "captures", "7.bgra"), file);
    r.game.send({
      id: request.id,
      ok: true,
      op: "capture",
      result: { seq: 7, format: "bgra8", digest: declared.digest ?? fnv1a64Hex(file), ...declared },
    });
    return shot;
  }

  it("a capture declaring 5000×5000 is refused before any read, and the game is killed", async () => {
    const reads: string[] = [];
    const r = await rig({
      io: {
        readCapture: async (file) => {
          reads.push(file);
          return Buffer.alloc(0);
        },
      },
    });
    const shot = refusalOf(r.port.screenshotWithStats());
    const request = await lastRequest(r);
    r.game.send({
      id: request.id,
      ok: true,
      op: "capture",
      result: { seq: 1, width: 5000, height: 5000, format: "bgra8", digest: "0".repeat(16) },
    });
    assert.equal(await shot, NativeRefusal.ReplyInvalid);
    assert.deepEqual(reads, [], "nothing was read");
    assert.deepEqual(r.encoded, [], "nothing was encoded");
  });

  it("a 64×64 capture whose file is one byte longer is capture-too-large; the file stays", async () => {
    const r = await rig();
    const file = bgra([10, 20, 30, 255], 64 * 64);
    const shot = captured(r, Buffer.concat([file, Buffer.from([0])]), {
      width: 64,
      height: 64,
      digest: fnv1a64Hex(file),
    });
    assert.equal(await refusalOf(shot), NativeRefusal.CaptureTooLarge);
    assert.deepEqual(r.encoded, []);
    assert.deepEqual(
      await readdir(path.join(r.stateDir, "captures")),
      ["7.bgra"],
      "the host changes nothing in the game's state while it runs: the run dir goes when the run ends",
    );
    assert.equal(r.game.killed(), false, "a bad capture is refused; the game keeps running");
  });

  it("a shorter file, or a digest that does not match the bytes, is capture-digest", async () => {
    const r = await rig();
    const file = bgra([1, 2, 3, 255], 4);
    assert.equal(
      await refusalOf(captured(r, file.subarray(1), { width: 2, height: 2, digest: fnv1a64Hex(file) })),
      NativeRefusal.CaptureDigest,
    );
    assert.equal(
      await refusalOf(captured(r, file, { width: 2, height: 2, digest: "0123456789abcdef" })),
      NativeRefusal.CaptureDigest,
    );
    assert.deepEqual(r.encoded, [], "no JPEG of bytes nobody vouched for");
  });

  it("the digest and the stats are taken on the BGRA, before the JPEG", async () => {
    const r = await rig();
    // Pure red in BGRA: B=0 G=0 R=255. Read as RGBA it would be pure blue.
    const red = bgra([0, 0, 255, 255], 4);
    const shot = await captured(r, red, { width: 2, height: 2 });
    assert.deepEqual(r.encoded, [red], "the JPEG encoder got the very bytes the digest vouched for");
    assert.ok(
      shot.stats.meanLuma > 50 && shot.stats.meanLuma < 60,
      `red's Rec.709 luma, not blue's: ${shot.stats.meanLuma}`,
    );
    assert.equal(shot.stats.canvas, true);
    assert.deepEqual(await readdir(path.join(r.stateDir, "captures")), ["7.bgra"], "the host removes nothing");
  });

  it("the FNV-1a 64 digest is the C++ template's", () => {
    assert.equal(fnv1a64Hex(Buffer.alloc(0)), "cbf29ce484222325");
    assert.equal(fnv1a64Hex(Buffer.from("a")), "af63dc4c8601ec8c");
    assert.equal(fnv1a64Hex(Buffer.from("foobar")), "85944171f73967e8");
  });
});

/**
 * The game writes in `state/`, so it can make `captures` (or `state` itself, or the capture
 * file) a link, or the capture file a FIFO. The host reads nothing through any of them, encodes
 * nothing, and removes or changes nothing outside the run, even when the bytes there carry the
 * digest the game declared.
 */
describe("a capture through anything the game planted is refused, with no side effect", () => {
  const pixels = bgra([9, 8, 7, 255], 4);
  const plants: Array<[string, (r: Rig, outside: string) => Promise<void>]> = [
    [
      "captures is a link to a folder outside the run",
      async (r, outside) => {
        await symlink(outside, path.join(r.stateDir, "captures"));
      },
    ],
    [
      "the capture file is a link to a file outside the run",
      async (r, outside) => {
        await mkdir(path.join(r.stateDir, "captures"));
        await symlink(path.join(outside, "7.bgra"), path.join(r.stateDir, "captures", "7.bgra"));
      },
    ],
    [
      "state itself was swapped for a link to a folder outside",
      async (r, outside) => {
        await mkdir(path.join(outside, "captures"));
        await writeFile(path.join(outside, "captures", "7.bgra"), pixels);
        await rename(r.stateDir, `${r.stateDir}-gone`);
        await symlink(outside, r.stateDir);
      },
    ],
    [
      "the capture file is a FIFO",
      async (r) => {
        await mkdir(path.join(r.stateDir, "captures"));
        await promisify(execFile)("/usr/bin/mkfifo", [path.join(r.stateDir, "captures", "7.bgra")]);
      },
    ],
    [
      "captures is a link to a folder holding a FIFO",
      async (r, outside) => {
        await rm(path.join(outside, "7.bgra"));
        await promisify(execFile)("/usr/bin/mkfifo", [path.join(outside, "7.bgra")]);
        await symlink(outside, path.join(r.stateDir, "captures"));
      },
    ],
  ];
  for (const [label, plant] of plants) {
    it(label, { skip: POSIX_ONLY }, async () => {
      const r = await rig();
      const outside = await tmpDir("native-port-outside-");
      await writeFile(path.join(outside, "7.bgra"), pixels);
      await writeFile(path.join(outside, "keep.txt"), "untouched");
      await plant(r, outside);
      const before = await listing(outside);
      const shot = r.port.screenshotWithStats();
      const request = await lastRequest(r);
      r.game.send({
        id: request.id,
        ok: true,
        op: "capture",
        result: { seq: 7, width: 2, height: 2, format: "bgra8", digest: fnv1a64Hex(pixels) },
      });
      assert.equal(await refusalOf(shot), NativeRefusal.CaptureDigest);
      assert.deepEqual(r.encoded, [], "nothing was encoded");
      assert.deepEqual(await listing(outside), before, "nothing outside the run was removed or changed");
      assert.equal(r.game.killed(), false, "a refused capture leaves the game running");
    });
  }
});

describe("visibility, sound and events", () => {
  it("setVisible(false) pauses a headless run and hides a window run", async () => {
    const headless = await rig({ mode: NativeRunMode.Headless });
    headless.port.setVisible(false);
    assert.deepEqual(await lastRequest(headless), { id: 1, op: NativeOp.Pause });
    const window = await rig({ mode: NativeRunMode.Window });
    window.port.setVisible(false);
    assert.deepEqual(await lastRequest(window), { id: 1, op: NativeOp.Visible, arg: { visible: false } });
  });

  it("showing a headless run again starts only the clock the host paused, never one its harness paused", async () => {
    const r = await rig();
    const pause = r.port.studioCall("pause");
    r.game.send({ id: (await lastRequest(r)).id, ok: true, op: "pause", result: { running: false } });
    await pause;
    r.port.setVisible(false);
    r.port.setVisible(true);
    await r.clock.settle();
    assert.deepEqual(
      r.game.requests.map((request) => request.op),
      [NativeOp.Pause],
      "the harness's pause stands",
    );
  });

  it("setAudioMuted is the audio op", async () => {
    const r = await rig();
    r.port.setAudioMuted(true);
    assert.deepEqual(await lastRequest(r), { id: 1, op: NativeOp.Audio, arg: { muted: true } });
  });

  it("a focus event is forwarded; a malformed one is reply-invalid", async () => {
    const r = await rig({ mode: NativeRunMode.Window });
    const heard: unknown[] = [];
    r.port.onEvent((event) => heard.push(event));
    r.game.send({ event: "focus", focused: true });
    await r.clock.settle();
    assert.deepEqual(heard, [{ event: NativeEvent.Focus, focused: true }]);
    r.game.send({ event: "focus", focused: "yes" });
    await r.clock.settle();
    assert.equal(r.port.failure, NativeRefusal.ReplyInvalid);
    assert.ok(r.game.killed());
  });

  it("stderr lines reach the console cut at the limit, and a fatal event is an error", async () => {
    const r = await rig();
    r.game.stderr.write(`${"w".repeat(NATIVE_STDERR_LINE_MAX_CHARS + 10)}\nWARNING: two\n`);
    r.game.send({ event: "fatal", reason: "out of memory" });
    await r.clock.settle();
    const entries = r.port.consoleEntries();
    assert.equal(entries.length, 3);
    assert.equal(entries[0]?.message.length, NATIVE_STDERR_LINE_MAX_CHARS);
    assert.equal(entries[1]?.message, "WARNING: two");
    assert.equal(r.port.status().consoleErrors, 1);
  });

  it("a character split across two stderr chunks reaches the console whole", async () => {
    const r = await rig();
    const line = Buffer.from("ошибка: текстура\n", "utf8");
    // Split after the third byte: inside the second character (each Cyrillic letter is two bytes).
    r.game.stderr.write(line.subarray(0, 3));
    await r.clock.settle();
    r.game.stderr.write(line.subarray(3));
    await r.clock.settle();
    assert.deepEqual(
      r.port.consoleEntries().map((entry) => entry.message),
      ["ошибка: текстура"],
    );
  });
});

/** An AppKit line as NSLog writes it: date, time, process[pid:thread], then the text. */
const nslog = (ms: number, text: string) =>
  `2026-10-01 11:12:23.${String(ms).padStart(3, "0")} game[86335:29232700] ${text}`;
const FLOOD = "+[NSXPCSharedListener endpointForReply:withListenerName:replyErrorCode:]: an error occurred";

/**
 * A line identical to the one before it, once NSLog's prefix is set aside, is counted instead of
 * written; the count is written as one line when another line comes, when the flush timer fires
 * or when the game ends. Nothing here knows any particular sentence.
 */
describe("repeated stderr lines", () => {
  /** What the port's stderr listeners and its console saw, in order. */
  function seen(r: Rig) {
    const lines: string[] = [];
    r.port.onStderr((line) => lines.push(line));
    return { lines, console: () => r.port.consoleEntries().map((entry) => entry.message) };
  }

  it("a run of identical lines is written once, then as one counted line when a different line comes", async () => {
    const r = await rig();
    const out = seen(r);
    r.game.stderr.write(
      `${[1, 2, 3, 4, 5].map((ms) => nslog(ms, FLOOD)).join("\n")}\nINFO: GL: Renderer: ANGLE (Metal)\n`,
    );
    await r.clock.settle();
    const expected = [nslog(1, FLOOD), `(repeated 4 times) ${FLOOD}`, "INFO: GL: Renderer: ANGLE (Metal)"];
    assert.deepEqual(out.lines, expected);
    assert.deepEqual(out.console(), expected);
  });

  it("distinct lines all pass through, raylib's INFO lines among them", async () => {
    const r = await rig();
    const out = seen(r);
    const lines = [
      "INFO: Initializing raylib 6.0",
      nslog(1, FLOOD),
      "INFO: GL: Version: OpenGL ES 3.0",
      nslog(2, "other"),
    ];
    r.game.stderr.write(`${lines.join("\n")}\n`);
    await r.clock.settle();
    assert.deepEqual(out.lines, lines);
  });

  it("the injected flush timer writes the pending count, and counting goes on after it", async () => {
    const r = await rig();
    const out = seen(r);
    r.game.stderr.write(`WARNING: same\nWARNING: same\nWARNING: same\n`);
    await r.clock.settle();
    assert.deepEqual(out.lines, ["WARNING: same"], "nothing more before the timer");
    await r.clock.advance(NATIVE_LOG_REPEAT_FLUSH_MS);
    assert.deepEqual(out.lines, ["WARNING: same", "(repeated 2 times) WARNING: same"]);
    r.game.stderr.write(`WARNING: same\n`);
    await r.clock.settle();
    await r.clock.advance(NATIVE_LOG_REPEAT_FLUSH_MS - 1);
    assert.equal(out.lines.length, 2, "the next count waits its own full interval");
    await r.clock.advance(1);
    assert.deepEqual(out.lines.at(-1), "(repeated 1 times) WARNING: same");
  });

  it("a game that ends while lines are being counted writes their count", async () => {
    const r = await rig();
    const out = seen(r);
    r.game.stderr.write(`${nslog(1, FLOOD)}\n${nslog(2, FLOOD)}\n${nslog(3, FLOOD)}\n`);
    await r.clock.settle();
    r.game.reap({ code: 0, signal: null });
    await r.clock.settle();
    assert.deepEqual(out.lines, [nslog(1, FLOOD), `(repeated 2 times) ${FLOOD}`]);
  });

  it("ten seconds of a 120-lines-a-second flood is a handful of lines, and every repeat is counted", async () => {
    const r = await rig();
    const out = seen(r);
    for (let second = 0; second < 10; second++) {
      r.game.stderr.write(Array.from({ length: 120 }, (_, n) => `${nslog(n, FLOOD)}\n`).join(""));
      await r.clock.settle();
      await r.clock.advance(1000);
    }
    r.game.reap({ code: 0, signal: null });
    await r.clock.settle();
    assert.ok(out.lines.length <= 2 + Math.ceil(10_000 / NATIVE_LOG_REPEAT_FLUSH_MS), String(out.lines.length));
    const counts = out.lines.slice(1).map((line) => Number(/^\(repeated (\d+) times\) /.exec(line)?.[1]));
    assert.equal(
      counts.reduce((sum, n) => sum + n, 0),
      10 * 120 - 1,
      out.lines.join("\n"),
    );
  });
});

/** A registry stand-in whose `start` waits until the row opens it; `honours` rejects on abort as the registry does. */
function gatedRegistry(honours: boolean) {
  const live = new Set<string>();
  const events: string[] = [];
  const gates: Array<() => void> = [];
  let count = 0;
  const start: NativeLeaseOptions["start"] = async (request) => {
    count += 1;
    const runId = `run${count}`;
    events.push(`start ${runId}`);
    await new Promise<void>((resolve, reject) => {
      gates.push(resolve);
      const { signal } = request;
      if (honours && signal) signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    live.add(runId);
    const run: NativeLeaseRun = {
      status: {
        project: request.project,
        runId,
        target: request.target,
        state: NativeRunState.Ready,
        mode: request.mode,
        pid: 1,
        backend: null,
        refusal: null,
        problem: null,
        exit: null,
        owner: request.owner ?? null,
        startedAt: new Date(0).toISOString(),
        endedAt: null,
      },
      port: {} as NativeGamePort,
    };
    return run;
  };
  const stop = async (runId: string) => {
    events.push(`stop ${runId}`);
    live.delete(runId);
  };
  /** Opens every start that waits, now or in the next few turns, and lets what follows run. */
  const open = async () => {
    for (let round = 0; round < 10; round++) {
      for (const gate of gates.splice(0)) gate();
      await tick();
    }
  };
  return { live, events, start, stop, open };
}

const settled = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ value, error: null }),
    (error: unknown) => ({ value: null, error }),
  );
const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";

/**
 * A native lease starts its run through the registry. A lease given back (or a newer load, or the
 * harness's `native.stop`) while that run is still building or starting cancels it: no game is
 * left running that no lease holds, whether the registry honours the abort or answers the run anyway.
 */
describe("a native lease", () => {
  for (const honours of [true, false]) {
    const registry = honours ? "a registry that honours the abort" : "a registry that answers the run anyway";
    it(`given back while its game starts, it leaves no game running (${registry})`, async () => {
      const r = gatedRegistry(honours);
      const lease = new NativeLeasePort({ start: r.start, stop: r.stop, target: BuildTarget.Mac, owner: "harness:1" });
      const loading = settled(lease.load("pong"));
      await tick();
      let disposed = false;
      const disposing = lease.dispose().then(() => {
        disposed = true;
      });
      await r.open();
      await disposing;
      const load = await loading;
      assert.ok(isAbort(load.error), `the load is cancelled: ${String(load.error)}`);
      assert.equal(disposed, true);
      assert.deepEqual([...r.live], [], "no game runs that no lease holds");
      assert.equal(lease.run, null);
      const again = await settled(lease.load("pong"));
      assert.ok(again.error, "a lease given back loads nothing");
      assert.deepEqual(
        r.events.filter((event) => event.startsWith("start")),
        ["start run1"],
        "nothing started after it was given back",
      );
    });

    it(`a newer load cancels one still starting and keeps its own run (${registry})`, async () => {
      const r = gatedRegistry(honours);
      const lease = new NativeLeasePort({ start: r.start, stop: r.stop, target: BuildTarget.Mac });
      const first = settled(lease.load("pong"));
      await tick();
      const second = settled(lease.load("pong"));
      await r.open();
      await r.open();
      assert.ok(isAbort((await first).error), "the first load is cancelled");
      assert.match(String((await second).value), /^native:\/\/pong\/run2$/);
      assert.deepEqual([...r.live], ["run2"]);
      assert.equal(lease.run?.status.runId, "run2");
    });

    it(`stopRun cancels a load still starting and keeps the lease (${registry})`, async () => {
      const r = gatedRegistry(honours);
      const lease = new NativeLeasePort({ start: r.start, stop: r.stop, target: BuildTarget.Mac });
      assert.equal(lease.project, null);
      const loading = settled(lease.load("pong"));
      await tick();
      assert.equal(lease.project, "pong", "a load still starting names its game");
      const stopping = lease.stopRun();
      await r.open();
      assert.equal(await stopping, true, "it cancelled something");
      assert.ok(isAbort((await loading).error));
      assert.deepEqual([...r.live], []);
      assert.equal(await lease.stopRun(), false, "nothing left to stop");
      const again = settled(lease.load("pong"));
      await r.open();
      assert.match(String((await again).value), /^native:\/\/pong\//, "the lease still loads");
    });
  }
});

describe("the scripted fake game on a real fd 3", () => {
  /** The fake game started the way spawnGame starts a game: fd 3 piped, its own group, a fresh env. */
  async function fakeGame(mode: string) {
    const stateDir = await tmpDir("native-fake-state-");
    const proc = spawn(process.execPath, [FAKE_GAME, mode], {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      detached: true,
      env: { GENEX_STUDIO_NONCE: NONCE, GENEX_STATE_DIR: stateDir, GENEX_STUDIO_FD: "3" },
    });
    const fd3 = proc.stdio[3];
    assert.ok(fd3 instanceof Duplex && proc.pid && proc.stdout && proc.stderr);
    const pid = proc.pid;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
      proc.once("exit", (code, signal) => done({ code, signal })),
    );
    const child: GameChild = {
      pid,
      fd3,
      stdout: proc.stdout,
      stderr: proc.stderr,
      exited,
      kill: (signal) => process.kill(-pid, signal),
    };
    // The real clock: no row waits for a timeout, and a game that stalls fails its row at the
    // call timeout instead of holding the runner for ever.
    const port = new NativeGamePort({
      child,
      nonce: NONCE,
      mode: NativeRunMode.Headless,
      stateDir,
      timers: REAL_TIMERS,
      encodeJpeg: async () => Buffer.from("jpeg"),
    });
    const stop = async () => {
      if (!port.exit) process.kill(-pid, "SIGKILL");
      await exited;
      assert.equal(running(pid), false, "nothing left running");
    };
    return { port, stop, exited, pid };
  }

  for (const mode of ["good", "partial", "crlf"]) {
    it(`${mode}: ready, state and a 2×2 capture whose digest matches`, async () => {
      const game = await fakeGame(mode);
      try {
        await game.port.ready();
        assert.deepEqual(await game.port.studioState(), { tick: 1, mode });
        const shot = await game.port.screenshotWithStats();
        assert.equal(shot.stats.width, 2);
        const quit = await game.port.call(NativeOp.Quit);
        assert.deepEqual(quit, { quitting: true });
        assert.deepEqual(await game.exited, { code: 0, signal: null });
      } finally {
        await game.stop();
      }
    });
  }

  for (const [mode, refusal] of [
    ["flood", NativeRefusal.ReplyTooLarge],
    ["endless", NativeRefusal.ReplyTooLarge],
    ["depth", NativeRefusal.ReplyInvalid],
  ] as const) {
    it(`${mode}: killed ${refusal}, and the call rejects with it`, async () => {
      const game = await fakeGame(mode);
      try {
        await game.port.ready();
        assert.equal(await refusalOf(game.port.studioState()), refusal);
        const exit = await game.exited;
        assert.equal(exit.signal, "SIGKILL");
      } finally {
        await game.stop();
      }
    });
  }

  it("stderr-flood: every console line is cut at the limit and the port keeps a bounded tail", async () => {
    const game = await fakeGame("stderr-flood");
    const lines: Array<[number, boolean]> = [];
    try {
      game.port.onStderr((line, cut) => lines.push([line.length, cut]));
      await game.port.ready();
      for (let wait = 0; wait < 200 && lines.length < 5000; wait++) await sleep(10);
      assert.equal(lines.length, 5000);
      assert.deepEqual(lines[0], [NATIVE_STDERR_LINE_MAX_CHARS, true]);
      assert.ok(lines.slice(1).every(([length, cut]) => length < 32 && !cut));
      assert.ok(game.port.consoleEntries().length <= 500);
    } finally {
      await game.stop();
    }
  });
});

describe("where a capture came from", () => {
  const build = { stack: GameStack.RustWgpu, target: BuildTarget.Mac, digest: "c".repeat(64), lock: "d".repeat(64) };

  /** One capture of `file` answered as seq 7 on `r`, with the reply's own fields over the defaults. */
  async function shot(r: Rig, file: Buffer, reply: Record<string, unknown> = {}) {
    const taking = r.port.screenshotWithStats();
    const request = await lastRequest(r);
    await mkdir(path.join(r.stateDir, "captures"), { recursive: true });
    await writeFile(path.join(r.stateDir, "captures", "7.bgra"), file);
    r.game.send({
      id: request.id,
      ok: true,
      op: "capture",
      result: { seq: 7, width: 2, height: 2, format: "bgra8", digest: fnv1a64Hex(file), ...reply },
    });
    return taking;
  }

  it("the camera is the one the game says it drew from, when its capture names one", async () => {
    const r = await rig();
    const pixels = bgra([4, 5, 6, 255], 4);
    // The host still thinks `default`: a debugCamera it sent is unanswered when the capture goes.
    assert.equal((await shot(r, pixels, { camera: "eye:spawn" })).provenance.camera, "eye:spawn");
  });

  it("a capture whose camera is not a short name is reply-invalid", async () => {
    for (const camera of [7, "", "x".repeat(300), null]) {
      const r = await rig();
      const refusal = await shot(r, bgra([4, 5, 6, 255], 4), { camera }).then(
        () => null,
        (error: unknown) => (error instanceof NativeError ? error.refusal : String(error)),
      );
      assert.equal(refusal, NativeRefusal.ReplyInvalid, JSON.stringify(camera));
    }
  });

  it("screenshotWithStats keeps the game's seq, the digest the host checked, the camera, the run id and the build", async () => {
    const r = await rig({ io: { runId: "0123456789ab", build } });
    const pixels = bgra([4, 5, 6, 255], 4);
    const taken = await shot(r, pixels);
    assert.deepEqual(taken.provenance, {
      seq: 7,
      digest: fnv1a64Hex(pixels),
      camera: "default",
      runId: "0123456789ab",
      build,
      render: null,
      outputSize: { width: 2, height: 2 },
    });
  });

  // Pass 2 (TS-F1): a builder capture kept no word of the settings that drew it, so a frame drawn
  // after `renderSettings {set:{deviceClass:"mobile-mid", preset:"low"}}` read as a regression.
  it("a capture keeps the render settings the game answered with, a verb change named as such", async () => {
    const r = await rig({ io: { runId: "0123456789ab", build } });
    const render = {
      preset: "low",
      deviceClass: "mobile-mid",
      settingsSource: SettingsSource.Verb,
      scale: 1,
      settleFrames: 8,
      historyReset: true,
      exposure: CaptureExposure.Instant,
    };
    const taken = await shot(r, bgra([4, 5, 6, 255], 4), { render: { ...render, extra: "dropped" } });
    assert.deepEqual(taken.provenance.render, render, "only the provenance's own fields are kept");
    assert.equal(taken.provenance.render?.settingsSource, SettingsSource.Verb);
    const saved = captureProvenanceOf(JSON.parse(JSON.stringify(taken.provenance)));
    assert.deepEqual(saved?.render, render, "the saved sidecar reads it back");
  });

  it("the camera is the one the last answered debugCamera left the game on; a refused one changes nothing", async () => {
    const r = await rig();
    const pixels = bgra([4, 5, 6, 255], 4);
    const moved = r.port.studioCall("debugCamera", "overhead");
    let request = await lastRequest(r);
    r.game.send({ id: request.id, ok: true, op: "debugCamera", result: { ok: true, camera: "overhead" } });
    await moved;
    assert.equal((await shot(r, pixels)).provenance.camera, "overhead");
    const refused = r.port.studioCall("debugCamera", "nowhere");
    request = await lastRequest(r);
    r.game.send({ id: request.id, ok: true, op: "debugCamera", result: { ok: false, available: ["overhead"] } });
    await refused;
    assert.equal(
      (await shot(r, pixels)).provenance.camera,
      "overhead",
      "a camera the game refused is not the one shown",
    );
    const back = r.port.studioCall("debugCamera", null);
    request = await lastRequest(r);
    r.game.send({ id: request.id, ok: true, op: "debugCamera", result: { ok: true } });
    await back;
    assert.equal((await shot(r, pixels)).provenance.camera, "default");
  });

  // Renderer pass 2, P2-0.9 step B (the 4K/1440p capture plan): `capture --size` asks the game for
  // its pinned capture at that size; the saved frame's `outputSize` is the size read back.
  it("screenshotAt sends the size asked for and keeps the size read back as outputSize", async () => {
    const r = await rig({ io: { runId: "0123456789ab", build } });
    const pixels = bgra([4, 5, 6, 255], 64 * 64);
    const taking = r.port.screenshotAt({ width: 64, height: 64 });
    const request = await lastRequest(r);
    assert.equal(request.op, NativeOp.Capture);
    assert.deepEqual(request.arg, { size: { width: 64, height: 64 } });
    await mkdir(path.join(r.stateDir, "captures"), { recursive: true });
    await writeFile(path.join(r.stateDir, "captures", "7.bgra"), pixels);
    r.game.send({
      id: request.id,
      ok: true,
      op: "capture",
      result: { seq: 7, width: 64, height: 64, format: "bgra8", digest: fnv1a64Hex(pixels) },
    });
    assert.deepEqual((await taking).provenance.outputSize, { width: 64, height: 64 });
  });

  it("a capture size outside whole pixels in 64..4096 is refused before anything is sent", async () => {
    const hostile = [
      { width: 63, height: 64 },
      { width: 64, height: NATIVE_CAPTURE_MAX_PX + 1 },
      { width: 64.5, height: 64 },
      { width: -64, height: 64 },
      { width: Number.NaN, height: 64 },
      { width: Number.POSITIVE_INFINITY, height: 64 },
      { width: 64 },
      { width: "64", height: 64 },
    ];
    for (const size of hostile) {
      const r = await rig();
      // The hostile shapes are the point: a caller's size is not trusted to be the declared type.
      const refusal = await refusalOf(r.port.screenshotAt(size as never));
      assert.equal(refusal, NativeRefusal.Unsupported, JSON.stringify(size));
      await r.clock.settle();
      assert.equal(r.game.requests.length, 0, `${JSON.stringify(size)}: nothing sent`);
    }
  });

  it("a game that draws another size than the one asked for is refused and nothing is encoded", async () => {
    const r = await rig();
    const pixels = bgra([4, 5, 6, 255], 4);
    const taking = refusalOf(r.port.screenshotAt({ width: 128, height: 72 }));
    const request = await lastRequest(r);
    await mkdir(path.join(r.stateDir, "captures"), { recursive: true });
    await writeFile(path.join(r.stateDir, "captures", "7.bgra"), pixels);
    r.game.send({
      id: request.id,
      ok: true,
      op: "capture",
      result: { seq: 7, width: 2, height: 2, format: "bgra8", digest: fnv1a64Hex(pixels) },
    });
    assert.equal(await taking, NativeRefusal.Unsupported, "a C++ game draws its world size only");
    assert.deepEqual(r.encoded, [], "nothing was encoded");
  });

  it("captureSurface hands the port's provenance on unchanged, as the harness's screenshot saves it", async () => {
    const r = await rig({ io: { runId: "0123456789ab", build } });
    const pixels = bgra([4, 5, 6, 255], 4);
    const taking = captureSurface(r.port, 80, CaptureSurface.Canvas);
    const request = await lastRequest(r);
    await mkdir(path.join(r.stateDir, "captures"), { recursive: true });
    await writeFile(path.join(r.stateDir, "captures", "2.bgra"), pixels);
    r.game.send({
      id: request.id,
      ok: true,
      op: "capture",
      result: { seq: 2, width: 2, height: 2, format: "bgra8", digest: fnv1a64Hex(pixels) },
    });
    const taken = await taking;
    assert.deepEqual(taken.provenance, {
      seq: 2,
      digest: fnv1a64Hex(pixels),
      camera: "default",
      runId: "0123456789ab",
      build,
      render: null,
      outputSize: { width: 2, height: 2 },
    });
  });

  it("a port that was told no run or build says so with null, never a guess", async () => {
    const r = await rig();
    const taken = await shot(r, bgra([1, 1, 1, 255], 4));
    assert.equal(taken.provenance.runId, null);
    assert.equal(taken.provenance.build, null);
  });

  it("a lease's capture carries its run's provenance", async () => {
    const r = await rig({ io: { runId: "abcdefabcdef", build } });
    const lease = new NativeLeasePort({
      target: BuildTarget.Mac,
      start: async () => ({
        status: { runId: "abcdefabcdef", project: "pong" } as NativeLeaseRun["status"],
        port: r.port,
      }),
      stop: async () => {},
    });
    await lease.load("pong");
    const taking = lease.screenshotWithStats();
    const request = await lastRequest(r);
    const pixels = bgra([7, 7, 7, 255], 4);
    await mkdir(path.join(r.stateDir, "captures"), { recursive: true });
    await writeFile(path.join(r.stateDir, "captures", "3.bgra"), pixels);
    r.game.send({
      id: request.id,
      ok: true,
      op: "capture",
      result: { seq: 3, width: 2, height: 2, format: "bgra8", digest: fnv1a64Hex(pixels) },
    });
    const taken = await taking;
    assert.equal(taken.provenance.seq, 3);
    assert.equal(taken.provenance.runId, "abcdefabcdef");
  });
});

describe("events out of turn", () => {
  it("a frame before ready is reply-invalid: no ring was announced yet", async () => {
    const r = await rig({ ready: false });
    const ready = refusalOf(r.port.ready());
    r.game.send({ event: "frame", seq: 1, slot: 0, ts: 1 });
    assert.equal(await ready, NativeRefusal.ReplyInvalid);
    assert.ok(r.game.killed());
  });

  it("a restored device from a protocol 1 game, or before any ready, is reply-invalid", async () => {
    const early = await rig({ ready: false });
    const ready = refusalOf(early.port.ready());
    early.game.send({ event: NativeEvent.DeviceRestored });
    assert.equal(await ready, NativeRefusal.ReplyInvalid);
    const v1 = await rig();
    v1.game.send({ event: NativeEvent.DeviceRestored });
    await v1.clock.settle();
    assert.equal(v1.port.failure, NativeRefusal.ReplyInvalid);
    assert.ok(v1.game.killed());
  });

  it("the restored-device event is the wire name genex-studio sends (native-wire-v2.json)", async () => {
    const wire = JSON.parse(await readFile(new URL("../fixtures/native-wire-v2.json", import.meta.url), "utf8"));
    assert.equal(wire.events.deviceRestored, NativeEvent.DeviceRestored);
    assert.equal(wire.events.starting, NativeEvent.Starting, "and so is the still-starting one");
  });

  it("contract v2: a restored device is forwarded, and the game keeps running", async () => {
    const r = await rig({ ready: false });
    r.game.send(readyEvent(V2_READY));
    await r.port.ready();
    const heard: unknown[] = [];
    r.port.onEvent((event) => heard.push(event));
    r.game.send({ event: NativeEvent.DeviceRestored, extra: "ignored" });
    await r.clock.settle();
    assert.deepEqual(heard, [{ event: NativeEvent.DeviceRestored }], "a copy: no unchecked field survives");
    assert.equal(r.game.killed(), false);
  });
});

/**
 * The fd-3 pipe as a hostile game uses it, on a real process in its own group: each misbehaviour
 * ends the game with its typed refusal, the process is reaped (SIGKILL, nothing left running), and
 * nothing else happens: no capture is read or encoded, nothing in the run's state changes. The
 * game is a short Node script; the port's clock is a fake one, so the slow-loris row waits out no
 * real deadline.
 */
describe("the fd-3 pipe against a hostile game", { skip: POSIX_ONLY }, () => {
  /** The hostile game: what it does on its pipe, by `GENEX_HOSTILE`. */
  const HOSTILE_GAME = String.raw`
    const net = require("node:net");
    const pipe = new net.Socket({ fd: 3, readable: true, writable: true });
    const mode = process.env.GENEX_HOSTILE;
    const nonce = process.env.GENEX_STUDIO_NONCE;
    const MAX = Number(process.env.GENEX_LINE_MAX);
    const ready = (fields) => pipe.write(JSON.stringify({ event: "ready", nonce, protocol: 2, contractVersion: 2,
      build: "hostile", backend: { api: "metal", device: "x" }, size: { width: 64, height: 64 }, seed: 0,
      receipt: { tier: "core", backend: "metal", adapter: "x", nativeEnhanced: [], extensionApi: 1, customPassApi: 1 },
      ...fields }) + "\n");
    if (mode === "oversize") { ready({}); pipe.write("z".repeat(MAX + 1) + "\n"); }
    if (mode === "wrong-nonce") ready({ nonce: "another-run" });
    if (mode === "verb-before-ready") pipe.write(JSON.stringify({ id: 1, ok: true, op: "state", result: {} }) + "\n");
    if (mode === "slow-loris") {
      const line = '{"event":"ready","nonce":"' + nonce + '"';
      let at = 0;
      setInterval(() => { if (at < line.length) pipe.write(line[at++]); }, 50);
    }
    if (mode === "huge-capture") {
      ready({});
      let buffered = "";
      pipe.on("data", (chunk) => {
        buffered += chunk;
        for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
          const { id, op } = JSON.parse(buffered.slice(0, end));
          buffered = buffered.slice(end + 1);
          if (op === "capture") pipe.write(JSON.stringify({ id, ok: true, op, result: { seq: 1,
            width: Number(process.env.GENEX_HUGE_W), height: Number(process.env.GENEX_HUGE_H), format: "bgra8",
            digest: "0".repeat(16) } }) + "\n");
        }
      });
    }
    setInterval(() => {}, 1000);
  `;

  /** Starts the hostile game as `spawnGame` starts one: fd 3 piped, its own group, a fresh env. */
  async function hostile(mode: string) {
    const stateDir = await tmpDir("native-hostile-state-");
    // One past the capture cap: the widest picture a game may declare, one row taller.
    const huge = { w: NATIVE_CAPTURE_MAX_PX, h: NATIVE_CAPTURE_MAX_BYTES / (NATIVE_CAPTURE_MAX_PX * 4) + 1 };
    const proc = spawn(process.execPath, ["-e", HOSTILE_GAME], {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      detached: true,
      env: {
        GENEX_HOSTILE: mode,
        GENEX_STUDIO_NONCE: NONCE,
        GENEX_LINE_MAX: String(NATIVE_LINE_MAX_BYTES),
        GENEX_HUGE_W: String(huge.w),
        GENEX_HUGE_H: String(huge.h),
      },
    });
    const fd3 = proc.stdio[3];
    assert.ok(fd3 instanceof Duplex && proc.pid && proc.stdout && proc.stderr);
    const pid = proc.pid;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
      proc.once("exit", (code, signal) => done({ code, signal })),
    );
    const child: GameChild = {
      pid,
      fd3,
      stdout: proc.stdout,
      stderr: proc.stderr,
      exited,
      kill: (signal) => process.kill(-pid, signal),
    };
    const clock = fakeClock();
    const reads: string[] = [];
    const encoded: Buffer[] = [];
    const port = new NativeGamePort({
      child,
      nonce: NONCE,
      mode: NativeRunMode.Headless,
      stateDir,
      timers: clock.timers,
      encodeJpeg: async (bytes) => {
        encoded.push(bytes);
        return Buffer.from("jpeg");
      },
      readCapture: async (file) => {
        reads.push(file);
        return Buffer.alloc(0);
      },
    });
    const before = await listing(stateDir);
    /** The process is reaped by SIGKILL, nothing of it runs, and nothing happened beside the refusal. */
    const assertEnded = async (label: string) => {
      const exit = await Promise.race([exited, sleep(5000).then(() => null)]);
      if (!exit) process.kill(-pid, "SIGKILL");
      assert.equal(exit?.signal, "SIGKILL", `${label}: reaped after the host's SIGKILL`);
      assert.equal(running(pid), false, `${label}: nothing left running`);
      assert.deepEqual(reads, [], `${label}: no capture was read`);
      assert.deepEqual(encoded, [], `${label}: nothing was encoded`);
      assert.deepEqual(await listing(stateDir), before, `${label}: nothing in the run's state changed`);
    };
    return { port, clock, assertEnded };
  }

  /** Waits on the real clock for what a real process sends, a bounded number of times. */
  async function until(done: () => boolean) {
    for (let round = 0; round < 500 && !done(); round++) await sleep(10);
  }

  const rows: Array<{
    mode: string;
    refusal: NativeRefusal;
    drive: (g: Awaited<ReturnType<typeof hostile>>) => Promise<string | null>;
  }> = [
    {
      mode: "oversize",
      refusal: NativeRefusal.ReplyTooLarge,
      drive: async (g) => {
        await g.port.ready();
        const state = refusalOf(g.port.studioState());
        return state;
      },
    },
    { mode: "wrong-nonce", refusal: NativeRefusal.BadHandshake, drive: (g) => refusalOf(g.port.ready()) },
    { mode: "verb-before-ready", refusal: NativeRefusal.ReplyInvalid, drive: (g) => refusalOf(g.port.ready()) },
    {
      mode: "slow-loris",
      refusal: NativeRefusal.ReadyTimeout,
      drive: async (g) => {
        const ready = refusalOf(g.port.ready());
        // A few bytes of a ready line trickle in, and never its end.
        await sleep(300);
        await g.clock.advance(NATIVE_READY_TIMEOUT_MS);
        return ready;
      },
    },
    {
      mode: "huge-capture",
      refusal: NativeRefusal.ReplyInvalid,
      drive: async (g) => {
        await g.port.ready();
        return refusalOf(g.port.screenshotWithStats());
      },
    },
  ];
  for (const { mode, refusal, drive } of rows) {
    it(`${mode}: refused ${refusal}, the game reaped, and nothing else done`, async () => {
      const game = await hostile(mode);
      let answered: string | null = null;
      const driving = drive(game).then((value) => {
        answered = value;
      });
      await until(() => answered !== null);
      await driving;
      assert.equal(answered, refusal);
      assert.equal(game.port.failure, refusal);
      await game.assertEnded(mode);
    });
  }
});
