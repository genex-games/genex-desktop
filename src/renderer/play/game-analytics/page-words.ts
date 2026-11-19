/**
 * The words of a game's analytics page's shell: its tabs, the line of facts under the title, what
 * each state says, and where Back goes. The reports, Campaign links and SDK keep their own words
 * beside their components. The page is called "stats" to the person, as the page it opens from is.
 */
import { GameReport } from "../../../shared/game-analytics.ts";
import { t } from "../../../shared/i18n.ts";
import { PlayShelf } from "../../../shared/play.ts";
import { PlayPage, type PlayView } from "../../state/play.ts";
import { PLAY_WORDS } from "../../words.ts";
import { AnalyticsTab } from "./tabs.ts";

/** The shell's own words. */
export const PAGE_WORDS = {
  /** The page's name while the game's title is not known. */
  title: t("Game stats"),
  /** Copy's label while the game's title is not known. */
  copyLink: t("Copy the game link"),
  tabsLabel: t("Stats sections"),
  tabs: {
    [AnalyticsTab.Overview]: t("Overview"),
    [AnalyticsTab.Acquisition]: t("Acquisition"),
    [AnalyticsTab.Retention]: t("Retention"),
    [AnalyticsTab.Engagement]: t("Engagement"),
    [AnalyticsTab.Events]: t("Events"),
    [AnalyticsTab.Revenue]: t("Revenue"),
    [AnalyticsTab.Installs]: t("Installs"),
    [AnalyticsTab.Links]: t("Campaign links"),
    [AnalyticsTab.Sdk]: t("SDK"),
  } satisfies Record<AnalyticsTab, string>,
  /** The facts under the title, each its own short line. */
  onlyYou: t("Only you can see this"),
  span: (from: string, to: string) => t("{from} – {to}, days in UTC", { from, to }),
  against: (days: number) => t("changes are against the {days} days before", { days }),
  updated: (ago: string) => t("updated {ago}", { ago }),
  linksSpan: (from: string, to: string) => t("numbers are for {from} – {to}", { from, to }),
  sdkVersion: (version: string) => t("the published game loads Genex SDK {version}", { version }),
  lastEvent: (ago: string) => t("last event {ago}", { ago }),
  noEvents: t("no events yet"),
  /** While the SDK tab shows Studio preview's events, the last one is said to be theirs. */
  lastPreviewEvent: (ago: string) => t("last event in Studio preview {ago}", { ago }),
  noPreviewEvents: t("no events in Studio preview yet"),
  /** What the skeleton is, read aloud. */
  loading: t("Loading stats"),
  unavailable: t("genex.games doesn’t have these stats yet. They arrive with its next update."),
  noGame: t("This game isn’t on genex.games, or it isn’t yours."),
  /** Why a game has no such report: Installs needs an app build, Revenue a Store. */
  noReport: {
    [GameReport.Installs]: t("Installs shows up once this game has an app build."),
    [GameReport.Revenue]: t("Revenue shows up once this game has a Store."),
    other: t("This game doesn’t have this report."),
  },
  openOverview: t("Open Overview"),
  failed: t("Couldn’t load these stats."),
  offline: t("These stats load as soon as you’re back online."),
  /** Over the last numbers read, when reading them again failed. */
  stale: t("Couldn’t refresh. These are the last stats that loaded."),
} as const;

/** What Back says for each page it can return to. */
const BACK_LABELS: Record<PlayPage, string> = {
  [PlayPage.Shelf]: PLAY_WORDS.shelves[PlayShelf.Games],
  [PlayPage.Friends]: PLAY_WORDS.people.friends,
  [PlayPage.Profile]: PLAY_WORDS.stats.backToProfile,
  [PlayPage.Stats]: PLAY_WORDS.stats.title,
  [PlayPage.Game]: PLAY_WORDS.people.back,
  [PlayPage.GameAnalytics]: PLAY_WORDS.people.back,
};

/** What Back says on a Play page: the page it returns to, or plain Back for a game's own pages. */
export const backLabel = (back: PlayView | null): string => (back ? BACK_LABELS[back.page] : PLAY_WORDS.people.back);

/** Why the game has no report on `tab`, in that report's own words. */
export function noReportWords(tab: AnalyticsTab): string {
  if (tab === AnalyticsTab.Installs) return PAGE_WORDS.noReport[GameReport.Installs];
  if (tab === AnalyticsTab.Revenue) return PAGE_WORDS.noReport[GameReport.Revenue];
  return PAGE_WORDS.noReport.other;
}
