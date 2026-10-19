/**
 * GLB-embedded images to per-family KTX2 sidecars (game systems C-13). Each embedded PNG or JPEG a
 * material samples is encoded once per usage its slots give it, written beside the GLB as
 * `<model>.t<image>[.<usage>].<family>.ktx2`, and named in `asset.extras.genex_textures`; the
 * embedded image stays as the fallback. The schema rows run everywhere; the encoding rows where
 * `node scripts/toolchains/importer-tools.ts fetch` has put the Basis encoder in `.studio-dev/tools/`.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { encode as encodePng } from "fast-png";
import { importWithCache, openAssetCache } from "../../src/main/asset-cache.ts";
import {
  type ImportSandbox,
  importRustAssets,
  importStagedAssets,
  type RustAssetImportDeps,
} from "../../src/main/rust-assets.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import {
  BASIS_ENCODER,
  type BasisEncoderModule,
  TextureUsage,
} from "../../src/substrate/asset-import/basis-encoder.ts";
import { BinWriter, type GltfJson, readGlb, writeGlb } from "../../src/substrate/asset-import/glb.ts";
import {
  addGlbTextures,
  GLB_TEXTURES_EXTRAS_KEY,
  GLB_TEXTURES_SCHEMA_VERSION,
  type GlbImageSkipped,
  GlbImageSkip,
  GlbTexturesSkip,
  glbTextureFamilyOf,
  glbTextureFileName,
  isGlbTextureStem,
  isGlbTextureStemOf,
  parseGlbTextures,
} from "../../src/substrate/asset-import/glb-textures.ts";
import { IMPORT_JOB_VERSION, parseImportReceipt } from "../../src/substrate/asset-import/job.ts";
import { ImportConverter } from "../../src/substrate/asset-import/import-plan.ts";
import { readKtx2Header } from "../../src/substrate/asset-import/ktx2.ts";
import { KTX2_VK_FORMAT, TextureCompression } from "../../src/substrate/asset-import/texture-table.ts";
import { validateGltf } from "../../src/substrate/asset-import/validate.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const ENCODER_DIR = path.join(REPO, ".studio-dev", "tools", `basis-encoder-${BASIS_ENCODER.version}`);
const FETCHED = BASIS_ENCODER.files.every((file) => existsSync(path.join(ENCODER_DIR, file.name)));
const SKIP_UNFETCHED = FETCHED ? false : "the Basis encoder is not fetched (importer-tools.ts fetch)";
const ENCODE_ROW_MS = 2 * MINUTE_MS;
const SIDE = 32;
const ALL_FAMILIES = [
  TextureCompression.Bc,
  TextureCompression.Astc,
  TextureCompression.Etc2,
  TextureCompression.Rgba8,
];
const DESKTOP_FAMILIES = [TextureCompression.Bc, TextureCompression.Rgba8];

/** A `side` x `side` PNG: a checker whose colours `seed` shifts, so two seeds give two images. */
function checker(seed: number, side = SIDE): Uint8Array {
  const data = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const check = ((x >> 2) + (y >> 2)) & 1;
      data.set([check ? 200 : (seed * 40) & 255, (x * 8 + seed) & 255, check ? 30 : 180, 255], (y * side + x) * 4);
    }
  }
  return encodePng({ width: side, height: side, data, channels: 4, depth: 8 });
}

/** What one test GLB's images are: embedded bytes, or a URI beside it. */
type ImageSpec = { bytes: Uint8Array; mimeType?: string } | { uri: string };

/** A material's texture slots, by texture index (texture i samples image i). */
interface MaterialSpec {
  base?: number;
  normal?: number;
  metallicRoughness?: number;
  occlusion?: number;
  emissive?: number;
}

