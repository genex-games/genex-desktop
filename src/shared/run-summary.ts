/** Reporting projection only. No decisions here may control execution or acceptance. */
import { compareIds } from "./compare-ids.ts";
import { CustomEvent } from "./custom-events.ts";
import { EventKind, type EventEnvelope } from "./event-log.ts";
import {
  ExecutionStatus,
  executionActivity,
  executionStep,
  isExecutionEvent,
  preferredChallenger,
  RoundOutcome,
  roundOutcome,
  type RunExecution,
  RunState,
  type RunWorked,
} from "./run-state.ts";
type Row = Record<string, any>;
export interface RunAttempt {
  id: string;
  worker: string;
  iteration: number | null;
  state: string;
  evaluation: "accepted" | "rejected" | null;
  reason: string | null;
}
export interface RunTask {
  id: string;
  title: string;
  workers: string[];
  state: string;
  integrations: number;
  attempts: RunAttempt[];
  reason: string | null;
}
/**
 * Who established an interaction result (`run_interaction_evidence.source`). Wire values: the
 * seed writes them (`harness-seed/loop/run-events.ts` `InteractionSource`, held equal by
 * `seed-contracts.test.ts`) and the outcome panel names them.
 */
export const InteractionSource = {
  /** A fresh playtester answered a yes/no question by playing. */
  IndependentPlaytester: "independent-playtester",
  /** A judge played the build blind to settle what screenshots could not. */
  HandsOnJudge: "hands-on-judge",
  /** A kept route was replayed on this build without a model. */
  RouteReplay: "route-replay",
} as const;
export type InteractionSource = (typeof InteractionSource)[keyof typeof InteractionSource];

/**
 * Whether an interaction result rests on the studio's own check of the game's state (a goal it
 * verified after a move) or only on what the model said it saw.
 */
export const InteractionObjective = {
  StudioVerified: "studio-verified",
  ModelSaid: "model-said",
} as const;
export type InteractionObjective = (typeof InteractionObjective)[keyof typeof InteractionObjective];

export interface RunEvidence {
  id: string;
  head: string | null;
  category: "health" | "structural" | "visual" | "interaction" | "comparison";
  label: string;
  status: "passed" | "failed" | "unknown" | "incomplete";
  note: string | null;
  source: string;
  capture?: string;
  /** For an interaction: verified by the studio against the game's state, or only the model's word. */
  objective?: InteractionObjective;
  /** For an interaction: the session's trace (`trace.jsonl`), when it played through the computer tool. */
  trace?: string;
}
export interface RunSummary {
  /** Revision of the memoized persisted summary; preview identity is separate. */
  revision?: number;
  startedAt?: string;
  endedAt?: string;
  /** How long it has worked since `startedAt`, pauses aside (run-state.ts); absent when its start is unknown. */
  worked?: RunWorked;
  runId: string;
  project: string;
  completeHistory: boolean;
  execution: string;
  reason: string | null;
  landed: boolean | null;
  deliveredHead: string | null;
  deliveredSourceHead: string | null;
  head: string | null;
  base: string | null;
  tasks: RunTask[];
  evidence: RunEvidence[];
  counts: {
    integrations: number;
    accepted: number;
    rejected: number;
    stopped: number;
    failed: number;
    superseded: number;
    running: number;
    queued: number;
    completedUnevaluated: number;
  };
  learning: string | null;
  graphEvents?: EventEnvelope[];
  /** Index in the run's graph events where `graphEvents` starts; absent or 0 means all of them. */
  graphEventsFrom?: number;
  runDirectory?: string;
  /** Saved captures, with current matched to the displayed/delivered revision. */
  captures?: { base?: string; current?: string };
  preview?: {
    project: string | null;
    head: string | null;
    state: string;
    error: string | null;
  };
}

/** `RunSummary.execution` for a run whose history has no lifecycle record yet. */
export const UNKNOWN_EXECUTION = "unknown";
/** The worker a plain (not directed) build's rounds belong to. */
const BUILD_WORKER = "build";
/** The worker a merge that names none is counted against. */
const UNASSIGNED_WORKER = "unassigned";
/** A worker's own attempt when it runs once (`mode: "single"`) instead of in rounds. */
const SINGLE_MODE = "single";
/** How a worker's or an attempt's state reads before any record says otherwise. */
const UNKNOWN_STATE = "unknown";

