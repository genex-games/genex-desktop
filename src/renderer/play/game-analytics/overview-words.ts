/**
 * The Overview's words: its tiles and the chart each one picks, the sentences an insight is told
 * in, the names of the channels and of the funnel's steps, and what a block says while it has
 * nothing to show. Whole sentences with their numbers as placeholders, so each language orders
 * them its own way; the numbers arrive already written by the kit's formatters.
 */
import { DeviceClass, OverviewMetric } from "../../../shared/game-analytics.ts";
import { t } from "../../../shared/i18n.ts";
import { REPORT_WORDS } from "./report-words.ts";

/** What a device is called in an insight: the headline, then the two sentences under it. */
interface DeviceWords {
  /** `times` is how many times longer it takes to load, written ("2.1"). */
  headline: (times: string) => string;
  /** The device's load time and everyone else's, and the share of its players who leave before it loads. */
  detail: (seconds: string, others: string, left: string) => string;
}

/** The Overview's own copy. */
export const OVERVIEW_WORDS = {
  /** Each tile's label. */
  metrics: {
    [OverviewMetric.Players]: t("Players"),
    [OverviewMetric.NewPlayers]: t("New players"),
    [OverviewMetric.Plays]: t("Plays"),
    [OverviewMetric.MedianPlaySeconds]: t("Median play length"),
    [OverviewMetric.Day1]: t("Day 1 retention"),
    [OverviewMetric.Day7]: t("Day 7 retention"),
    [OverviewMetric.Installs]: t("Installs"),
    [OverviewMetric.NexSpent]: t("Nex spent"),
  } satisfies Record<OverviewMetric, string>,
  /** The chart's title for the number picked. */
  charts: {
    [OverviewMetric.Players]: t("Players per day"),
    [OverviewMetric.NewPlayers]: t("New players per day"),
    [OverviewMetric.Plays]: t("Plays per day"),
    [OverviewMetric.MedianPlaySeconds]: t("Median play length by day"),
    [OverviewMetric.Day1]: t("Day 1 retention by first-play day"),
    [OverviewMetric.Day7]: t("Day 7 retention by first-play day"),
    [OverviewMetric.Installs]: t("Installs per day"),
    [OverviewMetric.NexSpent]: t("Nex spent per day"),
  } satisfies Record<OverviewMetric, string>,
  /** The dashed line's name: the period before, by its length. */
  daysBefore: REPORT_WORDS.daysBefore,
  /** In place of the chart while no day of the number picked can be known. */
  chartEmpty: t("Too early for this number. It fills in as the days pass."),
  /** In place of everything when the answer holds no number at all. */
  empty: t("No numbers for these days yet."),

  insightsTitle: t("Worth a look"),
  /** What an insight about how the game runs is filed under; the others are filed under their tab's name. */
  performance: t("Performance"),
  level: {
    /** `level` is the level's name as every tab writes it ("Level 4", or the name the game gave). */
    headline: (level: string) => t("{level} loses more players than the levels around it", { level }),
    detail: (before: string, reached: string) =>
      t("{before} of players reach the level before it, {reached} reach this one.", { before, reached }),
    /** `tries` picks the plural; `shown` is the same number as it is written. */
    detailWithTries: (before: string, reached: string, tries: number, shown: string) =>
      t(
        "{before} of players reach the level before it, {reached} reach this one. It takes {tries, plural, one {{shown} try} other {{shown} tries}} to pass.",
        { before, reached, tries, shown },
      ),
  },
  campaign: {
    /** `count` picks the plural; `shown` is the same number as it is written. */
    fewerStay: (name: string, count: number, shown: string) =>
      t(
        "{name} brought {count, plural, one {{shown} new player} other {{shown} new players}}, and fewer of them stay",
        { name, count, shown },
      ),
    moreStay: (name: string, count: number, shown: string) =>
      t("{name} brought {count, plural, one {{shown} new player} other {{shown} new players}}, and more of them stay", {
        name,
        count,
        shown,
      }),
    detail: (day7: string, everyone: string) =>
      t("{day7} still play a week later, against {everyone} for everyone.", { day7, everyone }),
  },
  device: {
    [DeviceClass.Computer]: {
      headline: (times) => t("Computers load the game {times}× slower", { times }),
      detail: (seconds, others, left) =>
        t("{seconds} on computers, {others} on other devices. {left} of computer players leave before it loads.", {
          seconds,
          others,
          left,
        }),
    },
    [DeviceClass.Phone]: {
      headline: (times) => t("Phones load the game {times}× slower", { times }),
      detail: (seconds, others, left) =>
        t("{seconds} on phones, {others} on other devices. {left} of phone players leave before it loads.", {
          seconds,
          others,
          left,
        }),
    },
    [DeviceClass.Tablet]: {
      headline: (times) => t("Tablets load the game {times}× slower", { times }),
      detail: (seconds, others, left) =>
        t("{seconds} on tablets, {others} on other devices. {left} of tablet players leave before it loads.", {
          seconds,
          others,
          left,
        }),
    },
  } satisfies Record<DeviceClass, DeviceWords>,
  installed: {
    headline: t("Players who install the app stay longer"),
    detail: (installed: string, browser: string) =>
      t("{installed} still play a week later, against {browser} in the browser.", { installed, browser }),
  },

  channelsTitle: t("Where new players came from"),
  /** What the channels' list is, read aloud. */
  channelsLabel: t("New players by where they came from"),
  channelsEmpty: REPORT_WORDS.noNewPlayers,
  /** A channel's name; Genex is the product's own and is never translated. */
  channels: REPORT_WORDS.channels,

  retentionTitle: t("Do new players come back"),
  /** What the curve shows, read aloud and as its table's caption. */
  retentionLabel: t("New players who play again, by days since their first play"),
  retentionEmpty: REPORT_WORDS.tooEarly,
  /** A day since the first play: a mini stat's label and a place on the curve. */
  day: REPORT_WORDS.day,
  /** The curve's first column heading in its table. */
  daysSince: REPORT_WORDS.daysSince,
  thisGame: t("This game"),
  similarGames: t("Similar games"),

  funnelTitle: t("New visitors, step by step"),
  /** What the funnel's list is, read aloud. */
  funnelLabel: t("How far new visitors get"),
  funnelEmpty: REPORT_WORDS.noNewVisitors,
  steps: REPORT_WORDS.steps,
} as const;
