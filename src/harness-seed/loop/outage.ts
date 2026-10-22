/**
 * Provider outages are weather, not verdicts.
 *
 * A provider that answers "API Error: 529 Overloaded" or "500 Internal server error" for a few
 * minutes fails every facet, the integration facet, the ledger and the global judge at once. Read
 * as "the challenger did not produce a judgeable build", two failures with the same cause trip the
 * circuit breaker on every facet — a policy written for builds that crash, applied to an API that
 * was briefly down.
 *
 * `isTransientProviderError` tells the two apart; `withProviderPatience` waits it out with a
 * capped backoff (about half an hour in total) before the caller's own policy takes over. A
 * usage or auth failure is never transient: those have a sign-in button or a reset time.
 */

import { CLIP_REASON } from "./text.ts";
import { MINUTE_MS, SECOND_MS, sleepUnlessCancelled } from "./time.ts";
import type { HarnessCtx } from "../types/harness.d.ts";

/** How much of the error a status line quotes while it waits. */
const STATUS_ERROR_CHARS = 80;

/**
 * How an engine call failed (the `kind` on the error the host rethrows). The app's copy is
 * `EngineFailureKind` in `shared/engine-requests.ts`; the values are the host's: never rename one.
 */
export const EngineFailure = {
  RateLimit: "rate_limit",
  /** A subscription cap (weekly/session) that no in-run wait can outlive — end the run, don't retry. */
  UsageLimit: "usage_limit",
  Auth: "auth",
  Unavailable: "unavailable",
  ContextThreshold: "context_threshold",
  ContextOverflow: "context_overflow",
  Aborted: "aborted",
  /** A completion outlived its ceiling. Distinct from "aborted": nobody asked for this stop. */
  Timeout: "timeout",
  Other: "other",
} as const;
export type EngineFailure = (typeof EngineFailure)[keyof typeof EngineFailure];

/**
 * Why a delegated build ended (`DelegateResult.stopReason`). A vendor's own subtype may also
 * arrive, so the field stays a string. The app's copy is `StopReason` in
 * `shared/engine-requests.ts`; logs keep the values: never rename one.
 */
export const StopReason = {
  Completed: "completed",
  /** Somebody stopped it: the user, or the run pulling a worker off. */
  Stopped: "stopped",
  /** Its time budget ran out. */
  Deadline: "deadline",
  Error: "error",
  /** The model's output hit its length limit. */
  Length: "length",
  ContextOverflow: "context_overflow",
  NoProgress: "no_progress",
  MaxTurns: "max_turns",
  Aborted: "aborted",
  /** The CLI refused the session before it did anything: the sandbox it asked for cannot run on this computer. */
  SandboxUnavailable: "sandbox_unavailable",
} as const;
export type StopReason = (typeof StopReason)[keyof typeof StopReason];

/** Is this failure an engine's own limit — its session limit or its usage cap — rather than a fault? */
export function isEngineLimit(kind: unknown): boolean {
  return kind === EngineFailure.RateLimit || kind === EngineFailure.UsageLimit;
}

/** An engine's limit as a run keeps it: which one, what the engine said, when it resets and when it hit. */
export interface EngineLimit {
  kind: string;
  message: string;
  retryAfterMs: number | null;
  at: number;
}

/** The limit an engine error names (`isEngineLimit(err.kind)`), as a run keeps it. */
export function engineLimitOf(err: any, at = Date.now()): EngineLimit {
  return {
    kind: err.kind,
    message: String(err.message ?? err),
    retryAfterMs: typeof err.retryAfterMs === "number" ? err.retryAfterMs : null,
    at,
  };
}

/** A limit as a sentence names it: the plan's usage cap, or its session limit. */
export function limitWords(kind: unknown): string {
  return kind === EngineFailure.UsageLimit ? "usage cap" : "session limit";
}

/** Waits between retries, in order; the run's `budgets.outageDelays` overrides them (tests). */
export const OUTAGE_DELAYS = [MINUTE_MS, 2 * MINUTE_MS, 5 * MINUTE_MS, 10 * MINUTE_MS, 15 * MINUTE_MS];

/**
 * Words of a provider that is briefly down: an overloaded or failing gateway, a dropped connection,
 * or no network at all (a lookup that found nothing, a network that is down or can't reach the
 * host: the CLI's "Can't reach the API server … (ENOTFOUND)").
 */
const TRANSIENT =
  /\b(529|502|503|504|500)\b|overloaded|internal server error|bad gateway|service unavailable|gateway time-?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|ENETDOWN|socket hang up|fetch failed|network error|temporarily unavailable|try again in a moment/i;
/** Words of a cap or a sign-in, which no wait fixes even when the rest reads like an outage. */
const NEVER_TRANSIENT =
  /weekly limit|usage limit|hit your limit|out of usage|resets? (at|on)\b|unauthori[sz]ed|forbidden|\b401\b|\b403\b|invalid api key|not logged in|sign in|session expired/i;

/** Failures no wait fixes: a usage cap, a sign-in, a stop somebody asked for. */
const NEVER_TRANSIENT_KINDS = new Set<unknown>([EngineFailure.UsageLimit, EngineFailure.Auth, EngineFailure.Aborted]);

