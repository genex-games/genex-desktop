/**
 * The plan watcher's loop, one pass at a time: poll → claim → run the official CLI → submit, or
 * release and say why. Ported from genex-demo `apps/cli/src/lib/player/loop.ts`; the desktop
 * drives the passes (`player-watcher.ts`), so a pass returns how long to wait instead of sleeping.
 *
 * What it never does: approve anything (the player already did, on genex.games), spend (its
 * credential cannot), or sign in unattended (a refused credential stops it). What it keeps:
 *  - Serial work: one job a pass, whatever the queue holds; a plan answering four at once would
 *    find its limits by being rate limited.
 *  - The lease: a row another machine holds is theirs until it expires, so `genex player` on the
 *    same Mac and this watcher never answer one prompt twice.
 *  - Builds come first: while one runs, a pass keeps presence and claims nothing; above the
 *    keep-for-building line a claimed row goes back as a wait with the plan's real reset.
 *  - The log carries ids, statuses and timings, never a prompt or an answer.
 */
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import type { AiWatcherRunner } from "../../shared/game-ai-watcher.ts";
import type { ProviderUsage } from "../../shared/provider-usage.ts";
import { AI_DEFAULT_KEEP_FOR_BUILDING_PERCENT } from "../../shared/game-ai-views.ts";
import {
  FALLBACK_POLICY,
  type PendingGeneration,
  PlayerApiError,
  PlayerAuthError,
  type PlayerClient,
  type PlayerPolicy,
  type PlayerProvider,
  PlayerRelease,
  PlayerUpdateRequiredError,
  type RunnerJob,
} from "./player-api.ts";
import { PROVIDER_FOR_RUNNER, RUNNER_FOR_PROVIDER, type RunnerInstall, type RunnerOutcome } from "./player-runner.ts";

/** How often the served policy and the CLIs on this Mac are read again. */
export const POLICY_REFRESH_MS = 5 * MINUTE_MS;
/** Never beat slower than this: genex.games counts a watcher online for 90 s. */
export const MAX_HEARTBEAT_MS = MINUTE_MS;
/** Never beat faster than this, whatever the cadence. */
const MIN_HEARTBEAT_MS = 5 * SECOND_MS;
/** Heartbeats per poll interval genex.games names. */
const HEARTBEAT_POLLS = 6;
/** Renew the lease while a long call runs; genex.games' lease is 120 s. */
export const LEASE_RENEW_MS = 45 * SECOND_MS;
/** Bounds one spawned call, well inside a one-time request's 30-minute life. */
export const JOB_TIMEOUT_MS = 10 * MINUTE_MS;
/** The shortest a job is given, whatever its lease says. */
const MIN_JOB_TIMEOUT_MS = 30 * SECOND_MS;
/** A job gets this many of its lease's lengths. */
const JOB_LEASES = 5;
/** The lease a job without one names, in seconds. */
const DEFAULT_LEASE_SECONDS = 120;
/** What a release says when the watcher is going away mid-job. */
export const SHUTDOWN_RETRY_SECONDS = 5;
/** The longest a plan's own wait parks a lane on this Mac: a one-time request has no grant to park. */
export const MAX_PROVIDER_COOLDOWN_MS = 60 * MINUTE_MS;
/** The shortest backoff or wait. */
const MIN_WAIT_MS = SECOND_MS;

/** Why a watcher stopped and will not go on by itself. Wire values: never rename one. */
export const WatcherStop = {
  /** genex.games refused the player credential: sign in again. */
  AuthRefused: "auth-refused",
  /** genex.games no longer serves this version (426): update the app. */
  UpdateRequired: "update-required",
} as const;
export type WatcherStop = (typeof WatcherStop)[keyof typeof WatcherStop];

/** A stop and what genex.games said with it. */
export type WatcherStopInfo =
  | { kind: typeof WatcherStop.AuthRefused; status: number; code: string }
  | { kind: typeof WatcherStop.UpdateRequired; minVersion: string; latestVersion: string };

