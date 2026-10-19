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
import { meshToGlb, readGlb, writeGlb } from "../../src/substrate/asset-import/glb.ts";
import { ImportConverter } from "../../src/substrate/asset-import/import-plan.ts";
import { addLodExtras, LodSkip, readLodSet, validateLodSet } from "../../src/substrate/asset-import/lods.ts";

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
    return [a, b, a + 1, a + 1, b, b + 1];
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
  });
});
