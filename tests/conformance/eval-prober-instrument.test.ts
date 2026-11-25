/**
 * The page instrument's pointer-lock shim, camera ring, post-lock look record and fullscreen door,
 * replayed with no browser. `probeInitSource()` is one self-contained IIFE, so it runs inside a
 * `node:vm` context offering exactly the DOM surface the instrument reaches for: a
 * `Document.prototype` with a real `pointerLockElement` getter to shadow, an
 * `Element.prototype.requestPointerLock` that counts the calls reaching it (the instrument must
 * make none: the real one takes the cursor), a window whose listeners the test fires directly, a
 * WebGPU queue whose writes carry a view matrix, and a manual timer queue. Ported from genex-demo's
 * `prober/instrument.test.ts`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import vm from "node:vm";
import { probeInitSource } from "../../scripts/evals/prober/instrument.ts";
import { MIRROR_CELLS } from "../../scripts/evals/prober/phases/baseline.ts";
import { yawSweepDeg } from "../../scripts/evals/prober/verdicts.ts";

type Listener = (e: Record<string, unknown>) => void;

type CameraSnapshot = {
  readonly frames: number;
  readonly retained: number;
  readonly ringCap: number;
  readonly firstSampleT: number | null;
  readonly samples: Array<{ t: number; fx: number; fz: number }>;
};
type LookSnapshot = {
  readonly windowMs: number;
  readonly samples: number;
  readonly headings: number;
  readonly firstT: number | null;
  readonly lastT: number | null;
  readonly sweepDeg: number;
  readonly mouseSweepDeg: number;
  readonly mouseSteps: number;
  readonly mouseStepsUnattributable: number;
  readonly lastMoveT: number | null;
};

type Harness = {
  readonly ctx: vm.Context;
  readonly fire: (type: string, init: Record<string, unknown>) => Record<string, unknown>;
  readonly timers: Array<{ fn: () => void; ms: number }>;
  readonly flushTimers: () => void;
  readonly element: { requestPointerLock: () => unknown; requestFullscreen?: () => Promise<void> };
  /** How many calls reached the browser's own `requestPointerLock`, the one that takes the real cursor. */
  readonly realLockRequests: () => number;
  readonly snapshot: () => {
    pointerLock: Record<string, unknown> & { look: LookSnapshot };
    camera: CameraSnapshot;
    fullscreen: Record<string, unknown>;
    frames: { mirrorWidth: number; mirrorHeight: number };
  };
  readonly document: { pointerLockElement: unknown; exitPointerLock: () => void };
  /** Set the page clock (`performance.now()`), in ms. */
  readonly setClock: (t: number) => void;
  /**
   * Feed one camera sample through the REAL WebGPU route: write a view matrix
   * whose forward axis has the given ground heading, then run one animation
   * frame so the instrument's flusher takes it. `heading: null` writes a
   * matrix looking straight down, which has no ground heading at all.
   */
  readonly cameraFrame: (t: number, headingDeg: number | null) => void;
};

/** The page's navigator: no activation API, an API with no `isActive`, or one that answers. */
function navigatorFor(activation: boolean | null | undefined): Record<string, unknown> {
  if (activation === undefined) return {};
  if (activation === null) return { userActivation: {} };
  return { userActivation: { isActive: activation } };
}

