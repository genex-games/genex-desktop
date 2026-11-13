/**
 * The Builds tab's list (panels/run-graph/builds-list.ts): what works now, then what changed, newest
 * first. A step is a row with a mark, the time it ended and what it stands as; a build check that
 * did not pass is a row of its own; the lead is a row only while it works itself. A row of the
 * chat's Building card finds its row here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildChecklist } from "../../src/renderer/chat/build-checklist.ts";
import { GraphSelection } from "../../src/renderer/panels/inspector/selection.ts";
import {
  type BuildsList,
  buildsList,
  type ListRow,
  RowMark,
  rowOfChecklist,
} from "../../src/renderer/panels/run-graph/builds-list.ts";
import { buildRunGraph, GraphNodeKind, type FinishCheckNode } from "../../src/renderer/run-graph.ts";
import { buildTimeline } from "../../src/renderer/run-graph-builds.ts";
import { leadWorking, partRows, stepWord } from "../../src/renderer/run-steps.ts";
import { leadFace, leadNodeOf, readingNodes } from "../../src/renderer/run-tree.ts";
import { BUILD_LINE_WORDS, LEAD_WORDS } from "../../src/renderer/words.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { type EventEnvelope, EventKind } from "../../src/shared/event-log.ts";
import { HealthFinding } from "../../src/shared/preview-contract.ts";
import { summarizeRun } from "../../src/shared/run-summary.ts";
import { poolWorkerId, WorkerEnd, WorkerIsolation, WorkerVerdict } from "../../src/shared/workers.ts";

const RUN = "run-l";
const PROJECT = "game";
const H = (digit: number): string => String(digit).repeat(40);

let seq = 0;
/** One record of the run, a minute after the one before: 09:01, 09:02, … */
function inRun(eventType: string, payload: Record<string, unknown> = {}): EventEnvelope {
  seq += 1;
  return {
    id: `e${String(seq).padStart(4, "0")}`,
    thread_id: "t1",
    session_id: null,
    turn_id: null,
    created_at: new Date(Date.UTC(2026, 0, 1, 9, seq, 0)).toISOString(),
    data: { type: EventKind.Custom, event_type: eventType, payload: { runId: RUN, project: PROJECT, ...payload } },
  } as EventEnvelope;
}
const at = (event: EventEnvelope): string => event.created_at;

const start = (id: string, title: string) =>
  inRun(CustomEvent.WorkerStarted, { workerId: poolWorkerId(id), title, isolation: WorkerIsolation.Copy });
const end = (id: string, title: string) =>
  inRun(CustomEvent.WorkerFinished, { workerId: poolWorkerId(id), title, state: WorkerEnd.Done, delivered: true });
const used = (id: string, title: string) =>
  inRun(CustomEvent.WorkerFinished, { workerId: poolWorkerId(id), title, verdict: WorkerVerdict.Used, merged: true });
const rejected = (id: string, title: string) =>
  inRun(CustomEvent.WorkerFinished, { workerId: poolWorkerId(id), title, verdict: WorkerVerdict.Rejected });
const check = (head: string, extra: Record<string, unknown> = {}) =>
  inRun(CustomEvent.IntegrationHealth, { head, ok: true, problems: [], findings: [], picture: null, ...extra });

/** The list of a log, as the Builds tab folds it. */
function listOf(events: EventEnvelope[], now = Date.UTC(2026, 0, 1, 10, 0, 0)): BuildsList {
  const graph = buildRunGraph(events);
  assert.ok(graph, "the log folds into a graph");
  const summary = summarizeRun(events, PROJECT, RUN);
  const rows = partRows(graph, summary);
  const finishCheck =
    graph.nodes.find((node): node is FinishCheckNode => node.kind === GraphNodeKind.FinishCheck) ?? null;
  return buildsList({
    graph,
    rows,
    timeline: buildTimeline(graph, rows),
    nodes: readingNodes(graph, rows, summary),
    face: graph.tree ? leadFace(graph, summary, rows) : null,
    leadAtWork: leadWorking(graph, summary, rows),
    jobs: leadNodeOf(graph)?.jobs ?? [],
    finishCheck,
    now,
  });
}

const titles = (rows: ListRow[]): string[] => rows.map((row) => row.title);
const named = (rows: ListRow[], title: string): ListRow => {
  const row = rows.find((item) => item.title === title);
  assert.ok(row, `no row "${title}" among ${titles(rows).join(", ")}`);
  return row;
};

