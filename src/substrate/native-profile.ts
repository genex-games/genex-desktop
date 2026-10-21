/**
 * The host's profile leg for games with no JavaScript renderer (game-systems PROF-6): a native run
 * (Rust · wgpu, and C++ · raylib for the frame counters) and a Rust web page.
 *
 * - `readFrameProfile` asks the game's dev `profile` verb (`{action, frames?, mode?}`) and hands on
 *   only what `parseProfileAnswer` accepts: a game that never learned the verb (an export, an old
 *   build) is `unknown-op`, one that serves no profiles yet `not-served`, and an answer outside its
 *   shape or over its cap is refused, never passed through.
 * - `NativeProfiler` is `preview.profile`'s native leg: the optimization stage's begin, start, read
 *   and end over the run's own ops. Frame time is the game's frame counter (`timing`) over a window
 *   the host times; draws and triangles are the game's last drawn frame (`state().__render`); the
 *   frame profile's summary adds CPU and GPU percentiles and hitches when the game serves it. The
 *   sample is schema 1 with backend `native`, so the stage reads it as it reads a page's.
 */
import { SECOND_MS } from "../shared/duration.ts";
import {
  FrameProfileAction,
  type FrameProfileAnswer,
  type FrameProfileRequest,
  type ProfileSummaryV1,
  ProfileUnavailableReason,
  parseProfileAnswer,
  profileUnavailable,
} from "../shared/frame-profile.ts";
import { NativeError, NativeOp, NativeOpError, type NativeReadyEvent } from "../shared/native-contract.ts";
import {
  type Metric,
  type ProfileBegin,
  type ProfileRequest,
  type ProfileSample,
  SampleBackend,
} from "../shared/optimization.ts";
import { shortId } from "./ids.ts";

/** Sessions one run holds at once (as a page's profiler). */
const MAX_SESSIONS = 1;
/** The warm-up and sample windows a session may ask for (as a page's profiler). */
const MAX_WARMUP_MS = 10 * SECOND_MS;
const MIN_SAMPLE_MS = 100;
const MAX_SAMPLE_MS = 15 * SECOND_MS;
/** How long past its warm-up and sample a session stays readable. */
const SESSION_GRACE_MS = 5 * SECOND_MS;
/** Frames the window must count before its frame time is believed (as a page's cadence). */
const MIN_CADENCE_FRAMES = 30;

const MESSAGE = {
  tooManySessions: "too many profile sessions; end previous sessions",
  invalidDuration: "invalid profile duration",
  alreadyStarted: "profile already started",
  answerRefused: (action: FrameProfileAction) => `the game's ${action} profile answer is out of shape or over its cap`,
} as const;

/** Why a read answers no sample: wire text the harness records with the stage (a page's words where they match). */
const REASON = {
  notReady: "native run not ready",
  noTiming: "native frame timing unavailable",
  unknownSession: "unknown profile session",
  expired: "profile expired/navigation changed",
  fewFrames: "insufficient live render frames",
  notServed: "frame profile not served",
  noDraws: "no drawn frame",
} as const;

/** Where each native metric comes from (a sample's `provenance`). */
const PROVENANCE = {
  cadence: "native frame counter / host-timed window",
  tally: "game tally / last drawn frame (state().__render)",
  timer: "game frame timer / mean of its last 120 frames",
  summary: "game frame profile / summary percentiles",
} as const;

/** Where a session is (the page profiler's wire words). */
const ProfileState = {
  Warming: "warming",
  Sampling: "sampling",
  Finished: "finished",
  Unavailable: "unavailable",
} as const;
type ProfileState = (typeof ProfileState)[keyof typeof ProfileState];

/** A page's answer for a verb it does not have (`studioCallScript`). */
const isMissing = (value: unknown): boolean =>
  typeof value === "object" && value !== null && Reflect.get(value, "__missing") === true;

/** The code a game refused an op or page verb with (`NativeOpRefusedError.gameError`), or null. */
function gameErrorOf(error: unknown): string | null {
  if (!(error instanceof NativeError)) return null;
  const code: unknown = Reflect.get(error, "gameError");
  return typeof code === "string" ? code : null;
}

/** What a game's refusal of the verb means for the caller: no profile and why, or null for a real failure. */
function unavailableFor(code: string | null): FrameProfileAnswer | null {
  if (code === NativeOpError.UnknownOp) return profileUnavailable(ProfileUnavailableReason.UnknownOp);
  if (code === NativeOpError.Unavailable) return profileUnavailable(ProfileUnavailableReason.NotServed);
  return null;
}

