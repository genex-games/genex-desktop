/**
 * Touch synthesis end to end (M3.9): a play script's `touch` action as kinds.ts keeps it, as
 * play-script.ts drives it (`preview.input` touch steps with frames between them), and as the host
 * routes it (`routePreviewInput`): to a contract v2 run's `input` op or a Rust · wgpu web page's
 * `input` verb, refused `touch-not-taken` with nothing applied by any other preview or a protocol 1
 * game. The last rows play a
 * touch-only game in memory through the real `NativeGamePort`; `rust-runtime.test.ts` plays the
 * real Rust protocol game the same way on the Mac build.
 */
import assert from "node:assert/strict";
import { Duplex, PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { routePreviewInput } from "../../src/main/harness-rpc/preview.ts";
import {
  NativeError,
  NativeEvent,
  NativeLifecycle,
  NativeOp,
  NativeRefusal,
  NativeRunMode,
  type NativeTimers,
} from "../../src/shared/native-contract.ts";
import { type PreviewInputAction, type PreviewTouchAction, TouchPhase } from "../../src/shared/preview-contract.ts";
import { describePlayScript, normalizePlayScript } from "../../src/harness-seed/loop/kinds.ts";
import { applyPlayScript } from "../../src/harness-seed/loop/play-script.ts";
import { NativeGamePort } from "../../src/substrate/native-game-port.ts";
import type { PreviewPort } from "../../src/substrate/preview-port.ts";
import type { GameChild } from "../../src/substrate/spawn.ts";

const NONCE = "play-script-n0nce";
/** The frame a stepped touch step is given to land in (`INPUT_FRAME_MS` in play-script.ts). */
const FRAME_MS = 48;
/** The id a script's finger takes when it names none: touch 0 is the mouse's. */
const SCRIPT_TOUCH_ID = 1;

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

/** A harness ctx that records every call and answers from `answer` (an empty object by default). */
function recorder(answer: (call: Call) => unknown = () => ({})) {
  const calls: Call[] = [];
  const ctx = {
    cancelled: false,
    call: async (method: string, payload: Record<string, unknown> = {}) => {
      const call = { method, payload };
      calls.push(call);
      return answer(call);
    },
  };
  return { calls, ctx };
}

/** The touch steps a recorded script sent, in order. */
function touchSteps(calls: Call[]): PreviewTouchAction[] {
  return calls.flatMap((call) => {
    const actions = call.method === "preview.input" ? call.payload.actions : undefined;
    return Array.isArray(actions) ? actions.filter((action) => action?.type === "touch") : [];
  });
}

const step = (ms: number, extra: Record<string, unknown> = {}) => ({
  method: "preview.call",
  payload: { method: "step", arg: ms, ...extra },
});
const touch = (phase: TouchPhase, x: number, y: number, id = SCRIPT_TOUCH_ID, extra: Record<string, unknown> = {}) => ({
  method: "preview.input",
  payload: { actions: [{ type: "touch", phase, id, x, y }], ...extra },
});

describe("a play script's touch action", () => {
  it("taps as a start, a frame, an end and a frame under the stepped clock, on the lease", async () => {
    const { calls, ctx } = recorder();
    await applyPlayScript(ctx as never, [{ type: "touch", x: 40, y: 20 }], { clock: "step", handle: "h1" });
    assert.deepEqual(calls, [
      touch(TouchPhase.Start, 40, 20, SCRIPT_TOUCH_ID, { handle: "h1" }),
      step(FRAME_MS, { handle: "h1" }),
      touch(TouchPhase.End, 40, 20, SCRIPT_TOUCH_ID, { handle: "h1" }),
      step(FRAME_MS, { handle: "h1" }),
    ]);
  });

  it("holds for its ms, then lifts where it went down; a named id is kept", async () => {
    const { calls, ctx } = recorder();
    await applyPlayScript(ctx as never, [{ type: "touch", x: 10, y: 12, ms: 600, id: 3 }], { clock: "step" });
    assert.deepEqual(calls, [
      touch(TouchPhase.Start, 10, 12, 3),
      step(600),
      touch(TouchPhase.End, 10, 12, 3),
      step(FRAME_MS),
    ]);
  });

  it("swipes through moves from where it went down to where it lifts, a frame after each step", async () => {
    const { calls, ctx } = recorder();
    await applyPlayScript(ctx as never, [{ type: "touch", x: 0, y: 50, toX: 80, toY: 10, ms: 400 }], {
      clock: "step",
    });
    const steps = touchSteps(calls);
    assert.deepEqual(steps[0], { type: "touch", phase: TouchPhase.Start, id: SCRIPT_TOUCH_ID, x: 0, y: 50 });
    assert.deepEqual(steps.at(-1), { type: "touch", phase: TouchPhase.End, id: SCRIPT_TOUCH_ID, x: 80, y: 10 });
    const moves = steps.filter((s) => s.phase === TouchPhase.Move);
    assert.ok(moves.length >= 2, "a swipe glides, it does not jump");
    const xs = moves.map((m) => m.x);
    assert.deepEqual(
      xs,
      [...xs].sort((a, b) => a - b),
      "moves head toward the lift",
    );
    assert.deepEqual(moves.at(-1), { type: "touch", phase: TouchPhase.Move, id: SCRIPT_TOUCH_ID, x: 80, y: 10 });
    const stepped = calls.filter((c) => c.method === "preview.call").map((c) => Number(c.payload.arg));
    assert.equal(stepped.length, steps.length, "every touch step gets its frame");
    assert.ok(stepped.reduce((sum, ms) => sum + ms, 0) >= 400, "the swipe lasts its ms");
  });

  it("under the wall clock sends the steps without stepping a clock the game runs itself", async () => {
    const { calls, ctx } = recorder();
    await applyPlayScript(ctx as never, [{ type: "touch", x: 5, y: 6 }], { clock: "wall" });
    assert.deepEqual(calls, [touch(TouchPhase.Start, 5, 6), touch(TouchPhase.End, 5, 6)]);
  });

  it("skips a touch the preview refuses touch-not-taken and plays the rest of the script", async () => {
    const refused = new NativeError(NativeRefusal.TouchNotTaken, "no touch here");
    const { calls, ctx } = recorder((call) => {
      const actions = call.payload.actions;
      if (Array.isArray(actions) && actions[0]?.type === "touch") throw refused;
      return {};
    });
    const played = await applyPlayScript(
      ctx as never,
      [
        { type: "touch", x: 1, y: 2 },
        { type: "tap", keys: ["space"] },
      ],
      { clock: "step" },
    );
    assert.deepEqual(
      calls.map((c) => c.method),
      ["preview.input", "preview.input", "preview.call"],
      "one refused start, no frame spent on it, then the tap",
    );
    assert.equal(played.refused, 1, "the skipped touch is counted, not hidden");
  });

  it("lets any other failure of a touch end the script", async () => {
    const { ctx } = recorder(() => {
      throw new NativeError(NativeRefusal.Unresponsive, "gone");
    });
    await assert.rejects(
      applyPlayScript(ctx as never, [{ type: "touch", x: 1, y: 2 }], { clock: "step" }),
      NativeError,
    );
  });

  it("never takes a game's own refusal (unsupported) for a preview that takes no touch", async () => {
    const { ctx } = recorder((call) => {
      const actions = call.payload.actions;
      if (Array.isArray(actions) && actions[0]?.type === "touch")
        throw new NativeError(NativeRefusal.Unsupported, "the game refused its input op");
      return {};
    });
    await assert.rejects(
      applyPlayScript(ctx as never, [{ type: "touch", x: 1, y: 2 }], { clock: "step" }),
      (error: unknown) => error instanceof NativeError && error.refusal === NativeRefusal.Unsupported,
    );
  });
});

describe("a play script's hostile touch fields", () => {
  it("refuses hostile touch fields before anything is sent", async () => {
    const hostile: Array<[string, Record<string, unknown>]> = [
      ["no y", { type: "touch", x: 1 }],
      ["a NaN x", { type: "touch", x: Number.NaN, y: 1 }],
      ["an infinite y", { type: "touch", x: 1, y: Number.POSITIVE_INFINITY }],
      ["a text x", { type: "touch", x: "1", y: 1 }],
      ["half a lift", { type: "touch", x: 1, y: 1, toX: 4 }],
    ];
    for (const [why, action] of hostile) {
      const { calls, ctx } = recorder();
      await applyPlayScript(ctx as never, [action], { clock: "step" });
      assert.deepEqual(calls, [], why);
    }
  });

  it("puts a finger the script names outside a uint32 on the script's own id", async () => {
    for (const id of [-1, 1.5, 2 ** 32, "2", null]) {
      const { calls, ctx } = recorder();
      await applyPlayScript(ctx as never, [{ type: "touch", x: 1, y: 1, id }], { clock: "step" });
      assert.equal(touchSteps(calls)[0]?.id, SCRIPT_TOUCH_ID, `id ${String(id)}`);
    }
  });
});

describe("an agent is told a play script may touch", () => {
  it("the play tool's script and the scout's PLAY ask each show a tap, a hold and a swipe", async () => {
    const { tools } = await import("../../src/harness-seed/tools/preview-tools.ts");
    const play = tools.find((tool) => tool.name === "play_deterministic");
    const script = JSON.stringify(play?.parameters ?? {});
    for (const shape of ["type:'touch', x:480, y:270}", "ms:600}", "toX:700"]) assert.ok(script.includes(shape), shape);
    const { scoutBrief } = await import("../../src/harness-seed/loop/scout.ts");
    const brief = scoutBrief({ run: { runId: "r1", project: "pond", goal: "a pond" } as never, profile: null });
    assert.match(brief, /\{"type":"touch","x":480,"y":270\}/, "the scout's PLAY ask shows a tap");
    assert.match(brief, /"toX":700/, "and a swipe");
    const { normalizePlayScript: normalize } = await import("../../src/harness-seed/loop/kinds.ts");
    // What the tool shows is what a declared script keeps.
    assert.deepEqual(normalize([{ type: "touch", x: 200, y: 400, toX: 700, toY: 400, ms: 300 }]), [
      { type: "touch", x: 200, y: 400, toX: 700, toY: 400, ms: 300 },
    ]);
  });
});

describe("a declared play script keeps its touches", () => {
  it("normalizes a tap, a long press and a swipe, and drops one it cannot place", () => {
    const script = normalizePlayScript([
      { type: "touch", x: 40, y: 20 },
      { type: "touch", x: "nope", y: 20 },
      { type: "touch", x: 10, y: 12, ms: 99_999, id: 3 },
      { type: "touch", x: 0, y: 50, toX: 80, toY: 10 },
      { type: "touch", x: 0, y: 50, toX: 80 },
    ]);
    assert.deepEqual(script, [
      { type: "touch", x: 40, y: 20 },
      { type: "touch", x: 10, y: 12, ms: 8_000, id: 3 },
      { type: "touch", x: 0, y: 50, toX: 80, toY: 10 },
    ]);
  });

  it("tells the judge where the script touched", () => {
    const said = describePlayScript([
      { type: "touch", x: 40, y: 20 },
      { type: "touch", x: 0, y: 50, toX: 80, toY: 10 },
    ]);
    assert.match(said, /touch \(40, 20\)/);
    assert.match(said, /swipe from \(0, 50\) to \(80, 10\)/);
  });
});

/**
 * A browser page port: it records what reached its `input` (synthesized events) and its page verbs.
 * `verb` is what the page's `input` verb answers (a Rust · wgpu web page answers `{held, ignored}`).
 */
function pagePort(verb: unknown = { __missing: true }): {
  port: PreviewPort;
  got: PreviewInputAction[][];
  verbs: Array<[string, unknown]>;
} {
  const got: PreviewInputAction[][] = [];
  const verbs: Array<[string, unknown]> = [];
  const port = {
    input: async (actions: PreviewInputAction[]) => {
      got.push(actions);
      return { ok: true, applied: actions.length, width: 960, height: 540 };
    },
    studioCall: async (method: string, arg?: unknown) => {
      verbs.push([method, arg]);
      return verb;
    },
  };
  return { port: port as unknown as PreviewPort, got, verbs };
}

const TIMERS: NativeTimers = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} };

