/**
 * Workers, jobs and the finish check in the Builds graph's model. Every worker a lead starts is one
 * session node on its own row, folded with what the director already wrote about it; a graph that
 * holds a worker's or a job's records is a tree whose lead carries the jobs, and a run's tree ends
 * in the finish check until the run finishes. A chat turn that started workers is a graph of its
 * own, keyed by the turn. Logs without these records fold to exactly the nodes they always did.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { seedBuildGraph } from "../../src/main/dev/fixture-build-graph.ts";
import { seedLeadGraph } from "../../src/main/dev/fixture-lead-graph.ts";
import {
  buildRunGraph,
  type FacetNode,
  FinishCheckState,
  GraphNodeKind,
  type LeadNode,
  lastGraphKey,
  type RunGraph,
} from "../../src/renderer/run-graph.ts";
import { partRows, StepState, statusLine } from "../../src/renderer/run-steps.ts";
import { LeadFace, leadFace } from "../../src/renderer/run-tree.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { type EventData, type EventEnvelope, EventKind } from "../../src/shared/event-log.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { isJobState, isJobStopper, JobRole, JobState, JobStopper } from "../../src/shared/jobs.ts";
import { turnGraphKey } from "../../src/shared/run-graph-events.ts";
import { ExecutionStatus } from "../../src/shared/run-state.ts";
import {
  isWorkerEnd,
  isWorkerStopCode,
  isWorkerVerdict,
  poolWorkerId,
  WorkerEnd,
  WorkerIsolation,
  WorkerStopCode,
  WorkerVerdict,
} from "../../src/shared/workers.ts";
import { tmpDir } from "../helpers/tmp.ts";

const RUN = "run-r";
const TURN = "msg-t";

let seq = 0;
/** One record of the chat's log, a second after the one before. */
function logged(data: EventData): EventEnvelope {
  seq += 1;
  return {
    id: `e${String(seq).padStart(4, "0")}`,
    thread_id: "t1",
    session_id: null,
    turn_id: null,
    created_at: new Date(Date.UTC(2026, 0, 1, 9, 0, seq)).toISOString(),
    data,
  } as EventEnvelope;
}
const custom = (eventType: string, payload: Record<string, unknown>) =>
  logged({ type: EventKind.Custom, event_type: eventType, payload });
const inRun = (eventType: string, payload: Record<string, unknown> = {}) =>
  custom(eventType, { runId: RUN, ...payload });

/** A Loop led by a lead, started and still running. */
const runOpened = (): EventEnvelope[] => [
  inRun(CustomEvent.RunStarted, { goal: "A racing game", project: "game" }),
  inRun(CustomEvent.AutopilotStarted, { director: true, facets: [] }),
];

function started(scope: Record<string, unknown>, id: string, title: string, extra: Record<string, unknown> = {}) {
  return custom(CustomEvent.WorkerStarted, {
    ...scope,
    workerId: id,
    title,
    isolation: WorkerIsolation.Read,
    task: `${title}, then report`,
    ...extra,
  });
}
function finished(scope: Record<string, unknown>, id: string, title: string, extra: Record<string, unknown>) {
  return custom(CustomEvent.WorkerFinished, { ...scope, workerId: id, title, ...extra });
}
const runScope = { runId: RUN };
const turnScope = { turn: TURN };

function jobStarted(scope: Record<string, unknown>, jobId: string, title: string, extra: Record<string, unknown> = {}) {
  return custom(CustomEvent.JobStarted, {
    ...scope,
    jobId,
    project: "game",
    title,
    command: "make",
    cwd: ".",
    startedAt: "2026-01-01T09:00:00.000Z",
    role: JobRole.Lead,
    deadlineAt: "2026-01-01T11:00:00.000Z",
    ...extra,
  });
}
function jobEnded(scope: Record<string, unknown>, jobId: string, title: string, extra: Record<string, unknown> = {}) {
  return custom(CustomEvent.JobEnded, {
    ...scope,
    jobId,
    project: "game",
    title,
    state: JobState.Succeeded,
    exitCode: 0,
    signal: null,
    endedAt: "2026-01-01T09:04:00.000Z",
    durationMs: 240_000,
    ...extra,
  });
}

const kinds = (graph: RunGraph | null) => graph?.nodes.map((node) => node.kind);
const leadOf = (graph: RunGraph | null) =>
  graph?.nodes.find((node): node is LeadNode => node.kind === GraphNodeKind.Lead) ?? null;
const partOf = (graph: RunGraph | null, id: string): FacetNode | undefined =>
  graph?.facets.find((facet) => facet.facetId === id);

/** Each row as `[part, [[step id, state, on the line, name], …]]`. */
const rowsOf = (graph: RunGraph) =>
  partRows(graph).map((row) => [
    row.facet.facetId,
    row.steps.map((step) => [step.id, step.state, step.onLine, step.name]),
  ]);

