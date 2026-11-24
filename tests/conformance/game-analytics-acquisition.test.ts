/**
 * The Acquisition report of a game's analytics, end to end: what main reads of genex.games' answer
 * (a hostile body is refused or loses only the rows that cannot be trusted, and "not known yet"
 * stays null), what a fixture launch answers for every period, option and kind of game, and what
 * the report derives and draws from an answer.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { build } from "esbuild";
import type { ReactElement } from "react";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { fixtureAcquisition } from "../../src/main/dev/fixture-game-analytics/fixture-acquisition.ts";
import { createFixtureGameAnalytics } from "../../src/main/dev/fixture-game-analytics/index.ts";
import {
  type GameSample,
  gameSample,
  ownSamples,
  SampleKind,
  type SampleSource,
} from "../../src/main/dev/fixture-game-analytics/sample.ts";
import { FixtureAccount, fixtureAccountToken } from "../../src/main/dev/fixture-people.ts";
import { isRecord } from "../../src/main/play/gallery.ts";
import { toAcquisitionReport } from "../../src/main/play/game-analytics/report-acquisition.ts";
import { toReportAnswer } from "../../src/main/play/game-analytics/reports.ts";
import { reportRoute } from "../../src/main/play/game-analytics/routes.ts";
import type { CampaignsProps, SourcesProps } from "../../src/renderer/play/game-analytics/acquisition-sections.tsx";
import type * as AcquisitionView from "../../src/renderer/play/game-analytics/acquisition-view.ts";
import { formatNumber, periodLabels } from "../../src/renderer/play/game-analytics/kit/format.ts";
import type { ReportAnswer, ReportProps } from "../../src/renderer/play/game-analytics/report-props.ts";
import { AnalyticsTab } from "../../src/renderer/play/game-analytics/tabs.ts";
import { SeriesSlot } from "../../src/renderer/play/stats-chart.ts";
import {
  type AcquisitionReport,
  type AnalyticsWindow,
  AnnotationKind,
  Attribution,
  CampaignField,
  type CampaignRow,
  DeviceClass,
  FunnelStep,
  GameReport,
  type GameReportOptions,
  GenexSurface,
  SourceBreakdown,
  SourceChannel,
  type SourceNumbers,
  type SourceRow,
} from "../../src/shared/game-analytics.ts";
import { setLocale } from "../../src/shared/i18n.ts";
import { Locale } from "../../src/shared/locale.ts";
import { STATS_PERIODS, type StatsPeriod } from "../../src/shared/play-stats.ts";

const DAYS = 7;
const ENDS_ON = "2026-11-17";
const WINDOW: AnalyticsWindow = { days: DAYS, endsOn: ENDS_ON, computedAt: "2026-11-17T12:00:00.000Z" };
const fill = <T>(value: T, length = DAYS): T[] => Array.from({ length }, () => value);

/** An Acquisition report as genex.games answers it for a week, every part of it well formed. */
const acquisitionData = (): AcquisitionReport => ({
  newPlayers: { now: 84, before: 60 },
  newVisitors: { now: 200, before: 150 },
  shown: { now: 4000, before: 3600 },
  shownVisitors: { now: 80, before: 54 },
  daily: [
    { channel: "genex", newPlayers: fill(8) },
    { channel: "campaigns", newPlayers: [0, 0, 0, 9, 6, 4, 2] },
    { channel: "direct", newPlayers: fill(1) },
  ],
  funnel: [
    { step: "visited", people: 200 },
    { step: "pressed_play", people: 96 },
    { step: "loaded", people: 84 },
    { step: "engaged", people: 60 },
    { step: "returned", people: 22 },
  ],
  breakdown: "channel",
  attribution: "first",
  sources: [
    {
      key: "genex",
      shown: 4000,
      newVisitors: 120,
      newPlayers: 56,
      day1: 0.38,
      day7: null,
      nexPerPlayer: 4.6,
      parts: [
        {
          key: "feed",
          shown: 4000,
          newVisitors: 80,
          newPlayers: 40,
          day1: 0.36,
          day7: null,
          nexPerPlayer: 4,
          parts: [],
        },
        {
          key: "friends",
          shown: null,
          newVisitors: 40,
          newPlayers: 16,
          day1: 0.43,
          day7: null,
          nexPerPlayer: 6.1,
          parts: [],
        },
      ],
    },
    {
      key: "campaigns",
      shown: null,
      newVisitors: 60,
      newPlayers: 21,
      day1: 0.3,
      day7: null,
      nexPerPlayer: 2.4,
      parts: [
        {
          key: "tiktok.com",
          shown: null,
          newVisitors: 60,
          newPlayers: 21,
          day1: 0.3,
          day7: null,
          nexPerPlayer: 2.4,
          parts: [],
        },
      ],
    },
    {
      key: "direct",
      shown: null,
      newVisitors: 20,
      newPlayers: 7,
      day1: null,
      day7: null,
      nexPerPlayer: null,
      parts: [],
    },
  ],
  campaignBy: "campaign",
  campaigns: [
    {
      name: "launch_trailer",
      source: "tiktok",
      medium: "social",
      newVisitors: 50,
      newPlayers: 18,
      day1: 0.26,
      day7: null,
      nexPerPlayer: 1.6,
    },
    {
      name: "devlog_12",
      source: null,
      medium: null,
      newVisitors: 10,
      newPlayers: 3,
      day1: null,
      day7: null,
      nexPerPlayer: null,
    },
  ],
});

/** `target` with the value at `path` replaced (undefined reads as a missing part). */
function withAt(target: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  if (Array.isArray(target)) return target.map((item, index) => (index === head ? withAt(item, rest, value) : item));
  return isRecord(target) ? { ...target, [head]: withAt(target[String(head)], rest, value) } : target;
}

/** A row of the sources table as the wire sends one, `over` changing what the case needs. */
const sourceRow = (key: unknown, over: Record<string, unknown> = {}) => ({
  key,
  shown: null,
  newVisitors: 10,
  newPlayers: 4,
  day1: 0.3,
  day7: 0.1,
  nexPerPlayer: 2,
  parts: [],
  ...over,
});

/** A row of the campaigns table as the wire sends one. */
const campaignRow = (name: unknown, over: Record<string, unknown> = {}) => ({
  name,
  source: "tiktok",
  medium: "social",
  newVisitors: 10,
  newPlayers: 4,
  day1: 0.3,
  day7: 0.1,
  nexPerPlayer: 2,
  ...over,
});

