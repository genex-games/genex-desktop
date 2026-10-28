/**
 * Usage analytics for builds, runs, Live, assets and engine projects (`analytics/events/builds.ts`,
 * `analytics/builds-stage.ts`): what a log record, one of main's events, a library change or a
 * stage press is sent as. Starts pair with their ends in memory and leave only durations; every
 * value is a code, a switch, a count, a duration or the game's random ref — never a title, a
 * task, a reason, a path, a name, a model or an id of the log's.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BLANK_AFTER_MS,
  blankSuspected,
  firstMessageAt,
  gameSays,
  liveShownProperties,
  nodeKindOf,
  planningEnded,
  pressOutcomeOf,
  RAPID_RELOAD_MS,
  reloadPressed,
  setupCardShown,
  setupPluginOf,
  setupStepChanges,
  setupStepId,
  type StepStates,
  stepStateOf,
} from "../../src/renderer/analytics/builds-stage.ts";
import {
  BuildMode,
  buildBroke,
  type BuildPolls,
  BuildsEvent,
  type BuildsMemory,
  type BuildsTracked,
  buildsLogEvents,
  buildsMemory,
  buildsUiEvents,
  firstBuildsMade,
  inventoryFailures,
  type JobPhases,
  jobPhaseChanges,
  LiveOutcome,
  LiveTrigger,
  NodeKind,
  PartTrouble,
  PlanningEnd,
  pluginRef,
  PressOutcome,
  RETRY_OF_FAILED_MS,
  SetupStepState,
  Unlisted,
} from "../../src/renderer/analytics/events/builds.ts";
import type { StepsCard } from "../../src/renderer/chat/engine-steps.ts";
import { GraphSelection } from "../../src/renderer/panels/inspector/selection.ts";
import { MakingKind, MakingPhase } from "../../src/shared/asset-making.ts";
import { AutoResumeCause, CustomEvent, customEventData, StopCode } from "../../src/shared/custom-events.ts";
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import { EngineFailureKind, StopReason } from "../../src/shared/engine-requests.ts";
import { type EventEnvelope, EventKind } from "../../src/shared/event-log.ts";
import { FinishCheckStep, StopWhy } from "../../src/shared/finish-check.ts";
import { JobRole, JobState } from "../../src/shared/jobs.ts";
import { LiveBehindReason } from "../../src/shared/live-behind.ts";
import { PluginSourceKind } from "../../src/shared/plugins.ts";
import { ReadyVia } from "../../src/shared/preview-contract.ts";
import { LoopProfile } from "../../src/shared/project-facts.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { ExecutionStatus, RoundOutcome, VerdictPass, VerdictRule } from "../../src/shared/run-state.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { WorkerEnd, WorkerIsolation, WorkerStopCode, WorkerVerdict } from "../../src/shared/workers.ts";

const T0 = Date.parse("2026-10-27T10:00:00.000Z");
const THREAD = "thread-a";
const REF = "0123456789abcdef";

let sequence = 0;
/** A log record of `thread`, `ms` after T0. */
function record(name: CustomEvent, payload: Record<string, unknown>, ms: number, thread = THREAD): EventEnvelope {
  sequence += 1;
  return {
    id: `ev-${sequence}`,
    thread_id: thread,
    session_id: null,
    turn_id: null,
    created_at: new Date(T0 + ms).toISOString(),
    data: customEventData(name, payload),
  };
}

/** Memory whose games all have one ref, and whose plugins are these. */
function memoryWith(plugins: BuildsMemory["plugins"] = () => []): BuildsMemory {
  const memory = buildsMemory();
  memory.gameRef = (name) => (name ? REF : null);
  memory.plugins = plugins;
  return memory;
}

/** Every event a run of records means, in order. */
const read = (memory: BuildsMemory, records: readonly EventEnvelope[]): BuildsTracked[] =>
  records.flatMap((entry) => buildsLogEvents(entry, memory));

const only = (found: readonly BuildsTracked[]): BuildsTracked => {
  assert.equal(found.length, 1, JSON.stringify(found));
  const [first] = found;
  assert.ok(first);
  return first;
};