/** The v2 ready a Rust game sends, with its capability receipt. */
const V2_READY = {
  protocol: 2,
  contractVersion: 2,
  backend: { api: "metal", device: "Apple M4" },
  receipt: {
    tier: "core",
    backend: "metal",
    adapter: "Apple M4",
    nativeEnhanced: [],
    extensionApi: 1,
    customPassApi: 1,
  },
};

/** A touch-only game's rules: `taps` counts the fingers that lifted, applied on the next step; keys reach nothing. */
function touchOnly() {
  const down = new Set<number>();
  let lifted = 0;
  let taps = 0;
  let frame = 0;
  const input = (actions: unknown) => {
    for (const action of Array.isArray(actions) ? actions : []) {
      if (action?.phase === TouchPhase.Start) down.add(action.id);
      if (action?.phase === TouchPhase.End && down.delete(action.id)) lifted += 1;
    }
    return { held: [] };
  };
  const step = (ms: unknown) => {
    const ticks = Math.max(1, Math.round(Number(ms ?? 16) / 16));
    frame += ticks;
    taps += lifted;
    lifted = 0;
    return { frame, simulatedMs: frame * 16, steppedFrames: ticks, drawCalls: 1 };
  };
  const state = () => ({
    lifecycle: NativeLifecycle.Resumed,
    safeArea: { top: 0, left: 0, bottom: 0, right: 0 },
    taps,
  });
  return {
    answer: (op: string, arg: Record<string, unknown> | undefined): unknown => {
      if (op === NativeOp.Input) return input(arg?.actions);
      if (op === NativeOp.Step) return step(arg?.ms);
      return state();
    },
  };
}