/** A unit quad, flat on z, with normals, tangents and UVs: enough for the validator to read every slot. */
function quad(bin: BinWriter, accessors: GltfJson[]): GltfJson {
  const add = (values: Float32Array, type: string, extra: GltfJson = {}) => {
    accessors.push({ bufferView: bin.add(values, { target: 34962 }), componentType: 5126, count: 4, type, ...extra });
    return accessors.length - 1;
  };
  const POSITION = add(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), "VEC3", {
    min: [0, 0, 0],
    max: [1, 1, 0],
  });
  const NORMAL = add(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), "VEC3");
  const TANGENT = add(new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]), "VEC4");
  const TEXCOORD_0 = add(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), "VEC2");
  accessors.push({
    bufferView: bin.add(new Uint16Array([0, 1, 2, 0, 2, 3]), { target: 34963 }),
    componentType: 5123,
    count: 6,
    type: "SCALAR",
  });
  return { attributes: { POSITION, NORMAL, TANGENT, TEXCOORD_0 }, indices: accessors.length - 1, material: 0 };
}

function material(spec: MaterialSpec): GltfJson {
  const slot = (texture: number | undefined) => (texture === undefined ? {} : { index: texture });
  const pbr: GltfJson = {};
  if (spec.base !== undefined) pbr.baseColorTexture = slot(spec.base);
  if (spec.metallicRoughness !== undefined) pbr.metallicRoughnessTexture = slot(spec.metallicRoughness);
  return {
    name: "crate",
    pbrMetallicRoughness: pbr,
    ...(spec.normal === undefined ? {} : { normalTexture: slot(spec.normal) }),
    ...(spec.occlusion === undefined ? {} : { occlusionTexture: slot(spec.occlusion) }),
    ...(spec.emissive === undefined ? {} : { emissiveTexture: slot(spec.emissive), emissiveFactor: [1, 1, 1] }),
  };
}

/** A one-quad GLB whose material samples `images` through `slots`; `asset` replaces its asset object. */
function texturedGlb(images: readonly ImageSpec[], slots: MaterialSpec, asset?: unknown): Uint8Array {
  const bin = new BinWriter();
  const accessors: GltfJson[] = [];
  const primitive = quad(bin, accessors);
  const gltfImages = images.map((image) =>
    "uri" in image ? { uri: image.uri } : { bufferView: bin.add(image.bytes), mimeType: image.mimeType ?? "image/png" },
  );
  const data = bin.bytes();
  const json: GltfJson = {
    asset: asset ?? { version: "2.0", generator: "C-13 test" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [primitive] }],
    materials: [material(slots)],
    images: gltfImages,
    samplers: [{}],
    textures: gltfImages.map((_, source) => ({ sampler: 0, source })),
    accessors,
    bufferViews: bin.views,
    buffers: [{ byteLength: data.byteLength }],
  };
  return writeGlb(json, data);
}

/** Poly Haven's wooden_crate layout: a base colour, a normal map, and one ARM image for occlusion and metallic-roughness. */
const crate = () =>
  texturedGlb([{ bytes: checker(1) }, { bytes: checker(2) }, { bytes: checker(3) }], {
    base: 0,
    normal: 1,
    occlusion: 2,
    metallicRoughness: 2,
  });

/** The outcome of an encode that the row expects to have encoded. */
async function encoded(glb: Uint8Array, name: string, families: readonly TextureCompression[]) {
  const outcome = await addGlbTextures(glb, name, families);
  assert.ok(outcome.encoded, `not encoded: ${outcome.encoded ? "" : outcome.reason}`);
  return outcome;
}

