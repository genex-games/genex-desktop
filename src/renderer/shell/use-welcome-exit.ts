import { useCallback } from "react";
import { queueGenexPromo } from "../genex-promo.ts";
import type { Studio } from "../state/studio.ts";
import type { ComposerHandoff } from "./use-composer-handoff.ts";

/**
 * The welcome ends at home, with the idea typed there waiting in home's composer: its first
 * message makes the game. Finishing the welcome queues the Genex promo.
 */
export function useWelcomeExit(app: Studio, handoff: ComposerHandoff) {
  const { holdIdea } = handoff;
  const readyAfterWelcome = useCallback(
    async (idea: string | null) => {
      holdIdea(idea);
      app.goHome();
    },
    [app, holdIdea],
  );
  const finishWelcome = useCallback(
    (then?: () => void) => {
      // A new person meets the Genex plugin once the welcome is behind them.
      queueGenexPromo();
      app.finishWelcome();
      then?.();
    },
    [app],
  );
  return { readyAfterWelcome, finishWelcome };
}
