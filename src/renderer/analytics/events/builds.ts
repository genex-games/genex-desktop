/**
 * Builds, runs, Live, assets and engine projects (plan §1.6): from a first message to a game that plays.
 *
 * The log's run records (starts, workers, verdicts, finish checks, closes), main's run events and
 * the library's games and asset jobs are read here, by pure readers that keep only what pairs a
 * start with its end in memory: times, never ids. The stage's own presses are sent from their
 * hooks with the builders in `builds-stage.ts`. Every value is a code from the app's vocabularies,
 * a switch, a count or a duration: never a title, a task, a reason, a path or a name.
 */
import { CallCutOff, PluginSourceKind } from "../../../shared/plugins.ts";
import {
  AutoResumeCause,
  CustomEvent,
  customRecord,
  type LoopRefusal,
  loopRefusalOf,
  RunStartRefusal,
  StopCode,
} from "../../../shared/custom-events.ts";
import { MINUTE_MS } from "../../../shared/duration.ts";
import { EngineFailureKind, StopReason } from "../../../shared/engine-requests.ts";
import type { BuildProblem } from "../../../shared/build-problem.ts";
import type { EventEnvelope } from "../../../shared/event-log.ts";
import { FinishCheckStep, StopWhy } from "../../../shared/finish-check.ts";
import { GameEngine } from "../../../shared/game-engine.ts";
import { GenexBlocked } from "../../../shared/genex.ts";
import { GenexTool, MakingKind, type MakingPhase, type MakingJob } from "../../../shared/asset-making.ts";
import { JobRole, JobState, JobStopper } from "../../../shared/jobs.ts";
import { type LiveLoadFailure, type PreviewGone, ReadyVia } from "../../../shared/preview-contract.ts";
import { LoopProfile } from "../../../shared/project-facts.ts";
import { EngineId } from "../../../shared/providers.ts";
import {
  CompletionPolicy,
  ExecutionStatus,
  executionActivity,
  executionStep,
  isExecutionEvent,
  RUN_PAUSE_EVENTS,
  RUN_RESUME_EVENTS,
  RUN_START_EVENTS,
  RoundOutcome,
  type RunExecution,
  recordedRunLoop,
  roundOutcome,
  VerdictPass,
  VerdictRule,
  workedMs,
} from "../../../shared/run-state.ts";
import type { AssetKind, AssetPreviewMode } from "../../../shared/game-assets.ts";
import type { LiveBehindReason } from "../../../shared/live-behind.ts";
import type { GameProject } from "../../../shared/studio-api.ts";
import { UiEvent } from "../../../shared/ui-events.ts";
import { WorkerEnd, WorkerIsolation, WorkerStopCode, WorkerVerdict } from "../../../shared/workers.ts";
import type { GraphSelection } from "../../panels/inspector/selection.ts";
import type { LiveRun } from "../../panels/stage/live-run.ts";
import type { StageAct } from "../../panels/stage/unreal-stage-view.ts";
import type { AssetInventory, LibraryState } from "../../state/library.ts";
import type { UnrealStageStep } from "../../unreal-game.ts";
import type { Studio } from "../../state/studio.ts";
import { guarded, track } from "../client.ts";
import { gameRef } from "../game-ref.ts";
import type { AreaObservers } from "../observers.ts";
import { type CountBucket, countBucket, elapsedMs, oneOf } from "../properties.ts";

/** A plugin call that fails again within this long of a failed one of the same kind in the same chat is a retry. */
export const RETRY_OF_FAILED_MS = 10 * MINUTE_MS;

// ── vocabularies ────────────────────────────────────────────────────────────────────────────

/** How a build began: a Loop run, or a chat turn whose lead started workers. */
export const BuildMode = { Loop: "loop", ChatTurn: "chat_turn" } as const;
export type BuildMode = (typeof BuildMode)[keyof typeof BuildMode];

/** A value the app reads but whose vocabulary it does not know (a vendor's own stop reason, a plugin's kind). */
export const Unlisted = { Other: "other" } as const;
export type Unlisted = (typeof Unlisted)[keyof typeof Unlisted];

/** What ended the first plan's wait on an empty stage. */
export const PlanningEnd = {
  /** A run started building. */
  RunStarted: "run_started",
  /** The chat stopped working without a run: it answered, or built the game itself. */
  TurnEnded: "turn_ended",
  /** The person left the game, or the stage, while it planned. */
  LeftGame: "left_game",
} as const;
export type PlanningEnd = (typeof PlanningEnd)[keyof typeof PlanningEnd];

/** Where a build's Play, Keep building or Resume was pressed. */
export const BuildSurface = {
  BuildsBar: "builds_bar",
  ResultPanel: "result_panel",
  MorningCard: "morning_card",
  EmptyStage: "empty_stage",
  StoppedStage: "stopped_stage",
  ChatCard: "chat_card",
  BuildsCard: "builds_card",
} as const;
export type BuildSurface = (typeof BuildSurface)[keyof typeof BuildSurface];

/** How Live's wait for a page ended: shown, or given up and why. */
export const LiveOutcome = {
  Shown: "shown",
  TimedOut: "timed_out",
  LoadFailed: "load_failed",
  Crashed: "crashed",
  BuildBroken: "build_broken",
} as const;
export type LiveOutcome = (typeof LiveOutcome)[keyof typeof LiveOutcome];

/** What started a load Live waits on. */
export const LiveTrigger = {
  /** The game was opened while Live held its page. */
  OpenGame: "open_game",
  /** Main started a load of this game itself (a chat's show, the morning card). */
  MainLoad: "main_load",
  /** The game took its first kind, and its page was loaded. */
  GameStarted: "game_started",
  Reload: "reload",
  Play: "play",
  ShowBuild: "show_build",
  FirstBuildAuto: "first_build_auto",
  Install: "install",
  WebBuild: "web_build",
  UnseenChange: "unseen_change",
} as const;
export type LiveTrigger = (typeof LiveTrigger)[keyof typeof LiveTrigger];

/** What an empty stage showed: the first idea, a game being built, a game stopped or waiting for Play. */
export const EmptyArt = { Idea: "idea", Building: "building", Stopped: "stopped" } as const;
export type EmptyArt = (typeof EmptyArt)[keyof typeof EmptyArt];

/** What the person did on an empty stage before it went. */
export const EmptyAction = {
  WatchProgress: "watch_progress",
  PlayLatest: "play_latest",
  Play: "play",
  None: "none",
} as const;
export type EmptyAction = (typeof EmptyAction)[keyof typeof EmptyAction];

