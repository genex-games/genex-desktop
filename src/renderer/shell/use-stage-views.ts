import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { recheckChatFiles } from "../chat-files.ts";
import {
  OPEN_BESIDE_EVENT,
  OPEN_DESIGN_EVENT,
  OPEN_FILE_EVENT,
  type BesideTarget,
  type OpenFileRequest,
} from "../open-beside.ts";
import { askForPage, noteMaking, type PagePoint } from "../panels/design/design-asks.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { projectOf } from "../state/threads.ts";
import { hostPlatform } from "../platform.ts";
import { noteStageSwitch } from "../analytics/workspace-trackers.ts";
import { StageSwitchVia } from "../analytics/workspace-vocabulary.ts";
import { StageView } from "../stage.ts";
import { stageViewChosen } from "../state/layout.ts";
import type { Studio } from "../state/studio.ts";
import { notifyProblem } from "../state/toasts.ts";
import { chatFileWords } from "../words.ts";

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
          notifyProblem(app.notify)(error);
          recheckChatFiles(request.threadId, [request.ref]);
        },
      );
    };
    window.addEventListener(OPEN_FILE_EVENT, open);
    return () => window.removeEventListener(OPEN_FILE_EVENT, open);
  }, [app]);
}

/**
 * A page of a game's design board brought in front of the person: by the game's agent
 * (`show_design`) or by a press on the page's name in the chat. The Design tab opens on it when its
 * game is the one on the stage; another game's page waits for that game's Design tab.
 */
function useShownDesign(app: Studio, chooseStageView: (view: StageView) => void): void {
  useEffect(() => {
    const open = (project: string, via: StageSwitchVia): void => {
      if (projectOf(app.threads.getState()) !== project) return;
      noteStageSwitch(via);
      chooseStageView(StageView.Design);
    };
    const show = (project: string | null, file: string, via: StageSwitchVia, point: PagePoint = {}): void => {
      if (!project) return;
      askForPage(project, file, point);
      open(project, via);
    };
    const fromChat = (event: Event): void => {
      const file = (event as CustomEvent<string>).detail;
      if (typeof file === "string") show(projectOf(app.threads.getState()), file, StageSwitchVia.ChatLink);
    };
    const stop = window.studio.onEvent((event) => {
      if (event.type === UiEvent.DesignShown) {
        const { project, file, note, spot } = event.payload;
        show(project, file, StageSwitchVia.Other, { note, ...(spot ? { spot } : {}) });
      }
      // The agent said what it is about to draw: the tab opens, so the person watches it appear.
      if (event.type === UiEvent.DesignMaking) {
        noteMaking(event.payload.project, event.payload.files, Date.now());
        open(event.payload.project, StageSwitchVia.Other);
      }
    });
    window.addEventListener(OPEN_DESIGN_EVENT, fromChat);
    return () => {
      stop();
      window.removeEventListener(OPEN_DESIGN_EVENT, fromChat);
    };
  }, [app, chooseStageView]);
}

/** The stage's view, chosen by the user or by what opens it. */
export function useStageViews(app: Studio) {
  useOpenChatFiles(app);
  const chooseStageView = useCallback(
    (next: StageView) => app.layout.setState((s) => stageViewChosen(s, next), true),
    [app],
  );
  useShownDesign(app, chooseStageView);
  const showLive = useCallback(() => chooseStageView(StageView.Live), [chooseStageView]);
  const { beside, closeBeside } = useBeside(app, chooseStageView);
  return useMemo(
    () => ({ chooseStageView, showLive, beside, closeBeside }),
    [chooseStageView, showLive, beside, closeBeside],
  );
}

/** The stage views the shell's hooks and parts share. */
export type StageViews = ReturnType<typeof useStageViews>;
