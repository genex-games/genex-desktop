import type { RunGraphEvent } from "../shared/run-graph-events.ts";
/**
 * Run graph — the pure data model behind the Build room's node-graph view of an Autopilot run.
 *
 * Everything here is derived from the thread's event log alone (the log is the source of truth),
 * with no DOM in sight, so the shape of the graph and its layout can be unit-tested.
 * `panels/RunGraph.tsx` renders it.
 *
 *   Run → Base → Facet (one column each) → iteration 1 → iteration 2 → … → Integration → Final
 *
 * plus dashed cross-edges for defects the judge routed to another facet and for builder flags
 * that name a target facet. `run-steps.ts` folds it into what the Builds tab draws. The payload
 * readers live in `run-graph-parse.ts` and the asset cards in `run-graph-assets.ts`.
 */
import { CustomEvent } from "../shared/custom-events.ts";
import { HOUR_MS } from "../shared/duration.ts";
import type { EventEnvelope } from "../shared/event-log.ts";
import type { ProjectAsset, ProjectAssets } from "../shared/game-assets.ts";
import { normalizeOptimization, type OptimizationResultV1 } from "../shared/optimization.ts";
import {
  executionStep,
  isExecutionEvent,
  RoundOutcome,
  type RunExecution,
  RunState,
  recordedRunLoop,
  roundOutcome,
} from "../shared/run-state.ts";
import type { RunSummary } from "../shared/run-summary.ts";
import {
  type AssetLedger,
  type AssetPlace,
  assetCallReturned,
  assetDelivered,
  assetRequested,
  blenderAsset,
  keptAssetJobs,
  newAssetLedger,
} from "./run-graph-assets.ts";
import {
  bool,
  customOf,
  num,
  type Payload,
  parseDiffs,
  parseFix,
  parseFlags,
  parseLiveness,
  parseMerge,
  parseMove,
  parseScoreboard,
  parseAdvice,
  parseShots,
  parseVerdict,
  record,
  records,
  str,
  strings,
  strOrNull,
} from "./run-graph-parse.ts";
import { ABANDONED_ROUND_LABEL, buildingRoundLabel, verdictLabel } from "./words.ts";

export { digestField } from "./run-graph-parse.ts";

// ── nodes ─────────────────────────────────────────────────────────────────────────────────

/** What a node of the graph stands for. Every node but a part or a round is the only one of its kind, and has its kind as its id. */
export const GraphNodeKind = {
  Run: "run",
  Base: "base",
  Facet: "facet",
  Iteration: "iteration",
  Integration: "integration",
  Optimization: "optimization",
  Final: "final",
  Blender: "blender",
  Assets: "assets",
} as const;
export type GraphNodeKind = (typeof GraphNodeKind)[keyof typeof GraphNodeKind];
/** `building` = a move/fix/liveness was asked for the iteration but no verdict has landed yet;
 * `stopped` = the lead ended it mid-build, so no judge ever saw it and nothing was rolled back;
 * `unjudged` = it finished, but no winner was recorded, so it was neither kept nor undone;
 * `abandoned` = the run finished while it was still in that state. */
export const IterationStatus = {
  Accepted: "accepted",
  Rolled: "rolled",
  Building: "building",
  Stopped: "stopped",
  Unjudged: "unjudged",
  Abandoned: "abandoned",
} as const;
export type IterationStatus = (typeof IterationStatus)[keyof typeof IterationStatus];

/** A judged round's status, from the one outcome rule in `shared/run-state.ts`. */
const STATUS_OF: Record<RoundOutcome, IterationStatus> = {
  [RoundOutcome.Accepted]: IterationStatus.Accepted,
  [RoundOutcome.Rejected]: IterationStatus.Rolled,
  [RoundOutcome.Stopped]: IterationStatus.Stopped,
  [RoundOutcome.Unevaluated]: IterationStatus.Unjudged,
};

export interface CheckResult {
  id: string;
  kind: string;
  weight: string;
  /** null = unmeasured */
  pass: boolean | null;
  reason: string;
}

export interface Scoreboard {
  total: number;
  passing: number;
  unmeasured: number;
  /**
   * The checks the plan and the harness wrote, counted apart from the questions a judge grew
   * from its own defect list (`grownTotal`). Null on a run from before the loop split them.
   */
  plannedTotal: number | null;
  plannedPassing: number | null;
  plannedUnmeasured: number | null;
  grownTotal: number | null;
  identityTotal: number | null;
  identityPassing: number | null;
  flips: string[];
  /** `flips` minus the judge's own grown questions; null on a run from before the split. */
  plannedFlips: string[] | null;
  regressions: string[];
  results: CheckResult[];
}

/**
 * One judged build, whoever judged it — the shape `loop/verdict.ts` writes for a worker's round
 * (`facet_iteration.verdict`) and for each of the lead's own passes (`director_verdict`). Its
 * `because` is already the owner's sentence; the renderer shows it, never rewrites it.
 */
export interface VerdictRecord {
  /** which pass looked: a worker's round, a fork gate, the lead's judge, a health pass, the close */
  pass: string;
  at: string | null;
  build: { head: string | null; worker: string | null; round: number | null };
  against: { head: string | null; what: string | null };
  observed: {
    ok: boolean | null;
    problems: string[];
    cameras: string[];
    demos: string[];
    consoleFresh: string[];
    consoleInherited: string[];
  };
  measured: {
    planned: CheckResult[];
    grown: CheckResult[];
    flips: string[];
    regressions: string[];
    unmeasured: string[];
  };
  seen: {
    pick: string | null;
    veto: boolean | null;
    satisfied: boolean | null;
    question: string | null;
    answer: boolean | null;
    alive: number | null;
    aliveMax: number | null;
    judgeCalls: number;
  };
  decision: { kept: boolean | null; rule: string };
  /** one sentence, written by the pass that judged it, with no id, sha or harness word in it */
  because: string;
}

export interface MoveInfo {
  what: string;
  source: string | null;
  milestoneId: string | null;
  delivered: boolean | null;
  scale: string | null;
}

export interface FixInfo {
  what: string;
  checkId: string | null;
  streak: number | null;
  /** THE FIX: a build that leaves it unfixed loses */
  mandatory: boolean | null;
  delivered: boolean | null;
}

/** A note the user sent from the Builds tab (`user_feedback`), pinned to a round when it named one. */
export interface NoteInfo {
  id: string;
  facetId: string | null;
  iteration: number | null;
  camera: string | null;
  text: string;
  at: string;
  /** the first round of that part judged after the note went in — null until one lands */
  landedIn: number | null;
}

export interface Principle {
  key: string;
  title: string | null;
  score: number | null;
  reason: string;
  fix: string;
}

export interface Liveness {
  /** Which critic answered: "place" (a world you stand in) or "screen" (a board, a puzzle, a builder). */
  critic: string | null;
  total: number | null;
  max: number | null;
  biggest: string | null;
  summary: string | null;
  principles: Principle[];
}

export interface FlagInfo {
  what: string;
  checkId: string | null;
  target: string | null;
}

export interface OutageInfo {
  count: number;
  phase: string | null;
  lastError: string | null;
}

export interface Shot {
  camera: string;
  path: string;
}

/**
 * A critic's fresh look at a round the lead saved (`director_verdict` with `advice: true`): what it
 * saw wrong with the fix for each, one bold move, and its answers to the lead's gates. It is
 * advice: it decided nothing, so it is never a verdict.
 */
export interface AdviceInfo {
  at: string;
  defects: Array<{ defect: string; fix: string }>;
  boldMove: string;
  gates: string[];
  shots: string[];
}

export interface DiffInfo {
  camera: string;
  diffFraction: number | null;
  heatmapPath: string | null;
}

export interface MergeInfo {
  /** the part it belongs to, after a restart is folded into the part it replaced */
  facetId: string;
  iteration: number | null;
  /** when the merge landed: a lead's merge names no round, only a moment */
  at: string;
  /** its place in the log — what a lead's merge is ordered by against the rounds around it */
  seq: number;
  head: string | null;
  conflict: boolean;
  union: boolean;
  stage: string | null;
}

