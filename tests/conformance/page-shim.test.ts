/**
 * The page shim's pure logic (M4.1) — the stepper, the timer queue, the seeded generator, the
 * pointer-lock arithmetic and the merging facade, all under node with no browser and no
 * Electron. Everything here is what makes `step(960)` mean the same thing to a game that never
 * heard of the studio as it does to the template.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PAGE_DISPATCH } from "../../src/main/page-dispatch.ts";
import { GAME_DISABLED_BLINK_FEATURES, gameViewPreferences } from "../../src/main/game-view.ts";
import { FlowPhase, installStudio, makeRng } from "../../src/game-template/src/studio.js";
import {
  AUTO_RESUME_MS,
  DEFAULT_SHIM_OPTIONS,
  MAX_INTERVAL_FIRES_PER_FRAME,
  NESTED_TIMER_MIN_MS,
  contextKind,
  glDrainBudget,
  createClock,
  createFacade,
  createPointerLock,
  FACADE_MEMBERS,
  hookedAnswers,
  installFacade,
  installPageGlobal,
  installSeededRandom,
  mulberry32,
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
    assert.equal(normalizeShimOptions({ seed: null }).seed, null);
    assert.equal(normalizeShimOptions({ readyMs: 1 }).readyMs, 1000);
    assert.equal(normalizeShimOptions({ readyMs: "nonsense" }).readyMs, DEFAULT_SHIM_OPTIONS.readyMs);
    assert.equal(normalizeShimOptions({ clock: "studio" }).clock, "studio");
    assert.equal(rig({ clock: "studio" }).clock.frozen(), true, "a studio-clock page is frozen from its first frame");
  });
});

describe("determinism", () => {
  it("is the same generator the template ships", () => {
    // Same seed, same stream: a game seeded by the shim and one seeded by its own contract
    // must photograph the same frame.
    for (const seed of [0, 1, 42, 0x9e3779b9, 2 ** 32 - 1]) {
      const shim = mulberry32(seed);
      const template = makeRng(seed);
      const a = Array.from({ length: 64 }, () => shim());
      const b = Array.from({ length: 64 }, () => template());
      assert.deepEqual(a, b, `seed ${seed}`);
    }
  });

  it("seeds at install, so a module-scope capture of Math.random is still reproducible", () => {
    const host = { Math: { random: () => 0.42 } };
    const seeded = installSeededRandom(host, 1);
    assert.equal(seeded.installed, true);
    // What a bundle does at module scope, before anyone calls seed(n).
    const captured = host.Math.random;
    assert.notEqual(captured(), 0.42);
    seeded.reseed(7);
    const first = [captured(), captured(), captured()];
    seeded.reseed(7);
    const second = [captured(), captured(), captured()];
    assert.deepEqual(first, second);
    seeded.reseed(8);
    assert.notDeepEqual([captured(), captured(), captured()], first);
    const reference = mulberry32(7);
    assert.deepEqual(first, [reference(), reference(), reference()]);
  });
});

describe("pointer lock", () => {
  it("answers locked whether or not Chromium granted it, and lets go when the user does", () => {
    let native: string | null = null;
    const events: string[] = [];
    const lock = createPointerLock({ nativeElement: () => native, dispatch: (type: string) => events.push(type) });
    assert.equal(lock.element(), null);
    lock.request("canvas");
    assert.equal(lock.locked(), true);
    assert.equal(lock.element(), "canvas");
    assert.deepEqual(events, ["pointerlockchange"]);
    native = "canvas";
    lock.onNativeChange();
    assert.equal(lock.element(), "canvas");
    assert.equal(lock.faked(), null, "a real lock retires the fake");
    native = null;
    lock.onNativeChange();
    assert.equal(lock.element(), null, "Esc must end the lock");
    lock.request("canvas");
    lock.exit();
    assert.equal(lock.element(), null);
  });
});

describe("the __studio facade", () => {
  const own = () => ({
    version: 1,
    hud: "shim-hud",
    state: () => ({ from: "shim" }),
    ready: (why: string) => ({ ready: true, why }),
    step: () => ({ ok: true, frames: 1 }),
    pause: () => true,
    start: () => true,
    seed: (n: number) => n,
    capture: () => "shim-capture",
    inspect: () => "shim-inspect",
    cameras: () => [],
    attached: () => false,
  });

  it("keeps every method a game defined, and fills in the ones it did not", () => {
    const target: Record<string, unknown> = {};
    installFacade(target, own());
    const game = Object.freeze({ inspect: () => "game-inspect", cameras: () => ["front"], hud: "game-hud" });
    assert.doesNotThrow(() => {
      (target as { __studio: unknown }).__studio = game;
    });
    const studio = target.__studio as Record<string, (arg?: unknown) => unknown> & {
      __shim: boolean;
      __game: unknown;
      hud: string;
    };
    assert.equal(studio.inspect(), "game-inspect");
    assert.deepEqual(studio.cameras(), ["front"]);
    assert.equal(studio.capture(), "shim-capture");
    assert.equal(studio.hud, "game-hud");
    assert.equal(studio.__shim, true);
    assert.equal(studio.__game, game);
    assert.deepEqual(studio.state(), { from: "shim" });
    assert.deepEqual(studio.ready("declared"), { ready: true, why: "declared" });
    assert.equal(Object.isFrozen(game), true, "the facade must never write to the game's object");
  });

  it("keeps a method the contract never named, because the harness reaches those by name", () => {
    const target: Record<string, unknown> = {};
    installFacade(target, own());
    (target as { __studio: unknown }).__studio = { fireTheSpecial: () => "fired", rounds: 3 };
    const studio = target.__studio as Record<string, unknown>;
    assert.equal((studio.fireTheSpecial as () => string)(), "fired");
    assert.equal(studio.rounds, 3);
    assert.equal(studio.somethingElse, undefined);
  });

  it("answers on a page that never heard of the contract", () => {
    const target: Record<string, unknown> = {};
    installFacade(target, own());
    const studio = target.__studio as Record<string, () => unknown>;
    assert.deepEqual(studio.state(), { from: "shim" });
    assert.equal(studio.capture(), "shim-capture");
    assert.equal(studio.inspect(), "shim-inspect");
  });

  it("never lets a hostile getter on the game's object throw at the studio", () => {
    const game = {
      get inspect() {
        throw new Error("no");
      },
    };
    const facade = createFacade({ own: own(), getAssigned: () => game }) as unknown as Record<string, () => unknown>;
    assert.equal(facade.inspect(), "shim-inspect");
  });
});

describe("begin() through the facade", () => {
  it("is the game's when it has one, and answers that it has none on every other page", () => {
    assert.ok(FACADE_MEMBERS.includes("begin"), "begin is a member the facade answers");
    const target: Record<string, unknown> = {};
    installFacade(target, { version: 1, hud: "shim-hud", state: () => ({}), ...hookedAnswers() });
    const studio = () => target.__studio as { begin(): { ok: boolean; reason?: string; flow?: unknown } };
    const none = studio().begin();
    assert.equal(none.ok, false, "a page that declares no begin() answers uniformly, never {__missing}");
    assert.match(String(none.reason), /no begin/);
    const flow = { phase: "playing", playing: true };
    (target as { __studio: unknown }).__studio = Object.freeze({ begin: () => ({ ok: true, flow }) });
    assert.deepEqual(studio().begin(), { ok: true, flow });
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

  /** A page with the shim's clock, a canvas, and whatever contract the test hands it. */
  function page(game: Record<string, unknown> | null) {
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
      __studio: null as unknown,
      __studioClock: { mouseMove: (dx: number, dy: number) => void moved.push({ dx, dy }) },
      __studioTrustedTypes: {},
    };
    installFacade(window, {
      version: 1,
      hud: undefined,
      state: () => ({}),
      ready: () => ({}),
      step: () => ({}),
      pause: () => true,
      start: () => true,
      seed: (n: number) => n,
      attached: () => false,
      // The shim's own injectInput records and never dispatches; it answers with a look too.
      injectInput: (input: { look?: { dx: number; dy: number } }) => ({
        keys: [],
        look: { x: input?.look?.dx ?? 0, y: 0 },
      }),
    } as never);
    if (game) (window as { __studio: unknown }).__studio = game;
    globals.window = window;
    globals.document = { querySelector: () => canvas, activeElement: null };
    globals.MouseEvent = class {};
    globals.PointerEvent = class {};
    const restore = () => Object.assign(globals, before);
    return { window, moved, restore };
  }

  it("hands the look to the contract once and still moves the mouse with its real delta", () => {
    const looks: number[] = [];
    // Both roads run: the contract is told, and the synthetic move keeps its movement — a game
    // that reads `movementX` itself and never reads `ctx.look` is the only thing that move is
    // for (tests/fixtures/games/bundled-ts turns its camera from a plain mousemove listener).
    // The de-duplication lives in the accumulator where the roads meet, not here.
    const p = page({
      injectInput: (input: { look?: { dx: number } }) => {
        looks.push(input?.look?.dx ?? 0);
        return { keys: [], look: { x: 0, y: 0 } };
      },
    });
    try {
      dispatch({
        studio: { look: { dx: 120, dy: 0 } },
        dom: [{ kind: "mouse", type: "mousemove", x: 10, y: 20, movementX: 120, movementY: 0 }],
      });
      assert.deepEqual(looks, [120], "the contract took the look once");
      assert.deepEqual(p.moved, [{ dx: 120, dy: 0 }], "the synthetic move carries the pointer AND the movement");
    } finally {
      p.restore();
    }
  });

  it("still moves the mouse for a page with no contract of its own", () => {
    const p = page(null);
    try {
      dispatch({
        studio: { look: { dx: 90, dy: -5 } },
        dom: [{ kind: "mouse", type: "mousemove", x: 4, y: 8, movementX: 90, movementY: -5 }],
      });
      assert.deepEqual(p.moved, [{ dx: 90, dy: -5 }], "a page with no contract is driven by the synthetic move alone");
    } finally {
      p.restore();
    }
  });

  it("keeps the synthetic move for a contract that does not answer with a look", () => {
    const p = page({ injectInput: () => ({ keys: [] }) });
    try {
      dispatch({
        studio: { look: { dx: 40, dy: 0 } },
        dom: [{ kind: "mouse", type: "mousemove", x: 1, y: 2, movementX: 40, movementY: 0 }],
      });
      assert.deepEqual(p.moved, [{ dx: 40, dy: 0 }]);
    } finally {
      p.restore();
    }
  });
});

