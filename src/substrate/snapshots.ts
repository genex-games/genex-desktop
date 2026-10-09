/**
 * Snapshot engine (git instead of Docker commit/save/load).
 *
 * Hard constraint #3: *every self-modification should be recoverable*. Here that is: both
 * workspaces are git repos, a snapshot is a commit + tag recorded in the event log, and a restore
 * is a checkout: instant, diffable (which is literally the self-change UI, user story 5) and
 * kilobytes. It is the first recovery path, not a guarantee on its own: the snapshot store lives
 * in the sandbox-writable workspace, so a self-edit can damage it, and a rewind that fails falls
 * back to reseeding from the app (recovery.ts), which gives up the agent's own harness edits.
 *
 * `healthy` is the flag the watchdog steers by: a snapshot becomes healthy only once the harness
 * has completed a full turn after it, so rewinding always lands on a version that actually ran.
 *
 * Simplification vs the original design: it budgeted a bundled
 * `pnpm` for dependency restore. Both workspaces are dependency-free by design — the harness
 * talks to the substrate over RPC and games are built with the app's bundled esbuild against a
 * vendored three.js — so restore is a pure checkout. {@link SnapshotEngine.restore} still calls
 * the `afterRestore` hook where an install step would go.
 */
import { cp, lstat, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureDir, pathExists } from "./fsx.ts";
import { shortId } from "./ids.ts";
import { throughClaudeFolder } from "./paths.ts";
import type { SnapshotGitRefs } from "./types.ts";
import { type SnapshotRecord, SnapshotScope } from "../shared/event-log.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startWithRecovery } from "./process-start.ts";
import { errorMessage } from "../shared/errors.ts";
import { hostGitArgs, hostGitConfig, hostGitEnv } from "./git-policy.ts";

const execFileAsync = promisify(execFile);

/** The snapshot index entry is a contract the UI reads too; it lives in `shared/event-log.ts`. */
export type { SnapshotRecord } from "../shared/event-log.ts";
/** The commits a snapshot holds, plus — for a game — the branch it was taken on. */
export type SnapshotRecordGit = SnapshotGitRefs;

/** Why the engine would not snapshot or restore a game folder. Error codes callers read: never rename a value. */
export const SnapshotRefusal = {
  OperationInProgress: "operation-in-progress",
  BranchChanged: "branch-changed",
  HistoryChanged: "history-changed",
  RescueFailed: "rescue-failed",
  /** A worker's copy of the game would be larger than a copy may be (`WRITER_COPY_MAX_BYTES`). */
  CopyTooLarge: "copy-too-large",
} as const;
export type SnapshotRefusal = (typeof SnapshotRefusal)[keyof typeof SnapshotRefusal];

/** git output a host call may buffer before it fails. */
const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * The most disk a worker's copy of a game may take. Up to eight workers copy one game at once; past
 * this a copy costs the person's disk more than the work is worth, and the lead should work in the
 * game folder itself instead.
 */
export const WRITER_COPY_MAX_BYTES = 2 * 1024 ** 3;

/** Folders a copy never receives from a nested repository: its history, and packages it links instead. */
const NEVER_COPIED = new Set([".git", "node_modules"]);

/** What a worker's copy of a game would take, in all and by top-level folder, largest first. */
export interface CopySize {
  bytes: number;
  folders: Array<{ folder: string; bytes: number }>;
}

const MESSAGE = {
  UnknownWorkspace: (name: string) => `unknown workspace: ${name}`,
  NotACommit: (revision: string) => `not a commit: ${JSON.stringify(revision).slice(0, 80)}`,
  RescueFailed: (reason: string) =>
    `the folder could not be saved before the restore, so it was left as it is: ${reason}`,
  OperationInProgress: (marker: string) =>
    `a git ${marker} is in progress in this folder; the studio will not commit over it`,
  BranchChanged: (now: string | null, branch: string | null) =>
    `the folder is on ${now ?? "a detached HEAD"}, not on ${branch ?? "the detached HEAD"} where the snapshot was taken`,
  NotDescendant: "the folder's HEAD no longer descends from the snapshot",
  ForeignCommits: "the branch holds commits since the snapshot that the studio did not make",
  RescueReason: (snapshotId: string) => `pre-restore rescue before ${snapshotId}`,
} as const;