describe("runs from the log", () => {
  it("sends a Loop's start once its autopilot_started says how it works, with its run_started's budgets", () => {
    const memory = memoryWith();
    const found = read(memory, [
      record(
        CustomEvent.RunStarted,
        { runId: "r1", project: "pong", engine: EngineId.Codex, budgets: { wallClockMs: 2 * HOUR_MS } },
        0,
      ),
      record(
        CustomEvent.AutopilotStarted,
        { runId: "r1", project: "pong", director: true, maxParallel: 3, facets: [], profile: LoopProfile.Open },
        5,
      ),
    ]);
    assert.deepEqual(only(found), {
      event: BuildsEvent.RunStarted,
      properties: {
        mode: BuildMode.Loop,
        loop_hours: 2,
        until_satisfied: false,
        completion_policy: null,
        director: true,
        facets: 0,
        max_parallel: 3,
        profile: LoopProfile.Open,
        resumed: false,
        engine: EngineId.Codex,
        previous_run_state: null,
        ms_since_previous_end: null,
        game_ref: REF,
      },
    });
  });

  it("pairs a pause with its automatic resume, and a close with the run before the next start", () => {
    const memory = memoryWith();
    read(memory, [
      record(CustomEvent.RunStarted, { runId: "r1", project: "pong", budgets: { untilSatisfied: true } }, 0),
      record(CustomEvent.AutopilotStarted, { runId: "r1", project: "pong" }, 0),
    ]);
    const paused = only(
      read(memory, [
        record(
          CustomEvent.RunFinished,
          {
            runId: "r1",
            project: "pong",
            executionStatus: ExecutionStatus.Paused,
            stopCode: StopCode.UsageLimit,
            limit: { kind: EngineFailureKind.UsageLimit, retryAfterMs: HOUR_MS, message: "You hit your limit" },
          },
          10 * MINUTE_MS,
        ),
      ]),
    );
    assert.equal(paused.event, BuildsEvent.RunFinished);
    assert.equal(paused.properties.execution_status, ExecutionStatus.Paused);
    assert.equal(paused.properties.stop_code, StopCode.UsageLimit);
    assert.equal(paused.properties.limit_kind, EngineFailureKind.UsageLimit);
    assert.equal(paused.properties.retry_after_ms, HOUR_MS);
    assert.equal(paused.properties.worked_ms, 10 * MINUTE_MS);

    const resumed = only(
      read(memory, [
        record(
          CustomEvent.RunAutoResumed,
          { runId: "r1", cause: AutoResumeCause.LimitReset, attempt: 1 },
          70 * MINUTE_MS,
        ),
      ]),
    );
    assert.deepEqual(resumed, {
      event: BuildsEvent.RunAutoResumed,
      properties: { cause: AutoResumeCause.LimitReset, attempt: 1, paused_ms: HOUR_MS },
    });

    const closed = only(
      read(memory, [
        record(CustomEvent.RunResumed, { runId: "r1" }, 70 * MINUTE_MS),
        record(
          CustomEvent.RunFinished,
          {
            runId: "r1",
            project: "pong",
            executionStatus: ExecutionStatus.Completed,
            stopCode: StopCode.Budget,
            landed: true,
            durationMs: 80 * MINUTE_MS,
            stillToFix: { done: ["a", "b"], notDone: ["c"], why: StopWhy.Time, hours: 1.5 },
            iterations: [{ winner: "challenger" }, { winner: "incumbent" }, { winner: "challenger" }],
            profile: LoopProfile.Web,
          },
          80 * MINUTE_MS,
        ),
      ]),
    );
    assert.deepEqual(closed.properties, {
      execution_status: ExecutionStatus.Completed,
      stop_code: StopCode.Budget,
      limit_kind: null,
      retry_after_ms: null,
      still_to_fix_why: StopWhy.Time,
      done_count: 2,
      not_done_count: 1,
      landed: true,
      victory: false,
      duration_ms: 80 * MINUTE_MS,
      worked_ms: 20 * MINUTE_MS,
      loop_hours: 1.5,
      rounds_accepted: 2,
      rounds_rejected: 1,
      profile: LoopProfile.Web,
      game_ref: REF,
    });

    const next = only(
      read(memory, [
        record(CustomEvent.RunStarted, { runId: "r2", project: "pong" }, 85 * MINUTE_MS),
        record(CustomEvent.AutopilotStarted, { runId: "r2", project: "pong" }, 85 * MINUTE_MS),
      ]),
    );
    assert.equal(next.event, BuildsEvent.RunStarted);
    assert.equal(next.properties.previous_run_state, ExecutionStatus.Completed);
    assert.equal(next.properties.ms_since_previous_end, 5 * MINUTE_MS);
  });

  it("a close of a run that started before this launch has no worked time", () => {
    const found = only(
      read(memoryWith(), [record(CustomEvent.RunFinished, { runId: "old", failure: { message: "x" } }, 0)]),
    );
    assert.equal(found.event, BuildsEvent.RunFinished);
    assert.equal(found.properties.execution_status, ExecutionStatus.Failed);
    assert.equal(found.properties.worked_ms, null);
  });

  it("counts a chat turn's first worker as a chat build's start, once per turn", () => {
    const memory = memoryWith();
    const found = read(memory, [
      record(CustomEvent.WorkerStarted, { workerId: "w1", turn: "m1", isolation: WorkerIsolation.Copy }, 0),
      record(CustomEvent.WorkerStarted, { workerId: "w2", turn: "m1" }, 1),
    ]);
    const started = only(found);
    assert.equal(started.event, BuildsEvent.RunStarted);
    assert.equal(started.properties.mode, BuildMode.ChatTurn);
  });

  it("sends a worker's end with how long it worked, and the lead's verdict on its own", () => {
    const memory = memoryWith();
    const found = read(memory, [
      record(
        CustomEvent.WorkerStarted,
        { runId: "r1", workerId: "w1", isolation: WorkerIsolation.Lock, in: "unreal" },
        0,
      ),
      record(
        CustomEvent.WorkerFinished,
        { runId: "r1", workerId: "w1", state: WorkerEnd.Failed, stopCode: WorkerStopCode.Error, delivered: false },
        90 * SECOND_MS,
      ),
      record(
        CustomEvent.WorkerFinished,
        { runId: "r1", workerId: "w1", verdict: WorkerVerdict.Rejected },
        91 * SECOND_MS,
      ),
    ]);
    assert.deepEqual(found, [
      {
        event: BuildsEvent.WorkerFinished,
        properties: {
          state: WorkerEnd.Failed,
          stop_code: WorkerStopCode.Error,
          isolation: WorkerIsolation.Lock,
          in: "unreal",
          delivered: false,
          in_game: false,
          ms: 90 * SECOND_MS,
          in_run: true,
        },
      },
      { event: BuildsEvent.WorkerJudged, properties: { verdict: WorkerVerdict.Rejected, merged: false, in_run: true } },
    ]);
  });

  it("times a finish check from its checking step to the reviewer's answer", () => {
    const memory = memoryWith();
    const found = read(memory, [
      record(CustomEvent.FinishCheck, { runId: "r1", round: 2, step: FinishCheckStep.Checking }, 0),
      record(
        CustomEvent.FinishCheck,
        {
          runId: "r1",
          round: 2,
          step: FinishCheckStep.Rejected,
          rejections: 2,
          notDone: ["x", "y"],
          done: ["z"],
          timeLeft: true,
          reviewer: { engine: EngineId.ClaudeCode, model: "my-model" },
        },
        45 * SECOND_MS,
      ),
    ]);
    assert.deepEqual(only(found).properties, {
      round: 2,
      step: FinishCheckStep.Rejected,
      rejections: 2,
      stopped: false,
      time_left: true,
      done_count: 1,
      not_done_count: 2,
      reviewer_engine: EngineId.ClaudeCode,
      ms_checking: 45 * SECOND_MS,
    });
  });

  it("reads a lead's health pass as a start check timed from its merge, and its other passes as rounds", () => {
    const memory = memoryWith();
    const found = read(memory, [
      record(CustomEvent.IntegrationMerge, { runId: "r1" }, 0),
      record(
        CustomEvent.DirectorVerdict,
        { runId: "r1", pass: VerdictPass.Health, decision: { kept: false, rule: VerdictRule.DoesNotStart } },
        12 * SECOND_MS,
      ),
      record(
        CustomEvent.DirectorVerdict,
        {
          runId: "r1",
          pass: VerdictPass.Judge,
          decision: { kept: true, rule: VerdictRule.JudgePreferred },
          measured: { planned: [{ pass: true }, { pass: false }], grown: [{ pass: true }] },
        },
        20 * SECOND_MS,
      ),
      record(
        CustomEvent.FacetIteration,
        { runId: "r1", winner: "incumbent", scoreboard: { passing: 3, total: 5 } },
        30,
      ),
    ]);
    assert.deepEqual(found, [
      {
        event: BuildsEvent.BuildHealthChecked,
        properties: { ok: false, rule: VerdictRule.DoesNotStart, ms_since_merge: 12 * SECOND_MS, problems_count: null },
      },
      {
        event: BuildsEvent.RunRoundJudged,
        properties: {
          outcome: RoundOutcome.Accepted,
          pass: VerdictPass.Judge,
          rule: VerdictRule.JudgePreferred,
          checks_passing: 2,
          checks_total: 3,
        },
      },
      {
        event: BuildsEvent.RunRoundJudged,
        properties: {
          outcome: RoundOutcome.Rejected,
          pass: VerdictPass.Round,
          rule: null,
          checks_passing: 3,
          checks_total: 5,
        },
      },
    ]);
  });

  it("names a part's trouble by its record, and the provider it lost only by kind", () => {
    const found = read(memoryWith(), [
      record(CustomEvent.FacetProviderOutage, { lost: EngineFailureKind.Auth, attempt: 2, error: "Bearer abc" }, 0),
      record(CustomEvent.FacetCircuitBreak, { reason: "three tries" }, 1),
    ]);
    assert.deepEqual(
      found.map((item) => item.properties),
      [
        { kind: PartTrouble.ProviderOutage, lost: EngineFailureKind.Auth, attempt: 2 },
        { kind: PartTrouble.CircuitBreak, lost: null, attempt: null },
      ],
    );
  });
});

