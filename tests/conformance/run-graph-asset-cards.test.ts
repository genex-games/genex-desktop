/**
 * A worker's assets on the Builds graph. Every distinct asset a worker delivered is a card of its
 * own under that worker, whose own node stays; making the same asset again (the same game file, or
 * the same plugin tool's asset of the same name) is a new version of that card, never another card,
 * and its versions keep their compare. A worker that delivered nothing draws as it always did.
 *
 * The first Loop is the castle-artillery incident's shape: one worker made a rocket launcher three
 * times, a rocket three times, a grenade launcher twice, a grenade round, an ammo crate twice and a
 * folded rocket, each its own Blender job and delivery.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AssetInfo,
  buildRunGraph,
  GraphNodeKind,
  rectsOverlap,
  type Rect,
  type RunGraph,
} from "../../src/renderer/run-graph.ts";
import { AssetCardState, assetVersions, earlierVersion } from "../../src/renderer/run-graph-assets.ts";
import { buildTimeline } from "../../src/renderer/run-graph-builds.ts";
import { isInPlaceTree } from "../../src/renderer/run-graph-comb.ts";
import {
  isAssetSelection,
  PictureSource,
  partRows,
  STEPS,
  type Step,
  stepAndAssetIds,
} from "../../src/renderer/run-steps.ts";
import { buildsLayout, readingNodes, readingOrder } from "../../src/renderer/run-tree.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { type EventEnvelope, EventKind } from "../../src/shared/event-log.ts";
import { poolWorkerId, WorkerEnd, WorkerIsolation, WorkerVerdict } from "../../src/shared/workers.ts";

const RUN = "run-castle";
const H = (digit: number): string => String(digit).repeat(40);

let seq = 0;
/** One record of the run, a second after the one before. */
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

const opened = (): EventEnvelope[] => [
  inRun(CustomEvent.RunStarted, { goal: "A castle that fires back", project: "game" }),
  inRun(CustomEvent.AutopilotStarted, { director: true, facets: [], workerRecords: true }),
];
const start = (id: string, title: string, isolation: WorkerIsolation = WorkerIsolation.Copy) =>
  inRun(CustomEvent.WorkerStarted, { workerId: poolWorkerId(id), title, isolation, task: `${title}.` });
const done = (id: string, title: string) =>
  inRun(CustomEvent.WorkerFinished, { workerId: poolWorkerId(id), title, state: WorkerEnd.Done, delivered: true });
const used = (id: string, title: string) =>
  inRun(CustomEvent.WorkerFinished, { workerId: poolWorkerId(id), title, verdict: WorkerVerdict.Used, merged: true });
const rejected = (id: string, title: string) =>
  inRun(CustomEvent.WorkerFinished, { workerId: poolWorkerId(id), title, verdict: WorkerVerdict.Rejected });

/** Where the host kept the picture of Blender job `job`, under the run's folder. */
const kept = (job: string): string => `/runs/${RUN}/deliveries/${job}.png`;

/**
 * One Blender job of worker `worker`, as the host records it: the call, the delivery with its kept
 * picture, and the call coming back with its files. Each job delivers into a folder of its own.
 */
function blenderJob(worker: string, job: string, name: string, extra: { ok?: boolean } = {}): EventEnvelope[] {
  const files = [`assets/blender/${job}/model.glb`, `assets/blender/${job}/render.png`];
  const call = inRun(CustomEvent.PluginToolStarted, {
    callId: `call-${job}`,
    pluginId: "blender",
    pluginName: "Local Blender",
    tool: "model",
    facetId: worker,
    args: `name=${name} script=assets/src/${name}.py`,
    making: { kind: "model" },
  });
  if (extra.ok === false)
    return [call, inRun(CustomEvent.PluginTool, { callId: `call-${job}`, facetId: worker, ok: false, error: "boom" })];
  return [
    call,
    inRun(CustomEvent.AssetDelivered, {
      project: "game",
      source: "blender",
      pluginId: "blender",
      jobId: job,
      files: files.map((file) => ({ file, bytes: 1, kind: file.endsWith(".glb") ? "model" : "image" })),
      at: "2026-01-01T09:00:30.000Z",
      workspace: "build",
      facetId: worker,
      picture: kept(job),
    }),
    inRun(CustomEvent.PluginTool, { callId: `call-${job}`, facetId: worker, ok: true, files }),
  ];
}

