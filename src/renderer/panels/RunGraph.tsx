import { gridTransform } from "../canvas-view.ts";
import { PerformanceComponent, PerformanceMarkName } from "../../shared/performance.ts";
import { markPerformance, PerformanceBoundary } from "../performance.tsx";
/**
 * The Builds tab — a run drawn as a graph a player can read without knowing the harness: what you
 * asked → one row per part, its steps on a line → your build. What reached the build is the line;
 * what did not hangs below it. The judges are an eye on the edge into every node they looked at.
 * A run or a chat turn whose lead started workers or background work is a tree: what you asked →
 * the lead (its background work under it) → a row per worker → your build → the finish check.
 *
 * `run-steps.ts` folds the log into steps and lays them out; this file owns the canvas (pan, zoom,
 * keeping live work in view, bringing a selected node to the middle), the selection and the keyboard.
 * `run-graph/` holds the nodes, the gates, the status bar, the zoom pill and the camera;
 * `RunInspector.tsx` is the card a selected node opens into, in place over the canvas —
 * there is no side panel. Harness words never reach the screen: facet = part, iteration = try,
 * accepted = kept, rolled back = undone.
 */
import type { JSX, ReactNode } from "react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { type AssetInfo, IterationStatus, type RunGraph as RunGraphModel, runIdOf } from "../run-graph.ts";
import {
  frontier,
  Gate,
  type GatePoint,
  isJudgedTry,
  resultStatus,
  rowMeta,
  StepState,
  statusLine,
} from "../run-steps.ts";
import type { AgentScreenFrame } from "../../shared/agent-screen.ts";
import { leadFrameOf } from "../state/agent-screens.ts";
import { useAgentScreens } from "../state/hooks.ts";
import { GraphSelection, isPartSelection, partOf, partSelection } from "./inspector/selection.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import { BuildStatus, type EarlierBuild, PlayButton, ZoomPill } from "./run-graph/chrome.tsx";
import { GateButton, GateTip, gateWords } from "./run-graph/gates.tsx";
import {
  AssetsTile,
  FinishCheckNode,
  JobsTile,
  LeadNode,
  OptimizationTile,
  ResultNode,
  StartNode,
  StepNode,
} from "./run-graph/nodes.tsx";
import { runProgress, useBuildsModel, useNow, useRunStills } from "./run-graph/use-builds-model.ts";
import { GLIDE_MS, useGraphCamera } from "./run-graph/use-graph-camera.ts";
import { Inspector, Lightbox, type LightItem, type Reply } from "./RunInspector.tsx";
import { type ReferenceFrame, useReferenceFrames } from "./run-stills.ts";
import { StageLoading } from "./stage/LiveLoaderArt.tsx";

export { gateWords } from "./run-graph/gates.tsx";
export { assetsStatus } from "./run-graph/nodes.tsx";

interface Props {
  graph: RunGraphModel;
  project: string | null;
  onShowLive?: () => void;
  onShowAsset?: (jobId: string) => void;
  /** Follow up in chat: the composer takes a chip naming the node; null when there is no chat to reply in. */
  onReply: ((reply: Reply) => void) | null;
  /** Set while an earlier build is shown: its name, and the way back to the latest one. */
  earlier?: EarlierBuild | null;
  /** The stage's toast channel: this panel's own Play/Make it live refuse for ordinary reasons. */
  onNotice: Notify;
}

type BuildsModel = ReturnType<typeof useBuildsModel>;
type Stills = ReturnType<typeof useRunStills>;
type LightState = { items: LightItem[]; index: number } | null;

/** Below this zoom a node is its picture and its status glyph; from NEAR it adds what it was asked. */
const FAR = 0.6;
const NEAR = 1.35;
/** The canvas's dot grid, in canvas pixels. */
const GRID_PX = 22;
/** The graph under an open node's card: still live and clickable, only quieter. */
const OPEN_CARD_OPACITY = 0.4;

const EDGE_INK = "color-mix(in oklab, var(--ink-3) 38%, var(--canvas))";
const EDGE: Record<string, { stroke: string; strokeDasharray?: string; strokeLinecap?: "round" }> = {
  solid: { stroke: EDGE_INK },
  pending: { stroke: EDGE_INK, strokeDasharray: "5 4" },
  dotted: { stroke: EDGE_INK, strokeDasharray: "1 4", strokeLinecap: "round" },
  live: { stroke: "var(--accent)", strokeDasharray: "4 4" },
};

