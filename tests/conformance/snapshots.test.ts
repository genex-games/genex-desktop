/**
 * Snapshot engine conformance.
 *
 * Backs hard constraint #3: a broken self-edit can never permanently kill the studio. Every
 * assertion here is about that promise being mechanically true, not merely intended.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { EventStore } from "../../src/substrate/event-store.ts";
import {
  SnapshotEngine,
  SnapshotIndex,
  STUDIO_COMMITTER,
  ensureRepo,
  git,
  snapshotRef,
} from "../../src/substrate/snapshots.ts";
import { NESTED_BACKUP, nestedRepos, versionNestedForLanding } from "../../src/substrate/game-workspace.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { shellExec as sh } from "../helpers/posix-shell.ts";
import { workspaceContentStamp } from "../../src/substrate/workspace-content.ts";
import { SnapshotScope } from "../../src/shared/event-log.ts";
import { dirtyUserRepo, fixtureGit, nestedUserRepo } from "../helpers/snapshot-fixtures.ts";

const exists = (target: string): Promise<boolean> =>
  stat(target).then(
    () => true,
    () => false,
  );

it("new game snapshots exclude environment secrets even without a project ignore file", async () => {
  const dir = await tmpDir();
  await writeFile(path.join(dir, "index.html"), "playable");
  await writeFile(path.join(dir, ".env.local"), "FIXTURE_TOKEN=synthetic-secret");
  await mkdir(path.join(dir, "nested"));
  await writeFile(path.join(dir, "nested", ".env.production"), "FIXTURE_TOKEN=synthetic-secret");
  const engine = new SnapshotEngine([{ name: "game", dir }]);
  await engine.init();
  await engine.snapshot({ scope: SnapshotScope.Game, gameWorkspace: "game", reason: "save" });
  assert.equal((await git(dir, ["ls-files", "--", ".env.local", "nested/.env.production"])).trim(), "");
  assert.equal(await readFile(path.join(dir, ".env.local"), "utf8"), "FIXTURE_TOKEN=synthetic-secret");
});

it("host staging of a nested repository also excludes newly introduced environment files", async () => {
  const dir = await tmpDir();
  await ensureRepo(dir);
  await mkdir(path.join(dir, "nested"));
  await writeFile(path.join(dir, "nested", "index.html"), "playable");
  await writeFile(path.join(dir, "nested", ".env.local"), "FIXTURE_TOKEN=synthetic");
  await git(dir, ["add", "--", "nested"]);
  const staged = await git(dir, ["diff", "--cached", "--name-only"]);
  assert.ok(staged.includes("nested/index.html"));
  assert.ok(!staged.includes(".env.local"));
});

/**
 * A project folder holding the user's own game one level down, as a repository of its own with
 * its own build and its own packages — a shape that can lose a run's work. Git records `wreckage/` as a pointer, not as files.
 */
async function nestedGame(): Promise<{ engine: SnapshotEngine; live: string; wreckage: string }> {
  const live = path.join(await tmpDir("studio-nested-"), "stunt");
  await mkdir(path.join(live, "src"), { recursive: true });
  await writeFile(path.join(live, "index.html"), "<h1>the studio's own page</h1>\n");
  await writeFile(path.join(live, ".gitignore"), "export/\n.DS_Store\n.studio/\nnode_modules\n.git.studio-backup\n");

  const wreckage = path.join(live, "wreckage");
  await mkdir(path.join(wreckage, "src"), { recursive: true });
  await writeFile(path.join(wreckage, ".gitignore"), "node_modules/\ndist/\n");
  await writeFile(path.join(wreckage, "src", "main.js"), "export const speed = 1;\n");
  await writeFile(
    path.join(wreckage, "package.json"),
    JSON.stringify({ name: "wreckage", type: "module", scripts: { build: "node build.mjs" } }),
  );
  // Its build imports a package: without the game's own node_modules in the fork it cannot run.
  await writeFile(
    path.join(wreckage, "build.mjs"),
    [
      'import { bundle } from "bundler";',
      'import { writeFile, mkdir } from "node:fs/promises";',
      'await mkdir("dist", { recursive: true });',
      'await writeFile("dist/index.html", bundle());',
      "",
    ].join("\n"),
  );
  await mkdir(path.join(wreckage, "node_modules", "bundler"), { recursive: true });
  await writeFile(
    path.join(wreckage, "node_modules", "bundler", "package.json"),
    JSON.stringify({ name: "bundler", type: "module", main: "index.js" }),
  );
  await writeFile(
    path.join(wreckage, "node_modules", "bundler", "index.js"),
    "export const bundle = () => '<h1>built</h1>';\n",
  );
  await ensureRepo(wreckage); // the game keeps its own history

  const engine = new SnapshotEngine([{ name: "stunt", dir: live }]);
  await engine.init(); // …and the studio's history records it as a pointer
  return { engine, live, wreckage };
}

async function harnessWorkspace(): Promise<{ engine: SnapshotEngine; dir: string; games: string }> {
  const root = await tmpDir("studio-snap-");
  const dir = path.join(root, "workspaces", "harness");
  const games = path.join(root, "workspaces", "games", "pong");
  await mkdir(dir, { recursive: true });
  await mkdir(games, { recursive: true });
  await writeFile(path.join(dir, "loop.mjs"), "export const version = 1;\n");
  await writeFile(path.join(games, "index.html"), "<h1>v1</h1>\n");
  const engine = new SnapshotEngine([
    { name: "harness", dir },
    { name: "pong", dir: games },
  ]);
  await engine.init();
  return { engine, dir, games };
}

