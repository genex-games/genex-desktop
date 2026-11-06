import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activityNotices,
  applyEvents,
  clearActivity,
  dayGroup,
  EMPTY_NOTICES,
  markRead,
  noticeDestination,
  noticeSource,
  pressReviewFix,
  reviewToasts,
  systemNotes,
  waitingNotices,
  type NoticeState,
} from "../../src/renderer/notifications.ts";
import type { EventEnvelope } from "../../src/renderer/types.ts";
import { resultStatus } from "../../src/renderer/run-steps.ts";
import { loopRunWords, outcomeTitle } from "../../src/renderer/words.ts";
import { summarizeRun, summaryOutcome } from "../../src/shared/run-summary.ts";

let n = 0;
const at = "2026-09-24T10:00:00.000Z";
function custom(threadId: string, event_type: string, payload: Record<string, unknown> = {}): EventEnvelope {
  n += 1;
  return {
    id: `e-${String(n).padStart(4, "0")}`,
    thread_id: threadId,
    session_id: null,
    turn_id: null,
    created_at: at,
    data: { type: "custom", event_type, payload },
  };
}
function user(threadId: string, content = "yes"): EventEnvelope {
  n += 1;
  return {
    id: `e-${String(n).padStart(4, "0")}`,
    thread_id: threadId,
    session_id: null,
    turn_id: null,
    created_at: at,
    data: { type: "messages", messages: [{ role: "user", content }] },
  };
}
const run = (state: NoticeState, events: EventEnvelope[], options?: Parameters<typeof applyEvents>[2]) =>
  applyEvents(state, events, options);

