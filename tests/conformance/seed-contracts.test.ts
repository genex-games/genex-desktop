/**
 * The app and the harness each keep a copy of the contracts they share, because the app must not
 * load the agent's editable seed (scripts/check-boundaries.ts) and the seed cannot import from
 * the app. These tests hold the copies together: the same coordinator tools, the same queue
 * states and readings of the same logs, the same role tables and presets, the same skill
 * edits and the same vocabularies. A change to one copy that the other lacks fails here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as seedChatDispatch from "../../src/harness-seed/loop/chat-dispatch.ts";
import * as seedContractLessons from "../../src/harness-seed/loop/contract-lessons.ts";
import * as seedCompletionPolicy from "../../src/harness-seed/loop/completion-policy.ts";
import { endsSessions as seedEndsSessions } from "../../src/harness-seed/loop/compaction-log.ts";
import * as seedDelegatedTurn from "../../src/harness-seed/loop/delegated-turn.ts";
import * as seedFolderFacts from "../../src/harness-seed/loop/folder-facts.ts";
import * as seedEngineGame from "../../src/harness-seed/loop/engine-game.ts";
import * as seedGameEngine from "../../src/harness-seed/loop/game-engine.ts";
import * as seedUnrealLead from "../../src/harness-seed/loop/unreal/lead-contract.ts";
import * as seedUnrealLive from "../../src/harness-seed/loop/unreal/live-contract.ts";
import blenderManifest from "../../src/plugins/blender/plugin.json" with { type: "json" };
import genexManifest from "../../src/plugins/genex/plugin.json" with { type: "json" };
import { PartRunState, PlayCheckShot } from "../../src/plugins/unreal/editor-queue.ts";
import { LeadLoopToolName, LiveLoopToolName, LoopToolName } from "../../src/plugins/unreal/loop-tools.ts";
import { LeadPluginTool as seedLeadPluginTool } from "../../src/harness-seed/loop/unreal/save-point.ts";
import { PluginCallBlocker as seedPluginCallBlocker } from "../../src/harness-seed/loop/unreal/lead-steps.ts";
import { PluginCallBlocker } from "../../src/shared/plugins.ts";
import { LOCK_LABEL_CHARS } from "../../src/shared/plugin-hooks.ts";
import { HelperState } from "../../src/plugins/unreal/setup.ts";
import unrealManifest from "../../src/plugins/unreal/plugin.json" with { type: "json" };
import * as seedInbox from "../../src/harness-seed/loop/run-inbox.ts";
import * as seedQueue from "../../src/harness-seed/loop/message-queue.ts";
import * as seedRoles from "../../src/harness-seed/loop/model-roles.ts";
import * as seedEffort from "../../src/harness-seed/loop/effort-cap.ts";
import * as seedOutage from "../../src/harness-seed/loop/outage.ts";
import * as seedSandboxRefusal from "../../src/harness-seed/loop/workers/sandbox-refusal.ts";
import * as seedOutcomes from "../../src/harness-seed/loop/outcomes.ts";
import {
  PreviewConsoleSource as seedPreviewConsoleSource,
  PreviewGone as seedPreviewGone,
} from "../../src/harness-seed/loop/preview-gone.ts";
import { PageMethod as seedPageMethod } from "../../src/harness-seed/loop/page-contract.ts";
import * as seedJudgeProvenance from "../../src/harness-seed/loop/judge-provenance.ts";
import { InteractionObjective, InteractionSource, InteractionStatus } from "../../src/shared/run-summary.ts";
import * as seedInteractionEvidence from "../../src/harness-seed/loop/interaction-evidence.ts";
import * as seedInteractionWords from "../../src/harness-seed/loop/interaction-words.ts";
import * as seedComputerLoop from "../../src/harness-seed/loop/computer-loop.ts";
import { ScreenRole } from "../../src/shared/agent-screen.ts";
import { ComputerPacing } from "../../src/shared/computer-target.ts";
import * as seedRunEvents from "../../src/harness-seed/loop/run-events.ts";
import * as seedSkills from "../../src/harness-seed/loop/skills.ts";
import * as seedStateShape from "../../src/harness-seed/loop/state-shape.ts";
import { SteerDelivery as seedSteerDelivery } from "../../src/harness-seed/loop/steer-delivery.ts";
import * as seedTime from "../../src/harness-seed/loop/time.ts";
import * as seedWakeSchedule from "../../src/harness-seed/loop/director/wake-schedule.ts";
import { DelegationRefusal as seedDelegationRefusal } from "../../src/harness-seed/loop/director/lead-session.ts";
import * as seedWorkers from "../../src/harness-seed/loop/workers/contract.ts";
import * as seedWhere from "../../src/harness-seed/loop/workers/where.ts";
import * as seedWorkerRecords from "../../src/harness-seed/loop/workers/records.ts";
import * as seedJobs from "../../src/harness-seed/loop/jobs/contract.ts";
import * as seedBudgets from "../../src/harness-seed/loop/director/budgets.ts";
import { yes as seedYes } from "../../src/harness-seed/loop/director/args.ts";
import { DirectorTool as seedDirectorTool } from "../../src/harness-seed/loop/director/tool-specs.ts";
import { finishLands, RunWriteTool } from "../../src/main/core/worker-tools.ts";
import { RESUME_RUN as seedResumeRun } from "../../src/harness-seed/loop/after-loop-run.ts";
import { REOPEN_RUN as seedReopenRun } from "../../src/harness-seed/loop/reopen-run-prompts.ts";
import {
  COMMAND_TIMEOUT_MS as seedGameToolsTable,
  tools as seedGameTools,
} from "../../src/harness-seed/tools/game-tools.ts";
import { COMMAND_TIMEOUT_MS } from "../../src/shared/toolchain.ts";
import * as seedVerdict from "../../src/harness-seed/loop/verdict.ts";
import { endsChatSessions } from "../../src/shared/chat-rewind.ts";
import * as coordinator from "../../src/shared/coordinator.ts";
import { throughClaudeFolder as seedThroughClaudeFolder } from "../../src/harness-seed/loop/workers/claude-folder.ts";
import { throughClaudeFolder } from "../../src/substrate/paths.ts";
import {
  CUSTOM_EVENT_TYPES,
  CompletionRole,
  CustomEvent,
  StopCode,
  customPayload,
} from "../../src/shared/custom-events.ts";
import * as duration from "../../src/shared/duration.ts";
import { TargetRuntime } from "../../src/shared/computer-target.ts";
import { ENGINE_ID, engineOf, GameEngine, isEngineGame } from "../../src/shared/game-engine.ts";
import { ToolPermissionState } from "../../src/shared/permissions.ts";
import {
  CoreFact,
  type FactRef,
  FactSource,
  FolderHolds,
  factsOfEngine,
  kindPending,
  kindUnknown,
  LoopProfile,
  loopProfileOf,
  ProjectStarter,
  pluginFactSource,
  servedAsWebGame,
  servedFacts,
  WEB_LOOP_FACTS,
} from "../../src/shared/project-facts.ts";
import { ProjectTool } from "../../src/shared/project-tools.ts";
import * as workers from "../../src/shared/workers.ts";
import * as jobs from "../../src/shared/jobs.ts";
import { SnapshotRefusal } from "../../src/substrate/snapshots.ts";
import { DelegationRefusal, EngineFailureKind, StopReason } from "../../src/shared/engine-requests.ts";
import * as queue from "../../src/shared/message-queue.ts";
import * as roles from "../../src/shared/model-roles.ts";
import { ReasoningEffort } from "../../src/shared/model-preferences.ts";
import { GameFront, GameSteer, PreviewConsoleSource, PreviewGone } from "../../src/shared/preview-contract.ts";
import { EngineId } from "../../src/shared/providers.ts";
import {
  CompletionPolicy,
  ExecutionStatus,
  JournalPhase,
  VerdictPass,
  VerdictRule,
  recordedRunLoop,
} from "../../src/shared/run-state.ts";
import { applyEdits, SKILL_EDIT_OPS } from "../../src/shared/skill-edits.ts";
import * as studioStateShape from "../../src/shared/studio-state-shape.ts";
import { CONTRACT_LESSONS_FILE, LESSONS_SKILL, StagedTarget } from "../../src/shared/self-change-files.ts";
import { EventKind, type EventEnvelope, MessageUsageSource } from "../../src/shared/event-log.ts";
import {
  DIRECTOR_LOOP_ENV,
  HarnessCapability,
  harnessRunEnv,
  UNREAL_RUNNER_ENV,
  UnrealRunnerChoice,
} from "../../src/shared/protocol.ts";
import { CHAT_JUDGE_CAPABILITY } from "../../src/harness-seed/loop/chat-judge.ts";
import * as seedEngineJudges from "../../src/harness-seed/loop/engine-judges.ts";
import { judgePlayToolWithJudges } from "../../src/main/core/judge-play-tool-prompts.ts";
import { LOCAL_ROLES_CAPABILITY } from "../../src/harness-seed/loop/local-roles-served.ts";
import * as seedEngineSeat from "../../src/harness-seed/loop/engine-seat.ts";
import * as seedLoopSwitch from "../../src/harness-seed/loop/loop-switch.ts";
import { EngineKind, EngineStatusCode } from "../../src/shared/engine-descriptor.ts";
import { savedByLead } from "../../src/renderer/words.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import {
  ALL_BUILD_TARGETS,
  BUILD_TARGETS,
  BuildTarget,
  CREATABLE_STACKS,
  CreationRefusal,
  GameStack,
  ProjectKind,
  STACK_OF_KIND,
  STACK_TARGETS,
  stackForTargets,
} from "../../src/shared/game-project.ts";
import { HOST_MATRIX, judgingTarget, STACK_HOST_MATRIX, TargetRefusal } from "../../src/shared/game-targets.ts";
import * as frameProfile from "../../src/shared/frame-profile.ts";
import * as gameSaves from "../../src/shared/game-saves.ts";
import { SampleBackend } from "../../src/shared/optimization.ts";
import { SampleBackend as SeedSampleBackend } from "../../src/harness-seed/loop/performance.ts";
import * as native from "../../src/shared/native-contract.ts";
import { HARNESS_MOBILE_ARTIFACTS, MobileArtifact } from "../../src/shared/game-export-contract.ts";
import * as seedNative from "../../src/harness-seed/loop/native-contract.ts";
import * as conformance from "../../src/shared/game-conformance.ts";
import * as renderQuality from "../../src/shared/render-quality.ts";
import type { CameraPoseResult, EmptySceneResult, WitnessResult } from "../../src/shared/harness-api.ts";
import { CheckKind as seedCheckKind } from "../../src/harness-seed/loop/spec.ts";
import * as seedRunDispatch from "../../src/harness-seed/loop/run-dispatch.ts";
import { launchRefusalCode as seedLaunchRefusalCode } from "../../src/harness-seed/loop/native-loop.ts";
import { RUST_NIGHT_PARTS } from "../../src/substrate/seed-upgrade.ts";

/** Bake names: a plain segment, and every hostile shape a path parameter meets. Both copies must agree on each. */
const BAKE_NAME_CANDIDATES: unknown[] = [
  "navmesh",
  "level-1_a",
  "x".repeat(64),
  "x".repeat(65),
  "",
  ".",
  "..",
  "../x",
  "/etc/hosts",
  "a/b",
  "a\\b",
  "a\0b",
  ".hidden",
  "Nav",
  "-lead",
  1,
  null,
];

/** bakeAssets and reloadAssets answers, good and malformed: each op's verdict must agree. */
const ASSET_REPLY_CANDIDATES: unknown[] = [
  { kind: "nav", name: "market", bytes: 4096, digest: "0123456789abcdef" },
  { kind: "impostor", name: "oak", bytes: 0, digest: "0123456789abcdef" },
  { kind: "terrain", name: "market", bytes: 4096, digest: "0123456789abcdef" },
  { kind: "nav", name: "../market", bytes: 4096, digest: "0123456789abcdef" },
  { kind: "nav", name: "market", bytes: -1, digest: "0123456789abcdef" },
  { kind: "nav", name: "market", bytes: 2 ** 40, digest: "0123456789abcdef" },
  { kind: "nav", name: "market", bytes: 4096, digest: "XYZ" },
  { reloaded: ["textures/bark.png"], refused: [], pending: 0 },
  { reloaded: [], refused: [{ path: "../x.png", code: "unsafe-path" }], pending: 1 },
  { reloaded: [], refused: [{ path: "x.png", code: "gone" }], pending: 0 },
  { reloaded: [1], refused: [], pending: 0 },
  { reloaded: [], refused: [], pending: -1 },
  { reloaded: [], refused: [] },
];

