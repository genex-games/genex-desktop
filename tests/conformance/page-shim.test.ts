/**
 * The page shim's pure logic (M4.1) — the stepper, the timer queue and readiness, under node with
 * no browser and no Electron — and what it leaves alone: a game owes the studio nothing, so the
 * shim installs no `window.__studio`, seeds no `Math.random` and fakes no pointer lock.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PAGE_DISPATCH } from "../../src/main/page-dispatch.ts";
import { GAME_DISABLED_BLINK_FEATURES, gameViewPreferences } from "../../src/main/game-view.ts";
import {
  AUTO_RESUME_MS,
  DEFAULT_SHIM_OPTIONS,
  MAX_INTERVAL_FIRES_PER_FRAME,
  NESTED_TIMER_MIN_MS,
  contextKind,
  glDrainBudget,
  createClock,
  installPageGlobal,
  normalizeShimOptions,
  readinessVerdict,
} from "../../src/page/shim.ts";

const FRAME_MS = 1000 / 60;

/** A page whose animation frames and timers the test delivers by hand. */
function rig(options: Record<string, unknown> = {}) {
  let time = 0;
  const frames = new Map<number, (t: number) => void>();
  const timers = new Map<number, { fn: () => void; due: number }>();
  let nextFrame = 1;
  let nextTimer = 1;
  const host = {
    now: () => time,
    dateNow: () => 1_700_000_000_000 + time,
    raf: (cb: (t: number) => void) => {
      const id = nextFrame++;
      frames.set(id, cb);
      return id;
    },
    cancelRaf: (id: number) => void frames.delete(id),
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextTimer++;
      timers.set(id, { fn, due: time + (Number(ms) || 0) });
      return id;
    },
    clearTimeout: (id: number) => void timers.delete(id),
    setInterval: (fn: () => void, ms: number) => host.setTimeout(fn, ms),
    clearInterval: (id: number) => host.clearTimeout(id),
    report: () => {},
  };
  const clock = createClock(host, options);
  return {
    clock,
    frames,
    timers,
    advance: (ms: number) => {
      time += ms;
    },
    /** One real frame: the pump opens it, the browser runs what was armed. */
    wallFrame: () => {
      time += 16;
      clock.openFrame();
      const jobs = [...frames.values()];
      frames.clear();
      for (const cb of jobs) cb(time);
    },
  };
}

