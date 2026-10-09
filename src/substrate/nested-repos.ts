/**
 * A game folder's version history where it meets somebody else's: the repositories a folder
 * holds inside it (the user's own game, dropped into a project folder), the one conversion that
 * makes such a repository part of the folder's history, and the `.gitignore` rules the studio
 * needs before it commits anything there.
 */
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fsx.ts";
import { isScannedChild } from "./project-shape.ts";
import { git, gitOrNull } from "./snapshots.ts";

/** Where a nested repository's own history is kept once the studio versions its files. */
export const NESTED_BACKUP = ".git.studio-backup";

/** git's tree-entry mode for a gitlink: a nested repository recorded as a pointer. */
const GITLINK_MODE = "160000";

const MESSAGE = {
  StagedChanges: (count: number) =>
    `the game folder has changes staged for its own next commit (${count} file(s)) — commit or unstage them before making this build live`,
  ConversionCommit: (converted: string[]) =>
    `studio: ${converted.map((rel) => `${rel}/`).join(", ")} is part of this game's history now (its own is kept as ${NESTED_BACKUP})`,
  NoConsent: (landing: string[]) =>
    `The game in ${landing.map((rel) => `${rel}/`).join(", ")} keeps its own version history, and the studio was not allowed to make it part of this game — the build's work inside it cannot be made live. Open this folder again and keep it: the studio then adds those files to the game's history, and the folder's own history is kept beside it.`,
} as const;

/**
 * The repositories a folder holds directly inside it: the user's own game, dropped into a
 * project folder. Git records such a folder as a pointer, not as files, which is why the studio
 * has to ask before it may version one.
 */
export async function nestedRepos(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!isScannedChild(entry)) continue;
    if (await pathExists(path.join(dir, entry.name, ".git"))) found.push(entry.name);
  }
  return found;
}

/**
 * The rules the studio needs in a game's `.gitignore`, beyond its own scratch: packages are
 * never committed (a fork links them in from the game folder, and an unignored link would be
 * swept into a commit and landed pointing at the user's own machine), a repository the studio
 * versioned keeps its own history beside it, and the three kinds of file a first `git add -A`
 * should never sweep into somebody's history — build output, secrets, and a tool's scratch.
 * `node_modules` carries no slash on purpose — a rule with one matches directories only, and
 * the link a fork leaves is a link, so a folder whose own file says `node_modules/` still gets
 * the slashless line. The rest are directories, and read as the user wrote them.
 *
 * Written before `git init` (see `#writeTemplate`), so the very first commit is already clean:
 * one adopted folder shipped `.playwright-cli/` and `output/` into "substrate: initial".
 * A path the folder already tracks is unaffected — git ignores rules for tracked files — so a
 * game that commits its `dist/` keeps committing it.
 */
const IGNORE_RULES: Array<{ line: string; already: RegExp }> = [
  { line: ".studio/", already: /^\.studio\/?$/m },
  { line: "node_modules", already: /^\/?node_modules$/m },
  { line: NESTED_BACKUP, already: /^\/?\.git\.studio-backup\/?$/m },
  { line: "dist/", already: /^\/?dist\/?$/m },
  { line: "output/", already: /^\/?output\/?$/m },
  { line: ".env", already: /^\/?\.env$/m },
  { line: ".playwright-cli/", already: /^\/?\.playwright-cli\/?$/m },
];

/** Which of those rules a folder's `.gitignore` is still missing. */
export function missingIgnoreRules(current: string | null): string[] {
  return IGNORE_RULES.filter((rule) => current === null || !rule.already.test(current)).map((rule) => rule.line);
}

/** Top up a folder's `.gitignore` with the rules the studio needs; what the user wrote is kept. */
export async function ensureIgnoreRules(dir: string, header = ""): Promise<void> {
  const file = path.join(dir, ".gitignore");
  const current = await readFile(file, "utf8").catch(() => null);
  const missing = missingIgnoreRules(current);
  if (missing.length === 0) return;
  const before = current === null ? header : `${current.replace(/\s*$/, "")}\n`;
  await writeFile(file, `${before}${missing.join("\n")}\n`);
}

/** Whether `rel` is one of the nested repositories or lies inside one. */
function insideNested(rel: string, nested: string[]): boolean {
  return nested.some((entry) => rel === entry || rel.startsWith(`${entry}/`));
}

/**
 * `write-tree` below takes the whole live index, so anything the user had staged for their own
 * next commit would be swept into the studio's — and `reset --soft` leaves index and HEAD
 * equal, so the landing's own dirty check would then see a clean folder and carry on over it.
 */
async function refuseStagedChanges(dir: string, nested: string[]): Promise<void> {
  const staged = ((await gitOrNull(dir, ["diff", "--cached", "--name-only"])) ?? "")
    .split("\n")
    .filter(Boolean)
    .filter((rel) => rel !== ".gitignore" && !insideNested(rel, nested));
  if (staged.length > 0) throw new Error(MESSAGE.StagedChanges(staged.length));
}

/**
 * Stage each nested repository's files in place of its pointer, backing its `.git` up first.
 * `converted` and `backed` are filled as it goes, so a failure part-way can be undone.
 */
