/**
 * The harness's copy of the names Genex gives the long processes its agents start (jobs): where a
 * job is, who stopped it, who started it, the job tools and the look-only app tool. The app's copy
 * is `shared/jobs.ts`; `seed-contracts.test.ts` holds the two together. Wire values: never rename
 * one. It imports nothing, so any module can read it while any other is still loading.
 */

/** Where a job is: running, ended on its own (succeeded or failed), stopped, timed out, or interrupted by an earlier Genex ending. */
export const JobState = {
  Running: "running",
  Succeeded: "succeeded",
  Failed: "failed",
  Stopped: "stopped",
  TimedOut: "timed_out",
  Interrupted: "interrupted",
} as const;
export type JobState = (typeof JobState)[keyof typeof JobState];

/** Who stopped a job: the agent, the person, the end of its run or turn, or quitting Genex. */
export const JobStopper = { Agent: "agent", Person: "person", ScopeEnded: "scope_ended", Quit: "quit" } as const;
export type JobStopper = (typeof JobStopper)[keyof typeof JobStopper];

/** Who started a job: the chat's own agent, a lead or a worker. */
export const JobRole = { Chat: "chat", Lead: "lead", Worker: "worker" } as const;
export type JobRole = (typeof JobRole)[keyof typeof JobRole];

/** The job tools, by the names an engine sends. */
export const JobTool = { Start: "job_start", Status: "job_status", Tail: "job_tail", Stop: "job_stop" } as const;
export type JobTool = (typeof JobTool)[keyof typeof JobTool];

/** The look-only tool for an app window's picture and accessibility tree. */
export const APP_LOOK_TOOL_NAME = "app_look";
