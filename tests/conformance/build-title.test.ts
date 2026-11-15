/**
 * A build's name (shared/build-title.ts): the short title the chat gave it as it started it
 * (`start_autopilot`'s `title`, carried on `run_registered`), else its first save point's label,
 * else the chat's title, else a short line of its goal without an older seed's "The person asked:"
 * lead. The history, the graph and the Builds bar's tabs call a build by it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { startAutopilot } from "../../src/harness-seed/loop/start-autopilot.ts";
import { argumentProblems } from "../../src/harness-seed/tools/index.ts";
import { buildHistory } from "../../src/renderer/build-progress.ts";
import { buildRunGraph, GraphNodeKind } from "../../src/renderer/run-graph.ts";
import { buildTitle, cleanBuildTitle, MAX_BUILD_TITLE_CHARS } from "../../src/shared/build-title.ts";
import { CustomEvent, LEAD_PART } from "../../src/shared/custom-events.ts";
import { type EventEnvelope, EventKind } from "../../src/shared/event-log.ts";

const LEGACY_GOAL =
  'The person asked: "Make a game about a cat who delivers pizza across rooftops at night". This means a 3D runner where the cat jumps between roofs.';

let seq = 0;
function record(eventType: string, payload: Record<string, unknown>): EventEnvelope {
  seq += 1;
  return {
    id: `e${seq}`,
    thread_id: "t1",
    session_id: null,
    turn_id: null,
    created_at: new Date(Date.UTC(2026, 10, 14, 9, seq)).toISOString(),
    data: { type: EventKind.Custom, event_type: eventType, payload: { runId: "run_a", project: "game", ...payload } },
  } as EventEnvelope;
}
const savePoint = (iteration: number, label: string, auto = false) =>
  record(CustomEvent.FacetIteration, { facetId: LEAD_PART, iteration, label, auto });

test("a build is called by its own title, else its first save point, else the chat's title, else its goal", () => {
  const goal = LEGACY_GOAL;
  assert.equal(
    buildTitle({ title: "Rooftop pizza cat", firstSavePoint: "Roofs", threadTitle: "Cat", goal }),
    "Rooftop pizza cat",
  );
  assert.equal(
    buildTitle({ title: " ", firstSavePoint: "Roofs and jumps", threadTitle: "Cat", goal }),
    "Roofs and jumps",
  );
  assert.equal(buildTitle({ firstSavePoint: null, threadTitle: "Pizza cat", goal }), "Pizza cat");
  assert.equal(buildTitle({ goal: "" }), "", "nothing to call it by");
});

test("an older run's goal is shortened to the person's quoted ask, without the lead before it", () => {
  const title = buildTitle({ goal: LEGACY_GOAL });
  assert.doesNotMatch(title, /person asked|"/i);
  assert.ok(title.startsWith("Make a game about a cat"), title);
  assert.ok([...title].length <= MAX_BUILD_TITLE_CHARS, "short enough for a tab");
  assert.equal(
    buildTitle({ goal: "  A night street race\nwith neon" }),
    "A night street race",
    "a plain goal keeps its first line",
  );
});

test("a title is one line of at most the longest a tab shows, cut at a word", () => {
  assert.equal(cleanBuildTitle('  "Neon   drift\nracer" '), "Neon drift racer");
  assert.equal(cleanBuildTitle(42), null);
  assert.equal(cleanBuildTitle(""), null);
  const long = cleanBuildTitle("word ".repeat(40));
  assert.ok(long && [...long].length <= MAX_BUILD_TITLE_CHARS && long.endsWith("…"), String(long));
  assert.doesNotMatch(long ?? "", / …$/);
});

test("start_autopilot asks for a short title and carries it onto the run; a launch without one still starts", async () => {
  const params = startAutopilot.parameters as { required?: string[]; properties?: Record<string, unknown> };
  assert.ok(params.properties?.title, "the tool names a title");
  assert.ok(params.required?.includes("title"), "and asks for it");
  const ctx = { engine: "vendor" } as never;
  const named = (await startAutopilot.execute({ goal: "make a pizza cat game", title: " Pizza cat " }, ctx)) as {
    details?: { run?: Record<string, unknown> };
  };
  assert.equal(named.details?.run?.title, "Pizza cat");
  const unnamed = (await startAutopilot.execute({ goal: "make a pizza cat game" }, ctx)) as {
    details?: { run?: Record<string, unknown> };
  };
  assert.equal(unnamed.details?.run?.title, undefined, "no title, no field: the app names it another way");
  assert.deepEqual(argumentProblems(params as never, { goal: "g", title: "Pizza cat" }), []);
});

test("the history and the graph call a run by the title its registration carries", () => {
  const events = [
    record(CustomEvent.RunRegistered, { goal: LEGACY_GOAL, title: "Rooftop pizza cat" }),
    savePoint(1, "Roof jumps"),
  ];
  const [entry] = buildHistory(events, "t1");
  assert.equal(entry?.title, "Rooftop pizza cat");
  assert.equal(entry?.ask, LEGACY_GOAL, "what was asked stays as it was");
  const run = buildRunGraph(events, "run_a")?.nodes.find((node) => node.kind === GraphNodeKind.Run);
  assert.equal(run && "title" in run ? run.title : null, "Rooftop pizza cat");
});

test("an older run with no title is called by its first save point the lead named, not an autosave", () => {
  const events = [
    record(CustomEvent.RunRegistered, { goal: LEGACY_GOAL }),
    savePoint(1, "Autosave", true),
    savePoint(2, "Roofs and jumps"),
    savePoint(3, "Pizza delivery"),
  ];
  const [entry] = buildHistory(events, "t1");
  assert.equal(entry?.title, "Roofs and jumps");
  const [bare] = buildHistory([record(CustomEvent.RunRegistered, { goal: LEGACY_GOAL })], "t1");
  assert.equal(bare?.title, undefined, "nothing of its own: the tab falls back to the chat's title or its goal");
});

test("a chat turn's build is called by the person's words, never the board notes a send added under them", async () => {
  const { queuedAsk } = await import("../../src/renderer/run-graph.ts");
  const { DESIGN_NEWS_HEADING } = await import("../../src/shared/design-tell-prompts.ts");
  const said: EventEnvelope = {
    id: "m1",
    thread_id: "t1",
    session_id: null,
    turn_id: null,
    created_at: new Date(Date.UTC(2026, 10, 14, 9, 0)).toISOString(),
    data: {
      type: EventKind.Messages,
      messages: [{ role: "user", content: `Make the hills greener\n\n${DESIGN_NEWS_HEADING}\nA note on Look` }],
    },
  } as EventEnvelope;
  const queue = { messages: new Map([["turn-1", { eventId: "m1" }]]) } as never;
  assert.equal(queuedAsk([said], queue, "turn-1"), "Make the hills greener");
});
