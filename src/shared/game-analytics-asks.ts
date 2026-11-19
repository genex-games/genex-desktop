/**
 * What Studio asks a game's analytics with, where the contract (`game-analytics.ts`) leaves it
 * open: which of the options each report takes, and how long the words a creator types may be.
 * The renderer keys its reads and holds its forms by these, and main refuses a question that
 * breaks them (`main/play/game-analytics/asked.ts`, `routes.ts`), so the two cannot drift.
 */
import { EVENT_LIMITS, GameReport, type GameReportOptions } from "./game-analytics.ts";

/**
 * Why genex.games refused a save, as the code the failure carries across IPC (`error-codes.ts`):
 * the game already keeps `CAMPAIGN_LINKS_MAX` links or `FUNNELS_MAX` funnels, so trying again
 * cannot work until one is removed.
 */
export const AnalyticsSaveRefusal = { Limit: "analytics_save_limit" } as const;
export type AnalyticsSaveRefusal = (typeof AnalyticsSaveRefusal)[keyof typeof AnalyticsSaveRefusal];

/**
 * The options each report takes. Any other changes nothing about its answer: the renderer leaves
 * it out of the question (and of the read's key), main out of the route.
 */
export const REPORT_OPTIONS = {
  [GameReport.Overview]: [],
  [GameReport.Acquisition]: ["breakdown", "attribution", "campaignBy"],
  [GameReport.Retention]: ["mode", "cohort", "segmentBy"],
  [GameReport.Engagement]: [],
  [GameReport.Events]: ["event", "splitBy"],
  [GameReport.Revenue]: [],
  [GameReport.Installs]: [],
} as const satisfies Record<GameReport, readonly (keyof GameReportOptions)[]>;

/** The longest a funnel's name may be. */
export const FUNNEL_NAME_MAX = 80;
/** The longest an event property's name may be (`splitBy`, a funnel step's `property`): an event name's length. */
export const PROPERTY_NAME_MAX = EVENT_LIMITS.nameLength;