describe("GLB image sidecars", { skip: SKIP_UNFETCHED, timeout: ENCODE_ROW_MS }, () => {
  it("a wooden_crate-shaped GLB yields base, normal and ARM sidecars named in valid extras, and still validates", async () => {
    const source = crate();
    const outcome = await encoded(source, "wooden_crate", ALL_FAMILIES);
    assert.deepEqual(outcome.entries, [
      { image: 0, kind: TextureUsage.Color, stem: "wooden_crate.t0" },
      { image: 1, kind: TextureUsage.Normal, stem: "wooden_crate.t1" },
      { image: 2, kind: TextureUsage.Data, stem: "wooden_crate.t2" },
    ]);
    assert.deepEqual(outcome.skipped, []);
    const { json, bin } = readGlb(outcome.bytes);
    assert.deepEqual(parseGlbTextures(json), outcome.entries);
    const asset = json.asset as GltfJson;
    assert.deepEqual(Object.keys(asset.extras as GltfJson), [GLB_TEXTURES_EXTRAS_KEY]);
    assert.equal((asset.extras as Record<string, GltfJson>)[GLB_TEXTURES_EXTRAS_KEY]?.v, GLB_TEXTURES_SCHEMA_VERSION);
    assert.equal(json.extensionsUsed, undefined, "never an extension");
    // The embedded images stay as the fallback: the binary chunk and the image views are untouched.
    assert.deepEqual(bin, readGlb(source).bin);
    assert.deepEqual(json.images, readGlb(source).json.images);
    assert.deepEqual(await validateGltf(outcome.bytes, "glb"), [], "the Khronos validator passes the output");
    assert.deepEqual(
      outcome.sidecars.map(({ stem, texture }) => [stem, texture.usage, texture.side]),
      [
        ["wooden_crate.t0", TextureUsage.Color, SIDE],
        ["wooden_crate.t1", TextureUsage.Normal, SIDE],
        ["wooden_crate.t2", TextureUsage.Data, SIDE],
      ],
    );
    for (const sidecar of outcome.sidecars) {
      assert.deepEqual(
        sidecar.files.map((file) => file.compression),
        ALL_FAMILIES,
      );
      for (const file of sidecar.files) {
        const header = readKtx2Header(file.bytes);
        const space = sidecar.texture.usage === TextureUsage.Color ? "srgb" : "linear";
        assert.equal(header?.vkFormat, KTX2_VK_FORMAT[file.compression][space], `${sidecar.stem} ${file.compression}`);
        assert.deepEqual([header?.width, header?.height, header?.levels], [SIDE, SIDE, Math.log2(SIDE) + 1]);
      }
    }
  });

  it("is deterministic: two imports give the same GLB and the same sidecar bytes", async () => {
    const a = await encoded(crate(), "crate", DESKTOP_FAMILIES);
    const b = await encoded(crate(), "crate", DESKTOP_FAMILIES);
    assert.deepEqual(a.bytes, b.bytes);
    assert.deepEqual(
      a.sidecars.map((sidecar) => sidecar.files),
      b.sidecars.map((sidecar) => sidecar.files),
    );
  });

  it("an image sampled in two usages is encoded once per usage, each with its own stem", async () => {
    const glb = texturedGlb([{ bytes: checker(4) }], { base: 0, occlusion: 0 });
    const outcome = await encoded(glb, "rock", DESKTOP_FAMILIES);
    assert.deepEqual(outcome.entries, [
      { image: 0, kind: TextureUsage.Color, stem: "rock.t0.color" },
      { image: 0, kind: TextureUsage.Data, stem: "rock.t0.data" },
    ]);
    const [color, data] = outcome.sidecars;
    assert.equal(readKtx2Header(color?.files[0]?.bytes ?? new Uint8Array())?.vkFormat, KTX2_VK_FORMAT.bc.srgb);
    assert.equal(readKtx2Header(data?.files[0]?.bytes ?? new Uint8Array())?.vkFormat, KTX2_VK_FORMAT.bc.linear);
  });

  it("two images with the same bytes and usage share the first one's sidecar", async () => {
    const same = checker(5);
    const glb = texturedGlb([{ bytes: same }, { bytes: same }], { base: 0, emissive: 1 });
    const outcome = await encoded(glb, "lamp", DESKTOP_FAMILIES);
    assert.deepEqual(outcome.entries, [
      { image: 0, kind: TextureUsage.Color, stem: "lamp.t0" },
      { image: 1, kind: TextureUsage.Color, stem: "lamp.t0" },
    ]);
    assert.equal(outcome.sidecars.length, 1);
  });

  it("a non-square embedded image is encoded at its square power-of-two class (48 x 20 is 64 in log steps)", async () => {
    const wide = encodePng({
      width: 48,
      height: 20,
      data: new Uint8Array(48 * 20 * 4).fill(90),
      channels: 4,
      depth: 8,
    });
    const outcome = await encoded(texturedGlb([{ bytes: wide }], { base: 0 }), "plank", DESKTOP_FAMILIES);
    assert.deepEqual(outcome.sidecars[0]?.texture, { usage: TextureUsage.Color, width: 48, height: 20, side: 64 });
  });

  it("an image it cannot encode is left out with its reason, and the others still get sidecars", async () => {
    const damaged = checker(6).slice(0, 60);
    const huge = checker(7);
    // The IHDR claims 65536 x 65536: refused from the header, before any pixel is allocated.
    new DataView(huge.buffer, huge.byteOffset).setUint32(16, 65536);
    new DataView(huge.buffer, huge.byteOffset).setUint32(20, 65536);
    const webp = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ");
    const glb = texturedGlb(
      [
        { bytes: checker(8) },
        { uri: "beside.png" },
        { bytes: webp, mimeType: "image/webp" },
        { bytes: damaged },
        { bytes: huge },
      ],
      { base: 0, normal: 1, metallicRoughness: 2, occlusion: 3, emissive: 4 },
    );
    const outcome = await encoded(glb, "mixed", DESKTOP_FAMILIES);
    assert.deepEqual(outcome.entries, [{ image: 0, kind: TextureUsage.Color, stem: "mixed.t0" }]);
    const skipped: GlbImageSkipped[] = [
      { image: 1, reason: GlbImageSkip.NotEmbedded },
      { image: 2, reason: GlbImageSkip.NotEncodable },
      { image: 3, reason: GlbImageSkip.Malformed },
      { image: 4, reason: GlbImageSkip.TooLarge },
    ];
    assert.deepEqual(outcome.skipped, skipped);
  });

  it("an encoder that fails (or cannot start) leaves every image out, never the model", async () => {
    const broken: BasisEncoderModule = {
      initializeBasis: () => {
        throw new Error("the encoder cannot start");
      },
      BasisEncoder: class {
        constructor() {
          throw new Error("the encoder cannot start");
        }
      } as BasisEncoderModule["BasisEncoder"],
      basis_tex_format: { cUASTC_LDR_4x4: { value: 0 } },
      ldr_image_type: { cPNGImage: { value: 0 }, cJPGImage: { value: 1 } },
    };
    const glb = crate();
    const outcome = await addGlbTextures(glb, "crate", DESKTOP_FAMILIES, broken);
    assert.equal(outcome.encoded, false);
    assert.equal(outcome.bytes, glb);
    assert.deepEqual(
      outcome.skipped.map(({ reason }) => reason),
      [GlbImageSkip.EncodeFailed, GlbImageSkip.EncodeFailed, GlbImageSkip.EncodeFailed],
    );
  });

  it("an image no material samples gets no sidecar", async () => {
    const outcome = await encoded(
      texturedGlb([{ bytes: checker(9) }, { bytes: checker(10) }], { base: 1 }),
      "a",
      DESKTOP_FAMILIES,
    );
    assert.deepEqual(outcome.entries, [{ image: 1, kind: TextureUsage.Color, stem: "a.t1" }]);
  });

  it("keeps an existing asset.extras member beside genex_textures", async () => {
    const glb = texturedGlb(
      [{ bytes: checker(11) }],
      { base: 0 },
      { version: "2.0", extras: { author: "Poly Haven" } },
    );
    const outcome = await encoded(glb, "b", DESKTOP_FAMILIES);
    const extras = (readGlb(outcome.bytes).json.asset as GltfJson).extras as GltfJson;
    assert.deepEqual(Object.keys(extras), ["author", GLB_TEXTURES_EXTRAS_KEY]);
  });
});