export interface TrendPoint {
  iteration: number;
  passing: number | null;
  total: number | null;
  alive: number | null;
  aliveMax: number | null;
}

export interface RunNode {
  kind: "run";
  id: "run";
  runId: string;
  project: string | null;
  goal: string;
  reference: { name: string; kind: string | null } | null;
  durationMs?: number;
  startedAt: string | null;
  finishedAt: string | null;
  active: boolean;
  victory: boolean | null;
  stoppedBecause: string | null;
  decisions: string[];
  maxParallel: number | null;
  engine: string | null;
  model: string | null;
  builderEngine: string | null;
  /** labels of the reference stills the run was given */
  referenceFrames: string[];
  /**
   * A run the lead runs itself (`autopilot_started.director`). It has no shared-base stage
   * unless it built a starting point of its own, and its builders are single sessions rather
   * than rounds — so the base node and the progress line read differently.
   */
  director: boolean;
  /**
   * The run stopped where it can be picked up again — the engine's limit, a quit, a crash
   * (`autopilot_paused`). It is not over, and no surface may call it finished.
   */
  paused: boolean;
}

export interface BaseNode {
  kind: "base";
  id: "base";
  done: boolean;
  ok: boolean | null;
  commit: string | null;
  error: string | null;
  planReviewed: boolean;
  empty?: boolean;
  outages: number;
  /**
   * There was never a shared base to build: a lead's run that started from the game as it
   * stands. Without this the card pulses "Building the ground every part starts from…" for the whole
   * run, because `autopilot_base` — which only a base stage emits — never arrives.
   */
  absent: boolean;
}

export interface FacetNode {
  kind: "facet";
  id: string;
  facetId: string;
  title: string;
  /** plan order — also picks the colour */
  index: number;
  budgetShare: number | null;
  plannedChecks: number | null;
  stoppedBecause: string | null;
  satisfied: boolean | null;
  iterations: number;
  accepted: number;
  rolled: number;
  building: boolean;
  trend: TrendPoint[];
  checksAdded: number;
  replans: number;
  outages: number;
  /** A sub-agent's files are in the game folder, waiting for the lead to use them (`director_worker.delivered`). */
  delivered: boolean;
  /** A single-session worker's session ended in failure, so it delivered nothing (`director_worker.state` failed). */
  failed: boolean;
}

export interface IterationNode {
  activityAt?: string;
  kind: "iteration";
  id: string;
  facetId: string;
  facetTitle: string;
  facetIndex: number;
  iteration: number;
  status: IterationStatus;
  /** the FACET-card wording ("kept — verified checks flipped", "rolled back — taste veto", …) */
  verdictLabel: string;
  verdictSource: string | null;
  winner: string | null;
  satisfied: boolean;
  reason: string;
  biggestGap: string;
  defects: string[];
  unmeasured: string[];
  scoreboard: Scoreboard | null;
  move: MoveInfo | null;
  fix: FixInfo | null;
  liveness: Liveness | null;
  flags: FlagInfo[];
  routedOut: number;
  routedIn: number;
  outage: OutageInfo | null;
  shots: Shot[];
  diffs: DiffInfo[];
  merge: MergeInfo | null;
  /** when the verdict landed */
  judgedAt: string | null;
  /** the first record of this round — when the builder started on it */
  startedAt: string | null;
  /** the places in the log of this round's first record and of its verdict */
  startedSeq: number;
  judgedSeq: number | null;
  notes: NoteInfo[];
  /** The round's own verdict record — null on a run from before the round wrote one. */
  verdict: VerdictRecord | null;
  /** The critic's advice on this round, when the lead asked for it: never a verdict. */
  advice: AdviceInfo | null;
}

export interface IntegrationNode {
  kind: "integration";
  id: "integration";
  merges: MergeInfo[];
  conflicts: number;
  unions: number;
  ledger: { pick: string | null; reason: string; defects: string[] } | null;
}

export interface FinalNode {
  kind: "final";
  id: "final";
  done: boolean;
  victory: boolean | null;
  stoppedBecause: string | null;
  globalVerdict: { pick: string | null; reason: string; biggestGap: string; defects: string[] } | null;
  facets: Array<{
    facetId: string;
    stoppedBecause: string | null;
    iterations: number | null;
    satisfied: boolean | null;
  }>;
  /** The run's own report to the user, in its words — `reportSummary` says where it comes from. */
  summary: string | null;
  /** Did the run's merged build reach the live game folder (null until the run closes)? */
  landed: boolean | null;
  /** The merged build's commit — playable and landable after the run, landed or not. */
  integrationHead: string | null;
  /** Where the run started; a head equal to it holds nothing to play. */
  baseCommit: string | null;
  /**
   * What the close made of the landing: whether a judge of that exact build preferred it
   * (`verified`), which rule landed it (`how`, a token) and the sentence the close wrote for the
   * user (`line`). A run that landed a head no judge ever looked at must not read like one a
   * judge chose, and this is the only record of the difference.
   */
  landing: { verified: boolean; how: string | null; line: string | null } | null;
}

/**
 * Where an asked-for asset is, from the log's point of view. `requested` is the call going out,
 * `generating` is a job the plugin accepted and has not delivered yet, and the two end states
 * are the only ones that say what happened. A call that delivers nothing never becomes a card.
 */
export type AssetState = "requested" | "generating" | "delivered" | "failed";

/**
 * One asset the run asked for: a `blender_asset` event, or a plugin tool call joined to its
 * delivery (`plugin_tool_started` → `asset_delivered` → `plugin_tool`, on `callId`, then `jobId`
 * and the remote `generationId`).
 * Blender fills the render and geometry fields; a plugin fills the job fields. `ok` is derived
 * from `state`, so the modeller's card, its drawer and its lightbox read exactly as before.
 */
export interface AssetInfo {
  /** the Assets stage's record of this asset, for its thumbnail; set by the Builds page */
  preview?: ProjectAsset;
  /** a copy is in the game itself, not only in a build workspace */
  inGame?: boolean;
  generationId?: string;
  name: string;
  file: string | null;
  bytes: number;
  /** absolute path of the render PNG under the run folder, readable via `readRunStill` */
  render: string | null;
  /** the second view (front), beside the first; null for events written before it existed */
  renderFront: string | null;
  facetId: string | null;
  iteration: number | null;
  ok: boolean;
  error: string | null;
  polygons: number | null;
  /** what the GPU draws per instance — the number that matters when an asset is placed many times */
  triangles: number | null;
  at: string;
  /** `blender`, or the id of the plugin that was asked */
  source: string;
  /** the plugin's display name — what a card may print, where the id is not */
  pluginName: string | null;
  /** the plugin call this came from; null for a Blender asset */
  callId: string | null;
  /** the id a delivery joins on; null until the plugin names one */
  jobId: string | null;
  state: AssetState;
  /** game-relative paths that landed, once they have */
  files: string[];
  /** the arguments digest the host wrote, and the two fields worth their own line */
  args: string;
  prompt: string | null;
  operation: string | null;
  /** the bare tool name the plugin declared (`asset`) */
  tool: string | null;
  /** the latest in-game check of this asset (`inspect_use`/`verify_use`), when one ran */
  check?: { ok: boolean; error: string | null; at: string };
  /** plugin work done on this asset (a Blender inspection or re-export): a step, not a new asset */
  derived?: Array<{
    pluginName: string | null;
    name: string;
    files: string[];
    size: number[] | null;
    triangles: number | null;
    at: string;
  }>;
}

/** Every asset job this run asked a plugin for, oldest first — one card each, under the modeller. */
export interface AssetsNode {
  kind: "assets";
  id: "assets";
  jobs: AssetInfo[];
}

/** The modeller (AG-930): present when the run had Blender, whether or not anything was modelled. */
export interface BlenderNode {
  kind: "blender";
  id: "blender";
  version: string | null;
  assets: AssetInfo[];
}

export interface OptimizationNode {
  kind: "optimization";
  id: "optimization";
  result: OptimizationResultV1;
}

