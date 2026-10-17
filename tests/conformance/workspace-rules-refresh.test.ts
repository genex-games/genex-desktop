/**
 * Every commit Genex makes in a game follows the rules for what the folder holds then.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ChatCheckpoints, CheckpointPhase, chatCheckpointRef } from "../../src/main/chat-checkpoints.ts";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";
import type { PlacedRule } from "../../src/shared/project-workspace.ts";
import { SnapshotScope } from "../../src/shared/event-log.ts";
import {
  ensureRepo,
  git,
  HARNESS_WORKSPACE,
  SnapshotEngine,
  SnapshotRefusal,
  SnapshotRefusedError,
  type WorkspaceSpec,
} from "../../src/substrate/snapshots.ts";
import { pathExists } from "../../src/substrate/fsx.ts";
import { ensureFactIgnoreRules } from "../../src/substrate/nested-repos.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { copyProject, Project } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** How long a test waits for the core's checkpoint of a message, and how often it looks. */
const CHECKPOINT_WAIT_MS = 10_000;
const CHECKPOINT_POLL_MS = 50;

/** Unreal's scratch at the game's root, as a fact's rule places it. */
const SAVED: PlacedRule = { base: ".", pattern: "Saved/" };

/** The files a commit holds. */
const treeOf = async (dir: string, commit: string) =>
  (await git(dir, ["ls-tree", "-r", "--name-only", commit])).split("\n").filter(Boolean);

/** Write files into a folder, making their folders. */
async function writeIn(dir: string, files: Record<string, string>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
}

/** A harness and a game workspace, each a folder of its own, neither a repository yet. */
async function twoWorkspaces(): Promise<{ harness: string; game: string }> {
  const root = await tmpDir("studio-rules-refresh-");
  const harness = path.join(root, "harness");
  const game = path.join(root, "game");
  await writeIn(harness, { "loop.ts": "export {};\n" });
  await writeIn(game, { "index.html": "<canvas></canvas>\n" });
  return { harness, game };
}

