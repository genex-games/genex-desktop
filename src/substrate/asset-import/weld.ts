/**
 * Weld at import (C-7): every mesh primitive's bitwise-identical vertices merged into one and the
 * primitive indexed over them, then duplicate accessors and materials merged and everything
 * unreferenced dropped (`prune.ts`). A vertex is every attribute it carries, morph-target deltas
 * and `JOINTS_n`/`WEIGHTS_n` included, so skins and morphs come through unchanged; two vertices
 * that differ in any byte of any of them stay two. The output is a pure function of the input.
 *
 * Ported from glTF-Transform 4.4.2 (MIT, © 2024 Don McCurdy, THIRD-PARTY-NOTICES.md "Asset
 * importer ports"): `packages/functions/src/weld.ts` (`weldPrimitive`: the first-use write map
 * over the index stream), `hash-table.ts` (`VertexStream`: each vertex's attributes padded to 4
 * bytes and hashed with MurmurHash2, open addressing with triangular probing) and
 * `compact-primitive.ts` (`compactAttribute`, and 16-bit indices up to 65,534 vertices).
 */
import { LODS_EXTRAS_KEY, MESHLETS_EXTRAS_KEY } from "../../shared/render-quality.ts";
import { GltfComponent, readGlb } from "./glb.ts";
import { index, isObject, type Json, objects, strings } from "./gltf-json.ts";
import {
  accessorAt,
  accessorCount,
  accessorData,
  attributeMaps,
  dedupAccessors,
  dedupMaterials,
  elementLayout,
  type PackDoc,
  packGlb,
  primitivesOf,
  pruneAccessors,
  pruneMaterials,
  WeldSkip,
  WeldSkipped,
} from "./prune.ts";

export { WeldSkip };

/** An empty slot in the weld's hash table and write map. */
const EMPTY_U32 = 0xffffffff;
/** The largest vertex count indexed with 16 bits (65,535 is the strip restart value). */
const MAX_SHORT_VERTICES = 65_534;
const POINTS = 0;
const TRIANGLES = 4;
const MURMUR_M = 0x5bd1e995;
const MURMUR_R = 24;
const WORD = 4;
const SCALAR = "SCALAR";

/**
 * The extensions a document may use for the step to run: each names accessors, views and
 * materials only where the step remaps them (or not at all). Anything else leaves the GLB as it was.
 */
const WELD_SAFE_EXTENSIONS: ReadonlySet<string> = new Set([
  "EXT_mesh_gpu_instancing",
  "EXT_texture_avif",
  "EXT_texture_webp",
  "KHR_lights_punctual",
  "KHR_materials_anisotropy",
  "KHR_materials_clearcoat",
  "KHR_materials_diffuse_transmission",
  "KHR_materials_dispersion",
  "KHR_materials_emissive_strength",
  "KHR_materials_ior",
  "KHR_materials_iridescence",
  "KHR_materials_pbrSpecularGlossiness",
  "KHR_materials_sheen",
  "KHR_materials_specular",
  "KHR_materials_transmission",
  "KHR_materials_unlit",
  "KHR_materials_volume",
  "KHR_mesh_quantization",
  "KHR_texture_basisu",
  "KHR_texture_transform",
  "KHR_xmp_json_ld",
]);

/** A count before the step and after it. */
export interface WeldCounts {
  before: number;
  after: number;
}

/** What {@link weldGlb} did: the bytes to deliver, and what shrank or why nothing did. */
export type WeldOutcome =
  | {
      bytes: Uint8Array;
      welded: true;
      /** Vertices of the welded primitives. */
      vertices: WeldCounts;
      /** The document's accessors: duplicates merged, unreferenced ones dropped. */
      accessors: WeldCounts;
      /** The document's materials: duplicates merged, unreferenced ones dropped. */
      materials: WeldCounts;
    }
  | { bytes: Uint8Array; welded: false; reason: WeldSkip };

/** One vertex stream: an accessor's dense bytes and its element size, padded as upstream hashes it. */
interface Stream {
  bytes: Uint8Array;
  elementBytes: number;
  paddedBytes: number;
}

/** A primitive's vertices as one record per vertex: hashed and compared across every stream. */
interface VertexRecords {
  streams: Stream[];
  scratch: Uint8Array;
  words: Uint32Array;
}