/** What a dev fixture appends, as the log would hand it back. */
async function seeded(seed: (core: never, project: string, threadId: string) => Promise<void>) {
  const appended: EventData[] = [];
  const core = {
    store: { listEvents: async () => [] },
    layout: { runs: await tmpDir("studio-graph-workers-") },
    append: async (events: EventData[]) => void appended.push(...events),
  };
  await seed(core as never, "fixture-game", "thread-1");
  return appended.map(logged);
}
const runIdOf = (event: EventEnvelope) => (event.data as { payload?: { runId?: string } }).payload?.runId;
const ofRun = (events: EventEnvelope[], runId: string) => events.filter((event) => runIdOf(event) === runId);

/** What each of these logs folded to before workers and jobs were on the graph. */
const LOOP_KINDS = [
  ...["run", "base", "facet", "iteration", "iteration", "facet", "iteration", "iteration", "facet", "iteration"],
  ...["facet", "iteration", "facet", "iteration", "iteration", "facet", "iteration", "iteration", "facet"],
  ...["iteration", "iteration", "iteration", "facet", "iteration", "iteration", "iteration", "facet"],
  ...["iteration", "iteration", "iteration", "facet", "iteration", "iteration", "integration", "final"],
];

const LOOP_ROWS = [
  [
    "crumple",
    [
      ["step:crumple:1", "undone", false, "First build"],
      ["step:crumple:2", "undone", false, "Small fixes"],
    ],
  ],
  [
    "contact",
    [
      ["step:contact:1", "undone", false, "First build"],
      ["step:contact:2", "undone", false, "Small fixes"],
    ],
  ],
  ["cars", [["step:cars:1", "undone", false, "First build"]]],
  ["dirt", [["step:dirt:1", "undone", false, "First build"]]],
  [
    "post",
    [
      ["step:post:1", "undone", false, "First build"],
      ["step:post:2", "undone", false, "Small fixes"],
    ],
  ],
  [
    "crumple2",
    [
      ["step:crumple2:1", "in-build", true, "First build"],
      ["step:crumple2:2", "in-build", true, "Small fixes"],
    ],
  ],
  [
    "contact2",
    [
      ["step:contact2:1", "in-build", true, "First build"],
      ["step:contact2:2", "in-build", true, "Small fixes"],
      ["step:contact2:3", "in-build", true, "Small fixes"],
    ],
  ],
  [
    "cars2",
    [
      ["step:cars2:1", "in-build", true, "First build"],
      ["step:cars2:2", "in-build", true, "Small fixes"],
      ["step:cars2:3", "in-build", true, "Small fixes"],
    ],
  ],
  [
    "dirt2",
    [
      ["step:dirt2:1", "in-build", true, "First build"],
      ["step:dirt2:2", "undone", false, "Small fixes"],
      ["step:dirt2:3", "undone", false, "Small fixes"],
    ],
  ],
  [
    "post2",
    [
      ["step:post2:1", "in-build", true, "First build"],
      ["step:post2:2", "undone", false, "Small fixes"],
    ],
  ],
];

const LEAD_EARLIER_ROWS: unknown[] = [
  ["lead", [["step:lead:1", "in-build", true, "Greybox"]]],
  ["lead-atmosphere", [["step:lead-atmosphere:1", "in-build", true, "Fog and light"]]],
  ["agent-blender_model-1", [["session:agent-blender_model-1", "in-build", true, "Blender: Katana"]]],
  ["agent-texture-1", [["session:agent-texture-1", "delivered", false, "Texture: Wet concrete"]]],
  ["agent-genex_cast-1", [["session:agent-genex_cast-1", "not-delivered", false, "Meshy: Goblin"]]],
];

const BUILD_DONE_KINDS = [
  ...["run", "base", "facet", "facet", "iteration", "iteration", "iteration", "iteration", "iteration"],
  ...["iteration", "iteration", "iteration", "iteration", "iteration", "iteration", "iteration", "facet"],
  ...["iteration", "integration", "final"],
];

const BUILD_DONE_ROWS = [
  ["sword", [["session:sword", "in-build", true, "Sword, ice and light"]]],
  [
    "land",
    [
      ["step:land:1", "in-build", true, "First build"],
      ["step:land:2", "in-build", true, "Snowfall"],
      ["step:land:3", "in-build", true, "Layered depth"],
      ["step:land:4", "in-build", true, "Natural shore"],
      ["step:land:8", "undone", false, "Tall mountain"],
    ],
  ],
  ["sky", [["step:sky:1", "in-build", true, "First build"]]],
];

const BUILD_LIVE_ROWS = [
  ["sword", [["session:sword", "in-build", true, "Sword, ice and light"]]],
  [
    "land",
    [
      ["step:land:1", "in-build", true, "First build"],
      ["step:land:2", "in-build", true, "Snowfall"],
      ["step:land:3", "in-build", true, "Layered depth"],
      ["step:land:4", "judging", false, "Tall mountain"],
    ],
  ],
  ["sky", [["step:sky:1", "building", false, "First build"]]],
];

