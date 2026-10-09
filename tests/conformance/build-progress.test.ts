import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProgress, buildVerdictLine, projectBuildGraph } from "../../src/renderer/build-progress.ts";
import {
  appliesUnseen,
  firstBuildShows,
  laterOf,
  liveBehindOf,
  newBuildOffer,
  type StageWatch,
} from "../../src/renderer/stage.ts";
import { summaryCounts, type RunSummary } from "../../src/shared/run-summary.ts";
import type { EventEnvelope, ConversationRecord } from "../../src/substrate/types.ts";
function event(id: number, type: string, payload: Record<string, unknown> = {}, thread = "parent"): EventEnvelope {
  return {
    id: String(id).padStart(3, "0"),
    thread_id: thread,
    session_id: null,
    turn_id: null,
    created_at: `2026-09-04T21:00:0${id}Z`,
    data: { type: "custom", event_type: type, payload: { runId: "run_x", ...payload } },
  };
}
const start = [
  event(1, "run_started", { engine: "codex", model: "gpt-6-astra" }),
  event(2, "autopilot_started", { maxParallel: 5, facets: [{ id: "river", title: "River", budgetShare: 1 }] }),
];
const worker: ConversationRecord = {
  id: "child",
  agent_id: "studio",
  created_at: "",
  updated_at: "",
  latest_event_id: null,
  title: "run_x · River",
};
test("base opens before a verdict or screenshot exists", () => {
  const graph = projectBuildGraph(start, "parent", [], "/runs")!;
  assert.equal(graph.runDir, "/runs/run_x");
  assert.equal(buildProgress(graph).nodeId, "base");
  assert.match(buildProgress(graph).title, /starting point/);
  assert.match(buildProgress(graph).health, /1 part waiting/);
});
test("first native worker activity appears before first-round judgment in old logs", () => {
  const graph = projectBuildGraph(
    [
      ...start,
      event(3, "autopilot_base", { ok: false, error: "identical cameras" }),
      event(4, "delegated.codex", { kind: "system" }, "child"),
    ],
    "parent",
    [worker],
    "/runs",
  )!;
  assert.equal(buildProgress(graph).nodeId, "iter:river:1");
  // What the checks saw is the starting point's own detail, not an unattributed sentence bolted
  // onto the line that says how this run is going.
  assert.doesNotMatch(buildProgress(graph).health, /identical cameras/);
  assert.match(buildProgress(graph).health, /empty game/);
  assert.doesNotMatch(buildProgress(graph).health, /scaffold/);
  assert.match(buildProgress(graph).title, /1 part/);
});
test("another conversation cannot change the selected run", () => {
  assert.equal(
    projectBuildGraph([...start, event(9, "run_started", { runId: "unrelated" }, "other")], "parent", [], null)?.runId,
    "run_x",
  );
  assert.equal(projectBuildGraph(start, null, [], null), null);
});
test("native start and recovered old start cannot overwrite a recorded verdict", () => {
  const graph = projectBuildGraph(
    [
      ...start,
      event(3, "autopilot_base", { ok: true }),
      event(4, "delegated.codex", {}, "child"),
      event(5, "facet_build_started", { facetId: "river", iteration: 1 }),
      event(6, "facet_iteration", { facetId: "river", iteration: 1, winner: "challenger" }),
      event(7, "run_finished", { victory: true }),
    ],
    "parent",
    [worker],
    null,
  )!;
  assert.equal(graph.nodes.filter((n) => n.kind === "iteration").length, 1);
  assert.equal(graph.nodes.find((n) => n.kind === "iteration")?.status, "accepted");
  assert.equal(buildProgress(graph).nodeId, "final");
});
test("while the run is going, the header says what the outcome card says: the recorded summary", () => {
  const graph = projectBuildGraph(
    [
      ...start,
      event(3, "autopilot_base", { ok: true }),
      event(4, "facet_build_started", { facetId: "river", iteration: 1 }),
    ],
    "parent",
    [],
    null,
  )!;
  assert.equal(graph.active, true);
  // Without a summary the classic wording stands.
  assert.match(buildProgress(graph).title, /1 part building/);
  const summary: RunSummary = {
    runId: "run_x",
    project: "game",
    completeHistory: true,
    execution: "running",
    reason: null,
    landed: null,
    deliveredHead: null,
    deliveredSourceHead: null,
    head: null,
    base: null,
    tasks: [
      {
        id: "river",
        title: "River",
        workers: ["river"],
        state: "running",
        integrations: 0,
        attempts: [],
        reason: null,
      },
    ],
    evidence: [],
    counts: {
      integrations: 0,
      accepted: 0,
      rejected: 0,
      stopped: 0,
      failed: 0,
      superseded: 0,
      running: 1,
      queued: 0,
      completedUnevaluated: 0,
    },
    learning: null,
  };
  const progress = buildProgress({ ...graph, summary });
  assert.equal(progress.nodeId, "iter:river:1", "the focus node still comes from the graph");
  assert.match(progress.title, /1 part building/, "the graph keeps its own words for what is happening");
  assert.ok(progress.health.endsWith(` · ${summaryCounts(summary)}`), "the counts are the outcome card's counts");
  assert.match(progress.health, /1 running/);
});
test("an empty base is reported as infrastructure, not a validated game", () => {
  const graph = projectBuildGraph(
    [...start, event(3, "autopilot_base", { ok: true, empty: true })],
    "parent",
    [],
    null,
  )!;
  assert.match(buildProgress(graph).health, /no scenery or gameplay yet/);
});

