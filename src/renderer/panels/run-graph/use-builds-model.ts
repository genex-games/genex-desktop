/** Everything the Builds tab draws, folded once from the run's graph, its recorded outcome and the game's assets. */
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { SECOND_MS } from "../../../shared/duration.ts";
import { workedMs } from "../../../shared/run-state.ts";
import {
  type AssetsNode,
  type BaseNode,
  type BlenderNode,
  buildRunGraph,
  type FinishCheckNode,
  joinBuildsView,
  GraphNodeKind,
  type IntegrationNode,
  type IterationNode,
  type OptimizationNode,
  type RunGraph as RunGraphModel,
  type RunNode,
  runIdOf,
  RunStillStage,
  runStillPath,
  thumbShot,
} from "../../run-graph.ts";
import { leadWorking, partRows, resultStatus, StepState } from "../../run-steps.ts";
import { buildsLayout, graphLoaded, leadFace, leadNodeOf, readingNodes, readingOrder } from "../../run-tree.ts";
import { useLibrary } from "../../state/hooks.ts";
import { assetsOf } from "../../state/library.ts";
import { studio } from "../../state/studio.ts";
import { useStill } from "../../stills.ts";
import { useSharedSnapshot } from "../../use-shared-snapshot.ts";
import { useRunSummary } from "../../use-run-summary.ts";
import { useRoundStill } from "../run-stills.ts";

/** How often the status bar's elapsed time moves while the run does. */
const CLOCK_TICK_MS = 30 * SECOND_MS;

type BuildsOutcome = ReturnType<typeof useRunSummary>;

