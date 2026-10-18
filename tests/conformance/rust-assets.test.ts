/**
 * The Rust · wgpu import step (M2.7, plan "Game services"): a typed step per file and stack, the
 * per-destination texture table (held equal to `genex-assets`'s by a shared fixture), the Basis
 * Universal golden corpus, the safe-path rule's hostile table, the converters on the shared
 * Suzanne samples, Draco and meshopt decoding, and the importer in its real sandbox: no network,
 * no write outside its job's `out/`, every output admitted by the host.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { type ImportSandbox, importRustAssets, type RustAssetImportDeps } from "../../src/main/rust-assets.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import { convertAsset } from "../../src/substrate/asset-import/convert.ts";
import { GltfComponent, meshToGlb, readGlb, writeGlb } from "../../src/substrate/asset-import/glb.ts";
import { normalizeGltf } from "../../src/substrate/asset-import/gltf-decompress.ts";
import {
  AssetImportRefusal,
  ImportAction,
  ImportConverter,
  isAssetImportRefusal,
  planImport,
} from "../../src/substrate/asset-import/import-plan.ts";
import { Ktx2FamilySkip, transcodeKtx2 } from "../../src/substrate/asset-import/ktx2.ts";
import { objToMesh } from "../../src/substrate/asset-import/obj.ts";
import { isSafeAssetPath, readGameAsset } from "../../src/substrate/asset-import/safe-asset.ts";
import {
  BASIS_TRANSCODE_FORMAT,
  DESTINATION_TEXTURES,
  TEXTURE_COMPRESSION_FEATURE,
  TextureCompression,
  textureCompressionFor,
  texturesForTargets,
} from "../../src/substrate/asset-import/texture-table.ts";
import { ProcessSandbox, type RunResult } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const SAMPLES = path.join(FIXTURES, "asset-previews");
const IMPORT = path.join(FIXTURES, "asset-import");
const sample = async (name: string) => new Uint8Array(await readFile(path.join(SAMPLES, name)));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const ALL_TARGETS = Object.values(BuildTarget);

type Json = Record<string, any>;

describe("import plan: a typed step per file and stack", () => {
  const { Keep, Normalize, Convert, Refuse, Skip } = ImportAction;
  const rows: Array<[GameStack, string, ImportAction, ImportConverter | AssetImportRefusal | null]> = [
    [GameStack.RustWgpu, "assets/ship.fbx", Refuse, AssetImportRefusal.UnsupportedByRust],
    [GameStack.RustWgpu, "assets/theme.xm", Refuse, AssetImportRefusal.UnsupportedByRust],
    [GameStack.RustWgpu, "assets/theme.mod", Refuse, AssetImportRefusal.UnsupportedByRust],
    [GameStack.RustWgpu, "assets/theme.qoa", Refuse, AssetImportRefusal.UnsupportedByRust],
    [GameStack.RustWgpu, "assets/clip.mp4", Refuse, AssetImportRefusal.UnsupportedByRust],
    [GameStack.RustWgpu, "assets/ship.obj", Convert, ImportConverter.ObjToGlb],
    [GameStack.RustWgpu, "assets/ship.stl", Convert, ImportConverter.StlToGlb],
    [GameStack.RustWgpu, "assets/ship.ply", Convert, ImportConverter.PlyToGlb],
    [GameStack.RustWgpu, "assets/voice.opus", Convert, ImportConverter.AudioToOgg],
    [GameStack.RustWgpu, "assets/voice.m4a", Convert, ImportConverter.AudioToOgg],
    [GameStack.RustWgpu, "assets/voice.aac", Convert, ImportConverter.AudioToOgg],
    [GameStack.RustWgpu, "assets/ship.glb", Normalize, ImportConverter.GltfDecompress],
    [GameStack.RustWgpu, "assets/ship.gltf", Normalize, ImportConverter.GltfDecompress],
    [GameStack.RustWgpu, "assets/rock.ktx2", Normalize, ImportConverter.Ktx2Check],
    [GameStack.RustWgpu, "assets/env/sky.hdr", Normalize, ImportConverter.HdrCheck],
    [GameStack.RaylibCpp, "assets/env/sky.hdr", Refuse, AssetImportRefusal.UnsupportedByRaylib],
    [GameStack.RustWgpu, "assets/rock.webp", Keep, null],
    [GameStack.RustWgpu, "assets/theme.flac", Keep, null],
    [GameStack.RustWgpu, "assets/notes.xyz", Skip, null],
    [GameStack.RaylibCpp, "assets/rock.webp", Refuse, AssetImportRefusal.UnsupportedByRaylib],
    [GameStack.RaylibCpp, "assets/ship.fbx", Refuse, AssetImportRefusal.UnsupportedByRaylib],
    [GameStack.RaylibCpp, "assets/ship.obj", Keep, null],
    [GameStack.RaylibCpp, "assets/theme.xm", Keep, null],
    [GameStack.ThreeJs, "assets/ship.fbx", Keep, null],
    [GameStack.ThreeJs, "assets/ship.obj", Keep, null],
  ];
  for (const [stack, file, action, detail] of rows) {
    it(`${stack}: ${file} → ${action}${detail ? ` (${detail})` : ""}`, () => {
      const step = planImport(stack, file);
      assert.equal(step.action, action);
      if (action === Refuse) assert.equal(step.refusal, detail);
      else if (detail) assert.equal(step.converter, detail);
      else assert.equal(step.converter, undefined);
    });
  }
});

describe("per-destination texture table", () => {
  it("is the table genex-assets keeps (the shared fixture)", async () => {
    const shared = JSON.parse(await readFile(path.join(IMPORT, "texture-table.json"), "utf8"));
    assert.deepEqual(shared.destinations, DESTINATION_TEXTURES);
    assert.deepEqual(shared.features, TEXTURE_COMPRESSION_FEATURE);
    assert.deepEqual(shared.basisFormats, BASIS_TRANSCODE_FORMAT);
  });

  it("every destination ends with uncompressed textures, and mobile never starts with BC", () => {
    for (const target of ALL_TARGETS) {
      assert.equal(DESTINATION_TEXTURES[target].at(-1), TextureCompression.Rgba8, target);
      assert.notEqual(
        target === BuildTarget.Ios || target === BuildTarget.Android ? DESTINATION_TEXTURES[target][0] : null,
        TextureCompression.Bc,
      );
    }
  });

  const rows: Array<[BuildTarget, string[], TextureCompression]> = [
    [BuildTarget.Mac, ["texture-compression-bc", "texture-compression-astc"], TextureCompression.Bc],
    [BuildTarget.Windows, [], TextureCompression.Rgba8],
    [BuildTarget.Ios, ["texture-compression-astc", "texture-compression-etc2"], TextureCompression.Astc],
    [BuildTarget.Android, ["texture-compression-etc2"], TextureCompression.Etc2],
    [BuildTarget.Android, [], TextureCompression.Rgba8],
    [BuildTarget.Web, ["texture-compression-bc"], TextureCompression.Bc],
    [BuildTarget.Web, ["texture-compression-astc", "texture-compression-etc2"], TextureCompression.Astc],
  ];
  for (const [target, features, family] of rows) {
    it(`${target} with [${features.join(", ")}] loads ${family}`, () => {
      assert.equal(textureCompressionFor(target, new Set(features)), family);
    });
  }

  it("the import step transcodes every family its destinations may pick, in table order", () => {
    assert.deepEqual(texturesForTargets([BuildTarget.Mac]), [TextureCompression.Bc, TextureCompression.Rgba8]);
    assert.deepEqual(texturesForTargets([BuildTarget.Ios, BuildTarget.Mac]), Object.values(TextureCompression));
  });
});

describe("Basis Universal golden corpus", () => {
  it("texture.ktx2 transcodes to the golden bytes for every family, identically across two runs", async () => {
    const golden = JSON.parse(await readFile(path.join(IMPORT, "basisu-golden.json"), "utf8"));
    const wasm = await readFile(fileURLToPath(import.meta.resolve(`three/${golden.transcoder.file}`)));
    assert.equal(sha(wasm), golden.transcoder.sha256, "the pinned transcoder");
    const bytes = await sample("texture.ktx2");
    assert.equal(sha(bytes), golden.source.sha256);
    const families = Object.values(TextureCompression);
    const first = await transcodeKtx2(bytes, families);
    const second = await transcodeKtx2(bytes, families);
    assert.deepEqual(first, second);
    assert.deepEqual(first, golden.level0);
  });

  it("a damaged KTX2 is refused malformed, and the file is never rewritten", async () => {
    const bytes = await sample("texture.ktx2");
    const damaged = bytes.slice(0, 200);
    const result = await convertAsset({
      converter: ImportConverter.Ktx2Check,
      ext: "ktx2",
      name: "t",
      bytes: damaged,
      targets: [BuildTarget.Mac],
    });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.refusal, AssetImportRefusal.Malformed);
    const kept = await convertAsset({
      converter: ImportConverter.Ktx2Check,
      ext: "ktx2",
      name: "t",
      bytes,
      targets: [BuildTarget.Ios],
    });
    assert.ok(kept.ok);
    assert.equal(sha(kept.bytes), sha(bytes));
    assert.deepEqual(
      kept.textures?.map((t) => t.compression),
      [TextureCompression.Astc, TextureCompression.Etc2, TextureCompression.Rgba8],
    );
  });
});

describe("the asset-path rule", () => {
  const unsafe = [
    "",
    "/etc/passwd",
    "../x.png",
    "assets/../../x.png",
    "assets/./x.png",
    "assets//x.png",
    "a\\b.png",
    "C:/x.png",
    "assets/con.png",
    "assets/NUL",
    "assets/x.png.",
    "assets/x.png ",
    "assets/\u0000.png",
    "assets/é.png",
  ];
  for (const rel of unsafe) {
    it(`refuses ${JSON.stringify(rel)}`, () => assert.equal(isSafeAssetPath(rel), false));
  }
  for (const rel of ["assets/ship.glb", "assets/sub dir/a-b_c.1.png", "x"]) {
    it(`accepts ${JSON.stringify(rel)}`, () => assert.equal(isSafeAssetPath(rel), true));
  }
});

/** A game folder with the shared samples and hostile entries; `outside` is a folder beside it. */
async function makeGame(): Promise<{ root: string; game: string; outside: string }> {
  const root = await realpath(await tmpDir("genex-rust-assets-"));
  const game = path.join(root, "game");
  const outside = path.join(root, "outside");
  await mkdir(path.join(game, "assets", "sub"), { recursive: true });
  await mkdir(outside);
  for (const name of [
    "model.obj",
    "model.mtl",
    "model.stl",
    "model.ply",
    "compressed.glb",
    "texture.ktx2",
    "animated.fbx",
    "sample.xm",
    "tone.wav",
  ]) {
    await copyFile(path.join(SAMPLES, name), path.join(game, "assets", name));
  }
  await writeFile(path.join(outside, "secret.obj"), "v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n");
  await writeFile(path.join(game, "assets", "broken.stl"), "solid broken\nfacet normal 0 0 1\nvertex nope\n");
  await symlink(path.join(outside, "secret.obj"), path.join(game, "assets", "escape.obj"));
  await symlink(outside, path.join(game, "assets", "out-link"));
  await symlink(path.join(game, "assets", "model.obj"), path.join(game, "assets", "inside-link.obj"));
  execFileSync("mkfifo", [path.join(game, "assets", "pipe.obj")]);
  return { root, game, outside };
}

