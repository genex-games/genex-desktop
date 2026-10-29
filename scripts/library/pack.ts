/**
 * The Genex Library pack build's pure steps: a model decimated to its budget (meshoptimizer through
 * the importer's own level chain, `lods.ts`), its triangles counted, a preview and a mean colour
 * taken from an image, and the `entry.json` facts of each kind. `build-library.ts` drives them over
 * downloaded sources; tests drive them over synthetic ones.
 */
import { addLodExtras, simplifyInputs, simplifyTo } from "../../src/substrate/asset-import/lods.ts";
import { type Geometry, readGeometry } from "../../src/substrate/asset-import/meshlets.ts";
import { GltfComponent, readGlb } from "../../src/substrate/asset-import/glb.ts";
import { index, isObject, type Json, objects } from "../../src/substrate/asset-import/gltf-json.ts";
import { weldGlb } from "../../src/substrate/asset-import/weld.ts";
import { type PackDoc, packGlb, pruneAccessors } from "../../src/substrate/asset-import/prune.ts";
import { type RgbaImage, resampleSquare } from "../../src/substrate/asset-import/resample.ts";
import { TextureUsage } from "../../src/substrate/asset-import/basis-encoder.ts";
import {
  LIBRARY_ENTRY_SCHEMA,
  LIBRARY_IMPOSTOR_BUDGETS,
  LIBRARY_LICENCE,
  type LibraryEntry,
  type LibraryEntryFacts,
  type LibraryMap,
  type LibraryTier,
} from "../../src/shared/genex-library.ts";

/** glTF's TRIANGLES mode, the default. */
const MODE_TRIANGLES = 4;
const TRIANGLE = 3;
const RGBA = 4;
/** The side of a material's preview swatch. */
export const PREVIEW_SIDE = 256;
/** The JPEG quality previews are written at. */
const PREVIEW_QUALITY = 85;

const MESSAGE = {
  NotTriangles: "a primitive that is not a triangle list",
  CannotReach: (triangles: number, cap: number) =>
    `the simplifier stops at ${triangles} triangles, over the budget of ${cap}: pick a lighter source or a larger budget`,
} as const;

/** Why a decimation failed. */
export class DecimateError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "DecimateError";
  }
}

const primitivesOf = (json: Json): Json[] => objects(json.meshes).flatMap((mesh) => objects(mesh.primitives));

/** The count of the accessor at `at`, or null. */
function accessorCount(json: Json, at: unknown): number | null {
  const position = index(at);
  return position === null ? null : index(objects(json.accessors)[position]?.count);
}

/** The triangles a GLB draws at full detail: every primitive's indices (or vertices) over three. */
export function glbTriangles(glb: Uint8Array): number {
  const { json } = readGlb(glb);
  let triangles = 0;
  for (const primitive of primitivesOf(json as Json)) {
    if ((primitive.mode ?? MODE_TRIANGLES) !== MODE_TRIANGLES) throw new DecimateError(MESSAGE.NotTriangles);
    const attributes = isObject(primitive.attributes) ? primitive.attributes : {};
    const count =
      accessorCount(json as Json, primitive.indices) ?? accessorCount(json as Json, attributes.POSITION) ?? 0;
    triangles += Math.floor(count / TRIANGLE);
  }
  return triangles;
}

/** Primitives too small to shrink leave the total over its share, so a cut aims a little under the cap. */
const AIM_AT_CAP = 0.92;
/** The importer level a cut asks for: one that may drop small disconnected pieces (`Prune`), as a scan needs. */
const DECIMATE_LEVEL = 9;
/** The relative errors a decimation tries in turn, tightest first (share of the mesh's extent). */
const DECIMATE_ERRORS = [0.02, 0.05, 0.1, 0.2] as const;
/** The errors tried with normals and UVs ignored, when the weighed passes stay over the cap. */
const DECIMATE_ERRORS_LOOSE = [0.1, 0.2, 0.35] as const;

