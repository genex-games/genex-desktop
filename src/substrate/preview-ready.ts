/**
 * Booted means booted (M4.3).
 *
 * The studio used to guess: every load slept a flat 1.5 s and then photographed whatever was
 * on the glass. A game that boots asynchronously — a GLB loader, a Vite bundle that attaches
 * after its assets arrive, a WebGPU renderer awaiting `requestAdapter`, a top-level await —
 * was judged on its loading screen and told its contract was missing. This module waits for a
 * fact instead, bounded by the folder's own `bootMs`.
 *
 * Readiness here is LOGICAL, never visual. A hidden or occluded window never fires
 * `requestAnimationFrame`, so a poll that waited for a presented frame would hang exactly
 * where runs run. Pixels stay the capture path's problem.
 *
 * Pure over a {@link PreviewPort}: no Electron, no studio state, so `node --test` and
 * FakePreview get it for free.
 */
import type { PreviewInputAction } from "./preview-input.ts";
import type { PreviewPort } from "./preview-port.ts";
import { COMPUTER_VIEW } from "./computer-tool.ts";
import { ReadyPhase, type ReadyResult, ReadyVia } from "../shared/preview-contract.ts";
import { errorMessage } from "../shared/errors.ts";
import { MINUTE_MS, SECOND_MS } from "../shared/duration.ts";
import { setTimeout as delay } from "node:timers/promises";

/** The shortest and longest a folder may ask the studio to wait, and what it waits with no answer. */
export const BOOT_MS_MIN = SECOND_MS;
export const BOOT_MS_MAX = MINUTE_MS;
export const BOOT_MS_DEFAULT = 15 * SECOND_MS;

/**
 * How long a page reporting nothing at all is given before the studio stops asking: what the
 * studio used to sleep blind after every load. A page with the shim says "booting" and gets the
 * whole budget; a page that answers "there is no readiness signal here" will never answer
 * differently, and waiting a further quarter minute for it buys nobody anything.
 */
export const SILENT_MS = 1.5 * SECOND_MS;

/** How often the studio asks, and how far into the budget it knocks on a gesture-blocked page. */
export const POLL_MS = 100;
export const KNOCK_AT = 0.5;

/** The fastest the studio polls, whatever a caller asks. */
const MIN_POLL_MS = 10;
/** Polls past the budget's worth before a clock that does not advance still ends the wait. */
const POLL_SLACK = 4;
/** How much of the page's own reason a snapshot keeps. */
const MAX_REASON_CHARS = 300;
/** How many gesture reasons a snapshot keeps, and how much of each. */
const MAX_GESTURE_REASONS = 4;
const MAX_GESTURE_REASON_CHARS = 160;
/** How many keys a knock taps at most. */
const MAX_KNOCK_KEYS = 8;

/** Why a wait ended without the page up: text the user and the evidence read. */
const REASON = {
  noSignal: "the page reports no readiness signal",
  answeredNothing: "the page answered nothing",
  crashed: "the page crashed while it was loading",
  failedToBoot: "the page reported that it failed to boot",
  neverReady: "the page never reported itself ready",
} as const;

/** A number, or a numeric string; NaN for anything else. */
function numericValue(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value.trim());
  return Number.NaN;
}

/**
 * ONE boot budget. `studio.json`'s `bootMs`, clamped — the shim's own hard bound and the
 * studio's poll are both resolved from this call, so they expire together. Without that, a
 * game declaring 30 s has the shim give up at its own default and the studio polls a
 * permanently-false signal for the remaining 22 seconds.
 */
export function bootBudget(bootMs?: unknown): number {
  const value = numericValue(bootMs);
  if (!Number.isFinite(value)) return BOOT_MS_DEFAULT;
  return Math.min(BOOT_MS_MAX, Math.max(BOOT_MS_MIN, Math.round(value)));
}

/** What a folder declared, clamped — `null` when it declared nothing, so no key is written. */
export function declaredBootMs(raw: unknown): number | null {
  const declaredNothing = raw === null || raw === undefined || raw === "";
  if (declaredNothing) return null;
  const value = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(value)) return null;
  return bootBudget(value);
}

export { ReadyPhase, ReadyVia };
export type { ReadyResult };

/** A `via` the page may answer with. */
function isReadyVia(value: unknown): value is ReadyVia {
  return value === ReadyVia.Shim || value === ReadyVia.Contract || value === ReadyVia.None;
}

/** A phase the page itself can report; `unknown` is only ever the studio's own fallback. */
function isAnsweredPhase(value: unknown): value is ReadyPhase {
  return value === ReadyPhase.Ready || value === ReadyPhase.Failed || value === ReadyPhase.Boot;
}