test("the final Optimization stage does not announce another creative build", async () => {
  const { emptyOptimization } = await import("../../src/harness-seed/loop/optimization.ts");
  const result = { ...emptyOptimization({ runId: "run_x", project: "game" }), phase: "profiling_candidate" };
  const graph = projectBuildGraph(
    [...start, event(3, "autopilot_base", { ok: true }), event(4, "optimization_updated", result)],
    "parent",
    [],
    null,
  )!;
  assert.equal(buildProgress(graph).nodeId, "optimization");
  assert.equal(buildProgress(graph).title, "Optimization");
  assert.match(buildProgress(graph).health, /safe improvements/);
});

test("an earlier build retains its rounds after an empty replacement run", () => {
  const events = [
    ...start,
    event(3, "facet_iteration", { facetId: "river", iteration: 1, winner: "challenger" }),
    event(4, "run_finished", {}),
    event(5, "run_started", { runId: "replacement" }),
    event(6, "run_finished", { runId: "replacement" }),
  ];
  assert.equal(projectBuildGraph(events, "parent", [], "/runs")?.runId, "replacement");
  const previous = projectBuildGraph(events, "parent", [], "/runs", "run_x")!;
  assert.equal(previous.runId, "run_x");
  assert.equal(previous.nodes.filter((n) => n.kind === "iteration").length, 1);
  assert.equal(previous.runDir, "/runs/run_x");
});

// ── a lead's run (M1.9) ───────────────────────────────────────────────────────────────────
// It has no shared-base stage, so the phase has to be read off its builders instead. The first
// real director run reported "Building the shared base · Checks pending" from dusk to dawn.

const leadStart = [
  event(1, "run_started", { engine: "claude-code", goal: "a demolition derby" }),
  event(2, "autopilot_started", { maxParallel: 5, facets: [], director: true }),
];
const worker_ = (id: number, workerId: string, state: string, extra: Record<string, unknown> = {}) =>
  event(id, "director_worker", { workerId, title: `${workerId} work`, mode: "loop", state, ...extra });

test("a lead run with no builders yet says it is getting started, not building a base", () => {
  const progress = buildProgress(projectBuildGraph(leadStart, "parent", [], "/runs")!);
  assert.equal(progress.nodeId, "base");
  assert.equal(progress.title, "Getting started");
  assert.doesNotMatch(progress.title, /base/i);
  // Flipped: no time-of-day words in the app's copy.
  assert.match(progress.health, /deciding what this build needs/);
});

test("once a builder starts, the lead run counts parts — never a base", () => {
  const graph = projectBuildGraph(
    [...leadStart, worker_(3, "crumple", "running"), worker_(4, "dirt", "running")],
    "parent",
    [],
    "/runs",
  )!;
  const base = graph.nodes.find((n) => n.kind === "base")!;
  assert.equal(base.kind === "base" && base.absent, true, "no shared base was ever built");
  assert.equal(base.kind === "base" && base.done, true, "so the card must stop pulsing");
  const progress = buildProgress(graph);
  assert.equal(progress.title, "2 parts building");
  assert.match(progress.health, /Nothing kept yet/);
});

