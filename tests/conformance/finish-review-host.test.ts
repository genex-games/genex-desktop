/**
 * The reviewer's verdict is the app's: it seats the reviewer, reads the answer and records it; the
 * harness only asks and settles. Real core (`worker-chat.ts`: a game chat with a run started in
 * it), fake engines whose reviewer answers what the test scripts, no harness.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { FinishReviews } from "../../src/main/core/finish-review.ts";
import { CustomEvent, customRecord } from "../../src/shared/custom-events.ts";
import {
  FINISH_REASON_CHARS,
  FinishCheckStep,
  type FinishRecord,
  MAX_FINISH_REASONS,
  MAX_FINISH_REJECTIONS,
  rejectionsInRow,
  reviewerVerdict,
} from "../../src/shared/finish-check.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import type { DelegateResult } from "../../src/substrate/engines/types.ts";
import { reviewerAnswer, seatedReviewer } from "../helpers/reviewer.ts";
import { CLAUDE, closeWorkerChats, RUN_ID, workerChat } from "../helpers/worker-chat.ts";

after(closeWorkerChats);

/** A case that would hang on a regression fails within this instead. */
const CASE_TIMEOUT_MS = 60_000;
const CLAIM = "A full lap runs and the lap timer counts on screen.";
const YES_REASONS = ["The lap runs from start to finish and the timer counts."];
const NO_REASONS = ["The lap timer never shows."];

type Chat = Awaited<ReturnType<typeof workerChat>>;

/** The reviewer answers each session from `answers`, in order; any other session gets the plain answer. */
function reviewerSays(chat: Chat, answers: Array<ReturnType<typeof reviewerAnswer>>): void {
  chat.answerWith((request) => (seatedReviewer(request) ? (answers.shift() as unknown as DelegateResult) : undefined));
}

/** What the harness sends to ask for a review of a run's claim. */
function reviewAsk(chat: Chat, extra: Record<string, unknown> = {}) {
  return {
    project: chat.game,
    runId: RUN_ID,
    engine: CLAUDE,
    prompt: "Check the lead's claim.",
    images: [],
    reads: chat.project.dir,
    timeoutMs: 60_000,
    maxTurns: 10,
    claim: CLAIM,
    proof: ["reports/tests.txt"],
    observers: ["preview"],
    ...extra,
  };
}

/** The `finish_check` records of the chat, oldest first. */
async function checks(chat: Chat): Promise<Array<Record<string, unknown>>> {
  return (await chat.core.store.listEvents(chat.threadId)).flatMap((event) => {
    const custom = customRecord(event.data);
    return custom?.event_type === CustomEvent.FinishCheck ? [custom.payload as Record<string, unknown>] : [];
  });
}

/** Call a host method the harness may call, as the harness would. */
async function call(chat: Chat, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handler = chat.api[method];
  if (!handler) throw new Error(`the host serves no ${method}`);
  return (await handler(params)) as Record<string, unknown>;
}
const review = (chat: Chat, extra: Record<string, unknown> = {}) =>
  call(chat, HostMethod.FinishReview, reviewAsk(chat, extra));
const settle = (chat: Chat, params: Record<string, unknown>) =>
  call(chat, HostMethod.FinishSettle, { project: chat.game, runId: RUN_ID, ...params });

/** Strip a record's time, which the host stamps. */
const untimed = ({ at: _at, ...rest }: Record<string, unknown>) => rest;

