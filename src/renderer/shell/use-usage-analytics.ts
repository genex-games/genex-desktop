import { useCallback, useEffect, useState } from "react";
import { setAnalyticsScreen } from "../analytics/client.ts";
import type { AnalyticsChoice } from "../analytics/consent.ts";
import { ConsentSurface } from "../analytics/events/core.ts";
import { analyticsScreen, type ScreenPlace } from "../analytics/screens.ts";
import { chooseUsageAnalytics } from "../analytics/start.ts";
import type { WelcomeScreen } from "../onboarding/state.ts";
import { useLaunch, usePlay, useSession, useShallow } from "../state/hooks.ts";
import { asksAboutAnalytics } from "../state/session.ts";
import type { Studio } from "../state/studio.ts";

/** What the shell knows of where the person is; Play, the launch and the welcome's step are read here. */
export type ShellPlace = Omit<ScreenPlace, "welcomeScreen" | "play" | "playViewer" | "launching"> & {
  playOpen: boolean;
};

/**
 * Usage analytics in the shell: which screen the person is on (never what is on it), and the
 * one-time question — whether it is up, whether it names the replay, and its answer. The welcome
 * holds its film while the question is up and reports its step through `onWelcomeScreen`.
 */
export function useUsageAnalytics(app: Studio, { playOpen, ...place }: ShellPlace) {
  const [welcomeScreen, setWelcomeScreen] = useState<WelcomeScreen | null>(null);
  const play = usePlay(useShallow((s) => ({ page: s.view.page, viewer: s.viewer !== null })));
  const launching = useLaunch((s) => s.launch !== null);
  const { asking, firstLaunch, replayUntil } = useSession(
    useShallow((s) => ({ asking: asksAboutAnalytics(s), firstLaunch: s.firstLaunch, replayUntil: s.replayUntil })),
  );
  const screen = analyticsScreen({
    ...place,
    welcomeScreen,
    play: playOpen ? play.page : null,
    playViewer: play.viewer,
    launching,
  });
  useEffect(() => setAnalyticsScreen(screen), [screen]);
  const choose = useCallback(
    (choice: AnalyticsChoice, shownMs: number) =>
      chooseUsageAnalytics(app, choice, {
        surface: firstLaunch ? ConsentSurface.FirstLaunch : ConsentSurface.Upgrade,
        shownMs,
        now: Date.now(),
      }),
    [app, firstLaunch],
  );
  const replay = replayUntil !== null && Date.now() < replayUntil;
  return { asking, replay, choose, onWelcomeScreen: setWelcomeScreen };
}
