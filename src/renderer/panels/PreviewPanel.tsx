import { useSharedSnapshot } from "../use-shared-snapshot.ts";
/**
 * The stage — user story 1, 2, 4.
 *
 * Two views. Live: the actual pixels come from a native `WebContentsView` that main positions
 * on top of this placeholder, so this component owns the rectangle and reports it back. When
 * nothing can run yet (no model) the stage teaches setup instead of sitting empty.
 *
 * Builds: an Autopilot run as a timeline (`RunGraph`) — every part's rounds with their stills
 * and the judges' verdicts, live. A reply about a node goes through the chat's composer
 * (`reply-about.ts`) and lands in the builders' next brief through the steering inbox. An earlier
 * build opens from its result card in the chat (`open-build.ts`); the latest is Builds' default.
 * The stage never pulls itself there: the one thing a user always wants to see is their game,
 * so Live stays until they choose otherwise, and it never changes while they watch it — a new
 * build or a changed game marks Reload instead (`stage.ts` holds the rules).
 *
 * `stage/` holds the pieces: the live page load and its probe, the native view's rectangle, the
 * build-problem strip, what waits for Live's Reload, the strip over the stage and its empty states.
 */
import type { JSX } from "react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { mergeChatEvents } from "../../shared/chat-history.ts";
import { canBuildWith } from "../../shared/engine-descriptor.ts";
import { ObserverLive } from "../../shared/observers.ts";
import type { ConversationRecord, EventEnvelope } from "../../shared/event-log.ts";
import type { PluginInfo } from "../../shared/plugins.ts";
import {
  buildHistory,
  historyLabel,
  isNewestBuild,
  projectBuildGraph,
  replyTarget,
  stageRunGraph,
  workerThreadsOf,
} from "../build-progress.ts";
import type { BesideTarget } from "../open-beside.ts";
import { OPEN_BUILD_EVENT } from "../open-build.ts";
import { replyAbout } from "../reply-about.ts";
import { type RunGraph as RunGraphModel, runBuilding, runIdOf } from "../run-graph.ts";
import { kindPendingGame, type StageWatch, StageView, watchingLive } from "../stage.ts";
import { threadLog } from "../state/event-log.ts";
import { useEventLog, useLaunch, useShallow, useThreads } from "../state/hooks.ts";
import { isWorkingStatus } from "../state/threads.ts";
import { studio } from "../state/studio.ts";
import type { EngineDescriptor, GameProject } from "../types.ts";
import {
  chosenLiveView,
  type LiveView,
  latestShot,
  liveViewsFor,
  picturesGraph,
  type SettledGraphs,
  settledGraphOf,
  settledKeys,
} from "../live-views.ts";
import { useStill } from "../stills.ts";
import { readText, storageKeyFor, writeText } from "../storage.ts";
import { WEB_BUILD_SHOWN_EVENT } from "../web-build-shown.ts";
import { isPlanning, runIdIn } from "../words.ts";
import { AssetsCanvas } from "./AssetsCanvas.tsx";
import { FileViewer } from "./FileViewer.tsx";
import type { Notify } from "../state/toasts.ts";
import { RunGraph } from "./RunGraph.tsx";
import type { Reply } from "./RunInspector.tsx";
import { useLiveBehind } from "./stage/live-behind.ts";
import { BuildTrouble, useBuildProblem } from "./stage/build-problem.tsx";
import { useLiveLoad, useLiveProbe, useLoadOnceStarted } from "./stage/live-load.ts";
import { useStageControls } from "./stage/live-run.ts";
import { useNativeViewBounds } from "./stage/native-bounds.ts";
import { PluginCardStage } from "./stage/PluginCardStage.tsx";
import { stageFlags } from "./stage/stage-flags.ts";
import { EmptyGame, LiveLoading, NoGame, PlanningBuild, StoppedGame } from "./stage/StageBody.tsx";
import { StageStrip } from "./stage/StageStrip.tsx";
import { type StageTabKey, tabChoice, webBuildView } from "./stage/stage-tabs.ts";
import { StillsStage } from "./stage/StillsStage.tsx";
import { UnrealStage } from "./stage/UnrealStage.tsx";

