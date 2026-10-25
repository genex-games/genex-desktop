/**
 * A remix made in Play is shown in Create from the press (variant C): Play gives way at once, the
 * sidebar and the workspace show the copy being made (`RemixLayer`), and the new game opens when
 * main names it. A person who went elsewhere meanwhile keeps their place: the new game takes the
 * remix's row and a toast says it is ready. A failure is told as a toast, and Play comes back for
 * a person still with the remix.
 */
import { useEffect, useLayoutEffect } from "react";
import { remixTitle } from "../../shared/play.ts";
import type { Navigation } from "../shell/use-navigation.ts";
import type { ShellChrome } from "../shell/use-shell-chrome.ts";
import { usePlay } from "../state/hooks.ts";
import { remixEnded, remixFailureTold, remixOpened } from "../state/play.ts";
import { studio } from "../state/studio.ts";
import { notifyProblem, ToastTone } from "../state/toasts.ts";
import { PLAY_WORDS } from "../words.ts";
import { stillWithRemix } from "./remix-model.ts";

/** Follow a remix from its press to its game: Create while it is made, the game once it is. */
export function usePlayRemixes(
  navigation: Pick<Navigation, "enterProject">,
  chrome: Pick<ShellChrome, "setPlayOpen" | "workspaceCovered">,
): void {
  const { enterProject } = navigation;
  const { setPlayOpen, workspaceCovered } = chrome;
  const pressed = usePlay((s) => s.making?.slug ?? null);
  const remixed = usePlay((s) => s.remixed);
  const remixFailed = usePlay((s) => s.remixFailed);
  const remixRefusal = usePlay((s) => s.remixRefusal);
  // In the press's own commit, so the view transition around it shows Play turning into Create.
  useLayoutEffect(() => {
    if (pressed) setPlayOpen(false);
  }, [pressed, setPlayOpen]);
  useEffect(() => {
    if (!remixed) return;
    const app = studio();
    const { making } = app.play.getState();
    if (!stillWithRemix(making, workspaceCovered)) {
      app.play.setState((state) => remixEnded(remixOpened(state)), true);
      app.notify(PLAY_WORDS.making.ready(making ? remixTitle(making.title) : remixed), ToastTone.Ok);
      return;
    }
    app.play.setState(remixOpened, true);
    // The copy stays on screen until its game is open under it.
    void enterProject(remixed, true)
      .catch(notifyProblem(app.notify))
      .finally(() => app.play.setState(remixEnded, true));
  }, [remixed, enterProject, workspaceCovered]);
  useEffect(() => {
    if (!remixFailed) return;
    const app = studio();
    const back = stillWithRemix(app.play.getState().making, workspaceCovered);
    app.play.setState(remixFailureTold, true);
    app.notify(remixRefusal ? PLAY_WORDS.remixRefused[remixRefusal] : PLAY_WORDS.remixFailed, ToastTone.Error);
    if (back) setPlayOpen(true);
  }, [remixFailed, remixRefusal, setPlayOpen, workspaceCovered]);
}
