import { appendedEntryIds } from "../../src/renderer/chat/transcript-motion.ts";
import { learningParts } from "../../src/renderer/chat/learning-parts.ts";
import { anchorShift, mountedRange, rowOffsets } from "../../src/renderer/chat/transcript-window.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventStore } from "../../src/substrate/event-store.ts";
import { CHAT_PAGE_SIZE, chatContext, mergeChatEvents } from "../../src/shared/chat-history.ts";
import { chatActivity, delegationActivityScope, SessionActivityRole } from "../../src/shared/chat-activity.ts";
import { CustomEvent, customPayload } from "../../src/shared/custom-events.ts";
import { measuredContext } from "../../src/shared/context.ts";
import { EventKind } from "../../src/shared/event-log.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { compactedWords } from "../../src/renderer/words.ts";
import { withLiveTail } from "../../src/renderer/use-chat-history.ts";
import { removeTree } from "../helpers/tmp.ts";
import type { EventData, EventEnvelope } from "../../src/substrate/types.ts";
const event = (id: number, data: EventData): EventEnvelope => ({
  id: String(id).padStart(6, "0"),
  thread_id: "game",
  turn_id: "turn",
  session_id: null,
  created_at: new Date(id).toISOString(),
  data,
});
const custom = (id: number, event_type: string, payload: unknown) => event(id, { type: "custom", event_type, payload });

test("history pages are bounded, ordered, gap-free, stable during appends, and preserve current run context", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-chat-pages-"));
  try {
    const store = await EventStore.open(root);
    const thread = await store.createThread();
    await store.appendEvents(thread, [
      { type: "custom", event_type: "run_started", payload: { runId: "long-build", project: "game" } },
    ]);
    for (let batch = 0; batch < 4; batch++)
      await store.appendEvents(
        thread,
        Array.from({ length: 100 }, (_, i) => ({
          type: "messages" as const,
          messages: [{ role: "user" as const, content: `Request ${batch * 100 + i}` }],
        })),
      );
    const first = await store.chatPage(thread);
    assert.equal(first.events.length, CHAT_PAGE_SIZE);
    assert.equal(first.hasMore, true);
    assert.equal(
      first.context.some((e) => e.data.type === "custom" && e.data.event_type === "run_started"),
      true,
    );
    const originalHead = first.events.at(-1)!.id;
    await store.appendEvents(thread, [
      { type: "messages", messages: [{ role: "assistant", content: "New reply while paging" }] },
    ]);
    const second = await store.chatPage(thread, first.before!);
    const third = await store.chatPage(thread, second.before!);
    assert.equal(third.hasMore, false);
    const merged = mergeChatEvents(first.events, second.events, third.events);
    assert.equal(merged.length, 402);
    assert.equal(merged.at(-1)!.id, originalHead);
    assert.equal(new Set(merged.map((e) => e.id)).size, 402);
    const current = await store.chatPage(thread);
    assert.equal(current.events.at(-1)!.data.type, "messages");
    await store.appendEvents(thread, [
      { type: "custom", event_type: "run_finished", payload: { runId: "long-build" } },
    ]);
    const finished = await store.chatPage(thread);
    assert.equal(finished.context.at(-1)!.data.type, "custom");
    assert.ok(finished.context.some((e) => e.data.type === "custom" && e.data.event_type === "run_finished"));
    assert.ok(finished.context.length < 10, "the current-state snapshot does not retain the conversation");
    const tail = await store.listEvents(thread, { tail: true, limit: 3 });
    assert.equal(tail.length, 3);
    assert.deepEqual(
      tail.map((e) => e.id),
      tail.map((e) => e.id).sort(),
    );
    const reopened = await EventStore.open(root);
    assert.deepEqual(await reopened.chatState(thread), finished.context);
  } finally {
    await removeTree(root);
  }
});

test("state projection retains unanswered consent and queued input, then removes only the settled identities", () => {
  const pending = chatContext(
    [],
    [
      custom(1, "run_started", { runId: "a" }),
      custom(2, "plugin_consent", { consentId: "approve", state: "pending" }),
      custom(3, "coordinator_message_queued", { messageId: "steer" }),
    ],
  );
  const settled = chatContext(pending, [
    custom(4, "plugin_consent", { consentId: "approve", state: "approved" }),
    custom(5, "coordinator_message_handled", { messageId: "steer" }),
    custom(6, "run_finished", { runId: "a" }),
    custom(7, "run_started", { runId: "b" }),
  ]);
  assert.equal(settled.length, 1);
  assert.equal((settled[0]!.data as any).payload.runId, "b");
});

test("worker completion cannot replace the main session activity", () => {
  const state = chatActivity(
    [
      custom(1, "session_activity", { role: "planner", phase: "thinking" }),
      custom(2, "session_activity", { role: "builder", phase: "completed" }),
      custom(3, "session_activity", { role: "reviewer", phase: "tool" }),
    ],
    true,
  );
  assert.equal(state.phase, "thinking");
});

/** One context reading of a Claude Code session on Opus, as the meter or the delegation mirror writes it. */
const reading = (id: number, role: SessionActivityRole | undefined, promptTokens: number) =>
  custom(id, CustomEvent.ContextUsage, {
    engine: EngineId.ClaudeCode,
    requestedModel: "opus",
    model: "opus",
    ...(role ? { role } : {}),
    promptTokens,
    contextWindow: 200_000,
  });
/** The readings the chat's facts keep, oldest first: whose session each measured, and how full it was. */
const readingsKept = (facts: readonly EventEnvelope[]) =>
  facts
    .map((fact) => customPayload(fact.data, CustomEvent.ContextUsage))
    .filter((p) => p !== null)
    .map((p) => [p.role, p.promptTokens]);

