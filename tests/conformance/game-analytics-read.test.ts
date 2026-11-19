/**
 * A game's analytics as main reads them from genex.games, for the game's creator alone. What the
 * renderer asks with and what genex.games answers are both hostile input: a malformed question is
 * refused before any call, a broken answer is an error and never reads as "not served yet" or as
 * zeros, and a rate that cannot be known yet stays null. A fixture launch answers the same routes
 * from one made-up game per slug, so its reports agree with each other.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFixtureGameAnalytics } from "../../src/main/dev/fixture-game-analytics/index.ts";
import { type GameSample, gameSample, ownSamples } from "../../src/main/dev/fixture-game-analytics/sample.ts";
import { FixtureAccount, fixtureAccountToken } from "../../src/main/dev/fixture-people.ts";
import { fixturePlayRequest } from "../../src/main/dev/fixture-play.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { registerGameAnalyticsIpc } from "../../src/main/ipc/game-analytics.ts";
import {
  type GalleryAnswer,
  GalleryError,
  type GalleryRequest,
  isRecord,
  SignInNeeded,
} from "../../src/main/play/gallery.ts";
import {
  amount,
  compared,
  count,
  isoDay,
  isoTime,
  line,
  measure,
  oneOf,
  orNull,
  rate,
  rateOrNull,
  rows,
  series,
  shortSeries,
  whole,
} from "../../src/main/play/game-analytics/kit.ts";
import { type GameAnalytics, gameAnalytics } from "../../src/main/play/game-analytics/read.ts";
import { toOverviewReport } from "../../src/main/play/game-analytics/report-overview.ts";
import { toReportAnswer } from "../../src/main/play/game-analytics/reports.ts";
import {
  AnalyticsRoute,
  eventsStatusRoute,
  linksRoute,
  reportRoute,
} from "../../src/main/play/game-analytics/routes.ts";
import {
  type AnalyticsWindow,
  Attribution,
  CAMPAIGN_LINKS_MAX,
  CampaignField,
  type CampaignTags,
  CohortSize,
  EVENT_LIMITS,
  type EventFunnelDraft,
  EventOrigin,
  FUNNELS_MAX,
  FunnelStep,
  GameReport,
  type GameReportQuery,
  type OverviewReport,
  ReadKind,
  RETENTION_SPAN,
  RetentionMode,
  SegmentBy,
  SourceBreakdown,
  SourceChannel,
} from "../../src/shared/game-analytics.ts";
import { AnalyticsSaveRefusal } from "../../src/shared/game-analytics-asks.ts";
import { errorCode } from "../../src/shared/errors.ts";
import { PLAY_ORIGIN } from "../../src/shared/play.ts";
import { dayBefore, STATS_PERIODS, type StatsPeriod } from "../../src/shared/play-stats.ts";

const TOKEN = "genex-cli-token";
const SLUG = "neon-rush";
/** The website Play links to in these tests: a link may point only at the game's page there. */
const WEB = "https://genex.games";
const COVER = "https://cdn.genex.technology/covers/a.webp";
const DAYS = 7;
const ENDS_ON = "2026-11-17";
const WINDOW: AnalyticsWindow = { days: DAYS, endsOn: ENDS_ON, computedAt: "2026-11-17T12:00:00.000Z" };
const GAME = {
  slug: SLUG,
  title: "Neon Rush",
  coverUrl: COVER,
  playingNow: 3,
  publishedOn: "2026-06-01",
  version: "1.4.0",
  hasAppBuild: false,
  sdkVersion: "0.38.2",
  eventsReady: true,
};
const TAGS: CampaignTags = {
  source: "tiktok",
  medium: "social",
  campaign: "launch_trailer",
  content: null,
  term: null,
};
const DRAFT: EventFunnelDraft = {
  name: "First purchase",
  withinDays: 7,
  steps: [
    { event: "level_start", property: null, value: null },
    { event: "level_complete", property: "level", value: "1" },
  ],
};

const ok = (body: unknown): GalleryAnswer => ({ status: 200, body });
const status = (code: number, body: unknown = null): GalleryAnswer => ({ status: code, body });
const fill = <T>(value: T, length = DAYS): T[] => Array.from({ length }, () => value);
const counts = (each: number) => ({
  now: each * DAYS,
  before: each * DAYS - 9,
  daily: fill(each),
  dailyBefore: fill(each - 1),
});

/** An Overview as genex.games answers it for a week, every part of it well formed. */
const overviewData = (): OverviewReport => ({
  series: {
    players: counts(40),
    newPlayers: counts(12),
    plays: counts(55),
    medianPlaySeconds: { now: 340, before: 318.5, daily: fill(341.5), dailyBefore: fill(300) },
    day1: { now: 0.345, before: 0.324, daily: [...fill(0.35, DAYS - 1), null], dailyBefore: fill(0.32) },
    day7: { now: null, before: 0.137, daily: fill(null), dailyBefore: fill(0.13) },
    installs: null,
    nexSpent: counts(90),
  },
  annotations: [
    { on: "2026-11-12", kind: "campaign", label: "launch_trailer" },
    { on: "2026-11-15", kind: "version", label: "1.4.0" },
  ],
  insights: [
    { kind: "level_drop_off", level: "4", reachedBefore: 0.61, reached: 0.38, tries: 4 },
    { kind: "campaign_retention", campaign: "launch_trailer", newPlayers: 1460, day7: 0.082, day7All: 0.145 },
    { kind: "device_load", device: "phone", loadSeconds: 6.1, loadSecondsOthers: 2.9, leftLoading: 0.14 },
    { kind: "installed_retention", day7Installed: 0.261, day7Browser: 0.122 },
  ],
  channels: [
    { channel: "genex", people: 50 },
    { channel: "campaigns", people: 20 },
    { channel: "direct", people: 14 },
  ],
  retention: {
    rates: [0.345, 0.268, 0.221, ...fill(null, RETENTION_SPAN - 3)],
    before: [0.324, 0.25, 0.2, ...fill(0.1, RETENTION_SPAN - 3)],
    similar: null,
  },
  funnel: [
    { step: "visited", people: 200 },
    { step: "pressed_play", people: 96 },
    { step: "loaded", people: 84 },
    { step: "engaged", people: 60 },
    { step: "returned", people: 22 },
  ],
});
const overviewBody = (data: unknown = overviewData()) => ({
  report: GameReport.Overview,
  game: GAME,
  window: WINDOW,
  data,
});
const QUERY: GameReportQuery = { slug: SLUG, report: GameReport.Overview, days: DAYS };

/** `target` with the value at `path` replaced (undefined reads as a missing part). */
function withAt(target: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  if (Array.isArray(target)) return target.map((item, index) => (index === head ? withAt(item, rest, value) : item));
  return isRecord(target) ? { ...target, [head]: withAt(target[String(head)], rest, value) } : target;
}

interface Call {
  route: string;
  method: string;
  token?: string;
  body?: unknown;
}

