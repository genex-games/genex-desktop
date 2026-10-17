import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RunSummaryFeed,
  createRunSummaryFeeds,
  graphEventsSince,
  type GraphCursor,
} from "../../src/shared/run-summary-feed.ts";
import type { RunSummary } from "../../src/shared/run-summary.ts";
import { keepSummary, keptSummary } from "../../src/renderer/use-run-summary.ts";
import type { UiEvent } from "../../src/shared/ui-events.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";

const event = (id: string) =>
  ({
    id,
    thread_id: "t",
    created_at: id,
    data: { type: "custom", event_type: "x", payload: { runId: "r" } },
  }) as unknown as EventEnvelope;
const ids = (events: EventEnvelope[] | undefined) => (events ?? []).map((e) => e.id);
// A reply is a copy, as it is over IPC.
const summary = (graphEvents: EventEnvelope[], graphEventsFrom: number) =>
  ({ project: "p", runId: "r", graphEvents: [...graphEvents], graphEventsFrom }) as unknown as RunSummary;
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("graph events from a matching cursor are the held last one and the tail; any mismatch sends everything", () => {
  const all = ["a", "b", "c", "d"].map(event);
  // The held last event comes again: its compaction tail (`graphLastAt`) moves as traces arrive.
  assert.deepEqual(graphEventsSince(all, { count: 2, lastId: "b" }), { from: 1, events: all.slice(1) });
  assert.deepEqual(graphEventsSince(all, { count: 4, lastId: "d" }), { from: 3, events: all.slice(3) });
  for (const cursor of [
    null,
    undefined,
    { count: 0, lastId: "a" },
    { count: 2, lastId: "c" },
    { count: 5, lastId: "d" },
    { count: 1.5, lastId: "a" },
    { count: 2, lastId: 7 },
  ] as Array<GraphCursor | null | undefined>) {
    assert.deepEqual(graphEventsSince(all, cursor), { from: 0, events: all }, JSON.stringify(cursor));
  }
});

test("a feed asks for what follows its graph and hands listeners the whole graph", async () => {
  const cursors: Array<GraphCursor | null> = [];
  const server = ["a", "b"].map(event);
  const feed = new RunSummaryFeed({
    fetch: async (cursor) => {
      cursors.push(cursor);
      const { from, events } = graphEventsSince(server, cursor);
      return summary(events, from);
    },
  });
  const seen: RunSummary[] = [];
  feed.subscribe((value) => seen.push(value));
  await flush();
  server.push(event("c"));
  feed.invalidate();
  await flush();
  feed.invalidate();
  await flush();
  assert.deepEqual(cursors, [null, { count: 2, lastId: "b" }, { count: 3, lastId: "c" }]);
  assert.deepEqual(
    seen.map((s) => ids(s.graphEvents)),
    [
      ["a", "b"],
      ["a", "b", "c"],
      ["a", "b", "c"],
    ],
  );
  assert.ok(seen.every((s) => !("graphEventsFrom" in s)));
  assert.equal(seen[2]!.graphEvents, seen[1]!.graphEvents, "no new events keeps the same graph array");
});

test("views of one run share fetches; a later view gets the latest summary at once", async () => {
  let fetches = 0;
  const feed = new RunSummaryFeed({ fetch: async () => (fetches++, summary([event("a")], 0)) });
  const first: RunSummary[] = [];
  const second: RunSummary[] = [];
  const offFirst = feed.subscribe((value) => first.push(value));
  await flush();
  feed.subscribe((value) => second.push(value));
  assert.equal(second.length, 1, "delivered synchronously from the latest summary");
  await flush();
  assert.equal(fetches, 2);
  assert.equal(first.length, 2);
  offFirst();
  assert.equal(feed.listeners, 1);
});

test("invalidations during a fetch fold into one follow-up, spaced by the minimum interval", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const pending: Array<() => void> = [];
  let fetches = 0;
  const feed = new RunSummaryFeed({
    fetch: () =>
      new Promise((resolve) => {
        fetches++;
        pending.push(() => resolve(summary([], 0)));
      }),
    minIntervalMs: 250,
    now: () => now,
  });
  feed.subscribe(() => {});
  assert.equal(fetches, 1);
  for (let i = 0; i < 20; i++) feed.invalidate();
  now = 100;
  pending.shift()!();
  await flush();
  assert.equal(fetches, 1, "the follow-up waits for the interval");
  now = 250;
  t.mock.timers.tick(150);
  assert.equal(fetches, 2);
  pending.shift()!();
  await flush();
  assert.equal(fetches, 2, "twenty invalidations became one fetch");
});