/**
 * A Loop mid-way: the house was added, the night version was left out, a check of the lead's own
 * commit did not pass, and the bow is being built.
 */
function loop(): { events: EventEnvelope[]; houseEnd: EventEnvelope; failed: EventEnvelope } {
  seq = 0;
  const events = [
    inRun(CustomEvent.RunStarted, { goal: "A quiet village" }),
    inRun(CustomEvent.AutopilotStarted, { director: true, facets: [], workerRecords: true }),
    start("w1", "A timber house"),
    end("w1", "A timber house"),
  ];
  const houseEnd = used("w1", "A timber house");
  events.push(check(H(1), { worker: poolWorkerId("w1") }), houseEnd);
  events.push(start("w2", "A night version"), end("w2", "A night version"), rejected("w2", "A night version"));
  const failed = check(H(2), { ok: false, problems: ["Uncaught TypeError"], findings: [HealthFinding.Uncaught] });
  events.push(failed, start("w3", "The archer draws the bow"));
  return { events, houseEnd, failed };
}

describe("the Builds list", () => {
  it("lists what works now apart from what changed", () => {
    const { working, changes } = listOf(loop().events);
    assert.deepEqual(titles(working), ["The archer draws the bow"]);
    assert.equal(working[0]?.mark, RowMark.Working);
    assert.ok(!titles(changes).includes("The archer draws the bow"));
  });

  it("lists what changed newest first", () => {
    const { changes } = listOf(loop().events);
    assert.deepEqual(titles(changes), [
      BUILD_LINE_WORDS.finding[HealthFinding.Uncaught],
      "A night version",
      "A timber house",
    ]);
  });

  it("marks a step by where its work stands, and says so only when it is not in the build", () => {
    const { changes } = listOf(loop().events);
    const house = named(changes, "A timber house");
    const night = named(changes, "A night version");
    assert.equal(house.mark, RowMark.Added);
    assert.equal(house.detail, null);
    assert.equal(night.mark, RowMark.Out);
    assert.ok(night.step);
    assert.equal(night.detail, stepWord(night.step, true));
  });

  it("gives a worker's row the time its last record was written", () => {
    const { events, houseEnd } = loop();
    assert.equal(named(listOf(events).changes, "A timber house").at, at(houseEnd));
  });

  it("makes a build check that did not pass a row of its own, with what it found and when", () => {
    const { events, failed } = loop();
    const row = named(listOf(events).changes, BUILD_LINE_WORDS.finding[HealthFinding.Uncaught]);
    assert.equal(row.mark, RowMark.Problem);
    assert.equal(row.at, at(failed));
    assert.equal(row.detail, BUILD_LINE_WORDS.outcome.errors);
    assert.equal(row.build?.n, 2);
  });

  it("leaves a check that passed off the list: its step is the row", () => {
    const { changes } = listOf(loop().events);
    assert.equal(changes.filter((row) => row.build !== null).length, 1);
  });

  it("shows the lead only while it works itself", () => {
    const { events } = loop();
    assert.ok(!listOf(events).working.some((row) => row.id === GraphSelection.Lead));
    // Its last worker ended: the lead has the run again.
    const alone = [...events, end("w3", "The archer draws the bow"), used("w3", "The archer draws the bow")];
    const lead = listOf(alone).working.find((row) => row.id === GraphSelection.Lead);
    assert.equal(lead?.title, LEAD_WORDS.name);
    assert.equal(lead?.mark, RowMark.Working);
  });

  it("finds the row of a step of the chat's Building card", () => {
    const { events } = loop();
    const list = listOf(events);
    const summary = summarizeRun(events, PROJECT, RUN);
    const card = buildChecklist(summary, Date.UTC(2026, 0, 1, 10, 0, 0));
    const bow = card?.rows.find((row) => row.title === "The archer draws the bow");
    const house = card?.rows.find((row) => row.title === "A timber house");
    assert.ok(bow && house);
    assert.equal(rowOfChecklist(list, bow.id), named(list.working, "The archer draws the bow").id);
    assert.equal(rowOfChecklist(list, house.id), named(list.changes, "A timber house").id);
    assert.equal(rowOfChecklist(list, "no-such-step"), null);
  });
});
