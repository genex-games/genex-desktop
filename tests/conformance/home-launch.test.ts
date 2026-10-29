/**
 * Home starts a game from its first message: the game is named by the model picked for it, made
 * where the user chose, opened, and only then does its own chat send the message. Nothing is made
 * before the message, and a refusal leaves the user at home with their words.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  initialLaunch,
  LaunchPhase,
  launchFailed,
  launchFinished,
  launchHanded,
  launchInSidebar,
  launchMade,
  launchNamed,
  launchOpened,
  launchStarted,
  returnTaken,
} from "../../src/renderer/state/launch.ts";
import { createStudio } from "../../src/renderer/state/studio.ts";
import { Room, roomOf } from "../../src/renderer/state/threads.ts";
import type { KeyValueStorage } from "../../src/renderer/storage.ts";
import type { Bootstrap, ConversationRecord, GameProject } from "../../src/shared/studio-api.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const REQUEST = "A cozy fishing game on a tiny island.";

function memoryStorage(seed: Record<string, string> = {}): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const game = (name: string, title: string): GameProject =>
  ({ name, title, dir: `/g/${name}`, pathLabel: `~/AI Games/${name}`, createdAt: "" }) as GameProject;
const listing = (...names: string[]) => names.map((name) => ({ name }));
const chat = (id: string, project: string): ConversationRecord => ({
  id,
  agent_id: "a",
  created_at: "",
  updated_at: "",
  latest_event_id: null,
  metadata: { kind: "game", project },
});

describe("the launch's own steps", () => {
  const started = launchStarted(initialLaunch(), { id: "l1", text: REQUEST, extras: undefined, at: 5, known: [] });

  it("goes naming → opening → opened → handed, each step only for its own launch", () => {
    assert.equal(started.launch?.phase, LaunchPhase.Naming);
    const named = launchNamed(started, "l1", "Tiny Island Fishing");
    assert.equal(named.launch?.phase, LaunchPhase.Opening);
    assert.equal(named.launch?.title, "Tiny Island Fishing");
    assert.equal(launchNamed(started, "other", "Wrong"), started, "a stale launch's step changes nothing");
    const opened = launchOpened(named, "l1", { project: "tiny-island-fishing", threadId: "t1" });
    assert.deepEqual(
      { phase: opened.launch?.phase, project: opened.launch?.project, threadId: opened.launch?.threadId },
      { phase: LaunchPhase.Opened, project: "tiny-island-fishing", threadId: "t1" },
    );
    assert.deepEqual(opened.planning, { project: "tiny-island-fishing", at: 5 }, "the stage plans from the send");
    const handed = launchHanded(opened, "l1");
    assert.equal(handed.launch?.phase, LaunchPhase.Handed);
    assert.equal(launchHanded(handed, "l1"), handed, "a message is handed over once");
    assert.equal(launchFinished(handed, "l1").launch, null);
    assert.deepEqual(launchFinished(handed, "l1").planning, opened.planning, "and keeps doing so after");
    assert.equal(launchFinished(handed, "other"), handed);
  });

  it("the sidebar holds one row for it: a placeholder until its game is listed, then the game's own", () => {
    const named = launchNamed(started, "l1", "Tiny Island Fishing");
    const nothing = listing();
    assert.deepEqual(launchInSidebar(null, nothing), { placeholder: false, title: null, project: null });
    assert.deepEqual(launchInSidebar(named.launch, nothing), {
      placeholder: true,
      title: "Tiny Island Fishing",
      project: null,
    });
    const made = launchMade(named, "l1", "tiny-island-fishing");
    assert.equal(made.launch?.phase, LaunchPhase.Opening, "made, its chat still opening");
    assert.equal(launchMade(named, "other", "x"), named, "a stale launch's step changes nothing");
    assert.equal(launchInSidebar(made.launch, nothing).placeholder, true, "never no row at all");
    assert.deepEqual(launchInSidebar(made.launch, listing("tiny-island-fishing")), {
      placeholder: false,
      title: "Tiny Island Fishing",
      project: "tiny-island-fishing",
    });
  });

  it("while its game is being made, the one game listed since the launch started is its row", () => {
    const before = launchStarted(initialLaunch(), {
      id: "l1",
      text: REQUEST,
      extras: undefined,
      at: 5,
      known: ["pond"],
    });
    const naming = before.launch;
    assert.equal(
      launchInSidebar(naming, listing("pond", "other")).placeholder,
      true,
      "nothing is made before it is named",
    );
    const named = launchNamed(before, "l1", "Tiny Island Fishing").launch;
    assert.deepEqual(launchInSidebar(named, listing("pond", "tiny-island-fishing")), {
      placeholder: false,
      title: "Tiny Island Fishing",
      project: "tiny-island-fishing",
    });
    assert.equal(launchInSidebar(named, listing("pond")).placeholder, true, "not listed yet: the placeholder");
    assert.equal(
      launchInSidebar(named, listing("pond", "a", "b")).placeholder,
      true,
      "two new games: neither is taken for it",
    );
  });

  it("a failed launch gives the words back to home once", () => {
    const failed = launchFailed(started, "l1");
    assert.equal(failed.launch, null);
    assert.equal(failed.returned?.text, REQUEST);
    assert.equal(returnTaken(failed).returned, null);
  });
});

describe("launching a game from home", () => {
  function launched(overrides: Parameters<typeof fakeStudioApi>[0] = {}, storage = memoryStorage()) {
    const boot = {
      threadId: "studio",
      layout: {},
      gamesRootLabel: "~/AI Games",
      harness: { state: "ready", version: null, capabilities: [] },
      threads: [],
      events: [],
      eventsCursor: null,
      engines: [],
      activeDelegations: {},
      games: [],
    } as unknown as Bootstrap;
    const made: GameProject[] = [];
    const fake = fakeStudioApi({
      bootstrap: async () => boot,
      games: async () => made,
      nameGame: async () => ({ title: "Tiny Island Fishing" }),
      createGame: async (title) => {
        made.push(game("tiny-island-fishing", title));
        return made[0] as GameProject;
      },
      threadForGame: async (project) => chat("t-fish", project),
      ...overrides,
    });
    const timers = { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0 };
    const app = createStudio(fake.api, { storage, timers });
    app.start();
    return { app, fake, storage };
  }

  it("names the game with the picked model, makes it in the games folder, and opens its chat", async () => {
    const { app, fake, storage } = launched();
    await tick();
    assert.equal(roomOf(app.threads.getState()), Room.Home);
    await app.launchGame({ text: REQUEST, modelKey: "claude-code::opus", effort: "high" });
    assert.deepEqual(fake.callsOf("nameGame"), [[{ prompt: REQUEST, engine: "claude-code", model: "opus" }]]);
    assert.deepEqual(fake.callsOf("createGame"), [["Tiny Island Fishing"]]);
    assert.equal(app.threads.getState().activeThreadId, "t-fish");
    assert.equal(roomOf(app.threads.getState()), Room.Build);
    assert.deepEqual(fake.callsOf("loadPreview"), [["tiny-island-fishing"]], "the new game loads once");
    assert.deepEqual(
      app.library.getState().games.map((g) => g.name),
      ["tiny-island-fishing"],
    );
    const { launch } = app.launch.getState();
    assert.deepEqual(
      { phase: launch?.phase, threadId: launch?.threadId, text: launch?.text },
      { phase: LaunchPhase.Opened, threadId: "t-fish", text: REQUEST },
      "the chat sends the message itself, once it is open",
    );
    assert.deepEqual(fake.callsOf("send"), [], "nothing is sent before the chat is open");
    assert.equal(storage.data.get("studio.model.t-fish"), "claude-code::opus", "the chat keeps home's model");
    assert.equal(storage.data.get("studio.threadEffort.t-fish"), "high", "and its effort");
  });

  it("the made game takes its placeholder's place at once, while its chat is still opening", async () => {
    let openChat: (record: ConversationRecord) => void = () => {};
    const { app } = launched({
      threadForGame: () =>
        new Promise((resolve) => {
          openChat = resolve;
        }),
    });
    await tick();
    const going = app.launchGame({ text: REQUEST, modelKey: null, effort: null });
    await tick();
    const listed = app.library.getState().games.map((g) => g.name);
    assert.ok(listed.includes("tiny-island-fishing"), "the library lists the new game");
    assert.deepEqual(
      launchInSidebar(app.launch.getState().launch, app.library.getState().games),
      { placeholder: false, title: "Tiny Island Fishing", project: "tiny-island-fishing" },
      "one row, the game's own, never the game and its placeholder",
    );
    openChat(chat("t-fish", "tiny-island-fishing"));
    await going;
    assert.equal(app.launch.getState().launch?.phase, LaunchPhase.Opened);
  });

  it("a game the library lists before it is handed back still has one row, never beside its placeholder", async () => {
    // Main announces a new game and lists its folder while it is still making it (its repository
    // and chat), so a library refresh can list the game before `createGame` answers with it.
    let finishMaking: () => void = () => {};
    const made: GameProject[] = [game("pond", "Pond")];
    const { app, fake } = launched({
      games: async () => made,
      createGame: async (title) => {
        const fish = game("tiny-island-fishing", title);
        made.push(fish);
        fake.emit({ type: UiEvent.GameChanged, payload: { project: fish.name } });
        await new Promise<void>((resolve) => {
          finishMaking = resolve;
        });
        return fish;
      },
    });
    await tick();
    await app.library.refreshGames();
    const going = app.launchGame({ text: REQUEST, modelKey: null, effort: null });
    await tick();
    await tick();
    const listed = app.library.getState().games.map((g) => g.name);
    assert.deepEqual(listed, ["pond", "tiny-island-fishing"], "the refresh lists the game being made");
    assert.deepEqual(
      launchInSidebar(app.launch.getState().launch, app.library.getState().games),
      { placeholder: false, title: "Tiny Island Fishing", project: "tiny-island-fishing" },
      "one row, the game's own, never the game and its placeholder",
    );
    finishMaking();
    await going;
    assert.equal(app.launch.getState().launch?.project, "tiny-island-fishing");
  });

  it("makes the game in the folder chosen at home", async () => {
    const { app, fake } = launched();
    await tick();
    await app.launchGame({ text: REQUEST, modelKey: null, effort: null, parent: "/Users/me/Projects" });
    assert.deepEqual(fake.callsOf("nameGame"), [[{ prompt: REQUEST }]]);
    assert.deepEqual(fake.callsOf("createGame"), [["Tiny Island Fishing", { parent: "/Users/me/Projects" }]]);
  });

  it("still makes the game, as Untitled game, when naming itself fails", async () => {
    const { app, fake } = launched({
      nameGame: async () => {
        throw new Error("main went away");
      },
    });
    await tick();
    await app.launchGame({ text: REQUEST, modelKey: null, effort: null });
    assert.deepEqual(fake.callsOf("createGame"), [["Untitled game", { provisional: true }]]);
  });

  it("a first message that names no game (a greeting) makes it Untitled, its name waiting for an idea", async () => {
    const { app, fake } = launched({ nameGame: async () => ({ title: "Untitled game", provisional: true }) });
    await tick();
    await app.launchGame({ text: "Hello", modelKey: null, effort: null });
    assert.deepEqual(fake.callsOf("createGame"), [["Untitled game", { provisional: true }]]);
  });

  it("a picked model that is out of usage makes no game: home keeps the words and says why", async () => {
    const weekly = "You've hit your weekly limit · resets 6pm";
    const { app, fake } = launched({
      nameGame: async () => ({ title: "A cozy fishing game", provisional: true, limited: weekly }),
    });
    await tick();
    await app.launchGame({ text: REQUEST, modelKey: "claude-code::opus", effort: "high" });
    assert.deepEqual(fake.callsOf("createGame"), [], "no game waits empty for a turn that cannot run");
    assert.equal(roomOf(app.threads.getState()), Room.Home);
    assert.equal(app.launch.getState().launch, null);
    assert.equal(app.launch.getState().returned?.text, REQUEST, "the words go back to home");
    const [toast] = app.toasts.getState().items;
    assert.equal(toast?.tone, "err");
    assert.match(toast?.text ?? "", /weekly limit/);
    assert.deepEqual(fake.callsOf("send"), []);
  });

  it("a refused game leaves home as it was, says why, and gives the words back", async () => {
    const { app, fake } = launched({
      createGame: async () => {
        throw new Error("Choose a folder outside your games.");
      },
    });
    await tick();
    await app.launchGame({ text: REQUEST, modelKey: null, effort: null, parent: "/inside/a/game" });
    assert.equal(app.threads.getState().activeThreadId, null);
    assert.equal(roomOf(app.threads.getState()), Room.Home);
    assert.equal(app.launch.getState().launch, null);
    assert.equal(app.launch.getState().returned?.text, REQUEST);
    assert.equal(app.toasts.getState().items[0]?.tone, "err");
    assert.deepEqual(fake.callsOf("send"), []);
  });

  it("one launch at a time: a second send while the first is out does nothing", async () => {
    const { app, fake } = launched();
    await tick();
    const first = app.launchGame({ text: REQUEST, modelKey: null, effort: null });
    await app.launchGame({ text: "Another game", modelKey: null, effort: null });
    await first;
    assert.equal(fake.callsOf("createGame").length, 1);
  });
});
