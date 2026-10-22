/**
 * A worker's copy of a game is the snapshot's commit, made cheaply: every file the game folder still
 * holds as the commit has it is cloned from there (copy-on-write on APFS, so a large Unreal project's
 * content costs neither the time of writing it again nor its disk), and git writes only what the
 * folder no longer holds as committed. However it was made, the copy is exactly the commit's.
 */
import assert from "node:assert/strict";
import { chmod, copyFile, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { SnapshotScope } from "../../src/shared/event-log.ts";
import { git, SnapshotEngine } from "../../src/substrate/snapshots.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** An Unreal-shaped game, snapshotted, then changed in the folder: what a lead's game looks like at a worker's start. */
async function game() {
  const root = await tmpDir("worker-copy-clone-");
  const dir = path.join(root, "game");
  const files: Record<string, string> = {
    ".gitignore": "unreal/Saved/\nunreal/Intermediate/\n",
    "unreal/Content/Maps/Dock.umap": "map bytes ".repeat(4096),
    "unreal/Content/Props/Crate.uasset": "crate bytes ".repeat(2048),
    "assets/genex/guard.glb": "glTF guard",
    "assets/src/house.py": "import bpy\n",
    "src/main.js": "export const speed = 1;\n",
    "assets/old.png": "old picture",
    "tools/build.sh": "#!/bin/sh\necho build\n",
  };
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
  await chmod(path.join(dir, "tools/build.sh"), 0o755);
  await symlink("guard.glb", path.join(dir, "assets/genex/current.glb"));
  await mkdir(path.join(dir, "unreal/Saved"), { recursive: true });
  await writeFile(path.join(dir, "unreal/Saved/editor.log"), "ignored editor output");
  const engine = new SnapshotEngine([{ name: "g", dir }]);
  await engine.init();
  const snap = await engine.snapshot({ scope: SnapshotScope.Game, reason: "before worker w1", gameWorkspace: "g" });
  // The lead keeps working after the snapshot: an edit, a deletion, a mode change, a new file.
  await writeFile(path.join(dir, "src/main.js"), "export const speed = 2; // the lead's edit since\n");
  await rm(path.join(dir, "assets/old.png"));
  await chmod(path.join(dir, "tools/build.sh"), 0o644);
  await writeFile(path.join(dir, "assets/new.png"), "untracked since");
  return { root, dir, engine, commit: snap.git.game as string };
}

/**
 * A clone that records what it was asked to clone (paths inside the game) and copies each file;
 * `act` may copy differently, leave a file out or fail once it has run.
 */
function recordingClone(
  act: (from: string, to: string, file: string) => Promise<void> = (from, to) => copyFile(from, to),
  fails = false,
) {
  const cloned: string[] = [];
  const cloneFiles = async (gameDir: string, targetDir: string, files: readonly string[]) => {
    for (const file of files) {
      cloned.push(file);
      await mkdir(path.dirname(path.join(targetDir, file)), { recursive: true });
      await act(path.join(gameDir, file), path.join(targetDir, file), file);
    }
    if (fails) throw new Error("cp exited 1");
  };
  return { cloned, cloneFiles };
}

/** The copy holds exactly the commit: git sees nothing changed, and every tracked file reads as committed. */
async function assertExactly(copy: string, commit: string) {
  assert.equal((await git(copy, ["status", "--porcelain", "--untracked-files=all"])).trim(), "", "git sees no change");
  assert.equal((await git(copy, ["rev-parse", "HEAD"])).trim(), commit);
  const tracked = (await git(copy, ["ls-tree", "-r", "--name-only", "-z", commit])).split("\0").filter(Boolean);
  for (const file of tracked) {
    const info = await lstat(path.join(copy, file));
    if (info.isSymbolicLink()) continue;
    assert.equal(
      await readFile(path.join(copy, file), "utf8"),
      await git(copy, ["show", `${commit}:${file}`]),
      `${file} as committed`,
    );
  }
}

describe("a worker's copy of a game", () => {
  it("clones what the folder still holds as committed, and git writes only the rest", async () => {
    const { root, engine, commit } = await game();
    const { cloned, cloneFiles } = recordingClone();
    const copy = path.join(root, "scratch", "worker-w1");
    await engine.worktreeAt("g", commit, copy, { cloneFiles });
    assert.deepEqual(cloned.sort(), [
      ".gitignore",
      "assets/genex/guard.glb",
      "assets/src/house.py",
      "unreal/Content/Maps/Dock.umap",
      "unreal/Content/Props/Crate.uasset",
    ]);
    await assertExactly(copy, commit);
    assert.equal(
      await readFile(path.join(copy, "src/main.js"), "utf8"),
      "export const speed = 1;\n",
      "not the edit since",
    );
    assert.equal(
      await readFile(path.join(copy, "assets/old.png"), "utf8"),
      "old picture",
      "the deleted file, as committed",
    );
    assert.equal((await lstat(path.join(copy, "tools/build.sh"))).mode & 0o111, 0o111, "executable as committed");
    assert.equal(
      await readlink(path.join(copy, "assets/genex/current.glb")),
      "guard.glb",
      "a committed link stays one",
    );
    await assert.rejects(lstat(path.join(copy, "assets/new.png")), "nothing untracked");
    await assert.rejects(lstat(path.join(copy, "unreal/Saved")), "nor the editor's ignored output");
    await engine.removeWorktree("g", copy);
  });

  it("is the commit even when a clone brings other bytes, or fails", async () => {
    const { root, engine, commit } = await game();
    // A file changed between the look and the clone: the clone brings the lead's newer bytes.
    const raced = recordingClone(async (from, to, file) => {
      await copyFile(from, to);
      if (file.endsWith("Dock.umap")) await writeFile(to, "the lead saved the map meanwhile");
    });
    const first = path.join(root, "scratch", "worker-w1");
    await engine.worktreeAt("g", commit, first, { cloneFiles: raced.cloneFiles });
    await assertExactly(first, commit);
    // A clone that leaves one file out and then fails, as `cp` does when one of its files fails.
    const failing = recordingClone(async (from, to, file) => {
      if (!file.endsWith("Crate.uasset")) await copyFile(from, to);
    }, true);
    const second = path.join(root, "scratch", "worker-w2");
    await engine.worktreeAt("g", commit, second, { cloneFiles: failing.cloneFiles });
    await assertExactly(second, commit);
    // Where the platform clones nothing, git checks every file out, as it always did.
    const third = path.join(root, "scratch", "worker-w3");
    await engine.worktreeAt("g", commit, third, { cloneFiles: null });
    await assertExactly(third, commit);
  });

  it("copies an older commit too: what changed since comes from git, the rest is cloned", async () => {
    const { root, dir, engine, commit } = await game();
    await writeFile(path.join(dir, "assets/src/house.py"), "import bpy  # newer\n");
    await engine.snapshot({ scope: SnapshotScope.Game, reason: "later", gameWorkspace: "g" });
    const { cloned, cloneFiles } = recordingClone();
    const copy = path.join(root, "scratch", "worker-w3");
    await engine.worktreeAt("g", commit, copy, { cloneFiles });
    assert.ok(!cloned.includes("assets/src/house.py"), "changed since that commit");
    assert.ok(cloned.includes("unreal/Content/Maps/Dock.umap"));
    await assertExactly(copy, commit);
  });
});