describe("reading a game's file for the importer", {
  skip: process.platform === "win32" && "POSIX links and FIFOs",
}, () => {
  let game: string;
  before(async () => ({ game } = await makeGame()));

  const rows: Array<[string, AssetImportRefusal]> = [
    ["assets/escape.obj", AssetImportRefusal.EscapesGame],
    ["assets/out-link/secret.obj", AssetImportRefusal.EscapesGame],
    ["assets/inside-link.obj", AssetImportRefusal.EscapesGame],
    ["assets/pipe.obj", AssetImportRefusal.NotRegularFile],
    ["assets/sub", AssetImportRefusal.NotRegularFile],
    ["assets/none.obj", AssetImportRefusal.Missing],
    ["../outside/secret.obj", AssetImportRefusal.UnsafePath],
  ];
  for (const [rel, refusal] of rows) {
    it(`${rel} is refused ${refusal}`, async () => {
      const read = await readGameAsset(game, rel, 1024 * 1024);
      assert.equal(read.ok, false);
      assert.equal(!read.ok && read.refusal, refusal);
    });
  }

  it("a file over the cap is refused too-large", async () => {
    const read = await readGameAsset(game, "assets/model.obj", 1024);
    assert.equal(!read.ok && read.refusal, AssetImportRefusal.TooLarge);
  });
});

