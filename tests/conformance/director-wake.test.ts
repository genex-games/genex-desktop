import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  afterTurn,
  DirectorLoop,
  passDeadline,
  TurnEnd,
  WRAP_UP_MARGIN_MS,
  WrapCause,
} from "../../src/harness-seed/loop/director/wake-schedule.ts";
import * as wakePrompts from "../../src/harness-seed/loop/director/wake-prompts.ts";
import { wakeRecord } from "../../src/harness-seed/loop/director/journal.ts";
import { HOUR_MS, MINUTE_MS } from "../../src/harness-seed/loop/time.ts";
import {
  bookmarkLead,
  chatBookmark,
  continuesChat,
  leadSeat,
} from "../../src/harness-seed/loop/director/lead-session.ts";
import { CHAT_SO_FAR_MESSAGES, chatSoFar } from "../../src/harness-seed/loop/director/lead-session-prompts.ts";

const T0 = Date.UTC(2026, 8, 25, 14, 0, 0);

describe("when the lead is woken (wake-schedule.ts)", () => {
  it("W7. asks once what next when nothing runs, then wraps up; a running worker or job is not idle", () => {
    const idle = {
      ok: true,
      closed: false,
      running: 0,
      idleAsked: false,
      workingTimeLeft: true,
      finishRequested: false,
    };
    assert.deepEqual(afterTurn(idle), { next: TurnEnd.AskIdle, idleAsked: true });
    assert.deepEqual(afterTurn({ ...idle, idleAsked: true }), {
      next: TurnEnd.WrapUp,
      idleAsked: true,
      wrapCause: WrapCause.Idle,
    });
    for (const busy of [{ running: 1 }, { running: 2 }])
      assert.deepEqual(
        afterTurn({ ...idle, idleAsked: true, ...busy }),
        { next: TurnEnd.Sleep, idleAsked: false },
        `${JSON.stringify(busy)} is not idle, and the next idle turn is asked again`,
      );
    assert.deepEqual(afterTurn({ ...idle, closed: true, running: 1 }), { next: TurnEnd.Close, idleAsked: false });
    assert.deepEqual(afterTurn({ ...idle, ok: false, running: 1 }), {
      next: TurnEnd.WrapUp,
      idleAsked: false,
      wrapCause: WrapCause.Failed,
    });
    assert.deepEqual(afterTurn({ ...idle, workingTimeLeft: false, running: 1 }), {
      next: TurnEnd.WrapUp,
      idleAsked: false,
      wrapCause: WrapCause.Deadline,
    });
    assert.deepEqual(afterTurn({ ...idle, workingTimeLeft: false, finishRequested: true, ok: false }), {
      next: TurnEnd.WrapUp,
      idleAsked: false,
      wrapCause: WrapCause.Finish,
    });
  });

  it("W7b (provider lost). a turn a lost provider failed closes the run paused — never the wrap-up that lands a build", () => {
    // A wrap-up after a lost provider would land a build nobody could check.
    const lost = {
      ok: false,
      closed: false,
      providerLost: true,
      running: 3,
      planWindowOpen: false,
      workersLimitPending: false,
      idleAsked: false,
      workingTimeLeft: true,
      finishRequested: false,
    };
    assert.deepEqual(afterTurn(lost), { next: TurnEnd.Close, idleAsked: false });
    assert.deepEqual(afterTurn({ ...lost, workingTimeLeft: false }), { next: TurnEnd.Close, idleAsked: false });
    assert.deepEqual(afterTurn({ ...lost, ok: true, idleAsked: true }), { next: TurnEnd.Close, idleAsked: true });
    assert.deepEqual(
      afterTurn({ ...lost, providerLost: false }),
      { next: TurnEnd.WrapUp, idleAsked: false, wrapCause: WrapCause.Failed },
      "any other failed turn keeps today's wrap-up",
    );
  });

  it("a turn cut by its own cap goes on at once, never into the wrap-up as a failed turn", () => {
    const idle = {
      ok: true,
      closed: false,
      running: 0,
      planWindowOpen: false,
      workersLimitPending: false,
      idleAsked: false,
      workingTimeLeft: true,
      finishRequested: false,
    };
    const capped = { ...idle, ok: false, capped: true };
    assert.deepEqual(afterTurn(capped), { next: TurnEnd.Continue, idleAsked: false });
    assert.deepEqual(afterTurn({ ...capped, ok: true, idleAsked: true }), { next: TurnEnd.Continue, idleAsked: false });
    assert.deepEqual(afterTurn({ ...capped, running: 2 }), { next: TurnEnd.Continue, idleAsked: false });
    // The run is over, or its working time is: the cap changes nothing then.
    assert.deepEqual(afterTurn({ ...capped, closed: true }), { next: TurnEnd.Close, idleAsked: false });
    assert.deepEqual(afterTurn({ ...capped, providerLost: true }), { next: TurnEnd.Close, idleAsked: false });
    assert.deepEqual(afterTurn({ ...capped, workingTimeLeft: false }), {
      next: TurnEnd.WrapUp,
      idleAsked: false,
      wrapCause: WrapCause.Deadline,
    });
    // Without the cap, a failed turn wraps up as it always did.
    assert.deepEqual(afterTurn({ ...capped, capped: false }), {
      next: TurnEnd.WrapUp,
      idleAsked: false,
      wrapCause: WrapCause.Failed,
    });
  });

  it("W9. a pass the lead asks for in the wrap-up has the wrap-up's time, not the working deadline that moved to its start", () => {
    const clocks = { softDeadline: T0 + HOUR_MS, finalDeadline: T0 + 2 * HOUR_MS };
    assert.equal(passDeadline({ ...clocks, now: T0 }), T0 + HOUR_MS, "while working: the working deadline");
    assert.equal(
      passDeadline({ ...clocks, now: T0 + HOUR_MS + MINUTE_MS }),
      T0 + 2 * HOUR_MS - WRAP_UP_MARGIN_MS,
      "wrapping up: the run's end, less the wrap-up's margin",
    );
    // A finish request moved the working deadline to the moment it started the wrap-up.
    assert.equal(
      passDeadline({ now: T0, softDeadline: T0, finalDeadline: T0 + HOUR_MS }),
      T0 + HOUR_MS - WRAP_UP_MARGIN_MS,
    );
  });

  it("W11. a goal run idle twice wraps up: the studio sends it to no art director first", () => {
    const idle = {
      ok: true,
      closed: false,
      running: 0,
      planWindowOpen: false,
      workersLimitPending: false,
      idleAsked: true,
      workingTimeLeft: true,
      finishRequested: false,
    };
    // Flipped (Loop phase 4): a goal run idle twice was sent to art direction once first; the art
    // director's look is the lead's to ask for now, so the second idle turn wraps up.
    assert.deepEqual(afterTurn(idle), { next: TurnEnd.WrapUp, idleAsked: true, wrapCause: WrapCause.Idle });
    // The first idle turn is still asked what next, a busy one sleeps, and no working time wraps up.
    assert.deepEqual(afterTurn({ ...idle, idleAsked: false }), { next: TurnEnd.AskIdle, idleAsked: true });
    assert.deepEqual(afterTurn({ ...idle, running: 1 }), { next: TurnEnd.Sleep, idleAsked: false });
    assert.deepEqual(afterTurn({ ...idle, workingTimeLeft: false }), {
      next: TurnEnd.WrapUp,
      idleAsked: true,
      wrapCause: WrapCause.Deadline,
    });
  });
});

