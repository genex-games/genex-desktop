/**
 * Import-time LODs (renderer pass 2, A6.9; attribute-aware since LOD-09): a GLB of at least
 * {@link LOD_MIN_TRIANGLES} triangles gets `extras.genex_lods` on every primitive, the schema in
 * `native/genex-rust/crates/genex-render/README.md`. Each level is simplified from the primitive's
 * own triangles by meshoptimizer's simplifier (npm `meshoptimizer` 1.3.0, `decoders.ts`) to half the
 * previous level's target, weighing the primitive's normals and first texture coordinates beside
 * its positions so a collapse that would slide the texture or bend the shading costs what it does.
 * Vertices that also lie in another primitive are locked, so primitives that meet stay joined, and
 * so are leaf cards' (`lod-cards.ts`), so foliage keeps its area; a primitive's own open borders may
 * simplify. Levels from the second on may drop small disconnected
 * parts, and a double-sided material's folds are kept.
 *
 * Each level carries its object-space error: the largest of meshoptimizer's error times the mesh's
 * extent, how far the primitive's vertices lie from the level (`lod-deviation.ts`) and the level
 * before's error. The chain's length is the GLB's largest primitive's (levels stop when one is no
 * longer markedly coarser, its error passes {@link LOD_MAX_RELATIVE_ERROR}, or at
 * {@link LOD_MAX_LEVELS}); a primitive that cannot be simplified that far repeats its last level,
 * so every primitive has the same number. Never an extension, never in `extensionsRequired`: any
 * glTF reader still draws the primitive whole, and the runtime validates the levels again.
 *
 * All or nothing per GLB, like the meshlets step: when any primitive cannot be read, the GLB is
 * returned unchanged with the reason. The output is a pure function of the input.
 */
import {
  LOD_MAX_LEVELS,
  LOD_MIN_TRIANGLES,
  LOD_SCHEMA_VERSION,
  LodExtrasKey,
  LodFault,
  LodLevelKey,
  LODS_EXTRAS_KEY,
} from "../../shared/render-quality.ts";
import { MeshoptSimplifyFlag, meshoptSimplifier } from "./decoders.ts";
import { GltfComponent, type GltfJson, readGlb, writeGlb } from "./glb.ts";
import { index, isObject, type Json, objects } from "./gltf-json.ts";
import { findCards } from "./lod-cards.ts";
import { vertexDeviation } from "./lod-deviation.ts";
import { type Geometry, readGeometry } from "./meshlets.ts";
import { accessorData, type PackDoc } from "./prune.ts";

/** Each level aims at this share of the previous level's triangles. */
const LOD_RATIO = 0.5;
/** A level must keep at most this share of the previous one's triangles to count as coarser. */
const LOD_MIN_REDUCTION = 0.85;
/** The coarsest error a level may have, relative to the mesh's extent. */
export const LOD_MAX_RELATIVE_ERROR = 0.1;
/** How much a unit of normal difference weighs against a unit of position error (Godot's and kansei's choice). */
const NORMAL_WEIGHT = 0.5;
/** How much a unit of texture-coordinate difference weighs against a unit of position error. */
const UV_WEIGHT = 1;
/** The first level (1-based) that may drop small disconnected parts. */
const PRUNE_FROM_LEVEL = 2;
/** `vertexLock` value that keeps a vertex in place (meshoptimizer's `meshopt_SimplifyVertex_Lock`). */
const VERTEX_LOCKED = 1;
const NORMAL = "NORMAL";
const TEXCOORD_0 = "TEXCOORD_0";
const U32_BYTES = 4;
const TRIANGLE = 3;
const NORMAL_FLOATS = 3;
const UV_FLOATS = 2;
/** The glTF accessor type of each attribute width read here. */
const VECTOR_TYPE: Readonly<Record<number, string>> = { [UV_FLOATS]: "VEC2", [NORMAL_FLOATS]: "VEC3" };
/** Each normalized integer component type's reader and its largest value (glTF 3.11). */
const NORMALIZED: Readonly<Record<number, readonly [number, (data: DataView, at: number) => number, number]>> = {
  [GltfComponent.UnsignedByte]: [1, (data, at) => data.getUint8(at), 255],
  [GltfComponent.UnsignedShort]: [2, (data, at) => data.getUint16(at, true), 65_535],
};

