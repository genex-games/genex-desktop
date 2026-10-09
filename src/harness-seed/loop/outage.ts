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

/** Words of a provider that is briefly down: an overloaded or failing gateway, a dropped connection. */
const TRANSIENT =
  /\b(529|502|503|504|500)\b|overloaded|internal server error|bad gateway|service unavailable|gateway time-?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network error|temporarily unavailable|try again in a moment/i;
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
function nextWait(ctx: HarnessCtx, err: unknown, wait: number | undefined, deadline: number): number | null {
  if (!isTransientProviderError(err) || ctx?.cancelled) return null;
  if (wait === undefined || Date.now() + wait > deadline) return null;
  return wait;
}

/**
 * Run `attempt()`; on a transient provider error wait and try again through the schedule,
 * telling the log each time (`onWait({ wait, attempt, error })`). Anything else — or the
 * schedule and the deadline running out — rethrows the last error, so the caller's own policy
 * (auto-tie, circuit breaker, "judge unavailable") applies only to real failures.
 */
export async function withProviderPatience<T>(
  ctx: HarnessCtx,
  attempt: () => Promise<T>,
  {
    deadline = Infinity,
    delays = OUTAGE_DELAYS,
    onWait = null,
    label = "provider",
  }: {
    deadline?: number;
    delays?: number[];
    onWait?: ((wait: { wait: number; attempt: number; error: string }) => unknown) | null;
    label?: string;
  } = {},
): Promise<T> {
  let index = 0;
  for (;;) {
    try {
      return await attempt();
    } catch (err: any) {
      const wait = nextWait(ctx, err, delays[index], deadline);
      if (wait === null) throw err;
      index += 1;
      const said = String(err?.message ?? err);
      ctx?.setStatus?.(
        `${label} is overloaded — waiting ${Math.round(wait / SECOND_MS)}s before retrying (${said.slice(0, STATUS_ERROR_CHARS)})`,
      );
      if (typeof onWait === "function") await onWait({ wait, attempt: index, error: said.slice(0, CLIP_REASON) });
      await sleepUnlessCancelled(ctx, wait);
      if (ctx?.cancelled) throw err;
    }
  }
}
