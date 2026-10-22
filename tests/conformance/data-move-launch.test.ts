/**
 * The launch that moves Genex's data: the files go to the new folder, the record says where they
 * are (or why they are not), and what pointed into the old folder points into the new one: the
 * library's absolute folders, and every build copy's Git worktree, whether its repository stayed
 * (a game in the games folder) or moved too (the harness's own). A move cut short carries on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, readlink, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATA_FOLDER_FILE, readDataFolderRecord, writeDataFolderRecord } from "../../src/main/data-folder.ts";
import { finishMove, removeLeftover, runDataMove } from "../../src/main/data-move-launch.ts";
import { DataFolderProblem, type DataMoveProgress } from "../../src/shared/data-folder.ts";
import { DataMoveError, moveData } from "../../src/substrate/data-move.ts";
import { claudeProjectDirName } from "../../src/substrate/engines/claude-permissions.ts";
import { rebasePaths } from "../../src/substrate/data-relink.ts";
import { samePath } from "../../src/substrate/paths.ts";
import { gitFile } from "../helpers/git.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

const COMMITTER = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await gitFile(["-C", dir, ...args], { env: { ...process.env, ...COMMITTER } });
  return String(stdout);
}

/** Whether `repo` lists a worktree at `dir` (Git spells it with forward slashes on Windows). */
async function listsWorktree(repo: string, dir: string): Promise<boolean> {
  const listed = (await git(repo, "worktree", "list", "--porcelain"))
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length)));
  return listed.some((at) => samePath(at, dir));
}

/** A repository with one commit, and a worktree of it at `worktree`. */
async function repoWithCopy(repo: string, worktree: string): Promise<void> {
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-q");
  await writeFile(path.join(repo, "main.js"), "console.log(1)\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "first");
  await mkdir(path.dirname(worktree), { recursive: true });
  await git(repo, "worktree", "add", "-q", "--detach", worktree);
}

/** Genex's default data folder with the record, a library index, a game copy kept inside and two build copies. */
async function machine(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await tmpDir("data-launch-"));
  t.after(() => removeTree(root));
  const from = path.join(root, "AppData", "Genex");
  const to = path.join(root, "D", "Genex");
  const game = path.join(root, "AI Games", "Racer");
  const keptCopy = path.join(from, "opened-copies", "Puzzle");
  await mkdir(to, { recursive: true });
  await repoWithCopy(game, path.join(from, "scratch", "autopilot", "run-1"));
  await repoWithCopy(path.join(from, "workspaces", "harness"), path.join(from, "scratch", "self-edit", "check-1"));
  await mkdir(keptCopy, { recursive: true });
  await writeFile(
    path.join(from, "projects.json"),
    JSON.stringify({ version: 1, aliases: { Racer: game, Puzzle: keptCopy }, presentation: { [keptCopy]: {} } }),
  );
  await writeDataFolderRecord(from, { moveTo: to });
  return { root, from, to, game, keptCopy };
}

const MINUTE = 60_000;

const ACROSS_VOLUMES: typeof moveData = (plan, options) =>
  moveData(plan, { ...options, sameVolume: async () => false, freeBytes: async () => Number.MAX_SAFE_INTEGER });

function deps(m: { from: string; to: string }, move?: typeof moveData) {
  const progress: DataMoveProgress[] = [];
  const log: string[] = [];
  return {
    progress,
    log,
    deps: {
      from: m.from,
      to: m.to,
      defaultDir: m.from,
      progress: (p: DataMoveProgress) => progress.push(p),
      log: (line: string) => log.push(line),
      ...(move ? { move } : {}),
    },
  };
}

for (const [label, move] of [
  ["on one volume", undefined],
  ["across volumes", ACROSS_VOLUMES],
] as const) {
  test(`a move ${label} records the new folder and leaves every build copy working`, async (t) => {
    const m = await machine(t);
    const run = deps(m, move);
    const outcome = await runDataMove(run.deps);
    assert.equal(outcome.moved, true);
    assert.deepEqual(readDataFolderRecord(m.from), { dir: m.to });
    assert.deepEqual(await readdir(m.from), [DATA_FOLDER_FILE], "only the record stays behind");

    const index = JSON.parse(await readFile(path.join(m.to, "projects.json"), "utf8"));
    const movedCopy = path.join(m.to, "opened-copies", "Puzzle");
    assert.deepEqual(index.aliases, { Racer: m.game, Puzzle: movedCopy });
    assert.deepEqual(Object.keys(index.presentation), [movedCopy]);

    const runCopy = path.join(m.to, "scratch", "autopilot", "run-1");
    const selfEdit = path.join(m.to, "scratch", "self-edit", "check-1");
    assert.equal(await git(runCopy, "status", "--porcelain"), "");
    assert.equal(await git(selfEdit, "status", "--porcelain"), "");
    assert.ok(await listsWorktree(m.game, runCopy), "the game's repository knows where its copy is");
    assert.ok(await listsWorktree(path.join(m.to, "workspaces", "harness"), selfEdit), "so does the moved harness");
    // A prune (as a clean-up runs) must keep the moved copies: their repositories know where they are.
    await git(m.game, "worktree", "prune");
    assert.ok(await listsWorktree(m.game, runCopy), "the game's repository knows where its copy is");
  });
}

