/**
 * A game's analytics page in the renderer: how Play opens it and goes back, the store that reads
 * its reports, campaign links and events status (one read at a time for a question, nothing for a
 * page the person left, the last answer kept when a re-read fails, nothing of one account left for
 * the next), and the page's faces for every state, rendered by React's server renderer from the
 * plain renderer build.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { setImmediate as settled } from "node:timers/promises";
import { build } from "esbuild";
import type { ReactElement } from "react";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { createFixtureGameAnalytics } from "../../src/main/dev/fixture-game-analytics/index.ts";
import { FixtureAccount, fixtureAccountToken } from "../../src/main/dev/fixture-people.ts";
import { toEventsStatus } from "../../src/main/play/game-analytics/events-status.ts";
import { toCampaignLinks } from "../../src/main/play/game-analytics/links.ts";
import { toReportAnswer } from "../../src/main/play/game-analytics/reports.ts";
import { eventsStatusRoute, linksRoute, reportRoute } from "../../src/main/play/game-analytics/routes.ts";
import { analyticsScreen, SCREENS, type ScreenPlace } from "../../src/renderer/analytics/screens.ts";
import type { AnalyticsFaceProps } from "../../src/renderer/play/game-analytics/AnalyticsFace.tsx";
import { periodSpan } from "../../src/renderer/play/game-analytics/page-dates.ts";
import {
  type Body,
  BodyKind,
  bodyOf,
  focusAfterRemoval,
  headFacts,
  headOf,
  type ShownTab,
  statsRow,
} from "../../src/renderer/play/game-analytics/page-view.ts";
import { backLabel, PAGE_WORDS } from "../../src/renderer/play/game-analytics/page-words.ts";
import {
  AnalyticsTab,
  DEFAULT_ANALYTICS_TAB,
  isAnalyticsTab,
  listedTabs,
  reportOf,
} from "../../src/renderer/play/game-analytics/tabs.ts";
import { WelcomeScreen } from "../../src/renderer/onboarding/state.ts";
import { SettingsSection } from "../../src/renderer/settings-navigation.ts";
import { StageView } from "../../src/renderer/stage.ts";
import {
  accountSwitched,
  createGameAnalyticsStore,
  EVENTS_STATUS_POLL_MS,
  type GameAnalyticsStore,
  initialGameAnalytics,
  LINKS_STALE_MS,
  latestReady,
  linksKey,
  REPORT_STALE_MS,
  REPORTS_KEPT,
  reportKey,
  reportQuery,
  eventsKey,
} from "../../src/renderer/state/game-analytics.ts";
import { LoadStatus } from "../../src/renderer/state/people.ts";
import {
  backFromProfile,
  createPlayStore,
  gameAnalyticsShown,
  gameAnalyticsTabChosen,
  gameChanged,
  gameShown,
  initialPlay,
  ownStatsView,
  PlayPage,
  type PlayState,
  type PlayView,
  profileShown,
  statsShown,
} from "../../src/renderer/state/play.ts";
import { createStudio } from "../../src/renderer/state/studio.ts";
import { Room } from "../../src/renderer/state/threads.ts";
import { HOUR_MS } from "../../src/shared/duration.ts";
import {
  type AnalyticsGame,
  type AnalyticsRead,
  Attribution,
  type CampaignLink,
  type CampaignTags,
  type EventFunnel,
  type EventFunnelDraft,
  EventOrigin,
  type EventsStatus,
  EVENT_LIMITS,
  GameReport,
  type GameReportAnswer,
  type GameReportQuery,
  OverviewMetric,
  ReadKind,
  RetentionMode,
  SourceBreakdown,
} from "../../src/shared/game-analytics.ts";
import { GenexAccountStatus } from "../../src/shared/genex-account.ts";
import { PLAY_ORIGIN, type PlayGame } from "../../src/shared/play.ts";
import { AvatarStyle, type PlayMe } from "../../src/shared/play-people.ts";
import { DEFAULT_STATS_PERIOD, type PlayStats, type StatsPeriod } from "../../src/shared/play-stats.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const SLUG = "lantern-run";

/** The game as an answer describes it. */
const gameOf = (slug: string, over: Partial<AnalyticsGame> = {}): AnalyticsGame => ({
  slug,
  title: "Lantern Run",
  coverUrl: null,
  playingNow: 38,
  publishedOn: "2026-09-01",
  version: "1.4.0",
  hasAppBuild: false,
  sdkVersion: "0.38.2",
  eventsReady: true,
  ...over,
});

/** An Overview answer with nothing in it, for the game and period asked. */
function overviewAnswer(query: Pick<GameReportQuery, "slug" | "days">, game: Partial<AnalyticsGame> = {}) {
  const none = Object.fromEntries(Object.values(OverviewMetric).map((metric) => [metric, null]));
  return {
    report: GameReport.Overview,
    game: gameOf(query.slug, game),
    window: { days: query.days, endsOn: "2026-11-17", computedAt: "2026-11-17T12:00:00.000Z" },
    data: {
      series: none as Record<OverviewMetric, null>,
      annotations: [],
      insights: [],
      channels: [],
      retention: { rates: [], before: [], similar: null },
      funnel: [],
    },
  } satisfies GameReportAnswer;
}

/** An Events answer with the funnels given. */
function eventsAnswer(query: Pick<GameReportQuery, "slug" | "days">, funnels: EventFunnel[] = []) {
  return {
    report: GameReport.Events,
    game: gameOf(query.slug),
    window: { days: query.days, endsOn: "2026-11-17", computedAt: "2026-11-17T12:00:00.000Z" },
    data: { lastAt: null, total: 0, custom: [], automatic: [], detail: null, funnels },
  } satisfies GameReportAnswer;
}

/** The answer genex.games would give `query`: its report, empty. */
const answerFor = (query: GameReportQuery): GameReportAnswer =>
  query.report === GameReport.Events ? eventsAnswer(query) : { ...overviewAnswer(query), report: GameReport.Overview };

const ready = <Value>(value: Value): AnalyticsRead<Value> => ({ kind: ReadKind.Ready, value });

/** A promise the test settles by hand: an answer still on its way. */
function deferred<Value>(): { promise: Promise<Value>; resolve(value: Value): void } {
  let resolve: (value: Value) => void = () => {};
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: (value) => resolve(value) };
}

const link = (id: string, over: Partial<CampaignLink> = {}): CampaignLink => ({
  id,
  source: "tiktok",
  medium: "social",
  campaign: "launch",
  content: null,
  term: null,
  url: `https://genex.games/${SLUG}?utm_source=tiktok&utm_medium=social&utm_campaign=launch`,
  shortUrl: null,
  createdOn: "2026-11-01",
  newVisitors: 12,
  newPlayers: 7,
  day7: null,
  ...over,
});

const eventsStatus = (slug: string, origin: EventOrigin): EventsStatus => ({
  game: gameOf(slug),
  origin,
  lastAt: "2026-11-17T11:59:48.000Z",
  names: 3,
  recent: [],
  dropped: [],
  limits: EVENT_LIMITS,
});

/** The account's stats for a week with the games given. */
const weekOf = (games: PlayStats["games"]): PlayStats => ({
  days: 7,
  endsOn: "2026-11-17",
  players: 0,
  playersBefore: 0,
  published: games.length,
  publishedThisMonth: 0,
  games,
});

const funnel = (id: string): EventFunnel => ({ id, name: "First win", withinDays: 7, steps: [], typicalDay: null });

/**
 * A store over an API that records each call and answers what the test says, on a clock and an
 * interval the test moves by hand. Signed in as "me" unless told otherwise.
 */
