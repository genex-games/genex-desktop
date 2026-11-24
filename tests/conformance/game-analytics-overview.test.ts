/**
 * The Overview tab of a game's analytics: what it derives from an answer for display (the eight
 * tiles with their change, the per-day chart of the number picked, the sentences written from an
 * insight's typed fields, the channels, the retention curve and the funnel), and its face as
 * React's server renderer draws it from the plain renderer build.
 *
 * Every answer here but the hand-made ones is a fixture launch's own, read by the real parser, so
 * the screen is checked against what it will be given. The app's language is set to Japanese with
 * no catalog: the words stay English and the numbers read the English way whatever the computer's.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { build } from "esbuild";
import type { ReactElement } from "react";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { fixtureOverview } from "../../src/main/dev/fixture-game-analytics/fixture-overview.ts";
import { gameSample, SampleKind, type SampleSource } from "../../src/main/dev/fixture-game-analytics/sample.ts";
import { toOverviewReport } from "../../src/main/play/game-analytics/report-overview.ts";
import { formatDay, formatDayRange } from "../../src/renderer/play/game-analytics/kit/format.ts";
import type { OverviewView } from "../../src/renderer/play/game-analytics/overview-view.ts";
import type { ReportAnswer, ReportProps } from "../../src/renderer/play/game-analytics/report-props.ts";
import { AnalyticsTab } from "../../src/renderer/play/game-analytics/tabs.ts";
import { LineTone } from "../../src/renderer/play/stats-chart.ts";
import {
  AnnotationKind,
  DeviceClass,
  FunnelStep,
  GameReport,
  type Insight,
  InsightKind,
  OverviewMetric,
  type OverviewReport,
  SourceChannel,
} from "../../src/shared/game-analytics.ts";
import { setLocale } from "../../src/shared/i18n.ts";
import { Locale } from "../../src/shared/locale.ts";
import { STATS_PERIODS, type StatsPeriod } from "../../src/shared/play-stats.ts";

type Answer = ReportAnswer<typeof GameReport.Overview>;
type FaceProps = {
  view: OverviewView;
  onChoose: (metric: OverviewMetric) => void;
  onOpenTab: (tab: AnalyticsTab) => void;
};

/** What the tests reach in the renderer build: the Overview's view model, its two components and React's server renderer. */
interface OverviewBundle {
  view: typeof import("../../src/renderer/play/game-analytics/overview-view.ts");
  DeltaKind: typeof import("../../src/renderer/play/game-analytics/kit/index.ts").DeltaKind;
  OverviewReport: (props: ReportProps<typeof GameReport.Overview>) => ReactElement;
  OverviewFace: (props: FaceProps) => ReactElement;
  createElement: (type: unknown, props: object | null, ...children: unknown[]) => ReactElement;
  renderToStaticMarkup: (element: ReactElement) => string;
}

