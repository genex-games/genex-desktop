/** AG-931: bounded final pass; all writers operate on an isolated candidate, never live B. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runTurn } from "./turn-loop.ts";
import { roleEffort, roleEngine, RoleKey, supportsSessions } from "./model-roles.ts";
import { gatherEvidence } from "./evidence.ts";
import { optimizationPreservation, PreservationStatus, visionCheck, referenceStats } from "./judge.ts";
import { runPlaytest } from "./playtester.ts";
import { runDeterministicChecks, compareScoreboards, toScoreboard } from "./checks.ts";
import { mechanicalReview } from "./review.ts";
import { PROFILE_DEFAULTS, optimizationAllowance, comparePerformance, preservedChecks, finite } from "./performance.ts";
import { HostMethod } from "./host-methods.ts";
import { PageMethod } from "./page-contract.ts";
import { EventKind, JournalPhase, RunEvent } from "./run-events.ts";
import { writeJournal } from "./run-journal.ts";
import { SECOND_MS, sleep } from "./time.ts";
import { TurnStatus, TurnStop } from "./turn-record.ts";
import { optimizationBrief } from "./optimization-prompts.ts";
import { CheckKind } from "./spec.ts";
import { DEFAULT_WALL_CLOCK_MS, PAGE_SEED } from "./config.ts";
import { acquireFor } from "./native-contract.ts";
import { OptimizationOutcome } from "./outcomes.ts";
import { DEFAULT_CAMERA } from "./cameras.ts";
import type { AnyRecord, ForwardedCall, HarnessCtx, Run } from "../types/harness.d.ts";
import type { CheckResult } from "./checks.ts";
import type { Evidence, Shot } from "./evidence.ts";
import type { AcquireCall, LeaseGame } from "./native-contract.ts";
import type { FacetSpec } from "./spec.ts";

/** Where the stage stands (`checkpoint.phase`, `result.phase`). Persisted: never rename a value. */
const OptimizationPhase = {
  Pending: "pending",
  VerifyingBaseline: "verifying_baseline",
  ProfilingBaseline: "profiling_baseline",
  BuildingCandidate: "building_candidate",
  ValidatingCandidate: "validating_candidate",
  ProfilingCandidate: "profiling_candidate",
  FinalQuality: "final_quality",
  Adopting: "adopting",
  Terminal: "terminal",
} as const;
type OptimizationPhase = (typeof OptimizationPhase)[keyof typeof OptimizationPhase];

/** Why the stage ended as it did (`result.reasonCode`), and the codes its own errors carry. Persisted. */
const OptimizationReason = {
  AdoptionRecovered: "adoption_recovered",
  BaselineChanged: "baseline_changed",
  BaselineChecksUnverified: "baseline_checks_unverified",
  BaselineObservationFailed: "baseline_observation_failed",
  BaselineUnverified: "baseline_unverified",
  CandidateBroken: "candidate_broken",
  Cancelled: "cancelled",
  CapabilityMissing: "capability_missing",
  ContractRegression: "contract_regression",
  Deadline: "deadline",
  FinalQualityFailed: "final_quality_failed",
  FinishRequested: "finish_requested",
  IncomparableOrRegressed: "incomparable_or_regressed",
  Inconclusive: "inconclusive",
  InsufficientTime: "insufficient_time",
  Interrupted: "interrupted",
  LiveChanged: "live_changed",
  NoSourceChange: "no_source_change",
  PreservationRegression: "preservation_regression",
  PreservationUnverified: "preservation_unverified",
  RendererNotReady: "renderer_not_ready",
  StageFailed: "stage_failed",
  VerifiedGain: "verified_gain",
} as const;
type OptimizationReason = (typeof OptimizationReason)[keyof typeof OptimizationReason];

/** What the stage asks of a preview profile session (`preview.profile` `action`). Wire values. */
const ProfileAction = {
  Begin: "begin",
  Start: "start",
  Read: "read",
  End: "end",
} as const;

/** The states of a profile `read` the stage acts on; any other means the window is still open. Wire values. */
const ProfileState = {
  Unavailable: "unavailable",
  Finished: "finished",
} as const;

/** Which tree the live game holds after an interrupted adoption (`optimization.reconcile`). Wire values. */
const RetainedTree = {
  Candidate: "candidate",
  Baseline: "baseline",
  Changed: "changed",
} as const;

/** How the host's promotion of a verified candidate ended (`optimization.promote`). Wire values. */
const PromotionOutcome = {
  Promoted: "promoted",
  BaselineChanged: "baseline_changed",
  Failed: "failed",
} as const;

/**
 * This stage leases a raylib game's preview naming the build it profiles and reviews a C++ diff by
 * the run's stack: a raylib night refuses to run on a copy kept from before (native-contract.ts
 * `servesNative`), whose lease the host refuses and whose review reads C++ by three.js rules.
 */
export const SERVES_NATIVE = true;

/**
 * This stage leases a Rust · wgpu game's preview naming the build it profiles, as a raylib one's,
 * and reviews its diff by the run's own stack: a Rust night refuses a copy kept from before Rust
 * games (native-contract.ts `servesRust`), which reviewed a Rust diff as a three.js one.
 */
export const SERVES_RUST = true;

/** The stage's id in its artifacts, its preview profile sessions and its worker's ownership. */
const STAGE_ID = "optimization";
/** The worker's share of the stage's allowance. */
const WORKER_SHARE = 0.45;
/** Seven paired/control windows plus diagnostics, evidence and judgment need real time. */
const MINIMUM_STAGE_MS = 100 * SECOND_MS;
/** The least a worker is given; less and the stage skips. */
const MINIMUM_WORKER_MS = 15 * SECOND_MS;
/** Slack kept after the build, beyond the paired samples and two validations. */
const POST_BUILD_MARGIN_MS = 15 * SECOND_MS;
/** The least one validation pass is assumed to take. */
const MINIMUM_VALIDATION_MS = 10 * SECOND_MS;
/** Profile windows each scenario may need after the build: paired, bracket and overhead control. */
const WINDOWS_PER_SCENARIO = 14;
/** Paired before/after samples per scenario (and again with counters off). */
const PAIRED_SAMPLES = 3;
/** How often the stage looks at the clock while it waits or observes. */
const POLL_MS = 100;
/** Frames a scenario without a demo is stepped before it is sampled. */
const WARM_STEPS = 960;
/** Tool rounds a direct (completion-only) worker gets. */
const DIRECT_WORKER_ROUNDS = 16;

/** Failures that skip the stage rather than fail it: it ran out of time, or cannot measure. */
const SKIPPING_FAILURES: readonly string[] = [
  OptimizationReason.Deadline,
  OptimizationReason.CapabilityMissing,
  OptimizationReason.RendererNotReady,
];
/** Endings where the live folder changed under the stage and was left as the user has it. */
const LIVE_PRESERVED: readonly string[] = [OptimizationReason.BaselineChanged, OptimizationReason.LiveChanged];

