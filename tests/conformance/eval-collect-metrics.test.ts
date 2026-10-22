/**
 * The metric catalog (§7) over `RunObservation`s built from the synthetic lane fixtures: each
 * definition (wall and censored time to done, first preview, build spans and their median,
 * normalized tokens by role and model with coverage, context peaks and compactions, model and
 * tool calls, the blind-edit streak, `verifiedBeforeDone` and its gate, API-equivalent cost and an
 * unknown price, quota deltas), the ±2% token cross-check, the served-model check, the vacuity
 * guard and the one `ToolCategory` table with its command false-positive rows.
 * Hermetic: fixtures and a synthetic price table.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { readClaudeStream } from "../../scripts/evals/collect/claude-stream.ts";
import { readCodexStream } from "../../scripts/evals/collect/codex-stream.ts";
import { genexEventsOf } from "../../scripts/evals/collect/genex-events.ts";
import { CollectError, CollectErrorCode } from "../../scripts/evals/collect/honesty.ts";
import type {
  BuildSpanEvent,
  ModelCallEvent,
  ObservationEvent,
  RunObservation,
  ToolCallEvent,
} from "../../scripts/evals/collect/observation.ts";
import {
  buildRunObservation,
  type ObservationInput,
  type TimelineReading,
} from "../../scripts/evals/collect/observe.ts";
import { classifyCommand, classifyTool } from "../../src/shared/tool-category.ts";
import { readTranscripts } from "../../scripts/evals/collect/transcripts.ts";
import { isMeasured, unavailable } from "../../scripts/evals/ledger/types.ts";
import {
  apiEquivalentCost,
  blindEditStreak,
  callMetrics,
  contextMetrics,
  engineFallbackCheck,
  isSameModel,
  isToDoneCensored,
  median,
  quotaDeltas,
  runMetrics,
  servedModelCheck,
  servedModels,
  timeMetrics,
  tokenCrossCheck,
  tokenMetrics,
  verifiedBeforeDone,
} from "../../scripts/evals/metrics.ts";
import { sameModel } from "../../scripts/evals/lanes/raw.ts";
import { validatePriceTable } from "../../scripts/evals/prices.ts";
import {
  BuildSpanKind,
  Coverage,
  EndedHow,
  EvalAgent,
  HarnessFailure,
  LaneModeServed,
  ObservationEventKind,
  ObservationSource,
  ObservedErrorKind,
  ServedModelRole,
  TokenRole,
  ToolCategory,
  UnavailableReason,
} from "../../scripts/evals/vocabulary.ts";
import { EventKind } from "../../src/shared/event-log.ts";
import { EngineId } from "../../src/shared/providers.ts";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/evals/collect");
const PROMPT_AT = 1_790_000_000_000;
const END_AT = PROMPT_AT + 18_000;
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const PRICES = validatePriceTable({
  schema: "genex-evals/prices/1",
  asOf: "2026-09-25",
  unit: "usd-per-million-tokens",
  models: {
    "claude-opus-5-5": { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
    "claude-haiku-4-5": { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
    "gpt-6.1-sol": { unknown: true },
  },
});
const window = { startMs: PROMPT_AT - 1000, endMs: PROMPT_AT + 3_600_000 };

function input(overrides: Partial<ObservationInput>): ObservationInput {
  return {
    runId: "20260921T141320-raw-claude-canary-r1",
    laneId: "raw-claude",
    agent: EvalAgent.ClaudeCli,
    engine: EngineId.ClaudeCode,
    modelRequested: "claude-opus-5-5",
    modeServed: LaneModeServed.RawCli,
    endedHow: EndedHow.AgentFinished,
    promptAtMs: PROMPT_AT,
    endAtMs: END_AT,
    stream: null,
    transcripts: null,
    eventLog: null,
    laneReport: null,
    snapshot: null,
    quotaBefore: null,
    quotaAfter: null,
    ...overrides,
  };
}

async function claudeObservation(overrides: Partial<ObservationInput> = {}): Promise<RunObservation> {
  const transcripts = await readTranscripts({
    engine: EngineId.ClaudeCode,
    home: path.join(FIXTURES, "claude-home"),
    roots: ["/work/run"],
    window,
    promptAtMs: PROMPT_AT,
    leadSessionId: "sess-main",
  });
  return buildRunObservation(
    input({ stream: readClaudeStream(fixture("claude-stream.jsonl"), PROMPT_AT), transcripts, ...overrides }),
  );
}

async function codexObservation(overrides: Partial<ObservationInput> = {}): Promise<RunObservation> {
  const transcripts = await readTranscripts({
    engine: EngineId.Codex,
    home: path.join(FIXTURES, "codex-home"),
    roots: ["/work/run"],
    window,
    promptAtMs: PROMPT_AT,
    leadSessionId: "thr-main",
  });
  return buildRunObservation(
    input({
      laneId: "raw-codex",
      agent: EvalAgent.CodexCli,
      engine: EngineId.Codex,
      modelRequested: "gpt-6.1-sol",
      stream: readCodexStream(fixture("codex-stream.jsonl"), PROMPT_AT),
      transcripts,
      ...overrides,
    }),
  );
}

const tool = (id: string, atMs: number, category: ToolCategory): ToolCallEvent => ({
  kind: ObservationEventKind.ToolCall,
  atMs,
  source: ObservationSource.Stream,
  id,
  session: { sessionId: "s", parentSessionId: null, role: ServedModelRole.Main },
  name: "x",
  category,
  endMs: null,
  ok: null,
});

const withTimeline = (obs: RunObservation, events: ObservationEvent[]): RunObservation => ({
  ...obs,
  timeline: events,
});

describe("the observation assembler", () => {
  it("takes model calls from the transcripts, adds the helper model once as auxiliary, and keeps the stream's tools", async () => {
    const obs = await claudeObservation();
    const calls = obs.timeline.filter((e): e is ModelCallEvent => e.kind === ObservationEventKind.ModelCall);
    assert.ok(
      calls
        .filter((c) => c.session.role !== ServedModelRole.Auxiliary)
        .every((c) => c.source === ObservationSource.Transcript),
    );
    assert.deepEqual(
      calls.filter((c) => c.session.role === ServedModelRole.Auxiliary).map((c) => c.model),
      ["claude-haiku-4-5-20251001"],
    );
    assert.equal(obs.timeline.filter((e) => e.kind === ObservationEventKind.ToolCall).length, 6);
    assert.equal(obs.wallMs, 18_000);
    assert.deepEqual(obs.provenance.sources, [ObservationSource.Stream, ObservationSource.Transcript]);
    assert.equal(obs.provenance.servedMain, "claude-opus-5-5");
    assert.deepEqual(obs.provenance.traceComplete, { parseFailures: 0, truncatedTail: false });
    assert.deepEqual(obs.provenance.providerNoise, { apiErrors: 0, retries: 1, apiErrorStatus: null });
    assert.equal(obs.provenance.cliReportedUsd, 0.5);
    assert.deepEqual(Object.keys(obs.provenance.modelUsage).sort(), ["claude-haiku-4-5-20251001", "claude-opus-5-5"]);
    const times = obs.timeline.map((e) => e.atMs);
    assert.deepEqual(
      times,
      [...times].sort((a, b) => a - b),
      "the timeline is in receive order",
    );
  });

  describe("auxiliary tokens: what a CLI's per-model totals hold beyond the calls naming that model", () => {
    const trace = { parseFailures: 0, partialTail: false, sawTerminal: true };
    const tokens = (uncachedInput: number, output = 0) => ({
      uncachedInput,
      cacheWrite: 0,
      cacheRead: 0,
      output,
      reasoning: 0,
    });
    const call = (id: string, model: string, usage: ReturnType<typeof tokens>): ModelCallEvent => ({
      kind: ObservationEventKind.ModelCall,
      atMs: 1,
      source: ObservationSource.Transcript,
      id,
      session: { sessionId: "s", parentSessionId: null, role: ServedModelRole.Main },
      model,
      usage,
      contextTokens: usage.uncachedInput,
      contextWindow: null,
      effortServed: null,
      endMs: null,
      ttftMs: null,
    });
    const auxiliary = (obs: RunObservation) =>
      obs.timeline.filter(
        (e): e is ModelCallEvent =>
          e.kind === ObservationEventKind.ModelCall && e.session.role === ServedModelRole.Auxiliary,
      );
    const stream = (modelUsage: Record<string, ReturnType<typeof tokens>>) => ({
      ...readClaudeStream(fixture("claude-stream.jsonl"), PROMPT_AT),
      modelUsage: Object.fromEntries(
        Object.entries(modelUsage).map(([model, usage]) => [model, { usage, contextWindow: null }]),
      ),
    });

    it("keeps the helper's share of a model a sub-agent also called", () => {
      const obs = buildRunObservation(
        input({
          stream: stream({ "claude-opus-5-5": tokens(500, 50), "claude-haiku-4-5": tokens(1000, 10) }),
          transcripts: {
            events: [
              call("main", "claude-opus-5-5", tokens(500, 50)),
              call("explore", "claude-haiku-4-5", tokens(100, 4)),
            ],
            trace,
          },
        }),
      );
      assert.deepEqual(
        auxiliary(obs).map((c) => [c.model, c.usage]),
        [["claude-haiku-4-5", tokens(900, 6)]],
      );
      assert.deepEqual(tokenMetrics(obs).byRole[TokenRole.Auxiliary], tokens(900, 6));
    });

    it("adds nothing when the totals equal the calls, and never a negative remainder", () => {
      const obs = buildRunObservation(
        input({
          stream: stream({ "claude-opus-5-5": tokens(500, 50), "claude-haiku-4-5": tokens(100, 4) }),
          transcripts: {
            events: [
              call("main", "claude-opus-5-5", tokens(600, 60)),
              call("explore", "claude-haiku-4-5", tokens(100, 4)),
            ],
            trace,
          },
        }),
      );
      assert.deepEqual(auxiliary(obs), []);
    });

    it("reads a Genex lane's per-model totals from its event log, as a raw lane's come from its stream", () => {
      const obs = buildRunObservation(
        input({
          agent: EvalAgent.GenexApp,
          transcripts: { events: [call("chat", "claude-opus-5-5", tokens(500, 50))], trace },
          eventLog: {
            events: [],
            trace,
            modelUsage: {
              "claude-opus-5-5": { usage: tokens(500, 50), contextWindow: 1_000_000 },
              "claude-haiku-4-5": { usage: tokens(300, 3), contextWindow: 200_000 },
            },
          },
        }),
      );
      assert.deepEqual(
        auxiliary(obs).map((c) => [c.model, c.usage, c.source]),
        [["claude-haiku-4-5", tokens(300, 3), ObservationSource.EventLog]],
      );
      assert.deepEqual(tokenMetrics(obs).byRole[TokenRole.Auxiliary], tokens(300, 3));
    });

    describe("a by_model row keyed with Claude Code's context tag (`[1m]`) against bare transcript calls", () => {
      /** A Genex lane whose one chat call on the bare id meets an event log totalling the tagged id. */
      const tagged = (taggedInput: number) =>
        buildRunObservation(
          input({
            agent: EvalAgent.GenexApp,
            transcripts: { events: [call("chat", "claude-opus-5-5", tokens(53_100))], trace },
            eventLog: genexEventsOf(
              [
                {
                  id: "evt_001",
                  thread_id: "eval-thread",
                  session_id: null,
                  turn_id: null,
                  created_at: new Date(PROMPT_AT + 100).toISOString(),
                  data: {
                    type: EventKind.Messages,
                    messages: [{ role: "assistant", content: "ok" }],
                    usage: {
                      engine: EngineId.ClaudeCode,
                      by_model: {
                        "claude-opus-5-5[1m]": {
                          input_tokens: taggedInput,
                          output_tokens: 0,
                          cache_read_tokens: 0,
                          cache_write_tokens: 0,
                          context_window: 1_000_000,
                        },
                      },
                    },
                  },
                },
              ],
              PROMPT_AT,
            ),
          }),
        );

      it("counts the model once: no auxiliary residual, its window found, one priced id", () => {
        const obs = tagged(53_100);
        assert.deepEqual(auxiliary(obs), []);
        const metrics = tokenMetrics(obs);
        assert.equal(metrics.byRole[TokenRole.Auxiliary], undefined);
        assert.deepEqual(Object.keys(metrics.byModel), ["claude-opus-5-5"]);
        const lead = obs.timeline.find((e): e is ModelCallEvent => e.kind === ObservationEventKind.ModelCall);
        assert.equal(lead?.contextWindow, 1_000_000);
        assert.ok(isMeasured(apiEquivalentCost(obs, PRICES)), "the model prices under its untagged id");
      });

      it("adds only a real remainder, as one auxiliary call keyed by the untagged id", () => {
        const obs = tagged(60_000);
        assert.deepEqual(
          auxiliary(obs).map((c) => [c.id, c.model, c.usage, c.contextWindow]),
          [["model-usage:claude-opus-5-5", "claude-opus-5-5", tokens(6_900), 1_000_000]],
        );
        assert.deepEqual(Object.keys(tokenMetrics(obs).byModel), ["claude-opus-5-5"]);
      });
    });
  });

  it("falls back to the stream's calls without transcripts, and to the stream's last line without an end time", () => {
    const obs = buildRunObservation(
      input({ stream: readClaudeStream(fixture("claude-stream.jsonl"), PROMPT_AT), endAtMs: null }),
    );
    assert.equal(obs.wallMs, 17_000);
    assert.equal(tokenMetrics(obs).coverage, Coverage.StreamOnly);
    assert.equal(callMetrics(obs).coverage, Coverage.StreamOnly);
  });
});

