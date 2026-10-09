/**
 * What a finished build measured, read from synthetic event logs (§9.4, M5.3): a chat-only build's
 * turn, a turn that only answered or launched a run (no row), and a launched run once it closes.
 * M4's own events are read only under the names the caller passes; these tests spell the documented
 * wire names, as tests may.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FIELD_EVENT_NAMES,
  type FactsStore,
  type FieldEventNames,
  fieldModel,
  readFinishedFacts,
  runFacts,
  turnFacts,
} from "../../src/main/run-sharing-facts.ts";
import {
  type ConversationRecord,
  type EventData,
  type EventEnvelope,
  MessageUsageSource,
  ThreadKind,
} from "../../src/shared/event-log.ts";
import { EndedHow, LaneModeServed, LaunchPath, TokenRole } from "../../src/shared/eval-lane.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { DEFAULT_PERMISSION_MODE, PermissionMode } from "../../src/shared/permissions.ts";
import { ExecutionStatus } from "../../src/shared/run-state.ts";
import { DEFAULT_RUNS_ORIGIN, FieldPlatform, buildFieldRow } from "../../src/shared/run-sharing.ts";
import { createRunSharing } from "../../src/main/run-sharing.ts";
import path from "node:path";
import { tmpDir } from "../helpers/tmp.ts";
import type { BuildObservationPayload } from "../../src/shared/custom-events.ts";
import { ReadyVia } from "../../src/shared/preview-contract.ts";

const M4: FieldEventNames = { completionCall: "completion_call", previewReady: "preview_ready" };
const T0 = Date.parse("2026-10-01T10:00:00.000Z");

/** A log whose records are `at` seconds after T0. */
function log(...records: Array<[number, EventData]>): EventEnvelope[] {
  return records.map(([at, data], index) => ({
    id: `e${String(index).padStart(4, "0")}`,
    thread_id: "thread-1",
    session_id: null,
    turn_id: "turn-1",
    created_at: new Date(T0 + at * 1000).toISOString(),
    data,
  }));
}

const custom = (event_type: string, payload: Record<string, unknown>): EventData => ({
  type: "custom",
  event_type,
  payload,
});
const reply = (model: string, output: number): EventData => ({
  type: "messages",
  messages: [{ role: "assistant", content: "…" }],
  usage: { engine: EngineId.ClaudeCode, model, input_tokens: 100, output_tokens: output, cache_read_tokens: 1000 },
});
/** A build record in the producer's shape (the seed's `recordBuildObservation`), typed so a misnamed key fails. */
const build = (ok: boolean, durationMs: number, pageMs: number | null): EventData => {
  const payload: BuildObservationPayload = {
    project: "demo",
    brief: "SYNTHETIC BRIEF TEXT",
    ok,
    model: "claude-sonnet-5-5",
    durationMs,
    usage: { input_tokens: 50, output_tokens: 20, cache_write_tokens: 5 },
    ready: pageMs === null ? null : { ready: true, ms: pageMs + 10, pageMs, timedOut: false, via: ReadyVia.Shim },
    summary: "SYNTHETIC SUMMARY",
  };
  return custom("build_observation", { ...payload });
};

/** The queue taking message `messageId`: the record a handled message's own turn follows. */
const processing = (messageId: string): EventData => custom("coordinator_message_processing", { messageId });

function chatBuild(): EventEnvelope[] {
  return log(
    [0, processing("m1")],
    [0, { type: "turn_started" }],
    [1, reply("claude-opus-5-5[1m]", 10)],
    [2, { type: "tool_requested", tool_call_id: "c1", request: { name: "mcp__studio__delegate", arguments: {} } }],
    [30, build(false, 20_000, 900)],
    [40, custom("preview_ready", { project: "demo", ms: 35_000, via: "shim" })],
    [60, build(true, 40_000, 800)],
    [61, custom("context_usage", { engine: EngineId.ClaudeCode, percent: 38.5 })],
    [62, custom("context_usage", { engine: EngineId.ClaudeCode, role: "builder", percent: 91 })],
    [63, custom("compacted", { engine: EngineId.ClaudeCode })],
    [64, custom("completion_call", { role: "judge", usage: { input_tokens: 7, output_tokens: 3 } })],
    [70, reply("claude-opus-5-5[1m]", 30)],
    [90, { type: "turn_ended", status: "ok" }],
  );
}