describe("snapshot engine", () => {
  it("commits, tags and restores a workspace exactly", async () => {
    const { engine, dir } = await harnessWorkspace();
    const good = await engine.snapshot({ scope: "harness", reason: "before self-edit", healthy: true });
    assert.ok(good.git.harness, "snapshot records the commit hash");

    // The agent breaks itself: edits a file and adds a new broken one.
    await writeFile(path.join(dir, "loop.mjs"), "syntax error !!!\n");
    await writeFile(path.join(dir, "broken-tool.mjs"), "throw new Error('boom')\n");

    await engine.restore(good);
    assert.equal(await readFile(path.join(dir, "loop.mjs"), "utf8"), "export const version = 1;\n");
    await assert.rejects(() => readFile(path.join(dir, "broken-tool.mjs"), "utf8"), /ENOENT/);

    // Bookmarked on a ref of the studio's own — never a tag. A tag shows in `git tag` and
    // `git push --tags` would ship one snapshot per run to somebody's remote (M2.7).
    assert.equal((await git(dir, ["tag", "--list"])).trim(), "");
    assert.equal((await git(dir, ["rev-parse", snapshotRef(good.snapshot_id)])).trim(), good.git.harness);
    assert.match(
      await git(dir, ["for-each-ref", "--format=%(refname)", "refs/studio/"]),
      new RegExp(snapshotRef(good.snapshot_id)),
    );
  });

  it("commits under one name, so a run leaves one committer in the user's log", async () => {
    const { engine, games } = await harnessWorkspace();
    await writeFile(path.join(games, "index.html"), "<h1>v2</h1>\n");
    await engine.snapshot({ scope: "game", reason: "iteration 1", gameWorkspace: "pong" });
    // Author and committer, every commit in the game: the substrate's initial one and the
    // snapshot on top of it, never a studio identity in the user's history.
    const who = new Set((await git(games, ["log", "--format=%an|%ae|%cn|%ce"])).trim().split("\n"));
    assert.deepEqual(
      [...who],
      [`${STUDIO_COMMITTER.name}|${STUDIO_COMMITTER.email}|${STUDIO_COMMITTER.name}|${STUDIO_COMMITTER.email}`],
    );
  });

  it("snapshots both workspaces under scope 'both' and keeps them independently restorable", async () => {
    const { engine, dir, games } = await harnessWorkspace();
    const first = await engine.snapshot({ scope: "both", reason: "iteration 1", gameWorkspace: "pong" });
    assert.ok(first.git.harness && first.git.game);

    await writeFile(path.join(games, "index.html"), "<h1>v2 regression</h1>\n");
    await writeFile(path.join(dir, "loop.mjs"), "export const version = 2;\n");
    await engine.snapshot({ scope: "both", reason: "iteration 2", gameWorkspace: "pong" });

    // Restore only the game (the gauntlet's "challenger lost, keep the incumbent" path).
    await engine.restore({ ...first, scope: "game" }, { gameWorkspace: "pong" });
    assert.equal(await readFile(path.join(games, "index.html"), "utf8"), "<h1>v1</h1>\n");
    assert.equal(await readFile(path.join(dir, "loop.mjs"), "utf8"), "export const version = 2;\n");
  });

  it("produces a reviewable diff between snapshots (the self-change UI's data)", async () => {
    const { engine, dir } = await harnessWorkspace();
    const before = await engine.snapshot({ scope: "harness", reason: "before" });
    await writeFile(path.join(dir, "loop.mjs"), "export const version = 2; // agent edit\n");
    const after = await engine.snapshot({ scope: "harness", reason: "after" });
    const diff = await engine.diff("harness", before.git.harness!, after.git.harness!);
    assert.match(diff, /loop\.mjs/);
    assert.match(diff, /\+export const version = 2; \/\/ agent edit/);
  });

  it("creates a playable worktree at an old snapshot without touching the live tree", async () => {
    const { engine, games } = await harnessWorkspace();
    const v1 = await engine.snapshot({ scope: "game", reason: "v1", gameWorkspace: "pong" });
    await writeFile(path.join(games, "index.html"), "<h1>v2</h1>\n");
    await engine.snapshot({ scope: "game", reason: "v2", gameWorkspace: "pong" });

    const forkDir = path.join(await tmpDir("studio-fork-"), "pong-fork");
    await engine.worktreeAt("pong", v1.git.game!, forkDir);
    assert.equal(await readFile(path.join(forkDir, "index.html"), "utf8"), "<h1>v1</h1>\n");
    assert.equal(await readFile(path.join(games, "index.html"), "utf8"), "<h1>v2</h1>\n");
    await engine.removeWorktree("pong", forkDir);
  });

  it("keeps a snapshot addressable even when nothing changed", async () => {
    const { engine } = await harnessWorkspace();
    const a = await engine.snapshot({ scope: "harness", reason: "idle" });
    const b = await engine.snapshot({ scope: "harness", reason: "idle again" });
    assert.notEqual(a.snapshot_id, b.snapshot_id);
    assert.notEqual(a.git.harness, b.git.harness, "empty commits still advance the timeline");
  });

  it("finishes the housekeeping a host commit starts before the commit resolves", async () => {
    // Git hands a commit's auto-maintenance to a detached process by default: it kept writing into
    // a harness `.git` after `StudioCore.stop()` resolved, and the teardown that removed the folder
    // failed with ENOTEMPTY. Two packs over a limit of one make the next commit repack.
    const { engine, dir } = await harnessWorkspace();
    await git(dir, ["repack", "-d", "-q"]);
    await writeFile(path.join(dir, "loop.mjs"), "export const version = 2;\n");
    await engine.snapshot({ scope: "harness", reason: "second pack" });
    await git(dir, ["repack", "-d", "-q"]);
    await git(dir, ["config", "gc.autoPackLimit", "1"]);
    const packs = async () =>
      (await readdir(path.join(dir, ".git", "objects", "pack"))).filter((file) => file.endsWith(".pack"));
    assert.equal((await packs()).length, 2);
    await git(dir, ["commit", "-q", "--allow-empty", "-m", "after edit"]);
    assert.equal((await packs()).length, 1, "the repack ran inside the commit, not after it");
  });

  it("is idempotent about repo creation", async () => {
    const dir = path.join(await tmpDir(), "ws");
    await ensureRepo(dir);
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    await ensureRepo(dir);
    assert.equal((await git(dir, ["rev-parse", "HEAD"])).trim(), head);
  });
});