describe("time", () => {
  it("reports wall time, uncensored time to done, the first preview and full coverage for a finished clean run", async () => {
    const time = timeMetrics(await claudeObservation());
    assert.equal(time.wallMs, 18_000);
    assert.equal(time.toDoneMs, 18_000);
    assert.equal(time.firstPreviewMs, 13_000);
    assert.equal(time.coverage, Coverage.Full);
    assert.equal(time.firstBootMs, null, "boot and playable times belong to the grader");
  });

  for (const endedHow of [
    EndedHow.Deadline,
    EndedHow.OwnBudget,
    EndedHow.MaxTurns,
    EndedHow.Crash,
    EndedHow.Cancelled,
  ]) {
    it(`censors time to done when the run ended ${endedHow}`, async () => {
      const obs = await claudeObservation({ endedHow });
      assert.equal(timeMetrics(obs).toDoneMs, null);
      assert.equal(isToDoneCensored(obs), true);
    });
  }

  it("marks timing trace-dirty when the stream lost lines", async () => {
    const stream = readClaudeStream(`${fixture("claude-stream.jsonl")}not json\n`, PROMPT_AT);
    const obs = buildRunObservation(input({ stream }));
    assert.equal(timeMetrics(obs).coverage, Coverage.TraceDirty);
  });

  it("measures finished build spans and their median; an open span is left out", () => {
    const span = (id: string, kind: BuildSpanKind, atMs: number, endMs: number | null): BuildSpanEvent => ({
      kind: ObservationEventKind.BuildSpan,
      atMs,
      source: ObservationSource.EventLog,
      id,
      span: kind,
      endMs,
      ok: true,
    });
    const obs = buildRunObservation(
      input({
        agent: EvalAgent.GenexApp,
        eventLog: {
          events: [
            span("a", BuildSpanKind.ChatDelegation, 0, 60_000),
            span("b", BuildSpanKind.ChatDelegation, 70_000, 90_000),
            span("c", BuildSpanKind.Facet, 10_000, 40_000),
            span("d", BuildSpanKind.Facet, 50_000, null),
          ],
          trace: { parseFailures: 0, partialTail: false, sawTerminal: true },
        },
      }),
    );
    const time = timeMetrics(obs);
    assert.deepEqual(time.builds, [
      { kind: BuildSpanKind.ChatDelegation, ms: 60_000 },
      { kind: BuildSpanKind.Facet, ms: 30_000 },
      { kind: BuildSpanKind.ChatDelegation, ms: 20_000 },
    ]);
    assert.equal(time.delegationP50Ms, 40_000);
    assert.deepEqual([median([]), median([3]), median([1, 9, 5])], [null, 3, 5]);
  });
});

