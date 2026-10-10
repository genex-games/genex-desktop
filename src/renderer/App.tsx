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
import { useEffect, useRef } from "react";
import { ColorTweakerHost } from "./appearance/tweaker/ColorTweakerHost.tsx";
import { Onboarding } from "./onboarding/Onboarding.tsx";
import { AppDialogs } from "./panels/AppDialogs.tsx";
import { GenexPromo } from "./panels/GenexPromo.tsx";
import { AppSidebar } from "./shell/AppSidebar.tsx";
import { PluginsRoom, Toasts } from "./shell/store-leaves.tsx";
import { useChatWidthVariable } from "./shell/use-shell-chrome.ts";
import { noticeState } from "./shell/use-shell-notices.ts";
import { useShell } from "./shell/use-shell.ts";
import { Workspace } from "./shell/Workspace.tsx";
import { useEngines, useUpdate } from "./state/hooks.ts";
import { CodexLoginPanel } from "./ui/CodexLoginPanel.tsx";

/** `data-room` while Plugins covers the workspace. */
const PLUGINS_ROOM = "plugins";

export function App(): JSX.Element {
  const shell = useRef<HTMLDivElement>(null);
  const { app, dialogs, welcoming, threads, chrome, navigation, views, notices, firstAsks, welcome, chat, handoff } =
    useShell();
  const { activeThreadId, room, project } = threads;
  const engines = useEngines((s) => s.list);
  const updateReady = useUpdate((s) => s.ready !== null);
  useChatWidthVariable(shell, app);
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
      data-room={chrome.pluginsOpen ? PLUGINS_ROOM : room}
      data-active-thread={activeThreadId ?? ""}
      data-project={project ?? ""}
      data-sidebar-open={chrome.sidebarVisible}
      data-compact={chrome.compactWindow}
      data-notices={noticeState(notices)}
      data-update-ready={updateReady || undefined}
      className="studio-shell h-full bg-canvas"
    >
      <AppSidebar
        app={app}
        chrome={chrome}
        dialogs={dialogs}
        navigation={navigation}
        notices={notices}
        welcoming={welcoming}
      />
      {chrome.drawerCovers && (
        <button
          type="button"
          className="studio-sidebar-backdrop"
          aria-label="Close sidebar"
          onClick={chrome.toggleSidebar}
        />
      )}
      <main className="relative min-h-0 min-w-0" inert={chrome.drawerCovers || welcoming}>
        <Workspace
          app={app}
          chrome={chrome}
          navigation={navigation}
          views={views}
          dialogs={dialogs}
          chat={chat}
          handoff={handoff}
        />
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
      <GenexPromo welcoming={welcoming} pluginsOpen={chrome.pluginsOpen} project={project} />
      <Toasts />
      <CodexLoginPanel />
      <ColorTweakerHost />
    </div>
  );
}
