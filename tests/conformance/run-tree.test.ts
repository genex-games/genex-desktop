/**
 * The Builds graph as a tree: what you asked → the lead → a row per worker → the result → the
 * finish check, with the lead's background work hanging under it. The lead says what it is doing,
 * each worker reads in plain words, and a graph with no worker and no job keeps today's layout.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { seedBuildGraph } from "../../src/main/dev/fixture-build-graph.ts";
import { seedLeadGraph } from "../../src/main/dev/fixture-lead-graph.ts";
import { buildRunGraph, GraphNodeKind, rectsOverlap, type RunGraph } from "../../src/renderer/run-graph.ts";
import type { JobInfo } from "../../src/renderer/run-graph-workers.ts";
import {
  layoutSteps,
  leadWorking,
  partRows,
  resultGate,
  STEPS,
  StepEdgeKind,
  statusLine,
  stepPill,
  stepWord,
} from "../../src/renderer/run-steps.ts";
import {
  buildsLayout,
  graphLoaded,
  jobsTileStatus,
  LeadFace,
  leadFace,
  readingNodes,
  readingOrder,
} from "../../src/renderer/run-tree.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { type EventData, type EventEnvelope, EventKind } from "../../src/shared/event-log.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { turnGraphKey } from "../../src/shared/run-graph-events.ts";
import { JobRole, JobState, JobStopper } from "../../src/shared/jobs.ts";
import { ExecutionStatus } from "../../src/shared/run-state.ts";
import { summarizeRun } from "../../src/shared/run-summary.ts";
import { poolWorkerId, WorkerEnd, WorkerIsolation, WorkerVerdict } from "../../src/shared/workers.ts";
import { tmpDir } from "../helpers/tmp.ts";

const RUN = "run-r";
const TURN = "msg-t";
const START = Date.UTC(2026, 0, 1, 9, 0, 0);

let seq = 0;
/** One record of the chat's log, a second after the one before. */
function logged(data: EventData): EventEnvelope {
  seq += 1;
  return {
    id: `e${String(seq).padStart(4, "0")}`,
    thread_id: "t1",
    session_id: null,
    turn_id: null,
    created_at: new Date(START + seq * 1000).toISOString(),
    data,
  } as EventEnvelope;
}
const custom = (eventType: string, payload: Record<string, unknown>) =>
  logged({ type: EventKind.Custom, event_type: eventType, payload });
const inRun = (eventType: string, payload: Record<string, unknown> = {}) =>
  custom(eventType, { runId: RUN, project: "game", ...payload });

const runOpened = (): EventEnvelope[] => [
  inRun(CustomEvent.RunStarted, { goal: "Port the racer to Unreal", mode: "director" }),
  inRun(CustomEvent.AutopilotStarted, { director: true, facets: [] }),
];
const started = (scope: Record<string, unknown>, id: string, title: string, extra: Record<string, unknown> = {}) =>
  custom(CustomEvent.WorkerStarted, {
    ...scope,
    workerId: id,
    title,
    isolation: WorkerIsolation.Read,
    task: `${title}, then report`,
    ...extra,
  });
const finished = (scope: Record<string, unknown>, id: string, title: string, extra: Record<string, unknown>) =>
  custom(CustomEvent.WorkerFinished, { ...scope, workerId: id, title, ...extra });
const runScope = { runId: RUN };
const turnScope = { turn: TURN };
const jobStarted = (jobId: string, title: string) =>
  custom(CustomEvent.JobStarted, {
    runId: RUN,
    jobId,
    project: "game",
    title,
    command: "make",
    cwd: ".",
    startedAt: new Date(START).toISOString(),
    role: JobRole.Lead,
    deadlineAt: new Date(START + 7_200_000).toISOString(),
  });

const STUDY = poolWorkerId("w1");
const CAR = poolWorkerId("w2");
const TRACK = poolWorkerId("w3");
/** A typed worker of the Unreal lead, under the id that lead gives it. */
const SOUND = "agent-sound-1";

