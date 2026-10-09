/**
 * A round whose model provider is lost — its sign-in gone, one of its limits, an outage that
 * outlasted the ladder. A lost provider is no verdict on the round — neither a broken build (a
 * strike towards the circuit breaker, its work rolled back) nor an auto-tie: it is recorded as an
 * outage, nothing is judged or struck, and it waits — until the provider is back (it is then built
 * or verified again), until the run stops it (a paused run's close; its work is kept on the
 * round's `…-stopped` ref), or until the facet's own time is over.
 */
import { EngineFailure, isTransientProviderError, outageDelays } from "../outage.ts";
import { isProviderLoss, lossWords, noteProviderLoss } from "../provider-loss.ts";
import { RunEvent } from "../run-events.ts";
import { GIT, commitAll, shortSha } from "../git.ts";
import { StopCode, stopWith } from "../outcomes.ts";
import { CLIP_REASON } from "../text.ts";
import { MINUTE_MS, SECOND_MS } from "../time.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import { RoundFlow, stoppedByUser } from "./flow.ts";
import { type OutagePhase, roundFields } from "./record.ts";
import { finishStoppedRound } from "./stop.ts";
import type { FacetLoop, FacetRound } from "./state.ts";

/** How often a round waiting for its provider looks again: a stop, its clock, the provider back. */
const PROVIDER_POLL_MS = 30 * SECOND_MS;

/** How long a session limit that names no reset is waited for before the round is tried again. */
const UNNAMED_RESET_WAIT_MS = MINUTE_MS;
/** Who ended a round the facet's own clock ran out on while it waited (`facet_stopped.by`). */
const WAITED_OUT_BY = "provider";

/** How often this run's waiting rounds look again: its own knob (`budgets.providerPollMs`, tests), else `PROVIDER_POLL_MS`. */
function pollMs(loop: FacetLoop): number {
  const own = loop.run?.budgets?.providerPollMs;
  return typeof own === "number" && own > 0 ? own : PROVIDER_POLL_MS;
}

/** A lost provider, as a round waits on it. */
export interface LostProvider {
  /** An engine failure kind; an outage is `EngineFailure.Unavailable`. */
  kind: string;
  engine: string;
  message: string;
  /** When it lifts by itself (a limit's reset, an outage's next try); null when only a Resume does (a sign-in, a cap). */
  until: number | null;
}

/** When a loss that `err` names lifts by itself, or null when only the user can lift it. */
function liftsAt(loop: FacetLoop, err: AnyRecord, now: number): number | null {
  const resetMs = typeof err?.retryAfterMs === "number" ? err.retryAfterMs : null;
  if (err?.kind === EngineFailure.Auth) return null;
  if (err?.kind === EngineFailure.UsageLimit) return resetMs === null ? null : now + resetMs;
  if (err?.kind === EngineFailure.RateLimit) return now + (resetMs ?? UNNAMED_RESET_WAIT_MS);
  const ladder = outageDelays(loop.run);
  return now + (ladder.at(-1) ?? 0);
}

/**
 * The provider loss `err` names for `engine`, or null for any other failure: a lost sign-in or a
 * limit (its circuit opens for the whole run, provider-loss.ts), or an outage (`isTransientProviderError`)
 * tried again after the last step of the run's outage ladder.
 */
export function lostProviderOf(loop: FacetLoop, err: unknown, engine: string, now = Date.now()): LostProvider | null {
  const failure = (err ?? {}) as AnyRecord;
  const lost = isProviderLoss(failure.kind);
  if (!lost && !isTransientProviderError(err)) return null;
  const on = typeof failure.engine === "string" ? failure.engine : engine;
  if (lost) noteProviderLoss(loop.run.runId, on, failure, now);
  return {
    kind: lost ? failure.kind : EngineFailure.Unavailable,
    engine: on,
    message: String(failure.message ?? err).slice(0, CLIP_REASON),
    until: liftsAt(loop, failure, now),
  };
}

/** The outage on the record (`facet_provider_outage` with the loss's kind), and to whoever watches the loop (the director's wake). */
export async function announceLoss(loop: FacetLoop, round: FacetRound, lost: LostProvider, phase: OutagePhase) {
  const { appendRun, facet, onProviderLost } = loop;
  await appendRun(RunEvent.FacetProviderOutage, {
    ...roundFields(loop, round.iteration),
    phase,
    lost: lost.kind,
    ...(lost.until !== null ? { wait: Math.max(0, lost.until - Date.now()) } : {}),
    error: lost.message,
  });
  try {
    onProviderLost?.({ ...lost, facetId: facet.id, iteration: round.iteration, phase });
  } catch {
    /* the watcher is a courtesy; the wait is the work */
  }
}

/** The builder's engine is out of usage — a cap that outlives the run: stop, and keep the half-built work. */
export async function stopOutOfUsage(loop: FacetLoop, round: FacetRound): Promise<RoundFlow> {
  const { engineId, result, worktree } = loop;
  const failure = round.buildEngineError;
  stopWith(result, StopCode.UsageLimit, `the engine (${engineId}) is out of usage: ${round.buildFailed}`);
  // By kind as well as in words: a director on the other subscription reads this as the
  // workers' limit, not its own (cross-provider roles).
  result.limit = {
    kind: EngineFailure.UsageLimit,
    engine: engineId,
    message: String(round.buildFailed ?? ""),
    retryAfterMs: typeof failure.retryAfterMs === "number" ? failure.retryAfterMs : null,
  };
  if (worktree) await keepHalfBuilt(loop, round);
  return RoundFlow.Stop;
}

/** The half-built round, committed and kept reachable; the stop reason says where. Best-effort. */
async function keepHalfBuilt(loop: FacetLoop, round: FacetRound): Promise<void> {
  const { ctx, facet, git, gitOptions, gitWhere, keepReachable, result } = loop;
  try {
    await commitAll(
      ctx,
      gitWhere,
      `facet ${facet.id} iteration ${round.iteration}: half-built, engine out of usage — unjudged`,
      { allowEmpty: true, ...gitOptions },
    );
    const held = await git(GIT.head);
    await keepReachable(held);
    result.stoppedBecause += ` (work in progress preserved as commit ${shortSha(held)})`;
  } catch {
    /* preservation is best-effort */
  }
}

/**
 * Wait while `lost` holds: answers `RoundFlow.Stop` when the run stopped the round (its work kept
 * on the `…-stopped` ref) or the facet's time ran out first, and nothing when the provider is
 * back and the caller may build or verify again. Never a verdict, never a strike.
 */
export async function waitForProvider(
  loop: FacetLoop,
  round: FacetRound,
  lost: LostProvider,
  phase: OutagePhase,
): Promise<RoundFlow> {
  await announceLoss(loop, round, lost, phase);
  const { ctx, facet, run } = loop;
  ctx.setStatus(`run ${run.runId} · ${facet.title} — waiting for its model provider (${lossWords(lost.kind)})`);
  for (;;) {
    if (loop.ctx.cancelled) return stoppedByUser(loop);
    if (await loop.stoppedHere(round.iteration)) return RoundFlow.Stop;
    const now = Date.now();
    if (lost.until !== null && now >= lost.until) return null;
    if (now >= loop.deadline) {
      const reason = `its time ran out while its model provider was unavailable (${lossWords(lost.kind)})`;
      await finishStoppedRound(loop, round.iteration, { by: WAITED_OUT_BY, reason });
      return RoundFlow.Stop;
    }
    await loop.sleepFor(Math.min(pollMs(loop), loop.deadline - now, (lost.until ?? Infinity) - now));
  }
}
