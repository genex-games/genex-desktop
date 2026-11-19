/**
 * The tabs of a game's analytics page: its seven reports, then Campaign links and SDK, which the
 * page sets apart at the row's end. A closed vocabulary: Play's view carries one
 * (`PlayView` in `state/play.ts`) and the usage-analytics screen names it, never the game.
 */
import { GameReport, isGameReport } from "../../../shared/game-analytics.ts";

/** A tab of a game's analytics page: a report by its wire name, or one of the page's two tools. */
export const AnalyticsTab = {
  ...GameReport,
  /** The campaign links the creator saved, and the form that makes one. */
  Links: "links",
  /** How the game's own events arrive: the SDK's page. */
  Sdk: "sdk",
} as const;
export type AnalyticsTab = (typeof AnalyticsTab)[keyof typeof AnalyticsTab];

const TABS: ReadonlySet<unknown> = new Set(Object.values(AnalyticsTab));

/** Whether a value is one of the tabs. */
export const isAnalyticsTab = (value: unknown): value is AnalyticsTab => TABS.has(value);

/** The tab the page opens on when none is named. */
export const DEFAULT_ANALYTICS_TAB: AnalyticsTab = AnalyticsTab.Overview;

/** The tabs set apart at the row's end: tools, not reports. */
export const SIDE_TABS: readonly AnalyticsTab[] = [AnalyticsTab.Links, AnalyticsTab.Sdk];

/** Whether a tab is one of the two set apart. */
export const isSideTab = (tab: AnalyticsTab): boolean => SIDE_TABS.includes(tab);

/** The report a tab draws; null for Campaign links and SDK, which read their own data. */
export const reportOf = (tab: AnalyticsTab): GameReport | null => (isGameReport(tab) ? tab : null);

/**
 * The tabs the page lists, in order. Installs is there only for a game with an app build, or while
 * it is the tab shown (a page opened straight on it must show where it is).
 */
export function listedTabs(hasAppBuild: boolean, shown: AnalyticsTab): AnalyticsTab[] {
  const installs = hasAppBuild || shown === AnalyticsTab.Installs;
  return Object.values(AnalyticsTab).filter((tab) => installs || tab !== AnalyticsTab.Installs);
}
