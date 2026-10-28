/**
 * The workspace's usage analytics (plan §1.4): home, launching and opening games, navigation and
 * Settings. Each event's properties come from pure builders and in-memory trackers on clocks the
 * test holds, and from the area's observers over real stores; every property is a kind, a switch, a
 * count, a bucket or a duration — never a game's name, a folder, a path, words someone wrote or an id.
 */
import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";
import type { PostHog } from "posthog-js";
import { ThemeImportProblem, importTheme, Scheme, themeImportProblem } from "../../src/renderer/appearance/themes.ts";
import { startAnalytics } from "../../src/renderer/analytics/client.ts";
import { createWorkspaceObservers, WorkspaceEvent } from "../../src/renderer/analytics/events/workspace.ts";
import { GAME_REFS_MAX, gameRef } from "../../src/renderer/analytics/game-ref.ts";
import { CharsBucket, CountBucket } from "../../src/renderer/analytics/properties.ts";
import {
  ageBucket,
  appearanceFieldsChanged,
  effortOf,
  exportFinishedProperties,
  freedProperties,
  gameCreatedProperties,
  gameManagedProperties,
  gameOpenedProperties,
  homeLeftTo,
  homeWords,
  launchHandedProperties,
  launchStartedProperties,
  noticeOpenedProperties,
  providerEngine,
  searchClosedProperties,
  sheetClosedProperties,
  sheetViewedProperties,
  sizeBucket,
  stageChangedProperties,
} from "../../src/renderer/analytics/workspace-properties.ts";
import {
  createHomeVisit,
  createNote,
  createQuietFields,
  createSettingsVisit,
  NAV_NOTE_MS,
  noteStageSwitch,
} from "../../src/renderer/analytics/workspace-trackers.ts";
import {
  ActionOutcome,
  AgeBucket,
  DismissVia,
  DraftSource,
  FolderPickOutcome,
  FreeSpaceAnswer,
  GameAction,
  GameCreatedFrom,
  HomeLeftTo,
  HomeWords,
  LaunchFailReason,
  LaunchMode,
  LaunchStage,
  ManageVia,
  NavVia,
  NoticeVia,
  NoticeWent,
  SearchOutcome,
  SearchTarget,
  SheetOutcome,
  SizeBucket,
  StageSwitchVia,
  StorageSurface,
} from "../../src/renderer/analytics/workspace-vocabulary.ts";
import { NoticeKind, NoticeTone } from "../../src/renderer/notifications.ts";
import { inspectPickedFolder } from "../../src/renderer/open-folder.ts";
import { SettingsSection } from "../../src/renderer/settings-navigation.ts";
import { StageView } from "../../src/renderer/stage.ts";
import { type Launch, LaunchPhase } from "../../src/renderer/state/launch.ts";
import { stageViewChosen } from "../../src/renderer/state/layout.ts";
import { createStudio } from "../../src/renderer/state/studio.ts";
import { Room } from "../../src/renderer/state/threads.ts";
import { ToastTone } from "../../src/renderer/state/toasts.ts";
import { type KeyValueStorage, STORAGE_KEYS } from "../../src/renderer/storage.ts";
import type { FolderInspection, GameProject } from "../../src/shared/game-project.ts";
import { DAY_MS, HOUR_MS } from "../../src/shared/duration.ts";
import { ReasoningEffort } from "../../src/shared/model-preferences.ts";
import { EngineId } from "../../src/shared/providers.ts";
import type { Bootstrap } from "../../src/shared/studio-api.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Words, names, paths and ids a person's work could put anywhere: none may reach a property. */
const HOSTILE = [
  "/Users/alice/Games/Secret Dungeon",
  "C:\\Users\\bob\\AI Games\\heist",
  "file:///Users/alice/heist/index.html#start",
  "~/coding/alice-private",
  "Alice's Secret Dungeon",
  "thread-8f2c1a9e",
  "sk-ant-api03-hostile",
  'quote"<script>alert(1)</script>',
] as const;
/** The tell-tale pieces of HOSTILE: any one of them in a property means something leaked. */
const TELLS = ["alice", "bob", "secret", "heist", "8f2c1a9e", "sk-ant", "<script", "users"];

