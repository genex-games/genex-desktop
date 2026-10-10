import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CHAT_CHECKPOINTS_KEPT,
  CHECKPOINT_FILE_MAX_BYTES,
  ChatCheckpoints,
  chatCheckpointRef,
} from "../../src/main/chat-checkpoints.ts";
import { ensureRepo, git } from "../../src/substrate/snapshots.ts";
import { removeTree } from "../helpers/tmp.ts";

async function game(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-chat-checkpoint-"));
  t.after(() => removeTree(root));
  const dir = path.join(root, "game");
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, ".gitignore"), "dist/\n");
  await fs.writeFile(path.join(dir, "src", "main.js"), "jump();\n");
  await fs.writeFile(path.join(dir, "studio.json"), '{"shape":"template"}\n');
  await ensureRepo(dir);
  return { dir, checkpoints: new ChatCheckpoints(path.join(root, "indexes")) };
}
const read = (dir: string, file: string) => fs.readFile(path.join(dir, file), "utf8");
const exists = (dir: string, file: string) =>
  fs.access(path.join(dir, file)).then(
    () => true,
    () => false,
  );

test("checkpoints disable repository fsmonitor, hooks and content filters", async (t) => {
  const { dir, checkpoints } = await game(t);
  const script = path.join(dir, "probe.sh");
  const marker = path.join(dir, "RAN");
  await fs.writeFile(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`);
  await fs.chmod(script, 0o755);
  const monitor = path.join(dir, "monitor.sh");
  await fs.writeFile(monitor, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`);
  await fs.chmod(monitor, 0o755);
  await git(dir, ["config", "core.fsmonitor", monitor]);
  await git(dir, ["config", "filter.hostile.clean", script]);
  await git(dir, ["config", "filter.hostile.smudge", script]);
  await fs.writeFile(path.join(dir, ".gitattributes"), "src/main.js filter=hostile\n");
  await checkpoints.take(dir, "safe-thread", "safe-message");
  await fs.writeFile(path.join(dir, "src/main.js"), "changed();\n");
  await checkpoints.restore(dir, "safe-thread", "safe-message");
  assert.equal(await exists(dir, "RAN"), false);
  assert.equal(await read(dir, "src/main.js"), "jump();\n");
});

test("a checkpoint saves the folder without moving HEAD, a branch or the user’s staged work", async (t) => {
  const { dir, checkpoints } = await game(t);
  await fs.writeFile(path.join(dir, "notes.txt"), "my notes\n");
  await fs.writeFile(path.join(dir, "src", "main.js"), "jump(); run();\n");
  await git(dir, ["add", "src/main.js"]);
  const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
  const staged = await git(dir, ["diff", "--cached"]);
  const commit = await checkpoints.take(dir, "thread-1", "msg_a");
  assert.equal((await git(dir, ["rev-parse", "HEAD"])).trim(), head);
  assert.equal(await git(dir, ["diff", "--cached"]), staged);
  assert.equal((await git(dir, ["branch", "--format=%(refname:short)"])).trim(), "main");
  assert.equal((await git(dir, ["rev-parse", chatCheckpointRef("thread-1", "msg_a")])).trim(), commit);
  assert.equal(
    (await git(dir, ["rev-parse", `${commit}^1`])).trim(),
    head,
    "its parent records the HEAD it was taken on",
  );
  assert.equal(await git(dir, ["show", `${commit}:notes.txt`]), "my notes\n", "untracked files are part of the folder");
  assert.equal(
    await checkpoints.take(dir, "thread-1", "msg_a"),
    commit,
    "an answer retried after a restart keeps its first checkpoint",
  );
});