/** A Loop's lead with three workers: one studied, one added to the game, one still building in Unreal. */
function loopWithWorkers(extra: EventEnvelope[] = []): EventEnvelope[] {
  seq = 0;
  return [
    ...runOpened(),
    started(runScope, STUDY, "Study the web game"),
    started(runScope, CAR, "Port the car", { isolation: WorkerIsolation.Copy }),
    started(runScope, TRACK, "Build the track", { isolation: WorkerIsolation.Lock, in: GameEngine.Unreal }),
    jobStarted("j1", "Unreal build"),
    finished(runScope, STUDY, "Study the web game", { state: WorkerEnd.Done, summary: "Studied the web game." }),
    finished(runScope, CAR, "Port the car", { state: WorkerEnd.Done, delivered: true }),
    finished(runScope, CAR, "Port the car", { verdict: WorkerVerdict.Used, merged: true }),
    ...extra,
  ];
}

/** The graph of a log, its summary and its rows, as the Builds tab folds them. */
function fold(events: EventEnvelope[], key?: string) {
  const graph = buildRunGraph(events, key) as RunGraph;
  assert.ok(graph, "the log draws a graph");
  const summary = graph.turn ? null : summarizeRun(events, "game", graph.runId);
  if (summary) graph.summary = summary;
  return { graph, summary, rows: partRows(graph, summary) };
}

/** Every drawn box but the row labels. */
const boxes = (rects: Record<string, { x: number; y: number; w: number; h: number }>) =>
  Object.entries(rects).filter(([id]) => !id.startsWith("row:"));

/** What a dev fixture appends, as the log would hand it back. */
async function seeded(seed: (core: never, project: string, threadId: string) => Promise<void>) {
  const appended: EventData[] = [];
  const core = {
    store: { listEvents: async () => [] },
    layout: { runs: await tmpDir("studio-run-tree-") },
    append: async (events: EventData[]) => void appended.push(...events),
  };
  await seed(core as never, "fixture-game", "thread-1");
  return appended.map(logged);
}

describe("a graph without workers or jobs keeps today's layout", () => {
  it("a lead's run between parts lays out as it always did, the lead after the result", () => {
    seq = 0;
    const { graph, summary, rows } = fold([
      ...runOpened(),
      inRun(CustomEvent.DirectorWorker, { workerId: "sword", title: "Sword", state: "running", mode: "single" }),
      inRun(CustomEvent.DirectorWorker, { workerId: "sword", title: "Sword", state: "done", mode: "single" }),
      inRun(CustomEvent.IntegrationMerge, { facetId: "sword", head: "h1", commit: "c1", conflict: false }),
      inRun(CustomEvent.IntegrationHealth, { head: "h1", ok: true, problems: [] }),
    ]);
    assert.equal(graph.tree, false);
    const lead = leadWorking(graph, summary, rows);
    assert.equal(lead, true);
    const layout = buildsLayout(graph, rows, summary);
    assert.deepEqual(
      layout,
      layoutSteps(rows, { assets: false, optimization: false, resultGate: resultGate(graph), lead }),
    );
    assert.equal(layout.rects["session:sword"]?.x, STEPS.pad + STEPS.startW + 2 * STEPS.busGap);
    assert.ok(layout.rects.lead && layout.rects.final);
    assert.equal(layout.rects.lead.x, layout.rects.final.x + STEPS.resultW + STEPS.leadGap, "after the result");
    assert.equal(layout.rects.jobs, undefined);
    assert.equal(layout.rects[GraphNodeKind.FinishCheck], undefined);
  });

  it("the build-graph dev fixture lays out as it always did", async () => {
    seq = 0;
    const events = await seeded(seedBuildGraph);
    for (const runId of ["fixture-graph-run", "fixture-graph-live"]) {
      const { graph, summary, rows } = fold(events, runId);
      assert.equal(graph.tree, false);
      const assets = graph.nodes.some(
        (node) => node.kind === GraphNodeKind.Assets || node.kind === GraphNodeKind.Blender,
      );
      const optimization = graph.nodes.some((node) => node.kind === GraphNodeKind.Optimization);
      assert.deepEqual(
        buildsLayout(graph, rows, summary),
        layoutSteps(rows, {
          assets,
          optimization,
          resultGate: resultGate(graph),
          lead: leadWorking(graph, summary, rows),
        }),
        runId,
      );
    }
  });
});

