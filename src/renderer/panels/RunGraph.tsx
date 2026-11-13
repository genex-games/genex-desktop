import type { KeepBuildingTap } from "../keep-building.ts";
import { PerformanceComponent, PerformanceMarkName } from "../../shared/performance.ts";
import { markPerformance, PerformanceBoundary } from "../performance.tsx";
/**
 * The Builds tab — a run as a list a player can read without knowing the harness: once it is over
 * its build, then what works now, then what changed, newest first. A run or a chat turn whose lead
 * started workers lists each worker as a row; the lead is a row only while it works itself.
 *
 * `run-steps.ts` folds the log into steps and `run-graph/builds-list.ts` into rows; this file owns
 * the selection and the keyboard. `run-graph/` holds the list, its rows and the status bar;
 * `RunInspector.tsx` is the card a pressed row opens into, in its place in the list — there is no
 * side panel and no canvas. Harness words never reach the screen: facet = part, iteration = try,
 * accepted = kept, rolled back = undone.
 */
import type { JSX, ReactNode } from "react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { type AssetInfo, type RunGraph as RunGraphModel, runIdOf } from "../run-graph.ts";
import { graphAssetCards, resultStatus, StepState, statusLine } from "../run-steps.ts";
import { RunState } from "../../shared/run-state.ts";
import { t } from "../../shared/i18n.ts";
import type { HistoryEntry } from "../build-progress.ts";
import { OPEN_BUILD_STEP_EVENT, takeBuildStep } from "../open-build.ts";
import { readingNodes } from "../run-tree.ts";
import { GraphSelection } from "./inspector/selection.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import { keyTakenElsewhere } from "./keyboard.ts";
import { barPlay } from "./run-graph/bar-shape.ts";
import { BuildsList } from "./run-graph/BuildsList.tsx";
import { type BuildsList as List, buildsList, listRows, rowOfChecklist } from "./run-graph/builds-list.ts";
import { BuildStatus, type BuildTabs, PlayButton } from "./run-graph/chrome.tsx";
import { useBuildsModel, useNow, useRunStills } from "./run-graph/use-builds-model.ts";
import { Inspector, Lightbox, type LightItem, type Reply } from "./RunInspector.tsx";
import { webBuildShown } from "../web-build-shown.ts";
import { Pending } from "../ui/Pending.tsx";
import { SkeletonLines } from "../ui/Skeleton.tsx";
import { nodeKindOf } from "../analytics/builds-stage.ts";
import { track } from "../analytics/client.ts";
import { AnalyticsEvent } from "../analytics/events.ts";
import { BuildSurface, NodeVia } from "../analytics/events/builds.ts";

/** A row opened on the list, and how. */
function noteNodeOpened(id: string, via: NodeVia, active: boolean): void {
  track(AnalyticsEvent.BuildsNodeOpened, { node_kind: nodeKindOf(id), via, run_active: active });
}

export { assetsStatus } from "./inspector/asset-jobs.ts";

interface Props {
  graph: RunGraphModel;
  project: string | null;
  onShowLive?: () => void;
  /** A game that plays as its own app (an Unreal game): Play starts it (`game-play.ts`) instead of showing Live. */
  onPlayGame?: (() => Promise<void>) | null;
  onShowAsset?: (jobId: string) => void;
  /** Follow up in chat: the composer takes a chip naming the row; null when there is no chat to reply in. */
  onReply: ((reply: Reply) => void) | null;
  /** Keep building on what the run left, in the chat that owns it; null when there is no chat. */
  onKeepBuilding?: KeepBuildingTap | null;
  /** The chat's builds, as the bar's tabs, and the one on show. */
  tabs?: BuildTabs | null;
  /** The stage's toast channel: this panel's own Play/Make it live refuse for ordinary reasons. */
  onNotice: Notify;
}

type BuildsModel = ReturnType<typeof useBuildsModel>;
type Stills = ReturnType<typeof useRunStills>;
type LightState = { items: LightItem[]; index: number } | null;

/**
 * Whether ← or → walks the list: only from the list or its card (or nowhere in particular),
 * with no modifier; a control that uses the arrows itself — the compare slider, the tab switcher,
 * a menu — keeps them.
 */