describe("rules topped up before a commit", () => {
  it("a chat checkpoint leaves a newly ruled folder out, even after it captured it", async () => {
    const root = await tmpDir("studio-rules-checkpoint-");
    const dir = path.join(root, "game");
    await writeIn(dir, { "index.html": "<canvas></canvas>\n" });
    await ensureRepo(dir);
    await writeIn(dir, { "Saved/a": "scratch\n" });
    const answers: PlacedRule[][] = [[], [SAVED]];
    const checkpoints = new ChatCheckpoints(path.join(root, "indexes"), undefined, {
      neverCaptured: async () => answers.shift() ?? [],
    });

    const first = await checkpoints.take(dir, "thread", "m1");
    assert.ok(first);
    assert.ok((await treeOf(dir, first)).includes("Saved/a"), "captured while nothing ruled it out");
    const second = await checkpoints.take(dir, "thread", "m2");
    assert.ok(second);
    assert.ok(!(await treeOf(dir, second)).includes("Saved/a"), "left out once a rule names it");
    assert.equal(await readFile(path.join(dir, "Saved/a"), "utf8"), "scratch\n", "the file stays on disk");
  });

  it("a rewind across a new rule leaves what the rule leaves out as it is", async () => {
    const root = await tmpDir("studio-rules-rewind-");
    const dir = path.join(root, "game");
    await writeIn(dir, { "index.html": "v1\n" });
    await ensureRepo(dir);
    await writeIn(dir, { "Saved/a": "old scratch\n" });
    let rules: PlacedRule[] = [];
    const checkpoints = new ChatCheckpoints(path.join(root, "indexes"), undefined, {
      neverCaptured: async () => rules,
    });
    const before = await checkpoints.take(dir, "thread", "m1");
    assert.ok(before && (await treeOf(dir, before)).includes("Saved/a"), "the first checkpoint captured it");
    await writeIn(dir, { "Saved/a": "new scratch\n", "index.html": "v2\n" });
    rules = [SAVED];
    await checkpoints.take(dir, "thread", "m1", CheckpointPhase.After);

    const plan = await checkpoints.plan(dir, "thread", "m1");
    assert.equal(plan.state === "restore" && plan.files, 1, "only index.html goes back");
    const restored = await checkpoints.restore(dir, "thread", "m1");
    assert.equal(restored.files, 1);
    assert.equal(await readFile(path.join(dir, "index.html"), "utf8"), "v1\n");
    assert.equal(await readFile(path.join(dir, "Saved/a"), "utf8"), "new scratch\n", "the scratch stays as it is");
    await checkpoints.putBack(dir, restored.saved);
    assert.equal(await readFile(path.join(dir, "index.html"), "utf8"), "v2\n");
    assert.equal(await readFile(path.join(dir, "Saved/a"), "utf8"), "new scratch\n");
  });

  it("a ruled folder the repository tracks stays in checkpoints, and a rewind brings it back", async () => {
    const root = await tmpDir("studio-rules-tracked-");
    const dir = path.join(root, "game");
    await writeIn(dir, { "index.html": "v1\n", "Binaries/tool.dll": "build 1\n" });
    await ensureRepo(dir);
    const binaries: PlacedRule = { base: ".", pattern: "Binaries/" };
    const checkpoints = new ChatCheckpoints(path.join(root, "indexes"), undefined, {
      neverCaptured: async () => [binaries, SAVED],
    });
    const first = await checkpoints.take(dir, "thread", "m1");
    assert.ok(first && (await treeOf(dir, first)).includes("Binaries/tool.dll"), "a tracked file stays captured");
    await writeIn(dir, { "Binaries/tool.dll": "build 2\n" });
    await checkpoints.take(dir, "thread", "m1", CheckpointPhase.After);
    const restored = await checkpoints.restore(dir, "thread", "m1");
    assert.equal(restored.files, 1);
    assert.equal(await readFile(path.join(dir, "Binaries/tool.dll"), "utf8"), "build 1\n", "the rewind brings it back");
  });

  it("a checkpoint whose rules cannot be read is still taken", async () => {
    const root = await tmpDir("studio-rules-unread-");
    const dir = path.join(root, "game");
    await writeIn(dir, { "index.html": "v1\n" });
    await ensureRepo(dir);
    const checkpoints = new ChatCheckpoints(path.join(root, "indexes"), undefined, {
      neverCaptured: async () => {
        throw new Error("the rules could not be read");
      },
    });
    const taken = await checkpoints.take(dir, "thread", "m1");
    assert.ok(taken && (await treeOf(dir, taken)).includes("index.html"), "a rejection counts as no rules");
  });

  it("the harness's workspace is never given a game's rules", async () => {
    const { harness, game } = await twoWorkspaces();
    const engine = new SnapshotEngine([
      { name: HARNESS_WORKSPACE, dir: harness },
      { name: "game", dir: game },
    ]);
    const hooked: WorkspaceSpec[] = [];
    engine.beforeCommit = async (workspace) => {
      hooked.push(workspace);
    };

    await engine.init();
    assert.deepEqual(hooked, [{ name: "game", dir: game }], "init tops up the game only");
    hooked.length = 0;
    await engine.snapshot({ scope: SnapshotScope.Both, gameWorkspace: "game", reason: "save" });
    assert.deepEqual(hooked, [{ name: "game", dir: game }], "a snapshot of both tops up the game only");
  });

  it("restoring a save point from before a rule leaves what the rule ignores now on disk", async () => {
    const { harness, game } = await twoWorkspaces();
    await writeIn(game, { ".gitignore": "node_modules\n" });
    const engine = new SnapshotEngine([
      { name: HARNESS_WORKSPACE, dir: harness },
      { name: "game", dir: game },
    ]);
    engine.beforeCommit = async ({ dir }) => {
      const lines = (await pathExists(path.join(dir, "project.godot"))) ? ["/.godot/"] : [];
      await ensureFactIgnoreRules(dir, lines);
      return lines;
    };
    engine.keepIgnoring = ({ dir }, lines) => ensureFactIgnoreRules(dir, lines);
    await engine.init();
    const web = await engine.snapshot({ scope: SnapshotScope.Game, gameWorkspace: "game", reason: "web only" });
    await writeIn(game, { "project.godot": "config_version=5\n", ".godot/editor/state.cfg": "scratch\n" });
    await engine.snapshot({ scope: SnapshotScope.Game, gameWorkspace: "game", reason: "after the port" });

    const rescue = await engine.restore(web, { gameWorkspace: "game" });
    assert.ok(rescue, "a rescue was taken");
    assert.equal(
      await readFile(path.join(game, ".godot/editor/state.cfg"), "utf8"),
      "scratch\n",
      "the engine's scratch, which the rescue leaves out, is never deleted",
    );
    assert.equal(await pathExists(path.join(game, "project.godot")), false, "what the save point lacked is gone");

    // The scratch left on disk stays out of the next save point, though nothing names the engine now.
    const next = await engine.snapshot({
      scope: SnapshotScope.Game,
      gameWorkspace: "game",
      reason: "after the restore",
    });
    assert.ok(next.git.game);
    assert.deepEqual(
      (await treeOf(game, next.git.game)).filter((file) => file.startsWith(".godot/")),
      [],
      "the engine's scratch never reaches history",
    );
  });

  it("a rewind past a port keeps the scratch it leaves on disk out of the next checkpoint", async () => {
    const root = await tmpDir("studio-rules-rewind-port-");
    const dir = path.join(root, "game");
    await writeIn(dir, { "index.html": "v1\n", ".gitignore": "node_modules\n" });
    await ensureRepo(dir);
    // The rules follow the folder as the core's do: Unreal's while it holds a project file.
    const checkpoints = new ChatCheckpoints(path.join(root, "indexes"), undefined, {
      neverCaptured: async (folder) => {
        const rules = (await pathExists(path.join(folder, "Garden.uproject"))) ? [SAVED] : [];
        await ensureFactIgnoreRules(
          folder,
          rules.map(() => "/Saved/"),
        );
        return rules;
      },
    });
    await checkpoints.take(dir, "thread", "m1");
    await writeIn(dir, { "Garden.uproject": "{}\n", "Saved/Autosaves/a.umap": "scratch\n" });
    await checkpoints.take(dir, "thread", "m1", CheckpointPhase.After);

    await checkpoints.restore(dir, "thread", "m1");
    assert.equal(await pathExists(path.join(dir, "Garden.uproject")), false, "the port's project file goes back");
    assert.equal(await readFile(path.join(dir, "Saved/Autosaves/a.umap"), "utf8"), "scratch\n", "its scratch stays");
    const next = await checkpoints.take(dir, "thread", "m2");
    assert.ok(next);
    assert.deepEqual(
      (await treeOf(dir, next)).filter((file) => file.startsWith("Saved/")),
      [],
      "the scratch stays out of the next checkpoint",
    );
  });

  it("a snapshot refused mid-merge tops nothing up", async () => {
    const { harness, game } = await twoWorkspaces();
    const engine = new SnapshotEngine([
      { name: HARNESS_WORKSPACE, dir: harness },
      { name: "game", dir: game },
    ]);
    await engine.init();
    const hooked: WorkspaceSpec[] = [];
    engine.beforeCommit = async (workspace) => {
      hooked.push(workspace);
    };
    const head = (await git(game, ["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(game, ".git", "MERGE_HEAD"), `${head}\n`);
    await assert.rejects(
      engine.snapshot({ scope: SnapshotScope.Game, gameWorkspace: "game", reason: "save" }),
      (err: unknown) => err instanceof SnapshotRefusedError && err.code === SnapshotRefusal.OperationInProgress,
    );
    assert.deepEqual(hooked, [], "the rules are never topped up for a refused snapshot");
  });

  it("a rule top-up that fails never stops a snapshot", async () => {
    const { harness, game } = await twoWorkspaces();
    const engine = new SnapshotEngine([
      { name: HARNESS_WORKSPACE, dir: harness },
      { name: "game", dir: game },
    ]);
    engine.beforeCommit = async () => {
      throw new Error("the rules could not be read");
    };
    await engine.init();
    const record = await engine.snapshot({ scope: SnapshotScope.Game, gameWorkspace: "game", reason: "save" });
    assert.ok(record.git.game, "the snapshot holds the game");
    assert.equal((await git(game, ["cat-file", "-t", record.git.game])).trim(), "commit");
  });
});

describe("a game whose ignore file is a link", () => {
  let lite: CoreLite;
  let root: string;
  before(async () => {
    root = await realpath(await tmpDir("studio-rules-link-"));
    lite = await coreLite({ gamesRoot: path.join(root, "games") });
  });
  after(() => lite.close());

  it("a web game's own ignore file stays as the person left it at each save point", async () => {
    const game = await lite.core.createGame("Paper Lanterns");
    const file = path.join(game.dir, ".gitignore");
    const without = (await readFile(file, "utf8"))
      .split("\n")
      .filter((line) => line !== "dist/")
      .join("\n");
    await writeFile(file, without);
    await lite.core.snapshot(SnapshotScope.Game, "a removed rule", game.name);
    assert.equal(await readFile(file, "utf8"), without, "a removed generic line stays removed");
    await rm(file);
    await lite.core.snapshot(SnapshotScope.Game, "a removed file", game.name);
    await assert.rejects(lstat(file), "a deleted ignore file is not made again");
  });

  it("snapshots without writing through the link", async () => {
    const game = await lite.core.createGame("Lantern Keep");
    const outside = path.join(root, "outside-rules");
    const text = "# someone else's rules\n";
    await writeFile(outside, text);
    await rm(path.join(game.dir, ".gitignore"));
    await symlink(outside, path.join(game.dir, ".gitignore"));
    await writeIn(game.dir, { "Saved/x": "scratch\n", "Lantern.uproject": "{}\n" });

    const record = await lite.core.snapshot(SnapshotScope.Game, "after the port", game.name);
    assert.ok(record.git.game, "the snapshot succeeded");
    assert.equal(await readFile(outside, "utf8"), text, "the outside file is byte-identical");
    assert.ok((await lstat(path.join(game.dir, ".gitignore"))).isSymbolicLink(), "the link is still a link");
  });
});

describe("restoring a save point through the core", () => {
  let lite: CoreLite;
  before(async () => {
    lite = await coreLite();
  });
  after(() => lite.close());

  /** The files of a commit under any of these folders. */
  const under = async (dir: string, commit: string, folders: string[]) =>
    (await treeOf(dir, commit)).filter((file) => folders.some((folder) => file.startsWith(`${folder}/`)));

  it("keeps a later engine's scratch on disk and out of every save point after it", async () => {
    const project = "garden-restore";
    await lite.core.games.scaffold(project);
    const dir = lite.core.games.dirFor(project);
    const web = await lite.core.snapshot(SnapshotScope.Game, "web only", project);
    const scratch = {
      "Saved/Autosaves/a.umap": "autosave\n",
      "DerivedDataCache/big.ddp": "cache\n",
      ".godot/editor/state.cfg": "scratch\n",
    };
    await writeIn(dir, { "Garden.uproject": "{}\n", "project.godot": "config_version=5\n", ...scratch });
    const ported = await lite.core.snapshot(SnapshotScope.Game, "after the port", project);
    assert.ok(ported.git.game);
    assert.deepEqual(await under(dir, ported.git.game, ["Saved", "DerivedDataCache", ".godot"]), []);

    await lite.core.snapshots.restore(web, { gameWorkspace: project });
    assert.equal(await pathExists(path.join(dir, "Garden.uproject")), false, "what the save point lacked is gone");
    for (const [file, text] of Object.entries(scratch))
      assert.equal(await readFile(path.join(dir, file), "utf8"), text, `${file} stays on disk`);
    const after = await lite.core.snapshot(SnapshotScope.Game, "after the restore", project);
    assert.ok(after.git.game);
    assert.deepEqual(await under(dir, after.git.game, ["Saved", "DerivedDataCache", ".godot"]), []);
  });
});

describe("a folder whose ignore file says what no pattern can be made of", () => {
  let lite: CoreLite;
  let cases: string;
  before(async () => {
    const root = await realpath(await tmpDir("studio-rules-odd-line-"));
    cases = path.join(root, "cases");
    await mkdir(cases);
    lite = await coreLite({
      gamesRoot: path.join(root, "games"),
      executionPolicy: { allowedProjectRoot: root, runBackgroundImprovement: false },
    });
  });
  after(() => lite.close());

  it("opens and saves, its facts' lines added beside the person's", async () => {
    const dir = await copyProject(Project.GodotGame, cases);
    // git reads a class whose range runs backwards as matching nothing.
    await writeFile(path.join(dir, ".gitignore"), "[z-a]\n");
    const game = await lite.core.adoptProject(dir);
    const lines = (await readFile(path.join(dir, ".gitignore"), "utf8")).split("\n");
    assert.equal(lines[0], "[z-a]", "the person's line stays");
    assert.ok(lines.includes("/.godot/"), lines.join("|"));
    const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
    assert.ok(!(await treeOf(dir, head)).some((file) => file.startsWith(".godot/")), "the first commit leaves it out");
    await writeIn(dir, { "level.tscn": "[gd_scene]\n" });
    const record = await lite.core.snapshot(SnapshotScope.Game, "a save point", game.name);
    assert.ok(record.git.game && (await treeOf(dir, record.git.game)).includes("level.tscn"));
  });
});

describe("a chat checkpoint taken by the core", () => {
  let lite: CoreLite;
  before(async () => {
    lite = await coreLite();
  });
  after(() => lite.close());

  /** The chat's queue starts answering a message, which takes its checkpoint; answers the checkpoint. */
  async function answer(threadId: string, dir: string, messageId: string): Promise<string> {
    const append = (lite.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>)["events.append"];
    assert.ok(append);
    const batch = [customEventData(CustomEvent.CoordinatorMessageProcessing, { messageId })];
    await append({ threadId, batch });
    const ref = chatCheckpointRef(threadId, messageId);
    const deadline = Date.now() + CHECKPOINT_WAIT_MS;
    while (Date.now() < deadline) {
      const commit = (await git(dir, ["rev-parse", "--verify", "-q", ref]).catch(() => "")).trim();
      if (commit) return commit;
      await sleep(CHECKPOINT_POLL_MS);
    }
    throw new Error(`no checkpoint for ${messageId}`);
  }

  it("tops up the ignore file and leaves a port's scratch out, and a rules failure never stops one", async () => {
    const project = "garden";
    await lite.core.games.scaffold(project);
    const threadId = await lite.core.createGameThread(project);
    const dir = lite.core.games.dirFor(project);
    await writeIn(dir, { "Saved/a": "scratch\n" });
    const first = await answer(threadId, dir, "msg_one");
    assert.ok((await treeOf(dir, first)).includes("Saved/a"), "captured while the game is a web game");

    await writeIn(dir, { "Garden.uproject": "{}\n" });
    const second = await answer(threadId, dir, "msg_two");
    assert.ok(!(await treeOf(dir, second)).includes("Saved/a"), "left out once the folder holds an Unreal project");
    assert.ok((await readFile(path.join(dir, ".gitignore"), "utf8")).split("\n").includes("/Saved/"));

    const games = lite.core.games;
    const ensure = games.ensureWorkspaceRules.bind(games);
    games.ensureWorkspaceRules = async () => {
      throw new Error("the rules could not be read");
    };
    try {
      assert.ok(await answer(threadId, dir, "msg_three"), "the checkpoint is still taken");
    } finally {
      games.ensureWorkspaceRules = ensure;
    }
  });
});
