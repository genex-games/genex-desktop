/**
 * The account's stats page, opened from More on its profile and read only once it opens: a period
 * (7 days first, 30, 90), four tiles (plays and players with their change and a sparkline, who is
 * playing now, games made), plays per day as a chart that follows the pointer, and every game's
 * numbers in a table. Every number comes from the same per-game series, so they always agree.
 */
import type { JSX, KeyboardEvent } from "react";
import { useEffect, useState } from "react";
import { intlLocale, t } from "../../shared/i18n.ts";
import {
  DEFAULT_STATS_PERIOD,
  dailyTotals,
  gameRows,
  type PlayStats as Stats,
  periodDays,
  STATS_PERIODS,
  type StatsPeriod,
  statsTotals,
} from "../../shared/play-stats.ts";
import { richText } from "../rich-text.tsx";
import { usePeople } from "../state/hooks.ts";
import { LoadStatus } from "../state/people.ts";
import { studio } from "../state/studio.ts";
import { Button } from "../ui/Button.tsx";
import { PLAY_WORDS } from "../words.ts";
import { PlayPageFrame } from "./PlayPageFrame.tsx";
import { SignInNote } from "./SignInNote.tsx";
import { formatCount, formatStat } from "./play-model.ts";
import { AreaChart, Sparkline } from "./StatsCharts.tsx";
import { ChangeMark } from "./StatsStrip.tsx";

const WORDS = PLAY_WORDS.stats;
/** Dates under the chart and in its tooltip: "Oct 13". */
const DAY_FORMAT = new Intl.DateTimeFormat(intlLocale(), { month: "short", day: "numeric", timeZone: "UTC" });
const dayLabel = (iso: string): string => DAY_FORMAT.format(new Date(`${iso}T00:00:00.000Z`));

