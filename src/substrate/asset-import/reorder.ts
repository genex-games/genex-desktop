/**
 * Vertex cache and fetch order at import (C-8): every triangle primitive's triangles reordered for
 * the post-transform vertex cache (meshoptimizer's `optimizeVertexCache`) and its vertices stored
 * in the order the triangles first use them (`optimizeVertexFetchRemap`), through
 * `MeshoptEncoder.reorderMesh` of npm `meshoptimizer` 1.3.0 (`decoders.ts`). Every attribute and
 * morph target moves with its vertex, `JOINTS_n`/`WEIGHTS_n` included, so skins and morphs come
 * through corner for corner; a vertex no triangle uses is dropped. Triangles keep their winding.
 *
 * It runs after weld and tangents and before meshlets and LODs (`convert.ts`), so the clusters and
 * levels index the final order. A document the step cannot rewrite safely (the weld step's rules,
 * `weld.ts`) comes back as the same bytes with the reason. The output is a pure function of the input.
 */
import { meshoptEncoder } from "./decoders.ts";
import { GltfComponent, readGlb } from "./glb.ts";
import { index, isObject, type Json } from "./gltf-json.ts";
import {
  accessorAt,
  accessorCount,
  accessorData,
  attributeMaps,
  dedupAccessors,
  elementLayout,
  type PackDoc,
  packGlb,
  primitivesOf,
  pruneAccessors,
  WeldSkip,
  WeldSkipped,
} from "./prune.ts";
import { appendAccessor, bounds, precondition, primitiveAccessors, readIndices } from "./weld.ts";

/** The largest vertex count indexed with 16 bits (65,535 is the strip restart value), as `weld.ts`. */
const MAX_SHORT_VERTICES = 65_534;
/** meshoptimizer's remap entry for a vertex no index uses. */
const UNUSED = 0xffffffff;
const TRIANGLES = 4;
const TRIANGLE = 3;
const SCALAR = "SCALAR";

/** Why {@link reorderGlb} returned the GLB as it was. Wire values in the import outcome: never rename one. */
export const ReorderSkip = {
  UnreadableGeometry: WeldSkip.UnreadableGeometry,
  ExternalBuffer: WeldSkip.ExternalBuffer,
  UnsafeExtension: WeldSkip.UnsafeExtension,
  SparseAccessor: WeldSkip.SparseAccessor,
  ImportExtras: WeldSkip.ImportExtras,
  /** No primitive is a triangle list with a triangle in it (points, lines, empty). */
  NoTriangles: "no-triangles",
} as const;
export type ReorderSkip = (typeof ReorderSkip)[keyof typeof ReorderSkip];

/** A count before the step and after it. */
export interface VertexCounts {
  before: number;
  after: number;
}

/** What {@link reorderGlb} did: the bytes to deliver, and how many vertices the reordered primitives kept. */
export type ReorderOutcome =
  | { bytes: Uint8Array; reordered: true; primitives: number; vertices: VertexCounts }
  | { bytes: Uint8Array; reordered: false; reason: ReorderSkip };

/** A GLB opened for a rewrite: its JSON cloned, its accessors read from the binary chunk on use. */
export function openDoc(glb: Uint8Array): PackDoc {
  const parts = readGlb(glb);
  return { json: structuredClone(parts.json) as Json, bin: parts.bin, data: new Map() };
}

/** {@link openDoc}, or null for bytes that are not a GLB the steps can read. */
export function tryOpenDoc(glb: Uint8Array): PackDoc | null {
  try {
    return openDoc(glb);
  } catch {
    return null;
  }
}

/** Why a vertex-rewriting step must leave `doc` alone (the weld step's rules), or null. */
export function rewriteBlocker(doc: PackDoc): RewriteSkip | null {
  const blocked = precondition(doc.json);
  return blocked ? rewriteSkip(blocked) : null;
}

/** Why a vertex-rewriting step left a GLB alone under the weld step's rules (never `nothing-to-weld`). */
export type RewriteSkip = Exclude<WeldSkip, typeof WeldSkip.NothingToWeld>;

/** A weld-rule reason as a rewriting step reports it: `nothing-to-weld` is the weld's own outcome, never a blocker. */
export function rewriteSkip(reason: WeldSkip): RewriteSkip {
  return reason === WeldSkip.NothingToWeld ? WeldSkip.UnreadableGeometry : reason;
}

/** `bytes`' elements gathered so element `i` of the result is element `sources[i]` of the input. */
function gather(bytes: Uint8Array, elementBytes: number, sources: Uint32Array): Uint8Array {
  const out = new Uint8Array(sources.length * elementBytes);
  sources.forEach((source, at) => {
    out.set(bytes.subarray(source * elementBytes, (source + 1) * elementBytes), at * elementBytes);
  });
  return out;
}

/** `indices` as a new index accessor over `vertexCount` vertices: 16-bit up to {@link MAX_SHORT_VERTICES}. */
function appendIndexAccessor(doc: PackDoc, indices: Uint32Array, vertexCount: number): number {
  const short = vertexCount <= MAX_SHORT_VERTICES;
  const typed = short ? Uint16Array.from(indices) : indices;
  const data = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  const componentType = short ? GltfComponent.UnsignedShort : GltfComponent.UnsignedInt;
  return appendAccessor(doc, { componentType, count: indices.length, type: SCALAR }, data);
}

