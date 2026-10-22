/**
 * A lead's Loop in place on the Builds graph: its save points are the spine, each worker hangs off
 * the save point that took its work, every worker that delivered has a picture, each save point
 * wears its own picture, the assets card says what became of every job once the run is over, and
 * the words say a refused worker never started. `fixtures/lead-in-place-run.json` is a trimmed,
 * synthetic Loop of that shape: fourteen workers, eleven save points, Blender and Genex jobs.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  type AssetInfo,
  buildRunGraph,
  GraphNodeKind,
  type IterationNode,
  joinAssetInventory,
  rectsOverlap,
  type RunGraph,
} from "../../src/renderer/run-graph.ts";
import { AssetCardState, assetCounts } from "../../src/renderer/run-graph-assets.ts";
import { frameDifference, savePointShot } from "../../src/renderer/run-graph-pictures.ts";
import {
  lastSavePoint,
  PictureSource,
  partRows,
  STEPS,
  type Step,
  StepEdgeKind,
  StepState,
  statusLine,
  stepWord,
} from "../../src/renderer/run-steps.ts";
import { buildsLayout, readingNodes, readingOrder } from "../../src/renderer/run-tree.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { type EventData, type EventEnvelope, EventKind } from "../../src/shared/event-log.ts";
import type { ProjectAssets } from "../../src/shared/game-assets.ts";
import { summarizeRun } from "../../src/shared/run-summary.ts";
import { poolWorkerId, WorkerEnd, WorkerIsolation, WorkerVerdict } from "../../src/shared/workers.ts";

const LOG = JSON.parse(
  readFileSync(new URL("../fixtures/lead-in-place-run.json", import.meta.url), "utf8"),
) as EventEnvelope[];
const PROJECT = "harbour";

/** The fixture's graph as the Builds tab folds it: with its summary, optionally the game's inventory. */
function fold(events: EventEnvelope[] = LOG, inventory: ProjectAssets | null = null) {
  const built = buildRunGraph(events) as RunGraph;
  assert.ok(built, "the log draws a graph");
  const graph = { ...built, nodes: joinAssetInventory(built.nodes, inventory) };
  const summary = summarizeRun(events, PROJECT, graph.runId);
  graph.summary = summary;
  return { graph, summary, rows: partRows(graph, summary) };
}

const assetJobs = (graph: RunGraph): AssetInfo[] =>
  graph.nodes.flatMap((node) => (node.kind === GraphNodeKind.Assets ? node.jobs : []));
const stepOf = (rows: ReturnType<typeof partRows>, id: string): Step => {
  const step = rows.flatMap((row) => row.steps).find((each) => each.id === id);
  assert.ok(step, `no step ${id}`);
  return step;
};
const worker = (n: number): string => `session:${poolWorkerId(`w${n}`)}`;
const save = (n: number): string => `step:lead:${n}`;

describe("the assets card once a lead's Loop is over", () => {
  it("nothing is still making, a request the service refused is no card, and a delivery that landed no file is no card", () => {
    const jobs = assetJobs(fold().graph);
    const count = (state: string) => jobs.filter((job) => job.state === state).length;
    assert.equal(count(AssetCardState.Requested) + count(AssetCardState.Generating), 0, "no Making after the end");
    assert.equal(count(AssetCardState.Unfinished), 1, "the one generation nobody waited for");
    assert.equal(count(AssetCardState.Failed), 0, "the requests refused before any generation started made nothing");
    for (const job of jobs.filter((each) => each.state === AssetCardState.Delivered))
      assert.ok(job.files.length > 0, `a delivered card holds files: ${job.name}`);
  });

  it("counts what the tile says: nothing making once the run is over, the unfinished apart", () => {
    const counts = assetCounts(assetJobs(fold().graph));
    assert.equal(counts.making, 0);
    assert.equal(counts.unfinished, 1);
    assert.equal(counts.failed, 0);
    assert.equal(counts.made + counts.failed + counts.unfinished, assetJobs(fold().graph).length);
  });

  it("a Blender failure the same worker then delivered under the same name folds into that success", () => {
    const jobs = assetJobs(fold().graph);
    const failedBlender = jobs.filter((job) => job.source === "blender" && job.state === AssetCardState.Failed);
    assert.deepEqual(failedBlender, [], "every Blender failure was retried and delivered by the same worker");
  });

  it("puts each worker's jobs on that worker's part, whatever id its plugin calls named it by", () => {
    const { graph } = fold();
    const parts = new Set(graph.facets.map((facet) => facet.facetId));
    for (const job of assetJobs(graph).filter((each) => each.facetId !== null))
      assert.ok(parts.has(job.facetId ?? ""), `${job.name} is on ${job.facetId}, a part of the graph`);
  });
});

