import { shortId } from "./ids.ts";
import { installProfileObserver } from "../preview-profiler/observer.ts";
import { SECOND_MS } from "../shared/duration.ts";
import type { ProfileBegin, ProfileRequest, ProfileSample } from "../shared/optimization.ts";
import { setTimeout as sleep } from "node:timers/promises";
/** The harness sends these over `preview.profile`, so they live in `shared/optimization.ts`. */
export type { ProfileBegin, ProfileRequest };
/** A renderer that is still initialising is asked again, this often, this many times. */
export const INSTALL_RETRY_MS = 250;
export const INSTALL_RETRIES = 8;

/** How long one evaluation in the page may take before the transport counts as stuck. */
const TRANSPORT_TIMEOUT_MS = 5 * SECOND_MS;
/** Sessions one preview holds at once. */
const MAX_SESSIONS = 1;
/** The warm-up and sample windows a session may ask for. */
const MAX_WARMUP_MS = 10 * SECOND_MS;
const MIN_SAMPLE_MS = 100;
const MAX_SAMPLE_MS = 15 * SECOND_MS;
/** How long past its warm-up and sample a session stays readable. */
const SESSION_GRACE_MS = 5 * SECOND_MS;
/** The largest sample (as JSON) the observer may answer. */
const MAX_SAMPLE_JSON_CHARS = 24_000;
/** Frames a live cadence must count before its aggregate is believed. */
const MIN_CADENCE_FRAMES = 30;
/** How far the reported frame time and fps may sit from the cadence they claim to summarise. */
const CADENCE_TOLERANCE = 0.001;
/** The sample format this host reads. */
const SAMPLE_SCHEMA_VERSION = 1;

/** Where the page's observer says a session is. Wire values the harness reads. */
const ProfileState = {
  Warming: "warming",
  Sampling: "sampling",
  Finished: "finished",
  Unavailable: "unavailable",
} as const;
type ProfileState = (typeof ProfileState)[keyof typeof ProfileState];
const PROFILE_STATES: readonly string[] = Object.values(ProfileState);

const MESSAGE = {
  TransportTimedOut: "profile transport timed out",
  TooManySessions: "too many profile sessions; end previous sessions",
  InvalidDuration: "invalid profile duration",
  AlreadyStarted: "profile already started",
} as const;

/** Why a read answers no sample: wire text the harness records with the stage. */
const REASON = {
  identityUnavailable: "renderer version/module identity unavailable",
  observerUnavailable: "observer unavailable",
  unknownSession: "unknown profile session",
  expired: "profile expired/navigation changed",
  invalidResponse: "invalid observer response",
  invalidSchema: "invalid sample schema",
  invalidCadence: "invalid live cadence aggregate",
  nonfiniteMetric: "nonfinite metric",
} as const;

interface ProfileSession {
  request: ProfileBegin;
  generation: number;
  key: string;
  expires: number;
  reason: string | null;
  started: boolean;
}

type ObserverAnswer = { error?: string; retryable?: boolean } | null;

/** No sample, and why. */
function unavailable(reason: string): { state: ProfileState; sample: null; reason: string } {
  return { state: ProfileState.Unavailable, sample: null, reason };
}

/** A warm-up and sample window the observer can hold. */
function isValidDuration(p: ProfileBegin): boolean {
  const finite = Number.isFinite(p.warmupMs) && Number.isFinite(p.sampleMs);
  const warmupInRange = p.warmupMs >= 0 && p.warmupMs <= MAX_WARMUP_MS;
  const sampleInRange = p.sampleMs >= MIN_SAMPLE_MS && p.sampleMs <= MAX_SAMPLE_MS;
  return finite && warmupInRange && sampleInRange;
}

/** An installed observer that answered with capabilities, not an error or a truncated reply. */
function isUsableObserver(capabilities: ObserverAnswer): boolean {
  if (!capabilities || capabilities.error) return false;
  return !("__error" in capabilities) && !("__truncated" in capabilities);
}

