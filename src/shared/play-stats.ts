/**
 * A creator's own stats, which only they ever see: for a period (7, 30 or 90 days), each published
 * game's plays and players per day, the period before as one number, and who is playing right now.
 * Every number on the stats strip and the stats page is derived here from those per-game series,
 * so totals, rows and the chart always agree.
 */

/** The periods the stats page offers, in days; the profile's strip is always the first. */
export const STATS_PERIODS = [7, 30, 90] as const;
export type StatsPeriod = (typeof STATS_PERIODS)[number];
/** The period the profile's strip shows and the stats page opens on. */
export const DEFAULT_STATS_PERIOD: StatsPeriod = 7;

/** Whether a value is one of the periods. */
export const isStatsPeriod = (value: unknown): value is StatsPeriod =>
  typeof value === "number" && (STATS_PERIODS as readonly number[]).includes(value);

/** One game's numbers over the period. */
export interface PlayGameStats {
  slug: string;
  title: string;
  coverUrl: string | null;
  /** Plays per day, oldest first, one per day of the period. */
  plays: number[];
  /** Different players per day, oldest first. */
  players: number[];
  /** Plays over the period before. */
  playsBefore: number;
  /** Different players over the whole period, and over the period before. */
  playersTotal: number;
  playersBefore: number;
  /** People in it right now. */
  playingNow: number;
}

/** A creator's stats for one period. */
export interface PlayStats {
  days: StatsPeriod;
  /** The period's last day (UTC, `YYYY-MM-DD`): today. */
  endsOn: string;
  games: PlayGameStats[];
  /** Different people who played any of their games in the period, and in the period before. */
  players: number;
  playersBefore: number;
  /** Games they have published, ever, and in the last 30 days. */
  published: number;
  publishedThisMonth: number;
}

/** How a number moved against the period before. */
export const ChangeKind = {
  Up: "up",
  Down: "down",
  Flat: "flat",
  /** Nothing before to compare with: "New", never a percentage. */
  New: "new",
  /** Nothing now and nothing before: a dash. */
  None: "none",
} as const;
export type ChangeKind = (typeof ChangeKind)[keyof typeof ChangeKind];

/** A change, with its whole percentage when there is one. */
export interface Change {
  kind: ChangeKind;
  percent: number;
}

/** How `now` compares with `before`. */
export function changeOf(now: number, before: number): Change {
  if (before <= 0) return { kind: now > 0 ? ChangeKind.New : ChangeKind.None, percent: 0 };
  const percent = Math.round(((now - before) / before) * 100);
  if (percent > 0) return { kind: ChangeKind.Up, percent };
  if (percent < 0) return { kind: ChangeKind.Down, percent };
  return { kind: ChangeKind.Flat, percent: 0 };
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

/** The period's headline numbers: plays and players with their change, and who plays now. */
export interface StatsTotals {
  plays: number;
  playsChange: Change;
  players: number;
  playersChange: Change;
  playingNow: number;
  /** The game most people are in right now, and how many others have someone in them. */
  liveGame: string | null;
  liveOthers: number;
}

/** The headline numbers of `stats`. */
export function statsTotals(stats: PlayStats): StatsTotals {
  const plays = sum(stats.games.map((game) => sum(game.plays)));
  const playsBefore = sum(stats.games.map((game) => game.playsBefore));
  const live = stats.games.filter((game) => game.playingNow > 0).toSorted((a, b) => b.playingNow - a.playingNow);
  return {
    plays,
    playsChange: changeOf(plays, playsBefore),
    players: stats.players,
    playersChange: changeOf(stats.players, stats.playersBefore),
    playingNow: sum(stats.games.map((game) => game.playingNow)),
    liveGame: live[0]?.title ?? null,
    liveOthers: Math.max(0, live.length - 1),
  };
}

/** Plays (or players) per day over every game: the chart's line and the tiles' sparklines. */
export function dailyTotals(stats: PlayStats, measure: "plays" | "players"): number[] {
  return Array.from({ length: stats.days }, (_, day) => sum(stats.games.map((game) => game[measure][day] ?? 0)));
}

/** A row of the per-game table. */
export interface GameStatsRow {
  game: PlayGameStats;
  plays: number;
  change: Change;
}

/** The per-game table: most played first, then by title. */
export function gameRows(stats: PlayStats): GameStatsRow[] {
  return stats.games
    .map((game) => {
      const plays = sum(game.plays);
      return { game, plays, change: changeOf(plays, game.playsBefore) };
    })
    .toSorted((a, b) => b.plays - a.plays || a.game.title.localeCompare(b.game.title));
}

/** The UTC date `days` before `endsOn`, as `YYYY-MM-DD`. */
export function dayBefore(endsOn: string, days: number): string {
  const end = Date.parse(`${endsOn}T00:00:00.000Z`);
  return new Date(end - days * 86_400_000).toISOString().slice(0, 10);
}

/** The date of each day of the period, oldest first. */
export const periodDays = (stats: Pick<PlayStats, "days" | "endsOn">): string[] =>
  Array.from({ length: stats.days }, (_, day) => dayBefore(stats.endsOn, stats.days - 1 - day));