describe("old runs draw as they did", () => {
  it("a lead's synthetic Loop keeps its nodes and its rows", () => {
    const journal = JSON.parse(
      readFileSync(new URL("../fixtures/director-loop-run.json", import.meta.url), "utf8"),
    ) as EventEnvelope[];
    const graph = buildRunGraph(journal);
    assert.ok(graph);
    assert.deepEqual(kinds(graph), LOOP_KINDS);
    assert.equal(graph.tree, false);
    assert.deepEqual(rowsOf(graph), LOOP_ROWS);
  });

  it("the Unreal lead's dev fixture keeps its nodes and its rows", async () => {
    const events = await seeded(seedLeadGraph);
    const done = buildRunGraph(ofRun(events, "fixture-lead-done"));
    const live = buildRunGraph(ofRun(events, "fixture-lead-live"));
    assert.ok(done && live);
    assert.deepEqual(kinds(done), [
      ...["run", "base", "facet", "iteration", "facet", "iteration", "facet", "facet", "facet", "facet", "iteration"],
      ...["integration", "final", "assets"],
    ]);
    assert.deepEqual(rowsOf(done), [
      ...LEAD_EARLIER_ROWS,
      ["lead-combat", [["step:lead-combat:1", "in-build", true, "Katana in hand"]]],
    ]);
    assert.deepEqual(kinds(live), [
      ...["run", "base", "facet", "iteration", "facet", "iteration", "facet", "facet", "facet", "facet", "facet"],
      ...["integration", "final", "assets"],
    ]);
    assert.deepEqual(rowsOf(live), [
      ...LEAD_EARLIER_ROWS,
      ["lead-combat", [["session:lead-combat", "building", false, "Lead · Katana combat"]]],
      ["agent-sound-1", [["session:agent-sound-1", "building", false, "Sound: Blade swings"]]],
    ]);
    assert.equal(done.tree || live.tree, false);
  });

  it("the build-graph dev fixture keeps its nodes and its rows", async () => {
    const events = await seeded(seedBuildGraph);
    const done = buildRunGraph(ofRun(events, "fixture-graph-run"));
    const live = buildRunGraph(ofRun(events, "fixture-graph-live"));
    assert.ok(done && live);
    assert.deepEqual(kinds(done), BUILD_DONE_KINDS);
    assert.deepEqual(rowsOf(done), BUILD_DONE_ROWS);
    assert.deepEqual(kinds(live), [
      ...["run", "base", "facet", "facet", "iteration", "iteration", "iteration", "iteration", "iteration"],
      ...["facet", "iteration", "integration", "final"],
    ]);
    assert.deepEqual(rowsOf(live), BUILD_LIVE_ROWS);
    assert.equal(done.tree || live.tree, false);
    assert.equal(lastGraphKey(events), "fixture-graph-live", "the newest run is still the one shown");
  });
});

describe("workers on the graph", () => {
  it("draws each worker of a run as one session node on its own row", () => {
    const physics = poolWorkerId("w1");
    const steering = poolWorkerId("w2");
    const graph = buildRunGraph([
      ...runOpened(),
      started(runScope, physics, "Check the physics", { type: "researcher" }),
      started(runScope, steering, "Center the steering", { isolation: WorkerIsolation.Copy }),
      finished(runScope, physics, "Check the physics", {
        state: WorkerEnd.Done,
        summary: "The physics holds up.",
      }),
    ]);
    assert.ok(graph);
    assert.deepEqual(
      graph.facets.map((facet) => [facet.facetId, facet.title]),
      [
        [physics, "Check the physics"],
        [steering, "Center the steering"],
      ],
    );
    assert.deepEqual(
      partRows(graph).map((row) => row.steps.map((step) => [step.id, step.session])),
      [[[`session:${physics}`, true]], [[`session:${steering}`, true]]],
    );
    const done = partOf(graph, physics);
    assert.equal(done?.building, false);
    assert.equal(done?.satisfied, true);
    assert.deepEqual(done?.worker, {
      type: "researcher",
      isolation: WorkerIsolation.Read,
      in: null,
      task: "Check the physics, then report",
      summary: "The physics holds up.",
      turn: null,
      ended: WorkerEnd.Done,
      stopCode: null,
      verdict: null,
      note: null,
      merged: false,
    });
    assert.equal(partOf(graph, steering)?.building, true);
    assert.equal(partRows(graph)[1]?.steps[0]?.state, StepState.Building);
  });

  it("says which engine a worker works in, and nothing for one that names none", () => {
    const graph = buildRunGraph([
      ...runOpened(),
      started(runScope, poolWorkerId("w1"), "Build the track", {
        isolation: WorkerIsolation.Lock,
        in: GameEngine.Unreal,
      }),
      started(runScope, poolWorkerId("w2"), "Tune the lights", { in: "a toaster" }),
    ]);
    assert.equal(partOf(graph, poolWorkerId("w1"))?.worker?.in, GameEngine.Unreal);
    assert.equal(partOf(graph, poolWorkerId("w2"))?.worker?.in, null);
  });
});