/** Why {@link addLodExtras} returned the GLB unchanged. */
export const LodSkip = {
  BelowThreshold: "below-threshold",
  AlreadySimplified: "already-simplified",
  UnreadableGeometry: "unreadable-geometry",
  NoSimplifier: "no-simplifier",
  NotCoarser: "not-coarser",
} as const;
export type LodSkip = (typeof LodSkip)[keyof typeof LodSkip];

/** One level: its triangle list (primitive vertex indices) and its object-space error. */
export interface LodLevel {
  indices: Uint32Array;
  error: number;
}

/** One primitive's levels, coarser and coarser. */
export interface LodSet {
  levels: LodLevel[];
}

/** What {@link addLodExtras} did: the bytes to deliver and whether they carry levels. */
export type LodOutcome =
  | { bytes: Uint8Array; simplified: true }
  | { bytes: Uint8Array; simplified: false; reason: LodSkip };

const primitivesOf = (json: Json): Json[] => objects(json.meshes).flatMap((mesh) => objects(mesh.primitives));
const padded = (size: number) => Math.ceil(size / U32_BYTES) * U32_BYTES;

/**
 * Null when `set` is a chain the runtime takes for a primitive of `vertexCount` vertices: at most
 * {@link LOD_MAX_LEVELS} levels of whole triangles, each no finer than the one before, errors
 * finite, never negative and never smaller than the one before, every index a vertex.
 */
export function validateLodSet(set: LodSet, vertexCount: number): LodFault | null {
  if (set.levels.length > LOD_MAX_LEVELS) return LodFault.OverLimit;
  let previous: LodLevel | null = null;
  for (const level of set.levels) {
    const whole = level.indices.length > 0 && level.indices.length % TRIANGLE === 0;
    const errorOk = Number.isFinite(level.error) && level.error >= (previous?.error ?? 0);
    const coarser = previous === null || level.indices.length <= previous.indices.length;
    if (!whole || !errorOk || !coarser) return LodFault.NotCoarser;
    if (level.indices.some((vertex) => vertex >= vertexCount)) return LodFault.VertexOutOfMesh;
    previous = level;
  }
  return null;
}

/** One primitive as the simplifier takes it: geometry, weighed attributes, locks and flags. */
interface SimplifyInput {
  geometry: Geometry;
  /** Per vertex: the normal (when the primitive has one), then UV0 (when it has one). */
  attributes: Float32Array;
  stride: number;
  weights: number[];
  lock: Uint8Array;
  doubleSided: boolean;
}

/** A float or normalized-integer attribute of `width` components as tight floats, or null. */
function attributeFloats(doc: PackDoc, at: unknown, width: number, count: number): Float32Array | null {
  const found = index(at);
  const accessor = objects(doc.json.accessors)[found ?? -1];
  const shaped = accessor !== undefined && accessor.type === VECTOR_TYPE[width] && index(accessor.count) === count;
  if (found === null || !shaped) return null;
  let bytes: Uint8Array;
  try {
    bytes = accessorData(doc, found);
  } catch {
    return null;
  }
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (accessor.componentType === GltfComponent.Float) {
    return bytes.byteLength === count * width * 4
      ? Float32Array.from({ length: count * width }, (_, i) => data.getFloat32(i * 4, true))
      : null;
  }
  const normalized = NORMALIZED[Number(accessor.componentType)];
  if (!normalized || accessor.normalized !== true || bytes.byteLength !== count * width * normalized[0]) return null;
  const [size, read, largest] = normalized;
  return Float32Array.from({ length: count * width }, (_, i) => read(data, i * size) / largest);
}

/** The primitive's normal and UV0 interleaved with their weights; absent ones are left out. */
function weighedAttributes(
  doc: PackDoc,
  primitive: Json,
  count: number,
): Pick<SimplifyInput, "attributes" | "stride" | "weights"> {
  const attributes = isObject(primitive.attributes) ? primitive.attributes : {};
  const streams = [
    {
      values: attributeFloats(doc, attributes[NORMAL], NORMAL_FLOATS, count),
      width: NORMAL_FLOATS,
      weight: NORMAL_WEIGHT,
    },
    { values: attributeFloats(doc, attributes[TEXCOORD_0], UV_FLOATS, count), width: UV_FLOATS, weight: UV_WEIGHT },
  ].filter((stream): stream is { values: Float32Array; width: number; weight: number } => stream.values !== null);
  const stride = streams.reduce((sum, stream) => sum + stream.width, 0);
  const out = new Float32Array(count * stride);
  let offset = 0;
  for (const stream of streams) {
    for (let vertex = 0; vertex < count; vertex++)
      out.set(stream.values.subarray(vertex * stream.width, (vertex + 1) * stream.width), vertex * stride + offset);
    offset += stream.width;
  }
  return { attributes: out, stride, weights: streams.flatMap((stream) => Array(stream.width).fill(stream.weight)) };
}