/** How much a node shows at a zoom: its picture only, its words, or also what it was asked. */
function zoomLevel(k: number): "far" | "mid" | "near" {
  if (k < FAR) return "far";
  return k >= NEAR ? "near" : "mid";
}

/** Whether a key press landed in a field that owns its own keys. */
function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
}

/**
 * Whether ← or → walks the graph: only from the graph or its card (or nowhere in particular),
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

/**
 * What is open over the canvas — the selected node's panel (with the try whose judges' notes it
 * opened on, when a gate asked for them), the lightbox — and the gate tooltip.
 */
function useOverlays(selectable: string[]) {
  const [selectedId, setSelected] = useState<string | null>(null);
  const [notesFor, setNotesFor] = useState<string | null>(null);
  const [light, setLight] = useState<LightState>(null);
  const [tip, setTip] = useState<GatePoint | null>(null);
  const onGraph = (id: string): boolean => selectable.includes(id) || isPartSelection(id);
  const selected = selectedId && onGraph(selectedId) ? selectedId : null;
  /** Open a node's card (or close it with null); `notes` names the try whose judges' notes it opens on. */
  const setSelectedId = useCallback((id: string | null, notes: string | null = null) => {
    setSelected(id);
    setNotesFor(notes);
  }, []);
  const clear = useCallback(() => {
    setSelectedId(null);
    setLight(null);
  }, [setSelectedId]);
  const deselect = useCallback(() => setSelectedId(null), [setSelectedId]);
  return { selected, setSelectedId, deselect, notesFor, light, setLight, tip, setTip, clear };
}
type Overlays = ReturnType<typeof useOverlays>;

/** Escape closes the topmost overlay and stops there; 0 fits everything; ← and → walk an open node's neighbours. */
function useGraphKeys(overlays: Overlays, fitAll: () => void, step: (dir: number) => void): void {
  const { light, selected, setLight, setSelectedId } = overlays;
  useEffect(() => {
    /** Close the lightbox, else the panel; false when neither is open. */
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
      if (typingIn(event.target)) return;
      if (event.key === "Escape") {
        // One press, one dismissal: what this panel closes must not also reach the chat behind it.
        if (closeTopmost()) event.stopPropagation();
        else return;
      } else if (event.key === "0") {
        fitAll();
      } else walk(event);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fitAll, step, light, selected, setLight, setSelectedId]);
}

/** Previous and next walk the graph in reading order; from a part, next is its first step. */
function useStepper(overlays: Overlays, model: BuildsModel): (dir: number) => void {
  const { selected, setSelectedId } = overlays;
  const { rows, selectable } = model;
  return useCallback(
    (dir: number): void => {
      const facetId = partOf(selected);
      const first = facetId ? rows.find((row) => row.facet.facetId === facetId)?.steps[0]?.id : undefined;
      const next = first && dir > 0 ? first : ringStep(selectable, selectable.indexOf(first ?? selected ?? ""), dir);
      if (next) setSelectedId(next);
    },
    [rows, selectable, selected, setSelectedId],
  );
}

