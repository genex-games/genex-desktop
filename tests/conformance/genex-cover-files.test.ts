/**
 * genex__cover keeps the cover the game's agent made: a picture, and optionally a clip, inside the
 * game folder, named by path (`{ image, clip? }`). Studio reads each by its bytes, checks what Genex
 * needs (a PNG or JPEG of at least 1280×720 within 8 MB; a WebM or MP4 of at least five seconds),
 * measures the picture's light the way Genex's gate does, and copies both into the Genex plugin's
 * own storage. It takes no frame of the game for the agent's cover, and anything it refuses leaves
 * no trace: nothing kept, nothing changed in the game.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { createGenexPlugin } from "../../src/plugins/genex/backend.ts";
import { encodePng } from "../../src/substrate/png.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT = "harbour-run";
const FIXTURES = path.resolve("tests/fixtures/genex-cover");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/**
 * A 1920×1080 PNG whose red rises left to right and whose green and blue stay put: its Rec.709 luma
 * mean is known, and `level` scales it, so a dark one is easy to make.
 */
function gradientPng(level = 1, width = 1920, height = 1080): Buffer {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      rgb[at] = Math.round(level * (40 + (180 * x) / (width - 1)));
      rgb[at + 1] = Math.round(level * 120);
      rgb[at + 2] = Math.round(level * 60);
    }
  return encodePng({ width, height, rgb });
}
/** That PNG's luma mean (0–1): Rec.709 over its mean red, green and blue. */
const gradientLuma = (level = 1) => (level * (0.2126 * 130 + 0.7152 * 120 + 0.0722 * 60)) / 255;

