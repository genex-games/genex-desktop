/**
 * The Building card's checklist (chat/build-checklist.ts): every part of a running build once —
 * the plan's parts and any other a worker built, a restart on its part's row — added, working or
 * still to come, and last the lead putting it together; and the card's one line, counted from it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildChecklist, checklistCaption, PartMark, runPlanParts } from "../../src/renderer/chat/build-checklist.ts";
import { BUILD_CHECKLIST_WORDS } from "../../src/renderer/words.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { summarizeRun } from "../../src/shared/run-summary.ts";

const RUN = "run_c";
const PROJECT = "racer";
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);

const event = (id: number, data: EventData): EventEnvelope => ({
  id: String(id).padStart(6, "0"),
  thread_id: "t1",
  turn_id: null,
  session_id: null,
  created_at: new Date(NOW - (100 - id) * MINUTE_MS).toISOString(),
  data,
});
const custom = (id: number, eventType: string, payload: Record<string, unknown>) =>
  event(id, { type: "custom", event_type: eventType, payload: { runId: RUN, project: PROJECT, ...payload } });

const plan = (id: number, parts: Array<[string, string]>) =>
  custom(id, CustomEvent.AutopilotPlanReview, {
    summary: "A night race.",
    waitMinutes: 0,
    facets: parts.map(([partId, title]) => ({ id: partId, title, identity: [], cameras: [], checks: [] })),
  });
const worker = (id: number, workerId: string, title: string, extra: Record<string, unknown> = {}) =>
  custom(id, CustomEvent.DirectorWorker, { workerId, title, mode: "loop", state: "running", ...extra });
const round = (id: number, facetId: string, iteration: number, deadlineMs?: number) =>
  custom(id, CustomEvent.FacetBuildStarted, {
    facetId,
    facetTitle: facetId,
    iteration,
    ...(deadlineMs ? { deadlineMs } : {}),
  });
const merged = (id: number, facetId: string, head: string) =>
  custom(id, CustomEvent.IntegrationMerge, { facetId, head, conflict: false, stage: "director" });

/** The checklist as the card reads it from a log, at `now`. */
function checklistOf(events: EventEnvelope[], { finishing = false, now = NOW } = {}) {
  return buildChecklist({
    summary: summarizeRun(events, PROJECT, RUN),
    plan: runPlanParts(events, RUN),
    finishing,
    now,
  });
}

const rowsOf = (list: ReturnType<typeof checklistOf>) => list?.rows.map((row) => [row.title, row.mark, row.status]);

