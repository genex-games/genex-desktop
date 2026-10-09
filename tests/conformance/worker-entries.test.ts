/**
 * Workers in the chat: every worker a lead starts, in a run or in a chat turn, is one line naming
 * its task, rewritten in place when it ends and when the lead marks it, in plain words. A line
 * never names an id or how the worker stands in the game.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { EntryAction, EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { transcriptEntries } from "../../src/renderer/chat/transcript.ts";
import { buildRunGraph } from "../../src/renderer/run-graph.ts";
import { partRows, StepState, stepWord } from "../../src/renderer/run-steps.ts";
import { buildsLayout, LeadFace, leadFace } from "../../src/renderer/run-tree.ts";
import { summarizeRun } from "../../src/shared/run-summary.ts";
import { CHAT_PAGE_SIZE, chatContext, mergeChatEvents } from "../../src/shared/chat-history.ts";
import { planRewind, withoutRewound } from "../../src/shared/chat-rewind.ts";
import { CustomEvent, customEvent } from "../../src/shared/custom-events.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";

const RUN = "r-loop";
const TURN = "m-turn";
/** Words the person never reads on a worker's line. */
const INTERNAL_WORDS = /reader|writer|editor|copy|lock|merge|isolation|sandbox|seat|pool\.|w1|agent-/i;

const event = (id: number, data: EventData): EventEnvelope => ({
  id: String(id).padStart(6, "0"),
  thread_id: "t1",
  turn_id: null,
  session_id: null,
  created_at: new Date(id).toISOString(),
  data,
});
const custom = (id: number, eventType: string, payload: Record<string, unknown>) =>
  event(id, { type: "custom", event_type: eventType, payload });
/** Where a record belongs: a run, or (with no run) a chat turn. */
type Scope = { runId: string } | { turn: string };
const inRun: Scope = { runId: RUN };
const inTurn: Scope = { turn: TURN };
const started = (id: number, workerId: string, title: string, scope: Scope, extra: Record<string, unknown> = {}) =>
  custom(id, CustomEvent.WorkerStarted, {
    ...scope,
    project: "valley",
    workerId,
    title,
    isolation: "copy",
    task: `${title}, please`,
    at: "2026-01-01T12:00:00.000Z",
    ...extra,
  });
const finished = (id: number, workerId: string, title: string, scope: Scope, extra: Record<string, unknown> = {}) =>
  custom(id, CustomEvent.WorkerFinished, {
    ...scope,
    project: "valley",
    workerId,
    title,
    at: "2026-01-01T12:04:00.000Z",
    ...extra,
  });

type ActionEntry = Extract<ReturnType<typeof toEntries>[number], { kind: typeof EntryKind.Action }>;
const isWorkerLine = (entry: { kind: string; action?: string }): entry is ActionEntry =>
  entry.kind === EntryKind.Action && entry.action === EntryAction.Worker;
const workerLines = (events: EventEnvelope[]): string[] =>
  toEntries(events).flatMap((entry) => (isWorkerLine(entry) ? [entry.text] : []));

it("one line per worker, naming it, rewritten when it ends", () => {
  assert.deepEqual(workerLines([started(1, "pool.w1", "Check the physics", inTurn)]), ["Check the physics…"]);
  assert.deepEqual(
    workerLines([
      started(1, "pool.w1", "Check the physics", inTurn),
      started(2, "pool.w2", "Center the steering", inTurn),
      finished(3, "pool.w1", "Check the physics", inTurn, {
        state: "done",
        summary: "Checked the physics: the front wheels sit off center.",
      }),
    ]),
    ["Checked the physics: the front wheels sit off center.", "Center the steering…"],
    "the end rewrites its own worker's line and leaves the other working",
  );
  assert.deepEqual(
    workerLines([started(1, "unreal-track", "Build the track", inRun, { isolation: "lock", in: "unreal" })]),
    ["Build the track in Unreal…"],
  );
  assert.deepEqual(
    workerLines([started(1, "pool.w3", "Tune the menu", inRun, { isolation: "lock", in: "web" })]),
    ["Tune the menu…"],
    "a worker in the web game's own folder just works",
  );
});