/** The CLIs this Mac answers with now. */
export interface WatcherRunners {
  /** Each CLI that passed its probe. */
  installs: RunnerInstall[];
  /** Codex is signed in here but did not pass its read-deny probe. */
  codexHeld: boolean;
}

/** How one job is run: the served policy, its CLI, the stop signal, its deadline and the log. */
export interface WatcherRun {
  policy: PlayerPolicy;
  install: RunnerInstall;
  signal: AbortSignal;
  timeoutMs: number;
  log: (line: string) => void;
}

/** What a session runs on; every part is replaceable in a test. */
export interface WatcherSessionDeps {
  client: PlayerClient;
  clock: { now(): number };
  /** `process.platform`, as the heartbeat reports it. */
  platform: string;
  /** This Mac's name on genex.games' watcher list. */
  label: string;
  /** The id genex.games gave this watcher before, kept across launches. */
  watcherId: string | null;
  /** The CLIs that passed their probe; read on start and with each policy refresh. */
  runners(): Promise<WatcherRunners>;
  runJob(job: RunnerJob, run: WatcherRun): Promise<RunnerOutcome>;
  /** The plan's windows for a CLI, or null when it reports none. */
  planUsage(runner: AiWatcherRunner): Promise<ProviderUsage | null>;
  /** Settings' keep-for-building share, 0 to 100. */
  keepForBuildingPercent(): Promise<number>;
  log(line: string): void;
  /** Call `fn` every `ms` until the returned cancel runs (the lease renewal). */
  repeat(ms: number, fn: () => void): () => void;
  random(): number;
}

/** What a pass came to: whether a job ran, how long to wait for the next, and a stop. */
export interface PassResult {
  worked: boolean;
  sleepMs: number;
  stop: WatcherStopInfo | null;
}

/** What Settings is shown of a session. */
export interface WatcherSnapshot {
  watcherId: string | null;
  runners: AiWatcherRunner[];
  codexHeld: boolean;
  /** The plan reached its keep-for-building line; it rests until `resetsAt` when known. */
  resting: { resetsAt: string | null } | null;
  /** genex.games did not answer the last call. */
  unreachable: boolean;
  lastAnsweredAt: string | null;
}

/** Whether a pass may claim work (no build runs) and its stop signal. */
export interface PassOptions {
  claim: boolean;
  signal: AbortSignal;
}

/** The keep-for-building line for a plan's windows. */
export interface PlanCeiling {
  resting: boolean;
  resetsAt: string | null;
}

/**
 * Whether a plan reached its keep-for-building line: any window at or past `100 - keep` percent.
 * It rests until the latest reset among those windows. Keeping nothing lets games use it all, and
 * a window whose share is unknown is not a full one.
 */