describe("chat builds, jobs and plugin calls from the log", () => {
  it("reads a chat build's observation, a vendor's own stop reason as other", () => {
    const found = only(
      read(memoryWith(), [
        record(
          CustomEvent.BuildObservation,
          {
            ok: false,
            consoleErrors: 7,
            durationMs: 1000,
            turns: 4,
            stopReason: "error_max_turns",
            ready: { ready: false, via: ReadyVia.Shim, timedOut: true, pageTimedOut: false },
            observation: { frameAdvanced: false, running: null, studioMissing: true },
          },
          0,
        ),
      ]),
    );
    assert.equal(found.event, BuildsEvent.ChatBuildObserved);
    assert.equal(found.properties.stop_reason, Unlisted.Other);
    assert.equal(found.properties.console_errors, "6-20");
    assert.equal(found.properties.ready_via, ReadyVia.Shim);
    assert.equal(found.properties.ready_timed_out, true);
    const incomplete = only(
      read(memoryWith(), [record(CustomEvent.DelegationIncomplete, { stopReason: StopReason.MaxTurns }, 0)]),
    );
    assert.deepEqual(incomplete.properties, { stop_reason: StopReason.MaxTurns });
  });

  it("pairs a job's end with who started it", () => {
    const memory = memoryWith();
    const found = read(memory, [
      record(
        CustomEvent.JobStarted,
        { jobId: "j1", role: JobRole.Worker, title: "build", command: "npm run build" },
        0,
      ),
      record(
        CustomEvent.JobEnded,
        { jobId: "j1", state: JobState.Failed, exitCode: 2, durationMs: 5000, runId: "r1", tail: "error" },
        5000,
      ),
    ]);
    assert.deepEqual(only(found).properties, {
      state: JobState.Failed,
      stopped_by: null,
      role: JobRole.Worker,
      exit_nonzero: true,
      duration_ms: 5000,
      in_run: true,
    });
  });

  it("names a bundled plugin's call by its id, a local one only as local, and counts a quick retry of a failed kind", () => {
    const plugins = () => [
      { manifest: { id: "genex" }, source: PluginSourceKind.Bundled },
      { manifest: { id: "my-tools" }, source: PluginSourceKind.Local },
    ];
    const memory = memoryWith(plugins);
    const call = (pluginId: string, ok: boolean, ms: number) =>
      record(
        CustomEvent.PluginTool,
        { pluginId, ok, making: { kind: MakingKind.Character, tool: "tripo", prompt: "a knight" }, images: 2 },
        ms,
      );
    const found = read(memory, [
      call("genex", false, 0),
      call("genex", false, RETRY_OF_FAILED_MS - 1),
      call("my-tools", true, RETRY_OF_FAILED_MS),
    ]);
    assert.deepEqual(
      found.map((item) => {
        assert.equal(item.event, BuildsEvent.PluginToolFinished);
        return [item.properties.plugin_ref, item.properties.tool, item.properties.retry_of_failed];
      }),
      [
        ["genex", "tripo", false],
        ["genex", "tripo", true],
        [PluginSourceKind.Local, null, false],
      ],
    );
  });
});

