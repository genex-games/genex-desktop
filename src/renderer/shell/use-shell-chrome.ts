/**
 * The shell's chrome: the compact drawer, Plugins or Create › Items over the workspace, the sidebar
 * toggle and the chat's width as a CSS variable.
 */
import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../shared/i18n.ts";
import { track } from "../analytics/client.ts";
import { AnalyticsEvent } from "../analytics/events.ts";
import { PlayMode, PlayModeVia, SidebarVia } from "../analytics/workspace-vocabulary.ts";
import type { AppDialogs as Dialogs } from "../panels/AppDialogs.tsx";
import { chatWidthOf, sidebarToggled } from "../state/layout.ts";
import type { Studio } from "../state/studio.ts";
import { OPEN_PLAY_EVENT } from "../play/open-play.ts";
import { OPEN_PLUGINS_EVENT } from "../ui/ComposerAddMenu.tsx";

const COMPACT = "(max-width: 900px)";
/** The sidebar toggles' labels. */
export const SIDEBAR_TOGGLE = { Show: t("Show sidebar"), Hide: t("Hide sidebar") } as const;
/** What a sidebar toggle does, as its `data-sidebar-toggle`: focus moves find the toggles by it. */
export const SidebarToggle = { Show: "show", Hide: "hide" } as const;
export type SidebarToggle = (typeof SidebarToggle)[keyof typeof SidebarToggle];

/** Focus the sidebar toggle that does `toggle`, once the toggle it replaced is gone. */
function focusSidebarToggle(toggle: SidebarToggle): void {
  requestAnimationFrame(() =>
    (document.querySelector(`[data-sidebar-toggle="${toggle}"]`) as HTMLElement | null)?.focus(),
  );
}

/** Whether the window is narrow (the sidebar is a drawer), and whether that drawer is open. */
function useCompactWindow() {
  const [compactWindow, setCompactWindow] = useState(() => window.matchMedia(COMPACT).matches);
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(COMPACT);
    const change = () => {
      setCompactWindow(media.matches);
      setDrawerOpen(false);
    };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return { compactWindow, drawerOpen, setDrawerOpen };
}

/**
 * The chat's width as the shell's `--chat-width`, set from the layout store before paint. A drag
 * moves it on every pointer move; writing the variable directly keeps that from re-rendering
 * the whole shell.
 */
export function useChatWidthVariable(shell: RefObject<HTMLDivElement | null>, app: Studio): void {
  useLayoutEffect(() => {
    const apply = (width: number): void => shell.current?.style.setProperty("--chat-width", `${width}px`);
    apply(chatWidthOf(app.layout.getState()));
    return app.layout.subscribe((state) => apply(chatWidthOf(state)));
  }, [app, shell]);
}

/**
 * Plugins opens over the workspace, from the sidebar or from a window event naming a plugin;
 * `leaveOthers` closes Play and Create › Items on the way.
 */
function usePluginsRoom(dialogs: Dialogs, setDrawerOpen: (open: boolean) => void, leaveOthers: () => void) {
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [setupPlugin, setSetupPlugin] = useState<string | undefined>();
  useEffect(() => {
    const open = (event: Event) => {
      setSetupPlugin((event as CustomEvent<{ plugin?: string }>).detail?.plugin);
      dialogs.dispatch({ type: "close-settings" });
      leaveOthers();
      setPluginsOpen(true);
      setDrawerOpen(false);
    };
    window.addEventListener(OPEN_PLUGINS_EVENT, open);
    return () => window.removeEventListener(OPEN_PLUGINS_EVENT, open);
  }, [dialogs.dispatch, setDrawerOpen, leaveOthers]);
  const openPlugins = useCallback(() => {
    setSetupPlugin(undefined);
    leaveOthers();
    setPluginsOpen(true);
    setDrawerOpen(false);
  }, [setDrawerOpen, leaveOthers]);
  return { pluginsOpen, setPluginsOpen, setupPlugin, openPlugins };
}

/**
 * The sidebar's toggle, which puts focus on the toggle that replaces the one pressed, and Escape
 * closing the compact drawer. A button press is `toggleSidebar`; ⌘B says so with `toggleSidebarFrom`.
 */
function useSidebarToggle(
  app: Studio,
  {
    compactWindow,
    drawerOpen,
    setDrawerOpen,
    sidebarVisible,
  }: {
    compactWindow: boolean;
    drawerOpen: boolean;
    setDrawerOpen: (update: boolean | ((open: boolean) => boolean)) => void;
    sidebarVisible: boolean;
  },
) {
  const toggleSidebarFrom = useCallback(
    (via: SidebarVia) => {
      if (compactWindow) setDrawerOpen((open) => !open);
      else app.layout.setState((s) => sidebarToggled(s), true);
      track(AnalyticsEvent.SidebarToggled, { visible: !sidebarVisible, via, compact: compactWindow });
      focusSidebarToggle(sidebarVisible ? SidebarToggle.Show : SidebarToggle.Hide);
    },
    [app, compactWindow, sidebarVisible, setDrawerOpen],
  );
  const toggleSidebar = useCallback(() => toggleSidebarFrom(SidebarVia.Button), [toggleSidebarFrom]);
  /** Escape in a compact window: close the drawer; false when it was not open. */
  const closeDrawer = useCallback((): boolean => {
    if (!compactWindow || !drawerOpen) return false;
    setDrawerOpen(false);
    focusSidebarToggle(SidebarToggle.Show);
    return true;
  }, [compactWindow, drawerOpen, setDrawerOpen]);
  return { toggleSidebar, toggleSidebarFrom, closeDrawer };
}

