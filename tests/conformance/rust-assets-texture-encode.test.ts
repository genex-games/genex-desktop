/**
 * The loose-texture encode step (game systems C-12): a PNG or JPEG whose usage resolved (a
 * `[[texture]]` row, a material slot) is encoded once to UASTC by the pinned Basis Universal v2.50
 * encoder and written as one fixed-format KTX2 per texture family its destinations may pick, beside
 * the source, which stays as the fallback. A non-square or non-power-of-two image is resampled into
 * its square power-of-two class first (box filter down, Mitchell up), and the receipt records the
 * class with the issue `resampled`. The resample rows run everywhere; the encoding rows where
 * `node scripts/toolchains/importer-tools.ts fetch` has put the encoder in `.studio-dev/tools/`;
 * the stage rows on macOS (the importer's Seatbelt sandbox).
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import { importWithCache, openAssetCache } from "../../src/main/asset-cache.ts";
import {
  type ImportSandbox,
  importRustAssets,
  importStagedAssets,
  type RustAssetImportDeps,
} from "../../src/main/rust-assets.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { ImportIssueCode, TextureUsageSource } from "../../src/shared/asset-db.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import { BASIS_ENCODER, TextureUsage } from "../../src/substrate/asset-import/basis-encoder.ts";
import { convertAsset } from "../../src/substrate/asset-import/convert.ts";
import {
  AssetImportRefusal,
  ImportAction,
  ImportConverter,
  planImport,
} from "../../src/substrate/asset-import/import-plan.ts";
import { readKtx2Header } from "../../src/substrate/asset-import/ktx2.ts";
import {
  type RgbaImage,
  resampleSquare,
  TEXTURE_SIDE_MAX,
  textureSideClass,
} from "../../src/substrate/asset-import/resample.ts";
import {
  decodeImage,
  encodedTextureIssues,
  parseEncodedTexture,
  stageTextureUsages,
  TEXTURE_SOURCE_PIXELS_MAX,
  TextureDecodeError,
  textureLockFacts,
} from "../../src/substrate/asset-import/texture-encode.ts";
import { KTX2_VK_FORMAT, TextureCompression } from "../../src/substrate/asset-import/texture-table.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const ENCODER_DIR = path.join(REPO, ".studio-dev", "tools", `basis-encoder-${BASIS_ENCODER.version}`);
const FETCHED = BASIS_ENCODER.files.every((file) => existsSync(path.join(ENCODER_DIR, file.name)));
const SKIP_UNFETCHED = FETCHED ? false : "the Basis encoder is not fetched (importer-tools.ts fetch)";
const SKIP_STAGE = process.platform !== "darwin" ? "the importer's Seatbelt sandbox is macOS's" : SKIP_UNFETCHED;
const ENCODE_ROW_MS = 2 * MINUTE_MS;
const ALL_FAMILIES = [
  TextureCompression.Bc,
  TextureCompression.Astc,
  TextureCompression.Etc2,
  TextureCompression.Rgba8,
];

/** A `width` x `height` RGBA image: a checker over two gradients, alpha falling left to right. */
function pattern(width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const check = ((x >> 3) + (y >> 3)) & 1;
      data.set(
        [check ? 230 : (x * 4) & 255, (y * 4) & 255, check ? 40 : 200, 255 - ((x * 2) & 255)],
        (y * width + x) * 4,
      );
    }
  }
  return { width, height, data };
}

const png = (width: number, height: number) =>
  encodePng({ width, height, data: pattern(width, height).data, channels: 4, depth: 8 });
const jpg = (width: number, height: number) =>
  new Uint8Array(jpeg.encode({ width, height, data: pattern(width, height).data }, 90).data);

/** One colour everywhere. */
function flat(width: number, height: number, rgba: readonly number[]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let at = 0; at < data.length; at += 4) data.set(rgba, at);
  return { width, height, data };
}

describe("the square power-of-two size class", () => {
  it("is the nearest power of two of the longer side, in log steps, capped at TEXTURE_SIDE_MAX", () => {
    const table: Array<[number, number, number]> = [
      [1000, 600, 1024],
      [600, 1000, 1024],
      [1024, 1024, 1024],
      [1024, 512, 1024],
      [700, 700, 512],
      [730, 100, 1024],
      [1, 1, 1],
      [3, 2, 4],
      [5000, 5000, TEXTURE_SIDE_MAX],
      [8192, 8192, TEXTURE_SIDE_MAX],
    ];
    for (const [width, height, side] of table)
      assert.equal(textureSideClass(width, height), side, `${width}x${height}`);
  });
});