/** A Builds graph node that is not one of its fixed nodes: a part's row, or one of its steps. */
export const NodeKind = { Part: "part", Step: "step", Build: "build" } as const;
export type NodeKind = (typeof NodeKind)[keyof typeof NodeKind];

/** How a Builds graph node was opened. */
export const NodeVia = { Click: "click", Arrow: "arrow", GateNotes: "gate_notes" } as const;
export type NodeVia = (typeof NodeVia)[keyof typeof NodeVia];

/** Where an earlier build was opened from. */
export const HistoryVia = { Tab: "tab", ChatCard: "chat_card" } as const;
export type HistoryVia = (typeof HistoryVia)[keyof typeof HistoryVia];

/** The trouble a part of a run ran into (`facet_*` records). */
export const PartTrouble = {
  CircuitBreak: "circuit_break",
  Stopped: "stopped",
  WindDown: "wind_down",
  ProviderOutage: "provider_outage",
  MachinePressure: "machine_pressure",
} as const;
export type PartTrouble = (typeof PartTrouble)[keyof typeof PartTrouble];

/** Where an asset's preview was opened from. */
export const AssetOpenedFrom = { Canvas: "canvas", Search: "search" } as const;
export type AssetOpenedFrom = (typeof AssetOpenedFrom)[keyof typeof AssetOpenedFrom];

/** At which step an asset's preview failed: reading the file, starting the 3D viewer, decoding a picture, playing media. */
export const PreviewFailure = { Read: "read", Viewer: "viewer", Decode: "decode", Codec: "codec" } as const;
export type PreviewFailure = (typeof PreviewFailure)[keyof typeof PreviewFailure];

/** Where a found asset came from: the person's own library, or the community's. */
export const FoundIn = { Library: "library", Community: "community" } as const;
export type FoundIn = (typeof FoundIn)[keyof typeof FoundIn];

/** Where one row of an engine setup card stands. */
export const SetupStepState = { Open: "open", Working: "working", You: "you", Done: "done" } as const;
export type SetupStepState = (typeof SetupStepState)[keyof typeof SetupStepState];

/** Which button of an engine setup card was pressed. */
export const SetupButton = { Step: "step", Primary: "primary", Secondary: "secondary" } as const;
export type SetupButton = (typeof SetupButton)[keyof typeof SetupButton];

/** How a press that runs a plugin action ended: done, the person said no in its dialog, or it failed. */
export const PressOutcome = { Ok: "ok", Declined: "declined", Failed: "failed" } as const;
export type PressOutcome = (typeof PressOutcome)[keyof typeof PressOutcome];

/** How an engine setup card went away: nothing left open, or the person hid it. */
export const SetupEnd = { Done: "done", Hidden: "hidden" } as const;
export type SetupEnd = (typeof SetupEnd)[keyof typeof SetupEnd];

/** A Roblox publish: a new game on Roblox, or an update of one. */
export const PublishKind = { First: "first", Update: "update" } as const;
export type PublishKind = (typeof PublishKind)[keyof typeof PublishKind];

/** How a Roblox publish the card followed ended. */
export const PublishEnd = { Published: "published", Stopped: "stopped" } as const;
export type PublishEnd = (typeof PublishEnd)[keyof typeof PublishEnd];

/** A plugin as an event may name it: its id when bundled or listed, else only where it came from. */
export type PluginRef = string;

// ── events ──────────────────────────────────────────────────────────────────────────────────

/** This area's events, by their wire names. */
export const BuildsEvent = {
  BuildPlanningEnded: "build_planning_ended",
  RunStarted: "run_started",
  RunStartRefused: "run_start_refused",
  RunPlanReviewShown: "run_plan_review_shown",
  WorkerFinished: "worker_finished",
  WorkerJudged: "worker_judged",
  BuildHealthChecked: "build_health_checked",
  RunRoundJudged: "run_round_judged",
  FinishCheckAnswered: "finish_check_answered",
  RunPartStuck: "run_part_stuck",
  RunFinished: "run_finished",
  RunAutoResumed: "run_auto_resumed",
  RunStopRequested: "run_stop_requested",
  RunResumePressed: "run_resume_pressed",
  KeepBuildingPressed: "keep_building_pressed",
  BuildPlayed: "build_played",
  BuildMadeLive: "build_made_live",
  BuildsNodeOpened: "builds_node_opened",
  BuildsHistoryOpened: "builds_history_opened",
  FirstPreviewReady: "first_preview_ready",
  GameFirstBuildMade: "game_first_build_made",
  LiveGameShown: "live_game_shown",
  LiveEmptyStateLeft: "live_empty_state_left",
  LiveFirstBuildAutoShown: "live_first_build_auto_shown",
  LiveReloadPressed: "live_reload_pressed",
  GameBuildFailed: "game_build_failed",
  GameBuildRetryPressed: "game_build_retry_pressed",
  PackagesInstallFinished: "packages_install_finished",
  LiveBlankSuspected: "live_blank_suspected",
  LiveShownBuildBroken: "live_shown_build_broken",
  LivePlayToggled: "live_play_toggled",
  WebBuildWaitGaveUp: "web_build_wait_gave_up",
  ChatBuildObserved: "chat_build_observed",
  ChatBuildIncomplete: "chat_build_incomplete",
  AgentJobEnded: "agent_job_ended",
  PluginToolFinished: "plugin_tool_finished",
  AssetJobPhaseChanged: "asset_job_phase_changed",
  AssetCandidateApproved: "asset_candidate_approved",
  AssetPreviewOpened: "asset_preview_opened",
  AssetPreviewFailed: "asset_preview_failed",
  AssetsInventoryFailed: "assets_inventory_failed",
  AssetSearchAdded: "asset_search_added",
  UnrealStageStepChanged: "unreal_stage_step_changed",
  UnrealStageActionPressed: "unreal_stage_action_pressed",
  EngineSetupCardShown: "engine_setup_card_shown",
  EngineSetupStepChanged: "engine_setup_step_changed",
  EngineSetupButtonPressed: "engine_setup_button_pressed",
  EngineSetupEnded: "engine_setup_ended",
  RobloxPublishPressed: "roblox_publish_pressed",
  RobloxPublishFinished: "roblox_publish_finished",
} as const;
export type BuildsEvent = (typeof BuildsEvent)[keyof typeof BuildsEvent];

