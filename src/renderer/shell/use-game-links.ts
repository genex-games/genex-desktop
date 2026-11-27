/**
 * `genex://` links: once the shell is ready, the game a link left waiting opens, and so does each one
 * main announces after (`play.game-link`). A `genex://game/<slug>` link opens the game's page in Play;
 * a `genex://create/<slug>` link to a game of this library (a review on genex.games, its email) opens
 * that game with Publish, where its review card is, and opening it sends nothing. A link from the
 * Genex button in a game engine's editor opens that game's chat as the small window kept over the
 * editor (`beside-window.ts`), and for a project no game here holds, the Open Game sheet. Main hands each
 * link over once (`main/play/game-links.ts`).
 */
import { useEffect } from "react";
import { GENEX_PLUGIN_ID } from "../../shared/genex.ts";
import type { FolderInspection } from "../../shared/game-project.ts";
import type { GameLinkOpen } from "../../shared/play.ts";
import type { StudioApi } from "../../shared/studio-api.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { PlayModeVia } from "../analytics/workspace-vocabulary.ts";
import { openPluginSetupFor } from "../plugin-setup.ts";
import type { Studio } from "../state/studio.ts";
import { notifyProblem } from "../state/toasts.ts";
import { setBesideWindow } from "./beside-window.ts";

/** Open the link waiting now, and each one main announces; answers the unsubscribe. */
export function followGameLinks(
  api: Pick<StudioApi, "playTakeGameLink" | "onEvent">,
  open: (link: GameLinkOpen) => void,
): () => void {
  const take = (): void => {
    void api
      .playTakeGameLink()
      .then((link) => {
        if (link?.slug || link?.chat) open(link);
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
  /** Make the window the small chat kept over the editor the link came from. */
  showBeside(): void;
  /** Offer to open an editor's project no game here holds: the Open Game sheet asks. */
  offerFolder(folder: string): void;
}

/** Open what a link names: the library's own game with Publish when it names one, else the game's page in Play. */
export function openGameLink(link: GameLinkOpen, shell: GameLinkShell): void {
  if (link.chat) {
    if (link.project) {
      shell.openGame(link.project);
      shell.showBeside();
    } else if (link.folder) shell.offerFolder(link.folder);
    return;
  }
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
  offerFolder: (inspection: FolderInspection) => void,
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
      showBeside: () => void setBesideWindow(window.studio, app.layout, true),
      // Looking writes nothing; the sheet's own button is what opens the folder as a game.
      offerFolder: (folder) => void window.studio.inspectFolder(folder).then(offerFolder, notifyProblem(app.notify)),
    };
    return followGameLinks(window.studio, (link) => openGameLink(link, shell));
  }, [app, ready, openPlay, selectGame, offerFolder]);
}
