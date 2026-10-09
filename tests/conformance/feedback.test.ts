/**
 * Send feedback: the sidebar's bug button posts one anonymous report to genex.games. The person's
 * words, the screen and the app and OS versions always go. Two switches add more, each on its own:
 * the app's diagnostics, and the open chat's newest events, both redacted like the studio log.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  FEEDBACK_CHAT_EVENTS,
  FEEDBACK_CHAT_MAX_CHARS,
  FEEDBACK_DIAGNOSTICS_MAX_CHARS,
  FEEDBACK_STRING_MAX_CHARS,
  FEEDBACK_URL,
  type FeedbackReport,
  type FeedbackSources,
  sendFeedback,
} from "../../src/main/feedback.ts";
import { FEEDBACK_TEXT_MAX_CHARS, FeedbackScreen } from "../../src/shared/feedback.ts";
import { type ConversationRecord, type EventEnvelope, ThreadKind } from "../../src/shared/event-log.ts";
import type { GameProject } from "../../src/shared/game-project.ts";
import { feedbackAbout } from "../../src/renderer/feedback-about.ts";
import { EventStore } from "../../src/substrate/event-store.ts";
import { tmpDir } from "../helpers/tmp.ts";

const HOME = "/Users/someone";
const KEY = "sk-ant-abcdefghijklmnop";
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;

interface Posted {
  url: string;
  init: RequestInit;
  report: FeedbackReport;
}

const DIAGNOSTICS = "Genex 1.2.3 (packaged)\nRecent log (0 lines)";

/** A sender over fakes: it records what it would post, which chats it read and whether it read the diagnostics. */
function rig({ status = HTTP_OK, events = [] as EventEnvelope[] } = {}) {
  const posted: Posted[] = [];
  const chatsRead: Array<{ threadId: string; count: number }> = [];
  const diagnosticsRead: true[] = [];
  const sources: FeedbackSources = {
    app: { version: "1.2.3", packaged: true },
    os: { platform: "darwin", release: "25.3.0", arch: "arm64" },
    home: HOME,
    diagnostics: async () => {
      diagnosticsRead.push(true);
      return DIAGNOSTICS;
    },
    chatEvents: async (threadId, count) => {
      chatsRead.push({ threadId, count });
      return events;
    },
    fetch: async (url, init = {}) => {
      posted.push({ url: String(url), init, report: JSON.parse(String(init.body)) });
      return new Response("{}", { status });
    },
  };
  return { sources, posted, chatsRead, diagnosticsRead };
}

const event = (id: string, message: string): EventEnvelope => ({
  id,
  thread_id: "thread-1",
  session_id: null,
  turn_id: null,
  created_at: "2026-10-07T10:00:00.000Z",
  data: { type: "error", message },
});

const draft = (overrides: Record<string, unknown> = {}) => ({
  text: "The stage went black after Undo",
  screen: FeedbackScreen.Chat,
  appLogs: false,
  chatId: null,
  ...overrides,
});