function rig(options: { account?: string | null } = {}) {
  let now = 1_000_000;
  const calls: string[] = [];
  const intervals = new Map<number, { run: () => void; ms: number }>();
  let handles = 0;
  const answers = {
    report: async (query: GameReportQuery): Promise<AnalyticsRead<GameReportAnswer>> => ready(answerFor(query)),
    events: async (slug: string, origin: EventOrigin): Promise<AnalyticsRead<EventsStatus>> =>
      ready(eventsStatus(slug, origin)),
    links: async (_slug: string, _days: StatsPeriod): Promise<AnalyticsRead<CampaignLink[]>> => ready([link("a")]),
    saveLink: async (_slug: string, tags: CampaignTags): Promise<CampaignLink> => link("new", tags),
    removeLink: async (): Promise<void> => {},
    saveFunnel: async (_slug: string, draft: EventFunnelDraft): Promise<EventFunnel> => ({
      ...funnel("f1"),
      name: draft.name,
    }),
    removeFunnel: async (): Promise<void> => {},
  };
  const asked: GameReportQuery[] = [];
  const api = {
    playGameReport: (query: GameReportQuery) => {
      calls.push(`report ${query.report} ${query.days}`);
      asked.push(query);
      return answers.report(query);
    },
    playGameEvents: (slug: string, origin: EventOrigin) => {
      calls.push(`events ${slug} ${origin}`);
      return answers.events(slug, origin);
    },
    playCampaignLinks: (slug: string, days: StatsPeriod) => {
      calls.push(`links ${slug} ${days}`);
      return answers.links(slug, days);
    },
    playCampaignLinkSave: (slug: string, tags: CampaignTags) => {
      calls.push(`save-link ${slug} ${tags.campaign}`);
      return answers.saveLink(slug, tags);
    },
    playCampaignLinkRemove: (slug: string, id: string) => {
      calls.push(`remove-link ${slug} ${id}`);
      return answers.removeLink();
    },
    playFunnelSave: (slug: string, draft: EventFunnelDraft) => {
      calls.push(`save-funnel ${slug} ${draft.name}`);
      return answers.saveFunnel(slug, draft);
    },
    playFunnelRemove: (slug: string, id: string) => {
      calls.push(`remove-funnel ${slug} ${id}`);
      return answers.removeFunnel();
    },
  };
  let hidden = false;
  const store: GameAnalyticsStore = createGameAnalyticsStore(api, {
    now: () => now,
    setInterval: (run, ms) => {
      handles += 1;
      intervals.set(handles, { run, ms });
      return handles;
    },
    clearInterval: (handle) => void intervals.delete(handle as number),
    hidden: () => hidden,
  });
  store.accountChanged(options.account === undefined ? "me" : options.account);
  return {
    store,
    calls,
    asked,
    answers,
    advance: (ms: number) => {
      now += ms;
    },
    /** Every interval running fires once; resolves when the reads it started have landed. */
    tick: async () => {
      for (const { run } of [...intervals.values()]) run();
      await settled();
    },
    intervals: () => [...intervals.values()].map(({ ms }) => ms),
    hide: (value: boolean) => {
      hidden = value;
    },
  };
}

const overview = (days: StatsPeriod = 7, slug = SLUG): GameReportQuery => ({
  slug,
  report: GameReport.Overview,
  days,
});
const reportEntry = (store: GameAnalyticsStore, query: GameReportQuery) => store.getState().reports[reportKey(query)];

describe("a game's analytics page among Play's pages", () => {
  const statsView: PlayView = { page: PlayPage.Stats, userId: "me", from: PlayPage.Friends };
  const onStats: PlayState = { ...initialPlay(), view: statsView };

  it("opens on Overview from the Stats page, and Back returns to Stats, then its profile, then where that came from", () => {
    const shown = gameAnalyticsShown(onStats, SLUG);
    assert.deepEqual(shown.view, {
      page: PlayPage.GameAnalytics,
      slug: SLUG,
      tab: AnalyticsTab.Overview,
      back: statsView,
    });
    const stats = backFromProfile(shown);
    assert.deepEqual(stats.view, statsView);
    const profile = backFromProfile(stats);
    assert.deepEqual(profile.view, { page: PlayPage.Profile, userId: "me", from: PlayPage.Friends });
    assert.deepEqual(backFromProfile(profile).view, { page: PlayPage.Friends });
  });

  it("changes nothing when the page is already shown, and only the tab when another is asked for", () => {
    const shown = gameAnalyticsShown(onStats, SLUG);
    assert.equal(gameAnalyticsShown(shown, SLUG), shown, "the same game, no tab named");
    assert.equal(gameAnalyticsShown(shown, SLUG, AnalyticsTab.Overview), shown, "the tab it is on");
    const links = gameAnalyticsShown(shown, SLUG, AnalyticsTab.Links);
    assert.deepEqual(links.view, {
      page: PlayPage.GameAnalytics,
      slug: SLUG,
      tab: AnalyticsTab.Links,
      back: statsView,
    });
    assert.equal(gameAnalyticsShown(links, SLUG), links, "no tab named: the one shown stays");
  });

  it("opens on the tab named", () => {
    const shown = gameAnalyticsShown(onStats, SLUG, AnalyticsTab.Retention);
    assert.equal(shown.view.page === PlayPage.GameAnalytics && shown.view.tab, AnalyticsTab.Retention);
  });

  it("gives way to another game's page without stacking: Back still goes where the first one's did", () => {
    const first = gameAnalyticsShown(onStats, SLUG, AnalyticsTab.Sdk);
    const second = gameAnalyticsShown(first, "frost-keep");
    assert.deepEqual(second.view, {
      page: PlayPage.GameAnalytics,
      slug: "frost-keep",
      tab: DEFAULT_ANALYTICS_TAB,
      back: statsView,
    });
  });

  it("changes the tab of the page shown, and nothing on any other page or for the tab already shown", () => {
    const shown = gameAnalyticsShown(onStats, SLUG);
    const retention = gameAnalyticsTabChosen(shown, AnalyticsTab.Retention);
    assert.deepEqual(retention.view, { ...shown.view, tab: AnalyticsTab.Retention });
    assert.equal(gameAnalyticsTabChosen(retention, AnalyticsTab.Retention), retention);
    assert.equal(gameAnalyticsTabChosen(onStats, AnalyticsTab.Retention), onStats);
  });

  it("goes back to exactly the page it was opened from, whichever that was", () => {
    const origins: PlayView[] = [
      { page: PlayPage.Shelf },
      { page: PlayPage.Friends },
      { page: PlayPage.Profile, userId: "me", from: PlayPage.Shelf },
      statsView,
      { page: PlayPage.Game, slug: SLUG, back: { page: PlayPage.Shelf } },
    ];
    for (const origin of origins) {
      const shown = gameAnalyticsShown({ ...initialPlay(), view: origin }, SLUG);
      assert.deepEqual(backFromProfile(shown).view, origin, origin.page);
    }
  });

  it("opened from Create goes back to the account's Stats page, not to whatever Play last showed", () => {
    const friends: PlayState = { ...initialPlay(), view: { page: PlayPage.Friends } };
    const shown = gameAnalyticsShown(friends, SLUG, AnalyticsTab.Links, ownStatsView("me"));
    const stats = backFromProfile(shown);
    assert.deepEqual(stats.view, { page: PlayPage.Stats, userId: "me", from: PlayPage.Shelf });
    const profile = backFromProfile(stats);
    assert.deepEqual(profile.view, { page: PlayPage.Profile, userId: "me", from: PlayPage.Shelf });
    assert.deepEqual(backFromProfile(profile).view, { page: PlayPage.Shelf });
    assert.deepEqual(ownStatsView(null), { page: PlayPage.Shelf }, "signed out: the shelf");
    const again = gameAnalyticsShown(gameAnalyticsShown(onStats, "frost-keep"), SLUG, undefined, ownStatsView("me"));
    assert.deepEqual(
      again.view.page === PlayPage.GameAnalytics && again.view.back,
      ownStatsView("me"),
      "a named Back wins over the one of the page it replaces",
    );
  });

  it("a profile or a game's page opened over it comes back to it", () => {
    const shown = gameAnalyticsShown(onStats, SLUG, AnalyticsTab.Revenue);
    const profile = profileShown(shown, "ann");
    assert.deepEqual(profile.view, { page: PlayPage.Profile, userId: "ann", from: PlayPage.Shelf, back: shown.view });
    assert.deepEqual(backFromProfile(profile).view, shown.view);
    const game = gameShown(shown, SLUG);
    assert.deepEqual(game.view, { page: PlayPage.Game, slug: SLUG, back: shown.view });
    assert.deepEqual(backFromProfile(game).view, shown.view);
    assert.equal(statsShown(shown), shown, "Stats opens from a profile only");
  });

  it("follows the game to its new link when it is renamed, keeping the tab and Back", () => {
    const shown = gameAnalyticsShown(onStats, SLUG, AnalyticsTab.Events);
    const game = { id: "g1", slug: SLUG };
    const moved = { ...game, slug: "lantern-run-2", title: "Lantern Run 2" } as PlayGame;
    assert.deepEqual(gameChanged(shown, game, moved).view, {
      page: PlayPage.GameAnalytics,
      slug: "lantern-run-2",
      tab: AnalyticsTab.Events,
      back: statsView,
    });
    const other = { id: "g2", slug: "frost-keep" };
    assert.equal(gameChanged(shown, other, { ...other, slug: "frost" } as PlayGame).view, shown.view);
    assert.equal(gameChanged(shown, game, null).view, shown.view, "a game that left the catalog moves nothing");
    assert.equal(
      gameChanged(shown, game, { ...game, title: "Lantern" } as PlayGame).view,
      shown.view,
      "the same link: the same view",
    );
  });

  it("is opened, turned to a tab and left through the store's actions", () => {
    const api = new Proxy({}, { get: () => () => assert.fail("no call expected") }) as Parameters<
      typeof createPlayStore
    >[0];
    const play = createPlayStore(api, null);
    play.showGameAnalytics(SLUG);
    play.chooseAnalyticsTab(AnalyticsTab.Acquisition);
    assert.deepEqual(play.getState().view, {
      page: PlayPage.GameAnalytics,
      slug: SLUG,
      tab: AnalyticsTab.Acquisition,
      back: { page: PlayPage.Shelf },
    });
    play.showGameAnalytics("frost-keep", AnalyticsTab.Sdk, ownStatsView("me"));
    play.back();
    assert.deepEqual(play.getState().view, ownStatsView("me"));
  });

  it("names the page Back returns to", () => {
    assert.equal(backLabel(statsView), "Stats");
    assert.equal(backLabel({ page: PlayPage.Profile, userId: "me", from: PlayPage.Shelf }), "Profile");
    assert.equal(backLabel({ page: PlayPage.Friends }), "Friends");
    assert.equal(backLabel({ page: PlayPage.Shelf }), "Games");
    assert.equal(backLabel({ page: PlayPage.Game, slug: SLUG, back: { page: PlayPage.Shelf } }), "Back");
    assert.equal(backLabel(null), "Back");
  });
});