/** A game's profile answer that `parseProfileAnswer` refused: out of shape, or over its cap. */
export class ProfileAnswerRefusedError extends Error {
  readonly action: FrameProfileAction;
  constructor(action: FrameProfileAction) {
    super(MESSAGE.answerRefused(action));
    this.name = "ProfileAnswerRefusedError";
    this.action = action;
  }
}

/** How the leg reaches the verb: the native port's `profile` op, or a page's `__studio.profile`. */
export type ProfileVerbCall = (request: FrameProfileRequest) => Promise<unknown>;

/**
 * The game's answer to one checked `profile` request: the parsed answer, or `unavailable` when the
 * game does not serve it (`unknown-op`, `unavailable`, a page with no verb). Rejects
 * `ProfileAnswerRefusedError` for an answer outside its shape, and with the call's own error for
 * anything else (a bad argument, a run that ended).
 */
export async function readFrameProfile(
  call: ProfileVerbCall,
  request: FrameProfileRequest,
): Promise<FrameProfileAnswer> {
  let answer: unknown;
  try {
    answer = await call(request);
  } catch (error) {
    const unavailable = unavailableFor(gameErrorOf(error));
    if (unavailable) return unavailable;
    throw error;
  }
  if (isMissing(answer)) return profileUnavailable(ProfileUnavailableReason.NotServed);
  const parsed = parseProfileAnswer(request.action, answer);
  if (!parsed) throw new ProfileAnswerRefusedError(request.action);
  return parsed;
}

/** A port that reads the frame profile itself: a native run, or a native lease (`no-run` while it holds none). */
interface FrameProfilePort {
  frameProfile(request: FrameProfileRequest): Promise<FrameProfileAnswer>;
}

const readsFrameProfile = (port: object): port is FrameProfilePort =>
  typeof Reflect.get(port, "frameProfile") === "function";

/**
 * `preview.frameProfile` on a lease's port: a native port reads its run's `profile` op, any other
 * port (a Rust web page) the page's `__studio.profile` verb; a page with no verb is `not-served`.
 */
export function previewFrameProfile(
  port: { studioCall(method: string, arg?: unknown): Promise<unknown> },
  request: FrameProfileRequest,
): Promise<FrameProfileAnswer> {
  if (readsFrameProfile(port)) return port.frameProfile(request);
  return readFrameProfile((checked) => port.studioCall(NativeOp.Profile, checked), request);
}

/** The game's `timing` answer: its frame counter and its timer's means. */
export interface NativeTimingReading {
  frameMs: number;
  updateMs: number;
  drawMs: number;
  frames: number;
}

/** What the native sampler reaches the run through (the port, or a test's stand-in). */
export interface NativeProfilerIo {
  /** The run's `ready`, or null before it. */
  ready(): NativeReadyEvent | null;
  /** The `start` op: the game's clock runs. */
  start(): Promise<unknown>;
  timing(): Promise<NativeTimingReading>;
  /** The `state` op's answer (its `__render` tally is read). */
  state(): Promise<unknown>;
  /** The frame profile's summary through {@link readFrameProfile}. */
  summary(): Promise<FrameProfileAnswer>;
  now(): number;
}

interface NativeSession {
  request: ProfileBegin;
  generation: number;
  expires: number;
  reason: string | null;
  started: boolean;
  /** The frame counter where the window opened, on the host's clock; null while warming. */
  baseline: { frames: number; at: number } | null;
  /** When warming ends, on the host's clock (set at start). */
  warmEnd: number;
}

/** No sample, and why. */
function unavailable(reason: string): { state: ProfileState; sample: null; reason: string } {
  return { state: ProfileState.Unavailable, sample: null, reason };
}

/** A warm-up and sample window the sampler can hold. */
function isValidDuration(p: ProfileBegin): boolean {
  const finite = Number.isFinite(p.warmupMs) && Number.isFinite(p.sampleMs);
  const warmupInRange = p.warmupMs >= 0 && p.warmupMs <= MAX_WARMUP_MS;
  const sampleInRange = p.sampleMs >= MIN_SAMPLE_MS && p.sampleMs <= MAX_SAMPLE_MS;
  return finite && warmupInRange && sampleInRange;
}

/** One metric: a finite non-negative value, or null with why. */
function metric(value: number | null, unit: string, provenance: string, why: string): Metric {
  const known = value !== null && Number.isFinite(value) && value >= 0;
  return { value: known ? value : null, unit, reason: known ? null : why, provenance };
}