test("a copy reports its progress toward the new folder", async (t) => {
  const m = await machine(t);
  const run = deps(m, ACROSS_VOLUMES);
  await runDataMove(run.deps);
  assert.ok(run.progress.every((p) => p.to === m.to));
  const last = run.progress.at(-1);
  assert.ok(last && last.total > 0 && last.done === last.total);
});

test("a move that cannot happen leaves the data where it was and records why", async (t) => {
  const m = await machine(t);
  await writeFile(path.join(m.to, "someone-else.txt"), "x");
  const before = await readdir(m.from);
  const run = deps(m, ACROSS_VOLUMES);
  assert.deepEqual(await runDataMove(run.deps), { moved: false, problem: DataFolderProblem.NotEmpty });
  assert.deepEqual(readDataFolderRecord(m.from), { failed: { to: m.to, problem: DataFolderProblem.NotEmpty } });
  assert.deepEqual(await readdir(m.from), before);
  assert.deepEqual(await readdir(m.to), ["someone-else.txt"]);
});

test("a copy cut short carries on: half-copied entries are copied again, the rest copied once", async (t) => {
  const m = await machine(t);
  // The earlier attempt recorded its entries, copied part of `scratch`, then Genex closed.
  await writeDataFolderRecord(m.from, {
    moveTo: m.to,
    moving: ["opened-copies", "projects.json", "scratch", "workspaces"],
  });
  await mkdir(path.join(m.to, "scratch", "autopilot"), { recursive: true });
  await writeFile(path.join(m.to, "scratch", "autopilot", "half.bin"), "partial");
  await runDataMove(deps(m, ACROSS_VOLUMES).deps);
  assert.deepEqual(readDataFolderRecord(m.from), { dir: m.to });
  assert.deepEqual((await readdir(m.to)).sort(), ["opened-copies", "projects.json", "scratch", "workspaces"]);
  assert.deepEqual(await readdir(path.join(m.to, "scratch", "autopilot")), ["run-1"], "the half copy is gone");
});

test("renames cut short carry on: what was renamed stays, the rest follows", async (t) => {
  const m = await machine(t);
  await writeDataFolderRecord(m.from, {
    moveTo: m.to,
    moving: ["opened-copies", "projects.json", "scratch", "workspaces"],
  });
  const { rename } = await import("node:fs/promises");
  await rename(path.join(m.from, "opened-copies"), path.join(m.to, "opened-copies"));
  await runDataMove(deps(m).deps);
  assert.deepEqual((await readdir(m.to)).sort(), ["opened-copies", "projects.json", "scratch", "workspaces"]);
  assert.deepEqual(await readdir(m.from), [DATA_FOLDER_FILE]);
});

test("a later launch removes only the entries the move recorded and could not remove", async (t) => {
  const m = await machine(t);
  await writeFile(path.join(m.from, "not-ours.txt"), "keep");
  await writeDataFolderRecord(m.from, {
    dir: m.to,
    leftover: [{ dir: m.from, entries: ["scratch", "../escape"], since: Date.now() + MINUTE }],
  });
  const log: string[] = [];
  await removeLeftover(m.from, m.to, (line) => log.push(line));
  const left = (await readdir(m.from)).sort();
  assert.ok(!left.includes("scratch"));
  assert.ok(left.includes("not-ours.txt") && left.includes("workspaces"));
  assert.deepEqual(readDataFolderRecord(m.from), { dir: m.to }, "a name that is a path is never read back");
});

test("paths keep their place when the data moves: inside the old folder only, keys too", () => {
  const from = path.resolve("/old/Genex");
  const to = path.resolve("/new/Genex");
  assert.deepEqual(
    rebasePaths(
      {
        a: path.join(from, "x"),
        b: path.resolve("/old/GenexOther/y"),
        c: "relative/x",
        list: [from, 3, null],
        [path.join(from, "k")]: true,
      },
      from,
      to,
    ),
    {
      a: path.join(to, "x"),
      b: path.resolve("/old/GenexOther/y"),
      c: "relative/x",
      list: [to, 3, null],
      [path.join(to, "k")]: true,
    },
  );
});

