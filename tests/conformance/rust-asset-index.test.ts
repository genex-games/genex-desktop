/**
 * The streaming facts and named groups in `assets/genex-asset-index.json`
 * (`src/main/rust-package-assets.ts`, C-29 and C-30), so the streaming code reads only the index:
 *
 * - a model's levels of detail coarse first, each with the byte ranges of its triangle list in the
 *   shipped GLB, beside the bytes every level needs (the GLB's head and its vertex data) and its UV
 *   texel density (UV area over world area, node transforms applied) for mip priority (STR-17,
 *   STR-19);
 * - a KTX2 family file's levels smallest first, with each one's side and byte range;
 * - `genex.toml`'s `[[asset_group]]` rows as the index's `groups`, each listing its member assets;
 *   a member of any group is not `boot`.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ASSET_INDEX_FILE,
  type AssetIndex,
  type AssetIndexEntry,
  packageAssets,
} from "../../src/main/rust-package-assets.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { GltfComponent, meshToGlb, readGlb, writeGlb } from "../../src/substrate/asset-import/glb.ts";
import { writeKtx2 } from "../../src/substrate/asset-import/ktx2-write.ts";
import { addLodExtras, type LodLevel, readLodSet } from "../../src/substrate/asset-import/lods.ts";
import { readGeometry } from "../../src/substrate/asset-import/meshlets.ts";
import { TextureCompression } from "../../src/substrate/asset-import/texture-table.ts";
import type { AssetGroupRow } from "../../src/substrate/genex-toml.ts";
import { tmpDir } from "../helpers/tmp.ts";

type Json = Record<string, any>;
/** The density rows' tolerance (the WP's 1%). */
const DENSITY_TOLERANCE = 0.01;

