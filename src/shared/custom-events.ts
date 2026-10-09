/**
 * Durable custom events: the `{ type: "custom", event_type, payload }` records in the append-only
 * log (`shared/event-log.ts`). The harness seed, the core and the dev fixtures write them; the
 * renderer, `shared/` derivations and the harness read them back, from logs of any age.
 *
 * `CustomEvent` names every `event_type` the studio writes or reads (`CUSTOM_EVENT_TYPES` lists the
 * same names), and `tests/conformance/custom-events.test.ts` keeps it complete. Write a name as
 * `CustomEvent.RunFinished` and a record as `customEventData(name, payload)`. `CustomEventMap`
 * types the payloads the app reads. Every field is optional, because most of these records are written by the
 * harness, which the in-app agent may edit, and old logs keep old shapes. Read them through
 * `customEvent` / `customPayload`, never `payload as`.
 */
import type { ChatActivityPhase } from "./chat-activity.ts";
import type { ChatRewind } from "./chat-rewind.ts";
import type { PlanReviewRecord } from "./composer.ts";
import type { ContextMeasurement } from "./context.ts";
import type { AssetDeliveredPayload, PluginToolFinishedPayload, PluginToolStartedPayload } from "./game-assets.ts";
import type { PluginConsentEvent } from "./plugins.ts";
import type { ToolPermissionEvent } from "./permissions.ts";
import type { SteerDelivery } from "./message-queue.ts";
import type { Usage } from "./event-log.ts";
import type { BuildObservation, ReadyResult, ReadyVia } from "./preview-contract.ts";
import type { RunSpec } from "./protocol.ts";

/**
 * Every custom event name in the studio's own code. A few are only read: names older versions
 * wrote (`blender_asset`, `run_paused`, `run_resumed`, `run_settled`, `build_landed`,
 * `connections_applied`, `tool_failure`, `skillopt_lessons_staged`) so old logs still read.
 * The values are persisted in every log: never rename one.
 */
export const CustomEvent = {
  // assets and plugins
  AssetDelivered: "asset_delivered",
  BlenderAsset: "blender_asset",
  ConnectorTool: "connector_tool",
  PluginConsent: "plugin_consent",
  PluginTool: "plugin_tool",
  PluginToolStarted: "plugin_tool_started",
  /** Claude asking the person before it uses a tool (shared/permissions.ts); written by the host only. */
  ToolPermission: "tool_permission",
  // the unattended run and its lead
  AutopilotBase: "autopilot_base",
  AutopilotBaseStarted: "autopilot_base_started",
  AutopilotDecision: "autopilot_decision",
  AutopilotPaused: "autopilot_paused",
  AutopilotPlanReview: "autopilot_plan_review",
  AutopilotProviderOutage: "autopilot_provider_outage",
  AutopilotResumed: "autopilot_resumed",
  AutopilotStarted: "autopilot_started",
  BuildLanded: "build_landed",
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
  /** The studio resumed a paused run on its own (`main/core/auto-resume.ts`); written by the host only. */
  RunAutoResumed: "run_auto_resumed",
  RunBackoff: "run_backoff",
  RunControl: "run_control",
  RunControlApplied: "run_control_applied",
  RunFinished: "run_finished",
  RunFollowupRequested: "run_followup_requested",
  RunInteractionEvidence: "run_interaction_evidence",
  RunIteration: "run_iteration",
  RunLearning: "run_learning",
  RunPaused: "run_paused",
  RunRegistered: "run_registered",
  RunResumed: "run_resumed",
  RunSettled: "run_settled",
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
  /** One direct model call (`engine.complete`) and what served it; written by the host only. */
  CompletionCall: "completion_call",
  ConnectionsApplied: "connections_applied",
  ContextUsage: "context_usage",
  ContractorHandoff: "contractor_handoff",
  ContractorSession: "contractor_session",
  ConversationCapabilitiesApplied: "conversation_capabilities_applied",
  ConversationRewound: "conversation_rewound",
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
  /** The first time a project's preview reported itself ready after a build; written by the harness. */
  PreviewReady: "preview_ready",
  PlanningCapabilitiesApplied: "planning_capabilities_applied",
  SessionActivity: "session_activity",
  ToolRegistryApplied: "tool_registry_applied",
  UserFeedback: "user_feedback",
  // the studio itself: its harness, learning and games
  BuildObservation: "build_observation",
  FixtureNoise: "fixture_noise",
  GameArchived: "game_archived",
  GameCoverCreated: "game_cover_created",
  GamesMigrated: "games_migrated",
  HarnessBooted: "harness_booted",
  HarnessDowngraded: "harness_downgraded",
  HarnessLayoutMigrated: "harness_layout_migrated",
  HarnessReseeded: "harness_reseeded",
  ImprovementApplied: "improvement_applied",
  RebuildAndRestartStudio: "rebuild_and_restart_studio",
  SeedManifestReconciled: "seed_manifest_reconciled",
  SeedUpgraded: "seed_upgraded",
  SelfChangeUndone: "self_change_undone",
  SelfEdit: "self_edit",
  SkillEdited: "skill_edited",
  SkilloptAccepted: "skillopt_accepted",
  SkilloptLessonsStaged: "skillopt_lessons_staged",
  SkilloptPass: "skillopt_pass",
  SkilloptRejected: "skillopt_rejected",
  SkilloptStaged: "skillopt_staged",
  SnapshotHealthy: "snapshot_healthy",
  ThreadAdopted: "thread_adopted",
  ToolFailure: "tool_failure",
  ToolInstalled: "tool_installed",
} as const;
export type CustomEvent = (typeof CustomEvent)[keyof typeof CustomEvent];