function assertClean(properties: unknown, what: string): void {
  const text = JSON.stringify(properties).toLowerCase();
  for (const tell of TELLS) assert.ok(!text.includes(tell), `${what} leaked "${tell}": ${text}`);
}

function memoryStorage(seed: Record<string, string> = {}): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const project = (name: string, extra: Partial<GameProject> = {}): GameProject =>
  ({ name, title: name, dir: `/Users/alice/${name}`, pathLabel: `~/${name}`, createdAt: "", ...extra }) as GameProject;

describe("the workspace's buckets", () => {
  it("sizes and ages fall in their steps, and clocks that jump back read as the youngest", () => {
    assert.equal(sizeBucket(0), SizeBucket.Small);
    assert.equal(sizeBucket(1024 ** 3 - 1), SizeBucket.Small);
    assert.equal(sizeBucket(1024 ** 3), SizeBucket.Medium);
    assert.equal(sizeBucket(6 * 1024 ** 3), SizeBucket.Large);
    assert.equal(sizeBucket(50 * 1024 ** 3), SizeBucket.Huge);
    assert.equal(ageBucket(-5), AgeBucket.Hour);
    assert.equal(ageBucket(HOUR_MS), AgeBucket.Day);
    assert.equal(ageBucket(2 * DAY_MS), AgeBucket.Week);
    assert.equal(ageBucket(10 * DAY_MS), AgeBucket.Month);
    assert.equal(ageBucket(90 * DAY_MS), AgeBucket.Older);
  });

  it("only the app's own engines and efforts pass; anything typed is null", () => {
    assert.equal(providerEngine(EngineId.Codex), EngineId.Codex);
    assert.equal(effortOf(ReasoningEffort.High), ReasoningEffort.High);
    for (const typed of HOSTILE) {
      assert.equal(providerEngine(typed), null);
      assert.equal(effortOf(typed), null);
    }
    assert.equal(providerEngine(null), null);
  });
});

