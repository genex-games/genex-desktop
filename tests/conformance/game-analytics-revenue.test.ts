/**
 * The Revenue report of a game's analytics, end to end: the parser that reads genex.games' answer
 * (a broken answer is refused, a broken row is dropped, "not known yet" stays null), the fixture
 * launch's made-up report (the same Nex, purchases, payers and players as every other report of the
 * game), what the page derives from an answer, and the report's face as React's server renderer
 * draws it from the plain renderer build.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { build } from "esbuild";
import type { ReactElement } from "react";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { fixtureRevenue } from "../../src/main/dev/fixture-game-analytics/fixture-revenue.ts";
import { createFixtureGameAnalytics } from "../../src/main/dev/fixture-game-analytics/index.ts";
import { gameSample, ownSamples, SampleKind } from "../../src/main/dev/fixture-game-analytics/sample.ts";
import { FixtureAccount, fixtureAccountToken } from "../../src/main/dev/fixture-people.ts";
import { isRecord } from "../../src/main/play/gallery.ts";
import { toRevenueReport } from "../../src/main/play/game-analytics/report-revenue.ts";
import { toReportAnswer } from "../../src/main/play/game-analytics/reports.ts";
import { reportRoute } from "../../src/main/play/game-analytics/routes.ts";
import type { ReportAnswer, ReportProps } from "../../src/renderer/play/game-analytics/report-props.ts";
import type { RevenueView } from "../../src/renderer/play/game-analytics/revenue-view.ts";
import {
  type AnalyticsGame,
  type AnalyticsWindow,
  GameReport,
  RETENTION_SPAN,
  type RevenueReport,
  SourceChannel,
} from "../../src/shared/game-analytics.ts";
import { setLocale } from "../../src/shared/i18n.ts";
import { Locale } from "../../src/shared/locale.ts";
import { STATS_PERIODS, type StatsPeriod } from "../../src/shared/play-stats.ts";

const DAYS = 7;
const WINDOW: AnalyticsWindow = { days: DAYS, endsOn: "2026-11-17", computedAt: "2026-11-17T12:00:00.000Z" };
/** The spending curve's longest: the first day and the `RETENTION_SPAN` days after it. */
const SPEND_POINTS = RETENTION_SPAN + 1;

const fill = <T>(value: T, length = DAYS): T[] => Array.from({ length }, () => value);

/** A Revenue report as genex.games answers it for a week, every part of it well formed. */
const revenueData = (): RevenueReport => ({
  nex: { now: 4200, before: 3100 },
  purchases: { now: 70, before: 52 },
  payers: { now: 35, before: 30 },
  players: { now: 800, before: 640 },
  nexPerPlayerDay: { now: 2.17, before: 2.31 },
  daily: [500, 620, 580, 640, 700, 610, 550],
  dailyBefore: fill(440),
  items: [
    { id: "storm-lantern-skin", name: "Storm Lantern skin", price: 150, sold: 12, buyers: 12, nex: 1800 },
    { id: "extra-life-pack", name: "Extra life pack", price: 40, sold: 40, buyers: 19, nex: 1600 },
    { id: "tip-jar", name: "Tip jar", price: null, sold: 18, buyers: 9, nex: 800 },
  ],
  spend: [1.1, 1.9, 2.4, 2.8, 3, 3.3, 3.5, 3.6, ...fill(null, SPEND_POINTS - 8)],
  firstPurchaseDay: 2,
  sources: [
    { channel: SourceChannel.Genex, players: 500, payers: 25, nex: 3000 },
    { channel: SourceChannel.Campaigns, players: 200, payers: 6, nex: 700 },
    { channel: SourceChannel.Direct, players: 100, payers: 4, nex: 500 },
  ],
});

/** `target` with the value at `path` replaced (undefined reads as a missing part). */
function withAt(target: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  if (Array.isArray(target)) return target.map((item, index) => (index === head ? withAt(item, rest, value) : item));
  return isRecord(target) ? { ...target, [head]: withAt(target[String(head)], rest, value) } : target;
}