function boot(opts: {
  refuse: "reject" | "hang" | "grant";
  userActivation?: boolean | null;
  fullscreen?: "reject" | "grant" | "absent";
}): Harness {
  const winListeners = new Map<string, Listener[]>();
  const docListeners = new Map<string, Listener[]>();
  const timers: Harness["timers"] = [];
  const on = (store: Map<string, Listener[]>) => (type: string, fn: Listener) => {
    store.set(type, [...(store.get(type) ?? []), fn]);
  };
  class Event {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  }
  class Document {}
  let realLocked: unknown = null;
  let realLockRequests = 0;
  Object.defineProperty(Document.prototype, "pointerLockElement", {
    configurable: true,
    get() {
      return realLocked;
    },
  });
  let realFullscreen: unknown = null;
  class Element {
    requestPointerLock(): unknown {
      realLockRequests += 1;
      if (opts.refuse === "reject") {
        return Promise.reject(
          new Error("WrongDocumentError: The root document of this element is not valid for pointer lock."),
        );
      }
      if (opts.refuse === "grant") {
        realLocked = this;
        return Promise.resolve();
      }
      return undefined; // the legacy void signature: neither resolves nor rejects
    }
  }
  // The fullscreen door: absent entirely (an older engine), refusing the way
  // Chromium does without a gesture, or granting and setting the element.
  if (opts.fullscreen !== "absent") {
    (Element.prototype as unknown as { requestFullscreen: () => Promise<void> }).requestFullscreen = function (
      this: unknown,
    ) {
      if (opts.fullscreen === "grant") {
        realFullscreen = this;
        return Promise.resolve();
      }
      return Promise.reject(new TypeError("Permissions check failed"));
    };
  }
  class HTMLCanvasElement {
    getContext(): null {
      return null;
    }
  }
  // The WebGPU camera route: the instrument patches `GPUQueue.prototype.writeBuffer`
  // and offers the ONE stable address that keeps changing as the view matrix.
  class GPUQueue {
    writeBuffer(): void {}
  }
  let clock = 1234.5;
  // A rAF that queues instead of calling back: the instrument's own sampling
  // loop must not keep this process alive, and a test fires exactly the frame
  // it registered.
  const rafQueue: Array<(ts: number) => void> = [];
  const document = Object.assign(Object.create(Document.prototype), {
    addEventListener: on(docListeners),
    dispatchEvent(e: { type: string }) {
      for (const fn of docListeners.get(e.type) ?? []) fn(e as unknown as Record<string, unknown>);
      return true;
    },
    exitPointerLock() {
      realLocked = null;
    },
    getElementsByTagName: () => [],
  });
  // An ACCESSOR, defined after the assign: `Object.assign` copies a getter's value at
  // assign time, which would have frozen `fullscreenElement` at null.
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => realFullscreen });
  const sandbox: Record<string, unknown> = {
    document,
    Document,
    Element,
    Event,
    HTMLCanvasElement,
    location: { href: "https://quiet-village.example.test/" },
    performance: { now: () => clock },
    GPUQueue,
    navigator: navigatorFor(opts.userActivation),
    addEventListener: on(winListeners),
    requestAnimationFrame: (cb: (ts: number) => void) => rafQueue.push(cb),
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    JSON,
    Math,
    Date,
    Object,
    Array,
    Promise,
    String,
    Number,
    WeakMap,
    WeakSet,
    Float32Array,
    ArrayBuffer,
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(probeInitSource(), ctx);
  const probe = sandbox.__GENEX_PROBE__ as { snapshot: () => ReturnType<Harness["snapshot"]> };
  assert.ok(probe, "the instrument installed");
  const queue = Object.create(GPUQueue.prototype) as {
    writeBuffer: (b: object, off: number, data: Float32Array) => void;
  };
  const viewBuffer = {};
  let matrixSeq = 0;
  const cameraFrame = (t: number, headingDeg: number | null) => {
    clock = t;
    // Column-major world-to-camera matrix: the instrument reads the forward
    // axis as -(third row of R) = (-m[2], -m[6], -m[10]) and m[15] = 1 marks
    // it affine. m[12] carries a per-frame nonce so every write is a change.
    const m = new Float32Array(16);
    if (headingDeg === null) {
      m[6] = 1; // forward straight down: no ground heading
    } else {
      m[2] = -Math.sin((headingDeg * Math.PI) / 180);
      m[10] = -Math.cos((headingDeg * Math.PI) / 180);
    }
    m[12] = ++matrixSeq;
    m[15] = 1;
    queue.writeBuffer(viewBuffer, 0, m);
    // Register through the PATCHED rAF (the instrument replaced the sandbox's),
    // then run what it queued: the flushers fire on a new timestamp.
    const raf = sandbox.requestAnimationFrame as (cb: (ts: number) => void) => number;
    raf(() => {});
    for (const cb of rafQueue.splice(0)) cb(t);
  };
  return {
    setClock: (t) => {
      clock = t;
    },
    cameraFrame,
    ctx,
    timers,
    flushTimers: () => {
      const due = timers.splice(0);
      for (const t of due) t.fn();
    },
    fire: (type, init) => {
      const e = { type, ...init };
      for (const fn of winListeners.get(type) ?? []) fn(e);
      return e;
    },
    element: new Element(),
    realLockRequests: () => realLockRequests,
    snapshot: () => probe.snapshot(),
    document: document as Harness["document"],
  };
}