describe("a chat-only build's turn", () => {
  it("measures builds, tokens by role, timing and context from typed fields only", () => {
    const facts = turnFacts({ events: chatBuild(), permissionMode: PermissionMode.AcceptEdits }, M4);
    assert.ok(facts);
    assert.equal(facts.engine, EngineId.ClaudeCode);
    assert.equal(facts.model, "claude-opus-5-5");
    assert.equal(facts.modeServed, LaneModeServed.ChatOnly);
    assert.equal(facts.launch, LaunchPath.None);
    assert.equal(facts.permissionMode, PermissionMode.AcceptEdits);
    assert.equal(facts.endedHow, EndedHow.AgentFinished);
    assert.equal(facts.buildOk, true);
    assert.deepEqual(facts.time, {
      wallMs: 90_000,
      firstBootMs: 900,
      firstPreviewMs: 35_000,
      delegationP50Ms: 30_000,
      builds: 2,
    });
    assert.deepEqual(facts.tokensByRole[TokenRole.Lead], {
      uncachedInput: 200,
      cacheWrite: 0,
      cacheRead: 2000,
      output: 40,
      reasoning: 0,
    });
    assert.deepEqual(facts.tokensByRole[TokenRole.Workers], {
      uncachedInput: 100,
      cacheWrite: 10,
      cacheRead: 0,
      output: 40,
      reasoning: 0,
    });
    assert.equal(facts.tokensByRole[TokenRole.Judges]?.output, 3);
    assert.equal(facts.tokens.output, 83);
    assert.deepEqual(facts.context, { leadPeakPct: 38.5, compactions: 1 });
    assert.deepEqual(facts.calls, { modelCalls: 2, tools: { total: 1, byCategory: {} } });
    const row = buildFieldRow(facts, {
      installId: "0123456789abcdef0123456789abcdef",
      consentVersion: "2026-10-01",
      recordedAt: "2026-10-01T10:02:00.000Z",
      app: { version: "0.1.0", platform: FieldPlatform.Mac },
    });
    assert.ok(row.ok);
    assert.equal(JSON.stringify(row.row).includes("SYNTHETIC"), false, "no brief or summary text reaches the row");
  });

  it("reads M4's events under their registered names by default", () => {
    assert.deepEqual(FIELD_EVENT_NAMES, M4);
    const facts = turnFacts({ events: chatBuild(), permissionMode: undefined });
    assert.ok(facts);
    assert.equal(facts.time.firstPreviewMs, 35_000);
    assert.ok(facts.tokensByRole[TokenRole.Judges]);
    assert.equal(facts.permissionMode, DEFAULT_PERMISSION_MODE);
  });

  it("leaves M4's measurements null or absent (never zero) when their events are not read", () => {
    const facts = turnFacts(
      { events: chatBuild(), permissionMode: undefined },
      { completionCall: null, previewReady: null },
    );
    assert.ok(facts);
    assert.equal(facts.time.firstPreviewMs, null);
    assert.equal(facts.tokensByRole[TokenRole.Judges], undefined);
  });

  it("reads a cancelled or failed turn as its ending", () => {
    const events = chatBuild();
    events[events.length - 1] = {
      ...(events.at(-1) as EventEnvelope),
      data: { type: "turn_ended", status: "cancelled" },
    };
    assert.equal(turnFacts({ events, permissionMode: null }, M4)?.endedHow, EndedHow.Cancelled);
    events[events.length - 1] = { ...(events.at(-1) as EventEnvelope), data: { type: "turn_ended", status: "error" } };
    assert.equal(turnFacts({ events, permissionMode: null }, M4)?.endedHow, EndedHow.Crash);
  });

  it("makes no row for a turn that only answered, one still running, or one that launched a run", () => {
    const answered = log([0, { type: "turn_started" }], [1, reply("claude-opus-5-5", 5)], [2, { type: "turn_ended" }]);
    assert.equal(turnFacts({ events: answered, permissionMode: null }, M4), null);
    const running = chatBuild().slice(0, -1);
    assert.equal(turnFacts({ events: running, permissionMode: null }, M4), null);
    const launched = log(
      [0, { type: "turn_started" }],
      [1, reply("claude-opus-5-5", 5)],
      [2, build(true, 1000, null)],
      [3, custom("run_registered", { runId: "run-1", budgets: { untilSatisfied: true } })],
      [4, { type: "turn_ended" }],
    );
    assert.equal(turnFacts({ events: launched, permissionMode: null }, M4), null);
  });

  it("makes no row when the engine or model cannot be named", () => {
    const events = log(
      [0, { type: "turn_started" }],
      [
        1,
        { type: "messages", messages: [], usage: { engine: "mystery", model: "My Custom Model!", output_tokens: 1 } },
      ],
      [2, build(true, 1000, null)],
      [3, { type: "turn_ended" }],
    );
    assert.equal(turnFacts({ events, permissionMode: null }, M4), null);
  });
});