describe("what the message that wakes the lead says (wake-prompts.ts)", () => {
  it("P7. what the user says is bounded: the newest messages, each clipped, and how many earlier ones are left out", () => {
    const { USER_SAYS_CHARS, USER_SAYS_MAX } = wakePrompts as unknown as Record<string, number>;
    assert.equal(typeof USER_SAYS_MAX, "number", "the block has a bound");
    const said = Array.from({ length: USER_SAYS_MAX + 5 }, (_, i) => `message ${i} ${"x".repeat(3 * USER_SAYS_CHARS)}`);
    const block = wakePrompts.userSaysBlock(said).split("\n");
    assert.equal(block[0], "THE USER SAYS (verbatim, oldest first):");
    assert.equal(block[1], "- (5 earlier messages not shown)");
    const shown = block.slice(2);
    assert.equal(shown.length, USER_SAYS_MAX);
    assert.ok(shown[0]!.startsWith("- message 5 "), shown[0]!.slice(0, 40));
    assert.ok(
      shown.every((line) => line.length <= USER_SAYS_CHARS + 4),
      "each clipped to its bound",
    );
    // A block under the bound is word for word.
    assert.equal(
      wakePrompts.userSaysBlock(["make the sky red"]),
      "THE USER SAYS (verbatim, oldest first):\n- make the sky red",
    );
  });
});