const EMPTY_WORKER_EVENTS: EventEnvelope[] = [];

interface Props {
  games: GameProject[];
  /** The conversation whose builds the stage draws; its whole log is read once it is shown. */
  threadId: string | null;
  runsRoot: string | null;
  status: string;
  project: string | null;
  engines: EngineDescriptor[];
  /** `~/AI Games`, as a human reads it. */
  gamesRootLabel: string;
  /** The stage's view is App's, so the chat's morning card can put it back on Live. */
  view: StageView;
  onView: (view: StageView) => void;
  onNotice: Notify;
  /** Installed plugins — App's list, refreshed on `plugins.changed`; the toolbar and the dialog read one copy. */
  plugins: PluginInfo[];
  visible: boolean;
  sidebarOverlay: boolean;
  /** A file or image opened from the chat: a fourth tab until it is closed. */
  beside?: BesideTarget | null;
  onCloseBeside?: () => void;
}

/** The earlier build the user opened for this conversation, if any; the latest shows otherwise. */
function useHistorySelection(threadId: string | null) {
  const [historySelection, setHistorySelection] = useState<{ threadId: string | null; runId: string } | null>(null);
  const selectedRun = historySelection?.threadId === threadId ? historySelection.runId : null;
  const select = useCallback(
    (runId: string, latest: string | undefined): void =>
      setHistorySelection(runId === latest ? null : { threadId, runId }),
    [threadId],
  );
  const showLatest = useCallback((): void => setHistorySelection(null), []);
  return { selectedRun, select, showLatest };
}

/** The run a `studio:open-build` names, when it is one of this conversation's builds. */
function openedRun(event: Event, history: ReadonlyArray<{ runId: string }>): string | null {
  const runId: unknown = event instanceof CustomEvent ? event.detail?.runId : undefined;
  if (typeof runId !== "string" || !history.some((run) => run.runId === runId)) return null;
  return runId;
}

/** An earlier build opens from its result card in the chat; the latest is Builds' own default. */
function useOpenBuild(
  history: ReadonlyArray<{ runId: string }>,
  select: (runId: string, latest: string | undefined) => void,
  onView: (view: StageView) => void,
): void {
  const historyRef = useRef(history);
  historyRef.current = history;
  useEffect(() => {
    const open = (event: Event): void => {
      const runs = historyRef.current;
      const runId = openedRun(event, runs);
      if (!runId) return;
      select(runId, runs.at(-1)?.runId);
      onView(StageView.Builds);
    };
    window.addEventListener(OPEN_BUILD_EVENT, open);
    return () => window.removeEventListener(OPEN_BUILD_EVENT, open);
  }, [select, onView]);
}

/**
 * What sits above the stage rather than over it: a build that failed. Above, not inside: the game
 * runs in a native view that paints on top of this window, so a caption in the rectangle would be
 * behind the game.
 */
function StageBanners({ trouble }: { trouble: ReturnType<typeof useBuildProblem> }): JSX.Element | null {
  if (!trouble.buildProblem) return null;
  return (
    <BuildTrouble
      problem={trouble.buildProblem}
      installing={trouble.installing}
      installLines={trouble.installLines}
      onInstall={trouble.installPackages}
      onRunScripts={trouble.runSetupScripts}
      onReload={() => void window.studio.reloadPreview({ retry: true }).catch(() => {})}
    />
  );
}