describe("token counts in the normalized shape (Rule 13)", () => {
  /** A chat-only build whose lead, worker and judge report Codex-style or Claude-style input. */
  function turn(leadEngine: EngineId): EventEnvelope[] {
    const leadModel = leadEngine === EngineId.Codex ? "gpt-6.1-sol" : "claude-opus-5-5";
    return log(
      [0, { type: "turn_started" }],
      [
        1,
        {
          type: "messages",
          messages: [{ role: "assistant", content: "…" }],
          usage: {
            engine: leadEngine,
            model: leadModel,
            input_tokens: 10_000,
            cache_read_tokens: 9000,
            output_tokens: 10,
          },
        },
      ],
      [
        2,
        custom("build_observation", {
          project: "demo",
          ok: true,
          model: "gpt-6.1-sol",
          durationMs: 1000,
          usage: { engine: EngineId.Codex, input_tokens: 2000, cache_read_tokens: 1500, output_tokens: 5 },
        }),
      ],
      [
        3,
        custom("completion_call", {
          role: "judge",
          engine: EngineId.Codex,
          model: "gpt-6.1-sol",
          usage: { input_tokens: 300, cache_read_tokens: 200, output_tokens: 1 },
        }),
      ],
      [4, { type: "turn_ended", status: "ok" }],
    );
  }

  it("takes Codex's cache reads out of its input, for the lead, the workers and the judges", () => {
    const facts = turnFacts({ events: turn(EngineId.Codex), permissionMode: null }, M4);
    assert.ok(facts);
    const roles = [TokenRole.Lead, TokenRole.Workers, TokenRole.Judges];
    const usages = roles.map((role) => facts.tokensByRole[role]);
    assert.deepEqual(
      usages.map((usage) => usage?.uncachedInput),
      [1000, 500, 100],
    );
    assert.deepEqual(
      usages.map((usage) => usage?.cacheRead),
      [9000, 1500, 200],
    );
    assert.equal(facts.tokens.uncachedInput, 1600);
  });

  it("reduces only the Codex part of a turn whose lead is Claude", () => {
    const facts = turnFacts({ events: turn(EngineId.ClaudeCode), permissionMode: null }, M4);
    assert.ok(facts);
    assert.equal(facts.tokensByRole[TokenRole.Lead]?.uncachedInput, 10_000);
    assert.equal(facts.tokensByRole[TokenRole.Workers]?.uncachedInput, 500);
    assert.equal(facts.tokensByRole[TokenRole.Judges]?.uncachedInput, 100);
  });
});

