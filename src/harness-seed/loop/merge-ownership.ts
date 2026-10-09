/**
 * Ownership across the mandatory merge.
 *
 * Every round a worker merges the integration branch into itself, and every round the ownership
 * reviewer judges what the worker changed. The two used to fight: the reviewer reverted content
 * that had arrived by merge, a merge that kept this part's side of another part's file went
 * unseen until the director's integrate silently undid the other part's work, and a conflict in
 * another part's file was handed to a builder that may not edit it.
 *
 * - `resolveByOwnership` settles the mandatory merge by the ownership rule: another part's file
 *   takes the integration side, the template entry is union-merged on its wiring block, and only
 *   the files this part owns are left to its builder.
 * - `concludeHandMerge` commits a hand merge the builder left uncommitted, so the review sees its
 *   ancestry, and says when it was left half done.
 * - `droppedByMerge` finds another part's change the merge dropped; `restoreDropped` puts it back.
 *
 * New names live here, not in `review.ts` or `merge.ts`: a seed upgrade keeps a module the
 * in-app agent edited, and an upgraded module importing a new name from a kept older one fails
 * to link. This module imports only names those modules always had.
 */
import { GIT, shortSha } from "./git.ts";
import { unionMergeMain } from "./merge.ts";
import { isCommit } from "./shell.ts";

/** What a review finding is about, by its `category`. The values are written into the run log. */
export const ReviewCategory = {
  /** A file outside this part's ownership (`review.ts` ownershipBreach). */
  Ownership: "ownership",
  /** Another part's change a merge into this part dropped. */
  MergeDropped: "merge-dropped",
} as const;
export type ReviewCategory = (typeof ReviewCategory)[keyof typeof ReviewCategory];

/** What enforcement did to one file. The quarantine's action names its folder (`quarantined to …`). */
export const EnforcedAction = {
  Reverted: "reverted",
  Kept: "kept (arrived by merge)",
  Restored: "restored from integration",
} as const;
export type EnforcedAction = (typeof EnforcedAction)[keyof typeof EnforcedAction];

/** How a hand merge stood when the review came: none pending, committed now, or left with conflicts. */
export const HandMerge = {
  None: "none",
  Concluded: "concluded",
  Unresolved: "unresolved",
} as const;
export type HandMerge = (typeof HandMerge)[keyof typeof HandMerge];

/** The review's mechanical half writes this `source`; only its findings are enforced. */
const MECHANICAL_SOURCE = "mechanical";
/** How an ownership finding was worded before findings carried a category (a kept older reviewer). */
const OWNERSHIP_WORDING = /outside this facet's ownership/;
/** The most changed paths one merge is searched for a dropped change: each costs two git commands. */
const MAX_DROPPED_SCAN = 400;
/** The most staged paths a concluded merge is searched for conflict markers. */
const MAX_MARKER_SCAN = 400;

/** A command run in the worktree: its exit code and output. */
export type MergeExec = (command: string) => Promise<{ code: number | null; stdout?: string; stderr?: string }>;

/** Is this file one the part may edit? (`review.ts` allowedFile, with the part's spec and shape.) */
export type OwnedFile = (file: string) => boolean;

/** A finding as enforcement reads it. */
export interface EnforcedFinding {
  file?: string;
  source?: string;
  category?: string;
  what?: string;
}

/** A finding this module writes: the shape of `review.ts` Violation. */
export interface MergeFinding {
  file: string;
  line: number;
  category: ReviewCategory;
  what: string;
  fix: string;
  source: string;
}

/** What `resolveByOwnership` did with a conflicted merge. */
export interface OwnershipResolution {
  ok: boolean;
  reason?: string;
  /** Conflicted files this part may edit, left for its builder. */
  left?: string[];
  /** Conflicted files of other parts, settled on the integration side. */
  theirs?: string[];
  /** The template entry was union-merged on its wiring block. */
  union?: boolean;
  duplicates?: number;
}

/** How `concludeHandMerge` found the worktree. */
export interface ConcludedMerge {
  state: HandMerge;
  /** The commit the hand merge took in, when one was pending. */
  head?: string;
  /** The files still in conflict, when it was left half done. */
  files: string[];
}

/** The `GIT` command lines this module speaks, which a kept older `git.ts` may lack. */
const MERGE_VERBS = [
  "sameAsRev",
  "mergeBase",
  "changedBetween",
  "mergeHead",
  "stageExists",
  "takeTheirs",
  "takeTheirDeletion",
  "stagedNames",
  "conflictMarked",
] as const;

