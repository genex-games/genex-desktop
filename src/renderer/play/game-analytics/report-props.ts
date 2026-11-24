/**
 * The props of the nine components a game's analytics page draws in its body: one per report
 * (`OverviewReport` … `InstallsReport`), `LinksPage` and `SdkPage`. The page's shell
 * (`GameAnalyticsPage.tsx`, `AnalyticsFace.tsx`) owns everything around them and hands them only
 * finished data, so a component here never reads a store, never calls `window.studio` and never
 * draws a loading, failed, signed-out or "not served yet" state: it is mounted only once there is
 * an answer to draw.
 *
 * What the shell already draws, so a component must not repeat it: the header (cover, title, link
 * with Copy, playing now, the line saying only the creator sees this, the period's days, what
 * changes are against and how long ago the numbers were computed), the tabs, the period switch,
 * the line that says a refresh failed (with Try again), and every state without data.
 *
 * What every component may count on:
 * - Its data is a complete answer that main already validated against `shared/game-analytics.ts`.
 *   A rate that is `null` cannot be known yet: draw it empty, never as zero.
 * - Its root element carries its own data attribute (`data-game-analytics-report="<report>"`,
 *   `data-game-analytics-links`, `data-game-analytics-sdk`) and every control inside gets a stable
 *   `data-game-analytics-*` attribute of its own.
 * - It sits in a column up to 1200px wide inside the tab's panel (`role="tabpanel"`); the shell
 *   sets `aria-busy` on the panel and dims what it holds while `refreshing`. A root that wears the
 *   class `game-analytics-report` is a column with the page's gap (`game-analytics-page.css`).
 * - A title, a campaign's name, a referrer, an event's name or any other text a person wrote is
 *   wrapped in `data-analytics-mask` when it sits inside a control, so usage replays hide it.
 */
import type {
  AnalyticsGame,
  CampaignLink,
  CampaignTags,
  EventFunnel,
  EventFunnelDraft,
  EventOrigin,
  EventsStatus,
  GameReport,
  GameReportAnswer,
  GameReportOptions,
} from "../../../shared/game-analytics.ts";
import { AnalyticsSaveRefusal } from "../../../shared/game-analytics-asks.ts";
import { errorCodeIn } from "../../../shared/errors.ts";
import type { StatsPeriod } from "../../../shared/play-stats.ts";
import type { AnalyticsTab } from "./tabs.ts";

/**
 * Whether a refused save of a campaign link or a funnel was refused because the game keeps no more
 * of them: then trying again cannot work, and the form says to remove one first.
 */
export const savedPastLimit = (error: unknown): boolean =>
  errorCodeIn(AnalyticsSaveRefusal, error) === AnalyticsSaveRefusal.Limit;

/** One report's answer as genex.games gave it: `report`, `game`, `window` (the period) and `data`. */
export type ReportAnswer<Report extends GameReport> = Extract<GameReportAnswer, { report: Report }>;

/** What all nine components are given. */
export interface TabProps {
  /** The game's link on genex.games, as every call about it names it. */
  slug: string;
  /**
   * A newer answer is on its way: the period or an option changed, or the page is reading again.
   * What the component holds is the answer before it, so keep drawing it; the shell dims the panel.
   * The SDK tab's re-read every few seconds is silent: there it is true only while the other
   * origin's status is on its way.
   */
  refreshing: boolean;
  /**
   * Reading again failed and what the component holds is the last answer that loaded. The shell
   * says so above the panel with Try again; nothing more is needed here.
   */
  stale: boolean;
  /**
   * The wall clock, for words like "12 sec. ago" (`formatAgo` in the kit): the shell reads it again
   * every half minute on a report and on Campaign links, every few seconds on SDK. A component
   * never asks `Date.now()` itself.
   */
  now: number;
  /** Open another tab of the page, for example Campaign links from a campaigns table. */
  onOpenTab(tab: AnalyticsTab): void;
}

/**
 * What a report's component is given.
 *
 * `answer.data` is the report (`OverviewReport`, `AcquisitionReport`, … in the contract),
 * `answer.window` the period it covers (`days`, `endsOn`, `computedAt`) and `answer.game` the game.
 *
 * `options` are the options the report is asked with now, and `onOptions` changes them: the shell
 * merges the change into `options` and reads the report again. Until the new answer lands the
 * component keeps the old `answer` with `refreshing` true, so draw a switcher's selected value
 * from `options` (it follows the press at once) and the numbers from `answer`. An option nobody
 * chose yet is absent from `options`: genex.games then picks its default, and the answer says
 * which (`answer.data.breakdown`, `.attribution`, `.campaignBy`, `.mode`, `.cohort`, `.segmentBy`,
 * `.detail?.name`, `.detail?.splitBy`), so read a switcher's value as `options.mode ?? answer.data.mode`.
 * Only the options a report takes change what is read (`REPORT_OPTIONS` in
 * `shared/game-analytics-asks.ts`); the period is the shell's and is not an option.
 */
export interface ReportProps<Report extends GameReport> extends TabProps {
  answer: ReportAnswer<Report>;
  options: GameReportOptions;
  /** Change options; a key set to `undefined` goes back to genex.games' default. */
  onOptions(change: GameReportOptions): void;
}

/** The Events report's props: a report's, and the saving and removing of the game's funnels. */
export interface EventsReportProps extends ReportProps<typeof GameReport.Events> {
  /**
   * Save a funnel. Resolves with it once genex.games kept it and the report was read again, so
   * `answer.data.funnels` already lists it; rejects with genex.games' refusal (say so beside the form;
   * `savedPastLimit` tells a game that keeps no more funnels apart).
   */
  onSaveFunnel(draft: EventFunnelDraft): Promise<EventFunnel>;
  /** Remove a funnel; resolves once the report was read again without it, rejects when it could not be removed. */
  onRemoveFunnel(id: string): Promise<void>;
}

/** What the Campaign links page is given. */
export interface LinksPageProps extends TabProps {
  /** The game as the latest answer described it; null when no report has been read for it yet. */
  game: AnalyticsGame | null;
  /** The game's page on genex.games: the address a link's tags go on (`campaignUrl(gameUrl, tags)`). */
  gameUrl: string;
  /** The period each link's numbers (`newVisitors`, `newPlayers`, `day7`) are counted over. */
  days: StatsPeriod;
  /** The links the creator saved, as genex.games listed them; a link just saved comes first. */
  links: CampaignLink[];
  /**
   * Save a link with these tags. Resolves with the saved link, which `links` then shows first;
   * rejects with genex.games' refusal, the list as it was (`savedPastLimit` tells a full list apart).
   */
  onSave(tags: CampaignTags): Promise<CampaignLink>;
  /** Remove a link; resolves once genex.games removed it and `links` no longer has it, rejects when it could not. */
  onRemove(id: string): Promise<void>;
}

/** What the SDK page is given. */
export interface SdkPageProps extends TabProps {
  /** The game as the status describes it: its `sdkVersion` and whether it can send events (`eventsReady`). */
  game: AnalyticsGame;
  /** The game's events as they arrive: read again every few seconds while the tab is shown. */
  status: EventsStatus;
  /**
   * Whose events are asked for now: the published game's, or Studio's preview. It follows the
   * switch at once; `status.origin` says whose events `status` holds until the new answer lands.
   */
  origin: EventOrigin;
  /** Turn the origin switch: the shell reads the other origin's status and keeps reading it. */
  onOrigin(origin: EventOrigin): void;
}
