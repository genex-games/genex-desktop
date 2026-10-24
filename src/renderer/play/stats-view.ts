/**
 * What the profile's game stats strip shows, decided from the stats read and the account's games:
 * the first-game invitation with no games, a dash and honest zeros in a quiet week (and a link to
 * share), "New" for a game with nothing before it, the numbers with their change and More otherwise,
 * and the plays in total while genex.games has no daily stats to give.
 */
import type { PlayGame } from "../../shared/play.ts";
import { type Change, ChangeKind, statsTotals } from "../../shared/play-stats.ts";
import { LoadStatus, type StatsEntry } from "../state/people.ts";

/** Which strip shows. */
export const StripKind = {
  /** Nothing read yet. */
  Loading: "loading",
  /** No published games: one line and Create a game. */
  NoGames: "no-games",
  /** genex.games has no daily stats yet: the plays in total. */
  Totals: "totals",
  /** Games, but nobody played them in the period: zeros and a link to share. */
  Quiet: "quiet",
  /** The period's numbers with More. */
  Numbers: "numbers",
  /** The stats could not be read. */
  Failed: "failed",
} as const;
export type StripKind = (typeof StripKind)[keyof typeof StripKind];

/** The strip's content. */
export type StripView =
  | { kind: typeof StripKind.Loading | typeof StripKind.NoGames | typeof StripKind.Failed }
  | { kind: typeof StripKind.Totals; plays: number; playingNow: number }
  | { kind: typeof StripKind.Quiet; share: PlayGame | null; playingNow: number }
  | {
      kind: typeof StripKind.Numbers;
      plays: number;
      playsChange: Change;
      players: number;
      /** A change in players is shown only beside a real one in plays: "New" twice says nothing. */
      playersChange: Change | null;
      playingNow: number;
    };

/** The game a quiet week offers to share: the account's most played. */
const mostPlayed = (games: readonly PlayGame[]): PlayGame | null =>
  games.toSorted((a, b) => b.plays - a.plays)[0] ?? null;

/** What the strip shows for `entry` (the period's read) and the account's published `games`. */
export function stripView(entry: StatsEntry | undefined, games: readonly PlayGame[]): StripView {
  if (games.length === 0) return { kind: StripKind.NoGames };
  if (!entry || (entry.status === LoadStatus.Loading && !entry.stats && !entry.unavailable))
    return { kind: StripKind.Loading };
  const playingNow = (live: number | null) => live ?? games.reduce((sum, game) => sum + (game.online ?? 0), 0);
  if (entry.unavailable || (!entry.stats && entry.status === LoadStatus.Ready))
    return {
      kind: StripKind.Totals,
      plays: games.reduce((sum, game) => sum + game.plays, 0),
      playingNow: playingNow(null),
    };
  if (!entry.stats) return { kind: StripKind.Failed };
  const totals = statsTotals(entry.stats);
  if (totals.plays === 0) return { kind: StripKind.Quiet, share: mostPlayed(games), playingNow: totals.playingNow };
  const steady = totals.playsChange.kind !== ChangeKind.New;
  return {
    kind: StripKind.Numbers,
    plays: totals.plays,
    playsChange: totals.playsChange,
    players: totals.players,
    playersChange: steady ? totals.playersChange : null,
    playingNow: totals.playingNow,
  };
}
