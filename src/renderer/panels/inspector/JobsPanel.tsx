/**
 * The card of the lead's background work: one row per job, newest first, with who started it,
 * where it is and how long it ran. Read-only: no command, id or log, and Stop stays on the job's
 * line in the chat.
 */
import type { JSX } from "react";
import { JobState } from "../../../shared/jobs.ts";
import type { JobInfo } from "../../run-graph-workers.ts";
import { jobStateWords, jobsTileStatus, leadNodeOf } from "../../run-tree.ts";
import { JOBS_WORDS } from "../../words.ts";
import { useNow } from "../run-graph/use-builds-model.ts";
import { Panel, Para } from "./chrome.tsx";
import { GraphSelection } from "./selection.ts";
import { Status } from "./tone.tsx";
import type { InspectorProps } from "./types.ts";

/** One job: its name, then who started it and where it is. */
function JobRow({ job, now }: { job: JobInfo; now: number }): JSX.Element {
  const who = job.who ? JOBS_WORDS.by(job.who) : JOBS_WORDS.byLead;
  return (
    <div data-job-row className="flex flex-col gap-0.5 border-t border-line py-2 first:border-t-0">
      <span className="text-chat-sub text-ink [overflow-wrap:anywhere]">{job.title}</span>
      <span className="text-body-sm text-ink-3">{`${who} · ${jobStateWords(job, now)}`}</span>
    </div>
  );
}

/** The background card, opened from the tile under the lead. */
export function JobsPanel(props: InspectorProps): JSX.Element {
  const jobs = leadNodeOf(props.graph)?.jobs ?? [];
  const now = useNow(jobs.some((job) => job.state === JobState.Running));
  const status = jobsTileStatus(jobs, now);
  return (
    <Panel
      id={GraphSelection.Jobs}
      label={JOBS_WORDS.title}
      title={JOBS_WORDS.title}
      status={<Status tone={status.tone}>{status.status}</Status>}
      onPrev={props.onPrev}
      onNext={props.onNext}
      onClose={props.onClose}
    >
      <Para quiet>{JOBS_WORDS.about}</Para>
      <div className="flex flex-col">
        {[...jobs].reverse().map((job) => (
          <JobRow key={job.jobId} job={job} now={now} />
        ))}
      </div>
    </Panel>
  );
}
