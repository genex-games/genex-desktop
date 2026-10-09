/**
 * The door — where a launch lands, and what the run promises (M1.7).
 *
 * Two rules are tested here as pure functions, and then pinned in the files that draw them.
 * The opening rule exists because a first launch used to land in the Studio thread — the one
 * chat that cannot build — so the first sentence a new user typed was answered with "this chat
 * never builds; press the folder+". The promise exists because the switch offered "∞ — until
 * the critics are satisfied", which told nobody when to come back, and the first real run
 * was paused by the Claude plan's five-hour window at 105 of 180 minutes.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  clockAfter,
  HOURS_CEILING,
  HOURS_DEFAULT,
  HOURS_OFF_PROMISE,
  hoursCaption,
  hoursPromise,
} from "../../src/renderer/door.ts";
import {
  chatPlaceholder,
  COMPOSER_LINE_CHARS,
  composerPlaceholder,
  HOME_PLACEHOLDER,
  LEAD_PLACEHOLDER,
  PLAN_PLACEHOLDER,
  QUEUE_PLACEHOLDER,
} from "../../src/renderer/composer-placeholder.ts";
import { leadTakesChat } from "../../src/renderer/chat/live-chat.ts";
import { endClock } from "../../src/harness-seed/loop/wall-clock.ts";
import { createStudio } from "../../src/renderer/state/studio.ts";
import { Room, roomOf } from "../../src/renderer/state/threads.ts";
import type { Bootstrap, ConversationRecord } from "../../src/shared/studio-api.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = (file: string): string => readFileSync(path.join(root, file), "utf8");
const rendererFiles = (): string[] =>
  readdirSync(path.join(root, "src/renderer"), { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => path.join(root, "src/renderer", file));

/** The slice of a thread record a launch reads. */
interface OpeningThread {
  id: string;
  updated_at: string;
  metadata?: { kind?: string; project?: string | null; archived?: boolean } | null;
}

const studio: OpeningThread = { id: "studio", updated_at: "2026-09-01T10:00:00Z", metadata: { kind: "studio" } };
const game = (id: string, updated: string, project: string | null, archived = false): OpeningThread => ({
  id,
  updated_at: updated,
  metadata: { kind: "game", project, archived },
});

