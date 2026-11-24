/**
 * The Installs report of a game's analytics, end to end: what main reads from genex.games (a
 * hostile body never reads as numbers, a number that cannot be known stays null), what a fixture
 * launch answers for every period and kind of game, what the page derives from an answer, and the
 * face the report draws.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { build } from "esbuild";
import type { ReactElement } from "react";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { fixtureInstalls } from "../../src/main/dev/fixture-game-analytics/fixture-installs.ts";
import { createFixtureGameAnalytics } from "../../src/main/dev/fixture-game-analytics/index.ts";
import {
  type GameSample,
  gameSample,
  SampleKind,
  type SampleSource,
} from "../../src/main/dev/fixture-game-analytics/sample.ts";
import { FixtureAccount, fixtureAccountToken } from "../../src/main/dev/fixture-people.ts";
import { isRecord } from "../../src/main/play/gallery.ts";
import { toInstallsReport } from "../../src/main/play/game-analytics/report-installs.ts";
import { toReportAnswer } from "../../src/main/play/game-analytics/reports.ts";
import { reportRoute } from "../../src/main/play/game-analytics/routes.ts";
import type { InstallsView } from "../../src/renderer/play/game-analytics/installs-view.ts";
import { formatDay } from "../../src/renderer/play/game-analytics/kit/format.ts";
import type { ReportAnswer, ReportProps } from "../../src/renderer/play/game-analytics/report-props.ts";
import {
  type AnalyticsWindow,
  Attribution,
  GameReport,
  InsightKind,
  InstallBlock,
  InstallStep,
  type InstallsReport,
  OsFamily,
  PlayPlace,
  ReadKind,
  RetentionMode,
  SourceChannel,
} from "../../src/shared/game-analytics.ts";
import { setLocale } from "../../src/shared/i18n.ts";
import { Locale } from "../../src/shared/locale.ts";
import { dayBefore, STATS_PERIODS, type StatsPeriod } from "../../src/shared/play-stats.ts";

const DAYS = 7;
const WINDOW: AnalyticsWindow = { days: DAYS, endsOn: "2026-11-17", computedAt: "2026-11-17T12:00:00.000Z" };
const fill = <T>(value: T, length = DAYS): T[] => Array.from({ length }, () => value);

/** An Installs report as genex.games answers it for a week, every part of it well formed. */
const installsData = (): InstallsReport => ({
  installs: { now: 70, before: 56 },
  opened: { now: 62, before: 48 },
  installedNow: { now: 410, before: 360 },
  removed: 20,
  funnel: [
    { step: InstallStep.Offered, people: 500 },
    { step: InstallStep.Pressed, people: 90 },
    { step: InstallStep.Downloaded, people: 76 },
    { step: InstallStep.Installed, people: 70 },
    { step: InstallStep.Opened, people: 62 },
  ],
  blocked: [
    { reason: InstallBlock.MacIntel, people: 12 },
    { reason: InstallBlock.OldSystem, people: 9 },
    { reason: InstallBlock.LinuxArm, people: 4 },
    { reason: InstallBlock.Other, people: 1 },
  ],
  daily: [
    { os: OsFamily.Windows, installs: fill(6) },
    { os: OsFamily.MacArm, installs: fill(3) },
    { os: OsFamily.MacIntel, installs: [1, 0, 1, 0, 1, 0, 1] },
    { os: OsFamily.Linux, installs: [0, 1, 0, 1, 0, 1, 0] },
  ],
  systems: [
    { os: OsFamily.Windows, installs: 42, opened: 37, downloadSeconds: 52, failed: 0.034 },
    { os: OsFamily.MacArm, installs: 21, opened: 19, downloadSeconds: 41.5, failed: 0.022 },
    { os: OsFamily.MacIntel, installs: 4, opened: 3, downloadSeconds: null, failed: null },
    { os: OsFamily.Linux, installs: 3, opened: 3, downloadSeconds: 47, failed: 0 },
  ],
  places: [
    {
      place: PlayPlace.Installed,
      newPlayers: 70,
      day1: 0.491,
      day7: null,
      medianPlaySeconds: 800,
      playsPerPlayerDay: 1.9,
      nexPerPlayer: 9.4,
    },
    {
      place: PlayPlace.Browser,
      newPlayers: 610,
      day1: 0.314,
      day7: 0.122,
      medianPlaySeconds: 290.5,
      playsPerPlayerDay: 1.3,
      nexPerPlayer: null,
    },
  ],
  versions: [
    { version: "1.4.0", publishedOn: "2026-11-09", installed: 291 },
    { version: "1.3.2", publishedOn: "2026-10-21", installed: 90 },
    { version: "1.3.0", publishedOn: null, installed: 29 },
  ],
  updateDays: 1.2,
  channels: [
    { channel: SourceChannel.Genex, people: 34 },
    { channel: SourceChannel.Campaigns, people: 19 },
    { channel: SourceChannel.Direct, people: 9 },
    { channel: SourceChannel.Social, people: 5 },
    { channel: SourceChannel.Search, people: 2 },
    { channel: SourceChannel.Other, people: 1 },
  ],
});

/** `target` with the value at `path` replaced (undefined reads as a missing part). */
function withAt(target: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return value;
  if (Array.isArray(target)) return target.map((item, index) => (index === head ? withAt(item, rest, value) : item));
  return isRecord(target) ? { ...target, [head]: withAt(target[String(head)], rest, value) } : target;
}

const read = (data: unknown, window: AnalyticsWindow = WINDOW) => toInstallsReport(data, window);
/** The report read from a well-formed body with one value replaced. */
const readWith = (path: readonly (string | number)[], value: unknown) => read(withAt(installsData(), path, value));
const BIDI = "‮";
const BELL = "\u0007";