describe("send feedback", () => {
  it("sends only the words, the screen and the versions while both switches are off", async () => {
    const { sources, posted, chatsRead, diagnosticsRead } = rig();
    await sendFeedback(draft(), sources);
    assert.equal(posted.length, 1);
    assert.equal(posted[0]?.url, FEEDBACK_URL);
    assert.equal(posted[0]?.init.method, "POST");
    assert.deepEqual(posted[0]?.report, {
      text: "The stage went black after Undo",
      screen: FeedbackScreen.Chat,
      app: { version: "1.2.3", packaged: true },
      os: { platform: "darwin", release: "25.3.0", arch: "arm64" },
    });
    assert.deepEqual(chatsRead, [], "no chat is read");
    assert.deepEqual(diagnosticsRead, [], "the diagnostics are not read");
  });

  it("attaches the open chat's newest events alone, redacted, when only the chat is switched on", async () => {
    const events = [
      event("e1", `failed in ${HOME}/AI Games/pong`),
      event("e2", `Bearer ${KEY} from someone@example.com`),
    ];
    const { sources, posted, chatsRead, diagnosticsRead } = rig({ events });
    await sendFeedback(draft({ chatId: "thread-1" }), sources);
    assert.deepEqual(chatsRead, [{ threadId: "thread-1", count: FEEDBACK_CHAT_EVENTS }]);
    assert.deepEqual(diagnosticsRead, [], "the app's logs stay home");
    const logs = posted[0]?.report.logs;
    assert.equal(logs?.diagnostics, undefined);
    const lines = logs?.chat?.split("\n").map((line) => JSON.parse(line) as EventEnvelope) ?? [];
    assert.deepEqual(
      lines.map((line) => line.id),
      ["e1", "e2"],
      "oldest first, one event per line",
    );
    assert.doesNotMatch(logs?.chat ?? "", new RegExp(`${HOME}|${KEY}|someone@example\\.com`));
    assert.match(logs?.chat ?? "", /~\/AI Games\/pong/);
  });

  it("attaches the diagnostics alone when only app logs are switched on", async () => {
    const { sources, posted, chatsRead } = rig();
    await sendFeedback(draft({ appLogs: true, screen: FeedbackScreen.Home }), sources);
    assert.deepEqual(chatsRead, []);
    assert.deepEqual(posted[0]?.report.logs, { diagnostics: DIAGNOSTICS });
  });

  it("keeps the diagnostics' start and newest end when they are too long to send", async () => {
    const { sources, posted } = rig();
    const head = "Genex 1.2.3 (packaged)\nProviders\n";
    const tail = "\n  newest log line";
    sources.diagnostics = async () => `${head}${"l".repeat(FEEDBACK_DIAGNOSTICS_MAX_CHARS)}${tail}`;
    await sendFeedback(draft({ appLogs: true }), sources);
    const sent = posted[0]?.report.logs?.diagnostics ?? "";
    assert.ok(sent.length <= FEEDBACK_DIAGNOSTICS_MAX_CHARS, "within genex.games's cap");
    assert.ok(sent.startsWith(head), "the versions and providers stay");
    assert.ok(sent.endsWith(tail), "the newest log lines stay");
    assert.match(sent, /characters cut/);
  });

  it("attaches both when both are switched on", async () => {
    const { sources, posted } = rig({ events: [event("e1", "boom")] });
    await sendFeedback(draft({ appLogs: true, chatId: "thread-1" }), sources);
    assert.equal(posted[0]?.report.logs?.diagnostics, DIAGNOSTICS);
    assert.match(posted[0]?.report.logs?.chat ?? "", /boom/);
  });

  it("clips each long string and drops the oldest events past the size cap", async () => {
    const long = "x".repeat(FEEDBACK_STRING_MAX_CHARS + 3_000);
    const events = Array.from({ length: FEEDBACK_CHAT_EVENTS }, (_, at) => event(`e${at}`, long));
    const { sources, posted } = rig({ events });
    await sendFeedback(draft({ chatId: "thread-1" }), sources);
    const chat = posted[0]?.report.logs?.chat ?? "";
    assert.ok(chat.length <= FEEDBACK_CHAT_MAX_CHARS);
    const lines = chat.split("\n").map((line) => JSON.parse(line) as EventEnvelope);
    assert.ok(lines.length > 1 && lines.length < FEEDBACK_CHAT_EVENTS, "some fit, the oldest went");
    assert.equal(lines.at(-1)?.id, `e${FEEDBACK_CHAT_EVENTS - 1}`, "the newest stays");
    const oldest = lines[0];
    assert.ok(oldest);
    assert.equal(
      (oldest.data as { message: string }).message,
      `${"x".repeat(FEEDBACK_STRING_MAX_CHARS)}… [3000 more characters]`,
    );
  });

  it("redacts a credential the clip cuts through", async () => {
    const cut = `${"y ".repeat((FEEDBACK_STRING_MAX_CHARS - 10) / 2)}${KEY} and more after it`;
    const { sources, posted } = rig({ events: [event("e1", cut)] });
    await sendFeedback(draft({ chatId: "thread-1" }), sources);
    assert.doesNotMatch(posted[0]?.report.logs?.chat ?? "", /sk-ant/);
  });

  it("sends the words trimmed", async () => {
    const { sources, posted } = rig();
    await sendFeedback(draft({ text: "  \n Crash on start \n" }), sources);
    assert.equal(posted[0]?.report.text, "Crash on start");
  });

  it("fails, naming the status, when genex.games refuses the report", async () => {
    const { sources } = rig({ status: HTTP_NOT_FOUND });
    await assert.rejects(sendFeedback(draft(), sources), /404/);
  });
});

