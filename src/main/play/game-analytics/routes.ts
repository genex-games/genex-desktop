/**
 * The routes of a game's analytics on genex.games, as the contract's header lists them
 * (`shared/game-analytics.ts`). Main builds every one from values it has checked: the renderer
 * names a game by its slug and a report by its name, never a path or a piece of one.
 */
import type { EventOrigin, GameReport, GameReportQuery } from "../../../shared/game-analytics.ts";
import { REPORT_OPTIONS } from "../../../shared/game-analytics-asks.ts";
import type { StatsPeriod } from "../../../shared/play-stats.ts";

const segment = encodeURIComponent;
/** What comes before a game's slug in every analytics route, and the folder after it. */
const GAMES = "/api/projects/";
const FOLDER = "/analytics/";
const root = (slug: string): string => `${GAMES}${segment(slug)}${FOLDER}`;

/** The routes a game's analytics use. */
export const AnalyticsRoute = {
  report: (slug: string, report: GameReport) => `${root(slug)}reports/${segment(report)}`,
  eventsStatus: (slug: string) => `${root(slug)}events/status`,
  links: (slug: string) => `${root(slug)}links`,
  link: (slug: string, id: string) => `${root(slug)}links/${segment(id)}`,
  funnels: (slug: string) => `${root(slug)}funnels`,
  funnel: (slug: string, id: string) => `${root(slug)}funnels/${segment(id)}`,
} as const;

/** A report's route with its period and the options that report takes (`REPORT_OPTIONS`). */
export function reportRoute(query: GameReportQuery): string {
  const params = new URLSearchParams({ days: String(query.days) });
  for (const name of REPORT_OPTIONS[query.report]) {
    const value = query[name];
    if (value !== undefined) params.set(name, value);
  }
  return `${AnalyticsRoute.report(query.slug, query.report)}?${params}`;
}

/** The route of a game's events as they arrive from `origin`. */
export const eventsStatusRoute = (slug: string, origin: EventOrigin): string =>
  `${AnalyticsRoute.eventsStatus(slug)}?${new URLSearchParams({ origin })}`;

/** The route of a game's saved campaign links, with what each brought over `days`. */
export const linksRoute = (slug: string, days: StatsPeriod): string =>
  `${AnalyticsRoute.links(slug)}?${new URLSearchParams({ days: String(days) })}`;

/**
 * The game an analytics path names and what follows its folder (`reports/overview`, `links/<id>`),
 * or null for any other path: how a stand-in for genex.games tells these routes from the rest.
 */
export function analyticsPathOf(pathname: string): { slug: string; rest: string } | null {
  if (!pathname.startsWith(GAMES)) return null;
  const folder = pathname.indexOf(FOLDER, GAMES.length);
  if (folder <= GAMES.length) return null;
  const slug = pathname.slice(GAMES.length, folder);
  if (slug.includes("/")) return null;
  try {
    return { slug: decodeURIComponent(slug), rest: pathname.slice(folder + FOLDER.length) };
  } catch {
    return null;
  }
}
