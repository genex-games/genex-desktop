/**
 * A sub-agent's delivery on its way from its copy of the game into the game folder, as `loop/git.ts`
 * says it to git: one folder committed in the copy (`commitFolder`), what that commit holds under
 * the folder with sizes (`treeEntries`), and chosen files checked out of it (`checkoutPaths`). Run
 * against real repositories through a `run.exec` that runs `/bin/sh -c` as the host does; hostile
 * folder and file names reach git as one word each and run nothing.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { checkoutPaths, commitFolder, treeEntries } from "../../src/harness-seed/loop/git-delivery.ts";
import { gitFile } from "../helpers/git.ts";
import { tmpDir } from "../helpers/tmp.ts";

const sh = promisify(execFile);
const SKIP = process.platform === "win32" ? "runs /bin/sh as the host does on macOS" : false;

/** A ctx whose `run.exec` runs the command in `cwd` (or the game folder for `{ project }`), as the host does. */
function execCtx(game: string) {
  const commands: string[] = [];
  const ctx = {
    call: async (method: string, params: { command: string; cwd?: string }) => {
      assert.equal(method, "run.exec");
      commands.push(params.command);
      try {
        const out = await sh("/bin/sh", ["-c", params.command], { cwd: params.cwd ?? game, encoding: "utf8" });
        return { code: 0, stdout: out.stdout, stderr: out.stderr };
      } catch (err) {
        const failed = err as { code?: number; stdout?: string; stderr?: string };
        return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
      }
    },
  };
  return { ctx: ctx as never, commands };
}

/** A game repository and a copy of it that shares its objects (as a worktree does). */
async function gameAndCopy() {
  const root = await tmpDir("seed-git-delivery-");
  const game = path.join(root, "game");
  await mkdir(game);
  await gitFile(["init", "-q", "-b", "main"], { cwd: game });
  await writeFile(path.join(game, "NOTES.md"), "# Game\n");
  await gitFile(["add", "-A"], { cwd: game });
  await gitFile(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "start"], { cwd: game });
  const copy = path.join(root, "copy");
  await gitFile(["worktree", "add", "-q", "--detach", copy], { cwd: game });
  return { root, game, copy };
}

describe("a sub-agent's delivery through loop/git.ts", { skip: SKIP }, () => {
  it("commits only the agent's folder in its copy, lists it with sizes, and lands chosen files in the game", async () => {
    const { game, copy } = await gameAndCopy();
    const folder = "assets/agents/blender_model-1";
    await mkdir(path.join(copy, folder), { recursive: true });
    await writeFile(path.join(copy, folder, "katana.glb"), "glb-bytes");
    await writeFile(path.join(copy, "stray.txt"), "outside the folder");
    const { ctx } = execCtx(game);
    const commit = await commitFolder(ctx, copy, folder, "Agent blender_model-1");
    assert.match(String(commit), /^[0-9a-f]{40,64}$/);
    const entries = await treeEntries(ctx, { project: "game" }, commit, folder);
    assert.equal(entries.length, 1);
    assert.match(entries[0] ?? "", /^100644 blob [0-9a-f]+ +9\tassets\/agents\/blender_model-1\/katana\.glb$/);
    const status = await sh("git", ["status", "--porcelain"], { cwd: copy, encoding: "utf8" });
    assert.match(status.stdout, /\?\? stray\.txt/, "nothing outside the folder was committed");
    assert.equal(await checkoutPaths(ctx, { project: "game" }, commit, [`${folder}/katana.glb`]), true);
    assert.equal(await readFile(path.join(game, folder, "katana.glb"), "utf8"), "glb-bytes");
  });

  const HOSTILE: Array<[string, string]> = [
    ["a command substitution", "assets/agents/$(touch PWNED)"],
    ["backticks", "assets/agents/`touch PWNED`"],
    ["a chained command", "assets/agents/x; touch PWNED"],
    ["a quote", "assets/agents/it's"],
  ];
  for (const [what, folder] of HOSTILE) {
    it(`passes a folder with ${what} to git as one word, and runs nothing`, async () => {
      const { game, copy } = await gameAndCopy();
      const { ctx } = execCtx(game);
      await commitFolder(ctx, copy, folder, "Agent x");
      await treeEntries(ctx, { project: "game" }, "HEAD", folder);
      await checkoutPaths(ctx, { project: "game" }, "HEAD", [folder]);
      for (const where of [game, copy]) {
        const listed = await sh("ls", ["-a"], { cwd: where, encoding: "utf8" });
        assert.doesNotMatch(listed.stdout, /PWNED/, `nothing ran in ${where}`);
      }
    });
  }

  it("refuses a revision that is not a commit before any git runs", async () => {
    const { game } = await gameAndCopy();
    const { ctx, commands } = execCtx(game);
    assert.deepEqual(await treeEntries(ctx, { project: "game" }, "main; touch PWNED", "assets"), []);
    assert.equal(await checkoutPaths(ctx, { project: "game" }, "--orphan", ["NOTES.md"]), false);
    assert.equal(await checkoutPaths(ctx, { project: "game" }, "HEAD", []), false, "nothing to land");
    assert.deepEqual(commands, [], "git never ran");
  });
});