/** The last drawn frame's draws and triangles from a `state` answer's `__render`, each null when absent. */
function tallyOf(state: unknown): { drawCalls: number | null; triangles: number | null } {
  const render: unknown = typeof state === "object" && state !== null ? Reflect.get(state, "__render") : null;
  const read = (key: string): number | null => {
    const value: unknown = typeof render === "object" && render !== null ? Reflect.get(render, key) : null;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  };
  return { drawCalls: read("drawCalls"), triangles: read("triangles") };
}

/** Whether a profile answer is the summary (not `unavailable`, a report, an arm or a trace). */
const isSummary = (answer: FrameProfileAnswer): answer is ProfileSummaryV1 => "v" in answer && answer.v === 1;

/** The summary's percentiles and hitches as extra metrics; none when the game serves no summary. */
function summaryMetrics(summary: FrameProfileAnswer): Record<string, Metric> {
  if (!isSummary(summary)) return {};
  const s = summary;
  const extra: Record<string, Metric> = {
    cpuP50Ms: metric(s.cpu.p50, "ms", PROVENANCE.summary, REASON.notServed),
    cpuP95Ms: metric(s.cpu.p95, "ms", PROVENANCE.summary, REASON.notServed),
    hitches: metric(s.hitches.count, "hitches", PROVENANCE.summary, REASON.notServed),
  };
  if (s.gpu) extra.gpuP50Ms = metric(s.gpu.p50, "ms", PROVENANCE.summary, REASON.notServed);
  return extra;
}

/** What one finished window measured, before it becomes a sample. */
interface WindowReading {
  count: number;
  elapsedMs: number;
  timing: NativeTimingReading;
  tally: { drawCalls: number | null; triangles: number | null };
  summary: FrameProfileAnswer;
}

/** The renderer, version and configuration a ready names (a v2 game's receipt adds its tier). */
function identityOf(ready: NativeReadyEvent) {
  return {
    renderer: `Genex native renderer (${ready.backend.api})`,
    version: ready.build,
    configuration: {
      backend: ready.backend.api,
      device: ready.backend.device,
      protocol: ready.protocol,
      contract: ready.contractVersion,
      size: ready.size,
      ...(ready.receipt ? { tier: ready.receipt.tier } : {}),
    },
  };
}

/** A schema-1 sample of one native window: the stage's metric names, plus the game's own timers. */
export function nativeSample(ready: NativeReadyEvent, reading: WindowReading): ProfileSample {
  const cadenceKnown = reading.count >= MIN_CADENCE_FRAMES && reading.elapsedMs > 0;
  const frameMs = cadenceKnown ? reading.elapsedMs / reading.count : null;
  const fps = cadenceKnown ? (SECOND_MS * reading.count) / reading.elapsedMs : null;
  const { drawCalls, triangles } = reading.tally;
  const inventory: Record<string, number> = {};
  if (drawCalls !== null) inventory.drawCalls = drawCalls;
  if (triangles !== null) inventory.triangles = triangles;
  return {
    schemaVersion: 1,
    backend: SampleBackend.Native,
    ...identityOf(ready),
    scope: "native frame (whole frame; draws and triangles are the game's tally of its last drawn frame)",
    inventory,
    intervals: { count: reading.count, elapsedMs: reading.elapsedMs, minMs: null, maxMs: null },
    metrics: {
      fps: metric(fps, "frames/s", PROVENANCE.cadence, REASON.fewFrames),
      frameMs: metric(frameMs, "ms/frame", PROVENANCE.cadence, REASON.fewFrames),
      drawCalls: metric(drawCalls, "calls/frame", PROVENANCE.tally, REASON.noDraws),
      triangles: metric(triangles, "triangles/frame", PROVENANCE.tally, REASON.noDraws),
      gameFrameMs: metric(reading.timing.frameMs, "ms/frame", PROVENANCE.timer, REASON.noTiming),
      updateMs: metric(reading.timing.updateMs, "ms/frame", PROVENANCE.timer, REASON.noTiming),
      drawMs: metric(reading.timing.drawMs, "ms/frame", PROVENANCE.timer, REASON.noTiming),
      ...summaryMetrics(reading.summary),
    },
  };
}

/**
 * `preview.profile` on a native run: one session at a time, begun while paused, started with the
 * game's clock, read until its window closes, then ended. A session the host invalidated (another
 * call into the game, an evaluation) or one read past its window answers `unavailable`.
 */
