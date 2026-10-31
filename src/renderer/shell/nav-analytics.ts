/**
 * Moving around the app as usage analytics counts it: a game opened (how, where its row sat,
 * how long it took), a game that would not open, a shortcut, and ⌘K search opening. The way in is
 * the note the press left (`noteNav`); what is opened is named only by its random ref.
 */
import { track } from "../analytics/client.ts";
import { AnalyticsEvent } from "../analytics/events.ts";
import { gameRef } from "../analytics/game-ref.ts";
import { countBucket } from "../analytics/properties.ts";
import { gameOpenedProperties } from "../analytics/workspace-properties.ts";
import { navNotes, noteNav } from "../analytics/workspace-trackers.ts";
import { NavItem, NavVia, PlayMode, SearchVia, type ShortcutKey } from "../analytics/workspace-vocabulary.ts";
import type { Studio } from "../state/studio.ts";
import { projectOf, Room, roomOf, sidebarGames, type ThreadsState, threadMeta } from "../state/threads.ts";

/** Opening `name` now reloads Live: it is the game on the stage and the one Live holds (`enterProject`). */
export function reloadsLive(threads: ThreadsState, name: string): boolean {
  const onStage = roomOf(threads) === Room.Build && projectOf(threads) === name;
  return onStage && threads.liveProject === name;
}

/** A game was opened, `startedAt` being when it was asked for. */
export function trackGameOpened(app: Studio, name: string, startedAt: number, reload: boolean): void {
  const { games } = app.library.getState();
  const at = Date.now();
  const index = sidebarGames(games, app.threads.getState().records).findIndex((game) => game.name === name);
  const opened = gameOpenedProperties({
    via: navNotes.take(at, NavVia.Other),
    game: games.find((game) => game.name === name) ?? null,
    index,
    startedAt,
    at,
    reload,
    ref: gameRef(name),
  });
  track(AnalyticsEvent.GameOpened, opened);
}

/** A game that would not open (main refused; its reason is only words for now). */
export function trackGameOpenFailed(): void {
  track(AnalyticsEvent.GameOpenFailed, { via: navNotes.take(Date.now(), NavVia.Other) });
}

/** The game a chat about to be selected belongs to, when selecting it moves to another game. */
export function gameEnteredBy(app: Studio, threadId: string): string | null {
  const threads = app.threads.getState();
  const record = threads.records.find((thread) => thread.id === threadId);
  const project = threadMeta(record).project;
  if (typeof project !== "string" || !project) return null;
  return project === projectOf(threads) && roomOf(threads) === Room.Build ? null : project;
}

/** A keyboard shortcut, and whether it found nothing to do. */
export function trackShortcut(key: ShortcutKey, didNothing = false): void {
  track(AnalyticsEvent.ShortcutUsed, { key, did_nothing: didNothing });
}

/** ⌘K search opened. */
export function trackSearchOpened(app: Studio, via: SearchVia): void {
  track(AnalyticsEvent.GameSearchOpened, { via, games_bucket: countBucket(app.library.getState().games.length) });
}

/** The way a sidebar press leads home or into a game, for the screen it brings up. */
const NAV_VIA: Partial<Record<NavItem, NavVia>> = {
  [NavItem.Home]: NavVia.Wordmark,
  [NavItem.NewGame]: NavVia.NewGame,
  [NavItem.GamesPlus]: NavVia.GamesPlus,
  [NavItem.Harness]: NavVia.Sidebar,
};

/** A sidebar press: counted, and noted for the home or game it brings up. */
export function trackNavClicked(app: Studio, item: NavItem, side: { play: boolean; compact: boolean }): void {
  track(AnalyticsEvent.NavClicked, { item, mode: side.play ? PlayMode.Play : PlayMode.Create, compact: side.compact });
  const via = NAV_VIA[item];
  if (via) noteNav(via);
  if (item === NavItem.Search) trackSearchOpened(app, SearchVia.Sidebar);
}