/** A UV sphere of `rings` x `segments` quads, one primitive. */
function sphereGlb(rings: number, segments: number): Uint8Array {
  const positions: number[] = [];
  for (let r = 0; r <= rings; r++) {
    for (let s = 0; s <= segments; s++) {
      const theta = (r / rings) * Math.PI;
      const phi = (s / segments) * Math.PI * 2;
      positions.push(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s;
      const b = a + segments + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  return meshToGlb({
    name: "sphere",
    materials: [],
    primitives: [{ positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }],
  });
}

/** A `width` x `height` quad in the XY plane with UVs over `[0, uvMax]` on both axes. */
function quadGlb(width: number, height: number, uvMax = 1, withUvs = true): Uint8Array {
  const positions = Float32Array.from([0, 0, 0, width, 0, 0, width, height, 0, 0, height, 0]);
  const uvs = Float32Array.from([0, uvMax, uvMax, uvMax, uvMax, 0, 0, 0]);
  const indices = Uint32Array.from([0, 1, 2, 0, 2, 3]);
  return meshToGlb({
    name: "quad",
    materials: [],
    primitives: [{ positions, indices, ...(withUvs ? { uvs } : {}) }],
  });
}

/** `glb` with its one node given `fields` (a scale, a matrix) and, with `parentScale`, under a scaled parent. */
function withNode(glb: Uint8Array, fields: Json, parentScale?: number): Uint8Array {
  const { json, bin } = readGlb(glb) as { json: Json; bin: Uint8Array };
  Object.assign(json.nodes[0], fields);
  if (parentScale !== undefined) {
    json.nodes.push({ children: [0], scale: [parentScale, parentScale, parentScale] });
    json.scenes[0].nodes = [json.nodes.length - 1];
  }
  return writeGlb(json, bin);
}

/** A full KTX2 chain of `side` in BC7, each level filled with its own byte. */
function bcChain(side: number): Uint8Array {
  const levels: Uint8Array[] = [];
  for (let level = 0; side >> level >= 1; level++) {
    levels.push(new Uint8Array(Math.ceil((side >> level) / 4) ** 2 * 16).fill(level + 1));
  }
  return writeKtx2({ compression: TextureCompression.Bc, srgb: true, side, levels });
}

/** The index of `files` packaged for `target`, with `groups`. */
async function indexOf(
  files: Array<[string, Uint8Array]>,
  options: { groups?: readonly AssetGroupRow[]; target?: BuildTarget } = {},
): Promise<{ index: AssetIndex; out: string; text: string }> {
  const parent = await realpath(await tmpDir("rust-asset-index-"));
  const from = path.join(parent, "stage", "assets");
  for (const [name, bytes] of files) {
    const to = path.join(from, ...name.split("/"));
    await mkdir(path.dirname(to), { recursive: true });
    await writeFile(to, bytes);
  }
  const out = path.join(parent, "out", "assets");
  await packageAssets({
    from,
    to: out,
    target: options.target ?? BuildTarget.Mac,
    ...(options.groups ? { groups: options.groups } : {}),
  });
  const text = await readFile(path.join(out, ASSET_INDEX_FILE), "utf8");
  return { index: JSON.parse(text) as AssetIndex, out, text };
}

const entryOf = (index: AssetIndex, rel: string): AssetIndexEntry => {
  const found = index.assets.find((entry) => entry.path === rel);
  assert.ok(found, `no index entry for ${rel}`);
  return found;
};

/** The little-endian unsigned values of `width` bytes in `bytes` at `ranges`, in order. */
function valuesAt(bytes: Uint8Array, ranges: ReadonlyArray<{ offset: number; bytes: number }>, width: 2 | 4): number[] {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: number[] = [];
  for (const range of ranges) {
    for (let at = range.offset; at < range.offset + range.bytes; at += width)
      values.push(width === 2 ? data.getUint16(at, true) : data.getUint32(at, true));
  }
  return values;
}

const near = (actual: number | null | undefined, expected: number) =>
  typeof actual === "number" && Math.abs(actual - expected) <= expected * DENSITY_TOLERANCE;

describe("asset index: a model's levels coarse first with byte ranges (C-29)", () => {
  it("the LOD sphere lists its levels coarse first, each range holding exactly that level's triangle list", async () => {
    const lods = await addLodExtras(sphereGlb(32, 64));
    assert.equal(lods.simplified, true, "the sphere has import-time levels");
    const glb = lods.bytes;
    const { index, out } = await indexOf([["models/sphere.glb", glb]]);
    const mesh = entryOf(index, "models/sphere.glb").mesh;
    assert.ok(mesh, "a model entry carries its mesh facts");
    const { json, bin } = readGlb(glb) as { json: Json; bin: Uint8Array };
    const primitive = json.meshes[0].primitives[0];
    const set = readLodSet(json, bin, primitive).set;
    assert.ok(set && set.levels.length >= 2, "at least two simplified levels");
    // Coarse first: the coarsest simplified level, then finer ones, then level 0 (the mesh itself).
    assert.deepEqual(
      mesh.levels.map((level) => level.level),
      Array.from({ length: set.levels.length + 1 }, (_, at) => set.levels.length - at),
    );
    const triangles = mesh.levels.map((level) => level.triangles);
    assert.deepEqual(
      triangles,
      [...triangles].sort((a, b) => a - b),
      "triangles grow from the first level listed to the last",
    );
    assert.equal(mesh.triangles, 32 * 64 * 2, "level 0's triangles");
    assert.equal(mesh.levels.at(-1)?.triangles, mesh.triangles);
    const shipped = new Uint8Array(await readFile(path.join(out, "models", "sphere.glb")));
    for (const level of mesh.levels) {
      const expected: LodLevel | null | undefined = level.level === 0 ? null : set.levels[level.level - 1];
      if (expected) {
        const words = valuesAt(shipped, level.ranges, 4);
        assert.deepEqual(words, [...expected.indices], `level ${level.level}'s bytes are its triangle list`);
        assert.equal(level.error, expected.error);
      } else {
        assert.equal(level.error, 0);
        const own = readGeometry(json, bin, primitive)?.indices;
        assert.ok(own, "the sphere reads as triangles");
        const width = json.accessors[primitive.indices].componentType === GltfComponent.UnsignedShort ? 2 : 4;
        assert.deepEqual(
          valuesAt(shipped, level.ranges, width),
          [...own],
          "level 0's range is the primitive's own index list",
        );
      }
    }
    // Every level needs the GLB's head (header, JSON chunk, BIN chunk header) and the vertex data.
    const binStart = 20 + new DataView(glb.buffer, glb.byteOffset).getUint32(12, true) + 8;
    assert.deepEqual(mesh.head, { offset: 0, bytes: binStart });
    const positions = json.bufferViews[json.accessors[primitive.attributes.POSITION].bufferView];
    const covered = mesh.vertices.some(
      (range) =>
        range.offset <= binStart + positions.byteOffset &&
        range.offset + range.bytes >= binStart + positions.byteOffset + positions.byteLength,
    );
    assert.ok(covered, "the vertex ranges cover POSITION");
    const ends = [mesh.head, ...mesh.vertices, ...mesh.levels.flatMap((level) => level.ranges)].map(
      (range) => range.offset + range.bytes,
    );
    assert.ok(Math.max(...ends) <= shipped.byteLength, "every range lies inside the shipped file");
  });

  it("a model without import-time levels lists level 0 alone", async () => {
    const { index } = await indexOf([["quad.glb", quadGlb(2, 2)]]);
    const mesh = entryOf(index, "quad.glb").mesh;
    assert.deepEqual(
      mesh?.levels.map((level) => [level.level, level.triangles, level.error]),
      [[0, 2, 0]],
    );
  });
});

describe("asset index: a model's UV texel density (C-29)", () => {
  const rows: Array<[string, Uint8Array, number]> = [
    ["a 1x1 quad with UVs over [0,1]", quadGlb(1, 1), 1],
    ["a 2x3 quad with UVs over [0,1]", quadGlb(2, 3), Math.sqrt(1 / 6)],
    ["a 4x4 quad tiling its texture twice", quadGlb(4, 4, 2), 0.5],
    ["a 1x1 quad scaled 2x by its node", withNode(quadGlb(1, 1), { scale: [2, 2, 2] }), 0.5],
    ["a 1x1 quad scaled 2x3 by its node", withNode(quadGlb(1, 1), { scale: [2, 3, 1] }), Math.sqrt(1 / 6)],
    ["a 1x1 quad under a parent scaled 4x", withNode(quadGlb(1, 1), {}, 4), 0.25],
    [
      "a 1x1 quad with a node matrix scaling 2x",
      withNode(quadGlb(1, 1), { matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 5, 6, 7, 1] }),
      0.5,
    ],
  ];
  for (const [name, glb, expected] of rows) {
    it(`${name}: ${expected.toFixed(4)} UV per unit, within 1%`, async () => {
      const { index } = await indexOf([["quad.glb", glb]]);
      const density = entryOf(index, "quad.glb").mesh?.uvDensity;
      assert.ok(near(density, expected), `uvDensity ${density}, expected ${expected}`);
    });
  }

  it("a model without TEXCOORD_0 has no density", async () => {
    const { index } = await indexOf([["plain.glb", quadGlb(1, 1, 1, false)]]);
    assert.equal(entryOf(index, "plain.glb").mesh?.uvDensity, null);
  });
});

describe("asset index: KTX2 levels smallest first (C-29)", () => {
  it("each family file lists its levels smallest first, with the side and the bytes of each", async () => {
    const ktx2 = bcChain(64);
    const { index, out } = await indexOf([
      ["rock.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
      ["rock.bc.ktx2", ktx2],
    ]);
    const file = entryOf(index, "rock.png").files.find((row) => row.family === TextureCompression.Bc);
    assert.ok(file?.levels, "the family file carries its levels");
    assert.deepEqual(
      file.levels.map((level) => level.px),
      [1, 2, 4, 8, 16, 32, 64],
    );
    const shipped = new Uint8Array(await readFile(path.join(out, "rock.bc.ktx2")));
    for (const level of file.levels) {
      const fill = Math.log2(64 / level.px) + 1;
      const bytes = shipped.subarray(level.offset, level.offset + level.bytes);
      assert.equal(bytes.length, Math.ceil(level.px / 4) ** 2 * 16);
      assert.ok(
        bytes.every((byte) => byte === fill),
        `level of ${level.px} px holds its own bytes`,
      );
    }
    assert.equal(file.levels.reduce((sum, level) => sum + level.bytes, 0) <= file.bytes, true);
  });

  it("a phone's trimmed family file lists only the levels it ships", async () => {
    const { index } = await indexOf([["rock.astc.ktx2", trimmedSource()]], { target: BuildTarget.Ios });
    const file = index.assets.flatMap((entry) => entry.files).find((row) => row.path === "rock.astc.ktx2");
    assert.equal(file?.px, 2048);
    assert.equal(file?.levels?.at(-1)?.px, 2048);
    assert.equal(file?.levels?.length, 12);
  });
});

/** An ASTC chain of 4096 px (a phone trims it to 2048). */
function trimmedSource(): Uint8Array {
  const levels: Uint8Array[] = [];
  for (let level = 0; 4096 >> level >= 1; level++)
    levels.push(new Uint8Array(Math.ceil((4096 >> level) / 4) ** 2 * 16));
  return writeKtx2({ compression: TextureCompression.Astc, srgb: true, side: 4096, levels });
}

describe("asset index: named asset groups (C-30)", () => {
  const files: Array<[string, Uint8Array]> = [
    ["interiors/castle/hall.glb", quadGlb(1, 1)],
    ["interiors/castle/throne.glb", quadGlb(1, 1)],
    ["interiors/crypt/tomb.glb", quadGlb(1, 1)],
    ["props/door.glb", quadGlb(1, 1)],
    ["textures/stone.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
    ["textures/stone.bc.ktx2", bcChain(16)],
    ["sky.hdr", new Uint8Array([1, 2, 3])],
  ];
  const groups: AssetGroupRow[] = [
    { name: "crypt", paths: ["interiors/crypt/**", "props/door.glb"] },
    { name: "castle", paths: ["interiors/castle/*.glb", "props/*.glb", "textures/stone.png"] },
    { name: "empty", paths: ["nothing/**"] },
  ];

  it("lists each group by name with its member assets; a path in two groups is in both", async () => {
    const { index } = await indexOf(files, { groups });
    assert.deepEqual(index.groups, [
      {
        name: "castle",
        assets: ["interiors/castle/hall.glb", "interiors/castle/throne.glb", "props/door.glb", "textures/stone.png"],
      },
      { name: "crypt", assets: ["interiors/crypt/tomb.glb", "props/door.glb"] },
      { name: "empty", assets: [] },
    ]);
  });

  it("a member of any group is not boot; every other asset is", async () => {
    const { index } = await indexOf(files, { groups });
    const boot = Object.fromEntries(index.assets.map((entry) => [entry.path, entry.boot]));
    assert.deepEqual(boot, {
      "interiors/castle/hall.glb": false,
      "interiors/castle/throne.glb": false,
      "interiors/crypt/tomb.glb": false,
      "props/door.glb": false,
      "sky.hdr": true,
      "textures/stone.png": false,
    });
  });

  it("without groups the index has none and every asset is boot", async () => {
    const { index } = await indexOf(files);
    assert.deepEqual(index.groups, []);
    assert.ok(index.assets.every((entry) => entry.boot));
  });

  it("two packages of one stage write byte-identical indexes", async () => {
    const [a, b] = await Promise.all([indexOf(files, { groups }), indexOf(files, { groups })]);
    assert.equal(a.text, b.text);
  });
});

describe("asset index: hostile models get no mesh facts and never stop the package (C-29)", () => {
  const sphere = sphereGlb(4, 8);
  const garbled = (edit: (json: Json) => void) => {
    const { json, bin } = readGlb(sphere) as { json: Json; bin: Uint8Array };
    edit(json);
    return writeGlb(json, bin);
  };
  const rows: Array<[string, Uint8Array]> = [
    ["a file that is not a GLB", new TextEncoder().encode("glTF but not really")],
    ["a truncated GLB", sphere.subarray(0, sphere.length - 9)],
    [
      "a view past the binary chunk",
      garbled((json) => {
        json.bufferViews[0].byteOffset = 1 << 20;
      }),
    ],
    [
      "a view in another buffer",
      garbled((json) => {
        json.bufferViews[0].buffer = 1;
      }),
    ],
    [
      "an index accessor past its view",
      garbled((json) => {
        json.accessors[json.meshes[0].primitives[0].indices].count = 1 << 20;
      }),
    ],
    [
      "a negative view offset",
      garbled((json) => {
        json.bufferViews[0].byteOffset = -8;
      }),
    ],
  ];
  for (const [name, bytes] of rows) {
    it(`${name}: the entry has no mesh facts, the file still ships`, async () => {
      const { index } = await indexOf([["bad.glb", bytes]]);
      const entry = entryOf(index, "bad.glb");
      assert.equal(entry.mesh, undefined);
      assert.equal(entry.bytes, bytes.byteLength);
    });
  }
});
