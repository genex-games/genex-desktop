/**
 * genex.games' coin mark, a pixel coin: what a game's price and the account's balance are counted
 * in. Its gold and the gold's light and shade are theme tokens (`--coin*`, play.css). Never the blue
 * credits shard: credits pay for making, coin for what games sell.
 */
import type { JSX } from "react";

/** The coin, row by row, as genex.games draws it: L light, M mid, D dark. */
const COIN = [
  "..LLL......",
  ".LLMMM.....",
  "LLMMMMD....",
  "LMMMMMD.L..",
  "LMMMMDD.MM.",
  ".MMMDD..MMD",
  "..DDD..MMMD",
  "......MMMDD",
  ".....MMMDD.",
  "......DDD..",
] as const;
/** The coin's grid: columns by rows. */
const COLUMNS = 11;
const ROWS = 10;

type CoinShade = "L" | "M" | "D";
const isShade = (pixel: string): pixel is CoinShade => pixel === "L" || pixel === "M" || pixel === "D";

/** Every lit pixel of the coin with its shade. */
const COIN_CELLS = COIN.flatMap((row, y) =>
  [...row].flatMap((pixel, x) => (isShade(pixel) ? [{ x, y, shade: pixel }] : [])),
);

/** The coin mark, `size` pixels wide. */
export function CoinMark({ size = 17 }: { size?: number }): JSX.Element {
  return (
    <svg
      className="coin-mark"
      viewBox={`0 0 ${COLUMNS} ${ROWS}`}
      width={size}
      height={Math.round((size * ROWS) / COLUMNS)}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {COIN_CELLS.map((cell) => (
        <rect key={`${cell.x}-${cell.y}`} x={cell.x} y={cell.y} width={1} height={1} data-shade={cell.shade} />
      ))}
    </svg>
  );
}