it("says where an in-place worker works by the lock it holds, before the engine an older record names", () => {
  const line = (extra: Record<string, unknown>) =>
    workerLines([started(1, "pool.w1", "Build the track", inRun, { isolation: "lock", ...extra })]);
  assert.deepEqual(line({ where: "Unreal" }), ["Build the track in Unreal…"]);
  assert.deepEqual(
    line({ where: "Toy editor", in: "unreal" }),
    ["Build the track in Toy editor…"],
    "where wins over in",
  );
  assert.deepEqual(line({ where: 7, in: "unreal" }), ["Build the track in Unreal…"], "a where that is no text");
  assert.deepEqual(line({ where: "  " }), ["Build the track…"], "an empty where");
});

it("says how the worker ended: added, done with its summary, not used with the note, didn't finish with why in the app's words, stopped", () => {
  const ending = (...rest: Array<Record<string, unknown>>) =>
    workerLines([
      started(1, "pool.w1", "Port the car", inRun),
      ...rest.map((payload, index) => finished(2 + index, "pool.w1", "Port the car", inRun, payload)),
    ]);
  const cases: Array<[string, string[], string]> = [
    [
      "used and added",
      ending(
        { state: "done", summary: "Ported the car.", delivered: true },
        { verdict: "used", merged: true, summary: "Ported the car." },
      ),
      "Ported the car. Added to your game.",
    ],
    ["done with its summary", ending({ state: "done", summary: "Ported the car" }), "Ported the car."],
    [
      "done in place in the game",
      ending({ state: "done", summary: "Ported the car.", inGame: true }),
      "Ported the car. Added to your game.",
    ],
    ["done with no summary", ending({ state: "done" }), "Port the car."],
    [
      "used, not added yet",
      ending({ state: "done", summary: "Ported the car." }, { verdict: "used" }),
      "Ported the car.",
    ],
    [
      "not used, with the lead's note",
      ending({ state: "done", summary: "Ported the car." }, { verdict: "rejected", note: "It broke the jump." }),
      "Ported the car. Not used: It broke the jump.",
    ],
    ["not used, no note", ending({ state: "done" }, { verdict: "rejected" }), "Port the car. Not used."],
    [
      "didn't finish: the host refused it, in the app's words, never the lead's",
      ending({
        state: "failed",
        stoppedBecause:
          "Genex did not start it: this chat already runs 3 workers, the most the person's Settings allow: wait for one to finish (worker_wait)",
        stopCode: "host_refused",
      }),
      "Port the car: didn't finish. Your Settings allow no more workers at once.",
    ],
    [
      "didn't finish: an error, in the app's words",
      ending({ state: "failed", stoppedBecause: "API Error: 529 overloaded", stopCode: "error" }),
      "Port the car: didn't finish. It ran into an error.",
    ],
    [
      "didn't finish, with only the harness's own words: none of them",
      ending({ state: "failed", stoppedBecause: "the session ran out of time" }),
      "Port the car: didn't finish.",
    ],
    ["didn't finish, no why", ending({ state: "failed" }), "Port the car: didn't finish."],
    ["stopped", ending({ state: "stopped", stoppedBecause: "the person stopped it" }), "Port the car: stopped."],
  ];
  for (const [name, lines, line] of cases) {
    assert.deepEqual(lines, [line], name);
    assert.doesNotMatch(line, INTERNAL_WORDS, name);
  }
});

it("work in the game stays in the game: a rejection after it was added changes nothing, as on its row", () => {
  const lines = (...events: EventEnvelope[]) =>
    toEntries(events)
      .filter(isWorkerLine)
      .map((line) => [line.text, line.workerDone]);
  assert.deepEqual(
    lines(
      started(1, "pool.w1", "Tune the jump", inTurn, { isolation: "lock" }),
      finished(2, "pool.w1", "Tune the jump", inTurn, { state: "done", inGame: true }),
      finished(3, "pool.w1", "Tune the jump", inTurn, { verdict: "rejected", note: "too floaty" }),
    ),
    [["Tune the jump. Added to your game.", true]],
    "written in place and finished, then rejected",
  );
  assert.deepEqual(
    lines(
      started(1, "pool.w1", "Center the steering", inTurn),
      finished(2, "pool.w1", "Center the steering", inTurn, {
        state: "done",
        summary: "Centered it.",
        delivered: true,
      }),
      finished(3, "pool.w1", "Center the steering", inTurn, { verdict: "used", merged: true }),
      finished(4, "pool.w1", "Center the steering", inTurn, { verdict: "rejected", note: "pulls left" }),
    ),
    [["Centered it. Added to your game.", true]],
    "used and added, then rejected",
  );
});

