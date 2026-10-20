/**
 * Leaf cards at import (LOD-09): a primitive made of small, open, nearly flat cards keeps every card
 * whole through the attribute-aware simplifier (`lod-cards.ts` finds them, `lods.ts` locks their
 * vertices), alpha-masked or not, as `LockBorder` kept them before LOD-09. Pruning cards (LOD-10) is
 * held back, so a crown of cards alone is not coarser and is delivered as before.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type GltfJson, meshToGlb, readGlb, writeGlb } from "../../src/substrate/asset-import/glb.ts";
import { addLodExtras, LodSkip } from "../../src/substrate/asset-import/lods.ts";

// biome-ignore lint/suspicious/noExplicitAny: fixtures read untyped glTF JSON.
type Json = Record<string, any>;
const SHOWCASE = fileURLToPath(new URL("../../native/genex-rust/examples/showcase/game/assets/", import.meta.url));

/** Cards in the synthetic crown. */
const CROWN_CARDS = 256;
/** Each card's side, in metres. */
const CARD_SIDE = 0.15;
/** The crown's radius about its centre (0, 2, 0). */
const CROWN_RADIUS = 1;

/** A small deterministic stream of numbers in [0, 1) (an LCG; fixtures only). */
function stream(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

/** One card: a quad of four vertices about `centre`, facing `normal`, as positions, normals, UVs. */
interface Card {
  positions: number[];
  normals: number[];
  uvs: number[];
}

/** A quad of side {@link CARD_SIDE} about `centre`, its plane turned by `yaw` and `pitch`. */
function card(centre: readonly number[], yaw: number, pitch: number): Card {
  const right = [Math.cos(yaw), 0, Math.sin(yaw)];
  const up = [-Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch), Math.cos(yaw) * Math.sin(pitch)];
  const normal = [
    right[1] * up[2] - right[2] * up[1],
    right[2] * up[0] - right[0] * up[2],
    right[0] * up[1] - right[1] * up[0],
  ];
  const half = CARD_SIDE / 2;
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  return {
    positions: corners.flatMap(([u = 0, v = 0]) =>
      [0, 1, 2].map((axis) => (centre[axis] ?? 0) + (right[axis] ?? 0) * u * half + (up[axis] ?? 0) * v * half),
    ),
    normals: corners.flatMap(() => normal),
    uvs: corners.flatMap(([u = 0, v = 0]) => [(u + 1) / 2, (1 - v) / 2]),
  };
}

/** The crown's cards, scattered in a ball by `seed`. */
function crownCards(seed = 7, count = CROWN_CARDS): Card[] {
  const next = stream(seed);
  return Array.from({ length: count }, () => {
    const [theta, phi, r] = [next() * Math.PI * 2, Math.acos(2 * next() - 1), CROWN_RADIUS * Math.cbrt(next())];
    const centre = [r * Math.sin(phi) * Math.cos(theta), 2 + r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta)];
    return card(centre, next() * Math.PI * 2, (next() - 0.5) * Math.PI);
  });
}

/** `cards` as one primitive (two triangles per card) on an alpha-masked, double-sided material. */
function crownGlb(cards: readonly Card[]): Uint8Array {
  const indices = cards.flatMap((_, at) => [0, 1, 2, 0, 2, 3].map((corner) => at * 4 + corner));
  const glb = meshToGlb({
    name: "crown",
    materials: [{ name: "leaves", baseColor: [1, 1, 1, 1] }],
    primitives: [
      {
        positions: Float32Array.from(cards.flatMap((each) => each.positions)),
        normals: Float32Array.from(cards.flatMap((each) => each.normals)),
        uvs: Float32Array.from(cards.flatMap((each) => each.uvs)),
        indices: Uint32Array.from(indices),
        material: 0,
      },
    ],
  });
  const { json, bin } = readGlb(glb) as { json: Json; bin: Uint8Array };
  Object.assign(json.materials[0], { alphaMode: "MASK", alphaCutoff: 0.5, doubleSided: true });
  return writeGlb(json, bin);
}

describe("leaf cards stay whole at import (LOD-09)", () => {
  for (const alphaMode of ["MASK", "OPAQUE"]) {
    it(`a ${alphaMode} crown of cards alone keeps every card: not coarser, delivered as before`, async () => {
      const { json, bin } = readGlb(crownGlb(crownCards())) as { json: Json; bin: Uint8Array };
      json.materials[0].alphaMode = alphaMode;
      const glb = writeGlb(json as GltfJson, bin);
      assert.deepEqual(await addLodExtras(glb), { bytes: glb, simplified: false, reason: LodSkip.NotCoarser });
    });
  }

  it("a showcase-style tree whose locked crown outweighs its bark is delivered as before: not coarser", async () => {
    const [wood, leaves] = await Promise.all(
      ["tree-broadleaf-0-lod0-wood.glb", "tree-broadleaf-0-lod0-foliage.glb"].map(async (name) =>
        readGlb(new Uint8Array(await readFile(`${SHOWCASE}${name}`))),
      ),
    );
    const tree = mergeTree(wood as { json: Json; bin: Uint8Array }, leaves as { json: Json; bin: Uint8Array });
    // The chain's length is the largest primitive's; the crown's cards are all locked, so it has
    // none. Pruning cards (LOD-10, held back) is what gives such a tree levels.
    assert.deepEqual(await addLodExtras(tree), { bytes: tree, simplified: false, reason: LodSkip.NotCoarser });
  });
});

/**
 * The showcase's wood and foliage GLBs as one mesh of two primitives: the bark on an opaque
 * material, the crown on an alpha-masked double-sided one (what the showcase sets in code).
 */
function mergeTree(wood: { json: Json; bin: Uint8Array }, leaves: { json: Json; bin: Uint8Array }): Uint8Array {
  const offset = Math.ceil(wood.bin.byteLength / 4) * 4;
  const bin = new Uint8Array(offset + leaves.bin.byteLength);
  bin.set(wood.bin);
  bin.set(leaves.bin, offset);
  const views = [
    ...wood.json.bufferViews,
    ...leaves.json.bufferViews.map((view: Json) => ({ ...view, byteOffset: (view.byteOffset ?? 0) + offset })),
  ];
  const viewBase = wood.json.bufferViews.length;
  const accessorBase = wood.json.accessors.length;
  const accessors = [
    ...wood.json.accessors,
    ...leaves.json.accessors.map((accessor: Json) => ({ ...accessor, bufferView: accessor.bufferView + viewBase })),
  ];
  const shift = (primitive: Json, material: number) => ({
    ...primitive,
    material,
    attributes: Object.fromEntries(
      Object.entries(primitive.attributes as Record<string, number>).map(([key, at]) => [key, at + accessorBase]),
    ),
    indices: primitive.indices + accessorBase,
  });
  const json: Json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "tree" }],
    meshes: [
      {
        name: "tree",
        primitives: [
          { ...wood.json.meshes[0].primitives[0], material: 0 },
          shift(leaves.json.meshes[0].primitives[0], 1),
        ],
      },
    ],
    materials: [
      { name: "bark", pbrMetallicRoughness: { baseColorFactor: [0.4, 0.3, 0.2, 1] } },
      { name: "leaves", alphaMode: "MASK", alphaCutoff: 0.5, doubleSided: true },
    ],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: bin.byteLength }],
  };
  return writeGlb(json as GltfJson, bin);
}
