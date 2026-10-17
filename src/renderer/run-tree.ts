/**
 * The Builds graph as a tree (`RunGraph.tree`): a graph that holds a worker's or a job's records
 * draws the lead between what you asked and the rows, its background work hanging under it, and a
 * run's tree ends in the finish check. This module says where the lead stands, what its background
 * tile reads and the order Previous and Next step through; `run-steps.ts` lays the tree out. Every
 * other graph keeps today's layout.
 *
 * Pure: no DOM, no window. `panels/run-graph/use-builds-model.ts` and the tests share it.
 */
import { MINUTE_MS } from "../shared/duration.ts";
import { FinishCheckStep, MAX_FINISH_REJECTIONS } from "../shared/finish-check.ts";
import { JobState } from "../shared/jobs.ts";
import { ExecutionStatus } from "../shared/run-state.ts";
import type { RunSummary } from "../shared/run-summary.ts";
import { GraphSelection } from "./panels/inspector/selection.ts";
import {
  type FinishCheckNode,
  FinishCheckState,
  type FinishRound,
  GraphNodeKind,
  type LeadNode,
  type RunGraph,
  runIdOf,
} from "./run-graph.ts";
import type { JobInfo } from "./run-graph-workers.ts";
import {
  isWorkerAtWork,
  layoutSteps,
  leadWorking,
  type PartRow,
  resultGate,
  runExecution,
  type StepsLayout,
  Tone,
} from "./run-steps.ts";
import { backgroundCount, FINISH_CHECK_WORDS, jobStatusWords, LEAD_WORDS } from "./words.ts";
import { isInPlaceTree, layoutComb } from "./run-graph-comb.ts";

/** What the lead's node says it is doing: working itself, waiting for its workers, paused, done or stopped. */
export const LeadFace = {
  Working: "working",
  Waiting: "waiting",
  Paused: "paused",
  Done: "done",
  Stopped: "stopped",
} as const;
export type LeadFace = (typeof LeadFace)[keyof typeof LeadFace];

/** The background tile's words: the job it names, and how the background work stands. */
export interface JobsTileStatus {
  title: string;
  status: string;
  tone: Tone;
}

/** The lead's node of a tree, when the graph has one. */
export const leadNodeOf = (graph: RunGraph): LeadNode | null =>
  graph.nodes.find((node): node is LeadNode => node.kind === GraphNodeKind.Lead) ?? null;

const hasNode = (graph: RunGraph, kind: RunGraph["nodes"][number]["kind"]): boolean =>
  graph.nodes.some((node) => node.kind === kind);

/** The run was asked with pictures: its start shows them, its words under them. */
const asksWithPictures = (graph: RunGraph): boolean =>
  graph.nodes.some((node) => node.kind === GraphNodeKind.Run && node.asked !== null);

/**
 * The Builds tab's layout of a graph: today's options (the assets under the start, the
 * optimisation card, the result's gate, the lead while it has the run), plus the tree's when the
 * graph is one: the lead's background work when it has any, the finish check when it waits. A
 * lead's tree in place (workers and its own save points) hangs its workers off the save points
 * (`run-graph-comb.ts`); every other graph lays out a row per part.
 */
export function buildsLayout(graph: RunGraph, rows: PartRow[], summary: RunSummary | null): StepsLayout {
  const lead = leadNodeOf(graph);
  const tree = graph.tree
    ? { tree: { jobs: (lead?.jobs.length ?? 0) > 0, finishCheck: hasNode(graph, GraphNodeKind.FinishCheck) } }
    : {};
  const options = {
    assets: hasNode(graph, GraphNodeKind.Blender) || hasNode(graph, GraphNodeKind.Assets),
    startWords: asksWithPictures(graph),
    optimization: hasNode(graph, GraphNodeKind.Optimization),
    resultGate: resultGate(graph),
    lead: leadWorking(graph, summary, rows),
    ...tree,
  };
  return graph.tree && isInPlaceTree(rows) ? layoutComb(rows, options) : layoutSteps(rows, options);
}

/** How a run's close reads on the lead: stopped for a failure or a cancel, done for any other. */
const CLOSED_FACE: Partial<Record<string, LeadFace>> = {
  [ExecutionStatus.Paused]: LeadFace.Paused,
  [ExecutionStatus.Failed]: LeadFace.Stopped,
  [ExecutionStatus.Cancelled]: LeadFace.Stopped,
};

/** A row the lead works on itself, working now: one no worker holds (an Unreal lead's milestone). */
const isLeadAtWork = (row: PartRow): boolean => row.working && row.facet.worker === undefined;

/**
 * The lead's card sentence by its face. In a tree the lead at work may have a row of its own at
 * work, so it never says nothing works; a graph that is no tree keeps its words.
 */
export function leadAbout(face: LeadFace, tree: boolean): string {
  return tree && face === LeadFace.Working ? LEAD_WORDS.aboutWorkingInTree : LEAD_WORDS.about[face];
}

/**
 * What the lead of a tree is doing: while the run goes on it works itself, while a row of its
 * own works or no worker works, and waits only while every working row is a worker's; then
 * paused, stopped, or done. A chat turn is done once no worker works.
 */
