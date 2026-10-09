/**
 * User repositories in the states snapshot, landing and restore code must never lose: committed
 * history plus uncommitted edits, staged edits and untracked files, and a game folder that holds
 * another repository one level down.
 *
 * Built with the machine's real git. Commits carry a fixture identity and skip signing and hooks,
 * so the builders behave the same whatever the developer's global git config says.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gitFile } from "./git.ts";
import { tmpDir } from "./tmp.ts";

const IDENTITY = [
  "-c",
  "user.name=Fixture User",
  "-c",
  "user.email=fixture@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.autocrlf=false",
];

export async function fixtureGit(dir: string, args: string[]): Promise<string> {
  const { stdout } = await gitFile([...IDENTITY, ...args], { cwd: dir });
  return String(stdout).trim();
}

async function writeAll(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
}

export interface UserRepoSpec {
  /** Files in the first commit. */
  committed?: Record<string, string>;
  /** Tracked files changed in the working tree and left unstaged (must name committed files). */
  modified?: Record<string, string>;
  /** Changes added to the index but not committed. */
  staged?: Record<string, string>;
  /** Files git has never seen. */
  untracked?: Record<string, string>;
  /** Lines of the repo's own `.gitignore`, committed with the rest. */
  ignore?: string[];
}

export interface UserRepo {
  dir: string;
  /** The commit the builder made; the working tree is dirty on top of it. */
  head: string;
  spec: Required<UserRepoSpec>;
  /** `git status --porcelain` right now, one entry per line. */
  status(): Promise<string[]>;
}

const DEFAULT_REPO: Required<UserRepoSpec> = {
  committed: { "index.html": '<canvas id="game"></canvas>\n', "src/main.js": "export const speed = 1;\n" },
  modified: { "src/main.js": "export const speed = 2; // the user's edit, not yet committed\n" },
  staged: { "src/level.js": "export const level = 'staged, never committed';\n" },
  untracked: { "notes/ideas.md": "- a jump that feels like mine\n" },
  ignore: ["node_modules/", "dist/"],
};

async function initRepo(dir: string, spec: Required<UserRepoSpec>): Promise<UserRepo> {
  await mkdir(dir, { recursive: true });
  await fixtureGit(dir, ["init", "-q", "-b", "main"]);
  await writeAll(dir, {
    ...spec.committed,
    ...(spec.ignore.length ? { ".gitignore": `${spec.ignore.join("\n")}\n` } : {}),
  });
  await fixtureGit(dir, ["add", "-A"]);
  await fixtureGit(dir, ["commit", "-q", "-m", "the user's own history"]);
  const head = await fixtureGit(dir, ["rev-parse", "HEAD"]);
  await writeAll(dir, spec.staged);
  if (Object.keys(spec.staged).length) await fixtureGit(dir, ["add", "--", ...Object.keys(spec.staged)]);
  await writeAll(dir, spec.modified);
  await writeAll(dir, spec.untracked);
  return {
    dir,
    head,
    spec,
    status: async () =>
      (await fixtureGit(dir, ["status", "--porcelain", "--untracked-files=all"])).split("\n").filter(Boolean),
  };
}

/**
 * A game folder that is the user's own repository, dirty in every way at once: an unstaged edit,
 * a staged new file and an untracked file on top of one commit. Pass a spec to change any part.
 */
export async function dirtyUserRepo(spec: UserRepoSpec = {}, dir?: string): Promise<UserRepo> {
  return initRepo(dir ?? path.join(await tmpDir("studio-user-repo-"), "game"), { ...DEFAULT_REPO, ...spec });
}

export interface NestedRepo {
  /** The folder the user opened. */
  parent: string;
  /** The repository one level down that holds the real game. */
  inner: UserRepo;
  /** The inner repo's folder name relative to `parent`. */
  rel: string;
}

/**
 * A folder holding the user's game one level down as a repository of its own, dirty like
 * {@link dirtyUserRepo}. `parentRepo` makes the outer folder a repository too, with one commit that
 * leaves the inner repository unadded (git would record it only as a gitlink, never as files).
 */
export async function nestedUserRepo(
  options: { rel?: string; parentRepo?: boolean; inner?: UserRepoSpec } = {},
): Promise<NestedRepo> {
  const rel = options.rel ?? "wreckage";
  const parent = path.join(await tmpDir("studio-nested-repo-"), "project");
  await mkdir(parent, { recursive: true });
  await writeFile(path.join(parent, "README.md"), "the folder the user opened\n");
  const inner = await dirtyUserRepo(options.inner, path.join(parent, rel));
  if (options.parentRepo) {
    await fixtureGit(parent, ["init", "-q", "-b", "main"]);
    await fixtureGit(parent, ["add", "README.md"]);
    await fixtureGit(parent, ["commit", "-q", "-m", "outer folder"]);
  }
  return { parent, inner, rel };
}
