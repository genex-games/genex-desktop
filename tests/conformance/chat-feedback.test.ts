import { test } from "node:test";
import assert from "node:assert/strict";
import type { EventData, EventEnvelope } from "../../src/substrate/types.ts";
import { toEntries } from "../../src/renderer/chat-entries.ts";
import { chatContext } from "../../src/shared/chat-history.ts";
import { isHandoffNarration } from "../../src/shared/chat-presentation.ts";
import {
  storedChatModel,
  rememberChatModel,
  modelStoreKeys,
  storedChatEffort,
  rememberChatEffort,
} from "../../src/renderer/stored-model.ts";
import { interviewQuestion, interviewForReply } from "../../src/harness-seed/loop/interview-question.ts";
import { preparationBudgetMs, wrapReserveMs } from "../../src/harness-seed/loop/director.ts";

const event = (id: number, data: EventData): EventEnvelope => ({
  id: String(id).padStart(6, "0"),
  thread_id: "game",
  turn_id: "turn",
  session_id: null,
  created_at: new Date().toISOString(),
  data,
});
const custom = (id: number, event_type: string, payload: unknown) => event(id, { type: "custom", event_type, payload });

test("build decisions are information, never questions; learning has its own work-style disclosure", () => {
  const entries = toEntries([
    custom(1, "autopilot_decision", { plain: "The studio is building the starting point first." }),
    custom(2, "autopilot_decision", { plain: "The starting point could not be built." }),
    custom(3, "autopilot_plan_review", { summary: "One small world", waitMinutes: 0 }),
    custom(4, "skillopt_pass", { tasks: 8, staged: 1 }),
  ]);
  assert.ok(entries.every((e) => e.kind !== "action" && e.kind !== "question"));
  assert.ok(
    entries.some((e) => e.kind === "system" && e.text.includes("could not be built")),
    "failure stays visible",
  );
  assert.equal(entries.at(-1)?.kind, "learning");
});

test("real intake questions survive pagination and settle on either a choice reply or custom text", () => {
  const question = custom(
    2,
    "interview_question",
    interviewQuestion({
      question: "Where should the scene take place?",
      options: "Ashlands (Recommended) | Open terrain\nTown street | Buildings and lanterns",
    }),
  );
  const context = chatContext(
    [],
    [
      event(1, { type: "messages", messages: [{ role: "user", content: "Make a Morrowind scene" }] }),
      question,
      event(3, { type: "turn_ended", status: "ok" }),
    ],
  );
  assert.equal(toEntries(context).filter((e) => e.kind === "question" && e.pending).length, 1);
  const reply = event(4, { type: "messages", messages: [{ role: "user", content: "Actually, a coast at night" }] });
  assert.ok(
    !chatContext(context, [reply]).some((e) => e.data.type === "custom" && e.data.event_type === "interview_question"),
  );
  assert.equal(toEntries([question, reply]).find((e) => e.kind === "question")?.pending, false);
  assert.equal(
    toEntries([question, custom(4, "run_started", { runId: "r" })]).find((e) => e.kind === "question")?.pending,
    false,
  );
  assert.throws(() => interviewQuestion({ question: " " }));
});

test("host handoff diagnostics disappear while ordinary explanations and errors remain", () => {
  const technical =
    "**test-4** (folder `AI Games/test-4`) — Claude Code (opus) · medium effort conducts the build interview itself and starts the run when it has what it needs.";
  assert.equal(isHandoffNarration(technical), true);
  assert.equal(
    isHandoffNarration(
      "Claude Code (opus) · medium effort continues the build interview — same session, its context restored.",
    ),
    true,
  );
  const entries = toEntries([
    event(1, {
      type: "messages",
      messages: [
        { role: "assistant", content: technical },
        { role: "assistant", content: "The shrine now has warm lanterns." },
        { role: "assistant", content: "Could not build the starting point." },
      ],
    }),
  ]);
  assert.equal(entries.length, 2);
});

test("only the direct answer to an interview question inherits its commissioning options", () => {
  const intake = "interview_turn";
  const question = custom(1, "interview_question", { question: "Which scene?", intakeId: intake });
  const answer = event(2, { type: "messages", messages: [{ role: "user", content: "Ashlands" }] });
  assert.deepEqual(interviewForReply([question, answer]), intake);
  assert.equal(interviewForReply([question]), null);
  assert.equal(
    interviewForReply([
      question,
      answer,
      event(3, { type: "messages", messages: [{ role: "user", content: "Another message" }] }),
    ]),
    null,
  );
  assert.equal(interviewForReply([question, answer, custom(3, "run_started", { runId: "r" })]), null);
});

