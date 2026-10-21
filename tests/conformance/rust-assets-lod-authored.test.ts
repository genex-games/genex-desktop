/**
 * Authored levels at import (LOD-11, `src/substrate/asset-import/lod-authored.ts`): a GLB whose
 * host node carries `MSFT_lod` gets its level nodes' meshes as the host primitives' `genex_lods`,
 * each level's screen coverage converted to the object-space error at which the runtime's rule
 * switches to it; the steps that rewrite vertices run between the lift and the fold; a host whose
 * levels do not match is refused with a typed reason and the GLB keeps no private extra.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LODS_EXTRAS_KEY } from "../../src/shared/render-quality.ts";
import { GltfComponent, readGlb, writeGlb } from "../../src/substrate/asset-import/glb.ts";
import {
  AUTHORED_LODS_KEY,
  AuthoredLodSkip,
  coverageError,
  foldAuthoredLods,
  LOD_NOMINAL_HEIGHT_PX,
  liftMsftLod,
  MSFT_LOD,
} from "../../src/substrate/asset-import/lod-authored.ts";
import { readLodSet } from "../../src/substrate/asset-import/lods.ts";
import { reorderGlb } from "../../src/substrate/asset-import/reorder.ts";
import { addTangents } from "../../src/substrate/asset-import/tangents.ts";
import { weldGlb } from "../../src/substrate/asset-import/weld.ts";

type Json = Record<string, any>;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const COVERAGE = [0.5, 0.2, 0.01];

/** A unit UV sphere of `rings` x `segments` quads: positions, normals (the same) and triangles. */
function sphere(rings: number, segments: number): { positions: Float32Array; indices: Uint32Array } {
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
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

interface Level {
  positions: Float32Array;
  indices: Uint32Array;
  /** Leave NORMAL out (an attribute mismatch). */
  noNormal?: boolean;
  /** Split into this many primitives (a parts mismatch when it differs from the host's). */
  parts?: number;
}

/** A GLB of a host node (mesh 0) naming `ids` in MSFT_lod, then one node per further level, the scene holding the host only. */
function msftLodGlb(
  levels: Level[],
  options: { ids?: number[]; coverage?: number[] | null; extraHost?: boolean } = {},
) {
  const chunks: Uint8Array[] = [];
  const views: Json[] = [];
  const accessors: Json[] = [];
  let length = 0;
  const add = (bytes: Uint8Array, target: number, accessor: Json): number => {
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.byteLength, target });
    chunks.push(bytes);
    length += Math.ceil(bytes.byteLength / 4) * 4;
    accessors.push({ ...accessor, bufferView: views.length - 1 });
    return accessors.length - 1;
  };
  const meshes = levels.map((level) => {
    const parts = level.parts ?? 1;
    const per = Math.ceil(level.indices.length / 3 / parts) * 3;
    const count = level.positions.length / 3;
    const min = [0, 1, 2].map((axis) => Math.min(...level.positions.filter((_, at) => at % 3 === axis)));
    const max = [0, 1, 2].map((axis) => Math.max(...level.positions.filter((_, at) => at % 3 === axis)));
    const position = add(new Uint8Array(level.positions.buffer.slice(0)), ARRAY_BUFFER, {
      componentType: GltfComponent.Float,
      type: "VEC3",
      count,
      min,
      max,
    });
    const normal = level.noNormal
      ? null
      : add(new Uint8Array(level.positions.buffer.slice(0)), ARRAY_BUFFER, {
          componentType: GltfComponent.Float,
          type: "VEC3",
          count,
        });
    const primitives = Array.from({ length: parts }, (_, part) => {
      const slice = level.indices.slice(part * per, (part + 1) * per);
      const indices = add(new Uint8Array(slice.buffer.slice(0)), ELEMENT_ARRAY_BUFFER, {
        componentType: GltfComponent.UnsignedInt,
        type: "SCALAR",
        count: slice.length,
      });
      const attributes: Json = { POSITION: position };
      if (normal !== null) attributes.NORMAL = normal;
      return { attributes, indices };
    });
    return { primitives };
  });
  const bin = new Uint8Array(length);
  let cursor = 0;
  for (const chunk of chunks) {
    bin.set(chunk, cursor);
    cursor += Math.ceil(chunk.byteLength / 4) * 4;
  }
  const ids = options.ids ?? levels.slice(1).map((_, at) => at + 1);
  const coverage = options.coverage === undefined ? COVERAGE.slice(0, ids.length + 1) : options.coverage;
  const host: Json = { name: "High_LOD", mesh: 0, extensions: { [MSFT_LOD]: { ids } } };
  if (coverage) host.extras = { MSFT_screencoverage: coverage };
  const nodes: Json[] = [host, ...levels.slice(1).map((_, at) => ({ name: `LOD${at + 1}`, mesh: at + 1 }))];
  if (options.extraHost) nodes[1] = { ...nodes[1], extensions: { [MSFT_LOD]: { ids: [2] } } };
  const json: Json = {
    asset: { version: "2.0" },
    extensionsUsed: [MSFT_LOD],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    meshes,
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: length }],
  };
  return writeGlb(json, bin);
}

