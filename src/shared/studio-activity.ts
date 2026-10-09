import { compareIds } from "./compare-ids.ts";
import { AutoResumeCause, CustomEvent } from "./custom-events.ts";
import { EventKind, type EventEnvelope } from "./event-log.ts";
import { ExecutionStatus } from "./run-state.ts";
import {
  RunSummaryAccumulator,
  summarizeRun,
  summaryOutcome,
  UNKNOWN_EXECUTION,
  type OutcomeView,
  type RunSummary,
} from "./run-summary.ts";
import { UNDONE_BY_USER, undoneSelfChanges } from "./run-review.ts";
import { changeTitle, plural, skillWords } from "./skill-words.ts";
import { agentChangedFile } from "./self-change-files.ts";

/** What a run left the user with, in the words Activity shows. */
export type RunOutcomeKind = "running" | "delivered" | "none" | "failed" | "stopped" | "unknown";

export interface StudioActivityItem {
  id: string;
  at: string;
  /** `recovery` and `upkeep` are Studio looking after itself; neither is a result for the user. */
  kind: "run" | "improvement" | "learning" | "recovery" | "upkeep";
  title: string;
  /** A learned change's own state (`Undone`, `2 awaiting review`); a run has `runOutcome` instead. */
  status?: string;
  /** Where a run stands, as fields; the renderer words it (`outcomeTitle` in renderer/words.ts). */
  runOutcome?: OutcomeView;
  detail: string;
  attention?: boolean;
  project?: string;
  runId?: string;
  snapshotId?: string;
  undone?: boolean;
  outcome?: RunOutcomeKind;
  /** The run's own plain report, when it wrote one. */
  report?: string;
  /** Plain lines describing an instruction change, and who let it land. */
  summary?: string[];
  approvedBy?: "auto" | "human";
}

/** Log records that belong to Activity rather than to the Studio conversation. */
export const STUDIO_RECORD_EVENTS = new Set<string>([
  CustomEvent.SkilloptAccepted,
  CustomEvent.SkilloptPass,
  CustomEvent.SkilloptRejected,
  CustomEvent.SkilloptStaged,
  CustomEvent.SkilloptLessonsStaged,
  CustomEvent.RunLearning,
  CustomEvent.ImprovementApplied,
  CustomEvent.SelfEdit,
  CustomEvent.SkillEdited,
  CustomEvent.ToolInstalled,
  CustomEvent.SelfChangeUndone,
  CustomEvent.SeedUpgraded,
  CustomEvent.HarnessLayoutMigrated,
  CustomEvent.HarnessDowngraded,
  CustomEvent.HarnessReseeded,
  CustomEvent.RebuildAndRestartStudio,
  CustomEvent.EngineFallback,
]);

/** Is this a record Activity shows rather than the Studio conversation? */
export function isStudioRecord(event: EventEnvelope): boolean {
  return (
    event.data.type === EventKind.WorkspaceRestored ||
    (event.data.type === EventKind.Custom && STUDIO_RECORD_EVENTS.has(event.data.event_type))
  );
}

/**
 * Whether an event can change what {@link studioActivity} returns. The host keeps only these
 * between reads, so Activity never re-reads the whole log.
 */
export function feedsActivity(event: EventEnvelope): boolean {
  const data = event.data;
  if (data.type === EventKind.WorkspaceRestored || data.type === EventKind.SnapshotCreated) return true;
  if (data.type !== EventKind.Custom) return false;
  return STUDIO_RECORD_EVENTS.has(data.event_type) || Boolean(words(record(data.payload).runId));
}

