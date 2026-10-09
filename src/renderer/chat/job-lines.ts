/**
 * The chat's lines for background work (`job_started`, `job_ended`) and for a missing macOS
 * permission (`app_look_access`), read from host records that may be old or partial: a field of
 * the wrong type is left out, and a record without a title draws nothing. A line never carries
 * the job's id, command or log.
 */
import { MINUTE_MS } from "../../shared/duration.ts";
import {
  AppLookAccessKind,
  type AppLookAccessPayload,
  type JobEndedPayload,
  type JobStartedPayload,
  JobState,
  JobStopper,
} from "../../shared/jobs.ts";
import { inBackground, jobRunningLine, jobStatusWords } from "../words.ts";

/** What Stop needs to reach a running job. */
export interface JobHandle {
  project: string;
  jobId: string;
  startedAt: string;
}

/** A started job's line, and what its end needs to rewrite it. */
export interface JobStart {
  line: string;
  title: string;
  worker?: string;
  jobId?: string;
  /** Present when Stop can reach it. */
  job?: JobHandle;
}

/** A field as non-empty text, or nothing. */
const textOf = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

/** The title of the worker a record names, when it names one. */
const workerTitle = (worker: unknown): string | undefined => textOf((worker as { title?: unknown } | null)?.title);

const STATES: readonly string[] = Object.values(JobState);
const STOPPERS: readonly string[] = Object.values(JobStopper);
const isJobState = (value: unknown): value is JobState => typeof value === "string" && STATES.includes(value);
const isJobStopper = (value: unknown): value is JobStopper => typeof value === "string" && STOPPERS.includes(value);

/** A `job_started` record's line; null without a title. */
export function jobStart(payload: Partial<JobStartedPayload>): JobStart | null {
  const title = textOf(payload.title);
  if (!title) return null;
  const worker = workerTitle(payload.worker);
  const jobId = textOf(payload.jobId);
  const project = textOf(payload.project);
  const startedAt = textOf(payload.startedAt) ?? "";
  return {
    line: inBackground(title, "", worker),
    title,
    ...(worker ? { worker } : {}),
    ...(jobId ? { jobId } : {}),
    ...(jobId && project ? { job: { project, jobId, startedAt } } : {}),
  };
}

/** A `job_ended` record's line, named as its start was when that is on the page; null without a title. */
export function jobEndLine(
  payload: Partial<JobEndedPayload>,
  start?: Pick<JobStart, "title" | "worker">,
): string | null {
  const title = textOf(payload.title) ?? start?.title;
  if (!title) return null;
  const state = isJobState(payload.state) ? payload.state : undefined;
  const stoppedBy = isJobStopper(payload.stoppedBy) ? payload.stoppedBy : undefined;
  const ranMs = typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs) ? payload.durationMs : 0;
  const status = jobStatusWords(state, stoppedBy, ranMs / MINUTE_MS);
  return inBackground(title, status, workerTitle(payload.worker) ?? start?.worker);
}

const PANES: readonly string[] = Object.values(AppLookAccessKind);
const isPane = (value: unknown): value is AppLookAccessKind => typeof value === "string" && PANES.includes(value);

/** The panes an `app_look_access` record says are missing, each once, in the record's order. */
export function missingPanes(payload: Partial<AppLookAccessPayload>): AppLookAccessKind[] {
  const missing: unknown[] = Array.isArray(payload.missing) ? payload.missing : [];
  return [...new Set(missing.filter(isPane))];
}

/**
 * A job line's words at `now` (ms since the epoch): a running job's minutes since its start, "just
 * started" under a minute or with a clock behind its start; the plain line once it ended or
 * without a readable start.
 */
export function runningLine(entry: { text: string; job?: JobHandle }, now: number): string {
  const started = Date.parse(entry.job?.startedAt ?? "");
  if (!entry.job || !Number.isFinite(started)) return entry.text;
  return jobRunningLine(entry.text, (now - started) / MINUTE_MS);
}