const tick = () => setImmediate();

test("a request engages the synthetic lock, records the activation state, and reports the door", async () => {
  const h = boot({ refuse: "reject", userActivation: true });
  const ret = h.element.requestPointerLock() as Promise<unknown>;
  assert.equal(h.snapshot().pointerLock.locked, false, "granted a moment later, as a browser grants");
  await ret; // resolved once the lock is held
  const pl = h.snapshot().pointerLock;
  assert.equal(pl.requested, 1);
  assert.equal(pl.grantedNatively, false);
  assert.equal(pl.shimmed, true);
  assert.equal(pl.locked, true);
  assert.equal(pl.userActivationAtRequest, true);
  assert.equal(pl.requestsWithActivation, 1);
  assert.equal(h.document.pointerLockElement, h.element, "the shadowed getter reports the synthetic element");
  assert.deepEqual([pl.movesWhileLocked, pl.deltasNative, pl.deltasSupplied], [0, 0, 0], "nothing moved yet");
});

test("THE MEASURED CASE: browser-supplied deltas count as native, and the fallback never fires for them", async () => {
  const h = boot({ refuse: "reject", userActivation: true });
  h.element.requestPointerLock();
  await tick();
  // Blink derives movementX/Y from consecutive positions for CDP-dispatched
  // moves — the bare run's camera turned with the fallback at zero.
  const e = h.fire("mousemove", { clientX: 100, clientY: 100, movementX: 12, movementY: -3 });
  assert.equal(e.movementX, 12, "a supplied delta is never second-guessed");
  const pl = h.snapshot().pointerLock;
  assert.equal(pl.movesWhileLocked, 1);
  assert.equal(pl.deltasNative, 1);
  assert.equal(pl.deltasSupplied, 0);
});

test("the fallback fills a zero delta from the previous position, PER EVENT TYPE, on all three move events", async () => {
  const h = boot({ refuse: "reject", userActivation: false });
  h.element.requestPointerLock();
  await tick();
  // First position per type: nothing to diff against, so no delta is supplied.
  for (const type of ["pointerrawupdate", "pointermove", "mousemove"]) {
    const first = h.fire(type, { clientX: 100, clientY: 100, movementX: 0, movementY: 0 });
    assert.equal(first.movementX, 0, `${type}: no previous position`);
  }
  // One physical move fires all three; each must get the SAME delta. A shared
  // last-position would hand the delta to the first type and zeroes to the rest.
  const patched = ["pointerrawupdate", "pointermove", "mousemove"].map((type) =>
    h.fire(type, { clientX: 130, clientY: 90, movementX: 0, movementY: 0 }),
  );
  for (const e of patched) {
    assert.equal(e.movementX, 30, `${e.type} movementX`);
    assert.equal(e.movementY, -10, `${e.type} movementY`);
  }
  const pl = h.snapshot().pointerLock;
  assert.equal(pl.movesWhileLocked, 6);
  assert.equal(pl.deltasNative, 0);
  assert.equal(pl.deltasSupplied, 3);
  assert.equal(pl.userActivationAtRequest, false, "asked with no activation live");
  assert.equal(pl.requestsWithActivation, 0);
});

test("nothing is counted or patched while no synthetic lock is held, and an exit stops the counting", async () => {
  const h = boot({ refuse: "reject", userActivation: null });
  // Before any request: the listeners are not even installed.
  h.fire("mousemove", { clientX: 1, clientY: 1, movementX: 0, movementY: 0 });
  assert.equal(h.snapshot().pointerLock.movesWhileLocked, 0);
  h.element.requestPointerLock();
  await tick();
  h.fire("mousemove", { clientX: 5, clientY: 5, movementX: 0, movementY: 0 });
  h.fire("mousemove", { clientX: 9, clientY: 5, movementX: 0, movementY: 0 });
  assert.equal(h.snapshot().pointerLock.deltasSupplied, 1);
  h.document.exitPointerLock();
  const after = h.fire("mousemove", { clientX: 20, clientY: 5, movementX: 0, movementY: 0 });
  assert.equal(after.movementX, 0, "unlocked: the event keeps its zero");
  const pl = h.snapshot().pointerLock;
  assert.equal(pl.locked, false);
  assert.equal(pl.exits, 1);
  assert.equal(pl.movesWhileLocked, 2);
  assert.equal(pl.userActivationAtRequest, null, "an absent isActive is null, never false");
});

