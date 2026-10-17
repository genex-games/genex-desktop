/**
 * The ends of a run's jobs, as a lead hears them. The app owns every job (`jobs.list` reads its
 * registry; the harness can neither start nor stop one): a lead's loop asks for the ends after a
 * cursor it keeps in its run's journal, so after a restart it reads on from there, nothing told
 * twice and nothing lost. An end the agent itself caused (`job_stop`) is passed over, since the
 * agent that stopped it knows; the cursor still moves past it. An app without `jobs.list` answers
 * nothing, and nothing is thrown.
 */
import type { HarnessCtx } from "../../types/harness.d.ts";
import type { HarnessParams, JobView } from "../../types/host-api.d.ts";
import { HostMethod } from "../host-methods.ts";
import { SECOND_MS } from "../time.ts";
import { JobStopper } from "./contract.ts";

/** A resting lead's loop asks the host for its run's job ends at most this often. */
export const JOB_POLL_MS = 5 * SECOND_MS;

/** One job of the run that ended, as the host told it. */
export type JobEnd = JobView;

/** The run a watcher reads: its game, and the run whose jobs (its lead's and its workers') it hears. */
export type JobWatchScope = { project: string; runId: string };

/** What a read found: the ends to tell, and where the next read goes on from. */
export type JobEndsRead = { ends: JobEnd[]; cursor: number };

/** Whether the host's answer to `jobs.list` is one this reader understands. */
function readable(answer: unknown): answer is { jobs: JobView[]; seq: number } {
  const value = answer as { jobs?: unknown; seq?: unknown } | null;
  return Boolean(value) && Array.isArray(value?.jobs) && Number.isSafeInteger(value?.seq);
}

/** The host's answer to `jobs.list`, or null for any failure, a thrown one included: a read never fails its loop. */
async function listJobs(host: Pick<HarnessCtx, "call">, params: HarnessParams<"jobs.list">): Promise<unknown> {
  try {
    return await host.call(HostMethod.JobsList, params);
  } catch {
    return null;
  }
}

/**
 * The run's jobs that ended after `cursor`, oldest first, less those the agent stopped itself, and
 * the cursor to go on from. A failed call or an answer it cannot read leaves the cursor where it was.
 */
export async function jobEnds(
  host: Pick<HarnessCtx, "call">,
  scope: JobWatchScope,
  cursor: number,
): Promise<JobEndsRead> {
  const params = { project: scope.project, runId: scope.runId, endedAfter: cursor };
  const answer = await listJobs(host, params);
  if (!readable(answer)) return { ends: [], cursor };
  const ends = answer.jobs
    .filter((job) => typeof job.endSeq === "number" && job.endSeq > cursor)
    .sort((a, b) => (a.endSeq ?? 0) - (b.endSeq ?? 0));
  return {
    ends: ends.filter((job) => job.stoppedBy !== JobStopper.Agent),
    cursor: Math.max(cursor, answer.seq, ...ends.map((job) => job.endSeq ?? 0)),
  };
}
