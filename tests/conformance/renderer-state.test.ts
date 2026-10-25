/**
 * The renderer's state (src/renderer/state/): pure store actions, the refresher every store reads
 * through, and the studio that wires them to one `onEvent` subscription — all driven through a
 * fake `StudioApi` in Node, no window. The last suite holds the one lint the stores need: a
 * component reads a store through a selector, never the whole state.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import type { ConversationRecord, GameProject, ProjectAssets } from "../../src/shared/studio-api.ts";
import type { UiEvent } from "../../src/shared/ui-events.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { shownPermissionMode } from "../../src/renderer/chat/use-permission-mode.ts";
import { createRefresher } from "../../src/renderer/state/refresher.ts";
import { computerControlOn, setComputerControl } from "../../src/renderer/use-computer-control.ts";
import { computerControlDetail } from "../../src/renderer/words.ts";
import { computerControlOffered, desktopStopShortcut, stopShortcutWords } from "../../src/shared/computer-control.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { SetupReport } from "../../src/renderer/state/boot.ts";
import { PlayViewerPhase } from "../../src/shared/play.ts";
import { UpdateAction } from "../../src/shared/app-update.ts";
import {
  createEventLogStore,
  eventLogBootstrapped,
  eventsArrived,
  initialEventLog,
  threadBackfilled,
  threadLog,
} from "../../src/renderer/state/event-log.ts";
import {
  busyThreadIds,
  gameRemovedFromThreads,
  harnessDown,
  initialThreads,
  personFirstLabel,
  projectOf,
  railThreadIds,
  returnTarget,
  Room,
  roomOf,
  sidebarGames,
  statusBootstrapped,
  statusReported,
  threadMeta,
  threadSelected,
  threadsLoaded,
} from "../../src/renderer/state/threads.ts";
import {
  ASSET_POLL_MS,
  createLibraryStore,
  delegationChanged,
  initialLibrary,
  libraryBootstrapped,
} from "../../src/renderer/state/library.ts";
import { frameReceived, screenClosed, screensLoaded } from "../../src/renderer/state/agent-screens.ts";
import { createToastsStore, TOAST_MS } from "../../src/renderer/state/toasts.ts";
import {
  chatWidthCommitted,
  chatWidthDragged,
  chatWidthOf,
  chatWidthStepped,
  createLayoutStore,
  stageViewChosen,
} from "../../src/renderer/state/layout.ts";
import { createModelPickerStore, pickerModelSet, pickerModelsReset } from "../../src/renderer/state/model-picker.ts";
import { uiEventReads } from "../../src/renderer/state/ui-event-routes.ts";
import { createStudio, EVENT_POLL_MS, type StudioTimers } from "../../src/renderer/state/studio.ts";
import type { KeyValueStorage } from "../../src/renderer/storage.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function memoryStorage(
  seed: Record<string, string> = {},
): KeyValueStorage & { data: Map<string, string>; writes: string[] } {
  const data = new Map(Object.entries(seed));
  const writes: string[] = [];
  return {
    data,
    writes,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      writes.push(key);
      data.set(key, value);
    },
    removeItem: (key) => void data.delete(key),
  };
}

function manualTimers(): StudioTimers & {
  intervals: Map<number, { run: () => void; ms: number }>;
  timeouts: Array<{ run: () => void; ms: number }>;
  fire(ms: number): void;
} {
  const intervals = new Map<number, { run: () => void; ms: number }>();
  const timeouts: Array<{ run: () => void; ms: number }> = [];
  let next = 0;
  return {
    intervals,
    timeouts,
    setInterval: (run, ms) => {
      intervals.set(++next, { run, ms });
      return next;
    },
    clearInterval: (handle) => void intervals.delete(handle as number),
    setTimeout: (run, ms) => {
      timeouts.push({ run, ms });
      return timeouts.length;
    },
    fire(ms) {
      for (const timer of [...intervals.values()]) if (timer.ms === ms) timer.run();
    },
  };
}

const envelope = (
  id: string,
  thread = "t1",
  data: EventEnvelope["data"] = { type: "error", message: id },
): EventEnvelope => ({
  id,
  thread_id: thread,
  session_id: null,
  turn_id: null,
  created_at: "2026-09-24T00:00:00.000Z",
  data,
});
const thread = (
  id: string,
  metadata: Record<string, unknown>,
  updated = "2026-09-01T00:00:00Z",
): ConversationRecord => ({
  id,
  agent_id: "a",
  created_at: updated,
  updated_at: updated,
  latest_event_id: null,
  metadata,
});
const gameProject = (name: string, extra: Partial<GameProject> = {}): GameProject => ({
  name,
  dir: `/games/${name}`,
  title: name,
  createdAt: "2026-09-01T00:00:00Z",
  pathLabel: `~/AI Games/${name}`,
  library: true,
  shape: {
    entry: "index.html",
    main: "src/main.js",
    build: null,
    install: null,
    own: false,
    kind: "studio-template",
    serve: ".",
  },
  built: false,
  facts: [{ id: "web-game", path: ".", source: "core" }],
  ...extra,
});
const studioThread = thread("studio", { kind: "studio" });
const pond = thread("pond-chat", { kind: "game", project: "pond" }, "2026-09-03T00:00:00Z");
const rift = thread("rift-chat", { kind: "game", project: "rift" }, "2026-09-02T00:00:00Z");

function countedLibrary() {
  const games = Array.from({ length: 64 }, (_, index) => gameProject(`game-${index}`));
  const records = Array.from({ length: 512 }, (_, index) =>
    thread(
      `thread-${index}`,
      { kind: "game", project: `game-${index % games.length}` },
      new Date(Date.UTC(2026, 0, 1) + ((index * 23) % 512) * 60_000).toISOString(),
    ),
  );
  let reads = 0;
  const counted = new Proxy(records, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  return { games, records: counted, reads: () => reads };
}

describe("createRefresher: one read at a time, stale answers dropped, failures caught", () => {
  it("queues exactly one follow-up behind a read in flight, and applies both in order", async () => {
    const reads: Array<ReturnType<typeof deferred<number>>> = [];
    const applied: number[] = [];
    const refresher = createRefresher(
      () => {
        const read = deferred<number>();
        reads.push(read);
        return read.promise;
      },
      (value) => applied.push(value),
    );
    const first = refresher.request();
    void refresher.request();
    void refresher.request();
    assert.equal(reads.length, 1, "a burst starts one read");
    reads[0]!.resolve(1);
    await tick();
    assert.equal(reads.length, 2, "and queues one more, however many arrived");
    reads[1]!.resolve(2);
    await first;
    assert.deepEqual(applied, [1, 2]);
    assert.equal(refresher.inFlight, false);
  });

  it("drops a reply that lands after reset, and reports a failure without rejecting", async () => {
    const read = deferred<number>();
    const applied: number[] = [];
    const refresher = createRefresher(
      () => read.promise,
      (value) => applied.push(value),
    );
    const pending = refresher.request();
    refresher.reset();
    read.resolve(7);
    await pending;
    assert.deepEqual(applied, [], "a reset store never hears the old answer");
    const errors: unknown[] = [];
    const failing = createRefresher(
      () => Promise.reject(new Error("offline")),
      () => assert.fail("nothing to apply"),
      { onError: (error) => errors.push(error) },
    );
    await failing.request();
    assert.equal((errors[0] as Error).message, "offline");
    const throwing = createRefresher<number>(
      () => {
        throw new Error("sync");
      },
      () => {},
    );
    await throwing.request();
    assert.equal(throwing.inFlight, false, "a fetch that throws before its first await still frees the gate");
  });
});

describe("the event log store", () => {
  it("never reads before the bootstrap set the cursor, then reads once right after it", async () => {
    const fake = fakeStudioApi({ events: async () => ({ events: [envelope("e3")], cursor: "c3" }) });
    const log = createEventLogStore(fake.api);
    await log.refresh();
    await log.refresh();
    assert.equal(fake.callsOf("events").length, 0, "an early poll would list every thread's whole log");
    log.bootstrap({ events: [envelope("e1"), envelope("e2")], eventsCursor: "c2" });
    await tick();
    assert.deepEqual(fake.callsOf("events"), [["c2"]], "the deferred refresh runs once, after the cursor main gave");
    assert.deepEqual(
      log.getState().feed.map((e) => e.id),
      ["e1", "e2", "e3"],
    );
    assert.equal(log.getState().cursor, "c3", "the next read continues from main's cursor, not an event id");
  });

  it("keeps a thread's slice when another thread's events arrive, and merges without duplicates", () => {
    const booted = eventLogBootstrapped(initialEventLog(), {
      events: [envelope("a1", "a"), envelope("b1", "b")],
      eventsCursor: null,
    });
    assert.equal(booted.cursor, "b1", "an old main without a cursor continues after the last event");
    const next = eventsArrived(booted, { events: [envelope("b2", "b"), envelope("b1", "b")], cursor: "c" });
    assert.equal(threadLog(next, "a"), threadLog(booted, "a"), "thread a's transcript does not recompute for b");
    assert.deepEqual(
      threadLog(next, "b").map((e) => e.id),
      ["b1", "b2"],
    );
    assert.equal(eventsArrived(next, { events: [], cursor: null }), next, "an empty read is no change");
    assert.equal(
      threadLog(next, "nobody"),
      threadLog(next, "nobody-else"),
      "a thread with nothing is one stable empty array",
    );
  });

  it("backfills a thread's whole log once, which the window then never trims", async () => {
    const whole = [envelope("w0", "w"), envelope("w1", "w"), envelope("x9", "x")];
    const fake = fakeStudioApi({ threadEvents: async () => whole });
    const log = createEventLogStore(fake.api);
    log.bootstrap({ events: [envelope("w1", "w")], eventsCursor: "c" });
    log.backfill("w");
    log.backfill("w");
    await tick();
    assert.deepEqual(fake.callsOf("threadEvents"), [["w"]], "one read per thread");
    assert.deepEqual(
      threadLog(log.getState(), "w").map((e) => e.id),
      ["w0", "w1"],
      "only that thread's events, merged by id",
    );
    const merged = threadBackfilled(initialEventLog(), "z", [envelope("z2", "z"), envelope("z1", "z")]);
    assert.deepEqual(
      threadLog(merged, "z").map((e) => e.id),
      ["z1", "z2"],
    );
  });

  it("asks again for a backfill that failed", async () => {
    let fail = true;
    const fake = fakeStudioApi({
      threadEvents: async () => {
        if (fail) throw new Error("busy");
        return [];
      },
    });
    const log = createEventLogStore(fake.api);
    log.backfill("w");
    await tick();
    fail = false;
    log.backfill("w");
    await tick();
    assert.equal(fake.callsOf("threadEvents").length, 2);
    assert.equal(log.getState().backfill.w, "done");
  });
});

describe("the threads store: the open game is derived from the open chat", () => {
  const loaded = threadsLoaded(initialThreads(), [studioThread, pond, rift]);

  it("a game chat shows its own game; Studio keeps the game the stage held", () => {
    const inPond = threadSelected(loaded, "pond-chat");
    assert.equal(projectOf(inPond), "pond");
    assert.equal(roomOf(inPond), "build");
    assert.equal(inPond.stageThreadId, "pond-chat");
    assert.equal(inPond.lastGameThreadId, "pond-chat");
    const inStudio = threadSelected(inPond, "studio");
    assert.equal(roomOf(inStudio), "studio");
    assert.equal(projectOf(inStudio), "pond", "Studio's stage is the game it was entered from");
    assert.equal(inStudio.stageThreadId, "pond-chat");
    const draft = threadSelected(
      threadsLoaded(inStudio, [...inStudio.records, thread("draft", { kind: "game", project: null })]),
      "draft",
    );
    assert.equal(projectOf(draft), null, "a draft has no game until its first brief binds one");
    const bound = threadsLoaded(
      draft,
      draft.records.map((t) => (t.id === "draft" ? thread("draft", { kind: "game", project: "moss" }) : t)),
    );
    assert.equal(projectOf(bound), "moss", "binding the draft moves the stage with it");
  });

  it("a live status report wins over a (retried) bootstrap's snapshot", () => {
    const booted = statusBootstrapped(loaded, { "pond-chat": { status: "building", since: 1 } });
    assert.equal(booted.statusSource, "bootstrap");
    const live = statusReported(booted, { "rift-chat": { status: "director", since: 2 } });
    assert.deepEqual(statusBootstrapped(live, { "pond-chat": { status: "stale", since: 0 } }).status, live.status);
    assert.deepEqual(harnessDown(live).status, {}, "a harness that is not ready has nothing running");
    assert.deepEqual(
      [
        ...busyThreadIds({
          a: { status: "idle", since: 0 },
          b: { status: "working", since: 0 },
          c: { status: "", since: 0 },
        }),
      ],
      ["b"],
    );
  });

  it("removing the stage's game opens home and forgets the return to it", () => {
    // Intentionally flipped: removing the game on the stage used to open Studio.
    const inPond = threadSelected(loaded, "pond-chat");
    const removed = gameRemovedFromThreads(inPond, "pond");
    assert.equal(removed.activeThreadId, null);
    assert.equal(roomOf(removed), Room.Home);
    assert.equal(projectOf(removed), null);
    assert.equal(removed.lastGameThreadId, null);
    assert.equal(gameRemovedFromThreads(inPond, "rift"), inPond, "another game's removal changes nothing here");
  });

  it("orders the sidebar's games by work in their chats, never by which one was opened last", () => {
    const names = (games: GameProject[]) => games.map((game) => game.name);
    const games = [
      gameProject("rift", { lastOpenedAt: "2026-09-05T00:00:00Z" }),
      gameProject("pond"),
      gameProject("moss", { pinned: true }),
      gameProject("fern", { createdAt: "2026-09-02T12:00:00Z" }),
    ];
    assert.deepEqual(names(sidebarGames(games, [studioThread, pond, rift])), ["moss", "pond", "fern", "rift"]);
    const replied = thread("rift-chat", { kind: "game", project: "rift" }, "2026-09-04T00:00:00Z");
    assert.deepEqual(
      names(sidebarGames(games, [studioThread, pond, replied])),
      ["moss", "rift", "pond", "fern"],
      "a message or reply in its chat moves a game up",
    );
  });

  it("orders the rail and finds Cmd-1's target among live games", () => {
    const games = [gameProject("rift", { primaryThreadId: "rift-chat" }), gameProject("pond")];
    assert.deepEqual(railThreadIds(loaded.records, games), ["studio", "rift-chat", "pond-chat"]);
    const state = { ...loaded, lastGameThreadId: "rift-chat" };
    assert.equal(returnTarget(state, games), "rift-chat");
    assert.equal(returnTarget(state, [gameProject("pond")]), "pond-chat", "a removed game's chat is not returned to");
  });

  it("indexes sidebar activity without rescanning every thread inside the sort", () => {
    const { games, records, reads } = countedLibrary();
    assert.equal(sidebarGames(games, records).length, games.length);
    assert.ok(reads() <= records.length * 2, `sidebar visited ${reads()} thread slots for ${records.length} records`);
  });

  it("indexes the rail's live chats without rescanning every thread for every game", () => {
    const { games, records, reads } = countedLibrary();
    assert.equal(railThreadIds(records, games).length, games.length);
    assert.ok(reads() <= records.length * 2, `rail visited ${reads()} thread slots for ${records.length} records`);
  });

  it("keeps sidebar date fallbacks and title ties, including archived activity", () => {
    const games = [
      gameProject("zebra", { createdAt: "invalid" }),
      gameProject("amber", { createdAt: "invalid" }),
      gameProject("old", { createdAt: "1960-01-01T00:00:00Z" }),
      gameProject("archived"),
    ];
    const records = [
      thread("old", { kind: "game", project: "old" }, "1961-01-01T00:00:00Z"),
      thread("archived", { kind: "game", project: "archived", archived: true }, "2026-10-01T00:00:00Z"),
    ];
    assert.deepEqual(
      sidebarGames(games, records).map((game) => game.name),
      ["archived", "amber", "zebra", "old"],
    );
  });

  it("keeps the rail's primary chat, freshest fallback and later-input timestamp ties", () => {
    const records = [
      studioThread,
      thread("first", { kind: "game", project: "pond" }),
      thread("later", { kind: "game", project: "pond" }),
      thread("archived", { kind: "game", project: "pond", archived: true }, "2026-10-01T00:00:00Z"),
      thread("other", { kind: "game", project: "rift" }),
    ];
    const games = [
      gameProject("pond", { primaryThreadId: "first" }),
      gameProject("pond"),
      gameProject("pond", { primaryThreadId: "archived" }),
      gameProject("rift", { primaryThreadId: "first" }),
      gameProject("empty"),
    ];
    assert.deepEqual(railThreadIds(records, games), ["studio", "first", "later", "later", "other"]);
  });

  it("reads thread metadata field by field", () => {
    assert.deepEqual(
      threadMeta(
        thread("x", { kind: "game", project: null, archived: true, lastEngine: "codex", lastModel: "", extra: 1 }),
      ),
      {
        kind: "game",
        project: null,
        archived: true,
        lastEngine: "codex",
        lastModel: "",
      },
    );
    assert.deepEqual(
      threadMeta(thread("y", { kind: "other", project: 3 })),
      {},
      "an unknown kind or a wrong type is absent, as before (not a game)",
    );
    assert.deepEqual(threadMeta(null), {});
  });

  it("reads the permission mode a chat's record keeps, and only a known one", () => {
    const bypass = thread("rift-chat", { kind: "game", project: "rift", permissionMode: "bypassPermissions" });
    assert.equal(threadMeta(bypass).permissionMode, "bypassPermissions");
    assert.equal(threadMeta(thread("x", { kind: "game", permissionMode: "yolo" })).permissionMode, undefined);
  });

  it("shows a chat opened again in the mode its record keeps, not the one new chats start in", () => {
    const record = thread("rift-chat", { kind: "game", project: "rift", permissionMode: "bypassPermissions" });
    const shown = (picked?: PermissionMode) =>
      shownPermissionMode({
        engine: EngineId.ClaudeCode,
        picked,
        recorded: threadMeta(record).permissionMode,
        defaultMode: PermissionMode.Auto,
      });
    assert.equal(shown(), PermissionMode.Bypass, "the pick is gone after switching chats or a restart");
    assert.equal(shown(PermissionMode.Manual), PermissionMode.Manual, "a pick on its way to the host shows at once");
    assert.equal(
      shownPermissionMode({
        engine: EngineId.OpenCode,
        picked: undefined,
        recorded: PermissionMode.Bypass,
        defaultMode: PermissionMode.Auto,
      }),
      PermissionMode.Auto,
      "an engine that cannot honour the mode runs, and shows, Auto",
    );
    assert.equal(
      shownPermissionMode({
        engine: EngineId.ClaudeCode,
        picked: undefined,
        recorded: undefined,
        defaultMode: PermissionMode.AcceptEdits,
      }),
      PermissionMode.AcceptEdits,
      "a chat that never chose shows the mode new chats start in",
    );
  });
});

describe("the library store", () => {
  it("counts builders per game from the event's own active count", () => {
    const one = delegationChanged(initialLibrary(), { started: true, project: "pond", active: 1 });
    assert.deepEqual([...one.building], ["pond"]);
    assert.equal(
      delegationChanged(one, { started: true, project: "pond", active: 2 }),
      one,
      "still building is no change",
    );
    assert.deepEqual(
      [...delegationChanged(one, { started: false, project: "pond", active: 1 }).building],
      ["pond"],
      "one builder of two finished",
    );
    assert.deepEqual(
      [...delegationChanged(one, { started: false, project: "pond" }).building],
      [],
      "an older event without a count",
    );
    assert.equal(delegationChanged(one, { started: true }), one);
  });

  it("reads which games are building from the bootstrap, so a reload mid-build keeps the badge (F8)", () => {
    const boot = {
      games: [gameProject("pond"), gameProject("rift")],
      gamesRootLabel: "~/AI Games",
      layout: { runs: "/runs" },
    };
    const loaded = libraryBootstrapped(initialLibrary(), { ...boot, activeDelegations: { pond: 2, rift: 0 } });
    assert.deepEqual([...loaded.building], ["pond"]);
    assert.deepEqual(
      [...delegationChanged(loaded, { started: false, project: "pond", active: 0 }).building],
      [],
      "the next finish clears it",
    );
    assert.deepEqual(
      [...libraryBootstrapped(loaded, boot).building],
      [],
      "an older main without the field reads nothing as building",
    );
  });

  it("serves every watcher of a game from one read and one poll, and stops when the last lets go", async () => {
    const timers = manualTimers();
    const inventory: ProjectAssets = { project: "pond", assets: [], truncated: false, skipped: [] };
    const fake = fakeStudioApi({ projectAssets: async (project) => ({ ...inventory, project }) });
    const library = createLibraryStore(fake.api, timers);
    const graph = library.watchAssets("pond");
    const canvas = library.watchAssets("pond");
    await tick();
    assert.equal(fake.callsOf("projectAssets").length, 1, "the timeline and the Assets stage share one read");
    assert.equal(timers.intervals.size, 1);
    timers.fire(ASSET_POLL_MS);
    await tick();
    assert.equal(fake.callsOf("projectAssets").length, 2);
    library.refreshAssets("rift");
    library.refreshAssets(null);
    await tick();
    assert.equal(fake.callsOf("projectAssets").length, 3, "only a watched game is read");
    graph();
    graph();
    assert.equal(timers.intervals.size, 1, "a second release of the same watch counts once");
    canvas();
    assert.equal(timers.intervals.size, 0);
    assert.deepEqual(library.getState().assets.pond?.value?.project, "pond");
  });

  it("keeps the last inventory when a read fails, and ignores an answer for another game", async () => {
    let answer: () => Promise<ProjectAssets> = async () => ({
      project: "pond",
      assets: [],
      truncated: false,
      skipped: [],
    });
    const fake = fakeStudioApi({ projectAssets: () => answer() });
    const library = createLibraryStore(fake.api, manualTimers());
    library.watchAssets("pond");
    await tick();
    answer = async () => {
      throw new Error("walk failed");
    };
    library.refreshAssets("pond");
    await tick();
    assert.equal(library.getState().assets.pond?.error, "Error: walk failed");
    assert.ok(library.getState().assets.pond?.value, "the last inventory stays on screen");
    answer = async () => ({ project: "renamed", assets: [], truncated: true, skipped: [] });
    library.refreshAssets("pond");
    await tick();
    assert.equal(library.getState().assets.pond?.value?.truncated, false);
  });
});

describe("agent screens, toasts and layout", () => {
  const frame = (handle: string, label: string) =>
    ({
      handle,
      label,
      project: "pond",
      jpeg: "",
      width: 1,
      height: 1,
      cursor: { x: 0, y: 0 },
      caption: null,
      at: 1,
    }) as never;

  it("keeps one card per window, sorted by label", () => {
    let state = frameReceived({ frames: [], trails: {} }, frame("h2", "b"));
    state = frameReceived(state, frame("h1", "a"));
    state = frameReceived(state, frame("h2", "b"));
    assert.deepEqual(
      state.frames.map((f) => f.handle),
      ["h1", "h2"],
    );
    assert.deepEqual(
      screenClosed(state, "h1").frames.map((f) => f.handle),
      ["h2"],
    );
    assert.equal(screensLoaded(state, []), state, "an empty reload leaves live cards alone");
  });

  it("a toast leaves on its own after four seconds", () => {
    const timeouts: Array<{ run: () => void; ms: number }> = [];
    const toasts = createToastsStore((run, ms) => timeouts.push({ run, ms }));
    toasts.notify("saved", "ok");
    toasts.notify("hello");
    assert.deepEqual(
      toasts.getState().items.map((t) => [t.id, t.text, t.tone]),
      [
        [1, "saved", "ok"],
        [2, "hello", "info"],
      ],
    );
    assert.deepEqual(
      timeouts.map((t) => t.ms),
      [TOAST_MS, TOAST_MS],
    );
    timeouts[0]!.run();
    toasts.dismiss(2);
    assert.deepEqual(toasts.getState().items, []);
  });

  it("persists layout into the keys earlier builds wrote, and a drag only when it ends", () => {
    const storage = memoryStorage({
      "studio.sidebarOpen": "false",
      "studio.chatWidth": "500",
      "studio.previewView": "assets",
    });
    const layout = createLayoutStore(storage);
    assert.deepEqual(
      { ...layout.getState() },
      { sidebarOpen: false, chatWidth: 500, stageView: "assets", chatDragWidth: null },
    );
    layout.setState((state) => chatWidthDragged(state, 900), true);
    layout.setState((state) => chatWidthDragged(state, 450), true);
    assert.equal(chatWidthOf(layout.getState()), 450);
    assert.deepEqual(storage.writes, [], "a drag in progress is not remembered");
    layout.setState((state) => chatWidthCommitted(state), true);
    assert.equal(storage.data.get("studio.chatWidth"), "450");
    assert.deepEqual(storage.writes, ["studio.chatWidth"], "only the key that changed is written");
    layout.setState((state) => chatWidthStepped(state, 1), true);
    assert.equal(storage.data.get("studio.chatWidth"), "470");
    assert.equal(chatWidthDragged(layout.getState(), 10).chatDragWidth, 320, "the chat keeps its limits");
    const fresh = createLayoutStore(memoryStorage({ "studio.chatWidth": "9000", "studio.previewView": "gone" }));
    assert.deepEqual(
      { ...fresh.getState() },
      { sidebarOpen: true, chatWidth: 434, stageView: "live", chatDragWidth: null },
    );
  });

  it("moves a chat left at the earlier default width to the current default, and keeps one a person set", () => {
    // Any layout change wrote the width, so 388 in storage is the earlier default, not a choice.
    const old = createLayoutStore(memoryStorage({ "studio.chatWidth": "388" }));
    assert.equal(old.getState().chatWidth, 434);
    assert.equal(createLayoutStore(memoryStorage({ "studio.chatWidth": "408" })).getState().chatWidth, 408);
  });

  it("never remembers a file opened beside the chat as the stage view", () => {
    const storage = memoryStorage({ "studio.previewView": "assets" });
    const layout = createLayoutStore(storage);
    layout.setState((state) => stageViewChosen(state, "file"), true);
    assert.equal(layout.getState().stageView, "file");
    assert.equal(storage.data.get("studio.previewView"), "assets");
    layout.setState((state) => stageViewChosen(state, "builds"), true);
    assert.equal(storage.data.get("studio.previewView"), "builds");
    assert.equal(createLayoutStore(memoryStorage({ "studio.previewView": "file" })).getState().stageView, "live");
  });

  it("keeps only the Settings model choices that differ from the rule, per engine", () => {
    const storage = memoryStorage({ "studio.models.picker": '{"codex":{"gpt-5.5":true,"bad":"yes"},"x":7}' });
    const picker = createModelPickerStore(storage);
    assert.deepEqual(picker.getState().choices, { codex: { "gpt-5.5": true } }, "malformed entries are dropped");
    const set = (engine: string, model: string, shown: boolean, byDefault: boolean) =>
      picker.setState((state) => pickerModelSet(state, { engine, model, shown, byDefault }), true);
    set("claude-code", "haiku", true, false);
    set("claude-code", "sonnet", false, true);
    assert.deepEqual(picker.getState().choices["claude-code"], { haiku: true, sonnet: false });
    set("claude-code", "sonnet", true, true);
    assert.deepEqual(picker.getState().choices["claude-code"], { haiku: true }, "back to the rule is forgotten");
    assert.equal(storage.data.get("studio.models.picker"), '{"codex":{"gpt-5.5":true},"claude-code":{"haiku":true}}');
    picker.setState((state) => pickerModelsReset(state, "claude-code"), true);
    assert.deepEqual(createModelPickerStore(storage).getState().choices, { codex: { "gpt-5.5": true } });
  });
});

describe("what each UI event makes the renderer read again", () => {
  const reads = (event: UiEvent) =>
    Object.entries(uiEventReads(event))
      .filter(([, value]) => value)
      .map(([key]) => key)
      .sort();
  const ev = (type: string, payload: unknown = {}): UiEvent => ({ type, payload }) as UiEvent;

  it("pulls logged events in live, and lists on their own changes", () => {
    for (const type of [
      "chat.message",
      "run.finished",
      "delegated.event",
      "plugin.consent",
      "improvement.applied",
      "coordinator.queued",
      "run.optimization",
    ]) {
      assert.deepEqual(reads(ev(type)), ["events"], type);
    }
    assert.deepEqual(reads(ev("thread.bound")), ["events", "threads"]);
    assert.deepEqual(reads(ev("game.changed")), ["events", "games", "threads"]);
    assert.deepEqual(reads(ev("skillopt.staged")), ["staged"]);
    assert.deepEqual(reads(ev("engines.changed")), ["engines"]);
    assert.deepEqual(reads(ev("model.pull", { model: "m", progress: { status: "pulling" } })), []);
    assert.deepEqual(reads(ev("model.pull", { model: "m", progress: { status: "success" } })), ["engines"]);
    assert.deepEqual(reads(ev("plugins.changed")), ["plugins"]);
    assert.deepEqual(reads(ev("harness.log")), []);
  });

  it("re-reads one game's assets on its plugin's word, and every watched game on an unnamed delivery", () => {
    assert.deepEqual(uiEventReads(ev("plugin.event", { id: "genex", event: {}, project: "pond" })).assets, {
      project: "pond",
    });
    assert.equal(uiEventReads(ev("plugin.event", { id: "genex", event: {} })).assets, null);
    assert.deepEqual(uiEventReads(ev("asset.delivered", { project: "pond" })).assets, { project: "pond" });
    assert.deepEqual(uiEventReads(ev("asset.delivered", {})).assets, { project: null });
    assert.deepEqual(uiEventReads(ev("asset.jobs", { project: "pond" })).assets, { project: "pond" });
    assert.equal(uiEventReads(ev("asset.jobs", {})).assets, null, "a change of jobs names its game");
  });
});

describe("the studio: one subscription, the bootstrap and the commands that span stores", () => {
  const boot = (overrides: Record<string, unknown> = {}) => ({
    threadId: "studio",
    layout: { runs: "/runs" },
    gamesRootLabel: "~/AI Games",
    harness: { state: "ready", version: null, capabilities: [] },
    threads: [studioThread, pond, rift],
    events: [envelope("e1", "pond-chat")],
    eventsCursor: "c1",
    games: [gameProject("pond"), gameProject("rift")],
    engines: [],
    threadStatus: { "pond-chat": { status: "building", since: 5 } },
    ...overrides,
  });

  function started(overrides: Parameters<typeof fakeStudioApi>[0] = {}, storage = memoryStorage()) {
    const timers = manualTimers();
    const fake = fakeStudioApi({ bootstrap: async () => boot() as never, ...overrides });
    const app = createStudio(fake.api, { storage, timers });
    const stop = app.start();
    return { fake, app, stop, timers, storage };
  }

  it("opens home, loads no preview, keeps the way back to the last chat, and asks nothing before the cursor", async () => {
    // Intentionally flipped: a launch used to reopen the remembered chat and load its game.
    const storage = memoryStorage({ "studio.activeThread": "rift-chat", "studio.lastGameThread": "rift-chat" });
    const { fake, app } = started({}, storage);
    assert.equal(app.session.getState().status, "loading");
    await tick();
    assert.equal(app.threads.getState().activeThreadId, null);
    assert.equal(roomOf(app.threads.getState()), Room.Home);
    assert.equal(projectOf(app.threads.getState()), null);
    assert.deepEqual(fake.callsOf("loadPreview"), [], "nothing is loaded behind home");
    assert.equal(app.session.getState().status, "ready");
    assert.equal(app.threads.getState().lastGameThreadId, "rift-chat", "⌘1 returns to the last game chat");
    assert.equal(storage.data.has("studio.reviewProject"), false);
    assert.equal(storage.data.get("studio.lastGameThread"), "rift-chat");
    assert.equal(storage.data.has("studio.activeThread"), true, "the opening does not rewrite the remembered chat");
    assert.deepEqual(app.threads.getState().status, { "pond-chat": { status: "building", since: 5 } });
    assert.equal(app.library.getState().runsRoot, "/runs");
    assert.equal(fake.callsOf("pluginsList").length, 1, "plugins are read once the bootstrap is ready");
  });

  it("an empty library opens home and loads no preview", async () => {
    // Intentionally flipped: an empty library used to open Create game over Studio.
    const { fake, app } = started({
      bootstrap: async () => boot({ threads: [studioThread], games: [], events: [] }) as never,
    });
    await tick();
    assert.equal(app.threads.getState().activeThreadId, null);
    assert.equal(roomOf(app.threads.getState()), Room.Home);
    assert.deepEqual(fake.callsOf("loadPreview"), []);
    assert.deepEqual(fake.callsOf("newGameThread"), [], "creation waits for an explicit name or folder");
  });

  it("offers the developer tools only when main says the run is unpackaged", async () => {
    const empty = { threads: [studioThread], games: [], events: [] };
    const developer = started({ bootstrap: async () => boot({ ...empty, developer: true }) as never });
    const packaged = started({ bootstrap: async () => boot(empty) as never });
    await tick();
    assert.equal(developer.app.session.getState().developer, true);
    assert.equal(packaged.app.session.getState().developer, false);
  });

  it("a first launch is welcomed once, and home follows the welcome", async () => {
    // Intentionally flipped: Create game used to follow the welcome.
    const empty = { threads: [studioThread], games: [], events: [] };
    const { app, storage, fake } = started({ bootstrap: async () => boot({ ...empty, welcome: true }) as never });
    await tick();
    assert.equal(app.session.getState().welcoming, true);
    app.finishWelcome();
    assert.equal(app.session.getState().welcoming, false);
    assert.equal(roomOf(app.threads.getState()), Room.Home);
    assert.deepEqual(fake.callsOf("createGame"), [], "no game is made for the welcome");
    assert.equal(storage.data.get("studio.welcomed"), "1");
    const again = started(
      { bootstrap: async () => boot({ ...empty, welcome: true }) as never },
      memoryStorage({ "studio.welcomed": "1" }),
    );
    await tick();
    assert.equal(again.app.session.getState().welcoming, false, "a profile is welcomed once");
    const session = started({ bootstrap: async () => boot({ ...empty, welcome: false }) as never });
    await tick();
    assert.equal(
      session.app.session.getState().welcoming,
      false,
      "a session that may not welcome (smoke, fixtures) does not",
    );
  });

  it("a build the chat put on screen for the game on the stage shows Live", async () => {
    const storage = memoryStorage({ "studio.previewView": "builds" });
    const { fake, app } = started({}, storage);
    await tick();
    app.selectThread("rift-chat");
    assert.equal(app.layout.getState().stageView, "builds");
    fake.emit({ type: "stage.show", payload: { project: "pond", view: "live" } });
    assert.equal(app.layout.getState().stageView, "builds", "another game's build leaves this stage alone");
    fake.emit({ type: "stage.show", payload: { project: "rift", view: "live" } });
    assert.equal(app.layout.getState().stageView, "live");
  });

  it("makes the copy of the game the bar's Remix closed the viewer on, as a card's Remix does", async () => {
    const { fake, app } = started();
    await tick();
    await app.play.open({ slug: "pond", title: "Pond", coverUrl: null });
    fake.emit({ type: "play.viewer", payload: { slug: "pond", openId: 1, phase: PlayViewerPhase.Playing } });
    fake.emit({
      type: "play.viewer",
      payload: { slug: "pond", openId: 1, phase: PlayViewerPhase.Closed, remix: true },
    });
    assert.deepEqual(fake.callsOf("playRemix"), [["pond"]]);
    assert.equal(app.play.getState().making?.slug, "pond", "Create shows the copy being made");
    assert.equal(app.play.getState().viewer, null);
    fake.emit({ type: "play.viewer", payload: { slug: "pond", openId: 1, phase: PlayViewerPhase.Closed } });
    assert.equal(fake.callsOf("playRemix").length, 1, "a plain closing makes nothing");
  });

  it("a downloaded update waits for a restart: read at the bootstrap, and announced while the studio runs", async () => {
    const before = started({ readyUpdate: async () => ({ version: "0.2.0", action: UpdateAction.Restart }) });
    await tick();
    assert.deepEqual(
      before.app.update.getState().ready,
      { version: "0.2.0", action: UpdateAction.Restart },
      "downloaded before this window opened",
    );
    const { fake, app } = started({ readyUpdate: async () => null });
    await tick();
    assert.equal(app.update.getState().ready, null);
    fake.emit({ type: "update.ready", payload: { version: "0.3.0", action: UpdateAction.Restart } });
    assert.deepEqual(app.update.getState().ready, { version: "0.3.0", action: UpdateAction.Restart });
    const unreadable = started({ readyUpdate: async () => Promise.reject(new Error("main is restarting")) });
    await tick();
    assert.equal(unreadable.app.update.getState().ready, null);
    assert.equal(unreadable.app.session.getState().status, "ready", "the studio opens without it");
  });

  it("agents that would not start show in the open studio: read at the bootstrap, announced, and Try again or a start clears them", async () => {
    const failed = { platform: "win32", phase: "ready", sandbox: null, failure: "srt-win acl stamp timed out" };
    const before = started({ bootState: async () => failed as never });
    await tick();
    assert.equal(before.app.agentsStart.getState().failure, "srt-win acl stamp timed out", "before this window opened");
    const retries: Array<() => Promise<unknown>> = [
      async () => ({ ...failed, failure: "EPERM: lstat AppData" }),
      async () => ({ platform: "win32", phase: "ready", sandbox: null }),
    ];
    const { fake, app } = started({ retrySandboxSetup: (() => retries.shift()?.()) as never });
    await tick();
    assert.equal(app.agentsStart.getState().failure, null);
    fake.emit({ type: "harness.start-failed", payload: { failure: "srt-win acl stamp timed out" } });
    assert.equal(app.agentsStart.getState().failure, "srt-win acl stamp timed out");
    await app.agentsStart.report();
    assert.deepEqual(fake.callsOf("reportSandboxSetup"), [["srt-win acl stamp timed out"]]);
    assert.equal(app.agentsStart.getState().report, SetupReport.Sent);
    const trying = app.agentsStart.retry();
    assert.equal(app.agentsStart.getState().retrying, true);
    await trying;
    assert.equal(app.agentsStart.getState().failure, "EPERM: lstat AppData", "a Try again that fails says why");
    assert.equal(app.agentsStart.getState().report, SetupReport.Idle, "a new failure gets a report of its own");
    await app.agentsStart.retry();
    assert.equal(app.agentsStart.getState().failure, null);
    assert.equal(fake.callsOf("retrySandboxSetup").length, 2);
    fake.emit({ type: "harness.start-failed", payload: { failure: "again" } });
    fake.emit({ type: "studio.ready", payload: { userData: "/u" } });
    assert.equal(app.agentsStart.getState().failure, null, "a studio that started has its agents");
  });

  it("a failed bootstrap says why, and a retry replaces it", async () => {
    let fail = true;
    const { app } = started({
      bootstrap: async () => {
        if (fail) throw new Error("core is not up");
        return boot() as never;
      },
    });
    await tick();
    assert.deepEqual(
      { status: app.session.getState().status, error: app.session.getState().error },
      { status: "failed", error: "core is not up" },
    );
    fail = false;
    await app.bootstrap();
    assert.equal(app.session.getState().status, "ready");
    assert.equal(app.session.getState().error, null);
  });

  it("the chat a wait on the person is for reads it as it comes and goes; another chat never does", async () => {
    const { fake, app } = started();
    await tick();
    app.selectThread("rift-chat");
    const label = () => personFirstLabel(app.threads.getState(), app.threads.getState().activeThreadId);
    assert.equal(label(), null);
    fake.emit({
      type: "lock.person-first",
      payload: { project: "rift", threadId: "rift-chat", label: "Unreal", waiting: true },
    });
    assert.equal(label(), "Unreal");
    fake.emit({
      type: "lock.person-first",
      payload: { project: "pond", threadId: "pond-chat", label: "Desk", waiting: true },
    });
    assert.equal(label(), "Unreal", "another chat's wait leaves this one's");
    fake.emit({
      type: "lock.person-first",
      payload: { project: "rift", threadId: "rift-chat", label: "Unreal", waiting: false },
    });
    assert.equal(label(), null);
  });

  it("feeds events from its one subscription and polls the log", async () => {
    const { fake, app, timers, stop } = started({ events: async () => ({ events: [], cursor: "c2" }) });
    await tick();
    const before = fake.callsOf("events").length;
    fake.emit({ type: "harness.status", payload: { all: { "rift-chat": { status: "director", since: 9 } } } });
    fake.emit({ type: "delegation.started", payload: { project: "pond", engine: "claude-code", active: 1 } });
    fake.emit({ type: "thread.bound", payload: { threadId: "rift-chat", project: "rift" } });
    await tick();
    assert.deepEqual(app.threads.getState().status, { "rift-chat": { status: "director", since: 9 } });
    assert.deepEqual([...app.library.getState().building], ["pond"]);
    assert.ok(fake.callsOf("threads").length >= 1);
    assert.ok(fake.callsOf("events").length > before);
    const polled = fake.callsOf("events").length;
    timers.fire(EVENT_POLL_MS);
    await tick();
    assert.equal(fake.callsOf("events").length, polled + 1);
    stop();
    assert.equal(fake.listeners("onEvent"), 0, "stopping unsubscribes");
  });

  it("opening a game starts nothing; opening the game Live holds on the stage again reloads it", async () => {
    // Intentionally flipped: opening a game used to load its preview.
    const moss = thread("moss-chat", { kind: "game", project: "moss" });
    const { fake, app, storage } = started({ threadForGame: async () => moss });
    await tick();
    const loads = fake.callsOf("loadPreview").length;
    const record = await app.enterProject("moss");
    await tick();
    assert.equal(record?.id, "moss-chat");
    assert.equal(app.threads.getState().activeThreadId, "moss-chat");
    assert.deepEqual(fake.callsOf("loadPreview").slice(loads), [], "the game waits for Play");
    assert.equal(app.threads.getState().liveProject, null, "Live holds no game");
    assert.equal(storage.data.get("studio.activeThread"), "moss-chat");
    assert.ok(fake.callsOf("games").length >= 1);
    await app.enterProject("moss");
    await tick();
    assert.deepEqual(fake.callsOf("loadPreview").slice(loads), [], "opening it again still starts nothing");
    fake.emit({ type: "preview.identity", payload: { project: "moss", head: null, state: "loading", error: null } });
    assert.equal(app.threads.getState().liveProject, "moss", "a load holds Live from its start");
    await app.enterProject("moss");
    await tick();
    assert.deepEqual(
      fake.callsOf("loadPreview").slice(loads),
      [["moss"]],
      "opening the game Live holds on the stage again reloads it, as the sidebar always did",
    );
  });

  it("switching games keeps the game Live holds as it was left and starts no other", async () => {
    // Intentionally flipped: switching to another game used to load it, ending the one in Live.
    const chats: Record<string, ConversationRecord> = { pond, rift };
    const { fake, app } = started({ threadForGame: async (name: string) => chats[name] ?? pond });
    await tick();
    await app.enterProject("pond");
    fake.emit({ type: "preview.identity", payload: { project: "pond", head: null, state: "loaded", error: null } });
    await tick();
    const loads = fake.callsOf("loadPreview").length;
    await app.enterProject("rift");
    await tick();
    assert.equal(app.threads.getState().activeThreadId, "rift-chat");
    assert.equal(app.threads.getState().liveProject, "pond", "Live keeps the game it holds, out of sight");
    app.selectThread("pond-chat");
    app.selectThread("rift-chat");
    app.goHome();
    await app.enterProject("pond");
    await tick();
    assert.deepEqual(fake.callsOf("loadPreview").slice(loads), [], "no switch loads a game");
    assert.equal(app.threads.getState().liveProject, "pond", "the game comes back as it was left");
    fake.emit({ type: "preview.identity", payload: { project: "pond", head: null, state: "failed", error: "boom" } });
    assert.equal(app.threads.getState().liveProject, null, "a failed load leaves Live holding no game");
  });

  it("a refused open is toasted in plain words", async () => {
    const { app } = started({
      threadForGame: async () => {
        throw new Error('a contractor is building in "skate" right now — wait for it to finish before landing a build');
      },
    });
    await tick();
    assert.equal(await app.enterProject("skate"), null);
    assert.equal(app.toasts.getState().items[0]?.tone, "err");
  });

  it("removing the stage's game opens home; removing another game leaves the stage", async () => {
    // Intentionally flipped: removing the game on the stage used to open Studio.
    const storage = memoryStorage({ "studio.reviewProject": "pond" });
    const { app } = started({}, storage);
    await tick();
    app.selectThread("pond-chat");
    assert.equal(await app.removeGame("rift"), false);
    assert.equal(app.threads.getState().activeThreadId, "pond-chat");
    assert.equal(await app.removeGame("pond"), true);
    assert.equal(app.threads.getState().activeThreadId, null);
    assert.equal(roomOf(app.threads.getState()), Room.Home);
    assert.equal(storage.data.has("studio.reviewProject"), false);
    assert.equal(storage.data.has("studio.lastGameThread"), false);
    assert.deepEqual(
      app.library.getState().games.map((g) => g.name),
      [],
    );
  });

  it("the engines refresh a surface is handed stays one function while the list it reads changes", async () => {
    // Settings re-renders on every engines update and keys an effect on the refresh it is handed.
    // A surface handed the store's own refresh reads once per open; one handed a new closure per
    // render reads, lands a new list, re-renders and reads again for as long as it stays open.
    let reads = 0;
    const { app } = started({
      engines: async () => {
        reads += 1;
        return [{ id: `engine-${reads}` }] as never;
      },
    });
    await tick();
    const openSettings = async (handed: () => () => unknown): Promise<number> => {
      let keyedOn: unknown = null;
      let effectRuns = 0;
      const render = (): void => {
        const refresh = handed();
        if (refresh === keyedOn || effectRuns >= 3) return;
        keyedOn = refresh;
        effectRuns += 1;
        void refresh();
      };
      const unsubscribe = app.engines.subscribe(render);
      render();
      for (let i = 0; i < 5; i++) await tick();
      unsubscribe();
      return effectRuns;
    };
    const refresh = app.engines.refresh;
    const before = reads;
    assert.equal(await openSettings(() => app.engines.refresh), 1, "one open of Settings is one read");
    assert.equal(reads, before + 1);
    assert.equal(app.engines.refresh, refresh, "the store hands out the same refresh after an update");
    assert.deepEqual(
      app.engines.getState().list.map((engine) => engine.id),
      [`engine-${reads}`],
      "the read did land a new list",
    );
    assert.equal(await openSettings(() => () => void app.engines.refresh()), 3, "a closure per render keeps reading");
  });

  it("sends from the open chat, then reads the log, the games and the threads", async () => {
    const { fake, app } = started();
    await tick();
    app.selectThread("pond-chat");
    const reads = {
      events: fake.callsOf("events").length,
      games: fake.callsOf("games").length,
      threads: fake.callsOf("threads").length,
    };
    await app.send("make it rain", { engine: "claude-code" });
    await tick();
    assert.deepEqual(fake.callsOf("send").at(-1), ["make it rain", { thread: "pond-chat", engine: "claude-code" }]);
    assert.equal(fake.callsOf("events").length, reads.events + 1);
    assert.equal(fake.callsOf("games").length, reads.games + 1);
    assert.equal(fake.callsOf("threads").length, reads.threads + 1);
  });
});

/** Every renderer source file: the selector rule is about the whole tree, not one panel. */
function rendererFiles(): string[] {
  const root = path.resolve(fileURLToPath(new URL("../../src/renderer", import.meta.url)));
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => path.join(root, file));
}

