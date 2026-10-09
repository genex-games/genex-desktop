import { mergeChatEvents } from "../shared/chat-history.ts";
import { CustomEvent, customEvent, customRecord, DELEGATED_PREFIX } from "../shared/custom-events.ts";
import { type ConversationRecord, type EventEnvelope, EventKind } from "../shared/event-log.ts";
import { RunState, runExecutions } from "../shared/run-state.ts";
import { summaryCounts, summaryOutcome } from "../shared/run-summary.ts";
import {
  type BaseNode,
  buildRunGraph,
  type FacetNode,
  type FinalNode,
  GraphNodeKind,
  hasMergedBuild,
  headVerdict,
  IterationStatus,
  type RunGraph,
  type RunNode,
} from "./run-graph.ts";
import {
  keptSoFarWords,
  loopRunWords,
  outcomeTitle,
  PROGRESS_WORDS,
  partsBuildingWords,
  partsFinishedWords,
  partsWaitingWords,
  verdictSentence,
} from "./words.ts";

/**
 * A run's worker threads. The harness names each one `<runId> · <part title>` when it creates it
 * (`thread.create` takes a title and no metadata), so the title is the one place the link between
 * a run, its part and the part's thread is recorded. Every lookup goes through these two.
 */
const workerTitlePrefix = (runId: string): string => `${runId} · `;

export function workerThreadsOf(threads: readonly ConversationRecord[], runId: string): ConversationRecord[] {
  return threads.filter((thread) => thread.title?.startsWith(workerTitlePrefix(runId)));
}

export function workerThreadFor(
  threads: readonly Pick<ConversationRecord, "id" | "title">[],
  runId: string,
  partTitle: string,
): Pick<ConversationRecord, "id" | "title"> | undefined {
  return threads.find((thread) => thread.title === `${workerTitlePrefix(runId)}${partTitle}`);
}

/** The `director_worker.mode` of a builder that works in one session, with no rounds. */
const SINGLE_SESSION_MODE = "single";

/** A delegated builder's mirrored record. */
const isDelegatedRecord = (e: EventEnvelope): boolean =>
  e.data.type === EventKind.Custom && e.data.event_type.startsWith(DELEGATED_PREFIX);

/** Whether an event belongs to the run on show: every event does when none is chosen or it names no run. */
const inSelectedRun = (runId: unknown, selectedRunId: string | null | undefined): boolean =>
  !selectedRunId || !runId || runId === selectedRunId;

/** Follow the selected conversation, including first-round starts in older worker logs. */
export function projectBuildGraph(
  events: EventEnvelope[],
  threadId: string | null,
  threads: readonly Pick<ConversationRecord, "id" | "title">[],
  runsRoot: string | null,
  selectedRunId?: string | null,
  options: { includeWorkers?: boolean; fold?: typeof buildRunGraph } = {},
): RunGraph | null {
  if (!threadId) return null;
  const parent = events.filter((e) => {
    if (e.thread_id !== threadId) return false;
    return inSelectedRun(customRecord(e.data)?.payload.runId, selectedRunId);
  });
  const fold = options.fold ?? buildRunGraph;
  const initial = fold(parent);
  if (!initial) return null;
  const starts =
    options.includeWorkers === false
      ? []
      : initial.facets.flatMap((facet) => firstRoundStart(events, parent, threads, initial.runId, facet));
  const graph = starts.length ? (fold(mergeChatEvents(parent, starts)) ?? initial) : initial;
  if (!graph.runDir && runsRoot) graph.runDir = `${runsRoot}/${graph.runId}`;
  return graph;
}

/** Single-session director workers have an explicit lifecycle, not a round loop. */
function isSingleSessionWorker(parent: EventEnvelope[], facetId: string): boolean {
  return parent.some((e) => {
    const worker = customEvent(e, CustomEvent.DirectorWorker);
    return worker !== null && worker.workerId === facetId && worker.mode === SINGLE_SESSION_MODE;
  });
}

/**
 * The start of a part's first round, read off the first mirrored record in its worker thread —
 * older worker logs never wrote one. A single-session worker gets none: a synthetic first round
 * would remain "building" even after the worker's done event.
 */
function firstRoundStart(
  events: EventEnvelope[],
  parent: EventEnvelope[],
  threads: readonly Pick<ConversationRecord, "id" | "title">[],
  runId: string,
  facet: FacetNode,
): EventEnvelope[] {
  if (isSingleSessionWorker(parent, facet.facetId)) return [];
  const started = parent.some((event) => {
    const start = customEvent(event, CustomEvent.FacetBuildStarted);
    return start?.facetId === facet.facetId && start.iteration === 1;
  });
  if (started) return [];
  const child = workerThreadFor(threads, runId, facet.title);
  if (!child) return [];
  const first = events.find((e) => e.thread_id === child.id && isDelegatedRecord(e));
  if (!first) return [];
  return [
    {
      ...first,
      id: `${first.id}:build-start`,
      data: {
        type: EventKind.Custom,
        event_type: CustomEvent.FacetBuildStarted,
        payload: { runId, facetId: facet.facetId, facetTitle: facet.title, iteration: 1 },
      },
    },
  ];
}