/** A Genex image a worker delivered into the game, by the file it landed as and the prompt it was made from. */
function genexImage(worker: string, job: string, file: string, prompt: string): EventEnvelope[] {
  return [
    inRun(CustomEvent.PluginToolStarted, {
      callId: `call-${job}`,
      pluginId: "genex",
      pluginName: "Genex",
      tool: "asset",
      facetId: worker,
      args: `operation=image prompt=${prompt}`,
    }),
    inRun(CustomEvent.AssetDelivered, {
      project: "game",
      source: "genex",
      pluginId: "genex",
      jobId: job,
      files: [{ file, bytes: 1, kind: "image" }],
      at: "2026-01-01T09:00:30.000Z",
      workspace: "build",
      facetId: worker,
      picture: kept(job),
    }),
    inRun(CustomEvent.PluginTool, { callId: `call-${job}`, facetId: worker, ok: true, jobId: job, files: [file] }),
  ];
}

/** What worker w3 made, in the order it made it: the incident's twelve Blender jobs. */
const ARTILLERY: Array<[job: string, name: string]> = [
  ["j01", "rocket_launcher"],
  ["j02", "rocket"],
  ["j03", "rocket_launcher"],
  ["j04", "grenade_launcher"],
  ["j05", "rocket"],
  ["j06", "grenade_round"],
  ["j07", "rocket_launcher"],
  ["j08", "ammo_crate"],
  ["j09", "grenade_launcher"],
  ["j10", "ammo_crate"],
  ["j11", "rocket"],
  ["j12", "rocket_folded"],
];
const W3 = "Rocket launcher, grenade launcher and ammo";

/**
 * A Loop of three workers: a reader that delivered nothing, w3 making the artillery (one job failed
 * before it was made again), and w4 painting a banner, then the same banner file again from a
 * different prompt. w4's work was not used.
 */
function castle(): EventEnvelope[] {
  seq = 0;
  return [
    ...opened(),
    start("w1", "Study the walls", WorkerIsolation.Read),
    start("w3", W3),
    start("w4", "Paint the banner"),
    done("w1", "Study the walls"),
    ...blenderJob("w3", "j00", "rocket_launcher", { ok: false }),
    ...ARTILLERY.flatMap(([job, name]) => blenderJob("w3", job, name)),
    ...genexImage("w4", "g1", "assets/genex/banner.png", "a red banner with a lion"),
    ...genexImage("w4", "g2", "assets/genex/banner.png", "a blue banner with a lion"),
    done("w3", W3),
    used("w3", W3),
    done("w4", "Paint the banner"),
    rejected("w4", "Paint the banner"),
  ];
}

function graphOf(events: EventEnvelope[]): RunGraph {
  const graph = buildRunGraph(events);
  assert.ok(graph, "the log draws a graph");
  return graph;
}

const stepOf = (graph: RunGraph, id: string): Step => {
  const step = partRows(graph)
    .flatMap((row) => row.steps)
    .find((each) => each.facetId === poolWorkerId(id));
  assert.ok(step, `no step for ${id}`);
  return step;
};

const versionsOf = (step: Step): Array<[string, number]> =>
  (step.assets ?? []).map((card) => [card.name, card.versions.length]);

/** Every rect of a layout against every other: none lies on another. */
function assertNoOverlap(rects: Record<string, Rect>): void {
  const boxes = Object.entries(rects);
  for (const [a, ra] of boxes)
    for (const [b, rb] of boxes) if (a < b) assert.equal(rectsOverlap(ra, rb), false, `${a} on ${b}`);
}

/** Each of a worker's asset cards sits under its node, two to a row, inside the node's own width. */
function assertUnderItsWorker(rects: Record<string, Rect>, step: Step): void {
  const node = rects[step.id];
  assert.ok(node, `${step.id} is drawn`);
  const cards = (step.assets ?? []).map((card) => rects[card.id]);
  assert.ok(cards.length > 0, "the worker has asset cards");
  cards.forEach((card, index) => {
    assert.ok(card, `card ${index} is drawn`);
    assert.ok(card.y >= node.y + node.h, `card ${index} is under the worker`);
    assert.ok(card.x >= node.x && card.x + card.w <= node.x + node.w, `card ${index} keeps to the worker's width`);
    const left = cards[index - (index % 2)];
    assert.equal(card.y, left?.y, `card ${index} shares its row with its neighbour`);
  });
  assert.equal(cards[0]?.y, node.y + node.h + STEPS.shelfGap, "the first row right under the worker");
}

