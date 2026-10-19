/**
 * MikkTSpace tangents at import (C-8): a triangle primitive whose material has a normal texture,
 * which has NORMAL and the texture's coordinate set but no TANGENT, gets a float `TANGENT` (unit xyz
 * and the bitangent sign in w) from meshoptimizer's `generateTangents` with `Compatible`, MikkTSpace's
 * output (npm `meshoptimizer` 1.3.0, `decoders.ts`), so a baked normal map shades without seams. The
 * generator answers per corner; a vertex whose corners disagree (a mirrored UV seam, where the sign
 * flips, or a hard UV split) becomes one vertex per distinct tangent, every other attribute and morph
 * delta copied, so the sign stays continuous within each UV island and splits at the seam.
 *
 * A primitive without NORMAL is left for the runtime, which derives normals and tangents together.
 * A document the step cannot rewrite safely (the weld step's rules, `weld.ts`) comes back as the same
 * bytes with the reason. The output is a pure function of the input.
 */
import { MeshoptTangentsFlag, meshoptTangents } from "./decoders.ts";
import { GltfComponent } from "./glb.ts";
import { index, isObject, type Json, objects } from "./gltf-json.ts";
import {
  accessorAt,
  accessorData,
  dedupAccessors,
  type PackDoc,
  packGlb,
  primitivesOf,
  pruneAccessors,
  WeldSkip,
  WeldSkipped,
} from "./prune.ts";
import {
  rebuildPrimitive,
  rewriteBlocker,
  rewriteSkip,
  triangleList,
  tryOpenDoc,
  type VertexCounts,
} from "./reorder.ts";

const TANGENT = "TANGENT";
const NORMAL = "NORMAL";
const POSITION = "POSITION";
const TEXCOORD = "TEXCOORD_";
const VEC2 = "VEC2";
const VEC3 = "VEC3";
const VEC4 = "VEC4";
const TANGENT_WIDTH = 4;
const VEC3_WIDTH = 3;
const VEC2_WIDTH = 2;
const FLOAT_BYTES = 4;
/** The tangent of a vertex no triangle uses: +x, right-handed. */
const IDLE_TANGENT = [1, 0, 0, 1] as const;

/** Why {@link addTangents} returned the GLB as it was. Wire values in the import outcome: never rename one. */
export const TangentSkip = {
  UnreadableGeometry: WeldSkip.UnreadableGeometry,
  ExternalBuffer: WeldSkip.ExternalBuffer,
  UnsafeExtension: WeldSkip.UnsafeExtension,
  SparseAccessor: WeldSkip.SparseAccessor,
  ImportExtras: WeldSkip.ImportExtras,
  /** No primitive is normal-mapped with NORMAL, float coordinates and no TANGENT of its own. */
  NothingToGenerate: "nothing-to-generate",
} as const;
export type TangentSkip = (typeof TangentSkip)[keyof typeof TangentSkip];

/** What {@link addTangents} did: the bytes to deliver, and the tangent primitives' vertex counts. */
export type TangentOutcome =
  | { bytes: Uint8Array; generated: true; primitives: number; vertices: VertexCounts }
  | { bytes: Uint8Array; generated: false; reason: TangentSkip };

/** The coordinate set a normal-mapped material samples its normal texture with, or null for none. */
function normalTexCoord(json: Json, primitive: Json): number | null {
  const material = objects(json.materials)[index(primitive.material) ?? -1];
  const normal = isObject(material?.normalTexture) ? material.normalTexture : null;
  if (!normal || index(normal.index) === null) return null;
  // KHR_texture_transform may name another set for this texture (its spec's `texCoord` override).
  const transform = isObject(normal.extensions) ? normal.extensions.KHR_texture_transform : undefined;
  const override = isObject(transform) ? index(transform.texCoord) : null;
  return override ?? index(normal.texCoord) ?? 0;
}

/** Accessor `at` as tight floats when it is a float accessor of `type`, else null. */
function floats(doc: PackDoc, at: unknown, type: string): Float32Array | null {
  const found = index(at);
  if (found === null) return null;
  const accessor = accessorAt(doc, found);
  if (accessor.componentType !== GltfComponent.Float || accessor.type !== type) return null;
  const bytes = accessorData(doc, found);
  return new Float32Array(bytes.slice().buffer);
}

/** The generator's inputs of a primitive that needs tangents, or null for one the step leaves. */
function tangentInputs(doc: PackDoc, primitive: Json) {
  const texCoord = normalTexCoord(doc.json, primitive);
  const attributes = isObject(primitive.attributes) ? primitive.attributes : {};
  if (texCoord === null || attributes[TANGENT] !== undefined || attributes[NORMAL] === undefined) return null;
  const list = triangleList(doc, primitive);
  if (!list) return null;
  const positions = floats(doc, attributes[POSITION], VEC3);
  const normals = floats(doc, attributes[NORMAL], VEC3);
  const uvs = floats(doc, attributes[`${TEXCOORD}${texCoord}`], VEC2);
  if (!positions || !normals || !uvs) return null;
  return { ...list, positions, normals, uvs };
}

