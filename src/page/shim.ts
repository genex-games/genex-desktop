import { animationGate } from "./animation-gate.ts";
/**
 * The page shim — the studio owns the clock (M4.1).
 *
 * The studio serves every game page itself, so it can put its own code on the page before a
 * single line of game code runs. That is what this file is. It takes over `performance.now`,
 * `Date.now`, `requestAnimationFrame` and — while the clock is frozen — the timers, so the
 * studio can pace a page between a player's moves and get exactly the frames it asked for.
 * It asks nothing of the game and changes nothing the game sees beyond time: no
 * `window.__studio`, no seeded `Math.random`, no faked pointer lock. The studio's own controls
 * live on `__studioClock`, `__studioCapture` and `__studioGl`.
 *
 * Everything here is a plain browser ES module with named exports: the pure logic (the stepper,
 * the timer queue, readiness) is built from injected dependencies and tested under `node --test`
 * with no Electron and no DOM.
 */
import { createFrameCapture } from "./capture.ts";
import { installStudioDrawCounters } from "./counters.ts";
import type { Foreign, PageGlobal } from "./foreign.ts";

/** The virtual clock's version — read by the studio before it trusts any of these verbs. */
export const CLOCK_VERSION = 1;

/** A `step()` never runs more frames than this, whatever it was asked for. */
export const MAX_STEP_FRAMES = 4096;
/** The most uncaught errors whose words the shim keeps; the count goes on past it. */
const MAX_UNCAUGHT_KEPT = 8;
/** The longest uncaught error message the shim keeps. */
const MAX_UNCAUGHT_CHARS = 300;
/** The longest span a single `step()` may simulate. */
export const MAX_STEP_MS = 60_000;
/** One repeating timer fires at most this many times in one simulated frame, so it cannot spin. */
export const MAX_INTERVAL_FIRES_PER_FRAME = 4;
/** Total timer callbacks in one simulated frame — the belt for a self-rescheduling `setTimeout`. */
export const MAX_TIMER_FIRES_PER_FRAME = 512;
/** A timer scheduled from inside a timer callback waits at least this long — the HTML nesting clamp. */
export const NESTED_TIMER_MIN_MS = 4;
/** Our timer handles start here so they never collide with the host's own. */
const TIMER_HANDLE_BASE = 500_000_000;
/** How long the timer that stands in for an animation frame waits, on a page that has none. */
const FALLBACK_FRAME_MS = 16;
/** A page left frozen with nobody stepping it starts itself again after this long. */
export const AUTO_RESUME_MS = 20_000;
/** What the shim says about a page that was still booting when its budget ran out. */
export const BOOT_BUDGET_SPENT = "the page was still booting when its boot budget ran out";

export const DEFAULT_SHIM_OPTIONS = Object.freeze({
  clock: "wall",
  frameMs: 1000 / 60,
  readyMs: 15_000,
  quietMs: 250,
  counters: true,
  maxTimers: 4096,
});

/** Whatever the serve layer sent, made safe. An older studio that sends nothing gets the defaults. */
export function normalizeShimOptions(raw: Foreign) {
  const input = raw && typeof raw === "object" ? raw : {};
  const num = (value: Foreign, fallback: Foreign, min: Foreign, max: Foreign) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    clock: input.clock === "studio" ? "studio" : "wall",
    frameMs: num(input.frameMs, DEFAULT_SHIM_OPTIONS.frameMs, 1, 1000),
    readyMs: num(input.readyMs, DEFAULT_SHIM_OPTIONS.readyMs, 1000, 600_000),
    quietMs: num(input.quietMs, DEFAULT_SHIM_OPTIONS.quietMs, 0, 10_000),
    counters: input.counters !== false,
    maxTimers: Math.round(num(input.maxTimers, DEFAULT_SHIM_OPTIONS.maxTimers, 16, 65_536)),
  };
}

/** How many recent frame rates `fps()` averages. */
const FPS_SAMPLES = 120;

/** An animation-frame callback the page registered, and the native frame it is armed on. */
interface RafEntry {
  id: number;
  cb: Foreign;
  native: Foreign;
}

/** A page timer, fired from the native clock while live and from `step()` while frozen. */
interface TimerEntry {
  handle: number;
  fn: Foreign;
  args: Foreign;
  delayMs: number;
  repeat: Foreign;
  due: number;
  native: Foreign;
  seq: number;
}

/** Everything the virtual clock knows: the natives, where time stands, and what is waiting on it. */
interface Clock {
  host: Foreign;
  options: ReturnType<typeof normalizeShimOptions>;
  frameMs: number;
  report: (err: Foreign) => void;
  dateBase: number;
  offset: number;
  pinned: number;
  frozen: boolean;
  frames: number;
  steppedFrames: number;
  lastFrame: number;
  autoResumes: number;
  lastFreezeTouch: number;
  installedAt: number;
  rafEntries: Map<number, RafEntry>;
  nextRafId: number;
  /** The entries the browser will call in the frame the pump just opened. */
  frameSet: Set<RafEntry> | null;
  timers: Map<number, TimerEntry>;
  nextTimer: number;
  overflow: number;
  seq: number;
  /** True while a timer callback is running: what a nested `setTimeout` is recognised by. */
  firing: boolean;
  afterFrameSubscribers: Set<() => void>;
  fpsSamples: number[];
}

const nativeNow = (k: Clock) => k.host.now();
const virtualNow = (k: Clock) => (k.frozen ? k.pinned : nativeNow(k) + k.offset);

// ── animation frames ───────────────────────────────────────────────────────
function arm(k: Clock, entry: RafEntry) {
  entry.native = k.host.raf(() => {
    entry.native = null;
    k.rafEntries.delete(entry.id);
    try {
      entry.cb(virtualNow(k));
    } catch (err) {
      k.report(err);
    } finally {
      settle(k, entry);
    }
  });
}

function settle(k: Clock, entry: RafEntry) {
  if (!k.frameSet) return;
  if (k.frameSet.delete(entry) && k.frameSet.size === 0) {
    k.frameSet = null;
    closeFrame(k, false);
  }
}

function requestFrame(k: Clock, cb: Foreign) {
  if (typeof cb !== "function") throw new TypeError("requestAnimationFrame expects a function");
  const entry: RafEntry = { id: k.nextRafId++, cb, native: null };
  k.rafEntries.set(entry.id, entry);
  if (!k.frozen) arm(k, entry);
  return entry.id;
}

function cancelFrame(k: Clock, id: Foreign) {
  const entry = k.rafEntries.get(id);
  if (!entry) return;
  if (entry.native != null) k.host.cancelRaf(entry.native);
  k.rafEntries.delete(id);
  settle(k, entry);
}

