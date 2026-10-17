/**
 * Import-time meshlets (R2.3): a GLB at or above the triangle threshold is clustered with
 * meshoptimizer's clusterizer (the build `three` ships, `decoders.ts`) and each primitive gets
 * `extras.genex_meshlets`, the schema in `native/genex-rust/crates/genex-render/README.md`. Never
 * an extension, never in `extensionsRequired`: any glTF reader still draws the primitive, and the
 * Rust runtime validates the set again at load (`meshlet::validate`) and clusters at runtime when
 * it is absent or invalid.
 *
 * The rule is all or nothing per GLB, like the runtime's (it merges a GLB's primitives into one
 * mesh): when any primitive cannot be read or the result does not validate, the GLB is returned
 * unchanged. An optional step never refuses an import. The output is a pure function of the input.
 */
import {
  MESHLET_MAX_TRIANGLES,
  MESHLET_MAX_VERTICES,
  MESHLET_MIN_TRIANGLES_DEFAULT,
  MESHLET_RECORD_BYTES,
  MESHLET_SCHEMA_VERSION,
  MESHLETS_EXTRAS_KEY,
  MeshletFault,
} from "../../shared/render-quality.ts";
import { meshoptClusterizer } from "./decoders.ts";
import { type GltfJson, readGlb, writeGlb } from "./glb.ts";

// The schema's vocabulary lives once, in the shared table the Rust runtime is held to
// (`genex-toml.test.ts`, `crates/genex/tests/vocabulary.rs`); the importer re-exports it.
export {
  MESHLET_MAX_TRIANGLES,
  MESHLET_MAX_VERTICES,
  MESHLET_RECORD_BYTES,
  MESHLET_SCHEMA_VERSION,
  MESHLETS_EXTRAS_KEY,
  MeshletFault,
};
/** The fewest triangles a GLB needs to be clustered: the runtime's `DEFAULT_MESHLET_MIN_TRIANGLES`. */
export const MESHLET_MIN_TRIANGLES = MESHLET_MIN_TRIANGLES_DEFAULT;
/** The most triangles the importer clusters; a bigger GLB is delivered as it is and clustered at runtime. */
export const MESHLET_MAX_IMPORT_TRIANGLES = 4_000_000;
/** meshoptimizer's cone weight: 0 builds the most compact meshlets, 1 the tightest cones. */
const CONE_WEIGHT = 0.25;

/** Why {@link addMeshletExtras} returned the GLB unchanged. */
export const MeshletSkip = {
  BelowThreshold: "below-threshold",
  AboveCeiling: "above-ceiling",
  AlreadyClustered: "already-clustered",
  UnreadableGeometry: "unreadable-geometry",
  NoClusterizer: "no-clusterizer",
  Invalid: "invalid",
} as const;
export type MeshletSkip = (typeof MeshletSkip)[keyof typeof MeshletSkip];

/** One meshlet record (the runtime's `GpuMeshlet`). */
export interface Meshlet {
  /** Object-space bounding sphere: centre xyz, radius. */
  bounds: readonly [number, number, number, number];
  /** Normal cone: unit axis xyz, cutoff (1 means no cone). */
  cone: readonly [number, number, number, number];
  /** First entry of the meshlet's vertices in `MeshletSet.vertices`. */
  vertexOffset: number;
  /** First entry of the meshlet's packed triangles in `MeshletSet.triangles`. */
  triangleOffset: number;
  vertexCount: number;
  triangleCount: number;
}

/** One primitive's meshlets: offsets index this set's own `vertices` and `triangles`. */
export interface MeshletSet {
  meshlets: Meshlet[];
  /** Primitive vertex index of each meshlet vertex. */
  vertices: number[];
  /** Packed meshlet-local triangles ({@link packTriangle}). */
  triangles: number[];
}

/** A triangle's three meshlet-local indices in one `u32`, low byte first. */
export const packTriangle = ([a, b, c]: readonly [number, number, number]): number => (a | (b << 8) | (c << 16)) >>> 0;