test("restoring puts back edited, deleted and added files, and leaves ignored files, studio.json and HEAD alone", async (t) => {
  const { dir, checkpoints } = await game(t);
  await fs.writeFile(path.join(dir, "notes.txt"), "my notes\n");
  await checkpoints.take(dir, "thread-1", "msg_a");
  assert.deepEqual(await checkpoints.plan(dir, "thread-1", "msg_a"), { state: "unchanged", nested: [] });
  // The answer's work: an edit, a new folder, a deletion; the game's shape changed meanwhile.
  await fs.writeFile(path.join(dir, "src", "main.js"), "jump(); boss();\n");
  await fs.mkdir(path.join(dir, "src", "boss"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "boss", "boss.js"), "boss();\n");
  await fs.rm(path.join(dir, "notes.txt"));
  await fs.writeFile(path.join(dir, "studio.json"), '{"shape":"built"}\n');
  await fs.mkdir(path.join(dir, "dist"));
  await fs.writeFile(path.join(dir, "dist", "bundle.js"), "built\n");
  const head = (await git(dir, ["rev-parse", "HEAD"])).trim();
  assert.deepEqual(await checkpoints.plan(dir, "thread-1", "msg_a"), {
    state: "restore",
    files: 3,
    outside: [],
    outsideUnknown: false,
    nested: [],
    tooLarge: 0,
  });
  assert.equal((await checkpoints.restore(dir, "thread-1", "msg_a")).files, 3);
  assert.equal(await read(dir, "src/main.js"), "jump();\n");
  assert.equal(await read(dir, "notes.txt"), "my notes\n");
  assert.equal(await exists(dir, "src/boss"), false, "a folder emptied by the rewind goes too");
  assert.equal(await read(dir, "studio.json"), '{"shape":"built"}\n');
  assert.equal(await read(dir, "dist/bundle.js"), "built\n");
  assert.equal((await git(dir, ["rev-parse", "HEAD"])).trim(), head);
  // What the rewind overwrote is kept on a ref of its own.
  const kept = (
    await git(dir, ["for-each-ref", "--format=%(objectname)", "refs/studio/chat/thread-1/rewound/"])
  ).trim();
  assert.equal(await git(dir, ["show", `${kept}:src/boss/boss.js`]), "boss();\n");
  assert.equal((await git(dir, ["tag"])).trim(), "");
  assert.deepEqual(await checkpoints.plan(dir, "thread-1", "msg_a"), { state: "unchanged", nested: [] });
});

test("files stay as they are once the game’s history moved, or when there is no checkpoint", async (t) => {
  const { dir, checkpoints } = await game(t);
  assert.deepEqual(await checkpoints.plan(dir, "thread-1", "msg_a"), { state: "unavailable", reason: "no-checkpoint" });
  await checkpoints.take(dir, "thread-1", "msg_a");
  await fs.writeFile(path.join(dir, "src", "main.js"), "landed();\n");
  await git(dir, ["commit", "-qam", "a build landed"]);
  assert.deepEqual(await checkpoints.plan(dir, "thread-1", "msg_a"), {
    state: "unavailable",
    reason: "history-changed",
  });
  await assert.rejects(checkpoints.restore(dir, "thread-1", "msg_a"), /changed through a commit or a landed build/);
  assert.equal(await read(dir, "src/main.js"), "landed();\n");
});

test("a folder whose repository has no commit yet is checkpointed and restored too", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-chat-checkpoint-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "game");
  await fs.mkdir(dir);
  await git(dir, ["init", "-q", "-b", "main"]);
  await fs.writeFile(path.join(dir, "index.html"), "<canvas></canvas>\n");
  const checkpoints = new ChatCheckpoints(path.join(root, "indexes"));
  await checkpoints.take(dir, "thread-1", "msg_a");
  await fs.writeFile(path.join(dir, "index.html"), "<main></main>\n");
  await fs.writeFile(path.join(dir, "game.js"), "x\n");
  assert.equal((await checkpoints.restore(dir, "thread-1", "msg_a")).files, 2);
  assert.equal(await read(dir, "index.html"), "<canvas></canvas>\n");
  assert.equal(await exists(dir, "game.js"), false);
  assert.equal(await git(dir, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "unborn"), "unborn");
});

test("each chat keeps its newest message checkpoints", async (t) => {
  const { dir, checkpoints } = await game(t);
  for (let n = 0; n <= CHAT_CHECKPOINTS_KEPT; n++) {
    await fs.writeFile(path.join(dir, "src", "main.js"), `step(${n});\n`);
    await checkpoints.take(dir, "thread-1", `msg_${String(n).padStart(3, "0")}`);
  }
  const refs = (await git(dir, ["for-each-ref", "--format=%(refname)", "refs/studio/chat/thread-1/before/"]))
    .trim()
    .split("\n");
  assert.equal(refs.length, CHAT_CHECKPOINTS_KEPT);
  assert.ok(refs.includes(chatCheckpointRef("thread-1", `msg_${CHAT_CHECKPOINTS_KEPT}`)));
});