describe("main's run events", () => {
  it("sends a reviewer's retry by kind, and a stop with the time the run worked", () => {
    const memory = memoryWith();
    read(memory, [record(CustomEvent.RunStarted, { runId: "r1" }, 0)]);
    const retry = buildsUiEvents(
      { type: UiEvent.JudgeRetry, payload: { kind: EngineFailureKind.RateLimit, attempt: 2, waitMs: 3000 } },
      memory,
      T0,
    );
    const stop = buildsUiEvents({ type: UiEvent.RunStopping, payload: { runId: "r1" } }, memory, T0 + MINUTE_MS);
    assert.deepEqual(retry, [
      {
        event: BuildsEvent.ReviewerRetried,
        properties: { kind: EngineFailureKind.RateLimit, attempt: 2, wait_ms: 3000 },
      },
    ]);
    assert.deepEqual(stop, [{ event: BuildsEvent.RunStopRequested, properties: { worked_ms: MINUTE_MS } }]);
  });
});

describe("the library", () => {
  it("sends a game's first build when it stops waiting for one", () => {
    const before = [{ name: "pong", awaitingFirstBuild: true as const }];
    const after = [{ name: "pong", createdAt: new Date(T0).toISOString() }];
    assert.deepEqual(firstBuildsMade(before, after, { now: T0 + MINUTE_MS, gameRef: () => REF }), [
      { event: BuildsEvent.GameFirstBuildMade, properties: { ms_since_game_created: MINUTE_MS, game_ref: REF } },
    ]);
    assert.deepEqual(firstBuildsMade(after, after, { now: T0, gameRef: () => REF }), []);
  });

  it("times an asset job in each phase it leaves", () => {
    const seen: JobPhases = new Map();
    const job = (phase: MakingPhase) => [{ jobId: "j1", phase, kind: MakingKind.Music }];
    assert.deepEqual(jobPhaseChanges("pong", job(MakingPhase.Making), seen, T0), []);
    assert.deepEqual(jobPhaseChanges("pong", job(MakingPhase.Making), seen, T0 + 5), []);
    assert.deepEqual(jobPhaseChanges("pong", job(MakingPhase.Failed), seen, T0 + 30 * SECOND_MS), [
      {
        event: BuildsEvent.AssetJobPhaseChanged,
        properties: {
          from: MakingPhase.Making,
          to: MakingPhase.Failed,
          kind: MakingKind.Music,
          ms_in_from: 30 * SECOND_MS,
        },
      },
    ]);
  });

  it("counts inventory reads that fail in a row", () => {
    const failures = new Map<string, number>();
    const ok = { error: null };
    const first = { error: "EACCES /Users/alice" };
    const second = { error: "EACCES /Users/alice" };
    assert.deepEqual(inventoryFailures({ pong: ok }, { pong: first }, failures), [
      { event: BuildsEvent.AssetsInventoryFailed, properties: { failures_in_row: 1 } },
    ]);
    assert.deepEqual(inventoryFailures({ pong: first }, { pong: second }, failures), [
      { event: BuildsEvent.AssetsInventoryFailed, properties: { failures_in_row: 2 } },
    ]);
    assert.deepEqual(inventoryFailures({ pong: second }, { pong: ok }, failures), []);
    assert.equal(failures.size, 0);
  });
});

