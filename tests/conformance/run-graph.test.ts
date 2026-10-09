/**
 * Run graph — the Build room's node-graph view is rebuilt from the log alone.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildProgress } from "../../src/renderer/build-progress.ts";
import { newBuildOffer } from "../../src/renderer/stage.ts";
import type { EventEnvelope } from "../../src/substrate/types.ts";
import {
  buildRunGraph,
  hasMergedBuild,
  nextStep,
  passedFraction,
  plannedFlips,
  roundStep,
  type IterationNode,
  type Rect,
} from "../../src/renderer/run-graph.ts";
import { checkCounts } from "../../src/renderer/words.ts";

let counter = 0;
function event(eventType: string, payload: Record<string, unknown>): EventEnvelope {
  counter += 1;
  return {
    id: `e${String(counter).padStart(4, "0")}`,
    thread_id: "t",
    session_id: null,
    turn_id: null,
    created_at: `2026-09-03T15:${String(counter % 60).padStart(2, "0")}:00.000Z`,
    data: { type: "custom", event_type: eventType, payload: { runId: "run_x", ...payload } },
  };
}

const facets = [
  { id: "buildings", title: "Cottages & chapel", budgetShare: 0.6 },
  { id: "ground", title: "Terrain & light", budgetShare: 0.4 },
];

function verdict(
  facetId: string,
  iteration: number,
  winner: "challenger" | "incumbent",
  extra: Record<string, unknown> = {},
) {
  return event("facet_iteration", {
    facetId,
    facetTitle: facets.find((f) => f.id === facetId)?.title,
    iteration,
    winner,
    satisfied: false,
    biggest_gap: `gap of ${facetId} ${iteration} — something the judge saw that runs on for a very long time indeed, well past ninety characters`,
    reason: winner === "challenger" ? "checks accepted" : "no change",
    verdictSource: winner === "challenger" ? "checks" : "invisible",
    defects: ["[floating] hay hovers", "well reads as a shed"],
    unmeasured: [],
    scoreboard: {
      total: 10,
      passing: 6,
      unmeasured: 1,
      flips: ["a"],
      regressions: [],
      results: [{ id: "a", kind: "scene", weight: "identity", pass: true, reason: "" }],
    },
    move: null,
    liveness: { total: 9, max: 24, biggest: "light", scores: { light: 0, extent: 2 } },
    shots: [{ camera: "default", path: `/runs/run_x/${facetId}/${iteration}/default.jpg`, bytes: 10 }],
    flags: [],
    diffs: {},
    ...extra,
  });
}

/** A run that stopped mid-build: two facets, a routed defect, and an asked-but-unanswered move. */
function midRun(): EventEnvelope[] {
  counter = 0;
  return [
    event("run_started", {
      project: "village",
      goal: "A medieval village",
      reference: { name: "Kingdom Come", kind: "reference" },
    }),
    event("autopilot_started", { facets, maxParallel: 2 }),
    event("autopilot_base", { ok: true, commit: "abc123" }),
    verdict("buildings", 1, "challenger"),
    verdict("ground", 1, "challenger"),
    event("facet_defect_routed", {
      from: "buildings",
      to: "ground",
      iteration: 1,
      check: { id: "defect-hay", defect: "hay reads plastic", camera: "camSquare" },
    }),
    event("facet_move", {
      facetId: "buildings",
      facetTitle: "Cottages & chapel",
      iteration: 2,
      what: "Chapel tower with a bell",
      milestoneId: "chapel",
      source: "milestone",
      delivered: null,
      scale: null,
    }),
    event("facet_move", {
      facetId: "ground",
      facetTitle: "Terrain & light",
      iteration: 2,
      what: "Mud ruts on the lane",
      milestoneId: "lane",
      source: "milestone",
      delivered: null,
      scale: null,
    }),
    verdict("ground", 2, "incumbent"),
    event("facet_move", {
      facetId: "ground",
      facetTitle: "Terrain & light",
      iteration: 2,
      what: "Mud ruts on the lane",
      milestoneId: "lane",
      source: "milestone",
      delivered: false,
      scale: "polish",
    }),
    event("integration_merge", { facetId: "buildings", iteration: 1, head: "deadbeef", conflict: false }),
  ];
}

function finishRun(events: EventEnvelope[]): EventEnvelope[] {
  return [
    ...events,
    verdict("buildings", 2, "challenger", {
      move: {
        what: "Chapel tower with a bell",
        milestoneId: "chapel",
        source: "milestone",
        delivered: true,
        scale: "structural",
      },
    }),
    event("integration_ledger", { pick: "challenger", reason: "B wins", defects: ["trees are blobs"] }),
    event("run_finished", {
      victory: false,
      stoppedBecause: "facets settled",
      globalVerdict: { pick: "challenger", defects: ["trees are blobs"], biggest_gap: "trees", reason: "B wins" },
      facets: {
        buildings: { stoppedBecause: "budget exhausted", iterations: 2, satisfied: false },
        ground: { stoppedBecause: "settled", iterations: 2, satisfied: false },
      },
    }),
  ];
}

const iterations = (nodes: ReturnType<typeof buildRunGraph>): IterationNode[] =>
  (nodes?.nodes ?? []).filter((node): node is IterationNode => node.kind === "iteration");