/** The Overview as the plain renderer build compiles it. */
async function overviewBundle(): Promise<OverviewBundle> {
  const result = await build({
    stdin: {
      contents: [
        'export * as view from "./src/renderer/play/game-analytics/overview-view.ts";',
        'export { DeltaKind } from "./src/renderer/play/game-analytics/kit/index.ts";',
        'export { OverviewFace, OverviewReport } from "./src/renderer/play/game-analytics/OverviewReport.tsx";',
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

/** The day the fixture answers end on: the design's own month, Oct 19 to Nov 17. */
const NOW = Date.parse("2026-11-17T12:04:00.000Z");

/** A fixture game of `kind`; only the rich one has an app build. */
const sourceOf = (kind: SampleKind, over: Partial<SampleSource> = {}): SampleSource => ({
  slug: "lantern-run",
  title: "Lantern Run",
  coverUrl: null,
  plays: 30_000,
  playingNow: 38,
  hasAppBuild: kind === SampleKind.Rich,
  kind,
  dormant: false,
  ...over,
});

/** The Overview answer a fixture launch gives for a game, as it crosses the wire and the real parser. */
function fixtureAnswer(kind: SampleKind, days: StatsPeriod = 30, over: Partial<SampleSource> = {}): Answer {
  const sample = gameSample(sourceOf(kind, over), days, NOW);
  const wire: unknown = JSON.parse(JSON.stringify(fixtureOverview(sample, {})));
  const data = toOverviewReport(wire, sample.window);
  assert.ok(data, `the ${kind} game's ${days} days parse`);
  return { report: GameReport.Overview, game: sample.game, window: sample.window, data };
}

/** `answer` with parts of its data replaced. */
const withData = (answer: Answer, data: Partial<OverviewReport>): Answer => ({
  ...answer,
  data: { ...answer.data, ...data },
});

/** An answer with nothing in it: no number has a series, and every list is empty. */
function nothingAnswer(): Answer {
  const answer = fixtureAnswer(SampleKind.Young);
  const none = Object.fromEntries(Object.values(OverviewMetric).map((metric) => [metric, null]));
  return withData(answer, {
    series: none as Record<OverviewMetric, null>,
    annotations: [],
    insights: [],
    channels: [],
    retention: { rates: [], before: [], similar: null },
    funnel: [],
  });
}

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
/** Every opening tag in `markup` that matches `pattern`. */
const tags = (markup: string, pattern: RegExp): string[] => markup.match(new RegExp(pattern.source, "g")) ?? [];
/** The part of `markup` from the opening tag that matches `pattern` up to the next `</section>`. */
const sectionOf = (markup: string, id: string): string =>
  new RegExp(`<section[^>]*data-game-analytics-section="${id}".*?</section>`).exec(markup)?.[0] ?? "";

let bundle: OverviewBundle;
before(async () => {
  bundle = await overviewBundle();
});
// The bundle reads the same language slot as this file: numbers the English way, whatever the computer's.
beforeEach(() => setLocale(Locale.Japanese, {}));
after(() => setLocale(Locale.English, {}));

/** The rows the view model writes for `insights`, for a game with an app build unless `over` says otherwise. */
const written = (insights: Insight[], over: { hasAppBuild?: boolean } = {}) =>
  bundle.view.overviewInsights(insights, { hasAppBuild: true, ...over });

const noop = (): void => {};
/** The report as the shell mounts it: Players is the number picked. */
const drawReport = (answer: Answer): string =>
  bundle.renderToStaticMarkup(
    bundle.createElement(bundle.OverviewReport, {
      slug: answer.game.slug,
      refreshing: false,
      stale: false,
      now: NOW,
      onOpenTab: noop,
      answer,
      options: {},
      onOptions: noop,
    } satisfies ReportProps<typeof GameReport.Overview>),
  );
/** The face with `chosen` as the number picked, as after a press on its tile. */
const drawFace = (answer: Answer, chosen: OverviewMetric): string =>
  bundle.renderToStaticMarkup(
    bundle.createElement(bundle.OverviewFace, {
      view: bundle.view.overviewView(answer, chosen),
      onChoose: noop,
      onOpenTab: noop,
    } satisfies FaceProps),
  );
/** The row of a chart's text-equivalent table whose row heading is `place`. */
const tableRow = (markup: string, place: string): string =>
  new RegExp(`<tr><th scope="row">${place}</th>.*?</tr>`).exec(markup)?.[0] ?? "";
/** The tile of `metric`, from its opening tag to its end. */
const tileOf = (markup: string, metric: OverviewMetric): string =>
  new RegExp(`<button[^>]*data-game-analytics-tile="${metric}".*?</button>`).exec(markup)?.[0] ?? "";
/** What a bar list's rows read as, row by row. */
const barRows = (markup: string, id: string): string[] => {
  const list = new RegExp(`<ul[^>]*data-game-analytics-bars="${id}".*?</ul>`).exec(markup)?.[0] ?? "";
  return tags(list, /<li[^>]*>.*?<\/li>/).map(words);
};

describe("the Overview's tiles", () => {
  it("are the eight headline numbers of the rich game's month, each written in its own unit", () => {
    const { tiles } = bundle.view.overviewView(fixtureAnswer(SampleKind.Rich), OverviewMetric.Players);
    assert.deepEqual(
      tiles.map((tile) => [tile.metric, tile.label, tile.value]),
      [
        [OverviewMetric.Players, "Players", "9,300"],
        [OverviewMetric.NewPlayers, "New players", "7,840"],
        [OverviewMetric.Plays, "Plays", "30,889"],
        [OverviewMetric.MedianPlaySeconds, "Median play length", "5m 40s"],
        [OverviewMetric.Day1, "Day 1 retention", "34.5%"],
        [OverviewMetric.Day7, "Day 7 retention", "14.5%"],
        [OverviewMetric.Installs, "Installs", "1,060"],
        [OverviewMetric.NexSpent, "Nex spent", "48,610"],
      ],
    );
  });

  it("tell a count's change in percent, a rate's in points and the median's as a signed length", () => {
    const { tiles } = bundle.view.overviewView(fixtureAnswer(SampleKind.Rich), OverviewMetric.Players);
    const { Percent, Points, Amount } = bundle.DeltaKind;
    const delta = (metric: OverviewMetric) =>
      tiles.find((tile) => tile.metric === metric)?.delta ?? assert.fail(metric);
    assert.deepEqual(delta(OverviewMetric.Players), { kind: Percent, now: 9300, before: 5602 });
    assert.deepEqual(delta(OverviewMetric.NewPlayers), { kind: Percent, now: 7840, before: 4331 });
    assert.deepEqual(delta(OverviewMetric.Plays), { kind: Percent, now: 30_889, before: 18_386 });
    assert.deepEqual(delta(OverviewMetric.Installs), { kind: Percent, now: 1060, before: 768 });
    assert.deepEqual(delta(OverviewMetric.NexSpent), { kind: Percent, now: 48_610, before: 31_565 });
    assert.deepEqual(delta(OverviewMetric.Day1), { kind: Points, now: 0.345, before: 0.324 });
    assert.deepEqual(delta(OverviewMetric.Day7), { kind: Points, now: 0.145, before: 0.137 });
    const median = delta(OverviewMetric.MedianPlaySeconds);
    assert.deepEqual([median.kind, median.now, median.before], [Amount, 340, 318]);
    assert.equal(median.kind === Amount && median.format(22), "+22 s");
    assert.equal(median.kind === Amount && median.format(-65), "−1m 5s");
  });

  it("carry a value per day for the sparkline, gaps included", () => {
    const answer = fixtureAnswer(SampleKind.Rich);
    const { tiles } = bundle.view.overviewView(answer, OverviewMetric.Players);
    for (const tile of tiles) {
      assert.deepEqual(tile.spark, answer.data.series[tile.metric]?.daily, tile.metric);
      assert.equal(tile.spark.length, 30, tile.metric);
    }
    const day7 = tiles.find((tile) => tile.metric === OverviewMetric.Day7);
    assert.equal(day7?.spark.at(-1), null, "the newest players have not had seven days yet");
  });

  it("mark the number picked, Players unless another is", () => {
    const answer = fixtureAnswer(SampleKind.Rich);
    const pressed = (chosen: OverviewMetric) =>
      bundle.view
        .overviewView(answer, chosen)
        .tiles.filter((tile) => tile.pressed)
        .map((tile) => tile.metric);
    assert.deepEqual(pressed(OverviewMetric.Players), [OverviewMetric.Players]);
    assert.deepEqual(pressed(OverviewMetric.NexSpent), [OverviewMetric.NexSpent]);
  });

  it("leave Installs out for a game with no app build, and fall back to the first tile when it was the one picked", () => {
    const view = bundle.view.overviewView(fixtureAnswer(SampleKind.Steady), OverviewMetric.Installs);
    assert.equal(view.tiles.length, 7);
    assert.equal(
      view.tiles.some((tile) => tile.metric === OverviewMetric.Installs),
      false,
    );
    assert.deepEqual(
      view.tiles.filter((tile) => tile.pressed).map((tile) => tile.metric),
      [OverviewMetric.Players],
    );
    assert.equal(view.chart?.metric, OverviewMetric.Players);
  });

  it("keep a number that cannot be known yet empty, never zero", () => {
    const { tiles } = bundle.view.overviewView(fixtureAnswer(SampleKind.Young), OverviewMetric.Players);
    const tile = (metric: OverviewMetric) => tiles.find((one) => one.metric === metric) ?? assert.fail(metric);
    assert.equal(tile(OverviewMetric.Day7).value, null, "nobody has had seven days yet");
    assert.deepEqual(tile(OverviewMetric.Day7).delta, { kind: bundle.DeltaKind.Points, now: null, before: null });
    assert.equal(tile(OverviewMetric.Day1).value, "25.0%");
    assert.deepEqual(tile(OverviewMetric.Day1).delta, { kind: bundle.DeltaKind.Points, now: 0.25, before: null });
    assert.equal(tile(OverviewMetric.MedianPlaySeconds).value, "1m 35s");
    assert.equal(tile(OverviewMetric.NexSpent).value, "0", "nothing spent is a real zero");
    assert.equal(tile(OverviewMetric.Players).value, "15");
  });

  it("are written for every period and kind of fixture game", () => {
    for (const kind of Object.values(SampleKind)) {
      for (const days of STATS_PERIODS) {
        const answer = fixtureAnswer(kind, days);
        const view = bundle.view.overviewView(answer, OverviewMetric.Players);
        assert.equal(view.tiles.length, kind === SampleKind.Rich ? 8 : 7, `${kind} ${days}`);
        assert.equal(view.chart?.labels.length, days, `${kind} ${days}`);
        assert.equal(view.empty, false, `${kind} ${days}`);
        for (const tile of view.tiles) assert.equal(tile.spark.length, days, `${kind} ${days} ${tile.metric}`);
      }
    }
  });
});

describe("the Overview's chart", () => {
  it("draws the number picked per day, the period before as a dashed line, and the marks on their days", () => {
    const answer = fixtureAnswer(SampleKind.Rich);
    const chart = bundle.view.overviewView(answer, OverviewMetric.Players).chart ?? assert.fail("no chart");
    const players = answer.data.series[OverviewMetric.Players] ?? assert.fail("no players");
    assert.equal(chart.metric, OverviewMetric.Players);
    assert.equal(chart.title, "Players per day");
    assert.deepEqual(chart.series, [
      { id: "now", label: formatDayRange("2026-10-19", "2026-11-17"), tone: LineTone.Main, values: players.daily },
      { id: "before", label: "30 days before", tone: LineTone.Before, values: players.dailyBefore },
    ]);
    assert.deepEqual(chart.legend, [
      { id: "now", label: formatDayRange("2026-10-19", "2026-11-17"), tone: LineTone.Main },
      { id: "before", label: "30 days before", tone: LineTone.Before },
    ]);
    assert.equal(chart.labels.length, 30);
    assert.deepEqual([chart.labels[0], chart.labels.at(-1)], [formatDay("2026-10-19"), formatDay("2026-11-17")]);
    assert.deepEqual(chart.marks, [
      { index: 17, kind: AnnotationKind.Campaign, label: "Campaign launch_trailer" },
      { index: 21, kind: AnnotationKind.Version, label: "Version 1.4.0" },
    ]);
    assert.equal(chart.empty, false);
  });

  it("names each number's chart and writes its values in the number's unit", () => {
    const answer = fixtureAnswer(SampleKind.Rich);
    const table: [OverviewMetric, string, number, string][] = [
      [OverviewMetric.Players, "Players per day", 1510, "1,510"],
      [OverviewMetric.NewPlayers, "New players per day", 824, "824"],
      [OverviewMetric.Plays, "Plays per day", 2084, "2,084"],
      [OverviewMetric.MedianPlaySeconds, "Median play length by day", 340, "5m 40s"],
      [OverviewMetric.Day1, "Day 1 retention by first-play day", 0.366, "36.6%"],
      [OverviewMetric.Day7, "Day 7 retention by first-play day", 0.094, "9.4%"],
      [OverviewMetric.Installs, "Installs per day", 1060, "1,060"],
      [OverviewMetric.NexSpent, "Nex spent per day", 2400, "2,400"],
    ];
    for (const [metric, title, value, written] of table) {
      const chart = bundle.view.overviewView(answer, metric).chart ?? assert.fail(metric);
      assert.equal(chart.metric, metric);
      assert.equal(chart.title, title);
      assert.equal(chart.format(value), written, metric);
      assert.deepEqual(chart.series[0]?.values, answer.data.series[metric]?.daily, metric);
      assert.deepEqual(chart.series[1]?.values, answer.data.series[metric]?.dailyBefore, metric);
    }
  });

  it("writes a rate's axis in whole percents while its readout keeps its decimal, and any other axis as its values", () => {
    const answer = fixtureAnswer(SampleKind.Rich);
    for (const metric of [OverviewMetric.Day1, OverviewMetric.Day7]) {
      const chart = bundle.view.overviewView(answer, metric).chart ?? assert.fail(metric);
      assert.deepEqual([chart.axisFormat(0.4), chart.axisFormat(0), chart.format(0.4)], ["40%", "0%", "40.0%"], metric);
    }
    const plays = bundle.view.overviewView(answer, OverviewMetric.Plays).chart ?? assert.fail("plays");
    assert.equal(plays.axisFormat(2000), "2,000");
    const { retention } = bundle.view.overviewView(answer, OverviewMetric.Players);
    assert.deepEqual([retention.axisFormat(0.4), retention.format(0.345)], ["40%", "34.5%"]);
  });

  it("says how long the period before is, for each period", () => {
    for (const days of STATS_PERIODS) {
      const chart = bundle.view.overviewView(fixtureAnswer(SampleKind.Steady, days), OverviewMetric.Plays).chart;
      assert.equal(chart?.series[1]?.label, `${days} days before`);
    }
    const week = bundle.view.overviewView(fixtureAnswer(SampleKind.Rich, 7), OverviewMetric.Players).chart;
    assert.equal(week?.series[0]?.label, formatDayRange("2026-11-11", "2026-11-17"));
    assert.deepEqual(week?.marks, [], "the campaign and the version began before this week");
  });

  it("has nothing to draw while no day of either period can be known, and says so instead of a flat line", () => {
    const young = fixtureAnswer(SampleKind.Young);
    assert.equal(bundle.view.overviewView(young, OverviewMetric.Day7).chart?.empty, true);
    assert.equal(bundle.view.overviewView(young, OverviewMetric.Day1).chart?.empty, false);
    assert.equal(bundle.view.overviewView(young, OverviewMetric.NexSpent).chart?.empty, false, "zeros are numbers");
    const week = fixtureAnswer(SampleKind.Rich, 7);
    assert.equal(
      bundle.view.overviewView(week, OverviewMetric.Day7).chart?.empty,
      false,
      "the week before has its Day 7, so its dashed line is drawn",
    );
  });

  it("is absent when no number has a series", () => {
    const view = bundle.view.overviewView(nothingAnswer(), OverviewMetric.Players);
    assert.deepEqual(view.tiles, []);
    assert.equal(view.chart, null);
  });
});

describe("the Overview's insights", () => {
  it("writes one sentence pair per insight from its typed fields, each opening the tab it is about", () => {
    const { insights } = bundle.view.overviewView(fixtureAnswer(SampleKind.Rich), OverviewMetric.Players);
    assert.deepEqual(insights, [
      {
        id: "level_drop_off-0",
        kind: InsightKind.LevelDropOff,
        tab: AnalyticsTab.Engagement,
        area: "Engagement",
        headline: "Level 4 loses more players than the levels around it",
        detail: "61% of players reach the level before it, 38% reach this one. It takes 4 tries to pass.",
        masked: true,
      },
      {
        id: "campaign_retention-1",
        kind: InsightKind.CampaignRetention,
        tab: AnalyticsTab.Acquisition,
        area: "Acquisition",
        headline: "launch_trailer brought 1,460 new players, and fewer of them stay",
        detail: "8.2% still play a week later, against 14.5% for everyone.",
        masked: true,
      },
      {
        id: "device_load-2",
        kind: InsightKind.DeviceLoad,
        tab: AnalyticsTab.Engagement,
        area: "Performance",
        headline: "Phones load the game 2.1× slower",
        detail: "6.1 s on phones, 2.9 s on other devices. 14% of phone players leave before it loads.",
        masked: false,
      },
      {
        id: "installed_retention-3",
        kind: InsightKind.InstalledRetention,
        tab: AnalyticsTab.Installs,
        area: "Installs",
        headline: "Players who install the app stay longer",
        detail: "26.1% still play a week later, against 12.2% in the browser.",
        masked: false,
      },
    ]);
  });

  it("keeps the order sent, names each row apart, and is nothing when there are none", () => {
    const load: Insight = {
      kind: InsightKind.DeviceLoad,
      device: DeviceClass.Tablet,
      loadSeconds: 8,
      loadSecondsOthers: 2,
      leftLoading: 0.3,
    };
    const equal: Insight = { kind: InsightKind.InstalledRetention, day7Installed: 0.2, day7Browser: 0.2 };
    assert.deepEqual(
      written([load, equal, { ...load, device: DeviceClass.Phone }]).map((insight) => insight.id),
      ["device_load-0", "device_load-2"],
    );
    assert.deepEqual(bundle.view.overviewView(fixtureAnswer(SampleKind.Young), OverviewMetric.Players).insights, []);
    assert.deepEqual(written([]), []);
  });
});

describe("the wording of an Overview insight", () => {
  it("words a level with no tries, one try and half a try, a campaign whose players stay more, and each device", () => {
    const level = { kind: InsightKind.LevelDropOff, level: "Boss", reachedBefore: 0.5, reached: 0.2 } as const;
    assert.equal(
      written([{ ...level, tries: null }])[0]?.detail,
      "50% of players reach the level before it, 20% reach this one.",
    );
    assert.equal(
      written([{ ...level, tries: 1 }])[0]?.detail,
      "50% of players reach the level before it, 20% reach this one. It takes 1 try to pass.",
    );
    assert.equal(
      written([{ ...level, tries: 2.5 }])[0]?.detail,
      "50% of players reach the level before it, 20% reach this one. It takes 2.5 tries to pass.",
    );
    assert.equal(
      written([{ ...level, tries: null }])[0]?.headline,
      "Boss loses more players than the levels around it",
      "a level the game names is shown as written, as Engagement shows it",
    );
    assert.equal(
      written([{ ...level, tries: null, level: "Level 3" }])[0]?.headline,
      "Level 3 loses more players than the levels around it",
      "never Level Level 3",
    );
    assert.equal(
      written([{ ...level, tries: null, level: "4" }])[0]?.headline,
      "Level 4 loses more players than the levels around it",
    );
    const campaign = { kind: InsightKind.CampaignRetention, campaign: "spring", day7All: 0.1 } as const;
    assert.equal(
      written([{ ...campaign, newPlayers: 1, day7: 0.2 }])[0]?.headline,
      "spring brought 1 new player, and more of them stay",
    );
    assert.equal(
      written([{ ...campaign, newPlayers: 12_500, day7: 0.05 }])[0]?.headline,
      "spring brought 12,500 new players, and fewer of them stay",
    );
    const load = { kind: InsightKind.DeviceLoad, loadSeconds: 9, loadSecondsOthers: 3, leftLoading: 0.2 } as const;
    assert.deepEqual(
      Object.values(DeviceClass).map((device) => {
        const [one] = written([{ ...load, device }]);
        return [one?.headline, one?.detail];
      }),
      [
        [
          "Computers load the game 3.0× slower",
          "9.0 s on computers, 3.0 s on other devices. 20% of computer players leave before it loads.",
        ],
        [
          "Phones load the game 3.0× slower",
          "9.0 s on phones, 3.0 s on other devices. 20% of phone players leave before it loads.",
        ],
        [
          "Tablets load the game 3.0× slower",
          "9.0 s on tablets, 3.0 s on other devices. 20% of tablet players leave before it loads.",
        ],
      ],
    );
  });
});

describe("an Overview insight whose numbers contradict its kind", () => {
  it("leaves out an insight whose numbers do not say what its kind says", () => {
    const table: [string, Insight][] = [
      [
        "a level as many reach",
        { kind: InsightKind.LevelDropOff, level: "4", reachedBefore: 0.4, reached: 0.4, tries: 3 },
      ],
      [
        "a level more reach",
        { kind: InsightKind.LevelDropOff, level: "4", reachedBefore: 0.3, reached: 0.4, tries: 3 },
      ],
      [
        "a campaign whose players stay as everyone does",
        { kind: InsightKind.CampaignRetention, campaign: "spring", newPlayers: 40, day7: 0.1, day7All: 0.1 },
      ],
      [
        "a device that loads no slower",
        {
          kind: InsightKind.DeviceLoad,
          device: DeviceClass.Phone,
          loadSeconds: 3,
          loadSecondsOthers: 3,
          leftLoading: 0.1,
        },
      ],
      [
        "a device that loads faster",
        {
          kind: InsightKind.DeviceLoad,
          device: DeviceClass.Phone,
          loadSeconds: 2,
          loadSecondsOthers: 3,
          leftLoading: 0.1,
        },
      ],
      [
        "a device with nothing to compare with",
        {
          kind: InsightKind.DeviceLoad,
          device: DeviceClass.Phone,
          loadSeconds: 2,
          loadSecondsOthers: 0,
          leftLoading: 0.1,
        },
      ],
      [
        "installed players who stay less",
        { kind: InsightKind.InstalledRetention, day7Installed: 0.1, day7Browser: 0.2 },
      ],
      [
        "installed players who stay the same",
        { kind: InsightKind.InstalledRetention, day7Installed: 0.2, day7Browser: 0.2 },
      ],
    ];
    for (const [name, insight] of table) assert.deepEqual(written([insight]), [], name);
    const installed: Insight = { kind: InsightKind.InstalledRetention, day7Installed: 0.3, day7Browser: 0.1 };
    assert.equal(written([installed]).length, 1);
    assert.deepEqual(
      written([installed], { hasAppBuild: false }),
      [],
      "a game with no app build has no Installs tab to open",
    );
  });
});

describe("the Overview's channels and funnel", () => {
  it("lists the channels that brought new players, most first as sent, under the app's names", () => {
    const { channels } = bundle.view.overviewView(fixtureAnswer(SampleKind.Rich), OverviewMetric.Players);
    assert.deepEqual(channels, [
      { id: SourceChannel.Genex, label: "Genex", value: 3790 },
      { id: SourceChannel.Campaigns, label: "Campaigns", value: 2480 },
      { id: SourceChannel.Social, label: "Social", value: 790 },
      { id: SourceChannel.Direct, label: "Direct", value: 520 },
      { id: SourceChannel.Search, label: "Search engines", value: 170 },
      { id: SourceChannel.Other, label: "Other sites", value: 90 },
    ]);
  });

  it("leaves out a channel that brought nobody, and is empty when none did", () => {
    const young = bundle.view.overviewView(fixtureAnswer(SampleKind.Young), OverviewMetric.Players);
    assert.deepEqual(
      young.channels.map((row) => [row.id, row.value]),
      [
        [SourceChannel.Genex, 8],
        [SourceChannel.Social, 3],
        [SourceChannel.Campaigns, 2],
        [SourceChannel.Direct, 2],
      ],
    );
    assert.deepEqual(bundle.view.overviewChannels([{ channel: SourceChannel.Genex, people: 0 }]), []);
    assert.deepEqual(bundle.view.overviewChannels([]), []);
  });

  it("lists the funnel's steps as they came, each a share of everyone who opened the page", () => {
    const { funnel } = bundle.view.overviewView(fixtureAnswer(SampleKind.Rich), OverviewMetric.Players);
    assert.deepEqual(funnel, {
      total: 19_380,
      items: [
        { id: FunnelStep.Visited, label: "Opened the game page", value: 19_380 },
        { id: FunnelStep.PressedPlay, label: "Pressed Play", value: 8560 },
        { id: FunnelStep.Loaded, label: "Game loaded", value: 7840 },
        { id: FunnelStep.Engaged, label: "Played 30 s or more", value: 5960 },
        { id: FunnelStep.Returned, label: "Came back another day", value: 2270 },
      ],
    });
  });

  it("draws the steps that came: a place with no Play button sends no pressed-play step", () => {
    const funnel = bundle.view.overviewFunnel([
      { step: FunnelStep.Visited, people: 100 },
      { step: FunnelStep.Loaded, people: 60 },
      { step: FunnelStep.Engaged, people: 30 },
      { step: FunnelStep.Returned, people: 9 },
    ]);
    assert.deepEqual(
      funnel?.items.map((item) => item.id),
      [FunnelStep.Visited, FunnelStep.Loaded, FunnelStep.Engaged, FunnelStep.Returned],
    );
    assert.equal(funnel?.total, 100);
  });

  it("has no funnel when nobody came, and no shares when the first step is not everyone", () => {
    assert.equal(bundle.view.overviewFunnel([]), null);
    assert.equal(
      bundle.view.overviewFunnel([
        { step: FunnelStep.Visited, people: 0 },
        { step: FunnelStep.Loaded, people: 0 },
      ]),
      null,
    );
    const headless = bundle.view.overviewFunnel([
      { step: FunnelStep.Loaded, people: 60 },
      { step: FunnelStep.Engaged, people: 30 },
    ]);
    assert.equal(headless?.total, 0, "nothing to divide by: the shares read as dashes");
    assert.equal(headless?.items.length, 2);
  });
});

describe("the Overview's retention block, and an answer with nothing in it", () => {
  it("reads Day 1, Day 7 and Day 30 off the retention curve and draws it against similar games", () => {
    const answer = fixtureAnswer(SampleKind.Rich);
    const { retention } = bundle.view.overviewView(answer, OverviewMetric.Players);
    assert.deepEqual(retention.stats, [
      { id: "day1", label: "Day 1", value: "34.5%" },
      { id: "day7", label: "Day 7", value: "14.5%" },
      { id: "day30", label: "Day 30", value: "5.3%" },
    ]);
    assert.deepEqual(retention.series, [
      { id: "game", label: "This game", tone: LineTone.Main, values: answer.data.retention.rates },
      { id: "similar", label: "Similar games", tone: LineTone.Similar, values: answer.data.retention.similar },
    ]);
    assert.deepEqual(retention.legend, [
      { id: "game", label: "This game", tone: LineTone.Main },
      { id: "similar", label: "Similar games", tone: LineTone.Similar },
    ]);
    assert.equal(retention.labels.length, 30);
    assert.deepEqual([retention.labels[0], retention.labels[6], retention.labels[29]], ["Day 1", "Day 7", "Day 30"]);
    assert.deepEqual(retention.ticks, [0, 6, 13, 20, 29]);
    assert.equal(retention.empty, false);
  });

  it("drops the similar line and its legend entry while there are too few games to compare with", () => {
    const { retention } = bundle.view.overviewView(fixtureAnswer(SampleKind.Young), OverviewMetric.Players);
    assert.deepEqual(
      retention.series.map((line) => line.id),
      ["game"],
    );
    assert.deepEqual(
      retention.legend.map((item) => item.id),
      ["game"],
    );
    assert.deepEqual(
      retention.stats.map((stat) => stat.value),
      ["25.0%", null, null],
      "Day 7 and Day 30 cannot be known two days in",
    );
    assert.equal(retention.empty, false);
  });

  it("has no curve to draw while no day is known, and labels only the days a short curve reaches", () => {
    const none = bundle.view.overviewRetention({ rates: [], before: [], similar: null });
    assert.equal(none.empty, true);
    assert.deepEqual(
      none.stats.map((stat) => stat.value),
      [null, null, null],
    );
    const unripe = bundle.view.overviewRetention({ rates: [null, null], before: [0.2, 0.1], similar: [0.3, 0.2] });
    assert.equal(unripe.empty, true, "what similar games do is no curve of this game's");
    const short = bundle.view.overviewRetention({
      rates: Array.from({ length: 10 }, () => 0.2),
      before: Array.from({ length: 10 }, () => 0.2),
      similar: null,
    });
    assert.deepEqual(short.ticks, [0, 6]);
    assert.deepEqual(
      short.stats.map((stat) => stat.value),
      ["20.0%", "20.0%", null],
    );
  });

  it("knows an answer with nothing in it from a game nobody has played", () => {
    assert.equal(bundle.view.overviewView(nothingAnswer(), OverviewMetric.Players).empty, true);
    const dormant = fixtureAnswer(SampleKind.Steady, 7, { dormant: true });
    const view = bundle.view.overviewView(dormant, OverviewMetric.Players);
    assert.equal(view.empty, false);
    assert.equal(view.tiles[0]?.value, "0");
    assert.deepEqual(view.channels, []);
    assert.equal(view.funnel, null);
    assert.equal(view.retention.empty, true);
  });
});

describe("the Overview's face: the rich game's tiles and chart", () => {
  it("the rich game: eight tiles that are buttons, Players pressed, each with its number and its change", () => {
    const markup = drawReport(fixtureAnswer(SampleKind.Rich));
    assert.match(markup, /^<div class="game-analytics-report" data-game-analytics-report="overview">/);
    const tiles = tags(markup, /<button[^>]*data-game-analytics-tile="[^"]*"[^>]*>/);
    assert.deepEqual(
      tiles.map((tile) => [
        /data-game-analytics-tile="([^"]*)"/.exec(tile)?.[1],
        /aria-pressed="([^"]*)"/.exec(tile)?.[1],
      ]),
      [
        [OverviewMetric.Players, "true"],
        [OverviewMetric.NewPlayers, "false"],
        [OverviewMetric.Plays, "false"],
        [OverviewMetric.MedianPlaySeconds, "false"],
        [OverviewMetric.Day1, "false"],
        [OverviewMetric.Day7, "false"],
        [OverviewMetric.Installs, "false"],
        [OverviewMetric.NexSpent, "false"],
      ],
    );
    assert.deepEqual(
      Object.values(OverviewMetric).map((metric) => words(tileOf(markup, metric))),
      [
        "Players 9,300 +66%",
        "New players 7,840 +81%",
        "Plays 30,889 +68%",
        "Median play length 5m 40s +22 s",
        "Day 1 retention 34.5% +2.1 pts",
        "Day 7 retention 14.5% +0.8 pts",
        "Installs 1,060 +38%",
        "Nex spent 48,610 +54%",
      ],
    );
    assert.equal(tags(markup, /<canvas[^>]*game-analytics-tile-spark[^>]*>/).length, 8, "a sparkline in every tile");
  });

  it("the rich game: the chart of the number picked, the period before in its legend and the marks in its table", () => {
    const answer = fixtureAnswer(SampleKind.Rich);
    const markup = drawReport(answer);
    const section = sectionOf(markup, "daily");
    assert.match(section, /<h2[^>]*>Players per day<\/h2>/);
    assert.match(section, /<figure[^>]*data-game-analytics-chart="daily"[^>]*data-chart="line"/);
    assert.deepEqual(
      tags(section, /<span class="game-analytics-swatch" data-line="[^"]*"/).map(
        (tag) => /data-line="([^"]*)"/.exec(tag)?.[1],
      ),
      [LineTone.Main, LineTone.Before],
    );
    assert.match(words(section), new RegExp(`${formatDayRange("2026-10-19", "2026-11-17")} 30 days before`));
    assert.equal(tags(section, /<tr><th scope="row">/).length, 30, "a row per day");
    const dayBefore = answer.data.series[OverviewMetric.Players]?.dailyBefore[17];
    assert.equal(
      words(tableRow(section, formatDay("2026-11-05"))),
      `${formatDay("2026-11-05")} 1,180 ${dayBefore} Campaign launch_trailer`,
      "the campaign's first day: its players, the same day of the period before, and the mark",
    );
    assert.match(words(tableRow(section, formatDay("2026-11-09"))), /Version 1\.4\.0$/);
    assert.doesNotMatch(words(tableRow(section, formatDay("2026-11-10"))), /Campaign|Version/);
  });

  it("a press on a tile shows its number: the tile pressed, the chart retitled, the values in its unit", () => {
    const markup = drawFace(fixtureAnswer(SampleKind.Rich), OverviewMetric.Day7);
    assert.match(tileOf(markup, OverviewMetric.Day7), /aria-pressed="true"/);
    assert.match(tileOf(markup, OverviewMetric.Players), /aria-pressed="false"/);
    const section = sectionOf(markup, "daily");
    assert.match(section, /<h2[^>]*>Day 7 retention by first-play day<\/h2>/);
    assert.match(section, /role="img" aria-label="Day 7 retention by first-play day"/);
    const newest = tableRow(section, formatDay("2026-11-17"));
    assert.match(
      newest,
      /<td><\/td><td>[\d.]+%<\/td>/,
      "no Day 7 yet for today's players: an empty cell, the day before's rate beside it",
    );
    assert.doesNotMatch(section, /<td>0(\.0)?%<\/td>/, "never a zero for a day that cannot be known");
  });
});