/** `input` with its attribute weights zeroed: positions alone decide what collapses. */
const unweighed = <T extends { weights: number[] }>(input: T): T => ({ ...input, weights: input.weights.map(() => 0) });

/** The geometry and simplifier inputs of every primitive of the GLB document `doc`. */
function inputsOf(doc: PackDoc) {
  const primitives = primitivesOf(doc.json);
  const geometry = primitives.map((primitive) => readGeometry(doc.json, doc.bin, primitive));
  if (geometry.some((each) => each === null)) throw new DecimateError(MESSAGE.NotTriangles);
  // Primitives that share positions (a model's LOD copies, a mesh split by material) lock every shared
  // vertex in the importer's level chain, which would stop a cut to budget; seams may move here.
  const inputs = simplifyInputs(doc, primitives, geometry as Geometry[]).map((input) => ({
    ...input,
    lock: new Uint8Array(input.lock.length),
  }));
  return { primitives, inputs };
}

/** Every primitive simplified so that all together keep at most `cap` triangles, at `maxError`. */
async function simplifiedWithin(
  inputs: ReturnType<typeof inputsOf>["inputs"],
  cap: number,
  maxError: number,
): Promise<Uint32Array[]> {
  const total = inputs.reduce((sum, each) => sum + each.geometry.indices.length / TRIANGLE, 0);
  const share = Math.min(1, (cap * AIM_AT_CAP) / total);
  const out: Uint32Array[] = [];
  for (const input of inputs)
    out.push((await simplifyTo(input, input.geometry.indices, share, DECIMATE_LEVEL, maxError))[0]);
  return out;
}

/** The coarsest and finest grids a clustering tries, in cells along the longest side. */
const CLUSTER_GRID_MIN = 4;
const CLUSTER_GRID_MAX = 1024;

/** The corner and longest side of the box around `positions`. */
function boxOf(positions: Float32Array): { min: number[]; side: number } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let at = 0; at < positions.length; at++) {
    const axis = at % 3;
    const value = positions[at] ?? 0;
    min[axis] = Math.min(min[axis] ?? value, value);
    max[axis] = Math.max(max[axis] ?? value, value);
  }
  return { min, side: Math.max(...max.map((high, axis) => high - (min[axis] ?? 0)), Number.EPSILON) };
}

/** The point of vertex `vertex`. */
const pointOf = (positions: Float32Array, vertex: number): number[] =>
  [0, 1, 2].map((axis) => positions[vertex * 3 + axis] ?? 0);

/** For each vertex `used` by a mesh, the vertex that stands for its grid cell: the one nearest the cell's centroid. */
function cellRepresentatives(positions: Float32Array, used: ReadonlySet<number>, cells: number): Map<number, number> {
  const { min, side } = boxOf(positions);
  const size = side / cells;
  const keyOf = (vertex: number) =>
    pointOf(positions, vertex)
      .map((value, axis) => Math.floor((value - (min[axis] ?? 0)) / size))
      .join(",");
  const sums = new Map<string, { sum: number[]; n: number }>();
  for (const vertex of used) {
    const cell = sums.get(keyOf(vertex)) ?? { sum: [0, 0, 0], n: 0 };
    pointOf(positions, vertex).forEach((value, axis) => {
      cell.sum[axis] = (cell.sum[axis] ?? 0) + value;
    });
    cell.n++;
    sums.set(keyOf(vertex), cell);
  }
  const best = new Map<string, { vertex: number; distance: number }>();
  for (const vertex of used) {
    const key = keyOf(vertex);
    const cell = sums.get(key);
    const distance = pointOf(positions, vertex).reduce(
      (sum, value, axis) => sum + (value - (cell?.sum[axis] ?? 0) / (cell?.n ?? 1)) ** 2,
      0,
    );
    if (distance < (best.get(key)?.distance ?? Infinity)) best.set(key, { vertex, distance });
  }
  return new Map([...used].map((vertex) => [vertex, best.get(keyOf(vertex))?.vertex ?? vertex]));
}

