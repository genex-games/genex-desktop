/**
 * The frames a video is rendered from stay out of a game's history: a folder of numbered pictures
 * large enough to be a render's dump is added to the game's ignore rules before Genex commits, so
 * no save point or chat checkpoint holds it, and it stays on disk for the person.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { chatCheckpointRef } from "../../src/main/chat-checkpoints.ts";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";
import { SnapshotScope } from "../../src/shared/event-log.ts";
import { pathExists } from "../../src/substrate/fsx.ts";
import { RENDER_DUMP_MIN_BYTES, RENDER_DUMP_MIN_FILES, renderDumpRules } from "../../src/substrate/render-dumps.ts";
import { ensureRepo, git } from "../../src/substrate/snapshots.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** How long a test waits for the core's checkpoint of a message, and how often it looks. */
const CHECKPOINT_WAIT_MS = 10_000;
const CHECKPOINT_POLL_MS = 50;

/** One frame's size, so a dump of the fewest frames is just past the byte floor. */
const FRAME_BYTES = Math.ceil((RENDER_DUMP_MIN_BYTES * 1.1) / RENDER_DUMP_MIN_FILES);

/** The files a commit holds. */
const treeOf = async (dir: string, commit: string) =>
  (await git(dir, ["ls-tree", "-r", "--name-only", commit])).split("\n").filter(Boolean);

/**
 * Write `count` numbered pictures into `folder` (`frame_0001.png`…), each `bytes` long. Sparse:
 * the size is real to `lstat` and costs no disk.
 */
async function writeFrames(
  dir: string,
  folder: string,
  {
    count = RENDER_DUMP_MIN_FILES,
    bytes = FRAME_BYTES,
    name = (i: number) => `frame_${String(i).padStart(4, "0")}.png`,
  } = {},
): Promise<string[]> {
  await mkdir(path.join(dir, folder), { recursive: true });
  const files: string[] = [];
  for (let i = 1; i <= count; i++) {
    const rel = `${folder}/${name(i)}`;
    await writeFile(path.join(dir, rel), "\x89PNG\r\n\x1a\n");
    await truncate(path.join(dir, rel), bytes);
    files.push(rel);
  }
  return files;
}

/** A number spelled in letters (1 → "b"), for names with no digit in them. */
const letters = (n: number): string =>
  [...n.toString(26)].map((c) => String.fromCharCode(97 + Number.parseInt(c, 26))).join("");

/** A game folder with one commit, for the detector alone. */
async function repo(): Promise<string> {
  const dir = path.join(await tmpDir("studio-render-dumps-"), "game");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.html"), "<canvas></canvas>\n");
  await ensureRepo(dir);
  return dir;
}

describe("a video render's frames in a game", () => {
  let lite: CoreLite;
  before(async () => {
    lite = await coreLite();
  });
  after(() => lite.close());

  it("never land in a save point, and stay on disk beside the video", async () => {
    const project = "flythrough";
    await lite.core.games.scaffold(project);
    const dir = lite.core.games.dirFor(project);
    const frames = await writeFrames(dir, "docs/video/frames");
    await writeFile(path.join(dir, "docs/video/flythrough.mp4"), "mp4\n");

    const record = await lite.core.snapshot(SnapshotScope.Game, "after the render", project);
    assert.ok(record.git.game);
    const tree = await treeOf(dir, record.git.game);
    assert.ok(tree.includes("docs/video/flythrough.mp4"), "the video is kept");
    assert.deepEqual(
      tree.filter((file) => file.startsWith("docs/video/frames/")),
      [],
      "no frame is committed",
    );
    assert.ok((await readFile(path.join(dir, ".gitignore"), "utf8")).split("\n").includes("docs/video/frames/"));
    for (const file of [frames[0], frames.at(-1)])
      assert.ok(file && (await pathExists(path.join(dir, file))), `${file} stays on disk`);

    const next = await lite.core.snapshot(SnapshotScope.Game, "a later save point", project);
    assert.ok(next.git.game);
    assert.ok(!(await treeOf(dir, next.git.game)).some((file) => file.startsWith("docs/video/frames/")));
  });

  it("never land in a chat checkpoint", async () => {
    const project = "flythrough-chat";
    await lite.core.games.scaffold(project);
    const threadId = await lite.core.createGameThread(project);
    const dir = lite.core.games.dirFor(project);
    await writeFrames(dir, "renders/take-1");

    const append = (lite.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>)["events.append"];
    assert.ok(append);
    await append({ threadId, batch: [customEventData(CustomEvent.CoordinatorMessageProcessing, { messageId: "m1" })] });
    const ref = chatCheckpointRef(threadId, "m1");
    let commit = "";
    for (const deadline = Date.now() + CHECKPOINT_WAIT_MS; !commit && Date.now() < deadline; ) {
      commit = (await git(dir, ["rev-parse", "--verify", "-q", ref]).catch(() => "")).trim();
      if (!commit) await sleep(CHECKPOINT_POLL_MS);
    }
    assert.ok(commit, "the checkpoint was taken");
    assert.ok(!(await treeOf(dir, commit)).some((file) => file.startsWith("renders/")), "no frame is captured");
  });
});

