import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, open, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpDir } from "../helpers/tmp.ts";
import { readAssetPreview } from "../../src/main/asset-preview.ts";
import {
  ASSET_PREVIEW_MIME,
  assetCompanion,
  assetExtension,
  assetPreviewMode,
} from "../../src/shared/asset-preview.ts";
import { ASSET_FORMATS, type AssetKind, assetFormat, assetKind } from "../../src/shared/game-assets.ts";
import { readContainedImage, walkGameAssets } from "../../src/main/game-assets.ts";

/**
 * raylib's own formats, which no Chromium viewer shows. The samples in `tests/fixtures/asset-previews/`
 * are synthetic minimal files written by hand from each format's public header layout (no tool,
 * no download): a 1×1 QOI, a 1×1 uncompressed DDS, a one-voxel MagicaVoxel VOX, an IQM v2 header
 * with no meshes, a binary M3D with only its HEAD and end chunks, a one-slice silent QOA, a
 * one-pattern two-channel XM and a one-pattern four-channel ProTracker MOD.
 */
const RAYLIB_SAMPLES: ReadonlyArray<{ ext: string; kind: AssetKind; magic: string; at: number }> = [
  { ext: "qoi", kind: "image", magic: "qoif", at: 0 },
  { ext: "dds", kind: "image", magic: "DDS ", at: 0 },
  { ext: "vox", kind: "model", magic: "VOX ", at: 0 },
  { ext: "iqm", kind: "model", magic: "INTERQUAKEMODEL\0", at: 0 },
  { ext: "m3d", kind: "model", magic: "3DMO", at: 0 },
  { ext: "qoa", kind: "audio", magic: "qoaf", at: 0 },
  { ext: "xm", kind: "audio", magic: "Extended Module: ", at: 0 },
  // ProTracker's signature follows the title, 31 sample headers, the song length and the order table.
  { ext: "mod", kind: "audio", magic: "M.K.", at: 1080 },
];
const SAMPLES = path.join(import.meta.dirname, "../fixtures/asset-previews");