export function planCeiling(usage: ProviderUsage | null, keepPercent: number): PlanCeiling {
  if (!usage || keepPercent <= 0) return { resting: false, resetsAt: null };
  const line = 100 - keepPercent;
  const over = usage.windows.filter((window) => window.percent !== null && window.percent >= line);
  if (over.length === 0) return { resting: false, resetsAt: null };
  const resets = over
    .map((window) => window.resetsAt)
    .filter((at): at is string => typeof at === "string" && Number.isFinite(Date.parse(at)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return { resting: true, resetsAt: resets.at(-1) ?? null };
}

/** Exponential with jitter, from genex.games' numbers. */
export function backoffMs(policy: PlayerPolicy, attempt: number, random: () => number = Math.random): number {
  const b = policy.backoff;
  const raw = Math.min(b.maxSeconds, b.initialSeconds * b.factor ** Math.max(0, attempt - 1));
  const jitter = 1 + (random() * 2 - 1) * b.jitterRatio;
  return Math.max(MIN_WAIT_MS, Math.round(raw * jitter * SECOND_MS));
}

/**
 * Whether a row is this watcher's to work: it carries a job (a workflow parent's work belongs to
 * its executor), and nobody else holds a live lease on it.
 */
export function workable(row: PendingGeneration, watcherId: string, now: number): boolean {
  if (!row.runner) return false;
  if (!row.claimedBy || row.claimedBy === watcherId) return true;
  const until = Date.parse(row.leaseExpiresAt ?? "");
  return Number.isFinite(until) && until <= now;
}

/** A resting plan, until its reset has passed. */
function restingAt(resting: { resetsAt: string | null } | null, now: number): { resetsAt: string | null } | null {
  if (!resting?.resetsAt) return resting;
  return Date.parse(resting.resetsAt) > now ? resting : null;
}

/** The refusals that end a session rather than delay a pass. */
function fatalOf(error: unknown): WatcherStopInfo | null {
  if (error instanceof PlayerUpdateRequiredError)
    return { kind: WatcherStop.UpdateRequired, minVersion: error.minVersion, latestVersion: error.latestVersion };
  if (error instanceof PlayerAuthError)
    return { kind: WatcherStop.AuthRefused, status: error.status, code: error.code };
  return null;
}

/** A short, code-shaped description of a failure: never a body, never content. */
function describe(error: unknown): string {
  if (error instanceof PlayerApiError) return `${error.status}${error.code ? ` ${error.code}` : ""}`;
  if (error instanceof Error) return error.name === "TimeoutError" ? "timeout" : error.name;
  return "error";
}

/** A claim another machine won: no work, and no failure either. */
const lostRace = (error: unknown): boolean =>
  error instanceof PlayerApiError &&
  (error.code === "already_claimed" || error.code === "external_request_not_pending");

/** A session's own state between passes. */
interface SessionState {
  policy: PlayerPolicy;
  policyAt: number;
  heartbeatAt: number;
  watcherId: string | null;
  runners: WatcherRunners;
  failures: number;
  warnedNoRunners: boolean;
  unreachable: boolean;
  resting: { resetsAt: string | null } | null;
  lastAnsweredAt: string | null;
  /** A lane whose plan said wait, and when it may be asked again. */
  cooldown: Map<PlayerProvider, number>;
}

/** One pass's own record: a failure grows the backoff, a stop ends the session. */
interface PassState {
  failed: boolean;
  worked: boolean;
  stop: WatcherStopInfo | null;
}

/** What every step of a pass reads and writes. */
interface PassContext {
  deps: WatcherSessionDeps;
  state: SessionState;
  pass: PassState;
  signal: AbortSignal;
}

/** One claimed row and its lane. */
interface Claimed {
  row: PendingGeneration;
  provider: PlayerProvider;
}

const nowOf = (ctx: PassContext): number => ctx.deps.clock.now();
const watcherIdOf = (ctx: PassContext): string => ctx.state.watcherId ?? "";

/** A call that failed: a refusal that ends the session stops it; anything else is logged and backed off from. */
function failedCall(ctx: PassContext, what: string, error: unknown): void {
  ctx.pass.stop = fatalOf(error);
  if (ctx.pass.stop) return;
  ctx.pass.failed = true;
  ctx.state.unreachable = !(error instanceof PlayerApiError);
  ctx.deps.log(`player: ${what} failed (${describe(error)})`);
}

/** Read the served policy and this Mac's CLIs again when due; an unreadable policy keeps the last one. */
async function refresh(ctx: PassContext): Promise<void> {
  const { deps, state } = ctx;
  if (nowOf(ctx) < state.policyAt) return;
  state.policyAt = nowOf(ctx) + POLICY_REFRESH_MS;
  try {
    state.policy = await deps.client.policy();
  } catch (error) {
    ctx.pass.stop = fatalOf(error);
    if (ctx.pass.stop) return;
    // Kept, not failed: the last policy read (the shipped one at first) answers games just as well.
    state.unreachable = !(error instanceof PlayerApiError);
    deps.log(`player: policy read failed (${describe(error)}); keeping the last one`);
  }
  state.runners = await deps.runners();
  state.warnedNoRunners = false;
}

/** Say this watcher is here and what it runs, when due. */
async function beat(ctx: PassContext): Promise<void> {
  const { deps, state } = ctx;
  if (nowOf(ctx) < state.heartbeatAt) return;
  try {
    const answer = await deps.client.heartbeat({
      ...(state.watcherId ? { watcherId: state.watcherId } : {}),
      platform: deps.platform,
      runners: state.runners.installs.map((install) => install.runner),
      label: deps.label,
    });
    state.watcherId = answer.watcherId;
    state.unreachable = false;
    const every = answer.pollIntervalSeconds * SECOND_MS * HEARTBEAT_POLLS;
    state.heartbeatAt = nowOf(ctx) + Math.min(MAX_HEARTBEAT_MS, Math.max(MIN_HEARTBEAT_MS, every));
  } catch (error) {
    failedCall(ctx, "heartbeat", error);
    state.heartbeatAt = nowOf(ctx) + backoffMs(state.policy, state.failures + 1, deps.random);
  }
}

/** The rows waiting on a lane, or null while the lane waits out its plan or when the poll failed. */
async function listed(ctx: PassContext, provider: PlayerProvider): Promise<PendingGeneration[] | null> {
  const until = ctx.state.cooldown.get(provider) ?? 0;
  if (until > nowOf(ctx)) return null;
  ctx.state.cooldown.delete(provider);
  try {
    const rows = await ctx.deps.client.pending(provider);
    ctx.state.unreachable = false;
    return rows;
  } catch (error) {
    failedCall(ctx, "poll", error);
    return null;
  }
}

/** Each lane in turn, one job at most per lane, one after the other. */
async function workLanes(ctx: PassContext): Promise<void> {
  const { deps, state } = ctx;
  if (state.runners.installs.length === 0 && !state.warnedNoRunners) {
    // Once per refresh, not per poll: it would otherwise be the whole log on a Mac with neither CLI.
    state.warnedNoRunners = true;
    deps.log("player: no CLI here passed its check — nothing can be answered yet");
  }
  for (const install of state.runners.installs) {
    const provider = PROVIDER_FOR_RUNNER[install.runner];
    const rows = await listed(ctx, provider);
    if (ctx.pass.stop || ctx.signal.aborted) return;
    // Listed again next pass: while a job ran, the queue and every other machine's leases moved on.
    const row = rows?.find((candidate) => workable(candidate, watcherIdOf(ctx), nowOf(ctx)));
    if (row) await workRow(ctx, { row, provider }, install);
    if (ctx.pass.stop || ctx.signal.aborted) return;
  }
}

/** Claim a row: the answer (null when it did not read), or false when the claim did not happen. */
async function claimRow(ctx: PassContext, { row, provider }: Claimed): Promise<PendingGeneration | null | false> {
  try {
    return await ctx.deps.client.claim(row.id, provider, watcherIdOf(ctx));
  } catch (error) {
    if (lostRace(error)) ctx.deps.log(`player: ${row.id} taken by another machine`);
    else failedCall(ctx, `claim of ${row.id}`, error);
    return false;
  }
}

/** Claim one row, then run it and submit the answer, or hand it back and say why. */
async function workRow(ctx: PassContext, claim: Claimed, install: RunnerInstall): Promise<void> {
  const claimed = await claimRow(ctx, claim);
  if (claimed === false || (await keptForBuilding(ctx, claim))) return;
  // The claim answers with the job, so its framing wins over the listing's copy.
  const job = claimed?.runner ?? claim.row.runner;
  if (!job) return;
  ctx.pass.worked = true;
  const outcome = await runClaimed(ctx, claim, job, install).catch(
    (): RunnerOutcome => ({ ok: false, release: PlayerRelease.RunnerUnavailable, detail: "runner", durationMs: 0 }),
  );
  // A stop that arrived mid-call outranks whatever the CLI produced: nobody will submit it.
  if (!outcome.ok || ctx.signal.aborted) await handBack(ctx, claim, outcome);
  else await submitAnswer(ctx, claim, outcome);
}

/** Run a claimed job with its lease renewed meanwhile. */
async function runClaimed(
  ctx: PassContext,
  { row, provider }: Claimed,
  job: RunnerJob,
  install: RunnerInstall,
): Promise<RunnerOutcome> {
  const { deps, state } = ctx;
  const renew = deps.repeat(LEASE_RENEW_MS, () => {
    void deps.client.claim(row.id, provider, watcherIdOf(ctx)).catch(() => {});
  });
  deps.log(`player: ${row.id} ${job.mode} ${job.model.cliModel} running`);
  const leaseMs = (job.leaseSeconds || DEFAULT_LEASE_SECONDS) * SECOND_MS * JOB_LEASES;
  const timeoutMs = Math.min(JOB_TIMEOUT_MS, Math.max(MIN_JOB_TIMEOUT_MS, leaseMs));
  try {
    return await deps.runJob(job, { policy: state.policy, install, signal: ctx.signal, timeoutMs, log: deps.log });
  } finally {
    renew();
  }
}

/** Hand a row back; a refusal that ends the session is recorded. */
async function releaseRow(
  ctx: PassContext,
  { row, provider }: Claimed,
  reason: PlayerRelease,
  retryAfterSeconds: number | undefined,
): Promise<void> {
  try {
    await ctx.deps.client.release(row.id, provider, {
      watcherId: watcherIdOf(ctx),
      reason,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  } catch (error) {
    ctx.pass.stop = fatalOf(error);
    if (!ctx.pass.stop) ctx.deps.log(`player: release of ${row.id} failed (${describe(error)})`);
  }
}

/** Keep a lane's wait here too: the row stays pending and the next poll would list it again at once. */
function coolDown(ctx: PassContext, provider: PlayerProvider, seconds: number | undefined): void {
  const waitMs = Math.min(MAX_PROVIDER_COOLDOWN_MS, Math.max(MIN_WAIT_MS, (seconds ?? 0) * SECOND_MS));
  ctx.state.cooldown.set(provider, nowOf(ctx) + waitMs);
  ctx.deps.log(`player: ${provider} waits ${Math.round(waitMs / SECOND_MS)}s before the next request`);
}

/** Whether the lane's plan is past its keep-for-building line; if so the row goes back as a wait until its reset. */
async function keptForBuilding(ctx: PassContext, claim: Claimed): Promise<boolean> {
  const { deps, state } = ctx;
  const usage = await deps.planUsage(RUNNER_FOR_PROVIDER[claim.provider]).catch(() => null);
  const keep = await deps.keepForBuildingPercent().catch(() => AI_DEFAULT_KEEP_FOR_BUILDING_PERCENT);
  const ceiling = planCeiling(usage, keep);
  state.resting = ceiling.resting ? { resetsAt: ceiling.resetsAt } : null;
  if (!ceiling.resting) return false;
  const resetMs = ceiling.resetsAt ? Date.parse(ceiling.resetsAt) - nowOf(ctx) : 0;
  const seconds = resetMs > 0 ? Math.ceil(resetMs / SECOND_MS) : state.policy.backoff.maxSeconds;
  await releaseRow(ctx, claim, PlayerRelease.RateLimited, seconds);
  deps.log(`player: ${claim.row.id} released ${PlayerRelease.RateLimited} (kept for building)`);
  coolDown(ctx, claim.provider, seconds);
  return true;
}

/** Submit an answer, or hand the row back as failed when genex.games will not take it. */
async function submitAnswer(ctx: PassContext, claim: Claimed, outcome: RunnerOutcome): Promise<void> {
  const { deps, state } = ctx;
  try {
    const receipt = await deps.client.submit(claim.row.id, claim.provider, watcherIdOf(ctx), outcome.output);
    state.lastAnsweredAt = new Date(nowOf(ctx)).toISOString();
    deps.log(`player: ${claim.row.id} delivered in ${outcome.durationMs}ms (${receipt.status})`);
  } catch (error) {
    ctx.pass.stop = fatalOf(error);
    if (ctx.pass.stop) return;
    deps.log(`player: ${claim.row.id} could not be submitted (${describe(error)})`);
    await releaseRow(ctx, claim, PlayerRelease.Failed, undefined);
  }
}

/** The wait a release names: a short one on shutdown, the run's own, or the plan's on a rate limit. */
function retryOf(outcome: RunnerOutcome, reason: PlayerRelease, policy: PlayerPolicy, stopping: boolean) {
  if (stopping) return SHUTDOWN_RETRY_SECONDS;
  if (outcome.retryAfterSeconds !== undefined) return outcome.retryAfterSeconds;
  return reason === PlayerRelease.RateLimited ? policy.backoff.maxSeconds : undefined;
}

/** Hand back a row whose run did not answer, with its reason and wait. */
async function handBack(ctx: PassContext, claim: Claimed, outcome: RunnerOutcome): Promise<void> {
  const { deps, state } = ctx;
  const stopping = ctx.signal.aborted;
  const reason = stopping ? PlayerRelease.RunnerUnavailable : (outcome.release ?? PlayerRelease.Failed);
  const retry = retryOf(outcome, reason, state.policy, stopping);
  await releaseRow(ctx, claim, reason, retry);
  const detail = outcome.detail ? ` (${outcome.detail})` : "";
  deps.log(`player: ${claim.row.id} released ${reason}${detail} after ${outcome.durationMs}ms`);
  const planWait = reason === PlayerRelease.RateLimited || reason === PlayerRelease.AuthExpired;
  if (!stopping && planWait) coolDown(ctx, claim.provider, retry);
  // A CLI signed out or gone is checked again before the next job.
  if (reason === PlayerRelease.AuthExpired || reason === PlayerRelease.RunnerUnavailable) state.policyAt = 0;
}

/** A plan watcher session over `deps`: `pass` runs one pass, `snapshot` is what Settings shows. */
export function createWatcherSession(deps: WatcherSessionDeps) {
  const state: SessionState = {
    policy: FALLBACK_POLICY,
    policyAt: 0,
    heartbeatAt: 0,
    watcherId: deps.watcherId,
    runners: { installs: [], codexHeld: false },
    failures: 0,
    warnedNoRunners: false,
    unreachable: false,
    resting: null,
    lastAnsweredAt: null,
    cooldown: new Map(),
  };

  /** One pass: policy, presence, then (when allowed) at most one job per lane. */
  const pass = async (options: PassOptions): Promise<PassResult> => {
    const ctx: PassContext = {
      deps,
      state,
      pass: { failed: false, worked: false, stop: null },
      signal: options.signal,
    };
    await refresh(ctx);
    if (!ctx.pass.stop) await beat(ctx);
    const canWork = !ctx.pass.stop && !ctx.pass.failed && options.claim && !options.signal.aborted;
    if (canWork) await workLanes(ctx);
    state.failures = ctx.pass.failed ? state.failures + 1 : 0;
    const interval = Math.max(MIN_WAIT_MS, state.policy.pollIntervalSeconds * SECOND_MS);
    const backoff = ctx.pass.failed ? backoffMs(state.policy, state.failures, deps.random) : 0;
    const sleepMs = ctx.pass.worked ? 0 : Math.max(interval, backoff);
    return { worked: ctx.pass.worked, sleepMs, stop: ctx.pass.stop };
  };

  return {
    pass,
    /** What Settings shows of this session. */
    snapshot: (): WatcherSnapshot => ({
      watcherId: state.watcherId,
      runners: state.runners.installs.map((install) => install.runner),
      codexHeld: state.runners.codexHeld,
      resting: restingAt(state.resting, deps.clock.now()),
      unreachable: state.unreachable,
      lastAnsweredAt: state.lastAnsweredAt,
    }),
  };
}

/** A session as `createWatcherSession` makes it. */
export type WatcherSession = ReturnType<typeof createWatcherSession>;
