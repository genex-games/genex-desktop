/**
 * Where a facet's look builds the game's Windows and Linux destinations (evidence.ts
 * `crossBuilds`). A new module, so a kept older phase or state never hides it from another.
 */
import { FacetRole } from "./state.ts";

/**
 * Does this facet's look build the game's Windows and Linux destinations: the integration's and
 * a facet on the game's own folder do; a worker's copy never does, or each copy keeps cross
 * builds of its own (the Bodycam rerun's four workers filled 70 GB in two hours).
 */
export function buildsCrossDestinations({ role, worktree }: { role: string; worktree: string | null }): boolean {
  return role === FacetRole.Integration || worktree === null;
}