/**
 * The game inside the folder is opened as *the* game by default, and a
 * user who keeps the parent lets the studio version it instead. Everything below is the second
 * half — what "versioned" has to mean for a run's work to survive.
 */
describe("a game that brought its own repository", () => {
  it("keeps a worker's edit inside it: committed when accepted, undone when lost, landed when live", async () => {
    const { engine, live, wreckage } = await nestedGame();
    const base = await engine.snapshot({ scope: "game", reason: "before the run", gameWorkspace: "stunt" });
    assert.deepEqual(
      await engine.nestedRepositories("stunt", base.git.game!),
      ["wreckage"],
      "the studio's history holds a pointer",
    );

    const fork = path.join(await tmpDir("studio-fork-"), "worker-a");
    await engine.worktreeAt("stunt", base.git.game!, fork, { versionNested: true });

    // The worker improves the game the user actually brought.
    await writeFile(path.join(fork, "wreckage", "src", "main.js"), "export const speed = 2; // worker\n");
    assert.match(
      await git(fork, ["status", "--porcelain"]),
      /wreckage\/src\/main\.js/,
      "the edit is work the studio can see",
    );

    // facet-loop's own two commands — this is what "accepted" is made of.
    await git(fork, ["add", "-A"]);
    await git(fork, ["commit", "-q", "-m", "facet a iteration 1: accepted"]);
    const accepted = (await git(fork, ["rev-parse", "HEAD"])).trim();
    assert.match(
      await git(fork, ["show", "--name-only", "--format=", accepted]),
      /wreckage\/src\/main\.js/,
      "the accepted commit contains it",
    );

    // …and the lost-iteration path: the attempt goes, the game stays.
    await writeFile(path.join(fork, "wreckage", "src", "main.js"), "export const speed = 99; // lost attempt\n");
    await writeFile(path.join(fork, "wreckage", "src", "extra.js"), "// half a spike\n");
    await git(fork, ["reset", "-q", "--hard"]);
    await git(fork, ["clean", "-qfd"]);
    assert.match(
      await readFile(path.join(fork, "wreckage", "src", "main.js"), "utf8"),
      /speed = 2/,
      "the kept round survives the reset",
    );
    assert.equal(await exists(path.join(fork, "wreckage", "src", "extra.js")), false, "the lost attempt does not");

    // Landing: the folder is converted with the consent the Open Game sheet recorded, then the
    // build merges in as any build does.
    const converted = await versionNestedForLanding(live, accepted, { consent: true });
    assert.deepEqual(converted, ["wreckage"]);
    assert.equal(
      (await git(live, ["status", "--porcelain"])).trim(),
      "",
      "the game folder is clean, so a landing may proceed",
    );
    assert.ok(await exists(path.join(wreckage, NESTED_BACKUP)), "the game's own history is kept, not deleted");
    await git(live, ["merge", "--no-ff", "-m", "studio: landed build", accepted]);
    assert.match(
      await readFile(path.join(wreckage, "src", "main.js"), "utf8"),
      /speed = 2/,
      "the user plays what the judge kept",
    );
    assert.equal((await git(live, ["status", "--porcelain"])).trim(), "", "and nothing is left uncommitted behind it");
  });

  it("runs the game's own build in a worker's copy, and never commits the link that lets it", async () => {
    const { engine, live } = await nestedGame();
    const base = await engine.snapshot({ scope: "game", reason: "before the run", gameWorkspace: "stunt" });
    const fork = path.join(await tmpDir("studio-fork-"), "worker-b");
    await engine.worktreeAt("stunt", base.git.game!, fork, { versionNested: true });

    // Through the platform's POSIX shell, as a build runs (Windows' npm is a script execFile cannot
    // start). npm's "> build" banner is the evidence; a parent `npm run --silent` would pass its
    // loglevel down and hide it.
    const built = await sh("unset npm_config_loglevel; npm run build", path.join(fork, "wreckage"));
    assert.equal(built.code, 0, built.stderr);
    assert.match(built.stdout + built.stderr, /build\.mjs|dist/i);
    assert.match(await readFile(path.join(fork, "wreckage", "dist", "index.html"), "utf8"), /built/);
    assert.equal(
      await exists(path.join(live, "wreckage", "dist")),
      false,
      "the fork builds, the user's folder is untouched",
    );

    // The packages are linked in, not copied — and git must never see that link: an untracked
    // symlink is swept up by `git add -A` and would land pointing at the user's own machine.
    assert.equal((await git(fork, ["status", "--porcelain"])).trim(), "", "the fork is clean after its own build");
    await git(fork, ["add", "-A"]);
    assert.doesNotMatch(await git(fork, ["diff", "--cached", "--name-only"]), /node_modules/);
  });

  it("refuses when the user has staged work of their own, rather than committing it as the studio", async () => {
    const { engine, live, wreckage } = await nestedGame();
    const base = await engine.snapshot({ scope: "game", reason: "before the run", gameWorkspace: "stunt" });
    const fork = path.join(await tmpDir("studio-fork-"), "worker-e");
    await engine.worktreeAt("stunt", base.git.game!, fork, { versionNested: true });
    const carried = (await git(fork, ["rev-parse", "HEAD"])).trim();

    // The conversion commits `write-tree` of the whole live index, and `reset --soft` then leaves
    // index and HEAD equal — so anything the user had staged was swept into a commit signed by
    // the studio, and the landing's own dirty check saw a clean folder afterwards.
    await writeFile(path.join(live, "src", "mine.js"), "export const mine = 1;\n");
    await git(live, ["add", "--", "src/mine.js"]);
    await assert.rejects(
      () => versionNestedForLanding(live, carried, { consent: true }),
      /staged for its own next commit/,
      "their next commit is theirs",
    );
    assert.ok(await exists(path.join(wreckage, ".git")), "and the game is still a repository of its own");
    assert.equal(await exists(path.join(wreckage, NESTED_BACKUP)), false);
    assert.match(
      await git(live, ["diff", "--cached", "--name-only"]),
      /src\/mine\.js/,
      "their staged work is untouched",
    );

    // Committed by them, the same conversion goes through.
    await git(live, ["commit", "-q", "-m", "mine"]);
    assert.deepEqual(await versionNestedForLanding(live, carried, { consent: true }), ["wreckage"]);
  });

  it("leaves the folder exactly as it was when the user did not agree", async () => {
    const { engine, live, wreckage } = await nestedGame();
    const base = await engine.snapshot({ scope: "game", reason: "before the run", gameWorkspace: "stunt" });
    const fork = path.join(await tmpDir("studio-fork-"), "worker-c");
    // No consent: the fork is a copy to read and run, versioned by nothing — as it always was.
    await engine.worktreeAt("stunt", base.git.game!, fork);
    await writeFile(path.join(fork, "wreckage", "src", "main.js"), "export const speed = 3;\n");
    assert.equal((await git(fork, ["status", "--porcelain"])).trim(), "", "an unversioned copy hides the edit");
    await git(fork, ["add", "-A"]);
    await git(fork, ["commit", "-q", "--allow-empty", "-m", "facet a iteration 1: accepted"]);
    assert.deepEqual(
      await versionNestedForLanding(live, (await git(fork, ["rev-parse", "HEAD"])).trim(), { consent: false }),
      [],
      "a build that carries nothing under it converts nothing",
    );

    // And a build that *does* carry those files — a fork made while the answer was yes, landed
    // into a folder whose answer is no — is refused rather than written.
    const versioned = path.join(await tmpDir("studio-fork-"), "worker-d");
    await engine.worktreeAt("stunt", base.git.game!, versioned, { versionNested: true });
    const carried = (await git(versioned, ["rev-parse", "HEAD"])).trim();
    await assert.rejects(
      () => versionNestedForLanding(live, carried, { consent: false }),
      /The game in wreckage\/ keeps its own version history/,
      "nothing is converted without the consent step",
    );
    assert.ok(await exists(path.join(wreckage, ".git")), "the game keeps its own .git");
    assert.equal(await exists(path.join(wreckage, NESTED_BACKUP)), false);
    assert.match(
      await git(live, ["ls-tree", "HEAD", "--", "wreckage"]),
      /^160000 commit/,
      "and the studio's history still holds a pointer",
    );
    assert.deepEqual(await nestedRepos(live), ["wreckage"]);
  });
});