describe("buildRunGraph", () => {
  it("shows a cross-provider starting point as building until its checks finish", () => {
    const events = [
      event("run_started", { engine: "codex", model: "sonnet", builderEngine: "claude-code" }),
      event("autopilot_started", { director: true, facets: [] }),
      event("autopilot_base_started", {}),
    ];
    const graph = buildRunGraph(events)!;
    const run = graph.nodes.find((n) => n.kind === "run")!;
    const base = graph.nodes.find((n) => n.kind === "base")!;
    assert.equal(run.builderEngine, "claude-code");
    assert.equal(base.absent, false);
    assert.equal(base.done, false);
    assert.equal(buildProgress(graph).title, "Building the starting point");
    const finished = buildRunGraph([...events, event("autopilot_base", { ok: true, empty: true })])!;
    assert.equal(buildProgress(finished).title, "The starting point is ready");
  });

  it("returns null for a thread with no run", () => {
    assert.equal(buildRunGraph([]), null);
    assert.equal(
      buildRunGraph([
        {
          id: "1",
          thread_id: "t",
          session_id: null,
          turn_id: null,
          created_at: "",
          data: { type: "thread_created", title: "x", metadata: {} },
        } as EventEnvelope,
      ]),
      null,
    );
  });

  it("builds run → base → facets → iterations → integration → final from the log", () => {
    const graph = buildRunGraph(finishRun(midRun()));
    assert.ok(graph);
    assert.equal(graph.runId, "run_x");
    assert.equal(graph.active, false);
    assert.deepEqual(
      graph.facets.map((facet) => facet.facetId),
      ["buildings", "ground"],
    );
    assert.deepEqual(
      graph.nodes.map((node) => node.kind).filter((kind, index, all) => all.indexOf(kind) === index),
      ["run", "base", "facet", "iteration", "integration", "final"],
    );

    const run = graph.nodes.find((node) => node.kind === "run");
    assert.ok(run && run.kind === "run");
    assert.equal(run.goal, "A medieval village");
    assert.equal(run.reference?.name, "Kingdom Come");
    assert.equal(run.stoppedBecause, "facets settled");
    assert.equal(run.victory, false);

    const base = graph.nodes.find((node) => node.kind === "base");
    assert.ok(base && base.kind === "base" && base.done && base.commit === "abc123");

    const buildings = graph.facets[0];
    assert.equal(buildings.budgetShare, 0.6);
    assert.equal(buildings.stoppedBecause, "budget exhausted");
    assert.equal(buildings.iterations, 2);
    assert.equal(buildings.accepted, 2);
    assert.equal(buildings.trend.length, 2);
    assert.equal(buildings.trend[0].passing, 6);
    assert.equal(buildings.trend[0].alive, 9);

    const ground = graph.facets[1];
    assert.equal(ground.accepted, 1);
    assert.equal(ground.rolled, 1);

    const flow = graph.edges.filter((edge) => edge.kind === "flow").map((edge) => edge.id);
    assert.ok(flow.includes("run→base"));
    assert.ok(flow.includes("base→facet:buildings"));
    assert.ok(flow.includes("facet:buildings→iter:buildings:1"));
    assert.ok(flow.includes("iter:buildings:1→iter:buildings:2"));
    assert.ok(flow.includes("iter:buildings:2→integration"));
    assert.ok(flow.includes("iter:ground:2→integration"));
    assert.ok(flow.includes("integration→final"));

    const final = graph.nodes.find((node) => node.kind === "final");
    assert.ok(final && final.kind === "final");
    assert.equal(final.globalVerdict?.pick, "challenger");
    assert.deepEqual(final.globalVerdict?.defects, ["trees are blobs"]);

    const integration = graph.nodes.find((node) => node.kind === "integration");
    assert.ok(integration && integration.kind === "integration");
    assert.equal(integration.merges.length, 1);
    assert.equal(integration.ledger?.pick, "challenger");
    const merged = iterations(graph).find((node) => node.id === "iter:buildings:1");
    assert.equal(merged?.merge?.head, "deadbeef");
  });

  it("shows an asked-but-unanswered move as a building node until the verdict lands", () => {
    const mid = buildRunGraph(midRun());
    assert.ok(mid);
    assert.equal(mid.active, true);
    const building = iterations(mid).find((node) => node.id === "iter:buildings:2");
    assert.ok(building, "iteration 2 of buildings exists while its move is being built");
    assert.equal(building.status, "building");
    assert.match(building.verdictLabel, /^building · move: Chapel tower/);
    assert.equal(building.move?.delivered, null);
    assert.equal(mid.facets[0].building, true);
    assert.equal(mid.facets[0].iterations, 1, "a building iteration is not counted as judged");

    // the ground facet's move was answered (not delivered) after its verdict — that is not building
    const ground2 = iterations(mid).find((node) => node.id === "iter:ground:2");
    assert.equal(ground2?.status, "rolled");
    assert.equal(ground2?.move?.delivered, false);
    assert.equal(ground2?.move?.scale, "polish");
    assert.equal(ground2?.verdictLabel, "undone — nothing visible changed");

    const done = buildRunGraph(finishRun(midRun()));
    assert.ok(done);
    const judged = iterations(done).find((node) => node.id === "iter:buildings:2");
    assert.equal(judged?.status, "accepted");
    assert.equal(judged?.verdictLabel, "kept — the checks it was given now pass, and no reviewer objected");
    assert.equal(judged?.move?.delivered, true);
    assert.equal(judged?.move?.scale, "structural");
    assert.ok(
      iterations(done).every((node) => node.status !== "building"),
      "nothing is building after the run finished",
    );
  });

  it("marks a still-building iteration abandoned when the run stops first", () => {
    const events = [...midRun(), event("run_finished", { victory: false, stoppedBecause: "provider outage" })];
    const graph = buildRunGraph(events);
    const node = iterations(graph).find((n) => n.id === "iter:buildings:2");
    assert.equal(node?.status, "abandoned");
  });

  it("draws a dashed routed edge from the judged iteration to the target facet's next iteration", () => {
    const graph = buildRunGraph(midRun());
    assert.ok(graph);
    const routed = graph.edges.filter((edge) => edge.kind === "routed");
    assert.equal(routed.length, 1);
    assert.equal(routed[0].from, "iter:buildings:1");
    // ground had finished iteration 1 when the defect was routed → its iteration 2 receives it
    assert.equal(routed[0].to, "iter:ground:2");
    assert.equal(routed[0].count, 1);
    const source = iterations(graph).find((node) => node.id === "iter:buildings:1");
    assert.equal(source?.routedOut, 1);
    const target = iterations(graph).find((node) => node.id === "iter:ground:2");
    assert.equal(target?.routedIn, 1);
  });

  it("collapses repeated routes between the same nodes and falls back to the facet header", () => {
    const events = [
      ...midRun().slice(0, 5),
      event("facet_defect_routed", { from: "buildings", to: "ground", iteration: 1, check: { id: "a" } }),
      event("facet_defect_routed", { from: "buildings", to: "ground", iteration: 1, check: { id: "b" } }),
      event("facet_defect_routed", { from: "ground", to: "buildings", iteration: 7, check: { id: "c" } }),
    ];
    const graph = buildRunGraph(events);
    assert.ok(graph);
    const routed = graph.edges.filter((edge) => edge.kind === "routed");
    assert.equal(routed.length, 2);
    const merged = routed.find((edge) => edge.from === "iter:buildings:1");
    assert.equal(merged?.count, 2);
    // ground has no iteration 7 and buildings has no iteration 2 yet → both ends use headers
    const fallback = routed.find((edge) => edge.from === "facet:ground");
    assert.equal(fallback?.to, "facet:buildings");
  });

  it("uses the last run in the log", () => {
    counter = 0;
    const events = [
      event("run_started", { runId: "run_old", goal: "old" }),
      verdict("buildings", 1, "challenger"),
      event("run_finished", { runId: "run_old" }),
      ...midRun().map((e) => e),
    ];
    // midRun() reset the counter; re-id so ordering is stable
    events.forEach((e, index) => (e.id = `e${String(index).padStart(4, "0")}`));
    const graph = buildRunGraph(events);
    assert.equal(graph?.runId, "run_x");
  });

  it("parses facet_fix, flags with a target, and provider outages", () => {
    const events = [
      ...midRun(),
      event("facet_fix", {
        facetId: "buildings",
        iteration: 2,
        what: "ground the plinths",
        checkId: "buildings-grounded",
        streak: 2,
        delivered: null,
      }),
      event("facet_flag", {
        facetId: "buildings",
        iteration: 2,
        what: "needs terrain first",
        checkId: "buildings-grounded",
        target: "ground",
      }),
      event("facet_provider_outage", {
        facetId: "buildings",
        phase: "build",
        wait: 30,
        attempt: 1,
        error: "overloaded",
      }),
    ];
    const graph = buildRunGraph(events);
    const node = iterations(graph).find((n) => n.id === "iter:buildings:2");
    assert.equal(node?.fix?.checkId, "buildings-grounded");
    assert.equal(node?.fix?.streak, 2);
    assert.match(node?.verdictLabel ?? "", /ground the plinths/);
    assert.equal(node?.flags.length, 1);
    assert.equal(node?.outage?.count, 1);
    assert.equal(node?.outage?.lastError, "overloaded");
    const flagEdge = graph?.edges.find((edge) => edge.kind === "flag");
    assert.equal(flagEdge?.from, "iter:buildings:2");
    assert.equal(flagEdge?.to, "facet:ground", "ground's next iteration (3) does not exist → its header");
  });
});

