/**
 * The Retention report's words: its tiles, the three switches, what each block is called and says
 * while it has nothing to show, and the names of the groups new players are compared by. Whole
 * sentences with their numbers and names as placeholders, so each language orders them its own
 * way; the numbers and days arrive already written by the kit's formatters.
 */
import { CohortSize, PlayPlace, RetentionMode, SegmentBy } from "../../../shared/game-analytics.ts";
import { t, tc } from "../../../shared/i18n.ts";
import { REPORT_WORDS } from "./report-words.ts";

/** The Retention report's own copy. */
export const RETENTION_WORDS = {
  /** A day, or a week, since the first play: a tile's label, a column's heading, a place on the curve. */
  day: REPORT_WORDS.day,
  week: (week: number) => t("Week {week}", { week }),
  /** A tile's quiet line: the same day's rate for similar games, already written ("31.0%"). */
  similar: (rate: string) => t("similar games {rate}", { rate }),

  /** The switch that says what counts as coming back: its visible label, which also names it aloud. */
  modeLabel: t("Came back"),
  modes: {
    [RetentionMode.OnDay]: t("On that day"),
    [RetentionMode.DayOrLater]: t("That day or later"),
  } satisfies Record<RetentionMode, string>,
  /** The switch that groups first plays into cohorts. */
  cohortLabel: t("Group first plays"),
  cohortSizes: {
    [CohortSize.Day]: t("By day"),
    [CohortSize.Week]: t("By week"),
  } satisfies Record<CohortSize, string>,

  curveTitle: t("New players who play again, by day since their first play"),
  /** The dashed line's name: the period before, by its length. */
  daysBefore: REPORT_WORDS.daysBefore,
  similarGames: t("Similar games on Genex"),
  /** The curve's first column heading in its table. */
  daysSince: REPORT_WORDS.daysSince,
  curveEmpty: REPORT_WORDS.tooEarly,

  /** The cohort table: its title, its caption read aloud, and the line beside the title, by how first plays are grouped. */
  cohortTitles: {
    [CohortSize.Day]: t("By first-play day"),
    [CohortSize.Week]: t("By first-play week"),
  } satisfies Record<CohortSize, string>,
  cohortCaptions: {
    [CohortSize.Day]: t("Retention by first-play day"),
    [CohortSize.Week]: t("Retention by first-play week"),
  } satisfies Record<CohortSize, string>,
  cohortHints: {
    [CohortSize.Day]: {
      [RetentionMode.OnDay]: t(
        "Percent of each day’s new players who played again that many days later. Empty cells have not happened yet.",
      ),
      [RetentionMode.DayOrLater]: t(
        "Percent of each day’s new players who played again that many days later, or any day after. Empty cells have not happened yet.",
      ),
    },
    [CohortSize.Week]: {
      [RetentionMode.OnDay]: t(
        "Percent of each week’s new players who played again that many weeks later. Empty cells have not happened yet.",
      ),
      [RetentionMode.DayOrLater]: t(
        "Percent of each week’s new players who played again that many weeks later, or any week after. Empty cells have not happened yet.",
      ),
    },
  } satisfies Record<CohortSize, Record<RetentionMode, string>>,
  firstPlay: t("First play"),
  newPlayers: t("New players"),
  noNewPlayers: REPORT_WORDS.noNewPlayers,
  /** What a flagged cohort's dot says, and the line under the table that explains the dots. */
  flag: (campaign: string) => t("The {campaign} campaign brought most of these new players", { campaign }),
  flagNotes: {
    [CohortSize.Day]: {
      one: (campaign: string) => t("Days when the {campaign} campaign brought most new players", { campaign }),
      /** `campaigns` is the names as a list ("a, b and c"). */
      several: (campaigns: string) => t("Days when one campaign brought most new players: {campaigns}", { campaigns }),
    },
    [CohortSize.Week]: {
      one: (campaign: string) => t("Weeks when the {campaign} campaign brought most new players", { campaign }),
      several: (campaigns: string) => t("Weeks when one campaign brought most new players: {campaigns}", { campaigns }),
    },
  } satisfies Record<CohortSize, { one: (campaign: string) => string; several: (campaigns: string) => string }>,

  segmentsTitle: t("Compare groups of new players"),
  /** What the comparison's switch chooses, read aloud. */
  segmentSwitch: t("Compare by"),
  segmentBy: {
    [SegmentBy.Place]: t("Where they play"),
    [SegmentBy.Channel]: tc("traffic", "Source"),
    [SegmentBy.Device]: t("Device"),
    [SegmentBy.Country]: t("Country"),
    [SegmentBy.Version]: t("Version"),
  } satisfies Record<SegmentBy, string>,
  /** The comparison table's caption, read aloud. */
  segmentCaptions: {
    [SegmentBy.Place]: t("Retention by where new players play"),
    [SegmentBy.Channel]: t("Retention by where new players came from"),
    [SegmentBy.Device]: t("Retention by what new players play on"),
    [SegmentBy.Country]: t("Retention by new players’ country"),
    [SegmentBy.Version]: t("Retention by the version new players first played"),
  } satisfies Record<SegmentBy, string>,
  group: t("Group"),
  segmentsEmpty: t("No new players to compare in these days."),
  allNewPlayers: t("All new players"),
  places: {
    [PlayPlace.Browser]: t("Browser, on genex.games"),
    [PlayPlace.GenexApp]: t("Genex app, in Play"),
    [PlayPlace.Installed]: t("Installed on their computer"),
  } satisfies Record<PlayPlace, string>,
  /** A channel's name; Genex is the product's own and is never translated. */
  channels: REPORT_WORDS.channels,
  devices: REPORT_WORDS.devices,

  weeksTitle: t("Players each week: who is new, who stayed, who left"),
  /**
   * The line beside the title: the latest week's players, all told. `day` is its Monday, written;
   * `count` picks the plural and `shown` is the same number as it is written.
   */
  weekOf: (day: string, count: number, shown: string) =>
    t("Week of {day}: {count, plural, one {{shown} player} other {{shown} players}}", { day, count, shown }),
  /** The heading of the weeks' column in the chart's table. */
  weekStarts: t("Week of"),
  lifecycle: {
    fresh: tc("players", "New"),
    stayed: t("Played the week before too"),
    back: t("Back after 2 weeks or more"),
    left: t("Did not return this week"),
  },
  weeksEmpty: t("This fills in after the game’s first whole week, Monday to Sunday."),
} as const;
