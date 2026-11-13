/**
 * The Building card's checklist (chat/build-checklist.ts): the steps of a running build a person can
 * read — each save point its lead made, by its label, then each part a worker built, a restart on its
 * part's row — and never the lead itself or a last step of putting it together; and the card's one
 * line, counted from it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { savePointRound } from "../../src/harness-seed/loop/director/open/graph.ts";
import {
  buildChecklist,
  CHECKLIST_FOLD_PAST,
  CHECKLIST_ROWS_SHOWN,
  type ChecklistRow,
  checklistCaption,
  foldChecklist,
  PartMark,
} from "../../src/renderer/chat/build-checklist.ts";
import { EntryAction, EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { buildHistory } from "../../src/renderer/build-progress.ts";
import { BuildBarShape, buildBarShape } from "../../src/renderer/panels/run-graph/bar-shape.ts";
import { BUILD_CHECKLIST_WORDS } from "../../src/renderer/words.ts";
import { CHAT_PAGE_SIZE } from "../../src/shared/chat-history.ts";
import { CustomEvent, customPayload, LEAD_PART } from "../../src/shared/custom-events.ts";
import { type EventData, type EventEnvelope, EventKind } from "../../src/shared/event-log.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { RunState } from "../../src/shared/run-state.ts";
import { summarizeRun } from "../../src/shared/run-summary.ts";
import { WorkerEnd, WorkerVerdict } from "../../src/shared/workers.ts";

const RUN = "run_c";
const PROJECT = "racer";
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
/** A tool call of the lead's turn: what fills the chat between its save points. */
const READ_CALL = { name: "Read", arguments: {} };

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

const worker = (id: number, workerId: string, title: string, extra: Record<string, unknown> = {}) =>
  custom(id, CustomEvent.DirectorWorker, { workerId, title, mode: "loop", state: "running", ...extra });
const round = (id: number, facetId: string, iteration: number, deadlineMs?: number) =>
  custom(id, CustomEvent.FacetBuildStarted, { facetId, iteration, ...(deadlineMs ? { deadlineMs } : {}) });
const merged = (id: number, facetId: string, head: string) =>
  custom(id, CustomEvent.IntegrationMerge, { facetId, head, conflict: false, stage: "director" });
/** A pool worker's own record: its start, or its end and the lead's word on it. */
const record = (id: number, type: string, workerId: string, title: string, extra: Record<string, unknown> = {}) =>
  custom(id, type, { workerId, title, ...extra });

/**
 * A save point of the open Loop's lead, written into `log` as the seed writes it (`savePointRound`):
 * the lead's own row at the first, its kept round under its label, and its merge into the game folder.
 */
async function leadSaves(log: EventEnvelope[], at: number, label: string, auto = false): Promise<void> {
  const loopRun = {
    run: { runId: RUN, project: PROJECT },
    ctx: { call: async () => null },
    appendRun: async (type: string, payload: Record<string, unknown>) => {
      log.push(custom(log.length + 1, type, payload));
    },
  };
  const point = { label, summary: "", snapshotId: `snap-${at}`, auto, at: NOW, notes: [] };
  await savePointRound(loopRun as never, point, at, []);
}

/** The checklist as the card reads it from the summary main builds of the whole log, at `now`. */
function checklistOf(events: EventEnvelope[], { now = NOW } = {}) {
  return buildChecklist(summarizeRun(events, PROJECT, RUN), now);
}

const rowsOf = (list: ReturnType<typeof checklistOf>) => list?.rows.map((row) => [row.title, row.mark, row.status]);