/** What a press on the canvas does: select a node, clear, or open a gate's node on its judges' notes. */
function useCanvasActions(overlays: Overlays, moved: { current: boolean }) {
  const { setSelectedId, setTip } = overlays;
  const select = useCallback(
    (id: string): void => {
      if (moved.current) return;
      setTip(null);
      setSelectedId(id);
    },
    [moved, setSelectedId, setTip],
  );
  const onBackgroundClick = useCallback((): void => {
    if (moved.current) return;
    setSelectedId(null);
    setTip(null);
  }, [moved, setSelectedId, setTip]);
  const openGate = useCallback(
    (gate: GatePoint, notesId: string | null): void => {
      if (moved.current) return;
      setTip(null);
      setSelectedId(gate.target, notesId);
    },
    [moved, setSelectedId, setTip],
  );
  return useMemo(() => ({ select, onBackgroundClick, openGate }), [select, onBackgroundClick, openGate]);
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
  const play = (): Promise<void> | void => {
    if (!project || !outcome?.head) return;
    return window.studio
      .showBuild(project, outcome.head)
      .then(() => onShowLive?.())
      .catch(notifyProblem(onNotice));
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

/** Over the hidden canvas until the run's recorded outcome arrives: the stage's loader. */
function OutcomePending(): JSX.Element {
  return (
    <div
      data-builds-loading
      className="stage-loader-late absolute inset-0 grid place-items-center p-8"
      style={{ visibility: "visible" }}
    >
      <StageLoading label="Loading builds" />
    </div>
  );
}

export const RunGraph = memo(function RunGraph({
  graph: suppliedGraph,
  project,
  onReply,
  earlier = null,
  onNotice,
  onShowLive,
  onShowAsset,
}: Props): JSX.Element {
  useEffect(() => markPerformance(PerformanceMarkName.GraphCommit));
  const model = useBuildsModel(suppliedGraph, project);
  const { graph, rows } = model;
  const references = useReferenceFrames(project, graph.runId);
  const stills = useRunStills(model);
  // The lead's own newest view of the game: the picture on its node while it has the run.
  const leadFrame = useAgentScreens((s) => leadFrameOf(s, project, graph.runId)) ?? null;
  const overlays = useOverlays(model.selectable);
  const { selected } = overlays;
  const camera = useGraphCamera({
    graph,
    ready: model.loaded,
    layout: model.layout,
    rows,
    live: frontier(rows),
    selected,
    onNewRun: overlays.clear,
    onDeselect: overlays.deselect,
  });
  const step = useStepper(overlays, model);
  useGraphKeys(overlays, camera.fitAll, step);
  const actions = useCanvasActions(overlays, camera.moved);
  const { hasBuild, play, openJob } = useBuildActions(project, model, { onShowLive, onShowAsset, onNotice });

  // Keep the viewport mounted for measurements/listeners while hiding non-authoritative fallback totals.
  return (
    <PerformanceBoundary id={PerformanceComponent.RunGraph}>
      <div
        data-stage-graph
        className="absolute inset-0 flex flex-col overflow-hidden bg-canvas select-none"
        style={{ visibility: model.loaded ? "visible" : "hidden" }}
      >
        {!model.loaded && <OutcomePending />}
        <BuildStatusClock
          model={model}
          earlier={earlier}
          action={
            hasBuild ? (
              <PlayButton quiet={graph.active} label={graph.active ? "Play latest" : "Play"} onPlay={play} />
            ) : null
          }
        />
        <div className="@container/stage relative flex min-h-0 flex-1 overflow-hidden">
          <div className="relative min-w-0 flex-1 overflow-hidden">
            <GraphCanvas
              model={model}
              camera={camera}
              project={project}
              stills={stills}
              leadFrame={leadFrame}
              selected={selected}
              tip={overlays.tip}
              onSelect={actions.select}
              onBackgroundClick={actions.onBackgroundClick}
              onOpenGate={actions.openGate}
              onTip={overlays.setTip}
            />
            <ZoomPill
              pct={Math.round(camera.view.k * 100)}
              onOut={camera.zoomOut}
              onIn={camera.zoomIn}
              onFit={camera.fitAll}
              onNow={camera.jumpToNow}
            />
          </div>

          {selected ? (
            <SelectedPanel
              key={selected}
              selection={selected}
              model={model}
              overlays={overlays}
              project={project}
              references={references}
              stills={stills}
              leadFrame={leadFrame}
              onStep={step}
              onOpenJob={openJob}
              onReply={onReply}
              onNotice={onNotice}
              onPlay={hasBuild ? play : null}
            />
          ) : null}

          <LightboxOf light={overlays.light} onLight={overlays.setLight} />
        </div>
      </div>
    </PerformanceBoundary>
  );
});

/** The inspector of the selected node, wired to the overlays it opens. */
function SelectedPanel({
  selection,
  model,
  overlays,
  project,
  references,
  stills,
  leadFrame,
  onStep,
  onOpenJob,
  onReply,
  onNotice,
  onPlay,
}: {
  selection: string;
  model: BuildsModel;
  overlays: Overlays;
  project: string | null;
  references: ReferenceFrame[];
  stills: Stills;
  leadFrame: AgentScreenFrame | null;
  onStep: (dir: number) => void;
  onOpenJob: (job: AssetInfo) => void;
  onReply: Props["onReply"];
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
      optimization={model.optimization}
      project={project}
      references={references}
      baseSrc={stills.baseSrc}
      resultSrc={stills.resultSrc}
      resultPath={stills.resultPath}
      resultBorrowed={stills.borrowed}
      leadFrame={leadFrame}
      onClose={() => overlays.setSelectedId(null)}
      onSelect={(id) => overlays.setSelectedId(id)}
      onPrev={() => onStep(-1)}
      onNext={() => onStep(1)}
      notesFor={overlays.notesFor}
      onLight={(items, index) => overlays.setLight({ items, index })}
      onOpenJob={onOpenJob}
      onReply={onReply}
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

// ── the canvas ────────────────────────────────────────────────────────────────────────────

/** Select the same reviewed try whether its gate opened before or after another step arrived. */
function gateNotesId(gate: GatePoint, model: BuildsModel): string | null {
  if (gate.gate === Gate.Looking) return null;
  const target = model.stepById.get(gate.target);
  const judged = target?.tries.filter(isJudgedTry) ?? [];
  const notes = target?.tries.find((node) => node.status === IterationStatus.Accepted) ?? judged.at(-1);
  return notes?.id ?? null;
}

/** The pannable, zoomable canvas: the edges, the row labels, the nodes and the judges' gates. */
function GraphCanvas({
  model,
  camera,
  project,
  stills,
  leadFrame,
  selected,
  tip,
  onSelect,
  onBackgroundClick,
  onOpenGate,
  onTip,
}: {
  model: BuildsModel;
  camera: ReturnType<typeof useGraphCamera>;
  project: string | null;
  stills: Stills;
  leadFrame: AgentScreenFrame | null;
  selected: string | null;
  tip: GatePoint | null;
  onSelect: (id: string) => void;
  onBackgroundClick: () => void;
  onOpenGate: (gate: GatePoint, notesId: string | null) => void;
  onTip: (gate: GatePoint | null) => void;
}): JSX.Element {
  const { graph, layout } = model;
  const { view, viewport, panning, onBackgroundDown, gliding } = camera;
  return (
    <div
      ref={viewport}
      data-zoom={zoomLevel(view.k)}
      className={`group/canvas absolute inset-0 ${panning ? "cursor-grabbing" : "cursor-grab"}`}
      onPointerDown={onBackgroundDown}
      onClick={onBackgroundClick}
    >
      <div
        ref={camera.grid}
        data-grid-scale={view.k}
        aria-hidden="true"
        className="pointer-events-none absolute top-0 left-0"
        style={{
          width: `calc(150% + ${GRID_PX * 2}px)`,
          height: `calc(150% + ${GRID_PX * 2}px)`,
          backgroundImage: "radial-gradient(var(--line-strong) 1px, transparent 1.25px)",
          backgroundSize: `${GRID_PX * view.k}px ${GRID_PX * view.k}px`,
          transform: gridTransform(view, view.k),
          transformOrigin: "0 0",
        }}
      />
      {/* An open node's card sits over this layer; the graph stays live and clickable, only quieter. */}
      <div
        ref={camera.layer}
        className="absolute top-0 left-0"
        style={{
          width: layout.width,
          height: layout.height,
          transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.k})`,
          transformOrigin: "0 0",
          opacity: selected ? OPEN_CARD_OPACITY : 1,
          transition: `opacity ${GLIDE_MS}ms var(--ease)${gliding ? `, transform ${GLIDE_MS}ms var(--ease)` : ""}`,
        }}
      >
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0 overflow-visible"
          width={layout.width}
          height={layout.height}
        >
          {layout.edges.map((edge) => (
            <path key={edge.id} d={edge.d} fill="none" strokeWidth={1.5} {...EDGE[edge.kind]} />
          ))}
        </svg>

        <RowLabels model={model} selected={selected} onSelect={onSelect} />
        <GraphNodes
          model={model}
          project={project}
          stills={stills}
          leadFrame={leadFrame}
          selected={selected}
          onSelect={onSelect}
        />

        {layout.gates.map((gate) => (
          <GateButton
            key={gate.target}
            gate={gate}
            notesId={gateNotesId(gate, model)}
            onOpen={onOpenGate}
            onTip={onTip}
          />
        ))}
        {tip ? <GateTip gate={tip} words={gateWords(tip, model.stepById.get(tip.target) ?? null, graph)} /> : null}
      </div>
    </div>
  );
}

/** Each part's title and meta over its row: pressing it opens the part's card. A part built in one session has no label. */
const RowLabels = memo(function RowLabels({
  model,
  selected,
  onSelect,
}: {
  model: BuildsModel;
  selected: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const { rows, layout, graph } = model;
  return (
    <>
      {rows.map((row) => {
        const rect = layout.rects[`row:${row.facet.facetId}`];
        if (!rect) return null;
        const meta = rowMeta(row, graph.active);
        const id = partSelection(row.facet.facetId);
        return (
          <button
            key={row.facet.id}
            type="button"
            data-graph-row={row.facet.facetId}
            aria-pressed={selected === id}
            className="absolute flex min-w-0 cursor-pointer items-baseline gap-1.5 overflow-hidden rounded-[6px] px-0.5 text-left whitespace-nowrap hover:[&>span:first-child]:underline focus-visible:outline-2 focus-visible:outline-accent group-data-[zoom=far]/canvas:hidden"
            style={{ left: rect.x - 2, top: rect.y, maxWidth: rect.w }}
            title={meta ? `${row.facet.title} · ${meta}` : row.facet.title}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(id);
            }}
          >
            <span className="min-w-0 truncate text-xs font-semibold text-ink">{row.facet.title}</span>
            {meta ? <span className="min-w-0 shrink-[3] truncate text-xs text-ink-3">{meta}</span> : null}
          </button>
        );
      })}
    </>
  );
});

/** Every node of the graph, from what you asked to your build (and in a tree, the finish check). */
const GraphNodes = memo(function GraphNodes({
  model,
  project,
  stills,
  leadFrame,
  selected,
  onSelect,
}: {
  model: BuildsModel;
  project: string | null;
  stills: Stills;
  leadFrame: AgentScreenFrame | null;
  selected: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const { graph, layout, optimization, leadNode, finishCheck } = model;
  const jobsRect = layout.rects[GraphSelection.Jobs];
  const finishRect = layout.rects[GraphSelection.FinishCheck];
  return (
    <>
      <StartNode
        run={model.run}
        base={model.base}
        rect={layout.rects.start}
        src={stills.baseSrc}
        active={graph.active}
        selected={selected === GraphSelection.Start}
        onSelect={() => onSelect(GraphSelection.Start)}
      />
      {layout.rects.assets ? (
        <AssetsTile
          blender={model.blender}
          assets={model.assets}
          project={project}
          rect={layout.rects.assets}
          active={graph.active}
          selected={selected === GraphSelection.Assets}
          onSelect={() => onSelect(GraphSelection.Assets)}
        />
      ) : null}
      {model.steps.map((node) => (
        <StepNode
          key={node.id}
          project={project}
          runId={graph.runId}
          active={graph.active}
          step={node}
          rect={layout.rects[node.id]}
          ghost={layout.ghosts.has(node.id)}
          selected={selected === node.id}
          onSelect={onSelect}
        />
      ))}
      {optimization && layout.rects.optimization ? (
        <OptimizationTile
          node={optimization}
          rect={layout.rects.optimization}
          selected={selected === GraphSelection.Optimization}
          onSelect={() => onSelect(GraphSelection.Optimization)}
        />
      ) : null}
      <ResultNode
        active={graph.active}
        status={stills.result}
        rect={layout.rects.final}
        src={stills.resultSrc}
        borrowed={stills.borrowed}
        selected={selected === GraphSelection.Final}
        onSelect={() => onSelect(GraphSelection.Final)}
      />
      {layout.rects.lead ? (
        <LeadNode
          rect={layout.rects.lead}
          frame={leadFrame}
          face={model.face ?? undefined}
          selected={selected === GraphSelection.Lead}
          onSelect={() => onSelect(GraphSelection.Lead)}
        />
      ) : null}
      {leadNode && jobsRect ? (
        <JobsTile
          jobs={leadNode.jobs}
          rect={jobsRect}
          selected={selected === GraphSelection.Jobs}
          onSelect={() => onSelect(GraphSelection.Jobs)}
        />
      ) : null}
      {finishCheck && finishRect ? (
        <FinishCheckNode
          node={finishCheck}
          rect={finishRect}
          selected={selected === GraphSelection.FinishCheck}
          onSelect={() => onSelect(GraphSelection.FinishCheck)}
        />
      ) : null}
    </>
  );
});

/** Only elapsed-time text ticks; the graph's nodes and camera stay untouched. */
function BuildStatusClock({
  model,
  earlier,
  action,
}: {
  model: BuildsModel;
  earlier: EarlierBuild | null;
  action: ReactNode;
}): JSX.Element {
  const now = useNow(model.graph.active);
  return (
    <BuildStatus
      status={statusLine(model.graph, model.outcome, model.rows, now)}
      earlier={earlier}
      progress={earlier ? null : runProgress(model, now)}
      action={action}
    />
  );
}