describe("a graph with its assets or its optimisation keeps today's layout and order", () => {
  it("the Unreal lead's dev fixture: the assets card under the start, stepped right after it", async () => {
    seq = 0;
    const events = await seeded(seedLeadGraph);
    const shared = ["start", "assets", "step:lead:1", "step:lead-atmosphere:1"];
    const agents = ["session:agent-blender_model-1", "session:agent-texture-1", "session:agent-genex_cast-1"];
    const expected: Record<string, string[]> = {
      "fixture-lead-done": [...shared, ...agents, "step:lead-combat:1", "final"],
      "fixture-lead-live": [...shared, ...agents, "session:lead-combat", "session:agent-sound-1", "final"],
    };
    for (const [runId, steps] of Object.entries(expected)) {
      const { graph, summary, rows } = fold(events, runId);
      assert.equal(graph.tree, false, runId);
      assert.deepEqual(readingOrder(rows, readingNodes(graph, rows, summary)), steps, runId);
      const layout = buildsLayout(graph, rows, summary);
      const lead = leadWorking(graph, summary, rows);
      const today = layoutSteps(rows, { assets: true, optimization: false, resultGate: resultGate(graph), lead });
      assert.deepEqual(layout, today, runId);
      assert.ok(layout.rects.assets && layout.rects.start, runId);
      assert.equal(layout.rects.assets.x, layout.rects.start.x, "the assets card stands under the start");
      assert.ok(layout.rects.assets.y > layout.rects.start.y);
    }
  });

  it("a run in its optimisation: the card between the last step and the result, stepped before the result", async () => {
    const { emptyOptimization } = await import("../../src/harness-seed/loop/optimization.ts");
    seq = 0;
    const optimizing = { ...emptyOptimization({ runId: RUN, project: "game" }), phase: "profiling_candidate" };
    const { graph, summary, rows } = fold([
      inRun(CustomEvent.RunStarted, { goal: "A river" }),
      inRun(CustomEvent.AutopilotStarted, { facets: [{ id: "river", title: "River", budgetShare: 1 }] }),
      inRun(CustomEvent.AutopilotBase, { ok: true }),
      inRun(CustomEvent.OptimizationUpdated, optimizing),
    ]);
    assert.deepEqual(readingOrder(rows, readingNodes(graph, rows, summary)), [
      "start",
      "session:river",
      "optimization",
      "final",
      "lead",
    ]);
    const layout = buildsLayout(graph, rows, summary);
    const lead = leadWorking(graph, summary, rows);
    const today = layoutSteps(rows, { assets: false, optimization: true, resultGate: resultGate(graph), lead });
    assert.deepEqual(layout, today);
    const { optimization, final } = layout.rects;
    assert.ok(optimization && final);
    assert.equal(optimization.y, final.y);
    assert.ok(optimization.x < final.x, "the optimisation card comes before the result");
  });
});