describe("the reviewer's verdict is the app's", () => {
  it("a review records checking, then the reviewer's yes once the round is settled", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await workerChat();
    reviewerSays(chat, [reviewerAnswer("yes", YES_REASONS)]);
    const held = await review(chat);
    assert.deepEqual(held, { round: 1, step: FinishCheckStep.Accepted, reasons: YES_REASONS });
    assert.ok(seatedReviewer(chat.seen.at(-1) ?? {}), "the reviewer sat where the host seats reviewers");
    assert.equal(chat.seen.at(-1)?.readOnly, true, "read-only");
    assert.deepEqual((await checks(chat)).map(untimed), [
      { runId: RUN_ID, round: 1, step: FinishCheckStep.Checking, claim: CLAIM, proof: ["reports/tests.txt"] },
    ]);
    const settled = await settle(chat, { round: 1 });
    assert.deepEqual(settled, {
      round: 1,
      step: FinishCheckStep.Accepted,
      reasons: YES_REASONS,
      rejections: 0,
      stopped: false,
    });
    assert.deepEqual((await checks(chat)).map(untimed).at(-1), {
      runId: RUN_ID,
      round: 1,
      step: FinishCheckStep.Accepted,
      reasons: YES_REASONS,
      rejections: 0,
      observers: ["preview"],
      reviewer: { engine: CLAUDE },
    });
  });

  it("settling may turn a held answer into no answer, never into a yes", { timeout: CASE_TIMEOUT_MS }, async () => {
    const chat = await workerChat();
    await chat.startRun("run_beside");
    reviewerSays(chat, [reviewerAnswer("no", NO_REASONS), reviewerAnswer("no", NO_REASONS)]);
    await review(chat);
    const lapsed = await settle(chat, { round: 1, unanswered: "the build moved while the reviewer read" });
    assert.equal(lapsed.step, FinishCheckStep.Unanswered);
    assert.equal(lapsed.why, "the build moved while the reviewer read");
    await review(chat);
    const recorded = (await checks(chat)).length;
    const hostile: Array<[string, Record<string, unknown>]> = [
      ["another run of the game", { runId: "run_beside", round: 2 }],
      ["a round never held", { round: 7 }],
      ["a round already settled", { round: 1 }],
      ["another game", { project: chat.other.name, round: 2 }],
      ["a yes smuggled in", { round: 2, step: FinishCheckStep.Accepted }],
      ["a yes smuggled as no answer", { round: 2, unanswered: { step: FinishCheckStep.Accepted } }],
    ];
    for (const [label, params] of hostile) {
      await assert.rejects(settle(chat, params), Error, `${label}: refused`);
      assert.equal((await checks(chat)).length, recorded, `${label}: nothing recorded`);
    }
    const rejected = await settle(chat, { round: 2 });
    assert.equal(rejected.step, FinishCheckStep.Rejected, "the held no stands");
    assert.deepEqual(rejected.reasons, NO_REASONS);
    await assert.rejects(settle(chat, { round: 2 }), Error, "a second settle is refused");
    assert.equal((await checks(chat)).length, recorded + 1, "one record for the one settle");
  });

  it("three no's in a row stop the Loop by the app's own count", { timeout: CASE_TIMEOUT_MS }, async () => {
    const chat = await workerChat();
    reviewerSays(chat, [
      reviewerAnswer("no", NO_REASONS),
      reviewerAnswer("no", NO_REASONS),
      reviewerAnswer("no", NO_REASONS),
      reviewerAnswer("no", NO_REASONS),
    ]);
    const counts: Array<[unknown, unknown]> = [];
    for (const [round, unanswered] of [
      [1, undefined],
      [2, "the lead's turn ended before the reviewer answered"],
      [3, undefined],
      [4, undefined],
    ] as const) {
      await review(chat);
      const settled = await settle(chat, { round, ...(unanswered ? { unanswered } : {}) });
      counts.push([settled.rejections, settled.stopped]);
    }
    assert.deepEqual(counts, [
      [1, false],
      [1, false],
      [2, false],
      [MAX_FINISH_REJECTIONS, true],
    ]);
    const last = (await checks(chat)).at(-1);
    assert.equal(last?.stopped, true);
    assert.equal(last?.rejections, MAX_FINISH_REJECTIONS);
  });

  it("a resumed run goes on counting its no's; a finished run reopened for a new ask starts them over", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await workerChat();
    reviewerSays(
      chat,
      Array.from({ length: 4 }, () => reviewerAnswer("no", NO_REASONS)),
    );
    const close = (payload: Record<string, unknown>) =>
      chat.core.append(
        [{ type: "custom", event_type: "run_finished", payload: { runId: RUN_ID, ...payload } }] as never,
        chat.threadId,
      );
    const no = async () => {
      const held = await review(chat);
      return (await settle(chat, { round: held.round })).rejections;
    };
    const counts = [await no(), await no()];
    await close({ paused: true });
    await chat.startRun(RUN_ID);
    counts.push(await no());
    await close({});
    await chat.startRun(RUN_ID);
    counts.push(await no());
    assert.deepEqual(counts, [1, 2, MAX_FINISH_REJECTIONS, 1]);
    const rounds = (await checks(chat))
      .filter((check) => check.step === FinishCheckStep.Checking)
      .map((check) => check.round);
    assert.deepEqual(rounds, [1, 2, 3, 4], "the round numbers go on across asks");
  });

  it("a review is refused for a run that isn't this game's or isn't running, before any engine starts", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await workerChat();
    reviewerSays(chat, [reviewerAnswer("yes", YES_REASONS)]);
    const otherChat = await chat.core.threadForGame(chat.other.name);
    await chat.startRun("run_elsewhere", otherChat, chat.other.name);
    await chat.startRun("run_done");
    await chat.core.append(
      [{ type: "custom", event_type: "run_finished", payload: { runId: "run_done" } }] as never,
      chat.threadId,
    );
    const seen = chat.seen.length;
    for (const [label, extra] of [
      ["another game's run", { runId: "run_elsewhere" }],
      ["a run that finished", { runId: "run_done" }],
      ["a run nobody started", { runId: "run_unknown" }],
      ["a game that isn't there", { project: "no-such-game" }],
      ["a name that climbs out", { runId: "../run_workers" }],
    ] as const) {
      await assert.rejects(review(chat, extra), Error, `${label}: refused`);
    }
    assert.equal(chat.seen.length, seen, "no engine started");
    assert.deepEqual(await checks(chat), [], "nothing recorded");
  });

  it("a run that finishes drops its held round, and nothing more is recorded", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await workerChat();
    reviewerSays(chat, [reviewerAnswer("yes", YES_REASONS), reviewerAnswer("yes", YES_REASONS)]);
    await review(chat);
    await chat.core.append(
      [{ type: "custom", event_type: "run_finished", payload: { runId: RUN_ID } }] as never,
      chat.threadId,
    );
    await assert.rejects(settle(chat, { round: 1 }), Error, "the finished run's round is gone");
    assert.deepEqual(
      (await checks(chat)).map((check) => check.step),
      [FinishCheckStep.Checking],
      "nothing after the checking record",
    );
    await chat.startRun(RUN_ID);
    const again = await review(chat);
    assert.equal(again.round, 2, "the resumed run's next round, numbered past the records");
  });

  for (const [label, payload] of [
    ["closes", {}],
    ["pauses", { paused: true }],
  ] as const) {
    it(`a run that ${label} while its reviewer reads leaves nothing to settle`, {
      timeout: CASE_TIMEOUT_MS,
    }, async () => {
      const chat = await workerChat();
      reviewerSays(chat, [reviewerAnswer("yes", YES_REASONS)]);
      chat.whileRunning(async (request) => {
        if (!seatedReviewer(request)) return;
        await chat.core.append(
          [{ type: "custom", event_type: "run_finished", payload: { runId: RUN_ID, ...payload } }] as never,
          chat.threadId,
        );
      });
      const held = await review(chat);
      assert.equal(held.round, 1);
      await assert.rejects(settle(chat, { round: 1 }), Error, "the dropped round is not settled");
      assert.deepEqual(
        (await checks(chat)).map((check) => check.step),
        [FinishCheckStep.Checking],
        "nothing after the checking record",
      );
    });
  }

  it("a run that pauses drops its held round before the settle", { timeout: CASE_TIMEOUT_MS }, async () => {
    const chat = await workerChat();
    reviewerSays(chat, [reviewerAnswer("no", NO_REASONS)]);
    await review(chat);
    await chat.core.append(
      [{ type: "custom", event_type: "run_finished", payload: { runId: RUN_ID, paused: true } }] as never,
      chat.threadId,
    );
    await assert.rejects(settle(chat, { round: 1 }), Error, "the paused run's round is gone");
    assert.deepEqual(
      (await checks(chat)).map((check) => check.step),
      [FinishCheckStep.Checking],
    );
  });

  it("a held round the harness never settles gives way to the run's next claim, recorded as no answer", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await workerChat();
    reviewerSays(chat, [reviewerAnswer("no", NO_REASONS), reviewerAnswer("yes", YES_REASONS)]);
    const asked: { second?: Promise<unknown> } = {};
    chat.whileRunning(async (request) => {
      if (!seatedReviewer(request) || asked.second) return;
      asked.second = review(chat).catch((err: Error) => err);
      await asked.second;
    });
    await review(chat);
    assert.ok((await asked.second) instanceof Error, "a second review while the reviewer reads is refused");
    chat.whileRunning(async () => {});
    const next = await review(chat);
    assert.equal(next.round, 2, "the next claim gets its own round");
    await assert.rejects(settle(chat, { round: 1 }), Error, "the round given way is not settled");
    const settled = await settle(chat, { round: 2 });
    assert.equal(settled.step, FinishCheckStep.Accepted);
    assert.deepEqual(
      (await checks(chat)).map((check) => [check.round, check.step]),
      [
        [1, FinishCheckStep.Checking],
        [1, FinishCheckStep.Unanswered],
        [2, FinishCheckStep.Checking],
        [2, FinishCheckStep.Accepted],
      ],
      "the unsettled no never counts: it is recorded as no answer",
    );
  });
});

