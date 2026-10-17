/**
 * Genex's picture on the Plugins page: the tools it routes, sliding round a 2×2 board that is
 * never empty. Still in a menu and when the person asked for reduced motion.
 */
import type { JSX, RefObject } from "react";
import { useEffect, useRef } from "react";
import type { PluginIconSize } from "../../../ui/PluginIcon.tsx";
import { BOARD_CELLS, type Cell, loopMs, pieceFrames } from "./router-icon.ts";
import { ICON_TOOLS, markIsLight, toolMark } from "./routed-tools.ts";

/** Where a cell is, as a percentage of a tile's own size (a CSS translate): the board's inset, the step between cells, and just off each side. */
const INSET_PCT = 17.6;
const STEP_PCT = 116.35;
const OFF_BEFORE_PCT = -106;
const OFF_AFTER_PCT = 256;
/** How a tool slides between two cells. */
const SLIDE_EASING = "cubic-bezier(0.6, 0, 0.2, 1)";
/** A hop between two places off the board happens at once. */
const HOP_EASING = "steps(1, end)";

const place = (v: number): number => {
  if (v < 0) return OFF_BEFORE_PCT;
  if (v > 1) return OFF_AFTER_PCT;
  return INSET_PCT + v * STEP_PCT;
};
const translate = ([column, row]: Cell): string => `translate(${place(column)}%, ${place(row)}%)`;

/** The timelines are the same for every board, so they are worked out once. */
const FRAMES = pieceFrames(ICON_TOOLS.length);
const LOOP_MS = loopMs(ICON_TOOLS.length);

/** Play the board's moves on its tiles until the picture goes away. */
function usePlay(board: RefObject<HTMLSpanElement | null>, still: boolean): void {
  useEffect(() => {
    const tiles = board.current?.children;
    if (still || !tiles || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const playing = FRAMES.map((frames, i) =>
      tiles[i]?.animate(
        frames.map((f) => ({
          transform: translate(f.cell),
          offset: f.offset,
          easing: f.jump ? HOP_EASING : SLIDE_EASING,
        })),
        { duration: LOOP_MS, iterations: Number.POSITIVE_INFINITY },
      ),
    );
    return () => {
      for (const animation of playing) animation?.cancel();
    };
  }, [board, still]);
}

/** Genex's picture: its routed tools on a board that keeps moving (still in a menu). */
export function RouterIcon({ size = "row" }: { size?: PluginIconSize }): JSX.Element {
  const board = useRef<HTMLSpanElement>(null);
  const still = size === "menu";
  usePlay(board, still);
  const tools = still ? ICON_TOOLS.slice(0, BOARD_CELLS.length) : ICON_TOOLS;
  return (
    <span ref={board} className={`extension-icon extension-icon-${size} router-icon`} aria-hidden="true">
      {tools.map((tool, i) => (
        <span key={tool} className="router-tile" style={{ transform: translate(FRAMES[i]?.[0]?.cell ?? [-1, -1]) }}>
          <img src={toolMark(tool)} alt="" draggable={false} data-light-mark={markIsLight(tool) || undefined} />
        </span>
      ))}
    </span>
  );
}