describe("the tree on the canvas", () => {
  it("a tree runs from what you asked to the lead, then a row per worker into the result", () => {
    const { graph, summary, rows } = fold(loopWithWorkers());
    assert.equal(graph.tree, true);
    const layout = buildsLayout(graph, rows, summary);
    const { start, lead, final } = layout.rects;
    assert.ok(start && lead && final);
    assert.equal(start.x, STEPS.pad);
    assert.equal(lead.x, start.x + start.w + STEPS.leadGap, "the lead right of what you asked");
    assert.equal(lead.y + lead.h / 2, start.y + start.h / 2, "on the same middle line");
    assert.equal(final.y + final.h / 2, lead.y + lead.h / 2, "and so is the result");
    const steps = rows.flatMap((row) => row.steps).map((step) => layout.rects[step.id]);
    assert.equal(steps.length, 3, "a node per worker");
    for (const rect of steps) {
      assert.ok(rect);
      assert.equal(rect.x, lead.x + lead.w + 2 * STEPS.busGap, "each worker's row starts past the lead's bus");
      assert.ok(final.x > rect.x + rect.w, "the result is right of every row");
    }
    for (const [a, ra] of boxes(layout.rects))
      for (const [b, rb] of boxes(layout.rects)) if (a < b) assert.equal(rectsOverlap(ra, rb), false, `${a} on ${b}`);
    const intoLead = layout.edges.find(
      (edge) => edge.d === `M${start.x + start.w} ${start.y + start.h / 2} H${lead.x}`,
    );
    assert.equal(intoLead?.kind, StepEdgeKind.Solid, "a worker works, so the lead is not alone");
    assert.ok(
      layout.edges.some((edge) => edge.d.startsWith(`M${lead.x + lead.w} `)),
      "the bus into the rows leaves from the lead",
    );
  });

  it("a worker that finished its task is on the line, joined to the result; one that did not, or was not used, is a ghost", () => {
    const { graph, summary, rows } = fold(
      loopWithWorkers([
        started(runScope, poolWorkerId("w5"), "Add rain", { isolation: WorkerIsolation.Copy }),
        started(runScope, poolWorkerId("w6"), "Bake the lights", { isolation: WorkerIsolation.Copy }),
        started(runScope, poolWorkerId("w7"), "Add skid marks", { isolation: WorkerIsolation.Copy }),
        started(runScope, poolWorkerId("w8"), "Add smoke", { isolation: WorkerIsolation.Copy }),
        finished(runScope, poolWorkerId("w5"), "Add rain", { state: WorkerEnd.Failed }),
        finished(runScope, poolWorkerId("w6"), "Bake the lights", { state: WorkerEnd.Stopped }),
        finished(runScope, poolWorkerId("w7"), "Add skid marks", { state: WorkerEnd.Done, delivered: true }),
        finished(runScope, poolWorkerId("w7"), "Add skid marks", { verdict: WorkerVerdict.Rejected }),
        finished(runScope, poolWorkerId("w8"), "Add smoke", { state: WorkerEnd.Done, delivered: true }),
        // The Unreal lead's typed worker between the lead's "used" and the save point that adds it.
        started(runScope, SOUND, "Sound: Blade swings", { isolation: WorkerIsolation.Copy }),
        finished(runScope, SOUND, "Sound: Blade swings", { state: WorkerEnd.Done, delivered: true }),
        finished(runScope, SOUND, "Sound: Blade swings", { verdict: WorkerVerdict.Used }),
      ]),
    );
    const layout = buildsLayout(graph, rows, summary);
    const look = (id: string) => {
      const edge = (prefix: string) => layout.edges.find((line) => line.id === `${prefix}:${id}`)?.kind ?? null;
      return [layout.ghosts.has(`session:${id}`), edge("in"), edge("out")];
    };
    const joined = [false, StepEdgeKind.Solid, StepEdgeKind.Solid];
    assert.deepEqual(look(STUDY), joined, "a reader that finished");
    assert.deepEqual(look(CAR), joined, "a copy the lead added");
    assert.deepEqual(look(SOUND), joined, "work the lead used, not added yet");
    const sound = rows.find((row) => row.facet.facetId === SOUND)?.steps[0];
    assert.ok(sound);
    assert.equal(stepWord(sound, graph.active), "Done");
    const ghost = [true, StepEdgeKind.Dotted, null];
    assert.deepEqual(look(poolWorkerId("w5")), ghost, "a worker that failed");
    assert.deepEqual(look(poolWorkerId("w6")), ghost, "a worker that was stopped");
    assert.deepEqual(look(poolWorkerId("w7")), ghost, "a worker the lead did not use");
    assert.deepEqual(look(poolWorkerId("w8")), ghost, "work handed back that the lead has not used yet");
  });

  it("a director's builder that handed work back stays a ghost until the lead integrates it, also after the run ends", () => {
    const builder = (extra: EventEnvelope[]) => [
      ...runOpened(),
      inRun(CustomEvent.DirectorWorker, { workerId: "sky", title: "Sky", mode: "single", state: "running" }),
      started(runScope, "sky", "Sky", { isolation: WorkerIsolation.Copy }),
      inRun(CustomEvent.DirectorWorker, { workerId: "sky", title: "Sky", mode: "single", state: "done" }),
      // What the director writes for a builder that finished with a commit of its own.
      finished(runScope, "sky", "Sky", { state: WorkerEnd.Done, delivered: true }),
      ...extra,
    ];
    const look = (events: EventEnvelope[]) => {
      const { graph, summary, rows } = fold(events);
      const layout = buildsLayout(graph, rows, summary);
      const edge = (prefix: string) => layout.edges.find((line) => line.id === `${prefix}:sky`)?.kind ?? null;
      return [layout.ghosts.has("session:sky"), edge("in"), edge("out"), rows[0]?.steps[0]?.onLine];
    };
    const ghost = [true, StepEdgeKind.Dotted, null, false];
    assert.deepEqual(look(builder([])), ghost, "handed back, not integrated yet");
    assert.deepEqual(look(builder([inRun(CustomEvent.RunFinished, { status: "done" })])), ghost, "never integrated");
    const merged = inRun(CustomEvent.IntegrationMerge, { facetId: "sky", commit: "c1", head: "h1", conflict: false });
    assert.deepEqual(
      look(builder([merged])),
      [false, StepEdgeKind.Solid, StepEdgeKind.Solid, true],
      "integrated: in the build",
    );
  });

  it("the line into the lead is live while the lead works alone", () => {
    const { graph, summary, rows } = fold(
      loopWithWorkers([finished(runScope, TRACK, "Build the track", { state: WorkerEnd.Done })]),
    );
    const layout = buildsLayout(graph, rows, summary);
    const { start, lead } = layout.rects;
    assert.ok(start && lead);
    const intoLead = layout.edges.find(
      (edge) => edge.d === `M${start.x + start.w} ${start.y + start.h / 2} H${lead.x}`,
    );
    assert.equal(intoLead?.kind, StepEdgeKind.Live);
  });
});

