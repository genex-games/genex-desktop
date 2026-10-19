// MikkTSpace tangents and vertex order at import (C-8): a primitive whose material has a normal
// texture and no TANGENT gets meshoptimizer's MikkTSpace-compatible tangents, a vertex whose corners
// disagree (a mirrored UV seam) split in two; then every triangle primitive is reordered for the
// vertex cache and vertex fetch. Skins and morph targets come through corner for corner, the LOD and
// meshlet extras written after the chain still validate, the output is byte-stable and passes the
// Khronos validator, and a document a step cannot rewrite comes back as the same bytes with the reason.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { LODS_EXTRAS_KEY, MESHLETS_EXTRAS_KEY } from "../../src/shared/render-quality.ts";
import { convertAsset } from "../../src/substrate/asset-import/convert.ts";
import {
  ARRAY_BUFFER,
  BinWriter,
  ELEMENT_ARRAY_BUFFER,
  GltfComponent,
  meshToGlb,
  readGlb,
  writeGlb,
} from "../../src/substrate/asset-import/glb.ts";
import { ImportConverter } from "../../src/substrate/asset-import/import-plan.ts";
import { readLodSet, validateLodSet } from "../../src/substrate/asset-import/lods.ts";
import { type MeshletSet, readMeshletSet, validateMeshletSet } from "../../src/substrate/asset-import/meshlets.ts";
import { ReorderSkip, reorderGlb } from "../../src/substrate/asset-import/reorder.ts";
import { addTangents, TangentSkip } from "../../src/substrate/asset-import/tangents.ts";
import { GltfIssueCode, GltfIssueSeverity, validateGltf } from "../../src/substrate/asset-import/validate.ts";
import { inwardTriangles } from "../helpers/glb-winding.ts";

// biome-ignore lint/suspicious/noExplicitAny: test fixtures poke at untyped glTF JSON.
type Json = Record<string, any>;
type Typed = Float32Array | Uint8Array | Uint16Array | Uint32Array;

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const IMPORT_FIXTURES = fileURLToPath(new URL("../fixtures/asset-import/", import.meta.url));
const fixture = async (name: string) => new Uint8Array(await readFile(path.join(IMPORT_FIXTURES, name)));
const WIDTH: Readonly<Record<string, number>> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const COMPONENT: ReadonlyMap<unknown, number> = new Map<unknown, number>([
  [Float32Array, GltfComponent.Float],
  [Uint8Array, GltfComponent.UnsignedByte],
  [Uint16Array, GltfComponent.UnsignedShort],
  [Uint32Array, GltfComponent.UnsignedInt],
]);
/** The FIFO vertex cache the ACMR row simulates (meshoptimizer's `analyzeVertexCache` default size). */
const CACHE_SIZE = 16;
/**
 * A 1x1 RGBA PNG of a flat normal (128, 128, 255): the normal map's image, embedded so the
 * validator reads no external file, and one the runtime decodes.
 */
const PNG_1X1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNoaPj/HwAGggL/bOBDIwAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** One accessor of a hand-built fixture. */
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
    min[i % width] = Math.min(min[i % width] ?? 0, value);
    max[i % width] = Math.max(max[i % width] ?? 0, value);
  });
  return { min, max };
}

/** One fixture accessor as a view of its own, vertex data padded to 4-byte elements. */
function viewOf(bin: BinWriter, { data, type, use }: Data): number {
  const element = data.BYTES_PER_ELEMENT * (WIDTH[type] ?? 1);
  const stride = Math.ceil(element / 4) * 4;
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (use === "index") return bin.add(bytes, { target: ELEMENT_ARRAY_BUFFER });
  if (use !== "vertex") return bin.add(bytes);
  if (stride === element) return bin.add(bytes, { target: ARRAY_BUFFER });
  const out = new Uint8Array((bytes.length / element) * stride);
  for (let i = 0; i < bytes.length / element; i++) out.set(bytes.subarray(i * element, (i + 1) * element), i * stride);
  return bin.add(out, { target: ARRAY_BUFFER, byteStride: stride });
}

