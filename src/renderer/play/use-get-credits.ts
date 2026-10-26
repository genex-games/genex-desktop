/**
 * Get credits: genex.games' plans page in the browser, from wherever credits are spent (the account
 * menu at zero, a card the account had too few credits for, a review it cannot pay for).
 */
import { creditsPlansUrl } from "../../shared/play-credits.ts";
import { usePlayWeb } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";

/** Opens genex.games' plans page; nothing to do when main cannot open it. */
export function useGetCredits(): () => void {
  const web = usePlayWeb();
  return () =>
    void studio()
      .api.openUrl(creditsPlansUrl(web))
      .catch(() => undefined);
}