describe("a worker's assets as cards of their own", () => {
  it("is one card per distinct asset, in the order each was first made; making one again is its next version", () => {
    const step = stepOf(graphOf(castle()), "w3");
    assert.deepEqual(versionsOf(step), [
      ["rocket_launcher", 3],
      ["rocket", 3],
      ["grenade_launcher", 2],
      ["grenade_round", 1],
      ["ammo_crate", 2],
      ["rocket_folded", 1],
    ]);
    const launcher = step.assets?.[0];
    assert.deepEqual(
      launcher?.versions.map((version) => version.callId),
      ["call-j01", "call-j03", "call-j07"],
      "its versions oldest first; the failed try is no version",
    );
    assert.ok(launcher && isAssetSelection(launcher.id), "a card is a selection of its own on the graph");
    const ids = (step.assets ?? []).map((card) => card.id);
    assert.equal(new Set(ids).size, ids.length, "every card has its own id");
  });

  it("each card wears its newest version's picture; the worker keeps its own node and picture", () => {
    const step = stepOf(graphOf(castle()), "w3");
    assert.deepEqual(
      step.assets?.map((card) => card.picture),
      ["j07", "j11", "j09", "j06", "j10", "j12"].map((job) => ({ source: PictureSource.Kept, path: kept(job) })),
    );
    assert.deepEqual(step.picture, { source: PictureSource.Kept, path: kept("j12") }, "as before: its newest delivery");
  });

  it("an id stays put as new versions arrive", () => {
    const events = castle();
    const callOf = (event: EventEnvelope) => (event.data as { payload?: { callId?: string } }).payload?.callId;
    const thirdRocket = events.findIndex((event) => callOf(event) === "call-j11");
    assert.ok(thirdRocket > 0);
    const before = graphOf(events.slice(0, thirdRocket));
    assert.equal(stepOf(before, "w3").assets?.[1]?.versions.length, 2, "two rockets so far");
    const after = graphOf(events);
    const idOf = (graph: RunGraph) => stepOf(graph, "w3").assets?.find((card) => card.name === "rocket")?.id;
    assert.ok(idOf(before));
    assert.equal(idOf(before), idOf(after));
  });

  it("an id stays put while a delivery waits for its call to come back", () => {
    const events = castle();
    const delivery = (event: EventEnvelope) => (event.data as { payload?: { jobId?: string } }).payload?.jobId;
    const firstBanner = events.findIndex((event) => delivery(event) === "g1");
    assert.ok(firstBanner > 0);
    // The host writes the delivery before the call returns: for a moment the banner is a delivery
    // no call has claimed yet, then the call's card that folds it in.
    const waiting = graphOf(events.slice(0, firstBanner + 1));
    const idOf = (graph: RunGraph) => stepOf(graph, "w4").assets?.[0]?.id;
    assert.ok(idOf(waiting), "the delivery is a card already");
    assert.equal(idOf(waiting), idOf(graphOf(events.slice(0, firstBanner + 2))), "its call came back");
    assert.equal(idOf(waiting), idOf(graphOf(events)), "and the banner was made again");
  });

  it("a plugin whose calls return their files without a job: each version keeps its own delivery's picture", () => {
    seq = 0;
    const painted = (job: string, prompt: string): EventEnvelope[] => [
      inRun(CustomEvent.PluginToolStarted, {
        callId: `call-${job}`,
        pluginId: "painter",
        pluginName: "Painter",
        tool: "paint",
        facetId: "w8",
        args: `prompt=${prompt}`,
      }),
      inRun(CustomEvent.AssetDelivered, {
        project: "game",
        source: "painter",
        pluginId: "painter",
        jobId: job,
        files: [{ file: "assets/painter/door.png", bytes: 1, kind: "image" }],
        at: "2026-01-01T09:00:30.000Z",
        workspace: "build",
        facetId: "w8",
        picture: kept(job),
      }),
      inRun(CustomEvent.PluginTool, {
        callId: `call-${job}`,
        facetId: "w8",
        ok: true,
        files: ["assets/painter/door.png"],
      }),
    ];
    const graph = graphOf([
      ...opened(),
      start("w8", "Paint the door"),
      ...painted("p1", "a red door"),
      ...painted("p2", "a green door"),
    ]);
    const cards = stepOf(graph, "w8").assets ?? [];
    assert.equal(cards.length, 1, "one door");
    assert.deepEqual(
      cards[0]?.versions.map((version) => version.picture),
      [kept("p1"), kept("p2")],
      "two versions, each its own delivery's picture; the second delivery folds into the second call",
    );
    assert.deepEqual(cards[0]?.picture, { source: PictureSource.Kept, path: kept("p2") });
  });

  it("the same game file delivered again is one asset whatever its prompt, and its versions keep their compare", () => {
    const graph = graphOf(castle());
    const banner = stepOf(graph, "w4").assets;
    assert.equal(banner?.length, 1, "the banner, once");
    const [first, second] = banner?.[0]?.versions ?? [];
    assert.ok(first && second);
    assert.deepEqual(
      [first.picture, second.picture],
      [kept("g1"), kept("g2")],
      "each version keeps the picture its own delivery kept, though its delivery landed before its call came back",
    );
    assert.deepEqual(banner?.[0]?.picture, { source: PictureSource.Kept, path: kept("g2") });
    const jobs = graph.nodes.flatMap((node) => (node.kind === GraphNodeKind.Assets ? node.jobs : []));
    assert.equal(earlierVersion(jobs, second), first, "the compare pairs the new banner with the one before");
    assert.equal(
      earlierVersion(jobs, { ...second }),
      first,
      "a copy of the version finds it too: the tab may hold the card's versions and the run's jobs as separate copies",
    );
  });

  it("a delivery no call asked for is called by its file's own name, not its path or its extension", () => {
    seq = 0;
    const events = [
      ...opened(),
      start("w7", "Hang the flags"),
      inRun(CustomEvent.AssetDelivered, {
        project: "game",
        source: "genex",
        jobId: "job-flag",
        files: [{ file: "assets/genex/flags/flag-red.png", bytes: 1, kind: "image" }],
        at: "2026-01-01T09:00:30.000Z",
        workspace: "game",
        facetId: "w7",
      }),
    ];
    assert.deepEqual(versionsOf(stepOf(graphOf(events), "w7")), [["flag-red", 1]]);
  });

  it("a worker that delivered nothing has no asset cards", () => {
    const graph = graphOf(castle());
    assert.equal(stepOf(graph, "w1").assets, undefined, "the reader");
    const making = graphOf([
      ...opened(),
      start("w5", "Cast a cannon"),
      blenderJob("w5", "k1", "cannon")[0] as EventEnvelope,
    ]);
    assert.equal(stepOf(making, "w5").assets, undefined, "a job still on its way is no card yet");
  });
});

