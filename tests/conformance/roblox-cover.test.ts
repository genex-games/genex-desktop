/**
 * A Roblox game's cover for Roblox itself: Studio's viewport made into the game icon and a
 * thumbnail in the game's `.genex/roblox-cover/`, for the agent to upload on the game's Creator Hub page.
 * The pictures are made by the system's own tools (`sips`, PowerShell), stood in for here; the
 * folder they go in is the game's own, never one a link leads out of.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  COVER_FOLDER,
  COVER_SIZES,
  CoverPicture,
  centredCrop,
  coverCommands,
  coverPictures,
  makeCover,
} from "../../src/plugins/roblox/cover-pictures.ts";
import { tmpDir } from "../helpers/tmp.ts";

const POSIX = { skip: process.platform === "win32" && "links and sips paths are POSIX here" };

/** A PNG header of `width` × `height`: all a size read needs. */
function pngOf(width: number, height: number): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "latin1");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
}

/** A stand-in for sips and PowerShell: each command's output file gets what it was made from. */
function recordingRun() {
  const runs: Array<{ file: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const run = async (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => {
    runs.push({ file, args, env });
    const out = args.indexOf("--out");
    if (out >= 0) await writeFile(String(args[out + 1]), `made from ${args[out - 1]}`);
  };
  return { runs, run };
}

describe("the cover's shapes", () => {
  it("crops about the centre to each picture's shape", () => {
    const rows: Array<[{ width: number; height: number }, CoverPicture, { width: number; height: number }]> = [
      [{ width: 1280, height: 720 }, CoverPicture.Icon, { width: 720, height: 720 }],
      [{ width: 1280, height: 720 }, CoverPicture.Thumbnail, { width: 1280, height: 720 }],
      [{ width: 1000, height: 1000 }, CoverPicture.Thumbnail, { width: 1000, height: 563 }],
      [{ width: 800, height: 1200 }, CoverPicture.Icon, { width: 800, height: 800 }],
      [{ width: 2560, height: 1080 }, CoverPicture.Thumbnail, { width: 1920, height: 1080 }],
    ];
    for (const [from, picture, crop] of rows)
      assert.deepEqual(centredCrop(from, COVER_SIZES[picture]), crop, `${from.width}×${from.height} ${picture}`);
  });

  it("makes each picture with sips on a Mac and PowerShell on Windows, never a path in a command", () => {
    const from = { width: 1280, height: 720 };
    const mac = coverCommands("darwin", {}, from, COVER_SIZES[CoverPicture.Icon], "/t/viewport.png", "/g/icon.png");
    assert.deepEqual(
      mac.map(({ file, args }) => [file, ...args]),
      [
        ["/usr/bin/sips", "-s", "format", "png", "-c", "720", "720", "/t/viewport.png", "--out", "/g/icon.png"],
        ["/usr/bin/sips", "-z", "512", "512", "/g/icon.png"],
      ],
    );
    const [windows] = coverCommands(
      "win32",
      { SystemRoot: "D:\\Win" },
      from,
      COVER_SIZES[CoverPicture.Thumbnail],
      "C:\\t\\viewport.png",
      "C:\\g\\thumbnail.png",
    );
    assert.equal(windows?.file, "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.ok(!windows?.args.join(" ").includes("C:\\"), "the paths travel in the environment");
    assert.equal(windows?.env.GENEX_COVER_IN, "C:\\t\\viewport.png");
    assert.equal(windows?.env.GENEX_COVER_OUT, "C:\\g\\thumbnail.png");
    assert.equal(windows?.env.GENEX_COVER_WIDTH, "1920");
    assert.equal(windows?.env.GENEX_COVER_HEIGHT, "1080");
  });
});

describe("making the cover", () => {
  it("writes the icon and the thumbnail into the game's .genex/roblox-cover", POSIX, async () => {
    const game = await tmpDir("roblox-cover-");
    const { runs, run } = recordingRun();
    const made = await makeCover(pngOf(1280, 720), game, { platform: "darwin", env: {}, run });
    const folder = path.join(game, COVER_FOLDER);
    assert.deepEqual(made, {
      [CoverPicture.Icon]: path.join(folder, "icon.png"),
      [CoverPicture.Thumbnail]: path.join(folder, "thumbnail.png"),
    });
    assert.deepEqual((await readdir(folder)).sort(), ["icon.png", "thumbnail.png"]);
    assert.equal(runs.length, 4, "a crop and a scale for each");
    const viewport = String(runs[0]?.args[6]);
    assert.ok(!viewport.startsWith(game), "the viewport's picture stays in a private temporary folder");
    await assert.rejects(lstat(viewport), "and is gone after");
  });

  it("refuses what isn't a picture, or a cover folder a link leads elsewhere, and writes nothing", POSIX, async () => {
    const game = await tmpDir("roblox-cover-");
    const elsewhere = await tmpDir("roblox-cover-elsewhere-");
    const { runs, run } = recordingRun();
    await assert.rejects(makeCover(Buffer.from("not a picture"), game, { platform: "darwin", env: {}, run }));
    await mkdir(path.join(game, ".genex"));
    await symlink(elsewhere, path.join(game, COVER_FOLDER));
    await assert.rejects(makeCover(pngOf(640, 360), game, { platform: "darwin", env: {}, run }));
    assert.deepEqual(runs, [], "nothing ran");
    assert.deepEqual(await readdir(elsewhere), [], "nothing landed outside the game");
  });

  it("replaces a picture that is a link instead of writing through it", POSIX, async () => {
    const game = await tmpDir("roblox-cover-");
    const elsewhere = await tmpDir("roblox-cover-elsewhere-");
    const target = path.join(elsewhere, "keep.txt");
    await writeFile(target, "keep");
    await mkdir(path.join(game, COVER_FOLDER), { recursive: true });
    await symlink(target, path.join(game, COVER_FOLDER, "icon.png"));
    const { run } = recordingRun();
    await makeCover(pngOf(640, 360), game, { platform: "darwin", env: {}, run });
    assert.equal(await readFile(target, "utf8"), "keep");
    assert.equal((await lstat(path.join(game, COVER_FOLDER, "icon.png"))).isSymbolicLink(), false);
  });
});

describe("cover-pictures", () => {
  it("answers where the pictures are, or why there are none, from Studio's viewport", POSIX, async () => {
    const game = await tmpDir("roblox-cover-");
    const { run } = recordingRun();
    const make = (picture: Buffer, folder: string) => makeCover(picture, folder, { platform: "darwin", env: {}, run });
    const shot = { data: pngOf(1280, 720).toString("base64") };
    const said = await coverPictures({ bound: () => true, shot: async () => shot, folder: game, make });
    assert.match(said, /icon\.png/);
    assert.match(said, /thumbnail\.png/);
    const folder = path.join(game, COVER_FOLDER);
    assert.ok(said.includes(folder), "the answer names the folder the file dialog goes to first");
    assert.ok(
      !said.includes(path.join(folder, "icon.png")),
      "a file dialog opens the folder, then picks the picture by name: no whole file path to paste",
    );
    assert.match(
      said,
      /create\.roblox\.com/,
      "the pictures go on the game's Creator Hub page, where Roblox takes them now",
    );
    const unbound = await coverPictures({ bound: () => false, shot: async () => shot, folder: game, make });
    assert.match(unbound, /isn't connected/);
    const blank = await coverPictures({ bound: () => true, shot: async () => null, folder: game, make });
    assert.match(blank, /couldn't take/i);
    const noFolder = await coverPictures({ bound: () => true, shot: async () => shot, folder: undefined, make });
    assert.match(noFolder, /no game folder/i);
  });
});
