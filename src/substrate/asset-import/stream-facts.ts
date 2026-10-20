/**
 * The streaming facts the package step writes into the asset index (C-29), read from a shipped
 * file so the runtime's streaming reads only the index:
 *
 * - **A GLB's levels, coarse first.** Level 0 is each primitive's own triangle list; levels 1.. are
 *   its `genex_lods` levels (`lods.ts`). Each level lists the byte ranges of its triangle lists in
 *   the file, beside the bytes every level needs: the head (GLB header, JSON chunk and BIN chunk
 *   header) and the vertex data (every view a primitive's attributes or morph targets read). A level
 *   past 0 is listed only when every primitive carries a valid chain of the same length, the way the
 *   runtime merges a part's primitives level by level (`mesh_lod.rs`).
 * - **A GLB's UV texel density.** The square root of the summed TEXCOORD_0 area over the summed
 *   area in the default scene's space (node transforms applied, each instance counted), over every
 *   primitive with UVs: UV units per world unit. A texture of side `s` lands `s * density` texels on
 *   one world unit (Unity's UV distribution metric). None without UVs.
 * - **A KTX2's levels, smallest first.** Each level's side and byte range, from the level index.
 *
 * Pure over the bytes. Anything the runtime would not read as plain triangles in the binary chunk
 * (a view in another buffer or past the chunk, a malformed accessor) answers null: no facts.
 */
import { GltfComponent, isGlb } from "./glb.ts";
import { index, isObject, type Json, objects } from "./gltf-json.ts";
import { readKtx2Header } from "./ktx2.ts";
import { readLodSet } from "./lods.ts";
import { readGeometry } from "./meshlets.ts";
import { accessorData, type PackDoc } from "./prune.ts";
import { LodExtrasKey, LodLevelKey, LODS_EXTRAS_KEY } from "../../shared/render-quality.ts";

/** A byte range of a shipped file. */
export interface ByteRange {
  offset: number;
  bytes: number;
}

/** One level of a model: its number (0 is the mesh itself), triangles, object-space error and triangle-list bytes. */
export interface MeshLevelFacts {
  level: number;
  triangles: number;
  /** The largest primitive error of the level, object space before node scale; 0 for level 0. */
  error: number;
  /** Where its triangle lists lie in the file, in file order, adjacent ranges merged. */
  ranges: ByteRange[];
}

/** What streaming needs of one GLB. */
export interface MeshFacts {
  /** Level 0's triangles over the file's primitives (each counted once). */
  triangles: number;
  /** UV units per world unit over TEXCOORD_0; null when no primitive has UVs. */
  uvDensity: number | null;
  /** The GLB header, the JSON chunk and the BIN chunk header: what every read starts with. */
  head: ByteRange;
  /** The vertex data every level reads, in file order, merged. */
  vertices: ByteRange[];
  /** Coarsest first; level 0 last. */
  levels: MeshLevelFacts[];
}

/** One KTX2 level as shipped: its side in texels and where its bytes lie. */
export interface TextureLevelFacts {
  px: number;
  offset: number;
  bytes: number;
}

/** Bytes of a KTX2 header, and of one entry of its level index (offset, length, uncompressed length). */
export const KTX2_HEADER_BYTES = 80;
const KTX2_LEVEL_ENTRY_BYTES = 24;
/** The GLB header, and a chunk's header (length, type). */
const GLB_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const CHUNK_BIN = 0x004e4942;
const U32_BYTES = 4;
const TRIANGLE = 3;
const TEXCOORD_0 = "TEXCOORD_0";
const UV_FLOATS = 2;
const MAT4 = 16;
/** Index component bytes by glTF component type. */
const INDEX_BYTES: Readonly<Record<number, number>> = {
  [GltfComponent.UnsignedByte]: 1,
  [GltfComponent.UnsignedShort]: 2,
  [GltfComponent.UnsignedInt]: 4,
};
/** Each normalized integer UV component type's width and largest value (glTF 3.11, KHR_mesh_quantization). */
const NORMALIZED_UV: Readonly<Record<number, readonly [number, number]>> = {
  [GltfComponent.UnsignedByte]: [1, 255],
  [GltfComponent.UnsignedShort]: [2, 65_535],
};
// biome-ignore format: a matrix reads as its four columns
const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Thrown inside {@link glbStreamFacts} for anything the runtime would not read: the answer is null. */
class Unreadable extends Error {}

/** A GLB's JSON and where its binary chunk's body lies in the file. */
interface GlbLayout {
  json: Json;
  bin: Uint8Array;
  /** The file offset of the BIN chunk's first byte. */
  binStart: number;
}