/** The stage's durable result record (`optimization/result.json`); emptyOptimization shows its fields. */
export type OptimizationResult = AnyRecord;
/** A fresh evidence pass over one tree (the candidate's or the baseline's). */
type EvidencePass = (ctx: HarnessCtx, options: AnyRecord) => Promise<Evidence>;
/** One profile sample of `revision` running `scenario`. */
type Sampler = (revision: AnyRecord, scenario: AnyRecord, counters?: boolean) => Promise<AnyRecord>;
/** What a caller hands runOptimization: the provisional quality boundary, the journal it resumes from. */
export interface OptimizationOptions {
  threadId: string;
  run: Run;
  journal: AnyRecord;
  origin?: string;
  baselineSnapshot?: { snapshot_id?: string } | null;
  baselineVerified?: boolean;
  baselineEvidence?: Evidence | null;
  baselineVerdict?: unknown;
  specs?: FacetSpec[];
  requiredChecks?: CheckResult[];
  quality?:
    | ((
        ctx: HarnessCtx,
        options: { run: Run; evidence: Evidence; baseline: Evidence; handle: string; root: string },
      ) => Promise<unknown>)
    | null;
  deadline: number;
  /** Injection seam for lifecycle tests; production uses the real collector, worker and critics. */
  services?: {
    evidence?: EvidencePass;
    checks?: typeof preservationChecks;
    sample?: Sampler;
    worker?: (options: AnyRecord) => Promise<void>;
    preserve?: typeof optimizationPreservation;
    minimumMs?: number;
    minimumWorkerMs?: number;
    postBuildReserveMs?: number;
  };
}

/**
 * A profiler that could not arm because the renderer had not finished `init()` yet is not a
 * missing capability — it is a WebGPU game still booting (M4.9). It gets its own reason code so
 * the stage is `skipped` with a sentence the reader can act on, instead of being filed with a
 * studio that cannot profile at all.
 */
const RENDERER_NOT_READY = /renderer is not initiali[sz]ed|renderer not ready|not yet initiali[sz]ed/i;
function profileErrorCode(reason: unknown): OptimizationReason {
  return RENDERER_NOT_READY.test(String(reason ?? ""))
    ? OptimizationReason.RendererNotReady
    : OptimizationReason.CapabilityMissing;
}

/** An error the stage raises itself, carrying the reason code it ends with. */
function stageError(message: string, code: OptimizationReason): Error {
  return Object.assign(new Error(message), { code });
}

export function emptyOptimization(
  run: Pick<Run, "runId" | "project">,
  reason: string | null = null,
): OptimizationResult {
  return {
    schemaVersion: 1,
    runId: run.runId,
    project: run.project,
    stageId: STAGE_ID,
    attempt: 0,
    phase: reason ? OptimizationPhase.Terminal : OptimizationPhase.Pending,
    outcome: reason ? OptimizationOutcome.Skipped : null,
    reasonCode: reason ? OptimizationReason.BaselineUnverified : null,
    reason,
    summary: reason ?? "Waiting for the assembled game",
    baseline: null,
    candidate: null,
    retainedRevision: null,
    candidateAdopted: false,
    scenarios: [],
    preservation: { status: "not_run", reasons: [], evidenceRefs: [] },
    changedFiles: [],
    reportPath: null,
    startedAt: null,
    finishedAt: reason ? new Date().toISOString() : null,
    sequence: 0,
  };
}
export async function saveOptimization(
  ctx: HarnessCtx,
  { threadId, run, result }: { threadId: string; run: Pick<Run, "runId" | "project">; result: OptimizationResult },
): Promise<OptimizationResult> {
  result.sequence++;
  const bytes = (value: unknown): string => Buffer.from(JSON.stringify(value, null, 2)).toString("base64");
  result.reportPath = await ctx.call(HostMethod.RunArtifact, {
    runId: run.runId,
    name: "optimization/result.json",
    base64: bytes(result),
  });
  // Persist the real artifact path too, for a reader reopening only result.json.
  await ctx.call(HostMethod.RunArtifact, { runId: run.runId, name: "optimization/result.json", base64: bytes(result) });
  await ctx.call(HostMethod.EventsAppend, {
    threadId,
    batch: [{ type: EventKind.Custom, event_type: RunEvent.OptimizationUpdated, payload: result }],
  });
  ctx.notify?.("run.optimization", { runId: run.runId, sequence: result.sequence });
  return result;
}
export async function skipOptimization(
  ctx: HarnessCtx,
  { threadId, run, reason }: { threadId: string; run: Pick<Run, "runId" | "project">; reason: string },
): Promise<OptimizationResult> {
  return saveOptimization(ctx, { threadId, run, result: emptyOptimization(run, reason) });
}
const refs = (ev: Evidence | null | undefined): string[] =>
  (ev?.shots ?? []).map((s: Shot) => s.path).filter(Boolean) as string[];
const cleanEvidence = (ev: Evidence | null | undefined): AnyRecord | null =>
  ev ? JSON.parse(JSON.stringify(ev, (k, v) => (k === "base64" ? undefined : v))) : null;

/** Fresh checks for every part, qualified by part ID; a missing formerly passing result rejects. */
export async function preservationChecks(
  ctx: HarnessCtx,
  {
    run,
    specs,
    evidence,
    handle,
    root,
    deadline,
  }: { run: Run; specs: FacetSpec[]; evidence: Evidence; handle?: string; root: string; deadline?: number | null },
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const spec of specs) {
    const scored = await runDeterministicChecks(ctx, { spec, evidence, handle, references: referenceStats(run) });
    for (const check of scored.pending.filter((c) => c.kind === CheckKind.Vision)) {
      const shot = evidence.shots.find((s: Shot) => s.camera === check.camera);
      let crop: { base64?: string } | null | undefined = shot;
      if (shot && check.crop)
        crop = await ctx.call(HostMethod.PreviewCrop, {
          handle,
          runId: run.runId,
          path: shot.path!,
          crop: check.crop,
          label: `optimization/preservation/${spec.id}-${check.id}`,
        });
      scored.results.push(await visionCheck(ctx, { run, check, crop }));
    }
    const play = scored.pending.filter((c) => c.kind === CheckKind.Play);
    if (play.length) {
      const played = await runPlaytest(ctx, {
        run,
        spec,
        checks: play,
        root,
        handle,
        deadline,
        iteration: 0,
        labelPrefix: `optimization/preservation/${spec.id}`,
      });
      scored.results.push(...played!.results);
    }
    results.push(...scored.results.map((r) => ({ ...r, id: `${spec.id}/${r.id}` })));
  }
  return results;
}

/**
 * One optimization attempt in flight: the caller's options, the checkpoint it resumes from, the
 * clock it runs against, and what each step has established so far.
 */