test("a page's request never reaches the browser, whatever it would answer: the synthetic lock engages at once", async () => {
  for (const refuse of ["reject", "hang", "grant"] as const) {
    const h = boot({ refuse, userActivation: true });
    const ret = h.element.requestPointerLock() as Promise<unknown>;
    assert.equal(typeof ret.then, "function", `${refuse}: the caller gets a promise`);
    await ret;
    await tick();
    assert.equal(h.realLockRequests(), 0, `${refuse}: the browser's own lock takes the real cursor of whoever is here`);
    assert.equal(h.timers.length, 0, `${refuse}: no grace period waits on a browser that is never asked`);
    const pl = h.snapshot().pointerLock;
    assert.deepEqual(
      [pl.requested, pl.shimmed, pl.locked, pl.grantedNatively],
      [1, true, true, false],
      `${refuse}: requested, shimmed, locked, grantedNatively`,
    );
    assert.equal(h.document.pointerLockElement, h.element, `${refuse}: the page sees its element locked`);
  }
});

test("the frame mirror has the cells the change floors are sized in", () => {
  const { frames } = boot({ refuse: "reject" }).snapshot();
  assert.equal(frames.mirrorWidth * frames.mirrorHeight, MIRROR_CELLS);
});

/* ------------------------------------------------ the camera ring + the look record */

/**
 * The WebGPU flusher offers an address only once it has been rewritten with a
 * change three times, so the first three frames of every sequence below take
 * no sample. `prime()` spends them before the lock, where they are not
 * observed either.
 */
function prime(h: Harness): void {
  for (let i = 0; i < 4; i++) h.cameraFrame(100 + i * 10, 0);
}

test("THE BLOCKING CASE: the sample buffer is a RING — the snapshot carries the newest samples, not the first ones", () => {
  const h = boot({ refuse: "reject" });
  prime(h);
  const before = h.snapshot().camera;
  assert.equal(before.frames, 1, "three primes to earn the address, one sample");
  assert.equal(before.firstSampleT, 130);
  for (let i = 0; i < 1300; i++) h.cameraFrame(1000 + i * 10, i % 360);
  const c = h.snapshot().camera;
  assert.equal(c.ringCap, 1200);
  assert.equal(c.frames, 1301);
  assert.equal(c.retained, 1200);
  assert.equal(c.samples.length, 1200);
  assert.equal(c.samples[0].t, 1000 + 100 * 10, "the oldest retained sample is #102 of 1,301 (loop index 100), not #1");
  assert.equal(c.samples[1199].t, 1000 + 1299 * 10, "the newest sample is the camera NOW — what readCamera() reads");
  assert.equal(c.firstSampleT, 130, "the first sample ever taken is kept by value, the ring having dropped it");
  for (let i = 1; i < c.samples.length; i++) assert.ok(c.samples[i].t > c.samples[i - 1].t, "oldest first");
});

test("the look record starts at the lock: samples before it are not observed, samples after it all are", async () => {
  const h = boot({ refuse: "reject", userActivation: true });
  prime(h);
  for (let i = 0; i < 20; i++) h.cameraFrame(500 + i * 10, i * 5);
  assert.equal(
    h.snapshot().pointerLock.look.samples,
    0,
    "a heading that swept before the lock is not post-lock evidence",
  );
  h.setClock(1000);
  h.element.requestPointerLock();
  await tick();
  assert.equal(h.snapshot().pointerLock.engagedAtMs, 1000);
  for (let i = 0; i < 1500; i++) h.cameraFrame(1100 + i * 10, 0);
  const L = h.snapshot().pointerLock.look;
  assert.equal(L.samples, 1500, "every post-lock sample counted — 300 more than the ring can hold");
  assert.equal(L.headings, 1500);
  assert.equal(L.firstT, 1100);
  assert.equal(L.lastT, 1100 + 1499 * 10);
  assert.equal(L.sweepDeg, 0);
  assert.equal(h.snapshot().camera.retained, 1200);
});

