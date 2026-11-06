import { useCallback } from "react";
import { track } from "../analytics/client.ts";
import { AnalyticsEvent } from "../analytics/events.ts";
import { noticeOpenedProperties } from "../analytics/workspace-properties.ts";
import { noteNav, noteStageSwitch } from "../analytics/workspace-trackers.ts";
import { NavVia, NoticeVia, NoticeWent, PlayModeVia, StageSwitchVia } from "../analytics/workspace-vocabulary.ts";
import { GENEX_PLUGIN_ID } from "../../shared/genex.ts";
import { type Notice, noticeDestination } from "../notifications.ts";
import { openPluginSetupFor } from "../plugin-setup.ts";
import type { AppDialogs as Dialogs } from "../panels/AppDialogs.tsx";
import { SettingsOpenedFrom, SettingsSection } from "../settings-navigation.ts";
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

/** Notifications read the same log the chat does; opening one goes where it points, and says where it went. */
export function useShellNotices(
  app: Studio,
  input: {
    ready: boolean;
    dialogs: Dialogs;
    away: boolean;
    openPlay: (play: boolean, via?: PlayModeVia) => void;
  },
  navigation: Navigation,
  views: StageViews,
): Notifications {
  const { selectThread } = navigation;
  const { chooseStageView } = views;
  const { openSettings } = input.dialogs;
  const { records: threads, activeThreadId, games } = useRailView();
  const goTo = useCallback(
    (notice: Notice, via: NoticeVia): NoticeWent => {
      const chatExists = (id: string) => app.threads.getState().records.some((thread) => thread.id === id);
      const to = noticeDestination(notice, chatExists, via === NoticeVia.Fix);
      if (to.to === "settings") {
        openSettings(SettingsSection.Providers, null, SettingsOpenedFrom.Notification);
        return NoticeWent.Settings;
      }
      // A game from Play: its own page.
      if (to.to === "play") {
        input.openPlay(true, PlayModeVia.Notification);
        app.play.showGame(to.slug);
        return NoticeWent.Play;
      }
      if (to.to === "nowhere") return NoticeWent.Nowhere;
      noteNav(NavVia.Notification);
      selectThread(to.threadId);
      if (to.view) {
        noteStageSwitch(StageSwitchVia.Notification);
        chooseStageView(to.view);
      }
      // A game's review: its Publish opens once its strip is up, on the card that says what to fix.
      if (to.publish) openPluginSetupFor(to.publish, GENEX_PLUGIN_ID);
      return NoticeWent.Thread;
    },
    [app, openSettings, selectThread, chooseStageView, input.openPlay],
  );
  const openNotice = useCallback(
    (notice: Notice, via: NoticeVia) => {
      const went = goTo(notice, via);
      track(AnalyticsEvent.NoticeOpened, noticeOpenedProperties(notice, { via, went, now: Date.now() }));
    },
    [goTo],
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