/** The attempt states that count toward a summary total, and the total each one counts in. */
const STATE_COUNT: ReadonlyMap<string, keyof RunSummary["counts"]> = new Map([
  ["queued", "queued"],
  ["running", "running"],
  ["failed", "failed"],
  ["stopped", "stopped"],
  ["superseded", "superseded"],
  ["done", "completedUnevaluated"],
]);

/** The execution states a summary shows as they are; any other close is shown as finished. */
const OPEN_OR_FAILED_STATES: ReadonlySet<string> = new Set([
  UNKNOWN_EXECUTION,
  ExecutionStatus.Running,
  ExecutionStatus.Paused,
  ExecutionStatus.Failed,
  ExecutionStatus.Cancelled,
]);

const INTERACTION_STATUSES: ReadonlySet<string> = new Set(["passed", "failed", "incomplete"]);

const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const string = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const failureMessage = (value: unknown): string | null => {
  const text = string(value);
  if (!text) return null;
  try {
    const body = record(JSON.parse(text));
    return string(record(body.error).message) ?? string(body.message) ?? text;
  } catch {
    return text;
  }
};

/** A recorded yes/no answer as an evidence status: no answer is unknown. */
function answerStatus(answer: unknown): RunEvidence["status"] {
  if (answer === true) return "passed";
  if (answer === false) return "failed";
  return "unknown";
}

function emptySummary(project: string, runId: string): RunSummary {
  return {
    runId,
    project,
    completeHistory: false,
    execution: UNKNOWN_EXECUTION,
    reason: null,
    landed: null,
    deliveredHead: null,
    deliveredSourceHead: null,
    head: null,
    base: null,
    tasks: [],
    evidence: [],
    counts: {
      integrations: 0,
      accepted: 0,
      rejected: 0,
      stopped: 0,
      failed: 0,
      superseded: 0,
      running: 0,
      queued: 0,
      completedUnevaluated: 0,
    },
    learning: null,
  };
}

/** What `summarizeRun` gathers while it reads the log, before it groups workers into tasks. */
interface Summarizing {
  result: RunSummary;
  workers: Map<string, Row>;
  attempts: Map<string, RunAttempt>;
  merges: { worker: string; head: string }[];
  operations: Set<string>;
  evidence: Map<string, RunEvidence>;
  execution: RunExecution | null;
}

/** One of the run's own custom records, as the readers see it. */
interface RunRecord {
  event: EventEnvelope;
  event_type: string;
  payload: Row;
  /** The worker (or facet) the record is about, when it names one. */
  workerId: string | null;
}

type RecordReader = (run: Summarizing, record: RunRecord) => void;

function workerRow(run: Summarizing, id: string): Row {
  const existing = run.workers.get(id);
  if (existing) return existing;
  const row: Row = { id, title: id, state: UNKNOWN_STATE };
  run.workers.set(id, row);
  return row;
}

function attemptRow(run: Summarizing, workerId: string, iteration: number | null): RunAttempt {
  const key = `${workerId}:${iteration ?? SINGLE_MODE}`;
  const existing = run.attempts.get(key);
  if (existing) return existing;
  const attempt: RunAttempt = {
    id: key,
    worker: workerId,
    iteration,
    state: "running",
    evaluation: null,
    reason: null,
  };
  run.attempts.set(key, attempt);
  return attempt;
}

function addEvidence(run: Summarizing, item: RunEvidence): void {
  const key = `${item.head}:${item.category}:${item.label}`;
  const previous = run.evidence.get(key);
  const inconclusive = item.status === "unknown" || item.status === "incomplete";
  // An unanswered recheck cannot resolve an observed failure on the same revision/scope.
  if (previous?.status !== "failed" || !inconclusive) {
    run.evidence.set(key, item);
    return;
  }
  run.evidence.set(key, {
    ...previous,
    note: [previous.note, `Later recheck ${item.status}: ${item.note ?? "no conclusive answer"}`]
      .filter(Boolean)
      .join("\n"),
  });
}

