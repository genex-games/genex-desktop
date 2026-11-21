/**
 * Each game's design board as main last read it, for everything that draws one: the stage's Design
 * tab and the chat's cards of the pages an agent showed. A board is files the game's agent writes,
 * so whoever shows one reads it again on a clock (`useLiveBoard`, the stage's `useDesignBoard`);
 * two readers of one game share one read and one answer.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { DesignBoard, DesignItem } from "../../../shared/design-board.ts";
import { SECOND_MS } from "../../../shared/duration.ts";
import { UiEvent } from "../../../shared/ui-events.ts";
import { usePolling } from "../../use-polling.ts";

/** How often a board on show is read again: a page being written reaches the person within this. */
export const LIVE_POLL_MS = 2 * SECOND_MS;

/** How long a board that was just read counts as read, whoever asks next. */
const FRESH_MS = SECOND_MS;

const EMPTY: DesignBoard = { items: [], stamp: "" };

const boards = new Map<string, DesignBoard>();
const reads = new Map<string, Promise<void>>();
/** When each game's board was last read, on the page's own clock. */
const readAt = new Map<string, number>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether two answers hold the same artboards at the same addresses: a board read again and unchanged. */
function sameBoard(a: DesignBoard, b: DesignBoard): boolean {
  if (a.stamp !== b.stamp || a.items.length !== b.items.length) return false;
  return a.items.every((item, index) => item.url === b.items[index]?.url && item.title === b.items[index]?.title);
}

/** Whether an artboard read again is the one already kept: same file, address, title and time. */
const sameItem = (a: DesignItem, b: DesignItem): boolean =>
  a.file === b.file && a.url === b.url && a.title === b.title && a.modifiedAt === b.modifiedAt;

/**
 * A board read again, sharing what did not change with the one kept: an artboard that is the same
 * is the same object, and a list of the same artboards the same list, so what draws them redraws
 * only what changed. A stamp moves with any file of the board (the person's own marks among them).
 */
export function sharedBoard(before: DesignBoard | undefined, board: DesignBoard): DesignBoard {
  if (!before) return board;
  const kept = new Map(before.items.map((item) => [item.file, item]));
  const items = board.items.map((item) => {
    const old = kept.get(item.file);
    return old && sameItem(old, item) ? old : item;
  });
  const same = items.length === before.items.length && items.every((item, index) => item === before.items[index]);
  return { items: same ? before.items : items, stamp: board.stamp };
}

/** Keep a game's board as it was just read, telling whoever draws it only when it changed. */
function keepBoard(project: string, board: DesignBoard): void {
  const before = boards.get(project);
  if (before && sameBoard(before, board)) return;
  boards.set(project, sharedBoard(before, board));
  for (const listener of listeners) listener();
}

/**
 * Read a game's board again. A read already on its way is the one awaited, and a board read within
 * `FRESH_MS` is not read again unless `atOnce` (the agent just showed a page): the tab and each
 * card on show keep their own clocks, and together they still ask main about once a second at most.
 * A board that cannot be read is empty.
 */
export function refreshBoard(project: string, atOnce = false): Promise<void> {
  const running = reads.get(project);
  if (running) return running;
  if (!atOnce && performance.now() - (readAt.get(project) ?? -FRESH_MS) < FRESH_MS) return Promise.resolve();
  const read = window.studio
    .designBoard(project)
    .catch(() => EMPTY)
    .then((board) => keepBoard(project, board))
    .finally(() => {
      reads.delete(project);
      readAt.set(project, performance.now());
    });
  reads.set(project, read);
  return read;
}

/** A game's board as last read; null until its first read has answered. */
export function useBoard(project: string | null): DesignBoard | null {
  return useSyncExternalStore(subscribe, () => (project ? (boards.get(project) ?? null) : null));
}

/**
 * A game's board, read again every `everyMs` while `live`, and at once when the game's agent shows
 * a page; null until the first read has answered.
 */
export function useLiveBoard(project: string | null, everyMs = LIVE_POLL_MS, live = true): DesignBoard | null {
  const refresh = useCallback(() => {
    if (project) void refreshBoard(project);
  }, [project]);
  useEffect(() => {
    refresh();
    if (!project) return;
    return window.studio.onEvent((event) => {
      if (event.type === UiEvent.DesignShown && event.payload.project === project) void refreshBoard(project, true);
    });
  }, [project, refresh]);
  usePolling(refresh, everyMs, live && project !== null);
  return useBoard(project);
}