test("a worker's context reading on the chat's model cannot evict the main session's from the chat's facts", () => {
  const said = (id: number) =>
    event(id, { type: EventKind.Messages, messages: [{ role: "assistant", content: `Step ${id}` }] });
  // The main session measured itself, then a base builder and a playtester on the same model
  // mirrored theirs into the game thread, and the chat went on long past one history page.
  const log = [
    reading(1, undefined, 1_000),
    reading(2, SessionActivityRole.Planner, 40_000),
    reading(3, SessionActivityRole.Builder, 80_000),
    reading(4, SessionActivityRole.Reviewer, 10_000),
    reading(5, SessionActivityRole.Builder, 90_000),
    ...Array.from({ length: CHAT_PAGE_SIZE + 40 }, (_, i) => said(6 + i)),
  ];
  const facts = chatContext([], log);
  // Reopened: the meter reads the facts plus the newest page, which no longer holds any reading.
  const reopened = mergeChatEvents(facts, log.slice(-CHAT_PAGE_SIZE));
  assert.equal(measuredContext(reopened, EngineId.ClaudeCode, "opus")?.promptTokens, 40_000);
  assert.deepEqual(
    readingsKept(facts),
    [
      [SessionActivityRole.Planner, 40_000],
      [SessionActivityRole.Reviewer, 10_000],
      [SessionActivityRole.Builder, 90_000],
    ],
    "each role keeps only its newest reading, and a reading with no role is the main session's",
  );
});

test("a chat checkpoint saved before readings were kept per role is rebuilt, and the meter finds the main session's", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-chat-context-"));
  try {
    const store = await EventStore.open(root);
    const thread = await store.createThread();
    const logged = (role: SessionActivityRole, promptTokens: number) => reading(0, role, promptTokens).data;
    await store.appendEvents(thread, [
      logged(SessionActivityRole.Planner, 40_000),
      logged(SessionActivityRole.Builder, 90_000),
    ]);
    await store.appendEvents(
      thread,
      Array.from({ length: CHAT_PAGE_SIZE + 40 }, (_, i) => ({
        type: EventKind.Messages,
        messages: [{ role: "assistant" as const, content: `Step ${i}` }],
      })),
    );
    const all = await store.listEvents(thread, {});
    // What the app saved before (format 5): one reading per model, so the builder's had evicted the planner's.
    const builderOnly = all.filter(
      (e) => customPayload(e.data, CustomEvent.ContextUsage)?.role === SessionActivityRole.Builder,
    );
    await fs.writeFile(
      path.join(store.threadDir(thread), "chat-context.json"),
      JSON.stringify({ version: 5, head: all.at(-1)?.id, rewinds: 0, events: builderOnly }),
    );
    const page = await store.chatPage(thread);
    const reopened = mergeChatEvents(page.context, page.events);
    assert.equal(measuredContext(reopened, EngineId.ClaudeCode, "opus")?.promptTokens, 40_000);
  } finally {
    await removeTree(root);
  }
});

test("a reading with no role and a planner's are the main session's: the newer replaces the older in the facts", () => {
  const planner = reading(1, SessionActivityRole.Planner, 40_000);
  const unnamed = reading(2, undefined, 45_000);
  assert.deepEqual(readingsKept(chatContext([], [planner, unnamed])), [[undefined, 45_000]]);
  // The same across a checkpoint: the saved facts folded first, then the events after its head.
  assert.deepEqual(readingsKept(chatContext(chatContext([], [planner]), [unnamed])), [[undefined, 45_000]]);
  const named = reading(3, SessionActivityRole.Planner, 50_000);
  assert.deepEqual(readingsKept(chatContext(chatContext([], [unnamed]), [named])), [
    [SessionActivityRole.Planner, 50_000],
  ]);
});

test("delegated background work never becomes the main reply, while a direct chat build does", () => {
  assert.equal(delegationActivityScope({ selfCapture: {} }).role, "planner");
  assert.equal(delegationActivityScope({ selfCapture: { runId: "run", facetId: "bridge" } }).role, "builder");
  assert.deepEqual(delegationActivityScope({ playtest: { runId: "run", facetId: "bridge" }, readOnly: true }), {
    role: "reviewer",
    runId: "run",
    facetId: "bridge",
  });
  assert.equal(delegationActivityScope({ candidateId: "experiment" }).role, "builder");
  assert.deepEqual(delegationActivityScope({ coordinator: { runId: "run" }, readOnly: true }), {
    role: "planner",
    runId: "run",
    facetId: undefined,
  });
});

test("late terminal records from another build do not replace the current build outcome", () => {
  const context = chatContext(
    [],
    [
      custom(1, "run_started", { runId: "a" }),
      custom(2, "run_started", { runId: "b" }),
      custom(3, "run_finished", { runId: "b" }),
      custom(4, "run_finished", { runId: "a" }),
    ],
  );
  assert.equal((context.at(-1)!.data as any).payload.runId, "b");
});

test("native tool identities are isolated across workers and preserve result details", () => {
  const mirror = (id: number, delegationId: string, kind: string, parts: unknown[]) =>
    custom(id, "delegated.codex", { delegationId, kind, data: { parts } });
  const entries = toEntries([
    mirror(1, "bridge", "assistant", [{ type: "tool_use", id: "item_0", name: "Bash", input: "check bridge" }]),
    mirror(2, "lights", "assistant", [{ type: "tool_use", id: "item_0", name: "Bash", input: "check lights" }]),
    mirror(3, "lights", "user", [
      { type: "tool_result", tool_use_id: "item_0", is_error: true, content: "Light missing" },
    ]),
    mirror(4, "bridge", "user", [
      { type: "tool_result", tool_use_id: "item_0", is_error: false, content: "Bridge passed" },
    ]),
  ]);
  const rows = entries.flatMap((e) => (e.kind === "tools" ? e.rows : []));
  assert.equal(rows[0]!.state, "succeeded");
  assert.equal(rows[1]!.state, "failed");
  assert.equal(rows[0]!.detail?.[0]?.text, "Bridge passed");
  assert.equal(rows[1]!.detail?.[0]?.text, "Light missing");
  assert.notEqual(rows[0]!.key, rows[1]!.key);
});