describe("what the journal keeps of the wake loop (journal.ts wakeRecord)", () => {
  /**
   * The run's own record — its clock, its workers, the defects nobody owns, the plan window, the
   * log — is written on every save now (director-journal.test.ts K2); the wake loop's record keeps
   * only the loop's own state, and a Resume takes back the idle question and the wakes (K5).
   */
  it("J1. the journal keeps the wake loop's own state: the idle question, why the wrap-up started, and the wakes with when they were", () => {
    const iso = (ms: number) => new Date(ms).toISOString();
    const record = wakeRecord({
      idleAsked: true,
      wrapCause: WrapCause.Idle,
      wakes: 2,
      wakesAt: [T0 + 1, T0 + 2],
      lastWakeAt: T0 + 2,
      asleepSince: T0 + 3,
    });
    assert.deepEqual(record, {
      loop: DirectorLoop.Wake,
      idleAsked: true,
      // The lost sessions it replaced, so a Resume does not start that allowance again.
      freshSessions: 0,
      wrapCause: WrapCause.Idle,
      wakes: 2,
      wakesAt: [iso(T0 + 1), iso(T0 + 2)],
      lastWakeAt: iso(T0 + 2),
      asleepSince: iso(T0 + 3),
    });
  });
});

/** A chat's bookmark as a chat turn records it (delegated-turn.ts `bookmarkSession`). */
const bookmarked = (payload: Record<string, unknown>) => ({
  data: { type: "custom", event_type: "contractor_session", payload },
});

