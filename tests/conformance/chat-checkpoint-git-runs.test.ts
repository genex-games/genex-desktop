import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChatCheckpoints } from "../../src/main/chat-checkpoints.ts";
import { ensureRepo, git } from "../../src/substrate/snapshots.ts";

// Its own file: the PATH a checkpoint finds git on is set once per process.
test("a checkpoint reads the repository's executable configuration once, not before every git run", {
  skip: process.platform === "win32" ? "the git shim is a shell script" : false,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-checkpoint-runs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "game");
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "main.js"), "jump();\n");
  await ensureRepo(dir);
  const bin = path.join(root, "bin");
  const log = path.join(root, "git.log");
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "git"), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  await fs.chmod(path.join(bin, "git"), 0o755);
  const checkpoints = new ChatCheckpoints(path.join(root, "indexes"), async () => `${bin}:${process.env.PATH}`);

  await fs.writeFile(path.join(dir, "src", "main.js"), "run();\n");
  const commit = await checkpoints.take(dir, "thread-1", "msg_a");

  const runs = (await fs.readFile(log, "utf8")).split("\n").filter(Boolean);
  const configReads = runs.filter((run) => run.includes("--get-regexp"));
  assert.equal(configReads.length, 1, runs.join("\n"));
  assert.ok(runs.length > configReads.length, "the checkpoint's own git runs go through the same git");
  assert.equal(await git(dir, ["show", `${commit}:src/main.js`]), "run();\n");
});

test("each checkpoint reads the configuration again: a filter added between two is never run", {
  skip: process.platform === "win32" ? "the filter is a shell script" : false,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-checkpoint-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "game");
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "main.js"), "jump();\n");
  await ensureRepo(dir);
  const checkpoints = new ChatCheckpoints(path.join(root, "indexes"));
  await checkpoints.take(dir, "thread-1", "msg_a");

  const marker = path.join(root, "RAN");
  const script = path.join(root, "probe.sh");
  await fs.writeFile(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
  await fs.chmod(script, 0o755);
  await git(dir, ["config", "filter.hostile.clean", script]);
  await fs.writeFile(path.join(dir, ".gitattributes"), "src/main.js filter=hostile\n");
  await fs.writeFile(path.join(dir, "src", "main.js"), "run();\n");
  await checkpoints.take(dir, "thread-1", "msg_b");

  await assert.rejects(fs.access(marker));
});