test("a move that cannot put everything back stays recorded and carries on at the next start", async (t) => {
  const m = await machine(t);
  const stranded: typeof moveData = async () => {
    throw new DataMoveError(DataFolderProblem.InUse, "EBUSY: scratch", { stranded: ["scratch"], left: [] });
  };
  await writeDataFolderRecord(m.from, {
    moveTo: m.to,
    moving: ["opened-copies", "projects.json", "scratch", "workspaces"],
  });
  const outcome = await runDataMove(deps(m, stranded).deps);
  assert.deepEqual(outcome, { moved: false, problem: DataFolderProblem.InUse, stranded: ["scratch"] });
  assert.deepEqual(readDataFolderRecord(m.from), {
    moveTo: m.to,
    moving: ["opened-copies", "projects.json", "scratch", "workspaces"],
    failed: { to: m.to, problem: DataFolderProblem.InUse },
  });
});

test("a failed move's own copies it could not remove are listed, and removed at the next start", async (t) => {
  const m = await machine(t);
  const leftCopy: typeof moveData = async (plan) => {
    await mkdir(path.join(plan.to, "scratch"), { recursive: true });
    throw new DataMoveError(DataFolderProblem.InUse, "EBUSY", { stranded: [], left: ["scratch"] });
  };
  await runDataMove(deps(m, leftCopy).deps);
  const record = readDataFolderRecord(m.from);
  assert.deepEqual(record.failed, { to: m.to, problem: DataFolderProblem.InUse });
  assert.equal(record.moveTo, undefined);
  assert.deepEqual(
    record.leftover?.map(({ dir, entries }) => ({ dir, entries })),
    [{ dir: m.to, entries: ["scratch"] }],
  );
  await removeLeftover(m.from, m.from, () => {});
  assert.deepEqual(await readdir(m.to), [], "no file in a failed move's copy counts as an edit");
  assert.equal(readDataFolderRecord(m.from).leftover, undefined);
});

test("an earlier move's leftovers stay listed through the next move, and ones in its target go first", async (t) => {
  const m = await machine(t);
  const elsewhere = path.join(m.root, "E", "Genex");
  await mkdir(path.join(elsewhere, "old"), { recursive: true });
  await mkdir(path.join(m.to, "scratch"), { recursive: true });
  await writeFile(path.join(m.to, "scratch", "stale.txt"), "old copy");
  const later = Date.now() + MINUTE;
  await writeDataFolderRecord(m.from, {
    moveTo: m.to,
    leftover: [
      { dir: elsewhere, entries: ["old"], since: later },
      { dir: m.to, entries: ["scratch"], since: later },
    ],
  });
  const outcome = await runDataMove(deps(m, ACROSS_VOLUMES).deps);
  assert.equal(outcome.moved, true, "the stale copy in the target was cleared before the move");
  const record = readDataFolderRecord(m.from);
  assert.deepEqual(
    record.leftover?.map(({ dir }) => dir),
    [elsewhere],
    "the one elsewhere is still listed",
  );
  // Git may check the copy out with Windows line endings.
  assert.match(
    await readFile(path.join(m.to, "scratch", "autopilot", "run-1", "main.js"), "utf8"),
    /^console\.log\(1\)\r?\n$/,
  );
});

test("a left copy someone changed after the move stays; untouched ones go", async (t) => {
  const m = await machine(t);
  const old = path.join(m.root, "old-data");
  await mkdir(path.join(old, "edited"), { recursive: true });
  await mkdir(path.join(old, "untouched"), { recursive: true });
  await writeFile(path.join(old, "edited", "level.tscn"), "before");
  await writeFile(path.join(old, "untouched", "level.tscn"), "before");
  const since = Date.now() - MINUTE;
  const { utimes } = await import("node:fs/promises");
  const before = new Date(since - MINUTE);
  await utimes(path.join(old, "untouched", "level.tscn"), before, before);
  await utimes(path.join(old, "edited", "level.tscn"), before, before);
  await writeFile(path.join(old, "edited", "level.tscn"), "edited in another editor after the copy");
  await writeDataFolderRecord(m.from, { dir: m.to, leftover: [{ dir: old, entries: ["edited", "untouched"], since }] });
  const log: string[] = [];
  await removeLeftover(m.from, m.to, (line) => log.push(line));
  assert.deepEqual(await readdir(old), ["edited"]);
  assert.deepEqual(
    readDataFolderRecord(m.from).leftover?.map(({ entries }) => entries),
    [["edited"]],
  );
  assert.ok(log.some((line) => line.includes("changed after the move")));
});

