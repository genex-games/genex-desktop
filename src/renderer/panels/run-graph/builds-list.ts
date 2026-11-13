/**
 * The Builds tab as a list: what works now, then what changed, newest first. Each step of the run is
 * a row: its mark, when it ended and, when its work is not in the build, how it stands. A build check
 * that did not pass is a row of its own (one that passed is not: its step is the row). The lead is a
 * row only while it works itself; its background work, the finish check and the run's assets are
 * rows while the run has them.
 *
 * Pure: no DOM, no window. `BuildsList.tsx` draws it and the tests read it directly.
 */
import { t } from "../../../shared/i18n.ts";
import { JobState } from "../../../shared/jobs.ts";
import { type FinishCheckNode, FinishCheckState, type RunGraph } from "../../run-graph.ts";
import { type BuildCard, BuildOutcome, type BuildTimeline, placedWord } from "../../run-graph-builds.ts";
import type { JobInfo } from "../../run-graph-workers.ts";
import { isLiveStep, type PartRow, type Step, StepState } from "../../run-steps.ts";
import { finishCheckFace, jobsTileStatus, LeadFace, type ReadingNodes } from "../../run-tree.ts";
import { BUILD_LINE_WORDS, LEAD_WORDS } from "../../words.ts";
import { GraphSelection } from "../inspector/selection.ts";

const MESSAGE = { assets: t("Assets") } as const;

/** A row's mark: its work is in the build, under way, left out of it, a check that did not pass, or not started. */
export const RowMark = {
  Added: "added",
  Working: "working",
  Out: "out",
  Problem: "problem",
  Waiting: "waiting",
} as const;
export type RowMark = (typeof RowMark)[keyof typeof RowMark];

/** One row of the list. */
export interface ListRow {
  /** its selection id: a step's own, a build's, or one of the graph's fixed nodes */
  id: string;
  title: string;
  mark: RowMark;
  /** when it ended (or, for a row at work, started), as the log wrote it; null when the log gave none */
  at: string | null;
  /** how it stands, in words, when the mark alone does not say it */
  detail: string | null;
  /** the step it is, when it is one */
  step: Step | null;
  /** the build whose check it is, when it is one */
  build: BuildCard | null;
}

/** The list: what works now, in the order it started; what changed, newest first. */
export interface BuildsList {
  working: ListRow[];
  changes: ListRow[];
}

/** What the list is folded from: the Builds model's parts. */
export interface BuildsListInput {
  graph: RunGraph;
  rows: PartRow[];
  timeline: BuildTimeline | null;
  nodes: ReadingNodes;
  /** what the lead of a tree is doing; null for a graph that is no tree */
  face: LeadFace | null;
  /** the lead has the run to itself between parts */
  leadAtWork: boolean;
  jobs: JobInfo[];
  finishCheck: FinishCheckNode | null;
  now: number;
}

/** A row with where it sorts: its place in the log, later first. */
type Placed = ListRow & { order: number };

/** A row that is neither a step nor a build: the lead, its background work, the finish check, the assets. */
const fixed = (id: string, title: string, mark: RowMark, detail: string | null = null): ListRow => ({
  id,
  title,
  mark,
  at: null,
  detail,
  step: null,
  build: null,
});

/** The steps whose work is in the build, or on its way there. */
const IN_BUILD: ReadonlySet<StepState> = new Set([StepState.InBuild, StepState.Kept, StepState.Delivered]);
/** The steps that have not ended either way: not started, or stopped by a pause with their work kept. */
const NOT_ENDED: ReadonlySet<StepState> = new Set([StepState.Waiting, StepState.Paused]);

/** A step's mark, by where its work stands. */
function stepMark(step: Step): RowMark {
  if (isLiveStep(step)) return RowMark.Working;
  if (IN_BUILD.has(step.state)) return RowMark.Added;
  return NOT_ENDED.has(step.state) ? RowMark.Waiting : RowMark.Out;
}

/** When a step ended, or started while it works: its worker's records, else its shown try's. */
function stepAt(step: Step): string | null {
  const worker = step.worker;
  if (worker) return worker.settledAt ?? worker.startedAt;
  return step.shown?.judgedAt ?? step.shown?.startedAt ?? null;
}

/** Where a step sorts: its worker's last record, else its shown try's verdict or start. */
function stepOrder(step: Step): number {
  const worker = step.worker;
  if (worker) return worker.settledSeq ?? worker.startedSeq ?? 0;
  return step.shown?.judgedSeq ?? step.shown?.startedSeq ?? 0;
}

