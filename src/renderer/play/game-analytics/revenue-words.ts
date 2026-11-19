/**
 * The words of the Revenue report: its tiles and their notes, each block's title, the tables'
 * headings and total rows, what a block says when it has nothing to show, and the name of each
 * channel a player can first come from.
 */
import { t, tc } from "../../../shared/i18n.ts";
import { REPORT_WORDS } from "./report-words.ts";

/** The Revenue report's own copy. */
export const REVENUE_WORDS = {
  tiles: {
    nexSpent: t("Nex spent"),
    inPurchases: (count: number) => t("in {count, plural, one {# purchase} other {# purchases}}", { count }),
    payers: t("Paying players"),
    /** `share` is the percentage of the period's players who paid, already written. */
    ofEveryone: (share: string) => t("{share} of everyone who played", { share }),
    nexPerPayer: t("Nex per paying player"),
    /** `count` is an average with one decimal, already written: "2.0". */
    purchasesEach: (count: string) => t("{count} purchases each", { count }),
    nexPerPlayerDay: t("Nex per player a day"),
    everyoneThatDay: t("across everyone who played that day"),
  },
  /** In place of the charts and tables when nothing was bought in the period. */
  nothingBought: (days: number) =>
    t(
      "Nobody bought anything in these {days} days. Nex spent in this game’s Store or through the SDK’s purchases shows up here.",
      { days },
    ),
  daily: {
    title: t("Nex spent per day"),
    series: t("Nex spent"),
  },
  items: {
    title: t("What players buy"),
    table: t("Items sold"),
    item: t("Item"),
    price: t("Price"),
    sold: t("Sold"),
    buyers: t("Buyers"),
    nex: t("Nex"),
    share: t("Share of Nex"),
    total: t("All items"),
    empty: t("No items to show yet."),
  },
  spend: {
    title: t("What a new player spends over time"),
    /** What the curve draws, for its table and for assistive technology. */
    chart: t("Nex a new player has spent by each day since their first play"),
    series: t("Nex per new player"),
    place: REPORT_WORDS.daysSince,
    byDay: (day: number) => t("By day {day}", { day }),
    firstPurchase: t("First purchase"),
    firstDay: t("First day"),
    day: REPORT_WORDS.day,
    empty: (days: number) => t("No new players in these {days} days, so there’s nothing to follow yet.", { days }),
  },
  sources: {
    title: t("Which sources bring players who pay"),
    hint: t("By the first source that brought each player"),
    table: t("Spending by first source"),
    source: tc("traffic", "Source"),
    players: t("Players"),
    paying: t("Paying"),
    share: t("Share paying"),
    nex: t("Nex"),
    nexEach: t("Nex per player"),
    total: t("All players"),
    empty: t("No sources to show yet."),
    footnote: t(
      "Counts Nex spent in this game through its Store and the SDK’s purchases. Refunded purchases are taken out.",
    ),
  },
  channels: REPORT_WORDS.channels,
} as const;
