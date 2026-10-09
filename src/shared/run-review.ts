/**
 * Rebuild a game's last unattended run from the event log.
 *
 * Review reads one run, never the merged log's global last run or last iterations, so two games
 * built close together never mash into one page. The log already names `project` and (now) `runId` on
 * every run event; this is the reconstruction the filmstrip reads.
 *
 * Lives in shared because both processes must agree on it: main replays a game's threads
 * uncapped for the morning-after review, the renderer computes the same shape from whatever
 * slice of the log it holds. Events in, review out — no Electron on either side.
 */
import { CustomEvent } from "./custom-events.ts";
import { EventKind, type EventEnvelope } from "./event-log.ts";
import { RoundOutcome, roundOutcome, roundWinner, type RoundWinner } from "./run-state.ts";

export interface RunShot {
  camera: string;
  path: string;
  bytes?: number;
}

export interface RunIterationView {
  iteration: number;
  iterationId: string;
  runId: string;
  project: string;
  /** The harness's own winner field, as recorded; null when the round recorded none. */
  winner: RoundWinner | null;
  /** How the round ended (`run-state.ts`): only an accepted round's build is kept. */
  outcome: RoundOutcome;
  biggest_gap: string;
  reason: string;
  /** Kept build after the verdict (incumbent, or the new one if the challenger won). */
  snapshot: string | null;
  /** The challenger's tree, snapshotted before a possible rewind. */
  attemptSnapshot: string | null;
  shots: RunShot[];
  incumbentShots: RunShot[];
}

export interface LoopRunReview {
  project: string | null;
  started: Record<string, unknown> | null;
  finished: Record<string, unknown> | null;
  /** Newest first. */
  iterations: RunIterationView[];
}