describe("the Acquisition report as main reads it", () => {
  const read = (data: unknown) => toAcquisitionReport(data, WINDOW);
  const keys = (report: AcquisitionReport | null): string[] => (report ?? assert.fail()).sources.map((row) => row.key);

  it("reads every part of a well-formed answer as it was sent", () => {
    assert.deepEqual(read(acquisitionData()), acquisitionData());
  });

  it("is not a report when a fixed part is missing or a number is not what it should be", () => {
    const broken: Array<[string, readonly (string | number)[], unknown]> = [
      ["no new players", ["newPlayers"], undefined],
      ["new players that are a number", ["newPlayers"], 84],
      ["new players that are null", ["newPlayers"], null],
      ["a count as text", ["newPlayers", "now"], "84"],
      ["a negative count", ["newPlayers", "now"], -1],
      ["a fractional count", ["newPlayers", "before"], 59.5],
      ["a count that is not finite", ["newVisitors", "now"], Number.POSITIVE_INFINITY],
      ["a missing total before", ["newVisitors", "before"], undefined],
      ["no new visitors", ["newVisitors"], undefined],
      ["shown left out", ["shown"], undefined],
      ["shown as a list", ["shown"], [4000, 3600]],
      ["a negative shown", ["shown", "now"], -4000],
      ["shown visitors left out", ["shownVisitors"], undefined],
      ["fractional shown visitors", ["shownVisitors", "before"], 0.5],
      ["no daily", ["daily"], undefined],
      ["daily that is not a list", ["daily"], { genex: fill(8) }],
      ["a channel's days one short", ["daily", 0, "newPlayers"], fill(8, DAYS - 1)],
      ["a channel's days one long", ["daily", 1, "newPlayers"], fill(3, DAYS + 1)],
      ["a channel's days of another period", ["daily", 2, "newPlayers"], fill(1, 30)],
      ["a channel's days that are not a list", ["daily", 0, "newPlayers"], "8,8,8,8,8,8,8"],
      ["a negative day", ["daily", 0, "newPlayers", 3], -8],
      ["a fractional day", ["daily", 1, "newPlayers", 0], 0.5],
      ["a day that is null", ["daily", 2, "newPlayers", 6], null],
      ["no funnel", ["funnel"], undefined],
      ["a funnel that is not a list", ["funnel"], "visited"],
      ["no breakdown", ["breakdown"], undefined],
      ["a breakdown the app does not know", ["breakdown"], "planet"],
      ["no attribution", ["attribution"], undefined],
      ["an attribution the app does not know", ["attribution"], "middle"],
      ["no campaign tag", ["campaignBy"], undefined],
      ["a campaign tag the app does not know", ["campaignBy"], "utm_campaign"],
      ["no sources", ["sources"], undefined],
      ["sources that are not a list", ["sources"], {}],
      ["no campaigns", ["campaigns"], null],
      ["campaigns that are not a list", ["campaigns"], "launch_trailer"],
    ];
    for (const [name, path, value] of broken) assert.equal(read(withAt(acquisitionData(), path, value)), null, name);
    for (const body of [null, undefined, [], "acquisition", 7]) assert.equal(read(body), null);
  });

  it("keeps what cannot be known yet as null, never as zero", () => {
    const report = read(acquisitionData()) ?? assert.fail();
    assert.equal(report.sources[0]?.day7, null);
    assert.equal(report.sources[0]?.parts[1]?.shown, null, "nothing is shown to a friend");
    assert.deepEqual(
      [report.sources[2]?.day1, report.sources[2]?.day7, report.sources[2]?.nexPerPlayer, report.sources[2]?.shown],
      [null, null, null, null],
    );
    assert.deepEqual([report.campaigns[1]?.source, report.campaigns[1]?.medium], [null, null]);
    assert.deepEqual([report.campaigns[1]?.day1, report.campaigns[1]?.nexPerPlayer], [null, null]);
    const uncounted = read({ ...acquisitionData(), shown: null, shownVisitors: null }) ?? assert.fail();
    assert.equal(uncounted.shown, null, "times shown that genex.games does not count");
    assert.equal(uncounted.shownVisitors, null);
  });

  it("drops the source rows it cannot trust and keeps the rest", () => {
    const sources = [
      sourceRow("genex", {
        parts: [
          sourceRow("feed"),
          sourceRow("billboard"),
          sourceRow("feed", { newPlayers: 1 }),
          sourceRow("search", { newPlayers: -1 }),
          sourceRow("profile", { parts: [sourceRow("deeper")] }),
          "featured",
        ],
      }),
      sourceRow("telepathy"),
      sourceRow("genex", { newPlayers: 1 }),
      sourceRow("social", { newPlayers: -2 }),
      sourceRow("social", { newVisitors: 1.5 }),
      sourceRow("social", { day1: 34.5 }),
      sourceRow("social", { day7: -0.1 }),
      sourceRow("social", { day1: "30%" }),
      sourceRow("social", { nexPerPlayer: -3 }),
      sourceRow("social", { shown: -5 }),
      sourceRow("social", { shown: "many" }),
      sourceRow("social", { parts: null }),
      sourceRow("social", { parts: { 0: sourceRow("x.com") } }),
      sourceRow("social", { day1: undefined }),
      sourceRow(7),
      null,
      "direct",
      sourceRow("search", {
        nexPerPlayer: 0.5,
        parts: [sourceRow(" evil‮.example\u0007 "), sourceRow(""), sourceRow("h".repeat(300)), sourceRow(12)],
      }),
    ];
    const report = read({ ...acquisitionData(), sources }) ?? assert.fail();
    assert.deepEqual(keys(report), ["genex", "search"]);
    assert.deepEqual(
      report.sources[0]?.parts.map((part) => [part.key, part.newPlayers, part.parts]),
      [
        ["feed", 4, []],
        ["profile", 4, []],
      ],
      "Genex's parts are its surfaces, one level deep",
    );
    assert.equal(report.sources[1]?.nexPerPlayer, 0.5);
    assert.deepEqual(
      report.sources[1]?.parts.map((part) => part.key),
      ["evil.example"],
      "a site's name loses the characters that turn it around",
    );
  });

  it("reads a row's key as its breakdown names it", () => {
    const of = (breakdown: string, rows: unknown[]) => keys(read({ ...acquisitionData(), breakdown, sources: rows }));
    assert.deepEqual(
      of("referrer", [
        sourceRow(" news‮.example\u0000 "),
        sourceRow("direct"),
        sourceRow("news.example"),
        sourceRow("⁦⁩"),
        sourceRow("h".repeat(254)),
        sourceRow({ host: "x.com" }),
        sourceRow("genex", { parts: [sourceRow("billboard")] }),
      ]),
      ["news.example", "direct", "genex"],
    );
    const referrers = read({
      ...acquisitionData(),
      breakdown: "referrer",
      sources: [sourceRow("genex", { parts: [sourceRow("billboard")] })],
    });
    assert.deepEqual(
      referrers?.sources[0]?.parts.map((part) => part.key),
      ["billboard"],
      "only a channel named Genex holds surfaces",
    );
    assert.deepEqual(
      of("country", [
        sourceRow("US"),
        sourceRow("de"),
        sourceRow("DE"),
        sourceRow("USA"),
        sourceRow("U"),
        sourceRow("1A"),
        sourceRow("U‮S"),
        sourceRow(""),
        sourceRow(44),
      ]),
      ["US", "DE"],
    );
    assert.deepEqual(
      of("device", [sourceRow("phone"), sourceRow("fridge"), sourceRow("computer"), sourceRow("phone")]),
      ["phone", "computer"],
    );
    assert.deepEqual(of("channel", [sourceRow("phone"), sourceRow("US"), sourceRow("x.com")]), []);
  });

  it("drops the campaign rows it cannot trust and keeps the rest", () => {
    const campaigns = [
      campaignRow(" launch‮_trailer\u0007 ", { source: " tik⁦tok ", medium: null }),
      campaignRow("launch_trailer", { newPlayers: 1 }),
      campaignRow("c".repeat(500)),
      campaignRow(""),
      campaignRow(12),
      campaignRow("no_source", { source: 14 }),
      campaignRow("empty_medium", { medium: "" }),
      campaignRow("long_source", { source: "s".repeat(500) }),
      campaignRow("negative", { newVisitors: -1 }),
      campaignRow("fraction", { newPlayers: 0.5 }),
      campaignRow("high", { day1: 1.01 }),
      campaignRow("low", { day7: -0.01 }),
      campaignRow("text", { nexPerPlayer: "2" }),
      campaignRow("missing", { day7: undefined }),
      "devlog_12",
      null,
      campaignRow("devlog_12", { source: null, medium: null, day1: null, day7: null, nexPerPlayer: null }),
    ];
    const report = read({ ...acquisitionData(), campaigns }) ?? assert.fail();
    assert.deepEqual(
      report.campaigns.map((row) => [row.name, row.source, row.medium, row.newPlayers, row.day7]),
      [
        ["launch_trailer", "tiktok", null, 4, 0.1],
        ["devlog_12", null, null, 4, null],
      ],
    );
  });

  it("drops a channel or a step the app does not know, and a second copy of one", () => {
    const data = {
      ...acquisitionData(),
      daily: [
        { channel: "genex", newPlayers: fill(8) },
        { channel: "telepathy", newPlayers: fill(9) },
        { channel: "genex", newPlayers: fill(1) },
        { channel: "social", newPlayers: fill(2) },
        "direct",
        null,
      ],
      funnel: [
        { step: "visited", people: 200 },
        { step: "teleported", people: 150 },
        { step: "loaded", people: 84 },
        { step: "loaded", people: 1 },
        { step: "engaged", people: "60" },
        { step: "returned", people: -2 },
      ],
    };
    const report = read(data) ?? assert.fail();
    assert.deepEqual(report.daily, [
      { channel: "genex", newPlayers: fill(8) },
      { channel: "social", newPlayers: fill(2) },
    ]);
    assert.deepEqual(report.funnel, [
      { step: "visited", people: 200 },
      { step: "loaded", people: 84 },
    ]);
    const unknownOnly = read({ ...acquisitionData(), daily: [{ channel: "telepathy", newPlayers: "soon" }] });
    assert.deepEqual(unknownOnly?.daily, [], "a channel the app does not draw cannot break the report");
  });

  it("keeps no more rows than a page can show", () => {
    const data = {
      ...acquisitionData(),
      breakdown: "referrer",
      sources: [
        sourceRow("many.example", {
          parts: Array.from({ length: 5000 }, (_, index) => sourceRow(`p${index}.example`)),
        }),
        ...Array.from({ length: 5000 }, (_, index) => sourceRow(`site${index}.example`)),
      ],
      campaigns: Array.from({ length: 5000 }, (_, index) => campaignRow(`campaign_${index}`)),
      daily: Array.from({ length: 5000 }, () => ({ channel: "genex", newPlayers: fill(1) })),
      funnel: Array.from({ length: 5000 }, () => ({ step: "visited", people: 1 })),
    };
    const report = read(data) ?? assert.fail();
    assert.ok(report.sources.length <= 100, `${report.sources.length} sources`);
    assert.equal(report.sources[1]?.key, "site0.example", "the first ones sent");
    assert.ok((report.sources[0]?.parts.length ?? 0) <= 50, `${report.sources[0]?.parts.length} parts`);
    assert.ok(report.campaigns.length <= 100, `${report.campaigns.length} campaigns`);
    assert.equal(report.daily.length, 1);
    assert.equal(report.funnel.length, 1);
  });
});