describe("a game's analytics tabs", () => {
  it("are the seven reports, then Campaign links and SDK", () => {
    assert.deepEqual(Object.values(AnalyticsTab), [...Object.values(GameReport), "links", "sdk"]);
    assert.equal(isAnalyticsTab("retention"), true);
    assert.equal(isAnalyticsTab("lantern-run"), false);
    assert.equal(reportOf(AnalyticsTab.Revenue), GameReport.Revenue);
    assert.equal(reportOf(AnalyticsTab.Links), null);
    assert.equal(reportOf(AnalyticsTab.Sdk), null);
  });

  it("list Installs only for a game with an app build, or while Installs is the tab shown", () => {
    const withoutInstalls = Object.values(AnalyticsTab).filter((tab) => tab !== AnalyticsTab.Installs);
    assert.deepEqual(listedTabs(false, AnalyticsTab.Overview), withoutInstalls);
    assert.deepEqual(listedTabs(true, AnalyticsTab.Overview), Object.values(AnalyticsTab));
    assert.deepEqual(listedTabs(false, AnalyticsTab.Installs), Object.values(AnalyticsTab));
  });
});

describe("usage analytics: the screen of a game's analytics page", () => {
  const place: ScreenPlace = {
    welcoming: false,
    welcomeScreen: WelcomeScreen.Welcome,
    playViewer: false,
    settings: null,
    searching: false,
    feedback: false,
    openFolder: false,
    plugins: false,
    items: false,
    play: PlayPage.GameAnalytics,
    playTab: AnalyticsTab.Retention,
    room: Room.Build,
    launching: false,
    stageView: StageView.Live,
  };

  it("carries the tab, and nothing of the game", () => {
    assert.equal(analyticsScreen(place), "/play/game-analytics/retention");
    assert.equal(analyticsScreen({ ...place, playTab: AnalyticsTab.Sdk }), "/play/game-analytics/sdk");
    assert.equal(analyticsScreen({ ...place, play: PlayPage.Stats }), "/play/stats", "a tab left over names nothing");
    assert.equal(analyticsScreen({ ...place, settings: SettingsSection.Privacy }), "/settings/privacy");
    for (const tab of Object.values(AnalyticsTab))
      assert.equal(SCREENS.has(`/play/game-analytics/${tab}`), true, `the ${tab} screen is one the app can name`);
    assert.equal(SCREENS.has(`/play/game-analytics/${SLUG}`), false);
  });
});

describe("the game analytics store: reports", () => {
  it("reads nothing signed out", async () => {
    const { store, calls } = rig({ account: null });
    await store.loadReport(overview());
    await store.loadLinks(SLUG, 7);
    const stop = store.watchEvents(SLUG, EventOrigin.Published);
    await settled();
    stop();
    assert.deepEqual(calls, []);
    assert.deepEqual(store.getState().reports, {});
  });

  it("tells a read on its way from one that answered and one that failed", async () => {
    const { store, answers } = rig();
    const answer = deferred<AnalyticsRead<GameReportAnswer>>();
    answers.report = () => answer.promise;
    const read = store.loadReport(overview());
    assert.deepEqual(reportEntry(store, overview()), {
      ask: overview(),
      status: LoadStatus.Loading,
      read: null,
      at: 0,
    });
    answer.resolve(ready(overviewAnswer(overview())));
    await read;
    const entry = reportEntry(store, overview());
    assert.equal(entry?.status, LoadStatus.Ready);
    assert.equal(entry?.read?.kind, ReadKind.Ready);
    assert.equal(entry?.at, 1_000_000);

    answers.report = async () => {
      throw new Error("offline");
    };
    await store.loadReport(overview(30));
    assert.deepEqual(reportEntry(store, overview(30)), {
      ask: overview(30),
      status: LoadStatus.Failed,
      read: null,
      at: 0,
    });
  });

  it("keeps why there is no report as an answer: not served yet, no such game, no such report", async () => {
    const { store, answers } = rig();
    for (const kind of [ReadKind.Unavailable, ReadKind.NoGame, ReadKind.NoReport] as const) {
      answers.report = async () => ({ kind });
      await store.loadReport(overview(), { force: true });
      const entry = reportEntry(store, overview());
      assert.deepEqual([entry?.status, entry?.read], [LoadStatus.Ready, { kind }]);
    }
    assert.deepEqual(store.getState().games, {}, "a refusal describes no game");
  });

  it("joins a read already on its way instead of asking twice", async () => {
    const { store, calls, answers } = rig();
    const answer = deferred<AnalyticsRead<GameReportAnswer>>();
    answers.report = () => answer.promise;
    const first = store.loadReport(overview());
    const second = store.loadReport(overview(), { force: true });
    answer.resolve(ready(overviewAnswer(overview())));
    await Promise.all([first, second]);
    assert.deepEqual(calls, ["report overview 7"]);
  });

  it("reads again on open only once the answer is older than REPORT_STALE_MS, or when forced", async () => {
    const { store, calls, advance } = rig();
    await store.loadReport(overview());
    advance(REPORT_STALE_MS - 1);
    await store.loadReport(overview());
    assert.equal(calls.length, 1, "still fresh");
    advance(1);
    await store.loadReport(overview());
    assert.equal(calls.length, 2, "stale: read again");
    assert.equal(reportEntry(store, overview())?.at, 1_000_000 + REPORT_STALE_MS);
    await store.loadReport(overview(), { force: true });
    assert.equal(calls.length, 3, "forced");
  });

  it("keys a report by the options that matter to it, and asks with those alone", async () => {
    const { store, calls, asked } = rig();
    await store.loadReport({ ...overview(), mode: RetentionMode.DayOrLater, event: "level_start" });
    await store.loadReport(overview());
    assert.deepEqual(calls, ["report overview 7"], "another report's options do not split Overview");
    assert.deepEqual(asked[0], overview());

    const acquisition = { slug: SLUG, report: GameReport.Acquisition, days: 7 } as const;
    await store.loadReport({ ...acquisition, breakdown: SourceBreakdown.Country });
    await store.loadReport({ ...acquisition, breakdown: SourceBreakdown.Device, mode: RetentionMode.OnDay });
    await store.loadReport({ ...acquisition, attribution: Attribution.Latest });
    assert.equal(calls.length, 4, "each breakdown and attribution is its own read");
    assert.deepEqual(asked[2], { ...acquisition, breakdown: SourceBreakdown.Device });
    assert.notEqual(
      reportKey(reportQuery(SLUG, GameReport.Events, 7, { event: "a", splitBy: "b" })),
      reportKey(reportQuery(SLUG, GameReport.Events, 7, { event: "a|b" })),
    );
  });

  it("drops an answer for a report, period or option the person has left", async () => {
    const { store, answers } = rig();
    const slow = deferred<AnalyticsRead<GameReportAnswer>>();
    answers.report = (query) => (query.days === 7 ? slow.promise : Promise.resolve(ready(answerFor(query))));
    const left = store.loadReport(overview(7));
    await store.loadReport(overview(30));
    slow.resolve(ready(overviewAnswer(overview(7))));
    await left;
    assert.equal(reportEntry(store, overview(7)), undefined, "nothing is kept of the read that was left");
    assert.equal(reportEntry(store, overview(30))?.status, LoadStatus.Ready);
  });

  it("lands an answer when the person came back before it arrived", async () => {
    const { store, calls, answers } = rig();
    const slow = deferred<AnalyticsRead<GameReportAnswer>>();
    answers.report = (query) => (query.days === 7 ? slow.promise : Promise.resolve(ready(answerFor(query))));
    const first = store.loadReport(overview(7));
    await store.loadReport(overview(30));
    const again = store.loadReport(overview(7));
    slow.resolve(ready(overviewAnswer(overview(7))));
    await Promise.all([first, again]);
    assert.equal(reportEntry(store, overview(7))?.read?.kind, ReadKind.Ready);
    assert.deepEqual(calls, ["report overview 7", "report overview 30"]);
  });

  it("drops an answer once the page is left, and puts back what the entry held before", async () => {
    const { store, answers, advance } = rig();
    await store.loadReport(overview());
    advance(REPORT_STALE_MS);
    const slow = deferred<AnalyticsRead<GameReportAnswer>>();
    answers.report = () => slow.promise;
    const reread = store.loadReport(overview());
    assert.equal(reportEntry(store, overview())?.status, LoadStatus.Loading);
    store.leave();
    slow.resolve({ kind: ReadKind.NoGame });
    await reread;
    const entry = reportEntry(store, overview());
    assert.deepEqual([entry?.status, entry?.read?.kind, entry?.at], [LoadStatus.Ready, ReadKind.Ready, 1_000_000]);
  });

  it("keeps the last answer when a re-read fails", async () => {
    const { store, answers } = rig();
    await store.loadReport(overview());
    answers.report = async () => {
      throw new Error("offline");
    };
    await store.loadReport(overview(), { force: true });
    const entry = reportEntry(store, overview());
    assert.equal(entry?.status, LoadStatus.Failed);
    assert.equal(entry?.read?.kind, ReadKind.Ready);
    assert.equal(entry?.at, 1_000_000, "it is as old as the answer it still holds");
  });

  it("remembers the game an answer described, for the header and the Installs tab", async () => {
    const { store, answers } = rig();
    answers.report = async (query) => ready(overviewAnswer(query, { hasAppBuild: true, playingNow: 4 }));
    await store.loadReport(overview());
    assert.equal(store.getState().games[SLUG]?.hasAppBuild, true);
    assert.equal(store.getState().games[SLUG]?.playingNow, 4);
  });

  it("finds the newest answer of a report, whatever period or option it was asked with", async () => {
    const { store, advance } = rig();
    assert.equal(
      latestReady(store.getState().reports, (ask) => ask.slug === SLUG),
      null,
    );
    await store.loadReport(overview(7));
    advance(10);
    await store.loadReport(overview(30));
    const mine = (ask: GameReportQuery) => ask.slug === SLUG && ask.report === GameReport.Overview;
    assert.equal(latestReady(store.getState().reports, mine)?.window.days, 30);
    assert.equal(
      latestReady(store.getState().reports, (ask) => ask.slug === "frost-keep"),
      null,
    );
  });

  it("keeps no more than REPORTS_KEPT answers, the oldest going first and never one on its way", async () => {
    const { store, answers, advance } = rig();
    const asked = Array.from({ length: REPORTS_KEPT + 30 }, (_, index) => overview(7, `game-${index}`));
    for (const query of asked) {
      await store.loadReport(query);
      advance(1);
    }
    const slow = deferred<AnalyticsRead<GameReportAnswer>>();
    answers.report = () => slow.promise;
    const onItsWay = store.loadReport(overview(30, "game-0"));
    advance(1);
    answers.report = async (query) => ready(answerFor(query));
    await store.loadReport(overview(7, "latest"));
    const kept = Object.keys(store.getState().reports);
    assert.ok(kept.length <= REPORTS_KEPT + 1, `${kept.length} kept`);
    assert.equal(reportEntry(store, overview(7, "game-0")), undefined, "the oldest answer went");
    assert.equal(reportEntry(store, overview(30, "game-0"))?.status, LoadStatus.Loading, "the read on its way stays");
    assert.equal(reportEntry(store, overview(7, "latest"))?.status, LoadStatus.Ready, "the answer just read stays");
    assert.equal(reportEntry(store, overview(7, `game-${asked.length - 1}`))?.status, LoadStatus.Ready);
    slow.resolve(ready(overviewAnswer(overview(30, "game-0"))));
    await onItsWay;
  });

  it("keeps the period chosen for the Stats page and every game's page, in memory only", () => {
    const { store } = rig();
    assert.equal(store.getState().period, DEFAULT_STATS_PERIOD);
    store.choosePeriod(90);
    assert.equal(store.getState().period, 90);
    const same = store.getState();
    store.choosePeriod(90);
    assert.equal(store.getState(), same);
  });
});