describe("the Overview's face: what is worth a look", () => {
  it("the rich game: what is worth a look, each row a button to its tab with the creator's words kept out of replays", () => {
    const markup = drawReport(fixtureAnswer(SampleKind.Rich));
    const section = sectionOf(markup, "insights");
    assert.match(section, /<h2[^>]*>Worth a look<\/h2>/);
    const rows = tags(section, /<button[^>]*data-game-analytics-insight="[^"]*"[^>]*>.*?<\/button>/);
    assert.deepEqual(
      rows.map((row) => [
        /data-game-analytics-insight="([^"]*)"/.exec(row)?.[1],
        /data-game-analytics-open="([^"]*)"/.exec(row)?.[1],
        /<span class="game-analytics-overview-insight-text"( data-analytics-mask="true")?>/.exec(row)?.[1] !==
          undefined,
        words(row),
      ]),
      [
        [
          InsightKind.LevelDropOff,
          AnalyticsTab.Engagement,
          true,
          "Engagement Level 4 loses more players than the levels around it 61% of players reach the level before it, 38% reach this one. It takes 4 tries to pass.",
        ],
        [
          InsightKind.CampaignRetention,
          AnalyticsTab.Acquisition,
          true,
          "Acquisition launch_trailer brought 1,460 new players, and fewer of them stay 8.2% still play a week later, against 14.5% for everyone.",
        ],
        [
          InsightKind.DeviceLoad,
          AnalyticsTab.Engagement,
          false,
          "Performance Phones load the game 2.1× slower 6.1 s on phones, 2.9 s on other devices. 14% of phone players leave before it loads.",
        ],
        [
          InsightKind.InstalledRetention,
          AnalyticsTab.Installs,
          false,
          "Installs Players who install the app stay longer 26.1% still play a week later, against 12.2% in the browser.",
        ],
      ],
    );
  });

  it("gives every control a stable attribute, and keeps a person's words inside one out of replays", () => {
    const answer = fixtureAnswer(SampleKind.Rich);
    const named: Insight[] = [
      { kind: InsightKind.CampaignRetention, campaign: "<b>summer</b> & co", newPlayers: 2, day7: 0.3, day7All: 0.1 },
      {
        kind: InsightKind.LevelDropOff,
        level: "The Long Dark Cellar Of Many Doors",
        reachedBefore: 0.9,
        reached: 0.1,
        tries: null,
      },
    ];
    const markup = drawReport(withData(answer, { insights: named }));
    for (const button of tags(markup, /<button[^>]*>/))
      assert.match(button, / data-game-analytics-[a-z]+="[^"]+"/, button);
    const rows = tags(
      sectionOf(markup, "insights"),
      /<button[^>]*data-game-analytics-insight="[^"]*"[^>]*>.*?<\/button>/,
    );
    assert.equal(rows.length, 2);
    for (const row of rows) {
      const masked =
        /<span class="game-analytics-overview-insight-text" data-analytics-mask="true">.*?<\/span><\/span>/.exec(
          row,
        )?.[0] ?? "";
      assert.equal(words(row.replace(masked, "")), words(row).split(" ")[0], "only the tab's name is outside the mask");
    }
    assert.match(words(rows[0] ?? ""), /^Acquisition <b>summer<\/b> & co brought 2 new players, and more of them stay/);
    assert.doesNotMatch(markup, /<b>summer/, "a name is text, never markup");
  });
});

