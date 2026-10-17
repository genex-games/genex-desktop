/**
 * The shell's chrome: the compact drawer, Plugins over the workspace, the sidebar toggle and the
 * chat's width as a CSS variable.
 */
import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useLayoutEffect, useState } from "react";
import type { AppDialogs as Dialogs } from "../panels/AppDialogs.tsx";
import { chatWidthOf, sidebarToggled } from "../state/layout.ts";
import type { Studio } from "../state/studio.ts";
import { OPEN_PLAY_EVENT } from "../play/open-play.ts";
import { OPEN_PLUGINS_EVENT } from "../ui/ComposerAddMenu.tsx";

const COMPACT = "(max-width: 900px)";
/** The sidebar toggles' labels. Smoke runners and focus moves find the toggles by them. */
export const SIDEBAR_TOGGLE = { Show: "Show sidebar", Hide: "Hide sidebar" } as const;

/** Focus the sidebar toggle with this label, once the toggle it replaced is gone. */
function focusSidebarToggle(label: string): void {
  requestAnimationFrame(() => (document.querySelector(`[aria-label="${label}"]`) as HTMLElement | null)?.focus());
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

/** Plugins opens over the workspace, from the sidebar or from a window event naming a plugin. */
function usePluginsRoom(dialogs: Dialogs, setDrawerOpen: (open: boolean) => void, leavePlay: () => void) {
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [setupPlugin, setSetupPlugin] = useState<string | undefined>();
  useEffect(() => {
    const open = (event: Event) => {
      setSetupPlugin((event as CustomEvent<{ plugin?: string }>).detail?.plugin);
      dialogs.dispatch({ type: "close-settings" });
      leavePlay();
      setPluginsOpen(true);
      setDrawerOpen(false);
    };
    window.addEventListener(OPEN_PLUGINS_EVENT, open);
    return () => window.removeEventListener(OPEN_PLUGINS_EVENT, open);
  }, [dialogs.dispatch, setDrawerOpen, leavePlay]);
  const openPlugins = useCallback(() => {
    setSetupPlugin(undefined);
    leavePlay();
    setPluginsOpen(true);
    setDrawerOpen(false);
  }, [setDrawerOpen, leavePlay]);
  return { pluginsOpen, setPluginsOpen, setupPlugin, openPlugins };
}

/**
 * The shell's chrome: the compact drawer, Plugins or Play over the workspace, and the sidebar toggle,
 * which puts focus on the toggle that replaces the one pressed.
 */
export function useShellChrome(app: Studio, dialogs: Dialogs, sidebarOpen: boolean) {
  const { compactWindow, drawerOpen, setDrawerOpen } = useCompactWindow();
  // Play is the sidebar's other side: launch opens Create (home), and any way into Create leaves it.
  const [playOpen, setPlayOpen] = useState(false);
  const leavePlay = useCallback(() => setPlayOpen(false), []);
  const plugins = usePluginsRoom(dialogs, setDrawerOpen, leavePlay);
  const { setPluginsOpen } = plugins;
  const sidebarVisible = compactWindow ? drawerOpen : sidebarOpen;
  const closeOverlays = useCallback(() => {
    setPluginsOpen(false);
    setPlayOpen(false);
    setDrawerOpen(false);
  }, [setPluginsOpen, setDrawerOpen]);
  /** Play or Create, from the sidebar's switch. Play closes Plugins; the drawer stays. */
  const choosePlay = useCallback(
    (play: boolean) => {
      if (play) setPluginsOpen(false);
      setPlayOpen(play);
    },
    [setPluginsOpen],
  );
  // Another place asked for Play (the Credits tab's invite): it comes up over Plugins.
  useEffect(() => {
    const open = () => choosePlay(true);
    window.addEventListener(OPEN_PLAY_EVENT, open);
    return () => window.removeEventListener(OPEN_PLAY_EVENT, open);
  }, [choosePlay]);
  const toggleSidebar = useCallback(() => {
    if (compactWindow) setDrawerOpen((open) => !open);
    else app.layout.setState((s) => sidebarToggled(s), true);
    focusSidebarToggle(sidebarVisible ? SIDEBAR_TOGGLE.Show : SIDEBAR_TOGGLE.Hide);
  }, [app, compactWindow, sidebarVisible, setDrawerOpen]);
  /** Escape in a compact window: close the drawer; false when it was not open. */
  const closeDrawer = useCallback((): boolean => {
    if (!compactWindow || !drawerOpen) return false;
    setDrawerOpen(false);
    focusSidebarToggle(SIDEBAR_TOGGLE.Show);
    return true;
  }, [compactWindow, drawerOpen, setDrawerOpen]);
  const { pluginsOpen, setupPlugin, openPlugins } = plugins;
  return useMemo(
    () => ({
      pluginsOpen,
      setPluginsOpen,
      setupPlugin,
      openPlugins,
      /** Play's dashboard is up in place of the workspace. */
      playOpen,
      setPlayOpen: choosePlay,
      /** Something covers the workspace (Plugins or Play): it is hidden and inert. */
      workspaceCovered: pluginsOpen || playOpen,
      compactWindow,
      setDrawerOpen,
      sidebarVisible,
      /** The compact drawer is open over the workspace. */
      drawerCovers: compactWindow && drawerOpen,
      /** The chat and Plugins headers show their own sidebar toggle. */
      sidebarHidden: !sidebarVisible || compactWindow,
      closeOverlays,
      toggleSidebar,
      closeDrawer,
    }),
    [
      pluginsOpen,
      setPluginsOpen,
      setupPlugin,
      openPlugins,
      playOpen,
      choosePlay,
      compactWindow,
      setDrawerOpen,
      sidebarVisible,
      drawerOpen,
      closeOverlays,
      toggleSidebar,
      closeDrawer,
    ],
  );
}

/** The chrome the shell's hooks and parts share. */
export type ShellChrome = ReturnType<typeof useShellChrome>;