test("a rewound .gitignore neither deletes nor captures what the game ignored, like .env", async (t) => {
  const { dir, checkpoints } = await game(t);
  await fs.writeFile(path.join(dir, ".gitignore"), "dist/\n.env\nsave/\n");
  await git(dir, ["add", ".gitignore"]);
  await git(dir, ["commit", "-qm", "ignore rules"]);
  await fs.writeFile(path.join(dir, ".env"), "TOKEN=secret\n");
  await fs.mkdir(path.join(dir, "save"));
  await fs.writeFile(path.join(dir, "save", "slot1.json"), "{}\n");
  await checkpoints.take(dir, "thread-1", "msg_a");
  // The answer rewrote the rules without those lines; the ignored files are now plain content.
  await fs.writeFile(path.join(dir, ".gitignore"), "dist/\n");
  await fs.writeFile(path.join(dir, "src", "main.js"), "changed();\n");
  const { files } = await checkpoints.restore(dir, "thread-1", "msg_a");
  assert.equal(files, 2, ".gitignore and main.js");
  assert.equal(await read(dir, ".gitignore"), "dist/\n.env\nsave/\n");
  assert.equal(
    await read(dir, "save/slot1.json"),
    "{}\n",
    "ignored before the message, so never the checkpoint’s to delete",
  );
  assert.equal(await read(dir, ".env"), "TOKEN=secret\n");
  const refs = (await git(dir, ["for-each-ref", "--format=%(objectname)", "refs/studio/chat/"])).trim().split("\n");
  for (const commit of refs)
    assert.doesNotMatch(
      await git(dir, ["ls-tree", "-r", "--name-only", commit]),
      /(^|\n)\.env\n/,
      "secrets never enter a checkpoint",
    );
});

test("a checkpoint that left nothing out carries no record of it; one that did keeps it", async (t) => {
  const { dir, checkpoints } = await game(t);
  const record = ".studio-checkpoint-left-out.json";
  const files = async (ref: string) => (await git(dir, ["ls-tree", "--name-only", ref])).trim().split("\n");
  const plain = await checkpoints.take(dir, "thread-1", "msg_a");
  assert.ok(plain);
  assert.equal((await files(plain)).includes(record), false, "nothing left out, nothing recorded");
  await fs.mkdir(path.join(dir, "engine"));
  await ensureRepo(path.join(dir, "engine"));
  const nested = await checkpoints.take(dir, "thread-1", "msg_b");
  assert.ok(nested);
  assert.equal((await files(nested)).includes(record), true, "a nested repository is recorded");
  await fs.rm(path.join(dir, "engine"), { recursive: true, force: true });
  const again = await checkpoints.take(dir, "thread-1", "msg_c");
  assert.ok(again);
  assert.equal((await files(again)).includes(record), false, "an earlier record does not linger");
  assert.deepEqual(await checkpoints.plan(dir, "thread-1", "msg_c"), { state: "unchanged", nested: [] });
});

test("nested repositories keep their own history, even one without a commit", async (t) => {
  const { dir, checkpoints } = await game(t);
  await fs.mkdir(path.join(dir, "engine"));
  await git(path.join(dir, "engine"), ["init", "-q"]);
  await fs.writeFile(path.join(dir, "engine", "core.js"), "core();\n");
  await checkpoints.take(dir, "thread-1", "msg_a");
  await fs.writeFile(path.join(dir, "engine", "core.js"), "changed();\n");
  await fs.writeFile(path.join(dir, "src", "main.js"), "changed();\n");
  assert.deepEqual(await checkpoints.plan(dir, "thread-1", "msg_a"), {
    state: "restore",
    files: 1,
    outside: [],
    outsideUnknown: false,
    nested: ["engine"],
    tooLarge: 0,
  });
  await checkpoints.restore(dir, "thread-1", "msg_a");
  assert.equal(await read(dir, "engine/core.js"), "changed();\n");
  assert.equal(await read(dir, "src/main.js"), "jump();\n");
});