test("links into the old folder follow the data; links elsewhere stay as they were", async (t) => {
  const m = await machine(t);
  const outside = path.join(m.root, "AI Games", "Racer");
  const shadow = path.join(m.from, "scratch", "builds", "puzzle-1");
  await mkdir(path.join(m.keptCopy, "node_modules"), { recursive: true });
  await mkdir(shadow, { recursive: true });
  await symlink(path.join(m.keptCopy, "node_modules"), path.join(shadow, "node_modules"), "junction");
  await symlink(outside, path.join(m.from, "scratch", "builds", "racer-link"), "junction");
  await runDataMove(deps(m, ACROSS_VOLUMES).deps);
  const movedShadow = path.join(m.to, "scratch", "builds", "puzzle-1", "node_modules");
  assert.equal(path.resolve(await readlink(movedShadow)), path.join(m.to, "opened-copies", "Puzzle", "node_modules"));
  assert.equal(path.resolve(await readlink(path.join(m.to, "scratch", "builds", "racer-link"))), outside);
});

test("Claude Code's sessions of the moved folders follow them; a neighbour with a similar name keeps its own", async (t) => {
  const m = await machine(t);
  const projects = path.join(m.from, "engine-homes", "claude-code", "projects");
  const runCopy = path.join(m.from, "scratch", "autopilot", "run-1");
  const neighbour = claudeProjectDirName(`${m.from} Games${path.sep}Racer`);
  for (const name of [claudeProjectDirName(runCopy), neighbour]) {
    await mkdir(path.join(projects, name), { recursive: true });
    await writeFile(path.join(projects, name, "session-1.jsonl"), "{}\n");
  }
  await runDataMove(deps(m, ACROSS_VOLUMES).deps);
  const moved = path.join(m.to, "engine-homes", "claude-code", "projects");
  const names = (await readdir(moved)).sort();
  assert.deepEqual(names, [claudeProjectDirName(path.join(m.to, "scratch", "autopilot", "run-1")), neighbour].sort());
});

test("a move Genex closed after recording, before repairing, is repaired at the next start", async (t) => {
  const m = await machine(t);
  // The move renamed everything and wrote its record; Genex closed before any repair.
  const { rename } = await import("node:fs/promises");
  for (const name of ["opened-copies", "projects.json", "scratch", "workspaces"])
    await rename(path.join(m.from, name), path.join(m.to, name));
  await writeDataFolderRecord(m.from, { dir: m.to, relinkFrom: m.from });
  await finishMove(m.from, m.to, { log: () => {} });
  assert.deepEqual(readDataFolderRecord(m.from), { dir: m.to }, "repaired once, then cleared");
  const runCopy = path.join(m.to, "scratch", "autopilot", "run-1");
  assert.equal(await git(runCopy, "status", "--porcelain"), "");
  assert.ok(await listsWorktree(m.game, runCopy));
  const index = JSON.parse(await readFile(path.join(m.to, "projects.json"), "utf8"));
  assert.equal(index.aliases.Puzzle, path.join(m.to, "opened-copies", "Puzzle"));
});

test("with no Git to repair build copies, the other repairs still run", async (t) => {
  const m = await machine(t);
  const projects = path.join(m.from, "engine-homes", "claude-code", "projects");
  const runCopy = path.join(m.from, "scratch", "autopilot", "run-1");
  await mkdir(path.join(projects, claudeProjectDirName(runCopy)), { recursive: true });
  const run = deps(m, ACROSS_VOLUMES);
  await runDataMove({ ...run.deps, hostGit: async () => false });
  assert.ok(run.log.some((line) => line.includes("no Git to repair")));
  const moved = await readdir(path.join(m.to, "engine-homes", "claude-code", "projects"));
  assert.deepEqual(moved, [claudeProjectDirName(path.join(m.to, "scratch", "autopilot", "run-1"))]);
  const index = JSON.parse(await readFile(path.join(m.to, "projects.json"), "utf8"));
  assert.equal(index.aliases.Puzzle, path.join(m.to, "opened-copies", "Puzzle"));
});