describe("GLBs left unchanged", { skip: SKIP_UNFETCHED, timeout: ENCODE_ROW_MS }, () => {
  it("returns the very bytes with the reason, and encodes nothing", async () => {
    const reencoded = (await encoded(crate(), "crate", DESKTOP_FAMILIES)).bytes;
    const rows: Array<[string, Uint8Array, string, GlbTexturesSkip]> = [
      ["no images", texturedGlb([], {}), "crate", GlbTexturesSkip.NoImages],
      ["only a file beside it", texturedGlb([{ uri: "a.png" }], { base: 0 }), "crate", GlbTexturesSkip.NoImages],
      ["imported before", reencoded, "crate", GlbTexturesSkip.AlreadyEncoded],
      [
        "extras a number",
        texturedGlb([{ bytes: checker(12) }], { base: 0 }, { version: "2.0", extras: 3 }),
        "c",
        GlbTexturesSkip.ExtrasNotObject,
      ],
      ["asset an array", texturedGlb([{ bytes: checker(12) }], { base: 0 }, []), "c", GlbTexturesSkip.ExtrasNotObject],
      ["an empty name", crate(), "", GlbTexturesSkip.UnsafeName],
      ["a name with a folder", crate(), "../up", GlbTexturesSkip.UnsafeName],
      ["a hidden name", crate(), ".crate", GlbTexturesSkip.UnsafeName],
    ];
    for (const [label, glb, name, reason] of rows) {
      const outcome = await addGlbTextures(glb, name, DESKTOP_FAMILIES);
      assert.equal(outcome.encoded, false, label);
      assert.equal(outcome.bytes, glb, `${label}: the same bytes`);
      if (!outcome.encoded) assert.equal(outcome.reason, reason, label);
    }
  });
});

