/**
 * The finish check in the chat: each round of a run's finish check is one line, written when the
 * reviewer starts checking and rewritten in place by its verdict. A stop asks for attention; no
 * line ever folds into the run's activity row.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { EntryKind, SystemTag, toEntries } from "../../src/renderer/chat-entries.ts";
import { morningWords } from "../../src/renderer/morning-words.ts";
import { FINISH_CHECK_WORDS } from "../../src/renderer/words.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";
import { FinishCheckStep, MAX_FINISH_REJECTIONS } from "../../src/shared/finish-check.ts";

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

/** The finish check's lines: their text and whether they ask for attention. */
const finishLines = (events: EventEnvelope[]) =>
  toEntries(events).flatMap((entry) =>
    entry.kind === EntryKind.System && entry.tag === SystemTag.FinishCheck
      ? [[entry.text, entry.attention === true] as const]
      : [],
  );

it("one chat line per check, rewritten by its verdict", () => {
  assert.deepEqual(finishLines([check(1, 1, FinishCheckStep.Checking, { claim: "Done." })]), [
    [FINISH_CHECK_WORDS.chat.checking, false],
  ]);
  const log = [
    check(1, 1, FinishCheckStep.Checking),
    check(2, 1, FinishCheckStep.Rejected, { reasons: [NO_FINISH_LINE, NO_TIMER], rejections: 1 }),
    check(3, 2, FinishCheckStep.Checking),
    check(4, 2, FinishCheckStep.Unanswered, { why: "the reviewer's session ended", rejections: 1 }),
    check(5, 3, FinishCheckStep.Checking),
    check(6, 3, FinishCheckStep.Rejected, { reasons: [NO_TIMER], rejections: 2 }),
    check(7, 4, FinishCheckStep.Checking),
    check(8, 4, FinishCheckStep.Rejected, { reasons: [NO_TIMER], rejections: 3, stopped: true }),
  ];
  assert.deepEqual(finishLines(log), [
    [`The reviewer sent the work back (1 of ${MAX_FINISH_REJECTIONS}): ${NO_FINISH_LINE}`, false],
    ["The reviewer couldn't answer: the reviewer's session ended", false],
    [`The reviewer sent the work back (2 of ${MAX_FINISH_REJECTIONS}): ${NO_TIMER}`, false],
    [FINISH_CHECK_WORDS.chat.stopped(NO_TIMER), true],
  ]);
  assert.match(FINISH_CHECK_WORDS.chat.stopped(NO_TIMER), /so the Loop stopped\. Not done: The lap timer/);

  const yes = [
    check(1, 1, FinishCheckStep.Checking),
    check(2, 1, FinishCheckStep.Accepted, { reasons: ["Laps run."] }),
  ];
  assert.deepEqual(finishLines(yes), [[FINISH_CHECK_WORDS.chat.accepted, false]]);
  assert.deepEqual(
    finishLines([check(2, 1, FinishCheckStep.Accepted)]),
    [[FINISH_CHECK_WORDS.chat.accepted, false]],
    "a verdict whose checking line is not on the page is a line of its own",
  );
  const routine = toEntries(log).filter((entry) => entry.kind === EntryKind.Activity);
  assert.deepEqual(routine, [], "never folded into an activity row");
});

it("a record it cannot place says nothing", () => {
  const hostile: Array<[string, Record<string, unknown>]> = [
    ["no run", { round: 1, step: FinishCheckStep.Checking }],
    ["a chat turn's", { turn: "m-1", round: 1, step: FinishCheckStep.Checking }],
    ["no round", { runId: RUN, step: FinishCheckStep.Checking }],
    ["an unknown step", { runId: RUN, round: 1, step: "maybe" }],
    ["reasons that are not strings", { runId: RUN, round: 1, step: FinishCheckStep.Rejected, reasons: [3] }],
  ];
  for (const [name, payload] of hostile)
    assert.deepEqual(finishLines([custom(1, CustomEvent.FinishCheck, payload)]), [], name);
  assert.deepEqual(
    finishLines([check(1, 1, FinishCheckStep.Checking), check(2, 2, FinishCheckStep.Checking)]),
    [
      [FINISH_CHECK_WORDS.chat.checking, false],
      [FINISH_CHECK_WORDS.chat.checking, false],
    ],
    "two rounds are two lines",
  );
});

it("a run paused while the reviewer is checking says there was no answer, as the graph does", async () => {
  const { buildRunGraph, GraphNodeKind } = await import("../../src/renderer/run-graph.ts");
  const paused = [
    custom(1, CustomEvent.RunStarted, { runId: RUN, project: "valley", goal: "a racer" }),
    custom(2, CustomEvent.AutopilotStarted, { runId: RUN, director: true, facets: [], workerRecords: true }),
    check(3, 1, FinishCheckStep.Checking),
    custom(4, CustomEvent.RunFinished, { runId: RUN, paused: true, executionStatus: "paused" }),
  ];
  assert.deepEqual(finishLines(paused), [[FINISH_CHECK_WORDS.chat.unanswered(""), false]]);
  const node = buildRunGraph(paused, RUN)?.nodes.find((one) => one.kind === GraphNodeKind.FinishCheck);
  assert.equal((node as { state?: string } | undefined)?.state, "not_yet", "the graph agrees: no reviewer is at work");
  const resumed = [...paused, custom(5, CustomEvent.AutopilotResumed, { runId: RUN })];
  const again = buildRunGraph(resumed, RUN)?.nodes.find((one) => one.kind === GraphNodeKind.FinishCheck);
  assert.equal((again as { state?: string } | undefined)?.state, "not_yet", "nor after the run resumes");
});

it("a run that ends while the reviewer is checking leaves the line saying there was no answer", () => {
  const finished = (id: number, runId: string) => custom(id, CustomEvent.RunFinished, { runId, project: "valley" });
  assert.deepEqual(finishLines([check(1, 1, FinishCheckStep.Checking), finished(2, RUN)]), [
    [FINISH_CHECK_WORDS.chat.unanswered(""), false],
  ]);
  assert.deepEqual(
    finishLines([check(1, 1, FinishCheckStep.Checking), finished(2, "another-run")]),
    [[FINISH_CHECK_WORDS.chat.checking, false]],
    "another run's end leaves it",
  );
  const answered = [
    check(1, 1, FinishCheckStep.Checking),
    check(2, 1, FinishCheckStep.Rejected, { reasons: [NO_TIMER], rejections: 1 }),
    finished(3, RUN),
  ];
  assert.deepEqual(
    finishLines(answered),
    [[`The reviewer sent the work back (1 of ${MAX_FINISH_REJECTIONS}): ${NO_TIMER}`, false]],
    "an answered round keeps its verdict",
  );
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