describe("home and its launch", () => {
  it("a launch's shape leaves, never its words, its model or the folder chosen", () => {
    const properties = launchStartedProperties(
      {
        text: `${HOSTILE[4]} — make it like ${HOSTILE[0]}`,
        extras: { reviewPlan: true, mentions: [], frames: [] },
        modelKey: `${EngineId.ClaudeCode}::${HOSTILE[5]}`,
        effort: ReasoningEffort.High,
        parent: HOSTILE[1],
      },
      { fromSuggestion: false, fromWelcomeIdea: true, games: 3 },
    );
    assert.deepEqual(properties, {
      chars_bucket: CharsBucket.Medium,
      from_suggestion: false,
      from_welcome_idea: true,
      mode: LaunchMode.Auto,
      review_plan: true,
      pictures: 0,
      mentions: 0,
      engine: EngineId.ClaudeCode,
      effort: ReasoningEffort.High,
      custom_location: true,
      games_bucket: CountBucket.Few,
    });
    assertClean(properties, "game_launch_started");
    const custom = launchStartedProperties(
      { text: "x", modelKey: `${HOSTILE[2]}::m`, effort: HOSTILE[3] },
      { fromSuggestion: true, fromWelcomeIdea: false, games: 0 },
    );
    assert.equal(custom.engine, null, "an engine nobody ships is never named");
    assert.equal(custom.effort, null);
    assert.equal(custom.custom_location, false);
  });

  it("a game made is counted with its creation time and a random ref, not its name", () => {
    const created = gameCreatedProperties({
      from: GameCreatedFrom.Home,
      startedAt: 1_000,
      at: 3_500,
      customLocation: false,
      provisional: true,
      games: 1,
      ref: "0123456789abcdef",
    });
    assert.deepEqual(created, {
      from: GameCreatedFrom.Home,
      create_ms: 2_500,
      custom_location: false,
      provisional: true,
      games_bucket: CountBucket.One,
      game_ref: "0123456789abcdef",
    });
  });

  it("a launch is handed over once, timed from when its message left home", () => {
    const opened: Launch = {
      id: "l1",
      text: HOSTILE[4],
      extras: undefined,
      at: 10_000,
      phase: LaunchPhase.Opened,
      title: HOSTILE[4],
      project: HOSTILE[0],
      threadId: HOSTILE[5],
      known: [],
    };
    const handed = { ...opened, phase: LaunchPhase.Handed };
    const properties = launchHandedProperties(opened, handed, 14_250, "ref");
    assert.deepEqual(properties, { total_ms: 4_250, game_ref: "ref" });
    assertClean(properties, "game_launch_handed");
    assert.equal(launchHandedProperties(handed, handed, 20_000, "ref"), null, "only the step into Handed counts");
    assert.equal(launchHandedProperties(handed, null, 20_000, null), null);
  });

  it("a visit: the first home is the launch's, a note wins, and the first words say where they came from", () => {
    const notes = createNote<NavVia>();
    const visit = createHomeVisit(notes);
    assert.equal(visit.via(0), NavVia.Launch, "the window's first home, asked for by nobody");
    visit.viewed(0, null);
    assert.equal(visit.drafted("", 100), null, "no words, nothing started");
    const started = visit.drafted(HOSTILE[4], 1_500);
    assert.deepEqual(started, { ms_since_home_viewed: 1_500, source: DraftSource.Typed });
    assert.equal(visit.drafted(`${HOSTILE[4]} more`, 2_000), null, "once a visit");
    const discarded = visit.left(HOSTILE[0], homeLeftTo(Room.Build), 61_000);
    assert.deepEqual(discarded, {
      chars_bucket: CharsBucket.Short,
      from_suggestion: false,
      dwell_ms: 61_000,
      left_to: HomeLeftTo.Game,
    });
    assertClean([started, discarded], "home visit");

    notes.note(NavVia.Wordmark, 70_000);
    assert.equal(visit.via(70_500), NavVia.Wordmark, "a fresh note names the way in");
    assert.equal(visit.via(71_000), NavVia.Other, "a note is read once; later homes are other");
    visit.viewed(71_000, null);
    assert.deepEqual(visit.suggested(""), { nth_in_visit: 1, draft_was_empty: true });
    assert.deepEqual(visit.suggested(HOSTILE[4]), { nth_in_visit: 2, draft_was_empty: false });
    assert.equal(visit.drafted(HOSTILE[4], 72_000)?.source, DraftSource.Suggestion);
    assert.deepEqual(visit.launched(), { fromSuggestion: true, fromWelcomeIdea: false });
    assert.equal(visit.left(HOSTILE[4], HomeLeftTo.Other, 80_000), null, "a draft that left as a launch is not lost");

    visit.viewed(90_000, DraftSource.WelcomeIdea);
    assert.equal(visit.drafted(HOSTILE[4], 90_100)?.source, DraftSource.WelcomeIdea);
  });

  it("what home came up with, and where the person went", () => {
    assert.equal(homeWords(true, HOSTILE[0]), HomeWords.FailedLaunch);
    assert.equal(homeWords(false, HOSTILE[0]), HomeWords.WelcomeIdea);
    assert.equal(homeWords(false, null), HomeWords.None);
    assert.equal(homeLeftTo(Room.Studio), HomeLeftTo.Harness);
    assert.equal(homeLeftTo(Room.Home), HomeLeftTo.Other);
  });

  it("a note keeps only while fresh, and never from the future", () => {
    const note = createNote<StageSwitchVia>(NAV_NOTE_MS);
    note.note(StageSwitchVia.Tab, 1_000);
    assert.equal(note.take(1_000 + NAV_NOTE_MS + 1, StageSwitchVia.Other), StageSwitchVia.Other, "stale");
    note.note(StageSwitchVia.Tab, 5_000);
    assert.equal(note.take(4_000, StageSwitchVia.Other), StageSwitchVia.Other, "a clock that went back");
  });
});