/** The conversation's builds: its whole log and its current run's workers' logs, folded into the graph and its history. */
function useStageGraph({
  project,
  threadId,
  runsRoot,
  selectedRun,
  buildsVisible,
}: {
  project: string | null;
  threadId: string | null;
  runsRoot: string | null;
  selectedRun: string | null;
  buildsVisible: boolean;
}) {
  // The stage draws a thread's whole story, not the bounded all-threads tail: its log, and each of
  // the current run's workers' logs, are read in full once and then kept live.
  const events = useDeferredValue(useEventLog((s) => threadLog(s, threadId)));
  useEffect(() => {
    if (threadId) return studio().eventLog.watchThread(threadId);
  }, [threadId]);
  const history = useMemo(() => buildHistory(events, threadId), [events, threadId]);
  const [workerRun, setWorkerRun] = useState<string | null>(null);
  const workerFields = useThreads(
    useShallow((state) =>
      workerRun ? workerThreadsOf(state.records, workerRun).flatMap((worker) => [worker.id, worker.title ?? ""]) : [],
    ),
  );
  const workers = useMemo(() => {
    const records: Array<Pick<ConversationRecord, "id" | "title">> = [];
    for (let index = 0; index < workerFields.length; index += 2) {
      const id = workerFields[index];
      const title = workerFields[index + 1];
      if (id !== undefined) records.push({ id, title });
    }
    return records;
  }, [workerFields]);
  const workerLogs = useEventLog(
    useShallow((s) => (buildsVisible ? workers.map((worker) => threadLog(s, worker.id)) : [])),
  );
  const workerEvents = useMemo(
    () => (buildsVisible ? mergeChatEvents(...workerLogs) : EMPTY_WORKER_EVENTS),
    [workerLogs, buildsVisible],
  );
  const graph = useSharedSnapshot(
    useMemo(
      () =>
        project
          ? projectBuildGraph(mergeChatEvents(workerEvents, events), threadId, workers, runsRoot, selectedRun, {
              includeWorkers: buildsVisible,
            })
          : null,
      [events, workerEvents, threadId, workers, runsRoot, project, selectedRun, buildsVisible],
    ),
  );
  // The run's workers write their own threads; the graph reads each one's whole log. A chat turn's
  // workers are pool sessions with no threads named after a run.
  const shownRunId = graph ? runIdOf(graph) : null;
  useEffect(() => {
    setWorkerRun(shownRunId);
  }, [shownRunId]);
  // The run Live answers to: the shown graph's, or (a chat turn's shown) the newest run's.
  const runGraph = useMemo(
    () => stageRunGraph(events, threadId, runsRoot, graph, history),
    [events, threadId, runsRoot, graph, history],
  );
  useEffect(() => {
    if (!buildsVisible) return;
    const release = workers.map((worker) => studio().eventLog.watchThread(worker.id));
    return () => {
      for (const stop of release) stop();
    };
  }, [workers, buildsVisible]);
  // An earlier run's graph, for Live's pictures when the stage's run took none yet: a finished run is
  // projected once per thread, not again with every batch of its log.
  const settled = useRef<{ key: string; graphs: SettledGraphs }>({ key: "", graphs: new Map() });
  const earlierGraph = useMemo(() => {
    const key = `${threadId}\n${runsRoot}`;
    if (settled.current.key !== key) settled.current = { key, graphs: new Map() };
    return settledGraphOf(
      settled.current.graphs,
      (runId: string) => projectBuildGraph(events, threadId, [], runsRoot, runId, { includeWorkers: false }),
      settledKeys(events, history),
    );
  }, [events, threadId, runsRoot, history]);
  return { history, graph, runGraph, earlierGraph };
}

/**
 * The run the stage draws: the conversation's build history, the one opened from it (the latest
 * by default), its graph, and whether a new run is still being planned. While an earlier build is
 * shown, `earlier` names it and leads back to the latest one.
 */
function useStageRun({
  project,
  threadId,
  runsRoot,
  status,
  onView,
  buildsVisible,
}: {
  project: string | null;
  threadId: string | null;
  runsRoot: string | null;
  status: string;
  onView: (view: StageView) => void;
  buildsVisible: boolean;
}) {
  const { selectedRun, select, showLatest } = useHistorySelection(threadId);
  const { history, graph, runGraph, earlierGraph } = useStageGraph({
    project,
    threadId,
    runsRoot,
    selectedRun,
    buildsVisible,
  });
  useOpenBuild(history, select, onView);
  const latestRun = history.at(-1)?.runId;
  const historyIndex = history.findIndex((run) => run.runId === (selectedRun ?? latestRun));
  const planningRun = isPlanning(status) ? runIdIn(status) : null;
  const planning = Boolean(!selectedRun && planningRun && planningRun !== graph?.runId);
  const shownRun = history[historyIndex];
  const earlier = useMemo(
    () =>
      selectedRun && shownRun
        ? { label: historyLabel(shownRun, { newest: isNewestBuild(history, shownRun) }), onLatest: showLatest }
        : null,
    [selectedRun, shownRun, history, showLatest],
  );
  return { selectedRun, history, graph, runGraph, planning, earlier, earlierGraph };
}