/**
 * `indices` with vertices clustered on a grid of `cells` along the longest side of `positions`' box:
 * every vertex of a cell becomes the cell's vertex nearest its centroid, and a triangle that no
 * longer has three distinct corners is dropped. Only indices change; the vertex data is untouched.
 */
function clusteredIndices(positions: Float32Array, indices: Uint32Array, cells: number): Uint32Array {
  const stand = cellRepresentatives(positions, new Set(indices), cells);
  const kept: number[] = [];
  for (let at = 0; at + 2 < indices.length; at += TRIANGLE) {
    const [a = 0, b = 0, c = 0] = [0, 1, 2].map((k) => stand.get(indices[at + k] ?? 0) ?? 0);
    if (a !== b && b !== c && a !== c) kept.push(a, b, c);
  }
  return Uint32Array.from(kept);
}

/** Every primitive clustered on the finest grid that keeps all together within `cap` triangles. */
function clusteredWithin(inputs: ReturnType<typeof inputsOf>["inputs"], cap: number): Uint32Array[] | null {
  const run = (cells: number) =>
    inputs.map((input) => clusteredIndices(input.geometry.positions, input.geometry.indices, cells));
  const total = (parts: Uint32Array[]) => parts.reduce((sum, indices) => sum + indices.length / TRIANGLE, 0);
  let low = CLUSTER_GRID_MIN;
  let high = CLUSTER_GRID_MAX;
  let best: Uint32Array[] | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const parts = run(mid);
    if (total(parts) <= cap) {
      best = parts;
      low = mid + 1;
    } else high = mid - 1;
  }
  return best;
}

/**
 * `glb` with at most `cap` triangles: each primitive simplified to its share of the budget by
 * meshoptimizer (normals and UVs weighed, where primitives meet locked), at the tightest error
 * that gets under `cap`. Unchanged when it already fits. Throws {@link DecimateError} when even
 * the loosest error stays over `cap`.
 */
export async function decimateGlb(glb: Uint8Array, cap: number): Promise<{ bytes: Uint8Array; triangles: number }> {
  const before = glbTriangles(glb);
  if (before <= cap) return { bytes: glb, triangles: before };
  // A scan exported as a triangle soup has nothing to collapse until identical vertices are merged.
  const parts = readGlb(weldGlb(glb).bytes);
  const doc: PackDoc = { json: parts.json as Json, bin: parts.bin, data: new Map() };
  const { primitives, inputs } = inputsOf(doc);
  // Seams (normals, UVs) hold vertices in place: a scan that cannot reach the cap with them weighed is cut without.
  const passes = [
    ...DECIMATE_ERRORS.map((maxError) => ({ inputs, maxError })),
    ...DECIMATE_ERRORS_LOOSE.map((maxError) => ({ inputs: inputs.map(unweighed), maxError })),
  ];
  const apply = (kept: Uint32Array[]) => {
    const accessors = objects(doc.json.accessors);
    primitives.forEach((primitive, at) => {
      const indices = kept[at] ?? new Uint32Array(0);
      accessors.push({ componentType: GltfComponent.UnsignedInt, count: indices.length, type: "SCALAR" });
      doc.data.set(accessors.length - 1, new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength));
      primitive.indices = accessors.length - 1;
    });
    doc.json.accessors = accessors;
    pruneAccessors(doc);
    const bytes = packGlb(doc);
    return { bytes, triangles: glbTriangles(bytes) };
  };
  for (const { inputs: pass, maxError } of passes) {
    const kept = await simplifiedWithin(pass, cap, maxError);
    if (kept.reduce((sum, indices) => sum + indices.length / TRIANGLE, 0) <= cap) return apply(kept);
  }
  // A mesh the simplifier cannot collapse (a scan of near-separate triangles) is clustered on a grid.
  const clustered = clusteredWithin(inputs, cap);
  if (clustered) return apply(clustered);
  throw new DecimateError(MESSAGE.CannotReach(before, cap));
}