/** A sample of the schema this host reads, small enough to trust, with every part present. */
function isWellFormedSample(sample: ProfileSample | undefined): sample is ProfileSample {
  if (!sample || sample.schemaVersion !== SAMPLE_SCHEMA_VERSION) return false;
  if (!["webgl", "webgpu"].includes(sample.backend)) return false;
  if (JSON.stringify(sample).length > MAX_SAMPLE_JSON_CHARS) return false;
  return Boolean(sample.metrics && sample.configuration && sample.intervals && sample.inventory);
}

/** A live frame time must be the aggregate of the cadence it came with, fps included. */
function hasConsistentCadence(sample: ProfileSample): boolean {
  if (sample.metrics.frameMs?.value === null) return true;
  const cadence = sample.intervals;
  const counted = Number.isSafeInteger(cadence.count) && cadence.count >= MIN_CADENCE_FRAMES;
  const timed = Number.isFinite(cadence.elapsedMs) && cadence.elapsedMs > 0;
  if (!counted || !timed) return false;
  const frameGap = Math.abs((sample.metrics.frameMs?.value ?? 0) - cadence.elapsedMs / cadence.count);
  const fpsGap = Math.abs((sample.metrics.fps?.value ?? 0) - (SECOND_MS * cadence.count) / cadence.elapsedMs);
  const drifted = frameGap > CADENCE_TOLERANCE || fpsGap > CADENCE_TOLERANCE;
  return !drifted;
}

/** Every metric is absent (null) or a finite, non-negative number. */
function hasFiniteMetrics(sample: ProfileSample): boolean {
  return Object.values(sample.metrics).every((m) => {
    if (!m) return false;
    if (m.value === null) return true;
    return typeof m.value === "number" && Number.isFinite(m.value) && m.value >= 0;
  });
}

/**
 * Class identity proves which imported Three module owns this renderer, and it is the
 * first thing tried. A game whose three is inside its own bundle has no bare specifier to
 * import, so the fallback is the stamp three itself writes on the canvas it renders to
 * (`data-engine`, "three.js r<REVISION>", both builds, unconditionally). That stamp proves
 * which three DREW here and which revision it claims to be — it does not prove the module
 * is the studio's own copy, so it establishes the revision and nothing more.
 */
const RENDERER_REVISION_PROBE = `(async () => {
        const r = globalThis.__studioHook?.current?.()?.renderer;
        if (!r) return null;
        try {
          const m = await import(r.isWebGLRenderer ? "three" : "three/webgpu");
          const ctor = r.isWebGLRenderer ? m.WebGLRenderer : m.WebGPURenderer;
          if (typeof ctor === "function" && r instanceof ctor) return String(m.REVISION);
        } catch {}
        const stamp = r.domElement && typeof r.domElement.getAttribute === "function" ? r.domElement.getAttribute("data-engine") : null;
        const found = typeof stamp === "string" ? /three\\.js r(\\d+)/.exec(stamp) : null;
        return found ? found[1] : null;
      })()`;