/** A GLB whose accessors are `accessors` (each in a view of its own) and whose image 0 is {@link PNG_1X1}. */
function glbOf(accessors: Data[], rest: Json): Uint8Array {
  const bin = new BinWriter();
  const json: Json = {
    asset: { version: "2.0" },
    ...rest,
    accessors: accessors.map((item) => ({
      bufferView: viewOf(bin, item),
      componentType: COMPONENT.get(item.data.constructor),
      count: item.data.length / (WIDTH[item.type] ?? 1),
      type: item.type,
      ...(item.normalized ? { normalized: true } : {}),
      ...(item.bounds ? minMax(item.data, WIDTH[item.type] ?? 1) : {}),
    })),
  };
  const image = bin.add(PNG_1X1);
  json.images = [{ bufferView: image, mimeType: "image/png" }];
  const data = bin.bytes();
  return writeGlb({ ...json, bufferViews: bin.views, buffers: [{ byteLength: data.byteLength }] }, data);
}

/** `glb` with one normal-mapped material (texture coordinates `texCoord`) on every primitive. */
function normalMapped(glb: Uint8Array, texCoord = 0): Uint8Array {
  const { json, bin } = readGlb(glb) as { json: Json; bin: Uint8Array };
  const views = [...json.bufferViews];
  const image = views.length;
  const pad = (4 - (bin.byteLength % 4)) % 4;
  views.push({ buffer: 0, byteOffset: bin.byteLength + pad, byteLength: PNG_1X1.byteLength });
  const out = new Uint8Array(bin.byteLength + pad + PNG_1X1.byteLength);
  out.set(bin);
  out.set(PNG_1X1, bin.byteLength + pad);
  json.images = [{ bufferView: image, mimeType: "image/png" }];
  json.textures = [{ source: 0 }];
  json.materials = [{ name: "bumpy", normalTexture: { index: 0, ...(texCoord ? { texCoord } : {}) } }];
  for (const primitive of json.meshes.flatMap((mesh: Json) => mesh.primitives)) primitive.material = 0;
  json.bufferViews = views;
  json.buffers = [{ byteLength: out.byteLength }];
  return writeGlb(json, out);
}

/** A flat 5x3 grid in z = 0, facing +z, its u mirrored at x = 0 (u = |x| / 2): two UV islands sharing a column. */
function mirroredGrid(): Uint8Array {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  for (let y = 0; y < 3; y++) {
    for (let x = -2; x <= 2; x++) {
      positions.push(x, y, 0);
      normals.push(0, 0, 1);
      uvs.push(Math.abs(x) / 2, y / 2);
    }
  }
  const indices: number[] = [];
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 4; x++) {
      const a = y * 5 + x;
      indices.push(a, a + 1, a + 5, a + 1, a + 6, a + 5);
    }
  }
  return meshToGlb({
    name: "grid",
    materials: [],
    primitives: [
      {
        positions: Float32Array.from(positions),
        normals: Float32Array.from(normals),
        uvs: Float32Array.from(uvs),
        indices: Uint32Array.from(indices),
      },
    ],
  });
}

/**
 * A UV sphere of `rings` x `segments` quads as `parts` primitives split by rings; with normals and uvs,
 * or positions only as the LOD golden's sphere (`rust-assets-lods.test.ts`).
 */