/** The setters Play's switch closes and opens rooms with. */
interface RoomSetters {
  setPlayOpen: (open: boolean) => void;
  setPluginsOpen: (open: boolean) => void;
  setItemsOpen: (open: boolean) => void;
}

/**
 * Play or Create, from the sidebar's switch. Play closes Plugins and Items; the drawer stays. A
 * switch the person asked for names its `via`, and counts when it changes the side. Another place
 * asking for Play (the Credits tab's invite) brings it up over Plugins.
 */
function useChoosePlay(playOpen: boolean, { setPlayOpen, setPluginsOpen, setItemsOpen }: RoomSetters) {
  const playNow = useRef(playOpen);
  playNow.current = playOpen;
  const choosePlay = useCallback(
    (play: boolean, via?: PlayModeVia) => {
      if (play) {
        setPluginsOpen(false);
        setItemsOpen(false);
      }
      if (via && play !== playNow.current)
        track(AnalyticsEvent.PlayModeSwitched, { to: play ? PlayMode.Play : PlayMode.Create, via });
      setPlayOpen(play);
    },
    [setPlayOpen, setPluginsOpen, setItemsOpen],
  );
  useEffect(() => {
    const open = () => choosePlay(true, PlayModeVia.OpenPlayEvent);
    window.addEventListener(OPEN_PLAY_EVENT, open);
    return () => window.removeEventListener(OPEN_PLAY_EVENT, open);
  }, [choosePlay]);
  return choosePlay;
}

/**
 * The shell's chrome: the compact drawer, Plugins or Play over the workspace, and the sidebar toggle,
 * which puts focus on the toggle that replaces the one pressed.
 */
export function useShellChrome(app: Studio, dialogs: Dialogs, sidebarOpen: boolean) {
  const { compactWindow, drawerOpen, setDrawerOpen } = useCompactWindow();
  // Play is the sidebar's other side: launch opens Create (home), and any way into Create leaves it.
  const [playOpen, setPlayOpen] = useState(false);
  // Create › Items is a room like Plugins: either one, never both (marketplace plan 10.3).
  const [itemsOpen, setItemsOpen] = useState(false);
  const leaveForPlugins = useCallback(() => {
    setItemsOpen(false);
    setPlayOpen(false);
  }, []);
  const plugins = usePluginsRoom(dialogs, setDrawerOpen, leaveForPlugins);
  const { setPluginsOpen } = plugins;
  const sidebarVisible = compactWindow ? drawerOpen : sidebarOpen;
  const closeOverlays = useCallback(() => {
    setPluginsOpen(false);
    setItemsOpen(false);
    setPlayOpen(false);
    setDrawerOpen(false);
  }, [setPluginsOpen, setDrawerOpen]);
  /**
   * Create › Items, from its sidebar row: over the workspace, in Plugins' place. Pressed again while it
   * is open, the tab on show is read again (once its last read is old); opening it reads it anyway.
   */
  const openItems = useCallback(() => {
    if (itemsOpen) void app.items.refresh();
    setPluginsOpen(false);
    setPlayOpen(false);
    setItemsOpen(true);
    setDrawerOpen(false);
  }, [app, itemsOpen, setPluginsOpen, setDrawerOpen]);
  const choosePlay = useChoosePlay(playOpen, { setPlayOpen, setPluginsOpen, setItemsOpen });
  const { toggleSidebar, toggleSidebarFrom, closeDrawer } = useSidebarToggle(app, {
    compactWindow,
    drawerOpen,
    setDrawerOpen,
    sidebarVisible,
  });
  const { pluginsOpen, setupPlugin, openPlugins } = plugins;
  return useMemo(
    () => ({
      pluginsOpen,
      setPluginsOpen,
      setupPlugin,
      openPlugins,
      /** Create › Items is up in place of the workspace. */
      itemsOpen,
      setItemsOpen,
      openItems,
      /** Play's dashboard is up in place of the workspace. */
      playOpen,
      setPlayOpen: choosePlay,
      /** Something covers the workspace (Plugins, Items or Play): it is hidden and inert. */
      workspaceCovered: pluginsOpen || itemsOpen || playOpen,
      compactWindow,
      setDrawerOpen,
      sidebarVisible,
      /** The compact drawer is open over the workspace. */
      drawerCovers: compactWindow && drawerOpen,
      /** The chat and Plugins headers show their own sidebar toggle. */
      sidebarHidden: !sidebarVisible || compactWindow,
      closeOverlays,
      toggleSidebar,
      /** The sidebar toggled by something other than its buttons (⌘B). */
      toggleSidebarFrom,
      closeDrawer,
    }),
    [
      pluginsOpen,
      setPluginsOpen,
      setupPlugin,
      openPlugins,
      itemsOpen,
      openItems,
      playOpen,
      choosePlay,
      compactWindow,
      setDrawerOpen,
      sidebarVisible,
      drawerOpen,
      closeOverlays,
      toggleSidebar,
      toggleSidebarFrom,
      closeDrawer,
    ],
  );
}

/** The chrome the shell's hooks and parts share. */
export type ShellChrome = ReturnType<typeof useShellChrome>;