/** True for an error (or its message) that names a provider hiccup, not a fault of the build. */
export function isTransientProviderError(errorOrText: unknown): boolean {
  const kind = typeof errorOrText === "object" && errorOrText ? (errorOrText as { kind?: unknown }).kind : null;
  if (NEVER_TRANSIENT_KINDS.has(kind)) return false;
  const text =
    typeof errorOrText === "string"
      ? errorOrText
      : String((errorOrText as { message?: unknown } | null | undefined)?.message ?? errorOrText ?? "");
  if (!text) return false;
  if (NEVER_TRANSIENT.test(text)) return false;
  if (kind === EngineFailure.Unavailable) return true;
  return TRANSIENT.test(text);
}

/** The delays a run uses: its own knob, else the schedule above. */
export function outageDelays(
  run: { budgets?: { outageDelays?: unknown; [knob: string]: unknown } } | null | undefined,
): number[] {
  const own = run?.budgets?.outageDelays;
  return Array.isArray(own) && own.every((n) => typeof n === "number" && n >= 0) ? own : OUTAGE_DELAYS;
}

/**
 * How long to wait before the next attempt after `err`, or null when patience is over: the error
 * is not a provider hiccup, the run was stopped, or the schedule or the deadline ran out.
 */
function nextWait(
  ctx: HarnessCtx,
  err: unknown,
  wait: number | undefined,
  { deadline, now }: { deadline: number; now: number },
): number | null {
  if (!isTransientProviderError(err) || ctx?.cancelled) return null;
  if (wait === undefined || now + wait > deadline) return null;
  return wait;
}

/** The clock a caller's patience may run on (its own, so a test moves it); the wall clock otherwise. */
export interface PatienceClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** The time on the caller's clock, or the wall clock's. */
const nowOn = (clock: PatienceClock | null): number => (clock ? clock.now() : Date.now());

/** A wait on a caller's clock is taken in steps this long, so a Stop ends it soon. */
const PATIENCE_STEP_MS = 5 * SECOND_MS;

/** Waits `ms` on the caller's clock, or the wall clock; a Stop ends it at its next step. */
async function patienceWait(ctx: HarnessCtx, ms: number, clock: PatienceClock | null): Promise<void> {
  if (!clock) return sleepUnlessCancelled(ctx, ms);
  const until = clock.now() + ms;
  while (!ctx?.cancelled && clock.now() < until) await clock.sleep(Math.min(PATIENCE_STEP_MS, until - clock.now()));
}

/**
 * What ends a caller's patience early, besides a Stop: `when` settles (the person wrote in the chat,
 * person-wrote.ts), and the wait ends with an error that says `why`.
 */
export interface PatienceEnd {
  when: Promise<unknown>;
  why: string;
}

/** How patient a caller is: its deadline, schedule, log, label, clock, and what ends it early. */
export interface PatienceOptions {
  deadline?: number;
  delays?: number[];
  onWait?: ((wait: { wait: number; attempt: number; error: string }) => unknown) | null;
  label?: string;
  /** The caller's own clock, which both the deadline and the waits are read on. */
  clock?: PatienceClock | null;
  /** Ends the patience early (the person wrote), with an error that says why. */
  endEarly?: PatienceEnd | null;
}

/**
 * Run `attempt()`; on a transient provider error wait and try again through the schedule,
 * telling the log each time (`onWait({ wait, attempt, error })`). Anything else — or the
 * schedule and the deadline running out — rethrows the last error, so the caller's own policy
 * (auto-tie, circuit breaker, "judge unavailable") applies only to real failures. `endEarly`
 * ends the waiting with its own error as soon as it settles.
 */
export async function withProviderPatience<T>(
  ctx: HarnessCtx,
  attempt: () => Promise<T>,
  options: PatienceOptions = {},
): Promise<T> {
  const { deadline = Infinity, delays = OUTAGE_DELAYS, clock = null, endEarly = null } = options;
  const early = earlyEnd(endEarly);
  for (let index = 0; ; index += 1) {
    try {
      return await attempt();
    } catch (err: any) {
      const wait = nextWait(ctx, err, delays[index], { deadline, now: nowOn(clock) });
      // A real failure stays the caller's to handle; only a wait ends early.
      if (wait === null) throw err;
      early.check();
      await announceWait(ctx, options, { wait, attempt: index + 1, err });
      await (endEarly ? Promise.race([patienceWait(ctx, wait, clock), endEarly.when]) : patienceWait(ctx, wait, clock));
      if (ctx?.cancelled) throw err;
      early.check();
    }
  }
}

/** Watches what ends a caller's patience early: `check` throws its error once it has settled. */
function earlyEnd(end: PatienceEnd | null): { check(): void } {
  let ended = false;
  void end?.when.then(() => {
    ended = true;
  });
  return {
    check: () => {
      if (ended && end) throw new Error(end.why);
    },
  };
}

/** Say a wait out loud: the status line, and the caller's log. */
async function announceWait(
  ctx: HarnessCtx,
  { onWait = null, label = "provider" }: PatienceOptions,
  { wait, attempt, err }: { wait: number; attempt: number; err: any },
): Promise<void> {
  const said = String(err?.message ?? err);
  ctx?.setStatus?.(
    `${label} is overloaded — waiting ${Math.round(wait / SECOND_MS)}s before retrying (${said.slice(0, STATUS_ERROR_CHARS)})`,
  );
  if (typeof onWait === "function") await onWait({ wait, attempt, error: said.slice(0, CLIP_REASON) });
}
