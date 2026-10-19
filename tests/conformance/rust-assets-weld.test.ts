// The import step's weld, dedup and prune (C-7, ports of glTF-Transform): duplicated vertices merge
// to the welded counts, skins and morph targets come through vertex for vertex, equal materials and
// accessors merge, unreferenced ones go, the output is byte-stable and passes the Khronos validator,
// and a document the step cannot rewrite safely comes back as the very same bytes with the reason.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { convertAsset } from "../../src/substrate/asset-import/convert.ts";
import {
  ARRAY_BUFFER,
  BinWriter,
  ELEMENT_ARRAY_BUFFER,
  GltfComponent,
  readGlb,
  writeGlb,
} from "../../src/substrate/asset-import/glb.ts";
import { ImportSizeKey, inspectGlb, parseImportSizes } from "../../src/substrate/asset-import/inspect.ts";
import { ImportConverter } from "../../src/substrate/asset-import/import-plan.ts";
import { IMPORT_JOB_VERSION, ImportJobLayout, parseImportReceipt } from "../../src/substrate/asset-import/job.ts";
import { validateGltf } from "../../src/substrate/asset-import/validate.ts";
import { WeldSkip, weldGlb } from "../../src/substrate/asset-import/weld.ts";
import { runImportJob } from "../../src/substrate/asset-import/worker.ts";
import { tmpDir } from "../helpers/tmp.ts";

// biome-ignore lint/suspicious/noExplicitAny: test fixtures poke at untyped glTF JSON.
type Json = Record<string, any>;
type Typed = Float32Array | Uint8Array | Uint16Array | Uint32Array;

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const fixture = async (...parts: string[]) => new Uint8Array(await readFile(path.join(FIXTURES, ...parts)));

const COMPONENT: ReadonlyMap<unknown, number> = new Map<unknown, number>([
  [Float32Array, GltfComponent.Float],
  [Uint8Array, GltfComponent.UnsignedByte],
  [Uint16Array, GltfComponent.UnsignedShort],
  [Uint32Array, GltfComponent.UnsignedInt],
]);
const WIDTH: Readonly<Record<string, number>> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** One accessor of a fixture: its data, its type and how it is used. */
interface Data {
  data: Typed;
  type: string;
  use?: "vertex" | "index";
  normalized?: boolean;
  bounds?: boolean;
}

function minMax(data: Typed, width: number): { min: number[]; max: number[] } {
  const min = Array.from({ length: width }, () => Number.POSITIVE_INFINITY);
  const max = Array.from({ length: width }, () => Number.NEGATIVE_INFINITY);
  data.forEach((value, i) => {
    const c = i % width;
    min[c] = Math.min(min[c] ?? 0, value);
    max[c] = Math.max(max[c] ?? 0, value);
  });
  return { min, max };
}

/** `bytes`' elements each padded from `element` to `stride` bytes. */
function strided(bytes: Uint8Array, element: number, stride: number): Uint8Array {
  const count = bytes.length / element;
  const out = new Uint8Array(count * stride);
  for (let i = 0; i < count; i++) out.set(bytes.subarray(i * element, (i + 1) * element), i * stride);
  return out;
}

/** One fixture accessor's data appended as a view of its own; vertex data 4-byte strided. */
function viewOf(bin: BinWriter, { data, type, use }: Data): number {
  const width = WIDTH[type] ?? 1;
  const element = data.BYTES_PER_ELEMENT * width;
  const stride = Math.ceil(element / 4) * 4;
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (use === "index") return bin.add(bytes, { target: ELEMENT_ARRAY_BUFFER });
  if (use !== "vertex") return bin.add(bytes);
  if (stride === element) return bin.add(bytes, { target: ARRAY_BUFFER });
  return bin.add(strided(bytes, element, stride), { target: ARRAY_BUFFER, byteStride: stride });
}