describe("what hangs on the tree", () => {
  it("the lead's background work hangs under it on a dotted line, and nothing hangs there without jobs", () => {
    const { graph, summary, rows } = fold(loopWithWorkers());
    const layout = buildsLayout(graph, rows, summary);
    const { lead, jobs } = layout.rects;
    assert.ok(lead && jobs);
    assert.deepEqual(jobs, {
      x: lead.x,
      y: lead.y + lead.h + STEPS.assetsGap,
      w: STEPS.assetsW,
      h: STEPS.assetsH,
    });
    const line = layout.edges.find((edge) => edge.d === `M${lead.x + lead.w / 2} ${lead.y + lead.h} V${jobs.y}`);
    assert.equal(line?.kind, StepEdgeKind.Dotted);

    seq = 0;
    const plain = fold([...runOpened(), started(runScope, STUDY, "Study the web game")]);
    assert.equal(plain.graph.tree, true);
    assert.equal(buildsLayout(plain.graph, plain.rows, plain.summary).rects.jobs, undefined);
  });

  it("the finish check is the last node, after the result, on a dotted line", () => {
    const { graph, summary, rows } = fold(loopWithWorkers());
    const layout = buildsLayout(graph, rows, summary);
    const { final } = layout.rects;
    const check = layout.rects[GraphNodeKind.FinishCheck];
    assert.ok(final && check);
    assert.deepEqual(check, {
      x: final.x + final.w + STEPS.leadGap,
      y: final.y,
      w: STEPS.resultW,
      h: STEPS.resultH,
    });
    const rightmost = Math.max(...boxes(layout.rects).map(([, rect]) => rect.x + rect.w));
    assert.equal(check.x + check.w, rightmost, "nothing is right of it");
    const line = layout.edges.find((edge) => edge.d === `M${final.x + final.w} ${final.y + final.h / 2} H${check.x}`);
    assert.equal(line?.kind, StepEdgeKind.Dotted);

    const over = fold(
      loopWithWorkers([inRun(CustomEvent.RunFinished, { landed: false, stoppedBecause: "the lead finished" })]),
    );
    assert.equal(
      buildsLayout(over.graph, over.rows, over.summary).rects[GraphNodeKind.FinishCheck],
      undefined,
      "a finished run with no check has none",
    );
  });

  it("a chat turn's tree has its lead and no finish check", () => {
    seq = 0;
    const { graph, summary, rows } = fold([
      started(turnScope, poolWorkerId("w1"), "Check the physics", { ask: "The car drifts left" }),
      finished(turnScope, poolWorkerId("w1"), "Check the physics", { state: WorkerEnd.Done }),
    ]);
    assert.equal(graph.turn, TURN);
    const layout = buildsLayout(graph, rows, summary);
    assert.ok(layout.rects.lead);
    assert.equal(layout.rects[GraphNodeKind.FinishCheck], undefined);
    assert.equal(leadFace(graph, summary, rows), LeadFace.Done);
  });
});