describe("the game analytics store: one account's numbers never reach the next", () => {
  it("clears everything when the account changes or signs out", async () => {
    const { store } = rig();
    await store.loadReport(overview());
    await store.loadLinks(SLUG, 7);
    store.choosePeriod(30);
    store.accountChanged("me");
    assert.equal(Object.keys(store.getState().reports).length, 1, "the same account: nothing changes");
    store.accountChanged("other");
    assert.deepEqual(store.getState(), { ...initialGameAnalytics(), account: "other" });
    await store.loadReport(overview());
    store.accountChanged(null);
    assert.deepEqual(store.getState(), initialGameAnalytics());
    assert.deepEqual(accountSwitched(initialGameAnalytics(), null), initialGameAnalytics());
  });

  it("drops an answer asked under the account before, and reads afresh for the new one", async () => {
    const { store, calls, answers } = rig();
    const slow = deferred<AnalyticsRead<GameReportAnswer>>();
    answers.report = () => slow.promise;
    const old = store.loadReport(overview());
    store.accountChanged("other");
    answers.report = async (query) => ready(overviewAnswer(query, { title: "Theirs" }));
    await store.loadReport(overview());
    slow.resolve(ready(overviewAnswer(overview(), { title: "Mine" })));
    await old;
    assert.equal(calls.length, 2, "the new account's read does not join the old one's");
    assert.equal(store.getState().games[SLUG]?.title, "Theirs");
  });

  it("stops the events status interval with the account", async () => {
    const { store, intervals } = rig();
    store.watchEvents(SLUG, EventOrigin.Published);
    await settled();
    assert.equal(intervals().length, 1);
    store.accountChanged(null);
    assert.equal(intervals().length, 0);
  });

  it("is cleared by the studio when the people store's account changes", async () => {
    const me: PlayMe = {
      id: "me",
      name: "Rab",
      handle: null,
      imageUrl: null,
      avatarVariant: 0,
      pro: false,
      joinedAt: null,
      avatarStyle: AvatarStyle.Generated,
      photoUrl: null,
      avatarVariantKept: false,
      handleChosen: null,
    };
    const fake = fakeStudioApi();
    fake.stub("playMe", async () => me);
    fake.stub("genexAccount", async () => ({ status: GenexAccountStatus.SignedIn }));
    const api = { ...fake.api, playGameReport: async (query: GameReportQuery) => ready(answerFor(query)) };
    const studio = createStudio(api, { storage: null });
    assert.equal(studio.gameAnalytics.getState().account, null);
    await studio.people.loadMe();
    assert.equal(studio.gameAnalytics.getState().account, "me");
    await studio.gameAnalytics.loadReport(overview());
    assert.equal(Object.keys(studio.gameAnalytics.getState().reports).length, 1);
    fake.stub("genexAccount", async () => ({ status: GenexAccountStatus.SignedOut }));
    fake.stub("playMe", async () => null);
    await studio.people.loadMe();
    assert.deepEqual(studio.gameAnalytics.getState(), initialGameAnalytics());
  });
});

