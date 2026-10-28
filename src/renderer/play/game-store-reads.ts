/**
 * When a game page's Store section reads genex.games again (marketplace plan 10.2), decided without a
 * window: the Store tab when the page opens, My items the first time it is chosen, both after the
 * account changes and after a purchase or a claim (`all`), and the half on show again when it is
 * chosen again or the window comes back to the front, once its last read is old (`REREAD_GAP_MS`):
 * an item added to or removed from the game elsewhere shows up without leaving the page, and a burst
 * of focus and tab presses reads once. `use-game-store.ts` makes the reads.
 */
import { rereadDue } from "../state/refresher.ts";
import { StoreView } from "./store-model.ts";

/** The two reads a game page's store makes. */
export interface GameStoreReader {
  /** The Store tab, with My items' count. */
  readTab(): void;
  readMine(): void;
}

/** What asks a game page's store to read again. */
export interface GameStoreReads {
  /** Everything again, whenever: the page opened, the account changed, or a purchase or a claim ended. */
  all(): void;
  /** A half was chosen: My items is read the first time, and either again once its last read is old. */
  chose(view: StoreView): void;
  /** The window came back to the front with `view` on show: it is read again once its last read is old. */
  focused(view: StoreView): void;
}

/** The reads of one game page's store over `read`, paced on the clock `now`. */
export function gameStoreReads(read: GameStoreReader, now: () => number): GameStoreReads {
  /** My items was chosen once: from then on it is read with the tab. */
  let wantsMine = false;
  const last: Partial<Record<StoreView, number>> = {};
  const readView = (view: StoreView, force: boolean): void => {
    if (!force && !rereadDue(last[view], now())) return;
    last[view] = now();
    if (view === StoreView.MyItems) read.readMine();
    else read.readTab();
  };
  return {
    all: () => {
      readView(StoreView.Store, true);
      if (wantsMine) readView(StoreView.MyItems, true);
    },
    chose: (view) => {
      if (view === StoreView.Store) return readView(StoreView.Store, false);
      const first = !wantsMine;
      wantsMine = true;
      readView(StoreView.MyItems, first);
    },
    focused: (view) => {
      readView(StoreView.Store, false);
      if (view === StoreView.MyItems) readView(StoreView.MyItems, false);
    },
  };
}