const THREE_LEVELS = (): Level[] => [sphere(16, 32), sphere(8, 16), sphere(4, 8)];

/** What a reader finds of the private extra and MSFT_lod anywhere in the JSON. */
function leftovers(json: Json): string[] {
  const text = JSON.stringify(json);
  return [AUTHORED_LODS_KEY, MSFT_LOD, "MSFT_screencoverage"].filter((key) => text.includes(key));
}

/** The runtime's rule (genex-render `select_lod`): the coarsest level whose error projects to at most the threshold. */
function selectLod(errors: number[], distance: number, fovyDeg: number, height = LOD_NOMINAL_HEIGHT_PX): number {
  const pixelsPerUnit = height / (2 * Math.tan(((fovyDeg / 2) * Math.PI) / 180));
  let level = 0;
  errors.forEach((error, at) => {
    if (error * pixelsPerUnit <= distance) level = at + 1;
  });
  return level;
}

/** The camera distance at which a unit sphere's projected disc covers `c` of the view's height squared. */
function distanceAtCoverage(c: number, fovyDeg: number, radius = 1): number {
  const t = Math.tan(((fovyDeg / 2) * Math.PI) / 180);
  return radius / (2 * t * Math.sqrt(c / Math.PI));
}

describe("MSFT_lod levels at import", () => {
  it("an MSFT_lod GLB maps its levels into genex_lods with screen coverage converted to errors", async () => {
    const levels = THREE_LEVELS();
    const lifted = liftMsftLod(msftLodGlb(levels));
    assert.equal(lifted.lifted, 1);
    const folded = await foldAuthoredLods(lifted.bytes);
    assert.ok(folded.authored, JSON.stringify(folded));
    assert.equal(folded.hosts, 1);
    const { json, bin } = readGlb(folded.bytes) as { json: Json; bin: Uint8Array };
    assert.deepEqual(leftovers(json), [], "no MSFT_lod, coverage or private extra is left");
    assert.equal(json.meshes.length, 1, "the level meshes are gone");
    assert.equal(json.nodes[1].mesh, undefined);
    const primitive = json.meshes[0].primitives[0];
    const counts = levels.map((level) => level.positions.length / 3);
    assert.equal(json.accessors[primitive.attributes.POSITION].count, counts[0] + counts[1] + counts[2]);
    assert.equal(json.accessors[primitive.attributes.NORMAL].count, counts[0] + counts[1] + counts[2]);
    const read = readLodSet(json, bin, primitive);
    assert.equal(read.fault, undefined);
    assert.ok(read.set);
    assert.equal(read.set.levels.length, 2);
    assert.equal(read.set.levels[0]?.indices.length, levels[1]?.indices.length);
    assert.equal(read.set.levels[1]?.indices.length, levels[2]?.indices.length);
    assert.equal(
      read.set.levels[0]?.indices[0],
      (levels[1]?.indices[0] ?? 0) + counts[0],
      "level 1 indexes its own appended vertices",
    );
    const radius = 1;
    assert.ok(Math.abs((read.set.levels[0]?.error ?? 0) - coverageError(radius, 0.5)) < 1e-6);
    assert.ok(Math.abs((read.set.levels[1]?.error ?? 0) - coverageError(radius, 0.2)) < 1e-6);
  });

  it("the runtime's rule then switches where the coverage says, whatever the field of view", async () => {
    const folded = await foldAuthoredLods(liftMsftLod(msftLodGlb(THREE_LEVELS())).bytes);
    const { json, bin } = readGlb(folded.bytes) as { json: Json; bin: Uint8Array };
    const errors = readLodSet(json, bin, json.meshes[0].primitives[0]).set?.levels.map((level) => level.error) ?? [];
    for (const fovy of [40, 60, 90]) {
      for (const [at, c] of COVERAGE.slice(0, 2).entries()) {
        const d = distanceAtCoverage(c, fovy);
        assert.equal(selectLod(errors, d * 0.99, fovy), at, `fov ${fovy}: just nearer than coverage ${c}`);
        assert.equal(selectLod(errors, d * 1.01, fovy), at + 1, `fov ${fovy}: just farther than coverage ${c}`);
      }
    }
  });

  it("keeps the levels through weld, tangents and reorder between the lift and the fold", async () => {
    let bytes = liftMsftLod(msftLodGlb(THREE_LEVELS())).bytes;
    bytes = weldGlb(bytes).bytes;
    bytes = (await addTangents(bytes)).bytes;
    bytes = (await reorderGlb(bytes)).bytes;
    const folded = await foldAuthoredLods(bytes);
    assert.ok(folded.authored, JSON.stringify(folded));
    const { json, bin } = readGlb(folded.bytes) as { json: Json; bin: Uint8Array };
    assert.equal(readLodSet(json, bin, json.meshes[0].primitives[0]).set?.levels.length, 2);
    assert.deepEqual(leftovers(json), []);
  });

  it("levels without a usable coverage take how far the base lies from them, never decreasing", async () => {
    for (const coverage of [null, [0.2, 0.5, 0.01], [0.5, 2, 0.1]]) {
      const folded = await foldAuthoredLods(liftMsftLod(msftLodGlb(THREE_LEVELS(), { coverage })).bytes);
      assert.ok(folded.authored, JSON.stringify(coverage));
      const { json, bin } = readGlb(folded.bytes) as { json: Json; bin: Uint8Array };
      const errors = readLodSet(json, bin, json.meshes[0].primitives[0]).set?.levels.map((level) => level.error) ?? [];
      assert.equal(errors.length, 2);
      assert.ok((errors[0] ?? 0) > 0, `${JSON.stringify(coverage)}: ${errors}`);
      assert.ok((errors[1] ?? 0) >= (errors[0] ?? 0), `${JSON.stringify(coverage)}: ${errors}`);
    }
  });
});

