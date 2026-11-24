/**
 * The Engagement report of a game's analytics, end to end: how main reads genex.games' answer (a
 * broken answer is refused, a number that cannot be known stays null, a bad row is left out), what a
 * fixture launch answers for every game and period (made from the game's sample, so it agrees with
 * the other reports), what the page derives from the numbers to show them, and the report's face as
 * React's server renderer draws it from the plain renderer build.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { build } from "esbuild";
import type { ReactElement } from "react";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { fixtureEngagement } from "../../src/main/dev/fixture-game-analytics/fixture-engagement.ts";
import { createFixtureGameAnalytics } from "../../src/main/dev/fixture-game-analytics/index.ts";
import { gameSample, ownSamples, SampleKind } from "../../src/main/dev/fixture-game-analytics/sample.ts";
import { FixtureAccount, fixtureAccountToken } from "../../src/main/dev/fixture-people.ts";
import { isRecord } from "../../src/main/play/gallery.ts";
import { toEngagementReport } from "../../src/main/play/game-analytics/report-engagement.ts";
import { toReportAnswer } from "../../src/main/play/game-analytics/reports.ts";
import { reportRoute } from "../../src/main/play/game-analytics/routes.ts";
import {
  type AnalyticsWindow,
  type EngagementReport,
  GameReport,
  InsightKind,
  type RunNumbers,
  WEEK_HOURS,
} from "../../src/shared/game-analytics.ts";
import { setLocale } from "../../src/shared/i18n.ts";
import { Locale } from "../../src/shared/locale.ts";
import { STATS_PERIODS, type StatsPeriod } from "../../src/shared/play-stats.ts";
import {
  DASH,
  formatCompact,
  formatDayTime,
  formatHour,
  formatPercent,
  weekdayName,
} from "../../src/renderer/play/game-analytics/kit/format.ts";
import type { ReportAnswer, ReportProps } from "../../src/renderer/play/game-analytics/report-props.ts";

const WINDOW: AnalyticsWindow = { days: 30, endsOn: "2026-11-17", computedAt: "2026-11-17T12:00:00.000Z" };
const fill = <T>(value: T, length: number): T[] => Array.from({ length }, () => value);
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

const RUN: RunNumbers = {
  started: 33_800,
  loadSeconds: 3.8,
  loadSecondsP90: 11.2,
  loaded: 0.914,
  smooth: 0.933,
  fps: 55,
  clean: 0.989,
};
const NOTHING_RAN: RunNumbers = {
  started: 0,
  loadSeconds: null,
  loadSecondsP90: null,
  loaded: null,
  smooth: null,
  fps: null,
  clean: null,
};

/** An Engagement report as genex.games answers it, every part of it well formed. */
const engagementData = (): EngagementReport => ({
  plays: { now: 30_889, before: 18_386 },
  playsPerPlayerDay: { now: 1.38, before: 1.364 },
  medianPlaySeconds: { now: 340, before: 318 },
  p90PlaySeconds: 1860,
  playSeconds: { now: 16_063_200, before: 9_389_700.5 },
  playSecondsPerPlayerDay: { now: 717.7, before: 696.5 },
  quickExits: { now: 0.098, before: 0.11 },
  peak: { now: 212, before: 88 },
  peakAt: "2026-11-07T20:00:00.000Z",
  dailyPlayers: { now: 746.1, before: 449.4 },
  monthlyPlayers: { now: 9300, before: 5602 },
  lengths: [
    { length: "under_10s", plays: 3027 },
    { length: "under_1m", plays: 4510 },
    { length: "under_3m", plays: 5529 },
    { length: "under_10m", plays: 8124 },
    { length: "under_30m", plays: 6518 },
    { length: "over_30m", plays: 3181 },
  ],
  daysAWeek: [3200, 1050, 550, 280, 170, 110, 160],
  hours: fill(180, WEEK_HOURS),
  hoursLocal: fill(184, WEEK_HOURS),
  levels: [
    { level: "1", started: 7410, finished: 6743, tries: 1, seconds: 48 },
    { level: "2", started: 6600, finished: 5483, tries: 1.5, seconds: 74.5 },
    { level: "3", started: 5400, finished: 4520, tries: null, seconds: null },
  ],
  run: RUN,
  runBefore: { ...RUN, started: 19_900, loadSeconds: 3.1, loaded: 0.925 },
  runSince: "1.4.0",
  devices: [
    { device: "computer", run: { ...RUN, started: 18_839, loadSeconds: 2.9, loaded: 0.951 } },
    { device: "phone", run: { ...RUN, started: 13_290, loadSeconds: 6.1, loaded: 0.86 } },
    { device: "tablet", run: NOTHING_RAN },
  ],
});

/** `target` with the value at `path` replaced (undefined reads as a missing part). */
function withAt(target: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  if (Array.isArray(target)) return target.map((item, index) => (index === head ? withAt(item, rest, value) : item));
  return isRecord(target) ? { ...target, [head]: withAt(target[String(head)], rest, value) } : target;
}

