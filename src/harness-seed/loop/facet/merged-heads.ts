/**
 * The integration commits a worker's worktree holds, and what they changed in its own files. A
 * worker told to merge a lead's fix may merge a head that integration has since moved past; a
 * review that diffs against an older merge reads the lead's fix as the worker's own edit and
 * reverts it.
 *
 * A new module on purpose: a workspace that kept an older review.ts or gate.ts still loads, because
 * only updated callers import from here.
 */
import { GIT } from "../git.ts";
import { isCommit } from "../shell.ts";

/** How far back along the integration line a review looks for the newest commit its worktree holds. */
const INTEGRATION_LINE_MAX = 40;
/** A template game's entry, when its shape names none: the module every part's wiring line lands in. */
const TEMPLATE_ENTRY = "src/main.js";

/** One git command line in the worktree, answering its stdout. */
type Git = (command: string) => Promise<string>;

/** The commits of a command's answer, one per line; anything else on a line is dropped. */
const commitsOf = (out: unknown): string[] =>
  String(out ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(isCommit);

/**
 * The integration line a worktree may have merged beyond its incumbent, newest first: the
 * first-parent history from the newest integration head anybody knows back to what the incumbent
 * already holds. A builder may merge any of them — the head its note named, the head the lead told
 * it to merge, or one in between — so the review's base is the newest of them its HEAD contains.
 * Empty when either end is not a commit or git refuses.
 */
export async function integrationLine(
  git: Git,
  { from, incumbent }: { from: unknown; incumbent: unknown },
): Promise<string[]> {
  if (!isCommit(from) || !isCommit(incumbent) || from === incumbent) return [];
  return commitsOf(await git(GIT.firstParentLine(from, incumbent, INTEGRATION_LINE_MAX)));
}

/**
 * The files of this part's own seam that a merge just changed: nobody but the lead (or a merge
 * worker it started) edits integration directly, and this part's own accepted work is already in
 * `before`, so whatever the merge changed in its files is somebody else's change to keep. A
 * template game's entry is left out: every part's wiring line lands there.
 */
export async function othersChangesToOwnFiles(
  git: Git,
  {
    before,
    after,
    owned,
    template = true,
    main = null,
  }: { before: unknown; after: unknown; owned: (file: string) => boolean; template?: boolean; main?: string | null },
): Promise<string[]> {
  if (!isCommit(before) || !isCommit(after) || before === after) return [];
  const wiring = template ? (main ?? TEMPLATE_ENTRY) : null;
  const changed = String(await git(GIT.changedBetween(before, after)))
    .split("\n")
    .map((file) => file.trim());
  return changed.filter((file) => file !== "" && file !== wiring && owned(file));
}
