/**
 * Live's play-time models and microphone ask per game, as main keeps them (`core/preview-ai.ts`):
 * read when the bar mounts for a game, then kept by the `preview.ai` event. Each of the bar's
 * buttons is one call to main, whose answer is the game's state after it. Pure actions; the store's
 * commands call `StudioApi`.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import type { PreviewAiState } from "../../shared/preview-ai.ts";
import type { StudioApi } from "../../shared/studio-api.ts";

export interface PreviewAiStoreState {
  /** Each game's state, once read or heard. */
  games: Readonly<Record<string, PreviewAiState>>;
}

export const EMPTY_PREVIEW_AI: PreviewAiStoreState = { games: {} };

/** A game's state arrived (a read, an answer or the event). */
export function previewAiArrived(state: PreviewAiStoreState, next: PreviewAiState): PreviewAiStoreState {
  const now = state.games[next.project];
  if (now && JSON.stringify(now) === JSON.stringify(next)) return state;
  return { ...state, games: { ...state.games, [next.project]: next } };
}

export interface PreviewAiStore extends StoreApi<PreviewAiStoreState> {
  /** Read a game's state from main (the bar mounted for it). */
  read(project: string): Promise<void>;
  /** The person's Start for a cap: real models in Live, paid from their credits. */
  startReal(project: string, capCredits: number): Promise<void>;
  /** The person's Start for a plan of their own: it answers in Live, at no credits. */
  startPlan(project: string, engine: string): Promise<void>;
  /** The person's Stop: practice answers again. */
  backToPractice(project: string): Promise<void>;
  /** The person's answer to the game's microphone ask. */
  answerMic(project: string, allow: boolean): Promise<void>;
  /** The `preview.ai` event. */
  heard(next: PreviewAiState): void;
}

/** The store over `api`. */
export function createPreviewAiStore(
  api: Pick<StudioApi, "previewAi" | "previewAiReal" | "previewAiPlan" | "previewAiPractice" | "previewMicAnswer">,
): PreviewAiStore {
  const store = createStore<PreviewAiStoreState>()(() => EMPTY_PREVIEW_AI);
  const take = async (answer: Promise<PreviewAiState>): Promise<void> => {
    const next = await answer.catch(() => null);
    if (next) store.setState((state) => previewAiArrived(state, next), true);
  };
  return Object.assign(store, {
    read: (project: string) => take(api.previewAi(project)),
    startReal: (project: string, capCredits: number) => take(api.previewAiReal(project, capCredits)),
    startPlan: (project: string, engine: string) => take(api.previewAiPlan(project, engine)),
    backToPractice: (project: string) => take(api.previewAiPractice(project)),
    answerMic: (project: string, allow: boolean) => take(api.previewMicAnswer(project, allow)),
    heard: (next: PreviewAiState) => store.setState((state) => previewAiArrived(state, next), true),
  });
}