/** Calls kept as they are made, answered by `answers`; `signInAs` changes the account. */
function rig(
  answers: (route: string, method: string) => GalleryAnswer,
  { signedIn = true }: { signedIn?: boolean } = {},
) {
  let token: string | undefined = signedIn ? TOKEN : undefined;
  const calls: Call[] = [];
  const request: GalleryRequest = async (route, init) => {
    const method = init.method ?? "GET";
    calls.push({
      route,
      method,
      ...(init.token ? { token: init.token } : {}),
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    return answers(route, method);
  };
  const analytics = gameAnalytics({ request, token: async () => token, now: () => 0, web: WEB });
  const signInAs = (next: string | undefined): void => {
    token = next;
  };
  return { analytics, calls, signInAs };
}

/** Every call of the client with a well-formed question, by name. */
const everyCall = (analytics: GameAnalytics): Array<[string, () => Promise<unknown>]> => [
  ["report", () => analytics.report(QUERY)],
  ["events", () => analytics.events(SLUG, EventOrigin.Published)],
  ["links", () => analytics.links(SLUG, DAYS)],
  ["saveLink", () => analytics.saveLink(SLUG, TAGS)],
  ["removeLink", () => analytics.removeLink(SLUG, "link_1")],
  ["saveFunnel", () => analytics.saveFunnel(SLUG, DRAFT)],
  ["removeFunnel", () => analytics.removeFunnel(SLUG, "funnel_1")],
];

describe("the routes of a game's analytics", () => {
  it("are built from the game, the report and the period, with only the options that report takes", () => {
    assert.equal(reportRoute(QUERY), "/api/projects/neon-rush/analytics/reports/overview?days=7");
    assert.equal(
      reportRoute({
        slug: SLUG,
        report: GameReport.Acquisition,
        days: 30,
        breakdown: SourceBreakdown.Country,
        attribution: Attribution.Latest,
        campaignBy: CampaignField.Source,
        mode: RetentionMode.DayOrLater,
        event: "level_complete",
      }),
      "/api/projects/neon-rush/analytics/reports/acquisition?days=30&breakdown=country&attribution=latest&campaignBy=source",
    );
    assert.equal(
      reportRoute({
        slug: SLUG,
        report: GameReport.Retention,
        days: 90,
        mode: RetentionMode.DayOrLater,
        cohort: CohortSize.Week,
        segmentBy: SegmentBy.Version,
      }),
      "/api/projects/neon-rush/analytics/reports/retention?days=90&mode=day_or_later&cohort=week&segmentBy=version",
    );
    assert.equal(
      reportRoute({ slug: SLUG, report: GameReport.Events, days: 7, event: "level_complete", splitBy: "time s&x=1" }),
      "/api/projects/neon-rush/analytics/reports/events?days=7&event=level_complete&splitBy=time+s%26x%3D1",
    );
    assert.equal(
      eventsStatusRoute(SLUG, EventOrigin.Preview),
      "/api/projects/neon-rush/analytics/events/status?origin=preview",
    );
    assert.equal(linksRoute(SLUG, 30), "/api/projects/neon-rush/analytics/links?days=30");
    assert.equal(AnalyticsRoute.link(SLUG, "a/b"), "/api/projects/neon-rush/analytics/links/a%2Fb");
    assert.equal(AnalyticsRoute.funnel(SLUG, "f_1"), "/api/projects/neon-rush/analytics/funnels/f_1");
  });
});

describe("what every parser of a game's analytics reads with", () => {
  it("takes a number only for what it counts", () => {
    const numbers: unknown[] = [
      0,
      7,
      7.5,
      -1,
      1,
      0.4,
      1.01,
      "7",
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ];
    assert.deepEqual(
      numbers.map((value) => [count(value), amount(value), rate(value)]),
      [
        [0, 0, 0],
        [7, 7, undefined],
        [undefined, 7.5, undefined],
        [undefined, undefined, undefined],
        [1, 1, 1],
        [undefined, 0.4, 0.4],
        [undefined, 1.01, undefined],
        [undefined, undefined, undefined],
        [undefined, undefined, undefined],
        [undefined, undefined, undefined],
        [undefined, undefined, undefined],
        [undefined, undefined, undefined],
      ],
    );
    assert.equal(count(2 ** 53), undefined, "past what a number holds exactly");
  });

  it("keeps 'not known yet' apart from 'not a number'", () => {
    assert.equal(rateOrNull(null), null);
    assert.equal(rateOrNull(0), 0);
    assert.equal(rateOrNull(undefined), undefined);
    assert.equal(rateOrNull("0.3"), undefined);
    assert.equal(orNull(count)(null), null);
    assert.equal(orNull(count)(1.5), undefined);
    assert.deepEqual(measure({ now: null, before: 318.5 }), { now: null, before: 318.5 });
    assert.deepEqual(measure({ now: 0.3, before: null }, rate), { now: 0.3, before: null });
    assert.equal(measure({ now: 1.3, before: null }, rate), undefined);
    assert.equal(measure({ now: 340 }), undefined, "a missing side is not an unknown one");
    assert.deepEqual(compared({ now: 12, before: 0 }), { now: 12, before: 0 });
    assert.equal(compared({ now: 12, before: null }), undefined, "a count is never unknown");
    assert.equal(compared({ now: 1.5, before: 1 }), undefined);
    assert.deepEqual(compared({ now: 1.5, before: 1 }, amount), { now: 1.5, before: 1 });
    assert.equal(compared([12, 0]), undefined);
  });

  it("reads a series whole or not at all, and a list row by row", () => {
    assert.deepEqual(series([1, 2, 3], 3, count), [1, 2, 3]);
    assert.equal(series([1, 2], 3, count), undefined);
    assert.equal(series([1, -2, 3], 3, count), undefined);
    assert.equal(series([1, null, 3], 3, count), undefined);
    assert.deepEqual(series([0.1, null, 0.3], 3, rateOrNull), [0.1, null, 0.3]);
    assert.equal(series("123", 3, count), undefined);
    assert.deepEqual(shortSeries([0.3, null], 30, rateOrNull), [0.3, null]);
    assert.deepEqual(shortSeries([], 30, rateOrNull), []);
    assert.equal(shortSeries(fill(0.1, 31), 30, rateOrNull), undefined);
    assert.deepEqual(rows([1, "x", 2, -3, 4, 5], 3, count), [1, 2, 4], "bad rows left out, the first three kept");
    assert.deepEqual(rows([], 3, count), []);
    assert.equal(rows({ 0: 1 }, 3, count), undefined, "not a list");
    assert.deepEqual(rows([3, 3, 4, 3], 9, count, String), [3, 4], "one row for a key");
  });

  it("cleans a line of words, and refuses one too long or empty", () => {
    assert.equal(line("  launch\u202E_trailer\u0007\u2028 ", 80), "launch_trailer");
    assert.equal(line("\u200F\u0000 ", 80), undefined);
    assert.equal(line("a".repeat(81), 80), undefined);
    assert.equal(line("a".repeat(80), 80), "a".repeat(80));
    assert.equal(line(14, 80), undefined);
    assert.equal(line("tab\tand\nbreak", 80), "tabandbreak", "one line");
  });

  it("knows a vocabulary's values, a real day and a real time", () => {
    const isChannel = oneOf(SourceChannel);
    assert.deepEqual(
      ["genex", "Genex", "campaigns", "toString", 3, null].map((value) => isChannel(value)),
      [true, false, true, false, false, false],
    );
    assert.equal(isoDay("2026-11-17"), "2026-11-17");
    for (const value of ["2026-02-30", "2026-13-01", "17.11.2026", "2026-11-17T00:00:00Z", "", 20261117, null])
      assert.equal(isoDay(value), undefined, String(value));
    assert.equal(isoTime("2026-11-17T12:00:00Z"), "2026-11-17T12:00:00.000Z");
    assert.equal(isoTime("2026-11-17T14:00:00.5+02:00"), "2026-11-17T12:00:00.500Z");
    for (const value of ["2026-11-17", "4 min ago", "Nov 17 2026 12:00", "2026-11-17T25:00:00Z", 1763380800000, null])
      assert.equal(isoTime(value), undefined, String(value));
  });

  it("makes a whole of parts only when every part was read", () => {
    assert.deepEqual(whole({ now: count(3), before: rateOrNull(null) }), { now: 3, before: null });
    assert.equal(whole({ now: count(3), before: rateOrNull("x") }), undefined);
    assert.deepEqual(whole({}), {});
  });
});

describe("reading a game's analytics", () => {
  it("answers the report genex.games gave, asked with the account's token", async () => {
    const { analytics, calls } = rig(() => ok(overviewBody()));
    const read = await analytics.report(QUERY);
    assert.deepEqual(read, {
      kind: ReadKind.Ready,
      value: { report: GameReport.Overview, game: GAME, window: WINDOW, data: overviewData() },
    });
    assert.deepEqual(calls, [{ route: reportRoute(QUERY), method: "GET", token: TOKEN }]);
  });

  it("needs the account: signed out, nothing is asked", async () => {
    const { analytics, calls } = rig(() => ok(overviewBody()), { signedIn: false });
    for (const [name, call] of everyCall(analytics)) await assert.rejects(call(), SignInNeeded, name);
    assert.equal(calls.length, 0);
  });

  it("reads a rejected token as a sign-in that ended", async () => {
    const { analytics } = rig(() => status(401));
    for (const [name, call] of everyCall(analytics)) await assert.rejects(call(), SignInNeeded, name);
  });

  it("tells a game that is not there and a report it does not have from a genex.games that serves neither yet", async () => {
    const kinds: Array<[unknown, ReadKind]> = [
      [{ code: "no_game" }, ReadKind.NoGame],
      [{ code: "no_report" }, ReadKind.NoReport],
      [null, ReadKind.Unavailable],
      [{}, ReadKind.Unavailable],
      [{ code: "unavailable" }, ReadKind.Unavailable],
      [{ code: "ready" }, ReadKind.Unavailable],
      [{ code: "gone" }, ReadKind.Unavailable],
      [{ code: 404 }, ReadKind.Unavailable],
      [{ error: "no_game" }, ReadKind.Unavailable],
      ["no_game", ReadKind.Unavailable],
    ];
    for (const [body, kind] of kinds) {
      const { analytics } = rig(() => status(404, body));
      assert.deepEqual(await analytics.report(QUERY), { kind }, JSON.stringify(body));
      assert.deepEqual(await analytics.events(SLUG, EventOrigin.Published), { kind }, JSON.stringify(body));
      assert.deepEqual(await analytics.links(SLUG, DAYS), { kind }, JSON.stringify(body));
    }
  });

  it("fails on any other refusal, keeping its status", async () => {
    for (const code of [400, 403, 409, 429, 500, 503]) {
      const { analytics } = rig(() => status(code, { code: "no_game" }));
      await assert.rejects(analytics.report(QUERY), (error) => error instanceof GalleryError && error.status === code);
    }
  });

  it("fails on an answer its parser cannot read: a broken answer is never 'not served yet' and never zeros", async () => {
    const quiet = {
      game: GAME,
      origin: EventOrigin.Published,
      lastAt: null,
      names: 0,
      recent: [],
      dropped: [],
      limits: EVENT_LIMITS,
    };
    const shapeless = [null, {}, [], "ok", 0];
    const reads: Array<{
      name: string;
      call: (analytics: GameAnalytics) => Promise<{ kind: ReadKind }>;
      readable: unknown;
      broken: unknown[];
    }> = [
      {
        name: "report",
        call: (analytics) => analytics.report(QUERY),
        readable: overviewBody(),
        broken: [
          ...shapeless,
          overviewBody({}),
          overviewBody(null),
          { ...overviewBody(), report: GameReport.Revenue },
          { ...overviewBody(), game: null },
          { ...overviewBody(), window: { ...WINDOW, days: 30 } },
        ],
      },
      {
        name: "events status",
        call: (analytics) => analytics.events(SLUG, EventOrigin.Published),
        readable: quiet,
        broken: [
          ...shapeless,
          overviewBody(),
          { ...quiet, origin: EventOrigin.Preview },
          { ...quiet, names: -1 },
          { ...quiet, recent: "none" },
          { ...quiet, game: { ...GAME, slug: "another-game" } },
        ],
      },
      {
        name: "links",
        call: (analytics) => analytics.links(SLUG, DAYS),
        readable: { links: [] },
        broken: [...shapeless, overviewBody(), { links: null }, { links: "none" }],
      },
    ];
    for (const { name, call, readable, broken } of reads) {
      assert.equal(
        (await call(rig(() => ok(readable)).analytics)).kind,
        ReadKind.Ready,
        `${name} reads when well formed`,
      );
      for (const body of broken) {
        const label = `${name}: ${JSON.stringify(body)?.slice(0, 60)}`;
        await assert.rejects(call(rig(() => ok(body)).analytics), GalleryError, label);
      }
    }
  });

  it("keeps nothing from one account for the next", async () => {
    const { analytics, calls, signInAs } = rig(() => ok(overviewBody()));
    await analytics.report(QUERY);
    signInAs("another-account");
    await analytics.report(QUERY);
    assert.deepEqual(
      calls.map((call) => call.token),
      [TOKEN, "another-account"],
    );
    signInAs(undefined);
    await assert.rejects(analytics.report(QUERY), SignInNeeded);
    assert.equal(calls.length, 2);
  });

  it("fails a save or a removal genex.games refused, whatever it says, and sends each as its own call", async () => {
    const refused = rig(() => status(404, { code: "no_game" }));
    await assert.rejects(refused.analytics.saveLink(SLUG, TAGS), GalleryError);
    await assert.rejects(refused.analytics.removeLink(SLUG, "link_1"), GalleryError);
    await assert.rejects(refused.analytics.saveFunnel(SLUG, DRAFT), GalleryError);
    await assert.rejects(refused.analytics.removeFunnel(SLUG, "funnel_1"), GalleryError);
    assert.deepEqual(
      refused.calls.map((call) => [call.method, call.route, call.body]),
      [
        ["POST", AnalyticsRoute.links(SLUG), TAGS],
        ["DELETE", AnalyticsRoute.link(SLUG, "link_1"), undefined],
        ["POST", AnalyticsRoute.funnels(SLUG), DRAFT],
        ["DELETE", AnalyticsRoute.funnel(SLUG, "funnel_1"), undefined],
      ],
    );
    assert.ok(refused.calls.every((call) => call.token === TOKEN));
  });

  it("tells a save past the game's limit apart by a code, so the page can say to remove one first", async () => {
    const full = rig(() => status(409, { code: "limit" }));
    for (const save of [() => full.analytics.saveLink(SLUG, TAGS), () => full.analytics.saveFunnel(SLUG, DRAFT)]) {
      await assert.rejects(save(), (error) => errorCode(error) === AnalyticsSaveRefusal.Limit);
    }
    const others: Array<[number, unknown]> = [
      [409, null],
      [409, { code: "conflict" }],
      [409, "limit"],
      [400, { code: "limit" }],
      [500, { code: "limit" }],
    ];
    for (const [code, body] of others) {
      const { analytics } = rig(() => status(code, body));
      const label = `${code} ${JSON.stringify(body)}`;
      await assert.rejects(analytics.saveLink(SLUG, TAGS), (error) => errorCode(error) === null, label);
      await assert.rejects(analytics.saveLink(SLUG, TAGS), GalleryError, label);
    }
    const reading = rig(() => status(409, { code: "limit" }));
    await assert.rejects(reading.analytics.report(QUERY), GalleryError, "a read is never refused for a limit");
    await assert.rejects(reading.analytics.removeLink(SLUG, "link_1"), GalleryError, "nor a removal");
  });

  it("keeps a campaign link only when it points at the game's own page on the website Play links to", async () => {
    const linkTo = (url: string, shortUrl: string | null) => ({
      ...TAGS,
      id: "link_1",
      url,
      shortUrl,
      createdOn: ENDS_ON,
      newVisitors: 0,
      newPlayers: 0,
      day7: null,
    });
    const page = `${WEB}/${SLUG}?utm_source=tiktok`;
    const listed = rig(() =>
      ok({ links: [linkTo(page, `${WEB}/go/1`), { ...linkTo("https://evil.example/neon-rush", null), id: "link_2" }] }),
    );
    const read = await listed.analytics.links(SLUG, DAYS);
    assert.deepEqual(read.kind === ReadKind.Ready ? read.value.map((link) => [link.id, link.url, link.shortUrl]) : [], [
      ["link_1", page, `${WEB}/go/1`],
    ]);
    const elsewhere = rig(() => ok(linkTo(`${WEB}/another-game?utm_source=tiktok`, null)));
    await assert.rejects(elsewhere.analytics.saveLink(SLUG, TAGS), GalleryError, "a saved link that points elsewhere");
  });

  it("removes a link or a funnel on any success, and saves tags as genex.games keeps them", async () => {
    const { analytics, calls } = rig((_route, method) => (method === "DELETE" ? status(204) : status(500)));
    assert.equal(await analytics.removeLink(SLUG, "link_1"), undefined);
    assert.equal(await analytics.removeFunnel(SLUG, "funnel_1"), undefined);
    await assert.rejects(
      analytics.saveLink(SLUG, {
        source: " TikTok ",
        medium: "Paid Social",
        campaign: "Launch  Trailer",
        content: " ",
        term: null,
      }),
      GalleryError,
    );
    assert.deepEqual(calls.at(-1)?.body, {
      source: "tiktok",
      medium: "paid_social",
      campaign: "launch_trailer",
      content: null,
      term: null,
    });
  });
});

describe("a malformed question about a game's analytics", () => {
  const long = (length: number) => "a".repeat(length);
  const query = (change: Record<string, unknown>): GameReportQuery => ({ ...QUERY, ...change }) as GameReportQuery;
  const tags = (change: Record<string, unknown>): CampaignTags => ({ ...TAGS, ...change }) as CampaignTags;
  const draft = (change: Record<string, unknown>): EventFunnelDraft => ({ ...DRAFT, ...change }) as EventFunnelDraft;
  const step = (change: Record<string, unknown>) => ({ event: "level_start", property: null, value: null, ...change });

  const questions = (analytics: GameAnalytics): Array<[string, () => Promise<unknown>]> => [
    ["a slug with a space", () => analytics.report(query({ slug: "Bad Slug" }))],
    ["a slug that climbs", () => analytics.report(query({ slug: "../admin" }))],
    ["a slug with a query", () => analytics.report(query({ slug: "neon?x=1" }))],
    ["a slug that is a number", () => analytics.report(query({ slug: 7 }))],
    ["no slug", () => analytics.report(query({ slug: undefined }))],
    ["no question at all", () => analytics.report(undefined as unknown as GameReportQuery)],
    ["a period the page does not offer", () => analytics.report(query({ days: 14 }))],
    ["a period as text", () => analytics.report(query({ days: "30" }))],
    ["an unknown report", () => analytics.report(query({ report: "sales" }))],
    ["a report that is a path", () => analytics.report(query({ report: "overview/../../users" }))],
    ["an unknown breakdown", () => analytics.report(query({ breakdown: "planet" }))],
    ["an attribution that is a number", () => analytics.report(query({ attribution: 1 }))],
    ["an unknown campaign field", () => analytics.report(query({ campaignBy: "utm_campaign" }))],
    ["an unknown retention mode", () => analytics.report(query({ mode: "rolling" }))],
    ["an unknown cohort size", () => analytics.report(query({ cohort: "month" }))],
    ["an unknown segment", () => analytics.report(query({ segmentBy: "browser" }))],
    ["an option that is null", () => analytics.report(query({ breakdown: null }))],
    ["an event name with capitals", () => analytics.report(query({ event: "Level Complete" }))],
    ["an event name too long", () => analytics.report(query({ event: long(41) }))],
    ["an event name with a control character", () => analytics.report(query({ event: "level\u0007" }))],
    ["an empty event name", () => analytics.report(query({ event: "" }))],
    ["a split property too long", () => analytics.report(query({ splitBy: long(41) }))],
    ["a split property that turns text around", () => analytics.report(query({ splitBy: "level\u202Egnp" }))],
    ["a split property with a line break", () => analytics.report(query({ splitBy: "level\nx" }))],
    ["an empty split property", () => analytics.report(query({ splitBy: "" }))],
    ["events of a bad slug", () => analytics.events("Bad Slug", EventOrigin.Published)],
    ["events from an unknown place", () => analytics.events(SLUG, "live" as EventOrigin)],
    ["links of a bad slug", () => analytics.links("a/b", DAYS)],
    ["links over a period the page does not offer", () => analytics.links(SLUG, 14 as StatsPeriod)],
    ["a link for a bad slug", () => analytics.saveLink("Bad Slug", TAGS)],
    ["tags that are not tags", () => analytics.saveLink(SLUG, "utm_source=x" as unknown as CampaignTags)],
    ["tags with no source", () => analytics.saveLink(SLUG, tags({ source: undefined }))],
    ["an empty campaign", () => analytics.saveLink(SLUG, tags({ campaign: "   " }))],
    ["a tag too long", () => analytics.saveLink(SLUG, tags({ medium: long(81) }))],
    ["a tag with a control character", () => analytics.saveLink(SLUG, tags({ source: "tik\u0000tok" }))],
    ["a tag that turns text around", () => analytics.saveLink(SLUG, tags({ campaign: "launch\u202E" }))],
    ["a content tag that is a number", () => analytics.saveLink(SLUG, tags({ content: 4 }))],
    ["a term tag too long", () => analytics.saveLink(SLUG, tags({ term: long(81) }))],
    ["a link id that climbs", () => analytics.removeLink(SLUG, "../links")],
    ["an empty link id", () => analytics.removeLink(SLUG, "")],
    ["a link id too long", () => analytics.removeLink(SLUG, long(65))],
    ["a link id that is a number", () => analytics.removeLink(SLUG, 3 as unknown as string)],
    ["a funnel for a bad slug", () => analytics.saveFunnel("Bad Slug", DRAFT)],
    ["a funnel that is not one", () => analytics.saveFunnel(SLUG, [] as unknown as EventFunnelDraft)],
    ["a funnel with no name", () => analytics.saveFunnel(SLUG, draft({ name: " " }))],
    ["a funnel name too long", () => analytics.saveFunnel(SLUG, draft({ name: long(81) }))],
    ["a funnel name with a control character", () => analytics.saveFunnel(SLUG, draft({ name: "First\u001B[2J" }))],
    ["a funnel over no days", () => analytics.saveFunnel(SLUG, draft({ withinDays: 0 }))],
    ["a funnel over too many days", () => analytics.saveFunnel(SLUG, draft({ withinDays: 31 }))],
    ["a funnel over part of a day", () => analytics.saveFunnel(SLUG, draft({ withinDays: 1.5 }))],
    ["a funnel with no steps", () => analytics.saveFunnel(SLUG, draft({ steps: [] }))],
    ["a funnel whose steps are not a list", () => analytics.saveFunnel(SLUG, draft({ steps: { 0: step({}) } }))],
    ["a funnel with too many steps", () => analytics.saveFunnel(SLUG, draft({ steps: fill(step({}), 9) }))],
    [
      "a step that is not an event",
      () => analytics.saveFunnel(SLUG, draft({ steps: [step({ event: "Level Start" })] })),
    ],
    [
      "a step's property too long",
      () => analytics.saveFunnel(SLUG, draft({ steps: [step({ property: long(41), value: "1" })] })),
    ],
    [
      "a step's value too long",
      () => analytics.saveFunnel(SLUG, draft({ steps: [step({ property: "level", value: long(201) })] })),
    ],
    [
      "a step's value with a control character",
      () => analytics.saveFunnel(SLUG, draft({ steps: [step({ property: "level", value: "1\u0000" })] })),
    ],
    ["a step with a value and no property", () => analytics.saveFunnel(SLUG, draft({ steps: [step({ value: "1" })] }))],
    [
      "a step with a property and no value",
      () => analytics.saveFunnel(SLUG, draft({ steps: [step({ property: "level" })] })),
    ],
    ["a funnel id that climbs", () => analytics.removeFunnel(SLUG, "a/../b")],
  ];

  it("is refused before anything is asked of genex.games", async () => {
    const { analytics, calls } = rig(() => ok(overviewBody()));
    for (const [name, ask] of questions(analytics)) {
      await assert.rejects(async () => ask(), Error, name);
      assert.equal(calls.length, 0, name);
    }
  });
});

describe("an answer about a game's analytics", () => {
  it("is not one when it answers another report, game or period, or lacks a part", () => {
    assert.ok(toReportAnswer(overviewBody(), QUERY), "the well-formed answer reads");
    const broken: Array<[string, unknown]> = [
      ["not an object", "overview"],
      ["a list", [overviewBody()]],
      ["another report echoed", withAt(overviewBody(), ["report"], GameReport.Revenue)],
      ["no report echoed", withAt(overviewBody(), ["report"], undefined)],
      ["another game", withAt(overviewBody(), ["game", "slug"], "other-game")],
      ["no game", withAt(overviewBody(), ["game"], undefined)],
      ["a game with no title", withAt(overviewBody(), ["game", "title"], "")],
      ["a title that is only control characters", withAt(overviewBody(), ["game", "title"], "\u0007\u202E")],
      ["a title far too long", withAt(overviewBody(), ["game", "title"], "a".repeat(5000))],
      ["no count of who plays now", withAt(overviewBody(), ["game", "playingNow"], undefined)],
      ["who plays now as null", withAt(overviewBody(), ["game", "playingNow"], null)],
      ["fewer than nobody playing now", withAt(overviewBody(), ["game", "playingNow"], -1)],
      ["half a person playing now", withAt(overviewBody(), ["game", "playingNow"], 2.5)],
      ["who plays now as text", withAt(overviewBody(), ["game", "playingNow"], "3")],
      ["another period", withAt(overviewBody(), ["window", "days"], 30)],
      ["a period as text", withAt(overviewBody(), ["window", "days"], "7")],
      ["no window", withAt(overviewBody(), ["window"], undefined)],
      ["a last day that is not a day", withAt(overviewBody(), ["window", "endsOn"], "yesterday")],
      ["a last day that does not exist", withAt(overviewBody(), ["window", "endsOn"], "2026-02-31")],
      ["a computed time that is not one", withAt(overviewBody(), ["window", "computedAt"], "4 min ago")],
      ["no data", withAt(overviewBody(), ["data"], undefined)],
      ["data of another shape", withAt(overviewBody(), ["data"], { nex: { now: 1, before: 1 } })],
    ];
    for (const [name, body] of broken) assert.equal(toReportAnswer(body, QUERY), null, name);
    assert.equal(toReportAnswer(overviewBody(), { ...QUERY, days: 30 }), null, "asked for another period");
    assert.equal(toReportAnswer(overviewBody(), { ...QUERY, slug: "other" }), null, "asked about another game");
    assert.equal(
      toReportAnswer(overviewBody(), { ...QUERY, report: GameReport.Acquisition }),
      null,
      "asked for another report",
    );
  });

  it("names the game in clean words and with a cover only from Genex's hosts", () => {
    const body = withAt(
      withAt(overviewBody(), ["game", "title"], "  Neon\u202E \u0007Rush\u200F "),
      ["game", "coverUrl"],
      "https://evil.example/c.png",
    );
    const answer = toReportAnswer(withAt(body, ["game", "version"], 14), QUERY);
    assert.equal(answer?.game.title, "Neon Rush");
    assert.equal(answer?.game.coverUrl, null);
    assert.equal(answer?.game.version, null, "a version that is not text is no version");
    assert.equal(answer?.window.computedAt, WINDOW.computedAt);
  });
});

describe("the Overview report", () => {
  const read = (data: unknown) => toOverviewReport(data, WINDOW);

  it("reads every part of a well-formed answer as it was sent", () => {
    assert.deepEqual(read(overviewData()), overviewData());
  });

  it("is not a report when a part is missing or a number is not what it should be", () => {
    const broken: Array<[string, readonly (string | number)[], unknown]> = [
      ["no series", ["series"], undefined],
      ["series that are a list", ["series"], []],
      ["a missing metric", ["series", "plays"], undefined],
      ["a metric that is a number", ["series", "players"], 9300],
      ["a count as text", ["series", "players", "now"], "280"],
      ["a negative count", ["series", "players", "now"], -1],
      ["a fractional count", ["series", "newPlayers", "before"], 12.5],
      ["a count that is not finite", ["series", "plays", "now"], Number.POSITIVE_INFINITY],
      ["a missing total", ["series", "plays", "before"], undefined],
      ["a negative day", ["series", "plays", "daily", 3], -4],
      ["a fractional day", ["series", "nexSpent", "daily", 0], 0.5],
      ["a day as text", ["series", "players", "dailyBefore", 6], "40"],
      ["a series one day short", ["series", "players", "daily"], fill(40, DAYS - 1)],
      ["a series one day long", ["series", "plays", "dailyBefore"], fill(54, DAYS + 1)],
      ["a series of another period", ["series", "day1", "daily"], fill(0.3, 30)],
      ["a series that is not a list", ["series", "newPlayers", "daily"], { 0: 12 }],
      ["a rate above one", ["series", "day1", "now"], 34.5],
      ["a negative rate", ["series", "day7", "before"], -0.1],
      ["a rate as text", ["series", "day1", "before"], "32%"],
      ["a daily rate above one", ["series", "day1", "daily", 2], 1.01],
      ["a negative play length", ["series", "medianPlaySeconds", "now"], -5],
      ["no annotations", ["annotations"], undefined],
      ["annotations that are not a list", ["annotations"], {}],
      ["no insights", ["insights"], undefined],
      ["no channels", ["channels"], null],
      ["no funnel", ["funnel"], "visited"],
      ["no retention", ["retention"], undefined],
      ["a retention curve too long", ["retention", "rates"], fill(0.1, RETENTION_SPAN + 1)],
      ["a rate above one in the curve", ["retention", "rates", 1], 26.8],
      ["a curve before of another length", ["retention", "before"], fill(0.1, 5)],
      ["a curve of similar games of another length", ["retention", "similar"], fill(0.1, 5)],
      ["a curve that is not a list", ["retention", "rates"], "0.345"],
    ];
    for (const [name, path, value] of broken) assert.equal(read(withAt(overviewData(), path, value)), null, name);
    assert.equal(read(null), null);
    assert.equal(read([]), null);
  });

  it("keeps a rate that cannot be known yet as null, never as zero", () => {
    const report = read(overviewData()) ?? assert.fail();
    assert.equal(report.series.day7?.now, null);
    assert.deepEqual(report.series.day7?.daily, fill(null));
    assert.equal(report.series.day1?.daily.at(-1), null);
    assert.equal(report.retention.rates[3], null);
    assert.equal(report.retention.similar, null);
    assert.equal(report.series.installs, null, "no app build: no installs series");
    const unknown = read(withAt(overviewData(), ["series", "medianPlaySeconds", "before"], null)) ?? assert.fail();
    assert.equal(unknown.series.medianPlaySeconds?.before, null);
    const noPlayers = read(withAt(overviewData(), ["series", "players", "daily", 2], null)) ?? assert.fail();
    assert.equal(noPlayers.series.players?.daily[2], null);
  });

  it("drops the rows it cannot trust and keeps the rest", () => {
    const data = {
      ...overviewData(),
      annotations: [
        { on: "2026-11-12", kind: "campaign", label: " launch\u202E_trailer\u0007 " },
        { on: "2026-11-13", kind: "holiday", label: "Halloween" },
        { on: "13 Nov", kind: "version", label: "1.4.0" },
        { on: "2026-11-10", kind: "version", label: "before the period" },
        { on: "2026-11-18", kind: "version", label: "after the period" },
        { on: "2026-11-14", kind: "version", label: "v".repeat(500) },
        { on: "2026-11-14", kind: "version", label: 14 },
        "2026-11-15",
        { on: "2026-11-17", kind: "version", label: "1.4.1" },
      ],
      insights: [
        { kind: "weather", note: "rain" },
        { kind: "level_drop_off", level: "4", reachedBefore: 61, reached: 0.38, tries: 4 },
        { kind: "level_drop_off", level: "5\u202E", reachedBefore: 0.4, reached: 0.31, tries: null },
        { kind: "campaign_retention", campaign: "launch_trailer", newPlayers: -3, day7: 0.082, day7All: 0.145 },
        { kind: "device_load", device: "fridge", loadSeconds: 6.1, loadSecondsOthers: 2.9, leftLoading: 0.14 },
        { kind: "installed_retention", day7Installed: 0.261, day7Browser: 0.122 },
        null,
      ],
      channels: [
        { channel: "genex", people: 50 },
        { channel: "telepathy", people: 40 },
        { channel: "genex", people: 1 },
        { channel: "social", people: -2 },
        { channel: "search", people: 3 },
      ],
      funnel: [
        { step: "visited", people: 200 },
        { step: "teleported", people: 150 },
        { step: "loaded", people: 84 },
        { step: "loaded", people: 1 },
        { step: "engaged", people: "60" },
      ],
    };
    const report = read(data) ?? assert.fail();
    assert.deepEqual(report.annotations, [
      { on: "2026-11-12", kind: "campaign", label: "launch_trailer" },
      { on: "2026-11-17", kind: "version", label: "1.4.1" },
    ]);
    assert.deepEqual(report.insights, [
      { kind: "level_drop_off", level: "5", reachedBefore: 0.4, reached: 0.31, tries: null },
      { kind: "installed_retention", day7Installed: 0.261, day7Browser: 0.122 },
    ]);
    assert.deepEqual(report.channels, [
      { channel: SourceChannel.Genex, people: 50 },
      { channel: SourceChannel.Search, people: 3 },
    ]);
    assert.deepEqual(report.funnel, [
      { step: FunnelStep.Visited, people: 200 },
      { step: FunnelStep.Loaded, people: 84 },
    ]);
  });

  it("keeps no more rows than a page can show", () => {
    const mark = (index: number) => ({ on: ENDS_ON, kind: "version", label: `1.0.${index}` });
    const insight = { kind: "installed_retention", day7Installed: 0.2, day7Browser: 0.1 };
    const data = {
      ...overviewData(),
      annotations: Array.from({ length: 5000 }, (_, index) => mark(index)),
      insights: fill(insight, 5000),
    };
    const report = read(data) ?? assert.fail();
    assert.ok(report.annotations.length <= 100, `${report.annotations.length} annotations`);
    assert.equal(report.annotations[0]?.label, "1.0.0", "the first ones sent");
    assert.ok(report.insights.length <= 12, `${report.insights.length} insights`);
  });
});

describe("the fixture account's game analytics", () => {
  const NOW = Date.parse("2026-11-17T12:04:00.000Z");
  const author = { id: "fx-simeon-m", name: "Simeon M" };
  const items = [
    { slug: "lost-cathedral", title: "Lost Cathedral", thumbnailUrl: null, playsCount: 2682, online: null, author },
    { slug: "stick-steel", title: "Stick & Steel", thumbnailUrl: null, playsCount: 2431, online: 6, author },
    {
      slug: "skate",
      title: "SKATE",
      thumbnailUrl: null,
      playsCount: 5285,
      online: 8,
      author,
      builds: [{ platform: "macos" }],
    },
  ];
  const catalog = { games: (authorId: string) => (authorId === author.id ? items : []) };
  const full = fixtureAccountToken(FixtureAccount.Full);
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  const sampleOf = (slug: string, days: StatsPeriod, account: FixtureAccount = FixtureAccount.Full) => {
    const source = ownSamples(account, catalog).find((game) => game.slug === slug) ?? assert.fail(`no ${slug}`);
    return gameSample(source, days, NOW);
  };
  const fixture = () => createFixtureGameAnalytics({ now: () => NOW });
  /** The fixture's Overview for a game, read by the real parser. */
  const overviewOf = (slug: string, days: StatsPeriod, token = full) => {
    const query = { slug, report: GameReport.Overview, days };
    const answer = fixture().answer(reportRoute(query), { method: "GET", token }, catalog);
    assert.equal(answer?.status, 200, `${slug} over ${days} days`);
    const read = toReportAnswer(answer?.body, query, true) ?? assert.fail(`${slug} over ${days} days does not read`);
    assert.equal(read.report, GameReport.Overview);
    return read.report === GameReport.Overview ? read : assert.fail();
  };

  it("answers an Overview the real parser reads, for every game and period, exactly as it was made", () => {
    for (const { slug } of items) {
      for (const days of STATS_PERIODS) {
        const query = { slug, report: GameReport.Overview, days };
        const answer = fixture().answer(reportRoute(query), { method: "GET", token: full }, catalog);
        const sent = isRecord(answer?.body) ? answer.body.data : undefined;
        const read = overviewOf(slug, days);
        assert.deepEqual(read.data, JSON.parse(JSON.stringify(sent)), `${slug} over ${days} days loses nothing`);
        assert.equal(read.window.days, days);
        assert.equal(read.window.endsOn, "2026-11-17", "the period ends today, in UTC");
        assert.equal(read.game.slug, slug);
        for (const series of Object.values(read.data.series)) {
          if (!series) continue;
          assert.equal(series.daily.length, days);
          assert.equal(series.dailyBefore.length, days);
        }
      }
    }
  });

  it("reads an answer only when it echoes the options asked from a closed vocabulary, as the period and the game", () => {
    const bodyOf = (query: GameReportQuery) =>
      fixture().answer(reportRoute(query), { method: "GET", token: full }, catalog)?.body;
    const echoes: Array<[string, GameReportQuery, readonly (string | number)[], unknown]> = [
      [
        "a breakdown",
        { slug: "skate", report: GameReport.Acquisition, days: 30, breakdown: SourceBreakdown.Country },
        ["data", "breakdown"],
        SourceBreakdown.Channel,
      ],
      [
        "an attribution",
        { slug: "skate", report: GameReport.Acquisition, days: 30, attribution: Attribution.Latest },
        ["data", "attribution"],
        Attribution.First,
      ],
      [
        "a campaign tag",
        { slug: "skate", report: GameReport.Acquisition, days: 30, campaignBy: CampaignField.Medium },
        ["data", "campaignBy"],
        CampaignField.Campaign,
      ],
      [
        "a retention mode",
        { slug: "skate", report: GameReport.Retention, days: 30, mode: RetentionMode.OnDay },
        ["data", "mode"],
        RetentionMode.DayOrLater,
      ],
      [
        "a cohort size",
        { slug: "skate", report: GameReport.Retention, days: 30, cohort: CohortSize.Week },
        ["data", "cohort"],
        CohortSize.Day,
      ],
      [
        "a split of new players",
        { slug: "skate", report: GameReport.Retention, days: 30, segmentBy: SegmentBy.Country },
        ["data", "segmentBy"],
        SegmentBy.Place,
      ],
    ];
    for (const [name, query, path, other] of echoes) {
      const body = bodyOf(query);
      assert.ok(toReportAnswer(body, query, true), `${name}: the answer to it reads`);
      assert.equal(toReportAnswer(withAt(body, path, other), query, true), null, `${name}: another one echoed`);
    }
    const unasked = { slug: "skate", report: GameReport.Acquisition, days: 30 } as const;
    assert.ok(toReportAnswer(bodyOf(unasked), unasked, true), "what genex.games picks when nothing is asked reads");
    const named = { slug: "skate", report: GameReport.Events, days: 30, event: "no_such_event" } as const;
    assert.ok(
      toReportAnswer(bodyOf(named), named, true),
      "an event a game no longer sends: the detail shown by default",
    );
  });

  it("gives its richest game the numbers the page was designed with, over 30 days", () => {
    const { data, game } = overviewOf("skate", 30);
    const totals = Object.fromEntries(Object.entries(data.series).map(([metric, series]) => [metric, series?.now]));
    assert.deepEqual(totals, {
      players: 9300,
      newPlayers: 7840,
      plays: 30889,
      medianPlaySeconds: 340,
      day1: 0.345,
      day7: 0.145,
      installs: 1060,
      nexSpent: 48610,
    });
    assert.equal(game.hasAppBuild, true);
    assert.deepEqual(
      [2, 6, 13, 29].map((index) => data.retention.rates[index]),
      [0.221, 0.145, 0.096, 0.053],
      "Day 3, 7, 14 and 30",
    );
    assert.deepEqual(
      data.funnel.map((count) => [count.step, count.people]),
      [
        [FunnelStep.Visited, 19380],
        [FunnelStep.PressedPlay, 8560],
        [FunnelStep.Loaded, 7840],
        [FunnelStep.Engaged, 5960],
        [FunnelStep.Returned, 2270],
      ],
    );
    assert.deepEqual(
      data.channels.map((count) => [count.channel, count.people]),
      [
        [SourceChannel.Genex, 3790],
        [SourceChannel.Campaigns, 2480],
        [SourceChannel.Social, 790],
        [SourceChannel.Direct, 520],
        [SourceChannel.Search, 170],
        [SourceChannel.Other, 90],
      ],
    );
    assert.deepEqual(data.annotations, [
      { on: dayBefore("2026-11-17", 12), kind: "campaign", label: "launch_trailer" },
      { on: dayBefore("2026-11-17", 8), kind: "version", label: "1.4.0" },
    ]);
    const daily = data.series.newPlayers?.daily ?? assert.fail();
    assert.ok((daily[17] ?? 0) > 4 * (daily[16] ?? 0), "the campaign's first day is a spike in new players");
    assert.deepEqual(
      data.insights.map((insight) => insight.kind),
      ["level_drop_off", "campaign_retention", "device_load", "installed_retention"],
    );
  });

  /** What must hold of any sample for its reports to agree. */
  function agrees(made: GameSample, name: string): void {
    assert.equal(sum(made.channels.map((channel) => channel.newPlayers)), made.newPlayers.now, name);
    assert.equal(sum(made.channels.map((channel) => channel.newVisitors)), made.newVisitors.now, name);
    assert.equal(sum(made.newPlayers.daily), made.newPlayers.now, name);
    assert.equal(sum(made.newPlayers.dailyBefore), made.newPlayers.before, name);
    assert.equal(sum(made.plays.daily), made.plays.now, name);
    assert.equal(sum(made.nex.daily), made.nex.now, name);
    made.newPlayers.daily.forEach((people, day) => {
      const byChannel = sum(made.channels.map((channel) => channel.daily[day] ?? Number.NaN));
      assert.equal(byChannel, people, `${name}, day ${day}: channels sum to new players`);
    });
    assert.ok(
      made.channels.every((channel) => channel.daily.every((people) => people >= 0)),
      name,
    );
    assert.equal(made.funnel[0]?.people, made.newVisitors.now, `${name}: the funnel starts at every new visitor`);
    const loaded = made.funnel.find((count) => count.step === FunnelStep.Loaded);
    assert.equal(loaded?.people, made.newPlayers.now, `${name}: a new player is a visitor whose game loaded`);
    assert.deepEqual(
      made.funnel.map((count) => count.people),
      made.funnel.map((count) => count.people).toSorted((a, b) => b - a),
      `${name}: fewer people at each step`,
    );
    assert.equal(made.day1.now, made.retention.rates[0], `${name}: Day 1 is one number`);
    assert.equal(made.day7.now, made.retention.rates[6], `${name}: Day 7 is one number`);
    assert.ok(made.players.now <= sum(made.players.daily), `${name}: no more players than player-days`);
    assert.ok(made.players.now >= made.newPlayers.now, `${name}: every new player is a player`);
    assert.ok(made.payers.now <= made.players.now, `${name}: every payer is a player`);
    assert.equal(made.dates.length, made.window.days, name);
    assert.equal(made.dates.at(-1), made.window.endsOn, name);
  }

  it("makes every report of a game from one sample, so its numbers agree with each other", () => {
    const sample = sampleOf("skate", 30);
    assert.deepEqual(
      [sample.payers.now, sample.purchases.now, sample.nex.now, sample.newVisitors.now],
      [412, 837, 48610, 19380],
    );
    assert.deepEqual(
      sample.channels.map((channel) => [channel.channel, channel.newVisitors, channel.newPlayers]),
      [
        [SourceChannel.Genex, 8620, 3790],
        [SourceChannel.Campaigns, 6010, 2480],
        [SourceChannel.Social, 2180, 790],
        [SourceChannel.Direct, 1540, 520],
        [SourceChannel.Search, 580, 170],
        [SourceChannel.Other, 450, 90],
      ],
    );
    assert.equal(sample.campaign?.name, "launch_trailer");
    assert.equal(sample.campaign?.startsOn, dayBefore("2026-11-17", 12));
    assert.equal(sample.campaign?.newPlayers, 1460);
    for (const { slug } of items) {
      for (const days of STATS_PERIODS) agrees(sampleOf(slug, days), `${slug} over ${days} days`);
    }
    const week = sampleOf("skate", 7);
    const season = sampleOf("skate", 90);
    assert.deepEqual(week.newPlayers.daily, sample.newPlayers.daily.slice(-7), "a week is the month's last week");
    assert.deepEqual(season.plays.daily.slice(-30), sample.plays.daily, "the month is the season's last month");
    assert.deepEqual(season.plays.daily.slice(30, 60), sample.plays.dailyBefore, "and the month before it");
    assert.deepEqual(sampleOf("skate", 30), sample, "the same game on the same day is the same sample");
  });

  it("has a game with no app build and a young one with almost nothing", () => {
    const steady = overviewOf("lost-cathedral", 30);
    assert.equal(steady.game.hasAppBuild, false);
    assert.equal(steady.data.series.installs, null);
    assert.ok((steady.data.series.players?.now ?? 0) > 100);
    const young = overviewOf("stick-steel", 30);
    assert.ok((young.data.series.players?.now ?? 0) > 0, "somebody played");
    assert.ok((young.data.series.players?.now ?? 0) < 40, "but few");
    assert.equal(young.data.series.day7?.now, null, "Day 7 has not come");
    assert.deepEqual(young.data.retention.rates.slice(6), fill(null, RETENTION_SPAN - 6));
    assert.equal(young.data.retention.rates.length, RETENTION_SPAN);
    assert.equal(young.data.series.medianPlaySeconds?.before, null, "nothing to measure before it was published");
    assert.equal(young.data.series.players?.before, 0);
    assert.deepEqual(young.data.insights, []);
  });

  it("follows the fixture account: nobody this week for the quiet one, one young game for the fresh one, none for a new one", () => {
    const quiet = overviewOf("skate", 7, fixtureAccountToken(FixtureAccount.Quiet));
    assert.equal(quiet.data.series.plays?.now, 0);
    assert.equal(quiet.data.series.day1?.now, null, "nobody to divide by");
    assert.equal(quiet.data.series.medianPlaySeconds?.now, null);
    const fresh = overviewOf("lost-cathedral", 7, fixtureAccountToken(FixtureAccount.Fresh));
    assert.equal(fresh.data.series.day7?.now, null);
    const route = reportRoute({ slug: "skate", report: GameReport.Overview, days: 7 });
    for (const account of [FixtureAccount.Fresh, FixtureAccount.New]) {
      const answer = fixture().answer(route, { method: "GET", token: fixtureAccountToken(account) }, catalog);
      assert.deepEqual([answer?.status, answer?.body], [404, { code: ReadKind.NoGame }], account);
    }
  });

  it("answers every analytics route, so none of them ends the fixture's sign-in", () => {
    const made = fixture();
    const routes = [
      ...Object.values(GameReport).map((report) => reportRoute({ slug: "skate", report, days: 30 })),
      eventsStatusRoute("skate", EventOrigin.Published),
      eventsStatusRoute("skate", EventOrigin.Preview),
      linksRoute("skate", 30),
      `${AnalyticsRoute.links("skate")}/unknown/deeper`,
    ];
    for (const route of routes) {
      const answer = made.answer(route, { method: "GET", token: full }, catalog);
      assert.ok(answer && answer.status !== 401, route);
      assert.equal(made.answer(route, { method: "GET" }, catalog)?.status, 401, `${route}, signed out`);
      const ended = fixtureAccountToken(FixtureAccount.Ended);
      assert.equal(made.answer(route, { method: "GET", token: ended }, catalog)?.status, 401, `${route}, ended`);
    }
    assert.equal(made.answer("/api/gallery", { method: "GET", token: full }, catalog), null, "not its route");
    assert.equal(made.answer("/api/projects/fx0001/like", { method: "PUT", token: full }, catalog), null);
  });

  it("refuses a game that is not the account's, a report a game does not have, and a question it cannot read", () => {
    const made = fixture();
    const ask = (route: string) => made.answer(route, { method: "GET", token: full }, catalog);
    const theirs = ask(reportRoute({ slug: "frigate", report: GameReport.Overview, days: 7 }));
    assert.deepEqual([theirs?.status, theirs?.body], [404, { code: ReadKind.NoGame }]);
    const installs = ask(reportRoute({ slug: "lost-cathedral", report: GameReport.Installs, days: 7 }));
    assert.deepEqual([installs?.status, installs?.body], [404, { code: ReadKind.NoReport }]);
    assert.equal(ask(reportRoute({ slug: "skate", report: GameReport.Installs, days: 7 }))?.status, 200);
    assert.equal(ask(`${AnalyticsRoute.report("skate", GameReport.Overview)}?days=14`)?.status, 400);
    const unknown = ask(`${AnalyticsRoute.report("skate", "sales" as GameReport)}?days=7`);
    assert.deepEqual([unknown?.status, unknown?.body], [404, null]);
  });

  it("keeps a saved link and a saved funnel for the launch, and forgets a removed one", () => {
    const made = fixture();
    const send = (method: "GET" | "POST" | "DELETE", route: string, body?: unknown) =>
      made.answer(route, { method, token: full, ...(body === undefined ? {} : { body }) }, catalog);
    const linksOf = (slug: string): unknown[] => {
      const body = send("GET", linksRoute(slug, 30))?.body;
      return isRecord(body) && Array.isArray(body.links) ? body.links : assert.fail("no links");
    };
    const before = linksOf("skate").length;
    const saved = send("POST", AnalyticsRoute.links("skate"), { ...TAGS, source: "TikTok", content: "story link" });
    assert.equal(saved?.status, 200);
    const link = isRecord(saved?.body) ? saved.body : assert.fail();
    assert.equal(link.source, "tiktok");
    assert.equal(link.content, "story_link");
    assert.equal(
      link.url,
      "https://genex.games/skate?utm_source=tiktok&utm_medium=social&utm_campaign=launch_trailer&utm_content=story_link",
    );
    assert.equal(link.createdOn, "2026-11-17");
    assert.deepEqual([link.newVisitors, link.newPlayers, link.day7], [0, 0, null]);
    assert.deepEqual(linksOf("skate")[0], link, "the newest link first");
    assert.equal(linksOf("skate").length, before + 1);
    const hasIt = (slug: string) => linksOf(slug).some((other) => isRecord(other) && other.id === link.id);
    assert.deepEqual([hasIt("skate"), hasIt("lost-cathedral")], [true, false], "a link is its game's");
    assert.equal(send("POST", AnalyticsRoute.links("skate"), { source: "x" })?.status, 400);
    assert.equal(send("DELETE", AnalyticsRoute.link("skate", String(link.id)))?.status, 200);
    assert.equal(linksOf("skate").length, before);
    assert.equal(send("DELETE", AnalyticsRoute.link("skate", String(link.id)))?.status, 404);

    const funnelsOf = (): unknown[] => {
      const body = send("GET", reportRoute({ slug: "skate", report: GameReport.Events, days: 30 }))?.body;
      const data = isRecord(body) && isRecord(body.data) ? body.data : assert.fail("no events report");
      return Array.isArray(data.funnels) ? data.funnels : assert.fail("no funnels");
    };
    const had = funnelsOf().length;
    const answered = send("POST", AnalyticsRoute.funnels("skate"), DRAFT);
    assert.equal(answered?.status, 200);
    const funnel = isRecord(answered?.body) ? answered.body : assert.fail();
    assert.equal(funnel.name, DRAFT.name);
    assert.equal(funnel.withinDays, 7);
    const steps = Array.isArray(funnel.steps) ? funnel.steps : assert.fail();
    assert.deepEqual(
      steps.map((step) => (isRecord(step) ? [step.event, step.property, step.value] : null)),
      DRAFT.steps.map((step) => [step.event, step.property, step.value]),
    );
    const reached = steps.map((step) => (isRecord(step) && typeof step.players === "number" ? step.players : -1));
    assert.ok(
      (reached[0] ?? 0) > 0 && (reached[1] ?? -1) >= 0 && (reached[1] ?? 0) <= (reached[0] ?? 0),
      "fewer each step",
    );
    assert.equal(funnelsOf().length, had + 1);
    assert.deepEqual(funnelsOf()[0], funnel);
    assert.equal(send("POST", AnalyticsRoute.funnels("skate"), { name: "x" })?.status, 400);
    assert.equal(send("DELETE", AnalyticsRoute.funnel("skate", String(funnel.id)))?.status, 200);
    assert.equal(funnelsOf().length, had);
  });

  it("answers a save as the contract says: the link that already has the tags, and 409 past the limit", () => {
    const made = fixture();
    const send = (method: "GET" | "POST", route: string, body?: unknown) =>
      made.answer(route, { method, token: full, ...(body === undefined ? {} : { body }) }, catalog);
    const linkIds = (): string[] => {
      const body = send("GET", linksRoute("skate", 30))?.body;
      const links = isRecord(body) && Array.isArray(body.links) ? body.links : assert.fail("no links");
      return links.map((link) => (isRecord(link) ? String(link.id) : ""));
    };
    const madeUp = linkIds();
    const again = send("POST", AnalyticsRoute.links("skate"), {
      ...TAGS,
      source: "TikTok",
      content: "Bio Link",
    });
    assert.equal(again?.status, 200);
    assert.equal(isRecord(again?.body) ? again.body.id : null, madeUp[0], "the made-up link with those tags");
    assert.deepEqual(linkIds(), madeUp, "no second link with the same tags");
    const idOf = (answer: GalleryAnswer | null): unknown => (isRecord(answer?.body) ? answer.body.id : undefined);
    const first = idOf(send("POST", AnalyticsRoute.links("skate"), { ...TAGS, campaign: "twice" }));
    assert.equal(idOf(send("POST", AnalyticsRoute.links("skate"), { ...TAGS, campaign: "twice" })), first);
    for (let index = linkIds().length; index < CAMPAIGN_LINKS_MAX; index += 1)
      assert.equal(send("POST", AnalyticsRoute.links("skate"), { ...TAGS, campaign: `c${index}` })?.status, 200);
    assert.deepEqual(send("POST", AnalyticsRoute.links("skate"), { ...TAGS, campaign: "one_more" }), {
      status: 409,
      body: { code: "limit" },
    });
    assert.equal(linkIds().length, CAMPAIGN_LINKS_MAX);
    assert.ok(
      madeUp.every((id) => linkIds().includes(id)),
      "the made-up links are all still listed",
    );

    const funnelIds = (): string[] => {
      const body = send("GET", reportRoute({ slug: "skate", report: GameReport.Events, days: 30 }))?.body;
      const data = isRecord(body) && isRecord(body.data) ? body.data : assert.fail("no events report");
      const funnels = Array.isArray(data.funnels) ? data.funnels : assert.fail("no funnels");
      return funnels.map((funnel) => (isRecord(funnel) ? String(funnel.id) : ""));
    };
    const madeFunnels = funnelIds();
    for (let index = madeFunnels.length; index < FUNNELS_MAX; index += 1)
      assert.equal(send("POST", AnalyticsRoute.funnels("skate"), DRAFT)?.status, 200);
    assert.deepEqual(send("POST", AnalyticsRoute.funnels("skate"), DRAFT), { status: 409, body: { code: "limit" } });
    assert.equal(funnelIds().length, FUNNELS_MAX);
    assert.ok(
      madeFunnels.every((id) => funnelIds().includes(id)),
      "the made-up funnels are all still listed",
    );
  });

  it("answers through a fixture launch's requests and the real client, signed in only", async () => {
    const signedIn = gameAnalytics({
      request: fixturePlayRequest,
      token: async () => full,
      now: Date.now,
      localImages: true,
      web: PLAY_ORIGIN.web,
    });
    for (const days of STATS_PERIODS) {
      const read = await signedIn.report({ slug: "skate", report: GameReport.Overview, days });
      assert.equal(read.kind, ReadKind.Ready, `${days} days`);
      if (read.kind !== ReadKind.Ready || read.value.report !== GameReport.Overview) assert.fail();
      assert.equal(read.value.game.title, "SKATE");
      assert.equal(read.value.game.hasAppBuild, true);
      assert.equal(read.value.window.endsOn, new Date().toISOString().slice(0, 10));
      assert.equal(read.value.data.series.plays?.daily.length, days);
    }
    assert.deepEqual(await signedIn.report({ slug: "lost-cathedral", report: GameReport.Installs, days: 7 }), {
      kind: ReadKind.NoReport,
    });
    assert.deepEqual(await signedIn.report({ slug: "frigate", report: GameReport.Overview, days: 7 }), {
      kind: ReadKind.NoGame,
    });
    assert.deepEqual(await signedIn.report({ slug: "no-such-game", report: GameReport.Overview, days: 7 }), {
      kind: ReadKind.NoGame,
    });
    const route = reportRoute({ slug: "skate", report: GameReport.Overview, days: 7 });
    assert.equal((await fixturePlayRequest(route, { method: "GET" })).status, 401);
    assert.equal((await fixturePlayRequest(linksRoute("skate", 7), { method: "GET", token: full })).status, 200);
  });
});

describe("a game's analytics over IPC", () => {
  type Listener = (event: IpcSender, payload: unknown) => Promise<IpcResult>;
  const studio: IpcSender = { sender: "studio", senderFrame: "main-frame" };
  const gamePage: IpcSender = { sender: "game", senderFrame: "game-frame" };

  /** The seven channels over a client that records what reached it. */
  function ipcRig(fixture = false) {
    const listeners = new Map<string, Listener>();
    const handle = createIpcHandle(
      { handle: (channel, listener) => void listeners.set(channel, listener) },
      { fixture, isStudioUi: (event) => event.sender === "studio" },
    );
    const reached: Array<[string, ...unknown[]]> = [];
    const record =
      <Value>(name: string, value: Value) =>
      async (...args: unknown[]): Promise<Value> => {
        reached.push([name, ...args]);
        return value;
      };
    const link = {
      ...TAGS,
      id: "link_1",
      url: "https://genex.games/neon-rush",
      shortUrl: null,
      createdOn: ENDS_ON,
      newVisitors: 0,
      newPlayers: 0,
      day7: null,
    };
    const funnel = { id: "funnel_1", name: DRAFT.name, withinDays: 7, steps: [], typicalDay: null };
    registerGameAnalyticsIpc(handle, {
      report: record("report", { kind: ReadKind.Unavailable }),
      events: record("events", { kind: ReadKind.Unavailable }),
      links: record("links", { kind: ReadKind.Ready, value: [link] }),
      saveLink: record("saveLink", link),
      removeLink: record("removeLink", undefined),
      saveFunnel: record("saveFunnel", funnel),
      removeFunnel: record("removeFunnel", undefined),
    });
    const invoke = (channel: string, payload?: unknown, from: IpcSender = studio) => {
      const listener = listeners.get(channel) ?? assert.fail(`${channel} is not registered`);
      return listener(from, payload);
    };
    return { invoke, reached, link, funnel };
  }

  it("hands a well-formed question to the client, checked and nothing more", async () => {
    const { invoke, reached, link, funnel } = ipcRig();
    const asked = {
      slug: SLUG,
      report: GameReport.Events,
      days: 30,
      event: "level_complete",
      splitBy: "level",
      path: "/api/users/me",
    };
    assert.deepEqual(await invoke("studio:play.game-report", asked), {
      ok: true,
      value: { kind: ReadKind.Unavailable },
    });
    assert.deepEqual(await invoke("studio:play.game-events", { slug: SLUG, origin: EventOrigin.Preview }), {
      ok: true,
      value: { kind: ReadKind.Unavailable },
    });
    assert.deepEqual(await invoke("studio:play.campaign-links", { slug: SLUG, days: 90 }), {
      ok: true,
      value: { kind: ReadKind.Ready, value: [link] },
    });
    assert.deepEqual(
      await invoke("studio:play.campaign-link-save", { slug: SLUG, tags: { ...TAGS, source: " TikTok " } }),
      {
        ok: true,
        value: link,
      },
    );
    assert.deepEqual(await invoke("studio:play.campaign-link-remove", { slug: SLUG, id: "link_1" }), {
      ok: true,
      value: undefined,
    });
    assert.deepEqual(await invoke("studio:play.funnel-save", { slug: SLUG, draft: DRAFT }), {
      ok: true,
      value: funnel,
    });
    assert.deepEqual(await invoke("studio:play.funnel-remove", { slug: SLUG, id: "funnel_1" }), {
      ok: true,
      value: undefined,
    });
    assert.deepEqual(reached, [
      ["report", { slug: SLUG, report: GameReport.Events, days: 30, event: "level_complete", splitBy: "level" }],
      ["events", SLUG, EventOrigin.Preview],
      ["links", SLUG, 90],
      ["saveLink", SLUG, TAGS],
      ["removeLink", SLUG, "link_1"],
      ["saveFunnel", SLUG, DRAFT],
      ["removeFunnel", SLUG, "funnel_1"],
    ]);
  });

  it("refuses a malformed payload by name before the client hears of it", async () => {
    const { invoke, reached } = ipcRig();
    const refusals: Array<[string, unknown, RegExp]> = [
      ["studio:play.game-report", undefined, /question/],
      ["studio:play.game-report", { slug: "Bad Slug", report: GameReport.Overview, days: 7 }, /game address/],
      ["studio:play.game-report", { slug: SLUG, report: "sales", days: 7 }, /report/],
      ["studio:play.game-report", { slug: SLUG, report: GameReport.Overview, days: 14 }, /period/],
      [
        "studio:play.game-report",
        { slug: SLUG, report: GameReport.Acquisition, days: 7, breakdown: "planet" },
        /breakdown/,
      ],
      ["studio:play.game-report", { slug: SLUG, report: GameReport.Retention, days: 7, mode: 3 }, /mode/],
      ["studio:play.game-report", { slug: SLUG, report: GameReport.Events, days: 7, event: "Level Complete" }, /event/],
      [
        "studio:play.game-report",
        { slug: SLUG, report: GameReport.Events, days: 7, splitBy: "x".repeat(400) },
        /property/,
      ],
      ["studio:play.game-events", undefined, /game address/],
      ["studio:play.game-events", { slug: SLUG, origin: "live" }, /events come from/],
      ["studio:play.campaign-links", { slug: "../x", days: 7 }, /game address/],
      ["studio:play.campaign-links", { slug: SLUG, days: "7" }, /period/],
      ["studio:play.campaign-link-save", { slug: SLUG }, /tags/],
      ["studio:play.campaign-link-save", { slug: SLUG, tags: { ...TAGS, campaign: "x".repeat(81) } }, /tags/],
      ["studio:play.campaign-link-save", { slug: SLUG, tags: { ...TAGS, source: "a\u0000b" } }, /tags/],
      ["studio:play.campaign-link-remove", { slug: SLUG, id: "../1" }, /saved/],
      ["studio:play.funnel-save", { slug: SLUG, draft: { ...DRAFT, withinDays: 400 } }, /funnel/],
      ["studio:play.funnel-save", { slug: SLUG, draft: { ...DRAFT, steps: "level_start" } }, /funnel/],
      ["studio:play.funnel-remove", { slug: SLUG, id: 7 }, /saved/],
      ["studio:play.funnel-remove", { slug: 7, id: "funnel_1" }, /game address/],
    ];
    for (const [channel, payload, why] of refusals) {
      const answer = await invoke(channel, payload);
      assert.equal(answer.ok, false, `${channel} ${JSON.stringify(payload)}`);
      if (!answer.ok) assert.match(answer.error, why, `${channel} ${JSON.stringify(payload)}`);
    }
    assert.deepEqual(reached, []);
  });

  it("takes a save or a removal only from Studio's own page; a read from any page it gave the bridge", async () => {
    const { invoke, reached } = ipcRig();
    const writes: Array<[string, unknown]> = [
      ["studio:play.campaign-link-save", { slug: SLUG, tags: TAGS }],
      ["studio:play.campaign-link-remove", { slug: SLUG, id: "link_1" }],
      ["studio:play.funnel-save", { slug: SLUG, draft: DRAFT }],
      ["studio:play.funnel-remove", { slug: SLUG, id: "funnel_1" }],
    ];
    for (const [channel, payload] of writes) {
      const answer = await invoke(channel, payload, gamePage);
      assert.equal(answer.ok, false, channel);
      if (!answer.ok) assert.match(answer.error, /restricted to Studio UI/, channel);
    }
    assert.deepEqual(reached, []);
    assert.equal((await invoke("studio:play.campaign-links", { slug: SLUG, days: 7 }, gamePage)).ok, true);
  });

  it("answers in a fixture profile too: its launch makes the numbers and keeps the saves", async () => {
    const { invoke, reached } = ipcRig(true);
    assert.equal((await invoke("studio:play.game-report", QUERY)).ok, true);
    assert.equal((await invoke("studio:play.game-events", { slug: SLUG, origin: EventOrigin.Published })).ok, true);
    assert.equal((await invoke("studio:play.campaign-links", { slug: SLUG, days: 7 })).ok, true);
    assert.equal((await invoke("studio:play.campaign-link-save", { slug: SLUG, tags: TAGS })).ok, true);
    assert.equal((await invoke("studio:play.campaign-link-remove", { slug: SLUG, id: "link_1" })).ok, true);
    assert.equal((await invoke("studio:play.funnel-save", { slug: SLUG, draft: DRAFT })).ok, true);
    assert.equal((await invoke("studio:play.funnel-remove", { slug: SLUG, id: "funnel_1" })).ok, true);
    assert.equal(reached.length, 7);
  });
});