describe("the virtual clock", () => {
  it("runs exactly the frames step() was asked for, on a loop that re-queues itself", async () => {
    const { clock } = rig();
    let calls = 0;
    const loop = () => {
      calls++;
      clock.wrappers.requestAnimationFrame(loop);
    };
    clock.wrappers.requestAnimationFrame(loop);
    const before = clock.now();
    const result = await clock.step(1000);
    assert.equal(result.frames, 60);
    assert.equal(result.idle, 0, "every frame found a callback to call");
    assert.equal(calls, 60);
    assert.ok(Math.abs(clock.now() - before - 60 * FRAME_MS) < 1e-9, `now advanced by ${clock.now() - before}`);
    assert.equal(clock.frozen(), true);
  });

  it("counts stepped frames separately from the wall pump's — the property proveStep rests on", async () => {
    const r = rig();
    const loop = () => r.clock.wrappers.requestAnimationFrame(loop);
    r.clock.wrappers.requestAnimationFrame(loop);
    r.wallFrame();
    r.wallFrame();
    assert.equal(r.clock.frames(), 2);
    assert.equal(r.clock.steppedFrames(), 0);
    await r.clock.step(1000);
    assert.equal(r.clock.steppedFrames(), 60);
    assert.equal(r.clock.frames(), 62);
  });

  it("stays monotonic across a freeze and a resume", async () => {
    const r = rig();
    const first = r.clock.now();
    r.advance(500);
    const live = r.clock.now();
    assert.ok(live > first);
    r.clock.pause();
    await r.clock.step(100);
    const stepped = r.clock.now();
    r.advance(5000);
    r.clock.start();
    assert.ok(r.clock.now() >= stepped, "the clock went backwards on resume");
    r.advance(10);
    assert.ok(r.clock.now() > stepped);
  });

  it("converts a live timer into a virtual one across a freeze", async () => {
    const r = rig();
    let fired = 0;
    r.clock.wrappers.setTimeout(() => fired++, 100);
    assert.equal(r.timers.size, 1);
    r.clock.pause();
    assert.equal(r.timers.size, 0, "the native timer must be cancelled, not left to race the step");
    await r.clock.step(50);
    assert.equal(fired, 0);
    await r.clock.step(60);
    assert.equal(fired, 1);
    assert.equal(r.clock.timerStats().pending, 0);
  });

  it("owes a frozen interval its fires, and never lets one spin", async () => {
    const paced = rig();
    let ticks = 0;
    paced.clock.wrappers.setInterval(() => ticks++, 16);
    paced.clock.pause();
    await paced.clock.step(60_000);
    assert.ok(ticks > 3600 && ticks < 3900, `a 16 ms interval fired ${ticks} times across 60 s`);

    const spinning = rig();
    let spins = 0;
    spinning.clock.wrappers.setInterval(() => spins++, 0);
    spinning.clock.pause();
    const result = await spinning.clock.step(1000);
    assert.equal(result.frames, 60);
    assert.equal(spins, 60 * MAX_INTERVAL_FIRES_PER_FRAME);
  });

  it("cancels a callback the frame it was cancelled in, so a restart cannot fork the loop", async () => {
    const r = rig();
    let handle = 0;
    let loops = 0;
    const loop = () => {
      loops++;
      handle = r.clock.wrappers.requestAnimationFrame(loop);
    };
    // The pause screen's Resume, running ahead of the loop in the same frame: cancel, re-request.
    let resumed = false;
    const resume = () => {
      r.clock.wrappers.requestAnimationFrame(resume);
      if (resumed) return;
      resumed = true;
      r.clock.wrappers.cancelAnimationFrame(handle);
      handle = r.clock.wrappers.requestAnimationFrame(loop);
    };
    r.clock.wrappers.requestAnimationFrame(resume);
    handle = r.clock.wrappers.requestAnimationFrame(loop);
    await r.clock.step(10 * FRAME_MS);
    // Nine, not ten: the loop was cancelled in the first frame before its turn came, exactly as
    // a browser skips a callback cancelled during its own frame. Before the entries stayed
    // reachable while they ran, the cancel found nothing, the cancelled callback ran anyway and
    // re-queued a second chain: nineteen calls, and a game at twice its rate for the rest of the run.
    assert.equal(loops, 9, "the cancelled callback ran anyway and the loop forked");
    assert.equal(r.clock.pendingRaf(), 2, "one resume chain and one game loop, never two of either");
  });

  it("gives an async animation callback its microtask before the next frame", async () => {
    const r = rig();
    let drawn = 0;
    const loop = async () => {
      await Promise.resolve();
      drawn++;
      r.clock.wrappers.requestAnimationFrame(loop);
    };
    r.clock.wrappers.requestAnimationFrame(loop);
    const result = await r.clock.step(10 * FRAME_MS);
    assert.equal(result.frames, 10);
    // A synchronous stepper charged ten frames to a game that had drawn one, and said nothing.
    assert.equal(drawn, 10, `an awaiting loop drew ${drawn} of the 10 frames it was charged for`);
    assert.equal(result.idle, 0);
  });

  it("counts the frames that found no callback at all, so an over-charge is never silent", async () => {
    const r = rig();
    r.clock.wrappers.requestAnimationFrame(() => {});
    const result = await r.clock.step(10 * FRAME_MS);
    assert.equal(result.frames, 10);
    assert.equal(result.idle, 9, "nine of the ten simulated frames had nothing to call");
  });

  it("clamps a self-rescheduling setTimeout the way a browser's nesting clamp does", async () => {
    const r = rig();
    let fires = 0;
    const loop = () => {
      fires++;
      r.clock.wrappers.setTimeout(loop, 0);
    };
    r.clock.wrappers.setTimeout(loop, 0);
    r.clock.pause();
    const result = await r.clock.step(1000);
    assert.equal(result.frames, 60);
    // Unclamped this chain was a new handle every time, so the interval cap never saw it and the
    // frame budget (512 a frame) was the only bound: eight minutes of game logic in one step().
    assert.ok(fires <= 61 && fires >= 59, `a setTimeout(fn, 0) chain fired ${fires} times in one simulated second`);
    assert.equal(NESTED_TIMER_MIN_MS, 4);
  });

  it("draws a frame without simulating one", () => {
    const r = rig();
    let drawn = 0;
    const loop = () => {
      drawn++;
      r.clock.wrappers.requestAnimationFrame(loop);
    };
    r.clock.wrappers.requestAnimationFrame(loop);
    r.clock.pause();
    const at = r.clock.now();
    assert.equal(r.clock.pumpFrame(0), true);
    assert.equal(drawn, 1);
    assert.equal(r.clock.now(), at);
    assert.equal(r.clock.steppedFrames(), 0);
  });

  it("closes a frame after the last of the page's own callbacks", () => {
    const r = rig();
    const order: string[] = [];
    r.clock.afterFrame(() => order.push("after"));
    const loop = () => {
      order.push("game");
      r.clock.wrappers.requestAnimationFrame(loop);
    };
    r.clock.wrappers.requestAnimationFrame(loop);
    r.wallFrame();
    assert.deepEqual(order, ["game", "after"]);
  });

  it("starts a page nobody is stepping any more", () => {
    const r = rig();
    r.clock.pause();
    r.advance(AUTO_RESUME_MS + 1);
    r.clock.tick();
    assert.equal(r.clock.frozen(), false);
    assert.equal(r.clock.autoResumes(), 1);
  });

  it("takes whatever the serve layer sent and makes it safe", () => {
    assert.deepEqual(normalizeShimOptions({}), { ...DEFAULT_SHIM_OPTIONS });
    assert.deepEqual(normalizeShimOptions(undefined), { ...DEFAULT_SHIM_OPTIONS });
    // Flipped from a seed and a pointer-lock switch: the shim keys no generator and fakes no lock.
    assert.deepEqual(Object.keys(normalizeShimOptions({ seed: 7, pointerLock: true })).sort(), [
      "clock",
      "counters",
      "frameMs",
      "maxTimers",
      "quietMs",
      "readyMs",
    ]);
    assert.equal(normalizeShimOptions({ readyMs: 1 }).readyMs, 1000);
    assert.equal(normalizeShimOptions({ readyMs: "nonsense" }).readyMs, DEFAULT_SHIM_OPTIONS.readyMs);
    assert.equal(normalizeShimOptions({ clock: "studio" }).clock, "studio");
    assert.equal(rig({ clock: "studio" }).clock.frozen(), true, "a studio-clock page is frozen from its first frame");
  });
});