/** The run whose pictures Live's own view shows (`picturesGraph`): the stage's run, else the newest earlier one with some. */
function useLivePictures(
  run: Pick<ReturnType<typeof useStageRun>, "runGraph" | "history" | "earlierGraph">,
  liveView: LiveView,
  wanted: boolean,
): RunGraphModel | null {
  const { runGraph, history, earlierGraph } = run;
  return useMemo(() => {
    if (!wanted) return runGraph;
    const runs = history.filter((entry) => entry.chat !== true).map((entry) => entry.runId);
    return picturesGraph(runGraph, runs, earlierGraph, liveView);
  }, [wanted, runGraph, history, earlierGraph, liveView]);
}

/**
 * A game with nothing to show whose chat is working on it (or that home is still launching) is
 * having its first plan written. A game launched from home writes from when its message was sent.
 */
function useFirstPlan(project: string | null, status: string, graph: RunGraphModel | null): { since?: number } | null {
  const launching = useLaunch((s) => s.launch?.project === project);
  const launched = useLaunch((s) => s.planning);
  const building = isWorkingStatus(status) || launching;
  const since = launched?.project === project ? launched.at : undefined;
  const planning = Boolean(project && building && !runBuilding(graph));
  return useMemo(() => {
    if (!planning) return null;
    return since === undefined ? {} : { since };
  }, [planning, since]);
}

/**
 * Follow up in chat about a node of this run: the composer takes a chip naming it; none without a
 * chat, and none on a chat turn's graph, whose workers take no notes through a run's inbox.
 */
function replyFor(threadId: string | null, graph: RunGraphModel): ((reply: Reply) => void) | null {
  const target = replyTarget(graph);
  if (!threadId || !target) return null;
  return (reply) => replyAbout({ threadId, ...target, ...reply });
}

/**
 * Live with no game to show: the Planner while the first plan is written (one Planner from the
 * first frame the game loads to its first picture, never drawn twice), else the loader or the
 * empty game.
 */
function LiveStates({
  view,
  runGraph,
  project,
  onWatch,
  onPlay,
  onResume,
}: {
  view: StageContentsView;
  /** the run Live answers to: a run building fills an empty or stopped stage */
  runGraph: RunGraphModel | null;
  project: string | null;
  onWatch: () => void;
  onPlay: (head: string) => Promise<void>;
  onResume: () => void;
}): JSX.Element | null {
  const { firstPlan, liveLoading, showEmpty, gameStopped, loader } = view;
  if (firstPlan && (liveLoading || showEmpty)) return <PlanningBuild {...firstPlan} />;
  if (loader.shown) return <LiveLoading leaving={loader.leaving} />;
  // A load still inside its first moments shows the bare stage: most finish before a loader would.
  if (liveLoading) return null;
  if (gameStopped)
    return <StoppedGame graph={runGraph} project={project} onWatch={onWatch} onPlay={onPlay} onResume={onResume} />;
  if (showEmpty) return <EmptyGame graph={runGraph} project={project} onWatch={onWatch} onPlay={onPlay} />;
  return null;
}

/** What the stage shows over (or instead of) the running game, and why. */
interface StageContentsView {
  stageView: StageView;
  planning: boolean;
  showEmpty: boolean;
  liveLoading: boolean;
  gameStopped: boolean;
  /** The loader over a load: drawn, or fading out before the game is uncovered. */
  loader: { shown: boolean; leaving: boolean };
  /** The game's first plan is being written: the Planner writes it (from `since`) until there is a game. */
  firstPlan: { since?: number } | null;
}