/** A run's start as `run_started` carries it; also a chat turn's first worker (mode chat_turn). */
export type RunStartedProperties = {
  mode: BuildMode;
  /** A timed Loop's hours; null for an ∞ Loop, a goal Loop or a chat turn. */
  loop_hours: number | null;
  until_satisfied: boolean;
  completion_policy: CompletionPolicy | null;
  director: boolean;
  facets: number;
  max_parallel: number | null;
  profile: LoopProfile | null;
  resumed: boolean;
  engine: EngineId | null;
  /** How the chat's run before this one ended, as this launch saw it; null when it saw none. */
  previous_run_state: ExecutionStatus | null;
  ms_since_previous_end: number | null;
  /** The game's random ref (`game-ref.ts`); null when the record names none. */
  game_ref: string | null;
};

/** A run's close, paused included. */
export type RunFinishedProperties = {
  execution_status: ExecutionStatus;
  stop_code: StopCode | null;
  limit_kind: EngineFailureKind | null;
  retry_after_ms: number | null;
  still_to_fix_why: StopWhy | null;
  done_count: number;
  not_done_count: number;
  landed: boolean;
  victory: boolean;
  duration_ms: number | null;
  /** The time it worked, pauses left out; null when it started before this launch. */
  worked_ms: number | null;
  loop_hours: number | null;
  rounds_accepted: number;
  rounds_rejected: number;
  profile: LoopProfile | null;
  /** Why the Loop did not run at all (`LoopRefusal`); null when it ran. */
  loop_refusal: LoopRefusal | null;
  game_ref: string | null;
};

/** What Live's wait for a page ended on. */
export type LiveGameShownProperties = {
  outcome: LiveOutcome;
  load_ms: number;
  /** What started the load; null when its starter did not say. */
  trigger: LiveTrigger | null;
  /** The first time this launch showed this game in Live. */
  first_in_launch: boolean;
  /** Since the game was made; null when the library does not say. */
  game_age_ms: number | null;
  /** Since the chat's first message, when the stage has read it. */
  ms_since_first_message: number | null;
  /** The game says it is in play (`state().flow.playing`); null when it says nothing. */
  game_playing: boolean | null;
  draws_seen: boolean;
  game_ref: string | null;
  /** Why the page did not load (Chromium's kind, or the game's own build); null when nothing said. */
  load_failure: LiveLoadFailure | null;
  /** Why the page's renderer went away, on a crash; null otherwise. */
  crash_reason: PreviewGone | null;
};

export type BuildsEventProperties = {
  [BuildsEvent.BuildPlanningEnded]: { ms: number; ended_by: PlanningEnd; from_home: boolean; game_ref: string | null };
  [BuildsEvent.RunStarted]: RunStartedProperties;
  /** `conflict`: the chat already builds; `refusal`: the harness's code for why (null from an older harness). */
  [BuildsEvent.RunStartRefused]: { conflict: boolean; refusal: RunStartRefusal | null };
  [BuildsEvent.RunPlanReviewShown]: { wait_minutes: number | null; facets: number };
  [BuildsEvent.WorkerFinished]: {
    state: WorkerEnd;
    stop_code: WorkerStopCode | null;
    isolation: WorkerIsolation | null;
    in: GameEngine | null;
    delivered: boolean;
    in_game: boolean;
    ms: number | null;
    in_run: boolean;
  };
  [BuildsEvent.WorkerJudged]: { verdict: WorkerVerdict; merged: boolean; in_run: boolean };
  [BuildsEvent.BuildHealthChecked]: {
    ok: boolean | null;
    rule: VerdictRule | null;
    ms_since_merge: number | null;
    problems_count: number | null;
  };
  [BuildsEvent.RunRoundJudged]: {
    outcome: RoundOutcome;
    pass: VerdictPass;
    rule: VerdictRule | null;
    checks_passing: number | null;
    checks_total: number | null;
  };
  [BuildsEvent.FinishCheckAnswered]: {
    round: number | null;
    step: FinishCheckStep;
    rejections: number | null;
    stopped: boolean;
    time_left: boolean;
    done_count: number;
    not_done_count: number;
    reviewer_engine: EngineId | null;
    ms_checking: number | null;
  };
  [BuildsEvent.RunPartStuck]: { kind: PartTrouble; lost: EngineFailureKind | null; attempt: number | null };
  [BuildsEvent.RunFinished]: RunFinishedProperties;
  [BuildsEvent.RunAutoResumed]: { cause: AutoResumeCause | null; attempt: number | null; paused_ms: number | null };
  [BuildsEvent.RunStopRequested]: { worked_ms: number | null };
  [BuildsEvent.RunResumePressed]: { surface: BuildSurface };
  [BuildsEvent.KeepBuildingPressed]: { surface: BuildSurface; not_done_count: number; sent: boolean };
  [BuildsEvent.BuildPlayed]: { surface: BuildSurface; run_active: boolean; ok: boolean };
  [BuildsEvent.BuildMadeLive]: { ok: boolean };
  [BuildsEvent.BuildsNodeOpened]: { node_kind: GraphSelection | NodeKind; via: NodeVia; run_active: boolean };
  [BuildsEvent.BuildsHistoryOpened]: { via: HistoryVia; index_from_newest: number; running: boolean };
  [BuildsEvent.FirstPreviewReady]: {
    ms_build_to_ready: number | null;
    via: ReadyVia | null;
    in_run: boolean;
    game_ref: string | null;
  };
  [BuildsEvent.GameFirstBuildMade]: { ms_since_game_created: number | null; game_ref: string | null };
  [BuildsEvent.LiveGameShown]: LiveGameShownProperties;
  [BuildsEvent.LiveEmptyStateLeft]: { art: EmptyArt; ms_shown: number; action: EmptyAction };
  [BuildsEvent.LiveFirstBuildAutoShown]: { ok: boolean };
  [BuildsEvent.LiveReloadPressed]: {
    behind_reason: LiveBehindReason | null;
    /** Another reload of the same game came within `RAPID_RELOAD_MS`. */
    rapid: boolean;
    ms_since_last: number | null;
  };
  [BuildsEvent.GameBuildFailed]: {
    needs_install: boolean;
    showing_last_build: boolean;
    skipped_scripts: boolean;
    killed: boolean;
  };
  [BuildsEvent.GameBuildRetryPressed]: { attempt: number; needs_install: boolean };
  [BuildsEvent.PackagesInstallFinished]: { ok: boolean; scripts: boolean; ms: number };
  [BuildsEvent.LiveBlankSuspected]: {
    ms_after_shown: number;
    draws_counted: boolean;
    game_playing: boolean | null;
    /** The page's loop had stopped answering when the stage looked. */
    unresponsive: boolean;
  };
  [BuildsEvent.LiveShownBuildBroken]: { run_active: boolean };
  [BuildsEvent.LivePlayToggled]: { to: LiveRun; ok: boolean };
  [BuildsEvent.WebBuildWaitGaveUp]: { asks: number };
  [BuildsEvent.ChatBuildObserved]: {
    ok: boolean;
    console_errors: CountBucket;
    duration_ms: number | null;
    turns: number | null;
    stop_reason: StopReason | Unlisted | null;
    ready: boolean | null;
    ready_via: ReadyVia | null;
    ready_timed_out: boolean;
    page_timed_out: boolean;
    frame_advanced: boolean | null;
    running: boolean | null;
    studio_missing: boolean | null;
  };
  [BuildsEvent.ChatBuildIncomplete]: { stop_reason: StopReason | Unlisted | null };
  [BuildsEvent.AgentJobEnded]: {
    state: JobState | null;
    stopped_by: JobStopper | null;
    role: JobRole | null;
    exit_nonzero: boolean;
    duration_ms: number | null;
    in_run: boolean;
  };
  [BuildsEvent.PluginToolFinished]: {
    plugin_ref: PluginRef;
    kind: MakingKind | Unlisted;
    tool: GenexTool | Unlisted | null;
    ok: boolean;
    cut_off: CallCutOff | null;
    blocked: GenexBlocked | null;
    duration_ms: number | null;
    images: number;
    retry_of_failed: boolean;
    in_run: boolean;
  };
  [BuildsEvent.AssetJobPhaseChanged]: {
    from: MakingPhase;
    to: MakingPhase;
    kind: MakingKind | Unlisted;
    ms_in_from: number | null;
  };
  [BuildsEvent.AssetCandidateApproved]: { ok: boolean; cancelled: boolean; picked: boolean };
  [BuildsEvent.AssetPreviewOpened]: { mode: AssetPreviewMode; kind: AssetKind; from: AssetOpenedFrom };
  [BuildsEvent.AssetPreviewFailed]: { mode: AssetPreviewMode; stage: PreviewFailure };
  [BuildsEvent.AssetsInventoryFailed]: { failures_in_row: number };
  [BuildsEvent.AssetSearchAdded]: { from: FoundIn; ok: boolean };
  [BuildsEvent.UnrealStageStepChanged]: {
    from: UnrealStageStep;
    to: UnrealStageStep;
    ms_in_from: number;
    editors: number;
  };
  [BuildsEvent.UnrealStageActionPressed]: { act: StageAct; step: UnrealStageStep | null; ok: boolean };
  [BuildsEvent.EngineSetupCardShown]: {
    plugin_ref: PluginRef;
    step_count: number;
    open_steps: number;
    you_steps: number;
    has_primary: boolean;
  };
  [BuildsEvent.EngineSetupStepChanged]: {
    plugin_ref: PluginRef;
    /** The step's id for a bundled plugin's card; null for any other plugin's. */
    step_id: string | null;
    from: SetupStepState;
    to: SetupStepState;
    ms_in_previous: number | null;
    ms_since_shown: number | null;
  };
  [BuildsEvent.EngineSetupButtonPressed]: {
    plugin_ref: PluginRef;
    button: SetupButton;
    step_id: string | null;
    outcome: PressOutcome;
  };
  [BuildsEvent.EngineSetupEnded]: {
    plugin_ref: PluginRef;
    outcome: SetupEnd;
    open_steps: number;
    ms_since_shown: number | null;
  };
  [BuildsEvent.RobloxPublishPressed]: { kind: PublishKind; started: boolean };
  [BuildsEvent.RobloxPublishFinished]: { kind: PublishKind; phase: PublishEnd; ms: number | null };
};

