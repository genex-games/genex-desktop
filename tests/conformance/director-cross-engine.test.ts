/**
 * Two subscriptions in one Loop — through the real core and the real harness child. A lead on
 * Claude Code starts workers on Codex and asks Codex for a second opinion: every delegation and
 * every second opinion must reach the engine the roles named, with a model that engine knows and a
 * brief in that engine's own tool voice. And when the workers' engine hits its limit, that is the
 * workers' problem, not the lead's: the run does not pause, and the worker's end says why.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  EngineError,
  type CompleteRequest,
  type CompleteResponse,
  type DelegateRequest,
  type DelegateResult,
  type LiveToolResult,
} from "../../src/substrate/engines/types.ts";
import { customEvents, makeFakePreview, startRig, waitForLog, type Rig } from "../helpers/studio-rig.ts";
import { BRIDGE_TOOL_CMD } from "../../src/harness-seed/loop/model-roles.ts";

const rigs: Rig[] = [];
after(async () => {
  await Promise.all(rigs.map((rig) => rig.stop().catch(() => {})));
});

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);

/** A worker in its own copy of the integration branch: its title and its task. */
const copyWorker = (title: string, task: string) => ({ title, task, isolation: "copy" });

/**
 * A lead's turn on a web Loop: one worker in a copy, waited for and merged, a second opinion on the
 * merged build, and the finish. `before` reads the judge calls before the finish.
 */
async function leadOneWorker(
  call: (name: string, args: Record<string, unknown>) => Promise<string>,
  results: Record<string, any>,
  before: () => void,
): Promise<void> {
  results.status0 = JSON.parse(await call("run_status", {}));
  results.started = await call("worker_start", copyWorker("Plaza", "paint the plaza red"));
  results.waited = await call("worker_wait", { id: "w1", seconds: "120" });
  results.integrated = await call("worker_mark", { id: "w1", verdict: "used" });
  results.judged = await call("judge", { question: "is the plaza red?" });
  before();
  results.finished = await call("finish", { summary: "the plaza is red", land: "yes", victory: "yes" });
}

/** The live tools of a request, answering text. */
const liveCall = (request: DelegateRequest) => async (name: string, args: Record<string, unknown>) =>
  text(await request.onLiveTool!(name, args));

/** Two fake subscriptions, each counting what reached it. */
function twoEngines(rig: Rig, delegate: (engine: string, request: DelegateRequest) => Promise<DelegateResult>) {
  const completes: Record<string, CompleteRequest[]> = { "claude-code": [], codex: [] };
  for (const id of ["claude-code", "codex"]) {
    rig.core.engines.register({
      id,
      label: id,
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      complete: async (request: CompleteRequest): Promise<CompleteResponse> => {
        completes[id]!.push(request);
        return {
          message: { role: "assistant", content: '{"answer":"yes","pass":true}' },
          usage: {},
          model: request.model ?? "fixture",
          engine: id,
          stopReason: "stop",
        };
      },
      delegate: (request: DelegateRequest) => delegate(id, request),
    } as never);
  }
  return completes;
}

const ROLES = {
  planner: "opus",
  builder: "gpt-6-astra",
  judge: "gpt-6-astra",
  engines: { builder: "codex", judge: "codex" },
};

