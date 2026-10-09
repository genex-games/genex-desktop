/**
 * Steps — what the Builds graph draws. Tries fold into steps, a step's state comes from the build
 * before the judges, the judges show as gates, and the layout keeps what landed on the line.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventEnvelope } from "../../src/substrate/types.ts";
import { summarizeRun } from "../../src/shared/run-summary.ts";
import { buildRunGraph, IterationStatus, rectsOverlap } from "../../src/renderer/run-graph.ts";
import { TRY_WORD } from "../../src/renderer/round-status.ts";
import {
  askedRest,
  budgetWords,
  buildReview,
  capWords,
  checkingBuild,
  foldTries,
  frontier,
  headline,
  judgesOn,
  layoutSteps,
  leadStopped,
  leadWorking,
  partRows,
  readyToPlay,
  resultGate,
  resultStatus,
  rowMeta,
  statusLine,
  stepPill,
  stepSentence,
  stepWord,
  STEPS,
  triesWord,
  workedShortWords,
  workerStopWords,
} from "../../src/renderer/run-steps.ts";
import type { WorkerInfo } from "../../src/renderer/run-graph-workers.ts";
import { WorkerEnd, WorkerStopCode } from "../../src/shared/workers.ts";
import { sideBySideWords } from "../../src/renderer/words.ts";
const START = Date.parse("2026-09-19T15:36:00.000Z");
let minute = 0;
function event(eventType: string, payload: Record<string, unknown>, runId = "run_ice"): EventEnvelope {
  minute += 1;
  return {
    id: `e${String(minute).padStart(4, "0")}`,
    thread_id: "t",
    session_id: null,
    turn_id: null,
    created_at: new Date(START + minute * 60_000).toISOString(),
    data: { type: "custom", event_type: eventType, payload: { runId, project: "ice", ...payload } },
  };
}

const move = (facetId: string, iteration: number, what: string, milestoneId: string) =>
  event("facet_move", {
    facetId,
    facetTitle: "Frozen landscape",
    iteration,
    what,
    milestoneId,
    source: "milestone",
    delivered: null,
    scale: null,
  });
const judged = (
  facetId: string,
  iteration: number,
  winner: "challenger" | "incumbent",
  extra: Record<string, unknown> = {},
) =>
  event("facet_iteration", {
    facetId,
    facetTitle: "Frozen landscape",
    iteration,
    winner,
    satisfied: false,
    verdictSource: winner === "challenger" ? "checks" : "invisible",
    reason: winner === "challenger" ? "checks accepted" : "no change",
    biggest_gap: winner === "challenger" ? "" : "There is still no single tall mountain behind the sword",
    defects: [],
    unmeasured: [],
    scoreboard: { total: 5, passing: 5, unmeasured: 0, flips: [], regressions: [], results: [] },
    shots: [{ camera: "default", path: `/runs/run_ice/${facetId}/${iteration}/default.jpg`, bytes: 10 }],
    flags: [],
    diffs: {},
    ...extra,
  });

/** The tester's run: a lead's run with a helper that retried two steps and one single session. */
function loopRun({ finished = true }: { finished?: boolean } = {}): EventEnvelope[] {
  minute = 0;
  const events = [
    event("run_started", { goal: "A sword in ice", mode: "director" }),
    event("autopilot_started", { director: true, facets: [], maxParallel: 2 }),
    event("director_worker", { workerId: "sword", title: "Sword, ice and light", state: "running", mode: "single" }),
    event("director_worker", { workerId: "land", title: "Frozen landscape", state: "running", mode: "loop" }),
    event("facet_build_started", { facetId: "land", facetTitle: "Frozen landscape", iteration: 1 }),
    judged("land", 1, "challenger"),
    move("land", 2, "Natural shore: drifts creep onto the ice with no hard seam", "shore"),
    judged("land", 2, "incumbent"),
    move("land", 3, "Natural shore: drifts creep onto the ice with no hard seam", "shore"),
    judged("land", 3, "challenger"),
    event("integration_merge", { facetId: "land", head: "h1", commit: "c1", conflict: false, stage: "director" }),
    event("director_worker", { workerId: "sword", title: "Sword, ice and light", state: "done", mode: "single" }),
    event("integration_merge", { facetId: "sword", head: "h2", commit: "c2", conflict: false, stage: "director" }),
    event("integration_health", { head: "h2", ok: true, problems: [] }),
    move("land", 4, "Tall mountain: a blue-grey mass behind the sword", "mountain"),
    judged("land", 4, "incumbent"),
    move("land", 5, "Tall mountain: a blue-grey mass behind the sword", "mountain"),
  ];
  if (!finished) return events;
  return [
    ...events,
    event("facet_iteration", {
      facetId: "land",
      facetTitle: "Frozen landscape",
      iteration: 5,
      winner: null,
      satisfied: false,
      verdictSource: "stopped",
      reason: "stopped by the director: the loop kept re-judging the mountain",
      shots: [],
      flags: [],
      diffs: {},
    }),
    event("run_finished", {
      landed: true,
      integrationHead: "h2",
      baseCommit: "base",
      stoppedBecause: "the director finished the run",
    }),
  ];
}

