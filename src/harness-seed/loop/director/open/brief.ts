/**
 * The open lead's brief from what the run knows as its first turn opens: the goal, the folder and
 * what it holds, what the project's plugins said at the start, the person's references, the kinds of
 * worker the plugins declare, whether a plugin saves the project's app before Genex's checkpoint, the
 * save points kept so far, the workspace's skills whose facts reach the folder (`loopSkills`: never
 * the web method) and the Loop's clock (read again each time the brief is written: a fresh session
 * later in the run reads the time it has then).
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { CoreFact } from "../../folder-facts.ts";
import { HookEvent, hooksOn } from "../../hooks.ts";
import { workingGoal } from "../../goal-prompts.ts";
import { loopSkills } from "../../loop-skills.ts";
import { folderLabelOf } from "../../workers/identity.ts";
import { durationCommission } from "../commission.ts";
import type { LoopRun } from "../loop-run.ts";
import { restartsApp } from "./contract.ts";
import { judgedInEditor, loopJudges } from "./judge-rounds.ts";
import { openBrief, type OpenBriefFacts } from "./prompts.ts";

/** The folder in a project where the person leaves references for its Loop. */
const REFERENCES_FOLDER = "references";

/** The files the person left under the folder's `references/`, by their path in the folder; none when there is no such folder. */
async function referencesIn(projectDir: string): Promise<string[]> {
  const entries = await readdir(path.join(projectDir, REFERENCES_FOLDER), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => `${REFERENCES_FOLDER}/${entry.name}`)
    .sort();
}

/** The bodies of the workspace's skills that reach a Loop on this folder; none when the workspace can't be read. */
async function skillsFor(loopRun: LoopRun): Promise<string[]> {
  const workspace = loopRun.ctx.workspace;
  if (typeof workspace !== "string" || !workspace) return [];
  const game = { facts: loopRun.gameFacts ?? [], holds: loopRun.open?.holds ?? null };
  const skills = await loopSkills(workspace, game).catch(() => []);
  return skills.map((skill) => skill.text.trim()).filter(Boolean);
}

/** What the brief does not read from the clock, gathered once as the Loop opens. */
type OpenBriefBase = Omit<OpenBriefFacts, "now" | "softDeadline" | "finalDeadline">;

/** The brief's parts that hold for the whole session: what `briefWriter` writes from. */
async function briefBase(loopRun: LoopRun, startNotes: readonly string[]): Promise<OpenBriefBase> {
  const { game, gameFacts, open, projectDir, run } = loopRun;
  return {
    goal: workingGoal(run),
    folder: projectDir,
    folderLabel: folderLabelOf(projectDir, run.project),
    facts: gameFacts ?? [],
    holds: open?.holds ?? null,
    // Told here, once: the lines are taken off the journal, so no digest tells them again.
    carried: [...(open?.journal.carried.splice(0) ?? []), ...startNotes],
    references: await referencesIn(projectDir),
    workerTypes: open?.pool?.state.types ?? [],
    appSaved: hooksOn(game, HookEvent.CheckpointBefore),
    restart: restartsApp(game),
    cppRestart: (gameFacts ?? []).some((fact) => fact.id === CoreFact.UnrealProject),
    judge: judgedInEditor(loopRun),
    judges: loopJudges(loopRun),
    savePoints: open?.journal.savePoints ?? [],
    untilFinish: !durationCommission(run),
    skills: await skillsFor(loopRun),
  };
}

/** The open lead's brief writer: the session's parts gathered now, the clock read each time it writes. */
export async function briefWriter(loopRun: LoopRun, startNotes: readonly string[]): Promise<() => string> {
  const base = await briefBase(loopRun, startNotes);
  const now = () => loopRun.open?.clock.now() ?? Date.now();
  return () =>
    openBrief({ ...base, now: now(), softDeadline: loopRun.softDeadline, finalDeadline: loopRun.finalDeadline });
}