describe("the Building card's checklist", () => {
  /** The owner's tower defense Loop: two save points of its lead, and a music worker whose work it used. */
  async function towerDefense(): Promise<EventEnvelope[]> {
    const log = [custom(1, CustomEvent.RunStarted, { mode: "director" })];
    await leadSaves(log, 1, "Tower defense playable: 4 towers, 15 waves, boss, HUD");
    log.push(record(log.length + 1, CustomEvent.WorkerStarted, "pool.w1", "Battle music loop"));
    log.push(record(log.length + 1, CustomEvent.WorkerFinished, "pool.w1", "Battle music loop", { state: "done" }));
    const used = { verdict: WorkerVerdict.Used, merged: true };
    log.push(record(log.length + 1, CustomEvent.WorkerFinished, "pool.w1", "Battle music loop", used));
    await leadSaves(log, 2, "Tower defense complete: music, tuned difficulty, victory/restart verified");
    return log;
  }

  it("lists the lead's save points by their labels in the order saved, then its workers; never the lead, never a last step of putting it together", async () => {
    assert.deepEqual(rowsOf(checklistOf(await towerDefense())), [
      ["Tower defense playable: 4 towers, 15 waves, boss, HUD", PartMark.Added, BUILD_CHECKLIST_WORDS.added],
      [
        "Tower defense complete: music, tuned difficulty, victory/restart verified",
        PartMark.Added,
        BUILD_CHECKLIST_WORDS.added,
      ],
      ["Battle music loop", PartMark.Added, BUILD_CHECKLIST_WORDS.added],
    ]);
  });

  it("leaves out Genex's autosave between the lead's turns and another run's save points", async () => {
    const log = await towerDefense();
    await leadSaves(log, 3, "Autosave", true);
    const elsewhere = {
      runId: "other",
      facetId: LEAD_PART,
      iteration: 1,
      verdictSource: "lead",
      label: "Another game",
    };
    log.push(custom(log.length + 1, CustomEvent.FacetIteration, elsewhere));
    assert.deepEqual(
      checklistOf(log)?.rows.map((row) => row.title),
      [
        "Tower defense playable: 4 towers, 15 waves, boss, HUD",
        "Tower defense complete: music, tuned difficulty, victory/restart verified",
        "Battle music loop",
      ],
    );
  });

  it("keeps a save point the chat's loaded page no longer holds: the steps come from the run's summary of the whole log", async () => {
    const log = [custom(1, CustomEvent.RunStarted, { mode: "director" })];
    await leadSaves(log, 1, "A car to drive");
    // The lead's turn between the two save points: more tool calls than one page of the chat holds.
    for (let call = 0; call < CHAT_PAGE_SIZE; call++)
      log.push(event(log.length + 1, { type: EventKind.ToolRequested, tool_call_id: `c${call}`, request: READ_CALL }));
    await leadSaves(log, 2, "A full lap");
    const page = log.slice(-CHAT_PAGE_SIZE);
    const labels = page.map((one) => customPayload(one.data, CustomEvent.FacetIteration)?.label);
    assert.ok(!labels.includes("A car to drive"), "the first save point is off the page");
    const list = checklistOf(log);
    assert.deepEqual(
      list?.rows.map((row) => row.title),
      ["A car to drive", "A full lap"],
    );
    assert.equal(list?.done, 2);
  });

  it("counts what is done and what works on the card's one line, with no total to count against", async () => {
    const log = await towerDefense();
    log.push(record(log.length + 1, CustomEvent.WorkerStarted, "pool.w2", "Victory screen"));
    const list = checklistOf(log);
    assert.equal(checklistCaption(list!, false), BUILD_CHECKLIST_WORDS.caption(3, 1));
    assert.equal(BUILD_CHECKLIST_WORDS.caption(3, 1), "3 done · 1 working");
    assert.equal(BUILD_CHECKLIST_WORDS.caption(3, 0), "3 done");
  });

  const log = [
    custom(1, CustomEvent.RunStarted, { mode: "director" }),
    worker(3, "track", "Track and night city"),
    round(4, "track", 1),
    worker(5, "track", "Track and night city", { state: "done" }),
    merged(6, "track", "a".repeat(40)),
    worker(7, "cars", "Cars: clear-coat finish"),
    round(8, "cars", 2, NOW + 25 * MINUTE_MS),
  ];

  it("lists each worker's part by its title: added, or working with its time left", () => {
    assert.deepEqual(rowsOf(checklistOf(log)), [
      ["Track and night city", PartMark.Added, BUILD_CHECKLIST_WORDS.added],
      ["Cars: clear-coat finish", PartMark.Working, BUILD_CHECKLIST_WORDS.workingFor(25)],
    ]);
  });

  it("says the round a part is in when its time left is unknown", () => {
    const list = checklistOf([...log, worker(9, "sound", "Engine, tyres and rain"), round(10, "sound", 1)]);
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

  it("keeps a restarted part on its own row, under its first name", () => {
    const restarted = [
      ...log,
      worker(9, "cars", "Cars: clear-coat finish", { state: "stopped" }),
      worker(10, "cars-2", "Cars again", { replaces: "cars" }),
      round(11, "cars-2", 1, NOW + 40 * MINUTE_MS),
    ];
    const list = checklistOf(restarted);
    assert.equal(list?.rows.length, 2, JSON.stringify(rowsOf(list)));
    assert.deepEqual(list?.rows[1], {
      id: "cars",
      title: "Cars: clear-coat finish",
      mark: PartMark.Working,
      status: BUILD_CHECKLIST_WORDS.workingFor(40),
    });
  });

  it("asked to finish, says it is finishing, and a part that ended without its work says it was not added", () => {
    const list = checklistOf(log);
    assert.equal(checklistCaption(list!, true), BUILD_CHECKLIST_WORDS.finishing(1));
    const settled = checklistOf([...log, worker(9, "cars", "Cars: clear-coat finish", { state: "done" })]);
    assert.equal(checklistCaption(settled!, true), BUILD_CHECKLIST_WORDS.finishing(0));
    assert.deepEqual(settled?.rows[1]?.status, BUILD_CHECKLIST_WORDS.notAdded);
  });

  it("lists nothing before a save point or a worker", () => {
    assert.equal(checklistOf([custom(1, CustomEvent.RunStarted, { mode: "director" })]), null);
  });

  it("lists the workers of a Loop by their own records: added by the lead's word, working, or ended", () => {
    const pool = [
      custom(1, CustomEvent.RunStarted, { mode: "director" }),
      record(2, CustomEvent.WorkerStarted, "pool.w1", "Raise the land"),
      record(3, CustomEvent.WorkerFinished, "pool.w1", "Raise the land", { state: WorkerEnd.Done }),
      record(4, CustomEvent.WorkerFinished, "pool.w1", "Raise the land", { verdict: WorkerVerdict.Used, merged: true }),
      record(5, CustomEvent.WorkerFinished, "pool.w1", "Raise the land", { verdict: WorkerVerdict.Rejected }),
      record(6, CustomEvent.WorkerStarted, "pool.w2", "Light the valley"),
      record(7, CustomEvent.WorkerStarted, "pool.w3", "Paint the sky"),
      record(8, CustomEvent.WorkerFinished, "pool.w3", "Paint the sky", { state: WorkerEnd.Failed }),
    ];
    assert.deepEqual(rowsOf(checklistOf(pool)), [
      ["Raise the land", PartMark.Added, BUILD_CHECKLIST_WORDS.added],
      ["Light the valley", PartMark.Working, BUILD_CHECKLIST_WORDS.working],
      ["Paint the sky", PartMark.Next, BUILD_CHECKLIST_WORDS.notAdded],
    ]);
  });
});

describe("the building-card dev fixture", () => {
  it("is a Loop still going whose card lists its lead's two save points, two parts added, one working and a restart on one row", async () => {
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
    const list = buildChecklist(summarizeRun(log, "fixture-game", runId), Date.now());
    assert.deepEqual(
      list?.rows.map((row) => [row.title, row.mark]),
      [
        ["A car to drive on a test loop", PartMark.Added],
        ["A full lap of the night city, with speed and lap time", PartMark.Added],
        ["Speed and lap HUD", PartMark.Added],
        ["Track and night city", PartMark.Added],
        ["Cars: clear-coat finish", PartMark.Working],
        ["World: building facades", PartMark.Working],
      ],
    );
    // Flipped (no clock): the part at work showed its round's time left ("Working · ~25 min"); a Loop's
    // round has no deadline, so it shows its round.
    assert.equal(list?.rows[4]?.status, BUILD_CHECKLIST_WORDS.workingRound(2));
    assert.equal(list?.rows[5]?.status, BUILD_CHECKLIST_WORDS.workingRound(1), "the restart's own first round");
    assert.equal(checklistCaption(list!, false), "4 done · 2 working");
    assert.equal(
      log.filter((e) => e.data.type === "messages").length,
      6,
      "the five earlier Loops' asks and this one's; seeding again writes nothing",
    );
    const told = toEntries(log).flatMap((entry) =>
      entry.kind === EntryKind.Action && entry.action === EntryAction.Told ? [entry.text] : [],
    );
    assert.deepEqual(told, ["Told “Cars: clear-coat finish”: Change from the person: make the cars red."]);
  });

  it("gives the chat more builds than the Builds bar shows as tabs, so it holds them in its picker", async () => {
    const { seedBuildingCard } = await import("../../src/main/dev/fixture-building-card.ts");
    const log: EventEnvelope[] = [];
    const core = {
      store: { listEvents: async () => log },
      append: async (events: EventData[]) => {
        for (const data of events) log.push(event(log.length + 1, data));
      },
    };
    await seedBuildingCard(core as never, "fixture-game", "t1");
    const history = buildHistory(log, "t1");
    assert.equal(history.length, 6);
    assert.equal(history.at(-1)?.state, RunState.Running, "the newest is the Loop still going");
    assert.ok(
      history.every((build) => build.ask.length > 0),
      "each build is named by what was asked",
    );
    assert.equal(buildBarShape(history.length, Number.POSITIVE_INFINITY), BuildBarShape.Picker);
  });
});

describe("the Building card's fold", () => {
  const rows = (count: number): ChecklistRow[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `step-${index + 1}`,
      title: `Step ${index + 1}`,
      mark: PartMark.Added,
      status: BUILD_CHECKLIST_WORDS.added,
    }));
  const ids = (list: ChecklistRow[]): string[] => list.map((row) => row.id);

  it("shows every row of a short list", () => {
    const all = rows(CHECKLIST_FOLD_PAST);
    assert.deepEqual(foldChecklist(all, false), { rows: all, hidden: 0 });
  });

  it("past that, shows the latest rows and counts the earlier ones", () => {
    const all = rows(CHECKLIST_FOLD_PAST + 5);
    const folded = foldChecklist(all, false);
    assert.equal(folded.rows.length, CHECKLIST_ROWS_SHOWN);
    assert.deepEqual(ids(folded.rows), ids(all.slice(-CHECKLIST_ROWS_SHOWN)));
    assert.equal(folded.hidden, all.length - CHECKLIST_ROWS_SHOWN);
  });

  it("shows them all once the person opened the earlier ones", () => {
    const all = rows(CHECKLIST_FOLD_PAST + 5);
    assert.deepEqual(foldChecklist(all, true), { rows: all, hidden: 0 });
  });
});