describe("a run on two subscriptions", () => {
  it("a Claude Code lead starts Codex workers and asks Codex for a second opinion, each in its own voice and on its own model", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("cross-smoke", { title: "Cross smoke" });
    const seen: Array<{ engine: string; request: DelegateRequest }> = [];
    const results: Record<string, any> = {};
    let completes: Record<string, CompleteRequest[]> = {};
    completes = twoEngines(rig, async (engine, request) => {
      seen.push({ engine, request });
      if (request.director) {
        await leadOneWorker(liveCall(request), results, () => {
          results.judgeCalls = {
            claude: completes["claude-code"]!.length,
            codex: completes.codex!.length,
            codexModels: completes.codex!.map((r) => r.model),
          };
        });
        return { ok: true, engine, turns: 7, usage: {}, sessionId: "director-cross", summary: "run done" };
      }
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'red';\n");
      return { ok: true, engine, turns: 3, usage: {}, sessionId: "worker-cross", summary: "painted the plaza red" };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a red plaza",
      project: project.name,
      mode: "autopilot",
      engine: "claude-code",
      model: "opus",
      roles: ROLES,
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "cross-engine run_finished",
    );

    // The run says who is on which subscription.
    const started = customEvents(events, "run_started").find((e) => e.runId === runId)!;
    assert.equal(started.engine, "claude-code");
    assert.equal(started.builderEngine, "codex");
    assert.equal(started.judgeEngine, "codex");
    assert.equal(started.judgeModel, "gpt-6-astra");
    assert.equal(started.model, "gpt-6-astra", "run.model is the workers' model");

    // The lead's session went to Claude Code, on the orchestrator's model, in Claude's voice.
    const directors = seen.filter((s) => s.request.director);
    assert.equal(directors.length, 1, "one lead session");
    assert.equal(directors[0]!.engine, "claude-code");
    assert.equal(directors[0]!.request.model, "opus");
    // Flipped (Loop phase 5): the lead's brief names its run tools plainly (worker_start), no mcp__ names.
    assert.match(directors[0]!.request.prompt, /\bworker_start\b/, "the lead reads its tools' names");
    assert.equal(directors[0]!.request.prompt.includes("tool.mjs"), false, "and never the bridge");
    // Flipped (Loop phase 5): a web Loop's finish asks no reviewer; its health check lands it.

    // The worker went to Codex, on the workers' model, in Codex's voice.
    const workers = seen.filter((s) => !s.request.director);
    assert.equal(workers.length, 1, `one worker session — worker_start answered ${results.started}`);
    assert.equal(workers[0]!.engine, "codex");
    assert.equal(workers[0]!.request.model, "gpt-6-astra");
    // Flipped (Loop phase 5): a worker's brief is the pool's, the same on every engine: it names its
    // tools plainly (plugins_find), neither the bridge command nor an mcp__ name.
    assert.match(workers[0]!.request.prompt, /\bplugins_find\b/, "the worker reads its tools' names");
    assert.equal(workers[0]!.request.prompt.includes(BRIDGE_TOOL_CMD), false, "never the bridge command");
    assert.equal(workers[0]!.request.prompt.includes("mcp__studio__"), false, "and never an mcp__ name");
    assert.match(results.waited, /w1 · Plaza · copy · done/, results.waited);
    assert.match(results.integrated, /^Merged w1's work into your folder/, results.integrated);

    // The second opinion went to Codex, on the judges' model; Claude Code judged nothing.
    assert.match(results.judged, /Second opinion: /, results.judged);
    assert.ok(results.judgeCalls.codex >= 1, "the second opinion ran on Codex");
    assert.ok(
      (results.judgeCalls.codexModels as string[]).every((m) => m === "gpt-6-astra"),
      `judge models: ${results.judgeCalls.codexModels.join(",")}`,
    );
    assert.equal(results.judgeCalls.claude, 0, "no judge call reached Claude Code");

    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, true, String(finished.stoppedBecause));
  });

  it("the workers' engine running out is the workers' problem: the run keeps going and the worker's end names the limit", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("cross-limit", { title: "Cross limit" });
    const results: Record<string, any> = {};
    twoEngines(rig, async (engine, request) => {
      if (request.director) {
        const call = liveCall(request);
        results.started = await call("worker_start", copyWorker("Sign", "hang a sign"));
        results.waited = await call("worker_wait", { id: "w1", seconds: "120" });
        results.status1 = JSON.parse(await call("run_status", {}));
        results.finished = await call("finish", { summary: "Codex is out of usage; nothing to land", land: "no" });
        return { ok: true, engine, turns: 4, usage: {}, sessionId: "director-limit", summary: "finished" };
      }
      // Codex's own limit, as its CLI reports it: the usage cap, resetting three hours away.
      throw new EngineError("usage_limit", "codex", "You've hit your usage limit · resets 6pm", 3 * 3_600_000);
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a sign",
      project: project.name,
      mode: "autopilot",
      engine: "claude-code",
      model: "opus",
      roles: ROLES,
      reference: { name: "sign", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "cross-engine run_finished after the workers' limit",
    );

    assert.match(results.started, /^Started w1 \(copy\)/, results.started);
    // Flipped (Loop phase 5): run_status no longer carries a workers' engine limit of its own; the
    // worker's end says the engine's words, and the run goes on.
    assert.deepEqual(
      results.status1.workers.map((worker: { id: string; state: string }) => [worker.id, worker.state]),
      [["w1", "failed"]],
    );
    assert.match(results.waited, /w1 · Sign · copy · failed[\s\S]*usage limit/, results.waited);

    // Not the director's limit: the run finished on its own word, and was never paused.
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.limit, undefined, JSON.stringify(finished.limit));
    assert.doesNotMatch(String(finished.stoppedBecause), /usage cap|session limit|paused/);
    assert.equal(
      customEvents(events, "autopilot_paused").some((e) => e.runId === runId),
      false,
      "the run is done, not paused",
    );
  });

  it("a Claude Code lead with Ollama judges: every second opinion reaches the local engine on the judges' model, and no session is asked of it", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("local-reviewers", { title: "Local reviewers" });
    const seen: Array<{ engine: string; request: DelegateRequest }> = [];
    const results: Record<string, any> = {};
    const completes = twoEngines(rig, async (engine, request) => {
      seen.push({ engine, request });
      if (request.director) {
        await leadOneWorker(liveCall(request), results, () => {
          results.judgeCalls = { claude: completes["claude-code"]!.length, local: local.map((r) => r.model) };
        });
        return { ok: true, engine, turns: 7, usage: {}, sessionId: "director-local", summary: "run done" };
      }
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'red';\n");
      return { ok: true, engine, turns: 3, usage: {}, sessionId: "worker-local", summary: "painted the plaza red" };
    });
    // Ollama as it is: completions with tools and images, and no sessions at all.
    const local: CompleteRequest[] = [];
    rig.core.engines.register({
      id: "ollama",
      label: "Ollama",
      kind: "direct",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [{ id: "vl", label: "vl", contextWindow: 32_000, supportsTools: true, supportsVision: true }],
      defaultModel: async () => "vl",
      complete: async (request: CompleteRequest): Promise<CompleteResponse> => {
        local.push(request);
        return {
          message: { role: "assistant", content: '{"answer":"yes","pass":true}' },
          usage: {},
          model: request.model ?? "vl",
          engine: "ollama",
          stopReason: "stop",
        };
      },
    } as never);

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a red plaza",
      project: project.name,
      mode: "autopilot",
      engine: "claude-code",
      model: "opus",
      roles: { planner: "opus", builder: "opus", judge: "vl", engines: { judge: "ollama" } },
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "local-reviewers run_finished",
    );

    const started = customEvents(events, "run_started").find((e) => e.runId === runId)!;
    assert.equal(started.engine, "claude-code");
    assert.equal(started.builderEngine, undefined, "the workers stay on the lead's engine");
    assert.equal(started.judgeEngine, "ollama");
    assert.equal(started.judgeModel, "vl");
    assert.ok(
      seen.every((s) => s.engine === "claude-code"),
      "every session went to Claude Code; none was asked of Ollama",
    );
    assert.equal(seen.filter((s) => !s.request.director)[0]?.request.model, "opus", "the worker builds on opus");
    // Flipped (Loop phase 5): no reviewer reads a web Loop's finish, on any engine.
    assert.match(results.judged, /Second opinion: /, results.judged);
    assert.ok((results.judgeCalls.local as string[]).length >= 1, "the second opinion ran on Ollama");
    assert.ok(
      (results.judgeCalls.local as string[]).every((m) => m === "vl"),
      `judge models: ${results.judgeCalls.local.join(",")}`,
    );
    assert.equal(results.judgeCalls.claude, 0, "no judge call reached Claude Code");
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, true, String(finished.stoppedBecause));
  });
});
