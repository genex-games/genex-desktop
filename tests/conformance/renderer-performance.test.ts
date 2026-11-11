import ceilings from "../fixtures/renderer-performance-ceilings.json" with { type: "json" };
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeChatEvents } from "../../src/shared/chat-history.ts";
import { EventKind, type EventEnvelope } from "../../src/shared/event-log.ts";
import { assetsFailed, assetsLoaded, gamesLoaded, initialLibrary } from "../../src/renderer/state/library.ts";
import { harnessDown, initialThreads, statusReported, threadsLoaded } from "../../src/renderer/state/threads.ts";
import { eventsArrived, initialEventLog, threadBackfilled } from "../../src/renderer/state/event-log.ts";
import { appendFeed } from "../../src/renderer/event-feed.ts";

const event = (id: string): EventEnvelope => ({
  id,
  thread_id: "lead",
  session_id: null,
  turn_id: null,
  created_at: "2026-09-28T00:00:00Z",
  data: { type: EventKind.Custom, event_type: "test", payload: {} },
});

describe("renderer performance behavior", () => {
  it("unchanged store refreshes preserve identity and still clear asset errors", () => {
    const inventory = { project: "game", assets: [], skipped: [], truncated: false };
    const library = assetsLoaded(initialLibrary(), "game", inventory);
    assert.equal(assetsLoaded(library, "game", structuredClone(inventory)), library);
    assert.equal(gamesLoaded(library, []), library);
    const failed = assetsFailed(library, "game", "read failed");
    assert.equal(assetsLoaded(failed, "game", inventory).assets.game?.error, null);
    const threads = statusReported(initialThreads(), {});
    assert.equal(threadsLoaded(threads, []), threads);
    assert.equal(statusReported(threads, {}), threads);
    assert.equal(harnessDown(threads), threads);
  });
  it("event order is independent of a Danish collator", () => {
    const ids = ["0199aaaa-0000", "0199ab00-0000", "0199a900-0000"];
    const original = String.prototype.localeCompare;
    const collator = new Intl.Collator("da");
    try {
      String.prototype.localeCompare = function (other: string) {
        return collator.compare(String(this), other);
      };
      assert.deepEqual(
        mergeChatEvents(ids.map(event)).map((item) => item.id),
        [...ids].sort(),
      );
    } finally {
      String.prototype.localeCompare = original;
    }
  });
  it("duplicate and out-of-order batches stay ordered without duplicate events", () => {
    const current = [event("01"), event("03")];
    assert.deepEqual(
      appendFeed(current, [event("02"), event("02")]).map((item) => item.id),
      ["01", "02", "03"],
    );
    const state = threadBackfilled(initialEventLog(), "lead", current);
    const next = eventsArrived(state, { events: [event("04"), event("04")], cursor: "04" });
    assert.deepEqual(
      next.byThread.lead?.map((item) => item.id),
      ["01", "03", "04"],
    );
  });
  it("a sorted append never inspects ids in retained thread history", () => {
    let reads = 0;
    const history = Array.from({ length: 20_000 }, (_, index) => event(String(index).padStart(8, "0")));
    const state = threadBackfilled(initialEventLog(), "lead", history);
    for (const item of state.byThread.lead ?? []) {
      const id = item.id;
      Object.defineProperty(item, "id", {
        get: () => {
          reads++;
          return id;
        },
      });
    }
    eventsArrived(state, { events: [event("00020000")], cursor: "00020000" });
    assert.ok(reads <= ceilings.retainedHistoryIdReadsPerAppend, `retained history id reads: ${reads}`);
  });
});

