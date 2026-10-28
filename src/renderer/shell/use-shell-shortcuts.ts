import type { RefObject } from "react";
import { useMemo } from "react";
import { HarnessOpenedVia, noteHarnessOpening } from "../analytics/plugins-harness.ts";
import { noteNav } from "../analytics/workspace-trackers.ts";
import { NavVia, SearchVia, ShortcutKey, SidebarVia } from "../analytics/workspace-vocabulary.ts";
import type { AppDialogs as Dialogs } from "../panels/AppDialogs.tsx";
import { useRailView } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { Room, railThreadIds, roomOf } from "../state/threads.ts";
import type { PromptBarHandle } from "../ui/PromptBar.tsx";
import { useAppShortcuts } from "../use-app-shortcuts.ts";
import { trackSearchOpened, trackShortcut } from "./nav-analytics.ts";
import type { Navigation } from "./use-navigation.ts";
import type { ShellChrome } from "./use-shell-chrome.ts";

/** The app's keyboard, over the rail's order; each shortcut is counted, with whether it found nothing to do. */
export function useShellShortcuts(
  dialogs: Dialogs,
  chrome: ShellChrome,
  navigation: Navigation,
  composer: RefObject<PromptBarHandle | null>,
): void {
  const { records: threads, activeThreadId, games } = useRailView();
  const railIds = useMemo(() => railThreadIds(threads, games), [threads, games]);
  useAppShortcuts({
    blocked: dialogs.state.picked !== null,
    search: () => {
      trackShortcut(ShortcutKey.K);
      trackSearchOpened(studio(), SearchVia.Shortcut);
      dialogs.dispatch({ type: "search" });
    },
    toggleSidebar: () => {
      trackShortcut(ShortcutKey.B);
      chrome.toggleSidebarFrom(SidebarVia.Shortcut);
    },
    closeDrawer: chrome.closeDrawer,
    newGame: () => {
      trackShortcut(ShortcutKey.N);
      noteNav(NavVia.Shortcut);
      navigation.newGame();
    },
    returnToGame: () => {
      noteNav(NavVia.Shortcut);
      trackShortcut(ShortcutKey.One, !navigation.returnToGame());
    },
    enterStudio: () => {
      // Only a Harness room that comes up reads the note; one already up would keep it for a later visit.
      if (roomOf(studio().threads.getState()) !== Room.Studio) noteHarnessOpening(HarnessOpenedVia.Shortcut);
      trackShortcut(ShortcutKey.Two, !navigation.enterStudio());
    },
    focusGame: () => {
      noteNav(NavVia.Shortcut);
      trackShortcut(ShortcutKey.I, !navigation.returnToGame());
      requestAnimationFrame(() => composer.current?.focus());
    },
    stepRail: (step) => {
      const index = activeThreadId ? railIds.indexOf(activeThreadId) : -1;
      const target = railIds[Math.max(0, Math.min(railIds.length - 1, index + step))];
      trackShortcut(step === 1 ? ShortcutKey.RailDown : ShortcutKey.RailUp, !target || target === activeThreadId);
      if (!target) return;
      noteNav(NavVia.Rail);
      navigation.selectThread(target);
    },
  });
}