/** The new vertices of a primitive split by tangent: new → old vertex, the corners' new indices, each vertex's tangent. */
interface Split {
  sources: Uint32Array;
  indices: Uint32Array;
  tangents: Float32Array;
}

/**
 * One vertex per distinct (old vertex, tangent): a vertex keeps its index for the tangent its first
 * corner has, and each other tangent its corners have becomes a new vertex after the old ones, in
 * corner order. Tangents compare bit for bit.
 */
function splitByTangent(indices: Uint32Array, corners: Float32Array, vertexCount: number): Split {
  const bits = new Uint32Array(corners.buffer, corners.byteOffset, corners.length);
  const sources = Array.from({ length: vertexCount }, (_, at) => at);
  const tangents: number[] = Array.from({ length: vertexCount }, () => IDLE_TANGENT).flat();
  const kept = new Map<number, string>();
  const extra = new Map<string, number>();
  const out = new Uint32Array(indices.length);
  indices.forEach((vertex, corner) => {
    const key = bits.subarray(corner * TANGENT_WIDTH, (corner + 1) * TANGENT_WIDTH).join(",");
    const tangent = corners.subarray(corner * TANGENT_WIDTH, (corner + 1) * TANGENT_WIDTH);
    const own = kept.get(vertex);
    if (own === undefined) {
      kept.set(vertex, key);
      tangent.forEach((value, at) => {
        tangents[vertex * TANGENT_WIDTH + at] = value;
      });
    }
    if (own === undefined || own === key) {
      out[corner] = vertex;
      return;
    }
    const split = `${vertex}:${key}`;
    let added = extra.get(split);
    if (added === undefined) {
      added = sources.length;
      extra.set(split, added);
      sources.push(vertex);
      tangents.push(...tangent);
    }
    out[corner] = added;
  });
  return { sources: Uint32Array.from(sources), indices: out, tangents: Float32Array.from(tangents) };
}

/** Generate and add one primitive's tangents; its vertex counts, or null when it needs none. */
async function tangentPrimitive(doc: PackDoc, primitive: Json): Promise<VertexCounts | null> {
  const inputs = tangentInputs(doc, primitive);
  if (!inputs) return null;
  const generator = await meshoptTangents();
  const corners = generator.generateTangents(
    inputs.indices,
    inputs.positions,
    VEC3_WIDTH,
    inputs.normals,
    VEC3_WIDTH,
    inputs.uvs,
    VEC2_WIDTH,
    [MeshoptTangentsFlag.Compatible],
  );
  const split = splitByTangent(inputs.indices, corners, inputs.vertexCount);
  const count = split.sources.length;
  const data = new Uint8Array(split.tangents.buffer, 0, count * TANGENT_WIDTH * FLOAT_BYTES);
  const accessor: Json = { componentType: GltfComponent.Float, count, type: VEC4 };
  rebuildPrimitive(doc, primitive, split.sources, split.indices, { [TANGENT]: { accessor, data } });
  return { before: inputs.vertexCount, after: count };
}

/**
 * `glb` with MikkTSpace tangents on every normal-mapped primitive that lacks them, mirrored seams
 * split; the same bytes with the reason when the step cannot run or nothing needs tangents. Never
 * throws for the GLB's own contents.
 */
export async function addTangents(glb: Uint8Array): Promise<TangentOutcome> {
  const skip = (reason: TangentSkip): TangentOutcome => ({ bytes: glb, generated: false, reason });
  const doc = tryOpenDoc(glb);
  if (!doc) return skip(TangentSkip.UnreadableGeometry);
  const blocked = rewriteBlocker(doc);
  if (blocked) return skip(blocked);
  try {
    const vertices: VertexCounts = { before: 0, after: 0 };
    let primitives = 0;
    for (const primitive of primitivesOf(doc.json)) {
      const counts = await tangentPrimitive(doc, primitive);
      if (!counts) continue;
      vertices.before += counts.before;
      vertices.after += counts.after;
      primitives++;
    }
    if (!primitives) return skip(TangentSkip.NothingToGenerate);
    dedupAccessors(doc);
    pruneAccessors(doc);
    return { bytes: packGlb(doc), generated: true, primitives, vertices };
  } catch (error) {
    if (error instanceof WeldSkipped) return skip(rewriteSkip(error.reason));
    throw error;
  }
}
