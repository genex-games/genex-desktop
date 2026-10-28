/**
 * Decimation to a triangle budget (WP-0/WP-6): a static GLB with more triangles than its budget
 * (a 7.85M-triangle Poly Haven fir, a dense Tripo mesh) is simplified to it, so LOD0 starts at the
 * budget, the import step's levels (`lods.ts`) halve it from there and a far copy draws as its
 * impostor. Two places run it: the import step, before tangents, at the import cap
 * (`MODEL_IMPORT_TRIANGLES`), and `cc0__fetch` at the tier an agent names, so a heavy CC0 model
 * reaches the game folder already light.
 *
 * Every primitive keeps the same share of its triangles. Each is simplified by meshoptimizer's
 * attribute-aware simplifier (normals and UV0 weighed beside positions, vertices where primitives
 * meet locked, a double-sided material's folds kept, the error unbounded so the budget wins); one
 * that cannot get there that way (locked seams, thousands of separate needles) is finished by its
 * sloppy simplifier on the same vertices. Leaf cards are not locked here, unlike the LOD step: a
 * budget is a ceiling, and cards that stay whole would keep a crown over it. Each primitive's
 * vertices are then compacted to the ones its triangles still use, so the file shrinks with it.
 *
 * Skinned GLBs are left alone (a character's budget is its generator's polycount), and so is
 * anything the vertex steps cannot rewrite (the weld step's rules). The simplifier is a parameter:
 * the importer passes its pinned module, a plugin backend the npm package. The output is a pure
 * function of the input.
 */
import { MeshoptSimplifyFlag } from "./decoders.ts";
import { isObject, type Json } from "./gltf-json.ts";
import { type SimplifyInput, simplifyInputs } from "./lods.ts";
import { type Geometry, readGeometry } from "./meshlets.ts";
import { dedupAccessors, primitivesOf, pruneAccessors, packGlb, type PackDoc, WeldSkipped } from "./prune.ts";
import { rebuildPrimitive, rewriteBlocker, tryOpenDoc } from "./reorder.ts";

/** Why {@link decimateGlb} returned the GLB as it was. Wire values: never rename one. */
export const DecimateSkip = {
  /** Its triangles are at or under the budget. */
  WithinBudget: "within-budget",
  /** It has a skinned mesh: a character keeps the polycount its generator gave it. */
  Skinned: "skinned",
  /** It is not a GLB the vertex steps can rewrite (the weld step's rules), or has no triangle list. */
  UnreadableGeometry: "unreadable-geometry",
} as const;
export type DecimateSkip = (typeof DecimateSkip)[keyof typeof DecimateSkip];

/** What {@link decimateGlb} did. */
export type DecimateOutcome =
  | { bytes: Uint8Array; decimated: true; before: number; after: number }
  | { bytes: Uint8Array; decimated: false; reason: DecimateSkip };

/** The parts of meshoptimizer's simplifier the decimation calls: the importer's pinned module or the npm package. */
export interface DecimateSimplifier {
  ready: Promise<void>;
  simplifyWithAttributes(
    indices: Uint32Array,
    vertexPositions: Float32Array,
    vertexPositionsStride: number,
    vertexAttributes: Float32Array,
    vertexAttributesStride: number,
    attributeWeights: number[],
    vertexLock: Uint8Array | null,
    targetIndexCount: number,
    targetError: number,
    flags?: MeshoptSimplifyFlag[],
  ): [Uint32Array, number];
  simplifySloppy(
    indices: Uint32Array,
    vertexPositions: Float32Array,
    vertexPositionsStride: number,
    vertexLock: Uint8Array | null,
    targetIndexCount: number,
    targetError: number,
  ): [Uint32Array, number];
}

const TRIANGLE = 3;
/** The error the attribute-aware pass may reach, relative to the mesh's extent: unbounded, the budget decides. */
const UNBOUNDED_ERROR = 1;
/** A primitive the attribute-aware pass leaves this far over its share goes on to the sloppy pass. */
const SHARE_SLACK = 1.05;
/** The fewest triangles a primitive keeps (or all of its own when it has fewer). */
const MIN_PRIMITIVE_TRIANGLES = 4;
const JOINTS_0 = "JOINTS_0";

const isSkinned = (json: Json, primitives: Json[]): boolean =>
  Array.isArray(json.skins) ||
  primitives.some((primitive) => isObject(primitive.attributes) && primitive.attributes[JOINTS_0] !== undefined);