describe("the Installs report as main reads it", () => {
  it("reads a well-formed body exactly as it was sent", () => {
    const sent = installsData();
    assert.deepEqual(read(JSON.parse(JSON.stringify(sent))), sent);
  });

  it("keeps what cannot be known yet as null, never as zero", () => {
    const report = read(installsData()) ?? assert.fail("a well-formed body reads");
    const [installed, browser] = report.places;
    assert.equal(installed?.day7, null);
    assert.equal(browser?.nexPerPlayer, null);
    assert.equal(report.systems[2]?.downloadSeconds, null);
    assert.equal(report.systems[2]?.failed, null);
    assert.equal(report.versions[2]?.publishedOn, null);
    assert.equal(readWith(["updateDays"], null)?.updateDays, null);
    const unripe = readWith(["places", 1], {
      place: PlayPlace.Browser,
      newPlayers: 0,
      day1: null,
      day7: null,
      medianPlaySeconds: null,
      playsPerPlayerDay: null,
      nexPerPlayer: null,
    });
    assert.deepEqual(unripe?.places[1], {
      place: PlayPlace.Browser,
      newPlayers: 0,
      day1: null,
      day7: null,
      medianPlaySeconds: null,
      playsPerPlayerDay: null,
      nexPerPlayer: null,
    });
  });

  it("refuses a body that is not a report, and one with a fixed part missing or broken", () => {
    for (const body of [null, undefined, 7, "installs", [], [installsData()]]) assert.equal(read(body), null);
    const table: [path: (string | number)[], value: unknown, why: string][] = [
      [["installs"], undefined, "no installs"],
      [["installs"], 70, "installs as one number"],
      [["installs", "now"], -1, "a negative count"],
      [["installs", "now"], 70.5, "a fractional count"],
      [["installs", "now"], "70", "a count as text"],
      [["installs", "before"], null, "a count that is null"],
      [["installs", "now"], Number.MAX_SAFE_INTEGER + 2, "a count past what a number holds"],
      [["opened"], undefined, "no opened"],
      [["opened", "before"], Number.NaN, "a count that is not a number"],
      [["opened", "now"], 71, "more opened than installed"],
      [["opened", "before"], 57, "more opened than installed, before"],
      [["installedNow"], undefined, "no installed now"],
      [["installedNow", "now"], Number.POSITIVE_INFINITY, "an endless count"],
      [["installedNow", "before"], -3, "a negative count before"],
      [["removed"], undefined, "no removed"],
      [["removed"], null, "removed that is null"],
      [["removed"], 2.5, "a fractional removed"],
      [["removed"], -2, "a negative removed"],
      [["funnel"], undefined, "no funnel"],
      [["funnel"], { offered: 500 }, "a funnel that is no list"],
      [["blocked"], undefined, "no blocked"],
      [["blocked"], "none", "blocked that is no list"],
      [["daily"], undefined, "no daily"],
      [["daily"], { windows: fill(6) }, "daily that is no list"],
      [["systems"], undefined, "no systems"],
      [["systems"], null, "systems that is null"],
      [["places"], undefined, "no places"],
      [["places"], 2, "places that is a number"],
      [["versions"], undefined, "no versions"],
      [["versions"], "1.4.0", "versions that is text"],
      [["updateDays"], undefined, "no update days"],
      [["updateDays"], -1, "negative update days"],
      [["updateDays"], "1.2", "update days as text"],
      [["updateDays"], Number.POSITIVE_INFINITY, "endless update days"],
      [["channels"], undefined, "no channels"],
      [["channels"], { genex: 34 }, "channels that is no list"],
    ];
    for (const [path, value, why] of table) assert.equal(readWith(path, value), null, why);
  });

  it("drops a row it cannot read and keeps the rest", () => {
    const table: [list: keyof InstallsReport, path: (string | number)[], value: unknown, why: string][] = [
      ["funnel", ["step"], "refunded", "a step the app does not know"],
      ["funnel", ["people"], -5, "a negative step"],
      ["funnel", ["people"], 1.5, "a fractional step"],
      ["funnel", [], null, "a step that is null"],
      ["blocked", ["reason"], "no_gpu", "a reason the app does not know"],
      ["blocked", ["people"], "12", "a count as text"],
      ["blocked", [], "mac_intel", "a row that is text"],
      ["daily", ["os"], "android", "a system the app does not know"],
      ["daily", ["installs"], fill(6, DAYS - 1), "a series a day short"],
      ["daily", ["installs"], fill(6, DAYS + 1), "a series a day long"],
      ["daily", ["installs"], [6, 6, 6, -1, 6, 6, 6], "a negative day"],
      ["daily", ["installs"], [6, 6, 6, 0.5, 6, 6, 6], "a fractional day"],
      ["daily", ["installs"], [6, 6, 6, null, 6, 6, 6], "a day that is null"],
      ["daily", ["installs"], "6666666", "a series that is text"],
      ["systems", ["os"], "ios", "a system the app does not know"],
      ["systems", ["installs"], -1, "negative installs"],
      ["systems", ["opened"], 43, "more opened than installed"],
      ["systems", ["opened"], undefined, "no opened"],
      ["systems", ["downloadSeconds"], -4, "a negative download time"],
      ["systems", ["downloadSeconds"], undefined, "no download time"],
      ["systems", ["downloadSeconds"], Number.POSITIVE_INFINITY, "an endless download time"],
      ["systems", ["failed"], 1.01, "a failed share over 1"],
      ["systems", ["failed"], -0.01, "a failed share under 0"],
      ["systems", ["failed"], "3%", "a failed share as text"],
      ["places", ["place"], "console", "a place the app does not know"],
      ["places", ["newPlayers"], 0.5, "fractional new players"],
      ["places", ["day1"], 1.2, "Day 1 over 1"],
      ["places", ["day1"], undefined, "no Day 1"],
      ["places", ["day7"], -0.1, "Day 7 under 0"],
      ["places", ["medianPlaySeconds"], -1, "a negative play length"],
      ["places", ["playsPerPlayerDay"], "1.9", "plays as text"],
      ["places", ["nexPerPlayer"], Number.NaN, "Nex that is not a number"],
      ["versions", ["version"], "", "a version with no name"],
      ["versions", ["version"], `${BIDI}${BELL} `, "a version of nothing but controls"],
      ["versions", ["version"], "9".repeat(41), "a version too long to be one"],
      ["versions", ["version"], 14, "a version that is a number"],
      ["versions", ["publishedOn"], "2026-02-30", "a publish day that does not exist"],
      ["versions", ["publishedOn"], "yesterday", "a publish day in words"],
      ["versions", ["publishedOn"], undefined, "no publish day"],
      ["versions", ["installed"], -1, "a negative installed"],
      ["versions", ["installed"], 411, "more computers than have the game"],
      ["channels", ["channel"], "podcast", "a channel the app does not know"],
      ["channels", ["people"], 3.3, "fractional people"],
    ];
    for (const [list, path, value, why] of table) {
      const whole = installsData()[list];
      const report = readWith([list, 0, ...path], value) ?? assert.fail(`${why}: the report still reads`);
      const kept = report[list];
      assert.ok(Array.isArray(whole) && Array.isArray(kept));
      assert.deepEqual(kept, whole.slice(1), why);
    }
  });

  it("keeps one row for each system, step, reason, place, version and channel: the first sent", () => {
    const data = installsData();
    const twice = {
      ...data,
      funnel: [...data.funnel, { step: InstallStep.Offered, people: 1 }],
      blocked: [...data.blocked, { reason: InstallBlock.MacIntel, people: 1 }],
      daily: [...data.daily, { os: OsFamily.Windows, installs: fill(1) }],
      systems: [...data.systems, { os: OsFamily.Windows, installs: 1, opened: 1, downloadSeconds: 1, failed: 0 }],
      places: [...data.places, { ...data.places[0], newPlayers: 1 }],
      versions: [...data.versions, { version: "1.4.0", publishedOn: null, installed: 1 }],
      channels: [...data.channels, { channel: SourceChannel.Genex, people: 1 }],
    };
    assert.deepEqual(read(twice), data);
  });

  it("cuts an oversized list to what a page can show", () => {
    const versions = Array.from({ length: 5000 }, (_, index) => ({
      version: `1.0.${index}`,
      publishedOn: null,
      installed: 0,
    }));
    const report = readWith(["versions"], versions) ?? assert.fail();
    assert.ok(report.versions.length <= 50, `${report.versions.length} versions`);
    assert.equal(report.versions[0]?.version, "1.0.0", "the first ones sent");
    const systems = Array.from({ length: 5000 }, () => installsData().systems).flat();
    assert.equal(readWith(["systems"], systems)?.systems.length, 4);
    const steps = Array.from({ length: 5000 }, () => installsData().funnel).flat();
    assert.equal(readWith(["funnel"], steps)?.funnel.length, 5);
  });

  it("cleans a version of the characters that turn text around or control a terminal", () => {
    const report = readWith(["versions", 0, "version"], `  ${BIDI}1.4.0${BELL}\n-beta  `) ?? assert.fail();
    assert.equal(report.versions[0]?.version, "1.4.0-beta");
  });

  it("reads each system's installs over the period that was asked, not another", () => {
    const month: AnalyticsWindow = { ...WINDOW, days: 30 };
    assert.deepEqual(read(installsData(), month)?.daily, [], "a week's series is not a month's");
    const data = withAt(installsData(), ["daily"], [{ os: OsFamily.Windows, installs: fill(2, 30) }]);
    assert.deepEqual(read(data, month)?.daily, [{ os: OsFamily.Windows, installs: fill(2, 30) }]);
  });

  it("takes an answer with nothing in it: no installs, empty lists", () => {
    const empty: InstallsReport = {
      installs: { now: 0, before: 0 },
      opened: { now: 0, before: 0 },
      installedNow: { now: 0, before: 0 },
      removed: 0,
      funnel: [],
      blocked: [],
      daily: [],
      systems: [],
      places: [],
      versions: [],
      updateDays: null,
      channels: [],
    };
    assert.deepEqual(read(empty), empty);
  });
});

