/**
 * What a game with no cover shows where its cover would be: a still wire floor plate lying toward
 * the horizon, in the theme's quiet ink, its lines fading with depth and its face faintly filled.
 * Recent's small tile draws the plate with fewer lines than a card does.
 */
import type { JSX } from "react";

/** The drawing's box in its own units: 16:9, as every cover is. */
const WIDTH = 160;
const HEIGHT = 90;
/** Where the floor would meet the sky. */
const HORIZON = 26;
/** The plate's near and far edges, as depths (1 would be the box's bottom edge). */
const NEAR = 1.35;
const FAR = 6;
/** Half the plate's width at depth 1, in units. */
const HALF_WIDTH = 74;

/** A coordinate to a hundredth: short path data. */
const at = (value: number): number => Math.round(value * 100) / 100;
/** A floor line `z` deep lies this far down. */
const floorY = (z: number): number => at(HORIZON + (HEIGHT - HORIZON) / z);
/** Where the plate's line `share` of the way across (-1 left edge, 1 right) crosses depth `z`. */
const floorX = (share: number, z: number): number => at(WIDTH / 2 + (share * HALF_WIDTH) / z);

/** How strongly a line `z` deep is drawn: near lines clear, far ones faint. */
const depthAlpha = (z: number): number => at(0.75 - (0.55 * (z - NEAR)) / (FAR - NEAR));

interface Stroke {
  d: string;
  alpha: number;
}

/** The depths between the near and far edges at which the plate's `count` lines across lie, evenly on the ground. */
function acrossDepths(count: number): number[] {
  // Equal steps of depth are equal on the ground; on screen they close up toward the horizon.
  return Array.from({ length: count }, (_, index) => NEAR + ((FAR - NEAR) * index) / (count - 1));
}

/** A line running away, cut into `segments` stretches so it fades as it goes. */
function awayStrokes(share: number, segments: number): Stroke[] {
  const depths = acrossDepths(segments + 1);
  return depths.slice(1).map((far, index) => {
    const near = depths[index] ?? NEAR;
    return {
      d: `M${floorX(share, near)} ${floorY(near)}L${floorX(share, far)} ${floorY(far)}`,
      alpha: depthAlpha(near),
    };
  });
}

/** The plate with `rows` lines across and `columns` lines away (each an odd count, edges included). */
function plate(rows: number, columns: number): { face: string; strokes: Stroke[] } {
  const across = acrossDepths(rows).map((z) => ({
    d: `M${floorX(-1, z)} ${floorY(z)}H${floorX(1, z)}`,
    alpha: depthAlpha(z),
  }));
  const shares = Array.from({ length: columns }, (_, index) => -1 + (2 * index) / (columns - 1));
  const away = shares.flatMap((share) => awayStrokes(share, rows - 1));
  const corners = [
    [floorX(-1, NEAR), floorY(NEAR)],
    [floorX(1, NEAR), floorY(NEAR)],
    [floorX(1, FAR), floorY(FAR)],
    [floorX(-1, FAR), floorY(FAR)],
  ];
  const face = corners.map(([x, y]) => `${x},${y}`).join(" ");
  return { face, strokes: [{ d: `M0 ${HORIZON}H${WIDTH}`, alpha: 0.12 }, ...across, ...away] };
}

/** A card's plate, and Recent's sparser one. */
const CARD_PLATE = plate(7, 9);
const TILE_PLATE = plate(4, 5);

/** The plate drawn to fill its box (the box is 16:9, so nothing stretches). */
export function NoCover({ small = false }: { small?: boolean }): JSX.Element {
  const { face, strokes } = small ? TILE_PLATE : CARD_PLATE;
  return (
    <svg
      className="play-no-cover"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <polygon points={face} fill="currentColor" stroke="none" opacity={0.06} />
      {strokes.map((stroke) => (
        <path key={stroke.d} d={stroke.d} opacity={stroke.alpha} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}