/** A step's row. A step in the build says nothing more; any other says how it stands. */
function stepRow(step: Step, input: BuildsListInput): Placed {
  const mark = stepMark(step);
  const place = input.timeline?.places.get(step.id);
  return {
    id: step.id,
    title: step.name,
    mark,
    at: stepAt(step),
    detail: mark === RowMark.Added ? null : placedWord(step, place, input.graph.active),
    step,
    build: null,
    order: stepOrder(step),
  };
}

/** The row of a build whose check did not pass: what it found first, in plain words, and its outcome. */
function buildRow(build: BuildCard): Placed {
  const [finding] = build.findings;
  const title = finding ? BUILD_LINE_WORDS.finding[finding] : BUILD_LINE_WORDS.name(build.n);
  return {
    id: build.id,
    title,
    mark: RowMark.Problem,
    at: build.at,
    detail: BUILD_LINE_WORDS.outcome[build.outcome],
    step: null,
    build,
    order: build.seq,
  };
}

/** Whether the lead works itself: in a tree by its face, else while it has the run between parts. */
const leadWorks = (input: BuildsListInput): boolean =>
  input.face === null ? input.leadAtWork : input.face === LeadFace.Working;

/** The background work's row: at work while a job runs, else how it ended. */
function jobsRow(input: BuildsListInput): ListRow | null {
  if (!input.nodes.jobs) return null;
  const running = input.jobs.some((job) => job.state === JobState.Running);
  const status = jobsTileStatus(input.jobs, input.now);
  return fixed(GraphSelection.Jobs, status.title, running ? RowMark.Working : RowMark.Added, status.status || null);
}

/** The finish check's row: at work while it looks, a problem after a no, else done. */
function finishRow(node: FinishCheckNode | null): ListRow | null {
  if (!node) return null;
  const face = finishCheckFace(node);
  const marks: Partial<Record<FinishCheckState, RowMark>> = {
    [FinishCheckState.Checking]: RowMark.Working,
    [FinishCheckState.Done]: RowMark.Added,
  };
  return fixed(GraphSelection.FinishCheck, face.name, marks[node.state] ?? RowMark.Problem, face.word || null);
}

/** The run's own rows that are no step: the ones at work, and the ones that head what changed. */
function fixedRows(input: BuildsListInput): ListRow[] {
  const lead = leadWorks(input) ? fixed(GraphSelection.Lead, LEAD_WORDS.name, RowMark.Working) : null;
  const assets = input.nodes.assets ? fixed(GraphSelection.Assets, MESSAGE.assets, RowMark.Added) : null;
  return [lead, finishRow(input.finishCheck), jobsRow(input), assets].filter((row): row is ListRow => row !== null);
}

/** The Builds list of a run or a chat turn's graph. */
export function buildsList(input: BuildsListInput): BuildsList {
  const steps = input.rows.flatMap((row) => row.steps).map((step) => stepRow(step, input));
  const failed = (input.timeline?.builds ?? []).filter((build) => build.outcome !== BuildOutcome.Passed).map(buildRow);
  const fixedOnes = fixedRows(input);
  const atWork = (row: ListRow): boolean => row.mark === RowMark.Working;
  const plain = ({ order: _order, ...row }: Placed): ListRow => row;
  const working = [
    ...fixedOnes.filter(atWork),
    ...steps
      .filter(atWork)
      .sort((a, b) => a.order - b.order)
      .map(plain),
  ];
  const changes = [
    ...fixedOnes.filter((row) => !atWork(row)),
    ...[...steps.filter((row) => !atWork(row)), ...failed].sort((a, b) => b.order - a.order).map(plain),
  ];
  return { working, changes };
}

/** Every row of the list, what works first. */
export const listRows = (list: BuildsList): ListRow[] => [...list.working, ...list.changes];

/**
 * The row of a step of the chat's Building card (`chat/build-checklist.ts`), or null when the list
 * has none: a worker's part by its part's id, a lead's save point by its part and try.
 */
export function rowOfChecklist(list: BuildsList, checklistId: string): string | null {
  const isIt = (step: Step): boolean =>
    step.facetId === checklistId || step.tries.some((node) => `${node.facetId}:${node.iteration}` === checklistId);
  return listRows(list).find((row) => row.step !== null && isIt(row.step))?.id ?? null;
}