describe("the stage's build polls", () => {
  const broken = {
    needsInstall: false,
    showingLastBuild: true,
    skippedScripts: null,
    code: 1,
    command: "npm run build /Users/alice/pong",
    lines: ["error in /Users/alice/pong/src/main.ts"],
  };

  it("counts a build that broke between two polls, once, with what the stage offers and no command", () => {
    const polls: BuildPolls = new Map();
    assert.equal(buildBroke(polls, "pong", null), null);
    assert.deepEqual(buildBroke(polls, "pong", broken), {
      needs_install: false,
      showing_last_build: true,
      skipped_scripts: false,
      killed: false,
    });
    assert.equal(buildBroke(polls, "pong", broken), null, "still broken is not news");
    assert.equal(buildBroke(polls, "pong", null), null);
    assert.equal(buildBroke(polls, "pong", { ...broken, code: null })?.killed, true, "broke again");
  });

  it("never counts a game's first answer, nor a game reopened while still broken", () => {
    const polls: BuildPolls = new Map();
    assert.equal(buildBroke(polls, "pong", broken), null, "opened already broken");
    // The stage watches another game, then this one again: the memory is the game's, not the watch's.
    assert.equal(buildBroke(polls, "maze", null), null);
    assert.equal(buildBroke(polls, "pong", broken), null, "reopened still broken");
    assert.equal(buildBroke(polls, "maze", broken)?.needs_install, false, "the other game broke while watched");
  });
});

describe("the stage", () => {
  it("says how Live's wait ended, from the load's own clock and what the page reported", () => {
    const properties = liveShownProperties({
      outcome: LiveOutcome.Shown,
      load: { since: T0, trigger: LiveTrigger.FirstBuildAuto },
      now: T0 + 4 * SECOND_MS,
      firstInLaunch: true,
      gameCreatedAt: new Date(T0 - 10 * MINUTE_MS).toISOString(),
      firstMessageAt: T0 - 9 * MINUTE_MS,
      state: { drawCalls: 12, flow: { phase: "menu", playing: false } },
      gameRef: REF,
    });
    assert.deepEqual(properties, {
      outcome: LiveOutcome.Shown,
      load_ms: 4 * SECOND_MS,
      trigger: LiveTrigger.FirstBuildAuto,
      first_in_launch: true,
      game_age_ms: 10 * MINUTE_MS + 4 * SECOND_MS,
      ms_since_first_message: 9 * MINUTE_MS + 4 * SECOND_MS,
      game_playing: false,
      draws_seen: true,
      game_ref: REF,
      load_failure: null,
      crash_reason: null,
    });
    assert.equal(liveShownProperties({ ...inputWithout(), load: { since: T0 } }).trigger, null);
  });

  it("suspects a blank game only after it showed and drew nothing for a while", () => {
    assert.equal(blankSuspected(T0, T0 + BLANK_AFTER_MS - 1, { drawCalls: 0 }), null);
    assert.equal(blankSuspected(T0, T0 + BLANK_AFTER_MS, { drawCalls: 4 }), null);
    assert.deepEqual(blankSuspected(T0, T0 + BLANK_AFTER_MS, { drawCalls: 0 }), {
      ms_after_shown: BLANK_AFTER_MS,
      draws_counted: true,
      game_playing: null,
      unresponsive: false,
    });
    assert.equal(blankSuspected(T0, T0 + BLANK_AFTER_MS, null)?.draws_counted, false);
    assert.equal(blankSuspected(T0, T0 + BLANK_AFTER_MS, null, true)?.unresponsive, true, "its loop stopped answering");
    assert.equal(blankSuspected(T0, T0 + BLANK_AFTER_MS, null, "true")?.unresponsive, false, "only a plain true");
  });

  it("marks a Reload rapid when the last one of the game was moments ago", () => {
    assert.deepEqual(reloadPressed(null, null, T0), { behind_reason: null, rapid: false, ms_since_last: null });
    assert.deepEqual(reloadPressed(LiveBehindReason.Build, T0, T0 + RAPID_RELOAD_MS - 1), {
      behind_reason: LiveBehindReason.Build,
      rapid: true,
      ms_since_last: RAPID_RELOAD_MS - 1,
    });
    assert.equal(reloadPressed(null, T0, T0 + RAPID_RELOAD_MS).rapid, false);
  });

  it("times the first plan's wait", () => {
    assert.deepEqual(planningEnded({ since: T0, fromHome: true, gameRef: REF }, PlanningEnd.RunStarted, T0 + 5), {
      ms: 5,
      ended_by: PlanningEnd.RunStarted,
      from_home: true,
      game_ref: REF,
    });
  });

  it("reads the chat's first message time from its log", () => {
    const said: EventEnvelope = {
      ...record(CustomEvent.RunStarted, {}, 2000),
      data: { type: EventKind.Messages, messages: [{ role: "user", content: "make pong" }] },
    };
    assert.equal(firstMessageAt([record(CustomEvent.RunStarted, {}, 0), said]), T0 + 2000);
    assert.equal(firstMessageAt([]), null);
  });

  it("names a Builds node by its kind, never its id", () => {
    assert.equal(nodeKindOf(GraphSelection.FinishCheck), GraphSelection.FinishCheck);
    assert.equal(nodeKindOf("part:facet-7"), NodeKind.Part);
    assert.equal(nodeKindOf("step-abc"), NodeKind.Step);
  });

  it("tells a press the person declined from one that failed", () => {
    assert.equal(pressOutcomeOf(undefined), PressOutcome.Ok);
    assert.equal(pressOutcomeOf(new Error("boom")), PressOutcome.Failed);
  });
});