describe("what reads as a render's dump", () => {
  it("is a folder of enough numbered pictures, large enough together", async () => {
    const dir = await repo();
    await writeFrames(dir, "out/seq", { name: (i) => `Shot.${String(i).padStart(4, "0")}.jpg` });
    assert.deepEqual(await renderDumpRules(dir), [{ base: "out", pattern: "seq/" }]);
  });

  it("names a dump at the game's root by its own folder", async () => {
    const dir = await repo();
    await writeFrames(dir, "frames");
    assert.deepEqual(await renderDumpRules(dir), [{ base: ".", pattern: "frames/" }]);
  });

  const notDumps: Array<{ why: string; folder: string; options: Parameters<typeof writeFrames>[2] }> = [
    { why: "too few frames", folder: "a", options: { count: RENDER_DUMP_MIN_FILES - 1, bytes: FRAME_BYTES * 2 } },
    { why: "a sprite animation's small frames", folder: "assets/run", options: { count: 400, bytes: 4096 } },
    { why: "pictures not numbered", folder: "assets/tex", options: { name: (i: number) => `rock-${letters(i)}.png` } },
    { why: "numbered files that are no pictures", folder: "logs", options: { name: (i: number) => `run_${i}.log` } },
  ];
  for (const { why, folder, options } of notDumps)
    it(`leaves alone ${why}`, async () => {
      const dir = await repo();
      await writeFrames(dir, folder, options);
      assert.deepEqual(await renderDumpRules(dir), []);
    });

  it("leaves alone frames the game already tracks", async () => {
    const dir = await repo();
    await writeFrames(dir, "cutscene");
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", "the person's own frames"]);
    assert.deepEqual(await renderDumpRules(dir), []);
  });

  it("answers nothing for a folder that is no repository", async () => {
    const dir = await tmpDir("studio-render-dumps-bare-");
    await writeFrames(dir, "frames");
    assert.deepEqual(await renderDumpRules(dir), []);
  });

  // A folder's name becomes an ignore line: anything git would read as more than that name.
  const hostileFolders = ["new\nline", "star*", "[set]", "!bang", "#hash", "back\\slash", "q?", " lead", "trail "];
  for (const folder of hostileFolders)
    it(`names no rule for the folder ${JSON.stringify(folder)}, and writes nothing`, async () => {
      const dir = await repo();
      const ignoreBefore = await readFile(path.join(dir, ".gitignore"), "utf8").catch(() => null);
      await writeFrames(dir, `renders/${folder}`);
      assert.deepEqual(await renderDumpRules(dir), []);
      assert.equal(await readFile(path.join(dir, ".gitignore"), "utf8").catch(() => null), ignoreBefore);
    });
});