test("tools reconcile by identity and never infer success from missing mirrored results", () => {
  const entries = toEntries([
    event(1, {
      type: "tool_requested",
      tool_call_id: "a",
      request: { name: "read_file", arguments: { path: "game.ts" } },
    }),
    event(2, {
      type: "tool_requested",
      tool_call_id: "b",
      request: { name: "read_file", arguments: { path: "other.ts" } },
    }),
    event(3, { type: "tool_result", tool_call_id: "b", result: { ok: false, content: "File unavailable" } }),
    event(4, { type: "turn_ended", status: "cancelled" }),
  ]);
  const rows = entries.flatMap((e) => (e.kind === "tools" ? e.rows : []));
  assert.equal(rows[0]!.state, "stopped");
  assert.equal(rows[1]!.state, "failed");
  const mirror = toEntries([
    custom(1, "delegated.codex", {
      kind: "assistant",
      data: { parts: [{ type: "tool_use", id: "mirror", name: "Bash", input: "npm test" }] },
    }),
  ]);
  assert.equal(mirror[0]!.kind, "tools");
  assert.equal((mirror[0] as any).rows[0].state, "unknown");
});

test("parallel plugin calls match their own outcomes and delivered assets stay visible", () => {
  const entries = toEntries([
    custom(1, "plugin_tool_started", {
      callId: "a",
      pluginName: "Images",
      tool: "generate",
      toolName: "images__generate",
    }),
    custom(2, "plugin_tool_started", {
      callId: "b",
      pluginName: "Images",
      tool: "generate",
      toolName: "images__generate",
    }),
    custom(3, "plugin_tool", { callId: "b", pluginName: "Images", ok: false, error: "Generation failed" }),
    custom(4, "asset_delivered", {
      project: "game",
      source: "images",
      jobId: "a",
      at: "now",
      files: [{ file: "assets/cover.png", kind: "image", bytes: 42 }],
    }),
    custom(5, "plugin_tool", { callId: "a", pluginName: "Images", ok: true }),
  ]);
  const rows = entries.flatMap((e) => (e.kind === "tools" ? e.rows : []));
  assert.equal(rows.find((row) => row.key === "a")!.state, "succeeded");
  assert.equal(rows.find((row) => row.key === "b")!.state, "failed");
  assert.ok(entries.some((e) => e.kind === "assets"));
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length);
});

test("build-workspace deliveries wait for their run result; game-folder deliveries show where they land", () => {
  const file = (name: string) => [
    { file: `assets/genex/0d99db96-677f-436b-abcf-5da04d1e06cf/${name}`, kind: "audio", bytes: 4 },
  ];
  const entries = toEntries([
    custom(1, "asset_delivered", {
      project: "game",
      source: "genex",
      jobId: "chat",
      at: "now",
      workspace: "game",
      files: file("chat.mp3"),
    }),
    custom(2, "asset_delivered", {
      project: "game",
      source: "genex",
      jobId: "director",
      at: "now",
      runId: "run_a",
      workspace: "build",
      files: file("kick.mp3"),
    }),
    custom(3, "asset_delivered", {
      project: "game",
      source: "genex",
      jobId: "legacy",
      at: "now",
      runId: "run_a",
      files: file("whistle.mp3"),
    }),
    custom(4, "run_finished", { runId: "run_a", project: "game", landed: false, stoppedBecause: "paused" }),
    custom(5, "asset_delivered", {
      project: "game",
      source: "genex",
      jobId: "resumed",
      at: "now",
      runId: "run_a",
      workspace: "build",
      files: file("crowd.mp3"),
    }),
    custom(6, "run_finished", { runId: "run_a", project: "game", landed: true }),
    custom(7, "asset_delivered", {
      project: "game",
      source: "genex",
      jobId: "orphan",
      at: "now",
      workspace: "build",
      files: file("orphan.mp3"),
    }),
  ]);
  assert.deepEqual(
    entries.flatMap((e) => (e.kind === "assets" ? [e.delivery.jobId] : [])),
    ["chat"],
  );
  const results = entries.flatMap((e) => (e.kind === "morning" ? [e] : []));
  assert.equal(results.length, 2);
  assert.equal(results[0]!.assets, undefined, "a paused close does not repeat what the final result shows");
  assert.deepEqual(
    results[1]!.assets?.map((d) => d.jobId),
    ["director", "legacy", "resumed"],
  );
});

test("a run's earlier result card is superseded by its later close, so only the latest offers Resume", () => {
  const entries = toEntries([
    custom(1, "run_started", { runId: "r", project: "game" }),
    custom(2, "run_finished", { runId: "r", project: "game", landed: true }),
    custom(3, "run_registered", { runId: "r", project: "game", resumed: true }),
    custom(4, "run_finished", { runId: "r", project: "game", executionStatus: "paused" }),
    custom(5, "autopilot_paused", { runId: "r", project: "game" }),
  ]);
  const results = entries.flatMap((e) => (e.kind === "morning" ? [e] : []));
  assert.deepEqual(
    results.map((card) => card.superseded),
    [true, undefined],
    "the reopened run's pause is not the finished run's card",
  );
});

test("a coordinator turn ending does not end worker tools; stopping their run does", () => {
  const pending = [
    custom(1, "delegated.codex", {
      runId: "build",
      delegationId: "worker",
      kind: "assistant",
      data: { parts: [{ type: "tool_use", id: "t", name: "Bash" }] },
    }),
    custom(2, "plugin_tool_started", { runId: "build", callId: "image", pluginName: "Images", tool: "generate" }),
    event(3, { type: "turn_ended", status: "cancelled" }),
  ];
  const rows = (events: EventEnvelope[]) =>
    toEntries(events).flatMap((entry) => (entry.kind === "tools" ? entry.rows : []));
  assert.deepEqual(
    rows(pending).map((row) => row.state),
    ["running", "running"],
  );
  assert.deepEqual(
    rows([...pending, custom(4, "run_finished", { runId: "build", executionStatus: "cancelled" })]).map(
      (row) => row.state,
    ),
    ["stopped", "stopped"],
  );
  assert.deepEqual(
    rows([...pending, custom(4, "run_finished", { runId: "other" })]).map((row) => row.state),
    ["running", "running"],
  );
});