describe("the plan's checks and the judge's own notes", () => {
  it("carries both counts onto the round, and counts only the plan's flips as a win", () => {
    counter = 0;
    const graph = buildRunGraph([
      event("run_started", { project: "village", goal: "A medieval village" }),
      event("autopilot_started", { facets, maxParallel: 2 }),
      verdict("buildings", 1, "challenger", {
        scoreboard: {
          total: 12,
          passing: 3,
          unmeasured: 4,
          plannedTotal: 9,
          plannedPassing: 3,
          plannedUnmeasured: 4,
          grownTotal: 3,
          flips: ["mud-visible", "defect-hay-hovers"],
          plannedFlips: ["mud-visible"],
          regressions: [],
          results: [],
        },
      }),
    ])!;
    const round = graph.nodes.find((node): node is IterationNode => node.kind === "iteration")!;
    assert.equal(round.scoreboard?.plannedTotal, 9);
    assert.equal(round.scoreboard?.grownTotal, 3);
    // The line every surface prints — the round card, the round drawer, the judges' sheet, the chat.
    assert.equal(checkCounts(round.scoreboard), "Passed 3 · Failed 2 · Couldn't measure 4 · 3 reviewer notes");
    // "+1", not "+2": the judge's own question turning green is not the part doing its job.
    assert.deepEqual(plannedFlips(round), ["mud-visible"]);
    assert.equal(passedFraction(round.scoreboard), (3 / 9) * 100);
  });

  it("reads a run from before the split exactly as it always did", () => {
    counter = 0;
    const graph = buildRunGraph([
      event("run_started", { project: "village", goal: "g" }),
      event("autopilot_started", { facets, maxParallel: 2 }),
      verdict("buildings", 1, "challenger"),
    ])!;
    const round = graph.nodes.find((node): node is IterationNode => node.kind === "iteration")!;
    assert.equal(round.scoreboard?.plannedTotal, null);
    assert.equal(round.scoreboard?.plannedFlips, null);
    assert.equal(checkCounts(round.scoreboard), "Passed 6 · Failed 3 · Couldn't measure 1");
    assert.deepEqual(plannedFlips(round), ["a"]);
  });
});

/** Two cards share pixels: what no timeline layout may do. */
const rectsOverlap = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// ── the Builds tab: notes, plain words, timeline ─────────────────────────────────────────

import {
  checkWords,
  digestField,
  plainDefect,
  roundKind,
  roundWhy,
  runDirOf,
  runStillPath,
  thumbShot,
} from "../../src/renderer/run-graph.ts";
import { layoutSteps, partRows, STEPS } from "../../src/renderer/run-steps.ts";

describe("notes and plain words", () => {
  it("pins a user note to the round it named and records the first later verdict of that part", () => {
    const events = midRun();
    events.push(
      event("user_feedback", {
        facetId: "ground",
        iteration: 1,
        camera: "default",
        text: "the mud is too shiny",
        at: "2026-09-03T15:30:00.000Z",
      }),
    );
    const graph = buildRunGraph(finishRun(events))!;
    // the note came after every verdict in midRun; only buildings it 2 (finishRun) is judged later
    assert.equal(graph.notes.length, 1);
    const note = graph.notes[0]!;
    assert.equal(note.facetId, "ground");
    assert.equal(note.landedIn, null, "ground judged nothing after the note");
    const ground1 = iterations(graph).find((node) => node.facetId === "ground" && node.iteration === 1)!;
    assert.deepEqual(
      ground1.notes.map((n) => n.text),
      ["the mud is too shiny"],
    );
  });

  it("marks a note as landed once a later round of that part is judged", () => {
    counter = 0;
    const events = [
      event("run_started", { project: "village", goal: "A village" }),
      event("autopilot_started", { facets, maxParallel: 2 }),
      verdict("buildings", 1, "challenger"),
      event("user_feedback", { facetId: "buildings", iteration: 1, text: "chapel too small" }),
      verdict("buildings", 2, "challenger"),
    ];
    const graph = buildRunGraph(events)!;
    assert.equal(graph.notes[0]!.landedIn, 2);
    // a note with no part is a run-level note, pinned nowhere
    const graph2 = buildRunGraph([...events, event("user_feedback", { text: "more fog everywhere" })])!;
    assert.equal(graph2.notes.length, 2);
    assert.equal(graph2.notes[1]!.facetId, null);
    assert.equal(
      iterations(graph2).reduce((sum, node) => sum + node.notes.length, 0),
      1,
    );
  });

  it("names a round's kind and job from its move or fix", () => {
    const base = iterations(buildRunGraph(finishRun(midRun()))!);
    const first = base.find((node) => node.facetId === "buildings" && node.iteration === 1)!;
    assert.equal(roundKind(first), "first build");
    assert.match(roundWhy(first), /first build/i);
    const stepped = base.find((node) => node.facetId === "buildings" && node.iteration === 2)!;
    assert.equal(roundKind(stepped), "next step");
    assert.equal(roundWhy(stepped), "Chapel tower with a bell");
    const critic = { ...stepped, move: { ...stepped.move!, source: "critic" } };
    assert.equal(roundKind(critic), "what's missing");
    // The taste judge's big move, which a worker builds once its lead's ladder is climbed.
    const reviewer = { ...stepped, move: { ...stepped.move!, source: "reviewer" } };
    assert.equal(roundKind(reviewer), "what's missing");
    const fix = {
      ...stepped,
      fix: {
        what: "Rebuild the canopies from leaf cards",
        checkId: "trees",
        streak: 3,
        mandatory: true,
        delivered: null,
      },
    };
    assert.equal(roundKind(fix), "must fix");
    assert.equal(roundWhy(fix), "Rebuild the canopies from leaf cards");
    const softFix = { ...fix, fix: { ...fix.fix, streak: 1, mandatory: false } };
    assert.equal(roundKind(softFix), "fixes");
    const polish = { ...first, iteration: 3 };
    assert.equal(roundKind(polish), "polish");
  });

  it("strips check ids from defects and turns ids into words", () => {
    assert.equal(plainDefect("[floating] hay hovers above the cart"), "hay hovers above the cart");
    assert.equal(plainDefect("no prefix here"), "no prefix here");
    assert.equal(checkWords("defect-the-dog-is-a-boxy-loaf"), "the dog is a boxy loaf");
    assert.equal(checkWords("roof_strips-layered"), "roof strips layered");
  });

  it("finds the run folder from a still and prefers the default camera for a thumbnail", () => {
    assert.equal(
      runDirOf("/Users/x/runs/run_abc/facet_a/iter_001/screenshots/camLane.jpg", "run_abc"),
      "/Users/x/runs/run_abc",
    );
    assert.equal(runDirOf("/elsewhere/cam.jpg", "run_abc"), null);
    assert.equal(runStillPath("/Users/x/runs/run_abc", "base"), "/Users/x/runs/run_abc/base/screenshots/default.jpg");
    const graph = buildRunGraph(midRun())!;
    assert.equal(graph.runDir, "/runs/run_x");
    const node = iterations(graph)[0]!;
    assert.equal(
      thumbShot({
        ...node,
        shots: [
          { camera: "demo:walk", path: "d" },
          { camera: "camLane", path: "l" },
          { camera: "default", path: "x" },
        ],
      })?.path,
      "x",
    );
    assert.equal(
      thumbShot({
        ...node,
        shots: [
          { camera: "demo:walk", path: "d" },
          { camera: "camLane", path: "l" },
        ],
      })?.path,
      "l",
    );
    assert.equal(thumbShot({ ...node, shots: [] }), null);
    assert.deepEqual(graph.lastMerged, { facetId: "buildings", iteration: 1 });
  });
});

describe("the next step is one fact", () => {
  it("names the round underway with its part, in the words the judges' sheet uses, and nothing once the run is over", () => {
    const graph = buildRunGraph(midRun())!;
    const underway = iterations(graph).filter((node) => node.status === "building");
    assert.equal(underway.length, 1, "the asked-but-unanswered move is the one round underway");
    assert.equal(roundStep(underway[0]!), "Next step: Chapel tower with a bell");
    assert.equal(nextStep(graph), "Cottages & chapel — Next step: Chapel tower with a bell");
    // The outcome card must not invent a step when the record holds none.
    assert.equal(nextStep(buildRunGraph(finishRun(midRun()))!), null);
  });
});

