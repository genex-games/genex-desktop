/** What the classic run's builder is told each iteration: the first playable, a gap to close, a failure to recover from, or the last stretch. */
import { HOUR_MS } from "./time.ts";
import { ReferenceKind } from "./run-events.ts";
import type { Run } from "../types/harness.d.ts";

/** Which brief an iteration gets (`briefPhase` in gauntlet.ts picks it). */
export const BriefPhase = {
  First: "first",
  Integrate: "integrate",
  Gap: "gap",
} as const;
export type BriefPhase = (typeof BriefPhase)[keyof typeof BriefPhase];

/** The run fields a brief reads. */
type BriefRun = Pick<Run, "runId" | "reference" | "goal" | "budgets" | "project">;

/** What a classic iteration's brief is built from. */
export interface BriefInput {
  run: BriefRun;
  iteration: number;
  biggestGap: string;
  phase: string;
  lastFailure?: string | null;
  gapHistory?: Array<{ iteration: number; gap: string }>;
  acceptedShots?: string[];
}

/** The line every brief ends on: a build nobody can judge is a loss. */
const JUDGEABLE = [
  `When you are done, make sure the game still loads and window.__studio still works —`,
  `a build that cannot be judged counts as a loss.`,
];

/** The builder's brief for one iteration of the classic run. */
export function buildBrief({
  run,
  iteration,
  biggestGap,
  phase,
  lastFailure = null,
  gapHistory = [],
  acceptedShots = [],
}: BriefInput): string {
  if (phase === BriefPhase.First) return firstPlayableBrief(run);
  if (phase === BriefPhase.Integrate) return integrationBrief(run, iteration, biggestGap);
  // A mechanical failure is quoted as exactly that — the previous attempt never reached the
  // blind judge, so there is no design gap in the error string to "close".
  if (lastFailure) return failureBrief(run, iteration, biggestGap, lastFailure);
  return gapBrief(run, iteration, biggestGap, gapHistory, acceptedShots);
}

/** The bar the run is held to: a direction's feeling, or a named reference and its notes. */
function barLine(run: BriefRun): string {
  if (run.reference?.kind === ReferenceKind.Direction) return `DIRECTION (feeling): ${run.reference?.name ?? run.goal}`;
  const notes = run.reference?.notes ? ` — ${run.reference.notes}` : "";
  return `QUALITY BAR: ${run.reference?.name ?? "unnamed reference"}${notes}`;
}

/** How much the first playable should reach for, by the length of the run. */
function ambitionFor(run: BriefRun): string {
  const hours = (run.budgets?.wallClockMs ?? 0) / HOUR_MS;
  if (hours >= 8) return "This is a long run: a world with a readable fantasy, not a mechanic demo.";
  if (hours >= 4) return "A complete loop plus a visual identity.";
  return "One verb and one look, pushed as far as the clock allows.";
}

/** The goal, the project and the bar: the head every brief shares. */
function briefHead(run: BriefRun): string[] {
  return [`GOAL: ${run.goal}`, `PROJECT: ${run.project}`, barLine(run)];
}

function firstPlayableBrief(run: BriefRun): string {
  return [
    `You are in an unattended run (${run.runId}), iteration 1 — the first playable.`,
    ``,
    ...briefHead(run),
    ambitionFor(run),
    ``,
    `Build the first playable version. Architecture is yours. It must load, expose window.__studio,`,
    `and look like a game from the default camera toward that feeling/bar — AAA/photoreal if that is`,
    `what was asked. A cube on a plane is not a game.`,
    `Sample input in update() from ctx.keys / ctx.look so the critic can drive WASD while paused.`,
    ...JUDGEABLE,
  ].join("\n");
}

function integrationBrief(run: BriefRun, iteration: number, biggestGap: string): string {
  return [
    `You are in an unattended run (${run.runId}), iteration ${iteration} — integration pass.`,
    ``,
    ...briefHead(run),
    ``,
    `The clock is in its last stretch. Do not add systems. Glue what exists: visual consistency,`,
    `leftover feel, the camera, the one verb. The last blind gap was:`,
    biggestGap,
    ``,
    `When you are done, make sure the game still loads and window.__studio still works.`,
  ].join("\n");
}

function failureBrief(run: BriefRun, iteration: number, biggestGap: string, lastFailure: string): string {
  return [
    `You are in an unattended run (${run.runId}), iteration ${iteration}.`,
    ``,
    ...briefHead(run),
    ``,
    `The previous attempt never reached the blind judge — it failed before quality was in question:`,
    `"${lastFailure}"`,
    ``,
    `That is a failure report, not a design verdict. Deliver a build that loads and keeps`,
    `window.__studio working, and continue toward the goal. The last real blind gap was:`,
    biggestGap,
    ``,
    ...JUDGEABLE,
  ].join("\n");
}

function gapBrief(
  run: BriefRun,
  iteration: number,
  biggestGap: string,
  gapHistory: Array<{ iteration: number; gap: string }>,
  acceptedShots: string[],
): string {
  return [
    `You are in an unattended run (${run.runId}), iteration ${iteration}.`,
    ``,
    ...briefHead(run),
    ``,
    `THE SINGLE BIGGEST REMAINING GAP (from the last blind comparison):`,
    biggestGap,
    ...earlierGaps(gapHistory),
    ...acceptedShotLines(acceptedShots),
    ``,
    `Close that one gap. Prefer a change the default camera can see. Visuals decide most rounds;`,
    `a prettier build that feels worse will be rolled back. Do not start unrelated work.`,
    ...JUDGEABLE,
  ].join("\n");
}

/** The gaps before the last one, newest first, so a builder does not swing back and forth. */
function earlierGaps(gapHistory: Array<{ iteration: number; gap: string }>): string[] {
  if (gapHistory.length <= 1) return [];
  return [
    ``,
    `EARLIER GAPS (newest first — do not undo what fixing them achieved; if these swing between`,
    `opposite extremes, make a smaller, targeted correction, not another swing):`,
    ...gapHistory.slice(1).map((entry) => `- iteration ${entry.iteration}: ${entry.gap}`),
  ];
}

/** The accepted build's screenshots, for the builder to look at before it codes. */
function acceptedShotLines(acceptedShots: string[]): string[] {
  if (!acceptedShots.length) return [];
  return [
    ``,
    `LOOK AT the current accepted build's screenshots before you code (Read these image files):`,
    ...acceptedShots.map((p) => `- ${p}`),
    `Compare them with the reference stills in references/ — close the gap you can SEE.`,
  ];
}
