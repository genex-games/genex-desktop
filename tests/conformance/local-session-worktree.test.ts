/** Local sessions grant a linked worktree's real Git metadata, independently of ambient routing. */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { it } from "node:test";
import { EngineId } from "../../src/shared/providers.ts";
import { LocalSessions } from "../../src/substrate/engines/local-session.ts";
import { LocalTool } from "../../src/substrate/engines/local-session-tools.ts";
import { ProcessSandbox, type SandboxOptions, shellQuote } from "../../src/substrate/spawn.ts";
import { git } from "../../src/substrate/snapshots.ts";
import { tmpDir } from "../helpers/tmp.ts";

it("local sessions grant only the linked workspace and its Git metadata", async (t) => {
  const root = await realpath(await tmpDir("local-git-雪 space-"));
  const repository = path.join(root, "repository");
  const workspace = path.join(root, "workspace");
  const unrelated = path.join(root, "unrelated");
  await mkdir(repository);
  await mkdir(unrelated);
  await git(unrelated, ["init"]);
  await git(repository, ["init"]);
  await writeFile(path.join(repository, "game.txt"), "baseline\n");
  await git(repository, ["add", "game.txt"]);
  await git(repository, ["commit", "-m", "baseline"]);
  await git(repository, ["worktree", "add", "--detach", workspace]);
  const metadata = await realpath(path.join(repository, ".git", "worktrees", "workspace"));
  const common = await realpath(path.join(repository, ".git"));
  const create = ProcessSandbox.create.bind(ProcessSandbox);
  const grants: SandboxOptions[] = [];
  t.mock.method(ProcessSandbox, "create", async (options: SandboxOptions) => {
    grants.push(options);
    // This contract probe runs no command; the real Git discovery above and the grants are tested.
    return create({ ...options, enabled: false });
  });
  const sessions = new LocalSessions({
    root: path.join(root, "sessions"),
    scratchRoot: path.join(root, "scratch"),
    protectedPaths: [unrelated],
    contextWindow: 16384,
    complete: async () => ({
      engine: EngineId.Bonsai,
      model: "fixture",
      usage: {},
      stopReason: "stop",
      message: { role: "assistant", content: "Done" },
    }),
  });
  const result = await sessions.run({ cwd: workspace, prompt: "Inspect the workspace" }, "fixture");
  assert.equal(result.ok, true);
  assert.equal(grants.length, 1);
  assert.deepEqual(grants[0]?.writableRoots, [await realpath(workspace), metadata, common]);
  assert.deepEqual(grants[0]?.secretPaths?.slice(0, 1), [unrelated]);
  assert.equal(grants[0]?.writableRoots?.includes(repository), false, "no grant to the other working copy");
  const previous = process.env.GIT_DIR;
  try {
    process.env.GIT_DIR = path.join(unrelated, ".git");
    await sessions.run({ cwd: workspace, prompt: "Inspect again" }, "fixture");
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
  }
  assert.deepEqual(grants[1]?.writableRoots, [await realpath(workspace), metadata, common]);
  assert.equal(grants[1]?.writableRoots?.includes(path.join(unrelated, ".git")), false);
});

it("Windows local sessions commit a linked worktree while refusing unrelated writes", {
  skip:
    process.platform !== "win32" || process.env.GENEX_WINDOWS_SANDBOX !== "ready"
      ? "needs Windows with a provisioned sandbox (GENEX_WINDOWS_SANDBOX=ready)"
      : false,
}, async () => {
  const root = await realpath(await tmpDir("local-worktree-"));
  const repository = path.join(root, "repository");
  const workspace = path.join(root, "workspace");
  const unrelated = path.join(root, "unrelated");
  await mkdir(repository);
  await mkdir(unrelated);
  await writeFile(path.join(repository, "game.txt"), "baseline\n");
  await git(repository, ["init"]);
  await git(repository, ["add", "game.txt"]);
  await git(repository, ["commit", "-m", "baseline"]);
  const head = (await git(repository, ["rev-parse", "HEAD"])).trim();
  await git(repository, ["worktree", "add", "--detach", workspace]);
  await writeFile(path.join(workspace, "game.txt"), "candidate\n");
  let round = 0;
  const commands = [
    "git add game.txt && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m candidate",
    `printf escaped > ${shellQuote(path.join(unrelated, "escaped.txt").replaceAll("\\", "/"))}`,
    `printf granted > ${shellQuote(path.join(workspace, "granted.txt").replaceAll("\\", "/"))}`,
  ];
  const commandResults: Array<{ code: number | null; sandboxed: boolean }> = [];
  const sessions = new LocalSessions({
    root: path.join(root, "sessions"),
    scratchRoot: path.join(root, "scratch"),
    protectedPaths: [unrelated],
    contextWindow: 16384,
    complete: async (request) => {
      const answer = request.messages.findLast((message) => message.role === "tool");
      if (answer) commandResults.push(JSON.parse(answer.content));
      const command = commands[round++];
      return {
        engine: EngineId.Bonsai,
        model: "fixture",
        usage: {},
        stopReason: command ? "tool_calls" : "stop",
        message: {
          role: "assistant",
          content: command ? "" : "Done",
          ...(command
            ? { tool_calls: [{ id: `command-${round}`, name: LocalTool.RunCommand, arguments: { command } }] }
            : {}),
        },
      };
    },
  });
  const result = await sessions.run({ cwd: workspace, prompt: "Commit the candidate" }, "fixture");
  assert.equal(result.ok, true, result.errorText);
  assert.deepEqual(
    commandResults.map((answer) => answer.sandboxed),
    [true, true, true],
  );
  assert.equal(commandResults[0]?.code, 0);
  assert.notEqual(commandResults[1]?.code, 0);
  assert.equal(commandResults[2]?.code, 0);
  assert.equal(await readFile(path.join(workspace, "granted.txt"), "utf8"), "granted");
  assert.notEqual((await git(workspace, ["rev-parse", "HEAD"])).trim(), head);
  assert.equal((await git(repository, ["rev-parse", "HEAD"])).trim(), head);
  assert.equal(await readFile(path.join(repository, "game.txt"), "utf8"), "baseline\n");
  assert.equal(await git(workspace, ["show", "HEAD:game.txt"]), "candidate\n");
  await assert.rejects(stat(path.join(unrelated, "escaped.txt")), /ENOENT/);
});