/** Has the run closed (paused or finished) as it stands? */
const hasClosed = (execution: RunExecution | null): boolean =>
  execution !== null && execution.state !== RunState.Running;

// Running, paused or finished, and how it closed: the one execution rule (run-state.ts).
function readExecution(run: Summarizing, { event, event_type, payload }: RunRecord): void {
  const closed = hasClosed(run.execution);
  run.execution = executionStep(run.execution, run.result.runId, {
    event_type,
    payload,
    at: event.created_at,
  });
  if (!run.execution) return;
  if (closed && run.execution.state === RunState.Running) forgetClose(run.result);
  run.result.execution = run.execution.status;
  if (run.execution.endedAt) run.result.endedAt = run.execution.endedAt;
  else delete run.result.endedAt;
  if (run.execution.openedAt) run.result.worked = run.execution.worked;
  else delete run.result.worked;
}

/** One of the run's own records, in order: the run's lifecycle, or a sign that it is working. */
function readRunRecord(run: Summarizing, own: RunRecord): void {
  if (isExecutionEvent(own)) readExecution(run, own);
  else run.execution = executionActivity(run.execution, own.event.created_at);
}

/** What a close said about the build, cleared when the run goes on: the next close says it anew. */
function forgetClose(result: RunSummary): void {
  result.landed = null;
  result.reason = null;
  result.deliveredHead = null;
  result.deliveredSourceHead = null;
}

// Its working time counts from its first start, or from the start that reopened it once finished.
const readRunStart: RecordReader = ({ result, execution }, { event, payload }) => {
  result.startedAt = execution?.openedAt ?? result.startedAt ?? event.created_at;
  result.completeHistory ||= payload.resumed !== true;
};

const readAutopilotBase: RecordReader = ({ result }, { payload }) => {
  result.base = string(payload.commit);
  if (payload.ok === true) result.head = string(payload.commit) ?? result.head;
};

const readDirectorWorker: RecordReader = (run, { payload, workerId }) => {
  if (!workerId) return;
  const w = workerRow(run, workerId);
  Object.assign(w, {
    title: payload.title ?? w.title,
    state: payload.state ?? w.state,
    mode: payload.mode ?? w.mode,
    replaces: payload.replaces ?? w.replaces,
    reason: payload.stoppedBecause ?? w.reason,
  });
  if (w.mode === SINGLE_MODE)
    Object.assign(attemptRow(run, workerId, null), {
      state: w.state,
      reason: string(w.reason),
    });
};

/** A facet's (or the plain build's) round: started, or finished with its outcome. */
const readRound: RecordReader = (run, { event_type, payload, workerId }) => {
  const hasWorker = workerId !== null || event_type === CustomEvent.RunIteration;
  if (!hasWorker || typeof payload.iteration !== "number") return;
  const w = workerRow(run, workerId ?? BUILD_WORKER);
  w.title = payload.facetTitle ?? w.title;
  if (event_type === CustomEvent.FacetBuildStarted) w.state = "running";
  const attempt = attemptRow(run, workerId ?? BUILD_WORKER, payload.iteration);
  if (event_type === CustomEvent.FacetBuildStarted) return;
  // A judged round is accepted or rejected; a stopped one is stopped; one that recorded no
  // winner still finished, and is counted as completed without evaluation.
  const outcome = roundOutcome(payload);
  const judged = outcome === RoundOutcome.Accepted || outcome === RoundOutcome.Rejected;
  attempt.evaluation = judged ? outcome : null;
  attempt.state = outcome === RoundOutcome.Stopped ? "stopped" : "done";
  attempt.reason = string(payload.reason);
};

/** Does this merge move the integrated head somewhere new (and not back onto the base)? */
function movesHead(run: Summarizing, payload: Row, operation: string): boolean {
  const { result } = run;
  const startsFromBase = result.head === null && payload.head === result.base;
  return (
    !run.operations.has(operation) &&
    payload.head !== result.head &&
    payload.head !== payload.previousHead &&
    !startsFromBase
  );
}