test("files changed between answers are named as changed outside the chat, and a restore can be undone", async (t) => {
  const { dir, checkpoints } = await game(t);
  await checkpoints.take(dir, "thread-1", "msg_a");
  await fs.writeFile(path.join(dir, "src", "boss.js"), "boss();\n");
  await checkpoints.take(dir, "thread-1", "msg_a", "after");
  // The person edits a file between answers; the next answer changes another.
  await fs.writeFile(path.join(dir, "src", "main.js"), "my own tweak();\n");
  await checkpoints.take(dir, "thread-1", "msg_b");
  await fs.writeFile(path.join(dir, "src", "music.js"), "music();\n");
  await checkpoints.take(dir, "thread-1", "msg_b", "after");
  assert.deepEqual(await checkpoints.plan(dir, "thread-1", "msg_a", ["msg_a", "msg_b"]), {
    state: "restore",
    files: 3,
    outside: ["src/main.js"],
    outsideUnknown: false,
    nested: [],
    tooLarge: 0,
  });
  const { saved } = await checkpoints.restore(dir, "thread-1", "msg_a");
  assert.equal(await exists(dir, "src/boss.js"), false);
  await checkpoints.putBack(dir, saved);
  assert.equal(await read(dir, "src/main.js"), "my own tweak();\n");
  assert.equal(await read(dir, "src/music.js"), "music();\n");
});

test("files the repository tells git to skip are still saved and restored", async (t) => {
  const { dir, checkpoints } = await game(t);
  await git(dir, ["update-index", "--assume-unchanged", "src/main.js"]);
  await fs.writeFile(path.join(dir, "src", "main.js"), "local();\n");
  await checkpoints.take(dir, "thread-1", "msg_a");
  await fs.writeFile(path.join(dir, "src", "main.js"), "answer();\n");
  await checkpoints.restore(dir, "thread-1", "msg_a");
  assert.equal(await read(dir, "src/main.js"), "local();\n");
});

test("files too large to keep are never deleted or overwritten by a restore, and do not stop later checkpoints", async (t) => {
  const { dir, checkpoints } = await game(t);
  const big = (file: string) => fs.truncate(path.join(dir, file), CHECKPOINT_FILE_MAX_BYTES + 1);
  // Too large before the message: the answer shrinks it, and the rewind must not delete it.
  await fs.writeFile(path.join(dir, "intro.mp4"), "");
  await big("intro.mp4");
  // Small and saved before the message: it grows past the limit afterwards.
  await fs.writeFile(path.join(dir, "music.ogg"), "v1 small");
  await checkpoints.take(dir, "thread-1", "msg_a");
  await fs.writeFile(path.join(dir, "intro.mp4"), "compressed");
  await big("music.ogg");
  await fs.writeFile(path.join(dir, "src", "main.js"), "changed();\n");
  assert.ok(
    await checkpoints.take(dir, "thread-1", "msg_a", "after"),
    "a grown file does not break the next checkpoint",
  );
  assert.deepEqual(await checkpoints.plan(dir, "thread-1", "msg_a"), {
    state: "restore",
    files: 1,
    outside: [],
    outsideUnknown: false,
    nested: [],
    tooLarge: 2,
  });
  await checkpoints.restore(dir, "thread-1", "msg_a");
  assert.equal(await read(dir, "intro.mp4"), "compressed");
  assert.equal((await fs.stat(path.join(dir, "music.ogg"))).size, CHECKPOINT_FILE_MAX_BYTES + 1);
  assert.equal(await read(dir, "src/main.js"), "jump();\n");
});

test("a folder standing where the checkpoint had a file is kept while it holds anything never saved", async (t) => {
  const { dir, checkpoints } = await game(t);
  await fs.writeFile(path.join(dir, "server"), "old launcher\n");
  await checkpoints.take(dir, "thread-1", "msg_a");
  await fs.rm(path.join(dir, "server"));
  await fs.mkdir(path.join(dir, "server"));
  await fs.writeFile(path.join(dir, "server", "index.js"), "serve();\n");
  await fs.writeFile(path.join(dir, "server", ".env"), "TOKEN=secret\n");
  await checkpoints.restore(dir, "thread-1", "msg_a");
  assert.equal(await read(dir, "server/.env"), "TOKEN=secret\n", "never saved, so never deleted");
  assert.equal(await read(dir, "server/index.js"), "serve();\n", "the place is left whole, not half undone");
});