describe("the words of a lead's Loop", () => {
  it("the header counts the save points and names no worker the host never started", () => {
    const { graph, summary, rows } = fold();
    const line = statusLine(graph, summary, rows);
    assert.equal(line.rest, "11 save points");
  });

  it("a worker the host refused reads Not started", () => {
    const { graph, rows } = fold();
    for (const id of [worker(5), worker(6)]) {
      const step = stepOf(rows, id);
      assert.equal(step.state, StepState.NotDelivered);
      assert.equal(stepWord(step, graph.active), "Not started");
    }
  });
});

describe("a worker's picture", () => {
  it("every worker that delivered a picture shows one, and the reader shows the save point it looked at", () => {
    const { rows } = fold();
    for (const n of [1, 2, 3, 7, 9, 11, 12, 14]) {
      const picture = stepOf(rows, worker(n)).picture;
      assert.equal(picture?.source, PictureSource.File, `worker ${n} delivered renders`);
    }
    const reader = stepOf(rows, worker(10)).picture;
    assert.equal(reader?.source, PictureSource.Reviewed);
    assert.equal(reader?.source === PictureSource.Reviewed && reader.round.iteration, 6, "the save point before it");
    for (const n of [5, 6]) assert.equal(stepOf(rows, worker(n)).picture, undefined, "a refused worker made nothing");
  });

  it("prefers a delivery that is in the game, and draws a model-only delivery as the Assets stage does", () => {
    const plain = fold();
    const kept = plain.rows.flatMap((row) => row.steps);
    const blender = assetJobs(plain.graph).filter((job) => job.facetId === poolWorkerId("w3"));
    const oldest = blender[0];
    const character = assetJobs(plain.graph).find(
      (job) => job.facetId === poolWorkerId("w4") && job.state === AssetCardState.Delivered && job.files.length,
    );
    assert.ok(oldest && character && kept.length);
    const asset = (file: string) => ({
      file,
      kind: file.endsWith(".png") ? ("image" as const) : ("model" as const),
      bytes: 1,
      mtime: "2026-01-01T09:00:00.000Z",
      source: "plugin" as const,
    });
    const inventory: ProjectAssets = {
      project: PROJECT,
      assets: [
        ...oldest.files.map(asset),
        ...character.files.map((file) => ({ ...asset(file), jobId: character.jobId ?? "" })),
      ],
      truncated: false,
      skipped: [],
    };
    const { rows } = fold(LOG, inventory);
    const w3 = stepOf(rows, worker(3)).picture;
    assert.equal(w3?.source === PictureSource.File && oldest.files.includes(w3.file), true, "the copy in the game");
    const w4 = stepOf(rows, worker(4)).picture;
    assert.equal(w4?.source, PictureSource.Asset, "a model with no picture of its own");
  });

  it("a worker that finished, changed nothing and delivered nothing reads Nothing made; a reader that finished reads Done", () => {
    const run = "run-n";
    let seq = 0;
    const logged = (eventType: string, payload: Record<string, unknown>): EventEnvelope => {
      seq += 1;
      const data: EventData = { type: EventKind.Custom, event_type: eventType, payload: { runId: run, ...payload } };
      return {
        id: `n${seq}`,
        thread_id: "t",
        session_id: null,
        turn_id: null,
        created_at: `2026-01-01T09:00:${String(seq).padStart(2, "0")}.000Z`,
        data,
      } as EventEnvelope;
    };
    const events = [
      logged(CustomEvent.RunStarted, { goal: "A harbour", project: PROJECT }),
      logged(CustomEvent.AutopilotStarted, { director: true, facets: [], workerRecords: true }),
      logged(CustomEvent.WorkerStarted, {
        workerId: poolWorkerId("w1"),
        title: "Make a crate",
        isolation: WorkerIsolation.Copy,
      }),
      logged(CustomEvent.WorkerStarted, {
        workerId: poolWorkerId("w2"),
        title: "Look at it",
        isolation: WorkerIsolation.Read,
      }),
      logged(CustomEvent.WorkerFinished, {
        workerId: poolWorkerId("w1"),
        title: "Make a crate",
        state: WorkerEnd.Done,
      }),
      logged(CustomEvent.WorkerFinished, {
        workerId: poolWorkerId("w1"),
        title: "Make a crate",
        verdict: WorkerVerdict.Used,
      }),
      logged(CustomEvent.WorkerFinished, { workerId: poolWorkerId("w2"), title: "Look at it", state: WorkerEnd.Done }),
    ];
    const graph = buildRunGraph(events) as RunGraph;
    const rows = partRows(graph, null);
    const empty = stepOf(rows, worker(1));
    assert.equal(stepWord(empty, graph.active), "Nothing made");
    assert.equal(empty.onLine, false, "nothing of it to stand on the line with");
    const layout = buildsLayout(graph, rows, null);
    assert.equal(layout.ghosts.has(empty.id), true);
    assert.equal(layout.edges.find((edge) => edge.id === `hang:${empty.id}`)?.kind, StepEdgeKind.Dotted);
    assert.equal(stepWord(stepOf(rows, worker(2)), graph.active), "Done", "a reader changes nothing by design");
  });
});