function sphereGlb(rings: number, segments: number, parts = 1, shaded = true, mirrored = false): Uint8Array {
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let r = 0; r <= rings; r++) {
    for (let s = 0; s <= segments; s++) {
      const theta = (r / rings) * Math.PI;
      const phi = (s / segments) * Math.PI * 2;
      positions.push(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
      // Mirrored: u runs 1 → 0 → 1 around the sphere, two islands meeting at s = 0 and s = segments / 2.
      uvs.push(mirrored ? Math.abs((2 * s) / segments - 1) : s / segments, r / rings);
    }
  }
  const per = Math.ceil(rings / parts);
  const primitives = Array.from({ length: parts }, (_, part) => {
    const indices: number[] = [];
    for (let r = part * per; r < Math.min(rings, (part + 1) * per); r++) {
      for (let s = 0; s < segments; s++) {
        const a = r * (segments + 1) + s;
        const b = a + segments + 1;
        // Counter-clockwise seen from outside: the sphere faces out.
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const shading = shaded ? { normals: Float32Array.from(positions), uvs: Float32Array.from(uvs) } : {};
    return { positions: Float32Array.from(positions), ...shading, indices: Uint32Array.from(indices) };
  });
  return meshToGlb({ name: "sphere", materials: [], primitives });
}

/** The elements of accessor `at` as numbers, one array per element. */
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

/** A primitive's index stream. */
const indicesOf = (glb: Uint8Array, primitive = 0): number[] => {
  const { json } = readGlb(glb) as { json: Json };
  return elements(glb, json.meshes[0].primitives[primitive].indices).map(([i]) => i ?? 0);
};

/** Each corner of a primitive as every attribute and morph delta it reads, `skip` attributes left out. */
function corners(glb: Uint8Array, primitive = 0, skip: readonly string[] = []): string[] {
  const { json } = readGlb(glb) as { json: Json };
  const prim = json.meshes[0].primitives[primitive];
  const maps: Array<[string, number]> = [
    ...Object.entries(prim.attributes as Record<string, number>).filter(([key]) => !skip.includes(key)),
    ...(prim.targets ?? []).flatMap((target: Record<string, number>, t: number) =>
      Object.entries(target).map(([key, at]): [string, number] => [`target${t}.${key}`, at]),
    ),
  ];
  const streams = maps.map(([key, at]) => [key, elements(glb, at)] as const);
  return indicesOf(glb, primitive).map((i) =>
    streams.map(([key, values]) => `${key}=${values[i]?.join(",")}`).join(" "),
  );
}

/** A primitive's triangles as sorted corner tuples (winding kept by rotation), for order-free equality. */
function triangles(glb: Uint8Array, primitive = 0, skip: readonly string[] = []): string[] {
  const list = corners(glb, primitive, skip);
  const out: string[] = [];
  for (let at = 0; at + 2 < list.length; at += 3) {
    const tri = [list[at] ?? "", list[at + 1] ?? "", list[at + 2] ?? ""];
    const first = tri.indexOf([...tri].sort()[0] ?? "");
    out.push([0, 1, 2].map((k) => tri[(first + k) % 3]).join(" | "));
  }
  return out.sort();
}

/** Average cache misses per triangle of an index stream on a FIFO cache of {@link CACHE_SIZE}. */
function acmr(indices: readonly number[]): number {
  const cache: number[] = [];
  let misses = 0;
  for (const vertex of indices) {
    if (cache.includes(vertex)) continue;
    misses++;
    cache.push(vertex);
    if (cache.length > CACHE_SIZE) cache.shift();
  }
  return misses / (indices.length / 3);
}

const toGlb = async (bytes: Uint8Array, name = "model") => {
  const result = await convertAsset({
    converter: ImportConverter.GltfDecompress,
    ext: "glb",
    name,
    bytes,
    targets: [BuildTarget.Mac],
  });
  assert.ok(result.ok, JSON.stringify(result));
  return result.bytes;
};

const errorsOf = async (glb: Uint8Array) =>
  (await validateGltf(glb, "glb")).filter((issue) => issue.severity === GltfIssueSeverity.Error);

const attributesOf = (glb: Uint8Array, primitive = 0): Json =>
  (readGlb(glb) as { json: Json }).json.meshes[0].primitives[primitive].attributes;

/** The validator's findings that an embedded image does not decode. */
const undecodable = async (glb: Uint8Array) =>
  (await validateGltf(glb, "glb")).filter((issue) => issue.code === GltfIssueCode.ImageDataInvalid);

describe("MikkTSpace tangents at import (C-8)", () => {
  it("a mirrored-UV normal-mapped grid gets one tangent sign per UV island, split at the mirror seam", async () => {
    const out = await toGlb(normalMapped(mirroredGrid()), "grid");
    const attributes = attributesOf(out);
    assert.ok(attributes.TANGENT !== undefined, "the importer writes TANGENT");
    const tangents = elements(out, attributes.TANGENT);
    const positions = elements(out, attributes.POSITION);
    const normals = elements(out, attributes.NORMAL);
    assert.equal(positions.length, 15 + 3, "the three seam vertices split in two, nothing else");
    const indices = indicesOf(out);
    for (let at = 0; at < indices.length; at += 3) {
      const tri = [indices[at], indices[at + 1], indices[at + 2]].map((i) => i ?? 0);
      const centre = tri.reduce((sum, i) => sum + (positions[i]?.[0] ?? 0), 0) / 3;
      const island = centre < 0 ? -1 : 1;
      for (const i of tri) {
        const [x = 0, y = 0, z = 0, w = 0] = tangents[i] ?? [];
        assert.equal(w, island, `corner ${i} of a triangle at x=${centre.toFixed(2)}: sign ${w}`);
        assert.deepEqual([x, y, z], [island, 0, 0], "the tangent follows +u: -x on the mirrored island");
        const [nx = 0, ny = 0, nz = 0] = normals[i] ?? [];
        assert.equal(x * nx + y * ny + z * nz, 0, "orthogonal to the normal");
      }
    }
    const seam = positions.flatMap((p, i) => (p[0] === 0 ? [i] : []));
    assert.equal(seam.length, 6, "each seam position is two vertices");
    assert.deepEqual(new Set(seam.map((i) => tangents[i]?.[3])), new Set([-1, 1]), "one per island");
    assert.deepEqual(await errorsOf(out), []);
  });

  it("the material's texCoord set drives the basis", async () => {
    const { json, bin } = readGlb(normalMapped(mirroredGrid(), 1)) as { json: Json; bin: Uint8Array };
    const primitive = json.meshes[0].primitives[0];
    // TEXCOORD_1 is the mirrored set; TEXCOORD_0 becomes a plain planar one (u = x).
    primitive.attributes.TEXCOORD_1 = primitive.attributes.TEXCOORD_0;
    const planar = Float32Array.from({ length: 30 }, (_, i) => (i % 2 ? Math.floor(i / 10) / 2 : ((i / 2) % 5) - 2));
    const view = json.bufferViews.length;
    json.bufferViews.push({
      buffer: 0,
      byteOffset: bin.byteLength,
      byteLength: planar.byteLength,
      target: ARRAY_BUFFER,
    });
    json.accessors.push({ bufferView: view, componentType: GltfComponent.Float, count: 15, type: "VEC2" });
    primitive.attributes.TEXCOORD_0 = json.accessors.length - 1;
    const data = new Uint8Array(bin.byteLength + planar.byteLength);
    data.set(bin);
    data.set(new Uint8Array(planar.buffer), bin.byteLength);
    json.buffers = [{ byteLength: data.byteLength }];
    const outcome = await addTangents(writeGlb(json, data));
    assert.ok(outcome.generated, JSON.stringify(outcome));
    assert.deepEqual(outcome.vertices, { before: 15, after: 18 }, "split by TEXCOORD_1's mirror, not TEXCOORD_0");
  });

  it("a primitive that has TANGENT, no normal-mapped material or no NORMAL keeps its vertices: typed", async () => {
    const skipped = async (glb: Uint8Array) =>
      assert.deepEqual(await addTangents(glb), { bytes: glb, generated: false, reason: TangentSkip.NothingToGenerate });
    await skipped(mirroredGrid());
    await skipped((await addTangents(normalMapped(mirroredGrid()))).bytes);
    const { json, bin } = readGlb(normalMapped(mirroredGrid())) as { json: Json; bin: Uint8Array };
    // Without NORMAL the runtime derives both normals and tangents, so the step leaves the primitive.
    delete json.meshes[0].primitives[0].attributes.NORMAL;
    await skipped(writeGlb(json, bin));
  });
});

describe("tangents and order keep skins and morph targets (C-8)", () => {
  it("a skinned, morphing normal-mapped primitive keeps every joint, weight and morph delta per corner", async () => {
    const positions = Float32Array.from([-1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 1, 0, 0, 1, 0, 1, 1, 0]);
    const normals = Float32Array.from(Array.from({ length: 6 }, () => [0, 0, 1]).flat());
    const uvs = Float32Array.from([1, 0, 0, 0, 1, 0, 1, 1, 0, 1, 1, 1]);
    const joints = Uint8Array.from(Array.from({ length: 6 }, (_, i) => [0, 1, 2, 3].map((j) => (i + j) % 4)).flat());
    const weights = Float32Array.from(Array.from({ length: 6 }, (_, i) => [0.7, 0.2 - i * 0.01, 0.1, i * 0.01]).flat());
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const delta = Float32Array.from(Array.from({ length: 18 }, (_, i) => i / 100));
    const indices = Uint16Array.from([0, 1, 3, 1, 4, 3, 1, 2, 4, 2, 5, 4]);
    const glb = glbOf(
      [
        { data: positions, type: "VEC3", use: "vertex", bounds: true },
        { data: normals, type: "VEC3", use: "vertex" },
        { data: uvs, type: "VEC2", use: "vertex" },
        { data: joints, type: "VEC4", use: "vertex" },
        { data: weights, type: "VEC4", use: "vertex" },
        { data: delta, type: "VEC3", use: "vertex", bounds: true },
        { data: indices, type: "SCALAR", use: "index" },
        { data: Float32Array.from([...identity, ...identity, ...identity, ...identity]), type: "MAT4" },
      ],
      {
        meshes: [
          {
            primitives: [
              {
                attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, JOINTS_0: 3, WEIGHTS_0: 4 },
                targets: [{ POSITION: 5 }],
                indices: 6,
                material: 0,
              },
            ],
            weights: [0.5],
          },
        ],
        materials: [{ normalTexture: { index: 0 } }],
        textures: [{ source: 0 }],
        nodes: [{ mesh: 0, skin: 0 }, { children: [2, 3, 4] }, {}, {}, {}],
        skins: [{ joints: [1, 2, 3, 4], inverseBindMatrices: 7 }],
        scene: 0,
        scenes: [{ nodes: [0, 1] }],
      },
    );
    const before = triangles(glb);
    const out = await toGlb(glb, "skinned");
    assert.ok(attributesOf(out).TANGENT !== undefined);
    assert.ok(elements(out, attributesOf(out).POSITION).length > 6, "the mirrored column split");
    assert.deepEqual(triangles(out, 0, ["TANGENT"]), before, "every corner reads what it read before");
    assert.deepEqual(await errorsOf(out), []);
  });
});

describe("vertex cache and fetch order at import (C-8)", () => {
  it("ACMR on the golden's sphere is at most 0.9x before, through the import step, every triangle kept", async () => {
    const sphere = sphereGlb(16, 32, 2, false);
    const out = await toGlb(sphere, "sphere");
    for (const primitive of [0, 1]) {
      const was = acmr(indicesOf(sphere, primitive));
      const now = acmr(indicesOf(out, primitive));
      assert.ok(now <= 0.9 * was, `primitive ${primitive}: ACMR ${now.toFixed(3)} after, ${was.toFixed(3)} before`);
      assert.deepEqual(triangles(out, primitive), triangles(sphere, primitive), "same triangles, same winding");
    }
  });

  it("vertices are stored in first-use order, and the reorder is deterministic", async () => {
    const outcome = await reorderGlb(sphereGlb(16, 32));
    assert.ok(outcome.reordered, JSON.stringify(outcome));
    const indices = indicesOf(outcome.bytes);
    let next = 0;
    for (const vertex of indices) {
      assert.ok(vertex <= next, `vertex ${vertex} used before ${next}`);
      if (vertex === next) next++;
    }
    assert.equal(sha((await reorderGlb(sphereGlb(16, 32))).bytes), sha(outcome.bytes));
  });

  it("LOD and meshlet extras written after the chain validate on a normal-mapped sphere", async () => {
    const out = await toGlb(normalMapped(sphereGlb(32, 64)), "sphere");
    const { json, bin } = readGlb(out) as { json: Json; bin: Uint8Array };
    const primitive = json.meshes[0].primitives[0];
    assert.ok(primitive.attributes.TANGENT !== undefined, "tangent-complete");
    assert.ok(primitive.extras?.[LODS_EXTRAS_KEY] && primitive.extras?.[MESHLETS_EXTRAS_KEY], "both extras");
    const vertices = elements(out, primitive.attributes.POSITION).length;
    const lods = readLodSet(json, bin, primitive);
    assert.ok(lods.set, JSON.stringify(lods));
    assert.equal(validateLodSet(lods.set, vertices), null);
    const meshlets = readMeshletSet(json, bin, 0);
    assert.ok(!("fault" in meshlets) && meshlets.set);
    assert.equal(validateMeshletSet(meshlets.set as MeshletSet, indicesOf(out), vertices), null);
    assert.deepEqual(await errorsOf(out), []);
    assert.equal(sha(await toGlb(normalMapped(sphereGlb(32, 64)), "sphere")), sha(out), "byte-stable");
  });
});

describe("the runtime fallback's fixtures (C-9)", () => {
  it("a mirrored-UV normal-mapped sphere and its import are the files the runtime's tangents are held to", async () => {
    const source = normalMapped(sphereGlb(8, 16, 1, true, true));
    assert.equal(sha(source), sha(await fixture("tangents-mirrored.glb")), "the source is this function's output");
    assert.equal(attributesOf(source).TANGENT, undefined, "the source has no tangents: the runtime makes its own");
    const out = await toGlb(source, "tangents-mirrored");
    assert.equal(sha(out), sha(await fixture("tangents-mirrored.imported.glb")), "the importer's tangents");
    const signs = new Set(elements(out, attributesOf(out).TANGENT).map((tangent) => tangent[3]));
    assert.deepEqual(signs, new Set([-1, 1]), "both islands");
    assert.deepEqual(await errorsOf(out), []);
    // GF round 2: the fixture's normal map did not decode and its sphere was wound inward, so the
    // runtime refused the image and drew the sphere inside out.
    for (const [name, glb] of [
      ["the source", source],
      ["the import", out],
    ] as const) {
      assert.deepEqual(await undecodable(glb), [], `${name}'s normal map decodes`);
      assert.equal(inwardTriangles(glb), 0, `every triangle of ${name} faces outward`);
    }
  });

  it("the sphere the rows build faces outward at every size", () => {
    for (const [rings, segments] of [
      [8, 16],
      [16, 32],
      [32, 64],
    ])
      assert.equal(inwardTriangles(sphereGlb(rings, segments)), 0, `${rings} x ${segments}`);
  });
});

describe("documents the steps cannot rewrite: the same bytes and the reason", () => {
  const edit = (glb: Uint8Array, change: (json: Json) => void) => {
    const { json, bin } = readGlb(glb) as { json: Json; bin: Uint8Array };
    change(json);
    return writeGlb(json, bin);
  };
  const base = () => normalMapped(mirroredGrid());
  const hostile: Array<[string, () => Uint8Array, TangentSkip, ReorderSkip]> = [
    [
      "not a GLB",
      () => new TextEncoder().encode("solid nope"),
      TangentSkip.UnreadableGeometry,
      ReorderSkip.UnreadableGeometry,
    ],
    [
      "an external buffer",
      () => edit(base(), (json) => json.buffers.push({ uri: "more.bin", byteLength: 4 })),
      TangentSkip.ExternalBuffer,
      ReorderSkip.ExternalBuffer,
    ],
    [
      "an extension the step does not remap",
      () => edit(base(), (json) => (json.extensionsUsed = ["KHR_materials_variants"])),
      TangentSkip.UnsafeExtension,
      ReorderSkip.UnsafeExtension,
    ],
    [
      "import extras naming views",
      () => edit(base(), (json) => (json.meshes[0].primitives[0].extras = { [LODS_EXTRAS_KEY]: {} })),
      TangentSkip.ImportExtras,
      ReorderSkip.ImportExtras,
    ],
    [
      "an index accessor past its view",
      () => edit(base(), (json) => (json.accessors[json.meshes[0].primitives[0].indices].count += 999)),
      TangentSkip.UnreadableGeometry,
      ReorderSkip.UnreadableGeometry,
    ],
    [
      "an attribute naming accessor 99",
      () => edit(base(), (json) => (json.meshes[0].primitives[0].attributes.COLOR_0 = 99)),
      TangentSkip.UnreadableGeometry,
      ReorderSkip.UnreadableGeometry,
    ],
    [
      "a sparse texture coordinate",
      () =>
        edit(base(), (json) => {
          json.accessors[json.meshes[0].primitives[0].attributes.TEXCOORD_0].sparse = { count: 1 };
        }),
      TangentSkip.SparseAccessor,
      ReorderSkip.SparseAccessor,
    ],
  ];
  for (const [what, make, tangentReason, reorderReason] of hostile) {
    it(`${what}: tangents ${tangentReason}, reorder ${reorderReason}`, async () => {
      const glb = make();
      assert.deepEqual(await addTangents(glb), { bytes: glb, generated: false, reason: tangentReason });
      assert.deepEqual(await reorderGlb(glb), { bytes: glb, reordered: false, reason: reorderReason });
    });
  }

  it("points are left in their order", async () => {
    const points = edit(mirroredGrid(), (json) => {
      json.meshes[0].primitives[0].mode = 0;
      delete json.meshes[0].primitives[0].indices;
    });
    assert.deepEqual(await reorderGlb(points), { bytes: points, reordered: false, reason: ReorderSkip.NoTriangles });
  });
});