/** A triangle with its winding kept, rotated so its smallest index comes first. */
function canonical(a: number, b: number, c: number): string {
  if (a <= b && a <= c) return `${a},${b},${c}`;
  return b <= c ? `${b},${c},${a}` : `${c},${a},${b}`;
}

/** The checks on one meshlet's counts and that its ranges continue where the previous one ended. */
function rangeFault(meshlet: Meshlet, next: readonly [number, number], set: MeshletSet): MeshletFault | null {
  const { vertexCount, triangleCount, vertexOffset, triangleOffset } = meshlet;
  const countsFit =
    vertexCount >= 1 &&
    vertexCount <= MESHLET_MAX_VERTICES &&
    triangleCount >= 1 &&
    triangleCount <= MESHLET_MAX_TRIANGLES;
  if (!countsFit) return MeshletFault.OverLimit;
  if (vertexOffset + vertexCount > set.vertices.length || triangleOffset + triangleCount > set.triangles.length) {
    return MeshletFault.RangeOutOfBounds;
  }
  if (vertexOffset !== next[0] || triangleOffset !== next[1]) return MeshletFault.RangesNotTiled;
  return null;
}

/** One meshlet's triangles in primitive vertices, or the fault that refuses it. */
function meshletTriangles(meshlet: Meshlet, set: MeshletSet, meshVertices: number): string[] | MeshletFault {
  const local = set.vertices.slice(meshlet.vertexOffset, meshlet.vertexOffset + meshlet.vertexCount);
  if (local.some((vertex) => vertex >= meshVertices)) return MeshletFault.VertexOutOfMesh;
  const found: string[] = [];
  for (const packed of set.triangles.slice(meshlet.triangleOffset, meshlet.triangleOffset + meshlet.triangleCount)) {
    const a = packed & 0xff;
    const b = (packed >>> 8) & 0xff;
    const c = (packed >>> 16) & 0xff;
    const fits = a < meshlet.vertexCount && b < meshlet.vertexCount && c < meshlet.vertexCount;
    if (packed >>> 24 !== 0 || !fits) return MeshletFault.LocalIndexOutOfMeshlet;
    found.push(canonical(local[a] ?? 0, local[b] ?? 0, local[c] ?? 0));
  }
  return found;
}

/**
 * Check `set` against the mesh it claims to cover, as the runtime's `meshlet::validate` does:
 * limits, in-bounds ranges that tile both buffers in order, vertex and local indices in range, and
 * every mesh triangle (winding kept) in exactly one meshlet. Null when it holds.
 */
export function validateMeshletSet(
  set: MeshletSet,
  indices: ArrayLike<number>,
  meshVertices: number,
): MeshletFault | null {
  let next: readonly [number, number] = [0, 0];
  const covered: string[] = [];
  for (const meshlet of set.meshlets) {
    const fault = rangeFault(meshlet, next, set);
    if (fault) return fault;
    const triangles = meshletTriangles(meshlet, set, meshVertices);
    if (typeof triangles === "string") return triangles;
    for (const triangle of triangles) covered.push(triangle);
    next = [meshlet.vertexOffset + meshlet.vertexCount, meshlet.triangleOffset + meshlet.triangleCount];
  }
  if (next[0] !== set.vertices.length || next[1] !== set.triangles.length) return MeshletFault.RangesNotTiled;
  if (covered.length !== indices.length / 3) return MeshletFault.TrianglesDiffer;
  const mesh: string[] = [];
  for (let at = 0; at + 2 < indices.length; at += 3) {
    mesh.push(canonical(indices[at] ?? 0, indices[at + 1] ?? 0, indices[at + 2] ?? 0));
  }
  mesh.sort();
  covered.sort();
  return mesh.every((triangle, at) => triangle === covered[at]) ? null : MeshletFault.TrianglesDiffer;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const objects = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : []);