describe("a worker's end and the lead's verdict", () => {
  it("a director worker that writes its old and new records is one row", () => {
    const graph = buildRunGraph([
      ...runOpened(),
      inRun(CustomEvent.DirectorWorker, { workerId: "sword", title: "Sword", mode: "single", state: "running" }),
      started(runScope, "sword", "Sword", { isolation: WorkerIsolation.Copy }),
      inRun(CustomEvent.DirectorWorker, { workerId: "sword", title: "Sword", state: "done", delivered: true }),
      finished(runScope, "sword", "Sword", { state: WorkerEnd.Done }),
    ]);
    assert.ok(graph);
    assert.deepEqual(
      graph.facets.map((facet) => facet.facetId),
      ["sword"],
    );
    const sword = partOf(graph, "sword");
    assert.equal(sword?.delivered, true, "an end record without `delivered` never clears the director's");
    assert.equal(sword?.worker?.ended, WorkerEnd.Done);
    assert.deepEqual(rowsOf(graph), [["sword", [["session:sword", StepState.Delivered, false, "Sword"]]]]);
  });

  it("a worker's start names its row: the title it was given for the person, not the one the director knows it by", () => {
    const fitting = "Fit Sword in with the rest of the game";
    const graph = buildRunGraph([
      ...runOpened(),
      inRun(CustomEvent.DirectorWorker, {
        workerId: "sword-2",
        title: "Merge Sword",
        mode: "single",
        state: "running",
      }),
      started(runScope, "sword-2", fitting, { isolation: WorkerIsolation.Copy, task: fitting }),
      inRun(CustomEvent.DirectorWorker, { workerId: "sword-2", title: "Merge Sword", state: "done" }),
      finished(runScope, "sword-2", fitting, { state: WorkerEnd.Done }),
    ]);
    assert.ok(graph);
    assert.deepEqual(rowsOf(graph), [["sword-2", [["session:sword-2", StepState.Delivered, true, fitting]]]]);
    const old = buildRunGraph([
      ...runOpened(),
      inRun(CustomEvent.DirectorWorker, {
        workerId: "sword-2",
        title: "Merge Sword",
        mode: "single",
        state: "running",
      }),
    ]);
    assert.equal(partOf(old, "sword-2")?.title, "Merge Sword", "a log without worker records reads as it did");
  });

  it("the lead's later verdict is merged into the worker's row", () => {
    const car = poolWorkerId("w1");
    const lights = poolWorkerId("w2");
    const graph = buildRunGraph([
      ...runOpened(),
      started(runScope, car, "Port the car", { isolation: WorkerIsolation.Copy }),
      started(runScope, lights, "Tune the lights", { isolation: WorkerIsolation.Copy }),
      finished(runScope, car, "Port the car", { state: WorkerEnd.Done, delivered: true, summary: "Ported the car." }),
      finished(runScope, lights, "Tune the lights", { state: WorkerEnd.Done, delivered: true }),
      finished(runScope, car, "Port the car", { verdict: WorkerVerdict.Used, merged: true }),
      finished(runScope, lights, "Tune the lights", { verdict: WorkerVerdict.Rejected, note: "Too dark at night" }),
    ]);
    assert.ok(graph);
    const ported = partOf(graph, car);
    assert.equal(ported?.worker?.ended, WorkerEnd.Done, "a verdict keeps the earlier end");
    assert.equal(ported?.worker?.summary, "Ported the car.");
    assert.equal(ported?.worker?.verdict, WorkerVerdict.Used);
    assert.equal(ported?.worker?.merged, true);
    const tuned = partOf(graph, lights);
    assert.equal(tuned?.worker?.verdict, WorkerVerdict.Rejected);
    assert.equal(tuned?.worker?.note, "Too dark at night");
    assert.equal(tuned?.stoppedBecause, "Too dark at night", "a rejected worker stopped for the lead's reason");
    const [portedRow, tunedRow] = partRows(graph);
    assert.equal(portedRow?.integrated, true, "work added to the game is in the build");
    assert.equal(portedRow?.steps[0]?.state, StepState.InBuild);
    assert.equal(tunedRow?.integrated, false);
    assert.equal(graph.mergedHead, null, "a worker's merge moves no build of the run's");
  });
});

describe("work in the game stays in the game", () => {
  it("a rejection after the work was added changes nothing on its row", () => {
    const car = poolWorkerId("w1");
    const jump = poolWorkerId("w2");
    const graph = buildRunGraph([
      ...runOpened(),
      started(runScope, car, "Port the car", { isolation: WorkerIsolation.Copy }),
      started(runScope, jump, "Tune the jump", { isolation: WorkerIsolation.Lock }),
      inRun(CustomEvent.DirectorWorker, { workerId: "sky", title: "Sky", mode: "single", state: "running" }),
      started(runScope, "sky", "Sky", { isolation: WorkerIsolation.Copy }),
      finished(runScope, car, "Port the car", { state: WorkerEnd.Done, delivered: true }),
      finished(runScope, car, "Port the car", { verdict: WorkerVerdict.Used, merged: true }),
      finished(runScope, car, "Port the car", { verdict: WorkerVerdict.Rejected, note: "pulls left" }),
      finished(runScope, jump, "Tune the jump", { state: WorkerEnd.Done, inGame: true }),
      finished(runScope, jump, "Tune the jump", { verdict: WorkerVerdict.Rejected, note: "too floaty" }),
      finished(runScope, "sky", "Sky", { state: WorkerEnd.Done, delivered: true }),
      inRun(CustomEvent.IntegrationMerge, { facetId: "sky", head: "h1", commit: "c1", conflict: false }),
      finished(runScope, "sky", "Sky", { verdict: WorkerVerdict.Rejected }),
    ]);
    assert.ok(graph);
    const rows = partRows(graph).map((row) => [row.facet.facetId, row.integrated, row.facet.worker?.merged]);
    assert.deepEqual(rows, [
      [car, true, true],
      [jump, true, true],
      ["sky", true, false],
    ]);
    assert.deepEqual(
      partRows(graph).map((row) => row.steps.map((step) => step.state)),
      [[StepState.InBuild], [StepState.InBuild], [StepState.InBuild]],
    );
    assert.equal(partOf(graph, car)?.stoppedBecause, "done", "the lead's note on a refused rejection stops nothing");
  });
});