/** One event this area sends, with its properties. */
export type BuildsTracked = {
  [E in BuildsEvent]: { event: E; properties: BuildsEventProperties[E] };
}[BuildsEvent];

/** Send what the readers found. */
function sendAll(found: readonly BuildsTracked[]): void {
  for (const item of found) track(item.event, item.properties);
}

// ── reading payloads ────────────────────────────────────────────────────────────────────────

type Fields = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const fieldsOf = (value: unknown): Fields => (isRecord(value) ? value : {});
const textOf = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const lengthOf = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
/** A finite, non-negative number, rounded; null for anything else. */
export const amountOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
const flagOf = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const hoursOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

/** A vocabulary's word, or `other` for a string it does not know; null for none. */
function wordOrOther<V extends string>(vocabulary: Readonly<Record<string, V>>, value: unknown): V | Unlisted | null {
  if (typeof value !== "string" || !value) return null;
  return oneOf(vocabulary, value) ?? Unlisted.Other;
}

/** A record's time in ms; 0 when it cannot be read. */
const recordTime = (record: Pick<EventEnvelope, "created_at">): number => {
  const at = Date.parse(record.created_at);
  return Number.isFinite(at) ? at : 0;
};

/** How long from a remembered time to now; null when nothing was remembered. */
const since = (from: number | undefined, to: number): number | null =>
  from === undefined ? null : elapsedMs(from, to);

/** Where a plugin came from, as an event may say it: its id only when bundled or listed. */
const SHAREABLE_SOURCES: ReadonlySet<string> = new Set([
  PluginSourceKind.Bundled,
  PluginSourceKind.Catalog,
  PluginSourceKind.Index,
]);

/** A plugin as an event names it: its id when bundled, catalog or index, else `local` or `github`. */
export function pluginRef(
  pluginId: unknown,
  plugins: ReadonlyArray<{ manifest: { id: string }; source: PluginSourceKind }>,
): PluginRef {
  const plugin = plugins.find((entry) => entry.manifest.id === pluginId);
  if (!plugin) return PluginSourceKind.Local;
  return SHAREABLE_SOURCES.has(plugin.source) ? plugin.manifest.id : plugin.source;
}

// ── what pairs records in memory ────────────────────────────────────────────────────────────

/** A worker's start, kept until its end. */
interface WorkerStart {
  at: number;
  isolation: WorkerIsolation | null;
  in: GameEngine | null;
}

/** What this area pairs across records in one launch: times and codes, never ids that leave. */
export interface BuildsMemory {
  /** Each run's execution as this launch saw it (`run-state.ts`). */
  runs: Map<string, RunExecution>;
  /** A run's `run_started` payload, kept until its `autopilot_started` sends the start. */
  starts: Map<string, Fields>;
  /** When each paused run paused. */
  pausedAt: Map<string, number>;
  /** How each conversation's newest run ended, and when. */
  lastClose: Map<string, { status: ExecutionStatus; at: number }>;
  /** Chat turns whose first worker already counted as a build's start. */
  turns: Set<string>;
  workers: Map<string, WorkerStart>;
  /** When each run last merged, for its health pass. */
  merges: Map<string, number>;
  /** When each finish check began, by run and round. */
  checks: Map<string, number>;
  /** Who started each job. */
  jobs: Map<string, JobRole>;
  /** When a plugin call of a kind last failed, by chat and kind. */
  failedCalls: Map<string, number>;
  /** The plugins installed now, for `plugin_ref`. */
  plugins: () => ReadonlyArray<{ manifest: { id: string }; source: PluginSourceKind }>;
  /** A game's random ref by its folder name (`game-ref.ts`); none until the listeners start. */
  gameRef: (name: string | null) => string | null;
}