describe("send feedback refuses", () => {
  const hostile: Array<[string, unknown]> = [
    ["no payload", undefined],
    ["a string payload", "feedback"],
    ["missing text", { ...draft(), text: undefined }],
    ["blank text", draft({ text: "   \n " })],
    ["text past the limit", draft({ text: "x".repeat(FEEDBACK_TEXT_MAX_CHARS + 1) })],
    ["a number for text", draft({ text: 42 })],
    ["an unknown screen", draft({ screen: "settings" })],
    ["appLogs as a string", draft({ appLogs: "yes" })],
    ["a number for the chat", draft({ chatId: 7 })],
  ];
  for (const [name, payload] of hostile) {
    it(`${name} and posts nothing`, async () => {
      const { sources, posted, chatsRead, diagnosticsRead } = rig();
      await assert.rejects(sendFeedback(payload, sources));
      assert.deepEqual(posted, []);
      assert.deepEqual(chatsRead, []);
      assert.deepEqual(diagnosticsRead, []);
    });
  }

  it("a chat id that leaves the event log and posts nothing", async () => {
    const store = await EventStore.open(path.join(await tmpDir(), "exoharness"), "studio");
    const thread = await store.createThread();
    await store.appendEvents(thread, [{ type: "error", message: "inside" }]);
    for (const chatId of [`../${thread}`, `${thread}/../..`, "/etc/passwd", "", "."]) {
      const { sources, posted } = rig();
      sources.chatEvents = (id, count) => store.listEvents(id, { limit: count, tail: true });
      await assert.rejects(sendFeedback(draft({ chatId }), sources), `${chatId} is refused`);
      assert.deepEqual(posted, [], `${chatId} posts nothing`);
    }
    const { sources, posted } = rig();
    sources.chatEvents = (id, count) => store.listEvents(id, { limit: count, tail: true });
    await sendFeedback(draft({ chatId: thread }), sources);
    assert.match(posted[0]?.report.logs?.chat ?? "", /inside/, "the real chat id still reads its log");
  });
});

describe("where feedback comes from", () => {
  const record = (id: string, metadata: Record<string, unknown>): ConversationRecord => ({
    id,
    agent_id: "studio",
    created_at: "2026-10-07T10:00:00.000Z",
    updated_at: "2026-10-07T10:00:00.000Z",
    latest_event_id: null,
    metadata,
  });
  const pong = { name: "pong", title: "Neon Pong" } as GameProject;
  const gameChat = record("game-1", { kind: ThreadKind.Game, project: "pong" });
  const harness = record("studio-1", { kind: ThreadKind.Studio });

  it("names the open game's chat by its game", () => {
    assert.deepEqual(feedbackAbout({ activeThread: gameChat, pluginsOpen: false, games: [pong] }), {
      screen: FeedbackScreen.Chat,
      chat: { id: "game-1", title: "Neon Pong" },
    });
  });

  it("names the Harness chat Harness", () => {
    assert.deepEqual(feedbackAbout({ activeThread: harness, pluginsOpen: false, games: [pong] }), {
      screen: FeedbackScreen.Harness,
      chat: { id: "studio-1", title: "Harness" },
    });
  });

  it("has no chat on Home or over Plugins", () => {
    assert.deepEqual(feedbackAbout({ activeThread: null, pluginsOpen: false, games: [pong] }), {
      screen: FeedbackScreen.Home,
      chat: null,
    });
    assert.deepEqual(feedbackAbout({ activeThread: gameChat, pluginsOpen: true, games: [pong] }), {
      screen: FeedbackScreen.Plugins,
      chat: null,
    });
  });
});
