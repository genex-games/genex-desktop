/**
 * What the full journal (journal.ts) says to the lead when a run resumes: the heading of its
 * first digest, the paragraph that digest ends on, the workers from before the pause in the words
 * a digest line gives them (and the one line later digests give them all), and why `worker_start`
 * will not give one of their ids to a new worker. Plain facts in, text out. A finished build reopened
 * speaks of its workers in words of its own (`PriorEra`, director/reopen-prompts.ts).
 */
import { shortSha } from "../git.ts";
import { WorkerState } from "../outcomes.ts";
import { clip } from "../text.ts";
import { LEAD_PRIOR_BRINGS_IN } from "./lead-session-prompts.ts";

/**
 * This part serves a lead that is its chat's own session and writes nothing (one session): a run
 * seats one only when every part it depends on says so (lead-session.ts `servesLead`).
 */
export const SERVES_LEAD = true;

/** How much of a worker-from-before's brief its digest line quotes. */
const PRIOR_BRIEF_CHARS = 160;
/** The one line a later digest gives the workers from before the pause names at most this many. */
const PRIOR_IDS_NAMED = 8;

/** A clock time as the digest says it. */
const utc = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

/** How the workers of the run before are spoken of: their state then, and the line that names them. */
export interface PriorEra {
  /** A worker that was building when that run ended. */
  running: string;
  /** After another state, and after "ran": "before the pause". */
  state: string;
  /** Before their ids, in the one line later digests give them. */
  from: string;
}

/** The run before paused (a Resume): the default. */
const PAUSE_ERA: PriorEra = {
  running: "stopped when the run paused",
  state: "before the pause",
  from: "from before the pause",
};

/** The heading of a resumed run's first digest, in place of "WOKEN AT". */
export function resumedHeading(now: number): string {
  return `RESUMED AT ${utc(now)} — this run paused and picks up where it stood. Its workers from before the pause are not running; what they committed is kept.`;
}

/** The paragraph a resumed run's first digest ends on, while it has working time. */
export function resumeClosing(): string {
  return "Decide what the rest of the run needs — start a worker again (from=<commit> builds on one from before), bring in what is ready, or finish — then end your turn; the studio wakes you when something happens.";
}

/** A worker from before the pause (or of `era`): its state then, as its digest line says it. */
export function priorWorkerState(state: string, era: PriorEra = PAUSE_ERA): string {
  return state === WorkerState.Running ? era.running : `${state} ${era.state}`;
}

/**
 * A worker from before the pause: what it committed, and how to go on from it — for a lead that
 * writes nothing (`lead`), through a worker started from it; for a director with its own hands,
 * also by merging it in its worktree.
 */
export function priorCommitWords({
  lastCommit,
  from,
  ref,
  lead = false,
}: {
  lastCommit: string | null;
  from: string | null;
  ref: string;
  lead?: boolean;
}): string {
  if (!lastCommit || lastCommit === from) return "it left no commit of its own";
  const bringIn = lead ? LEAD_PRIOR_BRINGS_IN : `\`git merge ${lastCommit}\` in your worktree brings it in`;
  return `its last commit ${shortSha(lastCommit)} is kept on ${ref} — worker_start from=${lastCommit} builds on it, ${bringIn}`;
}

/** What a worker from before the pause left, and how to go on from it (`lead`: see `priorCommitWords`). */
export function priorWorkerLeft(worker: {
  lastCommit: string | null;
  from: string | null;
  ref: string;
  owns: readonly string[];
  brief: string;
  lead?: boolean;
}): string {
  const { owns, brief } = worker;
  return [
    priorCommitWords(worker),
    owns.length ? `owned ${owns.join(", ")}` : "",
    brief ? `brief: ${clip(brief, PRIOR_BRIEF_CHARS)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The workers from before the pause (or of `era`), in the one line every digest after a resumed run's first gives them. */
export function priorWorkersLine(ids: readonly string[], era: PriorEra = PAUSE_ERA): string {
  const more = ids.length > PRIOR_IDS_NAMED ? ` and ${ids.length - PRIOR_IDS_NAMED} more` : "";
  return `- ${era.from}, not running: ${ids.slice(0, PRIOR_IDS_NAMED).join(", ")}${more} — worker_status <id> has what each left and how to build on it`;
}

/** Why `worker_start` will not give a new worker the id of one from before the pause (or of `era`) that left work. */
export function priorIdTaken({
  id,
  lastCommit,
  ref,
  era = PAUSE_ERA,
}: {
  id: string;
  lastCommit: string;
  ref: string;
  era?: PriorEra;
}): string {
  return `worker "${id}" ran ${era.state} and its work is kept on ${ref} — a new "${id}" would move that ref off it. Start it with from=${lastCommit} to build on that work, or pick another id.`;
}