/** profile answers by shape (a summary, a report, an arm, a trace) and malformed ones: each op's verdict must agree. */
const PROFILE_REPLY_CANDIDATES: unknown[] = [
  { v: 1, on: true, frames: 120 },
  { v: 1, on: "yes", frames: 120 },
  { v: 1, on: true, frames: -1 },
  { v: 2, frames: [], truncated: false },
  { v: 2, frames: {}, truncated: false },
  { v: 2, frames: [], truncated: 1 },
  { v: 3, frames: [], truncated: false },
  { mode: "nodes" },
  { mode: "frame" },
  { mode: "all" },
  { bytes: 4096, digest: "0123456789abcdef" },
  { bytes: 4096, digest: "0123456789ABCDEF" },
  { bytes: -1, digest: "0123456789abcdef" },
];

/** renderSettings answers, and captures with and without their render provenance: each op's verdict must agree. */
const RENDER_REPLY_CANDIDATES: unknown[] = [
  {
    preset: "low",
    requested: "auto",
    deviceClass: "mobile-mid",
    detectedClass: "desktop-high",
    features: { bloom: false },
    renderScaleLock: null,
    scale: 0.75,
  },
  {
    preset: "auto",
    requested: "auto",
    deviceClass: "mobile-mid",
    detectedClass: "desktop-high",
    features: {},
    renderScaleLock: null,
    scale: 0.75,
  },
  {
    preset: "low",
    requested: "low",
    deviceClass: "watch-low",
    detectedClass: "desktop-high",
    features: {},
    renderScaleLock: null,
    scale: 1,
  },
  {
    preset: "low",
    requested: "low",
    deviceClass: "mobile-mid",
    detectedClass: "mobile-mid",
    features: { raytracing: true },
    renderScaleLock: 0.5,
    scale: 1,
  },
  {
    preset: "low",
    requested: "low",
    deviceClass: "mobile-mid",
    detectedClass: "mobile-mid",
    features: {},
    renderScaleLock: 3,
    scale: 1,
  },
  {
    preset: "low",
    requested: "low",
    deviceClass: "mobile-mid",
    detectedClass: "mobile-mid",
    features: {},
    renderScaleLock: null,
    frameBudgetMs: 4,
    scale: 1,
  },
  {
    preset: "low",
    requested: "low",
    deviceClass: "mobile-mid",
    detectedClass: "mobile-mid",
    features: {},
    renderScaleLock: null,
    frameBudgetMs: 0.5,
    scale: 1,
  },
  {
    seq: 1,
    width: 64,
    height: 64,
    format: "bgra8",
    digest: "0123456789abcdef",
    render: {
      preset: "high",
      deviceClass: "desktop-high",
      settingsSource: "reference-class",
      scale: 1,
      settleFrames: 8,
      historyReset: true,
      exposure: "instant",
    },
  },
  {
    seq: 1,
    width: 64,
    height: 64,
    format: "bgra8",
    digest: "0123456789abcdef",
    render: { preset: "high", deviceClass: "desktop-high" },
  },
  {
    seq: 1,
    width: 64,
    height: 64,
    format: "bgra8",
    digest: "0123456789abcdef",
    render: {
      preset: "high",
      deviceClass: "desktop-high",
      settingsSource: "saved",
      scale: 1,
      settleFrames: 1,
      historyReset: true,
      exposure: "instant",
    },
  },
  {
    seq: 1,
    width: 64,
    height: 64,
    format: "bgra8",
    digest: "0123456789abcdef",
    render: {
      preset: "high",
      deviceClass: "desktop-high",
      settingsSource: "toml",
      scale: 1,
      settleFrames: 17,
      historyReset: true,
      exposure: "instant",
    },
  },
];

/** True when `A` and `B` are each assignable to the other: two copies of one shape. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

let clock = 0;
const at = () => new Date(Date.UTC(2026, 8, 24, 0, 0, clock++)).toISOString();
const row = (id: number, data: EventEnvelope["data"]): EventEnvelope => ({
  id: String(id).padStart(4, "0"),
  thread_id: "chat",
  session_id: null,
  turn_id: null,
  created_at: at(),
  data,
});
const user = (id: number, content: string) => row(id, { type: "messages", messages: [{ role: "user", content }] });
const said = (id: number, content: string) => row(id, { type: "messages", messages: [{ role: "assistant", content }] });
const custom = (id: number, event_type: string, payload: Record<string, unknown> = {}) =>
  row(id, { type: "custom", event_type, payload });

/** Logs that walk every queue record and every run lifecycle record the two readers know. */
const LOGS: Record<string, EventEnvelope[]> = {
  empty: [],
  "a queued, edited, answered message": [
    user(1, "add a boss"),
    custom(2, "coordinator_message_queued", { messageId: "a", action: { type: "user_message", text: "add a boss" } }),
    custom(3, "coordinator_message_updated", { messageId: "a", text: "add two bosses" }),
    custom(4, "coordinator_message_processing", { messageId: "a" }),
    said(5, "On it."),
    custom(6, "coordinator_message_handled", { messageId: "a" }),
  ],
  "a paused queue with a removed and a waiting message": [
    user(1, "first"),
    custom(2, "coordinator_message_queued", { messageId: "a", action: { text: "first" } }),
    custom(3, "coordinator_queue_paused"),
    user(4, "second"),
    custom(5, "coordinator_message_queued", { messageId: "b", eventId: "0004", action: { text: "second" } }),
    custom(6, "coordinator_message_removed", { messageId: "a" }),
    user(7, "third"),
    custom(8, "coordinator_message_queued", { messageId: "c", action: { text: "third" } }),
  ],
  "an answer cut off twice by restarts": [
    user(1, "make it red"),
    custom(2, "coordinator_message_queued", { messageId: "red", action: { text: "make it red" } }),
    custom(3, "coordinator_message_processing", { messageId: "red" }),
    custom(4, "coordinator_message_requeued", { messageId: "red", attempts: 1 }),
    custom(5, "coordinator_message_processing", { messageId: "red", attempt: 2 }),
    custom(6, "coordinator_queue_resumed"),
  ],
  "a message steered into a running turn and read there, and one it did not read": [
    user(1, "build a pond"),
    custom(2, "coordinator_message_queued", { messageId: "a", action: { text: "build a pond" } }),
    custom(3, "coordinator_message_processing", { messageId: "a" }),
    user(4, "and ducks"),
    custom(5, "coordinator_message_queued", { messageId: "b", action: { text: "and ducks" } }),
    custom(6, "coordinator_message_steering", { messageId: "b", into: "a" }),
    custom(7, "coordinator_message_delivered", { messageId: "b", into: "a", how: "native" }),
    user(8, "make it run"),
    custom(9, "coordinator_message_queued", { messageId: "c", action: { text: "make it run" } }),
    custom(10, "coordinator_message_steering", { messageId: "c", into: "a" }),
    custom(11, "coordinator_message_requeued", { messageId: "c" }),
    user(12, "and rain"),
    custom(13, "coordinator_message_queued", { messageId: "d", action: { text: "and rain" } }),
    custom(14, "coordinator_message_steering", { messageId: "d" }),
  ],
  "a run started, paused, resumed and finished, then a second run": [
    custom(1, "run_registered", { runId: "r1", project: "space", goal: "a shooter" }),
    custom(2, "run_started", { runId: "r1", engine: "codex" }),
    custom(3, "facet_iteration", { runId: "r1", facetId: "enemies", winner: "challenger" }),
    custom(4, "autopilot_paused", { runId: "r1" }),
    custom(5, "autopilot_resumed", { runId: "r1" }),
    custom(6, "run_steering", { runId: "r1", text: "more stars" }),
    custom(7, "run_finished", { runId: "r1", paused: true, integrationHead: "abc1234" }),
    custom(8, "run_started", { runId: "r2", project: "space", goal: "add a boss" }),
    custom(9, "director_worker", { runId: "r2", workerId: "w1", state: "running" }),
  ],
  "a close with no run before it": [custom(1, "run_finished", { runId: "lost" }), custom(2, "autopilot_paused", {})],
  "a lead woken between its workers' news": [
    custom(1, "run_started", { runId: "r1", project: "space", goal: "add stars" }),
    custom(2, "director_worker", { runId: "r1", workerId: "w1", state: "running" }),
    custom(3, "director_continued", { runId: "r1", minutesLeft: 40, reasons: ["worker_round"] }),
    custom(4, "director_progress", { runId: "r1", text: "the sky is in" }),
    custom(5, "director_continued", { runId: "r1", minutesLeft: 20, reasons: ["heartbeat"] }),
  ],
  "a lead that took the chat's words and heard them": [
    custom(1, "run_started", { runId: "r1", project: "space", goal: "add stars" }),
    custom(2, "director_worker", { runId: "r1", workerId: "w1", state: "running" }),
    custom(3, "run_steering", { runId: "r1", text: "more stars", sourceMessageId: "red", how: "lead" }),
    custom(4, "run_steering_delivered", { runId: "r1", messageId: "3", facetId: "build", stage: "next brief" }),
    custom(5, "run_steering_delivered", { runId: "r1", sourceMessageId: "red", how: "lead" }),
  ],
};

describe("the coordinator contract (shared/coordinator.ts ↔ loop/run-inbox.ts)", () => {
  it("offers the same tools, word for word", () => {
    assert.deepEqual(coordinator.coordinatorTools, seedInbox.coordinatorTools);
    for (const tool of seedInbox.coordinatorTools)
      assert.equal(coordinator.isCoordinatorTool(tool.name), true, tool.name);
    assert.equal(coordinator.isCoordinatorTool("delete_game"), false);
  });

  it("the chat's own session after a run keeps the host's own tools: live run controls, and the resume it records", () => {
    for (const tool of coordinator.runControlTools) assert.equal(coordinator.isCoordinatorTool(tool.name), true);
    assert.deepEqual(
      coordinator.runControlTools.map((tool) => tool.name),
      Object.values(coordinator.RunControl),
    );
    // The resume is the coordinator's own `resume_run`, never a live control: its reply ends first.
    assert.equal(coordinator.isCoordinatorTool(seedResumeRun), true);
    assert.equal(coordinator.isRunControl(seedResumeRun), false);
  });

  it("names the builds a chat's own session records to start as the seed's tools do, which Plan holds", () => {
    const seedNames = new Set([...seedGameTools.map((tool) => tool.name), seedReopenRun, seedResumeRun]);
    for (const name of Object.values(coordinator.BuildLaunch)) assert.equal(seedNames.has(name), true, name);
    assert.equal(coordinator.BuildLaunch.ReopenRun, seedReopenRun);
    assert.equal(coordinator.BuildLaunch.ResumeRun, seedResumeRun);
    assert.equal(coordinator.isBuildLaunch("ask_user"), false, "a question is no launch");
  });

  it("one vocabulary names the coordinator's tools, in menu order, and the run's controls are some of them", () => {
    const names: string[] = Object.values(coordinator.CoordinatorTool);
    assert.deepEqual(
      coordinator.coordinatorTools.map((tool) => tool.name),
      names,
    );
    for (const control of Object.values(coordinator.RunControl)) assert.ok(names.includes(control), control);
  });

  for (const [name, events] of Object.entries(LOGS)) {
    it(`reads the run and the conversation of the same log the same way: ${name}`, () => {
      assert.deepEqual(coordinator.latestRun(events), seedInbox.latestRun(events as never));
      for (const runId of ["r1", "r2", "lost", "none"]) {
        assert.deepEqual(coordinator.latestRun(events, runId), seedInbox.latestRun(events as never, runId), runId);
        assert.deepEqual(coordinator.runSnapshot(events, runId), seedInbox.runSnapshot(events as never, runId), runId);
      }
      assert.deepEqual(coordinator.conversationThrough(events), seedInbox.conversationThrough(events as never));
      for (const messageId of ["a", "b", "c", "red"])
        assert.deepEqual(
          coordinator.conversationThrough(events, messageId),
          seedInbox.conversationThrough(events as never, messageId),
          messageId,
        );
    });
  }
});