function rowsOf(events: EventEnvelope[]) {
  const graph = buildRunGraph(events)!;
  const summary = summarizeRun(events, "ice", graph.runId);
  graph.summary = summary;
  return { graph, summary, rows: partRows(graph, summary) };
}

describe("tries fold into steps", () => {
  it("groups the tries at one step and ends the group at the try the judges kept", () => {
    const { rows } = rowsOf(loopRun());
    const land = rows.find((row) => row.facet.facetId === "land")!;
    assert.deepEqual(
      land.steps.map((step) => [step.name, step.tries.map((node) => node.iteration)]),
      [
        ["First build", [1]],
        ["Natural shore", [2, 3]],
        ["Tall mountain", [4, 5]],
      ],
    );
    const shore = land.steps[1]!;
    assert.equal(shore.shown?.iteration, 3, "the node shows the kept try");
    assert.equal(stepWord(shore, false), "Added", "the chat's word for a merged part");
    assert.equal(triesWord(shore), "2 tries");
  });

  it("starts a new step after a kept try even when the builder is asked the same thing", () => {
    const { graph } = rowsOf(loopRun());
    const rounds = graph.nodes.filter((node) => node.kind === "iteration" && node.facetId === "land");
    assert.equal(foldTries(rounds as never).length, 3);
  });

  it("names a step by the first clause of what it was asked", () => {
    assert.equal(
      headline("Add a wreck-lifecycle system: once a car's total crumple crosses a threshold"),
      "Add a wreck-lifecycle system",
    );
    assert.equal(headline("[defect-x] make the hay less plastic"), "Make the hay less plastic");
  });
});

