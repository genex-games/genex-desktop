/**
 * The chat's usage analytics (plan §1.5): what a send, a card, a Stop or a rewind sends, and what
 * the log's records and main's events become once paired in memory. Every property is a kind, a
 * switch, a count, a bucket or a duration from the injected clock: never the words, a path, a name
 * the person chose or an id.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStore } from "zustand/vanilla";
import { ChatActivityPhase } from "../../src/shared/chat-activity.ts";
import type { RewindFiles } from "../../src/shared/chat-rewind.ts";
import { PlanReviewState } from "../../src/shared/composer.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { EngineKind } from "../../src/shared/engine-descriptor.ts";
import { EngineFailureKind } from "../../src/shared/engine-requests.ts";
import { ToolCategory } from "../../src/shared/eval-lane.ts";
import { type EventData, type EventEnvelope, EventKind } from "../../src/shared/event-log.ts";
import { SteerDelivery } from "../../src/shared/message-queue.ts";
import { PermissionDecision, PermissionMode, ToolPermissionBy } from "../../src/shared/permissions.ts";
import { PluginSourceKind } from "../../src/shared/plugins.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { SendPlacement } from "../../src/renderer/chat/pending-sends.ts";
import {
  AFTER_STOP_MS,
  type ChatMemory,
  createChatMemory,
  noteComposed,
  noteRewound,
  noteStop,
  takeComposedFiles,
} from "../../src/renderer/analytics/chat-memory.ts";
import { chatObservers, type SendEvent } from "../../src/renderer/analytics/chat-observe.ts";
import {
  chatHistoryFacts,
  engineRef,
  hoursBucket,
  messagesBack,
  modelPickedProperties,
  modelRef,
  namesOwnModel,
  noteMessageSent,
  permissionAnsweredProperties,
  planAnsweredProperties,
  questionAnsweredProperties,
  rewindCompletedProperties,
  rewindConfirmedProperties,
  rewindPreviewProperties,
  type SendFacts,
  sendBlockedProperties,
  stopRequestedProperties,
} from "../../src/renderer/analytics/chat-properties.ts";
import {
  CardSettledBy,
  ComposerRoom,
  ContextBucket,
  HoursBucket,
  LeftTo,
  PlanAction,
  QuestionVia,
  RewindFilesState,
  SendBlock,
  SendRoute,
  SendSource,
  SignInFrom,
  StopEndedBy,
  StopIgnored,
  StopVia,
  TurnOutcome,
  TurnStatus,
  WaitingCardKind,
} from "../../src/renderer/analytics/chat-vocabulary.ts";
import { ChatEvent, sendQuestionAnswer } from "../../src/renderer/analytics/events/chat.ts";
import { CharsBucket, CountBucket, type EventProperties } from "../../src/renderer/analytics/properties.ts";

const T0 = Date.parse("2026-10-27T10:00:00.000Z");
const THREAD = "thread-7f3a9c";

/** Words, paths, names and ids a person or the agent wrote: none may leave in a property. */
const HOSTILE = [
  "/Users/alice/Secret Game",
  "C:\\Users\\alice\\game",
  "file:///Users/alice/x.png#frag",
  "Alice Smith's Kart",
  "make the boss harder and add my phone 555-0199",
  "rm -rf /Users/alice/Secret Game",
  "mcp__alices_server__send_mail",
  "my-own-ollama-tag:latest",
  "http://10.0.0.7:1234/v1",
  "Claude wants to run npm install in /Users/alice",
  "Could not answer this message: ENOENT /Users/alice/x",
  THREAD,
  "req-9d1e",
  "consent-44ab",
  "msg-c1d2",
  "review-77",
];

interface Sent {
  event: string;
  properties: EventProperties;
}

function recorder(): { sent: Sent[]; send: SendEvent } {
  const sent: Sent[] = [];
  const send: SendEvent = (event, properties) => {
    sent.push({ event, properties });
  };
  return { sent, send };
}

/** Every string a property holds, arrays included. */
function strings(properties: EventProperties): string[] {
  return Object.values(properties).flatMap((value) => {
    if (typeof value === "string") return [value];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  });
}

/** Nothing hostile leaves, whole or in part. */
function assertClean(sent: readonly Sent[]): void {
  for (const { event, properties } of sent)
    for (const value of strings(properties))
      for (const hostile of HOSTILE) assert.ok(!value.includes(hostile), `${event} leaks ${JSON.stringify(value)}`);
}