describe("snapshot index (derived from the log)", () => {
  it("finds the newest healthy snapshot — the watchdog's rewind target", () => {
    const index = new SnapshotIndex();
    const mk = (id: string, healthy: boolean) => ({
      snapshot_id: id,
      scope: "harness" as const,
      git: { harness: id },
      created_at: new Date().toISOString(),
      reason: "test",
      healthy,
    });
    index.add(mk("s1", true));
    index.add(mk("s2", true));
    index.add(mk("s3", false)); // the self-edit that broke everything
    assert.equal(index.newestHealthy()?.snapshot_id, "s2");
    assert.equal(index.newest()?.snapshot_id, "s3");
    index.markHealthy("s3");
    assert.equal(index.newestHealthy()?.snapshot_id, "s3");
  });

  it("rebuilds from the event log alone", async () => {
    const store = await EventStore.open(path.join(await tmpDir(), "exoharness"), "studio");
    const thread = await store.createThread();
    await store.appendEvents(thread, [
      {
        type: "snapshot_created",
        snapshot_id: "snap_a",
        scope: "harness",
        git: { harness: "aaa" },
        healthy: true,
      },
      {
        type: "snapshot_created",
        snapshot_id: "snap_b",
        scope: "harness",
        git: { harness: "bbb" },
        healthy: false,
      },
      { type: "workspace_restored", snapshot_id: "snap_a", reason: "watchdog", scope: "harness" },
    ]);

    const index = new SnapshotIndex();
    for (const event of await store.listEvents(thread)) {
      if (event.data.type === "snapshot_created") {
        index.add({
          snapshot_id: event.data.snapshot_id,
          scope: event.data.scope,
          git: event.data.git,
          created_at: event.created_at,
          reason: event.data.reason ?? "",
          healthy: event.data.healthy ?? false,
        });
      }
    }
    assert.deepEqual(
      index.all().map((s) => s.snapshot_id),
      ["snap_a", "snap_b"],
    );
    assert.equal(index.newestHealthy()?.snapshot_id, "snap_a");
  });
});

