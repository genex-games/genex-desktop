/**
 * Import-time LODs (renderer pass 2, A6.9): a GLB of at least `LOD_MIN_TRIANGLES` triangles gets
 * `extras.genex_lods` on every primitive, levels simplified from the primitive's own triangles by
 * meshoptimizer's simplifier (npm `meshoptimizer` 1.3.0, `decoders.ts`), coarser and coarser, each with its
 * object-space error. Never an extension: any glTF reader still draws the primitive whole, and
 * the runtime validates the levels again (genex-render `tests/glb_lods.rs` loads the golden below).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  LOD_MAX_LEVELS,
  LOD_MIN_TRIANGLES,
  LOD_SCHEMA_VERSION,
  LodExtrasKey,
  LodFault,
  LodLevelKey,
  LODS_EXTRAS_KEY,
} from "../../src/shared/render-quality.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { convertAsset } from "../../src/substrate/asset-import/convert.ts";
import { GltfComponent, meshToGlb, readGlb, writeGlb } from "../../src/substrate/asset-import/glb.ts";
import { ImportConverter } from "../../src/substrate/asset-import/import-plan.ts";
import {
  addLodExtras,
  type LodSet,
  LodSkip,
  readLodSet,
  validateLodSet,
} from "../../src/substrate/asset-import/lods.ts";
import { inwardTriangles } from "../helpers/glb-winding.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Json = Record<string, any>;

/** A UV sphere of `rings` x `segments` quads as one primitive (or `parts` primitives splitting it by rings). */
function sphereGlb(rings: number, segments: number, parts = 1): Uint8Array {
  const positions: number[] = [];
  for (let r = 0; r <= rings; r++) {
    for (let s = 0; s <= segments; s++) {
      const theta = (r / rings) * Math.PI;
      const phi = (s / segments) * Math.PI * 2;
      positions.push(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
    }
  }
  const quad = (r: number, s: number) => {
    const a = r * (segments + 1) + s;
    const b = a + segments + 1;
    // Counter-clockwise seen from outside: the sphere faces out.
    return [a, a + 1, b, a + 1, b + 1, b];
  };
  const per = Math.ceil(rings / parts);
  const primitives = Array.from({ length: parts }, (_, part) => {
    const indices: number[] = [];
    for (let r = part * per; r < Math.min(rings, (part + 1) * per); r++)
      for (let s = 0; s < segments; s++) indices.push(...quad(r, s));
    return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
  });
  return meshToGlb({ name: "sphere", materials: [], primitives });
}

/** The sphere's vertices as {@link sphereGlb} lays them out. */
function spherePositions(rings: number, segments: number): Float32Array {
  const positions: number[] = [];
  for (let r = 0; r <= rings; r++) {
    for (let s = 0; s <= segments; s++) {
      const theta = (r / rings) * Math.PI;
      const phi = (s / segments) * Math.PI * 2;
      positions.push(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi));
    }
  }
  return Float32Array.from(positions);
}

/** The sphere's triangles as {@link sphereGlb} winds them, one primitive. */
function sphereIndices(rings: number, segments: number): Uint32Array {
  const indices: number[] = [];
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s;
      const b = a + segments + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  return Uint32Array.from(indices);
}

/** Cells per side of the UV-seamed plane. */
const PLANE_CELLS = 64;

/**
 * A flat unit plane of {@link PLANE_CELLS}² cells as two UV islands that meet at x = 0.5, the seam
 * vertices doubled: the left island's u grows with x², the right one's v with y², so a collapse
 * across the stretched direction moves the texture while one along the other does not.
 */
