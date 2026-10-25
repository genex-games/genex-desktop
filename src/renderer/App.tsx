/**
 * Shared sidebar and chat; the active conversation selects the game stage or Studio review.
 *
 * App owns only its UI: the compact drawer, which room is up, the dialogs. What the studio knows
 * — games, conversations, the log, engines, plugins — is in the stores (`state/`), fed by one
 * subscription that is wired before React mounts. The shell's hooks and parts live in `shell/`:
 * `useShell` wires chrome, navigation, stage views, notifications and the keyboard; `AppSidebar`,
 * `Workspace` and `WorkspaceStage` draw them.
 *
 * App reads the stores through the grouped views of `state/hooks.ts`. What changes many times a
 * second is read by the leaf that shows it, not here, so it never re-renders the whole shell: the
 * chat's width (a CSS variable set from the layout store), agent screens (the stage and the
 * chat's build line), toasts and the plugin list (`shell/store-leaves.tsx`). The log's feed stays
 * here: the notifications App draws on its own root read it.
 */
import type { JSX } from "react";
import { lazy, Suspense, useEffect, useRef } from "react";
import { t } from "../shared/i18n.ts";
import { ColorTweakerHost } from "./appearance/tweaker/ColorTweakerHost.tsx";
import { Onboarding } from "./onboarding/Onboarding.tsx";
import { AppDialogs } from "./panels/AppDialogs.tsx";
import { GenexPromo } from "./panels/GenexPromo.tsx";
import { nativeViewsUp } from "./play/play-model.ts";
import { AvatarWelcome } from "./play/AvatarWelcome.tsx";
import { PlayPages } from "./play/PlayPages.tsx";
import { PlayViewerLayer } from "./play/PlayViewerLayer.tsx";
import { useGuestSignIn } from "./play/use-genex-sign-in.ts";
import { usePlayRemixes } from "./play/use-play-remixes.ts";
import { AppSidebar } from "./shell/AppSidebar.tsx";
import { PluginsRoom, Toasts } from "./shell/store-leaves.tsx";
import { useChatWidthVariable } from "./shell/use-shell-chrome.ts";
import { noticeState } from "./shell/use-shell-notices.ts";
import { useShell } from "./shell/use-shell.ts";
import { Workspace } from "./shell/Workspace.tsx";
import { useEngines, usePlay, useUpdate } from "./state/hooks.ts";
import { CodexLoginPanel } from "./ui/CodexLoginPanel.tsx";

/** Create › Items, a room over the workspace: loaded the first time it opens, as most sessions never do. */
const ItemsPage = lazy(() => import("./panels/items/ItemsPage.tsx").then((room) => ({ default: room.ItemsPage })));

/** `data-room` while Plugins covers the workspace. */
const PLUGINS_ROOM = "plugins";
/** `data-room` while Create › Items covers it. */
const ITEMS_ROOM = "items";
/** `data-room` while Play's dashboard covers it. */
const PLAY_ROOM = "play";

/** The room `data-room` names: Plugins, Items or Play over the workspace, else the open conversation's. */
const roomName = (chrome: { pluginsOpen: boolean; itemsOpen: boolean; playOpen: boolean }, room: string): string => {
  if (chrome.pluginsOpen) return PLUGINS_ROOM;
  if (chrome.itemsOpen) return ITEMS_ROOM;
  return chrome.playOpen ? PLAY_ROOM : room;
};

/** What covers the workspace when it is up: Plugins, Create › Items or Play. */
function Rooms({
  app,
  chrome,
  navigation,
  project,
}: Pick<ReturnType<typeof useShell>, "app" | "chrome" | "navigation"> & { project: string | null }): JSX.Element {
  return (
    <>
      {chrome.pluginsOpen && (
        <PluginsRoom
          setupPlugin={chrome.setupPlugin}
          project={project}
          onPluginsRefresh={app.plugins.refresh}
          onIndexRefresh={app.plugins.refreshIndex}
          onBack={() => chrome.setPluginsOpen(false)}
          sidebarHidden={chrome.sidebarHidden}
          onToggleSidebar={chrome.toggleSidebar}
        />
      )}
      {chrome.itemsOpen && (
        <Suspense fallback={null}>
          <ItemsPage
            sidebarHidden={chrome.sidebarHidden}
            onToggleSidebar={chrome.toggleSidebar}
            onOpenGame={navigation.enterProject}
            onNewGame={navigation.newGame}
          />
        </Suspense>
      )}
      {chrome.playOpen && !chrome.pluginsOpen && <PlayPages chrome={chrome} onNewGame={navigation.newGame} />}
    </>
  );
}

export function App(): JSX.Element {
  const shell = useRef<HTMLDivElement>(null);
  const { app, dialogs, welcoming, threads, chrome, navigation, views, notices, firstAsks, welcome, chat, handoff } =
    useShell();
  const { activeThreadId, room, project } = threads;
  const engines = useEngines((s) => s.list);
  const updateReady = useUpdate((s) => s.ready !== null);
  useChatWidthVariable(shell, app);
  usePlayRemixes(navigation, chrome);
  useGuestSignIn();
  // While Play's game or its menu lies over the window, no drag region takes the pointer from them (play.css).
  const playNative = usePlay((s) => nativeViewsUp(s.viewer));
  // A game playing in Play is modal: nothing under it takes the keyboard or a click.
  const viewing = usePlay((s) => s.viewer !== null);
  useEffect(() => {
    const refresh = () => {
      void app.engines.refresh();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [app]);
  return (
    <div
      ref={shell}
      data-studio-state
      data-room={roomName(chrome, room)}
      data-active-thread={activeThreadId ?? ""}
      data-project={project ?? ""}
      data-sidebar-open={chrome.sidebarVisible}
      data-compact={chrome.compactWindow}
      data-notices={noticeState(notices)}
      data-update-ready={updateReady || undefined}
      data-play-native={playNative || undefined}
      className="studio-shell h-full bg-canvas"
    >
      <AppSidebar
        app={app}
        chrome={chrome}
        dialogs={dialogs}
        navigation={navigation}
        notices={notices}
        welcoming={welcoming}
        covered={viewing}
      />
      {chrome.drawerCovers && (
        <button
          type="button"
          className="studio-sidebar-backdrop"
          aria-label={t("Close sidebar")}
          onClick={chrome.toggleSidebar}
        />
      )}
      <main className="relative min-h-0 min-w-0" inert={chrome.drawerCovers || welcoming || viewing}>
        <Workspace
          app={app}
          chrome={chrome}
          navigation={navigation}
          views={views}
          dialogs={dialogs}
          chat={chat}
          handoff={handoff}
        />
        <Rooms app={app} chrome={chrome} navigation={navigation} project={project} />
      </main>
      <AppDialogs
        dialogs={dialogs}
        firstAsks={firstAsks}
        onEnterProject={navigation.enterProject}
        onSelectThread={navigation.selectThread}
        onSelectGame={navigation.selectGame}
        onRemoveGame={navigation.removeGame}
      />
      {welcoming && (
        <Onboarding
          engines={engines}
          onEnginesRefresh={app.engines.refresh}
          onReady={welcome.readyAfterWelcome}
          onFinish={welcome.finishWelcome}
        />
      )}
      <GenexPromo welcoming={welcoming} pluginsOpen={chrome.workspaceCovered} project={project} />
      <AvatarWelcome blocked={welcoming} />
      <PlayViewerLayer />
      <Toasts />
      <CodexLoginPanel />
      <ColorTweakerHost />
    </div>
  );
}