const NOW = Date.parse("2026-11-17T12:04:00.000Z");
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
/** A made-up game with an app build, of one kind. */
const sourceOf = (kind: SampleKind, dormant = false): SampleSource => ({
  slug: `fx-${kind}`,
  title: "Lantern Run",
  coverUrl: null,
  plays: 5285,
  playingNow: 8,
  hasAppBuild: true,
  kind,
  dormant,
});
const sampleOf = (kind: SampleKind, days: StatsPeriod, dormant = false): GameSample =>
  gameSample(sourceOf(kind, dormant), days, NOW);
/** Every kind of game over every period, lively and silent for two weeks. */
const everySample = (): GameSample[] =>
  Object.values(SampleKind).flatMap((kind) =>
    STATS_PERIODS.flatMap((days) => [sampleOf(kind, days), sampleOf(kind, days, true)]),
  );
const named = (sample: GameSample): string => `${sample.game.slug} over ${sample.window.days} days`;
const stepOf = (report: InstallsReport, step: InstallStep): number | undefined =>
  report.funnel.find((row) => row.step === step)?.people;

describe("a fixture game's Installs report", () => {
  it("is read by the real parser for every period and kind of game, exactly as it was made", () => {
    for (const sample of everySample()) {
      const made = fixtureInstalls(sample, {});
      assert.deepEqual(toInstallsReport(JSON.parse(JSON.stringify(made)), sample.window), made, named(sample));
    }
  });

  it("takes no options: asked with any, it answers the same", () => {
    const sample = sampleOf(SampleKind.Rich, 30);
    const asked = fixtureInstalls(sample, { attribution: Attribution.Latest, mode: RetentionMode.DayOrLater });
    assert.deepEqual(asked, fixtureInstalls(sample, {}));
  });

  it("agrees with the game's sample and with itself", () => {
    for (const sample of everySample()) {
      const name = named(sample);
      const report = fixtureInstalls(sample, {});
      const installs = sample.installs ?? assert.fail("a game with an app build has installs");
      assert.deepEqual(report.installs, { now: installs.now, before: installs.before }, name);
      const perDay = installs.daily.map((_, day) => sum(report.daily.map((row) => row.installs[day] ?? 0)));
      assert.deepEqual(perDay, installs.daily, `${name}: the systems sum to the installs of each day`);
      for (const system of report.systems) {
        const daily = report.daily.find((row) => row.os === system.os) ?? assert.fail(`${name}: ${system.os} per day`);
        assert.equal(sum(daily.installs), system.installs, `${name}: ${system.os} over the period`);
        assert.ok(system.installs > 0, `${name}: a system nobody installed on is not listed`);
      }
      assert.equal(report.daily.length, report.systems.length, name);
      assert.equal(sum(report.systems.map((row) => row.installs)), installs.now, name);
      assert.equal(sum(report.systems.map((row) => row.opened)), report.opened.now, name);
      assert.equal(sum(report.channels.map((row) => row.people)), installs.now, name);
      assert.deepEqual(
        report.channels.map((row) => row.people),
        report.channels.map((row) => row.people).toSorted((a, b) => b - a),
        `${name}: most installs first`,
      );
      assert.equal(stepOf(report, InstallStep.Installed), installs.now, name);
      assert.equal(stepOf(report, InstallStep.Opened), report.opened.now, name);
      const steps = Object.values(InstallStep).map((step) => stepOf(report, step) ?? assert.fail(`${name}: ${step}`));
      assert.deepEqual(
        steps,
        steps.toSorted((a, b) => b - a),
        `${name}: fewer people at each step`,
      );
      assert.ok((steps[0] ?? 0) <= sample.newVisitors.now, `${name}: nobody saw Install without visiting`);
      assert.equal(
        report.installedNow.now,
        report.installedNow.before + installs.now - report.removed,
        `${name}: installed now is what was there, plus the installs, minus the removals`,
      );
      assert.equal(sum(report.versions.map((row) => row.installed)), report.installedNow.now, name);
      assert.equal(sum(report.places.map((row) => row.newPlayers)), sample.newPlayers.now, name);
    }
  });

  it("is the design's month for the rich game", () => {
    const sample = sampleOf(SampleKind.Rich, 30);
    const report = fixtureInstalls(sample, {});
    assert.deepEqual(report.installs, { now: 1060, before: 768 });
    assert.deepEqual(report.opened, { now: 940, before: 667 });
    assert.deepEqual(report.installedNow, { now: 2870, before: 2120 });
    assert.equal(report.removed, 310);
    assert.deepEqual(report.funnel, [
      { step: InstallStep.Offered, people: 6840 },
      { step: InstallStep.Pressed, people: 1240 },
      { step: InstallStep.Downloaded, people: 1092 },
      { step: InstallStep.Installed, people: 1060 },
      { step: InstallStep.Opened, people: 940 },
    ]);
    assert.deepEqual(report.blocked, [
      { reason: InstallBlock.MacIntel, people: 180 },
      { reason: InstallBlock.OldSystem, people: 150 },
      { reason: InstallBlock.LinuxArm, people: 90 },
    ]);
    assert.deepEqual(report.systems, [
      { os: OsFamily.Windows, installs: 610, opened: 536, downloadSeconds: 52, failed: 0.034 },
      { os: OsFamily.MacArm, installs: 360, opened: 326, downloadSeconds: 41, failed: 0.022 },
      { os: OsFamily.MacIntel, installs: 50, opened: 43, downloadSeconds: 58, failed: 0.041 },
      { os: OsFamily.Linux, installs: 40, opened: 35, downloadSeconds: 47, failed: 0.05 },
    ]);
    assert.deepEqual(report.places, [
      {
        place: PlayPlace.Installed,
        newPlayers: 1060,
        day1: 0.491,
        day7: 0.261,
        medianPlaySeconds: 800,
        playsPerPlayerDay: 1.9,
        nexPerPlayer: 9.4,
      },
      {
        place: PlayPlace.Browser,
        newPlayers: 6780,
        day1: 0.314,
        day7: 0.122,
        medianPlaySeconds: 290,
        playsPerPlayerDay: 1.3,
        nexPerPlayer: 3.1,
      },
    ]);
    assert.deepEqual(report.versions.slice(0, 2), [
      { version: "1.4.0", publishedOn: "2026-11-09", installed: 2038 },
      { version: "1.3.2", publishedOn: "2026-10-21", installed: 631 },
    ]);
    assert.equal(report.versions[2]?.publishedOn, "2026-09-30");
    assert.equal(sum(report.versions.slice(2).map((row) => row.installed)), 201, "the older versions together");
    assert.equal(report.updateDays, 1.2);
    assert.deepEqual(report.channels, [
      { channel: SourceChannel.Genex, people: 520 },
      { channel: SourceChannel.Campaigns, people: 290 },
      { channel: SourceChannel.Direct, people: 140 },
      { channel: SourceChannel.Social, people: 80 },
      { channel: SourceChannel.Search, people: 20 },
      { channel: SourceChannel.Other, people: 10 },
    ]);
  });

  it("names the sample's release as the newest version, and repeats the sample's own numbers", () => {
    for (const kind of [SampleKind.Rich, SampleKind.Steady]) {
      for (const days of STATS_PERIODS) {
        const sample = sampleOf(kind, days);
        const report = fixtureInstalls(sample, {});
        const [newest, ...older] = report.versions;
        assert.deepEqual(
          [newest?.version, newest?.publishedOn],
          [sample.release.version, sample.release.on],
          named(sample),
        );
        for (const row of older)
          assert.ok(row.publishedOn === null || row.publishedOn < sample.release.on, row.version);
        const insight = sample.insights.find((one) => one.kind === InsightKind.InstalledRetention);
        const [installed, browser] = report.places;
        if (insight?.kind === InsightKind.InstalledRetention)
          assert.deepEqual(
            [installed?.day7, browser?.day7],
            [insight.day7Installed, insight.day7Browser],
            named(sample),
          );
        const day1 = sample.day1.now ?? assert.fail();
        assert.ok(
          (installed?.day1 ?? 0) > day1 && (browser?.day1 ?? 1) < day1,
          `${named(sample)}: around everyone's Day 1`,
        );
      }
    }
  });

  it("says the same computers have the game today, whatever the period", () => {
    for (const kind of Object.values(SampleKind)) {
      const today = STATS_PERIODS.map((days) => fixtureInstalls(sampleOf(kind, days), {}).installedNow.now);
      assert.deepEqual(today, [today[0], today[0], today[0]], kind);
    }
    assert.equal(fixtureInstalls(sampleOf(SampleKind.Rich, 7, true), {}).installedNow.now, 2870);
  });

  it("moves a steady game's numbers around the design's by its own seed", () => {
    const steady = fixtureInstalls(sampleOf(SampleKind.Steady, 30), {});
    const other = fixtureInstalls(gameSample({ ...sourceOf(SampleKind.Steady), slug: "fx-other" }, 30, NOW), {});
    assert.notDeepEqual(
      steady.systems.map((row) => row.downloadSeconds),
      other.systems.map((row) => row.downloadSeconds),
    );
    assert.ok(
      steady.blocked.some((row) => row.reason === InstallBlock.Other),
      "a reason the design's game has none of",
    );
    assert.ok(
      steady.versions.some((row) => row.publishedOn === null),
      "a version whose publish day is not known",
    );
    assert.ok((steady.updateDays ?? 0) > 0);
  });

  it("has almost nothing for a young game: no installs, nothing to divide by, Day 7 not known yet", () => {
    for (const days of STATS_PERIODS) {
      const sample = sampleOf(SampleKind.Young, days);
      const report = fixtureInstalls(sample, {});
      assert.deepEqual(report.installs, { now: 0, before: 0 });
      assert.deepEqual(report.opened, { now: 0, before: 0 });
      assert.deepEqual(report.installedNow, { now: 0, before: 0 });
      assert.equal(report.removed, 0);
      assert.ok((stepOf(report, InstallStep.Offered) ?? 0) > 0, "a few visitors saw Install");
      assert.equal(stepOf(report, InstallStep.Pressed), 0);
      assert.deepEqual(
        [report.blocked, report.daily, report.systems, report.versions, report.channels],
        [[], [], [], [], []],
      );
      assert.equal(report.updateDays, null);
      const [installed, browser] = report.places;
      assert.deepEqual(installed, {
        place: PlayPlace.Installed,
        newPlayers: 0,
        day1: null,
        day7: null,
        medianPlaySeconds: null,
        playsPerPlayerDay: null,
        nexPerPlayer: null,
      });
      assert.equal(browser?.newPlayers, sample.newPlayers.now);
      assert.ok((browser?.day1 ?? 0) > 0, "Day 1 has come");
      assert.equal(browser?.day7, null, "Day 7 has not");
      assert.equal(browser?.nexPerPlayer, 0, "nobody has spent anything, which is known");
    }
  });

  it("has nothing at all for a week nobody played", () => {
    const report = fixtureInstalls(sampleOf(SampleKind.Steady, 7, true), {});
    assert.deepEqual(
      report.funnel.map((row) => row.people),
      [0, 0, 0, 0, 0],
    );
    assert.deepEqual(
      report.places.map((row) => [
        row.newPlayers,
        row.day1,
        row.medianPlaySeconds,
        row.playsPerPlayerDay,
        row.nexPerPlayer,
      ]),
      [
        [0, null, null, null, null],
        [0, null, null, null, null],
      ],
    );
  });

  it("is answered on the report's route for a game with an app build, and refused for one without", () => {
    const author = { id: "fx-simeon-m", name: "Simeon M" };
    const items = [
      { slug: "lost-cathedral", title: "Lost Cathedral", thumbnailUrl: null, playsCount: 2682, online: null, author },
      { slug: "stick-steel", title: "Stick & Steel", thumbnailUrl: null, playsCount: 2431, online: 6, author },
      { slug: "skate", title: "SKATE", thumbnailUrl: null, playsCount: 5285, online: 8, author, builds: [{}] },
    ];
    const catalog = { games: (authorId: string) => (authorId === author.id ? items : []) };
    const token = fixtureAccountToken(FixtureAccount.Full);
    const fixture = createFixtureGameAnalytics({ now: () => NOW });
    for (const days of STATS_PERIODS) {
      const query = { slug: "skate", report: GameReport.Installs, days };
      const answer = fixture.answer(reportRoute(query), { method: "GET", token }, catalog);
      assert.equal(answer?.status, 200, `over ${days} days`);
      const read = toReportAnswer(answer?.body, query, true) ?? assert.fail(`over ${days} days does not read`);
      const sent = isRecord(answer?.body) ? answer.body.data : undefined;
      assert.deepEqual(read.data, JSON.parse(JSON.stringify(sent)), `over ${days} days loses nothing`);
      assert.equal(read.window.endsOn, dayBefore("2026-11-18", 1));
    }
    const route = reportRoute({ slug: "lost-cathedral", report: GameReport.Installs, days: 30 });
    const refused = fixture.answer(route, { method: "GET", token }, catalog);
    assert.deepEqual([refused?.status, refused?.body], [404, { code: ReadKind.NoReport }]);
  });
});

