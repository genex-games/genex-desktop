import type { JSX } from "react";
import { useMemo } from "react";
import { t } from "../../shared/i18n.ts";
import { trackedRestart, UpdateSurface } from "../analytics/events/launch.ts";
import { noteNav } from "../analytics/workspace-trackers.ts";
import { trackGameManaged } from "../analytics/workspace-track.ts";
import { ActionOutcome, GameAction, ManageVia, NavVia } from "../analytics/workspace-vocabulary.ts";
import type { AppDialogs as Dialogs } from "../panels/AppDialogs.tsx";
import { SettingsOpenedFrom } from "../settings-navigation.ts";
import type { GameProject } from "../types.ts";
import { feedbackAbout } from "../feedback-about.ts";
import { BootstrapGate } from "../panels/BootstrapGate.tsx";
import { Sidebar } from "../panels/Sidebar.tsx";
import { useLaunch, usePlugins, useSidebarLibrary, useThreadsView, useUpdate } from "../state/hooks.ts";
import { launchInSidebar } from "../state/launch.ts";
import { distinctFailures, pluginUpdates } from "../state/plugins.ts";
import type { Studio } from "../state/studio.ts";
import { busyThreadIds, Room } from "../state/threads.ts";
import { notifyProblem } from "../state/toasts.ts";
import { openPluginsAt } from "../ui/ComposerAddMenu.tsx";
import { LoadFailed } from "../ui/LoadFailed.tsx";
import type { Notifications } from "../use-notifications.ts";
import { trackNavClicked } from "./nav-analytics.ts";
import { useCoveredByRemix } from "./RemixLayer.tsx";
import type { Navigation } from "./use-navigation.ts";
import type { ShellChrome } from "./use-shell-chrome.ts";

const SIDEBAR_PANE = "h-full border-r border-line bg-base px-3 pt-12";

/** Pin or unpin a game from its menu, counted as it ends; a failure is said in the person's words. */
function pinGame(app: Studio, game: GameProject, notifyFailure: (error: unknown) => void): void {
  const action = game.pinned ? GameAction.Unpinned : GameAction.Pinned;
  void app.saveGame(game.name, { pinned: !game.pinned }).then(
    () => trackGameManaged(action, ManageVia.Menu, ActionOutcome.Ok, game),
    (error: unknown) => {
      trackGameManaged(action, ManageVia.Menu, ActionOutcome.Failed, game, error);
      notifyFailure(error);
    },
  );
}

/** The plugin updates waiting, whether Update plugins is installing them, and its press. */
function usePluginUpdates(app: Studio) {
  const pluginList = usePlugins((s) => s.list);
  const pluginIndex = usePlugins((s) => s.index);
  const waiting = useMemo(() => pluginUpdates(pluginList, pluginIndex), [pluginList, pluginIndex]);
  const updating = usePlugins((s) => s.updating);
  /** Install every waiting update but the unticked ones. */
  const update = (skipped: ReadonlySet<string>): void => {
    // One cause (no connection) refuses every update alike: it is said once, with its code.
    void app.plugins.updateAll(skipped).then((failures) => {
      for (const failure of distinctFailures(failures)) notifyProblem(app.notify)(failure);
    });
  };
  return { waiting, updating, update };
}

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
  const { games, building } = useSidebarLibrary();
  // A game home is starting has one row: a placeholder until it is made and listed, then its own.
  const launching = useMemo(() => launchInSidebar(launch, games), [launch, games]);
  const update = useUpdate((s) => s.ready);
  const plugins = usePluginUpdates(app);
  const busyThreads = useMemo(() => busyThreadIds(threadStatus), [threadStatus]);
  const { pluginsOpen, itemsOpen } = chrome;
  // A remix Create shows is the selected row; nothing else is.
  const remixing = useCoveredByRemix();
  const unselected = pluginsOpen || itemsOpen || remixing;
  const hidden = !chrome.sidebarVisible || welcoming;
  const notifyFailure = notifyProblem(app.notify);
  const restartToUpdate = (): Promise<boolean> =>
    trackedRestart(UpdateSurface.Sidebar, () => app.api.restartToUpdate()).catch((error: unknown) => {
      notifyFailure(error);
      return false;
    });
  const downloadUpdate = (): void => {
    void app.api.openUpdateDownload().catch(notifyFailure);
  };
  return (
    <aside className="studio-sidebar" inert={hidden || covered} aria-hidden={hidden}>
      <BootstrapGate
        failed={({ error, retry, retrying }) => (
          <div className={SIDEBAR_PANE}>
            <LoadFailed
              message={t("Could not load games and chats.")}
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
          itemsOpen={itemsOpen}
          onItems={chrome.openItems}
          playOpen={chrome.playOpen}
          onPlayMode={chrome.setPlayOpen}
          onNav={(item) => trackNavClicked(app, item, { play: chrome.playOpen, compact: chrome.compactWindow })}
          onSettings={() => dialogs.openSettings(undefined, null, SettingsOpenedFrom.Sidebar)}
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
          onSelectGame={(name) => {
            noteNav(NavVia.Sidebar);
            void navigation.selectGame(name);
          }}
          onShowRemix={navigation.showRemix}
          onRenameGame={(game) => dialogs.dispatch({ type: "game", kind: "rename", game })}
          onPinGame={(game) => pinGame(app, game, notifyFailure)}
          onDeleteGame={(game) => dialogs.dispatch({ type: "game", kind: "delete", game })}
          onChangeCover={(game) => dialogs.dispatch({ type: "game", kind: "cover", game })}
          update={update}
          onRestartToUpdate={restartToUpdate}
          onDownloadUpdate={downloadUpdate}
          pluginUpdates={plugins.waiting}
          updatingPlugins={plugins.updating}
          onUpdatePlugins={plugins.update}
          onOpenPlugin={openPluginsAt}
        />
      </BootstrapGate>
    </aside>
  );
}