test("message batch entries have stable unique identities when older history is prepended", () => {
  const batch = event(3, {
    type: "messages",
    messages: [
      { role: "user", content: "One" },
      { role: "assistant", content: "Two" },
    ],
  });
  const single = toEntries([batch]);
  const withHistory = toEntries([
    event(1, { type: "messages", messages: [{ role: "user", content: "Earlier" }] }),
    batch,
  ]);
  assert.notEqual(single[0]!.id, single[1]!.id);
  assert.deepEqual(
    withHistory.slice(-2).map((e) => e.id),
    single.map((e) => e.id),
  );
});

test("tool projection retains command input separately from multiline output", () => {
  const command = "npm run build && npm test";
  const rows = toEntries([
    event(1, { type: "tool_requested", tool_call_id: "command", request: { name: "Bash", arguments: { command } } }),
    event(2, {
      type: "tool_result",
      tool_call_id: "command",
      result: { ok: true, content: "Build passed.\n\n34 checks passed." },
    }),
  ]);
  const group = rows.find((row) => row.kind === "tools");
  assert.ok(group && group.kind === "tools");
  assert.deepEqual(group.rows[0]!.input, { command });
  assert.equal(group.rows[0]!.detail?.map((line) => line.text).join("\n"), "Build passed.\n\n34 checks passed.");
});

test("cancelled plans stay at their recorded position when a later conversation starts", () => {
  const rows = toEntries([
    custom(1, "plan_review", { id: "plan", state: "cancelled" }),
    event(2, { type: "messages", messages: [{ role: "user", content: "Build something else" }] }),
    event(3, { type: "messages", messages: [{ role: "assistant", content: "The new game is ready." }] }),
  ]);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["system", "user", "assistant"],
  );
  assert.equal(rows[0]!.kind === "system" && rows[0]!.text, "Plan cancelled.");
});

test("queue identity, edits and removals survive paged history and checkpoint batches", async () => {
  const { messageQueueState } = await import("../../src/shared/message-queue.ts");
  const { conversationThrough } = await import("../../src/shared/coordinator.ts");
  const user = event(1, { type: "messages", messages: [{ role: "user", content: "Original request" }] });
  const queued = custom(2, "coordinator_message_queued", { messageId: "a", action: { text: "Original request" } });
  let state = chatContext(chatContext([], [user]), [queued]);
  state = chatContext(state, [
    custom(3, "coordinator_message_updated", { messageId: "a", text: "Revised request" }),
    custom(4, "coordinator_queue_paused", {}),
  ]);
  assert.equal(messageQueueState(state).paused, true);
  assert.equal(messageQueueState(state).messages.get("a")?.eventId, user.id);
  assert.equal(messageQueueState(state).messages.get("a")?.action?.text, "Revised request");
  state = chatContext(state, [custom(5, "coordinator_message_processing", { messageId: "a" })]);
  assert.equal(messageQueueState(state).messages.get("a")?.state, "processing");
  state = chatContext(state, [
    custom(6, "coordinator_message_handled", { messageId: "a" }),
    event(7, { type: "messages", messages: [{ role: "user", content: "Another request" }] }),
  ]);
  const visible = conversationThrough(mergeChatEvents(state, [user])) as EventEnvelope[];
  assert.equal((visible.find((e) => e.id === user.id)?.data as any)?.messages[0].content, "Revised request");
  assert.equal(
    state.some((e) => e.id === user.id),
    false,
    "settled old message bodies are not checkpointed",
  );
  state = chatContext(state, [custom(8, "coordinator_message_removed", { messageId: "a" })]);
  assert.equal(
    conversationThrough(mergeChatEvents(state, [user])).some((e: EventEnvelope) => e.id === user.id),
    false,
  );
});

test("ordinary completed queue messages do not grow the current-state checkpoint", () => {
  let state: EventEnvelope[] = [];
  for (let n = 0; n < 500; n++)
    state = chatContext(state, [
      event(n * 3 + 1, { type: "messages", messages: [{ role: "user", content: `Request ${n}` }] }),
      custom(n * 3 + 2, "coordinator_message_queued", { messageId: String(n), action: { text: `Request ${n}` } }),
      custom(n * 3 + 3, "coordinator_message_handled", { messageId: String(n) }),
    ]);
  assert.equal(state.length, 1, "only the latest user event bridges a future queue marker batch");
});

test("entrance motion applies only to newly appended rows, never history or remounts", () => {
  assert.deepEqual([...appendedEntryIds(null, ["b", "c"])], []);
  assert.deepEqual([...appendedEntryIds([], ["first"])], ["first"]);
  assert.deepEqual([...appendedEntryIds(["b", "c"], ["a", "b", "c"])], []);
  assert.deepEqual([...appendedEntryIds(["b", "c"], ["b", "c"])], []);
  assert.deepEqual([...appendedEntryIds(["b", "c"], ["a", "b", "c", "d", "e"])], ["d", "e"]);
});

test("the transcript window lays rows out, mounts those near the viewport and keeps the top row in place", () => {
  assert.deepEqual(
    rowOffsets(
      [{ id: "a" }, { id: "b" }, { id: "c" }],
      new Map([
        ["a", 40],
        ["c", 60],
      ]),
    ),
    [0, 40, 140, 200],
    "an unmeasured row counts as 100 px",
  );
  const hundreds = Array.from({ length: 31 }, (_, i) => i * 100);
  assert.deepEqual(
    mountedRange(hundreds, { top: 1500, height: 400 }),
    { start: 3, end: 30 },
    "three screens either side",
  );
  assert.deepEqual(mountedRange(hundreds, { top: 9000, height: 400 }), { start: 30, end: 30 }, "past the end, none");
  assert.deepEqual(mountedRange(hundreds, { top: 0, height: 900 }), { start: 0, end: 30 });
  assert.deepEqual(mountedRange([0], { top: 0, height: 900 }), { start: 0, end: 0 });

  const before = { ids: ["a", "b", "c"], offsets: [0, 100, 200, 300] };
  const grown = { ids: ["x", "a", "b", "c"], offsets: [0, 50, 150, 250, 350] };
  assert.equal(anchorShift(before, grown, 150), 50, "the row across the viewport's top moves by what was added above");
  assert.equal(anchorShift(before, { ids: ["a", "c"], offsets: [0, 100, 200] }, 150), 0, "a row that is gone");
  assert.equal(anchorShift(before, grown, 1000), 50, "past the end, the first row anchors");
  assert.equal(anchorShift({ ids: [], offsets: [0] }, grown, 0), 0);
});

