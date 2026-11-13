/**
 * The game's design board for the stage: what the Design tab hangs, and whether it holds something
 * the person has not seen (the tab's mark). Kept out of `DesignStage.tsx`, which loads only when
 * Design opens. The board is read again on a clock (`design-boards.ts`): often while the tab is
 * open, now and then while it is not, and at once when the agent shows a page.
 */
import { useEffect, useState } from "react";
import type { DesignBoard } from "../../../shared/design-board.ts";
import { SECOND_MS } from "../../../shared/duration.ts";
import { readText, storageKeyFor, writeText } from "../../storage.ts";
import { LIVE_POLL_MS, useLiveBoard } from "./design-boards.ts";
import { boardIsNew } from "./design-asks.ts";

/** How often the board is read again while its tab is not open. */
const AWAY_POLL_MS = 10 * SECOND_MS;

const EMPTY: DesignBoard = { items: [], stamp: "" };

/** The stage's game's design board, read again while it may change, and whether it is new to the person. */
export function useDesignBoard(project: string | null, open: boolean): { board: DesignBoard; isNew: boolean } {
  const board = useLiveBoard(project, open ? LIVE_POLL_MS : AWAY_POLL_MS) ?? EMPTY;
  const [seen, setSeen] = useState<string | null>(null);
  useEffect(() => {
    setSeen(project ? readText(storageKeyFor.designSeen(project)) : null);
  }, [project]);
  // Looking at the board is what makes it seen.
  useEffect(() => {
    if (!project || !open || !board.stamp || board.stamp === seen) return;
    writeText(storageKeyFor.designSeen(project), board.stamp);
    setSeen(board.stamp);
  }, [project, open, board.stamp, seen]);
  return { board, isNew: !open && boardIsNew({ pages: board.items.length, stamp: board.stamp }, seen) };
}