/** A new vertex attribute a step adds to a rebuilt primitive: its accessor (no view) and dense data. */
export interface AddedAttribute {
  accessor: Json;
  data: Uint8Array;
}

/**
 * Rewrite one primitive over new vertices: new vertex `i` is old vertex `sources[i]` in every
 * attribute and morph target, `indices` index the new vertices, and `added` attributes are set
 * beside them. Each rewritten accessor is a new one (another primitive may share the old); bounds
 * are recomputed where the old accessor had them.
 */
export function rebuildPrimitive(
  doc: PackDoc,
  primitive: Json,
  sources: Uint32Array,
  indices: Uint32Array,
  added: Readonly<Record<string, AddedAttribute>> = {},
): void {
  const moved = new Map<number, number>();
  for (const at of primitiveAccessors(primitive)) {
    const old = accessorAt(doc, at);
    const data = gather(accessorData(doc, at), elementLayout(old).elementBytes, sources);
    const { bufferView: _view, byteOffset: _offset, min: _min, max: _max, ...rest } = old;
    const hadBounds = old.min !== undefined || old.max !== undefined;
    const accessor: Json = { ...rest, count: sources.length, ...(hadBounds ? bounds(old, data) : {}) };
    moved.set(at, appendAccessor(doc, accessor, data));
  }
  for (const attributes of attributeMaps(primitive)) {
    for (const key of Object.keys(attributes)) attributes[key] = moved.get(index(attributes[key]) ?? -1);
  }
  const own = isObject(primitive.attributes) ? primitive.attributes : {};
  for (const [key, attribute] of Object.entries(added))
    own[key] = appendAccessor(doc, attribute.accessor, attribute.data);
  primitive.attributes = own;
  primitive.indices = appendIndexAccessor(doc, indices, sources.length);
}

/**
 * A triangle primitive's vertex count and index stream, every attribute checked to have that count;
 * null for one the vertex steps leave alone (not a triangle list, no POSITION, no triangle).
 */
export function triangleList(doc: PackDoc, primitive: Json): { vertexCount: number; indices: Uint32Array } | null {
  const mode = index(primitive.mode) ?? TRIANGLES;
  const position = isObject(primitive.attributes) ? index(primitive.attributes.POSITION) : null;
  if (mode !== TRIANGLES || position === null) return null;
  const vertexCount = accessorCount(doc, position);
  if (primitiveAccessors(primitive).some((at) => accessorCount(doc, at) !== vertexCount))
    throw new WeldSkipped(WeldSkip.UnreadableGeometry, "attributes of different counts");
  const indices = readIndices(doc, primitive, vertexCount);
  if (indices.length % TRIANGLE) throw new WeldSkipped(WeldSkip.UnreadableGeometry, "a partial triangle");
  return indices.length ? { vertexCount, indices } : null;
}

/** Old vertex → new vertex as meshoptimizer returned it, turned into new vertex → old vertex. */
function sourcesOf(remap: Uint32Array, unique: number): Uint32Array {
  const sources = new Uint32Array(unique);
  remap.forEach((target, source) => {
    if (target !== UNUSED) sources[target] = source;
  });
  return sources;
}

/** Reorder every triangle primitive of `doc`; returns the primitives done and their vertex counts. */
async function reorderDoc(doc: PackDoc): Promise<{ primitives: number; vertices: VertexCounts }> {
  const encoder = await meshoptEncoder();
  const vertices: VertexCounts = { before: 0, after: 0 };
  let primitives = 0;
  for (const primitive of primitivesOf(doc.json)) {
    const list = triangleList(doc, primitive);
    if (!list) continue;
    const indices = Uint32Array.from(list.indices);
    const [remap, unique] = encoder.reorderMesh(indices, true, false);
    rebuildPrimitive(doc, primitive, sourcesOf(remap, unique), indices);
    vertices.before += list.vertexCount;
    vertices.after += unique;
    primitives++;
  }
  return { primitives, vertices };
}

/**
 * `glb` with every triangle primitive in vertex cache and fetch order; the same bytes with the
 * reason when the step cannot run or no primitive is a triangle list. Never throws for the GLB's
 * own contents.
 */
export async function reorderGlb(glb: Uint8Array): Promise<ReorderOutcome> {
  const skip = (reason: ReorderSkip): ReorderOutcome => ({ bytes: glb, reordered: false, reason });
  const doc = tryOpenDoc(glb);
  if (!doc) return skip(ReorderSkip.UnreadableGeometry);
  const blocked = rewriteBlocker(doc);
  if (blocked) return skip(blocked);
  try {
    const { primitives, vertices } = await reorderDoc(doc);
    if (!primitives) return skip(ReorderSkip.NoTriangles);
    dedupAccessors(doc);
    pruneAccessors(doc);
    return { bytes: packGlb(doc), reordered: true, primitives, vertices };
  } catch (error) {
    if (error instanceof WeldSkipped) return skip(rewriteSkip(error.reason));
    throw error;
  }
}
