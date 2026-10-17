/**
 * What a Loop lead and a chat's model read of the judges a game's engine plugin declares: the
 * `judge` argument of `judge_play`, a judge's round after a save point, and the answers it brings.
 */
import type { JudgeRef } from "../types/host-api.d.ts";

/** The judges as the model reads them: each by its id, with its label. */
const listed = (judges: readonly JudgeRef[]): string =>
  judges.map((judge) => `${judge.id} (${judge.label})`).join(", ");

/** What a lead and a chat's model are told of a judge, and what a round says. */
export const ENGINE_JUDGE_WORDS = {
  /** `judge_play`'s `judge` for a Loop lead, with the game's judges listed. */
  leadArg: (judges: readonly JudgeRef[]) =>
    `Optional: which of this game's judges plays, by id: ${listed(judges)}. Each plays with its own brief and players. Leave it out for a plain judge.`,
  /** `judge_play`'s `judge` for a direct model's chat, which cannot list the game's judges up front. */
  chatArg:
    "Optional: which of the game's own judges plays, by id, when its engine plugin declares judges; leave it out for a plain judge. An id the game doesn't have is answered with the ones it has. Whether a judge plays at all is yours to decide: a change that touches what a judge tests is a hint, not a rule.",
  /** The lead's brief, beside `judge_play`, when the game has judges. */
  briefRounds: (judges: readonly JudgeRef[]) =>
    `After each turn that keeps a save point, Genex has the game's judges play it, one at a time: ${listed(judges)}. Their answers open your next turn.`,
  unknownJudge: (id: string, judges: readonly JudgeRef[]) =>
    judges.length
      ? `No judge named "${id}" plays this game. Its judges: ${listed(judges)}.`
      : `This game has no judges of its own: leave judge out and a plain judge plays it.`,
  /** The one yes/no question a judge's round asks, with the save point it plays. */
  roundAsk: (judge: JudgeRef, point: { label: string; summary: string }) =>
    `${judge.label} judge, save point "${point.label}"${point.summary ? ` (${point.summary})` : ""}: playing as your brief asks, does the game hold up, with nothing broken?`,
  /** One judge's answer, as the lead's next turn opens with it. */
  played: (judge: JudgeRef, label: string, answer: string) =>
    `The ${judge.label} judge played save point "${label}": ${answer}`,
  /** Why no judge played the save point: too little of the Loop's working time is left, or a finish was asked for. */
  noTime: (label: string) =>
    `No judge played save point "${label}": the Loop's working time is nearly over, so its time goes to wrapping up.`,
  /** Why the round stopped before a judge played: the Loop is stopping or held. */
  cut: (label: string, unplayed: readonly JudgeRef[]) =>
    `The judges' round after save point "${label}" stopped before ${unplayed.map((judge) => `the ${judge.label} judge`).join(" and ")} played: the Loop is stopping.`,
  /** Why the round stopped before a judge played: the Loop's working time ran out during the round. */
  timeUp: (label: string, unplayed: readonly JudgeRef[]) =>
    `The judges' round after save point "${label}" stopped before ${unplayed.map((judge) => `the ${judge.label} judge`).join(" and ")} played: the Loop's working time is over.`,
} as const;