describe("the lead and its background work", () => {
  it("a graph with workers or jobs is a tree whose lead carries the jobs; a graph with neither has no lead node", () => {
    const plain = buildRunGraph(runOpened());
    assert.equal(plain?.tree, false);
    assert.equal(leadOf(plain), null);

    const withJobs = buildRunGraph([
      ...runOpened(),
      jobStarted(runScope, "j1", "Unreal build"),
      jobStarted(runScope, "j2", "Shader compile", {
        role: JobRole.Worker,
        worker: { id: "w1", title: "Port the car" },
      }),
      jobEnded(runScope, "j1", "Unreal build"),
      jobEnded(runScope, "j3", "Asset cook", { state: JobState.Stopped, stoppedBy: JobStopper.Person, exitCode: null }),
    ]);
    assert.equal(withJobs?.tree, true);
    assert.deepEqual(kinds(withJobs)?.slice(0, 3), ["run", "base", "lead"]);
    assert.deepEqual(leadOf(withJobs)?.jobs, [
      {
        jobId: "j1",
        title: "Unreal build",
        who: null,
        state: JobState.Succeeded,
        exitCode: 0,
        startedAt: "2026-01-01T09:00:00.000Z",
        endedAt: "2026-01-01T09:04:00.000Z",
        durationMs: 240_000,
        stoppedBy: null,
      },
      {
        jobId: "j2",
        title: "Shader compile",
        who: "Port the car",
        state: JobState.Running,
        exitCode: null,
        startedAt: "2026-01-01T09:00:00.000Z",
        endedAt: null,
        durationMs: null,
        stoppedBy: null,
      },
      {
        jobId: "j3",
        title: "Asset cook",
        who: null,
        state: JobState.Stopped,
        exitCode: null,
        startedAt: null,
        endedAt: "2026-01-01T09:04:00.000Z",
        durationMs: 240_000,
        stoppedBy: JobStopper.Person,
      },
    ]);

    const withWorkers = buildRunGraph([...runOpened(), started(runScope, poolWorkerId("w1"), "Port the car")]);
    assert.equal(withWorkers?.tree, true);
    assert.deepEqual(leadOf(withWorkers)?.jobs, []);
  });

  it("a run's tree ends in the finish check until the run finishes; a chat turn's never does", () => {
    const working = [...runOpened(), started(runScope, poolWorkerId("w1"), "Port the car")];
    const running = buildRunGraph(working);
    const check = running?.nodes.at(-1);
    assert.equal(check?.kind, GraphNodeKind.FinishCheck);
    assert.deepEqual(check, {
      kind: GraphNodeKind.FinishCheck,
      id: GraphNodeKind.FinishCheck,
      state: FinishCheckState.NotYet,
      reasons: [],
      round: null,
    });
    assert.ok(
      running?.edges.some((edge) => edge.from === GraphNodeKind.Final && edge.to === GraphNodeKind.FinishCheck),
    );

    const pauses: Array<[string, EventEnvelope[]]> = [
      ["paused alone", [inRun(CustomEvent.AutopilotPaused, { reason: "limit" })]],
      [
        "the director's pause: its close says paused, then the pause",
        [
          inRun(CustomEvent.RunFinished, { executionStatus: ExecutionStatus.Paused }),
          inRun(CustomEvent.AutopilotPaused, { reason: "limit" }),
        ],
      ],
    ];
    for (const [name, pause] of pauses) {
      const paused = buildRunGraph([...working, ...pause]);
      assert.equal(paused?.nodes.at(-1)?.kind, GraphNodeKind.FinishCheck, `a paused run is not over: ${name}`);
    }

    const over = buildRunGraph([...working, inRun(CustomEvent.RunFinished, { victory: true })]);
    assert.equal(over?.tree, true);
    assert.equal(kinds(over)?.includes(GraphNodeKind.FinishCheck), false, "a finished run with no check draws none");

    const turn = buildRunGraph([started(turnScope, poolWorkerId("w1"), "Check the physics")]);
    assert.equal(turn?.tree, true);
    assert.equal(kinds(turn)?.includes(GraphNodeKind.FinishCheck), false);
  });

  it("a Loop whose lead says it writes worker records is a tree from its start: the lead never moves when a worker starts", () => {
    const opened = [
      inRun(CustomEvent.RunStarted, { goal: "A racing game", project: "game" }),
      inRun(CustomEvent.AutopilotStarted, { director: true, facets: [], workerRecords: true }),
    ];
    const alone = buildRunGraph(opened);
    assert.equal(alone?.tree, true);
    assert.deepEqual(kinds(alone), ["run", "base", "lead", "integration", "final", "finish_check"]);
    const withWorker = buildRunGraph([...opened, started(runScope, poolWorkerId("w1"), "Port the car")]);
    assert.deepEqual(
      kinds(withWorker)?.filter((kind) => kind !== GraphNodeKind.Facet),
      kinds(alone),
      "the first worker adds its row; the lead and the finish check stay where they were",
    );
    assert.equal(buildRunGraph(runOpened())?.tree, false, "a start that does not say so keeps today's layout");
  });
});

