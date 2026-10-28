/**
 * An engine game's cover reel: the picture and the frames of play its agent rendered in the engine
 * into `.studio/cover/`, copied into a folder of the host's own and played on a page there, so a
 * plugin's still or clip of a game that runs as an app is taken of what its engine drew. The folder
 * is the agent's: nothing through a link, nothing that is not the picture or video it claims, and
 * nothing over its caps is ever copied, and the reel's folder never outlives the take.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import {
  COVER_PICTURE_MAX_BYTES,
  type ReelConfig,
  runReel,
  stageCoverReel,
  takenFromReel,
} from "../../src/main/core/cover-reel.ts";
import { appCoverGuidance } from "../../src/main/core/cover-reel-prompts.ts";
import { CoreFact, FactSource, type ProjectFact } from "../../src/shared/project-facts.ts";
import { observeHost } from "../helpers/observe-windows.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
const MP4 = Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);
const tagged = (bytes: Buffer, tag: string) => Buffer.concat([bytes, Buffer.from(tag)]);

/** A game folder, its cover folder, and a folder outside it that a link may point at. */
async function gameWithCover() {
  const root = await realpath(await tmpDir("cover-reel-"));
  const game = path.join(root, "game");
  const cover = path.join(game, ".studio", "cover");
  const outside = path.join(root, "outside");
  const scratch = path.join(root, "scratch");
  await mkdir(cover, { recursive: true });
  await mkdir(outside, { recursive: true });
  return { root, game, cover, outside, scratch };
}

/** Every file under `dir`, relative to it and sorted. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

const VIEW = { stillDemo: "genex-cover", clipDemo: "genex-clip" };

describe("staging a cover reel", () => {
  it("copies the picture and the frames in play order under the host's names, beside the page that plays them", async () => {
    const { game, cover, scratch } = await gameWithCover();
    await writeFile(path.join(cover, "cover.png"), tagged(PNG, "picture"));
    await mkdir(path.join(cover, "clip"));
    for (const n of [10, 2, 1]) await writeFile(path.join(cover, "clip", `frame${n}.jpg`), tagged(JPEG, `f${n}`));
    await writeFile(path.join(cover, "clip", "frame.wav"), "audio Godot writes beside its frames");
    const reel = await stageCoverReel(game, scratch, VIEW);
    assert.ok(reel);
    assert.deepEqual(reel.config, {
      picture: "picture.png",
      frames: ["frames/0000.jpg", "frames/0001.jpg", "frames/0002.jpg"],
      video: null,
      fps: 30,
      stillDemo: "genex-cover",
      clipDemo: "genex-clip",
    });
    assert.deepEqual(
      await readFile(path.join(reel.dir, "frames", "0002.jpg")),
      tagged(JPEG, "f10"),
      "numbers sort as numbers",
    );
    const page = await readFile(path.join(reel.dir, "index.html"), "utf8");
    assert.ok(page.includes('"frames/0000.jpg"'));
    await reel.dispose();
    assert.deepEqual(await filesUnder(scratch), [], "nothing is left once it is given back");
  });

  it("takes a video when there are no frames, and lists only the views it has media for", async () => {
    const { game, cover, scratch } = await gameWithCover();
    await writeFile(path.join(cover, "clip.mp4"), tagged(MP4, "video"));
    const reel = await stageCoverReel(game, scratch, VIEW);
    assert.equal(reel?.config.video, "clip.mp4");
    assert.equal(reel?.config.stillDemo, null, "no picture, no still demo");
    assert.equal(reel?.config.clipDemo, "genex-clip");
    await reel?.dispose();
  });

  it("stages nothing, and leaves nothing behind, for a folder whose media is not what it claims or not its own", async (t) => {
    const cases: Array<[string, (f: Awaited<ReturnType<typeof gameWithCover>>) => Promise<void>]> = [
      ["no cover folder at all", (f) => rm(path.join(f.game, ".studio"), { recursive: true })],
      ["text named cover.png", async (f) => writeFile(path.join(f.cover, "cover.png"), "not a picture at all")],
      [
        "a picture over the cap",
        async (f) => {
          const file = path.join(f.cover, "cover.png");
          await writeFile(file, PNG);
          await truncate(file, COVER_PICTURE_MAX_BYTES + 1);
        },
      ],
      [
        "a picture that is a link out",
        async (f) => {
          await writeFile(path.join(f.outside, "secret.png"), tagged(PNG, "secret"));
          await symlink(path.join(f.outside, "secret.png"), path.join(f.cover, "cover.png"));
        },
      ],
      [
        "a cover folder that is a link out",
        async (f) => {
          await writeFile(path.join(f.outside, "cover.png"), tagged(PNG, "secret"));
          await rm(f.cover, { recursive: true });
          await symlink(f.outside, f.cover);
        },
      ],
      [
        "a .studio that is a link out",
        async (f) => {
          await mkdir(path.join(f.outside, "cover"));
          await writeFile(path.join(f.outside, "cover", "cover.png"), tagged(PNG, "secret"));
          await rm(path.join(f.game, ".studio"), { recursive: true });
          await symlink(f.outside, path.join(f.game, ".studio"));
        },
      ],
      [
        "a frames folder that is a link out",
        async (f) => {
          await writeFile(path.join(f.outside, "0001.png"), tagged(PNG, "secret"));
          await symlink(f.outside, path.join(f.cover, "clip"));
        },
      ],
      ["a video that is no video", async (f) => writeFile(path.join(f.cover, "clip.webm"), "plain words")],
      [
        "a FIFO named cover.png",
        async (f) => {
          if (process.platform === "win32") return;
          execFileSync("mkfifo", [path.join(f.cover, "cover.png")]);
        },
      ],
    ];
    for (const [name, arrange] of cases) {
      if (name.includes("FIFO") && process.platform === "win32") {
        t.diagnostic("no FIFO on Windows");
        continue;
      }
      const fixture = await gameWithCover();
      await arrange(fixture);
      const before = await filesUnder(fixture.root);
      assert.equal(await stageCoverReel(fixture.game, fixture.scratch, VIEW), null, name);
      assert.deepEqual(await filesUnder(fixture.scratch), [], `${name}: no reel folder left`);
      assert.deepEqual(await filesUnder(fixture.root), before, `${name}: nothing else changed`);
    }
  });

  it("skips a frame that is a link out or no picture, and keeps the rest in order", async () => {
    const { game, cover, outside, scratch } = await gameWithCover();
    await mkdir(path.join(cover, "clip"));
    await writeFile(path.join(cover, "clip", "0001.png"), tagged(PNG, "one"));
    await writeFile(path.join(outside, "secret.png"), tagged(PNG, "secret"));
    await symlink(path.join(outside, "secret.png"), path.join(cover, "clip", "0002.png"));
    await writeFile(path.join(cover, "clip", "0003.png"), "words");
    await writeFile(path.join(cover, "clip", "0004.png"), tagged(PNG, "four"));
    const reel = await stageCoverReel(game, scratch, VIEW);
    assert.deepEqual(reel?.config.frames, ["frames/0000.png", "frames/0001.png"]);
    assert.deepEqual(await readFile(path.join(reel?.dir ?? "", "frames", "0001.png")), tagged(PNG, "four"));
    await reel?.dispose();
  });
});

const fact = (id: string, at = "."): ProjectFact => ({ id, path: at, source: FactSource.Core });

describe("which games are taken from their reel", () => {
  it("is a game made in an app engine, or any game not served as a web page", () => {
    const rows: Array<[string, ProjectFact[], boolean]> = [
      ["a Unity game", [fact(CoreFact.UnityProject, "unity")], true],
      ["a Godot game with its web export", [fact(CoreFact.GodotProject), fact(CoreFact.WebGame, "export")], true],
      ["an Unreal game", [fact(CoreFact.UnrealProject)], true],
      ["a web game", [fact(CoreFact.WebGame)], false],
      ["a web game with Blender files", [fact(CoreFact.WebGame), fact(CoreFact.BlenderAssets, "art")], false],
      ["a folder of no kind yet, served as a web page", [], false],
    ];
    for (const [name, facts, reeled] of rows) assert.equal(takenFromReel({ facts }), reeled, name);
  });
});

/**
 * The reel's page run on a fake page: a canvas that writes down what it draws, pictures that load
 * at once, and a frame clock and a time the test moves.
 */
