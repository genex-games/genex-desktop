/**
 * The developer control's `runs`: where each run of a profile stands, read from the event log
 * and the run journals and nothing else, so an operator watching an unattended Loop can tell a
 * working run from a paused or finished one without scraping the profile's files. Read-only.
 */
import { CustomEvent, customRecord } from "../../shared/custom-events.ts";
import type { ConversationRecord, EventEnvelope } from "../../shared/event-log.ts";
import {
  JournalPhase,
  type RunExecution,
  RunState,
  runExecution,
  runExecutions,
  workedMs,
} from "../../shared/run-state.ts";

/** The most runs one answer lists. */
const MAX_LISTED_RUNS = 24;

/** The records `runs` reads: the event store's threads, their events and their artifacts. */
export interface RunRecords {
  listThreads(): Promise<Array<Pick<ConversationRecord, "id" | "metadata">>>;
  listEvents(threadId: string): Promise<EventEnvelope[]>;
  readArtifact(threadId: string, artifactId: string): Promise<unknown>;
}

/** The run's clock as its journal last saved it. */
export interface DevRunClock {
  softDeadline: string | null;
  finalDeadline: string | null;
  workedMs: number | null;
}

/** One run, as `runs` reports it. */
export interface DevRun {
  runId: string;
  threadId: string;
  project: string | null;
  state: RunExecution["state"];
  status: RunExecution["status"];
  startedAt: string | null;
  endedAt: string | null;
  /** How long it has worked, paused time not counted (`run-state.ts` `workedMs`). */
  workedMs: number;
  /** Its journal's phase, when it has a journal. */
  phase: string | null;
  clock: DevRunClock | null;
  /** Its own newest record: when, and which. */
  lastEventAt: string | null;
  lastEventType: string | null;
  /** What its last close said, while it is closed. */
  stoppedBecause: string | null;
  stopCode: string | null;
  integrationHead: string | null;
  landed: boolean | null;
  /** A Resume would continue it: paused, with a journal that is not done. */
  resumable: boolean;
}

/** What one thread's history says about each of its runs beyond its execution. */
interface RunTrail {
  last: { at: string; type: string } | null;
  close: Record<string, unknown> | null;
}

/** The journal fields `runs` reports. */
type Journal = { phase?: unknown; director?: { clock?: Record<string, unknown> } } | null;

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Each run's newest own record and its last close, by run id. */
function runTrails(events: readonly EventEnvelope[]): Map<string, RunTrail> {
  const trails = new Map<string, RunTrail>();
  for (const event of events) {
    const custom = customRecord(event.data);
    const runId = text(custom?.payload.runId);
    if (!custom || !runId) continue;
    const trail = trails.get(runId) ?? { last: null, close: null };
    trail.last = { at: event.created_at, type: custom.event_type };
    if (custom.event_type === CustomEvent.RunFinished) trail.close = custom.payload as Record<string, unknown>;
    trails.set(runId, trail);
  }
  return trails;
}

/**
 * The runs of one thread worth listing: every open one, and the one the conversation is on (the
 * last started, a reopened run included) when the person is looking at it.
 */
function listedRuns(events: readonly EventEnvelope[], active: boolean): RunExecution[] {
  const current = active ? (runExecution(events)?.runId ?? null) : null;
  return [...runExecutions(events).values()].filter((run) => run.state !== RunState.Finished || run.runId === current);
}

function clockOf(journal: Journal): DevRunClock | null {
  const clock = journal?.director?.clock;
  if (!clock) return null;
  const worked = clock.workedMs;
  return {
    softDeadline: text(clock.softDeadline),
    finalDeadline: text(clock.finalDeadline),
    workedMs: typeof worked === "number" && Number.isFinite(worked) ? worked : null,
  };
}

/** The journal a Resume continues from (`studio-core.ts` `resumeAutopilot`), or null. */
async function readJournal(records: RunRecords, threadId: string, runId: string): Promise<Journal> {
  const journal = await records.readArtifact(threadId, `autopilot_${runId}`).catch(() => null);
  return journal && typeof journal === "object" ? (journal as Journal) : null;
}

async function describe(
  records: RunRecords,
  thread: { id: string; project: string | null },
  run: RunExecution,
  trail: RunTrail | undefined,
  now: number,
): Promise<DevRun> {
  const journal = await readJournal(records, thread.id, run.runId);
  const phase = text(journal?.phase);
  const close = run.state === RunState.Running ? null : (trail?.close ?? null);
  return {
    runId: run.runId,
    threadId: thread.id,
    project: thread.project,
    state: run.state,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    workedMs: workedMs(run.worked, now),
    phase,
    clock: clockOf(journal),
    lastEventAt: trail?.last?.at ?? null,
    lastEventType: trail?.last?.type ?? null,
    stoppedBecause: text(close?.stoppedBecause),
    stopCode: text(close?.stopCode),
    integrationHead: text(close?.integrationHead),
    landed: typeof close?.landed === "boolean" ? close.landed : null,
    resumable: run.state === RunState.Paused && journal !== null && phase !== JournalPhase.Done,
  };
}

/**
 * Every open run of the profile, and the newest run of the chat the person has open, in thread
 * order, at most `limit` of them. Reads only the event log and the journals of the runs it lists.
 */
export async function listRuns(
  records: RunRecords,
  options: { activeThread: string | null; now?: number; limit?: number },
): Promise<{ runs: DevRun[]; truncated: boolean }> {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? MAX_LISTED_RUNS;
  const runs: DevRun[] = [];
  for (const record of await records.listThreads()) {
    const events = await records.listEvents(record.id);
    const listed = listedRuns(events, record.id === options.activeThread);
    if (listed.length === 0) continue;
    const trails = runTrails(events);
    const thread = { id: record.id, project: text(record.metadata?.project) };
    for (const run of listed) {
      if (runs.length === limit) return { runs, truncated: true };
      runs.push(await describe(records, thread, run, trails.get(run.runId), now));
    }
  }
  return { runs, truncated: false };
}