describe("a chat turn's own graph", () => {
  /** A Loop, then a chat message that started two workers and a job of the chat's own. */
  const log = (ask?: string): EventEnvelope[] => [
    ...runOpened(),
    started(runScope, poolWorkerId("w1"), "Study the web game"),
    inRun(CustomEvent.RunFinished, { victory: true }),
    logged({ type: EventKind.Messages, messages: [{ role: "user", content: "Make the car feel heavier" }] }),
    custom(CustomEvent.CoordinatorMessageQueued, { messageId: TURN, eventId: `e${String(seq).padStart(4, "0")}` }),
    started(turnScope, poolWorkerId("w1"), "Check the physics", ask ? { ask } : {}),
    started(turnScope, poolWorkerId("w2"), "Center the steering", { isolation: WorkerIsolation.Copy }),
    jobStarted(turnScope, "j1", "Physics probe", { role: JobRole.Chat }),
    finished(turnScope, poolWorkerId("w1"), "Check the physics", { state: WorkerEnd.Done }),
  ];

  it("a chat turn that started workers is its own graph, keyed by the turn", () => {
    const events = log("Make the car feel heavier, please");
    assert.equal(lastGraphKey(events), turnGraphKey(TURN));
    const turn = buildRunGraph(events);
    assert.ok(turn);
    assert.equal(turn.turn, TURN);
    assert.equal(turn.runId, turnGraphKey(TURN));
    assert.equal(turn.mergedHead, null);
    const run = turn.nodes.find((node) => node.kind === GraphNodeKind.Run);
    assert.ok(run?.kind === GraphNodeKind.Run);
    assert.equal(run.goal, "Make the car feel heavier, please");
    assert.equal(run.director, true);
    const firstOfTurn = events.find((event) => (event.data as { payload?: { turn?: string } }).payload?.turn === TURN);
    assert.equal(run.startedAt, firstOfTurn?.created_at, "it started with its first worker");
    assert.equal(turn.active, true, "a worker still works");
    assert.deepEqual(
      turn.facets.map((facet) => facet.title),
      ["Check the physics", "Center the steering"],
    );
    assert.deepEqual(
      leadOf(turn)?.jobs.map((job) => job.title),
      ["Physics probe"],
    );
    const loop = buildRunGraph(events, RUN);
    assert.ok(loop);
    assert.equal(loop.turn, undefined);
    assert.deepEqual(
      loop.facets.map((facet) => facet.title),
      ["Study the web game"],
    );
    assert.deepEqual(leadOf(loop)?.jobs, []);
  });

  it("a chat turn's goal is the queued message when its workers did not keep it", () => {
    const turn = buildRunGraph(log());
    const run = turn?.nodes.find((node) => node.kind === GraphNodeKind.Run);
    assert.equal(run?.kind === GraphNodeKind.Run && run.goal, "Make the car feel heavier");
  });

  it("a chat turn is done once every worker of it has ended", () => {
    const events = [
      ...log(),
      finished(turnScope, poolWorkerId("w2"), "Center the steering", { state: WorkerEnd.Done, delivered: true }),
    ];
    const turn = buildRunGraph(events);
    assert.equal(turn?.active, false);
    const final = turn?.nodes.find((node) => node.kind === GraphNodeKind.Final);
    assert.equal(final?.kind === GraphNodeKind.Final && final.done, true);
  });

  it("a chat turn whose workers ended still works while the lead answers its message", () => {
    const allEnded = [
      ...log(),
      custom(CustomEvent.CoordinatorMessageProcessing, { messageId: TURN }),
      finished(turnScope, poolWorkerId("w2"), "Center the steering", { state: WorkerEnd.Done, delivered: true }),
    ];
    const answering = buildRunGraph(allEnded);
    assert.ok(answering);
    assert.equal(answering.active, true, "the lead still answers the message");
    const rows = partRows(answering);
    assert.equal(leadFace(answering, null, rows), LeadFace.Working);
    const line = statusLine(answering, null, rows, Date.UTC(2026, 0, 1, 10));
    assert.deepEqual([line.strong, line.rest], ["Working", ""]);
    const final = answering.nodes.find((node) => node.kind === GraphNodeKind.Final);
    assert.equal(final?.kind === GraphNodeKind.Final && final.done, false);
    const answered = buildRunGraph([...allEnded, custom(CustomEvent.CoordinatorMessageHandled, { messageId: TURN })]);
    assert.equal(answered?.active, false, "answered: the turn is done");
    assert.equal(answered && leadFace(answered, null, partRows(answered)), LeadFace.Done);
  });
});