describe("the modeller in the run graph (AG-930)", () => {
  it("a Blender node exists when the run had Blender, folds assets in order, ignores chat-build events, and sits under the starting world", () => {
    counter = 0;
    const events = [
      event("run_started", {
        goal: "a farm",
        project: "farm",
        reference: { name: "x" },
        blender: { version: "5.2.1", path: "/Applications/Blender.app/Contents/MacOS/Blender" },
      }),
      event("autopilot_started", { facets, maxParallel: 2 }),
      event("blender_asset", {
        facetId: "buildings",
        iteration: 1,
        name: "barn",
        file: "assets/barn.glb",
        bytes: 40960,
        render: "/runs/run_x/facet_buildings/blender/barn-1.png",
        renderFront: "/runs/run_x/facet_buildings/blender/barn-1-front.png",
        ok: true,
        error: null,
        stats: { meshes: 3, polygons: 900, triangles: 1800, materials: 2, size: [6, 4, 8] },
        blenderVersion: "5.2.1",
        at: "2026-09-05T10:00:00.000Z",
      }),
      event("blender_asset", {
        facetId: "ground",
        iteration: 2,
        name: "dog",
        file: null,
        bytes: 0,
        render: null,
        ok: false,
        error: "NameError: bpyy",
        stats: null,
        blenderVersion: "5.2.1",
        at: "2026-09-05T10:01:00.000Z",
      }),
      verdict("buildings", 1, "challenger"),
    ];
    // A chat build's asset names no runId: the graph never sees it.
    const chat = event("blender_asset", {
      name: "cart",
      ok: true,
      file: "assets/cart.glb",
      bytes: 10,
      render: null,
      stats: null,
    });
    (chat.data as { payload: Record<string, unknown> }).payload.runId = undefined;
    const graph = buildRunGraph([...events, chat])!;
    const node = graph.nodes.find((n) => n.kind === "blender");
    assert.ok(node && node.kind === "blender");
    assert.equal(node.version, "5.2.1");
    assert.deepEqual(
      node.assets.map((a) => [a.name, a.ok, a.facetId, a.iteration, a.polygons]),
      [
        ["barn", true, "buildings", 1, 900],
        ["dog", false, "ground", 2, null],
      ],
    );
    assert.equal(node.assets[1]!.error, "NameError: bpyy");
    assert.equal(node.assets[0]!.triangles, 1800);
    assert.equal(node.assets[0]!.renderFront, "/runs/run_x/facet_buildings/blender/barn-1-front.png");
    assert.equal(node.assets[1]!.renderFront, null, "an event without the second view still folds");
    assert.equal(graph.runDir, "/runs/run_x", "the first render names the run folder like any still");
    // The modeller is part of the one assets node, under the start.
    const layout = layoutSteps(partRows(graph), { assets: true });
    assert.ok(layout.rects.assets!.y >= layout.rects.start!.y + layout.rects.start!.h, "below the start");
    // A part built in one session has no label, only its node; neither may sit under the assets.
    for (const [id, rect] of Object.entries(layout.rects))
      if (/^(row|step|session):/.test(id))
        assert.equal(rectsOverlap(layout.rects.assets!, rect), false, `never over ${id}`);
  });

  it("no Blender node when the run had none, and an asset event alone still creates one", () => {
    counter = 0;
    const without = buildRunGraph([
      event("run_started", { goal: "g", project: "p", reference: { name: "x" }, blender: null }),
      event("autopilot_started", { facets, maxParallel: 1 }),
    ])!;
    assert.equal(
      without.nodes.some((n) => n.kind === "blender"),
      false,
    );
    assert.equal(layoutSteps(partRows(without)).rects.assets, undefined);
    counter = 0;
    const lateGrant = buildRunGraph([
      event("run_started", { goal: "g", project: "p", reference: { name: "x" } }),
      event("blender_asset", {
        name: "dog",
        ok: true,
        file: "assets/dog.glb",
        bytes: 1,
        render: null,
        stats: null,
        blenderVersion: "5.2.1",
      }),
    ])!;
    const node = lateGrant.nodes.find((n) => n.kind === "blender");
    assert.ok(node && node.kind === "blender" && node.version === "5.2.1");
  });
});

