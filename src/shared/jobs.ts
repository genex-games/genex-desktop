/**
 * Long processes the agents start (jobs): a build, a headless run, a server, a render that keeps
 * running after the agent's turn. The main process owns every job (`substrate/jobs.ts`), keeps its
 * record on disk per game and stops it when Genex quits. Renderer-safe (no Node). The harness's
 * copy of the names is `loop/jobs/contract.ts`, held to this one by `seed-contracts.test.ts`.
 */
import type { PermissionMode } from "./permissions.ts";

/** Where a job is. Persisted in job records and events: never rename a value. */
export const JobState = {
  /** Its process runs. */
  Running: "running",
  /** It exited on its own with code 0. */
  Succeeded: "succeeded",
  /** It exited on its own with another code, or a signal ended it. */
  Failed: "failed",
  /** Someone stopped it: the agent, the person, its scope's end or quitting Genex (`stoppedBy`). */
  Stopped: "stopped",
  /** It ran past its time limit and was stopped. */
  TimedOut: "timed_out",
  /** It was running when an earlier Genex ended; this start found it and closed its record. */
  Interrupted: "interrupted",
} as const;
export type JobState = (typeof JobState)[keyof typeof JobState];

/** Who stopped a job. Persisted in job records: never rename a value. */
export const JobStopper = {
  Agent: "agent",
  Person: "person",
  /** The run, or the chat turn, it belonged to ended. */
  ScopeEnded: "scope_ended",
  Quit: "quit",
} as const;
export type JobStopper = (typeof JobStopper)[keyof typeof JobStopper];

const JOB_STATES: ReadonlySet<string> = new Set(Object.values(JobState));
const JOB_STOPPERS: ReadonlySet<string> = new Set(Object.values(JobStopper));

/** Whether `value` is a job's state, in its exact wire spelling. */
export const isJobState = (value: unknown): value is JobState => typeof value === "string" && JOB_STATES.has(value);

/** Whether `value` names who stopped a job, in its exact wire spelling. */
export const isJobStopper = (value: unknown): value is JobStopper =>
  typeof value === "string" && JOB_STOPPERS.has(value);

/** What a job belongs to, and so what ends it besides itself. Persisted: never rename a value. */
export const JobScopeKind = { Chat: "chat", Run: "run", Turn: "turn" } as const;
export type JobScopeKind = (typeof JobScopeKind)[keyof typeof JobScopeKind];

/** A job's scope: the chat (outlives turns), a run (ends when it settles) or a chat turn's worker. */
export type JobScope =
  | { kind: typeof JobScopeKind.Chat }
  | { kind: typeof JobScopeKind.Run; runId: string }
  | { kind: typeof JobScopeKind.Turn; turn: string };

/** Who started a job: the chat's own agent, a lead or a worker. Persisted: never rename a value. */
export const JobRole = { Chat: "chat", Lead: "lead", Worker: "worker" } as const;
export type JobRole = (typeof JobRole)[keyof typeof JobRole];

/** The job tools, by the names an engine sends: never rename a value. */
export const JobTool = {
  Start: "job_start",
  Status: "job_status",
  Tail: "job_tail",
  Stop: "job_stop",
} as const;
export type JobTool = (typeof JobTool)[keyof typeof JobTool];

/** The look-only tool for an app window's picture and accessibility tree: never rename it. */
export const APP_LOOK_TOOL_NAME = "app_look";

/** The tool name a job's permission card carries; persisted in `tool_permission` rows: never rename it. */
export const JOB_PERMISSION_TOOL = "Job";

/** The longest title a job keeps. */
export const JOB_TITLE_MAX_CHARS = 60;

const JOB_TOOL_NAMES: ReadonlySet<string> = new Set(Object.values(JobTool));

