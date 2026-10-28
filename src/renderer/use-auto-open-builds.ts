/**
 * A newly active run opens Builds once; later explicit tab choices remain the user's. A first
 * build hands the idea cube to the crane on Live (1.4 s) before Builds opens.
 */
import { useEffect, useRef } from "react";
import { RunState, runExecution } from "../shared/run-state.ts";
import { noteStageSwitch } from "./analytics/workspace-trackers.ts";
import { StageSwitchVia } from "./analytics/workspace-vocabulary.ts";
import { StageView } from "./stage.ts";
import { prefersReducedMotion } from "./ui/media-queries.ts";
import type { EventEnvelope } from "./types.ts";

/** How long Live keeps the stage after a first build starts, so the hand-off can play. */
const HAND_OFF_MS = 2_600;

export function useAutoOpenBuilds({
  active,
  threadId,
  stateEvents,
  view,
  chooseView,
}: {
  /** A game chat, loaded. */
  active: boolean;
  threadId: string | null;
  stateEvents: EventEnvelope[];
  view: StageView;
  chooseView: (view: StageView) => void;
}): void {
  const openedBuild = useRef<string | null>(null);
  const handOff = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const viewNow = useRef(view);
  viewNow.current = view;
  useEffect(() => () => clearTimeout(handOff.current), [threadId]);
  useEffect(() => {
    if (!active || !threadId) return;
    const run = runExecution(stateEvents);
    if (run?.state !== RunState.Running) {
      openedBuild.current = null;
      return;
    }
    const key = `${threadId}:${run.runId}`;
    if (openedBuild.current === key) return;
    openedBuild.current = key;
    const idea =
      viewNow.current === StageView.Live &&
      !!document.querySelector('[data-stage-empty="idea"], [data-stage-empty="building"]') &&
      !prefersReducedMotion();
    clearTimeout(handOff.current);
    if (!idea) {
      noteStageSwitch(StageSwitchVia.AutoRunStarted);
      chooseView(StageView.Builds);
      return;
    }
    handOff.current = setTimeout(() => {
      if (openedBuild.current !== key || viewNow.current !== StageView.Live) return;
      noteStageSwitch(StageSwitchVia.AutoRunStarted);
      chooseView(StageView.Builds);
    }, HAND_OFF_MS);
  }, [active, threadId, stateEvents, chooseView]);
}
