/**
 * The thumbnails Studio keeps between sessions: a card's picture is kept under the key the card
 * made it for and read back as the same picture, only a small picture is ever kept, and no key or
 * game name can place a file outside the store.
 */
import assert from "node:assert/strict";
import { readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { keepThumbnail, MAX_THUMBNAIL_BYTES, readThumbnail } from "../../src/main/asset-thumbnails.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A picture's bytes as far as the store looks: the format's signature, then `fill`. */
const png = (fill = 1, bytes = 64): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(bytes, fill)]);
const base64 = (data: Buffer): string => data.toString("base64");

/** Every file under `dir`, by its path from it. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)));
}

/** A store folder with a sibling the store must never touch. */
async function store(): Promise<{ root: string; outside: string }> {
  const outside = await realpath(await tmpDir("asset-thumbnails-"));
  return { root: path.join(outside, "store"), outside };
}

describe("the kept thumbnails", () => {
  it("answer the picture kept under a key, for that game and that key only", async () => {
    const { root } = await store();
    assert.equal(await readThumbnail(root, "keep", "knight"), null, "nothing kept yet");
    assert.equal(await keepThumbnail(root, "keep", "knight", base64(png(7))), true);
    assert.deepEqual(await readThumbnail(root, "keep", "knight"), { mimeType: "image/png", data: base64(png(7)) });
    assert.equal(await readThumbnail(root, "keep", "dragon"), null);
    assert.equal(await readThumbnail(root, "other-game", "knight"), null);
    assert.equal(await keepThumbnail(root, "keep", "knight", base64(png(9))), true);
    assert.deepEqual(await readThumbnail(root, "keep", "knight"), { mimeType: "image/png", data: base64(png(9)) });
  });

  it("keep nothing that is not a small picture", async () => {
    const { root, outside } = await store();
    const refused: unknown[] = [
      "",
      base64(Buffer.from("plain text, long enough to sniff")),
      base64(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")),
      base64(png(1, MAX_THUMBNAIL_BYTES)),
      "not base64 at all !!!",
      null,
      42,
      { data: base64(png()) },
    ];
    for (const data of refused) assert.equal(await keepThumbnail(root, "keep", "k", data as string), false);
    assert.deepEqual(await filesUnder(outside), [], "nothing was written");
  });

  it("place every file inside the store, whatever the game and the key are called", async () => {
    const { root, outside } = await store();
    const hostile = [
      "../escape",
      "..\\escape",
      "/etc/passwd",
      "C:\\Windows\\win.ini",
      "a/b/../../../c",
      "nul",
      "x".repeat(4000),
      "",
    ];
    for (const name of hostile) {
      assert.equal(await keepThumbnail(root, name, name, base64(png(3))), true, `kept under ${name.slice(0, 20)}`);
      assert.deepEqual(await readThumbnail(root, name, name), { mimeType: "image/png", data: base64(png(3)) });
    }
    const written = await filesUnder(outside);
    assert.equal(written.length, hostile.length);
    for (const file of written) assert.match(file, /^store[\\/][0-9a-f]+[\\/][0-9a-f]+$/, file);
    for (const bad of [null, 7, {}] as unknown[]) {
      assert.equal(await keepThumbnail(root, bad as string, "k", base64(png())), false);
      assert.equal(await keepThumbnail(root, "keep", bad as string, base64(png())), false);
      assert.equal(await readThumbnail(root, bad as string, "k"), null);
      assert.equal(await readThumbnail(root, "keep", bad as string), null);
    }
    assert.equal((await filesUnder(outside)).length, hostile.length, "a malformed name writes nothing");
  });

  it("answer nothing for a kept file that is no picture", async () => {
    const { root } = await store();
    await keepThumbnail(root, "keep", "knight", base64(png()));
    const [kept] = await filesUnder(root);
    assert.ok(kept);
    await writeFile(path.join(root, kept), "tampered: not a picture at all");
    assert.equal(await readThumbnail(root, "keep", "knight"), null);
  });

  it("forget a game's oldest pictures past its cap, never the newest", async () => {
    const { root } = await store();
    let clock = 1_700_000_000_000;
    const options = { maxFiles: 3, now: () => (clock += 60_000) };
    for (const key of ["a", "b", "c", "d", "e"]) await keepThumbnail(root, "keep", key, base64(png()), options);
    assert.ok((await filesUnder(root)).length <= 3);
    assert.notEqual(await readThumbnail(root, "keep", "e"), null, "the newest stays");
    assert.equal(await readThumbnail(root, "keep", "a"), null, "the oldest went");
    await keepThumbnail(root, "other-game", "z", base64(png()), options);
    assert.notEqual(await readThumbnail(root, "keep", "e"), null, "another game's pictures do not count");
  });
});

describe("the core's kept thumbnails", () => {
  it("are kept and read for a game of this studio, and refused for anything else", async () => {
    const { core } = await coreLite({ gamesRoot: await realpath(await tmpDir("asset-thumbnails-core-")) });
    await core.games.scaffold("keep", { title: "Keep" });
    assert.equal(await core.keepAssetThumbnail({ project: "keep", key: "knight", data: base64(png(5)) }), true);
    assert.deepEqual(await core.readAssetThumbnail({ project: "keep", key: "knight" }), {
      mimeType: "image/png",
      data: base64(png(5)),
    });
    for (const bad of [null, {}, { project: "keep" }, { project: 7, key: "k" }, { project: "keep", key: 7 }]) {
      await assert.rejects(core.readAssetThumbnail(bad as never), /Project and key are required/);
      await assert.rejects(core.keepAssetThumbnail(bad as never), /Project and key are required/);
    }
    await assert.rejects(core.readAssetThumbnail({ project: "../keep", key: "knight" }));
    await assert.rejects(core.keepAssetThumbnail({ project: "../keep", key: "knight", data: base64(png()) }));
  });
});
