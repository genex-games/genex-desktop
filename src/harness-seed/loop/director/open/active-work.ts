/**
 * What an open Loop's lead has at work while it rests: its pool's running workers and the run's
 * running jobs (the director's own builders too, should a run have any), and which of those jobs may
 * write in the game folder beside the lead (`writesBeside`). The wake loop reads it for
 * an open Loop only, so a lead whose workers or jobs run is not asked what next, and its heartbeat
 * keeps time while they do; a web Loop counts its builders as it always did. Jobs are read from the
 * host at most every `JOB_POLL_MS`. A module new to the seed, so the shipped wake.ts needs no new
 * name from a module an agent may have kept.
 */
import type { HarnessCtx } from "../../../types/harness.d.ts";
import type { JobView } from "../../../types/host-api.d.ts";
import { HostMethod } from "../../host-methods.ts";
import { JobRole, JobState } from "../../jobs/contract.ts";
import { JOB_POLL_MS } from "../../jobs/watch.ts";
import { LoopProfile } from "../../folder-facts.ts";
import { WorkerIsolation } from "../../workers/contract.ts";
import { isWorking, runningRecords, type WorkerRecord } from "../../workers/records.ts";
import type { LoopRun } from "../loop-run.ts";
import type { OpenLoop } from "./contract.ts";

/** Whether the run leads an open Loop. */
export const leadsOpenLoop = (loopRun: Pick<LoopRun, "profile" | "open">): boolean =>
  loopRun.profile === LoopProfile.Open && Boolean(loopRun.open);

/** The run's jobs as the host lists them now; null when it could not say. */
async function jobsNow(ctx: HarnessCtx, project: string, runId: string): Promise<JobView[] | null> {
  try {
    const answer = await ctx.call(HostMethod.JobsList, { project, runId });
    return Array.isArray(answer?.jobs) ? answer.jobs : null;
  } catch {
    return null;
  }
}

/**
 * Whether a job's owner may write in the game folder beside the lead: a worker of the run's pool that
 * works there in place (isolation lock), or a worker the pool doesn't know. Never the lead's own job,
 * nor one a worker in a copy or a reader started.
 */
export function writesBeside(job: Pick<JobView, "role" | "worker">, records: readonly WorkerRecord[]): boolean {
  if (job?.role !== JobRole.Worker) return false;
  const named = records.filter((record) => record.title === job.worker);
  return !named.length || named.some((record) => record.isolation === WorkerIsolation.Lock);
}

/**
 * Whether a job that writes beside the lead was left running by its writer in place, which has ended
 * (a server, a run of the game): nobody works on with it but the lead, who may keep it or stop it.
 */
function leftBehind(job: Pick<JobView, "worker">, records: readonly WorkerRecord[]): boolean {
  const named = records.filter((record) => record.title === job.worker);
  return named.length > 0 && !named.some(isWorking);
}

/** The jobs read into the open Loop: how many run, how many of those write beside the lead, those left behind, and its writers' last end. */
function readJobs(open: OpenLoop, jobs: readonly JobView[]): void {
  const records = open.pool?.state.records ?? [];
  const beside = jobs.filter((job) => writesBeside(job, records));
  const running = beside.filter((job) => job.state === JobState.Running);
  open.jobsRunning = jobs.filter((job) => job?.state === JobState.Running).length;
  open.writerJobsRunning = running.length;
  open.leftoverJobs = running.filter((job) => leftBehind(job, records)).map((job) => job.title || job.id);
  const ends = beside.flatMap((job) => (typeof job.endSeq === "number" ? [job.endSeq] : []));
  open.writerJobEndSeq = Math.max(open.writerJobEndSeq, ...ends);
}

/**
 * What the lead has at work now, from the last read of the run's jobs (`activeWork` refreshes it): a
 * recovery of the project's app under way counts too, so a lone lead rests while Genex brings the
 * app back, and the recovery's outcome wakes it, never the question of what next.
 */
export function workAtHand(loopRun: LoopRun): number {
  const open = loopRun.open;
  const pooled = open?.pool ? runningRecords(open.pool.state).length : 0;
  const recovering = open?.recovering ? 1 : 0;
  return loopRun.runningWorkers().length + pooled + (open?.jobsRunning ?? 0) + recovering;
}

/**
 * What the lead has at work now, the run's jobs read again when the last read is `JOB_POLL_MS` old,
 * or at once when `fresh` (a turn's edge, which must not miss a job that ran within it).
 */
export async function activeWork(loopRun: LoopRun, now: number, { fresh = false } = {}): Promise<number> {
  const open = loopRun.open;
  const stale = open && (fresh || open.jobsReadAt === null || now - open.jobsReadAt >= JOB_POLL_MS);
  if (open && stale) {
    open.jobsReadAt = now;
    const jobs = await jobsNow(loopRun.ctx, loopRun.run.project, loopRun.run.runId);
    if (jobs !== null) readJobs(open, jobs);
  }
  return workAtHand(loopRun);
}
