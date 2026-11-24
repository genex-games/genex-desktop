/**
 * The Engagement report's words: its tiles and what each one counts, the names of the play lengths
 * and of the devices, the sentences under its charts, and what a block says while it has nothing
 * to show. Whole sentences with their numbers as placeholders, so each language orders them its
 * own way; the numbers arrive already written by the kit's formatters.
 */
import { PlayLength } from "../../../shared/game-analytics.ts";
import { t, tc } from "../../../shared/i18n.ts";
import { REPORT_WORDS } from "./report-words.ts";

/** What a block says while nobody has played in it. */
const NO_PLAYS = t("No plays in these days yet.");

/** The Engagement's own copy. */
export const ENGAGEMENT_WORDS = {
  /** In place of everything when nobody played in the period or the one before. */
  empty: NO_PLAYS,

  tiles: {
    plays: t("Plays"),
    playsPerPlayerDay: t("Plays per player a day"),
    medianPlay: t("Median play length"),
    playTime: t("Total play time"),
    playTimePerPlayerDay: t("Play time per player a day"),
    quickExits: t("Quick exits"),
    peak: t("Most playing at once"),
    dailyShare: t("Daily share of monthly players"),
  },
  notes: {
    plays: t("counted once the game has loaded"),
    onDaysTheyPlay: t("on the days they play"),
    /** `length` is the 90th percentile play, written. */
    nineInTen: (length: string) => t("9 in 10 plays end within {length}", { length }),
    playTime: t("everyone’s plays added up"),
    /** `length` is how short a quick exit is, written ("10 s"). */
    quickExits: (length: string) => t("plays that end within {length}", { length }),
    /** `when` is the hour of the most playing at once, written on the viewer's clock. */
    peakAt: (when: string) => t("{when}, your time", { when }),
    /** `days` picks the plural; the daily and monthly players are written. */
    dailyShare: (daily: string, monthly: string, days: number) =>
      t("{daily} a day of {monthly} in {days, plural, one {# day} other {# days}}", { daily, monthly, days }),
  },
  /** How a change in quick exits is told: fewer is the good way. */
  fewer: (points: string) => t("{points}, fewer", { points }),
  more: (points: string) => t("{points}, more", { points }),

  lengths: {
    title: t("How long a play lasts"),
    label: t("Share of plays by length"),
    bucket: {
      [PlayLength.Under10s]: t("< 10 s"),
      [PlayLength.Under1m]: t("10–60 s"),
      [PlayLength.Under3m]: t("1–3 min"),
      [PlayLength.Under10m]: t("3–10 min"),
      [PlayLength.Under30m]: t("10–30 min"),
      [PlayLength.Over30m]: t("30 min +"),
    } satisfies Record<PlayLength, string>,
    /** The half of plays that end sooner than the median, and what a quick exit is. */
    median: (median: string, quick: string) =>
      t("Half of all plays last under {median}. Plays under {quick} count as quick exits.", { median, quick }),
    quickOnly: (quick: string) => t("Plays under {quick} count as quick exits.", { quick }),
    empty: NO_PLAYS,
  },

  days: {
    title: t("How many days a week they play"),
    label: t("Share of weekly players by days played"),
    /** The first and the last bar say what they count; the ones between are numbers. */
    bar: (days: number) => t("{days, plural, one {# day} other {# days}}", { days }),
    /** `days` picks the plural and is the number written; `share` is who play that often. */
    regulars: (share: string, days: number) =>
      t(
        "Of everyone who played in a week. {share} play on {days, plural, one {# day} other {# days}} or more: your regulars.",
        {
          share,
          days,
        },
      ),
    empty: t("No players in these days yet."),
  },

  hours: {
    title: t("When they play"),
    corner: t("Weekday"),
    mine: t("My time"),
    players: t("Players’ time"),
    switchLabel: t("Clock"),
    labelMine: t("Plays by weekday and hour, on your clock"),
    labelPlayers: t("Plays by weekday and hour, on each player’s own clock"),
    busiest: (day: string, hour: string) => t("Busiest hour: {day} at {hour}", { day, hour }),
    fewer: t("Fewer plays"),
    more: tc("scale", "More"),
    empty: NO_PLAYS,
  },

  levels: {
    title: t("How far players get"),
    label: t("Share of the players who started the first level, by the level they finished"),
    /** `count` picks the plural; `shown` is the same number written. */
    hint: (count: number, shown: string, level: string) =>
      t("Of {count, plural, one {{shown} player} other {{shown} players}} who started {level}", {
        count,
        shown,
        level,
      }),
    /** The names of the events the report is drawn from, written for the link. */
    fromEvents: (events: string) => t("From your events {events}", { events }),
    tries: t("Tries to pass"),
    time: t("Time to pass"),
    note: t("Percent who finished each level."),
    /** The level that loses the most; `points` picks the plural, `shownPoints` is the same number written. */
    loses: (level: string, points: number, shownPoints: string) =>
      t(
        "Percent who finished each level. {level} loses the most: {points, plural, one {{shownPoints} point} other {{shownPoints} points}}.",
        { level, points, shownPoints },
      ),
    losesAfter: (level: string, points: number, shownPoints: string, tries: number, shownTries: string) =>
      t(
        "Percent who finished each level. {level} loses the most: {points, plural, one {{shownPoints} point} other {{shownPoints} points}}, after {tries, plural, one {{shownTries} try} other {{shownTries} tries}}.",
        { level, points, shownPoints, tries, shownTries },
      ),
    /** A game that sends no level events yet: the names are the events it has to send. */
    unsent: (start: string, complete: string, fail: string) =>
      t("This fills in once your game sends {start}, {complete} and {fail}.", { start, complete, fail }),
    openSdk: t("Open SDK"),
    nobody: t("Nobody has played a level in these days yet."),
  },

  run: {
    title: t("How it runs"),
    tiles: {
      loadTime: t("Load time, median"),
      loaded: t("Loaded"),
      smooth: t("Smooth plays"),
      clean: t("Plays without errors"),
    },
    notes: {
      /** `seconds` is the 90th percentile load, written. */
      loadWithin: (seconds: string) => t("9 in 10 load within {seconds}", { seconds }),
      loadWithinSince: (seconds: string, version: string) =>
        t("9 in 10 load within {seconds}. The change came with version {version}.", { seconds, version }),
      since: (version: string) => t("The change came with version {version}.", { version }),
      loaded: t("of plays that were started"),
      smooth: (fps: number) => t("held {fps} frames a second or more", { fps }),
      clean: t("no script error, no crash"),
    },
  },

  devices: {
    title: t("By device"),
    label: t("How the game runs by device"),
    empty: t("Nothing has run in these days yet."),
    names: REPORT_WORDS.devices,
    columns: {
      device: t("Device"),
      share: t("Share of plays"),
      loadTime: t("Load time"),
      loaded: t("Loaded"),
      fps: t("Frames a second"),
      clean: t("Without errors"),
    },
    /** A word after a number that is far from the others, so the flag is not told by colour alone. */
    slow: t("slow"),
    low: t("low"),
  },
} as const;
