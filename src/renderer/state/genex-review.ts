/**
 * The sidebar's second line under each game on Genex (mockup C1), as main keeps them
 * (`studio:plugins.genex-review-lines`): read once the studio is up, and again whenever a game's review
 * changes (`UiEvent.GenexReviewChanged`) or the Genex plugin says something of a game (a publish ends),
 * a burst of those once. Pure actions; the store's command calls `StudioApi`.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import type { GenexSidebarEntry } from "../../shared/genex-review.ts";
import type { StudioApi } from "../../shared/studio-api.ts";

export interface GenexReviewState {
  /** Each game's line that has one, by game. */
  lines: Readonly<Record<string, GenexSidebarEntry>>;
}

export const EMPTY_REVIEW_LINES: GenexReviewState = { lines: {} };

/** Whether two answers hold the same lines: a read that changed nothing leaves the rows alone. */
function sameLines(a: Readonly<Record<string, GenexSidebarEntry>>, b: Readonly<Record<string, GenexSidebarEntry>>) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => a[key]?.line === b[key]?.line && a[key]?.things === b[key]?.things);
}

/** Main's lines arrived. */
export function linesLoaded(state: GenexReviewState, lines: Readonly<Record<string, GenexSidebarEntry>>) {
  return sameLines(state.lines, lines) ? state : { ...state, lines };
}

export interface GenexReviewStore extends StoreApi<GenexReviewState> {
  /** Read the lines again; reads asked for while one runs become one more read after it. */
  refresh(): Promise<void>;
}

/** The lines store over `api`. */
export function createGenexReviewStore(api: Pick<StudioApi, "genexReviewLines">): GenexReviewStore {
  const store = createStore<GenexReviewState>()(() => EMPTY_REVIEW_LINES);
  const reading: { now: Promise<void> | null; again: boolean } = { now: null, again: false };
  const read = async (): Promise<void> => {
    do {
      reading.again = false;
      const lines = await api.genexReviewLines().catch(() => null);
      if (lines) store.setState((state) => linesLoaded(state, lines), true);
    } while (reading.again);
  };
  return Object.assign(store, {
    refresh(): Promise<void> {
      if (reading.now) {
        reading.again = true;
        return reading.now;
      }
      reading.now = read().finally(() => {
        reading.now = null;
      });
      return reading.now;
    },
  });
}