describe("the plugins' asset jobs in the run graph", () => {
  /** The host's record of a plugin call going out. */
  const started = (callId: string, extra: Record<string, unknown> = {}) =>
    event("plugin_tool_started", {
      callId,
      pluginId: "genex",
      pluginName: "Genex Tools",
      tool: "asset",
      toolName: "genex__asset",
      args: "operation=create prompt=a red barn with a weathervane style=painterly",
      project: "farm",
      engine: "claude-code",
      role: "builder",
      at: "2026-09-05T10:00:00.000Z",
      ...extra,
    });
  /** The same call coming back. */
  const finished = (callId: string, extra: Record<string, unknown> = {}) =>
    event("plugin_tool", {
      callId,
      pluginId: "genex",
      pluginName: "Genex Tools",
      tool: "asset",
      toolName: "genex__asset",
      args: "operation=create prompt=a red barn with a weathervane style=painterly",
      project: "farm",
      engine: "claude-code",
      role: "builder",
      at: "2026-09-05T10:00:00.000Z",
      ok: true,
      result: '{"id":"job-1","status":"generating"}',
      images: 0,
      durationMs: 900,
      ...extra,
    });

  it("follows one job from asked-for to delivered, keeps the worker that asked, and folds a restart into one part", () => {
    counter = 0;
    const graph = buildRunGraph([
      event("run_started", { goal: "a farm", project: "farm", reference: { name: "x" } }),
      event("autopilot_started", { facets, maxParallel: 2 }),
      verdict("buildings", 1, "challenger"),
      event("director_worker", {
        workerId: "buildings2",
        replaces: "buildings",
        title: "Cottages & chapel",
        state: "running",
      }),
      started("call-1", { facetId: "buildings2", iteration: 1 }),
      finished("call-1", { facetId: "buildings2", iteration: 1, jobId: "job-1" }),
      event("asset_delivered", {
        project: "farm",
        source: "genex",
        pluginId: "genex",
        jobId: "job-1",
        files: [{ file: "assets/genex/job-1/barn.png", bytes: 20480, kind: "image" }],
        at: "2026-09-05T10:02:00.000Z",
        facetId: "buildings2",
        iteration: 1,
      }),
    ])!;
    const node = graph.nodes.find((n) => n.kind === "assets");
    assert.ok(node && node.kind === "assets", "a plugin call with attribution earns an assets node");
    assert.equal(node.jobs.length, 1, "one card per call, not one per event");
    const job = node.jobs[0]!;
    assert.equal(job.state, "delivered");
    assert.equal(job.ok, true, "`ok` stays derived from the state");
    assert.equal(job.source, "genex");
    assert.equal(job.pluginName, "Genex Tools");
    assert.equal(job.jobId, "job-1");
    assert.equal(job.callId, "call-1");
    assert.deepEqual(job.files, ["assets/genex/job-1/barn.png"]);
    assert.equal(job.file, "assets/genex/job-1/barn.png");
    assert.equal(job.bytes, 20480);
    assert.equal(job.prompt, "a red barn with a weathervane", "the prompt comes out of the host's own digest");
    assert.equal(job.operation, "create");
    assert.equal(job.tool, "asset");
    // The restart is the same part, and its rounds carry on after the ones it replaced.
    assert.equal(job.facetId, "buildings");
    assert.equal(job.iteration, 2);
  });

  it("shows a job the plugin has taken on as still generating, and drops a call that delivered nothing", () => {
    counter = 0;
    const generating = buildRunGraph([
      event("run_started", { goal: "a farm", project: "farm" }),
      started("call-1"),
      finished("call-1", { jobId: "job-1" }),
    ])!;
    const open = generating.nodes.find((n) => n.kind === "assets");
    assert.ok(open && open.kind === "assets");
    assert.equal(open.jobs[0]!.state, "generating", "accepted, not yet delivered");
    assert.equal(open.jobs[0]!.ok, false);

    counter = 0;
    // A call still out has only ever been asked for; the log may not claim more than that.
    const asked = buildRunGraph([event("run_started", { goal: "a farm", project: "farm" }), started("call-1")])!;
    const open2 = asked.nodes.find((n) => n.kind === "assets");
    assert.ok(open2 && open2.kind === "assets");
    assert.equal(open2.jobs[0]!.state, "requested");

    counter = 0;
    // A status check delivers nothing and names no job: it is not an asset, so it is not a card.
    const status = buildRunGraph([
      event("run_started", { goal: "a farm", project: "farm" }),
      started("call-2", { tool: "status", toolName: "genex__status", args: "operation=status" }),
      finished("call-2", { tool: "status", toolName: "genex__status", result: '{"jobs":0}' }),
    ])!;
    assert.equal(
      status.nodes.some((n) => n.kind === "assets"),
      false,
    );
    assert.equal(
      layoutSteps(partRows(status), { assets: status.nodes.some((n) => n.kind === "assets") }).rects.assets,
      undefined,
    );
  });

  it("says a failed call failed, in the plugin's own words, and keeps the card", () => {
    counter = 0;
    const graph = buildRunGraph([
      event("run_started", { goal: "a farm", project: "farm" }),
      event("autopilot_started", { facets, maxParallel: 1 }),
      started("call-1", { facetId: "ground", iteration: 2 }),
      finished("call-1", { facetId: "ground", iteration: 2, ok: false, error: "out of credits", result: "" }),
    ])!;
    const node = graph.nodes.find((n) => n.kind === "assets");
    assert.ok(node && node.kind === "assets");
    assert.equal(node.jobs[0]!.state, "failed");
    assert.equal(node.jobs[0]!.ok, false);
    assert.equal(node.jobs[0]!.error, "out of credits");
    assert.equal(node.jobs[0]!.facetId, "ground");
    assert.equal(node.jobs[0]!.iteration, 2);
  });

  it("joins a call that names no job to the delivery of the same files", () => {
    counter = 0;
    const graph = buildRunGraph([
      event("run_started", { goal: "a farm", project: "farm" }),
      started("call-1"),
      event("asset_delivered", {
        project: "farm",
        source: "genex",
        jobId: "job-1",
        files: [{ file: "assets/barn.png", bytes: 10, kind: "image" }],
      }),
      finished("call-1", { files: ["assets/barn.png"] }),
    ])!;
    const node = graph.nodes.find((n) => n.kind === "assets");
    assert.ok(node && node.kind === "assets");
    assert.equal(node.jobs.length, 1);
    assert.equal(node.jobs[0]!.callId, "call-1");
    assert.equal(node.jobs[0]!.jobId, "job-1");
  });

  it("shows Blender work on an asset the run already has as a step on that asset, not a new one", () => {
    counter = 0;
    const blender = {
      pluginId: "blender",
      pluginName: "Local Blender",
      tool: "model",
      args: "name=tank-inspect script=assets/src/inspect.py model=assets/genex/job-1/tank.glb",
    };
    const graph = buildRunGraph([
      event("run_started", { goal: "tanks", project: "farm" }),
      started("call-1", { args: "operation=model prompt=a tank" }),
      finished("call-1", {
        args: "operation=model prompt=a tank",
        jobId: "job-1",
        files: ["assets/genex/job-1/tank.glb"],
      }),
      started("call-2", { args: "operation=wait id=gen-1" }),
      finished("call-2", { args: "operation=wait id=gen-1", jobId: "job-2", files: ["assets/genex/job-2/tank.glb"] }),
      started("call-3", blender),
      finished("call-3", {
        ...blender,
        files: ["assets/blender/b-1/model.glb", "assets/blender/b-1/render.png"],
        result: JSON.stringify({
          jobId: "b-1",
          derivedFrom: { file: "assets/genex/job-1/tank.glb" },
          stats: { size: [1, 0.579, 0.4685], triangles: 144143 },
        }),
      }),
    ])!;
    const node = graph.nodes.find((n) => n.kind === "assets");
    assert.ok(node && node.kind === "assets");
    assert.equal(node.jobs.length, 2, "the Blender pass is not a third asset");
    assert.deepEqual(node.jobs[0]!.derived, [
      {
        pluginName: "Local Blender",
        name: "tank-inspect",
        files: ["assets/blender/b-1/model.glb", "assets/blender/b-1/render.png"],
        size: [1, 0.579, 0.4685],
        triangles: 144143,
        at: "2026-09-05T10:00:00.000Z",
      },
    ]);
  });

  it("keeps a failed in-game check off the asset list and on the asset it checked", () => {
    counter = 0;
    const check = { args: "operation=inspect_use id=job-1" };
    const graph = buildRunGraph([
      event("run_started", { goal: "a farm", project: "farm" }),
      started("call-1"),
      finished("call-1", { jobId: "job-1", files: ["assets/genex/job-1/barn.png"] }),
      started("call-2", check),
      finished("call-2", {
        ...check,
        ok: false,
        error: "Job job-1 was delivered to another workspace",
        result: "",
        at: "2026-09-05T10:05:00.000Z",
      }),
      started("call-3", { args: "operation=status" }),
      finished("call-3", { args: "operation=status", ok: false, error: "offline", result: "" }),
      started("call-4", {
        pluginId: "blender",
        pluginName: "Local Blender",
        args: "operation=model name=hero-tank script=assets/src/hero.py",
      }),
    ])!;
    const node = graph.nodes.find((n) => n.kind === "assets");
    assert.ok(node && node.kind === "assets");
    assert.deepEqual(
      node.jobs.map((job) => job.name),
      ["a red barn with a weathervane", "hero-tank"],
      "checks and lookups are not assets; a named model keeps its name",
    );
    assert.deepEqual(node.jobs[0]!.check, {
      ok: false,
      error: "Job job-1 was delivered to another workspace",
      at: "2026-09-05T10:05:00.000Z",
    });
    assert.equal(node.jobs[0]!.state, "delivered", "a failed check does not fail the asset");
  });

  /**
   * The order the host actually writes: the delivery record is appended while `assets.deliver` is
   * still running, so it lands between the call going out and the call coming back.
   */
  it("reads the real event order — started, delivered, then finished — as one delivered card", () => {
    counter = 0;
    const graph = buildRunGraph([
      event("run_started", { goal: "a farm", project: "farm" }),
      started("call-1"),
      event("asset_delivered", {
        project: "farm",
        source: "genex",
        pluginId: "genex",
        jobId: "job-1",
        files: [{ file: "assets/genex/job-1/barn.png", bytes: 20480, kind: "image" }],
        at: "2026-09-05T10:01:00.000Z",
      }),
      finished("call-1", {
        jobId: "job-1",
        files: ["assets/genex/job-1/barn.png"],
        result: '{"id":"job-1","files":["assets/genex/job-1/barn.png"]}',
      }),
    ])!;
    const node = graph.nodes.find((n) => n.kind === "assets");
    assert.ok(node && node.kind === "assets");
    assert.equal(node.jobs.length, 1, "the delivery that arrived first is this call's card, not a second one");
    const job = node.jobs[0]!;
    assert.equal(job.state, "delivered");
    assert.equal(job.ok, true);
    assert.equal(job.callId, "call-1");
    assert.equal(job.jobId, "job-1");
    assert.equal(job.bytes, 20480, "the bytes the delivery record knew survive the fold");
    assert.equal(job.file, "assets/genex/job-1/barn.png");
    assert.equal(job.prompt, "a red barn with a weathervane", "and the card still says what was asked for");
  });

  it("resolves the card a create opened when a later wait delivers the same generation", () => {
    counter = 0;
    const graph = buildRunGraph([
      event("run_started", { goal: "a farm", project: "farm" }),
      started("call-1"),
      finished("call-1", { jobId: "job-1", generationId: "gen-1", result: '{"id":"job-1","generationId":"gen-1"}' }),
      started("call-2", { args: "operation=wait id=gen-1", at: "2026-09-05T10:05:00.000Z" }),
      event("asset_delivered", {
        project: "farm",
        source: "genex",
        pluginId: "genex",
        jobId: "job-2",
        files: [{ file: "assets/genex/job-2/barn.glb", bytes: 4096, kind: "model" }],
        at: "2026-09-05T10:06:00.000Z",
      }),
      finished("call-2", {
        jobId: "job-2",
        generationId: "gen-1",
        files: ["assets/genex/job-2/barn.glb"],
        at: "2026-09-05T10:06:00.000Z",
      }),
    ])!;
    const node = graph.nodes.find((n) => n.kind === "assets");
    assert.ok(node && node.kind === "assets");
    assert.equal(node.jobs.length, 1, "one asset, one card: the create, the wait and the delivery are one thing");
    const job = node.jobs[0]!;
    assert.equal(job.state, "delivered", "the create never stays generating once its generation is delivered");
    assert.equal(job.ok, true);
    assert.equal(job.callId, "call-1", "the card is the one the run asked for");
    assert.equal(job.jobId, "job-2", "carrying the job whose files landed");
    assert.deepEqual(job.files, ["assets/genex/job-2/barn.glb"]);
    assert.equal(job.bytes, 4096);
    assert.equal(
      node.jobs.some((j) => j.state === "generating"),
      false,
    );
  });

  it("ignores a plugin call and a delivery that belong to another run, and never doubles a Blender asset", () => {
    counter = 0;
    const foreign = started("call-1");
    (foreign.data as { payload: Record<string, unknown> }).payload.runId = "run_other";
    const chat = event("asset_delivered", {
      project: "farm",
      source: "genex",
      jobId: "job-9",
      files: [{ file: "assets/genex/job-9/a.png", bytes: 1, kind: "image" }],
      at: "2026-09-05T10:00:00.000Z",
    });
    (chat.data as { payload: Record<string, unknown> }).payload.runId = undefined;
    const graph = buildRunGraph([event("run_started", { goal: "a farm", project: "farm" }), foreign, chat])!;
    assert.equal(
      graph.nodes.some((n) => n.kind === "assets"),
      false,
      "the graph only draws its own run",
    );

    counter = 0;
    // Blender writes both records; the modeller's card is the one that shows it.
    const modelled = buildRunGraph([
      event("run_started", { goal: "a farm", project: "farm", blender: { version: "5.2.1" } }),
      event("blender_asset", {
        name: "barn",
        file: "assets/barn.glb",
        bytes: 100,
        render: "/runs/run_x/blender/barn.png",
        ok: true,
        error: null,
        stats: null,
        at: "2026-09-05T10:00:00.000Z",
      }),
      event("asset_delivered", {
        project: "farm",
        source: "blender",
        jobId: "barn",
        files: [{ file: "assets/barn.glb", bytes: 100, kind: "model" }],
        at: "2026-09-05T10:00:01.000Z",
      }),
    ])!;
    assert.equal(
      modelled.nodes.some((n) => n.kind === "assets"),
      false,
      "no second card for a model the modeller already drew",
    );
    const blender = modelled.nodes.find((n) => n.kind === "blender");
    assert.ok(blender && blender.kind === "blender");
    assert.equal(blender.assets[0]!.source, "blender");
    assert.equal(blender.assets[0]!.state, "delivered");
    assert.deepEqual(blender.assets[0]!.files, ["assets/barn.glb"]);
  });

  it("hangs the assets under the start, and crosses no part's row", () => {
    counter = 0;
    const graph = buildRunGraph([
      event("run_started", { goal: "a farm", project: "farm", blender: { version: "5.2.1" } }),
      event("autopilot_started", { facets, maxParallel: 2 }),
      verdict("buildings", 1, "challenger"),
      verdict("ground", 1, "challenger"),
      event("blender_asset", {
        facetId: "buildings",
        iteration: 1,
        name: "barn",
        file: "assets/barn.glb",
        bytes: 1,
        render: null,
        ok: true,
        error: null,
        stats: null,
      }),
      started("call-1", { facetId: "ground", iteration: 1 }),
      finished("call-1", { facetId: "ground", iteration: 1, jobId: "job-1", files: ["assets/genex/job-1/hay.png"] }),
    ])!;
    const layout = layoutSteps(partRows(graph), { assets: true });
    assert.ok(layout.rects.assets, "the graph places one assets node for the modeller and the plugins");
    assert.equal(layout.rects.assets!.x, layout.rects.start!.x, "the same column as the start");
    assert.ok(
      layout.rects.assets!.x + layout.rects.assets!.w <= STEPS.pad + STEPS.startW + STEPS.busGap,
      "clear of the parts' bus",
    );
    assert.ok(layout.rects.assets!.y >= layout.rects.start!.y + layout.rects.start!.h, "under the start, not over it");
    const entries = Object.entries(layout.rects).filter(([id]) => !id.startsWith("row:"));
    for (const [aId, a] of entries) {
      for (const [bId, b] of entries) {
        if (aId >= bId) continue;
        assert.equal(rectsOverlap(a, b), false, `${aId} overlaps ${bId}`);
      }
    }
    // A dotted thread hangs it off the start: a tool every part reaches for, not a step.
    assert.ok(
      layout.edges.some((edge) => edge.kind === "dotted" && edge.d.endsWith(`V${layout.rects.assets!.y}`)),
      "hung off the start",
    );
  });

  it("reads one field out of the host's arguments digest, and nothing out of a digest without it", () => {
    const digest = "operation=create prompt=a red barn with a weathervane style=painterly count=2";
    assert.equal(digestField(digest, "operation"), "create");
    assert.equal(digestField(digest, "prompt"), "a red barn with a weathervane");
    assert.equal(digestField(digest, "count"), "2");
    assert.equal(digestField(digest, "seed"), null);
    assert.equal(digestField("", "prompt"), null);
    assert.equal(digestField("prompt=", "prompt"), null, "an empty value is no value");
  });
});