describe("the game analytics store: campaign links", () => {
  const tags: CampaignTags = { source: "x", medium: "social", campaign: "winter", content: null, term: null };
  const listOf = (store: GameAnalyticsStore, days: StatsPeriod = 7): string[] => {
    const read = store.getState().links[linksKey({ slug: SLUG, days })]?.read;
    return read?.kind === ReadKind.Ready ? read.value.map((one) => one.id) : [];
  };

  it("reads the list once while fresh, and again once it is older than LINKS_STALE_MS", async () => {
    const { store, calls, advance } = rig();
    await store.loadLinks(SLUG, 7);
    await store.loadLinks(SLUG, 7);
    assert.deepEqual(calls, ["links lantern-run 7"]);
    advance(LINKS_STALE_MS);
    await store.loadLinks(SLUG, 7);
    assert.equal(calls.length, 2);
    assert.deepEqual(listOf(store), ["a"]);
  });

  it("puts a saved link first in every list of the game, from the answer, and hands it back", async () => {
    const { store, calls } = rig();
    await store.loadLinks(SLUG, 7);
    await store.loadLinks(SLUG, 30);
    const saved = await store.saveLink(SLUG, tags);
    assert.equal(saved.campaign, "winter");
    assert.deepEqual(listOf(store, 7), ["new", "a"]);
    assert.deepEqual(listOf(store, 30), ["new", "a"]);
    assert.deepEqual(calls.at(-1), "save-link lantern-run winter");
    await store.saveLink(SLUG, { ...tags, campaign: "spring" });
    assert.deepEqual(listOf(store, 7), ["new", "a"], "the same link saved again takes its place, not a second row");
  });

  it("takes a removed link out of every list once genex.games removed it", async () => {
    const { store, answers } = rig();
    answers.links = async () => ready([link("a"), link("b")]);
    await store.loadLinks(SLUG, 7);
    await store.removeLink(SLUG, "a");
    assert.deepEqual(listOf(store), ["b"]);
  });

  it("leaves the list as it was when a save or a removal is refused, and says so to the caller", async () => {
    const { store, answers } = rig();
    await store.loadLinks(SLUG, 7);
    answers.saveLink = async () => {
      throw new Error("too many links");
    };
    answers.removeLink = async () => {
      throw new Error("offline");
    };
    await assert.rejects(store.saveLink(SLUG, tags), /too many links/);
    await assert.rejects(store.removeLink(SLUG, "a"), /offline/);
    assert.deepEqual(listOf(store), ["a"]);
  });

  it("drops a list the person turned away from before it arrived", async () => {
    const { store, answers } = rig();
    const slow = deferred<AnalyticsRead<CampaignLink[]>>();
    answers.links = () => slow.promise;
    const read = store.loadLinks(SLUG, 7);
    await store.loadReport(overview());
    slow.resolve(ready([link("a")]));
    await read;
    assert.equal(store.getState().links[linksKey({ slug: SLUG, days: 7 })], undefined);
  });

  it("never lets a list read before a save land over the saved link: it reads the list again", async () => {
    const { store, answers, calls } = rig();
    await store.loadLinks(SLUG, 7);
    const older = deferred<AnalyticsRead<CampaignLink[]>>();
    answers.links = () => older.promise;
    const reread = store.loadLinks(SLUG, 7, { force: true });
    await store.saveLink(SLUG, tags);
    assert.deepEqual(listOf(store), ["new", "a"]);
    answers.links = async () => ready([link("new"), link("a")]);
    older.resolve(ready([link("a")]));
    await reread;
    assert.deepEqual(listOf(store), ["new", "a"], "the saved link stays");
    assert.deepEqual(
      calls.filter((call) => call.startsWith("links")),
      ["links lantern-run 7", "links lantern-run 7", "links lantern-run 7"],
      "the list sent before the save is read again",
    );
  });

  it("never lets a list read before a removal bring the removed link back", async () => {
    const { store, answers } = rig();
    answers.links = async () => ready([link("a"), link("b")]);
    await store.loadLinks(SLUG, 7);
    const older = deferred<AnalyticsRead<CampaignLink[]>>();
    answers.links = () => older.promise;
    const reread = store.loadLinks(SLUG, 7, { force: true });
    await store.removeLink(SLUG, "b");
    answers.links = async () => ready([link("a")]);
    older.resolve(ready([link("a"), link("b")]));
    await reread;
    assert.deepEqual(listOf(store), ["a"]);
  });

  it("reads again a new period's list that was on its way when a link was saved", async () => {
    const { store, answers } = rig();
    await store.loadLinks(SLUG, 7);
    const older = deferred<AnalyticsRead<CampaignLink[]>>();
    answers.links = () => older.promise;
    const turned = store.loadLinks(SLUG, 30);
    await store.saveLink(SLUG, tags);
    answers.links = async () => ready([link("new"), link("a")]);
    older.resolve(ready([link("a")]));
    await turned;
    assert.deepEqual(listOf(store, 30), ["new", "a"]);
    assert.equal(store.getState().links[linksKey({ slug: SLUG, days: 30 })]?.status, LoadStatus.Ready);
  });
});

describe("the game analytics store: funnels", () => {
  const events: GameReportQuery = { slug: SLUG, report: GameReport.Events, days: 7 };
  const draft: EventFunnelDraft = { name: "First win", withinDays: 7, steps: [] };

  it("reads the Events report shown again after a funnel is saved or removed", async () => {
    const { store, calls, answers } = rig();
    await store.loadReport(events);
    answers.report = async (query) => ready(eventsAnswer(query, [funnel("f1")]));
    const saved = await store.saveFunnel(SLUG, draft);
    assert.equal(saved.id, "f1");
    assert.deepEqual(calls, ["report events 7", "save-funnel lantern-run First win", "report events 7"]);
    const read = reportEntry(store, events)?.read;
    assert.equal(read?.kind === ReadKind.Ready && read.value.report === GameReport.Events, true);
    assert.equal(
      read?.kind === ReadKind.Ready && read.value.report === GameReport.Events && read.value.data.funnels.length,
      1,
    );
    await store.removeFunnel(SLUG, "f1");
    assert.deepEqual(calls.slice(3), ["remove-funnel lantern-run f1", "report events 7"]);
  });

  it("makes the game's other Events answers stale, so they are read again when shown", async () => {
    const { store, calls } = rig();
    await store.loadReport({ ...events, days: 30 });
    await store.loadReport(events);
    await store.saveFunnel(SLUG, draft);
    const before = calls.length;
    await store.loadReport({ ...events, days: 30 });
    assert.equal(calls.length, before + 1, "the 30-day answer was read again though it was fresh");
  });

  it("reads the Events report afresh after a save, never joining the read that was on its way", async () => {
    const { store, calls, answers } = rig();
    const older = deferred<AnalyticsRead<GameReportAnswer>>();
    answers.report = () => older.promise;
    const first = store.loadReport(events);
    answers.saveFunnel = async () => funnel("f1");
    answers.report = async (query) => ready(eventsAnswer(query, [funnel("f1")]));
    const saving = store.saveFunnel(SLUG, draft);
    await settled();
    assert.deepEqual(calls, ["report events 7", "save-funnel lantern-run First win", "report events 7"]);
    await saving;
    const funnelsShown = () => {
      const read = reportEntry(store, events)?.read;
      return read?.kind === ReadKind.Ready && read.value.report === GameReport.Events ? read.value.data.funnels : [];
    };
    assert.deepEqual(
      funnelsShown().map((one) => one.id),
      ["f1"],
      "the saved funnel is shown once the save resolves",
    );
    older.resolve(ready(eventsAnswer(events)));
    await first;
    assert.deepEqual(
      funnelsShown().map((one) => one.id),
      ["f1"],
      "the older read does not land over it",
    );
    assert.equal(calls.length, 3, "nor is it read a third time: the fresh answer already landed");
  });

  it("reads nothing again when the Events report is not what the page shows", async () => {
    const { store, calls } = rig();
    await store.loadReport(overview());
    await store.saveFunnel(SLUG, draft);
    assert.deepEqual(calls, ["report overview 7", "save-funnel lantern-run First win"]);
  });
});

describe("the game analytics store: the SDK tab's events status", () => {
  it("reads when the tab opens, again every EVENTS_STATUS_POLL_MS while it stays, and stops when it is left", async () => {
    const { store, calls, tick, intervals } = rig();
    const stop = store.watchEvents(SLUG, EventOrigin.Published);
    await settled();
    assert.deepEqual(calls, ["events lantern-run published"]);
    assert.deepEqual(intervals(), [EVENTS_STATUS_POLL_MS]);
    await tick();
    await tick();
    assert.equal(calls.length, 3);
    const entry = store.getState().events[eventsKey({ slug: SLUG, origin: EventOrigin.Published })];
    assert.equal(entry?.read?.kind, ReadKind.Ready);
    stop();
    assert.deepEqual(intervals(), [], "the interval is gone");
    await tick();
    assert.equal(calls.length, 3);
  });

  it("watches one origin at a time: turning the switch stops the last watch", async () => {
    const { store, calls, tick, intervals } = rig();
    store.watchEvents(SLUG, EventOrigin.Published);
    await settled();
    store.watchEvents(SLUG, EventOrigin.Preview);
    await settled();
    assert.deepEqual(intervals(), [EVENTS_STATUS_POLL_MS]);
    await tick();
    assert.deepEqual(calls, [
      "events lantern-run published",
      "events lantern-run preview",
      "events lantern-run preview",
    ]);
  });

  it("an old watch's stop leaves a newer watch running", async () => {
    const { store, intervals } = rig();
    const stopFirst = store.watchEvents(SLUG, EventOrigin.Published);
    store.watchEvents(SLUG, EventOrigin.Preview);
    stopFirst();
    assert.equal(intervals().length, 1);
  });

  it("stops when the page turns to a report, and skips a turn while the window is hidden", async () => {
    const { store, calls, tick, intervals, hide } = rig();
    store.watchEvents(SLUG, EventOrigin.Published);
    await settled();
    hide(true);
    await tick();
    assert.equal(calls.length, 1, "hidden: not read");
    hide(false);
    await tick();
    assert.equal(calls.length, 2);
    await store.loadReport(overview());
    assert.deepEqual(intervals(), []);
  });

  it("keeps the last status when a re-read fails", async () => {
    const { store, answers, tick } = rig();
    store.watchEvents(SLUG, EventOrigin.Published);
    await settled();
    answers.events = async () => {
      throw new Error("offline");
    };
    await tick();
    const entry = store.getState().events[eventsKey({ slug: SLUG, origin: EventOrigin.Published })];
    assert.deepEqual([entry?.status, entry?.read?.kind], [LoadStatus.Failed, ReadKind.Ready]);
  });
});

