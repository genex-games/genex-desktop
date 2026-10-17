/**
 * A worker's copy of a game: what it leaves out, and when it is too large to make.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { SnapshotScope } from "../../src/shared/event-log.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { PluginSourceKind } from "../../src/shared/plugins.ts";
import {
  ensureRepo,
  git,
  SnapshotEngine,
  SnapshotRefusal,
  SnapshotRefusedError,
} from "../../src/substrate/snapshots.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { copyProject, Project, TOY_PLUGIN, TOY_PLUGIN_ID } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

const KB = 1024;
/** The nested repository the person dropped into their game. */
const NESTED = "vendor-game";

/** Write files into a folder, making their folders. */
async function writeIn(dir: string, files: Record<string, string>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
}

/** Whether a path exists, without following a link. */
const exists = (file: string) =>
  lstat(file).then(
    () => true,
    () => false,
  );

/** The answer `snapshot.worktree` gives the harness. */
type Copy = { path: string; commit: string };

/** Make a worker's copy of a game the way the harness asks for one. */
async function workerCopy(lite: CoreLite, project: string, name: string): Promise<Copy> {
  const call = lite.api()[HostMethod.SnapshotWorktree] as (p: Record<string, unknown>) => Promise<Copy>;
  return call({ project, name, runId: "run-copy" });
}

/** Where `snapshot.worktree` puts a copy named `name`. */
const copyDir = (lite: CoreLite, name: string) =>
  path.join(path.resolve(lite.core.layout.scratch), "autopilot", "run-copy", name);