describe("a worker started again", () => {
  it("a start after the worker's end is a new attempt on the same row: nothing of the old end or verdict carries over", () => {
    const sword = poolWorkerId("sword");
    const firstAttempt = [
      ...runOpened(),
      started(runScope, sword, "Sword", { isolation: WorkerIsolation.Copy }),
      finished(runScope, sword, "Sword", { state: WorkerEnd.Stopped, stoppedBecause: "the run paused" }),
      finished(runScope, sword, "Sword", { verdict: WorkerVerdict.Rejected, note: "the blade clips the hand" }),
    ];
    const again = [...firstAttempt, started(runScope, sword, "Sword", { isolation: WorkerIsolation.Copy })];
    const working = buildRunGraph(again);
    assert.equal(working?.facets.length, 1, "one row");
    const part = partOf(working, sword);
    assert.equal(part?.building, true);
    assert.equal(part?.stoppedBecause, null);
    assert.deepEqual([part?.worker?.ended, part?.worker?.verdict, part?.worker?.note], [null, null, null]);
    const ended = buildRunGraph([...again, finished(runScope, sword, "Sword", { state: WorkerEnd.Done })]);
    assert.ok(ended);
    assert.deepEqual(rowsOf(ended), [[sword, [[`session:${sword}`, StepState.Delivered, true, "Sword"]]]]);
    const endFirst = buildRunGraph([
      ...runOpened(),
      finished(runScope, sword, "Sword", { state: WorkerEnd.Failed, stoppedBecause: "crashed" }),
      started(runScope, sword, "Sword"),
    ]);
    assert.equal(partOf(endFirst, sword)?.building, true, "an end on the page before a start: the start is newer");
  });
});

describe("a builder restarted under a new id", () => {
  it("its worker records land on the row it replaces, as its director records do", () => {
    const opened = [
      ...runOpened(),
      inRun(CustomEvent.DirectorWorker, { workerId: "sword", title: "Sword", mode: "single", state: "running" }),
      started(runScope, "sword", "Sword", { isolation: WorkerIsolation.Copy }),
      inRun(CustomEvent.DirectorWorker, {
        workerId: "sword-2",
        title: "Sword",
        mode: "single",
        state: "running",
        replaces: "sword",
      }),
      started(runScope, "sword-2", "Sword", { isolation: WorkerIsolation.Copy, task: "Sword, again" }),
    ];
    const working = buildRunGraph(opened);
    assert.deepEqual(
      working?.facets.map((facet) => facet.facetId),
      ["sword"],
      "one row",
    );
    assert.equal(partOf(working, "sword")?.worker?.task, "Sword, again", "it reads as the new attempt");
    const ended = buildRunGraph([
      ...opened,
      finished(runScope, "sword-2", "Sword", { state: WorkerEnd.Done, summary: "Forged the sword." }),
    ]);
    assert.ok(ended);
    assert.deepEqual(
      ended.facets.map((facet) => facet.facetId),
      ["sword"],
    );
    const sword = partOf(ended, "sword");
    assert.equal(sword?.worker?.ended, WorkerEnd.Done);
    assert.equal(sword?.worker?.summary, "Forged the sword.");
    assert.equal(partRows(ended)[0]?.steps.length, 1, "one session step");
  });
});

