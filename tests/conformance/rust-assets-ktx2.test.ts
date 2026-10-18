/**
 * Basis Universal textures for the Rust · wgpu runtime (renderer pass 2, A6.5): the import step
 * transcodes a mipmapped, square, power-of-two Basis KTX2 once per texture family its game's
 * destinations may pick, every level, into a KTX2 in that family's fixed GPU format with its
 * levels written plain, so the runtime carries no transcoder (genex-render `read_ktx2` reads
 * these files; its `texture_compressed` rows read the goldens below). A texture that is not one
 * keeps today's level-0 check and is skipped with a typed reason.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { convertAsset } from "../../src/substrate/asset-import/convert.ts";
import { ImportConverter } from "../../src/substrate/asset-import/import-plan.ts";
import { IMPORT_JOB_VERSION, parseImportReceipt } from "../../src/substrate/asset-import/job.ts";
import { Ktx2FamilySkip, readKtx2Header } from "../../src/substrate/asset-import/ktx2.ts";
import { KTX2_VK_FORMAT, TextureCompression, familyFileName } from "../../src/substrate/asset-import/texture-table.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const IMPORT = path.join(FIXTURES, "asset-import");
const fixture = async (name: string) => new Uint8Array(await readFile(path.join(IMPORT, name)));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const check = async (bytes: Uint8Array, targets: BuildTarget[]) => {
  const result = await convertAsset({ converter: ImportConverter.Ktx2Check, ext: "ktx2", name: "t", bytes, targets });
  assert.ok(result.ok, JSON.stringify(result));
  return result;
};

/** A KTX2 file's level index: (offset, length) per level, level 0 first. */
function levelIndex(bytes: Uint8Array): Array<[number, number]> {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const levels = data.getUint32(40, true);
  return Array.from({ length: levels }, (_, level) => [
    Number(data.getBigUint64(80 + level * 24, true)),
    Number(data.getBigUint64(88 + level * 24, true)),
  ]);
}

describe("Basis KTX2 transcoded per family at import", () => {
  for (const source of ["basis-uastc-64.ktx2", "basis-etc1s-64.ktx2"]) {
    it(`${source}: one sRGB KTX2 per family, every level, level 0 the receipt's own transcode`, async () => {
      const result = await check(await fixture(source), Object.values(BuildTarget));
      assert.deepEqual(
        result.families?.map((family) => family.compression),
        Object.values(TextureCompression),
      );
      for (const family of result.families ?? []) {
        const header = readKtx2Header(family.bytes);
        assert.ok(header, family.compression);
        assert.equal(
          header.vkFormat,
          KTX2_VK_FORMAT[family.compression].srgb,
          `${family.compression}: sRGB as its source`,
        );
        assert.deepEqual([header.width, header.height, header.levels, header.supercompression], [64, 64, 7, 0]);
        const index = levelIndex(family.bytes);
        const level0 = index[0] ?? [0, 0];
        assert.equal(level0[1], family.compression === TextureCompression.Rgba8 ? 64 * 64 * 4 : 16 * 16 * 16);
        const rgba8 = family.compression === TextureCompression.Rgba8;
        assert.equal((index[6] ?? [0, 0])[1], rgba8 ? 4 : 16, "1 x 1: one texel, or one whole block");
        const transcoded = result.textures?.find((t) => t.compression === family.compression);
        assert.equal(
          sha(family.bytes.subarray(level0[0], level0[0] + level0[1])),
          transcoded?.sha256,
          "level 0 is the checked transcode",
        );
        const offsets = index.map(([offset]) => offset);
        assert.ok(
          offsets.every((offset, at) => at === 0 || offset < (offsets[at - 1] ?? 0)),
          "smallest level first in the file",
        );
      }
      const again = await check(await fixture(source), Object.values(BuildTarget));
      assert.deepEqual(
        again.families?.map((family) => sha(family.bytes)),
        result.families?.map((family) => sha(family.bytes)),
        "deterministic",
      );
    });
  }

  it("only the families the game's destinations may pick", async () => {
    const mac = await check(await fixture("basis-uastc-64.ktx2"), [BuildTarget.Mac]);
    assert.deepEqual(
      mac.families?.map((family) => family.compression),
      [TextureCompression.Bc, TextureCompression.Rgba8],
    );
    const phones = await check(await fixture("basis-uastc-64.ktx2"), [BuildTarget.Ios, BuildTarget.Android]);
    assert.deepEqual(
      phones.families?.map((family) => family.compression),
      [TextureCompression.Astc, TextureCompression.Etc2, TextureCompression.Rgba8],
    );
  });

  it("the runtime's goldens are this output (genex-render tests/texture_compressed.rs reads them)", async () => {
    const result = await check(await fixture("basis-uastc-64.ktx2"), Object.values(BuildTarget));
    for (const family of result.families ?? []) {
      const golden = await fixture(familyFileName("basis-uastc-64.ktx2", family.compression));
      assert.equal(sha(family.bytes), sha(golden), family.compression);
    }
  });

  it("a texture that is not square and a power of two keeps its level-0 check and is skipped, typed", async () => {
    const sample = new Uint8Array(await readFile(path.join(FIXTURES, "asset-previews", "texture.ktx2")));
    const result = await check(sample, [BuildTarget.Mac]);
    assert.equal(result.families, undefined);
    assert.equal(result.familiesSkipped, Ktx2FamilySkip.NotSquare);
    assert.equal(result.textures?.length, 2, "the level-0 check still runs");
  });

  it("family files are named beside their source", () => {
    assert.equal(familyFileName("assets/rock/albedo.ktx2", TextureCompression.Astc), "assets/rock/albedo.astc.ktx2");
    assert.equal(familyFileName("albedo.KTX2", TextureCompression.Bc), "albedo.bc.ktx2");
  });
});

describe("the receipt's family files, as the host reads them", () => {
  const entry = (families: unknown) => ({
    version: IMPORT_JOB_VERSION,
    files: [{ index: 3, ok: true, output: "out/3.ktx2", families }],
  });
  it("a family file named for its index and family is read", () => {
    const receipt = parseImportReceipt(entry([{ compression: "bc", output: "out/3.bc.ktx2" }]));
    const line = receipt?.files[0];
    assert.ok(line?.ok);
    assert.deepEqual(line.families, [{ compression: TextureCompression.Bc, output: "out/3.bc.ktx2" }]);
  });
  const hostile: Array<[string, unknown]> = [
    ["another index", [{ compression: "bc", output: "out/4.bc.ktx2" }]],
    ["another family", [{ compression: "bc", output: "out/3.astc.ktx2" }]],
    ["outside out/", [{ compression: "bc", output: "../3.bc.ktx2" }]],
    ["an unknown family", [{ compression: "pvrtc", output: "out/3.pvrtc.ktx2" }]],
    [
      "the same family twice",
      [
        { compression: "bc", output: "out/3.bc.ktx2" },
        { compression: "bc", output: "out/3.bc.ktx2" },
      ],
    ],
    ["not a list", { compression: "bc", output: "out/3.bc.ktx2" }],
  ];
  for (const [what, families] of hostile) {
    it(`a receipt line with ${what} is dropped (its file counts as failed)`, () => {
      assert.deepEqual(parseImportReceipt(entry(families))?.files, []);
    });
  }
  it("an unknown skip reason drops the line", () => {
    const receipt = parseImportReceipt({
      version: IMPORT_JOB_VERSION,
      files: [{ index: 3, ok: true, output: "out/3.ktx2", familiesSkipped: "too-pretty" }],
    });
    assert.deepEqual(receipt?.files, []);
  });
});
