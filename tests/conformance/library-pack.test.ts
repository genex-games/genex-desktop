/**
 * The Genex Library pack build's steps (`scripts/library/pack.ts`): a model over its budget is
 * decimated under it by the importer's own simplifier, keeping its silhouette and UVs; one already
 * under it is left byte for byte; levels are baked in so a delivery needs no import work; and each
 * kind's `entry.json` facts carry what the runtime reads (maps per tier, texel density, members,
 * impostor for the big budgets).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decimateGlb,
  glbTriangles,
  materialFacts,
  meanColor,
  modelFacts,
  previewJpeg,
  withLevels,
} from "../../scripts/library/pack.ts";
import {
  LibraryBudget,
  type LibraryEntry,
  LibraryKind,
  LibrarySite,
  LibraryTier,
} from "../../src/shared/genex-library.ts";
import { meshToGlb, readGlb } from "../../src/substrate/asset-import/glb.ts";
import { LODS_EXTRAS_KEY } from "../../src/shared/render-quality.ts";

/** A bumpy `n` x `n` grid of quads over a unit square: 2·n² triangles a simplifier can thin out. */
function bumpyGrid(n: number): Uint8Array {
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let y = 0; y <= n; y++) {
    for (let x = 0; x <= n; x++) {
      positions.push(x / n, 0.05 * Math.sin((x / n) * Math.PI * 3) * Math.cos((y / n) * Math.PI * 2), y / n);
      uvs.push(x / n, y / n);
    }
  }
  const indices: number[] = [];
  const at = (x: number, y: number) => y * (n + 1) + x;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++)
      indices.push(at(x, y), at(x, y + 1), at(x + 1, y), at(x + 1, y), at(x, y + 1), at(x + 1, y + 1));
  }
  return meshToGlb({
    name: "grid",
    primitives: [
      { positions: new Float32Array(positions), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) },
    ],
    materials: [],
  });
}

const source = { site: LibrarySite.PolyHaven, id: "x", page: "https://polyhaven.com/a/x", authors: ["A"] };

describe("Genex Library pack steps", () => {
  it("decimates a model over its budget under it, by the importer's simplifier", async () => {
    const glb = bumpyGrid(80);
    assert.equal(glbTriangles(glb), 12_800);
    const { bytes, triangles } = await decimateGlb(glb, 2_000);
    assert.ok(triangles <= 2_000, `${triangles} triangles`);
    assert.ok(triangles >= 200, `${triangles} triangles keeps a surface, not a sliver`);
    assert.equal(glbTriangles(bytes), triangles);
    const { json } = readGlb(bytes);
    const primitive = (
      json.meshes as Array<{ primitives: Array<{ attributes: Record<string, number>; extras?: unknown }> }>
    )[0]?.primitives[0];
    assert.ok(primitive?.attributes.TEXCOORD_0 !== undefined, "UVs survive");
    assert.equal(primitive?.extras, undefined, "no stale level chain left on the promoted mesh");
  });

  it("cuts a scan of loose triangles (nothing to weld or collapse) under its budget by clustering", async () => {
    // A bumpy sheet whose every corner has its own UV, as a photogrammetry export has: no two vertices merge.
    const n = 60;
    const positions: number[] = [];
    const uvs: number[] = [];
    const point = (x: number, y: number) => [x / n, 0.1 * Math.sin((x / n) * 9) * Math.cos((y / n) * 7), y / n];
    let seed = 1;
    const noise = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        for (const [dx, dy] of [
          [0, 0],
          [0, 1],
          [1, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ] as const) {
          positions.push(...point(x + dx, y + dy));
          uvs.push(noise(), noise());
        }
      }
    }
    const indices = Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
    const soup = meshToGlb({
      name: "soup",
      primitives: [{ positions: new Float32Array(positions), uvs: new Float32Array(uvs), indices }],
      materials: [],
    });
    assert.equal(glbTriangles(soup), 7_200);
    const { bytes, triangles } = await decimateGlb(soup, 1_500);
    assert.ok(triangles <= 1_500 && triangles >= 150, `${triangles} triangles`);
    assert.equal(glbTriangles(bytes), triangles);
  });

  it("leaves a model already within its budget byte for byte", async () => {
    const glb = bumpyGrid(10);
    const { bytes, triangles } = await decimateGlb(glb, 5_000);
    assert.equal(triangles, 200);
    assert.deepEqual(bytes, glb);
  });

  it("bakes the runtime's level chain in, so the import step has nothing left to add", async () => {
    const { bytes, levels } = await withLevels(bumpyGrid(40));
    assert.equal(levels, true);
    const { json } = readGlb(bytes);
    const extras = (json.meshes as Array<{ primitives: Array<{ extras?: Record<string, unknown> }> }>)[0]?.primitives[0]
      ?.extras;
    assert.ok(extras && LODS_EXTRAS_KEY in extras);
  });

  it("writes a material's facts: maps per tier, texel density from its real tile, its mean colour", async () => {
    const entry: LibraryEntry = {
      id: "material/asphalt_02",
      kind: LibraryKind.Material,
      name: "Asphalt 02",
      category: "asphalt",
      tags: ["road"],
      licence: "CC0-1.0",
      source,
      material: { tileMetres: 2, tiers: [LibraryTier.TwoK] },
    };
    const image = {
      width: 2,
      height: 2,
      data: new Uint8Array([10, 20, 30, 255, 30, 40, 50, 255, 10, 20, 30, 255, 30, 40, 50, 255]),
    };
    const maps = { albedo: "albedo.2k.jpg", normal: "normal.2k.jpg", orm: "orm.2k.jpg" };
    const facts = materialFacts(entry, [{ tier: LibraryTier.TwoK, side: 2048, maps }], meanColor(image));
    assert.deepEqual(facts.maps, { "2k": maps });
    assert.deepEqual(facts.texelsPerMetre, { "2k": 1024 });
    assert.deepEqual(facts.baseColor, [20, 30, 40]);
    assert.deepEqual(facts.size, [2, 2, 0]);
    const preview = await previewJpeg(image, 16);
    assert.deepEqual([...preview.subarray(0, 2)], [0xff, 0xd8], "a JPEG");
  });

  it("gives a rock an impostor and a small prop none", () => {
    const rock: LibraryEntry = {
      id: "model/boulder_01",
      kind: LibraryKind.Model,
      name: "Boulder",
      category: "rock",
      tags: ["boulder"],
      licence: "CC0-1.0",
      source,
      model: {
        budget: LibraryBudget.Rock,
        sizeMetres: [1.3, 1, 1.8],
        tier: LibraryTier.TwoK,
        sourceTriangles: 124_000,
      },
    };
    assert.equal(modelFacts(rock, ["model.glb"], 24_000).impostor, true);
    const bench = { ...rock, model: { ...rock.model, budget: LibraryBudget.SmallProp } } as LibraryEntry;
    const facts = modelFacts(bench, ["model.glb"], 630);
    assert.equal(facts.impostor, false);
    assert.deepEqual(facts.members, ["model.glb"]);
    assert.deepEqual(facts.size, [1.3, 1, 1.8]);
  });
});
