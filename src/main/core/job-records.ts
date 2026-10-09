/**
 * A job's start and end as host records in the chat it reports to (`job_started`, `job_ended`):
 * written by the app that owns the job (`JobService`'s `onStarted`/`onEnded`), never by the harness
 * (`harness-events.ts` refuses both). The chat is nudged as for its other host rows.
 */
import path from "node:path";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { errorMessage } from "../../shared/errors.ts";
import { type JobEndedPayload, type JobRecord, JobScopeKind, type JobStartedPayload } from "../../shared/jobs.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { isInside } from "../../substrate/paths.ts";
import type { StudioCore } from "../studio-core.ts";

/** How many of a job's last log lines its end record keeps, and at most how many characters. */
const JOB_ENDED_TAIL_LINES = 20;
const JOB_ENDED_TAIL_CHARS = 1_500;

const MESSAGE = {
  notRecorded: (what: string, id: string, error: unknown) =>
    `[core] the ${what} of job ${id} was not recorded in its chat: ${errorMessage(error)}`,
} as const;

/** A job's folder as its records name it: relative to its game ("." for its root), else as it is. */
function gameRelative(core: StudioCore, record: JobRecord): string {
  const game = path.resolve(core.games.dirFor(record.owner.project));
  const cwd = path.resolve(record.cwd);
  return isInside(game, cwd) ? path.relative(game, cwd) || "." : cwd;
}

/**
 * The graph a job's records belong to: its run when it is a run's, else the chat turn it belongs to
 * (a turn worker's) or was started in (the chat's own session's).
 */
function scopeOf(record: JobRecord): { runId?: string; turn?: string } {
  const { scope, turn } = record.owner;
  if (scope.kind === JobScopeKind.Run) return { runId: scope.runId };
  if (scope.kind === JobScopeKind.Turn) return { turn: scope.turn };
  return turn ? { turn } : {};
}

/** The `job_started` record of a job. */
function jobStartedPayload(core: StudioCore, record: JobRecord): JobStartedPayload {
  const { owner } = record;
  return {
    jobId: record.id,
    project: owner.project,
    title: record.title,
    command: record.command,
    cwd: gameRelative(core, record),
    startedAt: record.startedAt,
    role: owner.role,
    ...(owner.worker ? { worker: { ...owner.worker } } : {}),
    ...scopeOf(record),
    deadlineAt: record.deadlineAt,
  };
}

/** The last lines of a job's log, as its end record keeps them; none when it cannot be read. */
async function endTail(core: StudioCore, record: JobRecord): Promise<string | undefined> {
  const tail = await core.jobs.tail(record.owner.project, record.id, { lines: JOB_ENDED_TAIL_LINES }).catch(() => null);
  const text = tail?.text ?? "";
  return text ? text.slice(-JOB_ENDED_TAIL_CHARS) : undefined;
}

/** The `job_ended` record of a job. */
async function jobEndedPayload(core: StudioCore, record: JobRecord): Promise<JobEndedPayload> {
  const endedAt = record.endedAt ?? new Date().toISOString();
  const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(record.startedAt)) || 0;
  const tail = await endTail(core, record);
  return {
    jobId: record.id,
    project: record.owner.project,
    title: record.title,
    state: record.state,
    exitCode: record.exitCode ?? null,
    signal: record.signal ?? null,
    endedAt,
    durationMs,
    ...(record.stoppedBy ? { stoppedBy: record.stoppedBy } : {}),
    ...(record.owner.worker ? { worker: { ...record.owner.worker } } : {}),
    ...scopeOf(record),
    ...(tail ? { tail } : {}),
  };
}

/** Append a host row to a job's chat and nudge the chat. */
async function appendToChat(core: StudioCore, record: JobRecord, data: ReturnType<typeof customEventData>) {
  const threadId = record.owner.chatThreadId;
  await core.append([data], threadId);
  core.emit(UiEvent.ThreadUpdated, { threadId, project: record.owner.project });
}

/** Record a job's start in its chat; a failure is logged, never the job's. */
export async function recordJobStarted(core: StudioCore, record: JobRecord): Promise<void> {
  try {
    await appendToChat(core, record, customEventData(CustomEvent.JobStarted, { ...jobStartedPayload(core, record) }));
  } catch (error) {
    core.options.onLog?.(MESSAGE.notRecorded("start", record.id, error), "stderr");
  }
}

/**
 * Record a job's end in its chat, then mark it recorded, so a later app start hands only the ends
 * never recorded (`JobService.reconcile`). A failure is logged and left for that later start.
 */
export async function recordJobEnded(core: StudioCore, record: JobRecord): Promise<void> {
  try {
    const payload = await jobEndedPayload(core, record);
    await appendToChat(core, record, customEventData(CustomEvent.JobEnded, { ...payload }));
    await core.jobs.markEndLogged(record.owner.project, record.id);
  } catch (error) {
    core.options.onLog?.(MESSAGE.notRecorded("end", record.id, error), "stderr");
  }
}