const index = (value: unknown): number | null =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;

const GLTF_TRIANGLES = 4;
const COMPONENT_FLOAT = 5126;
const INDEX_COMPONENT_BYTES: Readonly<Record<number, number>> = { 5121: 1, 5123: 2, 5125: 4 };
const FLOAT_BYTES = 4;
const POSITION_FLOATS = 3;
const U32_BYTES = 4;

/** A primitive's geometry as the clusterizer and the simplifier take it: tight positions and a triangle list. */
export interface Geometry {
  positions: Float32Array;
  indices: Uint32Array;
}

/** The bytes an accessor addresses: its view's slice from the accessor's offset, with the view's stride. */
function accessorBytes(
  json: Json,
  bin: Uint8Array,
  accessor: Json,
  elementBytes: number,
): { data: Uint8Array; stride: number; count: number } | null {
  const count = index(accessor.count);
  const view = objects(json.bufferViews)[index(accessor.bufferView) ?? -1];
  if (count === null || !view || accessor.sparse !== undefined || index(view.buffer) !== 0) return null;
  const start = (index(view.byteOffset) ?? 0) + (index(accessor.byteOffset) ?? 0);
  const stride = index(view.byteStride) || elementBytes;
  const viewEnd = (index(view.byteOffset) ?? 0) + (index(view.byteLength) ?? 0);
  const end = count === 0 ? start : start + (count - 1) * stride + elementBytes;
  if (stride < elementBytes || end > viewEnd || viewEnd > bin.byteLength) return null;
  return { data: bin.subarray(start, end), stride, count };
}

/** POSITION as tight floats, or null when it is not a plain float VEC3 the runtime reads the same way. */
function readPositions(json: Json, bin: Uint8Array, accessor: Json | undefined): Float32Array | null {
  if (!accessor || accessor.componentType !== COMPONENT_FLOAT || accessor.type !== "VEC3") return null;
  const found = accessorBytes(json, bin, accessor, POSITION_FLOATS * FLOAT_BYTES);
  if (!found) return null;
  const view = new DataView(found.data.buffer, found.data.byteOffset, found.data.byteLength);
  const out = new Float32Array(found.count * POSITION_FLOATS);
  for (let vertex = 0; vertex < found.count; vertex++) {
    for (let axis = 0; axis < POSITION_FLOATS; axis++) {
      out[vertex * POSITION_FLOATS + axis] = view.getFloat32(vertex * found.stride + axis * FLOAT_BYTES, true);
    }
  }
  return out.every(Number.isFinite) ? out : null;
}

/** One index of `width` bytes at `offset`. */
function indexAt(view: DataView, width: number, offset: number): number {
  if (width === 1) return view.getUint8(offset);
  return width === 2 ? view.getUint16(offset, true) : view.getUint32(offset, true);
}

/** The indices accessor's values, or null when it is not a plain unsigned scalar the runtime reads. */
function readIndexAccessor(json: Json, bin: Uint8Array, primitive: Json): Uint32Array | null {
  const accessor = objects(json.accessors)[index(primitive.indices) ?? -1];
  const width = INDEX_COMPONENT_BYTES[Number(accessor?.componentType)];
  if (!accessor || !width || accessor.type !== "SCALAR") return null;
  const found = accessorBytes(json, bin, accessor, width);
  if (!found) return null;
  const view = new DataView(found.data.buffer, found.data.byteOffset, found.data.byteLength);
  return Uint32Array.from({ length: found.count }, (_, at) => indexAt(view, width, at * found.stride));
}

/** The triangle list: the indices accessor, or the vertices in order when the primitive has none. */
function readIndices(json: Json, bin: Uint8Array, primitive: Json, vertexCount: number): Uint32Array | null {
  const indices =
    primitive.indices === undefined
      ? Uint32Array.from({ length: vertexCount }, (_, at) => at)
      : readIndexAccessor(json, bin, primitive);
  const whole = indices !== null && indices.length % 3 === 0;
  return whole && indices.every((vertex) => vertex < vertexCount) ? indices : null;
}

