/**
 * The cover made while the game is built: once every turn on the open game has finished, Studio
 * asks the Genex plugin to take its cover (the game's genex-cover demo, or a plain frame of a game
 * with none) and record its clip, so Publish opens with them already there. The plugin decides
 * whether it is due: never over the person's pick or the owner's cover, at most once in a while.
 */
import { useEffect } from "react";
import { GENEX_PLUGIN_ID, GenexAction } from "../../../../shared/genex.ts";
import { UiEvent } from "../../../../shared/ui-events.ts";

/** Whether a finished delegation leaves the game with no turn running. */
export const turnsSettled = (payload: { project: string; active: number }, project: string): boolean =>
  payload.project === project && payload.active === 0;

/** Take the open game's cover after its turns settle, while `enabled` (Genex on, a web game with a build). */
export function useCoverAfterTurns(project: string | null, enabled: boolean): void {
  useEffect(() => {
    if (!project || !enabled) return;
    return window.studio.onEvent((event) => {
      if (event.type !== UiEvent.DelegationFinished || !turnsSettled(event.payload, project)) return;
      void window.studio.pluginAction(GENEX_PLUGIN_ID, GenexAction.CoverAuto, {}, project).catch(() => {});
    });
  }, [project, enabled]);
}