/** Memory for one start of the listeners. */
export function buildsMemory(): BuildsMemory {
  return {
    runs: new Map(),
    starts: new Map(),
    pausedAt: new Map(),
    lastClose: new Map(),
    turns: new Set(),
    workers: new Map(),
    merges: new Map(),
    checks: new Map(),
    jobs: new Map(),
    failedCalls: new Map(),
    plugins: () => [],
    gameRef: () => null,
  };
}

/** Where a record sits: its conversation and its time. */
interface At {
  thread: string;
  at: number;
}

type Reader = (payload: Fields, at: At, memory: BuildsMemory) => BuildsTracked | null;

const runIdOf = (payload: Fields): string | null => textOf(payload.runId);
const workerKeyOf = (payload: Fields): string | null => {
  const worker = textOf(payload.workerId);
  const scope = runIdOf(payload) ?? textOf(payload.turn);
  return worker && scope ? `${scope}\n${worker}` : null;
};

// ── runs ────────────────────────────────────────────────────────────────────────────────────

/** The game a run builds, and how the chat's run before this one ended and how long ago. */
function runContext(
  memory: BuildsMemory,
  at: At,
  project: unknown,
): Pick<RunStartedProperties, "previous_run_state" | "ms_since_previous_end" | "game_ref"> {
  const previous = memory.lastClose.get(at.thread);
  return {
    previous_run_state: previous?.status ?? null,
    ms_since_previous_end: previous ? elapsedMs(previous.at, at.at) : null,
    game_ref: memory.gameRef(textOf(project)),
  };
}

const completionPolicyOf = (budgets: unknown): CompletionPolicy | null =>
  oneOf(CompletionPolicy, fieldsOf(budgets).completionPolicy);

/** A Loop's start, sent at `autopilot_started` with its `run_started` read before it. */
const runStarted: Reader = (payload, at, memory) => {
  const runId = runIdOf(payload);
  if (!runId) return null;
  const start = memory.starts.get(runId) ?? {};
  memory.starts.delete(runId);
  const budgets = start.budgets ?? payload.budgets;
  const loop = recordedRunLoop(budgets);
  return {
    event: BuildsEvent.RunStarted,
    properties: {
      mode: BuildMode.Loop,
      loop_hours: loop?.hours ?? null,
      until_satisfied: loop?.hours === null,
      completion_policy: completionPolicyOf(budgets),
      director: payload.director === true,
      facets: lengthOf(payload.facets),
      max_parallel: amountOf(payload.maxParallel),
      profile: oneOf(LoopProfile, payload.profile),
      resumed: payload.resumed === true || start.resumed === true,
      engine: oneOf(EngineId, start.engine),
      ...runContext(memory, at, payload.project ?? start.project),
    },
  };
};

/** A run's start record: kept for its `autopilot_started`, which says how the Loop works. */
const runStartRecorded: Reader = (payload, _at, memory) => {
  const runId = runIdOf(payload);
  if (runId) memory.starts.set(runId, payload);
  return null;
};

/** A worker's start: kept for its end; a chat turn's first worker starts a chat build. */
const workerStarted: Reader = (payload, at, memory) => {
  const key = workerKeyOf(payload);
  if (key) {
    const isolation = oneOf(WorkerIsolation, payload.isolation);
    memory.workers.set(key, { at: at.at, isolation, in: oneOf(GameEngine, payload.in) });
  }
  const turn = textOf(payload.turn);
  if (!turn || runIdOf(payload) || memory.turns.has(turn)) return null;
  memory.turns.add(turn);
  return {
    event: BuildsEvent.RunStarted,
    properties: {
      mode: BuildMode.ChatTurn,
      loop_hours: null,
      until_satisfied: false,
      completion_policy: null,
      director: false,
      facets: 0,
      max_parallel: null,
      profile: null,
      resumed: false,
      engine: null,
      ...runContext(memory, at, payload.project),
    },
  };
};

/** A worker's end, or the lead's later verdict on it. */
const workerFinished: Reader = (payload, at, memory) => {
  const inRun = runIdOf(payload) !== null;
  const verdict = oneOf(WorkerVerdict, payload.verdict);
  const state = oneOf(WorkerEnd, payload.state);
  if (!state) {
    if (!verdict) return null;
    return { event: BuildsEvent.WorkerJudged, properties: { verdict, merged: payload.merged === true, in_run: inRun } };
  }
  const key = workerKeyOf(payload);
  const start = key ? memory.workers.get(key) : undefined;
  if (key) memory.workers.delete(key);
  return {
    event: BuildsEvent.WorkerFinished,
    properties: {
      state,
      stop_code: oneOf(WorkerStopCode, payload.stopCode),
      isolation: start?.isolation ?? null,
      in: start?.in ?? null,
      delivered: payload.delivered === true,
      in_game: payload.inGame === true,
      ms: since(start?.at, at.at),
      in_run: inRun,
    },
  };
};

const runStartRefused: Reader = (payload) => ({
  event: BuildsEvent.RunStartRefused,
  properties: { conflict: runIdOf(payload) !== null, refusal: oneOf(RunStartRefusal, payload.refusal) },
});

const planReviewShown: Reader = (payload) => ({
  event: BuildsEvent.RunPlanReviewShown,
  properties: { wait_minutes: amountOf(payload.waitMinutes), facets: lengthOf(payload.facets) },
});

const merged: Reader = (payload, at, memory) => {
  const runId = runIdOf(payload);
  if (runId) memory.merges.set(runId, at.at);
  return null;
};

/** The classic pipeline's look at the merged build: does it run? */
const integrationHealth: Reader = (payload, at, memory) => {
  const runId = runIdOf(payload);
  return {
    event: BuildsEvent.BuildHealthChecked,
    properties: {
      ok: flagOf(payload.ok),
      rule: null,
      ms_since_merge: since(runId ? memory.merges.get(runId) : undefined, at.at),
      problems_count: Array.isArray(payload.problems) ? payload.problems.length : null,
    },
  };
};

