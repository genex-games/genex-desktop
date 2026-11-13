/**
 * The Builds graph as a tree: a graph that holds a worker's or a job's records has a lead between
 * its workers, its background work and, in a run, the finish check. The lead says what it is doing,
 * each worker reads in plain words, and a graph with no worker and no job is no tree.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { seedBuildGraph } from "../../src/main/dev/fixture-build-graph.ts";
import { buildRunGraph, GraphNodeKind, type RunGraph } from "../../src/renderer/run-graph.ts";
import type { JobInfo } from "../../src/renderer/run-graph-workers.ts";
import { leadWorking, PictureSource, partRows, statusLine, stepPill, stepWord } from "../../src/renderer/run-steps.ts";
import {
  graphLoaded,
  jobsTileStatus,
  LeadFace,
  leadFace,
  type LeadRest,
  leadRest,
  readingNodes,
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

/** The save point a resting lead wears, by its id. */
const savedAt = (rest: LeadRest | null): string | null => (rest && "save" in rest ? rest.save.id : null);

/** A trimmed run's log in `fixtures/`. */
const readLog = (name: string): EventEnvelope[] =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as EventEnvelope[];

/** What a dev fixture appends, as the log would hand it back. */
async function seeded(seed: (core: never, project: string, threadId: string) => Promise<void>) {
  const appended: EventData[] = [];
  const core = {
    store: { listEvents: async () => [], writeArtifact: async () => 0 },
    layout: { runs: await tmpDir("studio-run-tree-") },
    append: async (events: EventData[]) => void appended.push(...events),
  };
  await seed(core as never, "fixture-game", "thread-1");
  return appended.map(logged);
}

describe("a graph without workers or jobs is no tree", () => {
  it("a lead's run between parts is no tree, and the lead has the run", () => {
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
  });

  it("the build-graph dev fixture is no tree, and only its running run was asked with pictures", async () => {
    seq = 0;
    const events = await seeded(seedBuildGraph);
    for (const runId of ["fixture-graph-run", "fixture-graph-live"]) {
      const { graph } = fold(events, runId);
      assert.equal(graph.tree, false);
      // The running run answers a message sent with pictures.
      const startWords = graph.nodes.some((node) => node.kind === GraphNodeKind.Run && node.asked !== null);
      assert.equal(startWords, runId === "fixture-graph-live", runId);
    }
  });
});