describe("notifications", () => {
  it("keeps a question waiting until the person answers it", () => {
    const asked = run(EMPTY_NOTICES, [
      custom("t1", "interview_question", { question: "Which art style should the village use?", project: "village" }),
    ]);
    assert.equal(waitingNotices(asked.state.items).length, 1);
    assert.equal(asked.arrived[0]?.text, "Which art style should the village use?");
    assert.equal(asked.arrived[0]?.project, "village");
    // Opening the panel reads activity, never a waiting row.
    assert.equal(waitingNotices(markRead(asked.state).items).length, 1);
    const answered = run(asked.state, [user("t2"), user("t1", "Watercolour")]);
    assert.equal(waitingNotices(answered.state.items).length, 0);
  });

  it("settles a permission when it is answered and a plan when it is decided", () => {
    const asked = run(EMPTY_NOTICES, [
      custom("t1", "plugin_consent", {
        consentId: "c1",
        pluginName: "Image studio",
        prompt: "Use the new moon texture?",
        state: "pending",
      }),
      custom("t2", "plan_review", { id: "p1", state: "waiting" }),
    ]);
    assert.deepEqual(
      waitingNotices(asked.state.items)
        .map((item) => item.kind)
        .sort(),
      ["permission", "plan"],
    );
    assert.equal(
      asked.state.items.find((item) => item.kind === "permission")?.text,
      "Image studio: Use the new moon texture?",
    );
    const decided = run(asked.state, [
      custom("t1", "plugin_consent", { consentId: "c1", state: "approved", by: "user" }),
      custom("t2", "plan_review", { id: "p1", state: "approved" }),
    ]);
    assert.equal(waitingNotices(decided.state.items).length, 0);
  });

  it("lets a plan that starts by itself stop waiting", () => {
    const { state } = run(EMPTY_NOTICES, [custom("t1", "autopilot_plan_review", { runId: "r1", waitMinutes: 20 })]);
    const created = Date.parse(at);
    assert.equal(waitingNotices(state.items, created + 60_000).length, 1);
    assert.equal(waitingNotices(state.items, created + 21 * 60_000).length, 0);
    assert.equal(waitingNotices(run(state, [user("t1", "go")]).state.items, created).length, 0);
  });

  it("tells how a build ended, and leaves out a build the person stopped", () => {
    const { state, arrived } = run(EMPTY_NOTICES, [
      custom("t1", "run_finished", { runId: "r1", project: "a", landed: true, executionStatus: "completed" }),
      custom("t2", "run_finished", { runId: "r2", project: "b", executionStatus: "failed" }),
      custom("t3", "run_finished", { runId: "r3", project: "c", landed: false, integrationHead: "x", baseCommit: "y" }),
      custom("t3", "autopilot_paused", { runId: "r3", project: "c" }),
      custom("t4", "run_finished", {
        runId: "r4",
        project: "d",
        stoppedBecause: "stopped by the user",
        executionStatus: "paused",
      }),
    ]);
    assert.deepEqual(
      activityNotices(state.items)
        .map((item) => [item.project, item.tone, item.view])
        .sort(),
      [
        ["a", "done", "live"],
        ["b", "failed", "builds"],
        ["c", "stopped", "builds"],
      ],
    );
    assert.equal(arrived.length, 3);
  });

  it("a Loop that worked in its project's own folder is kept there, never promised as something to play", () => {
    const { state } = run(EMPTY_NOTICES, [
      custom("t1", "run_finished", { runId: "r1", project: "web", landed: true, executionStatus: "completed" }),
      custom("t2", "run_finished", {
        runId: "r2",
        project: "godot",
        landed: true,
        executionStatus: "completed",
        profile: "open",
      }),
    ]);
    const texts = Object.fromEntries(activityNotices(state.items).map((item) => [item.project, item.text]));
    assert.match(String(texts.web), /Changes are live/);
    assert.match(String(texts.godot), /kept in your project/);
    assert.doesNotMatch(String(texts.godot), /live/i);
  });

  it("the run card and its result say a Loop led in its project's own folder kept its work there, never to play in Live", () => {
    const closed = (project: string, profile?: string) =>
      summarizeRun(
        [
          custom("t1", "run_started", { runId: `r-${project}`, project }),
          custom("t1", "run_finished", {
            runId: `r-${project}`,
            project,
            landed: true,
            executionStatus: "completed",
            ...(profile ? { profile } : {}),
          }),
        ],
        project,
        `r-${project}`,
      );
    const open = closed("godot", "open");
    const web = closed("web");
    const graph = { turn: false, active: false } as never;
    const openWords = [
      outcomeTitle(summaryOutcome(open), "card"),
      outcomeTitle(summaryOutcome(open), "full"),
      resultStatus(graph, open).word,
      ...Object.values(loopRunWords({ rounds: 0, landed: true, profile: "open" })),
      ...Object.values(
        loopRunWords({ rounds: 0, landed: true, profile: "open", stoppedBecause: "stopped by the user" }),
      ),
    ];
    for (const words of openWords) assert.doesNotMatch(words, /live|play/i, words);
    assert.ok(openWords.every((words) => !/open Live to play it/.test(words)));
    assert.match(outcomeTitle(summaryOutcome(web), "card"), /Changes are live/, "a web Loop's card is as it was");
    assert.equal(resultStatus(graph, web).word, "Live in your game");
    assert.match(loopRunWords({ rounds: 0, landed: true }).because, /open Live to play it/);
  });

  it("words a failed build and a failed plan, and a started run settles the chat's question", () => {
    const { state } = run(EMPTY_NOTICES, [
      custom("t1", "run_finished", {
        runId: "r7",
        project: "e",
        failure: { message: "The director returned without continuing the timed build." },
      }),
      custom("t2", "plan_review", { id: "p2", state: "failed" }),
      custom("t3", "interview_question", { question: "Night or day?" }),
      custom("t3", "run_started", { runId: "r8" }),
      custom("t4", "interview_question", { question: 42 }),
    ]);
    const build = state.items.find((item) => item.key === "build:r7");
    assert.equal(build?.tone, "failed");
    assert.match(build?.text ?? "", /^Build failed\. /);
    assert.equal(state.items.find((item) => item.key === "plan:t2")?.text, "The plan could not be prepared.");
    assert.equal(waitingNotices(state.items).length, 0, "the run settled t3's question and t4's was not words");
  });

  it("arrives read in the chat being watched and on the first launch", () => {
    const events = [
      custom("t1", "run_finished", { runId: "r5", landed: true }),
      custom("t2", "run_finished", { runId: "r6", landed: true }),
    ];
    const watched = run(EMPTY_NOTICES, events, { seen: (thread) => thread === "t1" });
    assert.deepEqual(
      activityNotices(watched.state.items)
        .filter((item) => !item.read)
        .map((item) => item.threadId),
      ["t2"],
    );
    assert.deepEqual(
      watched.arrived.map((item) => item.threadId),
      ["t2"],
    );
    const first = run(EMPTY_NOTICES, [...events, custom("t3", "interview_question", { question: "Ready?" })], {
      catchUp: true,
    });
    assert.equal(first.arrived.length, 0);
    assert.ok(activityNotices(first.state.items).every((item) => item.read));
    assert.equal(waitingNotices(first.state.items).length, 1, "a question still waits after a relaunch");
  });

  it("reads each event once and keeps the feed bounded", () => {
    const events = Array.from({ length: 80 }, (_, i) =>
      custom(`t${i}`, "run_finished", { runId: `bulk-${i}`, landed: true }),
    );
    const once = run(EMPTY_NOTICES, events);
    assert.equal(activityNotices(once.state.items).length, 60);
    const again = run(once.state, events);
    assert.equal(again.arrived.length, 0);
    assert.equal(again.state, once.state, "nothing new leaves the feed untouched");
    assert.equal(activityNotices(clearActivity(once.state).items).length, 0);
  });

  it("names a provider that needs a new sign-in", () => {
    const { state } = run(EMPTY_NOTICES, [custom("t1", "needs_signin", { engine: "claude-code" })]);
    assert.equal(state.items[0]?.text, "Signed out. Sign in again to keep building.");
    assert.equal(noticeSource(state.items[0]!, "Glass cathedral"), "Claude Code");
    assert.equal(state.items[0]?.engine, "claude-code");
  });

  it("groups by day", () => {
    const now = new Date(2026, 8, 24, 15, 0);
    assert.equal(dayGroup(new Date(2026, 8, 24, 9, 0).toISOString(), now), "Today");
    assert.equal(dayGroup(new Date(2026, 8, 23, 23, 0).toISOString(), now), "Yesterday");
    assert.equal(dayGroup(new Date(2026, 8, 20, 12, 0).toISOString(), now), "Earlier");
  });
});