const iso = (at: number): string => new Date(at).toISOString();
let serial = 0;
function record(data: EventData, at: number, thread = THREAD): EventEnvelope {
  serial += 1;
  return {
    id: `ev-${String(serial).padStart(6, "0")}`,
    thread_id: thread,
    session_id: null,
    turn_id: null,
    created_at: iso(at),
    data,
  };
}
const custom = (event_type: string, payload: unknown, at: number, thread = THREAD): EventEnvelope =>
  record({ type: EventKind.Custom, event_type, payload }, at, thread);
const userMessage = (content: string, at: number): EventEnvelope =>
  record({ type: EventKind.Messages, messages: [{ role: "user", content }] }, at);

/** Observers over a fresh memory and a clock the test moves. */
function hearing() {
  const memory = createChatMemory();
  const clock = { now: T0 };
  const { sent, send } = recorder();
  const observers = chatObservers(memory, () => clock.now, send);
  const log = (event: EventEnvelope): void => observers.log?.(event);
  const ui = (event: UiEvent): void => observers.ui?.(event);
  return { memory, clock, sent, send, log, ui, observers };
}

function facts(overrides: Partial<SendFacts> = {}): SendFacts {
  return {
    thread: THREAD,
    clientId: "msg-c1d2",
    room: ComposerRoom.Game,
    route: SendRoute.Chat,
    placement: SendPlacement.Transcript,
    source: SendSource.Composer,
    permissionMode: PermissionMode.Auto,
    key: `${EngineId.ClaudeCode}::claude-opus-4-1`,
    engineKind: EngineKind.Delegated,
    effort: "high",
    loop: { on: true, hours: 3 },
    planReview: false,
    pictures: 1,
    files: 2,
    mentions: 0,
    text: HOSTILE[4] ?? "",
    events: [],
    chatWorking: false,
    ...overrides,
  };
}