describe("resampling into the size class", () => {
  it("a flat image stays flat in every usage, up and down", () => {
    for (const usage of Object.values(TextureUsage)) {
      for (const [width, height, side] of [
        [1000, 600, 1024],
        [96, 40, 64],
      ] as const) {
        const out = resampleSquare(flat(width, height, [10, 128, 250, 77]), side, usage);
        assert.deepEqual([out.width, out.height, out.data.length], [side, side, side * side * 4]);
        const normal = usage === TextureUsage.Normal;
        for (let at = 0; at < out.data.length; at += 4) {
          // A normal map's texels are unit vectors after the resample; the flat input's is not, so only alpha holds.
          if (!normal) assert.deepEqual([...out.data.subarray(at, at + 3)], [10, 128, 250], `${usage} ${at}`);
          assert.equal(out.data[at + 3], 77);
        }
      }
    }
  });

  it("colour is filtered in linear light; data is not", () => {
    // Black and white columns averaged two to one: linear light gives sRGB 188, a plain mean 128.
    const stripes: RgbaImage = { width: 4, height: 2, data: new Uint8Array(4 * 2 * 4) };
    for (let x = 0; x < 4; x++)
      for (let y = 0; y < 2; y++) stripes.data.set(x % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * 4 + x) * 4);
    const color = resampleSquare(stripes, 2, TextureUsage.Color);
    const data = resampleSquare(stripes, 2, TextureUsage.Data);
    assert.equal(color.data[0], 188);
    assert.equal(data.data[0], 128);
  });

  it("normal maps come out as unit vectors", () => {
    const tilted = flat(6, 6, [200, 150, 230, 255]);
    const out = resampleSquare(tilted, 8, TextureUsage.Normal);
    for (let at = 0; at < out.data.length; at += 4) {
      const [x, y, z] = [0, 1, 2].map((c) => ((out.data[at + c] ?? 0) / 255) * 2 - 1) as [number, number, number];
      assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 0.02, `texel ${at / 4}: ${Math.hypot(x, y, z)}`);
    }
  });

  it("is byte-stable, and a square power-of-two image of its own class comes back unchanged", () => {
    const source = pattern(1000, 600);
    const a = resampleSquare(source, 1024, TextureUsage.Color);
    const b = resampleSquare(source, 1024, TextureUsage.Color);
    assert.deepEqual(a.data, b.data);
    const square = pattern(64, 64);
    assert.deepEqual(resampleSquare(square, 64, TextureUsage.Color).data, square.data);
  });
});