export class PreviewProfiler {
  #sessions = new Map<string, ProfileSession>();
  #generation = 0;
  readonly evaluate: (s: string) => Promise<unknown>;
  readonly version: () => Promise<string>;
  constructor(evaluate: (s: string) => Promise<unknown>, version: () => Promise<string>) {
    this.evaluate = async (expression) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          evaluate(expression),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(MESSAGE.TransportTimedOut)), TRANSPORT_TIMEOUT_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    this.version = version;
  }
  async invalidate(reason: string) {
    this.#generation++;
    for (const s of this.#sessions.values()) {
      s.reason = reason;
      await this.evaluate(`globalThis[${JSON.stringify(s.key)}]?.end()`).catch(() => {});
    }
  }
  async profile(p: ProfileRequest): Promise<unknown> {
    if (p.action === "begin") return this.#begin(p);
    const s = this.#sessions.get(p.sessionId);
    if (p.action === "end") {
      if (s)
        await this.evaluate(
          `(() => { const k = ${JSON.stringify(s.key)}; globalThis[k]?.end(); delete globalThis[k]; return true; })()`,
        ).catch(() => {});
      this.#sessions.delete(p.sessionId);
      return { ended: true };
    }
    if (!s) return unavailable(REASON.unknownSession);
    if (this.#isStale(s)) return this.#expire(s);
    if (p.action === "start") {
      if (s.started) throw new Error(MESSAGE.AlreadyStarted);
      s.started = true;
      return this.evaluate("globalThis.__studioClock.start()");
    }
    return this.#read(s);
  }

  async #begin(p: ProfileBegin): Promise<unknown> {
    if (this.#sessions.size >= MAX_SESSIONS) throw new Error(MESSAGE.TooManySessions);
    if (!isValidDuration(p)) throw new Error(MESSAGE.InvalidDuration);
    const identity = await this.evaluate(RENDERER_REVISION_PROBE);
    const version = await this.version();
    if (identity !== version.split(".")[1]) return { sessionId: null, reason: REASON.identityUnavailable };
    const sessionId = shortId("profile");
    const key = `__${sessionId}`;
    const capabilities = await this.#installObserver(p, key);
    if (!isUsableObserver(capabilities))
      return { sessionId: null, capabilities, reason: capabilities?.error ?? REASON.observerUnavailable };
    this.#sessions.set(sessionId, {
      request: p,
      generation: this.#generation,
      key,
      expires: Date.now() + p.warmupMs + p.sampleMs + SESSION_GRACE_MS,
      reason: null,
      started: false,
    });
    return { sessionId, capabilities };
  }

  /**
   * A common Renderer throws out of render() until its init() has resolved, and a WebGPU
   * game reaches that through a top-level await. The old single attempt raced it and the
   * whole optimization stage was skipped; these retries fit inside the stage's own deadline.
   */
  async #installObserver(p: ProfileBegin, key: string): Promise<ObserverAnswer> {
    const options = JSON.stringify({ key, warmupMs: p.warmupMs, sampleMs: p.sampleMs, counters: p.counters });
    const install = () =>
      this.evaluate(`(${installProfileObserver.toString()})(${options})`) as Promise<ObserverAnswer>;
    let capabilities = await install();
    for (let attempt = 0; attempt < INSTALL_RETRIES && capabilities?.retryable === true; attempt++) {
      await sleep(INSTALL_RETRY_MS);
      capabilities = await install();
    }
    return capabilities;
  }

  /** A session a navigation or a rebuild invalidated, or one read past its window. */
  #isStale(s: ProfileSession): boolean {
    return Boolean(s.reason) || s.generation !== this.#generation || Date.now() > s.expires;
  }

  async #expire(s: ProfileSession): Promise<unknown> {
    await this.evaluate(`globalThis[${JSON.stringify(s.key)}]?.end()`).catch(() => {});
    const progress = await this.evaluate(`globalThis[${JSON.stringify(s.key)}]?.read()`).catch(() => null);
    return {
      ...unavailable(s.reason ?? REASON.expired),
      ...(progress ? { diagnostic: progress } : {}),
    };
  }

  async #read(s: ProfileSession): Promise<unknown> {
    const raw = (await this.evaluate(`globalThis[${JSON.stringify(s.key)}]?.read()`)) as {
      state?: string;
      reason?: string;
      sample?: ProfileSample;
    } | null;
    if (!raw || !PROFILE_STATES.includes(raw.state ?? "")) return unavailable(REASON.invalidResponse);
    if (raw.state !== ProfileState.Finished) return { state: raw.state, sample: null, reason: raw.reason ?? null };
    const sample = raw.sample;
    if (!isWellFormedSample(sample)) return unavailable(REASON.invalidSchema);
    if (!hasConsistentCadence(sample)) return unavailable(REASON.invalidCadence);
    if (!hasFiniteMetrics(sample)) return unavailable(REASON.nonfiniteMetric);
    return {
      state: ProfileState.Finished,
      reason: null,
      sample: {
        ...sample,
        version: await this.version(),
        revision: s.request.expectedRevision,
        scenarioId: s.request.scenarioId,
        handle: s.request.handle,
        measuredAt: new Date().toISOString(),
      },
    };
  }
}