/** `glb` with the runtime's level chain baked in (what the import step would add), so a delivery needs no import work. */
export async function withLevels(glb: Uint8Array): Promise<{ bytes: Uint8Array; levels: boolean }> {
  const outcome = await addLodExtras(glb);
  return { bytes: outcome.bytes, levels: outcome.simplified };
}

/** The mean sRGB colour of `image`'s opaque texels (a material's untextured stand-in). */
export function meanColor(image: RgbaImage): [number, number, number] {
  const sum = [0, 0, 0];
  let count = 0;
  for (let at = 0; at < image.data.length; at += RGBA) {
    if ((image.data[at + 3] ?? 0) === 0) continue;
    for (let channel = 0; channel < 3; channel++) sum[channel] = (sum[channel] ?? 0) + (image.data[at + channel] ?? 0);
    count++;
  }
  const mean = (channel: number) => (count ? Math.round((sum[channel] ?? 0) / count) : 0);
  return [mean(0), mean(1), mean(2)];
}

/** `image` resampled to a `side`-pixel square and written as a JPEG (a browsable preview). */
export async function previewJpeg(image: RgbaImage, side = PREVIEW_SIDE): Promise<Uint8Array> {
  const square =
    image.width === side && image.height === side ? image : resampleSquare(image, side, TextureUsage.Color);
  const { default: jpeg } = await import("jpeg-js");
  const encoded = jpeg.encode({ width: side, height: side, data: Buffer.from(square.data) }, PREVIEW_QUALITY);
  return new Uint8Array(encoded.data);
}

/** The facts every kind shares. */
function baseFacts(entry: LibraryEntry, size: [number, number, number]): LibraryEntryFacts {
  return {
    schema: LIBRARY_ENTRY_SCHEMA,
    id: entry.id,
    kind: entry.kind,
    name: entry.name,
    tags: entry.tags,
    licence: LIBRARY_LICENCE,
    source: entry.source,
    size,
  };
}

/** A material's maps at one tier, by map name, and the texture's side in pixels. */
export interface MaterialTier {
  tier: LibraryTier;
  side: number;
  maps: Record<LibraryMap, string>;
}

/** A material's `entry.json` facts. */
export function materialFacts(
  entry: LibraryEntry,
  tiers: readonly MaterialTier[],
  baseColor: [number, number, number],
): LibraryEntryFacts {
  const tile = entry.material?.tileMetres ?? 1;
  const facts = baseFacts(entry, [tile, tile, 0]);
  facts.maps = Object.fromEntries(tiers.map((each) => [each.tier, each.maps]));
  facts.texelsPerMetre = Object.fromEntries(tiers.map((each) => [each.tier, Math.round(each.side / tile)]));
  facts.baseColor = baseColor;
  return facts;
}

/** A sky's `entry.json` facts. */
export function skyFacts(entry: LibraryEntry, hdri: Partial<Record<LibraryTier, string>>): LibraryEntryFacts {
  const facts = baseFacts(entry, [0, 0, 0]);
  facts.hdri = hdri;
  if (entry.sky) {
    facts.time = entry.sky.time;
    facts.weather = entry.sky.weather;
  }
  return facts;
}

/** A model's or a filled vegetation slot's `entry.json` facts. */
export function modelFacts(entry: LibraryEntry, members: readonly string[], triangles: number): LibraryEntryFacts {
  const spec = entry.model ?? entry.slot;
  const facts = baseFacts(entry, spec?.sizeMetres ?? [1, 1, 1]);
  facts.members = [...members];
  facts.triangles = triangles;
  facts.impostor = spec ? LIBRARY_IMPOSTOR_BUDGETS.has(spec.budget) : false;
  return facts;
}