test("learning hides zero counts and links recorded counts without rewriting notes", () => {
  assert.deepEqual(learningParts("4 past tasks reviewed · 1 proposed · 0 applied · 0 rejected"), [
    { text: "4 past tasks reviewed", link: true },
    { text: "1 proposed", link: true },
  ]);
  assert.deepEqual(learningParts("0 past tasks reviewed · 0 proposed"), []);
  assert.deepEqual(learningParts("Keep the lanterns warm. 0 shadows were added."), [
    { text: "Keep the lanterns warm. 0 shadows were added.", link: false },
  ]);
  assert.deepEqual(learningParts("2 applied · 1 rejected"), [
    { text: "2 applied", link: true },
    { text: "1 rejected", link: true },
  ]);
});

test("a follow-up typed during a build reads after that build: waiting at the end, delivered where processing began", async () => {
  const { deliveryOrder } = await import("../../src/renderer/chat/delivery-order.ts");
  const user = (id: number, content: string) => event(id, { type: "messages", messages: [{ role: "user", content }] });
  const tools = (id: number) =>
    event(id, {
      type: "tool_requested",
      tool_call_id: `t${id}`,
      request: { name: "read_file", arguments: { path: "a.js" } },
    } as EventData);
  const base = [
    user(1, "Build a village"),
    tools(2),
    user(3, "do you see genex tools?"),
    custom(4, "coordinator_message_queued", { messageId: "m", eventId: "000003" }),
    tools(5),
    tools(6),
  ];
  const waiting = deliveryOrder(base).map((e) => e.id);
  assert.deepEqual(
    waiting,
    ["000001", "000002", "000004", "000005", "000006", "000003"],
    "still waiting: below the current work",
  );
  const tools2 = toEntries(deliveryOrder(base)).filter((e) => e.kind === "tools");
  assert.equal(tools2.length, 1, "queue bookkeeping does not split one work group");
  const delivered = [
    ...base,
    custom(7, "run_finished", { runId: "r", stoppedBecause: "stopped by the user", executionStatus: "paused" }),
    custom(8, "coordinator_message_processing", { messageId: "m" }),
    event(9, { type: "messages", messages: [{ role: "assistant", content: "Yes." }] }),
  ];
  assert.deepEqual(
    deliveryOrder(delivered)
      .map((e) => e.id)
      .slice(-4),
    ["000007", "000003", "000008", "000009"],
    "delivered after the build it waited for",
  );
});

test("a Stop with a follow-up waiting hands over to it; a plain Stop shows one stopped line", () => {
  const queued = [
    event(1, { type: "messages", messages: [{ role: "user", content: "Question?" }] }),
    custom(2, "coordinator_message_queued", { messageId: "m", eventId: "000001" }),
  ];
  const stop = (id: number) => [
    custom(id, "run_finished", {
      runId: "r",
      stoppedBecause: "stopped by the user",
      executionStatus: "paused",
      project: "game",
    }),
    custom(id + 1, "autopilot_paused", { runId: "r", project: "game" }),
  ];
  const handed = toEntries([custom(0, "run_started", { runId: "r" }), ...queued, ...stop(3)]);
  assert.equal(
    handed.find((e) => e.kind === "morning")?.kind === "morning" && handed.find((e) => e.kind === "morning")!.handedOff,
    true,
  );
  assert.ok(
    !handed.some((e) => e.kind === "action" && e.action === "resume"),
    "no second paused line under the result",
  );
  const plain = toEntries([custom(0, "run_started", { runId: "r" }), ...stop(3)]);
  const card = plain.find((e) => e.kind === "morning");
  assert.ok(card && card.kind === "morning" && !card.handedOff);
  assert.ok(!plain.some((e) => e.kind === "action" && e.action === "resume"));
  const alone = toEntries([custom(0, "run_started", { runId: "r" }), custom(1, "autopilot_paused", { runId: "r" })]);
  assert.ok(
    alone.some((e) => e.kind === "action" && e.action === "resume" && !/paused/i.test(e.text)),
    "a pause with no result card still offers Resume, in the same words",
  );
});

test("Stop reads as stopped: a builder handing back and its orphaned tools settle with the turn", () => {
  const entries = toEntries([
    event(1, { type: "turn_started", metadata: {} } as EventData),
    event(2, {
      type: "tool_requested",
      tool_call_id: "hand",
      request: { name: "delegate_to_contractor", arguments: { brief: "x" } },
    } as EventData),
    custom(3, "delegated.claude-code", {
      kind: "assistant",
      data: { parts: [{ type: "tool_use", id: "bash1", name: "Bash", input: { command: "npm run build" } }] },
      delegationId: "d1",
    }),
    event(4, {
      type: "tool_result",
      tool_call_id: "hand",
      result: { ok: false, content: "Contractor stopped after 3 turns (stopped): stopped by you" },
    } as EventData),
    event(5, { type: "turn_ended", status: "cancelled" } as EventData),
  ]);
  const rows = entries.flatMap((e) => (e.kind === "tools" ? e.rows : []));
  assert.ok(rows.length >= 2);
  for (const row of rows) {
    assert.equal(row.state, "stopped", row.label);
    assert.ok(!row.failed, row.label);
  }
});