/** One answer from the page. Always well formed: an unreadable page reports `via: "none"`. */
export interface ReadySnapshot {
  via: ReadyVia;
  ready: boolean;
  phase: ReadyPhase;
  attached: boolean;
  frames: number;
  drawCalls: number;
  /** How long the PAGE took to become ready — non-null only when the shim answered. */
  pageMs: number | null;
  /**
   * The PAGE's own word that its boot budget is spent (M4.10). The shim keeps evaluating after
   * it — a late quiet still settles ready — so this is a fact about the boot, not a verdict.
   */
  timedOut: boolean;
  reason: string | null;
  gesture: { needed: boolean; done: boolean; reasons: string[] };
}

const NO_GESTURE = { needed: false, done: false, reasons: [] as string[] };

/**
 * The expression the studio evaluates in the page.
 *
 * `window.__studioClock.boot()` is the SYNCHRONOUS snapshot. `window.__studioReady` stays a
 * PROMISE and nothing here reads fields off it — a thenable is explicitly rejected as a
 * snapshot source, so a version skew degrades to the fallback instead of polling a promise
 * object for ever.
 *
 * The fallback for a page the shim never reached tests a REAL contract: `window.__studio`
 * present, `__shim !== true`, and a `state()` that answers something other than `{__missing}`.
 * The shim's own merging facade must never be mistaken for a game's contract, or every page
 * would report itself attached and the whole premise would collapse.
 */
export const READY_PROBE = `(() => {
  var noGesture = { needed: false, done: false, reasons: [] };
  var readGesture = function (raw) {
    if (!raw || typeof raw !== "object") return noGesture;
    var reasons = Array.isArray(raw.reasons) ? raw.reasons.slice(0, ${MAX_GESTURE_REASONS}).map(function (r) { return String(r).slice(0, ${MAX_GESTURE_REASON_CHARS}); }) : [];
    return { needed: raw.needed === true, done: raw.done === true, reasons: reasons };
  };
  var fail = function (reason) {
    return { via: "none", ready: false, phase: "unknown", attached: false, frames: 0, drawCalls: 0, pageMs: null, timedOut: false, reason: reason, gesture: noGesture };
  };
  try {
    var clock = window.__studioClock;
    var snap = clock && typeof clock.boot === "function" ? clock.boot() : null;
    if (snap && typeof snap === "object" && typeof snap.then !== "function") {
      var ready = snap.ready === true;
      var phase = snap.phase === "ready" || snap.phase === "failed" || snap.phase === "boot" ? snap.phase : ready ? "ready" : "boot";
      var pageMs = typeof snap.readyAfterMs === "number" ? snap.readyAfterMs : null;
      // "at" is already measured from the shim's own boot; "since" is how old the page is NOW.
      // Subtracting one from the other made every page report a boot of 0 ms, so nothing could
      // ever be slow and the five-second boot warning could never fire.
      if (pageMs === null && typeof snap.at === "number") pageMs = Math.max(0, Math.round(snap.at));
      return {
        via: "shim",
        ready: ready,
        phase: phase,
        attached: snap.attached === true,
        frames: Number(snap.frames) || 0,
        drawCalls: Number(snap.drawCalls) || 0,
        pageMs: typeof pageMs === "number" && isFinite(pageMs) ? pageMs : null,
        /* The shim's own budget, spent: the page says so, and it keeps evaluating afterwards. */
        timedOut: snap.timedOut === true,
        reason: typeof snap.reason === "string" && snap.reason ? snap.reason.slice(0, ${MAX_REASON_CHARS}) : null,
        gesture: readGesture(snap.gesture)
      };
    }
    var contract = window.__studio;
    if (contract && contract.__shim !== true && typeof contract.state === "function") {
      var state = null;
      var threw = null;
      try { state = contract.state(); } catch (err) { threw = String((err && err.message) || err).slice(0, ${MAX_REASON_CHARS}); }
      if (state && typeof state.then === "function") state = null;
      var has = !threw && !!state && typeof state === "object" && state.__missing !== true;
      return {
        via: "contract",
        ready: has,
        phase: has ? "ready" : "boot",
        attached: has,
        frames: has && isFinite(Number(state.frame)) ? Number(state.frame) : 0,
        drawCalls: 0,
        pageMs: null,
        timedOut: false,
        reason: threw ? "the game's state() threw: " + threw : has ? null : "the game's state() reports nothing yet",
        gesture: noGesture
      };
    }
    return fail("the page reports no readiness signal");
  } catch (err) {
    return fail(String((err && err.message) || err).slice(0, ${MAX_REASON_CHARS}));
  }
})()`;