describe("engine setup cards", () => {
  const card = (rows: StepsCard["steps"]): StepsCard => ({ title: "Unreal setup", intro: "", open: true, steps: rows });
  const row = (id: string, state: Partial<{ done: boolean; you: true; working: true }>) => ({
    id,
    label: `Step ${id}`,
    detail: "",
    done: state.done ?? false,
    ...(state.you ? { you: state.you } : {}),
    ...(state.working ? { working: state.working } : {}),
  });

  it("names a row's state, and its id only for a bundled plugin", () => {
    assert.equal(stepStateOf(row("a", { done: true })), SetupStepState.Done);
    assert.equal(stepStateOf(row("a", { working: true })), SetupStepState.Working);
    assert.equal(stepStateOf(row("a", { you: true })), SetupStepState.You);
    assert.equal(stepStateOf(row("a", {})), SetupStepState.Open);
    const plugins = [
      { manifest: { id: "roblox" }, source: PluginSourceKind.Bundled },
      { manifest: { id: "mine" }, source: PluginSourceKind.Github },
    ];
    assert.equal(setupStepId(setupPluginOf("roblox", plugins), "studio"), "studio");
    assert.equal(setupStepId(setupPluginOf("mine", plugins), "studio"), null);
    assert.equal(setupPluginOf("mine", plugins).ref, PluginSourceKind.Github);
  });

  it("sends each row's move with how long it stood where it was", () => {
    const plugin = { ref: "roblox", bundled: true };
    const seen: StepStates = new Map();
    const first = card([row("studio", { done: true }), row("sign-in", { you: true })]);
    assert.deepEqual(setupCardShown(first, plugin), {
      plugin_ref: "roblox",
      step_count: 2,
      open_steps: 1,
      you_steps: 1,
      has_primary: false,
    });
    assert.deepEqual(setupStepChanges(first, seen, { plugin, now: T0, shownAt: T0 }), []);
    const next = card([row("studio", { done: true }), row("sign-in", { done: true })]);
    assert.deepEqual(setupStepChanges(next, seen, { plugin, now: T0 + MINUTE_MS, shownAt: T0 }), [
      {
        plugin_ref: "roblox",
        step_id: "sign-in",
        from: SetupStepState.You,
        to: SetupStepState.Done,
        ms_in_previous: MINUTE_MS,
        ms_since_shown: MINUTE_MS,
      },
    ]);
  });
});

/** A `liveShownProperties` input with nothing known. */
function inputWithout() {
  return {
    outcome: LiveOutcome.TimedOut,
    load: { since: T0, trigger: LiveTrigger.Reload },
    now: T0,
    firstInLaunch: false,
    gameCreatedAt: null,
    firstMessageAt: null,
    state: null,
    gameRef: null,
  };
}

// ── hostile input ─────────────────────────────────────────────────────────────────────────

/** What a person, an agent or a plugin may have written: none of it may reach an event. */
const SECRET = "SECRET-Alice-Plan";
const PATH = "/Users/alice/AI Games/My Secret Game";
const MARKERS = [SECRET, "alice", "/Users", "run-SECRET", "w-SECRET", "j-SECRET", "Bearer"];