describe("a compaction's end of the chat's sessions (shared/chat-rewind.ts ↔ loop/compaction-log.ts)", () => {
  const records: Array<[name: string, data: Record<string, unknown>, ends: boolean]> = [
    ["a handover", { type: "custom", event_type: "compacted", payload: { summary: "s", sessionId: "a" } }, true],
    ["a log summary", { type: "custom", event_type: "compacted", payload: { summary: "s", upTo: "1" } }, true],
    [
      "the provider's own",
      { type: "custom", event_type: "compacted", payload: { native: true, sessionId: "a" } },
      false,
    ],
    ["another record", { type: "custom", event_type: "contractor_session", payload: { sessionId: "a" } }, false],
    ["a message", { type: "messages", messages: [] }, false],
  ];
  for (const [name, data, ends] of records) {
    it(`reads whether it ends them the same way: ${name}`, () => {
      assert.equal(endsChatSessions(data as never), ends);
      assert.equal(seedEndsSessions(data), ends);
    });
  }
});

describe("the run inbox's wrap-up (shared/coordinator.ts ↔ loop/run-inbox.ts)", () => {
  it("names the wrap-up the same way, in its persisted spelling", () => {
    assert.deepEqual(coordinator.RunControlAction, { Finish: "finish" });
    assert.deepEqual(seedInbox.RunControlAction, coordinator.RunControlAction);
  });

  const finish = (id: number, runId = "r") => custom(id, "run_control", { runId, action: "finish" });
  const registered = (id: number, fields: Record<string, unknown> = {}) =>
    custom(id, "run_registered", { runId: "r", ...fields });
  const rows: Array<{ label: string; events: EventEnvelope[]; expected: boolean }> = [
    { label: "a finish, then the run resumed", events: [finish(1), registered(2, { resumed: true })], expected: false },
    { label: "the run resumed, then a finish", events: [registered(1, { resumed: true }), finish(2)], expected: true },
    { label: "an old log with no registration, then a finish", events: [finish(1)], expected: true },
    { label: "a finish for another run", events: [registered(1), finish(2, "other")], expected: false },
  ];
  for (const { label, events, expected } of rows) {
    it(`reads whether this session was asked to wrap up the same way: ${label}`, () => {
      assert.equal(seedInbox.finishRequested(events as never, "r"), expected, "harness");
      assert.equal(coordinator.finishRequested(events, "r"), expected, "app");
    });
  }
});

describe("the follow-up queue (shared/message-queue.ts ↔ loop/message-queue.ts)", () => {
  it("knows every state the harness's queue writes", () => {
    const seen = new Set<string>();
    for (const events of Object.values(LOGS))
      for (const message of seedQueue.messageQueueState(events as never).messages.values()) seen.add(message.state);
    assert.deepEqual([...seen].sort(), [...queue.QUEUE_STATES].sort());
    assert.equal(queue.MESSAGE_ATTEMPTS, seedQueue.MESSAGE_ATTEMPTS);
    assert.deepEqual(queue.SteerDelivery, seedSteerDelivery, "how a steered message was read, as both write it");
  });

  for (const [name, events] of Object.entries(LOGS)) {
    it(`reads the same queue and the same restart notice: ${name}`, () => {
      const ours = queue.messageQueueState(events);
      const theirs = seedQueue.messageQueueState(events as never);
      assert.equal(ours.paused, theirs.paused);
      assert.deepEqual([...ours.messages.entries()], [...theirs.messages.entries()]);
      assert.equal(queue.interruptedReplyNotice(events), seedQueue.interruptedReplyNotice(events as never));
    });
  }

  it("names the records the harness's queue writes", async () => {
    const events: EventEnvelope[] = [];
    const host = {
      call: async (method: string, p: { batch: EventEnvelope["data"][] }) => {
        if (method === "events.append") for (const data of p.batch) events.push(row(events.length + 1, data));
      },
      notify: () => {},
    };
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const harness = new seedQueue.MessageQueue(
      host as never,
      async () => {},
      () => gate,
    );
    await harness.enqueue({ threadId: "chat", text: "hi", messageId: "m" });
    await harness.enqueue({ threadId: "chat", text: "later", messageId: "n" });
    await harness.change("chat", "m", "edit", "hello");
    await harness.change("chat", "n", "remove");
    await harness.pause("chat");
    await harness.resume("chat");
    open();
    for (
      let n = 0;
      n < 1000 && !events.some((e) => e.data.type === "custom" && e.data.event_type === queue.QUEUE_EVENTS.handled);
      n++
    )
      await new Promise((r) => setImmediate(r));
    harness.stop();
    const written = new Set(events.flatMap((e) => (e.data.type === "custom" ? [e.data.event_type] : [])));
    const known = new Set<string>(Object.values(queue.QUEUE_EVENTS));
    for (const type of written) assert.ok(known.has(type), `${type} is a queue record the app does not name`);
    assert.equal(written.size, 7, "queued, updated, removed, paused, resumed, processing and handled were all written");
  });
});

describe("model roles (shared/model-roles.ts ↔ loop/model-roles.ts)", () => {
  it("has the same tables", () => {
    for (const key of ["FABLE", "OPUS", "SOL", "TERRA"] as const) assert.equal(roles[key], seedRoles[key], key);
    // The older seed's engine constants stay exported for kept files; they are the app's ids.
    assert.deepEqual(
      [seedRoles.CLAUDE_CODE_ENGINE, seedRoles.CODEX_ENGINE, seedRoles.BONSAI_ENGINE],
      [EngineId.ClaudeCode, EngineId.Codex, EngineId.Bonsai],
    );
    assert.deepEqual(roles.ROLES, seedRoles.ROLES);
    assert.deepEqual(roles.CLAUDE_CODE_MODELS, seedRoles.CLAUDE_CODE_MODELS);
    assert.deepEqual(roles.CODEX_MODELS, seedRoles.CODEX_MODELS);
    assert.deepEqual(roles.ENGINE_MODELS, seedRoles.ENGINE_MODELS);
    assert.deepEqual(roles.DELEGATED_ENGINES, seedRoles.DELEGATED_ENGINES);
    assert.deepEqual(roles.ENGINE_LABELS, seedRoles.ENGINE_LABELS);
  });

  const engines = ["claude-code", "codex", "bonsai", "ollama", "opencode", "openrouter", undefined];
  const models = [undefined, "default", roles.FABLE, roles.OPUS, "sonnet", roles.SOL, "gpt-5.9-new", "qwen3:8b"];

  it("resolves every preset and names every model the same way", () => {
    for (const engine of engines) {
      assert.equal(roles.isDelegated(engine), seedRoles.isDelegated(engine), String(engine));
      assert.equal(roles.hasSessionRoles(engine), seedRoles.hasSessionRoles(engine), String(engine));
      assert.equal(roles.takesRoles(engine), seedRoles.takesRoles(engine), String(engine));
      for (const key of ["planner", "builder", "judge"] as const)
        for (const other of engines)
          assert.equal(
            roles.crossesTo(engine, key, other),
            seedRoles.crossesTo(engine, key, other),
            `${engine} ${key} → ${other}`,
          );
      assert.equal(roles.engineLabel(engine), seedRoles.engineLabel(engine), String(engine));
      assert.deepEqual(roles.modelsFor(engine), seedRoles.modelsFor(engine), String(engine));
      for (const model of models) {
        const label = `${engine} ${model}`;
        if (engine) assert.deepEqual(roles.resolveRoles(engine, model), seedRoles.resolveRoles(engine, model), label);
        assert.equal(roles.roleName(engine, model), seedRoles.roleName(engine as never, model), label);
        if (engine) assert.equal(roles.describeRoles(engine, model), seedRoles.describeRoles(engine, model), label);
      }
    }
  });

  it("cleans the composer's explicit roles the same way", () => {
    const records: unknown[] = [
      null,
      "opus",
      [],
      {},
      { planner: "default" },
      { planner: roles.FABLE, builder: " opus ", judge: "" },
      { builder: roles.SOL, engines: { builder: "codex" } },
      { engines: { judge: "codex", planner: "codex" } },
      { judge: roles.OPUS, engines: { judge: "claude-code", builder: "ollama" } },
      { judge: "vl", engines: { judge: "ollama" } },
      { builder: roles.OPUS, judge: "vl", engines: { builder: "claude-code", judge: "ollama" } },
      { builder: "coder", engines: { builder: "ollama", judge: "bonsai" } },
      { planner: "sonnet", efforts: { planner: "high", builder: 3, judge: "low" } },
      { planner: "sonnet", efforts: { builder: 3 } },
      { builder: 7, judge: null, unknown: "x" },
    ];
    for (const engine of engines.filter((e): e is string => Boolean(e))) {
      for (const record of records) {
        const label = `${engine} ${JSON.stringify(record)}`;
        assert.deepEqual(roles.normalizeRoles(engine, record), seedRoles.normalizeRoles(engine, record), label);
        assert.equal(
          roles.describeRoles(engine, "opus", record),
          seedRoles.describeRoles(engine, "opus", record as object | null),
          label,
        );
      }
    }
  });
});

describe("effort per role (shared/model-roles.ts ↔ loop/effort-cap.ts)", () => {
  it("caps a worker's and a reviewer's effort at high, keeps the lead's as set, and agrees on every level", () => {
    assert.deepEqual(seedEffort.EFFORT_ORDER, Object.values(ReasoningEffort), "the same levels, least to most");
    assert.equal(seedEffort.WORKER_EFFORT_CEILING, roles.WORKER_EFFORT_CEILING);
    const levels = [...Object.values(ReasoningEffort), "turbo", undefined];
    for (const role of ["planner", "builder", "judge"] as const)
      for (const effort of levels)
        assert.equal(
          roles.roleEffortCap(role, effort),
          seedEffort.effortCap(effort, role === "planner"),
          `${role} at ${String(effort)}`,
        );
    assert.deepEqual(
      ["max", "ultra", "xhigh", "high", "medium", "low"].map((effort) => roles.roleEffortCap("builder", effort)),
      ["high", "high", "high", "high", "medium", "low"],
    );
    assert.equal(roles.roleEffortCap("judge", "max"), "high");
    assert.equal(roles.roleEffortCap("planner", "max"), "max", "the lead thinks as hard as the user set");
    assert.equal(roles.roleEffortCap("builder", "turbo"), "turbo", "a level no engine names is left alone");
  });
});

