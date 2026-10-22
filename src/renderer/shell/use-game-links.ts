/**
 * `genex://game/<slug>` links (the website's Open in Genex): once the shell is ready, the game a
 * link left waiting opens its page in Play, and so does each one main announces after
 * (`play.game-link`). Main hands each game over once (`main/play/game-links.ts`).
 */
import { useEffect } from "react";
import type { StudioApi } from "../../shared/studio-api.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type { Studio } from "../state/studio.ts";

/** Open the game a link waits on now, and each one main announces; answers the unsubscribe. */
export function followGameLinks(
  api: Pick<StudioApi, "playTakeGameLink" | "onEvent">,
  open: (slug: string) => void,
): () => void {
  const take = (): void => {
    void api
      .playTakeGameLink()
      .then((slug) => {
        if (slug) open(slug);
      })
      .catch(() => {});
  };
  take();
  return api.onEvent((event) => {
    if (event.type === UiEvent.PlayGameLink) take();
  });
}

/** Open each linked game's page in Play once the shell is `ready`. */
export function useGameLinks(app: Studio, ready: boolean, openPlay: (play: boolean) => void): void {
  useEffect(() => {
    if (!ready) return undefined;
    return followGameLinks(window.studio, (slug) => {
      openPlay(true);
      app.play.showGame(slug);
    });
  }, [app, ready, openPlay]);
}
