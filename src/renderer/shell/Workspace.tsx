import type { JSX } from "react";
import { memo, useCallback, useMemo } from "react";
import { t } from "../../shared/i18n.ts";
import { noteNav, noteStageSwitch } from "../analytics/workspace-trackers.ts";
import { trackGameManaged } from "../analytics/workspace-track.ts";
import { ActionOutcome, GameAction, ManageVia, NavVia, StageSwitchVia } from "../analytics/workspace-vocabulary.ts";
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
import { RemixLayer, useCoveredByRemix } from "./RemixLayer.tsx";
import type { WorkspaceProps } from "./use-shell.ts";
import { WorkspaceStage } from "./WorkspaceStage.tsx";

/** The chat column beside the stage (a game's build stage, or Studio's review), with home over both. */
export const Workspace = memo(function Workspace(props: WorkspaceProps): JSX.Element {
  const { chrome } = props;
  // Plugins or Play is up in its place.
  const away = chrome.workspaceCovered;
  const activeThread = useThreads(activeThreadOf);
  const underHome = useCoveredByHome();
  const underRemix = useCoveredByRemix();
  const covered = underHome || underRemix;
  return (
    <div
      className="studio-workspace absolute inset-0"
      inert={away}
      style={{ visibility: away ? "hidden" : "visible", opacity: away ? 0 : 1 }}
    >
      <div className="relative flex min-h-0 min-w-0 flex-col" inert={covered}>
        <BootstrapGate
          failed={({ error, retry, retrying }) => (
            <LoadFailed
              message={t("Could not load Studio.")}
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
      <HomeLayer app={props.app} dialogs={props.dialogs} chrome={chrome} handoff={props.handoff} under={underRemix} />
      <RemixLayer sidebarHidden={chrome.sidebarHidden} onToggleSidebar={chrome.toggleSidebar} />
    </div>
  );
});

/** A chat link to the stage, named for usage analytics before it moves the stage. */
const chatLink = (show: () => void) => (): void => {
  noteStageSwitch(StageSwitchVia.ChatLink);
  show();
};

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
      const game = app.library.getState().games.find((known) => known.name === name) ?? null;
      const renamed = (outcome: ActionOutcome, failure?: unknown): void =>
        trackGameManaged(GameAction.Renamed, ManageVia.ChatHeader, outcome, game, failure);
      void app.saveGame(name, { title }).then(
        () => renamed(ActionOutcome.Ok),
        (error: unknown) => {
          renamed(ActionOutcome.Failed, error);
          notifyProblem(notify)(error);
        },
      );
    },
    [app, notify],
  );
  const shows = useMemo(
    () => ({
      live: chatLink(views.showLive),
      assets: chatLink(() => views.chooseStageView(StageView.Assets)),
      builds: chatLink(() => views.chooseStageView(StageView.Builds)),
    }),
    [views],
  );
  const newGame = useCallback(() => {
    noteNav(NavVia.Chat);
    navigation.newGame();
  }, [navigation]);
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
      onNewGame={newGame}
      onShowLive={shows.live}
      onShowAssets={shows.assets}
      onShowBuilds={shows.builds}
      onOpenStudio={navigation.enterStudio}
      onNotice={notify}
      onSend={app.send}
      composer={chat.composer}
    />
  );
}
