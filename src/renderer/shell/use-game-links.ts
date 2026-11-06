/**
 * `genex://` links: once the shell is ready, the game a link left waiting opens, and so does each one
 * main announces after (`play.game-link`). A `genex://game/<slug>` link opens the game's page in Play;
 * a `genex://create/<slug>` link to a game of this library (a review on genex.games, its email) opens
 * that game with Publish, where its review card is, and opening it sends nothing. Main hands each
 * link over once (`main/play/game-links.ts`).
 */
import { useEffect } from "react";
import { GENEX_PLUGIN_ID } from "../../shared/genex.ts";
import type { GameLinkOpen } from "../../shared/play.ts";
import type { StudioApi } from "../../shared/studio-api.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { PlayModeVia } from "../analytics/workspace-vocabulary.ts";
import { openPluginSetupFor } from "../plugin-setup.ts";
import type { Studio } from "../state/studio.ts";

/** Open the link waiting now, and each one main announces; answers the unsubscribe. */
export function followGameLinks(
  api: Pick<StudioApi, "playTakeGameLink" | "onEvent">,
  open: (link: GameLinkOpen) => void,
): () => void {
  const take = (): void => {
    void api
      .playTakeGameLink()
      .then((link) => {
        if (link?.slug) open(link);
      })
      .catch(() => {});
  };
  take();
  return api.onEvent((event) => {
    if (event.type === UiEvent.PlayGameLink) take();
  });
}

/** What the shell does for a link: show a game's page in Play, or open a game of the library with Publish. */
export interface GameLinkShell {
  showInPlay(slug: string): void;
  openGame(project: string): void;
  openPublish(project: string): void;
}

/** Open what a link names: the library's own game with Publish when it names one, else the game's page in Play. */
export function openGameLink(link: GameLinkOpen, shell: GameLinkShell): void {
  if (!link.project) {
    shell.showInPlay(link.slug);
    return;
  }
  shell.openGame(link.project);
  shell.openPublish(link.project);
}

/** Open each linked game once the shell is `ready`: its page in Play, or the library's own game with Publish. */
export function useGameLinks(
  app: Studio,
  ready: boolean,
  openPlay: (play: boolean, via?: PlayModeVia) => void,
  selectGame: (project: string) => void,
): void {
  useEffect(() => {
    if (!ready) return undefined;
    const shell: GameLinkShell = {
      showInPlay: (slug) => {
        openPlay(true, PlayModeVia.GameLink);
        app.play.showGame(slug);
      },
      // Opening a game leaves Play and the other rooms itself.
      openGame: (project) => selectGame(project),
      openPublish: (project) => openPluginSetupFor(project, GENEX_PLUGIN_ID),
    };
    return followGameLinks(window.studio, (link) => openGameLink(link, shell));
  }, [app, ready, openPlay, selectGame]);
}