describe("one change, taken back on its own (Undo this change)", () => {
  it("reverses the change in its own file and leaves later changes and other files alone", async () => {
    const { engine, dir } = await harnessWorkspace();
    await writeFile(path.join(dir, "aim.md"), "# aim\n\n- lead the target\n");
    const before = await engine.snapshot({ scope: "harness", reason: "skillopt: approved edits to aim" });
    await writeFile(path.join(dir, "aim.md"), "# aim\n\n- lead the target\n- clamp pitch to 35 degrees\n");
    const after = await engine.snapshot({ scope: "harness", reason: "after self-change: aim.md" });
    // Later: another change to the same file, a ledger line, and an app update to code.
    await writeFile(
      path.join(dir, "aim.md"),
      "# aim\n\n- lead the target\n- clamp pitch to 35 degrees\n\n## Later\n- keep the horizon level\n",
    );
    await writeFile(path.join(dir, "ledger.jsonl"), '{"decision":"kept"}\n');
    await writeFile(path.join(dir, "loop.mjs"), "export const version = 3;\n");

    const patch = await engine.patch("harness", before.git.harness!, after.git.harness!, ["aim.md"]);
    assert.match(patch, /\+- clamp pitch to 35 degrees/);
    assert.doesNotMatch(patch, /loop\.mjs|ledger/);
    // The change sat at the end of its file and the later one was appended right after it, so
    // the context-matched patch no longer fits; the change's own lines still do.
    assert.equal(await engine.revert("harness", before.git.harness!, after.git.harness!, ["aim.md"]), true);

    assert.equal(
      await readFile(path.join(dir, "aim.md"), "utf8"),
      "# aim\n\n- lead the target\n\n## Later\n- keep the horizon level\n",
    );
    assert.equal(await readFile(path.join(dir, "ledger.jsonl"), "utf8"), '{"decision":"kept"}\n');
    assert.equal(await readFile(path.join(dir, "loop.mjs"), "utf8"), "export const version = 3;\n");
  });

  it("refuses, changing nothing, when a later change rewrote the same lines", async () => {
    const { engine, dir } = await harnessWorkspace();
    await writeFile(path.join(dir, "aim.md"), "# aim\n- lead the target\n");
    const before = await engine.snapshot({ scope: "harness", reason: "skillopt: approved edits to aim" });
    await writeFile(path.join(dir, "aim.md"), "# aim\n- lead the target by a car length\n");
    const after = await engine.snapshot({ scope: "harness", reason: "after self-change: aim.md" });
    await writeFile(path.join(dir, "aim.md"), "# aim\n- lead the target by half a car length\n");

    await assert.rejects(engine.revert("harness", before.git.harness!, after.git.harness!, ["aim.md"]));
    assert.equal(await readFile(path.join(dir, "aim.md"), "utf8"), "# aim\n- lead the target by half a car length\n");
  });

  it("will not guess where a change that only deleted lines belongs once its surroundings moved", async () => {
    const { engine, dir } = await harnessWorkspace();
    await writeFile(path.join(dir, "aim.md"), "# aim\n- lead the target\n- never brake\n- aim low\n");
    const before = await engine.snapshot({ scope: "harness", reason: "skillopt: approved edits to aim" });
    await writeFile(path.join(dir, "aim.md"), "# aim\n- lead the target\n- aim low\n");
    const after = await engine.snapshot({ scope: "harness", reason: "after self-change: aim.md" });
    await writeFile(path.join(dir, "aim.md"), "# aim\n- lead the moving target\n- aim lower\n");

    await assert.rejects(engine.revert("harness", before.git.harness!, after.git.harness!, ["aim.md"]));
    assert.equal(await readFile(path.join(dir, "aim.md"), "utf8"), "# aim\n- lead the moving target\n- aim lower\n");
    assert.equal(
      await engine.revert("harness", after.git.harness!, after.git.harness!, ["aim.md"]),
      false,
      "nothing to take back",
    );
  });
});

describe("workspace cleanup", () => {
  it("removes stale worktrees without corrupting the repo", async () => {
    const { engine, games } = await harnessWorkspace();
    const snap = await engine.snapshot({ scope: "game", reason: "v1", gameWorkspace: "pong" });
    const forkDir = path.join(await tmpDir("studio-fork-"), "gone");
    await engine.worktreeAt("pong", snap.git.game!, forkDir);
    await rm(forkDir, { recursive: true, force: true });
    await engine.removeWorktree("pong", forkDir);
    // Repo still usable after the worktree vanished from under it.
    await engine.snapshot({ scope: "game", reason: "after cleanup", gameWorkspace: "pong" });
    assert.ok(await engine.currentCommit("pong"));
    assert.ok(games);
  });
});