/** A GLB of `rest` whose accessors are `accessors`, each in a view of its own. */
function glbOf(accessors: Data[], rest: Json): Uint8Array {
  const bin = new BinWriter();
  const json: Json = {
    asset: { version: "2.0" },
    ...rest,
    accessors: accessors.map((item) => {
      const width = WIDTH[item.type] ?? 1;
      return {
        bufferView: viewOf(bin, item),
        componentType: COMPONENT.get(item.data.constructor),
        count: item.data.length / width,
        type: item.type,
        ...(item.normalized ? { normalized: true } : {}),
        ...(item.bounds ? minMax(item.data, width) : {}),
      };
    }),
  };
  const data = bin.bytes();
  return writeGlb({ ...json, bufferViews: bin.views, buffers: [{ byteLength: data.byteLength }] }, data);
}

/** The elements of accessor `at` of a GLB as numbers, one array per element. */
function elements(glb: Uint8Array, at: number): number[][] {
  const { json, bin } = readGlb(glb) as { json: Json; bin: Uint8Array };
  const accessor = json.accessors[at];
  const view = json.bufferViews[accessor.bufferView];
  const width = WIDTH[accessor.type] ?? 1;
  const read: Record<number, [number, (d: DataView, o: number) => number]> = {
    [GltfComponent.Float]: [4, (d, o) => d.getFloat32(o, true)],
    [GltfComponent.UnsignedByte]: [1, (d, o) => d.getUint8(o)],
    [GltfComponent.UnsignedShort]: [2, (d, o) => d.getUint16(o, true)],
    [GltfComponent.UnsignedInt]: [4, (d, o) => d.getUint32(o, true)],
  };
  const [size, get] = read[accessor.componentType] ?? [4, () => Number.NaN];
  const stride = view.byteStride ?? size * width;
  const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return Array.from({ length: accessor.count }, (_, i) =>
    Array.from({ length: width }, (_, c) => get(data, start + i * stride + c * size)),
  );
}

/** Each corner of a primitive's index stream, as every attribute and morph delta it reads. */
function corners(glb: Uint8Array, mesh: number, primitive: number): string[] {
  const { json } = readGlb(glb) as { json: Json };
  const prim = json.meshes[mesh].primitives[primitive];
  const maps: Array<[string, number]> = [
    ...Object.entries(prim.attributes as Record<string, number>),
    ...(prim.targets ?? []).flatMap((target: Record<string, number>, t: number) =>
      Object.entries(target).map(([key, at]): [string, number] => [`target${t}.${key}`, at]),
    ),
  ];
  const streams = maps.map(([key, at]) => [key, elements(glb, at)] as const);
  const indices = elements(glb, prim.indices).map(([i]) => i ?? 0);
  return indices.map((i) => streams.map(([key, values]) => `${key}=${values[i]?.join(",")}`).join(" "));
}

const RED = { pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], metallicFactor: 0 } };

/**
 * Two primitives over a 3x3 grid (9 vertices, 8 triangles), every vertex stored three times; the
 * second primitive is the first moved along x, with equal normals, uvs and indices in accessors of
 * its own and a material equal to the first but for its name; one accessor nothing names.
 */
function duplicatedGrid(): Uint8Array {
  const grid = Array.from({ length: 9 }, (_, v) => [v % 3, Math.floor(v / 3)] as const);
  const copies = (make: (x: number, y: number) => number[]) =>
    [0, 1, 2].flatMap(() => grid.flatMap(([x, y]) => make(x, y)));
  const triangles = [0, 1, 3, 1, 4, 3, 1, 2, 4, 2, 5, 4, 3, 4, 6, 4, 7, 6, 4, 5, 7, 5, 8, 7];
  // Corner k of the stream uses copy k % 3 of its vertex, so every copy is drawn.
  const indices = Uint16Array.from(triangles.map((v, k) => v + 9 * (k % 3)));
  const normals = Float32Array.from(copies(() => [0, 0, 1]));
  const uvs = Float32Array.from(copies((x, y) => [x / 2, y / 2]));
  const attributes = (position: number, normal: number, uv: number) => ({
    POSITION: position,
    NORMAL: normal,
    TEXCOORD_0: uv,
  });
  return glbOf(
    [
      { data: Float32Array.from(copies((x, y) => [x, y, 0])), type: "VEC3", use: "vertex", bounds: true },
      { data: normals, type: "VEC3", use: "vertex" },
      { data: uvs, type: "VEC2", use: "vertex" },
      { data: indices, type: "SCALAR", use: "index" },
      { data: Float32Array.from(copies((x, y) => [x + 5, y, 0])), type: "VEC3", use: "vertex", bounds: true },
      { data: normals.slice(), type: "VEC3", use: "vertex" },
      { data: uvs.slice(), type: "VEC2", use: "vertex" },
      { data: indices.slice(), type: "SCALAR", use: "index" },
      { data: Float32Array.from([9, 9, 9]), type: "VEC3" },
    ],
    {
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [
        {
          primitives: [
            { attributes: attributes(0, 1, 2), indices: 3, material: 0 },
            { attributes: attributes(4, 5, 6), indices: 7, material: 1 },
          ],
        },
      ],
      materials: [
        { name: "red", ...RED },
        { name: "red again", ...RED },
      ],
    },
  );
}