/** A refusal with a typed `code`; the folder was left exactly as it was. */
export class SnapshotRefusedError extends Error {
  readonly code: SnapshotRefusal;
  readonly workspace: string;
  constructor(code: SnapshotRefusal, workspace: string, message: string) {
    super(message);
    this.name = "SnapshotRefusedError";
    this.code = code;
    this.workspace = workspace;
  }
}

/**
 * A commit the studio makes in somebody's repository: their hooks (husky, lint-staged) never run
 * on it and cannot refuse it, as in `game-candidate.ts`.
 */
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

/** What git leaves behind while the user is half-way through a merge, rebase, cherry-pick or revert. */
const OPERATIONS_IN_PROGRESS = [
  "MERGE_HEAD",
  "REBASE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
];

/** The harness's own workspace key; every other key names a game's workspace. */
export const HARNESS_WORKSPACE = "harness";

export interface WorkspaceSpec {
  /** "harness" or a game workspace key. */
  name: string;
  dir: string;
}

/**
 * One committer, everywhere the studio writes history — here, in the run's worktrees
 * (`harness-seed/loop/repo.ts`) and in `landBuild`. A user's `git log` used to name five
 * (studio-substrate, studio-facet, studio-integrator, studio-director, studio-base) as if a
 * committee had been through their game unattended.
 */
export const STUDIO_COMMITTER = { name: "AI Game Studio", email: "studio@ai-game-studio.local" };

/** Where a snapshot is bookmarked: a ref of the studio's own, never a tag `push --tags` ships. */
export const snapshotRef = (snapshotId: string): string => `refs/studio/snap/${snapshotId}`;

