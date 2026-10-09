/**
 * The operator's read-only view of a live profile's runs (`runs`), which operations a launch
 * answers in which state, and the named keys the control presses.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";
import { EventKind, type EventEnvelope } from "../../src/shared/event-log.ts";
import { DevErrorCode, DevMethod, devRefusal, operationSchema } from "../../src/main/dev/protocol.ts";
import { listRuns } from "../../src/main/dev/runs.ts";
import { DesktopControl } from "../../src/main/dev/control.ts";

let sequence = 0;
/** One custom record of a run in a thread, at a minute past the fixture's hour. */
function record(threadId: string, minute: number, type: string, payload: Record<string, unknown>): EventEnvelope {
  return {
    id: `e${String(++sequence).padStart(5, "0")}`,
    thread_id: threadId,
    session_id: null,
    turn_id: null,
    created_at: `2026-10-06T01:${String(minute).padStart(2, "0")}:00.000Z`,
    data: customEventData(type as typeof CustomEvent.RunStarted, payload),
  };
}
const message = (threadId: string, minute: number): EventEnvelope => ({
  id: `e${String(++sequence).padStart(5, "0")}`,
  thread_id: threadId,
  session_id: null,
  turn_id: null,
  created_at: `2026-10-06T01:${String(minute).padStart(2, "0")}:00.000Z`,
  data: { type: EventKind.Messages, messages: [{ role: "user", content: "make it faster" }] } as never,
});

/** Three games: a paused run, a finished one, and a run still running in another chat. */
function fixtureStore() {
  const threads = [
    { id: "t-paused", metadata: { project: "racer" } },
    { id: "t-finished", metadata: { project: "village" } },
    { id: "t-running", metadata: { project: "flight" } },
    { id: "t-studio", metadata: {} },
  ];
  const events: Record<string, EventEnvelope[]> = {
    "t-paused": [
      record("t-paused", 0, CustomEvent.RunStarted, { runId: "run_p", project: "racer" }),
      record("t-paused", 10, CustomEvent.DirectorProgress, { runId: "run_p" }),
      record("t-paused", 20, CustomEvent.RunFinished, {
        runId: "run_p",
        executionStatus: "paused",
        stoppedBecause: "Claude's session limit; resets at 06:10",
        integrationHead: "abc123",
      }),
      record("t-paused", 20, CustomEvent.AutopilotPaused, { runId: "run_p" }),
      message("t-paused", 30),
    ],
    "t-finished": [
      record("t-finished", 0, CustomEvent.RunStarted, { runId: "run_f", project: "village" }),
      record("t-finished", 40, CustomEvent.RunFinished, {
        runId: "run_f",
        executionStatus: "completed",
        stoppedBecause: "the judge was satisfied",
        landed: true,
      }),
    ],
    "t-running": [
      record("t-running", 0, CustomEvent.RunStarted, { runId: "run_old", project: "flight" }),
      record("t-running", 5, CustomEvent.RunFinished, { runId: "run_old", executionStatus: "completed" }),
      record("t-running", 6, CustomEvent.RunStarted, { runId: "run_r", project: "flight" }),
      record("t-running", 50, CustomEvent.FacetIteration, { runId: "run_r", facetId: "cockpit" }),
    ],
    "t-studio": [message("t-studio", 1)],
  };
  const journals: Record<string, unknown> = {
    "t-paused/autopilot_run_p": {
      phase: "running",
      director: {
        clock: {
          started: "2026-10-06T01:00:00.000Z",
          softDeadline: "2026-10-06T05:00:00.000Z",
          finalDeadline: "2026-10-06T05:30:00.000Z",
          workedMs: 1_200_000,
        },
      },
    },
    "t-finished/autopilot_run_f": { phase: "done" },
    "t-running/autopilot_run_r": { phase: "running" },
  };
  const reads: string[] = [];
  return {
    reads,
    records: {
      listThreads: async () => threads,
      listEvents: async (id: string) => events[id] ?? [],
      readArtifact: async (id: string, artifact: string) => {
        reads.push(`${id}/${artifact}`);
        return journals[`${id}/${artifact}`] ?? null;
      },
    },
  };
}

