/**
 * `loop/outcomes.ts` and `loop/run-events.ts`: how a loop ended as a code beside its sentence,
 * a worker's state from one table, and a run's record written by one helper that logs a failure
 * (rate-limited) instead of swallowing it. Also the light effort a bounded ask always runs at
 * (`loop/config.ts` `LIGHT_EFFORT`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  StopCode,
  WorkerState,
  diedEarly,
  isRunning,
  setWorkerState,
  stopOf,
  stopWith,
} from "../../src/harness-seed/loop/outcomes.ts";
import {
  FAILURE_LOG_EVERY_MS,
  appendRun,
  logFailure,
  resetFailureLog,
  saveJournal,
} from "../../src/harness-seed/loop/run-events.ts";
import { LIGHT_EFFORT } from "../../src/harness-seed/loop/config.ts";
import { reviewDiff } from "../../src/harness-seed/loop/judge.ts";
import { runPlaytest } from "../../src/harness-seed/loop/playtester.ts";
import { nextMove, replanCheck } from "../../src/harness-seed/loop/replan.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

describe("stop reasons", () => {
  it("carry a code beside the owner's sentence, and refuse a code nobody declared", () => {
    const result = stopWith(
      { facetId: "plaza" },
      StopCode.ObservationDown,
      "the observation layer is down (screenshot(default) failed)",
    );
    assert.deepEqual(stopOf(result as never), {
      code: "observation-down",
      text: "the observation layer is down (screenshot(default) failed)",
    });
    assert.throws(() => stopWith({}, "went-home", "?"), /unknown stop code/);
    assert.deepEqual(stopOf({ stoppedBecause: "written before codes" }), { code: null, text: "written before codes" });
  });

  it("decide who died early on the code, whatever the sentence says", () => {
    for (const code of [StopCode.ObservationDown, StopCode.UsageLimit, StopCode.EngineExhausted])
      assert.equal(diedEarly(stopWith({}, code, "reworded tomorrow")), true, code);
    for (const code of [StopCode.UserStop, StopCode.Done, StopCode.Budget, StopCode.CircuitBreak, StopCode.Yielded])
      assert.equal(
        diedEarly(stopWith({}, code, "the engine failed three build turns — said about something else")),
        false,
        code,
      );
    assert.equal(diedEarly({ stoppedBecause: "the observation layer is down" }), false, "prose alone decides nothing");
  });
});

describe("a bounded ask's effort", () => {
  // A code review, a replan, the next move and a direct playtester's moves always ran "low",
  // whatever effort the user set for a role: a run at high judge effort must not pay high
  // effort for each of up to twenty playtester moves. Pinned so a refactor cannot change it.
  it("stays light even when the user set role efforts", async () => {
    const run = {
      runId: "r1",
      project: "p",
      engine: "ollama",
      model: "m",
      goal: "g",
      roles: { efforts: { judge: "high", planner: "max", builder: "high" } },
      effort: "max",
    };
    const spec = {
      id: "plaza",
      title: "Plaza",
      intent: "a plaza",
      checks: [{ id: "c1", kind: "play", ask: "Can you walk?" }],
    };
    const recorder = ctxRecorder({
      handlers: {
        "engine.complete": () => ({ message: { role: "assistant", content: "{}" } }),
        "engine.describe": () => [],
        "preview.load": () => ({}),
        "preview.call": () => null,
      },
    });
    const { ctx } = recorder;
    await reviewDiff(ctx, { run, diff: "", spec } as never);
    await replanCheck(ctx, { run, spec, check: spec.checks[0], reason: "unmeasurable" } as never);
    await nextMove(ctx, { run, spec } as never);
    await runPlaytest(ctx, {
      run,
      spec,
      checks: spec.checks,
      root: "/r",
      entry: undefined,
      handle: undefined,
      labelPrefix: undefined,
      deadline: Date.now() + 60_000,
      iteration: 0,
      maxActions: 1,
    } as never);
    const efforts = recorder.paramsOf("engine.complete").map((p) => p.effort);
    assert.deepEqual(efforts, ["low", "low", "low", "low"], "review, replan, next move, one playtester move");
    assert.equal(LIGHT_EFFORT, "low");
  });
});

describe("a delegated play session meets the game's front-end", () => {
  const spec = { id: "plaza", title: "Plaza", intent: "a plaza", checks: [{ id: "c1", kind: "play", ask: "Fun?" }] };

  it("asks the studio to keep the title and menu on screen, with the run's setup or without one", async () => {
    for (const setup of [undefined, { demo: "pick-map", verify: { path: "map", equals: "apex" } }]) {
      const run = { runId: "r1", project: "p", engine: "codex", model: "m", goal: "g", ...(setup ? { setup } : {}) };
      const recorder = ctxRecorder({
        handlers: {
          "engine.describe": () => [{ id: "codex", kind: "delegated" }],
          "engine.delegate": () => ({ turns: 1, summary: "{}" }),
        },
      });
      await runPlaytest(recorder.ctx, { run, spec, checks: spec.checks, root: "/r", maxActions: 1 } as never);
      const asked = recorder.paramsOf("engine.delegate")[0]?.playtest as { setup?: Record<string, unknown> };
      assert.deepEqual(asked.setup, { ...(setup ?? {}), begin: false }, JSON.stringify(setup));
    }
  });
});

describe("a direct engine's play session", () => {
  const run = { runId: "r1", project: "p", engine: "ollama", model: "m", goal: "g" };
  const spec = {
    id: "plaza",
    title: "Plaza",
    intent: "a plaza",
    checks: [
      { id: "walk", kind: "play", ask: "Can you walk?" },
      { id: "bench", kind: "play", ask: "Is there a bench?", expect: "no" },
    ],
  };

  it("plays with the tools on its lease, then asks for the answers once the budget is spent", async () => {
    const replies = [
      { role: "assistant", content: "", tool_calls: [{ id: "t1", name: "game_state", arguments: {} }] },
      { role: "assistant", content: "still playing", tool_calls: [{ id: "t2", name: "fly", arguments: {} }] },
      {
        role: "assistant",
        content: '{"answers":{"walk":{"answer":"yes","note":"walked"},"bench":{"answer":"yes"}},"report":"done"}',
      },
    ];
    const recorder = ctxRecorder({
      handlers: {
        "engine.complete": () => ({ message: replies.shift() }),
        "engine.describe": () => [],
        "preview.load": () => ({}),
        "preview.call": () => null,
        "preview.state": () => ({ score: 3 }),
      },
    });
    const played = await runPlaytest(recorder.ctx, {
      run,
      spec,
      checks: spec.checks,
      root: "/r",
      handle: "lease-1",
      deadline: Date.now() + 60_000,
      iteration: 2,
      maxActions: 1,
    } as never);
    assert.ok(played);
    assert.deepEqual(
      played.results.map((r) => [r.id, r.pass, r.answer]),
      [
        ["walk", true, "yes"],
        ["bench", false, "yes"],
      ],
    );
    assert.equal(played.report.actions, 1, "one tool call was played before the budget ran out");
    assert.equal(played.report.report, "done");
    const completes = recorder.paramsOf("engine.complete");
    assert.equal(completes.length, 3);
    assert.ok(completes[0]?.tools, "a move is asked with the play tools");
    assert.equal(completes[2]?.tools, undefined, "the answers are asked for without tools");
    for (const complete of completes)
      assert.deepEqual(complete.provenance, { role: "playtester", runId: "r1" }, "the host records who asked");
    for (const method of ["preview.load", "preview.call", "preview.state"])
      assert.equal(recorder.paramsOf(method)[0]?.handle, "lease-1", `${method} runs on the session's lease`);
    const messages = completes[2]?.messages as Array<{ role: string; content: string }>;
    assert.deepEqual(
      messages.map((m) => m.role),
      ["user", "assistant", "tool", "assistant", "user"],
    );
    assert.match(messages[2]?.content ?? "", /"score": 3/);
    assert.equal(messages[4]?.content, "Your action budget is spent. Reply now with the JSON answers and report.");
    assert.deepEqual(
      recorder.notifications.map((n) => n.type),
      ["judge.playtest"],
    );
  });

  it("answers nothing when it is stopped before its first move, and says so on every question", async () => {
    const recorder = ctxRecorder({
      handlers: {
        "engine.complete": () => ({ message: { role: "assistant", content: "{}" } }),
        "engine.describe": () => [],
        "preview.load": () => ({}),
        "preview.call": () => null,
      },
    });
    recorder.cancelAfter("preview.call");
    const played = await runPlaytest(recorder.ctx, {
      run,
      spec,
      checks: spec.checks,
      root: "/r",
      deadline: Date.now() + 60_000,
      maxActions: 3,
    } as never);
    assert.ok(played);
    assert.equal(recorder.paramsOf("engine.complete").length, 0);
    assert.deepEqual(
      played.results.map((r) => [r.id, r.pass, r.state]),
      [
        ["walk", null, "unmeasured"],
        ["bench", null, "unmeasured"],
      ],
    );
    assert.equal(played.report.actions, 0);
  });
});

describe("worker states", () => {
  it("come from one table", () => {
    const worker = { state: WorkerState.Running };
    assert.equal(setWorkerState(worker, WorkerState.Stopped), "stopped");
    assert.equal(worker.state, "stopped");
    assert.throws(() => setWorkerState(worker, "paused"), /unknown worker state/);
    assert.equal(worker.state, "stopped");
  });

  it("say whether a worker is still at work", () => {
    const worker = { state: WorkerState.Running };
    assert.equal(isRunning(worker), true);
    for (const state of [WorkerState.Done, WorkerState.Stopped, WorkerState.Failed]) {
      setWorkerState(worker, state);
      assert.equal(isRunning(worker), false, state);
    }
    assert.equal(isRunning(null), false);
  });
});

describe("the run's record", () => {
  it("appends one custom event, stamping the run first so a payload's own runId wins", async () => {
    const recorder = ctxRecorder({ handlers: { "events.append": () => ({ appended: 1 }) } });
    assert.deepEqual(
      await appendRun(recorder.ctx, "run-thread", "director_show", { target: "integration" }, { runId: "run_a" }),
      { appended: 1 },
    );
    await appendRun(
      recorder.ctx,
      "run-thread",
      "facet_steered",
      { runId: "run_b", facetId: "sky" },
      { runId: "run_a" },
    );
    await appendRun(recorder.ctx, "run-thread", "facet_move", { facetId: "sky" });
    assert.deepEqual(
      recorder.paramsOf("events.append").map((p) => p.batch),
      [
        [{ type: "custom", event_type: "director_show", payload: { runId: "run_a", target: "integration" } }],
        [{ type: "custom", event_type: "facet_steered", payload: { runId: "run_b", facetId: "sky" } }],
        [{ type: "custom", event_type: "facet_move", payload: { facetId: "sky" } }],
      ],
    );
  });

  it("never throws a failed write at the run, and says so in the log", async () => {
    resetFailureLog();
    const recorder = ctxRecorder({
      handlers: {
        "events.append": () => {
          throw new Error("the log is full");
        },
        "artifact.write": () => {
          throw new Error("disk full");
        },
      },
    });
    const said: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((line: string) => (said.push(String(line)), true)) as typeof process.stderr.write;
    try {
      assert.equal(await appendRun(recorder.ctx, "run-thread", "facet_move", {}), undefined);
      assert.equal(await saveJournal(recorder.ctx, "run-thread", "run_a", { phase: "facets" }), undefined);
    } finally {
      process.stderr.write = write;
    }
    assert.deepEqual(said, [
      "[harness] events.append facet_move failed: the log is full\n",
      "[harness] the run journal write failed: disk full\n",
    ]);
    assert.deepEqual(recorder.paramsOf("artifact.write"), [
      { threadId: "run-thread", artifactId: "autopilot_run_a", value: { phase: "facets" } },
    ]);
  });

  it("says one kind of failure at most once a minute, with how many went unsaid", () => {
    resetFailureLog();
    const lines: string[] = [];
    const write = (line: string) => void lines.push(line);
    assert.equal(logFailure("the run journal write", new Error("a"), { now: 0, write }), true);
    assert.equal(logFailure("the run journal write", new Error("b"), { now: 1_000, write }), false);
    assert.equal(logFailure("the run journal write", new Error("c"), { now: 2_000, write }), false);
    assert.equal(
      logFailure("events.append facet_move", new Error("d"), { now: 2_000, write }),
      true,
      "another kind is its own",
    );
    assert.equal(logFailure("the run journal write", new Error("e"), { now: FAILURE_LOG_EVERY_MS, write }), true);
    assert.deepEqual(lines, [
      "[harness] the run journal write failed: a\n",
      "[harness] events.append facet_move failed: d\n",
      "[harness] the run journal write failed (and 2 more since the last report): e\n",
    ]);
  });
});
