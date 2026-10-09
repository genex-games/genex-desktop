/**
 * A run's record: the custom events on its thread and the journal a resume replays.
 *
 * Every mode wrote these for itself — the director, the classic pipeline, a facet, the gauntlet —
 * and every copy ended in `.catch(() => {})`. A feed card or a journal write is never worth a
 * run, so a failure still must not throw; but one that nobody hears about is how a run ends
 * with no journal to resume from and nothing in any log to say why. A failure is now written to
 * the harness's stderr (the host keeps it in its log), at most once a minute per kind, with how
 * many were not written out in between.
 */

import { HostMethod } from "./host-methods.ts";
import { CLIP_REASON, clip } from "./text.ts";
import { MINUTE_MS } from "./time.ts";
import type { HarnessCtx } from "../types/harness.d.ts";

/**
 * Every custom event name the harness writes or reads: `appendRun(ctx, threadId, RunEvent.RunFinished, …)`.
 * The studio reads these records back from logs of any age, so a value is never renamed; the app
 * names each one too (tests/conformance/seed-contracts.test.ts holds the two together).
 */
export const RunEvent = {
  // the unattended run and its lead
  AutopilotBase: "autopilot_base",
  AutopilotBaseStarted: "autopilot_base_started",
  AutopilotDecision: "autopilot_decision",
  AutopilotPaused: "autopilot_paused",
  AutopilotPlanReview: "autopilot_plan_review",
  AutopilotProviderOutage: "autopilot_provider_outage",
  AutopilotResumed: "autopilot_resumed",
  AutopilotStarted: "autopilot_started",
  DirectorContinued: "director_continued",
  DirectorProgress: "director_progress",
  DirectorShow: "director_show",
  DirectorVerdict: "director_verdict",
  DirectorWorker: "director_worker",
  IntegrationHealth: "integration_health",
  IntegrationLedger: "integration_ledger",
  IntegrationMerge: "integration_merge",
  ObservationOutage: "observation_outage",
  OptimizationUpdated: "optimization_updated",
  RunBackoff: "run_backoff",
  RunControl: "run_control",
  RunControlApplied: "run_control_applied",
  RunFinished: "run_finished",
  RunFollowupRequested: "run_followup_requested",
  RunInteractionEvidence: "run_interaction_evidence",
  RunIteration: "run_iteration",
  RunLearning: "run_learning",
  RunRegistered: "run_registered",
  RunStartBlocked: "run_start_blocked",
  RunStarted: "run_started",
  RunSteering: "run_steering",
  RunSteeringDelivered: "run_steering_delivered",
  RunVisualEvidence: "run_visual_evidence",
  WorkerStopRequested: "worker_stop_requested",
  // one part's rounds
  FacetBuildStarted: "facet_build_started",
  FacetCheckAdded: "facet_check_added",
  FacetCheckReplanned: "facet_check_replanned",
  FacetCheckRetired: "facet_check_retired",
  FacetCircuitBreak: "facet_circuit_break",
  FacetDefectRouted: "facet_defect_routed",
  FacetFix: "facet_fix",
  FacetFlag: "facet_flag",
  FacetFollowup: "facet_followup",
  FacetIteration: "facet_iteration",
  FacetLessons: "facet_lessons",
  FacetLiveness: "facet_liveness",
  FacetMachinePressure: "facet_machine_pressure",
  FacetMove: "facet_move",
  FacetObservationOutage: "facet_observation_outage",
  FacetPartialEvaluated: "facet_partial_evaluated",
  FacetProviderOutage: "facet_provider_outage",
  FacetRebaselined: "facet_rebaselined",
  FacetReview: "facet_review",
  FacetReviewEnforced: "facet_review_enforced",
  FacetSessionReset: "facet_session_reset",
  FacetSpike: "facet_spike",
  FacetSteered: "facet_steered",
  FacetStopped: "facet_stopped",
  FacetWindDown: "facet_wind_down",
  RecipeOutcome: "recipe_outcome",
  // the conversation, its queue and its sessions
  Compacted: "compacted",
  CompactionFailed: "compaction_failed",
  ContextUsage: "context_usage",
  ContractorHandoff: "contractor_handoff",
  ContractorSession: "contractor_session",
  CoordinatorMessageDelivered: "coordinator_message_delivered",
  CoordinatorMessageHandled: "coordinator_message_handled",
  CoordinatorMessageProcessing: "coordinator_message_processing",
  CoordinatorMessageQueued: "coordinator_message_queued",
  CoordinatorMessageRemoved: "coordinator_message_removed",
  CoordinatorMessageRequeued: "coordinator_message_requeued",
  CoordinatorMessageSteering: "coordinator_message_steering",
  CoordinatorMessageUpdated: "coordinator_message_updated",
  CoordinatorQueuePaused: "coordinator_queue_paused",
  CoordinatorQueueResumed: "coordinator_queue_resumed",
  DelegationIncomplete: "delegation_incomplete",
  EngineFallback: "engine_fallback",
  InterviewQuestion: "interview_question",
  NeedsSignin: "needs_signin",
  PlanReview: "plan_review",
  /** The first time a project's preview reported itself ready after a build (first-preview.ts). */
  PreviewReady: "preview_ready",
  SessionActivity: "session_activity",
  // the harness itself and what it learns
  BuildObservation: "build_observation",
  HarnessBooted: "harness_booted",
  RebuildAndRestartStudio: "rebuild_and_restart_studio",
  SelfEdit: "self_edit",
  SkillEdited: "skill_edited",
  SkilloptAccepted: "skillopt_accepted",
  SkilloptLessonsStaged: "skillopt_lessons_staged",
  SkilloptPass: "skillopt_pass",
  SkilloptRejected: "skillopt_rejected",
  SkilloptStaged: "skillopt_staged",
  ToolFailure: "tool_failure",
  ToolInstalled: "tool_installed",
} as const;
export type RunEvent = (typeof RunEvent)[keyof typeof RunEvent];