describe("what a tab of the analytics page shows", () => {
  const signedIn = { signedIn: true, online: true, previous: null };
  const entry = (status: LoadStatus, read: AnalyticsRead<string> | null) => ({ ask: null, status, read, at: 5 });

  it("asks for a sign-in before anything else", () => {
    const body = bodyOf({ ...signedIn, signedIn: false, entry: entry(LoadStatus.Ready, ready("numbers")) });
    assert.deepEqual(body, { kind: BodyKind.SignedOut });
  });

  it("is loading until the first answer, then the answer, dimmed while it is read again", () => {
    assert.deepEqual(bodyOf({ ...signedIn, entry: undefined }), { kind: BodyKind.Loading });
    assert.deepEqual(bodyOf({ ...signedIn, entry: entry(LoadStatus.Loading, null) }), { kind: BodyKind.Loading });
    assert.deepEqual(bodyOf({ ...signedIn, entry: entry(LoadStatus.Ready, ready("numbers")) }), {
      kind: BodyKind.Ready,
      value: "numbers",
      refreshing: false,
      stale: false,
    });
    assert.deepEqual(bodyOf({ ...signedIn, entry: entry(LoadStatus.Loading, ready("numbers")) }), {
      kind: BodyKind.Ready,
      value: "numbers",
      refreshing: true,
      stale: false,
    });
  });

  it("does not say a read that repeats on an interval is refreshing, only that another answer is on its way", () => {
    const quiet = { ...signedIn, quietRereads: true };
    assert.deepEqual(bodyOf({ ...quiet, entry: entry(LoadStatus.Loading, ready("status")) }), {
      kind: BodyKind.Ready,
      value: "status",
      refreshing: false,
      stale: false,
    });
    assert.deepEqual(bodyOf({ ...quiet, entry: entry(LoadStatus.Loading, null), previous: "other origin" }), {
      kind: BodyKind.Ready,
      value: "other origin",
      refreshing: true,
      stale: false,
    });
  });

  it("shows the answer before it while another option or period is on its way", () => {
    assert.deepEqual(bodyOf({ ...signedIn, entry: entry(LoadStatus.Loading, null), previous: "before" }), {
      kind: BodyKind.Ready,
      value: "before",
      refreshing: true,
      stale: false,
    });
    assert.deepEqual(bodyOf({ ...signedIn, entry: undefined, previous: "before" }), {
      kind: BodyKind.Ready,
      value: "before",
      refreshing: true,
      stale: false,
    });
  });

  it("keeps the last answer when a re-read fails, and says it could not refresh", () => {
    assert.deepEqual(bodyOf({ ...signedIn, entry: entry(LoadStatus.Failed, ready("numbers")) }), {
      kind: BodyKind.Ready,
      value: "numbers",
      refreshing: false,
      stale: true,
    });
  });

  it("says it failed with nothing read, and that the Mac is offline when that is why", () => {
    assert.deepEqual(bodyOf({ ...signedIn, entry: entry(LoadStatus.Failed, null) }), { kind: BodyKind.Failed });
    assert.deepEqual(bodyOf({ ...signedIn, online: false, entry: entry(LoadStatus.Failed, null) }), {
      kind: BodyKind.Offline,
    });
  });

  it("keeps the tab's last answer up, saying it could not refresh, when another period or option fails to load", () => {
    const stale = { kind: BodyKind.Ready, value: "before", refreshing: false, stale: true };
    assert.deepEqual(
      bodyOf({ ...signedIn, entry: entry(LoadStatus.Failed, null), previous: "before" }),
      stale,
      "the tab stays, with what was typed in it",
    );
    assert.deepEqual(
      bodyOf({ ...signedIn, online: false, entry: entry(LoadStatus.Failed, null), previous: "before" }),
      stale,
    );
  });

  it("moves the focus after a removal to the next row's Remove, else the one before, else nowhere listed", () => {
    assert.equal(focusAfterRemoval(["a", "b", "c"], "b"), "c");
    assert.equal(focusAfterRemoval(["a", "b", "c"], "c"), "b", "the last row: the one before it");
    assert.equal(focusAfterRemoval(["a"], "a"), null, "the only row: nothing listed is left");
    assert.equal(focusAfterRemoval(["a", "b"], "z"), null, "a row not listed");
  });

  it("tells genex.games not serving it from no such game and no such report", () => {
    const kinds = [
      [ReadKind.Unavailable, BodyKind.Unavailable],
      [ReadKind.NoGame, BodyKind.NoGame],
      [ReadKind.NoReport, BodyKind.NoReport],
    ] as const;
    for (const [kind, body] of kinds) {
      assert.deepEqual(bodyOf({ ...signedIn, entry: entry(LoadStatus.Ready, { kind }) }), { kind: body });
      assert.deepEqual(bodyOf({ ...signedIn, entry: entry(LoadStatus.Loading, { kind }) }), { kind: body });
    }
  });

  it("heads the page with what the latest answer said of the game, else its Stats row, else its own page", () => {
    const row = {
      slug: SLUG,
      title: "Lantern Run",
      coverUrl: "https://assets.genex.games/lantern.png",
      plays: [],
      players: [],
      playsBefore: 0,
      playersTotal: 0,
      playersBefore: 0,
      playingNow: 2,
    };
    const stats = { 30: { status: LoadStatus.Ready, unavailable: false, stats: { ...weekOf([]), games: [row] } } };
    assert.equal(statsRow(stats, SLUG), row, "found in whichever period was read");
    assert.equal(statsRow(stats, "frost-keep"), null);
    assert.equal(statsRow({}, SLUG), null);
    assert.deepEqual(headOf(gameOf(SLUG, { hasAppBuild: true }), row, null), {
      title: "Lantern Run",
      coverUrl: null,
      playingNow: 38,
      hasAppBuild: true,
    });
    assert.deepEqual(headOf(undefined, row, null), {
      title: "Lantern Run",
      coverUrl: "https://assets.genex.games/lantern.png",
      playingNow: 2,
      hasAppBuild: false,
    });
    assert.deepEqual(headOf(undefined, null, null), {
      title: null,
      coverUrl: null,
      playingNow: null,
      hasAppBuild: false,
    });
  });

  it("writes the period in UTC days", () => {
    assert.deepEqual(periodSpan("2026-11-17", 30), { from: "Oct 19", to: "Nov 17" });
    assert.deepEqual(periodSpan("2026-01-03", 7), { from: "Dec 28", to: "Jan 3" });
  });

  it("says under the title what the numbers are, tab by tab", () => {
    const now = Date.parse("2026-11-17T12:04:00.000Z");
    const answer = overviewAnswer({ slug: SLUG, days: 30 });
    const report: ShownTab = {
      tab: AnalyticsTab.Overview,
      body: { kind: BodyKind.Ready, value: answer, refreshing: false, stale: false },
    };
    assert.deepEqual(headFacts(report, 30, now), [
      "Only you can see this",
      "Oct 19 – Nov 17, days in UTC",
      "changes are against the 30 days before",
      "updated 4 min. ago",
    ]);
    // "Ago" is written as the reports write it (the kit's `formatAgo`): numbers computed on a clock
    // ahead of this computer's are from just now, not from the future.
    const behind = Date.parse("2026-11-17T11:59:00.000Z");
    assert.equal(headFacts(report, 30, behind).at(-1), "updated just now");
    assert.equal(headFacts(report, 30, now + 3 * HOUR_MS).at(-1), "updated 3 hr. ago");
    const waiting: ShownTab = { tab: AnalyticsTab.Overview, body: { kind: BodyKind.Loading } };
    assert.deepEqual(headFacts(waiting, 7, now), ["Only you can see this", "Nov 11 – Nov 17, days in UTC"]);
    const links: ShownTab = { tab: AnalyticsTab.Links, body: { kind: BodyKind.Loading } };
    assert.deepEqual(headFacts(links, 30, now), ["Only you can see this", "numbers are for Oct 19 – Nov 17"]);
    const status = eventsStatus(SLUG, EventOrigin.Published);
    const sdk: ShownTab = {
      tab: AnalyticsTab.Sdk,
      body: { kind: BodyKind.Ready, value: status, refreshing: false, stale: false },
    };
    assert.deepEqual(headFacts(sdk, 30, now), [
      "Only you can see this",
      "the published game loads Genex SDK 0.38.2",
      "last event 4 min. ago",
    ]);
    const quiet: ShownTab = { ...sdk, body: { ...sdk.body, value: { ...status, lastAt: null } } as Body<EventsStatus> };
    assert.equal(headFacts(quiet, 30, now).at(-1), "no events yet");
    // The last event is the one of the events shown: Studio preview's are not the published game's.
    const preview: ShownTab = {
      ...sdk,
      body: { ...sdk.body, value: eventsStatus(SLUG, EventOrigin.Preview) } as Body<EventsStatus>,
    };
    assert.deepEqual(headFacts(preview, 30, now).slice(1), [
      "the published game loads Genex SDK 0.38.2",
      "last event in Studio preview 4 min. ago",
    ]);
    const previewQuiet: ShownTab = {
      ...preview,
      body: {
        ...preview.body,
        value: { ...eventsStatus(SLUG, EventOrigin.Preview), lastAt: null },
      } as Body<EventsStatus>,
    };
    assert.equal(headFacts(previewQuiet, 30, now).at(-1), "no events in Studio preview yet");
  });
});