/** Every registered name, for code that checks a name at run time. */
export const CUSTOM_EVENT_TYPES: readonly CustomEvent[] = Object.freeze(Object.values(CustomEvent));

/** A registered custom event name (the same union as {@link CustomEvent}). */
export type CustomEventType = CustomEvent;

/** A delegated builder's mirrored trace: one family, `delegated.<engine id>`. */
export const DELEGATED_PREFIX = "delegated.";
export type DelegatedEventType = `delegated.${string}`;

const KNOWN: ReadonlySet<string> = new Set(CUSTOM_EVENT_TYPES);

/** A name the studio writes or reads, a `delegated.<engine>` trace included. */
export function isCustomEventType(value: unknown): value is CustomEventType | DelegatedEventType {
  return (
    typeof value === "string" &&
    (KNOWN.has(value) || (value.startsWith(DELEGATED_PREFIX) && value.length > DELEGATED_PREFIX.length))
  );
}

// ── payloads ─────────────────────────────────────────────────────────────────────────────────

/** Where in a run a record belongs. Most run records carry some of these. */
export interface RunScope {
  runId?: string;
  project?: string;
  facetId?: string;
  facetTitle?: string;
  iteration?: number;
}

/** The part of a run's budgets its start records carry for the app to read back (`recordedRunLoop`). */
export type RecordedRunBudgets = Partial<Pick<RunSpec["budgets"], "wallClockMs" | "untilSatisfied">>;

export interface InterviewChoice {
  id: string;
  label: string;
  description?: string;
}

/** A check scoreboard as a round records it. */
export interface RoundScoreboard {
  total?: number | null;
  passing?: number | null;
  unmeasured?: number | null;
  flips?: string[];
  plannedFlips?: string[];
  regressions?: string[];
}

export interface RoundVerdict {
  because?: string | null;
}

export interface FacetIterationPayload extends RunScope {
  winner?: string;
  satisfied?: boolean;
  biggest_gap?: string;
  verdictSource?: string;
  reason?: string;
  scoreboard?: RoundScoreboard | null;
  verdict?: RoundVerdict | null;
  move?: { what?: string; delivered?: boolean | null; scale?: string | null } | null;
  /** Saved stills, as paths or `{ path }` records depending on the version that wrote them. */
  shots?: unknown;
}

/**
 * Why a loop stopped, as a code beside the sentence a person reads (`stopCode` on a run's close,
 * a facet's result). The seed's copy is `StopCode` in `loop/outcomes.ts`
 * (tests/conformance/seed-contracts.test.ts holds the two together). Persisted: never rename a value.
 */