describe("grouping delivered cards into assets", () => {
  const card = (name: string, files: string[], extra: Partial<AssetInfo> = {}): AssetInfo =>
    ({
      name,
      files,
      source: "blender",
      tool: "model",
      state: AssetCardState.Delivered,
      ...extra,
    }) as AssetInfo;

  it("joins by a shared game file, or by the same plugin, tool and name; anything else stays apart", () => {
    const rows: Array<[string, AssetInfo[], number[]]> = [
      ["same name, plugin and tool", [card("crate", ["a.glb"]), card("crate", ["b.glb"])], [2]],
      ["same file, another prompt", [card("red", ["x.png"]), card("blue", ["x.png"])], [2]],
      ["another tool", [card("crate", ["a.glb"]), card("crate", ["b.glb"], { tool: "image" })], [1, 1]],
      ["another plugin", [card("crate", ["a.glb"]), card("crate", ["b.glb"], { source: "genex" })], [1, 1]],
      ["no name to join on", [card("", ["a.glb"]), card("", ["b.glb"])], [1, 1]],
      ["a failure is no version", [card("crate", ["a.glb"], { state: AssetCardState.Failed }), card("crate", [])], [1]],
      ["still making is no version", [card("crate", [], { state: AssetCardState.Generating })], []],
    ];
    for (const [why, cards, sizes] of rows)
      assert.deepEqual(
        assetVersions(cards).map((versions) => versions.length),
        sizes,
        why,
      );
  });
});