describe("decoding a loose texture", () => {
  it("a PNG and a JPEG decode to RGBA8 at their own size", async () => {
    const fromPng = await decodeImage(png(40, 24));
    assert.deepEqual([fromPng.width, fromPng.height, fromPng.data.length], [40, 24, 40 * 24 * 4]);
    assert.deepEqual(fromPng.data, pattern(40, 24).data);
    const fromJpg = await decodeImage(jpg(40, 24));
    assert.deepEqual([fromJpg.width, fromJpg.height, fromJpg.data.length], [40, 24, 40 * 24 * 4]);
  });

  it("grey, grey-alpha, RGB, 16-bit and palette PNGs all decode to RGBA8", async () => {
    const grey = encodePng({ width: 2, height: 1, data: new Uint8Array([0, 255]), channels: 1, depth: 8 });
    assert.deepEqual([...(await decodeImage(grey)).data], [0, 0, 0, 255, 255, 255, 255, 255]);
    const greyAlpha = encodePng({ width: 1, height: 1, data: new Uint8Array([90, 30]), channels: 2, depth: 8 });
    assert.deepEqual([...(await decodeImage(greyAlpha)).data], [90, 90, 90, 30]);
    const rgb = encodePng({ width: 1, height: 1, data: new Uint8Array([1, 2, 3]), channels: 3, depth: 8 });
    assert.deepEqual([...(await decodeImage(rgb)).data], [1, 2, 3, 255]);
    const deep = encodePng({
      width: 1,
      height: 1,
      data: new Uint16Array([0xffff, 0x8000, 0, 0xffff]),
      channels: 4,
      depth: 16,
    });
    assert.deepEqual([...(await decodeImage(deep)).data], [255, 128, 0, 255]);
    const indexed = encodePng({
      width: 2,
      height: 1,
      data: new Uint8Array([1, 0]),
      channels: 1,
      depth: 8,
      palette: [
        [9, 8, 7],
        [200, 100, 50],
      ],
    });
    assert.deepEqual([...(await decodeImage(indexed)).data], [200, 100, 50, 255, 9, 8, 7, 255]);
  });

  it("refuses what is not a whole PNG or JPEG, and a source over the pixel cap before decoding it", async () => {
    const hostile: Array<[string, Uint8Array]> = [
      ["empty", new Uint8Array(0)],
      ["text", new TextEncoder().encode("not an image")],
      ["truncated PNG", png(16, 16).slice(0, 40)],
      ["truncated JPEG", jpg(16, 16).slice(0, 30)],
      ["WebP", new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")],
    ];
    for (const [name, bytes] of hostile)
      await assert.rejects(
        decodeImage(bytes),
        (e: unknown) => e instanceof TextureDecodeError && e.refusal === AssetImportRefusal.Malformed,
        name,
      );
    // A PNG header claiming 65536 x 65536: refused too-large from the header, no pixel allocated.
    const huge = png(1, 1);
    const view = new DataView(huge.buffer, huge.byteOffset);
    view.setUint32(16, 65536);
    view.setUint32(20, 65536);
    assert.ok(65536 * 65536 > TEXTURE_SOURCE_PIXELS_MAX);
    const tooLarge = (e: unknown) => e instanceof TextureDecodeError && e.refusal === AssetImportRefusal.TooLarge;
    await assert.rejects(decodeImage(huge), tooLarge);
    // A JPEG whose frame header claims 65535 x 65535: the same, from the start-of-frame segment.
    const wide = jpg(16, 16);
    const sof = wide.findIndex((byte, at) => byte === 0xff && wide[at + 1] === 0xc0);
    new DataView(wide.buffer, wide.byteOffset).setUint16(sof + 5, 0xffff);
    new DataView(wide.buffer, wide.byteOffset).setUint16(sof + 7, 0xffff);
    await assert.rejects(decodeImage(wide), tooLarge);
  });
});

describe("planning a loose texture", () => {
  it("a Rust game's PNG or JPEG with a resolved usage runs texture-encode; without one it is kept", () => {
    for (const file of ["assets/ground.jpg", "assets/ground.jpeg", "assets/t/flow.png"]) {
      assert.deepEqual(planImport(GameStack.RustWgpu, file, TextureUsage.Color), {
        action: ImportAction.Normalize,
        converter: ImportConverter.TextureEncode,
        output: file.slice(file.lastIndexOf(".") + 1),
      });
      assert.deepEqual(planImport(GameStack.RustWgpu, file), { action: ImportAction.Keep });
      assert.deepEqual(planImport(GameStack.RustWgpu, file, null), { action: ImportAction.Keep });
    }
  });

  it("a WebP (no decoder in the importer) and another stack's texture are kept whatever the usage", () => {
    assert.deepEqual(planImport(GameStack.RustWgpu, "assets/a.webp", TextureUsage.Data), { action: ImportAction.Keep });
    assert.deepEqual(planImport(GameStack.RaylibCpp, "assets/a.png", TextureUsage.Color), {
      action: ImportAction.Keep,
    });
    // A usage never turns a model into a texture.
    assert.equal(
      planImport(GameStack.RustWgpu, "assets/a.obj", TextureUsage.Color).converter,
      ImportConverter.ObjToGlb,
    );
  });
});

describe("the receipt's texture record", () => {
  it("records the class; a resampled one carries the issue, and the lock facts add it to the usage's", () => {
    const resampled = { usage: TextureUsage.Color, width: 1000, height: 600, side: 1024 };
    assert.deepEqual(parseEncodedTexture(resampled), resampled);
    assert.deepEqual(encodedTextureIssues(resampled), [{ code: ImportIssueCode.Resampled, detail: "1000x600" }]);
    assert.deepEqual(encodedTextureIssues({ ...resampled, width: 1024, height: 1024 }), []);
    const facts = textureLockFacts(
      { path: "assets/ground.png", usage: TextureUsage.Color, source: TextureUsageSource.Toml, issues: [] },
      resampled,
    );
    assert.deepEqual(facts, {
      settings: { usage: TextureUsage.Color, usageSource: TextureUsageSource.Toml },
      issues: [{ code: ImportIssueCode.Resampled, detail: "1000x600" }],
    });
  });

  it("a record that is not one is refused", () => {
    const good = { usage: TextureUsage.Data, width: 64, height: 64, side: 64 };
    const hostile: unknown[] = [
      null,
      [],
      "color",
      { ...good, usage: "albedo" },
      { ...good, side: 48 },
      { ...good, side: TEXTURE_SIDE_MAX * 2 },
      { ...good, width: 0 },
      { ...good, height: -1 },
      { ...good, width: 1.5 },
    ];
    for (const value of hostile) assert.equal(parseEncodedTexture(value), null, JSON.stringify(value));
  });
});

describe("resolving the stage's texture usages", () => {
  it("[[texture]] rows and a glTF's material slots decide; a name never does", async () => {
    const root = await realpath(await tmpDir("texture-usages-"));
    await mkdir(path.join(root, "assets", "maps"), { recursive: true });
    await writeFile(
      path.join(root, "genex.toml"),
      '[game]\ntitle = "Game"\n\n[[texture]]\npath = "ground.jpg"\nusage = "color"\n\n[[texture]]\npath = "maps/flow.png"\nusage = "data"\n',
    );
    const gltf = {
      asset: { version: "2.0" },
      images: [{ uri: "maps/wall-normal.png" }, { uri: "maps/wall.png" }, { uri: "../../escape.png" }],
      textures: [{ source: 0 }, { source: 1 }, { source: 2 }],
      materials: [
        {
          normalTexture: { index: 0 },
          pbrMetallicRoughness: { baseColorTexture: { index: 1 } },
          occlusionTexture: { index: 2 },
        },
      ],
    };
    await writeFile(path.join(root, "assets", "wall.gltf"), JSON.stringify(gltf));
    const files = [
      "assets/ground.jpg",
      "assets/maps/flow.png",
      "assets/maps/wall-normal.png",
      "assets/maps/wall.png",
      "assets/rock_normal.png",
      "assets/wall.gltf",
    ];
    const resolved = await stageTextureUsages(root, files);
    const usage = Object.fromEntries(resolved.map((row) => [row.path, [row.usage, row.source]]));
    assert.deepEqual(usage, {
      "assets/ground.jpg": [TextureUsage.Color, TextureUsageSource.Toml],
      "assets/maps/flow.png": [TextureUsage.Data, TextureUsageSource.Toml],
      "assets/maps/wall-normal.png": [TextureUsage.Normal, TextureUsageSource.MaterialSlot],
      "assets/maps/wall.png": [TextureUsage.Color, TextureUsageSource.MaterialSlot],
      "assets/rock_normal.png": [null, null],
    });
  });

  it("a broken genex.toml or model decides nothing and throws nothing", async () => {
    const root = await realpath(await tmpDir("texture-usages-broken-"));
    await mkdir(path.join(root, "assets"), { recursive: true });
    await writeFile(path.join(root, "genex.toml"), "[[texture]]\npath = 3\n");
    await writeFile(path.join(root, "assets", "bad.gltf"), "{ not json");
    await writeFile(path.join(root, "assets", "bad.glb"), "glTF but not really");
    const resolved = await stageTextureUsages(root, ["assets/a.png", "assets/bad.gltf", "assets/bad.glb"]);
    assert.deepEqual(
      resolved.map((row) => [row.path, row.usage]),
      [["assets/a.png", null]],
    );
  });
});

describe("encoding a loose texture in the importer", { skip: SKIP_UNFETCHED }, () => {
  it("a JPEG used as colour becomes sRGB KTX2 per family, the source kept as the fallback", {
    timeout: ENCODE_ROW_MS,
  }, async () => {
    const bytes = jpg(256, 256);
    const result = await convertAsset({
      converter: ImportConverter.TextureEncode,
      ext: "jpg",
      name: "ground",
      bytes,
      targets: [BuildTarget.Web],
      usage: TextureUsage.Color,
    });
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.bytes, bytes, "the source is the step's output, unchanged");
    assert.deepEqual(result.texture, { usage: TextureUsage.Color, width: 256, height: 256, side: 256 });
    assert.deepEqual(
      result.families?.map((family) => family.compression),
      ALL_FAMILIES,
    );
    for (const family of result.families ?? []) {
      const header = readKtx2Header(family.bytes);
      assert.ok(header, family.compression);
      assert.equal(header.vkFormat, KTX2_VK_FORMAT[family.compression].srgb, family.compression);
      assert.deepEqual([header.width, header.height, header.levels, header.supercompression], [256, 256, 9, 0]);
    }
  });

  it("a 1000x600 PNG becomes 1024 per family with the class in the receipt; data maps are linear", {
    timeout: ENCODE_ROW_MS,
  }, async () => {
    const result = await convertAsset({
      converter: ImportConverter.TextureEncode,
      ext: "png",
      name: "wide",
      bytes: png(1000, 600),
      targets: [BuildTarget.Mac],
      usage: TextureUsage.Data,
    });
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.texture, { usage: TextureUsage.Data, width: 1000, height: 600, side: 1024 });
    assert.deepEqual(
      encodedTextureIssues(result.texture ?? { usage: TextureUsage.Data, width: 1, height: 1, side: 1 }),
      [{ code: ImportIssueCode.Resampled, detail: "1000x600" }],
    );
    assert.deepEqual(
      result.families?.map((family) => family.compression),
      [TextureCompression.Bc, TextureCompression.Rgba8],
    );
    for (const family of result.families ?? []) {
      const header = readKtx2Header(family.bytes);
      assert.deepEqual([header?.width, header?.height, header?.levels], [1024, 1024, 11]);
      assert.equal(header?.vkFormat, KTX2_VK_FORMAT[family.compression].linear);
    }
  });

  it("is byte-stable: the same image and usage give the same files twice", { timeout: ENCODE_ROW_MS }, async () => {
    const input = {
      converter: ImportConverter.TextureEncode,
      ext: "png",
      name: "n",
      bytes: png(96, 40),
      targets: [BuildTarget.Ios],
      usage: TextureUsage.Normal,
    } as const;
    const [a, b] = [await convertAsset(input), await convertAsset(input)];
    assert.ok(a.ok && b.ok);
    assert.deepEqual(
      a.families?.map((family) => family.bytes),
      b.families?.map((family) => family.bytes),
    );
    assert.equal(a.families?.length, 3);
  });

  it("refuses an image it cannot read with a typed code, and a step with no usage importer-failed", async () => {
    const base = {
      converter: ImportConverter.TextureEncode,
      ext: "png",
      name: "x",
      targets: [BuildTarget.Mac],
    } as const;
    const broken = await convertAsset({ ...base, bytes: png(8, 8).slice(0, 40), usage: TextureUsage.Color });
    assert.deepEqual(broken.ok ? null : broken.refusal, AssetImportRefusal.Malformed);
    const unplanned = await convertAsset({ ...base, bytes: png(8, 8) });
    assert.deepEqual(unplanned.ok ? null : unplanned.refusal, AssetImportRefusal.ImporterFailed);
  });
});