describe("the fixture account's Acquisition report", () => {
  const NOW = Date.parse("2026-11-17T12:04:00.000Z");
  const author = { id: "fx-simeon-m", name: "Simeon M" };
  const RICH = "skate";
  const STEADY = "lost-cathedral";
  const YOUNG = "stick-steel";
  const items = [
    { slug: STEADY, title: "Lost Cathedral", thumbnailUrl: null, playsCount: 2682, online: null, author },
    { slug: YOUNG, title: "Stick & Steel", thumbnailUrl: null, playsCount: 2431, online: 6, author },
    {
      slug: RICH,
      title: "SKATE",
      thumbnailUrl: null,
      playsCount: 5285,
      online: 8,
      author,
      builds: [{ platform: "macos" }],
    },
  ];
  const catalog = { games: (authorId: string) => (authorId === author.id ? items : []) };
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  const sampleOf = (slug: string, days: StatsPeriod, account: FixtureAccount = FixtureAccount.Full): GameSample => {
    const source = ownSamples(account, catalog).find((game) => game.slug === slug) ?? assert.fail(`no ${slug}`);
    return gameSample(source, days, NOW);
  };
  /** The fixture's Acquisition for a game as it was sent and as the real parser reads it. */
  const acquisitionOf = (
    slug: string,
    days: StatsPeriod,
    options: GameReportOptions = {},
    account: FixtureAccount = FixtureAccount.Full,
  ) => {
    const query = { slug, report: GameReport.Acquisition, days, ...options };
    const fixture = createFixtureGameAnalytics({ now: () => NOW });
    const answer = fixture.answer(reportRoute(query), { method: "GET", token: fixtureAccountToken(account) }, catalog);
    const name = `${slug} over ${days} days with ${JSON.stringify(options)}`;
    assert.equal(answer?.status, 200, name);
    const read = toReportAnswer(answer?.body, query, true) ?? assert.fail(`${name} does not read`);
    const sent: unknown = isRecord(answer?.body) ? answer.body.data : undefined;
    return read.report === GameReport.Acquisition ? { data: read.data, sent, name } : assert.fail(name);
  };
  /** The new players' average of a number over the rows that know it. */
  const mean = (rows: readonly SourceNumbers[], pick: (row: SourceNumbers) => number | null): number | null => {
    const known = rows.filter((row) => pick(row) !== null && row.newPlayers > 0);
    const people = sum(known.map((row) => row.newPlayers));
    return people > 0 ? sum(known.map((row) => row.newPlayers * (pick(row) ?? 0))) / people : null;
  };
  const close = (actual: number | null, expected: number | null, within: number, name: string): void => {
    if (expected === null) assert.equal(actual, null, name);
    else assert.ok(actual !== null && Math.abs(actual - expected) <= within, `${name}: ${actual} against ${expected}`);
  };
  const numbers = (row: SourceNumbers) => [row.newVisitors, row.newPlayers, row.day1, row.day7, row.nexPerPlayer];
  const everyOption = <Value>(
    run: (options: Required<Pick<GameReportOptions, "breakdown" | "attribution">>) => Value,
  ) =>
    Object.values(SourceBreakdown).flatMap((breakdown) =>
      Object.values(Attribution).map((attribution) => run({ breakdown, attribution })),
    );

  it("answers a report the real parser reads, for every game, period and option, exactly as it was made", () => {
    for (const { slug } of items) {
      for (const days of STATS_PERIODS) {
        everyOption((options) => {
          const { data, sent, name } = acquisitionOf(slug, days, options);
          assert.deepEqual(data, JSON.parse(JSON.stringify(sent)), `${name} loses nothing`);
          assert.deepEqual([data.breakdown, data.attribution], [options.breakdown, options.attribution], name);
          assert.equal(
            data.daily.every((channel) => channel.newPlayers.length === days),
            true,
            name,
          );
        });
        for (const campaignBy of Object.values(CampaignField)) {
          const { data, sent, name } = acquisitionOf(slug, days, { campaignBy });
          assert.deepEqual(data, JSON.parse(JSON.stringify(sent)), `${name} loses nothing`);
          assert.equal(data.campaignBy, campaignBy, name);
        }
      }
    }
    const plain = acquisitionOf(RICH, 30).data;
    assert.deepEqual(
      [plain.breakdown, plain.attribution, plain.campaignBy],
      [SourceBreakdown.Channel, Attribution.First, CampaignField.Campaign],
      "asked with no option, it answers genex.games' defaults",
    );
  });

  it("splits the game's own new visitors and new players, whatever they are split by and credited to", () => {
    for (const { slug } of items) {
      for (const days of STATS_PERIODS) {
        const sample = sampleOf(slug, days);
        everyOption((options) => {
          const { data, name } = acquisitionOf(slug, days, options);
          const rows = data.sources;
          assert.equal(sum(rows.map((row) => row.newPlayers)), sample.newPlayers.now, `${name}: new players`);
          assert.equal(sum(rows.map((row) => row.newVisitors)), sample.newVisitors.now, `${name}: new visitors`);
          assert.deepEqual(
            rows.map((row) => row.newPlayers),
            rows.map((row) => row.newPlayers).sort((a, b) => b - a),
            `${name}: most new players first`,
          );
          for (const row of [...rows, ...rows.flatMap((one) => one.parts)]) {
            assert.ok(row.newVisitors > 0, `${name}: ${row.key} brought somebody`);
            assert.ok(row.newPlayers <= row.newVisitors, `${name}: ${row.key} has no more players than visitors`);
            assert.equal(
              row.day1 === null,
              row.newPlayers === 0 || sample.day1.now === null,
              `${name}: ${row.key} Day 1`,
            );
            assert.equal(
              row.day7 === null,
              row.newPlayers === 0 || sample.day7.now === null,
              `${name}: ${row.key} Day 7`,
            );
            assert.equal(row.nexPerPlayer === null, row.newPlayers === 0, `${name}: ${row.key} Nex`);
          }
          for (const row of rows.filter((one) => one.parts.length > 0)) {
            assert.equal(sum(row.parts.map((part) => part.newPlayers)), row.newPlayers, `${name}: inside ${row.key}`);
            assert.equal(sum(row.parts.map((part) => part.newVisitors)), row.newVisitors, `${name}: inside ${row.key}`);
          }
          close(
            mean(rows, (row) => row.day1),
            sample.day1.now,
            0.002,
            `${name}: Day 1 averages to the game's`,
          );
          close(
            mean(rows, (row) => row.day7),
            sample.day7.now,
            0.002,
            `${name}: Day 7 averages to the game's`,
          );
        });
      }
    }
  });

  it("repeats what the game's sample holds: totals, days, funnel, channels and the campaign", () => {
    for (const { slug } of items) {
      for (const days of STATS_PERIODS) {
        const sample = sampleOf(slug, days);
        const { data, name } = acquisitionOf(slug, days);
        assert.deepEqual(data.newPlayers, { now: sample.newPlayers.now, before: sample.newPlayers.before }, name);
        assert.deepEqual(data.newVisitors, { now: sample.newVisitors.now, before: sample.newVisitors.before }, name);
        assert.deepEqual(data.funnel, sample.funnel, name);
        const brought = sample.channels.filter((channel) => channel.newPlayers > 0);
        assert.deepEqual(
          data.daily,
          brought.map(({ channel, daily }) => ({ channel, newPlayers: daily })),
          `${name}: a channel's days`,
        );
        assert.deepEqual(
          data.sources.map((row) => [row.key, row.newVisitors, row.newPlayers]),
          sample.channels
            .filter((channel) => channel.newVisitors > 0)
            .map((channel) => [channel.channel, channel.newVisitors, channel.newPlayers]),
          `${name}: by first channel, the sample's channels`,
        );
        const paid = sample.channels.find((channel) => channel.channel === SourceChannel.Campaigns);
        assert.equal(sum(data.campaigns.map((row) => row.newPlayers)), paid?.newPlayers ?? 0, `${name}: campaigns`);
        assert.equal(sum(data.campaigns.map((row) => row.newVisitors)), paid?.newVisitors ?? 0, `${name}: campaigns`);
        if (!sample.campaign) continue;
        const { name: campaign, source, medium, newVisitors, newPlayers, day1, day7 } = sample.campaign;
        const first = data.campaigns[0] ?? assert.fail(name);
        assert.deepEqual(
          [first.name, first.source, first.medium, first.newVisitors, first.newPlayers, first.day1, first.day7],
          [campaign, source, medium, newVisitors, newPlayers, day1, day7],
          `${name}: the campaign the Overview tells of`,
        );
      }
    }
  });

  it("gives its richest game the numbers the page was designed with, over 30 days", () => {
    const { data } = acquisitionOf(RICH, 30);
    assert.deepEqual(data.newPlayers.now, 7840);
    assert.deepEqual(data.newVisitors.now, 19_380);
    assert.deepEqual(
      data.campaigns.map((row) => [row.name, row.source, row.medium, ...numbers(row)]),
      [
        ["launch_trailer", "tiktok", "social", 3420, 1460, 0.26, 0.082, 1.6],
        ["devlog_12", "youtube", "video", 1180, 520, 0.352, 0.149, 3.4],
        ["halloween_update", "discord", "community", 640, 310, 0.41, 0.197, 4.9],
        ["newsletter_oct", "email", "newsletter", 410, 130, 0.308, 0.123, 2.8],
        ["reddit_webgames", "reddit", "social", 360, 60, 0.217, 0.067, 0.9],
      ],
    );
    const genex = data.sources[0] ?? assert.fail();
    assert.deepEqual([genex.key, genex.shown, genex.newVisitors, genex.newPlayers], ["genex", 157_900, 8620, 3790]);
    assert.deepEqual(
      genex.parts.map((part) => [part.key, part.shown, part.newVisitors, part.newPlayers]),
      [
        [GenexSurface.Feed, 96_400, 3660, 1540],
        [GenexSurface.Featured, 41_200, 2470, 1180],
        [GenexSurface.Search, 9800, 1060, 520],
        [GenexSurface.Profile, 6300, 610, 250],
        [GenexSurface.Friends, null, 480, 210],
        [GenexSurface.Remixes, 4200, 340, 90],
      ],
    );
    assert.deepEqual(
      data.sources.map((row) => [row.key, row.day1, row.day7, row.nexPerPlayer?.toFixed(1)]),
      [
        [SourceChannel.Genex, 0.384, 0.173, "4.6"],
        [SourceChannel.Campaigns, 0.3, 0.112, "2.4"],
        [SourceChannel.Social, 0.31, 0.121, "3.0"],
        [SourceChannel.Direct, 0.369, 0.16, "6.5"],
        [SourceChannel.Search, 0.271, 0.094, "2.1"],
        [SourceChannel.Other, 0.244, 0.089, "1.9"],
      ],
    );
    assert.deepEqual(data.shown?.now, 157_900, "every time Genex showed the game");
    assert.deepEqual(data.shownVisitors?.now, 8140, "friends bring visitors Genex showed nothing to");
    const clicked = (side: "now" | "before") => (data.shownVisitors?.[side] ?? 0) / (data.shown?.[side] ?? 1);
    assert.equal((clicked("now") * 100).toFixed(1), "5.2");
    assert.equal(((clicked("now") - clicked("before")) * 100).toFixed(1), "0.4");
    assert.ok((data.shownVisitors?.before ?? 0) <= data.newVisitors.before, "visitors Genex brought are visitors");
    const direct = data.sources.find((row) => row.key === SourceChannel.Direct);
    assert.deepEqual(direct?.parts, [], "nothing is inside Direct");
    const campaigns = data.sources.find((row) => row.key === SourceChannel.Campaigns);
    assert.deepEqual(
      campaigns?.parts.map((part) => [part.key, ...numbers(part)]),
      [
        ["tiktok.com", 3420, 1460, 0.26, 0.082, 1.6],
        ["youtube.com", 1180, 520, 0.352, 0.149, 3.4],
        ["discord.com", 640, 310, 0.41, 0.197, 4.9],
        ["mail.google.com", 410, 130, 0.308, 0.123, 2.8],
        ["reddit.com", 360, 60, 0.217, 0.067, 0.9],
      ],
      "the sites its campaigns came from",
    );
  });

  it("names a row by what the breakdown asks for", () => {
    const keysOf = (breakdown: SourceBreakdown, slug = RICH) =>
      acquisitionOf(slug, 30, { breakdown }).data.sources.map((row) => row.key);
    const referrers = acquisitionOf(RICH, 30, { breakdown: SourceBreakdown.Referrer }).data.sources;
    const referrer = (key: string): SourceRow => referrers.find((row) => row.key === key) ?? assert.fail(key);
    assert.deepEqual(
      [referrer("genex.games").shown, referrer("genex.games").newVisitors, referrer("genex.games").newPlayers],
      [157_900, 8620, 3790],
      "everything inside Genex comes from its own site",
    );
    assert.deepEqual(
      [referrer(SourceChannel.Direct).newVisitors, referrer(SourceChannel.Direct).newPlayers],
      [1540, 520],
    );
    assert.ok(referrer("tiktok.com").newPlayers > 1460, "a site's campaign and plain links count together");
    assert.equal(
      referrers.every((row) => row.parts.length === 0),
      true,
    );
    assert.equal(referrers.filter((row) => row.shown !== null).length, 1, "Genex shows the game only inside Genex");
    for (const key of keysOf(SourceBreakdown.Country)) assert.match(key, /^[A-Z]{2}$/);
    assert.ok(keysOf(SourceBreakdown.Country).length > 8);
    assert.deepEqual(keysOf(SourceBreakdown.Device), [DeviceClass.Computer, DeviceClass.Phone, DeviceClass.Tablet]);
    const devices = acquisitionOf(RICH, 30, { breakdown: SourceBreakdown.Device }).data;
    assert.equal(sum(devices.sources.map((row) => row.shown ?? 0)), devices.shown?.now, "shown on every device");
    assert.deepEqual(keysOf(SourceBreakdown.Device, STEADY).toSorted(), Object.values(DeviceClass).toSorted());
  });

  it("credits the latest source without losing anybody: Genex and Direct gain what the others lose", () => {
    for (const slug of [RICH, STEADY]) {
      const first = acquisitionOf(slug, 30, { attribution: Attribution.First }).data;
      const latest = acquisitionOf(slug, 30, { attribution: Attribution.Latest }).data;
      const players = (data: AcquisitionReport, channel: SourceChannel) =>
        data.sources.find((row) => row.key === channel)?.newPlayers ?? 0;
      for (const channel of [SourceChannel.Genex, SourceChannel.Direct])
        assert.ok(players(latest, channel) > players(first, channel), `${slug}: ${channel} gains`);
      for (const channel of [SourceChannel.Campaigns, SourceChannel.Social])
        assert.ok(players(latest, channel) < players(first, channel), `${slug}: ${channel} loses`);
      assert.deepEqual(latest.daily, first.daily, `${slug}: the days stay by first channel`);
      assert.deepEqual(latest.campaigns, first.campaigns, `${slug}: a player keeps their first campaign`);
      assert.deepEqual([latest.shown, latest.shownVisitors], [first.shown, first.shownVisitors], slug);
      const countries = (attribution: Attribution) =>
        acquisitionOf(slug, 30, { breakdown: SourceBreakdown.Country, attribution }).data.sources;
      assert.deepEqual(countries(Attribution.Latest), countries(Attribution.First), `${slug}: a country is no source`);
    }
  });

  it("groups campaigns by each utm_ tag, a campaign that came without the tag left out", () => {
    const grouped = (campaignBy: CampaignField, slug = RICH): CampaignRow[] =>
      acquisitionOf(slug, 30, { campaignBy }).data.campaigns;
    assert.deepEqual(
      grouped(CampaignField.Source).map((row) => [row.name, row.source, row.medium, row.newVisitors, row.newPlayers]),
      [
        ["tiktok", "tiktok", "social", 3420, 1460],
        ["youtube", "youtube", "video", 1180, 520],
        ["discord", "discord", "community", 640, 310],
        ["email", "email", "newsletter", 410, 130],
        ["reddit", "reddit", "social", 360, 60],
      ],
    );
    const media = grouped(CampaignField.Medium);
    assert.deepEqual(
      media.map((row) => [row.name, row.source, row.newVisitors, row.newPlayers]),
      [
        ["social", "tiktok", 3780, 1520],
        ["video", "youtube", 1180, 520],
        ["community", "discord", 640, 310],
        ["newsletter", "email", 410, 130],
      ],
      "two campaigns of one medium are one row, under the source that brought most",
    );
    close(
      media[0]?.day1 ?? null,
      (1460 * 0.26 + 60 * 0.217) / 1520,
      0.0006,
      "a merged row's Day 1 is its players' average",
    );
    const contents = grouped(CampaignField.Content);
    assert.ok(contents.length > 0 && contents.length < 5, "some links carry utm_content");
    assert.ok(sum(contents.map((row) => row.newPlayers)) < 2480);
    assert.equal(grouped(CampaignField.Term).length, 1, "one link carries utm_term");
    for (const slug of [RICH, STEADY]) {
      for (const campaignBy of Object.values(CampaignField)) {
        const rows = grouped(campaignBy, slug);
        assert.equal(
          new Set(rows.map((row) => row.name)).size,
          rows.length,
          `${slug} by ${campaignBy}: one row a value`,
        );
        for (const row of rows)
          assert.ok(row.newVisitors >= row.newPlayers && row.newVisitors > 0, `${slug}: ${row.name}`);
      }
    }
    assert.ok(grouped(CampaignField.Campaign, STEADY).length > 0, "a steady game has campaigns of its own");
    assert.deepEqual(grouped(CampaignField.Term, STEADY), [], "and none with utm_term");
  });

  it("has almost nothing for a young game: no campaign, no Day 7, and Genex not counting what it showed yet", () => {
    for (const days of STATS_PERIODS) {
      const sample = sampleOf(YOUNG, days);
      everyOption((options) => {
        const { data, name } = acquisitionOf(YOUNG, days, options);
        assert.ok(data.newPlayers.now > 0 && data.newPlayers.now < 40, name);
        assert.deepEqual([data.shown, data.shownVisitors], [null, null], name);
        assert.deepEqual(data.campaigns, [], name);
        const rows = [...data.sources, ...data.sources.flatMap((row) => row.parts)];
        assert.ok(rows.length > 0, name);
        assert.equal(
          rows.every((row) => row.day7 === null && row.shown === null),
          true,
          `${name}: unripe is null`,
        );
        assert.equal(
          rows.some((row) => row.day1 !== null),
          sample.day1.now !== null,
          `${name}: Day 1 has passed`,
        );
        assert.equal(
          rows.every((row) => row.nexPerPlayer === null || row.nexPerPlayer === 0),
          true,
          `${name}: no Nex yet`,
        );
      });
    }
  });

  it("has nothing at all for a week nobody came", () => {
    const sample = sampleOf(STEADY, 7, FixtureAccount.Quiet);
    assert.equal(sample.newVisitors.now, 0);
    everyOption((options) => {
      const { data, name } = acquisitionOf(STEADY, 7, options, FixtureAccount.Quiet);
      assert.deepEqual([data.sources, data.campaigns, data.daily], [[], [], []], name);
      assert.deepEqual([data.newPlayers.now, data.newVisitors.now], [0, 0], name);
      assert.equal(
        data.funnel.every((step) => step.people === 0),
        true,
        name,
      );
      assert.deepEqual([data.shown?.now, data.shownVisitors?.now], [0, 0], `${name}: counted, and nothing`);
    });
  });
});