export const StopCode = {
  UserStop: "user-stop",
  FinishRequested: "finish-requested",
  StoppedRound: "stopped-round",
  Budget: "budget",
  TooLate: "too-late",
  Yielded: "yielded",
  Done: "done",
  CircuitBreak: "circuit-break",
  UsageLimit: "usage-limit",
  EngineExhausted: "engine-exhausted",
  ObservationDown: "observation-down",
  JudgeDown: "judge-down",
  SignIn: "sign-in",
  NoReference: "no-reference",
  Victory: "victory",
  IterationsSpent: "iterations-spent",
  BaseFailed: "base-failed",
  NotJudgeable: "not-judgeable",
  NoImprovement: "no-improvement",
  ReferenceUnbeaten: "reference-unbeaten",
  AttemptNotKept: "attempt-not-kept",
} as const;
export type StopCode = (typeof StopCode)[keyof typeof StopCode];

/**
 * The provider failure a director's run paused on (its report's `limit`): `kind` is an engine
 * failure kind (`EngineFailureKind` in shared/engine-requests.ts) — an engine limit, a lost sign-in
 * (`auth`, an expired login or an account whose access was taken away) or an outage the lead could
 * not wait out (`unavailable`) — and `retryAfterMs` how long after `at` (ms since the epoch; a close
 * that leaves it out is read from its own time) a limit resets.
 */
export interface RunLimit {
  kind?: string;
  message?: string;
  retryAfterMs?: number | null;
  at?: number;
}

export interface RunFinishedPayload extends RunScope {
  victory?: boolean;
  /** Why the run stopped, as a code (autopilot closes carry one; older closes and other modes may not). */
  stopCode?: StopCode;
  reference?: string;
  stoppedBecause?: string;
  executionStatus?: string;
  iterations?: unknown[];
  landed?: boolean;
  /** Why the run failed, when it did (the director's report). */
  failure?: { message?: string } | null;
  /** The provider failure that paused it, when one did (a director's run). */
  limit?: RunLimit | null;
  /** Older closes marked a pause with this flag instead of `executionStatus`. */
  paused?: boolean;
  integrationHead?: string;
  baseCommit?: string;
  landingResult?: { line?: string };
  learned?: string;
  /** The run's own report to the user; anything but a string is ignored by its readers. */
  summary?: unknown;
  mode?: string;
  durationMs?: number;
  /**
   * On a close a later launch settled for a run the app died under: when its work last happened
   * (the conversation's newest record before that launch), where its working time ends.
   */
  workedUntil?: string;
}

/** Why the studio resumed a paused run on its own (`run_auto_resumed`). Persisted: never rename a value. */
export const AutoResumeCause = {
  /** The engine limit that paused it has reset. */
  LimitReset: "limit-reset",
  /** The studio's loop crashed under it and is running again. */
  LoopRestart: "loop-restart",
  /** A provider outage paused it, and the wait after it is over: the provider is tried again. */
  ProviderOutage: "provider-outage",
} as const;
export type AutoResumeCause = (typeof AutoResumeCause)[keyof typeof AutoResumeCause];

/** A paused run the studio resumed on its own: why, and which of the run's automatic resumes it is. */
export interface RunAutoResumedPayload extends RunScope {
  cause?: AutoResumeCause;
  attempt?: number;
}

/** One part of the plan, as the start and plan-review records list it. */
export interface PlannedFacet {
  id?: string;
  title?: string;
  budgetShare?: number;
  identity?: string[];
}

export interface CoordinatorPayload {
  messageId?: string;
  eventId?: string;
  runId?: string;
  /** Handled without an answer: the turn that took it failed (the chat says why). */
  failed?: boolean;
}

/**
 * A message steered into the chat's running turn (`shared/message-queue.ts`): `into` is the
 * message that turn answers; `how` (delivered only) is how the session took it.
 */
export interface SteerPayload extends CoordinatorPayload {
  into?: string;
  how?: SteerDelivery;
}

/** The body of a delegated builder's mirrored SDK record. */
export interface DelegatedData {
  role?: string;
  subtype?: string;
  model?: string;
  requested_model?: string;
  session_id?: string;
  note?: string;
  tool_name?: string | null;
  decision_reason?: string | null;
  message?: string | null;
  parts?: Array<{
    type: string;
    name?: string;
    id?: string;
    text?: string;
    input?: unknown;
    tool_use_id?: string;
    is_error?: boolean;
    content?: string;
  }>;
}

