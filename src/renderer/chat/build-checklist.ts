/**
 * The running build's steps as the Building card lists them (`BuildChecklist.tsx`): each save point
 * its lead made, by its label, in the order saved, then each part a worker built — a restart
 * (`replaces`) stays on its part's row, as the run's summary groups it — added, working or ended
 * without it. The lead itself is no row: what it does now is the card's line. Its counts make that
 * line once there is a step. Pure: read from the run's summary, which main builds from the whole log.
 */
import { buildTitle } from "../../shared/build-title.ts";
import { LEAD_PART } from "../../shared/custom-events.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import type { RunSummary, RunTask } from "../../shared/run-summary.ts";
import { WorkerState } from "../run-graph.ts";
import { BUILD_CHECKLIST_WORDS as WORDS } from "../words.ts";

/** A row's mark: a tick once added, a dashed ring while it works, an empty ring otherwise. */
export const PartMark = { Added: "added", Working: "working", Next: "next" } as const;
export type PartMark = (typeof PartMark)[keyof typeof PartMark];

/** One row of the checklist. */
export interface ChecklistRow {
  id: string;
  title: string;
  mark: PartMark;
  /** Where it stands, in the words on the row's right. */
  status: string;
}

/** Where the lead is in its plan: its step `n` (from 1) of `total`, by name. */
export interface PlanStep {
  n: number;
  total: number;
  name: string;
}

/** The checklist: its rows, how many of them are done and how many work now, and the plan's step when the lead named a plan. */
export interface BuildChecklist {
  rows: ChecklistRow[];
  done: number;
  working: number;
  step?: PlanStep;
  /** How many of its first rows are the lead's own (its plan's steps, or its save points); the parts follow. */
  lead: number;
}

/** Whether a part's worker is building now. */
const isWorking = (task: RunTask): boolean => task.state === WorkerState.Running;

/** What a working part says: its time left when its round named a deadline, else its round. */
function workingStatus(task: RunTask, now: number): string {
  const left = typeof task.deadlineMs === "number" ? Math.round((task.deadlineMs - now) / MINUTE_MS) : 0;
  if (left >= 1) return WORDS.workingFor(left);
  return typeof task.round === "number" ? WORDS.workingRound(task.round) : WORDS.working;
}

/** A part's row: its work in the build, under way, or ended without it. */
function partRow(task: RunTask, now: number): ChecklistRow {
  const row = { id: task.id, title: task.title };
  if (isWorking(task)) return { ...row, mark: PartMark.Working, status: workingStatus(task, now) };
  if (task.integrations > 0 || task.added === true) return { ...row, mark: PartMark.Added, status: WORDS.added };
  return { ...row, mark: PartMark.Next, status: WORDS.notAdded };
}

/** The save points the lead made, in the order it made them, each done under its label: Genex's autosaves are none. */
function savePointRows(lead: RunTask | undefined): ChecklistRow[] {
  return (lead?.attempts ?? []).flatMap((attempt) =>
    attempt.label && !attempt.auto
      ? [{ id: attempt.id, title: attempt.label, mark: PartMark.Added, status: WORDS.added }]
      : [],
  );
}

/**
 * The lead's plan as rows: each save point ticks the next step, the step after the last save point
 * is at work, the rest wait. Save points past the plan keep their own labels; the last step stays
 * the current one until the build ends.
 */
function planRows(steps: string[], saved: ChecklistRow[]): { rows: ChecklistRow[]; step: PlanStep } {
  const rows = steps.map((name, at): ChecklistRow => {
    const id = `step-${at}`;
    if (at < saved.length) return { id, title: name, mark: PartMark.Added, status: WORDS.added };
    if (at === saved.length) return { id, title: name, mark: PartMark.Working, status: WORDS.working };
    return { id, title: name, mark: PartMark.Next, status: "" };
  });
  const n = Math.min(saved.length + 1, steps.length);
  return { rows: [...rows, ...saved.slice(steps.length)], step: { n, total: steps.length, name: steps[n - 1] ?? "" } };
}

/** The checklist of a running build at `now`, or null before it has a plan, a save point or a worker. */
export function buildChecklist(summary: RunSummary | null, now: number): BuildChecklist | null {
  const tasks = summary?.tasks ?? [];
  const parts = tasks.filter((task) => task.id !== LEAD_PART);
  const saved = savePointRows(tasks.find((task) => task.id === LEAD_PART));
  const plan = summary?.steps?.length ? planRows(summary.steps, saved) : null;
  const leadRows = plan?.rows ?? saved;
  const rows = [...leadRows, ...parts.map((task) => partRow(task, now))];
  if (!rows.length) return null;
  const done = rows.filter((row) => row.mark === PartMark.Added).length;
  const working = rows.filter((row) => row.mark === PartMark.Working).length;
  return { rows, done, working, lead: leadRows.length, ...(plan ? { step: plan.step } : {}) };
}

/**
 * What the lead is doing, in one line both the chat's Building card and the lead's row in Builds
 * say: its plan's step when it named a plan, else its own last words; null when it said nothing yet.
 */
export function leadLine(summary: RunSummary | null, now: number): string | null {
  const step = buildChecklist(summary, now)?.step;
  if (step) return WORDS.step(step.n, step.total, step.name);
  return summary?.lead?.said.at(-1)?.text ?? null;
}

/** The build's name: the title the chat gave it, else its lead's first save point; "" when it has neither. */
export function summaryTitle(summary: RunSummary | null | undefined): string {
  const lead = summary?.tasks.find((task) => task.id === LEAD_PART);
  const firstSavePoint = lead?.attempts.find((attempt) => attempt.label && !attempt.auto)?.label ?? null;
  return buildTitle({ title: summary?.title ?? null, firstSavePoint });
}

/** A list longer than this many rows folds: the card would otherwise push the chat away. */
export const CHECKLIST_FOLD_PAST = 7;
/** How many of its latest rows a folded list shows. */
export const CHECKLIST_ROWS_SHOWN = 5;

/** The rows a card shows, and how many earlier ones it folds away. */
export interface FoldedChecklist {
  rows: ChecklistRow[];
  hidden: number;
}

/**
 * A long list as the card shows it: its latest rows, the earlier ones counted, until the person
 * opens them. Only rows already done at its top fold: the step at work and the ones after it stay.
 */
export function foldChecklist(rows: ChecklistRow[], opened: boolean): FoldedChecklist {
  if (opened || rows.length <= CHECKLIST_FOLD_PAST) return { rows, hidden: 0 };
  const firstNotDone = rows.findIndex((row) => row.mark !== PartMark.Added);
  const doneAtTop = firstNotDone < 0 ? rows.length : firstNotDone;
  const hidden = Math.min(rows.length - CHECKLIST_ROWS_SHOWN, doneAtTop);
  return { rows: rows.slice(hidden), hidden };
}

/** The card's one line, counted from its checklist: how many steps are done, and how many work. */
export function checklistCaption(list: BuildChecklist, finishing: boolean): string {
  if (finishing) return WORDS.finishing(list.working);
  if (list.step) return WORDS.step(list.step.n, list.step.total, list.step.name);
  return WORDS.caption(list.done, list.working);
}