test('a finished run closes the director\'s phase, so a later pass is not labelled with its last "Thinking"', () => {
  const after = chatActivity(
    [custom(1, "session_activity", { role: "planner", phase: "thinking" }), custom(2, "run_finished", { runId: "r" })],
    true,
    "Improving its own craft",
  );
  assert.equal(after.label, "Improving its own craft");
});

test("another delegation's end does not end the reply in progress", () => {
  const activity = (n: number, payload: Record<string, unknown>) => custom(n, "session_activity", payload);
  const replying = activity(1, { role: "planner", phase: "responding", delegationId: "chat" });
  const leadDone = activity(2, { role: "planner", phase: "completed", delegationId: "lead", runId: "r" });
  assert.equal(chatActivity([replying, leadDone], true, "Building").phase, "responding");
  // The reply's own end still hands the line back to the work in progress.
  const replyDone = activity(3, { role: "planner", phase: "completed", delegationId: "chat" });
  assert.deepEqual(chatActivity([replying, replyDone], true, "Building"), { phase: "working", label: "Building" });
});

test("the live tail keeps the loaded array when nothing new arrived for this thread", () => {
  const loaded = [event(1, { type: "error", message: "a" }), event(2, { type: "error", message: "b" })];
  const other = { ...event(3, { type: "error", message: "other chat" }), thread_id: "other" };
  assert.equal(withLiveTail(loaded, [], "game"), loaded, "no live events");
  assert.equal(withLiveTail(loaded, [other], "game"), loaded, "another chat's event is not news here");
  assert.equal(withLiveTail(loaded, [loaded[0]!, loaded[1]!], "game"), loaded, "events already on the page");
  const fresh = event(4, { type: "error", message: "new" });
  assert.deepEqual(
    withLiveTail(loaded, [other, fresh], "game").map((e) => e.id),
    [loaded[0]!.id, loaded[1]!.id, fresh.id],
  );
});

test("routine narration folds by what its record says, not by the words written about it", () => {
  const lines = (events: EventEnvelope[]) =>
    toEntries(events).map((entry) =>
      entry.kind === "activity"
        ? `activity:${entry.rows.length}`
        : entry.kind === "system"
          ? `line:${entry.tag}`
          : entry.kind,
    );
  const run = { runId: "r", project: "game", facetId: "sky", facetTitle: "Sky" };
  // A lead's decision is only its sentence (no structured outcome yet), so its words still decide.
  assert.deepEqual(
    lines([
      custom(1, "autopilot_decision", { ...run, plain: "Stopped the sky builder: it failed twice" }),
      custom(12, "autopilot_decision", { ...run, plain: "Building the sky next." }),
    ]),
    ["line:UPDATE", "activity:1"],
  );
  // A round the lead stopped, one that broke checks again, and a step that was not delivered are trouble.
  assert.deepEqual(
    lines([
      custom(2, "facet_iteration", {
        ...run,
        iteration: 1,
        winner: null,
        verdictSource: "stopped",
        reason: "moved on",
      }),
    ]),
    ["line:PART"],
  );
  assert.deepEqual(
    lines([
      custom(3, "facet_iteration", {
        ...run,
        iteration: 2,
        winner: "challenger",
        scoreboard: { total: 3, passing: 2, regressions: ["a"] },
      }),
    ]),
    ["line:PART"],
  );
  assert.deepEqual(
    lines([
      custom(4, "facet_iteration", {
        ...run,
        iteration: 3,
        winner: "challenger",
        move: { what: "add rain", delivered: false },
      }),
    ]),
    ["line:PART"],
  );
  // An ordinary undone round, whatever its judge wrote, is routine.
  assert.deepEqual(
    lines([
      custom(5, "facet_iteration", {
        ...run,
        iteration: 4,
        winner: "incumbent",
        verdictSource: "taste-veto",
        verdict: { because: "Undone: the checks failed and it could not be judged better" },
      }),
    ]),
    ["activity:1"],
  );
  assert.deepEqual(
    lines([custom(6, "facet_iteration", { ...run, iteration: 5, winner: "incumbent", verdictSource: "outage" })]),
    ["line:PART"],
    "a judge that could not be reached is trouble",
  );
  // A connector call is a step of the work, failed or not, never a narration line.
  assert.deepEqual(
    lines([
      custom(7, "connector_tool", { connectorId: "figma", tool: "get", ok: false, error: "denied" }),
      custom(8, "connector_tool", { connectorId: "figma", tool: "get", ok: true }),
    ]),
    ["tools", "tools"],
  );
  assert.deepEqual(lines([custom(9, "blender_asset", { ...run, name: "boat", ok: false, error: "crash" })]), [
    "line:BLENDER",
  ]);
  assert.deepEqual(
    lines([
      custom(10, "facet_circuit_break", { ...run, reason: "no judge" }),
      custom(11, "facet_check_replanned", { ...run, action: "drop" }),
    ]),
    ["line:UPDATE", "activity:1"],
  );
});