const readIntegrationMerge: RecordReader = (run, { event, payload, workerId }) => {
  if (payload.conflict !== false || !string(payload.head)) return;
  const operation = string(payload.operationId) ?? event.id;
  if (!movesHead(run, payload, operation)) return;
  run.operations.add(operation);
  run.merges.push({ worker: workerId ?? UNASSIGNED_WORKER, head: payload.head });
  run.result.head = payload.head;
};

const readDirectorProgress: RecordReader = ({ result }, { payload }) => {
  result.head = string(payload.head) ?? result.head;
};

const readIntegrationHealth: RecordReader = (run, { event, event_type, payload }) => {
  addEvidence(run, {
    id: event.id,
    head: string(payload.head),
    category: "health",
    label: "Build health",
    status: answerStatus(payload.ok),
    note: Array.isArray(payload.problems) ? payload.problems.join("; ") : null,
    source: event_type,
  });
};

/** A lead's verdict: its measured checks, what it saw, and its side-by-side pick. */
const readDirectorVerdict: RecordReader = (run, { event, event_type, payload }) => {
  const head = string(record(payload.build).head);
  const measured = record(payload.measured);
  const seen = record(payload.seen);
  for (const check of [
    ...(Array.isArray(measured.planned) ? measured.planned : []),
    ...(Array.isArray(measured.grown) ? measured.grown : []),
  ]) {
    addEvidence(run, {
      id: event.id,
      head,
      category: "structural",
      label: String(check.id),
      status: answerStatus(check.pass),
      note: string(check.reason),
      source: event_type,
    });
  }
  if (string(seen.question))
    addEvidence(run, {
      id: event.id,
      head,
      category: "visual",
      label: seen.question,
      status: answerStatus(seen.answer),
      note: string(seen.note),
      source: event_type,
    });
  if (seen.pick != null)
    addEvidence(run, {
      id: event.id,
      head,
      category: "comparison",
      label: "Comparative judgement",
      status: preferredChallenger(seen.pick) ? "passed" : "failed",
      note: string(payload.because),
      source: event_type,
    });
};

const readVisualEvidence: RecordReader = (run, { event, event_type, payload }) => {
  addEvidence(run, {
    id: event.id,
    head: string(payload.head),
    category: "visual",
    label: string(payload.question) ?? "Visual question",
    status: answerStatus(payload.answer),
    note: string(payload.note),
    source: event_type,
  });
};

/** The objective and trace an interaction record carries, read field by field: a record may hold anything. */
function interactionProof(payload: Record<string, unknown>): Pick<RunEvidence, "objective" | "trace"> {
  const objective = Object.values(InteractionObjective).find((value) => value === payload.objective);
  const trace = string(payload.trace);
  return { ...(objective ? { objective } : {}), ...(trace ? { trace } : {}) };
}

const readInteractionEvidence: RecordReader = (run, { event, event_type, payload }) => {
  addEvidence(run, {
    id: event.id,
    head: string(payload.head),
    category: "interaction",
    label: string(payload.label) ?? "Independent playtest",
    status: INTERACTION_STATUSES.has(payload.status) ? payload.status : "unknown",
    note: string(payload.note),
    source: string(payload.source) ?? event_type,
    ...interactionProof(payload),
  });
};

const readWorkerStop: RecordReader = (run, { payload, workerId }) => {
  if (!workerId) return;
  const w = workerRow(run, workerId);
  w.reason = string(payload.reason);
  w.stopSource = string(payload.source);
};

const readRunFinished: RecordReader = (run, { payload }) => {
  const { result } = run;
  for (const [workerId, value] of Object.entries(record(payload.workers))) {
    const row = record(value);
    const w = workerRow(run, workerId);
    w.state = string(row.state) ?? w.state;
    w.title = string(row.title) ?? w.title;
  }
  result.reason = failureMessage(record(payload.failure).message) ?? string(payload.stoppedBecause);
  result.landed = typeof payload.landed === "boolean" ? payload.landed : null;
  result.head = string(payload.integrationHead) ?? result.head;
  if (result.landed === true) {
    result.deliveredSourceHead = result.head;
    result.deliveredHead = string(payload.deliveredHead);
  }
  result.base = string(payload.baseCommit) ?? result.base;
};