/** A folder with two games in it, named and placed as a person's could be. */
function inspection(): FolderInspection {
  const preflight = (needsInstall: boolean, git: "none" | "repo") => ({
    entry: "index.html",
    build: null,
    serve: ".",
    install: needsInstall ? "npm install" : null,
    needsInstall,
    contract: "loaded" as const,
    git,
    nested: [],
    problems: ["/Users/alice/heist has no page"],
    warnings: [],
    writes: ["studio.json", "/Users/alice/.secret"],
  });
  const shape = { entry: "index.html", main: "src/main.js", build: null, install: null, own: true, serve: "." };
  return {
    dir: HOSTILE[0],
    pathLabel: HOSTILE[3],
    candidates: [
      {
        rel: "heist",
        dir: `${HOSTILE[0]}/heist`,
        shape: { ...shape, kind: "phaser" },
        why: [HOSTILE[4]],
        pathLabel: HOSTILE[1],
        preflight: preflight(true, "repo"),
      },
      {
        rel: "alice-secret",
        dir: HOSTILE[2],
        shape: { ...shape, kind: "engine-export" },
        why: [],
        pathLabel: HOSTILE[2],
        preflight: preflight(false, "none"),
      },
    ],
    suggested: "heist",
    nested: [HOSTILE[0], HOSTILE[1]],
    starter: [],
    ownFiles: false,
    webStarter: false,
  };
}

describe("opening a folder", () => {
  it("the sheet is counted by what the folder holds, never by its names or paths", () => {
    const viewed = sheetViewedProperties(inspection());
    assert.deepEqual(viewed, {
      candidates: 2,
      must_choose: true,
      suggested_kind: "phaser",
      nested_repos: 2,
      engine_export: true,
      needs_install: true,
      problems: 1,
      git: "repo",
    });
    assertClean(viewed, "open_folder_sheet_viewed");
  });

  it("the sheet's end: put away by its Cancel, or adopted with how long adopting took", () => {
    const facts = { shownAt: 1_000, changedOption: true, detailsOpened: false, trustToggled: true, kind: null };
    assert.deepEqual(
      sheetClosedProperties(facts, { outcome: SheetOutcome.Dismissed, at: 9_000, via: DismissVia.Cancel }),
      {
        outcome: SheetOutcome.Dismissed,
        via: DismissVia.Cancel,
        dwell_ms: 8_000,
        changed_option: true,
        details_opened: false,
        trust_toggled: true,
        kind: null,
      },
    );
    const adopted = sheetClosedProperties(
      { ...facts, kind: "three-vite" },
      { outcome: SheetOutcome.Adopted, at: 12_000, adoptStartedAt: 10_000, via: DismissVia.Close },
    );
    assert.equal(adopted.dwell_ms, 9_000, "dwell ends at the answer, not after adopting");
    assert.equal(adopted.adopt_ms, 2_000);
    assert.equal(adopted.via, undefined, "only a sheet put away says how");
  });

  it("the picker and the inspection are timed apart, and a refusal is counted before it is thrown on", async () => {
    let clock = 0;
    const now = () => clock;
    const reports: unknown[] = [];
    const cancelled = await inspectPickedFolder(
      {
        pickProject: async () => {
          clock += 4_000;
          return null;
        },
        inspectFolder: async () => inspection(),
      },
      (picked) => reports.push(picked),
      now,
    );
    assert.equal(cancelled, null);
    const picked = await inspectPickedFolder(
      {
        pickProject: async () => {
          clock += 1_000;
          return HOSTILE[0];
        },
        inspectFolder: async () => {
          clock += 250;
          return inspection();
        },
      },
      (report) => reports.push(report),
      now,
    );
    assert.equal(picked?.suggested, "heist");
    await assert.rejects(
      inspectPickedFolder(
        {
          pickProject: async () => HOSTILE[1],
          inspectFolder: async () => {
            clock += 10;
            throw new Error(`${HOSTILE[1]} is protected`);
          },
        },
        (report) => reports.push(report),
        now,
      ),
      /protected/,
    );
    assert.deepEqual(reports, [
      { outcome: FolderPickOutcome.Cancelled, pick_ms: 4_000 },
      { outcome: FolderPickOutcome.Picked, pick_ms: 1_000, inspect_ms: 250 },
      { outcome: FolderPickOutcome.Refused, pick_ms: 0, inspect_ms: 10, code: null },
    ]);
    assertClean(reports, "open_folder_picked");
  });
});