/** The period switch: a small segmented row; arrow keys move along it. */
function PeriodSwitch({ period, onChange }: { period: StatsPeriod; onChange: (period: StatsPeriod) => void }) {
  const keys = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const moves: Record<string, number> = { ArrowLeft: index - 1, ArrowRight: index + 1 };
    const next = STATS_PERIODS[moves[event.key] ?? -1];
    if (next === undefined) return;
    event.preventDefault();
    onChange(next);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-stats-period="${next}"]`)?.focus();
  };
  return (
    <div className="stats-periods" role="tablist" aria-label={WORDS.periodLabel}>
      {STATS_PERIODS.map((days, index) => (
        <button
          key={days}
          type="button"
          role="tab"
          aria-selected={days === period}
          tabIndex={days === period ? 0 : -1}
          data-stats-period={days}
          className="stats-period"
          onClick={() => onChange(days)}
          onKeyDown={(event) => keys(event, index)}
        >
          {WORDS.period(days)}
        </button>
      ))}
    </div>
  );
}

/** The four tiles over the chart. */
function Tiles({ stats }: { stats: Stats }): JSX.Element {
  const totals = statsTotals(stats);
  const live = totals.liveGame ? WORDS.liveIn(totals.liveGame, totals.liveOthers) : WORDS.nobodyNow;
  return (
    <div className="stats-tiles">
      <div className="stats-tile" data-stats-tile="plays">
        <span className="stats-tile-label">{WORDS.playsTile}</span>
        <span className="stats-tile-value">{formatStat(totals.plays)}</span>
        <span className="stats-tile-change">
          <ChangeMark change={totals.playsChange} />
          <span className="stats-tile-note">{WORDS.vsPrevious(stats.days)}</span>
        </span>
        <Sparkline data={dailyTotals(stats, "plays")} height={36} />
      </div>
      <div className="stats-tile" data-stats-tile="players">
        <span className="stats-tile-label">{WORDS.playersTile}</span>
        <span className="stats-tile-value">{formatStat(totals.players)}</span>
        <span className="stats-tile-change">
          <ChangeMark change={totals.playersChange} />
          <span className="stats-tile-note">{WORDS.vsPrevious(stats.days)}</span>
        </span>
        <Sparkline data={dailyTotals(stats, "players")} height={36} />
      </div>
      <div className="stats-tile" data-stats-tile="playing-now">
        <span className="stats-tile-label">{WORDS.playingNowTile}</span>
        <span className="stats-tile-value stats-tile-live">
          {formatStat(totals.playingNow)}
          <span className="stats-live-dot" data-off={totals.playingNow === 0 || undefined} aria-hidden="true" />
        </span>
        <span className="stats-tile-note">{live}</span>
      </div>
      <div className="stats-tile" data-stats-tile="games">
        <span className="stats-tile-label">{WORDS.gamesTile}</span>
        <span className="stats-tile-value">{formatStat(stats.published)}</span>
        {stats.publishedThisMonth > 0 && (
          <span className="stats-tile-note">
            {richText(t("<added>+{count}</added> this month", { count: stats.publishedThisMonth }), {
              added: (words) => (
                <span className="stats-change" data-change="up">
                  {words}
                </span>
              ),
            })}
          </span>
        )}
      </div>
    </div>
  );
}

/** Every game's numbers, most played first. */
function GamesTable({ stats }: { stats: Stats }): JSX.Element {
  return (
    <div role="table" aria-label={WORDS.tableLabel} className="stats-table" data-stats-table>
      <div role="row" className="stats-row stats-row-head">
        <span role="columnheader">{WORDS.gameColumn}</span>
        <span role="columnheader" className="stats-cell-number">
          {WORDS.playsColumn}
        </span>
        <span role="columnheader" className="stats-cell-number">
          {WORDS.playersColumn}
        </span>
        <span role="columnheader">{WORDS.dayByDayColumn}</span>
        <span role="columnheader" className="stats-cell-number">
          {WORDS.changeColumn}
        </span>
      </div>
      {gameRows(stats).map(({ game, plays, change }) => (
        <div role="row" key={game.slug} className="stats-row" data-stats-game={game.slug}>
          <span role="cell" className="stats-cell-game">
            <span className="stats-thumb">
              {game.coverUrl && <img src={game.coverUrl} alt="" draggable={false} loading="lazy" />}
            </span>
            <span className="stats-game-title">{game.title}</span>
          </span>
          <span role="cell" className="stats-cell-number">
            {formatStat(plays)}
          </span>
          <span role="cell" className="stats-cell-number stats-cell-quiet">
            {formatStat(game.playersTotal)}
          </span>
          <span role="cell">
            <Sparkline data={game.plays} width={170} height={30} />
          </span>
          <span role="cell" className="stats-cell-number">
            <ChangeMark change={change} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** The period's page body. */
function StatsBody({ stats }: { stats: Stats }): JSX.Element {
  const labels = periodDays(stats).map(dayLabel);
  return (
    <>
      <Tiles stats={stats} />
      <section className="stats-chart" aria-label={WORDS.chartTitle}>
        <h2 className="stats-chart-title">{WORDS.chartTitle}</h2>
        <AreaChart
          data={dailyTotals(stats, "plays")}
          labels={labels}
          label={WORDS.chartLabel(stats.days)}
          valueLine={(count) => WORDS.tooltip(count.toLocaleString(intlLocale()))}
          axisValue={(count) => formatCount(count)}
        />
      </section>
      {stats.games.length > 0 && <GamesTable stats={stats} />}
    </>
  );
}

/** The account's stats page. */
export function PlayStats({
  sidebarHidden,
  onToggleSidebar,
  onNewGame,
}: {
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
  onNewGame: () => void;
}): JSX.Element {
  const [period, setPeriod] = useState<StatsPeriod>(DEFAULT_STATS_PERIOD);
  const entry = usePeople((s) => s.stats[period]);
  const signedIn = usePeople((s) => s.me !== null);
  useEffect(() => {
    if (signedIn) void studio().people.loadStats(period);
  }, [period, signedIn]);
  const stats = entry?.stats ?? null;
  const noGames = stats !== null && stats.published === 0 && stats.games.length === 0;
  return (
    <PlayPageFrame
      label={WORDS.title}
      sidebarHidden={sidebarHidden}
      onToggleSidebar={onToggleSidebar}
      onBack={() => studio().play.back()}
      backLabel={WORDS.backToProfile}
    >
      <div className="stats-page" data-stats-page={period}>
        <div className="stats-head">
          <h1 className="stats-title">{WORDS.title}</h1>
          <span className="stats-only-you">{WORDS.onlyYou}</span>
          <PeriodSwitch period={period} onChange={setPeriod} />
        </div>
        {!signedIn && <SignInNote text={WORDS.signedOut} />}
        {entry?.unavailable && <p className="people-note">{WORDS.unavailable}</p>}
        {entry?.status === LoadStatus.Failed && !stats && (
          <div className="people-note">
            {WORDS.failed}
            <Button variant="secondary" onClick={() => void studio().people.loadStats(period, { force: true })}>
              {PLAY_WORDS.retry}
            </Button>
          </div>
        )}
        {noGames && (
          <div className="stats-strip">
            <span className="stats-strip-line">{WORDS.startFirst}</span>
            <button type="button" className="people-button stats-strip-action" data-tone="primary" onClick={onNewGame}>
              {WORDS.createGame}
            </button>
          </div>
        )}
        {stats && !noGames && <StatsBody stats={stats} />}
        {signedIn && !stats && !entry?.unavailable && entry?.status !== LoadStatus.Failed && <StatsPlaceholder />}
      </div>
    </PlayPageFrame>
  );
}

/** The tiles and the chart on their way. */
function StatsPlaceholder(): JSX.Element {
  return (
    <div className="stats-placeholder" aria-busy="true">
      <div className="stats-tiles">
        {[0, 1, 2, 3].map((tile) => (
          <span key={tile} className="stats-tile stats-tile-placeholder" />
        ))}
      </div>
      <span className="stats-chart stats-chart-placeholder" />
    </div>
  );
}