describe("records the graph cannot place", () => {
  it("ignores worker and job records it cannot place, and never doubles a row", () => {
    const rows: Array<[string, EventEnvelope[], (graph: RunGraph | null) => void]> = [
      [
        "a worker record with no id, or an empty one",
        [
          ...runOpened(),
          custom(CustomEvent.WorkerStarted, { runId: RUN, title: "Nameless" }),
          started(runScope, "", "Empty"),
          finished(runScope, "", "Empty", { state: WorkerEnd.Done }),
        ],
        (graph) => {
          assert.deepEqual(graph?.facets, []);
          assert.equal(graph?.tree, false, "nothing placed: no tree");
        },
      ],
      [
        "a record naming both a run and a turn is the run's",
        [...runOpened(), started({ runId: RUN, turn: TURN }, poolWorkerId("w1"), "Both")],
        (graph) => {
          assert.equal(graph?.runId, RUN);
          assert.deepEqual(
            graph?.facets.map((facet) => facet.title),
            ["Both"],
          );
        },
      ],
      [
        "a repeated start for a worker still working: one row, as the first start and what came after left it",
        [
          ...runOpened(),
          started(runScope, poolWorkerId("w1"), "Port it", { isolation: WorkerIsolation.Copy }),
          inRun(CustomEvent.DirectorWorker, {
            workerId: poolWorkerId("w1"),
            title: "Port it",
            state: "done",
            delivered: true,
          }),
          started(runScope, poolWorkerId("w1"), "Port it", { isolation: WorkerIsolation.Read, task: "Something else" }),
        ],
        (graph) => {
          assert.equal(graph?.facets.length, 1);
          const part = partOf(graph, poolWorkerId("w1"));
          assert.equal(part?.worker?.task, "Port it, then report");
          assert.equal(part?.worker?.isolation, WorkerIsolation.Copy);
          assert.equal(part?.delivered, true, "what the director wrote in between stands");
        },
      ],
      [
        "a job with neither a run nor a turn, and a job with no id",
        [...runOpened(), jobStarted({}, "j1", "Loose"), jobStarted(runScope, "", "Nameless")],
        (graph) => {
          assert.equal(graph?.tree, false);
          assert.equal(leadOf(graph), null);
        },
      ],
    ];
    for (const [name, events, check] of rows) {
      const graph = buildRunGraph(events);
      assert.doesNotThrow(() => check(graph), name);
    }
    assert.equal(buildRunGraph(log2(), turnGraphKey("no-such-turn")), null, "a turn with no workers has no graph");
    assert.equal(buildRunGraph([jobStarted(turnScope, "j1", "Alone")], turnGraphKey(TURN)), null);
    assert.equal(lastGraphKey([jobStarted(turnScope, "j1", "Alone")]), null, "a job alone makes no turn's graph");
    const finishedRun = [...runOpened(), inRun(CustomEvent.RunFinished, { status: "done" })];
    for (const nameless of [
      custom(CustomEvent.WorkerStarted, { turn: TURN, title: "Nameless", isolation: WorkerIsolation.Read, task: "x" }),
      started(turnScope, "", "Empty"),
      finished(turnScope, "", "Empty", { state: WorkerEnd.Done }),
    ]) {
      const events = [...finishedRun, nameless];
      assert.equal(lastGraphKey(events), RUN, "a worker record naming no worker places no turn");
      assert.equal(buildRunGraph(events)?.runId, RUN, "the run stays on Builds");
    }
  });
});

it("a worker's end, stop code and verdict are read only from their own words", () => {
  const vocabularies: Array<[string, Record<string, string>, (value: unknown) => boolean]> = [
    ["end", WorkerEnd, isWorkerEnd],
    ["stop code", WorkerStopCode, isWorkerStopCode],
    ["verdict", WorkerVerdict, isWorkerVerdict],
  ];
  for (const [name, vocabulary, is] of vocabularies) {
    for (const value of Object.values(vocabulary)) assert.equal(is(value), true, `${name}: ${value}`);
    for (const hostile of ["", "DONE", "finished", "busy", "__proto__", "toString", null, undefined, 3, {}, ["done"]])
      assert.equal(is(hostile), false, `${name}: ${String(hostile)}`);
  }
  assert.equal(isWorkerVerdict(WorkerEnd.Done), false, "an end is no verdict");
});

it("a hostile field of a worker record reads as if it were absent, and the row keeps its words", () => {
  const car = poolWorkerId("w1");
  const hostile: Array<[string, Record<string, unknown>, string]> = [
    ["a stop code no table knows", { state: WorkerEnd.Failed, stopCode: "busy" }, "stopCode"],
    ["a stop code naming an object's own key", { state: WorkerEnd.Failed, stopCode: "__proto__" }, "stopCode"],
    ["a stop code that is a number", { state: WorkerEnd.Failed, stopCode: 3 }, "stopCode"],
    ["a state of another vocabulary", { state: "finished" }, "state"],
    ["a state in capitals", { state: "DONE" }, "state"],
    ["a verdict in capitals", { verdict: "USED" }, "verdict"],
    ["a verdict that is an object", { verdict: {} }, "verdict"],
    ["a summary that is a number", { state: WorkerEnd.Done, summary: 42 }, "summary"],
  ];
  const before = finished(runScope, car, "Port the car", { state: WorkerEnd.Done, summary: "Ported the car." });
  for (const [name, payload, field] of hostile) {
    const { [field]: _dropped, ...absent } = payload;
    for (const prior of [[], [before]]) {
      const read = (end: Record<string, unknown>) => {
        const graph = buildRunGraph([
          ...runOpened(),
          started(runScope, car, "Port the car", { isolation: WorkerIsolation.Copy }),
          ...prior,
          finished(runScope, car, "Port the car", end),
        ]);
        assert.ok(graph, name);
        return [rowsOf(graph), partOf(graph, car)?.worker, partOf(graph, car)?.stoppedBecause];
      };
      assert.deepEqual(read(payload), read(absent), `${name}${prior.length ? ", after an end" : ""}`);
    }
  }
});

it("a job's state and who stopped it are read only from their own words", () => {
  for (const value of Object.values(JobState)) assert.equal(isJobState(value), true, value);
  for (const value of Object.values(JobStopper)) assert.equal(isJobStopper(value), true, value);
  for (const hostile of ["", "RUNNING", "done", " failed", null, undefined, 3, {}, ["failed"]]) {
    assert.equal(isJobState(hostile), false, String(hostile));
    assert.equal(isJobStopper(hostile), false, String(hostile));
  }
  assert.equal(isJobStopper(JobState.Failed), false, "a state is no stopper");
});

function log2(): EventEnvelope[] {
  return [...runOpened(), started(turnScope, poolWorkerId("w1"), "Check the physics")];
}