test("a user whose git converts line endings gets every file back byte for byte", async (t) => {
  // Git for Windows installs with core.autocrlf=true: a restore wrote LF files back as CRLF.
  const config = await fs.mkdtemp(path.join(os.tmpdir(), "studio-autocrlf-"));
  t.after(() => fs.rm(config, { recursive: true, force: true }));
  await fs.writeFile(path.join(config, "gitconfig"), "[core]\n\tautocrlf = true\n");
  const saved = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = path.join(config, "gitconfig");
  t.after(() => {
    if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = saved;
  });
  const { dir, checkpoints } = await game(t);
  await fs.writeFile(path.join(dir, "notes.txt"), "lf\nonly\n");
  await fs.writeFile(path.join(dir, "windows.txt"), "crlf\r\nkept\r\n");
  await checkpoints.take(dir, "thread-1", "msg_a");
  for (const file of ["src/main.js", "notes.txt", "windows.txt"]) await fs.writeFile(path.join(dir, file), "edited\n");
  await checkpoints.restore(dir, "thread-1", "msg_a");
  assert.equal(await read(dir, "src/main.js"), "jump();\n");
  assert.equal(await read(dir, "notes.txt"), "lf\nonly\n");
  assert.equal(await read(dir, "windows.txt"), "crlf\r\nkept\r\n");
});

test("a restore that fails partway puts the folder back as it was", {
  skip: process.platform === "win32" && "chmod cannot make a folder read-only on Windows",
}, async (t) => {
  const { dir, checkpoints } = await game(t);
  await fs.mkdir(path.join(dir, "locked"));
  await fs.writeFile(path.join(dir, "locked", "x.js"), "v1\n");
  await checkpoints.take(dir, "thread-1", "msg_a");
  await fs.writeFile(path.join(dir, "added.js"), "new\n");
  await fs.writeFile(path.join(dir, "locked", "x.js"), "v2\n");
  await fs.chmod(path.join(dir, "locked"), 0o555);
  try {
    await assert.rejects(checkpoints.restore(dir, "thread-1", "msg_a"));
    assert.equal(await read(dir, "added.js"), "new\n", "what the failed restore removed came back");
    assert.equal(await read(dir, "locked/x.js"), "v2\n");
  } finally {
    await fs.chmod(path.join(dir, "locked"), 0o755);
  }
});

test("when a later answer left no checkpoint, changes outside the chat are reported as unknown", async (t) => {
  const { dir, checkpoints } = await game(t);
  await checkpoints.take(dir, "thread-1", "msg_a");
  await fs.writeFile(path.join(dir, "src", "boss.js"), "boss();\n");
  await checkpoints.take(dir, "thread-1", "msg_a", "after");
  await fs.writeFile(path.join(dir, "notes.md"), "mine\n");
  assert.equal(await checkpoints.take(dir, "thread-1", "msg_b", "before", Date.now() - 1), null, "too late to keep");
  await fs.writeFile(path.join(dir, "src", "music.js"), "music();\n");
  const plan = await checkpoints.plan(dir, "thread-1", "msg_a", ["msg_a", "msg_b"]);
  assert.equal(plan.state === "restore" && plan.outsideUnknown, true);
  // Files the withdrawn messages saved themselves are the chat's, not someone else's.
  const credited = await checkpoints.plan(dir, "thread-1", "msg_a", ["msg_a"], ["notes.md", "src/music.js"]);
  assert.deepEqual(credited.state === "restore" && credited.outside, []);
});