describe("a lead's Loop in place is a comb", () => {
  /** Each step's column on the spine: 0 is the lead, n the nth save point. */
  function columns() {
    const { graph, summary, rows } = fold();
    const layout = buildsLayout(graph, rows, summary);
    const lead = layout.rects.lead;
    assert.ok(lead);
    const column = (id: string) => {
      const rect = layout.rects[id];
      assert.ok(rect, `${id} is drawn`);
      return (rect.x - lead.x) / STEPS.pitch;
    };
    return { graph, summary, rows, layout, lead, column };
  }

  it("the save points are one line from the lead into the result, and no row spans the graph", () => {
    const { layout, lead, column } = columns();
    for (let n = 1; n <= 11; n++) {
      assert.equal(column(save(n)), n, `save point ${n} in its own column`);
      assert.equal(layout.rects[save(n)]?.y, lead.y, "on the lead's line");
    }
    assert.ok((layout.rects.final?.x ?? 0) > (layout.rects[save(11)]?.x ?? Infinity), "the result after the last");
    assert.deepEqual(
      Object.keys(layout.rects).filter((id) => id.startsWith("row:")),
      [],
      "no row label: every worker is its one node",
    );
    const boxes = Object.entries(layout.rects);
    for (const [a, ra] of boxes)
      for (const [b, rb] of boxes) if (a < b) assert.equal(rectsOverlap(ra, rb), false, `${a} on ${b}`);
  });

  it("each worker hangs under the save point that took its work, or after the one current when it started", () => {
    const { column, layout, lead } = columns();
    const expected: Array<[number, number]> = [
      [4, 1],
      [5, 1],
      [6, 1],
      [1, 2],
      [2, 2],
      [3, 2],
      [7, 5],
      [8, 5],
      [9, 5],
      [10, 7],
      [11, 8],
      [12, 9],
      [13, 10],
      [14, 10],
    ];
    for (const [n, at] of expected) {
      assert.equal(column(worker(n)), at, `worker ${n} under save point ${at}`);
      assert.notEqual(layout.rects[worker(n)]?.y, lead.y, `worker ${n} off the line`);
    }
    for (const n of [5, 6]) {
      assert.equal(layout.ghosts.has(worker(n)), true, "a worker that never ran is a ghost");
      assert.equal(layout.edges.find((edge) => edge.id === `hang:${worker(n)}`)?.kind, StepEdgeKind.Dotted);
    }
    assert.equal(layout.edges.find((edge) => edge.id === `hang:${worker(1)}`)?.kind, StepEdgeKind.Solid);
  });

  it("fourteen workers make it no taller than three lanes, so Fit is set by the save points alone", () => {
    const { layout } = columns();
    const lanes = 3;
    assert.ok(layout.height <= 2 * STEPS.pad + STEPS.nodeH + lanes * (STEPS.nodeH + STEPS.hangGap));
  });

  it("Previous and Next walk along the spine: each save point after the workers it took", () => {
    const { graph, summary, rows, layout } = columns();
    const order = readingOrder(rows, readingNodes(graph, rows, summary), layout.order);
    const at = (id: string) => order.indexOf(id);
    assert.ok(at(worker(4)) < at(save(1)) && at(save(1)) < at(worker(1)) && at(worker(3)) < at(save(2)));
    assert.equal(order.at(-1), "finish_check" in layout.rects ? "finish_check" : "final");
  });
});