/**
 * Does `git.ts` have every command line this module needs? A seed upgrade keeps a `git.ts` the
 * in-app agent edited; without them each function here falls back to what the loop did before.
 */
export function speaksMergeOwnership(): boolean {
  const verbs: Record<string, unknown> = GIT;
  return MERGE_VERBS.every((verb) => verbs[verb] !== undefined);
}

/** The non-empty lines of a command's output. */
function lines(out: { stdout?: string } | null | undefined): string[] {
  return String(out?.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The single-character escapes git writes in a quoted path, by the byte each stands for. */
const C_ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** The bytes one piece of a quoted path stands for: an escape (`\303`, `\"`) or plain text. */
function quotedBytes(piece: string): number[] {
  if (!piece.startsWith("\\")) return [...new TextEncoder().encode(piece)];
  const escape = piece.slice(1);
  if (/^[0-7]{3}$/.test(escape)) return [Number.parseInt(escape, 8)];
  return [C_ESCAPES[escape] ?? escape.charCodeAt(0)];
}

/**
 * A path as git lists it, read back as the file it names. Git quotes a name holding a byte outside
 * printable ASCII, a quote or a backslash (`"src/caf\303\251.js"`); left quoted, such a name
 * matches no file on disk.
 */
function gitPath(listed: string): string {
  const quoted = listed.length > 1 && listed.startsWith('"') && listed.endsWith('"');
  if (!quoted) return listed;
  const pieces = listed.slice(1, -1).split(/(\\(?:[0-7]{3}|.))/s);
  return new TextDecoder().decode(new Uint8Array(pieces.flatMap(quotedBytes)));
}

/** The paths a git listing names, one per line, each read back as the file it names. */
function paths(out: { stdout?: string } | null | undefined): string[] {
  return lines(out).map(gitPath);
}

/** Does `rev`'s copy of `file` match the worktree's? A command that fails answers no. */
async function sameAs(exec: MergeExec, rev: string, file: string): Promise<boolean> {
  const answer = await exec(GIT.sameAsRev(rev, file)).catch(() => null);
  return String(answer?.stdout ?? "").trim() === "yes";
}

/**
 * Is this finding one ownership enforcement acts on? The mechanical half's, with a file, and of
 * the ownership category; a finding with no category is read by its old wording instead.
 */
export function isOwnershipFinding(finding: EnforcedFinding): boolean {
  if (finding.source !== MECHANICAL_SOURCE || !finding.file) return false;
  if (finding.category) return finding.category === ReviewCategory.Ownership;
  return OWNERSHIP_WORDING.test(String(finding.what ?? ""));
}

/** Is this finding a change a merge dropped? */
export function isDroppedFinding(finding: EnforcedFinding): boolean {
  return (
    finding.source === MECHANICAL_SOURCE && Boolean(finding.file) && finding.category === ReviewCategory.MergeDropped
  );
}

/**
 * The commit a merge in progress is taking in, or null when none is pending. Enforcement reverts
 * to it, never to the pre-merge incumbent, while a merge is open.
 */
export async function pendingMergeHead(exec: MergeExec): Promise<string | null> {
  if (!speaksMergeOwnership()) return null;
  const answer = await exec(GIT.mergeHead).catch(() => null);
  const head = String(answer?.stdout ?? "").trim();
  return answer?.code === 0 && isCommit(head) ? head : null;
}

/** A stdout-or-throw git runner (enforcement's) read as an exec that answers its exit code. */
function asExec(git: (command: string) => Promise<string>): MergeExec {
  return (command) =>
    git(command).then(
      (stdout) => ({ code: 0, stdout }),
      () => ({ code: 1, stdout: "" }),
    );
}

/**
 * Did this file's content arrive by merge? It is byte-identical to its copy at one of `heads`
 * (integration heads; anything that is not a commit is skipped). Enforcement keeps such a file:
 * it is the other part's work, not this part's edit.
 */
export async function arrivedByMerge(
  git: (command: string) => Promise<string>,
  { heads = [], file }: { heads?: readonly unknown[]; file: string },
): Promise<boolean> {
  if (!speaksMergeOwnership()) return false;
  for (const head of heads.filter(isCommit)) if (await sameAs(asExec(git), head, file)) return true;
  return false;
}

/** {@link pendingMergeHead}, for enforcement's stdout-or-throw runner. */
export function openMergeHead(git: (command: string) => Promise<string>): Promise<string | null> {
  return pendingMergeHead(asExec(git));
}

/**
 * Settle a conflicted merge by ownership, after `git merge` stopped. Another part's file takes the
 * side being merged in (its deletion too); the template entry (`main`, when `wiring`) is
 * union-merged on its FACET WIRING block; a file this part owns is left. With nothing left the
 * merge is committed and `ok`; otherwise `left` names the files this part's builder may resolve,
 * and the caller aborts the merge as it always has.
 */
export async function resolveByOwnership(
  exec: MergeExec,
  {
    owned,
    main = "src/main.js",
    wiring = true,
    message = "merge (resolved by ownership)",
  }: { owned: OwnedFile; main?: string; wiring?: boolean; message?: string },
): Promise<OwnershipResolution> {
  if (!speaksMergeOwnership()) return unionMergeMain(exec, { message, main, wiring });
  const unmerged = await exec(GIT.unmerged);
  const files = paths(unmerged);
  if (unmerged.code !== 0 || !files.length) return { ok: false, reason: "no unmerged file", left: [] };
  const entry = wiring && files.includes(main);
  const others = files.filter((file) => !(entry && file === main));
  const own = others.filter((file) => owned(file));
  const theirs = others.filter((file) => !owned(file));
  // A merge settled only in part is aborted, so its builder merges the wiring block as well.
  const left = entry ? [main, ...own] : own;
  for (const file of theirs) {
    const settled = await takeTheirSide(exec, file);
    if (!settled) return { ok: false, reason: `could not take the integration side of ${file}`, left, theirs };
  }
  if (own.length) return { ok: false, reason: `conflicts in ${left.join(", ")}`, left, theirs };
  if (entry) return unionTheEntry(exec, { main, message, theirs });
  const committed = await exec(GIT.commit(message, { noEdit: true }));
  if (committed.code !== 0)
    return { ok: false, reason: `could not commit the merge: ${committed.stderr || committed.stdout}`, left, theirs };
  return { ok: true, theirs };
}

/** The template entry, union-merged on its wiring block once every other conflict is settled. */
async function unionTheEntry(
  exec: MergeExec,
  { main, message, theirs }: { main: string; message: string; theirs: string[] },
): Promise<OwnershipResolution> {
  const union = await unionMergeMain(exec, { message, main, wiring: true });
  if (!union.ok) return { ok: false, reason: union.reason, left: [main], theirs };
  return { ok: true, union: true, duplicates: union.duplicates ?? 0, theirs };
}

/** One conflicted path settled on the side being merged in: its copy, or its deletion. */
async function takeTheirSide(exec: MergeExec, file: string): Promise<boolean> {
  const stage = await exec(GIT.stageExists(3, file)).catch(() => null);
  const hasTheirs = String(stage?.stdout ?? "").trim() === "yes";
  const command = hasTheirs ? GIT.takeTheirs(file) : GIT.takeTheirDeletion(file);
  const settled = await exec(command).catch(() => null);
  return settled?.code === 0;
}

/**
 * A hand merge the builder left uncommitted (`git merge --no-commit`, or a merge it never
 * finished) is committed before the review, so the review sees the merged head as an ancestor
 * and judges only this part's own diff. A merge with conflicts left (any path still unmerged, or
 * one staged with its markers) is not committed: the caller treats the build as broken instead of
 * reviewing half a merge. Nothing is staged on the builder's behalf: git writes no markers for a
 * binary or modify/delete conflict, so what is on disk proves no resolution.
 */
export async function concludeHandMerge(
  exec: MergeExec,
  { message = "merge (concluded before review)" }: { message?: string } = {},
): Promise<ConcludedMerge> {
  const head = await pendingMergeHead(exec);
  if (!head) return { state: HandMerge.None, files: [] };
  const unmerged = paths(await exec(GIT.unmerged).catch(() => null));
  const staged = paths(await exec(GIT.stagedNames).catch(() => null)).slice(0, MAX_MARKER_SCAN);
  const suspects = [...new Set([...unmerged, ...staged])];
  // The marker scan prints each name as given (`printf '%s'`), never git-quoted.
  const marked = suspects.length ? lines(await exec(GIT.conflictMarked(suspects)).catch(() => null)) : [];
  const open = [...new Set([...unmerged, ...marked])];
  if (open.length) return { state: HandMerge.Unresolved, head, files: open };
  const committed = await exec(GIT.commit(message, { noEdit: true })).catch(() => null);
  if (committed?.code !== 0) return { state: HandMerge.Unresolved, head, files: [] };
  return { state: HandMerge.Concluded, head, files: [] };
}

/**
 * Another part's change that a merge into this part dropped: a file changed on the merged head
 * since the two branches parted, that this part does not own, whose worktree copy is still the
 * incumbent's and not the merged head's. The merge kept this part's side of it — resolved
 * `--ours`, or overwritten after — and the director's integrate would then undo the other part's
 * work without a conflict. Call it only with a head the worktree has merged (an ancestor of HEAD,
 * or the pending MERGE_HEAD). A file the merged head deleted is never reported: nothing merged is
 * deleted by enforcement.
 */
export async function droppedByMerge(
  exec: MergeExec,
  { incumbent, mergedHead, owned }: { incumbent: unknown; mergedHead: unknown; owned: OwnedFile },
): Promise<MergeFinding[]> {
  const comparable = isCommit(incumbent) && isCommit(mergedHead) && incumbent !== mergedHead;
  if (!comparable || !speaksMergeOwnership()) return [];
  const base = String((await exec(GIT.mergeBase(incumbent, mergedHead)).catch(() => null))?.stdout ?? "").trim();
  if (!isCommit(base) || base === mergedHead) return [];
  const incoming = paths(await exec(GIT.changedBetween(base, mergedHead)).catch(() => null));
  // Only a file the worktree no longer has as the merged head has it can have been dropped.
  const differs = new Set(paths(await exec(GIT.diffNames(mergedHead, ".")).catch(() => null)));
  const suspects = incoming.filter((file) => differs.has(file) && !owned(file)).slice(0, MAX_DROPPED_SCAN);
  const findings: MergeFinding[] = [];
  for (const file of suspects) {
    if (!(await sameAs(exec, incumbent, file))) continue;
    const present = await exec(GIT.catFileExists(mergedHead, file)).catch(() => null);
    if (String(present?.stdout ?? "").trim() !== "yes") continue;
    findings.push(droppedFinding(file, mergedHead));
  }
  return findings;
}

/** The finding for one dropped change, and how the builder puts it back. */
function droppedFinding(file: string, mergedHead: string): MergeFinding {
  return {
    file,
    line: 0,
    category: ReviewCategory.MergeDropped,
    what: `the merge of integration ${shortSha(mergedHead)} dropped another part's change to ${file} (it still reads as before the merge)`,
    fix: `restore it with \`git checkout ${mergedHead} -- ${file}\`; it is not this part's file`,
    source: MECHANICAL_SOURCE,
  };
}

/**
 * Put back what a merge dropped: each merge-dropped finding's file is checked out from the merged
 * head. `git(command)` runs a shell command in the worktree and answers its stdout.
 */
export async function restoreDropped(
  git: (command: string) => Promise<string>,
  { violations = [], from }: { violations?: ReadonlyArray<EnforcedFinding>; from: unknown },
): Promise<Array<{ file: string; action: string }>> {
  if (!isCommit(from)) return [];
  const restored: Array<{ file: string; action: string }> = [];
  for (const finding of violations.filter(isDroppedFinding)) {
    const file = String(finding.file);
    const done = await git(GIT.checkoutPath(from, file)).then(
      () => true,
      () => false,
    );
    if (done) restored.push({ file, action: EnforcedAction.Restored });
  }
  return restored;
}

/** The files enforcement acted on, by what it did: what `facet_review_enforced` records. */
export function enforcedLists(enforced: ReadonlyArray<{ file: string; action: string }>): {
  reverted: string[];
  kept: string[];
  quarantined: string[];
  restored: string[];
} {
  const named = (action: string) => enforced.filter((e) => e.action === action).map((e) => e.file);
  const known = new Set<string>(Object.values(EnforcedAction));
  return {
    reverted: named(EnforcedAction.Reverted),
    kept: named(EnforcedAction.Kept),
    quarantined: enforced.filter((e) => !known.has(e.action)).map((e) => e.file),
    restored: named(EnforcedAction.Restored),
  };
}
