/**
 * The director's wake loop, without a rig: when the lead is woken and why (wake-schedule.ts),
 * what the message that wakes it says (wake-prompts.ts), what the journal keeps (wake.ts), and
 * the typed lines the run's producers write so the waker never reads English.
 *
 * The lead used to stay inside one long turn — `wait` in a loop and a "continue" prompt whenever
 * the turn ended with time left, which stretched a single session over the whole run. Now it ends its turn after every decision and the studio wakes the same
 * session with a digest when something happens. Every clock here is a number the test chooses.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  afterTurn,
  DIRECTOR_LOOP_ENV,
  DirectorLoop,
  directorLoopOf,
  HEARTBEAT_MS,
  MAX_WAKES_PER_HOUR,
  nextWake,
  NOTE_WAKE,
  NoteKind,
  passDeadline,
  TurnEnd,
  WAKE_DEBOUNCE_MS,
  WRAP_UP_MARGIN_MS,
  WakeCause,
  WakeUrgency,
  WrapCause,
  type WakeView,
} from "../../src/harness-seed/loop/director/wake-schedule.ts";
import {
  CARD_MAX_LINES,
  freshStart,
  idleAsk,
  WAKE_BRIEF,
  wakeDigest,
  wakeRules,
  wakeTools,
  wrapLead,
  type DigestFacts,
} from "../../src/harness-seed/loop/director/wake-prompts.ts";
import * as wakePrompts from "../../src/harness-seed/loop/director/wake-prompts.ts";
import { wakeRecord } from "../../src/harness-seed/loop/director/journal.ts";
import { DIRECTOR_TOOLS, directorBrief, monitorNote, waitForPlanGo } from "../../src/harness-seed/loop/director.ts";
import { HOUR_MS, MINUTE_MS } from "../../src/harness-seed/loop/time.ts";
import {
  bookmarkLead,
  chatBookmark,
  continuesChat,
  leadSeat,
} from "../../src/harness-seed/loop/director/lead-session.ts";
import { CHAT_SO_FAR_MESSAGES, chatSoFar } from "../../src/harness-seed/loop/director/lead-session-prompts.ts";
import { priorCommitWords } from "../../src/harness-seed/loop/director/journal-prompts.ts";
import { hasConflictMarkers } from "../../src/harness-seed/loop/director/conflict-worker.ts";
import { DIRECTOR_LOOP_ENV as SHARED_DIRECTOR_LOOP_ENV, harnessRunEnv } from "../../src/shared/protocol.ts";

const T0 = Date.UTC(2026, 8, 25, 14, 0, 0);

/** A lead asleep since T0 with one worker running and nothing unread: override what the row is about. */
const view = (over: Partial<WakeView> = {}): WakeView => ({
  now: T0,
  unread: [],
  asleepFromSeq: 10,
  asleepSince: T0,
  userWaiting: false,
  finishNew: false,
  running: 1,
  planWindowEndsAt: null,
  workersLimitLiftsAt: null,
  softDeadline: T0 + HOUR_MS,
  wrapping: false,
  idleDue: false,
  idleAsked: false,
  wakesAt: [],
  ...over,
});

