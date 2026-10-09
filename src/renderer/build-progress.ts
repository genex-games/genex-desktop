import { mergeChatEvents } from "../shared/chat-history.ts";
import { CustomEvent, customEvent, customRecord, DELEGATED_PREFIX } from "../shared/custom-events.ts";
import { type ConversationRecord, type EventEnvelope, EventKind } from "../shared/event-log.ts";
import { messageQueueState, type QueueView } from "../shared/message-queue.ts";
import { graphKeyOf, turnOfGraphKey } from "../shared/run-graph-events.ts";
import { RunState, runExecutions } from "../shared/run-state.ts";
import { summaryCounts, summaryOutcome } from "../shared/run-summary.ts";
import {
  answeringTurn,
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
  RUN_ID_EVENTS,
  runIdOf,
  turnKeyOf,
  WORKER_EVENTS,
} from "./run-graph.ts";
import { DayGroup, dayOf } from "./notifications.ts";
import {
  BUILD_HISTORY_WORDS,
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

/**
 * Whether an event belongs to the graph on show (a run, or a chat turn's key): every event does
 * when none is chosen or it names neither a run nor a turn.
 */
function inSelectedRun(
  payload: Record<string, unknown> | undefined,
  selectedRunId: string | null | undefined,
): boolean {
  const key = payload ? graphKeyOf(payload) : null;
  return !selectedRunId || !key || key === selectedRunId;
}

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
    return inSelectedRun(customRecord(e.data)?.payload, selectedRunId);
  });
  const fold = options.fold ?? buildRunGraph;
  const initial = fold(parent, selectedRunId ?? undefined);
  if (!initial) return null;
  // A chat turn's workers are pool sessions: they have no worker threads named after a run.
  const runId = runIdOf(initial);
  const starts =
    options.includeWorkers === false || !runId
      ? []
      : initial.facets.flatMap((facet) => firstRoundStart(events, parent, threads, runId, facet));
  const graph = starts.length ? (fold(mergeChatEvents(parent, starts), initial.runId) ?? initial) : initial;
  if (!graph.runDir && runsRoot && runId) graph.runDir = `${runsRoot}/${runId}`;
  return graph;
}

/**
 * The graph of the run the stage's Live answers to (its builds on offer, a build found broken, a
 * run building): the graph shown when it is a run's, else the newest run's. A chat turn's graph
 * has no build of its own; null when the chat has no run.
 */