/**
 * A skinned, morphing quad of nine stored vertices: two are exact copies (they weld), and three
 * copy a vertex but for one joint index, one weight or one morph delta (they must not).
 */
function skinnedMorph(): Uint8Array {
  const base = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
  ];
  const of = [0, 1, 2, 3, 0, 1, 2, 3, 1];
  const positions = Float32Array.from(of.flatMap((v) => base[v] ?? []));
  const joints = Uint8Array.from(of.flatMap((v, i) => (i === 5 ? [0, 1, 0, 0] : [v % 2, 1 - (v % 2), 0, 0])));
  const weights = Float32Array.from(of.flatMap((_, i) => (i === 6 ? [0.75, 0.25, 0, 0] : [0.5, 0.5, 0, 0])));
  const colors = Uint8Array.from(of.flatMap((v) => [v * 60, 255 - v * 60, 128]));
  const delta = Float32Array.from(of.flatMap((v, i) => (i === 7 ? [0, 0, 2] : [0, 0, v / 4])));
  const delta2 = Float32Array.from(of.flatMap((v) => [v / 8, 0, 0]));
  const indices = Uint16Array.from([0, 1, 2, 4, 5, 6, 7, 8, 3, 0, 2, 3]);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return glbOf(
    [
      { data: positions, type: "VEC3", use: "vertex", bounds: true },
      { data: joints, type: "VEC4", use: "vertex" },
      { data: weights, type: "VEC4", use: "vertex" },
      { data: colors, type: "VEC3", use: "vertex", normalized: true },
      { data: delta, type: "VEC3", use: "vertex", bounds: true },
      { data: delta2, type: "VEC3", use: "vertex", bounds: true },
      { data: indices, type: "SCALAR", use: "index" },
      { data: Float32Array.from([...identity, ...identity]), type: "MAT4" },
      { data: Float32Array.from([0, 1]), type: "SCALAR", bounds: true },
      { data: Float32Array.from([0, 0, 0, 1, 0, Math.SQRT1_2, 0, Math.SQRT1_2]), type: "VEC4" },
    ],
    {
      scene: 0,
      scenes: [{ nodes: [0, 1] }],
      nodes: [{ mesh: 0, skin: 0 }, { children: [2] }, { translation: [0, 1, 0] }],
      skins: [{ joints: [1, 2], inverseBindMatrices: 7 }],
      meshes: [
        {
          weights: [0, 0],
          primitives: [
            {
              attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2, COLOR_0: 3 },
              targets: [{ POSITION: 4 }, { POSITION: 5 }],
              indices: 6,
            },
          ],
        },
      ],
      animations: [
        { channels: [{ sampler: 0, target: { node: 2, path: "rotation" } }], samplers: [{ input: 8, output: 9 }] },
      ],
    },
  );
}

/** `glb` with its JSON changed by `change`. */
function changed(glb: Uint8Array, change: (json: Json) => void): Uint8Array {
  const { json, bin } = readGlb(glb) as { json: Json; bin: Uint8Array };
  change(json);
  return writeGlb(json, bin);
}