describe("the lead says what it is doing", () => {
  it("the lead says what it is doing: alone, waiting for a worker, paused, done, stopped", () => {
    const working = fold(loopWithWorkers());
    const alone = fold(loopWithWorkers([finished(runScope, TRACK, "Build the track", { state: WorkerEnd.Done })]));
    const { summary } = alone;
    assert.ok(summary);
    const closed = (execution: string) => leadFace(alone.graph, { ...summary, execution }, alone.rows);
    seq = 0;
    const milestone = fold([
      ...runOpened(),
      inRun(CustomEvent.DirectorWorker, {
        workerId: "lead-combat",
        title: "Lead · Combat",
        state: "running",
        mode: "single",
      }),
      started(runScope, "agent-sound-1", "Sound: Blade swings", { isolation: WorkerIsolation.Copy }),
    ]);
    const rows: [string, LeadFace][] = [
      ["a worker works", leadFace(working.graph, working.summary, working.rows)],
      ["no worker works", leadFace(alone.graph, summary, alone.rows)],
      ["its own milestone works beside a worker", leadFace(milestone.graph, milestone.summary, milestone.rows)],
      ["paused", closed(ExecutionStatus.Paused)],
      ["finished", closed(ExecutionStatus.Completed)],
      ["failed", closed(ExecutionStatus.Failed)],
      ["cancelled", closed(ExecutionStatus.Cancelled)],
    ];
    assert.deepEqual(rows, [
      ["a worker works", LeadFace.Waiting],
      ["no worker works", LeadFace.Working],
      ["its own milestone works beside a worker", LeadFace.Working],
      ["paused", LeadFace.Paused],
      ["finished", LeadFace.Done],
      ["failed", LeadFace.Stopped],
      ["cancelled", LeadFace.Stopped],
    ]);
  });

  it("says how many workers are on it while they work", () => {
    const { graph, summary, rows } = fold(loopWithWorkers());
    assert.equal(statusLine(graph, summary, rows).rest, "1 worker on it");
    seq = 0;
    const both = fold([
      ...runOpened(),
      started(runScope, STUDY, "Study the web game"),
      started(runScope, CAR, "Port the car", { isolation: WorkerIsolation.Copy }),
    ]);
    assert.equal(statusLine(both.graph, both.summary, both.rows).rest, "2 workers on it");
  });
});