it("replays Optimization once, ignores stale/unknown updates, and keeps its result on compact boot closure", () => {
  const result = {
    schemaVersion: 1,
    runId: "run_x",
    project: "game",
    stageId: "optimization",
    sequence: 2,
    phase: "terminal",
    outcome: "no_improvement",
    summary: "No safe gain",
    scenarios: [],
    changedFiles: [],
  };
  const graph = buildRunGraph([
    event("run_started", {}),
    event("optimization_updated", result),
    event("optimization_updated", { ...result, sequence: 1, summary: "stale" }),
    event("optimization_updated", { ...result, schemaVersion: 9, sequence: 3 }),
    event("run_finished", { stoppedBecause: "restart" }),
  ])!;
  const nodes = graph.nodes.filter((n) => n.kind === "optimization");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.result.summary, "No safe gain");
  assert.ok(graph.nodes.findIndex((n) => n.kind === "optimization") < graph.nodes.findIndex((n) => n.kind === "final"));
  const layout = layoutSteps(partRows(graph), { optimization: graph.nodes.some((n) => n.kind === "optimization") });
  assert.ok(layout.rects.optimization);
});

/**
 * A synthetic director run with restarted builders, 21 rounds and twelve merges.
 * It preserves the historical graph regressions without retaining a private run journal.
 */