function uvSeamedPlane(): { positions: Float32Array; uvs: Float32Array; indices: Uint32Array; glb: Uint8Array } {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const island = (from: number, to: number, map: (x: number, y: number) => [number, number]) => {
    const base = positions.length / 3;
    const width = to - from;
    for (let row = 0; row <= PLANE_CELLS; row++) {
      for (let column = 0; column <= width; column++) {
        const x = (from + column) / PLANE_CELLS;
        const y = row / PLANE_CELLS;
        positions.push(x, y, 0);
        normals.push(0, 0, 1);
        uvs.push(...map(x, y));
      }
    }
    for (let row = 0; row < PLANE_CELLS; row++) {
      for (let column = 0; column < width; column++) {
        const a = base + row * (width + 1) + column;
        const b = a + width + 1;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  };
  island(0, PLANE_CELLS / 2, (x, y) => [0.5 * (2 * x) ** 2, y]);
  island(PLANE_CELLS / 2, PLANE_CELLS, (x, y) => [x, y * y]);
  const primitive = {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
  };
  return { ...primitive, glb: meshToGlb({ name: "plane", materials: [], primitives: [primitive] }) };
}

/**
 * The largest texture-coordinate error of `level` over the plane: at every original triangle's
 * centroid, the level's interpolated UV against the original's (the plane is flat, so the level
 * triangle under a centroid is found in xy). Infinity when a centroid has no level triangle.
 */
function uvStretch(plane: ReturnType<typeof uvSeamedPlane>, level: Uint32Array): number {
  const { positions: p, uvs: t, indices } = plane;
  let worst = 0;
  for (let at = 0; at < indices.length; at += 3) {
    const corners = [indices[at] ?? 0, indices[at + 1] ?? 0, indices[at + 2] ?? 0];
    const mean = (values: Float32Array, stride: number, axis: number) =>
      corners.reduce((sum, vertex) => sum + (values[vertex * stride + axis] ?? 0), 0) / 3;
    const [x, y, u, v] = [mean(p, 3, 0), mean(p, 3, 1), mean(t, 2, 0), mean(t, 2, 1)];
    let error = Number.POSITIVE_INFINITY;
    for (let k = 0; k < level.length && error === Number.POSITIVE_INFINITY; k += 3) {
      const [a, b, c] = [level[k] ?? 0, level[k + 1] ?? 0, level[k + 2] ?? 0];
      const [ax, ay, bx, by, cx, cy] = [p[a * 3], p[a * 3 + 1], p[b * 3], p[b * 3 + 1], p[c * 3], p[c * 3 + 1]].map(
        (value) => value ?? 0,
      ) as [number, number, number, number, number, number];
      const area = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(area) < 1e-12) continue;
      const wa = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / area;
      const wb = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / area;
      const wc = 1 - wa - wb;
      if (Math.min(wa, wb, wc) < -1e-6) continue;
      const lu = wa * (t[a * 2] ?? 0) + wb * (t[b * 2] ?? 0) + wc * (t[c * 2] ?? 0);
      const lv = wa * (t[a * 2 + 1] ?? 0) + wb * (t[b * 2 + 1] ?? 0) + wc * (t[c * 2 + 1] ?? 0);
      error = Math.hypot(lu - u, lv - v);
    }
    worst = Math.max(worst, error);
  }
  return worst;
}

type Vec3 = [number, number, number];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const along = (a: Vec3, d: Vec3, s: number): Vec3 => [a[0] + d[0] * s, a[1] + d[1] * s, a[2] + d[2] * s];
const distance = (a: Vec3, b: Vec3) => Math.hypot(...sub(a, b));

/** The distance from `p` to triangle `abc` (Ericson, Real-Time Collision Detection 5.1.5). */
function pointTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const [d1, d2] = [dot(ab, sub(p, a)), dot(ac, sub(p, a))];
  if (d1 <= 0 && d2 <= 0) return distance(p, a);
  const [d3, d4] = [dot(ab, sub(p, b)), dot(ac, sub(p, b))];
  if (d3 >= 0 && d4 <= d3) return distance(p, b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return distance(p, along(a, ab, d1 / (d1 - d3)));
  const [d5, d6] = [dot(ab, sub(p, c)), dot(ac, sub(p, c))];
  if (d6 >= 0 && d5 <= d6) return distance(p, c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return distance(p, along(a, ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return distance(p, along(b, sub(c, b), (d4 - d3) / (d4 - d3 + d5 - d6)));
  const sum = va + vb + vc;
  return distance(p, along(along(a, ab, vb / sum), ac, vc / sum));
}

/** How far the farthest of `positions`' vertices lies from the surface of `level` (brute force). */
function vertexDeviation(positions: Float32Array, level: Uint32Array): number {
  const at = (vertex: number): Vec3 => [
    positions[vertex * 3] ?? 0,
    positions[vertex * 3 + 1] ?? 0,
    positions[vertex * 3 + 2] ?? 0,
  ];
  let worst = 0;
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    let nearest = Number.POSITIVE_INFINITY;
    for (let k = 0; k < level.length; k += 3)
      nearest = Math.min(
        nearest,
        pointTriangle(at(vertex), at(level[k] ?? 0), at(level[k + 1] ?? 0), at(level[k + 2] ?? 0)),
      );
    worst = Math.max(worst, nearest);
  }
  return worst;
}

/** Joints per vertex in the skinned fixture. */
const INFLUENCES = 4;

/**
 * {@link sphereGlb} skinned: `JOINTS_0` (u8) bends the top half to joint 1 and the bottom to joint 0,
 * `WEIGHTS_0` (float) blends them by height, appended to the binary chunk.
 */
function skinnedSphereGlb(rings: number, segments: number): Uint8Array {
  const { json, bin } = readGlb(sphereGlb(rings, segments)) as { json: Json; bin: Uint8Array };
  const positions = spherePositions(rings, segments);
  const count = positions.length / 3;
  const joints = new Uint8Array(count * INFLUENCES);
  const weights = new Float32Array(count * INFLUENCES);
  for (let vertex = 0; vertex < count; vertex++) {
    const up = ((positions[vertex * 3 + 1] ?? 0) + 1) / 2;
    joints.set([0, 1, 0, 0], vertex * INFLUENCES);
    weights.set([1 - up, up, 0, 0], vertex * INFLUENCES);
  }
  const start = Math.ceil(bin.byteLength / 4) * 4;
  const out = new Uint8Array(start + joints.byteLength + weights.byteLength);
  out.set(bin);
  out.set(joints, start);
  out.set(new Uint8Array(weights.buffer), start + joints.byteLength);
  json.bufferViews.push(
    { buffer: 0, byteOffset: start, byteLength: joints.byteLength },
    { buffer: 0, byteOffset: start + joints.byteLength, byteLength: weights.byteLength },
  );
  const view = json.bufferViews.length - 2;
  json.accessors.push(
    { bufferView: view, componentType: GltfComponent.UnsignedByte, count, type: "VEC4" },
    { bufferView: view + 1, componentType: GltfComponent.Float, count, type: "VEC4" },
  );
  const attributes = json.meshes[0].primitives[0].attributes;
  attributes.JOINTS_0 = json.accessors.length - 2;
  attributes.WEIGHTS_0 = json.accessors.length - 1;
  json.buffers[0].byteLength = out.byteLength;
  return writeGlb(json, out);
}

/** The first primitive's level set of `glb`, which must have one. */
function levelsOf(glb: Uint8Array): { json: Json; bin: Uint8Array; set: LodSet } {
  const { json, bin } = readGlb(glb) as { json: Json; bin: Uint8Array };
  const read = readLodSet(json, bin, json.meshes[0].primitives[0]);
  assert.ok(read.set, JSON.stringify(read));
  return { json, bin, set: read.set };
}

/** The bound on level 1's texture shift: half a texel of a 1024² texture. */
const UV_STRETCH_BOUND = 1 / 2048;

describe("import-time LODs (genex_lods)", () => {
  it("a sphere above the threshold gets coarser levels with growing error, every index in range", async () => {
    const glb = sphereGlb(32, 64);
    const outcome = await addLodExtras(glb);
    assert.ok(outcome.simplified, JSON.stringify(outcome));
    const { json, bin } = readGlb(outcome.bytes) as { json: Json; bin: Uint8Array };
    const primitive = json.meshes[0].primitives[0];
    const extras = primitive.extras[LODS_EXTRAS_KEY];
    assert.deepEqual(Object.keys(extras), Object.values(LodExtrasKey));
    assert.equal(extras.version, LOD_SCHEMA_VERSION);
    assert.ok(extras.levels.length >= 2 && extras.levels.length <= LOD_MAX_LEVELS, `${extras.levels.length} levels`);
    for (const level of extras.levels) assert.deepEqual(Object.keys(level), Object.values(LodLevelKey));
    const set = readLodSet(json, bin, primitive);
    assert.ok(set.set, JSON.stringify(set));
    const full = 32 * 64 * 2;
    const counts = set.set.levels.map((level) => level.indices.length / 3);
    assert.ok(
      counts.every((count, at) => count < (at === 0 ? full : (counts[at - 1] ?? 0))),
      `coarser: ${counts}`,
    );
    assert.ok((counts.at(-1) ?? full) <= full / 4, `the last level drops at least three quarters: ${counts}`);
    const errors = set.set.levels.map((level) => level.error);
    assert.ok(
      errors.every((error, at) => Number.isFinite(error) && error >= (errors[at - 1] ?? 0)),
      `${errors}`,
    );
    assert.ok((errors.at(-1) ?? 1) < 0.2, "a unit sphere's coarsest level stays within a fifth of its radius");
    assert.equal(validateLodSet(set.set, 33 * 65), null);
    assert.equal(sha((await addLodExtras(glb)).bytes), sha(outcome.bytes), "deterministic");
  });

  it("every primitive of a split mesh gets the same number of levels", async () => {
    const outcome = await addLodExtras(sphereGlb(32, 64, 3));
    assert.ok(outcome.simplified);
    const { json, bin } = readGlb(outcome.bytes) as { json: Json; bin: Uint8Array };
    const lengths = json.meshes[0].primitives.map(
      (primitive: Json) => readLodSet(json, bin, primitive).set?.levels.length,
    );
    assert.equal(new Set(lengths).size, 1, `${lengths}`);
    assert.ok((lengths[0] ?? 0) >= 1);
  });

  it("below the threshold, already simplified, or foreign extras: delivered unchanged, typed", async () => {
    const small = sphereGlb(8, 16);
    assert.ok(8 * 16 * 2 < LOD_MIN_TRIANGLES);
    assert.deepEqual(await addLodExtras(small), { bytes: small, simplified: false, reason: LodSkip.BelowThreshold });
    const once = (await addLodExtras(sphereGlb(32, 64))).bytes;
    assert.deepEqual(await addLodExtras(once), { bytes: once, simplified: false, reason: LodSkip.AlreadySimplified });
    const { json, bin } = readGlb(sphereGlb(32, 64)) as { json: Json; bin: Uint8Array };
    json.meshes[0].primitives[0].extras = "not an object";
    const foreign = writeGlb(json, bin);
    assert.deepEqual(await addLodExtras(foreign), {
      bytes: foreign,
      simplified: false,
      reason: LodSkip.UnreadableGeometry,
    });
  });

  const hostile: Array<[string, LodFault, (extras: Json) => void]> = [
    ["another version", LodFault.UnknownVersion, (extras) => (extras.version = 99)],
    [
      "too many levels",
      LodFault.OverLimit,
      (extras) => (extras.levels = Array(LOD_MAX_LEVELS + 1).fill(extras.levels[0])),
    ],
    ["a view past the buffer", LodFault.RangeOutOfBounds, (extras) => (extras.indices = 999)],
    ["a level past its view", LodFault.RangeOutOfBounds, (extras) => (extras.levels[0].count = 1e9)],
    ["a level that is not whole triangles", LodFault.NotCoarser, (extras) => (extras.levels[0].count -= 1)],
    ["a finer level after a coarser one", LodFault.NotCoarser, (extras) => extras.levels.reverse()],
    ["a negative error", LodFault.NotCoarser, (extras) => (extras.levels[0].error = -1)],
  ];
  for (const [what, fault, damage] of hostile) {
    it(`extras with ${what} are refused ${fault}`, async () => {
      const { json, bin } = readGlb((await addLodExtras(sphereGlb(32, 64))).bytes) as { json: Json; bin: Uint8Array };
      const primitive = json.meshes[0].primitives[0];
      damage(primitive.extras[LODS_EXTRAS_KEY]);
      assert.equal(readLodSet(json, bin, primitive).fault, fault);
    });
  }

  it("a converted model carries its levels, and the runtime's golden is this output", async () => {
    const result = await convertAsset({
      converter: ImportConverter.GltfDecompress,
      ext: "glb",
      name: "sphere",
      bytes: sphereGlb(16, 32, 2),
      targets: [BuildTarget.Mac],
    });
    assert.ok(result.ok);
    const { json } = readGlb(result.bytes) as { json: Json };
    for (const primitive of json.meshes[0].primitives)
      assert.ok(primitive.extras?.[LODS_EXTRAS_KEY], "levels on every primitive");
    const golden = new Uint8Array(await readFile(path.join(FIXTURES, "asset-import", "lods-sphere.glb")));
    assert.equal(sha(result.bytes), sha(golden), "genex-render tests/glb_lods.rs loads this file");
    // GF round 2: the golden was wound inward, so the runtime drew it inside out.
    for (const primitive of [0, 1])
      assert.equal(inwardTriangles(golden, primitive), 0, `primitive ${primitive} faces outward`);
  });
});

describe("attribute-aware chains (LOD-09)", () => {
  it("a UV-seamed plane's level 1 moves its texture by at most half a texel", async () => {
    const plane = uvSeamedPlane();
    const outcome = await addLodExtras(plane.glb);
    assert.ok(outcome.simplified, JSON.stringify(outcome));
    const level = levelsOf(outcome.bytes).set.levels[0];
    assert.ok(level, "a first level");
    assert.ok(level.indices.length < plane.indices.length, "level 1 is coarser");
    const stretch = uvStretch(plane, level.indices);
    assert.ok(stretch <= UV_STRETCH_BOUND, `level 1 UV stretch ${stretch} over ${UV_STRETCH_BOUND}`);
  });

  it("every level's error is object-space and at least how far the mesh's vertices lie from it", async () => {
    const outcome = await addLodExtras(sphereGlb(32, 64));
    assert.ok(outcome.simplified);
    const positions = spherePositions(32, 64);
    for (const [at, level] of levelsOf(outcome.bytes).set.levels.entries()) {
      const deviation = vertexDeviation(positions, level.indices);
      assert.ok(level.error >= Math.fround(deviation), `level ${at + 1}: error ${level.error} under ${deviation}`);
    }
    // A node scale belongs to the runtime: the same sphere at twice the size has twice the errors.
    const doubled = await addLodExtras(
      meshToGlb({
        name: "sphere",
        materials: [],
        primitives: [{ positions: positions.map((value) => value * 2), indices: sphereIndices(32, 64) }],
      }),
    );
    const [one, two] = [levelsOf(outcome.bytes).set.levels, levelsOf(doubled.bytes).set.levels];
    assert.equal(two.length, one.length);
    for (const [at, level] of one.entries())
      assert.ok(Math.abs((two[at]?.error ?? 0) - level.error * 2) <= level.error * 1e-3, `level ${at + 1} scales`);
  });

  it("the output is a pure function of the input", async () => {
    for (const glb of [uvSeamedPlane().glb, skinnedSphereGlb(32, 64), sphereGlb(32, 64, 3)]) {
      const [first, second] = [await addLodExtras(glb), await addLodExtras(glb.slice())];
      assert.ok(first.simplified);
      assert.equal(sha(second.bytes), sha(first.bytes));
    }
  });

  it("a skinned sphere's levels keep JOINTS_0 and WEIGHTS_0 for every vertex they draw", async () => {
    const glb = skinnedSphereGlb(32, 64);
    const before = readGlb(glb) as { json: Json; bin: Uint8Array };
    const outcome = await addLodExtras(glb);
    assert.ok(outcome.simplified, JSON.stringify(outcome));
    const { json, bin, set } = levelsOf(outcome.bytes);
    const attributes = json.meshes[0].primitives[0].attributes;
    const accessorBytes = (doc: { json: Json; bin: Uint8Array }, at: number) => {
      const accessor = doc.json.accessors[at];
      const view = doc.json.bufferViews[accessor.bufferView];
      return doc.bin.subarray(view.byteOffset, view.byteOffset + view.byteLength);
    };
    for (const key of ["JOINTS_0", "WEIGHTS_0"]) {
      assert.equal(json.accessors[attributes[key]].count, json.accessors[attributes.POSITION].count, key);
      const was = before.json.meshes[0].primitives[0].attributes[key];
      assert.deepEqual(accessorBytes({ json, bin }, attributes[key]), accessorBytes(before, was), `${key} unchanged`);
    }
    assert.ok(set.levels.length >= 2, `${set.levels.length} levels`);
    assert.equal(validateLodSet(set, json.accessors[attributes.POSITION].count), null);
  });
});
