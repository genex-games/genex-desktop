/**
 * The chat's Genex cover card shows the bound game's kept cover shot, read through one host read:
 * the `genex-cover` scope of `readProjectAsset`. The host builds the place itself from the game's
 * name (the Genex plugin's `covers/<project>/shot.png|jpg`), never from a path the renderer or a
 * plugin names, and answers null, touching nothing, for everything else.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readdir, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { before, it } from "node:test";
import { type ProjectAssetRead, ProjectAssetScope } from "../../src/shared/game-assets.ts";
import { GENEX_COVER_MAX_BYTES } from "../../src/shared/genex.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
/** The leading bytes of a JFIF JPEG, enough for the sniffer and for nothing else to read it as. */
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0xff, 0xd9,
]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1");
const GAME = "harbor-run";

let lite: CoreLite;
/** The Genex plugin's cover folders, `engine-homes/genex/covers`. */
let covers: string;
/** A folder beside the profile holding good pictures a hostile read would like to reach. */
let outside: string;

before(async () => {
  lite = await coreLite();
  covers = path.join(lite.core.layout.engineHomes, "genex", "covers");
  outside = await realpath(await tmpDir("genex-cover-outside-"));
  await writeFile(path.join(outside, "secret.png"), PNG);
  await mkdir(path.join(outside, "planted"), { recursive: true });
  await writeFile(path.join(outside, "planted", "shot.png"), PNG);
});

const cover = (project: unknown, extra: Record<string, unknown> = {}) =>
  ({ project, scope: ProjectAssetScope.GenexCover, ...extra }) as ProjectAssetRead;
const read = (request: ProjectAssetRead) => lite.core.readProjectAsset(request);

/** Leave exactly these files in a game's cover folder. */
async function keep(files: Record<string, Buffer | string>, project = GAME): Promise<string> {
  const dir = path.join(covers, project);
  await mkdir(dir, { recursive: true });
  for (const name of await readdir(dir)) await rm(path.join(dir, name), { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await writeFile(path.join(dir, name), bytes);
  return dir;
}

/** What an entry is, for the inventory. */
function kindOf(st: Awaited<ReturnType<typeof lstat>>): string {
  if (st.isSymbolicLink()) return "link";
  return st.isDirectory() ? "dir" : "file";
}

/** Every entry under `root`, as a link, folder or file with its size and time: what a read must not change. */
async function inventory(root: string): Promise<string[]> {
  const lines: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const file = path.join(dir, name);
      const st = await lstat(file);
      lines.push(`${path.relative(root, file)} ${kindOf(st)} ${st.size} ${st.mtimeMs}`);
      if (st.isDirectory() && !st.isSymbolicLink()) await walk(file);
    }
  };
  await walk(root);
  return lines;
}

/** Everything a read could touch: the profile's engine homes, the games and the folder outside. */
const everything = async () => ({
  engineHomes: await inventory(lite.core.layout.engineHomes),
  games: await inventory(lite.gamesRoot),
  outside: await inventory(outside),
});

it("answers the kept shot's bytes and their type, PNG or JPEG", async () => {
  await keep({ "shot.png": PNG, "shot.json": "{}" });
  assert.deepEqual(await read(cover(GAME)), { mimeType: "image/png", data: PNG.toString("base64") });
  await keep({ "shot.jpg": JPEG });
  assert.deepEqual(await read(cover(GAME)), { mimeType: "image/jpeg", data: JPEG.toString("base64") });
});

it("takes the newer image while a new shot of the other type replaces the old one", async () => {
  const dir = await keep({ "shot.png": PNG, "shot.jpg": JPEG });
  await utimes(path.join(dir, "shot.png"), new Date("2026-01-01"), new Date("2026-01-01"));
  assert.equal((await read(cover(GAME)))?.mimeType, "image/jpeg");
  await utimes(path.join(dir, "shot.jpg"), new Date("2025-01-01"), new Date("2025-01-01"));
  assert.equal((await read(cover(GAME)))?.mimeType, "image/png");
});

it("never reads a file the caller names: the place is the host's", async () => {
  await keep({ "shot.png": PNG });
  const named = await read(cover(GAME, { file: path.join(outside, "secret.png") }));
  assert.equal(named?.data, PNG.toString("base64"), "the kept shot, whatever file was named");
  await keep({});
  for (const file of [path.join(outside, "secret.png"), "../../../secret.png", "shot.json", "sent.json"])
    assert.equal(await read(cover(GAME, { file })), null, `no shot kept, ${file} named`);
});