describe("a synthetic lead run, replayed", () => {
  const journal = JSON.parse(
    readFileSync(new URL("../fixtures/director-loop-run.json", import.meta.url), "utf8"),
  ) as EventEnvelope[];
  const loopRun = () => buildRunGraph(journal)!;

  it("knows it is a lead's run and that it never had a shared base", () => {
    const graph = loopRun();
    assert.equal(graph.runId, "run_fixture123456");
    const run = graph.nodes.find((node) => node.kind === "run");
    assert.equal(run?.kind === "run" && run.director, true);
    assert.equal(
      journal.some((event) => event.data.type === "custom" && event.data.event_type === "autopilot_base"),
      false,
      "the run emitted no base event — the bug's whole cause",
    );
    const base = graph.nodes.find((node) => node.kind === "base");
    assert.equal(base?.kind === "base" && base.absent, true);
    assert.equal(base?.kind === "base" && base.done, true);
    // And it knows it from the moment the run starts, not from the first builder: between
    // 16:11 and 16:24 that run the card pulsed "Building the ground every part starts from…"
    // for a starting point the run was never going to build.
    const atStart = buildRunGraph(
      journal.slice(
        0,
        journal.findIndex((e) => e.data.type === "custom" && e.data.event_type === "autopilot_started") + 1,
      ),
    )!;
    const first = atStart.nodes.find((node) => node.kind === "base");
    assert.equal(atStart.facets.length, 0, "no builder had started yet");
    assert.equal(first?.kind === "base" && first.absent, true);
  });

  it("offers a build only when the run's head moved off the starting commit", () => {
    const finished = journal.at(-1)!;
    const payload = (finished.data as { payload: Record<string, unknown> }).payload;
    assert.equal(hasMergedBuild({ integrationHead: payload.integrationHead as string, baseCommit: null }), true);
    assert.equal(
      hasMergedBuild({ integrationHead: "5719bbb111", baseCommit: "5719bbb111" }),
      false,
      "nothing beyond the starting point",
    );
    assert.equal(hasMergedBuild({ integrationHead: null, baseCommit: "5719bbb111" }), false);
    assert.equal(hasMergedBuild(null), false);
  });

  it("draws a restarted part once: five parts, not ten, with both builders' rounds in a row", () => {
    // Every one of the five parts was stopped and started again that run (crumple → crumple2,
    // …). Nothing in the log said the second was the first one continued, so the Builds page
    // drew ten parts, five of them red with nothing kept — and no morning could read that.
    const asItWas = loopRun();
    assert.equal(asItWas.facets.length, 10, "ten independently named attempts");
    const restarted: Record<string, string> = {
      crumple2: "crumple",
      contact2: "contact",
      cars2: "cars",
      dirt2: "dirt",
      post2: "post",
    };
    const withReplaces: EventEnvelope[] = journal.map((envelope) => {
      const data = envelope.data;
      if (data.type !== "custom" || data.event_type !== "director_worker") return envelope;
      const payload = data.payload as Record<string, unknown>;
      const replaces = restarted[String(payload.workerId)];
      return replaces ? { ...envelope, data: { ...data, payload: { ...payload, replaces } } } : envelope;
    });
    const graph = buildRunGraph(withReplaces)!;
    assert.deepEqual(
      graph.facets.map((facet) => facet.facetId),
      ["crumple", "contact", "cars", "dirt", "post"],
    );
    // Each keeps the name it was started under, not the "(restart)" one.
    assert.deepEqual(
      graph.facets.map((facet) => facet.title),
      asItWas.facets.slice(0, 5).map((facet) => facet.title),
    );

    // The rounds run on rather than colliding: both builders counted from 1, and both are here.
    const crumple = graph.facets.find((facet) => facet.facetId === "crumple")!;
    const rounds = graph.nodes.filter(
      (node): node is IterationNode => node.kind === "iteration" && node.facetId === "crumple",
    );
    assert.deepEqual(
      rounds.map((round) => round.iteration),
      [1, 2, 3, 4],
      "two rounds under each builder, one part",
    );
    assert.equal(crumple.iterations, 4);
    assert.equal(
      crumple.accepted,
      asItWas.facets
        .filter((f) => f.facetId === "crumple" || f.facetId === "crumple2")
        .reduce((sum, f) => sum + f.accepted, 0),
    );
    // The part is not both building and stopped: the attempt ended, the part carried on, and
    // the last word about it is the one the second builder ended on.
    assert.equal(crumple.building, false);
    assert.equal(crumple.satisfied, true, "the restart ran to the end of its brief");
    // Nothing left pointing at a folded builder: every edge in the graph names a node it has.
    const ids = new Set(graph.nodes.map((node) => node.id));
    for (const edge of graph.edges) assert.ok(ids.has(edge.from) && ids.has(edge.to), `${edge.from} → ${edge.to}`);
  });

  it("stops saying it is building a base the moment the first builder starts", () => {
    const upTo = (eventType: string) =>
      journal.slice(0, journal.findIndex((e) => e.data.type === "custom" && e.data.event_type === eventType) + 1);
    const beforeAnyWorker = buildProgress(buildRunGraph(upTo("autopilot_started"))!);
    assert.equal(beforeAnyWorker.title, "Getting started");
    for (const stage of ["director_worker", "facet_build_started", "facet_iteration", "integration_merge"]) {
      const progress = buildProgress(buildRunGraph(upTo(stage))!);
      // The phrases a fall-through to the classic base path would actually produce today — the
      // old "shared base" wording was renamed by the same change, so looking for it proved nothing.
      // Flipped: no time-of-day words in the app's copy.
      assert.doesNotMatch(progress.title, /starting point|Planning the parts/i, stage);
      assert.doesNotMatch(progress.health, /Every part starts from it/i, stage);
      assert.match(progress.title, /part/i, stage);
    }
    // And for the whole run: at no point after the first builder does the base phase come back. Stated as
    // the positive invariant, because every phase this run can reach is one of these.
    const firstWorker = journal.findIndex((e) => e.data.type === "custom" && e.data.event_type === "director_worker");
    for (let at = firstWorker + 1; at < journal.length; at += 1) {
      const progress = buildProgress(buildRunGraph(journal.slice(0, at + 1))!);
      assert.match(progress.title, /part|Between builds|Getting started|Finished|Paused|Stopped/, `event ${at}`);
      assert.doesNotMatch(progress.title, /starting point/i, `event ${at}`);
    }
  });

  it("reports the run in its own words, and says nothing when it never wrote any", () => {
    const finished = journal.at(-1)!;
    assert.equal(finished.data.type === "custom" && finished.data.event_type, "run_finished");
    const payload = (finished.data as { payload: Record<string, unknown> }).payload;
    assert.equal(payload.summary, undefined, "it ran out of time before it wrote one");
    const final = loopRun().nodes.find((node) => node.kind === "final")!;
    // It used to fall back to the last note the lead had left *itself*, so the morning card read
    // "Base fixed and re-based (69f573d): crowd shader now compiles under r185…".
    assert.equal(final.kind === "final" && final.summary, null);
    const notes = payload.notes as Array<{ text: string }>;
    assert.match(notes.at(-1)!.text, /re-based/, "the note that used to be printed as the report");
    // A run that does write one is reported in that instead.
    const spoken = buildRunGraph([
      ...journal.slice(0, -1),
      {
        ...finished,
        data: {
          type: "custom",
          event_type: "run_finished",
          payload: { ...payload, summary: "  Five parts landed; the derby drives.  " },
        },
      },
    ])!;
    const spokenFinal = spoken.nodes.find((node) => node.kind === "final")!;
    assert.equal(spokenFinal.kind === "final" && spokenFinal.summary, "Five parts landed; the derby drives.");
  });

  it("reads the morning off what happened to the build, not off a victory flag", () => {
    const finished = journal.at(-1)!;
    const payload = (finished.data as { payload: Record<string, unknown> }).payload;
    assert.equal(payload.victory, false);
    assert.equal(payload.landed, false, "the fixture has not landed");
    const graph = loopRun();
    const judged = graph.nodes.filter(
      (node) => node.kind === "iteration" && (node.status === "accepted" || node.status === "rolled"),
    ).length;
    assert.equal(judged, 21, "twenty-one judged rounds");
    assert.equal(buildProgress(graph).title, "Finished after 21 rounds · not made live yet");
    const landed = buildRunGraph([
      ...journal.slice(0, -1),
      { ...finished, data: { type: "custom", event_type: "run_finished", payload: { ...payload, landed: true } } },
    ])!;
    assert.equal(buildProgress(landed).title, "Finished after 21 rounds · live in your game");
    const final = landed.nodes.find((node) => node.kind === "final")!;
    assert.equal(final.kind === "final" && final.landed, true);
  });

  it("keeps the newest merged build, so the stage has something to offer", () => {
    const graph = loopRun();
    const merges = journal.filter((e) => e.data.type === "custom" && e.data.event_type === "integration_merge");
    assert.equal(merges.length, 12);
    const lastHead = merges
      .map((e) => (e.data as { payload: { head?: string } }).payload.head)
      .filter(Boolean)
      .at(-1);
    assert.equal(graph.mergedHead?.head, lastHead);
    assert.equal(graph.mergedHead?.healthy, null, "nothing in that run said whether the merge ran");
    // The lead's health pass now says so on the record (M1.9), and a build that did not run is
    // never offered.
    const withHealth = (ok: boolean) =>
      buildRunGraph([
        ...journal,
        {
          ...journal.at(-1)!,
          id: "zzz",
          data: {
            type: "custom",
            event_type: "integration_health",
            payload: { runId: "run_fixture123456", head: lastHead, ok },
          },
        },
      ])!;
    assert.equal(withHealth(true).mergedHead?.healthy, true);
    assert.equal(newBuildOffer(withHealth(false).mergedHead, null), null);
    assert.equal(newBuildOffer(withHealth(true).mergedHead, null)?.head, lastHead);
  });

  it("shows the lead's builders as parts, with the rounds they kept", () => {
    const graph = loopRun();
    assert.ok(graph.facets.length >= 5, `${graph.facets.length} parts`);
    for (const facet of graph.facets) assert.notEqual(facet.title, facet.facetId, "every builder named itself");
    assert.equal(
      graph.facets.reduce((total, facet) => total + facet.accepted, 0),
      10,
      "ten synthetic kept rounds",
    );
  });
});

