import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventStore } from "../../src/substrate/event-store.ts";
import { chatContext } from "../../src/shared/chat-history.ts";
import { measuredContext } from "../../src/shared/context.ts";
import {
  REWOUND_EVENT,
  harnessView,
  planRewind,
  rewindableMessages,
  rewindsOf,
  withdrawnId,
  withoutRewound,
} from "../../src/shared/chat-rewind.ts";
import { latestRun } from "../../src/shared/coordinator.ts";
import { seedRewindChat } from "../../src/main/dev/fixture-chat.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { applyEvents } from "../../src/renderer/notifications.ts";
import { EntryAction, EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import {
  REWIND_WORDS,
  restoresByDefault,
  rewindBusyLabel,
  rewindFilesWords,
} from "../../src/renderer/chat/rewind-words.ts";
import type { RewindFiles } from "../../src/shared/chat-rewind.ts";
import { lastContractorSession } from "../../src/harness-seed/loop/chat-session.ts";
import { messageQueueState } from "../../src/shared/message-queue.ts";
import type { EventData, EventEnvelope } from "../../src/substrate/types.ts";

const event = (id: number, data: EventData): EventEnvelope => ({
  id: String(id).padStart(6, "0"),
  thread_id: "game",
  turn_id: null,
  session_id: null,
  created_at: new Date(id).toISOString(),
  data,
});
const custom = (id: number, event_type: string, payload: unknown) => event(id, { type: "custom", event_type, payload });
/** A row between two numbered ones: ids compare as strings, so '000011a' sorts after '000011'. */
const between = (id: string, event_type: string, payload: unknown): EventEnvelope => ({
  ...custom(0, event_type, payload),
  id,
});
const user = (id: number, content: string) => event(id, { type: "messages", messages: [{ role: "user", content }] });
/** A turn's start or end, carrying its turn id as the store writes it. */
const turnRow = (id: number, type: "turn_started" | "turn_ended", turn: string): EventEnvelope => ({
  ...event(id, type === "turn_ended" ? { type, status: "ok" } : { type }),
  turn_id: turn,
});
const reply = (id: number, content: string) =>
  event(id, { type: "messages", messages: [{ role: "assistant", content }] });
const ids = (events: readonly EventEnvelope[]) => events.map((e) => Number(e.id));

/** Two answered messages, the second with its own session bookmark. */
function conversation(): EventEnvelope[] {
  return [
    user(1, "Make a platformer"),
    custom(2, "coordinator_message_queued", { messageId: "a", action: { text: "Make a platformer" } }),
    custom(3, "coordinator_message_processing", { messageId: "a" }),
    event(4, { type: "turn_started" }),
    custom(5, "contractor_session", { engine: "claude-code", sessionId: "ses-1", project: "p" }),
    reply(6, "Built it."),
    event(7, { type: "turn_ended", status: "ok" }),
    custom(8, "coordinator_message_handled", { messageId: "a" }),
    user(9, "Add a boss"),
    custom(10, "coordinator_message_queued", {
      messageId: "b",
      action: { text: "Add a boss", imageCount: 2, attachmentsArtifact: "message_attachments_b" },
    }),
    custom(11, "coordinator_message_processing", { messageId: "b" }),
    event(12, { type: "turn_started" }),
    custom(13, "contractor_session", { engine: "claude-code", sessionId: "ses-1", project: "p" }),
    reply(14, "The boss is in."),
    event(15, { type: "turn_ended", status: "ok" }),
    custom(16, "coordinator_message_handled", { messageId: "b" }),
  ];
}

test("rewinding to a message withdraws it and everything after it, keeping earlier turns intact", () => {
  const events = conversation();
  const planned = planRewind(events, [], "b");
  assert.ok(planned.ok);
  assert.deepEqual(
    { ...planned.rewind, hide: planned.rewind.hide.map(Number) },
    { messageId: "b", from: "000011", through: "000016", hide: [9, 10] },
  );
  assert.equal(planned.text, "Add a boss");
  assert.equal(planned.imageCount, 2);
  const visible = withoutRewound(events, [planned.rewind]);
  assert.deepEqual(ids(visible), [1, 2, 3, 4, 5, 6, 7, 8]);
  // Bookkeeping and the marker itself are never withdrawn.
  const marker = custom(20, REWOUND_EVENT, planned.rewind);
  const updated = event(19, { type: "thread_updated", metadata: { rewinds: [planned.rewind] } });
  assert.deepEqual(
    ids(withoutRewound([...events, updated, marker], [{ ...planned.rewind, through: "000020" }])).slice(-2),
    [19, 20],
  );
});

test("a rewind keeps the edited text, reaches back only for input sent after the message, and starts at its first processing", () => {
  const events = [
    user(1, "First"),
    custom(2, "coordinator_message_queued", { messageId: "a", action: { text: "First" } }),
    custom(3, "coordinator_message_processing", { messageId: "a" }),
    // Queued while the first answer ran, edited, answered after a restart requeued it.
    user(4, "Second"),
    custom(5, "coordinator_message_queued", { messageId: "b", action: { text: "Second" } }),
    custom(6, "coordinator_message_updated", { messageId: "b", text: "Second, revised" }),
    user(7, "Third"),
    custom(8, "coordinator_message_queued", { messageId: "c", action: { text: "Third" } }),
    reply(9, "First answered."),
    custom(10, "coordinator_message_handled", { messageId: "a" }),
    custom(11, "coordinator_message_processing", { messageId: "b" }),
    custom(12, "coordinator_message_requeued", { messageId: "b" }),
    custom(13, "coordinator_message_processing", { messageId: "b" }),
    reply(14, "Second answered."),
    custom(15, "coordinator_message_handled", { messageId: "b" }),
    custom(16, "coordinator_message_processing", { messageId: "c" }),
    reply(17, "Third answered."),
    custom(18, "coordinator_message_handled", { messageId: "c" }),
  ];
  const planned = planRewind(events, [], "b");
  assert.ok(planned.ok);
  assert.equal(planned.rewind.from, "000011", "an answer interrupted by a restart belongs to the message too");
  assert.deepEqual(planned.answered, ["b", "c"]);
  assert.equal(planned.text, "Second, revised");
  // b's own rows and c's (sent after b) leave; the first answer, delivered after b was typed, stays.
  assert.deepEqual(ids(withoutRewound(events, [planned.rewind])), [1, 2, 3, 9, 10]);
});

test("a rewind crosses a build: the build's rows leave with the message, an earlier build's close stays", () => {
  const events = conversation();
  // Flipped: a build started after the message used to refuse the rewind (`across-build`).
  const built = [...events.slice(0, 11), between("000011a", "run_started", { runId: "r1" }), ...events.slice(11)];
  const planned = planRewind(built, [], "b");
  assert.ok(planned.ok);
  assert.deepEqual(planned.builds, [{ runId: "r1", landed: false }]);
  assert.equal(planned.rewind.keep, undefined, "nothing in the range began before it");
  assert.equal(latestRun(withoutRewound(built, [planned.rewind])), null, "the build is no longer the chat's");
  // A build started before the message and closed after it (a rewind's Stop, or a landing): its
  // close stays, or it would read as running for good.
  const earlier = [
    ...events.slice(0, 8),
    between("000008a", "run_started", { runId: "r0" }),
    ...events.slice(8, 13),
    between("000013a", "run_finished", { runId: "r0", landed: true }),
    between("000013b", "run_started", { runId: "r2" }),
    between("000013c", "run_finished", { runId: "r2" }),
    ...events.slice(13),
  ];
  const across = planRewind(earlier, [], "b");
  assert.ok(across.ok);
  assert.deepEqual(across.rewind.keep, ["000013a"]);
  assert.deepEqual(across.builds, [
    { runId: "r0", landed: true },
    { runId: "r2", landed: false },
  ]);
  const run = latestRun(withoutRewound(earlier, [across.rewind]));
  assert.equal(run?.runId, "r0");
  assert.equal(run?.state, "finished");
});

test("a rewind keeps a job's end whose start stays, and the start of a job still running", () => {
  const events = conversation();
  const job = (jobId: string, title: string) => ({ jobId, project: "p", title, startedAt: "2026-01-01T12:00:00.000Z" });
  const end = (jobId: string, title: string) => ({ ...job(jobId, title), state: "succeeded", durationMs: 240_000 });
  const withJobs = [
    ...events.slice(0, 8),
    between("000008a", "job_started", job("j-before", "Unreal build")),
    ...events.slice(8, 13),
    between("000013a", "job_ended", end("j-before", "Unreal build")),
    between("000013b", "job_started", job("j-running", "Asset bake")),
    between("000013c", "job_started", job("j-done", "Shader compile")),
    between("000013d", "job_ended", end("j-done", "Shader compile")),
    ...events.slice(13),
  ];
  const planned = planRewind(withJobs, [], "b");
  assert.ok(planned.ok);
  assert.deepEqual(planned.rewind.keep, ["000013a", "000013b"]);
  const lines = toEntries(withoutRewound(withJobs, [planned.rewind])).flatMap((entry) =>
    entry.kind === EntryKind.Action && entry.action === EntryAction.Job ? [[entry.text, entry.job?.jobId]] : [],
  );
  assert.deepEqual(lines, [
    ["In the background: Unreal build · finished · 4 min", undefined],
    ["In the background: Asset bake", "j-running"],
  ]);
});

test("a rewind is refused while a message is being answered or handed in, for waiting input, and once gone", () => {
  const events = conversation();
  assert.deepEqual(planRewind(events.slice(0, 13), [], "b"), { ok: false, reason: "busy" });
  assert.deepEqual(
    planRewind(
      [
        ...events,
        user(17, "And a moat"),
        custom(18, "coordinator_message_queued", { messageId: "c" }),
        custom(19, "coordinator_message_steering", { messageId: "c", into: "b" }),
      ],
      [],
      "a",
    ),
    { ok: false, reason: "busy" },
    "not while a message is being handed to the turn answering",
  );
  assert.deepEqual(planRewind(events.slice(0, 10), [], "b"), { ok: false, reason: "not-answered" });
  assert.deepEqual(planRewind(events, [], "missing"), { ok: false, reason: "not-found" });
  const removed = [...events.slice(0, 10), custom(11, "coordinator_message_removed", { messageId: "b" })];
  assert.deepEqual(planRewind(removed, [], "b"), { ok: false, reason: "not-found" });
  // Twice to the same message: the second finds it gone.
  const first = planRewind(events, [], "b");
  assert.ok(first.ok);
  assert.deepEqual(planRewind(events, [first.rewind], "b"), { ok: false, reason: "not-found" });
});

test("a bubble with no queue record is rewound by its own id; its bubble id finds a queued message too", () => {
  const events = [
    user(1, "Make a platformer"),
    reply(2, "Built it."),
    user(3, "Add a boss"),
    reply(4, "The boss is in."),
    ...conversation()
      .slice(8)
      .map((e) => ({ ...e, id: String(Number(e.id) + 10).padStart(6, "0") })),
  ];
  const planned = planRewind(events, [], "000003");
  assert.ok(planned.ok);
  assert.deepEqual(
    { messageId: planned.rewind.messageId, from: planned.rewind.from, text: planned.text },
    { messageId: "000003", from: "000003", text: "Add a boss" },
  );
  assert.deepEqual(ids(withoutRewound(events, [planned.rewind])), [1, 2]);
  assert.deepEqual(planRewind(events, [], "000002"), { ok: false, reason: "not-found" }, "a reply is no bubble");
  const byBubble = planRewind(events, [], "000019");
  assert.ok(byBubble.ok);
  assert.equal(byBubble.rewind.messageId, "b", "the queued message its bubble carries");
});

test("a withdrawn range keeps the rows it names in keep", () => {
  const rewind = { messageId: "b", from: "000010", through: "000020", hide: ["000003"], keep: ["000015"] };
  assert.deepEqual(
    ["000003", "000009", "000010", "000015", "000020", "000021"].map((id) => withdrawnId(id, [rewind])),
    [true, false, true, false, true, false],
  );
  assert.equal(rewindsOf([custom(21, REWOUND_EVENT, rewind)])[0]?.keep?.[0], "000015", "the marker carries it");
  const { keep: _keep, ...older } = rewind;
  assert.equal(withdrawnId("000015", [older]), true, "a rewind from before keep withdraws its whole range");
});

test("a question asked before the message keeps its answer; one asked after it leaves whole", () => {
  const ask = (id: string, requestId: string, state: string) =>
    between(id, "tool_permission", { requestId, project: "p", threadId: "game", tool: "Bash", state });
  const events = conversation();
  const asked = [
    ...events.slice(0, 10),
    ask("000010a", "early", "pending"),
    ...events.slice(10, 13),
    ask("000013a", "late", "pending"),
    ask("000013b", "early", "denied"),
    ask("000013c", "late", "allowed"),
    ...events.slice(13),
  ];
  const planned = planRewind(asked, [], "b");
  assert.ok(planned.ok);
  assert.deepEqual(planned.rewind.keep, ["000013b"]);
  const answers = withoutRewound(asked, [planned.rewind]).flatMap((e) =>
    e.data.type === "custom" && e.data.event_type === "tool_permission" ? [e.data.payload] : [],
  );
  assert.deepEqual(
    answers.map((p) => [(p as { requestId: string }).requestId, (p as { state: string }).state]),
    [
      ["early", "pending"],
      ["early", "denied"],
    ],
    "the early card stays answered, and the late one leaves with the message",
  );
});

test("the harness forgets every session recorded before a rewind, so the next turn starts fresh", () => {
  const events = conversation();
  const planned = planRewind(events, [], "b");
  assert.ok(planned.ok);
  assert.equal(
    lastContractorSession(withoutRewound(events, [planned.rewind]), "claude-code")?.sessionId,
    "ses-1",
    "hiding rows alone would still resume the session",
  );
  const init = between("000005a", "delegated.claude-code", {
    kind: "system",
    data: { subtype: "init", session_id: "ses-1" },
  });
  const view = harnessView(
    [...events, init].sort((x, y) => x.id.localeCompare(y.id)),
    [planned.rewind],
  );
  assert.equal(lastContractorSession(view, "claude-code"), null);
  assert.deepEqual(ids(view.filter((e) => e.data.type === "messages")), [1, 6]);
  // A session recorded after the rewind is resumed as usual.
  const later = custom(30, "contractor_session", { engine: "claude-code", sessionId: "ses-2", project: "p" });
  assert.equal(
    lastContractorSession(harnessView([...events, later], [planned.rewind]), "claude-code")?.sessionId,
    "ses-2",
  );
  // The queue restored after a restart does not see the withdrawn message.
  assert.equal(messageQueueState(view).messages.has("b"), false);
});

test("a compaction forgets every session recorded before it, as a rewind does", () => {
  const init = custom(19, "delegated.claude-code", { kind: "system", data: { subtype: "init", session_id: "ses-1" } });
  const compacted = custom(20, "compacted", {
    engine: "claude-code",
    summary: "where the chat stands",
    upTo: "0000019",
  });
  const view = harnessView([...conversation(), init, compacted], []);
  assert.equal(lastContractorSession(view, "claude-code"), null, "the compacted session is not resumed");
  assert.ok(
    view.some((e) => e.data.type === "custom" && e.data.event_type === "compacted"),
    "the compaction itself stays",
  );
  const later = custom(30, "contractor_session", { engine: "claude-code", sessionId: "ses-2", project: "p" });
  assert.equal(
    lastContractorSession(harnessView([...conversation(), compacted, later], []), "claude-code")?.sessionId,
    "ses-2",
    "a session opened after the compaction is resumed as usual",
  );
});

test("a provider's own compaction keeps the session it compacted: the next turn resumes it", () => {
  const init = custom(19, "delegated.claude-code", { kind: "system", data: { subtype: "init", session_id: "ses-1" } });
  const native = custom(20, "compacted", {
    engine: "claude-code",
    summary: "where the chat stands",
    native: true,
    sessionId: "ses-1",
  });
  const view = harnessView([...conversation(), init, native], []);
  assert.equal(lastContractorSession(view, "claude-code")?.sessionId, "ses-1", "the compacted session goes on");
  const earlier = custom(18, "compacted", { engine: "claude-code", summary: "older", upTo: "0000007" });
  assert.equal(
    lastContractorSession(harnessView([...conversation(), earlier, init, native], []), "claude-code")?.sessionId,
    "ses-1",
    "a handover before it still ends only the sessions before the handover",
  );
});

test("a run's mirrored session never becomes the chat's session, rewound or not", () => {
  const directorInit = custom(20, "delegated.claude-code", {
    kind: "system",
    runId: "run_1",
    role: "planner",
    data: { subtype: "init", session_id: "director-1" },
  });
  const view = harnessView([...conversation(), directorInit], []);
  assert.equal(lastContractorSession(view, "claude-code")?.sessionId, "ses-1", "the director works elsewhere");
  // A chat from before the bookmark existed still finds its own session from its init.
  const legacyInit = custom(20, "delegated.claude-code", {
    kind: "system",
    data: { subtype: "init", session_id: "legacy-1" },
  });
  const unbookmarked = conversation().filter(
    (event) => !(event.data.type === "custom" && event.data.event_type === "contractor_session"),
  );
  assert.equal(
    lastContractorSession(harnessView([...unbookmarked, legacyInit], []), "claude-code")?.sessionId,
    "legacy-1",
  );
  // Flipped: a later init no longer outranks the chat's bookmark — it may be a
  // coordinator's, worker's or reviewer's session in this thread.
  assert.equal(
    lastContractorSession(harnessView([...conversation(), legacyInit], []), "claude-code")?.sessionId,
    "ses-1",
  );
});

test("the chat offers Rewind on every answered, delivered and queue-less bubble, builds or not", () => {
  const events = conversation();
  assert.deepEqual(
    [...rewindableMessages(events)],
    [
      ["000001", "a"],
      ["000009", "b"],
    ],
  );
  // Flipped: a bubble before the latest build used to lose Rewind.
  const built = [...events.slice(0, 8), between("000008a", "run_finished", { runId: "r1" }), ...events.slice(8)];
  assert.deepEqual(
    [...rewindableMessages(built)],
    [
      ["000001", "a"],
      ["000009", "b"],
    ],
  );
  assert.deepEqual(
    [...rewindableMessages(events.slice(0, 13))],
    [["000001", "a"]],
    "a message being answered is not offered",
  );
  const waiting = [...events, user(17, "Then a moat"), custom(18, "coordinator_message_queued", { messageId: "c" })];
  assert.deepEqual([...rewindableMessages(waiting)].at(-1), ["000009", "b"], "a waiting message is not offered");
  const older = [user(0, "Before the queue"), { ...reply(0, "Answered."), id: "000000a" }, ...events];
  assert.deepEqual([...rewindableMessages(older)][0], ["000000", "000000"], "a bubble without a queue record");
});

test("rewinds come from markers and the thread index, and survive in the current-state facts", () => {
  const events = conversation();
  const planned = planRewind(events, [], "b");
  assert.ok(planned.ok);
  const marker = custom(17, REWOUND_EVENT, { ...planned.rewind, files: 2 });
  assert.equal(rewindsOf([marker]).length, 1);
  assert.equal(rewindsOf([marker], { rewinds: [planned.rewind] }).length, 1, "the same rewind counts once");
  const facts = chatContext(chatContext([], events), [marker, user(18, "Add a boss, but smaller")]);
  assert.ok(
    facts.some((e) => e.id === marker.id),
    "the marker stays a permanent fact",
  );
  // The context meter restarts: the next turn is a fresh session.
  const usage = between("000012a", "context_usage", {
    engine: "claude-code",
    model: "m",
    promptTokens: 900,
    contextWindow: 1000,
  });
  assert.ok(measuredContext([usage], "claude-code", "m"));
  assert.equal(measuredContext([usage, marker], "claude-code", "m"), null);
});

test("the stored current-state facts are rebuilt without withdrawn rows when a chat is rewound", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-rewind-state-"));
  try {
    const store = await EventStore.open(root);
    const thread = await store.createThread({ metadata: { kind: "game", project: "p" } });
    const write = async (data: EventData[]) => (await store.appendEvents(thread, data)).events;
    await write([
      { type: "messages", messages: [{ role: "user", content: "Make it" }] },
      {
        type: "custom",
        event_type: "coordinator_message_queued",
        payload: { messageId: "a", action: { text: "Make it" } },
      },
    ]);
    await write([
      { type: "custom", event_type: "coordinator_message_processing", payload: { messageId: "a" } },
      { type: "custom", event_type: "coordinator_message_handled", payload: { messageId: "a" } },
    ]);
    await write([
      { type: "messages", messages: [{ role: "user", content: "Plan it" }] },
      {
        type: "custom",
        event_type: "coordinator_message_queued",
        payload: { messageId: "b", action: { text: "Plan it" } },
      },
    ]);
    await write([
      { type: "custom", event_type: "coordinator_message_processing", payload: { messageId: "b" } },
      { type: "custom", event_type: "interview_question", payload: { question: "How big?" } },
      { type: "custom", event_type: "coordinator_message_handled", payload: { messageId: "b" } },
    ]);
    assert.ok(
      (await store.chatState(thread)).some(
        (e) => e.data.type === "custom" && e.data.event_type === "interview_question",
      ),
    );
    const planned = planRewind(await store.listEvents(thread), [], "b");
    assert.ok(planned.ok);
    await store.updateThread(thread, { metadata: { rewinds: [planned.rewind] } });
    await write([{ type: "custom", event_type: REWOUND_EVENT, payload: planned.rewind }]);
    const state = await store.chatState(thread);
    assert.equal(
      state.some((e) => e.data.type === "custom" && e.data.event_type === "interview_question"),
      false,
      "a withdrawn question is no longer pending",
    );
    assert.ok(state.some((e) => e.data.type === "custom" && e.data.event_type === REWOUND_EVENT));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a rewind settles what the chat was waiting on in notifications", () => {
  const question = { ...custom(5, "interview_question", { question: "How big?" }) };
  let { state } = applyEvents({ floor: null, items: [] }, [question]);
  assert.equal(state.items.filter((item) => item.waiting).length, 1);
  ({ state } = applyEvents(state, [
    custom(6, REWOUND_EVENT, { messageId: "b", from: "000004", through: "000005", hide: [] }),
  ]));
  assert.equal(state.items.filter((item) => item.waiting).length, 0);
});

test("a plan review reaching into what leaves goes whole, and an approved plan gives back only the request", () => {
  const approved = "Make a racing game\n\nUser-approved implementation plan:\n1. Track\n\nProceed with this plan.";
  const events = [
    custom(1, "plan_review", { id: "r1", state: "waiting", text: "Make a racing game", plan: "1. Track" }),
    custom(2, "plan_review", { id: "r1", state: "starting", text: "Make a racing game" }),
    user(3, approved),
    custom(4, "coordinator_message_queued", { messageId: "a", action: { text: approved } }),
    custom(5, "coordinator_message_processing", { messageId: "a" }),
    custom(6, "plan_review", { id: "r1", state: "approved", text: "Make a racing game" }),
    reply(7, "Building the track."),
    custom(8, "coordinator_message_handled", { messageId: "a" }),
  ];
  const planned = planRewind(events, [], "a");
  assert.ok(planned.ok);
  assert.equal(planned.text, "Make a racing game");
  assert.deepEqual(planned.reviews, ["r1"]);
  assert.deepEqual(ids(withoutRewound(events, [planned.rewind])), [], "no review is left reading as starting");
});

test("follow-ups still waiting leave with the message and come back as words; the queue hold stays", () => {
  const events = [
    ...conversation(),
    custom(17, "coordinator_queue_paused", {}),
    user(18, "Then add music"),
    custom(19, "coordinator_message_queued", { messageId: "c", action: { text: "Then add music" } }),
  ];
  const planned = planRewind(events, [], "b");
  assert.ok(planned.ok);
  assert.deepEqual(planned.held, [{ messageId: "c", text: "Then add music", pickedImages: 0 }]);
  const view = withoutRewound(events, [planned.rewind]);
  assert.equal(messageQueueState(view).paused, true, "the hold is queue state, not conversation");
  assert.equal(messageQueueState(view).messages.has("c"), false);
});

test("a message read into a running answer is a rewind target of its own; the answer it joined stays settled", () => {
  const events = [
    user(1, "Make a platformer"),
    custom(2, "coordinator_message_queued", { messageId: "a", action: { text: "Make a platformer" } }),
    custom(3, "coordinator_message_processing", { messageId: "a" }),
    reply(4, "Built it."),
    custom(5, "coordinator_message_handled", { messageId: "a" }),
    user(6, "Add a boss"),
    custom(7, "coordinator_message_queued", { messageId: "b", action: { text: "Add a boss" } }),
    custom(8, "coordinator_message_processing", { messageId: "b" }),
    turnRow(9, "turn_started", "turn-b"),
    // Sent while b was answered, and read by that answer.
    user(10, "Give it wings"),
    custom(11, "coordinator_message_queued", {
      messageId: "c",
      action: { text: "Give it wings", imageCount: 1, attachmentsArtifact: "message_attachments_c" },
    }),
    custom(12, "coordinator_message_steering", { messageId: "c", into: "b" }),
    custom(13, "coordinator_message_delivered", { messageId: "c", into: "b", how: "native" }),
    reply(14, "The boss is in, with wings."),
    turnRow(15, "turn_ended", "turn-b"),
    custom(16, "coordinator_message_handled", { messageId: "b" }),
  ];
  // Flipped: a delivered message used to have no Rewind of its own (`not-answered`).
  assert.deepEqual(
    [...rewindableMessages(events)],
    [
      ["000001", "a"],
      ["000006", "b"],
      ["000010", "c"],
    ],
  );
  assert.deepEqual(
    planRewind(events.slice(0, 12), [], "a"),
    { ok: false, reason: "busy" },
    "not while it is being handed in",
  );
  assert.deepEqual([...rewindableMessages(events.slice(0, 12))], [["000001", "a"]], "nor while it is handed in");
  const joined = planRewind(events, [], "c");
  assert.ok(joined.ok);
  assert.equal(joined.joined, true);
  assert.equal(joined.rewind.from, "000010", "from its bubble: it had no answer of its own");
  assert.deepEqual(joined.rewind.keep, ["000015", "000016"], "the answer it joined ends and stays answered");
  assert.equal(joined.text, "Give it wings");
  assert.equal(joined.imageCount, 1);
  const joinedView = harnessView(events, [joined.rewind]);
  assert.deepEqual(ids(joinedView), [1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16]);
  assert.equal(messageQueueState(joinedView).messages.get("b")?.state, "handled", "the harness never answers b again");
  assert.equal(messageQueueState(joinedView).messages.has("c"), false);
  // Rewinding the answer it joined withdraws it too.
  const planned = planRewind(events, [], "b");
  assert.ok(planned.ok);
  assert.equal(planned.joined, false);
  assert.equal(planned.rewind.from, "000008");
  assert.deepEqual(planned.held, [], "it was read, so it does not come back to the composer");
  assert.deepEqual(planned.answered, ["b"], "its changes are its answer's");
  const view = withoutRewound(events, [planned.rewind]);
  assert.deepEqual(ids(view), [1, 2, 3, 4, 5]);
  assert.equal(messageQueueState(view).messages.has("c"), false);
  // Further back, it leaves as well.
  const earlier = planRewind(events, [], "a");
  assert.ok(earlier.ok);
  assert.deepEqual(earlier.held, []);
  assert.deepEqual(ids(withoutRewound(events, [earlier.rewind])), []);
});

test("the dialog says in one line why only the conversation rewinds, and offers the switch only for a restore", () => {
  const stays = (reason: Extract<RewindFiles, { state: "unavailable" }>["reason"]) =>
    rewindFilesWords({ state: "unavailable", reason }).line;
  assert.deepEqual(
    (["build-changed", "build-running", "history-changed", "no-checkpoint", "joined-answer", "too-large"] as const).map(
      stays,
    ),
    [
      "Only the conversation rewinds: a build changed the game after this message, so its files stay as they are.",
      "A build is running. Rewinding stops it and cuts off any answer under way; the game’s files stay as they are.",
      "Only the conversation rewinds: a commit changed the game after this message, so its files stay as they are.",
      "Only the conversation rewinds: there’s no saved copy of the game from before this message.",
      "Only the conversation rewinds: this message joined an answer already under way, so there’s no saved copy from just before it.",
      "Only the conversation rewinds: the files that changed were too large to save.",
    ],
  );
  assert.equal(
    rewindFilesWords({ state: "unavailable", reason: "too-large", tooLargeFiles: ["Content/big.uasset", "take2.wav"] })
      .line,
    "Only the conversation rewinds: the files that changed were too large to save: big.uasset, take2.wav.",
    "the dialog names the files that keep the game files where they are",
  );
  assert.equal(rewindFilesWords({ state: "none" }).line, "Only the conversation rewinds.");
  assert.equal(
    rewindFilesWords({ state: "unchanged", nested: [] }).line,
    "The game files haven’t changed since this message.",
  );
  const restore: Extract<RewindFiles, { state: "restore" }> = {
    state: "restore",
    files: 2,
    outside: [],
    outsideUnknown: false,
    nested: [],
    tooLarge: 0,
  };
  assert.equal(rewindFilesWords(restore).line, "2 files go back to how they were before this message.");
  assert.equal(restoresByDefault(restore), true);
  assert.equal(restoresByDefault({ ...restore, outside: ["src/level.ts"] }), false, "changed outside: off at first");
  assert.equal(
    rewindFilesWords({ ...restore, outside: ["src/level.ts"] }).outside,
    "Including 1 file changed outside this chat: level.ts.",
  );
  assert.equal(restoresByDefault({ ...restore, outsideUnknown: true }), false);
  assert.equal(
    rewindFilesWords({ ...restore, tooLarge: 2, tooLargeFiles: ["Content/big.uasset", "audio/take2.wav"] }).nested,
    "Too large to save, so they stay as they are: big.uasset, take2.wav.",
    "the dialog names files too large to save before the person confirms",
  );
  assert.equal(
    rewindFilesWords({ ...restore, tooLarge: 1, tooLargeFiles: ["big.uasset"] }).nested,
    "Too large to save, so it stays as it is: big.uasset.",
  );
  assert.equal(
    rewindFilesWords({ ...restore, tooLarge: 2 }).nested,
    "2 files were too large to save and stay as they are.",
    "an older answer without names keeps the count",
  );
  assert.equal(restoresByDefault({ state: "unavailable", reason: "build-running" }), true, "no switch to start off");
  assert.deepEqual(
    [rewindBusyLabel(true), rewindBusyLabel(false), REWIND_WORDS.rewind, REWIND_WORDS.restoreFiles],
    ["Stopping the build…", "Rewinding…", "Rewind chat", "Restore game files"],
  );
});

test("the rewind fixture chat offers Rewind on every bubble, and its build-followed message rewinds the chat alone", async () => {
  const lite = await coreLite();
  try {
    await seedRewindChat(lite.core);
    const thread = await lite.core.threadForGame("rewind-chat");
    const events = await lite.core.store.listEvents(thread);
    const bubbles = events.filter((e) => e.data.type === "messages" && e.data.messages.some((m) => m.role === "user"));
    const offered = rewindableMessages(events);
    assert.equal(bubbles.length, 6);
    assert.deepEqual(
      bubbles.map((e) => offered.get(e.id)),
      [
        bubbles[0]!.id,
        "fixture-rewind-first",
        "fixture-rewind-built",
        "fixture-rewind-failed",
        "fixture-rewind-boats",
        "fixture-rewind-joined",
      ],
    );
    const built = planRewind(events, [], "fixture-rewind-built");
    assert.ok(built.ok);
    assert.deepEqual(built.builds, [{ runId: "fixture-rewind-run", landed: true }]);
    const joined = planRewind(events, [], "fixture-rewind-joined");
    assert.ok(joined.ok && joined.joined);
  } finally {
    await lite.close();
  }
});
