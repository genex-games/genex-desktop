import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  activityNotices,
  applyEvents,
  clearActivity,
  dayGroup,
  EMPTY_NOTICES,
  markRead,
  noticeSource,
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