describe("when the lead is woken (wake-schedule.ts)", () => {
  it("W1. wakes five seconds after a worker's round, and news in that window rides along", () => {
    const round = { at: T0, seq: 11, kind: NoteKind.WorkerRound };
    assert.deepEqual(nextWake(view({ unread: [round] })), {
      at: T0 + WAKE_DEBOUNCE_MS,
      reasons: [NoteKind.WorkerRound],
    });
    const second = { at: T0 + 2_000, seq: 12, kind: NoteKind.WorkerRound };
    assert.deepEqual(
      nextWake(view({ now: T0 + 2_000, unread: [round, second] })),
      { at: T0 + WAKE_DEBOUNCE_MS, reasons: [NoteKind.WorkerRound] },
      "a second round inside the window neither moves the wake nor says itself twice",
    );
    // A round that landed while the lead was still in its turn is news once it rests.
    const duringTurn = { at: T0 - 60_000, seq: 9, kind: NoteKind.WorkerEnded };
    assert.deepEqual(nextWake(view({ unread: [duringTurn] })), {
      at: T0 + WAKE_DEBOUNCE_MS,
      reasons: [NoteKind.WorkerEnded],
    });
  });

  it("W2. wakes at once for the user — a message or a finish request — even while other news settles", () => {
    const round = { at: T0, seq: 11, kind: NoteKind.WorkerRound };
    const said = nextWake(view({ now: T0 + 1_000, unread: [round], userWaiting: true }))!;
    assert.equal(said.at, T0 + 1_000);
    assert.ok(said.reasons.includes(WakeCause.UserMessage), JSON.stringify(said));
    const finishing = nextWake(view({ now: T0 + 1_000, unread: [round], finishNew: true }))!;
    assert.equal(finishing.at, T0 + 1_000);
    assert.ok(finishing.reasons.includes(WakeCause.FinishRequested), JSON.stringify(finishing));
    const toWorker = nextWake(view({ unread: [{ at: T0, seq: 11, kind: NoteKind.UserToWorker }] }))!;
    assert.deepEqual(toWorker, { at: T0, reasons: [NoteKind.UserToWorker] }, "the user speaking to a worker");
  });

  it("W3. sleeps through what the lead caused itself, and through lines that ask nothing of it", () => {
    const quiet = [
      { at: T0, seq: 9, text: "its own note, from its own turn" },
      { at: T0, seq: 11, kind: NoteKind.WorkerStopped },
      { at: T0, seq: 12, kind: NoteKind.MonitorQuiet },
      { at: T0, seq: 13, kind: NoteKind.DefectShelved },
      { at: T0, seq: 14, kind: NoteKind.DefectRouted },
    ];
    assert.deepEqual(
      nextWake(view({ unread: quiet })),
      { at: T0 + HEARTBEAT_MS, reasons: [WakeCause.Heartbeat] },
      "nothing but the heartbeat is ahead",
    );
    // Flipped (review of the wake loop): with nothing running, these lines no longer leave the
    // lead asleep until the wrap-up. They still wake nobody; the lead is asked what next instead.
    assert.deepEqual(
      nextWake(view({ unread: quiet, running: 0 })),
      { at: T0, reasons: [WakeCause.IdleAsk] },
      "nothing runs and nothing else is ahead: asked what next",
    );
    // A line with no kind that arrived while the lead slept is somebody else's: it wakes, as news.
    const news = { at: T0 + 1_000, seq: 15 };
    assert.deepEqual(nextWake(view({ now: T0 + 1_000, unread: [...quiet, news], running: 0 })), {
      at: T0 + 1_000 + WAKE_DEBOUNCE_MS,
      reasons: [WakeCause.News],
    });
  });

  it("W4. a heartbeat after twenty quiet minutes, only while builders run", () => {
    assert.deepEqual(nextWake(view({ running: 1 })), { at: T0 + HEARTBEAT_MS, reasons: [WakeCause.Heartbeat] });
    // Flipped (review of the wake loop): nobody building used to mean nothing ahead but the
    // wrap-up; now it is the idle question, once. Asked already, only the wrap-up is ahead.
    assert.deepEqual(
      nextWake(view({ running: 0 })),
      { at: T0, reasons: [WakeCause.IdleAsk] },
      "nobody is building: no heartbeat, the question of what next",
    );
    assert.deepEqual(
      nextWake(view({ running: 0, idleAsked: true })),
      { at: T0 + HOUR_MS, reasons: [WakeCause.WrapUp] },
      "asked already: nothing to check on",
    );
    assert.equal(HEARTBEAT_MS, 20 * MINUTE_MS);
  });

  it("W5. no more than thirty wakes an hour; the user, finish, the plan window and the wrap-up are never held back", () => {
    const oldest = T0 - 50 * MINUTE_MS;
    const wakesAt = Array.from({ length: MAX_WAKES_PER_HOUR }, (_, i) => oldest + i * MINUTE_MS);
    const round = { at: T0, seq: 11, kind: NoteKind.WorkerRound };
    assert.deepEqual(nextWake(view({ unread: [round], wakesAt })), {
      at: oldest + HOUR_MS,
      reasons: [NoteKind.WorkerRound],
    });
    assert.equal(nextWake(view({ unread: [round], wakesAt, userWaiting: true }))!.at, T0);
    assert.equal(nextWake(view({ wakesAt, finishNew: true }))!.at, T0);
    assert.deepEqual(nextWake(view({ wakesAt, planWindowEndsAt: T0 - 1 })), {
      at: T0,
      reasons: [WakeCause.PlanWindow],
    });
    assert.deepEqual(nextWake(view({ wakesAt, softDeadline: T0 - 1 })), { at: T0, reasons: [WakeCause.WrapUp] });
    // One wake fewer in the window, and the round goes at once.
    assert.equal(nextWake(view({ unread: [round], wakesAt: wakesAt.slice(1) }))!.at, T0 + WAKE_DEBOUNCE_MS);
  });

  it("W6. the plan window's end, the wrap-up and the workers' limit resetting are timers, each said once", () => {
    assert.deepEqual(nextWake(view({ planWindowEndsAt: T0 + 3 * MINUTE_MS })), {
      at: T0 + 3 * MINUTE_MS,
      reasons: [WakeCause.PlanWindow],
    });
    assert.deepEqual(nextWake(view({ workersLimitLiftsAt: T0 + 7 * MINUTE_MS })), {
      at: T0 + 7 * MINUTE_MS,
      reasons: [WakeCause.WorkersLimitLifted],
    });
    assert.deepEqual(nextWake(view({ softDeadline: T0 + MINUTE_MS })), {
      at: T0 + MINUTE_MS,
      reasons: [WakeCause.WrapUp],
    });
    // Once said, the loop hands the schedule nothing more to say about them.
    assert.deepEqual(nextWake(view({ softDeadline: T0 + MINUTE_MS, wrapping: true, running: 0 })), null);
    // A timer already past is due now, with whatever else is due by then.
    assert.deepEqual(nextWake(view({ now: T0 + 5 * MINUTE_MS, planWindowEndsAt: T0, softDeadline: T0 })), {
      at: T0 + 5 * MINUTE_MS,
      reasons: [WakeCause.PlanWindow, WakeCause.WrapUp],
    });
    assert.deepEqual(nextWake(view({ idleDue: true })), { at: T0, reasons: [WakeCause.IdleAsk] });
  });

  it("W7. asks once what next when nothing runs, then wraps up; a running builder, an open plan window or a pending workers' limit is not idle", () => {
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
    assert.deepEqual(afterTurn(idle), { next: TurnEnd.AskIdle, idleAsked: true });
    assert.deepEqual(afterTurn({ ...idle, idleAsked: true }), {
      next: TurnEnd.WrapUp,
      idleAsked: true,
      wrapCause: WrapCause.Idle,
    });
    for (const busy of [{ running: 1 }, { planWindowOpen: true }, { workersLimitPending: true }])
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

  it("W8. a lead that went to sleep busy is asked what next the moment nothing runs and nothing else is ahead", () => {
    // The lead stopped its last worker and ended its turn; the worker has settled since.
    const stopped = { at: T0, seq: 11, kind: NoteKind.WorkerStopped };
    assert.deepEqual(nextWake(view({ running: 0, unread: [stopped] })), { at: T0, reasons: [WakeCause.IdleAsk] });
    // Whatever else wakes it keeps its own time and reasons: the question waits for that turn's end.
    const ended = { at: T0, seq: 11, kind: NoteKind.WorkerEnded };
    assert.deepEqual(nextWake(view({ running: 0, unread: [ended] })), {
      at: T0 + WAKE_DEBOUNCE_MS,
      reasons: [NoteKind.WorkerEnded],
    });
    assert.deepEqual(nextWake(view({ running: 0, userWaiting: true })), {
      at: T0,
      reasons: [WakeCause.UserMessage],
    });
    assert.deepEqual(nextWake(view({ running: 0, planWindowEndsAt: T0 + 3 * MINUTE_MS })), {
      at: T0 + 3 * MINUTE_MS,
      reasons: [WakeCause.PlanWindow],
    });
    assert.deepEqual(nextWake(view({ running: 0, workersLimitLiftsAt: T0 + 7 * MINUTE_MS })), {
      at: T0 + 7 * MINUTE_MS,
      reasons: [WakeCause.WorkersLimitLifted],
    });
    // Out of working time it is the wrap-up, not a question; wrapping up, nothing at all.
    assert.deepEqual(nextWake(view({ running: 0, softDeadline: T0 - 1 })), { at: T0, reasons: [WakeCause.WrapUp] });
    assert.equal(nextWake(view({ running: 0, wrapping: true })), null);
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

  it("W10. the finish mark is a timer: it wakes the lead once at its time, uncapped, and never in the wrap-up", () => {
    const mark = T0 + 10 * MINUTE_MS;
    assert.deepEqual(nextWake(view({ finishMarkAt: mark })), { at: mark, reasons: [WakeCause.FinishMark] });
    // The hourly cap holds the heartbeat back, never the mark.
    const wakesAt = Array.from({ length: MAX_WAKES_PER_HOUR }, (_, i) => T0 - 50 * MINUTE_MS + i * MINUTE_MS);
    assert.deepEqual(nextWake(view({ finishMarkAt: mark, wakesAt })), { at: mark, reasons: [WakeCause.FinishMark] });
    // A mark already past (a goal run sent to art direction, a Resume after it) is due now.
    assert.deepEqual(nextWake(view({ now: mark + MINUTE_MS, finishMarkAt: mark })), {
      at: mark + MINUTE_MS,
      reasons: [WakeCause.FinishMark],
    });
    // Wrapping up, the mark is gone; once said, the loop hands the schedule none.
    assert.equal(nextWake(view({ finishMarkAt: mark, wrapping: true, running: 0 })), null);
    assert.deepEqual(nextWake(view({ finishMarkAt: null })), { at: T0 + HEARTBEAT_MS, reasons: [WakeCause.Heartbeat] });
    // A timer ahead, like the wrap-up: a run gone idle before its mark is still asked what next.
    assert.deepEqual(nextWake(view({ running: 0, finishMarkAt: mark })), { at: T0, reasons: [WakeCause.IdleAsk] });
  });

  it("W10c. the art director's regular look is a timer of its own: due at its time, uncapped, and never in the wrap-up", () => {
    const shipLook = WakeCause.ShipLook;
    const look = T0 + 10 * MINUTE_MS;
    const at = (over: Partial<WakeView>) => nextWake(view(over));
    assert.deepEqual(at({ shipLookAt: look }), { at: look, reasons: [shipLook] });
    // The hourly cap holds the heartbeat back, never the look: four busy workers fill the cap.
    const wakesAt = Array.from({ length: MAX_WAKES_PER_HOUR }, (_, i) => T0 - 50 * MINUTE_MS + i * MINUTE_MS);
    assert.deepEqual(at({ shipLookAt: look, wakesAt }), { at: look, reasons: [shipLook] });
    // Due already (the wave came in while the lead was busy): now.
    assert.deepEqual(at({ now: look + MINUTE_MS, shipLookAt: look }), { at: look + MINUTE_MS, reasons: [shipLook] });
    // The wrap-up takes no look: wrapping, or a working time already over.
    assert.equal(at({ shipLookAt: look, wrapping: true, running: 0 }), null);
    assert.deepEqual(at({ softDeadline: T0 - 1_000, shipLookAt: look, running: 2 })?.reasons, [WakeCause.WrapUp]);
  });

  it("W10b. a finish mark still unsaid when the wrap-up is due gives way to the wrap-up: the two never share a wake", () => {
    // A Mac that slept through both times, or a Resume of a run paused in its wrap-up (soft deadline now).
    const mark = T0 - 40 * MINUTE_MS;
    const due = nextWake(view({ softDeadline: T0 - 1_000, finishMarkAt: mark, running: 2 }));
    assert.deepEqual(due?.reasons, [WakeCause.WrapUp]);
    assert.deepEqual(nextWake(view({ softDeadline: T0, finishMarkAt: mark, running: 0 })), {
      at: T0,
      reasons: [WakeCause.WrapUp],
    });
    // Ahead of the wrap-up, the mark still wakes the lead on its own.
    assert.deepEqual(nextWake(view({ now: mark, finishMarkAt: mark })), { at: mark, reasons: [WakeCause.FinishMark] });
  });

  it("W11. a goal run idle twice with no ship review on its head is sent to art direction once, then wraps up", () => {
    const idle = {
      ok: true,
      closed: false,
      running: 0,
      planWindowOpen: false,
      workersLimitPending: false,
      idleAsked: true,
      workingTimeLeft: true,
      finishRequested: false,
      artDirectionOwed: true,
    };
    assert.deepEqual(afterTurn(idle), { next: TurnEnd.ArtDirection, idleAsked: true });
    // Art direction said (or never owed): the second idle turn wraps up as before.
    assert.deepEqual(afterTurn({ ...idle, artDirectionOwed: false }), {
      next: TurnEnd.WrapUp,
      idleAsked: true,
      wrapCause: WrapCause.Idle,
    });
    // The first idle turn is still asked what next, a busy one sleeps, and no working time wraps up.
    assert.deepEqual(afterTurn({ ...idle, idleAsked: false }), { next: TurnEnd.AskIdle, idleAsked: true });
    assert.deepEqual(afterTurn({ ...idle, running: 1 }), { next: TurnEnd.Sleep, idleAsked: false });
    assert.deepEqual(afterTurn({ ...idle, workingTimeLeft: false }), {
      next: TurnEnd.WrapUp,
      idleAsked: true,
      wrapCause: WrapCause.Deadline,
    });
  });

  it("the wake loop is the default; the long turn is only asked for by name", () => {
    assert.equal(directorLoopOf({}), DirectorLoop.Wake);
    assert.equal(directorLoopOf({ directorLoop: "wake" }), DirectorLoop.Wake);
    assert.equal(directorLoopOf({ directorLoop: "turn" }), DirectorLoop.Turn);
    // A shipped build's way back: the studio's environment names the loop for a run that names none.
    const turn = { [DIRECTOR_LOOP_ENV]: "turn" };
    assert.equal(directorLoopOf({}, turn), DirectorLoop.Turn);
    assert.equal(directorLoopOf({ directorLoop: "wake" }, turn), DirectorLoop.Wake, "the run's own word wins");
    assert.equal(directorLoopOf({}, { [DIRECTOR_LOOP_ENV]: "sideways" }), DirectorLoop.Wake);
    // The studio hands the harness that one variable of its own, and only when it is set.
    assert.deepEqual(harnessRunEnv({ [SHARED_DIRECTOR_LOOP_ENV]: "turn", HOME: "/Users/me" }), {
      [SHARED_DIRECTOR_LOOP_ENV]: "turn",
    });
    assert.deepEqual(harnessRunEnv({ HOME: "/Users/me" }), {});
    assert.deepEqual(harnessRunEnv({ [SHARED_DIRECTOR_LOOP_ENV]: " " }), {});
  });
});

/** One wake's facts: a user message, two lines of news, one worker, an open plan. */
const facts = (over: Partial<DigestFacts> = {}): DigestFacts => ({
  now: T0,
  reasons: [WakeCause.UserMessage, NoteKind.WorkerEnded],
  userSays: ["make the sky red", "and the benches oak"],
  finishNew: false,
  happened: ["the plan is on the user's screen: sky", "worker sky done"],
  softDeadline: T0 + 42 * MINUTE_MS,
  finalDeadline: T0 + 52 * MINUTE_MS,
  wrapping: false,
  integrationHead: "abcdef1234567890",
  integrationHealthy: true,
  defects: [],
  workers: [
    {
      id: "sky",
      title: "Dusk sky",
      state: "running",
      minutesLeft: 12,
      round: 2,
      accepted: 1,
      passing: "3/5",
      filesChanged: 4,
    },
  ],
  planWindowUntil: null,
  workersLimit: null,
  finishRequested: false,
  card: {
    runId: "run_w",
    project: "skate",
    goal: "a dusk plaza",
    direction: true,
    plan: { summary: "This run: a dusk sky over the plaza.", parts: ["sky"] },
  },
  closing: "Decide, act, and end your turn — the studio wakes you when something happens.",
  ...over,
});

describe("what the message that wakes the lead says (wake-prompts.ts)", () => {
  it("P1. the digest: the user's words first and verbatim, then what happened, then where the run stands, then a build card of at most fifteen lines — no worktree path", () => {
    const digest = wakeDigest(facts());
    assert.match(digest, /^WOKEN AT 14:00 UTC — /);
    const order = ["THE USER SAYS", "make the sky red", "WHAT HAPPENED", "worker sky done", "WHERE THE RUN STANDS"];
    const at = [...order, "BUILD CARD", "Decide, act, and end your turn"].map((mark) => digest.indexOf(mark));
    assert.ok(
      at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1]!)),
      `in order: ${JSON.stringify(at)}\n${digest}`,
    );
    assert.ok(digest.indexOf("make the sky red") < digest.indexOf("and the benches oak"), "oldest first");
    assert.match(digest, /- time: 42 working minutes, wrap-up at 14:42 UTC, 52 minutes in all/);
    assert.match(digest, /- integration: abcdef1234, last health pass loads/);
    assert.match(digest, /- worker sky \(Dusk sky\): running · 12 min left · round 2 · 1 accepted · passing 3\/5/);
    const card = digest.slice(digest.indexOf("BUILD CARD")).split("\n\n")[0]!.split("\n");
    assert.ok(card.length <= CARD_MAX_LINES, `the card is ${card.length} lines:\n${card.join("\n")}`);
    assert.match(card.join("\n"), /Plan: This run: a dusk sky over the plaza\. — parts: sky/);
    assert.match(card.join("\n"), /end your turn after each decision/i);
    assert.doesNotMatch(digest, /autopilot\/run_w|\/integration\b/, "no worktree path");
    assert.doesNotMatch(digest, /THE USER ASKED TO FINISH/);
    const finishing = wakeDigest(facts({ userSays: [], finishNew: true, finishRequested: true }));
    assert.match(finishing, /THE USER ASKED TO FINISH: integrate what is ready and call finish\./);
    assert.doesNotMatch(finishing, /THE USER SAYS/, "no section for nobody's words");
    const nothing = wakeDigest(facts({ userSays: [], happened: [], card: { ...facts().card, plan: null } }));
    assert.match(nothing, /WHAT HAPPENED:\n- nothing new since your last turn/);
    assert.match(nothing, /Plan: none yet — call plan before your first worker/);
    const many = wakeDigest(facts({ happened: Array.from({ length: 50 }, (_, i) => `line ${i}`) }));
    assert.match(many, /line 49/, "the newest are kept");
    assert.doesNotMatch(many, /line 0\n/);
    assert.match(many, /10 earlier lines not shown/);
  });

  it("P2. an idle ask on a direction build says the timed build still has its minutes; a wrap-up says why it started", () => {
    assert.match(
      idleAsk({ direction: true, minutesLeft: 42 }),
      /^The timed build still has 42 working minutes and nothing is running\. What next\?/,
    );
    assert.match(idleAsk({ direction: true, minutesLeft: 42 }), /the studio starts the wrap-up/);
    assert.match(
      idleAsk({ direction: false, minutesLeft: 42 }),
      /^Nothing is running and 42 working minutes remain\. What next\?/,
    );
    const wrap = "Run run_w: your session reached its deadline; 9 minutes remain.";
    assert.equal(wrapLead(WrapCause.Deadline, wrap), wrap, "the deadline needs no reason");
    assert.match(
      wrapLead(WrapCause.Idle, wrap),
      /^Nothing was running and your last turn started nothing[\s\S]*Run run_w/,
    );
    assert.match(wrapLead(WrapCause.Failed, wrap), /^Your last turn failed[\s\S]*Run run_w/);
    assert.match(wrapLead(WrapCause.Finish, wrap), /^The user asked to finish[\s\S]*Run run_w/);
  });

  it("P3. a lost session's fresh start carries the brief, the wake rules, the lead's notes, the recent log and the news", () => {
    const lost = {
      why: "the session was not found",
      brief: "You are the DIRECTOR of run run_w",
      rules: wakeRules({ heartbeatMinutes: 20 }),
      notes: ["sky started; the plaza is next"],
      recent: ["worker sky started (single)"],
      digest: "WOKEN AT 14:00 UTC — a worker ended",
    };
    const fresh = freshStart({ ...lost, lead: true });
    // One session: a lead has no memory file to read first — the notes and the run so far follow.
    const order = [
      "YOUR EARLIER SESSION WAS LOST (the session was not found)",
      "Your notes and the run so far are below",
      "You are the DIRECTOR of run run_w",
      "HOW THIS RUN WORKS",
      "YOUR NOTES",
      "sky started; the plaza is next",
      "THE RUN SO FAR",
      "worker sky started (single)",
      "WOKEN AT 14:00 UTC",
    ];
    const at = order.map((mark) => fresh.indexOf(mark));
    assert.ok(
      at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1]!)),
      `in order: ${JSON.stringify(at)}\n${fresh}`,
    );
    assert.ok(fresh.startsWith("YOUR EARLIER SESSION WAS LOST"));
    assert.ok(!fresh.includes("DIRECTOR.md"), "and no memory file is named");
    // Flipped (review of one session): with no lead — a director with its own hands, as a kept
    // director.ts from before one session drives the wake loop — its memory file is read first.
    const hands = freshStart(lost);
    assert.match(
      hands,
      /^YOUR EARLIER SESSION WAS LOST \(the session was not found\)[^\n]*Read \.studio\/DIRECTOR\.md/,
    );
    assert.doesNotMatch(hands, /Your notes and the run so far are below/);
  });

  it("P3b. a fresh session gets the build card the lost one had already been shown", () => {
    const card = "THE BUILD — run run_w · a dusk plaza · plan: sky, plaza";
    const fresh = freshStart({
      why: "the session was not found",
      brief: "You are the DIRECTOR of run run_w",
      rules: wakeRules({ heartbeatMinutes: 20 }),
      notes: [],
      recent: [],
      // The wake that lost the session left the card out: the old session had seen it.
      digest: "WOKEN AT 14:00 UTC — a worker ended",
      card,
      lead: true,
    });
    assert.ok(fresh.includes(card), "the new session knows what the build is");
    assert.ok(fresh.indexOf(card) < fresh.indexOf("WOKEN AT 14:00 UTC"), "before the news it frames");
  });

  it("P4. a waking lead's tools have no wait and tell it to end its turn", () => {
    const tools = wakeTools(DIRECTOR_TOOLS, { lead: true });
    assert.deepEqual(
      tools.map((t) => t.name),
      DIRECTOR_TOOLS.map((t) => t.name).filter((name) => name !== "wait"),
    );
    const start = tools.find((t) => t.name === "worker_start")!;
    assert.match(start.description, /end your turn/);
    assert.doesNotMatch(start.description, /use wait/);
    // A waking lead writes nothing (one session): a conflict `integrate` meets goes to a worker.
    const integrate = tools.find((t) => t.name === "integrate")!;
    assert.match(integrate.description, /A conflict elsewhere goes to a worker/);
    assert.doesNotMatch(integrate.description, /resolve it yourself/);
    // Flipped (review of one session): a director with its own hands on the wake loop (no lead: a
    // kept director.ts from before one session) resolves a conflict itself, as it always did.
    const hands = wakeTools(DIRECTOR_TOOLS).find((t) => t.name === "integrate")!;
    assert.match(hands.description, /resolve it yourself with git in your worktree/);
    assert.doesNotMatch(hands.description, /goes to a worker/);
    assert.match(wakeTools(DIRECTOR_TOOLS).find((t) => t.name === "worker_start")!.description, /end your turn/);
    // The same flat string schemas both bridges carry (the tools test in director.test.ts).
    for (const tool of tools) {
      assert.equal(tool.parameters.type, "object");
      for (const prop of Object.values(tool.parameters.properties))
        assert.equal((prop as { type: string }).type, "string");
      for (const req of tool.parameters.required ?? []) assert.ok(req in tool.parameters.properties);
      assert.ok(tool.description.length > 40, `${tool.name} is described`);
    }
    assert.ok(JSON.stringify(tools).length <= JSON.stringify(DIRECTOR_TOOLS).length, "no bigger than the old set");
    // The set the long turn is offered is left as it was, `wait` and all.
    assert.ok(DIRECTOR_TOOLS.some((t) => t.name === "wait"));
    assert.match(DIRECTOR_TOOLS.find((t) => t.name === "worker_start")!.description, /use wait/);
  });

  it("P7. the build card gives a lead its rule (it builds in the integration worktree), and a director with its own hands its memory file — each within the card's bound", () => {
    const cardOf = (lead: boolean | undefined) => {
      const digest = wakeDigest(facts({ card: { ...facts().card, ...(lead === undefined ? {} : { lead }) } }));
      return digest.slice(digest.indexOf("BUILD CARD")).split("\n\n")[0]!;
    };
    const lead = cardOf(true);
    // Flipped (the lead builds with its own hands): its card says where it builds, not that it only reads.
    assert.match(lead, /You build in the integration worktree and commit there/);
    assert.doesNotMatch(lead, /DIRECTOR\.md|You only read/);
    for (const hands of [cardOf(false), cardOf(undefined)]) {
      assert.match(hands, /Keep \.studio\/DIRECTOR\.md current/);
      assert.doesNotMatch(hands, /You build in the integration worktree/);
    }
    for (const card of [lead, cardOf(false)])
      assert.ok(card.split("\n").length <= CARD_MAX_LINES, `the card is ${card.split("\n").length} lines`);
  });

  it("P7b. a goal build's card and brief say the art director's blocker and visible defects are required finishing, never optional polish, and its nits stay optional", () => {
    const goal = wakeDigest(facts({ card: { ...facts().card, direction: false, goalCommission: true } }));
    const card = goal.slice(goal.indexOf("BUILD CARD")).split("\n\n")[0]!;
    assert.match(card, /do not continue optional polish/, "optional polish is still not the goal build's work");
    assert.match(card, /art director's blocker and visible defects[^\n]*not optional polish/);
    assert.match(card, /nits stay optional/);
    assert.ok(card.split("\n").length <= CARD_MAX_LINES, `the card is ${card.split("\n").length} lines`);
    // A legacy run that is neither a goal nor a duration commission has no finish the art director
    // turns back: its card, like its brief, says nothing of the art director's defects.
    const legacy = wakeDigest(facts({ card: { ...facts().card, direction: false } }));
    const legacyCard = legacy.slice(legacy.indexOf("BUILD CARD")).split("\n\n")[0]!;
    assert.match(legacyCard, /do not continue optional polish/);
    assert.doesNotMatch(legacyCard, /art director/, "only a goal commission's card names the art director's defects");

    const now = Date.now();
    const brief = directorBrief({
      run: {
        runId: "run_g",
        project: "skate",
        goal: "a plaza to skate",
        engine: "claude-code",
        budgets: { completionPolicy: "goal" },
      },
      shape: { entry: "index.html", main: "src/main.js", build: null },
      ownShape: false,
      capacity: { max: 6, free: 5, memory: { freeMb: 9000 } },
      skill: "# playbook",
      softDeadline: now + HOUR_MS,
      finalDeadline: now + 2 * HOUR_MS,
      integrationWorktree: "/w",
      baseCommit: "abcdef1234567890",
      loop: DirectorLoop.Wake,
    } as never);
    const time = brief.split("\n").find((line) => line.startsWith("TIME:"))!;
    assert.match(time, /Report blockers instead of optional polish/);
    assert.match(time, /art director's blocker and visible defects[^\n]*not optional polish/);
  });

  it("P8. a worker from before a pause is brought in by a worker for a lead, and by a merge in its worktree for a director with its own hands", () => {
    const prior = {
      lastCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      from: "0f0f0f0f0f",
      ref: "refs/studio/runs/r/workers/sky",
    };
    const lead = priorCommitWords({ ...prior, lead: true });
    assert.match(lead, /worker_start from=a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 builds on it/);
    assert.match(lead, /integrating a worker started from it brings it in/);
    assert.doesNotMatch(lead, /git merge|in your worktree/);
    assert.match(
      priorCommitWords(prior),
      /`git merge a1b2c3d4e5f60718293a4b5c6d7e8f9012345678` in your worktree brings it in/,
    );
  });

  it("P5. the wake brief swaps the plan-review and user sentences, names no wait, and stays under five thousand characters of its own", () => {
    const now = Date.now();
    const skill = "# playbook\n" + "a rule the architect wrote\n".repeat(400);
    const base = {
      run: { runId: "run_b", project: "skate", goal: "refine the plaza", engine: "claude-code" },
      shape: { entry: "index.html", main: "src/main.js", build: null },
      ownShape: false,
      capacity: { max: 6, free: 5, memory: { freeMb: 9000 } },
      skill,
      softDeadline: now + 3_600_000,
      finalDeadline: now + 7_200_000,
      integrationWorktree: "/w",
      baseCommit: "abcdef1234567890",
    };
    const turn = directorBrief(base as never);
    assert.equal(directorBrief({ ...base, loop: DirectorLoop.Turn } as never), turn, "the default brief is unchanged");
    const wake = directorBrief({ ...base, loop: DirectorLoop.Wake } as never);
    assert.ok(wake.length - skill.length < 5_000, `the wake brief's own words are ${wake.length - skill.length}`);
    const tools = wake.split("\n").find((line) => line.startsWith("- The run's own tools:"))!;
    assert.equal(
      tools,
      `- The run's own tools: ${wakeTools(DIRECTOR_TOOLS)
        .map((t) => t.name)
        .join(", ")}.`,
    );
    assert.doesNotMatch(tools, /\bwait\b/);
    assert.ok(wake.includes(WAKE_BRIEF.userSays), "the user's words open the message that wakes it");
    assert.doesNotMatch(wake, /USER SAYS in wait/);
    const reviewed = directorBrief({
      ...base,
      loop: DirectorLoop.Wake,
      run: { ...base.run, reviewPlan: true },
    } as never);
    assert.ok(reviewed.includes(WAKE_BRIEF.planReview));
    // The plan review's own sentence rides on top of the five thousand: it adds that, and nothing more.
    assert.ok(
      reviewed.length - wake.length <= WAKE_BRIEF.planReview.length,
      `the plan review adds ${reviewed.length - wake.length} characters`,
    );
    assert.ok(
      reviewed.length - skill.length < 5_000 + WAKE_BRIEF.planReview.length,
      `the reviewed wake brief's own words are ${reviewed.length - skill.length}`,
    );
    assert.match(reviewed, /THE USER ASKED TO READ IT FIRST: your first worker waits for their word/);
    assert.match(reviewed, /end your turn after plan/);
    assert.doesNotMatch(reviewed, /your first worker_start waits/);
  });

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

  it("P6. the wake rules are bounded and name the heartbeat", () => {
    const rules = wakeRules({ heartbeatMinutes: 20 });
    assert.ok(rules.length <= 800, `${rules.length} characters`);
    assert.match(rules, /^HOW THIS RUN WORKS — ONE DECISION PER TURN:/);
    assert.match(rules, /every 20 minutes while workers run/);
    assert.match(rules, /end your turn/i);
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

describe("the lines the run writes, typed for the waker", () => {
  it("M1. a fresh violation is a waking line; its clearing and a silent round are not", () => {
    const look = (over: Record<string, unknown>) => ({
      id: "plaza",
      round: 1,
      minutesInRound: 14,
      files: ["src/plaza.js"],
      violations: [],
      ...over,
    });
    const violation = "edited a file outside this facet's ownership (src/sky.js)";
    const fresh = monitorNote(null, look({ violations: [violation] }))!;
    assert.equal(fresh.kind, NoteKind.MonitorViolation);
    assert.equal(NOTE_WAKE[fresh.kind], WakeUrgency.Soon);
    const cleared = monitorNote({ violations: [violation] }, look({ violations: [] }))!;
    assert.equal(cleared.kind, NoteKind.MonitorQuiet);
    assert.equal(NOTE_WAKE[cleared.kind], WakeUrgency.Never);
    const silent = monitorNote(null, look({ files: [] }))!;
    assert.equal(silent.kind, NoteKind.MonitorQuiet);
    assert.equal(silent.silent, true);
  });

  it("H1. a zero plan slice reads the inbox once and never sleeps", async () => {
    let reads = 0;
    const held = await waitForPlanGo({
      until: T0 + 4 * MINUTE_MS,
      sliceMs: 0,
      now: () => T0,
      read: async () => {
        reads++;
        return [];
      },
      sleep: async () => {
        throw new Error("a zero slice never sleeps");
      },
    });
    assert.equal(held.reason, "slice");
    assert.equal(reads, 1);
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

  it("O4. a lead's brief says where it sits and that it builds in the integration worktree with its own hands, names no memory file, and stays bounded; the long turn keeps its hands", () => {
    const now = Date.now();
    const skill = "# playbook\n" + "a rule the architect wrote\n".repeat(400);
    const base = {
      run: { runId: "run_b", project: "skate", goal: "refine the plaza", engine: "claude-code" },
      shape: { entry: "index.html", main: "src/main.js", build: null },
      ownShape: false,
      capacity: { max: 6, free: 5, memory: { freeMb: 9000 } },
      skill,
      softDeadline: now + 3_600_000,
      finalDeadline: now + 7_200_000,
      integrationWorktree: "/scratch/autopilot/run_b/integration",
      baseCommit: "abcdef1234567890",
      nestedRepos: ["wreckage"],
      contract: { ok: false, error: "window.__studio is missing" },
      loop: DirectorLoop.Wake,
    };
    const lead = directorBrief({ ...base, lead: { gameFolder: "/games/skate" } } as never);
    assert.match(lead, /^You are the DIRECTOR of run run_b on the game "skate" — and still this chat's own session/);
    assert.match(lead, /WHERE YOU ARE: your cwd is the game folder the user sees \(\/games\/skate\)/);
    assert.match(lead, /the run's integration worktree \(\/scratch\/autopilot\/run_b\/integration\)/);
    // Flipped (the lead builds with its own hands): it edits and commits in the integration
    // worktree it leads, does foundations and small repairs itself, and hands parallel work out.
    assert.match(lead, /You build there with your own hands/);
    assert.match(lead, /commit them there/);
    assert.match(lead, /do the foundations yourself/);
    assert.match(lead, /wire it yourself in the integration worktree/);
    assert.match(lead, /vendor what the run builds on .*yourself in the integration worktree/);
    assert.doesNotMatch(lead, /DIRECTOR\.md|Edit here yourself|you only READ|every change is a worker's/);
    // The same bound the wake brief keeps (P5), on the same facts.
    const plain = directorBrief({
      ...base,
      nestedRepos: [],
      contract: null,
      lead: { gameFolder: "/games/skate" },
    } as never);
    assert.ok(plain.length - skill.length < 5_000, `the lead's brief's own words are ${plain.length - skill.length}`);
    const turn = directorBrief({ ...base, loop: DirectorLoop.Turn } as never);
    assert.match(turn, /Keep \.studio\/DIRECTOR\.md in your worktree current/);
    assert.match(turn, /Edit here yourself/);
  });
});

describe("a conflict worker's files, read for conflict markers (conflict-worker.ts)", () => {
  it("Q1. finds a whole hunk git left, and not a Markdown heading underlined with =======", () => {
    const rows: Array<{ label: string; text: string; markers: boolean }> = [
      { label: "a hunk", text: "a\n<<<<<<< HEAD\nleft\n=======\nright\n>>>>>>> sky\nb\n", markers: true },
      {
        label: "a hunk with a base (diff3)",
        text: "<<<<<<< ours\nx\n||||||| base\ny\n=======\nz\n>>>>>>> theirs\n",
        markers: true,
      },
      { label: "a hunk with bare markers", text: "<<<<<<<\nx\n=======\ny\n>>>>>>>\n", markers: true },
      { label: "a resolved file", text: "export const sign = ['left', 'right'];\n", markers: false },
      { label: "a setext heading", text: "Title\n=======\n\nbody\n", markers: false },
      { label: "an arrow in a string", text: "const a = '<<<<<<<';\nconst b = '>>>>>>>';\n", markers: false },
      { label: "half a hunk", text: "<<<<<<< HEAD\nleft\n=======\nright\n", markers: false },
    ];
    assert.deepEqual(
      rows.map(({ label, text }) => ({ label, markers: hasConflictMarkers(text) })),
      rows.map(({ label, markers }) => ({ label, markers })),
    );
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

describe("the art director's cadence and the outcome nudge across a Resume", () => {
  it("are kept on the journal in working time, so a Resume neither looks again at once nor forgets the next nudge", async () => {
    const { wakeRecord, restoredWake } = await import("../../src/harness-seed/loop/director/journal.ts");
    const now = Date.now();
    const saved = wakeRecord({
      idleAsked: false,
      wrapCause: null,
      wakes: 7,
      wakesAt: [],
      lastWakeAt: now - 1000,
      asleepSince: null,
      nextShipLookWorkedMs: 150 * MINUTE_MS,
      verifyNudgedWorkedMs: 90 * MINUTE_MS,
    } as never);
    const restored = restoredWake(JSON.parse(JSON.stringify(saved)), now);
    assert.equal(restored.nextShipLookWorkedMs, 150 * MINUTE_MS);
    assert.equal(restored.verifyNudgedWorkedMs, 90 * MINUTE_MS);
    const garbled = restoredWake({ nextShipLookWorkedMs: "soon", verifyNudgedWorkedMs: -5 }, now);
    assert.equal(garbled.nextShipLookWorkedMs, undefined, "a value that is no working time is none");
    assert.equal(garbled.verifyNudgedWorkedMs, undefined);
  });
});