/** The shim installed in a Node process of its own with a fake DOM's prototypes: what it changed. */
async function installedShim(): Promise<Record<string, unknown>> {
  const shim = pathToFileURL(path.resolve(import.meta.dirname, "../../src/page/shim.ts")).href;
  const script = `
    class Element { requestPointerLock() { return "native"; } }
    class Document {}
    Object.defineProperty(Document.prototype, "pointerLockElement", { configurable: true, get: () => null });
    Object.assign(globalThis, { Element, Document });
    const random = Math.random;
    const request = Element.prototype.requestPointerLock;
    const lockDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "pointerLockElement");
    const { installStudioShim } = await import(${JSON.stringify(shim)});
    installStudioShim({ seed: 1, pointerLock: true });
    const game = { mine: true };
    globalThis.__studio = game;
    const state = globalThis.__studioClock.state();
    console.log(JSON.stringify({
      nativeRandom: Math.random === random,
      gameKeepsItsOwn: globalThis.__studio === game,
      nativeLockRequest: Element.prototype.requestPointerLock === request,
      nativeLockElement: Object.getOwnPropertyDescriptor(Document.prototype, "pointerLockElement").get === lockDescriptor.get,
      stateKeys: Object.keys(state).sort(),
    }));
    process.exit(0);`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script]);
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
}

describe("what the shim leaves to the page", () => {
  it("installs no window.__studio, seeds no Math.random and fakes no pointer lock", async () => {
    const page = await installedShim();
    assert.equal(page.nativeRandom, true, "Math.random is the browser's own");
    assert.equal(page.gameKeepsItsOwn, true, "a page's own window.__studio is a plain value of its own");
    assert.equal(page.nativeLockRequest, true, "requestPointerLock is the browser's own");
    assert.equal(page.nativeLockElement, true, "pointerLockElement is the browser's own");
  });

  it("reports what the page is doing from the studio's own clock", async () => {
    const page = await installedShim();
    assert.deepEqual(page.stateKeys, ["__attached", "fps", "frame", "pointerLock", "render", "running", "simulatedMs"]);
  });
});

describe("readiness", () => {
  it("calls a page that outran its boot budget timed out, never failed", () => {
    const slow = readinessVerdict({
      elapsed: 15_001,
      quiet: false,
      complete: false,
      frames: 0,
      drawCalls: 0,
      readyMs: 15_000,
    });
    assert.equal(slow.timedOut, true);
    assert.equal(slow.ready, false);
    // `phase: "failed"` is a page's own report of a boot failure and every consumer refuses to
    // load on it — a slow first draw must cost a note, not the whole run's evidence.
    assert.equal(slow.settle, null, "a spent budget must not settle the page as failed");
    const early = readinessVerdict({
      elapsed: 900,
      quiet: false,
      complete: false,
      frames: 0,
      drawCalls: 0,
      readyMs: 15_000,
    });
    assert.equal(early.timedOut, false);
  });

  it("still settles a page that goes quiet after its budget ran out", () => {
    const late = readinessVerdict({
      elapsed: 40_000,
      quiet: true,
      complete: true,
      frames: 9,
      drawCalls: 120,
      readyMs: 15_000,
    });
    assert.equal(late.settle, "quiet");
    assert.equal(late.ready, true);
    const drewNothing = readinessVerdict({
      elapsed: 9_000,
      quiet: true,
      complete: true,
      frames: 9,
      drawCalls: 0,
      readyMs: 15_000,
    });
    assert.equal(drewNothing.settle, "quiet-no-draw");
  });
});