/** One primitive's geometry, or null when the runtime would not read it as plain triangles. */
export function readGeometry(json: Json, bin: Uint8Array, primitive: Json): Geometry | null {
  if ((primitive.mode ?? GLTF_TRIANGLES) !== GLTF_TRIANGLES) return null;
  const attributes = isObject(primitive.attributes) ? primitive.attributes : {};
  const positions = readPositions(json, bin, objects(json.accessors)[index(attributes.POSITION) ?? -1]);
  if (!positions) return null;
  const indices = readIndices(json, bin, primitive, positions.length / POSITION_FLOATS);
  return indices ? { positions, indices } : null;
}

/** meshoptimizer's meshlets of one primitive in the schema's layout, with the bounds and cones. */
async function clusterPrimitive(geometry: Geometry): Promise<MeshletSet> {
  const clusterizer = await meshoptClusterizer();
  const { positions, indices } = geometry;
  const built = clusterizer.buildMeshlets(
    indices,
    positions,
    POSITION_FLOATS,
    MESHLET_MAX_VERTICES,
    MESHLET_MAX_TRIANGLES,
    CONE_WEIGHT,
  );
  const bounds = clusterizer.computeMeshletBounds(built, positions, POSITION_FLOATS);
  const set: MeshletSet = { meshlets: [], vertices: [], triangles: [] };
  for (let at = 0; at < built.meshletCount; at++) {
    const [vertexOffset = 0, triangleOffset = 0, vertexCount = 0, triangleCount = 0] = built.meshlets.subarray(
      at * 4,
      at * 4 + 4,
    );
    const sphere = bounds[at];
    const hasCone =
      sphere !== undefined &&
      [sphere.coneAxisX, sphere.coneAxisY, sphere.coneAxisZ, sphere.coneCutoff].every(Number.isFinite);
    set.meshlets.push({
      bounds: sphere ? [sphere.centerX, sphere.centerY, sphere.centerZ, sphere.radius] : [0, 0, 0, 0],
      cone:
        sphere && hasCone
          ? [sphere.coneAxisX, sphere.coneAxisY, sphere.coneAxisZ, Math.min(1, Math.max(-1, sphere.coneCutoff))]
          : [0, 0, 1, 1],
      vertexOffset: set.vertices.length,
      triangleOffset: set.triangles.length,
      vertexCount,
      triangleCount,
    });
    for (let v = 0; v < vertexCount; v++) set.vertices.push(built.vertices[vertexOffset + v] ?? 0);
    for (let t = 0; t < triangleCount; t++) {
      const first = triangleOffset + t * 3;
      set.triangles.push(
        packTriangle([built.triangles[first] ?? 0, built.triangles[first + 1] ?? 0, built.triangles[first + 2] ?? 0]),
      );
    }
  }
  return set;
}

/** The three little-endian views of a set: records, vertex ids, packed triangles. */
function setViews(set: MeshletSet): { meshlets: Uint8Array; vertices: Uint8Array; triangles: Uint8Array } {
  const records = new DataView(new ArrayBuffer(set.meshlets.length * MESHLET_RECORD_BYTES));
  set.meshlets.forEach((meshlet, at) => {
    const base = at * MESHLET_RECORD_BYTES;
    for (const [i, value] of [...meshlet.bounds, ...meshlet.cone].entries())
      records.setFloat32(base + i * 4, value, true);
    const counts = [meshlet.vertexOffset, meshlet.triangleOffset, meshlet.vertexCount, meshlet.triangleCount];
    for (const [i, value] of counts.entries()) records.setUint32(base + 32 + i * 4, value, true);
  });
  const words = (values: readonly number[]) => {
    const out = new DataView(new ArrayBuffer(values.length * U32_BYTES));
    for (const [i, value] of values.entries()) out.setUint32(i * U32_BYTES, value, true);
    return new Uint8Array(out.buffer);
  };
  return { meshlets: new Uint8Array(records.buffer), vertices: words(set.vertices), triangles: words(set.triangles) };
}