export type GraphNode =
  | RunNode
  | BaseNode
  | FacetNode
  | IterationNode
  | IntegrationNode
  | OptimizationNode
  | FinalNode
  | BlenderNode
  | AssetsNode;

/** A plain flow edge, a defect the judge routed to another part, or a builder's flag naming one. */
export const EdgeKind = { Flow: "flow", Routed: "routed", Flag: "flag" } as const;
export type EdgeKind = (typeof EdgeKind)[keyof typeof EdgeKind];

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  /** how many routed defects / flags this edge stands for */
  count: number;
}

export interface RunGraph {
  summary?: RunSummary;
  runId: string;
  active: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** plan order */
  facets: FacetNode[];
  /** every note the user sent during this run, oldest first */
  notes: NoteInfo[];
  /** the run's artefact folder, read off the first still's path — null until a still exists */
  runDir: string | null;
  /** the last accepted round merged into the shared build */
  lastMerged: { facetId: string; iteration: number } | null;
  /**
   * The newest commit on the shared build, with the time it landed and whether anything has
   * confirmed it runs (`integration_health`; null when nobody looked). This is the build the
   * stage can offer the user while the run is still going.
   */
  mergedHead: { head: string; at: string; healthy: boolean | null } | null;
  /**
   * Every build the lead judged this run, oldest first — its fork gates, its judge, its health
   * passes and its close. The Builds drawer shows the newest one about the build on the stage
   * instead of a sentence about the run.
   */
  verdicts: VerdictRecord[];
}

export const FACET_PALETTE = ["#9a5cff", "#f09a2f", "#2fbfb0", "#f0567a", "#4f8cff", "#5ccf6b"] as const;

export function facetColor(index: number): string {
  return FACET_PALETTE[((index % FACET_PALETTE.length) + FACET_PALETTE.length) % FACET_PALETTE.length];
}

export const iterationNodeId = (facetId: string, iteration: number): string => `iter:${facetId}:${iteration}`;
export const facetNodeId = (facetId: string): string => `facet:${facetId}`;

// ── builder ───────────────────────────────────────────────────────────────────────────────

interface FacetDraft {
  node: FacetNode;
  iterations: Map<number, IterationNode>;
  /** highest iteration that has a verdict */
  completed: number;
  /** provider outages while building iteration N, seen before any node for N exists */
  outages: Map<number, OutageInfo>;
}

interface CrossEdgeDraft {
  kind: typeof EdgeKind.Routed | typeof EdgeKind.Flag;
  fromFacet: string;
  fromIteration: number | null;
  toFacet: string;
  /** the target's iteration in flight when the defect was routed */
  toIteration: number;
}

/** A part as the log names it after restarts: the part it belongs to, and how far its rounds are shifted. */
interface PartRef {
  id: string;
  offset: number;
}

/** Everything `buildRunGraph` gathers while it reads the log, before the graph is assembled. */
interface GraphDraft {
  runId: string;
  run: RunNode;
  base: BaseNode;
  /** a new-game run announced its base stage (`autopilot_base_started`) */
  baseStarted: boolean;
  integration: IntegrationNode;
  final: FinalNode;
  optimization: OptimizationNode | null;
  blender: BlenderNode | null;
  assets: AssetLedger;
  facets: Map<string, FacetDraft>;
  crossEdges: CrossEdgeDraft[];
  /**
   * A part that was restarted (`director_worker.replaces`) is one part, not two. The lead names
   * the worker it is replacing; everything the replacement then does is read as the part's own,
   * its rounds carrying on after the ones it replaced (both builders count from 1), so a
   * restarted part is never drawn twice, once red with nothing kept.
   */
  restarts: Map<string, PartRef>;
  notes: NoteInfo[];
  verdicts: VerdictRecord[];
  runDir: string | null;
  lastMerged: RunGraph["lastMerged"];
  mergedHead: RunGraph["mergedHead"];
  /** Running, paused or finished: the one execution rule, fed this run's lifecycle records. */
  execution: RunExecution | null;
  /** the moment of the record being read — a round first seen in it started then */
  eventAt: string | null;
  /** the place in the log of the record being read */
  seq: number;
}

/** One record of this run, read once: the part and round it names, after restarts are folded in. */
interface RunEntry {
  event: EventEnvelope;
  payload: Payload;
  facetId: string | null;
  facetTitle: string | undefined;
  /** the round it names, counted on from the rounds of the attempt a restart replaced */
  round: number | null;
}

/** What a lead's worker reports about itself (`director_worker.state`, a summary task's `state`). */
export const WorkerState = { Running: "running", Done: "done", Failed: "failed" } as const;

/** The records that name the run the Builds page shows. */
const RUN_ID_EVENTS = new Set<string>([CustomEvent.RunStarted, CustomEvent.RunRegistered, CustomEvent.FacetIteration]);

/** Same rule as the run gallery: the last run the log mentions is the one shown. */
export function lastRunId(events: EventEnvelope[]): string | null {
  let last: string | null = null;
  for (const event of events) {
    const custom = customOf(event);
    if (!custom || !RUN_ID_EVENTS.has(custom.event_type)) continue;
    const runId = strOrNull(custom.payload.runId);
    if (runId) last = runId;
  }
  return last;
}

export function buildRunGraph(events: RunGraphEvent[]): RunGraph | null {
  const runId = lastRunId(events);
  if (!runId) return null;
  const graph = newGraphDraft(runId);
  for (const event of events) {
    const custom = customOf(event);
    if (!custom) continue;
    graph.eventAt = event.graphLastAt ?? event.created_at;
    graph.seq = event.graphSequence ?? graph.seq + 1;
    if (custom.event_type === CustomEvent.UserFeedback) {
      readNote(graph, event, custom.payload);
      continue;
    }
    if (str(custom.payload.runId) !== runId) continue;
    trackExecution(graph, custom, event.created_at);
    applyRunEvent(graph, custom, runEntry(graph, event, custom.payload));
  }
  return assembleGraph(graph);
}

function newGraphDraft(runId: string): GraphDraft {
  return {
    runId,
    run: newRunNode(runId),
    base: {
      kind: GraphNodeKind.Base,
      id: GraphNodeKind.Base,
      done: false,
      ok: null,
      commit: null,
      error: null,
      planReviewed: false,
      outages: 0,
      absent: false,
    },
    baseStarted: false,
    integration: {
      kind: GraphNodeKind.Integration,
      id: GraphNodeKind.Integration,
      merges: [],
      conflicts: 0,
      unions: 0,
      ledger: null,
    },
    final: newFinalNode(),
    optimization: null,
    blender: null,
    assets: newAssetLedger(),
    facets: new Map(),
    crossEdges: [],
    restarts: new Map(),
    notes: [],
    verdicts: [],
    runDir: null,
    lastMerged: null,
    mergedHead: null,
    execution: null,
    eventAt: null,
    seq: 0,
  };
}

function newRunNode(runId: string): RunNode {
  return {
    kind: GraphNodeKind.Run,
    id: GraphNodeKind.Run,
    runId,
    project: null,
    goal: "",
    reference: null,
    startedAt: null,
    finishedAt: null,
    active: true,
    victory: null,
    stoppedBecause: null,
    decisions: [],
    maxParallel: null,
    engine: null,
    model: null,
    builderEngine: null,
    referenceFrames: [],
    director: false,
    paused: false,
  };
}

function newFinalNode(): FinalNode {
  return {
    kind: GraphNodeKind.Final,
    id: GraphNodeKind.Final,
    done: false,
    victory: null,
    stoppedBecause: null,
    globalVerdict: null,
    facets: [],
    summary: null,
    landed: null,
    integrationHead: null,
    baseCommit: null,
    landing: null,
  };
}

function restartOf(graph: GraphDraft, workerId: string): PartRef {
  return graph.restarts.get(workerId) ?? { id: workerId, offset: 0 };
}