/** What fills the stage's rectangle over (or instead of) the running game. */
function StageContents({
  project,
  threadId,
  graph,
  runGraph,
  view,
  showSetup,
  beside,
  focusedAsset,
  earlier,
  onView,
  onFocusAsset,
  onNotice,
  onPlayBuild,
  onResume,
  onCloseBeside,
}: {
  project: string | null;
  threadId: string | null;
  graph: RunGraphModel | null;
  /** the run Live answers to (`stageRunGraph`) */
  runGraph: RunGraphModel | null;
  view: StageContentsView;
  showSetup: boolean;
  beside: BesideTarget | null;
  focusedAsset: string | null;
  /** Set while an earlier build is shown: its name, and the way back to the latest one. */
  earlier: { label: string; onLatest: () => void } | null;
  onView: (view: StageView) => void;
  onFocusAsset: (id: string) => void;
  onNotice: Notify;
  /** Swap a build of this run into Live, as the user asked. */
  onPlayBuild: (head: string) => Promise<void>;
  /** Play the stopped game again. */
  onResume: () => void;
  onCloseBeside?: () => void;
}): JSX.Element {
  const { stageView, planning } = view;
  const buildsOpen = stageView === StageView.Builds;
  const showLive = useCallback(() => onView(StageView.Live), [onView]);
  const showAsset = useCallback(
    (id: string) => {
      onFocusAsset(id);
      onView(StageView.Assets);
    },
    [onFocusAsset, onView],
  );
  const reply = useMemo(() => (graph ? replyFor(threadId, graph) : null), [threadId, graph]);
  // Builds shows the plan while the run is still planning, and the run's graph after.
  const graphShown = buildsOpen && !planning ? graph : null;
  return (
    <>
      {!project ? <NoGame showSetup={showSetup} /> : null}
      <LiveStates
        view={view}
        runGraph={runGraph}
        project={project}
        onWatch={() => onView(StageView.Builds)}
        onPlay={onPlayBuild}
        onResume={onResume}
      />
      {buildsOpen && planning ? <PlanningBuild /> : null}
      {graphShown ? (
        <RunGraph
          graph={graphShown}
          project={project}
          onShowLive={showLive}
          onShowAsset={showAsset}
          onReply={reply}
          earlier={earlier}
          onNotice={onNotice}
        />
      ) : null}
      {stageView === StageView.Assets && project ? (
        <AssetsCanvas focusJob={focusedAsset} project={project} onNotice={onNotice} />
      ) : null}
      {stageView === StageView.File && beside ? (
        <FileViewer threadId={threadId} target={beside} onClose={() => onCloseBeside?.()} onNotice={onNotice} />
      ) : null}
    </>
  );
}

/**
 * The Live view chosen for each game whose folder has more than one, as its observer key: kept in
 * memory for this launch (so a choice holds where storage is unavailable) and remembered per game.
 */
function useChosenLiveViews(project: string | null) {
  const [picks, setPicks] = useState<ReadonlyMap<string, string>>(() => new Map());
  const remember = useCallback((game: string, key: string): void => {
    writeText(storageKeyFor.liveView(game), key);
    setPicks((before) => new Map(before).set(game, key));
  }, []);
  const remembered = useMemo(
    () => (project ? (picks.get(project) ?? readText(storageKeyFor.liveView(project))) : null),
    [project, picks],
  );
  return { remembered, remember };
}

/** Live's views of the game, picked by its folder's facts (`live-views.ts`), the one shown, and whether it is the web preview. */
function useLiveView(
  game: GameProject | null,
  plugins: PluginInfo[],
  remembered: string | null,
): { views: LiveView[]; liveView: LiveView; preview: boolean } {
  return useMemo(() => {
    const views = liveViewsFor(game, plugins);
    const liveView = chosenLiveView(views, remembered);
    return { views, liveView, preview: liveView.live === ObserverLive.Preview };
  }, [game, plugins, remembered]);
}

