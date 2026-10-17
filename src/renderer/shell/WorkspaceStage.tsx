import type { ComponentProps, JSX } from "react";
import { memo, useCallback } from "react";
import { BootstrapGate } from "../panels/BootstrapGate.tsx";
import { ReviewPanel } from "../panels/ReviewPanel.tsx";
import {
  useEngines,
  useEventLog,
  useLayoutView,
  useSessionView,
  useStageLibrary,
  useStageThreads,
} from "../state/hooks.ts";
import { stagedCounted } from "../state/library.ts";
import { Room } from "../state/threads.ts";
import { notifyProblem } from "../state/toasts.ts";
import { useCoveredByHome } from "./HomeScreen.tsx";
import { useCoveredByRemix } from "./RemixLayer.tsx";
import { StagePreview } from "./store-leaves.tsx";
import type { WorkspaceProps } from "./use-shell.ts";
import { webBuildShown } from "../web-build-shown.ts";

/** The stage beside the chat: a game's preview, or Studio's review when the Studio chat is open. */
export const WorkspaceStage = memo(function WorkspaceStage({
  app,
  chrome,
  navigation,
  views,
}: Pick<WorkspaceProps, "app" | "chrome" | "navigation" | "views">): JSX.Element {
  const threadsView = useStageThreads();
  const { ready, welcoming } = useSessionView();
  const { stageView } = useLayoutView();
  const engines = useEngines((s) => s.list);
  const { activeThreadId, room, project, activeStatus } = threadsView;
  const { games, rootLabel, runsRoot } = useStageLibrary();
  // Under home or a remix being made, the stage is out of sight, and so is its game's native view.
  const underHome = useCoveredByHome();
  const underRemix = useCoveredByRemix();
  const covered = underHome || underRemix;
  const stageVisible = room === Room.Build && !chrome.workspaceCovered && !welcoming && !covered;
  const { beside } = views;
  const countStaged = useCallback((count: number) => app.library.setState((s) => stagedCounted(s, count), true), [app]);
  return (
    <div className="relative min-h-0 min-w-0">
      <div
        className="absolute inset-0 flex"
        inert={!stageVisible}
        style={{ visibility: stageVisible ? "visible" : "hidden" }}
      >
        <BootstrapGate failed={() => <div className="p-4 text-ink-3">Workspace unavailable until Studio loads.</div>}>
          <StagePreview
            status={activeStatus?.status ?? ""}
            threadId={room === Room.Build ? activeThreadId : threadsView.stageThreadId}
            runsRoot={runsRoot}
            games={games}
            project={project}
            visible={stageVisible}
            sidebarOverlay={chrome.drawerCovers}
            engines={engines}
            gamesRootLabel={rootLabel}
            view={stageView}
            onView={views.chooseStageView}
            onNotice={app.notify}
            beside={beside && beside.threadId === activeThreadId ? beside.target : null}
            onCloseBeside={views.closeBeside}
          />
        </BootstrapGate>
      </div>
      {room === Room.Studio && ready && (
        <div className="absolute inset-0 flex">
          <StudioReview
            games={games}
            onStagedCount={countStaged}
            onOpenGame={navigation.selectGame}
            onNewGame={navigation.newGame}
            onStartBuilding={() => navigation.returnToGame(true)}
            onPlayCommit={(name, commit) => {
              void window.studio
                .showBuild(name, commit)
                .then(() => {
                  webBuildShown(name);
                  navigation.selectGame(name);
                  views.showLive();
                })
                .catch(notifyProblem(app.notify));
            }}
          />
        </div>
      )}
    </div>
  );
});

/** Activity alone subscribes to the all-thread feed. */
function StudioReview(props: Omit<ComponentProps<typeof ReviewPanel>, "events">): JSX.Element {
  const feed = useEventLog((state) => state.feed);
  return <ReviewPanel {...props} events={feed} />;
}