test("new games inherit the last model while previous conversations keep their model", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  rememberChatModel(storage, "first", "claude-code::opus");
  assert.equal(storedChatModel(storage, "new", { kind: "game" }), "claude-code::opus");
  rememberChatModel(storage, "second", "codex::gpt-5.4");
  assert.equal(storedChatModel(storage, "first", { kind: "game" }), "claude-code::opus");
  assert.equal(storedChatModel(storage, "new", { kind: "game" }), "codex::gpt-5.4");
  assert.equal(
    storedChatModel(storage, "saved", { kind: "game", lastEngine: "ollama", lastModel: "local" }),
    "ollama::local",
  );
});

test("Studio keeps its own model without changing the one new games inherit", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  rememberChatModel(storage, "game", "claude-code::opus");
  assert.equal(
    storedChatModel(storage, "studio", { kind: "studio" }),
    "claude-code::opus",
    "Studio starts from the last game pick",
  );
  rememberChatModel(storage, "studio", "codex::gpt-5.4", true);
  assert.equal(storedChatModel(storage, "studio", { kind: "studio" }), "codex::gpt-5.4");
  assert.equal(
    storedChatModel(storage, "new", { kind: "game" }),
    "claude-code::opus",
    "a Studio pick is not inherited by new games",
  );
  rememberChatModel(storage, "game", "ollama::local");
  assert.equal(
    storedChatModel(storage, "studio", { kind: "studio" }),
    "codex::gpt-5.4",
    "a game pick leaves Studio alone",
  );
  assert.notEqual(modelStoreKeys(true).effort("codex::gpt-5.4"), modelStoreKeys(false).effort("codex::gpt-5.4"));
});

test("a game chat keeps its own effort; the effort saved for a model only seeds fresh chats", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  const game = { kind: "game" } as const;
  storage.setItem(modelStoreKeys(false).effort("codex::gpt"), "medium");
  rememberChatEffort(storage, "first", "low");
  storage.setItem(modelStoreKeys(false).effort("codex::gpt"), "high");
  assert.equal(
    storedChatEffort(storage, { id: "first", meta: game }, "codex::gpt"),
    "low",
    "outlives a per-model pick",
  );
  assert.equal(storedChatEffort(storage, { id: "fresh", meta: game }, "codex::gpt"), "high");
  rememberChatEffort(storage, "first", null);
  assert.equal(
    storedChatEffort(storage, { id: "first", meta: { ...game, lastEffort: "medium" } }, "codex::gpt"),
    "medium",
    "a cleared pick falls back to the chat's last turn",
  );
  assert.equal(
    storedChatEffort(storage, { id: "studio", meta: { kind: "studio", lastEffort: "low" } }, "codex::gpt"),
    null,
    "Studio keeps only its per-model effort",
  );
});

test("preparation leaves working time in a fifteen-minute run and never enlarges its deadline", () => {
  const total = 15 * 60_000,
    soft = total - wrapReserveMs(total),
    base = preparationBudgetMs(soft);
  assert.ok(base > 0 && base <= soft / 3);
  assert.ok(soft - base >= 6 * 60_000, "the lead has working time before wrap-up");
  assert.equal(preparationBudgetMs(2 * 60_000), 0, "short remainder goes directly to the lead");
  assert.equal(preparationBudgetMs(-1), 0);
  assert.equal(preparationBudgetMs(24 * 3_600_000), 30 * 60_000);
});

test("a delegated reply reconciles on its durable row before the stream acknowledgement", async () => {
  const { replyCommitted } = await import("../../src/renderer/chat/stream-reconciliation.ts");
  const stream = { text: "The match is ready.", after: "000001" };
  assert.equal(
    replyCommitted(stream, [
      custom(2, "delegated.codex", {
        kind: "assistant",
        role: "planner",
        data: { parts: [{ type: "text", text: stream.text }] },
      }),
    ]),
    true,
  );
  assert.equal(
    replyCommitted(stream, [
      custom(2, "delegated.codex", {
        kind: "assistant",
        role: "builder",
        data: { parts: [{ type: "text", text: stream.text }] },
      }),
    ]),
    false,
  );
  assert.equal(
    replyCommitted(stream, [event(2, { type: "turn_ended", status: "ok" })]),
    false,
    "idle is not a saved reply",
  );
  assert.equal(
    replyCommitted(stream, [event(2, { type: "messages", messages: [{ role: "assistant", content: stream.text }] })]),
    true,
  );
});

test("a saved build report updates the existing reply without giving it a new entrance", () => {
  const delegated = custom(1, "delegated.codex", {
    kind: "assistant",
    role: "planner",
    data: { parts: [{ type: "text", text: "The match is ready." }] },
  });
  const before = toEntries([delegated]).find((entry) => entry.kind === "assistant");
  const after = toEntries([
    delegated,
    event(2, {
      type: "messages",
      messages: [{ role: "assistant", content: "The match is ready. The controls passed." }],
    }),
  ]).filter((entry) => entry.kind === "assistant");
  assert.equal(after.length, 1);
  assert.equal(after[0]?.id, before?.id);
  assert.ok(after[0]?.kind === "assistant");
  assert.equal(after[0].text, "The match is ready. The controls passed.");
});