function facet(graph: GraphDraft, facetId: string, title?: string): FacetDraft {
  const existing = graph.facets.get(facetId);
  if (existing) {
    if (title && existing.node.title === facetId) existing.node.title = title;
    return existing;
  }
  const draft: FacetDraft = {
    node: {
      kind: GraphNodeKind.Facet,
      id: facetNodeId(facetId),
      facetId,
      title: title || facetId,
      index: graph.facets.size,
      budgetShare: null,
      plannedChecks: null,
      stoppedBecause: null,
      satisfied: null,
      iterations: 0,
      accepted: 0,
      rolled: 0,
      building: false,
      trend: [],
      checksAdded: 0,
      replans: 0,
      outages: 0,
      delivered: false,
      failed: false,
    },
    iterations: new Map(),
    completed: 0,
    outages: new Map(),
  };
  graph.facets.set(facetId, draft);
  return draft;
}

function iteration(graph: GraphDraft, facetId: string, n: number, title?: string): IterationNode {
  const owner = facet(graph, facetId, title);
  const existing = owner.iterations.get(n);
  if (existing) return existing;
  const node: IterationNode = {
    kind: GraphNodeKind.Iteration,
    id: iterationNodeId(facetId, n),
    facetId,
    facetTitle: owner.node.title,
    facetIndex: owner.node.index,
    iteration: n,
    status: IterationStatus.Building,
    verdictLabel: buildingRoundLabel(null),
    verdictSource: null,
    winner: null,
    satisfied: false,
    reason: "",
    biggestGap: "",
    defects: [],
    unmeasured: [],
    scoreboard: null,
    move: null,
    fix: null,
    liveness: null,
    flags: [],
    routedOut: 0,
    routedIn: 0,
    outage: owner.outages.get(n) ?? null,
    shots: [],
    diffs: [],
    merge: null,
    judgedAt: null,
    startedAt: graph.eventAt,
    startedSeq: graph.seq,
    judgedSeq: null,
    notes: [],
    verdict: null,
    advice: null,
  };
  owner.iterations.set(n, node);
  return node;
}

/** The round a record names, marked as worked on now; null when it names no part or no round. */
function touchedRound(graph: GraphDraft, entry: RunEntry): IterationNode | null {
  if (!entry.facetId || entry.round === null) return null;
  const node = iteration(graph, entry.facetId, entry.round, entry.facetTitle);
  node.activityAt = entry.event.created_at;
  return node;
}

function runEntry(graph: GraphDraft, event: EventEnvelope, payload: Payload): RunEntry {
  const named = strOrNull(payload.facetId);
  const merged = named ? restartOf(graph, named) : null;
  const raw = num(payload.iteration);
  return {
    event,
    payload,
    facetId: merged ? merged.id : named,
    facetTitle: strOrNull(payload.facetTitle) ?? undefined,
    round: raw !== null && merged ? raw + merged.offset : raw,
  };
}

function assetPlace(entry: RunEntry): AssetPlace {
  return { facetId: entry.facetId, iteration: entry.round, at: entry.event.created_at };
}

/** A note is part of this run when it names it, or when it was written while the run was live. */
function readNote(graph: GraphDraft, event: EventEnvelope, payload: Payload): void {
  const noteRun = strOrNull(payload.runId);
  const runLive = graph.run.active && graph.run.startedAt !== null;
  const ours = noteRun ? noteRun === graph.runId : runLive;
  if (!ours) return;
  const text = str(payload.text, "").trim();
  if (!text) return;
  graph.notes.push({
    id: event.id,
    facetId: strOrNull(payload.facetId),
    iteration: num(payload.iteration),
    camera: strOrNull(payload.camera),
    text,
    at: strOrNull(payload.at) ?? event.created_at,
    landedIn: null,
  });
}

function trackExecution(graph: GraphDraft, custom: { event_type: string; payload: Payload }, at: string): void {
  if (!isExecutionEvent(custom)) return;
  const before = graph.execution?.state ?? null;
  graph.execution = executionStep(graph.execution, graph.runId, { ...custom, at });
  graph.run.active = graph.execution?.state === RunState.Running;
  graph.run.paused = graph.execution?.state === RunState.Paused;
  if (graph.run.active && closedState(before)) reopenAfterClose(graph, before);
}

/** A run that had closed: paused or finished. */
const closedState = (state: RunState | null): state is Exclude<RunState, typeof RunState.Running> =>
  state !== null && state !== RunState.Running;

/**
 * The run goes on after a close (a pause resumed, a finished run reopened): that close is not its
 * last word, and its next close says it all again. After a finished one only new merges are offered.
 */
function reopenAfterClose(graph: GraphDraft, closedAs: RunState): void {
  graph.final = newFinalNode();
  graph.run.finishedAt = null;
  graph.run.victory = null;
  graph.run.stoppedBecause = null;
  if (closedAs === RunState.Finished) graph.mergedHead = null;
}

/** One record of the run, handed to the reader of its kind; the parts' own records go on to `applyPartEvent`. */
function applyRunEvent(graph: GraphDraft, custom: { event_type: string }, entry: RunEntry): void {
  const { payload } = entry;
  switch (custom.event_type) {
    case CustomEvent.RunRegistered:
    case CustomEvent.RunStarted:
      onRunStarted(graph, entry);
      break;
    case CustomEvent.BlenderAsset:
      onBlenderAsset(graph, entry);
      break;
    case CustomEvent.PluginToolStarted:
      assetRequested(graph.assets, payload, assetPlace(entry));
      break;
    case CustomEvent.PluginTool:
      assetCallReturned(graph.assets, payload, entry.event.created_at);
      break;
    case CustomEvent.AssetDelivered:
      assetDelivered(graph.assets, payload, assetPlace(entry));
      break;
    case CustomEvent.AutopilotStarted:
      onAutopilotStarted(graph, payload);
      break;
    case CustomEvent.AutopilotBaseStarted:
      graph.baseStarted = true;
      break;
    case CustomEvent.AutopilotBase:
      onBase(graph.base, payload);
      break;
    case CustomEvent.AutopilotPlanReview:
      graph.base.planReviewed = true;
      break;
    case CustomEvent.AutopilotDecision:
      onDecision(graph.run, payload);
      break;
    case CustomEvent.AutopilotProviderOutage:
      graph.base.outages += 1;
      break;
    case CustomEvent.IntegrationMerge:
      onMerge(graph, entry);
      break;
    case CustomEvent.DirectorVerdict:
      onDirectorVerdict(graph, entry);
      break;
    case CustomEvent.IntegrationHealth:
      onHealth(graph, payload);
      break;
    case CustomEvent.IntegrationLedger:
      onLedger(graph.integration, payload);
      break;
    case CustomEvent.OptimizationUpdated:
      updateOptimization(graph, payload);
      break;
    case CustomEvent.RunFinished:
      onRunFinished(graph, entry);
      break;
    default:
      applyPartEvent(graph, custom, entry);
  }
}

/** One part's record — a round asked for, built, flagged or judged; a kind the graph does not draw is skipped. */
function applyPartEvent(graph: GraphDraft, custom: { event_type: string }, entry: RunEntry): void {
  switch (custom.event_type) {
    case CustomEvent.FacetProviderOutage:
      onFacetOutage(graph, entry);
      break;
    case CustomEvent.FacetBuildStarted:
      touchedRound(graph, entry);
      break;
    case CustomEvent.DirectorWorker:
      onDirectorWorker(graph, entry.payload);
      break;
    case CustomEvent.FacetMove:
      onMove(graph, entry);
      break;
    case CustomEvent.FacetFix:
      onFix(graph, entry);
      break;
    case CustomEvent.FacetLiveness:
      onLiveness(graph, entry);
      break;
    case CustomEvent.FacetFlag:
      onFlag(graph, entry);
      break;
    case CustomEvent.FacetDefectRouted:
      onDefectRouted(graph, entry);
      break;
    case CustomEvent.FacetCheckAdded:
      if (entry.facetId) facet(graph, entry.facetId, entry.facetTitle).node.checksAdded += 1;
      break;
    case CustomEvent.FacetCheckReplanned:
      if (entry.facetId) facet(graph, entry.facetId, entry.facetTitle).node.replans += 1;
      break;
    case CustomEvent.FacetIteration:
      onRoundJudged(graph, entry);
      break;
    default:
      break;
  }
}