describe("the Revenue report as genex.games answers it", () => {
  const read = (data: unknown) => toRevenueReport(data, WINDOW);

  it("reads every part of a well-formed answer as it was sent", () => {
    assert.deepEqual(read(revenueData()), revenueData());
  });

  it("is not a report when a fixed part is missing or is not what it should be", () => {
    const broken: Array<[string, readonly (string | number)[], unknown]> = [
      ["no Nex", ["nex"], undefined],
      ["Nex that is a number", ["nex"], 4200],
      ["Nex as text", ["nex", "now"], "4200"],
      ["negative Nex", ["nex", "now"], -1],
      ["a fraction of a Nex", ["nex", "before"], 3100.5],
      ["Nex that is not finite", ["nex", "now"], Number.POSITIVE_INFINITY],
      ["Nex that is not a number", ["nex", "before"], Number.NaN],
      ["Nex with no period before", ["nex", "before"], undefined],
      ["Nex not known", ["nex", "now"], null],
      ["no purchases", ["purchases"], undefined],
      ["negative purchases", ["purchases", "now"], -3],
      ["half a purchase", ["purchases", "before"], 0.5],
      ["no payers", ["payers"], null],
      ["a fractional payer", ["payers", "now"], 34.5],
      ["no players", ["players"], undefined],
      ["players as a list", ["players"], [800, 640]],
      ["negative players", ["players", "before"], -640],
      ["more payers than players", ["payers", "now"], 801],
      ["more payers than players before", ["players", "before"], 29],
      ["no Nex per player a day", ["nexPerPlayerDay"], undefined],
      ["Nex per player a day that is a number", ["nexPerPlayerDay"], 2.17],
      ["negative Nex per player a day", ["nexPerPlayerDay", "now"], -2.17],
      ["Nex per player a day as text", ["nexPerPlayerDay", "before"], "2.31"],
      ["Nex per player a day with a side missing", ["nexPerPlayerDay", "before"], undefined],
      ["Nex per player a day that is not finite", ["nexPerPlayerDay", "now"], Number.POSITIVE_INFINITY],
      ["no days", ["daily"], undefined],
      ["days that are not a list", ["daily"], { 0: 500 }],
      ["a day short", ["daily"], fill(500, DAYS - 1)],
      ["a day long", ["daily"], fill(500, DAYS + 1)],
      ["the days of another period", ["daily"], fill(500, 30)],
      ["a negative day", ["daily", 3], -640],
      ["a fractional day", ["daily", 0], 500.5],
      ["a day not known", ["daily", 6], null],
      ["a day as text", ["daily", 2], "580"],
      ["no days before", ["dailyBefore"], undefined],
      ["a day before short", ["dailyBefore"], fill(440, DAYS - 1)],
      ["a negative day before", ["dailyBefore", 1], -1],
      ["no items", ["items"], undefined],
      ["items that are not a list", ["items"], { "tip-jar": 800 }],
      ["no spending curve", ["spend"], undefined],
      ["a spending curve that is not a list", ["spend"], "1.1"],
      ["a spending curve too long", ["spend"], fill(1.1, SPEND_POINTS + 1)],
      ["negative spending", ["spend", 1], -1.9],
      ["spending as text", ["spend", 0], "1.1"],
      ["spending that is not finite", ["spend", 2], Number.NaN],
      ["no first purchase day", ["firstPurchaseDay"], undefined],
      ["a negative first purchase day", ["firstPurchaseDay"], -1],
      ["half a first purchase day", ["firstPurchaseDay"], 1.5],
      ["a first purchase day as text", ["firstPurchaseDay"], "2"],
      ["no sources", ["sources"], undefined],
      ["sources that are not a list", ["sources"], { genex: 500 }],
    ];
    for (const [name, path, value] of broken) assert.equal(read(withAt(revenueData(), path, value)), null, name);
    for (const body of [null, undefined, [], "revenue", 4200]) assert.equal(read(body), null, String(body));
  });

  it("holds the days to the period it was asked over", () => {
    const month: AnalyticsWindow = { ...WINDOW, days: 30 };
    assert.equal(toRevenueReport(revenueData(), month), null, "a week's days are not a month's");
    const data = { ...revenueData(), daily: fill(100, 30), dailyBefore: fill(90, 30) };
    assert.equal(toRevenueReport(data, month)?.daily.length, 30);
  });

  it("keeps what cannot be known yet as null, never as zero", () => {
    const report = read(revenueData()) ?? assert.fail();
    assert.equal(report.spend[8], null, "a day that has not passed");
    assert.equal(report.spend.length, SPEND_POINTS);
    assert.equal(report.items[2]?.price, null, "an item with no one price");
    const unknown = {
      ...revenueData(),
      nexPerPlayerDay: { now: null, before: null },
      spend: fill(null, SPEND_POINTS),
      firstPurchaseDay: null,
    };
    const read2 = read(unknown) ?? assert.fail();
    assert.deepEqual(read2.nexPerPlayerDay, { now: null, before: null });
    assert.deepEqual(read2.spend, fill(null, SPEND_POINTS));
    assert.equal(read2.firstPurchaseDay, null);
    const half = read(withAt(revenueData(), ["nexPerPlayerDay", "before"], null)) ?? assert.fail();
    assert.deepEqual(half.nexPerPlayerDay, { now: 2.17, before: null });
  });

  it("reads a game where nothing was bought: zeros that are zeros, empty lists, a curve of any length", () => {
    const nothing: RevenueReport = {
      nex: { now: 0, before: 0 },
      purchases: { now: 0, before: 0 },
      payers: { now: 0, before: 0 },
      players: { now: 12, before: 0 },
      nexPerPlayerDay: { now: 0, before: null },
      daily: fill(0),
      dailyBefore: fill(0),
      items: [],
      spend: [],
      firstPurchaseDay: null,
      sources: [],
    };
    assert.deepEqual(read(nothing), nothing);
    assert.deepEqual(read({ ...nothing, spend: [0, 0, null] })?.spend, [0, 0, null]);
    assert.equal(read({ ...nothing, firstPurchaseDay: 0 })?.firstPurchaseDay, 0, "the first day is a day");
  });

  it("drops the items it cannot trust and keeps the rest, in the order sent", () => {
    const item = (over: object) => ({
      id: "glow-trail",
      name: "Glow trail",
      price: 80,
      sold: 5,
      buyers: 5,
      nex: 400,
      ...over,
    });
    const data = {
      ...revenueData(),
      items: [
        item({ id: " storm‮-skin\u0007 ", name: "‮Storm\u0000 Lantern⁦ skin⁩\n" }),
        item({ id: undefined }),
        item({ id: "" }),
        item({ id: 7 }),
        item({ id: "i".repeat(500) }),
        item({ id: "no-name", name: undefined }),
        item({ id: "blank-name", name: " ‏\u0007 " }),
        item({ id: "long-name", name: "n".repeat(500) }),
        item({ id: "number-name", name: 40 }),
        item({ id: "negative-price", price: -80 }),
        item({ id: "fractional-price", price: 79.99 }),
        item({ id: "text-price", price: "80" }),
        item({ id: "no-price", price: undefined }),
        item({ id: "negative-sold", sold: -5 }),
        item({ id: "fractional-sold", sold: 5.5 }),
        item({ id: "no-sold", sold: undefined }),
        item({ id: "fractional-buyers", buyers: 2.5 }),
        item({ id: "more-buyers-than-sales", buyers: 6 }),
        item({ id: "negative-nex", nex: -400 }),
        item({ id: "fractional-nex", nex: 400.5 }),
        item({ id: "more-nex-than-all", nex: 4201 }),
        item({ id: "infinite-nex", nex: Number.POSITIVE_INFINITY }),
        null,
        "glow-trail",
        ["glow-trail", "Glow trail", 80, 5, 5, 400],
        item({ id: "free", name: "Free hat", price: 0, sold: 3, buyers: 3, nex: 0 }),
        item({ id: "storm-skin", name: "The same id again" }),
        item({ id: "open", name: "Tip jar", price: null }),
      ],
    };
    const report = read(data) ?? assert.fail();
    assert.deepEqual(report.items, [
      { id: "storm-skin", name: "Storm Lantern skin", price: 80, sold: 5, buyers: 5, nex: 400 },
      { id: "free", name: "Free hat", price: 0, sold: 3, buyers: 3, nex: 0 },
      { id: "open", name: "Tip jar", price: null, sold: 5, buyers: 5, nex: 400 },
    ]);
  });

  it("drops the sources it cannot trust and keeps the rest", () => {
    const data = {
      ...revenueData(),
      sources: [
        { channel: "genex", players: 500, payers: 25, nex: 3000 },
        { channel: "telepathy", players: 40, payers: 2, nex: 100 },
        { channel: "genex", players: 1, payers: 1, nex: 1 },
        { channel: "social", players: -2, payers: 0, nex: 0 },
        { channel: "social", players: 20.5, payers: 0, nex: 0 },
        { channel: "campaigns", players: 20, payers: 21, nex: 100 },
        { channel: "campaigns", players: 801, payers: 2, nex: 100 },
        { channel: "campaigns", players: 200, payers: 6, nex: 4201 },
        { channel: "campaigns", players: 200, payers: "6", nex: 700 },
        { channel: "campaigns", players: 200, payers: 6 },
        { channel: SourceChannel.Search, players: 3, payers: 0, nex: 0 },
        { channel: 5, players: 3, payers: 0, nex: 0 },
        null,
        "direct",
      ],
    };
    const report = read(data) ?? assert.fail();
    assert.deepEqual(report.sources, [
      { channel: SourceChannel.Genex, players: 500, payers: 25, nex: 3000 },
      { channel: SourceChannel.Search, players: 3, payers: 0, nex: 0 },
    ]);
  });

  it("keeps no more rows than a page can show", () => {
    const item = (index: number) => ({
      id: `item-${index}`,
      name: `Item ${index}`,
      price: 1,
      sold: 1,
      buyers: 1,
      nex: 1,
    });
    const channels = Object.values(SourceChannel);
    const data = {
      ...revenueData(),
      items: Array.from({ length: 5000 }, (_, index) => item(index)),
      sources: Array.from({ length: 5000 }, (_, index) => ({
        channel: channels[index % channels.length],
        players: 1,
        payers: 0,
        nex: 0,
      })),
    };
    const report = read(data) ?? assert.fail();
    assert.ok(report.items.length <= 100, `${report.items.length} items`);
    assert.equal(report.items[0]?.id, "item-0", "the first ones sent");
    assert.equal(report.sources.length, channels.length, "a channel has one row");
  });
});