/** Studio's git identity and an isolated config, reused wherever the studio — or a tool it spawns — commits. */
export const GIT_ENV = {
  // The agent never gets to forge history: every commit the substrate makes is the studio's.
  GIT_AUTHOR_NAME: STUDIO_COMMITTER.name,
  GIT_AUTHOR_EMAIL: STUDIO_COMMITTER.email,
  GIT_COMMITTER_NAME: STUDIO_COMMITTER.name,
  GIT_COMMITTER_EMAIL: STUDIO_COMMITTER.email,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

/**
 * Config a repository cannot override on the host: a `.git/config` planted in a game folder
 * (`core.fsmonitor = ./x.sh`, `core.hooksPath`) must never make a host-side status, diff or
 * commit run a program. `-c` beats every config file.
 */
export { HOST_GIT_CONFIG } from "./git-policy.ts";

/** Git as the studio in `dir`; `input`, when given, is written to its standard input. */
export async function git(
  dir: string,
  args: string[],
  env: Record<string, string> = {},
  input?: string,
): Promise<string> {
  const environment = hostGitEnv({ ...GIT_ENV, ...env });
  const config = await hostGitConfig(dir, environment);
  const { stdout } = await startWithRecovery(() => {
    const running = execFileAsync("git", [...config, "-C", dir, ...hostGitArgs(args)], {
      windowsHide: true,
      env: environment,
      maxBuffer: GIT_MAX_BUFFER_BYTES,
    });
    if (input !== undefined) running.child.stdin?.end(input);
    return running;
  });
  return stdout;
}

/**
 * The files that bringing `to` into `from` would change inside a `.claude` folder (Claude Code's
 * project settings, hooks, commands, skills), against their merge base: what no build may land in
 * a game on the harness's word.
 */
export async function claudeFolderChanges(dir: string, from: string, to: string): Promise<string[]> {
  const changed = await git(dir, ["diff", "--name-only", "--no-renames", "-z", `${from}...${to}`]);
  return changed.split("\0").filter((file) => file && throughClaudeFolder(file));
}

export async function gitOrNull(dir: string, args: string[], env: Record<string, string> = {}): Promise<string | null> {
  try {
    return await git(dir, args, env);
  } catch {
    return null;
  }
}

/** Why a revision was refused: it does not name a commit, or git would read it as an option. */
export class NotACommitError extends Error {
  constructor(revision: string) {
    super(MESSAGE.NotACommit(revision));
    this.name = "NotACommitError";
  }
}

/**
 * The commit `revision` names in `dir`, as a full hash. A revision reaches git as an argument, so
 * one that begins with `-` (`--output=<file>`, `--orphan`) is refused before git sees it, and
 * the lookup itself sits behind `--end-of-options`.
 */
export async function resolveCommit(dir: string, revision: string): Promise<string> {
  const text = String(revision ?? "");
  const optionOrBroken = !text || text.startsWith("-") || /[\0\n\r]/.test(text);
  if (optionOrBroken) throw new NotACommitError(text);
  const hash = (
    await gitOrNull(dir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${text}^{commit}`])
  )?.trim();
  if (!hash || !/^[0-9a-f]{40,64}$/.test(hash)) throw new NotACommitError(text);
  return hash;
}

/** `git init` + an initial commit if the directory is not a repo yet. */
export async function ensureRepo(dir: string): Promise<void> {
  await ensureDir(dir);
  if (await pathExists(path.join(dir, ".git"))) return;
  await git(dir, ["init", "-q", "-b", "main"]);
  await stagePublicChanges(dir);
  await git(dir, ["commit", "-q", "--allow-empty", "-m", "substrate: initial"]);
}

/** Environment files never enter host-created commits, even when an adopted folder has no ignore file. */
async function stagePublicChanges(dir: string): Promise<void> {
  await git(dir, ["add", "-A"]);
}

/** One `git ls-tree -r -l -z` entry of a file: its size and path (a nested repository's pointer is no blob). */
const TRACKED_BLOB = /^\d+ blob [0-9a-f]+ +(\d+)\t(.+)$/s;

/** A path inside the game, POSIX, as copy rules read it. */
const gameRelative = (gameDir: string, file: string): string => path.relative(gameDir, file).split(path.sep).join("/");

/** A copy's size rule and tally: what it leaves out, by the path inside the game, and where sizes add up. */
interface CopyTally {
  skip: (rel: string) => boolean;
  add: (rel: string, bytes: number) => void;
}

/** Tally the files of one folder a copy receives, never through a link; answers its subfolders it receives. */
async function tallyFolder(gameDir: string, folder: string, tally: CopyTally): Promise<string[]> {
  const subfolders: string[] = [];
  for (const entry of await readdir(path.join(gameDir, folder), { withFileTypes: true }).catch(() => [])) {
    const child = `${folder}/${entry.name}`;
    if (NEVER_COPIED.has(entry.name) || tally.skip(child)) continue;
    if (entry.isDirectory()) subfolders.push(child);
    else if (entry.isFile()) tally.add(child, (await lstat(path.join(gameDir, child)).catch(() => null))?.size ?? 0);
  }
  return subfolders;
}

/**
 * Tally each file a copy receives from the nested repository at `rel`: never its history or
 * packages, nor what the tally skips, and never through a link.
 */
async function tallyNested(gameDir: string, rel: string, tally: CopyTally): Promise<void> {
  const root = await lstat(path.join(gameDir, rel)).catch(() => null);
  if (!root?.isDirectory() || tally.skip(rel)) return;
  const pending = [rel];
  for (let folder = pending.pop(); folder !== undefined; folder = pending.pop())
    pending.push(...(await tallyFolder(gameDir, folder, tally)));
}

export class SnapshotEngine {
  readonly workspaces: Map<string, string>;
  /** Optional hook for dependency restore; no-op by design (see file header). */
  afterRestore?: (workspace: WorkspaceSpec) => Promise<void>;
  /**
   * Called before the engine commits a game folder (never the harness's): its owner tops up the
   * folder's ignore rules for what it holds now and may answer those rules' lines (a string
   * array), which a restore then never deletes. A rejection never stops the commit; the owner reports it.
   */
  beforeCommit?: (workspace: WorkspaceSpec) => Promise<readonly string[] | undefined>;
  /**
   * Called after a restore put a game folder back, with the ignore lines its last `beforeCommit`
   * answered: its owner writes them into the restored ignore file, so what a restore leaves on disk
   * because they ignore it stays out of every commit after it, though the restored folder may no
   * longer hold what named those rules. A rejection never stops the restore; the owner reports it.
   */
  keepIgnoring?: (workspace: WorkspaceSpec, lines: readonly string[]) => Promise<void>;
  /** Per game folder, the ignore lines its last `beforeCommit` answered. */
  readonly #ruleLines = new Map<string, readonly string[]>();

  constructor(workspaces: WorkspaceSpec[]) {
    this.workspaces = new Map(workspaces.map((w) => [w.name, w.dir]));
  }

  dirFor(name: string): string {
    const dir = this.workspaces.get(name);
    if (!dir) throw new Error(MESSAGE.UnknownWorkspace(name));
    return dir;
  }

  register(spec: WorkspaceSpec): void {
    this.workspaces.set(spec.name, spec.dir);
  }

  /** A repository for every workspace that has none yet; a game's rules are topped up before its first commit. */
  async init(): Promise<void> {
    for (const [name, dir] of this.workspaces) {
      // Only a folder about to get its first commit: init runs for every game at each start.
      if (!(await pathExists(path.join(dir, ".git")))) await this.#beforeCommit(name, dir);
      await ensureRepo(dir);
    }
  }

  /** The `beforeCommit` hook for a game folder, keeping the lines it answers; what it throws stays with its owner. */
  async #beforeCommit(name: string, dir: string): Promise<void> {
    if (name === HARNESS_WORKSPACE || !this.beforeCommit) return;
    const lines = await this.beforeCommit({ name, dir }).catch(() => undefined);
    const answered: unknown[] = Array.isArray(lines) ? lines : [];
    this.#ruleLines.set(
      dir,
      answered.filter((line): line is string => typeof line === "string" && line !== ""),
    );
  }

  #namesForScope(scope: SnapshotScope, gameWorkspace?: string): string[] {
    const game = gameWorkspace ? [gameWorkspace] : [];
    switch (scope) {
      case SnapshotScope.Harness:
        return [HARNESS_WORKSPACE];
      case SnapshotScope.Game:
        return game;
      case SnapshotScope.Both:
        return [HARNESS_WORKSPACE, ...game];
    }
  }

  /**
   * Commit the current state of the scoped workspaces and tag it.
   * Returns the record the caller appends to the event log as `snapshot_created`.
   */
  async snapshot(options: {
    scope: SnapshotScope;
    reason: string;
    gameWorkspace?: string;
    healthy?: boolean;
  }): Promise<SnapshotRecord> {
    const snapshotId = shortId("snap");
    const refs: SnapshotRecordGit = {};
    for (const name of this.#namesForScope(options.scope, options.gameWorkspace)) {
      const dir = this.dirFor(name);
      // `add -A` in the middle of the user's merge would commit their conflict markers for them.
      // Refused before the rules are topped up, so a refusal writes nothing; a folder with no
      // repository yet is in no git operation.
      const hasRepo = await pathExists(path.join(dir, ".git"));
      if (name !== HARNESS_WORKSPACE && hasRepo) await this.#refuseMidOperation(name, dir);
      await this.#beforeCommit(name, dir);
      await ensureRepo(dir);
      await stagePublicChanges(dir);
      // --allow-empty: a snapshot must exist even when nothing changed, so that timeline
      // positions and `healthy` marks stay addressable.
      await git(dir, [...NO_HOOKS, "commit", "-q", "--allow-empty", "-m", `snapshot ${snapshotId}: ${options.reason}`]);
      const commit = (await git(dir, ["rev-parse", "HEAD"])).trim();
      // `refs/studio/snap/…`, not `refs/tags/snap/…`: a tag in the user's repository is theirs,
      // it shows in `git tag`, and `git push --tags` would ship every run's bookkeeping to
      // their remote. The ref is just as reachable and nothing but the studio ever lists it.
      await git(dir, ["update-ref", snapshotRef(snapshotId), commit]);
      if (name === HARNESS_WORKSPACE) refs.harness = commit;
      else {
        refs.game = commit;
        refs.gameBranch = await this.#branchOf(dir);
      }
    }
    return {
      snapshot_id: snapshotId,
      scope: options.scope,
      git: refs,
      created_at: new Date().toISOString(),
      reason: options.reason,
      healthy: options.healthy ?? false,
    };
  }

  /**
   * Restore a snapshot. Uses `reset --hard` + `clean -fd` so that files the agent created after
   * the snapshot (a half-written broken tool, for instance) actually disappear.
   *
   * `scope` narrows the restore to part of what the record captured — a "both" snapshot can be
   * rewound game-only, leaving the harness where it stands. A workspace the record holds no
   * commit for is skipped, so widening beyond the record is harmless but does nothing.
   *
   * A game folder is somebody's own, and they may be working in it while a round runs. Before its
   * reset, everything the folder holds is committed to a rescue snapshot, which this returns (null
   * when no game was restored). The restore is refused, with the folder untouched, when that
   * rescue cannot be taken, when the folder is no longer on the branch the snapshot was taken on,
   * or when the branch holds commits since the snapshot that are not the studio's own.
   */
  async restore(
    record: SnapshotRecord,
    options: { gameWorkspace?: string; scope?: SnapshotScope } = {},
  ): Promise<SnapshotRecord | null> {
    const targets: Array<{ name: string; dir: string; commit: string }> = [];
    for (const name of this.#namesForScope(options.scope ?? record.scope, options.gameWorkspace)) {
      const commit = name === HARNESS_WORKSPACE ? record.git.harness : record.git.game;
      if (commit) targets.push({ name, dir: this.dirFor(name), commit });
    }
    // Every check and the rescue come before any reset, so a refusal leaves every workspace as it was.
    let rescue: SnapshotRecord | null = null;
    for (const { name, dir, commit } of targets) {
      if (name === HARNESS_WORKSPACE) continue;
      await this.#refuseMidOperation(name, dir);
      await this.#refuseMovedHistory(name, dir, commit, record.git.gameBranch);
      try {
        rescue = await this.snapshot({
          scope: SnapshotScope.Game,
          gameWorkspace: name,
          reason: MESSAGE.RescueReason(record.snapshot_id),
        });
      } catch (err) {
        if (err instanceof SnapshotRefusedError) throw err;
        throw new SnapshotRefusedError(SnapshotRefusal.RescueFailed, name, MESSAGE.RescueFailed(errorMessage(err)));
      }
    }
    for (const { name, dir, commit } of targets) await this.#resetTo(name, dir, commit);
    return rescue;
  }

  /**
   * Put a workspace back to `commit` and remove what it did not hold. What a game's rules ignore
   * now stayed out of its rescue, so it is never cleaned either: an older save point's ignore file
   * may not name the engine's scratch yet, so its owner writes those rules back into it (`keepIgnoring`).
   */
  async #resetTo(name: string, dir: string, commit: string): Promise<void> {
    const kept = name === HARNESS_WORKSPACE ? [] : (this.#ruleLines.get(dir) ?? []);
    await git(dir, ["reset", "-q", "--hard", "--end-of-options", commit]);
    if (kept.length > 0) await this.keepIgnoring?.({ name, dir }, kept).catch(() => {});
    await git(dir, ["clean", "-qfd", ...kept.flatMap((line) => ["-e", line])]);
    await this.afterRestore?.({ name, dir });
  }

  /** `refs/heads/<branch>`, or null when HEAD is detached. */
  async #branchOf(dir: string): Promise<string | null> {
    return (await gitOrNull(dir, ["symbolic-ref", "-q", "HEAD"]))?.trim() || null;
  }

  async #refuseMidOperation(name: string, dir: string): Promise<void> {
    for (const marker of OPERATIONS_IN_PROGRESS) {
      const where = (await gitOrNull(dir, ["rev-parse", "--git-path", marker]))?.trim();
      if (where && (await pathExists(path.resolve(dir, where)))) {
        throw new SnapshotRefusedError(SnapshotRefusal.OperationInProgress, name, MESSAGE.OperationInProgress(marker));
      }
    }
  }

  /**
   * The folder must still be where the studio left it: on the branch the snapshot was taken on,
   * at the snapshot or a descendant of it made only of the studio's own commits. Anything else is
   * the user's history, and a reset would drop it from their branch.
   */
  async #refuseMovedHistory(
    name: string,
    dir: string,
    commit: string,
    branch: string | null | undefined,
  ): Promise<void> {
    if (branch !== undefined) {
      const now = await this.#branchOf(dir);
      if (now !== branch) {
        throw new SnapshotRefusedError(SnapshotRefusal.BranchChanged, name, MESSAGE.BranchChanged(now, branch));
      }
    }
    if ((await gitOrNull(dir, ["merge-base", "--is-ancestor", "--end-of-options", commit, "HEAD"])) === null) {
      throw new SnapshotRefusedError(SnapshotRefusal.HistoryChanged, name, MESSAGE.NotDescendant);
    }
    // The branch's own line only: work a studio merge brought in arrives through that merge
    // commit, which is the studio's, whoever wrote the commits on the merged side (R1).
    const identities = (
      await git(dir, ["log", "--first-parent", "--format=%ae%n%ce", "--end-of-options", `${commit}..HEAD`])
    )
      .split("\n")
      .filter(Boolean);
    if (identities.some((email) => email !== STUDIO_COMMITTER.email)) {
      throw new SnapshotRefusedError(SnapshotRefusal.HistoryChanged, name, MESSAGE.ForeignCommits);
    }
  }

  /**
   * A playable fork of a game workspace at a snapshot — pairs with an event-log fork.
   *
   * `versionNested` is the user's answer to "may the studio version the repositories inside my
   * game folder": with it, the fork's copy of a nested repository is
   * committed here, so a worker's edits inside it are real work the studio can keep, roll back
   * and merge. Without it the copy is what it always was — files to read and run, versioned by
   * nothing.
   */
  async worktreeAt(
    workspace: string,
    commit: string,
    targetDir: string,
    options: { versionNested?: boolean; skip?: (rel: string) => boolean } = {},
  ): Promise<string> {
    const dir = this.dirFor(workspace);
    const skip = options.skip ?? (() => false);
    const resolved = await resolveCommit(dir, commit);
    await git(dir, ["worktree", "add", "--detach", "-f", "--end-of-options", targetDir, resolved]);
    // A game with its own build needs its dependencies in the copy too: node_modules is
    // ignored by git, so the worktree gets a link to the workspace's own.
    await this.#linkModules(dir, targetDir, "");
    // A nested git repository inside the game (the user's own project dropped into the folder)
    // is a bare pointer in the studio's history and an empty directory in a worktree. Copy its
    // working tree in (without its .git) so agents see and run the game.
    const nested = await this.nestedRepositories(workspace, resolved);
    for (const rel of nested) {
      const source = path.join(dir, rel);
      const target = path.join(targetDir, rel);
      if (!(await pathExists(source))) continue;
      await cp(source, target, {
        recursive: true,
        force: true,
        // Besides its history and packages, what the game's copy rules leave out (`skip`, by the
        // path inside the game): an engine's scratch a worker never needs.
        filter: (from) => !NEVER_COPIED.has(path.basename(from)) && !skip(gameRelative(dir, from)),
      }).catch(() => {});
    }
    if (options.versionNested) await this.#versionNested(targetDir, nested, resolved);
    // After the conversion, never before: a link is not a file the studio may commit into
    // somebody's game.
    for (const rel of nested) await this.#linkModules(dir, targetDir, rel);
    return targetDir;
  }

  /**
   * Link a folder's installed packages into the fork instead of installing them again (142 MB
   * for the game that produced this rule), so the game's own build runs where its package.json
   * is. Only where git ignores that path: an untracked symlink is swept up by the next
   * `git add -A`, and a landed one would point the user's game at itself.
   */
  async #linkModules(repoDir: string, targetDir: string, rel: string): Promise<void> {
    const relPath = rel ? `${rel}/node_modules` : "node_modules";
    const modules = path.join(repoDir, relPath);
    const linked = path.join(targetDir, relPath);
    if (!(await pathExists(modules)) || (await pathExists(linked))) return;
    // `check-ignore -q` says nothing and exits 0 when the path is ignored; null is "not ignored".
    if ((await gitOrNull(targetDir, ["check-ignore", "-q", "--", relPath])) === null) return;
    await symlink(modules, linked, "dir").catch(() => {});
  }

  /**
   * Replace the pointers to the game's own repositories with the files themselves — in this fork
   * only. A gitlink is committed by nothing: a worker's edits under `wreckage/` never reached an
   * "accepted" commit, survived a lost iteration's `reset --hard`, or landed. The live folder keeps its pointer until the user agrees to the same conversion
   * at landing (`studio-core.landBuild`).
   *
   * The commit is deterministic — same parent, same files, same identity, same date as the commit
   * it forks from — so two forks of one commit produce the *same* conversion commit. That makes
   * merging one fork into another a plain three-way merge instead of an add/add conflict on every
   * file of the game.
   */
  async #versionNested(targetDir: string, nested: string[], commit: string): Promise<void> {
    const staged: string[] = [];
    for (const rel of nested) {
      if (!(await pathExists(path.join(targetDir, rel)))) continue;
      await gitOrNull(targetDir, ["rm", "-r", "-q", "--cached", "--", rel]);
      await gitOrNull(targetDir, ["add", "--", rel]);
      staged.push(rel);
    }
    if (staged.length === 0) return;
    const date = (await gitOrNull(targetDir, ["show", "-s", "--format=%cI", "--end-of-options", commit]))?.trim();
    await gitOrNull(
      targetDir,
      ["commit", "-q", "-m", `studio: version ${staged.join(", ")} — the game's own repositories`],
      date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {},
    );
  }

  /**
   * What a worker's copy of `commit` would take: every file the commit tracks (a copy checks them
   * all out) and the working files of each nested repository that the copy receives (`skip` names
   * what it leaves out, by the path inside the game; links are never followed), by top-level
   * folder, largest first.
   */
  async copySize(workspace: string, commit: string, skip: (rel: string) => boolean): Promise<CopySize> {
    const dir = this.dirFor(workspace);
    const resolved = await resolveCommit(dir, commit);
    const byFolder = new Map<string, number>();
    const add = (rel: string, bytes: number) => {
      const folder = rel.split("/")[0] ?? rel;
      byFolder.set(folder, (byFolder.get(folder) ?? 0) + bytes);
    };
    for (const entry of (await git(dir, ["ls-tree", "-r", "-l", "-z", "--end-of-options", resolved])).split("\0")) {
      const blob = TRACKED_BLOB.exec(entry);
      if (blob?.[1] && blob[2]) add(blob[2], Number(blob[1]));
    }
    for (const rel of await this.nestedRepositories(workspace, resolved)) await tallyNested(dir, rel, { skip, add });
    const folders = [...byFolder]
      .map(([folder, bytes]) => ({ folder, bytes }))
      .sort((a, b) => b.bytes - a.bytes || a.folder.localeCompare(b.folder));
    return { bytes: folders.reduce((sum, folder) => sum + folder.bytes, 0), folders };
  }

  /** Paths a commit records as nested repositories (gitlinks, mode 160000). */
  async nestedRepositories(workspace: string, commit: string): Promise<string[]> {
    const listing = commit.startsWith("-")
      ? ""
      : ((await gitOrNull(this.dirFor(workspace), ["ls-tree", "-r", "--end-of-options", commit])) ?? "");
    return listing
      .split("\n")
      .filter((line) => line.startsWith("160000 "))
      .map((line) => line.split("\t")[1] ?? "")
      .filter(Boolean);
  }

  async removeWorktree(workspace: string, targetDir: string): Promise<void> {
    await gitOrNull(this.dirFor(workspace), ["worktree", "remove", "--force", targetDir]);
  }

  /** Unified diff between two snapshots — or, with no `toCommit`, out to the working tree. */
  async diff(workspace: string, fromCommit: string, toCommit?: string): Promise<string> {
    // A self-change newer than every snapshot exists only as uncommitted files, so "up to now"
    // must mean the working tree, not HEAD — HEAD is still the snapshot the change sits on.
    const dir = this.dirFor(workspace);
    const from = await resolveCommit(dir, fromCommit);
    const to = toCommit ? await resolveCommit(dir, toCommit) : null;
    const args = ["diff", "--stat", "-p", "--end-of-options", from, ...(to ? [to] : [])];
    return (await gitOrNull(dir, args)) ?? "";
  }

  /**
   * A change as a patch: `paths` (all when empty) between two commits, or from a commit out to
   * the working tree. `binary` makes it applicable; without it, it is for reading.
   */
  async patch(
    workspace: string,
    fromCommit: string,
    toCommit: string | undefined,
    paths: string[],
    options: { binary?: boolean } = {},
  ): Promise<string> {
    const dir = this.dirFor(workspace);
    const from = await resolveCommit(dir, fromCommit);
    const to = toCommit ? await resolveCommit(dir, toCommit) : null;
    return git(dir, [
      "diff",
      ...(options.binary === false ? [] : ["--binary"]),
      "--end-of-options",
      from,
      ...(to ? [to] : []),
      "--",
      ...paths,
    ]);
  }

  /**
   * Apply a patch to the working tree. All or nothing: `--check` runs first, so a patch that no
   * longer fits (a later change rewrote the same lines) changes nothing and throws.
   */
  async applyPatch(
    workspace: string,
    patch: string,
    options: { reverse?: boolean; zeroContext?: boolean } = {},
  ): Promise<void> {
    const dir = this.dirFor(workspace);
    // Inside .git: never swept into a snapshot by `add -A`, never removed by `clean`.
    const file = path.join(dir, ".git", "studio-change.patch");
    await writeFile(file, patch);
    const args = [
      "apply",
      ...(options.reverse ? ["-R"] : []),
      ...(options.zeroContext ? ["--unidiff-zero"] : []),
      "--whitespace=nowarn",
    ];
    await git(dir, [...args, "--check", file]);
    await git(dir, [...args, file]);
  }

  /**
   * Take one change back in the working tree and leave everything else as it is: the diff of
   * `paths` between two commits, reversed. The usual context-matched patch first. When a later
   * edit touched the lines around it — a learned change appends at the end of its file, and so
   * does the next one — the same diff without context, found by the lines the change added. A
   * change that only deleted lines has nothing to find and is refused rather than guessed at.
   * False when there was nothing to take back.
   */
  async revert(workspace: string, fromCommit: string, toCommit: string | undefined, paths: string[]): Promise<boolean> {
    const patch = await this.patch(workspace, fromCommit, toCommit, paths);
    if (!patch.trim()) return false;
    try {
      await this.applyPatch(workspace, patch, { reverse: true });
    } catch (err) {
      const dir = this.dirFor(workspace);
      const from = await resolveCommit(dir, fromCommit);
      const to = toCommit ? await resolveCommit(dir, toCommit) : null;
      const bare = await git(dir, [
        "diff",
        "-U0",
        "--binary",
        "--end-of-options",
        from,
        ...(to ? [to] : []),
        "--",
        ...paths,
      ]);
      if (/^@@ -\d+(?:,\d+)? \+\d+,0 @@/m.test(bare)) throw err;
      await this.applyPatch(workspace, bare, { reverse: true, zeroContext: true });
    }
    return true;
  }

  /** Paths that differ between two commits. */
  async changedPaths(workspace: string, fromCommit: string, toCommit: string): Promise<string[]> {
    const dir = this.dirFor(workspace);
    const out = await git(dir, [
      "diff",
      "--name-only",
      "--end-of-options",
      await resolveCommit(dir, fromCommit),
      await resolveCommit(dir, toCommit),
    ]);
    return out.split("\n").filter(Boolean);
  }

  async currentCommit(workspace: string): Promise<string> {
    return (await git(this.dirFor(workspace), ["rev-parse", "HEAD"])).trim();
  }

  /** Paths whose working-tree state differs from HEAD, untracked files included. */
  async uncommittedPaths(workspace: string): Promise<string[]> {
    const dir = this.dirFor(workspace);
    const changed = await git(dir, ["diff", "--name-only", "HEAD"]);
    const untracked = await git(dir, ["ls-files", "--others", "--exclude-standard"]);
    return `${changed}\n${untracked}`.split("\n").filter(Boolean);
  }

  async fileAt(workspace: string, commit: string, relPath: string): Promise<string | null> {
    if (commit.startsWith("-")) return null;
    return await gitOrNull(this.dirFor(workspace), ["show", "--end-of-options", `${commit}:${relPath}`]);
  }
}

/**
 * Index of snapshots derived from the event log. The log is the source of truth; this is a
 * disposable cache that any process can rebuild by replaying `snapshot_created` /
 * `workspace_restored` events.
 */
export class SnapshotIndex {
  readonly #records = new Map<string, SnapshotRecord>();
  readonly #order: string[] = [];

  add(record: SnapshotRecord): void {
    if (!this.#records.has(record.snapshot_id)) this.#order.push(record.snapshot_id);
    this.#records.set(record.snapshot_id, record);
  }

  markHealthy(snapshotId: string): void {
    const record = this.#records.get(snapshotId);
    if (!record) return;
    record.healthy = true;
    delete record.harness_healthy;
  }

  get(snapshotId: string): SnapshotRecord | undefined {
    return this.#records.get(snapshotId);
  }

  all(): SnapshotRecord[] {
    return this.#order
      .map((id) => this.#records.get(id))
      .filter((record): record is SnapshotRecord => record !== undefined);
  }

  /** Newest snapshot known to have run a full turn — the watchdog's rewind target. */
  newestHealthy(scope?: SnapshotScope): SnapshotRecord | undefined {
    for (const id of [...this.#order].reverse()) {
      const record = this.#records.get(id);
      if (record && rewindsScope(record, scope)) return record;
    }
    return undefined;
  }

  newest(): SnapshotRecord | undefined {
    const last = this.#order.at(-1);
    return last === undefined ? undefined : this.#records.get(last);
  }
}

/**
 * Whether a snapshot is a rewind target for `scope`: healthy, covering that scope, and — for a
 * harness rewind — not marked as a harness that failed to run.
 */
function rewindsScope(record: SnapshotRecord, scope?: SnapshotScope): boolean {
  if (!record.healthy) return false;
  const covers = !scope || record.scope === scope || record.scope === SnapshotScope.Both;
  if (!covers) return false;
  return !(scope === SnapshotScope.Harness && record.harness_healthy === false);
}
