import { useCallback } from "react";
import { GenexAccountStatus } from "../../shared/genex-account.ts";
import { noteNav } from "../analytics/workspace-trackers.ts";
import { NavVia } from "../analytics/workspace-vocabulary.ts";
import { promoAfterWelcome } from "../genex-promo.ts";
import type { Studio } from "../state/studio.ts";
import type { ComposerHandoff } from "./use-composer-handoff.ts";

/**
 * The welcome ends at home, with the idea typed there waiting in home's composer: its first
 * message makes the game. Finishing the welcome queues the Genex promo, or settles it for someone
 * who signed in to Genex there.
 */
export function useWelcomeExit(app: Studio, handoff: ComposerHandoff) {
  const { holdIdea } = handoff;
  const readyAfterWelcome = useCallback(
    async (idea: string | null) => {
      holdIdea(idea);
      noteNav(NavVia.AfterWelcome);
      app.goHome();
    },
    [app, holdIdea],
  );
  const finishWelcome = useCallback(
    (then?: () => void) => {
      // A new person meets the Genex plugin once the welcome is behind them, unless they signed in
      // to Genex there.
      promoAfterWelcome(app.people.getState().account === GenexAccountStatus.SignedIn);
      app.finishWelcome();
      then?.();
    },
    [app],
  );
  return { readyAfterWelcome, finishWelcome };
}