interface Stage {
  ctx: HarnessCtx;
  /** `ctx` held to the stage's clock: every call checks it, and preview reads race it. */
  bounded: HarnessCtx;
  options: OptimizationOptions;
  run: Run;
  /** The run as the stage's own critics see it: with the stage's deadline and thread. */
  stageRun: Run;
  threadId: string;
  journal: AnyRecord;
  checkpoint: AnyRecord;
  result: OptimizationResult;
  budget: AnyRecord;
  deadline: number;
  services: NonNullable<OptimizationOptions["services"]>;
  specs: FacetSpec[];
  /** The checks the run required of the baseline; the candidate must keep every one. */
  requiredChecks: CheckResult[];
  // Set once the candidate is open and the preview acquired; releaseStage checks each before releasing it.
  handle: any;
  session: string | null;
  candidate: any;
  changedLive: boolean;
  // What the steps established, in order.
  before: { evidence: Evidence; checks: CheckResult[] } | null;
  validationMs: number;
  scenarios: AnyRecord[];
  diagnostics: AnyRecord[];
  guide: string;
  brief: string;
  workerMs: number;
  frozen: AnyRecord | null;
  after: { evidence: Evidence; checks: CheckResult[] } | null;
}

/** A step of the stage: the stage's result when it ends here, or null to go on. */
type Step = (stage: Stage) => Promise<OptimizationResult | null>;

/** The stage in order: each step either ends it (with its reason) or hands on to the next. */
const STEPS: readonly Step[] = [
  reconcileAdoption,
  refuseToStart,
  openCandidate,
  verifyBaseline,
  profileBaseline,
  briefWorker,
  buildCandidate,
  reviewCandidate,
  validateCandidate,
  judgePreservation,
  measureScenarios,
  checkFinalQuality,
];

/** Options carry the provisional quality boundary from the caller; they do not bypass it. */
export async function runOptimization(ctx: HarnessCtx, options: OptimizationOptions): Promise<OptimizationResult> {
  // The journal is the run's own record (autopilot.ts); the stage keeps its checkpoint on it.
  const saved = options.journal.optimization ?? null;
  if (saved?.result?.outcome && saved.result.outcome !== OptimizationOutcome.Interrupted) return saved.result;
  const stage = openStage(ctx, options, saved);
  try {
    for (const step of STEPS) {
      const ended = await step(stage);
      if (ended) return ended;
    }
    return await adoptCandidate(stage);
  } catch (error: any) {
    return await failStage(stage, error);
  } finally {
    await releaseStage(stage);
  }
}

/** A new checkpoint on the journal: the stage's allowance, and a result still pending. */
function newCheckpoint(run: Run, origin: string): AnyRecord {
  const allocatedMs = optimizationAllowance(run.budgets?.wallClockMs ?? DEFAULT_WALL_CLOCK_MS);
  return {
    schemaVersion: 1,
    runId: run.runId,
    project: run.project,
    origin,
    stageId: STAGE_ID,
    attempt: 0,
    phase: OptimizationPhase.Pending,
    baseline: null,
    candidate: null,
    adoptionIntent: null,
    budget: {
      allocatedMs,
      consumedMs: 0,
      workerAllocatedMs: allocatedMs * WORKER_SHARE,
      workerConsumedMs: 0,
      activeSegmentStartedAt: null,
    },
    result: emptyOptimization(run),
  };
}

/** The stage, resumed from `saved` or started fresh, charged for any downtime and bounded by its allowance. */
function openStage(ctx: HarnessCtx, options: OptimizationOptions, saved: AnyRecord | null): Stage {
  const {
    threadId,
    run,
    journal,
    origin = "autopilot_multi",
    specs = [],
    requiredChecks = [],
    deadline,
    // Injection seam for lifecycle tests; production uses the real collector, worker and critics.
    services = {},
  } = options;
  const checkpoint = saved ?? newCheckpoint(run, origin);
  if (!saved) journal.optimization = checkpoint;
  const stage: Stage = {
    ctx,
    bounded: ctx,
    options,
    run,
    stageRun: run,
    threadId,
    journal,
    checkpoint,
    result: checkpoint.result,
    budget: checkpoint.budget,
    deadline,
    services,
    specs,
    requiredChecks,
    handle: null,
    session: null,
    candidate: null,
    changedLive: false,
    before: null,
    validationMs: 0,
    scenarios: [],
    diagnostics: [],
    guide: "",
    brief: "",
    workerMs: 0,
    frozen: null,
    after: null,
  };
  charge(stage);
  const { budget } = stage;
  stage.deadline = Math.min(deadline, Date.now() + Math.max(0, budget.allocatedMs - budget.consumedMs));
  stage.stageRun = { ...run, optimizationDeadline: stage.deadline, optimizationThreadId: threadId };
  stage.bounded = boundedContext(stage);
  return stage;
}

/** A crash cannot refund the active segment. Conservatively include unaccounted downtime. */
function charge({ budget, checkpoint }: Stage): void {
  const now = Date.now();
  if (budget.activeSegmentStartedAt) {
    const elapsed = Math.max(0, now - Date.parse(budget.activeSegmentStartedAt));
    budget.consumedMs = Math.min(budget.allocatedMs, budget.consumedMs + elapsed);
    if (checkpoint.phase === OptimizationPhase.BuildingCandidate)
      budget.workerConsumedMs = Math.min(budget.workerAllocatedMs, budget.workerConsumedMs + elapsed);
  }
  budget.activeSegmentStartedAt = new Date(now).toISOString();
}

/** Throw when the user stopped the run or the stage's allowance is spent. */
function assertActive({ ctx, deadline }: Stage): void {
  if (ctx.cancelled) throw stageError("Stopped by user", OptimizationReason.Interrupted);
  if (Date.now() >= deadline) throw stageError("Optimization time allowance exhausted", OptimizationReason.Deadline);
}

/** Engine calls whose own timeout the stage clips to its deadline. */
const ENGINE_WORK: readonly string[] = [HostMethod.EngineComplete, HostMethod.EngineDelegate];

/** `ctx`, with every call checked against the stage's clock and every preview read raced against it. */
function boundedContext(stage: Stage): HarnessCtx {
  const { ctx, threadId } = stage;
  const bounded = Object.create(ctx);
  bounded.call = (method: string, payload: AnyRecord = {}) => {
    assertActive(stage);
    const operation = (ctx.call as ForwardedCall)(
      method,
      ENGINE_WORK.includes(method)
        ? {
            ...payload,
            timeoutMs: Math.max(1, Math.min(payload.timeoutMs ?? Infinity, stage.deadline - Date.now())),
            threadId,
          }
        : payload,
    );
    // An untrusted preview can stop answering. Race only read/observation work, never a writer:
    // delegated/direct builders must terminate before their completion promise settles.
    if (!method.startsWith("preview.")) return operation;
    return raceDeadline(stage, operation);
  };
  return bounded;
}