describe("a save point's picture", () => {
  const shot = (camera: string) => ({ camera, path: `/runs/r/open/save/${camera}.png` });
  const round = (shots: string[], extra: Partial<IterationNode> = {}): IterationNode =>
    ({ id: "iter:lead:2", shots: shots.map(shot), shown: null, ...extra }) as IterationNode;

  it("is the picture the lead named, else the camera that changed most since the save point before", () => {
    const earlier = round(["Overview", "Pier"]);
    const named = round(["Overview", "Pier"], { shown: shot("shows") });
    assert.equal(savePointShot(named, earlier, new Map())?.camera, "shows");
    const changed = new Map([
      ["Overview", 0.004],
      ["Pier", 0.21],
    ]);
    assert.equal(savePointShot(round(["Overview", "Pier"]), earlier, changed)?.camera, "Pier");
    assert.equal(
      savePointShot(round(["Overview", "Pier", "Probe"]), earlier, changed)?.camera,
      "Probe",
      "a new camera",
    );
    assert.equal(savePointShot(round(["Overview", "Pier"]), earlier, new Map())?.camera, "Overview", "unmeasured");
    assert.equal(savePointShot(round(["Overview", "Pier"]), null, changed)?.camera, "Overview", "the first save point");
  });

  it("measures a change as the mean colour difference, alpha aside", () => {
    const black = [0, 0, 0, 255, 0, 0, 0, 255];
    const white = [255, 255, 255, 0, 255, 255, 255, 0];
    assert.equal(frameDifference(black, black), 0);
    assert.equal(frameDifference(black, white), 1);
    assert.equal(frameDifference(black, [0, 0, 0, 255]), 1, "frames of different sizes");
  });

  it("each save point after the first knows the one before it, and the lead wears the last", () => {
    const { rows } = fold();
    assert.equal(stepOf(rows, save(1)).earlier, undefined);
    for (let n = 2; n <= 11; n++) assert.equal(stepOf(rows, save(n)).earlier?.iteration, n - 1);
    assert.equal(lastSavePoint(rows)?.id, save(11));
  });
});

