/**
 * Decimation to a triangle budget (WP-0/WP-6): a static GLB heavier than its budget (a 7.85M-triangle
 * Poly Haven fir, a dense Tripo mesh) is simplified to it, every primitive by the same share, its
 * vertices compacted so the file shrinks too; a skinned GLB or one within budget keeps its bytes. The
 * import step runs it before tangents and LODs, so the levels and the impostor start from LOD0 at
 * the budget, and names it on the receipt (`decimated`, `<before>/<after>`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MeshoptSimplifier } from "meshoptimizer";
import { ImportIssueCode } from "../../src/shared/asset-db.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { MODEL_IMPORT_TRIANGLES } from "../../src/shared/model-budget.ts";
import { LODS_EXTRAS_KEY } from "../../src/shared/render-quality.ts";
import { convertAsset } from "../../src/substrate/asset-import/convert.ts";
import { DecimateSkip, decimateGlb } from "../../src/substrate/asset-import/decimate.ts";
import { readGlb, writeGlb } from "../../src/substrate/asset-import/glb.ts";
import { ImportConverter } from "../../src/substrate/asset-import/import-plan.ts";
import { inspectGlb } from "../../src/substrate/asset-import/inspect.ts";
import { readGeometry } from "../../src/substrate/asset-import/meshlets.ts";
import { bumpyGrid } from "../helpers/dense-glb.ts";

type Json = Record<string, any>;

/** Every primitive's triangles, read back. */
function triangles(glb: Uint8Array): number {
  const { json, bin } = readGlb(glb);
  const primitives = (json.meshes as Json[]).flatMap((mesh) => mesh.primitives as Json[]);
  return primitives.reduce((sum, primitive) => sum + (readGeometry(json, bin, primitive)?.indices.length ?? 0) / 3, 0);
}

/** The model's bounds over every POSITION accessor. */
function extent(glb: Uint8Array): { min: number[]; max: number[] } {
  const { json } = readGlb(glb);
  const positions = (json.meshes as Json[])
    .flatMap((mesh) => mesh.primitives as Json[])
    .map((primitive) => (json.accessors as Json[])[primitive.attributes.POSITION]);
  return {
    min: [0, 1, 2].map((axis) => Math.min(...positions.map((accessor) => accessor.min[axis]))),
    max: [0, 1, 2].map((axis) => Math.max(...positions.map((accessor) => accessor.max[axis]))),
  };
}

/** `glb` with a skin on its node and JOINTS_0 named on its first primitive (enough to be a character). */
function skinned(glb: Uint8Array): Uint8Array {
  const { json, bin } = readGlb(glb);
  const copy = structuredClone(json) as Json;
  copy.nodes.push({ name: "root" });
  copy.skins = [{ joints: [copy.nodes.length - 1] }];
  copy.nodes[0].skin = 0;
  copy.meshes[0].primitives[0].attributes.JOINTS_0 = copy.meshes[0].primitives[0].attributes.POSITION;
  return writeGlb(copy, bin);
}

describe("decimating a model to a triangle budget", () => {
  it("brings a dense GLB under budget, every primitive by the same share, and shrinks the file", async () => {
    const dense = bumpyGrid(120);
    assert.equal(triangles(dense), 28_800);
    const outcome = await decimateGlb(dense, 3_000, MeshoptSimplifier);
    assert.ok(outcome.decimated, JSON.stringify(outcome));
    assert.equal(outcome.before, 28_800);
    assert.equal(outcome.after, triangles(outcome.bytes));
    assert.ok(outcome.after <= 3_000 && outcome.after >= 1_500, `${outcome.after} triangles`);
    assert.ok(
      outcome.bytes.byteLength < dense.byteLength / 4,
      `${outcome.bytes.byteLength} of ${dense.byteLength} bytes`,
    );
    const { json, bin } = readGlb(outcome.bytes);
    const parts = (json.meshes as Json[])[0]?.primitives as Json[];
    assert.equal(parts.length, 2, "each primitive kept");
    for (const primitive of parts) {
      const geometry = readGeometry(json, bin, primitive);
      assert.ok(geometry && geometry.indices.length >= 3 * 600, "each primitive keeps its share");
      assert.ok(geometry && Math.max(...geometry.indices) < geometry.positions.length / 3, "indices in range");
      assert.ok(primitive.attributes.NORMAL !== undefined && primitive.attributes.TEXCOORD_0 !== undefined);
    }
    const before = extent(dense);
    const after = extent(outcome.bytes);
    for (const axis of [0, 2]) {
      assert.ok(Math.abs((before.min[axis] ?? 0) - (after.min[axis] ?? 0)) < 1e-4, "the outline stays");
      assert.ok(Math.abs((before.max[axis] ?? 0) - (after.max[axis] ?? 0)) < 1e-4, "the outline stays");
    }
  });

  it("keeps a GLB within budget, a skinned one and unreadable bytes as they are, with the reason", async () => {
    const light = bumpyGrid(10);
    assert.deepEqual(await decimateGlb(light, 1_000, MeshoptSimplifier), {
      bytes: light,
      decimated: false,
      reason: DecimateSkip.WithinBudget,
    });
    const character = skinned(bumpyGrid(60));
    assert.deepEqual(await decimateGlb(character, 1_000, MeshoptSimplifier), {
      bytes: character,
      decimated: false,
      reason: DecimateSkip.Skinned,
    });
    const junk = new Uint8Array([1, 2, 3]);
    assert.deepEqual(await decimateGlb(junk, 1_000, MeshoptSimplifier), {
      bytes: junk,
      decimated: false,
      reason: DecimateSkip.UnreadableGeometry,
    });
  });

  it("is a pure function of the input", async () => {
    const dense = bumpyGrid(80);
    const a = await decimateGlb(dense, 2_000, MeshoptSimplifier);
    const b = await decimateGlb(dense, 2_000, MeshoptSimplifier);
    assert.deepEqual(a.bytes, b.bytes);
  });
});

describe("the import step decimates a model over the import cap", () => {
  const convert = (bytes: Uint8Array, triangleBudget?: number) =>
    convertAsset({
      converter: ImportConverter.GltfDecompress,
      ext: "glb",
      name: "grid",
      bytes,
      targets: [BuildTarget.Mac],
      ...(triangleBudget === undefined ? {} : { triangleBudget }),
    });

  it("imports at the budget with LODs on top, and names the decimation on the receipt", async () => {
    const result = await convert(bumpyGrid(100), 4_000);
    assert.ok(result.ok, JSON.stringify(result));
    const after = triangles(result.bytes);
    assert.ok(after <= 4_000, `${after} triangles`);
    assert.deepEqual(result.report, [{ code: ImportIssueCode.Decimated, detail: `20000/${after}` }]);
    const { json } = readGlb(result.bytes);
    const primitive = (json.meshes as Json[])[0]?.primitives[0] as Json;
    assert.ok(primitive.extras?.[LODS_EXTRAS_KEY], "levels start from the decimated LOD0");
    assert.equal(inspectGlb(result.bytes)?.triangles, after);
  });

  it("leaves a model within the import cap whole, with no issue", async () => {
    const result = await convert(bumpyGrid(40));
    assert.ok(result.ok);
    assert.equal(triangles(result.bytes), 3_200);
    assert.equal(result.report, undefined);
    assert.ok(3_200 < MODEL_IMPORT_TRIANGLES);
  });
});
