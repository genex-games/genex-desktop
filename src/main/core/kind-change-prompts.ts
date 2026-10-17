/** What Genex tells a session about a tool that changes what its project is (`kind-change.ts`). Model-facing text. */
import type { FactRef } from "../../shared/project-facts.ts";

/** The root of a game, as a fact's path spells it. */
const ROOT = ".";

/** The facts in words: each id and where it is. */
function factsWords(facts: readonly FactRef[]): string {
  if (facts.length === 0) return "no kind yet";
  return facts
    .map((fact) => (fact.path === ROOT ? `${fact.id} at its root` : `${fact.id} in ${fact.path}/`))
    .join(", ");
}

/** What a kind-changing call answers, and the snapshot it takes first. */
export const KIND_CHANGE_MESSAGE = {
  runGoing: (tool: string) =>
    `${tool} changes what this project is, and a run of this game is going, so it did not run: it would change the project under the run. Wait until the run ends, or tell the person to stop it first.`,
  snapshotReason: (tool: string) => `before ${tool} changed what the project is`,
  changed: (facts: readonly FactRef[]) =>
    `The project now holds ${factsWords(facts)}. End your reply now: Genex continues this session with the tools for it.`,
} as const;
