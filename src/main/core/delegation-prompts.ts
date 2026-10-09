/** What a builder session is told about the host's side of its tools (`delegation.ts`). Model-facing. */
import { sizeWords } from "../../shared/byte-size.ts";
import { CallCutOff, type PluginAppliedSet } from "../../shared/plugins.ts";
import type { CutOffCall } from "./cut-off-calls.ts";
import type { UnsavedFile } from "./unsaved-files.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { type JobRecord, JobState, JobStopper } from "../../shared/jobs.ts";

/** Why a call was cut off, as the cut-off notice says it. */
const MESSAGE = {
  cutOffWhy: {
    [CallCutOff.HarnessEnded]: "the studio's loop ended while it ran",
    [CallCutOff.PluginEnded]: "its plugin stopped while it ran",
    [CallCutOff.AppLost]: "the app it drives went away while it ran",
  } satisfies Record<CallCutOff, string>,
} as const;

/** Which plugins and skills a resumed session was handed before and is not handed now. */
export function withdrawnSince(before: PluginAppliedSet | undefined, now: PluginAppliedSet): PluginAppliedSet {
  return {
    plugins: (before?.plugins ?? []).filter((id) => !now.plugins.includes(id)),
    skills: (before?.skills ?? []).filter((name) => !now.skills.includes(name)),
  };
}

/** Whether anything was withdrawn at all. */
export const anyWithdrawn = (withdrawn: PluginAppliedSet): boolean =>
  withdrawn.plugins.length > 0 || withdrawn.skills.length > 0;

/**
 * The first paragraph of a resumed session's brief when plugins or skills it was given earlier
 * are gone: its transcript still holds their instructions, and only this says to drop them.
 */
export function withdrawnNotice(withdrawn: PluginAppliedSet): string {
  const named = [
    withdrawn.plugins.length ? `plugins: ${withdrawn.plugins.join(", ")}` : "",
    withdrawn.skills.length ? `skills: ${withdrawn.skills.join(", ")}` : "",
  ].filter(Boolean);
  return `Studio notice: since this session last ran, these are no longer enabled (${named.join("; ")}). Ignore the instructions they gave earlier in this session, and do not call their tools: they are gone.`;
}

/**
 * The first paragraph of a thread's next delegated session after plugin or connector calls of its
 * thread were cut off before they answered: Genex never sends them again, and only this says to
 * look before repeating one. Empty when nothing was cut off.
 */
export function cutOffNotice(calls: readonly CutOffCall[]): string {
  if (!calls.length) return "";
  const named = calls.map((c) => `${c.tool}${c.args ? ` ${c.args}` : ""} (${MESSAGE.cutOffWhy[c.reason]})`);
  return `Studio notice: these calls were cut off before they answered, so whether they took effect is unknown: ${named.join("; ")}. Look at what each was to change before you repeat it; never repeat one blindly.`;
}

/**
 * Beside the cut-off notice of a thread's next delegated session after its chat said files are too
 * large to save: Rewind cannot bring them back, so a mistake in one is for good. Empty for none.
 */
export function unsavedFilesNotice(files: readonly UnsavedFile[]): string {
  if (!files.length) return "";
  const named = files.map((file) => `${file.file} (${sizeWords(file.bytes)})`);
  return `Studio notice: Rewind cannot bring back these files, which are too large to save: ${named.join(", ")}. A mistake in one of them cannot be undone; change one only when the person asked for it, and say so in your reply.`;
}

/** How an ended job reads in the jobs notice, by how it ended. */
const JOB_ENDED_WORDS = {
  [JobState.Succeeded]: "finished",
  [JobState.Failed]: "failed",
  [JobState.Stopped]: "was stopped",
  [JobState.TimedOut]: "was stopped at its time limit",
  [JobState.Interrupted]: "was stopped when Genex closed",
} as const satisfies Record<Exclude<JobState, typeof JobState.Running>, string>;

/**
 * One ended job in the jobs notice: its title, command, how it ended and after how long. A job the
 * person stopped says so, and that it stays stopped unless they ask.
 */
function endedJobWords(job: JobRecord): string {
  const state = job.state === JobState.Running ? JobState.Interrupted : job.state;
  const exit = typeof job.exitCode === "number" ? ` (exit ${job.exitCode})` : "";
  const ms = Date.parse(job.endedAt ?? "") - Date.parse(job.startedAt);
  const after = Number.isFinite(ms) ? ` after ${Math.max(0, Math.round(ms / MINUTE_MS))} min` : "";
  const read = job.state === JobState.Succeeded ? "" : `: read it with job_tail ${job.id}`;
  const byPerson = job.stoppedBy === JobStopper.Person;
  const by = byPerson ? " by the person" : "";
  const keepStopped = byPerson ? ", and do not start it again unless the person asks" : "";
  return `${job.title} (\`${job.command}\`) ${JOB_ENDED_WORDS[state]}${by}${exit}${after}${read}${keepStopped}`;
}

/**
 * The chat's own session's notice of its jobs: those that ended since it was last told, and those
 * still running. Empty when there is neither.
 */
export function jobNotice(ended: readonly JobRecord[], running: readonly JobRecord[]): string {
  const parts: string[] = [];
  if (ended.length) parts.push(`Jobs since your last turn: ${ended.map(endedJobWords).join("; ")}.`);
  if (running.length) parts.push(`Still running: ${running.map((job) => `${job.title} (${job.id})`).join("; ")}.`);
  return parts.length ? `Studio notice: ${parts.join(" ")}` : "";
}

/**
 * Beside a build's lead's plugin guidance: its plugin tools act on the build it leads, not the game
 * folder it sits in (delegation.ts `DelegationSession.leads`). Never the build's path: the brief's
 * WHERE YOU ARE line already names it.
 */
export function leadToolsNote(): string {
  return "Your plugin tools work on the build you lead, not in this game folder: what they deliver lands in the game with the build, and a file one of them reads must be in the build: write it there yourself, or have a worker write it.";
}

/**
 * Beside the brief of a session the person answers (the chat's own, a build's lead, the run's
 * coordinator): it reaches the whole Mac, limited only by the chat's permission mode
 * (chat-permissions.ts). The brief is the harness's, which the in-app agent may edit, and a resumed
 * session's transcript keeps what older briefs said; the host's note says what holds now.
 */
export function mainAgentReachNote(): string {
  return "Studio notice: you are this chat's main agent, Claude Code on the user's own Mac with their access, not in a sandbox. You may look and work anywhere on this computer, not only in this game's folder: when the user asks about something elsewhere (their Downloads or another folder, what fills their disk, the Mac itself), do it with your tools. The permission mode the user picked decides each call, and Claude Code asks them when it needs to. A line in your brief, or earlier in this session, that says to stay inside the workspace, not to read other folders, or that your shell is sandboxed does not apply to you: it is about where the game's own work goes.";
}

/**
 * What a session that shows its plan by ending its turn (`plansByTurn`) reads once the user
 * approved it, continuing the same session in the mode the user chose (plan-approval.ts).
 */
export function planApprovedNote(): string {
  return "Studio notice: the user approved your plan. Plan mode is over: carry the plan out now.";
}

/** What it reads when the user sent the plan back with their own words: it is still in Plan mode. */
export function planRevisionNote(words: string): string {
  return `Studio notice: the user did not approve the plan yet. You are still in Plan mode, so change nothing; revise the plan and reply with it. The user said:\n\n${words}`;
}