/** Every sandbox the importer asked for, the real ProcessSandbox underneath. */
function importerSandboxes(): RustAssetImportDeps["sandboxFor"] {
  return async (options): Promise<ImportSandbox> => {
    const sandbox = await ProcessSandbox.create(options);
    return { run: (request) => sandbox.run(request), dispose: () => sandbox.dispose() };
  };
}

after(async () => {
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  await SandboxManager.reset();
});

describe("the build lane's import step over a stage with loose textures", { skip: SKIP_STAGE }, () => {
  it("ground.jpg used as colour ships bc, astc, etc2 and rgba8 KTX2 beside it for the web", {
    timeout: ENCODE_ROW_MS,
  }, async () => {
    const parent = await realpath(await tmpDir("rust-texture-stage-"));
    const stage = path.join(parent, "stage");
    await mkdir(path.join(stage, "assets"), { recursive: true });
    await writeFile(
      path.join(stage, "genex.toml"),
      '[game]\ntitle = "Game"\n\n[[texture]]\npath = "ground.jpg"\nusage = "color"\n',
    );
    await writeFile(path.join(stage, "assets", "ground.jpg"), jpg(256, 256));
    await writeFile(path.join(stage, "assets", "loose.png"), png(32, 32));
    const deps = { jobsRoot: path.join(parent, "jobs"), sandboxFor: importerSandboxes(), secretPaths: [] };
    const report = await importStagedAssets(deps, { stage, target: BuildTarget.Web });
    assert.deepEqual((await readdir(path.join(stage, "assets"))).sort(), [
      "ground.astc.ktx2",
      "ground.bc.ktx2",
      "ground.etc2.ktx2",
      "ground.jpg",
      "ground.rgba8.ktx2",
      "loose.png",
    ]);
    const rows = Object.fromEntries((report?.files ?? []).map((row) => [row.file, row]));
    const ground = rows["assets/ground.jpg"];
    assert.equal(ground?.converter, ImportConverter.TextureEncode);
    assert.equal(ground?.refusal, undefined);
    assert.deepEqual(ground?.texture, { usage: TextureUsage.Color, width: 256, height: 256, side: 256 });
    assert.deepEqual(
      ground?.families?.map((family) => family.file),
      ALL_FAMILIES.map((family) => `assets/ground.${family}.ktx2`),
    );
    for (const family of ALL_FAMILIES) {
      const header = readKtx2Header(
        new Uint8Array(await readFile(path.join(stage, "assets", `ground.${family}.ktx2`))),
      );
      assert.equal(header?.vkFormat, KTX2_VK_FORMAT[family].srgb, family);
    }
    // No row, slot or role names loose.png: it ships as its source, not encoded.
    assert.deepEqual(rows["assets/loose.png"], { file: "assets/loose.png", action: ImportAction.Keep });
  });
});