function vertexRecords(streams: Stream[]): VertexRecords {
  const size = streams.reduce((sum, stream) => sum + stream.paddedBytes, 0);
  const scratch = new Uint8Array(size);
  return { streams, scratch, words: new Uint32Array(scratch.buffer) };
}

/** MurmurHash2 of vertex `at`'s padded record (upstream `VertexStream.hash`). */
function hashVertex(records: VertexRecords, at: number): number {
  let offset = 0;
  for (const { bytes, elementBytes, paddedBytes } of records.streams) {
    records.scratch.set(bytes.subarray(at * elementBytes, (at + 1) * elementBytes), offset);
    records.scratch.fill(0, offset + elementBytes, offset + paddedBytes);
    offset += paddedBytes;
  }
  let hash = 0;
  for (const word of records.words) {
    let k = Math.imul(word, MURMUR_M) >>> 0;
    k = (k ^ (k >> MURMUR_R)) >>> 0;
    k = Math.imul(k, MURMUR_M) >>> 0;
    hash = Math.imul(hash, MURMUR_M) >>> 0;
    hash = (hash ^ k) >>> 0;
  }
  return hash;
}

/** Whether vertices `a` and `b` are equal in every byte of every stream. */
function sameVertex(records: VertexRecords, a: number, b: number): boolean {
  for (const { bytes, elementBytes } of records.streams) {
    for (let j = 0; j < elementBytes; j++) {
      if (bytes[a * elementBytes + j] !== bytes[b * elementBytes + j]) return false;
    }
  }
  return true;
}

/** The table slot of vertex `key`: its own, or the slot of an equal vertex already placed. */
function hashLookup(table: Uint32Array, records: VertexRecords, key: number): number {
  const mask = table.length - 1;
  let bucket = hashVertex(records, key) & mask;
  for (let probe = 0; probe <= mask; probe++) {
    const item = table[bucket] ?? EMPTY_U32;
    if (item === EMPTY_U32 || sameVertex(records, item, key)) return bucket;
    bucket = (bucket + probe + 1) & mask;
  }
  throw new WeldSkipped(WeldSkip.UnreadableGeometry, "weld table full");
}

const ceilPowerOfTwo = (value: number) => 2 ** Math.ceil(Math.log2(Math.max(value, 1)));

/** Old vertex → new vertex, in first-use order over the index stream, and the new vertex count. */
function writeMap(records: VertexRecords, indices: Uint32Array, vertexCount: number): [Uint32Array, number] {
  const size = ceilPowerOfTwo(vertexCount + vertexCount / 4);
  const table = new Uint32Array(size).fill(EMPTY_U32);
  const map = new Uint32Array(vertexCount).fill(EMPTY_U32);
  let next = 0;
  for (const source of indices) {
    if (map[source] !== EMPTY_U32) continue;
    const slot = hashLookup(table, records, source);
    const found = table[slot] ?? EMPTY_U32;
    if (found === EMPTY_U32) {
      table[slot] = source;
      map[source] = next++;
    } else {
      map[source] = map[found] ?? EMPTY_U32;
    }
  }
  return [map, next];
}

/** Read one index of each width the glTF index stream may have. */
const INDEX_READ: Readonly<Record<number, (data: DataView, at: number) => number>> = {
  [GltfComponent.UnsignedByte]: (d, at) => d.getUint8(at),
  [GltfComponent.UnsignedShort]: (d, at) => d.getUint16(at * 2, true),
  [GltfComponent.UnsignedInt]: (d, at) => d.getUint32(at * 4, true),
};

/** A primitive's index stream, or 0..count for an unindexed one; every index checked against the vertices. */
function readIndices(doc: PackDoc, primitive: Json, vertexCount: number): Uint32Array {
  const at = index(primitive.indices);
  if (primitive.indices === undefined) return Uint32Array.from({ length: vertexCount }, (_, i) => i);
  if (at === null) throw new WeldSkipped(WeldSkip.UnreadableGeometry, "indices names no accessor");
  const accessor = accessorAt(doc, at);
  const read = INDEX_READ[accessor.componentType as number];
  if (!read || accessor.type !== SCALAR) throw new WeldSkipped(WeldSkip.UnreadableGeometry, "indices of no index type");
  const bytes = accessorData(doc, at);
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Uint32Array(accessorCount(doc, at));
  for (let i = 0; i < out.length; i++) {
    const value = read(data, i);
    if (value >= vertexCount) throw new WeldSkipped(WeldSkip.UnreadableGeometry, "an index past the last vertex");
    out[i] = value;
  }
  return out;
}

