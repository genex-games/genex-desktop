/**
 * The Builds list's lead and its company: a graph that holds a worker's or a job's records
 * (`RunGraph.tree`) has a lead working between its workers, its background work and, in a run, the
 * finish check. This module says what the lead is doing, what its background work's row reads and
 * which of these rows the list has (`panels/run-graph/builds-list.ts`).
 *
 * Pure: no DOM, no window. `panels/run-graph/use-builds-model.ts` and the tests share it.
 */
import { MINUTE_MS } from "../shared/duration.ts";
import { FinishCheckStep } from "../shared/finish-check.ts";
import { JobState } from "../shared/jobs.ts";
import { ExecutionStatus } from "../shared/run-state.ts";
import type { RunSummary } from "../shared/run-summary.ts";
import {
  type FinishCheckNode,
  FinishCheckState,
  type FinishRound,
  GraphNodeKind,
  healthPicture,
  type LeadNode,
  type RunGraph,
  roundShot,
  runIdOf,
} from "./run-graph.ts";
import type { JobInfo } from "./run-graph-workers.ts";
import {
  isWorkerAtWork,
  lastSavePoint,
  leadWorking,
  type PartRow,
  runExecution,
  type Step,
  Tone,
} from "./run-steps.ts";
import { backgroundCount, FINISH_CHECK_WORDS, jobStatusWords, LEAD_WORDS } from "./words.ts";

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

/** How a run's close reads on the lead: stopped for a failure or a cancel, done for any other. */
const CLOSED_FACE: Partial<Record<string, LeadFace>> = {
  [ExecutionStatus.Paused]: LeadFace.Paused,
  [ExecutionStatus.Failed]: LeadFace.Stopped,
  [ExecutionStatus.Cancelled]: LeadFace.Stopped,
};

/** A row the lead works on itself, working now: one no worker holds (a lead's milestone). */
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

/** The lead's faces whose work stands where they left it: done, or paused with the Loop. */
const AT_REST: ReadonlySet<LeadFace> = new Set([LeadFace.Done, LeadFace.Paused]);

/** What a lead at rest wears: the run's last save point, whose card picks its picture, or a build's screenshot. */
export type LeadRest = { save: Step } | { build: string };

/** Whether a save point kept a picture its card can wear. */
const pictured = (save: Step): boolean => save.shown !== null && roundShot(save.shown) !== null;

/**
 * What the lead wears once it is done or paused: its work is where the run's last save point left
 * it; where its build stands (`build`, the build's own picture) when that save point kept no picture;
 * and in a Loop without save points, that picture or else the newest screenshot a health check kept.
 * Null while it works, waits or after a stop, and in a run with none of them.
 */
export function leadRest(
  graph: RunGraph,
  rows: PartRow[],
  face: LeadFace,
  build: string | null = null,
): LeadRest | null {
  if (!AT_REST.has(face)) return null;
  const save = lastSavePoint(rows);
  // A health check's picture may be older than the save point: only the build's own stands in for it.
  if (save) return pictured(save) || !build ? { save } : { build };
  const built = build ?? healthPicture(graph, null)?.path;
  return built ? { build: built } : null;
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
    finishCheck: hasNode(graph, GraphNodeKind.FinishCheck),
    lead: leadWorking(graph, summary, rows),
  };
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
export const currentRound = (node: FinishCheckNode): FinishRound | undefined =>
  node.rounds.find((round) => round.round === node.round);

/** What a no left to fix: what the reviewer named not done, else (an older record) its reasons. */
export const leftOf = (round: FinishRound): string[] => (round.notDone.length ? round.notDone : round.reasons);

/**
 * The line under the final look's state: looking, how many things a no left, no answer, all done.
 * It reads the run's current ask only (`node.round`); a node drawn before its first claim says nothing.
 */
function finishCheckLine(node: FinishCheckNode): string {
  if (node.state === FinishCheckState.Checking) return FINISH_CHECK_WORDS.checking;
  if (node.state === FinishCheckState.Done) return FINISH_CHECK_WORDS.doneWord;
  const newest = currentRound(node);
  if (!newest) return "";
  if (newest.step === FinishCheckStep.Unanswered) return FINISH_CHECK_WORDS.unanswered;
  return FINISH_CHECK_WORDS.leftWord(leftOf(newest).length);
}

/** What the finish check's node says, in the owner's four states (Not yet, Checking, Done, Stopped). */
export const finishCheckFace = (node: FinishCheckNode): FinishCheckFace => ({
  name: FINISH_CHECK_WORDS.state[node.state],
  word: finishCheckLine(node),
});

/** The finish check's four looks, the owner's states: not yet after a no or no answer, checking, done, stopped. */
export const FinishLook = {
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

/** Which look a finish check wears, by its state. */
function lookOf(node: FinishCheckNode): FinishLook {
  if (node.state === FinishCheckState.Checking) return FinishLook.Checking;
  if (node.state === FinishCheckState.Done) return FinishLook.Done;
  if (node.state === FinishCheckState.Stopped) return FinishLook.Stopped;
  return FinishLook.NotYet;
}

/** The finish check node's colours (`FINISH_LOOKS`). */
export const finishCheckLook = (node: FinishCheckNode): FinishCheckLook => FINISH_LOOKS[lookOf(node)];

/** The tone of the finish check card's status: the node's ink. */
export const finishPanelTone = (node: FinishCheckNode): Tone => FINISH_LOOKS[lookOf(node)].tone;

/** Whether the Loop is over for a no: the no's stopped it, or it ended some other way since. */
export const endedOnNo = (round: FinishRound, node: FinishCheckNode): boolean => round.stopped || node.over;

/** The line under one round on the finish check's card, and whether it reads quietly. */
export interface RoundNote {
  text: string;
  quiet: boolean;
}

/**
 * The line under what a no left, for the current ask's newest no while its Loop has not stopped on
 * it: the Loop keeps working on it, or, once it is over, it ended before another look. A stop shows
 * Keep building instead. Null for anything else.
 */
export function roundNoteOf(round: FinishRound, node: FinishCheckNode): RoundNote | null {
  if (round.step !== FinishCheckStep.Rejected || round.stopped || round.round !== node.round) return null;
  if (node.over) return { text: FINISH_CHECK_WORDS.endedAfterNo, quiet: true };
  return { text: FINISH_CHECK_WORDS.keepsWorking, quiet: true };
}
