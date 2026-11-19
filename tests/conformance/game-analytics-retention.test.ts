/**
 * The Retention report of a game's analytics, end to end: what main reads from genex.games (a
 * hostile body is refused or loses only its bad rows, and a rate that cannot be known stays null),
 * what a fixture launch answers for every period, option and kind of game, what the page derives
 * for display, and the report's face as React's server renderer draws it.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { build } from "esbuild";
import type { ReactElement } from "react";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { createFixtureGameAnalytics } from "../../src/main/dev/fixture-game-analytics/index.ts";
import {
  type GameSample,
  gameSample,
  ownSamples,
  SampleKind,
} from "../../src/main/dev/fixture-game-analytics/sample.ts";
import { FixtureAccount, fixtureAccountToken } from "../../src/main/dev/fixture-people.ts";
import { isRecord } from "../../src/main/play/gallery.ts";
import { toRetentionReport } from "../../src/main/play/game-analytics/report-retention.ts";
import { toReportAnswer } from "../../src/main/play/game-analytics/reports.ts";
import { reportRoute } from "../../src/main/play/game-analytics/routes.ts";
import {
  type AnalyticsWindow,
  CohortSize,
  DeviceClass,
  GameReport,
  type GameReportOptions,
  PlayPlace,
  RETENTION_DAYS,
  RETENTION_SPAN,
  RetentionMode,
  type RetentionReport,
  SegmentBy,
  SourceChannel,
} from "../../src/shared/game-analytics.ts";
import type { ReportProps } from "../../src/renderer/play/game-analytics/report-props.ts";
import { formatList, setLocale } from "../../src/shared/i18n.ts";
import { Locale } from "../../src/shared/locale.ts";
import { dayBefore, STATS_PERIODS, type StatsPeriod } from "../../src/shared/play-stats.ts";

type Answer = ReportProps<typeof GameReport.Retention>["answer"];

const ENDS_ON = "2026-11-17";
const WEEK: AnalyticsWindow = { days: 7, endsOn: ENDS_ON, computedAt: "2026-11-17T12:00:00.000Z" };
const QUARTER: AnalyticsWindow = { ...WEEK, days: 90 };
const fill = <T>(value: T, length: number): T[] => Array.from({ length }, () => value);

/** A Retention report as genex.games answers it for a week, every part of it well formed. */
const retentionData = (): RetentionReport => ({
  mode: "on_day",
  cohort: "day",
  headline: [
    { day: 1, rate: 0.345, before: 0.324, similar: 0.311 },
    { day: 3, rate: 0.221, before: 0.207, similar: 0.196 },
    { day: 7, rate: 0.145, before: 0.137, similar: 0.126 },
    { day: 14, rate: null, before: 0.093, similar: 0.08 },
    { day: 30, rate: null, before: null, similar: null },
  ],
  curve: {
    rates: [0.345, 0.268, 0.221, 0.193, 0.173, 0.157, 0.145, null],
    before: [0.324, 0.25, 0.207, 0.181, 0.163, 0.149, 0.137, 0.127],
    similar: [0.311, 0.24, 0.196, 0.17, 0.151, 0.136, 0.126, 0.115],
  },
  cohorts: [
    { startsOn: "2026-11-11", size: 120, rates: [0.36, 0.27, 0.2, 0.19, 0.17, 0.15], campaign: null },
    { startsOn: "2026-11-12", size: 732, rates: [0.28, 0.21, 0.18, 0.15, 0.14, null], campaign: "launch_trailer" },
    { startsOn: "2026-11-16", size: 244, rates: [0.37, null, null, null, null, null], campaign: null },
    { startsOn: "2026-11-17", size: 235, rates: fill(null, 6), campaign: null },
  ],
  segmentBy: "place",
  segments: [
    { key: "browser", newPlayers: 5720, day1: 0.314, day7: 0.122, day30: 0.041 },
    { key: "genex_app", newPlayers: 1180, day1: 0.379, day7: 0.166, day30: null },
    { key: "installed", newPlayers: 940, day1: 0.491, day7: null, day30: null },
  ],
  weeks: [
    { startsOn: "2026-11-02", fresh: 3319, stayed: 830, back: 210, left: 1036 },
    { startsOn: "2026-11-09", fresh: 2110, stayed: 1520, back: 260, left: 2839 },
  ],
});

/** `retentionData()` with one part changed. */
const withPart = (part: string, value: unknown): Record<string, unknown> => ({ ...retentionData(), [part]: value });
/** `retentionData()` with one field of one row of a list changed. */
const withRow = (list: "cohorts" | "segments" | "weeks", change: object, at = 0): Record<string, unknown> => {
  const data = retentionData();
  const rows: object[] = [...data[list]];
  rows[at] = { ...rows[at], ...change };
  return { ...data, [list]: rows };
};
const read = (data: unknown, window: AnalyticsWindow = WEEK): RetentionReport | null => toRetentionReport(data, window);

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
const RICH = "skate";
const STEADY = "lost-cathedral";
const YOUNG = "stick-steel";
const catalog = { games: (authorId: string) => (authorId === author.id ? items : []) };
const full = fixtureAccountToken(FixtureAccount.Full);

/** The fixture's answer to a Retention question, as sent and as the real parser reads it. */
const asked = (slug: string, days: StatsPeriod, options: GameReportOptions = {}, token = full) => {
  const query = { slug, report: GameReport.Retention, days, ...options };
  const answer = createFixtureGameAnalytics({ now: () => NOW }).answer(
    reportRoute(query),
    { method: "GET", token },
    catalog,
  );
  const name = `${slug} over ${days} days with ${JSON.stringify(options)}`;
  assert.equal(answer?.status, 200, name);
  const answered = toReportAnswer(answer?.body, query, true) ?? assert.fail(`${name} does not read`);
  const sent: unknown = isRecord(answer?.body) ? answer.body.data : undefined;
  return answered.report === GameReport.Retention
    ? { data: answered.data, sent, name, answer: answered }
    : assert.fail(name);
};

