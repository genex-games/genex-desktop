import type { JSX } from "react";
import { memo, useCallback } from "react";
import { BootstrapGate } from "../panels/BootstrapGate.tsx";
import { ChatPanel } from "../panels/ChatPanel.tsx";
import { ChatResizeHandle } from "../panels/ChatResizeHandle.tsx";
import { TerminalDock } from "../panels/TerminalDock.tsx";
import { StageView } from "../stage.ts";
import { useEngines, useLibrary, useThreads, useThreadsView } from "../state/hooks.ts";
import { activeThread as activeThreadOf, personFirstLabel, threadMeta } from "../state/threads.ts";
import { notifyProblem } from "../state/toasts.ts";
import { LoadFailed } from "../ui/LoadFailed.tsx";
import { HomeLayer, useCoveredByHome } from "./HomeScreen.tsx";
import type { WorkspaceProps } from "./use-shell.ts";
import { WorkspaceStage } from "./WorkspaceStage.tsx";

/** The chat column beside the stage (a game's build stage, or Studio's review), with home over both. */
export const Workspace = memo(function Workspace(props: WorkspaceProps): JSX.Element {
  const { chrome } = props;
  const { pluginsOpen } = chrome;
  const activeThread = useThreads(activeThreadOf);
  const covered = useCoveredByHome();
  return (
    <div
      className="studio-workspace absolute inset-0"
      inert={pluginsOpen}
      style={{ visibility: pluginsOpen ? "hidden" : "visible", opacity: pluginsOpen ? 0 : 1 }}
    >
      <div className="relative flex min-h-0 min-w-0 flex-col" inert={covered}>
        <BootstrapGate
          failed={({ error, retry, retrying }) => (
            <LoadFailed
              what="Studio"
              error={error ?? undefined}
              onRetry={retry}
              retrying={retrying}
              detailClassName="mt-2 break-words"
            />
          )}
        >
          <WorkspaceChat {...props} />
        </BootstrapGate>
        <TerminalDock
          project={threadMeta(activeThread).project ?? null}
          onReveal={() => {
            props.dialogs.dispatch({ type: "close-settings" });
            chrome.closeOverlays();
          }}
        />
        <ChatResizeHandle />
      </div>
      <WorkspaceStage app={props.app} chrome={chrome} navigation={props.navigation} views={props.views} />
      <HomeLayer app={props.app} dialogs={props.dialogs} chrome={chrome} handoff={props.handoff} />
    </div>
  );
});

/** The chat column's panel, fed by the open thread's history. */
function WorkspaceChat({ app, chrome, navigation, views, chat }: WorkspaceProps) {
  const { activeThreadId, activeThread, status: threadStatus } = useThreadsView();
  const engines = useEngines((s) => s.list);
  const activeStatus = (activeThreadId && threadStatus[activeThreadId]) || null;
  const personFirst = useThreads((s) => personFirstLabel(s, s.activeThreadId));
  const games = useLibrary((s) => s.games);
  const notify = app.notify;
  const saveGameTitle = useCallback(
    (name: string, title: string) => {
      void app.saveGame(name, { title }).catch(notifyProblem(notify));
    },
    [app, notify],
  );
  return (
    <ChatPanel
      loading={chat.loading}
      loadError={chat.history.error}
      onRetryLoad={chat.retry}
      sidebarHidden={chrome.sidebarHidden}
      onToggleSidebar={chrome.toggleSidebar}
      onEnginesRefresh={app.engines.refresh}
      events={chat.history.events}
      stateEvents={chat.history.stateEvents}
      history={chat.history}
      engines={engines}
      games={games}
      activeThread={activeThread}
      status={activeStatus?.status ?? ""}
      busySince={activeStatus?.since ?? null}
      personFirst={personFirst}
      firstAsk={chat.firstAsk}
      onRename={app.renameThread}
      onRenameGame={saveGameTitle}
      onNewGame={navigation.newGame}
      onShowLive={views.showLive}
      onShowAssets={() => views.chooseStageView(StageView.Assets)}
      onShowBuilds={() => views.chooseStageView(StageView.Builds)}
      onOpenStudio={navigation.enterStudio}
      onNotice={notify}
      onSend={app.send}
      composer={chat.composer}
    />
  );
}