function arrowWalks(event: KeyboardEvent): boolean {
  const target = event.target instanceof HTMLElement ? event.target : null;
  const here = !target || target === document.body || Boolean(target.closest("[data-stage-graph]"));
  const modified = event.metaKey || event.ctrlKey || event.altKey;
  return here && !event.defaultPrevented && !modified && target?.getAttribute("role") !== "slider";
}

/** The step one arrow press moves by; other keys have none. */
const ARROW_STEP: Partial<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1 };

/** The item one step away in a ring, wrapping at both ends. */
const ringStep = <T,>(items: readonly T[], at: number, dir: number): T | undefined =>
  items[(at + dir + items.length) % items.length];

// ── the view ──────────────────────────────────────────────────────────────────────────────

/** What is open on the list — the pressed row's card — and the lightbox over the tab. */
function useOverlays(selectable: string[]) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [light, setLight] = useState<LightState>(null);
  const selected = selectedId && selectable.includes(selectedId) ? selectedId : null;
  // A card whose row left the list (the lead stops working itself) closes for good: it must not
  // open again by itself, taking focus, when its row comes back.
  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null);
  }, [selectedId, selected]);
  const clear = useCallback(() => {
    setSelectedId(null);
    setLight(null);
  }, []);
  return { selected, setSelectedId, light, setLight, clear };
}
type Overlays = ReturnType<typeof useOverlays>;

