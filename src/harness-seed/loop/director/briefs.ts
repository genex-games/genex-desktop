/**
 * What a web game's Loop lead reads: its brief (who it is, the goal, its time, where it builds, its
 * tools), the wrap-up, a resumed run's note and the words after an engine's limit. Mechanics only:
 * what the game is and how it looks, plays or is built are the user's and the lead's to decide.
 * Model-facing: the lead reads it as written.
 */
import { shortSha } from "../git.ts";
import { appIdentity } from "../project-prompts.ts";
import { minutes } from "../time.ts";
import { folderLabelOf } from "../workers/identity.ts";
import { WorkerTool } from "../workers/contract.ts";
import { DirectorTool } from "./tool-specs.ts";
import { type FactRef, ProjectTool } from "../folder-facts.ts";
import type { Run } from "../../types/harness.d.ts";

/** This part serves a lead that is its chat's own session (lead-session.ts `servesLead`). */
export const SERVES_LEAD = true;

/** The integration head's last health check, as the wrap-up says it (none before one). */
const HEALTH_WORDS: Readonly<Record<string, string>> = {
  true: ", it passed its last health check",
  false: ", it failed its last health check",
};

/** What the web lead's brief is made of. */
export interface DirectorBriefFacts {
  run: Run;
  softDeadline: number;
  finalDeadline: number;
  integrationWorktree: string;
  baseCommit: string | null;
  /** The game folder the chat's session sits in. */
  gameFolder: string;
  /** What the game's folder holds. */
  facts: readonly FactRef[] | null;
  /** A resumed run's words about where it stands, or null. */
  resume: string | null;
  /** The workspace's skills whose facts reach this project, by name: read on demand. */
  skills?: readonly string[];
}

/** What a lead is told of Genex's plugin search, by the tools' own names. */
const PLUGIN_SEARCH_LINE = `PLUGINS: Genex's plugin search: ${ProjectTool.PluginsFind}; ${ProjectTool.PluginsSuggest} shows the person its card.`;

/** The time paragraph: the hours are a cap, and finish ends the Loop whenever the goal is reached. */
function timeWords({
  softDeadline,
  finalDeadline,
}: Pick<DirectorBriefFacts, "softDeadline" | "finalDeadline">): string {
  const left = Math.max(0, minutes(softDeadline - Date.now()));
  const all = Math.max(0, minutes(finalDeadline - Date.now()));
  return `TIME: about ${left} working minutes (${all} in all). The time is a cap, not a quota: call finish when the goal is reached.`;
}

/** The lead's brief, Genex's identity first (a fresh session reads this brief alone). */
export function directorBrief(facts: DirectorBriefFacts): string {
  const { run, integrationWorktree, baseCommit, gameFolder, skills = [] } = facts;
  return [
    appIdentity({ folderLabel: folderLabelOf(gameFolder, run.project), facts: facts.facts ?? [] }),
    `YOU LEAD THIS LOOP. You are this chat's own session, leading a Loop on the game "${run.project}". Your cwd is the game folder the user sees (${gameFolder}). You build in the run's integration worktree (${integrationWorktree}), a git worktree of the game at ${shortSha(baseCommit ?? "")}, by its full path; commit there. Leave the game folder as the user left it: finish lands the integration branch there.`,
    `THE GOAL: ${run.goal}`,
    timeWords(facts),
    `WORKERS (optional): ${WorkerTool.Start} hands one task to a worker in the background, with the tools you have. A writer works in its own copy of the integration branch (isolation copy); ${WorkerTool.Mark} used merges its work into the integration worktree, and Genex runs one health check of the merged build (the page loads, no uncaught errors, the screenshot is not blank). A reader (isolation read) looks and writes nothing. ${WorkerTool.Wait}, ${WorkerTool.Status}, ${WorkerTool.Steer} and ${WorkerTool.Stop} reach them.`,
    `SECOND OPINION (optional): ${DirectorTool.Judge} hands pictures you name (or a screenshot of the integration build) and your question to a model that did none of the work. It decides nothing.`,
    PLUGIN_SEARCH_LINE,
    `FINISH: ${DirectorTool.Finish} with a summary. Genex runs the health check on the integration branch first and lands it in the game folder when it passes; when it fails you hear why and go on (or finish with land=no). ${DirectorTool.Show} offers a build to the user's Live view; ${DirectorTool.Note} leaves a card in the run's feed.`,
    ...(skills.length
      ? [`SKILLS: ${skills.join(", ")} — read one when it helps (they are in the harness's skills folder).`]
      : []),
    ...(facts.resume ? [facts.resume] : []),
  ].join("\n\n");
}

/** The wrap-up's message: the working time is over, and what is left to do. */
export function wrapUpPrompt({
  run,
  finalDeadline,
  integrationHead,
  integrationHealthy,
  running,
  userAsked = false,
}: {
  run: Run;
  finalDeadline: number;
  integrationHead: string | null;
  integrationHealthy: boolean | null;
  running: readonly string[];
  userAsked?: boolean;
}): string {
  const head = integrationHead ? shortSha(integrationHead) : "none";
  const health = HEALTH_WORDS[String(integrationHealthy)] ?? "";
  return [
    `Run ${run.runId}: ${userAsked ? "the user asked to finish" : "the working time is over"}; ${minutes(finalDeadline - Date.now())} minutes remain. Start no worker.`,
    running.length
      ? `Workers still running: ${running.join(", ")} — finish stops them; merge what you want to keep first.`
      : "",
    `Integration branch: ${head}${health}.`,
    "Call finish now with a summary of what was built and what remains (land=no to keep it unlanded).",
  ]
    .filter(Boolean)
    .join("\n");
}

/** What a resumed run's lead is told: where the integration branch stands. */
export function resumeNote({
  forkCommit,
  baseCommit,
  aheadOfBase,
}: {
  forkCommit: string | null;
  baseCommit: string | null;
  aheadOfBase: number;
}): string {
  const commits = `commit${aheadOfBase === 1 ? "" : "s"}`;
  const ahead = aheadOfBase
    ? ` — ${aheadOfBase} ${commits} beyond the starting point ${shortSha(baseCommit ?? "")}`
    : "";
  return `THE RUN RESUMES: the integration branch stands at ${shortSha(forkCommit ?? "")}${ahead}. Workers from before the pause no longer run; run_status lists the run.`;
}

/** What the lead's session is told after an engine limit it was made to wait out. */
export function limitResumePrompt(waitedMinutes: number): string {
  return `The engine's limit paused you for ${waitedMinutes} minutes; your workers kept running. Call run_status, then continue where you were.`;
}