/** How a verdict's planned and grown checks read: how many pass, of how many judged. */
function checksOf(measured: unknown): { passing: number | null; total: number | null } {
  const fields = fieldsOf(measured);
  const lines = [fields.planned, fields.grown].flatMap((list) => (Array.isArray(list) ? list : []));
  if (lines.length === 0) return { passing: null, total: null };
  return { passing: lines.filter((line) => fieldsOf(line).pass === true).length, total: lines.length };
}

/** How a lead's kept-or-not reads as a round's outcome. */
function keptOutcome(kept: unknown): RoundOutcome {
  if (kept === true) return RoundOutcome.Accepted;
  if (kept === false) return RoundOutcome.Rejected;
  return RoundOutcome.Unevaluated;
}

/** A lead's verdict: its health pass is the build's start check; every other pass judges a round. */
const directorVerdict: Reader = (payload, at, memory) => {
  const decision = fieldsOf(payload.decision);
  const rule = oneOf(VerdictRule, decision.rule);
  const pass = oneOf(VerdictPass, payload.pass) ?? VerdictPass.Judge;
  if (pass === VerdictPass.Health) {
    const runId = runIdOf(payload);
    return {
      event: BuildsEvent.BuildHealthChecked,
      properties: {
        ok: flagOf(decision.kept),
        rule,
        ms_since_merge: since(runId ? memory.merges.get(runId) : undefined, at.at),
        problems_count: null,
      },
    };
  }
  const checks = checksOf(payload.measured);
  return {
    event: BuildsEvent.RunRoundJudged,
    properties: {
      outcome: keptOutcome(decision.kept),
      pass,
      rule,
      checks_passing: checks.passing,
      checks_total: checks.total,
    },
  };
};

/** A part's or a run's own round, judged by its own record. */
const roundJudged: Reader = (payload) => {
  const board = fieldsOf(payload.scoreboard);
  return {
    event: BuildsEvent.RunRoundJudged,
    properties: {
      outcome: roundOutcome(payload),
      pass: VerdictPass.Round,
      rule: null,
      checks_passing: amountOf(board.passing),
      checks_total: amountOf(board.total),
    },
  };
};

/** One step of a Loop's finish check: its checking start is kept, an answer is sent with how long it took. */
const finishCheck: Reader = (payload, at, memory) => {
  const step = oneOf(FinishCheckStep, payload.step);
  const key = `${runIdOf(payload) ?? ""}\n${String(payload.round)}`;
  if (!step) return null;
  if (step === FinishCheckStep.Checking) {
    memory.checks.set(key, at.at);
    return null;
  }
  const started = memory.checks.get(key);
  memory.checks.delete(key);
  return {
    event: BuildsEvent.FinishCheckAnswered,
    properties: {
      round: amountOf(payload.round),
      step,
      rejections: amountOf(payload.rejections),
      stopped: payload.stopped === true,
      time_left: payload.timeLeft === true,
      done_count: lengthOf(payload.done),
      not_done_count: lengthOf(payload.notDone),
      reviewer_engine: oneOf(EngineId, fieldsOf(payload.reviewer).engine),
      ms_checking: since(started, at.at),
    },
  };
};

/** A part's trouble, by the record that tells it. */
const partStuck =
  (kind: PartTrouble): Reader =>
  (payload) => ({
    event: BuildsEvent.RunPartStuck,
    properties: { kind, lost: oneOf(EngineFailureKind, payload.lost), attempt: amountOf(payload.attempt) },
  });

/** How many of a close's rounds were kept and undone. */
function roundsOf(iterations: unknown): { accepted: number; rejected: number } {
  const outcomes = (Array.isArray(iterations) ? iterations : []).map((item) =>
    isRecord(item) ? roundOutcome(item) : RoundOutcome.Unevaluated,
  );
  return {
    accepted: outcomes.filter((outcome) => outcome === RoundOutcome.Accepted).length,
    rejected: outcomes.filter((outcome) => outcome === RoundOutcome.Rejected).length,
  };
}

/** What a close leaves still to fix, as counts and its code. */
function stillToFixOf(
  payload: Fields,
): Pick<RunFinishedProperties, "still_to_fix_why" | "done_count" | "not_done_count"> {
  const left = fieldsOf(payload.stillToFix);
  return {
    still_to_fix_why: oneOf(StopWhy, left.why),
    done_count: lengthOf(left.done),
    not_done_count: Math.max(lengthOf(left.notDone), lengthOf(payload.notDone)),
  };
}

/** A run's close: how it ended, by its codes, counts and times. */
const runFinished: Reader = (payload, at, memory) => {
  const runId = runIdOf(payload) ?? "";
  const before = memory.runs.get(runId) ?? null;
  const record = { event_type: CustomEvent.RunFinished, payload: { ...payload }, at: new Date(at.at).toISOString() };
  const closed = executionStep(before, runId, record);
  const status = closed?.status ?? ExecutionStatus.Completed;
  const limit = fieldsOf(payload.limit);
  const rounds = roundsOf(payload.iterations);
  memory.lastClose.set(at.thread, { status, at: at.at });
  return {
    event: BuildsEvent.RunFinished,
    properties: {
      execution_status: status,
      stop_code: oneOf(StopCode, payload.stopCode),
      limit_kind: oneOf(EngineFailureKind, limit.kind),
      retry_after_ms: amountOf(limit.retryAfterMs),
      ...stillToFixOf(payload),
      landed: payload.landed === true,
      victory: payload.victory === true,
      duration_ms: amountOf(payload.durationMs),
      worked_ms: before && closed ? workedMs(closed.worked, at.at) : null,
      loop_hours: hoursOf(fieldsOf(payload.stillToFix).hours),
      rounds_accepted: rounds.accepted,
      rounds_rejected: rounds.rejected,
      profile: oneOf(LoopProfile, payload.profile),
      loop_refusal: loopRefusalOf(payload.refusal),
      game_ref: memory.gameRef(textOf(payload.project)),
    },
  };
};

const autoResumed: Reader = (payload, at, memory) => {
  const runId = runIdOf(payload);
  return {
    event: BuildsEvent.RunAutoResumed,
    properties: {
      cause: oneOf(AutoResumeCause, payload.cause),
      attempt: amountOf(payload.attempt),
      paused_ms: since(runId ? memory.pausedAt.get(runId) : undefined, at.at),
    },
  };
};

// ── chat builds, jobs and plugin calls ──────────────────────────────────────────────────────

const previewReady: Reader = (payload, _at, memory) => ({
  event: BuildsEvent.FirstPreviewReady,
  properties: {
    ms_build_to_ready: amountOf(payload.ms),
    via: oneOf(ReadyVia, payload.via),
    in_run: runIdOf(payload) !== null,
    game_ref: memory.gameRef(textOf(payload.project)),
  },
});

