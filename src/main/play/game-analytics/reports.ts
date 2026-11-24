/**
 * Every report of a game's analytics and the parser that reads it, and the envelope they all arrive
 * in: the report, the game and the period, each echoing what was asked, then the report's own data,
 * which echoes the options asked (`REPORT_OPTIONS`). An answer to another question is none, since
 * the renderer keeps it as the answer to this one.
 */
import {
  type AnalyticsGame,
  type AnalyticsWindow,
  GameReport,
  type GameReportAnswer,
  type GameReportMap,
  type GameReportQuery,
} from "../../../shared/game-analytics.ts";
import { isRecord } from "../gallery.ts";
import { toAnalyticsGame, toAnalyticsWindow } from "./game.ts";
import { toAcquisitionReport } from "./report-acquisition.ts";
import { toEngagementReport } from "./report-engagement.ts";
import { toEventsReport } from "./report-events.ts";
import { toInstallsReport } from "./report-installs.ts";
import { toOverviewReport } from "./report-overview.ts";
import { toRetentionReport } from "./report-retention.ts";
import { toRevenueReport } from "./report-revenue.ts";

/** Reads one report's data for the period it was asked over: null when it is not that report. */
export type ReportParser<Report extends GameReport> = (
  data: unknown,
  window: AnalyticsWindow,
) => GameReportMap[Report] | null;

/** Whether a report's data echoes the options `query` asked with; an option not asked lets genex.games pick. */
type Echoes<Report extends GameReport> = (data: GameReportMap[Report], query: GameReportQuery) => boolean;

/** Whether `echoed` is what was `asked`, or nothing was. */
const same = (asked: string | undefined, echoed: string): boolean => asked === undefined || asked === echoed;

/** The reports that take no option echo nothing. */
const noOptions = (): boolean => true;

/**
 * What each report echoes: Acquisition's and Retention's options are closed vocabularies, so another
 * value echoed answers another question. Events echoes nothing here: the event and the property it
 * asks for are names a game may no longer send, which genex.games answers with the detail it shows
 * by default, and the page draws a detail under its own name and split.
 */
const ECHOES = {
  [GameReport.Overview]: noOptions,
  [GameReport.Acquisition]: (data, query) =>
    same(query.breakdown, data.breakdown) &&
    same(query.attribution, data.attribution) &&
    same(query.campaignBy, data.campaignBy),
  [GameReport.Retention]: (data, query) =>
    same(query.mode, data.mode) && same(query.cohort, data.cohort) && same(query.segmentBy, data.segmentBy),
  [GameReport.Engagement]: noOptions,
  [GameReport.Events]: noOptions,
  [GameReport.Revenue]: noOptions,
  [GameReport.Installs]: noOptions,
} as const satisfies { [Report in GameReport]: Echoes<Report> };

/** One report's answer, as the contract's `GameReportAnswer` spells each of its members. */
interface AnswerOf<Report extends GameReport> {
  report: Report;
  game: AnalyticsGame;
  window: AnalyticsWindow;
  data: GameReportMap[Report];
}

/** A report's parser with the envelope around what it read, when that echoes what `query` asked. */
const answering =
  <Report extends GameReport>(report: Report, parse: ReportParser<Report>, echoes: Echoes<Report>) =>
  (data: unknown, game: AnalyticsGame, window: AnalyticsWindow, query: GameReportQuery): AnswerOf<Report> | null => {
    const read = parse(data, window);
    return read && echoes(read, query) ? { report, game, window, data: read } : null;
  };

/** Each report's parser. */
export const REPORT_PARSERS = {
  [GameReport.Overview]: toOverviewReport,
  [GameReport.Acquisition]: toAcquisitionReport,
  [GameReport.Retention]: toRetentionReport,
  [GameReport.Engagement]: toEngagementReport,
  [GameReport.Events]: toEventsReport,
  [GameReport.Revenue]: toRevenueReport,
  [GameReport.Installs]: toInstallsReport,
} as const satisfies { [Report in GameReport]: ReportParser<Report> };

const ANSWERS = {
  [GameReport.Overview]: answering(
    GameReport.Overview,
    REPORT_PARSERS[GameReport.Overview],
    ECHOES[GameReport.Overview],
  ),
  [GameReport.Acquisition]: answering(
    GameReport.Acquisition,
    REPORT_PARSERS[GameReport.Acquisition],
    ECHOES[GameReport.Acquisition],
  ),
  [GameReport.Retention]: answering(
    GameReport.Retention,
    REPORT_PARSERS[GameReport.Retention],
    ECHOES[GameReport.Retention],
  ),
  [GameReport.Engagement]: answering(
    GameReport.Engagement,
    REPORT_PARSERS[GameReport.Engagement],
    ECHOES[GameReport.Engagement],
  ),
  [GameReport.Events]: answering(GameReport.Events, REPORT_PARSERS[GameReport.Events], ECHOES[GameReport.Events]),
  [GameReport.Revenue]: answering(GameReport.Revenue, REPORT_PARSERS[GameReport.Revenue], ECHOES[GameReport.Revenue]),
  [GameReport.Installs]: answering(
    GameReport.Installs,
    REPORT_PARSERS[GameReport.Installs],
    ECHOES[GameReport.Installs],
  ),
} as const;

/**
 * A report's answer to `query`, or null when `body` is not one: another report, game, period or
 * option echoed, a part missing, or data its parser cannot read. `local` (fixture launches only)
 * lets a drawn cover through.
 */
export function toReportAnswer(body: unknown, query: GameReportQuery, local = false): GameReportAnswer | null {
  if (!isRecord(body) || body.report !== query.report) return null;
  const game = toAnalyticsGame(body.game, query.slug, local);
  const window = toAnalyticsWindow(body.window, query.days);
  return game && window ? ANSWERS[query.report](body.data, game, window, query) : null;
}