describe("finding, opening and managing games", () => {
  it("a game opened: where its row sat, whether pinned, and how long it took", () => {
    const opened = gameOpenedProperties({
      via: NavVia.Sidebar,
      game: { pinned: true },
      index: 7,
      startedAt: 100,
      at: 340,
      reload: false,
      ref: "ref",
    });
    assert.deepEqual(opened, {
      via: NavVia.Sidebar,
      pinned: true,
      sidebar_index_bucket: CountBucket.Several,
      open_ms: 240,
      reload: false,
      game_ref: "ref",
    });
    const rowless = gameOpenedProperties({
      via: NavVia.Other,
      game: null,
      index: -1,
      startedAt: 0,
      at: 0,
      reload: true,
      ref: null,
    });
    assert.equal(rowless.sidebar_index_bucket, null, "a game with no row has no place");
    assert.equal(rowless.pinned, false);
  });

  it("search's end names the result by its place and kind, never by what was typed or found", () => {
    const opened = searchClosedProperties({
      picked: { index: 2, earlierChat: true },
      query: HOSTILE[4],
      results: 4,
      noResultsSeen: true,
      openedAt: 1_000,
      at: 4_000,
    });
    assert.deepEqual(opened, {
      outcome: SearchOutcome.Opened,
      query_chars_bucket: CharsBucket.Short,
      results_count: 4,
      result_index: 2,
      target: SearchTarget.EarlierChat,
      no_results_seen: true,
      dwell_ms: 3_000,
    });
    const dismissed = searchClosedProperties({
      picked: null,
      query: "",
      results: 0,
      noResultsSeen: false,
      openedAt: 0,
      at: 10,
    });
    assert.equal(dismissed.outcome, SearchOutcome.Dismissed);
    assert.equal("result_index" in dismissed, false);
    assertClean([opened, dismissed], "game_search_closed");
  });

  it("managing a game says how old it was, and an unreadable creation time says nothing", () => {
    const now = Date.parse("2026-10-27T12:00:00Z");
    const managed = gameManagedProperties({
      action: GameAction.Renamed,
      via: ManageVia.ChatHeader,
      outcome: ActionOutcome.Ok,
      game: { createdAt: "2026-10-27T11:30:00Z" },
      at: now,
      ref: "ref",
    });
    assert.equal(managed.ms_since_created_bucket, AgeBucket.Hour);
    const unknown = gameManagedProperties({
      action: GameAction.Removed,
      via: ManageVia.Menu,
      outcome: ActionOutcome.Cancelled,
      game: { createdAt: HOSTILE[0] },
      at: now,
      ref: null,
    });
    assert.equal(unknown.ms_since_created_bucket, null);
    assertClean([managed, unknown], "game_managed");
  });

  it("an export is counted by its files, never by their names or where they went", () => {
    const done = exportFinishedProperties(
      { files: 12, excluded: [HOSTILE[0], HOSTILE[2], ".env"] },
      { startedAt: 0, at: 5_000, ref: "ref" },
    );
    assert.deepEqual(done, {
      outcome: ActionOutcome.Ok,
      files_bucket: CountBucket.Several,
      excluded_bucket: CountBucket.Few,
      export_ms: 5_000,
      game_ref: "ref",
    });
    assert.deepEqual(exportFinishedProperties(null, { startedAt: 0, at: 1, ref: null }), {
      outcome: ActionOutcome.Failed,
      code: null,
      export_ms: 1,
      game_ref: null,
    });
    assertClean(done, "game_export_finished");
  });

  it("freeing space says how much in buckets and how many games were busy, never which", () => {
    const freed = freedProperties(StorageSurface.ChatHeader, 6 * 1024 ** 3, {
      freedBytes: 2 * 1024 ** 3,
      skipped: [HOSTILE[4], HOSTILE[0]],
    });
    assert.deepEqual(freed, {
      surface: StorageSurface.ChatHeader,
      answer: FreeSpaceAnswer.Free,
      freeable_bucket: SizeBucket.Large,
      freed_bucket: SizeBucket.Medium,
      skipped_games: 2,
      failed: false,
    });
    assert.equal(freedProperties(StorageSurface.Settings, 0, null).failed, true);
    assertClean(freed, "free_space_answered");
  });

  it("a stage switch says from, to, what moved it and how long the last view stayed", () => {
    assert.deepEqual(
      stageChangedProperties({
        from: StageView.Live,
        to: StageView.Builds,
        via: StageSwitchVia.AutoRunStarted,
        since: 1_000,
        at: 31_000,
        running: true,
      }),
      {
        from: StageView.Live,
        to: StageView.Builds,
        via: StageSwitchVia.AutoRunStarted,
        from_dwell_ms: 30_000,
        run_running: true,
      },
    );
  });

  it("a notification is counted by its kind, never its words, chat or game", () => {
    const opened = noticeOpenedProperties(
      {
        kind: NoticeKind.Build,
        tone: NoticeTone.Failed,
        waiting: false,
        at: "2026-10-27T12:00:00Z",
      },
      { via: NoticeVia.SystemNotification, went: NoticeWent.Thread, now: Date.parse("2026-10-27T12:10:00Z") },
    );
    assert.deepEqual(opened, {
      kind: NoticeKind.Build,
      tone: NoticeTone.Failed,
      waiting: false,
      via: NoticeVia.SystemNotification,
      age_ms: 600_000,
      went: NoticeWent.Thread,
    });
    const hostile = noticeOpenedProperties(
      { kind: NoticeKind.Question, waiting: true, at: HOSTILE[5] },
      { via: NoticeVia.Panel, went: NoticeWent.Nowhere, now: 0 },
    );
    assert.equal(hostile.age_ms, null);
    assert.equal(hostile.tone, null);
    assertClean([opened, hostile], "notice_opened");
  });
});