/**
 * Characterization of today's behaviour on folders the user already versions, pinned before the
 * snapshot code is refactored. A later change that means to alter any of this names the flip.
 */
describe("snapshots of the user's own repository (characterization)", () => {
  it("records every uncommitted, staged and untracked file, and restore brings each one back", async () => {
    const repo = await dirtyUserRepo();
    assert.deepEqual(await repo.status(), ["A  src/level.js", " M src/main.js", "?? notes/ideas.md"]);
    const engine = new SnapshotEngine([{ name: "game", dir: repo.dir }]);
    await engine.init();
    const before = await engine.snapshot({ scope: "game", reason: "before the run", gameWorkspace: "game" });
    // Today the snapshot is a commit on the user's own branch, on top of their history.
    assert.equal(await fixtureGit(repo.dir, ["branch", "--show-current"]), "main");
    assert.equal(await fixtureGit(repo.dir, ["rev-parse", "HEAD"]), before.git.game);
    assert.equal(await fixtureGit(repo.dir, ["rev-parse", "HEAD~1"]), repo.head);
    assert.deepEqual(await repo.status(), []);

    // The run breaks an edit, deletes a note and leaves junk behind.
    await writeFile(path.join(repo.dir, "src/main.js"), "broken\n");
    await rm(path.join(repo.dir, "notes/ideas.md"));
    await writeFile(path.join(repo.dir, "junk.js"), "junk\n");
    await engine.restore(before, { gameWorkspace: "game" });
    assert.equal(await readFile(path.join(repo.dir, "src/main.js"), "utf8"), repo.spec.modified["src/main.js"]);
    assert.equal(await readFile(path.join(repo.dir, "src/level.js"), "utf8"), repo.spec.staged["src/level.js"]);
    assert.equal(await readFile(path.join(repo.dir, "notes/ideas.md"), "utf8"), repo.spec.untracked["notes/ideas.md"]);
    assert.equal(await exists(path.join(repo.dir, "junk.js")), false);
    assert.deepEqual(await repo.status(), []);
  });

  it("leaves a repository one level down alone when the folder around it is snapshotted", async () => {
    const { parent, inner, rel } = await nestedUserRepo({ parentRepo: true });
    assert.deepEqual(await nestedRepos(parent), [rel]);
    const dirty = await inner.status();
    const engine = new SnapshotEngine([{ name: "project", dir: parent }]);
    await engine.init();
    await engine.snapshot({ scope: "game", reason: "before the run", gameWorkspace: "project" });
    assert.deepEqual(await inner.status(), dirty, "the inner repo's own uncommitted work is not touched");
    assert.equal(await fixtureGit(inner.dir, ["rev-parse", "HEAD"]), inner.head, "nor is its history");
  });
});

/**
 * A restore is `reset --hard` plus `clean -fd` in a folder the user may still be working in.
 * Before one runs, everything in the folder is committed to a rescue snapshot (and the restore
 * is refused when that cannot be done), and the folder must still be on the branch the studio
 * snapshotted, with nothing but the studio's own commits on top of it (GDS-3, GDS-4).
 */