describe("message_sent", () => {
  it("says how the message went and into what chat, never its words", () => {
    const memory = createChatMemory();
    const events = [
      userMessage("first idea", T0 - 60_000),
      record({ type: EventKind.TurnEnded, status: "ok" }, T0 - 20_000),
    ];
    const sent = noteMessageSent(memory, facts({ events }), T0);
    assert.deepEqual(sent, {
      room: ComposerRoom.Game,
      route: SendRoute.Chat,
      placement: SendPlacement.Transcript,
      source: SendSource.Composer,
      permission_mode: PermissionMode.Auto,
      engine: EngineId.ClaudeCode,
      engine_kind: EngineKind.Delegated,
      model: "claude-opus-4-1",
      effort: "high",
      loop_on: true,
      loop_hours_bucket: HoursBucket.Few,
      plan_review: false,
      pictures: 1,
      files: 2,
      mentions: 0,
      chars_bucket: CharsBucket.Medium,
      user_message_index: 2,
      is_first_in_game: false,
      chat_working: false,
      after_rewind: false,
      after_stop: false,
      repeats_previous: false,
      think_time_ms: 20_000,
    });
    assertClean([{ event: ChatEvent.MessageSent, properties: sent }]);
  });

  it("marks the first message of a game, a repeat, and sends right after a rewind or a Stop", () => {
    const memory = createChatMemory();
    assert.equal(noteMessageSent(memory, facts(), T0).is_first_in_game, true);
    assert.equal(noteMessageSent(memory, facts({ room: ComposerRoom.Studio }), T0).is_first_in_game, false);
    const said = [userMessage("  Make it   RED ", T0 - 5000)];
    assert.equal(noteMessageSent(memory, facts({ events: said, text: "make it red" }), T0).repeats_previous, true);
    noteRewound(memory, THREAD);
    noteStop(memory, THREAD, T0);
    const after = noteMessageSent(memory, facts(), T0 + AFTER_STOP_MS);
    assert.deepEqual([after.after_rewind, after.after_stop], [true, true]);
    const later = noteMessageSent(memory, facts(), T0 + AFTER_STOP_MS + 1);
    assert.deepEqual([later.after_rewind, later.after_stop], [false, false]);
  });

  it("names catalog models only: a model the person or their server named is custom", () => {
    const table: Array<[string | null, string, string]> = [
      [`${EngineId.ClaudeCode}::claude-sonnet-4-5`, EngineId.ClaudeCode, "claude-sonnet-4-5"],
      [`${EngineId.OpenRouter}::vendor/model:free`, EngineId.OpenRouter, "vendor/model:free"],
      [`${EngineId.Codex}::default`, EngineId.Codex, "default"],
      [`${EngineId.ClaudeCode}::/Users/alice/model`, EngineId.ClaudeCode, "custom"],
      [`${EngineId.OpenRouter}::Alice Smith's Kart`, EngineId.OpenRouter, "custom"],
      [`${EngineId.Ollama}::my-own-ollama-tag:latest`, EngineId.Ollama, "custom"],
      [`${EngineId.LocalServer}::http://10.0.0.7:1234/v1`, EngineId.LocalServer, "custom"],
      ["mcp__alices_server__send_mail::x", "other", "custom"],
      [null, "none", "none"],
    ];
    for (const [key, engine, model] of table) {
      assert.equal(engineRef(key?.split("::")[0]), engine, `${key}`);
      assert.equal(modelRef(key), model, `${key}`);
    }
    assert.equal(namesOwnModel(`${EngineId.Ollama}::mine`), true);
    assert.equal(namesOwnModel(`${EngineId.ClaudeCode}::claude-opus-4-1`), false);
  });

  it("buckets a Loop's hours and keeps only an effort from the app's own scale", () => {
    assert.deepEqual(
      [
        hoursBucket({ on: false, hours: 3 }),
        hoursBucket({ on: true, hours: null }),
        hoursBucket({ on: true, hours: 0.5 }),
        hoursBucket({ on: true, hours: 4 }),
        hoursBucket({ on: true, hours: 8 }),
        hoursBucket({ on: true, hours: 12 }),
      ],
      [HoursBucket.None, HoursBucket.None, HoursBucket.One, HoursBucket.Few, HoursBucket.Several, HoursBucket.Long],
    );
    const sent = noteMessageSent(createChatMemory(), facts({ effort: "Alice Smith's Kart" }), T0);
    assert.equal("effort" in sent, false);
  });

  it("counts the files its own composer attached, once", () => {
    const memory = createChatMemory();
    noteComposed(memory, THREAD, 3);
    assert.equal(takeComposedFiles(memory, "another-chat"), 0);
    noteComposed(memory, THREAD, 3);
    assert.equal(takeComposedFiles(memory, THREAD), 3);
    assert.equal(takeComposedFiles(memory, THREAD), 0);
  });

  it("reads the chat's history without leaving its words", () => {
    const events = [userMessage(HOSTILE[0] ?? "", T0 - 10), userMessage(HOSTILE[4] ?? "", T0 - 5)];
    assert.deepEqual(chatHistoryFacts(events, HOSTILE[4] ?? "", T0), { userMessages: 2, repeatsPrevious: true });
    assert.deepEqual(chatHistoryFacts([], "", T0), { userMessages: 0, repeatsPrevious: false });
  });
});

describe("a dead Send", () => {
  it("counts presses in a row until a message goes", () => {
    const memory = createChatMemory();
    const blocked = { reason: SendBlock.NoModel, room: ComposerRoom.Home, key: null };
    assert.equal(sendBlockedProperties(memory, blocked).attempts_in_row, 1);
    const again = sendBlockedProperties(memory, { ...blocked, key: `${EngineId.Ollama}::my-own-ollama-tag:latest` });
    assert.deepEqual(again, {
      reason: SendBlock.NoModel,
      room: ComposerRoom.Home,
      engine: EngineId.Ollama,
      attempts_in_row: 2,
    });
    noteMessageSent(memory, facts(), T0);
    assert.equal(sendBlockedProperties(memory, blocked).attempts_in_row, 1);
  });
});