export interface DelegatedPayload extends RunScope {
  kind?: string;
  role?: string;
  engine?: string;
  requestedModel?: string | null;
  model?: string | null;
  delegationId?: string;
  data?: DelegatedData;
}

export interface SessionActivityPayload extends RunScope {
  phase?: ChatActivityPhase;
  label?: string;
  sessionId?: string;
  engine?: string;
  role?: string;
  /** The delegation that reported it: a settled phase ends only its own delegation's reply. */
  delegationId?: string;
}

/**
 * What a round's code review enforced, by file. Logs written before the split carry every enforced
 * file under `reverted`, kept and quarantined ones included, and nothing under the other lists.
 */
export interface FacetReviewEnforcedPayload extends RunScope {
  /** Files outside the part's ownership, checked out from the diff base. */
  reverted?: string[];
  /** Files outside the part's ownership whose content arrived by merge, left as they are. */
  kept?: string[];
  /** New files outside the part's ownership, moved to `.studio/quarantine/`. */
  quarantined?: string[];
  /** Another part's changes a merge into this part dropped, checked out from the merged head. */
  restored?: string[];
  /** Checks the model reviewer marked as made to pass without the work. */
  gamed?: string[];
}

/** A part-level notice: a circuit break, a replanned check, a raised flag, or the lead's plan. */
export interface FacetNoticePayload extends RunScope {
  reason?: string;
  checkId?: string;
  action?: string;
  why?: string;
  what?: string;
}

export interface PlanReviewPayload extends RunScope {
  waitMinutes?: number;
  summary?: string;
  facets?: PlannedFacet[];
  game?: { kind?: string | null } | null;
}

/** The chat's contractor session: what its next turn resumes, and the model it was opened on. */
export interface ContractorSessionPayload {
  project?: string;
  engine?: string;
  sessionId?: string;
  model?: string | null;
}

/** What a delegated build reported of itself, as a chat record keeps it (`DelegateResult`). */
export interface DelegateReportFields {
  model?: string | null;
  requestedModel?: string | null;
  cliVersion?: string | null;
  cliPath?: string | null;
  usage?: Usage | null;
  billing?: string | null;
  /** Why the build ended: a `StopReason` from `shared/engine-requests.ts`, or the vendor's own subtype. */
  stopReason?: string;
}

/** A chat build that ended before its work did: the session it can be picked up from. */
export interface DelegationIncompletePayload extends ContractorSessionPayload, DelegateReportFields {}

/**
 * What the studio saw of a finished chat build (harness `delegated-turn.ts`). `ok` is the build's
 * word and the screen's together. `durationMs`, `turns` and `usage` are the delegation's own
 * report; `ready` is what `preview.ready` answered, null when the preview could not be asked.
 */
export interface BuildObservationPayload extends DelegateReportFields {
  project?: string;
  brief?: string;
  ok?: boolean;
  consoleErrors?: number;
  reason?: string | null;
  observation?: Partial<BuildObservation> | null;
  summary?: string;
  sessionId?: string | null;
  cost_usd?: number | null;
  durationMs?: number | null;
  turns?: number | null;
  ready?: Partial<ReadyResult> | null;
}

/**
 * A project's preview reported itself ready for the first time after a build. `ms`: from the
 * start of that build to the ready answer; `via`: which signal answered.
 */
export interface PreviewReadyPayload extends RunScope {
  ms?: number;
  via?: ReadyVia;
}

/**
 * Who asked for a direct model call (`completion_call.role`). Persisted: never rename a value.
 * The seed's copy is `CompletionRole` in `loop/judge-provenance.ts`.
 */
export const CompletionRole = {
  Judge: "judge",
  Playtester: "playtester",
  SkilloptGate: "skillopt-gate",
} as const;
export type CompletionRole = (typeof CompletionRole)[keyof typeof CompletionRole];

const COMPLETION_ROLES: ReadonlySet<unknown> = new Set(Object.values(CompletionRole));

/** Is this one of the roles a completion's caller may name? */
export function isCompletionRole(value: unknown): value is CompletionRole {
  return COMPLETION_ROLES.has(value);
}

/**
 * What a caller of `engine.complete` says about its call, for the record only: never sent to the
 * model. `promptSha256` is the SHA-256 of the system prompt (the rubric, no evidence).
 */