test("a reply that does not continue the held graph starts over with a full fetch", async () => {
  const cursors: Array<GraphCursor | null> = [];
  const replies = [summary(["a", "b"].map(event), 0), summary([event("x")], 7), summary(["a", "b", "c"].map(event), 0)];
  const feed = new RunSummaryFeed({ fetch: async (cursor) => (cursors.push(cursor), replies.shift()!) });
  const seen: RunSummary[] = [];
  feed.subscribe((value) => seen.push(value));
  await flush();
  feed.invalidate();
  await flush();
  await flush();
  assert.deepEqual(cursors, [null, { count: 2, lastId: "b" }, null]);
  assert.deepEqual(
    seen.map((s) => ids(s.graphEvents)),
    [
      ["a", "b"],
      ["a", "b", "c"],
    ],
  );
});

test("a disposed feed neither fetches nor notifies", async () => {
  let fetches = 0;
  let release!: () => void;
  const feed = new RunSummaryFeed({
    fetch: () =>
      new Promise((resolve) => {
        fetches++;
        release = () => resolve(summary([], 0));
      }),
  });
  const seen: RunSummary[] = [];
  feed.subscribe((value) => seen.push(value));
  feed.dispose();
  release();
  await flush();
  feed.invalidate();
  assert.equal(fetches, 1);
  assert.equal(seen.length, 0);
});

test("a clock that steps back never holds the next fetch longer than one interval", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 1_000_000;
  let fetches = 0;
  const feed = new RunSummaryFeed({
    fetch: async () => (fetches++, summary([], 0)),
    minIntervalMs: 250,
    now: () => now,
  });
  feed.subscribe(() => {});
  await flush();
  now -= 3_600_000;
  feed.invalidate();
  t.mock.timers.tick(250);
  await flush();
  assert.equal(fetches, 2);
});

test("a failed fetch keeps the last summary, and a change during it still refetches", async () => {
  const outcomes: Array<() => Promise<RunSummary>> = [
    async () => summary([event("a")], 0),
    async () => {
      feed.invalidate();
      throw new Error("host busy");
    },
    async () => summary([event("b")], 1),
  ];
  const feed = new RunSummaryFeed({ fetch: () => outcomes.shift()!() });
  const seen: RunSummary[] = [];
  feed.subscribe((value) => seen.push(value));
  await flush();
  feed.invalidate();
  await flush();
  await flush();
  assert.deepEqual(
    seen.map((s) => ids(s.graphEvents)),
    [["a"], ["a", "b"]],
  );
  assert.equal(outcomes.length, 0);
});

test("views of a run share one feed and one event listener; the last view takes both away", async () => {
  const listeners = new Set<(event: UiEvent) => void>();
  const asked: Array<[string, string, GraphCursor | null | undefined]> = [];
  const studio = {
    runSummary: async (project: string, runId: string, graphFrom?: GraphCursor | null) => (
      asked.push([project, runId, graphFrom]), summary([event("a")], 0)
    ),
    onEvent: (listener: (event: UiEvent) => void) => (
      listeners.add(listener),
      () => {
        listeners.delete(listener);
      }
    ),
  };
  const emit = (type: string, payload: unknown = {}) => {
    // A pushed event is whatever main sent; the feed reads only its type and the run it names.
    for (const listener of listeners) listener({ type, payload } as UiEvent);
  };
  const feeds = createRunSummaryFeeds(studio, 0);
  const offFirst = feeds.subscribe("game", "r1", () => {});
  const offSecond = feeds.subscribe("game", "r1", () => {});
  await flush();
  assert.equal(listeners.size, 1);
  assert.equal(feeds.size, 1);
  const before = asked.length;
  emit("run.summary.changed", { runId: "r2" });
  await flush();
  assert.equal(asked.length, before, "another run's change does not refetch");
  emit("run.summary.changed", { runId: "r1" });
  await flush();
  assert.equal(asked.length, before + 1);
  assert.deepEqual(asked.at(-1)!.slice(0, 2), ["game", "r1"]);
  emit("preview.identity", { project: "game", head: null, state: "loaded", error: null });
  await flush();
  assert.equal(asked.length, before + 1, "a preview change patches the summary without a fetch");
  offFirst();
  assert.equal(listeners.size, 1, "one view left");
  offSecond();
  offSecond();
  assert.equal(listeners.size, 0);
  assert.equal(feeds.size, 0);
  feeds.subscribe("game", "r1", () => {});
  await flush();
  assert.equal(asked.at(-1)![2], null, "a new feed starts from the whole graph");
});

