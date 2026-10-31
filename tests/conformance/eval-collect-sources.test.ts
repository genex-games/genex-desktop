/**
 * The eval collectors' file sources: Codex rollouts chained by `parent_thread_id` and summed, the
 * eval homes' transcripts filtered by folder and time and split by role, and the Genex event log
 * read through the app's `EventStore` without a single write. Path boundaries get hostile-input
 * tables (a symlinked folder, a symlinked file, a home whose `sessions`/`projects` points outside)
 * that assert nothing outside the home is read and nothing anywhere is written.
 * Hermetic: synthetic fixtures and temporary folders only.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  chainOf,
  codexRun,
  listRollouts,
  readRollout,
  readRollouts,
} from "../../scripts/evals/collect/codex-subagents.ts";
import {
  DELEGATE_TOOL,
  genexEventsOf,
  readEventLog,
  readGenexEvents,
} from "../../scripts/evals/collect/genex-events.ts";
import type { ObservationEvent } from "../../scripts/evals/collect/observation.ts";
import {
  listClaudeTranscripts,
  readTranscripts,
  servedRoleOf,
  type TranscriptOptions,
} from "../../scripts/evals/collect/transcripts.ts";
import {
  BuildSpanKind,
  ObservationEventKind,
  PreviewSignal,
  QuestionKind,
  ServedModelRole,
  ToolCategory,
} from "../../scripts/evals/vocabulary.ts";
import { PlanReviewState } from "../../src/shared/composer.ts";
import { ContextSource } from "../../src/shared/context.ts";
import {
  CompletionRole,
  CustomEvent,
  DELEGATED_PREFIX,
  StopCode,
  customEventData,
} from "../../src/shared/custom-events.ts";
import { EventKind, type EventData, type EventEnvelope, MessageUsageSource } from "../../src/shared/event-log.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { ExecutionStatus } from "../../src/shared/run-state.ts";
import { EventStore } from "../../src/substrate/event-store.ts";
import { createUuidv7Generator } from "../../src/substrate/ids.ts";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures/evals/collect");
const PROMPT_AT = 1_790_000_000_000;
const HOUR_MS = 3_600_000;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "eval-collect-"));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const ofKind = <K extends ObservationEvent["kind"]>(events: ObservationEvent[], kind: K) =>
  events.filter((event): event is Extract<ObservationEvent, { kind: K }> => event.kind === kind);

/** Every path under a folder with its size and mtime, symlinks not followed: a write anywhere changes it. */
function tree(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (at: string) => {
    for (const name of fs.readdirSync(at).sort()) {
      const full = path.join(at, name);
      const stat = fs.lstatSync(full);
      out.push(`${path.relative(dir, full)}:${stat.size}:${stat.mtimeMs}`);
      if (stat.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out;
}

describe("Codex rollouts", () => {
  const home = path.join(FIXTURES, "codex-home");

  it("reads a rollout's own session_meta, not the parent's replayed one, and one call per token growth", () => {
    const file = path.join(home, "sessions/2026/09/21/rollout-2026-09-21T14-13-24-thr-sub.jsonl");
    const sub = readRollout(fs.readFileSync(file, "utf8"), file, PROMPT_AT);
    assert.equal(sub.sessionId, "thr-sub");
    assert.equal(sub.parentSessionId, "thr-main");
    assert.equal(sub.file, path.basename(file));
    assert.equal(sub.model, "gpt-6.1-sol");
    assert.equal(sub.effort, "high");
    assert.deepEqual(
      sub.calls.map((call) => [call.session.role, call.usage.uncachedInput, call.usage.cacheRead]),
      [[ServedModelRole.Subagent, 6000, 2000]],
    );
    assert.deepEqual(
      sub.tools.map((tool) => [tool.name, tool.category, tool.endMs]),
      [
        ["exec", ToolCategory.Shell, 5500],
        ["shell", ToolCategory.Build, 8000],
      ],
    );
  });

  it("chains the sub-agent to the main thread, leaves the unrelated thread out and sums the finals", async () => {
    const rollouts = await readRollouts(home, PROMPT_AT);
    assert.equal(rollouts.length, 3);
    assert.deepEqual(
      chainOf(rollouts, "thr-main").map((r) => r.sessionId),
      ["thr-main", "thr-sub"],
    );
    const run = codexRun(rollouts, "thr-main");
    assert.deepEqual(run.total, {
      uncachedInput: 16000,
      cacheWrite: 0,
      cacheRead: 42000,
      output: 1500,
      reasoning: 350,
    });
    assert.equal(run.servedMain, "gpt-6.1-sol");
    assert.equal(run.effortServed, "high");
    assert.equal(run.cliVersion, "0.160.0");
    const calls = ofKind(run.events, ObservationEventKind.ModelCall);
    assert.equal(calls.length, 3, "a repeated token_count with no growth is not a call");
    assert.deepEqual(
      calls.filter((c) => c.session.role === ServedModelRole.Main).map((c) => c.contextWindow),
      [258400, 258400],
    );
    assert.deepEqual(
      ofKind(run.events, ObservationEventKind.Compaction).map((c) => c.atMs),
      [15000],
    );
    assert.deepEqual(
      ofKind(run.events, ObservationEventKind.ToolCall).map((t) => t.session.sessionId),
      ["thr-sub", "thr-sub"],
    );
    assert.deepEqual(codexRun(rollouts, "no-such-thread").chain, []);
  });

  it("counts a torn last line as a truncated tail and a bad middle line as a parse failure", () => {
    const read = readRollout('{"type":"session_meta","payload":{"id":"x"}}\nnot json\n{"type":', "r.jsonl", PROMPT_AT);
    assert.deepEqual(read.trace, { parseFailures: 1, partialTail: true, sawTerminal: true });
  });
});

describe("path boundaries: nothing outside the eval home is read, nothing is written", () => {
  const outside = path.join(scratch, "outside");
  const rollout = fs.readFileSync(
    path.join(FIXTURES, "codex-home/sessions/2026/09/21/rollout-2026-09-21T14-13-20-thr-main.jsonl"),
    "utf8",
  );
  fs.mkdirSync(path.join(outside, "sessions/2026"), { recursive: true });
  fs.mkdirSync(path.join(outside, "projects/-x"), { recursive: true });
  fs.writeFileSync(path.join(outside, "sessions/2026/rollout-outside.jsonl"), rollout);
  fs.writeFileSync(path.join(outside, "rollout-outside.jsonl"), rollout);
  fs.writeFileSync(path.join(outside, "projects/-x/s.jsonl"), "{}\n");

  const homes: Array<[string, (home: string) => void]> = [
    [
      "the whole sessions folder is a symlink out",
      (home) => fs.symlinkSync(path.join(outside, "sessions"), path.join(home, "sessions")),
    ],
    [
      "a dated folder inside sessions is a symlink out",
      (home) => {
        fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
        fs.symlinkSync(path.join(outside, "sessions/2026"), path.join(home, "sessions/2026"));
      },
    ],
    [
      "a rollout file is a symlink out",
      (home) => {
        fs.mkdirSync(path.join(home, "sessions/2026/09/21"), { recursive: true });
        fs.symlinkSync(
          path.join(outside, "rollout-outside.jsonl"),
          path.join(home, "sessions/2026/09/21/rollout-link.jsonl"),
        );
      },
    ],
    ["the home has no sessions folder", () => {}],
  ];
  homes.forEach(([name, build], index) => {
    it(`Codex: ${name}`, async () => {
      const home = path.join(scratch, `codex-${index}`);
      fs.mkdirSync(home);
      build(home);
      const before = [tree(home), tree(outside)];
      assert.deepEqual(await listRollouts(home), []);
      assert.deepEqual(await readRollouts(home, PROMPT_AT), []);
      assert.deepEqual([tree(home), tree(outside)], before);
    });
  });

  const claudeHomes: Array<[string, (home: string) => void]> = [
    [
      "the projects folder is a symlink out",
      (home) => fs.symlinkSync(path.join(outside, "projects"), path.join(home, "projects")),
    ],
    [
      "a project folder is a symlink out",
      (home) => {
        fs.mkdirSync(path.join(home, "projects"));
        fs.symlinkSync(path.join(outside, "projects/-x"), path.join(home, "projects/-x"));
      },
    ],
    [
      "a transcript is a symlink out",
      (home) => {
        fs.mkdirSync(path.join(home, "projects/-y"), { recursive: true });
        fs.symlinkSync(path.join(outside, "projects/-x/s.jsonl"), path.join(home, "projects/-y/s.jsonl"));
      },
    ],
  ];
  claudeHomes.forEach(([name, build], index) => {
    it(`Claude: ${name}`, async () => {
      const home = path.join(scratch, `claude-${index}`);
      fs.mkdirSync(home);
      build(home);
      const before = [tree(home), tree(outside)];
      assert.deepEqual(await listClaudeTranscripts(home), []);
      assert.deepEqual([tree(home), tree(outside)], before);
    });
  });
});

describe("transcripts in the eval homes", () => {
  const window = { startMs: PROMPT_AT - 1000, endMs: PROMPT_AT + HOUR_MS };
  const options = (engine: EngineId, home: string, leadSessionId: string | null): TranscriptOptions => ({
    engine,
    home: path.join(FIXTURES, home),
    roots: ["/work/run"],
    window,
    promptAtMs: PROMPT_AT,
    leadSessionId,
  });

  it("Claude: counts the run's main session and its side chain, drops another folder's and an earlier one", async () => {
    const read = await readTranscripts(options(EngineId.ClaudeCode, "claude-home", "sess-main"));
    assert.equal(read.dropped, 2);
    assert.deepEqual(read.sessions.map((s) => [s.file, s.role, s.calls]).sort(), [
      ["agent-a1.jsonl", ServedModelRole.Subagent, 1],
      ["sess-main.jsonl", ServedModelRole.Main, 6],
    ]);
    const main = ofKind(read.events, ObservationEventKind.ModelCall).filter(
      (c) => c.session.role === ServedModelRole.Main,
    );
    const output = main.reduce((sum, call) => sum + call.usage.output, 0);
    assert.equal(output, 385, "each message keeps its final output count, once");
    assert.equal(read.servedMain, "claude-opus-5-5");
    assert.deepEqual(
      ofKind(read.events, ObservationEventKind.Compaction).map((c) => c.atMs),
      [12500],
    );
  });

  it("Claude: the main loop's model is served main even when a sub-agent on another model is read first", async () => {
    const home = path.join(scratch, "claude-home-haiku-subagent");
    fs.cpSync(path.join(FIXTURES, "claude-home"), home, { recursive: true });
    const agent = path.join(home, "projects/-work-run-project/sess-main/subagents/agent-a1.jsonl");
    fs.writeFileSync(
      agent,
      fs.readFileSync(agent, "utf8").replaceAll('"model":"claude-opus-5-5"', '"model":"claude-haiku-4-5-20251001"'),
    );
    for (const lead of ["sess-main", null]) {
      const read = await readTranscripts({ ...options(EngineId.ClaudeCode, "claude-home", lead), home });
      assert.equal(read.servedMain, "claude-opus-5-5", `lead ${lead}`);
      const subagent = read.sessions.find((session) => session.file === "agent-a1.jsonl");
      assert.equal(subagent?.role, ServedModelRole.Subagent, `lead ${lead}`);
    }
  });

  it("counts a studio scratch session (judge, playtester) only for a Genex lane, and only inside its own run", async () => {
    const SCRATCH_TMP = "/scratch-tmp";
    const rows = [
      [EngineId.ClaudeCode, "claude-home", "sess-main", "studio-judge-sessions", "sess-other.jsonl"],
      [EngineId.Codex, "codex-home", "thr-main", "studio-playtest-x1", "rollout-2026-09-21T14-13-20-thr-other.jsonl"],
    ] as const;
    for (const [engine, name, lead, folder, file] of rows) {
      const home = path.join(scratch, `scratch-${name}`);
      fs.cpSync(path.join(FIXTURES, name), home, { recursive: true });
      const other = fs
        .readdirSync(home, { recursive: true, withFileTypes: true })
        .find((entry) => entry.isFile() && entry.name === file);
      assert.ok(other, file);
      const at = path.join(other.parentPath, other.name);
      fs.writeFileSync(
        at,
        fs.readFileSync(at, "utf8").replaceAll('"/elsewhere/project"', `"${SCRATCH_TMP}/${folder}"`),
      );
      const base = { ...options(engine, name, lead), home, tmpDir: SCRATCH_TMP };
      const counted = (read: Awaited<ReturnType<typeof readTranscripts>>) =>
        read.sessions.some((session) => session.file === file);
      const raw = await readTranscripts(base);
      assert.equal(counted(raw), false, `${name}: a raw lane never counts a studio scratch session`);
      const genex = await readTranscripts({ ...base, scratch: { startMs: PROMPT_AT, endMs: PROMPT_AT + HOUR_MS } });
      assert.equal(counted(genex), true, `${name}: a Genex lane counts its own judge or playtester`);
      const later = await readTranscripts({
        ...base,
        scratch: { startMs: PROMPT_AT + 5000, endMs: PROMPT_AT + HOUR_MS },
      });
      assert.equal(counted(later), false, `${name}: a scratch session from before the run's prompt is another run's`);
    }
  });

  it("Codex: counts the main thread and its sub-agent with their roles; the other folder's thread is dropped", async () => {
    const read = await readTranscripts(options(EngineId.Codex, "codex-home", "thr-main"));
    assert.equal(read.dropped, 1);
    assert.deepEqual(read.sessions.map((s) => [s.sessionId, s.role]).sort(), [
      ["thr-main", ServedModelRole.Main],
      ["thr-sub", ServedModelRole.Subagent],
    ]);
    assert.equal(read.servedMain, "gpt-6.1-sol");
    assert.equal(read.cliVersion, "0.160.0");
    assert.equal(read.effortServed, "high");
    assert.equal(
      ofKind(read.events, ObservationEventKind.ToolCall).length,
      2,
      "only the sub-agent's tools; the stream has the main thread's",
    );
  });

  it("maps census roles to served roles", () => {
    const rows: Array<[Parameters<typeof servedRoleOf>[0], ServedModelRole]> = [
      ["other", ServedModelRole.Main],
      ["director", ServedModelRole.Main],
      ["worker:facet", ServedModelRole.Worker],
      ["judge:taste", ServedModelRole.Judge],
      ["playtester", ServedModelRole.Judge],
      ["coordinator:intake", ServedModelRole.Auxiliary],
      ["ledger:lessons", ServedModelRole.Auxiliary],
    ];
    for (const [role, served] of rows) assert.equal(servedRoleOf(role), served, role);
  });

  it("reads nothing for an engine without transcripts", async () => {
    const read = await readTranscripts(options(EngineId.Ollama, "claude-home", null));
    assert.deepEqual(read.sessions, []);
    assert.equal(read.sha256, null);
  });
});

describe("the counted transcripts' digest", () => {
  const window = { startMs: PROMPT_AT - 1000, endMs: PROMPT_AT + HOUR_MS };
  const at = (engine: EngineId, home: string, lead: string): TranscriptOptions => ({
    engine,
    home,
    roots: ["/work/run"],
    window,
    promptAtMs: PROMPT_AT,
    leadSessionId: lead,
  });

  it("digests the run's counted transcripts wherever the home is, and moves when one of them changes", async () => {
    for (const [engine, name, lead] of [
      [EngineId.ClaudeCode, "claude-home", "sess-main"],
      [EngineId.Codex, "codex-home", "thr-main"],
    ] as const) {
      const copy = path.join(scratch, `digest-${name}`);
      fs.cpSync(path.join(FIXTURES, name), copy, { recursive: true });
      const original = await readTranscripts(at(engine, path.join(FIXTURES, name), lead));
      assert.match(original.sha256 ?? "", /^[0-9a-f]{64}$/, name);
      assert.equal((await readTranscripts(at(engine, copy, lead))).sha256, original.sha256, name);
      const counted = fs
        .readdirSync(copy, { recursive: true, withFileTypes: true })
        .find((entry) => entry.isFile() && entry.name.includes(lead));
      assert.ok(counted, name);
      fs.appendFileSync(path.join(counted.parentPath, counted.name), "\n");
      assert.notEqual((await readTranscripts(at(engine, copy, lead))).sha256, original.sha256, name);
    }
  });

  it("is null when the home holds no transcript of the run", async () => {
    const empty = path.join(scratch, "digest-empty");
    fs.mkdirSync(empty, { recursive: true });
    assert.equal((await readTranscripts(at(EngineId.ClaudeCode, empty, "sess-main"))).sha256, null);
  });
});

describe("Genex event log", () => {
  const root = path.join(scratch, "exoharness");
  let clock = PROMPT_AT;
  const at = (ms: number) => {
    clock = PROMPT_AT + ms;
  };
  const delegated = (payload: Record<string, unknown>): EventData => ({
    type: EventKind.Custom,
    event_type: `${DELEGATED_PREFIX}${EngineId.ClaudeCode}`,
    payload,
  });
  const script: Array<[number, EventData]> = [
    [1000, { type: EventKind.ToolRequested, tool_call_id: "dlg_1", request: { name: DELEGATE_TOOL, arguments: {} } }],
    [
      2000,
      delegated({
        data: {
          session_id: "s-chat",
          parts: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "npm run build" } }],
        },
      }),
    ],
    [
      3000,
      delegated({
        data: { session_id: "s-chat", parts: [{ type: "tool_result", tool_use_id: "tu_1", is_error: true }] },
      }),
    ],
    [
      4000,
      delegated({
        data: {
          session_id: "s-chat",
          parts: [{ type: "tool_use", id: "tu_2", name: "mcp__studio__checkpoint", input: {} }],
        },
      }),
    ],
    [
      4500,
      delegated({
        data: {
          session_id: "s-chat",
          parts: [{ type: "tool_use", id: "tu_3", name: "mcp__studio__capture", input: {} }],
        },
      }),
    ],
    [
      5000,
      customEventData(CustomEvent.ContextUsage, {
        engine: EngineId.ClaudeCode,
        sessionId: "s-chat",
        role: "planner",
        promptTokens: 50000,
        percent: 25,
        contextWindow: 200000,
        source: ContextSource.Provider,
      }),
    ],
    [
      6000,
      customEventData(CustomEvent.Compacted, { engine: EngineId.ClaudeCode, sessionId: "s-chat", role: "planner" }),
    ],
    [7000, customEventData(CustomEvent.InterviewQuestion, { question: "q" })],
    [8000, customEventData(CustomEvent.PlanReview, { id: "pr1", state: PlanReviewState.Generating, text: "" })],
    [8100, customEventData(CustomEvent.PlanReview, { id: "pr1", state: PlanReviewState.Waiting, text: "plan" })],
    [8200, customEventData(CustomEvent.PlanReview, { id: "pr1", state: PlanReviewState.Waiting, text: "plan" })],
    [8300, customEventData(CustomEvent.PlanReview, { id: "pr1", state: PlanReviewState.Approved, text: "plan" })],
    [
      9000,
      customEventData(CustomEvent.RunRegistered, {
        runId: "run_a",
        project: "proj",
        budgets: { untilSatisfied: true },
      }),
    ],
    [
      9100,
      customEventData(CustomEvent.RunStarted, { runId: "run_a", project: "proj", budgets: { wallClockMs: HOUR_MS } }),
    ],
    [10000, customEventData(CustomEvent.FacetBuildStarted, { runId: "run_a", facetId: "f1", iteration: 1 })],
    [20000, customEventData(CustomEvent.FacetBuildStarted, { runId: "run_a", facetId: "f2", iteration: 1 })],
    [
      40000,
      customEventData(CustomEvent.FacetIteration, {
        runId: "run_a",
        facetId: "f1",
        iteration: 1,
        scoreboard: { passing: 3, total: 5, regressions: ["c1"] },
      }),
    ],
    [41000, customEventData(CustomEvent.FacetLiveness, { runId: "run_a", total: 12 })],
    [42000, customEventData(CustomEvent.FacetLiveness, { runId: "run_a", total: 17 })],
    [43000, customEventData(CustomEvent.AutopilotProviderOutage, { runId: "run_a", attempt: 2 })],
    [44000, customEventData(CustomEvent.NeedsSignin, { engine: EngineId.ClaudeCode })],
    [
      50000,
      customEventData(CustomEvent.RunFinished, {
        runId: "run_a",
        project: "proj",
        victory: true,
        executionStatus: ExecutionStatus.Completed,
        landed: true,
      }),
    ],
    [61000, { type: EventKind.ToolResult, tool_call_id: "dlg_1", result: { ok: true, content: "done" } }],
  ];

  async function writeLog(): Promise<void> {
    const store = await EventStore.open(root, "studio", { now: () => clock, ids: createUuidv7Generator() });
    const thread = await store.createThread({ title: "eval", threadId: "eval-thread" });
    for (const [ms, data] of script) {
      at(ms);
      await store.appendEvents(thread, [data]);
    }
  }

  it("reads the log without writing to it", async () => {
    await writeLog();
    const before = tree(root);
    const events = await readEventLog(root);
    assert.equal(events.length, script.length + 1, "the thread's creation record and every scripted event");
    assert.deepEqual(tree(root), before);
    const missing = path.join(scratch, "no-log");
    assert.deepEqual(await readEventLog(missing), []);
    assert.equal(fs.existsSync(missing), false, "reading a missing log creates nothing (EventStore.open would)");
  });

  it("finds the chat delegation and the finished facet build as spans; an unfinished one stays open", async () => {
    const read = await readGenexEvents(root, PROMPT_AT);
    const spans = ofKind(read.events, ObservationEventKind.BuildSpan);
    assert.deepEqual(
      spans.map((s) => [s.span, s.atMs, s.endMs, s.ok]),
      [
        [BuildSpanKind.ChatDelegation, 1000, 61000, true],
        [BuildSpanKind.Facet, 10000, 40000, null],
        [BuildSpanKind.Facet, 20000, null, null],
      ],
    );
  });

  it("reads context, compaction, questions, the preview proxy, contractor tools and provider errors", async () => {
    const read = await readGenexEvents(root, PROMPT_AT);
    const [sample] = ofKind(read.events, ObservationEventKind.ContextSample);
    assert.deepEqual(sample && [sample.session.role, sample.tokens, sample.percent, sample.contextSource], [
      ServedModelRole.Main,
      50000,
      25,
      ContextSource.Provider,
    ]);
    assert.deepEqual(
      ofKind(read.events, ObservationEventKind.Compaction).map((e) => e.atMs),
      [6000],
    );
    assert.deepEqual(
      ofKind(read.events, ObservationEventKind.Question).map((e) => [e.atMs, e.question]),
      [
        [7000, QuestionKind.AskUser],
        [8100, QuestionKind.PlanReview],
      ],
    );
    assert.deepEqual(
      ofKind(read.events, ObservationEventKind.PreviewSignal).map((e) => [e.atMs, e.signal]),
      [[4000, PreviewSignal.Checkpoint]],
    );
    assert.deepEqual(
      ofKind(read.events, ObservationEventKind.ToolCall).map((t) => [t.name, t.category, t.endMs, t.ok]),
      [
        ["Bash", ToolCategory.Build, 3000, false],
        ["mcp__studio__checkpoint", ToolCategory.Studio, null, null],
        ["mcp__studio__capture", ToolCategory.Studio, null, null],
      ],
    );
    assert.deepEqual(
      ofKind(read.events, ObservationEventKind.Retry).map((e) => e.attempt),
      [2],
    );
    assert.equal(ofKind(read.events, ObservationEventKind.Error).length, 1);
  });

  it("reports the in-app signals of the launched run from typed fields", async () => {
    const { inApp } = await readGenexEvents(root, PROMPT_AT);
    assert.deepEqual(inApp, {
      runIds: ["run_a"],
      budgets: { untilSatisfied: true, completionPolicy: "goal" },
      victory: true,
      executionStatus: ExecutionStatus.Completed,
      stopCode: null,
      livenessMax: 17,
      scoreboard: { passing: 3, total: 5, regressions: 1 },
      landed: true,
    });
  });

  it("reads the first preview_ready, the judges' completion calls by role, and a close's stop code", () => {
    const envelope = (ms: number, n: number, data: EventData): EventEnvelope => ({
      id: `evt_${String(n).padStart(3, "0")}`,
      thread_id: "eval-thread",
      session_id: null,
      turn_id: null,
      created_at: new Date(PROMPT_AT + ms).toISOString(),
      data,
    });
    const usage = { input_tokens: 1200, cache_read_tokens: 1000, output_tokens: 40, reasoning_tokens: 10 };
    const read = genexEventsOf(
      [
        envelope(3000, 1, customEventData(CustomEvent.PreviewReady, { project: "proj", ms: 900 })),
        envelope(5000, 2, customEventData(CustomEvent.PreviewReady, { project: "proj", ms: 400 })),
        envelope(
          9000,
          3,
          customEventData(CustomEvent.CompletionCall, {
            // An older record's role, which no caller names any more: still read as a judge's.
            role: "playtester" as never,
            runId: "run_a",
            engine: EngineId.Codex,
            model: "gpt-6.1-sol",
            usage,
            latencyMs: 2000,
          }),
        ),
        envelope(9500, 4, customEventData(CustomEvent.CompletionCall, { role: CompletionRole.Judge, model: "m" })),
        envelope(
          9900,
          5,
          customEventData(CustomEvent.RunFinished, { runId: "run_a", stopCode: StopCode.NoImprovement }),
        ),
      ],
      PROMPT_AT,
    );
    assert.deepEqual(
      ofKind(read.events, ObservationEventKind.PreviewSignal).map((e) => [e.atMs, e.signal]),
      [[3000, PreviewSignal.PreviewReady]],
    );
    const calls = ofKind(read.events, ObservationEventKind.ModelCall);
    assert.deepEqual(
      calls.map((call) => [call.atMs, call.endMs, call.session.role, call.model]),
      [[7000, 9000, ServedModelRole.Judge, "gpt-6.1-sol"]],
      "a call without usage is not a measured call",
    );
    assert.deepEqual(calls[0]?.usage, {
      uncachedInput: 200,
      cacheWrite: 0,
      cacheRead: 1000,
      output: 40,
      reasoning: 10,
    });
    assert.equal(calls[0]?.engine, EngineId.Codex, "the engine says whether a transcript also holds the call");
    assert.equal(read.inApp.stopCode, StopCode.NoImprovement);
  });

  it("adds up every model's totals from the chat's, the builds' and the judges' usage records", () => {
    const envelope = (n: number, data: EventData): EventEnvelope => ({
      id: `evt_${String(n).padStart(3, "0")}`,
      thread_id: "eval-thread",
      session_id: null,
      turn_id: null,
      created_at: new Date(PROMPT_AT + n * 100).toISOString(),
      data,
    });
    const row = (input: number, output: number, window?: number) => ({
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      ...(window ? { context_window: window } : {}),
    });
    const read = genexEventsOf(
      [
        envelope(1, {
          type: EventKind.Messages,
          messages: [{ role: "assistant", content: "ok" }],
          usage: {
            engine: EngineId.ClaudeCode,
            by_model: { opus: row(10, 1, 1_000_000), haiku: row(100, 2, 200_000) },
          },
        }),
        envelope(
          2,
          customEventData(CustomEvent.BuildObservation, {
            usage: { engine: EngineId.ClaudeCode, by_model: { opus: row(20, 2), haiku: row(50, 1) } },
          }),
        ),
        envelope(
          3,
          customEventData(CustomEvent.CompletionCall, {
            role: CompletionRole.Judge,
            engine: EngineId.ClaudeCode,
            model: "opus",
            usage: { input_tokens: 5, output_tokens: 1, by_model: { opus: row(5, 1) } },
          }),
        ),
        envelope(
          4,
          customEventData(CustomEvent.BuildObservation, { usage: { engine: EngineId.Codex, input_tokens: 9 } }),
        ),
      ],
      PROMPT_AT,
    );
    const usage = (input: number, output: number) => ({
      uncachedInput: input,
      cacheWrite: 0,
      cacheRead: 0,
      output,
      reasoning: 0,
    });
    assert.deepEqual(read.modelUsage, {
      opus: { usage: usage(35, 4), contextWindow: 1_000_000 },
      haiku: { usage: usage(150, 3), contextWindow: 200_000 },
    });
  });

  it("adds a delegated turn's contractor totals once, though its reply and its build record both carry them", () => {
    const row = (input: number, output: number) => ({
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
    const report = {
      engine: EngineId.ClaudeCode,
      ...row(100, 50),
      by_model: { opus: row(130, 70), haiku: row(10, 5) },
    };
    /** One delegated turn in the seed's order: the build record, then the reply with the same report. */
    const turn = (turnId: string, marker: { usage_source?: MessageUsageSource }): EventEnvelope[] =>
      [
        customEventData(CustomEvent.BuildObservation, { project: "demo", ok: true, usage: report }),
        {
          type: EventKind.Messages,
          messages: [{ role: "assistant", content: "built" }],
          usage: { ...report, model: "opus" },
          ...marker,
        } satisfies EventData,
      ].map((data, n) => ({
        id: `evt_${turnId}_${n}`,
        thread_id: "eval-thread",
        session_id: null,
        turn_id: turnId,
        created_at: new Date(PROMPT_AT + n * 100).toISOString(),
        data,
      }));
    const usage = (input: number, output: number) => ({
      uncachedInput: input,
      cacheWrite: 0,
      cacheRead: 0,
      output,
      reasoning: 0,
    });
    for (const marker of [{ usage_source: MessageUsageSource.Delegation }, {}]) {
      const read = genexEventsOf(turn("t1", marker), PROMPT_AT);
      assert.deepEqual(
        read.modelUsage,
        { opus: { usage: usage(130, 70), contextWindow: null }, haiku: { usage: usage(10, 5), contextWindow: null } },
        marker.usage_source ? "a marked reply" : "a reply from a seed before the marker",
      );
    }
  });

  it("reads an empty log as nothing, with a clean trace", () => {
    const read = genexEventsOf([], PROMPT_AT);
    assert.deepEqual(read.events, []);
    assert.equal(read.inApp.executionStatus, null);
    assert.deepEqual(read.trace, { parseFailures: 0, partialTail: false, sawTerminal: true });
  });
});