describe("vocabularies (src/shared ↔ the seed's copies)", () => {
  it("names every record the harness writes as the app names it (RunEvent ⊆ CustomEvent)", () => {
    const known = new Set<string>(CUSTOM_EVENT_TYPES);
    const app: Readonly<Record<string, string>> = CustomEvent;
    for (const [member, name] of Object.entries(seedRunEvents.RunEvent)) {
      assert.ok(known.has(name), `${name} is a record the app does not name`);
      assert.equal(app[member], name, `RunEvent.${member} is CustomEvent.${member}`);
    }
  });

  it("names an event's kind of data as the log does", () => {
    assert.deepEqual(seedRunEvents.EventKind, EventKind);
  });

  it("names who played and what an interaction rests on as the app does", () => {
    assert.deepEqual(seedInteractionWords.InteractionSource, InteractionSource);
    assert.deepEqual(seedInteractionWords.InteractionObjective, InteractionObjective);
    assert.deepEqual(seedInteractionEvidence.InteractionStatus, InteractionStatus);
  });

  it("names who holds the computer and how its clock is held as the host does", () => {
    const roles: Readonly<Record<string, string>> = ScreenRole;
    for (const [member, role] of Object.entries(seedComputerLoop.PlayRole))
      assert.equal(roles[member], role, `PlayRole.${member} is ScreenRole.${member}`);
    const pacings: Readonly<Record<string, string>> = ComputerPacing;
    for (const [member, pacing] of Object.entries(seedComputerLoop.PlayPacing))
      assert.equal(pacings[member], pacing, `PlayPacing.${member} is ComputerPacing.${member}`);
  });

  it("stages a lessons suggestion for the file the host lets it write", () => {
    assert.deepEqual(seedContractLessons.StagedTarget, StagedTarget);
    assert.equal(seedContractLessons.CONTRACT_LESSONS_FILE, CONTRACT_LESSONS_FILE);
    assert.equal(seedContractLessons.LESSONS_SKILL, LESSONS_SKILL);
  });

  it("marks a reply's usage source as the log does", () => {
    assert.deepEqual(seedDelegatedTurn.MessageUsageSource, MessageUsageSource);
  });

  it("has the same run execution statuses", () => {
    assert.deepEqual(seedRunEvents.ExecutionStatus, ExecutionStatus);
  });

  it("names the same game engines as the app's engine record", () => {
    assert.deepEqual(seedGameEngine.GameEngine, GameEngine);
    // The runtimes a game's studio.json may name, as the seed spells them (folder-facts.ts).
    assert.deepEqual(seedFolderFacts.GameRuntime, { Browser: TargetRuntime.Browser, Bridge: TargetRuntime.Bridge });
    assert.equal(seedGameEngine.engineOfGame(undefined), GameEngine.Web);
    const linked = { engine: { kind: GameEngine.Unreal, project: "/p/A.uproject", linkedAt: "" } } as const;
    assert.equal(seedGameEngine.engineOfGame(linked), GameEngine.Unreal);
    // Any engine an installed plugin declares is the game's engine, by its id, as the app's `engineOf`.
    const toy = { kind: "toy-engine", project: "/p/A.toyproj", linkedAt: "" };
    assert.equal(seedGameEngine.engineOfGame({ engine: toy }), engineOf(toy));
    assert.equal(seedGameEngine.engineOfGame({ engine: toy }), "toy-engine");
    assert.equal(seedGameEngine.ENGINE_ID.source, ENGINE_ID.source);
    const misspelt = { kind: "Toy Engine", project: "/p/A.toyproj", linkedAt: "" };
    assert.equal(seedGameEngine.engineOfGame({ engine: misspelt }), GameEngine.Web, "a kind no engine id spells");
  });

  it("tells an engine game from a web game as the app does", () => {
    for (const kind of [GameEngine.Web, GameEngine.Unreal, "toy-engine", undefined, null, "", "Toy Engine", 3])
      assert.equal(seedEngineGame.isEngineGame(kind), isEngineGame(kind), String(kind));
  });
  it("reads why the host held a plugin call back as the host answers it", () => {
    assert.deepEqual(seedPluginCallBlocker, PluginCallBlocker);
  });

  it("calls the Unreal plugin's Loop tools by their names, and reads a part run's end as the plugin writes it", () => {
    const named = Object.fromEntries(
      Object.entries(LoopToolName).map(([key, tool]) => [key, `${unrealManifest.id}__${tool}`]),
    );
    assert.deepEqual(seedUnrealLive.UnrealLoopTool, named);
    assert.deepEqual(seedUnrealLive.PartRunEnd, { Done: PartRunState.Done, Failed: PartRunState.Failed });
  });

  it("calls the Unreal plugin's harness tools for the lead by their names, and reads a play-check as the plugin writes it", () => {
    const named = Object.fromEntries(
      Object.entries(LiveLoopToolName).map(([key, tool]) => [key, `${unrealManifest.id}__${tool}`]),
    );
    assert.deepEqual(seedUnrealLive.UnrealLivePluginTool, named);
    assert.deepEqual(seedUnrealLive.LiveCamera, PlayCheckShot);
    assert.deepEqual(seedUnrealLive.EditorHelperState, HelperState);
  });

  it("names a run journal's phases as the harness writes them", () => {
    assert.deepEqual(seedRunEvents.JournalPhase, JournalPhase);
  });

  it("has the same engine ids", () => {
    assert.deepEqual(seedRoles.EngineId, EngineId);
  });

  it("reads an engine the host reports signed in the way the host says it", () => {
    assert.equal(seedSandboxRefusal.ENGINE_READY, EngineStatusCode.Ready);
  });

  it("has the same engine failure kinds", () => {
    assert.deepEqual(seedOutage.EngineFailure, EngineFailureKind);
  });

  it("reads a delegated build's stop reasons the same way", () => {
    assert.deepEqual(seedOutage.StopReason, StopReason);
  });

  it("reads why a game window's renderer went away as the host reports it", () => {
    assert.deepEqual(seedPreviewGone, PreviewGone);
  });

  it("tells the studio's own console lines from the page's the way the host writes them", () => {
    assert.deepEqual(seedPreviewConsoleSource, PreviewConsoleSource);
  });

  it("calls the game's front-end verb by the name the harness drives it with", () => {
    assert.equal(GameFront.Begin, seedPageMethod.Begin);
  });

  it("calls the racing-line assist by the name the harness steers with", () => {
    assert.equal(GameSteer.Assist, seedPageMethod.Assist);
  });

  it("reads why the host refused a delegation the same way", () => {
    // The director's copy names the lock; the worker pool's copy names the ceiling.
    assert.deepEqual(
      { ...seedDelegationRefusal, TooManyWorkers: seedWorkers.WorkerRefusal.TooManyWorkers },
      DelegationRefusal,
    );
  });

  it("finds Claude Code's own folder in a path as the host does, however it is spelled", () => {
    const paths = [
      ".claude/settings.json",
      ".CLAUDE/hooks/pre.sh",
      "src/.claude/agents/a.md",
      ".claude. /x",
      ".claude::$DATA",
      "a\\.Claude\\b",
      ".claude",
      "claude/settings.json",
      ".claudex/a",
      "src/main.ts",
      "",
    ];
    for (const rel of paths) assert.equal(seedThroughClaudeFolder(rel), throughClaudeFolder(rel), rel);
  });

  it("names the director loop's override in the studio's environment the same way", () => {
    assert.equal(seedWakeSchedule.DIRECTOR_LOOP_ENV, DIRECTOR_LOOP_ENV);
  });

  it("names the Unreal runner's switch in the studio's environment the same way", () => {
    assert.equal(seedLoopSwitch.UNREAL_RUNNER_ENV, UNREAL_RUNNER_ENV);
    assert.deepEqual(seedLoopSwitch.UnrealRunnerChoice, UnrealRunnerChoice);
  });

  it("names the engine kind the host seats in place as the app does", () => {
    assert.equal(seedEngineSeat.SEATED_ENGINE_KIND, EngineKind.Delegated);
  });

  it("hands the harness only the run overrides of the studio's environment, each only when it is set", () => {
    const cases: Array<[env: Record<string, string | undefined>, handed: Record<string, string>]> = [
      [{}, {}],
      [{ [DIRECTOR_LOOP_ENV]: "turn" }, { [DIRECTOR_LOOP_ENV]: "turn" }],
      [{ [DIRECTOR_LOOP_ENV]: " turn " }, { [DIRECTOR_LOOP_ENV]: "turn" }],
      [{ [DIRECTOR_LOOP_ENV]: "  " }, {}],
      [{ [UNREAL_RUNNER_ENV]: "lead" }, { [UNREAL_RUNNER_ENV]: "lead" }],
      [
        { [UNREAL_RUNNER_ENV]: " lead ", [DIRECTOR_LOOP_ENV]: "turn" },
        { [UNREAL_RUNNER_ENV]: "lead", [DIRECTOR_LOOP_ENV]: "turn" },
      ],
      [{ [UNREAL_RUNNER_ENV]: "" }, {}],
      // The workers' handover switch of 2026-10-03 is gone with the handover: never handed on.
      [{ STUDIO_WORKER_HANDOVER: "1" }, {}],
      [{ HOME: "/Users/someone", ANTHROPIC_API_KEY: "sk-ant-x", PATH: "/usr/bin", STUDIO_OTHER: "1" }, {}],
    ];
    for (const [env, handed] of cases) assert.deepEqual(harnessRunEnv(env), handed, JSON.stringify(env));
  });

  it("reads a verdict record's pass and rule as the harness writes them", () => {
    assert.deepEqual(seedVerdict.VerdictPass, VerdictPass);
    assert.deepEqual(seedVerdict.VerdictRule, VerdictRule);
  });

  it("writes a lead's save point with the verdict source the renderer reads as saved by the lead", () => {
    assert.equal(seedUnrealLead.LEAD_VERDICT_SOURCE, seedVerdict.VerdictSource.Lead);
    assert.equal(savedByLead(seedUnrealLead.LEAD_VERDICT_SOURCE), true);
  });

  it("names why a loop stopped the same way, and reads a run's close by its code", () => {
    assert.deepEqual(seedOutcomes.StopCode, StopCode);
    const close = seedOutcomes.stopWith({ runId: "r1" }, seedOutcomes.StopCode.NoImprovement, "lost to its base");
    const read = customPayload(
      { type: "custom", event_type: CustomEvent.RunFinished, payload: close },
      CustomEvent.RunFinished,
    );
    assert.equal(read?.stopCode, StopCode.NoImprovement);
  });

  it("names who asked for a direct model call the same way", () => {
    assert.deepEqual(seedJudgeProvenance.CompletionRole, CompletionRole);
  });

  it("logs a chat's delegation under the tool name the app reads", () => {
    assert.equal(seedDelegatedTurn.DELEGATE_TOOL, coordinator.DELEGATE_TOOL);
  });

  it("names what ends a run (its budgets' completion policy) the same way", () => {
    assert.deepEqual(seedCompletionPolicy.CompletionPolicy, CompletionPolicy);
  });

  it("names a bounded state's markers and keep limits the same way, and validates keep paths the same way", () => {
    assert.deepEqual(seedStateShape.StateShape, studioStateShape.StateShape);
    assert.deepEqual(seedStateShape.ElidedKind, studioStateShape.ElidedKind);
    assert.equal(seedStateShape.MAX_KEEP_PATHS, studioStateShape.MAX_KEEP_PATHS);
    assert.equal(seedStateShape.MAX_KEEP_PATH_CHARS, studioStateShape.MAX_KEEP_PATH_CHARS);
    const raws: unknown[] = [
      undefined,
      "race.cars",
      [1, null, {}, ["race"]],
      ["", ".race", "race.", "race..cars", "a".repeat(121), "a".repeat(120)],
      ["__proto__.polluted", "a.constructor", "prototype", "race.cars", "race.cars", "cars.0.x"],
      Array.from({ length: 200 }, (_, i) => `p${i}`),
    ];
    for (const raw of raws) {
      assert.deepEqual(seedStateShape.keepPathsOf(raw), studioStateShape.keepPathsOf(raw), String(raw).slice(0, 40));
    }
  });

  it("has the same time units", () => {
    assert.deepEqual(
      { second: seedTime.SECOND_MS, minute: seedTime.MINUTE_MS, hour: seedTime.HOUR_MS },
      { second: duration.SECOND_MS, minute: duration.MINUTE_MS, hour: duration.HOUR_MS },
    );
  });
});

