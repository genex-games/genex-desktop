/**
 * What a Loop lead and a chat's model read of the judges a game's engine plugin declares: the
 * `judge` argument of `judge_play` and the answers it brings.
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
    `This game's judges: ${listed(judges)}. None plays unless you ask one with judge_play, for a second opinion that decides nothing.`,
  unknownJudge: (id: string, judges: readonly JudgeRef[]) =>
    judges.length
      ? `No judge named "${id}" plays this game. Its judges: ${listed(judges)}.`
      : `This game has no judges of its own: leave judge out and a plain judge plays it.`,
} as const;