export function leadFace(graph: RunGraph, summary: RunSummary | null, rows: PartRow[]): LeadFace {
  const execution = runExecution(graph, summary);
  if (execution !== ExecutionStatus.Running) return CLOSED_FACE[execution] ?? LeadFace.Done;
  const waits = rows.some(isWorkerAtWork) && !rows.some(isLeadAtWork);
  return waits ? LeadFace.Waiting : LeadFace.Working;
}

/** Whole minutes a job has run by `now`, 0 when its start is unknown or ahead of the clock. */
function minutesRunning(job: JobInfo, now: number): number {
  const started = Date.parse(job.startedAt ?? "");
  return Number.isFinite(started) ? Math.max(0, (now - started) / MINUTE_MS) : 0;
}

/** Where one job is, with how long it ran: "4 min" while it runs, "finished · 4 min", "stopped". */
export function jobStateWords(job: JobInfo, now: number): string {
  const minutes = job.state === JobState.Running ? minutesRunning(job, now) : (job.durationMs ?? 0) / MINUTE_MS;
  return jobStatusWords(job.state, job.stoppedBy ?? undefined, minutes);
}

/**
 * The background tile's words: the newest running job by name with its minutes, then the rest
 * counted ("4 min · 2 finished"); with none running, the newest job and how it ended, or how many
 * finished.
 */
export function jobsTileStatus(jobs: JobInfo[], now: number): JobsTileStatus {
  const running = jobs.filter((job) => job.state === JobState.Running);
  const ended = jobs.length - running.length;
  const newestRunning = running.at(-1);
  if (newestRunning) {
    const rest = backgroundCount(running.length - 1, ended);
    const status = [jobStateWords(newestRunning, now), rest].filter(Boolean).join(" · ");
    return { title: newestRunning.title, status, tone: Tone.Accent };
  }
  const newest = jobs.at(-1);
  if (!newest) return { title: "", status: "", tone: Tone.Muted };
  const status = jobs.length === 1 ? jobStateWords(newest, now) : backgroundCount(0, ended);
  return { title: newest.title, status, tone: Tone.Muted };
}

/** Which of the graph's own nodes there are to step through, besides the start, the rows and the result. */
export interface ReadingNodes {
  assets: boolean;
  tree: boolean;
  jobs: boolean;
  optimization: boolean;
  finishCheck: boolean;
  /** the lead has the run to itself: in a graph that is no tree, drawn after the result */
  lead: boolean;
}

/** The nodes of a graph there are to step through, as the Builds tab draws them. */
export function readingNodes(graph: RunGraph, rows: PartRow[], summary: RunSummary | null): ReadingNodes {
  return {
    assets: hasNode(graph, GraphNodeKind.Blender) || hasNode(graph, GraphNodeKind.Assets),
    tree: graph.tree,
    jobs: (leadNodeOf(graph)?.jobs.length ?? 0) > 0,
    optimization: hasNode(graph, GraphNodeKind.Optimization),
    finishCheck: hasNode(graph, GraphNodeKind.FinishCheck),
    lead: leadWorking(graph, summary, rows),
  };
}

/**
 * The graph's reading order, left to right: what you asked and its assets, the lead and its
 * background work (in a tree), every step (row by row, or in the layout's own `steps` order), the
 * optimisation card, the result, then the finish check (in a tree) or the lead while it has the run.
 */
export function readingOrder(
  rows: PartRow[],
  nodes: ReadingNodes,
  steps: string[] = rows.flatMap((row) => row.steps.map((step) => step.id)),
): string[] {
  const head = nodes.tree ? [GraphSelection.Lead, ...(nodes.jobs ? [GraphSelection.Jobs] : [])] : [];
  const last = nodes.tree ? nodes.finishCheck && GraphSelection.FinishCheck : nodes.lead && GraphSelection.Lead;
  const tail = last ? [last] : [];
  return [
    GraphSelection.Start,
    ...(nodes.assets ? [GraphSelection.Assets] : []),
    ...head,
    ...steps,
    ...(nodes.optimization ? [GraphSelection.Optimization] : []),
    GraphSelection.Final,
    ...tail,
  ];
}

/** Whether the Builds tab may draw a graph: a run's waits for its recorded outcome; a chat turn has none to wait for. */
export const graphLoaded = (graph: RunGraph, summary: RunSummary | null): boolean =>
  summary !== null || runIdOf(graph) === null;

/** The finish check node's words: its state, then what the newest round says. */
export interface FinishCheckFace {
  name: string;
  word: string;
}

/** The newest round of the run's current ask, or undefined before its first claim. */
const currentRound = (node: FinishCheckNode): FinishRound | undefined =>
  node.rounds.find((round) => round.round === node.round);

/**
 * The line under the finish check's state: the reviewer at work, a no's reasons and count, no
 * answer, a yes, a stop. It reads the run's current ask only (`node.round`, null before its first
 * claim): a reopened run's earlier rounds are listed, never its line.
 */