export class NativeProfiler {
  readonly #io: NativeProfilerIo;
  readonly #sessions = new Map<string, NativeSession>();
  #generation = 0;

  constructor(io: NativeProfilerIo) {
    this.#io = io;
  }

  /** Every open session no longer holds, for `reason`. */
  invalidate(reason: string): void {
    this.#generation += 1;
    for (const session of this.#sessions.values()) session.reason ??= reason;
  }

  /** Whether a session is open (a call into the game during it invalidates it). */
  get sampling(): boolean {
    return this.#sessions.size > 0;
  }

  async profile(p: ProfileRequest): Promise<unknown> {
    if (p.action === "begin") return this.#begin(p);
    const session = this.#sessions.get(p.sessionId);
    if (p.action === "end") {
      this.#sessions.delete(p.sessionId);
      return { ended: true };
    }
    if (!session) return unavailable(REASON.unknownSession);
    if (this.#isStale(session)) return unavailable(session.reason ?? REASON.expired);
    if (p.action === "start") return this.#start(session);
    return this.#read(session);
  }

  async #begin(p: ProfileBegin): Promise<unknown> {
    if (this.#sessions.size >= MAX_SESSIONS) throw new Error(MESSAGE.tooManySessions);
    if (!isValidDuration(p)) throw new Error(MESSAGE.invalidDuration);
    if (!this.#io.ready()) return { sessionId: null, reason: REASON.notReady };
    const timed = await this.#io.timing().then(
      () => true,
      () => false,
    );
    if (!timed) return { sessionId: null, reason: REASON.noTiming };
    const summary = await this.#io.summary().catch(() => profileUnavailable(ProfileUnavailableReason.NotServed));
    const sessionId = shortId("profile");
    this.#sessions.set(sessionId, {
      request: p,
      generation: this.#generation,
      expires: this.#io.now() + p.warmupMs + p.sampleMs + SESSION_GRACE_MS,
      reason: null,
      started: false,
      baseline: null,
      warmEnd: 0,
    });
    return { sessionId, capabilities: { backend: SampleBackend.Native, frameProfile: isSummary(summary) } };
  }

  async #start(session: NativeSession): Promise<unknown> {
    if (session.started) throw new Error(MESSAGE.alreadyStarted);
    session.started = true;
    const answer = await this.#io.start();
    session.warmEnd = this.#io.now() + session.request.warmupMs;
    session.expires = session.warmEnd + session.request.sampleMs + SESSION_GRACE_MS;
    if (session.request.warmupMs === 0) session.baseline = await this.#baseline();
    return answer;
  }

  async #baseline(): Promise<{ frames: number; at: number }> {
    const timing = await this.#io.timing();
    return { frames: timing.frames, at: this.#io.now() };
  }

  /** Whether the host invalidated the session or its window has passed. */
  #isStale(session: NativeSession): boolean {
    const invalid = session.reason !== null || session.generation !== this.#generation;
    return invalid || this.#io.now() > session.expires;
  }

  async #read(session: NativeSession): Promise<unknown> {
    const now = this.#io.now();
    if (!session.started || now < session.warmEnd) return { state: ProfileState.Warming, sample: null, reason: null };
    // A warm-up ends at the first read past it: the window opens there.
    session.baseline ??= await this.#baseline();
    if (this.#io.now() < session.baseline.at + session.request.sampleMs)
      return { state: ProfileState.Sampling, sample: null, reason: null };
    return this.#finish(session, session.baseline);
  }

  async #finish(session: NativeSession, baseline: { frames: number; at: number }): Promise<unknown> {
    const ready = this.#io.ready();
    if (!ready) return unavailable(REASON.notReady);
    const timing = await this.#io.timing();
    const elapsedMs = this.#io.now() - baseline.at;
    const state = await this.#io.state();
    const summary = await this.#io.summary().catch(() => profileUnavailable(ProfileUnavailableReason.NotServed));
    const reading: WindowReading = {
      count: Math.max(0, timing.frames - baseline.frames),
      elapsedMs,
      timing,
      tally: tallyOf(state),
      summary,
    };
    const sample: ProfileSample = {
      ...nativeSample(ready, reading),
      revision: session.request.expectedRevision,
      scenarioId: session.request.scenarioId,
      handle: session.request.handle,
      measuredAt: new Date().toISOString(),
    };
    return { state: ProfileState.Finished, reason: null, sample };
  }
}

/** The request the sampler's summary sends. */
export const SUMMARY_REQUEST: FrameProfileRequest = { action: FrameProfileAction.Summary };