/** Records that open a run in the history, and records of one judged round. */
const RUN_OPEN_EVENTS = new Set<string>([CustomEvent.RunStarted, CustomEvent.RunRegistered]);
const ROUND_EVENTS = new Set<string>([CustomEvent.FacetIteration, CustomEvent.RunIteration]);

/** The conversation's builds, oldest first: when each started, how many rounds it ran, and where it stands (run-state.ts). */
export function buildHistory(
  events: EventEnvelope[],
  threadId: string | null,
): Array<{ runId: string; rounds: number; state: string; startedAt: string | null }> {
  const own = events.filter((e) => e.thread_id === threadId);
  const runs = new Map<string, { rounds: number; startedAt: string | null }>();
  for (const e of own) {
    if (e.data.type !== EventKind.Custom) continue;
    const id = customRecord(e.data)?.payload.runId;
    if (!id) continue;
    const run = runs.get(id);
    if (RUN_OPEN_EVENTS.has(e.data.event_type))
      runs.set(id, { rounds: run?.rounds ?? 0, startedAt: run?.startedAt ?? e.created_at });
    else if (run && ROUND_EVENTS.has(e.data.event_type)) run.rounds++;
  }
  const executions = runExecutions(own);
  return [...runs].map(([runId, run]) => ({
    runId,
    rounds: run.rounds,
    state: executions.get(runId)?.state ?? RunState.Running,
    startedAt: run.startedAt,
  }));
}