describe("notifications: games from Play", () => {
  const install = (event: string, payload: Record<string, unknown>) =>
    custom("studio", event, {
      slug: "dust-runners",
      title: "Dust Runners",
      version: "1.3",
      platform: "mac",
      ...payload,
    });

  it("says a game is ready to play, from the game, as news that opens its page", () => {
    const { state, arrived } = run(EMPTY_NOTICES, [install("play_install_finished", {})]);
    const [row] = activityNotices(state.items);
    assert.equal(row?.kind, "play");
    assert.equal(row?.slug, "dust-runners");
    assert.equal(row?.text, "Ready to play on this Mac.");
    assert.equal(row?.waiting, undefined, "news, never something that waits on the person");
    assert.equal(noticeSource(row ?? arrived[0]!, undefined), "Dust Runners");
  });

  it("says why an install failed, naming the space to free, in the failed tone", () => {
    const failed = run(EMPTY_NOTICES, [
      install("play_install_failed", { failure: "no-space", neededBytes: Math.round(2.1 * 1024 ** 3) }),
    ]);
    const [row] = activityNotices(failed.state.items);
    assert.equal(row?.text, "Couldn’t install: free 2.1 GB on this Mac and try again.");
    assert.equal(row?.tone, "failed");
    const odd = run(EMPTY_NOTICES, [install("play_install_failed", { failure: "a reason from a newer app" })]);
    assert.equal(activityNotices(odd.state.items)[0]?.text, "Couldn’t install. Try again.");
  });

  it("tells a new version with its size, and keeps one row per game, the newest", () => {
    const { state } = run(EMPTY_NOTICES, [
      install("play_install_finished", {}),
      install("play_update_available", { version: "1.4", sizeBytes: 120 * 1024 ** 2 }),
    ]);
    const rows = activityNotices(state.items);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.text, "New version · 120 MB. It updates when you play.");
  });

  it("raises nothing for a record that names no game", () => {
    const { state } = run(EMPTY_NOTICES, [custom("studio", "play_install_finished", { title: "Nameless" })]);
    assert.deepEqual(state.items, []);
  });
});