describe("project facts (shared/project-facts.ts ↔ loop/folder-facts.ts)", () => {
  it("reads a fact an enabled plugin's detect found by the source the app writes", () => {
    const source = pluginFactSource("toys");
    assert.ok(source.startsWith(seedFolderFacts.PLUGIN_FACT_SOURCE_PREFIX));
    for (const other of Object.values(FactSource))
      assert.ok(!other.startsWith(seedFolderFacts.PLUGIN_FACT_SOURCE_PREFIX), other);
  });

  it("the seed's fact ids and served facts are the app's", () => {
    assert.deepEqual(seedFolderFacts.CoreFact, CoreFact);
    const at = (id: string, path: string) => ({ id, path, source: FactSource.Core });
    const linked = { kind: GameEngine.Unreal, project: "/p/A.uproject", linkedAt: "" } as const;
    const toyLinked = { kind: "toy-engine", project: "/p/A.toyproj", linkedAt: "" };
    assert.deepEqual(seedFolderFacts.FolderHolds, FolderHolds);
    // Each descriptor beside the facts the app lists for the same folder, and whether both serve it
    // as a web game: only one with no kind yet or one holding a web game at its root is.
    const table: Array<[string, seedFolderFacts.FactsOfDescriptor & object, FactRef[], boolean]> = [
      ["a game with no kind yet", { facts: [] }, [], true],
      ["an empty folder", { facts: [], holds: FolderHolds.Nothing }, [], true],
      ["a folder of notes", { facts: [], holds: FolderHolds.Notes }, [], true],
      ["a folder of its own files of a kind no rule knows", { facts: [], holds: FolderHolds.OwnFiles }, [], false],
      ["a folder that can't be read", { facts: [], holds: FolderHolds.Unreadable }, [], false],
      ["a web game", { facts: [at(CoreFact.WebGame, ".")] }, [at(CoreFact.WebGame, ".")], true],
      [
        "an Unreal project with a site",
        { facts: [at(CoreFact.WebGame, "site"), at(CoreFact.UnrealProject, ".")] },
        [at(CoreFact.WebGame, "site"), at(CoreFact.UnrealProject, ".")],
        false,
      ],
      ["an older descriptor", {}, [at(CoreFact.WebGame, ".")], true],
      ["an older linked one", { engine: linked }, [at(CoreFact.UnrealProject, ".")], false],
      ["an older one linked to another engine", { engine: toyLinked }, [at("toy-project", ".")], false],
      ["an older folder with no web page (a Godot one, say)", { web: false }, [at(CoreFact.GodotProject, ".")], false],
    ];
    for (const [name, descriptor, facts, web] of table) {
      const kind = { facts, holds: descriptor.holds ?? undefined };
      assert.equal(servedAsWebGame(kind), web, `${name}: the app serves it as web`);
      assert.equal(seedFolderFacts.servedAsWeb(descriptor), web, `${name}: the seed serves it as web`);
      assert.equal(seedFolderFacts.kindPending(descriptor), kindPending(kind), `${name}: kind pending`);
      if ("facts" in descriptor)
        assert.equal(seedFolderFacts.kindUnknown(descriptor), kindUnknown(kind), `${name}: kind unknown`);
      // A descriptor that carries its facts is served by the same facts (an older one by its older fields).
      if ("facts" in descriptor)
        assert.deepEqual(
          seedFolderFacts.servedFactsOf(descriptor),
          servedFacts(kind).map(({ id, path }) => ({ id, path })),
          `${name}: served facts`,
        );
    }
    assert.deepEqual(seedFolderFacts.FACT_ROOT, ".", "the root as a fact's path spells it");
    for (const engine of Object.values(GameEngine))
      assert.deepEqual(
        seedFolderFacts.factsOfEngine(engine),
        factsOfEngine(engine).map(({ id, path }) => ({ id, path })),
        `${engine}: the facts an engine stands for`,
      );
  });

  it("picks a Loop's profile from the folder's facts as the app does", () => {
    assert.deepEqual(seedFolderFacts.LoopProfile, LoopProfile);
    assert.deepEqual([...seedFolderFacts.WEB_LOOP_FACTS].sort(), [...WEB_LOOP_FACTS].sort());
    const at = (id: string, where: string) => ({ id, path: where });
    const { Web, Open } = LoopProfile;
    const table: Array<[string, { facts: FactRef[]; holds?: FolderHolds }, LoopProfile]> = [
      ["no kind yet", { facts: [] }, Web],
      ["its own files of a kind no rule knows", { facts: [], holds: FolderHolds.OwnFiles }, Open],
      ["a web game", { facts: [at(CoreFact.WebGame, ".")] }, Web],
      ["a web game with a second site", { facts: [at(CoreFact.WebGame, "."), at(CoreFact.WebGame, "site")] }, Web],
      [
        "a web game holding Blender files",
        { facts: [at(CoreFact.WebGame, "."), at(CoreFact.BlenderAssets, "assets")] },
        Web,
      ],
      ["a site in a subfolder only", { facts: [at(CoreFact.WebGame, "site")] }, Open],
      ["an Unreal project", { facts: [at(CoreFact.UnrealProject, ".")] }, Open],
      [
        "a web game with an Unreal project linked in",
        { facts: [at(CoreFact.WebGame, "."), at(CoreFact.UnrealProject, "unreal")] },
        Open,
      ],
      [
        "an Unreal project with a site",
        { facts: [at(CoreFact.UnrealProject, "."), at(CoreFact.WebGame, "site")] },
        Open,
      ],
      ["a Godot project", { facts: [at(CoreFact.GodotProject, ".")] }, Open],
      ["a plugin's kind", { facts: [at("toy-project", ".")] }, Open],
      ["Blender files alone", { facts: [at(CoreFact.BlenderAssets, ".")] }, Open],
      ["an Unreal plugin", { facts: [at(CoreFact.UnrealPlugin, ".")] }, Open],
    ];
    for (const [name, game, profile] of table) {
      assert.equal(loopProfileOf(game), profile, `${name}: the app's profile`);
      assert.equal(seedFolderFacts.loopProfileOf(game), profile, `${name}: the seed's profile`);
    }
  });

  it("the seed's starters and project tool names are the app's", () => {
    assert.deepEqual(seedFolderFacts.ProjectStarter, ProjectStarter);
    assert.deepEqual(seedFolderFacts.ProjectTool, ProjectTool);
  });

  it("the capabilities the seed claims when its parts serve them are the app's", () => {
    assert.equal(CHAT_JUDGE_CAPABILITY, HarnessCapability.ChatJudge);
    assert.equal(LOCAL_ROLES_CAPABILITY, HarnessCapability.LocalRoles);
  });

  it("names an engine's judge in judge_play by the argument the host reads, for a direct model and a Loop lead alike", async () => {
    const judges = [{ id: "crowd", label: "Crowd" }];
    const keys = (spec: { parameters?: { properties?: Record<string, unknown> } } | undefined) =>
      Object.keys(spec?.parameters?.properties ?? {}).sort();
    const hostTool = judgePlayToolWithJudges(judges);
    const [directTool] = (await import("../../src/harness-seed/tools/judge-tools.ts")).tools;
    assert.equal(directTool?.name, hostTool.name);
    assert.deepEqual(
      keys(directTool as never),
      keys(hostTool),
      "the direct model's tool takes the session's arguments",
    );
    assert.deepEqual(keys(seedEngineJudges.judgePlaySpec(judges)), keys(hostTool), "so does a Loop lead's");
    assert.equal(seedEngineJudges.servesEngineJudges(), true, "the shipped judge modules hand the judge on");
  });
});

describe("a lead's sub-agent tools (bundled plugins ↔ loop/unreal/lead-contract.ts)", () => {
  const { AgentKind, AGENT_TOOL_ALLOW } = seedUnrealLead;
  const agentNames = (manifest: { id: string; tools?: Array<{ name: string }> }) =>
    (manifest.tools ?? []).map((tool) => `${manifest.id}__${tool.name}`);
  const allows = (kind: seedUnrealLead.AgentKind, name: string) =>
    AGENT_TOOL_ALLOW[kind].some((entry) => name.startsWith(entry));

  it("names only tools the bundled plugins have, by their agent names", () => {
    const bundled = [blenderManifest, genexManifest, unrealManifest].flatMap(agentNames);
    // A renamed plugin or tool fails here, not in a run.
    for (const entry of Object.values(AGENT_TOOL_ALLOW).flat())
      assert.ok(
        bundled.some((name) => name.startsWith(entry)),
        entry,
      );
    const offered: Array<[seedUnrealLead.AgentKind, string]> = [
      [AgentKind.BlenderModel, `${blenderManifest.id}__model`],
      [AgentKind.BlenderPrep, `${blenderManifest.id}__model`],
      [AgentKind.GenexCast, `${genexManifest.id}__asset`],
      [AgentKind.GenexCast, `${blenderManifest.id}__model`],
      [AgentKind.Sound, `${genexManifest.id}__asset`],
      [AgentKind.Texture, `${genexManifest.id}__asset`],
      [AgentKind.Cpp, `${unrealManifest.id}__check-part`],
    ];
    for (const [kind, name] of offered) assert.equal(allows(kind, name), true, `${kind} ${name}`);
  });

  it("never offers any kind the user's editor, publishing, a CLI or the Unreal plugin's other tools", () => {
    const never = [
      "unreal-editor__call_tool",
      "unreal-editor__list_toolsets",
      "unreal-editor__describe_toolset",
      ...["publish", "publish-status", "cli", "cli-paid", "package"].map((tool) => `${genexManifest.id}__${tool}`),
      ...agentNames(unrealManifest).filter((name) => name !== `${unrealManifest.id}__check-part`),
    ];
    for (const kind of Object.values(AgentKind))
      for (const name of never) assert.equal(allows(kind, name), false, `${kind} ${name}`);
  });
});

describe("the Unreal plugin's harness tools a save asks (plugins/unreal ↔ the seed's and the app's names)", () => {
  const harness = new Set(
    (unrealManifest.tools as Array<{ name: string; audience?: string }>)
      .filter((tool) => tool.audience === "harness")
      .map((tool) => `${unrealManifest.id}__${tool.name}`),
  );

  it("names the lead's tools as the plugin does, each a harness tool of its manifest", () => {
    const named = Object.fromEntries(
      Object.entries(LeadLoopToolName).map(([key, tool]) => [key, `${unrealManifest.id}__${tool}`]),
    );
    assert.deepEqual(seedLeadPluginTool, named);
    for (const name of Object.values(seedLeadPluginTool)) assert.ok(harness.has(name), name);
  });
});

describe("skill edits (shared/skill-edits.ts ↔ loop/skills.ts)", () => {
  const skill =
    "---\nname: pacing\ndescription: keep it moving\n---\n# Pacing\nShort rounds.\n<!-- SLOW_UPDATE -->\nNever touch this.\n<!-- SLOW_UPDATE -->\nTail.\n";
  const edits: unknown[][] = [
    SKILL_EDIT_OPS.map((op) => ({ op, anchor: "Short rounds.", text: "Shorter." })),
    [{ op: "append", text: "- one more rule" }, { op: "append" }],
    [
      { op: "insert_after", anchor: "# Pacing", text: "Lead line." },
      { op: "insert_after", text: "no anchor" },
      { op: "insert_after", anchor: "  ", text: "blank" },
    ],
    [
      { op: "replace", anchor: "Never touch this.", text: "x" },
      { op: "delete", anchor: "Never" },
      { op: "insert_after", anchor: "Never touch", text: "y" },
    ],
    [
      { op: "replace", anchor: "missing", text: "x" },
      { op: "delete", anchor: "Tail." },
      { op: "rename", anchor: "Tail." },
    ],
    [
      { op: "replace", anchor: "Short rounds.", text: 42 },
      { op: "insert_after", anchor: "# Pacing" },
    ],
  ];
  for (const list of edits) {
    it(`replays ${JSON.stringify(list).slice(0, 80)} as the harness applied it`, () => {
      assert.deepEqual(applyEdits(skill, list), seedSkills.applyEdits(skill, list as never));
    });
  }
});

describe("run budgets (shared/run-state.ts ↔ loop/chat-dispatch.ts)", () => {
  it("reads the Loop back as the seed recorded it: ∞ as until satisfied, hours as hours", () => {
    assert.deepEqual(recordedRunLoop(seedChatDispatch.intakeBudgets({ hours: 24, untilSatisfied: true })), {
      hours: null,
    });
    assert.deepEqual(recordedRunLoop(seedChatDispatch.intakeBudgets({ hours: 1 })), { hours: 1 });
  });
});

/**
 * The seed's copy of the C++ · raylib contract (`loop/native-contract.ts`): the same stacks,
 * destinations, host matrix and judging target, the same native run vocabularies and constants,
 * and the same verdict on every reply the host checks.
 */