describe("tokens", () => {
  it("splits the normalized totals by role and by model with full coverage", async () => {
    const tokens = tokenMetrics(await claudeObservation());
    assert.deepEqual(tokens.byRole[TokenRole.Lead], {
      uncachedInput: 12,
      cacheWrite: 1690,
      cacheRead: 25900,
      output: 385,
      reasoning: 0,
    });
    assert.deepEqual(tokens.byRole[TokenRole.Subagents], {
      uncachedInput: 3,
      cacheWrite: 500,
      cacheRead: 0,
      output: 20,
      reasoning: 0,
    });
    assert.equal(tokens.byRole[TokenRole.Auxiliary]?.uncachedInput, 900);
    assert.deepEqual(Object.keys(tokens.byModel).sort(), ["claude-haiku-4-5-20251001", "claude-opus-5-5"]);
    assert.equal(tokens.uncachedInput, 12 + 3 + 900);
    assert.equal(tokens.coverage, Coverage.Full);
  });

  it("sums Codex's main thread and sub-agent with cached tokens out of input", async () => {
    const tokens = tokenMetrics(await codexObservation());
    assert.deepEqual(tokens.byRole[TokenRole.Lead], {
      uncachedInput: 10000,
      cacheWrite: 0,
      cacheRead: 40000,
      output: 1200,
      reasoning: 300,
    });
    assert.deepEqual(tokens.byRole[TokenRole.Subagents], {
      uncachedInput: 6000,
      cacheWrite: 0,
      cacheRead: 2000,
      output: 300,
      reasoning: 50,
    });
    assert.equal(tokens.coverage, Coverage.Full);
  });

  it("marks a Genex lane partial-judges and a lane with no calls unmeasured", () => {
    const call: ModelCallEvent = {
      kind: ObservationEventKind.ModelCall,
      atMs: 1,
      source: ObservationSource.Transcript,
      id: "m",
      session: { sessionId: "s", parentSessionId: null, role: ServedModelRole.Main },
      model: "claude-opus-5-5",
      usage: { uncachedInput: 1, cacheWrite: 0, cacheRead: 0, output: 1, reasoning: 0 },
      contextTokens: 1,
      contextWindow: null,
      effortServed: null,
      endMs: null,
      ttftMs: null,
    };
    const genex = buildRunObservation(
      input({
        agent: EvalAgent.GenexApp,
        transcripts: { events: [call], trace: { parseFailures: 0, partialTail: false, sawTerminal: true } },
      }),
    );
    assert.equal(tokenMetrics(genex).coverage, Coverage.PartialJudges);
    assert.equal(tokenMetrics(buildRunObservation(input({}))).coverage, Coverage.Unmeasured);
  });

  it("marks a Genex lane full once its judges' completion_call usage reaches the timeline, and partial without it", () => {
    const usage = { uncachedInput: 1, cacheWrite: 0, cacheRead: 0, output: 1, reasoning: 0 };
    const call = (id: string, role: ServedModelRole, source: ObservationSource, used = usage): ModelCallEvent => ({
      kind: ObservationEventKind.ModelCall,
      atMs: 1,
      source,
      id,
      session: { sessionId: id, parentSessionId: null, role },
      model: "claude-opus-5-5",
      usage: used,
      contextTokens: 1,
      contextWindow: null,
      effortServed: null,
      endMs: null,
      ttftMs: null,
    });
    const trace = { parseFailures: 0, partialTail: false, sawTerminal: true };
    const lead = call("lead", ServedModelRole.Main, ObservationSource.Transcript);
    const genex = (judge: ModelCallEvent) =>
      buildRunObservation(
        input({
          agent: EvalAgent.GenexApp,
          transcripts: { events: [lead], trace },
          eventLog: { events: [judge], trace },
        }),
      );
    const measured = genex(call("judge", ServedModelRole.Judge, ObservationSource.EventLog));
    assert.equal(tokenMetrics(measured).coverage, Coverage.Full);
    const unmeasured = genex(
      call("judge", ServedModelRole.Judge, ObservationSource.EventLog, {
        uncachedInput: 0,
        cacheWrite: 0,
        cacheRead: 0,
        output: 0,
        reasoning: 0,
      }),
    );
    assert.equal(tokenMetrics(unmeasured).coverage, Coverage.PartialJudges);
  });

  describe("event-log critic calls beside transcript judges", () => {
    const trace = { parseFailures: 0, partialTail: false, sawTerminal: true };
    const usage = (n: number) => ({ uncachedInput: n, cacheWrite: 0, cacheRead: 0, output: n, reasoning: 0 });
    const call = (
      id: string,
      role: ServedModelRole,
      source: ObservationSource,
      n: number,
      engine?: EngineId,
    ): ModelCallEvent => ({
      kind: ObservationEventKind.ModelCall,
      atMs: 1,
      source,
      id,
      session: { sessionId: id, parentSessionId: null, role },
      model: "m",
      usage: usage(n),
      contextTokens: n,
      contextWindow: null,
      effortServed: null,
      endMs: null,
      ttftMs: null,
      ...(engine ? { engine } : {}),
    });
    const lead = call("lead", ServedModelRole.Main, ObservationSource.Transcript, 10);

    it("counts a Codex run's ephemeral critics although the playtester's rollout is a transcript judge", () => {
      const playtester = call("playtester", ServedModelRole.Judge, ObservationSource.Transcript, 5);
      const critics = ["c1", "c2"].map((id) =>
        call(id, ServedModelRole.Judge, ObservationSource.EventLog, 1000, EngineId.Codex),
      );
      const obs = buildRunObservation(
        input({
          agent: EvalAgent.GenexApp,
          engine: EngineId.Codex,
          transcripts: { events: [lead, playtester], trace, criticSessions: 0 },
          eventLog: { events: critics, trace },
        }),
      );
      assert.deepEqual(tokenMetrics(obs).byRole[TokenRole.Judges], usage(2005));
      assert.equal(callMetrics(obs).modelCalls, 4);
      assert.equal(tokenMetrics(obs).coverage, Coverage.Full);
    });

    it("counts a Claude run's critics once when their own sessions are in the transcripts", () => {
      const transcribed = ["c1", "c2"].map((id) => call(id, ServedModelRole.Judge, ObservationSource.Transcript, 7));
      const logged = ["e1", "e2"].map((id) =>
        call(id, ServedModelRole.Judge, ObservationSource.EventLog, 7, EngineId.ClaudeCode),
      );
      const obs = buildRunObservation(
        input({
          agent: EvalAgent.GenexApp,
          transcripts: { events: [lead, ...transcribed], trace, criticSessions: 2 },
          eventLog: { events: logged, trace },
        }),
      );
      assert.deepEqual(tokenMetrics(obs).byRole[TokenRole.Judges], usage(14));
      assert.equal(callMetrics(obs).modelCalls, 3);
    });

    it("counts a Claude run's logged critics when the transcripts hold only the playtester", () => {
      const playtester = call("playtester", ServedModelRole.Judge, ObservationSource.Transcript, 5);
      const logged = call("e1", ServedModelRole.Judge, ObservationSource.EventLog, 7, EngineId.ClaudeCode);
      const obs = buildRunObservation(
        input({
          agent: EvalAgent.GenexApp,
          transcripts: { events: [lead, playtester], trace, criticSessions: 0 },
          eventLog: { events: [logged], trace },
        }),
      );
      assert.deepEqual(tokenMetrics(obs).byRole[TokenRole.Judges], usage(12));
    });
  });
});