describe("the reply a send waits for", () => {
  it("pairs the queue wait, the first activity and the first token with the send, by clock", () => {
    const { memory, clock, sent, log, ui } = hearing();
    noteMessageSent(memory, facts(), T0);
    clock.now = T0 + 1500;
    ui({ type: UiEvent.CoordinatorProcessing, payload: { threadId: THREAD, messageId: "msg-c1d2" } });
    log(custom(CustomEvent.SessionActivity, { phase: ChatActivityPhase.Thinking, label: HOSTILE[9] }, T0 + 2000));
    clock.now = T0 + 4000;
    ui({ type: UiEvent.ChatDelta, payload: { threadId: THREAD, streamId: "s-1", delta: HOSTILE[4] } });
    ui({ type: UiEvent.ChatDelta, payload: { threadId: THREAD, streamId: "s-1", delta: "more" } });
    assert.deepEqual(sent, [
      { event: ChatEvent.MessageQueueWaited, properties: { queue_wait_ms: 1500, placement: SendPlacement.Transcript } },
      {
        event: ChatEvent.ReplyFirstTokenReceived,
        properties: {
          first_token_ms: 4000,
          first_activity_ms: 2000,
          from_processing_ms: 2500,
          first_phase: ChatActivityPhase.Thinking,
          engine: EngineId.ClaudeCode,
          engine_kind: EngineKind.Delegated,
          is_first_in_game: true,
        },
      },
    ]);
  });

  it("does not take the words of a stream already under way as the next message's answer", () => {
    const { memory, clock, sent, ui } = hearing();
    ui({ type: UiEvent.ChatStreamStarted, payload: { threadId: THREAD, streamId: "old", afterEventId: null } });
    noteMessageSent(memory, facts(), T0);
    clock.now = T0 + 300;
    ui({ type: UiEvent.ChatDelta, payload: { threadId: THREAD, streamId: "old", delta: "x" } });
    assert.equal(sent.length, 0);
    ui({ type: UiEvent.ChatStreamEnded, payload: { threadId: THREAD, streamId: "old" } });
    clock.now = T0 + 900;
    ui({ type: UiEvent.ChatStreamStarted, payload: { threadId: THREAD, streamId: "new", afterEventId: null } });
    assert.deepEqual(
      sent.map((item) => [item.event, item.properties.first_token_ms]),
      [[ChatEvent.ReplyFirstTokenReceived, 900]],
    );
  });
});

describe("chat_turn_ended", () => {
  it("times a chat turn from its records and says how it ended", () => {
    const { memory, sent, log, ui } = hearing();
    memory.engineKinds.set(EngineId.Ollama, EngineKind.Direct);
    log(record({ type: EventKind.TurnStarted, metadata: { engine: EngineId.Ollama, model: HOSTILE[7] } }, T0));
    ui({ type: UiEvent.ChatStreamStarted, payload: { threadId: THREAD, streamId: "s", afterEventId: null } });
    ui({ type: UiEvent.ChatStreamEnded, payload: { threadId: THREAD, streamId: "s", failed: true } });
    log(
      custom(
        CustomEvent.CompletionCall,
        { ok: false, failure: EngineFailureKind.RateLimit, engine: EngineId.Ollama },
        T0 + 10,
      ),
    );
    log(
      record(
        { type: EventKind.TurnEnded, status: "error", metadata: { outcome: TurnOutcome.EngineLimited } },
        T0 + 42_000,
      ),
    );
    assert.deepEqual(sent, [
      {
        event: ChatEvent.ChatTurnEnded,
        properties: {
          status: TurnStatus.Error,
          outcome: TurnOutcome.EngineLimited,
          interrupted: false,
          duration_ms: 42_000,
          engine: EngineId.Ollama,
          engine_kind: EngineKind.Direct,
          streamed: true,
          stream_failed: true,
          failure_kind: EngineFailureKind.RateLimit,
          // A direct engine's failed call that was a limit is the limit the turn ended on.
          limit_kind: EngineFailureKind.RateLimit,
          launched_build: false,
        },
      },
    ]);
    assert.equal(memory.lastFailureAt, T0 + 42_000);
  });

  it("leaves a build's turns out, counts a restart's interrupted close, and never sends an unknown outcome", () => {
    const { sent, log } = hearing();
    log(record({ type: EventKind.TurnStarted, metadata: { engine: EngineId.Codex, runId: "run-1" } }, T0));
    log(record({ type: EventKind.TurnEnded, status: "ok" }, T0 + 5));
    log(record({ type: EventKind.TurnEnded, status: "error", metadata: { interrupted: true } }, T0 + 6));
    log(record({ type: EventKind.TurnStarted, metadata: { engine: EngineId.Codex } }, T0 + 7));
    log(record({ type: EventKind.TurnEnded, metadata: { outcome: HOSTILE[10] } }, T0 + 9));
    assert.deepEqual(
      sent.map((item) => [item.properties.status, item.properties.outcome, item.properties.interrupted]),
      [
        [TurnStatus.Error, TurnOutcome.None, true],
        [TurnStatus.Ok, TurnOutcome.Other, false],
      ],
    );
    assertClean(sent);
  });
});