it("preview reads actual media/model bytes but rejects scripts, traversal, hidden files and symlinks", async () => {
  const root = await tmpDir("asset-preview-");
  await mkdir(path.join(root, "assets"));
  await mkdir(path.join(root, "private"));
  const bytes = Buffer.from([0, 1, 2, 255]);
  await writeFile(path.join(root, "assets/model.glb"), bytes);
  assert.deepEqual((await readAssetPreview(root, "assets/model.glb")).data, new Uint8Array(bytes));
  await assert.rejects(readAssetPreview(root, "assets/model.glb", undefined, 3), /preview memory limit/);
  for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])
    await assert.rejects(readAssetPreview(root, "assets/model.glb", undefined, limit));
  await writeFile(path.join(root, "private/secret.json"), "{}");
  await symlink(path.join(root, "private"), path.join(root, "assets/linked"));
  await assert.rejects(readAssetPreview(root, "assets/linked/secret.json"), /Linked/);
  for (const file of [
    "private/secret.json",
    "assets/../private/secret.json",
    "assets/.key.json",
    "assets/src/script.json",
    "assets/script.js",
  ])
    await assert.rejects(readAssetPreview(root, file));
  const large = await open(path.join(root, "assets/large.glb"), "w");
  await large.truncate(101 * 1024 * 1024);
  await large.close();
  await assert.rejects(readAssetPreview(root, "assets/large.glb"), /preview memory limit/);
});
it("model companions stay within the asset root and reject remote, encoded traversal and platform paths", () => {
  assert.equal(assetCompanion("assets/models/a.gltf", "../textures/a.png"), "assets/textures/a.png");
  assert.equal(assetCompanion("@genex/job/a.gltf", "textures/a.png"), "@genex/job/textures/a.png");
  for (const uri of [
    "../../secret.json",
    "%2e%2e/%2e%2e/secret.json",
    "https://host/asset.png",
    "file:///secret",
    "/etc/passwd",
    "C:\\secret",
    "texture.png?x=1",
    ".secret",
  ])
    assert.throws(() => assetCompanion("assets/models/a.gltf", uri));
  assert.throws(() => assetCompanion("@genex/job/a.gltf", "../other/a.png"));
  // A model in an engine's or a plugin's asset folder loads what lies beside it in its top folder;
  // the main side holds the read to the game's asset folders.
  assert.equal(assetCompanion("Assets/m/car.gltf", "car.bin"), "Assets/m/car.bin");
  assert.equal(assetCompanion("Assets/m/car.obj", "../textures/car.png"), "Assets/textures/car.png");
  assert.equal(assetCompanion("car.gltf", "car.bin"), "car.bin", "a model at the game's root");
  assert.throws(() => assetCompanion("Assets/m/car.gltf", "../../secret.bin"), /leaves its asset folder/);
});
it("each advertised media format chooses a viewer while authoring and executable formats stay unsupported", () => {
  for (const ext of ["glb", "gltf", "fbx", "obj", "stl", "ply"]) assert.equal(assetPreviewMode(`a.${ext}`), "model");
  for (const ext of ["hdr", "exr", "ktx2"]) assert.equal(assetPreviewMode(`a.${ext}`), "texture");
  for (const ext of ["png", "gif", "webp", "svg", "avif", "bmp"]) assert.equal(assetPreviewMode(`a.${ext}`), "image");
  for (const ext of ["mp3", "wav", "flac", "opus", "m4a"]) assert.equal(assetPreviewMode(`a.${ext}`), "audio");
  for (const ext of ["mp4", "webm", "mov", "ogv"]) assert.equal(assetPreviewMode(`a.${ext}`), "video");
  for (const ext of ["blend", "exe", "html", "js"]) assert.equal(assetPreviewMode(`a.${ext}`), "unsupported");
});
it("one format table answers kind, viewer, type and thumbnail for every extension, and never an inherited name", () => {
  // The kind, the viewer and the MIME type used to be three lists that disagreed about textures and model companions.
  for (const [ext, format] of Object.entries(ASSET_FORMATS)) {
    assert.equal(ASSET_PREVIEW_MIME[ext], format.mime, ext);
    assert.equal(assetKind(`a.${ext.toUpperCase()}`), format.kind, ext);
    assert.equal(assetPreviewMode(`a.${ext}`), format.preview, ext);
    if (format.preview === "image" || format.preview === "texture")
      assert.equal(format.kind, "image", `${ext} is shown as a picture, so it is one`);
    if (format.raster)
      assert.ok(
        format.mime.startsWith("image/") && format.preview === "image",
        `${ext}: a thumbnail is a plain picture`,
      );
  }
  assert.deepEqual(
    Object.keys(ASSET_FORMATS)
      .filter((ext) => ASSET_FORMATS[ext]!.raster)
      .sort(),
    ["gif", "jpeg", "jpg", "png", "webp"],
    "the formats the contained reader byte-checks",
  );
  assert.deepEqual(
    Object.keys(ASSET_FORMATS)
      .filter((ext) => ASSET_FORMATS[ext]!.texture)
      .sort(),
    ["bmp", "jpeg", "jpg", "png", "webp"],
    "the pictures an FBX may name",
  );
  assert.equal(assetKind("a.mtl"), "other", "a material library is a model's companion, not a model");
  assert.equal(assetPreviewMode("a.mtl"), "text");
  for (const name of ["a.constructor", "a.__proto__", "a.toString", "png", "noext"])
    assert.deepEqual(
      [assetFormat(name), assetKind(name), ASSET_PREVIEW_MIME[assetExtension(name)] ?? null],
      [null, "other", name === "png" ? "image/png" : null],
      name,
    );
});
it("raylib's own formats read as their kind with no viewer, and no reader crashes on them", async () => {
  const root = await tmpDir("asset-preview-raylib-");
  await mkdir(path.join(root, "assets"));
  for (const { ext, kind, magic, at } of RAYLIB_SAMPLES) {
    const file = `assets/sample.${ext}`;
    const bytes = await readFile(path.join(SAMPLES, `sample.${ext}`));
    assert.ok(bytes.length > 0, `${ext}: the sample has bytes`);
    assert.equal(
      bytes.subarray(at, at + magic.length).toString("latin1"),
      magic,
      `${ext}: the sample carries its magic`,
    );
    await writeFile(path.join(root, file), bytes);
    assert.equal(assetKind(file), kind, ext);
    assert.equal(assetPreviewMode(file), "unsupported", ext);
    const read = await readAssetPreview(root, file);
    assert.equal(read.mimeType, "application/octet-stream", ext);
    assert.deepEqual(Buffer.from(read.data), bytes, `${ext}: the contained reader hands the bytes back unchanged`);
    assert.equal(await readContainedImage(root, file), null, `${ext}: no thumbnail is made of it`);
  }
  const walked = await walkGameAssets(root);
  assert.deepEqual(
    walked.entries.map((entry) => entry.file),
    RAYLIB_SAMPLES.map(({ ext }) => `assets/sample.${ext}`).sort(),
  );
  assert.deepEqual(walked.skipped, []);
});