function blenderNode(version: string | null): BlenderNode {
  return { kind: GraphNodeKind.Blender, id: GraphNodeKind.Blender, version, assets: [] };
}

function onRunStarted(graph: GraphDraft, entry: RunEntry): void {
  const { run } = graph;
  const { payload } = entry;
  run.project = strOrNull(payload.project);
  run.goal = str(payload.goal, "");
  run.startedAt = entry.event.created_at;
  // Absent budgets leave the earlier value; an ∞ build has only a safety ceiling, never a duration.
  const loop = recordedRunLoop(payload.budgets);
  if (loop) run.durationMs = loop.hours === null ? undefined : loop.hours * HOUR_MS;
  const reference = record(payload.reference);
  run.reference = reference ? { name: str(reference.name, "reference"), kind: strOrNull(reference.kind) } : null;
  run.referenceFrames = reference ? strings(reference.frames) : [];
  run.engine = strOrNull(payload.engine);
  run.model = strOrNull(payload.model);
  run.builderEngine = strOrNull(payload.builderEngine) ?? run.engine;
  const modeller = record(payload.blender);
  if (modeller) graph.blender = blenderNode(strOrNull(modeller.version));
}

function onBlenderAsset(graph: GraphDraft, entry: RunEntry): void {
  graph.blender ??= blenderNode(strOrNull(entry.payload.blenderVersion));
  const asset = blenderAsset(entry.payload, assetPlace(entry));
  graph.blender.assets.push(asset);
  if (!graph.runDir && asset.render) graph.runDir = runDirOf(asset.render, graph.runId);
}

function onAutopilotStarted(graph: GraphDraft, payload: Payload): void {
  graph.run.maxParallel = num(payload.maxParallel);
  graph.run.director = payload.director === true;
  for (const row of records(payload.facets)) {
    const id = strOrNull(row.id);
    if (!id) continue;
    const draft = facet(graph, id, strOrNull(row.title) ?? undefined);
    draft.node.budgetShare = num(row.budgetShare);
    draft.node.plannedChecks = num(row.checks);
  }
}

function onBase(base: BaseNode, payload: Payload): void {
  base.empty = payload.empty === true;
  base.done = true;
  base.ok = bool(payload.ok);
  base.commit = strOrNull(payload.commit);
  base.error = strOrNull(payload.error);
}

function onDecision(run: RunNode, payload: Payload): void {
  const decision = strOrNull(payload.decision);
  if (decision) run.decisions.push(decision);
}

function onFacetOutage(graph: GraphDraft, entry: RunEntry): void {
  if (!entry.facetId) {
    graph.base.outages += 1;
    return;
  }
  const draft = facet(graph, entry.facetId, entry.facetTitle);
  const inFlight = entry.round ?? draft.completed + 1;
  const existing = draft.iterations.get(inFlight);
  const info: OutageInfo = existing?.outage ??
    draft.outages.get(inFlight) ?? { count: 0, phase: null, lastError: null };
  info.count += 1;
  info.phase = strOrNull(entry.payload.phase) ?? info.phase;
  info.lastError = strOrNull(entry.payload.error) ?? info.lastError;
  if (existing) existing.outage = info;
  else draft.outages.set(inFlight, info);
  draft.node.outages += 1;
}

/**
 * A director's worker: a node the moment it starts, its stop reason when
 * it ends — a single-session worker has no iterations of its own to draw.
 */
function onDirectorWorker(graph: GraphDraft, payload: Payload): void {
  const workerId = strOrNull(payload.workerId);
  if (!workerId) return;
  foldRestart(graph, workerId, strOrNull(payload.replaces));
  const part = restartOf(graph, workerId);
  const draft = facet(graph, part.id, strOrNull(payload.title) ?? undefined);
  const state = strOrNull(payload.state);
  const running = state === WorkerState.Running;
  draft.node.building = running;
  // The attempt this one replaces ended; the part has not.
  if (running) draft.node.stoppedBecause = null;
  if (state && !running) draft.node.stoppedBecause = strOrNull(payload.stoppedBecause) ?? state;
  // A single-session builder that ran to the end did the work it was given: the card must
  // say "done", not "stopped", which is what the lead ending one early means.
  if (state === WorkerState.Done) draft.node.satisfied = true;
  draft.node.delivered = state === WorkerState.Done && payload.delivered === true;
  draft.node.failed = state === WorkerState.Failed;
}

/**
 * A restart names the worker it replaces: one row, its rounds continuing after that attempt's.
 * An id nobody has seen is ignored — a part cannot fold into nothing.
 */
function foldRestart(graph: GraphDraft, workerId: string, replaces: string | null): void {
  if (!replaces || graph.restarts.has(workerId)) return;
  const into = restartOf(graph, replaces);
  const older = graph.facets.get(into.id);
  if (older)
    graph.restarts.set(workerId, { id: into.id, offset: Math.max(older.completed, ...older.iterations.keys()) });
}

/** The asked event comes first; the answered one (delivered true/false) wins, and a new ask replaces an old one. */
function supersedes(next: { what: string; delivered: boolean | null }, current: MoveInfo | FixInfo | null): boolean {
  return !current || next.delivered !== null || current.what !== next.what;
}

function onMove(graph: GraphDraft, entry: RunEntry): void {
  const move = parseMove(entry.payload);
  if (!move) return;
  const node = touchedRound(graph, entry);
  if (node && supersedes(move, node.move)) node.move = move;
}

function onFix(graph: GraphDraft, entry: RunEntry): void {
  const fix = parseFix(entry.payload);
  if (!fix) return;
  const node = touchedRound(graph, entry);
  if (node && supersedes(fix, node.fix)) node.fix = fix;
}

function onLiveness(graph: GraphDraft, entry: RunEntry): void {
  const node = touchedRound(graph, entry);
  if (node) node.liveness = parseLiveness(entry.payload) ?? node.liveness;
}

/** A flag joins its round once: one with the same words and check is the same flag. */
function addFlag(node: IterationNode, flag: FlagInfo): void {
  const known = node.flags.some((existing) => existing.what === flag.what && existing.checkId === flag.checkId);
  if (!known) node.flags.push(flag);
}

function onFlag(graph: GraphDraft, entry: RunEntry): void {
  const { facetId, payload } = entry;
  if (!facetId) return;
  const draft = facet(graph, facetId, entry.facetTitle);
  const flag: FlagInfo = {
    what: str(payload.what, ""),
    checkId: strOrNull(payload.checkId),
    target: strOrNull(payload.target),
  };
  const at = entry.round ?? draft.completed + 1;
  addFlag(iteration(graph, facetId, at, entry.facetTitle), flag);
  if (flag.target) flag.target = restartOf(graph, flag.target).id;
  if (!flag.target || flag.target === facetId) return;
  const target = facet(graph, flag.target);
  graph.crossEdges.push({
    kind: EdgeKind.Flag,
    fromFacet: facetId,
    fromIteration: at,
    toFacet: flag.target,
    toIteration: target.completed + 1,
  });
}

function onDefectRouted(graph: GraphDraft, entry: RunEntry): void {
  const fromId = strOrNull(entry.payload.from);
  const to = strOrNull(entry.payload.to);
  if (!fromId || !to) return;
  const from = restartOf(graph, fromId);
  const into = restartOf(graph, to);
  const target = facet(graph, into.id);
  graph.crossEdges.push({
    kind: EdgeKind.Routed,
    fromFacet: from.id,
    fromIteration: entry.round === null ? null : entry.round + from.offset,
    toFacet: into.id,
    toIteration: target.completed + 1,
  });
}

/** `facet_iteration`: a worker's round was judged. */
function onRoundJudged(graph: GraphDraft, entry: RunEntry): void {
  const { facetId, round, payload } = entry;
  if (!facetId || round === null) return;
  const draft = facet(graph, facetId, entry.facetTitle);
  const node = iteration(graph, facetId, round, entry.facetTitle);
  node.activityAt = entry.event.created_at;
  recordVerdict(node, payload);
  node.judgedAt = entry.event.created_at;
  node.judgedSeq = graph.seq;
  node.verdict = parseVerdict(payload.verdict) ?? node.verdict;
  const [firstShot] = node.shots;
  if (!graph.runDir && firstShot) graph.runDir = runDirOf(firstShot.path, graph.runId);
  keepAskedWork(node, payload);
  for (const flag of parseFlags(payload.flags)) addFlag(node, flag);
  draft.completed = Math.max(draft.completed, round);
}

