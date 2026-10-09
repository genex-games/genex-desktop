/**
 * One rule for how a round ended and one for where a run stands (src/shared/run-state.ts), and
 * the projections that used to decide both for themselves now agreeing: the run summary, the
 * Builds graph, the chat's morning card, the review page and the build history.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  executionActivity,
  executionStep,
  recordedRunLoop,
  roundOutcome,
  runExecution,
  runExecutions,
  workedMs,
  workStart,
} from "../../src/shared/run-state.ts";
import { summarizeRun } from "../../src/shared/run-summary.ts";
import { lastLoopRunForProject } from "../../src/shared/run-review.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import { buildRunGraph, type IterationNode } from "../../src/renderer/run-graph.ts";
import { toEntries } from "../../src/renderer/chat-entries.ts";
import { buildHistory } from "../../src/renderer/build-progress.ts";
import { verdictWords } from "../../src/renderer/words.ts";

let clock = 0;
const custom = (event_type: string, payload: Record<string, unknown>, thread = "chat"): EventEnvelope => {
  clock += 1;
  return {
    id: `e${String(clock).padStart(4, "0")}`,
    thread_id: thread,
    session_id: null,
    turn_id: null,
    created_at: new Date(Date.UTC(2026, 8, 24, 0, 0, clock)).toISOString(),
    data: { type: "custom", event_type, payload },
  };
};
const run = { runId: "run-1", project: "pond" };
const round = (iteration: number, fields: Record<string, unknown>) =>
  custom("facet_iteration", { ...run, facetId: "sky", facetTitle: "Sky", iteration, ...fields });

describe("how a round ended", () => {
  it("kept, undone, stopped by the lead, or finished with no verdict", () => {
    assert.equal(roundOutcome({ winner: "challenger" }), "accepted");
    assert.equal(roundOutcome({ winner: "incumbent", verdictSource: "taste-veto" }), "rejected");
    assert.equal(roundOutcome({ winner: null, verdictSource: "stopped" }), "stopped");
    assert.equal(
      roundOutcome({ winner: "challenger", verdictSource: "stopped" }),
      "stopped",
      "a stopped round was never judged, whatever else it says",
    );
    assert.equal(roundOutcome({ winner: null }), "unevaluated", "no winner is neither kept nor undone");
    assert.equal(roundOutcome({ winner: "tie" }), "unevaluated");
    assert.equal(roundOutcome(null), "unevaluated");
  });

  it("the words say so too: a round with no verdict is not called undone", () => {
    assert.equal(verdictWords({ winner: null, source: null }).word, "not reviewed");
    assert.match(verdictWords({ winner: null, source: null }).label, /^not reviewed — no verdict was recorded/);
    assert.equal(verdictWords({ winner: "incumbent", source: null }).word, "undone");
  });
});

describe("the projections agree on a run's rounds", () => {
  clock = 0;
  const loopRun = [
    custom("run_started", { ...run, goal: "a pond" }),
    round(1, { winner: "challenger", verdictSource: "taste" }),
    round(2, { winner: "incumbent", verdictSource: "taste-veto" }),
    round(3, { winner: null, verdictSource: "stopped", reason: "the lead moved on" }),
    // Recorded with no winner and no source: before, the summary dropped it, and the graph and
    // the morning card both called it undone.
    round(4, { winner: null }),
    custom("run_finished", { ...run, landed: false, stoppedBecause: "autopilot finished" }),
  ];

  it("the summary, the Builds graph and the morning card count one kept and one undone", () => {
    const summary = summarizeRun(loopRun, "pond", "run-1");
    const graph = buildRunGraph(loopRun)!;
    const rounds = graph.nodes.filter((node): node is IterationNode => node.kind === "iteration");
    const morning = toEntries(loopRun).find((entry) => entry.kind === "morning");
    assert.deepEqual(
      rounds.map((node) => node.status),
      ["accepted", "rolled", "stopped", "unjudged"],
    );
    assert.equal(summary.counts.accepted, 1);
    assert.equal(summary.counts.rejected, 1);
    assert.equal(summary.counts.stopped, 1);
    assert.equal(
      summary.counts.completedUnevaluated,
      1,
      "the round with no verdict is counted, as completed without evaluation",
    );
    assert.equal(graph.facets[0]!.accepted, 1);
    assert.equal(graph.facets[0]!.rolled, 1);
    assert.ok(morning?.kind === "morning");
    assert.deepEqual(
      { kept: morning.kept, undone: morning.undone },
      { kept: summary.counts.accepted, undone: summary.counts.rejected },
    );
    assert.deepEqual(
      { kept: graph.facets[0]!.accepted, undone: graph.facets[0]!.rolled },
      { kept: morning.kept, undone: morning.undone },
    );
  });

  it("the review page keeps only an accepted round's build, and records no winner as none", () => {
    clock = 100;
    const gauntlet = [
      custom("run_started", run),
      custom("run_iteration", { ...run, iteration: 1, winner: "challenger", shots: [{ camera: "a", path: "/1.jpg" }] }),
      custom("run_iteration", { ...run, iteration: 2, shots: [{ camera: "a", path: "/2.jpg" }] }),
      custom("run_iteration", { ...run, iteration: 3, winner: "incumbent", shots: [{ camera: "a", path: "/3.jpg" }] }),
    ];
    const review = lastLoopRunForProject(gauntlet, "pond").iterations.slice().reverse();
    assert.deepEqual(
      review.map((row) => [row.winner, row.outcome]),
      [
        ["challenger", "accepted"],
        [null, "unevaluated"],
        ["incumbent", "rejected"],
      ],
    );
    assert.equal(
      review[2]!.incumbentShots[0]?.path,
      "/1.jpg",
      "the build before round 3 is round 1's, not the unjudged round 2's",
    );
    const morning = toEntries(gauntlet.concat(custom("run_finished", run))).find((entry) => entry.kind === "morning");
    assert.ok(morning?.kind === "morning");
    assert.deepEqual({ kept: morning.kept, undone: morning.undone }, { kept: 1, undone: 1 });
    const summary = summarizeRun(gauntlet, "pond", "run-1");
    assert.deepEqual(
      [summary.counts.accepted, summary.counts.rejected, summary.counts.completedUnevaluated],
      [1, 1, 1],
    );
  });
});

describe("where a run stands", () => {
  const step = (current: Parameters<typeof executionStep>[0], type: string, payload: Record<string, unknown> = {}) =>
    executionStep(current, "r", { event_type: type, payload, at: type });

  it("starts, closes (paused when the close says so), pauses and resumes", () => {
    const started = step(null, "run_started");
    assert.deepEqual(started, {
      runId: "r",
      state: "running",
      status: "running",
      startedAt: "run_started",
      openedAt: "run_started",
      endedAt: null,
      worked: { ms: 0, since: "run_started" },
      activeAt: null,
    });
    assert.equal(step(started, "run_finished")?.state, "finished");
    assert.equal(step(started, "run_finished")?.status, "completed");
    assert.equal(
      step(started, "run_finished", { executionStatus: "paused" })?.state,
      "paused",
      "a paused close can be resumed",
    );
    assert.equal(step(started, "run_finished", { failure: { message: "x" } })?.status, "failed");
    assert.equal(step(started, "run_finished", { executionStatus: "cancelled" })?.status, "cancelled");
    const paused = step(step(started, "run_finished"), "autopilot_paused");
    assert.equal(paused?.state, "paused");
    assert.equal(paused?.endedAt, "run_finished", "a pause keeps when it closed");
    const resumed = step(paused, "autopilot_resumed");
    assert.deepEqual([resumed?.state, resumed?.endedAt], ["running", null]);
    assert.equal(step(started, "facet_iteration"), started, "any other record changes nothing");
    assert.equal(
      step(null, "run_finished")?.state,
      "finished",
      "a history that lost the start still knows how the run closed",
    );
  });

  it("counts a finished run started again from its restart; a resumed pause keeps its first start", () => {
    const started = step(null, "run_started");
    const reopened = step(step(started, "run_finished"), "run_registered");
    assert.deepEqual(
      [reopened?.state, reopened?.startedAt, reopened?.openedAt],
      ["running", "run_started", "run_registered"],
      "a finished run started again is reopened: its working time counts from the restart",
    );
    assert.equal(step(reopened, "run_started")?.openedAt, "run_registered", "the restart's own start moves nothing");
    const resumed = step(step(started, "run_finished", { executionStatus: "paused" }), "run_registered");
    assert.equal(resumed?.openedAt, "run_started", "a resumed pause goes on with the time it had");
  });

  const at = (minute: number) => new Date(minute * 60_000).toISOString();
  const lifecycle = (current: Parameters<typeof executionStep>[0], type: string, minute: number, payload = {}) =>
    executionStep(current, "r", { event_type: type, payload, at: at(minute) });
  /** A run started at minute 0 whose last own record was written at `minute`. */
  const workingUntil = (minute: number) => executionActivity(lifecycle(null, "run_started", 0), at(minute));

  it("counts the time it worked: never a pause, a closed app, or a finished run before its reopen", () => {
    const started = lifecycle(null, "run_registered", 0);
    const sameStretch = lifecycle(started, "run_started", 1);
    assert.deepEqual(sameStretch?.worked, { ms: 0, since: at(0) }, "the start's own record goes on with it");
    const working = executionActivity(sameStretch, at(60));
    assert.equal(working?.activeAt, at(60));
    // The app died an hour in; the next launch settles the run ten hours later and pauses it.
    const paused = lifecycle(lifecycle(working, "run_finished", 600, { workedUntil: at(60) }), "autopilot_paused", 600);
    assert.ok(paused);
    assert.deepEqual(paused.worked, { ms: 60 * 60_000, since: null });
    assert.equal(executionActivity(paused, at(601)), paused, "a closed run is not working");
    assert.equal(workedMs(paused.worked, 900 * 60_000), 60 * 60_000, "a paused clock stands still");
    assert.equal(workStart(paused.worked), null);
    const resumed = lifecycle(paused, "run_registered", 720, { resumed: true });
    assert.ok(resumed);
    assert.deepEqual(resumed.worked, { ms: 60 * 60_000, since: at(720) });
    assert.equal(workedMs(resumed.worked, 725 * 60_000), 65 * 60_000);
    assert.equal(workStart(resumed.worked), 660 * 60_000, "the start it would have had without the pause");
    const pausedAgain = lifecycle(resumed, "run_paused", 730);
    assert.equal(pausedAgain?.worked.ms, 70 * 60_000);
    assert.equal(lifecycle(pausedAgain, "autopilot_resumed", 800)?.worked.since, at(800));
    const reopened = lifecycle(lifecycle(resumed, "run_finished", 740), "run_registered", 900);
    assert.deepEqual(reopened?.worked, { ms: 0, since: at(900) }, "a reopened run's time counts from the reopen");
  });

  it("ends a stretch when the run closed it, and a settled one when its work last happened", () => {
    const minutes = (run: ReturnType<typeof lifecycle>) => (run?.worked.ms ?? 0) / 60_000;
    // The run's own close or pause, written as it stops: a turn may have worked long past its last record.
    assert.equal(minutes(lifecycle(workingUntil(10), "run_finished", 22, { executionStatus: "completed" })), 22);
    assert.equal(minutes(lifecycle(workingUntil(10), "run_finished", 22, { iterations: [] })), 22);
    assert.equal(minutes(lifecycle(workingUntil(10), "autopilot_paused", 22)), 22, "a Stop mid-turn");
    // Settled by the next launch: when the conversation last heard from it, not the launch's own records.
    assert.equal(minutes(lifecycle(workingUntil(600), "run_finished", 600, { workedUntil: at(60) })), 60);
    // Settled by a launch from before it said when: the run's newest own record.
    assert.equal(minutes(lifecycle(workingUntil(60), "run_finished", 600, { stoppedBecause: "restart" })), 60);
    assert.equal(minutes(lifecycle(lifecycle(null, "run_started", 0), "run_finished", 30)), 30, "nothing else heard");
  });

  it("summarizes the time worked only for a run whose start is in its history", () => {
    clock = 300;
    const closed = [custom("run_finished", { runId: "lost", project: "pond" })];
    assert.equal(summarizeRun(closed, "pond", "lost").worked, undefined);
    const worked = [
      custom("run_started", { runId: "kept", project: "pond" }),
      custom("facet_iteration", { runId: "kept", project: "pond" }),
      custom("run_finished", { runId: "kept", project: "pond", executionStatus: "completed" }),
    ];
    assert.deepEqual(summarizeRun(worked, "pond", "kept").worked, { ms: 2000, since: null });
  });

  it("follows the last run started, and no other run's records", () => {
    clock = 200;
    const log = [
      custom("run_started", { runId: "a" }),
      custom("run_started", { runId: "b" }),
      custom("run_finished", { runId: "a" }),
      custom("autopilot_paused", { runId: "a" }),
    ];
    assert.deepEqual([runExecution(log)?.runId, runExecution(log)?.state], ["b", "running"]);
    assert.equal(runExecution(log, "a")?.state, "paused");
    assert.deepEqual(
      [...runExecutions(log)].map(([id, value]) => [id, value.state]),
      [
        ["a", "paused"],
        ["b", "running"],
      ],
    );
  });

  it("a resumed run is running again everywhere: summary, Builds graph, history and the chat's run", () => {
    clock = 300;
    const log = [
      custom("run_started", run),
      round(1, { winner: "challenger" }),
      custom("run_finished", { ...run, executionStatus: "paused", stoppedBecause: "stopped by the user" }),
      custom("autopilot_paused", run),
    ];
    assert.equal(summarizeRun(log, "pond", "run-1").execution, "paused");
    assert.deepEqual(
      [buildRunGraph(log)!.active, (buildRunGraph(log)!.nodes[0] as { paused: boolean }).paused],
      [false, true],
    );
    assert.equal(buildHistory(log, "chat")[0]!.state, "paused");
    assert.equal(runExecution(log)?.state, "paused");
    const resumed = [...log, custom("run_started", { ...run, resumed: true }), custom("autopilot_resumed", run)];
    assert.equal(summarizeRun(resumed, "pond", "run-1").execution, "running");
    assert.equal(summarizeRun(resumed, "pond", "run-1").endedAt, undefined);
    assert.deepEqual(
      [buildRunGraph(resumed)!.active, (buildRunGraph(resumed)!.nodes[0] as { paused: boolean }).paused],
      [true, false],
      "the graph used to stay inactive after a resume",
    );
    assert.equal(buildHistory(resumed, "chat")[0]!.state, "running");
    assert.equal(runExecution(resumed)?.state, "running");
  });

  it("a finished run reopened forgets its close and counts its time from the reopen", () => {
    clock = 400;
    const loopRun = [
      custom("run_started", run),
      round(1, { winner: "challenger" }),
      custom("run_finished", { ...run, landed: true, integrationHead: "h1", stoppedBecause: "satisfied" }),
    ];
    const reopen = custom("run_registered", { ...run, resumed: true });
    const log = [...loopRun, reopen, custom("run_started", { ...run, resumed: true })];
    const summary = summarizeRun(log, "pond", "run-1");
    assert.deepEqual(
      [summary.execution, summary.landed, summary.reason, summary.startedAt],
      ["running", null, null, reopen.created_at],
      "the first close's landing and reason are not the reopened run's",
    );
    assert.deepEqual([summary.deliveredHead, summary.deliveredSourceHead], [null, null]);
    assert.equal(summary.head, "h1", "the build it goes on from is still the one it stands on");
  });
});

describe("the Loop a run was given", () => {
  it("reads ∞ as until satisfied, whatever its ceiling", () => {
    assert.deepEqual(recordedRunLoop({ wallClockMs: 86_400_000, untilSatisfied: true }), { hours: null });
    assert.deepEqual(recordedRunLoop({ untilSatisfied: true }), { hours: null });
  });

  it("reads a wall-clock budget as its hours", () => {
    assert.deepEqual(recordedRunLoop({ wallClockMs: 1_800_000 }), { hours: 0.5 });
    assert.deepEqual(recordedRunLoop({ wallClockMs: 86_400_000 }), { hours: 24 }, "a legacy ∞ run reads as 24 h");
  });

  it("knows nothing from budgets it cannot read", () => {
    const unreadable: unknown[] = [
      {},
      { wallClockMs: 0 },
      { wallClockMs: "30" },
      { wallClockMs: Number.POSITIVE_INFINITY },
      { untilSatisfied: "yes" },
      null,
      undefined,
      "budgets",
      [1_800_000],
    ];
    for (const budgets of unreadable) assert.equal(recordedRunLoop(budgets), null, JSON.stringify(budgets));
  });
});