describe("one session: whose session the lead is (lead-session.ts)", () => {
  const run = { runId: "run_s", project: "plaza", goal: "a dusk plaza", engine: "claude-code", model: "opus" };

  it("O1. continues the chat's session only on the lead's engine, game and model; otherwise says whose session it keeps", () => {
    const seat = (events: unknown[], priorJournal: unknown = null) =>
      leadSeat({
        events: events as never,
        run: run as never,
        folder: "/games/plaza",
        priorJournal: priorJournal as never,
      });
    const chat = bookmarked({ project: "plaza", engine: "claude-code", sessionId: "chat-1", model: "opus" });
    const rows = [
      { label: "the chat's own session", events: [chat], want: { sessionId: "chat-1", chatSession: true } },
      {
        label: "a bookmark from before one session names no model",
        events: [bookmarked({ project: "plaza", engine: "claude-code", sessionId: "chat-0" })],
        want: { sessionId: "chat-0", chatSession: true },
      },
      {
        label: "no bookmark: a fresh session that becomes the chat's",
        events: [],
        want: { sessionId: null, chatSession: true },
      },
      {
        label: "another engine's session: the lead's own, the chat's left alone",
        events: [bookmarked({ project: "plaza", engine: "codex", sessionId: "chat-codex", model: null })],
        want: { sessionId: null, chatSession: false },
      },
      {
        label: "another model",
        events: [bookmarked({ project: "plaza", engine: "claude-code", sessionId: "chat-sonnet", model: "sonnet" })],
        want: { sessionId: null, chatSession: false },
      },
      {
        label: "another game's session",
        events: [bookmarked({ project: "other", engine: "claude-code", sessionId: "chat-other", model: "opus" })],
        want: { sessionId: null, chatSession: false },
      },
    ];
    for (const { label, events, want } of rows) {
      const got = seat(events);
      assert.deepEqual({ sessionId: got.sessionId, chatSession: got.chatSession }, want, label);
      assert.equal(got.folder, "/games/plaza", label);
    }
    // A Resume of a lead that kept a session of its own goes on in it; one that was the chat's does not come back.
    const other = [bookmarked({ project: "plaza", engine: "codex", sessionId: "chat-codex", model: null })];
    const own = { director: { sessionId: "lead-own", lead: { chatSession: false } } };
    assert.equal(seat(other, own).sessionId, "lead-own");
    assert.equal(
      seat(other, { director: { sessionId: "lead-was-chat", lead: { chatSession: true } } }).sessionId,
      null,
    );
    assert.equal(
      seat(other, { director: { sessionId: "pre-one-session" } }).sessionId,
      null,
      "an older run's director session sat elsewhere",
    );
    // The chat's latest session wins, whatever engine an older one was on.
    const latest = chatBookmark([
      bookmarked({ engine: "claude-code", sessionId: "old", model: "opus" }),
      other[0],
    ] as never);
    assert.equal(latest?.sessionId, "chat-codex");
    assert.equal(
      continuesChat(
        { sessionId: "s", engine: "claude-code", model: "default", modelKnown: true },
        { ...run, model: undefined } as never,
        undefined,
      ),
      true,
      "the engine's default is no model",
    );
  });

  it("O2. a fresh lead is told the chat's latest messages, clipped, oldest first", () => {
    const lines = Array.from({ length: CHAT_SO_FAR_MESSAGES + 5 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: `message ${i}`,
    }));
    const told = chatSoFar(lines);
    assert.match(told, /^THE CHAT SO FAR/);
    assert.ok(!told.includes("message 4\n") && told.includes("message 5"), "only the latest twenty");
    assert.ok(told.indexOf("message 5") < told.indexOf("message 24"), "oldest first");
    assert.match(chatSoFar([{ role: "user", content: "x".repeat(10_000) }]), /x…$/, "a long message is clipped");
    assert.equal(chatSoFar([]), "", "no chat, nothing said");
  });

  it("O3. the lead's session is written to the chat's bookmark only when it is the chat's and it changed", async () => {
    const appended: unknown[] = [];
    const ctx = { call: async (_method: string, params: { batch: unknown[] }) => appended.push(...params.batch) };
    const seat = leadSeat({ events: [], run: run as never, folder: "/games/plaza" });
    await bookmarkLead(ctx as never, { threadId: "t", run: run as never, seat }, "lead-1");
    await bookmarkLead(ctx as never, { threadId: "t", run: run as never, seat }, "lead-1");
    await bookmarkLead(
      ctx as never,
      { threadId: "t", run: run as never, seat: { ...seat, chatSession: false } },
      "lead-2",
    );
    assert.deepEqual(appended, [
      {
        type: "custom",
        event_type: "contractor_session",
        payload: { project: "plaza", engine: "claude-code", sessionId: "lead-1", model: "opus" },
      },
    ]);
  });
});

describe("a wake digest over its budget", () => {
  it("leaves out the oldest news and says so, keeping the newest", async () => {
    const { fitHappened } = await import("../../src/harness-seed/loop/director/wake.ts");
    const happened = Array.from({ length: 400 }, (_, i) => `worker sky landed round ${i}: ${"detail ".repeat(30)}`);
    const render = (lines: readonly string[]) => ["WOKEN", ...lines, "Decide, act, and end your turn."].join("\n");
    const fitted = fitHappened(happened, render, 2_000);
    assert.ok(render(fitted).length / 4 <= 2_000, `within the budget: ${Math.round(render(fitted).length / 4)} tokens`);
    assert.match(fitted[0] ?? "", /earlier events left out/, "the cut is said, first");
    assert.match(fitted.at(-1) ?? "", /round 399/, "the newest news stays");
    assert.deepEqual(
      fitHappened(happened.slice(0, 3), render, 2_000),
      happened.slice(0, 3),
      "news that fits is left alone",
    );
  });
});

describe("the lost-session allowance across a Resume", () => {
  it("is kept on the journal, so a Resume does not hand a run fresh sessions it already spent", async () => {
    const { wakeRecord, restoredWake } = await import("../../src/harness-seed/loop/director/journal.ts");
    const now = Date.now();
    const saved = wakeRecord({
      idleAsked: false,
      wrapCause: null,
      wakes: 4,
      wakesAt: [now - 1000],
      lastWakeAt: now - 1000,
      asleepSince: null,
      freshSessions: 2,
    } as never);
    const restored = restoredWake(JSON.parse(JSON.stringify(saved)), now) as { freshSessions?: number };
    assert.equal(restored.freshSessions, 2);
  });
});