export function stageRunGraph(
  events: EventEnvelope[],
  threadId: string | null,
  runsRoot: string | null,
  shown: RunGraph | null,
  history: readonly HistoryEntry[],
): RunGraph | null {
  if (!shown || runIdOf(shown)) return shown;
  const newestRun = history.filter((entry) => entry.chat !== true).at(-1)?.runId;
  if (!newestRun) return null;
  return projectBuildGraph(events, threadId, [], runsRoot, newestRun, { includeWorkers: false });
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

/**
 * A build in the conversation's history: a run (a Loop), or a chat turn that started workers
 * (`chat`, keyed by `turnGraphKey`). `runId` is the graph's key either way.
 */
export interface HistoryEntry {
  runId: string;
  rounds: number;
  state: string;
  startedAt: string | null;
  chat?: true;
}

/** A chat turn's workers while the history is read: those that started, and those that ended. */
interface TurnDraft {
  startedAt: string;
  started: Set<string>;
  ended: Set<string>;
}

/** Note one worker record of a chat turn; true when it is the turn's first, which opens it in the history. */
function readTurnRecord(
  turns: Map<string, TurnDraft>,
  key: string,
  e: EventEnvelope,
  payload: Record<string, unknown>,
): boolean {
  const workerId = typeof payload.workerId === "string" ? payload.workerId : "";
  if (!workerId) return false;
  const known = turns.get(key);
  const turn = known ?? { startedAt: e.created_at, started: new Set<string>(), ended: new Set<string>() };
  if (!known) turns.set(key, turn);
  const ended = e.data.type === EventKind.Custom && e.data.event_type === CustomEvent.WorkerFinished;
  (ended ? turn.ended : turn.started).add(workerId);
  return !known;
}

/**
 * Note one record of a run; true when it makes the run the newest build: it opens the run, or names
 * a run already open the way `lastGraphKey` reads it (a resume registers it again).
 */
function readRunRecord(
  runs: Map<string, { rounds: number; startedAt: string | null }>,
  id: string,
  eventType: string,
  at: string,
): boolean {
  const run = runs.get(id);
  if (RUN_OPEN_EVENTS.has(eventType)) {
    runs.set(id, { rounds: run?.rounds ?? 0, startedAt: run?.startedAt ?? at });
    return true;
  }
  if (run && ROUND_EVENTS.has(eventType)) run.rounds++;
  return run !== undefined && RUN_ID_EVENTS.has(eventType);
}

/** Make a build the newest of the history, wherever it stood. */
function moveLast(order: string[], key: string): void {
  const index = order.indexOf(key);
  if (index !== -1) order.splice(index, 1);
  order.push(key);
}

/** A chat turn works while one of its workers has started and not ended, or the lead still answers its message. */
function turnState(turn: TurnDraft, key: string, queue: QueueView): string {
  const working = [...turn.started].some((id) => !turn.ended.has(id));
  const message = turnOfGraphKey(key);
  const answering = message !== null && answeringTurn(queue, message);
  return working || answering ? RunState.Running : RunState.Finished;
}

/** The history while the log is read: the builds, newest last, and what each holds. */
interface HistoryDraft {
  order: string[];
  runs: Map<string, { rounds: number; startedAt: string | null }>;
  turns: Map<string, TurnDraft>;
}

/** Read one record into the history: a chat turn's worker record, or a run's. */
function readHistoryRecord(draft: HistoryDraft, e: EventEnvelope): void {
  if (e.data.type !== EventKind.Custom) return;
  const payload = customRecord(e.data)?.payload ?? {};
  const turnKey = WORKER_EVENTS.has(e.data.event_type) ? turnKeyOf(payload) : null;
  if (turnKey) {
    if (readTurnRecord(draft.turns, turnKey, e, payload)) draft.order.push(turnKey);
    return;
  }
  const id = typeof payload.runId === "string" ? payload.runId : "";
  if (id && readRunRecord(draft.runs, id, e.data.event_type, e.created_at)) moveLast(draft.order, id);
}

/**
 * The conversation's builds, oldest first: each run (when it started, how many rounds it ran,
 * where it stands, run-state.ts) and each chat turn that started workers (running while one of
 * them works). They stand in the order `lastGraphKey` reads newest by: a run at the last record
 * that names it as the shown run, a chat turn at its first worker record, so the last entry is
 * always the graph Builds shows by default.
 */
export function buildHistory(events: EventEnvelope[], threadId: string | null): HistoryEntry[] {
  const own = events.filter((e) => e.thread_id === threadId);
  const draft: HistoryDraft = { order: [], runs: new Map(), turns: new Map() };
  for (const e of own) readHistoryRecord(draft, e);
  const executions = runExecutions(own);
  const queue = messageQueueState(own);
  return draft.order.map((key): HistoryEntry => {
    const turn = draft.turns.get(key);
    if (turn)
      return { runId: key, rounds: 0, state: turnState(turn, key, queue), startedAt: turn.startedAt, chat: true };
    const run = draft.runs.get(key) ?? { rounds: 0, startedAt: null };
    return {
      runId: key,
      rounds: run.rounds,
      state: executions.get(key)?.state ?? RunState.Running,
      startedAt: run.startedAt,
    };
  });
}

/** The day a build started, as its history label says it: "today", "yesterday", else "5 Sep"; null when unknown. */
function dayWords(startedAt: string | null, now: Date): string | null {
  const date = startedAt ? new Date(startedAt) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  const day = dayOf(startedAt ?? "", now);
  if (day === DayGroup.Today) return BUILD_HISTORY_WORDS.today;
  if (day === DayGroup.Yesterday) return BUILD_HISTORY_WORDS.yesterday;
  return date.toLocaleDateString([], { day: "numeric", month: "short" });
}

/** What a build in the history is called: "This chat turn" for the newest build, else by its day: "Loop from yesterday". */
function historyName(entry: HistoryEntry, newest: boolean, now: Date): string {
  const chat = entry.chat === true;
  const day = newest ? null : dayWords(entry.startedAt, now);
  if (!day) return chat ? BUILD_HISTORY_WORDS.thisTurn : BUILD_HISTORY_WORDS.thisLoop;
  return chat ? BUILD_HISTORY_WORDS.turnFrom(day) : BUILD_HISTORY_WORDS.loopFrom(day);
}

/**
 * A build in the history, in plain words: what it was and when, then its state unless it simply
 * finished ("Loop from yesterday · paused"). `newest`: it is the latest build in the history.
 */
export function historyLabel(
  entry: HistoryEntry,
  { newest, now = new Date() }: { newest: boolean; now?: Date },
): string {
  const name = historyName(entry, newest, now);
  return entry.state === RunState.Finished ? name : `${name} · ${entry.state}`;
}

/**
 * Whether a build is the latest in the history: only it is "this" one; an earlier build of either
 * kind is named by its day, as a Loop before a newer chat turn is.
 */
export const isNewestBuild = (history: readonly HistoryEntry[], entry: HistoryEntry): boolean =>
  history.at(-1) === entry;

/** What a reply about a node of this graph names: its run and whether it is live; null for a chat turn's graph. */
export function replyTarget(graph: RunGraph): { runId: string; active: boolean } | null {
  const runId = runIdOf(graph);
  return runId ? { runId, active: graph.active } : null;
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