describe("MSFT_lod levels that cannot be kept", () => {
  it("is a pure function of its input, and leaves a GLB without MSFT_lod byte for byte", async () => {
    const input = msftLodGlb(THREE_LEVELS());
    const once = await foldAuthoredLods(liftMsftLod(input).bytes);
    const twice = await foldAuthoredLods(liftMsftLod(input).bytes);
    assert.deepEqual(once.bytes, twice.bytes);
    const plain = writeGlb({ asset: { version: "2.0" } }, new Uint8Array(0));
    assert.equal(liftMsftLod(plain).bytes, plain);
    const unchanged = await foldAuthoredLods(plain);
    assert.equal(unchanged.bytes, plain);
    assert.equal(unchanged.authored ? null : unchanged.reason, AuthoredLodSkip.NoAuthoredLevels);
  });

  it("refuses levels that do not match their host with a typed reason, keeping the meshes and no private extra", async () => {
    const [base = sphere(1, 3), one = sphere(1, 3), two = sphere(1, 3)] = THREE_LEVELS();
    const rows: { name: string; glb: Uint8Array; reason: AuthoredLodSkip }[] = [
      {
        name: "a level node that does not exist",
        glb: msftLodGlb([base, one, two], { ids: [1, 99] }),
        reason: AuthoredLodSkip.LevelMissing,
      },
      {
        name: "the host names itself",
        glb: msftLodGlb([base, one, two], { ids: [0, 1] }),
        reason: AuthoredLodSkip.LevelMissing,
      },
      {
        name: "a level named twice",
        glb: msftLodGlb([base, one, two], { ids: [1, 1] }),
        reason: AuthoredLodSkip.LevelMissing,
      },
      {
        name: "a level that is itself a host",
        glb: msftLodGlb([base, one, two], { extraHost: true }),
        reason: AuthoredLodSkip.LevelMissing,
      },
      {
        name: "a level split into other parts",
        glb: msftLodGlb([base, { ...one, parts: 2 }, two]),
        reason: AuthoredLodSkip.PartsMismatch,
      },
      {
        name: "a level without the host's NORMAL",
        glb: msftLodGlb([base, { ...one, noNormal: true }, two]),
        reason: AuthoredLodSkip.AttributesMismatch,
      },
      {
        name: "more levels than the runtime draws",
        glb: msftLodGlb([base, one, two, two, two, two], { coverage: null }),
        reason: AuthoredLodSkip.OverLimit,
      },
      {
        name: "a level finer than the one before",
        glb: msftLodGlb([base, two, one]),
        reason: AuthoredLodSkip.NotCoarser,
      },
    ];
    for (const row of rows) {
      const folded = await foldAuthoredLods(liftMsftLod(row.glb).bytes);
      assert.equal(folded.authored, false, row.name);
      assert.equal(folded.authored ? null : folded.reason, row.reason, row.name);
      const { json } = readGlb(folded.bytes) as { json: Json };
      const before = (readGlb(row.glb).json as Json).meshes.length;
      assert.equal(json.meshes.length, before, `${row.name}: no mesh removed`);
      assert.ok(!JSON.stringify(json).includes(AUTHORED_LODS_KEY), `${row.name}: no private extra left`);
      assert.ok(!JSON.stringify(json).includes(LODS_EXTRAS_KEY), `${row.name}: no levels written`);
    }
  });
});
