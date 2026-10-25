/**
 * The finish check in the chat: while the Loop works its rounds say nothing; once the run ends
 * without the reviewer's yes (not a pause), its result card lists what the harness wrote on the close:
 * what the last no found done and still to fix, why the Loop stopped, and its hours.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { EntryKind, stopWhyLine, toEntries } from "../../src/renderer/chat-entries.ts";
import { morningWords } from "../../src/renderer/morning-words.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";
import { FinishCheckStep, MAX_FINISH_REJECTIONS, StopWhy } from "../../src/shared/finish-check.ts";

const RUN = "r-loop";

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
const check = (id: number, round: number, step: string, extra: Record<string, unknown> = {}) =>
  custom(id, CustomEvent.FinishCheck, { runId: RUN, project: "valley", round, step, ...extra });

const NO_FINISH_LINE = "The track has no finish line, so a lap never ends.";
const NO_TIMER = "The lap timer isn't on screen in any shot.";

/** What the harness writes on a Loop's close without a yes (`run_finished.stillToFix`). */
const left = (extra: Record<string, unknown> = {}) => ({
  done: [],
  notDone: [NO_TIMER],
  why: StopWhy.Stuck,
  hours: null,
  ...extra,
});

/** The result card's still-to-fix lists, when the log ends with one. */
const stillToFixOf = (events: EventEnvelope[]) =>
  toEntries(events).flatMap((entry) => (entry.kind === EntryKind.Morning ? [entry.stillToFix ?? null] : []));
const finished = (id: number, extra: Record<string, unknown> = {}) =>
  custom(id, CustomEvent.RunFinished, { runId: RUN, project: "valley", ...extra });

it("a round of the finish check says nothing in the chat while the Loop works", () => {
  const log = [
    check(1, 1, FinishCheckStep.Checking, { claim: "Done." }),
    check(2, 1, FinishCheckStep.Rejected, { reasons: [NO_FINISH_LINE], notDone: [NO_TIMER], rejections: 1 }),
    check(3, 2, FinishCheckStep.Checking),
    check(4, 2, FinishCheckStep.Unanswered, { why: "the reviewer's session ended", rejections: 1 }),
    check(5, 3, FinishCheckStep.Checking),
    check(6, 3, FinishCheckStep.Rejected, { reasons: [NO_TIMER], rejections: MAX_FINISH_REJECTIONS, timeLeft: true }),
  ];
  assert.deepEqual(toEntries(log), [], "no line, no card, no activity row");
});

it("a Loop's close without a yes lists what the harness wrote on it: done, still to fix, why and its hours", () => {
  const met = "The laps run, as accepted before.";
  const log = [
    check(1, 1, FinishCheckStep.Rejected, { reasons: [met], done: ["Laps run"], notDone: [NO_TIMER], rejections: 3 }),
    finished(2, { victory: false, executionStatus: "completed", stillToFix: left({ done: ["Laps run"] }) }),
  ];
  assert.deepEqual(stillToFixOf(log), [{ done: ["Laps run"], notDone: [NO_TIMER], why: StopWhy.Stuck, hours: null }]);
  assert.ok(!JSON.stringify(toEntries(log)).includes(met), "what the reviewer checked is never listed");
  assert.deepEqual(stillToFixOf([finished(1, { victory: true, stillToFix: left() })]), [null], "a yes leaves nothing");
  assert.deepEqual(stillToFixOf([finished(1)]), [null], "a close that names nothing left has no list");
});

it("a paused close keeps its own reason and Resume: no list, whatever it carries, even after a Stop", () => {
  const stop = { stoppedBecause: "stopped by the user", stillToFix: left({ why: StopWhy.Person }) };
  for (const pause of [{ executionStatus: "paused" }, { paused: true }]) {
    const no = check(1, 1, FinishCheckStep.Rejected, { reasons: [], notDone: [NO_TIMER], rejections: 1 });
    const entries = toEntries([no, finished(2, { ...stop, ...pause })]);
    const card = entries.find((entry) => entry.kind === EntryKind.Morning);
    assert.ok(card && card.kind === EntryKind.Morning, JSON.stringify(pause));
    assert.equal(card.stillToFix, undefined, "no Almost there on a pause");
    assert.equal(card.stoppedBecause, "stopped by the user", "the pause's own reason stays");
  }
});

it("the card is the close's own: a page that lost the run's start and its checks still shows it whole", () => {
  const close = finished(9, { executionStatus: "completed", stillToFix: left({ why: StopWhy.Time, hours: 5 }) });
  assert.deepEqual(stillToFixOf([close]), [{ done: [], notDone: [NO_TIMER], why: StopWhy.Time, hours: 5 }]);
});

it("only the chat's newest result card is the latest, the one that offers Keep building", () => {
  const latest = (events: EventEnvelope[]) =>
    toEntries(events).flatMap((entry) => (entry.kind === EntryKind.Morning ? [entry.latest === true] : []));
  const other = custom(3, CustomEvent.RunFinished, { runId: "r-next", project: "valley", stillToFix: left() });
  assert.deepEqual(latest([finished(1, { stillToFix: left() }), other]), [false, true]);
  assert.deepEqual(latest([finished(1, { stillToFix: left() })]), [true]);
});