test("a yaw observed and then FROZEN stays observed: the record does not forget what the ring dropped", async () => {
  // The reviewer's case: a shimmed FollowCamera game that turned on the
  // directions drag and froze two minutes later. Under the first cut the
  // retained slice held only the frozen tail and the yaw was gone.
  const h = boot({ refuse: "reject", userActivation: true });
  prime(h);
  h.setClock(1000);
  h.element.requestPointerLock();
  await tick();
  // The drag: a locked move, then the camera turns 40° over the next frames.
  h.setClock(1100);
  h.fire("pointermove", { clientX: 100, clientY: 100, movementX: 30, movementY: 0 });
  for (let i = 0; i <= 4; i++) h.cameraFrame(1200 + i * 100, i * 10);
  // Then frozen for 2,000 frames — far past the ring.
  for (let i = 0; i < 2000; i++) h.cameraFrame(2000 + i * 100, 40);
  const L = h.snapshot().pointerLock.look;
  // Float32 view matrices: the heading comes back within ~1e-5° of what went in.
  assert.ok(Math.abs(L.sweepDeg - 40) < 1e-3, `sweep ${L.sweepDeg}`);
  assert.ok(Math.abs(L.mouseSweepDeg - 40) < 1e-3, `the four steps after the move are the mouse's: ${L.mouseSweepDeg}`);
  assert.equal(L.mouseSteps, 4);
  assert.equal(L.mouseStepsUnattributable, 0);
  const retained = h.snapshot().camera.samples;
  assert.equal(
    yawSweepDeg(retained),
    0,
    "the retained window is all frozen tail: the batch reading that demoted this run",
  );
});

test("the heading is attributed to the mouse only inside the window after a locked move, and a step longer than the window is named, not guessed", async () => {
  const h = boot({ refuse: "reject", userActivation: true });
  prime(h);
  h.setClock(1000);
  h.element.requestPointerLock();
  await tick();
  assert.equal(h.snapshot().pointerLock.look.windowMs, 500);
  h.cameraFrame(1000, 0);
  h.cameraFrame(1100, 0);
  h.setClock(1150);
  h.fire("mousemove", { clientX: 100, clientY: 100, movementX: 12, movementY: 0 });
  assert.equal(h.snapshot().pointerLock.look.lastMoveT, 1150);
  h.cameraFrame(1200, 20); // prev 1100: the move landed in (600, 1200], span 100 — the mouse's
  h.cameraFrame(1300, 30); // prev 1200: move at 1150 > 700, span 100 — the mouse's
  h.cameraFrame(1900, 60); // prev 1300: move at 1150 > 800, but the step spans 600 > 500 — unattributable
  h.cameraFrame(2000, 90); // prev 1900: 1150 is not > 1400 — a turn with no mouse behind it
  const L = h.snapshot().pointerLock.look;
  assert.equal(L.headings, 6);
  assert.ok(Math.abs(L.sweepDeg - 90) < 1e-3, `the total sweep counts every step: ${L.sweepDeg}`);
  assert.ok(
    Math.abs(L.mouseSweepDeg - 30) < 1e-3,
    `only the two steps inside the window are delivery: ${L.mouseSweepDeg}`,
  );
  assert.equal(L.mouseSteps, 2);
  assert.equal(L.mouseStepsUnattributable, 1);
  // A move while UNLOCKED stamps nothing: the listener counts only under the lock.
  h.document.exitPointerLock();
  h.setClock(2100);
  h.fire("mousemove", { clientX: 200, clientY: 100, movementX: 12, movementY: 0 });
  assert.equal(h.snapshot().pointerLock.look.lastMoveT, 1150);
});

test("the incremental sweep in the instrument equals the batch yawSweepDeg over the same samples, across a full turn and the ±180° seam", async () => {
  const h = boot({ refuse: "reject", userActivation: true });
  prime(h);
  h.setClock(1000);
  h.element.requestPointerLock();
  await tick();
  const headings = [178, -178, 178, -179, 0, 90, 180, 270, 360, 450, 300, 200];
  for (const [i, deg] of headings.entries()) h.cameraFrame(1000 + i * 10, deg);
  const snap = h.snapshot();
  // The ring still holds the prime sample from before the lock; the record
  // starts at the lock, so the batch reads the post-lock samples only.
  const postLock = snap.camera.samples.filter((s) => s.t >= 1000);
  assert.equal(postLock.length, headings.length);
  const batch = yawSweepDeg(postLock) ?? NaN;
  assert.ok(
    Math.abs(snap.pointerLock.look.sweepDeg - batch) < 1e-6,
    `instrument ${snap.pointerLock.look.sweepDeg} vs batch ${batch}`,
  );
  // 178→-178 is +4 the short way, -179→0 is +179, 180→270→360→450 is three
  // +90s through the seam, then -150 and -100: the accumulator peaks at 632.
  assert.ok(Math.abs(batch - 632) < 1e-3, `632° of accumulated turn: ${batch}`);
});