describe("the token cross-check (Rule 13)", () => {
  async function scaled(factor: number): Promise<RunObservation> {
    const obs = await claudeObservation();
    const timeline = obs.timeline.map((event) => {
      const isMain =
        event.kind === ObservationEventKind.ModelCall &&
        event.source === ObservationSource.Transcript &&
        event.session.role === ServedModelRole.Main;
      if (!isMain) return event;
      return { ...event, usage: { ...event.usage, cacheRead: Math.round(event.usage.cacheRead * factor) } };
    });
    return withTimeline(obs, timeline);
  }

  it("passes when the transcripts' main session matches the stream's totals", async () => {
    assert.equal(tokenCrossCheck(await claudeObservation()), null);
    assert.equal(tokenCrossCheck(await codexObservation()), null);
  });

  it("passes inside 2% and fails as token-mismatch outside it", async () => {
    assert.equal(tokenCrossCheck(await scaled(1.019)), null);
    assert.equal(tokenCrossCheck(await scaled(1.03)), HarnessFailure.TokenMismatch);
    assert.equal(tokenCrossCheck(await scaled(0.97)), HarnessFailure.TokenMismatch);
    assert.equal(runMetrics(await scaled(1.03), PRICES).harnessFailure, HarnessFailure.TokenMismatch);
  });

  it("types an engine fallback during the run as contamination: the lane ran another engine than its own", async () => {
    const obs = await claudeObservation();
    assert.equal(engineFallbackCheck(obs), null);
    const fellBack = withTimeline(obs, [
      ...obs.timeline,
      {
        kind: ObservationEventKind.Error,
        atMs: 1000,
        source: ObservationSource.EventLog,
        error: ObservedErrorKind.Fallback,
        httpStatus: null,
        session: null,
      },
    ]);
    assert.equal(engineFallbackCheck(fellBack), HarnessFailure.Contamination);
    assert.equal(runMetrics(fellBack, PRICES).harnessFailure, HarnessFailure.Contamination);
  });

  it("has nothing to check without a stream or without transcripts", async () => {
    const streamOnly = buildRunObservation(
      input({ stream: readClaudeStream(fixture("claude-stream.jsonl"), PROMPT_AT) }),
    );
    assert.equal(tokenCrossCheck(streamOnly), null);
  });
});

