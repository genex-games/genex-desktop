/**
 * Which surface the stage shows, and why the running game is or is not on it: pure, so the rules
 * are tested without React (`PreviewPanel` reads them each render).
 */
import { ObserverLive } from "../../../shared/observers.ts";
import type { BesideTarget } from "../../open-beside.ts";
import type { RunGraph as RunGraphModel } from "../../run-graph.ts";
import { StageView } from "../../stage.ts";
import type { LiveLoad } from "./live-load.ts";

/** What the live page reported, and the load Live waits on, as the flags read them (`useLiveLoad`). */
export interface LiveFlagsInput {
  state: Record<string, unknown> | null;
  liveLoad: LiveLoad | null;
  stopped: boolean;
}

/**
 * The view the stage shows. The user's stored choice is honoured, but Builds can only be shown
 * once there is a build to draw: a remembered "builds" on a game that has never run used to leave
 * the stage on the empty black scene with no copy on it and no Live/Builds control to escape with.
 */
export function resolveStageView(
  view: StageView,
  has: { beside: boolean; builds: boolean; project: boolean },
): StageView {
  if (view === StageView.File && has.beside) return StageView.File;
  if (view === StageView.Builds && has.builds) return StageView.Builds;
  if (view === StageView.Assets && has.project) return StageView.Assets;
  return StageView.Live;
}

/**
 * Which surface the stage shows, and why the running game is or is not on it. Live shows one view,
 * picked by the folder's facts (`live-views.ts`): only the web preview loads, empties or waits for
 * a page; the Unreal card, a plugin's card and the latest pictures hold none. A game with no kind yet (`pending`)
 * has no page: Live shows the first-idea state and waits for nothing.
 */
export function stageFlags({
  view,
  beside,
  graph,
  planning,
  project,
  liveView,
  pending,
  live,
}: {
  view: StageView;
  beside: BesideTarget | null;
  graph: RunGraphModel | null;
  planning: boolean;
  project: string | null;
  /** The view Live shows for this game (`liveViewFor`). */
  liveView: ObserverLive;
  pending: boolean;
  live: LiveFlagsInput;
}) {
  const stageView = resolveStageView(view, {
    beside: Boolean(beside),
    builds: graph !== null || planning,
    project: Boolean(project),
  });
  const onLive = Boolean(project) && stageView === StageView.Live;
  const previewOnStage = onLive && liveView === ObserverLive.Preview;
  const emptyScene = live.state?.phase === "empty" && live.state?.drawCalls === 0;
  const showEmpty = previewOnStage && (emptyScene || pending);
  const liveLoading = previewOnStage && live.liveLoad?.project === project && !showEmpty;
  return {
    stageView,
    /** The game has nothing in it yet, whichever view is open. */
    emptyScene: Boolean(project && (emptyScene || pending)),
    showEmpty,
    liveLoading,
    /** Live shows the web preview: its page, its probe and its controls. */
    previewOnStage,
    /** Live shows the Unreal card: the game plays in the Unreal editor. */
    cardOnStage: onLive && liveView === ObserverLive.UnrealCard,
    /** Live shows a plugin's card: the game plays in the plugin's engine, where the plugin says it stands. */
    pluginCardOnStage: onLive && liveView === ObserverLive.Card,
    /** Live shows the latest pictures of a folder no observer draws. */
    stillsOnStage: onLive && liveView === ObserverLive.Stills,
    /** The person stopped the game: its view holds no page until Play. */
    stopped: live.stopped,
    /** …and Live says so, with no load of it under way. */
    gameStopped: previewOnStage && live.stopped && !liveLoading && !showEmpty,
    buildsOpen: stageView === StageView.Builds,
    /** Assets is a full-stage surface like Builds: the native game view has to give the rectangle back. */
    assetsOpen: stageView === StageView.Assets,
    fileOpen: stageView === StageView.File,
  };
}
