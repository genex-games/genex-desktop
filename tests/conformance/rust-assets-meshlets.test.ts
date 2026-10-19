/**
 * R2.3: the import step clusters a big GLB with three's meshoptimizer clusterizer and writes the
 * meshlets into each primitive's `extras.genex_meshlets` (never an extension, never in
 * `extensionsRequired`, so any glTF reader still draws the primitive). The runtime validates the
 * set again at load (`genex-render` `tests/mesh.rs` holds the hostile rows); this file holds the
 * importer's side: valid extras, a determined output, GLBs below the threshold untouched, the
 * odd inputs left alone, and the clusterizer listed with its notice.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { convertAsset } from "../../src/substrate/asset-import/convert.ts";
import { IMPORT_DECODERS, ImportDecoder, meshoptClusterizer } from "../../src/substrate/asset-import/decoders.ts";
import {
  type MeshDocument,
  meshToGlb,
  readGlb as readGltfParts,
  writeGlb,
} from "../../src/substrate/asset-import/glb.ts";
import { ImportConverter } from "../../src/substrate/asset-import/import-plan.ts";
import {
  addMeshletExtras,
  MESHLET_MAX_TRIANGLES,
  MESHLET_MAX_VERTICES,
  MESHLET_MIN_TRIANGLES,
  MESHLET_RECORD_BYTES,
  MESHLET_SCHEMA_VERSION,
  MESHLETS_EXTRAS_KEY,
  MeshletFault,
  type MeshletSet,
  MeshletSkip,
  packTriangle,
  readMeshletSet,
  validateMeshletSet,
} from "../../src/substrate/asset-import/meshlets.ts";

type Json = Record<string, any>;

/** A GLB's JSON (loosely typed for the assertions) and binary chunk. */
function readGlb(bytes: Uint8Array): { json: Json; bin: Uint8Array } {
  return readGltfParts(bytes) as { json: Json; bin: Uint8Array };
}

/** A flat grid of `cells x cells` quads (two triangles each) in the xy plane, facing +z. */
function grid(cells: number, z = 0): MeshDocument["primitives"][number] {
  const side = cells + 1;
  const positions = new Float32Array(side * side * 3);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) positions.set([x * 0.1, y * 0.1, z + 0.01 * Math.sin(x + y)], (y * side + x) * 3);
  }
  const indices: number[] = [];
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const a = y * side + x;
      indices.push(a, a + 1, a + side, a + 1, a + side + 1, a + side);
    }
  }
  return { positions, indices: Uint32Array.from(indices) };
}

const glbOf = (...primitives: MeshDocument["primitives"]) => meshToGlb({ name: "big", primitives, materials: [] });

async function importGlb(bytes: Uint8Array, extra: Partial<Parameters<typeof convertAsset>[0]> = {}) {
  const result = await convertAsset({
    converter: ImportConverter.GltfDecompress,
    ext: "glb",
    name: "big",
    bytes,
    targets: [BuildTarget.Mac],
    ...extra,
  });
  assert.ok(result.ok, "the import step accepts the GLB");
  return result.bytes;
}

/** The first primitive's `genex_meshlets` object. */
function extrasOf(json: Json, primitive = 0): Json | undefined {
  return json.meshes[0].primitives[primitive].extras?.[MESHLETS_EXTRAS_KEY];
}

/** A primitive's triangle list read back from its GLB (u16 or u32 indices). */
function indicesOf(json: Json, bin: Uint8Array, primitive = 0): Uint32Array {
  const accessor = json.accessors[json.meshes[0].primitives[primitive].indices];
  const view = json.bufferViews[accessor.bufferView];
  const raw = new DataView(bin.buffer, bin.byteOffset + (view.byteOffset ?? 0), view.byteLength);
  const wide = accessor.componentType === 5125;
  return Uint32Array.from({ length: accessor.count }, (_, i) =>
    wide ? raw.getUint32(i * 4, true) : raw.getUint16(i * 2, true),
  );
}