export interface CompletionProvenance {
  role?: CompletionRole;
  runId?: string;
  fellBack?: boolean;
  promptSha256?: string;
}

/**
 * One `engine.complete` call as the host saw it: the engine asked, the model that served it, its
 * usage and stop reason, and how long it took. `failure` (an `EngineFailureKind`) is set when it failed.
 */
export interface CompletionCallPayload extends CompletionProvenance {
  engine?: string;
  requestedModel?: string | null;
  model?: string | null;
  usage?: Usage | null;
  stopReason?: string | null;
  latencyMs?: number;
  workClass?: string;
  ok?: boolean;
  failure?: string | null;
}

/**
 * Payloads of the custom events the app reads, by name. A name missing here is still a valid
 * `CustomEventType`; add its payload before reading it.
 */
/** A change the host wrote to one of the agent's own files, between the two snapshots around it. */
export interface SelfChangePayload {
  reason: string;
  snapshot_id: string;
  post_snapshot_id: string;
  bytes: number;
  /** What the agent will do differently, in plain words for the person; absent on older records. */
  title?: string;
  summary?: string[];
}

export interface CustomEventMap {
  asset_delivered: AssetDeliveredPayload;
  /**
   * `facetId` and `beyond`: a card about a step beyond the ask names its part and the proposal, so a
   * restart of the part reads back what it already asked (seed loop/facet/beyond.ts).
   */
  autopilot_decision: RunScope & {
    decision?: string;
    plain?: string;
    text?: string;
    facetId?: string;
    beyond?: string;
  };
  autopilot_paused: RunScope;
  autopilot_plan_review: PlanReviewPayload;
  autopilot_provider_outage: RunScope & { phase?: string; wait?: number; attempt?: number; error?: string };
  autopilot_resumed: RunScope & { doneFacets?: string[] };
  autopilot_started: RunScope & {
    facets?: PlannedFacet[];
    maxParallel?: number;
    director?: boolean;
    /** The run's lead takes the chat while it builds (live chat): a message goes to it, not behind the build. */
    liveChat?: boolean;
  };
  blender_asset: RunScope & {
    name?: string;
    bytes?: number;
    ok?: boolean;
    error?: string | null;
    stats?: { polygons?: number; triangles?: number } | null;
  };
  build_observation: BuildObservationPayload;
  /**
   * `summary`: what the harness wrote in place of the messages it replaced (loop/compact.ts,
   * session-compact.ts). `native`: the provider compacted `sessionId` in place, which goes on
   * (shared/chat-rewind.ts `endsChatSessions`); its summary, when it reports one, is the provider's own.
   */
  compacted: Partial<ContextMeasurement> & { messages?: number; trigger?: string; summary?: string; native?: boolean };
  completion_call: CompletionCallPayload;
  connector_tool: RunScope & { connectorId?: string; tool?: string; ok?: boolean; error?: string | null };
  context_usage: ContextMeasurement;
  contractor_session: ContractorSessionPayload;
  coordinator_message_delivered: SteerPayload;
  coordinator_message_handled: CoordinatorPayload;
  coordinator_message_processing: CoordinatorPayload;
  coordinator_message_queued: CoordinatorPayload;
  coordinator_message_removed: CoordinatorPayload;
  coordinator_message_requeued: CoordinatorPayload;
  coordinator_message_steering: SteerPayload;
  coordinator_message_updated: CoordinatorPayload;
  delegation_incomplete: DelegationIncompletePayload;
  /** A chat rewound to before a message (`shared/chat-rewind.ts`); `files`: game files put back, null when none were asked for. */
  conversation_rewound: Partial<ChatRewind> & { files?: number | null };
  director_show: RunScope & { target?: string; root?: string };
  director_verdict: RunScope & { pass?: string; because?: string; decision?: { kept?: boolean | null } };
  director_worker: RunScope & {
    workerId?: string;
    title?: string;
    mode?: string;
    state?: string;
    stoppedBecause?: string;
    /** The worker this one restarts (`worker_start replaces=`): the same part. */
    replaces?: string;
  };
  facet_build_started: RunScope;
  facet_check_replanned: FacetNoticePayload;
  facet_circuit_break: FacetNoticePayload;
  facet_fix: RunScope & {
    what?: string;
    checkId?: string | null;
    streak?: number;
    mandatory?: boolean;
    delivered?: boolean | null;
  };
  facet_flag: FacetNoticePayload;
  facet_iteration: FacetIterationPayload;
  facet_liveness: RunScope & {
    critic?: string;
    total?: number;
    max?: number;
    biggest?: string | null;
    summary?: string;
    grow?: string[];
    polish?: string[];
  };
  facet_move: RunScope & {
    what?: string;
    delivered?: boolean | null;
    scale?: string | null;
    milestoneId?: string | null;
    source?: string;
  };
  /** `lost`: the provider was lost (an engine failure kind), and the round waits for it rather than retry on a ladder. */
  facet_provider_outage: RunScope & { phase?: string; wait?: number; attempt?: number; error?: string; lost?: string };
  facet_review_enforced: FacetReviewEnforcedPayload;
  improvement_applied: { file?: string; reason?: string; snapshot_id?: string };
  interview_question: { question?: string; choices?: InterviewChoice[] };
  /** A provider signed out mid-turn (harness `turn-loop.ts`); `message` is the provider's own error. */
  needs_signin: { engine?: string; message?: string };
  plan_review: PlanReviewRecord;
  preview_ready: PreviewReadyPayload;
  plugin_consent: PluginConsentEvent;
  plugin_tool: PluginToolFinishedPayload & { facetTitle?: string };
  plugin_tool_started: PluginToolStartedPayload & { facetTitle?: string };
  tool_permission: ToolPermissionEvent;
  rebuild_and_restart_studio: { ok?: boolean; reason?: string };
  run_auto_resumed: RunAutoResumedPayload;
  run_control: RunScope & { action?: string };
  run_finished: RunFinishedPayload;
  run_iteration: RunScope & { winner?: string; biggest_gap?: string; verdict?: RoundVerdict | null };
  run_registered: RunScope & { budgets?: RecordedRunBudgets; resumed?: boolean };
  run_started: RunScope & {
    budgets?: RecordedRunBudgets;
    goal?: string;
    reference?: { name?: string; kind?: string };
    engine?: string;
    judgeEngine?: string;
    judgeModel?: string;
    roles?: { judge?: string };
  };
  /**
   * The workspace's one-time move from the JavaScript layout to TypeScript (substrate/seed-upgrade.ts
   * `migrateHarnessLayout`). `ok: false`: the migrated copy did not boot, and the JavaScript tree
   * keeps running (also written when the migrated self booted in its fork but not live, which the
   * boot then rewinds). `typeErrors`: bounded compiler output for the agent's own migrated files.
   * `replaced`: agent-edited modules that cannot run as TypeScript, replaced by the shipped ones.
   * `restored`: TypeScript-only files a rewind to a pre-upgrade tree had taken away.
   */
  harness_layout_migrated: {
    ok?: boolean;
    removed?: string[];
    renamed?: string[];
    deleted?: string[];
    stranded?: string[];
    replaced?: string[];
    restored?: string[];
    rewritten?: string[];
    typeErrors?: string;
    typeCheck?: string;
    error?: string;
  };
  /**
   * An older build of the app (from before the TypeScript layout) ran the harness workspace since
   * the last update (substrate/seed-upgrade.ts `downgraded`). `stranded`: JavaScript files the agent
   * edited meanwhile, backed up and not run; `migrated`: whether this boot moved it back.
   */
  harness_downgraded: { stranded?: string[]; migrated?: boolean };
  /** `moved`: code the seed moved out of a kept file, which other harness files now import from `to` (substrate/seed-upgrade.ts). */
  seed_upgraded: {
    added?: string[];
    updated?: string[];
    kept?: string[];
    retired?: string[];
    moved?: Array<{ from: string; to: string; names: string[]; callers: string[] }>;
  };
  session_activity: SessionActivityPayload;
  /**
   * A builder session took the plugin tool registry at `revision` (`main/core/connections.ts`).
   * Once the engine's session `session` answered, a second record names it with `plugins`, the
   * live plugin ids it got, and `skills`, their skills as `plugin/name`.
   */
  tool_registry_applied: {
    revision?: number;
    engine?: string;
    session?: string;
    plugins?: string[];
    skills?: string[];
  };
  skillopt_accepted: { skill?: string; title?: string };
  skillopt_pass: { staged?: number; accepted?: number };
  /** The host wrote one of the agent's own files for it (`guardian.write_self`, main/core/self-edit-gate.ts). */
  self_edit: SelfChangePayload & { file: string };
  /** …a skill, `skills/<slug>.md`. */
  skill_edited: SelfChangePayload & { slug: string };
  /** …a tool that was not there before, under `tools/`. */
  tool_installed: SelfChangePayload & { file: string };
  [delegated: DelegatedEventType]: DelegatedPayload;
}