describe("context", () => {
  it("takes the lead's peak prompt over its window, and counts compactions once", async () => {
    const context = contextMetrics(await claudeObservation());
    assert.equal(context.leadPeakTokens, 6352);
    assert.equal(context.leadPeakPct, 0.6);
    assert.equal(context.workersPeakPct, null);
    assert.equal(context.compactions, 1, "the stream's and the transcript's record of one compaction are one");
    assert.equal(context.coverage, Coverage.Full);
  });

  it("reads Codex's context window from the rollout and Genex samples from the event log", async () => {
    const codex = contextMetrics(await codexObservation());
    assert.equal(codex.leadPeakTokens, 30000);
    assert.equal(codex.leadPeakPct, 11.6);
    const sample = (role: ServedModelRole, percent: number, tokens: number): ObservationEvent => ({
      kind: ObservationEventKind.ContextSample,
      atMs: 1,
      source: ObservationSource.EventLog,
      session: { sessionId: role, parentSessionId: null, role },
      tokens,
      percent,
      contextSource: "provider",
    });
    const genex = buildRunObservation(
      input({
        eventLog: {
          events: [
            sample(ServedModelRole.Main, 40, 80000),
            sample(ServedModelRole.Main, 55.55, 111100),
            sample(ServedModelRole.Worker, 62, 124000),
          ],
          trace: { parseFailures: 0, partialTail: false, sawTerminal: true },
        },
      }),
    );
    assert.deepEqual(contextMetrics(genex), {
      leadPeakPct: 55.6,
      leadPeakTokens: 111100,
      workersPeakPct: 62,
      compactions: 0,
      coverage: Coverage.Full,
    });
    assert.equal(contextMetrics(buildRunObservation(input({}))).coverage, Coverage.Unmeasured);
  });
});