// ── timers ─────────────────────────────────────────────────────────────────
function schedule(k: Clock, fn: Foreign, delay: Foreign, args: Foreign, repeat: Foreign) {
  if (typeof fn !== "function" || k.timers.size >= k.options.maxTimers) {
    k.overflow += typeof fn === "function" ? 1 : 0;
    return repeat ? k.host.setInterval(fn, delay, ...args) : k.host.setTimeout(fn, delay, ...args);
  }
  // The browser's nesting clamp, modelled. A one-shot `setTimeout(loop, 0)` that reschedules
  // itself is a new entry with a new handle every time, so the per-handle interval cap never
  // applies to it and the only bound left was the frame budget: 512 fires per simulated
  // frame, about eight minutes of game logic inside one `step(960)`. The HTML spec gives a
  // nested chain a 4 ms floor, and so does this.
  const asked = Math.max(0, Number(delay) || 0);
  const delayMs = k.firing && asked < NESTED_TIMER_MIN_MS ? NESTED_TIMER_MIN_MS : asked;
  const entry: TimerEntry = {
    handle: k.nextTimer++,
    fn,
    args,
    delayMs,
    repeat,
    due: virtualNow(k) + delayMs,
    native: null,
    seq: k.seq++,
  };
  k.timers.set(entry.handle, entry);
  if (!k.frozen) armTimer(k, entry);
  return entry.handle;
}

function armTimer(k: Clock, entry: TimerEntry) {
  const wait = Math.max(0, entry.due - virtualNow(k));
  entry.native = k.host.setTimeout(() => {
    entry.native = null;
    fire(k, entry);
    if (entry.repeat && k.timers.get(entry.handle) === entry) {
      entry.due = virtualNow(k) + entry.delayMs;
      if (!k.frozen) armTimer(k, entry);
    }
  }, wait);
}

function fire(k: Clock, entry: TimerEntry) {
  if (!entry.repeat) k.timers.delete(entry.handle);
  const nested = k.firing;
  k.firing = true;
  try {
    entry.fn(...entry.args);
  } catch (err) {
    k.report(err);
  } finally {
    k.firing = nested;
  }
}

function clearTimerEntry(k: Clock, handle: Foreign) {
  const entry = k.timers.get(handle);
  if (!entry) {
    k.host.clearTimeout(handle);
    if (k.host.clearInterval) k.host.clearInterval(handle);
    return;
  }
  if (entry.native != null) k.host.clearTimeout(entry.native);
  k.timers.delete(handle);
}

/** Does `entry` fire before `next`: earlier, or as early and scheduled first? */
const firesBefore = (entry: TimerEntry, next: TimerEntry | null) =>
  !next || entry.due < next.due || (entry.due === next.due && entry.seq < next.seq);

/** The timer due first inside this frame that is not capped for it, or null. */
function nextDueTimer(k: Clock, capped: Set<number>): TimerEntry | null {
  let next: TimerEntry | null = null;
  for (const entry of k.timers.values()) {
    if (entry.due > k.pinned || capped.has(entry.handle)) continue;
    if (firesBefore(entry, next)) next = entry;
  }
  return next;
}

/**
 * Run every timer that has come due inside this simulated frame, in due order. A repeating
 * timer fires at most four times PER FRAME rather than per `step()` call, so `step(60000)`
 * still owes a 16 ms interval its ~3750 fires while `setInterval(f, 0)` cannot spin.
 */
function runDueTimers(k: Clock) {
  const fired = new Map<number, number>();
  const capped = new Set<number>();
  let total = 0;
  for (;;) {
    const next = nextDueTimer(k, capped);
    if (!next || total >= MAX_TIMER_FIRES_PER_FRAME) return;
    const count = (fired.get(next.handle) ?? 0) + 1;
    if (next.repeat && count > MAX_INTERVAL_FIRES_PER_FRAME) {
      capped.add(next.handle);
      // Resync rather than build a backlog: it owes four fires a frame, not a thousand.
      next.due = k.pinned + next.delayMs;
      continue;
    }
    fired.set(next.handle, count);
    total++;
    if (next.repeat) next.due += Math.max(next.delayMs, 0);
    fire(k, next);
    // A one-shot that rescheduled itself is a new entry with a new handle, so the per-handle
    // cap above cannot see it: what bounds that chain is the nesting clamp in `schedule()`,
    // which gives anything scheduled from inside a callback a 4 ms floor.
  }
}

// ── frames ─────────────────────────────────────────────────────────────────
/** Calls each function, reporting (never throwing) what one throws. */
function notifyAll(k: Clock, fns: Iterable<(() => void) | undefined>) {
  for (const fn of fns) {
    try {
      fn?.();
    } catch (err) {
      k.report(err);
    }
  }
}

function closeFrame(k: Clock, stepped: Foreign) {
  k.frames++;
  if (stepped) k.steppedFrames++;
  const at = virtualNow(k);
  if (k.lastFrame && at > k.lastFrame) {
    k.fpsSamples.push(1000 / (at - k.lastFrame));
    if (k.fpsSamples.length > FPS_SAMPLES) k.fpsSamples.shift();
  }
  k.lastFrame = at;
  notifyAll(k, [...k.afterFrameSubscribers]);
  notifyAll(k, [() => k.host.onFrame?.()]);
}

/** Called by the persistent native pump at the head of every real frame. */
function openFrame(k: Clock) {
  if (k.frozen) return;
  const pending = [];
  for (const entry of k.rafEntries.values()) if (entry.native != null) pending.push(entry);
  if (!pending.length) {
    k.frameSet = null;
    closeFrame(k, false);
    return;
  }
  k.frameSet = new Set(pending);
}

function drawTotals(k: Clock) {
  try {
    return k.host.drawTotals?.() ?? null;
  } catch {
    return null;
  }
}

// ── the verbs ──────────────────────────────────────────────────────────────
function pause(k: Clock) {
  k.lastFreezeTouch = nativeNow(k);
  if (k.frozen) return true;
  k.pinned = virtualNow(k);
  k.frozen = true;
  k.frameSet = null;
  for (const entry of k.rafEntries.values()) {
    if (entry.native != null) k.host.cancelRaf(entry.native);
    entry.native = null;
  }
  for (const entry of k.timers.values()) {
    if (entry.native != null) k.host.clearTimeout(entry.native);
    entry.native = null;
  }
  return true;
}

function start(k: Clock) {
  if (!k.frozen) return true;
  // Monotonic across every freeze/resume cycle: no game ever sees a negative dt.
  k.offset = k.pinned - nativeNow(k);
  k.frozen = false;
  for (const entry of k.rafEntries.values()) if (entry.native == null) arm(k, entry);
  for (const entry of k.timers.values()) if (entry.native == null) armTimer(k, entry);
  return true;
}