describe("the C++ · raylib contract (shared/game-project.ts, game-targets.ts, native-contract.ts ↔ loop/native-contract.ts)", () => {
  it("names the same stacks, destinations, kinds, hosts and refusals", () => {
    assert.deepEqual(seedNative.GameStack, GameStack);
    assert.deepEqual(seedNative.BuildTarget, BuildTarget);
    assert.deepEqual(seedNative.ProjectKind, ProjectKind);
    assert.deepEqual(seedNative.StudioPlatform, StudioPlatform);
    assert.deepEqual(seedNative.TargetRefusal, TargetRefusal);
    assert.deepEqual(seedNative.HOST_MATRIX, HOST_MATRIX);
  });

  it("both copies know the Rust · wgpu stack and kind, the mobile destinations and the per-stack tables", () => {
    for (const copy of [{ GameStack, BuildTarget, ProjectKind }, seedNative]) {
      assert.equal(copy.GameStack.RustWgpu, "rust-wgpu");
      assert.equal(copy.ProjectKind.RustWgpu, "rust-wgpu");
      assert.equal(copy.BuildTarget.Ios, "ios");
      assert.equal(copy.BuildTarget.Android, "android");
    }
    assert.deepEqual(seedNative.STACK_OF_KIND, STACK_OF_KIND);
    assert.deepEqual(seedNative.STACK_TARGETS, STACK_TARGETS);
    assert.deepEqual(seedNative.STACK_HOST_MATRIX, STACK_HOST_MATRIX);
    assert.deepEqual(seedNative.STACK_TARGETS[seedNative.GameStack.RustWgpu], ALL_BUILD_TARGETS);
  });

  it("both copies name the phone artifacts, and the harness makes only the Simulator app and the dev APK (M5.0)", () => {
    assert.deepEqual(seedNative.MobileArtifact, MobileArtifact);
    assert.deepEqual(seedNative.HARNESS_MOBILE_ARTIFACTS, HARNESS_MOBILE_ARTIFACTS);
    assert.equal(seedNative.HARNESS_MOBILE_ARTIFACTS.includes(seedNative.MobileArtifact.Ipa), false);
    assert.equal(seedNative.HARNESS_MOBILE_ARTIFACTS.includes(seedNative.MobileArtifact.Aab), false);
  });

  it("both copies build Rust's Windows and Linux destinations on a Mac and on the Linux Studio, nothing on Windows", () => {
    for (const matrix of [STACK_HOST_MATRIX, seedNative.STACK_HOST_MATRIX]) {
      const rust = matrix[GameStack.RustWgpu];
      for (const host of [StudioPlatform.Mac, StudioPlatform.Linux]) {
        const builds: readonly string[] = rust[host].build;
        assert.ok(builds.includes(BuildTarget.Windows) && builds.includes(BuildTarget.Linux), host);
      }
      assert.deepEqual(rust[StudioPlatform.Linux].run, [BuildTarget.Web]);
      assert.deepEqual(rust[StudioPlatform.Windows].build, []);
    }
  });

  it("refuses the same Rust-era cases in both copies: an unsupported kind, a gated stack, an offline toolchain", () => {
    for (const copy of [native.NativeRefusal, seedNative.NativeRefusal]) {
      assert.equal(copy.KindUnsupported, TargetRefusal.KindUnsupported);
      assert.equal(copy.StackGated, TargetRefusal.StackGated);
      assert.equal(copy.ToolchainOffline, TargetRefusal.ToolchainOffline);
    }
  });

  it("picks the same judging target for every destination set, host and game box", () => {
    for (let mask = 1; mask < 1 << BUILD_TARGETS.length; mask++) {
      const targets = BUILD_TARGETS.filter((_, index) => (mask & (1 << index)) !== 0);
      const destinations = { stack: stackForTargets(targets), targets };
      for (const host of [StudioPlatform.Mac, StudioPlatform.Windows, StudioPlatform.Linux])
        for (const gameBox of [false, true])
          assert.deepEqual(
            seedNative.judgingTarget(destinations, host, { gameBox }),
            judgingTarget(destinations, host, { gameBox }),
            `${targets.join("+")} on ${host}, gameBox ${gameBox}`,
          );
    }
  });

  it("holds the same op arguments and results, admission facts and typed-probe answers", () => {
    // Each pair must be assignable both ways; a field one copy lacks fails the typecheck here.
    const args: Same<native.NativeOpArgs, seedNative.NativeOpArgs> = true;
    const results: Same<native.NativeOpResults, seedNative.NativeOpResults> = true;
    const admission: Same<native.NativeAdmissionFacts, seedNative.NativeAdmissionFacts> = true;
    const witness: Same<WitnessResult, seedNative.WitnessResult> = true;
    const emptyScene: Same<EmptySceneResult, seedNative.EmptySceneResult> = true;
    const cameraPose: Same<CameraPoseResult, seedNative.CameraPoseResult> = true;
    const input: Same<native.NativeInputAction, seedNative.NativeInputAction> = true;
    const safeArea: Same<native.NativeSafeArea, seedNative.NativeSafeArea> = true;
    const stateV2: Same<native.NativeStateV2, seedNative.NativeStateV2> = true;
    assert.deepEqual(
      [args, results, admission, witness, emptyScene, cameraPose, input, safeArea, stateV2],
      Array(9).fill(true),
    );
  });

  it("names the same render vocabulary and ranges as shared/render-quality.ts (renderSettings, volatile.render)", () => {
    for (const name of [
      "QualityPreset",
      "FormFactor",
      "PerformanceTier",
      "DeviceClass",
      "RenderFeature",
      "DegradeReason",
      "SettingsSource",
      "CaptureExposure",
      "RendererFeature",
      "RenderInput",
      "RenderSettingsRefusal",
      "EFFECTIVE_PRESETS",
      "RENDER_SCALE_MIN",
      "RENDER_SCALE_MAX",
      "FRAME_BUDGET_MS_MIN",
      "FRAME_BUDGET_MS_MAX",
      "CAPTURE_SETTLE_FRAMES_MAX",
    ] as const)
      assert.deepEqual(seedNative[name], renderQuality[name], name);
    const settingsChange: Same<renderQuality.RenderSettingsChange, seedNative.RenderSettingsChange> = true;
    const settingsAnswer: Same<renderQuality.RenderSettingsAnswer, seedNative.RenderSettingsAnswer> = true;
    const status: Same<renderQuality.RenderStatus, seedNative.RenderStatus> = true;
    const provenance: Same<renderQuality.CaptureProvenance, seedNative.CaptureProvenance> = true;
    assert.deepEqual([settingsChange, settingsAnswer, status, provenance], [true, true, true, true]);
    assert.equal(seedNative.NativeOp.RenderSettings, "renderSettings");
    assert.equal(seedNative.NATIVE_RENDER_KEY, "render");
  });

  it("names the same custom pass stages, post-hdr and after-prepass among them (custom-pass API v2)", () => {
    assert.deepEqual(seedNative.CustomPassStage, native.CustomPassStage);
    assert.equal(native.CustomPassStage.PostHdr, "post-hdr");
    assert.equal(native.CustomPassStage.AfterPrepass, "after-prepass");
    assert.deepEqual(Object.values(native.CustomPassStage), [
      "before-cull",
      "after-opaque",
      "after-transparent",
      "post",
      "post-hdr",
      "after-prepass",
    ]);
    for (const copy of [native, seedNative]) {
      assert.equal(copy.NATIVE_EXTENSION_API_VERSION, 2);
      assert.equal(copy.NATIVE_CUSTOM_PASS_API_VERSION, 2);
    }
  });

  it("names the same game conformance checks (M7.0)", () => {
    assert.deepEqual(seedNative.ConformanceCheck, conformance.ConformanceCheck);
    assert.deepEqual(Object.values(seedNative.ConformanceCheck), [...conformance.CONFORMANCE_CHECKS]);
  });

  it("names the same native run vocabularies", () => {
    for (const name of [
      "NativeOp",
      "NativeEvent",
      "NativeRunMode",
      "NativeInputKind",
      "NativeGamepadFamily",
      "NativeBackend",
      "NativeRunState",
      "NativeRefusal",
      "NativeLifecycle",
      "NativeEnhancedFeature",
      "NativeGpuTier",
      "NATIVE_PROTOCOL_VERSIONS",
      "NATIVE_WGPU_BACKENDS",
      "BakeKind",
      "ReloadRefusal",
    ] as const)
      assert.deepEqual(seedNative[name], native[name], name);
  });

  it("both copies declare the profile op and the crash event, with frame-profile's actions and timing modes (PROF-0c)", () => {
    for (const copy of [native, seedNative]) {
      assert.equal(copy.NativeOp.Profile, "profile");
      assert.equal(copy.NativeEvent.Crash, "crash");
    }
    assert.deepEqual(seedNative.FrameProfileAction, frameProfile.FrameProfileAction);
    assert.deepEqual(seedNative.GpuTimingMode, frameProfile.GpuTimingMode);
  });

  it("both copies declare the saves and uiSettings ops with game-saves' codes, caps and argument shapes (UIS-15)", () => {
    for (const copy of [native, seedNative]) {
      assert.equal(copy.NativeOp.Saves, "saves");
      assert.equal(copy.NativeOp.UiSettings, "uiSettings");
    }
    for (const name of [
      "SaveOp",
      "SaveErrorCode",
      "SAVE_RESTORE_DIVERGED",
      "TextErrorCode",
      "SAVE_SLOT_NAME_MAX",
      "SAVE_LABEL_CHARS_MAX",
      "NATIVE_SAVES_ENVELOPE_MAX_BYTES",
      "UI_LOCALE_TAG_CHARS_MAX",
      "UI_SCALE_MIN",
      "UI_SCALE_MAX",
      "UI_TEXT_SIZE_MIN",
      "UI_TEXT_SIZE_MAX",
      "UI_SAFE_AREA_MAX_PX",
    ] as const)
      assert.deepEqual(seedNative[name], gameSaves[name], name);
    const savesArg: Same<gameSaves.SavesArg, seedNative.SavesArg> = true;
    const uiSettingsArg: Same<gameSaves.UiSettingsArg, seedNative.UiSettingsArg> = true;
    assert.deepEqual([savesArg, uiSettingsArg], [true, true]);
  });

  it("both copies read the page's audio() answer alike: available beside the game's level (AU-9)", () => {
    const answer: Same<native.NativeAudioAnswer, seedNative.NativeAudioAnswer> = true;
    assert.equal(answer, true);
    const heard = { available: true, rms: 0.0886, centroid: 459 };
    const candidates: unknown[] = [
      undefined,
      null,
      {},
      heard,
      { available: true, rms: 0, centroid: 0 },
      { available: false, rms: 0, centroid: 0 },
      // A page from before the level probe: a level with no `available` is not an answer.
      { rms: 0.1, centroid: 900 },
      { available: "yes", rms: 0.1, centroid: 900 },
      { available: true, rms: Number.NaN, centroid: 900 },
      { available: true, rms: 0.1, centroid: Number.POSITIVE_INFINITY },
      { available: true, rms: -0.1, centroid: 900 },
      { available: true, rms: 0.1 },
      { __missing: true },
    ];
    for (const value of candidates) {
      const label = JSON.stringify(value);
      assert.equal(seedNative.isNativeAudioAnswer(value), native.isNativeAudioAnswer(value), label);
      assert.equal(seedNative.isNativeAudioMeasured(value), native.isNativeAudioMeasured(value), label);
    }
    assert.equal(native.isNativeAudioMeasured(heard), true);
    assert.equal(native.isNativeAudioAnswer({ available: false, rms: 0, centroid: 0 }), true);
    assert.equal(native.isNativeAudioMeasured({ available: false, rms: 0, centroid: 0 }), false);
    assert.equal(native.isNativeAudioMeasured({ rms: 0.1, centroid: 900 }), false);
  });

  it("both copies declare the asset ops: bakeAssets of a nav or impostor bake, reloadAssets of named files", () => {
    for (const copy of [native, seedNative]) {
      assert.equal(copy.NativeOp.BakeAssets, "bakeAssets");
      assert.equal(copy.NativeOp.ReloadAssets, "reloadAssets");
      assert.deepEqual(copy.BakeKind, { Nav: "nav", Impostor: "impostor" });
      assert.deepEqual(Object.values(copy.ReloadRefusal), ["unsafe-path", "digest-mismatch", "missing"]);
    }
    for (const name of BAKE_NAME_CANDIDATES)
      assert.equal(seedNative.isBakeName(name), native.isBakeName(name), JSON.stringify(name));
  });

  it("both copies speak protocol 2 and still accept protocol 1", () => {
    for (const copy of [native, seedNative]) {
      assert.equal(copy.NATIVE_PROTOCOL_VERSION, 2);
      assert.equal(copy.NATIVE_PROTOCOL_V1, 1);
      for (const value of [0, 1, 2, 3, "2", null])
        assert.equal(copy.isNativeProtocolVersion(value), native.isNativeProtocolVersion(value), String(value));
    }
  });

  it("the refusals a destination shares are TargetRefusal's strings in both copies", () => {
    for (const copy of [native.NativeRefusal, seedNative.NativeRefusal]) {
      assert.equal(copy.NoGameBox, TargetRefusal.NoGameBox);
      assert.equal(copy.NotADestination, TargetRefusal.NotADestination);
      assert.equal(copy.NotRunnableHere, TargetRefusal.NotRunnableHere);
    }
  });

  it("holds the same constants", () => {
    // How the host assembles a Mac bundle, and how Live receives an embedded run's frames, are the
    // host's alone: the harness never builds a bundle or embeds a game.
    const hostOnly = new Set([
      "MAC_GAME_RPATH",
      "NATIVE_BUNDLE_APP",
      "NATIVE_FRAMES_ABI_VERSION",
      "NATIVE_FRAMES_WIRE_VERSION",
      "NATIVE_FRAME_BURST",
      "NATIVE_FRAME_SLOT_WATCHDOG_MS",
      "NATIVE_RESIZE_DEBOUNCE_MS",
      "NATIVE_FRAME_PIXELS_MAX",
      "NATIVE_FRAMES_RETIRED_MAX",
      "NATIVE_FRAMES_SERVICE_PREFIX",
      "NATIVE_NO_RUN_ID",
      // The receipt's size cap and the WGSL cap are checked by the host (the port's ready parser,
      // the lane's naga step); the harness reads a parsed receipt only.
      "NATIVE_RECEIPT_MAX_BYTES",
      "NATIVE_WGSL_MAX_BYTES",
      // A starting game's boot progress is read by the host for Live's card alone; the harness
      // never parses game events.
      "NATIVE_BOOT_COUNT_MAX",
      // The memory cap is the host's, from its own memory: the harness reads it off a run's status.
      "NATIVE_GAME_MEMORY_CAP_FLOOR_BYTES",
    ]);
    const shared = Object.entries(native).filter(
      ([name, value]) => /^(NATIVE|MAC)_/.test(name) && typeof value !== "object" && !hostOnly.has(name),
    );
    assert.ok(shared.length >= 20, "the scan found the constants");
    for (const [name, value] of shared)
      assert.equal((seedNative as Record<string, unknown>)[name], value, `${name} in the seed`);
  });

  it("gives every reply the host checks the same verdict", () => {
    // Every op against every shape: the replies one op accepts are what another refuses.
    const candidates: unknown[] = [
      undefined,
      null,
      0,
      "x",
      [],
      {},
      { seed: 1, paused: true },
      { seed: 1, paused: false },
      { running: true },
      { running: "yes" },
      { frame: 1, simulatedMs: 16, steppedFrames: 1, drawCalls: 3 },
      { frame: -1, simulatedMs: 16, steppedFrames: 1, drawCalls: 3 },
      { frame: 1, simulatedMs: Number.NaN, steppedFrames: 1, drawCalls: 3 },
      { held: ["KeyW"] },
      { held: [1] },
      { seq: 0, width: 64, height: 64, format: "bgra8", digest: "0123456789abcdef" },
      { seq: 0, width: 5000, height: 64, format: "bgra8", digest: "0123456789abcdef" },
      { seq: 0, width: 64, height: 64, format: "rgba8", digest: "0123456789abcdef" },
      { seq: 0, width: 64, height: 64, format: "bgra8", digest: "XYZ" },
      { ok: true, camera: "top" },
      { ok: false, available: ["default"] },
      { ok: "no" },
      { cameras: ["a"] },
      { eyes: [] },
      { demos: ["jump"] },
      { demos: [null] },
      { ok: true, demo: "jump", result: 1 },
      { muted: false },
      { rms: 0.1, centroid: 900 },
      { rms: Number.POSITIVE_INFINITY, centroid: 900 },
      { frameMs: 16, updateMs: 2, drawMs: 3, frames: 9 },
      { quitting: true },
      { fronted: true },
      { visible: false },
      { ring: [{ slot: 0, handleRef: "a" }] },
      { generation: 1, width: 1280, height: 720, slots: 3 },
      { generation: 0, width: 1280, height: 720, slots: 3 },
      { generation: 2 ** 32, width: 1280, height: 720, slots: 3 },
      { generation: 1, width: 4097, height: 720, slots: 3 },
      { generation: 1, width: 1280, height: 720, slots: 4 },
      { lifecycle: "resumed", safeArea: { top: 0, left: 0, bottom: 34, right: 0 } },
      { lifecycle: "suspended", safeArea: { top: 47, left: 0, bottom: 34, right: 0 }, phase: "play" },
      { lifecycle: "background", safeArea: { top: 0, left: 0, bottom: 0, right: 0 } },
      { lifecycle: "resumed" },
      { lifecycle: "resumed", safeArea: { top: -1, left: 0, bottom: 0, right: 0 } },
      { safeArea: { top: 0, left: 0, bottom: 0, right: 0 } },
      ...RENDER_REPLY_CANDIDATES,
      ...ASSET_REPLY_CANDIDATES,
      ...PROFILE_REPLY_CANDIDATES,
    ];
    for (const protocol of native.NATIVE_PROTOCOL_VERSIONS)
      for (const op of Object.values(native.NativeOp))
        for (const value of candidates)
          assert.equal(
            seedNative.isNativeResult(op, value, protocol),
            native.isNativeResult(op, value, protocol),
            `${op} v${protocol} ${JSON.stringify(value)}`,
          );
  });

  it("measures on a raylib game exactly the seed's own check kinds", () => {
    assert.deepEqual(Object.keys(seedNative.RAYLIB_CHECK_SUPPORT).sort(), Object.values(seedCheckKind).sort());
  });
});