const readRunLearning: RecordReader = ({ result }, { payload }) => {
  result.learning = string(payload.state);
};

/** What each record of a run adds to its summary, after its execution step. */
const READERS: ReadonlyMap<string, RecordReader> = new Map([
  [CustomEvent.RunStarted, readRunStart],
  [CustomEvent.RunRegistered, readRunStart],
  [CustomEvent.AutopilotBase, readAutopilotBase],
  [CustomEvent.DirectorWorker, readDirectorWorker],
  [CustomEvent.FacetBuildStarted, readRound],
  [CustomEvent.FacetIteration, readRound],
  [CustomEvent.RunIteration, readRound],
  [CustomEvent.IntegrationMerge, readIntegrationMerge],
  [CustomEvent.DirectorProgress, readDirectorProgress],
  [CustomEvent.IntegrationHealth, readIntegrationHealth],
  [CustomEvent.DirectorVerdict, readDirectorVerdict],
  [CustomEvent.RunVisualEvidence, readVisualEvidence],
  [CustomEvent.RunInteractionEvidence, readInteractionEvidence],
  [CustomEvent.WorkerStopRequested, readWorkerStop],
  [CustomEvent.RunFinished, readRunFinished],
  [CustomEvent.RunLearning, readRunLearning],
]);

/** The log's records once each, oldest first (ties by id). */
function chronological(events: EventEnvelope[]): EventEnvelope[] {
  const seen = new Set<string>();
  const sorted = [...events].sort((a, b) => compareIds(a.created_at, b.created_at) || compareIds(a.id, b.id));
  return sorted.filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
}

/** The record as this run's, or null when it is not a custom record of this run and project. */
function runRecord(event: EventEnvelope, project: string, runId: string): RunRecord | null {
  if (event.data.type !== EventKind.Custom) return null;
  const payload = record(event.data.payload);
  const otherProject = Boolean(payload.project) && payload.project !== project;
  if (payload.runId !== runId || otherProject) return null;
  const workerId = string(payload.workerId) ?? string(payload.facetId);
  return { event, event_type: event.data.event_type, payload, workerId };
}

/** The worker a task started from: follow `replaces` back to the first, stopping on a loop. */
function rootWorker(workers: Map<string, Row>, id: string): string {
  const seen = new Set<string>();
  let current = id;
  for (;;) {
    const replaces = workers.get(current)?.replaces;
    if (!replaces || !workers.has(replaces) || seen.has(current)) return current;
    seen.add(current);
    current = replaces;
  }
}

function groupTasks(workers: Map<string, Row>): Map<string, RunTask> {
  const tasks = new Map<string, RunTask>();
  for (const [id, w] of workers) {
    const key = rootWorker(workers, id);
    let task = tasks.get(key);
    if (!task) {
      task = {
        id: key,
        title: workers.get(key)?.title ?? key,
        workers: [],
        state: UNKNOWN_STATE,
        integrations: 0,
        attempts: [],
        reason: null,
      };
      tasks.set(key, task);
    }
    task.workers.push(id);
    task.state = w.state;
    task.reason = string(w.reason);
  }
  return tasks;
}

function countAttempt(counts: RunSummary["counts"], attempt: RunAttempt): void {
  if (attempt.evaluation) {
    counts[attempt.evaluation]++;
    return;
  }
  const total = STATE_COUNT.get(attempt.state);
  if (total) counts[total]++;
}

/** Groups the gathered workers into tasks, and counts their attempts and integrations. */
function finish(run: Summarizing): RunSummary {
  const { result, workers } = run;
  const tasks = groupTasks(workers);
  for (const attempt of run.attempts.values()) {
    tasks.get(rootWorker(workers, attempt.worker))?.attempts.push(attempt);
    countAttempt(result.counts, attempt);
  }
  for (const merge of run.merges) {
    const task = tasks.get(rootWorker(workers, merge.worker));
    if (task) task.integrations++;
  }
  result.counts.integrations = run.merges.length;
  result.tasks = [...tasks.values()];
  result.evidence = [...run.evidence.values()];
  return result;
}