const NOW = Date.parse("2026-10-06T02:00:00.000Z");

describe("the runs a live profile's operator sees", () => {
  it("lists every open run and the active chat's newest, with what a paused one needs to resume", async () => {
    const { records } = fixtureStore();
    const { runs, truncated } = await listRuns(records, { activeThread: "t-finished", now: NOW });
    assert.equal(truncated, false);
    assert.deepEqual(
      runs.map((run) => [run.runId, run.threadId, run.project, run.state, run.resumable]),
      [
        ["run_p", "t-paused", "racer", "paused", true],
        ["run_f", "t-finished", "village", "finished", false],
        ["run_r", "t-running", "flight", "running", false],
      ],
      "a finished run of an inactive chat, and the studio's own chat, are not listed",
    );
    const paused = runs[0];
    assert.equal(paused.phase, "running");
    assert.equal(paused.stoppedBecause, "Claude's session limit; resets at 06:10");
    assert.equal(paused.integrationHead, "abc123");
    assert.deepEqual(paused.clock, {
      softDeadline: "2026-10-06T05:00:00.000Z",
      finalDeadline: "2026-10-06T05:30:00.000Z",
      workedMs: 1_200_000,
    });
    // The run's own newest record, never a later chat message of the person's.
    assert.equal(paused.lastEventType, CustomEvent.AutopilotPaused);
    assert.equal(paused.lastEventAt, "2026-10-06T01:20:00.000Z");
    assert.equal(paused.workedMs, 20 * 60_000);

    const finished = runs[1];
    assert.equal(finished.stoppedBecause, "the judge was satisfied");
    assert.equal(finished.landed, true);
    assert.equal(finished.phase, "done");

    const running = runs[2];
    assert.equal(running.stoppedBecause, null, "a run working again carries no close");
    assert.equal(running.lastEventType, CustomEvent.FacetIteration);
    assert.equal(running.workedMs, 54 * 60_000);
  });

  it("lists the active chat's last-started run, even when an older run was reopened after a newer one", async () => {
    const events = [
      record("t-reopen", 0, CustomEvent.RunStarted, { runId: "run_a" }),
      record("t-reopen", 5, CustomEvent.RunFinished, { runId: "run_a", executionStatus: "completed" }),
      record("t-reopen", 6, CustomEvent.RunStarted, { runId: "run_b" }),
      record("t-reopen", 9, CustomEvent.RunFinished, { runId: "run_b", executionStatus: "completed" }),
      record("t-reopen", 10, CustomEvent.RunStarted, { runId: "run_a" }),
      record("t-reopen", 20, CustomEvent.RunFinished, { runId: "run_a", executionStatus: "completed" }),
    ];
    const { runs } = await listRuns(
      {
        listThreads: async () => [{ id: "t-reopen" }],
        listEvents: async () => events,
        readArtifact: async () => null,
      },
      { activeThread: "t-reopen", now: NOW },
    );
    assert.deepEqual(
      runs.map((run) => run.runId),
      ["run_a"],
    );
  });

  it("does not offer Resume for a paused run whose journal is gone or already done", async () => {
    for (const journal of [null, { phase: "done" }]) {
      const { records } = fixtureStore();
      const read = records.readArtifact;
      records.readArtifact = async (id: string, artifact: string) =>
        artifact === "autopilot_run_p" ? journal : read(id, artifact);
      const { runs } = await listRuns(records, { activeThread: null, now: NOW });
      const paused = runs.find((run) => run.runId === "run_p");
      assert.equal(paused?.resumable, false, JSON.stringify(journal));
    }
  });

  it("keeps the answer bounded and reads no journal of a run it does not list", async () => {
    const { records, reads } = fixtureStore();
    const { runs, truncated } = await listRuns(records, { activeThread: null, now: NOW, limit: 1 });
    assert.equal(runs.length, 1);
    assert.equal(truncated, true);
    assert.deepEqual(reads, ["t-paused/autopilot_run_p"]);
  });

  it("reads a thread with no run, a record with no run id or a foreign payload without listing anything", async () => {
    const odd: EventEnvelope[] = [
      record("t-odd", 0, CustomEvent.RunFinished, {}),
      record("t-odd", 1, CustomEvent.RunStarted, { runId: 42 }),
      { ...message("t-odd", 2), data: { type: EventKind.Custom, event_type: CustomEvent.RunStarted } as never },
    ];
    const { runs } = await listRuns(
      {
        listThreads: async () => [{ id: "t-odd" }],
        listEvents: async () => odd,
        readArtifact: async () => {
          throw new Error("no artifact folder");
        },
      },
      { activeThread: "t-odd", now: NOW },
    );
    assert.deepEqual(runs, []);
  });
});