describe("the import cache serves an encoded texture (C-3)", { skip: SKIP_STAGE }, () => {
  it("an unchanged texture runs no job the second time; a new usage re-encodes it", {
    timeout: ENCODE_ROW_MS,
  }, async () => {
    const parent = await realpath(await tmpDir("rust-texture-cache-"));
    const game = path.join(parent, "game");
    await mkdir(path.join(game, "assets"), { recursive: true });
    await writeFile(path.join(game, "assets", "ground.png"), png(100, 60));
    const cache = openAssetCache({ root: path.join(parent, "cache") });
    const deps = { jobsRoot: path.join(parent, "jobs"), sandboxFor: importerSandboxes(), secretPaths: [] };
    const jobs: string[][] = [];
    const run: typeof importRustAssets = async (d, r) => {
      jobs.push([...r.files]);
      return await importRustAssets(d, r);
    };
    const request = (usage: TextureUsage) => ({
      gameRoot: game,
      stack: GameStack.RustWgpu,
      files: ["assets/ground.png"],
      targets: [BuildTarget.Android],
      usages: new Map([["assets/ground.png", usage]]),
      tools: { basisu: BASIS_ENCODER.files[1].sha256 },
    });
    const first = await importWithCache(cache, deps, request(TextureUsage.Color), run);
    first.release();
    const second = await importWithCache(cache, deps, request(TextureUsage.Color), run);
    second.release();
    assert.deepEqual([first.misses, second.misses, second.hits, jobs.length], [1, 0, 1, 1]);
    const facts = (result: typeof first) =>
      result.files.map(({ texture, families }) => ({
        texture,
        families: families?.map(({ file, sha256 }) => [file, sha256]),
      }));
    assert.deepEqual(facts(second), facts(first));
    assert.deepEqual(first.files[0]?.texture, { usage: TextureUsage.Color, width: 100, height: 60, side: 128 });
    assert.deepEqual(
      first.files[0]?.families?.map((family) => family.file),
      ["assets/ground.astc.ktx2", "assets/ground.etc2.ktx2", "assets/ground.rgba8.ktx2"],
    );
    const normal = await importWithCache(cache, deps, request(TextureUsage.Normal), run);
    normal.release();
    assert.deepEqual([normal.misses, jobs.length], [1, 2]);
    assert.equal(normal.files[0]?.texture?.usage, TextureUsage.Normal);
  });
});