/** What the studio saw of a finished chat build: its own word, the page's answer and the frame's. */
const buildObserved: Reader = (payload) => {
  const ready = fieldsOf(payload.ready);
  const seen = fieldsOf(payload.observation);
  return {
    event: BuildsEvent.ChatBuildObserved,
    properties: {
      ok: payload.ok === true,
      console_errors: countBucket(amountOf(payload.consoleErrors) ?? 0),
      duration_ms: amountOf(payload.durationMs),
      turns: amountOf(payload.turns),
      stop_reason: wordOrOther(StopReason, payload.stopReason),
      ready: flagOf(ready.ready),
      ready_via: oneOf(ReadyVia, ready.via),
      ready_timed_out: ready.timedOut === true,
      page_timed_out: ready.pageTimedOut === true,
      frame_advanced: flagOf(seen.frameAdvanced),
      running: flagOf(seen.running),
      studio_missing: flagOf(seen.studioMissing),
    },
  };
};

const buildIncomplete: Reader = (payload) => ({
  event: BuildsEvent.ChatBuildIncomplete,
  properties: { stop_reason: wordOrOther(StopReason, payload.stopReason) },
});

const jobStarted: Reader = (payload, _at, memory) => {
  const job = textOf(payload.jobId);
  const role = oneOf(JobRole, payload.role);
  if (job && role) memory.jobs.set(job, role);
  return null;
};

const jobEnded: Reader = (payload, _at, memory) => {
  const job = textOf(payload.jobId);
  const role = job ? memory.jobs.get(job) : undefined;
  if (job) memory.jobs.delete(job);
  const exit = payload.exitCode;
  return {
    event: BuildsEvent.AgentJobEnded,
    properties: {
      state: oneOf(JobState, payload.state),
      stopped_by: oneOf(JobStopper, payload.stoppedBy),
      role: role ?? null,
      exit_nonzero: typeof exit === "number" && exit !== 0,
      duration_ms: amountOf(payload.durationMs),
      in_run: runIdOf(payload) !== null,
    },
  };
};

/** Whether this failed call repeats a failure of the same kind in the same chat a moment ago; remembers a failure. */
function retryOfFailed(memory: BuildsMemory, call: { key: string; ok: boolean; at: number }): boolean {
  const before = memory.failedCalls.get(call.key);
  if (call.ok) memory.failedCalls.delete(call.key);
  else memory.failedCalls.set(call.key, call.at);
  return !call.ok && before !== undefined && call.at - before <= RETRY_OF_FAILED_MS;
}

/** A plugin call's end: whose, what it made, and how it ended. The tool is named only for a plugin that may be named. */
const pluginTool: Reader = (payload, at, memory) => {
  const ref = pluginRef(payload.pluginId, memory.plugins());
  const named = ref !== PluginSourceKind.Local && ref !== PluginSourceKind.Github;
  const kind = oneOf(MakingKind, fieldsOf(payload.making).kind) ?? Unlisted.Other;
  const ok = payload.ok === true;
  const tool = named ? wordOrOther(GenexTool, fieldsOf(payload.making).tool) : null;
  return {
    event: BuildsEvent.PluginToolFinished,
    properties: {
      plugin_ref: ref,
      kind,
      tool,
      ok,
      cut_off: oneOf(CallCutOff, payload.cutOff),
      blocked: oneOf(GenexBlocked, payload.blocked),
      duration_ms: amountOf(payload.durationMs),
      images: amountOf(payload.images) ?? 0,
      retry_of_failed: retryOfFailed(memory, { key: `${at.thread}\n${ref}\n${kind}`, ok, at: at.at }),
      in_run: runIdOf(payload) !== null,
    },
  };
};

/** The readers, by the record they read. */
const READERS: Readonly<Partial<Record<string, Reader>>> = {
  [CustomEvent.RunStarted]: runStartRecorded,
  [CustomEvent.AutopilotStarted]: runStarted,
  [CustomEvent.RunStartBlocked]: runStartRefused,
  [CustomEvent.AutopilotPlanReview]: planReviewShown,
  [CustomEvent.WorkerStarted]: workerStarted,
  [CustomEvent.WorkerFinished]: workerFinished,
  [CustomEvent.IntegrationMerge]: merged,
  [CustomEvent.IntegrationHealth]: integrationHealth,
  [CustomEvent.DirectorVerdict]: directorVerdict,
  [CustomEvent.FacetIteration]: roundJudged,
  [CustomEvent.RunIteration]: roundJudged,
  [CustomEvent.FinishCheck]: finishCheck,
  [CustomEvent.FacetCircuitBreak]: partStuck(PartTrouble.CircuitBreak),
  [CustomEvent.FacetStopped]: partStuck(PartTrouble.Stopped),
  [CustomEvent.FacetWindDown]: partStuck(PartTrouble.WindDown),
  [CustomEvent.FacetProviderOutage]: partStuck(PartTrouble.ProviderOutage),
  [CustomEvent.FacetMachinePressure]: partStuck(PartTrouble.MachinePressure),
  [CustomEvent.RunFinished]: runFinished,
  [CustomEvent.RunAutoResumed]: autoResumed,
  [CustomEvent.PreviewReady]: previewReady,
  [CustomEvent.BuildObservation]: buildObserved,
  [CustomEvent.DelegationIncomplete]: buildIncomplete,
  [CustomEvent.JobStarted]: jobStarted,
  [CustomEvent.JobEnded]: jobEnded,
  [CustomEvent.PluginTool]: pluginTool,
};

/** A run's lifecycle record moves its execution; any other of its records marks it working. */
function followExecution(memory: BuildsMemory, record: { event_type: string; payload: Fields }, at: number): void {
  const runId = runIdOf(record.payload);
  if (!runId) return;
  const when = new Date(at).toISOString();
  const before = memory.runs.get(runId) ?? null;
  if (!isExecutionEvent(record)) {
    const active = executionActivity(before, when);
    if (active) memory.runs.set(runId, active);
    return;
  }
  const next = executionStep(before, runId, {
    event_type: record.event_type,
    payload: { ...record.payload },
    at: when,
  });
  if (next) memory.runs.set(runId, next);
  followPause(memory, { runId, eventType: record.event_type, paused: next?.status === ExecutionStatus.Paused }, at);
}

/** When a run paused, kept until it resumes or starts again. */
function followPause(
  memory: BuildsMemory,
  step: { runId: string; eventType: string; paused: boolean },
  at: number,
): void {
  const { runId, eventType } = step;
  if (RUN_RESUME_EVENTS.has(eventType) || RUN_START_EVENTS.has(eventType)) memory.pausedAt.delete(runId);
  const paused = RUN_PAUSE_EVENTS.has(eventType) || step.paused;
  if (paused && !memory.pausedAt.has(runId)) memory.pausedAt.set(runId, at);
}