describe("a round dropped while a review or a settle waits", () => {
  /** Finish checks over ports that run `during` inside each wait: a pause or close landing there. */
  function droppingReviews() {
    const records: Array<Record<string, unknown>> = [];
    const waits = { chat: () => {}, history: () => {} };
    let delegated = 0;
    const reviews: FinishReviews = new FinishReviews({
      runningChat: async () => {
        waits.chat();
        return "chat-1";
      },
      history: async () => {
        waits.history();
        return { all: [...records], sinceOpened: [...records] };
      },
      append: async (_threadId, payload) => records.push({ ...payload }),
      delegate: async () => {
        delegated += 1;
        return reviewerAnswer("yes", YES_REASONS);
      },
    });
    const ask = {
      project: "game",
      runId: RUN_ID,
      engine: CLAUDE,
      prompt: "Check the lead's claim.",
      images: [],
      reads: "/game",
      timeoutMs: 60_000,
      maxTurns: 10,
      claim: CLAIM,
      proof: [],
      observers: [],
    };
    return { reviews, records, waits, ask, delegated: () => delegated };
  }

  it("a drop between the hold and its checking record records nothing and starts no reviewer", async () => {
    const w = droppingReviews();
    w.waits.history = () => w.reviews.drop(RUN_ID);
    await assert.rejects(w.reviews.review(w.ask as never), /not a running run/);
    assert.deepEqual(w.records, [], "no checking row after the pause");
    assert.equal(w.delegated(), 0, "no reviewer for the closed run");
  });

  it("a drop between a settle's release and its outcome records no outcome", async () => {
    const w = droppingReviews();
    const answered = await w.reviews.review(w.ask as never);
    assert.equal(answered.step, FinishCheckStep.Accepted);
    const rows = w.records.length;
    w.waits.history = () => w.reviews.drop(RUN_ID);
    await assert.rejects(w.reviews.settle({ project: "game", runId: RUN_ID, round: answered.round } as never));
    assert.equal(w.records.length, rows, "no yes lands after the pause");
  });
});