interface RunBucket {
  project: string;
  runId: string;
  started: Record<string, unknown> | null;
  finished: Record<string, unknown> | null;
  iterations: RunIterationView[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asShots(value: unknown): RunShot[] {
  if (!Array.isArray(value)) return [];
  const shots: RunShot[] = [];
  for (const item of value) {
    const row = asRecord(item);
    if (typeof row.path !== "string" || !row.path) continue;
    shots.push({
      camera: typeof row.camera === "string" ? row.camera : "shot",
      path: row.path,
      ...(typeof row.bytes === "number" ? { bytes: row.bytes } : {}),
    });
  }
  return shots;
}

export function asPathList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function normalizeIteration(
  payload: Record<string, unknown>,
  fallback: { runId: string; project: string },
): RunIterationView {
  return {
    iteration: Number(payload.iteration) || 0,
    iterationId: String(payload.iterationId ?? String(payload.iteration ?? "")),
    runId: String(payload.runId ?? fallback.runId),
    project: String(payload.project ?? fallback.project),
    winner: roundWinner(payload.winner),
    outcome: roundOutcome(payload),
    biggest_gap: String(payload.biggest_gap ?? ""),
    reason: String(payload.reason ?? ""),
    snapshot: typeof payload.snapshot === "string" ? payload.snapshot : null,
    attemptSnapshot: typeof payload.attemptSnapshot === "string" ? payload.attemptSnapshot : null,
    shots: asShots(payload.shots),
    incumbentShots: asShots(payload.incumbentShots),
  };
}

/** Old logs omitted incumbent stills; reconstruct them from the last kept challenger. */
export function fillIncumbentShots(iterations: RunIterationView[]): RunIterationView[] {
  let kept: RunShot[] = [];
  return iterations.map((iteration) => {
    const incumbentShots = iteration.incumbentShots.length > 0 ? iteration.incumbentShots : kept;
    const next = incumbentShots === iteration.incumbentShots ? iteration : { ...iteration, incumbentShots };
    if (iteration.outcome === RoundOutcome.Accepted) kept = iteration.shots;
    return next;
  });
}

function custom(event: EventEnvelope): { event_type: string; payload: Record<string, unknown> } | null {
  if (event.data.type !== EventKind.Custom) return null;
  return { event_type: event.data.event_type, payload: asRecord(event.data.payload) };
}

/** How many of a run's rounds the review shows, newest first. */
const REVIEW_ROUNDS = 24;

/** The runs a log holds, in the order they first appeared, and the last one started. */
interface ReviewRuns {
  runs: Map<string, RunBucket>;
  order: string[];
  lastStartedId: string | null;
}

type RunRow = { event: EventEnvelope; payload: Record<string, unknown> };

function bucketFor(loopRuns: ReviewRuns, runId: string, fallbackProject: string): RunBucket {
  let bucket = loopRuns.runs.get(runId);
  if (!bucket) {
    bucket = { project: fallbackProject, runId, started: null, finished: null, iterations: [] };
    loopRuns.runs.set(runId, bucket);
    loopRuns.order.push(runId);
  }
  return bucket;
}

/** The project a record names, when it names one. */
function namedProject(payload: Record<string, unknown>): string | null {
  return typeof payload.project === "string" && payload.project ? payload.project : null;
}

function readStarted(loopRuns: ReviewRuns, { event, payload }: RunRow): void {
  const runId = String(payload.runId ?? event.id);
  const bucket = bucketFor(loopRuns, runId, String(payload.project ?? ""));
  bucket.started = {
    ...bucket.started,
    ...payload,
    startedAt: bucket.started?.startedAt ?? payload.startedAt ?? event.created_at,
  };
  bucket.project = namedProject(payload) ?? bucket.project;
  loopRuns.lastStartedId = runId;
}

/** The run's length: the one it recorded, else the time since its start, else unknown. */
function runDuration(payload: Record<string, unknown>, bucket: RunBucket, finishedAt: string): number | null {
  if (typeof payload.durationMs === "number") return payload.durationMs;
  const elapsed = Date.parse(finishedAt) - Date.parse(String(bucket.started?.startedAt ?? ""));
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

function readFinished(loopRuns: ReviewRuns, { event, payload }: RunRow): void {
  const runId = String(payload.runId ?? loopRuns.lastStartedId ?? event.id);
  const bucket = bucketFor(loopRuns, runId, String(payload.project ?? ""));
  bucket.finished = { ...payload, durationMs: runDuration(payload, bucket, event.created_at) };
  bucket.project = namedProject(payload) ?? bucket.project;
}

function readIteration(loopRuns: ReviewRuns, { payload }: RunRow): void {
  const runId = String(payload.runId ?? loopRuns.lastStartedId ?? "");
  if (!runId) return;
  const bucket = bucketFor(loopRuns, runId, String(payload.project ?? ""));
  const project = namedProject(payload);
  if (project && !bucket.project) bucket.project = project;
  bucket.iterations.push(normalizeIteration(payload, { runId, project: bucket.project }));
}

const LOOP_RUN_READERS: ReadonlyMap<string, (loopRuns: ReviewRuns, row: RunRow) => void> = new Map([
  [CustomEvent.RunStarted, readStarted],
  [CustomEvent.RunFinished, readFinished],
  [CustomEvent.RunIteration, readIteration],
]);

/**
 * The selected game's most recent run, including one still in flight (started, not finished).
 * Pass `project: null` to get an empty review — never a mashup of every game in the log.
 */
export function lastLoopRunForProject(events: EventEnvelope[], project: string | null): LoopRunReview {
  if (!project) return { project: null, started: null, finished: null, iterations: [] };
  const loopRuns: ReviewRuns = { runs: new Map(), order: [], lastStartedId: null };
  for (const event of events) {
    const row = custom(event);
    if (row) LOOP_RUN_READERS.get(row.event_type)?.(loopRuns, { event, payload: row.payload });
  }
  const buckets = loopRuns.order.map((runId) => loopRuns.runs.get(runId));
  const bucket = buckets.findLast((candidate) => candidate?.project === project);
  if (!bucket) return { project, started: null, finished: null, iterations: [] };
  return {
    project,
    started: bucket.started,
    finished: bucket.finished,
    iterations: fillIncumbentShots(bucket.iterations).slice().reverse().slice(0, REVIEW_ROUNDS),
  };
}

export function playSnapshotId(iteration: RunIterationView): string | null {
  return iteration.attemptSnapshot || iteration.snapshot;
}

/**
 * Self-changes a later rewind silently discarded, keyed by the change's pre-write snapshot id —
 * the id its Review card diffs from. A self-change write appends `post_snapshot_id` beside its
 * `snapshot_id`; the change is undone once a later `workspace_restored` whose scope covers the
 * harness ("harness" or "both" — every rewind path appends this event) restored a snapshot
 * created before that post snapshot. "Older" is settled by `snapshot_created` order in this same
 * log, never by id shape, so a restore target of unknown vintage flags nothing — except the
 * change's own pre-write snapshot, which precedes its post snapshot by construction. Changes
 * without `post_snapshot_id` (historical logs) are never flagged: there is no post-write state
 * to compare a restore against. The value is the restore's reason, or its event id when the
 * reason is blank. A change the user undid on its own (`self_change_undone`) is flagged whatever
 * it recorded, with {@link UNDONE_BY_USER} as the reason.
 */
export const UNDONE_BY_USER = "undone by the user";

/** A self-change that wrote a post snapshot, which a later rewind can take back. */
type PendingChange = { snapshotId: string; postSnapshotId: string };

/** Did this restore rewind the harness to before the change's post snapshot? */
function rewoundPast(
  change: PendingChange,
  restoredId: string,
  restoredTo: number | undefined,
  createdOrder: Map<string, number>,
): boolean {
  if (restoredId === change.snapshotId) return true;
  const postAt = createdOrder.get(change.postSnapshotId);
  return restoredTo !== undefined && postAt !== undefined && restoredTo < postAt;
}

export function undoneSelfChanges(events: EventEnvelope[]): Map<string, string> {
  const createdOrder = new Map<string, number>();
  const pending: PendingChange[] = [];
  const undone = new Map<string, string>();
  const readChange = (event_type: string, payload: Record<string, unknown>) => {
    // "Undo this change" takes back that one change and names it.
    if (event_type === CustomEvent.SelfChangeUndone && typeof payload.snapshot_id === "string") {
      undone.set(payload.snapshot_id, UNDONE_BY_USER);
      return;
    }
    if (typeof payload.snapshot_id === "string" && typeof payload.post_snapshot_id === "string") {
      pending.push({ snapshotId: payload.snapshot_id, postSnapshotId: payload.post_snapshot_id });
    }
  };
  const readRestore = (restoredId: string, because: string) => {
    const restoredTo = createdOrder.get(restoredId);
    for (const change of pending) {
      if (undone.has(change.snapshotId)) continue;
      if (rewoundPast(change, restoredId, restoredTo, createdOrder)) undone.set(change.snapshotId, because);
    }
  };
  events.forEach((event, index) => {
    const data = event.data;
    if (data.type === EventKind.SnapshotCreated) {
      if (!createdOrder.has(data.snapshot_id)) createdOrder.set(data.snapshot_id, index);
      return;
    }
    if (data.type === EventKind.Custom) {
      readChange(data.event_type, asRecord(data.payload));
      return;
    }
    if (data.type !== EventKind.WorkspaceRestored || data.scope === "game") return;
    readRestore(data.snapshot_id, data.reason || event.id);
  });
  return undone;
}

/** How a director's run landed: verified, live but unverified, or not landed. */
function directorResult(finished: Record<string, unknown>): string {
  if (asRecord(finished.landingResult).verified === true) return "preferred";
  return finished.landed === true ? "live" : "not landed";
}

/** A director's declared victory is not a comparative judgment against a reference. */
export function reviewOutcome(finished: Record<string, unknown>): { value: string; label: string } {
  if (finished.mode !== "director") return { value: finished.victory ? "won" : "held", label: "vs the bar" };
  return { value: directorResult(finished), label: "result" };
}