// ── What the tab derives and draws ─────────────────────────────────────────────────────────

type Answer = ReportAnswer<typeof GameReport.Acquisition>;

/** What the tests reach in the renderer build: the view model, the blocks the report is made of, and React's server renderer. */
interface AcquisitionBundle {
  view: typeof AcquisitionView;
  AcquisitionReport: (props: ReportProps<typeof GameReport.Acquisition>) => ReactElement;
  SourcesSection: (props: SourcesProps) => ReactElement;
  CampaignsSection: (props: CampaignsProps) => ReactElement;
  createElement: (type: unknown, props: object | null, ...children: unknown[]) => ReactElement;
  renderToStaticMarkup: (element: ReactElement) => string;
}

/** The Acquisition as the plain renderer build compiles it. */
async function acquisitionBundle(): Promise<AcquisitionBundle> {
  const result = await build({
    stdin: {
      contents: [
        'export * as view from "./src/renderer/play/game-analytics/acquisition-view.ts";',
        'export { AcquisitionReport } from "./src/renderer/play/game-analytics/AcquisitionReport.tsx";',
        'export { CampaignsSection, SourcesSection } from "./src/renderer/play/game-analytics/acquisition-sections.tsx";',
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
  });
  const code = result.outputFiles[0]?.text ?? "";
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

describe("the Acquisition tab", () => {
  /** The day the fixture answers end on: the design's own month, Oct 19 to Nov 17. */
  const NOW = Date.parse("2026-11-17T12:04:00.000Z");
  const noop = (): void => {};
  let bundle: AcquisitionBundle;
  before(async () => {
    bundle = await acquisitionBundle();
  });
  // The bundle reads the same language slot as this file: numbers the English way, whatever the computer's.
  beforeEach(() => setLocale(Locale.Japanese, {}));
  after(() => setLocale(Locale.English, {}));

  /** A fixture game of `kind`; only the rich one has an app build. */
  const sourceOf = (kind: SampleKind, over: Partial<SampleSource> = {}): SampleSource => ({
    // The fixture account's own young game: it has no campaign, which another slug's may.
    slug: kind === SampleKind.Young ? "stick-steel" : "lantern-run",
    title: "Lantern Run",
    coverUrl: null,
    plays: kind === SampleKind.Young ? 2431 : 30_000,
    playingNow: 38,
    hasAppBuild: kind === SampleKind.Rich,
    kind,
    dormant: false,
    ...over,
  });
  /** The answer a fixture launch gives for a game, as it crosses the wire and the real parser. */
  function answerOf(
    kind: SampleKind,
    days: StatsPeriod = 30,
    options: GameReportOptions = {},
    over: Partial<SampleSource> = {},
  ): Answer {
    const sample = gameSample(sourceOf(kind, over), days, NOW);
    const wire: unknown = JSON.parse(JSON.stringify(fixtureAcquisition(sample, options)));
    const data = toAcquisitionReport(wire, sample.window);
    assert.ok(data, `the ${kind} game's ${days} days parse`);
    return { report: GameReport.Acquisition, game: sample.game, window: sample.window, data };
  }
  const withData = (answer: Answer, data: Partial<AcquisitionReport>): Answer => ({
    ...answer,
    data: { ...answer.data, ...data },
  });
  const rich = (options: GameReportOptions = {}): Answer => answerOf(SampleKind.Rich, 30, options);
  /** A week nobody came in. */
  const quiet = (): Answer => answerOf(SampleKind.Steady, 7, {}, { dormant: true });

  const percent = (rate: number): string => `${(rate * 100).toFixed(1)}%`;
  const closeTo = (actual: number | null, expected: number, within: number, name: string): void =>
    assert.ok(actual !== null && Math.abs(actual - expected) <= within, `${name}: ${actual} against ${expected}`);
  /** The visit-to-play tile's share: the funnel's Loaded step over its first. */
  const tileShare = (answer: Answer): number | null => {
    const step = (name: FunnelStep) => answer.data.funnel.find((one) => one.step === name)?.people;
    const visited = step(FunnelStep.Visited);
    return visited ? (step(FunnelStep.Loaded) ?? 0) / visited : null;
  };
  const tileOf = (answer: Answer, id: AcquisitionView.AcquisitionTile) =>
    bundle.view.acquisitionTiles(answer.data).find((tile) => tile.id === id);
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

  describe("derives its tiles", () => {
    it("from the rich game's month: new players, new visitors, how many played and Genex's click-through", () => {
      const tiles = bundle.view.acquisitionTiles(rich().data);
      assert.deepEqual(
        tiles.map((tile) => [tile.id, tile.label, tile.value]),
        [
          ["newPlayers", "New players", "7,840"],
          ["newVisitors", "New visitors", "19,380"],
          ["visitToPlay", "Visit-to-play rate", "40.5%"],
          ["clickThrough", "Genex click-through", "5.2%"],
        ],
      );
      assert.deepEqual(
        tiles.map((tile) => tile.note),
        [
          "played this game for the first time",
          "opened the game page for the first time",
          "new visitors who got into the game",
          "of 157,900 times Genex showed the game",
        ],
      );
    });

    it("tells how each moved: counts in percent, the two rates in points", () => {
      const answer = rich();
      const { newPlayers, newVisitors, shown, shownVisitors } = answer.data;
      const [players, visitors, toPlay, clicked] = bundle.view.acquisitionTiles(answer.data).map((tile) => tile.delta);
      assert.deepEqual(players, { kind: "percent", now: newPlayers.now, before: newPlayers.before });
      assert.deepEqual(visitors, { kind: "percent", now: newVisitors.now, before: newVisitors.before });
      assert.equal(toPlay?.kind, "points");
      const step = (name: FunnelStep) => answer.data.funnel.find((one) => one.step === name)?.people ?? 0;
      closeTo(toPlay?.now ?? null, step(FunnelStep.Loaded) / step(FunnelStep.Visited), 1e-9, "visit to play now");
      assert.equal(toPlay?.before, null, "the answer has no funnel for the period before");
      assert.equal(clicked?.kind, "points");
      closeTo(clicked?.now ?? null, (shownVisitors?.now ?? 0) / (shown?.now ?? 1), 1e-9, "click-through now");
      closeTo(
        clicked?.before ?? null,
        (shownVisitors?.before ?? 0) / (shown?.before ?? 1),
        1e-9,
        "click-through before",
      );
    });

    it("leaves Genex click-through out while Genex does not count the times it showed the game", () => {
      const young = answerOf(SampleKind.Young);
      assert.equal(young.data.shown, null);
      assert.deepEqual(
        bundle.view.acquisitionTiles(young.data).map((tile) => tile.id),
        ["newPlayers", "newVisitors", "visitToPlay"],
      );
    });

    it("keeps a rate with nobody to divide by empty, never zero", () => {
      const nobody = withData(rich(), {
        newVisitors: { now: 0, before: 0 },
        newPlayers: { now: 0, before: 0 },
        shown: { now: 0, before: 0 },
        shownVisitors: { now: 0, before: 0 },
        funnel: [
          { step: FunnelStep.Visited, people: 0 },
          { step: FunnelStep.Loaded, people: 0 },
        ],
      });
      const tiles = bundle.view.acquisitionTiles(nobody.data);
      assert.deepEqual(
        tiles.map((tile) => tile.value),
        ["0", "0", null, null],
        "counts are numbers, rates are not known",
      );
      for (const tile of tiles.slice(2)) assert.deepEqual([tile.delta.now, tile.delta.before], [null, null], tile.id);
      assert.equal(tiles[3]?.note, "of 0 times Genex showed the game");
      const nobodyOpened = withData(rich(), {
        funnel: [
          { step: FunnelStep.Visited, people: 0 },
          { step: FunnelStep.Loaded, people: 0 },
        ],
      });
      assert.equal(tileOf(nobodyOpened, "visitToPlay")?.value, null, "nobody opened the page");
      const unknown = withData(rich(), { shownVisitors: null });
      assert.equal(tileOf(unknown, "clickThrough")?.value, null, "times shown, and nobody counted who came of it");
    });
  });

  describe("never writes a visit-to-play share over 100%", () => {
    it("takes the tile from the funnel: the new visitors who got into the game, whoever else first played", () => {
      const answer = withData(rich(), {
        newVisitors: { now: 100, before: 100 },
        newPlayers: { now: 120, before: 90 },
        funnel: [
          { step: FunnelStep.Visited, people: 100 },
          { step: FunnelStep.PressedPlay, people: 95 },
          { step: FunnelStep.Loaded, people: 90 },
          { step: FunnelStep.Engaged, people: 60 },
        ],
      });
      const toPlay = tileOf(answer, "visitToPlay");
      assert.equal(toPlay?.value, "90.0%");
      assert.equal(toPlay?.note, "new visitors who got into the game");
    });

    it("leaves a row's or a link's visit to play empty when it counts more new players than new visitors", () => {
      const answer = withData(rich(), {
        sources: [
          {
            key: "campaigns",
            newVisitors: 2,
            newPlayers: 5,
            shown: null,
            day1: null,
            day7: null,
            nexPerPlayer: null,
            parts: [],
          },
        ],
        campaigns: [
          {
            name: "late_click",
            source: "tiktok",
            medium: "social",
            newVisitors: 2,
            newPlayers: 5,
            day1: null,
            day7: null,
            nexPerPlayer: null,
          },
        ],
      });
      const sources = bundle.view.acquisitionSources(answer.data) ?? assert.fail("no sources");
      const campaigns = bundle.view.acquisitionCampaigns(answer.data) ?? assert.fail("no campaigns");
      assert.equal(sources.rows[0]?.visitToPlay, null);
      assert.equal(campaigns.rows[0]?.visitToPlay, null);
    });
  });

  describe("derives its chart of new players per day", () => {
    it("by channel, stacked in the order the channels are listed, each in its own colour", () => {
      const answer = rich();
      const chart = bundle.view.acquisitionChart(answer.data.daily, answer.window) ?? assert.fail("no chart");
      assert.deepEqual(
        chart.series.map((row) => row.id),
        ["genex", "campaigns", "social", "direct", "search", "other"],
      );
      assert.deepEqual(
        chart.series.map((row) => row.slot),
        [SeriesSlot.First, SeriesSlot.Second, SeriesSlot.Third, SeriesSlot.Fourth, SeriesSlot.Fifth, SeriesSlot.Rest],
      );
      assert.deepEqual(
        chart.series.map((row) => row.label),
        ["Genex", "Campaigns", "Social", "Direct", "Search engines", "Other sites"],
      );
      assert.deepEqual(
        chart.legend.map((item) => item.id),
        chart.series.map((row) => row.id),
      );
      assert.deepEqual(chart.labels, periodLabels(answer.window));
      assert.equal(sum(chart.series.flatMap((row) => row.values)), 7840, "every new player of the period is in a bar");
      assert.ok(chart.series.every((row) => row.values.length === 30));
    });

    it("marks the day campaigns took the lead, when the period holds it", () => {
      const answer = rich();
      const chart = bundle.view.acquisitionChart(answer.data.daily, answer.window) ?? assert.fail("no chart");
      assert.deepEqual(chart.marks, [
        { index: 30 - 1 - 12, kind: AnnotationKind.Campaign, label: "Campaigns take the lead" },
      ]);
      assert.equal(chart.labels[17], formatDayOf(answer, 17), "the mark's day is the campaign's first");
      const week = answerOf(SampleKind.Rich, 7);
      const weekChart = bundle.view.acquisitionChart(week.data.daily, week.window) ?? assert.fail("no chart");
      assert.deepEqual(weekChart.marks, [], "a week that begins inside the run holds no start");
      const steady = answerOf(SampleKind.Steady);
      assert.deepEqual(bundle.view.acquisitionChart(steady.data.daily, steady.window)?.marks, [], "no campaign leads");
    });

    it("finds the first day of each run of days when campaigns bring more than any other channel", () => {
      const day = (genex: number[], campaigns: number[]) => [
        { channel: SourceChannel.Genex, newPlayers: genex },
        { channel: SourceChannel.Campaigns, newPlayers: campaigns },
      ];
      const starts = bundle.view.campaignLeadStarts;
      assert.deepEqual(starts(day([5, 5, 5, 5, 5, 5, 5], [0, 0, 0, 9, 8, 7, 1])), [3]);
      assert.deepEqual(starts(day([5, 5, 5, 5, 5, 5, 5], [0, 0, 9, 1, 1, 8, 8])), [2, 5], "two runs, two starts");
      assert.deepEqual(
        starts(day([5, 5, 5, 5, 5, 5, 5], [9, 9, 9, 0, 0, 0, 0])),
        [],
        "the run began before the period",
      );
      assert.deepEqual(starts(day([5, 5, 5, 5, 5, 5, 5], [0, 0, 5, 5, 5, 5, 5])), [], "a tie is no lead");
      assert.deepEqual(
        starts([{ channel: SourceChannel.Campaigns, newPlayers: [0, 0, 3, 3] }]),
        [2],
        "alone, it leads",
      );
      assert.deepEqual(starts([{ channel: SourceChannel.Genex, newPlayers: [1, 2, 3] }]), [], "no campaigns");
      assert.deepEqual(starts([]), []);
    });

    it("is absent when nobody new came, and leaves out a channel that brought nobody", () => {
      const answer = quiet();
      assert.equal(answer.data.newPlayers.now, 0);
      assert.equal(bundle.view.acquisitionChart(answer.data.daily, answer.window), null);
      const zeros = [{ channel: SourceChannel.Genex, newPlayers: [0, 0, 0, 0, 0, 0, 0] }];
      assert.equal(bundle.view.acquisitionChart(zeros, answer.window), null);
      const one = bundle.view.acquisitionChart(
        [...zeros, { channel: SourceChannel.Direct, newPlayers: [0, 0, 2, 0, 0, 0, 0] }],
        answer.window,
      );
      assert.deepEqual(
        one?.series.map((row) => row.id),
        ["direct"],
      );
    });
  });

  /** The label the chart's axis writes for day `index` of the answer's period. */
  function formatDayOf(answer: Answer, index: number): string {
    return periodLabels(answer.window)[index] ?? assert.fail(`no day ${index}`);
  }

  describe("derives its funnel", () => {
    it("with the share that goes on and how many leave between steps", () => {
      const answer = rich();
      const steps = bundle.view.acquisitionFunnel(answer.data.funnel) ?? assert.fail("no funnel");
      const people = answer.data.funnel.map((step) => step.people);
      assert.deepEqual(
        steps.map((step) => [step.id, step.label, step.count]),
        [
          ["visited", "Opened the game page", people[0]],
          ["pressed_play", "Pressed Play", people[1]],
          ["loaded", "Game loaded", people[2]],
          ["engaged", "Played 30 s or more", people[3]],
          ["returned", "Came back another day", people[4]],
        ],
      );
      const lost = (index: number) => formatNumber((people[index] ?? 0) - (people[index + 1] ?? 0));
      const share = (index: number) => percent((people[index + 1] ?? 0) / (people[index] ?? 1));
      assert.deepEqual(
        steps.map((step) => [step.onward, step.lost]),
        [
          [`${share(0)} press Play`, `${lost(0)} leave`],
          [`${share(1)} see it load`, `${lost(1)} leave while it loads`],
          [`${share(2)} play 30 s or more`, `${lost(2)} leave sooner`],
          [`${share(3)} come back`, `${lost(3)} have not yet`],
          [`${percent((people[4] ?? 0) / (people[0] ?? 1))} of new visitors`, null],
        ],
      );
    });

    it("skips a step the answer does not hold, as a page that starts the game by itself has no Play button", () => {
      const steps =
        bundle.view.acquisitionFunnel([
          { step: FunnelStep.Visited, people: 200 },
          { step: FunnelStep.Loaded, people: 150 },
          { step: FunnelStep.Engaged, people: 100 },
        ]) ?? assert.fail("no funnel");
      assert.deepEqual(
        steps.map((step) => step.id),
        ["visited", "loaded", "engaged"],
      );
      assert.deepEqual(
        steps.map((step) => [step.onward, step.lost]),
        [
          ["75.0% see it load", "50 leave while it loads"],
          ["66.7% play 30 s or more", "50 leave sooner"],
          ["50.0% of new visitors", null],
        ],
      );
    });

    it("says nothing it cannot back: a step nobody leaves has no loss, and one that grows no share", () => {
      const steps =
        bundle.view.acquisitionFunnel([
          { step: FunnelStep.Visited, people: 100 },
          { step: FunnelStep.PressedPlay, people: 100 },
          { step: FunnelStep.Loaded, people: 120 },
          { step: FunnelStep.Engaged, people: 0 },
        ]) ?? assert.fail("no funnel");
      assert.deepEqual(
        steps.map((step) => [step.onward, step.lost]),
        [
          ["100.0% press Play", null],
          [null, null],
          ["0.0% play 30 s or more", "120 leave sooner"],
          ["0.0% of new visitors", null],
        ],
      );
      const alone = bundle.view.acquisitionFunnel([{ step: FunnelStep.Visited, people: 9 }]) ?? assert.fail("alone");
      assert.deepEqual([alone[0]?.onward, alone[0]?.lost], [null, null], "one step is no way anywhere");
      const headless = bundle.view.acquisitionFunnel([
        { step: FunnelStep.Loaded, people: 50 },
        { step: FunnelStep.Engaged, people: 25 },
      ]);
      assert.deepEqual(
        headless?.map((step) => step.onward),
        ["50.0% play 30 s or more", null],
        "no share of an unseen first step",
      );
    });

    it("is absent when nobody opened the game page", () => {
      assert.equal(bundle.view.acquisitionFunnel([]), null);
      assert.equal(bundle.view.acquisitionFunnel([{ step: FunnelStep.Visited, people: 0 }]), null);
      assert.equal(bundle.view.acquisitionView(quiet()).funnel, null);
    });
  });

  describe("derives its sources table", () => {
    const table = (answer: Answer) => bundle.view.acquisitionView(answer).sources ?? assert.fail("no sources");
    const names = (rows: readonly AcquisitionView.AcquisitionRow[]) => rows.map((row) => row.name);

    it("by channel: the channels' own names, Genex open on its places, and every new player in the last row", () => {
      const answer = rich();
      const { rows, total, expanded } = table(answer);
      assert.deepEqual(names(rows), ["Genex", "Campaigns", "Social", "Direct", "Search engines", "Other sites"]);
      const genex = rows[0] ?? assert.fail();
      assert.deepEqual(names(genex.parts), [
        "Games feed",
        "Featured",
        "Search on Genex",
        "Your profile",
        "Friends playing and invites",
        "Remixes of this game",
      ]);
      assert.deepEqual(
        genex.parts.map((part) => [part.shown, part.newVisitors, part.newPlayers]),
        [
          [96_400, 3660, 1540],
          [41_200, 2470, 1180],
          [9800, 1060, 520],
          [6300, 610, 250],
          [null, 480, 210],
          [4200, 340, 90],
        ],
      );
      assert.deepEqual(expanded, [genex.id], "the first row of the table starts open");
      assert.deepEqual(names(rows[1]?.parts ?? []), [
        "tiktok.com",
        "youtube.com",
        "discord.com",
        "mail.google.com",
        "reddit.com",
      ]);
      assert.deepEqual(rows[3]?.parts, [], "nothing is inside Direct");
      const all = total ?? assert.fail("no total row");
      assert.deepEqual(
        [all.name, all.shown, all.newVisitors, all.newPlayers],
        ["All new players", 157_900, 19_380, 7840],
      );
      assert.equal(all.visitToPlay, tileShare(answer), "the total's visit to play is the tile's");
      assert.deepEqual(
        [all.day1, all.day7, all.nexPerPlayer],
        [null, null, null],
        "the answer has no rate for every new player: the listed rows' would describe them alone",
      );
      assert.deepEqual(all.parts, []);
      assert.equal(rows[0]?.visitToPlay, 3790 / 8620, "a row's own visit to play");
    });

    it("names each row apart, a row's places by the row they are inside of", () => {
      const { rows, total } = table(rich());
      const ids = [...rows.flatMap((row) => [row.id, ...row.parts.map((part) => part.id)]), total?.id ?? ""];
      assert.equal(new Set(ids).size, ids.length, "Search is a channel and a place inside Genex");
      assert.ok(ids.includes("channel:search") && ids.includes("channel:genex/search"), ids.join(" "));
    });

    it("by referrer: the sites as the text they are, the visits with no site as such, nothing inside a row", () => {
      const { rows, expanded } = table(rich({ breakdown: SourceBreakdown.Referrer }));
      assert.deepEqual(expanded, [], "only the channel breakdown opens a row");
      assert.ok(rows.every((row) => row.parts.length === 0));
      const name = (id: string) => rows.find((row) => row.id === `referrer:${id}`)?.name;
      assert.equal(name("genex.games"), "genex.games", "a host is not a word of ours");
      assert.equal(name("tiktok.com"), "tiktok.com");
      assert.equal(name(SourceChannel.Direct), "No referrer");
    });

    it("by device: the devices' own names", () => {
      const { rows } = table(rich({ breakdown: SourceBreakdown.Device }));
      assert.deepEqual(names(rows), ["Computer", "Phone", "Tablet"]);
    });

    it("by country: the country's name in the app's language, its letters when the language has none", () => {
      setLocale(Locale.English, {});
      assert.deepEqual([bundle.view.countryName("DE"), bundle.view.countryName("US")], ["Germany", "United States"]);
      assert.equal(bundle.view.countryName("XX"), "XX", "no such country");
      assert.equal(bundle.view.countryName("ZZ"), "Unknown Region", "a country genex.games could not tell, named");
      setLocale(Locale.German, {});
      assert.deepEqual(
        [
          bundle.view.countryName("DE"),
          bundle.view.countryName("BR"),
          bundle.view.countryName("XX"),
          bundle.view.countryName("ZZ"),
        ],
        ["Deutschland", "Brasilien", "XX", "Unbekannte Region"],
      );
      const { rows } = table(rich({ breakdown: SourceBreakdown.Country }));
      assert.equal(rows[0]?.name, "Vereinigte Staaten", "the first country by new players");
      assert.ok(rows.every((row) => row.parts.length === 0));
      const total = sum(rows.map((row) => row.newPlayers));
      assert.equal(total, 7840);
    });

    it("keeps what cannot be known yet empty: a rate nobody could have reached, a Nex nobody spent", () => {
      const { rows, total } = table(answerOf(SampleKind.Young));
      assert.ok(rows.length > 0);
      for (const row of [...rows, ...rows.flatMap((one) => one.parts), total ?? assert.fail()]) {
        assert.equal(row.day7, null, `${row.id}: Day 7 has not come`);
        assert.equal(row.shown, null, `${row.id}: Genex does not count yet`);
      }
      assert.equal(total?.shown, null);
    });

    it("is absent when no source brought a new visitor", () => {
      assert.equal(bundle.view.acquisitionView(quiet()).sources, null);
      assert.equal(bundle.view.acquisitionSources(withData(rich(), { sources: [] }).data), null);
    });

    it("counts every new player in the total row, whatever rows are listed, and claims no rate for them", () => {
      const row = (key: string, newPlayers: number, day1: number | null): SourceRow => ({
        key,
        shown: null,
        newVisitors: newPlayers * 2,
        newPlayers,
        day1,
        day7: null,
        nexPerPlayer: day1 === null ? null : 10,
        parts: [],
      });
      const answer = withData(rich({ breakdown: SourceBreakdown.Device }), {
        sources: [row("computer", 30, 0.5), row("phone", 10, 0.1), row("tablet", 60, null)],
      });
      const { total } = table(answer);
      assert.deepEqual(
        [total?.newVisitors, total?.newPlayers],
        [answer.data.newVisitors.now, answer.data.newPlayers.now],
        "the report's own totals, not the 100 listed",
      );
      assert.deepEqual([total?.day1, total?.day7, total?.nexPerPlayer], [null, null, null]);
    });
  });

  describe("derives its campaigns table", () => {
    const table = (answer: Answer) => bundle.view.acquisitionView(answer).campaigns ?? assert.fail("no campaigns");

    it("the design's five campaigns, each with the source and medium it came with, and no row that claims to be all of them", () => {
      const { rows, total, expanded } = table(rich());
      assert.deepEqual(
        rows.map((row) => [row.name, row.detail, row.newVisitors, row.newPlayers]),
        [
          ["launch_trailer", "tiktok / social", 3420, 1460],
          ["devlog_12", "youtube / video", 1180, 520],
          ["halloween_update", "discord / community", 640, 310],
          ["newsletter_oct", "email / newsletter", 410, 130],
          ["reddit_webgames", "reddit / social", 360, 60],
        ],
      );
      assert.deepEqual(
        rows.map((row) => [row.day1, row.day7, row.nexPerPlayer]),
        [
          [0.26, 0.082, 1.6],
          [0.352, 0.149, 3.4],
          [0.41, 0.197, 4.9],
          [0.308, 0.123, 2.8],
          [0.217, 0.067, 0.9],
        ],
      );
      assert.equal(rows[0]?.visitToPlay, 1460 / 3420);
      assert.deepEqual(
        rows.map((row) => row.shown),
        [null, null, null, null, null],
        "Genex shows no campaign",
      );
      assert.equal(total, null, "the answer holds the largest campaigns and no total of them all");
      assert.deepEqual(expanded, []);
      assert.ok(rows.every((row) => row.parts.length === 0));
    });

    it("grouped by another tag: a row for each value", () => {
      const { rows, total } = table(rich({ campaignBy: CampaignField.Medium }));
      assert.deepEqual(
        rows.map((row) => [row.name, row.detail, row.newPlayers]),
        [
          ["social", "tiktok / social", 1520],
          ["video", "youtube / video", 520],
          ["community", "discord / community", 310],
          ["newsletter", "email / newsletter", 130],
        ],
      );
      assert.equal(total, null);
    });

    it("says only the half of source and medium a campaign has, and nothing of a campaign with neither", () => {
      const row = (name: string, source: string | null, medium: string | null): CampaignRow => ({
        name,
        source,
        medium,
        newVisitors: 10,
        newPlayers: 4,
        day1: null,
        day7: null,
        nexPerPlayer: null,
      });
      const answer = withData(rich(), {
        campaigns: [
          row("a", "tiktok", null),
          row("b", null, "video"),
          row("c", null, null),
          row("d", "tiktok", "social"),
        ],
      });
      const { rows } = table(answer);
      assert.deepEqual(
        rows.map((one) => one.detail),
        ["tiktok", "video", null, "tiktok / social"],
      );
    });

    it("is absent when no campaign brought a new visitor, as for a young game or a week nobody came", () => {
      assert.equal(bundle.view.acquisitionView(answerOf(SampleKind.Young)).campaigns, null);
      assert.equal(bundle.view.acquisitionView(quiet()).campaigns, null);
    });
  });

  describe("derives for every fixture game, period and option", () => {
    /** Every kind of game over every period, with every breakdown, attribution and tag asked. */
    const everyAsk = Object.values(SampleKind).flatMap((kind) =>
      STATS_PERIODS.flatMap((days) =>
        Object.values(SourceBreakdown).flatMap((breakdown) =>
          Object.values(Attribution).flatMap((attribution) =>
            Object.values(CampaignField).map((campaignBy) => ({ kind, days, breakdown, attribution, campaignBy })),
          ),
        ),
      ),
    );
    const idsOf = (table: AcquisitionView.AcquisitionTable | null): string[] =>
      table ? table.rows.flatMap((row) => [row.id, ...row.parts.map((part) => part.id)]) : [];

    it("tables whose total row counts every new player and visitor of the report, and whose rows are told apart", () => {
      for (const { kind, days, ...options } of everyAsk) {
        const name = `${kind} over ${days} days by ${JSON.stringify(options)}`;
        const view = bundle.view.acquisitionView(answerOf(kind, days, options));
        assert.deepEqual([view.breakdown, view.attribution, view.campaignBy], Object.values(options), name);
        const { data } = answerOf(kind, days, options);
        if (view.sources) {
          assert.equal(view.sources.total?.newPlayers, data.newPlayers.now, `${name}: players`);
          assert.equal(view.sources.total?.newVisitors, data.newVisitors.now, `${name}: visitors`);
        }
        assert.equal(view.campaigns?.total ?? null, null, `${name}: no campaigns total`);
        for (const table of [view.sources, view.campaigns]) {
          const ids = idsOf(table);
          assert.equal(new Set(ids).size, ids.length, `${name}: rows are told apart`);
        }
        assert.ok(view.tiles.length >= 3 && view.tiles.every((tile) => tile.value !== ""), name);
      }
    });
  });

  /** The words a reader meets in `markup`: tags gone, spaces single, the markup's escapes read back. */
  const words = (markup: string): string =>
    markup
      .replace(/<[^>]*>/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  /** The part of `markup` from the opening tag that matches `pattern` up to the next one that closes it. */
  const sectionOf = (markup: string, id: string): string =>
    new RegExp(`<section[^>]*data-game-analytics-section="${id}".*?</section>`).exec(markup)?.[0] ?? "";
  /** What a table's row reads as: its cells in order. */
  const rowOf = (markup: string, id: string): string => {
    const escaped = id.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const row = new RegExp(`<div role="row"[^>]*data-game-analytics-row="${escaped}"[^>]*>.*?</div>`).exec(markup)?.[0];
    return row ? words(row) : "";
  };
  /** The switch `id`'s options as they read, and the one that is chosen. */
  const switchOf = (markup: string, id: string): { options: string[]; chosen: string[] } => {
    const group = new RegExp(`<div[^>]*data-game-analytics-switch="${id}".*?</div>`).exec(markup)?.[0] ?? "";
    const buttons = group.match(/<button[^>]*>.*?<\/button>/g) ?? [];
    const optionOf = (button: string) => /data-game-analytics-option="([^"]*)"/.exec(button)?.[1] ?? "";
    return {
      options: buttons.map(optionOf),
      chosen: buttons.filter((button) => button.includes('aria-checked="true"')).map(optionOf),
    };
  };
  const drawReport = (answer: Answer, options: GameReportOptions = {}): string =>
    bundle.renderToStaticMarkup(
      bundle.createElement(bundle.AcquisitionReport, {
        slug: answer.game.slug,
        refreshing: false,
        stale: false,
        now: NOW,
        onOpenTab: noop,
        answer,
        options,
        onOptions: noop,
      } satisfies ReportProps<typeof GameReport.Acquisition>),
    );

  describe("draws the rich game's month", () => {
    it("with four tiles, the bars with their legend, the funnel and the two tables", () => {
      const html = drawReport(rich());
      assert.match(html, /^<div class="game-analytics-report" data-game-analytics-report="acquisition">/);
      const ids = (html.match(/data-game-analytics-tile="([^"]*)"/g) ?? []).map((tag) => tag.split('"')[1]);
      assert.deepEqual(ids, ["newPlayers", "newVisitors", "visitToPlay", "clickThrough"]);
      assert.match(words(html), /New players 7,840 .*played this game for the first time/);
      assert.match(words(html), /Genex click-through 5\.2% .*of 157,900 times Genex showed the game/);
      const sections = (html.match(/data-game-analytics-section="([^"]*)"/g) ?? []).map((tag) => tag.split('"')[1]);
      assert.deepEqual(sections, ["daily", "funnel", "sources", "campaigns"]);
      const daily = sectionOf(html, "daily");
      assert.match(daily, /data-game-analytics-chart="daily"/);
      assert.match(
        words(daily),
        /^New players per day, by where they came from Genex Campaigns Social Direct Search engines Other sites/,
      );
      assert.match(
        words(daily),
        /Campaigns take the lead/,
        "the day campaigns took the lead is told in the chart's table",
      );
      const funnel = sectionOf(html, "funnel");
      assert.match(
        words(funnel),
        /^From the game page to coming back New visitors in this period Opened the game page 19,380/,
      );
      assert.match(funnel, /data-game-analytics-funnel="funnel"/);
      assert.match(sectionOf(html, "sources"), /data-game-analytics-table="sources"/);
      assert.match(sectionOf(html, "campaigns"), /data-game-analytics-table="campaigns"/);
    });

    it("the sources the way the design reads them: Genex open on its places, all new players last", () => {
      const html = drawReport(rich());
      const sources = sectionOf(html, "sources");
      assert.match(words(sources), /Source Shown New visitors New players Visit to play Day 1 Day 7 Nex per player/);
      assert.match(rowOf(sources, "channel:genex"), /^Genex 157,900 8,620 3,790 44\.0% 38\.4% 17\.3% 4\.58$/);
      assert.match(rowOf(sources, "channel:genex/feed"), /^Games feed 96,400 3,660 1,540 42\.1% 36\.2% 15\.8% 4\.05$/);
      assert.match(
        rowOf(sources, "channel:genex/friends"),
        /^Friends playing and invites — 480 210 /,
        "nothing shown to a friend",
      );
      assert.match(rowOf(sources, "channel:campaigns"), /^Campaigns — 6,010 2,480 41\.3% 30\.0% 11\.2% 2\.44$/);
      assert.equal(rowOf(sources, "total"), "All new players 157,900 19,380 7,840 40.5%", "no rate of the listed rows");
      assert.equal(rowOf(sources, "channel:campaigns/tiktok.com"), "", "a closed row hides what is inside it");
      assert.match(sources, /aria-expanded="true"[^>]*aria-label="Hide what is inside Genex"/);
      assert.match(sources, /aria-expanded="false"[^>]*aria-label="Show what is inside Campaigns"/);
      assert.match(words(sources), /Each player counts for the source that first brought them\.$/);
    });

    it("the campaigns the way the design reads them, with the line that a player keeps the first", () => {
      const html = drawReport(rich());
      const campaigns = sectionOf(html, "campaigns");
      assert.match(words(campaigns), /Campaign New visitors New players Visit to play Day 1 Day 7 Nex per player/);
      assert.equal(
        rowOf(campaigns, "launch_trailer"),
        "launch_trailer tiktok / social 3,420 1,460 42.7% 26.0% 8.2% 1.60",
      );
      assert.equal(rowOf(campaigns, "reddit_webgames"), "reddit_webgames reddit / social 360 60 16.7% 21.7% 6.7% 0.90");
      assert.equal(rowOf(campaigns, "total"), "", "no row claims to be every campaign");
      assert.match(
        words(campaigns),
        /A player keeps the first campaign that brought them, through sign-in and install\. Links without utm_ tags are sorted by the site they came from\.$/,
      );
      assert.deepEqual(html.match(/data-game-analytics-open="([^"]*)"/g) ?? [], ['data-game-analytics-open="links"']);
      assert.match(campaigns, /<button[^>]*data-game-analytics-open="links"[^>]*>.*New campaign link<\/button>/);
    });

    it("keeps every control reachable by a name of its own: a switch for each choice and an option for each value", () => {
      const html = drawReport(rich());
      assert.deepEqual(switchOf(html, "breakdown"), {
        options: ["channel", "referrer", "country", "device"],
        chosen: ["channel"],
      });
      assert.deepEqual(switchOf(html, "attribution"), { options: ["first", "latest"], chosen: ["first"] });
      assert.deepEqual(switchOf(html, "campaign-by"), {
        options: ["campaign", "source", "medium", "content", "term"],
        chosen: ["campaign"],
      });
      assert.match(words(sectionOf(html, "sources")), /Channel Referrer Country Device First source Latest source/);
      assert.match(words(sectionOf(html, "campaigns")), /utm_campaign utm_source utm_medium utm_content utm_term/);
    });
  });

  describe("draws what the switches ask for before the answer to it lands", () => {
    /** The words of a table's first column heading. */
    const firstHeading = (section: string): string =>
      words(/<span role="columnheader"[^>]*>.*?<\/span>/.exec(section)?.[0] ?? "");

    it("the switches follow the options at once while the table stays the answer's", () => {
      const html = drawReport(rich(), {
        breakdown: SourceBreakdown.Country,
        attribution: Attribution.Latest,
        campaignBy: CampaignField.Term,
      });
      assert.deepEqual(switchOf(html, "breakdown").chosen, ["country"]);
      assert.deepEqual(switchOf(html, "attribution").chosen, ["latest"]);
      assert.deepEqual(switchOf(html, "campaign-by").chosen, ["term"]);
      assert.match(rowOf(html, "channel:genex"), /^Genex /, "the table is still the answer's");
      assert.match(words(sectionOf(html, "sources")), /that first brought them\.$/);
      assert.equal(
        firstHeading(sectionOf(html, "sources")),
        "Source",
        "its first column still names the answer's rows",
      );
      assert.equal(firstHeading(sectionOf(html, "campaigns")), "Campaign");
    });

    it("a table that has landed names its own breakdown and attribution", () => {
      const html = drawReport(
        rich({ breakdown: SourceBreakdown.Device, attribution: Attribution.Latest, campaignBy: CampaignField.Source }),
        {
          breakdown: SourceBreakdown.Device,
          attribution: Attribution.Latest,
          campaignBy: CampaignField.Source,
        },
      );
      assert.match(rowOf(html, "device:computer"), /^Computer /);
      assert.deepEqual(rowOf(html, "channel:genex"), "");
      assert.match(words(sectionOf(html, "sources")), /of their latest play\.$/);
      assert.match(rowOf(html, "tiktok"), /^tiktok tiktok \/ social 3,420 1,460 /);
      assert.equal(rowOf(sectionOf(html, "campaigns"), "total"), "");
      assert.equal(
        firstHeading(sectionOf(html, "sources")),
        "Device",
        "the first column is named by what its rows are",
      );
      assert.equal(
        firstHeading(sectionOf(html, "campaigns")),
        "utm_source",
        "and by the tag the campaigns are grouped by",
      );
      assert.equal(sectionOf(html, "sources").includes('aria-expanded="true"'), false, "no row starts open");
    });

    it("a country by its name, in the app's language", () => {
      setLocale(Locale.German, {});
      const html = drawReport(rich({ breakdown: SourceBreakdown.Country }), { breakdown: SourceBreakdown.Country });
      assert.match(rowOf(html, "country:US"), /^Vereinigte Staaten /);
      assert.match(rowOf(html, "country:DE"), /^Deutschland /);
    });
  });

  describe("draws what a game has not got yet", () => {
    it("a young game: three tiles, bars, and a campaigns block that says what a link is", () => {
      const html = drawReport(answerOf(SampleKind.Young));
      assert.equal(html.includes('data-game-analytics-tile="clickThrough"'), false);
      assert.match(words(html), /New players \d+ /);
      assert.match(sectionOf(html, "daily"), /data-game-analytics-chart="daily"/);
      const sources = sectionOf(html, "sources");
      assert.match(rowOf(sources, "total"), /^All new players /);
      assert.match(
        rowOf(sources, "total"),
        /^All new players \d+ \d+ [\d.]+%$/,
        "the counts and the share, and no rate of the listed rows",
      );
      const first = bundle.view.acquisitionView(answerOf(SampleKind.Young)).sources?.rows[0] ?? assert.fail("no row");
      assert.match(
        rowOf(sources, first.id),
        /^[^—]+ — \d+ \d+ [\d.]+% [\d.]+% — /,
        "Genex counts no showings, Day 7 has not come: dashes",
      );
      const campaigns = sectionOf(html, "campaigns");
      assert.match(campaigns, /data-game-analytics-campaigns-empty="true"/);
      assert.match(words(campaigns), /No campaign brought new visitors in this period\./);
      assert.match(words(campaigns), /A campaign link is your game’s link with utm_ tags on it\./);
      assert.equal(campaigns.includes("data-game-analytics-table"), false, "no table, no total row");
      assert.equal(campaigns.includes("A player keeps the first campaign"), false);
      assert.deepEqual(
        html.match(/data-game-analytics-open="links"/g)?.length,
        1,
        "one way to Campaign links, not two",
      );
      assert.match(campaigns, /<button[^>]*data-game-analytics-open="links"[^>]*>.*New campaign link<\/button>/);
    });

    it("another tag with no campaign under it names the tag", () => {
      const html = drawReport(withData(rich({ campaignBy: CampaignField.Term }), { campaigns: [] }), {
        campaignBy: CampaignField.Term,
      });
      assert.match(words(sectionOf(html, "campaigns")), /No new visitors came with utm_term in this period\./);
      assert.deepEqual(switchOf(html, "campaign-by").chosen, ["term"], "the switch stays to pick another tag");
    });

    it("a week nobody came: counts as zero, rates as dashes, and every block says so", () => {
      const html = drawReport(quiet());
      const text = words(html);
      assert.match(text, /New players 0 .*New visitors 0 .*Visit-to-play rate — /);
      assert.match(text, /No new players in these days\./);
      assert.match(text, /Nobody opened the game page for the first time in this period\./);
      assert.match(text, /No new visitors in these days\./);
      assert.equal(html.includes("data-game-analytics-chart"), false);
      assert.equal(html.includes("data-game-analytics-funnel"), false);
      assert.equal(html.includes('data-game-analytics-table="sources"'), false);
      assert.deepEqual(switchOf(html, "breakdown").options.length, 4, "the switches stay");
    });
  });

  describe("asks for what a person presses", () => {
    /** The children of a React element, whatever their number. */
    const childrenOf = (node: unknown): unknown[] =>
      isRecord(node) && isRecord(node.props) ? [node.props.children].flat() : [];
    const propsOf = (node: unknown): Record<string, unknown> =>
      isRecord(node) && isRecord(node.props) ? node.props : assert.fail("not an element");
    const call = (fn: unknown, ...args: unknown[]): void => {
      assert.equal(typeof fn, "function");
      if (typeof fn === "function") fn(...args);
    };
    const controlsOf = (section: ReactElement): unknown[] => childrenOf(propsOf(section).controls);

    it("the sources' switches ask for their own option only", () => {
      const asked: GameReportOptions[] = [];
      const view = bundle.view.acquisitionView(rich());
      const section = bundle.SourcesSection({
        table: view.sources,
        breakdown: view.breakdown,
        attribution: view.attribution,
        asked: { breakdown: SourceBreakdown.Channel, attribution: Attribution.First },
        onOptions: (change) => asked.push(change),
      });
      const [breakdown, attribution] = controlsOf(section);
      call(propsOf(breakdown).onChange, SourceBreakdown.Country);
      call(propsOf(attribution).onChange, Attribution.Latest);
      assert.deepEqual(asked, [{ breakdown: "country" }, { attribution: "latest" }]);
    });

    it("the campaigns' switch asks for its tag, and New campaign link opens the Campaign links tab", () => {
      const asked: GameReportOptions[] = [];
      const opened: AnalyticsTab[] = [];
      const view = bundle.view.acquisitionView(rich());
      const section = bundle.CampaignsSection({
        table: view.campaigns,
        campaignBy: view.campaignBy,
        asked: view.campaignBy,
        onOptions: (change) => asked.push(change),
        onOpenTab: (tab) => opened.push(tab),
      });
      const [pick, link] = controlsOf(section);
      call(propsOf(pick).onChange, CampaignField.Medium);
      assert.deepEqual(asked, [{ campaignBy: "medium" }]);
      const button =
        isRecord(link) && typeof link.type === "function" ? link.type(propsOf(link)) : assert.fail("no link");
      call(propsOf(button).onClick);
      assert.deepEqual(opened, [AnalyticsTab.Links]);
    });

    it("the empty campaigns block opens the same tab", () => {
      const opened: AnalyticsTab[] = [];
      const view = bundle.view.acquisitionView(answerOf(SampleKind.Young));
      const section = bundle.CampaignsSection({
        table: view.campaigns,
        campaignBy: view.campaignBy,
        asked: view.campaignBy,
        onOptions: noop,
        onOpenTab: (tab) => opened.push(tab),
      });
      assert.equal(controlsOf(section).length, 2, "the switch, and no second link");
      assert.equal(controlsOf(section)[1], null);
      const none = childrenOf(section)
        .flat()
        .find((node) => isRecord(node) && typeof node.type === "function");
      assert.ok(none, "the empty block");
      const empty = isRecord(none) && typeof none.type === "function" ? none.type(propsOf(none)) : assert.fail();
      const link = childrenOf(empty).find(
        (node) => isRecord(node) && typeof node.type === "function" && node.type.name === "NewLink",
      );
      assert.ok(link, "the link inside it");
      const button = isRecord(link) && typeof link.type === "function" ? link.type(propsOf(link)) : assert.fail();
      call(propsOf(button).onClick);
      assert.deepEqual(opened, [AnalyticsTab.Links]);
    });
  });
});