/** A position's key: its three floats, -0 read as 0. */
const positionKey = (positions: Float32Array, vertex: number) =>
  `${(positions[vertex * 3] ?? 0) + 0},${(positions[vertex * 3 + 1] ?? 0) + 0},${(positions[vertex * 3 + 2] ?? 0) + 0}`;

/** The vertices a primitive's triangles use, each once, in first-use order. */
function usedVertices(geometry: Geometry): number[] {
  const seen = new Uint8Array(geometry.positions.length / 3);
  const used: number[] = [];
  for (const vertex of geometry.indices) {
    if (seen[vertex]) continue;
    seen[vertex] = 1;
    used.push(vertex);
  }
  return used;
}

/**
 * Per primitive, 1 on each vertex its triangles use whose position another primitive's triangles
 * also use: where primitives meet. Primitives sharing one vertex buffer count only what they draw.
 */
function sharedVertexLocks(geometry: readonly Geometry[]): Uint8Array[] {
  const owners = new Map<string, number>();
  const used = geometry.map(usedVertices);
  used.forEach((vertices, primitive) => {
    for (const vertex of vertices) {
      const key = positionKey(geometry[primitive]?.positions ?? new Float32Array(), vertex);
      const owner = owners.get(key);
      if (owner === undefined) owners.set(key, primitive);
      else if (owner !== primitive) owners.set(key, -1);
    }
  });
  return geometry.map((each, primitive) => {
    const lock = new Uint8Array(each.positions.length / 3);
    for (const vertex of used[primitive] ?? [])
      if (owners.get(positionKey(each.positions, vertex)) === -1) lock[vertex] = VERTEX_LOCKED;
    return lock;
  });
}

/** Whether the primitive's material draws both faces. */
function isDoubleSided(json: Json, primitive: Json): boolean {
  return objects(json.materials)[index(primitive.material) ?? -1]?.doubleSided === true;
}

/** The simplifier's options for the 1-based level `level`. */
function flagsFor(input: SimplifyInput, level: number): MeshoptSimplifyFlag[] {
  const flags: MeshoptSimplifyFlag[] = [MeshoptSimplifyFlag.ErrorClamped];
  if (level >= PRUNE_FROM_LEVEL) flags.push(MeshoptSimplifyFlag.Prune);
  if (input.doubleSided) flags.push(MeshoptSimplifyFlag.PreserveFolds);
  return flags;
}

/** One simplification of `indices` to `share` of its triangles: the indices and the relative error. */
async function simplifyTo(
  input: SimplifyInput,
  indices: Uint32Array,
  share: number,
  level: number,
): Promise<[Uint32Array, number]> {
  const simplifier = await meshoptSimplifier();
  const target = Math.floor((indices.length * share) / TRIANGLE) * TRIANGLE;
  return simplifier.simplifyWithAttributes(
    indices,
    input.geometry.positions,
    TRIANGLE,
    input.attributes,
    input.stride,
    input.weights,
    input.lock,
    target,
    LOD_MAX_RELATIVE_ERROR,
    flagsFor(input, level),
  );
}

/** The levels of one primitive, `count` of them, each with its object-space error. */
async function simplifyPrimitive(input: SimplifyInput, count: number): Promise<LodSet> {
  const { positions } = input.geometry;
  const original = input.geometry.indices;
  const levels: LodLevel[] = [];
  let last: LodLevel = { indices: original, error: 0 };
  if (!original.length) return { levels: Array.from({ length: count }, () => last) };
  const scale = (await meshoptSimplifier()).getScale(positions, TRIANGLE);
  for (let level = 1; level <= count; level++) {
    const [indices, error] = await simplifyTo(input, original, LOD_RATIO ** level, level);
    const usable = indices.length > 0 && indices.length <= last.indices.length;
    if (usable) {
      const deviation = vertexDeviation(positions, original, indices);
      last = { indices, error: Math.max(Math.fround(error * scale), Math.fround(deviation), last.error) };
    }
    levels.push(last);
  }
  return { levels };
}