/** Whether `name` is one of the job tools. */
export function isJobTool(name: string): name is JobTool {
  return JOB_TOOL_NAMES.has(name);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;
const WHITESPACE = /\s+/g;
/** A shell assignment in front of a command (`FOO=1 make`): not the program. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** One line of plain text: control characters and newlines become spaces, runs of space one. */
function plainLine(text: string): string {
  return text.replace(CONTROL_CHARACTERS, " ").replace(WHITESPACE, " ").trim();
}

/** The program a command runs: its first word that is not an assignment, by its file name. */
function programName(command: string): string {
  const word = plainLine(command)
    .split(" ")
    .find((part) => part !== "" && !ASSIGNMENT.test(part));
  return word?.split("/").filter(Boolean).at(-1) ?? "";
}

/**
 * The title a job is shown by: the one the agent asked for as one plain line, clipped to
 * {@link JOB_TITLE_MAX_CHARS}; when that is empty, the name of the program the command runs.
 */
export function jobTitle(asked: string, command: string): string {
  const title = plainLine(asked) || programName(command);
  if (title.length <= JOB_TITLE_MAX_CHARS) return title;
  return `${title.slice(0, JOB_TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

/** Whose a job is: the game, the chat it reports to, who started it and what ends it. */
export interface JobOwner {
  project: string;
  chatThreadId: string;
  role: JobRole;
  scope: JobScope;
  /** The worker that started it, when one did. */
  worker?: { id: string; title: string };
  /** The chat turn (its message id) the chat's own session started it in: a chat-scope job outlives it. */
  turn?: string;
}

/** One job as its registry keeps it (`job.json`); `endSeq` orders the ends of one game's jobs. */
export interface JobRecord {
  id: string;
  title: string;
  owner: JobOwner;
  command: string;
  cwd: string;
  startedAt: string;
  state: JobState;
  endedAt?: string;
  endSeq?: number;
  exitCode?: number | null;
  signal?: string | null;
  stoppedBy?: JobStopper;
  deadlineAt: string;
  pid?: number;
  /** The process's start time as `ps -o lstart=` prints it: a left group is killed only when it matches. */
  procStart?: string;
  logFile: string;
  logBytes: number;
  /** The log reached its size cap; the job kept running. */
  logCapped?: boolean;
  /** The chat's agent has been told how it ended. */
  toldChat?: boolean;
  /** Its end is recorded in its chat. */
  endLogged?: boolean;
  /** The chat's permission mode when it started. */
  mode: PermissionMode;
}

/** Whether a job has ended, however it ended. */
export function isEndedJob(record: Pick<JobRecord, "state">): boolean {
  return record.state !== JobState.Running;
}

/**
 * One job as the harness reads it (`jobs.list`): what it is, who started it and how it ended,
 * never where its folder, log or process is. `endSeq` orders the ends of one game's jobs.
 */
export interface JobView {
  id: string;
  title: string;
  role: JobRole;
  /** The title of the worker that started it, when one did. */
  worker?: string;
  command: string;
  state: JobState;
  exitCode: number | null;
  endedAt: string | null;
  endSeq: number | null;
  /** How long it ran, once it ended. */
  durationMs: number | null;
  stoppedBy: JobStopper | null;
}

/** A job record as the harness may read it ({@link JobView}). */
export function jobView(record: JobRecord): JobView {
  const ran = Date.parse(record.endedAt ?? "") - Date.parse(record.startedAt);
  return {
    id: record.id,
    title: record.title,
    role: record.owner.role,
    ...(record.owner.worker ? { worker: record.owner.worker.title } : {}),
    command: record.command,
    state: record.state,
    exitCode: record.exitCode ?? null,
    endedAt: record.endedAt ?? null,
    endSeq: record.endSeq ?? null,
    durationMs: Number.isFinite(ran) ? Math.max(0, ran) : null,
    stoppedBy: record.stoppedBy ?? null,
  };
}

/** A job started (`job_started`, a host record in its chat). `cwd` is relative to the game, "." for its root. */
export interface JobStartedPayload {
  jobId: string;
  project: string;
  title: string;
  command: string;
  cwd: string;
  startedAt: string;
  role: JobRole;
  worker?: { id: string; title: string };
  runId?: string;
  /** The chat turn it belongs to or was started in, when it is no run's. */
  turn?: string;
  deadlineAt: string;
}

/** A job ended (`job_ended`, a host record in its chat), with the last lines of its log. */
export interface JobEndedPayload {
  jobId: string;
  project: string;
  title: string;
  state: JobState;
  exitCode: number | null;
  signal: string | null;
  endedAt: string;
  durationMs: number;
  stoppedBy?: JobStopper;
  /** The worker that started it, so an end whose start is not on the page still names it. */
  worker?: { id: string; title: string };
  runId?: string;
  /** The chat turn it belongs to or was started in, when it is no run's. */
  turn?: string;
  tail?: string;
}

/** The macOS access `app_look` needs, by the Privacy & Security pane that grants it. Persisted: never rename a value. */
export const AppLookAccessKind = { Screen: "screen", Accessibility: "accessibility" } as const;
export type AppLookAccessKind = (typeof AppLookAccessKind)[keyof typeof AppLookAccessKind];

/** Genex cannot see app windows yet (`app_look_access`, a host record): what the person must allow. */
export interface AppLookAccessPayload {
  project: string;
  missing: AppLookAccessKind[];
}
