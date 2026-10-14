import { useCallback } from "react";
import { queueGenexPromo } from "../genex-promo.ts";
import type { Studio } from "../state/studio.ts";
import type { ComposerHandoff } from "./use-composer-handoff.ts";

/**
 * The welcome ends at Home, with its idea waiting in the composer. C++ creation is an explicit
 * secondary action there; completing the welcome creates no game.
 */
export function useWelcomeExit(
  app: Pick<Studio, "goHome" | "finishWelcome">,
  handoff: Pick<ComposerHandoff, "holdIdea">,
) {
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
      // A new person meets Genex Tools once the welcome is behind them.
      queueGenexPromo();
      app.finishWelcome();
      then?.();
    },
    [app],
  );
  return { readyAfterWelcome, finishWelcome };
}