/** Positions of a GLB's first mesh: vertex and triangle counts and the bounding box. */
function glbShape(bytes: Uint8Array): { vertices: number; triangles: number; min: number[]; max: number[] } {
  const { json } = readGlb(bytes) as { json: Json };
  let vertices = 0;
  let triangles = 0;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const primitive of json.meshes[0].primitives) {
    const position = json.accessors[primitive.attributes.POSITION];
    vertices += position.count;
    triangles += json.accessors[primitive.indices].count / 3;
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c] ?? 0, position.min[c]);
      max[c] = Math.max(max[c] ?? 0, position.max[c]);
    }
  }
  return { vertices, triangles, min, max };
}

describe("converters", () => {
  const convert = async (converter: ImportConverter, name: string, mtl?: string) =>
    convertAsset({
      converter,
      ext: path.extname(name).slice(1),
      name: "model",
      bytes: await sample(name),
      ...(mtl ? { mtl: { text: await readFile(path.join(SAMPLES, mtl), "utf8"), dir: "" } } : {}),
      targets: [BuildTarget.Mac],
    });

  it("OBJ, STL and PLY Suzannes become GLBs of the same 968 triangles in the same Y-up box", async () => {
    const results = await Promise.all([
      convert(ImportConverter.ObjToGlb, "model.obj", "model.mtl"),
      convert(ImportConverter.StlToGlb, "model.stl"),
      convert(ImportConverter.PlyToGlb, "model.ply"),
    ]);
    const shapes = results.map((result) => {
      assert.ok(result.ok, JSON.stringify(result));
      return glbShape(result.bytes);
    });
    for (const shape of shapes) {
      assert.equal(shape.triangles, 968);
      for (let c = 0; c < 3; c++) {
        assert.ok(Math.abs((shape.min[c] ?? 0) - (shapes[0]?.min[c] ?? 0)) < 1e-3, `min ${c}: ${shape.min}`);
        assert.ok(Math.abs((shape.max[c] ?? 0) - (shapes[0]?.max[c] ?? 0)) < 1e-3, `max ${c}: ${shape.max}`);
      }
    }
    // Suzanne's ears are wider than she is tall, and her face looks along +Z: Y is up.
    const [box] = shapes;
    assert.ok(box && (box.max[0] ?? 0) - (box.min[0] ?? 0) > (box.max[1] ?? 0) - (box.min[1] ?? 0));
  });

  it("the OBJ's MTL colour becomes the GLB's material", async () => {
    const result = await convert(ImportConverter.ObjToGlb, "model.obj", "model.mtl");
    assert.ok(result.ok);
    const { json } = readGlb(result.bytes) as { json: Json };
    assert.equal(json.materials.length, 1);
    assert.equal(json.meshes[0].primitives[0].material, 0);
    assert.equal(json.materials[0].pbrMetallicRoughness.baseColorFactor.length, 4);
  });

  it("a conversion is byte-identical across two runs", async () => {
    for (const [converter, name] of [
      [ImportConverter.ObjToGlb, "model.obj"],
      [ImportConverter.StlToGlb, "model.stl"],
      [ImportConverter.PlyToGlb, "model.ply"],
    ] as const) {
      const [a, b] = await Promise.all([convert(converter, name), convert(converter, name)]);
      assert.ok(a.ok && b.ok);
      assert.equal(sha(a.bytes), sha(b.bytes), name);
    }
  });

  const damaged: Array<[ImportConverter, string, string]> = [
    [ImportConverter.ObjToGlb, "obj", "v 0 0 0\nf 1 2 3\n"],
    [ImportConverter.ObjToGlb, "obj", "v 0 0 nan\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"],
    [ImportConverter.ObjToGlb, "obj", "# no faces\nv 0 0 0\n"],
    [ImportConverter.StlToGlb, "stl", "solid x\nfacet normal 0 0 1\nvertex 0 0 0\nendfacet\n"],
    [ImportConverter.StlToGlb, "stl", "not an stl at all"],
    [ImportConverter.PlyToGlb, "ply", "ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n0\n"],
    [
      ImportConverter.PlyToGlb,
      "ply",
      "ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar uint vertex_indices\nend_header\n",
    ],
    [
      ImportConverter.PlyToGlb,
      "ply",
      "ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 9\n",
    ],
    [ImportConverter.GltfDecompress, "glb", "glTF but not really"],
  ];
  for (const [converter, ext, text] of damaged) {
    it(`a damaged .${ext} is refused malformed (${JSON.stringify(text.slice(0, 32))})`, async () => {
      const result = await convertAsset({
        converter,
        ext,
        name: "x",
        bytes: new TextEncoder().encode(text),
        targets: [BuildTarget.Mac],
      });
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.refusal, AssetImportRefusal.Malformed);
    });
  }

  it("Opus and AAC wait for the store's encoder: refused converter-missing, typed", async () => {
    const result = await convertAsset({
      converter: ImportConverter.AudioToOgg,
      ext: "opus",
      name: "voice",
      bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53]),
      targets: [BuildTarget.Mac],
    });
    assert.equal(!result.ok && result.refusal, AssetImportRefusal.ConverterMissing);
  });

  it("texture encoding and GLB image sidecars are declared but not served yet: refused converter-missing, and no plan picks them", async () => {
    for (const converter of [ImportConverter.TextureEncode, ImportConverter.GlbTextures]) {
      const result = await convertAsset({
        converter,
        ext: "png",
        name: "bark",
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        targets: [BuildTarget.Mac],
      });
      assert.equal(!result.ok && result.refusal, AssetImportRefusal.ConverterMissing, converter);
    }
    for (const file of ["assets/bark.png", "assets/bark.jpg", "assets/ship.glb"])
      for (const converter of [ImportConverter.TextureEncode, ImportConverter.GlbTextures])
        assert.notEqual(planImport(GameStack.RustWgpu, file).converter, converter, file);
    assert.equal(AssetImportRefusal.ValidationFailed, "validation-failed");
    assert.equal(isAssetImportRefusal(AssetImportRefusal.ValidationFailed), true);
  });
});