/** `operation`, or a rejection as soon as the user stops the run or the stage's clock runs out. */
function raceDeadline(stage: Stage, operation: Promise<unknown>): Promise<unknown> {
  const { ctx } = stage;
  let timer: ReturnType<typeof setInterval> | undefined;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setInterval(() => {
        if (ctx.cancelled || Date.now() >= stage.deadline)
          reject(
            stageError(
              "Preview observation stopped at the optimization deadline",
              ctx.cancelled ? OptimizationReason.Interrupted : OptimizationReason.Deadline,
            ),
          );
      }, POLL_MS);
    }),
  ]).finally(() => clearInterval(timer));
}

/** A call through the stage's bounded ctx, answered as loosely as a forwarded host call. */
function callBounded(stage: Stage, method: HostMethod, params?: unknown): Promise<any> {
  return (stage.bounded.call as ForwardedCall)(method, params);
}

/**
 * The stage's preview: a lease naming the build it judges (native-contract.ts `acquireFor`), since
 * the host refuses a raylib game's preview on a lease that names none. A game the library does not
 * describe, or a host that says nothing of itself, is judged in the browser.
 */
async function acquireStagePreview(stage: Stage): Promise<string> {
  const { run } = stage;
  const games = await callBounded(stage, HostMethod.GameList, {}).catch(() => []);
  const listed = Array.isArray(games) ? games.find((g: AnyRecord) => g?.name === run.project) : null;
  const game: LeaseGame = listed?.destinations ? { destinations: listed.destinations } : {};
  const capacity = (await callBounded(stage, HostMethod.PreviewCapacity, {}).catch(() => null)) ?? {};
  const call: AcquireCall = (method, params) => callBounded(stage, method, params);
  return (await acquireFor(call, game, capacity, { label: `optimization:${run.runId}`, purpose: STAGE_ID })).handle;
}

/** Save the stage's phase: its result, the run's journal and the checkpoint artifact. */
async function persist(stage: Stage, phase: OptimizationPhase): Promise<void> {
  const { ctx, checkpoint, result, journal, threadId, run } = stage;
  charge(stage);
  checkpoint.phase = phase;
  result.phase = phase;
  journal.phase = JournalPhase.Optimization;
  await saveOptimization(ctx, { threadId, run, result });
  await writeJournal(ctx, threadId, run.runId, journal);
  await ctx.call(HostMethod.RunArtifact, {
    runId: run.runId,
    name: "optimization/checkpoint.json",
    base64: Buffer.from(JSON.stringify(checkpoint, null, 2)).toString("base64"),
  });
}

/** Keep one of the stage's artifacts under `optimization/`; answers its path. */
async function artifact({ ctx, run }: Stage, name: string, value: unknown) {
  return ctx.call(HostMethod.RunArtifact, {
    runId: run.runId,
    name: `optimization/${name}`,
    base64: Buffer.from(typeof value === "string" ? value : JSON.stringify(value, null, 2)).toString("base64"),
  });
}

/** What the game was left on, said after a stage that did not improve it. */
function keptSummary({ result, checkpoint }: Stage, reasonCode: string): string {
  if (result.candidateAdopted) return "Verified candidate kept.";
  if (LIVE_PRESERVED.includes(reasonCode)) return "Current live files preserved.";
  if (checkpoint.baseline?.verified) return "Pre-optimization game kept.";
  return "Existing run verification outcome unchanged.";
}

/** End the stage: record the outcome and why, save it, and close the active budget segment. */
async function finish(
  stage: Stage,
  outcome: OptimizationOutcome,
  reasonCode: string,
  reason: string,
): Promise<OptimizationResult> {
  const { ctx, result, budget, journal, threadId, run } = stage;
  result.outcome = outcome;
  result.reasonCode = reasonCode;
  result.reason = reason;
  if (outcome !== OptimizationOutcome.Improved) result.summary = `${reason}. ${keptSummary(stage, reasonCode)}`;
  result.finishedAt = new Date().toISOString();
  await persist(stage, OptimizationPhase.Terminal);
  budget.activeSegmentStartedAt = null;
  await writeJournal(ctx, threadId, run.runId, journal);
  return result;
}

/** Reconcile exactly the durable adoption intent before considering new work. */
async function reconcileAdoption(stage: Stage): Promise<OptimizationResult | null> {
  const { ctx, checkpoint, result, run } = stage;
  if (checkpoint.adoptionIntent && checkpoint.baseline) {
    const recovered = await ctx.call(HostMethod.OptimizationReconcile, {
      project: run.project,
      baseline: checkpoint.baseline.revision,
      candidate: checkpoint.adoptionIntent.verifiedCandidate,
    });
    result.retainedRevision = recovered.revision;
    if (recovered.retained === RetainedTree.Candidate) {
      result.candidateAdopted = true;
      result.summary = "Verified optimization kept; adoption recovered after interruption";
      return finish(stage, OptimizationOutcome.Improved, OptimizationReason.AdoptionRecovered, result.summary);
    }
    if (recovered.retained === "changed")
      return finish(
        stage,
        OptimizationOutcome.Interrupted,
        OptimizationReason.LiveChanged,
        "Live files changed after the saved adoption intent; they were preserved",
      );
    checkpoint.adoptionIntent = null;
  }
  result.outcome = null;
  return null;
}

/** Say that the run is finishing, when it is: no new attempt starts then. */
async function finishRequested(stage: Stage): Promise<OptimizationResult | null> {
  if (!(await stage.ctx.runInbox?.finishing())) return null;
  return finish(
    stage,
    OptimizationOutcome.Skipped,
    OptimizationReason.FinishRequested,
    "Run is finishing at the user's request; no new optimization attempt started",
  );
}

/** Record the verified baseline's revision, then refuse an unverified baseline, a stop, a finish or too little time. */
async function refuseToStart(stage: Stage): Promise<OptimizationResult | null> {
  const { ctx, result, run, services, options } = stage;
  const { baselineSnapshot, baselineVerified, baselineEvidence } = options;
  if (!result.baseline && baselineSnapshot?.snapshot_id) {
    const revision = await ctx
      .call(HostMethod.OptimizationBaseline, { project: run.project, snapshotId: baselineSnapshot.snapshot_id })
      .catch(() => null);
    if (revision) {
      result.baseline = revision;
      result.retainedRevision ??= revision;
    }
  }
  const baselineReady = baselineVerified && baselineSnapshot?.snapshot_id && baselineEvidence?.ok;
  if (!baselineReady)
    return finish(
      stage,
      OptimizationOutcome.Skipped,
      OptimizationReason.BaselineUnverified,
      "Assembled game has not passed final verification",
    );
  if (ctx.cancelled)
    return finish(stage, OptimizationOutcome.Interrupted, OptimizationReason.Cancelled, "Stopped before optimization");
  const finishing = await finishRequested(stage);
  if (finishing) return finishing;
  if (stage.deadline - Date.now() < (services.minimumMs ?? MINIMUM_STAGE_MS))
    return finish(
      stage,
      OptimizationOutcome.Skipped,
      OptimizationReason.InsufficientTime,
      "Not enough time for measurement and preservation",
    );
  assertActive(stage);
  return null;
}

