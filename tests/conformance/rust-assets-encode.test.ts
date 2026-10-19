/**
 * Texture encoding at import (renderer pass 2, A6.6): a square, power-of-two PNG or JPEG encoded
 * by the pinned Basis Universal v2.50 encoder into a mipmapped UASTC KTX2 (sRGB for colour, linear
 * for data and normal maps), which the import step then transcodes per family (A6.5). The encoder
 * is a pinned download, never committed: the pin rows run everywhere, the encoding rows where
 * `node scripts/toolchains/importer-tools.ts fetch` has put it in `.studio-dev/tools/`.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import {
  BASIS_ENCODER,
  BasisEncoderError,
  basisEncoder,
  encodeKtx2,
  Ktx2EncodeSkip,
  TextureUsage,
} from "../../src/substrate/asset-import/basis-encoder.ts";
import { readKtx2Header, transcodeKtx2Families } from "../../src/substrate/asset-import/ktx2.ts";
import { TextureCompression } from "../../src/substrate/asset-import/texture-table.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const ENCODER_DIR = path.join(REPO, ".studio-dev", "tools", `basis-encoder-${BASIS_ENCODER.version}`);
const fetched = BASIS_ENCODER.files.every((file) => existsSync(path.join(ENCODER_DIR, file.name)));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A `width` x `height` RGBA PNG: a checker over two gradients, alpha falling left to right. */
function png(width: number, height: number): Uint8Array {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = (table[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array([...new TextEncoder().encode(type), ...data]);
    const out = new Uint8Array(12 + data.byteLength);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.byteLength);
    out.set(body, 4);
    view.setUint32(8 + data.byteLength, crc(body));
    return out;
  };
  const header = new Uint8Array(13);
  new DataView(header.buffer).setUint32(0, width);
  new DataView(header.buffer).setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * (1 + width * 4) + 1 + x * 4;
      const check = ((x >> 3) + (y >> 3)) & 1;
      rows.set([check ? 230 : (x * 4) & 255, (y * 4) & 255, check ? 40 : 200, 255 - ((x * 2) & 255)], at);
    }
  }
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return new Uint8Array([
    ...signature,
    ...chunk("IHDR", header),
    ...chunk("IDAT", new Uint8Array(deflateSync(rows))),
    ...chunk("IEND", new Uint8Array(0)),
  ]);
}

describe("the pinned Basis Universal encoder", () => {
  it("names v2.50's two files by sha256 and size at the release commit", () => {
    assert.equal(BASIS_ENCODER.license, "Apache-2.0");
    assert.match(
      BASIS_ENCODER.source,
      /^https:\/\/raw\.githubusercontent\.com\/BinomialLLC\/basis_universal\/[0-9a-f]{40}\//,
    );
    assert.deepEqual(
      BASIS_ENCODER.files.map((file) => file.name),
      ["basis_encoder.js", "basis_encoder.wasm"],
    );
    for (const file of BASIS_ENCODER.files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
      assert.ok(file.bytes > 0);
    }
  });

  it("a folder whose files are not the pinned bytes is refused before anything runs", async () => {
    const dir = await tmpDir("genex-basis-encoder-");
    const planted = path.join(dir, "planted.txt");
    // A script that would leave a mark if it ran.
    await writeFile(
      path.join(dir, "basis_encoder.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(planted)}, "ran");`,
    );
    await writeFile(path.join(dir, "basis_encoder.wasm"), new Uint8Array([0, 97, 115, 109]));
    await assert.rejects(basisEncoder(dir), BasisEncoderError);
    assert.equal(existsSync(planted), false, "the unpinned script never ran");
    await assert.rejects(basisEncoder(path.join(dir, "missing")), BasisEncoderError);
  });
});

describe("encoding PNG to KTX2 at import", {
  skip: !fetched && "the encoder is not fetched (node scripts/toolchains/importer-tools.ts fetch)",
}, () => {
  it("a square power-of-two colour PNG becomes a mipmapped sRGB UASTC KTX2 the transcoder reads per family", async () => {
    const encoder = await basisEncoder(ENCODER_DIR);
    const result = await encodeKtx2(encoder, png(64, 64), TextureUsage.Color);
    assert.ok("bytes" in result, JSON.stringify(result));
    const header = readKtx2Header(result.bytes);
    assert.ok(header);
    assert.deepEqual([header.vkFormat, header.width, header.height, header.levels, header.srgb], [0, 64, 64, 7, true]);
    const families = await transcodeKtx2Families(result.bytes, Object.values(TextureCompression));
    assert.ok("files" in families, JSON.stringify(families));
    assert.equal(families.files.length, 4);
    const again = await encodeKtx2(encoder, png(64, 64), TextureUsage.Color);
    assert.ok("bytes" in again);
    assert.equal(sha(again.bytes), sha(result.bytes), "deterministic");
  });

  it("data and normal maps are linear", async () => {
    const encoder = await basisEncoder(ENCODER_DIR);
    for (const usage of [TextureUsage.Data, TextureUsage.Normal]) {
      const result = await encodeKtx2(encoder, png(32, 32), usage);
      assert.ok("bytes" in result, usage);
      assert.equal(readKtx2Header(result.bytes)?.srgb, false, usage);
    }
  });

  it("a PNG that is not square and a power of two is skipped, typed, never encoded", async () => {
    const encoder = await basisEncoder(ENCODER_DIR);
    assert.deepEqual(await encodeKtx2(encoder, png(64, 32), TextureUsage.Color), { skipped: Ktx2EncodeSkip.NotSquare });
    assert.deepEqual(await encodeKtx2(encoder, png(48, 48), TextureUsage.Color), { skipped: Ktx2EncodeSkip.NotSquare });
  });

  it("bytes that are not a whole PNG or JPEG are refused, typed", async () => {
    const encoder = await basisEncoder(ENCODER_DIR);
    const whole = png(64, 64);
    for (const bytes of [whole.subarray(0, 60), new TextEncoder().encode("GIF89a not an image"), new Uint8Array(0)]) {
      await assert.rejects(encodeKtx2(encoder, bytes, TextureUsage.Color), BasisEncoderError);
    }
  });
});