/** A Radiance file's header, then `pixels` (the importer reads the header and the size, not the pixels). */
function radiance(
  resolution: string,
  pixels: Uint8Array = new Uint8Array(0),
  format = "FORMAT=32-bit_rle_rgbe\n",
): Uint8Array {
  const head = new TextEncoder().encode(`#?RADIANCE\n${format}\n${resolution}\n`);
  return Uint8Array.from([...head, ...pixels]);
}

/** A flat (uncompressed) `width × height` map: every texel the same RGBE. */
function flatRadiance(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([128, 64, 32, 129], i);
  return radiance(`-Y ${height} +X ${width}`, pixels);
}

/** The sha256 of the showcase's Poly Haven map (also in THIRD-PARTY-NOTICES.md and the renderer log). */
const SHOWCASE_HDRI_SHA256 = "de7ba9d0b070470dbb70d0144294c8708068df353537b26ab59c394707e84377";

describe("Radiance environment maps (.hdr)", () => {
  const convert = (bytes: Uint8Array, ext = "hdr") =>
    convertAsset({ converter: ImportConverter.HdrCheck, ext, name: "sky", bytes, targets: [BuildTarget.Mac] });

  it("a valid map is kept byte for byte", async () => {
    const bytes = flatRadiance(64, 32);
    const result = await convert(bytes);
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(sha(result.bytes), sha(bytes), "the importer only checks the header");
    assert.deepEqual(result.textures ?? [], []);
  });

  it("a new-style run-length map within the caps is kept", async () => {
    // One 16-wide row: header [2, 2, 0, 16], then four channels of one run of 16 each.
    const row = Uint8Array.from([2, 2, 0, 16, ...[128, 64, 32, 129].flatMap((v) => [128 + 16, v])]);
    const result = await convert(radiance("-Y 1 +X 16", row));
    assert.ok(result.ok, JSON.stringify(result));
  });

  const hostile: Array<[string, Uint8Array]> = [
    ["empty", new Uint8Array(0)],
    ["bad magic", new TextEncoder().encode("P6\n64 32\n255\n")],
    ["a png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])],
    ["0x0", radiance("-Y 0 +X 0")],
    ["zero width", radiance("-Y 32 +X 0")],
    ["wider than 4096", radiance("-Y 1 +X 4097", new Uint8Array(4097 * 4))],
    ["taller than 2048", radiance("-Y 2049 +X 4096", new Uint8Array(64))],
    ["a side past 2^32", radiance("-Y 99999999999999 +X 99999999999999")],
    ["xyze colours", radiance("-Y 1 +X 1", new Uint8Array(4), "FORMAT=32-bit_rle_xyze\n")],
    ["a rotated resolution", radiance("+X 64 -Y 32")],
    ["words for a resolution", radiance("-Y high +X wide")],
    ["no pixels at all", radiance("-Y 32 +X 64")],
    ["a flat map missing its last texel", flatRadiance(64, 32).slice(0, -4)],
    [
      "a header that never ends",
      Uint8Array.from([...new TextEncoder().encode("#?RADIANCE\n"), ...new Uint8Array(8192).fill(0x78)]),
    ],
  ];
  for (const [name, bytes] of hostile) {
    it(`${name} is refused malformed`, async () => {
      const result = await convert(bytes);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? null : result.refusal, AssetImportRefusal.Malformed);
    });
  }

  it("the showcase's CC0 map is the pinned file, is kept, and is listed in the notices", async () => {
    const file = fileURLToPath(
      new URL(
        "../../native/genex-rust/examples/showcase/game/assets/env/kloofendal_43d_clear_puresky_1k.hdr",
        import.meta.url,
      ),
    );
    const bytes = new Uint8Array(await readFile(file));
    assert.equal(bytes.byteLength, 1_184_531, "Poly Haven's published size");
    assert.equal(sha(bytes), SHOWCASE_HDRI_SHA256);
    const result = await convert(bytes);
    assert.ok(result.ok, JSON.stringify(result));
    const notices = await readFile(fileURLToPath(new URL("../../THIRD-PARTY-NOTICES.md", import.meta.url)), "utf8");
    for (const fact of [SHOWCASE_HDRI_SHA256, "kloofendal_43d_clear_puresky_1k.hdr", "CC0", "Poly Haven"]) {
      assert.ok(notices.includes(fact), `THIRD-PARTY-NOTICES.md names ${fact}`);
    }
  });
});