/** Open a fresh candidate on the verified baseline, and take a paused preview to observe it with. */
async function openCandidate(stage: Stage): Promise<null> {
  const { ctx, checkpoint, result, run, options, requiredChecks } = stage;
  const { baselineSnapshot, baselineVerdict = null, baselineEvidence } = options;
  if (checkpoint.candidate) {
    // An unfinished worker is never resumed against a partially edited tree.
    await ctx.call(HostMethod.OptimizationClose, { candidateId: checkpoint.candidate.candidateId });
    checkpoint.candidate = null;
  }
  const candidate = await callBounded(stage, HostMethod.OptimizationOpen, {
    project: run.project,
    runId: run.runId,
    baselineSnapshotId: baselineSnapshot?.snapshot_id,
  });
  stage.candidate = candidate;
  checkpoint.baseline = {
    revision: candidate.baseline,
    verified: true,
    qualityVerdict: baselineVerdict,
    evidenceRefs: refs(baselineEvidence),
    checkResults: requiredChecks,
  };
  result.baseline = candidate.baseline;
  result.retainedRevision = candidate.baseline;
  checkpoint.candidate = {
    candidateId: candidate.candidateId,
    root: candidate.root,
    revision: null,
    workerThreadId: null,
    workerSessionId: null,
    writerStopped: true,
  };
  result.startedAt ??= new Date().toISOString();
  await persist(stage, OptimizationPhase.VerifyingBaseline);
  stage.handle = await acquireStagePreview(stage);
  await callBounded(stage, HostMethod.PreviewCall, { method: PageMethod.Pause });
  stage.changedLive = true;
  return null;
}

/** A fresh evidence pass over `root`, from every camera the parts name, filed under `tag`. */
function observe(stage: Stage, root: string, tag: string): Promise<Evidence> {
  const cameras = [...new Set(stage.specs.flatMap((s: FacetSpec) => s.cameras ?? [DEFAULT_CAMERA]))];
  const evidence = stage.services.evidence ?? gatherEvidence;
  return evidence(stage.bounded, {
    run: stage.stageRun,
    iterationId: `optimization-${tag}`,
    seed: PAGE_SEED,
    handle: stage.handle,
    root,
    labelPrefix: `optimization/preservation/${tag}`,
    cameras: cameras.length ? cameras : [DEFAULT_CAMERA],
    eyes: true,
    motion: 6,
    audio: true,
    maxDemos: Infinity,
    userView: true,
  });
}

/** Every part's checks, fresh, over one evidence pass of `root`. */
function checkParts(stage: Stage, evidence: Evidence, root: string): Promise<CheckResult[]> {
  const checks = stage.services.checks ?? preservationChecks;
  return checks(stage.bounded, {
    run: stage.stageRun,
    specs: stage.specs,
    evidence,
    handle: stage.handle,
    root,
    deadline: stage.deadline,
  });
}

/** Observe and check the immutable baseline; it must still pass everything the run required. */
async function verifyBaseline(stage: Stage): Promise<OptimizationResult | null> {
  const { candidate, requiredChecks } = stage;
  const baselineStart = Date.now();
  const evidence = await observe(stage, candidate.baselineRoot, "baseline");
  await artifact(stage, "baseline/evidence.json", cleanEvidence(evidence));
  if (!evidence.ok)
    return finish(
      stage,
      OptimizationOutcome.Skipped,
      OptimizationReason.BaselineObservationFailed,
      `Immutable baseline could not be verified: ${(evidence.problems ?? []).join("; ")}`,
    );
  const checks = await checkParts(stage, evidence, candidate.baselineRoot);
  const missing = preservedChecks(requiredChecks, checks);
  if (missing.length)
    return finish(stage, OptimizationOutcome.Skipped, OptimizationReason.BaselineChecksUnverified, missing.join("; "));
  stage.before = { evidence, checks };
  stage.validationMs = Math.max(MINIMUM_VALIDATION_MS, Date.now() - baselineStart);
  const demo = evidence.registeredDemos?.find((n: unknown) => typeof n === "string");
  stage.scenarios = [
    { id: "default", seed: PAGE_SEED, camera: DEFAULT_CAMERA, demo: null },
    ...(demo ? [{ id: "demo", seed: PAGE_SEED, camera: DEFAULT_CAMERA, demo }] : []),
  ];
  return null;
}

/** Wait `ms`, checking the stage's clock as it goes. */
async function wait(stage: Stage, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    assertActive(stage);
    await sleep(Math.min(POLL_MS, end - Date.now()));
  }
}

/** Did the page refuse a `preview.call`? */
function refused(answer: AnyRecord | null | undefined): boolean {
  return Boolean(answer?.__missing || answer?.__error || answer?.ok === false);
}

/** Put the page on the scenario's workload: its seed, paused, then its demo or a warm default view. */
async function prepareScenario(stage: Stage, scenario: AnyRecord): Promise<void> {
  const { handle } = stage;
  for (const [method, arg] of [
    ["seed", scenario.seed],
    ["pause", undefined],
    ...(scenario.demo ? [["demo", scenario.demo]] : [["step", WARM_STEPS]]),
  ]) {
    const r = await callBounded(stage, HostMethod.PreviewCall, { handle, method, arg });
    if (refused(r)) throw new Error(`scenario ${method} unavailable`);
  }
  if (!scenario.demo) {
    const r = await callBounded(stage, HostMethod.PreviewCall, {
      handle,
      method: PageMethod.DebugCamera,
      arg: scenario.camera,
    });
    if (refused(r)) throw new Error("default camera unavailable");
  }
}

/** The stage's sampler: the injected one, or a live profile of the candidate's preview. */
function samplerOf(stage: Stage): Sampler {
  return (
    stage.services.sample ?? ((revision, scenario, counters = true) => profile(stage, revision, scenario, counters))
  );
}