describe("the cards on the canvas", () => {
  it("in place: under the worker, two to a row, never on another node; Previous and Next take each after its worker", () => {
    const graph = graphOf(castle());
    const rows = partRows(graph);
    const layout = buildsLayout(graph, rows, null);
    const w3 = stepOf(graph, "w3");
    assertUnderItsWorker(layout.rects, w3);
    assertUnderItsWorker(layout.rects, stepOf(graph, "w4"));
    assertNoOverlap(layout.rects);
    const order = readingOrder(rows, readingNodes(graph, rows, null), layout.order);
    const from = order.indexOf(w3.id);
    assert.deepEqual(order.slice(from, from + 7), stepAndAssetIds(w3), "the worker, then each of its assets");
  });

  it("a worker whose work was not used has ghost cards; a used one's are not", () => {
    const graph = graphOf(castle());
    const layout = buildsLayout(graph, partRows(graph), null);
    const ghosts = (id: string) => (stepOf(graph, id).assets ?? []).map((card) => layout.ghosts.has(card.id));
    assert.deepEqual(ghosts("w4"), [true]);
    assert.deepEqual(ghosts("w3"), [false, false, false, false, false, false]);
  });

  it("on a Loop's build line: under the worker beside its build, never on another node", () => {
    const events = [
      ...castle(),
      inRun(CustomEvent.IntegrationHealth, { head: H(1), ok: true, problems: [], findings: [], worker: "w3" }),
    ];
    const graph = graphOf(events);
    const rows = partRows(graph);
    assert.ok(buildTimeline(graph, rows), "the run has a build history");
    const layout = buildsLayout(graph, rows, null);
    const w3 = stepOf(graph, "w3");
    assert.equal(layout.rects[w3.id]?.x, layout.rects["build:1"]?.x, "w3 hangs off Build 1");
    assertUnderItsWorker(layout.rects, w3);
    assertNoOverlap(layout.rects);
    const order = layout.order ?? [];
    assert.deepEqual(order.slice(order.indexOf(w3.id), order.indexOf(w3.id) + 7), stepAndAssetIds(w3));
  });

  it("in rows: under the worker, the next row below its cards", () => {
    seq = 0;
    const events = [
      ...opened(),
      inRun(CustomEvent.DirectorWorker, { workerId: "keep", title: "Keep", state: "running", mode: "single" }),
      start("w3", W3),
      ...ARTILLERY.slice(0, 5).flatMap(([job, name]) => blenderJob("w3", job, name)),
      start("w6", "Raise the gate"),
      ...blenderJob("w6", "m1", "gate"),
    ];
    const graph = graphOf(events);
    const rows = partRows(graph);
    assert.equal(isInPlaceTree(rows) || buildTimeline(graph, rows) !== null, false, "a row per part");
    const layout = buildsLayout(graph, rows, null);
    assertUnderItsWorker(layout.rects, stepOf(graph, "w3"));
    assertUnderItsWorker(layout.rects, stepOf(graph, "w6"));
    assertNoOverlap(layout.rects);
  });

  it("a graph whose workers delivered nothing lays out exactly as it did", () => {
    seq = 0;
    const events = [...opened(), start("w1", "Study the walls", WorkerIsolation.Read), start("w2", "Plan the moat")];
    const graph = graphOf(events);
    const layout = buildsLayout(graph, partRows(graph), null);
    const lead = layout.rects.lead;
    assert.ok(lead);
    const below = layout.rects[stepOf(graph, "w1").id];
    const above = layout.rects[stepOf(graph, "w2").id];
    const pitch = STEPS.nodeH + STEPS.hangGap;
    assert.equal(below?.y, lead.y + pitch, "the first lane below");
    assert.equal(above?.y, lead.y - pitch, "the first lane above");
    assert.equal(lead.y, STEPS.pad + pitch, "the spine sits one lane down");
  });
});