describe("Settings", () => {
  it("one visit: where it went, what changed or failed, and how long it was open", () => {
    const visit = createSettingsVisit();
    assert.equal(visit.closed(0), null, "nothing open, nothing counted");
    assert.equal(visit.opened(SettingsSection.Providers, 1_000), true);
    assert.equal(visit.opened(SettingsSection.Games, 1_100), false, "a second open is the same visit");
    visit.section(SettingsSection.Games);
    visit.section(SettingsSection.Providers);
    visit.changed(false);
    visit.changed(true);
    visit.errored();
    assert.deepEqual(visit.closed(31_000), {
      last_section: SettingsSection.Providers,
      dwell_ms: 30_000,
      sections_visited: 2,
      changes: 2,
      errors_seen: 2,
    });
    assert.equal(visit.closed(32_000), null, "closed once");
    visit.changed(false);
    assert.equal(visit.open(), false, "a change outside a visit opens nothing");
  });

  it("appearance changes name the settings' own fields, never a preset's name", () => {
    const before = { mode: "system", light: { preset: "a" }, saved: [] };
    const after = { mode: "dark", light: { preset: "a" }, saved: [{ id: "custom:1", name: HOSTILE[4] }], extra: 1 };
    const fields = appearanceFieldsChanged(before, after);
    assert.deepEqual(fields, ["mode", "saved"]);
    assertClean(fields, "appearance fields");
  });

  it("a slider dragged across its range is one change, counted once it keeps still", () => {
    const pending = new Map<number, () => void>();
    let next = 0;
    const timers = {
      setTimeout: (run: () => void) => {
        next += 1;
        pending.set(next, run);
        return next;
      },
      clearTimeout: (handle: unknown) => {
        if (typeof handle === "number") pending.delete(handle);
      },
    };
    const settled: string[] = [];
    const changed = createQuietFields((field) => settled.push(field), 1_000, timers);
    changed(["light"]);
    changed(["light"]);
    changed(["light", "mode"]);
    assert.equal(pending.size, 2, "one wait per field, the last one");
    for (const run of [...pending.values()]) run();
    assert.deepEqual(settled.sort(), ["light", "mode"]);
  });

  it("a theme's import names its problem by a code, and keeps the person's message", () => {
    assert.throws(
      () => importTheme("{ not json", Scheme.Dark),
      (error: unknown) => themeImportProblem(error) === ThemeImportProblem.NotJson,
    );
    assert.throws(
      () => importTheme(JSON.stringify({ colors: {} }), Scheme.Dark),
      (error: unknown) => themeImportProblem(error) === ThemeImportProblem.NoColors && error instanceof Error,
    );
    assert.equal(themeImportProblem(new Error(HOSTILE[0])), null, "any other failure has no code");
  });
});