/** What a run left the user with, from how it closed and whether its build landed. */
export function runOutcomeKind(execution: string, landed: boolean | null): RunOutcomeKind {
  if (execution === ExecutionStatus.Running) return "running";
  if (execution === ExecutionStatus.Failed) return "failed";
  if (execution === ExecutionStatus.Cancelled || execution === ExecutionStatus.Paused) return "stopped";
  if (execution === ExecutionStatus.Completed) return landed === true ? "delivered" : "none";
  return "unknown";
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const words = (value: unknown): string => (typeof value === "string" ? value : "");
/** The strings of a payload field that should hold a list of them. */
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** A restore the harness made because a round's build lost is the round's business, not Activity's. */
const LOST_ROUND_RESTORE = /did not win/;

/** The records that move a run's place in Activity to their own time. */
const RUN_MILESTONES: ReadonlySet<string> = new Set<string>([
  CustomEvent.RunStarted,
  CustomEvent.RunFinished,
  CustomEvent.RunSettled,
  CustomEvent.AutopilotPaused,
  CustomEvent.AutopilotResumed,
  CustomEvent.RunAutoResumed,
  CustomEvent.BuildLanded,
]);

/** The executions that stopped short of a result, so the run needs the user to look. */
const STOPPED_SHORT: ReadonlySet<string> = new Set<string>([
  ExecutionStatus.Failed,
  ExecutionStatus.Cancelled,
  ExecutionStatus.Paused,
  UNKNOWN_EXECUTION,
]);

/** A run as Activity gathers it: its records, goal, and the milestone that dates it. */
interface ActivityRun {
  project: string;
  runId: string;
  goal: string;
  event: EventEnvelope;
  events: EventEnvelope[];
}

/** One Studio record, with what a reader needs to word it. */
interface StudioRecord {
  event: EventEnvelope;
  event_type: string;
  payload: Record<string, unknown>;
  /** Self-changes that were undone since, by snapshot id, with why (`undoneSelfChanges`). */
  restored: Map<string, string>;
}

/** The Activity item a Studio record makes, or null for a record that names nothing it can show. */
type ItemReader = (record: StudioRecord) => StudioActivityItem | null;

function restoredItem(event: EventEnvelope, reason: string, snapshotId: string): StudioActivityItem {
  return {
    id: event.id,
    at: event.created_at,
    kind: "recovery",
    title: "Restored Studio’s files to a saved version",
    attention: true,
    detail: reason,
    snapshotId,
  };
}

function improvementStatus(undone: boolean, byUser: boolean): string {
  if (byUser) return "Undone";
  return undone ? "Rolled back" : "Applied";
}

/** A change's plain lines: its own summary, or for a code change the reason it gave. */
function improvementSummary(payload: Record<string, unknown>, code: boolean): string[] {
  const summary = Array.isArray(payload.summary)
    ? payload.summary.filter((line): line is string => typeof line === "string" && Boolean(line.trim()))
    : [];
  if (summary.length) return summary;
  return code && words(payload.reason) ? [words(payload.reason)] : [];
}

const improvementItem: ItemReader = ({ event, event_type, payload: p, restored }) => {
  const snapshotId = words(p.snapshot_id);
  const undone = restored.has(snapshotId);
  const byUser = restored.get(snapshotId) === UNDONE_BY_USER;
  const code = event_type === CustomEvent.ImprovementApplied;
  const summary = improvementSummary(p, code);
  return {
    id: event.id,
    at: event.created_at,
    kind: "improvement",
    title: code
      ? "Improved its own code"
      : changeTitle({ title: words(p.title), skill: words(p.skill), file: words(p.file) }),
    status: improvementStatus(undone, byUser),
    undone,
    detail:
      words(p.rationale) ||
      words(p.reason) ||
      "Updated Studio instructions. Future game results have not been verified.",
    ...(summary.length ? { summary } : {}),
    ...(p.approvedBy === "auto" || p.approvedBy === "human" ? { approvedBy: p.approvedBy } : {}),
    ...(snapshotId ? { snapshotId } : {}),
  };
};

/** How Activity names a change the agent made to its own files, by the record that logged it. */
function selfChangeTitle(event_type: string, p: Record<string, unknown>): string {
  if (event_type === CustomEvent.SkillEdited) return `Harness rewrote ${skillWords(words(p.slug))}`;
  if (event_type === CustomEvent.ToolInstalled) return `Harness added a tool for itself: ${words(p.file)}`;
  return `Harness edited its own file ${words(p.file)}`;
}

/**
 * A change the agent made to its own instructions, skills or tools. Nobody approved it, so it
 * asks for a look until it is undone: text in a game file can steer what the agent rewrites.
 */
const selfChangeItem: ItemReader = ({ event, event_type, payload: p, restored }) => {
  if (!agentChangedFile(event_type, p)) return null;
  const snapshotId = words(p.snapshot_id);
  const undone = restored.has(snapshotId);
  const summary = improvementSummary(p, false);
  return {
    id: event.id,
    at: event.created_at,
    kind: "improvement",
    title: words(p.title) || selfChangeTitle(event_type, p),
    status: improvementStatus(undone, restored.get(snapshotId) === UNDONE_BY_USER),
    undone,
    detail: words(p.reason) || "Harness changed one of its own files.",
    ...(summary.length ? { summary } : {}),
    ...(undone ? {} : { attention: true }),
    ...(snapshotId ? { snapshotId } : {}),
  };
};

const learningPassItem: ItemReader = ({ event, payload: p }) => {
  const count = (key: string) => (typeof p[key] === "number" ? p[key] : 0);
  return {
    id: event.id,
    at: event.created_at,
    kind: "learning",
    title: "Checked for improvements",
    status: count("staged") ? `${count("staged")} awaiting review` : undefined,
    detail:
      words(p.note) ||
      `${count("tasks")} past tasks reviewed · ${count("accepted")} changes applied · ${count("staged")} proposed · ${count("rejected")} rejected`,
  };
};

type MovedCode = { from: string; to: string; names: string[] };
const isMovedCode = (m: unknown): m is MovedCode => {
  const row = record(m);
  return Boolean(m) && typeof row.from === "string" && typeof row.to === "string" && Array.isArray(row.names);
};

const seedUpgradeItem: ItemReader = ({ event, payload: p }) => {
  const added = strings(p.added);
  const updated = strings(p.updated);
  const kept = strings(p.kept);
  const retired = strings(p.retired);
  const count = added.length + updated.length;
  const did: string[] = [];
  if (count > 0) did.push(`refreshed ${plural(count, "Studio file")}`);
  if (retired.length > 0) did.push(`archived ${plural(retired.length, "retired file")}`);
  // A kept file whose code the update moved: its edits to that code no longer reach every caller.
  const moved = (Array.isArray(p.moved) ? p.moved : []).filter(isMovedCode);
  return {
    id: event.id,
    at: event.created_at,
    kind: "upkeep",
    title: `App update ${did.length ? did.join(" and ") : "kept the current Studio files"}`,
    detail: [
      added.length && `Added: ${added.join(", ")}.`,
      updated.length && `Updated: ${updated.join(", ")}.`,
      kept.length && `Preserved your edits: ${kept.join(", ")}.`,
      retired.length && `Backed up and retired: ${retired.join(", ")}.`,
      ...moved.map((m) => `Moved out of your ${m.from}: ${m.names.join(", ")}, now used from ${m.to}.`),
    ]
      .filter(Boolean)
      .join(" "),
    ...(moved.length > 0 ? { attention: true } : {}),
  };
};

const layoutMigrationItem: ItemReader = ({ event, payload: p }) => {
  if (p.ok === false)
    return {
      id: event.id,
      at: event.created_at,
      kind: "upkeep",
      title: "App update could not move Studio’s code to TypeScript yet",
      attention: true,
      detail:
        `Studio keeps running its current files and will try again after the next update. ${words(p.error)}`.trim(),
    };
  const renamed = strings(p.renamed);
  const stranded = strings(p.stranded);
  const replaced = strings(p.replaced);
  const typeErrors = words(p.typeErrors);
  const needsFixing = Boolean(typeErrors) || stranded.length > 0 || replaced.length > 0;
  return {
    id: event.id,
    at: event.created_at,
    kind: "upkeep",
    title: "App update moved Studio’s code to TypeScript",
    detail:
      [
        renamed.length && `Kept your edits as TypeScript: ${renamed.join(", ")}.`,
        stranded.length && `Backed up, unused beside your TypeScript files: ${stranded.join(", ")}.`,
        replaced.length &&
          `Replaced with the shipped version, your edit backed up (it could not run as TypeScript): ${replaced.join(", ")}.`,
        typeErrors && `Type errors to fix in your edited files:\n${typeErrors}`,
      ]
        .filter(Boolean)
        .join(" ") || "Every Studio file was the shipped version.",
    ...(needsFixing ? { attention: true } : {}),
  };
};

const downgradeItem: ItemReader = ({ event, payload: p }) => {
  const stranded = strings(p.stranded);
  return {
    id: event.id,
    at: event.created_at,
    kind: "upkeep",
    title: "An older version of the app ran Studio since the last update",
    attention: true,
    detail: [
      p.migrated === true ? "Studio’s code is TypeScript again." : "Studio keeps running its current files.",
      stranded.length &&
        `Edits made meanwhile to these JavaScript files were backed up and no longer run: ${stranded.join(", ")}.`,
    ]
      .filter(Boolean)
      .join(" "),
  };
};

function recoveryTitle(event_type: string, ok: unknown): string {
  if (event_type === CustomEvent.EngineFallback) return "Changed provider";
  return ok === false ? "Studio restart failed" : "Studio restarted";
}

const recoveryItem: ItemReader = ({ event, event_type, payload: p }) => ({
  id: event.id,
  at: event.created_at,
  kind: "recovery",
  title: recoveryTitle(event_type, p.ok),
  detail: words(p.reason) || words(p.detail),
  attention: p.ok === false || event_type === CustomEvent.HarnessReseeded,
});

/** Why the studio resumed a build on its own, as Activity says it (`run_auto_resumed`). */
const AUTO_RESUMED = {
  title: "Resumed a build automatically",
  [AutoResumeCause.LimitReset]: "The limit reset.",
  [AutoResumeCause.LoopRestart]: "Studio’s loop restarted.",
  [AutoResumeCause.ProviderOutage]: "The model provider was down; the wait after it is over.",
} as const;

const autoResumeItem: ItemReader = ({ event, payload: p }) => {
  const cause = Object.values(AutoResumeCause).find((value) => value === p.cause);
  return {
    id: event.id,
    at: event.created_at,
    kind: "recovery",
    title: AUTO_RESUMED.title,
    detail: cause ? AUTO_RESUMED[cause] : "",
    ...(words(p.project) ? { project: words(p.project) } : {}),
    ...(words(p.runId) ? { runId: words(p.runId) } : {}),
  };
};

/** The Activity item each Studio record makes. */
const ITEM_READERS: ReadonlyMap<string, ItemReader> = new Map([
  [CustomEvent.SkilloptAccepted, improvementItem],
  [CustomEvent.ImprovementApplied, improvementItem],
  [CustomEvent.SelfEdit, selfChangeItem],
  [CustomEvent.SkillEdited, selfChangeItem],
  [CustomEvent.ToolInstalled, selfChangeItem],
  [CustomEvent.SkilloptPass, learningPassItem],
  [CustomEvent.SeedUpgraded, seedUpgradeItem],
  [CustomEvent.HarnessLayoutMigrated, layoutMigrationItem],
  [CustomEvent.HarnessDowngraded, downgradeItem],
  [CustomEvent.RebuildAndRestartStudio, recoveryItem],
  [CustomEvent.EngineFallback, recoveryItem],
  [CustomEvent.HarnessReseeded, recoveryItem],
  [CustomEvent.RunAutoResumed, autoResumeItem],
]);

/** Adds a run's record to the run it belongs to, dating the run by its latest milestone. */
function gatherRun(runs: Map<string, ActivityRun>, { event, event_type, payload }: StudioRecord, runId: string): void {
  let run = runs.get(runId);
  if (!run) {
    run = { project: "", runId, goal: "", event, events: [] };
    runs.set(runId, run);
  }
  run.events.push(event);
  run.project ||= words(payload.project);
  if (event_type === CustomEvent.RunStarted) run.goal = words(payload.goal);
  if (RUN_MILESTONES.has(event_type)) run.event = event;
}

const isCustomOf = (event: EventEnvelope, types: readonly string[]): boolean =>
  event.data.type === EventKind.Custom && types.includes(event.data.event_type);

/** Does the run's checked outcome need the user to look? */
function runNeedsAttention(summary: RunSummary): boolean {
  const landedNothing = summary.execution === ExecutionStatus.Completed && summary.landed !== true;
  const currentCheckFailed = summary.evidence.some((e) => e.head === summary.head && e.status === "failed");
  return STOPPED_SHORT.has(summary.execution) || landedNothing || currentCheckFailed;
}

/** The run's Activity item, or null for a run without a project or without a start or finish. */
function runItem(run: ActivityRun, suppliedSummary?: RunSummary): StudioActivityItem | null {
  const startedOrFinished = run.events.some((e) => isCustomOf(e, [CustomEvent.RunStarted, CustomEvent.RunFinished]));
  if (!run.project || !startedOrFinished) return null;
  const summary = suppliedSummary ?? summarizeRun(run.events, run.project, run.runId);
  const finished = run.events.findLast((e) => isCustomOf(e, [CustomEvent.RunFinished]));
  const report = finished?.data.type === EventKind.Custom ? words(record(finished.data.payload).summary) : "";
  return {
    id: `run:${run.runId}`,
    at: run.event.created_at,
    kind: "run",
    project: run.project,
    runId: run.runId,
    title: run.goal || "Game run",
    runOutcome: summaryOutcome(summary),
    outcome: runOutcomeKind(summary.execution, summary.landed),
    ...(report ? { report } : {}),
    detail:
      summary.reason || `${summary.counts.accepted} attempts accepted · ${summary.counts.integrations} integrations`,
    attention: runNeedsAttention(summary),
  };
}

/** Compact facts from the complete log, independent of the selected game and notification tail. */
export function studioActivity(events: EventEnvelope[]): StudioActivityItem[] {
  const items: StudioActivityItem[] = [];
  const runs = new Map<string, ActivityRun>();
  const restored = undoneSelfChanges(events);
  for (const event of events) {
    const data = event.data;
    if (data.type === EventKind.WorkspaceRestored && !LOST_ROUND_RESTORE.test(data.reason)) {
      items.push(restoredItem(event, data.reason, data.snapshot_id));
      continue;
    }
    if (data.type !== EventKind.Custom) continue;
    const studioRecord: StudioRecord = { event, event_type: data.event_type, payload: record(data.payload), restored };
    const runId = words(studioRecord.payload.runId);
    if (runId) gatherRun(runs, studioRecord, runId);
    const item = ITEM_READERS.get(data.event_type)?.(studioRecord);
    if (item) items.push(item);
  }
  for (const run of runs.values()) {
    const item = runItem(run);
    if (item) items.push(item);
  }
  return items.sort((a, b) => compareIds(b.at, a.at) || compareIds(b.id, a.id));
}

interface IndexedActivityRun {
  run: ActivityRun;
  summary: RunSummaryAccumulator;
  last: EventEnvelope | null;
}

/** Activity rows plus the small ownership and self-change record indexes its other consumers need. */
export class ActivityIndex {
  readonly #runs = new Map<string, IndexedActivityRun>();
  readonly #records: EventEnvelope[] = [];
  #lastId: string | null = null;

  /** Append an id-ordered batch; false asks the owner to rebuild after an older external import. */
  append(events: readonly EventEnvelope[]): boolean {
    if (!this.#canAppend(events)) return false;
    const batches = new Map<string, EventEnvelope[]>();
    for (const event of events) {
      this.#lastId = event.id;
      this.#retain(event);
      if (event.data.type !== EventKind.Custom) continue;
      const payload = record(event.data.payload);
      const runId = words(payload.runId);
      if (!runId) continue;
      this.#gather(event, payload, runId);
      const batch = batches.get(runId) ?? [];
      batch.push(event);
      batches.set(runId, batch);
    }
    for (const [runId, batch] of batches) {
      const indexed = this.#runs.get(runId);
      if (!indexed) continue;
      for (const event of batch.sort(activityOrder)) indexed.summary.append(event);
      indexed.last = batch.at(-1) ?? indexed.last;
    }
    return true;
  }

  #canAppend(events: readonly EventEnvelope[]): boolean {
    let previousId = this.#lastId;
    for (const event of events) {
      if (previousId !== null && compareIds(event.id, previousId) <= 0) return false;
      previousId = event.id;
      if (event.data.type !== EventKind.Custom) continue;
      const previous = this.#runs.get(words(record(event.data.payload).runId))?.last;
      if (previous && activityOrder(event, previous) < 0) return false;
    }
    return true;
  }

  #retain(event: EventEnvelope): void {
    const data = event.data;
    if (data.type === EventKind.SnapshotCreated || data.type === EventKind.WorkspaceRestored) {
      this.#records.push(event);
      return;
    }
    if (data.type !== EventKind.Custom) return;
    // A record with an Activity item of its own is kept even when it stays in its conversation's
    // transcript (it is not a Studio record): an automatic resume, say.
    const retained =
      STUDIO_RECORD_EVENTS.has(data.event_type) ||
      ITEM_READERS.has(data.event_type) ||
      data.event_type === CustomEvent.RunStarted ||
      data.event_type === CustomEvent.RunRegistered;
    if (retained) this.#records.push(event);
  }

  #gather(event: EventEnvelope, payload: Record<string, unknown>, runId: string): void {
    if (event.data.type !== EventKind.Custom) return;
    let indexed = this.#runs.get(runId);
    if (!indexed) {
      indexed = {
        run: { project: "", runId, goal: "", event, events: [] },
        summary: new RunSummaryAccumulator("", runId),
        last: null,
      };
      this.#runs.set(runId, indexed);
    }
    const { run } = indexed;
    run.project ||= words(payload.project);
    indexed.summary.nameProject(run.project);
    const type = event.data.event_type;
    if (type === CustomEvent.RunStarted) run.goal = words(payload.goal);
    if (RUN_MILESTONES.has(type)) run.event = event;
    if (type === CustomEvent.RunStarted || type === CustomEvent.RunFinished) {
      run.events = run.events.filter(
        (previous) => previous.data.type !== EventKind.Custom || previous.data.event_type !== type,
      );
      run.events.push(event);
    }
  }

  /** Start, snapshot and self-change events, in log order, for ownership and undo consumers. */
  records(): EventEnvelope[] {
    return [...this.#records];
  }

  /** All Activity rows; only the small derived run state is folded for each result. */
  items(): StudioActivityItem[] {
    const records = this.#records.filter((event) => {
      if (event.data.type !== EventKind.Custom) return true;
      return event.data.event_type !== CustomEvent.RunStarted && event.data.event_type !== CustomEvent.RunRegistered;
    });
    const items = studioActivity(records).filter((item) => item.kind !== "run");
    for (const { run, summary } of this.#runs.values()) {
      const item = runItem(run, summary.summary());
      if (item) items.push(item);
    }
    return items.sort((a, b) => compareIds(b.at, a.at) || compareIds(b.id, a.id));
  }
}

function activityOrder(a: EventEnvelope, b: EventEnvelope): number {
  return compareIds(a.created_at, b.created_at) || compareIds(a.id, b.id);
}