test("a lead run counts the rounds its builders kept", () => {
  const graph = projectBuildGraph(
    [
      ...leadStart,
      worker_(3, "crumple", "running"),
      event(4, "facet_iteration", { facetId: "crumple", iteration: 1, winner: "challenger", verdictSource: "checks" }),
      event(5, "facet_iteration", {
        facetId: "crumple",
        iteration: 2,
        winner: "incumbent",
        verdictSource: "invisible",
      }),
      worker_(6, "dirt", "stopped", { stoppedBecause: "the work it was given is done" }),
    ],
    "parent",
    [],
    "/runs",
  )!;
  const progress = buildProgress(graph);
  assert.equal(progress.title, "1 part building");
  assert.match(progress.health, /1 round kept so far/);
  assert.match(progress.health, /1 finished/);
});

test("a builder that ran to the end reads as done, not stopped", () => {
  const graph = projectBuildGraph(
    [
      ...leadStart,
      worker_(3, "river", "running"),
      worker_(4, "river", "done", { stoppedBecause: "the work it was given is done" }),
      worker_(5, "cottages", "stopped", { stoppedBecause: "stopped by the director: it was going nowhere" }),
    ],
    "parent",
    [],
    "/runs",
  )!;
  const river = graph.facets.find((f) => f.facetId === "river")!;
  const cottages = graph.facets.find((f) => f.facetId === "cottages")!;
  assert.equal(river.satisfied, true);
  assert.equal(cottages.satisfied, null, "the lead ended that one early — nobody said it was done");
});

test("a lead run between builders says the lead is deciding, not that a base is missing", () => {
  const graph = projectBuildGraph(
    [...leadStart, worker_(3, "crumple", "stopped", { stoppedBecause: "done" })],
    "parent",
    [],
    "/runs",
  )!;
  assert.equal(buildProgress(graph).title, "Between builds");
  assert.match(buildProgress(graph).health, /deciding what comes next/);
});

test("a lead run that built a starting point still shows one", () => {
  const graph = projectBuildGraph(
    [...leadStart, event(3, "autopilot_base", { ok: true, commit: "abc", empty: true })],
    "parent",
    [],
    "/runs",
  )!;
  const base = graph.nodes.find((n) => n.kind === "base")!;
  assert.equal(base.kind === "base" && base.absent, false);
  assert.equal(buildProgress(graph).title, "The starting point is ready");
});

test("a finished run reads off what happened to the build, not off a victory flag", () => {
  const of = (payload: Record<string, unknown>) =>
    buildProgress(
      projectBuildGraph(
        [
          ...leadStart,
          worker_(3, "crumple", "running"),
          event(4, "facet_iteration", { facetId: "crumple", iteration: 1, winner: "challenger" }),
          event(5, "run_finished", payload),
        ],
        "parent",
        [],
        "/runs",
      )!,
    );
  assert.equal(of({ victory: false, landed: true }).title, "Finished after 1 round · live in your game");
  // "not made live yet" is only true of a run that merged something: the head has to have moved.
  assert.equal(
    of({
      victory: false,
      landed: false,
      stoppedBecause: "land=no",
      integrationHead: "aaa1b2c3d4",
      baseCommit: "5719bbb111",
    }).title,
    "Finished after 1 round · not made live yet",
  );
  // Flipped: no time-of-day words in the app's copy.
  assert.equal(
    of({ victory: false, landed: false, stoppedBecause: "land=no" }).title,
    "Finished after 1 round · nothing new",
  );
  assert.doesNotMatch(of({ victory: false, landed: false, stoppedBecause: "land=no" }).health, /playable/);
  assert.equal(of({ victory: false }).title, "Finished after 1 round");
});

