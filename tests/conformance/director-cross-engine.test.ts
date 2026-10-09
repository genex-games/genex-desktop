/**
 * Two subscriptions in one run — through the real core and
 * the real harness child. A director on Claude Code hires workers on Codex and asks Codex to
 * judge: every delegation and every judge call must reach the engine the roles named, with a
 * model that engine knows and a brief in that engine's own tool voice. And when the workers'
 * engine hits its limit, that is the workers' problem, not the director's: the run does not
 * pause, and run_status says which engine is out and for how long.
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
const json = (result: LiveToolResult): Record<string, any> => JSON.parse(text(result));

const planFor = (...ids: string[]): Record<string, unknown> => ({
  summary: "This run: make the plaza somewhere you would want to skate.",
  workers: JSON.stringify(
    ids.map((id) => ({
      id,
      title: id,
      seam: `the ${id}`,
      owns: `src/${id}.js`,
      done: [`the ${id} is there to see`],
      minutes: 20,
    })),
  ),
  base: "the integration branch as it stands",
  risks: "one window at a time on this machine",
});

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
  it("a Claude Code director hires Codex workers and Codex judges, each in its own voice and on its own model", async () => {
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
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        results.status0 = json(await call("run_status", {}));
        results.planned = text(await call("plan", planFor("plaza")));
        results.started = json(
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "paint the plaza red",
            mode: "single",
            minutes: "5",
            owns: "src/plaza.js",
          }),
        );
        for (let i = 0; i < 30; i++) {
          results.waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
          if (results.waited.status.workers[0]?.state !== "running") break;
        }
        results.integrated = json(await call("integrate", { worker: "plaza" }));
        results.judged = json(
          await call("judge", { target: "integration", against: "none", question: "is the plaza red?" }),
        );
        // Counted here, inside the run: the self-improvement pass that follows a finished run
        // asks the run's own engine by design, and is not a judge call.
        results.judgeCalls = {
          claude: completes["claude-code"]!.length,
          codex: completes.codex!.length,
          codexModels: completes.codex!.map((r) => r.model),
        };
        results.finished = text(await call("finish", { summary: "the plaza is red", land: "yes", victory: "yes" }));
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

    // The director's session went to Claude Code, on the orchestrator's model, in Claude's voice.
    const directors = seen.filter((s) => s.request.director);
    assert.equal(directors.length, 1, "one director session");
    assert.equal(directors[0]!.engine, "claude-code");
    assert.equal(directors[0]!.request.model, "opus");
    assert.ok(directors[0]!.request.prompt.includes("mcp__studio__"), "the director reads mcp__ names");
    assert.equal(directors[0]!.request.prompt.includes("tool.mjs"), false, "and never the bridge");

    // The worker went to Codex, on the workers' model, in Codex's voice.
    const workers = seen.filter((s) => !s.request.director);
    assert.equal(workers.length, 1, `one worker session — worker_start answered ${JSON.stringify(results.started)}`);
    assert.equal(workers[0]!.engine, "codex");
    assert.equal(workers[0]!.request.model, "gpt-6-astra");
    assert.ok(workers[0]!.request.prompt.includes(BRIDGE_TOOL_CMD), "the worker reads the bridge command");
    assert.equal(workers[0]!.request.prompt.includes("mcp__studio__"), false, "and never an mcp__ name");
    assert.equal(results.waited.status.workers[0].state, "done", JSON.stringify(results.waited));
    assert.equal(results.integrated.merged, true, JSON.stringify(results.integrated));

    // The judge's question went to Codex, on the judges' model; Claude Code judged nothing.
    assert.equal(results.judged.ok, true, JSON.stringify(results.judged));
    assert.ok(results.judgeCalls.codex >= 1, "the vision judge ran on Codex");
    assert.ok(
      (results.judgeCalls.codexModels as string[]).every((m) => m === "gpt-6-astra"),
      `judge models: ${results.judgeCalls.codexModels.join(",")}`,
    );
    assert.equal(results.judgeCalls.claude, 0, "no judge call reached Claude Code");

    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, true, String(finished.stoppedBecause));
  });

  it("the workers' engine running out is the workers' problem: the run keeps going and run_status names the engine", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("cross-limit", { title: "Cross limit" });
    const results: Record<string, any> = {};
    twoEngines(rig, async (engine, request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        results.planned = text(await call("plan", planFor("sign")));
        results.started = json(
          await call("worker_start", {
            id: "sign",
            title: "Sign",
            brief: "hang a sign",
            mode: "single",
            minutes: "5",
            owns: "src/sign.js",
          }),
        );
        for (let i = 0; i < 30; i++) {
          results.waited = json(await call("wait", { seconds: "5", worker: "sign" }));
          if (results.waited.status.workers[0]?.state !== "running") break;
        }
        results.status1 = json(await call("run_status", {}));
        results.finished = text(
          await call("finish", { summary: "Codex is out of usage; nothing to land", land: "no" }),
        );
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

    assert.equal(results.started.started, "sign", JSON.stringify(results.started));
    assert.equal(results.waited.status.workers[0].state, "failed", JSON.stringify(results.waited));
    const limit = results.status1.workersEngineLimit;
    assert.ok(limit, `run_status names the workers' engine's limit: ${JSON.stringify(results.status1)}`);
    assert.equal(limit.engine, "codex");
    assert.equal(limit.kind, "usage cap");
    assert.equal(limit.worker, "sign");
    assert.ok(
      limit.minutesUntilReset >= 170 && limit.minutesUntilReset <= 180,
      `resets in ${limit.minutesUntilReset} minutes`,
    );
    assert.match(limit.note, /your own session is not/);
    assert.match(limit.message, /usage limit/);

    // Not the director's limit: the run finished on its own word, and was never paused.
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.limit, undefined, JSON.stringify(finished.limit));
    assert.doesNotMatch(String(finished.stoppedBecause), /usage cap|session limit|paused/);
    assert.equal(
      customEvents(events, "autopilot_paused").some((e) => e.runId === runId),
      false,
      "the run is done, not paused",
    );
    // The worker's own ending names the limit (the start row of the same worker does not).
    const worker = customEvents(events, "director_worker")
      .filter((e) => e.workerId === "sign")
      .at(-1)!;
    assert.equal(worker.state, "failed");
    assert.match(String(worker.stoppedBecause), /usage limit/);
    // …and what to do about it, in the same breath.
    assert.match(limit.note, /worker_start will hit the same limit for about \d+ more minutes/);
  });

  it("a Claude Code director with Ollama reviewers: every judge call reaches the local engine on the reviewers' model, and no session is asked of it", async () => {
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
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        results.planned = text(await call("plan", planFor("plaza")));
        results.started = json(
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "paint the plaza red",
            mode: "single",
            minutes: "5",
            owns: "src/plaza.js",
          }),
        );
        for (let i = 0; i < 30; i++) {
          results.waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
          if (results.waited.status.workers[0]?.state !== "running") break;
        }
        results.integrated = json(await call("integrate", { worker: "plaza" }));
        results.judged = json(
          await call("judge", { target: "integration", against: "none", question: "is the plaza red?" }),
        );
        results.judgeCalls = { claude: completes["claude-code"]!.length, local: local.map((r) => r.model) };
        results.finished = text(await call("finish", { summary: "the plaza is red", land: "yes", victory: "yes" }));
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
    assert.equal(started.builderEngine, undefined, "the workers stay on the director's engine");
    assert.equal(started.judgeEngine, "ollama");
    assert.equal(started.judgeModel, "vl");
    assert.ok(
      seen.every((s) => s.engine === "claude-code"),
      "every session went to Claude Code; none was asked of Ollama",
    );
    assert.equal(seen.filter((s) => !s.request.director)[0]?.request.model, "opus", "the worker builds on opus");
    assert.equal(results.judged.ok, true, JSON.stringify(results.judged));
    assert.ok((results.judgeCalls.local as string[]).length >= 1, "the vision judge ran on Ollama");
    assert.ok(
      (results.judgeCalls.local as string[]).every((m) => m === "vl"),
      `judge models: ${results.judgeCalls.local.join(",")}`,
    );
    assert.equal(results.judgeCalls.claude, 0, "no judge call reached Claude Code");
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, true, String(finished.stoppedBecause));
  });
});