describe("calls", () => {
  it("counts distinct model responses (not the helper aggregate), tools by category, streak and sub-agents", async () => {
    const calls = callMetrics(await claudeObservation());
    assert.equal(calls.modelCalls, 7);
    assert.deepEqual(calls.tools, {
      total: 6,
      byCategory: {
        [ToolCategory.Edit]: 2,
        [ToolCategory.Build]: 1,
        [ToolCategory.Subagent]: 1,
        [ToolCategory.Read]: 1,
        [ToolCategory.Browser]: 1,
      },
    });
    assert.equal(calls.blindEditStreak, 2);
    assert.equal(calls.subagents, 1);
    assert.equal(calls.verifiedBeforeDone, true);
    assert.equal(calls.coverage, Coverage.Full);
  });

  it("breaks an edit streak only on a build, a test or a browser look", () => {
    const streak = blindEditStreak([
      tool("1", 1, ToolCategory.Edit),
      tool("2", 2, ToolCategory.Edit),
      tool("3", 3, ToolCategory.Read),
      tool("4", 4, ToolCategory.Edit),
      tool("5", 5, ToolCategory.Build),
      tool("6", 6, ToolCategory.Edit),
      tool("7", 7, ToolCategory.Browser),
      tool("8", 8, ToolCategory.Edit),
    ]);
    assert.equal(streak, 3);
  });

  it("gates verifiedBeforeDone on agent-finished and a clean trace (Rule 3)", async () => {
    const obs = await claudeObservation();
    const edits = Array.from({ length: 10 }, (_, i) => tool(`e${i}`, i, ToolCategory.Edit));
    const rows: Array<[string, RunObservation, ToolCallEvent[], boolean | null]> = [
      ["ten edits, no build", obs, edits, false],
      ["ten edits and a build", obs, [...edits, tool("b", 99, ToolCategory.Build)], true],
      ["nine edits, no build", obs, edits.slice(1), true],
      ["a deadline stop", { ...obs, endedHow: EndedHow.Deadline }, edits, null],
      [
        "a dirty trace",
        { ...obs, provenance: { ...obs.provenance, traceComplete: { parseFailures: 1, truncatedTail: false } } },
        edits,
        null,
      ],
    ];
    for (const [name, observation, tools, expected] of rows)
      assert.equal(verifiedBeforeDone(observation, tools), expected, name);
  });

  it("throws when the stream shows work but no model call was measured (the vacuity guard)", () => {
    const obs = buildRunObservation(
      input({ engine: EngineId.Codex, stream: readCodexStream(fixture("codex-stream.jsonl"), PROMPT_AT) }),
    );
    assert.throws(
      () => callMetrics(obs),
      (error: unknown) => error instanceof CollectError && error.code === CollectErrorCode.VacuousModelCalls,
    );
    const quiet = callMetrics(buildRunObservation(input({})));
    assert.deepEqual([quiet.modelCalls, quiet.coverage], [null, Coverage.Unmeasured]);
  });
});