describe("restoring a game the user may still be working in", () => {
  async function snapshotted() {
    const repo = await dirtyUserRepo();
    const engine = new SnapshotEngine([{ name: "game", dir: repo.dir }]);
    await engine.init();
    const before = await engine.snapshot({ scope: "game", reason: "before the round", gameWorkspace: "game" });
    return { repo, engine, before };
  }

  it("records the branch the snapshot was taken on", async () => {
    const { before } = await snapshotted();
    assert.equal(before.git.gameBranch, "refs/heads/main");
  });

  it("commits what the folder holds to a rescue snapshot first, so an edit made during the round survives the restore", async () => {
    const { repo, engine, before } = await snapshotted();
    // While the round is judged, the user edits a file and drops in art of their own.
    await writeFile(path.join(repo.dir, "src/main.js"), "export const speed = 3; // edited during the run\n");
    await mkdir(path.join(repo.dir, "assets"), { recursive: true });
    await writeFile(path.join(repo.dir, "assets/hero.txt"), "the user's own art\n");
    const rescue = await engine.restore(before, { gameWorkspace: "game" });
    // The restore itself still happens…
    assert.equal(await readFile(path.join(repo.dir, "src/main.js"), "utf8"), repo.spec.modified["src/main.js"]);
    assert.equal(await exists(path.join(repo.dir, "assets/hero.txt")), false);
    // …and both files are in the rescue, on a ref of the studio's own.
    assert.ok(rescue?.git.game, "restore returns the rescue snapshot it took");
    assert.match(rescue!.reason, new RegExp(`rescue before ${before.snapshot_id}`));
    assert.equal(await fixtureGit(repo.dir, ["rev-parse", snapshotRef(rescue!.snapshot_id)]), rescue!.git.game);
    assert.equal(
      await fixtureGit(repo.dir, ["show", `${rescue!.git.game}:src/main.js`]),
      "export const speed = 3; // edited during the run",
    );
    assert.equal(await fixtureGit(repo.dir, ["show", `${rescue!.git.game}:assets/hero.txt`]), "the user's own art");
  });

  it("refuses the restore, touching nothing, when the rescue snapshot cannot be taken", {
    skip: process.platform === "win32" && "chmod cannot make a file unreadable on Windows",
  }, async () => {
    const { repo, engine, before } = await snapshotted();
    await writeFile(path.join(repo.dir, "src/main.js"), "export const speed = 3; // edited during the run\n");
    // A file git cannot read: `add -A` fails on it, while `clean -fd` would delete it.
    const unreadable = path.join(repo.dir, "export-in-progress.bin");
    await writeFile(unreadable, "half-written by the user's exporter\n");
    await chmod(unreadable, 0o000);
    try {
      await assert.rejects(() => engine.restore(before, { gameWorkspace: "game" }), { code: "rescue-failed" });
      assert.equal(await exists(unreadable), true, "the unreadable file is still there");
      assert.equal(
        await readFile(path.join(repo.dir, "src/main.js"), "utf8"),
        "export const speed = 3; // edited during the run\n",
      );
      assert.equal(
        await fixtureGit(repo.dir, ["rev-parse", "HEAD"]),
        before.git.game,
        "no commit was made on the user's branch",
      );
    } finally {
      await chmod(unreadable, 0o644).catch(() => {});
    }
  });

  it("restores across the studio's own later snapshots", async () => {
    const { repo, engine, before } = await snapshotted();
    await writeFile(path.join(repo.dir, "src/main.js"), "attempt\n");
    await engine.snapshot({ scope: "game", reason: "the attempt", gameWorkspace: "game" });
    await engine.restore(before, { gameWorkspace: "game" });
    assert.equal(await readFile(path.join(repo.dir, "src/main.js"), "utf8"), repo.spec.modified["src/main.js"]);
    assert.equal(await fixtureGit(repo.dir, ["rev-parse", "HEAD"]), before.git.game);
  });

  it("refuses when the user switched branches, and leaves both branches where they were", async () => {
    const { repo, engine, before } = await snapshotted();
    await fixtureGit(repo.dir, ["checkout", "-q", "-b", "feature", repo.head]);
    await writeFile(path.join(repo.dir, "feature.js"), "export const feature = true;\n");
    await fixtureGit(repo.dir, ["add", "feature.js"]);
    await fixtureGit(repo.dir, ["commit", "-q", "-m", "the user's feature"]);
    const feature = await fixtureGit(repo.dir, ["rev-parse", "HEAD"]);
    await assert.rejects(() => engine.restore(before, { gameWorkspace: "game" }), { code: "branch-changed" });
    assert.equal(
      await fixtureGit(repo.dir, ["rev-parse", "refs/heads/feature"]),
      feature,
      "the feature branch was not repointed",
    );
    assert.equal(await fixtureGit(repo.dir, ["rev-parse", "refs/heads/main"]), before.git.game);
    assert.equal(await readFile(path.join(repo.dir, "feature.js"), "utf8"), "export const feature = true;\n");
  });

  it("refuses when the user committed on the branch after the snapshot, and keeps their commit", async () => {
    const { repo, engine, before } = await snapshotted();
    await writeFile(path.join(repo.dir, "src/main.js"), "export const speed = 4; // committed by the user\n");
    await fixtureGit(repo.dir, ["commit", "-q", "-am", "the user's fix"]);
    const mine = await fixtureGit(repo.dir, ["rev-parse", "HEAD"]);
    await assert.rejects(() => engine.restore(before, { gameWorkspace: "game" }), { code: "history-changed" });
    assert.equal(await fixtureGit(repo.dir, ["rev-parse", "HEAD"]), mine);
    assert.equal(
      await readFile(path.join(repo.dir, "src/main.js"), "utf8"),
      "export const speed = 4; // committed by the user\n",
    );
  });

  it("restores past a run whose merged-in work holds a contractor's own commit (R1)", async () => {
    const { repo, engine, before } = await snapshotted();
    // A facet worktree: one studio commit, then one the contractor made under its own identity,
    // brought into the live folder by the studio's own --no-ff merge.
    await fixtureGit(repo.dir, ["checkout", "-q", "-b", "facet"]);
    await writeFile(path.join(repo.dir, "src/facet.js"), "export const facet = 1;\n");
    await git(repo.dir, ["add", "-A"]);
    await git(repo.dir, ["commit", "-q", "-m", "facet: studio commit"]);
    await writeFile(path.join(repo.dir, "src/facet.js"), "export const facet = 2;\n");
    await fixtureGit(repo.dir, ["commit", "-q", "-am", "the contractor's own commit"]);
    await fixtureGit(repo.dir, ["checkout", "-q", "main"]);
    await git(repo.dir, [
      "-c",
      "core.hooksPath=/dev/null",
      "merge",
      "--no-ff",
      "-q",
      "-m",
      "studio: integrated build",
      "facet",
    ]);
    await engine.restore(before, { gameWorkspace: "game" });
    assert.equal(await fixtureGit(repo.dir, ["rev-parse", "HEAD"]), before.git.game, "the rollback happened");
    assert.equal(await exists(path.join(repo.dir, "src/facet.js")), false);
  });

  it("refuses to snapshot in the middle of the user's merge, and commits nothing", async () => {
    const repo = await dirtyUserRepo({ modified: {}, staged: {}, untracked: {} });
    await fixtureGit(repo.dir, ["checkout", "-q", "-b", "theirs"]);
    await writeFile(path.join(repo.dir, "src/main.js"), "export const speed = 'theirs';\n");
    await fixtureGit(repo.dir, ["commit", "-q", "-am", "theirs"]);
    await fixtureGit(repo.dir, ["checkout", "-q", "main"]);
    await writeFile(path.join(repo.dir, "src/main.js"), "export const speed = 'mine';\n");
    await fixtureGit(repo.dir, ["commit", "-q", "-am", "mine"]);
    const head = await fixtureGit(repo.dir, ["rev-parse", "HEAD"]);
    await assert.rejects(() => fixtureGit(repo.dir, ["merge", "-q", "theirs"]), "the merge conflicts");
    const engine = new SnapshotEngine([{ name: "game", dir: repo.dir }]);
    await assert.rejects(() => engine.snapshot({ scope: "game", reason: "before the round", gameWorkspace: "game" }), {
      code: "operation-in-progress",
    });
    assert.equal(await fixtureGit(repo.dir, ["rev-parse", "HEAD"]), head, "the half-resolved merge was not committed");
    assert.match(
      await readFile(path.join(repo.dir, "src/main.js"), "utf8"),
      /^<<<<<<< /m,
      "the conflict is still the user's to resolve",
    );
  });

  it("commits past the user's own hooks, which never see the studio's snapshot", async () => {
    const repo = await dirtyUserRepo();
    await mkdir(path.join(repo.dir, ".githooks"), { recursive: true });
    const hook = path.join(repo.dir, ".githooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n");
    await chmod(hook, 0o755);
    await fixtureGit(repo.dir, ["config", "core.hooksPath", ".githooks"]);
    const engine = new SnapshotEngine([{ name: "game", dir: repo.dir }]);
    await engine.init();
    const before = await engine.snapshot({ scope: "game", reason: "before the round", gameWorkspace: "game" });
    assert.equal(await fixtureGit(repo.dir, ["rev-parse", "HEAD"]), before.git.game);
    await writeFile(path.join(repo.dir, "src/main.js"), "attempt\n");
    await engine.restore(before, { gameWorkspace: "game" });
    assert.equal(await readFile(path.join(repo.dir, "src/main.js"), "utf8"), repo.spec.modified["src/main.js"]);
  });
});

