import { useCallback, useMemo } from "react";
import { noteNav } from "../analytics/workspace-trackers.ts";
import { NavVia } from "../analytics/workspace-vocabulary.ts";
import { useThreads } from "../state/hooks.ts";
import { remixReturnedTo, remixSetAside } from "../state/play.ts";
import type { Studio } from "../state/studio.ts";
import { returnTarget, Room, roomOf, studioThreadOf } from "../state/threads.ts";
import { withViewTransition } from "../ui/view-transition.ts";
import { gameEnteredBy, reloadsLive, trackGameOpened, trackGameOpenFailed } from "./nav-analytics.ts";
import type { ComposerHandoff } from "./use-composer-handoff.ts";
import type { ShellChrome } from "./use-shell-chrome.ts";

/** Leaving home or going back to it is one animated change; anything else switches at once. */
const fromHome = (app: Studio) => (select: () => void) => {
  if (roomOf(app.threads.getState()) === Room.Home) withViewTransition(select);
  else select();
};

/** The rooms over the workspace: left for it on the way somewhere, or left for the Play remix being made. */
function useRoomExits(app: Studio, chrome: ShellChrome) {
  const { setPluginsOpen, setItemsOpen, setPlayOpen, setDrawerOpen } = chrome;
  /** Leave Plugins, Items and Play for the workspace, and a remix being made for where the person is going. */
  const leaveRooms = useCallback(() => {
    setPluginsOpen(false);
    setItemsOpen(false);
    setPlayOpen(false);
    app.play.setState(remixSetAside, true);
  }, [app, setPluginsOpen, setItemsOpen, setPlayOpen]);
  /** Back to the Play remix being made, over Create. */
  const showRemix = useCallback(() => {
    setPluginsOpen(false);
    setItemsOpen(false);
    setPlayOpen(false);
    app.play.setState(remixReturnedTo, true);
    setDrawerOpen(false);
  }, [app, setPluginsOpen, setItemsOpen, setPlayOpen, setDrawerOpen]);
  return { leaveRooms, showRemix };
}

/**
 * Moving between conversations and games: each closes Plugins, Create › Items, Play and the drawer on
 * the way, and sets a Play remix being made aside (its sidebar row brings it back).
 */
export function useNavigation(app: Studio, chrome: ShellChrome, handoff: ComposerHandoff) {
  const { setDrawerOpen, closeOverlays } = chrome;
  const { leaveRooms, showRemix } = useRoomExits(app, chrome);
  const studioThread = useThreads(studioThreadOf);
  const selectThread = useCallback(
    (threadId: string) => {
      const startedAt = Date.now();
      const game = gameEnteredBy(app, threadId);
      fromHome(app)(() => {
        leaveRooms();
        app.selectThread(threadId);
      });
      if (game) trackGameOpened(app, game, startedAt, false);
      setDrawerOpen(false);
    },
    [app, leaveRooms, setDrawerOpen],
  );
  /** Home: no conversation open, and the composer that starts a new game. */
  const goHome = useCallback(() => {
    const atHome = roomOf(app.threads.getState()) === Room.Home;
    const go = () => {
      leaveRooms();
      app.goHome();
    };
    if (atHome) go();
    else withViewTransition(go);
    setDrawerOpen(false);
  }, [app, leaveRooms, setDrawerOpen]);
  /** Harness; false when there is none to open. */
  const enterStudio = useCallback((): boolean => {
    if (!studioThread) return false;
    selectThread(studioThread.id);
    return true;
  }, [studioThread, selectThread]);
  const { focusWhenOpen, focusOnly } = handoff;
  const enterProject = useCallback(
    (name: string, focusComposer = false): Promise<void> => {
      leaveRooms();
      const startedAt = Date.now();
      const reload = reloadsLive(app.threads.getState(), name);
      return app.enterProject(name, { open: fromHome(app) }).then((record) => {
        if (!record) {
          trackGameOpenFailed();
          return;
        }
        trackGameOpened(app, name, startedAt, reload);
        if (focusComposer) focusWhenOpen(record.id);
        setDrawerOpen(false);
      });
    },
    [app, leaveRooms, setDrawerOpen, focusWhenOpen],
  );
  /**
   * Back to the game chat last open, else the first game; `focusComposer` puts the cursor in it.
   * False when there is no game to go back to.
   */
  const returnToGame = useCallback(
    (focusComposer = false): boolean => {
      const { games } = app.library.getState();
      const target = returnTarget(app.threads.getState(), games);
      if (!target) {
        const first = games[0];
        if (!first) return false;
        void enterProject(first.name, focusComposer);
        return true;
      }
      if (focusComposer) focusOnly(target);
      selectThread(target);
      return true;
    },
    [app, selectThread, enterProject, focusOnly],
  );
  const selectGame = useCallback((name: string) => enterProject(name), [enterProject]);
  const removeGame = useCallback(
    async (name: string) => {
      // Deleting the game on the stage brings home up in its place.
      noteNav(NavVia.AfterDelete);
      if (await app.removeGame(name)) closeOverlays();
    },
    [app, closeOverlays],
  );
  /** New game is home, the wordmark's room, with the cursor in its composer (already there or not). */
  const newGame = useCallback(() => {
    goHome();
    requestAnimationFrame(() => handoff.homeComposer.current?.focus());
  }, [goHome, handoff.homeComposer]);
  return useMemo(
    () => ({
      selectThread,
      enterStudio,
      returnToGame,
      enterProject,
      selectGame,
      removeGame,
      newGame,
      goHome,
      showRemix,
    }),
    [selectThread, enterStudio, returnToGame, enterProject, selectGame, removeGame, newGame, goHome, showRemix],
  );
}

/** The navigation the shell's hooks and parts share. */
export type Navigation = ReturnType<typeof useNavigation>;