it("a worker record's fields are read only from their own words: a hostile one reads as if it were absent", () => {
  const hostile: Array<[string, Record<string, unknown>, string]> = [
    ["a stop code no table knows", { state: "failed", stopCode: "busy" }, "stopCode"],
    ["a stop code naming an object's own key", { state: "failed", stopCode: "__proto__" }, "stopCode"],
    ["a stop code that is a number", { state: "failed", stopCode: 3 }, "stopCode"],
    ["a state of another vocabulary", { state: "finished", summary: "Ported it." }, "state"],
    ["a state in capitals", { state: "DONE", summary: "Ported it." }, "state"],
    ["a verdict in capitals", { verdict: "USED", merged: false }, "verdict"],
    ["a verdict that is an object", { verdict: {} }, "verdict"],
    ["a summary that is a number", { state: "done", summary: 42 }, "summary"],
  ];
  const before = finished(2, "pool.w1", "Port the car", inRun, { state: "done", summary: "Ported the car." });
  const resumed = started(4, "pool.w1", "Port the car", inRun);
  // Around the record: alone, after an end it must not undo, and before a start that resumes a worker it did not end.
  const around: Array<[string, EventEnvelope[], EventEnvelope[]]> = [
    ["alone", [], []],
    ["after an end", [before], []],
    ["before a resume", [], [resumed]],
  ];
  for (const [name, payload, field] of hostile) {
    const { [field]: _dropped, ...absent } = payload;
    for (const [where, prior, after] of around) {
      const lines = (end: Record<string, unknown>): string[] =>
        workerLines([
          started(1, "pool.w1", "Port the car", inRun),
          ...prior,
          finished(3, "pool.w1", "Port the car", inRun, end),
          ...after,
        ]);
      assert.doesNotThrow(() => lines(payload), `${name}, ${where}`);
      assert.deepEqual(lines(payload), lines(absent), `${name}, ${where}`);
    }
  }
});

it("the line is never folded into the activity row", () => {
  const entries = toEntries([
    custom(1, CustomEvent.RunStarted, { runId: RUN }),
    started(2, "pool.w1", "Study the web game", inRun, { isolation: "read" }),
    custom(3, CustomEvent.RunStarted, { runId: "r-next" }),
    finished(4, "pool.w1", "Study the web game", inRun, { state: "done" }),
  ]);
  const folded = entries.flatMap((entry) => (entry.kind === EntryKind.Activity ? entry.rows.map((r) => r.text) : []));
  assert.ok(folded.length > 0, "the run's own narration folds");
  assert.ok(!folded.some((text) => text.includes("Study the web game")));
  assert.deepEqual(
    entries.filter(isWorkerLine).map((entry) => entry.text),
    ["Study the web game."],
  );
});

it("a resumed worker's second start and an end with no start on the page make one line each", () => {
  assert.deepEqual(
    workerLines([
      started(1, "pool.w1", "Port the car", inRun),
      started(2, "pool.w1", "Port the car", inRun),
      finished(3, "pool.w1", "Port the car", inRun, { state: "done", summary: "Ported the car." }),
    ]),
    ["Ported the car."],
  );
  assert.deepEqual(
    workerLines([
      finished(1, "pool.w2", "Build the track", inRun, { state: "done", summary: "Built the track." }),
      finished(2, "pool.w2", "Build the track", inRun, { verdict: "used", merged: true }),
      finished(3, "pool.w2", "Build the track", inRun, { state: "done" }),
    ]),
    ["Built the track. Added to your game."],
    "the end draws its line once; the verdict and a repeated end rewrite it",
  );
  assert.deepEqual(
    workerLines([started(1, "", "Nameless", inRun), finished(2, "pool.w9", "", inRun, { state: "done" })]),
    [],
    "a record with no id, or an end with no title and no start, draws nothing",
  );
});

it("a worker started again after it ended is a new attempt: a line of its own, nothing of the old end carried over", () => {
  const sword = (id: number, extra: Record<string, unknown>) => finished(id, "sword", "Sword", inRun, extra);
  const firstAttempt = [
    started(1, "sword", "Sword", inRun),
    sword(2, { state: "stopped" }),
    sword(3, { verdict: "rejected", note: "the blade clips the hand" }),
  ];
  assert.deepEqual(workerLines([...firstAttempt, started(4, "sword", "Sword", inRun)]), [
    "Sword. Not used: the blade clips the hand",
    "Sword…",
  ]);
  const secondEnded = [...firstAttempt, started(4, "sword", "Sword", inRun), sword(5, { state: "done" })];
  const lines = toEntries(secondEnded).filter(isWorkerLine);
  assert.deepEqual(
    lines.map((line) => [line.text, line.workerDone]),
    [
      ["Sword. Not used: the blade clips the hand", false],
      ["Sword.", true],
    ],
  );
  assert.deepEqual(
    workerLines(secondEnded.slice(1)),
    ["Sword. Not used: the blade clips the hand", "Sword."],
    "with the first start before the page, the same lines",
  );
});

