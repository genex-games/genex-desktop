/**
 * The running build's parts as the Building card lists them (`BuildChecklist.tsx`): every part the
 * plan names, then any other a worker built — a restart (`replaces`) stays on its part's row, as
 * the run's summary groups it — each added, working or still to come, and last the lead putting it
 * all together. Its counts make the card's one line. Pure: read from the run's summary and plan.
 */
import { CustomEvent, customRecord } from "../../shared/custom-events.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import type { EventEnvelope } from "../../shared/event-log.ts";
import type { RunSummary, RunTask } from "../../shared/run-summary.ts";
import { WorkerState } from "../run-graph.ts";
import { BUILD_CHECKLIST_WORDS as WORDS } from "../words.ts";

/** A row's mark: a tick once added, a dashed ring while it works, an empty ring otherwise. */
export const PartMark = { Added: "added", Working: "working", Next: "next" } as const;
export type PartMark = (typeof PartMark)[keyof typeof PartMark];

/** The id of the lead's own last row, apart from every part's. */
const TOGETHER = "together";

/** One row of the checklist. */
export interface ChecklistRow {
  id: string;
  title: string;
  mark: PartMark;
  /** Where it stands, in the words on the row's right. */
  status: string;
}

/** The checklist: its rows (the parts, then the lead's step) and the counts of the parts alone. */
export interface BuildChecklist {
  rows: ChecklistRow[];
  added: number;
  total: number;
  working: number;
}

/** A part the plan names: its id and title. */
export interface PlannedPart {
  id: string;
  title: string;
}

/** The parts of the run's newest plan, in its order: what the plan card showed the user. */
export function runPlanParts(events: readonly EventEnvelope[], runId: string | null): PlannedPart[] {
  if (!runId) return [];
  let parts: PlannedPart[] = [];
  for (const event of events) {
    const custom = customRecord(event.data);
    if (custom?.event_type !== CustomEvent.AutopilotPlanReview || custom.payload.runId !== runId) continue;
    const facets = Array.isArray(custom.payload.facets) ? custom.payload.facets : [];
    parts = facets.flatMap((facet) =>
      typeof facet?.id === "string" && facet.id ? [{ id: facet.id, title: String(facet.title || facet.id) }] : [],
    );
  }
  return parts;
}

/** Whether a part's worker is building now. */
const isWorking = (task: RunTask): boolean => task.state === WorkerState.Running;

/** What a working part says: its time left when its round named a deadline, else its round. */
function workingStatus(task: RunTask, now: number): string {
  const left = typeof task.deadlineMs === "number" ? Math.round((task.deadlineMs - now) / MINUTE_MS) : 0;
  if (left >= 1) return WORDS.workingFor(left);
  return typeof task.round === "number" ? WORDS.workingRound(task.round) : WORDS.working;
}

/** A part's row: its work in the build, under way, ended without it, or not started. */
function partRow(part: PlannedPart, task: RunTask | undefined, { finishing, now }: RowContext): ChecklistRow {
  const row = { id: part.id, title: part.title };
  if (task && isWorking(task)) return { ...row, mark: PartMark.Working, status: workingStatus(task, now) };
  if (task && (task.integrations > 0 || task.added === true))
    return { ...row, mark: PartMark.Added, status: WORDS.added };
  if (task) return { ...row, mark: PartMark.Next, status: WORDS.notAdded };
  return { ...row, mark: PartMark.Next, status: finishing ? WORDS.notStarted : WORDS.waiting };
}

/** What every row reads besides its part: whether the run is finishing, and the clock. */
interface RowContext {
  finishing: boolean;
  now: number;
}

/** The lead's last step: under way once the run is finishing and no part works, else next. */
function togetherRow(working: number, finishing: boolean): ChecklistRow {
  const now = finishing && working === 0;
  return {
    id: TOGETHER,
    title: WORDS.together,
    mark: now ? PartMark.Working : PartMark.Next,
    status: now ? WORDS.working : WORDS.next,
  };
}

/**
 * What a running build's checklist is read from: its summary, its plan's parts, and whether the
 * user asked it to finish (run-inbox `finishRequested`).
 */
export interface BuildParts {
  summary: RunSummary | null;
  plan: readonly PlannedPart[];
  finishing: boolean;
}

/** The checklist of a running build at `now`, or null before it has a plan or a worker. */
export function buildChecklist({ summary, plan, finishing, now }: BuildParts & { now: number }): BuildChecklist | null {
  const tasks = summary?.tasks ?? [];
  const planned = new Set(plan.map((part) => part.id));
  const extra = tasks.filter((task) => !planned.has(task.id)).map((task) => ({ id: task.id, title: task.title }));
  const parts = [...plan, ...extra];
  if (!parts.length) return null;
  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  const context = { finishing, now };
  const rows = parts.map((part) => partRow(part, byId.get(part.id), context));
  const added = rows.filter((row) => row.mark === PartMark.Added).length;
  const working = rows.filter((row) => row.mark === PartMark.Working).length;
  return { rows: [...rows, togetherRow(working, finishing)], added, total: rows.length, working };
}

/** The card's one line, counted from its checklist: how many parts are in, and how many work. */
export function checklistCaption(list: BuildChecklist, finishing: boolean): string {
  return finishing ? WORDS.finishing(list.working) : WORDS.caption(list.added, list.total, list.working);
}