async function stageNestedTrees(
  dir: string,
  nested: string[],
  progress: { converted: string[]; backed: string[] },
): Promise<void> {
  for (const rel of nested) {
    if (!(await pathExists(path.join(dir, rel)))) continue;
    const own = path.join(dir, rel, ".git");
    if (await pathExists(own)) {
      await rename(own, path.join(dir, rel, NESTED_BACKUP));
      progress.backed.push(rel);
    }
    await gitOrNull(dir, ["rm", "-r", "-q", "--cached", "--", rel]);
    await gitOrNull(dir, ["add", "--", rel]);
    progress.converted.push(rel);
  }
}

/** Commit the staged conversion on top of HEAD (and `mergeWith`), leaving the folder as it is. */
async function commitConversion(dir: string, converted: string[], mergeWith?: string): Promise<void> {
  await gitOrNull(dir, ["add", "--", ".gitignore"]);
  const tree = (await git(dir, ["write-tree"])).trim();
  const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
  const parents = ["-p", head, ...(mergeWith ? ["-p", mergeWith] : [])];
  const commit = (await git(dir, ["commit-tree", tree, ...parents, "-m", MESSAGE.ConversionCommit(converted)])).trim();
  // --soft: the commit is exactly the index we just built, so the folder stays as the user left
  // it — nothing of theirs is checked out over, and anything still uncommitted is still theirs.
  await git(dir, ["reset", "-q", "--soft", commit]);
}

/**
 * Make the game's own nested repositories part of *this* folder's history: back up each one's
 * `.git`, drop the pointer from the index and add the files. Only ever called with the user's
 * consent (`AdoptOptions.versionNested`, recorded in studio.json) — it is the one operation the
 * studio performs on somebody else's version history.
 *
 * `mergeWith` is the conversion commit the studio already made in its own forks: recording it as
 * a second parent makes the landing that follows a plain three-way merge, instead of an add/add
 * conflict on every file of the game. Returns the paths that were converted.
 */
export async function versionNestedTrees(dir: string, nested: string[], mergeWith?: string): Promise<string[]> {
  await refuseStagedChanges(dir, nested);
  // Before anything is added: the backup about to be made, and the packages a fork links in,
  // must be ignored — or this conversion would commit the game's own history back into the game.
  await ensureIgnoreRules(dir);
  const progress = { converted: [] as string[], backed: [] as string[] };
  try {
    await stageNestedTrees(dir, nested, progress);
    if (progress.converted.length === 0) return [];
    await commitConversion(dir, progress.converted, mergeWith);
    return progress.converted;
  } catch (err) {
    // A conversion that never reached its commit must leave nothing behind: a game that is no
    // longer a repository, with no commit carrying its files, is worse than any refusal.
    for (const rel of progress.backed) {
      await rename(path.join(dir, rel, NESTED_BACKUP), path.join(dir, rel, ".git")).catch(() => {});
    }
    if (progress.converted.length > 0) {
      await gitOrNull(dir, ["reset", "-q", "HEAD", "--", ...progress.converted]);
    }
    throw err;
  }
}

/**
 * Which repositories a landing would have to convert: a path this folder's history holds as a
 * pointer and the build being landed holds as files. Read-only, so the landing can refuse a
 * dirty folder *before* anything of the user's is renamed or committed — and can leave these
 * paths out of that check, since a pointer reads modified until the conversion happens.
 */
export async function nestedForLanding(dir: string, commit: string): Promise<string[]> {
  const pointers = ((await gitOrNull(dir, ["ls-tree", "-r", "HEAD"])) ?? "")
    .split("\n")
    .filter((line) => line.startsWith(`${GITLINK_MODE} `))
    .map((line) => line.split("\t")[1] ?? "")
    .filter(Boolean);
  const landing: string[] = [];
  for (const rel of pointers) {
    const listed = ((await gitOrNull(dir, ["ls-tree", commit, "--", rel])) ?? "").trim();
    if (listed.startsWith("040000 tree")) landing.push(rel);
  }
  return landing;
}

/** The first commit between `base` and `commit` that touches the landing paths, or "" when there is none. */
async function firstTouchSince(dir: string, base: string, commit: string, landing: string[]): Promise<string> {
  const listed = (await gitOrNull(dir, ["rev-list", "--reverse", `${base}..${commit}`, "--", ...landing])) ?? "";
  return listed.trim().split("\n")[0] ?? "";
}

/**
 * The conversion a landing needs, when it needs one: the repositories this folder's history holds
 * as pointers and the build being landed holds as files. Nothing to convert (the usual case, and
 * every game that has no repository inside it) returns []; without the user's consent it refuses
 * in words the user reads, because the alternative — merging files over a pointer — either fails
 * or writes over files git is not tracking.
 */
export async function versionNestedForLanding(
  dir: string,
  commit: string,
  options: { consent: boolean },
): Promise<string[]> {
  const landing = await nestedForLanding(dir, commit);
  if (landing.length === 0) return [];
  if (!options.consent) throw new Error(MESSAGE.NoConsent(landing));
  // The studio's forks already made this conversion as a commit of their own; joining it here
  // makes the landing a plain three-way merge instead of an add/add conflict on every file.
  const base = ((await gitOrNull(dir, ["merge-base", "HEAD", commit])) ?? "").trim();
  const firstTouch = base ? await firstTouchSince(dir, base, commit, landing) : "";
  return await versionNestedTrees(dir, landing, firstTouch || undefined);
}