it("a run's and a chat turn's workers get lines; a lead's milestone rows get none; the same id in two turns is two lines", () => {
  assert.deepEqual(
    workerLines([
      custom(1, CustomEvent.DirectorWorker, {
        runId: RUN,
        facetId: "lead",
        title: "Lay out the level",
        state: "running",
      }),
      custom(2, CustomEvent.DirectorWorker, {
        runId: RUN,
        facetId: "lead-m1",
        title: "Make it drive",
        state: "running",
      }),
      started(3, "agent-blender", "Model the bike", inRun),
      started(4, "pool.w1", "Check the physics", inTurn),
      started(5, "pool.w1", "Check the brakes", { turn: "m-later" }),
      finished(6, "pool.w1", "Check the physics", inTurn, { state: "done" }),
    ]),
    ["Model the bike…", "Check the physics.", "Check the brakes…"],
  );
});

it("a worker starting in a run leaves that run's held plan card waiting for the person", () => {
  const held = custom(1, CustomEvent.AutopilotPlanReview, { runId: RUN, plan: "Port the car", waitMinutes: 5 });
  const waiting = (events: EventEnvelope[]) =>
    toEntries(events).flatMap((entry) =>
      entry.kind === EntryKind.Action && entry.action === EntryAction.Steer ? [entry.pending] : [],
    );
  assert.deepEqual(waiting([held]), [true]);
  assert.deepEqual(waiting([held, started(2, "pool.w1", "Port the car", inRun)]), [true]);
});

it("a run that closes leaves none of its workers working: their lines read stopped and stay unpinned", () => {
  const log = [
    custom(1, CustomEvent.RunStarted, { runId: RUN, project: "valley", mode: "director" }),
    started(2, "port-car", "Port the car", inRun),
    started(3, "pool.w1", "Check the physics", inTurn),
    started(4, "trim-menu", "Trim the menu", inRun),
    finished(5, "trim-menu", "Trim the menu", inRun, { state: "done", summary: "Trimmed the menu." }),
    custom(6, CustomEvent.RunFinished, { runId: RUN, project: "valley", interrupted: true, victory: false }),
  ];
  assert.deepEqual(
    workerLines(log),
    ["Port the car: stopped.", "Check the physics…", "Trimmed the menu."],
    "the run's open worker stops with it; a chat turn's worker and an ended one keep their words",
  );
  const replies = Array.from({ length: CHAT_PAGE_SIZE + 10 }, (_, index) =>
    event(10 + index, { type: "messages", messages: [{ role: "assistant", content: `step ${index}` }] }),
  );
  const page = [...log, ...replies].slice(-CHAT_PAGE_SIZE);
  const threadEvents = mergeChatEvents(chatContext([], [...log, ...replies]), page);
  const pinned = transcriptEntries({
    events: page,
    stateEvents: threadEvents,
    threadEvents,
    queued: [],
    activeRunId: null,
    studio: false,
  }).flatMap((entry) => (isWorkerLine(entry) ? [entry.text] : []));
  assert.deepEqual(pinned, ["Check the physics…"], "only the chat turn's worker still working stays pinned");
});

