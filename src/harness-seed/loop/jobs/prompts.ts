/**
 * The words a lead reads about its run's jobs: one line per job that ended, naming it, who
 * started it, how it ended, after how long, and how to read its output.
 */
import type { JobView } from "../../types/host-api.d.ts";
import { CLIP_QUOTE, clipMarked } from "../text.ts";
import { minutes } from "../time.ts";
import { JobRole, JobState, JobStopper } from "./contract.ts";

/** How an ended job reads, by how it ended. */
const ENDED_WORDS = {
  [JobState.Succeeded]: "finished",
  [JobState.Failed]: "failed",
  [JobState.Stopped]: "was stopped",
  [JobState.TimedOut]: "was stopped at its time limit",
  [JobState.Interrupted]: "was stopped when Genex closed",
} as const satisfies Record<Exclude<JobState, typeof JobState.Running>, string>;

/** Who started a job, as its lead reads it. */
function starter(job: Pick<JobView, "role" | "worker">): string {
  if (job.role === JobRole.Worker) return job.worker ? `started by worker ${job.worker}` : "started by a worker";
  return job.role === JobRole.Lead ? "started by you" : "started in the chat";
}

/** How a job ended, with its exit code when it has one, and who stopped it when that was the person. */
function howItEnded(job: Pick<JobView, "state" | "exitCode" | "stoppedBy">): string {
  const state = job.state === JobState.Running ? JobState.Interrupted : job.state;
  const exit = typeof job.exitCode === "number" ? ` (exit ${job.exitCode})` : "";
  const by = job.stoppedBy === JobStopper.Person ? " by the person" : "";
  return `${ENDED_WORDS[state]}${by}${exit}`;
}

/**
 * One job of the run that ended, for its lead: "Unreal build (`make`, started by worker Scene
 * builder) failed (exit 2) after 4 min; read it with job_tail <id>." A job the person stopped stays
 * stopped unless they ask.
 */
export function jobEndLine(job: JobView): string {
  const ran = typeof job.durationMs === "number" ? ` after ${minutes(job.durationMs)} min` : "";
  const command = clipMarked(job.command, CLIP_QUOTE);
  const keepStopped = job.stoppedBy === JobStopper.Person ? " Do not start it again unless the person asks." : "";
  return `${job.title} (\`${command}\`, ${starter(job)}) ${howItEnded(job)}${ran}; read it with job_tail ${job.id}.${keepStopped}`;
}