const welded = (glb: Uint8Array) => {
  const outcome = weldGlb(glb);
  assert.ok(outcome.welded, `not welded: ${outcome.welded ? "" : outcome.reason}`);
  return outcome;
};

describe("weld: duplicated vertices merge to the welded counts", () => {
  it("a grid stored three times welds to its nine vertices per primitive, one material, deduplicated accessors", async () => {
    const input = duplicatedGrid();
    await validateGltf(input, "glb");
    const outcome = welded(input);
    assert.deepEqual(outcome.vertices, { before: 54, after: 18 });
    assert.deepEqual(outcome.materials, { before: 2, after: 1 });
    // Positions twice; normals, uvs and indices merged across the primitives; the stray accessor gone.
    assert.deepEqual(outcome.accessors, { before: 9, after: 5 });
    const { json } = readGlb(outcome.bytes) as { json: Json };
    const [first, second] = json.meshes[0].primitives;
    assert.equal(json.accessors[first.attributes.POSITION].count, 9);
    assert.equal(json.accessors[second.attributes.POSITION].count, 9);
    assert.equal(first.material, 0);
    assert.equal(second.material, 0);
    assert.equal(json.materials[0].name, "red");
    assert.equal(first.attributes.NORMAL, second.attributes.NORMAL);
    assert.equal(first.indices, second.indices);
    assert.deepEqual(json.accessors[second.attributes.POSITION].min, [5, 0, 0]);
    assert.deepEqual(corners(outcome.bytes, 0, 0), corners(input, 0, 0));
    assert.deepEqual(corners(outcome.bytes, 0, 1), corners(input, 0, 1));
    await validateGltf(outcome.bytes, "glb");
  });

  it("an unindexed triangle soup gets indices over its distinct vertices", async () => {
    const soup = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const input = glbOf([{ data: soup, type: "VEC3", use: "vertex", bounds: true }], {
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    });
    const outcome = welded(input);
    assert.deepEqual(outcome.vertices, { before: 6, after: 4 });
    const { json } = readGlb(outcome.bytes) as { json: Json };
    assert.deepEqual(elements(outcome.bytes, json.meshes[0].primitives[0].indices).flat(), [0, 1, 2, 1, 3, 2]);
    await validateGltf(outcome.bytes, "glb");
  });
});

describe("weld: skins and morph targets come through vertex for vertex", () => {
  it("only exact copies weld; joints, weights, colours and both morph deltas per corner are unchanged", async () => {
    const input = skinnedMorph();
    await validateGltf(input, "glb");
    const outcome = welded(input);
    assert.deepEqual(outcome.vertices, { before: 9, after: 7 });
    assert.deepEqual(corners(outcome.bytes, 0, 0), corners(input, 0, 0));
    await validateGltf(outcome.bytes, "glb");
  });

  it("the skin's inverse binds and the animation's samplers keep their bytes", () => {
    const input = skinnedMorph();
    const { bytes } = welded(input);
    const { json } = readGlb(bytes) as { json: Json };
    assert.deepEqual(elements(bytes, json.skins[0].inverseBindMatrices), elements(input, 7));
    const sampler = json.animations[0].samplers[0];
    assert.deepEqual(elements(bytes, sampler.input), elements(input, 8));
    assert.deepEqual(elements(bytes, sampler.output), elements(input, 9));
    assert.deepEqual(json.meshes[0].weights, [0, 0]);
  });
});

describe("weld: byte-stable output", () => {
  it("two runs write the same bytes, and a welded file welds to itself", () => {
    for (const make of [duplicatedGrid, skinnedMorph]) {
      const once = welded(make()).bytes;
      assert.deepEqual(welded(make()).bytes, once);
      const again = weldGlb(once);
      assert.deepEqual(again, { bytes: once, welded: false, reason: WeldSkip.NothingToWeld });
    }
  });
});