it("a closed run's open workers read stopped on their rows and on their lines alike, from the same log", () => {
  const closes: Array<[string, Record<string, unknown>]> = [
    ["interrupted", { interrupted: true, victory: false }],
    ["the director's paused close", { mode: "director", paused: true, landed: false }],
  ];
  for (const [name, close] of closes) {
    const log: EventEnvelope[] = [
      custom(1, CustomEvent.RunStarted, { runId: RUN, project: "valley", mode: "director" }),
      custom(2, CustomEvent.AutopilotStarted, { runId: RUN, project: "valley", director: true, workerRecords: true }),
      custom(3, CustomEvent.DirectorWorker, {
        runId: RUN,
        project: "valley",
        workerId: "port-car",
        title: "Port the car",
        mode: "single",
        state: "running",
      }),
      started(4, "port-car", "Port the car", inRun),
      started(5, "pool.w1", "Check the physics", inRun),
      custom(6, CustomEvent.RunFinished, { runId: RUN, project: "valley", ...close }),
    ];
    const graph = buildRunGraph(log, RUN);
    assert.ok(graph?.tree, name);
    const summary = summarizeRun(log, "valley", RUN);
    graph.summary = summary;
    const rows = partRows(graph, summary);
    const layout = buildsLayout(graph, rows, summary);
    const rowSaid = rows.flatMap((row) =>
      row.steps.map((step) => [
        row.facet.title,
        stepWord(step, graph.active),
        step.state,
        layout.ghosts.has(`session:${row.facet.facetId}`),
      ]),
    );
    assert.deepEqual(
      rowSaid,
      [
        ["Port the car", "Stopped", StepState.NotInBuild, true],
        ["Check the physics", "Stopped", StepState.NotInBuild, true],
      ],
      `${name}: each row stopped, a ghost`,
    );
    assert.notEqual(leadFace(graph, summary, rows), LeadFace.Waiting, `${name}: the lead waits for nobody`);
    assert.deepEqual(
      workerLines(log),
      ["Port the car: stopped.", "Check the physics: stopped."],
      `${name}: the lines say what the rows say`,
    );
  }
});

it("each layer settles a closed run's open workers on its own: the paging facts, and the transcript's pins", () => {
  const log = [
    custom(1, CustomEvent.RunStarted, { runId: RUN, project: "valley", mode: "director" }),
    started(2, "port-car", "Port the car", inRun),
    started(3, "pool.w1", "Check the physics", inTurn),
    custom(4, CustomEvent.RunFinished, { runId: RUN, project: "valley", interrupted: true, victory: false }),
  ];
  const startFacts = chatContext([], log).flatMap((fact) => {
    const start = customEvent(fact, CustomEvent.WorkerStarted);
    return start ? [start.workerId] : [];
  });
  assert.deepEqual(startFacts, ["pool.w1"], "the closed run's worker keeps no fact; the chat turn's does");
  const replies = Array.from({ length: 3 }, (_, index) =>
    event(10 + index, { type: "messages", messages: [{ role: "assistant", content: `step ${index}` }] }),
  );
  // The thread's events as they are, with no paging fact settled for them.
  const threadEvents = mergeChatEvents(log, replies);
  const pinned = transcriptEntries({
    events: replies,
    stateEvents: threadEvents,
    threadEvents,
    queued: [],
    activeRunId: null,
    studio: false,
  }).flatMap((entry) => (isWorkerLine(entry) ? [entry.text] : []));
  assert.deepEqual(pinned, ["Check the physics…"], "the transcript pins no worker of a closed run");
});

it("a running worker's line survives a page boundary", () => {
  const replies = Array.from({ length: CHAT_PAGE_SIZE + 40 }, (_, index) =>
    event(10 + index, { type: "messages", messages: [{ role: "assistant", content: `step ${index}` }] }),
  );
  const log = [
    started(1, "pool.w1", "Check the physics", inTurn),
    started(2, "pool.w2", "Center the steering", inTurn),
    started(3, "pool.w3", "Tune the menu", inTurn),
    finished(4, "pool.w3", "Tune the menu", inTurn, { state: "done" }),
    ...replies,
    finished(500, "pool.w2", "Center the steering", inTurn, { state: "done", summary: "Centered the steering." }),
    finished(501, "pool.w2", "Center the steering", inTurn, { verdict: "used", merged: true }),
  ];
  const page = log.slice(-CHAT_PAGE_SIZE);
  const threadEvents = mergeChatEvents(chatContext([], log), page);
  const lines = transcriptEntries({
    events: page,
    stateEvents: threadEvents,
    threadEvents,
    queued: [],
    activeRunId: null,
    studio: false,
  }).flatMap((entry) => (isWorkerLine(entry) ? [entry.text] : []));
  assert.deepEqual(lines, ["Check the physics…", "Centered the steering. Added to your game."]);
});