describe("R2.3 import-time clusters", () => {
  it("a GLB at or above the threshold carries valid genex_meshlets extras and requires nothing", async () => {
    const source = glbOf(grid(40));
    assert.equal(readGlb(source).json.meshes[0].primitives[0].extras, undefined);
    const out = await importGlb(source);
    const { json, bin } = readGlb(out);
    const extras = extrasOf(json);
    assert.ok(extras, "the primitive has the extras");
    assert.deepEqual(Object.keys(extras), [
      "version",
      "max_vertices",
      "max_triangles",
      "meshlets",
      "vertices",
      "triangles",
    ]);
    assert.equal(extras.version, MESHLET_SCHEMA_VERSION);
    assert.equal(extras.max_vertices, MESHLET_MAX_VERTICES);
    assert.equal(extras.max_triangles, MESHLET_MAX_TRIANGLES);
    assert.equal(json.extensionsRequired, undefined, "a reader that does not know it draws the primitive");
    assert.ok(!(json.extensionsUsed ?? []).includes(MESHLETS_EXTRAS_KEY), "not an extension either");

    const set = readMeshletSet(json, bin, 0);
    assert.ok(!("fault" in set), "the views read back");
    const indices = indicesOf(json, bin);
    assert.equal(validateMeshletSet((set as { set: MeshletSet }).set, indices, 41 * 41), null);
    const meshlets = (set as { set: MeshletSet }).set.meshlets;
    assert.ok(
      meshlets.length >= Math.ceil(indices.length / 3 / MESHLET_MAX_TRIANGLES),
      "enough meshlets to hold the triangles",
    );
    assert.ok(extras.meshlets !== extras.vertices && extras.vertices !== extras.triangles, "three distinct views");
    for (const view of [extras.meshlets, extras.vertices, extras.triangles]) {
      const found = json.bufferViews[view];
      assert.ok(found.byteOffset + found.byteLength <= json.buffers[0].byteLength, "inside the buffer");
      assert.equal(found.byteOffset % 4, 0, "4-byte aligned");
      assert.equal(found.target, undefined, "not a vertex or index view");
    }
    assert.equal(json.bufferViews[extras.meshlets].byteLength, meshlets.length * MESHLET_RECORD_BYTES);
  });

  it("every meshlet's bounds hold its vertices and its cone holds its triangle normals", async () => {
    const out = await importGlb(glbOf(grid(40)));
    const { json, bin } = readGlb(out);
    const read = readMeshletSet(json, bin, 0);
    assert.ok(!("fault" in read));
    const { set } = read as { set: MeshletSet };
    const accessor = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
    const view = json.bufferViews[accessor.bufferView];
    const positions = new Float32Array(bin.slice(view.byteOffset, view.byteOffset + view.byteLength).buffer);
    for (const meshlet of set.meshlets) {
      const [cx, cy, cz, radius] = meshlet.bounds;
      for (const vertex of set.vertices.slice(meshlet.vertexOffset, meshlet.vertexOffset + meshlet.vertexCount)) {
        const d = Math.hypot(
          positions[vertex * 3]! - cx,
          positions[vertex * 3 + 1]! - cy,
          positions[vertex * 3 + 2]! - cz,
        );
        assert.ok(d <= radius * 1.0001 + 1e-5, "the vertex is inside the sphere");
      }
      const [ax, ay, az, cutoff] = meshlet.cone;
      assert.ok(Number.isFinite(ax + ay + az + cutoff) && cutoff <= 1 && cutoff >= -1);
      // The grid faces +z: a viewer in front never sees the meshlet culled by its cone.
      const eye = [cx, cy, cz + 5];
      const to = [cx - eye[0]!, cy - eye[1]!, cz - eye[2]!];
      const length = Math.hypot(...to);
      assert.ok(to[0]! * ax + to[1]! * ay + to[2]! * az < cutoff * length + radius, "seen from the front");
    }
  });

  it("the output is the same bytes every run and importing it again changes nothing", async () => {
    const source = glbOf(grid(40));
    const first = await importGlb(source);
    const second = await importGlb(source);
    assert.deepEqual(first, second);
    assert.deepEqual(await importGlb(first), first, "an imported GLB keeps its extras as they are");
  });

  it("a GLB below the threshold is left as the converter delivered it", async () => {
    const small = glbOf(grid(10));
    const out = await importGlb(small);
    assert.deepEqual(out, small);
    assert.ok(200 < MESHLET_MIN_TRIANGLES);
  });

  it("the threshold is the GLB's triangles together, and a game may lower it", async () => {
    const halves = glbOf(grid(30), grid(30, 1));
    const together = await importGlb(halves);
    assert.ok(
      extrasOf(readGlb(together).json, 0) && extrasOf(readGlb(together).json, 1),
      "1800 + 1800 triangles reach 2048",
    );
    const one = glbOf(grid(30));
    // Renderer pass 2 A6.9 flipped: the import step now adds LODs (512 triangles and up), so the
    // GLB is no longer byte-identical; it still carries no meshlets.
    assert.equal(extrasOf(readGlb(await importGlb(one)).json), undefined, "1800 alone does not");
    const lowered = await importGlb(one, { meshletMinTriangles: 128 });
    assert.ok(extrasOf(readGlb(lowered).json), "a game's lower threshold clusters it");
    const raised = glbOf(grid(40));
    assert.equal(extrasOf(readGlb(await importGlb(raised, { meshletMinTriangles: 1_000_000 })).json), undefined);
  });

  it("a GLB the clusterizer cannot read the geometry of is delivered unchanged, never refused", async () => {
    const { json, bin } = readGlb(glbOf(grid(40)));
    const mutate = (change: (json: Json) => void) => {
      const copy = structuredClone(json);
      change(copy);
      return writeGlb(copy, bin);
    };
    const odd: Array<[string, Uint8Array]> = [
      ["lines", mutate((j) => (j.meshes[0].primitives[0].mode = 1))],
      ["a position accessor that is not float", mutate((j) => (j.accessors[0].componentType = 5122))],
      ["a sparse position accessor", mutate((j) => (j.accessors[0].sparse = { count: 1, indices: {}, values: {} }))],
      ["an index past the vertices", mutate((j) => (j.accessors[0].count = 3))],
      ["a view past the buffer", mutate((j) => (j.bufferViews[0].byteLength = 1 << 30))],
      ["extras that are not an object", mutate((j) => (j.meshes[0].primitives[0].extras = [1]))],
    ];
    for (const [name, bytes] of odd) {
      const out = await importGlb(bytes);
      assert.deepEqual(out, bytes, name);
    }
  });

  it("existing extras are kept beside the meshlets", async () => {
    const { json, bin } = readGlb(glbOf(grid(40)));
    json.meshes[0].primitives[0].extras = { author: "me" };
    const out = await importGlb(writeGlb(json, bin));
    const primitive = readGlb(out).json.meshes[0].primitives[0];
    assert.equal(primitive.extras.author, "me");
    assert.ok(primitive.extras[MESHLETS_EXTRAS_KEY]);
  });

  it("a primitive without indices clusters as the runtime reads it: vertices in order", async () => {
    const { positions, indices } = grid(40);
    const flat = new Float32Array(indices.length * 3);
    indices.forEach((vertex, at) => flat.set(positions.subarray(vertex * 3, vertex * 3 + 3), at * 3));
    const doc: MeshDocument = {
      name: "soup",
      primitives: [{ positions: flat, indices: Uint32Array.from({ length: indices.length }, (_, i) => i) }],
      materials: [],
    };
    const out = await importGlb(meshToGlb(doc));
    const { json, bin } = readGlb(out);
    const read = readMeshletSet(json, bin, 0);
    assert.ok(!("fault" in read));
    assert.equal(
      validateMeshletSet(
        (read as { set: MeshletSet }).set,
        indices.map((_, i) => i),
        flat.length / 3,
      ),
      null,
    );
  });

  it("the clusterizer is a listed decoder with its notice", () => {
    assert.equal(ImportDecoder.MeshoptClusterizer, "meshopt-clusterizer");
    assert.deepEqual(IMPORT_DECODERS[ImportDecoder.MeshoptClusterizer].files, ["meshoptimizer/meshopt_clusterizer.js"]);
    assert.equal(IMPORT_DECODERS[ImportDecoder.MeshoptClusterizer].license, "MIT");
  });

  it("the clusterizer runs offline from its own bytes", async () => {
    const clusterizer = await meshoptClusterizer();
    assert.equal(clusterizer.supported, true);
    const { positions, indices } = grid(8);
    const built = clusterizer.buildMeshlets(indices, positions, 3, MESHLET_MAX_VERTICES, MESHLET_MAX_TRIANGLES, 0.25);
    assert.ok(built.meshletCount >= 1);
  });

  it("addMeshletExtras says why it left a GLB alone", async () => {
    const below = await addMeshletExtras(glbOf(grid(10)));
    assert.deepEqual(below, { bytes: below.bytes, clustered: false, reason: MeshletSkip.BelowThreshold });
    const done = await addMeshletExtras(glbOf(grid(40)));
    assert.equal(done.clustered, true);
    const again = await addMeshletExtras(done.bytes);
    assert.deepEqual(again, { bytes: done.bytes, clustered: false, reason: MeshletSkip.AlreadyClustered });
  });
});