describe("a worker's copy", () => {
  let lite: CoreLite;
  let cases: string;
  before(async () => {
    const root = await realpath(await tmpDir("studio-writer-copy-"));
    cases = path.join(root, "cases");
    await mkdir(cases);
    lite = await coreLite({
      gamesRoot: path.join(root, "games"),
      executionPolicy: { allowedProjectRoot: root, runBackgroundImprovement: false },
      writerCopyMaxBytes: 256 * KB,
    });
    await lite.core.plugins.installLocal(TOY_PLUGIN, PluginSourceKind.Local, []);
    await lite.core.plugins.setEnabled(TOY_PLUGIN_ID, true);
  });
  after(async () => {
    lite.core.plugins.cancel();
    await lite.close();
  });

  /** A web game holding a repository of its own: a Godot and toy project with scratch of both. */
  async function gameWithNestedProject(caseName: string) {
    const into = path.join(cases, caseName);
    await mkdir(into);
    const dir = await copyProject(Project.WebFolder, into);
    const game = await lite.core.adoptProject(dir);
    const nested = path.join(dir, NESTED);
    await writeIn(nested, { "project.godot": "[application]\n", "Garden.toyproj": "toy\n", "src/z": "z\n" });
    await ensureRepo(nested);
    await writeIn(nested, { ".godot/x": "imported\n", "Cache/y": "cache\n", "Exports/e": "export\n" });
    await lite.core.snapshot(SnapshotScope.Game, "the nested project", game.name);
    return { dir, game };
  }

  it("leaves a nested project's ignored and skipped files out of the copy", async () => {
    const { game } = await gameWithNestedProject("plain");
    const copy = await workerCopy(lite, game.name, "plain");
    const inCopy = (rel: string) => exists(path.join(copy.path, NESTED, rel));
    assert.equal(await inCopy("src/z"), true, "the nested project's own files are copied");
    assert.equal(await inCopy(".godot/x"), false, "Godot's scratch, by the nested Godot project's rule");
    assert.equal(await inCopy("Cache/y"), false, "the toy engine's cache, by the plugin's rules");
    assert.equal(await inCopy("Exports/e"), false, "what the plugin's copySkip names");
  });

  it("with the nested projects versioned, leaves out only what history ignores", async () => {
    const { dir, game } = await gameWithNestedProject("versioned");
    const meta = JSON.parse(await readFile(path.join(dir, "studio.json"), "utf8"));
    await writeFile(path.join(dir, "studio.json"), `${JSON.stringify({ ...meta, versionNested: true }, null, 2)}\n`);
    const copy = await workerCopy(lite, game.name, "versioned");
    const inCopy = (rel: string) => exists(path.join(copy.path, NESTED, rel));
    assert.equal(await inCopy("src/z"), true);
    assert.equal(await inCopy("Exports/e"), true, "copySkip alone leaves out nothing a copy versions");
    assert.equal(await inCopy(".godot/x"), false, "ignored scratch is still left out");
    assert.equal(await inCopy("Cache/y"), false);
  });

  it("refuses a copy above the cap and makes nothing", async () => {
    const into = path.join(cases, "large");
    await mkdir(into);
    const dir = await copyProject(Project.WebFolder, into);
    await writeFile(path.join(dir, "level.bin"), Buffer.alloc(300 * KB, 1));
    const game = await lite.core.adoptProject(dir);
    await lite.core.snapshot(SnapshotScope.Game, "a large level", game.name);
    const worktreesBefore = await git(dir, ["worktree", "list", "--porcelain"]);

    await assert.rejects(workerCopy(lite, game.name, "large"), (err: unknown) => {
      assert.ok(err instanceof SnapshotRefusedError, String(err));
      assert.equal(err.code, SnapshotRefusal.CopyTooLarge);
      assert.match(err.message, /more than/);
      assert.match(err.message, /level\.bin/, "it names where the size is");
      return true;
    });
    assert.equal(await exists(copyDir(lite, "large")), false, "no copy was made");
    assert.equal(await git(dir, ["worktree", "list", "--porcelain"]), worktreesBefore, "git knows of no new copy");
  });

  it("every copy of a game too large to copy is refused in words for whoever asked", async () => {
    const into = path.join(cases, "any-caller");
    await mkdir(into);
    const dir = await copyProject(Project.WebFolder, into);
    await writeFile(path.join(dir, "level.bin"), Buffer.alloc(300 * KB, 1));
    const game = await lite.core.adoptProject(dir);
    await lite.core.snapshot(SnapshotScope.Game, "a large level", game.name);
    // A build's integration copy, a play copy, a facet's and a worker's: the copy is the whole game.
    for (const name of ["integration", "play-1", "spike-a", "w1"]) {
      await assert.rejects(workerCopy(lite, game.name, name), (err: unknown) => {
        assert.ok(err instanceof SnapshotRefusedError, String(err));
        assert.match(
          err.message,
          /^This game is too large to copy, so nothing that needs its own copy of it can start; work in the game folder itself\. A copy would take [\d.]+ KB, more than the 256 KB allowed \(most of it in level\.bin 300 KB, .*\)\.$/,
          name,
        );
        assert.doesNotMatch(err.message, /worker|smaller task/, "no advice a copy of any size would refuse");
        return true;
      });
    }
  });

  it("a refused copy removes nothing: an earlier copy of that name stays with its files", async () => {
    const into = path.join(cases, "grown");
    await mkdir(into);
    const dir = await copyProject(Project.WebFolder, into);
    const game = await lite.core.adoptProject(dir);
    const earlier = await workerCopy(lite, game.name, "grown");
    await writeIn(earlier.path, { "work.js": "the worker's edit\n" });
    await writeFile(path.join(dir, "level.bin"), Buffer.alloc(300 * KB, 1));
    await lite.core.snapshot(SnapshotScope.Game, "a large level", game.name);
    const worktreesBefore = await git(dir, ["worktree", "list", "--porcelain"]);
    assert.ok(worktreesBefore.includes(earlier.path), "git knows of the earlier copy");
    await assert.rejects(workerCopy(lite, game.name, "grown"), (err: unknown) => {
      assert.ok(err instanceof SnapshotRefusedError, String(err));
      assert.equal(err.code, SnapshotRefusal.CopyTooLarge);
      return true;
    });
    assert.equal(await readFile(path.join(earlier.path, "work.js"), "utf8"), "the worker's edit\n");
    assert.equal(
      await readFile(path.join(earlier.path, "index.html"), "utf8"),
      await readFile(path.join(dir, "index.html"), "utf8"),
    );
    assert.equal(await git(dir, ["worktree", "list", "--porcelain"]), worktreesBefore, "git still lists it");
  });

  it("copies the same game when the cap allows it", async () => {
    const roomy = await coreLite({
      gamesRoot: path.join(cases, "roomy-games"),
      executionPolicy: { allowedProjectRoot: cases, runBackgroundImprovement: false },
      writerCopyMaxBytes: 1024 * KB,
    });
    const into = path.join(cases, "roomy");
    await mkdir(into);
    const dir = await copyProject(Project.WebFolder, into);
    await writeFile(path.join(dir, "level.bin"), Buffer.alloc(300 * KB, 1));
    const game = await roomy.core.adoptProject(dir);
    const copy = await workerCopy(roomy, game.name, "roomy");
    assert.equal(await exists(path.join(copy.path, "level.bin")), true);
  });
});

describe("a copy's size", () => {
  it("counts tracked files and nested files, largest folder first", async () => {
    const dir = path.join(await tmpDir("studio-copy-size-"), "game");
    await writeIn(dir, { "Content/a": "a".repeat(3 * KB), "Source/b": "b".repeat(KB) });
    await writeIn(path.join(dir, NESTED), { "c.txt": "c".repeat(2 * KB) });
    await ensureRepo(path.join(dir, NESTED));
    // Not counted: what the copy never receives.
    await writeIn(path.join(dir, NESTED), { "node_modules/p/i.js": "p".repeat(5 * KB), "skipped/s": "s".repeat(KB) });
    // Nor what a link inside it points at: a copy receives the link, never the file.
    const outside = path.join(await tmpDir("studio-copy-size-outside-"), "big");
    await writeFile(outside, "o".repeat(10 * KB));
    await symlink(outside, path.join(dir, NESTED, "big-link"));
    await symlink(path.dirname(outside), path.join(dir, NESTED, "folder-link"));
    const engine = new SnapshotEngine([{ name: "game", dir }]);
    await engine.init();
    const commit = await engine.currentCommit("game");

    const size = await engine.copySize("game", commit, (rel) => rel === `${NESTED}/skipped`);
    assert.equal(size.bytes, 6 * KB);
    assert.deepEqual(size.folders, [
      { folder: "Content", bytes: 3 * KB },
      { folder: NESTED, bytes: 2 * KB },
      { folder: "Source", bytes: KB },
    ]);
  });
});
