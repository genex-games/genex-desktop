/**
 * Whether a board entry is a question this build can be asked.
 *
 * A harness-owned check the build cannot answer because it does not report what the check names
 * under `needs` (loop/harness-needs.ts) is not this build's question: it is in none of the card's
 * counts, in no list of unmeasured checks and in no list of results. One predicate decides that for
 * every reader that holds the spec — the summary, the round's record, the builder's prompt and
 * brief, and the board the lead reads — so a record's results agree with its own totals and no
 * builder is asked to expose what the check does not need. A board rendered without its spec
 * (an integration board, a worker's status) still lists every entry.
 *
 * Its own module so an upgraded checks.ts or facet/phases/publish.ts never asks a kept, older
 * harness-needs.ts for a name it does not have.
 */
import { notThisBuildsQuestion } from "./harness-needs.ts";

/** A board entry as far as this module reads it. */
interface EntryOf {
  id?: unknown;
  pass?: unknown;
  unavailable?: unknown;
  missing?: unknown;
}

/** A spec as far as this module reads it. */
interface SpecOf {
  checks?: readonly ({ id?: unknown; origin?: unknown; needs?: unknown } | null | undefined)[];
}

/**
 * True unless the entry measured nothing, the build could not answer it, and the spec's check is a
 * harness check whose `needs` cover everything the build was missing. A measured entry always
 * applies; so does any entry of a check the plan, the director or a judge wrote.
 */
export function appliesToBuild(entry: EntryOf | null | undefined, spec: SpecOf | null | undefined): boolean {
  if (!entry) return false;
  const measured = entry.pass === true || entry.pass === false;
  if (measured || entry.unavailable !== true) return true;
  const check = (spec?.checks ?? []).find((c) => c?.id === entry.id);
  return !notThisBuildsQuestion(check, entry.missing);
}
