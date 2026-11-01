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