/**
 * A game folder's `.git/config` is the game's (or a contractor's) to write, and the studio runs git
 * in it on the host, outside every sandbox. `core.fsmonitor` names a program git runs on status,
 * diff, add and commit; `core.hooksPath` a folder of programs it runs on commit and checkout.
 */
describe("a repository whose own config names a program", () => {
  it("snapshot and restore preserve raw file bytes without running clean or smudge filters", async () => {
    const repo = await dirtyUserRepo({ modified: {}, staged: {}, untracked: {} });
    const outside = await tmpDir("planted-filter-");
    const marker = path.join(outside, "RAN");
    const command = `touch '${marker}'; cat`;
    await fixtureGit(repo.dir, ["config", "filter.hostile.clean", command]);
    await fixtureGit(repo.dir, ["config", "filter.hostile.smudge", command]);
    await writeFile(path.join(repo.dir, ".gitattributes"), "src/main.js filter=hostile\n");
    const engine = new SnapshotEngine([{ name: "game", dir: repo.dir }]);
    const before = await engine.snapshot({ scope: "game", gameWorkspace: "game", reason: "filter probe" });
    const original = await readFile(path.join(repo.dir, "src/main.js"), "utf8");
    await writeFile(path.join(repo.dir, "src/main.js"), "changed();\n");
    await engine.snapshot({ scope: "game", gameWorkspace: "game", reason: "changed" });
    await engine.restore(before, { gameWorkspace: "game" });
    assert.equal(await exists(marker), false, "configured filters never run on the host");
    assert.equal(await readFile(path.join(repo.dir, "src/main.js"), "utf8"), original);
  });
  it("never makes a host-side snapshot, diff, restore or content stamp run it", async () => {
    const repo = await dirtyUserRepo({ modified: {}, staged: {}, untracked: {} });
    const outside = await tmpDir("planted-config-");
    const ran = path.join(outside, "RAN");
    const hook = path.join(outside, "hook.sh");
    await writeFile(hook, `#!/bin/sh\ntouch '${ran}'\nexit 0\n`);
    await chmod(hook, 0o755);
    const hooks = path.join(outside, "hooks");
    await mkdir(hooks);
    for (const name of ["pre-commit", "post-commit", "post-checkout", "reference-transaction"]) {
      await writeFile(path.join(hooks, name), `#!/bin/sh\ntouch '${ran}'\n`);
      await chmod(path.join(hooks, name), 0o755);
    }
    await fixtureGit(repo.dir, ["config", "core.fsmonitor", hook]);
    await fixtureGit(repo.dir, ["config", "core.hooksPath", hooks]);
    const engine = new SnapshotEngine([{ name: "game", dir: repo.dir }]);
    const before = await engine.snapshot({ scope: "game", reason: "before", gameWorkspace: "game" });
    await writeFile(path.join(repo.dir, "src/main.js"), "export const speed = 9;\n");
    const after = await engine.snapshot({ scope: "game", reason: "after", gameWorkspace: "game" });
    await engine.diff("game", before.git.game!, after.git.game!);
    await engine.changedPaths("game", before.git.game!, after.git.game!);
    await engine.uncommittedPaths("game");
    await engine.restore(before, { gameWorkspace: "game" });
    await workspaceContentStamp(repo.dir);
    assert.equal(await exists(ran), false, "the planted program never ran");
  });
});