test("a message steered into the running turn waits at the end, then reads where that turn read it, mid-work", async () => {
  const { deliveryOrder } = await import("../../src/renderer/chat/delivery-order.ts");
  const { conversationEntries } = await import("../../src/renderer/chat/conversation-entries.ts");
  const user = (id: number, content: string) => event(id, { type: "messages", messages: [{ role: "user", content }] });
  const said = (id: number, parts: unknown[]) =>
    custom(id, "delegated.claude-code", { delegationId: "chat", kind: "assistant", data: { parts } });
  const done = (id: number, tool: string) =>
    custom(id, "delegated.claude-code", {
      delegationId: "chat",
      kind: "user",
      data: { parts: [{ type: "tool_result", tool_use_id: tool, content: "ok" }] },
    });
  const base = [
    user(1, "Make the jump higher"),
    custom(2, "coordinator_message_queued", { messageId: "a", action: { text: "Make the jump higher" } }),
    custom(3, "coordinator_message_processing", { messageId: "a" }),
    said(4, [{ type: "tool_use", id: "read", name: "Read", input: { path: "player.ts" } }]),
    done(5, "read"),
    said(6, [{ type: "text", text: "Raising the jump." }]),
    said(7, [{ type: "tool_use", id: "edit", name: "Edit", input: { path: "player.ts" } }]),
    // Sent while the edit runs: saved and handed to the turn in one batch.
    user(8, "and make it floatier"),
    custom(9, "coordinator_message_queued", { messageId: "b", action: { text: "and make it floatier" } }),
    custom(10, "coordinator_message_steering", { messageId: "b", into: "a" }),
    said(11, [{ type: "tool_use", id: "check", name: "Bash", input: { command: "npm test" } }]),
  ];
  assert.deepEqual(
    deliveryOrder(base).map((e) => Number(e.id)),
    [2, 1, 3, 4, 5, 6, 7, 9, 10, 11, 8],
    "not read yet: below the current work, like queued input",
  );
  const waitingWork = conversationEntries(toEntries(deliveryOrder(base))).filter((e) => e.kind === "work");
  assert.equal(waitingWork.length, 2);
  assert.equal(
    waitingWork[1]!.kind === "work" && waitingWork[1]!.items.length,
    2,
    "its receipt and hand-off do not split the work group",
  );
  // Read at the next tool boundary: the host records it there, among the turn's own rows.
  const delivered = [
    ...base,
    done(12, "edit"),
    done(13, "check"),
    custom(14, "coordinator_message_delivered", { messageId: "b", into: "a", how: "native" }),
    said(15, [{ type: "tool_use", id: "gravity", name: "Edit", input: { path: "physics.ts" } }]),
    done(16, "gravity"),
    said(17, [{ type: "text", text: "Higher, and floatier." }]),
    custom(18, "coordinator_message_handled", { messageId: "a" }),
  ];
  assert.deepEqual(
    deliveryOrder(delivered).map((e) => Number(e.id)),
    [2, 1, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 8, 14, 15, 16, 17, 18],
    "right before its delivery, not where it was typed",
  );
  const entries = conversationEntries(toEntries(deliveryOrder(delivered)));
  assert.deepEqual(
    entries.map((e) => e.kind),
    ["user", "work", "assistant", "work", "user", "work", "assistant"],
  );
  assert.equal(entries[4]!.id, "000008-0:user");
  assert.equal(entries[4]!.kind === "user" && entries[4]!.text, "and make it floatier");
  assert.deepEqual(
    entries.flatMap((e) => (e.kind === "work" ? [e.items.length] : [])),
    [1, 2, 1],
    "the work before it keeps both its calls; what follows is new work",
  );
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length);
  // One the turn did not read goes back to the queue, and waits for its own turn at the end.
  const requeued = [
    ...base,
    custom(12, "coordinator_message_requeued", { messageId: "b" }),
    custom(13, "coordinator_message_handled", { messageId: "a" }),
  ];
  assert.equal(deliveryOrder(requeued).at(-1)!.id, "000008");
});

test("a message steered in by interrupting the session stops the tools that leg left running", () => {
  const said = (id: number, delegationId: string, parts: unknown[], scope: Record<string, string> = {}) =>
    custom(id, "delegated.claude-code", { delegationId, kind: "assistant", data: { parts }, ...scope });
  const events = (how: string) => [
    event(1, { type: "messages", messages: [{ role: "user", content: "Add a boss" }] }),
    custom(2, "coordinator_message_queued", { messageId: "a" }),
    custom(3, "coordinator_message_processing", { messageId: "a" }),
    event(4, {
      type: "tool_requested",
      tool_call_id: "direct",
      request: { name: "read_file", arguments: { path: "a.js" } },
    } as EventData),
    said(5, "chat", [{ type: "tool_use", id: "bash", name: "Bash", input: { command: "npm run build" } }]),
    said(6, "worker", [{ type: "tool_use", id: "bash", name: "Bash", input: { command: "npm test" } }], {
      runId: "build",
      facetId: "river",
    }),
    // A run's coordinator answers for that run: its rows carry the runId, but it is the chat's session.
    // (Its run controls are the host's own rows, recorded when the host answers them: a read here.)
    said(7, "coordinator", [{ type: "tool_use", id: "status", name: "Read", input: { file_path: "NOTES.md" } }], {
      runId: "build",
    }),
    event(8, { type: "messages", messages: [{ role: "user", content: "Give it wings" }] }),
    custom(9, "coordinator_message_queued", { messageId: "b" }),
    custom(10, "coordinator_message_steering", { messageId: "b", into: "a" }),
    custom(11, "coordinator_message_delivered", { messageId: "b", into: "a", how }),
    said(12, "chat", [{ type: "tool_use", id: "wings", name: "Edit", input: { path: "boss.ts" } }]),
  ];
  const states = (how: string) =>
    toEntries(events(how)).flatMap((e) => (e.kind === "tools" ? e.rows.map((row) => row.state) : []));
  assert.deepEqual(
    states("interrupt"),
    ["running", "stopped", "running", "stopped", "running"],
    "only the interrupted chat legs (a coordinator's too); not the turn's own call, a build worker or the resumed session",
  );
  assert.deepEqual(
    states("native"),
    ["running", "running", "running", "running", "running"],
    "read mid-turn, nothing was cut off",
  );
});

