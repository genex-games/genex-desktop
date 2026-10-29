import { useCallback, useMemo, useState } from "react";
import { firstScreenReady, useAppLoaderDismissal } from "../app-loader.ts";
import { firstAsksFromEvents } from "../chat-labels.ts";
import { useAppDialogs } from "../panels/AppDialogs.tsx";
import { threadLog } from "../state/event-log.ts";
import { useEventLog, useShallow, useLayoutView, useSession, useSessionView, useThreads } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { Room, roomOf, projectOf } from "../state/threads.ts";
import { useAutoOpenBuilds } from "../use-auto-open-builds.ts";
import { useChatHistory } from "../use-chat-history.ts";
import { useComposerHandoff } from "./use-composer-handoff.ts";
import { useGameLinks } from "./use-game-links.ts";
import { useNavigation } from "./use-navigation.ts";
import { useShellChrome } from "./use-shell-chrome.ts";
import { useShellNotices } from "./use-shell-notices.ts";
import { useShellShortcuts } from "./use-shell-shortcuts.ts";
import { useStageViews } from "./use-stage-views.ts";
import { useWelcomeExit } from "./use-welcome-exit.ts";

/**
 * Everything the shell holds and wires: its chrome, navigation, the stage's views, notifications,
 * the keyboard, the welcome's exit and the open chat's history. App draws what this returns; the
 * shell's parts (`AppSidebar`, `Workspace`, `WorkspaceStage`) read the rest of the stores
 * themselves.
 */
export function useShell() {
  const app = studio();
  const [threadAttempt, retryThread] = useState(0);
  const dialogs = useAppDialogs();
  const { ready, welcoming } = useSessionView();
  const { sidebarOpen, stageView } = useLayoutView();
  // The shell root's one read of the conversations; App draws `room`, `project` and the open id.
  const threads = useThreads(
    useShallow((state) => ({ activeThreadId: state.activeThreadId, room: roomOf(state), project: projectOf(state) })),
  );
  const { activeThreadId, room } = threads;
  const chrome = useShellChrome(app, dialogs, sidebarOpen);

  const liveThread = useEventLog((s) => threadLog(s, activeThreadId));
  const history = useChatHistory(activeThreadId, liveThread, threadAttempt);
  const chatLoading = ready && history.loading;
  const status = useSession((s) => s.status);
  const chatPending = Boolean(activeThreadId) && chatLoading && !history.error;
  useAppLoaderDismissal(firstScreenReady({ status, welcoming, chatPending }));
  const handoff = useComposerHandoff(ready && !chatLoading && !welcoming, activeThreadId);
  const navigation = useNavigation(app, chrome, handoff);
  const views = useStageViews(app);
  useAutoOpenBuilds({
    active: room === Room.Build && !chatLoading,
    threadId: activeThreadId,
    stateEvents: history.stateEvents,
    view: stageView,
    chooseView: views.chooseStageView,
  });
  const firstAsks = useEventLog(useShallow((s) => firstAsksFromEvents(s.feed)));
  const notices = useShellNotices(
    app,
    { ready, dialogs, away: chrome.workspaceCovered, openPlay: chrome.setPlayOpen },
    navigation,
    views,
  );
  useGameLinks(app, ready, chrome.setPlayOpen);
  // At home, the keyboard's composer is home's; the chat's stays mounted beneath it.
  const homeUp = room === Room.Home;
  useShellShortcuts(dialogs, chrome, navigation, homeUp ? handoff.homeComposer : handoff.composer);
  const welcome = useWelcomeExit(app, handoff);
  const retry = useCallback(() => retryThread((n) => n + 1), []);
  const firstAsk = activeThreadId ? firstAsks[activeThreadId] : undefined;
  const composer = handoff.composer;
  const chat = useMemo(
    () => ({
      history,
      loading: chatLoading,
      retry,
      firstAsk,
      composer,
    }),
    [history, chatLoading, retry, firstAsk, composer],
  );
  return { app, dialogs, welcoming, threads, chrome, navigation, views, notices, firstAsks, welcome, chat, handoff };
}

/** What the shell hands its parts. */
export type Shell = ReturnType<typeof useShell>;

/** What the workspace and its chat and stage take from the shell. */
export type WorkspaceProps = Pick<Shell, "app" | "chrome" | "navigation" | "views" | "dialogs" | "chat" | "handoff">;