/** A web build put on the stage (`web-build-shown.ts`) brings the game's Web game view forward when its folder has more than one. */
function useWebBuildShown(
  project: string | null,
  views: readonly LiveView[],
  remember: (game: string, key: string) => void,
): void {
  const now = useRef({ project, views });
  now.current = { project, views };
  useEffect(() => {
    const shown = (event: Event): void => {
      const game: unknown = event instanceof CustomEvent ? event.detail?.project : undefined;
      const web = webBuildView(game, now.current.project, now.current.views);
      if (web && typeof game === "string") remember(game, web);
    };
    window.addEventListener(WEB_BUILD_SHOWN_EVENT, shown);
    return () => window.removeEventListener(WEB_BUILD_SHOWN_EVENT, shown);
  }, [remember]);
}

/** Live's views of the game on the stage, the one shown, and a tab press: a Live tab remembers its view for the game, then shows Live. */
function useLiveTabs(
  project: string | null,
  game: GameProject | null,
  plugins: PluginInfo[],
  onView: (view: StageView) => void,
) {
  const { remembered, remember } = useChosenLiveViews(project);
  const { views, liveView, preview } = useLiveView(game, plugins, remembered);
  useWebBuildShown(project, views, remember);
  const chooseTab = useCallback(
    (key: StageTabKey) => {
      const choice = tabChoice(key, views);
      if (!choice) return;
      if ("live" in choice && choice.live && project) remember(project, choice.live);
      onView(choice.view);
    },
    [views, project, remember, onView],
  );
  return { views, liveView, preview, chooseTab };
}

/** The Unreal card's latest shot, read once the card is on the stage: the observer's newest capture, else the newest save point's still. */
function UnrealCardStage({
  game,
  observer,
  runGraph,
  plugins,
  onNotice,
}: {
  game: GameProject;
  observer: string | null;
  runGraph: RunGraphModel | null;
  plugins: PluginInfo[];
  onNotice: Notify;
}): JSX.Element {
  const shotFile = observer ? latestShot(runGraph, observer) : null;
  const shot = useStill(shotFile ? { run: shotFile } : null);
  return <UnrealStage game={game} plugins={plugins} shot={shot} onNotice={onNotice} />;
}

/** A plugin's card, with its observer's latest shot once the card is on the stage (as the Unreal card reads its own). */
function PluginCardWithShot({
  game,
  observer,
  runGraph,
  plugins,
  onNotice,
}: {
  game: GameProject;
  observer: string | null;
  runGraph: RunGraphModel | null;
  plugins: PluginInfo[];
  onNotice: Notify;
}): JSX.Element {
  const shotFile = observer ? latestShot(runGraph, observer) : null;
  const shot = useStill(shotFile ? { run: shotFile } : null);
  return <PluginCardStage game={game} observer={observer} plugins={plugins} shot={shot} onNotice={onNotice} />;
}

/** Live's view when it is not the web preview: the Unreal card, a plugin's card, or the latest pictures of a folder no observer draws. */
function OwnLiveView({
  game,
  on,
  view,
  run,
  plugins,
  onNotice,
}: {
  game: GameProject | null;
  on: { cardOnStage: boolean; pluginCardOnStage: boolean; stillsOnStage: boolean };
  view: LiveView;
  /** the stage's run, whose pictures (or an earlier run's) Live shows */
  run: Pick<ReturnType<typeof useStageRun>, "runGraph" | "history" | "earlierGraph">;
  plugins: PluginInfo[];
  onNotice: Notify;
}): JSX.Element | null {
  const graph = useLivePictures(run, view, [on.cardOnStage, on.pluginCardOnStage, on.stillsOnStage].some(Boolean));
  if (!game) return null;
  if (on.cardOnStage)
    return (
      <UnrealCardStage game={game} observer={view.observer} runGraph={graph} plugins={plugins} onNotice={onNotice} />
    );
  if (on.pluginCardOnStage)
    return (
      <PluginCardWithShot game={game} observer={view.observer} runGraph={graph} plugins={plugins} onNotice={onNotice} />
    );
  if (on.stillsOnStage) return <StillsStage title={game.title} graph={graph} observer={view.observer} />;
  return null;
}