test("a sample with no ground heading is a sample and not a heading, and yields no step", async () => {
  const h = boot({ refuse: "reject", userActivation: true });
  prime(h);
  h.setClock(1000);
  h.element.requestPointerLock();
  await tick();
  h.cameraFrame(1000, 0);
  h.cameraFrame(1010, null);
  h.cameraFrame(1020, null);
  h.cameraFrame(1030, 30);
  const L = h.snapshot().pointerLock.look;
  assert.equal(L.samples, 4);
  assert.equal(L.headings, 2);
  assert.ok(Math.abs(L.sweepDeg - 30) < 1e-3, `the step is taken between the two readable headings: ${L.sweepDeg}`);
});

/* ------------------------------------------------------------ the fullscreen door */

/** Call the patched `requestFullscreen` the way a game would. */
function requestFullscreen(h: Harness): Promise<void> {
  const request = h.element.requestFullscreen;
  assert.ok(request, "the engine offers requestFullscreen");
  return request.call(h.element);
}

test("FULLSCREEN, INSTRUMENT ONLY: a refused request is counted with its refusal and the activation state, and NOTHING is shimmed", async () => {
  const h = boot({ refuse: "reject", userActivation: false, fullscreen: "reject" });
  assert.deepEqual(
    h.snapshot().fullscreen,
    {
      requested: 0,
      granted: false,
      firstRequestAtMs: null,
      userActivationAtRequest: null,
      requestsWithActivation: 0,
      lastRefusal: null,
      refusals: 0,
    },
    "never asked: nothing recorded",
  );
  h.setClock(2000);
  let sawRejection = false;
  // The game's own catch still runs: the promise is observed, never replaced.
  await requestFullscreen(h).catch(() => {
    sawRejection = true;
  });
  await tick();
  assert.equal(sawRejection, true, "the game sees exactly what the browser did");
  const fs = h.snapshot().fullscreen;
  assert.equal(fs.requested, 1);
  assert.equal(fs.granted, false);
  assert.equal(fs.firstRequestAtMs, 2000);
  assert.equal(fs.userActivationAtRequest, false);
  assert.equal(fs.requestsWithActivation, 0);
  assert.equal(fs.refusals, 1);
  assert.match(String(fs.lastRefusal), /requestFullscreen rejected: TypeError: Permissions check failed/);
  assert.equal(
    (h.document as unknown as { fullscreenElement: unknown }).fullscreenElement,
    null,
    "no shadowed getter, no synthetic element: not shimmed",
  );
  // A second ask with activation live is counted per request; the first-call record is not rewritten.
  const again = boot({ refuse: "reject", userActivation: true, fullscreen: "reject" });
  again.setClock(100);
  await requestFullscreen(again).catch(() => {});
  await requestFullscreen(again).catch(() => {});
  await tick();
  const two = again.snapshot().fullscreen;
  assert.equal(two.requested, 2);
  assert.equal(two.requestsWithActivation, 2);
  assert.equal(two.firstRequestAtMs, 100);
});

test("a GRANTED fullscreen is read from document.fullscreenElement after the promise, never from the promise alone; an engine without the API records nothing", async () => {
  const h = boot({ refuse: "reject", userActivation: true, fullscreen: "grant" });
  await requestFullscreen(h);
  await tick();
  const fs = h.snapshot().fullscreen;
  assert.equal(fs.requested, 1);
  assert.equal(fs.granted, true);
  assert.equal(fs.refusals, 0);
  assert.equal(fs.lastRefusal, null);
  const none = boot({ refuse: "reject", fullscreen: "absent" });
  assert.equal(none.element.requestFullscreen, undefined, "the patch never invents a method the engine lacks");
  assert.equal(none.snapshot().fullscreen.requested, 0);
});