describe("the Retention report main reads", () => {
  it("keeps a well-formed answer exactly, every null still null", () => {
    const report = read(retentionData()) ?? assert.fail("a well-formed report reads");
    assert.deepEqual(report, retentionData());
    assert.equal(report.headline[3]?.rate, null, "a day that has not passed is not zero");
    assert.equal(report.headline[4]?.similar, null);
    assert.equal(report.curve.rates.at(-1), null);
    assert.equal(report.cohorts[3]?.rates[0], null);
    assert.equal(report.cohorts[0]?.campaign, null);
    assert.equal(report.segments[2]?.day30, null);
    const alone = read(withPart("curve", { ...retentionData().curve, similar: null })) ?? assert.fail();
    assert.equal(alone.curve.similar, null, "too few similar games to compare with");
  });

  it("refuses a report whose fixed parts are missing or broken, whole", () => {
    const { curve, headline } = retentionData();
    const point = (change: object, at = 0) =>
      headline.map((one, index) => (index === at ? { ...one, ...change } : one));
    const table: [string, unknown][] = [
      ["null", null],
      ["a list", []],
      ["text", "retention"],
      ["a number", 7],
      ["no mode", withPart("mode", undefined)],
      ["a mode the app does not know", withPart("mode", "weekly")],
      ["a mode that is no text", withPart("mode", 1)],
      ["a cohort size the app does not know", withPart("cohort", "month")],
      ["a split the app does not know", withPart("segmentBy", "os")],
      ["no headline", withPart("headline", undefined)],
      ["a headline that is no list", withPart("headline", { day: 1 })],
      ["a headline day missing", withPart("headline", headline.slice(0, 4))],
      ["a rate over 1", withPart("headline", point({ rate: 1.2 }))],
      ["a rate below 0", withPart("headline", point({ rate: -0.1 }, 2))],
      ["a rate as text", withPart("headline", point({ rate: "0.3" }))],
      ["a rate that is no number", withPart("headline", point({ rate: Number.NaN }))],
      ["a before over 1", withPart("headline", point({ before: 2 }, 4))],
      ["a similar as text", withPart("headline", point({ similar: "31%" }))],
      ["a headline rate left out", withPart("headline", point({ rate: undefined }))],
      ["no curve", withPart("curve", undefined)],
      ["a curve that is a list", withPart("curve", [])],
      ["curve rates that are no list", withPart("curve", { ...curve, rates: 0.3 })],
      ["a curve longer than the span", withPart("curve", { ...curve, rates: fill(0.1, RETENTION_SPAN + 1) })],
      ["a curve rate over 1", withPart("curve", { ...curve, rates: [34.5, ...curve.rates.slice(1)] })],
      ["a curve rate below 0", withPart("curve", { ...curve, rates: [-0.01, ...curve.rates.slice(1)] })],
      ["a before shorter than the rates", withPart("curve", { ...curve, before: curve.before.slice(1) })],
      ["a similar longer than the rates", withPart("curve", { ...curve, similar: [...(curve.similar ?? []), 0.1] })],
      ["a similar that is text", withPart("curve", { ...curve, similar: "none" })],
      ["a similar left out", withPart("curve", { rates: curve.rates, before: curve.before })],
      ["no cohorts", withPart("cohorts", undefined)],
      ["cohorts that are no list", withPart("cohorts", { "2026-11-11": 120 })],
      ["segments that are no list", withPart("segments", "browser")],
      ["no weeks", withPart("weeks", null)],
    ];
    for (const [name, data] of table) assert.equal(read(data), null, name);
  });

  it("takes the headline by its days: another day's point is left out, and the first of two stands", () => {
    const { headline } = retentionData();
    const extra = [
      { day: 2, rate: 0.9, before: 0.9, similar: 0.9 },
      ...headline.toReversed(),
      { ...headline[0], rate: 0 },
    ];
    const report = read(withPart("headline", extra)) ?? assert.fail();
    assert.deepEqual(report.headline, headline, "the days of the tiles, in their order");
    assert.deepEqual(
      report.headline.map((one) => one.day),
      [...RETENTION_DAYS],
    );
    for (const day of [0, -1, 1.5, "1", RETENTION_SPAN + 1]) {
      const broken = headline.map((one, index) => (index === 0 ? { ...one, day } : one));
      assert.equal(read(withPart("headline", broken)), null, `day ${day} is no day 1`);
    }
  });

  it("drops a cohort it cannot read and keeps the rest", () => {
    const table: [string, object][] = [
      ["a negative size", { size: -1 }],
      ["a fractional size", { size: 119.5 }],
      ["a size as text", { size: "120" }],
      ["no size", { size: undefined }],
      ["a day that does not exist", { startsOn: "2026-11-31" }],
      ["a day that is no day", { startsOn: "yesterday" }],
      ["a time for a day", { startsOn: "2026-11-11T00:00:00Z" }],
      ["a day before the period", { startsOn: "2026-11-10" }],
      ["a day after the period", { startsOn: "2026-11-18" }],
      ["a rate over 1", { rates: [36, 0.27] }],
      ["a rate below 0", { rates: [0.36, -0.2] }],
      ["a rate as text", { rates: ["0.36"] }],
      ["rates that are no list", { rates: 0.36 }],
      ["more rates than the span", { rates: fill(0.1, RETENTION_SPAN + 1) }],
      ["a campaign that is no text", { campaign: 5 }],
      ["a campaign left out", { campaign: undefined }],
      ["an empty campaign", { campaign: " ‎\u0007 " }],
      ["a campaign too long to be a name", { campaign: "x".repeat(201) }],
    ];
    for (const [name, change] of table) {
      const report = read(withRow("cohorts", change)) ?? assert.fail(`${name}: the report still reads`);
      assert.deepEqual(report.cohorts, retentionData().cohorts.slice(1), name);
    }
    const junk = [null, 7, "2026-11-11", [], ...retentionData().cohorts];
    assert.deepEqual(read(withPart("cohorts", junk))?.cohorts, retentionData().cohorts);
  });

  it("keeps the first of two cohorts of one day, and a row of any width up to the span", () => {
    const [first, second] = retentionData().cohorts;
    const twice = [first, { ...second, startsOn: first?.startsOn }, second];
    assert.deepEqual(read(withPart("cohorts", twice))?.cohorts, [first, second]);
    const wide = { ...first, rates: [...fill(0.2, RETENTION_SPAN - 1), null] };
    assert.deepEqual(read(withPart("cohorts", [wide, { ...second, rates: [] }]))?.cohorts, [
      wide,
      { ...second, rates: [] },
    ]);
  });

  it("cleans a campaign's name of what turns text around or controls a terminal", () => {
    const hostile = "  ‮launch\u0007_trailer⁦\u0000  ";
    const report = read(withRow("cohorts", { campaign: hostile }, 1)) ?? assert.fail();
    assert.equal(report.cohorts[1]?.campaign, "launch_trailer");
    assert.equal(read(withRow("cohorts", { campaign: "y".repeat(200) }, 1))?.cohorts[1]?.campaign?.length, 200);
  });

  it("takes a week's cohort that begins on its Monday before the period, and no day's cohort there", () => {
    const monday = dayBefore(ENDS_ON, WEEK.days - 1 + 6);
    const early = { startsOn: monday, size: 40, rates: [0.4], campaign: null };
    const tooEarly = { ...early, startsOn: dayBefore(monday, 1) };
    const weekly = { ...retentionData(), cohort: "week", cohorts: [tooEarly, early, ...retentionData().cohorts] };
    assert.deepEqual(read(weekly)?.cohorts, [early, ...retentionData().cohorts]);
    const daily = { ...weekly, cohort: "day" };
    assert.deepEqual(read(daily)?.cohorts, retentionData().cohorts);
  });

  it("drops a group whose key is not of the split asked for, or whose numbers are not what they count", () => {
    const table: [string, object][] = [
      ["a place the app does not know", { key: "console" }],
      ["a channel for a place", { key: "social" }],
      ["a key that is no text", { key: 1 }],
      ["no key", { key: undefined }],
      ["negative new players", { newPlayers: -5 }],
      ["fractional new players", { newPlayers: 0.5 }],
      ["new players as text", { newPlayers: "5,720" }],
      ["a Day 1 over 1", { day1: 31.4 }],
      ["a Day 7 below 0", { day7: -0.122 }],
      ["a Day 30 as text", { day30: "4.1%" }],
      ["a Day 30 left out", { day30: undefined }],
    ];
    for (const [name, change] of table) {
      const report = read(withRow("segments", change)) ?? assert.fail(`${name}: the report still reads`);
      assert.deepEqual(report.segments, retentionData().segments.slice(1), name);
    }
    const [browser, app] = retentionData().segments;
    assert.deepEqual(read(withPart("segments", [browser, { ...app, key: "browser" }, app]))?.segments, [browser, app]);
  });

  it("reads each split's own keys: a vocabulary's values, a country's two letters, a version's cleaned words", () => {
    const row = (key: unknown) => ({ key, newPlayers: 10, day1: 0.3, day7: null, day30: null });
    const keysOf = (segmentBy: string, keys: unknown[]) =>
      read({ ...retentionData(), segmentBy, segments: keys.map(row) })?.segments.map((one) => one.key);
    assert.deepEqual(keysOf("place", ["browser", "genex_app", "installed", "Browser", "phone"]), [
      "browser",
      "genex_app",
      "installed",
    ]);
    assert.deepEqual(keysOf("channel", ["genex", "campaigns", "social", "direct", "search", "other", "email"]), [
      "genex",
      "campaigns",
      "social",
      "direct",
      "search",
      "other",
    ]);
    assert.deepEqual(keysOf("device", ["computer", "phone", "tablet", "watch", "browser"]), [
      "computer",
      "phone",
      "tablet",
    ]);
    assert.deepEqual(keysOf("country", ["US", "BR", "USA", "U", "U1", "U‮", "", 5, null]), ["US", "BR"]);
    assert.deepEqual(
      keysOf("country", ["us", "br", "Fr", "US"]),
      ["US", "BR", "FR"],
      "a country's two letters in either case, kept in capitals as Acquisition keeps them",
    );
    assert.deepEqual(keysOf("version", ["1.4.0", " ‮1.3\u0007.0⁩ ", "", "‏", "v".repeat(201), "v".repeat(200), 14]), [
      "1.4.0",
      "1.3.0",
      "v".repeat(200),
    ]);
  });

  it("drops a week that is not a whole week of counts, and keeps the rest", () => {
    const table: [string, object][] = [
      ["a week that starts on a Tuesday", { startsOn: "2026-11-03" }],
      ["a week that is not over", { startsOn: "2026-11-16" }],
      ["a week in the future", { startsOn: "2026-11-23" }],
      ["a day that does not exist", { startsOn: "2026-02-30" }],
      ["a day that is no text", { startsOn: 20261102 }],
      ["negative new players", { fresh: -1 }],
      ["fractional stayers", { stayed: 829.5 }],
      ["returners as text", { back: "210" }],
      ["a negative number who left", { left: -1036 }],
      ["no number who left", { left: undefined }],
      ["a count that is no number", { fresh: Number.POSITIVE_INFINITY }],
    ];
    for (const [name, change] of table) {
      const report = read(withRow("weeks", change)) ?? assert.fail(`${name}: the report still reads`);
      assert.deepEqual(report.weeks, retentionData().weeks.slice(1), name);
    }
    const [first, second] = retentionData().weeks;
    assert.deepEqual(read(withPart("weeks", [first, { ...second, startsOn: first?.startsOn }, second]))?.weeks, [
      first,
      second,
    ]);
    const sunday = { ...second, startsOn: "2026-11-09" };
    assert.deepEqual(read(withPart("weeks", [sunday]), { ...WEEK, endsOn: "2026-11-15" })?.weeks, [sunday]);
    assert.deepEqual(read(withPart("weeks", [sunday]), { ...WEEK, endsOn: "2026-11-14" })?.weeks, []);
  });

  it("caps every list: the first rows sent are the ones kept", () => {
    const cohort = (back: number) => ({ startsOn: dayBefore(ENDS_ON, back), size: back, rates: [0.2], campaign: null });
    const cohorts = Array.from({ length: QUARTER.days + 6 }, (_, back) => cohort(back));
    const segments = Array.from({ length: 5000 }, (_, index) => ({
      key: `1.0.${index}`,
      newPlayers: index,
      day1: null,
      day7: null,
      day30: null,
    }));
    const weeks = Array.from({ length: 5000 }, (_, index) => ({
      startsOn: dayBefore("2026-11-09", index * 7),
      fresh: index,
      stayed: 0,
      back: 0,
      left: 0,
    }));
    const data = { ...retentionData(), cohort: "week", cohorts, segmentBy: "version", segments, weeks };
    const report = read(data, QUARTER) ?? assert.fail();
    assert.equal(report.cohorts.length, 90, "a cohort for each day of the longest period");
    assert.equal(report.cohorts[0]?.startsOn, ENDS_ON);
    assert.equal(report.segments.length, 50);
    assert.equal(report.segments[0]?.key, "1.0.0");
    assert.equal(report.weeks.length, 26);
    assert.equal(report.weeks[0]?.startsOn, "2026-11-09");
  });
});

