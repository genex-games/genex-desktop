/**
 * A Loop's build history on the Builds graph. Each health check of the integration head is a build
 * ("Build 1", "Build 2", …) wearing that check's screenshot and outcome; a worker hangs off the build
 * its work went into, or the build it started from; per build, finished workers past a few fold into
 * one card that opens in place. Runs whose checks name nothing new draw as they always did.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRunGraph, joinBuildsView, type RunGraph } from "../../src/renderer/run-graph.ts";
import {
  BuildOutcome,
  buildOutcome,
  buildTimeline,
  foldId,
  placedWord,
  WORKERS_SHOWN,
} from "../../src/renderer/run-graph-builds.ts";
import {
  PictureSource,
  partRows,
  resultStatus,
  type Step,
  StepEdgeKind,
  StepState,
  stepWord,
} from "../../src/renderer/run-steps.ts";
import type { RunSummary } from "../../src/shared/run-summary.ts";
import { buildsLayout } from "../../src/renderer/run-tree.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { type EventEnvelope, EventKind } from "../../src/shared/event-log.ts";
import { HealthFinding } from "../../src/shared/preview-contract.ts";
import { poolWorkerId, WorkerEnd, WorkerIsolation, WorkerVerdict } from "../../src/shared/workers.ts";

const RUN = "run-b";
const H = (digit: number): string => String(digit).repeat(40);
const shot = (label: string): string => `/runs/${RUN}/director/${label}.jpg`;

let seq = 0;
function inRun(eventType: string, payload: Record<string, unknown> = {}): EventEnvelope {
  seq += 1;
  return {
    id: `e${String(seq).padStart(4, "0")}`,
    thread_id: "t1",
    session_id: null,
    turn_id: null,
    created_at: new Date(Date.UTC(2026, 0, 1, 9, 0, seq)).toISOString(),
    data: { type: EventKind.Custom, event_type: eventType, payload: { runId: RUN, ...payload } },
  } as EventEnvelope;
}

const start = (id: string, title: string) =>
  inRun(CustomEvent.WorkerStarted, {
    workerId: poolWorkerId(id),
    title,
    isolation: WorkerIsolation.Copy,
    task: `${title}.`,
  });
const end = (id: string, title: string, state: WorkerEnd = WorkerEnd.Done) =>
  inRun(CustomEvent.WorkerFinished, { workerId: poolWorkerId(id), title, state, delivered: state === WorkerEnd.Done });
const used = (id: string, title: string) =>
  inRun(CustomEvent.WorkerFinished, {
    workerId: poolWorkerId(id),
    title,
    verdict: WorkerVerdict.Used,
    merged: true,
  });
const rejected = (id: string, title: string) =>
  inRun(CustomEvent.WorkerFinished, {
    workerId: poolWorkerId(id),
    title,
    verdict: WorkerVerdict.Rejected,
    note: "It broke the track.",
  });
const check = (head: string, extra: Record<string, unknown> = {}) =>
  inRun(CustomEvent.IntegrationHealth, { head, ok: true, problems: [], findings: [], ...extra });

/**
 * A Loop of three builds: a reader that started first and merged nothing, the car (Build 1), the
 * engine sounds (Build 2, a merge that changed no picture), a track worker the lead did not use,
 * six more not used off Build 2, one still working, and the lead's own commit (Build 3) whose
 * first check was blank and whose finish found it throwing.
 */
function loop(): EventEnvelope[] {
  seq = 0;
  const events = [
    inRun(CustomEvent.RunStarted, { goal: "A racing game", project: "game" }),
    inRun(CustomEvent.AutopilotStarted, { director: true, facets: [], workerRecords: true }),
    start("w0", "Study the game"),
    start("w1", "Blender rival GT car"),
    end("w0", "Study the game"),
    end("w1", "Blender rival GT car"),
    check(H(1), { picture: shot("merge_w1"), worker: poolWorkerId("w1") }),
    used("w1", "Blender rival GT car"),
    start("w2", "Synth engine sounds"),
    start("w3", "Build the track"),
    end("w2", "Synth engine sounds"),
    check(H(2), { picture: shot("merge_w2"), worker: "w2" }),
    used("w2", "Synth engine sounds"),
    end("w3", "Build the track"),
    rejected("w3", "Build the track"),
  ];
  for (let n = 4; n <= 9; n++) {
    events.push(start(`w${n}`, `Try a paint scheme ${n}`));
    events.push(end(`w${n}`, `Try a paint scheme ${n}`, n % 2 ? WorkerEnd.Stopped : WorkerEnd.Done));
    if (n % 2 === 0) events.push(rejected(`w${n}`, `Try a paint scheme ${n}`));
  }
  events.push(start("w10", "Tune the drift"));
  events.push(
    check(H(3), {
      ok: false,
      problems: ["the page's frame is blank"],
      findings: [HealthFinding.Blank],
      picture: shot("finish_1"),
    }),
  );
  events.push(
    check(H(3), {
      ok: false,
      problems: ["1 uncaught error: TypeError"],
      findings: [HealthFinding.Uncaught],
      picture: shot("finish_2"),
    }),
  );
  return events;
}