it("a Loop whose hours ran out before any final look still ends on the card: no list, its hours, Keep building", () => {
  const unlooked = { done: [], notDone: [], why: StopWhy.Time, hours: 5 };
  assert.deepEqual(stillToFixOf([finished(1, { stillToFix: unlooked })]), [unlooked]);
  assert.equal(stopWhyLine(StopWhy.Time, 5, false), "Your 5 hours ran out before a final look at your game.");
  const ended = { done: [], notDone: [], why: StopWhy.Ended, hours: null };
  assert.deepEqual(
    stillToFixOf([finished(1, { stillToFix: ended })]),
    [null],
    "any other end with nothing left: no card",
  );
});

it("a message the person sends after the newest result retires its Keep building, as a later chat turn does in Builds", () => {
  const said = event(2, { type: "messages", messages: [{ role: "user", content: "make the sky darker" }] });
  const latest = toEntries([finished(1, { stillToFix: left() }), said]).flatMap((entry) =>
    entry.kind === EntryKind.Morning ? [entry.latest === true] : [],
  );
  assert.deepEqual(latest, [false]);
});

it("a close's list it cannot trust says nothing", () => {
  const hostile: Array<[string, unknown]> = [
    ["no list", { why: StopWhy.Stuck }],
    ["an empty list", { notDone: [], why: StopWhy.Stuck }],
    ["items that are not words", { notDone: [3], why: StopWhy.Stuck }],
    ["an unknown why", { notDone: [NO_TIMER], why: "bored" }],
    ["not a record", "fix it"],
  ];
  for (const [name, stillToFix] of hostile) assert.deepEqual(stillToFixOf([finished(1, { stillToFix })]), [null], name);
  const odd = stillToFixOf([finished(1, { stillToFix: { notDone: [NO_TIMER], why: StopWhy.Ended, hours: -2 } })]);
  assert.deepEqual(
    odd,
    [{ done: [], notDone: [NO_TIMER], why: StopWhy.Ended, hours: null }],
    "hours that don't read are none",
  );
});

it("the card says why the Loop stopped in the person's words", () => {
  assert.equal(stopWhyLine(StopWhy.Time, 5), "Your 5 hours ran out before this was fixed.");
  assert.equal(stopWhyLine(StopWhy.Time, 0.5), "Your 30 minutes ran out before this was fixed.");
  assert.match(stopWhyLine(StopWhy.Stuck, null), /kept getting this wrong/);
  assert.match(stopWhyLine(StopWhy.Person, null), /^You stopped it/);
});

it("a run paused while the reviewer is checking reads in the graph as not yet: no reviewer is at work", async () => {
  const { buildRunGraph, GraphNodeKind } = await import("../../src/renderer/run-graph.ts");
  const paused = [
    custom(1, CustomEvent.RunStarted, { runId: RUN, project: "valley", goal: "a racer" }),
    custom(2, CustomEvent.AutopilotStarted, { runId: RUN, director: true, facets: [], workerRecords: true }),
    check(3, 1, FinishCheckStep.Checking),
    custom(4, CustomEvent.RunFinished, { runId: RUN, paused: true, executionStatus: "paused" }),
  ];
  const node = buildRunGraph(paused, RUN)?.nodes.find((one) => one.kind === GraphNodeKind.FinishCheck);
  assert.equal((node as { state?: string } | undefined)?.state, "not_yet");
  const resumed = [...paused, custom(5, CustomEvent.AutopilotResumed, { runId: RUN })];
  const again = buildRunGraph(resumed, RUN)?.nodes.find((one) => one.kind === GraphNodeKind.FinishCheck);
  assert.equal((again as { state?: string } | undefined)?.state, "not_yet", "nor after the run resumes");
});

it("a run_finished of an in-place Loop gives its result card the profile, so the card says kept in your project before the summary loads", () => {
  const closed = (profile?: string) =>
    toEntries([
      custom(1, CustomEvent.RunStarted, { runId: RUN, project: "valley", goal: "A valley" }),
      custom(2, CustomEvent.RunFinished, {
        runId: RUN,
        project: "valley",
        landed: true,
        executionStatus: "completed",
        ...(profile ? { profile } : {}),
      }),
    ]).find((entry) => entry.kind === EntryKind.Morning);
  const card = closed("open");
  assert.ok(card && card.kind === EntryKind.Morning);
  assert.equal(card.profile, "open");
  // The card's words before its run summary loads: the entry's own fields, nothing else.
  const words = morningWords({ ...card, paused: false, hasBuild: false, profile: card.profile });
  assert.doesNotMatch(words.because, /open Live/);
  assert.match(words.because, /kept in your project/);
  const web = closed();
  assert.ok(web && web.kind === EntryKind.Morning);
  assert.equal(web.profile, null, "a close that names no profile carries none");
});