describe("a game's ref", () => {
  it("is drawn at random once per game, kept, and never derived from the name", () => {
    const storage = memoryStorage();
    const draws = ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"];
    const random = () => draws.shift() ?? "cccccccccccccccc";
    assert.equal(gameRef(HOSTILE[4], storage, random), "aaaaaaaaaaaaaaaa");
    assert.equal(gameRef(HOSTILE[4], storage, random), "aaaaaaaaaaaaaaaa", "the same game keeps its ref");
    assert.equal(gameRef(HOSTILE[0], storage, random), "bbbbbbbbbbbbbbbb", "another game gets its own");
    assert.equal(gameRef(null, storage, random), null);
    assert.equal(gameRef("", storage, random), null);
    const drawn = gameRef("2048", storage);
    assert.match(drawn ?? "", /^[0-9a-f]{16}$/);
    assertClean([gameRef(HOSTILE[4], storage), drawn], "game_ref");
  });

  it("a draw that is not a ref, or a kept list that is not one, is never trusted", () => {
    const storage = memoryStorage({ [STORAGE_KEYS.analyticsGames]: JSON.stringify([["x", HOSTILE[0]], "junk", 4]) });
    const ref = gameRef("x", storage, () => HOSTILE[5]);
    assert.match(ref ?? "", /^[0-9a-f]{16}$/, "a malformed kept ref and a malformed draw both give way");
    assert.notEqual(ref, HOSTILE[0]);
    const unreadable = memoryStorage({ [STORAGE_KEYS.analyticsGames]: "{not json" });
    assert.match(gameRef("y", unreadable) ?? "", /^[0-9a-f]{16}$/);
  });

  it("keeps at most GAME_REFS_MAX games, the oldest forgotten first", () => {
    const storage = memoryStorage();
    for (let index = 0; index <= GAME_REFS_MAX; index += 1) gameRef(`game-${index}`, storage);
    const kept: unknown = JSON.parse(storage.data.get(STORAGE_KEYS.analyticsGames) ?? "[]");
    assert.ok(Array.isArray(kept));
    assert.equal(kept.length, GAME_REFS_MAX);
    assert.deepEqual(kept[0]?.[0], "game-1", "game-0 was the oldest");
  });
});

/** What reached the recorder: the app's events, without PostHog's own. */
const captured: Array<[string, Record<string, unknown>]> = [];
const ours = (): Array<[string, Record<string, unknown>]> => captured.filter(([name]) => !name.startsWith("$"));

/** A studio over the fake api, with nothing listed and timers that never fire. */
function studioOver(overrides: Parameters<typeof fakeStudioApi>[0] = {}, now?: () => number) {
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
  const fake = fakeStudioApi({ bootstrap: async () => boot, ...overrides });
  const timers = { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0 };
  return createStudio(fake.api, { storage: memoryStorage(), timers, ...(now ? { now } : {}) });
}