test("a nested repository with a non-ASCII name and a stale index lock do not stop checkpoints", async (t) => {
  const { dir, checkpoints } = await game(t);
  await fs.mkdir(path.join(dir, "игра"));
  await git(path.join(dir, "игра"), ["init", "-q"]);
  await fs.writeFile(path.join(dir, "игра", "main.js"), "x\n");
  assert.ok(await checkpoints.take(dir, "thread-1", "msg_a"));
  const indexes = path.join(path.dirname(dir), "indexes");
  for (const file of await fs.readdir(indexes))
    if (file.endsWith(".index")) await fs.writeFile(path.join(indexes, `${file}.lock`), "");
  await fs.writeFile(path.join(dir, "src", "main.js"), "changed();\n");
  assert.ok(await checkpoints.take(dir, "thread-1", "msg_b"));
});

test(".env.local and friends never enter a checkpoint and are never deleted, whatever .gitignore says", async (t) => {
  const { dir, checkpoints } = await game(t);
  await fs.writeFile(path.join(dir, ".env.local"), "KEY=old\n");
  await checkpoints.take(dir, "thread-1", "msg_a");
  await fs.mkdir(path.join(dir, "server"));
  await fs.writeFile(path.join(dir, "server", ".env.production"), "KEY=prod\n");
  await fs.writeFile(path.join(dir, ".env.local"), "KEY=new\n");
  await fs.writeFile(path.join(dir, "src", "main.js"), "changed();\n");
  await checkpoints.take(dir, "thread-1", "msg_a", "after");
  for (const ref of (await git(dir, ["for-each-ref", "--format=%(objectname)", "refs/studio/chat/"]))
    .trim()
    .split("\n")) {
    assert.doesNotMatch(await git(dir, ["ls-tree", "-r", "--name-only", ref]), /\.env\./);
  }
  await checkpoints.restore(dir, "thread-1", "msg_a");
  assert.equal(await read(dir, ".env.local"), "KEY=new\n");
  assert.equal(await read(dir, "server/.env.production"), "KEY=prod\n");
  assert.equal(
    await exists(dir, ".studio-checkpoint-left-out.json"),
    false,
    "the record of what was left out stays in the checkpoint",
  );
});

test("a file too large to save standing where the checkpoint had a folder is left alone", async (t) => {
  const { dir, checkpoints } = await game(t);
  await fs.mkdir(path.join(dir, "intro"));
  await fs.writeFile(path.join(dir, "intro", "frame1.png"), "f1");
  await checkpoints.take(dir, "thread-1", "msg_a");
  await fs.rm(path.join(dir, "intro"), { recursive: true });
  await fs.writeFile(path.join(dir, "intro"), "");
  await fs.truncate(path.join(dir, "intro"), CHECKPOINT_FILE_MAX_BYTES + 1);
  assert.deepEqual(await checkpoints.plan(dir, "thread-1", "msg_a"), { state: "unavailable", reason: "too-large" });
  await checkpoints.restore(dir, "thread-1", "msg_a");
  assert.equal((await fs.stat(path.join(dir, "intro"))).size, CHECKPOINT_FILE_MAX_BYTES + 1);
});

test("a folder holding something never saved keeps what the answer put in it too", async (t) => {
  const { dir, checkpoints } = await game(t);
  await fs.writeFile(path.join(dir, ".gitignore"), "dist/\n*.log\n");
  await fs.writeFile(path.join(dir, "server"), "old launcher\n");
  await checkpoints.take(dir, "thread-1", "msg_a");
  await fs.rm(path.join(dir, "server"));
  await fs.mkdir(path.join(dir, "server"));
  await fs.writeFile(path.join(dir, "server", "index.js"), "serve();\n");
  await fs.writeFile(path.join(dir, "server", "debug.log"), "log\n");
  await checkpoints.restore(dir, "thread-1", "msg_a");
  assert.equal(await read(dir, "server/index.js"), "serve();\n", "not half undone");
  assert.equal(await read(dir, "server/debug.log"), "log\n");
});

test("a settled checkpoint operation releases its folder queue", async (t) => {
  const { dir, checkpoints } = await game(t);
  const set = Map.prototype.set;
  const queues = new Set<Map<unknown, unknown>>();
  t.mock.method(Map.prototype, "set", function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
    if (key === dir && value instanceof Promise) queues.add(this);
    return set.call(this, key, value);
  });
  await checkpoints.take(dir, "thread-1", "queue-release");
  assert.ok(queues.size > 0);
  for (const queue of queues) assert.equal(queue.has(dir), false);
});