/** One profile window of `revision` running `scenario`, warmed first and armed while paused. */
async function profile(stage: Stage, revision: AnyRecord, scenario: AnyRecord, counters: boolean): Promise<AnyRecord> {
  const { ctx, handle, run } = stage;
  assertActive(stage);
  await callBounded(stage, HostMethod.PreviewLoad, {
    project: run.project,
    candidateId: stage.candidate.candidateId,
    revision,
    handle,
  });
  await prepareScenario(stage, scenario);
  await callBounded(stage, HostMethod.PreviewCall, { handle, method: PageMethod.Start });
  await wait(stage, PROFILE_DEFAULTS.warmupMs);
  // Reset the workload after warming, before arming; manual renders are never samples.
  await prepareScenario(stage, scenario);
  const armed = await callBounded(stage, HostMethod.PreviewProfile, {
    action: ProfileAction.Begin,
    handle,
    runId: run.runId,
    stageId: STAGE_ID,
    scenarioId: scenario.id,
    expectedRevision: revision,
    warmupMs: 0,
    sampleMs: PROFILE_DEFAULTS.sampleMs,
    counters,
  });
  if (!armed.sessionId)
    throw stageError(armed.reason ?? "profiling capability unavailable", profileErrorCode(armed.reason));
  const session: string = armed.sessionId;
  stage.session = session;
  // The observer is armed while paused. Starting must not invalidate this single permitted transition.
  await callBounded(stage, HostMethod.PreviewProfile, { action: ProfileAction.Start, handle, sessionId: session });
  try {
    return await readSample(stage, session);
  } finally {
    await ctx
      .call(HostMethod.PreviewProfile, { action: ProfileAction.End, handle, sessionId: session })
      .catch(() => {});
    stage.session = null;
  }
}

/** Poll the armed session until its window closes, and answer the sample it took. */
async function readSample(stage: Stage, session: string): Promise<AnyRecord> {
  const { handle } = stage;
  while (true) {
    await wait(stage, POLL_MS);
    const read = await callBounded(stage, HostMethod.PreviewProfile, {
      action: ProfileAction.Read,
      handle,
      sessionId: session,
    });
    if (read.state === ProfileState.Unavailable) {
      await artifact(stage, "profile-unavailable.json", read);
      throw stageError(read.reason, profileErrorCode(read.reason));
    }
    if (read.state === ProfileState.Finished) {
      if (!finite(read.sample?.metrics?.frameMs?.value))
        throw stageError("insufficient live render frames", OptimizationReason.CapabilityMissing);
      return read.sample;
    }
  }
}

/** Profile the baseline once per scenario: the diagnostics the worker is briefed with. */
async function profileBaseline(stage: Stage): Promise<null> {
  const sample = samplerOf(stage);
  await persist(stage, OptimizationPhase.ProfilingBaseline);
  const diagnostics: AnyRecord[] = [];
  for (const scenario of stage.scenarios) diagnostics.push(await sample(stage.candidate.baseline, scenario));
  stage.diagnostics = diagnostics;
  await artifact(stage, "baseline/diagnostic.json", diagnostics);
  return null;
}

/** The worker's time: its share of the allowance, less what paired validation needs after the build. */
function workerAllowance({ budget, deadline, scenarios, services, validationMs }: Stage): number {
  const neededAfterBuild =
    scenarios.length * WINDOWS_PER_SCENARIO * (PROFILE_DEFAULTS.warmupMs + PROFILE_DEFAULTS.sampleMs) +
    2 * validationMs +
    POST_BUILD_MARGIN_MS;
  return Math.min(
    budget.workerAllocatedMs - budget.workerConsumedMs,
    deadline - Date.now() - (services.postBuildReserveMs ?? neededAfterBuild),
  );
}

/** Size the worker's time, then write its brief into the candidate; a new attempt begins. */
async function briefWorker(stage: Stage): Promise<OptimizationResult | null> {
  const { ctx, candidate, checkpoint, result, run, services } = stage;
  stage.workerMs = workerAllowance(stage);
  if (stage.workerMs < (services.minimumWorkerMs ?? MINIMUM_WORKER_MS))
    return finish(
      stage,
      OptimizationOutcome.Skipped,
      OptimizationReason.InsufficientTime,
      "Not enough time remains for a bounded worker and fresh paired validation",
    );
  const finishing = await finishRequested(stage);
  if (finishing) return finishing;
  stage.guide = await readFile(path.join(ctx.workspace, "prompts", "optimization.md"), "utf8");
  stage.brief = optimizationBrief({
    guide: stage.guide,
    run,
    candidate,
    workerMs: stage.workerMs,
    diagnostics: stage.diagnostics,
  });
  await artifact(stage, "brief.md", stage.brief);
  await callBounded(stage, HostMethod.GameWrite, {
    project: run.project,
    candidateId: candidate.candidateId,
    file: ".studio/BRIEF.md",
    contents: stage.brief,
  });
  checkpoint.attempt++;
  result.attempt = checkpoint.attempt;
  return null;
}

/** Run the worker on the candidate; its time is charged whether it finishes or throws. */
async function buildCandidate(stage: Stage): Promise<null> {
  const { bounded, candidate, checkpoint, brief, workerMs } = stage;
  const worker = stage.services.worker ?? (() => runWorker(stage));
  checkpoint.candidate.writerStopped = false;
  await persist(stage, OptimizationPhase.BuildingCandidate);
  try {
    await worker({ ctx: bounded, candidate, brief, workerMs });
  } finally {
    charge(stage);
    checkpoint.candidate.writerStopped = true;
  }
  assertActive(stage);
  return null;
}

/** The built-in worker: the run's builder, delegated when its engine keeps sessions, else a direct turn. */
async function runWorker(stage: Stage): Promise<void> {
  const { checkpoint, run } = stage;
  const described = await callBounded(stage, HostMethod.EngineDescribe, {});
  const workerThread = await callBounded(stage, HostMethod.ThreadCreate, { title: `${run.runId} · Optimization` });
  checkpoint.candidate.workerThreadId = workerThread.id ?? workerThread;
  await persist(stage, OptimizationPhase.BuildingCandidate);
  if (supportsSessions(described.find((e: AnyRecord) => e.id === roleEngine(run, RoleKey.Builder)))) {
    await delegateWorker(stage);
    return;
  }
  await directWorker(stage);
}

/** A delegated builder owns the candidate's sources for one bounded session. */
async function delegateWorker(stage: Stage): Promise<void> {
  const { candidate, checkpoint, run, threadId } = stage;
  const files = await callBounded(stage, HostMethod.GameTree, {
    project: run.project,
    candidateId: candidate.candidateId,
  });
  const r = await callBounded(stage, HostMethod.EngineDelegate, {
    engine: roleEngine(run, RoleKey.Builder),
    model: run.model,
    effort: roleEffort(run, RoleKey.Builder),
    project: run.project,
    cwd: candidate.root,
    candidateId: candidate.candidateId,
    prompt: stage.brief,
    threadId,
    timeoutMs: stage.workerMs,
    ownership: {
      facetId: STAGE_ID,
      owns: [...files.filter((f: string) => !f.endsWith(".md")), "src"],
      ownsMain: true,
      ...(run.ownShape === true ? { template: false } : {}),
    },
  });
  checkpoint.candidate.workerSessionId = r.sessionId ?? null;
  if (!r.ok) throw new Error(r.errorText ?? r.stopReason ?? "Optimization worker failed");
}

