/**
 * What the chat shows, derived from synthetic logs (`renderer/chat/transcript.ts`): which
 * questions stay reachable whatever page is loaded, which records the transcript leaves to other
 * surfaces, and the work rows, plan review and finishing flag the composer reads.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";
import type { RunSummary } from "../../src/shared/run-summary.ts";
import { CHAT_PAGE_SIZE, chatContext, mergeChatEvents } from "../../src/shared/chat-history.ts";
import type { ActivityItem, ConversationEntry } from "../../src/renderer/chat/conversation-entries.ts";
import {
  currentWorkItems,
  finishingRun,
  isPendingConsent,
  isPendingQuestion,
  pendingPlanReview,
  runBudgetMs,
  runLoopSetting,
  runStartedAt,
  sentImages,
  transcriptEntries,
} from "../../src/renderer/chat/transcript.ts";

const event = (n: number, data: EventData): EventEnvelope => ({
  id: String(n).padStart(6, "0"),
  thread_id: "game",
  turn_id: null,
  session_id: null,
  created_at: new Date(n).toISOString(),
  data,
});
const custom = (n: number, event_type: string, payload: unknown): EventEnvelope =>
  event(n, { type: "custom", event_type, payload } as EventData);

it("upload review retains the complete host file list rather than the clipped argument digest", () => {
  const included = Array.from({ length: 600 }, (_, index) => `assets/file-${index}.png`);
  const events = [
    custom(1, "plugin_consent", {
      consentId: "review",
      pluginId: "genex",
      pluginName: "Genex",
      tool: "genex__export_review",
      args: { files: "clipped" },
      project: "game",
      prompt: "Review upload",
      state: "pending",
      exportReview: { included, excluded: [".env.local"] },
    }),
  ];
  const list = transcriptEntries({
    events,
    threadEvents: events,
    stateEvents: [],
    queued: [],
    activeRunId: null,
    studio: false,
  });
  const consent = list.find((entry) => "consentId" in entry && entry.consentId === "review");
  assert.ok(consent && "consentExport" in consent);
  assert.deepEqual(consent.consentExport, { included, excluded: [".env.local"] });
});
const user = (n: number, content: string): EventEnvelope =>
  event(n, { type: "messages", messages: [{ role: "user", content }] } as EventData);
const consent = (n: number, consentId: string, state: "pending" | "approved" | "declined"): EventEnvelope =>
  custom(n, "plugin_consent", {
    consentId,
    pluginId: "p",
    pluginName: "Palette",
    tool: "recolor",
    args: {},
    project: "game",
    prompt: "Recolor the sky?",
    state,
  });
const question = (n: number, text: string): EventEnvelope =>
  custom(n, "interview_question", { question: text, choices: [] });

type Input = Parameters<typeof transcriptEntries>[0];
const entries = (input: Partial<Input> & { threadEvents: EventEnvelope[] }): ConversationEntry[] =>
  transcriptEntries({
    events: input.threadEvents,
    stateEvents: [],
    queued: [],
    activeRunId: null,
    studio: false,
    ...input,
  });
const questions = (list: ConversationEntry[]) =>
  list.flatMap((e) => (e.kind === "question" ? [{ text: e.text, pending: e.pending }] : []));
const consents = (list: ConversationEntry[]) =>
  list.flatMap((e) =>
    e.kind === "action" && e.action === "consent" ? [{ id: e.consentId, pending: Boolean(e.pending) }] : [],
  );
const users = (list: ConversationEntry[]) => list.flatMap((e) => (e.kind === "user" ? [e.text] : []));
const toolChips = (list: ConversationEntry[]) =>
  list.flatMap((e) =>
    e.kind === "work" ? e.items.flatMap((item) => (item.kind === "tool" ? [item.tool.chip] : [])) : [],
  );

describe("transcriptEntries: what stays reachable whatever page is loaded", () => {
  it("keeps a plugin's pending question when its page is unloaded, and drops one already answered", () => {
    const threadEvents = [user(1, "paint it")];
    const pending = entries({ threadEvents, stateEvents: [consent(2, "sky", "pending")] });
    assert.deepEqual(consents(pending), [{ id: "sky", pending: true }]);
    assert.equal(pending.filter(isPendingConsent).length, 1);
    const answered = entries({
      threadEvents,
      stateEvents: [consent(2, "sky", "pending"), consent(3, "sky", "approved")],
    });
    assert.deepEqual(consents(answered), [], "an answered question is not carried beside the page");
    const other = entries({ threadEvents, stateEvents: [consent(2, "sky", "pending"), consent(3, "sea", "declined")] });
    assert.deepEqual(consents(other), [{ id: "sky", pending: true }], "answering one question leaves another waiting");
  });

  it("keeps an unanswered intake question when its page is unloaded", () => {
    const threadEvents = [user(1, "make a game"), question(2, "Which genre?")];
    const list = entries({ threadEvents, events: [] });
    assert.deepEqual(questions(list), [{ text: "Which genre?", pending: true }]);
    assert.equal(list.filter(isPendingQuestion).length, 1);
    assert.deepEqual(users(list), [], "only the question is carried, not the unloaded page");
  });

  it("forgets the intake question once the user answers or a run starts", () => {
    for (const answer of [
      user(3, "platformer"),
      custom(3, "run_started", { runId: "r1" }),
      custom(3, "run_registered", { runId: "r1" }),
    ]) {
      const threadEvents = [user(1, "make a game"), question(2, "Which genre?"), answer];
      assert.deepEqual(
        questions(entries({ threadEvents, events: [] })),
        [],
        `${answer.data.type} ${JSON.stringify(answer.data)}`,
      );
    }
    const askedAgain = [
      user(1, "make a game"),
      question(2, "Which genre?"),
      user(3, "platformer"),
      question(4, "How long?"),
    ];
    assert.deepEqual(questions(entries({ threadEvents: askedAgain, events: [] })), [
      { text: "How long?", pending: true },
    ]);
  });

  it("keeps a running job's line and Stop when its start is older than the loaded page", () => {
    const job = (n: number, event_type: string, jobId: string, extra: Record<string, unknown> = {}) =>
      custom(n, event_type, {
        jobId,
        project: "game",
        title: `Build ${jobId}`,
        startedAt: "2026-01-01T12:00:00.000Z",
        ...extra,
      });
    const replies = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) =>
        event(from + index, {
          type: "messages",
          messages: [{ role: "assistant", content: `step ${index}` }],
        } as EventData),
      );
    const log = [
      job(1, "job_started", "a"),
      job(2, "job_started", "b"),
      job(3, "job_started", "c"),
      job(4, "job_ended", "c", { state: "succeeded", durationMs: 60_000 }),
      ...replies(5, CHAT_PAGE_SIZE + 40),
      job(500, "job_ended", "b", { state: "failed", durationMs: 240_000 }),
    ];
    const page = log.slice(-CHAT_PAGE_SIZE);
    const threadEvents = mergeChatEvents(chatContext([], log), page);
    const jobs = entries({ threadEvents, events: page, stateEvents: threadEvents }).flatMap((e) =>
      e.kind === "action" && e.action === "job" ? [[e.text, e.job?.jobId]] : [],
    );
    assert.deepEqual(jobs, [
      ["In the background: Build a", "a"],
      ["In the background: Build b · failed · 4 min", undefined],
    ]);
  });

  it("shows only the loaded page, and counts a queued message's event as loaded", () => {
    const threadEvents = [user(1, "first"), user(2, "second"), user(3, "queued follow-up")];
    const page = [threadEvents[1]!];
    assert.deepEqual(users(entries({ threadEvents, events: page })), ["second"]);
    assert.deepEqual(
      users(entries({ threadEvents, events: page, queued: [{ messageId: "m", eventId: "000003", state: "queued" }] })),
      ["second", "queued follow-up"],
    );
    assert.deepEqual(
      users(entries({ threadEvents, events: page, queued: [{ messageId: "m", eventId: "000003", state: "handled" }] })),
      ["second"],
      "only a message still in the queue",
    );
    assert.deepEqual(
      users(entries({ threadEvents, events: page, queued: [{ messageId: "m", eventId: null, state: "queued" }] })),
      ["second"],
    );
  });
});

describe("transcriptEntries: records the chat leaves to other surfaces", () => {
  const traces = (runId: string, facetId?: string) => [
    user(1, "build it"),
    custom(2, "run_started", { runId: "r1" }),
    custom(3, "plugin_tool", {
      runId,
      ...(facetId ? { facetId } : {}),
      pluginId: "p",
      tool: "recolor",
      callId: "c1",
      ok: true,
    }),
    custom(4, "delegated.codex", {
      runId,
      ...(facetId ? { facetId } : {}),
      delegationId: "d",
      kind: "assistant",
      data: { parts: [{ type: "tool_use", id: "t1", name: "Bash", input: "npm test" }] },
    }),
  ];

  it("hides the active run's worker and plugin traces that name a part", () => {
    const hidden = entries({ threadEvents: traces("r1", "bridge"), activeRunId: "r1" });
    assert.deepEqual(toolChips(hidden), [], "the running build's task rows show them");
  });

  it("shows them for a finished run, another run, or a trace without a part", () => {
    const expected = toolChips(entries({ threadEvents: traces("r1", "bridge"), activeRunId: null }));
    assert.equal(expected.length, 2, "a plugin row and a worker row");
    assert.deepEqual(toolChips(entries({ threadEvents: traces("r0", "bridge"), activeRunId: "r1" })), expected);
    assert.deepEqual(toolChips(entries({ threadEvents: traces("r1"), activeRunId: "r1" })), expected);
  });

  it("hides Studio's own records in the Studio chat only", () => {
    const threadEvents = [
      user(1, "hello"),
      custom(2, "seed_upgraded", { added: ["a.mjs"], updated: [], retired: [], kept: [] }),
      event(3, { type: "workspace_restored", reason: "undo", snapshot_id: "s1" } as EventData),
    ];
    const kinds = (list: ConversationEntry[]) => list.map((e) => e.kind);
    assert.deepEqual(
      kinds(entries({ threadEvents, studio: false })),
      ["user", "work", "notice"],
      "a game chat shows the update and the restore",
    );
    assert.deepEqual(
      kinds(entries({ threadEvents, studio: true })),
      ["user"],
      "Activity beside the Studio chat shows them",
    );
  });
});

describe("pendingPlanReview", () => {
  const review = (n: number, id: string, extra: Record<string, unknown> = {}) =>
    custom(n, "plan_review", { id, state: "awaiting", text: `plan ${id}`, ...extra });

  it("answers the newest plan review when the composer can answer it", () => {
    assert.equal(pendingPlanReview([]), null);
    assert.equal(pendingPlanReview([review(1, "a"), user(2, "ok"), review(3, "b")])?.id, "b");
  });

  it("answers nothing when the newest one is incomplete, even if an older one was whole", () => {
    assert.equal(pendingPlanReview([review(1, "a"), custom(2, "plan_review", { id: "b", state: "awaiting" })]), null);
  });
});

describe("currentWorkItems", () => {
  const started = (n: number, runId: string, facetId: string, callId: string) =>
    custom(n, "plugin_tool_started", { runId, facetId, pluginId: "p", tool: `tool-${callId}`, callId });
  const outcome = (tasks: Array<{ id: string; state: string }>) => ({ tasks }) as unknown as RunSummary;
  const trailing: ActivityItem[] = [{ kind: "note", id: "n", text: "the chat's own work" }];
  const ids = (items: ActivityItem[]) => items.map((item) => item.id);

  it("lists the active run's rows for the parts running now, then the chat's own work", () => {
    const log = [
      started(1, "r1", "bridge", "c1"),
      started(2, "r1", "lights", "c2"),
      started(3, "r0", "bridge", "c3"),
      custom(4, "plugin_tool_started", { runId: "r1", pluginId: "p", tool: "x", callId: "c4" }),
    ];
    const running = outcome([
      { id: "bridge", state: "running" },
      { id: "lights", state: "passed" },
    ]);
    assert.deepEqual(ids(currentWorkItems(log, running, "r1", trailing)), ["c1", "n"]);
  });

  it("lists only the chat's own work without a summary or an active run", () => {
    const log = [started(1, "r1", "bridge", "c1")];
    assert.deepEqual(ids(currentWorkItems(log, null, "r1", trailing)), ["n"]);
    assert.deepEqual(ids(currentWorkItems(log, outcome([{ id: "bridge", state: "running" }]), null, trailing)), ["n"]);
  });
});

describe("finishingRun", () => {
  const control = (n: number, runId: string, action: string) => custom(n, "run_control", { runId, action });

  it("is true once the chat asked this running build to finish", () => {
    assert.equal(finishingRun([control(1, "r1", "finish")], "r1"), true);
  });

  it("is false for another build, another control, or no build", () => {
    assert.equal(finishingRun([control(1, "r0", "finish")], "r1"), false);
    assert.equal(finishingRun([control(1, "r1", "steer")], "r1"), false);
    assert.equal(finishingRun([control(1, "r1", "finish")], null), false);
  });

  it("is false once the build resumed after the wrap-up was asked", () => {
    const resumed = custom(2, "run_registered", { runId: "r1", resumed: true });
    assert.equal(finishingRun([control(1, "r1", "finish"), resumed], "r1"), false);
    assert.equal(finishingRun([control(1, "r1", "finish"), resumed, control(3, "r1", "finish")], "r1"), true);
  });
});

describe("sentImages: the pictures a message was sent with", () => {
  it("keys each message that saved attachments by its user entry, with the count the log kept", () => {
    const byEntry = sentImages([
      {
        messageId: "m1",
        eventId: "000001",
        state: "handled",
        action: { text: "look", attachmentsArtifact: "message_attachments_m1", imageCount: 2 },
      },
      {
        messageId: "m2",
        eventId: "000002",
        state: "queued",
        action: { text: "older log", attachmentsArtifact: "message_attachments_m2" },
      },
      { messageId: "m3", eventId: "000003", state: "queued", action: { text: "no pictures" } },
      { messageId: "m4", eventId: null, state: "queued", action: { attachmentsArtifact: "message_attachments_m4" } },
    ]);
    assert.deepEqual(
      [...byEntry],
      [
        ["000001-0:user", { messageId: "m1", count: 2 }],
        ["000002-0:user", { messageId: "m2" }],
      ],
    );
  });
});

describe("runStartedAt: how long the build row says the build has run", () => {
  const log = [
    custom(1000, "run_started", { runId: "r1" }),
    custom(5000, "run_started", { runId: "r2" }),
    custom(9000, "autopilot_paused", { runId: "r1" }),
  ];

  it("reads the recorded summary's working time first, else the run's own start record", () => {
    assert.equal(runStartedAt(log, "r1", { ms: 200, since: "1970-01-01T00:00:00.700Z" }), 500);
    assert.equal(runStartedAt(log, "r2", undefined), 5000);
    assert.equal(runStartedAt(log, "r2", { ms: 0, since: null }), 5000, "a summary from before a resume");
    assert.equal(runStartedAt(log, "r1", null), undefined, "a paused build has no running clock");
  });

  it("knows nothing without a run or a start", () => {
    assert.equal(runStartedAt(log, null, null), undefined);
    assert.equal(runStartedAt(log, "gone", null), undefined);
  });

  it("counts a finished build reopened from the reopen, and a resumed pause from the time it worked", () => {
    const reopened = [
      custom(1000, "run_started", { runId: "r1" }),
      custom(2000, "run_finished", { runId: "r1" }),
      custom(7000, "run_registered", { runId: "r1", resumed: true }),
    ];
    assert.equal(runStartedAt(reopened, "r1", null), 7000);
    const resumed = [
      custom(1000, "run_started", { runId: "r1" }),
      custom(2000, "run_finished", { runId: "r1", executionStatus: "paused" }),
      custom(7000, "run_registered", { runId: "r1", resumed: true }),
    ];
    assert.equal(runStartedAt(resumed, "r1", null), 6000, "a second of work before the pause");
  });

  it("ends work before a restart at the run's last record, not when the next launch closed it", () => {
    const restarted = [
      custom(1000, "run_started", { runId: "r1" }),
      custom(3000, "autopilot_decision", { runId: "r1" }),
      custom(50_000, "run_finished", { runId: "r1" }),
      custom(50_001, "autopilot_paused", { runId: "r1" }),
      custom(60_000, "run_registered", { runId: "r1", resumed: true }),
    ];
    assert.equal(runStartedAt(restarted, "r1", null), 58_000);
  });
});

describe("runBudgetMs: the time a build was given", () => {
  const started = (n: number, runId: string, budgets?: unknown) =>
    custom(n, "run_started", { runId, ...(budgets === undefined ? {} : { budgets }) });

  it("reads the start record's wall-clock budget", () => {
    assert.equal(runBudgetMs([started(1, "r1", { wallClockMs: 1_800_000 })], "r1"), 1_800_000);
  });

  it("lets a later record with a budget win, and keeps it through a later start without one", () => {
    const registered = custom(2, "run_registered", { runId: "r1", budgets: { wallClockMs: 3_600_000 } });
    assert.equal(runBudgetMs([started(1, "r1", { wallClockMs: 1_800_000 }), registered], "r1"), 3_600_000);
    const resumed = [started(1, "r1", { wallClockMs: 1_800_000 }), started(2, "r1")];
    assert.equal(runBudgetMs(resumed, "r1"), 1_800_000, "a resumed start without budgets keeps the earlier one");
  });

  it("ignores another run's records", () => {
    assert.equal(runBudgetMs([started(1, "r2", { wallClockMs: 1_800_000 })], "r1"), null);
  });

  it("knows nothing without a usable budget or a run", () => {
    for (const budgets of [undefined, {}, { wallClockMs: 0 }, { wallClockMs: "30" }]) {
      assert.equal(runBudgetMs([started(1, "r1", budgets)], "r1"), null, JSON.stringify(budgets));
    }
    assert.equal(runBudgetMs([started(1, "r1", { wallClockMs: 1_800_000 })], null), null);
  });

  it("gives an ∞ build no budget, so its row shows the elapsed clock rather than its 24 h ceiling", () => {
    const unbounded = [started(1, "r1", { wallClockMs: 86_400_000, untilSatisfied: true })];
    assert.equal(runBudgetMs(unbounded, "r1"), null);
  });
});

describe("runLoopSetting: the Loop a build was given, as Mode shows it", () => {
  const record = (n: number, event_type: string, budgets?: unknown) =>
    custom(n, event_type, { runId: "r1", ...(budgets === undefined ? {} : { budgets }) });

  it("reads ∞ as until satisfied, and a timed build as its hours", () => {
    const unbounded = [record(1, "run_registered", { wallClockMs: 86_400_000, untilSatisfied: true })];
    assert.deepEqual(runLoopSetting(unbounded, "r1"), { on: true, hours: null });
    assert.deepEqual(runLoopSetting([record(1, "run_started", { wallClockMs: 1_800_000 })], "r1"), {
      on: true,
      hours: 0.5,
    });
  });

  it("reads a build recorded before ∞ was kept as its 24 h", () => {
    assert.deepEqual(runLoopSetting([record(1, "run_started", { wallClockMs: 86_400_000 })], "r1"), {
      on: true,
      hours: 24,
    });
  });

  it("keeps a resumed build's budgets through a later start that carries none", () => {
    const resumed = [
      record(1, "run_registered", { wallClockMs: 1_800_000 }),
      record(2, "autopilot_paused"),
      record(3, "run_started"),
    ];
    assert.deepEqual(runLoopSetting(resumed, "r1"), { on: true, hours: 0.5 });
  });

  it("knows nothing without a start record that kept one, or without a run", () => {
    assert.equal(runLoopSetting([record(1, "run_started")], "r1"), null);
    assert.equal(runLoopSetting([], "r1"), null);
    assert.equal(runLoopSetting([record(1, "run_started", { wallClockMs: 1_800_000 })], null), null);
  });
});

it("a Codex sign-in failure never narrates a Claude failure", () => {
  const rows = entries({ threadEvents: [custom(1, "needs_signin", { engine: "codex", message: "401" })] });
  const text = JSON.stringify(rows);
  assert.ok(text.includes("Codex"));
  assert.ok(!text.includes("Claude Code"));
});

it("a sign-in failure and its adjacent harness reply render one notice", () => {
  const reply = event(2, { type: "messages", messages: [{ role: "assistant", content: "Codex needs a sign-in." }] });
  const rows = entries({ threadEvents: [custom(1, "needs_signin", { engine: "codex", message: "401" }), reply] });
  const rendered = rows.flatMap((row) => ("text" in row ? [row.text] : []));
  assert.equal(rendered.filter((text) => /Codex/.test(String(text))).length, 1);
});