describe("the fixture account's Retention report", () => {
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  const known = (values: readonly (number | null)[]) => values.filter((value) => value !== null);
  const sampleOf = (slug: string, days: StatsPeriod, account: FixtureAccount = FixtureAccount.Full): GameSample => {
    const source = ownSamples(account, catalog).find((game) => game.slug === slug) ?? assert.fail(`no ${slug}`);
    return gameSample(source, days, NOW);
  };
  const retentionOf = (slug: string, days: StatsPeriod, options: GameReportOptions = {}): RetentionReport =>
    asked(slug, days, options).data;
  const weekday = (day: string): number => new Date(`${day}T00:00:00.000Z`).getUTCDay();
  const MONDAY = 1;

  it("answers every period, option and kind of game with a report the real parser keeps whole", () => {
    assert.deepEqual(
      [RICH, STEADY, YOUNG].map((slug) => sampleOf(slug, 30).kind),
      [SampleKind.Rich, SampleKind.Steady, SampleKind.Young],
    );
    for (const { slug } of items) {
      for (const days of STATS_PERIODS) {
        for (const mode of Object.values(RetentionMode)) {
          for (const cohort of Object.values(CohortSize)) {
            for (const segmentBy of Object.values(SegmentBy)) {
              const { data, sent, name } = asked(slug, days, { mode, cohort, segmentBy });
              assert.deepEqual(data, JSON.parse(JSON.stringify(sent)), `${name} loses nothing`);
              assert.deepEqual([data.mode, data.cohort, data.segmentBy], [mode, cohort, segmentBy], name);
            }
          }
        }
      }
    }
  });

  it("picks the day it happened, a cohort a day and where they play when nothing is asked", () => {
    const report = retentionOf(RICH, 30);
    assert.deepEqual(
      [report.mode, report.cohort, report.segmentBy],
      [RetentionMode.OnDay, CohortSize.Day, SegmentBy.Place],
    );
  });

  it("repeats the sample's curve, Day 1 and Day 7, so Retention agrees with Overview", () => {
    for (const { slug } of items) {
      for (const days of STATS_PERIODS) {
        const sample = sampleOf(slug, days);
        const report = retentionOf(slug, days);
        assert.deepEqual(report.curve, sample.retention, `${slug} over ${days} days`);
        assert.deepEqual(
          report.headline.map((point) => point.day),
          [...RETENTION_DAYS],
        );
        const point = (day: number) => report.headline.find((one) => one.day === day) ?? assert.fail();
        assert.equal(point(1).rate, sample.day1.now);
        assert.equal(point(1).before, sample.day1.before);
        assert.equal(point(7).rate, sample.day7.now);
        assert.equal(point(7).before, sample.day7.before);
        for (const one of report.headline) {
          assert.equal(one.rate, sample.retention.rates[one.day - 1] ?? null, `day ${one.day}`);
          assert.equal(one.similar, sample.retention.similar?.[one.day - 1] ?? null, `day ${one.day}, similar`);
        }
      }
    }
  });

  it("makes a cohort of each day's new players: the sizes sum to them and Day 1 and Day 7 are the sample's", () => {
    for (const { slug } of items) {
      for (const days of STATS_PERIODS) {
        const sample = sampleOf(slug, days);
        const { cohorts } = retentionOf(slug, days);
        const name = `${slug} over ${days} days`;
        assert.equal(sum(cohorts.map((cohort) => cohort.size)), sample.newPlayers.now, name);
        assert.deepEqual(
          cohorts.map((cohort) => cohort.startsOn),
          sample.dates.filter((_, at) => (sample.newPlayers.daily[at] ?? 0) > 0),
          `${name}: a cohort for every day somebody first played, oldest first`,
        );
        for (const cohort of cohorts) {
          const at = sample.dates.indexOf(cohort.startsOn);
          assert.equal(cohort.size, sample.newPlayers.daily[at], `${name}, ${cohort.startsOn}`);
          assert.equal(cohort.rates[0] ?? null, sample.day1.daily[at], `${name}, ${cohort.startsOn}, Day 1`);
          assert.equal(cohort.rates[6] ?? null, sample.day7.daily[at], `${name}, ${cohort.startsOn}, Day 7`);
        }
      }
    }
  });

  it("leaves a day that has not passed null, never zero", () => {
    for (const { slug } of items) {
      for (const days of STATS_PERIODS) {
        const sample = sampleOf(slug, days);
        for (const mode of Object.values(RetentionMode)) {
          for (const cohort of retentionOf(slug, days, { mode }).cohorts) {
            const passed = days - 1 - sample.dates.indexOf(cohort.startsOn);
            const name = `${slug} over ${days} days, ${mode}, ${cohort.startsOn}`;
            assert.ok(cohort.rates.length <= RETENTION_SPAN, name);
            for (const [index, rate] of cohort.rates.entries()) {
              if (index >= passed) assert.equal(rate, null, `${name}, day ${index + 1} has not passed`);
            }
          }
        }
      }
    }
    const rich = retentionOf(RICH, 30).cohorts;
    assert.deepEqual(known(rich.at(-1)?.rates ?? [0]), [], "today's new players have had no day to come back");
    assert.equal(known(rich.at(-2)?.rates ?? []).length, 1);
    assert.equal(known(rich[0]?.rates ?? []).length, 29, "the oldest cohort of a month knows 29 days");
    const week = retentionOf(RICH, 7).headline;
    assert.deepEqual(
      week.map((point) => point.rate === null),
      [false, false, false, true, true],
      "a week knows nothing of day 14 or day 30",
    );
  });

  it("gives the young game almost nothing: a few players, a short curve, no similar games", () => {
    for (const days of STATS_PERIODS) {
      const report = retentionOf(YOUNG, days);
      assert.ok(report.cohorts.length <= 3, `${report.cohorts.length} cohorts`);
      assert.ok(sum(report.cohorts.map((cohort) => cohort.size)) < 30);
      assert.equal(report.curve.similar, null);
      assert.deepEqual(
        report.headline.map((point) => [point.day, point.rate === null, point.before, point.similar]),
        [
          [1, false, null, null],
          [3, true, null, null],
          [7, true, null, null],
          [14, true, null, null],
          [30, true, null, null],
        ],
      );
      for (const segmentBy of Object.values(SegmentBy)) {
        for (const row of retentionOf(YOUNG, days, { segmentBy }).segments) {
          assert.ok(row.newPlayers > 0, `${segmentBy} ${row.key}`);
          assert.equal(row.day7, null, `${segmentBy} ${row.key}: nobody has had seven days`);
          assert.equal(row.day30, null);
        }
      }
      assert.ok(retentionOf(YOUNG, days).weeks.length <= 1);
    }
  });

  it("flags the cohorts the campaign mostly brought with its name", () => {
    const sample = sampleOf(RICH, 30);
    const campaign = sample.campaign ?? assert.fail("the rich game has a campaign");
    const flagged = retentionOf(RICH, 30).cohorts.filter((cohort) => cohort.campaign !== null);
    assert.deepEqual(
      flagged.map((cohort) => [cohort.startsOn, cohort.campaign]),
      [0, 1, 2, 3].map((day) => [dayBefore(campaign.startsOn, -day), campaign.name]),
      "the four days of its spike",
    );
    const weekly = retentionOf(RICH, 30, { cohort: CohortSize.Week }).cohorts.filter((cohort) => cohort.campaign);
    assert.equal(weekly.length, 1, "and the week they fall in");
    assert.ok(weekly[0] && weekly[0].startsOn <= campaign.startsOn);
    for (const slug of [STEADY, YOUNG]) {
      for (const cohort of Object.values(CohortSize)) {
        assert.ok(
          retentionOf(slug, 30, { cohort }).cohorts.every((one) => one.campaign === null),
          `${slug} has no campaign`,
        );
      }
    }
  });

  it("groups first plays by week when asked: Monday first, cut to the period, a week known once it is over", () => {
    for (const { slug } of items) {
      for (const days of STATS_PERIODS) {
        const sample = sampleOf(slug, days);
        const { cohorts, cohort } = retentionOf(slug, days, { cohort: CohortSize.Week });
        const name = `${slug} over ${days} days`;
        assert.equal(cohort, CohortSize.Week);
        assert.equal(sum(cohorts.map((one) => one.size)), sample.newPlayers.now, name);
        assert.ok(cohorts.length <= Math.ceil(days / 7) + 1, `${name}: ${cohorts.length} weeks`);
        for (const [index, one] of cohorts.entries()) {
          const first = one.startsOn === sample.dates[0];
          assert.ok(sample.dates.includes(one.startsOn), `${name}, ${one.startsOn} is a day of the period`);
          assert.ok(first || weekday(one.startsOn) === MONDAY, `${name}, ${one.startsOn} is a Monday`);
          assert.ok(index === 0 || one.startsOn > (cohorts[index - 1]?.startsOn ?? ""), `${name}: oldest first`);
          for (const [week, rate] of one.rates.entries()) {
            const sunday = dayBefore(one.startsOn, -(7 - ((weekday(one.startsOn) + 6) % 7) + 7 * week + 6));
            if (sunday > ENDS_ON) assert.equal(rate, null, `${name}, ${one.startsOn}, week ${week + 1} is not over`);
          }
        }
      }
    }
    const month = retentionOf(RICH, 30, { cohort: CohortSize.Week }).cohorts;
    assert.deepEqual(
      month.map((one) => [one.startsOn, known(one.rates).length]),
      [
        ["2026-10-19", 3],
        ["2026-10-26", 2],
        ["2026-11-02", 1],
        ["2026-11-09", 0],
        ["2026-11-16", 0],
      ],
    );
    assert.deepEqual(
      retentionOf(RICH, 7, { cohort: CohortSize.Week }).cohorts.map((one) => known(one.rates).length),
      [0, 0],
      "no week after a first play is over inside a week",
    );
  });

  it("counts a return on that day or later at least as high as on that day, wherever a rate is known", () => {
    const pairs = (on: readonly (number | null)[], later: readonly (number | null)[], name: string): void => {
      assert.equal(later.length, on.length, name);
      for (const [index, rate] of on.entries()) {
        const other = later[index] ?? null;
        assert.equal(other === null, rate === null, `${name}, ${index}: known in one, known in the other`);
        if (rate !== null && other !== null) assert.ok(other >= rate, `${name}, ${index}: ${other} >= ${rate}`);
      }
    };
    const falling = (rates: readonly (number | null)[], name: string): void => {
      const values = known(rates);
      for (const [index, rate] of values.entries()) {
        assert.ok(index === 0 || rate <= (values[index - 1] ?? 1), `${name}: later days never count more`);
        assert.ok(rate >= 0 && rate <= 1, name);
      }
    };
    let higher = 0;
    for (const { slug } of items) {
      for (const days of STATS_PERIODS) {
        for (const cohort of Object.values(CohortSize)) {
          for (const segmentBy of Object.values(SegmentBy)) {
            const on = retentionOf(slug, days, { mode: RetentionMode.OnDay, cohort, segmentBy });
            const later = retentionOf(slug, days, { mode: RetentionMode.DayOrLater, cohort, segmentBy });
            const name = `${slug} over ${days} days by ${cohort} and ${segmentBy}`;
            pairs(on.curve.rates, later.curve.rates, `${name}, curve`);
            pairs(on.curve.before, later.curve.before, `${name}, before`);
            pairs(on.curve.similar ?? [], later.curve.similar ?? [], `${name}, similar`);
            falling(later.curve.rates, `${name}, curve`);
            for (const key of ["rate", "before", "similar"] as const) {
              pairs(
                on.headline.map((point) => point[key]),
                later.headline.map((point) => point[key]),
                `${name}, headline ${key}`,
              );
            }
            assert.deepEqual(
              later.headline.map((point) => point.rate),
              RETENTION_DAYS.map((day) => later.curve.rates[day - 1] ?? null),
              `${name}: the tiles are the curve's own days`,
            );
            assert.deepEqual(
              later.cohorts.map((one) => [one.startsOn, one.size, one.campaign]),
              on.cohorts.map((one) => [one.startsOn, one.size, one.campaign]),
            );
            for (const [index, one] of on.cohorts.entries()) {
              pairs(one.rates, later.cohorts[index]?.rates ?? [], `${name}, cohort ${one.startsOn}`);
              falling(later.cohorts[index]?.rates ?? [], `${name}, cohort ${one.startsOn}`);
            }
            assert.deepEqual(
              later.segments.map((row) => [row.key, row.newPlayers]),
              on.segments.map((row) => [row.key, row.newPlayers]),
            );
            for (const [index, row] of on.segments.entries()) {
              const other = later.segments[index] ?? assert.fail();
              pairs([row.day1, row.day7, row.day30], [other.day1, other.day7, other.day30], `${name}, ${row.key}`);
            }
            assert.deepEqual(later.weeks, on.weeks, "who played each week does not depend on it");
            higher += known(later.curve.rates).filter((rate, index) => rate > (on.curve.rates[index] ?? 1)).length;
          }
        }
      }
    }
    assert.ok(higher > 0, "and it is higher somewhere");
  });

  it("splits the rich game's new players by where they play as the design has them", () => {
    assert.deepEqual(retentionOf(RICH, 30).segments, [
      { key: PlayPlace.Browser, newPlayers: 5720, day1: 0.314, day7: 0.122, day30: 0.041 },
      { key: PlayPlace.GenexApp, newPlayers: 1180, day1: 0.379, day7: 0.166, day30: 0.064 },
      { key: PlayPlace.Installed, newPlayers: 940, day1: 0.491, day7: 0.261, day30: 0.112 },
    ]);
    assert.deepEqual(
      retentionOf(STEADY, 30).segments.map((row) => row.key),
      [PlayPlace.Browser, PlayPlace.GenexApp],
      "a game with no app build is installed nowhere",
    );
  });

  it("answers every split with groups that sum to the new players, each key of its own vocabulary", () => {
    const keys: Record<SegmentBy, (key: string) => boolean> = {
      [SegmentBy.Place]: (key) => Object.values<string>(PlayPlace).includes(key),
      [SegmentBy.Channel]: (key) => Object.values<string>(SourceChannel).includes(key),
      [SegmentBy.Device]: (key) => Object.values<string>(DeviceClass).includes(key),
      [SegmentBy.Country]: (key) => /^[A-Z]{2}$/.test(key),
      [SegmentBy.Version]: (key) => /^\d+\.\d+\.\d+$/.test(key),
    };
    for (const { slug } of items) {
      for (const days of STATS_PERIODS) {
        const sample = sampleOf(slug, days);
        for (const segmentBy of Object.values(SegmentBy)) {
          const { segments } = retentionOf(slug, days, { segmentBy });
          const name = `${slug} over ${days} days by ${segmentBy}`;
          assert.ok(segments.length > 0, name);
          assert.equal(sum(segments.map((row) => row.newPlayers)), sample.newPlayers.now, name);
          assert.equal(new Set(segments.map((row) => row.key)).size, segments.length, `${name}: no key twice`);
          for (const row of segments) {
            assert.ok(keys[segmentBy](row.key), `${name}: ${row.key}`);
            assert.ok(row.newPlayers > 0, `${name}: ${row.key} has someone`);
            const day30Known = sample.retention.rates[29] !== null && sample.retention.rates[29] !== undefined;
            if (!day30Known) assert.equal(row.day30, null, `${name}: ${row.key}, day 30 has not passed`);
          }
        }
        assert.deepEqual(
          retentionOf(slug, days, { segmentBy: SegmentBy.Channel }).segments.map((row) => [row.key, row.newPlayers]),
          sample.channels.filter((one) => one.newPlayers > 0).map((one) => [one.channel, one.newPlayers]),
          `${slug} over ${days} days: the sample's channels`,
        );
      }
    }
    const versions = retentionOf(RICH, 30, { segmentBy: SegmentBy.Version }).segments;
    const sample = sampleOf(RICH, 30);
    const since = sample.dates.indexOf(sample.release.on);
    assert.deepEqual(
      versions.map((row) => [row.key, row.newPlayers, row.day30 === null]),
      [
        [sample.release.version, sum(sample.newPlayers.daily.slice(since)), true],
        ["1.3.0", sum(sample.newPlayers.daily.slice(0, since)), false],
      ],
      "the newest version first; it is eight days old, so its day 30 is not known",
    );
  });

  it("sums whole weeks of players: new ones are the sample's, and who left is who stayed away", () => {
    for (const { slug } of items) {
      for (const days of STATS_PERIODS) {
        const sample = sampleOf(slug, days);
        const history = [...sample.newPlayers.dailyBefore, ...sample.newPlayers.daily];
        const { weeks } = retentionOf(slug, days);
        const name = `${slug} over ${days} days`;
        for (const [index, week] of weeks.entries()) {
          assert.equal(weekday(week.startsOn), MONDAY, `${name}, ${week.startsOn}`);
          assert.ok(dayBefore(week.startsOn, -6) <= ENDS_ON, `${name}, ${week.startsOn} is over`);
          const first = history.length - 1 - (Date.parse(ENDS_ON) - Date.parse(week.startsOn)) / 86_400_000;
          assert.ok(first >= 0, `${name}, ${week.startsOn} is inside what the sample knows`);
          assert.equal(week.fresh, sum(history.slice(first, first + 7)), `${name}, ${week.startsOn}: new players`);
          const before = weeks[index - 1];
          if (!before) continue;
          assert.equal(week.startsOn, dayBefore(before.startsOn, -7), `${name}: week after week`);
          assert.equal(week.left, before.fresh + before.stayed + before.back - week.stayed, `${name}: who left`);
        }
      }
    }
    const month = retentionOf(RICH, 30).weeks;
    assert.deepEqual(
      month.map((week) => week.startsOn),
      ["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"],
      "the six whole weeks before today",
    );
    assert.deepEqual(
      month.slice(2).map((week) => week.fresh),
      [926, 1006, 3319, 2110],
      "the design's new players, the campaign's week among them",
    );
    for (const week of month) assert.ok(week.stayed > 0 && week.back > 0 && week.left > 0, week.startsOn);
    assert.equal(retentionOf(RICH, 90).weeks.length, 13);
    assert.ok(retentionOf(RICH, 7).weeks.length >= 1);
    const quiet = createFixtureGameAnalytics({ now: () => NOW }).answer(
      reportRoute({ slug: RICH, report: GameReport.Retention, days: 30 }),
      { method: "GET", token: fixtureAccountToken(FixtureAccount.Quiet) },
      catalog,
    );
    const silent = toRetentionReport(isRecord(quiet?.body) ? quiet.body.data : null, { ...WEEK, days: 30 });
    const last = silent?.weeks.at(-1) ?? assert.fail("the silent game still has its weeks");
    assert.deepEqual([last.fresh, last.stayed, last.back], [0, 0, 0], "a week with nobody in it");
    assert.ok(last.left > 0, "everyone who played the week before left");
  });
});