/** The layout of `bytes`, or null when it is not a GLB with a binary chunk. */
function glbLayout(bytes: Uint8Array): GlbLayout | null {
  if (!isGlb(bytes)) return null;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = data.getUint32(8, true);
  const jsonEnd = GLB_HEADER_BYTES + CHUNK_HEADER_BYTES + data.getUint32(GLB_HEADER_BYTES, true);
  const binStart = jsonEnd + CHUNK_HEADER_BYTES;
  if (length > bytes.byteLength || binStart > length) return null;
  if (data.getUint32(jsonEnd + U32_BYTES, true) !== CHUNK_BIN) return null;
  const binEnd = binStart + data.getUint32(jsonEnd, true);
  if (binEnd > length) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(GLB_HEADER_BYTES + CHUNK_HEADER_BYTES, jsonEnd),
    );
    const json = JSON.parse(text) as unknown;
    return isObject(json) ? { json, bin: bytes.subarray(binStart, binEnd), binStart } : null;
  } catch {
    return null;
  }
}

/** A required non-negative integer field (absent reads as `fallback`); a present malformed one is unreadable. */
function field(owner: Json, key: string, fallback?: number): number {
  const value = owner[key];
  if (value === undefined && fallback !== undefined) return fallback;
  const found = index(value);
  if (found === null) throw new Unreadable(`${key} is not a non-negative integer`);
  return found;
}

/** The file range of view `at`, checked to lie in the binary chunk. */
function viewRange(layout: GlbLayout, at: number): ByteRange {
  const view = objects(layout.json.bufferViews)[at];
  if (!view || field(view, "buffer") !== 0) throw new Unreadable(`view ${at} is not in the binary chunk`);
  const offset = field(view, "byteOffset", 0);
  const bytes = field(view, "byteLength");
  if (offset + bytes > layout.bin.byteLength) throw new Unreadable(`view ${at} lies past the binary chunk`);
  return { offset: layout.binStart + offset, bytes };
}

/** Ranges sorted by offset, overlapping and touching ones merged. */
function merged(ranges: readonly ByteRange[]): ByteRange[] {
  const sorted = [...ranges].filter((range) => range.bytes > 0).sort((a, b) => a.offset - b.offset);
  const out: ByteRange[] = [];
  for (const range of sorted) {
    const last = out.at(-1);
    if (last && range.offset <= last.offset + last.bytes) {
      last.bytes = Math.max(last.bytes, range.offset + range.bytes - last.offset);
    } else out.push({ ...range });
  }
  return out;
}

/** Every view a primitive's attributes and morph targets read. */
function vertexRanges(layout: GlbLayout, primitive: Json): ByteRange[] {
  const maps = [primitive.attributes, ...(Array.isArray(primitive.targets) ? primitive.targets : [])].filter(isObject);
  const ranges: ByteRange[] = [];
  for (const map of maps) {
    for (const at of Object.values(map)) {
      const accessor = objects(layout.json.accessors)[index(at) ?? -1];
      if (!accessor) throw new Unreadable("an attribute names no accessor");
      if (accessor.bufferView !== undefined) ranges.push(viewRange(layout, field(accessor, "bufferView")));
    }
  }
  return ranges;
}

/** Level 0 of a primitive: its own index list's bytes, or none for a primitive drawn in vertex order. */
function ownLevel(layout: GlbLayout, primitive: Json): { triangles: number; ranges: ByteRange[] } {
  const geometry = readGeometry(layout.json, layout.bin, primitive);
  if (!geometry) throw new Unreadable("a primitive is not plain triangles");
  const triangles = geometry.indices.length / TRIANGLE;
  if (primitive.indices === undefined) return { triangles, ranges: [] };
  const accessor = objects(layout.json.accessors)[field(primitive, "indices")];
  const width = INDEX_BYTES[Number(accessor?.componentType)];
  if (!accessor || !width) throw new Unreadable("an index accessor without a width");
  const view = viewRange(layout, field(accessor, "bufferView"));
  const offset = view.offset + field(accessor, "byteOffset", 0);
  const bytes = field(accessor, "count") * width;
  if (offset + bytes > view.offset + view.bytes) throw new Unreadable("an index accessor lies past its view");
  return { triangles, ranges: [{ offset, bytes }] };
}

/** A primitive's `genex_lods` levels as ranges, or null when it has none the runtime takes. */
function lodLevels(layout: GlbLayout, primitive: Json): Array<MeshLevelFacts> | null {
  if (readLodSet(layout.json, layout.bin, primitive).set === null) return null;
  const extras = (primitive.extras as Json)[LODS_EXTRAS_KEY] as Json;
  const view = viewRange(layout, field(extras, LodExtrasKey.Indices));
  return objects(extras[LodExtrasKey.Levels]).map((entry, at) => {
    const count = field(entry, LodLevelKey.Count);
    const offset = view.offset + field(entry, LodLevelKey.First) * U32_BYTES;
    return {
      level: at + 1,
      triangles: count / TRIANGLE,
      error: Number(entry[LodLevelKey.Error]),
      ranges: [{ offset, bytes: count * U32_BYTES }],
    };
  });
}