describe("the contract's own look accumulator, where the roads meet", () => {
  /**
   * One look reaches a page carrying the studio's own contract by up to three roads:
   * `injectInput`, the synthetic move the studio dispatches for games with their own listener,
   * and — in an attended window — the browser's trusted move. All three used to feed the one
   * accumulator, so every camera turned two or three times as far as it was told to.
   */
  /** The template's own contract, installed on a fake page whose canvas holds the pointer lock. */
  function template() {
    const listeners = new Map<string, (event: Record<string, unknown>) => void>();
    const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
    const globals = globalThis as unknown as Record<string, unknown>;
    const before = { window: globals.window, document: globals.document };
    globals.window = {
      addEventListener: (type: string, fn: (event: Record<string, unknown>) => void) => void listeners.set(type, fn),
    };
    globals.document = { addEventListener: () => {}, querySelector: () => canvas, pointerLockElement: canvas };
    const restore = () => Object.assign(globals, before);
    try {
      const api = installStudio({ canvas, hud: false } as never) as {
        injectInput(input: unknown): { look: { x: number }; wheel: { y: number } };
      };
      const fire = (type: string, event: Record<string, unknown>) =>
        listeners.get(type)!({ clientX: 0, clientY: 0, preventDefault: () => {}, ...event });
      // An empty injection reads the accumulators without touching the beat counts.
      return { api, fire, restore, look: () => api.injectInput({}).look.x, wheel: () => api.injectInput({}).wheel.y };
    } catch (error) {
      restore();
      throw error;
    }
  }

  it("spends the beats the studio injected instead of adding them again", () => {
    const page = template();
    try {
      page.api.injectInput({ look: { dx: 120, dy: 0 } });
      page.fire("mousemove", { movementX: 120, movementY: 0 }); // the synthetic one
      page.fire("mousemove", { movementX: 120, movementY: 0 }); // the trusted one, in an attended window
      assert.equal(page.look(), 120, "one look, however many roads carried it");
      page.fire("mousemove", { movementX: 7, movementY: 0 }); // the user's own, after the harness let go
      assert.equal(page.look(), 127);
    } finally {
      page.restore();
    }
  });

  it("does the same for the wheel, which injectInput takes and onWheel used to add", () => {
    const page = template();
    try {
      page.api.injectInput({ wheel: { dx: 0, dy: 50 } });
      page.fire("wheel", { deltaX: 0, deltaY: 50 });
      page.fire("wheel", { deltaX: 0, deltaY: 50 });
      assert.equal(page.wheel(), 50);
      page.fire("wheel", { deltaX: 0, deltaY: 3 });
      assert.equal(page.wheel(), 53);
    } finally {
      page.restore();
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

describe("a game with a front-end: begin() takes it into play, flow says whether it is", () => {
  /** A title → countdown → race machine, the shape a racing game's front-end has. */
  function racer({ begin = true, flow = true }: { begin?: boolean; flow?: boolean } = {}) {
    const game = { phase: "menu", countdown: 0, x: 0 };
    return {
      fixedStepMs: 1000 / 60,
      reset() {
        game.phase = "menu";
        game.countdown = 0;
        game.x = 0;
      },
      update(dt: number, ctx: { keys: Set<string> }) {
        if (game.phase === "countdown") {
          game.countdown -= dt;
          if (game.countdown <= 0) game.phase = "playing";
        } else if (game.phase === "playing" && ctx.keys.has("w")) game.x += dt;
      },
      probes: () => ({ car: { x: game.x } }),
      ...(flow ? { flow: () => game.phase } : {}),
      ...(begin
        ? {
            begin() {
              game.phase = "playing";
              game.countdown = 0;
            },
          }
        : {}),
    };
  }

  type Api = {
    seed(n: number): number;
    step(ms?: number): unknown;
    state(): Record<string, unknown>;
    begin(): { ok: boolean; reason?: string; flow?: { phase: string; playing: boolean } | null };
  };

  /** The template installed on a fake page that keeps its globals until the test is done. */
  function install(config: Record<string, unknown>) {
    const globals = globalThis as unknown as Record<string, unknown>;
    const before = {
      window: globals.window,
      document: globals.document,
      requestAnimationFrame: globals.requestAnimationFrame,
    };
    globals.window = { addEventListener: () => {} };
    globals.document = { addEventListener: () => {}, querySelector: () => null };
    globals.requestAnimationFrame = () => 1;
    const restore = () => Object.assign(globals, before);
    try {
      return { api: installStudio({ hud: false, ...config } as never) as unknown as Api, restore };
    } catch (error) {
      restore();
      throw error;
    }
  }

  it("reports the game's first screen after a seed, and begin() leaves it in play, paused", () => {
    const { api, restore } = install(racer());
    try {
      api.seed(1);
      assert.deepEqual(api.state().flow, { phase: FlowPhase.Menu, playing: false });
      const began = api.begin();
      assert.deepEqual(began, { ok: true, flow: { phase: FlowPhase.Playing, playing: true } });
      assert.deepEqual(api.state().flow, { phase: "playing", playing: true });
      assert.equal(api.state().running, false, "begin() leaves the game paused, like a demo");
    } finally {
      restore();
    }
  });

  it("is deterministic: two seeds and two begins drive to the same state", () => {
    const { api, restore } = install(racer());
    try {
      const drive = () => {
        api.seed(7);
        api.begin();
        api.step(500);
        const { fps: _fps, ...rest } = api.state();
        return rest;
      };
      assert.deepEqual(drive(), drive());
    } finally {
      restore();
    }
  });

  it("changes nothing for a game that declares neither", () => {
    const { api, restore } = install(racer({ begin: false, flow: false }));
    try {
      api.seed(1);
      assert.equal("flow" in api.state(), false, "no flow key at all: an existing game's state is unchanged");
      const none = api.begin();
      assert.equal(none.ok, false);
      assert.match(String(none.reason), /config\.begin/);
    } finally {
      restore();
    }
  });

  it("answers no flow from begin() for a game that reports none, as state() does", () => {
    const { api, restore } = install(racer({ flow: false }));
    try {
      api.seed(1);
      assert.deepEqual(api.begin(), { ok: true, flow: null });
      assert.equal("flow" in api.state(), false);
    } finally {
      restore();
    }
  });

  it("names its phases in one frozen vocabulary", () => {
    assert.ok(Object.isFrozen(FlowPhase));
    assert.deepEqual(Object.values(FlowPhase), ["boot", "menu", "intro", "countdown", "playing", "paused", "results"]);
  });
});