/** The simplifier's options for one primitive. */
function flagsFor(input: SimplifyInput): MeshoptSimplifyFlag[] {
  const flags: MeshoptSimplifyFlag[] = [MeshoptSimplifyFlag.ErrorClamped];
  if (input.doubleSided) flags.push(MeshoptSimplifyFlag.PreserveFolds);
  return flags;
}

/** One primitive's triangles brought to `target` indices: attribute-aware first, sloppy if that stops short. */
function simplifyPrimitive(simplifier: DecimateSimplifier, input: SimplifyInput, target: number): Uint32Array {
  const { indices, positions } = input.geometry;
  const [careful] = simplifier.simplifyWithAttributes(
    indices,
    positions,
    TRIANGLE,
    input.attributes,
    input.stride,
    input.weights,
    input.lock,
    target,
    UNBOUNDED_ERROR,
    flagsFor(input),
  );
  if (careful.length <= target * SHARE_SLACK) return careful;
  const [sloppy] = simplifier.simplifySloppy(careful, positions, TRIANGLE, input.lock, target, UNBOUNDED_ERROR);
  return sloppy.length && sloppy.length < careful.length ? sloppy : careful;
}

/** `indices` over only the vertices they use, in first-use order: the sources and the remapped triangles. */
function compacted(indices: Uint32Array, vertexCount: number): { sources: Uint32Array; indices: Uint32Array } {
  const remap = new Int32Array(vertexCount).fill(-1);
  const sources: number[] = [];
  const out = new Uint32Array(indices.length);
  indices.forEach((vertex, at) => {
    if (remap[vertex] === -1) {
      remap[vertex] = sources.length;
      sources.push(vertex);
    }
    out[at] = remap[vertex] ?? 0;
  });
  return { sources: Uint32Array.from(sources), indices: out };
}

/** Each primitive's index target for `share` of its triangles. */
function targetOf(geometry: Geometry, share: number): number {
  const own = geometry.indices.length / TRIANGLE;
  const kept = Math.max(Math.floor(own * share), Math.min(own, MIN_PRIMITIVE_TRIANGLES));
  return kept * TRIANGLE;
}

/** The document's triangle primitives with their geometry, or null when any cannot be read. */
function readAll(doc: PackDoc, primitives: Json[]): Geometry[] | null {
  const geometry = primitives.map((primitive) => readGeometry(doc.json, doc.bin, primitive));
  const found = geometry.filter((each): each is Geometry => each !== null);
  return found.length === geometry.length && found.length ? found : null;
}

/**
 * `glb` with its triangles brought to at most about `budget`, every primitive by the same share and
 * its vertices compacted; the same bytes with the reason when it is within budget, skinned or not
 * rewritable. Never throws for the GLB's own contents.
 */
export async function decimateGlb(
  glb: Uint8Array,
  budget: number,
  simplifier: DecimateSimplifier,
): Promise<DecimateOutcome> {
  const skip = (reason: DecimateSkip): DecimateOutcome => ({ bytes: glb, decimated: false, reason });
  const doc = tryOpenDoc(glb);
  if (!doc || rewriteBlocker(doc)) return skip(DecimateSkip.UnreadableGeometry);
  const primitives = primitivesOf(doc.json);
  if (isSkinned(doc.json, primitives)) return skip(DecimateSkip.Skinned);
  const geometry = readAll(doc, primitives);
  if (!geometry) return skip(DecimateSkip.UnreadableGeometry);
  const before = geometry.reduce((sum, each) => sum + each.indices.length / TRIANGLE, 0);
  if (before <= budget) return skip(DecimateSkip.WithinBudget);
  await simplifier.ready;
  const share = budget / before;
  const inputs = simplifyInputs(doc, primitives, geometry);
  let after = 0;
  try {
    inputs.forEach((input, at) => {
      const primitive = primitives[at] ?? {};
      const simplified = simplifyPrimitive(simplifier, input, targetOf(input.geometry, share));
      const { sources, indices } = compacted(simplified, input.geometry.positions.length / TRIANGLE);
      rebuildPrimitive(doc, primitive, sources, indices);
      after += indices.length / TRIANGLE;
    });
  } catch (error) {
    if (error instanceof WeldSkipped) return skip(DecimateSkip.UnreadableGeometry);
    throw error;
  }
  dedupAccessors(doc);
  pruneAccessors(doc);
  return { bytes: packGlb(doc), decimated: true, before, after };
}