describe("tokens beyond a session's main loop (`by_model`)", () => {
  const counts = (input: number, output: number) => ({
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  });
  function turn(byModel: Record<string, ReturnType<typeof counts>>): EventEnvelope[] {
    return log(
      [0, { type: "turn_started" }],
      [
        1,
        {
          type: "messages",
          messages: [{ role: "assistant", content: "…" }],
          usage: { engine: EngineId.ClaudeCode, model: "claude-opus-5-5[1m]", ...counts(100, 50), by_model: byModel },
        },
      ],
      [2, build(true, 1000, null)],
      [3, { type: "turn_ended", status: "ok" }],
    );
  }
  const usage = (uncachedInput: number, output: number) => ({
    uncachedInput,
    cacheWrite: 0,
    cacheRead: 0,
    output,
    reasoning: 0,
  });

  it("counts the session's other models as auxiliary and its own model's surplus as subagents", () => {
    const events = turn({ "claude-opus-5-5[1m]": counts(130, 70), "claude-haiku-4-5-20251001": counts(10, 5) });
    const facts = turnFacts({ events, permissionMode: null }, M4);
    assert.ok(facts);
    assert.deepEqual(facts.tokensByRole[TokenRole.Lead], usage(100, 50));
    assert.deepEqual(facts.tokensByRole[TokenRole.Subagents], usage(30, 20));
    assert.deepEqual(facts.tokensByRole[TokenRole.Auxiliary], usage(10, 5));
    assert.equal(facts.tokens.output, 50 + 20 + 5 + 20, "lead, subagents, auxiliary and the worker");
    const row = buildFieldRow(facts, {
      installId: "0123456789abcdef0123456789abcdef",
      consentVersion: "2026-10-01",
      recordedAt: "2026-10-01T10:00:00.000Z",
      app: { version: "0.1.0", platform: FieldPlatform.Mac },
    });
    assert.ok(row.ok);
  });

  it("adds nothing when the main model's own share is all main loop", () => {
    const facts = turnFacts({ events: turn({ "claude-opus-5-5": counts(100, 50) }), permissionMode: null }, M4);
    assert.ok(facts);
    assert.equal(facts.tokensByRole[TokenRole.Subagents], undefined);
    assert.equal(facts.tokensByRole[TokenRole.Auxiliary], undefined);
  });

  it("adds nothing when `by_model` names no share for the main model: the split is unknown", () => {
    const facts = turnFacts({ events: turn({ "claude-sonnet-5-5": counts(400, 90) }), permissionMode: null }, M4);
    assert.ok(facts);
    assert.equal(facts.tokensByRole[TokenRole.Subagents], undefined);
    assert.equal(facts.tokensByRole[TokenRole.Auxiliary], undefined);
    assert.equal(facts.tokens.output, 50 + 20);
  });
});

describe("a delegated chat turn's one engine call", () => {
  const counts = (input: number, output: number) => ({
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  });
  /** The contractor's report, as the seed's `reportBuild` repeats it on both records. */
  const report = {
    engine: EngineId.ClaudeCode,
    ...counts(100, 50),
    by_model: { "claude-opus-5-5": counts(130, 70), "claude-haiku-4-5-20251001": counts(10, 5) },
  };
  /** One delegated turn in the producer's order: the build record, then the chat's reply carrying the same report. */
  function delegatedTurn(marker: Partial<Pick<Extract<EventData, { type: "messages" }>, "usage_source">>) {
    return log(
      [0, { type: "turn_started" }],
      [1, { type: "tool_requested", tool_call_id: "d1", request: { name: "delegate_to_contractor", arguments: {} } }],
      [30, custom("build_observation", { project: "demo", ok: true, model: "claude-opus-5-5", usage: report })],
      [
        31,
        {
          type: "messages",
          messages: [{ role: "assistant", content: "…" }],
          usage: { ...report, model: "claude-opus-5-5" },
          ...marker,
        },
      ],
      [32, { type: "turn_ended", status: "ok" }],
    );
  }
  const usage = (uncachedInput: number, output: number) => ({
    uncachedInput,
    cacheWrite: 0,
    cacheRead: 0,
    output,
    reasoning: 0,
  });

  for (const [vintage, marker] of [
    ["marked as the delegation's report", { usage_source: MessageUsageSource.Delegation }],
    ["from a seed before the marker (same counts, same turn)", {}],
  ] as const) {
    it(`counts the contractor once, as the chat's call, when the reply is ${vintage}`, () => {
      const facts = turnFacts({ events: delegatedTurn(marker), permissionMode: null }, M4);
      assert.ok(facts);
      assert.deepEqual(facts.tokensByRole[TokenRole.Lead], usage(100, 50));
      assert.equal(facts.tokensByRole[TokenRole.Workers], undefined, "the build record repeats the same call");
      assert.deepEqual(facts.tokensByRole[TokenRole.Subagents], usage(30, 20));
      assert.deepEqual(facts.tokensByRole[TokenRole.Auxiliary], usage(10, 5));
      assert.equal(facts.tokens.output, 50 + 20 + 5);
      assert.equal(facts.calls.modelCalls, 1);
      assert.equal(facts.time.builds, 1);
    });
  }

  it("still counts a build whose report no reply repeats", () => {
    const events = delegatedTurn({});
    const reply = events[3] as EventEnvelope;
    events[3] = {
      ...reply,
      data: { type: "messages", messages: [], usage: { ...report, ...counts(7, 1), model: "claude-opus-5-5" } },
    };
    const facts = turnFacts({ events, permissionMode: null }, M4);
    assert.ok(facts);
    assert.deepEqual(facts.tokensByRole[TokenRole.Workers], usage(100, 50));
  });
});