describe("glTF the runtime can read", () => {
  it("a Draco GLB is written back plain: no extension left, the declared counts and bounds kept", async () => {
    const bytes = await sample("compressed.glb");
    const before = readGlb(bytes).json as Json;
    const plain = await normalizeGltf(bytes, "glb");
    const { json, bin } = readGlb(plain) as { json: Json; bin: Uint8Array };
    assert.equal(json.extensionsUsed, undefined);
    assert.equal(json.extensionsRequired, undefined);
    assert.equal(json.buffers.length, 1);
    assert.equal(json.buffers[0].byteLength, bin.byteLength);
    for (const [at, accessor] of (json.accessors as Json[]).entries()) {
      assert.equal(accessor.count, before.accessors[at].count, `accessor ${at} count`);
      const view = json.bufferViews[accessor.bufferView];
      assert.ok(view.byteOffset + view.byteLength <= bin.byteLength);
    }
    for (const mesh of json.meshes)
      for (const primitive of mesh.primitives) assert.equal(primitive.extensions, undefined);
    const position = json.accessors[json.meshes[1].primitives[0].attributes.POSITION];
    const view = json.bufferViews[position.bufferView];
    const xyz = new Float32Array(bin.slice(view.byteOffset, view.byteOffset + view.byteLength).buffer);
    for (const [i, value] of xyz.entries()) {
      const c = i % 3;
      const inside = value >= position.min[c] - 1e-3 && value <= position.max[c] + 1e-3;
      assert.ok(inside, `vertex ${i} inside the declared box`);
    }
    assert.equal(sha(await normalizeGltf(bytes, "glb")), sha(plain), "deterministic");
  });

  it("a meshopt GLB is written back plain with the original vertex bytes", async () => {
    const vertices = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
    const plain = meshToGlb({
      name: "quad",
      materials: [],
      primitives: [{ positions: vertices, indices: Uint32Array.from([0, 1, 2, 2, 1, 3]) }],
    });
    const compressed = meshoptGlb(plain);
    const back = readGlb(await normalizeGltf(compressed, "glb")) as { json: Json; bin: Uint8Array };
    assert.equal(back.json.extensionsUsed, undefined);
    const view = back.json.bufferViews[back.json.accessors[0].bufferView];
    assert.deepEqual(
      [...new Float32Array(back.bin.slice(view.byteOffset, view.byteOffset + view.byteLength).buffer)],
      [...vertices],
    );
  });

  const required: Array<[string, string, Json]> = [
    [
      "a GLB requiring KHR_texture_basisu",
      "glb",
      { extensionsUsed: ["KHR_texture_basisu"], extensionsRequired: ["KHR_texture_basisu"] },
    ],
    [
      "a .gltf requiring Draco",
      "gltf",
      { extensionsUsed: ["KHR_draco_mesh_compression"], extensionsRequired: ["KHR_draco_mesh_compression"] },
    ],
  ];
  for (const [what, ext, extra] of required) {
    it(`${what} is refused unsupported-extension`, async () => {
      const json = { asset: { version: "2.0" }, ...extra };
      const bytes = ext === "glb" ? writeGlb(json, new Uint8Array(0)) : new TextEncoder().encode(JSON.stringify(json));
      const result = await convertAsset({
        converter: ImportConverter.GltfDecompress,
        ext,
        name: "x",
        bytes,
        targets: [BuildTarget.Mac],
      });
      assert.equal(!result.ok && result.refusal, AssetImportRefusal.UnsupportedExtension);
    });
  }

  it("a plain GLB is kept byte for byte", async () => {
    const bytes = await sample("animated.glb");
    assert.equal(sha(await normalizeGltf(bytes, "glb")), sha(bytes));
  });
});