/** Every record of the area, each field stuffed with words, paths, names and ids. */
function hostileRecords(): EventEnvelope[] {
  const scope = { runId: "run-SECRET", project: PATH, facetTitle: SECRET, facetId: SECRET };
  const words = { reason: SECRET, why: SECRET, because: SECRET, summary: SECRET, message: `Bearer ${SECRET}` };
  return [
    record(
      CustomEvent.RunStarted,
      { ...scope, goal: SECRET, engine: SECRET, budgets: { completionPolicy: SECRET } },
      0,
    ),
    record(
      CustomEvent.AutopilotStarted,
      { ...scope, profile: SECRET, facets: [{ title: SECRET }], maxParallel: SECRET },
      1,
    ),
    record(CustomEvent.RunStartBlocked, { ...scope, ...words, requestedRunId: "run-SECRET" }, 2),
    record(
      CustomEvent.AutopilotPlanReview,
      { ...scope, ...words, waitMinutes: SECRET, facets: [{ title: SECRET }] },
      3,
    ),
    record(
      CustomEvent.WorkerStarted,
      { ...scope, workerId: "w-SECRET", title: SECRET, task: SECRET, ask: SECRET, in: SECRET, isolation: SECRET },
      4,
    ),
    record(CustomEvent.WorkerStarted, { workerId: "w-SECRET", turn: "m-SECRET", title: SECRET, ask: SECRET }, 4),
    record(
      CustomEvent.WorkerFinished,
      {
        ...scope,
        ...words,
        workerId: "w-SECRET",
        state: WorkerEnd.Done,
        stopCode: SECRET,
        stoppedBecause: SECRET,
        title: SECRET,
      },
      5,
    ),
    record(
      CustomEvent.WorkerFinished,
      { ...scope, workerId: "w-SECRET", verdict: WorkerVerdict.Used, note: SECRET },
      6,
    ),
    record(CustomEvent.IntegrationMerge, { ...scope, head: SECRET }, 7),
    record(CustomEvent.IntegrationHealth, { ...scope, ok: SECRET, problems: [SECRET, PATH] }, 8),
    record(
      CustomEvent.DirectorVerdict,
      {
        ...scope,
        ...words,
        pass: SECRET,
        decision: { kept: SECRET, rule: SECRET },
        measured: { planned: [{ id: SECRET, reason: SECRET }] },
      },
      9,
    ),
    record(
      CustomEvent.FacetIteration,
      { ...scope, ...words, winner: SECRET, biggest_gap: SECRET, scoreboard: { flips: [SECRET], passing: SECRET } },
      10,
    ),
    record(CustomEvent.FinishCheck, { ...scope, round: 1, step: FinishCheckStep.Checking, claim: SECRET }, 11),
    record(
      CustomEvent.FinishCheck,
      {
        ...scope,
        ...words,
        round: 1,
        step: FinishCheckStep.Unanswered,
        claim: SECRET,
        proof: [PATH],
        reasons: [SECRET],
        notDone: [SECRET],
        reviewer: { engine: SECRET, model: SECRET },
      },
      12,
    ),
    record(
      CustomEvent.FacetProviderOutage,
      { ...scope, ...words, error: `Bearer ${SECRET}`, lost: SECRET, attempt: SECRET },
      13,
    ),
    record(CustomEvent.FacetStopped, { ...scope, ...words }, 14),
    record(
      CustomEvent.RunFinished,
      {
        ...scope,
        ...words,
        stopCode: SECRET,
        stoppedBecause: SECRET,
        notDone: [SECRET],
        stillToFix: { done: [SECRET], notDone: [SECRET], why: SECRET, hours: SECRET },
        failure: { message: PATH },
        limit: { kind: SECRET, message: SECRET },
        executionStatus: SECRET,
        profile: SECRET,
        learned: SECRET,
        reference: SECRET,
      },
      15,
    ),
    record(CustomEvent.RunAutoResumed, { ...scope, cause: SECRET, attempt: SECRET }, 16),
    record(CustomEvent.PreviewReady, { ...scope, ms: SECRET, via: SECRET }, 17),
    record(
      CustomEvent.BuildObservation,
      {
        ...words,
        project: PATH,
        brief: SECRET,
        model: SECRET,
        cliPath: PATH,
        stopReason: SECRET,
        ready: { reason: SECRET, via: SECRET },
        observation: { reasons: [SECRET] },
      },
      18,
    ),
    record(
      CustomEvent.DelegationIncomplete,
      { project: PATH, sessionId: SECRET, model: SECRET, stopReason: SECRET },
      19,
    ),
    record(
      CustomEvent.JobStarted,
      { jobId: "j-SECRET", project: PATH, title: SECRET, command: SECRET, cwd: PATH, role: SECRET },
      20,
    ),
    record(
      CustomEvent.JobEnded,
      {
        jobId: "j-SECRET",
        project: PATH,
        title: SECRET,
        state: SECRET,
        stoppedBy: SECRET,
        tail: SECRET,
        signal: SECRET,
        runId: "run-SECRET",
      },
      21,
    ),
    record(
      CustomEvent.PluginTool,
      {
        ...scope,
        callId: SECRET,
        pluginId: "alice-private",
        pluginName: SECRET,
        tool: SECRET,
        toolName: SECRET,
        args: SECRET,
        error: PATH,
        result: SECRET,
        files: [PATH],
        making: { kind: SECRET, tool: SECRET, prompt: SECRET },
        cutOff: SECRET,
        blocked: SECRET,
      },
      22,
    ),
    record(
      CustomEvent.PluginTool,
      { ...scope, pluginId: "genex", making: { kind: MakingKind.Image, tool: SECRET, prompt: SECRET }, error: SECRET },
      23,
    ),
  ];
}