export type CustomEventName = keyof CustomEventMap & string;

// Every payload entry names a registered event: a reader can only ask for a name the registry
// lists (or the `delegated.<engine>` family), whichever file the read sits in.
type UnregisteredPayload = Exclude<Exclude<keyof CustomEventMap, DelegatedEventType>, CustomEventType>;
const payloadsAreRegistered: [UnregisteredPayload] extends [never] ? true : { unregistered: UnregisteredPayload } =
  true;
void payloadsAreRegistered;

type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type FieldOf<T, F extends PropertyKey> = T extends unknown ? (F extends keyof T ? T[F] : undefined) : never;

/**
 * What a reader gets for one or more names: every field optional, and a field only some of the
 * names carry is typed with `undefined` for the others.
 */
export type CustomPayload<K extends CustomEventName> = {
  [F in KeysOfUnion<CustomEventMap[K]>]?: FieldOf<CustomEventMap[K], F>;
};

/** Any custom event's payload, before its name is known. */
export type AnyCustomPayload = RunScope & Record<string, unknown>;

/** The `data` of an event, as loosely as the log's readers receive it. */
export interface CustomEventData {
  readonly type: string;
  readonly event_type?: unknown;
  readonly payload?: unknown;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * Any custom event, as its name and a payload that is always an object: a payload the writer
 * left out, or wrote as something other than an object, reads as `{}`.
 */
export function customRecord(data: CustomEventData): { event_type: string; payload: AnyCustomPayload } | null {
  if (data.type !== "custom" || typeof data.event_type !== "string") return null;
  return { event_type: data.event_type, payload: record(data.payload) ?? {} };
}

/**
 * The payload of a custom event with this name (or one of these names), or `null` for any other
 * event. The fields are whatever the writer put there: their types are the contract, not a check.
 */
export function customPayload<K extends CustomEventName>(
  data: CustomEventData,
  name: K | readonly K[],
): CustomPayload<K> | null {
  const custom = customRecord(data);
  if (!custom) return null;
  const named =
    typeof name === "string" ? custom.event_type === name : (name as readonly string[]).includes(custom.event_type);
  const fields = custom.payload;
  return named ? (fields as CustomPayload<K>) : null;
}

/** `customPayload` for a whole log record. */
export function customEvent<K extends CustomEventName>(
  event: { readonly data: CustomEventData },
  name: K | readonly K[],
): CustomPayload<K> | null {
  return customPayload(event.data, name);
}

/** What a writer may put in a record: the fields its readers know, typed, and anything else. */
export type CustomEventPayloadIn<K extends CustomEventType> = K extends keyof CustomEventMap
  ? CustomEventMap[K] & { readonly [field: string]: unknown }
  : AnyCustomPayload;

/** A custom event's `data` as a writer builds it. */
export interface CustomEventRecord<K extends CustomEventType = CustomEventType> {
  type: "custom";
  event_type: K;
  payload: CustomEventPayloadIn<K>;
}

/** The `data` of a custom event: `customEventData(CustomEvent.RunFinished, { runId })`. */
export function customEventData<K extends CustomEventType>(
  name: K,
  payload: CustomEventPayloadIn<K>,
): CustomEventRecord<K> {
  return { type: "custom", event_type: name, payload };
}

/** A delegated builder's mirrored record (`delegated.<engine>`), with the engine it came from. */
export function delegatedPayload(
  data: CustomEventData,
): { engineId: string; payload: CustomPayload<DelegatedEventType> } | null {
  const custom = customRecord(data);
  if (!custom || !custom.event_type.startsWith(DELEGATED_PREFIX)) return null;
  const fields = custom.payload;
  return {
    engineId: custom.event_type.slice(DELEGATED_PREFIX.length),
    payload: fields as CustomPayload<DelegatedEventType>,
  };
}