describe("Stop", () => {
  it("says what was going on when Stop was pressed", () => {
    const memory = createChatMemory();
    memory.turns.set(THREAD, { at: T0, engine: EngineId.ClaudeCode, streamed: true, streamFailed: false });
    memory.streams.set(THREAD, "s");
    memory.cards.set("req-9d1e", { thread: THREAD, kind: WaitingCardKind.Permission, at: T0 });
    const stop = { thread: THREAD, via: StopVia.Escape, ignored: StopIgnored.None, buildRunning: true };
    assert.deepEqual(stopRequestedProperties(memory, stop, T0 + 7000), {
      via: StopVia.Escape,
      turn_age_ms: 7000,
      streaming: true,
      waiting_card: WaitingCardKind.Permission,
      build_running: true,
      ignored: StopIgnored.None,
    });
    const padded = { thread: undefined, via: StopVia.Button, ignored: StopIgnored.SendPad, buildRunning: false };
    assert.deepEqual(stopRequestedProperties(memory, padded, T0), {
      via: StopVia.Button,
      streaming: false,
      waiting_card: WaitingCardKind.None,
      build_running: false,
      ignored: StopIgnored.SendPad,
    });
  });

  it("settles when the stopped work records its end after the press, once", () => {
    const { memory, sent, log } = hearing();
    noteStop(memory, THREAD, T0);
    log(record({ type: EventKind.TurnEnded, status: "ok" }, T0 - 50));
    assert.equal(sent.length, 0);
    log(custom(CustomEvent.RunFinished, { runId: "run-1" }, T0 + 1200));
    log(record({ type: EventKind.TurnEnded, status: "cancelled" }, T0 + 1300));
    assert.deepEqual(sent, [
      { event: ChatEvent.ChatStopSettled, properties: { latency_ms: 1200, ended_by: StopEndedBy.RunFinished } },
    ]);
  });
});