/** The events one log record means, given what this launch read before it. */
export function buildsLogEvents(record: EventEnvelope, memory: BuildsMemory): BuildsTracked[] {
  const custom = customRecord(record.data);
  if (!custom) return [];
  const at = { thread: record.thread_id, at: recordTime(record) };
  const found = READERS[custom.event_type]?.(custom.payload, at, memory) ?? null;
  followExecution(memory, custom, at.at);
  return found ? [found] : [];
}

// ── main's run events ───────────────────────────────────────────────────────────────────────

/** The events one of main's UI events means. */
export function buildsUiEvents(
  event: { type: string; payload?: unknown },
  memory: BuildsMemory,
  now: number,
): BuildsTracked[] {
  const payload = fieldsOf(event.payload);
  if (event.type !== UiEvent.RunStopping) return [];
  const run = memory.runs.get(runIdOf(payload) ?? "");
  return [{ event: BuildsEvent.RunStopRequested, properties: { worked_ms: run ? workedMs(run.worked, now) : null } }];
}

// ── the library: first builds, asset jobs, inventories ──────────────────────────────────────

/** Games that were waiting for their first build and no longer are. */
export function firstBuildsMade(
  before: ReadonlyArray<Pick<GameProject, "name" | "awaitingFirstBuild">>,
  after: ReadonlyArray<Pick<GameProject, "name" | "createdAt" | "awaitingFirstBuild">>,
  at: { now: number; gameRef: (name: string) => string | null },
): BuildsTracked[] {
  const waited = new Set(before.filter((game) => game.awaitingFirstBuild === true).map((game) => game.name));
  return after
    .filter((game) => waited.has(game.name) && game.awaitingFirstBuild !== true)
    .map((game) => {
      const created = Date.parse(game.createdAt);
      return {
        event: BuildsEvent.GameFirstBuildMade,
        properties: {
          ms_since_game_created: Number.isFinite(created) ? elapsedMs(created, at.now) : null,
          game_ref: at.gameRef(game.name),
        },
      };
    });
}

/** Where each job of one inventory stands, and since when this launch saw it there. */
export type JobPhases = Map<string, { phase: MakingPhase; since: number }>;

/** The jobs whose phase moved since the last read of the same game; `seen` is updated. */
export function jobPhaseChanges(
  project: string,
  jobs: ReadonlyArray<Pick<MakingJob, "jobId" | "phase" | "kind">> | undefined,
  seen: JobPhases,
  now: number,
): BuildsTracked[] {
  const found: BuildsTracked[] = [];
  for (const job of jobs ?? []) {
    const key = `${project}\n${job.jobId}`;
    const before = seen.get(key);
    if (before?.phase === job.phase) continue;
    seen.set(key, { phase: job.phase, since: now });
    if (!before) continue;
    found.push({
      event: BuildsEvent.AssetJobPhaseChanged,
      properties: {
        from: before.phase,
        to: job.phase,
        kind: oneOf(MakingKind, job.kind) ?? Unlisted.Other,
        ms_in_from: elapsedMs(before.since, now),
      },
    });
  }
  return found;
}

/** Inventories whose read just failed, with how many reads in a row failed. */
export function inventoryFailures(
  before: Readonly<Record<string, Pick<AssetInventory, "error">>>,
  after: Readonly<Record<string, Pick<AssetInventory, "error">>>,
  failures: Map<string, number>,
): BuildsTracked[] {
  const found: BuildsTracked[] = [];
  for (const [project, inventory] of Object.entries(after)) {
    if (inventory === before[project]) continue;
    if (inventory.error === null) {
      failures.delete(project);
      continue;
    }
    const inRow = (failures.get(project) ?? 0) + 1;
    failures.set(project, inRow);
    found.push({ event: BuildsEvent.AssetsInventoryFailed, properties: { failures_in_row: inRow } });
  }
  return found;
}

/** Whether each game's build was broken when the stage last asked, kept per game across the times it is watched. */
export type BuildPolls = Map<string, boolean>;

/**
 * One build poll's answer for a game, as `game_build_failed`'s properties when it says the build
 * just broke: the poll before it found the game building. A game's first answer only says how it
 * stands, so opening or reopening a game that is already broken is never counted; `polls` is updated.
 */
export function buildBroke(
  polls: BuildPolls,
  project: string,
  problem: Pick<BuildProblem, "needsInstall" | "showingLastBuild" | "skippedScripts" | "code"> | null,
): BuildsEventProperties[typeof BuildsEvent.GameBuildFailed] | null {
  const builtBefore = polls.get(project) === false;
  polls.set(project, problem !== null);
  if (!problem || !builtBefore) return null;
  return {
    needs_install: problem.needsInstall,
    showing_last_build: problem.showingLastBuild,
    skipped_scripts: problem.skippedScripts !== null,
    killed: problem.code === null,
  };
}

/** The asset job moves in every inventory that changed. */
function assetJobChanges(before: LibraryState, after: LibraryState, seen: JobPhases, now: number): BuildsTracked[] {
  return Object.entries(after.assets)
    .filter(([project, inventory]) => inventory !== before.assets[project] && inventory.value)
    .flatMap(([project, inventory]) => jobPhaseChanges(project, inventory.value?.jobs, seen, now));
}

/** What the library's changes mean, watched from its store. */
function watchLibrary(app: Studio, now: () => number, ref: (name: string) => string | null): () => void {
  const seen: JobPhases = new Map();
  const failures = new Map<string, number>();
  return app.library.subscribe(
    guarded((after, before) => {
      const at = now();
      if (after.games !== before.games) sendAll(firstBuildsMade(before.games, after.games, { now: at, gameRef: ref }));
      if (after.assets === before.assets) return;
      sendAll(assetJobChanges(before, after, seen, at));
      sendAll(inventoryFailures(before.assets, after.assets, failures));
    }),
  );
}

/** What this area hears from the log, from main's events and from the library. */
export function createBuildsObservers(now: () => number = Date.now): AreaObservers {
  const memory = buildsMemory();
  memory.gameRef = (name) => gameRef(name);
  return {
    log: (record) => sendAll(buildsLogEvents(record, memory)),
    ui: (event) => sendAll(buildsUiEvents(event, memory, now())),
    start(app) {
      memory.plugins = () => app.plugins.getState().list;
      return watchLibrary(app, now, (name) => gameRef(name));
    },
  };
}