it("a viewer back before its read landed takes that read, and released logs are kept within a budget", async () => {
  const { createEventLogStore, RELEASED_RECORDS_MAX } = await import("../../src/renderer/state/event-log.ts");
  const { FEED_WINDOW } = await import("../../src/renderer/event-feed.ts");
  const reads: Array<(events: EventEnvelope[]) => void> = [];
  const store = createEventLogStore({
    events: async () => ({ events: [], cursor: null }),
    threadEvents: () => new Promise((resolve) => reads.push(resolve)),
  });
  const logOf = (thread: string, length: number) =>
    Array.from({ length }, (_, index) => ({ ...event(String(index).padStart(8, "0")), thread_id: thread }));
  // StrictMode mounts, cleans up and mounts again: the second viewer waits for the first read.
  const first = store.watchThread("lead");
  first();
  const second = store.watchThread("lead");
  assert.equal(reads.length, 1, "a viewer back during the read does not read again");
  reads[0]?.(logOf("lead", 5_000));
  await Promise.resolve();
  assert.equal(store.getState().byThread.lead?.length, 5_000);
  second();
  assert.equal(store.getState().backfill.lead, "done", "the log left a moment ago stays whole");
  assert.equal(store.getState().byThread.lead?.length, 5_000);

  const half = Math.ceil(RELEASED_RECORDS_MAX / 2) + 1;
  for (const [index, thread] of ["older", "newer"].entries()) {
    const stop = store.watchThread(thread);
    reads[index + 1]?.(logOf(thread, half));
    await Promise.resolve();
    stop();
  }
  assert.equal(store.getState().byThread.newer?.length, half, "the newest released log is kept");
  assert.equal(store.getState().backfill.older, undefined, "an older one past the budget is not");
  assert.equal(store.getState().byThread.older?.length, FEED_WINDOW);
  assert.equal(store.getState().byThread.lead?.length, 5_000, "a smaller one released before it still fits");

  const late = store.watchThread("late");
  late();
  const huge = store.watchThread("huge");
  huge();
  reads[3]?.(logOf("late", 10));
  reads[4]?.(logOf("huge", RELEASED_RECORDS_MAX + 1));
  await Promise.resolve();
  assert.equal(store.getState().byThread.late?.length, 10, "a read landing after its viewer left is kept");
  assert.equal(store.getState().byThread.huge?.length, FEED_WINDOW, "a log larger than the budget is not kept");
  assert.equal(store.getState().backfill.huge, undefined);
});

