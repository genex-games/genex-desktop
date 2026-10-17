/**
 * `loop/build-turn.ts`: one build turn on either kind of engine, recorded through a fake `ctx`.
 * A delegated engine gets one `engine.delegate` whose timeout is never under a minute; a direct
 * engine's turn is opened, run and closed on the thread, and closed as an error when it fails.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildTurn } from "../../src/harness-seed/loop/build-turn.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

const base = {
  engine: "claude-code",
  prompt: "build the plaza",
  project: "pong",
  threadId: "facet-thread",
  runId: "run_a",
};

describe("a delegated build turn", () => {
  it("is one engine.delegate with a timeout floored at a minute and the caller's own fields", async () => {
    const recorder = ctxRecorder({
      handlers: { "engine.delegate": () => ({ ok: true, sessionId: "s1", summary: "built" }) },
    });
    const answer = await buildTurn(recorder.ctx, {
      ...base,
      delegated: true,
      cwd: "/w/plaza",
      model: "opus",
      effort: "high",
      resume: "s0",
      timeoutMs: 8_000,
      delegation: { selfCapture: { project: "pong", root: "/w/plaza" }, extraReads: ["/w/base"] },
    });
    assert.deepEqual(answer, { ok: true, sessionId: "s1", summary: "built" });
    assert.deepEqual(recorder.sequence(), ["engine.delegate"]);
    assert.deepEqual(recorder.paramsOf("engine.delegate"), [
      {
        engine: "claude-code",
        prompt: "build the plaza",
        project: "pong",
        cwd: "/w/plaza",
        threadId: "facet-thread",
        model: "opus",
        effort: "high",
        resume: "s0",
        timeoutMs: 60_000,
        selfCapture: { project: "pong", root: "/w/plaza" },
        extraReads: ["/w/base"],
      },
    ]);
  });

  it("carries a run's sub-agent: its attribution and its tool allowlist reach the delegation", async () => {
    const recorder = ctxRecorder({ handlers: { "engine.delegate": () => ({ ok: true }) } });
    await buildTurn(recorder.ctx, {
      ...base,
      delegated: true,
      cwd: "/w/agent-2",
      attribution: { runId: "run_a", agentId: "agent-2" },
      toolAllow: ["blender__", "genex__asset"],
    });
    const [sent] = recorder.paramsOf("engine.delegate");
    assert.deepEqual(sent?.attribution, { runId: "run_a", agentId: "agent-2" });
    assert.deepEqual(sent?.toolAllow, ["blender__", "genex__asset"]);
  });

  it("names no attribution or allowlist for a turn that is nobody's sub-agent", async () => {
    const recorder = ctxRecorder({ handlers: { "engine.delegate": () => ({ ok: true }) } });
    await buildTurn(recorder.ctx, { ...base, delegated: true });
    const [sent] = recorder.paramsOf("engine.delegate");
    assert.ok(sent);
    assert.equal("attribution" in sent, false);
    assert.equal("toolAllow" in sent, false);
  });

  it("sends an effort only when the caller named one — and exactly what it named, even none", async () => {
    const recorder = ctxRecorder({ handlers: { "engine.delegate": () => ({ ok: true }) } });
    await buildTurn(recorder.ctx, { ...base, delegated: true, timeoutMs: 5 * 60_000 });
    await buildTurn(recorder.ctx, { ...base, delegated: true, timeoutMs: 5 * 60_000, effort: undefined });
    const [left, named] = recorder.paramsOf("engine.delegate");
    assert.equal("effort" in left!, false, "a caller that sends no effort leaves the key out");
    assert.equal(
      "effort" in named!,
      true,
      "a caller that passes the run's effort passes it, even when the run has none",
    );
    assert.equal(left!.timeoutMs, 5 * 60_000);
    assert.equal("model" in left!, false);
    assert.equal("cwd" in left!, false);
  });
});

describe("a direct build turn", () => {
  const direct = (recorder: ReturnType<typeof ctxRecorder>) =>
    buildTurn(recorder.ctx, {
      ...base,
      engine: "ollama",
      delegated: false,
      model: "qwen",
      metadata: { runId: "run_a", phase: "build", iteration: 2 },
      deadlineMs: Date.now() + 60_000,
      turn: { iteration: 2 },
    });

  it("opens the turn on the thread, runs it and closes it ok", async () => {
    const recorder = ctxRecorder({
      handlers: {
        "turn.begin": () => ({ turnId: "t1" }),
        "engine.describe": () => [{ id: "ollama", kind: "direct" }],
        "turn.append": () => true,
        "turn.end": () => true,
      },
    });
    // A stop already raised: the tool loop's first round ends the turn, which is all this needs.
    recorder.cancel();
    const outcome = await direct(recorder);
    assert.deepEqual(outcome, { stopped: "cancelled", round: 0 });
    assert.deepEqual(recorder.sequence(), ["turn.begin", "engine.describe", "turn.append", "turn.end"]);
    assert.deepEqual(recorder.paramsOf("turn.begin"), [
      {
        threadId: "facet-thread",
        input: [{ role: "user", content: "build the plaza" }],
        metadata: { runId: "run_a", phase: "build", iteration: 2 },
      },
    ]);
    assert.deepEqual(recorder.paramsOf("turn.end"), [{ turnId: "t1", status: "ok" }]);
  });

  it("closes a turn that failed as an error, and throws the failure on", async () => {
    const recorder = ctxRecorder({
      handlers: {
        "turn.begin": () => ({ turnId: "t2" }),
        "engine.describe": () => {
          throw Object.assign(new Error("the engine is gone"), { kind: "other" });
        },
        "turn.end": () => true,
      },
    });
    await assert.rejects(direct(recorder), /the engine is gone/);
    assert.deepEqual(recorder.paramsOf("turn.end"), [{ turnId: "t2", status: "error" }]);
  });
});
