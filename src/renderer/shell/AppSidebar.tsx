import type { JSX } from "react";
import { useMemo } from "react";
import type { AppDialogs as Dialogs } from "../panels/AppDialogs.tsx";
import { feedbackAbout } from "../feedback-about.ts";
import { BootstrapGate } from "../panels/BootstrapGate.tsx";
import { Sidebar } from "../panels/Sidebar.tsx";
import { useLaunch, usePlugins, useSidebarLibrary, useThreadsView, useUpdate } from "../state/hooks.ts";
import { launchInSidebar } from "../state/launch.ts";
import { pluginUpdates } from "../state/plugins.ts";
import type { Studio } from "../state/studio.ts";
import { busyThreadIds, Room } from "../state/threads.ts";
import { notifyProblem, ToastTone } from "../state/toasts.ts";
import { openPluginsAt } from "../ui/ComposerAddMenu.tsx";
import { LoadFailed } from "../ui/LoadFailed.tsx";
import type { Notifications } from "../use-notifications.ts";
import { problemWords } from "../words.ts";
import { useCoveredByRemix } from "./RemixLayer.tsx";
import type { Navigation } from "./use-navigation.ts";
import type { ShellChrome } from "./use-shell-chrome.ts";

const SIDEBAR_PANE = "h-full border-r border-line bg-base px-3 pt-12";

/** The sidebar: games, chats and notifications, behind the bootstrap's own loading and failure. */
export function AppSidebar({
  app,
  chrome,
  dialogs,
  navigation,
  notices,
  welcoming,
  covered = false,
}: {
  app: Studio;
  chrome: ShellChrome;
  dialogs: Dialogs;
  navigation: Navigation;
  notices: Notifications;
  welcoming: boolean;
  /** Something modal is over it (a game playing in Play): shown, but out of reach. */
  covered?: boolean;
}): JSX.Element {
  const { records: threads, status: threadStatus, activeThreadId, activeThread, project, room } = useThreadsView();
  const launch = useLaunch((s) => s.launch);
  const atHome = room === Room.Home && !launch;
  const { games, building, stagedCount } = useSidebarLibrary();
  // A game home is starting has one row: a placeholder until it is made and listed, then its own.
  const launching = useMemo(() => launchInSidebar(launch, games), [launch, games]);
  const update = useUpdate((s) => s.ready);
  const pluginList = usePlugins((s) => s.list);
  const pluginIndex = usePlugins((s) => s.index);
  const waitingUpdates = useMemo(() => pluginUpdates(pluginList, pluginIndex), [pluginList, pluginIndex]);
  const updatingPlugins = usePlugins((s) => s.updating);
  const busyThreads = useMemo(() => busyThreadIds(threadStatus), [threadStatus]);
  const { pluginsOpen } = chrome;
  // A remix Create shows is the selected row; nothing else is.
  const remixing = useCoveredByRemix();
  const unselected = pluginsOpen || remixing;
  const hidden = !chrome.sidebarVisible || welcoming;
  const notifyFailure = notifyProblem(app.notify);
  const restartToUpdate = (): Promise<boolean> =>
    app.api.restartToUpdate().catch((error: unknown) => {
      notifyFailure(error);
      return false;
    });
  const downloadUpdate = (): void => {
    void app.api.openUpdateDownload().catch(notifyFailure);
  };
  const updatePlugins = (skipped: ReadonlySet<string>): void => {
    // One cause (no connection) refuses every update alike: it is said once.
    void app.plugins.updateAll(skipped).then((failures) => {
      for (const words of new Set(failures.map(problemWords))) app.notify(words, ToastTone.Error);
    });
  };
  return (
    <aside className="studio-sidebar" inert={hidden || covered} aria-hidden={hidden}>
      <BootstrapGate
        failed={({ error, retry, retrying }) => (
          <div className={SIDEBAR_PANE}>
            <LoadFailed
              what="games and chats"
              error={error ?? undefined}
              onRetry={retry}
              retrying={retrying}
              className="text-ink-2"
              detailClassName="mt-2 break-words"
            />
          </div>
        )}
      >
        <Sidebar
          onSearch={() => dialogs.dispatch({ type: "search" })}
          notices={notices.visible}
          onOpenNotice={notices.open}
          onReadNotices={notices.readAll}
          onClearNotices={notices.clear}
          onToggle={chrome.toggleSidebar}
          onFeedback={() =>
            dialogs.dispatch({ type: "feedback", about: feedbackAbout({ activeThread, pluginsOpen, games }) })
          }
          pluginsOpen={pluginsOpen}
          onPlugins={chrome.openPlugins}
          playOpen={chrome.playOpen}
          onPlayMode={chrome.setPlayOpen}
          onSettings={() => dialogs.openSettings()}
          stagedCount={stagedCount}
          threads={threads}
          games={games}
          activeThreadId={unselected ? null : activeThreadId}
          activeProject={unselected || room === Room.Home ? null : project}
          atHome={atHome && !unselected}
          onHome={navigation.goHome}
          launching={launching}
          building={building}
          busyThreads={busyThreads}
          threadStatus={threadStatus}
          onNewGame={navigation.newGame}
          onSelectThread={navigation.selectThread}
          onSelectGame={navigation.selectGame}
          onShowRemix={navigation.showRemix}
          onRenameGame={(game) => dialogs.dispatch({ type: "game", kind: "rename", game })}
          onPinGame={(game) => {
            void app.saveGame(game.name, { pinned: !game.pinned }).catch(notifyFailure);
          }}
          onDeleteGame={(game) => dialogs.dispatch({ type: "game", kind: "delete", game })}
          onChangeCover={(game) => dialogs.dispatch({ type: "game", kind: "cover", game })}
          update={update}
          onRestartToUpdate={restartToUpdate}
          onDownloadUpdate={downloadUpdate}
          pluginUpdates={waitingUpdates}
          updatingPlugins={updatingPlugins}
          onUpdatePlugins={updatePlugins}
          onOpenPlugin={openPluginsAt}
        />
      </BootstrapGate>
    </aside>
  );
}