type Answer = ReportAnswer<typeof GameReport.Installs>;

/** What the tests reach in the renderer build: the view model, the report and React's server renderer. */
interface InstallsBundle {
  view: typeof import("../../src/renderer/play/game-analytics/installs-view.ts");
  DeltaKind: typeof import("../../src/renderer/play/game-analytics/kit/index.ts").DeltaKind;
  InstallsReport: (props: ReportProps<typeof GameReport.Installs>) => ReactElement;
  createElement: (type: unknown, props: object | null, ...children: unknown[]) => ReactElement;
  renderToStaticMarkup: (element: ReactElement) => string;
}

/** The Installs report as the plain renderer build compiles it. */
async function installsBundle(): Promise<InstallsBundle> {
  const result = await build({
    stdin: {
      contents: [
        'export * as view from "./src/renderer/play/game-analytics/installs-view.ts";',
        'export { DeltaKind } from "./src/renderer/play/game-analytics/kit/index.ts";',
        'export { InstallsReport } from "./src/renderer/play/game-analytics/InstallsReport.tsx";',
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

let bundle: InstallsBundle;
before(async () => {
  bundle = await installsBundle();
});
// The bundle reads the same language slot as this file: numbers the English way, whatever the computer's.
beforeEach(() => setLocale(Locale.Japanese, {}));
after(() => setLocale(Locale.English, {}));

/** The Installs answer a fixture launch gives for a game, as it crosses the wire and the real parser. */
function fixtureAnswer(kind: SampleKind, days: StatsPeriod = 30, dormant = false): Answer {
  const sample = sampleOf(kind, days, dormant);
  const wire: unknown = JSON.parse(JSON.stringify(fixtureInstalls(sample, {})));
  const data = toInstallsReport(wire, sample.window) ?? assert.fail(`the ${kind} game's ${days} days parse`);
  return { report: GameReport.Installs, game: sample.game, window: sample.window, data };
}

/** `answer` with parts of its report replaced. */
const withData = (answer: Answer, data: Partial<InstallsReport>): Answer => ({
  ...answer,
  data: { ...answer.data, ...data },
});

/** An answer with nothing in it: no installs, no steps, no rows. */
const nothingAnswer = (): Answer =>
  withData(fixtureAnswer(SampleKind.Rich), {
    installs: { now: 0, before: 0 },
    opened: { now: 0, before: 0 },
    installedNow: { now: 0, before: 0 },
    removed: 0,
    funnel: [],
    blocked: [],
    daily: [],
    systems: [],
    places: [],
    versions: [],
    updateDays: null,
    channels: [],
  });

const noop = (): void => {};
const drawReport = (answer: Answer): string =>
  bundle.renderToStaticMarkup(
    bundle.createElement(bundle.InstallsReport, {
      slug: answer.game.slug,
      refreshing: false,
      stale: false,
      now: NOW,
      onOpenTab: noop,
      answer,
      options: {},
      onOptions: noop,
    } satisfies ReportProps<typeof GameReport.Installs>),
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
/** Every piece of `markup` that matches `pattern`. */
const matches = (markup: string, pattern: RegExp): string[] => markup.match(new RegExp(pattern.source, "g")) ?? [];
/** The section with `id`, from its opening tag to its closing one. */
const sectionOf = (markup: string, id: string): string =>
  new RegExp(`<section[^>]*data-game-analytics-section="${id}".*?</section>`).exec(markup)?.[0] ?? "";
/** The tile with `id`, from its opening tag to the start of the next. */
const tileOf = (markup: string, id: string): string =>
  new RegExp(`<div[^>]*data-game-analytics-tile="${id}".*?</span></div>`).exec(markup)?.[0] ?? "";
/** The rows of the table with `id`, each as the words it reads, the heading first. */
const tableRows = (markup: string, id: string): string[] => {
  const table =
    new RegExp(`<div role="table"[^>]*data-game-analytics-table="${id}".*?</div></div>`).exec(markup)?.[0] ?? "";
  return table
    .split('<div role="row"')
    .slice(1)
    .map((row) => words(`<div role="row"${row.split("</div>")[0]}`));
};

describe("the Installs view model: the rich game's month", () => {
  const view = (): InstallsView => bundle.view.installsView(fixtureAnswer(SampleKind.Rich));

  it("four tiles with their number, their change and what it counts", () => {
    const { tiles } = view();
    assert.deepEqual(
      tiles.map((tile) => [tile.id, tile.value, tile.notes.map((note) => note.text)]),
      [
        ["installs", "1,060", ["downloaded and ready to open"]],
        ["opened", "88.7%", ["940 opened it at least once"]],
        ["installed-now", "2,870", ["310 removed it in this period"]],
        ["latest", "71%", [`1.4.0, published ${formatDay("2026-11-09")}`, "half update within 1.2 days"]],
      ],
    );
    const [installs, opened, installedNow, latest] = tiles;
    assert.deepEqual(installs?.delta, { kind: bundle.DeltaKind.Percent, now: 1060, before: 768 });
    assert.equal(installedNow?.delta?.kind, bundle.DeltaKind.Amount);
    assert.deepEqual([installedNow?.delta?.now, installedNow?.delta?.before], [2870, 2120]);
    assert.deepEqual(opened?.delta, { kind: bundle.DeltaKind.Points, now: 940 / 1060, before: 667 / 768 });
    assert.equal(latest?.delta, undefined, "the newest version has nothing to be compared with");
    assert.deepEqual(
      latest?.notes.map((note) => note.mask),
      [true, undefined],
      "a version is the creator's own words: kept out of replays",
    );
  });

  it("the way to the first launch: who saw Install, each step's share that goes on and what it loses", () => {
    const { funnel } = view();
    assert.equal(funnel.hint, "6,840 visitors on a computer that can run it saw Install. 18.1% pressed it.");
    assert.deepEqual(
      funnel.steps.map((step) => [step.id, step.count, step.onward, step.lost]),
      [
        [InstallStep.Pressed, 1240, "88.1% finish the download", "148 stopped or failed"],
        [InstallStep.Downloaded, 1092, "97.1% install", "32 could not be unpacked"],
        [InstallStep.Installed, 1060, "88.7% open it", "120 have not opened it"],
        [InstallStep.Opened, 940, "75.8% of those who pressed Install", null],
      ],
    );
  });

  it("the visitors who could not get a build, by reason, most first", () => {
    const blocked = view().funnel.blocked ?? assert.fail("some could not install");
    assert.equal(
      blocked.sentence,
      "420 visitors wanted it and could not install, because there is no build for their computer.",
    );
    assert.deepEqual(
      blocked.reasons.map((reason) => [reason.id, reason.label, reason.people]),
      [
        [InstallBlock.MacIntel, "Mac with an Intel chip and no Rosetta", "180"],
        [InstallBlock.OldSystem, "A system that is too old", "150"],
        [InstallBlock.LinuxArm, "Linux on ARM", "90"],
      ],
    );
  });

  it("the installs of each day stacked by system, in the systems' own order and colours", () => {
    const answer = fixtureAnswer(SampleKind.Rich);
    const { daily } = bundle.view.installsView(answer);
    assert.deepEqual(
      daily.series.map((series) => [series.id, series.label, series.values.length]),
      [
        [OsFamily.Windows, "Windows", 30],
        [OsFamily.MacArm, "Mac, Apple silicon", 30],
        [OsFamily.MacIntel, "Mac, Intel", 30],
        [OsFamily.Linux, "Linux", 30],
      ],
    );
    assert.equal(daily.labels.length, 30);
    assert.deepEqual(
      daily.legend.map((item) => [item.id, "slot" in item ? item.slot : null]),
      daily.series.map((series) => [series.id, series.slot]),
      "the legend wears the series' colours",
    );
    assert.equal(new Set(daily.series.map((series) => series.slot)).size, 4, "a colour for each system");
    const perDay = daily.labels.map((_, day) => sum(daily.series.map((series) => series.values[day] ?? 0)));
    assert.deepEqual(
      perDay,
      sampleOf(SampleKind.Rich, 30).installs?.daily,
      "the bars add up to the installs of each day",
    );
  });

  it("a system with no installs in the period is not drawn", () => {
    const answer = fixtureAnswer(SampleKind.Rich);
    const quiet = withData(answer, {
      daily: answer.data.daily.map((row) =>
        row.os === OsFamily.Linux ? { ...row, installs: row.installs.map(() => 0) } : row,
      ),
    });
    const { daily } = bundle.view.installsView(quiet);
    assert.deepEqual(
      daily.series.map((series) => series.id),
      [OsFamily.Windows, OsFamily.MacArm, OsFamily.MacIntel],
    );
    assert.deepEqual(
      daily.legend.map((item) => item.id),
      [OsFamily.Windows, OsFamily.MacArm, OsFamily.MacIntel],
    );
  });

  it("the systems' table: each share of the installs, and a total row of what the systems add up to", () => {
    const { systems } = view();
    assert.deepEqual(
      systems.rows.map((row) => [row.label, row.installs, row.share, row.opened, row.downloadSeconds, row.failed]),
      [
        ["Windows", 610, 610 / 1060, 536 / 610, 52, 0.034],
        ["Mac, Apple silicon", 360, 360 / 1060, 326 / 360, 41, 0.022],
        ["Mac, Intel", 50, 50 / 1060, 43 / 50, 58, 0.041],
        ["Linux", 40, 40 / 1060, 35 / 40, 47, 0.05],
      ],
    );
    assert.equal(sum(systems.rows.map((row) => row.share ?? 0)).toFixed(9), "1.000000000");
    const total = systems.total ?? assert.fail("a total row");
    assert.equal(total.label, "All systems");
    assert.equal(total.installs, 1060);
    assert.equal(total.share, null, "the total is not a share of itself");
    assert.equal(total.opened, 940 / 1060);
    assert.equal(
      total.downloadSeconds,
      null,
      "the answer has no download time for all systems, and a mean of medians is no median",
    );
    assert.equal(
      total.failed,
      null,
      "a share of downloads cannot be weighed by installs: the failed ones never installed",
    );
  });

  it("a system that has no download time yet shows none, and the total shows none either way", () => {
    const answer = fixtureAnswer(SampleKind.Rich);
    const unripe = withData(answer, {
      systems: answer.data.systems.map((row) =>
        row.os === OsFamily.Linux ? { ...row, downloadSeconds: null, failed: null } : row,
      ),
    });
    const { systems } = bundle.view.installsView(unripe);
    assert.deepEqual(
      systems.rows.map((row) => row.downloadSeconds),
      [52, 41, 58, null],
    );
    assert.equal(systems.total?.downloadSeconds, null);
    const nobody = bundle.view.installsView(
      withData(answer, {
        systems: answer.data.systems.map((row) => ({ ...row, downloadSeconds: null, failed: null })),
      }),
    );
    assert.equal(nobody.systems.total?.downloadSeconds, null);
  });

  it("the two places side by side, one measure to a row", () => {
    const { places } = view();
    assert.equal(places.hint, "1,060 new players installed, 6,780 played in the browser");
    assert.deepEqual(
      places.rows.map((row) => [row.label, row.installed, row.browser]),
      [
        ["Still playing on day 1", "49.1%", "31.4%"],
        ["Still playing on day 7", "26.1%", "12.2%"],
        ["Median play length", "13m 20s", "4m 50s"],
        ["Plays per player a day", "1.9", "1.3"],
        ["Nex per player", "9.40", "3.10"],
      ],
    );
  });

  it("the versions, newest first, each with its share of the computers that have the game", () => {
    const { versions } = view();
    assert.deepEqual(
      versions.map((row) => [row.label, row.published, row.installed, row.share]),
      [
        ["1.4.0", formatDay("2026-11-09"), 2038, 2038 / 2870],
        ["1.3.2", formatDay("2026-10-21"), 631, 631 / 2870],
        ["1.3.0 and older", formatDay("2026-09-30"), 201, 201 / 2870],
      ],
    );
  });

  it("where installs came from, most first, search and other sites as one row", () => {
    const { channels, credit } = view();
    assert.deepEqual(
      channels.map((row) => [row.id, row.label, row.value]),
      [
        [SourceChannel.Genex, "Genex", 520],
        [SourceChannel.Campaigns, "Campaigns", 290],
        [SourceChannel.Direct, "Direct", 140],
        [SourceChannel.Social, "Social", 80],
        ["search_and_other", "Search and other sites", 30],
      ],
    );
    assert.equal(credit, "A campaign link keeps its credit for 7 days between the click and the install.");
  });
});

describe("the Installs view model: what cannot be told", () => {
  it("a young game: nothing to divide by is a dash, not zero, and nothing is invented", () => {
    const { tiles, funnel, daily, systems, places, versions, channels } = bundle.view.installsView(
      fixtureAnswer(SampleKind.Young),
    );
    const [installs, opened, , latest] = tiles;
    assert.equal(installs?.value, "0", "no installs is a count that is known");
    assert.equal(opened?.value, null, "the share of nothing opened is not known");
    assert.deepEqual(opened?.notes, []);
    assert.deepEqual(opened?.delta, { kind: bundle.DeltaKind.Points, now: null, before: null });
    assert.equal(latest?.value, null);
    assert.deepEqual(latest?.notes, []);
    assert.deepEqual(funnel.steps, [], "nobody pressed Install");
    assert.equal(funnel.blocked, null);
    assert.deepEqual(daily.series, []);
    assert.deepEqual(daily.legend, []);
    assert.deepEqual(systems, { rows: [], total: null });
    assert.deepEqual(versions, []);
    assert.deepEqual(channels, []);
    const [day1, day7, median, plays, nex] = places.rows;
    for (const row of [day1, day7, median, plays, nex]) assert.equal(row?.installed, "—", row?.label);
    assert.equal(day7?.browser, "—", "Day 7 has not come yet");
    assert.notEqual(day1?.browser, "—");
  });

  it("an answer with nothing in it has nothing to draw", () => {
    const view = bundle.view.installsView(nothingAnswer());
    assert.equal(view.funnel.hint, null);
    assert.deepEqual(view.funnel.steps, []);
    assert.equal(view.funnel.blocked, null);
    assert.deepEqual(view.places, { hint: null, rows: [] });
    assert.deepEqual(view.systems, { rows: [], total: null });
    assert.deepEqual(view.versions, []);
    assert.deepEqual(view.channels, []);
    assert.deepEqual(
      view.tiles.map((tile) => tile.value),
      ["0", null, "0", null],
    );
  });

  it("a funnel the answer only half has draws the steps it has, and never a step as zero", () => {
    const answer = fixtureAnswer(SampleKind.Rich);
    const half = withData(answer, {
      funnel: answer.data.funnel.filter(
        (row) => row.step === InstallStep.Pressed || row.step === InstallStep.Installed,
      ),
    });
    const { funnel } = bundle.view.installsView(half);
    assert.equal(funnel.hint, null, "who saw Install is not said");
    assert.deepEqual(
      funnel.steps.map((step) => [step.id, step.count, step.onward, step.lost]),
      [
        [InstallStep.Pressed, 1240, null, null],
        [InstallStep.Installed, 1060, null, null],
      ],
    );
  });

  it("who saw Install with nobody pressing it says only that", () => {
    const answer = fixtureAnswer(SampleKind.Rich);
    const only = withData(answer, { funnel: [{ step: InstallStep.Offered, people: 1 }] });
    assert.equal(bundle.view.installsView(only).funnel.hint, "1 visitor on a computer that can run it saw Install.");
    const none = withData(answer, { funnel: [{ step: InstallStep.Offered, people: 0 }] });
    assert.equal(bundle.view.installsView(none).funnel.hint, "Nobody saw Install on a computer that can run it.");
  });

  it("a reason that stopped nobody is not listed, and one visitor is told in the singular", () => {
    const answer = fixtureAnswer(SampleKind.Rich);
    const one = withData(answer, {
      blocked: [
        { reason: InstallBlock.MacIntel, people: 0 },
        { reason: InstallBlock.Other, people: 1 },
      ],
    });
    const blocked = bundle.view.installsView(one).funnel.blocked ?? assert.fail("one could not install");
    assert.equal(
      blocked.sentence,
      "1 visitor wanted it and could not install, because there is no build for their computer.",
    );
    assert.deepEqual(
      blocked.reasons.map((reason) => reason.id),
      [InstallBlock.Other],
    );
    assert.equal(
      bundle.view.installsView(withData(answer, { blocked: [{ reason: InstallBlock.Other, people: 0 }] })).funnel
        .blocked,
      null,
    );
  });

  it("a long list of versions keeps three rows: the last holds its version and every older one", () => {
    const answer = fixtureAnswer(SampleKind.Rich);
    const many = withData(answer, {
      installedNow: { now: 1000, before: 900 },
      versions: [
        { version: "2.0.0", publishedOn: "2026-11-10", installed: 500 },
        { version: "1.9.0", publishedOn: "2026-11-01", installed: 300 },
        { version: "1.8.0", publishedOn: "2026-10-01", installed: 120 },
        { version: "1.7.0", publishedOn: null, installed: 50 },
        { version: "1.6.0", publishedOn: null, installed: 30 },
      ],
    });
    const { versions } = bundle.view.installsView(many);
    assert.deepEqual(
      versions.map((row) => [row.label, row.installed, row.share]),
      [
        ["2.0.0", 500, 0.5],
        ["1.9.0", 300, 0.3],
        ["1.8.0 and older", 200, 0.2],
      ],
    );
    assert.equal(versions[2]?.published, formatDay("2026-10-01"), "the newest of the folded versions' day");
    assert.equal(sum(versions.map((row) => row.installed)), 1000);
  });

  it("a version whose day was not kept shows a dash, and a share never reads over 100%", () => {
    const answer = fixtureAnswer(SampleKind.Rich);
    const over = withData(answer, {
      installedNow: { now: 100, before: 100 },
      versions: [
        { version: "1.1.0", publishedOn: null, installed: 90 },
        { version: "1.0.0", publishedOn: null, installed: 60 },
      ],
    });
    const { tiles, versions } = bundle.view.installsView(over);
    assert.deepEqual(
      versions.map((row) => [row.published, row.share]),
      [
        ["—", 0.6],
        ["—", 0.4],
      ],
    );
    assert.equal(tiles[3]?.value, "60%");
    assert.deepEqual(
      tiles[3]?.notes.map((note) => note.text),
      ["1.1.0", "half update within 1.2 days"],
      "no day to say: the version alone",
    );
  });

  it("the median days to update read as whole days when whole, and one day in the singular", () => {
    const answer = fixtureAnswer(SampleKind.Rich);
    const noteOf = (updateDays: number | null): string | undefined =>
      bundle.view.installsView(withData(answer, { updateDays })).tiles[3]?.notes.at(-1)?.text;
    assert.equal(noteOf(1), "half update within 1 day");
    assert.equal(noteOf(3), "half update within 3 days");
    assert.equal(noteOf(0.26), "half update within 0.3 days");
    assert.equal(noteOf(null), `1.4.0, published ${formatDay("2026-11-09")}`, "nothing to say about updating");
  });

  it("a count of one is told in the singular", () => {
    const answer = fixtureAnswer(SampleKind.Rich);
    const one = withData(answer, {
      installs: { now: 1, before: 1 },
      opened: { now: 1, before: 1 },
      installedNow: { now: 1, before: 1 },
      removed: 1,
    });
    const { tiles } = bundle.view.installsView(one);
    assert.deepEqual(
      tiles.map((tile) => tile.notes[0]?.text),
      [
        "downloaded and ready to open",
        "1 opened it at least once",
        "1 removed it in this period",
        `1.4.0, published ${formatDay("2026-11-09")}`,
      ],
    );
    const places = bundle.view.installsView(
      withData(answer, { places: answer.data.places.map((row) => ({ ...row, newPlayers: 1 })) }),
    ).places;
    assert.equal(places.hint, "1 new player installed, 1 played in the browser");
  });

  it("one place with nobody in it is all dashes, the other's numbers stay", () => {
    const answer = fixtureAnswer(SampleKind.Rich);
    const lonely = withData(answer, { places: answer.data.places.filter((row) => row.place === PlayPlace.Browser) });
    const { places } = bundle.view.installsView(lonely);
    assert.deepEqual(
      places.rows.map((row) => [row.installed, row.browser]),
      [
        ["—", "31.4%"],
        ["—", "12.2%"],
        ["—", "4m 50s"],
        ["—", "1.3"],
        ["—", "3.10"],
      ],
    );
  });
});

describe("the Installs face", () => {
  it("the rich game: four tiles, each with its number and what it counts", () => {
    const markup = drawReport(fixtureAnswer(SampleKind.Rich));
    assert.match(markup, /^<div class="game-analytics-report" data-game-analytics-report="installs">/);
    const ids = matches(markup, /data-game-analytics-tile="[^"]*"/).map((tag) => /"([^"]*)"/.exec(tag)?.[1]);
    assert.deepEqual(ids, ["installs", "opened", "installed-now", "latest"]);
    assert.equal(words(tileOf(markup, "installs")), "Installs 1,060 +38% downloaded and ready to open");
    assert.equal(words(tileOf(markup, "opened")), "Opened after installing 88.7% +1.8 pts 940 opened it at least once");
    assert.equal(words(tileOf(markup, "installed-now")), "Installed now 2,870 +750 310 removed it in this period");
    assert.equal(
      words(tileOf(markup, "latest")),
      `On the latest version 71% 1.4.0, published ${formatDay("2026-11-09")} half update within 1.2 days`,
    );
    assert.match(
      tileOf(markup, "latest"),
      /<span data-analytics-mask="true">1\.4\.0, published/,
      "the version stays out of replays",
    );
  });

  it("the rich game: the sections in the order of the page", () => {
    const markup = drawReport(fixtureAnswer(SampleKind.Rich));
    const ids = matches(markup, /<section[^>]*data-game-analytics-section="[^"]*"/).map(
      (tag) => /section="([^"]*)"/.exec(tag)?.[1],
    );
    assert.deepEqual(ids, ["funnel", "daily", "systems", "places", "versions", "channels"]);
    const titles = ids.map((id) => /<h2[^>]*>(.*?)<\/h2>/.exec(sectionOf(markup, id ?? ""))?.[1]);
    assert.deepEqual(titles, [
      "From pressing Install to opening the game",
      "Installs per day",
      "By system",
      "Players who install against players in the browser",
      "Versions on players’ computers",
      "Where installs came from",
    ]);
  });

  it("the rich game: the funnel's four steps, what each loses, and who could not install", () => {
    const section = sectionOf(drawReport(fixtureAnswer(SampleKind.Rich)), "funnel");
    assert.match(
      words(section),
      /^From pressing Install to opening the game 6,840 visitors on a computer that can run it saw Install\. 18\.1% pressed it\./,
    );
    const steps = matches(section, /<li class="game-analytics-step" data-game-analytics-step="[^"]*".*?<\/li>/).map(
      words,
    );
    assert.deepEqual(steps, [
      "Pressed Install 1,240 88.1% finish the download 148 stopped or failed",
      "Download finished 1,092 97.1% install 32 could not be unpacked",
      "Installed 1,060 88.7% open it 120 have not opened it",
      "Opened the game 940 75.8% of those who pressed Install",
    ]);
    const reasons = matches(section, /<li data-game-analytics-reason="[^"]*".*?<\/li>/).map(words);
    assert.deepEqual(reasons, [
      "Mac with an Intel chip and no Rosetta 180",
      "A system that is too old 150",
      "Linux on ARM 90",
    ]);
    assert.match(
      section,
      /<p class="game-analytics-installs-blocked-sentence">420 visitors wanted it and could not install/,
    );
  });

  it("the rich game: the day-by-day chart with its legend in the head and a text table that says the same", () => {
    const section = sectionOf(drawReport(fixtureAnswer(SampleKind.Rich)), "daily");
    assert.match(section, /<figure[^>]*data-game-analytics-chart="installs"[^>]*data-chart="bar"/);
    assert.match(section, /role="img" aria-label="Installs per day, by system"/);
    const legend = matches(section, /<li class="game-analytics-legend-item".*?<\/li>/).map(words);
    assert.deepEqual(legend, ["Windows", "Mac, Apple silicon", "Mac, Intel", "Linux"]);
    assert.equal(matches(section, /<tr><th scope="row">/).length, 30, "a row per day");
    assert.equal(matches(section, /<canvas/).length, 1);
  });

  it("the rich game: the systems' table with a total row, and the numbers of the design", () => {
    const rows = tableRows(drawReport(fixtureAnswer(SampleKind.Rich)), "systems");
    assert.deepEqual(rows, [
      "System Installs Share Opened Download time Failed",
      "Windows 610 57.5% 87.9% 52 s 3.4%",
      "Mac, Apple silicon 360 34.0% 90.6% 41 s 2.2%",
      "Mac, Intel 50 4.7% 86.0% 58 s 4.1%",
      "Linux 40 3.8% 87.5% 47 s 5.0%",
      "All systems 1,060 88.7%",
    ]);
  });

  it("the rich game: places side by side, versions with their bars, and where installs came from", () => {
    const markup = drawReport(fixtureAnswer(SampleKind.Rich));
    assert.deepEqual(tableRows(markup, "places"), [
      "New players Installed Browser",
      "Still playing on day 1 49.1% 31.4%",
      "Still playing on day 7 26.1% 12.2%",
      "Median play length 13m 20s 4m 50s",
      "Plays per player a day 1.9 1.3",
      "Nex per player 9.40 3.10",
    ]);
    assert.match(words(sectionOf(markup, "places")), /1,060 new players installed, 6,780 played in the browser/);
    const versions = tableRows(markup, "versions");
    assert.deepEqual(versions, [
      "Version Published Installed Share",
      `1.4.0 ${formatDay("2026-11-09")} 2,038 71%`,
      `1.3.2 ${formatDay("2026-10-21")} 631 22%`,
      `1.3.0 and older ${formatDay("2026-09-30")} 201 7%`,
    ]);
    assert.equal(
      matches(sectionOf(markup, "versions"), /data-analytics-mask="true"/).length,
      3,
      "a version is the creator's own words",
    );
    const channels = sectionOf(markup, "channels");
    const rows = matches(channels, /<li class="game-analytics-barlist-row".*?<\/li>/).map(words);
    assert.deepEqual(rows, [
      "Genex 520 49.1%",
      "Campaigns 290 27.4%",
      "Direct 140 13.2%",
      "Social 80 7.5%",
      "Search and other sites 30 2.8%",
    ]);
    assert.match(
      channels,
      /<p class="game-analytics-section-footnote">A campaign link keeps its credit for 7 days between the click and the install\.<\/p>/,
    );
  });

  it("the face has no control to press, and draws no zero for what it cannot know", () => {
    for (const kind of Object.values(SampleKind)) {
      const markup = drawReport(fixtureAnswer(kind));
      assert.equal(matches(markup, /<button/).length, 0, kind);
      assert.doesNotMatch(markup, /NaN|undefined|Infinity/, kind);
    }
  });

  it("a young game: dashes where there is nothing to divide by, and a sentence where a block has nothing", () => {
    const answer = fixtureAnswer(SampleKind.Young);
    const markup = drawReport(answer);
    const saw = stepOf(answer.data, InstallStep.Offered) ?? assert.fail("some saw Install");
    assert.ok(saw > 0, "the young game was seen");
    assert.equal(words(tileOf(markup, "opened")), "Opened after installing — —");
    assert.equal(words(tileOf(markup, "latest")), "On the latest version —");
    const funnel = words(sectionOf(markup, "funnel"));
    assert.ok(
      funnel.endsWith(
        `${saw} ${saw === 1 ? "visitor" : "visitors"} on a computer that can run it saw Install. 0.0% pressed it. Nobody pressed Install in this period.`,
      ),
      funnel,
    );
    assert.equal(matches(markup, /data-game-analytics-step=/).length, 0);
    assert.equal(words(sectionOf(markup, "daily")), "Installs per day No installs in this period.");
    assert.equal(words(sectionOf(markup, "systems")), "By system Nothing to split by system yet.");
    assert.equal(
      words(sectionOf(markup, "versions")),
      "Versions on players’ computers Nobody has it installed right now.",
    );
    assert.equal(words(sectionOf(markup, "channels")), "Where installs came from No installs to trace yet.");
    const [, day1, day7] = tableRows(markup, "places");
    assert.match(
      day1 ?? "",
      /^Still playing on day 1 — \d+\.\d%$/,
      "Day 1 of the browser's players, none of the installed",
    );
    assert.equal(day7, "Still playing on day 7 — —", "Day 7 has not come for anyone");
  });

  it("an answer with nothing in it: every block says so, and nothing is drawn as a chart or a table", () => {
    const markup = drawReport(nothingAnswer());
    assert.equal(matches(markup, /data-game-analytics-empty="true"/).length, 6);
    assert.equal(matches(markup, /<canvas[^>]*game-analytics-canvas/).length, 0);
    assert.equal(matches(markup, /data-game-analytics-table=/).length, 0);
    assert.equal(
      words(sectionOf(markup, "places")),
      "Players who install against players in the browser No new players in these days.",
    );
    assert.equal(matches(markup, /data-game-analytics-blocked/).length, 0);
  });

  it("every period of the rich and the steady game draws, with the same sections", () => {
    for (const kind of [SampleKind.Rich, SampleKind.Steady]) {
      for (const days of STATS_PERIODS) {
        const markup = drawReport(fixtureAnswer(kind, days));
        assert.equal(
          matches(markup, /<section[^>]*data-game-analytics-section=/).length,
          6,
          `${kind} over ${days} days`,
        );
        assert.doesNotMatch(markup, /NaN|undefined|Infinity/, `${kind} over ${days} days`);
      }
    }
  });
});
