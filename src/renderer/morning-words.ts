/**
 * The morning card's copy, as a pure function.
 *
 * The card itself is React, so nothing in a test can reach it; every sentence and every button it
 * offers is decided here instead, from the facts the log carries. The four paths a run can end
 * on — landed, kept but not made live, paused, stopped by the owner — are the four the user meets,
 * and the one thing they must never disagree about is the card's own buttons: a run the card
 * says is "Finished" must not be one whose Resume is the only thing that saves it, and a sentence
 * that promises a playable build must not appear over a card with no Play on it.
 */
import { loopRunWords, withoutIds } from "./words.ts";

export interface MorningLoopRun {
  /** rounds a judge saw */
  rounds: number;
  kept: number;
  undone: number;
  landed: boolean | null;
  /** the run stopped where Resume can pick it up: a plan limit, a quit, a crash */
  paused: boolean;
  /** the provider failure that paused it (the close's `limit.kind`), when one did */
  pausedOn?: string | null;
  /** there is a merged build to play or make live — the same fact the buttons are gated on */
  hasBuild: boolean;
  stoppedBecause?: string | null;
  /** the run's own report to the user; a run that ended before writing one has none */
  summary?: string | null;
  /** the plain sentence the close writes about landing, when the run wrote one */
  landingLine?: string | null;
  /** what the studio's own ledger made of the run (loop/ledger.ts), when it had something to say */
  learned?: string | null;
}

/** The card's buttons, in the order they are shown; the first is the primary one. */
export const MorningAction = {
  /** pick a paused run up where it left off */
  Resume: "resume",
  /** put the live game (the landed build) on the stage */
  Play: "play",
  /** load this run's merged build from a copy */
  PlayBuild: "play-build",
} as const;
export type MorningAction = (typeof MorningAction)[keyof typeof MorningAction];

export interface MorningWords {
  headline: string;
  /** "10 kept · 11 undone" — empty when no round was judged */
  tally: string;
  because: string;
  summary: string | null;
  /** what stands in the report's place when the run never wrote one */
  noReport: string | null;
  /** one line the studio learned about this game this run, or null when it learned nothing worth a line */
  learned: string | null;
  actions: MorningAction[];
}

function actionsFor(loopRun: MorningLoopRun): MorningAction[] {
  const build: MorningAction[] = loopRun.hasBuild ? [MorningAction.PlayBuild] : [];
  if (loopRun.paused) return [MorningAction.Resume, ...build];
  if (loopRun.landed === false) return build;
  return [MorningAction.Play];
}

export function morningWords(loopRun: MorningLoopRun): MorningWords {
  const words = loopRunWords({
    rounds: loopRun.rounds,
    landed: loopRun.landed,
    stoppedBecause: loopRun.stoppedBecause ?? null,
    paused: loopRun.paused,
    pausedOn: loopRun.pausedOn ?? null,
    hasBuild: loopRun.hasBuild,
    // A landed run's close says how it landed and whether anything checked it — the one detail
    // the user cannot see for themselves. The sentence itself is words.ts's, so the card, the run
    // pill and the Builds drawer cannot say it three ways.
    landing: loopRun.landingLine ?? null,
  });
  const summary = (loopRun.summary ?? "").trim();
  const learned = (loopRun.learned ?? "").trim();
  const kept = Math.max(0, Math.trunc(loopRun.kept || 0));
  const undone = Math.max(0, Math.trunc(loopRun.undone || 0));
  return {
    headline: words.headline,
    tally: kept + undone > 0 ? `${kept} kept · ${undone} undone` : "",
    because: words.because,
    summary: summary || null,
    noReport: summary ? null : noReportWords(loopRun.paused),
    // The studio's own sentence about the run, which the harness composes from its ledger of
    // outcomes. It arrives plain, but it arrives from the harness, so it goes through the same
    // scrub every other harness sentence does before it reaches a person.
    learned: learned ? withoutIds(learned) : null,
    actions: actionsFor(loopRun),
  };
}

/** Why a run has no report of its own. */
function noReportWords(paused: boolean): string {
  return paused ? "It was paused before it could write up the build." : "It ended before it could write up the build.";
}
