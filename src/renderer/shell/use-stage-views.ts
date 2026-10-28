import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { recheckChatFiles } from "../chat-files.ts";
import { OPEN_BESIDE_EVENT, OPEN_FILE_EVENT, type BesideTarget, type OpenFileRequest } from "../open-beside.ts";
import { hostPlatform } from "../platform.ts";
import { noteStageSwitch } from "../analytics/workspace-trackers.ts";
import { StageSwitchVia } from "../analytics/workspace-vocabulary.ts";
import { StageView } from "../stage.ts";
import { stageViewChosen } from "../state/layout.ts";
import type { Studio } from "../state/studio.ts";
import { ToastTone } from "../state/toasts.ts";
import { chatFileWords, problemWords } from "../words.ts";
import { errorCode } from "../../shared/errors.ts";

type Beside = { threadId: string; target: BesideTarget; returnTo: StageView };

/**
 * A file or image opened from the chat is a tab of that chat's game until it is closed; closing
 * it returns the stage to the view it came from.
 */
function useBeside(app: Studio, chooseStageView: (view: StageView) => void) {
  const [beside, setBeside] = useState<Beside | null>(null);
  useEffect(() => {
    const open = (event: Event): void => {
      const target = (event as CustomEvent<BesideTarget>).detail;
      const threadId = app.threads.getState().activeThreadId;
      if (!target || !threadId) return;
      const now = app.layout.getState().stageView;
      const from = now === StageView.File ? StageView.Live : now;
      setBeside((current) => ({
        threadId,
        target,
        returnTo: current?.threadId === threadId ? current.returnTo : from,
      }));
      noteStageSwitch(StageSwitchVia.FileBeside);
      app.layout.setState((s) => stageViewChosen(s, StageView.File), true);
    };
    window.addEventListener(OPEN_BESIDE_EVENT, open);
    return () => window.removeEventListener(OPEN_BESIDE_EVENT, open);
  }, [app]);
  const besideNow = useRef(beside);
  besideNow.current = beside;
  const closeBeside = useCallback(() => {
    const returnTo = besideNow.current?.returnTo ?? StageView.Live;
    setBeside(null);
    noteStageSwitch(StageSwitchVia.FileClosed);
    chooseStageView(returnTo);
  }, [chooseStageView]);
  return { beside, closeBeside };
}

/**
 * Every other file the chat names opens in its app through main, which says when no app would;
 * a file that moved or went away is asked about again, so its link goes.
 */
function useOpenChatFiles(app: Studio): void {
  useEffect(() => {
    const open = (event: Event): void => {
      const request = (event as CustomEvent<OpenFileRequest>).detail;
      if (!request?.threadId || !request.ref) return;
      void window.studio.openChatFile(request.threadId, request.ref).then(
        (result) => {
          if (result.problem) app.notify(chatFileWords(hostPlatform()).noApp(request.label));
        },
        (error: unknown) => {
          app.notify(problemWords(error), ToastTone.Error, errorCode(error));
          recheckChatFiles(request.threadId, [request.ref]);
        },
      );
    };
    window.addEventListener(OPEN_FILE_EVENT, open);
    return () => window.removeEventListener(OPEN_FILE_EVENT, open);
  }, [app]);
}

/** The stage's view, chosen by the user or by what opens it. */
export function useStageViews(app: Studio) {
  useOpenChatFiles(app);
  const chooseStageView = useCallback(
    (next: StageView) => app.layout.setState((s) => stageViewChosen(s, next), true),
    [app],
  );
  const showLive = useCallback(() => chooseStageView(StageView.Live), [chooseStageView]);
  const { beside, closeBeside } = useBeside(app, chooseStageView);
  return useMemo(
    () => ({ chooseStageView, showLive, beside, closeBeside }),
    [chooseStageView, showLive, beside, closeBeside],
  );
}

/** The stage views the shell's hooks and parts share. */
export type StageViews = ReturnType<typeof useStageViews>;