describe("cards that wait on the person", () => {
  it("asks for a permission by the tool's kind, and counts a card the work closed unanswered", () => {
    const { clock, sent, log } = hearing();
    const request = {
      requestId: "req-9d1e",
      project: HOSTILE[3],
      threadId: THREAD,
      tool: "Bash",
      title: HOSTILE[9],
      subject: HOSTILE[5],
      reason: HOSTILE[10],
      input: { command: HOSTILE[5] },
      always: [{ kind: "rule", rule: HOSTILE[5] }],
      state: "pending",
    };
    log(custom(CustomEvent.ToolPermission, request, T0));
    clock.now = T0 + 90_000;
    log(custom(CustomEvent.ToolPermission, { ...request, state: "denied", by: ToolPermissionBy.Stop }, T0 + 90_000));
    assert.deepEqual(sent, [
      {
        event: ChatEvent.PermissionRequested,
        properties: {
          tool_category: ToolCategory.Shell,
          is_plan: false,
          from_worker: false,
          from_subagent: false,
          always_offered: true,
          cards_waiting: 0,
        },
      },
      {
        event: ChatEvent.CardSettledWithoutAnswer,
        properties: { card: WaitingCardKind.Permission, by: CardSettledBy.Stop, wait_ms: 90_000 },
      },
    ]);
    assertClean(sent);
  });

  it("sends nothing more for a card the person answered", () => {
    const { sent, log } = hearing();
    const request = {
      requestId: "req-1",
      threadId: THREAD,
      tool: "ExitPlanMode",
      plan: HOSTILE[4],
      input: {},
      state: "pending",
    };
    log(custom(CustomEvent.ToolPermission, request, T0));
    log(custom(CustomEvent.ToolPermission, { ...request, state: "allowed", by: ToolPermissionBy.User }, T0 + 5));
    assert.deepEqual(
      sent.map((item) => [item.event, item.properties.is_plan]),
      [[ChatEvent.PermissionRequested, true]],
    );
  });

  it("names a consent card's plugin only when a catalog ships it", () => {
    const { sent, log, observers } = hearing();
    const plugins = createStore(() => ({
      list: [
        { manifest: { id: "alices-mailer" }, source: PluginSourceKind.Local },
        { manifest: { id: "genex" }, source: PluginSourceKind.Bundled },
      ],
    }));
    const stop = observers.start?.({
      engines: createStore(() => ({ list: [] })),
      plugins,
      threads: createStore(() => ({ activeThreadId: THREAD })),
    } as never);
    for (const [consentId, pluginId] of [
      ["consent-44ab", "alices-mailer"],
      ["consent-2", "genex"],
    ] as const) {
      const card = {
        consentId,
        pluginId,
        pluginName: HOSTILE[3],
        tool: "send",
        args: {},
        project: "p",
        prompt: HOSTILE[4],
      };
      log(custom(CustomEvent.PluginConsent, { ...card, state: "pending" }, T0));
      log(custom(CustomEvent.PluginConsent, { ...card, state: "declined", by: "timeout" }, T0 + 30_000));
    }
    stop?.();
    assert.deepEqual(
      sent.map((item) => item.properties),
      [
        { card: WaitingCardKind.Consent, by: CardSettledBy.Timeout, wait_ms: 30_000, plugin_ref: "local" },
        { card: WaitingCardKind.Consent, by: CardSettledBy.Timeout, wait_ms: 30_000, plugin_ref: "genex" },
      ],
    );
  });

  it("closes an agent's question with an answer, a newer question or the person's own message", () => {
    const { memory, sent, log } = hearing();
    const asked = (at: number) =>
      custom(
        CustomEvent.InterviewQuestion,
        {
          question: HOSTILE[4],
          choices: [
            { id: "a", label: HOSTILE[3] },
            { id: "b", label: "x" },
          ],
        },
        at,
      );
    log(asked(T0));
    log(asked(T0 + 1000));
    log(userMessage(HOSTILE[4] ?? "", T0 + 3000));
    log(asked(T0 + 4000));
    const answer = questionAnsweredProperties(memory, { thread: THREAD, via: QuestionVia.Choice, index: 0 }, T0 + 6000);
    log(userMessage("a", T0 + 6100));
    assert.deepEqual(answer, { via: QuestionVia.Choice, choice_index: 0, picked_recommended: true, wait_ms: 2000 });
    assert.deepEqual(
      sent.map((item) => [item.event, item.properties.by ?? item.properties.choices]),
      [
        [ChatEvent.ChatQuestionAsked, 2],
        [ChatEvent.CardSettledWithoutAnswer, CardSettledBy.NewQuestion],
        [ChatEvent.ChatQuestionAsked, 2],
        [ChatEvent.CardSettledWithoutAnswer, CardSettledBy.ComposerMessage],
        [ChatEvent.ChatQuestionAsked, 2],
      ],
    );
    assertClean(sent);
  });

  it("counts an answer once it was sent, once per question, and not when its send failed", async () => {
    const { memory, clock, sent, send, log } = hearing();
    const options = { memory, now: () => clock.now, send };
    const asked = (at: number) =>
      custom(CustomEvent.InterviewQuestion, { question: HOSTILE[4], choices: [{ id: "a", label: "x" }] }, at);
    const answered = () => sent.filter((item) => item.event === ChatEvent.ChatQuestionAnswered);
    log(asked(T0));
    clock.now = T0 + 2000;
    const failing = sendQuestionAnswer(
      { thread: THREAD, via: QuestionVia.OwnWords },
      async () => {
        assert.equal(answered().length, 0, "nothing is counted before the send went");
        throw new Error("send failed");
      },
      options,
    );
    await assert.rejects(failing, /send failed/);
    assert.equal(answered().length, 0, "a failed send is no answer");
    const delivered: string[] = [];
    const answer = { thread: THREAD, via: QuestionVia.Choice, index: 1 };
    await sendQuestionAnswer(answer, async () => void delivered.push("first"), options);
    // Pressed again (a sign-in held the first back): the same answer, sent again, counted once.
    await sendQuestionAnswer(answer, async () => void delivered.push("again"), options);
    assert.deepEqual(delivered, ["first", "again"]);
    assert.deepEqual(
      answered().map((item) => item.properties),
      [{ via: QuestionVia.Choice, choice_index: 1, picked_recommended: false, wait_ms: 2000 }],
    );
    // The answer closes the question; the next question's answer counts again.
    log(userMessage("x", T0 + 2100));
    log(asked(T0 + 3000));
    await sendQuestionAnswer({ thread: THREAD, via: QuestionVia.OwnWords }, async () => undefined, options);
    assert.equal(answered().length, 2);
    await sendQuestionAnswer({ thread: undefined, via: QuestionVia.OwnWords }, async () => undefined, options);
    assert.equal(answered().length, 2, "a chat with no thread yet counts nothing");
    assertClean(sent);
  });

  it("counts leaving a chat while a card waits, and where to", () => {
    const { clock, sent, log, observers } = hearing();
    const threads = createStore(() => ({ activeThreadId: THREAD as string | null }));
    const stop = observers.start?.({
      engines: createStore(() => ({ list: [] })),
      plugins: createStore(() => ({ list: [] })),
      threads,
    } as never);
    log(custom(CustomEvent.PlanReview, { id: "review-77", state: PlanReviewState.Waiting, text: HOSTILE[4] }, T0));
    sent.length = 0;
    clock.now = T0 + 45_000;
    threads.setState({ activeThreadId: null });
    threads.setState({ activeThreadId: "other-chat" });
    stop?.();
    assert.deepEqual(sent, [
      {
        event: ChatEvent.ChatLeftWhileWaiting,
        properties: { card: WaitingCardKind.Plan, wait_ms: 45_000, to: LeftTo.Home, cards_waiting: 1 },
      },
    ]);
  });

  it("answers a permission by its decision, never the words for Claude", () => {
    const deny = { decision: PermissionDecision.Deny, message: HOSTILE[4] } as const;
    assert.deepEqual(permissionAnsweredProperties(deny, { resolved: false, waitMs: 3000 }), {
      decision: PermissionDecision.Deny,
      with_message: true,
      wait_ms: 3000,
      resolved: false,
    });
    const plan = { decision: PermissionDecision.ApprovePlan, mode: PermissionMode.AcceptEdits } as const;
    assert.deepEqual(permissionAnsweredProperties(plan, { resolved: true, waitMs: undefined }), {
      decision: PermissionDecision.ApprovePlan,
      with_message: false,
      plan_mode: PermissionMode.AcceptEdits,
      resolved: true,
    });
  });
});