/**
 * Run one simulated frame's animation callbacks. The entries stay in the map until each one
 * is taken, so a `cancelAnimationFrame` issued from inside one of this frame's callbacks
 * really cancels the one it names — a browser skips a callback cancelled during its own
 * frame, and the cancel-then-request restart every pause screen does would otherwise fork the
 * loop and run the game at twice the rate for the rest of the run. A callback that requests
 * another frame lands under a fresh id that is not in this snapshot, which is what makes
 * "exactly the frames requested" literally true.
 *
 * Returns false when the frame had nothing to call.
 */
function drainFrame(k: Clock, at: Foreign) {
  const snapshot = [...k.rafEntries.values()];
  if (!snapshot.length) return false;
  for (const entry of snapshot) {
    if (!k.rafEntries.delete(entry.id)) continue;
    if (entry.native != null) k.host.cancelRaf(entry.native);
    entry.native = null;
    try {
      entry.cb(at);
    } catch (err) {
      k.report(err);
    }
  }
  return true;
}

/** How many frames a `step(ms)` runs, and how many it was asked for. */
function stepFrames(k: Clock, ms: number) {
  const asked = Number(ms);
  const span = Math.max(0, Math.min(MAX_STEP_MS, Number.isFinite(asked) ? asked : k.frameMs));
  const want = Math.max(1, Math.round(span / k.frameMs));
  return { want, count: Math.min(want, MAX_STEP_FRAMES) };
}

/** The draws and triangles between two counter totals; null where the counters cannot say. */
function drawnBetween(before: Foreign, after: Foreign) {
  if (!after) return { drawCalls: null, triangles: null };
  const triangles = after.triangles != null ? after.triangles - (before?.triangles ?? 0) : null;
  return { drawCalls: (after.drawCalls ?? 0) - (before?.drawCalls ?? 0), triangles };
}

async function step(k: Clock, ms: number) {
  if (!k.frozen) pause(k);
  k.lastFreezeTouch = nativeNow(k);
  const { want, count } = stepFrames(k, ms);
  const before = drawTotals(k);
  let idle = 0;
  for (let i = 0; i < count; i++) {
    k.pinned += k.frameMs;
    runDueTimers(k);
    if (!drainFrame(k, k.pinned)) idle++;
    closeFrame(k, true);
    // A microtask checkpoint between frames. An `async` animation callback returns at its
    // first `await`, so the continuation that re-arms the loop is still queued when the frame
    // ends; without this every frame after the first found nothing to call and a `step(960)`
    // charged sixty frames to a game that had drawn one. `idle` counts the frames that found
    // no callback at all, so the over-charge can never be silent again.
    await null;
  }
  const drawn = drawnBetween(before, drawTotals(k));
  return {
    ok: true,
    frames: count,
    idle,
    now: k.pinned,
    drawCalls: drawn.drawCalls,
    triangles: drawn.triangles,
    ...(count < want ? { truncated: true } : {}),
  };
}

/** Draw one frame without simulating one: every registered callback, once. */
function pumpFrame(k: Clock, dtMs: Foreign) {
  const advance = Math.max(0, Number(dtMs) || 0);
  if (k.frozen) k.pinned += advance;
  else k.offset += advance;
  if (!drainFrame(k, virtualNow(k))) return false;
  closeFrame(k, false);
  return true;
}

function fps(k: Clock) {
  if (!k.fpsSamples.length) return 0;
  return Math.round(k.fpsSamples.reduce((a, b) => a + b, 0) / k.fpsSamples.length);
}

/** The pump's beat: auto-resume a page nobody is stepping any more. */
function tick(k: Clock) {
  if (k.frozen && nativeNow(k) - k.lastFreezeTouch > AUTO_RESUME_MS) {
    k.autoResumes++;
    k.lastFreezeTouch = nativeNow(k);
    start(k);
  }
}

/** The page's own timing globals, as the clock replaces them. */
function clockWrappers(k: Clock) {
  function clearTimer(handle: Foreign) {
    clearTimerEntry(k, handle);
  }
  return {
    requestAnimationFrame: function requestAnimationFrame(cb: Foreign) {
      return requestFrame(k, cb);
    },
    cancelAnimationFrame: function cancelAnimationFrame(id: Foreign) {
      return cancelFrame(k, id);
    },
    setTimeout: (fn: Foreign, delay: Foreign, ...args: Foreign) => schedule(k, fn, delay, args, false),
    setInterval: (fn: Foreign, delay: Foreign, ...args: Foreign) => schedule(k, fn, delay, args, true),
    clearTimeout: clearTimer,
    clearInterval: clearTimer,
    now: () => virtualNow(k),
    dateNow: () => Math.round(k.dateBase + virtualNow(k)),
  };
}

/**
 * The virtual clock. `host` supplies the natives (`now`, `dateNow`, `raf`, `cancelRaf`,
 * `setTimeout`, `clearTimeout`) and, optionally, the page-world bits the clock reports on
 * (`drawTotals`, `onFrame`, `report`). Nothing in here touches a global.
 */
export function createClock(host: Foreign, rawOptions = {}) {
  const options = normalizeShimOptions(rawOptions);
  const frozen = options.clock === "studio";
  const k: Clock = {
    host,
    options,
    frameMs: options.frameMs,
    report: host.report ?? (() => {}),
    dateBase: (host.dateNow ? host.dateNow() : Date.now()) - host.now(),
    offset: 0,
    pinned: host.now(),
    frozen,
    frames: 0,
    steppedFrames: 0,
    lastFrame: 0,
    autoResumes: 0,
    lastFreezeTouch: 0,
    installedAt: 0,
    rafEntries: new Map(),
    nextRafId: 1,
    frameSet: null,
    timers: new Map(),
    nextTimer: TIMER_HANDLE_BASE,
    overflow: 0,
    seq: 0,
    firing: false,
    afterFrameSubscribers: new Set(),
    fpsSamples: [],
  };
  k.lastFreezeTouch = nativeNow(k);
  k.installedAt = frozen ? k.pinned : nativeNow(k);
  const wrappers = clockWrappers(k);
  return {
    version: CLOCK_VERSION,
    mode: () => options.clock,
    options: () => ({ ...options }),
    frozen: () => k.frozen,
    now: () => virtualNow(k),
    dateNow: () => Math.round(k.dateBase + virtualNow(k)),
    elapsed: () => virtualNow(k) - k.installedAt,
    pause: () => pause(k),
    start: () => start(k),
    step: (ms: number) => step(k, ms),
    pumpFrame: (dtMs: Foreign) => pumpFrame(k, dtMs),
    openFrame: () => openFrame(k),
    closeFrame: (stepped: Foreign) => closeFrame(k, stepped),
    tick: () => tick(k),
    fps: () => fps(k),
    frames: () => k.frames,
    steppedFrames: () => k.steppedFrames,
    autoResumes: () => k.autoResumes,
    pendingRaf: () => k.rafEntries.size,
    timerStats: () => ({ pending: k.timers.size, overflow: k.overflow }),
    afterFrame(fn: Foreign) {
      if (typeof fn !== "function") return () => {};
      k.afterFrameSubscribers.add(fn);
      return () => k.afterFrameSubscribers.delete(fn);
    },
    wrappers,
  };
}