const padded = (size: number) => Math.ceil(size / 4) * 4;

/** What {@link addMeshletExtras} did: the bytes to deliver and whether they carry meshlets. */
export type MeshletOutcome =
  | { bytes: Uint8Array; clustered: true }
  | { bytes: Uint8Array; clustered: false; reason: MeshletSkip };

/** The primitives of every mesh, in document order. */
const primitivesOf = (json: Json): Json[] => objects(json.meshes).flatMap((mesh) => objects(mesh.primitives));

/** What the primitives' `extras` allow: a new `genex_meshlets` key, one already there, or none (not an object). */
const ExtrasState = {
  Free: "free",
  Clustered: "clustered",
  Foreign: "foreign",
} as const;
type ExtrasState = (typeof ExtrasState)[keyof typeof ExtrasState];

/** Whether any primitive's extras already name `genex_meshlets`, or hold something extras cannot gain a key on. */
function extrasState(primitives: Json[]): ExtrasState {
  let state: ExtrasState = ExtrasState.Free;
  for (const primitive of primitives) {
    if (primitive.extras === undefined) continue;
    if (!isObject(primitive.extras)) state = ExtrasState.Foreign;
    else if (MESHLETS_EXTRAS_KEY in primitive.extras) return ExtrasState.Clustered;
  }
  return state;
}

/**
 * `glb` with `genex_meshlets` extras on every primitive when its triangles together reach
 * `minTriangles`; otherwise the same bytes with the reason. Never throws for the GLB's own
 * contents: an unreadable or non-validating result leaves the GLB as delivered.
 */
export async function addMeshletExtras(
  glb: Uint8Array,
  options: { minTriangles?: number } = {},
): Promise<MeshletOutcome> {
  const skip = (reason: MeshletSkip): MeshletOutcome => ({ bytes: glb, clustered: false, reason });
  let parts: { json: GltfJson; bin: Uint8Array };
  try {
    parts = readGlb(glb);
  } catch {
    return skip(MeshletSkip.UnreadableGeometry);
  }
  const json = structuredClone(parts.json) as Json;
  const primitives = primitivesOf(json);
  if (!primitives.length) return skip(MeshletSkip.BelowThreshold);
  const state = extrasState(primitives);
  if (state === ExtrasState.Clustered) return skip(MeshletSkip.AlreadyClustered);
  if (state === ExtrasState.Foreign) return skip(MeshletSkip.UnreadableGeometry);
  const geometry = primitives.map((primitive) => readGeometry(json, parts.bin, primitive));
  const found = geometry.filter((each): each is Geometry => each !== null);
  if (found.length !== geometry.length) return skip(MeshletSkip.UnreadableGeometry);
  const triangles = found.reduce((sum, each) => sum + each.indices.length / 3, 0);
  if (triangles < (options.minTriangles ?? MESHLET_MIN_TRIANGLES)) return skip(MeshletSkip.BelowThreshold);
  if (triangles > MESHLET_MAX_IMPORT_TRIANGLES) return skip(MeshletSkip.AboveCeiling);
  const sets: MeshletSet[] = [];
  try {
    for (const each of found) sets.push(await clusterPrimitive(each));
  } catch {
    return skip(MeshletSkip.NoClusterizer);
  }
  const invalid = sets.some(
    (set, at) =>
      validateMeshletSet(set, found[at]?.indices ?? [], (found[at]?.positions.length ?? 0) / POSITION_FLOATS) !== null,
  );
  if (invalid) return skip(MeshletSkip.Invalid);
  return { bytes: writeExtras(json, parts.bin, primitives, sets), clustered: true };
}