describe("the importer's validator mirrors the runtime's", () => {
  /** A quad as one meshlet, the Rust unit test's own fixture. */
  function quad(): { set: MeshletSet; indices: Uint32Array } {
    return {
      set: {
        meshlets: [
          {
            bounds: [0.5, 0.5, 0, 0.75],
            cone: [0, 0, 1, 1],
            vertexOffset: 0,
            triangleOffset: 0,
            vertexCount: 4,
            triangleCount: 2,
          },
        ],
        vertices: [0, 1, 2, 3],
        triangles: [packTriangle([0, 1, 2]), packTriangle([0, 2, 3])],
      },
      indices: Uint32Array.from([0, 1, 2, 2, 3, 0]),
    };
  }

  it("accepts a set covering its mesh once, with the winding rotated", () => {
    const { set, indices } = quad();
    assert.equal(validateMeshletSet(set, indices, 4), null);
  });

  it("refuses the hostile rows with the runtime's own typed codes", () => {
    const rows: Array<[string, (q: ReturnType<typeof quad>) => void, string]> = [
      ["a range past the buffer", (q) => (q.set.meshlets[0]!.triangleCount = 3), MeshletFault.RangeOutOfBounds],
      ["200 triangles in one meshlet", (q) => (q.set.meshlets[0]!.triangleCount = 200), MeshletFault.OverLimit],
      [
        "overlapping ranges",
        (q) =>
          q.set.meshlets.push({
            ...q.set.meshlets[0]!,
            vertexOffset: 2,
            triangleOffset: 1,
            vertexCount: 2,
            triangleCount: 1,
          }),
        MeshletFault.RangesNotTiled,
      ],
      ["a vertex past the mesh", (q) => (q.set.vertices[3] = 9), MeshletFault.VertexOutOfMesh],
      [
        "a local index past the meshlet",
        (q) => (q.set.triangles[1] = packTriangle([0, 2, 4])),
        MeshletFault.LocalIndexOutOfMeshlet,
      ],
      ["a flipped winding", (q) => (q.set.triangles[1] = packTriangle([0, 3, 2])), MeshletFault.TrianglesDiffer],
      [
        "a triangle twice and another never",
        (q) => (q.set.triangles[1] = packTriangle([1, 2, 0])),
        MeshletFault.TrianglesDiffer,
      ],
    ];
    for (const [name, change, fault] of rows) {
      const q = quad();
      change(q);
      assert.equal(validateMeshletSet(q.set, q.indices, 4), fault, name);
    }
  });
});
