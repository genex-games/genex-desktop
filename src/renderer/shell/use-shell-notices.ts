import { useCallback } from "react";
import { type Notice, NoticeKind } from "../notifications.ts";
import type { AppDialogs as Dialogs } from "../panels/AppDialogs.tsx";
import { SettingsSection } from "../settings-navigation.ts";
import { useRailView } from "../state/hooks.ts";
import type { Studio } from "../state/studio.ts";
import { type Notifications, useNotifications } from "../use-notifications.ts";
import type { Navigation } from "./use-navigation.ts";
import type { StageViews } from "./use-stage-views.ts";

/** What the shell root says about notifications: something waits on you, or is merely unread. */
export function noticeState(notices: Notifications): "waiting" | "unread" | undefined {
  if (notices.waitingCount) return "waiting";
  return notices.unread ? "unread" : undefined;
}

/** Notifications read the same log the chat does; opening one goes where it points. */
export function useShellNotices(
  app: Studio,
  input: { ready: boolean; dialogs: Dialogs; away: boolean; openPlay: (play: boolean) => void },
  navigation: Navigation,
  views: StageViews,
): Notifications {
  const { selectThread } = navigation;
  const { chooseStageView } = views;
  const { openSettings } = input.dialogs;
  const { records: threads, activeThreadId, games } = useRailView();
  const openNotice = useCallback(
    (notice: Notice) => {
      if (notice.kind === NoticeKind.SignIn) {
        openSettings(SettingsSection.Providers);
        return;
      }
      // A game from Play: its own page.
      if (notice.kind === NoticeKind.Play) {
        if (!notice.slug) return;
        input.openPlay(true);
        app.play.showGame(notice.slug);
        return;
      }
      if (!app.threads.getState().records.some((thread) => thread.id === notice.threadId)) return;
      selectThread(notice.threadId);
      if (notice.view) chooseStageView(notice.view);
    },
    [app, openSettings, selectThread, chooseStageView, input.openPlay],
  );
  return useNotifications({
    ready: input.ready,
    threads,
    games,
    activeThreadId,
    away: input.away,
    onOpen: openNotice,
  });
}