/**
 * What the boot budget says about a page that has not settled yet.
 *
 * Pure, so the rule a whole run hangs on can be read and tested without a browser: a page that
 * is merely SLOW is `timedOut`, never failed. `phase: "failed"` is the studio's word for a page
 * that reported a boot failure of its own and every consumer treats it as a refusal to load — so
 * a 40 MB level or an 18 s shader compile used to blind the scout for the whole run instead of
 * costing it one note. A timed-out page keeps booting: a late quiet still settles it ready.
 */
export function readinessVerdict(
  input: {
    readyMs?: unknown;
    elapsed?: unknown;
    quiet?: boolean;
    frames?: unknown;
    drawCalls?: unknown;
    complete?: boolean;
  } = {},
) {
  const readyMs = Number.isFinite(Number(input.readyMs)) ? Number(input.readyMs) : DEFAULT_SHIM_OPTIONS.readyMs;
  const elapsed = Number(input.elapsed) || 0;
  const quiet = input.quiet === true;
  const frames = Number(input.frames) || 0;
  const drawCalls = input.drawCalls === null || input.drawCalls === undefined ? null : Number(input.drawCalls);
  if (quiet && frames >= 2 && (drawCalls === null || drawCalls > 0))
    return { settle: "quiet", ready: true, timedOut: false };
  if (quiet && input.complete === true && elapsed > readyMs / 2)
    return { settle: "quiet-no-draw", ready: true, timedOut: false };
  return { settle: null, ready: false, timedOut: elapsed > readyMs };
}

/**
 * Install one of the studio's own globals so a page cannot replace it wholesale.
 *
 * The clock, the capture, the GL record, the counters and the hook are read back BY NAME from
 * the page world by every probe the studio trusts (readiness, the step witness, the attach report), so a
 * plain writable property let game code hand the studio a stub that reports whatever it liked.
 * The value is answered by a getter, an assignment is a silent no-op, and the property stays
 * configurable so an uninstall (and a second install of a newer version) can still take it back.
 */
export function installPageGlobal(target: Foreign, name: Foreign, value: Foreign) {
  try {
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: true,
      get: () => value,
      set: () => {},
    });
  } catch {
    try {
      target[name] = value;
    } catch {
      /* a page that will take neither keeps whatever it had */
    }
  }
  return value;
}

/** Which kind of context a canvas handed out, by the argument the page asked with. */
export function contextKind(type: Foreign) {
  const name = String(type ?? "").toLowerCase();
  if (name === "2d") return "2d";
  if (name === "webgl" || name === "experimental-webgl") return "webgl";
  if (name === "webgl2" || name === "experimental-webgl2") return "webgl2";
  if (name === "webgpu") return "webgpu";
  return "unknown";
}

/** The page's own timing functions, bound before the shim replaces them. */
interface Natives {
  performanceNow: () => number;
  dateNow: () => number;
  raf: ((cb: Foreign) => Foreign) | null;
  cancelRaf: ((id: Foreign) => void) | null;
  setTimeout: (...args: Foreign[]) => Foreign;
  clearTimeout: (id: Foreign) => void;
  setInterval: (...args: Foreign[]) => Foreign;
  clearInterval: (id: Foreign) => void;
}

function nativesOf(win: Foreign): Natives {
  return {
    performanceNow: win.performance ? win.performance.now.bind(win.performance) : Date.now,
    dateNow: Date.now.bind(Date),
    raf: typeof win.requestAnimationFrame === "function" ? win.requestAnimationFrame.bind(win) : null,
    cancelRaf: typeof win.cancelAnimationFrame === "function" ? win.cancelAnimationFrame.bind(win) : null,
    setTimeout: win.setTimeout.bind(win),
    clearTimeout: win.clearTimeout.bind(win),
    setInterval: win.setInterval.bind(win),
    clearInterval: win.clearInterval.bind(win),
  };
}

/** A real animation frame, or a timer standing in for one on a page that has none. */
const realFrame = (natives: Natives, cb: Foreign) =>
  natives.raf ? natives.raf(cb) : natives.setTimeout(() => cb(natives.performanceNow()), FALLBACK_FRAME_MS);

/** The page's draw counters' lifetime totals (`__studioDraw`), or null without counters. */
const pageDrawTotals = () => (globalThis as PageGlobal).__studioDraw?.totals?.() ?? null;

/** The draw count in a counter reading, or null without one. */
const drawCallsOf = (totals: Foreign) => (totals ? (totals.drawCalls ?? 0) : null);

const GL_NAMES: Record<number, string> = {
  1280: "INVALID_ENUM",
  1281: "INVALID_VALUE",
  1282: "INVALID_OPERATION",
  1285: "OUT_OF_MEMORY",
  1286: "INVALID_FRAMEBUFFER_OPERATION",
  37442: "CONTEXT_LOST_WEBGL",
};
/** How many distinct GL errors the page keeps, and how many one drain reads per context. */
const MAX_GL_ERRORS = 16;
const GL_DRAIN_PER_CONTEXT = 8;

/** What a canvas asked for: its context kind, its attributes and (on WebGPU) its alpha mode. */
interface CanvasRecord {
  kind: string;
  attrs: Record<string, Foreign>;
  alphaMode: string | null;
}

/** The canvases the page drew on and the GL errors they raised: the shim's one getContext record. */
interface CanvasWatch {
  canvasInfo: WeakMap<Foreign, CanvasRecord>;
  tracked: Set<Foreign>;
  glContexts: WeakMap<Foreign, Foreign>;
  glErrors: unknown[];
}

function noteGl(watch: CanvasWatch, message: unknown) {
  if (!watch.glErrors.includes(message) && watch.glErrors.length < MAX_GL_ERRORS) watch.glErrors.push(message);
}
const noteGlCode = (watch: CanvasWatch, code: Foreign) => noteGl(watch, `GL_${GL_NAMES[code] || String(code)}`);