describe("the door: what the run promises", () => {
  const at = (hhmm: string): number => new Date(`2026-09-08T${hhmm}:00`).getTime();
  /** The clock the Mac writes — the promise must be in the reader's own 12/24-hour setting. */
  const clock = (hhmm: string): string =>
    new Date(at(hhmm)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  it("names a wall clock the way the Mac writes one, wrapping past midnight", () => {
    assert.equal(clockAfter(3, at("04:10")), clock("07:10"));
    assert.equal(clockAfter(HOURS_DEFAULT, at("23:40")), clock("02:40"));
    assert.equal(clockAfter(0.5, at("09:05")), clock("09:35"));
  });

  it("the default is a capped run, and its promise says when to come back", () => {
    assert.equal(HOURS_DEFAULT, 3);
    const promise = hoursPromise(HOURS_DEFAULT, at("04:10"));
    assert.match(promise, /^Hours —/);
    assert.doesNotMatch(promise, /overnight|tonight/i, "the owner retired the word");
    assert.match(HOURS_OFF_PROMISE, /^Off — one build pass in this chat/);
    assert.ok(promise.includes(`until about ${clock("07:10")}`), promise);
    assert.match(promise, /Keep the app open/);
    assert.ok(hoursCaption(3, at("04:10")).includes(`until about ${clock("07:10")}`));
  });

  it("∞ is still a choice, and still names the ceiling it stops at", () => {
    const promise = hoursPromise(null, at("04:10"));
    assert.match(promise, /until its reviewers are satisfied/);
    assert.match(promise, new RegExp(`about ${clockAfter(HOURS_CEILING, at("04:10"))}`));
    // Whole strings, not substrings: 24 h from 04:10 is 04:10 again, so a caption that printed
    // the start time, or forgot the ceiling entirely, matched a bare /04:10/ just as well. The
    // exact form at least catches every wording and arithmetic change; the assertion below is
    // what makes the ceiling itself testable if it ever stops being a whole day.
    assert.equal(
      HOURS_CEILING % 24,
      0,
      "a ceiling that is not a whole day makes the next two assertions discriminating",
    );
    assert.equal(hoursCaption(null, at("04:10")), `until satisfied · by ~${clockAfter(HOURS_CEILING, at("04:10"))}`);
    assert.equal(hoursCaption(3, at("04:10")), `until about ${clock("07:10")}`);
    assert.notEqual(
      hoursCaption(null, at("04:10")),
      hoursCaption(3, at("04:10")),
      "no cap and a 3-hour cap say different things",
    );
  });

  it("no promise is a bare duration — a user asked when, not how long", () => {
    for (const words of [hoursPromise(3, at("04:10")), hoursCaption(3, at("04:10")), hoursPromise(null, at("04:10"))]) {
      assert.match(words, /\d{1,2}:\d\d/, `no clock time in "${words}"`);
    }
  });
});

describe("the door: what the app opens on launch", () => {
  const record = (thread: OpeningThread): ConversationRecord => ({
    id: thread.id,
    agent_id: "a",
    created_at: thread.updated_at,
    updated_at: thread.updated_at,
    latest_event_id: null,
    metadata: thread.metadata ?? {},
  });
  const launch = async (threads: OpeningThread[], games: string[], remembered: Record<string, string> = {}) => {
    const boot: Bootstrap = {
      threadId: "studio",
      layout: {},
      gamesRootLabel: "~/AI Games",
      harness: { state: "ready", version: null, capabilities: [] },
      threads: threads.map(record),
      events: [],
      eventsCursor: null,
      engines: [],
      activeDelegations: {},
      games: games.map((name) => ({
        name,
        dir: `/g/${name}`,
        title: name,
        createdAt: "",
        pathLabel: name,
        library: true,
        built: false,
        facts: [{ id: "web-game", path: ".", source: "core" }],
        shape: {
          entry: "index.html",
          main: "src/main.js",
          build: null,
          install: null,
          own: false,
          kind: "studio-template",
          serve: ".",
        },
      })),
    };
    const fake = fakeStudioApi({ bootstrap: async () => boot });
    const data = new Map(Object.entries(remembered));
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    };
    const timers = { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0 };
    const app = createStudio(fake.api, { storage, timers });
    app.start();
    await new Promise((resolve) => setImmediate(resolve));
    return { app, fake };
  };
  /** Home: no chat open, no game on the stage, nothing loaded, made or asked for. */
  const assertHome = ({ app, fake }: Awaited<ReturnType<typeof launch>>) => {
    assert.equal(app.threads.getState().activeThreadId, null, "no chat is selected");
    assert.equal(roomOf(app.threads.getState()), Room.Home);
    assert.equal(app.threads.getState().stageProject, null, "no game is on the stage");
    assert.deepEqual(fake.callsOf("loadPreview"), [], "no game is loaded behind home");
    for (const method of ["createGame", "nameGame", "newGameThread", "threadForGame"] as const)
      assert.deepEqual(fake.callsOf(method), [], `${method}: nothing is made until the first message`);
  };

  it("opens home even when there are games, and the last chat is remembered", async () => {
    // Intentionally flipped: a launch used to reopen the remembered chat with its game
    // on the stage. Home is where every launch starts; the remembered chat is one click or ⌘1 away.
    const launched = await launch(
      [studio, game("old", "2026-09-01T10:00:00Z", "pond-life"), game("fresh", "2026-09-04T10:00:00Z", "rift")],
      ["pond-life", "rift"],
      { "studio.activeThread": "old", "studio.reviewProject": "rift", "studio.lastGameThread": "old" },
    );
    assertHome(launched);
    assert.equal(launched.app.threads.getState().lastGameThreadId, "old", "⌘1 still returns to the last game chat");
  });

  it("an empty library opens home too: no Create game, nothing minted", async () => {
    // Intentionally flipped: an empty library used to open Create game over Studio.
    assertHome(await launch([studio], []));
  });

  it("a remembered chat whose game was removed opens home like any other launch", async () => {
    assertHome(
      await launch([studio, game("gone", "2026-09-04T10:00:00Z", "deleted-game")], [], {
        "studio.activeThread": "gone",
      }),
    );
  });
});

describe("the door: the composer's own instruction", () => {
  const every = [QUEUE_PLACEHOLDER, LEAD_PLACEHOLDER, HOME_PLACEHOLDER, PLAN_PLACEHOLDER];
  for (const revisingPlan of [true, false])
    for (const studio of [true, false])
      for (const draft of [true, false]) every.push(chatPlaceholder({ revisingPlan, studio, draft }));

  it("fits the line it is drawn on", () => {
    // About 53 characters is what the composer shows on one line at the default chat width, and
    // an empty box measures none of it — this is the sentence a first launch is read from.
    for (const words of new Set(every))
      assert.ok(words.length <= COMPOSER_LINE_CHARS, `too long for one line: "${words}"`);
  });

  it("asks home what to make, and only an active build overrides the context", () => {
    // Intentionally flipped: the words were "Describe a game…".
    assert.equal(HOME_PLACEHOLDER, "What do you want to make?");
    const firstLaunch = chatPlaceholder({ revisingPlan: false, studio: false, draft: true });
    assert.equal(firstLaunch, HOME_PLACEHOLDER);
    assert.equal(composerPlaceholder(false, firstLaunch), firstLaunch);
    assert.equal(composerPlaceholder(true, firstLaunch), QUEUE_PLACEHOLDER);
    // The most specific task wins: revising a plan outranks the Studio chat's own prompt. An
    // interview question is answered in its own card, so it does not take the composer's words.
    assert.equal(
      chatPlaceholder({ revisingPlan: true, studio: true, draft: false }),
      "Describe the changes to the plan…",
    );
  });
});