describe("the Building card's checklist", () => {
  const log = [
    custom(1, CustomEvent.RunStarted, { mode: "director" }),
    plan(2, [
      ["track", "Track and night city"],
      ["cars", "Cars: clear-coat finish"],
      ["sound", "Engine, tyres and rain"],
    ]),
    worker(3, "track", "Track and night city"),
    round(4, "track", 1),
    worker(5, "track", "Track and night city", { state: "done" }),
    merged(6, "track", "a".repeat(40)),
    worker(7, "cars", "Cars: clear-coat finish"),
    round(8, "cars", 2, NOW + 25 * MINUTE_MS),
  ];

  it("lists each planned part in plan order — added, working with its time left, waiting — and last the lead putting it together", () => {
    assert.deepEqual(rowsOf(checklistOf(log)), [
      ["Track and night city", PartMark.Added, BUILD_CHECKLIST_WORDS.added],
      ["Cars: clear-coat finish", PartMark.Working, BUILD_CHECKLIST_WORDS.workingFor(25)],
      ["Engine, tyres and rain", PartMark.Next, BUILD_CHECKLIST_WORDS.waiting],
      [BUILD_CHECKLIST_WORDS.together, PartMark.Next, BUILD_CHECKLIST_WORDS.next],
    ]);
  });

  it("says the round a part is in when its time left is unknown", () => {
    const list = checklistOf([...log, round(9, "sound", 1)]);
    assert.deepEqual(list?.rows[2]?.status, BUILD_CHECKLIST_WORDS.workingRound(1));
  });

  it("drops a round's time left once its model provider goes away: the wait moves its deadline, so it says the round", () => {
    const outage = custom(9, CustomEvent.FacetProviderOutage, {
      facetId: "cars",
      facetTitle: "Cars: clear-coat finish",
      iteration: 2,
      phase: "build",
      lost: "rate_limit",
    });
    const list = checklistOf([...log, outage]);
    assert.deepEqual(list?.rows[1]?.status, BUILD_CHECKLIST_WORDS.workingRound(2));
  });

  it("keeps a restarted part on its own row, under the plan's name", () => {
    const restarted = [
      ...log,
      worker(9, "cars", "Cars: clear-coat finish", { state: "stopped" }),
      worker(10, "cars-2", "Cars again", { replaces: "cars" }),
      round(11, "cars-2", 1, NOW + 40 * MINUTE_MS),
    ];
    const list = checklistOf(restarted);
    assert.equal(list?.rows.length, 4, JSON.stringify(rowsOf(list)));
    assert.deepEqual(list?.rows[1], {
      id: "cars",
      title: "Cars: clear-coat finish",
      mark: PartMark.Working,
      status: BUILD_CHECKLIST_WORDS.workingFor(40),
    });
  });

  it("counts the parts on the card's one line", () => {
    const list = checklistOf(log);
    assert.equal(checklistCaption(list!, false), BUILD_CHECKLIST_WORDS.caption(1, 3, 1));
    assert.equal(BUILD_CHECKLIST_WORDS.caption(7, 9, 2), "7 of 9 parts added · 2 working");
    assert.equal(BUILD_CHECKLIST_WORDS.caption(3, 3, 0), "3 of 3 parts added");
  });

  it("asked to finish, says it is finishing; once nothing runs, the lead's putting it together is the work", () => {
    const list = checklistOf(log, { finishing: true });
    assert.equal(checklistCaption(list!, true), BUILD_CHECKLIST_WORDS.finishing(1));
    const settled = checklistOf([...log, worker(9, "cars", "Cars: clear-coat finish", { state: "done" })], {
      finishing: true,
    });
    assert.equal(checklistCaption(settled!, true), BUILD_CHECKLIST_WORDS.finishing(0));
    assert.deepEqual(settled?.rows.at(-1)?.mark, PartMark.Working, "the lead is putting it together now");
    assert.deepEqual(settled?.rows[1]?.status, BUILD_CHECKLIST_WORDS.notAdded, "a part not added says so");
    assert.deepEqual(settled?.rows[2]?.status, BUILD_CHECKLIST_WORDS.notStarted, "nor will a part not started");
  });

  it("lists a part a worker built outside the plan, and nothing before a plan or a worker", () => {
    const extra = checklistOf([...log, worker(9, "rain", "Rain on the glass"), round(10, "rain", 1)]);
    assert.deepEqual(
      extra?.rows.map((row) => row.id),
      ["track", "cars", "sound", "rain", "together"],
    );
    assert.equal(checklistOf([custom(1, CustomEvent.RunStarted, { mode: "director" })]), null);
  });

  it("lists the workers of a Loop that keeps no plan, by their own records: added by the lead's word, working, or ended", () => {
    const record = (id: number, type: string, workerId: string, title: string, extra: Record<string, unknown> = {}) =>
      custom(id, type, { workerId, title, ...extra });
    const pool = [
      custom(1, CustomEvent.RunStarted, { mode: "director" }),
      record(2, CustomEvent.WorkerStarted, "pool.w1", "Raise the land"),
      record(3, CustomEvent.WorkerFinished, "pool.w1", "Raise the land", { state: "done" }),
      record(4, CustomEvent.WorkerFinished, "pool.w1", "Raise the land", { verdict: "used", merged: true }),
      record(5, CustomEvent.WorkerFinished, "pool.w1", "Raise the land", { verdict: "rejected" }),
      record(6, CustomEvent.WorkerStarted, "pool.w2", "Light the valley"),
      record(7, CustomEvent.WorkerStarted, "pool.w3", "Paint the sky"),
      record(8, CustomEvent.WorkerFinished, "pool.w3", "Paint the sky", { state: "failed" }),
    ];
    assert.deepEqual(rowsOf(checklistOf(pool))?.slice(0, 3), [
      ["Raise the land", PartMark.Added, BUILD_CHECKLIST_WORDS.added],
      ["Light the valley", PartMark.Working, BUILD_CHECKLIST_WORDS.working],
      ["Paint the sky", PartMark.Next, BUILD_CHECKLIST_WORDS.notAdded],
    ]);
  });

  it("reads the newest plan of this run only", () => {
    const replanned = [
      ...log,
      plan(9, [
        ["track", "Track and night city"],
        ["cars", "Cars: clear-coat finish"],
      ]),
      custom(10, CustomEvent.AutopilotPlanReview, { runId: "other", facets: [{ id: "x", title: "Another run" }] }),
    ];
    assert.deepEqual(
      runPlanParts(replanned, RUN).map((part) => part.id),
      ["track", "cars"],
    );
  });
});

describe("the building-card dev fixture", () => {
  it("is a Loop still going whose card lists two parts added, one working with its time left, a restart on one row, and one waiting", async () => {
    const { seedBuildingCard } = await import("../../src/main/dev/fixture-building-card.ts");
    const log: EventEnvelope[] = [];
    let seq = 0;
    const core = {
      store: { listEvents: async () => log },
      append: async (events: EventData[]) => {
        for (const data of events) {
          seq += 1;
          log.push({ ...event(seq, data), created_at: new Date(NOW + seq).toISOString() });
        }
      },
    };
    await seedBuildingCard(core as never, "fixture-game", "t1");
    await seedBuildingCard(core as never, "fixture-game", "t1");
    const runId = "fixture-building-card";
    const list = buildChecklist({
      summary: summarizeRun(log, "fixture-game", runId),
      plan: runPlanParts(log, runId),
      finishing: false,
      now: Date.now(),
    });
    assert.deepEqual(
      list?.rows.map((row) => [row.title, row.mark]),
      [
        ["Speed and lap HUD", PartMark.Added],
        ["Track and night city", PartMark.Added],
        ["Cars: clear-coat finish", PartMark.Working],
        ["World: building facades", PartMark.Working],
        ["Engine, tyres and rain", PartMark.Next],
        [BUILD_CHECKLIST_WORDS.together, PartMark.Next],
      ],
    );
    assert.match(String(list?.rows[2]?.status), /^Working · about 2[45] min$/);
    assert.equal(list?.rows[3]?.status, BUILD_CHECKLIST_WORDS.workingRound(1), "the restart's own first round");
    assert.equal(checklistCaption(list!, false), "2 of 5 parts added · 2 working");
    assert.equal(log.filter((e) => e.data.type === "messages").length, 1, "seeding again writes nothing");
  });
});