/** The judged round's own fields, off its `facet_iteration`. */
function recordVerdict(node: IterationNode, payload: Payload): void {
  const winner = strOrNull(payload.winner);
  const satisfied = payload.satisfied === true;
  const source = strOrNull(payload.verdictSource);
  // A round the lead stopped is neither kept nor undone: nobody judged it, and the
  // builder's work is on a branch, not in the bin. Nor is one that recorded no winner.
  node.status = STATUS_OF[roundOutcome(payload)];
  node.winner = winner;
  node.satisfied = satisfied;
  node.verdictSource = source;
  node.verdictLabel = verdictLabel(winner, satisfied, source);
  node.reason = str(payload.reason, "");
  // A stopped round was never judged: the gap it carries is the builder's brief, not a finding.
  node.biggestGap = node.status === IterationStatus.Stopped ? "" : str(payload.biggest_gap, "");
  node.defects = strings(payload.defects);
  node.unmeasured = strings(payload.unmeasured);
  node.scoreboard = parseScoreboard(payload.scoreboard);
  node.shots = parseShots(payload.shots);
  node.diffs = parseDiffs(payload.diffs);
}

/** Whether the round's own record of asked work leaves it open: none, or none delivered yet. */
const leftOpen = (asked: { delivered: unknown } | null): boolean => !asked || asked.delivered === null;

/** The move, fix and liveness the verdict repeats fill in only what the round's own records left open. */
function keepAskedWork(node: IterationNode, payload: Payload): void {
  const move = parseMove(payload.move);
  if (move && leftOpen(node.move)) node.move = move;
  const fix = parseFix(payload.fix);
  if (fix && leftOpen(node.fix)) node.fix = fix;
  const liveness = parseLiveness(payload.liveness);
  if (!liveness) return;
  if (!node.liveness) {
    node.liveness = liveness;
    return;
  }
  node.liveness.critic ??= liveness.critic;
  node.liveness.total ??= liveness.total;
  node.liveness.max ??= liveness.max;
  node.liveness.biggest ??= liveness.biggest;
}

function onMerge(graph: GraphDraft, entry: RunEntry): void {
  const { facetId, payload } = entry;
  const at = strOrNull(payload.at) ?? entry.event.created_at;
  const merge = parseMerge(payload, { facetId, iteration: entry.round, at, seq: graph.seq });
  const { integration } = graph;
  integration.merges.push(merge);
  if (merge.conflict) integration.conflicts += 1;
  if (merge.union) integration.unions += 1;
  if (facetId && merge.iteration !== null) {
    const node = graph.facets.get(facetId)?.iterations.get(merge.iteration);
    if (node) node.merge = merge;
    if (!merge.conflict) graph.lastMerged = { facetId, iteration: merge.iteration };
  }
  // A lead's merge names no round, so the newest build is tracked by its commit instead.
  if (!merge.conflict && merge.head) graph.mergedHead = { head: merge.head, at, healthy: null };
}

/**
 * The lead's own passes — the fork gate, its judge, a health pass, the close. Each one is a
 * build somebody looked at, with the sentence that look produced. A critic's advice comes the
 * same way and is no verdict: it goes on the round it looked at, and nothing else reads it.
 */
function onDirectorVerdict(graph: GraphDraft, entry: RunEntry): void {
  if (entry.payload.advice === true) {
    onAdvice(graph, entry);
    return;
  }
  const verdict = parseVerdict(entry.payload);
  if (verdict) graph.verdicts.push(verdict);
}

/** A critic's advice, on the round it names, else its part's latest round; dropped when its part has none. */
function onAdvice(graph: GraphDraft, entry: RunEntry): void {
  const advice = parseAdvice(entry.payload, entry.event.created_at);
  const draft = entry.facetId ? graph.facets.get(entry.facetId) : undefined;
  if (!advice || !draft) return;
  const latest = Math.max(0, ...draft.iterations.keys());
  const round = draft.iterations.get(entry.round ?? latest) ?? draft.iterations.get(latest);
  if (round) round.advice = advice;
}

/** Did the merged build run? Only a head that did is worth offering the user mid-run. */
function onHealth(graph: GraphDraft, payload: Payload): void {
  const head = strOrNull(payload.head);
  const { mergedHead } = graph;
  if (head && mergedHead?.head === head) mergedHead.healthy = payload.ok === true;
}

function onLedger(integration: IntegrationNode, payload: Payload): void {
  integration.ledger = {
    pick: strOrNull(payload.pick),
    reason: str(payload.reason, ""),
    defects: strings(payload.defects),
  };
}

/** The newest optimisation result of this run wins; one for another run, or an older one, is ignored. */
function updateOptimization(graph: GraphDraft, raw: unknown): void {
  const result = normalizeOptimization(raw);
  if (result?.runId !== graph.runId) return;
  const current = graph.optimization;
  if (!current || result.sequence > current.result.sequence)
    graph.optimization = { kind: GraphNodeKind.Optimization, id: GraphNodeKind.Optimization, result };
}

function onRunFinished(graph: GraphDraft, entry: RunEntry): void {
  const { run, final } = graph;
  const { payload } = entry;
  updateOptimization(graph, payload.optimization);
  run.finishedAt = entry.event.created_at;
  run.victory = bool(payload.victory);
  run.stoppedBecause = strOrNull(payload.stoppedBecause);
  final.done = true;
  final.victory = run.victory;
  final.stoppedBecause = run.stoppedBecause;
  final.summary = reportSummary(payload);
  final.landed = typeof payload.landed === "boolean" ? payload.landed : null;
  final.integrationHead = strOrNull(payload.integrationHead);
  final.baseCommit = strOrNull(payload.baseCommit);
  final.landing = parseLanding(record(payload.landingResult));
  final.globalVerdict = parseGlobalVerdict(record(payload.globalVerdict));
  finishFacets(graph, record(payload.facets));
}

function parseLanding(landing: Payload | null): FinalNode["landing"] {
  if (!landing) return null;
  return { verified: bool(landing.verified) === true, how: strOrNull(landing.how), line: strOrNull(landing.line) };
}

function parseGlobalVerdict(verdict: Payload | null): FinalNode["globalVerdict"] {
  if (!verdict) return null;
  return {
    pick: strOrNull(verdict.pick),
    reason: str(verdict.reason, ""),
    biggestGap: str(verdict.biggest_gap, ""),
    defects: strings(verdict.defects),
  };
}

/** The close's word on each part, on the final card and on the part's own node. */
function finishFacets(graph: GraphDraft, finished: Payload | null): void {
  if (!finished) return;
  for (const [id, raw] of Object.entries(finished)) {
    const row = record(raw) ?? {};
    const summary = {
      facetId: id,
      stoppedBecause: strOrNull(row.stoppedBecause),
      iterations: num(row.iterations),
      satisfied: bool(row.satisfied),
    };
    graph.final.facets.push(summary);
    const draft = graph.facets.get(restartOf(graph, id).id);
    if (draft) {
      draft.node.stoppedBecause = summary.stoppedBecause;
      draft.node.satisfied = summary.satisfied;
    }
  }
}

// ── assemble ──────────────────────────────────────────────────────────────────────────────

function flowEdge(from: string, to: string): GraphEdge {
  return { id: `${from}→${to}`, from, to, kind: EdgeKind.Flow, count: 1 };
}

/** A round that reached a verdict: kept or undone. */
function isDecided(status: IterationStatus): boolean {
  return status === IterationStatus.Accepted || status === IterationStatus.Rolled;
}

