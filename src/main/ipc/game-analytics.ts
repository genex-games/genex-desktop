/**
 * A game's analytics for its creator: the reports, the events as they arrive, the campaign links
 * and the funnels. The renderer names a game by its slug and everything else by a value of a known
 * vocabulary; every field is checked here (`play/game-analytics/asked.ts`) before the client hears
 * of it, and main builds every route. The saves and removals answer only Studio's own page
 * (`ipc-handle.ts`).
 */
import {
  campaignTagsOf,
  funnelDraftOf,
  originOf,
  periodOf,
  reportQueryOf,
  savedIdOf,
  slugOf,
} from "../play/game-analytics/asked.ts";
import type { GameAnalytics } from "../play/game-analytics/read.ts";
import type { IpcHandle } from "./registrar.ts";

/** Register the game analytics channels over `gameAnalytics`. */
export function registerGameAnalyticsIpc(handle: IpcHandle, gameAnalytics: GameAnalytics): void {
  handle("studio:play.game-report", (payload) => gameAnalytics.report(reportQueryOf(payload)));
  handle("studio:play.game-events", (payload) =>
    gameAnalytics.events(slugOf(payload?.slug), originOf(payload?.origin)),
  );
  handle("studio:play.campaign-links", (payload) =>
    gameAnalytics.links(slugOf(payload?.slug), periodOf(payload?.days)),
  );
  handle("studio:play.campaign-link-save", (payload) =>
    gameAnalytics.saveLink(slugOf(payload?.slug), campaignTagsOf(payload?.tags)),
  );
  handle("studio:play.campaign-link-remove", (payload) =>
    gameAnalytics.removeLink(slugOf(payload?.slug), savedIdOf(payload?.id)),
  );
  handle("studio:play.funnel-save", (payload) =>
    gameAnalytics.saveFunnel(slugOf(payload?.slug), funnelDraftOf(payload?.draft)),
  );
  handle("studio:play.funnel-remove", (payload) =>
    gameAnalytics.removeFunnel(slugOf(payload?.slug), savedIdOf(payload?.id)),
  );
}