describe("plans", () => {
  it("times writing a plan, counts its revisions and how long it waited for an answer", () => {
    const { memory, sent, log } = hearing();
    const review = (state: string, at: number) =>
      custom(
        CustomEvent.PlanReview,
        { id: "review-77", state, text: HOSTILE[4], plan: HOSTILE[4], error: HOSTILE[10] },
        at,
      );
    log(review(PlanReviewState.Generating, T0));
    log(review(PlanReviewState.Waiting, T0 + 30_000));
    log(review(PlanReviewState.Generating, T0 + 40_000));
    log(review(PlanReviewState.Failed, T0 + 55_000));
    const answered = planAnsweredProperties(
      memory,
      { review: "review-77", action: PlanAction.Dismiss, refused: false },
      T0 + 60_000,
    );
    log(review(PlanReviewState.Cancelled, T0 + 61_000));
    assert.deepEqual(
      sent.map((item) => item.properties),
      [
        { state: PlanReviewState.Waiting, generation_ms: 30_000, revision_index: 0 },
        { state: PlanReviewState.Failed, generation_ms: 15_000, revision_index: 1 },
        { state: PlanReviewState.Cancelled, revision_index: 1 },
      ],
    );
    assert.deepEqual(answered, { action: PlanAction.Dismiss, wait_ms: 5000, refused: false });
    assert.equal(memory.lastFailureAt, T0 + 55_000);
  });
});

describe("what else the log says", () => {
  it("maps sign-ins, fallbacks, compactions, steering and failed answers to the app's own codes", () => {
    const { memory, clock, sent, log, ui } = hearing();
    noteMessageSent(memory, facts({ clientId: "msg-c1d2" }), T0);
    log(custom(CustomEvent.NeedsSignin, { engine: EngineId.Codex, message: HOSTILE[10] }, T0));
    log(
      custom(
        CustomEvent.EngineFallback,
        { from: EngineId.ClaudeCode, to: HOSTILE[7], kind: EngineFailureKind.UsageLimit },
        T0,
      ),
    );
    ui({ type: UiEvent.ContextUsage, payload: { threadId: THREAD, percent: 91, model: HOSTILE[7] } });
    log(custom(CustomEvent.CompactionFailed, { trigger: "manual", error: HOSTILE[10] }, T0));
    log(custom(CustomEvent.Compacted, { trigger: HOSTILE[3], native: true, summary: HOSTILE[4] }, T0));
    log(custom(CustomEvent.CoordinatorMessageSteering, { messageId: "msg-9" }, T0));
    log(custom(CustomEvent.CoordinatorMessageDelivered, { messageId: "msg-9", how: SteerDelivery.Native }, T0 + 800));
    log(custom(CustomEvent.CoordinatorMessageRequeued, { messageId: "msg-10" }, T0 + 900));
    clock.now = T0 + 2000;
    log(custom(CustomEvent.CoordinatorMessageHandled, { messageId: "msg-c1d2", failed: true }, T0 + 2000));
    assert.deepEqual(
      sent.map((item) => [item.event, item.properties]),
      [
        [ChatEvent.ChatSignInNeeded, { engine: EngineId.Codex, from: SignInFrom.Turn }],
        [ChatEvent.EngineFellBack, { from: EngineId.ClaudeCode, to: "other", kind: EngineFailureKind.UsageLimit }],
        [
          ChatEvent.ChatContextCompacted,
          { trigger: "manual", native: false, failed: true, percent_before_bucket: ContextBucket.Full },
        ],
        [ChatEvent.ChatContextCompacted, { trigger: "other", native: true, failed: false }],
        [ChatEvent.MessageSteered, { how: SteerDelivery.Native, requeued: false, steer_wait_ms: 800 }],
        [ChatEvent.MessageSteered, { requeued: true }],
        [ChatEvent.MessageAnswerFailed, { engine: EngineId.ClaudeCode }],
      ],
    );
    assertClean(sent);
  });
});

