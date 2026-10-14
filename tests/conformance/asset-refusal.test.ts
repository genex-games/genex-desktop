/**
 * A delivered file the game's stack cannot load (`src/renderer/chat/asset-refusal.ts`): the host
 * marks it `refused` in `asset.delivered` (`stackAcceptsAsset`), and the chat's asset row says why
 * in words from `ASSET_REFUSAL_WORDS`. Nothing else ever gets a line, a refused file is never a
 * tile or a player, and its row is never behind "Show more assets".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deliveredPage,
  isAudioAsset,
  isRefusedAsset,
  isVisualAsset,
  refusalLine,
} from "../../src/renderer/chat/asset-refusal.ts";
import { ASSET_REFUSAL_WORDS } from "../../src/renderer/words.ts";
import {
  type AssetDeliveredPayload,
  AssetRefusal,
  assetKind,
  stackAcceptsAsset,
} from "../../src/shared/game-assets.ts";
import { GameStack } from "../../src/shared/game-project.ts";

type DeliveredFile = AssetDeliveredPayload["files"][number];

/** The files of one delivery, marked as `#recordDelivery` marks them for a game of `stack`. */
function delivery(stack: GameStack, files: readonly string[]): DeliveredFile[] {
  return files.map((file) => {
    const refused = stackAcceptsAsset(stack, file);
    return { file, bytes: 1, kind: assetKind(file), ...(refused ? { refused } : {}) };
  });
}

const FILES = ["assets/hero.webp", "assets/hero.png", "assets/theme.ogg", "assets/level.glb"];

describe("asset refusal lines", () => {
  it("a refused .webp in a raylib delivery gets the raylib line; its neighbours get none", () => {
    const [webp, ...rest] = delivery(GameStack.RaylibCpp, FILES);
    assert.ok(webp);
    assert.equal(webp.refused, AssetRefusal.UnsupportedByRaylib);
    assert.equal(refusalLine(webp), ASSET_REFUSAL_WORDS[AssetRefusal.UnsupportedByRaylib]("webp"));
    for (const file of rest) assert.equal(refusalLine(file), null, file.file);
  });

  it("a Rust delivery refuses what the Rust runtime cannot load, with the Rust line", () => {
    const files = ["assets/ship.fbx", "assets/theme.xm", "assets/hero.webp", "assets/ship.obj", "assets/voice.opus"];
    const [fbx, xm, ...loadable] = delivery(GameStack.RustWgpu, files);
    assert.ok(fbx && xm);
    assert.equal(fbx.refused, AssetRefusal.UnsupportedByRust);
    assert.equal(refusalLine(fbx), ASSET_REFUSAL_WORDS[AssetRefusal.UnsupportedByRust]("fbx"));
    assert.equal(refusalLine(xm), ASSET_REFUSAL_WORDS[AssetRefusal.UnsupportedByRust]("xm"));
    // WebP loads; OBJ and Opus are converted by the import step, so neither is refused.
    for (const file of loadable) assert.equal(refusalLine(file), null, file.file);
  });

  it("each compiled stack's line names its own stack and the file's extension", () => {
    const raylib = ASSET_REFUSAL_WORDS[AssetRefusal.UnsupportedByRaylib]("webp");
    const rust = ASSET_REFUSAL_WORDS[AssetRefusal.UnsupportedByRust]("fbx");
    assert.notEqual(raylib, rust);
    assert.match(raylib, /\.webp/);
    assert.match(rust, /\.fbx/);
  });

  it("a Three.js delivery of the same files gets no line at all", () => {
    for (const file of delivery(GameStack.ThreeJs, FILES)) assert.equal(refusalLine(file), null, file.file);
  });

  it("the line names the extension as the person reads it, lowercase and without its dot", () => {
    const [shouty] = delivery(GameStack.RaylibCpp, ["assets/Intro.MP4"]);
    assert.ok(shouty);
    assert.equal(refusalLine(shouty), ASSET_REFUSAL_WORDS[AssetRefusal.UnsupportedByRaylib]("mp4"));
  });

  it("a refusal this renderer does not know, or an inherited name, reads as no line and never throws", () => {
    for (const refused of ["no-such-refusal", "__proto__", "constructor", "toString", ""])
      assert.equal(refusalLine({ file: "assets/a.webp", bytes: 1, kind: "image", refused } as DeliveredFile), null);
  });
});

describe("delivered files in the chat", () => {
  const names = (list: readonly DeliveredFile[]) => list.map((file) => file.file);

  it("a refused picture, video or sound is a row, never a tile or a player", () => {
    const [webp, mp4, m4a, png, ogg] = delivery(GameStack.RaylibCpp, [
      "assets/a.webp",
      "assets/b.mp4",
      "assets/c.m4a",
      "assets/d.png",
      "assets/e.ogg",
    ]);
    assert.ok(webp && mp4 && m4a && png && ogg);
    for (const refused of [webp, mp4, m4a]) {
      assert.equal(isRefusedAsset(refused), true, refused.file);
      assert.equal(isVisualAsset(refused), false, refused.file);
      assert.equal(isAudioAsset(refused), false, refused.file);
    }
    assert.equal(isVisualAsset(png), true);
    assert.equal(isAudioAsset(ogg), true);
    assert.equal(isRefusedAsset(png), false);
  });

  it("a refusal shows on the first page however many loadable files came with it", () => {
    const pictures = Array.from({ length: 8 }, (_, n) => `assets/p${n}.png`);
    const page = deliveredPage(delivery(GameStack.RaylibCpp, [...pictures, "assets/hero.webp"]), 6);
    assert.deepEqual(names(page.media), pictures.slice(0, 6));
    assert.deepEqual(names(page.refused), ["assets/hero.webp"]);
    assert.equal(page.more, true, "the other two pictures wait for Show more");
  });

  it("every refused file keeps its row; only loadable media is paged", () => {
    const refused = ["assets/a.webp", "assets/b.mp4", "assets/c.svg"];
    const page = deliveredPage(delivery(GameStack.RaylibCpp, [...refused, "assets/d.png"]), 1);
    assert.deepEqual(names(page.media), ["assets/d.png"]);
    assert.deepEqual(names(page.refused), refused);
    assert.equal(page.more, false);
  });

  it("media comes pictures first, then sounds; buffers beside them get no row of their own", () => {
    const page = deliveredPage(
      delivery(GameStack.ThreeJs, ["assets/theme.ogg", "assets/level.bin", "assets/level.glb", "assets/hero.webp"]),
      6,
    );
    assert.deepEqual(names(page.media), ["assets/level.glb", "assets/hero.webp", "assets/theme.ogg"]);
    assert.deepEqual(page.refused, [], "a Three.js game loads every one of them");
  });

  it("a delivery of buffers alone still lists them, and one of refused files alone lists only refusals", () => {
    assert.deepEqual(names(deliveredPage(delivery(GameStack.RaylibCpp, ["assets/level.bin"]), 6).media), [
      "assets/level.bin",
    ]);
    const onlyRefused = deliveredPage(delivery(GameStack.RaylibCpp, ["assets/a.webp", "assets/b.mov"]), 6);
    assert.deepEqual(onlyRefused.media, []);
    assert.deepEqual(names(onlyRefused.refused), ["assets/a.webp", "assets/b.mov"]);
  });
});