/** How many levels the largest primitive gets before they stop getting coarser. */
async function chainLength(inputs: SimplifyInput[]): Promise<number> {
  const largest = inputs.reduce((most, each) =>
    each.geometry.indices.length > most.geometry.indices.length ? each : most,
  );
  const original = largest.geometry.indices;
  let previous = original.length;
  let length = 0;
  for (let level = 1; level <= LOD_MAX_LEVELS && original.length; level++) {
    const [indices] = await simplifyTo(largest, original, LOD_RATIO ** level, level);
    if (!indices.length || indices.length > previous * LOD_MIN_REDUCTION) break;
    length = level;
    previous = indices.length;
  }
  return length;
}

/** Each primitive's simplifier input, its attributes read from `doc`. */
function simplifyInputs(doc: PackDoc, primitives: Json[], geometry: Geometry[]): SimplifyInput[] {
  const locks = sharedVertexLocks(geometry);
  return geometry.map((each, at) => {
    const primitive = primitives[at] ?? {};
    const count = each.positions.length / 3;
    const lock = locks[at] ?? new Uint8Array(count);
    lockCards(each, lock);
    return {
      geometry: each,
      ...weighedAttributes(doc, primitive, count),
      lock,
      doubleSided: isDoubleSided(doc.json, primitive),
    };
  });
}

/**
 * Lock every vertex of a primitive's leaf cards (`lod-cards.ts`), alpha-masked or not: unlocked,
 * edge collapse erodes each card into a sliver and the crown loses half its area, so they stay
 * whole as `LockBorder` kept them before LOD-09 (a crown of cards alone is then not coarser).
 */
function lockCards(geometry: Geometry, lock: Uint8Array): void {
  for (const card of findCards(geometry)?.cards ?? []) for (const vertex of card.vertices) lock[vertex] = VERTEX_LOCKED;
}

/** Whether any primitive's extras already name `genex_lods`, or are not an object a key can join. */
function extrasState(primitives: Json[]): LodSkip | null {
  for (const primitive of primitives) {
    if (primitive.extras === undefined) continue;
    if (!isObject(primitive.extras)) return LodSkip.UnreadableGeometry;
    if (LODS_EXTRAS_KEY in primitive.extras) return LodSkip.AlreadySimplified;
  }
  return null;
}

/**
 * `glb` with `genex_lods` extras on every primitive when its triangles together reach
 * `minTriangles`; otherwise the same bytes with the reason. Never throws for the GLB's own contents.
 */
export async function addLodExtras(glb: Uint8Array, options: { minTriangles?: number } = {}): Promise<LodOutcome> {
  const skip = (reason: LodSkip): LodOutcome => ({ bytes: glb, simplified: false, reason });
  let parts: { json: GltfJson; bin: Uint8Array };
  try {
    parts = readGlb(glb);
  } catch {
    return skip(LodSkip.UnreadableGeometry);
  }
  const json = structuredClone(parts.json) as Json;
  const primitives = primitivesOf(json);
  const state = extrasState(primitives);
  if (state) return skip(state);
  const geometry = primitives.map((primitive) => readGeometry(json, parts.bin, primitive));
  const found = geometry.filter((each): each is Geometry => each !== null);
  if (found.length !== geometry.length || !found.length) return skip(LodSkip.UnreadableGeometry);
  const triangles = found.reduce((sum, each) => sum + each.indices.length / TRIANGLE, 0);
  if (triangles < (options.minTriangles ?? LOD_MIN_TRIANGLES)) return skip(LodSkip.BelowThreshold);
  const doc: PackDoc = { json, bin: parts.bin, data: new Map() };
  const inputs = simplifyInputs(doc, primitives, found);
  let sets: LodSet[];
  try {
    const count = await chainLength(inputs);
    if (!count) return skip(LodSkip.NotCoarser);
    sets = [];
    for (const each of inputs) sets.push(await simplifyPrimitive(each, count));
  } catch {
    return skip(LodSkip.NoSimplifier);
  }
  const invalid = sets.some((set, at) => validateLodSet(set, (found[at]?.positions.length ?? 0) / 3) !== null);
  if (invalid) return skip(LodSkip.NotCoarser);
  return { bytes: writeExtras(json, parts.bin, primitives, sets), simplified: true };
}