export function PreviewPanel({
  games,
  project,
  engines,
  view,
  onView,
  onNotice,
  threadId,
  runsRoot,
  status,
  plugins,
  visible,
  sidebarOverlay,
  beside = null,
  onCloseBeside,
}: Props): JSX.Element {
  /** The game on the stage, as the studio describes it — its title, its folder, its shape. */
  const loaded = useMemo(() => games.find((game) => game.name === project) ?? null, [games, project]);
  const { views, liveView, preview, chooseTab } = useLiveTabs(project, loaded, plugins, onView);
  const slot = useRef<HTMLDivElement>(null);
  const live = useLiveLoad(project);
  const pending = useLoadOnceStarted({ project, pending: kindPendingGame(loaded), noPage: !preview }, live.loadLive);
  const run = useStageRun({
    project,
    threadId,
    runsRoot,
    status,
    onView,
    buildsVisible: visible && view === StageView.Builds,
  });
  const { selectedRun, history, graph, runGraph, planning } = run;
  const flags = stageFlags({ view, beside, graph, planning, project, liveView: liveView.live, pending, live });
  const { stageView, showEmpty, liveLoading, gameStopped, previewOnStage } = flags;
  const [focusedAsset, setFocusedAsset] = useState<string | null>(null);
  /** A plugin's toolbar button has its panel up over the stage. */
  const [toolbarOpen, setToolbarOpen] = useState(false);
  // Only the web preview is a game to watch or a page to probe; beside any other view, what waits goes in.
  const watch: StageWatch = { view: stageView, visible, showEmpty, preview };
  const watching = watchingLive(watch);
  const firstPlan = useFirstPlan(project, status, runGraph);
  const shown = { onLive: previewOnStage && visible, loading: liveLoading, empty: showEmpty };
  const controls = useStageControls(project, live, { ...shown, firstPlan: Boolean(firstPlan) }, onNotice);
  const cover = { ...flags, liveLoading: controls.loader.covering, project, visible, sidebarOverlay, toolbarOpen };
  useNativeViewBounds(slot, { ...cover, watching });
  const trouble = useBuildProblem(project, live.loadLive, onNotice);
  useLiveProbe({ project: preview ? project : null, stageView, live, buildProblemRef: trouble.buildProblemRef });
  const { shownBuild, behind, showBuild, reload } = useLiveBehind({
    project,
    threadId,
    graph: runGraph,
    selectedRun,
    ...watch,
    stopped: live.stopped,
    loadLive: live.loadLive,
    onView,
    onNotice,
  });

  return (
    <div
      data-stage-view={stageView}
      data-shown-build={shownBuild?.head ?? ""}
      data-selected-run={selectedRun ?? graph?.runId ?? history.at(-1)?.runId ?? ""}
      className="column flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <StageStrip
        loaded={loaded}
        project={project}
        hasBuilds={Boolean(graph || planning)}
        buildsLive={Boolean(graph?.active || planning)}
        beside={beside}
        stageView={stageView}
        live={{ views, shown: liveView }}
        onTab={chooseTab}
        behind={behind}
        onReload={reload}
        run={controls.run}
        fullScreen={controls.fullScreen}
        sound={controls.sound}
        emptyGame={flags.emptyScene}
        livePreview={Boolean(project) && preview}
        gameControls={controls.gameControls}
        plugins={plugins}
        onNotice={onNotice}
        onToolbarOpen={setToolbarOpen}
      />

      {previewOnStage ? <StageBanners trouble={trouble} /> : null}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-base">
        <div ref={slot} data-preview-slot className="absolute inset-0" />
        <StageContents
          project={project}
          threadId={threadId}
          graph={graph}
          runGraph={runGraph}
          view={{ stageView, planning, showEmpty, liveLoading, gameStopped, loader: controls.loader, firstPlan }}
          showSetup={!project && !engines.some(canBuildWith)}
          beside={beside}
          focusedAsset={focusedAsset}
          earlier={run.earlier}
          onView={onView}
          onFocusAsset={setFocusedAsset}
          onNotice={onNotice}
          onPlayBuild={showBuild}
          onResume={controls.run.toggle}
          onCloseBeside={onCloseBeside}
        />
        <OwnLiveView game={loaded} on={flags} view={liveView} run={run} plugins={plugins} onNotice={onNotice} />
      </div>
    </div>
  );
}
