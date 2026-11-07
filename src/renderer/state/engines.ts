/**
 * The engines the studio can build with, as main last described them. Re-read on
 * `engines.changed`, on a sign-in, after a model finishes downloading, and when a surface asks.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import type { EngineDescriptor, StudioApi } from "../../shared/studio-api.ts";
import { createRefresher } from "./refresher.ts";

/** The revision a re-read is counted from when its engine cannot list its models again: any listing proves. */
export const REREAD_UNAVAILABLE = -1;

export interface EnginesState {
  list: EngineDescriptor[];
  /**
   * Engines whose models were listed again because a saved pick was missing from their list, by the
   * catalog revision they had when it was asked: only a listing newer than that one proves the pick
   * gone (`use-composer-model.ts`). Once per engine for the app's run.
   */
  rereads: Readonly<Record<string, number>>;
}

export function enginesLoaded(state: EnginesState, list: EngineDescriptor[]): EnginesState {
  return state.list === list ? state : { ...state, list };
}

/** A re-read of one engine's models was asked at this catalog revision; the first ask stands. */
export function rereadAsked(state: EnginesState, engine: string, revision: number): EnginesState {
  if (state.rereads[engine] !== undefined) return state;
  return { ...state, rereads: { ...state.rereads, [engine]: revision } };
}

/** The engine could not list its models again: the listing it has is the proof. */
export function rereadRefused(state: EnginesState, engine: string): EnginesState {
  return { ...state, rereads: { ...state.rereads, [engine]: REREAD_UNAVAILABLE } };
}

export interface EnginesStore extends StoreApi<EnginesState> {
  /** Read the list again; a read that fails keeps the last list. */
  refresh(): Promise<void>;
  /**
   * List one engine's models again, once, because a saved pick was missing from the list it gave
   * at `revision` (a first listing after launch can be partial: OpenCode lists its built-in
   * catalog while its cached one is missing). True when this call asked: no earlier one had.
   */
  reread(engine: string, revision: number): boolean;
}

export function createEnginesStore(api: Pick<StudioApi, "engines" | "refreshModels">): EnginesStore {
  const store = createStore<EnginesState>()(() => ({ list: [], rereads: {} }));
  const refresher = createRefresher(api.engines.bind(api), (list) =>
    store.setState((state) => enginesLoaded(state, list), true),
  );
  const listAgain = async (engine: string): Promise<void> => {
    try {
      await api.refreshModels(engine);
    } catch {
      store.setState((state) => rereadRefused(state, engine), true);
    }
    await refresher.request();
  };
  const reread = (engine: string, revision: number): boolean => {
    if (store.getState().rereads[engine] !== undefined) return false;
    store.setState((state) => rereadAsked(state, engine, revision), true);
    void listAgain(engine);
    return true;
  };
  return Object.assign(store, { refresh: () => refresher.request(), reread });
}