describe("the app's reading of a reviewer's answer", () => {
  const json = (answer: unknown) => JSON.stringify(answer);
  it("reads a fenced or trailing verdict with its reasons, and anything else as no answer", () => {
    const long = "x".repeat(FINISH_REASON_CHARS + 50);
    const many = Array.from({ length: MAX_FINISH_REASONS + 3 }, (_, n) => `reason ${n}`);
    const rows: Array<[string, string, unknown]> = [
      [
        "a fenced yes",
        `I looked.\n\`\`\`json\n${json({ verdict: "yes", reasons: ["ok"] })}\n\`\`\``,
        ["accepted", ["ok"]],
      ],
      [
        "a trailing no",
        `Done reading. ${json({ verdict: "No", reasons: [], notDone: ["no timer"] })}`,
        ["rejected", ["no timer"]],
      ],
      ["a no naming nothing", json({ verdict: "no" }), ["rejected", ["the reviewer named nothing concrete"]]],
      [
        "an echoed file fenced before the answer",
        `\`\`\`json\n${json({ name: "game" })}\n\`\`\`\n\`\`\`json\n${json({ verdict: "yes" })}\n\`\`\``,
        ["accepted", []],
      ],
      ["a stray brace after the answer", `${json({ verdict: "yes", reasons: ["fine"] })}}`, ["accepted", ["fine"]]],
      ["a maybe", json({ verdict: "maybe", reasons: ["hm"] }), ["unanswered", "its answer said neither yes nor no"]],
      ["no JSON", "It looks done to me.", ["unanswered", "its answer said neither yes nor no"]],
      ["a verdict that is not text", json({ verdict: true }), ["unanswered", "its answer said neither yes nor no"]],
    ];
    for (const [label, reply, expected] of rows) {
      const read = reviewerVerdict(reply);
      const got = [read.step, "reasons" in read ? read.reasons : read.why];
      assert.deepEqual(got, expected, label);
    }
    const capped = reviewerVerdict(json({ verdict: "no", reasons: [long, ...many] }));
    assert.ok("reasons" in capped && capped.reasons.length === MAX_FINISH_REASONS, "at most the cap of reasons");
    assert.ok("reasons" in capped && capped.reasons[0]?.length === FINISH_REASON_CHARS + 1, "each clipped and marked");
  });

  it("counts the no's in a row of one run: a yes clears it, no answer neither counts nor breaks it", () => {
    const record = (step: FinishCheckStep, runId = "r1"): FinishRecord => ({
      runId,
      round: 1,
      step,
      claim: null,
      reasons: [],
      why: null,
      stopped: false,
      rejections: null,
    });
    const { Accepted, Checking, Rejected, Unanswered } = FinishCheckStep;
    const rows: Array<[string, FinishCheckStep[], number]> = [
      ["none", [], 0],
      ["two no's", [Rejected, Checking, Rejected], 2],
      ["no answer between", [Rejected, Unanswered, Rejected], 2],
      ["a yes clears", [Rejected, Rejected, Accepted, Rejected], 1],
    ];
    for (const [label, steps, expected] of rows) {
      const records = [...steps.map((step) => record(step)), record(Rejected, "r2")];
      assert.equal(rejectionsInRow(records, "r1"), expected, label);
    }
  });
});
