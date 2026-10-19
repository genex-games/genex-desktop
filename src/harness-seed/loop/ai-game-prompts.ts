/**
 * The line a builder's brief carries when its game calls a model in play (`ai-game.ts`): where the
 * AI method is, and whether the game may run without an answer.
 */
import { AiRequirement } from "./ai-contract.ts";
import { aiRequirementOf } from "./kinds.ts";

/** Where a delegated builder finds the AI method, beside its brief. */
export const AI_METHOD_FILE_PATH = ".studio/AI.md";

/** What each requirement asks of the game when no answer comes. */
const WITHOUT_AI: Record<AiRequirement, string> = {
  [AiRequirement.Ai]:
    'it cannot run without AI (requires: "ai"): with no answer, Studio pauses it behind the "needs AI" state',
  [AiRequirement.Optional]: 'it plays on without AI (requires: "optional"): every call has a fallback',
};

/** The brief's line for a game that calls a model in play. */
export const aiBriefWords = (requirement: AiRequirement): string =>
  `AI: this game calls a model while it is played, through genex-ai only — ${WITHOUT_AI[requirement]}. Follow ${AI_METHOD_FILE_PATH} for every AI call: a site, a bounded schema, player text in untrusted, answers only through ai.drain() in update(), a clamping applier, a recorded tape per AI demo.`;

/** The brief's line for a game: where the AI method is, or "" for a game that declares no AI (by its typed word only). */
export function aiBriefLine(game: { ai?: unknown } | null | undefined): string {
  const requirement = aiRequirementOf(game?.ai);
  return requirement ? aiBriefWords(requirement) : "";
}