/** The file's levels coarse first: level 0 always, levels 1.. when every primitive has the same chain. */
function levelsOf(layout: GlbLayout, primitives: readonly Json[]): MeshLevelFacts[] {
  const own = primitives.map((primitive) => ownLevel(layout, primitive));
  const level0: MeshLevelFacts = {
    level: 0,
    triangles: own.reduce((sum, level) => sum + level.triangles, 0),
    error: 0,
    ranges: merged(own.flatMap((level) => level.ranges)),
  };
  const chains = primitives.map((primitive) => lodLevels(layout, primitive));
  const length = chains[0]?.length ?? 0;
  const whole = length > 0 && chains.every((chain) => chain !== null && chain.length === length);
  if (!whole) return [level0];
  const simplified = Array.from({ length }, (_, at) => {
    const rows = chains.map((chain) => chain?.[at]).filter((row): row is MeshLevelFacts => row !== undefined);
    return {
      level: at + 1,
      triangles: rows.reduce((sum, row) => sum + row.triangles, 0),
      error: Math.max(...rows.map((row) => row.error)),
      ranges: merged(rows.flatMap((row) => row.ranges)),
    };
  });
  return [...simplified.reverse(), level0];
}

/** A node's local transform as a column-major matrix: its `matrix`, or T·R·S. */
function localMatrix(node: Json): readonly number[] {
  const numbers = (value: unknown, length: number): number[] | null =>
    Array.isArray(value) && value.length === length && value.every((n) => typeof n === "number" && Number.isFinite(n))
      ? (value as number[])
      : null;
  const matrix = numbers(node.matrix, MAT4);
  if (matrix) return matrix;
  const [tx, ty, tz] = numbers(node.translation, 3) ?? [0, 0, 0];
  const [x, y, z, w] = numbers(node.rotation, 4) ?? [0, 0, 0, 1];
  const [sx, sy, sz] = numbers(node.scale, 3) ?? [1, 1, 1];
  // biome-ignore format: a matrix reads as its four columns
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function multiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(MAT4).fill(0);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++) out[col * 4 + row] += (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0);
  return out;
}

/**
 * Each mesh instance of the default scene with its world matrix (depth first, a node visited once
 * per path, cycles cut); every mesh once at identity when the file has no scene.
 */
function meshInstances(json: Json): Array<{ mesh: number; matrix: readonly number[] }> {
  const nodes = objects(json.nodes);
  const scene = objects(json.scenes)[index(json.scene) ?? 0];
  if (!scene) return objects(json.meshes).map((_, mesh) => ({ mesh, matrix: IDENTITY }));
  const found: Array<{ mesh: number; matrix: readonly number[] }> = [];
  const visit = (at: number, parent: readonly number[], path: ReadonlySet<number>) => {
    const node = nodes[at];
    if (!node || path.has(at)) return;
    const matrix = multiply(parent, localMatrix(node));
    const mesh = index(node.mesh);
    if (mesh !== null) found.push({ mesh, matrix });
    const below = new Set(path).add(at);
    for (const child of Array.isArray(node.children) ? node.children : []) visit(index(child) ?? -1, matrix, below);
  };
  for (const root of Array.isArray(scene.nodes) ? scene.nodes : []) visit(index(root) ?? -1, IDENTITY, new Set());
  return found;
}

/** TEXCOORD_0 as tight floats (float, or normalized unsigned byte or short), or null. */
function readUvs(doc: PackDoc, primitive: Json, count: number): Float32Array | null {
  const at = index(isObject(primitive.attributes) ? primitive.attributes[TEXCOORD_0] : undefined);
  const accessor = objects(doc.json.accessors)[at ?? -1];
  if (at === null || accessor?.type !== "VEC2" || index(accessor.count) !== count) return null;
  let bytes: Uint8Array;
  try {
    bytes = accessorData(doc, at);
  } catch {
    return null;
  }
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const floats = count * UV_FLOATS;
  if (accessor.componentType === GltfComponent.Float) {
    return Float32Array.from({ length: floats }, (_, i) => data.getFloat32(i * U32_BYTES, true));
  }
  const normalized = NORMALIZED_UV[Number(accessor.componentType)];
  if (!normalized || accessor.normalized !== true) return null;
  const [size, largest] = normalized;
  const read = (i: number) => (size === 1 ? data.getUint8(i) : data.getUint16(i * size, true));
  return Float32Array.from({ length: floats }, (_, i) => read(i) / largest);
}

type Vec3 = readonly [number, number, number];