/** A build in the history picker: when it started, and its state unless it simply finished. */
export function historyLabel(run: { startedAt: string | null; state: string }, index: number): string {
  const date = run.startedAt ? new Date(run.startedAt) : null;
  const when =
    date && !Number.isNaN(date.getTime())
      ? `${date.toLocaleDateString([], { day: "numeric", month: "short" })}, ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : `Build ${index + 1}`;
  return run.state === RunState.Finished ? when : `${when} · ${run.state}`;
}

/**
 * The last thing anybody actually said about the build the run stands on.
 *
 * The Builds drawer used to open with a sentence about the run as a whole — "Inspect the final
 * result and recorded checks", "The starting point passed its checks" — beside a build the lead
 * had judged four times since. Every one of those looks now writes a sentence of its own
 * (`loop/verdict.ts`), and this is the newest of them; `buildProgress` is the fallback for a
 * run that has not been looked at yet, or one recorded before the records existed.
 */
export function buildVerdictLine(graph: RunGraph): string | null {
  return verdictSentence(headVerdict(graph)) || null;
}

type Progress = { nodeId: string; title: string; health: string; failedBase: boolean };

/**
 * What the Builds tab says is happening right now, in one title and one sentence.
 *
 * Two kinds of run reach this. A programmed run builds a shared base and then rounds inside
 * each part, so its phase is the base and then the rounds. A lead's run (`run.director`) has
 * no shared base unless it built a starting point of its own, and its builders are whole
 * sessions rather than rounds — so its phase is read off the builders themselves. Before this,
 * a lead's run said "Building the shared base · Checks pending" from dusk to dawn, because the
 * one event that ends that phase is emitted by a stage the lead does not have.
 */
export function buildProgress(graph: RunGraph): Progress {
  const progress = classicProgress(graph);
  // A live run with the recorded summary keeps the graph's own words for what is happening
  // ("2 parts building", "Building the starting point") and carries the outcome card's counts
  // on the same line, so the header and the card can never disagree on the numbers.
  if (graph.active && graph.summary)
    return { ...progress, health: `${progress.health} · ${summaryCounts(graph.summary)}` };
  return progress;
}

/** The graph's run, starting point and result nodes, when it has them. */
interface Landmarks {
  run: RunNode | undefined;
  base: BaseNode | undefined;
  final: FinalNode | undefined;
  failedBase: boolean;
}

function landmarks(graph: RunGraph): Landmarks {
  let run: RunNode | undefined;
  let base: BaseNode | undefined;
  let final: FinalNode | undefined;
  for (const node of graph.nodes) {
    if (node.kind === GraphNodeKind.Run) run ??= node;
    else if (node.kind === GraphNodeKind.Base) base ??= node;
    else if (node.kind === GraphNodeKind.Final) final ??= node;
  }
  return { run, base, final, failedBase: base?.ok === false };
}

function classicProgress(graph: RunGraph): Progress {
  const marks = landmarks(graph);
  if (!graph.active) return endedProgress(graph, marks);
  const optimization = graph.nodes.find((n) => n.kind === GraphNodeKind.Optimization);
  if (optimization?.kind === GraphNodeKind.Optimization && optimization.result.phase !== "pending") {
    const { outcome, summary } = optimization.result;
    return {
      nodeId: optimization.id,
      title: outcome ? PROGRESS_WORDS.optimizationFinished : PROGRESS_WORDS.optimization,
      health: outcome ? summary : PROGRESS_WORDS.optimizing,
      failedBase: marks.failedBase,
    };
  }
  if (marks.run?.director) return directorProgress(graph, marks);
  return loopProgress(graph, marks);
}

/** A run that is over: the recorded outcome when there is one, else the morning's own words. */
function endedProgress(graph: RunGraph, { run, final, failedBase }: Landmarks): Progress {
  if (graph.summary)
    return {
      nodeId: GraphNodeKind.Final,
      title: outcomeTitle(summaryOutcome(graph.summary)),
      health: summaryCounts(graph.summary),
      failedBase,
    };
  const loopRun = loopRunWords({
    rounds: graph.facets.reduce((total, facet) => total + facet.iterations, 0),
    landed: final ? final.landed : null,
    stoppedBecause: final ? final.stoppedBecause : null,
    // The same two facts the morning card reads: a paused run is not finished, and only a
    // run that merged something may be told it has a build to play.
    paused: run?.paused ?? false,
    hasBuild: hasMergedBuild(final ?? null),
    landing: final ? (final.landing?.line ?? null) : null,
  });
  return { nodeId: GraphNodeKind.Final, title: loopRun.headline, health: loopRun.because, failedBase };
}

/** The run's starting point while it is still being built. */
const startingPointOpen = (base: BaseNode | undefined): base is BaseNode => base !== undefined && !base.done;

/** A lead's run: its own starting point first, then its builders. */
function directorProgress(graph: RunGraph, { base, failedBase }: Landmarks): Progress {
  if (startingPointOpen(base) && !base.absent)
    return {
      nodeId: GraphNodeKind.Base,
      title: PROGRESS_WORDS.buildingStart,
      health: PROGRESS_WORDS.startBeforeParts,
      failedBase,
    };
  if (!graph.facets.length)
    return {
      nodeId: GraphNodeKind.Base,
      title: base?.done && base.ok ? PROGRESS_WORDS.startReady : PROGRESS_WORDS.gettingStarted,
      health: PROGRESS_WORDS.leadLooking,
      failedBase,
    };
  const building = graph.facets.filter((facet) => facet.building);
  if (!building.length)
    return {
      nodeId: GraphNodeKind.Base,
      title: PROGRESS_WORDS.betweenBuilds,
      health: partsFinishedWords(graph.facets.length),
      failedBase,
    };
  const kept = graph.facets.reduce((total, facet) => total + facet.accepted, 0);
  return {
    nodeId: building[0]?.id ?? GraphNodeKind.Base,
    title: partsBuildingWords(building.length),
    health: keptSoFarWords(kept, graph.facets.length - building.length),
    failedBase,
  };
}

/** A programmed run: the plan, then the shared starting point, then rounds inside each part. */
function loopProgress(graph: RunGraph, { base, failedBase }: Landmarks): Progress {
  if (!graph.facets.length && startingPointOpen(base))
    return {
      nodeId: GraphNodeKind.Base,
      title: PROGRESS_WORDS.planningParts,
      health: PROGRESS_WORDS.planOpens,
      failedBase,
    };
  if (base && !base.done)
    return {
      nodeId: GraphNodeKind.Base,
      title: PROGRESS_WORDS.buildingStart,
      health: partsWaitingWords(graph.facets.length),
      failedBase,
    };
  const activeRound = graph.nodes.find(
    (n) => n.kind === GraphNodeKind.Iteration && n.status === IterationStatus.Building,
  );
  const building = graph.facets.filter((facet) => facet.building);
  return {
    nodeId: activeRound?.id ?? building[0]?.id ?? GraphNodeKind.Base,
    title: building.length ? partsBuildingWords(building.length) : PROGRESS_WORDS.preparingBuilds,
    // What went wrong with the starting point is the harness's own diagnostic; it belongs in the
    // starting point's Details, not in the one line that says how the run is going.
    health: startingPointHealth(base, failedBase),
    failedBase,
  };
}

function startingPointHealth(base: BaseNode | undefined, failedBase: boolean): string {
  if (failedBase) return PROGRESS_WORDS.startRejected;
  return base?.empty ? PROGRESS_WORDS.startEmpty : PROGRESS_WORDS.startPassed;
}
