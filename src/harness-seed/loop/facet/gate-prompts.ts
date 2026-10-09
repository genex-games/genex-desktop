/** What the round's gate tells a builder about the integration merge. */

/** The facts of a merge the harness could not settle on its own. */
export interface HandMergeFacts {
  /** The integration head to merge. */
  head: string;
  /** Why the harness could not merge it. */
  reason: string;
  /** The conflicted files this part may edit; unknown when the resolver did not say. */
  left?: readonly string[];
  /** The conflicted files of other parts; unknown when the resolver did not say. */
  theirs?: readonly string[];
}

/** How a builder settles a conflicted file another part owns: their side, never an edit. */
const TAKE_THEIRS =
  "belongs to another part: take theirs with `git checkout --theirs -- <file>`, then `git add` it, and never edit it";

/** How a builder resolves a conflict when the harness does not know whose files conflict. */
const KEEP_BOTH = "resolve the conflicts keeping both sides' work (yours and theirs)";

/**
 * How the builder resolves the merge. It names only the files the builder may edit; another
 * part's file cannot be hand-merged with an edit, so it takes their side. When the resolver did
 * not say whose files conflict, both sides are kept, as before ownership settled merges.
 */
function resolveWords({ left, theirs }: Pick<HandMergeFacts, "left" | "theirs">): string {
  const othersConflict = Boolean(theirs?.length);
  const otherFiles = othersConflict ? `; any other file that conflicts ${TAKE_THEIRS}` : "";
  if (left?.length)
    return `resolve the conflicts in ${left.join(", ")} (this part's files) keeping both sides' work (yours and theirs)${otherFiles}`;
  if (left && othersConflict) return `every file that conflicts ${TAKE_THEIRS}`;
  return KEEP_BOTH;
}

/** The note a builder gets when the integration merge needs its hands. */
export function handMergeNote({ head, reason, left, theirs }: HandMergeFacts): string {
  return `Other facets' accepted work is on commit ${head}. Your worktree could not merge it automatically (${reason}). FIRST run \`git merge ${head}\`, ${resolveWords({ left, theirs })}, and commit the merge — then continue with your own checks.`;
}

/** Why a build whose hand merge was left half done is not judged: the files still in conflict. */
export function unresolvedMergeWords(files: readonly string[]): string {
  return `the integration merge was left unfinished — conflicts remain in ${files.join(", ") || "the worktree"}; finish it (resolve, \`git add\`, commit) before the build can be judged`;
}
