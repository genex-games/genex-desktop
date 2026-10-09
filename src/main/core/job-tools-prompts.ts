/** What the job tools say to a model: their descriptions and their answers (`job-tools.ts`). Model-facing text. */
import type { LiveToolSpec } from "../../shared/engine-requests.ts";
import { JobState, JobStopper, JobTool } from "../../shared/jobs.ts";
import { JobRefusalCode } from "../../substrate/jobs.ts";

/** What every job can and cannot do, told with its start. */
const JOB_REACH =
  "A job has no outbound network (it may serve on localhost) and writes only in your folders; the person's sign-ins, Genex's data and other games stay out of its reach.";

/** `job_start`: a long command in the background, in the chat's permission mode. */
export const JOB_START_TOOL: LiveToolSpec = {
  name: JobTool.Start,
  description: `Start a long command in the background: a build, a headless run, a server, a render. Give it a short plain title the person will read, like 'Unreal build'. It keeps running after your turn; Genex tells you when it ends. Your own shell is for quick commands; its background shells end with your turn. ${JOB_REACH}`,
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "A short plain name the person reads, e.g. Unreal build." },
      command: { type: "string", description: "The shell command to run." },
      cwd: { type: "string", description: "A folder inside yours to run it in, relative to yours; yours by default." },
      hours: { type: "string", description: "Its time limit in hours: 2 by default, at most 24." },
    },
    required: ["title", "command"],
  },
};

/** `job_status`: one job, or every job of this game the session may see. */
export const JOB_STATUS_TOOL: LiveToolSpec = {
  name: JobTool.Status,
  description:
    "How your jobs stand: one job by its id, or, without one, every job of this game you can see, running and ended.",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "A job's id, as job_start or job_status gave it." } },
  },
};

/** `job_tail`: the end of a job's output. */
export const JOB_TAIL_TOOL: LiveToolSpec = {
  name: JobTool.Tail,
  description: "The last lines of a job's output, or only the lines that hold some text (plain text, not a pattern).",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "The job's id." },
      lines: { type: "string", description: "How many lines: 50 by default, at most 400." },
      contains: { type: "string", description: "Only lines holding this text." },
    },
    required: ["id"],
  },
};

/** `job_stop`: stop one of your jobs and everything it started. */
export const JOB_STOP_TOOL: LiveToolSpec = {
  name: JobTool.Stop,
  description: "Stop one of your jobs, and everything it started.",
  parameters: {
    type: "object",
    properties: { id: { type: "string", description: "The job's id." } },
    required: ["id"],
  },
};

/** How a job stands, in the words its status line uses. */
const STATE_WORDS = {
  [JobState.Running]: "running",
  [JobState.Succeeded]: "finished",
  [JobState.Failed]: "failed",
  [JobState.Stopped]: "stopped",
  [JobState.TimedOut]: "stopped at its time limit",
  [JobState.Interrupted]: "stopped when Genex closed",
} as const satisfies Record<JobState, string>;

/** Why the registry would not start a job, by its refusal code. */
const REFUSED = {
  [JobRefusalCode.TooMany]: "The job did not start: this game already runs as many jobs as it may. Stop one first.",
  [JobRefusalCode.EmptyCommand]: "The job did not start: give it a command to run.",
  [JobRefusalCode.CommandTooLong]:
    "The job did not start: the command is too long. Put it in a script in your folder and run that.",
  [JobRefusalCode.BadProject]: "The job did not start: this game's name cannot hold jobs.",
} as const satisfies Record<JobRefusalCode, string>;

/** One job, as a status line reads it. */
export interface JobLine {
  id: string;
  title: string;
  state: JobState;
  exitCode?: number | null | undefined;
  minutes: number;
  worker?: string | undefined;
  stoppedBy?: JobStopper | undefined;
}

/** A job's status line: its id, title, how it stands (and who stopped it, when the person did) and for how long. */
function statusLine(job: JobLine): string {
  const exit = job.exitCode === undefined || job.exitCode === null ? "" : ` (exit ${job.exitCode})`;
  const by = job.worker ? ` · by ${job.worker}` : "";
  const byPerson = job.stoppedBy === JobStopper.Person ? " by the person" : "";
  const time = job.state === JobState.Running ? `for ${job.minutes} min` : `after ${job.minutes} min`;
  return `${job.id} · ${job.title}${by} · ${STATE_WORDS[job.state]}${byPerson}${exit} ${time}`;
}

/** What a job tool answers. */
export const JOB_ANSWER = {
  started: (id: string, title: string, cwd: string, command: string, hours: number) =>
    `Job ${id} (${title}) started in ${cwd}: ${command}. Check it with job_status or job_tail; it stops after ${hours} h unless it ends first.`,
  inPlan:
    "The chat is in Plan mode, so this did not start: jobs wait until the plan is approved. Put it in your plan instead.",
  declined:
    "The person did not allow this job, so it did not start. Do not retry it; say in your reply what you needed.",
  refused: (code: JobRefusalCode) => REFUSED[code],
  badFolder: (cwd: string) =>
    `The job did not start: ${cwd} is not a folder inside yours. Give a folder relative to yours, or leave cwd out.`,
  noChat: "The job did not start: this session has no chat to report it to.",
  unknown: (id: string) => `No job ${id || "(no id)"} here.`,
  none: "No jobs here yet.",
  status: (jobs: readonly JobLine[]) => jobs.map(statusLine).join("\n"),
  stopped: (job: JobLine) => `Stopped: ${statusLine(job)}`,
  tail: (text: string, partial: boolean) =>
    `${partial ? "(only the end of a long log was searched)\n" : ""}${text || "(no output yet)"}`,
} as const;
