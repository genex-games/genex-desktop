/**
 * The account's own game stats for the last 7 days on its profile: one slim strip of numbers, no
 * chart. Plays and players with how they moved, who is playing now, and More, which opens the stats
 * page. With no games yet it invites the first; in a quiet week it shows honest zeros and a link to
 * share.
 */
import type { JSX } from "react";
import { useEffect } from "react";
import { type PlayGame, playPageUrl } from "../../shared/play.ts";
import { type Change, ChangeKind, DEFAULT_STATS_PERIOD } from "../../shared/play-stats.ts";
import { usePeople, usePlayWeb } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { Icon } from "../ui/icons.tsx";
import { useCopy } from "../use-copy.ts";
import { PLAY_WORDS } from "../words.ts";
import { formatStat } from "./play-model.ts";
import { StripKind, type StripView, stripView } from "./stats-view.ts";

const WORDS = PLAY_WORDS.stats;

/** A change against the period before: ▲ +12% in green, ▼ −8% in red, New, or a dash. */
export function ChangeMark({ change }: { change: Change }): JSX.Element {
  if (change.kind === ChangeKind.New)
    return (
      <span className="stats-change" data-change="up" title={WORDS.newLabel}>
        {WORDS.newChange}
      </span>
    );
  if (change.kind === ChangeKind.None)
    return (
      <span className="stats-change" data-change="flat">
        {WORDS.noChange}
      </span>
    );
  const up = change.kind !== ChangeKind.Down;
  return (
    <span
      className="stats-change"
      data-change={change.kind}
      aria-label={up ? WORDS.upLabel(change.percent) : WORDS.downLabel(change.percent)}
    >
      <Icon name={up ? "caret-up" : "caret-down"} size={12} />
      {up ? WORDS.up(change.percent) : WORDS.down(change.percent)}
    </span>
  );
}

/** One number on the strip with its noun, and its change when there is one. */
function StripValue({ value, noun, change }: { value: number; noun: string; change?: Change | null }) {
  return (
    <span className="stats-strip-value">
      <span className="stats-strip-number">{formatStat(value)}</span>
      <span className="stats-strip-noun">{noun}</span>
      {change && <ChangeMark change={change} />}
    </span>
  );
}

/** Who is playing right now, with the green dot (grey with nobody). */
function PlayingNow({ count }: { count: number }): JSX.Element {
  return (
    <span className="stats-strip-value stats-strip-live">
      <span className="stats-live-dot" data-off={count === 0 || undefined} aria-hidden="true" />
      <span className="stats-strip-number">{formatStat(count)}</span>
      <span className="stats-strip-noun">{WORDS.playingNow}</span>
    </span>
  );
}

/** Copy a game's genex.games link, for a quiet week. */
function CopyGameLink({ game }: { game: PlayGame }): JSX.Element {
  const [copied, copy] = useCopy();
  const web = usePlayWeb();
  return (
    <button
      type="button"
      className="people-button stats-strip-action"
      data-tone="tint"
      data-stats-copy-link
      onClick={() => copy(playPageUrl(web, game.slug))}
    >
      <Icon name={copied ? "check" : "link"} size={14} />
      {copied ? WORDS.linkCopied : WORDS.copyLink(game.title)}
    </button>
  );
}

/** The strip's content for its view. */
function StripBody({ view, onNewGame, onMore }: { view: StripView; onNewGame: () => void; onMore: () => void }) {
  const separator = <span className="stats-strip-separator" aria-hidden="true" />;
  switch (view.kind) {
    case StripKind.NoGames:
      return (
        <>
          <span className="stats-strip-line">{WORDS.startFirst}</span>
          <button type="button" className="people-button stats-strip-action" data-tone="primary" onClick={onNewGame}>
            {WORDS.createGame}
          </button>
        </>
      );
    case StripKind.Totals:
      return (
        <>
          <StripValue value={view.plays} noun={WORDS.plays(view.plays)} />
          {separator}
          <PlayingNow count={view.playingNow} />
        </>
      );
    case StripKind.Quiet:
      return (
        <>
          <StripValue value={0} noun={WORDS.plays(0)} change={{ kind: ChangeKind.None, percent: 0 }} />
          {separator}
          <StripValue value={0} noun={WORDS.players(0)} />
          {separator}
          <PlayingNow count={view.playingNow} />
          {view.share && <CopyGameLink game={view.share} />}
        </>
      );
    case StripKind.Numbers:
      return (
        <>
          <StripValue value={view.plays} noun={WORDS.plays(view.plays)} change={view.playsChange} />
          {separator}
          <StripValue value={view.players} noun={WORDS.players(view.players)} change={view.playersChange} />
          {separator}
          <PlayingNow count={view.playingNow} />
          <button
            type="button"
            className="people-button stats-strip-action"
            data-tone="tint"
            data-stats-more
            onClick={onMore}
          >
            {WORDS.more}
            <Icon name="chevron-right" size={14} />
          </button>
        </>
      );
    case StripKind.Failed:
      return <span className="stats-strip-line">{WORDS.failed}</span>;
    default:
      return <span className="stats-strip-line stats-strip-waiting" aria-busy="true" />;
  }
}

/** The account's last 7 days on its profile. */
export function StatsStrip({ games, onNewGame }: { games: readonly PlayGame[]; onNewGame: () => void }): JSX.Element {
  const entry = usePeople((s) => s.stats[DEFAULT_STATS_PERIOD]);
  const view = stripView(entry, games);
  useEffect(() => {
    if (games.length > 0) void studio().people.loadStats(DEFAULT_STATS_PERIOD, { force: true });
  }, [games.length]);
  const label = view.kind === StripKind.Totals ? WORDS.inTotal : WORDS.lastDays(DEFAULT_STATS_PERIOD);
  return (
    <section className="stats-strip-section" aria-label={WORDS.sectionLabel} data-stats-strip={view.kind}>
      <span className="stats-strip-label">{label}</span>
      <div className="stats-strip">
        <StripBody view={view} onNewGame={onNewGame} onMore={() => studio().play.showStats()} />
      </div>
    </section>
  );
}