describe("a step's state comes from the build first, the judges second", () => {
  it("draws the kept steps on the line, the undone one below it, and says who stopped the last try", () => {
    const { graph, rows } = rowsOf(loopRun());
    const land = rows.find((row) => row.facet.facetId === "land")!;
    assert.deepEqual(
      land.steps.map((step) => [step.state, step.onLine, step.gate]),
      [
        ["in-build", true, "kept"],
        ["in-build", true, "kept"],
        ["undone", false, "undone"],
      ],
    );
    const mountain = land.steps[2]!;
    assert.equal(stepWord(mountain, graph.active), "Undone");
    assert.equal(stepSentence(mountain, graph.active), "The reviewers undid one try. The lead stopped the second.");
    assert.equal(rowMeta(land, graph.active), "2 of 3 added");
    assert.equal(mountain.shown?.iteration, 4, "the node shows the last try that saved a picture");
    assert.equal(
      leadStopped(mountain.tries[1]!),
      "the loop kept re-judging the mountain",
      "who stopped it is said once",
    );
    assert.equal(askedRest(mountain), "A blue-grey mass behind the sword", "the panel does not repeat the node's name");
  });

  it("calls an unjudged round the lead merged in build, checked by the lead — never 'never judged'", () => {
    minute = 0;
    const events = [
      event("run_started", { goal: "A sword in ice", mode: "director" }),
      event("autopilot_started", { director: true, facets: [], maxParallel: 4 }),
      event("director_worker", { workerId: "sky", title: "Sky and fog", state: "running", mode: "loop" }),
      event("facet_build_started", { facetId: "sky", facetTitle: "Sky and fog", iteration: 1 }),
      event("integration_merge", { facetId: "sky", head: "h1", commit: "c1", conflict: false, stage: "director" }),
      event("run_finished", { landed: true, integrationHead: "h1", baseCommit: "base" }),
    ];
    const { graph, rows } = rowsOf(events);
    const [step] = rows[0]!.steps;
    assert.equal(
      graph.nodes.find((node) => node.kind === "iteration")?.status,
      "abandoned",
      "the round itself was never judged",
    );
    assert.equal(step!.state, "in-build");
    assert.equal(step!.checkedBy, "lead");
    assert.equal(step!.gate, null, "no eye: no judge looked at it");
    assert.equal(stepWord(step!, false), "Added");
    assert.match(stepSentence(step!, false), /the lead merged the part's work/);
  });

  it("keeps an unjudged, unmerged round out of the build without blaming a setting", () => {
    minute = 0;
    const { rows } = rowsOf([
      event("run_started", { goal: "g", mode: "director" }),
      event("autopilot_started", { director: true, facets: [] }),
      event("director_worker", { workerId: "sky", title: "Sky", state: "running", mode: "loop" }),
      event("facet_build_started", { facetId: "sky", facetTitle: "Sky", iteration: 1 }),
      event("run_finished", { landed: false }),
    ]);
    const [step] = rows[0]!.steps;
    assert.equal(step!.state, "not-in-build");
    assert.equal(stepWord(step!, false), "Left out");
    assert.equal(stepSentence(step!, false), "The run ended before the reviewers saw it.");
  });

  it("does not credit a lead's merge with a round started after the kept one it took", () => {
    minute = 0;
    const { rows } = rowsOf([
      event("run_started", { goal: "g", mode: "director" }),
      event("autopilot_started", { director: true, facets: [] }),
      event("director_worker", { workerId: "land", title: "Land", state: "running", mode: "loop" }),
      judged("land", 1, "challenger"),
      event("facet_build_started", { facetId: "land", facetTitle: "Land", iteration: 2 }),
      event("integration_merge", { facetId: "land", head: "h1", commit: "c1", conflict: false, stage: "director" }),
      event("run_finished", { landed: true, integrationHead: "h1", baseCommit: "base" }),
    ]);
    assert.deepEqual(
      rows[0]!.steps.map((step) => step.state),
      ["in-build", "not-in-build"],
    );
  });

  it("shows a single-session part as one node, with an eye only when a judge compared its build", () => {
    const { rows } = rowsOf(loopRun());
    const sword = rows.find((row) => row.facet.facetId === "sword")!;
    assert.equal(sword.steps.length, 1);
    assert.deepEqual(
      [sword.steps[0]!.session, sword.steps[0]!.state, sword.steps[0]!.checkedBy, sword.steps[0]!.gate],
      [true, "in-build", "lead", null],
    );
    assert.equal(rowMeta(sword, false), "", "its node says it all");
    const events = loopRun();
    events.splice(
      events.length - 1,
      0,
      event("director_verdict", {
        pass: "judge",
        build: { head: "h2", worker: "sword", round: null },
        seen: { pick: "challenger" },
        decision: { kept: true, rule: "judge" },
        because: "Kept: the judge preferred the sword to the empty lake.",
      }),
    );
    const judgedSword = rowsOf(events).rows.find((row) => row.facet.facetId === "sword")!.steps[0]!;
    assert.deepEqual([judgedSword.checkedBy, judgedSword.gate], ["judges", "kept"]);
  });
});

describe("while the run goes on", () => {
  it("hangs the work in hand below the line and names the judges looking at it", () => {
    const events = loopRun({ finished: false });
    events.push(
      event("facet_liveness", {
        facetId: "land",
        facetTitle: "Frozen landscape",
        iteration: 5,
        critic: "place",
        total: 12,
        max: 18,
      }),
    );
    const { graph, summary, rows } = rowsOf(events);
    const mountain = rows.find((row) => row.facet.facetId === "land")!.steps[2]!;
    assert.deepEqual([mountain.state, mountain.onLine, mountain.gate], ["judging", false, "looking"]);
    assert.equal(frontier(rows)?.id, mountain.id);
    const line = statusLine(graph, summary, rows, START + 39 * 60_000);
    assert.equal(line.tone, "live");
    assert.equal(line.strong, "Checking · 38 min");
    assert.equal(line.rest, "the reviewers are looking at try 2 of tall mountain");
    assert.equal(resultGate(graph), null, "no grey eye on a build that is still being made");
  });
});

describe("the status line", () => {
  it("says the build is live and which steps did not land", () => {
    const { graph, summary, rows } = rowsOf(loopRun());
    assert.deepEqual(statusLine(graph, summary, rows), {
      tone: "green",
      strong: "Live in your game · 17 min",
      rest: "all but tall mountain landed",
    });
  });

  it("keeps failed checks in the line instead of the good news", () => {
    const events = loopRun();
    events.splice(
      events.length - 1,
      0,
      event("run_visual_evidence", { head: "h2", question: "Is there a tall mountain?", answer: false }),
    );
    const { graph, summary, rows } = rowsOf(events);
    const line = statusLine(graph, summary, rows);
    assert.equal(line.tone, "orange");
    assert.equal(line.rest, "1 check failed");
  });

  it("says the status is unavailable when the summary cannot tell how the run closed", () => {
    const { graph, summary, rows } = rowsOf(loopRun());
    assert.deepEqual(statusLine(graph, { ...summary!, execution: "unknown" }, rows), {
      tone: "muted",
      strong: "Status unavailable · 17 min",
      rest: "the run's record is incomplete",
    });
  });

  it("gives a build made live on health alone the grey eye", () => {
    const { graph } = rowsOf(loopRun());
    assert.equal(resultGate(graph), "waiting");
  });
});

describe("the layout", () => {
  it("puts what landed on the line, hangs the rest below its anchor, and overlaps nothing", () => {
    const { rows } = rowsOf(loopRun());
    const layout = layoutSteps(rows, { resultGate: "waiting" });
    const boxes = Object.entries(layout.rects).filter(([id]) => !id.startsWith("row:"));
    for (const [a, ra] of boxes)
      for (const [b, rb] of boxes) if (a < b) assert.equal(rectsOverlap(ra, rb), false, `${a} overlaps ${b}`);
    const land = rows.find((row) => row.facet.facetId === "land")!;
    const [first, shore, mountain] = land.steps.map((step) => layout.rects[step.id]!);
    assert.equal(shore!.x - first!.x, STEPS.pitch, "the kept steps run left to right");
    assert.equal(shore!.y, first!.y, "on one line");
    assert.equal(mountain!.x, shore!.x, "the undone step hangs under the step it followed");
    assert.equal(mountain!.y, shore!.y + STEPS.nodeH + STEPS.hangGap);
    assert.ok(layout.ghosts.has(land.steps[2]!.id));
    assert.equal(layout.rects["row:sword"], undefined, "a part built in one session is its node: no label over it");
    assert.ok(layout.rects["row:land"], "a part with steps keeps its label");
    for (const [id, rect] of boxes)
      if (id !== "assets") assert.deepEqual([rect.w, rect.h], [STEPS.nodeW, STEPS.nodeH], `${id} is the one node size`);
    const start = layout.rects.start!,
      final = layout.rects.final!;
    assert.equal(start.y + start.h / 2, final.y + final.h / 2, "the start and the result share the middle");
    assert.ok(
      final.x >
        Math.max(
          ...boxes
            .filter(([id]) => id.startsWith("step:") || id.startsWith("session:"))
            .map(([, rect]) => rect.x + rect.w),
        ),
    );
    // Gates: one on the way into each kept step, one on top of the hanging step, one before the result.
    assert.deepEqual(layout.gates.map((gate) => gate.gate).sort(), ["kept", "kept", "undone", "waiting"]);
    const hang = layout.gates.find((gate) => gate.gate === "undone")!;
    assert.deepEqual([hang.x, hang.y], [mountain!.x + STEPS.nodeW / 2, mountain!.y]);
  });

  it("keeps a part with nothing in the build on its row, ghosted, and never joins it to the result", () => {
    minute = 0;
    const { rows } = rowsOf([
      event("run_started", { goal: "g", mode: "director" }),
      event("autopilot_started", { director: true, facets: [] }),
      event("director_worker", { workerId: "sky", title: "Sky", state: "running", mode: "loop" }),
      judged("sky", 1, "incumbent"),
      event("run_finished", { landed: false }),
    ]);
    const layout = layoutSteps(rows);
    const [step] = rows[0]!.steps;
    assert.equal(layout.rects[step!.id]!.y, layout.rects["row:sky"]!.y + STEPS.labelH, "on the row, not below it");
    assert.ok(layout.ghosts.has(step!.id));
    assert.ok(
      !layout.edges.some(
        (edge) => edge.kind === "solid" && edge.d.includes(`M${layout.rects[step!.id]!.x + STEPS.nodeW} `),
      ),
      "no line to the result",
    );
  });
});

it("no word the Builds tab shows for a try or a step says 'never judged' — the tester read it as a switched-off setting", () => {
  const leadMerged = () => {
    minute = 0;
    return [
      event("run_started", { goal: "g", mode: "director" }),
      event("autopilot_started", { director: true, facets: [] }),
      event("director_worker", { workerId: "sky", title: "Sky", state: "running", mode: "loop" }),
      event("facet_build_started", { facetId: "sky", facetTitle: "Sky", iteration: 1 }),
      event("integration_merge", { facetId: "sky", head: "h1", commit: "c1", conflict: false, stage: "director" }),
      event("run_finished", { landed: true, integrationHead: "h1", baseCommit: "base" }),
    ];
  };
  const said: string[] = [...Object.values(TRY_WORD)];
  for (const status of Object.values(IterationStatus))
    said.push(sideBySideWords({ status, satisfied: false, source: null }));
  for (const { graph, rows } of [loopRun(), loopRun({ finished: false }), leadMerged()].map(rowsOf)) {
    for (const row of rows) said.push(rowMeta(row, graph.active));
    for (const step of rows.flatMap((row) => row.steps)) {
      for (const active of [true, false])
        said.push(stepWord(step, active), stepPill(step, active), stepSentence(step, active));
      said.push(triesWord(step) ?? "", askedRest(step) ?? "");
      for (const node of step.tries) said.push(judgesOn(node), leadStopped(node) ?? "");
    }
  }
  assert.ok(said.length > 20, "the check read the words the tab shows");
  assert.deepEqual(
    said.filter((text) => /never judged/i.test(text)),
    [],
  );
});

describe("the time a run was given", () => {
  it("says how far into it the run is, in minutes and then hours", () => {
    assert.equal(budgetWords(9.5 * 60_000, 30 * 60_000), "9 of 30 min");
    assert.equal(budgetWords(20_000, 30 * 60_000), "0 of 30 min");
    assert.equal(budgetWords(65 * 60_000, 2 * 3_600_000), "1 h 5 min of 2 h");
  });

  it("is a cap on the chat's build card, never a target the build must reach", () => {
    assert.equal(capWords(30 * 60_000), "up to 30m");
    assert.equal(capWords(10 * 3_600_000), "up to 10h");
    assert.equal(capWords(90 * 60_000), "up to 1h 30m");
  });

  it("says how long a finished build worked in the card's short units", () => {
    const took = (ms: number) => workedShortWords({ ms, since: null });
    assert.equal(took((5 * 60 + 17) * 60_000 + 20_000), "5h 17m");
    assert.equal(took(42 * 60_000), "42m");
    assert.equal(took(2 * 3_600_000), "2h");
    assert.equal(took(20_000), null);
    assert.equal(workedShortWords(undefined), null, "a build whose start is unknown");
  });

  it("puts it in the status line instead of the bare elapsed time", () => {
    const events = loopRun({ finished: false });
    (events[0]!.data as { payload: Record<string, unknown> }).payload.budgets = { wallClockMs: 3_600_000 };
    events.push(
      event("facet_liveness", {
        facetId: "land",
        facetTitle: "Frozen landscape",
        iteration: 5,
        critic: "place",
        total: 12,
        max: 18,
      }),
    );
    const { graph, summary, rows } = rowsOf(events);
    assert.equal(statusLine(graph, summary, rows, START + 39 * 60_000).strong, "Checking · 38 min of 1 h");
  });
});

describe("the clock counts the time a build worked", () => {
  const HOUR = 60;
  /** An 8 h run: an hour of work, then the app closed under it; a launch ten hours later pauses it. */
  function interrupted(): EventEnvelope[] {
    minute = 0;
    const events = [
      event("run_registered", { goal: "A sword in ice", budgets: { wallClockMs: 8 * 3_600_000 } }),
      event("run_started", { goal: "A sword in ice", mode: "director" }),
    ];
    minute = HOUR;
    events.push(event("autopilot_decision", { decision: "the sword needs more light" }));
    minute = 11 * HOUR;
    events.push(event("run_finished", { victory: false, stoppedBecause: "interrupted by restart" }));
    events.push(event("autopilot_paused", {}));
    return events;
  }
  /** The same run resumed two hours after the launch paused it. */
  function resumed(): EventEnvelope[] {
    const events = interrupted();
    minute = 13 * HOUR;
    events.push(event("run_registered", { goal: "A sword in ice", resumed: true }));
    events.push(event("run_started", { goal: "A sword in ice", resumed: true }));
    return events;
  }

  it("says how long a paused build has worked, against the time it was given", () => {
    const { graph, summary, rows } = rowsOf(interrupted());
    const line = statusLine(graph, summary, rows, START + 12 * HOUR * 60_000);
    assert.equal(line.strong, "Paused · 1 h of 8 h");
  });

  it("goes on from the time worked: neither the pause nor the closed app counts", () => {
    const events = resumed();
    const { graph, summary, rows } = rowsOf(events);
    const resumedAt = Date.parse(events.at(-2)?.created_at ?? "");
    assert.equal(statusLine(graph, summary, rows, resumedAt + 5 * 60_000).strong, "Building · 1 h 5 min of 8 h");
  });

  it("names the time on every closed build", () => {
    const { graph, summary, rows } = rowsOf(loopRun());
    assert.equal(statusLine(graph, summary, rows).strong, "Live in your game · 17 min");
    const failed = [...loopRun({ finished: true }).slice(0, -1), event("run_finished", { failure: { message: "x" } })];
    const stopped = rowsOf(failed);
    assert.equal(statusLine(stopped.graph, stopped.summary, stopped.rows).strong, "Build failed · 17 min");
  });
});

describe("a finished run reopened", () => {
  it("counts its time from the reopen, and no longer calls the first close's build live", () => {
    const events = loopRun();
    const reopen = event("run_registered", {
      goal: "A sword in ice",
      resumed: true,
      budgets: { wallClockMs: 1_800_000 },
    });
    events.push(reopen, event("run_started", { goal: "A sword in ice", resumed: true }));
    const { graph, summary, rows } = rowsOf(events);
    const reopenedAt = Date.parse(reopen.created_at);
    assert.match(statusLine(graph, summary, rows, reopenedAt + 5 * 60_000).strong, / · 5 of 30 min$/);
    assert.equal(resultStatus(graph, summary).word, "Ready to play", "its build stands, but nothing is live yet");
  });
});

describe("between parts", () => {
  /** A lead's run with one single-session part, merged a moment ago. */
  function merged(): EventEnvelope[] {
    minute = 0;
    return [
      event("run_started", { goal: "A sword in ice", mode: "director" }),
      event("autopilot_started", { director: true, facets: [] }),
      event("director_worker", { workerId: "sword", title: "Sword, ice and light", state: "running", mode: "single" }),
      event("director_worker", { workerId: "sword", title: "Sword, ice and light", state: "done", mode: "single" }),
      event("integration_merge", { facetId: "sword", head: "h1", commit: "c1", conflict: false, stage: "director" }),
    ];
  }

  it("does not call a merged build ready to play until something has shown it starts", () => {
    const { graph, summary, rows } = rowsOf(merged());
    assert.equal(checkingBuild(graph, summary), true);
    assert.deepEqual(resultStatus(graph, summary), { word: "Checking it starts…", tone: "accent", state: "judging" });
    assert.equal(statusLine(graph, summary, rows).rest, "checking the new build starts");
    assert.equal(leadWorking(graph, summary, rows), false, "the check is what is happening, on the build's own node");
  });

  it("calls it ready once it ran, or says it didn't start", () => {
    const ran = rowsOf([...merged(), event("integration_health", { head: "h1", ok: true, problems: [] })]);
    assert.equal(resultStatus(ran.graph, ran.summary).word, "Ready to play");
    const failed = rowsOf([
      ...merged(),
      event("integration_health", { head: "h1", ok: false, problems: ["black screen"] }),
    ]);
    assert.deepEqual(resultStatus(failed.graph, failed.summary), {
      word: "Didn't start",
      tone: "red",
      state: "undone",
    });
    const pictured = rowsOf(merged());
    pictured.summary.captures = { current: "/runs/run_ice/director/health_h1/default.jpg" };
    assert.equal(
      resultStatus(pictured.graph, pictured.summary).word,
      "Ready to play",
      "a picture of the build is proof enough",
    );
  });

  it("draws the lead after the build while no part works, so the run never looks finished", () => {
    const { graph, summary, rows } = rowsOf([
      ...merged(),
      event("integration_health", { head: "h1", ok: true, problems: [] }),
    ]);
    assert.equal(leadWorking(graph, summary, rows), true);
    assert.equal(statusLine(graph, summary, rows).rest, "the lead is working on the next step");
    const layout = layoutSteps(rows, { lead: true });
    const final = layout.rects.final!;
    const lead = layout.rects.lead!;
    assert.equal(lead.x, final.x + final.w + STEPS.leadGap);
    assert.equal(lead.y + lead.h / 2, final.y + final.h / 2, "on the result's line");
    assert.ok(
      layout.edges.some(
        (edge) => edge.kind === "live" && edge.d === `M${final.x + final.w} ${final.y + final.h / 2} H${lead.x}`,
      ),
    );
    assert.equal(layoutSteps(rows).rects.lead, undefined);
  });

  it("hands the graph back to the parts when one starts working", () => {
    const { graph, summary, rows } = rowsOf([
      ...merged(),
      event("integration_health", { head: "h1", ok: true, problems: [] }),
      event("director_worker", { workerId: "folk", title: "Villagers", state: "running", mode: "single" }),
    ]);
    assert.equal(leadWorking(graph, summary, rows), false);
    assert.equal(statusLine(graph, summary, rows).rest, "working on Villagers");
  });

  it("offers Live the build to play once it is ready, and nothing before or after the run", () => {
    const ran = rowsOf([...merged(), event("integration_health", { head: "h1", ok: true, problems: [] })]);
    assert.equal(readyToPlay(ran.graph, ran.summary), "h1");
    const checking = rowsOf(merged());
    assert.equal(readyToPlay(checking.graph, checking.summary), null, "a build still being tried is not offered");
    const failed = rowsOf([
      ...merged(),
      event("integration_health", { head: "h1", ok: false, problems: ["black screen"] }),
    ]);
    assert.equal(readyToPlay(failed.graph, failed.summary), null, "a build that didn't start is not offered");
    const over = rowsOf([
      ...merged(),
      event("integration_health", { head: "h1", ok: true, problems: [] }),
      event("run_finished", { landed: false, integrationHead: "h1", baseCommit: "base" }),
    ]);
    assert.equal(readyToPlay(over.graph, over.summary), null, "a finished run is played from Builds");
    assert.equal(readyToPlay(ran.graph, null), null, "no recorded outcome, nothing to play");
  });
});

describe("the words a card wears", () => {
  it("says the judges kept or rejected a step, and nothing about what comes next", () => {
    const events = loopRun({ finished: false });
    events.push(judged("land", 5, "challenger"));
    const { graph, rows } = rowsOf(events);
    const mountain = rows.find((row) => row.facet.facetId === "land")!.steps[2]!;
    assert.equal(mountain.state, "kept");
    assert.equal(stepPill(mountain, graph.active), "Kept by reviewers");
    assert.equal(stepPill(mountain, false), "Kept by reviewers, not added");
    const undone = rowsOf(loopRun()).rows.find((row) => row.facet.facetId === "land")!.steps[2]!;
    assert.equal(undone.state, "undone");
    assert.equal(stepPill(undone, false), "Rejected by reviewers");
  });

  /** A lead's run whose one build a pass of the lead's looked at and wrote a sentence about. */
  const looked = (pass: string, rule: string, because: string) => {
    minute = 0;
    return rowsOf([
      event("run_started", { goal: "A sword in ice", mode: "director" }),
      event("autopilot_started", { director: true, facets: [] }),
      event("integration_merge", { facetId: "sword", head: "h1", commit: "c1", conflict: false, stage: "director" }),
      event("director_verdict", {
        pass,
        build: { head: "h1", worker: null, round: null },
        seen: { pick: null },
        decision: { kept: null, rule },
        because,
      }),
    ]).graph;
  };

  it("quotes the last look at the build and names who took it", () => {
    assert.deepEqual(buildReview(looked("judge", "preferred", "The judge preferred it.")), {
      label: "Reviewers",
      words: "The reviewer preferred it.",
    });
    assert.deepEqual(buildReview(looked("health", "starts", "It starts and draws its first frame.")), {
      label: "Health check",
      words: "It starts and draws its first frame.",
    });
  });

  it("says nothing about a build there was nothing to compare with", () => {
    const empty = "Nothing to compare it with: the run started from an empty game, so this build is judged on its own.";
    assert.equal(buildReview(looked("judge", "first-build", empty)), null);
    const unseen = "Nothing to compare it with: the game as it stood could not be photographed.";
    assert.equal(buildReview(looked("judge", "no-start", unseen)), null);
  });
});

describe("why a worker stopped short, on its card", () => {
  const worker = (ended: WorkerEnd | null, stopCode: WorkerStopCode | null = null): WorkerInfo => ({
    type: null,
    isolation: null,
    in: null,
    where: null,
    task: "Port the car",
    summary: null,
    turn: null,
    ended,
    stopCode,
    verdict: null,
    note: null,
    merged: false,
  });
  it("says the end record's code in the app's words, and nothing without one: the record's own reason is the lead's", () => {
    const cases: Array<[string, WorkerInfo, string | null]> = [
      [
        "refused by the host",
        worker(WorkerEnd.Failed, WorkerStopCode.HostRefused),
        "Your Settings allow no more workers at once",
      ],
      ["the turn ended", worker(WorkerEnd.Failed, WorkerStopCode.TurnEnded), "The chat turn ended first"],
      ["an error", worker(WorkerEnd.Failed, WorkerStopCode.Error), "It ran into an error"],
      ["no code", worker(WorkerEnd.Failed), null],
      ["finished", worker(WorkerEnd.Done, WorkerStopCode.Error), null],
      ["stopped by the Loop's end", worker(WorkerEnd.Stopped, WorkerStopCode.RunEnded), "The Loop ended first"],
      ["stopped by the lead", worker(WorkerEnd.Stopped, WorkerStopCode.StoppedByLead), "The lead stopped it"],
      ["stopped, no code", worker(WorkerEnd.Stopped), null],
      ["still working", worker(null), null],
    ];
    for (const [name, info, expected] of cases) assert.equal(workerStopWords(info), expected, name);
  });

  it("a worker in place says where it works by the lock it holds, before the engine an older record names", () => {
    const rows: Array<[string, Record<string, unknown>, string]> = [
      ["where alone", { where: "Unreal" }, "Working in Unreal"],
      ["where wins over in", { where: "Toy editor", in: "unreal" }, "Working in Toy editor"],
      ["an older record's in", { in: "unreal" }, "Working in Unreal"],
      ["a where that is no text", { where: 7, in: "unreal" }, "Working in Unreal"],
      ["an empty where", { where: "  " }, "Working"],
      ["neither", {}, "Working"],
    ];
    for (const [name, extra, expected] of rows) {
      const title = "Build the track";
      const graph = buildRunGraph([
        event("run_started", { goal: "a track" }),
        event("worker_started", { workerId: "pool.w1", title, isolation: "lock", task: title, ...extra }),
      ]);
      assert.ok(graph, name);
      const step = partRows(graph, null)[0]?.steps.find((each) => each.worker);
      assert.ok(step, name);
      assert.equal(stepWord(step, graph.active), expected, name);
    }
  });

  it("a failed builder's card never says the harness's own reason, whether or not its end has a code", () => {
    const why = "left conflict markers in src/main.ts — nothing was committed and the merge was aborted";
    const title = "Fit Plaza in with the rest of the game";
    for (const code of [WorkerStopCode.Error, null]) {
      const events = [
        event("run_started", { goal: "a plaza" }),
        event("director_worker", { workerId: "plaza-2", title, state: "running", mode: "single" }),
        event("worker_started", { workerId: "plaza-2", title, isolation: "copy", task: title }),
        event("director_worker", { workerId: "plaza-2", title, state: "failed", mode: "single", stoppedBecause: why }),
        event("worker_finished", {
          workerId: "plaza-2",
          title,
          state: "failed",
          stoppedBecause: why,
          ...(code ? { stopCode: code } : {}),
        }),
      ];
      const graph = buildRunGraph(events);
      assert.ok(graph);
      const info = partRows(graph, null)[0]?.steps.find((step) => step.worker)?.worker;
      assert.ok(info, `${code}: the builder's row has its worker records`);
      const said = workerStopWords(info) ?? "";
      assert.equal(said, code ? "It ran into an error" : "", `${code}`);
      assert.doesNotMatch(said, /reader|writer|editor|copy|lock|merg|isolation|sandbox|seat|conflict/i, `${code}`);
    }
  });
});