describe("a launched run", () => {
  function loopRun(): EventEnvelope[] {
    return log(
      [0, { type: "turn_started" }],
      [
        1,
        {
          type: "tool_requested",
          tool_call_id: "c1",
          request: { name: "mcp__studio__start_unattended_run", arguments: {} },
        },
      ],
      [2, custom("run_registered", { runId: "run-1", budgets: { wallClockMs: 3_600_000 } })],
      [3, { type: "turn_ended" }],
      [5, custom("run_started", { runId: "run-1", engine: EngineId.Codex, goal: "SYNTHETIC GOAL" })],
      [6, custom("context_usage", { runId: "run-1", engine: EngineId.Codex, model: "gpt-6.1-sol", percent: 55 })],
      [7, custom("facet_build_started", { runId: "run-1", facetId: "f1" })],
      [8, custom("facet_liveness", { runId: "run-1", total: 6, max: 10 })],
      [9, custom("facet_liveness", { runId: "run-1", total: 8, max: 10 })],
      [10, custom("facet_iteration", { runId: "run-1", scoreboard: { passing: 4, total: 5, regressions: ["a"] } })],
      [11, custom("facet_build_started", { runId: "run-2", facetId: "other" })],
      [
        20,
        custom("run_finished", {
          runId: "run-1",
          victory: true,
          executionStatus: ExecutionStatus.Completed,
          stopCode: "goal-met",
          durationMs: 15_000,
          summary: "SYNTHETIC SUMMARY",
        }),
      ],
    );
  }

  it("reads its launch, mode, signals and builds from its own records", () => {
    const facts = runFacts({ events: loopRun(), permissionMode: PermissionMode.Auto }, "run-1", M4);
    assert.ok(facts);
    assert.equal(facts.engine, EngineId.Codex);
    assert.equal(facts.model, "gpt-6.1-sol");
    assert.equal(facts.launch, LaunchPath.StartUnattendedRun);
    assert.equal(facts.modeServed, LaneModeServed.AutopilotTimed);
    assert.equal(facts.endedHow, EndedHow.AgentFinished);
    assert.equal(facts.buildOk, true);
    assert.equal(facts.time.wallMs, 15_000);
    assert.equal(facts.time.builds, 1);
    assert.deepEqual(facts.context, { leadPeakPct: 55, compactions: 0 });
    assert.deepEqual(facts.inApp, {
      victory: true,
      executionStatus: ExecutionStatus.Completed,
      stopCode: "goal-met",
      livenessMax: 8,
      scoreboard: { passing: 4, total: 5, regressions: 1 },
    });
  });

  it("makes no row before the run finished, and refuses a stop code that is a sentence", () => {
    const open = loopRun().slice(0, -1);
    assert.equal(runFacts({ events: open, permissionMode: null }, "run-1", M4), null);
    const events = loopRun();
    const last = events.at(-1) as EventEnvelope;
    events[events.length - 1] = {
      ...last,
      data: custom("run_finished", {
        runId: "run-1",
        executionStatus: ExecutionStatus.Failed,
        stopCode: "Out of ideas.",
      }),
    };
    const facts = runFacts({ events, permissionMode: null }, "run-1", M4);
    assert.equal(facts?.inApp.stopCode, null);
    assert.equal(facts?.endedHow, EndedHow.Crash);
  });
});