/** What the tests reach in the renderer build: the page's face, the Stats table and React's server renderer. */
interface PageBundle {
  AnalyticsFace: (props: AnalyticsFaceProps) => ReactElement;
  GamesTable: (props: { stats: PlayStats; onOpen: (slug: string) => void }) => ReactElement;
  PeriodSwitch: (props: { period: StatsPeriod; onChange: (period: StatsPeriod) => void }) => ReactElement;
  createElement: (type: unknown, props: object | null, ...children: unknown[]) => ReactElement;
  renderToStaticMarkup: (element: ReactElement) => string;
}

/** The fixture account's richest game: it has an app build, so every tab has an answer. */
const FIXTURE_SLUG = "skate";

/** The attribute on the root of each tab's own component. */
const tabRoot = (tab: AnalyticsTab): string => {
  if (tab === AnalyticsTab.Links) return 'data-game-analytics-links="true"';
  if (tab === AnalyticsTab.Sdk) return 'data-game-analytics-sdk="true"';
  return `data-game-analytics-report="${tab}"`;
};

/**
 * What a fixture launch answers for its richest game over 30 days, read by main's own parsers, as
 * the tab each answer is shown on.
 */
function fixtureAnswers(now: number): { game: AnalyticsGame; shown(tab: AnalyticsTab): ShownTab } {
  const items = [
    { slug: "lost-cathedral", title: "Lost Cathedral", thumbnailUrl: null, playsCount: 2682, online: null },
    { slug: FIXTURE_SLUG, title: "SKATE", thumbnailUrl: null, playsCount: 5285, online: 8, builds: [{}] },
  ];
  const catalog = { games: () => items };
  const fixture = createFixtureGameAnalytics({ now: () => now });
  const body = (route: string): unknown => {
    const answer = fixture.answer(route, { method: "GET", token: fixtureAccountToken(FixtureAccount.Full) }, catalog);
    assert.equal(answer?.status, 200, route);
    return answer?.body;
  };
  const readyBody = <Value>(value: Value | null, what: string): Body<Value> => ({
    kind: BodyKind.Ready,
    value: value ?? assert.fail(`${what} does not read`),
    refreshing: false,
    stale: false,
  });
  const report = (name: GameReport): GameReportAnswer => {
    const query: GameReportQuery = { slug: FIXTURE_SLUG, report: name, days: 30 };
    return toReportAnswer(body(reportRoute(query)), query, true) ?? assert.fail(`${name} does not read`);
  };
  const origin = EventOrigin.Published;
  return {
    game: report(GameReport.Overview).game,
    shown: (tab) => {
      if (tab === AnalyticsTab.Links)
        return {
          tab,
          body: readyBody(
            toCampaignLinks(body(linksRoute(FIXTURE_SLUG, 30)), { web: PLAY_ORIGIN.web, slug: FIXTURE_SLUG }),
            tab,
          ),
        };
      if (tab === AnalyticsTab.Sdk) {
        const status = toEventsStatus(body(eventsStatusRoute(FIXTURE_SLUG, origin)), FIXTURE_SLUG, origin, true);
        return { tab, body: readyBody(status, tab) };
      }
      return { tab, body: readyBody(report(tab), tab) };
    },
  };
}