test("a run the engine\u2019s limit paused is never called finished", () => {
  // The limit ends the run with run_finished immediately followed by autopilot_paused; the
  // Builds header used to read "Finished after 1 round \u00b7 not made live yet" over a run the
  // user could have resumed.
  const paused = projectBuildGraph(
    [
      ...leadStart,
      worker_(3, "crumple", "running"),
      event(4, "facet_iteration", { facetId: "crumple", iteration: 1, winner: "challenger" }),
      event(5, "run_finished", {
        landed: false,
        stoppedBecause:
          "the engine hit its session limit before the director called finish (429); the run is paused \u2014 Resume it when the limit resets; nothing was landed (land=no)",
      }),
      event(6, "autopilot_paused", {}),
    ],
    "parent",
    [],
    "/runs",
  )!;
  assert.match(buildProgress(paused).title, /^Paused after 1 round/);
  assert.match(buildProgress(paused).health, /pick up again/);
  assert.doesNotMatch(buildProgress(paused).title, /Finished/);
});

// ── the stage's own rules ───────────────────────────────────────────────────────────────────

test("a merged build is offered once, and only when something says it runs", () => {
  assert.equal(newBuildOffer(null, null), null);
  assert.deepEqual(newBuildOffer({ head: "aaa", at: "2026-09-07T23:32:00Z", healthy: true }, null), {
    head: "aaa",
    at: "2026-09-07T23:32:00Z",
    healthy: true,
  });
  // Nobody has looked yet: still offered — the user can always choose to look.
  assert.equal(newBuildOffer({ head: "aaa", at: "x", healthy: null }, null)?.head, "aaa");
  // It did not run: never offered.
  assert.equal(newBuildOffer({ head: "aaa", at: "x", healthy: false }, null), null);
  // Already on the stage: nothing to offer.
  assert.equal(newBuildOffer({ head: "aaa", at: "x", healthy: true }, "aaa"), null);
});

/**
 * Reload stayed lit after the person played the run's build from Builds, the morning card or a
 * review: those call main directly, and the stage only knew what its own Play had shown. Main now
 * says which build Live shows (`live.behind` `shows`), by full hash where a record may abbreviate.
 */
test("a build Live already shows is not offered, however it got there and however it is spelt", () => {
  const head = "0123456789abcdef0123456789abcdef01234567";
  const merged = { head, at: "x", healthy: true };
  assert.equal(newBuildOffer(merged, head), null, "main's own word, the full hash");
  assert.equal(newBuildOffer({ ...merged, head: head.slice(0, 10) }, head), null, "a record's short hash");
  assert.equal(newBuildOffer(merged, head.slice(0, 7)), null);
  assert.equal(newBuildOffer(merged, head.slice(0, 6))?.head, head, "too short to name a commit");
  assert.equal(newBuildOffer(merged, "0123456789abcdef0000")?.head, head, "another commit");
  assert.equal(newBuildOffer(merged, null)?.head, head, "Live shows the game folder");
});

test("the stage's mount read of Live never undoes an event main sent while it was asked", () => {
  const read = { project: "pong", reason: "changed" as const, commit: null, note: null, shows: null };
  const newer = { ...read, reason: null, shows: "0123456789abcdef" };
  assert.deepEqual(laterOf(null, read, false), read, "a stage that reloaded learns what waits");
  assert.deepEqual(laterOf(newer, read, true), newer, "the event came after the question");
  assert.equal(laterOf(null, read, true), null);
});

/**
 * Live never changes while the person watches it: the game does not update on its own, and only
 * Reload is highlighted, with a changed tooltip.
 * Reload names what it would bring: what main holds first, then a healthy build of the run,
 * then the way back from a build found broken.
 */
test("Reload offers what waits for Live, main's change first", () => {
  const healthy = { head: "bbb", at: "x", healthy: true };
  const held = { project: "pong", reason: "changed" as const, commit: null, note: "added the jump", shows: null };
  assert.equal(liveBehindOf({ waiting: null, offer: null, shownBroken: false }), null);
  assert.deepEqual(liveBehindOf({ waiting: held, offer: healthy, shownBroken: true }), {
    reason: "changed",
    note: "added the jump",
    head: null,
    held: true,
  });
  assert.deepEqual(liveBehindOf({ waiting: null, offer: healthy, shownBroken: false }), {
    reason: "build",
    note: null,
    head: "bbb",
    held: false,
  });
  // A merge nobody has confirmed runs is on the Builds graph, not offered on Live's Reload.
  assert.equal(liveBehindOf({ waiting: null, offer: { ...healthy, healthy: null }, shownBroken: false }), null);
  assert.equal(liveBehindOf({ waiting: null, offer: null, shownBroken: true })?.reason, "broken");
  // Main saying Live is current again (`reason: null`) is not a change.
  assert.equal(liveBehindOf({ waiting: { ...held, reason: null }, offer: null, shownBroken: false }), null);
});