test("a re-sent last event replaces the held one, and an unchanged one keeps the graph array", async () => {
  const stamped = (id: string, lastAt: string) => ({ ...event(id), graphLastAt: lastAt }) as EventEnvelope;
  const replies = [
    summary([event("a"), stamped("b", "t1")], 0),
    summary([stamped("b", "t2")], 1),
    summary([stamped("b", "t2")], 1),
    summary([event("b"), stamped("c", "t3")], 1),
  ];
  const feed = new RunSummaryFeed({ fetch: async () => replies.shift()! });
  const seen: RunSummary[] = [];
  feed.subscribe((value) => seen.push(value));
  for (let i = 0; i < 3; i++) {
    await flush();
    feed.invalidate();
  }
  await flush();
  const lastAt = (s: RunSummary) => (s.graphEvents?.at(-1) as { graphLastAt?: string } | undefined)?.graphLastAt;
  assert.deepEqual(
    seen.map((s) => [ids(s.graphEvents), lastAt(s)]),
    [
      [["a", "b"], "t1"],
      [["a", "b"], "t2"],
      [["a", "b"], "t2"],
      [["a", "b", "c"], "t3"],
    ],
  );
  assert.equal(seen[2]!.graphEvents, seen[1]!.graphEvents, "a repeat of the held last event keeps the array");
  assert.ok(!("graphLastAt" in seen[3]!.graphEvents![1]!), "an event no longer last loses its stale stamp");
});

test("a preview change patches every view at once; one pushed during a fetch outlives its reply", async () => {
  let release!: () => void;
  const preview = (project: string, head: string) => ({ project, head, state: "loaded", error: null });
  const replies = [
    async () => ({ ...summary([event("a")], 0), preview: preview("game", "h1") }),
    () =>
      new Promise<RunSummary>((resolve) => {
        release = () => resolve({ ...summary([event("a")], 0), preview: preview("game", "h1") });
      }),
  ];
  const feed = new RunSummaryFeed({ fetch: () => replies.shift()!() });
  const seen: RunSummary[] = [];
  feed.subscribe((value) => seen.push(value));
  await flush();
  feed.previewChanged(preview("game", "h2"));
  assert.equal(seen.at(-1)!.preview?.head, "h2");
  feed.invalidate();
  feed.previewChanged(preview("game", "h3"));
  release();
  await flush();
  assert.deepEqual(
    seen.map((s) => s.preview?.head),
    ["h1", "h2", "h3", "h3"],
  );
});

test("only a preview of the run's own game, or none, reaches its feed", async () => {
  const listeners = new Set<(event: UiEvent) => void>();
  const feeds = createRunSummaryFeeds(
    {
      runSummary: async () => summary([event("a")], 0),
      onEvent: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    },
    0,
  );
  const seen: RunSummary[] = [];
  feeds.subscribe("game", "r1", (value) => seen.push(value));
  await flush();
  const emit = (payload: unknown) => {
    for (const listener of listeners) listener({ type: "preview.identity", payload } as UiEvent);
  };
  emit({ project: "other", head: "x", state: "loaded", error: null });
  assert.equal(seen.length, 1, "another game's preview is ignored");
  emit(null);
  assert.equal(seen.length, 2);
  assert.equal(seen[1]!.preview, null);
});

test("a run's view that mounts again starts from the newest summary it was sent, never another run's", () => {
  const first = summary([], 0);
  const newer = { ...summary([event("a")], 0), revision: 2 } as RunSummary;
  keepSummary(first);
  keepSummary(newer);
  assert.equal(keptSummary("p", "r"), newer);
  assert.equal(keptSummary("p", "other"), null);
  assert.equal(keptSummary(null, "r"), null);
  for (let i = 0; i < 20; i++) keepSummary({ ...first, runId: `run-${i}` } as RunSummary);
  assert.equal(keptSummary("p", "r"), null, "only the most recent runs are kept");
});
