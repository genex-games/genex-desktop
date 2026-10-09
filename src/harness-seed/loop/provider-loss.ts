/**
 * Lost providers: a provider whose sign-in is gone, or one of whose limits holds, for one run.
 *
 * A provider that is gone is no verdict on anybody's work: the run pauses instead of landing an
 * unchecked build, rounds wait instead of being counted broken, and nothing asks it again until
 * the run starts again (or a limit resets).
 *
 * A module of its own, not outage.ts: a workspace may keep an agent-edited older outage.ts, and a
 * name imported from it that it never exported would keep the harness from linking.
 */
import { EngineFailure, engineLimitOf, limitWords, type EngineLimit } from "./outage.ts";
import { MINUTE_MS } from "./time.ts";

/**
 * How long a loss that names no end holds its circuit before one call may try again (a sign-in, a
 * cap with no reset). A run that paused on it starts trusting the provider again when it resumes
 * (`forgetProviderLosses`); this bounds what a stale loss can cost when nothing forgot it.
 */
const LOSS_HOLD_MS = 10 * MINUTE_MS;

/** Failures that take a provider away until the user acts or a limit resets: a lost sign-in, a cap, a session limit. */
const LOSS_KINDS: ReadonlySet<unknown> = new Set([
  EngineFailure.Auth,
  EngineFailure.UsageLimit,
  EngineFailure.RateLimit,
]);

/** Is this failure a provider lost for now — a sign-in gone, or one of its limits — rather than a fault? */
export function isProviderLoss(kind: unknown): boolean {
  return LOSS_KINDS.has(kind);
}

/** A provider loss as a sentence names it: a lost sign-in, the usage cap, the session limit, or an outage. */
export function lossWords(kind: unknown): string {
  if (kind === EngineFailure.Auth) return "lost sign-in";
  if (kind === EngineFailure.Unavailable) return "outage";
  return limitWords(kind);
}

/**
 * What the run's feed says when a provider loss pauses the lead: the lead's own line, and the
 * user's sentence (what paused it, and what brings it back).
 */
export function pauseDecision(kind: unknown, said: string): { line: string; plain: string } {
  if (kind === EngineFailure.Auth)
    return {
      line: `the engine lost its sign-in: ${said}`,
      plain:
        "the model provider stopped accepting this account, so the build paused — sign in again (or ask your admin to turn access back on), then press Resume",
    };
  if (kind === EngineFailure.Unavailable)
    return {
      line: `the lead's provider stayed down: ${said}`,
      plain: "the model provider stayed down, so the build paused — Resume picks it up where it stopped",
    };
  return {
    line: `the engine hit its ${limitWords(kind)}: ${said}`,
    plain: `your plan's ${limitWords(kind)} paused the build`,
  };
}

/** Why a run a provider loss paused ended, in the sentence its report keeps (`said` is the engine's own words). */
export function pauseEnding(kind: unknown, said: string): string {
  if (kind === EngineFailure.Auth)
    return `the engine lost its sign-in before the director called finish (${said}); the run is paused — sign in again (or have the admin turn access back on), then Resume`;
  if (kind === EngineFailure.Unavailable)
    return `the engine's provider stayed down before the director called finish (${said}); the run is paused — Resume it once the provider is back`;
  return `the engine hit its ${limitWords(kind)} before the director called finish (${said}); the run is paused — Resume it when the limit resets`;
}

/** A run's lost provider: the engine, the failure as the run keeps a limit, and where its caller may fall back. */
export interface ProviderLoss extends EngineLimit {
  engine: string;
  fallbacks: string[];
}

/** The run's lost providers, by run and engine. Every loop of a run (lead, workers, judges) reads the same table. */
const LOST_PROVIDERS = new Map<string, Map<string, ProviderLoss>>();

/**
 * Does `err` open its provider's circuit: a lost sign-in or a usage cap, or a session limit that
 * names its reset? A throttle that names none is retried by its caller, as it always was.
 */
function opensCircuit(err: any): boolean {
  if (err?.kind === EngineFailure.RateLimit) return typeof err.retryAfterMs === "number";
  return isProviderLoss(err?.kind);
}

/**
 * Remember that `engine` failed `err` for run `runId`: a provider loss that opens its circuit
 * (`opensCircuit`) stops calls to it until the run resumes or the limit resets. Answers the loss, or
 * null when `err` opened nothing (and nothing was remembered).
 */
export function noteProviderLoss(runId: unknown, engine: unknown, err: any, at = Date.now()): ProviderLoss | null {
  if (typeof runId !== "string" || typeof engine !== "string" || !opensCircuit(err)) return null;
  // A circuit's own error (`providerLostError`) is the loss already kept: never kept again over it.
  if (err.providerLost === true) return providerLossFor(runId, engine, at);
  const fallbacks = Array.isArray(err.fallbacks) ? err.fallbacks.filter((f: unknown) => typeof f === "string") : [];
  const loss = { ...engineLimitOf(err, at), engine, fallbacks };
  const run = LOST_PROVIDERS.get(runId) ?? new Map<string, ProviderLoss>();
  run.set(engine, loss);
  LOST_PROVIDERS.set(runId, run);
  return loss;
}

/** Is `loss` still holding at `now`: a limit until it resets, a loss that names no end for `LOSS_HOLD_MS`? */
function holds(loss: ProviderLoss, now: number): boolean {
  return now < loss.at + (loss.retryAfterMs ?? LOSS_HOLD_MS);
}

/** The loss that holds `engine` for run `runId` at `now`, or null: none, or a limit that has reset (its circuit closes). */
export function providerLossFor(runId: unknown, engine: unknown, now = Date.now()): ProviderLoss | null {
  if (typeof runId !== "string" || typeof engine !== "string") return null;
  const run = LOST_PROVIDERS.get(runId);
  const loss = run?.get(engine) ?? null;
  if (!loss || holds(loss, now)) return loss;
  run?.delete(engine);
  return null;
}

/** A lost sign-in on any engine of run `runId`: no wait mends it, so the run pauses for the user. */
export function lostSignIn(runId: unknown, now = Date.now()): ProviderLoss | null {
  if (typeof runId !== "string") return null;
  const engines = [...(LOST_PROVIDERS.get(runId)?.keys() ?? [])];
  for (const engine of engines) {
    const loss = providerLossFor(runId, engine, now);
    if (loss?.kind === EngineFailure.Auth) return loss;
  }
  return null;
}

/** A run of run `runId` (re)starts — the user's Resume, or the studio's: its providers are trusted again. */
export function forgetProviderLosses(runId: unknown): void {
  if (typeof runId === "string") LOST_PROVIDERS.delete(runId);
}

/**
 * What a call to a lost provider throws instead of reaching it: an engine error of the loss's own
 * kind, so every caller's policy for a lost sign-in or a limit applies, marked `providerLost`.
 */
export function providerLostError(loss: ProviderLoss): Error & { kind: string; engine: string; retryAfterMs?: number } {
  const said = `${loss.engine} is unavailable to this run (its ${lossWords(loss.kind)}): ${loss.message}`;
  return Object.assign(new Error(said), {
    kind: loss.kind,
    engine: loss.engine,
    fallbacks: loss.fallbacks,
    providerLost: true,
    ...(loss.retryAfterMs !== null ? { retryAfterMs: Math.max(0, loss.at + loss.retryAfterMs - Date.now()) } : {}),
  });
}