describe("the studio's own globals", () => {
  it("answers with the studio's object however hard a page assigns over it", () => {
    const target: Record<string, unknown> = {};
    const clock = { version: 1, stats: () => ({ steppedFrames: 3 }) };
    installPageGlobal(target, "__studioClock", clock);
    // Every probe the studio trusts reads these back BY NAME from the page world, so a plain
    // writable property let a build hand the studio a stub that reported whatever it liked.
    assert.doesNotThrow(() => {
      (target as { __studioClock: unknown }).__studioClock = { version: 1, stats: () => ({ steppedFrames: 99 }) };
    });
    assert.equal(target.__studioClock, clock);
    assert.deepEqual((target.__studioClock as { stats: () => unknown }).stats(), { steppedFrames: 3 });
    // Configurable, so an uninstall and a newer version can still take the name back.
    assert.doesNotThrow(() => delete (target as { __studioClock?: unknown }).__studioClock);
    assert.equal(target.__studioClock, undefined);
  });
});

describe("what a game page's renderer is given", () => {
  const prefs = gameViewPreferences("game-session", false);

  it("has no on-device speech recognition, whose missing binder kills the whole renderer", () => {
    // Both, never one: OnDeviceWebSpeechAvailable alone leaves
    // install({ processLocally: true }) killing the page, and InstallOnDeviceSpeechRecognition
    // alone leaves available() and a processLocally start() doing it.
    assert.ok(
      GAME_DISABLED_BLINK_FEATURES.includes("OnDeviceWebSpeechAvailable"),
      "available() and processLocally are back",
    );
    assert.ok(GAME_DISABLED_BLINK_FEATURES.includes("InstallOnDeviceSpeechRecognition"), "install() is back");
    assert.deepEqual(
      prefs.disableBlinkFeatures.split(","),
      [...GAME_DISABLED_BLINK_FEATURES],
      "the game view does not apply the list",
    );
  });

  it("keeps the sandbox it had, on the game session, and never gets a preload", () => {
    assert.equal(prefs.session, "game-session");
    assert.deepEqual(
      [prefs.sandbox, prefs.contextIsolation, prefs.nodeIntegration, prefs.webSecurity],
      [true, true, false, true],
    );
    assert.ok(!("preload" in prefs), "a game page must never get a preload");
    assert.equal(gameViewPreferences("s", true).offscreen, true);
  });
});

describe("the studio's input dispatch", () => {
  /** The page half of `preview.ts`: the very string it hands `executeJavaScript`, evaluated here. */
  const dispatch = new Function(`return (${PAGE_DISPATCH});`)() as (payload: unknown) => boolean;

  /** A page with the shim's clock and a canvas. */
  function page() {
    const moved: Array<{ dx: number; dy: number }> = [];
    const canvas = { dispatchEvent: () => true };
    const globals = globalThis as unknown as Record<string, unknown>;
    const before = {
      window: globals.window,
      document: globals.document,
      MouseEvent: globals.MouseEvent,
      PointerEvent: globals.PointerEvent,
    };
    const window = {
      __studioClock: { mouseMove: (dx: number, dy: number) => void moved.push({ dx, dy }) },
      __studioTrustedTypes: {},
    };
    globals.window = window;
    globals.document = { querySelector: () => canvas, activeElement: null };
    globals.MouseEvent = class {};
    globals.PointerEvent = class {};
    const restore = () => Object.assign(globals, before);
    return { window, moved, restore };
  }

  it("moves the mouse with its real delta", () => {
    const p = page();
    try {
      dispatch({ dom: [{ kind: "mouse", type: "mousemove", x: 4, y: 8, movementX: 90, movementY: -5 }] });
      assert.deepEqual(p.moved, [{ dx: 90, dy: -5 }]);
    } finally {
      p.restore();
    }
  });
});

describe("canvas kinds", () => {
  it("names the context a page asked for", () => {
    assert.equal(contextKind("2d"), "2d");
    assert.equal(contextKind("webgl"), "webgl");
    assert.equal(contextKind("experimental-webgl"), "webgl");
    assert.equal(contextKind("webgl2"), "webgl2");
    assert.equal(contextKind("webgpu"), "webgpu");
    assert.equal(contextKind("bitmaprenderer"), "unknown");
  });
});

it("budgets GPU error drains to one per thirty frames", () => {
  let reads = 0;
  const frame = glDrainBudget(() => {
    reads++;
  });
  for (let i = 0; i < 90; i++) frame();
  assert.equal(reads, 3);
});