describe("rewind", () => {
  it("says what the files would do without naming them, and whether the default was changed", () => {
    const files: RewindFiles = {
      state: "restore",
      files: 4,
      outside: [HOSTILE[0] ?? "", HOSTILE[1] ?? ""],
      outsideUnknown: false,
      tooLarge: 0,
      nested: [HOSTILE[2] ?? ""],
    };
    const preview = rewindPreviewProperties({ files, stopsBuild: true });
    assert.deepEqual(preview, {
      files_state: RewindFilesState.Restore,
      files_bucket: CountBucket.Few,
      outside_changes: 2,
      stops_build: true,
    });
    assert.deepEqual(rewindPreviewProperties(null), {
      files_state: RewindFilesState.Refused,
      stops_build: false,
      code: null,
    });
    assert.deepEqual(
      rewindPreviewProperties({
        files: { state: "unavailable", reason: "too-large", tooLargeFiles: [HOSTILE[0] ?? ""] },
        stopsBuild: false,
      }),
      { files_state: RewindFilesState.Unavailable, files_stay_reason: "too-large", stops_build: false },
    );
    assert.deepEqual(rewindConfirmedProperties(files, { restore: true, restoresByDefault: false, failed: false }), {
      action: "confirm",
      restore_files: true,
      default_overridden: true,
      failed: false,
    });
    assert.deepEqual(
      rewindConfirmedProperties({ state: "none" }, { restore: true, restoresByDefault: true, failed: true }),
      {
        action: "confirm",
        restore_files: false,
        default_overridden: false,
        failed: true,
        code: null,
      },
    );
    assertClean([{ event: ChatEvent.RewindPreviewed, properties: preview }]);
  });

  it("counts what came back and the messages a rewind takes out", () => {
    const result = {
      text: HOSTILE[4] ?? "",
      messageId: "msg-c1d2",
      imageCount: 1,
      pickedImages: 1,
      files: 7,
      held: [{ messageId: "m2", pickedImages: 0 }],
      undo: { rewindId: "x-0000000a" },
    };
    assert.deepEqual(rewindCompletedProperties(result), {
      files_restored_bucket: CountBucket.Several,
      held_followups: 1,
      undo_offered: true,
    });
    const target = userMessage("a", T0);
    const events = [
      userMessage("before", T0 - 1),
      target,
      record({ type: EventKind.TurnEnded }, T0 + 1),
      userMessage("b", T0 + 2),
    ];
    assert.equal(messagesBack(events, target.id), 2);
    assert.equal(messagesBack(events, "gone"), 0);
  });
});

describe("model picks", () => {
  it("says the engine and catalog model, the engine before, and a pick right after a failure", () => {
    const memory: ChatMemory = createChatMemory();
    memory.lastFailureAt = T0 - 60_000;
    const pick = {
      key: `${EngineId.Ollama}::my-own-ollama-tag:latest`,
      previousKey: `${EngineId.ClaudeCode}::opus`,
      free: true,
      engineKind: EngineKind.Direct,
    };
    assert.deepEqual(modelPickedProperties(memory, pick, T0), {
      engine: EngineId.Ollama,
      engine_kind: EngineKind.Direct,
      model: "custom",
      previous_engine: EngineId.ClaudeCode,
      changed_engine: true,
      free: true,
      local: true,
      after_failure: true,
    });
    assert.equal(modelPickedProperties(memory, pick, T0 + 10 * 60_000).after_failure, false);
  });
});
