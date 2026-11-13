/**
 * The Builds tab as a list: what works now, then what changed, newest first, then the steps whose work
 * was left out of the build, gathered under one row. Each step of the run is a row: its mark, when it
 * ended and what it made or, when its work is not in the build, how it stands. A build check that did
 * not pass is a row of its own (one that passed is not: its step is the row). The lead is a row only
 * while it works itself; its background work, the finish check and the run's assets are rows while
 * the run has them.
 *
 * Pure: no DOM, no window. `BuildsList.tsx` draws it and the tests read it directly.
 */
import { type AssetKind, assetKind } from "../../../shared/game-assets.ts";
import { t } from "../../../shared/i18n.ts";
import { JobState } from "../../../shared/jobs.ts";
import { type AssetInfo, type FinishCheckNode, FinishCheckState, type RunGraph } from "../../run-graph.ts";
import { BLENDER_SOURCE } from "../../run-graph-assets.ts";
import { type BuildCard, BuildOutcome, type BuildTimeline, placedWord } from "../../run-graph-builds.ts";
import type { JobInfo } from "../../run-graph-workers.ts";
import { type AssetCard, isLiveStep, type PartRow, type Step, StepState } from "../../run-steps.ts";
import { finishCheckFace, jobsTileStatus, LeadFace, type ReadingNodes } from "../../run-tree.ts";
import { BUILD_LINE_WORDS, LEAD_WORDS, MADE_WORDS } from "../../words.ts";
import { assetsStatus, isMaking } from "../inspector/asset-jobs.ts";
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

/**
 * The list: what works now, in the order it started, then the steps still to come while the run is
 * live; what changed, newest first; what was left out, newest first.
 */
export interface BuildsList {
  working: ListRow[];
  changes: ListRow[];
  leftOut: ListRow[];
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
  /** the run's asset jobs: the plugins' and the modeller's own */
  assetJobs: AssetInfo[];
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

/** What one thing a step made is: its newest version's kind, by its files, else the modeller's model. */
function madeKind(card: AssetCard): AssetKind {
  const newest = card.versions.at(-1);
  const file = newest?.preview?.file ?? newest?.files[0] ?? newest?.file;
  if (file) return assetKind(file);
  return newest?.source === BLENDER_SOURCE ? "model" : "other";
}

/** What a step made, in words: one thing by its kind and versions, more by each kind's count; null for nothing. */
export function madeWords(cards: readonly AssetCard[]): string | null {
  const [only] = cards;
  if (!only) return null;
  if (cards.length === 1) return MADE_WORDS.one(madeKind(only), only.versions.length);
  const counts: Partial<Record<AssetKind, number>> = {};
  for (const card of cards) counts[madeKind(card)] = (counts[madeKind(card)] ?? 0) + 1;
  return MADE_WORDS.many(counts);
}

/** A step's row. A step in the build says what it made; any other says how it stands. */
function stepRow(step: Step, input: BuildsListInput): Placed {
  const mark = stepMark(step);
  const place = input.timeline?.places.get(step.id);
  return {
    id: step.id,
    title: step.name,
    mark,
    at: stepAt(step),
    detail: mark === RowMark.Added ? madeWords(step.assets ?? []) : placedWord(step, place, input.graph.active),
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

/** Each finish check state's mark: at work while it looks, done, a problem after a no, quiet once stopped. */
const FINISH_MARK: Record<FinishCheckState, RowMark> = {
  [FinishCheckState.Checking]: RowMark.Working,
  [FinishCheckState.Done]: RowMark.Added,
  [FinishCheckState.NotYet]: RowMark.Problem,
  [FinishCheckState.Stopped]: RowMark.Out,
};

/** The finish check's row, marked by its state. */
function finishRow(node: FinishCheckNode | null): ListRow | null {
  if (!node) return null;
  const face = finishCheckFace(node);
  return fixed(GraphSelection.FinishCheck, face.name, FINISH_MARK[node.state], face.word || null);
}

/** The run's assets' row: at work while one is being made, and how they stand. */
function assetsRow(jobs: AssetInfo[]): ListRow {
  const status = jobs.length ? assetsStatus(jobs).text : null;
  return fixed(GraphSelection.Assets, MESSAGE.assets, jobs.some(isMaking) ? RowMark.Working : RowMark.Added, status);
}

/** The run's own rows that are no step: the ones at work, and the ones that head what changed. */
function fixedRows(input: BuildsListInput): ListRow[] {
  const lead = leadWorks(input) ? fixed(GraphSelection.Lead, LEAD_WORDS.name, RowMark.Working) : null;
  const assets = input.nodes.assets ? assetsRow(input.assetJobs) : null;
  return [lead, finishRow(input.finishCheck), jobsRow(input), assets].filter((row): row is ListRow => row !== null);
}

/** The Builds list of a run or a chat turn's graph. */
export function buildsList(input: BuildsListInput): BuildsList {
  const steps = input.rows.flatMap((row) => row.steps).map((step) => stepRow(step, input));
  const failed = (input.timeline?.builds ?? []).filter((build) => build.outcome !== BuildOutcome.Passed).map(buildRow);
  const fixedOnes = fixedRows(input);
  const atWork = (row: ListRow): boolean => row.mark === RowMark.Working;
  // A step not ended yet waits with the work while the run is live; once it is over, it was left out.
  const waits = (row: ListRow): boolean => row.mark === RowMark.Waiting;
  const live = input.graph.active === true;
  const current = (row: ListRow): boolean => atWork(row) || (live && waits(row));
  const plain = ({ order: _order, ...row }: Placed): ListRow => row;
  const working = [
    ...fixedOnes.filter(atWork),
    ...steps
      .filter(current)
      .sort((a, b) => Number(waits(a)) - Number(waits(b)) || a.order - b.order)
      .map(plain),
  ];
  const ended = steps.filter((row) => !current(row));
  const left = (row: Placed): boolean => row.mark === RowMark.Out || waits(row);
  const newestFirst = (rows: Placed[]): ListRow[] => rows.sort((a, b) => b.order - a.order).map(plain);
  const changes = [
    ...fixedOnes.filter((row) => !atWork(row)),
    ...newestFirst([...ended.filter((row) => !left(row)), ...failed]),
  ];
  return { working, changes, leftOut: newestFirst(ended.filter(left)) };
}

/** Every row of the list in the order it reads: what works, what changed, what was left out. */
export const listRows = (list: BuildsList): ListRow[] => [...list.working, ...list.changes, ...list.leftOut];

/**
 * The row of a step of the chat's Building card (`chat/build-checklist.ts`), or null when the list
 * has none: a worker's part by its part's id, a lead's save point by its part and try.
 */
export function rowOfChecklist(list: BuildsList, checklistId: string): string | null {
  const isIt = (step: Step): boolean =>
    step.facetId === checklistId || step.tries.some((node) => `${node.facetId}:${node.iteration}` === checklistId);
  return listRows(list).find((row) => row.step !== null && isIt(row.step))?.id ?? null;
}