/** Where a run's journal stands (`journal.phase`); a resume reads it back, so a value is never renamed. */
export const JournalPhase = {
  /** The classic pipeline's one-part run. */
  Single: "single",
  /** A director run: the lead's own session. */
  Director: "director",
  Base: "base",
  Facets: "facets",
  Integrate: "integrate",
  Ledger: "ledger",
  IntegrationFacet: "integration-facet",
  Verdict: "verdict",
  Optimization: "optimization",
  /** Stopped before it finished: a resume picks it up. */
  Paused: "paused",
  Done: "done",
} as const;
export type JournalPhase = (typeof JournalPhase)[keyof typeof JournalPhase];

/**
 * The `type` of an event's `data` in the log. Every log keeps it: never rename a value. The app's
 * copy is `EventKind` in `shared/event-log.ts` (tests/conformance/seed-contracts.test.ts).
 */
export const EventKind = {
  ThreadCreated: "thread_created",
  ThreadUpdated: "thread_updated",
  ThreadDeleted: "thread_deleted",
  ThreadForked: "thread_forked",
  SessionStarted: "session_started",
  SessionEnded: "session_ended",
  TurnStarted: "turn_started",
  TurnEnded: "turn_ended",
  Messages: "messages",
  ToolRequested: "tool_requested",
  ToolResult: "tool_result",
  Error: "error",
  ArtifactWritten: "artifact_written",
  SnapshotCreated: "snapshot_created",
  WorkspaceRestored: "workspace_restored",
  Custom: "custom",
} as const;
export type EventKind = (typeof EventKind)[keyof typeof EventKind];

/** Where a run stands, as the log folds it. The app folds the same log: never rename a value. */
export const RunState = {
  Running: "running",
  Paused: "paused",
  Finished: "finished",
  Superseded: "superseded",
} as const;
export type RunState = (typeof RunState)[keyof typeof RunState];

/** Which run an interview commissions: an Autopilot run, or the unattended loop. */
export const InterviewMode = {
  Autopilot: "autopilot",
  Loop: "loop",
} as const;
export type InterviewMode = (typeof InterviewMode)[keyof typeof InterviewMode];

/**
 * Who wrote a `run_steering` event other than the user (`source`): the director steering its own
 * worker. The user's steering carries no source. Never rename a value.
 */
export const SteeringSource = {
  Director: "director",
} as const;
export type SteeringSource = (typeof SteeringSource)[keyof typeof SteeringSource];

/** How a run is run (`mode` on its report, its journal and its ledger records): never rename a value. */
export const RunMode = {
  /** The classic pipeline: planned parts, run by rule. */
  Autopilot: "autopilot",
  /** One agent's decisions: the director and its workers. */
  Director: "director",
} as const;
export type RunMode = (typeof RunMode)[keyof typeof RunMode];

