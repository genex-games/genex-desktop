/**
 * The running build's steps as the Building card lists them (`BuildChecklist.tsx`): each save point
 * its lead made, by its label, in the order saved, then each part a worker built — a restart
 * (`replaces`) stays on its part's row, as the run's summary groups it — added, working or ended
 * without it. The lead itself is no row: what it does now is the card's line. Its counts make that
 * line once there is a step. Pure: read from the run's summary, which main builds from the whole log.
 */
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

/** The checklist: its rows, how many of them are done and how many work now. */
export interface BuildChecklist {
  rows: ChecklistRow[];
  done: number;
  working: number;
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

/** The checklist of a running build at `now`, or null before it has a save point or a worker. */
export function buildChecklist(summary: RunSummary | null, now: number): BuildChecklist | null {
  const tasks = summary?.tasks ?? [];
  const parts = tasks.filter((task) => task.id !== LEAD_PART);
  const leadRows = savePointRows(tasks.find((task) => task.id === LEAD_PART));
  const rows = [...leadRows, ...parts.map((task) => partRow(task, now))];
  if (!rows.length) return null;
  const done = rows.filter((row) => row.mark === PartMark.Added).length;
  const working = rows.filter((row) => row.mark === PartMark.Working).length;
  return { rows, done, working };
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

/** A long list as the card shows it: its latest rows, the earlier ones counted, until the person opens them. */
export function foldChecklist(rows: ChecklistRow[], opened: boolean): FoldedChecklist {
  if (opened || rows.length <= CHECKLIST_FOLD_PAST) return { rows, hidden: 0 };
  return { rows: rows.slice(-CHECKLIST_ROWS_SHOWN), hidden: rows.length - CHECKLIST_ROWS_SHOWN };
}

/** The card's one line, counted from its checklist: how many steps are done, and how many work. */
export function checklistCaption(list: BuildChecklist, finishing: boolean): string {
  return finishing ? WORDS.finishing(list.working) : WORDS.caption(list.done, list.working);
}
