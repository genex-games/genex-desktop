/**
 * Native games' AI budgets as their pages read them (`play/AiBudget.tsx`): what each game declared
 * and the account's budget in it, kept by the game's address. A read that fails keeps what was
 * known; an approval or a stop shows only what genex.games answered. Pure actions live in
 * `play/ai-budget-model.ts`; the store's commands call `StudioApi`.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import type { AiBudgetConfirmed, AiBudgetOpened, AiBudgetRead, AiBudgetStopped } from "../../shared/play-ai-budget.ts";
import type { StudioApi } from "../../shared/studio-api.ts";
import { budgetAfterChange, budgetAfterRead } from "../play/ai-budget-model.ts";

export interface AiBudgetState {
  /** Each game's budget by its address, once read. */
  games: Readonly<Record<string, AiBudgetRead>>;
}

export const EMPTY_AI_BUDGETS: AiBudgetState = { games: {} };

/** A game's read arrived. */
export function aiBudgetRead(state: AiBudgetState, slug: string, read: AiBudgetRead): AiBudgetState {
  return { games: { ...state.games, [slug]: budgetAfterRead(state.games[slug], read) } };
}

/** A game's budget was approved or stopped: `current` is how it stands after. */
export function aiBudgetChanged(state: AiBudgetState, slug: string, current: AiBudgetRead["current"]): AiBudgetState {
  return { games: { ...state.games, [slug]: budgetAfterChange(state.games[slug], current) } };
}

export interface AiBudgetStore extends StoreApi<AiBudgetState> {
  /** Read a game's budget from genex.games; reads of one game under way are one read. */
  read(slug: string): Promise<void>;
  /** Open the game's declared budget for approval; null when the call itself failed. */
  open(slug: string): Promise<AiBudgetOpened | null>;
  /** Approve the open quote with a limit; null when the call itself failed. The line shows what was answered. */
  confirm(slug: string, limitCredits: number): Promise<AiBudgetConfirmed | null>;
  /** Stop the game's budget; null when the call itself failed. */
  stop(slug: string): Promise<AiBudgetStopped | null>;
}

/** The store over `api`. */
export function createAiBudgetStore(
  api: Pick<StudioApi, "playAiBudget" | "playAiBudgetOpen" | "playAiBudgetConfirm" | "playAiBudgetStop">,
): AiBudgetStore {
  const store = createStore<AiBudgetState>()(() => EMPTY_AI_BUDGETS);
  const reading = new Map<string, Promise<void>>();
  const read = (slug: string): Promise<void> => {
    const running = reading.get(slug);
    if (running) return running;
    const next = api
      .playAiBudget(slug)
      .then((answer) => store.setState((state) => aiBudgetRead(state, slug, answer), true))
      // An optional feature: a read that fails changes nothing, and the page shows what it had.
      .catch(() => undefined)
      .finally(() => reading.delete(slug));
    reading.set(slug, next);
    return next;
  };
  const confirm = async (slug: string, limitCredits: number): Promise<AiBudgetConfirmed | null> => {
    const answer = await api.playAiBudgetConfirm(slug, limitCredits).catch(() => null);
    if (answer && "current" in answer) store.setState((state) => aiBudgetChanged(state, slug, answer.current), true);
    // Refused or unanswered: what genex.games holds now is read, never assumed.
    else await read(slug);
    return answer;
  };
  const stop = async (slug: string): Promise<AiBudgetStopped | null> => {
    const answer = await api.playAiBudgetStop(slug).catch(() => null);
    if (answer && "current" in answer) store.setState((state) => aiBudgetChanged(state, slug, answer.current), true);
    else await read(slug);
    return answer;
  };
  return Object.assign(store, {
    read,
    open: (slug: string) => api.playAiBudgetOpen(slug).catch(() => null),
    confirm,
    stop,
  });
}