describe("the Engagement report as main reads it", () => {
  const read = (data: unknown) => toEngagementReport(data, WINDOW);

  it("reads every part of a well-formed answer as it was sent", () => {
    assert.deepEqual(read(engagementData()), engagementData());
  });

  it("is not a report when a fixed part is missing or a number is not what it should be", () => {
    const broken: Array<[string, readonly (string | number)[], unknown]> = [
      ["no plays", ["plays"], undefined],
      ["plays that are a number", ["plays"], 30_889],
      ["a count as text", ["plays", "now"], "30889"],
      ["a negative count", ["plays", "before"], -1],
      ["a fractional count", ["plays", "now"], 30_889.5],
      ["a count that is not finite", ["plays", "now"], Number.POSITIVE_INFINITY],
      ["a count that is null", ["plays", "now"], null],
      ["no plays per player", ["playsPerPlayerDay"], undefined],
      ["a negative average", ["playsPerPlayerDay", "now"], -1.38],
      ["an average that is not a number", ["playsPerPlayerDay", "before"], Number.NaN],
      ["a missing side of a measure", ["medianPlaySeconds", "before"], undefined],
      ["a median as text", ["medianPlaySeconds", "now"], "5m 40s"],
      ["no 90th percentile", ["p90PlaySeconds"], undefined],
      ["a negative 90th percentile", ["p90PlaySeconds"], -1860],
      ["a 90th percentile as text", ["p90PlaySeconds"], "31m"],
      ["no play time", ["playSeconds"], undefined],
      ["negative play time", ["playSeconds", "now"], -1],
      ["no play time per player", ["playSecondsPerPlayerDay"], null],
      ["a rate above one", ["quickExits", "now"], 9.8],
      ["a negative rate", ["quickExits", "before"], -0.01],
      ["a rate as text", ["quickExits", "now"], "9.8%"],
      ["no peak", ["peak"], undefined],
      ["a fractional peak", ["peak", "now"], 212.4],
      ["no peak hour", ["peakAt"], undefined],
      ["a peak hour that is a day", ["peakAt"], "2026-11-07"],
      ["a peak hour that is a number", ["peakAt"], 1_794_000_000_000],
      ["a peak hour with no zone", ["peakAt"], "2026-11-07T20:00:00"],
      ["no daily players", ["dailyPlayers"], undefined],
      ["negative daily players", ["dailyPlayers", "now"], -3],
      ["no monthly players", ["monthlyPlayers"], undefined],
      ["fractional monthly players", ["monthlyPlayers", "now"], 9300.5],
      ["no lengths", ["lengths"], undefined],
      ["lengths that are not a list", ["lengths"], { under_10s: 3027 }],
      ["no days a week", ["daysAWeek"], undefined],
      ["six days a week", ["daysAWeek"], fill(10, 6)],
      ["eight days a week", ["daysAWeek"], fill(10, 8)],
      ["a negative day of the week", ["daysAWeek", 3], -1],
      ["a fractional day of the week", ["daysAWeek", 0], 0.58],
      ["days a week that are not a list", ["daysAWeek"], "58%"],
      ["no hours", ["hours"], undefined],
      ["a day of hours", ["hours"], fill(180, 24)],
      ["an hour short", ["hours"], fill(180, WEEK_HOURS - 1)],
      ["an hour long", ["hours"], fill(180, WEEK_HOURS + 1)],
      ["a negative hour", ["hours", 100], -1],
      ["a fractional hour", ["hours", 0], 1.5],
      ["an hour that is null", ["hours", 5], null],
      ["no players' hours", ["hoursLocal"], undefined],
      ["players' hours an hour short", ["hoursLocal"], fill(184, WEEK_HOURS - 1)],
      ["a player's hour as text", ["hoursLocal", 167], "184"],
      ["no levels", ["levels"], undefined],
      ["levels that are not a list", ["levels"], { 1: 6743 }],
      ["no run", ["run"], undefined],
      ["a run that is a list", ["run"], []],
      ["a run with no started plays", ["run", "started"], undefined],
      ["a run with fractional started plays", ["run", "started"], 33_800.5],
      ["a negative load time", ["run", "loadSeconds"], -3.8],
      ["a load time as text", ["run", "loadSecondsP90"], "11.2 s"],
      ["a loaded share above one", ["run", "loaded"], 91.4],
      ["a smooth share below zero", ["run", "smooth"], -0.1],
      ["negative frames a second", ["run", "fps"], -55],
      ["a clean share as text", ["run", "clean"], "98.9%"],
      ["a missing run number", ["run", "clean"], undefined],
      ["no run before", ["runBefore"], undefined],
      ["a run before with a rate above one", ["runBefore", "loaded"], 1.2],
      ["no version of the change", ["runSince"], undefined],
      ["a version that is a number", ["runSince"], 1.4],
      ["no devices", ["devices"], undefined],
      ["devices that are not a list", ["devices"], "phone"],
    ];
    for (const [name, path, value] of broken) assert.equal(read(withAt(engagementData(), path, value)), null, name);
    for (const body of [null, undefined, [], "engagement", 7, {}]) assert.equal(read(body), null);
  });

  it("keeps what cannot be known yet as null, never as zero", () => {
    const data = {
      ...engagementData(),
      playsPerPlayerDay: { now: null, before: null },
      medianPlaySeconds: { now: 95, before: null },
      p90PlaySeconds: null,
      playSecondsPerPlayerDay: { now: null, before: 600 },
      quickExits: { now: null, before: null },
      peakAt: null,
      dailyPlayers: { now: 4.5, before: null },
      hoursLocal: null,
      levels: null,
      run: { ...RUN, loadSecondsP90: null, fps: null },
      runBefore: NOTHING_RAN,
      runSince: null,
    };
    const report = read(data) ?? assert.fail("a report with nulls is still a report");
    assert.deepEqual(report, data);
    assert.equal(report.quickExits.now, null);
    assert.equal(report.medianPlaySeconds.before, null);
    assert.equal(report.hoursLocal, null);
    assert.equal(report.levels, null, "no level events is not an empty list");
    assert.deepEqual(report.runBefore, NOTHING_RAN);
    assert.deepEqual(report.devices[2], { device: "tablet", run: NOTHING_RAN });
    const noLevelsYet = read({ ...engagementData(), levels: [] }) ?? assert.fail();
    assert.deepEqual(noLevelsYet.levels, [], "level events with nobody in the period is an empty list");
  });

  it("drops the rows it cannot trust and keeps the rest", () => {
    const data = {
      ...engagementData(),
      lengths: [
        { length: "under_10s", plays: 3027 },
        { length: "under_2s", plays: 900 },
        { length: "under_10s", plays: 1 },
        { length: "under_1m", plays: -4 },
        { length: "under_3m", plays: 5529.5 },
        { length: "under_10m", plays: "8124" },
        "under_30m",
        null,
        { length: "over_30m", plays: 3181 },
      ],
      levels: [
        { level: " 1‮\u0007 ", started: 7410, finished: 6743, tries: 1, seconds: 48 },
        { level: "1", started: 1, finished: 1, tries: 1, seconds: 1 },
        { level: "2", started: -1, finished: 5483, tries: 1, seconds: 74 },
        { level: "3", started: 5400, finished: 4520.5, tries: 1, seconds: 92 },
        { level: "4", started: 4400, finished: 2816, tries: -4, seconds: 221 },
        { level: "5", started: 2700, finished: 2297, tries: 2, seconds: "2:05" },
        { level: "", started: 2000, finished: 1778, tries: 2, seconds: 140 },
        { level: "‮‏", started: 2000, finished: 1778, tries: 2, seconds: 140 },
        { level: "L".repeat(500), started: 1700, finished: 1408, tries: 3, seconds: 168 },
        { level: 8, started: 1300, finished: 889, tries: 3, seconds: 190 },
        { started: 1300, finished: 889, tries: 3, seconds: 190 },
        "9",
        { level: "boss", started: 800, finished: 412, tries: null, seconds: null },
      ],
      devices: [
        { device: "computer", run: RUN },
        { device: "fridge", run: RUN },
        { device: "computer", run: NOTHING_RAN },
        { device: "phone", run: { ...RUN, loaded: 86 } },
        { device: "phone" },
        { run: RUN },
        null,
        { device: "tablet", run: NOTHING_RAN },
      ],
    };
    const report = read(data) ?? assert.fail();
    assert.deepEqual(report.lengths, [
      { length: "under_10s", plays: 3027 },
      { length: "over_30m", plays: 3181 },
    ]);
    assert.deepEqual(report.levels, [
      { level: "1", started: 7410, finished: 6743, tries: 1, seconds: 48 },
      { level: "boss", started: 800, finished: 412, tries: null, seconds: null },
    ]);
    assert.deepEqual(report.devices, [
      { device: "computer", run: RUN },
      { device: "tablet", run: NOTHING_RAN },
    ]);
  });

  it("names the version of a change in clean words, and no version when the text is not one", () => {
    const since = (value: unknown) => read({ ...engagementData(), runSince: value })?.runSince;
    assert.equal(since(" 1.4.0‮\u0000 "), "1.4.0");
    assert.equal(since(""), null);
    assert.equal(since("‮"), null);
    assert.equal(since("v".repeat(500)), null, "a version too long to show is no version, not a broken report");
    assert.equal(since(null), null);
  });

  it("keeps no more rows than a page can show", () => {
    const level = (index: number) => ({ level: `L${index}`, started: 10, finished: 5, tries: 1, seconds: 30 });
    const data = {
      ...engagementData(),
      levels: Array.from({ length: 5000 }, (_, index) => level(index)),
      lengths: [...engagementData().lengths, ...fill({ length: "over_30m", plays: 1 }, 5000)],
      devices: fill({ device: "phone", run: RUN }, 5000),
    };
    const report = read(data) ?? assert.fail();
    assert.ok((report.levels?.length ?? 0) <= 60, `${report.levels?.length} levels`);
    assert.equal(report.levels?.[0]?.level, "L0", "the first ones sent");
    assert.equal(report.lengths.length, 6);
    assert.equal(sum(report.lengths.map((bucket) => bucket.plays)), 30_889);
    assert.equal(report.devices.length, 1);
  });
});