describe("reading genex_textures", () => {
  const document = (block: unknown, images = 2): GltfJson => ({
    asset: { version: "2.0", extras: { [GLB_TEXTURES_EXTRAS_KEY]: block } },
    images: Array.from({ length: images }, () => ({ bufferView: 0, mimeType: "image/png" })),
  });
  const row = (image: unknown, kind: unknown, stem: unknown) => ({ image, kind, stem });

  it("takes the rows the writer writes", () => {
    const rows = [row(0, "color", "crate.t0"), row(1, "normal", "crate.t1.normal"), row(1, "data", "crate.t1.data")];
    assert.deepEqual(parseGlbTextures(document({ v: 1, images: rows })), rows);
  });

  it("refuses the whole block for any malformed row, so a reader loads the embedded images", () => {
    const hostile: Array<[string, unknown]> = [
      ["no block", undefined],
      ["block an array", []],
      ["another version", { v: 2, images: [row(0, "color", "a.t0")] }],
      ["version as text", { v: "1", images: [row(0, "color", "a.t0")] }],
      ["images not an array", { v: 1, images: {} }],
      ["image out of range", { v: 1, images: [row(2, "color", "a.t2")] }],
      ["negative image", { v: 1, images: [row(-1, "color", "a.t0")] }],
      ["fractional image", { v: 1, images: [row(0.5, "color", "a.t0")] }],
      ["unknown kind", { v: 1, images: [row(0, "cutout", "a.t0")] }],
      ["stem with a folder", { v: 1, images: [row(0, "color", "../a.t0")] }],
      ["stem with a backslash", { v: 1, images: [row(0, "color", "a\\t0")] }],
      ["hidden stem", { v: 1, images: [row(0, "color", ".a")] }],
      ["empty stem", { v: 1, images: [row(0, "color", "")] }],
      ["NUL in stem", { v: 1, images: [row(0, "color", "a\0")] }],
      ["stem too long", { v: 1, images: [row(0, "color", "a".repeat(201))] }],
      ["image and kind twice", { v: 1, images: [row(0, "color", "a.t0"), row(0, "color", "b.t0")] }],
      ["a row not an object", { v: 1, images: [row(0, "color", "a.t0"), 7] }],
    ];
    for (const [label, block] of hostile) assert.equal(parseGlbTextures(document(block)), null, label);
    assert.equal(parseGlbTextures({ asset: { version: "2.0" } }), null, "no extras");
    assert.equal(parseGlbTextures(null), null, "not a document");
  });

  it("names each sidecar's family file beside its GLB", () => {
    assert.equal(
      glbTextureFileName("assets/models/crate.glb", "crate.t0", TextureCompression.Bc),
      "assets/models/crate.t0.bc.ktx2",
    );
    assert.equal(glbTextureFileName("crate.glb", "crate.t1.data", TextureCompression.Astc), "crate.t1.data.astc.ktx2");
    assert.ok(isGlbTextureStem("wooden crate.t0"));
    for (const stem of ["", ".t0", "a/b", "a\\b", "a\0", "a".repeat(201), 3])
      assert.equal(isGlbTextureStem(stem), false, String(stem));
  });
});