it("a game opened again keeps the whole log it read, so switching between two long Loops reads neither again", async () => {
  const { createEventLogStore } = await import("../../src/renderer/state/event-log.ts");
  const reads: string[] = [];
  const logOf = (thread: string, length: number) =>
    Array.from({ length }, (_, index) => ({
      ...event(`${thread}-${String(index).padStart(8, "0")}`),
      thread_id: thread,
    }));
  const store = createEventLogStore({
    events: async () => ({ events: [], cursor: null }),
    threadEvents: async (threadId) => {
      reads.push(threadId);
      return logOf(threadId, 6_000);
    },
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  // The Builds stage watches the open game's chat; another game's opens it in its place.
  let stop = store.watchThread("racing");
  await settle();
  for (const game of ["puzzle", "racing", "puzzle", "racing"]) {
    stop();
    stop = store.watchThread(game);
    await settle();
  }
  assert.deepEqual(reads, ["racing", "puzzle"], "each game's whole log is read once");
  assert.equal(store.getState().byThread.racing?.length, 6_000);
  assert.equal(store.getState().byThread.puzzle?.length, 6_000, "the game left a moment ago keeps its whole log");
  stop();
});

it("a thousand-step graph folds once when workers add no missing lifecycle", async () => {
  const { largeBuildGraph } = await import("../helpers/large-build-graph.ts");
  const { projectBuildGraph } = await import("../../src/renderer/build-progress.ts");
  const { buildRunGraph } = await import("../../src/renderer/run-graph.ts");
  const fixture = largeBuildGraph();
  let folds = 0;
  const fold: typeof buildRunGraph = (events) => {
    folds++;
    return buildRunGraph(events);
  };
  const graph = projectBuildGraph(fixture.events, "lead", fixture.threads, null, null, { fold });
  assert.equal(graph?.facets.length, 5);
  assert.equal(graph?.nodes.filter((node) => node.kind === "iteration").length, 1_000);
  assert.equal(folds, ceilings.foldsWithCompleteLifecycle);
  folds = 0;
  projectBuildGraph(fixture.events, "lead", fixture.threads, null, null, { fold, includeWorkers: false });
  assert.equal(folds, ceilings.foldsWithHiddenWorkers);
});

it("the Builds graph reads a Loop's log a bounded number of times however many workers it started", async () => {
  const { projectBuildGraph } = await import("../../src/renderer/build-progress.ts");
  const { CustomEvent } = await import("../../src/shared/custom-events.ts");
  const { poolWorkerId, WorkerEnd, WorkerIsolation } = await import("../../src/shared/workers.ts");
  const runId = "loop-run";
  const custom = (n: number, eventType: string, payload: Record<string, unknown>): EventEnvelope => ({
    ...event(String(n).padStart(8, "0")),
    data: { type: EventKind.Custom, event_type: eventType, payload: { runId, ...payload } },
  });
  // A Loop in place: its workers are pool sessions in the lead's own log, with no threads of their own.
  const log = [
    custom(0, CustomEvent.RunStarted, { goal: "Make it", project: "game", mode: "director" }),
    custom(1, CustomEvent.AutopilotStarted, { facets: [], director: true, workerRecords: true, profile: "open" }),
  ];
  for (let n = 0; n < 300; n++) {
    const worker = { workerId: poolWorkerId(`w${n}`), title: `Piece ${n}` };
    log.push(
      custom(log.length, CustomEvent.WorkerStarted, { ...worker, isolation: WorkerIsolation.Copy, task: "Make it" }),
    );
    log.push(custom(log.length, CustomEvent.WorkerFinished, { ...worker, state: WorkerEnd.Done, summary: "Made it" }));
  }
  let reads = 0;
  for (const item of log) {
    const data = item.data;
    Object.defineProperty(item, "data", {
      get: () => {
        reads++;
        return data;
      },
    });
  }
  const graph = projectBuildGraph(log, "lead", [], null, null, { includeWorkers: true });
  assert.equal(graph?.facets.length, 300);
  assert.ok(reads / log.length <= ceilings.loopLogReadsPerEvent, `log reads per event: ${reads / log.length}`);
});

it("Live's pictures project each finished or paused earlier run once, however many batches arrive", async () => {
  const { picturesGraph, settledGraphOf, settledKeys } = await import("../../src/renderer/live-views.ts");
  const { buildHistory } = await import("../../src/renderer/build-progress.ts");
  const { buildRunGraph } = await import("../../src/renderer/run-graph.ts");
  const { ObserverLive } = await import("../../src/shared/observers.ts");
  const { CustomEvent } = await import("../../src/shared/custom-events.ts");
  const runs = Array.from({ length: 9 }, (_, n) => `run_${n}`);
  const custom = (n: number, eventType: string, payload: Record<string, unknown>): EventEnvelope => ({
    ...event(`e${String(n).padStart(4, "0")}`),
    data: { type: EventKind.Custom, event_type: eventType, payload },
  });
  const log = runs.flatMap((runId, n) => [
    custom(n * 3, CustomEvent.RunStarted, { runId, goal: "Make it", project: "game" }),
    ...(n < runs.length - 1 ? [custom(n * 3 + 1, CustomEvent.RunFinished, { runId, victory: true })] : []),
    // Recovery closes a run the app quit under with its finish, then a pause: it stays paused.
    ...(runId === "run_3" ? [custom(n * 3 + 2, CustomEvent.AutopilotPaused, { runId })] : []),
  ]);
  let projections = 0;
  const graphOf = (runId: string) => {
    projections++;
    return buildRunGraph(log, runId);
  };
  const cache = new Map();
  const view = { live: ObserverLive.Stills, at: ".", observer: null };
  const shown = buildRunGraph(log, runs.at(-1));
  const keys = settledKeys(log, buildHistory(log, "lead"));
  assert.equal(keys(runs.at(-1) as string), null, "a running run is never kept");
  assert.notEqual(keys("run_3"), null, "a paused run is kept until a record names it again");
  for (let batch = 0; batch < 5; batch++) picturesGraph(shown, runs, settledGraphOf(cache, graphOf, keys), view);
  assert.equal(projections, ceilings.earlierRunsLooked, "each finished or paused earlier run is projected once");
  const reopened = [...log, custom(99, CustomEvent.RunStarted, { runId: "run_7", goal: "More", project: "game" })];
  assert.notEqual(
    settledKeys(reopened, buildHistory(reopened, "lead"))("run_7"),
    keys("run_7"),
    "a reopened run is projected afresh",
  );
});

/**
 * A long Loop's chat log: per round, the lead's own tools in a turn of its own, then a builder whose
 * mirrored calls each settle, and the builder's result.
 */
function longLoopChat(rounds: number): EventEnvelope[] {
  const log: EventEnvelope[] = [];
  const push = (turn: string, data: EventEnvelope["data"]) =>
    log.push({ ...event(String(log.length).padStart(8, "0")), turn_id: turn, data });
  const trace = (turn: string, delegationId: string, payload: Record<string, unknown>) =>
    push(turn, {
      type: EventKind.Custom,
      event_type: "delegated.claude-code",
      payload: { runId: "r", delegationId, ...payload },
    });
  for (let round = 0; round < rounds; round++) {
    const turn = `turn-${round}`;
    const delegationId = `builder-${round}`;
    push(turn, { type: EventKind.TurnStarted });
    for (let call = 0; call < 10; call++) {
      const id = `${turn}-call-${call}`;
      push(turn, { type: EventKind.ToolRequested, tool_call_id: id, request: { name: "Read", arguments: {} } });
      push(turn, { type: EventKind.ToolResult, tool_call_id: id, result: { ok: true, content: "ok" } });
    }
    for (let call = 0; call < 10; call++) {
      const id = `use-${call}`;
      trace(turn, delegationId, {
        kind: "assistant",
        data: { parts: [{ type: "tool_use", id, name: "Edit", input: {} }] },
      });
      trace(turn, delegationId, {
        kind: "user",
        data: { parts: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
      });
    }
    trace(turn, delegationId, { kind: "result", data: {} });
    push(turn, { type: EventKind.TurnEnded, status: "ok" });
  }
  return log;
}

it("a long Loop's chat settles its running tools without reading every row it ever made", async () => {
  const { toEntries } = await import("../../src/renderer/chat-entries.ts");
  // Every pass over the chat's tool rows walks a Map; count the steps of all of them.
  const iterator = Object.getPrototypeOf(new Map().entries()) as { next: (...args: unknown[]) => unknown };
  const next = iterator.next;
  let steps = 0;
  iterator.next = function (this: unknown, ...args: unknown[]) {
    steps++;
    return next.apply(this, args);
  };
  const stepsPerEvent = (rounds: number): number => {
    const log = longLoopChat(rounds);
    steps = 0;
    toEntries(log);
    return steps / log.length;
  };
  try {
    const short = stepsPerEvent(20);
    const long = stepsPerEvent(200);
    assert.ok(long <= ceilings.chatRowStepsPerEvent, `row steps per event: ${long}`);
    assert.ok(long <= short * 1.5, `a ten times longer chat takes ${long / short} times the steps per event`);
  } finally {
    iterator.next = next;
  }
});

it("coordinator status is transient and never triggers event polling", async () => {
  const { uiEventReads } = await import("../../src/renderer/state/ui-event-routes.ts");
  const { UiEvent } = await import("../../src/shared/ui-events.ts");
  assert.equal(uiEventReads({ type: UiEvent.CoordinatorStatus, payload: {} }).events, false);
});