// A WebGPU canvas says whether it is transparent in `configure()`, not in the context
// attributes — and three's default renderer configures `premultiplied`, so the frame
// the capture reads back has alpha where nothing was drawn. Recorded here, because the
// photograph downstream must know whether it has a background to paint under the frame.
function recordAlphaMode(watch: CanvasWatch, canvas: Foreign, context: Foreign, kind: string) {
  try {
    const nativeConfigure = context.configure.bind(context);
    context.configure = function configure(descriptor: Foreign) {
      try {
        const seen = watch.canvasInfo.get(canvas) ?? { kind, attrs: {}, alphaMode: null };
        seen.alphaMode =
          descriptor && typeof descriptor === "object" && descriptor.alphaMode
            ? String(descriptor.alphaMode)
            : "opaque";
        watch.canvasInfo.set(canvas, seen);
      } catch {
        /* a canvas that is going away tells us nothing about its alpha */
      }
      return nativeConfigure(descriptor);
    };
    context.__studioConfigure = true;
  } catch {
    /* a context that will not take a wrapper reads back as unconfigured, which is opaque */
  }
}

/** Records a context a canvas handed out: its kind, a WebGPU canvas's alpha, a WebGL canvas's loss. */
function recordContext(watch: CanvasWatch, canvas: Foreign, context: Foreign, type: Foreign, attrs: Foreign) {
  const kind = contextKind(type);
  if (!watch.canvasInfo.has(canvas) || watch.canvasInfo.get(canvas)?.kind === "unknown") {
    watch.canvasInfo.set(canvas, {
      kind,
      attrs: attrs && typeof attrs === "object" ? { ...attrs } : {},
      alphaMode: null,
    });
  }
  watch.tracked.add(canvas);
  if (kind === "webgpu" && typeof context.configure === "function" && !context.__studioConfigure)
    recordAlphaMode(watch, canvas, context, kind);
  if ((kind === "webgl" || kind === "webgl2") && !watch.glContexts.has(canvas)) {
    watch.glContexts.set(canvas, context);
    canvas.addEventListener("webglcontextlost", () => noteGl(watch, "GL_CONTEXT_LOST"));
  }
}

// ── canvases and GL errors: ONE getContext patch, installed at document start ──
function watchCanvases(win: Foreign): CanvasWatch {
  const watch: CanvasWatch = { canvasInfo: new WeakMap(), tracked: new Set(), glContexts: new WeakMap(), glErrors: [] };
  if (typeof win.HTMLCanvasElement === "function") {
    const originalGetContext = win.HTMLCanvasElement.prototype.getContext;
    win.HTMLCanvasElement.prototype.getContext = function getContext(this: Foreign, type: Foreign, attrs: Foreign) {
      const context = originalGetContext.apply(this, arguments);
      if (context) recordContext(watch, this, context, type, attrs);
      return context;
    };
  }
  for (const name of ["WebGLRenderingContext", "WebGL2RenderingContext"]) {
    const ctor = win[name];
    if (typeof ctor !== "function" || ctor.prototype.__studioWrapped) continue;
    ctor.prototype.__studioWrapped = true;
    const original = ctor.prototype.getError;
    ctor.prototype.getError = function () {
      const code = original.call(this);
      if (code && code !== this.NO_ERROR) noteGlCode(watch, code);
      return code;
    };
  }
  return watch;
}

function drainGl(watch: CanvasWatch) {
  for (const canvas of watch.tracked) {
    const gl = watch.glContexts.get(canvas);
    if (!gl || typeof gl.getError !== "function" || gl.isContextLost?.()) continue;
    let n = 0;
    let code = gl.getError();
    while (code !== gl.NO_ERROR && n++ < GL_DRAIN_PER_CONTEXT) {
      noteGlCode(watch, code);
      code = gl.getError();
    }
  }
}

/** One canvas as the studio reads it: its kind, alpha, sizes and whether it is on screen. */
function describeCanvas(watch: CanvasWatch, canvas: Foreign, index: number) {
  const info = watch.canvasInfo.get(canvas) ?? { kind: "unknown", attrs: {}, alphaMode: null };
  let rect = { width: 0, height: 0 };
  try {
    rect = canvas.getBoundingClientRect();
  } catch {
    /* detached */
  }
  return {
    index,
    kind: info.kind,
    alpha: info.attrs.alpha !== false,
    /** What a WebGPU context was configured with (`opaque`, `premultiplied`), or null. */
    alphaMode: info.alphaMode ?? null,
    preserveDrawingBuffer: info.attrs.preserveDrawingBuffer === true,
    width: canvas.width ?? 0,
    height: canvas.height ?? 0,
    cssWidth: Math.round(rect.width ?? 0),
    cssHeight: Math.round(rect.height ?? 0),
    visible: Boolean(canvas.isConnected) && (rect.width ?? 0) > 0 && (rect.height ?? 0) > 0,
  };
}

/** Every canvas the page created or holds in its document, in that order, with its descriptor. */
function canvasesOf(watch: CanvasWatch) {
  const elements = [...watch.tracked];
  try {
    for (const canvas of document.querySelectorAll("canvas")) if (!elements.includes(canvas)) elements.push(canvas);
  } catch {
    /* a document that is going away */
  }
  const descriptors = elements.map((canvas, index) => describeCanvas(watch, canvas, index));
  return { elements, descriptors };
}

/** Publishes `__studioGl`: the GL errors, and the switch the optimization observer turns the counters off with. */
function installGlGlobal(win: Foreign, watch: CanvasWatch, counters: boolean) {
  // A page that took the studio's older probe first (it is installed again on did-navigate)
  // keeps whatever it already saw: the shim owns the surface from here, not the history.
  try {
    for (const message of win.__studioGl?.errors?.() ?? []) noteGl(watch, String(message));
  } catch {
    /* an unreadable predecessor is not worth a throw */
  }
  let counting = counters;
  installPageGlobal(
    win,
    "__studioGl",
    Object.freeze({
      errors: () => {
        drainGl(watch);
        return watch.glErrors.slice();
      },
      note: (message: unknown) => noteGl(watch, String(message)),
      /** The optimization observer turns the draw counters off around a sample. */
      count: (on: Foreign) => {
        counting = on !== false;
        try {
          (globalThis as PageGlobal).__studioDraw?.enable?.(counting);
        } catch {
          /* the counters may not be installed yet; the flag below is the contract */
        }
        return counting;
      },
      counting: () => counting,
    }),
  );
}

/** What the page is still waiting for: requests in flight, and when a resource last moved. */
interface Loaders {
  inflight: number;
  lastResourceAt: number;
}