/** Every string an event carries, wherever it sits. */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => stringsIn(item));
  if (value && typeof value === "object") return Object.values(value).flatMap((item) => stringsIn(item));
  return [];
}

describe("hostile input never reaches an event", () => {
  it("the log's readers send only codes, counts, durations and the game's ref", () => {
    const memory = memoryWith(() => [{ manifest: { id: "genex" }, source: PluginSourceKind.Bundled }]);
    const found = read(memory, hostileRecords());
    assert.ok(found.length >= 15, `${found.length} events`);
    for (const { event, properties } of found) {
      for (const text of stringsIn(properties)) {
        for (const marker of MARKERS) assert.ok(!text.includes(marker), `${event} carried ${text}`);
      }
      for (const value of Object.values(properties)) {
        const allowed = value === null || ["string", "number", "boolean"].includes(typeof value);
        assert.ok(allowed, `${event} carried a ${typeof value}`);
      }
    }
    const refs = found.flatMap(({ properties }) => ("game_ref" in properties ? [properties.game_ref] : []));
    assert.ok(refs.every((ref) => ref === REF || ref === null));
    const local = found.find((item) => item.event === BuildsEvent.PluginToolFinished);
    assert.equal(
      local?.event === BuildsEvent.PluginToolFinished && local.properties.plugin_ref,
      PluginSourceKind.Local,
    );
  });

  it("main's events send no words of theirs", () => {
    const found = buildsUiEvents(
      { type: UiEvent.JudgeRetry, payload: { engine: SECRET, kind: SECRET, message: PATH, attempt: SECRET } },
      memoryWith(),
      T0,
    );
    assert.deepEqual(found, [
      { event: BuildsEvent.ReviewerRetried, properties: { kind: null, attempt: null, wait_ms: null } },
    ]);
  });

  it("the stage's builders read no words from the page, a plugin's card or the library", () => {
    assert.deepEqual(gameSays({ flow: { playing: SECRET, phase: SECRET }, drawCalls: SECRET, title: SECRET }), {
      playing: null,
      draws: null,
    });
    const plugin = setupPluginOf("alice-private", [
      { manifest: { id: "alice-private" }, source: PluginSourceKind.Local },
    ]);
    const seen: StepStates = new Map();
    const steps = (done: boolean): StepsCard => ({
      title: SECRET,
      intro: SECRET,
      open: true,
      steps: [{ id: SECRET, label: SECRET, detail: PATH, done, command: `cd ${PATH}` }],
      primary: { name: SECRET, args: { path: PATH }, label: SECRET },
    });
    setupStepChanges(steps(false), seen, { plugin, now: T0, shownAt: T0 });
    const moves = [
      setupCardShown(steps(false), plugin),
      ...setupStepChanges(steps(true), seen, { plugin, now: T0 + 1, shownAt: T0 }),
    ];
    assert.equal(moves.length, 2);
    for (const text of moves.flatMap((move) => stringsIn(move))) {
      for (const marker of MARKERS) assert.ok(!text.includes(marker), text);
    }
    assert.equal(pluginRef("alice-private", []), PluginSourceKind.Local);
    const games = firstBuildsMade([{ name: PATH, awaitingFirstBuild: true }], [{ name: PATH, createdAt: SECRET }], {
      now: T0,
      gameRef: () => REF,
    });
    assert.deepEqual(games, [
      { event: BuildsEvent.GameFirstBuildMade, properties: { ms_since_game_created: null, game_ref: REF } },
    ]);
    const jobs: JobPhases = new Map();
    jobPhaseChanges(PATH, [{ jobId: SECRET, phase: MakingPhase.Queued, kind: undefined }], jobs, T0);
    const moved = jobPhaseChanges(PATH, [{ jobId: SECRET, phase: MakingPhase.Making }], jobs, T0 + 1);
    assert.deepEqual(moved[0]?.properties, {
      from: MakingPhase.Queued,
      to: MakingPhase.Making,
      kind: Unlisted.Other,
      ms_in_from: 1,
    });
  });
});