describe("cost and served models", () => {
  it("prices every model's tokens with the table, the dated helper id at its family's price (Rule 15)", async () => {
    const obs = await claudeObservation();
    const opus = (15 * 4 + 2190 * 5 + 25900 * 0.2 + 405 * 20) / 1e6;
    const haiku = (900 * 1 + 12 * 5) / 1e6;
    const cost = runMetrics(obs, PRICES).cost;
    assert.ok(isMeasured(cost.apiEquivalentUsd));
    assert.equal(
      typeof cost.apiEquivalentUsd === "number" && Math.abs(cost.apiEquivalentUsd - (opus + haiku)) < 1e-4,
      true,
    );
    assert.deepEqual([cost.priceTable, cost.cliReportedUsd, cost.billed], ["2026-09-25", 0.5, null]);
  });

  it("is unavailable with a typed reason for an unknown price or no calls, never zero", async () => {
    assert.deepEqual(apiEquivalentCost(await codexObservation(), PRICES), unavailable(UnavailableReason.PriceUnknown));
    assert.deepEqual(
      apiEquivalentCost(buildRunObservation(input({})), PRICES),
      unavailable(UnavailableReason.NotRecorded),
    );
  });

  it("lists every served model by role; only the main loop's model can fail the run (Rule 16)", async () => {
    const obs = await claudeObservation();
    assert.deepEqual(
      servedModels(obs).map((m) => [m.id, m.role]),
      [
        ["claude-opus-5-5", ServedModelRole.Main],
        ["claude-haiku-4-5-20251001", ServedModelRole.Auxiliary],
        ["claude-opus-5-5", ServedModelRole.Subagent],
      ],
    );
    const served = (servedMain: string | null) =>
      servedModelCheck({ ...obs, provenance: { ...obs.provenance, servedMain } });
    assert.equal(served("claude-opus-5-5"), null);
    assert.equal(served("claude-opus-5-5-20260901"), null);
    assert.equal(served(null), null);
    assert.equal(served("claude-sonnet-5-5"), HarnessFailure.ServedModelMismatch);
  });

  it("accepts the context-tagged and dated ids the lane guard accepts, and only those", () => {
    const cases: ReadonlyArray<[served: string, same: boolean]> = [
      ["claude-opus-5-5", true],
      ["claude-opus-5-5[1m]", true],
      ["claude-opus-5-5-20260901", true],
      ["claude-opus-5-5-20260901[1m]", true],
      ["claude-sonnet-5-5[1m]", false],
      ["claude-opus-5-5-extra", false],
      ["claude-opus-5-5-2026090", false],
      ["claude-opus-5-5[1m]-20260901", false],
      ["xclaude-opus-5-5", false],
      ["claude-opus-5-5[1m][1m]", false],
      ["", false],
    ];
    for (const [served, same] of cases) {
      assert.equal(isSameModel("claude-opus-5-5", served), same, served);
      assert.equal(sameModel(served, "claude-opus-5-5"), same, `lane guard: ${served}`);
    }
    const obs = buildRunObservation(input({}));
    const check = (servedMain: string) =>
      servedModelCheck({ ...obs, modelRequested: "claude-opus-5-5", provenance: { ...obs.provenance, servedMain } });
    assert.equal(check("claude-opus-5-5[1m]"), null);
    assert.equal(check("claude-opus-5-5-20260901[1m]"), null);
    assert.equal(check("claude-sonnet-5-5[1m]"), HarnessFailure.ServedModelMismatch);
    assert.equal(check("claude-opus-5-5-extra"), HarnessFailure.ServedModelMismatch);
  });

  it("joins quota windows by id and flags a reset inside the run", () => {
    const before = {
      measuredAt: "2026-09-21T14:00:00Z",
      windows: [
        { id: "five-hour", label: "5h", percent: 20, resetsAt: "2026-09-21T16:00:00Z" },
        { id: "seven-day", label: "7d", percent: 50, resetsAt: "2026-09-25T00:00:00Z" },
      ],
    };
    const after = {
      measuredAt: "2026-09-21T17:00:00Z",
      windows: [
        { id: "five-hour", label: "5h", percent: 5, resetsAt: "2026-09-21T21:00:00Z" },
        { id: "seven-day", label: "7d", percent: 58, resetsAt: "2026-09-25T00:00:00Z" },
      ],
    };
    assert.deepEqual(
      quotaDeltas(before, after).map((d) => [d.windowId, d.before, d.after, d.resetInside]),
      [
        ["five-hour", 20, 5, true],
        ["seven-day", 50, 58, false],
      ],
    );
    assert.deepEqual(quotaDeltas(null, after), []);
  });
});