describe("quantized glTF (KHR_mesh_quantization, gltfpack's default)", () => {
  it("gltfpack's quantized Suzanne is dequantized: float attributes, the same vertices, its uv transform baked", async () => {
    const bytes = new Uint8Array(await readFile(path.join(IMPORT, "quantized.glb")));
    assert.deepEqual((readGlb(bytes).json as Json).extensionsRequired, ["KHR_mesh_quantization"]);
    const plain = await normalizeGltf(bytes, "glb");
    const { json, bin } = readGlb(plain) as { json: Json; bin: Uint8Array };
    assert.equal(json.extensionsUsed, undefined, "KHR_mesh_quantization and the baked KHR_texture_transform are gone");
    assert.equal(json.extensionsRequired, undefined);
    assert.equal(json.materials[0].pbrMetallicRoughness.baseColorTexture.extensions, undefined);
    const primitive = json.meshes[0].primitives[0];
    for (const semantic of ["POSITION", "NORMAL", "TEXCOORD_0"]) {
      const accessor = json.accessors[primitive.attributes[semantic]];
      assert.equal(accessor.componentType, GltfComponent.Float, semantic);
      assert.equal(accessor.normalized, undefined, semantic);
    }
    const read = (semantic: string) => floatAttribute(json, bin, primitive.attributes[semantic]);
    const [scale, offset] = [json.nodes[0].scale as number[], json.nodes[0].translation as number[]];
    const positions = read("POSITION").map((p) => p.map((v, c) => v * (scale[c] ?? 1) + (offset[c] ?? 0)));
    const box = json.accessors[primitive.attributes.POSITION];
    assert.deepEqual([box.min, box.max], boundsOf(read("POSITION")), "POSITION's min and max are the float data's");
    const normals = read("NORMAL");
    const uvs = read("TEXCOORD_0");
    const source = objToMesh(await readFile(path.join(SAMPLES, "model.obj"), "utf8"), null, "", "suzanne");
    const original = source.primitives.flatMap((p) => vertices(p.positions, p.normals, p.uvs));
    // One step of gltfpack's 14-bit grid along each axis: the node's scale.
    const step = Math.hypot(...scale);
    for (const [at, position] of positions.entries()) {
      const found = original.some(
        (v) =>
          distance(v.position, position) < step &&
          distance(v.normal, normals[at] ?? []) < 2e-2 &&
          distance(v.uv, uvs[at] ?? []) < 1e-3,
      );
      assert.ok(found, `vertex ${at} is one of the OBJ's within the quantization step`);
    }
    assert.equal(sha(await normalizeGltf(bytes, "glb")), sha(plain), "deterministic");
    const golden = new Uint8Array(await readFile(path.join(IMPORT, "quantized.plain.glb")));
    assert.equal(sha(plain), sha(golden), "the runtime's fixture (genex-render tests/mesh.rs) is this output");
  });

  const hostileQuantized: Array<[string, (json: Json) => void]> = [
    ["an accessor past its view's end", (json) => Object.assign(json.accessors[1], { count: 1_000_000 })],
    ["a sparse quantized accessor", (json) => Object.assign(json.accessors[1], { sparse: { count: 1 } })],
    ["an accessor that is both JOINTS_0 and NORMAL", (json) => (json.meshes[0].primitives[0].attributes.JOINTS_0 = 1)],
    ["a component type glTF does not have", (json) => (json.accessors[1].componentType = 5124)],
    ["a view outside the binary chunk", (json) => (json.bufferViews[2].byteOffset = 1 << 30)],
  ];
  for (const [what, damage] of hostileQuantized) {
    it(`a quantized GLB with ${what} is refused malformed`, async () => {
      const { json, bin } = readGlb(new Uint8Array(await readFile(path.join(IMPORT, "quantized.glb")))) as {
        json: Json;
        bin: Uint8Array;
      };
      damage(json);
      const result = await convertAsset({
        converter: ImportConverter.GltfDecompress,
        ext: "glb",
        name: "x",
        bytes: writeGlb(json, bin),
        targets: [BuildTarget.Mac],
      });
      assert.equal(!result.ok && result.refusal, AssetImportRefusal.Malformed, JSON.stringify(result));
    });
  }

  it("a .gltf requiring KHR_mesh_quantization is refused unsupported-extension (deliver it as GLB)", async () => {
    const json = {
      asset: { version: "2.0" },
      extensionsUsed: ["KHR_mesh_quantization"],
      extensionsRequired: ["KHR_mesh_quantization"],
    };
    const result = await convertAsset({
      converter: ImportConverter.GltfDecompress,
      ext: "gltf",
      name: "x",
      bytes: new TextEncoder().encode(JSON.stringify(json)),
      targets: [BuildTarget.Mac],
    });
    assert.equal(!result.ok && result.refusal, AssetImportRefusal.UnsupportedExtension);
  });
});

/** A float accessor's elements, each an array of its components. */
function floatAttribute(json: Json, bin: Uint8Array, at: number): number[][] {
  const accessor = json.accessors[at];
  const view = json.bufferViews[accessor.bufferView];
  const width = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[accessor.type] ?? 1;
  const stride = view.byteStride ?? width * 4;
  const data = new DataView(bin.buffer, bin.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0));
  return Array.from({ length: accessor.count }, (_, i) =>
    Array.from({ length: width }, (_, c) => data.getFloat32(i * stride + c * 4, true)),
  );
}

/** Per-component bounds as glTF stores them (single-precision values). */
function boundsOf(elements: number[][]): [number[], number[]] {
  const width = elements[0]?.length ?? 0;
  const min = Array.from({ length: width }, (_, c) => Math.min(...elements.map((e) => e[c] ?? 0)));
  const max = Array.from({ length: width }, (_, c) => Math.max(...elements.map((e) => e[c] ?? 0)));
  return [min.map(Math.fround), max.map(Math.fround)];
}

function vertices(positions: Float32Array, normals?: Float32Array, uvs?: Float32Array) {
  return Array.from({ length: positions.length / 3 }, (_, i) => ({
    position: [...positions.subarray(i * 3, i * 3 + 3)],
    normal: normals ? [...normals.subarray(i * 3, i * 3 + 3)] : [0, 0, 0],
    uv: uvs ? [...uvs.subarray(i * 2, i * 2 + 2)] : [0, 0],
  }));
}

const distance = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(...a.map((value, c) => value - (b[c] ?? Number.NaN)));

/**
 * `glb` with its first buffer view (the positions) re-encoded as meshopt ATTRIBUTES (codec
 * version 0, every byte group stored raw), the way `gltfpack` lays it out: the encoded stream in
 * buffer 0, a fallback buffer 1 with no data.
 */