function assembleGraph(graph: GraphDraft): RunGraph {
  const { run, base, runId } = graph;
  // Existing-game director runs reuse the starting world. A new-game run explicitly announces
  // its base before delegation; keep that stage pending until its checks arrive. Without either
  // base event, do not invent a base stage that may never run.
  const baseNeverAnnounced = !base.done && !graph.baseStarted;
  if (run.director && baseNeverAnnounced) {
    base.absent = true;
    base.done = true;
  }
  const facetNodes = [...graph.facets.values()].sort((a, b) => a.node.index - b.node.index);
  const nodes: GraphNode[] = [run, base];
  const edges: GraphEdge[] = [flowEdge(GraphNodeKind.Run, GraphNodeKind.Base)];
  for (const draft of facetNodes) drawPart(draft, run.active, nodes, edges);
  drawClose(graph, nodes, edges);
  edges.push(...crossEdges(graph));
  pinNotes(graph);
  return {
    runId,
    active: run.active,
    nodes,
    edges,
    facets: facetNodes.map((draft) => draft.node),
    notes: graph.notes,
    runDir: graph.runDir,
    lastMerged: graph.lastMerged,
    mergedHead: graph.mergedHead,
    verdicts: graph.verdicts,
  };
}

/** One part's column: its header, then its rounds in order, flowing into the integration. */
function drawPart(draft: FacetDraft, runActive: boolean, nodes: GraphNode[], edges: GraphEdge[]): void {
  const iterations = [...draft.iterations.values()].sort((a, b) => a.iteration - b.iteration);
  for (const node of iterations) settleRound(node, draft, runActive);
  draft.node.iterations = iterations.filter((node) => isDecided(node.status)).length;
  nodes.push(draft.node);
  edges.push(flowEdge(GraphNodeKind.Base, draft.node.id));
  let previous = draft.node.id;
  for (const node of iterations) {
    nodes.push(node);
    edges.push(flowEdge(previous, node.id));
    previous = node.id;
  }
  edges.push(flowEdge(previous, GraphNodeKind.Integration));
}

/** A round's last word once the log is read, and what it adds to its part's counts and trend. */
function settleRound(node: IterationNode, draft: FacetDraft, runActive: boolean): void {
  if (node.status === IterationStatus.Building && !runActive) node.status = IterationStatus.Abandoned;
  if (node.status === IterationStatus.Abandoned) node.verdictLabel = ABANDONED_ROUND_LABEL;
  if (node.status === IterationStatus.Building)
    node.verdictLabel = buildingRoundLabel(node.fix?.what ?? node.move?.what);
  node.facetTitle = draft.node.title;
  node.facetIndex = draft.node.index;
  node.outage ??= draft.outages.get(node.iteration) ?? null;
  if (node.status === IterationStatus.Accepted) draft.node.accepted += 1;
  else if (node.status === IterationStatus.Rolled) draft.node.rolled += 1;
  else if (node.status === IterationStatus.Building) draft.node.building = true;
  if (!isDecided(node.status)) return;
  draft.node.trend.push({
    iteration: node.iteration,
    passing: node.scoreboard?.passing ?? null,
    total: node.scoreboard?.total ?? null,
    alive: node.liveness?.total ?? null,
    aliveMax: node.liveness?.max ?? null,
  });
}

/** The integration, the optimisation when there was one, the final card, and the modeller and asset nodes. */
function drawClose(graph: GraphDraft, nodes: GraphNode[], edges: GraphEdge[]): void {
  const { optimization, blender } = graph;
  nodes.push(graph.integration, ...(optimization ? [optimization] : []), graph.final);
  if (blender) nodes.push(blender);
  const jobs = keptAssetJobs(graph.assets);
  if (jobs.length) nodes.push({ kind: GraphNodeKind.Assets, id: GraphNodeKind.Assets, jobs });
  if (!optimization) {
    edges.push(flowEdge(GraphNodeKind.Integration, GraphNodeKind.Final));
    return;
  }
  edges.push(flowEdge(GraphNodeKind.Integration, GraphNodeKind.Optimization));
  edges.push(flowEdge(GraphNodeKind.Optimization, GraphNodeKind.Final));
}

/** Cross edges resolve to iteration nodes where they exist, otherwise the facet header; repeats are counted. */
function crossEdges(graph: GraphDraft): GraphEdge[] {
  const resolve = (facetId: string, n: number | null): string | null => {
    const draft = graph.facets.get(facetId);
    if (!draft) return null;
    if (n !== null && draft.iterations.has(n)) return iterationNodeId(facetId, n);
    return draft.node.id;
  };
  const grouped = new Map<string, GraphEdge>();
  for (const cross of graph.crossEdges) {
    const from = resolve(cross.fromFacet, cross.fromIteration);
    const to = resolve(cross.toFacet, cross.toIteration);
    if (!from || !to) continue;
    if (from === to) continue;
    const id = `${cross.kind}:${from}→${to}`;
    const existing = grouped.get(id);
    if (existing) existing.count += 1;
    else grouped.set(id, { id, from, to, kind: cross.kind, count: 1 });
    if (cross.kind === EdgeKind.Routed) countRouted(graph, cross);
  }
  return [...grouped.values()];
}

function countRouted(graph: GraphDraft, cross: CrossEdgeDraft): void {
  const source = graph.facets.get(cross.fromFacet)?.iterations.get(cross.fromIteration ?? -1);
  if (source) source.routedOut += 1;
  const target = graph.facets.get(cross.toFacet)?.iterations.get(cross.toIteration);
  if (target) target.routedIn += 1;
}

/** Notes: pin each to the round it named and record the first later verdict of that part. */
function pinNotes(graph: GraphDraft): void {
  for (const note of graph.notes) {
    const draft = note.facetId ? graph.facets.get(note.facetId) : undefined;
    if (!draft) continue;
    const rounds = [...draft.iterations.values()].sort((a, b) => a.iteration - b.iteration);
    const later = rounds.find((round) => round.judgedAt !== null && round.judgedAt > note.at);
    note.landedIn = later ? later.iteration : null;
    const named = note.iteration !== null ? draft.iterations.get(note.iteration) : null;
    const judgedBefore = rounds.filter((round) => round.judgedAt !== null && round.judgedAt <= note.at).at(-1);
    const pinned = named ?? judgedBefore ?? rounds[0];
    if (pinned) pinned.notes.push(note);
  }
}

/**
 * What the run says it did, for the morning card. The lead's `finish` writes this for the user;
 * a run that ran out of time before it called `finish` writes none — as the first real run did
 * — and it has no report. It used to fall back to the last note the lead had left *itself*, which
 * is how a morning card came to read "Base fixed and re-based (69f573d): crowd shader now compiles
 * under r185". The card says plainly that no report was written instead; the stills, the kept and
 * undone counts and the buttons carry the substance.
 */
export function reportSummary(payload: { summary?: unknown }): string | null {
  const summary = typeof payload.summary === "string" ? payload.summary.trim() : "";
  return summary || null;
}

/**
 * Did the run leave a merged build of its own? This is the one fact the morning's copy and the
 * morning's buttons must agree on: "the build is kept and playable" belongs only over a card that
 * can actually open one, and a head that never moved off the starting commit holds nothing.
 */
export function hasMergedBuild(
  final: { integrationHead?: string | null; baseCommit?: string | null } | null | undefined,
): boolean {
  const head = final?.integrationHead ?? null;
  return typeof head === "string" && head !== "" && head !== (final?.baseCommit ?? null);
}

/**
 * The checks a round flipped that the part was actually planned against.
 *
 * The scoreboard's `flips` counts every check that turned green, including the ones a judge grew
 * during the run — so a round whose only gain was answering the judge's own new question read
 * as "+1 · kept" on the card. The loop now sends the planned list itself; failing that, the
 * verdict record keeps planned and grown apart; failing both (a run from before either) the
 * whole list stands, as it always did.
 */
export function plannedFlips(node: IterationNode): string[] {
  if (node.scoreboard?.plannedFlips) return node.scoreboard.plannedFlips;
  const flips = node.scoreboard?.flips ?? [];
  if (!node.verdict) return flips;
  const grown = new Set(node.verdict.measured.grown.map((check) => check.id));
  return flips.filter((id) => !grown.has(id));
}