describe("a worker's words", () => {
  it("a worker reads Working, Working in Unreal, Done, Added to your game, Didn't finish, Stopped, Not used; a web part reads as before", () => {
    const { graph, rows } = fold(
      loopWithWorkers([
        started(runScope, poolWorkerId("w4"), "Tune the lights"),
        started(runScope, poolWorkerId("w5"), "Add rain", { isolation: WorkerIsolation.Copy }),
        started(runScope, poolWorkerId("w6"), "Bake the lights", { isolation: WorkerIsolation.Copy }),
        started(runScope, poolWorkerId("w7"), "Add skid marks", { isolation: WorkerIsolation.Copy }),
        finished(runScope, poolWorkerId("w5"), "Add rain", { state: WorkerEnd.Failed, stoppedBecause: "it crashed" }),
        finished(runScope, poolWorkerId("w6"), "Bake the lights", { state: WorkerEnd.Stopped }),
        finished(runScope, poolWorkerId("w7"), "Add skid marks", { state: WorkerEnd.Done, delivered: true }),
        finished(runScope, poolWorkerId("w7"), "Add skid marks", {
          verdict: WorkerVerdict.Rejected,
          note: "Too dark",
        }),
        inRun(CustomEvent.DirectorWorker, { workerId: "sword", title: "Sword", state: "running", mode: "single" }),
        inRun(CustomEvent.DirectorWorker, { workerId: "sword", title: "Sword", state: "done", delivered: true }),
      ]),
    );
    const words = rows.flatMap((row) =>
      row.steps.map((step) => [row.facet.title, stepWord(step, graph.active), stepPill(step, graph.active)]),
    );
    assert.deepEqual(words, [
      ["Study the web game", "Done", "Done"],
      ["Port the car", "Added to your game", "Added to your game"],
      ["Build the track", "Working in Unreal", "Working in Unreal"],
      ["Tune the lights", "Working", "Working"],
      ["Add rain", "Didn't finish", "Didn't finish"],
      ["Bake the lights", "Stopped", "Stopped"],
      ["Add skid marks", "Not used", "Not used"],
      ["Sword", "Delivered", "Delivered, not used yet"],
    ]);
  });
});

describe("a worker the lead did not use", () => {
  it("a worker that wrote in place and finished, then was rejected, is in the game still: its row and its turn say so", () => {
    seq = 0;
    const events = [
      started(turnScope, poolWorkerId("w1"), "Tune the jump", { isolation: WorkerIsolation.Lock }),
      finished(turnScope, poolWorkerId("w1"), "Tune the jump", { state: WorkerEnd.Done, inGame: true }),
      finished(turnScope, poolWorkerId("w1"), "Tune the jump", {
        verdict: WorkerVerdict.Rejected,
        note: "Too floaty",
      }),
    ];
    const { graph, rows } = fold(events, turnGraphKey(TURN));
    const words = rows.flatMap((row) => row.steps.map((step) => stepWord(step, graph.active)));
    assert.deepEqual(words, ["Added to your game"]);
    const line = statusLine(graph, null, rows, START);
    assert.deepEqual([line.strong, line.rest], ["Live in your game", "from this chat turn"]);
  });
});