/** Read one component of each type, for bounds. */
const COMPONENT_READ: Readonly<Record<number, (data: DataView, at: number) => number>> = {
  [GltfComponent.Byte]: (d, at) => d.getInt8(at),
  [GltfComponent.UnsignedByte]: (d, at) => d.getUint8(at),
  [GltfComponent.Short]: (d, at) => d.getInt16(at, true),
  [GltfComponent.UnsignedShort]: (d, at) => d.getUint16(at, true),
  [GltfComponent.UnsignedInt]: (d, at) => d.getUint32(at, true),
  [GltfComponent.Float]: (d, at) => d.getFloat32(at, true),
};

/** Per-component bounds of dense data, in the accessor's own component values (glTF §5.1.6). */
function bounds(accessor: Json, bytes: Uint8Array): { min: number[]; max: number[] } {
  const { componentBytes, width } = elementLayout(accessor);
  const read = COMPONENT_READ[accessor.componentType as number] ?? COMPONENT_READ[GltfComponent.Float];
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = Array.from({ length: width }, () => Number.POSITIVE_INFINITY);
  const max = Array.from({ length: width }, () => Number.NEGATIVE_INFINITY);
  const components = bytes.length / componentBytes;
  for (let i = 0; i < components; i++) {
    const c = i % width;
    const value = read ? read(data, i * componentBytes) : 0;
    if (value < (min[c] ?? 0)) min[c] = value;
    if (value > (max[c] ?? 0)) max[c] = value;
  }
  return { min, max };
}

/** `bytes`' elements moved to their new places (upstream `compactAttribute`). */
function compact(bytes: Uint8Array, elementBytes: number, indices: Uint32Array, map: Uint32Array, count: number) {
  const out = new Uint8Array(count * elementBytes);
  const done = new Uint8Array(count);
  for (const source of indices) {
    const target = map[source] ?? 0;
    if (done[target]) continue;
    out.set(bytes.subarray(source * elementBytes, (source + 1) * elementBytes), target * elementBytes);
    done[target] = 1;
  }
  return out;
}

/** Append an accessor with `data` and no view yet (`packGlb` writes it); returns its index. */
function appendAccessor(doc: PackDoc, accessor: Json, data: Uint8Array): number {
  const accessors = objects(doc.json.accessors);
  accessors.push(accessor);
  doc.json.accessors = accessors;
  doc.data.set(accessors.length - 1, data);
  return accessors.length - 1;
}

/** The distinct accessors of a primitive's attributes and morph targets, in first-named order. */
function primitiveAccessors(primitive: Json): number[] {
  const found = attributeMaps(primitive).flatMap((map) => Object.values(map).map(index));
  if (found.some((at) => at === null))
    throw new WeldSkipped(WeldSkip.UnreadableGeometry, "an attribute names no accessor");
  return [...new Set(found as number[])];
}

/**
 * One primitive welded (upstream `weldPrimitive`): its attributes and morph targets rewritten as new
 * accessors of the distinct vertices, its indices as a new accessor over them. Returns the vertex
 * counts, or null for a primitive the step leaves alone (points, no positions).
 */
function weldPrimitive(doc: PackDoc, primitive: Json): WeldCounts | null {
  const mode = index(primitive.mode) ?? TRIANGLES;
  const position = isObject(primitive.attributes) ? index(primitive.attributes.POSITION) : null;
  if (mode === POINTS || position === null) return null;
  const vertexCount = accessorCount(doc, position);
  const sources = primitiveAccessors(primitive);
  if (sources.some((at) => accessorCount(doc, at) !== vertexCount))
    throw new WeldSkipped(WeldSkip.UnreadableGeometry, "attributes of different counts");
  const streams = sources.map((at): Stream => {
    const { elementBytes } = elementLayout(accessorAt(doc, at));
    return { bytes: accessorData(doc, at), elementBytes, paddedBytes: Math.ceil(elementBytes / WORD) * WORD };
  });
  const indices = readIndices(doc, primitive, vertexCount);
  const [map, count] = writeMap(vertexRecords(streams), indices, vertexCount);
  const moved = new Map<number, number>();
  sources.forEach((at, i) => {
    const old = accessorAt(doc, at);
    const stream = streams[i];
    if (!stream) return;
    const data = compact(stream.bytes, stream.elementBytes, indices, map, count);
    const { bufferView: _view, byteOffset: _offset, min: _min, max: _max, ...rest } = old;
    const hadBounds = old.min !== undefined || old.max !== undefined;
    const accessor: Json = { ...rest, count, ...(hadBounds ? bounds(old, data) : {}) };
    moved.set(at, appendAccessor(doc, accessor, data));
  });
  for (const attributes of attributeMaps(primitive)) {
    for (const key of Object.keys(attributes)) attributes[key] = moved.get(index(attributes[key]) ?? -1);
  }
  primitive.indices = appendIndices(doc, indices, map, count);
  return { before: vertexCount, after: count };
}