describe("model ids a row may carry", () => {
  const cases: ReadonlyArray<[unknown, string | null]> = [
    ["claude-opus-5-5", "claude-opus-5-5"],
    ["Claude-Opus-5-5[1m]", "claude-opus-5-5"],
    ["gpt-6.1-sol", "gpt-6.1-sol"],
    ["qwen3:8b", null],
    ["/Users/studio/models/local.gguf", null],
    ["", null],
    [42, null],
  ];
  for (const [raw, expected] of cases)
    it(`${JSON.stringify(raw)} → ${String(expected)}`, () => assert.equal(fieldModel(raw), expected));
});

describe("reading a finished build from the log", () => {
  function store(threads: Record<string, { metadata: Record<string, unknown>; events: EventEnvelope[] }>): FactsStore {
    const record = (id: string): ConversationRecord => ({
      id,
      agent_id: "studio",
      created_at: "2026-10-01T10:00:00.000Z",
      updated_at: "2026-10-01T10:00:00.000Z",
      latest_event_id: null,
      metadata: threads[id]?.metadata ?? {},
    });
    return {
      getRecord: async (id) => record(id),
      listThreads: async () => Object.keys(threads).map(record),
      listEvents: async (id) => threads[id]?.events ?? [],
    };
  }

  it("reads a game chat's turn with its permission mode, and never the Studio's own chat", async () => {
    const logs = store({
      game: {
        metadata: { kind: ThreadKind.Game, project: "demo", permissionMode: PermissionMode.Plan },
        events: chatBuild(),
      },
      studio: { metadata: { kind: ThreadKind.Studio }, events: chatBuild() },
    });
    const facts = await readFinishedFacts(logs, { threadId: "game", messageId: "m1" }, M4);
    assert.equal(facts?.permissionMode, PermissionMode.Plan);
    assert.equal(await readFinishedFacts(logs, { threadId: "studio", messageId: "m1" }, M4), null);
  });

  it("shares a handled message's own turn only: one that opened no turn shares nothing", async () => {
    const events = [
      ...chatBuild(),
      ...log([95, processing("m2")], [96, { type: "error", message: "Could not answer this message." }]),
    ];
    const logs = store({ game: { metadata: { kind: ThreadKind.Game, project: "demo" }, events } });
    assert.ok(await readFinishedFacts(logs, { threadId: "game", messageId: "m1" }, M4));
    assert.equal(await readFinishedFacts(logs, { threadId: "game", messageId: "m2" }, M4), null);
    assert.equal(await readFinishedFacts(logs, { threadId: "game", messageId: "never-taken" }, M4), null);

    const dir = path.join(await tmpDir("run-sharing-facts-"), "run-sharing");
    const posts: string[] = [];
    const sharing = createRunSharing({
      dir,
      origin: DEFAULT_RUNS_ORIGIN,
      sends: true,
      app: { version: "0.1.0", platform: FieldPlatform.Mac },
      now: () => T0,
      fetch: async (url) => {
        posts.push(String(url));
        return new Response(null, { status: 201 });
      },
      readFacts: (ref) => readFinishedFacts(logs, ref, M4),
    });
    await sharing.setOn(true);
    await sharing.buildFinished({ threadId: "game", messageId: "m1" });
    await sharing.buildFinished({ threadId: "game", messageId: "m2" });
    assert.equal(posts.length, 1, "the earlier build is not shared a second time");
  });

  it("finds a run among its game's chats and nowhere else", async () => {
    const run = log(
      [0, custom("run_started", { runId: "run-9", engine: EngineId.ClaudeCode })],
      [1, custom("context_usage", { runId: "run-9", engine: EngineId.ClaudeCode, model: "claude-opus-5-5" })],
      [9, custom("run_finished", { runId: "run-9", executionStatus: ExecutionStatus.Completed })],
    );
    const logs = store({
      first: { metadata: { kind: ThreadKind.Game, project: "demo" }, events: chatBuild() },
      second: { metadata: { kind: ThreadKind.Game, project: "demo" }, events: run },
      other: { metadata: { kind: ThreadKind.Game, project: "other" }, events: run },
    });
    assert.equal((await readFinishedFacts(logs, { runId: "run-9", project: "demo" }, M4))?.engine, EngineId.ClaudeCode);
    assert.equal(await readFinishedFacts(logs, { runId: "run-9", project: "missing" }, M4), null);
  });
});