describe("what the workspace hears without a click", () => {
  before(async () => {
    const posthog = {
      init: () => undefined,
      has_opted_out_capturing: () => false,
      opt_in_capturing: () => undefined,
      register: () => undefined,
      startSessionRecording: () => undefined,
      stopSessionRecording: () => undefined,
      capture: (name: string, properties: Record<string, unknown>) => captured.push([name, properties]),
    } as unknown as PostHog;
    const config = { key: "phc_test", host: "https://eu.i.posthog.com" };
    await startAnalytics(config, { replay: false }, async () => ({ posthog }));
  });
  beforeEach(() => {
    captured.length = 0;
  });

  it("a launch handed to its chat and the stage's views reach PostHog, with their way in and times", async () => {
    const app = studioOver();
    let clock = 50_000;
    const stop = createWorkspaceObservers(() => clock).start?.(app) ?? (() => undefined);

    const launch: Launch = {
      id: "l1",
      text: HOSTILE[4],
      extras: undefined,
      at: 40_000,
      phase: LaunchPhase.Opened,
      title: HOSTILE[4],
      project: HOSTILE[0],
      threadId: HOSTILE[5],
      known: [],
    };
    app.launch.setState({ launch, returned: null, planning: null }, true);
    app.launch.setState({ launch: { ...launch, phase: LaunchPhase.Handed }, returned: null, planning: null }, true);

    clock = 60_000;
    noteStageSwitch(StageSwitchVia.Tab, clock);
    app.layout.setState((state) => stageViewChosen(state, StageView.Builds), true);
    clock = 65_000;
    app.layout.setState((state) => stageViewChosen(state, StageView.Assets), true);
    app.toasts.notify(HOSTILE[0], ToastTone.Error);
    stop();
    await tick();

    const [handed, ...stages] = ours();
    assert.equal(handed?.[0], WorkspaceEvent.GameLaunchHanded);
    assert.equal(handed?.[1].total_ms, 10_000, "from when the message left home");
    assert.match(String(handed?.[1].game_ref), /^[0-9a-f]{16}$/, "the game by its random ref");
    const stage = { run_running: false };
    assert.deepEqual(stages, [
      [
        WorkspaceEvent.StageViewChanged,
        { from: StageView.Live, to: StageView.Builds, via: StageSwitchVia.Tab, from_dwell_ms: 10_000, ...stage },
      ],
      [
        WorkspaceEvent.StageViewChanged,
        { from: StageView.Builds, to: StageView.Assets, via: StageSwitchVia.Other, from_dwell_ms: 5_000, ...stage },
      ],
    ]);
    assertClean(ours(), "observed events");
  });

  it("a model out of usage stops a launch at naming, before any game is made", async () => {
    let clock = 1_000;
    const app = studioOver(
      {
        nameGame: async () => {
          clock += 2_000;
          return { title: "x", limited: HOSTILE[0] };
        },
      },
      () => clock,
    );
    await tick();
    await app.launchGame({ text: HOSTILE[4], modelKey: null, effort: null, parent: HOSTILE[0] });
    assert.deepEqual(ours(), [
      [
        WorkspaceEvent.GameLaunchFailed,
        {
          stage: LaunchStage.Naming,
          reason: LaunchFailReason.UsageLimit,
          elapsed_ms: 2_000,
          custom_location: true,
          code: null,
        },
      ],
    ]);
  });

  it("a refused folder stops a launch at creating; a made game counts from home; a chat that won't open stops it at opening", async () => {
    const refused = studioOver({
      nameGame: async () => ({ title: HOSTILE[4] }),
      createGame: async () => {
        throw new Error(HOSTILE[1]);
      },
    });
    await tick();
    await refused.launchGame({ text: HOSTILE[4], modelKey: null, effort: null, parent: HOSTILE[0] });
    const made = studioOver({
      nameGame: async () => ({ title: HOSTILE[4], provisional: true }),
      createGame: async (title) => project("alice-secret", { title }),
      threadForGame: async () => {
        throw new Error(HOSTILE[2]);
      },
    });
    await tick();
    await made.launchGame({ text: HOSTILE[4], modelKey: null, effort: null });
    const events = ours();
    assert.deepEqual(
      events.map(([name, properties]) => [name, properties.stage ?? properties.from]),
      [
        [WorkspaceEvent.GameLaunchFailed, LaunchStage.Creating],
        [WorkspaceEvent.GameCreated, GameCreatedFrom.Home],
        [WorkspaceEvent.GameLaunchFailed, LaunchStage.Opening],
      ],
    );
    assert.equal(events[0]?.[1].reason, LaunchFailReason.CreateRefused);
    assert.equal(events[1]?.[1].provisional, true);
    assert.equal(events[1]?.[1].custom_location, false);
    assert.equal(events[1]?.[1].games_bucket, CountBucket.One);
    assert.match(String(events[1]?.[1].game_ref), /^[0-9a-f]{16}$/);
    assert.equal(events[2]?.[1].reason, LaunchFailReason.OpenRefused);
    assertClean(events, "launch events");
  });
});