/**
 * How full the round's progress bar is: the share of the plan's checks that passed. A judge's own
 * grown questions are left out, so the bar and the counts beside it tell the same story.
 */
export function passedFraction(board: Scoreboard | null | undefined): number {
  if (!board) return 0;
  const split = typeof board.plannedTotal === "number";
  const total = (split ? board.plannedTotal : board.total) ?? 0;
  const passing = (split ? board.plannedPassing : board.passing) ?? 0;
  return total > 0 ? Math.max(0, Math.min(100, (passing / total) * 100)) : 0;
}

/** The run's final node (your build), once the graph has one. */
export function finalNodeOf(graph: RunGraph): FinalNode | null {
  return graph.nodes.find((node): node is FinalNode => node.kind === GraphNodeKind.Final) ?? null;
}

/**
 * The last thing anybody said about the build the run stands on: the newest verdict for the
 * merged head, or — before anything merged, and on a run whose passes named no head — simply
 * the newest one. The Builds drawer shows this in place of a sentence about the run as a whole.
 */
export function headVerdict(graph: RunGraph): VerdictRecord | null {
  const head = graph.mergedHead?.head ?? null;
  const forHead = head ? graph.verdicts.filter((verdict) => verdict.build.head === head) : [];
  return forHead.at(-1) ?? graph.verdicts.at(-1) ?? null;
}

/** `…/runs/run_x/facet_a/iter_001/screenshots/cam.jpg` → `…/runs/run_x`. */
export function runDirOf(stillPath: string, runId: string): string | null {
  const marker = `/${runId}/`;
  const at = stillPath.indexOf(marker);
  return at < 0 ? null : stillPath.slice(0, at + marker.length - 1);
}

/** The run-level capture folders the harness writes: the start, the merged build and the final build. */
export const RunStillStage = { Base: "base", Merged: "merged", Final: "final" } as const;
export type RunStillStage = (typeof RunStillStage)[keyof typeof RunStillStage];

/** Where a run-level capture lives — the file may not exist yet. */
export function runStillPath(runDir: string, stage: RunStillStage, camera = "default"): string {
  return `${runDir}/${stage}/screenshots/${camera}.jpg`;
}

// ── plain words ───────────────────────────────────────────────────────────────────────────

/** What a round is for, in the words the Builds tab uses. */
export const RoundKind = {
  FirstBuild: "first build",
  NextStep: "next step",
  MustFix: "must fix",
  WhatsMissing: "what's missing",
  Fixes: "fixes",
  Polish: "polish",
} as const;
export type RoundKind = (typeof RoundKind)[keyof typeof RoundKind];

/** A fix asked for this many rounds running is one the build must land. */
const MUST_FIX_STREAK = 2;

export function roundKind(node: IterationNode): RoundKind {
  if (node.fix) {
    const mustFix = node.fix.mandatory || (node.fix.streak ?? 0) >= MUST_FIX_STREAK;
    return mustFix ? RoundKind.MustFix : RoundKind.Fixes;
  }
  if (node.move) return moveKind(node.move.source);
  return node.iteration === 1 ? RoundKind.FirstBuild : RoundKind.Polish;
}

/** A step from the plan is the next one; one a reviewer or the critic named is what's missing; anything else is fixes. */
function moveKind(source: string | null): RoundKind {
  switch (source) {
    case "milestone":
    case "planner":
    case null:
      return RoundKind.NextStep;
    case "reviewer":
    case "critic":
      return RoundKind.WhatsMissing;
    default:
      return RoundKind.Fixes;
  }
}

/** The sentence a round card shows under its kind: what the builder was asked to do. */
export function roundWhy(node: IterationNode): string {
  if (node.fix) return node.fix.what;
  if (node.move) return node.move.what;
  return node.iteration === 1
    ? "The first build of this part — everything the plan asks for, in one pass."
    : "Small fixes across the part, no named step.";
}

/** One round as a step: "Next step: Chapel tower with a bell". The judges' sheet and the outcome card both read this. */
export function roundStep(node: IterationNode): string {
  const kind = roundKind(node);
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)}: ${roundWhy(node)}`;
}

/**
 * What the run is doing next, from the record alone: the round the lead most recently started
 * and has not judged yet, named with its part. Null when no round is underway — a run between
 * builds, or one that has ended — so the card can say the next step is not recorded rather than
 * guess one.
 */
export function nextStep(graph: RunGraph): string | null {
  const underway = graph.nodes.filter(
    (node): node is IterationNode => node.kind === GraphNodeKind.Iteration && node.status === IterationStatus.Building,
  );
  const node = underway.at(-1);
  return node ? `${node.facetTitle} — ${roundStep(node)}` : null;
}

/** Strip the `[check-id] ` prefix the judge puts on defects and gaps. */
export function plainDefect(text: string): string {
  return text.replace(/^\s*\[[^\]]*\]\s*/, "").trim();
}

/** `defect-the-dog-is-a-boxy-loaf` → `the dog is a boxy loaf`. */
export function checkWords(id: string): string {
  return id
    .replace(/^defect-/, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

/** The still a card shows for a round: the default camera when it exists, else the first shot. */
export function thumbShot(node: IterationNode): Shot | null {
  const [first] = node.shots;
  if (!first) return null;
  return (
    node.shots.find((shot) => shot.camera === "default") ??
    node.shots.find((shot) => !shot.camera.startsWith("demo")) ??
    first
  );
}

// ── layout ────────────────────────────────────────────────────────────────────────────────

export interface Size {
  w: number;
  h: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

/**
 * Each asset job of the graph joined to the game's asset inventory: the inventory's record of it
 * (by job id, the remote generation id, else one of its files) for its thumbnail, and whether a
 * copy is in the game itself rather than only in a build workspace. An inventory entry with no
 * delivery record is a plain file walked in the game folder itself.
 */
export function joinAssetInventory(nodes: GraphNode[], inventory: ProjectAssets | null): GraphNode[] {
  return nodes.map((node) =>
    node.kind === GraphNodeKind.Assets ? { ...node, jobs: node.jobs.map((job) => joinJob(job, inventory)) } : node,
  );
}

function joinJob(job: AssetInfo, inventory: ProjectAssets | null): AssetInfo {
  /** The inventory's asset of this job, by its job id or its generation id. */
  const ofJob = (a: ProjectAsset): boolean => {
    if (job.jobId && a.jobId === job.jobId) return true;
    return Boolean(job.generationId) && a.generationId === job.generationId;
  };
  const asset = inventory?.assets.find(ofJob) ?? inventory?.assets.find((a) => job.files.includes(a.file));
  return { ...job, preview: asset, inGame: asset ? inGameCopy(asset) : undefined };
}

/** A delivered asset is in the game when a present copy is the project's; a walked file with no delivery record is. */
function inGameCopy(asset: ProjectAsset): boolean {
  const copies = asset.availability?.deliveries.filter((d) => d.present);
  return copies ? copies.some((d) => d.scope === "project") : !asset.assetRef;
}

/**
 * The graph the Builds tab draws: the run's recorded summary restored over the live log (its
 * graph events when it carries them, its run folder), a skipped optimisation left out, and the
 * asset jobs joined to the game's inventory.
 */
export function buildsView(supplied: RunGraph, summary: RunSummary | null, inventory: ProjectAssets | null): RunGraph {
  const restored = summary?.graphEvents ? (buildRunGraph(summary.graphEvents) ?? supplied) : supplied;
  return joinBuildsView(restored, summary, inventory);
}

/** Join presentation data to an already restored graph without folding its event log again. */
export function joinBuildsView(
  restored: RunGraph,
  summary: RunSummary | null,
  inventory: ProjectAssets | null,
): RunGraph {
  const nodes = joinAssetInventory(
    restored.nodes.filter((node) => node.kind !== GraphNodeKind.Optimization || node.result.outcome !== "skipped"),
    inventory,
  );
  return { ...restored, nodes, runDir: summary?.runDirectory ?? restored.runDir, summary: summary ?? undefined };
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** The bounding box of a set of rects — what "Fit" frames. */
export function boundsOf(rects: Iterable<Rect>): Rect | null {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function truncate(text: string, max = 90): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}