/** A completion-only builder works the candidate in a bounded tool loop on the worker's own thread. */
async function directWorker(stage: Stage): Promise<void> {
  const { ctx, bounded, candidate, checkpoint, run } = stage;
  const turn = await callBounded(stage, HostMethod.TurnBegin, {
    threadId: checkpoint.candidate.workerThreadId,
    input: [{ role: "user", content: stage.brief }],
    metadata: { runId: run.runId, phase: STAGE_ID },
  });
  try {
    const r = await runTurn(bounded, {
      threadId: checkpoint.candidate.workerThreadId,
      turnId: turn.turnId,
      engine: roleEngine(run, RoleKey.Builder),
      model: run.model,
      project: run.project,
      runId: run.runId,
      candidateId: candidate.candidateId,
      maxRounds: DIRECT_WORKER_ROUNDS,
      deadlineMs: Date.now() + stage.workerMs,
      extraSystem: stage.guide,
    });
    const cutShort = r?.stopped === TurnStop.Cancelled || r?.stopped === TurnStop.Deadline;
    if (cutShort) throw new Error(`worker ${r.stopped}`);
    await ctx.call(HostMethod.TurnEnd, { turnId: turn.turnId, status: TurnStatus.Ok });
  } catch (e) {
    await ctx.call(HostMethod.TurnEnd, { turnId: turn.turnId, status: TurnStatus.Error });
    throw e;
  }
}

/** Freeze what the worker made; it must change source, and within the contract rules. */
async function reviewCandidate(stage: Stage): Promise<OptimizationResult | null> {
  const { candidate, checkpoint, result, run } = stage;
  const frozen = await callBounded(stage, HostMethod.OptimizationFreeze, { candidateId: candidate.candidateId });
  stage.frozen = frozen;
  checkpoint.candidate.revision = frozen.revision;
  result.candidate = frozen.revision;
  result.changedFiles = frozen.changedFiles;
  if (!frozen.changedFiles.some((f: string) => !f.endsWith(".md") && !f.startsWith(".studio/")))
    return finish(
      stage,
      OptimizationOutcome.NoImprovement,
      OptimizationReason.NoSourceChange,
      "No source optimization proposed",
    );
  const spec = { id: STAGE_ID, owns: frozen.changedFiles, checks: [] };
  // A game the user brought is judged by the contract rules only (M4.6): its own Math.random
  // and its own clock are the game, and a single one of them used to discard the whole
  // optimized candidate.
  const violations = mechanicalReview(frozen.diff, spec, {
    ownsMain: true,
    template: run.ownShape !== true,
    // The run's stack, whichever it is (review.ts reads it as `reviewAttempt` does): a Rust
    // game's diff is never read by rules the night's stack does not have.
    stack: typeof run.stack === "string" ? run.stack : null,
  });
  if (violations.length)
    return finish(
      stage,
      OptimizationOutcome.NoImprovement,
      OptimizationReason.ContractRegression,
      violations.map((v) => v.what).join("; "),
    );
  await artifact(stage, `candidate/${result.attempt}/source.diff`, frozen.diff);
  return null;
}

/** What the candidate lost against the baseline: checks, scoreboard lines, demos and cameras. */
function lostWork(stage: Stage, before: AnyRecord, after: AnyRecord): string[] {
  const { requiredChecks } = stage;
  const checkLoss = [
    ...preservedChecks(before.checks, after.checks),
    ...preservedChecks(requiredChecks, after.checks),
    ...compareScoreboards(toScoreboard(before.checks), toScoreboard(after.checks)).regressions,
  ];
  const afterDemos = after.evidence.registeredDemos ?? [];
  for (const demo of before.evidence.registeredDemos ?? [])
    if (!afterDemos.includes(demo)) checkLoss.push(`lost demo ${demo}`);
  for (const shot of before.evidence.shots)
    if (!after.evidence.shots.some((s: Shot) => s.camera === shot.camera)) checkLoss.push(`lost camera ${shot.camera}`);
  return checkLoss;
}

/** Observe and check the candidate; it must run, and keep everything the baseline had. */
async function validateCandidate(stage: Stage): Promise<OptimizationResult | null> {
  const { candidate, result } = stage;
  await persist(stage, OptimizationPhase.ValidatingCandidate);
  const evidence = await observe(stage, candidate.root, "candidate");
  if (!evidence.ok)
    return finish(
      stage,
      OptimizationOutcome.NoImprovement,
      OptimizationReason.CandidateBroken,
      "Candidate failed runtime verification",
    );
  const checks = await checkParts(stage, evidence, candidate.root);
  stage.after = { evidence, checks };
  const checkLoss = lostWork(stage, stage.before as AnyRecord, stage.after);
  if (!checkLoss.length) return null;
  result.preservation = { status: PreservationStatus.Regressed, reasons: checkLoss, evidenceRefs: refs(evidence) };
  return finish(
    stage,
    OptimizationOutcome.NoImprovement,
    OptimizationReason.PreservationRegression,
    checkLoss.join("; "),
  );
}

/** The preservation critic compares the two builds; the candidate must look and play the same. */
async function judgePreservation(stage: Stage): Promise<OptimizationResult | null> {
  const { bounded, result, frozen } = stage;
  const before = stage.before as NonNullable<Stage["before"]>;
  const after = stage.after as NonNullable<Stage["after"]>;
  const preserved = await (stage.services.preserve ?? optimizationPreservation)(bounded, {
    run: stage.stageRun,
    baseline: before.evidence,
    candidate: after.evidence,
    diff: frozen?.diff,
    checks: { before: before.checks, after: after.checks },
  });
  result.preservation = {
    status: preserved.status,
    reasons: preserved.reasons,
    evidenceRefs: [...refs(before.evidence), ...refs(after.evidence)],
  };
  await artifact(stage, `preservation/${result.attempt}/verdict.json`, {
    ...preserved,
    before: cleanEvidence(before.evidence),
    after: cleanEvidence(after.evidence),
    beforeChecks: before.checks,
    afterChecks: after.checks,
  });
  if (preserved.status !== PreservationStatus.Preserved)
    return finish(
      stage,
      OptimizationOutcome.NoImprovement,
      OptimizationReason.PreservationUnverified,
      "Preservation was not verified",
    );
  result.summary = preserved.summary;
  return null;
}

/** Paired samples of baseline and candidate, and a closing baseline bracket. */
async function pairedSamples(stage: Stage, scenario: AnyRecord, counters: boolean) {
  const sample = samplerOf(stage);
  const baseline = stage.candidate.baseline;
  const candidate = stage.frozen?.revision;
  const before: AnyRecord[] = [];
  const after: AnyRecord[] = [];
  for (let i = 0; i < PAIRED_SAMPLES; i++) {
    const a = await sample(baseline, scenario, counters);
    const b = await sample(candidate, scenario, counters);
    before.push(a);
    after.push(b);
    if (counters) {
      await artifact(stage, `baseline/${scenario.id}/sample-${i}.json`, a);
      await artifact(stage, `candidate/${stage.result.attempt}/${scenario.id}/sample-${i}.json`, b);
    }
  }
  const bracket = await sample(baseline, scenario, counters);
  return { before, after, bracket };
}