// ── loaders: what the page is still waiting for ──
function watchLoaders(win: Foreign, natives: Natives): Loaders {
  const loaders: Loaders = { inflight: 0, lastResourceAt: natives.performanceNow() };
  const bumpResource = () => {
    loaders.lastResourceAt = natives.performanceNow();
  };
  const settled = () => {
    loaders.inflight = Math.max(0, loaders.inflight - 1);
    bumpResource();
  };
  if (typeof win.fetch === "function") {
    const nativeFetch = win.fetch.bind(win);
    win.fetch = function studioFetch(...args: Foreign[]) {
      loaders.inflight++;
      bumpResource();
      return nativeFetch(...args).finally(settled);
    };
  }
  if (typeof win.XMLHttpRequest === "function") {
    const proto = win.XMLHttpRequest.prototype;
    const nativeSend = proto.send;
    proto.send = function send(this: Foreign, ...args: Foreign[]) {
      loaders.inflight++;
      bumpResource();
      this.addEventListener("loadend", () => settled(), { once: true });
      return nativeSend.apply(this, args);
    };
  }
  try {
    const observer = new win.PerformanceObserver(() => bumpResource());
    observer.observe({ type: "resource", buffered: true });
  } catch {
    /* no resource timeline: the quiet rule falls back to the fetch/XHR counters */
  }
  return loaders;
}

/** A thrown value in words: `Name: message` for an error, its text for anything else. */
function describeThrown(value: Foreign): string {
  if (value && typeof value === "object" && typeof value.message === "string") {
    return `${typeof value.name === "string" && value.name ? value.name : "Error"}: ${value.message}`;
  }
  return String(value);
}

/**
 * The words of an error the page did not catch, from a window `error` or `unhandledrejection`
 * event, or null for an event that is no such error: a script, image or stylesheet that failed
 * to load raises `error` on its own element, not on the window.
 */
export function uncaughtMessage(type: string, event: Foreign, win: Foreign): string | null {
  if (type === "unhandledrejection") return describeThrown(event?.reason);
  if (event?.target && event.target !== win) return null;
  if (event?.error !== undefined && event?.error !== null) return describeThrown(event.error);
  return String(event?.message ?? "");
}

/** The page's uncaught errors since this load: how many, and the words of the first few. */
interface UncaughtRecord {
  count: number;
  messages: string[];
}

// ── uncaught errors, watched ──
function watchUncaught(win: Foreign): UncaughtRecord {
  const record: UncaughtRecord = { count: 0, messages: [] };
  const note = (type: string) => (event: Foreign) => {
    const message = uncaughtMessage(type, event, win);
    if (message === null) return;
    record.count++;
    if (record.messages.length < MAX_UNCAUGHT_KEPT) record.messages.push(message.slice(0, MAX_UNCAUGHT_CHARS));
  };
  try {
    win.addEventListener("error", note("error"), true);
    win.addEventListener("unhandledrejection", note("unhandledrejection"), true);
  } catch {
    /* a page with no window events reports none */
  }
  return record;
}

/** Reports an error to the console, if there is one to report to. */
const reportError = (err: Foreign) => {
  try {
    console.error(err);
  } catch {
    /* nothing to report to */
  }
};

// ── the clock, and the patched globals ──
function installClock(win: Foreign, natives: Natives, options: ShimOptions, drawCounters: Foreign) {
  const clock = createClock(
    {
      now: natives.performanceNow,
      dateNow: natives.dateNow,
      raf: natives.raf ?? ((cb: Foreign) => realFrame(natives, cb)),
      cancelRaf: natives.cancelRaf ?? natives.clearTimeout,
      setTimeout: natives.setTimeout,
      clearTimeout: natives.clearTimeout,
      setInterval: natives.setInterval,
      clearInterval: natives.clearInterval,
      drawTotals: pageDrawTotals,
      // The frame boundary the counters divide their tally on. It runs after the hook's
      // `afterFrame`, so the frame the hook just judged is the frame these numbers describe.
      onFrame: () => drawCounters?.mark(),
      report: reportError,
    },
    options,
  );
  const w = clock.wrappers;
  win.requestAnimationFrame = w.requestAnimationFrame;
  win.cancelAnimationFrame = w.cancelAnimationFrame;
  win.setTimeout = w.setTimeout;
  win.setInterval = w.setInterval;
  win.clearTimeout = w.clearTimeout;
  win.clearInterval = w.clearInterval;
  try {
    if (win.performance) win.performance.now = w.now;
    Date.now = w.dateNow;
  } catch {
    /* a locked-down page keeps the wall clock; step() still paces the loop */
  }
  return clock;
}

type ShimOptions = ReturnType<typeof normalizeShimOptions>;
type ShimClock = ReturnType<typeof createClock>;
/** Whether the browser refused a pointer lock the page asked for: watched, never answered for the page. */
interface LockWatch {
  denied: boolean;
}

/** The element the browser has locked the pointer to, if any. */
function lockedElement(): Foreign {
  try {
    return document.pointerLockElement ?? null;
  } catch {
    return null;
  }
}

// ── pointer lock, watched ──
function watchPointerLock(): LockWatch {
  const lock: LockWatch = { denied: false };
  try {
    document.addEventListener(
      "pointerlockerror",
      () => {
        lock.denied = true;
      },
      true,
    );
  } catch {
    /* no document yet */
  }
  return lock;
}

/** The canvas a mouse event should land on when nothing is locked. */
function pickCanvas(watch: CanvasWatch) {
  const { descriptors, elements } = canvasesOf(watch);
  let best = null;
  let bestArea = -1;
  descriptors.forEach((d, index) => {
    if (d.kind === "unknown" || !d.visible) return;
    const area = d.cssWidth * d.cssHeight;
    if (area > bestArea) {
      bestArea = area;
      best = elements[index];
    }
  });
  return best ?? elements[0] ?? null;
}

/** Moves the mouse over the locked element, or the largest drawn canvas, or the document. */
function mouseMover(win: Foreign, watch: CanvasWatch) {
  return function mouseMove(dx: Foreign, dy: Foreign, x: Foreign, y: Foreign) {
    const target = lockedElement() ?? pickCanvas(watch) ?? document;
    const init = {
      clientX: Number(x) || 0,
      clientY: Number(y) || 0,
      screenX: Number(x) || 0,
      screenY: Number(y) || 0,
      movementX: Number(dx) || 0,
      movementY: Number(dy) || 0,
      bubbles: true,
      cancelable: true,
      view: win,
    };
    try {
      target.dispatchEvent(new MouseEvent("mousemove", init));
      if (typeof win.PointerEvent === "function") {
        target.dispatchEvent(new win.PointerEvent("pointermove", { ...init, pointerId: 1, pointerType: "mouse" }));
      }
    } catch {
      return false;
    }
    return true;
  };
}

/** Where the page's boot stands, and what the readiness rule has concluded about it. */
interface Readiness {
  bootAt: number;
  state: { ready: boolean; phase: string; why: Foreign; at: number | null };
  /** The boot budget ran out with the page still booting. A note, never a refusal — see below. */
  timedOut: boolean;
  gestureSeen: boolean;
  resolve: (value: unknown) => void;
}

