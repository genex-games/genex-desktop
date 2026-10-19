/**
 * Import-time LODs (renderer pass 2, A6.9): a GLB of at least {@link LOD_MIN_TRIANGLES} triangles
 * gets `extras.genex_lods` on every primitive, the schema in
 * `native/genex-rust/crates/genex-render/README.md`. Each level is simplified from the primitive's
 * own triangles by meshoptimizer's simplifier (npm `meshoptimizer` 1.3.0, `decoders.ts`) to half the
 * previous level's target, its open borders locked so primitives of one mesh stay joined, and
 * carries its object-space error (meshoptimizer's relative error times the mesh's extent), never
 * less than the level before. The chain's length is the GLB's largest primitive's (levels stop when
 * one is no longer markedly coarser, its error passes {@link LOD_MAX_RELATIVE_ERROR}, or at
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
import { meshoptSimplifier } from "./decoders.ts";
import { type GltfJson, readGlb, writeGlb } from "./glb.ts";
import { index, isObject, type Json, objects } from "./gltf-json.ts";
import { type Geometry, readGeometry } from "./meshlets.ts";

/** Each level aims at this share of the previous level's triangles. */
const LOD_RATIO = 0.5;
/** A level must keep at most this share of the previous one's triangles to count as coarser. */
const LOD_MIN_REDUCTION = 0.85;
/** The coarsest error a level may have, relative to the mesh's extent. */
export const LOD_MAX_RELATIVE_ERROR = 0.1;
/** The simplifier's flags: open borders stay where they are, so a mesh's primitives keep meeting. */
const SIMPLIFY_FLAGS = ["LockBorder"] as const;
const U32_BYTES = 4;
const TRIANGLE = 3;

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

/** The levels of one primitive, the largest primitive's count of them decided by the caller. */
async function simplifyPrimitive(geometry: Geometry, targets: readonly number[]): Promise<LodSet> {
  const simplifier = await meshoptSimplifier();
  const scale = simplifier.getScale(geometry.positions, TRIANGLE);
  const levels: LodLevel[] = [];
  let last: LodLevel = { indices: geometry.indices, error: 0 };
  for (const share of targets) {
    const target = Math.floor((geometry.indices.length * share) / TRIANGLE) * TRIANGLE;
    const [indices, error] = simplifier.simplify(
      geometry.indices,
      geometry.positions,
      TRIANGLE,
      target,
      LOD_MAX_RELATIVE_ERROR,
      [...SIMPLIFY_FLAGS],
    );
    const usable = indices.length > 0 && indices.length <= last.indices.length;
    last = usable ? { indices, error: Math.max(Math.fround(error * scale), last.error) } : last;
    levels.push(last);
  }
  return { levels };
}

/** The shares of the original each level aims at, as long as the largest primitive keeps getting coarser. */
async function chainTargets(largest: Geometry): Promise<number[]> {
  const simplifier = await meshoptSimplifier();
  const targets: number[] = [];
  let previous = largest.indices.length;
  for (let level = 1; level <= LOD_MAX_LEVELS; level++) {
    const share = LOD_RATIO ** level;
    const target = Math.floor((largest.indices.length * share) / TRIANGLE) * TRIANGLE;
    const [indices] = simplifier.simplify(
      largest.indices,
      largest.positions,
      TRIANGLE,
      target,
      LOD_MAX_RELATIVE_ERROR,
      [...SIMPLIFY_FLAGS],
    );
    if (!indices.length || indices.length > previous * LOD_MIN_REDUCTION) break;
    targets.push(share);
    previous = indices.length;
  }
  return targets;
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
  let sets: LodSet[];
  try {
    const largest = found.reduce((most, each) => (each.indices.length > most.indices.length ? each : most));
    const targets = await chainTargets(largest);
    if (!targets.length) return skip(LodSkip.NotCoarser);
    sets = [];
    for (const each of found) sets.push(await simplifyPrimitive(each, targets));
  } catch {
    return skip(LodSkip.NoSimplifier);
  }
  const invalid = sets.some((set, at) => validateLodSet(set, (found[at]?.positions.length ?? 0) / TRIANGLE) !== null);
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