test("a left entry that holds the folder in use is never removed", async (t) => {
  const m = await machine(t);
  const holder = path.join(m.root, "D");
  await writeDataFolderRecord(m.from, {
    dir: m.to,
    leftover: [{ dir: m.root, entries: ["D"], since: Date.now() + MINUTE }],
  });
  await removeLeftover(m.from, m.to, () => {});
  assert.ok((await readdir(holder)).includes("Genex"), "the data folder is still there");
});

test("a moving launch records each entry as it moves, so carrying on knows which side is the data", async (t) => {
  const m = await machine(t);
  const seen: Array<Record<string, string> | undefined> = [];
  const watching: typeof moveData = (plan, options) =>
    moveData(plan, {
      ...options,
      onEntryMoved: async (name, how) => {
        await options?.onEntryMoved?.(name, how);
        seen.push(readDataFolderRecord(m.from).done);
      },
    });
  await runDataMove(deps(m, watching).deps);
  assert.deepEqual(seen.at(-1), {
    "opened-copies": "renamed",
    "projects.json": "renamed",
    scratch: "renamed",
    workspaces: "renamed",
  });
  assert.deepEqual(readDataFolderRecord(m.from), { dir: m.to }, "the journal goes once the move is recorded");
});

/** Every file under `dir` last changed at `when` (links left alone). */
async function ageFiles(dir: string, when: Date): Promise<void> {
  const { lstat, utimes } = await import("node:fs/promises");
  for (const name of await readdir(dir)) {
    const entry = path.join(dir, name);
    const info = await lstat(entry);
    if (info.isDirectory()) await ageFiles(entry, when);
    else if (info.isFile()) await utimes(entry, when, when);
  }
}

test("an original edited between two attempts of a move stays: the first attempt's start counts", async (t) => {
  const m = await machine(t);
  const firstStart = Date.now() - 10 * MINUTE;
  // Everything was there before the first attempt; it copied scratch, then Genex closed, and an
  // editor changed one original meanwhile.
  const { cp, utimes } = await import("node:fs/promises");
  await ageFiles(m.from, new Date(firstStart - MINUTE));
  await cp(path.join(m.from, "scratch"), path.join(m.to, "scratch"), { recursive: true, verbatimSymlinks: true });
  const edited = path.join(m.from, "scratch", "autopilot", "run-1", "main.js");
  await writeFile(edited, "edited between the attempts");
  const between = new Date(firstStart + MINUTE);
  await utimes(edited, between, between);
  await writeDataFolderRecord(m.from, {
    moveTo: m.to,
    moving: ["opened-copies", "projects.json", "scratch", "workspaces"],
    movingSince: firstStart,
    done: { scratch: "copied" },
  });
  await runDataMove(deps(m, ACROSS_VOLUMES).deps);
  assert.equal(await readFile(edited, "utf8"), "edited between the attempts", "the edit is not removed");
  const kept = readDataFolderRecord(m.from).leftover?.find((item) => item.changed);
  assert.deepEqual(kept?.entries, ["scratch"]);
});

test("what was written under a renamed entry's old name stays, and Storage names it", async (t) => {
  const m = await machine(t);
  const { rename } = await import("node:fs/promises");
  await rename(path.join(m.from, "scratch"), path.join(m.to, "scratch"));
  await mkdir(path.join(m.from, "scratch"));
  await writeFile(path.join(m.from, "scratch", "late.log"), "written after the rename");
  await writeDataFolderRecord(m.from, {
    moveTo: m.to,
    moving: ["opened-copies", "projects.json", "scratch", "workspaces"],
    done: { scratch: "renamed" },
  });
  await runDataMove(deps(m).deps);
  await removeLeftover(m.from, m.to, () => {});
  assert.equal(await readFile(path.join(m.from, "scratch", "late.log"), "utf8"), "written after the rename");
  assert.deepEqual(
    readDataFolderRecord(m.from).leftover?.map(({ dir, entries, changed }) => ({ dir, entries, changed })),
    [{ dir: m.from, entries: ["scratch"], changed: true }],
  );
});

test("repairs and clean-up run only for the folder the record says is in use", async (t) => {
  const m = await machine(t);
  const other = path.join(m.root, "dev-profile", "core");
  await mkdir(other, { recursive: true });
  const leftover = [{ dir: m.root, entries: ["AI Games"], since: Date.now() + MINUTE }];
  await writeDataFolderRecord(m.from, { dir: m.to, relinkFrom: m.from, leftover });
  await finishMove(m.from, other, { log: () => {} });
  await removeLeftover(m.from, other, () => {});
  assert.deepEqual(readDataFolderRecord(m.from), { dir: m.to, relinkFrom: m.from, leftover });
  assert.ok((await readdir(m.root)).includes("AI Games"));
});