describe("which operations a launch answers in which state", () => {
  const launch = (over: Partial<{ ready: boolean; authVisible: boolean; stale: boolean }> = {}) => {
    const state = { ready: true, authVisible: false, stale: false, ...over };
    return { ready: state.ready, authVisible: state.authVisible, stale: () => state.stale };
  };
  it("answers runs, status and stop on a stale build, a harness that is not ready and under a sign-in sheet", () => {
    for (const method of [DevMethod.Runs, DevMethod.Status, DevMethod.Stop])
      for (const state of [launch({ stale: true }), launch({ ready: false }), launch({ authVisible: true })])
        assert.equal(devRefusal(method, state), null, method);
  });
  it("refuses an action on a stale build, a harness that is not ready or under a sign-in sheet", () => {
    assert.equal(devRefusal(DevMethod.Click, launch({ stale: true }))?.code, DevErrorCode.StaleBuild);
    assert.equal(devRefusal(DevMethod.Click, launch({ ready: false }))?.code, DevErrorCode.NotReady);
    assert.equal(devRefusal(DevMethod.Click, launch({ authVisible: true }))?.code, DevErrorCode.MissingPrerequisite);
    assert.equal(devRefusal(DevMethod.Logs, launch({ stale: true })), null, "logs collects what an earlier call saw");
    assert.equal(devRefusal(DevMethod.Click, launch()), null);
  });
  it("does not work out staleness for an operation that answers anyway", () => {
    let asked = 0;
    const state = {
      ready: true,
      authVisible: false,
      stale: () => {
        asked++;
        return true;
      },
    };
    devRefusal(DevMethod.Runs, state);
    devRefusal(DevMethod.TraceStop, state);
    assert.equal(asked, 0);
  });
  it("takes runs only with empty parameters", () => {
    assert.deepEqual(operationSchema.parse({ method: "runs", params: {} }), { method: "runs", params: {} });
    for (const params of [{ thread: "t-1" }, { all: true }, { limit: 500 }])
      assert.equal(operationSchema.safeParse({ method: "runs", params }).success, false, JSON.stringify(params));
  });
});

describe("the named keys the control presses", () => {
  it("gives arrow and page keys the virtual key codes a real keyboard sends", async () => {
    const sent: Array<Record<string, unknown>> = [];
    let attached = false;
    const wc = {
      isDestroyed: () => false,
      debugger: {
        isAttached: () => attached,
        attach: () => {
          attached = true;
        },
        sendCommand: async (method: string, params: Record<string, unknown>) => {
          if (method === "Input.dispatchKeyEvent") sent.push(params);
          return {};
        },
      },
    };
    const control = new DesktopControl();
    const codes: Record<string, number> = { ArrowLeft: 37, ArrowRight: 39, PageUp: 33, PageDown: 34, ArrowUp: 38 };
    for (const key of Object.keys(codes)) await control.key(wc as never, { key, code: key });
    const downs = sent.filter((p) => p.type === "keyDown");
    assert.deepEqual(
      downs.map((p) => [p.key, p.windowsVirtualKeyCode]),
      Object.entries(codes),
    );
    assert.ok(
      downs.every((p) => !("text" in p)),
      "a navigation key types no text",
    );
  });
});