describe("sidecar names the host accepts from an importer's receipt", () => {
  const entry = (families: unknown) => ({
    version: IMPORT_JOB_VERSION,
    files: [{ index: 3, ok: true, output: "out/3.glb", families }],
  });

  it("reads a GLB's sidecar files, each named for its index, stem order and family", () => {
    const families = [
      { compression: "bc", output: "out/3.s0.bc.ktx2", stem: "crate.t0" },
      { compression: "rgba8", output: "out/3.s0.rgba8.ktx2", stem: "crate.t0" },
      { compression: "bc", output: "out/3.s1.bc.ktx2", stem: "crate.t1" },
    ];
    const line = parseImportReceipt(entry(families))?.files[0];
    assert.ok(line?.ok);
    assert.deepEqual(line.families, families);
  });

  const hostile: Array<[string, unknown]> = [
    ["a stem with a folder", [{ compression: "bc", output: "out/3.s0.bc.ktx2", stem: "../crate.t0" }]],
    ["a hidden stem", [{ compression: "bc", output: "out/3.s0.bc.ktx2", stem: ".t0" }]],
    ["a stem that is not text", [{ compression: "bc", output: "out/3.s0.bc.ktx2", stem: 7 }]],
    ["another stem order", [{ compression: "bc", output: "out/3.s1.bc.ktx2", stem: "crate.t0" }]],
    ["a sidecar named as the file's own family", [{ compression: "bc", output: "out/3.bc.ktx2", stem: "crate.t0" }]],
    [
      "the same stem and family twice",
      [
        { compression: "bc", output: "out/3.s0.bc.ktx2", stem: "crate.t0" },
        { compression: "bc", output: "out/3.s0.bc.ktx2", stem: "crate.t0" },
      ],
    ],
  ];
  for (const [what, families] of hostile) {
    it(`drops a line with ${what}`, () => {
      assert.deepEqual(parseImportReceipt(entry(families))?.files, []);
    });
  }

  it("holds a stem to the GLB it was written for, and reads a sidecar's file name back", () => {
    const rows: Array<[string, unknown, boolean]> = [
      ["assets/crate.glb", "crate.t0", true],
      ["assets/crate.glb", "crate.t12.normal", true],
      ["assets/models/wooden crate.glb", "wooden crate.t3", true],
      ["assets/crate.glb", "crate.t0.cutout", false],
      ["assets/crate.glb", "crate.t01", false],
      ["assets/crate.glb", "crate.tx", false],
      ["assets/crate.glb", "crate.t0.color.data", false],
      ["assets/crate.glb", "ground", false],
      ["assets/crate.glb", "rock.t0", false],
      ["assets/crate.glb", "crate.t0/../x", false],
    ];
    for (const [glb, stem, ok] of rows) assert.equal(isGlbTextureStemOf(glb, stem), ok, `${glb} ${String(stem)}`);
    const file = glbTextureFileName("assets/m/crate.glb", "crate.t1.data", TextureCompression.Etc2);
    assert.deepEqual(glbTextureFamilyOf("assets/m/crate.glb", file), {
      stem: "crate.t1.data",
      compression: TextureCompression.Etc2,
    });
    for (const other of [
      "assets/crate.t1.etc2.ktx2",
      "assets/m/crate.etc2.ktx2",
      "assets/m/crate.t1.pvrtc.ktx2",
      "assets/m/rock.t1.bc.ktx2",
    ])
      assert.equal(glbTextureFamilyOf("assets/m/crate.glb", other), null, other);
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

const SKIP_STAGE = process.platform !== "darwin" ? "the importer's Seatbelt sandbox is macOS's" : SKIP_UNFETCHED;
const CRATE_SIDECARS = ["crate.t0", "crate.t1", "crate.t2"].flatMap((stem) =>
  DESKTOP_FAMILIES.map((family) => `${stem}.${family}.ktx2`),
);

describe("the build lane's import step over a stage with a textured GLB", { skip: SKIP_STAGE }, () => {
  it("writes the GLB's image sidecars beside it, and the staged GLB names them", {
    timeout: ENCODE_ROW_MS,
  }, async () => {
    const parent = await realpath(await tmpDir("rust-glb-textures-stage-"));
    const stage = path.join(parent, "stage");
    await mkdir(path.join(stage, "assets", "models"), { recursive: true });
    await writeFile(path.join(stage, "genex.toml"), '[game]\ntitle = "Game"\n');
    await writeFile(path.join(stage, "assets", "models", "crate.glb"), crate());
    const deps = { jobsRoot: path.join(parent, "jobs"), sandboxFor: importerSandboxes(), secretPaths: [] };
    const report = await importStagedAssets(deps, { stage, target: BuildTarget.Mac });
    assert.deepEqual(
      (await readdir(path.join(stage, "assets", "models"))).sort(),
      ["crate.glb", ...CRATE_SIDECARS].sort(),
    );
    const row = report?.files.find((file) => file.file === "assets/models/crate.glb");
    assert.equal(row?.converter, ImportConverter.GltfDecompress);
    assert.equal(row?.refusal, undefined);
    assert.deepEqual(
      row?.families?.map((family) => family.file),
      CRATE_SIDECARS.map((name) => `assets/models/${name}`),
    );
    const staged = new Uint8Array(await readFile(path.join(stage, "assets", "models", "crate.glb")));
    assert.deepEqual(
      parseGlbTextures(readGlb(staged).json)?.map(({ stem }) => stem),
      ["crate.t0", "crate.t1", "crate.t2"],
    );
    assert.deepEqual(await validateGltf(staged, "glb"), []);
    for (const name of CRATE_SIDECARS) {
      const header = readKtx2Header(new Uint8Array(await readFile(path.join(stage, "assets", "models", name))));
      const family = name.split(".").at(-2) as TextureCompression;
      const space = name.startsWith("crate.t0.") ? "srgb" : "linear";
      assert.equal(header?.vkFormat, KTX2_VK_FORMAT[family][space], name);
    }
  });
});

describe("the import cache serves a GLB's sidecars (C-3)", { skip: SKIP_STAGE }, () => {
  it("an unchanged GLB runs no job the second time and places the same sidecars", {
    timeout: ENCODE_ROW_MS,
  }, async () => {
    const parent = await realpath(await tmpDir("rust-glb-textures-cache-"));
    const game = path.join(parent, "game");
    await mkdir(path.join(game, "assets"), { recursive: true });
    await writeFile(path.join(game, "assets", "crate.glb"), crate());
    const cache = openAssetCache({ root: path.join(parent, "cache") });
    const deps = { jobsRoot: path.join(parent, "jobs"), sandboxFor: importerSandboxes(), secretPaths: [] };
    let jobs = 0;
    const run: typeof importRustAssets = async (d, r) => {
      jobs += 1;
      return await importRustAssets(d, r);
    };
    const request = {
      gameRoot: game,
      stack: GameStack.RustWgpu,
      files: ["assets/crate.glb"],
      targets: [BuildTarget.Mac],
      tools: { basisu: BASIS_ENCODER.files[1].sha256 },
    };
    const first = await importWithCache(cache, deps, request, run);
    first.release();
    const second = await importWithCache(cache, deps, request, run);
    second.release();
    assert.deepEqual([first.misses, second.misses, second.hits, jobs], [1, 0, 1, 1]);
    const facts = (result: typeof first) => result.files[0]?.families?.map(({ file, sha256 }) => [file, sha256]);
    assert.deepEqual(facts(second), facts(first));
    assert.deepEqual(
      facts(first)?.map(([file]) => file),
      CRATE_SIDECARS.map((name) => `assets/${name}`),
    );
  });
});