/** The page's faces as the plain renderer build compiles them. */
async function pageBundle(): Promise<PageBundle> {
  const result = await build({
    stdin: {
      contents: [
        'export { AnalyticsFace } from "./src/renderer/play/game-analytics/AnalyticsFace.tsx";',
        'export { GamesTable } from "./src/renderer/play/PlayStats.tsx";',
        'export { PeriodSwitch } from "./src/renderer/play/PeriodSwitch.tsx";',
        'export { createElement } from "react";',
        'export { renderToStaticMarkup } from "react-dom/server.edge";',
      ].join("\n"),
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "esm",
    jsx: "automatic",
    logLevel: "silent",
    platform: "browser",
    ...rendererBuildOptions(),
    plugins: [
      {
        name: "no-studio",
        setup(on) {
          on.onResolve({ filter: /\/App\.tsx$/ }, () => ({ path: "app", namespace: "no-studio" }));
          on.onLoad({ filter: /.*/, namespace: "no-studio" }, () => ({
            contents: "export function App() { return null; }",
            loader: "js",
          }));
        },
      },
    ],
  });
  const code = result.outputFiles[0]?.text ?? "";
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

describe("the analytics page's faces", () => {
  let bundle: PageBundle;
  const now = Date.parse("2026-11-17T12:04:00.000Z");
  const never = async (): Promise<never> => assert.fail("not pressed");
  const actions: AnalyticsFaceProps["actions"] = {
    onTab: () => {},
    onPeriod: () => {},
    onOptions: () => {},
    onOrigin: () => {},
    onRetry: () => {},
    onCopy: () => {},
    onSaveLink: never,
    onRemoveLink: never,
    onSaveFunnel: never,
    onRemoveFunnel: never,
  };
  const head = { title: "Lantern Run", coverUrl: null, playingNow: 38, hasAppBuild: false };
  const loading: ShownTab = { tab: AnalyticsTab.Overview, body: { kind: BodyKind.Loading } };
  /** The page's face as markup; `over` changes what the case needs. */
  const draw = (over: Partial<AnalyticsFaceProps> = {}): string =>
    bundle.renderToStaticMarkup(
      bundle.createElement(bundle.AnalyticsFace, {
        slug: SLUG,
        shown: loading,
        head,
        game: null,
        gameUrl: `https://genex.games/${SLUG}`,
        copied: false,
        period: 30,
        options: {},
        origin: EventOrigin.Published,
        now,
        actions,
        ...over,
      } satisfies AnalyticsFaceProps),
    );
  const overviewTab = (body: Body<GameReportAnswer>): ShownTab => ({ tab: AnalyticsTab.Overview, body });
  const tabTag = (markup: string, tab: AnalyticsTab): string =>
    markup.match(new RegExp(`<button[^>]*data-game-analytics-tab="${tab}"[^>]*>`))?.[0] ?? "";

  before(async () => {
    bundle = await pageBundle();
  });

  it("heads the page with the game: its title kept out of replays, its link with Copy, who is playing, and the facts", () => {
    const markup = draw();
    assert.match(markup, /data-game-analytics-page="overview"/);
    assert.match(markup, /<h1[^>]*><span data-analytics-mask="">Lantern Run<\/span><\/h1>/);
    assert.match(markup, /genex\.games\/lantern-run/);
    assert.doesNotMatch(markup, />https:\/\/genex\.games/, "the link reads without its scheme");
    assert.match(markup, /<button[^>]*data-game-analytics-copy="true"[^>]*aria-label="Copy the Lantern Run link"/);
    assert.match(
      markup,
      /<span class="game-analytics-link" data-analytics-mask="">(?:(?!<\/span><\/span>).)*aria-label="Copy the Lantern Run link"/,
      "Copy is named by the title, so it sits inside the part replays hide",
    );
    assert.match(markup, /data-game-analytics-live="true"[^>]*>.*38.*playing now/);
    assert.match(markup, /Only you can see this/);
    assert.match(markup, /Oct 19 – Nov 17, days in UTC/);
    assert.match(markup, /<span class="sr-only" role="status"><\/span>/, "nothing is announced before a copy");
    assert.match(draw({ copied: true }), /<span class="sr-only" role="status">Link copied<\/span>/);
  });

  it("falls back to a plain title and no live count while it knows nothing of the game", () => {
    const markup = draw({ head: { title: null, coverUrl: null, playingNow: null, hasAppBuild: false } });
    assert.match(markup, /<h1[^>]*>Game stats<\/h1>/);
    assert.doesNotMatch(markup, /data-game-analytics-live/);
    assert.match(markup, /aria-label="Copy the game link"/);
  });

  it("lists the report tabs with one roving stop, and sets Campaign links and SDK apart", () => {
    const markup = draw({ shown: { tab: AnalyticsTab.Retention, body: { kind: BodyKind.Loading } } });
    assert.match(markup, /role="tablist"[^>]*aria-label="Stats sections"/);
    for (const tab of listedTabs(false, AnalyticsTab.Retention)) {
      const tag = tabTag(markup, tab);
      const selected = tab === AnalyticsTab.Retention;
      assert.match(tag, /role="tab"/, tab);
      assert.match(tag, new RegExp(`aria-selected="${selected}"`), tab);
      assert.match(tag, new RegExp(`tabindex="${selected ? 0 : -1}"`), tab);
    }
    assert.match(tabTag(markup, AnalyticsTab.Links), /data-side=""/);
    assert.match(tabTag(markup, AnalyticsTab.Sdk), /data-side=""/);
    assert.doesNotMatch(tabTag(markup, AnalyticsTab.Revenue), /data-side/);
    assert.match(markup, />Campaign links</);
    assert.match(markup, /role="tabpanel"/);
  });

  it("shows Installs only once an answer said the game has an app build", () => {
    assert.equal(tabTag(draw(), AnalyticsTab.Installs), "");
    assert.notEqual(tabTag(draw({ head: { ...head, hasAppBuild: true } }), AnalyticsTab.Installs), "");
  });

  it("offers the three periods on every tab but SDK", () => {
    const markup = draw();
    for (const days of [7, 30, 90])
      assert.match(markup, new RegExp(`data-game-analytics-period="${days}"[^>]*>${days} days<`));
    assert.match(markup, /aria-selected="true"[^>]*data-game-analytics-period="30"/);
    const sdk = draw({ shown: { tab: AnalyticsTab.Sdk, body: { kind: BodyKind.Loading } } });
    assert.doesNotMatch(sdk, /data-game-analytics-period/);
  });

  it("signed out: says what signing in is for, with Sign in", () => {
    const markup = draw({ shown: overviewTab({ kind: BodyKind.SignedOut }) });
    assert.match(markup, /data-game-analytics-state="signed-out"/);
    assert.match(markup, /data-sign-in-note="true"[^>]*>Sign in to Genex to see your game stats\./);
  });

  it("loading: a skeleton that says it is busy", () => {
    const markup = draw();
    assert.match(markup, /data-game-analytics-state="loading"/);
    assert.match(markup, /aria-busy="true"/);
  });

  it("genex.games not serving it yet, no such game and no such report each say their own thing", () => {
    const unavailable = draw({ shown: overviewTab({ kind: BodyKind.Unavailable }) });
    assert.match(unavailable, /data-game-analytics-state="unavailable"/);
    assert.ok(unavailable.includes(PAGE_WORDS.unavailable));
    const noGame = draw({ shown: overviewTab({ kind: BodyKind.NoGame }) });
    assert.match(noGame, /data-game-analytics-state="no_game"/);
    assert.ok(noGame.includes(PAGE_WORDS.noGame));
    const installs = draw({ shown: { tab: AnalyticsTab.Installs, body: { kind: BodyKind.NoReport } } });
    assert.match(installs, /data-game-analytics-state="no_report"/);
    assert.match(installs, /app build/);
    assert.match(installs, /<button[^>]*data-game-analytics-go="overview"/);
    const revenue = draw({ shown: { tab: AnalyticsTab.Revenue, body: { kind: BodyKind.NoReport } } });
    assert.notEqual(
      revenue.match(/data-game-analytics-state="no_report"[^>]*>(.*?)<button/)?.[1],
      installs.match(/data-game-analytics-state="no_report"[^>]*>(.*?)<button/)?.[1],
      "Revenue and Installs say why in their own words",
    );
  });

  it("failed: says so, with Try again", () => {
    const markup = draw({ shown: overviewTab({ kind: BodyKind.Failed }) });
    assert.match(markup, /data-game-analytics-state="failed"/);
    assert.match(markup, /<button[^>]*data-game-analytics-retry="true"[^>]*>.*Try again/);
  });

  it("offline: the offline notice, with Try again", () => {
    const markup = draw({ shown: overviewTab({ kind: BodyKind.Offline }) });
    assert.match(markup, /data-game-analytics-state="offline"/);
    assert.match(markup, /data-play-offline="true"/);
    assert.match(markup, /Try again/);
  });

  it("ready: the tab's own component, busy while a newer answer is on its way, and a line when a refresh failed", () => {
    const answer = overviewAnswer({ slug: SLUG, days: 30 });
    const body = { kind: BodyKind.Ready, value: answer, refreshing: false, stale: false } as const;
    const markup = draw({ shown: overviewTab(body) });
    assert.match(markup, /data-game-analytics-state="ready"/);
    assert.match(markup, /data-game-analytics-report="overview"/);
    assert.match(markup, /updated 4 min\. ago/);
    assert.doesNotMatch(markup, /aria-busy="true"/);
    assert.doesNotMatch(markup, /data-game-analytics-stale/);
    assert.match(draw({ shown: overviewTab({ ...body, refreshing: true }) }), /aria-busy="true"/);
    const stale = draw({ shown: overviewTab({ ...body, stale: true }) });
    assert.match(stale, /data-game-analytics-stale="true"/);
    assert.match(stale, /data-game-analytics-retry="true"/);
    assert.match(stale, /data-game-analytics-report="overview"/, "the last numbers stay");
  });

  it("ready: Campaign links and SDK draw their own pages", () => {
    const links = draw({
      shown: {
        tab: AnalyticsTab.Links,
        body: { kind: BodyKind.Ready, value: [link("a")], refreshing: false, stale: false },
      },
    });
    assert.match(links, /data-game-analytics-links="true"/);
    const sdk = draw({
      shown: {
        tab: AnalyticsTab.Sdk,
        body: {
          kind: BodyKind.Ready,
          value: eventsStatus(SLUG, EventOrigin.Published),
          refreshing: false,
          stale: false,
        },
      },
    });
    assert.match(sdk, /data-game-analytics-sdk="true"/);
    assert.match(sdk, /the published game loads Genex SDK 0\.38\.2/);
  });

  it("each of the nine tabs draws its fixture answer inside the shell, found by its own attribute", () => {
    const rich = fixtureAnswers(now);
    for (const tab of Object.values(AnalyticsTab)) {
      const markup = draw({
        slug: FIXTURE_SLUG,
        head: { ...head, title: rich.game.title, hasAppBuild: true },
        game: rich.game,
        gameUrl: `https://genex.games/${FIXTURE_SLUG}`,
        shown: rich.shown(tab),
      });
      const panel = markup.match(/<div role="tabpanel"[^>]*data-game-analytics-state="ready"[^>]*>(.*)$/s)?.[1];
      assert.ok(panel, `${tab}: the shell shows the answer`);
      const root = panel.match(new RegExp(`^<div[^>]*${tabRoot(tab)}[^>]*>(.*)$`, "s"))?.[1] ?? "";
      assert.ok(root, `${tab}: the panel holds the tab's own component, first`);
      assert.doesNotMatch(root, /^<\/div>/, `${tab}: the component is not an empty region`);
      assert.match(root, /data-game-analytics-section="[^"]+"/, `${tab}: it draws its sections`);
      assert.doesNotMatch(
        panel,
        /data-game-analytics-(period|tab|facts|live|copy)=|role="tablist"/,
        `${tab}: it draws nothing of the shell`,
      );
    }
  });

  it("the Stats page's period switch is drawn as it was before it was shared", () => {
    const button = (days: number, selected: boolean): string =>
      `<button type="button" role="tab" aria-selected="${selected}" tabindex="${selected ? 0 : -1}" ` +
      `data-stats-period="${days}" class="stats-period">${days} days</button>`;
    assert.equal(
      bundle.renderToStaticMarkup(bundle.createElement(bundle.PeriodSwitch, { period: 30, onChange: () => {} })),
      `<div class="stats-periods" role="tablist" aria-label="Period">${button(7, false)}${button(30, true)}${button(90, false)}</div>`,
    );
  });

  it("the Stats table's rows each open their game's page: a button named by the title, kept out of replays", () => {
    const stats: PlayStats = {
      days: 7,
      endsOn: "2026-11-17",
      players: 3,
      playersBefore: 1,
      published: 1,
      publishedThisMonth: 0,
      games: [
        {
          slug: SLUG,
          title: "Lantern Run",
          coverUrl: null,
          plays: [1, 2, 3, 4, 5, 6, 7],
          players: [1, 1, 1, 1, 1, 1, 1],
          playsBefore: 10,
          playersTotal: 3,
          playersBefore: 1,
          playingNow: 0,
        },
      ],
    };
    const markup = bundle.renderToStaticMarkup(bundle.createElement(bundle.GamesTable, { stats, onOpen: () => {} }));
    assert.match(markup, /<div role="table" aria-label="My games" class="stats-table" data-stats-table="true">/);
    assert.match(markup, /<div role="row" class="stats-row" data-stats-game="lantern-run">/);
    assert.match(
      markup,
      /<button type="button"[^>]*data-game-analytics-open="lantern-run"[^>]*><span data-analytics-mask="">Lantern Run<\/span><\/button>/,
    );
  });
});
