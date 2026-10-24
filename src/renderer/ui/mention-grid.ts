/**
 * Moving the @ picker's outline with the arrow keys: rows at its top (Images) form one column, the
 * cards under them a grid of `columns`, and rows after the cards one column again. Pure, so it is
 * tested without a window.
 */

/** The picker's shape: rows before the cards, the cards and their columns, rows after them. */
export interface MentionGridShape {
  lead?: number;
  cards: number;
  rows: number;
  columns: number;
}

/** The arrow keys the picker takes from the text box. */
export const GRID_KEYS: ReadonlySet<string> = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

/** Where an arrow key moves the outline from `active`, clamped to the list; null for other keys. */
export function gridTarget(key: string, active: number, shape: MentionGridShape): number | null {
  const lead = shape.lead ?? 0;
  const total = lead + shape.cards + shape.rows;
  if (!GRID_KEYS.has(key) || total === 0) return null;
  const last = total - 1;
  if (key === "ArrowLeft") return Math.max(0, active - 1);
  if (key === "ArrowRight") return Math.min(last, active + 1);
  // In the rows above the cards, up and down go row by row, and down from the last one to the first card.
  if (active < lead) return key === "ArrowDown" ? Math.min(last, active + 1) : Math.max(0, active - 1);
  const target = gridMove(key, active - lead, shape);
  if (target !== null) return lead + target;
  return lead > 0 ? lead - 1 : active;
}

/** A vertical move inside the cards and the rows after them; null when Up leaves the cards' first line. */
function gridMove(key: string, active: number, shape: MentionGridShape): number | null {
  const last = shape.cards + shape.rows - 1;
  const inCards = active < shape.cards;
  if (key === "ArrowDown") {
    if (!inCards) return Math.min(last, active + 1);
    const below = active + shape.columns;
    if (below < shape.cards) return below;
    // From the last line of cards, down goes to the first row, or to the last card.
    return shape.rows > 0 ? shape.cards : Math.min(last, below);
  }
  if (!inCards) return active === shape.cards ? lastLineStart(shape) : active - 1;
  return active - shape.columns >= 0 ? active - shape.columns : null;
}

/** The first card of the cards' last line, where Up from the first row lands. */
function lastLineStart(shape: MentionGridShape): number {
  if (shape.cards === 0) return 0;
  return Math.floor((shape.cards - 1) / shape.columns) * shape.columns;
}