const NOW = Date.parse("2026-11-17T12:04:00.000Z");
const author = { id: "fx-simeon-m", name: "Simeon M" };
/** The fixture account's games as its catalog lists them: a steady one, a young one and the rich one. */
const games = [
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
const catalog = { games: (authorId: string) => (authorId === author.id ? games : []) };
const RICH = "skate";
const STEADY = "lost-cathedral";
const YOUNG = "stick-steel";
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
const sampleOf = (slug: string, days: StatsPeriod, account: FixtureAccount = FixtureAccount.Full) => {
  const source = ownSamples(account, catalog).find((game) => game.slug === slug) ?? assert.fail(`no ${slug}`);
  return gameSample(source, days, NOW);
};

describe("a fixture launch's Revenue report", () => {
  /** The report the builder makes for a game. */
  const made = (slug: string, days: StatsPeriod, account: FixtureAccount = FixtureAccount.Full): RevenueReport =>
    fixtureRevenue(sampleOf(slug, days, account), {});
  /** Every game of every fixture account that has some, over every period. */
  const everywhere = [FixtureAccount.Full, FixtureAccount.Quiet, FixtureAccount.Fresh].flatMap((account) =>
    ownSamples(account, catalog).flatMap((game) =>
      STATS_PERIODS.map((days) => ({ account, slug: game.slug, days, name: `${account}/${game.slug}/${days}` })),
    ),
  );

  it("covers the rich, the steady and the young game, and the accounts where nobody plays", () => {
    assert.deepEqual(
      [RICH, STEADY, YOUNG].map((slug) => sampleOf(slug, 30).kind),
      [SampleKind.Rich, SampleKind.Steady, SampleKind.Young],
    );
    assert.equal(everywhere.length, 21, "three games for the full and the quiet account, one for the fresh one");
  });

  it("answers a report the real parser reads exactly as it was made, for every game, period and account", () => {
    const launch = createFixtureGameAnalytics({ now: () => NOW });
    for (const { account, slug, days, name } of everywhere) {
      const query = { slug, report: GameReport.Revenue, days };
      const answer = launch.answer(reportRoute(query), { method: "GET", token: fixtureAccountToken(account) }, catalog);
      assert.equal(answer?.status, 200, name);
      const sent = isRecord(answer?.body) ? answer.body.data : undefined;
      const read = toReportAnswer(answer?.body, query, true) ?? assert.fail(`${name} does not read`);
      assert.equal(read.report, GameReport.Revenue);
      assert.deepEqual(read.data, JSON.parse(JSON.stringify(sent)), `${name} loses nothing`);
      assert.deepEqual(read.data, made(slug, days, account), `${name} is what the builder made`);
    }
  });

  it("repeats the sample's Nex, purchases, payers and players, and its Nex day by day", () => {
    for (const { account, slug, days, name } of everywhere) {
      const sample = sampleOf(slug, days, account);
      const report = made(slug, days, account);
      assert.deepEqual(report.nex, { now: sample.nex.now, before: sample.nex.before }, name);
      assert.deepEqual(report.purchases, sample.purchases, name);
      assert.deepEqual(report.payers, sample.payers, name);
      assert.deepEqual(report.players, { now: sample.players.now, before: sample.players.before }, name);
      assert.deepEqual(report.daily, sample.nex.daily, name);
      assert.deepEqual(report.dailyBefore, sample.nex.dailyBefore, name);
      assert.equal(sum(report.daily), report.nex.now, `${name}: the bars sum to the Nex spent`);
      assert.equal(sum(report.dailyBefore), report.nex.before, name);
    }
  });

  it("gives its richest game the numbers the page was designed with, over 30 days", () => {
    const report = made(RICH, 30);
    assert.deepEqual(
      [report.nex, report.purchases.now, report.payers.now, report.players.now],
      [{ now: 48_610, before: 31_565 }, 837, 412, 9300],
    );
    assert.equal(report.nexPerPlayerDay.now, 2.17);
    assert.deepEqual(report.items, [
      { id: "storm-lantern-skin", name: "Storm Lantern skin", price: 150, sold: 131, buyers: 131, nex: 19_650 },
      { id: "extra-life-pack", name: "Extra life pack", price: 40, sold: 402, buyers: 188, nex: 16_080 },
      { id: "glow-trail", name: "Glow trail", price: 80, sold: 96, buyers: 96, nex: 7680 },
      { id: "level-skip", name: "Level skip", price: 25, sold: 208, buyers: 97, nex: 5200 },
    ]);
    assert.equal(report.spend.length, RETENTION_SPAN + 1);
    assert.deepEqual(
      [0, 1, 7, 30].map((day) => report.spend[day]),
      [1.1, 1.9, 3.6, 5.2],
      "the first day, then by day 1, 7 and 30",
    );
    assert.equal(report.firstPurchaseDay, 2);
    assert.deepEqual(
      report.sources.map((source) => source.channel),
      [
        SourceChannel.Genex,
        SourceChannel.Campaigns,
        SourceChannel.Social,
        SourceChannel.Direct,
        SourceChannel.Search,
        SourceChannel.Other,
      ],
    );
  });

  it("shares the period's purchases and Nex among the items, most Nex first, each priced item at its price", () => {
    const known = ["storm-lantern-skin", "extra-life-pack", "glow-trail", "level-skip", "tip-jar"];
    for (const { account, slug, days, name } of everywhere) {
      const report = made(slug, days, account);
      if (report.purchases.now === 0) {
        assert.deepEqual(report.items, [], `${name}: nothing bought, nothing listed`);
        continue;
      }
      assert.equal(sum(report.items.map((item) => item.sold)), report.purchases.now, `${name}: sold`);
      assert.equal(sum(report.items.map((item) => item.nex)), report.nex.now, `${name}: Nex`);
      for (const item of report.items) {
        assert.ok(known.includes(item.id), `${name}: ${item.id} keeps its id over every period`);
        assert.ok(item.sold > 0, `${name}: ${item.id} was bought`);
        assert.ok(item.nex >= item.sold, `${name}: ${item.id} cost a Nex at least each time`);
        assert.ok(item.buyers >= 1 && item.buyers <= item.sold, `${name}: ${item.id} has a buyer, one a sale at most`);
        assert.ok(item.buyers <= report.payers.now, `${name}: ${item.id}'s buyers are payers`);
        if (item.price !== null)
          assert.equal(item.nex, item.price * item.sold, `${name}: ${item.id} sold at its price`);
      }
      const unpriced = report.items.filter((item) => item.price === null);
      assert.ok(unpriced.length <= 1, `${name}: one tip jar at most`);
      assert.ok(report.items.length - unpriced.length >= 2, `${name}: several of the Store's items sold`);
      assert.deepEqual(
        report.items.map((item) => item.nex),
        report.items.map((item) => item.nex).toSorted((a, b) => b - a),
        name,
      );
    }
    assert.equal(made(RICH, 7).items.at(-1)?.price, null, "a week's Nex is not whole sales: the rest is tips");
  });

  it("shares everyone who played, the payers and the Nex among the channels of the sample", () => {
    for (const { account, slug, days, name } of everywhere) {
      const sample = sampleOf(slug, days, account);
      const { sources, players, payers, nex } = made(slug, days, account);
      assert.equal(sum(sources.map((source) => source.players)), players.now, `${name}: players`);
      assert.equal(sum(sources.map((source) => source.payers)), payers.now, `${name}: payers`);
      assert.equal(sum(sources.map((source) => source.nex)), nex.now, `${name}: Nex`);
      const order = sample.channels.map((channel) => channel.channel);
      assert.deepEqual(
        sources.map((source) => source.channel),
        order.filter((channel) => sources.some((source) => source.channel === channel)),
        `${name}: in the sample's order`,
      );
      for (const source of sources) {
        const fresh = sample.channels.find((channel) => channel.channel === source.channel)?.newPlayers ?? 0;
        assert.ok(source.players >= fresh, `${name}: ${source.channel} holds its new players`);
        assert.ok(source.players > 0, `${name}: ${source.channel} has players`);
        assert.ok(source.payers <= source.players, `${name}: ${source.channel}'s payers are players`);
        assert.ok(source.nex === 0 || source.payers > 0, `${name}: ${source.channel}'s Nex has a payer`);
      }
    }
  });

  it("knows a new player's spending only for the days that have passed", () => {
    const week = made(RICH, 7);
    assert.ok(
      week.spend.slice(0, 8).every((value) => typeof value === "number" && value > 0),
      "the first day and the seven after it",
    );
    assert.deepEqual(week.spend.slice(8), fill(null, RETENTION_SPAN - 7), "day 8 on has not passed");
    assert.deepEqual(week.spend.slice(0, 8), made(RICH, 30).spend.slice(0, 8), "a game's curve is one curve");
    for (const { account, slug, days, name } of everywhere) {
      const known = made(slug, days, account).spend.filter((value): value is number => value !== null);
      assert.deepEqual(
        known,
        known.toSorted((a, b) => a - b),
        `${name}: what is spent adds up, it never falls`,
      );
    }
  });

  it("varies a steady game's own details by its slug, the same on every read", () => {
    const steady = made(STEADY, 30);
    assert.deepEqual(made(STEADY, 30), steady);
    assert.ok(steady.purchases.now > 0, "a steady game sells");
    assert.notDeepEqual(
      steady.items.map((item) => item.sold / steady.purchases.now),
      made(RICH, 30).items.map((item) => item.sold / 837),
    );
    assert.ok(steady.firstPurchaseDay !== null && steady.firstPurchaseDay >= 1 && steady.firstPurchaseDay <= 4);
    assert.ok((steady.nexPerPlayerDay.now ?? 0) > 0);
  });

  it("the young game has nothing bought: zeros where zero is true, null where it cannot be known", () => {
    for (const days of STATS_PERIODS) {
      const report = made(YOUNG, days);
      assert.deepEqual(
        [report.nex, report.purchases, report.payers],
        [
          { now: 0, before: 0 },
          { now: 0, before: 0 },
          { now: 0, before: 0 },
        ],
      );
      assert.ok(report.players.now > 0, "somebody played");
      assert.equal(report.players.before, 0);
      assert.deepEqual(report.nexPerPlayerDay, { now: 0, before: null }, "nobody to divide by before it was published");
      assert.deepEqual(report.items, []);
      assert.equal(report.firstPurchaseDay, null);
      assert.deepEqual(report.spend.slice(0, 3), [0, 0, 0], "two days old: its new players spent nothing so far");
      assert.deepEqual(report.spend.slice(3), fill(null, RETENTION_SPAN - 2));
      assert.ok(report.sources.every((source) => source.payers === 0 && source.nex === 0));
    }
  });

  it("a game nobody played this week has nothing to divide by", () => {
    const quiet = made(RICH, 7, FixtureAccount.Quiet);
    assert.deepEqual([quiet.nex.now, quiet.players.now, quiet.purchases.now], [0, 0, 0]);
    assert.equal(quiet.nexPerPlayerDay.now, null);
    assert.deepEqual(quiet.spend, fill(null, RETENTION_SPAN + 1));
    assert.deepEqual(quiet.sources, []);
    assert.deepEqual(quiet.items, []);
    assert.equal(quiet.nex.before, 0, "nor the week before");
    assert.ok(made(RICH, 30, FixtureAccount.Quiet).nex.now > 0, "it sold earlier in the month");
  });
});

/** What the tests reach in the renderer build: the report, what it derives from an answer, and React's server renderer. */
interface RevenueBundle {
  RevenueReport: (props: ReportProps<typeof GameReport.Revenue>) => ReactElement;
  revenueView: (answer: Pick<ReportAnswer<typeof GameReport.Revenue>, "data" | "window">) => RevenueView;
  createElement: (type: unknown, props: object | null, ...children: unknown[]) => ReactElement;
  renderToStaticMarkup: (element: ReactElement) => string;
}

/** The report as the plain renderer build compiles it. */
async function revenueBundle(): Promise<RevenueBundle> {
  const result = await build({
    stdin: {
      contents: [
        'export { RevenueReport } from "./src/renderer/play/game-analytics/RevenueReport.tsx";',
        'export { revenueView } from "./src/renderer/play/game-analytics/revenue-view.ts";',
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

let building: Promise<RevenueBundle> | undefined;
/** The bundle, built once for the file. */
const bundled = (): Promise<RevenueBundle> => {
  building ??= revenueBundle();
  return building;
};

const MINUS = "−";
const DASH = "—";
/** The bundle reads the same language slot as this file: numbers the English way, whatever the computer's. */
const japanese = (): void => setLocale(Locale.Japanese, {});
const GAME: AnalyticsGame = {
  slug: RICH,
  title: "SKATE",
  coverUrl: null,
  playingNow: 38,
  publishedOn: "2026-04-01",
  version: "1.4.0",
  hasAppBuild: true,
  sdkVersion: "0.38.2",
  eventsReady: true,
};
/** An answer around `data`, over `days`. */
const answerWith = (data: RevenueReport, days: StatsPeriod = DAYS): ReportAnswer<typeof GameReport.Revenue> => ({
  report: GameReport.Revenue,
  game: GAME,
  window: { ...WINDOW, days },
  data,
});
/** The fixture's answer for a game, as the page is handed it. */
const fixtureAnswer = (
  slug: string,
  days: StatsPeriod,
  account: FixtureAccount = FixtureAccount.Full,
): ReportAnswer<typeof GameReport.Revenue> => {
  const sample = sampleOf(slug, days, account);
  return { report: GameReport.Revenue, game: sample.game, window: sample.window, data: fixtureRevenue(sample, {}) };
};
/** A report where nobody played and nothing is known. */
const emptyData = (): RevenueReport => ({
  nex: { now: 0, before: 0 },
  purchases: { now: 0, before: 0 },
  payers: { now: 0, before: 0 },
  players: { now: 0, before: 0 },
  nexPerPlayerDay: { now: null, before: null },
  daily: fill(0),
  dailyBefore: fill(0),
  items: [],
  spend: [],
  firstPurchaseDay: null,
  sources: [],
});

describe("what the Revenue report derives from an answer", () => {
  let view: RevenueBundle["revenueView"];
  before(async () => {
    view = (await bundled()).revenueView;
  });
  beforeEach(japanese);
  after(() => setLocale(Locale.English, {}));

  const tileOf = (made: RevenueView, id: string) => made.tiles.find((tile) => tile.id === id) ?? assert.fail(id);
  const statOf = (made: RevenueView, id: string) => made.spend.stats.find((stat) => stat.id === id) ?? assert.fail(id);

  it("heads the report with what was spent, by how many, and what that is for each of them", () => {
    const made = view(fixtureAnswer(RICH, 30));
    assert.deepEqual(
      made.tiles.map((tile) => [tile.id, tile.label, tile.value, tile.note]),
      [
        ["nexSpent", "Nex spent", "48,610", "in 837 purchases"],
        ["payers", "Paying players", "412", "4.4% of everyone who played"],
        ["nexPerPayer", "Nex per paying player", "118", "2.0 purchases each"],
        ["nexPerPlayerDay", "Nex per player a day", "2.17", "across everyone who played that day"],
      ],
    );
    assert.equal(made.nothingBought, false);
  });

  it("compares each tile with the period before: sums and averages in percent, Nex per player a day in Nex", () => {
    const made = view(fixtureAnswer(RICH, 30));
    const sides = (id: string) => {
      const delta = tileOf(made, id).delta ?? assert.fail(id);
      return [delta.kind, delta.now, delta.before];
    };
    assert.deepEqual(sides("nexSpent"), ["percent", 48_610, 31_565]);
    assert.deepEqual(sides("payers"), ["percent", 412, 248]);
    assert.deepEqual(sides("nexPerPayer"), ["percent", 48_610 / 412, 31_565 / 248], "two counts divided, on each side");
    assert.deepEqual(sides("nexPerPlayerDay"), ["amount", 2.17, 2.34]);
    const perDay = tileOf(made, "nexPerPlayerDay").delta;
    assert.ok(perDay?.kind === "amount");
    assert.equal(perDay.format(-0.14), `${MINUS}0.14`);
    assert.equal(perDay.format(0.031), "+0.03");
  });

  it("counts one purchase as one, and leaves out a note it has nothing to divide for", () => {
    const one = view(answerWith({ ...revenueData(), purchases: { now: 1, before: 0 }, payers: { now: 1, before: 0 } }));
    assert.equal(tileOf(one, "nexSpent").note, "in 1 purchase");
    assert.equal(tileOf(one, "nexPerPayer").note, "1.0 purchases each");
    const nobody = view(answerWith(emptyData()));
    assert.equal(tileOf(nobody, "payers").note, undefined, "nobody played: no share of them paid");
    assert.equal(tileOf(nobody, "nexPerPayer").note, undefined);
  });

  it("shows zero where nothing was bought, and a dash where there is nobody to divide by", () => {
    const young = view(fixtureAnswer(YOUNG, 30));
    assert.equal(young.nothingBought, true);
    assert.match(young.nothing, /^Nobody bought anything in these 30 days\./);
    assert.deepEqual(
      young.tiles.map((tile) => [tile.id, tile.value, tile.note]),
      [
        ["nexSpent", "0", "in 0 purchases"],
        ["payers", "0", "0.0% of everyone who played"],
        ["nexPerPayer", null, undefined],
        ["nexPerPlayerDay", "0", "across everyone who played that day"],
      ],
    );
    const perPayer = tileOf(young, "nexPerPayer").delta;
    assert.deepEqual([perPayer?.now, perPayer?.before], [null, null], "no payer on either side");
    const nobody = view(answerWith(emptyData()));
    assert.equal(nobody.nothingBought, true);
    assert.equal(tileOf(nobody, "nexPerPlayerDay").value, null, "nobody played: not zero Nex each");
  });

  it("still draws the report when Nex was spent in the period, whatever the purchases say", () => {
    assert.equal(view(answerWith(revenueData())).nothingBought, false);
    assert.equal(view(answerWith({ ...revenueData(), purchases: { now: 0, before: 0 } })).nothingBought, false);
  });

  it("draws the Nex of each day of the period, oldest first", () => {
    const made = view(answerWith(revenueData()));
    assert.deepEqual(made.daily.labels.length, DAYS);
    assert.equal(made.daily.series.length, 1);
    assert.deepEqual(made.daily.series[0]?.values, [500, 620, 580, 640, 700, 610, 550]);
    assert.equal(made.daily.series[0]?.label, "Nex spent");
    const month = view(fixtureAnswer(RICH, 30));
    assert.equal(month.daily.labels.length, 30);
    assert.equal(sum(month.daily.series[0]?.values ?? []), 48_610);
  });

  it("lists the items most Nex first, each with its share of all Nex, and sums them from the period's totals", () => {
    const made = view(fixtureAnswer(RICH, 30));
    assert.deepEqual(
      made.items.rows.map((row) => [row.name, row.price, row.sold, row.buyers, row.nex, row.share?.toFixed(3)]),
      [
        ["Storm Lantern skin", 150, 131, 131, 19_650, "0.404"],
        ["Extra life pack", 40, 402, 188, 16_080, "0.331"],
        ["Glow trail", 80, 96, 96, 7680, "0.158"],
        ["Level skip", 25, 208, 97, 5200, "0.107"],
      ],
    );
    assert.deepEqual(made.items.total, {
      id: "total",
      name: "All items",
      price: null,
      sold: 837,
      buyers: 412,
      nex: 48_610,
      share: null,
    });
    const shuffled = view(
      answerWith({
        ...revenueData(),
        items: [
          { id: "a", name: "Cheap", price: 1, sold: 5, buyers: 5, nex: 5 },
          { id: "b", name: "Tied first", price: 10, sold: 5, buyers: 5, nex: 50 },
          { id: "c", name: "Most", price: 100, sold: 5, buyers: 5, nex: 500 },
          { id: "d", name: "Tied second", price: null, sold: 2, buyers: 2, nex: 50 },
        ],
      }),
    );
    assert.deepEqual(
      shuffled.items.rows.map((row) => row.id),
      ["c", "b", "d", "a"],
      "most Nex first, and a tie in the order sent",
    );
    assert.equal(shuffled.items.rows[2]?.price, null, "no one price stays unknown");
    assert.equal(shuffled.items.total.buyers, 35, "buyers of several items are counted once: the period's payers");
  });

  it("gives an item no share when no Nex was spent", () => {
    const free = view(
      answerWith({
        ...revenueData(),
        nex: { now: 0, before: 0 },
        items: [{ id: "hat", name: "Free hat", price: 0, sold: 3, buyers: 3, nex: 0 }],
      }),
    );
    assert.equal(free.items.rows[0]?.share, null);
  });

  it("writes what a new player has spent by day 1, 7 and 30, and the day of the first purchase", () => {
    const made = view(fixtureAnswer(RICH, 30));
    assert.equal(made.spend.known, true);
    assert.deepEqual(
      made.spend.stats.map((stat) => [stat.id, stat.label, stat.value]),
      [
        ["day1", "By day 1", "1.9 Nex"],
        ["day7", "By day 7", "3.6 Nex"],
        ["day30", "By day 30", "5.2 Nex"],
        ["firstPurchase", "First purchase", "Day 2"],
      ],
    );
    assert.equal(made.spend.labels.length, RETENTION_SPAN + 1);
    assert.deepEqual(made.spend.labels.slice(0, 3), ["First day", "Day 1", "Day 2"]);
    assert.equal(made.spend.labels.at(-1), "Day 30");
    assert.deepEqual(made.spend.ticks, [0, 10, 20, 30]);
    assert.equal(made.spend.series.length, 1);
    assert.equal(made.spend.series[0]?.values[0], 1.1);
    assert.equal(
      statOf(view(answerWith({ ...revenueData(), firstPurchaseDay: 0 })), "firstPurchase").value,
      "First day",
    );
  });

  it("leaves the days that have not passed as gaps and dashes, never zero", () => {
    const week = view(fixtureAnswer(RICH, 7));
    assert.equal(statOf(week, "day7").value, "3.6 Nex");
    assert.equal(statOf(week, "day30").value, null);
    assert.deepEqual(week.spend.series[0]?.values.slice(8), fill(null, RETENTION_SPAN - 7));
    const young = view(fixtureAnswer(YOUNG, 30));
    assert.deepEqual(
      young.spend.stats.map((stat) => stat.value),
      ["0 Nex", null, null, null],
      "a true zero by day 1, the rest not known",
    );
  });

  it("says so when the curve knows no day at all, and names no days it does not have", () => {
    const none = view(answerWith(emptyData(), 30));
    assert.equal(none.spend.known, false);
    assert.equal(none.spend.empty, "No new players in these 30 days, so there’s nothing to follow yet.");
    assert.deepEqual(none.spend.labels, []);
    assert.equal(none.spend.ticks, undefined);
    assert.deepEqual(
      none.spend.stats.map((stat) => stat.value),
      [null, null, null, null],
    );
    const unripe = view(answerWith({ ...revenueData(), spend: fill(null, RETENTION_SPAN + 1) }));
    assert.equal(unripe.spend.known, false);
    const short = view(answerWith({ ...revenueData(), spend: [0.4, 0.9, 1.2] }));
    assert.equal(short.spend.known, true);
    assert.equal(short.spend.ticks, undefined, "three days: the chart names its own");
    assert.deepEqual(
      short.spend.stats.map((stat) => stat.value),
      ["0.9 Nex", null, null, "Day 2"],
    );
  });

  it("names each source's channel and divides its counts: the share who pay and the Nex for each player", () => {
    const made = view(answerWith(revenueData()));
    assert.deepEqual(made.sources.rows, [
      { id: "genex", name: "Genex", players: 500, payers: 25, paying: 0.05, nex: 3000, nexEach: 6 },
      { id: "campaigns", name: "Campaigns", players: 200, payers: 6, paying: 0.03, nex: 700, nexEach: 3.5 },
      { id: "direct", name: "Direct", players: 100, payers: 4, paying: 0.04, nex: 500, nexEach: 5 },
    ]);
    assert.deepEqual(
      made.sources.total,
      { id: "total", name: "All players", players: 800, payers: 35, paying: 35 / 800, nex: 4200, nexEach: 5.25 },
      "everyone who played, whichever rows were sent",
    );
    const names = view(
      answerWith({
        ...revenueData(),
        sources: Object.values(SourceChannel).map((channel) => ({ channel, players: 0, payers: 0, nex: 0 })),
      }),
    );
    assert.deepEqual(
      names.sources.rows.map((row) => row.name),
      ["Genex", "Campaigns", "Social", "Direct", "Search engines", "Other sites"],
    );
    assert.ok(
      names.sources.rows.every((row) => row.paying === null && row.nexEach === null),
      "a channel with no players has no share and no average",
    );
    const nobody = view(answerWith(emptyData()));
    assert.deepEqual([nobody.sources.total.paying, nobody.sources.total.nexEach], [null, null]);
  });
});

describe("the Revenue report's face", () => {
  let bundle: RevenueBundle;
  before(async () => {
    bundle = await bundled();
  });
  beforeEach(japanese);
  after(() => setLocale(Locale.English, {}));

  /** The report as markup. */
  const draw = (answer: ReportAnswer<typeof GameReport.Revenue>): string =>
    bundle.renderToStaticMarkup(
      bundle.createElement(bundle.RevenueReport, {
        slug: answer.game.slug,
        refreshing: false,
        stale: false,
        now: NOW,
        onOpenTab: () => {},
        answer,
        options: {},
        onOptions: () => {},
      } satisfies ReportProps<typeof GameReport.Revenue>),
    );
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
  /** Every value of the attribute `name` in `markup`, in order. */
  const values = (markup: string, name: string): string[] =>
    [...markup.matchAll(new RegExp(`${name}="([^"]*)"`, "g"))].map((match) => match[1] ?? "");
  /** The markup of the section `id`, up to the next section. */
  const section = (markup: string, id: string): string =>
    new RegExp(`<section[^>]*data-game-analytics-section="${id}".*?</section>`).exec(markup)?.[0] ?? "";
  /** The cells of the table row `id` inside `markup`, as words. */
  const cellsOf = (markup: string, id: string): string[] => {
    const row = new RegExp(`<div role="row"[^>]*data-game-analytics-row="${id}".*?</div>`).exec(markup);
    return (row?.[0].match(/<span role="cell"[^>]*>.*?(?=<span role="cell"|$)/g) ?? []).map(words);
  };
  /** The words of the tile `id`. */
  const tile = (markup: string, id: string): string =>
    words(
      new RegExp(`<div[^>]*data-game-analytics-tile="${id}".*?(?=<div[^>]*data-game-analytics-tile|</div></div>)`).exec(
        markup,
      )?.[0] ?? "",
    );

  it("is the Revenue report: four tiles, then the days, what is bought, a new player's spending and the sources", () => {
    const markup = draw(fixtureAnswer(RICH, 30));
    assert.match(markup, /^<div class="game-analytics-report" data-game-analytics-report="revenue">/);
    assert.deepEqual(values(markup, "data-game-analytics-tile"), [
      "nexSpent",
      "payers",
      "nexPerPayer",
      "nexPerPlayerDay",
    ]);
    assert.deepEqual(values(markup, "data-game-analytics-section"), ["daily", "items", "spend", "sources"]);
    assert.deepEqual(values(markup, "data-game-analytics-chart"), ["nexPerDay", "spend"]);
    assert.deepEqual(values(markup, "data-game-analytics-table"), ["items", "sources"]);
    assert.deepEqual(values(markup, "data-game-analytics-stat"), ["day1", "day7", "day30", "firstPurchase"]);
    assert.doesNotMatch(markup, /data-game-analytics-empty/, "nothing is missing");
    assert.doesNotMatch(markup, /<button/, "it only shows: the page's controls are the shell's");
  });

  it("writes the tiles as the design has them, each change with its sign", () => {
    const markup = draw(fixtureAnswer(RICH, 30));
    assert.equal(tile(markup, "nexSpent"), "Nex spent 48,610 +54% in 837 purchases");
    assert.equal(tile(markup, "payers"), "Paying players 412 +66% 4.4% of everyone who played");
    assert.equal(tile(markup, "nexPerPayer"), `Nex per paying player 118 ${MINUS}7% 2.0 purchases each`);
    assert.equal(
      tile(markup, "nexPerPlayerDay"),
      `Nex per player a day 2.17 ${MINUS}0.17 across everyone who played that day`,
    );
  });

  it("draws the Nex of each day as bars on a canvas, with a table that says the same", () => {
    const daily = section(draw(fixtureAnswer(RICH, 30)), "daily");
    assert.match(daily, /<h2[^>]*>Nex spent per day<\/h2>/);
    assert.match(daily, /data-chart="bar"/);
    assert.match(daily, /<div class="game-analytics-plot" role="img" aria-label="Nex spent per day" tabindex="0">/);
    assert.match(daily, /<canvas[^>]*aria-hidden="true"/);
    const rows = daily.match(/<tr><th scope="row">.*?<\/tr>/g) ?? [];
    assert.equal(rows.length, 30, "a row a day");
    const sample = sampleOf(RICH, 30);
    assert.equal(words(rows[0] ?? ""), `10月19日 ${(sample.nex.daily[0] ?? 0).toLocaleString("en")}`);
    assert.equal(words(rows[29] ?? ""), `11月17日 ${(sample.nex.daily[29] ?? 0).toLocaleString("en")}`);
  });

  it("lists what players buy in a table, an item's name kept out of replays, with a total row", () => {
    const items = section(draw(fixtureAnswer(RICH, 30)), "items");
    assert.match(items, /<h2[^>]*>What players buy<\/h2>/);
    assert.match(items, /<div role="table" aria-label="Items sold"/);
    assert.deepEqual((items.match(/<span role="columnheader"[^>]*>.*?<\/span>/g) ?? []).map(words), [
      "Item",
      "Price",
      "Sold",
      "Buyers",
      "Nex",
      "Share of Nex",
    ]);
    assert.deepEqual(values(items, "data-game-analytics-row"), [
      "storm-lantern-skin",
      "extra-life-pack",
      "glow-trail",
      "level-skip",
      "total",
    ]);
    assert.deepEqual(cellsOf(items, "storm-lantern-skin"), [
      "Storm Lantern skin",
      "150",
      "131",
      "131",
      "19,650",
      "40.4%",
    ]);
    assert.deepEqual(cellsOf(items, "level-skip"), ["Level skip", "25", "208", "97", "5,200", "10.7%"]);
    assert.deepEqual(cellsOf(items, "total"), ["All items", "", "837", "412", "48,610", ""]);
    assert.match(items, /data-game-analytics-row="total"[^>]*data-total="true"/);
    assert.ok(
      items.includes(
        '<span class="game-analytics-cell-text" title="Storm Lantern skin" data-analytics-mask="true">Storm Lantern skin</span>',
      ),
    );
  });

  it("dashes the price of an item that has no one price, and keeps hostile names as text", () => {
    const week = section(draw(fixtureAnswer(RICH, 7)), "items");
    const jar = cellsOf(week, "tip-jar");
    assert.deepEqual(jar.slice(0, 2), ["Tip jar", DASH]);
    const hostile = draw(
      answerWith({
        ...revenueData(),
        items: [{ id: "x", name: '<img src=x onerror="alert(1)">', price: 5, sold: 1, buyers: 1, nex: 5 }],
      }),
    );
    assert.doesNotMatch(hostile, /<img/);
    assert.equal(cellsOf(section(hostile, "items"), "x")[0], '<img src=x onerror="alert(1)">'.replace(/"/g, "&quot;"));
  });

  it("draws what a new player spends over time: the small numbers, then the curve with its table", () => {
    const spend = section(draw(fixtureAnswer(RICH, 30)), "spend");
    assert.match(spend, /<h2[^>]*>What a new player spends over time<\/h2>/);
    assert.equal(
      words(/<dl class="game-analytics-ministats">.*?<\/dl>/.exec(spend)?.[0] ?? ""),
      "By day 1 1.9 Nex By day 7 3.6 Nex By day 30 5.2 Nex First purchase Day 2",
    );
    assert.match(spend, /data-chart="line"/);
    assert.match(spend, /role="img" aria-label="Nex a new player has spent by each day since their first play"/);
    const rows = (spend.match(/<tr><th scope="row">.*?<\/tr>/g) ?? []).map(words);
    assert.equal(rows.length, RETENTION_SPAN + 1);
    assert.deepEqual([rows[0], rows[7], rows[30]], ["First day 1.1", "Day 7 3.6", "Day 30 5.2"]);
    assert.match(spend, /<th scope="col">Days since the first play<\/th><th scope="col">Nex per new player<\/th>/);
  });

  it("leaves a day that has not passed empty in the curve's table and a dash over it", () => {
    const spend = section(draw(fixtureAnswer(RICH, 7)), "spend");
    const rows = (spend.match(/<tr><th scope="row">.*?<\/tr>/g) ?? []).map(words);
    assert.deepEqual([rows[7], rows[8], rows[30]], ["Day 7 3.6", "Day 8", "Day 30"]);
    assert.equal(
      words(/<dl class="game-analytics-ministats">.*?<\/dl>/.exec(spend)?.[0] ?? ""),
      `By day 1 1.9 Nex By day 7 3.6 Nex By day 30 ${DASH} First purchase Day 2`,
    );
  });

  it("lists the sources that bring players who pay, with a total row, a hint and what is counted", () => {
    const sources = section(draw(fixtureAnswer(RICH, 30)), "sources");
    assert.match(sources, /<h2[^>]*>Which sources bring players who pay<\/h2>/);
    assert.match(sources, /<p class="game-analytics-section-hint">By the first source that brought each player<\/p>/);
    assert.match(sources, /<div role="table" aria-label="Spending by first source"/);
    assert.deepEqual((sources.match(/<span role="columnheader"[^>]*>.*?<\/span>/g) ?? []).map(words), [
      "Source",
      "Players",
      "Paying",
      "Share paying",
      "Nex",
      "Nex per player",
    ]);
    assert.deepEqual(values(sources, "data-game-analytics-row"), [
      "genex",
      "campaigns",
      "social",
      "direct",
      "search",
      "other",
      "total",
    ]);
    assert.deepEqual(cellsOf(sources, "genex"), ["Genex", "4,496", "236", "5.2%", "26,595", "5.92"]);
    assert.deepEqual(cellsOf(sources, "search"), ["Search engines", "201", "6", "3.0%", "759", "3.78"]);
    assert.deepEqual(cellsOf(sources, "total"), ["All players", "9,300", "412", "4.4%", "48,610", "5.23"]);
    const plain = section(draw(answerWith(revenueData())), "sources");
    assert.deepEqual(
      [cellsOf(plain, "genex").at(-1), cellsOf(plain, "campaigns").at(-1)],
      ["6.00", "3.50"],
      "Nex per player keeps two decimals, as on every tab",
    );
    assert.equal(
      words(/<p class="game-analytics-section-footnote">.*?<\/p>/.exec(sources)?.[0] ?? ""),
      "Counts Nex spent in this game through its Store and the SDK’s purchases. Refunded purchases are taken out.",
    );
    assert.doesNotMatch(sources, /data-analytics-mask/, "a channel's name is the app's own word");
  });

  it("a young game where nothing was bought: the tiles at zero and one note, no empty chart or table", () => {
    const markup = draw(fixtureAnswer(YOUNG, 30));
    assert.deepEqual(values(markup, "data-game-analytics-tile"), [
      "nexSpent",
      "payers",
      "nexPerPayer",
      "nexPerPlayerDay",
    ]);
    assert.equal(tile(markup, "nexSpent"), `Nex spent 0 ${DASH} in 0 purchases`);
    assert.equal(tile(markup, "payers"), `Paying players 0 ${DASH} 0.0% of everyone who played`);
    assert.equal(tile(markup, "nexPerPayer"), `Nex per paying player ${DASH} ${DASH}`);
    assert.equal(tile(markup, "nexPerPlayerDay"), `Nex per player a day 0 ${DASH} across everyone who played that day`);
    assert.equal(values(markup, "data-game-analytics-empty").length, 1, "one note");
    assert.match(
      markup,
      /<p class="game-analytics-empty" data-game-analytics-empty="true">Nobody bought anything in these 30 days\. Nex spent in this game’s Store or through the SDK’s purchases shows up here\.<\/p>/,
    );
    for (const absent of ["section", "chart", "table", "stat"])
      assert.deepEqual(values(markup, `data-game-analytics-${absent}`), [], absent);
    assert.doesNotMatch(markup, /<canvas/);
  });

  it("an answer with nobody in it: dashes where there is nobody to divide by, and the same one note", () => {
    const markup = draw(answerWith(emptyData()));
    assert.equal(tile(markup, "payers"), `Paying players 0 ${DASH}`);
    assert.equal(
      tile(markup, "nexPerPlayerDay"),
      `Nex per player a day ${DASH} ${DASH} across everyone who played that day`,
    );
    assert.equal(values(markup, "data-game-analytics-empty").length, 1);
    assert.match(markup, /Nobody bought anything in these 7 days\./);
    assert.deepEqual(values(markup, "data-game-analytics-section"), []);
  });

  it("Nex spent but no rows and no curve yet: each block says so in place of an empty table or chart", () => {
    const markup = draw(answerWith({ ...revenueData(), items: [], sources: [], spend: [], firstPurchaseDay: null }, 7));
    assert.deepEqual(values(markup, "data-game-analytics-section"), ["daily", "items", "spend", "sources"]);
    assert.deepEqual(values(markup, "data-game-analytics-chart"), ["nexPerDay"]);
    assert.deepEqual(values(markup, "data-game-analytics-table"), []);
    assert.deepEqual(values(markup, "data-game-analytics-stat"), []);
    assert.equal(
      words(/<p class="game-analytics-empty"[^>]*>.*?<\/p>/.exec(section(markup, "items"))?.[0] ?? ""),
      "No items to show yet.",
    );
    assert.equal(
      words(/<p class="game-analytics-empty"[^>]*>.*?<\/p>/.exec(section(markup, "spend"))?.[0] ?? ""),
      "No new players in these 7 days, so there’s nothing to follow yet.",
    );
    assert.equal(
      words(/<p class="game-analytics-empty"[^>]*>.*?<\/p>/.exec(section(markup, "sources"))?.[0] ?? ""),
      "No sources to show yet.",
    );
    assert.match(section(markup, "sources"), /Refunded purchases are taken out\./, "what is counted is still said");
  });

  it("keeps a long item name on its row with the whole of it a hover away, and fifty items in the order of their Nex", () => {
    const long = "An extremely long item name that a creator typed without a thought for any table ".repeat(2).trim();
    const items = Array.from({ length: 50 }, (_, index) => ({
      id: `item-${index}`,
      name: index === 0 ? long : `Item ${index}`,
      price: 1,
      sold: 1,
      buyers: 1,
      nex: index + 1,
    }));
    const markup = section(draw(answerWith({ ...revenueData(), items })), "items");
    const rows = values(markup, "data-game-analytics-row");
    assert.equal(rows.length, 51);
    assert.deepEqual(rows.slice(0, 2), ["item-49", "item-48"]);
    assert.ok(markup.includes(`title="${long}"`));
  });
});
