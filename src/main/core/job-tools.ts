/**
 * The job tools (`job_start`, `job_status`, `job_tail`, `job_stop`) of the chat's own session, a
 * lead and a worker that writes: a long command the app runs in the background (`JobService`),
 * which outlives the session's turn and reports to its chat. A start follows the chat's permission
 * mode at the moment of the call (`jobGate`): Plan answers that it waits for the plan, Accept edits
 * and Manual ask the person on a card, Auto and Bypass start it in the mode's box. Whoever starts
 * it and in every mode, its command passes the never-touch screen first and its box denies the
 * never-touch list. A session sees and stops only its chat's jobs; a worker only its own.
 */
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../../shared/errors.ts";
import { HOUR_MS, MINUTE_MS } from "../../shared/duration.ts";
import type { LiveToolResult, LiveToolSpec } from "../../shared/engine-requests.ts";
import {
  type JobOwner,
  type JobRecord,
  JobRole,
  type JobScope,
  JobScopeKind,
  JobStopper,
  JobTool,
  isEndedJob,
  jobTitle,
} from "../../shared/jobs.ts";
import { PermissionDecision } from "../../shared/permissions.ts";
import { neverTouchFence, neverTouchScreen } from "../../substrate/engines/claude-permissions.ts";
import { neverTouchReason, SHELL_TOOL } from "../../substrate/engines/never-touch.ts";
import type { PermissionReply } from "../../substrate/engines/types.ts";
import { JobRefusal, JOB_DEFAULT_HOURS } from "../../substrate/jobs.ts";
import { isInside } from "../../substrate/paths.ts";
import type { StudioCore } from "../studio-core.ts";
import type { CoreInternals } from "./internals.ts";
import { JobGate, jobGate, type JobReach, jobPolicy } from "./job-gate.ts";
import {
  JOB_ANSWER,
  type JobLine,
  JOB_START_TOOL,
  JOB_STATUS_TOOL,
  JOB_STOP_TOOL,
  JOB_TAIL_TOOL,
} from "./job-tools-prompts.ts";
import { ProjectToolSeat } from "./project-tools.ts";
import { jobNotice } from "./delegation-prompts.ts";

/** The most jobs one `job_status` lists: the latest. */
const JOB_STATUS_MAX = 20;

/** Why a job tool call is refused outright, and what the screen could not read. */
const MESSAGE = {
  unknownTool: (name: string) => `Unknown tool: ${name}`,
  unscreened:
    "Genex could not check what this command reaches, so the job did not start. Do not retry it or work around it; carry on without it.",
} as const;

/**
 * A session that may run jobs: the folder its jobs run in and below (a worker's or the chat's own
 * folder, a lead's build), where they may write and what they never reach, and whose they are.
 */
export interface JobCaller {
  /** The folder its jobs run in and below, by its real path. */
  folder: string;
  reach: JobReach;
  owner: JobOwner;
  /** A run worker's run's first start (ms since the epoch): a "Don't wait for me" made before it reaches it. */
  runStartedAt?: number | null;
}

/**
 * The job tools a session is handed, by its seat: the chat's own session, a lead and a worker the
 * host seated (a worker with host tools writes: a reader has none) get all four; anyone else none.
 */
export function jobToolsFor(seat: ProjectToolSeat): LiveToolSpec[] {
  if (seat === ProjectToolSeat.None) return [];
  return [JOB_START_TOOL, JOB_STATUS_TOOL, JOB_TAIL_TOOL, JOB_STOP_TOOL];
}

/** One job tool call of a session that may run jobs, by name. */
export async function callJobTool(
  core: StudioCore,
  x: CoreInternals,
  name: string,
  args: Record<string, unknown>,
  caller: JobCaller,
  signal: AbortSignal,
): Promise<LiveToolResult> {
  if (name === JobTool.Start) return startJob(core, x, caller, args, signal);
  if (name === JobTool.Status) return jobStatus(core, caller, args);
  if (name === JobTool.Tail) return jobTail(core, caller, args);
  if (name === JobTool.Stop) return jobStop(core, caller, args);
  throw new Error(MESSAGE.unknownTool(name));
}