/** The touch-only game behind a real `NativeGamePort`, speaking `protocol`; its requests are recorded. */
async function touchOnlyGame(protocol: 1 | 2) {
  const toGame = new PassThrough();
  const fromGame = new PassThrough();
  const requests: Array<{ id: number; op: string; arg?: Record<string, unknown> }> = [];
  const send = (value: unknown) => fromGame.write(`${JSON.stringify(value)}\n`);
  const tapper = touchOnly();
  let buffered = "";
  toGame.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
      const request = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      requests.push(request);
      send({ id: request.id, ok: true, op: request.op, result: tapper.answer(request.op, request.arg) });
    }
  });
  const child: GameChild = {
    pid: 4343,
    fd3: Duplex.from({ readable: fromGame, writable: toGame }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exited: new Promise(() => {}),
    kill: () => {},
  };
  const port = new NativeGamePort({
    child,
    nonce: NONCE,
    mode: NativeRunMode.Headless,
    stateDir: "/nonexistent-state",
    timers: TIMERS,
    project: "tapper",
    encodeJpeg: async () => Buffer.from("jpeg"),
  });
  const v2 =
    protocol === 2 ? V2_READY : { protocol: 1, contractVersion: 1, backend: { api: "metal-angle", device: null } };
  send({ event: NativeEvent.Ready, nonce: NONCE, build: "test", size: { width: 96, height: 64 }, seed: 0, ...v2 });
  await port.ready();
  return { port, requests };
}