function finishCheckLine(node: FinishCheckNode): string {
  if (node.state === FinishCheckState.Checking) return FINISH_CHECK_WORDS.checking;
  if (node.state === FinishCheckState.Done) return FINISH_CHECK_WORDS.doneWord;
  if (node.state === FinishCheckState.Stopped) return FINISH_CHECK_WORDS.stoppedWord;
  const newest = currentRound(node);
  if (!newest) return FINISH_CHECK_WORDS.placeholder;
  if (newest.step === FinishCheckStep.Unanswered) return FINISH_CHECK_WORDS.unanswered;
  return FINISH_CHECK_WORDS.roundWord(node.reasons.length, node.rejections);
}

/** What the finish check's node says, in the owner's four states (Not yet, Checking, Done, Stopped). */
export const finishCheckFace = (node: FinishCheckNode): FinishCheckFace => ({
  name: FINISH_CHECK_WORDS.state[node.state],
  word: finishCheckLine(node),
});

/**
 * The finish check's five looks: a ghost until the current ask's first claim, then the owner's
 * four states (not yet after a no or no answer, checking, done, stopped).
 */
export const FinishLook = {
  Placeholder: "placeholder",
  NotYet: "not_yet",
  Checking: "checking",
  Done: "done",
  Stopped: "stopped",
} as const;
export type FinishLook = (typeof FinishLook)[keyof typeof FinishLook];

/** How the finish check's node and card are coloured: the state's ink, and the edge and fill tokens (null for none). */
export interface FinishCheckLook {
  look: FinishLook;
  tone: Tone;
  edge: string | null;
  fill: string | null;
}

/** Each look's ink, edge and fill, in the design's tokens: only the finish check wears these. */
const FINISH_LOOKS: Record<FinishLook, FinishCheckLook> = {
  [FinishLook.Placeholder]: { look: FinishLook.Placeholder, tone: Tone.Muted, edge: null, fill: null },
  [FinishLook.NotYet]: { look: FinishLook.NotYet, tone: Tone.Orange, edge: "var(--orange)", fill: null },
  [FinishLook.Checking]: {
    look: FinishLook.Checking,
    tone: Tone.Accent,
    edge: "var(--accent)",
    fill: "var(--accent-tint)",
  },
  [FinishLook.Done]: { look: FinishLook.Done, tone: Tone.Green, edge: "var(--green)", fill: "var(--green-tint)" },
  [FinishLook.Stopped]: { look: FinishLook.Stopped, tone: Tone.Red, edge: "var(--red)", fill: "var(--red-tint)" },
};

/** Which look a finish check wears: not yet is a ghost until the current ask has a round, as its line says. */
function lookOf(node: FinishCheckNode): FinishLook {
  if (node.state === FinishCheckState.Checking) return FinishLook.Checking;
  if (node.state === FinishCheckState.Done) return FinishLook.Done;
  if (node.state === FinishCheckState.Stopped) return FinishLook.Stopped;
  return currentRound(node) ? FinishLook.NotYet : FinishLook.Placeholder;
}

/** The finish check node's colours (`FINISH_LOOKS`). */
export const finishCheckLook = (node: FinishCheckNode): FinishCheckLook => FINISH_LOOKS[lookOf(node)];

/** The tone of the finish check card's status: the node's ink. */
export const finishPanelTone = (node: FinishCheckNode): Tone => FINISH_LOOKS[lookOf(node)].tone;

/** The ink of a round's reason numbers on the card: amber for why not yet, red for what isn't done, green for why yes. */
export function reasonTone(round: FinishRound): Tone {
  if (round.step === FinishCheckStep.Accepted) return Tone.Green;
  if (round.step !== FinishCheckStep.Rejected) return Tone.Muted;
  return round.stopped ? Tone.Red : Tone.Orange;
}

/** The line under one round on the finish check's card, and whether it reads quietly. */
export interface RoundNote {
  text: string;
  quiet: boolean;
}

/**
 * The line under a round's reasons on the card: why a round had no answer, a yes with no reasons,
 * a stop's pointer to the report, or, for the current ask's newest no, what follows (more no's stop
 * the Loop while it runs; once it is over, that it ended before another check). Null for none.
 */
export function roundNoteOf(round: FinishRound, node: FinishCheckNode): RoundNote | null {
  if (round.step === FinishCheckStep.Unanswered) return round.why ? { text: round.why, quiet: false } : null;
  if (round.step === FinishCheckStep.Accepted)
    return round.reasons.length === 0 ? { text: FINISH_CHECK_WORDS.saidYes, quiet: false } : null;
  if (round.step !== FinishCheckStep.Rejected) return null;
  if (round.stopped) return { text: FINISH_CHECK_WORDS.reportInChat, quiet: true };
  if (round.round !== node.round) return null;
  if (node.over) return { text: FINISH_CHECK_WORDS.endedAfterNo, quiet: true };
  return node.rejections < MAX_FINISH_REJECTIONS
    ? { text: FINISH_CHECK_WORDS.moreNos(node.rejections), quiet: true }
    : null;
}