function silent(reason: string): ReadySnapshot {
  return {
    via: ReadyVia.None,
    ready: false,
    phase: ReadyPhase.Unknown,
    attached: false,
    frames: 0,
    drawCalls: 0,
    pageMs: null,
    timedOut: false,
    reason,
    gesture: { ...NO_GESTURE, reasons: [] },
  };
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** The page's raw answer → a snapshot, or the silent one when it is not a snapshot at all. */
function normalizeSnapshot(raw: unknown): ReadySnapshot {
  if (!raw || typeof raw !== "object") return silent(REASON.answeredNothing);
  const o = raw as Record<string, unknown>;
  // An expression that threw inside the page comes back as `{__error}` (preview.evaluate).
  if (typeof o.__error === "string") return silent(o.__error.slice(0, MAX_REASON_CHARS));
  if (!isReadyVia(o.via)) return silent(REASON.noSignal);
  if (typeof o.ready !== "boolean") return silent(REASON.noSignal);
  const phase = isAnsweredPhase(o.phase) ? o.phase : ReadyPhase.Unknown;
  const fromShim = o.via === ReadyVia.Shim;
  const g = (o.gesture ?? {}) as Record<string, unknown>;
  return {
    via: o.via,
    ready: o.ready,
    phase,
    attached: o.attached === true,
    frames: num(o.frames),
    drawCalls: num(o.drawCalls),
    // Only the shim measures the page's own boot; a contract answer says nothing about when.
    pageMs: fromShim && typeof o.pageMs === "number" && Number.isFinite(o.pageMs) ? o.pageMs : null,
    // Only the shim has a boot budget of its own; a contract answer never claims one.
    timedOut: fromShim && o.timedOut === true,
    reason: typeof o.reason === "string" && o.reason ? o.reason.slice(0, MAX_REASON_CHARS) : null,
    gesture: {
      needed: g.needed === true,
      done: g.done === true,
      reasons: Array.isArray(g.reasons)
        ? g.reasons.slice(0, MAX_GESTURE_REASONS).map((r) => String(r).slice(0, MAX_GESTURE_REASON_CHARS))
        : [],
    },
  };
}

/**
 * One question to the page. NEVER throws: `evaluate` rejects in two entirely ordinary ways
 * while a page boots — a navigating frame and a disposed one — and `#loadServed`'s callers
 * must not be broken by either. Both become `via: "none"`.
 */
export async function readySnapshot(port: PreviewPort): Promise<ReadySnapshot> {
  try {
    return normalizeSnapshot(await port.evaluate(READY_PROBE));
  } catch (err) {
    return silent(String(errorMessage(err)).slice(0, MAX_REASON_CHARS));
  }
}

/**
 * A knock: move, click and optionally a key tap, at the view centre or a placed point.
 *
 * The preview's mouse events arrive TRUSTED and grant user activation — that is what unlocks
 * pointer lock, `AudioContext.resume()` and fullscreen, and what walks a title screen that
 * waits for a click. `trusted` is the port's own answer and is meaningful only after at least
 * one input of this page load; `null` means the port does not say.
 */
export async function unlockGesture(
  port: PreviewPort,
  at?: { x?: number; y?: number } | null,
  keys?: string[],
): Promise<{ knocked: boolean; trusted: boolean | null }> {
  const size = port.viewSize?.() ?? COMPUTER_VIEW;
  const x = Number.isFinite(Number(at?.x)) ? Number(at?.x) : Math.round(size.width / 2);
  const y = Number.isFinite(Number(at?.y)) ? Number(at?.y) : Math.round(size.height / 2);
  const tapped = (keys ?? [])
    .map((key) => String(key))
    .filter(Boolean)
    .slice(0, MAX_KNOCK_KEYS);
  const actions: PreviewInputAction[] = [
    { type: "move", x, y, px: true },
    { type: "click", x, y, button: "left", px: true },
    ...(tapped.length ? [{ type: "tap", keys: tapped } as PreviewInputAction] : []),
  ];
  let knocked = false;
  try {
    const applied = await port.input(actions);
    knocked = applied?.ok !== false;
  } catch {
    knocked = false;
  }
  const trusted = port.trustedInput;
  return { knocked, trusted: typeof trusted === "function" ? (trusted.call(port) ?? null) : null };
}

export interface AwaitReadyOptions {
  /** The budget, clamped by {@link bootBudget} — the same number the shim was loaded with. */
  timeoutMs?: number;
  pollMs?: number;
  /** Whether the studio may knock on a page that reports itself gesture-blocked, and where. */
  gesture?: boolean | { x?: number; y?: number; keys?: string[] } | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wait for the page to say it is up.
 *
 * Polls immediately (an already-up page costs nothing where it used to cost 1.5 s), returns at
 * once on a load error, a crash or phase `failed`, knocks ONCE when the page reports itself
 * gesture-blocked and half the budget has gone, gives a page that reports no signal at all the
 * old blind 1.5 s and no more, and times out at the budget.
 *
 * It never throws, because {@link readySnapshot} never throws.
 */
export async function awaitReady(port: PreviewPort, options: AwaitReadyOptions = {}): Promise<ReadyResult> {
  const { budgetMs, pollMs, now, sleep } = waitClock(options);
  const { mayKnock, knockAt } = knockPlan(options.gesture);

  const started = now();
  let polls = 0;
  let knocked = false;
  let sawSignal = false;
  let snapshot = silent(REASON.noSignal);

  const answer = (ready: boolean, timedOut: boolean, reason: string | null): ReadyResult =>
    readyResult(snapshot, { ready, timedOut, reason, ms: now() - started, budgetMs, polls, knocked });

  for (;;) {
    const loadStop = loadStopReason(port.status());
    if (loadStop) return answer(false, false, loadStop);
    snapshot = await readySnapshot(port);
    polls += 1;
    if (snapshot.via !== ReadyVia.None) sawSignal = true;
    if (snapshot.ready) return answer(true, false, null);
    if (snapshot.phase === ReadyPhase.Failed) return answer(false, false, snapshot.reason ?? REASON.failedToBoot);
    const elapsed = now() - started;
    const stop = waitStop({ elapsed, polls, sawSignal, budgetMs, pollMs }, snapshot);
    if (stop) return answer(false, stop.timedOut, stop.reason);
    const knockNow = mayKnock && !knocked && snapshot.gesture.needed && elapsed >= budgetMs * KNOCK_AT;
    if (knockNow) {
      knocked = true;
      await unlockGesture(port, knockAt, knockAt.keys);
    }
    await sleep(Math.max(0, Math.min(pollMs, budgetMs - (now() - started))));
  }
}

/** The wait's budget, poll interval and clock, from the options or their defaults. */
function waitClock(options: AwaitReadyOptions): {
  budgetMs: number;
  pollMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
} {
  return {
    budgetMs: bootBudget(options.timeoutMs),
    pollMs: Math.max(MIN_POLL_MS, Math.round(options.pollMs ?? POLL_MS)),
    now: options.now ?? (() => Date.now()),
    sleep: options.sleep ?? ((ms: number) => delay(ms)),
  };
}

/** Whether a wait may knock on a gesture-blocked page, and where. */
function knockPlan(gesture: AwaitReadyOptions["gesture"]): {
  mayKnock: boolean;
  knockAt: { x?: number; y?: number; keys?: string[] };
} {
  const mayKnock = gesture !== false && gesture !== null;
  const knockAt = typeof gesture === "object" && gesture ? gesture : {};
  return { mayKnock, knockAt };
}

/** What `awaitReady` answers, from the last snapshot and how the wait went. */
function readyResult(
  snapshot: ReadySnapshot,
  wait: {
    ready: boolean;
    timedOut: boolean;
    reason: string | null;
    ms: number;
    budgetMs: number;
    polls: number;
    knocked: boolean;
  },
): ReadyResult {
  const { ready } = wait;
  return {
    ready,
    ms: Math.max(0, Math.round(wait.ms)),
    pageMs: snapshot.via === ReadyVia.Shim ? snapshot.pageMs : null,
    // The page's own word counts, but only where it does not contradict the answer: a page that
    // spent its budget and then settled quiet IS ready, and saying it timed out would make
    // `readyNote` tell the user a page that came up never did.
    timedOut: wait.timedOut || (!ready && snapshot.timedOut),
    pageTimedOut: snapshot.timedOut,
    budgetMs: wait.budgetMs,
    via: snapshot.via,
    phase: snapshot.phase,
    reason: wait.reason,
    polls: wait.polls,
    gesture: { needed: snapshot.gesture.needed, done: wait.knocked, reasons: snapshot.gesture.reasons },
  };
}

/** Why the page cannot come up at all: its load failed, or it crashed. */
function loadStopReason(status: { loadError?: string | null; crashed?: boolean }): string | null {
  if (status.loadError) return status.loadError;
  if (status.crashed) return REASON.crashed;
  return null;
}

/** Why the wait ends now although the page is not up, or null to keep polling. */
function waitStop(
  wait: { elapsed: number; polls: number; sawSignal: boolean; budgetMs: number; pollMs: number },
  snapshot: ReadySnapshot,
): { timedOut: boolean; reason: string } | null {
  if (wait.elapsed >= wait.budgetMs) return { timedOut: true, reason: snapshot.reason ?? REASON.neverReady };
  // A clock that does not advance is still a bounded wait: the budget's worth of polls, and out.
  if (wait.polls > Math.ceil(wait.budgetMs / wait.pollMs) + POLL_SLACK)
    return { timedOut: true, reason: snapshot.reason ?? REASON.neverReady };
  // Nothing on this page reports readiness, and nothing will: the studio is as blind as it
  // always was here, and being blind slowly helps no one.
  if (!wait.sawSignal && wait.elapsed >= SILENT_MS)
    return { timedOut: false, reason: snapshot.reason ?? REASON.noSignal };
  return null;
}