it("a rewind keeps a worker's end whose start stays, and the start of a worker still working", () => {
  const user = (id: number, content: string) => event(id, { type: "messages", messages: [{ role: "user", content }] });
  const reply = (id: number, content: string) =>
    event(id, { type: "messages", messages: [{ role: "assistant", content }] });
  const queued = (id: number, kind: string, messageId: string, extra: Record<string, unknown> = {}) =>
    custom(id, kind, { messageId, ...extra });
  const log = [
    user(1, "Make the car drift less"),
    queued(2, CustomEvent.CoordinatorMessageQueued, "a", { eventId: "000001" }),
    queued(3, CustomEvent.CoordinatorMessageProcessing, "a"),
    started(4, "pool.w1", "Check the physics", { turn: "a" }),
    reply(5, "On it."),
    queued(6, CustomEvent.CoordinatorMessageHandled, "a"),
    user(7, "And a moat"),
    queued(8, CustomEvent.CoordinatorMessageQueued, "b", { eventId: "000007" }),
    queued(9, CustomEvent.CoordinatorMessageProcessing, "b"),
    finished(10, "pool.w1", "Check the physics", { turn: "a" }, { state: "done", summary: "Checked the physics." }),
    started(11, "pool.w1", "Dig the moat", { turn: "b" }),
    started(12, "pool.w2", "Fill the moat", { turn: "b" }),
    finished(13, "pool.w2", "Fill the moat", { turn: "b" }, { state: "done" }),
    reply(14, "Moat dug."),
    queued(15, CustomEvent.CoordinatorMessageHandled, "b"),
  ];
  const planned = planRewind(log, [], "b");
  assert.ok(planned.ok);
  assert.deepEqual(planned.rewind.keep, ["000010", "000011"]);
  assert.deepEqual(workerLines(withoutRewound(log, [planned.rewind])), ["Checked the physics.", "Dig the moat…"]);
});

it("a builder its run's lead integrates says it is in the game, as its row does; a conflict or another run's merge does not", () => {
  const merge = (id: number, facetId: string, runId: string, extra: Record<string, unknown> = {}) =>
    custom(id, CustomEvent.IntegrationMerge, { runId, facetId, commit: "c1", head: "h1", conflict: false, ...extra });
  const builder = [
    started(1, "sky", "Make the sky", inRun),
    finished(2, "sky", "Make the sky", inRun, { state: "done", summary: "Made the sky." }),
  ];
  assert.deepEqual(workerLines([...builder, merge(3, "sky", RUN)]), ["Made the sky. Added to your game."]);
  assert.deepEqual(
    workerLines([builder[0], merge(2, "sky", RUN), builder[1]]),
    ["Made the sky. Added to your game."],
    "integrated before its end reached the log",
  );
  assert.deepEqual(workerLines([...builder, merge(3, "sky", RUN, { conflict: true })]), ["Made the sky."]);
  assert.deepEqual(workerLines([...builder, merge(3, "sky", "r-other")]), ["Made the sky."]);
  assert.deepEqual(workerLines([...builder, merge(3, "sea", RUN)]), ["Made the sky."]);
  assert.deepEqual(
    workerLines([...builder, merge(3, "sky", RUN), finished(4, "sky", "Make the sky", inRun, { verdict: "rejected" })]),
    ["Made the sky. Added to your game."],
    "a rejection after it went in changes nothing",
  );
});

it("work in the game reads added once its worker is over, however it ended, as on its row: stopped, failed, or cut off by its run's end", () => {
  const merge = (id: number) =>
    custom(id, CustomEvent.IntegrationMerge, {
      runId: RUN,
      facetId: "land",
      commit: "c1",
      head: "h1",
      conflict: false,
    });
  const lines = (...events: EventEnvelope[]) =>
    toEntries(events)
      .filter(isWorkerLine)
      .map((line) => [line.text, line.workerDone]);
  const added = [["Raise the land. Added to your game.", true]];
  const begun = [
    custom(1, CustomEvent.RunStarted, { runId: RUN, project: "valley", mode: "director" }),
    started(2, "land", "Raise the land", inRun),
    merge(3),
  ];
  assert.deepEqual(
    lines(...begun),
    [["Raise the land…", false]],
    "added once, still at work on its next round: working, as its row says",
  );
  assert.deepEqual(
    lines(...begun, finished(4, "land", "Raise the land", inRun, { state: "stopped" })),
    added,
    "added, then stopped",
  );
  assert.deepEqual(
    lines(...begun, finished(4, "land", "Raise the land", inRun, { state: "failed", stopCode: "error" })),
    added,
    "added, then failed",
  );
  assert.deepEqual(
    lines(
      ...begun,
      custom(4, CustomEvent.RunFinished, { runId: RUN, project: "valley", interrupted: true, victory: false }),
    ),
    added,
    "added, then its run ended before its end reached the log",
  );
});