/** A string argument, trimmed; anything else is empty. */
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** A number argument as a model sends it (a number, or a string of one); undefined otherwise. */
function numberArg(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * `job_start`: in the chat's mode now. Plan answers before anything else; then the folder is
 * checked, the command screened, the person asked when the mode asks, and the job started in the
 * mode's box. Nothing starts on any refusal.
 */
async function startJob(
  core: StudioCore,
  x: CoreInternals,
  caller: JobCaller,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<LiveToolResult> {
  const mode = await x.permissions.modeOf(caller.owner.chatThreadId);
  const gate = jobGate(mode);
  if (gate === JobGate.Plan) return JOB_ANSWER.inPlan;
  const command = text(args.command);
  const title = jobTitle(text(args.title), command);
  const cwd = await jobFolder(caller.folder, args.cwd);
  if (!cwd) return refusal(JOB_ANSWER.badFolder(text(args.cwd)));
  const screened = await screenCommand(command, caller.reach, cwd);
  if (screened) return refusal(screened);
  if (gate === JobGate.Ask) {
    const folder = path.relative(caller.folder, cwd) || ".";
    const reply = await x.permissions.askForJob(jobAsk(caller, { title, command, folder }, signal));
    if (!allowed(reply)) return refusal(declinedWords(reply));
  }
  const policy = jobPolicy(gate, caller.reach, await neverTouchFence(caller.reach.neverTouch));
  const hours = numberArg(args.hours);
  try {
    const record = await core.jobs.start({
      owner: caller.owner,
      title,
      command,
      cwd,
      policy,
      mode,
      ...(hours !== undefined ? { hours } : {}),
    });
    return JOB_ANSWER.started(record.id, record.title, cwd, record.command, hoursOf(record));
  } catch (error) {
    if (error instanceof JobRefusal) return refusal(JOB_ANSWER.refused(error.code));
    return refusal(errorMessage(error));
  }
}

/** A tool answer that did nothing. */
const refusal = (words: string): LiveToolResult => ({ text: words, isError: true });

/** Whether the person's answer lets the job start. */
const allowed = (reply: PermissionReply): boolean =>
  reply.decision === PermissionDecision.Allow || reply.decision === PermissionDecision.Always;

/** What a session reads when its job was not allowed: the host's own words, or the person's no. */
function declinedWords(reply: PermissionReply): string {
  const own = "withdrawn" in reply && reply.withdrawn ? reply.message : undefined;
  return own ?? JOB_ANSWER.declined;
}

/** A job's card request, by who asks. */
function jobAsk(
  caller: JobCaller,
  job: { title: string; command: string; folder: string },
  signal: AbortSignal,
): Parameters<CoreInternals["permissions"]["askForJob"]>[0] {
  const { owner } = caller;
  const runId = owner.scope.kind === JobScopeKind.Run ? owner.scope.runId : null;
  return {
    project: owner.project,
    threadId: owner.chatThreadId,
    asker: owner.role,
    ...job,
    signal,
    ...(owner.worker ? { worker: owner.worker } : {}),
    runId,
    runStartedAt: caller.runStartedAt ?? null,
  };
}

/**
 * The folder a job runs in: the session's own, or a folder inside it named relative to it. Never
 * an absolute path, a home-relative one, one that climbs out (by `..` or through a link), a file or
 * a folder that does not exist: null for each.
 */
async function jobFolder(folder: string, asked: unknown): Promise<string | null> {
  const base = await realpath(folder).catch(() => null);
  if (!base) return null;
  if (asked === undefined || asked === null || text(asked) === "") return base;
  if (typeof asked !== "string") return null;
  const named = asked.trim();
  if (path.isAbsolute(named) || path.win32.isAbsolute(named) || named.startsWith("~")) return null;
  const real = await realpath(path.resolve(base, named)).catch(() => null);
  if (!real || !isInside(base, real)) return null;
  const isFolder = await stat(real).then(
    (entry) => entry.isDirectory(),
    () => false,
  );
  return isFolder ? real : null;
}

/**
 * The never-touch screen's refusal of a command, run where the job would run (`neverTouchScreen`):
 * the screen's own words for a hit, a refusal for a command it cannot read, null when it passes.
 */
async function screenCommand(command: string, reach: JobReach, cwd: string): Promise<string | null> {
  try {
    const hit = await neverTouchScreen({ tool: SHELL_TOOL, input: { command } }, reach.neverTouch, cwd, reach.home);
    return hit ? neverTouchReason(hit) : null;
  } catch {
    return MESSAGE.unscreened;
  }
}

/** A job's time limit in whole hours, as its record has it. */
function hoursOf(record: JobRecord): number {
  const ms = Date.parse(record.deadlineAt) - Date.parse(record.startedAt);
  return Number.isFinite(ms) ? Math.round((ms / HOUR_MS) * 100) / 100 : JOB_DEFAULT_HOURS;
}

/** Whether two scopes are the same chat, run or turn. */
function sameScope(a: JobScope, b: JobScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === JobScopeKind.Run && b.kind === JobScopeKind.Run) return a.runId === b.runId;
  if (a.kind === JobScopeKind.Turn && b.kind === JobScopeKind.Turn) return a.turn === b.turn;
  return true;
}

/** Whether a session may see a job: its chat's, and for a worker only its own of its own run or turn. */
function visible(record: JobRecord, caller: JobCaller): boolean {
  const { owner } = caller;
  const ours = record.owner.project === owner.project && record.owner.chatThreadId === owner.chatThreadId;
  if (!ours || owner.role !== JobRole.Worker) return ours;
  const sameWorker = record.owner.worker?.id === owner.worker?.id;
  return sameWorker && sameScope(record.owner.scope, owner.scope);
}

/** One job the session may see, by the id it named; null for any other. */
async function visibleJob(core: StudioCore, caller: JobCaller, id: string): Promise<JobRecord | null> {
  const record = await core.jobs.get(caller.owner.project, id);
  return record && visible(record, caller) ? record : null;
}

/** A job as its status line reads it. */
function lineOf(record: JobRecord, now = Date.now()): JobLine {
  const end = record.endedAt ? Date.parse(record.endedAt) : now;
  const minutes = Math.max(0, Math.round((end - Date.parse(record.startedAt)) / MINUTE_MS));
  return {
    id: record.id,
    title: record.title,
    state: record.state,
    exitCode: record.exitCode,
    minutes: Number.isFinite(minutes) ? minutes : 0,
    worker: record.owner.worker?.title,
    stoppedBy: record.stoppedBy,
  };
}

/** `job_status`: one job, or the latest jobs the session may see. */
async function jobStatus(core: StudioCore, caller: JobCaller, args: Record<string, unknown>): Promise<LiveToolResult> {
  const id = text(args.id);
  if (id) {
    const record = await visibleJob(core, caller, id);
    return record ? JOB_ANSWER.status([lineOf(record)]) : refusal(JOB_ANSWER.unknown(id));
  }
  const jobs = (await core.jobs.list(caller.owner.project)).filter((record) => visible(record, caller));
  if (!jobs.length) return JOB_ANSWER.none;
  return JOB_ANSWER.status(jobs.slice(-JOB_STATUS_MAX).map((record) => lineOf(record)));
}

/** `job_tail`: the end of one visible job's output. */
async function jobTail(core: StudioCore, caller: JobCaller, args: Record<string, unknown>): Promise<LiveToolResult> {
  const id = text(args.id);
  if (!(await visibleJob(core, caller, id))) return refusal(JOB_ANSWER.unknown(id));
  const lines = numberArg(args.lines);
  const contains = text(args.contains);
  const tail = await core.jobs.tail(caller.owner.project, id, {
    ...(lines !== undefined ? { lines } : {}),
    ...(contains ? { contains } : {}),
  });
  if (!tail) return refusal(JOB_ANSWER.unknown(id));
  return JOB_ANSWER.tail(tail.text, tail.partial);
}

/** `job_stop`: stop one visible job, as the agent stopped it. */
async function jobStop(core: StudioCore, caller: JobCaller, args: Record<string, unknown>): Promise<LiveToolResult> {
  const id = text(args.id);
  if (!(await visibleJob(core, caller, id))) return refusal(JOB_ANSWER.unknown(id));
  const record = await core.jobs.stop(caller.owner.project, id, JobStopper.Agent);
  return record ? JOB_ANSWER.stopped(lineOf(record)) : refusal(JOB_ANSWER.unknown(id));
}

/** What a chat's own session is told of its jobs as its turn begins, and the ended ones that tells. */
export interface JobNews {
  notice: string;
  told: string[];
}

/**
 * The chat's own session's news of its own jobs: those that ended since it was last told, and
 * those still running. A worker's and a lead's jobs are their own sessions' to follow.
 */
export async function jobNews(core: StudioCore, owner: Pick<JobOwner, "project" | "chatThreadId">): Promise<JobNews> {
  const jobs = (await core.jobs.list(owner.project)).filter(
    (record) => record.owner.chatThreadId === owner.chatThreadId && record.owner.role === JobRole.Chat,
  );
  const ended = jobs.filter((record) => isEndedJob(record) && record.toldChat !== true);
  const running = jobs.filter((record) => !isEndedJob(record));
  return { notice: jobNotice(ended, running), told: ended.map((record) => record.id) };
}