/** A point through a column-major matrix. */
function transformed(m: readonly number[], positions: Float32Array, vertex: number): Vec3 {
  const x = positions[vertex * 3] ?? 0;
  const y = positions[vertex * 3 + 1] ?? 0;
  const z = positions[vertex * 3 + 2] ?? 0;
  const axis = (row: number) => (m[row] ?? 0) * x + (m[4 + row] ?? 0) * y + (m[8 + row] ?? 0) * z + (m[12 + row] ?? 0);
  return [axis(0), axis(1), axis(2)];
}

/** A triangle's area in space. */
function spaceArea(a: Vec3, b: Vec3, c: Vec3): number {
  const [ux, uy, uz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const [vx, vy, vz] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}

/** A triangle's area in UV space, its corners vertices `a`, `b`, `c` of `uvs`. */
function uvArea(uvs: Float32Array, a: number, b: number, c: number): number {
  const at = (vertex: number, axis: number) => uvs[vertex * UV_FLOATS + axis] ?? 0;
  const [ux, uy] = [at(b, 0) - at(a, 0), at(b, 1) - at(a, 1)];
  const [vx, vy] = [at(c, 0) - at(a, 0), at(c, 1) - at(a, 1)];
  return Math.abs(ux * vy - uy * vx) / 2;
}

/** One primitive's world and UV areas under `matrix`. */
function primitiveAreas(positions: Float32Array, uvs: Float32Array, indices: Uint32Array, matrix: readonly number[]) {
  let world = 0;
  let uv = 0;
  for (let t = 0; t + 2 < indices.length; t += TRIANGLE) {
    const [a, b, c] = [indices[t] ?? 0, indices[t + 1] ?? 0, indices[t + 2] ?? 0];
    world += spaceArea(
      transformed(matrix, positions, a),
      transformed(matrix, positions, b),
      transformed(matrix, positions, c),
    );
    uv += uvArea(uvs, a, b, c);
  }
  return { world, uv };
}

/** UV units per world unit over every instanced primitive with UVs; null without any. */
function uvDensity(layout: GlbLayout): number | null {
  const doc: PackDoc = { json: layout.json, bin: layout.bin, data: new Map() };
  const meshes = objects(layout.json.meshes);
  let world = 0;
  let uv = 0;
  for (const instance of meshInstances(layout.json)) {
    for (const primitive of objects(meshes[instance.mesh]?.primitives)) {
      const geometry = readGeometry(layout.json, layout.bin, primitive);
      const uvs = geometry ? readUvs(doc, primitive, geometry.positions.length / 3) : null;
      if (!geometry || !uvs) continue;
      const areas = primitiveAreas(geometry.positions, uvs, geometry.indices, instance.matrix);
      world += areas.world;
      uv += areas.uv;
    }
  }
  const density = Math.sqrt(uv / world);
  return world > 0 && Number.isFinite(density) ? density : null;
}

/** The streaming facts of a GLB's bytes, or null when the runtime would not read it as plain triangles. */
export function glbStreamFacts(bytes: Uint8Array): MeshFacts | null {
  const layout = glbLayout(bytes);
  if (!layout) return null;
  const primitives = objects(layout.json.meshes).flatMap((mesh) => objects(mesh.primitives));
  if (primitives.length === 0) return null;
  try {
    const levels = levelsOf(layout, primitives);
    return {
      triangles: levels.at(-1)?.triangles ?? 0,
      uvDensity: uvDensity(layout),
      head: { offset: 0, bytes: layout.binStart },
      vertices: merged(primitives.flatMap((primitive) => vertexRanges(layout, primitive))),
      levels,
    };
  } catch (error) {
    if (error instanceof Unreadable) return null;
    throw error;
  }
}

/**
 * The levels of a KTX2 from its first bytes (header and level index), smallest first, or null when
 * the head is not a KTX2 or its level index does not fit `fileBytes`.
 */
export function ktx2LevelFacts(head: Uint8Array, fileBytes: number): TextureLevelFacts[] | null {
  const header = readKtx2Header(head);
  if (!header || header.levels === 0) return null;
  if (KTX2_HEADER_BYTES + header.levels * KTX2_LEVEL_ENTRY_BYTES > head.byteLength) return null;
  const data = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const levels: TextureLevelFacts[] = [];
  for (let level = 0; level < header.levels; level++) {
    const entry = KTX2_HEADER_BYTES + level * KTX2_LEVEL_ENTRY_BYTES;
    const offset = Number(data.getBigUint64(entry, true));
    const bytes = Number(data.getBigUint64(entry + 8, true));
    if (offset + bytes > fileBytes) return null;
    levels.push({ px: Math.max(1, header.width >> level), offset, bytes });
  }
  return levels.reverse();
}

/** The bytes {@link ktx2LevelFacts} needs of a KTX2 with at most `levels` levels. */
export function ktx2HeadBytes(levels: number): number {
  return KTX2_HEADER_BYTES + levels * KTX2_LEVEL_ENTRY_BYTES;
}