describe("the door: the composer while a build's lead takes the chat", () => {
  /** A build's start as its log records it: the run's lead takes the chat when it says so. */
  const start = (runId: string, payload: Record<string, unknown>, n: number) => ({
    id: `e${n}`,
    thread_id: "t",
    session_id: null,
    turn_id: null,
    created_at: "2026-09-26T08:44:56.000Z",
    data: { type: "custom" as const, event_type: "autopilot_started", payload: { runId, director: true, ...payload } },
  });

  it("says a message reaches the lead, not the end of the build, while such a build runs", () => {
    const contextual = "Ask for a change…";
    assert.equal(composerPlaceholder(true, contextual, true), LEAD_PLACEHOLDER);
    assert.equal(
      composerPlaceholder(true, contextual, false),
      QUEUE_PLACEHOLDER,
      "a build with no lead line keeps its queue",
    );
    assert.equal(composerPlaceholder(false, contextual, true), contextual, "no build, no lead to reach");
  });

  it("reads whether the lead takes the chat from the running build's latest start", () => {
    assert.equal(leadTakesChat([start("r1", { liveChat: true }, 1)], "r1"), true);
    assert.equal(leadTakesChat([start("r1", {}, 1)], "r1"), false, "the long turn opens no line");
    assert.equal(leadTakesChat([start("r1", { liveChat: true }, 1)], "r2"), false, "another build's lead");
    assert.equal(leadTakesChat([start("r1", { liveChat: true }, 1)], null), false, "nothing running");
    const resumedOld = [start("r1", { liveChat: true }, 1), start("r1", { resumed: true }, 2)];
    assert.equal(leadTakesChat(resumedOld, "r1"), false, "a resumed run says again for itself");
  });
});

describe("the chat's promise of when a build ends", () => {
  const at = (day: string, hhmm: string): number => new Date(`2026-09-${day}T${hhmm}:00`).getTime();
  const clock = (day: string, hhmm: string): string =>
    new Date(at(day, hhmm)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const HOUR = 3_600_000;

  it("names today's end by its clock alone", () => {
    assert.equal(endClock(3 * HOUR, at("26", "09:10")), clock("26", "12:10"));
  });

  it("says tomorrow when the end is on the next day: a 24-hour build ends at the minute it began", () => {
    assert.equal(endClock(24 * HOUR, at("26", "13:44")), `${clock("27", "13:44")} tomorrow`);
    assert.equal(endClock(3 * HOUR, at("26", "23:40")), `${clock("27", "02:40")} tomorrow`);
  });
});

/**
 * Source-level gates that remain: each needs a rendered window (dev-control golden snapshots of
 * the app-basics fixture) or the build smoke's own text to be proven any other way.
 */
describe("the door: the surfaces that draw it", () => {
  it("nothing in the renderer mints a game chat", () => {
    // What the app opens is proven by launching the studio store above. `window.studio` reaches
    // every renderer file, so this rule is about the whole tree: creation
    // waits for an explicit name or folder.
    const minting = rendererFiles()
      .filter((file) => /\bnewGameThread\(/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(root, file));
    assert.deepEqual(minting, [], "creation waits for an explicit name or folder");
  });

  it("blank chats keep creation in navigation and writing in the composer", () => {
    const chat = read("src/renderer/panels/ChatPanel.tsx");
    assert.doesNotMatch(
      chat,
      /What would you like to build\?|Ideas to start with|Ask about Studio<|Start a game<|STARTERS/,
    );
    assert.match(chat, /<PromptBar/);
    assert.match(read("src/renderer/panels/Sidebar.tsx"), /New game/);
  });

  it("the composer groups build behavior in the Mode panel", () => {
    const bar = read("src/renderer/ui/PromptBar.tsx");
    assert.match(bar, /<ComposerModeMenu/);
    assert.doesNotMatch(bar, /aria-label="Hours"/);
  });

  it("the box is sized to its placeholder, so a longer one still cannot be clipped", () => {
    assert.match(read("src/renderer/ui/PromptBar.tsx"), /if \(draft\.length === 0 && input\.placeholder\)/);
  });
});