describe("the ToolCategory table", () => {
  it("classifies typed tool names, MCP servers and the unknown fallback", () => {
    const rows: Array<[string, string | null, ToolCategory]> = [
      ["Read", null, ToolCategory.Read],
      ["Grep", null, ToolCategory.Search],
      ["Write", null, ToolCategory.Edit],
      ["apply_patch", null, ToolCategory.Edit],
      ["Task", null, ToolCategory.Subagent],
      ["spawn_agent", null, ToolCategory.Subagent],
      ["WebFetch", null, ToolCategory.Web],
      ["TodoWrite", null, ToolCategory.Planning],
      ["Skill", null, ToolCategory.Skill],
      ["mcp__studio__capture", null, ToolCategory.Studio],
      ["mcp__playwright__browser_click", null, ToolCategory.Browser],
      ["mcp__other__generate", null, ToolCategory.Other],
      ["SomethingNew", null, ToolCategory.Other],
      ["Bash", "npm run build", ToolCategory.Build],
      ["Bash", "git status", ToolCategory.Shell],
    ];
    for (const [name, command, category] of rows) assert.equal(classifyTool(name, command), category, name);
  });

  it("classifies commands at command position only (the false-positive rows)", () => {
    const rows: Array<[string, ToolCategory]> = [
      ["npm run build", ToolCategory.Build],
      ["cd app && npm test", ToolCategory.Build],
      ["npm run build 2>&1 | tail -20", ToolCategory.Build],
      ["npx tsc --noEmit", ToolCategory.Build],
      ["npm install three", ToolCategory.Install],
      ["npm i -D vite", ToolCategory.Install],
      ["cat > src/a.ts <<'EOF'\nnpm run build\nnode .studio/bridge/tool.mjs capture\nEOF", ToolCategory.Edit],
      ["sed -i 's/a/b/' a.ts", ToolCategory.Edit],
      ["echo 'npm install' > notes.txt", ToolCategory.Edit],
      ["echo 'run npm test later'", ToolCategory.Shell],
      ["echo hi > /dev/null", ToolCategory.Shell],
      ["grep -r foo src", ToolCategory.Search],
      ["cat a.ts | grep x", ToolCategory.Search],
      ["cat package.json", ToolCategory.Read],
      ["sed -n 1,20p a.ts", ToolCategory.Read],
      ["curl -s http://127.0.0.1:5173/", ToolCategory.Web],
      ["node .studio/bridge/tool.mjs preview_ready", ToolCategory.Studio],
      ["look-at-page http://127.0.0.1:5173/", ToolCategory.Browser],
      ["/opt/tools/look-at-page http://127.0.0.1:5173/", ToolCategory.Browser],
      ["/bin/zsh -lc 'npm run build'", ToolCategory.Build],
      ["git status", ToolCategory.Shell],
      ["python3 -c 'print(1)'", ToolCategory.Shell],
    ];
    for (const [command, category] of rows) assert.equal(classifyCommand(command), category, command);
  });
});

describe("run metrics", () => {
  it("assembles every block for a finished raw Claude run with no guard tripped", async () => {
    const metrics = runMetrics(await claudeObservation(), PRICES);
    assert.equal(metrics.harnessFailure, null);
    assert.deepEqual(metrics.effortServed, unavailable(UnavailableReason.CliUnreported));
    assert.equal(metrics.calls.modelCalls, 7);
  });

  it("reports the served effort a Codex rollout recorded", async () => {
    assert.equal(runMetrics(await codexObservation(), PRICES).effortServed, "high");
  });

  it("keeps a source's trace reading apart from another's", () => {
    const dirty: TimelineReading = { events: [], trace: { parseFailures: 2, partialTail: false, sawTerminal: true } };
    const obs = buildRunObservation(input({ eventLog: dirty }));
    assert.deepEqual(obs.provenance.traceComplete, { parseFailures: 2, truncatedTail: false });
  });
});