function meshoptGlb(glb: Uint8Array): Uint8Array {
  const { json, bin } = readGlb(glb) as { json: Json; bin: Uint8Array };
  const view = json.bufferViews[0];
  const stride = 12;
  const raw = bin.slice(view.byteOffset, view.byteOffset + view.byteLength);
  const encoded = encodeMeshoptAttributes(raw, raw.byteLength / stride, stride);
  const tail = new Uint8Array(Math.ceil(bin.byteLength / 4) * 4 - bin.byteLength);
  const merged = new Uint8Array([...bin, ...tail, ...encoded]);
  json.buffers = [
    { byteLength: merged.byteLength },
    { byteLength: view.byteLength, extensions: { EXT_meshopt_compression: { fallback: true } } },
  ];
  json.bufferViews[0] = {
    buffer: 1,
    byteOffset: 0,
    byteLength: view.byteLength,
    byteStride: stride,
    target: view.target,
    extensions: {
      EXT_meshopt_compression: {
        buffer: 0,
        byteOffset: bin.byteLength + tail.byteLength,
        byteLength: encoded.byteLength,
        byteStride: stride,
        count: raw.byteLength / stride,
        mode: "ATTRIBUTES",
      },
    },
  };
  json.extensionsUsed = ["EXT_meshopt_compression"];
  json.extensionsRequired = ["EXT_meshopt_compression"];
  return writeGlb(json, merged);
}

/** meshoptimizer's vertex codec v0 with raw byte groups: header, per-byte zigzag deltas, a zero tail. */
function encodeMeshoptAttributes(data: Uint8Array, count: number, stride: number): Uint8Array {
  const out: number[] = [0xa0];
  const blockSize = Math.min(Math.floor(8192 / stride) & ~15, 256);
  const last = new Uint8Array(stride);
  for (let start = 0; start < count; start += blockSize) {
    const size = Math.min(blockSize, count - start);
    const aligned = Math.ceil(size / 16) * 16;
    for (let k = 0; k < stride; k++) {
      out.push(...new Array(Math.ceil(aligned / 16 / 4)).fill(0xff));
      let previous = last[k] ?? 0;
      const deltas = new Array(aligned).fill(0);
      for (let i = 0; i < size; i++) {
        const value = data[(start + i) * stride + k] ?? 0;
        const delta = (value - previous) & 0xff;
        deltas[i] = ((delta << 1) ^ (delta & 0x80 ? 0xff : 0)) & 0xff;
        previous = value;
      }
      out.push(...deltas);
    }
    last.set(data.subarray((start + size - 1) * stride, (start + size) * stride));
  }
  out.push(...new Array(Math.max(32, stride)).fill(0));
  return Uint8Array.from(out);
}