describe("notifications: Genex's review of a game", () => {
  const THINGS = [{ text: "The coin button opens an outside payment page" }, { text: "Loads code from unpkg.com" }];
  const review = (change: string, payload: Record<string, unknown> = {}, project = "asphalt") =>
    custom(`chat-${project}`, "genex_review", {
      project,
      title: project === "asphalt" ? "Midnight Asphalt" : "Skate Dog",
      change,
      at,
      ...payload,
    });
  const fixed = (project = "asphalt") =>
    custom(`chat-${project}`, "genex_review_fix", {
      project,
      fixId: "f1",
      kind: "app",
      count: 2,
      autoPublish: true,
      at,
    });

  it("keeps a taken-down game, a turned-down app and a takedown kept down waiting, one row per game", () => {
    const down = run(EMPTY_NOTICES, [review("taken_down", { things: THINGS, count: 3 })]);
    const [row] = waitingNotices(down.state.items);
    assert.equal(row?.kind, "review");
    assert.equal(noticeSource(row!, "Midnight Asphalt"), "Midnight Asphalt was taken down");
    assert.equal(row?.text, "3 things to fix");
    assert.equal(row?.project, "asphalt");
    const app = run(EMPTY_NOTICES, [
      review("not_approved", { app: { platform: "mac", arch: "arm64", version: "1.3.0" }, things: THINGS }),
    ]);
    assert.equal(waitingNotices(app.state.items)[0]?.headline, "Midnight Asphalt's Mac app wasn't approved");
    assert.equal(waitingNotices(app.state.items)[0]?.text, "2 things to fix");
    const kept = run(down.state, [review("upheld", { things: THINGS })]);
    assert.deepEqual(
      waitingNotices(kept.state.items).map((item) => item.headline),
      ["Midnight Asphalt: human review kept it down"],
      "the newer row replaces the game's older one",
    );
  });

  it("no longer waits once the person asked for a person: the newer change is news in its place", () => {
    const down = run(EMPTY_NOTICES, [review("not_approved", { count: 1 }, "skate")]);
    const asked = run(down.state, [review("with_person", { requested: true }, "skate")]);
    assert.equal(waitingNotices(asked.state.items).length, 0);
    assert.equal(activityNotices(asked.state.items)[0]?.text, "Human review, usually within a day.");
  });

  it("tells a person reviewing it, and a game live or public again, as news that settles what waited", () => {
    const down = run(EMPTY_NOTICES, [review("taken_down", { count: 3 }), review("with_person", {}, "skate")]);
    const person = activityNotices(down.state.items).find((item) => item.project === "skate");
    assert.equal(person?.headline, "Skate Dog");
    assert.equal(person?.text, "Human review, usually within a day.");
    assert.equal(person?.waiting, undefined);
    const back = run(down.state, [review("restored")]);
    assert.equal(waitingNotices(back.state.items).length, 0, "public again: nothing waits");
    const news = activityNotices(back.state.items).find((item) => item.project === "asphalt");
    assert.equal(news?.headline, "Midnight Asphalt is public again");
    assert.equal(news?.text, "Anyone can find it on Genex.");
    const live = run(EMPTY_NOTICES, [review("not_approved", { count: 1 }), review("live")]);
    assert.equal(waitingNotices(live.state.items).length, 0);
    assert.equal(activityNotices(live.state.items)[0]?.headline, "Midnight Asphalt is live!");
  });

  it("settles the waiting row when Fix with agent is pressed, and only that game's", () => {
    const both = run(EMPTY_NOTICES, [
      review("taken_down", { count: 3 }),
      review("not_approved", { count: 1 }, "skate"),
    ]);
    assert.equal(waitingNotices(both.state.items).length, 2);
    const pressed = run(both.state, [fixed()]);
    assert.deepEqual(
      waitingNotices(pressed.state.items).map((item) => item.project),
      ["skate"],
    );
  });

  it("raises nothing for a change the bell does not tell, or a record with no game", () => {
    const { state } = run(EMPTY_NOTICES, [
      review("sent"),
      review("fix_stopped"),
      review("not_built"),
      custom("t9", "genex_review", { change: "taken_down" }),
      custom("t9", "genex_review", {}),
    ]);
    assert.deepEqual(state.items, []);
  });

  it("counts on the Dock while it waits, and stops counting once settled", () => {
    const down = run(EMPTY_NOTICES, [
      review("taken_down", { count: 3 }),
      review("not_approved", { count: 1 }, "skate"),
      custom("t1", "interview_question", { question: "Night or day?" }),
    ]);
    assert.equal(waitingNotices(down.state.items).length, 3, "each waiting review row adds one");
    const settled = run(down.state, [fixed(), review("live", {}, "skate")]);
    assert.equal(waitingNotices(settled.state.items).length, 1, "only the question still waits");
  });

  it("tells macOS only while Studio is in the background, in the review's own words", () => {
    const { arrived } = run(EMPTY_NOTICES, [
      review("taken_down", { count: 3 }),
      review("restored", {}, "skate"),
      review("with_person", {}, "skate"),
    ]);
    const source = () => "fallback";
    assert.deepEqual(systemNotes(arrived, { first: false, focused: true }, source), [], "never while in front");
    assert.deepEqual(systemNotes(arrived, { first: true, focused: false }, source), [], "never on the first read");
    const notes = systemNotes(arrived, { first: false, focused: false }, source);
    assert.deepEqual(
      notes.map(({ title, body }) => [title, body]),
      [
        ["Midnight Asphalt was taken down", "3 things to fix. Click to see them and fix them with your agent."],
        ["Skate Dog is public again", "Anyone can find it on Genex."],
      ],
      "a person reviewing it stays in the bell",
    );
    assert.equal(notes[0]?.id, arrived[0]?.id, "a click opens the row");
    for (const note of notes) {
      assert.ok(note.title.length <= 120 && note.body.length <= 240);
    }
    const one = run(EMPTY_NOTICES, [review("not_approved", { count: 1, app: { platform: "windows" } })]);
    assert.equal(
      systemNotes(one.arrived, { first: false, focused: false }, source)[0]?.body,
      "1 thing to fix. Click to see it and fix it with your agent.",
    );
  });

  it("opens its game's chat with Publish, from the bell, macOS or a toast, and sends nothing", () => {
    const { state } = run(EMPTY_NOTICES, [review("taken_down", { count: 3 })]);
    const row = state.items[0]!;
    assert.deepEqual(
      noticeDestination(row, () => true),
      { to: "thread", threadId: "chat-asphalt", publish: "asphalt" },
    );
    assert.deepEqual(
      noticeDestination(row, () => false),
      { to: "nowhere" },
      "a chat that is gone goes nowhere",
    );
    assert.deepEqual(
      noticeDestination(row, () => true, true),
      { to: "thread", threadId: "chat-asphalt" },
      "after the bell's Fix, the game's chat alone, where the agent has it",
    );
    const build = run(EMPTY_NOTICES, [custom("t1", "run_finished", { runId: "r1", landed: true })]).state.items[0]!;
    assert.equal((noticeDestination(build, () => true) as { publish?: string }).publish, undefined);
  });

  it("presses Fix with agent from the bell's Fix, then opens the game, even when the press fails", async () => {
    const { state } = run(EMPTY_NOTICES, [review("taken_down", { count: 3 })]);
    const row = state.items[0]!;
    const calls: unknown[] = [];
    const went: string[] = [];
    await pressReviewFix(
      { genexFixReview: async (project, options) => calls.push([project, options]) },
      row,
      (notice) => went.push(notice.id),
      () => went.push("failed"),
    );
    assert.deepEqual(calls, [["asphalt", { autoPublish: true }]]);
    assert.deepEqual(went, [row.id]);
    const failing: string[] = [];
    await pressReviewFix(
      { genexFixReview: async () => Promise.reject(new Error("offline")) },
      row,
      () => failing.push("went"),
      () => failing.push("failed"),
    );
    assert.deepEqual(failing, ["failed", "went"]);
  });

  it("toasts a game taken down, turned down or public again only while in front and another game is open", () => {
    const { arrived } = run(EMPTY_NOTICES, [
      review("taken_down", { count: 3 }),
      review("restored", {}, "skate"),
      review("live", {}, "skate"),
    ]);
    assert.deepEqual(reviewToasts(arrived, { focused: false, openProject: null }), [], "in the background: macOS");
    assert.deepEqual(
      reviewToasts(arrived, { focused: true, openProject: "asphalt" }).map((notice) => notice.headline),
      ["Skate Dog is public again"],
      "the open game's own card already says it, and live is news for the bell",
    );
    assert.equal(reviewToasts(arrived, { focused: true, openProject: null }).length, 2);
  });
});