/** Escape closes the topmost overlay and stops there; ← and → walk an open row's neighbours. */
function useListKeys(overlays: Overlays, step: (dir: number) => void): void {
  const { light, selected, setLight, setSelectedId } = overlays;
  useEffect(() => {
    /** Close the lightbox, else the card; false when neither is open. */
    const closeTopmost = (): boolean => {
      if (light) setLight(null);
      else if (selected) setSelectedId(null);
      else return false;
      return true;
    };
    /** An arrow walks from the open card only, never from under the lightbox. */
    const walk = (event: KeyboardEvent): void => {
      const dir = ARROW_STEP[event.key];
      if (!dir || !selected || light || !arrowWalks(event)) return;
      event.preventDefault();
      step(dir);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (keyTakenElsewhere(event)) return;
      if (event.key === "Escape") {
        // One press, one dismissal: what this panel closes must not also reach the chat behind it.
        if (closeTopmost()) event.stopPropagation();
        else return;
      } else walk(event);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, light, selected, setLight, setSelectedId]);
}

/** Previous and next walk the list in the order it reads, top to bottom. */
function useStepper(overlays: Overlays, selectable: string[], active: boolean): (dir: number) => void {
  const { selected, setSelectedId } = overlays;
  return useCallback(
    (dir: number): void => {
      const next = ringStep(selectable, selectable.indexOf(selected ?? ""), dir);
      if (!next) return;
      noteNodeOpened(next, NodeVia.Arrow, active);
      setSelectedId(next);
    },
    [selectable, selected, setSelectedId, active],
  );
}

/** A step pressed on the chat's Building card opens its row here, also when Builds was not yet on show. */
function useChatStep(list: List, open: (id: string) => void): void {
  useEffect(() => {
    const take = (): void => {
      const step = takeBuildStep();
      const row = step ? rowOfChecklist(list, step) : null;
      if (row) open(row);
    };
    take();
    window.addEventListener(OPEN_BUILD_STEP_EVENT, take);
    return () => window.removeEventListener(OPEN_BUILD_STEP_EVENT, take);
  }, [list, open]);
}

/**
 * What the Builds tab's own buttons do: play the run's build, or open an asset job on the Assets
 * stage. A chat turn's workers changed the game itself, so its Play shows Live once they did.
 */
function useBuildActions(
  project: string | null,
  model: Pick<BuildsModel, "outcome" | "graph">,
  { onShowLive, onShowAsset, onNotice }: Pick<Props, "onShowLive" | "onShowAsset" | "onNotice">,
) {
  const { outcome, graph } = model;
  if (!runIdOf(graph)) return turnActions(graph, onShowLive);
  const hasBuild = Boolean(outcome?.head && outcome.head !== outcome.base);
  const runActive = graph.active === true;
  const play = (): Promise<void> | void => {
    if (!project || !outcome?.head) return;
    return window.studio
      .showBuild(project, outcome.head)
      .then(() => {
        track(AnalyticsEvent.BuildPlayed, { surface: BuildSurface.BuildsBar, run_active: runActive, ok: true });
        webBuildShown(project);
        onShowLive?.();
      })
      .catch((error: unknown) => {
        track(AnalyticsEvent.BuildPlayed, { surface: BuildSurface.BuildsBar, run_active: runActive, ok: false });
        notifyProblem(onNotice)(error);
      });
  };
  const openJob = (job: AssetInfo): void => {
    if (!onShowAsset || !(job.generationId || job.jobId)) return;
    onShowAsset(job.generationId ?? job.jobId ?? "");
  };
  return { hasBuild, play, openJob };
}

/** A chat turn's buttons: Play shows Live once a worker's work went in; it has no asset jobs of a run's. */
function turnActions(graph: BuildsModel["graph"], onShowLive: Props["onShowLive"]) {
  const hasBuild = resultStatus(graph, null).state === StepState.InBuild;
  return { hasBuild, play: (): void => onShowLive?.(), openJob: (): void => {} };
}

/** Over the hidden list until the run's recorded outcome arrives: the list's shape. */
function OutcomePending(): JSX.Element {
  return (
    <div data-builds-loading className="absolute inset-0 bg-canvas p-6" style={{ visibility: "visible" }}>
      <Pending label={t("Loading builds")}>
        <SkeletonLines widths={[110, 260, 220, 240]} className="w-[260px]" />
      </Pending>
    </div>
  );
}

/** The list of a model, at `now`: its rows, and every row a press or an arrow can open, top to bottom. */
function useList(model: BuildsModel, now: number, over: boolean) {
  const { graph, rows, outcome, timeline, face, lead, leadNode, finishCheck } = model;
  const assetJobs = useMemo(() => graphAssetCards(graph), [graph]);
  const list = useMemo(
    () =>
      buildsList({
        graph,
        rows,
        timeline,
        nodes: readingNodes(graph, rows, outcome),
        face,
        leadAtWork: lead,
        jobs: leadNode?.jobs ?? [],
        assetJobs,
        finishCheck,
        now,
      }),
    [graph, rows, outcome, timeline, face, lead, leadNode, assetJobs, finishCheck, now],
  );
  const selectable = useMemo(
    () => [...(over ? [GraphSelection.Final] : []), ...listRows(list).map((row) => row.id)],
    [list, over],
  );
  return { list, selectable, assetJobs };
}

export const RunGraph = memo(function RunGraph({
  graph: suppliedGraph,
  project,
  onReply,
  onKeepBuilding = null,
  tabs = null,
  onNotice,
  onShowLive,
  onPlayGame = null,
  onShowAsset,
}: Props): JSX.Element {
  useEffect(() => markPerformance(PerformanceMarkName.GraphCommit));
  const model = useBuildsModel(suppliedGraph, project);
  const { graph } = model;
  const stills = useRunStills(model);
  const active = graph.active === true;
  const now = useNow(active);
  // The run's build heads the list once the run is over; while it runs the bar's Play offers it.
  const { list, selectable, assetJobs } = useList(model, now, !active);
  const overlays = useOverlays(selectable);
  const { selected, setSelectedId, clear } = overlays;
  // Another run's rows are not this one's: nothing of the last one stays open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the run on show is the trigger
  useEffect(() => clear(), [graph.runId, clear]);
  const step = useStepper(overlays, selectable, active);
  useListKeys(overlays, step);
  const select = useCallback(
    (id: string): void => {
      noteNodeOpened(id, NodeVia.Click, active);
      setSelectedId(id);
    },
    [setSelectedId, active],
  );
  useChatStep(list, setSelectedId);
  const { hasBuild, play, openJob } = useBuildActions(project, model, { onShowLive, onShowAsset, onNotice });
  const playBar = onPlayGame ?? barPlay(hasBuild, play, onShowLive);

  // Keep the list mounted for its listeners while hiding non-authoritative fallback totals.
  return (
    <PerformanceBoundary id={PerformanceComponent.RunGraph}>
      <div
        data-stage-graph
        className="absolute inset-0 flex flex-col overflow-hidden bg-canvas"
        style={{ visibility: model.loaded ? "visible" : "hidden" }}
      >
        {!model.loaded && <OutcomePending />}
        <BuildStatusClock
          model={model}
          tabs={tabs}
          action={
            playBar ? (
              <PlayButton quiet={graph.active} label={graph.active ? t("Play latest") : t("Play")} onPlay={playBar} />
            ) : null
          }
        />
        <div className="@container/stage relative flex min-h-0 flex-1 overflow-hidden">
          <BuildsList
            list={list}
            project={project}
            assetJobs={assetJobs}
            runId={graph.runId}
            active={active}
            result={active ? null : { status: stills.result, src: stills.resultSrc }}
            selected={selected}
            onSelect={select}
            onClose={() => setSelectedId(null)}
            card={
              selected ? (
                <SelectedPanel
                  key={selected}
                  selection={selected}
                  model={model}
                  overlays={overlays}
                  project={project}
                  stills={stills}
                  onOpenJob={openJob}
                  onReply={onReply}
                  onKeepBuilding={onKeepBuilding}
                  onNotice={onNotice}
                  onPlay={hasBuild ? play : null}
                />
              ) : null
            }
          />
          <LightboxOf light={overlays.light} onLight={overlays.setLight} />
        </div>
      </div>
    </PerformanceBoundary>
  );
});

/** The card of the open row, wired to the overlays it opens. */
function SelectedPanel({
  selection,
  model,
  overlays,
  project,
  stills,
  onOpenJob,
  onReply,
  onKeepBuilding,
  onNotice,
  onPlay,
}: {
  selection: string;
  model: BuildsModel;
  overlays: Overlays;
  project: string | null;
  stills: Stills;
  onOpenJob: (job: AssetInfo) => void;
  onReply: Props["onReply"];
  onKeepBuilding: KeepBuildingTap | null;
  onNotice: Props["onNotice"];
  onPlay: (() => Promise<void> | void) | null;
}): JSX.Element {
  return (
    <Inspector
      selection={selection}
      graph={model.graph}
      outcome={model.outcome}
      rows={model.rows}
      run={model.run}
      base={model.base}
      blender={model.blender}
      assets={model.assets}
      project={project}
      baseSrc={stills.baseSrc}
      resultSrc={stills.resultSrc}
      resultPath={stills.resultPath}
      resultBorrowed={stills.borrowed}
      timeline={model.timeline}
      onClose={() => overlays.setSelectedId(null)}
      onSelect={(id) => overlays.setSelectedId(id)}
      onLight={(items, index) => overlays.setLight({ items, index })}
      onOpenJob={onOpenJob}
      onReply={onReply}
      onKeepBuilding={onKeepBuilding}
      onNotice={onNotice}
      onPlay={onPlay}
    />
  );
}

/** The lightbox over the tab while one is open, stepping through its pictures in a ring. */
function LightboxOf({
  light,
  onLight,
}: {
  light: LightState;
  onLight: (update: (current: LightState) => LightState) => void;
}): JSX.Element | null {
  const item = light?.items[light.index];
  if (!light || !item) return null;
  const move = (dir: number): void =>
    onLight(
      (current) =>
        current && { ...current, index: (current.index + dir + current.items.length) % current.items.length },
    );
  return (
    <Lightbox
      item={item}
      count={light.items.length}
      onPrev={() => move(-1)}
      onNext={() => move(1)}
      onClose={() => onLight(() => null)}
    />
  );
}

/** Opening the only build there is does nothing. */
const STAY = (): void => {};

/** The bar's tabs: the chat's builds, or, before its history names any, the run on show as the one. */
function barTabs(tabs: BuildTabs | null, graph: RunGraphModel, goal: string): BuildTabs {
  if (tabs?.builds.length) return tabs;
  const only: HistoryEntry = {
    runId: graph.runId,
    rounds: 0,
    state: graph.active ? RunState.Running : RunState.Finished,
    startedAt: null,
    ask: goal,
    since: null,
  };
  return { builds: [only], open: graph.runId, onOpen: tabs?.onOpen ?? STAY };
}

/** The status words and the tabs' clocks, on the run's 30-second tick (the list reads the same tick for its background work). */
function BuildStatusClock({
  model,
  tabs,
  action,
}: {
  model: BuildsModel;
  tabs: BuildTabs | null;
  action: ReactNode;
}): JSX.Element {
  const now = useNow(model.graph.active);
  return (
    <BuildStatus
      status={statusLine(model.graph, model.outcome, model.rows, now)}
      tabs={barTabs(tabs, model.graph, model.run.goal)}
      action={action}
    />
  );
}