describe("the tree", () => {
  it("a Loop's lead with workers is a tree", () => {
    const { graph } = fold(loopWithWorkers());
    assert.equal(graph.tree, true);
  });

  it("a typed worker the lead used, not added yet, reads Done", () => {
    const { graph, rows } = fold(
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
    const sound = rows.find((row) => row.facet.facetId === SOUND)?.steps[0];
    assert.ok(sound);
    assert.equal(stepWord(sound, graph.active), "Done");
  });

  it("a director's builder that handed work back stays off the line until the lead integrates it, also after the run ends", () => {
    const builder = (extra: EventEnvelope[]) => [
      ...runOpened(),
      inRun(CustomEvent.DirectorWorker, { workerId: "sky", title: "Sky", mode: "single", state: "running" }),
      started(runScope, "sky", "Sky", { isolation: WorkerIsolation.Copy }),
      inRun(CustomEvent.DirectorWorker, { workerId: "sky", title: "Sky", mode: "single", state: "done" }),
      // What the director writes for a builder that finished with a commit of its own.
      finished(runScope, "sky", "Sky", { state: WorkerEnd.Done, delivered: true }),
      ...extra,
    ];
    const onLine = (events: EventEnvelope[]) => fold(events).rows[0]?.steps[0]?.onLine;
    assert.equal(onLine(builder([])), false, "handed back, not integrated yet");
    assert.equal(onLine(builder([inRun(CustomEvent.RunFinished, { status: "done" })])), false, "never integrated");
    const merged = inRun(CustomEvent.IntegrationMerge, { facetId: "sky", commit: "c1", head: "h1", conflict: false });
    assert.equal(onLine(builder([merged])), true, "integrated: in the build");
  });
});

describe("trees of other shapes", () => {
  it("a Loop's lead with one worker and no jobs is a tree", () => {
    seq = 0;
    const plain = fold([...runOpened(), started(runScope, STUDY, "Study the web game")]);
    assert.equal(plain.graph.tree, true);
  });

  it("a chat turn's tree is its turn's, and its lead is done", () => {
    seq = 0;
    const { graph, summary, rows } = fold([
      started(turnScope, poolWorkerId("w1"), "Check the physics", { ask: "The car drifts left" }),
      finished(turnScope, poolWorkerId("w1"), "Check the physics", { state: WorkerEnd.Done }),
    ]);
    assert.equal(graph.turn, TURN);
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

  it("done or paused, the lead wears the run's last save point; at work, waiting or stopped, nothing of its own", () => {
    const { graph, rows } = fold(readLog("lead-in-place-run.json"));
    const rests = Object.values(LeadFace).map((face) => [face, savedAt(leadRest(graph, rows, face))]);
    assert.deepEqual(rests, [
      [LeadFace.Working, null],
      [LeadFace.Waiting, null],
      [LeadFace.Paused, "step:lead:11"],
      [LeadFace.Done, "step:lead:11"],
      [LeadFace.Stopped, null],
    ]);
  });

  it("done with a last save point that kept no picture, the lead wears its build's picture instead of nothing", () => {
    const log = readLog("lead-in-place-run.json").map((event) => {
      const payload = (event.data as { payload?: Record<string, unknown> }).payload;
      return payload?.facetId === "lead"
        ? { ...event, data: { ...event.data, payload: { ...payload, shots: [] } } }
        : event;
    }) as EventEnvelope[];
    const { graph, rows } = fold(log);
    const build = "/runs/run_x/director/finish.jpg";
    assert.deepEqual(leadRest(graph, rows, LeadFace.Done, build), { build });
    assert.equal(
      savedAt(leadRest(graph, rows, LeadFace.Done)),
      "step:lead:11",
      "with no build picture either, its save point",
    );
    const pictured = fold(readLog("lead-in-place-run.json"));
    assert.equal(savedAt(leadRest(pictured.graph, pictured.rows, LeadFace.Done, build)), "step:lead:11");
    assert.equal(leadRest(graph, rows, LeadFace.Stopped, build), null);
    // A health check's picture may predate the save point: it never stands in for one.
    graph.health.push({
      head: null,
      ok: true,
      picture: "/runs/run_x/director/older.jpg",
      worker: null,
      problems: [],
      findings: null,
      seq: 0,
      at: null,
    });
    assert.equal(savedAt(leadRest(graph, rows, LeadFace.Done)), "step:lead:11");
  });

  it("done in a Loop without save points, the lead wears its newest build's screenshot", () => {
    // Two turns of one Loop: the first's checks were recorded before checks named their pictures.
    const { graph, summary, rows } = fold(readLog("loop-two-turns-run.json"));
    const face = leadFace(graph, summary, rows);
    assert.equal(face, LeadFace.Done);
    assert.deepEqual(leadRest(graph, rows, face), { build: "/runs/run_mvv2cixs406k/director/finish_d3f19a7f4e.jpg" });
    assert.equal(leadRest(graph, rows, LeadFace.Stopped), null, "a stopped lead's work is not where its build is");
    const pictures = rows.map((row) => [row.facet.title, row.steps[0]?.picture ?? null]);
    assert.deepEqual(
      pictures,
      [
        ["Boat sound effects", null],
        [
          "Rock explosion sound",
          { source: PictureSource.Build, path: "/runs/run_mvv2cixs406k/director/merge_w2_d3f19a7f4e.jpg" },
        ],
      ],
      "a worker whose merge check named no picture (an older record) wears none",
    );
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

describe("when the graph is drawn", () => {
  it("a chat turn's graph is drawn without waiting for a run's outcome; a run's waits for its outcome", () => {
    seq = 0;
    const events = [
      started(turnScope, poolWorkerId("w1"), "Check the physics"),
      finished(turnScope, poolWorkerId("w1"), "Check the physics", { state: WorkerEnd.Done }),
    ];
    const turn = fold(events, turnGraphKey(TURN)).graph;
    assert.equal(graphLoaded(turn, null), true, "a chat turn has no outcome to wait for");
    const run = fold(loopWithWorkers()).graph;
    assert.equal(graphLoaded(run, null), false, "a run's graph waits for its outcome");
    assert.equal(graphLoaded(run, summarizeRun(loopWithWorkers(), "game", RUN)), true);
  });

  it("a graph that is no tree reads as none", async () => {
    seq = 0;
    const events = await seeded(seedBuildGraph);
    for (const runId of ["fixture-graph-run", "fixture-graph-live"]) {
      const { graph, summary, rows } = fold(events, runId);
      assert.equal(readingNodes(graph, rows, summary).tree, false, runId);
    }
  });
});
