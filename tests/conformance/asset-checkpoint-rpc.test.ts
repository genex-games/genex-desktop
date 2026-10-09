/** Asset checkpoint authority follows Git's actual worktree registration across path spellings. */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { before, describe, it } from "node:test";
import { StudioCore } from "../../src/main/studio-core.ts";
import { SnapshotScope } from "../../src/shared/event-log.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { git } from "../../src/substrate/snapshots.ts";
import { sharedResources } from "../helpers/core-lite.ts";
import { closeBeforeCleanup, tmpDir } from "../helpers/tmp.ts";

let core: StudioCore;

before(async () => {
  const root = await realpath(await tmpDir("studio-checkpoint-雪 space-"));
  const gamesRoot = path.join(root, "games");
  await mkdir(gamesRoot);
  core = new StudioCore({
    paths: { userData: path.join(root, "userData"), resources: await sharedResources() },
    gamesRoot,
    engines: [],
    sandbox: false,
    execPath: process.execPath,
    executionPolicy: { allowedProjectRoot: gamesRoot, runBackgroundImprovement: false },
    improvementIdle: { idleMs: 0, minGapMs: 0 },
  });
  closeBeforeCleanup(() => core.stop());
  await core.init();
  for (const project of ["pong", "foreign"]) {
    await core.games.scaffold(project);
    await core.api()[HostMethod.SnapshotCreate]({ scope: SnapshotScope.Game, project, reason: "baseline" });
  }
});

describe("asset checkpoint worktree authority", () => {
  it("refuses an unsupported Windows worktree path before touching Git or scratch", async () => {
    const api = core.api();
    const runId = `deep-${"x".repeat(160)}`;
    const target = path.join(core.layout.scratch, "autopilot", runId, "integration");
    const before = await git(core.games.dirFor("pong"), ["worktree", "list", "--porcelain", "-z"]);
    const open = () => api[HostMethod.SnapshotWorktree]({ project: "pong", runId, name: "integration" });
    if (process.platform === "win32") {
      assert.ok(target.length > 260, "the Windows fixture reaches the worktree path limit");
      await assert.rejects(open(), { name: "WindowsWorktreePathError", code: "windows-worktree-path-too-long" });
      assert.equal(await git(core.games.dirFor("pong"), ["worktree", "list", "--porcelain", "-z"]), before);
      await assert.rejects(stat(path.dirname(target)), /ENOENT/);
      await mkdir(target, { recursive: true });
      const sentinel = path.join(target, "keep.txt");
      await writeFile(sentinel, "keep the existing workspace");
      await assert.rejects(open(), { code: "windows-worktree-path-too-long" });
      assert.equal(await readFile(sentinel, "utf8"), "keep the existing workspace");
      return;
    }
    const workspace = await open();
    const result = await api[HostMethod.AssetsCheckpoint]({ project: "pong", runId });
    assert.deepEqual(result.files, []);
    assert.equal(result.revision, workspace.commit);
  });

  it("checkpoints a registered worktree under a Unicode path with spaces", async () => {
    const api = core.api();
    const workspace = await api[HostMethod.SnapshotWorktree]({
      project: "pong",
      runId: "registered",
      name: "integration",
    });
    const file = "assets/models/crate.glb";
    await mkdir(path.dirname(path.join(workspace.path, file)), { recursive: true });
    await writeFile(path.join(workspace.path, file), "owned asset");
    const delivery = await core.assetCheckpoints.record("pong", workspace.path, "fixture", "job-1", [file]);
    const result = await api[HostMethod.AssetsCheckpoint]({
      project: "pong",
      runId: "registered",
      assetIds: [delivery.id],
    });
    assert.deepEqual(result.files, [file]);
    assert.equal(await git(workspace.path, ["show", `${result.revision}:${file}`]), "owned asset");
  });

  it("refuses another game's registered integration worktree without committing", async () => {
    const api = core.api();
    const workspace = await api[HostMethod.SnapshotWorktree]({
      project: "foreign",
      runId: "foreign",
      name: "integration",
    });
    const before = await git(workspace.path, ["rev-parse", "HEAD"]);
    await assert.rejects(api[HostMethod.AssetsCheckpoint]({ project: "pong", runId: "foreign" }), /does not belong/);
    assert.equal(await git(workspace.path, ["rev-parse", "HEAD"]), before);
  });

  it("refuses an unregistered directory under scratch and keeps its contents", async () => {
    const workspace = path.join(core.layout.scratch, "autopilot", "unregistered", "integration");
    await mkdir(workspace, { recursive: true });
    const sentinel = path.join(workspace, "keep.txt");
    await writeFile(sentinel, "keep");
    await assert.rejects(
      core.api()[HostMethod.AssetsCheckpoint]({ project: "pong", runId: "unregistered" }),
      /does not belong/,
    );
    assert.equal(await readFile(sentinel, "utf8"), "keep");
  });

  it("refuses run-id traversal before touching a registered game", async () => {
    const game = core.games.dirFor("pong");
    const before = await git(game, ["rev-parse", "HEAD"]);
    for (const runId of ["../registered", "registered/integration", "registered\\integration", "", "."]) {
      await assert.rejects(core.api()[HostMethod.AssetsCheckpoint]({ project: "pong", runId }), /Invalid run id/);
    }
    assert.equal(await git(game, ["rev-parse", "HEAD"]), before);
  });
});
