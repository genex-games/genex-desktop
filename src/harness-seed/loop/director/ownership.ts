/**
 * One owner per file, said at planning. Gen3's yard spent three rounds on window glass and fog the
 * light part owned; a plan that hands one path to two parts is told so before anybody builds (a
 * warning, not a refusal: a merge conflict is still settled by its worker).
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import type { PlanPart } from "./rules.ts";

/** A path a part owns, as the overlap check reads it: posix, no leading "./", no trailing "/". */
const ownedPath = (entry: string): string => entry.trim().replace(/^\.\//, "").replace(/\/+$/, "");

/** Does owning `a` hold `b` too: the same path, or a folder `b` lies in? */
const holds = (a: string, b: string): boolean => a === b || b.startsWith(`${a}/`);

/** What the plan's answer says when two parts own one path (`sharedOwnership`), or "" when none do. */
export function sharedOwnershipNote(parts: readonly PlanPart[]): string {
  const shared = sharedOwnership(parts);
  if (!shared) return "";
  return `Ownership: ${shared.a} and ${shared.b} both own ${shared.path}. A part's mandatory work should never wait on files another part holds: give each file one owner before their worker_start (owns=), or expect merge conflicts.`;
}

/**
 * The first path two parts both own, or null. Gen3's yard spent three rounds on window glass and
 * fog the light part owned: a plan that hands one file to two parts is refused before anybody builds.
 */
export function sharedOwnership(parts: readonly PlanPart[]): { a: string; b: string; path: string } | null {
  for (const [i, part] of parts.entries()) {
    for (const other of parts.slice(i + 1)) {
      for (const mine of part.owns.map(String).map(ownedPath).filter(Boolean)) {
        const theirs = other.owns
          .map(String)
          .map(ownedPath)
          .find((path) => holds(mine, path) || holds(path, mine));
        if (theirs) return { a: part.id, b: other.id, path: mine.length <= theirs.length ? theirs : mine };
      }
    }
  }
  return null;
}