/**
 * Counter instrumentation overhead must not manufacture the win. Repeat timing with
 * counter collection disabled on both versions, retaining the minimal cadence wrapper.
 */
async function controlOverhead(stage: Stage, scenario: AnyRecord, comparison: AnyRecord): Promise<void> {
  const off = await pairedSamples(stage, scenario, false);
  await artifact(stage, `candidate/${stage.result.attempt}/${scenario.id}/overhead-control.json`, off);
  const control = comparePerformance(off.before, off.after, off.bracket);
  const frameGainLost = comparison.gains.includes("frameMs") && !control.improved;
  const survivedControl = control.comparable && !control.reason.includes("regressed") && !frameGainLost;
  if (survivedControl) return;
  comparison.improved = false;
  comparison.reason = "Benefit did not survive counter-observer overhead control";
  comparison.gains = [];
}

/** Measure every scenario on both builds; a regression or an incomparable pair ends the stage. */
async function measureScenarios(stage: Stage): Promise<OptimizationResult | null> {
  const { result } = stage;
  await persist(stage, OptimizationPhase.ProfilingCandidate);
  result.scenarios = [];
  for (const scenario of stage.scenarios) {
    const { before, after, bracket } = await pairedSamples(stage, scenario, true);
    await artifact(stage, `baseline/${scenario.id}/bracket.json`, bracket);
    const comparison = comparePerformance(before, after, bracket);
    if (comparison.improved) await controlOverhead(stage, scenario, comparison);
    result.scenarios.push({ id: scenario.id, workload: scenario, before, after, comparison });
    const regressed = !comparison.improved && comparison.reason.includes("regressed");
    if (!comparison.comparable || regressed)
      return finish(
        stage,
        OptimizationOutcome.NoImprovement,
        OptimizationReason.IncomparableOrRegressed,
        comparison.reason,
      );
  }
  if (!result.scenarios.some((s: AnyRecord) => s.comparison.improved))
    return finish(
      stage,
      OptimizationOutcome.NoImprovement,
      OptimizationReason.Inconclusive,
      "No verified performance improvement",
    );
  return null;
}

/** Fresh final global quality evaluation of C; never reuse B's ledger verdict for C. */
async function checkFinalQuality(stage: Stage): Promise<OptimizationResult | null> {
  const { bounded, candidate, handle } = stage;
  const { quality } = stage.options;
  await persist(stage, OptimizationPhase.FinalQuality);
  const finalCandidate = await observe(stage, candidate.root, "final-candidate");
  const finalQuality = quality
    ? await quality(bounded, {
        run: stage.stageRun,
        evidence: finalCandidate,
        baseline: (stage.before as NonNullable<Stage["before"]>).evidence,
        handle,
        root: candidate.root,
      })
    : false;
  if (finalCandidate.ok && finalQuality) return null;
  return finish(
    stage,
    OptimizationOutcome.NoImprovement,
    OptimizationReason.FinalQualityFailed,
    "Candidate did not pass fresh final quality verification",
  );
}

/** Adopt the verified candidate: the intent is saved before the live folder is touched. */
async function adoptCandidate(stage: Stage): Promise<OptimizationResult> {
  const { candidate, checkpoint, result } = stage;
  const verifiedCandidate = stage.frozen?.revision;
  assertActive(stage);
  await callBounded(stage, HostMethod.OptimizationFreeze, { candidateId: candidate.candidateId }); // assert no late source writes
  const validationArtifact = await artifact(stage, `candidate/${result.attempt}/validation.json`, result);
  checkpoint.adoptionIntent = { expectedLive: candidate.baseline, verifiedCandidate, validationArtifact };
  await persist(stage, OptimizationPhase.Adopting); // must succeed before mutation
  assertActive(stage);
  const promoted = await callBounded(stage, HostMethod.OptimizationPromote, {
    candidateId: candidate.candidateId,
    expectedLive: candidate.baseline,
    verifiedCandidate,
    resultArtifact: validationArtifact,
  });
  result.retainedRevision = promoted.revision ?? candidate.baseline;
  if (promoted.outcome !== PromotionOutcome.Promoted)
    return finish(
      stage,
      OptimizationOutcome.NoImprovement,
      promoted.outcome,
      promoted.reason ?? "Candidate was not applied",
    );
  result.candidateAdopted = true;
  return finish(
    stage,
    OptimizationOutcome.Improved,
    OptimizationReason.VerifiedGain,
    "Measured improvement retained with appearance and gameplay preserved",
  );
}

/** How a failed stage is filed: stopped, unable to measure or out of time, or failed. */
function failureOutcome({ ctx }: Stage, error: any): OptimizationOutcome {
  if (ctx.cancelled || error.code === OptimizationReason.Interrupted) return OptimizationOutcome.Interrupted;
  if (SKIPPING_FAILURES.includes(error.code)) return OptimizationOutcome.Skipped;
  return OptimizationOutcome.Failed;
}

/** A step threw: settle a half-done adoption, then end the stage with the error's code. */
async function failStage(stage: Stage, error: any): Promise<OptimizationResult> {
  const { ctx, checkpoint, result, run } = stage;
  // Adoption is a transaction: a failed response/write may still have applied verified C.
  if (checkpoint.adoptionIntent && checkpoint.baseline) {
    const recovered = await ctx
      .call(HostMethod.OptimizationReconcile, {
        project: run.project,
        baseline: checkpoint.baseline.revision,
        candidate: checkpoint.adoptionIntent.verifiedCandidate,
      })
      .catch(() => null);
    if (recovered) {
      result.retainedRevision = recovered.revision;
      result.candidateAdopted = recovered.retained === RetainedTree.Candidate;
    }
  }
  return finish(
    stage,
    failureOutcome(stage, error),
    error.code ?? OptimizationReason.StageFailed,
    String(error.message ?? error),
  );
}

/** Give back what the stage held: the profile session, the preview, the candidate, the live view. */
async function releaseStage({ ctx, candidate, changedLive, checkpoint, handle, run, session }: Stage): Promise<void> {
  if (session && handle)
    await ctx
      .call(HostMethod.PreviewProfile, { action: ProfileAction.End, handle, sessionId: session })
      .catch(() => {});
  if (handle) await ctx.call(HostMethod.PreviewRelease, { handle }).catch(() => {});
  if (candidate && checkpoint.candidate?.writerStopped)
    await ctx.call(HostMethod.OptimizationClose, { candidateId: candidate.candidateId }).catch(() => {});
  if (changedLive) await ctx.call(HostMethod.PreviewLoad, { project: run.project }).catch(() => {});
}