function reelPage(config: ReelConfig) {
  const drawn: string[] = [];
  const frames: Array<() => void> = [];
  let now = 0;
  class FakeImage {
    src = "";
    naturalWidth = 1920;
    naturalHeight = 1080;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set source(_v: string) {}
    constructor() {
      queueMicrotask(() => this.onload?.());
    }
  }
  const context = {
    fillStyle: "",
    fillRect: () => {},
    drawImage: (image: FakeImage) => drawn.push(image.src),
  };
  const canvas = { width: 0, height: 0, getContext: () => context };
  const window = { innerWidth: 1920, innerHeight: 1080, devicePixelRatio: 1 } as Record<string, unknown>;
  const sandbox = {
    window,
    document: { querySelector: () => canvas, createElement: () => ({}) },
    Image: FakeImage,
    HTMLVideoElement: class {},
    performance: { now: () => now },
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    Promise,
    Math,
    Number,
    Map,
    Error,
  };
  runInNewContext(`(${runReel.toString()})(${JSON.stringify(config)})`, sandbox);
  const own = window.__studio as Record<string, (arg?: string) => unknown>;
  // What the page answers is made in its own realm: read it as the host does, as plain data.
  const plain = (value: unknown) => (value === undefined ? value : JSON.parse(JSON.stringify(value)));
  const studio: Record<string, (arg?: string) => Promise<unknown>> = {};
  for (const [name, call] of Object.entries(own)) studio[name] = async (arg) => plain(await call(arg));
  /** Draw one frame of the page, and answer what it drew last. */
  const frame = () => {
    const next = frames.shift();
    next?.();
    return drawn.at(-1) ?? null;
  };
  return { studio, frame, canvas, advance: (ms: number) => (now += ms) };
}