test("nothing goes into Live on its own while someone is watching a game in it", () => {
  const watching: StageWatch = { view: "live", visible: true, showEmpty: false };
  const held = { reason: "changed" as const, note: null, head: null, held: true };
  const build = { reason: "build" as const, note: null, head: "bbb", held: false };
  const broken = { reason: "broken" as const, note: null, head: null, held: false };
  for (const behind of [held, build, broken]) assert.equal(appliesUnseen(behind, watching), false, behind.reason);
  // Out of sight — another tab, Studio, the empty scaffold's placeholder — what main holds and the
  // way back from a broken build go in, so Live is current when they come back.
  for (const stage of [
    { ...watching, view: "builds" as const },
    { ...watching, visible: false },
    { ...watching, showEmpty: true },
  ]) {
    assert.equal(appliesUnseen(held, stage), true, JSON.stringify(stage));
    assert.equal(appliesUnseen(broken, stage), true, JSON.stringify(stage));
    // A run's newest build is never swapped in unasked: it waits for Reload, Play or Play latest.
    assert.equal(appliesUnseen(build, stage), false, JSON.stringify(stage));
  }
  assert.equal(appliesUnseen(null, { ...watching, view: "builds" }), false);
});

test("only the empty scaffold takes the run's first healthy build by itself", () => {
  const offer = { head: "aaa", at: "x", healthy: true };
  const empty: StageWatch = { view: "live", visible: true, showEmpty: true };
  assert.equal(firstBuildShows(offer, empty), true);
  assert.equal(firstBuildShows(offer, { ...empty, showEmpty: false }), false, "a game is on the stage");
  assert.equal(firstBuildShows({ ...offer, healthy: null }, empty), false, "nothing has confirmed it runs");
  assert.equal(firstBuildShows(offer, { ...empty, view: "builds" }), false);
  assert.equal(firstBuildShows(null, empty), false);
});

test("the sentence over the build carries no id, sha or ref out of the record", () => {
  // The lead composes this sentence itself, out of the run's own material — a builder's title
  // among it — so the drawer reads it through words.ts like every other phrase.
  const graph = projectBuildGraph(
    [
      ...start,
      event(3, "director_verdict", {
        pass: "judge",
        because: "The judge preferred it to what run_x built at 5719bbb111 on refs/studio/runs/run_x/integration.",
      }),
    ],
    "parent",
    [],
    null,
  )!;
  const line = buildVerdictLine(graph)!;
  assert.match(line, /^The reviewer preferred it to what built/);
  assert.doesNotMatch(line, /run_x|5719bbb111|refs\//);
  assert.equal(buildVerdictLine(projectBuildGraph(start, "parent", [], null)!), null);
});

test("single-session worker completion cannot be overwritten by an inferred first round", () => {
  const events = [
    event(1, "run_started", { engine: "codex", model: "sonnet", builderEngine: "claude-code" }),
    event(2, "autopilot_started", { director: true, facets: [] }),
    event(3, "director_worker", { workerId: "river", title: "River", mode: "single", state: "running" }),
    event(4, "delegated.claude-code", { kind: "system" }, "child"),
  ];
  const running = projectBuildGraph(events, "parent", [worker], "/runs")!;
  assert.equal(running.facets[0]!.building, true);
  assert.equal(running.nodes.filter((n) => n.kind === "iteration").length, 0);
  const done = projectBuildGraph(
    [
      ...events,
      event(5, "director_worker", {
        workerId: "river",
        title: "River",
        mode: "single",
        state: "done",
      }),
    ],
    "parent",
    [worker],
    "/runs",
  )!;
  assert.equal(done.facets[0]!.building, false);
  assert.equal(done.facets[0]!.satisfied, true);
  assert.equal(buildProgress(done).title, "Between builds");
});