/**
 * The same run, finished and then reopened by its chat's own session: the same run started again
 * with a fresh half hour and one new worker. Its first close is no longer its last word.
 */
describe("a finished lead run its chat's own session reopens", () => {
  const journal = JSON.parse(
    readFileSync(new URL("../fixtures/director-loop-run.json", import.meta.url), "utf8"),
  ) as EventEnvelope[];
  const runId = "run_fixture123456";
  const registered = journal[0]!.data as { payload: Record<string, unknown> };
  const finished = journal.at(-1)!;
  const closePayload = (finished.data as { payload: Record<string, unknown> }).payload;
  let at = Date.parse(finished.created_at);
  const later = (id: string, eventType: string, payload: Record<string, unknown>): EventEnvelope => {
    at += 1_000;
    return {
      ...finished,
      id: `zz-${id}`,
      created_at: new Date(at).toISOString(),
      data: { type: "custom", event_type: eventType, payload: { runId, ...payload } },
    };
  };
  const budgets = { wallClockMs: 1_800_000 };
  const spokenClose: EventEnvelope = {
    ...finished,
    data: {
      type: "custom",
      event_type: "run_finished",
      payload: { ...closePayload, summary: "Five parts; the derby drives.", landingResult: { verified: true } },
    },
  };
  const reopened = (): EventEnvelope[] => [
    ...journal.slice(0, -1),
    spokenClose,
    later("1", "run_registered", { ...registered.payload, resumed: true, budgets }),
    later("2", "run_started", { ...registered.payload, resumed: true, budgets }),
    later("3", "autopilot_resumed", { project: closePayload.project }),
    later("4", "autopilot_started", { project: closePayload.project, director: true, facets: [] }),
    later("5", "director_worker", { workerId: "pink", title: "Pink sky", mode: "single", state: "running" }),
  ];

  it("is running again, with nothing of the first close left on its final node", () => {
    const before = buildRunGraph([...journal.slice(0, -1), spokenClose])!;
    const closed = before.nodes.find((node) => node.kind === "final")!;
    assert.equal(closed.kind === "final" && closed.summary, "Five parts; the derby drives.", "what the close said");
    assert.ok(before.mergedHead, "the finished run kept its newest merge");
    const graph = buildRunGraph(reopened())!;
    assert.equal(graph.active, true);
    const final = graph.nodes.find((node) => node.kind === "final")!;
    assert.ok(final.kind === "final");
    assert.deepEqual(
      [final.done, final.summary, final.landing, final.integrationHead, final.facets],
      [false, null, null, null, []],
      "the first close is not the reopened run's result",
    );
    const run = graph.nodes.find((node) => node.kind === "run")!;
    assert.ok(run.kind === "run");
    assert.deepEqual([run.finishedAt, run.victory, run.stoppedBecause], [null, null, null]);
    assert.equal(run.durationMs, 1_800_000, "the reopen's own half hour");
    assert.equal(graph.mergedHead, null, "only a merge of the reopened run is new to the stage");
    assert.equal(newBuildOffer(graph.mergedHead, null), null);
    assert.ok(
      graph.facets.some((facet) => facet.facetId === "pink"),
      "its new worker is drawn on the same graph",
    );
  });

  it("names each part once on the final node when it closes again", () => {
    counter = 0;
    const close = (facets: Record<string, unknown>) => event("run_finished", { facets });
    const done = { stoppedBecause: "satisfied", iterations: 1, satisfied: true };
    const graph = buildRunGraph([
      event("run_started", { goal: "g", project: "p" }),
      close({ a: done }),
      event("run_registered", { goal: "g", project: "p", resumed: true }),
      event("run_started", { goal: "g", project: "p", resumed: true }),
      close({ a: done, b: done }),
    ])!;
    const final = graph.nodes.find((node) => node.kind === "final")!;
    assert.deepEqual(final.kind === "final" && final.facets.map((row) => row.facetId), ["a", "b"]);
  });
});

it("gives an ∞ build no duration, so it is never called a 24 h build", () => {
  const graph = buildRunGraph([event("run_started", { budgets: { wallClockMs: 86_400_000, untilSatisfied: true } })]);
  assert.ok(graph);
  assert.equal(graph.nodes.find((node) => node.kind === "run")?.durationMs, undefined);
});

it("a director working without worker rows has a compact, connected input-to-result path", () => {
  const graph = buildRunGraph([
    event("run_started", { budgets: { wallClockMs: 3_600_000 } }),
    event("autopilot_started", { director: true, facets: [] }),
  ])!;
  assert.equal(graph.nodes.find((node) => node.kind === "run")?.durationMs, 3_600_000);
  const layout = layoutSteps(partRows(graph)),
    start = layout.rects.start!,
    final = layout.rects.final!;
  assert.ok(final.x - start.x - start.w <= 80, "no empty worker-sized gap");
  assert.ok(
    layout.edges.some((edge) => edge.d === `M${start.x + start.w} ${start.y + start.h / 2} H${final.x}`),
    "one continuous connector",
  );
});