describe("an asset job's end", () => {
  let seq = 0;
  const logged = (eventType: string, payload: Record<string, unknown>): EventEnvelope => {
    seq += 1;
    const data: EventData = { type: EventKind.Custom, event_type: eventType, payload: { runId: "run-a", ...payload } };
    const created_at = new Date(Date.UTC(2026, 0, 1, 9, 0, seq)).toISOString();
    return { id: `a${seq}`, thread_id: "t", session_id: null, turn_id: null, created_at, data } as EventEnvelope;
  };
  const opened = () => [
    logged(CustomEvent.RunStarted, { goal: "A harbour", project: PROJECT }),
    logged(CustomEvent.AutopilotStarted, { director: true, facets: [], workerRecords: true }),
    logged(CustomEvent.WorkerStarted, {
      workerId: poolWorkerId("w1"),
      title: "Crates",
      isolation: WorkerIsolation.Copy,
    }),
    logged(CustomEvent.WorkerStarted, {
      workerId: poolWorkerId("w2"),
      title: "Barrels",
      isolation: WorkerIsolation.Copy,
    }),
  ];
  const call = (callId: string, worker: string, args: string, result: Record<string, unknown>, extra = {}) => [
    logged(CustomEvent.PluginToolStarted, { callId, pluginId: "genex", tool: "asset", facetId: worker, args }),
    logged(CustomEvent.PluginTool, { callId, facetId: worker, ok: true, result: JSON.stringify(result), ...extra }),
  ];
  const states = (events: EventEnvelope[]) =>
    assetJobs(buildRunGraph(events) as RunGraph).map((job) => [job.facetId, job.state, job.error]);

  it("a generation the call came back ok on but that failed is a failure, with its error; a request refused before one is no card", () => {
    seq = 0;
    const generationFailed = { status: "failed", generationId: "g1", error: "The generation failed." };
    const events = [
      ...opened(),
      ...call("c1", "w1", "operation=model prompt=a crate", generationFailed),
      ...call("c2", "w2", "operation=model prompt=a barrel", { status: "failed", error: "Cannot quote this." }),
    ];
    assert.deepEqual(states(events), [[poolWorkerId("w1"), AssetCardState.Failed, "The generation failed."]]);
  });

  it("a job still being made is making while the run goes on or is paused, and not finished once it ended", () => {
    seq = 0;
    const accepted = call("c1", "w1", "operation=model prompt=a crate", { status: "accepted" }, { jobId: "j1" });
    const running = [...opened(), ...accepted];
    assert.deepEqual(states(running), [[poolWorkerId("w1"), AssetCardState.Generating, null]]);
    const paused = [...running, logged(CustomEvent.AutopilotPaused, { reason: "usage limit" })];
    const pausedGraph = buildRunGraph(paused) as RunGraph;
    assert.equal(
      pausedGraph.nodes.some((node) => node.kind === GraphNodeKind.Run && node.paused),
      true,
    );
    assert.equal(assetJobs(pausedGraph)[0]?.state, AssetCardState.Generating, "a paused run may yet deliver it");
    const over = [...running, logged(CustomEvent.RunFinished, { landed: true })];
    assert.deepEqual(states(over), [[poolWorkerId("w1"), AssetCardState.Unfinished, null]]);
  });

  it("a failure folds only into the same worker's later success under the same name", () => {
    seq = 0;
    const failed = (generationId: string) => ({ status: "failed", generationId, error: "Failed." });
    const made = { status: "downloaded" };
    const events = [
      ...opened(),
      ...call("c1", "w1", "operation=model prompt=a crate", failed("g1")),
      ...call("c2", "w1", "operation=model prompt=a crate", made, {
        jobId: "j2",
        files: ["assets/genex/j2/crate.glb"],
      }),
      ...call("c3", "w1", "operation=model prompt=a barrel", failed("g3")),
      ...call("c4", "w2", "operation=model prompt=a barrel", made, {
        jobId: "j4",
        files: ["assets/genex/j4/barrel.glb"],
      }),
    ];
    assert.deepEqual(states(events), [
      [poolWorkerId("w1"), AssetCardState.Delivered, null],
      [poolWorkerId("w1"), AssetCardState.Failed, "Failed."],
      [poolWorkerId("w2"), AssetCardState.Delivered, null],
    ]);
  });
});

describe("the picture of a job with many files", () => {
  it("is drawn from its preferred file, else its biggest model or picture: a character's motion-only clips are kilobytes", () => {
    const { graph } = fold();
    const character = assetJobs(graph).find(
      (job) => job.facetId === poolWorkerId("w4") && job.state === AssetCardState.Delivered && job.files.length,
    );
    assert.ok(character?.jobId);
    const record = (file: string, bytes: number, extra = {}) => ({
      file,
      kind: "model" as const,
      bytes,
      mtime: "2026-01-01T09:00:00.000Z",
      source: "genex" as const,
      jobId: character.jobId ?? "",
      ...extra,
    });
    const clip = record("assets/genex/x/clip.glb", 67_872);
    const mesh = record("assets/genex/x/mesh.glb", 10_477_860);
    const inventory = (assets: ProjectAssets["assets"]): ProjectAssets => ({
      project: PROJECT,
      assets,
      truncated: false,
      skipped: [],
    });
    const previewOf = (assets: ProjectAssets["assets"]) =>
      assetJobs({ ...graph, nodes: joinAssetInventory(graph.nodes, inventory(assets)) }).find(
        (job) => job.jobId === character.jobId,
      )?.preview?.file;
    assert.equal(previewOf([clip, mesh]), mesh.file, "the mesh, not the clip listed first");
    const preferred = record("assets/genex/x/desktop.glb", 1_000, { preferredFile: "desktop.glb" });
    assert.equal(previewOf([clip, mesh, preferred]), preferred.file, "the plugin's own preferred file first");
  });
});