/** `json` and `bin` with each primitive's levels appended as one buffer view and named in its extras. */
function writeExtras(json: Json, bin: Uint8Array, primitives: Json[], sets: LodSet[]): Uint8Array {
  const views = objects(json.bufferViews);
  const chunks: Uint8Array[] = [];
  let length = padded(bin.byteLength);
  primitives.forEach((primitive, at) => {
    const set = sets[at];
    if (!set) return;
    const total = set.levels.reduce((sum, level) => sum + level.indices.length, 0);
    const words = new Uint32Array(total);
    let first = 0;
    const levels = set.levels.map((level) => {
      words.set(level.indices, first);
      const entry = {
        [LodLevelKey.First]: first,
        [LodLevelKey.Count]: level.indices.length,
        [LodLevelKey.Error]: level.error,
      };
      first += level.indices.length;
      return entry;
    });
    const data = new Uint8Array(words.buffer);
    views.push({ buffer: 0, byteOffset: length, byteLength: data.byteLength });
    chunks.push(data);
    length += padded(data.byteLength);
    const extras = isObject(primitive.extras) ? primitive.extras : {};
    primitive.extras = {
      ...extras,
      [LODS_EXTRAS_KEY]: {
        [LodExtrasKey.Version]: LOD_SCHEMA_VERSION,
        [LodExtrasKey.Indices]: views.length - 1,
        [LodExtrasKey.Levels]: levels,
      },
    };
  });
  const out = new Uint8Array(length);
  out.set(bin);
  let cursor = padded(bin.byteLength);
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += padded(chunk.byteLength);
  }
  const buffers = objects(json.buffers);
  json.bufferViews = views;
  json.buffers = [{ ...(buffers[0] ?? {}), byteLength: length }, ...buffers.slice(1)];
  return writeGlb(json as GltfJson, out);
}

/** A level entry's numbers, or null when one is missing or not a number of its kind. */
function levelEntry(value: unknown): { first: number; count: number; error: number } | null {
  if (!isObject(value)) return null;
  const first = index(value[LodLevelKey.First]);
  const count = index(value[LodLevelKey.Count]);
  const error = value[LodLevelKey.Error];
  if (first === null || count === null || typeof error !== "number") return null;
  return { first, count, error };
}

/**
 * The levels a primitive's `genex_lods` extras name, read back from the GLB's views (the importer's
 * own check, and the tests'): the set, or the fault the extras are refused with. A primitive
 * without the extras has `{ set: null }`.
 */
export function readLodSet(json: Json, bin: Uint8Array, primitive: Json): { set: LodSet | null; fault?: LodFault } {
  const extras = isObject(primitive.extras) ? primitive.extras[LODS_EXTRAS_KEY] : undefined;
  if (extras === undefined) return { set: null };
  if (!isObject(extras) || extras[LodExtrasKey.Version] !== LOD_SCHEMA_VERSION) {
    return { set: null, fault: LodFault.UnknownVersion };
  }
  const entries = Array.isArray(extras[LodExtrasKey.Levels]) ? (extras[LodExtrasKey.Levels] as unknown[]) : [];
  if (entries.length > LOD_MAX_LEVELS) return { set: null, fault: LodFault.OverLimit };
  const view = objects(json.bufferViews)[index(extras[LodExtrasKey.Indices]) ?? -1];
  const start = index(view?.byteOffset) ?? 0;
  const size = index(view?.byteLength);
  const inside = view !== undefined && size !== null && size % U32_BYTES === 0 && start + size <= bin.byteLength;
  if (!inside) return { set: null, fault: LodFault.RangeOutOfBounds };
  const data = new DataView(bin.buffer, bin.byteOffset + start, size);
  const levels: LodLevel[] = [];
  for (const value of entries) {
    const entry = levelEntry(value);
    if (!entry || (entry.first + entry.count) * U32_BYTES > size)
      return { set: null, fault: LodFault.RangeOutOfBounds };
    const indices = Uint32Array.from({ length: entry.count }, (_, at) =>
      data.getUint32((entry.first + at) * U32_BYTES, true),
    );
    levels.push({ indices, error: entry.error });
  }
  const vertexCount = vertexCountOf(json, primitive);
  const fault = validateLodSet({ levels }, vertexCount);
  return fault ? { set: null, fault } : { set: { levels } };
}

/** A primitive's vertex count: its POSITION accessor's. */
function vertexCountOf(json: Json, primitive: Json): number {
  const attributes = isObject(primitive.attributes) ? primitive.attributes : {};
  return index(objects(json.accessors)[index(attributes.POSITION) ?? -1]?.count) ?? 0;
}