describe("the background tile", () => {
  const job = (jobId: string, title: string, state: JobState, extra: Partial<JobInfo> = {}): JobInfo => ({
    jobId,
    title,
    who: null,
    state,
    exitCode: null,
    startedAt: "2026-01-01T09:00:00.000Z",
    endedAt: null,
    durationMs: null,
    stoppedBy: null,
    ...extra,
  });
  const NOW = Date.parse("2026-01-01T09:30:00.000Z");
  const running = (jobId: string, title: string, minutesAgo: number) =>
    job(jobId, title, JobState.Running, { startedAt: new Date(NOW - minutesAgo * 60_000).toISOString() });
  const ended = (jobId: string, title: string) =>
    job(jobId, title, JobState.Succeeded, { durationMs: 240_000, endedAt: "2026-01-01T09:04:00.000Z" });

  it("the background tile names the newest running job and counts the rest", () => {
    const table = [
      [ended("j1", "Shader compile"), ended("j2", "Asset cook"), running("j3", "Unreal build", 4)],
      [running("j1", "Shader compile", 9), running("j2", "Unreal build", 1)],
      [ended("j1", "Unreal build")],
      [ended("j1", "Shader compile"), ended("j2", "Unreal build")],
      [job("j1", "Unreal build", JobState.Stopped, { stoppedBy: JobStopper.Person })],
    ].map((jobs) => jobsTileStatus(jobs, NOW));
    assert.deepEqual(table, [
      { title: "Unreal build", status: "4 min · 2 finished", tone: "accent" },
      { title: "Unreal build", status: "1 min · 1 running", tone: "accent" },
      { title: "Unreal build", status: "finished · 4 min", tone: "muted" },
      { title: "Unreal build", status: "2 finished", tone: "muted" },
      { title: "Unreal build", status: "stopped", tone: "muted" },
    ]);
  });
});

describe("Previous and Next", () => {
  /** The order Previous and Next step through a log's graph. */
  const order = (events: EventEnvelope[], key?: string) => {
    const { graph, summary, rows } = fold(events, key);
    return readingOrder(rows, readingNodes(graph, rows, summary));
  };

  it("a graph that is no tree steps as it always did: the start, its assets, the steps, the result, the lead while it has the run", async () => {
    seq = 0;
    const between = order([
      ...runOpened(),
      inRun(CustomEvent.DirectorWorker, { workerId: "sword", title: "Sword", state: "running", mode: "single" }),
      inRun(CustomEvent.DirectorWorker, { workerId: "sword", title: "Sword", state: "done", mode: "single" }),
      inRun(CustomEvent.IntegrationMerge, { facetId: "sword", head: "h1", commit: "c1", conflict: false }),
      inRun(CustomEvent.IntegrationHealth, { head: "h1", ok: true, problems: [] }),
    ]);
    assert.deepEqual(between, ["start", "session:sword", "final", "lead"]);
    seq = 0;
    const events = await seeded(seedBuildGraph);
    for (const runId of ["fixture-graph-run", "fixture-graph-live"]) {
      const { graph, summary, rows } = fold(events, runId);
      const nodes = readingNodes(graph, rows, summary);
      const steps = rows.flatMap((row) => row.steps.map((step) => step.id));
      const before = [
        "start",
        ...(nodes.assets ? ["assets"] : []),
        ...steps,
        ...(nodes.optimization ? ["optimization"] : []),
        "final",
        ...(nodes.lead ? ["lead"] : []),
      ];
      assert.equal(nodes.tree, false, runId);
      assert.deepEqual(readingOrder(rows, nodes), before, runId);
    }
  });

  it("a Loop's tree steps from the start to the lead and its background work, every worker, the result, then the finish check", () => {
    assert.deepEqual(order(loopWithWorkers()), [
      "start",
      "lead",
      "jobs",
      `session:${STUDY}`,
      `session:${CAR}`,
      `session:${TRACK}`,
      "final",
      "finish_check",
    ]);
  });

  it("a chat turn's tree ends at its result, and is drawn without waiting for a run's outcome", () => {
    seq = 0;
    const events = [
      started(turnScope, poolWorkerId("w1"), "Check the physics"),
      finished(turnScope, poolWorkerId("w1"), "Check the physics", { state: WorkerEnd.Done }),
    ];
    assert.deepEqual(order(events), ["start", "lead", `session:${poolWorkerId("w1")}`, "final"]);
    const turn = fold(events, turnGraphKey(TURN)).graph;
    assert.equal(graphLoaded(turn, null), true, "a chat turn has no outcome to wait for");
    const run = fold(loopWithWorkers()).graph;
    assert.equal(graphLoaded(run, null), false, "a run's graph waits for its outcome");
    assert.equal(graphLoaded(run, summarizeRun(loopWithWorkers(), "game", RUN)), true);
  });
});