describe("the fixture account's Engagement report", () => {
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
  const RICH = "skate";
  const STEADY = "lost-cathedral";
  const YOUNG = "stick-steel";
  const sampleOf = (slug: string, days: StatsPeriod, account: FixtureAccount = FixtureAccount.Full) => {
    const source = ownSamples(account, catalog).find((game) => game.slug === slug) ?? assert.fail(`no ${slug}`);
    return gameSample(source, days, NOW);
  };
  /** The fixture's Engagement for a game as it was sent, and as the real parser reads it. */
  const engagementOf = (slug: string, days: StatsPeriod, account: FixtureAccount = FixtureAccount.Full) => {
    const query = { slug, report: GameReport.Engagement, days };
    const token = fixtureAccountToken(account);
    const answer = createFixtureGameAnalytics({ now: () => NOW }).answer(
      reportRoute(query),
      { method: "GET", token },
      catalog,
    );
    const name = `${slug} over ${days} days for ${account}`;
    assert.equal(answer?.status, 200, name);
    const read = toReportAnswer(answer?.body, query, true) ?? assert.fail(`${name} does not read`);
    if (read.report !== GameReport.Engagement) assert.fail(`${name} is another report`);
    return { data: read.data, sent: isRecord(answer?.body) ? answer.body.data : undefined, name };
  };
  /** Monday-first weekday of a UTC day. */
  const weekdayOf = (day: string): number => (new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7;
  /** The plays a group's run numbers stand for: the started ones that loaded. */
  const loadedPlays = (run: RunNumbers): number => Math.round(run.started * (run.loaded ?? 0));
  const everyGame = (check: (slug: string, days: StatsPeriod, account: FixtureAccount) => void): void => {
    for (const account of [FixtureAccount.Full, FixtureAccount.Quiet])
      for (const { slug } of items) for (const days of STATS_PERIODS) check(slug, days, account);
  };

  it("answers an Engagement the real parser reads, for every game, period and kind, exactly as it was made", () => {
    assert.deepEqual(
      [RICH, STEADY, YOUNG].map((slug) => sampleOf(slug, 30).kind),
      [SampleKind.Rich, SampleKind.Steady, SampleKind.Young],
    );
    everyGame((slug, days, account) => {
      const { data, sent, name } = engagementOf(slug, days, account);
      assert.deepEqual(data, JSON.parse(JSON.stringify(sent)), `${name} loses nothing`);
      assert.equal(data.lengths.length, 6, name);
      assert.equal(data.devices.length, 3, name);
    });
    const fresh = engagementOf(STEADY, 7, FixtureAccount.Fresh);
    assert.deepEqual(fresh.data, JSON.parse(JSON.stringify(fresh.sent)));
  });

  it("repeats the sample's numbers, and its own parts sum to them", () => {
    everyGame((slug, days, account) => {
      const sample = sampleOf(slug, days, account);
      const { data, name } = engagementOf(slug, days, account);
      assert.deepEqual(data.plays, { now: sample.plays.now, before: sample.plays.before }, name);
      assert.deepEqual(
        data.medianPlaySeconds,
        { now: sample.medianPlaySeconds.now, before: sample.medianPlaySeconds.before },
        name,
      );
      assert.equal(sum(data.lengths.map((bucket) => bucket.plays)), sample.plays.now, `${name}: lengths`);
      assert.equal(sum(data.hours), sample.plays.now, `${name}: hours`);
      if (data.hoursLocal) assert.equal(sum(data.hoursLocal), sample.plays.now, `${name}: players' hours`);
      assert.equal(sum(data.devices.map((device) => loadedPlays(device.run))), sample.plays.now, `${name}: devices`);
      assert.equal(loadedPlays(data.run), sample.plays.now, `${name}: every started play that loaded is a play`);
      assert.equal(loadedPlays(data.runBefore), sample.plays.before, `${name}: and so before`);
      assert.equal(data.run.started, sum(data.devices.map((device) => device.run.started)), `${name}: started`);
      const byWeekday = fill(0, 7);
      sample.dates.forEach((day, index) => {
        byWeekday[weekdayOf(day)] = (byWeekday[weekdayOf(day)] ?? 0) + (sample.plays.daily[index] ?? 0);
      });
      assert.deepEqual(
        byWeekday.map((_, day) => sum(data.hours.slice(day * 24, day * 24 + 24))),
        byWeekday,
        `${name}: a weekday's hours are its days' plays`,
      );
      const playerDays = sum(sample.players.daily);
      const near = (value: number | null, expected: number | null, within: number, what: string): void =>
        value === null || expected === null
          ? assert.equal(value, expected, `${name}: ${what}`)
          : assert.ok(Math.abs(value - expected) <= within, `${name}: ${what} is ${value}, not ${expected}`);
      const each = playerDays > 0 ? sample.plays.now / playerDays : null;
      near(data.playsPerPlayerDay.now, each, 0.001, "plays for each player-day");
      near(data.dailyPlayers.now, playerDays / days, 0.05, "players a day");
      const perPlayerDay = playerDays > 0 ? data.playSeconds.now / playerDays : null;
      near(data.playSecondsPerPlayerDay.now, perPlayerDay, 0.05, "play time for each player-day");
      assert.equal(sum(data.daysAWeek), sampleOf(slug, 7, account).players.now, `${name}: a week's players`);
      assert.ok(data.monthlyPlayers.now >= sample.players.now || days > 30, `${name}: a month holds the period`);
      assert.ok(data.peak.now <= Math.max(0, ...sample.players.daily), `${name}: no more at once than in a day`);
      assert.ok(data.peak.now >= sample.game.playingNow, `${name}: at least as many as play now`);
    });
    for (const slug of [RICH, STEADY, YOUNG]) {
      const month = sampleOf(slug, 30).players;
      for (const days of [30, 90] as const)
        assert.deepEqual(
          engagementOf(slug, days).data.monthlyPlayers,
          { now: month.now, before: month.before },
          `${slug} over ${days} days: a month's players are the 30-day report's`,
        );
    }
  });

  it("keeps the lengths, the median, the 90th percentile and the quick exits one story", () => {
    const bounds = [10, 60, 180, 600, 1800, Number.POSITIVE_INFINITY];
    everyGame((slug, days, account) => {
      const { data, name } = engagementOf(slug, days, account);
      const total = data.plays.now;
      if (total === 0) {
        assert.deepEqual([data.quickExits.now, data.p90PlaySeconds, data.medianPlaySeconds.now], [null, null, null]);
        return;
      }
      const within = data.lengths.map((_, index) => sum(data.lengths.slice(0, index + 1).map((b) => b.plays)) / total);
      const bucketOf = (seconds: number): number => bounds.findIndex((bound) => seconds < bound);
      const holds = (share: number): number => within.findIndex((reached) => reached >= share);
      const median = data.medianPlaySeconds.now ?? assert.fail(name);
      assert.equal(bucketOf(median), holds(0.5), `${name}: the median sits in the bucket that holds the middle play`);
      if (data.p90PlaySeconds !== null) {
        assert.ok(Math.abs(bucketOf(data.p90PlaySeconds) - holds(0.9)) <= 1, `${name}: the 90th percentile`);
        assert.ok(data.p90PlaySeconds > median, name);
      }
      const quick = (data.lengths[0]?.plays ?? 0) / total;
      assert.ok(Math.abs((data.quickExits.now ?? -1) - quick) < 0.0001, `${name}: quick exits are the first bucket`);
    });
  });

  it("gives its richest game the numbers the page was designed with, over 30 days", () => {
    const { data } = engagementOf(RICH, 30);
    assert.deepEqual(data.plays, { now: 30_889, before: 18_386 });
    assert.equal(data.playsPerPlayerDay.now?.toFixed(2), "1.38");
    assert.deepEqual(data.medianPlaySeconds, { now: 340, before: 318 });
    assert.equal(data.p90PlaySeconds, 1860, "9 in 10 plays end within 31 minutes");
    assert.equal(Math.round(data.playSeconds.now / 3600), 4462);
    assert.equal(Math.round((data.playSeconds.now / data.playSeconds.before - 1) * 100), 71);
    assert.equal(Math.round(data.playSecondsPerPlayerDay.now ?? 0), 718, "11m 58s");
    assert.equal(data.quickExits.now?.toFixed(3), "0.098");
    assert.ok((data.quickExits.before ?? 0) > (data.quickExits.now ?? 1), "fewer quick exits than before");
    assert.equal(data.peak.now, 212);
    assert.equal(data.peakAt, "2026-11-07T20:00:00.000Z", "Saturday the 7th at 20:00, the campaign's busiest day");
    assert.equal(Math.round(data.dailyPlayers.now ?? 0), 746);
    assert.equal(data.monthlyPlayers.now, 9300);
    assert.deepEqual(
      data.lengths.map((bucket) => ((bucket.plays / data.plays.now) * 100).toFixed(1)),
      ["9.8", "14.6", "17.9", "26.3", "21.1", "10.3"],
    );
    const weekly = sum(data.daysAWeek);
    assert.deepEqual(
      data.daysAWeek.map((people) => Math.round((people / weekly) * 100)),
      [58, 19, 10, 5, 3, 2, 3],
    );
    const busiest = data.hours.indexOf(Math.max(...data.hours));
    assert.deepEqual([Math.floor(busiest / 24), busiest % 24], [5, 20], "the busiest hour is Saturday at 20:00 UTC");
    const levels = data.levels ?? assert.fail("the rich game sends level events");
    assert.equal(levels.length, 8);
    assert.equal(levels[0]?.started, 7410);
    const finished = levels.map((level) => Math.round((level.finished / (levels[0]?.started ?? 1)) * 100));
    assert.deepEqual(finished, [91, 74, 61, 38, 31, 24, 19, 12]);
    assert.ok(levels.every((level) => level.finished <= level.started && level.started > 0));
    const drops = finished.map((share, index) => (finished[index - 1] ?? 100) - share);
    assert.equal(levels[drops.indexOf(Math.max(...drops))]?.level, "4", "level 4 loses the most");
    assert.equal(levels[3]?.tries, 4);
    assert.deepEqual(
      [data.run.loadSeconds, data.run.loadSecondsP90, data.runBefore.loadSeconds, data.runSince],
      [3.8, 11.2, 3.1, "1.4.0"],
    );
    assert.deepEqual([data.run.smooth, data.run.clean, data.run.fps], [0.933, 0.989, 55]);
    assert.ok((data.runBefore.loaded ?? 0) > (data.run.loaded ?? 1), "fewer plays load than before");
    const device = (name: string) => data.devices.find((row) => row.device === name)?.run ?? assert.fail(name);
    assert.deepEqual(
      ["computer", "phone", "tablet"].map((name) => [device(name).loadSeconds, device(name).fps]),
      [
        [2.9, 60],
        [6.1, 47],
        [4.4, 55],
      ],
    );
    assert.ok(
      (device("phone").loadSeconds ?? 0) > 2 * (device("computer").loadSeconds ?? 0),
      "phones load twice as slowly",
    );
    assert.equal(device("phone").loaded?.toFixed(2), "0.86");
    assert.deepEqual(
      ["computer", "phone", "tablet"].map((name) => Math.round((loadedPlays(device(name)) / data.plays.now) * 100)),
      [58, 37, 5],
    );
  });

  it("agrees with what the sample says is worth a look", () => {
    for (const slug of [RICH, STEADY]) {
      const sample = sampleOf(slug, 30);
      const { data } = engagementOf(slug, 30);
      const slow = sample.insights.find((insight) => insight.kind === InsightKind.DeviceLoad);
      if (slow?.kind !== InsightKind.DeviceLoad) assert.fail(`${slug} has no slow device`);
      const phone = data.devices.find((row) => row.device === slow.device)?.run ?? assert.fail();
      assert.equal(phone.loadSeconds, slow.loadSeconds, slug);
      assert.equal((1 - (phone.loaded ?? 0)).toFixed(2), slow.leftLoading.toFixed(2), slug);
      assert.equal(data.devices.find((row) => row.device === "computer")?.run.loadSeconds, slow.loadSecondsOthers);
    }
    const steady = engagementOf(STEADY, 30).data;
    assert.equal(steady.levels, null, "a game on an SDK from before events sends no levels");
    assert.equal(steady.runSince, null);
    assert.ok(steady.hoursLocal, "but its players' own hours are known");
  });

  it("has nothing for the young game where nothing can be measured", () => {
    for (const days of STATS_PERIODS) {
      const { data, name } = engagementOf(YOUNG, days);
      assert.ok(data.plays.now > 0 && data.plays.now < 100, `${name}: a handful of plays`);
      assert.equal(data.plays.before, 0, name);
      assert.deepEqual(
        [
          data.playsPerPlayerDay.before,
          data.medianPlaySeconds.before,
          data.playSecondsPerPlayerDay.before,
          data.quickExits.before,
        ],
        [null, null, null, null],
        `${name}: nothing before it was published`,
      );
      assert.ok(data.playsPerPlayerDay.now !== null && data.quickExits.now !== null, `${name}: but something now`);
      assert.equal(data.p90PlaySeconds, null, `${name}: too few plays for a 90th percentile`);
      assert.equal(data.run.loadSecondsP90, null, `${name}: and too few loads for one of the load time`);
      assert.ok(data.run.loadSeconds !== null, `${name}: but the median load is known`);
      assert.equal(data.hoursLocal, null, name);
      assert.equal(data.levels, null, name);
      assert.equal(data.runSince, null, name);
      assert.deepEqual(data.runBefore, NOTHING_RAN, name);
      assert.deepEqual(data.devices.find((row) => row.device === "tablet")?.run, NOTHING_RAN, `${name}: no tablet`);
      assert.deepEqual(data.daysAWeek.slice(3), [0, 0, 0, 0], `${name}: three days old, nobody played four`);
      assert.ok(data.peak.now >= 1 && data.peakAt !== null, name);
      assert.equal(data.peak.before, 0, name);
    }
  });

  it("is all zeros and nulls for a game nobody played in the period", () => {
    const { data } = engagementOf(RICH, 7, FixtureAccount.Quiet);
    assert.deepEqual(data.plays, { now: 0, before: 0 });
    assert.deepEqual(data.playsPerPlayerDay, { now: null, before: null });
    assert.deepEqual(data.quickExits, { now: null, before: null });
    assert.deepEqual([data.peak, data.peakAt], [{ now: 0, before: 0 }, null]);
    assert.deepEqual(data.dailyPlayers, { now: 0, before: 0 });
    assert.equal(sum(data.daysAWeek), 0);
    assert.equal(data.hoursLocal, null);
    assert.deepEqual(data.levels, [], "it sends level events, and nobody played a level");
    assert.deepEqual([data.run, data.runBefore], [NOTHING_RAN, NOTHING_RAN]);
    assert.ok(data.devices.every((device) => device.run.started === 0));
    assert.equal(data.runSince, null);
  });
});

/** What the tests reach in the renderer build: the report's view model, its component and React's server renderer. */
interface EngagementBundle {
  view: typeof import("../../src/renderer/play/game-analytics/engagement-view.ts");
  EngagementReport: (props: EngagementProps) => ReactElement;
  EngagementFace: (props: EngagementFaceProps) => ReactElement;
  createElement: (type: unknown, props: object | null, ...children: unknown[]) => ReactElement;
  renderToStaticMarkup: (element: ReactElement) => string;
}
type EngagementProps = ReportProps<typeof GameReport.Engagement> & { offsetMinutes?: number };
type EngagementView = EngagementBundle["view"];
/** What the face is given: a view to draw, and what its controls ask. */
interface EngagementFaceProps {
  view: ReturnType<EngagementView["engagementView"]>;
  onClock: (clock: EngagementView["ClockChoice"][keyof EngagementView["ClockChoice"]]) => void;
  onOpenTab: (tab: string) => void;
}

/** The report as the plain renderer build compiles it. */
async function engagementBundle(): Promise<EngagementBundle> {
  const result = await build({
    stdin: {
      contents: [
        'export * as view from "./src/renderer/play/game-analytics/engagement-view.ts";',
        'export { EngagementFace, EngagementReport } from "./src/renderer/play/game-analytics/EngagementReport.tsx";',
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

let bundled: Promise<EngagementBundle> | undefined;
/** The build, made once for every group that draws. */
const loadBundle = (): Promise<EngagementBundle> => {
  bundled ??= engagementBundle();
  return bundled;
};

/** The words a reader meets in `markup`: tags gone, spaces single, the markup's escapes read back. */
const words = (markup: string): string =>
  markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
/** The markup of the block that opens with `open`, up to the next block that does (or the end). */
const blockOf = (markup: string, open: string, next?: string): string => {
  const from = markup.indexOf(open);
  const to = next ? markup.indexOf(next, from + 1) : -1;
  return from < 0 ? "" : markup.slice(from, to < 0 ? undefined : to);
};
const section = (markup: string, id: string): string =>
  /<section[^>]*data-game-analytics-section="ID".*?<\/section>/s
    .exec(markup.replace(`data-game-analytics-section="${id}"`, 'data-game-analytics-section="ID"'))?.[0]
    ?.replace('data-game-analytics-section="ID"', `data-game-analytics-section="${id}"`) ?? "";
const tile = (markup: string, id: string): string =>
  new RegExp(`<div class="stats-tile game-analytics-tile" data-game-analytics-tile="${id}">.*?</div>`, "s").exec(
    markup,
  )?.[0] ?? "";
const MINUS = "−";

/** The three made-up games' Engagement over 30 days, and the rich one's week with nobody in it. */
function fixtureAnswers() {
  const NOW = Date.parse("2026-11-17T12:04:00.000Z");
  const author = { id: "fx-simeon-m", name: "Simeon M" };
  const game = (slug: string, title: string, builds?: unknown[]) => ({
    slug,
    title,
    thumbnailUrl: null,
    playsCount: 2500,
    online: 4,
    author,
    ...(builds ? { builds } : {}),
  });
  const items = [
    game("lost-cathedral", "Lost Cathedral"),
    game("stick-steel", "Stick & Steel"),
    game("skate", "SKATE", [{ platform: "macos" }]),
  ];
  const catalog = { games: (authorId: string) => (authorId === author.id ? items : []) };
  const answerOf = (
    slug: string,
    days: StatsPeriod,
    account: FixtureAccount,
  ): ReportAnswer<typeof GameReport.Engagement> => {
    const source = ownSamples(account, catalog).find((own) => own.slug === slug) ?? assert.fail(`no ${slug}`);
    const sample = gameSample(source, days, NOW);
    const data = toEngagementReport(JSON.parse(JSON.stringify(fixtureEngagement(sample, {}))), sample.window);
    return {
      report: GameReport.Engagement,
      game: sample.game,
      window: sample.window,
      data: data ?? assert.fail(`${slug} does not read`),
    };
  };
  return {
    now: NOW,
    rich: answerOf("skate", 30, FixtureAccount.Full),
    steady: answerOf("lost-cathedral", 30, FixtureAccount.Full),
    young: answerOf("stick-steel", 30, FixtureAccount.Full),
    empty: answerOf("skate", 7, FixtureAccount.Quiet),
  };
}

describe("what the Engagement report derives to show", () => {
  let view: EngagementBundle["view"];
  const made = fixtureAnswers();
  const rich = made.rich.data;
  const young = made.young.data;
  const empty = made.empty.data;
  const japanese = (): void => setLocale(Locale.Japanese, {});
  before(async () => {
    view = (await loadBundle()).view;
  });
  // The bundle reads the same language slot as this file: numbers the English way, whatever the computer's.
  beforeEach(japanese);
  after(() => setLocale(Locale.English, {}));

  it("turns a week of UTC hours to the viewer's clock: whole hours, part of an hour, either way round the week", () => {
    const hours = Array.from({ length: WEEK_HOURS }, (_, index) => index);
    assert.deepEqual(view.shiftedHours(hours, 0), hours);
    const east = view.shiftedHours(hours, 180);
    assert.equal(east[3], 0, "Monday 00:00 UTC is Monday 03:00 in Istanbul");
    assert.equal(east[0], 165, "and Sunday 21:00 UTC is its Monday 00:00");
    const west = view.shiftedHours(hours, -300);
    assert.equal(west[0], 5, "Monday 05:00 UTC is Monday 00:00 in New York");
    assert.equal(west[163], 0, "and Monday 00:00 UTC is its Sunday 19:00");
    assert.deepEqual(view.shiftedHours(hours, 7 * 24 * 60), hours, "a whole week round is the same week");
    assert.deepEqual(view.shiftedHours(hours, -7 * 24 * 60), hours);
    const one = fill(0, WEEK_HOURS);
    one[10] = 8;
    const india = view.shiftedHours(one, 330);
    assert.deepEqual([india[15], india[16]], [4, 4], "a half-hour zone shares an hour between two");
    const nepal = view.shiftedHours(one, 345);
    assert.deepEqual([nepal[15], nepal[16]], [2, 6]);
    for (const offset of [0, 60, -60, 330, -210, 345, 765, -720, 10_000])
      assert.equal(Math.round(sum(view.shiftedHours(rich.hours, offset))), rich.plays.now, `${offset} minutes`);
    assert.deepEqual(view.shiftedHours(hours, Number.NaN), hours, "no offset known reads as UTC");
    assert.deepEqual(view.shiftedHours([], 60), fill(0, WEEK_HOURS), "and a week that is not there is an empty week");
    assert.equal(view.shiftedHours(hours.slice(0, 24), 60).length, WEEK_HOURS);
  });

  it("names the busiest hour of a week, and none when nobody played", () => {
    assert.deepEqual(view.busiestHour(rich.hours), { day: 5, hour: 20 });
    assert.deepEqual(view.busiestHour(view.shiftedHours(rich.hours, 180)), { day: 5, hour: 23 });
    assert.deepEqual(view.busiestHour(view.shiftedHours(rich.hours, 300)), { day: 6, hour: 1 }, "over midnight");
    assert.equal(view.busiestHour(fill(0, WEEK_HOURS)), null);
    assert.equal(view.busiestHour([]), null);
    const tied = fill(3, WEEK_HOURS);
    assert.deepEqual(view.busiestHour(tied), { day: 0, hour: 0 }, "a tie names the first");
  });

  it("writes the hour of the most playing at once on the viewer's clock, as the heatmap does, and says so", () => {
    const newYork = -300;
    const note = (offset: number) => view.headlineTiles(rich, offset).find((one) => one.id === "peak")?.note;
    assert.equal(note(newYork), `${formatDayTime(rich.peakAt, newYork)}, your time`);
    assert.match(formatDayTime(rich.peakAt, newYork), /\b15:00$/, "20:00 UTC is 15:00 in New York");
    assert.match(formatDayTime(rich.peakAt, 330), /\b01:30$/, "and 01:30 the next day in India");
    assert.equal(note(0), `${formatDayTime(rich.peakAt, 0)}, your time`);
    const saturdayEight = 5 * 24 + 20;
    const only = { ...rich, hours: rich.hours.map((_, hour) => (hour === saturdayEight ? 1 : 0)) };
    const busiest = view.hoursView(only, view.ClockChoice.Mine, newYork).busiest;
    assert.match(busiest ?? "", /15:00$/, "the heatmap names the same hour");
  });

  it("writes the eight headline numbers, each with how it moved and what it counts", () => {
    const tiles = view.headlineTiles(rich, 0);
    assert.deepEqual(
      tiles.map((one) => one.id),
      [
        "plays",
        "plays-per-player-day",
        "median-play",
        "play-time",
        "play-time-per-player-day",
        "quick-exits",
        "peak",
        "daily-share",
      ],
    );
    const shown = Object.fromEntries(tiles.map((one) => [one.id, [one.value, one.note]]));
    assert.deepEqual(shown, {
      plays: ["30,889", "counted once the game has loaded"],
      "plays-per-player-day": ["1.38", "on the days they play"],
      "median-play": ["5m 40s", "9 in 10 plays end within 31m"],
      "play-time": ["4,462 h", "everyone’s plays added up"],
      "play-time-per-player-day": ["11m 58s", "on the days they play"],
      "quick-exits": ["9.8%", "plays that end within 10 s"],
      peak: ["212", `${formatDayTime("2026-11-07T20:00:00.000Z", 0)}, your time`],
      "daily-share": ["8.0%", "746 a day of 9,300 in 30 days"],
    });
    const delta = (id: string) => tiles.find((one) => one.id === id)?.delta ?? assert.fail(id);
    assert.deepEqual(delta("plays"), { kind: view.DeltaKind.Percent, now: 30_889, before: 18_386 });
    const share = delta("daily-share");
    assert.equal(share.kind, view.DeltaKind.Points);
    assert.ok(Math.abs((share.now ?? 0) - 746.1 / 9300) < 1e-9, "the daily players over the monthly ones");
    assert.ok(Math.abs((share.before ?? 0) - 449.4 / 5602) < 1e-9);
    const median = delta("median-play");
    if (median.kind !== view.DeltaKind.Amount) assert.fail("a play's length changes in seconds");
    assert.equal(median.format(22), "+22 s");
    const perDay = delta("plays-per-player-day");
    if (perDay.kind !== view.DeltaKind.Amount) assert.fail();
    assert.equal(perDay.format(0.04), "+0.04");
    const peak = delta("peak");
    if (peak.kind !== view.DeltaKind.Amount) assert.fail("the most at once changes in people");
    assert.equal(peak.format(124), "+124");
  });

  it("says in a word which way quick exits went, because fewer is the good way", () => {
    const quick = view.headlineTiles(rich, 0).find((one) => one.id === "quick-exits")?.delta ?? assert.fail();
    if (quick.kind !== view.DeltaKind.Amount) assert.fail();
    assert.equal(quick.lowerIsBetter, true);
    assert.equal(quick.format(-0.012), `${MINUS}1.2 pts, fewer`);
    assert.equal(quick.format(0.012), "+1.2 pts, more");
    assert.equal(quick.format(0.0001), "0.0 pts", "a change too small to show goes neither way");
    assert.equal(quick.format(-0.0004), "0.0 pts");
  });

  it("leaves a headline number empty when it cannot be known, never zero", () => {
    const tiles = Object.fromEntries(view.headlineTiles(empty, 0).map((one) => [one.id, one]));
    assert.equal(tiles.plays?.value, "0", "a count of nothing is a real zero");
    assert.equal(tiles["play-time"]?.value, "0 h");
    assert.equal(tiles.peak?.value, "0");
    for (const id of ["plays-per-player-day", "median-play", "play-time-per-player-day", "quick-exits", "daily-share"])
      assert.equal(tiles[id]?.value, null, id);
    assert.equal(tiles["median-play"]?.note, undefined, "no 90th percentile, no line about it");
    assert.equal(tiles.peak?.note, undefined, "no hour it happened");
    assert.equal(tiles["daily-share"]?.note, undefined);
    const fresh = Object.fromEntries(view.headlineTiles(young, 0).map((one) => [one.id, one]));
    assert.equal(fresh["median-play"]?.value, "1m 35s");
    assert.equal(fresh["median-play"]?.note, undefined, "too few plays for a 90th percentile");
    assert.equal(fresh["median-play"]?.delta?.before, null, "nothing before it was published");
    assert.equal(fresh["quick-exits"]?.value, "20.0%");
    assert.equal(fresh["daily-share"]?.delta?.before, null, "nobody a month ago to divide by");
  });

  it("shares the plays out by length, with the line about the median and what a quick exit is", () => {
    const lengths = view.lengthsView(rich) ?? assert.fail();
    assert.deepEqual(
      lengths.buckets.map((bucket) => [bucket.id, bucket.label, formatPercent(bucket.value)]),
      [
        ["under_10s", "< 10 s", "9.8%"],
        ["under_1m", "10–60 s", "14.6%"],
        ["under_3m", "1–3 min", "17.9%"],
        ["under_10m", "3–10 min", "26.3%"],
        ["under_30m", "10–30 min", "21.1%"],
        ["over_30m", "30 min +", "10.3%"],
      ],
    );
    assert.equal(lengths.footnote, "Half of all plays last under 5m 40s. Plays under 10 s count as quick exits.");
    const noMedian = view.lengthsView({ ...rich, medianPlaySeconds: { now: null, before: null } }) ?? assert.fail();
    assert.equal(noMedian.footnote, "Plays under 10 s count as quick exits.");
    const missing = view.lengthsView({ ...rich, lengths: rich.lengths.slice(1, 3) }) ?? assert.fail();
    assert.deepEqual(
      missing.buckets.map((bucket) => bucket.value === null),
      [true, false, false, true, true, true],
      "a length the answer did not carry is unknown, not empty",
    );
    assert.equal(view.lengthsView(empty), null, "no plays: nothing to share out");
    assert.equal(view.lengthsView({ ...rich, lengths: [] }), null);
  });

  it("shares a week's players out by the days they played on, and names the regulars", () => {
    const days = view.daysAWeekView(rich) ?? assert.fail();
    assert.deepEqual(
      days.buckets.map((bucket) => [bucket.id, formatPercent(bucket.value, 0)]),
      [
        ["1", "58%"],
        ["2", "19%"],
        ["3", "10%"],
        ["4", "5%"],
        ["5", "3%"],
        ["6", "2%"],
        ["7", "3%"],
      ],
    );
    assert.deepEqual(days.buckets.map((bucket) => bucket.label).slice(1, 6), ["2", "3", "4", "5", "6"]);
    assert.equal(days.footnote, "Of everyone who played in a week. 13% play on 4 days or more: your regulars.");
    const fresh = view.daysAWeekView(young) ?? assert.fail();
    assert.match(fresh.footnote, /\b0% play on 4 days or more/, "nobody yet is a real zero");
    assert.equal(view.daysAWeekView(empty), null);
    setLocale(Locale.English, {});
    const named = view.daysAWeekView(rich) ?? assert.fail();
    assert.deepEqual([named.buckets[0]?.label, named.buckets[6]?.label], ["1 day", "7 days"]);
  });

  it("draws the week on the viewer's clock or the players', and only offers the players' when it is known", () => {
    const mine = view.hoursView(rich, view.ClockChoice.Mine, 180);
    assert.equal(mine.clock, view.ClockChoice.Mine);
    assert.equal(mine.switchable, true);
    assert.equal(mine.rows.length, 7);
    assert.deepEqual(
      mine.rows.map((row) => row.label),
      [0, 1, 2, 3, 4, 5, 6].map(weekdayName),
    );
    assert.deepEqual(
      mine.rows.flatMap((row) => row.cells),
      view.shiftedHours(rich.hours, 180),
    );
    assert.equal(mine.columns.length, 24);
    assert.deepEqual([mine.columns[0], mine.columns[20]], [formatHour(0), formatHour(20)]);
    assert.equal(new Set(mine.columns).size, 24, "every hour heads its own column");
    assert.equal(mine.busiest, `Busiest hour: ${view.weekdayLongName(5)} at ${formatHour(23)}`);
    const utc = view.hoursView(rich, view.ClockChoice.Mine, 0);
    assert.equal(utc.busiest, `Busiest hour: ${view.weekdayLongName(5)} at ${formatHour(20)}`);
    const players = view.hoursView(rich, view.ClockChoice.Players, 180);
    assert.equal(players.clock, view.ClockChoice.Players);
    assert.deepEqual(
      players.rows.flatMap((row) => row.cells),
      rich.hoursLocal,
      "the players' own hours are drawn as sent, whatever the viewer's zone",
    );
    assert.notEqual(players.label, mine.label);
    const unknown = view.hoursView(young, view.ClockChoice.Players, 0);
    assert.equal(unknown.clock, view.ClockChoice.Mine, "with no players' hours the week is the viewer's");
    assert.equal(unknown.switchable, false);
    const nobody = view.hoursView(empty, view.ClockChoice.Mine, 0);
    assert.deepEqual([nobody.empty, nobody.busiest, nobody.switchable], [true, null, false]);
  });

  it("says how far players get: each level's share of those who started the first, and the one that loses the most", () => {
    const levels = view.levelsView(rich.levels);
    if (levels.kind !== view.LevelsKind.Levels) assert.fail("the rich game has levels");
    assert.equal(levels.hint, "Of 7,410 players who started Level 1");
    assert.deepEqual(
      levels.buckets.map((bucket) => [bucket.label, formatPercent(bucket.value, 0), bucket.note]),
      [
        ["Level 1", "91%", undefined],
        ["Level 2", "74%", undefined],
        ["Level 3", "61%", undefined],
        ["Level 4", "38%", `${MINUS}23 pts`],
        ["Level 5", "31%", undefined],
        ["Level 6", "24%", undefined],
        ["Level 7", "19%", undefined],
        ["Level 8", "12%", undefined],
      ],
    );
    assert.deepEqual(
      levels.rows.map((row) => [row.id, row.label, row.cells]),
      [
        ["tries", "Tries to pass", ["1", "1", "1", "4", "2", "2", "3", "3"]],
        ["time", "Time to pass", ["48 s", "1m 14s", "1m 32s", "3m 41s", "2m 5s", "2m 20s", "2m 48s", "3m 10s"]],
      ],
    );
    setLocale(Locale.English, {});
    const english = view.levelsView(rich.levels);
    if (english.kind !== view.LevelsKind.Levels) assert.fail();
    assert.equal(
      english.footnote,
      "Percent who finished each level. Level 4 loses the most: 23 points, after 4 tries.",
    );
  });

  it("keeps a level's own name, a missing number as a dash, and says nothing of a loser when no level loses anyone", () => {
    const level = (name: string, started: number, finished: number, tries: number | null = null) => ({
      level: name,
      started,
      finished,
      tries,
      seconds: null,
    });
    const named = view.levelsView([
      level("tutorial", 200, 200),
      level("The Docks", 190, 100, 2.5),
      level("7", 90, 120),
    ]);
    if (named.kind !== view.LevelsKind.Levels) assert.fail();
    assert.deepEqual(
      named.buckets.map((bucket) => [bucket.label, bucket.value]),
      [
        ["tutorial", 1],
        ["The Docks", 0.5],
        ["Level 7", 0.6],
      ],
      "a name is shown as written, a number as a level",
    );
    assert.deepEqual(named.rows[0]?.cells, [DASH, "2.5", DASH]);
    assert.deepEqual(named.rows[1]?.cells, [DASH, DASH, DASH]);
    setLocale(Locale.English, {});
    const one = view.levelsView([level("1", 1, 1), level("2", 1, 0, 1)]);
    if (one.kind !== view.LevelsKind.Levels) assert.fail();
    assert.equal(one.hint, "Of 1 player who started Level 1");
    assert.equal(one.footnote, "Percent who finished each level. Level 2 loses the most: 100 points, after 1 try.");
    const untried = view.levelsView([level("1", 100, 99), level("2", 99, 60)]);
    if (untried.kind !== view.LevelsKind.Levels) assert.fail();
    assert.equal(untried.footnote, "Percent who finished each level. Level 2 loses the most: 39 points.");
    const even = view.levelsView([level("1", 50, 50), level("2", 50, 50)]);
    if (even.kind !== view.LevelsKind.Levels) assert.fail();
    assert.equal(even.footnote, "Percent who finished each level.");
    assert.ok(even.buckets.every((bucket) => bucket.note === undefined));
    const more = view.levelsView([level("1", 10, 30)]);
    if (more.kind !== view.LevelsKind.Levels) assert.fail();
    assert.equal(more.buckets[0]?.value, 1, "more finishers than starters is still everyone, not 300%");
  });

  it("tells a game that sends no level events from one whose levels nobody played", () => {
    assert.equal(view.levelsView(null).kind, view.LevelsKind.Unsent);
    assert.equal(view.levelsView([]).kind, view.LevelsKind.Nobody);
    assert.equal(view.levelsView(empty.levels).kind, view.LevelsKind.Nobody);
    const unstarted = [{ level: "1", started: 0, finished: 0, tries: null, seconds: null }];
    assert.equal(view.levelsView(unstarted).kind, view.LevelsKind.Nobody);
    assert.equal(view.levelsView(young.levels).kind, view.LevelsKind.Unsent);
  });

  it("writes how the game runs against the period before, and names the version a change came with", () => {
    const tiles = Object.fromEntries(view.runTiles(rich).map((one) => [one.id, one]));
    assert.deepEqual(Object.keys(tiles), ["load-time", "loaded", "smooth", "clean"]);
    assert.deepEqual(
      Object.values(tiles).map((one) => [one.value, one.note]),
      [
        ["3.8 s", "9 in 10 load within 11.2 s. The change came with version 1.4.0."],
        ["91.4%", "of plays that were started"],
        ["93.3%", "held 30 frames a second or more"],
        ["98.9%", "no script error, no crash"],
      ],
    );
    const load = tiles["load-time"]?.delta ?? assert.fail();
    if (load.kind !== view.DeltaKind.Amount) assert.fail("a load time changes in seconds");
    assert.deepEqual([load.now, load.before, load.lowerIsBetter], [3.8, 3.1, true]);
    assert.equal(load.format(0.7), "+0.7 s");
    assert.deepEqual(tiles.loaded?.delta, {
      kind: view.DeltaKind.Points,
      now: rich.run.loaded,
      before: rich.runBefore.loaded,
    });
    const plain = view.runTiles({ ...rich, runSince: null });
    assert.equal(plain[0]?.note, "9 in 10 load within 11.2 s");
    const bare = view.runTiles({ ...rich, run: { ...rich.run, loadSecondsP90: null } });
    assert.equal(bare[0]?.note, "The change came with version 1.4.0.");
    const nothing = view.runTiles(empty);
    assert.deepEqual(
      nothing.map((one) => one.value),
      [null, null, null, null],
      "nothing ran: nothing is known, and nothing reads as zero",
    );
    assert.equal(nothing[0]?.note, undefined);
  });

  it("compares the devices: each one's share of the plays, and a word on the one that is slow or loads too few", () => {
    const rows = view.deviceRows(rich);
    assert.deepEqual(
      rows.map((row) => [row.label, formatPercent(row.share, 0), row.loadSeconds, row.slow, row.low, row.fps]),
      [
        ["Computer", "58%", 2.9, false, false, 60],
        ["Phone", "37%", 6.1, true, true, 47],
        ["Tablet", "5%", 4.4, false, false, 55],
      ],
    );
    assert.equal(formatPercent(rows[1]?.loaded), "86.0%");
    assert.equal(formatPercent(rows[0]?.clean), "99.3%");
    const fresh = view.deviceRows(young);
    const tablet = fresh.find((row) => row.device === "tablet") ?? assert.fail();
    assert.deepEqual(
      [tablet.share, tablet.loadSeconds, tablet.loaded, tablet.fps, tablet.clean, tablet.slow, tablet.low],
      [0, null, null, null, null, false, false],
      "nobody on a tablet: none of the plays, and nothing measured",
    );
    assert.deepEqual(view.deviceRows(empty), [], "nothing started anywhere: no rows at all");
    const unloaded = view.deviceRows({
      ...rich,
      devices: [{ device: "phone", run: { ...rich.run, started: 40, loaded: null } }],
    });
    assert.equal(unloaded[0]?.share, null, "a device whose loaded share is unknown has an unknown share of the plays");
  });
});

describe("the Engagement report's face", () => {
  let bundle: EngagementBundle;
  const made = fixtureAnswers();
  const rich = made.rich.data;
  const base = {
    slug: "skate",
    refreshing: false,
    stale: false,
    now: made.now,
    onOpenTab: () => {},
    options: {},
    onOptions: () => {},
    offsetMinutes: 0,
  };
  /** The report drawn for `answer`, on a clock `extra.offsetMinutes` east of UTC. */
  const draw = (answer: ReportAnswer<typeof GameReport.Engagement>, extra: Partial<EngagementProps> = {}): string =>
    bundle.renderToStaticMarkup(bundle.createElement(bundle.EngagementReport, { ...base, answer, ...extra }));
  /** The same report with `change` made to its data. */
  const changed = (change: Partial<EngagementReport>): ReportAnswer<typeof GameReport.Engagement> => ({
    ...made.rich,
    data: { ...rich, ...change },
  });
  const tileIds = (markup: string): string[] =>
    [...markup.matchAll(/data-game-analytics-tile="([a-z-]+)"/g)].map((found) => found[1] ?? "");
  const sectionIds = (markup: string): string[] =>
    [...markup.matchAll(/data-game-analytics-section="([a-z]+)"/g)].map((found) => found[1] ?? "");
  /** The numbers in the heatmap's cells, in reading order. */
  const heatCells = (markup: string): string[] =>
    [...markup.matchAll(/<td class="game-analytics-heat"[^>]*>([^<]*)<\/td>/g)].map((found) => found[1] ?? "");
  const cellsOf = (plays: readonly number[]): string[] => plays.map((count) => formatCompact(Math.round(count)));
  /** The words of a device's row of the table. */
  const rowOf = (table: string, device: string): string =>
    words(new RegExp(`data-game-analytics-row="${device}"[^>]*>(.*?)</div>`, "s").exec(table)?.[1] ?? "");
  before(async () => {
    bundle = await loadBundle();
  });
  beforeEach(() => setLocale(Locale.Japanese, {}));
  after(() => setLocale(Locale.English, {}));

  it("draws the eight headline numbers, the blocks under them and how it runs, in the order of the design", () => {
    const markup = draw(made.rich);
    assert.match(markup, /^<div class="game-analytics-report" data-game-analytics-report="engagement">/);
    assert.deepEqual(tileIds(markup), [
      "plays",
      "plays-per-player-day",
      "median-play",
      "play-time",
      "play-time-per-player-day",
      "quick-exits",
      "peak",
      "daily-share",
      "load-time",
      "loaded",
      "smooth",
      "clean",
    ]);
    assert.deepEqual(sectionIds(markup), ["lengths", "days", "hours", "levels", "run", "devices"]);
    const shown = (id: string) => words(tile(markup, id));
    assert.match(shown("plays"), /^Plays 30,889 .*counted once the game has loaded$/);
    assert.match(shown("median-play"), /^Median play length 5m 40s .*\+22 s.*9 in 10 plays end within 31m$/);
    assert.match(shown("quick-exits"), /^Quick exits 9\.8% .*fewer.*plays that end within 10 s$/);
    assert.ok(shown("peak").startsWith("Most playing at once 212 "), shown("peak"));
    assert.ok(
      shown("peak").endsWith(`${formatDayTime("2026-11-07T20:00:00.000Z", 0)}, your time`),
      "it names the hour it happened, on the viewer's clock",
    );
    assert.match(shown("daily-share"), /^Daily share of monthly players 8\.0% .*746 a day of 9,300 in 30 days$/);
    assert.match(
      shown("load-time"),
      /^Load time, median 3\.8 s .*\+0\.7 s.*9 in 10 load within 11\.2 s\. The change came with version 1\.4\.0\.$/,
    );
    assert.match(shown("loaded"), /^Loaded 91\.4% .*of plays that were started$/);
    assert.match(words(markup), /How it runs Load time, median/);
  });

  it("shares the plays by length and the players by days a week, with the line under each", () => {
    const markup = draw(made.rich);
    const lengths = section(markup, "lengths");
    const shares = (block: string): string[] =>
      [...block.matchAll(/<span class="game-analytics-bucket-value">([^<]*)<\/span>/g)].map((found) => found[1] ?? "");
    assert.deepEqual(shares(lengths), ["9.8%", "14.6%", "17.9%", "26.3%", "21.1%", "10.3%"]);
    assert.match(words(lengths), /Half of all plays last under 5m 40s\. Plays under 10 s count as quick exits\.$/);
    assert.equal((lengths.match(/data-peak="true"/g) ?? []).length, 1, "the tallest bar is picked out");
    const days = section(markup, "days");
    assert.deepEqual(shares(days), ["58%", "19%", "10%", "5%", "3%", "2%", "3%"]);
    assert.match(words(days), /1 day 19% 2 .* 3% 7 days Of everyone who played in a week\. 13% play on 4 days or more/);
  });

  it("draws the week by hour on the viewer's clock, with the busiest hour in words and a switch to the players'", () => {
    const hours = section(draw(made.rich, { offsetMinutes: 180 }), "hours");
    assert.equal(heatCells(hours).length, WEEK_HOURS);
    assert.deepEqual(heatCells(hours), cellsOf(view().shiftedHours(rich.hours, 180)));
    assert.equal((hours.match(/<th scope="col">\d\d:00<\/th>/g) ?? []).length, 24);
    assert.equal((hours.match(/<th scope="row">/g) ?? []).length, 7);
    assert.match(words(hours), new RegExp(`Busiest hour: ${view().weekdayLongName(5)} at ${formatHour(23)}`));
    assert.match(hours, /data-game-analytics-switch="clock"/);
    assert.match(hours, /aria-checked="true"[^>]*data-game-analytics-option="mine"/);
    assert.match(hours, /aria-checked="false"[^>]*data-game-analytics-option="players"/);
    assert.match(words(hours), /My time Players’ time/);
    const utc = section(draw(made.rich, { offsetMinutes: 0 }), "hours");
    assert.deepEqual(heatCells(utc), cellsOf(rich.hours), "no offset: the hours as sent");
    assert.match(words(utc), new RegExp(`at ${formatHour(20)}`));
  });

  it("draws the players' own clock as sent when it is chosen, whatever zone the viewer is in", () => {
    const players = bundle.renderToStaticMarkup(
      bundle.createElement(bundle.EngagementFace, {
        view: view().engagementView(rich, view().ClockChoice.Players, 180),
        onClock: () => {},
        onOpenTab: () => {},
      }),
    );
    const hours = section(players, "hours");
    assert.deepEqual(heatCells(hours), cellsOf(rich.hoursLocal ?? []));
    assert.match(hours, /aria-checked="true"[^>]*data-game-analytics-option="players"/);
    assert.match(hours, /on each player’s own clock/);
  });

  it("leaves the switch out when the players' hours are not known, and says so when nobody played", () => {
    const unknown = section(draw(changed({ hoursLocal: null })), "hours");
    assert.doesNotMatch(unknown, /data-game-analytics-switch/);
    assert.equal(heatCells(unknown).length, WEEK_HOURS);
    const nobody = section(draw(changed({ hours: fill(0, WEEK_HOURS), hoursLocal: null })), "hours");
    assert.equal(heatCells(nobody).length, 0);
    assert.match(words(nobody), /No plays in these days yet\./);
  });

  it("draws each level's bar with the one that loses the most picked out, and the medians under the bars", () => {
    const levels = section(draw(made.rich), "levels");
    assert.match(words(levels), /Of 7,410 players who started Level 1/);
    assert.match(levels, /data-game-analytics-open="events"/);
    assert.match(words(levels), /From your events level_start, level_complete, level_fail/);
    assert.equal((levels.match(/data-game-analytics-bucket="/g) ?? []).length, 8);
    assert.equal((levels.match(/game-analytics-bucket-note/g) ?? []).length, 1, "one level is named as the loser");
    assert.match(words(levels), /−23 pts 38% Level 4/);
    const tries = blockOf(levels, 'data-game-analytics-levels-row="tries"', 'data-game-analytics-levels-row="time"');
    assert.deepEqual(
      [...tries.matchAll(/<\/span>(\d)<\/li>/g)].map((found) => found[1]),
      ["1", "1", "1", "4", "2", "2", "3", "3"],
    );
    assert.match(
      words(levels),
      /Time to pass .* 3m 41s .*Percent who finished each level\. Level 4 loses the most: 23 points, after 4 tries\.$/,
    );
  });

  it("tells a game that sends no level events how to start, and one whose levels nobody played that nobody did", () => {
    const unsent = section(draw(changed({ levels: null })), "levels");
    assert.match(
      words(unsent),
      /This fills in once your game sends level_start, level_complete and level_fail\. Open SDK$/,
    );
    assert.match(unsent, /<button[^>]*data-game-analytics-open="sdk"/);
    assert.doesNotMatch(unsent, /data-game-analytics-bucket=/);
    const nobody = section(draw(changed({ levels: [] })), "levels");
    assert.match(words(nobody), /Nobody has played a level in these days yet\./);
    assert.doesNotMatch(nobody, /data-game-analytics-open/);
  });

  it("compares the devices, saying in words which one is slow and which loads too few", () => {
    const markup = draw(made.rich);
    const rows = [...markup.matchAll(/data-game-analytics-row="(computer|phone|tablet)"/g)].map((found) => found[1]);
    assert.deepEqual(rows, ["computer", "phone", "tablet"]);
    const table = blockOf(markup, 'data-game-analytics-table="devices"');
    assert.match(words(table), /Device Share of plays Load time Loaded Frames a second Without errors/);
    const row = (device: string): string => rowOf(table, device);
    assert.match(row("computer"), /^Computer 58% 2\.9 s 95\.1% 60 99\.3%/);
    assert.match(row("phone"), /^Phone 37% 6\.1 s slow 86\.0% low 47 98\.2%/);
    assert.doesNotMatch(row("tablet"), /slow|low/);
  });

  it("gives the young game dashes where nothing can be measured and its own say about what it lacks", () => {
    const markup = draw(made.young);
    assert.match(words(tile(markup, "median-play")), /^Median play length 1m 35s —$/, "no 90th percentile, no line");
    assert.match(words(tile(markup, "load-time")), /^Load time, median 3\.8 s —$/);
    assert.doesNotMatch(markup, /data-game-analytics-switch/);
    assert.match(words(section(markup, "levels")), /This fills in once your game sends/);
    assert.match(words(section(markup, "days")), /0% play on 4 days or more/);
    const table = blockOf(markup, 'data-game-analytics-table="devices"');
    assert.match(rowOf(table, "tablet"), /^Tablet 0% — — — —$/, "nobody on a tablet");
    assert.match(tile(markup, "plays"), /title="new: nothing before to compare">New</, "plays against nothing are new");
  });

  it("draws a number that cannot be known as a dash, never as zero", () => {
    const unknown = { now: null, before: null };
    const markup = draw(changed({ playsPerPlayerDay: unknown, quickExits: unknown, medianPlaySeconds: unknown }));
    for (const id of ["plays-per-player-day", "quick-exits", "median-play"]) {
      assert.match(tile(markup, id), /<span class="stats-tile-value" data-missing="true">—<\/span>/, id);
      assert.match(words(tile(markup, id)), /^[A-Za-z ]+ — —/, id);
    }
    assert.match(words(section(markup, "lengths")), /Plays under 10 s count as quick exits\.$/);
    assert.doesNotMatch(words(section(markup, "lengths")), /Half of all plays/, "no median, no line about it");
  });

  it("is one plain sentence for a game nobody played in the period or the one before", () => {
    const markup = draw(made.empty);
    assert.equal(words(markup), "No plays in these days yet.");
    assert.doesNotMatch(markup, /data-game-analytics-tile|data-game-analytics-section/);
    const lately = draw({ ...made.empty, data: { ...made.empty.data, plays: { now: 0, before: 40 } } });
    assert.match(lately, /data-game-analytics-tile="plays"/, "a game that has had plays still draws its numbers");
  });

  it("says in a block that has no numbers that it has none, and keeps drawing the others", () => {
    const markup = draw(changed({ lengths: [], daysAWeek: fill(0, 7), devices: [] }));
    assert.match(words(section(markup, "lengths")), /No plays in these days yet\./);
    assert.match(words(section(markup, "days")), /No players in these days yet\./);
    assert.match(words(section(markup, "devices")), /Nothing has run in these days yet\./);
    assert.match(markup, /data-game-analytics-tile="plays"/);
    assert.equal(heatCells(section(markup, "hours")).length, WEEK_HOURS);
  });

  it("writes a level's name as text, whatever it holds", () => {
    const name = '<img src=x onerror=alert(1)> & "The Docks"';
    const levels = [
      { level: "1", started: 100, finished: 90, tries: 1, seconds: 40 },
      { level: name, started: 90, finished: 30, tries: 3, seconds: 90 },
    ];
    const markup = draw(changed({ levels }));
    assert.doesNotMatch(markup, /<img/);
    assert.match(words(section(markup, "levels")), /<img src=x onerror=alert\(1\)> & "The Docks"/);
    const long = draw(changed({ levels: [{ ...levels[0], level: "L".repeat(200) }] }));
    assert.ok(long.includes("L".repeat(200)), "a long name is kept whole, for the title a hover shows");
  });

  it("takes the viewer's clock from the computer when no offset is given", () => {
    const earlier = process.env.TZ;
    try {
      for (const [zone, offset] of [
        ["Europe/Istanbul", 180],
        ["America/New_York", -300],
        ["UTC", 0],
        ["Asia/Kolkata", 330],
      ] as const) {
        process.env.TZ = zone;
        assert.equal(view().viewerOffsetMinutes(Date.parse("2026-01-15T12:00:00.000Z")), offset, zone);
      }
      process.env.TZ = "America/New_York";
      assert.equal(view().viewerOffsetMinutes(Date.parse("2026-07-15T12:00:00.000Z")), -240, "summer time");
      const markup = bundle.renderToStaticMarkup(
        bundle.createElement(bundle.EngagementReport, {
          ...base,
          offsetMinutes: undefined,
          answer: made.rich,
          now: Date.parse("2026-11-17T12:00:00.000Z"),
        }),
      );
      assert.match(
        words(section(markup, "hours")),
        new RegExp(`at ${formatHour(15)}`),
        "Saturday 20:00 UTC is 15:00 in New York",
      );
    } finally {
      if (earlier === undefined) delete process.env.TZ;
      else process.env.TZ = earlier;
    }
  });

  /** The view model of the bundle, read once the bundle is built. */
  function view(): EngagementView {
    return bundle.view;
  }
});