describe("the Overview's face: the first looks at the other reports", () => {
  it("the rich game: the channels with their shares, the retention block and the funnel, each opening its tab", () => {
    const answer = fixtureAnswer(SampleKind.Rich);
    const markup = drawReport(answer);
    assert.deepEqual(barRows(markup, "channels"), [
      "Genex 3,790 48%",
      "Campaigns 2,480 32%",
      "Social 790 10%",
      "Direct 520 7%",
      "Search engines 170 2%",
      "Other sites 90 1%",
    ]);
    assert.deepEqual(barRows(markup, "funnel"), [
      "Opened the game page 19,380 100.0%",
      "Pressed Play 8,560 44.2%",
      "Game loaded 7,840 40.5%",
      "Played 30 s or more 5,960 30.8%",
      "Came back another day 2,270 11.7%",
    ]);
    const retention = sectionOf(markup, "retention");
    assert.match(
      words(retention),
      /^Do new players come back Retention Day 1 34\.5% Day 7 14\.5% Day 30 5\.3% This game Similar games/,
    );
    assert.match(retention, /<figure[^>]*data-game-analytics-chart="retention"/);
    const similar = answer.data.retention.similar?.[6] ?? assert.fail("no similar games");
    assert.equal(words(tableRow(retention, "Day 7")), `Day 7 14.5% ${(similar * 100).toFixed(1)}%`);
    const opens = (id: string): (string | undefined)[] =>
      tags(sectionOf(markup, id), /<button[^>]*class="game-analytics-overview-open"[^>]*>/).map(
        (tag) => /data-game-analytics-open="([^"]*)"/.exec(tag)?.[1],
      );
    assert.deepEqual(opens("channels"), [AnalyticsTab.Acquisition]);
    assert.deepEqual(opens("retention"), [AnalyticsTab.Retention]);
    assert.deepEqual(opens("funnel"), [AnalyticsTab.Acquisition]);
    assert.match(sectionOf(markup, "channels"), /<h2[^>]*>Where new players came from<\/h2>/);
    assert.match(sectionOf(markup, "funnel"), /<h2[^>]*>New visitors, step by step<\/h2>/);
  });

  it("the young game: no Installs tile, dashes for what cannot be known, nothing worth a look, no similar games", () => {
    const markup = drawReport(fixtureAnswer(SampleKind.Young));
    assert.equal(tags(markup, /<button[^>]*data-game-analytics-tile="[^"]*"[^>]*>/).length, 7);
    assert.equal(tileOf(markup, OverviewMetric.Installs), "");
    assert.equal(words(tileOf(markup, OverviewMetric.Day7)), "Day 7 retention — —");
    assert.match(tileOf(markup, OverviewMetric.Day7), /<span class="stats-tile-value" data-missing="true">—<\/span>/);
    assert.equal(
      words(tileOf(markup, OverviewMetric.Day1)),
      "Day 1 retention 25.0% —",
      "nothing before to compare with",
    );
    assert.equal(words(tileOf(markup, OverviewMetric.Players)), "Players 15 New");
    assert.equal(words(tileOf(markup, OverviewMetric.NexSpent)), "Nex spent 0 —");
    assert.equal(sectionOf(markup, "insights"), "", "no block when there is nothing to say");
    assert.deepEqual(barRows(markup, "channels"), ["Genex 8 53%", "Social 3 20%", "Campaigns 2 13%", "Direct 2 13%"]);
    const retention = sectionOf(markup, "retention");
    assert.match(words(retention), /Day 1 25\.0% Day 7 — Day 30 — This game/);
    assert.doesNotMatch(retention, /Similar games/);
    assert.doesNotMatch(retention, /data-line="similar"/);
    assert.equal(words(tableRow(retention, "Day 3")), "Day 3", "a day that has not passed is an empty cell");
    assert.deepEqual(barRows(markup, "funnel")[0], "Opened the game page 38 100.0%");
    assert.doesNotMatch(markup, />0(\.0)?%</, "nothing unknown is drawn as zero");
  });
});