describe("raylib creation retired (shared/game-project.ts ↔ loop/native-contract.ts)", () => {
  it("retires raylib creation in both copies: the same creatable stacks, refusal and implied stack for every destination set", () => {
    assert.deepEqual(seedNative.CREATABLE_STACKS, CREATABLE_STACKS);
    assert.deepEqual(seedNative.CreationRefusal, CreationRefusal);
    for (let mask = 1; mask < 1 << ALL_BUILD_TARGETS.length; mask++) {
      const targets = ALL_BUILD_TARGETS.filter((_, index) => (mask & (1 << index)) !== 0);
      for (const chosen of [undefined, ...Object.values(GameStack)]) {
        const implied = stackForTargets(targets, chosen);
        assert.equal(seedNative.stackForTargets(targets, chosen), implied, `${targets.join("+")} ${chosen}`);
        assert.notEqual(implied, GameStack.RaylibCpp, `${targets.join("+")} ${chosen}`);
      }
    }
  });
});

describe("the parts a Rust night runs (loop/run-dispatch.ts RUST_PARTS ↔ substrate/seed-upgrade.ts RUST_NIGHT_PARTS)", () => {
  /** The modules a Rust night runs that a raylib night does not (the play script for its touches). */
  const RUST_ONLY = ["loop/native-loop.ts", "loop/native-evidence.ts", "loop/native-review.ts", "loop/play-script.ts"];
  /** The chat launcher checks its own parts before it launches a night (chat-dispatch.ts), so the start does not list it. */
  const LAUNCHER = "loop/chat-dispatch.ts";

  it("names the modules the host reads for SERVES_RUST, the chat launcher aside", () => {
    const seedParts = Object.keys(seedRunDispatch.RUST_PARTS);
    assert.equal(new Set(seedParts).size, seedParts.length, "each part once");
    assert.deepEqual([...seedParts, LAUNCHER].sort(), [...RUST_NIGHT_PARTS].sort());
  });

  it("holds under each name that module itself, and its own marks under its own name", async () => {
    for (const [rel, part] of Object.entries(seedRunDispatch.RUST_PARTS)) {
      if (rel === "loop/run-dispatch.ts") {
        assert.equal(part.SERVES_RUST, true, "the start says it serves Rust nights");
        assert.equal(part.SERVES_NATIVE, true, "and raylib nights");
        continue;
      }
      const loaded: unknown = await import(`../../src/harness-seed/${rel}`);
      assert.equal(part, loaded, `${rel} holds its own module`);
    }
  });

  it("the shipped seed serves a Rust night: every part carries SERVES_RUST, and a lease declares rust-wgpu", () => {
    const missing = Object.entries(seedRunDispatch.RUST_PARTS)
      .filter(([, part]) => part.SERVES_RUST !== true)
      .map(([rel]) => rel);
    assert.deepEqual(missing, [], "every part a Rust night runs serves one");
    assert.equal(seedNative.servesRust(Object.values(seedRunDispatch.RUST_PARTS)), true);
    assert.ok(seedNative.servedStacks().includes(seedNative.GameStack.RustWgpu), "a lease declares rust-wgpu");
    const rust = { name: "ferris", shape: { kind: ProjectKind.RustWgpu } };
    assert.equal(
      seedRunDispatch.loopRunRefusal(rust, [], undefined, {
        servesRust: seedNative.servesRust(Object.values(seedRunDispatch.RUST_PARTS)),
      }),
      null,
    );
  });

  it("holds the per-stack command timeout equal to the app's (shared/toolchain.ts)", () => {
    assert.deepEqual({ ...seedGameToolsTable }, { ...COMMAND_TIMEOUT_MS });
  });

  it("is every part a raylib night runs, plus the native loop, evidence and review", () => {
    for (const rel of RUST_ONLY) assert.ok(Object.hasOwn(seedRunDispatch.RUST_PARTS, rel), rel);
    for (const [rel, part] of Object.entries(seedRunDispatch.RUST_PARTS))
      if (!RUST_ONLY.includes(rel)) assert.equal(part.SERVES_NATIVE, true, `${rel} is a raylib night's part`);
  });

  it("refuses a Rust night by its code when a part lacks SERVES_RUST, and no other night", () => {
    const rust = { name: "ferris", shape: { kind: ProjectKind.RustWgpu } };
    const refused = seedRunDispatch.rustNightRefusal(rust, false);
    assert.equal(refused?.code, seedNative.NativeNightRefusal.RustPartsMissing);
    assert.equal(seedLaunchRefusalCode(refused), "rust-parts-missing", "a launch reads it as its typed refusal");
    assert.equal(seedRunDispatch.rustNightRefusal(rust, true), null);
    for (const kind of [ProjectKind.RaylibCpp, ProjectKind.ThreeVite, ProjectKind.StudioTemplate])
      assert.equal(seedRunDispatch.rustNightRefusal({ name: "pong", shape: { kind } }, false), null, kind);
    assert.equal(seedRunDispatch.loopRunRefusal(rust, [], undefined, { servesRust: false }), refused?.message);
    assert.equal(seedRunDispatch.loopRunRefusal(rust, [], undefined, { servesRust: true }), null);
    assert.equal(seedRunDispatch.loopRunRefusal(rust, []), null, "absent, the caller checked nothing");
  });

  it("a lease declares the stacks the harness serves: Rust only once every part a Rust night runs says so", async () => {
    const { GameStack: Stack } = seedNative;
    assert.deepEqual(seedNative.stacksServed({ native: true, rust: false }), [Stack.ThreeJs, Stack.RaylibCpp]);
    assert.deepEqual(seedNative.stacksServed({ native: true, rust: true }), [
      Stack.ThreeJs,
      Stack.RaylibCpp,
      Stack.RustWgpu,
    ]);
    assert.deepEqual(seedNative.stacksServed({ native: false, rust: false }), [Stack.ThreeJs]);
    assert.equal(seedNative.servesRust([{ SERVES_RUST: true }, { SERVES_RUST: true }]), true);
    assert.equal(seedNative.servesRust([{ SERVES_RUST: true }, { SERVES_NATIVE: true }]), false);
    assert.equal(seedNative.servesRust([{ SERVES_RUST: "true" }]), false, "only the boolean mark counts");
    const sent: Array<{ stacks?: readonly string[] }> = [];
    const call: seedNative.AcquireCall = async (_method, params) => {
      sent.push(params);
      return { handle: "h1" };
    };
    const macOnly = { destinations: { stack: Stack.RaylibCpp, targets: [seedNative.BuildTarget.Mac] } };
    const onMac = { host: seedNative.StudioPlatform.Mac, native: { gameBox: true } };
    await seedNative.acquireFor(call, macOnly, onMac);
    const declared = seedNative.servedStacks();
    assert.deepEqual(sent[0]?.stacks, declared);
    assert.equal(declared.includes(Stack.RaylibCpp), true);
    const rustServed = seedNative.servesRust(Object.values(seedRunDispatch.RUST_PARTS));
    assert.equal(declared.includes(Stack.RustWgpu), rustServed, "Rust is declared exactly when its parts serve it");
  });

  it("measures check kinds per stack: raylib's row is RAYLIB_CHECK_SUPPORT, three.js every kind, Rust no scene graph", () => {
    const { CheckSupport, GameStack: Stack, STACK_CHECK_SUPPORT } = seedNative;
    assert.deepEqual(Object.keys(STACK_CHECK_SUPPORT).sort(), Object.values(Stack).sort());
    for (const row of Object.values(STACK_CHECK_SUPPORT))
      assert.deepEqual(Object.keys(row).sort(), Object.values(seedCheckKind).sort());
    assert.deepEqual(STACK_CHECK_SUPPORT[Stack.RaylibCpp], seedNative.RAYLIB_CHECK_SUPPORT);
    assert.ok(Object.values(STACK_CHECK_SUPPORT[Stack.ThreeJs]).every((support) => support === CheckSupport.Measured));
    assert.equal(STACK_CHECK_SUPPORT[Stack.RustWgpu][seedCheckKind.Scene], CheckSupport.Unmeasured);
    assert.equal(seedNative.checkSupportFor(Stack.RustWgpu, seedCheckKind.Pixel), CheckSupport.Measured);
    assert.equal(seedNative.checkSupportFor(Stack.RaylibCpp, seedCheckKind.Scene), CheckSupport.Unmeasured);
  });
});