/** What a run's bar is (`reference.kind`): stills of a real game, or a described feeling. Never rename a value. */
export const ReferenceKind = {
  Reference: "reference",
  Direction: "direction",
} as const;
export type ReferenceKind = (typeof ReferenceKind)[keyof typeof ReferenceKind];

/** Stills that make the bar a picture (`ReferenceKind.Reference`) rather than a described direction. */
export const REFERENCE_MIN_STILLS = 2;

/**
 * How a run's close describes it (`report.executionStatus` on `run_finished`). The app reads it
 * (its copy is `ExecutionStatus` in `shared/run-state.ts`): never rename a value.
 */
export const ExecutionStatus = {
  Running: "running",
  Paused: "paused",
  Completed: "completed",
  Cancelled: "cancelled",
  Failed: "failed",
} as const;
export type ExecutionStatus = (typeof ExecutionStatus)[keyof typeof ExecutionStatus];

/** How long one kind of failure stays quiet after it has been said. */
export const FAILURE_LOG_EVERY_MS = MINUTE_MS;

const lastSaid = new Map<string, { at: number; quiet: number }>();

/**
 * Say that something the run meant to record did not get recorded. Rate-limited per `what`;
 * returns whether a line was written. `write` and `now` are for tests.
 */
export function logFailure(
  what: string,
  err: any,
  {
    now = Date.now(),
    write = (line: string): unknown => process.stderr.write(line),
  }: { now?: number; write?: (line: string) => unknown } = {},
): boolean {
  const entry = lastSaid.get(what) ?? { at: -Infinity, quiet: 0 };
  if (now - entry.at < FAILURE_LOG_EVERY_MS) {
    entry.quiet += 1;
    lastSaid.set(what, entry);
    return false;
  }
  const also = entry.quiet ? ` (and ${entry.quiet} more since the last report)` : "";
  lastSaid.set(what, { at: now, quiet: 0 });
  try {
    write(`[harness] ${what} failed${also}: ${clip(String(err?.message ?? err), CLIP_REASON)}\n`);
  } catch {
    /* a log that cannot be written is the last thing that may take a run down */
  }
  return true;
}

/** Forget what has been said (tests). */
export function resetFailureLog() {
  lastSaid.clear();
}

/**
 * Append one custom event to a run's thread. Resolves to what the host answered, or undefined
 * when the write failed — which is logged, never thrown. `runId` is stamped first when given,
 * so a payload's own `runId` still wins.
 */
export function appendRun(
  ctx: HarnessCtx,
  threadId: string,
  eventType: string,
  payload: object,
  { runId = null }: { runId?: string | null } = {},
): Promise<string | void> {
  const body = runId ? { runId, ...payload } : payload;
  return ctx
    .call(HostMethod.EventsAppend, {
      threadId,
      batch: [{ type: EventKind.Custom, event_type: eventType, payload: body }],
    })
    .catch((err) => {
      logFailure(`events.append ${eventType}`, err);
    });
}

/** The journal a run resumes from: `autopilot_<runId>` on its thread. Failures are logged, never thrown. */
export function saveJournal(
  ctx: HarnessCtx,
  threadId: string,
  runId: string,
  journal: unknown,
): Promise<number | void> {
  return ctx
    .call(HostMethod.ArtifactWrite, { threadId, artifactId: `autopilot_${runId}`, value: journal })
    .catch((err) => {
      logFailure("the run journal write", err);
    });
}

/**
 * Write one file into the run's own folder (`run.artifact`): text as it is, anything else as
 * pretty-printed JSON. Like every record of a run, a failed write is never worth the run.
 */
export function writeRunArtifact(ctx: HarnessCtx, runId: string, name: string, value: unknown): Promise<unknown> {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return ctx
    .call(HostMethod.RunArtifact, { runId, name, base64: Buffer.from(text).toString("base64") })
    .catch(() => {});
}

/** Who established an interaction result (`run_interaction_evidence.source`): the app's `InteractionSource`, word for word. */
export const InteractionSource = {
  IndependentPlaytester: "independent-playtester",
  HandsOnJudge: "hands-on-judge",
  RouteReplay: "route-replay",
} as const;
export type InteractionSource = (typeof InteractionSource)[keyof typeof InteractionSource];

/** Whether an interaction result rests on the studio's check of the game's state or the model's word: the app's `InteractionObjective`. */
export const InteractionObjective = {
  StudioVerified: "studio-verified",
  ModelSaid: "model-said",
} as const;
export type InteractionObjective = (typeof InteractionObjective)[keyof typeof InteractionObjective];