describe("the importer in its own sandbox", { skip: process.platform === "win32" && "POSIX links and FIFOs" }, () => {
  let game: string;
  let root: string;
  let jobsRoot: string;
  const sandboxes: ProcessSandbox[] = [];
  const runs: RunResult[] = [];
  const deps = (extra: Partial<RustAssetImportDeps> = {}): RustAssetImportDeps => ({
    jobsRoot,
    secretPaths: [],
    sandboxFor: async (options): Promise<ImportSandbox> => {
      const sandbox = await ProcessSandbox.create(options);
      sandboxes.push(sandbox);
      return {
        run: async (request) => {
          const run = await sandbox.run(request);
          runs.push(run);
          return run;
        },
        dispose: () => sandbox.dispose(),
      };
    },
    ...extra,
  });

  before(async () => {
    ({ root, game } = await makeGame());
    jobsRoot = path.join(root, "jobs");
  });
  after(async () => {
    await Promise.all(sandboxes.map((sandbox) => sandbox.dispose()));
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    await SandboxManager.reset();
  });

  it("imports a Rust game's files: converted, normalized, kept and refused, each typed", {
    timeout: 120_000,
  }, async () => {
    const files = [
      "assets/model.obj",
      "assets/model.stl",
      "assets/model.ply",
      "assets/compressed.glb",
      "assets/texture.ktx2",
      "assets/tone.wav",
      "assets/animated.fbx",
      "assets/sample.xm",
      "assets/escape.obj",
      "assets/out-link/secret.obj",
      "assets/pipe.obj",
      "assets/broken.stl",
      "../outside/secret.obj",
    ];
    const result = await importRustAssets(deps({ newJobId: () => "job-1" }), {
      gameRoot: game,
      stack: GameStack.RustWgpu,
      files,
      targets: [BuildTarget.Mac, BuildTarget.Ios],
    });
    const by = new Map(result.files.map((entry) => [entry.file, entry]));
    for (const file of ["assets/model.obj", "assets/model.stl", "assets/model.ply", "assets/compressed.glb"]) {
      const entry = by.get(file);
      assert.ok(entry?.output, `${file}: ${JSON.stringify(entry)} ${result.log}`);
      assert.equal(entry.output.file, file.replace(/\.\w+$/, ".glb"));
      assert.equal(sha(await readFile(entry.output.path)), entry.output.sha256);
      assert.equal(glbShape(await readFile(entry.output.path)).triangles > 0, true);
    }
    const ktx2 = by.get("assets/texture.ktx2");
    assert.deepEqual(
      ktx2?.textures?.map((t) => t.compression),
      Object.values(TextureCompression),
    );
    assert.equal(ktx2?.output?.sha256, sha(await sample("texture.ktx2")), "kept as delivered");
    assert.equal(by.get("assets/tone.wav")?.action, ImportAction.Keep);
    const refusals = Object.fromEntries(result.files.filter((e) => e.refusal).map((e) => [e.file, e.refusal]));
    assert.deepEqual(refusals, {
      "assets/animated.fbx": AssetImportRefusal.UnsupportedByRust,
      "assets/sample.xm": AssetImportRefusal.UnsupportedByRust,
      "assets/escape.obj": AssetImportRefusal.EscapesGame,
      "assets/out-link/secret.obj": AssetImportRefusal.EscapesGame,
      "assets/pipe.obj": AssetImportRefusal.NotRegularFile,
      "assets/broken.stl": AssetImportRefusal.Malformed,
      "../outside/secret.obj": AssetImportRefusal.UnsafePath,
    });
    assert.equal(runs.at(-1)?.sandboxed, true, "the importer ran sandboxed, never on the fallback path");
    const copied = (await readdir(path.join(result.jobDir, "in"))).sort();
    assert.deepEqual(
      copied,
      ["0.mtl", "0.obj", "1.stl", "2.ply", "3.glb", "4.ktx2", "11.stl"].sort(),
      "nothing refused was copied",
    );
  });

  it("a mipmapped Basis KTX2 gets one KTX2 per destination family, admitted beside its kept source", {
    timeout: 120_000,
  }, async () => {
    await copyFile(path.join(IMPORT, "basis-uastc-64.ktx2"), path.join(game, "assets", "rock.ktx2"));
    const result = await importRustAssets(deps({ newJobId: () => "job-families" }), {
      gameRoot: game,
      stack: GameStack.RustWgpu,
      files: ["assets/rock.ktx2", "assets/texture.ktx2"],
      targets: [BuildTarget.Mac, BuildTarget.Android],
    });
    const [rock, sample40] = result.files;
    assert.ok(rock?.output, `${JSON.stringify(rock)} ${result.log}`);
    assert.equal(
      rock.output.sha256,
      sha(await readFile(path.join(IMPORT, "basis-uastc-64.ktx2"))),
      "kept as delivered",
    );
    assert.deepEqual(
      rock.families?.map((family) => family.file),
      ["assets/rock.bc.ktx2", "assets/rock.astc.ktx2", "assets/rock.etc2.ktx2", "assets/rock.rgba8.ktx2"],
    );
    for (const family of rock.families ?? []) {
      const wire = family.file.split(".").at(-2);
      const golden = await readFile(path.join(IMPORT, `basis-uastc-64.${wire}.ktx2`));
      assert.equal(family.sha256, sha(golden), family.file);
      assert.equal(sha(await readFile(family.path)), family.sha256, `${family.file}: the host's own digest`);
    }
    assert.equal(sample40?.families, undefined);
    assert.equal(sample40?.familiesSkipped, Ktx2FamilySkip.NotSquare);
  });

  it("keeps a .hdr as delivered and refuses one with a bad header", { timeout: 120_000 }, async () => {
    await mkdir(path.join(game, "assets", "env"), { recursive: true });
    const good = flatRadiance(32, 16);
    await writeFile(path.join(game, "assets", "env", "sky.hdr"), good);
    await writeFile(path.join(game, "assets", "env", "bad.hdr"), radiance("-Y 0 +X 0"));
    await writeFile(path.join(game, "assets", "env", "huge.hdr"), radiance("-Y 4096 +X 8192"));
    const result = await importRustAssets(deps({ newJobId: () => "job-hdr" }), {
      gameRoot: game,
      stack: GameStack.RustWgpu,
      files: ["assets/env/sky.hdr", "assets/env/bad.hdr", "assets/env/huge.hdr"],
      targets: [BuildTarget.Mac, BuildTarget.Android],
    });
    const by = new Map(result.files.map((entry) => [entry.file, entry]));
    const kept = by.get("assets/env/sky.hdr");
    assert.ok(kept?.output, `${JSON.stringify(kept)} ${result.log}`);
    assert.equal(kept.output.file, "assets/env/sky.hdr", "kept beside its source under its own name");
    assert.equal(kept.output.sha256, sha(good), "kept as delivered");
    assert.equal(by.get("assets/env/bad.hdr")?.refusal, AssetImportRefusal.Malformed);
    assert.equal(by.get("assets/env/huge.hdr")?.refusal, AssetImportRefusal.Malformed);
  });

  it("the importer reaches no host and writes nothing outside its job's out/", { timeout: 120_000 }, async () => {
    const sibling = path.join(jobsRoot, "sibling");
    await mkdir(sibling, { recursive: true });
    const hostile = {
      argv: [process.execPath, path.join(IMPORT, "hostile-importer.mjs")],
      env: { HOSTILE_GAME: game, HOSTILE_SIBLING: sibling },
    };
    const result = await importRustAssets(deps({ newJobId: () => "job-hostile", importer: hostile }), {
      gameRoot: game,
      stack: GameStack.RustWgpu,
      files: ["assets/model.obj"],
      targets: [BuildTarget.Mac],
    });
    assert.equal(runs.at(-1)?.sandboxed, true);
    const proof = JSON.parse(await readFile(path.join(result.jobDir, "out", "proof.json"), "utf8"));
    for (const key of ["game", "sibling", "jobsRoot", "input", "jobFile"]) {
      assert.notEqual(proof[key], "written", `${key}: ${proof[key]}`);
    }
    assert.equal(proof.proxy, "status:403", "the filtering proxy refuses every host: no domain is open");
    assert.notEqual(proof.direct, "connected", "a direct connection never leaves the sandbox");
    assert.deepEqual(await readdir(sibling), []);
    await assert.rejects(readFile(path.join(game, "assets", "planted.txt")));
    assert.equal(sha(await readFile(path.join(result.jobDir, "in", "0.obj"))), sha(await sample("model.obj")));
    assert.equal(result.files[0]?.refusal, AssetImportRefusal.ImporterFailed, "no receipt: nothing admitted");
  });
});