function graphOf(events: EventEnvelope[]): RunGraph {
  const graph = buildRunGraph(events);
  assert.ok(graph);
  return graph;
}

const stepOf = (graph: RunGraph, id: string): Step | undefined =>
  partRows(graph)
    .flatMap((row) => row.steps)
    .find((step) => step.facetId === poolWorkerId(id));

describe("a Loop's build history", () => {
  it("is one build per head its health checks looked at, each with its picture and outcome", () => {
    const timeline = buildTimeline(graphOf(loop()), partRows(graphOf(loop())));
    assert.ok(timeline);
    assert.deepEqual(
      timeline.builds.map((build) => [build.n, build.head, build.worker, build.outcome, build.picture]),
      [
        [1, H(1), poolWorkerId("w1"), BuildOutcome.Passed, shot("merge_w1")],
        [2, H(2), poolWorkerId("w2"), BuildOutcome.Passed, shot("merge_w2")],
        [3, H(3), null, BuildOutcome.Errors, shot("finish_2")],
      ],
      "a second check of an unchanged head is that build looked at again: its newest word and picture",
    );
  });

  it("reads a check's outcome from the host's codes, never its words", () => {
    assert.equal(buildOutcome({ ok: true, findings: [] }), BuildOutcome.Passed);
    assert.equal(buildOutcome({ ok: false, findings: [HealthFinding.Blank] }), BuildOutcome.Blank);
    for (const broken of [HealthFinding.NotLoaded, HealthFinding.Crashed, HealthFinding.Uncaught])
      assert.equal(buildOutcome({ ok: false, findings: [broken, HealthFinding.Blank] }), BuildOutcome.Errors, broken);
    assert.equal(buildOutcome({ ok: false, findings: [] }), BuildOutcome.Failed, "a check that could not run");
    assert.equal(buildOutcome({ ok: false, findings: null }), BuildOutcome.Failed, "an older record: no codes");
    const graph = graphOf([...loop(), check(H(4), { ok: false, problems: ["blank"], findings: ["BLANK", 3] })]);
    assert.equal(buildTimeline(graph, partRows(graph))?.builds.at(-1)?.outcome, BuildOutcome.Failed, "unknown codes");
  });

  it("hangs each worker off the build its work went into, else the build it started from", () => {
    const graph = graphOf(loop());
    const timeline = buildTimeline(graph, partRows(graph));
    assert.ok(timeline);
    const place = (id: string) => timeline.places.get(stepOf(graph, id)?.id ?? "");
    assert.deepEqual(place("w0"), { build: 0, merged: false }, "started before the first build: the lead's");
    assert.deepEqual(place("w1"), { build: 1, merged: true });
    assert.deepEqual(place("w2"), { build: 2, merged: true }, "a bare `w2` on the check is the pool's worker");
    assert.deepEqual(place("w3"), { build: 1, merged: false }, "not used: off the build it started from");
    assert.deepEqual(place("w9"), { build: 2, merged: false });
    assert.deepEqual(place("w10"), { build: 2, merged: false }, "still working, off the build it started from");
  });

  it("folds a build's finished workers past a few into one card, never one at work, and opens it in place", () => {
    const graph = graphOf(loop());
    const rows = partRows(graph);
    const ids = (steps: Step[]) => steps.map((step) => step.facetId);
    const folded = buildTimeline(graph, rows)?.hangers[2];
    assert.ok(folded);
    assert.equal(folded.folded, 7 - WORKERS_SHOWN, "w2, w4…w9 finished off Build 2");
    assert.deepEqual(
      ids(folded.steps),
      [poolWorkerId("w2"), poolWorkerId("w8"), poolWorkerId("w9"), poolWorkerId("w10")],
      "the merged one, the newest to settle, and every one at work, in the order they started",
    );
    const open = buildTimeline(graph, rows, new Set([2]))?.hangers[2];
    assert.equal(open?.steps.length, 8);
    assert.equal(open?.open, true);
    assert.equal(buildTimeline(graph, rows)?.hangers[1]?.folded, 0, "Build 1 holds two: nothing folds");
  });

  it("draws the builds on one line with each worker beside its build, the fold card in the same lanes", () => {
    const graph = graphOf(loop());
    const rows = partRows(graph);
    const layout = buildsLayout(graph, rows, null);
    const rect = (id: string) => layout.rects[id];
    const [b1, b2, b3] = ["build:1", "build:2", "build:3"].map(rect);
    assert.ok(b1 && b2 && b3 && rect("lead") && rect("final"));
    assert.ok(b1.y === b2.y && b2.y === b3.y && b1.x < b2.x && b2.x < b3.x && b3.x < (rect("final")?.x ?? 0));
    const car = stepOf(graph, "w1");
    const track = stepOf(graph, "w3");
    const reader = stepOf(graph, "w0");
    assert.ok(car && track && reader);
    assert.equal(rect(car.id)?.x, b1.x, "the car hangs under Build 1");
    assert.equal(rect(track.id)?.x, b1.x, "the track worker started from Build 1");
    assert.equal(rect(reader.id)?.x, rect("lead")?.x, "the reader started before any build: under the lead");
    assert.equal(rect(foldId(2))?.x, b2.x);
    const edge = (id: string) => layout.edges.find((line) => line.id === `hang:${id}`)?.kind;
    assert.equal(edge(car.id), StepEdgeKind.Solid);
    assert.equal(edge(track.id), StepEdgeKind.Dotted);
    assert.equal(edge(stepOf(graph, "w10")?.id ?? ""), StepEdgeKind.Live);
    assert.ok(layout.ghosts.has(track.id) && !layout.ghosts.has(car.id));
    assert.deepEqual(
      layout.order?.filter((id) => id.startsWith("build:")),
      ["build:1", "build:2", "build:3"],
      "Previous and Next walk the builds in turn",
    );
  });

  it("keeps a lead with a hundred workers readable: a build shows a few, its fold card the rest", () => {
    seq = 0;
    const events = [...loop()];
    for (let n = 11; n <= 110; n++) {
      events.push(start(`w${n}`, `Variant ${n}`));
      events.push(end(`w${n}`, `Variant ${n}`));
      events.push(rejected(`w${n}`, `Variant ${n}`));
    }
    const graph = graphOf(events);
    const rows = partRows(graph);
    const layout = buildsLayout(graph, rows, null);
    const underBuild3 = Object.entries(layout.rects).filter(([, box]) => box.x === layout.rects["build:3"]?.x);
    assert.equal(underBuild3.length, 1 + WORKERS_SHOWN + 1, "Build 3, three workers and the fold card");
    const tall = buildsLayout(graph, rows, null, new Set([3]));
    assert.ok(tall.height > layout.height * 10, "opened, the fold shows every one");
  });

  it("leaves a run whose checks name no picture, worker or findings as it always was", () => {
    const old = loop().map((event) => {
      const data = event.data as { payload?: Record<string, unknown> };
      if (data.payload === undefined) return event;
      const { picture: _p, worker: _w, findings: _f, ...payload } = data.payload;
      return { ...event, data: { ...event.data, payload } } as EventEnvelope;
    });
    const graph = graphOf(old);
    const rows = partRows(graph);
    assert.equal(buildTimeline(graph, rows), null);
    const layout = buildsLayout(graph, rows, null);
    assert.equal(
      Object.keys(layout.rects).some((id) => id.startsWith("build:")),
      false,
    );
  });

  it("says the latest build did not start when its own health check failed, though no merge record names it", () => {
    const graph = graphOf(loop());
    const summary = { head: H(3), base: null } as unknown as RunSummary;
    assert.equal(resultStatus(graph, summary).state, StepState.Undone, "Build 3's newest check found it throwing");
    const passed = graphOf([...loop(), check(H(4), { picture: shot("merge_w9") })]);
    assert.equal(resultStatus(passed, { head: H(4), base: null } as unknown as RunSummary).state, StepState.InBuild);
  });

  it("says a merged worker's work is in the build, not yet the game; other words stay", () => {
    const graph = graphOf(loop());
    const timeline = buildTimeline(graph, partRows(graph));
    assert.ok(timeline);
    const words = (id: string) => {
      const step = stepOf(graph, id);
      assert.ok(step);
      return [placedWord(step, timeline.places.get(step.id), true), stepWord(step, true)];
    };
    assert.deepEqual(words("w1"), ["Added to your build", "Added to your game"]);
    assert.deepEqual(words("w3"), ["Not used", "Not used"]);
    assert.deepEqual(words("w10"), ["Working", "Working"]);
  });

  it("shows a sound-only worker its build's screenshot, not a sound it cannot draw", () => {
    seq = 0;
    const sound = "assets/genex/engine.wav";
    const events = [
      ...loop(),
      inRun(CustomEvent.AssetDelivered, {
        project: "game",
        source: "genex",
        jobId: "job-engine",
        files: [{ file: sound, bytes: 9, kind: "audio" }],
        at: "2026-01-01T09:00:30.000Z",
        workspace: "build",
        facetId: "w2",
      }),
    ];
    const inventory = {
      project: "game",
      assets: [{ file: sound, kind: "audio" as const, bytes: 9, mtime: "", source: "genex", jobId: "job-engine" }],
      truncated: false,
      skipped: [],
    };
    const graph = joinBuildsView(graphOf(events), null, inventory);
    assert.deepEqual(stepOf(graph, "w2")?.picture, { source: PictureSource.Build, path: shot("merge_w2") });
  });
});
