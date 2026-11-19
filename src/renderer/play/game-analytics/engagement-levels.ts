/**
 * "How far players get", derived without React: each level's share of the players who started the
 * first one, the level that loses the most of them, and the median tries and time to pass. A game
 * that sends no level events is told apart from one whose levels nobody has played yet.
 */
import type { LevelRow } from "../../../shared/game-analytics.ts";
import { ENGAGEMENT_WORDS as WORDS } from "./engagement-words.ts";
import { DASH, formatDuration, formatNumber, formatPoints, type HistogramBucket } from "./kit/index.ts";
import { levelName } from "./report-words.ts";

/** A loss that rounds to less than this many points is no loss worth naming. */
const LOSS_MIN_POINTS = 1;
const PERCENT = 100;

/** What the levels block is in: drawn, waiting for the game's events, or waiting for players. */
export const LevelsKind = { Levels: "levels", Unsent: "unsent", Nobody: "nobody" } as const;
export type LevelsKind = (typeof LevelsKind)[keyof typeof LevelsKind];

/** A line of numbers under the bars, one cell per level. */
export interface LevelsLine {
  id: string;
  label: string;
  cells: string[];
}

/** What "How far players get" draws. */
export type LevelsView =
  | {
      kind: typeof LevelsKind.Levels;
      /** Who the shares are of: the players who started the first level. */
      hint: string;
      /** One bar per level; the one that loses the most carries its loss as a note. */
      buckets: HistogramBucket[];
      /** Median tries and time to pass, a cell per level. */
      rows: LevelsLine[];
      footnote: string;
    }
  /** The game sends no level events: the block says how to start. */
  | { kind: typeof LevelsKind.Unsent }
  /** It sends them, and nobody has started a level in these days. */
  | { kind: typeof LevelsKind.Nobody };

export { levelName };

/** Decimals of a median number of tries: whole when it is, else one. */
const triesDigits = (tries: number): number => (Number.isInteger(tries) ? 0 : 1);

/** The level whose share falls furthest below the one before it (the first against everyone); null when none loses a point. */
function biggestLoss(shares: readonly number[]): { index: number; drop: number } | null {
  let worst: { index: number; drop: number } | null = null;
  for (const [index, share] of shares.entries()) {
    const drop = (shares[index - 1] ?? 1) - share;
    if (drop > (worst?.drop ?? 0)) worst = { index, drop };
  }
  return worst && Math.round(worst.drop * PERCENT) >= LOSS_MIN_POINTS ? worst : null;
}

/** The sentence under the bars: what they are, and which level loses the most and after how many tries. */
function footnoteOf(levels: readonly LevelRow[], loss: { index: number; drop: number } | null): string {
  const row = loss ? levels[loss.index] : undefined;
  if (!loss || !row) return WORDS.levels.note;
  const level = levelName(row.level);
  const points = Math.round(loss.drop * PERCENT);
  const shownPoints = formatNumber(points);
  if (row.tries === null) return WORDS.levels.loses(level, points, shownPoints);
  return WORDS.levels.losesAfter(
    level,
    points,
    shownPoints,
    row.tries,
    formatNumber(row.tries, triesDigits(row.tries)),
  );
}

/** The levels of a game as the block draws them. */
export function levelsView(levels: readonly LevelRow[] | null): LevelsView {
  if (levels === null) return { kind: LevelsKind.Unsent };
  const first = levels[0];
  if (first === undefined || first.started <= 0) return { kind: LevelsKind.Nobody };
  const shares = levels.map((row) => Math.min(1, Math.max(0, row.finished / first.started)));
  const loss = biggestLoss(shares);
  return {
    kind: LevelsKind.Levels,
    hint: WORDS.levels.hint(first.started, formatNumber(first.started), levelName(first.level)),
    buckets: levels.map((row, index) => ({
      id: row.level,
      label: levelName(row.level),
      value: shares[index] ?? 0,
      ...(loss?.index === index ? { note: formatPoints(-loss.drop, 0) } : {}),
    })),
    rows: [
      {
        id: "tries",
        label: WORDS.levels.tries,
        cells: levels.map((row) => (row.tries === null ? DASH : formatNumber(row.tries, triesDigits(row.tries)))),
      },
      { id: "time", label: WORDS.levels.time, cells: levels.map((row) => formatDuration(row.seconds)) },
    ],
    footnote: footnoteOf(levels, loss),
  };
}
