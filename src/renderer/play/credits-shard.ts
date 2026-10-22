/**
 * genex.games' credits shard as data: its pixels, the order they land in when it assembles, and the
 * scramble a credits number locks into place with. `CreditsShard.tsx` draws them.
 */

/** The shard, row by row: L light, M mid, D dark. */
const SHARD = [
  "........L..",
  "...L...LL..",
  "..LL...LML.",
  "..LML..LML.",
  ".LMML..LMML",
  ".LMMML.DMMD",
  "LMMMML.DMD.",
  "DMMMMD..D..",
  ".DMMD......",
  "..DD.......",
] as const;
/** A step of the assemble, and how many steps it takes. */
const STEP_MS = 35;
const STEPS = 14;
/** The shuffle's seed: every shard assembles in the same order, like the site's. */
const SHUFFLE_SEED = 7;
/** The scramble: characters it shows before the digits lock in, left to right, a frame every 50 ms. */
const NOISE = "!<>-_/[]{}=+*^?#$%&@";
export const SCRAMBLE_FRAMES = 10;
export const SCRAMBLE_FRAME_MS = 50;

/** The shard's tones: the brand's blues, or the green of credits earned. */
export const ShardTone = { Brand: "brand", Earned: "earned" } as const;
export type ShardTone = (typeof ShardTone)[keyof typeof ShardTone];

export type ShardCell = { x: number; y: number; shade: "L" | "M" | "D"; delay: number };

/** Every lit cell with the moment it lands in the shuffled assemble. */
function shardCells(): ShardCell[] {
  const cells: Omit<ShardCell, "delay">[] = [];
  for (const [y, row] of SHARD.entries())
    for (const [x, shade] of [...row].entries())
      if (shade !== ".") cells.push({ x, y, shade: shade as ShardCell["shade"] });
  const order = cells.map((_, index) => index);
  let seed = SHUFFLE_SEED;
  for (let i = order.length - 1; i > 0; i--) {
    seed = (seed * 16807) % 2147483647;
    const j = seed % (i + 1);
    [order[i], order[j]] = [order[j] ?? 0, order[i] ?? 0];
  }
  const perStep = Math.max(1, Math.round(cells.length / STEPS));
  const delays = new Map(order.map((cell, rank) => [cell, Math.floor(rank / perStep) * STEP_MS]));
  return cells.map((cell, index) => ({ ...cell, delay: delays.get(index) ?? 0 }));
}

/** The shard's cells, each with the moment it lands. */
export const SHARD_CELLS = shardCells();

/** `text` as the scramble shows it at `frame`: noise that locks into the text from the left. */
export function scrambled(text: string, frame: number): string {
  if (frame >= SCRAMBLE_FRAMES) return text;
  const locked = Math.floor((frame / SCRAMBLE_FRAMES) * text.length);
  let out = text.slice(0, locked);
  for (let at = locked; at < text.length; at++)
    out += /\d/.test(text[at] ?? "") ? NOISE[(at * 7 + frame * 13) % NOISE.length] : text[at];
  return out;
}