describe("how many workers a run may run (shared/builders.ts ↔ loop/director/budgets.ts)", () => {
  it("lets the lead run every worker the Maximum concurrent workers setting offers, and keeps the lead's own windows apart", async () => {
    const { LEAD_WINDOWS, MAX_BUILDERS, DEFAULT_BUILDERS } = await import("../../src/shared/builders.ts");
    const budgets = await import("../../src/harness-seed/loop/director/budgets.ts");
    assert.equal(budgets.MAX_WORKERS, MAX_BUILDERS, "no hidden cap below the setting's most");
    assert.ok(budgets.MAX_PLAN_WORKERS >= MAX_BUILDERS, "a plan can name a part for every worker");
    for (const builders of [1, DEFAULT_BUILDERS, MAX_BUILDERS])
      assert.equal(
        budgets.workerWindows(builders + LEAD_WINDOWS),
        builders,
        `${builders} builders in a pool of ${builders + LEAD_WINDOWS}`,
      );
  });
});

describe("where a run keeps its tracks (shared/game-history.ts ↔ loop/repo.ts)", () => {
  it("names every ref of a run under the root the app clears finished runs' tracks from", async () => {
    const { RUN_REFS } = await import("../../src/shared/game-history.ts");
    const repo = await import("../../src/harness-seed/loop/repo.ts");
    for (const ref of [
      repo.runRef("run_1", "integration"),
      repo.runRef("run_1", "worker", 2),
      repo.attemptRef("run_1", "f", 1),
    ])
      assert.ok(ref.startsWith(`${RUN_REFS}run_1/`), ref);
  });
});

describe("long processes the agents start (shared/jobs.ts ↔ loop/jobs/contract.ts)", () => {
  it("names the job states and tools as the app does", () => {
    assert.deepEqual(seedJobs.JobState, jobs.JobState);
    assert.deepEqual(seedJobs.JobStopper, jobs.JobStopper);
    assert.deepEqual(seedJobs.JobRole, jobs.JobRole);
    assert.deepEqual(seedJobs.JobTool, jobs.JobTool);
    assert.equal(seedJobs.APP_LOOK_TOOL_NAME, jobs.APP_LOOK_TOOL_NAME);
  });
});

describe("one worker model (shared/workers.ts ↔ loop/workers/contract.ts)", () => {
  it("names the worker tools, isolations, verdicts and refusals as the app does", () => {
    assert.deepEqual(seedWorkers.WorkerTool, workers.WorkerTool);
    assert.deepEqual(seedWorkers.WorkerIsolation, workers.WorkerIsolation);
    assert.deepEqual(seedWorkers.WorkerVerdict, workers.WorkerVerdict);
    assert.equal(seedWorkers.MAX_WORKERS_AT_ONCE, workers.MAX_WORKERS_AT_ONCE);
    assert.equal(seedWorkers.WorkerRefusal.TooManyWorkers, DelegationRefusal.TooManyWorkers);
    assert.equal(seedWorkers.WorkerRefusal.CopyTooLarge, SnapshotRefusal.CopyTooLarge);
    assert.equal(seedWorkers.WORKER_QUESTION_EVENT, CustomEvent.ToolPermission);
    assert.equal(seedWorkers.WORKER_QUESTION_PENDING, ToolPermissionState.Pending);
    // A worker waits as long as the director's own wait may.
    assert.equal(seedWorkers.MAX_WORKER_WAIT_S, seedBudgets.MAX_WAIT_S);
    // The verdict the Unreal lead's agents are marked with is the worker verdict, value for value.
    assert.deepEqual({ ...seedUnrealLead.AgentVerdict }, { ...workers.WorkerVerdict });
    // A worker's start and end records, its end states, its pool id and the caps of its words.
    assert.deepEqual(
      { ...seedWorkers.WorkerEvent },
      { Started: CustomEvent.WorkerStarted, Finished: CustomEvent.WorkerFinished },
    );
    assert.deepEqual(seedWorkers.WorkerEnd, workers.WorkerEnd);
    assert.deepEqual(seedWorkers.WorkerStopCode, workers.WorkerStopCode);
    // Each end is a state the pool's records keep, by the same word.
    const { Done, Failed, Stopped } = seedWorkerRecords.WorkerState;
    assert.deepEqual({ ...workers.WorkerEnd }, { Done, Failed, Stopped });
    assert.equal(seedWorkers.POOL_WORKER_PREFIX, workers.POOL_WORKER_PREFIX);
    assert.equal(seedWorkers.WORKER_TASK_CHARS, workers.WORKER_TASK_CHARS);
    assert.equal(seedWorkers.WORKER_ASK_CHARS, workers.WORKER_ASK_CHARS);
    assert.equal(seedWorkers.WORKER_SUMMARY_CHARS, workers.WORKER_SUMMARY_CHARS);
    assert.equal(seedWorkers.WORKER_TITLE_CHARS, workers.WORKER_TITLE_CHARS);
    // Where an in-place worker works is a lock's label, as long as a label may be.
    assert.equal(seedWhere.WORKER_WHERE_CHARS, LOCK_LABEL_CHARS);
  });

  it("Plan holds the director's merge and its landing finish by the seed's own names and its own reading of land", () => {
    assert.equal(RunWriteTool.Integrate, seedDirectorTool.Integrate);
    assert.equal(RunWriteTool.Finish, seedDirectorTool.Finish);
    for (const land of [
      undefined,
      null,
      "",
      " ",
      "yes",
      "Y",
      "true",
      "1",
      "no",
      "n",
      "false",
      "0",
      "maybe",
      true,
      false,
    ])
      assert.equal(finishLands({ land }), seedYes(land, true), `land=${JSON.stringify(land)}`);
  });
});

describe("Genex's moments (shared/plugin-hooks.ts ↔ loop/hooks.ts)", () => {
  it("names the hook events, the blocking ones, checkpoint skips, Genex's holds and the label cap as the app does", async () => {
    const seed = await import("../../src/harness-seed/loop/hooks.ts");
    const app = await import("../../src/shared/plugin-hooks.ts");
    assert.deepEqual(seed.HookEvent, app.HookEvent);
    assert.deepEqual([...seed.SEED_FIRED_HOOK_EVENTS].sort(), [...app.SEED_FIRED_HOOK_EVENTS].sort());
    assert.deepEqual([...seed.BLOCKING_HOOK_EVENTS].sort(), [...app.BLOCKING_HOOK_EVENTS].sort());
    assert.deepEqual(seed.CheckpointSkip, app.CheckpointSkip);
    assert.equal(seed.HOOK_BLOCKED, app.HOOK_BLOCKED);
    assert.deepEqual(seed.HookHold, app.HookHold);
    assert.equal(seed.HOOK_LABEL_CHARS, app.HOOK_LABEL_CHARS);
  });

  it("tells an older host by the name the host refuses an unknown method with", async () => {
    const seed = await import("../../src/harness-seed/loop/hooks.ts");
    const { HostRefusal } = await import("../../src/shared/harness-api.ts");
    assert.equal(seed.UNKNOWN_METHOD, HostRefusal.UnknownMethod);
    assert.equal(seed.olderHost({ name: HostRefusal.UnknownMethod }), true);
    assert.equal(seed.olderHost({ name: HostRefusal.InvalidParams }), false);
  });
});

describe("a game's observers and a lead's claim (shared/observers.ts ↔ loop/finish-contract.ts)", () => {
  it("names the finish check's steps, its rejection and reason caps, the capture sources, the events and the lead call's deadline as the app does", async () => {
    const seed = await import("../../src/harness-seed/loop/finish-contract.ts");
    const app = await import("../../src/shared/observers.ts");
    const check = await import("../../src/shared/finish-check.ts");
    const { BRIDGE_TOOL_DEADLINE_MS } = await import("../../src/substrate/engines/studio-bridge.ts");
    assert.deepEqual({ ...seed.FinishCheckStep }, { ...check.FinishCheckStep });
    assert.equal(seed.MAX_FINISH_REJECTIONS, check.MAX_FINISH_REJECTIONS);
    assert.equal(seed.MAX_FINISH_REASONS, check.MAX_FINISH_REASONS);
    assert.equal(seed.FINISH_REASON_CHARS, check.FINISH_REASON_CHARS);
    assert.equal(seed.FINISH_TIME_LEFT_MS, check.FINISH_TIME_LEFT_MS);
    assert.deepEqual({ ...seed.StopWhy }, { ...check.StopWhy });
    assert.equal(seed.FINISH_CHECK_EVENT, CustomEvent.FinishCheck);
    assert.deepEqual({ ...seed.ObserverSource }, { ...app.ObserverSource });
    assert.equal(seed.PREVIEW_OBSERVER, app.PREVIEW_OBSERVER);
    assert.equal(seed.PROOF_OBSERVER, app.PROOF_OBSERVER);
    assert.equal(seed.OBSERVER_CAPTURE_EVENT, CustomEvent.ObserverCapture);
    // Everything a lead's finish does happens inside its one call, which the bridge cuts at this deadline.
    assert.equal(seed.LEAD_CALL_MS, BRIDGE_TOOL_DEADLINE_MS);
  });
});

describe("profile samples (shared/optimization.ts ↔ loop/performance.ts)", () => {
  it("names the same sample backends, a native run's among them (PROF-0c)", () => {
    assert.deepEqual(SeedSampleBackend, SampleBackend);
    assert.equal(SampleBackend.Native, "native");
  });
});