/** A planted link in the game's cover folder, named `shot.png`, to `target`. */
async function plantShot(target: string): Promise<void> {
  const dir = await keep({});
  await symlink(target, path.join(dir, "shot.png"));
}

/** Each hostile read: what is arranged first, and what is asked. Every one answers null. */
const HOSTILE: Array<[string, () => Promise<unknown>, () => ProjectAssetRead]> = [
  ["no game", () => keep({ "shot.png": PNG }), () => cover(undefined)],
  ["a number for a game", async () => {}, () => cover(42)],
  ["an empty name", async () => {}, () => cover("")],
  ["a parent step", async () => {}, () => cover("..")],
  ["a traversal to another game", async () => {}, () => cover("../covers/other-game")],
  ["a nested name", async () => {}, () => cover(`${GAME}/../other-game`)],
  ["an absolute path", async () => {}, () => cover(path.join(outside, "planted"))],
  ["a space", async () => {}, () => cover("harbor run")],
  ["a NUL byte", async () => {}, () => cover(`${GAME}\u0000`)],
  ["a game folder that is a link", async () => {}, () => cover("linked-dir")],
  ["no shot kept", () => keep({ "shot.json": "{}", "sent.json": "{}" }), () => cover(GAME)],
  [
    "only other files: a send's copy, another type, a sibling",
    () => keep({ ".send-1.png": PNG, "shot.webp": PNG, "cover.png": PNG, "shot.png.bak": PNG }),
    () => cover(GAME),
  ],
  ["a shot that is a link out", () => plantShot(path.join(outside, "secret.png")), () => cover(GAME)],
  ["a shot that is a link to a folder", () => plantShot(path.join(outside, "planted")), () => cover(GAME)],
  ["a shot that is a folder", async () => mkdir(path.join(await keep({}), "shot.png")), () => cover(GAME)],
  // A read that opened it would wait for a writer forever: refused before it is opened.
  [
    "a shot that is a named pipe",
    async () => void execFileSync("mkfifo", [path.join(await keep({}), "shot.png")]),
    () => cover(GAME),
  ],
  [
    "a shot over the size cap",
    () => keep({ "shot.png": Buffer.concat([PNG, Buffer.alloc(GENEX_COVER_MAX_BYTES)]) }),
    () => cover(GAME),
  ],
  ["a shot that is not a picture", () => keep({ "shot.png": "not a picture at all" }), () => cover(GAME)],
  ["an empty shot", () => keep({ "shot.png": "" }), () => cover(GAME)],
  ["a PNG named .jpg", () => keep({ "shot.jpg": PNG }), () => cover(GAME)],
  ["a JPEG named .png", () => keep({ "shot.png": JPEG }), () => cover(GAME)],
  ["a GIF named .png", () => keep({ "shot.png": GIF }), () => cover(GAME)],
];

it("answers null and changes nothing for hostile games, places and files", async () => {
  // Another game's folder and a game folder that is a link out, both holding good shots.
  await keep({ "shot.png": PNG }, "other-game");
  await symlink(path.join(outside, "planted"), path.join(covers, "linked-dir"));
  for (const [name, arrange, request] of HOSTILE) {
    await arrange();
    const before = await everything();
    assert.equal(await read(request()), null, name);
    assert.deepEqual(await everything(), before, `${name}: nothing touched`);
  }
});

it("answers null for Genex storage or its covers folder reached through a link", async () => {
  await keep({ "shot.png": PNG });
  const genex = path.join(lite.core.layout.engineHomes, "genex");
  const moved = path.join(outside, "genex-moved");
  await rename(genex, moved);
  await symlink(moved, genex);
  try {
    assert.equal(await read(cover(GAME)), null, "Genex storage behind a link");
  } finally {
    await rm(genex);
    await rename(moved, genex);
  }
  const coversMoved = path.join(outside, "covers-moved");
  await rename(covers, coversMoved);
  await symlink(coversMoved, covers);
  try {
    assert.equal(await read(cover(GAME)), null, "the covers folder behind a link");
  } finally {
    await rm(covers);
    await rename(coversMoved, covers);
  }
  assert.equal((await read(cover(GAME)))?.mimeType, "image/png", "and read again once it is a folder");
});

it("leaves the game and inspection scopes as they were", async () => {
  await keep({ "shot.png": PNG });
  assert.equal(await read({ project: GAME, file: "assets/none.png" }), null);
  assert.equal(
    await read({ project: GAME, file: "shot.png", scope: ProjectAssetScope.GenexInspection }),
    null,
    "the inspection scope reads only a named job's frame",
  );
});