/** Every file under `dir`, relative to it and sorted. */
async function filesUnder(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

interface CoverAnswer {
  shot: {
    sha256: string;
    width: number;
    height: number;
    mimeType: string;
    source?: string;
    stats: { lumaMean: number; lumaStdDev: number; nearBlackFraction: number; litFraction: number };
    advice: string[];
  };
  clip: { sha256: string; mimeType: string; width: number; height: number; durationMs: number; motion?: number } | null;
  guidance: string;
}

/** The Genex plugin's backend bound to a game whose agent left its cover in `shots/`, every host call recorded. */
async function agentCover() {
  const temp = await tmpDir("studio-genex-cover-files-");
  const storage = path.join(temp, "storage");
  const game = path.join(temp, "game");
  const outside = path.join(temp, "outside");
  await mkdir(path.join(game, "shots"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(game, "index.html"), "<!doctype html><title>Harbour Run</title>");
  await writeFile(path.join(game, "shots", "cover.png"), gradientPng());
  for (const name of ["clip.webm", "clip.mp4", "clip-live.webm", "short.mp4", "small.jpg", "dark.jpg"])
    await copyFile(path.join(FIXTURES, name), path.join(game, "shots", name));
  for (const name of ["lit-baseline.jpg", "lit-progressive.jpg", "lit-grey.jpg"])
    await copyFile(path.join(FIXTURES, name), path.join(game, "shots", name));
  await writeFile(path.join(outside, "cover.png"), gradientPng());
  await writeFile(path.join(outside, "clip.webm"), await readFile(path.join(FIXTURES, "clip.webm")));
  const calls: string[] = [];
  const plugin = await createGenexPlugin("http://127.0.0.1:9");
  const ctx = {
    project: PROJECT,
    directory: game,
    host: async (method: string) => {
      calls.push(method);
      if (method === "storage.root") return storage;
      if (method === "credentials.session") return null;
      if (method === "events.emit") return true;
      throw new Error(`unexpected host call ${method}`);
    },
  };
  const cover = async (args: Record<string, unknown>) =>
    (await plugin.tool("cover", args, ctx)) as unknown as CoverAnswer;
  const kept = () => filesUnder(path.join(storage, "covers"));
  return { temp, storage, game, outside, calls, cover, kept };
}

describe("genex__cover keeps the agent's own cover", () => {
  it("copies the picture and the clip into the plugin's storage, measured, and takes no frame of the game", async () => {
    const fx = await agentCover();
    const before = await filesUnder(fx.game);
    const answer = await fx.cover({ image: "shots/cover.png", clip: "shots/clip.webm" });
    const picture = gradientPng();
    const clip = await readFile(path.join(FIXTURES, "clip.webm"));
    assert.deepEqual(await fx.kept(), [
      `${PROJECT}/agent.json`,
      `${PROJECT}/candidates.json`,
      `${PROJECT}/candidates/${sha256(picture)}.png`,
      `${PROJECT}/clip.json`,
      `${PROJECT}/clip.webm`,
      `${PROJECT}/shot.json`,
      `${PROJECT}/shot.png`,
    ]);
    assert.deepEqual(await readFile(path.join(fx.storage, "covers", PROJECT, "shot.png")), picture);
    assert.deepEqual(await readFile(path.join(fx.storage, "covers", PROJECT, "clip.webm")), clip);
    assert.equal(answer.shot.sha256, sha256(picture));
    assert.equal(answer.shot.width, 1920);
    assert.equal(answer.shot.height, 1080);
    assert.equal(answer.shot.mimeType, "image/png");
    assert.equal(answer.shot.source, undefined, "no capture of Studio's took it");
    assert.ok(Math.abs(answer.shot.stats.lumaMean - gradientLuma()) < 0.01, JSON.stringify(answer.shot.stats));
    assert.equal(answer.shot.stats.nearBlackFraction, 0);
    assert.deepEqual(answer.shot.advice, []);
    assert.equal(answer.clip?.sha256, sha256(clip));
    assert.equal(answer.clip?.mimeType, "video/webm");
    assert.deepEqual([answer.clip?.width, answer.clip?.height, answer.clip?.durationMs], [320, 180, 5500]);
    assert.equal(answer.clip?.motion, undefined, "Studio decodes no footage");
    assert.match(answer.guidance, /first publish/);
    assert.ok(!fx.calls.includes("observe"), "the host is asked for no frame of the game");
    assert.deepEqual(await filesUnder(fx.game), before, "the game is untouched");
    const took = JSON.parse(await readFile(path.join(fx.storage, "covers", PROJECT, "agent.json"), "utf8"));
    assert.ok(took.shot && took.clip, "Publish hears the agent kept a picture and a clip");
  });

  it("reads a JPEG's light from its blocks, baseline, progressive or grey, and an absolute path inside the game", async () => {
    const fx = await agentCover();
    const means: number[] = [];
    for (const name of ["lit-baseline.jpg", "lit-progressive.jpg", "lit-grey.jpg"]) {
      const answer = await fx.cover({ image: path.join(fx.game, "shots", name) });
      assert.equal(answer.shot.mimeType, "image/jpeg", name);
      assert.deepEqual([answer.shot.width, answer.shot.height], [1280, 720], name);
      assert.deepEqual(answer.shot.advice, [], name);
      means.push(answer.shot.stats.lumaMean);
    }
    // The fixtures' luma: BT.601 over red v, green 0.8v and blue 255 − v, v rising 40 to 220.
    for (const mean of means) assert.ok(Math.abs(mean - 0.4477) < 0.01, `${means}`);
    const clipOnly = await fx.cover({ image: "./shots/cover.png", clip: "shots/clip.mp4" });
    assert.deepEqual([clipOnly.clip?.mimeType, clipOnly.clip?.durationMs], ["video/mp4", 5500]);
    const live = await fx.cover({ image: "shots/cover.png", clip: "shots/clip-live.webm" });
    assert.ok((live.clip?.durationMs ?? 0) >= 5400, "a WebM a browser recorded is timed by its last frame");
  });

  it("keeps a dark or a small-but-allowed picture and says what Genex will likely do with it", async () => {
    const fx = await agentCover();
    const dark = await fx.cover({ image: "shots/dark.jpg" });
    assert.ok(dark.shot.advice.includes("too_dark"), JSON.stringify(dark.shot));
    assert.match(dark.guidance, /too dark/);
    await writeFile(path.join(fx.game, "shots", "square.png"), gradientPng(1, 1440, 1440));
    const square = await fx.cover({ image: "shots/square.png" });
    assert.deepEqual(square.shot.advice, ["not_16_9"]);
    assert.match(square.guidance, /crops it to its middle 16:9/);
  });
});

describe("genex__cover refuses what it cannot keep, and keeps nothing", () => {
  const posix = process.platform !== "win32";
  /** One refusal: what the agent passed, what the game holds for it, and the words the refusal names. */
  type Row = [label: string, args: (fx: Fixture) => Record<string, unknown>, expected: RegExp, setup?: Setup];
  type Fixture = Awaited<ReturnType<typeof agentCover>>;
  type Setup = (fx: Fixture) => Promise<unknown>;
  const ROWS: Row[] = [
    ["no picture at all", () => ({}), /Pass image/],
    ["a picture that is no path", () => ({ image: 3 }), /must be a path inside this game's folder/],
    ["an empty path", () => ({ image: "  " }), /must be a path/],
    ["a parent step out of the game", () => ({ image: "../outside/cover.png" }), /inside this game's folder/],
    ["an absolute path outside the game", (fx) => ({ image: path.join(fx.outside, "cover.png") }), /inside/],
    ["the game folder itself", (fx) => ({ image: fx.game }), /must be a path|inside/],
    ["a folder", () => ({ image: "shots" }), /must name a file/],
    ["a file that is not there", () => ({ image: "shots/nope.png" }), /no file at shots\/nope\.png/],
    [
      "a text file",
      () => ({ image: "notes.png" }),
      /PNG or a JPEG/,
      (fx) => writeFile(path.join(fx.game, "notes.png"), "a picture, honestly"),
    ],
    [
      "a GIF",
      () => ({ image: "shots/cover.gif" }),
      /PNG or a JPEG/,
      (fx) => writeFile(path.join(fx.game, "shots", "cover.gif"), Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;")),
    ],
    ["a picture under 1280×720", () => ({ image: "shots/small.jpg" }), /640×360: Genex needs at least 1280×720/],
    [
      "a picture over Genex's 8 MB",
      () => ({ image: "shots/huge.png" }),
      /over Genex's 8 MB limit/,
      async (fx) => {
        const file = path.join(fx.game, "shots", "huge.png");
        await writeFile(file, gradientPng());
        await truncate(file, 8 * 1024 * 1024 + 1);
      },
    ],
    [
      "a damaged JPEG",
      () => ({ image: "shots/cut.jpg" }),
      /could not read this JPEG/,
      async (fx) => {
        const whole = await readFile(path.join(FIXTURES, "lit-baseline.jpg"));
        await writeFile(path.join(fx.game, "shots", "cut.jpg"), whole.subarray(0, 400));
      },
    ],
    [
      "a damaged PNG",
      () => ({ image: "shots/cut.png" }),
      /could not read this PNG/,
      async (fx) => writeFile(path.join(fx.game, "shots", "cut.png"), gradientPng().subarray(0, 200)),
    ],
    ["a clip that is no video", () => ({ image: "shots/cover.png", clip: "shots/cover.png" }), /WebM or an MP4/],
    ["a clip under five seconds", () => ({ image: "shots/cover.png", clip: "shots/short.mp4" }), /2\.0 s/],
    [
      "a clip outside the game",
      (fx) => ({ image: "shots/cover.png", clip: path.join(fx.outside, "clip.webm") }),
      /inside/,
    ],
  ];
  const LINK_ROWS: Row[] = [
    [
      "a link out of the game",
      () => ({ image: "shots/link.png" }),
      /inside this game's folder/,
      (fx) => symlink(path.join(fx.outside, "cover.png"), path.join(fx.game, "shots", "link.png")),
    ],
    [
      "a folder linked out of the game",
      () => ({ image: "elsewhere/cover.png" }),
      /inside this game's folder/,
      (fx) => symlink(fx.outside, path.join(fx.game, "elsewhere")),
    ],
    [
      "a clip linked out of the game",
      () => ({ image: "shots/cover.png", clip: "shots/link.webm" }),
      /inside this game's folder/,
      (fx) => symlink(path.join(fx.outside, "clip.webm"), path.join(fx.game, "shots", "link.webm")),
    ],
  ];
  for (const [label, args, expected, setup] of [...ROWS, ...(posix ? LINK_ROWS : [])]) {
    it(`refuses ${label}`, async () => {
      const fx = await agentCover();
      await setup?.(fx);
      const game = await filesUnder(fx.game);
      const outside = await filesUnder(fx.outside);
      await assert.rejects(fx.cover(args(fx)), expected);
      assert.deepEqual(await fx.kept(), [], "nothing was kept");
      assert.deepEqual(await filesUnder(fx.game), game, "the game is untouched");
      assert.deepEqual(await filesUnder(fx.outside), outside, "nothing outside the game was touched");
      assert.ok(!fx.calls.includes("observe"), "the host is asked for no frame");
    });
  }

  it("keeps the last cover as it was when a later one is refused", async () => {
    const fx = await agentCover();
    const first = await fx.cover({ image: "shots/cover.png" });
    await assert.rejects(fx.cover({ image: "shots/cover.png", clip: "shots/short.mp4" }), /2\.0 s/);
    const record = JSON.parse(await readFile(path.join(fx.storage, "covers", PROJECT, "shot.json"), "utf8"));
    assert.equal(record.sha256, first.shot.sha256);
    assert.ok(!(await fx.kept()).includes(`${PROJECT}/clip.json`), "the refused clip was never kept");
  });
});