/** The remapped index stream as a new accessor: 16-bit up to {@link MAX_SHORT_VERTICES} vertices. */
function appendIndices(doc: PackDoc, indices: Uint32Array, map: Uint32Array, count: number): number {
  const remapped = indices.map((source) => map[source] ?? 0);
  const short = count <= MAX_SHORT_VERTICES;
  const typed = short ? Uint16Array.from(remapped) : remapped;
  const data = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  const componentType = short ? GltfComponent.UnsignedShort : GltfComponent.UnsignedInt;
  return appendAccessor(doc, { componentType, count: remapped.length, type: SCALAR }, data);
}

/** Why the step must leave this document alone, or null when it can run. */
function precondition(json: Json): WeldSkip | null {
  const buffers = objects(json.buffers);
  if (buffers.length > 1 || buffers.some((buffer) => buffer.uri !== undefined)) return WeldSkip.ExternalBuffer;
  const used = [...strings(json.extensionsUsed), ...strings(json.extensionsRequired)];
  if (used.some((name) => !WELD_SAFE_EXTENSIONS.has(name))) return WeldSkip.UnsafeExtension;
  const extras = primitivesOf(json).map((primitive) => primitive.extras);
  const named = (key: string) => extras.some((value) => isObject(value) && key in value);
  if (named(LODS_EXTRAS_KEY) || named(MESHLETS_EXTRAS_KEY)) return WeldSkip.ImportExtras;
  return null;
}

/** Weld, merge and prune `doc`; the input bytes when nothing shrank. */
function weldDoc(doc: PackDoc, glb: Uint8Array): WeldOutcome {
  const accessors = { before: objects(doc.json.accessors).length, after: 0 };
  const materials = { before: objects(doc.json.materials).length, after: 0 };
  const vertices: WeldCounts = { before: 0, after: 0 };
  for (const primitive of primitivesOf(doc.json)) {
    const counts = weldPrimitive(doc, primitive);
    vertices.before += counts?.before ?? 0;
    vertices.after += counts?.after ?? 0;
  }
  dedupAccessors(doc);
  dedupMaterials(doc.json);
  pruneMaterials(doc.json);
  pruneAccessors(doc);
  accessors.after = objects(doc.json.accessors).length;
  materials.after = objects(doc.json.materials).length;
  const shrank = [vertices, accessors, materials].some((counts) => counts.after < counts.before);
  if (!shrank) return { bytes: glb, welded: false, reason: WeldSkip.NothingToWeld };
  return { bytes: packGlb(doc), welded: true, vertices, accessors, materials };
}

/**
 * `glb` with its primitives welded and its duplicate and unreferenced accessors and materials gone;
 * the same bytes with the reason when the step cannot run or nothing would shrink. Never throws
 * for the GLB's own contents.
 */
export function weldGlb(glb: Uint8Array): WeldOutcome {
  const skip = (reason: WeldSkip): WeldOutcome => ({ bytes: glb, welded: false, reason });
  let doc: PackDoc;
  try {
    const parts = readGlb(glb);
    doc = { json: structuredClone(parts.json) as Json, bin: parts.bin, data: new Map() };
  } catch {
    return skip(WeldSkip.UnreadableGeometry);
  }
  const blocked = precondition(doc.json);
  if (blocked) return skip(blocked);
  try {
    return weldDoc(doc, glb);
  } catch (error) {
    if (error instanceof WeldSkipped) return skip(error.reason);
    throw error;
  }
}