const CONFIG: ReelConfig = {
  picture: "picture.png",
  frames: ["frames/0000.png", "frames/0001.png", "frames/0002.png", "frames/0003.png"],
  video: null,
  fps: 30,
  stillDemo: "genex-cover",
  clipDemo: "genex-clip",
};

describe("the reel's page", () => {
  it("lists its demos, holds the picture for the still and plays the frames from the first once started", async () => {
    const page = reelPage(CONFIG);
    assert.deepEqual(await page.studio.demos?.(), ["genex-cover", "genex-clip"]);
    assert.deepEqual(await page.studio.demo?.("genex-cover"), { ok: true });
    assert.equal(page.frame(), "picture.png");
    assert.equal(page.canvas.width, 1920, "the canvas fills the window");
    assert.deepEqual(await page.studio.demo?.("genex-clip"), { ok: true });
    assert.equal(page.frame(), "frames/0000.png", "a demo holds its first frame");
    page.advance(1000);
    assert.equal(page.frame(), "frames/0000.png", "nothing plays before start");
    page.studio.start?.();
    page.advance(100);
    assert.equal(page.frame(), "frames/0003.png", "three frames in at 30 a second");
    page.advance(34);
    assert.equal(page.frame(), "frames/0000.png", "and it loops");
    page.studio.pause?.();
    page.advance(500);
    assert.equal(page.frame(), "frames/0000.png", "a pause holds the frame");
  });

  it("answers the views it has no media for as unknown, and shows the clip's middle as its own view", async () => {
    const page = reelPage({ ...CONFIG, picture: null, stillDemo: null });
    assert.deepEqual(await page.studio.demos?.(), ["genex-clip"]);
    assert.deepEqual(await page.studio.demo?.("genex-cover"), { ok: false, available: ["genex-clip"] });
    assert.deepEqual(await page.studio.debugCamera?.("default"), { ok: true });
    assert.equal(page.frame(), "frames/0002.png");
    assert.deepEqual(await page.studio.debugCamera?.("close"), { ok: false, available: [] });
  });
});

describe("a plugin's still and clip of an engine game", () => {
  /** A Unity game in the library, with the cover its agent rendered. */
  async function unityHost() {
    // The windows stand in for the reel's page, whose own answers the tests above run.
    const host = await observeHost({ demos: ["genex-cover", "genex-clip"] }, { inLibrary: true });
    await mkdir(path.join(host.game, "unity", "ProjectSettings"), { recursive: true });
    await writeFile(path.join(host.game, "unity", "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0");
    const cover = path.join(host.game, ".studio", "cover");
    await mkdir(path.join(cover, "clip"), { recursive: true });
    await writeFile(path.join(cover, "cover.png"), tagged(PNG, "picture"));
    await writeFile(path.join(cover, "clip", "0001.png"), tagged(PNG, "frame"));
    return host;
  }

  it("is taken of its cover reel, served from a folder of the host's own that is gone afterwards", async () => {
    const host = await unityHost();
    const still = await host.still({ demo: "genex-cover", width: 1920, height: 1080 });
    assert.ok(still.still, JSON.stringify(still));
    const clip = await host.clip({ demo: "genex-clip", width: 960, height: 540 });
    assert.ok(clip.clip, JSON.stringify(clip));
    const loads = host.made.flatMap((port) => port.loads);
    assert.equal(loads.length, 2);
    for (const load of loads) {
      assert.equal(load.entry, "index.html");
      assert.ok(load.root?.startsWith(path.join(host.scratch, "cover-reels")), load.root);
      assert.ok(!load.root?.startsWith(host.game), "never served from the game folder");
    }
    assert.deepEqual(await filesUnder(path.join(host.scratch, "cover-reels")), [], "each reel is removed");
  });

  it("is taken of the game served when it left no cover, and a web game always is", async () => {
    const host = await observeHost({}, { inLibrary: true });
    const cover = path.join(host.game, ".studio", "cover");
    await mkdir(cover, { recursive: true });
    await writeFile(path.join(cover, "cover.png"), tagged(PNG, "picture"));
    await host.still({ demo: "hero-shot", width: 1920, height: 1080 });
    assert.deepEqual(
      host.made.flatMap((port) => port.loads),
      [{ entry: "index.html", root: host.game }],
      "a web game's own demo, from its own folder",
    );
  });
});

describe("what the session building an app's game is told", () => {
  it("names the folder, the picture, the frames and the engine's own way to render them", () => {
    for (const engine of [CoreFact.UnityProject, CoreFact.GodotProject, CoreFact.UnrealProject] as const) {
      const text = appCoverGuidance(engine);
      assert.ok(text.includes(".studio/cover/cover.png"), engine);
      assert.ok(text.includes(".studio/cover/clip/"), engine);
      assert.ok(text.includes("150 frames"), engine);
    }
    assert.ok(appCoverGuidance(CoreFact.GodotProject).includes("--write-movie"));
    assert.ok(appCoverGuidance(CoreFact.UnityProject).includes("Time.captureFramerate"));
    assert.ok(appCoverGuidance(CoreFact.UnrealProject).includes("Movie Render Queue"));
  });
});