test("a note sent from the Builds graph reads as the words written, named for what it was about", () => {
  const users = (events: EventEnvelope[]) =>
    toEntries(events).flatMap((e) => (e.kind === "user" ? [{ text: e.text, about: e.about }] : []));
  assert.deepEqual(
    users([
      event(1, {
        type: "messages",
        messages: [
          {
            role: "user",
            content: "[USER FEEDBACK on facet frozen, camera default, iteration 5] Make the peak twice as tall",
          },
        ],
      }),
      custom(2, "user_feedback", {
        runId: "r",
        facetId: "frozen",
        iteration: 5,
        label: "Tall mountain · try 5",
        text: "Make the peak twice as tall",
      }),
      // A note recorded before notes carried a name still loses the harness prefix.
      event(3, { type: "messages", messages: [{ role: "user", content: "[USER FEEDBACK] Warmer light everywhere" }] }),
      event(4, { type: "messages", messages: [{ role: "user", content: "[not a note] keep this" }] }),
    ]),
    [
      { text: "Make the peak twice as tall", about: "Tall mountain · try 5" },
      { text: "Warmer light everywhere", about: "Note to the build" },
      { text: "[not a note] keep this", about: undefined },
    ],
  );
});

test("the chat shows its own thinking summary, never a builder's and never an empty block", () => {
  const thought = (id: number, role: string | undefined, text: string) =>
    custom(id, "delegated.claude-code", {
      kind: "assistant",
      ...(role ? { role } : {}),
      data: { parts: [{ type: "thinking", text }] },
    });
  const entries = toEntries([
    thought(1, "planner", "The ask is research and a plan, so no build."),
    thought(2, "builder", "Maybe the jab timing is off."),
    thought(3, "planner", ""),
    // Mirrors from before roles were recorded cannot be attributed to the chat.
    thought(4, undefined, "An old builder thought."),
  ]);
  const thoughts = entries.flatMap((e) => (e.kind === "thinking" ? [e.text] : []));
  assert.deepEqual(thoughts, ["The ask is research and a plan, so no build."]);
});

test("a running web lookup says it is looking something up", () => {
  const entries = toEntries([
    custom(1, "delegated.claude-code", {
      kind: "assistant",
      role: "planner",
      delegationId: "d1",
      data: { parts: [{ type: "tool_use", id: "w1", name: "WebSearch", input: { query: "boxing game feel" } }] },
    }),
  ]);
  const rows = entries.flatMap((e) => (e.kind === "tools" ? e.rows : []));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.label, "looked something up");
  assert.equal(rows[0]!.activeLabel, "Looking something up");
});

test("a run control the host records itself is one row, and a recorded resume shows once, when it runs", () => {
  // The chat's own session after a run calls run_status live: the engine mirrors the call, and
  // the host records its own request and result (conversation.ts `coordinatorTool`).
  const mirrored = (id: number, name: string, callId: string, engine = "claude-code") =>
    custom(id, `delegated.${engine}`, {
      kind: "assistant",
      role: "planner",
      delegationId: "d1",
      data: { parts: [{ type: "tool_use", id: callId, name, input: {} }] },
    });
  const hosted = (id: number, name: string, callId: string, content: string) => [
    event(id, { type: "tool_requested", tool_call_id: callId, request: { name, arguments: { runId: "r1" } } }),
    event(id + 1, { type: "tool_result", tool_call_id: callId, result: { ok: true, content } }),
  ];
  const labels = (events: EventEnvelope[]) =>
    toEntries(events).flatMap((e) => (e.kind === "tools" ? e.rows.map((row) => row.label) : []));

  // Flipped: no time-of-day words in the app's copy.
  assert.deepEqual(
    labels([mirrored(1, "mcp__studio__run_status", "t1"), ...hosted(2, "run_status", "coord_1", "{}")]),
    ["checked on the build"],
    "one row for one call",
  );
  // Another server's tool that shares the name is not the studio's: the host records none, so it keeps its row.
  assert.equal(labels([mirrored(1, "mcp__github__run_status", "t3")]).length, 1);
  // After a paused run the session records resume_run (Codex through the bridge): nothing has
  // resumed yet. The chat resumes the run once the reply ends, and the host records it then.
  const recorded = mirrored(1, "mcp__studio__resume_run", "t2", "codex");
  assert.deepEqual(labels([recorded]), [], "a recorded resume is not a resumed build");
  assert.deepEqual(
    labels([
      recorded,
      custom(2, "turn_ended", {}),
      ...hosted(3, "resume_run", "coord_2", "Resume requested for the same run."),
    ]),
    ["resumed the saved build"],
    "shown once, when it runs",
  );
});