/** `json` and `bin` with each primitive's set appended as three buffer views and named in its extras. */
function writeExtras(json: Json, bin: Uint8Array, primitives: Json[], sets: MeshletSet[]): Uint8Array {
  const views = objects(json.bufferViews);
  const chunks: Uint8Array[] = [];
  let length = padded(bin.byteLength);
  const append = (data: Uint8Array): number => {
    views.push({ buffer: 0, byteOffset: length, byteLength: data.byteLength });
    chunks.push(data, new Uint8Array(padded(data.byteLength) - data.byteLength));
    length += padded(data.byteLength);
    return views.length - 1;
  };
  primitives.forEach((primitive, at) => {
    const set = sets[at];
    if (!set) return;
    const data = setViews(set);
    const meshlets = append(data.meshlets);
    const vertices = append(data.vertices);
    const triangles = append(data.triangles);
    const extras = isObject(primitive.extras) ? primitive.extras : {};
    primitive.extras = {
      ...extras,
      [MESHLETS_EXTRAS_KEY]: {
        version: MESHLET_SCHEMA_VERSION,
        max_vertices: MESHLET_MAX_VERTICES,
        max_triangles: MESHLET_MAX_TRIANGLES,
        meshlets,
        vertices,
        triangles,
      },
    };
  });
  const out = new Uint8Array(length);
  out.set(bin);
  let cursor = padded(bin.byteLength);
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  const buffers = objects(json.buffers);
  json.bufferViews = views;
  json.buffers = [{ ...(buffers[0] ?? {}), byteLength: length }, ...buffers.slice(1)];
  return writeGlb(json, out);
}

/**
 * The set a primitive's `genex_meshlets` extras name, read back from the GLB's views (the importer's
 * own check, and the tests'): the set, or the fault the extras are refused with. A primitive
 * without the extras has `{ set: null }`.
 */
export function readMeshletSet(
  json: Json,
  bin: Uint8Array,
  primitive: number,
  mesh = 0,
): { set: MeshletSet | null } | { fault: MeshletFault } {
  const owner = objects(objects(json.meshes)[mesh]?.primitives)[primitive];
  const extras = isObject(owner?.extras) ? owner.extras[MESHLETS_EXTRAS_KEY] : undefined;
  if (!isObject(extras)) return { set: null };
  if (extras.version !== MESHLET_SCHEMA_VERSION) return { fault: MeshletFault.UnknownVersion };
  const viewBytes = (key: string): Uint8Array | null => {
    const view = objects(json.bufferViews)[index(extras[key]) ?? -1];
    const start = index(view?.byteOffset) ?? 0;
    const size = index(view?.byteLength);
    if (!view || size === null || start + size > bin.byteLength) return null;
    return bin.subarray(start, start + size);
  };
  const [records, vertices, triangles] = [viewBytes("meshlets"), viewBytes("vertices"), viewBytes("triangles")];
  const aligned = records && vertices && triangles;
  if (!aligned || records.byteLength % MESHLET_RECORD_BYTES || vertices.byteLength % 4 || triangles.byteLength % 4) {
    return { fault: MeshletFault.RangeOutOfBounds };
  }
  const reader = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const words = (bytes: Uint8Array) =>
    Array.from({ length: bytes.byteLength / 4 }, (_, i) => reader(bytes).getUint32(i * 4, true));
  const table = reader(records);
  const set: MeshletSet = { meshlets: [], vertices: words(vertices), triangles: words(triangles) };
  for (let at = 0; at < records.byteLength / MESHLET_RECORD_BYTES; at++) {
    const base = at * MESHLET_RECORD_BYTES;
    const float = (i: number) => table.getFloat32(base + i * 4, true);
    const word = (i: number) => table.getUint32(base + 32 + i * 4, true);
    set.meshlets.push({
      bounds: [float(0), float(1), float(2), float(3)],
      cone: [float(4), float(5), float(6), float(7)],
      vertexOffset: word(0),
      triangleOffset: word(1),
      vertexCount: word(2),
      triangleCount: word(3),
    });
  }
  return { set };
}