/** What the tests reach in the renderer build: the report's view model and face, the kit and React's server renderer. */
interface RetentionBundle {
  view: typeof import("../../src/renderer/play/game-analytics/retention-view.ts");
  kit: typeof import("../../src/renderer/play/game-analytics/kit/index.ts");
  RetentionReport: (props: ReportProps<typeof GameReport.Retention>) => ReactElement;
  createElement: (type: unknown, props: object | null, ...children: unknown[]) => ReactElement;
  renderToStaticMarkup: (element: ReactElement) => string;
}

/** The Retention report as the plain renderer build compiles it. */
async function retentionBundle(): Promise<RetentionBundle> {
  const result = await build({
    stdin: {
      contents: [
        'export * as view from "./src/renderer/play/game-analytics/retention-view.ts";',
        'export * as kit from "./src/renderer/play/game-analytics/kit/index.ts";',
        'export { RetentionReport } from "./src/renderer/play/game-analytics/RetentionReport.tsx";',
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

/** Whether two rates are the same number, give or take what adding fractions loses. */
const near = (actual: number | null | undefined, expected: number): boolean =>
  typeof actual === "number" && Math.abs(actual - expected) < 1e-9;

describe("what the Retention report shows", () => {
  let bundle: RetentionBundle;
  before(async () => {
    bundle = await retentionBundle();
  });
  // The bundle reads the same language slot as this file: numbers the English way, whatever the computer's.
  beforeEach(() => setLocale(Locale.Japanese, {}));
  after(() => setLocale(Locale.English, {}));
  const viewOf = (data: RetentionReport, options: GameReportOptions = {}, window: AnalyticsWindow = WEEK) =>
    bundle.view.retentionView({ data, window }, options);
  const noop = (): void => {};
  /** The report as the shell mounts it, for an answer the fixture gave (or one made by hand) and the options asked. */
  const drawReport = (answer: Answer, options: GameReportOptions = {}): string =>
    bundle.renderToStaticMarkup(
      bundle.createElement(bundle.RetentionReport, {
        slug: answer.game.slug,
        refreshing: false,
        stale: false,
        now: NOW,
        onOpenTab: noop,
        answer,
        options,
        onOptions: noop,
      } satisfies ReportProps<typeof GameReport.Retention>),
    );

  it("writes a tile for each headline day: the rate, its change in points, similar games as the note", () => {
    const { tiles } = viewOf(retentionData());
    assert.deepEqual(
      tiles.map((tile) => [tile.id, tile.label, tile.value, tile.note]),
      [
        ["day1", "Day 1", "34.5%", "similar games 31.1%"],
        ["day3", "Day 3", "22.1%", "similar games 19.6%"],
        ["day7", "Day 7", "14.5%", "similar games 12.6%"],
        ["day14", "Day 14", null, "similar games 8.0%"],
        ["day30", "Day 30", null, undefined],
      ],
    );
    assert.deepEqual(tiles[0]?.delta, { kind: bundle.kit.DeltaKind.Points, now: 0.345, before: 0.324 });
    assert.equal(tiles[3]?.delta, undefined, "a day that has not passed has no change to show");
    const noBefore = retentionData();
    noBefore.headline = noBefore.headline.map((point) => ({ ...point, before: null }));
    assert.deepEqual(viewOf(noBefore).tiles[0]?.delta, { kind: bundle.kit.DeltaKind.Points, now: 0.345, before: null });
    const missing = { ...retentionData(), headline: retentionData().headline.slice(1) };
    assert.deepEqual(
      viewOf(missing).tiles.map((tile) => [tile.id, tile.value]),
      [
        ["day1", null],
        ["day3", "22.1%"],
        ["day7", "14.5%"],
        ["day14", null],
        ["day30", null],
      ],
      "always the five days, a missing one a dash",
    );
  });

  it("shows each switch at what was asked, or at what genex.games picked when nothing was", () => {
    const data = retentionData();
    assert.deepEqual(viewOf(data).chosen, {
      mode: RetentionMode.OnDay,
      cohort: CohortSize.Day,
      segmentBy: SegmentBy.Place,
    });
    const asked = { mode: RetentionMode.DayOrLater, cohort: CohortSize.Week, segmentBy: SegmentBy.Country };
    assert.deepEqual(viewOf(data, asked).chosen, asked, "the switch follows the press before the answer lands");
    assert.deepEqual(viewOf(data, { cohort: CohortSize.Week }).chosen, {
      mode: RetentionMode.OnDay,
      cohort: CohortSize.Week,
      segmentBy: SegmentBy.Place,
    });
    assert.deepEqual(
      [bundle.view.MODE_OPTIONS, bundle.view.COHORT_OPTIONS, bundle.view.SEGMENT_OPTIONS].map((options) =>
        options.map((option) => [option.value, option.label]),
      ),
      [
        [
          [RetentionMode.OnDay, "On that day"],
          [RetentionMode.DayOrLater, "That day or later"],
        ],
        [
          [CohortSize.Day, "By day"],
          [CohortSize.Week, "By week"],
        ],
        [
          [SegmentBy.Place, "Where they play"],
          [SegmentBy.Channel, "Source"],
          [SegmentBy.Device, "Device"],
          [SegmentBy.Country, "Country"],
          [SegmentBy.Version, "Version"],
        ],
      ],
    );
  });

  it("draws the curve by day since the first play, this period over the one before and similar games", () => {
    const { LineTone, formatDayRange } = bundle.kit;
    const data = retentionData();
    const curve = viewOf(data).curve ?? assert.fail("a curve with rates draws");
    assert.deepEqual(
      curve.labels,
      [1, 2, 3, 4, 5, 6, 7, 8].map((day) => `Day ${day}`),
    );
    assert.deepEqual(
      curve.series.map((line) => [line.id, line.tone, line.values]),
      [
        ["now", LineTone.Main, data.curve.rates],
        ["before", LineTone.Before, data.curve.before],
        ["similar", LineTone.Similar, data.curve.similar],
      ],
    );
    assert.deepEqual(
      curve.series.map((line) => line.label),
      [formatDayRange("2026-11-11", "2026-11-17"), "7 days before", "Similar games on Genex"],
    );
    assert.deepEqual(
      curve.legend.map((item) => [item.id, item.label]),
      curve.series.map((line) => [line.id, line.label]),
    );
    assert.deepEqual(curve.ticks, [0, 6], "the days a curve of eight has names for");
    assert.deepEqual(curve.callouts, [0, 6]);
    const month: AnalyticsWindow = { ...WEEK, days: 30 };
    const full = { ...data, curve: { rates: fill(0.1, 30), before: fill(null, 30), similar: null } };
    const whole = viewOf(full, {}, month).curve ?? assert.fail();
    assert.deepEqual(whole.ticks, [0, 6, 13, 20, 29]);
    assert.deepEqual(whole.callouts, [0, 6, 13, 29], "the headline days that have room to be written");
    assert.deepEqual(
      whole.series.map((line) => [line.id, line.label]),
      [["now", formatDayRange("2026-10-19", "2026-11-17")]],
      "a line with nothing known, and similar games when there are too few, are left out",
    );
    const before = { ...data, curve: { rates: fill(null, 3), before: [0.3, 0.2, null], similar: null } };
    assert.deepEqual(
      viewOf(before).curve?.series.map((line) => line.id),
      ["now", "before"],
      "this period's line keeps its place in the legend",
    );
  });

  it("has no curve while nobody of this game's can have come back", () => {
    const data = retentionData();
    const unknown = { rates: fill(null, 30), before: fill(null, 30), similar: fill(0.1, 30) };
    assert.equal(viewOf({ ...data, curve: unknown }).curve, null, "similar games alone are no curve of this game");
    assert.equal(viewOf({ ...data, curve: { rates: [], before: [], similar: null } }).curve, null);
  });

  it("sums the cohorts in a first row: each day's mean weighted by size, over the cells that are known", () => {
    const { formatDayRange, formatWeekday } = bundle.kit;
    const data: RetentionReport = {
      ...retentionData(),
      cohorts: [
        { startsOn: "2026-11-12", size: 300, rates: [0.2, null, null], campaign: "launch_trailer" },
        { startsOn: "2026-11-11", size: 100, rates: [0.4, 0.2, null, null], campaign: null },
        { startsOn: "2026-11-13", size: 0, rates: [0.9, null], campaign: null },
        { startsOn: "2026-11-17", size: 50, rates: [], campaign: null },
      ],
    };
    const cohorts = viewOf(data).cohorts ?? assert.fail("cohorts draw");
    assert.equal(cohorts.size, CohortSize.Day);
    assert.deepEqual(cohorts.columns, ["Day 1", "Day 2"], "as wide as the last day anybody knows");
    const [summary, ...rows] = cohorts.rows;
    assert.deepEqual(
      [summary?.id, summary?.label, summary?.size, summary?.summary, summary?.flag ?? null],
      ["all", formatDayRange("2026-11-11", "2026-11-17"), 450, true, null],
    );
    assert.ok(near(summary?.rates[0], (100 * 0.4 + 300 * 0.2) / 400), `${summary?.rates[0]}`);
    assert.ok(near(summary?.rates[1], 0.2), "only the cohort that knows day 2 counts for it");
    assert.deepEqual(
      rows.map((row) => [row.id, row.label, row.size, row.rates, row.flag ?? null, row.summary ?? false]),
      [
        ["2026-11-11", formatWeekday("2026-11-11"), 100, [0.4, 0.2], null, false],
        [
          "2026-11-12",
          formatWeekday("2026-11-12"),
          300,
          [0.2, null],
          "The launch_trailer campaign brought most of these new players",
          false,
        ],
        ["2026-11-13", formatWeekday("2026-11-13"), 0, [0.9, null], null, false],
        ["2026-11-17", formatWeekday("2026-11-17"), 50, [null, null], null, false],
      ],
      "oldest first, every row as wide as the table, a cell that has not happened null",
    );
    assert.deepEqual(cohorts.campaigns, ["launch_trailer"]);
    assert.equal(cohorts.note, "Days when the launch_trailer campaign brought most new players");
  });

  it("keeps a table of cohorts nobody can have come back from yet, and none when there are no new players", () => {
    const data = retentionData();
    const fresh = { ...data, cohorts: [{ startsOn: ENDS_ON, size: 12, rates: fill(null, 6), campaign: null }] };
    const cohorts = viewOf(fresh).cohorts ?? assert.fail();
    assert.deepEqual(cohorts.columns, ["Day 1"]);
    assert.deepEqual(
      cohorts.rows.map((row) => [row.size, row.rates]),
      [
        [12, [null]],
        [12, [null]],
      ],
      "a mean of nothing is not zero",
    );
    assert.equal(cohorts.note, null);
    assert.equal(viewOf({ ...data, cohorts: [] }).cohorts, null);
    const nobody = { ...data, cohorts: [{ startsOn: ENDS_ON, size: 0, rates: [0.5], campaign: null }] };
    assert.deepEqual(viewOf(nobody).cohorts?.rows[0]?.rates, [null], "nobody to weigh by");
  });

  it("names a week's cohort by its days, cut where the period ends, and says which campaigns the dots are", () => {
    const { formatDayRange } = bundle.kit;
    const data: RetentionReport = {
      ...retentionData(),
      mode: RetentionMode.DayOrLater,
      cohort: CohortSize.Week,
      cohorts: [
        { startsOn: "2026-11-11", size: 400, rates: [0.4], campaign: "launch_trailer" },
        { startsOn: "2026-11-16", size: 90, rates: [null], campaign: "creator_collab" },
        { startsOn: "2026-11-15", size: 10, rates: [null], campaign: "launch_trailer" },
      ],
    };
    const cohorts = viewOf(data).cohorts ?? assert.fail();
    assert.equal(cohorts.size, CohortSize.Week);
    assert.deepEqual(cohorts.columns, ["Week 1"]);
    assert.deepEqual(
      cohorts.rows.map((row) => row.label),
      [
        formatDayRange("2026-11-11", "2026-11-17"),
        formatDayRange("2026-11-11", "2026-11-15"),
        formatDayRange("2026-11-15", "2026-11-15"),
        formatDayRange("2026-11-16", "2026-11-17"),
      ],
      "Wednesday to Sunday, a Sunday alone, and Monday to the period's last day",
    );
    assert.deepEqual(cohorts.campaigns, ["launch_trailer", "creator_collab"]);
    assert.equal(
      cohorts.note,
      `Weeks when one campaign brought most new players: ${formatList(["launch_trailer", "creator_collab"])}`,
    );
    assert.equal(
      viewOf({ ...data, cohorts: data.cohorts.slice(0, 1) }).cohorts?.note,
      "Weeks when the launch_trailer campaign brought most new players",
    );
    assert.match(cohorts.hint, /each week’s new players .* weeks later, or any week after/);
    assert.match(viewOf(retentionData()).cohorts?.hint ?? "", /each day’s new players .* days later\. Empty cells/);
    assert.deepEqual(
      [cohorts.title, cohorts.caption, viewOf(retentionData()).cohorts?.title],
      ["By first-play week", "Retention by first-play week", "By first-play day"],
    );
  });

  it("names each group by its vocabulary, and totals them against everyone's headline days", () => {
    const row = (key: string, newPlayers = 10) => ({ key, newPlayers, day1: 0.3, day7: null, day30: null });
    const groups = (segmentBy: SegmentBy, keys: string[]) =>
      viewOf({ ...retentionData(), segmentBy, segments: keys.map((key) => row(key)) }).segments;
    const place = viewOf(retentionData()).segments;
    assert.equal(place.by, SegmentBy.Place);
    assert.equal(place.caption, "Retention by where new players play");
    assert.deepEqual(
      place.rows.map((one) => [one.id, one.label, one.newPlayers, one.day1, one.day7, one.day30]),
      [
        [PlayPlace.Browser, "Browser, on genex.games", 5720, 0.314, 0.122, 0.041],
        [PlayPlace.GenexApp, "Genex app, in Play", 1180, 0.379, 0.166, null],
        [PlayPlace.Installed, "Installed on their computer", 940, 0.491, null, null],
      ],
    );
    assert.deepEqual(place.total, {
      id: "all",
      label: "All new players",
      newPlayers: retentionData().cohorts.reduce((total, cohort) => total + cohort.size, 0),
      day1: 0.345,
      day7: 0.145,
      day30: null,
    });
    assert.deepEqual(
      groups(SegmentBy.Channel, Object.values(SourceChannel)).rows.map((one) => one.label),
      ["Genex", "Campaigns", "Social", "Direct", "Search engines", "Other sites"],
    );
    assert.deepEqual(
      groups(SegmentBy.Device, Object.values(DeviceClass)).rows.map((one) => one.label),
      ["Computer", "Phone", "Tablet"],
    );
    assert.deepEqual(
      groups(SegmentBy.Version, ["1.4.0", "constructor"]).rows.map((one) => one.label),
      ["1.4.0", "constructor"],
      "a version reads as it was written",
    );
    assert.deepEqual(
      groups(SegmentBy.Place, ["console", "toString", "browser"]).rows.map((one) => one.label),
      ["console", "toString", "Browser, on genex.games"],
      "a key with no name keeps its own",
    );
    setLocale(Locale.English, {});
    assert.deepEqual(
      groups(SegmentBy.Country, ["US", "BR"]).rows.map((one) => one.label),
      ["United States", "Brazil"],
      "English words, whatever language the computer is set to",
    );
    assert.deepEqual(
      groups(SegmentBy.Country, ["ZZ"]).rows.map((one) => one.label),
      ["Unknown Region"],
      "a country genex.games could not tell, named as Acquisition names it",
    );
    setLocale(Locale.German, {});
    assert.deepEqual(
      groups(SegmentBy.Country, ["US", "BR", "usa", "ZZ"]).rows.map((one) => one.label),
      ["Vereinigte Staaten", "Brasilien", "usa", "Unbekannte Region"],
      "a country in the app's language; what is no country code keeps its text",
    );
    const none = viewOf({ ...retentionData(), segments: [] }).segments;
    assert.deepEqual([none.rows, none.total], [[], null]);
  });

  it("counts everyone in the total row, as its rates do, when the groups listed are only the largest", () => {
    const data = retentionData();
    const everyone = data.cohorts.reduce((total, cohort) => total + cohort.size, 0);
    const largest = viewOf({ ...data, segments: [{ key: "US", newPlayers: 1300, day1: 0.3, day7: 0.1, day30: null }] });
    assert.equal(largest.segments.total?.newPlayers, everyone, "the new players the headline's rates are about");
    assert.notEqual(everyone, 1300);
  });

  it("gives the comparison its columns, the group's words hidden from replays only when the creator wrote them", () => {
    const { ColumnKind } = bundle.kit;
    const columns = bundle.view.segmentColumns(SegmentBy.Place);
    assert.deepEqual(
      columns.map((column) => [column.id, column.label, column.kind]),
      [
        ["group", "Group", ColumnKind.Text],
        ["newPlayers", "New players", ColumnKind.Number],
        ["day1", "Day 1", ColumnKind.Rate],
        ["day7", "Day 7", ColumnKind.Rate],
        ["day30", "Day 30", ColumnKind.Rate],
      ],
    );
    const one = { id: "browser", label: "Browser", newPlayers: 5, day1: 0.3, day7: null, day30: null };
    assert.deepEqual(
      columns.map((column) => column.value(one)),
      ["Browser", 5, 0.3, null, null],
    );
    const masked = (by: SegmentBy) => bundle.view.segmentColumns(by)[0]?.mask === true;
    assert.deepEqual(Object.values(SegmentBy).map(masked), [false, false, false, false, true]);
  });

  it("stacks each week's players: new, stayed and back, with those who left under the line", () => {
    const { SeriesSlot, formatDay } = bundle.kit;
    const data = retentionData();
    const weeks = viewOf({ ...data, weeks: data.weeks.toReversed() }).weeks ?? assert.fail("weeks draw");
    assert.deepEqual(weeks.labels, [formatDay("2026-11-02"), formatDay("2026-11-09")], "oldest first");
    assert.deepEqual(
      weeks.series.map((one) => [one.id, one.label, one.slot, one.values]),
      [
        ["fresh", "New", SeriesSlot.First, [3319, 2110]],
        ["stayed", "Played the week before too", SeriesSlot.Third, [830, 1520]],
        ["back", "Back after 2 weeks or more", SeriesSlot.Fifth, [210, 260]],
      ],
    );
    assert.deepEqual(weeks.below, { id: "left", label: "Did not return this week", values: [1036, 2839] });
    assert.equal(weeks.hint, `Week of ${formatDay("2026-11-09")}: 3,890 players`);
    const one = { startsOn: "2026-11-09", fresh: 1, stayed: 0, back: 0, left: 4 };
    assert.equal(viewOf({ ...data, weeks: [one] }).weeks?.hint, `Week of ${formatDay("2026-11-09")}: 1 player`);
    assert.equal(viewOf({ ...data, weeks: [] }).weeks, null);
  });

  /** A section of the report, from its opening tag to its end. */
  const sectionOf = (markup: string, id: string): string =>
    new RegExp(`<section[^>]*data-game-analytics-section="${id}".*?</section>`).exec(markup)?.[0] ?? "";
  /** The words and numbers of some markup, tags taken out and cells told apart by a bar. */
  const textOf = (markup: string): string =>
    markup
      .replace(/<svg.*?<\/svg>/g, "")
      .replace(/<\/(?:span|td|th)>/g, "|")
      .replace(/<[^>]*>/g, "")
      .replace(/\|+/g, "|")
      .replace(/^\||\|$/g, "");
  /** The row of a data table with this id, as the words and numbers it holds. */
  const rowText = (markup: string, id: string): string =>
    textOf(new RegExp(`data-game-analytics-row="${id}"[^>]*>(.*?)</div>`).exec(markup)?.[1] ?? "");
  const checked = (markup: string, id: string): string | undefined =>
    new RegExp(
      `data-game-analytics-switch="${id}">.*?aria-checked="true"[^>]*data-game-analytics-option="([a-z_]+)"`,
    ).exec(markup)?.[1];

  it("draws a rich game's report: five tiles, three switches, the curve, the cohorts, the groups and the weeks", () => {
    const { formatPercent } = bundle.kit;
    const { answer } = asked(RICH, 30);
    const markup = drawReport(answer);
    assert.match(markup, /^<div class="game-analytics-report" data-game-analytics-report="retention">/);
    assert.deepEqual(
      [...markup.matchAll(/data-game-analytics-tile="([a-z0-9]+)"/g)].map((match) => match[1]),
      RETENTION_DAYS.map((day) => `day${day}`),
    );
    assert.deepEqual(
      [...markup.matchAll(/data-game-analytics-switch="([a-z-]+)"/g)].map((match) => match[1]),
      ["mode", "cohort", "segment-by"],
    );
    assert.deepEqual(
      [checked(markup, "mode"), checked(markup, "cohort"), checked(markup, "segment-by")],
      [RetentionMode.OnDay, CohortSize.Day, SegmentBy.Place],
      "what genex.games picked, as nothing was asked",
    );
    assert.deepEqual(
      [...markup.matchAll(/data-game-analytics-section="([a-z]+)"/g)].map((match) => match[1]),
      ["curve", "cohorts", "segments", "weeks"],
    );
    const day1 = answer.data.headline[0] ?? assert.fail();
    assert.match(
      textOf(/data-game-analytics-tile="day1".*?<\/div>/.exec(markup)?.[0] ?? ""),
      new RegExp(`Day 1\\|${formatPercent(day1.rate)}\\|`),
    );
    assert.equal(rowText(markup, "browser"), "Browser, on genex.games|5,720|31.4%|12.2%|4.1%");
    assert.equal(rowText(markup, "genex_app"), "Genex app, in Play|1,180|37.9%|16.6%|6.4%");
    assert.equal(rowText(markup, "installed"), "Installed on their computer|940|49.1%|26.1%|11.2%");
    assert.match(
      rowText(markup, "all"),
      /^All new players\|7,840\|/,
      "everyone's new players, as the cohorts count them",
    );
    assert.match(markup, /data-game-analytics-row="all"[^>]*data-total="true"/);
    assert.match(markup, /<tr data-game-analytics-cohort="all" data-summary="true">/, "the first row sums the cohorts");
    assert.match(markup, /data-game-analytics-chart="curve"/);
    assert.match(markup, /data-game-analytics-chart="weeks"/);
  });

  it("shows each switch at what was asked, while the numbers stay the answer's until the new one lands", () => {
    const { answer } = asked(RICH, 30);
    const markup = drawReport(answer, {
      mode: RetentionMode.DayOrLater,
      cohort: CohortSize.Week,
      segmentBy: SegmentBy.Country,
    });
    assert.deepEqual(
      [checked(markup, "mode"), checked(markup, "cohort"), checked(markup, "segment-by")],
      [RetentionMode.DayOrLater, CohortSize.Week, SegmentBy.Country],
    );
    assert.match(markup, /By first-play day/, "the table is still the day cohorts the answer holds");
    assert.match(markup, /Retention by where new players play/);
  });

  it("names the first-play weeks and says what the dots under the table mean", () => {
    const { answer, data } = asked(RICH, 30, { cohort: CohortSize.Week });
    const markup = drawReport(answer);
    const cohorts = sectionOf(markup, "cohorts");
    assert.match(cohorts, /By first-play week/);
    assert.match(cohorts, /<th scope="col">Week 1<\/th>/);
    const flagged = data.cohorts.filter((cohort) => cohort.campaign !== null);
    assert.ok(flagged.length > 0, "the campaign's week is flagged");
    assert.equal(
      (cohorts.match(/class="game-analytics-flag"/g) ?? []).length,
      flagged.length + 1,
      "a dot for each flagged week, and the one beside the note",
    );
    const note = bundle.view.retentionView(answer, {}).cohorts?.note ?? assert.fail("the dots are explained");
    assert.match(cohorts, new RegExp(`data-game-analytics-flag-note="true">.*?${note}`));
  });

  it("leaves a rate that cannot be known as a dash or an empty cell, never as zero", () => {
    const { DASH } = bundle.kit;
    const { answer, data } = asked(YOUNG, 7);
    const markup = drawReport(answer);
    const unknown = data.headline.filter((point) => point.rate === null);
    assert.ok(unknown.length > 0, "the young game has days that have not passed");
    for (const point of unknown) {
      const tile = new RegExp(`data-game-analytics-tile="day${point.day}".*?</div>`).exec(markup)?.[0] ?? "";
      assert.match(tile, new RegExp(`data-missing="true">${DASH}</span>`), `day ${point.day} is a dash`);
      assert.doesNotMatch(tile, /data-direction/, `day ${point.day} has no change to show`);
    }
    assert.doesNotMatch(markup, /\b0\.0%/, "no zero stands in for a rate nobody can know");
  });

  it("draws an empty report as notes saying so: dashes in the tiles, no table, no chart", () => {
    const { answer } = asked(RICH, 30);
    const empty: Answer = {
      ...answer,
      data: {
        mode: RetentionMode.OnDay,
        cohort: CohortSize.Day,
        headline: RETENTION_DAYS.map((day) => ({ day, rate: null, before: null, similar: null })),
        curve: { rates: [], before: [], similar: null },
        cohorts: [],
        segmentBy: SegmentBy.Place,
        segments: [],
        weeks: [],
      },
    };
    const markup = drawReport(empty);
    assert.equal((markup.match(/data-game-analytics-empty="true"/g) ?? []).length, 4, "curve, cohorts, groups, weeks");
    assert.equal((markup.match(/data-missing="true"/g) ?? []).length, RETENTION_DAYS.length);
    assert.doesNotMatch(markup, /<table|data-game-analytics-chart|role="table"/);
    assert.match(markup, /No new players in these days\./);
    assert.match(markup, /This fills in after the game’s first whole week/);
  });

  it("writes what a person wrote as text, and keeps it out of usage recordings", () => {
    const { answer, data } = asked(RICH, 30);
    const wrote = "<img src=x onerror=alert(1)>";
    const cohorts = data.cohorts.map((cohort, at) => (at === 0 ? { ...cohort, campaign: wrote } : cohort));
    const hostile: Answer = {
      ...answer,
      data: {
        ...data,
        cohorts,
        segmentBy: SegmentBy.Version,
        segments: [{ key: "<b>1.0</b>", newPlayers: 12, day1: 0.3, day7: null, day30: null }],
      },
    };
    const markup = drawReport(hostile);
    assert.doesNotMatch(markup, /<img src=x|<b>1\.0/);
    assert.match(markup, /&lt;b&gt;1\.0&lt;\/b&gt;/);
    assert.match(sectionOf(markup, "cohorts"), /data-analytics-mask="true">[^<]*&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(sectionOf(markup, "segments"), /title="&lt;b&gt;1\.0&lt;\/b&gt;" data-analytics-mask="true"/);
    assert.doesNotMatch(
      sectionOf(drawReport(answer), "segments"),
      /data-analytics-mask/,
      "the app's own words need no hiding",
    );
  });
});
