/**
 * The frames a video is rendered from stay out of a game's history: the numbered pictures of a
 * folder large enough to be a render's dump are added to the game's ignore rules before Genex
 * commits, so no save point or chat checkpoint holds them, they stay on disk for the person, and
 * the video and every other file beside them are still saved.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ChatCheckpoints, chatCheckpointRef } from "../../src/main/chat-checkpoints.ts";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";
import { SnapshotScope } from "../../src/shared/event-log.ts";
import { ignoreLine, ruleMatches } from "../../src/shared/project-workspace.ts";
import { pathExists } from "../../src/substrate/fsx.ts";
import { ensureFactIgnoreRules } from "../../src/substrate/nested-repos.ts";
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
    // The case a whole-folder rule lost: the video, a poster and a numbered texture in the frames' own folder.
    await writeFile(path.join(dir, "docs/video/frames/flythrough.mp4"), "mp4\n");
    await writeFile(path.join(dir, "docs/video/frames/poster.png"), "\x89PNG\r\n\x1a\n");
    await writeFile(path.join(dir, "docs/video/frames/tile1.png"), "\x89PNG\r\n\x1a\n");

    const record = await lite.core.snapshot(SnapshotScope.Game, "after the render", project);
    assert.ok(record.git.game);
    const tree = await treeOf(dir, record.git.game);
    assert.deepEqual(
      tree.filter((file) => file.startsWith("docs/video/frames/")),
      ["docs/video/frames/flythrough.mp4", "docs/video/frames/poster.png", "docs/video/frames/tile1.png"],
      "the video, the poster and the texture are kept, no frame is committed",
    );
    const ignoreLines = (await readFile(path.join(dir, ".gitignore"), "utf8")).split("\n");
    assert.ok(ignoreLines.includes("docs/video/frames/frame_[0-9][0-9][0-9][0-9].png"), "only the frames are left out");
    for (const file of [frames[0], frames.at(-1)])
      assert.ok(file && (await pathExists(path.join(dir, file))), `${file} stays on disk`);

    const next = await lite.core.snapshot(SnapshotScope.Game, "a later save point", project);
    assert.ok(next.git.game);
    assert.deepEqual(
      (await treeOf(dir, next.git.game)).filter((file) => file.startsWith("docs/video/frames/")),
      ["docs/video/frames/flythrough.mp4", "docs/video/frames/poster.png", "docs/video/frames/tile1.png"],
    );
  });

  it("stay on disk when a save point from before the render is restored", async () => {
    const project = "flythrough-restore";
    await lite.core.games.scaffold(project);
    const dir = lite.core.games.dirFor(project);
    const before = await lite.core.snapshot(SnapshotScope.Game, "before the render", project);
    const frames = await writeFrames(dir, "renders/take-1");
    await writeFile(path.join(dir, "renders/take-1/take-1.mp4"), "mp4\n");
    await lite.core.snapshot(SnapshotScope.Game, "after the render", project);

    // The restore's rescue runs after the frames' line was written: they are ignored by then.
    await lite.core.snapshots.restore(before, { gameWorkspace: project });
    assert.equal(await pathExists(path.join(dir, "renders/take-1/take-1.mp4")), false, "the video went back");
    for (const file of frames) assert.ok(await pathExists(path.join(dir, file)), `${file} stays on disk`);
    const ignoreLines = (await readFile(path.join(dir, ".gitignore"), "utf8")).split("\n");
    assert.ok(
      ignoreLines.includes("renders/take-1/frame_[0-9][0-9][0-9][0-9].png"),
      "the frames stay out of the next save point",
    );
  });

  it("never land in a chat checkpoint", async () => {
    const project = "flythrough-chat";
    await lite.core.games.scaffold(project);
    const threadId = await lite.core.createGameThread(project);
    const dir = lite.core.games.dirFor(project);
    await writeFrames(dir, "renders/take-1");
    await writeFile(path.join(dir, "renders/take-1/take-1.mp4"), "mp4\n");

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
    assert.deepEqual(
      (await treeOf(dir, commit)).filter((file) => file.startsWith("renders/")),
      ["renders/take-1/take-1.mp4"],
      "the video is captured, no frame is",
    );
  });
});

describe("a chat rewound past a render", () => {
  it("keeps the frames on disk", async () => {
    const dir = await repo();
    await writeFile(path.join(dir, ".gitignore"), "node_modules/\n");
    const indexes = path.join(await tmpDir("studio-render-dumps-indexes-"), "indexes");
    // The rewind's own rules, as the core gives them (core/rewind.ts → ensureWorkspaceRules).
    const neverCaptured = async (at: string) => {
      const rules = await renderDumpRules(at);
      await ensureFactIgnoreRules(at, rules.map(ignoreLine));
      return rules;
    };
    const checkpoints = new ChatCheckpoints(indexes, undefined, { neverCaptured });
    await checkpoints.take(dir, "chat", "before");
    const frames = await writeFrames(dir, "renders/take-1");
    await writeFile(path.join(dir, "renders/take-1/take-1.mp4"), "mp4\n");
    const after = await checkpoints.take(dir, "chat", "after");
    assert.ok(after);
    assert.deepEqual(
      (await treeOf(dir, after)).filter((file) => file.startsWith("renders/")),
      ["renders/take-1/take-1.mp4"],
    );

    await checkpoints.restore(dir, "chat", "before");
    assert.equal(
      await pathExists(path.join(dir, "renders/take-1/take-1.mp4")),
      false,
      "the video went back with the chat",
    );
    for (const file of frames) assert.ok(await pathExists(path.join(dir, file)), `${file} stays on disk`);
  });
});

describe("what reads as a render's dump", () => {
  it("is a folder of enough numbered pictures, large enough together", async () => {
    const dir = await repo();
    await writeFrames(dir, "out/seq", { name: (i) => `Shot.${String(i).padStart(4, "0")}.jpg` });
    assert.deepEqual(await renderDumpRules(dir), [{ base: "out/seq", pattern: "Shot.[0-9][0-9][0-9][0-9].jpg" }]);
  });

  it("names a folder at the game's root by itself", async () => {
    const dir = await repo();
    await writeFrames(dir, "frames");
    assert.deepEqual(await renderDumpRules(dir), [{ base: "frames", pattern: "frame_[0-9][0-9][0-9][0-9].png" }]);
  });

  it("judges each sequence on its own and names it by its prefix, width and extension as spelled", async () => {
    const dir = await repo();
    await writeFrames(dir, "seq");
    // Unpadded, so its names come in three widths: 1 … 9, 10 … 99, 100 … 120.
    await writeFrames(dir, "seq", { name: (i) => `beauty.${i}.EXR` });
    // Too few to be a render, though the folder holds enough numbered pictures together.
    await writeFrames(dir, "seq", { count: 10, name: (i) => `tile${i}.png` });
    // Stray pictures named like the padded frames, but unpadded: a run of their own, too short.
    for (const stray of ["frame_1.png", "frame_12.png"])
      await writeFile(path.join(dir, "seq", stray), "\x89PNG\r\n\x1a\n");
    const rules = await renderDumpRules(dir);
    assert.deepEqual(rules.map(({ pattern }) => pattern).sort(), [
      "beauty.[0-9].EXR",
      "beauty.[0-9][0-9].EXR",
      "beauty.[0-9][0-9][0-9].EXR",
      "frame_[0-9][0-9][0-9][0-9].png",
    ]);
    const leftOut = (file: string) => rules.some((rule) => ruleMatches(file, rule));
    for (const frame of ["seq/frame_0001.png", "seq/beauty.7.EXR", "seq/beauty.12.EXR", "seq/beauty.120.EXR"])
      assert.ok(leftOut(frame), `${frame} is left out`);
    const kept = [
      "seq/tile1.png",
      "seq/enemy2.png",
      "seq/frame_1.png",
      "seq/frame_12.png",
      "seq/poster.png",
      "seq/take_1.mp4",
      "other/frame_0001.png",
    ];
    for (const file of kept) assert.ok(!leftOut(file), `${file} stays in history`);
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

  it("answers again the frames rules the ignore file holds, once their frames are ignored", async () => {
    const dir = await repo();
    await writeFrames(dir, "renders/take-1");
    const lines = (await renderDumpRules(dir)).map(ignoreLine);
    assert.deepEqual(lines, ["renders/take-1/frame_[0-9][0-9][0-9][0-9].png"]);
    // Lines of the same shape whose folder is no plain folder of the game are not Genex's to answer.
    const others = ["star*/f_[0-9].png", "/[0-9].png", "./[0-9].png", "../shots/[0-9].png", "a/../b/[0-9].png"];
    await writeFile(path.join(dir, ".gitignore"), [...lines, ...others, ""].join("\n"));
    assert.deepEqual((await renderDumpRules(dir)).map(ignoreLine), lines);
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
    it(`names no rule for the folder ${JSON.stringify(folder)}`, async () => {
      const dir = await repo();
      await writeFrames(dir, `renders/${folder}`);
      assert.deepEqual(await renderDumpRules(dir), []);
    });
});