describe("weld: a document the step cannot rewrite safely is left as it was", () => {
  const rows: Array<[string, () => Uint8Array, WeldSkip]> = [
    ["not a GLB", () => new TextEncoder().encode('{"asset":{"version":"2.0"}}'), WeldSkip.UnreadableGeometry],
    [
      "material variants name materials by index",
      () => changed(duplicatedGrid(), (json) => (json.extensionsUsed = ["KHR_materials_variants"])),
      WeldSkip.UnsafeExtension,
    ],
    [
      "an animation pointer names materials by index",
      () => changed(duplicatedGrid(), (json) => (json.extensionsUsed = ["KHR_animation_pointer"])),
      WeldSkip.UnsafeExtension,
    ],
    [
      "Draco data is still compressed",
      () => changed(duplicatedGrid(), (json) => (json.extensionsRequired = ["KHR_draco_mesh_compression"])),
      WeldSkip.UnsafeExtension,
    ],
    [
      "a second, external buffer",
      () => changed(duplicatedGrid(), (json) => json.buffers.push({ uri: "more.bin", byteLength: 4 })),
      WeldSkip.ExternalBuffer,
    ],
    [
      "import LOD extras name views by index",
      () => changed(duplicatedGrid(), (json) => (json.meshes[0].primitives[0].extras = { genex_lods: {} })),
      WeldSkip.ImportExtras,
    ],
    [
      "a sparse attribute",
      () =>
        changed(duplicatedGrid(), (json) => {
          json.accessors[1].sparse = {
            count: 1,
            indices: { bufferView: 3, componentType: 5123 },
            values: { bufferView: 1 },
          };
        }),
      WeldSkip.SparseAccessor,
    ],
    [
      "an attribute naming no accessor",
      () => changed(duplicatedGrid(), (json) => (json.meshes[0].primitives[1].attributes.NORMAL = 99)),
      WeldSkip.UnreadableGeometry,
    ],
    [
      "an accessor past its view",
      () => changed(duplicatedGrid(), (json) => (json.accessors[0].count = 1000)),
      WeldSkip.UnreadableGeometry,
    ],
    [
      "an index past the last vertex",
      () => changed(duplicatedGrid(), (json) => (json.accessors[3].bufferView = json.accessors[0].bufferView)),
      WeldSkip.UnreadableGeometry,
    ],
  ];
  for (const [what, make, reason] of rows) {
    it(`${what}: ${reason}, the same bytes`, () => {
      const input = make();
      const outcome = weldGlb(input);
      assert.deepEqual(outcome, { bytes: input, welded: false, reason });
      assert.equal(outcome.bytes, input);
    });
  }
});

describe("weld: the shared samples", () => {
  it("the LOD sphere's import extras leave it alone", async () => {
    const sphere = await fixture("asset-import", "lods-sphere.glb");
    assert.deepEqual(weldGlb(sphere), { bytes: sphere, welded: false, reason: WeldSkip.ImportExtras });
  });

  for (const [folder, name] of [
    ["asset-previews", "animated.glb"],
    ["asset-import", "quantized.glb"],
    ["asset-import", "quantized.plain.glb"],
  ]) {
    it(`${name}: the output keeps every corner and passes the validator`, async () => {
      const input = await fixture(folder ?? "", name ?? "");
      const outcome = weldGlb(input);
      if (!outcome.welded) {
        assert.equal(outcome.reason, WeldSkip.NothingToWeld);
        return;
      }
      assert.ok(outcome.vertices.after <= outcome.vertices.before);
      assert.deepEqual(corners(outcome.bytes, 0, 0), corners(input, 0, 0));
      await validateGltf(outcome.bytes, "glb");
    });
  }
});