/** A harness ctx whose preview calls reach `port` the way the host's preview RPC routes them. */
function hostCtx(port: PreviewPort) {
  return {
    cancelled: false,
    call: async (method: string, payload: Record<string, unknown> = {}) => {
      if (method === "preview.input") return routePreviewInput(port, payload.actions as never);
      if (method === "preview.call") return port.studioCall(String(payload.method), payload.arg);
      if (method === "preview.state") return port.studioState();
      throw new Error(`unexpected ${method}`);
    },
  };
}

async function refusalOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (error: unknown) => (error instanceof NativeError ? error.refusal : `untyped: ${String(error)}`),
  );
}

describe("the host routes a touch to a game that takes one", () => {
  const start: PreviewTouchAction = { type: "touch", phase: TouchPhase.Start, id: 1, x: 4, y: 5 };
  const tap: PreviewInputAction = { type: "tap", keys: ["space"] };

  it("refuses a touch to a preview that takes none touch-not-taken, applying nothing of the call", async () => {
    const { port, got, verbs } = pagePort();
    assert.equal(await refusalOf(routePreviewInput(port, [tap, start])), NativeRefusal.TouchNotTaken);
    assert.deepEqual(got, [], "not even the tap before it");
    assert.deepEqual(verbs, [], "a page that is not a Rust web build is never asked");
    await routePreviewInput(port, [tap]);
    assert.deepEqual(got, [[tap]], "input without a touch reaches the page as before");
  });

  it("hands a Rust · wgpu web page the whole call through its page input verb", async () => {
    const { port, got, verbs } = pagePort({ held: ["Space"], ignored: 0 });
    const answer = await routePreviewInput(port, [tap, start], { pageTakesTouch: true });
    assert.equal(answer.applied, 2);
    // As the page receives it: JSON through the preview.
    assert.deepEqual(
      JSON.parse(JSON.stringify(verbs)),
      [[NativeOp.Input, { actions: [tap, start] }]],
      "the page contract's input, touches included",
    );
    assert.deepEqual(got, [], "no synthesized browser event");
  });

  it("refuses touch-not-taken when a Rust web page has no input verb to take it", async () => {
    for (const verb of [{ __missing: true }, null, undefined, { ok: false }]) {
      const { port } = pagePort(verb);
      const refusal = await refusalOf(routePreviewInput(port, [start], { pageTakesTouch: true }));
      assert.equal(refusal, NativeRefusal.TouchNotTaken, JSON.stringify(verb));
    }
  });

  it("refuses a hostile touch to a Rust web page before the page is asked", async () => {
    const { port, verbs } = pagePort({ held: [], ignored: 0 });
    const hostile = { type: "touch", phase: TouchPhase.Start, id: -1, x: Number.NaN, y: 0 };
    await assert.rejects(routePreviewInput(port, [hostile as never], { pageTakesTouch: true }));
    assert.deepEqual(verbs, []);
  });

  it("refuses a touch to a protocol 1 game touch-not-taken and writes it nothing", async () => {
    const game = await touchOnlyGame(1);
    assert.equal(await refusalOf(routePreviewInput(game.port, [start])), NativeRefusal.TouchNotTaken);
    assert.deepEqual(game.requests, [], "a raylib game has no touch: nothing on its pipe");
  });

  it("hands a contract v2 game the touch in its input op", async () => {
    const game = await touchOnlyGame(2);
    const answer = await routePreviewInput(game.port, [tap, start]);
    assert.equal(answer.applied, 2);
    assert.deepEqual(game.requests.at(-1), { id: 1, op: NativeOp.Input, arg: { actions: [tap, start] } });
  });

  it("a play script's touch tap changes the probe of a touch-only game; its keys do not", async () => {
    const game = await touchOnlyGame(2);
    const ctx = hostCtx(game.port);
    await applyPlayScript(ctx as never, [{ type: "tap", keys: ["space"] }], { clock: "step" });
    assert.equal(((await game.port.studioState()) as { taps: number }).taps, 0, "a key reaches no touch control");
    await applyPlayScript(ctx as never, [{ type: "touch", x: 48, y: 32 }], { clock: "step" });
    assert.equal(((await game.port.studioState()) as { taps: number }).taps, 1, "one tap, measured by the probe");
  });
});