/** A clock for the status bar's elapsed time; it only ticks while the run does. */
export function useNow(live: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    // A run that goes live (resumed, or shown again) counts from now, not from when the clock last stopped.
    setNow(Date.now());
    const timer = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

/** The run's own node: every graph has one. */
function runNodeOf(graph: RunGraphModel): RunNode {
  const run = graph.nodes.find((node): node is RunNode => node.kind === GraphNodeKind.Run);
  if (!run) throw new Error(`run graph ${graph.runId} has no run node`);
  return run;
}

/** The first node of one kind, when the graph has it. */
function nodeOfKind<T extends RunGraphModel["nodes"][number]>(graph: RunGraphModel, kind: T["kind"]): T | null {
  return graph.nodes.find((node): node is T => node.kind === kind) ?? null;
}

/** The Builds tab's model: the graph as the outcome and the asset inventory see it, its rows and its layout. */
function useBuildGraph(suppliedGraph: RunGraphModel, project: string | null) {
  const outcome = useDeferredValue(useSharedSnapshot(useRunSummary(project, runIdOf(suppliedGraph))));
  const deferredGraph = useDeferredValue(suppliedGraph);
  // The game's asset inventory, from the library store's one watch (shared with the Assets stage).
  useEffect(() => (project ? studio().library.watchAssets(project) : undefined), [project]);
  const assetInventory = useLibrary((s) => assetsOf(s, project).value);
  const restored = useMemo(() => (outcome?.graphEvents ? buildRunGraph(outcome.graphEvents) : null), [outcome]);
  const source = restored ?? deferredGraph;
  const graph = useSharedSnapshot(
    useMemo<RunGraphModel>(() => joinBuildsView(source, outcome, assetInventory), [source, outcome, assetInventory]),
  );
  return { graph, outcome };
}

/** Derive rows and geometry from a structurally shared run snapshot. */
export function useBuildsModel(suppliedGraph: RunGraphModel, project: string | null) {
  const { graph, outcome } = useBuildGraph(suppliedGraph, project);
  const run = runNodeOf(graph);
  const base = nodeOfKind<BaseNode>(graph, GraphNodeKind.Base);
  const blender = useMemo(() => nodeOfKind<BlenderNode>(graph, GraphNodeKind.Blender), [graph]);
  const assets = useMemo(() => nodeOfKind<AssetsNode>(graph, GraphNodeKind.Assets), [graph]);
  const optimization = useMemo(() => nodeOfKind<OptimizationNode>(graph, GraphNodeKind.Optimization), [graph]);
  const finishCheck = useMemo(() => nodeOfKind<FinishCheckNode>(graph, GraphNodeKind.FinishCheck), [graph]);
  const loaded = graphLoaded(graph, outcome);
  const leadNode = useMemo(() => leadNodeOf(graph), [graph]);
  const rows = useSharedSnapshot(useMemo(() => partRows(graph, outcome), [graph, outcome]));
  // Between parts the lead has the run; its node keeps the graph from looking finished.
  const lead = useMemo(() => leadWorking(graph, outcome, rows), [graph, outcome, rows]);
  // A tree draws the lead for the whole run, saying what it is doing.
  const face = useMemo(() => (graph.tree ? leadFace(graph, outcome, rows) : null), [graph, outcome, rows]);
  const layout = useSharedSnapshot(useMemo(() => buildsLayout(graph, rows, outcome), [graph, rows, outcome]));
  const steps = useMemo(() => rows.flatMap((row) => row.steps), [rows]);
  const stepById = useMemo(() => new Map(steps.map((step) => [step.id, step] as const)), [steps]);
  const rounds = useMemo(
    () => graph.nodes.filter((node): node is IterationNode => node.kind === GraphNodeKind.Iteration),
    [graph],
  );
  const roundById = useMemo(() => new Map(rounds.map((node) => [node.id, node] as const)), [rounds]);
  /** Every node Previous and Next step through, in the graph's reading order. */
  const selectable = useMemo(() => readingOrder(rows, readingNodes(graph, rows, outcome)), [rows, graph, outcome]);
  return useMemo(
    () => ({
      outcome,
      loaded,
      graph,
      run,
      base,
      blender,
      assets,
      optimization,
      finishCheck,
      leadNode,
      face,
      rows,
      lead,
      layout,
      steps,
      stepById,
      rounds,
      roundById,
      selectable,
    }),
    [
      outcome,
      loaded,
      graph,
      run,
      base,
      blender,
      assets,
      optimization,
      finishCheck,
      leadNode,
      face,
      rows,
      lead,
      layout,
      steps,
      stepById,
      rounds,
      roundById,
      selectable,
    ],
  );
}

/** Where the run's starting still is: the outcome's capture, else the run folder's. */
const baseStillOf = (graph: RunGraphModel, outcome: BuildsOutcome): string | null =>
  outcome?.captures?.base ?? (graph.runDir ? runStillPath(graph.runDir, RunStillStage.Base) : null);

/** Where the run's final still is: the outcome's capture, else — once the run is over — the run folder's. */
const finalStillOf = (graph: RunGraphModel, outcome: BuildsOutcome): string | null =>
  outcome?.captures?.current ??
  (!graph.active && graph.runDir ? runStillPath(graph.runDir, RunStillStage.Final) : null);

/** The part a lead's merge brought in last: a lead's merge names no round, only its part. */
function newestMergedPart(graph: RunGraphModel): string | null {
  const integration = graph.nodes.find((node): node is IntegrationNode => node.kind === GraphNodeKind.Integration);
  const merge = integration?.merges.findLast((item) => !item.conflict && item.facetId);
  return merge?.facetId ?? null;
}

/**
 * The run's two stills: where it started, and its build now — the final capture, else the last
 * merged try's, else (a lead's merge names no round) the picture of the part it merged last. A
 * build still being tried shows that borrowed picture softened, never as the build's own.
 */
export function useRunStills(model: ReturnType<typeof useBuildsModel>) {
  const { graph, outcome, base, roundById } = model;
  const baseStillPath = baseStillOf(graph, outcome);
  const baseSrc = useStill(
    baseStillPath ? { run: baseStillPath, maxPx: 640, retry: `${graph.runDir}:${baseStillPath}:${base?.done}` } : null,
  );
  const merged = graph.lastMerged;
  const lastMergedRound = merged ? (roundById.get(`iter:${merged.facetId}:${merged.iteration}`) ?? null) : null;
  const finalStillPath = finalStillOf(graph, outcome);
  const finalSrc = useStill(
    finalStillPath ? { run: finalStillPath, maxPx: 640, retry: `${graph.runId}:${outcome?.head}` } : null,
  );
  const mergedShot = lastMergedRound ? thumbShot(lastMergedRound) : null;
  const mergedPath = finalSrc ? null : (mergedShot?.path ?? null);
  const mergedSrc = useStill(mergedPath ? { run: mergedPath, maxPx: 640 } : null);
  const newestPart = useMemo(() => newestMergedPart(graph), [graph]);
  // No part named: nothing to ask for while the build has a picture of its own.
  const partSrc = useRoundStill(graph, finalSrc || mergedShot ? "" : (newestPart ?? ""), 1, null, false);
  const result = useMemo(() => resultStatus(graph, outcome), [graph, outcome]);
  const resultSrc = finalSrc ?? mergedSrc ?? partSrc;
  const resultPath = finalSrc ? finalStillPath : (mergedShot?.path ?? null);
  const borrowed = result.state === StepState.Judging && !finalSrc;
  return useMemo(
    () => ({
      baseSrc,
      resultSrc,
      resultPath,
      result,
      borrowed,
    }),
    [baseSrc, resultSrc, resultPath, result, borrowed],
  );
}

/**
 * How much of the time it was given a live run has worked (run-state.ts `RunWorked`), 0 to 1; null
 * when it has no budget, its start is unknown or it is not running.
 */
export function runProgress(model: ReturnType<typeof useBuildsModel>, now: number): number | null {
  const { graph, run, outcome } = model;
  const budget = run.durationMs ?? null;
  if (!graph.active || !budget || !outcome?.worked) return null;
  return Math.min(1, Math.max(0, workedMs(outcome.worked, now) / budget));
}