/** The whole-frame draw count so far, or null without counters. */
const drawCallsNow = () => drawCallsOf(pageDrawTotals());

function settleReady(r: Readiness, natives: Natives, clock: ShimClock, why: Foreign, ready: Foreign) {
  if (r.state.ready || r.state.phase === "failed") return r.state;
  const at = natives.performanceNow();
  r.state = { ready, phase: ready ? "ready" : "failed", why, at };
  r.resolve({
    ready,
    why,
    ms: Math.round(at - r.bootAt),
    frames: clock.frames(),
    drawCalls: drawCallsNow(),
  });
  return r.state;
}

const documentComplete = () => {
  try {
    return document.readyState === "complete";
  } catch {
    return false;
  }
};

/** Everything `evaluateReady` reads: the page, its clock, its loaders and the shim's options. */
interface ReadyInputs {
  natives: Natives;
  clock: ShimClock;
  loaders: Loaders;
  options: ShimOptions;
}

function evaluateReady(r: Readiness, page: ReadyInputs) {
  if (r.state.at !== null) return;
  const { natives, clock, loaders, options } = page;
  const verdict = readinessVerdict({
    elapsed: natives.performanceNow() - r.bootAt,
    quiet: loaders.inflight === 0 && natives.performanceNow() - loaders.lastResourceAt > options.quietMs,
    complete: documentComplete(),
    frames: clock.frames(),
    drawCalls: drawCallsNow(),
    readyMs: options.readyMs,
  });
  if (verdict.settle) return void settleReady(r, natives, clock, verdict.settle, true);
  if (verdict.timedOut) r.timedOut = true;
}

function bootReport(r: Readiness, natives: Natives, clock: ShimClock, lock: LockWatch) {
  const reasons = lock.denied ? ["pointer lock was refused without a gesture"] : [];
  return {
    ready: r.state.ready,
    phase: r.state.phase,
    /** The boot budget passed with the page still booting: a note for the waiter, not a failure. */
    timedOut: r.timedOut,
    attached: Boolean((globalThis as PageGlobal).__studioHook?.current?.()),
    since: Math.round(natives.performanceNow() - r.bootAt),
    at: r.state.at === null ? null : Math.round(r.state.at - r.bootAt),
    frames: clock.frames(),
    steppedFrames: clock.steppedFrames(),
    drawCalls: drawCallsNow(),
    reason: r.state.why ?? (r.timedOut ? BOOT_BUDGET_SPENT : null),
    gesture: { needed: reasons.length > 0, reasons, done: r.gestureSeen },
  };
}

/** The input a real user's gesture arrives as. */
const GESTURE_TYPES = ["keydown", "keyup", "mousedown", "mouseup", "mousemove", "wheel", "pointerdown"];

function watchTrustedInput(win: Foreign, r: Readiness) {
  try {
    for (const type of GESTURE_TYPES) {
      win.addEventListener(
        type,
        (event: Foreign) => {
          if (!event.isTrusted) return;
          r.gestureSeen = true;
          win.__studioTrustedInput = true;
          // Per TYPE as well as at all: preview.ts withholds its synthetic copy of an event
          // type this page has already heard natively, and reads that decision here. A hidden
          // window takes native keys and clicks and delivers no native mousemove, so the two
          // facts are not the same fact — and a page that recorded only the boolean got every
          // key twice.
          (win.__studioTrustedTypes = win.__studioTrustedTypes || {})[event.type] = true;
        },
        true,
      );
    }
    // preview.ts's own trusted probe installs the same listeners; one copy is enough.
    win.__studioTrustedProbe = true;
  } catch {
    /* no window to listen on */
  }
}

/** How often readiness and the auto-resume are checked when no animation frame comes. */
const READINESS_POLL_MS = 100;
const GL_DRAIN_EVERY_FRAMES = 30;

// ── the persistent native pump ──
// Registered first, so it always runs before the game's own callbacks: in wall mode it opens
// the frame (and the last of the page's callbacks closes it); while frozen it drains GL
// errors and nothing else, so `steppedFrames` stays the honest measure of a step().
/** Budget background GPU error reads; explicit probes still drain immediately. */
export function glDrainBudget(drain: () => void): () => void {
  let frames = 0;
  return () => {
    frames++;
    if (frames % GL_DRAIN_EVERY_FRAMES === 0) drain();
  };
}

function startPump(page: ReadyInputs, watch: CanvasWatch, r: Readiness) {
  const { natives, clock } = page;
  const drain = glDrainBudget(() => drainGl(watch));
  const pump = () => {
    if (natives.raf) natives.raf(pump);
    try {
      drain();
      evaluateReady(r, page);
      clock.tick();
      clock.openFrame();
    } catch (err) {
      reportError(err);
    }
  };
  if (natives.raf) natives.raf(pump);
  natives.setInterval(() => {
    // A hidden or occluded window may get no animation frames at all; readiness must not wait
    // on a compositor the studio deliberately never shows.
    evaluateReady(r, page);
    clock.tick();
  }, READINESS_POLL_MS);
}

/** The graphics API the page's world is drawn with: WebGPU first, then WebGL. */
function backendOf(watch: CanvasWatch) {
  const { descriptors } = canvasesOf(watch);
  const three =
    descriptors.find((d) => d.kind === "webgpu") ?? descriptors.find((d) => d.kind === "webgl2" || d.kind === "webgl");
  return three ? three.kind : null;
}

// The LAST COMPLETED FRAME, not the lifetime total: `render.drawCalls` is the whole
// frame's honest figure, and a board check reads it against a per-frame budget.
function renderReport(watch: CanvasWatch, clock: ShimClock) {
  const drawn = (globalThis as PageGlobal).__studioDraw?.frame?.() ?? null;
  return {
    backend: backendOf(watch),
    drawCalls: drawn ? (drawn.drawCalls ?? 0) : null,
    triangles: drawn ? (drawn.triangles ?? null) : null,
    vertices: drawn ? (drawn.vertices ?? null) : null,
    fps: clock.fps(),
    source: drawn ? "counters" : "shim",
    trianglesExact: drawn ? drawn.trianglesExact !== false : false,
  };
}

const hookAttached = () => {
  try {
    return Boolean((globalThis as PageGlobal).__studioHook?.current?.());
  } catch {
    return false;
  }
};

/** What the page is doing, from the studio's own clock and counters: the game is never asked. */
function pageState(watch: CanvasWatch, clock: ShimClock) {
  const render = renderReport(watch, clock);
  return {
    frame: clock.frames(),
    simulatedMs: Math.round(clock.elapsed()),
    running: !clock.frozen(),
    fps: clock.fps(),
    pointerLock: lockedElement() !== null,
    render,
    __attached: hookAttached(),
  };
}