describe("the Overview's face with little or nothing to show", () => {
  it("the young game: a number no day of which is known says so in place of its chart", () => {
    const section = sectionOf(drawFace(fixtureAnswer(SampleKind.Young), OverviewMetric.Day7), "daily");
    assert.match(section, /<h2[^>]*>Day 7 retention by first-play day<\/h2>/);
    assert.match(
      section,
      /<p class="game-analytics-empty" data-game-analytics-empty="true">Too early for this number\./,
    );
    assert.doesNotMatch(section, /data-game-analytics-chart/);
  });

  it("an answer with nothing in it: one line saying so, and nothing to press", () => {
    const markup = drawReport(nothingAnswer());
    assert.equal(
      markup,
      '<div class="game-analytics-report" data-game-analytics-report="overview">' +
        '<p class="game-analytics-empty" data-game-analytics-empty="true">No numbers for these days yet.</p></div>',
    );
  });

  it("a game nobody played in the period: zeros where they are counts, dashes for rates, a line in each empty block", () => {
    const markup = drawReport(fixtureAnswer(SampleKind.Steady, 7, { dormant: true }));
    assert.equal(words(tileOf(markup, OverviewMetric.Players)), "Players 0 —");
    assert.equal(words(tileOf(markup, OverviewMetric.MedianPlaySeconds)), "Median play length — —");
    assert.equal(words(tileOf(markup, OverviewMetric.Day1)), "Day 1 retention — —");
    assert.match(sectionOf(markup, "daily"), /data-game-analytics-chart="daily"/, "a flat line of zeros is a chart");
    assert.equal(sectionOf(markup, "insights"), "");
    assert.match(words(sectionOf(markup, "channels")), /No new players in these days\.$/);
    assert.match(words(sectionOf(markup, "funnel")), /No new visitors in these days\.$/);
    const retention = sectionOf(markup, "retention");
    assert.match(words(retention), /Day 1 — Day 7 — Day 30 — Too early to tell\./);
    assert.doesNotMatch(retention, /data-game-analytics-chart|data-game-analytics-legend/);
  });
});