describe("inspect: a GLB's sizes for the receipt", () => {
  it("counts the grid before and after the weld", () => {
    const input = duplicatedGrid();
    const before = inspectGlb(input);
    const after = inspectGlb(welded(input).bytes);
    assert.ok(before && after);
    assert.equal(before.bytes, input.byteLength);
    assert.equal(before.jsonBytes + before.binBytes + 28, before.bytes);
    assert.deepEqual(
      { meshes: before.meshes, primitives: before.primitives, vertices: before.vertices, triangles: before.triangles },
      { meshes: 1, primitives: 2, vertices: 54, triangles: 16 },
    );
    assert.deepEqual(
      { vertices: after.vertices, triangles: after.triangles, materials: after.materials },
      { vertices: 18, triangles: 16, materials: 1 },
    );
    // 54 vertices of 32 bytes and 2x24 16-bit indices, then 18 of 32 (positions twice, the rest once) and 24.
    assert.equal(before.meshBytes, 54 * 32 + 2 * 24 * 2);
    assert.equal(after.meshBytes, 9 * 12 * 3 + 9 * 8 + 24 * 2);
    assert.ok(after.bytes < before.bytes);
  });

  it("counts a skinned file's animation bytes", () => {
    const sizes = inspectGlb(skinnedMorph());
    assert.equal(sizes?.animations, 1);
    assert.equal(sizes?.animationBytes, 2 * 4 + 2 * 16);
  });

  it("is null for bytes that are not a GLB", () => {
    assert.equal(inspectGlb(new Uint8Array([1, 2, 3])), null);
  });

  it("a receipt's sizes read back exactly, and anything else is refused", () => {
    const sizes = inspectGlb(duplicatedGrid());
    assert.ok(sizes);
    assert.deepEqual(parseImportSizes(JSON.parse(JSON.stringify(sizes))), sizes);
    const hostile: unknown[] = [
      null,
      [],
      "sizes",
      { ...sizes, bytes: -1 },
      { ...sizes, vertices: 1.5 },
      { ...sizes, triangles: "16" },
      { ...sizes, meshBytes: Number.NaN },
      { ...sizes, binBytes: 2 ** 53 },
      { ...sizes, extra: 1 },
      Object.fromEntries(Object.entries(sizes).filter(([key]) => key !== ImportSizeKey.Textures)),
    ];
    for (const value of hostile) assert.equal(parseImportSizes(value), null, JSON.stringify(value));
  });
});

describe("weld in the import step: the receipt carries the written GLB's sizes", () => {
  it("a GLB through the step comes out welded, its sizes beside it", async () => {
    const result = await convertAsset({
      converter: ImportConverter.GltfDecompress,
      ext: "glb",
      name: "grid",
      bytes: duplicatedGrid(),
      targets: [BuildTarget.Mac],
    });
    assert.ok(result.ok);
    assert.equal(inspectGlb(result.bytes)?.vertices, 18);
    assert.deepEqual(result.sizes, inspectGlb(result.bytes));
  });

  it("the importer writes the sizes into the receipt, and the host reads them back", async () => {
    const dir = await tmpDir("weld-receipt-");
    await mkdir(path.join(dir, ImportJobLayout.In));
    await mkdir(path.join(dir, ImportJobLayout.Out));
    await writeFile(path.join(dir, "in", "0.glb"), duplicatedGrid());
    const job = {
      version: IMPORT_JOB_VERSION,
      targets: [BuildTarget.Mac],
      files: [
        {
          index: 0,
          input: "in/0.glb",
          ext: "glb",
          converter: ImportConverter.GltfDecompress,
          output: "out/0.glb",
          name: "grid",
        },
      ],
    };
    await writeFile(path.join(dir, ImportJobLayout.Job), JSON.stringify(job));
    assert.equal(await runImportJob(dir), 0);
    const raw = JSON.parse(await readFile(path.join(dir, ImportJobLayout.Out, ImportJobLayout.Receipt), "utf8"));
    const entry = parseImportReceipt(raw)?.files[0];
    assert.ok(entry?.ok);
    const written = new Uint8Array(await readFile(path.join(dir, "out", "0.glb")));
    assert.deepEqual(entry.sizes, inspectGlb(written));
    assert.equal(entry.sizes?.vertices, 18);
  });

  it("a receipt line with sizes the host cannot read is dropped", () => {
    const sizes = inspectGlb(duplicatedGrid());
    const line = { index: 0, ok: true, output: "out/0.glb" };
    const read = (value: unknown) =>
      parseImportReceipt({ version: IMPORT_JOB_VERSION, files: [{ ...line, sizes: value }] });
    assert.deepEqual(read(sizes)?.files, [{ ...line, sizes }]);
    assert.deepEqual(read({ ...sizes, vertices: -1 })?.files, []);
  });
});