// ── the end-of-frame photograph ──
// Installed for EVERY page, the template included: `#capturePageSide` must work on a game
// with no contract of its own, or one failed page capture blinds the whole evidence pass.
function installCaptureGlobal(win: Foreign, watch: CanvasWatch, clock: ShimClock, natives: Natives) {
  installPageGlobal(
    win,
    "__studioCapture",
    Object.freeze(
      createFrameCapture({
        canvases: () => {
          drainGl(watch);
          return canvasesOf(watch);
        },
        rendererCanvas: () => (globalThis as PageGlobal).__studioHook?.current?.()?.canvas ?? null,
        afterFrame: clock.afterFrame,
        pumpFrame: clock.pumpFrame,
        draws: pageDrawTotals,
        frozen: clock.frozen,
        start: () => clock.start(),
        pause: () => clock.pause(),
        // The game is never asked for a picture: what it drew is read off its canvases.
        gameCapture: () => null,
        // The hook's view of the camera the game rendered with; the ladder only reaches here
        // when nothing drew by itself.
        debugCamera: (name: Foreign) => (globalThis as PageGlobal).__studioHook?.debugCamera?.(name) ?? null,
        currentCamera: () => {
          const named = (globalThis as PageGlobal).__studioHook?.cameras?.();
          return Array.isArray(named) && named.length ? named[0] : "default";
        },
        computedStyle: (element: Foreign) => win.getComputedStyle?.(element) ?? null,
        parentOf: (element: Foreign) => element?.parentElement ?? null,
        createCanvas: () => document.createElement("canvas"),
        // A data URL decoded back into something `drawImage` accepts: how a transparent WebGPU
        // frame, which cannot be copied from its own canvas, is painted over the page background.
        decode: async (url: Foreign) => {
          const image = new win.Image();
          image.src = url;
          if (typeof image.decode === "function") await image.decode();
          return image;
        },
        setTimeout: natives.setTimeout,
        clearTimeout: natives.clearTimeout,
      }),
    ),
  );
}

/** Everything `__studioClock` answers from. */
interface ClockParts {
  win: Foreign;
  natives: Natives;
  options: ShimOptions;
  clock: ShimClock;
  watch: CanvasWatch;
  loaders: Loaders;
  lock: LockWatch;
  uncaught: UncaughtRecord;
  readiness: Readiness;
  ready: (why: Foreign) => Foreign;
}

function clockStats({ options, clock, watch, readiness }: ClockParts) {
  const totals = pageDrawTotals();
  return {
    mode: options.clock,
    frozen: clock.frozen(),
    now: clock.now(),
    frames: clock.frames(),
    steppedFrames: clock.steppedFrames(),
    pendingRaf: clock.pendingRaf(),
    timers: clock.timerStats(),
    drawCalls: drawCallsOf(totals),
    triangles: totals ? (totals.triangles ?? null) : null,
    lastFrame: Math.round(clock.now()),
    ready: readiness.state.ready,
    pointerLock: lockedElement() !== null,
    backend: backendOf(watch),
    autoResumes: clock.autoResumes(),
  };
}

function installClockGlobal(parts: ClockParts) {
  const { win, natives, options, clock, watch, loaders, lock, readiness } = parts;
  installPageGlobal(
    win,
    "__studioClock",
    Object.freeze({
      version: CLOCK_VERSION,
      mode: clock.mode,
      frozen: clock.frozen,
      now: clock.now,
      pause: clock.pause,
      start: clock.start,
      step: clock.step,
      state: () => pageState(watch, clock),
      errors: () => ({ count: parts.uncaught.count, messages: [...parts.uncaught.messages] }),
      boot: () => bootReport(readiness, natives, clock, lock),
      ready: parts.ready,
      rafReal: (cb: Foreign) => realFrame(natives, cb),
      afterFrame: clock.afterFrame,
      pumpFrame: clock.pumpFrame,
      canvases: () => canvasesOf(watch),
      draws: () =>
        pageDrawTotals() ?? {
          drawCalls: 0,
          triangles: null,
          frames: clock.frames(),
          trianglesExact: false,
        },
      loaders: () => ({
        inflight: loaders.inflight,
        quietFor: Math.round(natives.performanceNow() - loaders.lastResourceAt),
        quietMs: options.quietMs,
      }),
      pointerLock: () => lockedElement() !== null,
      mouseMove: mouseMover(win, watch),
      stats: () => clockStats(parts),
    }),
  );
}

/**
 * Install the whole shim on a page. Idempotent: a second copy of the tag is a no-op.
 * Returns the clock it installed (or the one that was already there).
 */
export function installStudioShim(rawOptions: Foreign) {
  // The page's own globals, which the shim patches: read and written as the page left them.
  const win: Foreign = globalThis;
  if (win.__studioClock && win.__studioClock.version === CLOCK_VERSION) return win.__studioClock;
  const options = normalizeShimOptions(rawOptions);
  const natives = nativesOf(win);
  const uncaught = watchUncaught(win);
  if (natives.raf && natives.cancelRaf) {
    const gate = animationGate({ request: natives.raf, cancel: natives.cancelRaf });
    natives.raf = gate.request;
    natives.cancelRaf = gate.cancel;
    installPageGlobal(
      win,
      "__studioAnimation",
      Object.freeze({ setVisible: gate.setVisible, setMaxFps: gate.setMaxFps }),
    );
  }
  const watch = watchCanvases(win);
  installGlGlobal(win, watch, options.counters);
  // ── the draw counters, at the graphics API, installed before any game code runs ──
  // `renderer.info` misses a composer's passes and every replayed render bundle, so the honest
  // whole-frame figure is counted here. `mark()` closes each frame from the clock's own frame
  // boundary below.
  const drawCounters = options.counters
    ? installStudioDrawCounters({ scope: win, note: (message) => noteGl(watch, message) })
    : null;
  const loaders = watchLoaders(win, natives);
  const clock = installClock(win, natives, options, drawCounters);
  const lock = watchPointerLock();
  // ── readiness ──
  const readiness: Readiness = {
    bootAt: natives.performanceNow(),
    state: { ready: false, phase: "boot", why: null, at: null },
    timedOut: false,
    gestureSeen: false,
    resolve: () => {},
  };
  win.__studioReady = new Promise((resolve) => {
    readiness.resolve = resolve;
  });
  const ready = (why: Foreign) =>
    settleReady(readiness, natives, clock, typeof why === "string" && why ? why : "declared", true);
  watchTrustedInput(win, readiness);
  startPump({ natives, clock, loaders, options }, watch, readiness);
  installCaptureGlobal(win, watch, clock, natives);
  installClockGlobal({ win, natives, options, clock, watch, loaders, lock, uncaught, readiness, ready });
  return win.__studioClock;
}