test("steered input keeps its state across history pages, and settles with the turn it joined", async () => {
  const { messageQueueState } = await import("../../src/shared/message-queue.ts");
  const user = event(1, { type: "messages", messages: [{ role: "user", content: "Make it floatier" }] });
  // The page ends between the message and its receipt.
  let state = chatContext(chatContext([], [user]), [
    custom(2, "coordinator_message_queued", { messageId: "b", action: { text: "Make it floatier" } }),
    custom(3, "coordinator_message_steering", { messageId: "b", into: "a" }),
  ]);
  const steering = messageQueueState(state).messages.get("b");
  assert.equal(steering?.state, "steering");
  assert.equal(steering?.eventId, user.id);
  assert.ok(
    state.some((e) => e.id === user.id),
    "its bubble can wait below the work with its page unloaded",
  );
  const later = event(7, { type: "messages", messages: [{ role: "user", content: "Next" }] });
  state = chatContext(state, [
    custom(4, "coordinator_message_delivered", { messageId: "b", into: "a", how: "native" }),
  ]);
  assert.equal(
    messageQueueState(state).messages.get("b")?.state,
    "delivered",
    "read, while the turn it joined still works",
  );
  // A turn that ends without reading it after all puts it back: it keeps its bubble and its own turn.
  const requeued = chatContext(state, [
    custom(5, "coordinator_message_requeued", { messageId: "b" }),
    custom(6, "coordinator_message_handled", { messageId: "a" }),
    later,
    custom(8, "coordinator_message_processing", { messageId: "b" }),
  ]);
  assert.equal(messageQueueState(requeued).messages.get("b")?.state, "processing");
  assert.ok(requeued.some((e) => e.id === user.id));
  // Answered by that turn: settled with it, nothing of it checkpointed.
  state = chatContext(state, [custom(5, "coordinator_message_handled", { messageId: "a" }), later]);
  assert.equal(messageQueueState(state).messages.has("b"), false);
  assert.equal(
    state.some((e) => e.id === user.id),
    false,
  );
  // Edited while it waited: the edit and its settled state survive, so an older page reads true.
  let edited = chatContext(
    [],
    [
      user,
      custom(2, "coordinator_message_queued", { messageId: "b", action: { text: "Make it floatier" } }),
      custom(3, "coordinator_message_updated", { messageId: "b", text: "Make it much floatier" }),
    ],
  );
  edited = chatContext(
    chatContext(edited, [custom(4, "coordinator_message_steering", { messageId: "b", into: "a" })]),
    [
      custom(5, "coordinator_message_delivered", { messageId: "b", into: "a", how: "interrupt" }),
      custom(6, "coordinator_message_handled", { messageId: "a" }),
      later,
    ],
  );
  const settled = messageQueueState(mergeChatEvents(edited, [user])).messages.get("b");
  assert.equal(settled?.state, "delivered");
  assert.equal(settled?.action?.text, "Make it much floatier");
  assert.equal(
    edited.some((e) => e.id === user.id),
    false,
  );
});

test("a message handed to a run's lead reads where it was sent, its answer is a chat bubble, and it settles when that run closes", async () => {
  const { deliveryOrder } = await import("../../src/renderer/chat/delivery-order.ts");
  const { conversationEntries } = await import("../../src/renderer/chat/conversation-entries.ts");
  const { messageQueueState } = await import("../../src/shared/message-queue.ts");
  const user = (id: number, content: string) => event(id, { type: "messages", messages: [{ role: "user", content }] });
  // The lead's own session: the director of run_1, which speaks for the build in the chat.
  const lead = (id: number, parts: unknown[]) =>
    custom(id, "delegated.codex", {
      delegationId: "lead",
      role: "planner",
      runId: "run_1",
      kind: "assistant",
      data: { parts },
    });
  const log = [
    custom(1, "run_started", { runId: "run_1", project: "plaza" }),
    lead(2, [{ type: "tool_use", id: "start", name: "worker_start", input: { id: "sky" } }]),
    // Sent mid-build: saved and handed to the lead in one receipt.
    user(3, "is the sky dusk yet?"),
    custom(4, "coordinator_message_queued", { messageId: "m", action: { text: "is the sky dusk yet?" } }),
    custom(5, "coordinator_message_delivered", { messageId: "m", into: "run_1", how: "lead" }),
    custom(6, "run_steering", { runId: "run_1", text: "is the sky dusk yet?", sourceMessageId: "m" }),
    lead(7, [{ type: "text", text: "Not yet: the sky worker is on its first round." }]),
  ];
  assert.equal(messageQueueState(log).messages.get("m")?.state, "delivered");
  assert.deepEqual(
    deliveryOrder(log).map((e) => Number(e.id)),
    [1, 2, 4, 3, 5, 6, 7],
    "where it was delivered: at once, never below the build",
  );
  const entries = conversationEntries(toEntries(deliveryOrder(log)));
  assert.deepEqual(
    entries.map((e) => e.kind),
    ["work", "user", "assistant"],
  );
  assert.equal(entries[2]!.kind === "assistant" && entries[2]!.text, "Not yet: the sky worker is on its first round.");
  // Current until its run closes, then settled like any answered message.
  let state = chatContext([], log);
  assert.equal(messageQueueState(state).messages.get("m")?.state, "delivered");
  state = chatContext(state, [custom(8, "run_finished", { runId: "run_1" }), user(9, "thanks")]);
  assert.equal(messageQueueState(state).messages.has("m"), false, "settled with the run it was handed to");
  assert.equal(
    state.some((e) => e.id === "000003"),
    false,
  );
});

test("a finished compaction stays in the chat as its own row, never folded into the work around it, and opens to its summary", () => {
  const summary = "We're building Island Angler. Next: bigger waves.";
  const entries = toEntries([
    event(1, { type: "messages", messages: [{ role: "user", content: "Make the waves bigger" }] }),
    custom(2, CustomEvent.Compacted, { summary, messages: 42, trigger: "auto", upTo: "000001" }),
    event(3, { type: "messages", messages: [{ role: "assistant", content: "The waves are taller now." }] }),
  ]);
  const compaction = entries.find((entry) => entry.kind === EntryKind.Compaction);
  assert.deepEqual(compaction && { messages: compaction.messages, summary: compaction.summary }, {
    messages: 42,
    summary,
  });
  assert.ok(
    !entries.some((entry) => entry.kind === EntryKind.Activity),
    "nothing about the compaction is folded into a work row",
  );
  assert.equal(compactedWords(42), "Compacted 42 messages");
  assert.equal(compactedWords(1), "Compacted 1 message");
  assert.equal(compactedWords(undefined), "Compacted the conversation");
});