/** Incremental reporting state: retains derived workers, attempts and evidence, never raw envelopes. */
export class RunSummaryAccumulator {
  readonly #run: Summarizing;

  constructor(project: string, runId: string) {
    this.#run = newSummaryState(project, runId);
  }

  /** A run may name its project after its first unscoped records. */
  nameProject(project: string): void {
    if (!this.#run.result.project) this.#run.result.project = project;
  }

  /** Add one record in chronological order; replay deduplication belongs to the caller. */
  append(event: EventEnvelope): void {
    const own = runRecord(event, this.#run.result.project, this.#run.result.runId);
    if (!own) return;
    readRunRecord(this.#run, own);
    READERS.get(own.event_type)?.(this.#run, own);
  }

  /** A detached result: repeated reads never accumulate the final counts into the reducer. */
  summary(): RunSummary {
    return finish(structuredClone(this.#run));
  }
}

/** One run's summary from the log: its execution, tasks, attempts, integrations and evidence. */
export function summarizeRun(events: EventEnvelope[], project: string, runId: string): RunSummary {
  const run = newSummaryState(project, runId);
  for (const event of chronological(events)) {
    const own = runRecord(event, project, runId);
    if (!own) continue;
    readRunRecord(run, own);
    READERS.get(own.event_type)?.(run, own);
  }
  return finish(run);
}

function newSummaryState(project: string, runId: string): Summarizing {
  return {
    result: emptySummary(project, runId),
    workers: new Map(),
    attempts: new Map(),
    merges: [],
    operations: new Set(),
    evidence: new Map(),
    execution: null,
  };
}
/**
 * What a run's outcome is, as data: where the run stands, what became of its build, and whether
 * the checks on that build need attention. `renderer/words.ts` (`outcomeTitle`) says it — once
 * per surface, from these three fields, instead of each surface rewriting one English sentence.
 */
export interface OutcomeView {
  state: "unknown" | "running" | "paused" | "failed" | "cancelled" | "finished";
  /**
   * `delivered`: the build is in the game. `superseded`: a build was delivered, but a newer
   * integrated build was not. `available`: an integrated build exists that was not delivered
   * (yet). `none`: nothing to show.
   */
  delivered: "delivered" | "superseded" | "available" | "none";
  /** The checks recorded on the current build: one failed, or they are incomplete. */
  verification: "attention" | "incomplete";
}

/** Is this execution one the outcome shows as it is (anything else closed as finished)? */
function isShownAsIs(execution: string): execution is OutcomeView["state"] {
  return OPEN_OR_FAILED_STATES.has(execution);
}

/** A run summary's outcome as data (see {@link OutcomeView}). */
export function summaryOutcome(s: RunSummary): OutcomeView {
  const current = s.evidence.filter((e) => e.head === s.head);
  const verification = current.some((e) => e.category !== "comparison" && e.status === "failed")
    ? "attention"
    : "incomplete";
  const integrated = Boolean(s.head && s.head !== s.base);
  const state: OutcomeView["state"] = isShownAsIs(s.execution) ? s.execution : "finished";
  if (state === UNKNOWN_EXECUTION) return { state, delivered: "none", verification };
  if (state !== "finished") return { state, delivered: integrated ? "available" : "none", verification };
  if (s.landed !== true) return { state, delivered: "none", verification };
  return { state, delivered: s.deliveredSourceHead !== s.head ? "superseded" : "delivered", verification };
}

/** The summary's counts as one line of text. */
export function summaryCounts(s: RunSummary): string {
  const c = s.counts;
  return (
    `${c.integrations} recorded integrations · ${c.accepted + c.rejected} evaluated attempts (${c.accepted} accepted, ${c.rejected} rejected) · ${c.stopped} stopped · ${c.failed} failed · ${c.superseded} superseded` +
    (s.execution === ExecutionStatus.Running ? ` · ${c.running} running · ${c.queued} queued` : "") +
    (c.completedUnevaluated ? ` · ${c.completedUnevaluated} completed without evaluation` : "")
  );
}