describe("Settings → Permissions: Let agents control your computer", () => {
  it("is off unless the host's settings say it is on, and offered only on macOS and Windows", () => {
    assert.equal(computerControlOn(null), false, "before the settings load");
    assert.equal(computerControlOn({ learning: true, selfImproving: false }), false, "an older host's view");
    assert.equal(computerControlOn({ learning: true, selfImproving: false, computerControl: false }), false);
    assert.equal(computerControlOn({ learning: true, selfImproving: false, computerControl: true }), true);
    assert.equal(computerControlOffered(StudioPlatform.Mac), true);
    assert.equal(computerControlOffered(StudioPlatform.Windows), true, "the desktop driver ships on Windows too");
    for (const platform of [StudioPlatform.Linux, ""])
      assert.equal(computerControlOffered(platform), false, platform || "before main answered");
  });

  it("stops by a shortcut each system can register: no Command key on Windows, and not Task Manager's", () => {
    const mac = desktopStopShortcut(StudioPlatform.Mac);
    const windows = desktopStopShortcut(StudioPlatform.Windows);
    assert.equal(mac.accelerator, "Control+Alt+Command+Escape");
    assert.equal(stopShortcutWords(mac), "Control-Option-Command-Escape (⌃⌥⌘Esc)");
    assert.equal(windows.accelerator, "Control+Alt+Shift+Escape");
    assert.doesNotMatch(windows.accelerator, /Command|Cmd|Super|Meta/);
    assert.notEqual(windows.accelerator, "Control+Shift+Escape");
    assert.equal(stopShortcutWords(windows), "Ctrl+Alt+Shift+Esc");
    assert.match(computerControlDetail(StudioPlatform.Windows), /Ctrl\+Alt\+Shift\+Esc stops it/);
    assert.match(computerControlDetail(StudioPlatform.Mac), /⌃⌥⌘Esc stops it/);
  });

  it("the switch sends only this setting and shows what the host saved", async () => {
    const fake = fakeStudioApi();
    fake.stub("setSettings", async () => ({ learning: true, selfImproving: false, computerControl: false }));
    const view = await setComputerControl(fake.api, true);
    assert.deepEqual(fake.callsOf("setSettings"), [[{ computerControl: true }]]);
    assert.equal(computerControlOn(view), false, "the switch follows the host's answer, not the click");
  });
});

describe("components read the stores through selectors", () => {
  it("never calls a store hook without one, and never reaches a store's whole state", () => {
    const offenders: string[] = [];
    for (const file of rendererFiles()) {
      const source = readFileSync(file, "utf8");
      const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
      const name = path.relative(root, file).split(path.sep).join("/");
      for (const hit of source.matchAll(
        /\buse(?:Session|EventLog|Threads|Library|Engines|Plugins|AgentScreens|Toasts|Layout)\(\s*\)/g,
      ))
        offenders.push(`${name}: ${hit[0]}`);
      // zustand's own hook takes the store and the selector; one argument returns the whole state.
      for (const hit of source.matchAll(/\buseStore\(\s*[^,()]+(?:\([^()]*\))?[^,()]*\)/g))
        offenders.push(`${name}: ${hit[0]}`);
      if (
        !name.startsWith("src/renderer/state/") &&
        /from ["']zustand(?:\/[a-z]+)?["']/.test(source) &&
        !/from ["']zustand\/react\/shallow["']/.test(source)
      ) {
        offenders.push(`${name}: imports zustand directly (read stores through state/hooks.ts)`);
      }
    }
    assert.deepEqual(offenders, [], "select what the component shows; wrap objects and arrays in useShallow");
  });
});
