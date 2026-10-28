/**
 * The Genex Library pack build's pure steps: a model decimated to its budget (meshoptimizer through
 * the importer's own level chain, `lods.ts`), its triangles counted, a preview and a mean colour
 * taken from an image, and the `entry.json` facts of each kind. `build-library.ts` drives them over
 * downloaded sources; tests drive them over synthetic ones.
 */
import { addLodExtras, readLodSet } from "../../src/substrate/asset-import/lods.ts";
import { GltfComponent, readGlb } from "../../src/substrate/asset-import/glb.ts";
import { index, isObject, type Json, objects } from "../../src/substrate/asset-import/gltf-json.ts";
import { type PackDoc, packGlb, pruneAccessors } from "../../src/substrate/asset-import/prune.ts";
import { type RgbaImage, resampleSquare } from "../../src/substrate/asset-import/resample.ts";
import { TextureUsage } from "../../src/substrate/asset-import/basis-encoder.ts";
import { LODS_EXTRAS_KEY } from "../../src/shared/render-quality.ts";
import {
  LIBRARY_ENTRY_SCHEMA,
  LIBRARY_IMPOSTOR_BUDGETS,
  LIBRARY_LICENCE,
  type LibraryEntry,
  type LibraryEntryFacts,
  type LibraryMap,
  type LibraryTier,
} from "../../src/shared/genex-library.ts";

/** How many simplify-and-promote rounds a decimation may take before it gives up. */
const DECIMATE_ROUNDS_MAX = 8;
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

/** The finest level (past the casters-only ones) whose triangles across every primitive fit `cap`, else the coarsest. */
function levelFor(sets: Array<{ levels: Array<{ indices: Uint32Array }>; casters: number }>, cap: number): number {
  const count = sets[0]?.levels.length ?? 0;
  const first = Math.max(...sets.map((set) => set.casters));
  for (let level = first; level < count; level++) {
    const triangles = sets.reduce((sum, set) => sum + (set.levels[level]?.indices.length ?? 0) / TRIANGLE, 0);
    if (triangles <= cap) return level;
  }
  return count - 1;
}

/** `glb` (with fresh `genex_lods` extras) with each primitive's `level` promoted to its own indices and the extras dropped. */
function promote(glb: Uint8Array, cap: number): Uint8Array {
  const parts = readGlb(glb);
  const json = parts.json as Json;
  const primitives = primitivesOf(json);
  const sets = primitives.map((primitive) => readLodSet(json, parts.bin, primitive).set);
  if (sets.some((set) => set === null)) throw new DecimateError(MESSAGE.CannotReach(glbTriangles(glb), cap));
  const known = sets as NonNullable<(typeof sets)[number]>[];
  const level = levelFor(known, cap);
  const doc: PackDoc = { json, bin: parts.bin, data: new Map() };
  const accessors = objects(json.accessors);
  primitives.forEach((primitive, at) => {
    const indices = known[at]?.levels[level]?.indices ?? new Uint32Array(0);
    accessors.push({ componentType: GltfComponent.UnsignedInt, count: indices.length, type: "SCALAR" });
    doc.data.set(accessors.length - 1, new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength));
    primitive.indices = accessors.length - 1;
    if (isObject(primitive.extras)) delete primitive.extras[LODS_EXTRAS_KEY];
    if (isObject(primitive.extras) && Object.keys(primitive.extras).length === 0) delete primitive.extras;
  });
  json.accessors = accessors;
  pruneAccessors(doc);
  return packGlb(doc);
}

/**
 * `glb` with at most `cap` triangles: the importer's simplifier run on it and its finest level
 * that fits promoted to the mesh, again until it fits; unchanged when it already fits. Throws
 * {@link DecimateError} when the simplifier cannot get under `cap`.
 */
export async function decimateGlb(glb: Uint8Array, cap: number): Promise<{ bytes: Uint8Array; triangles: number }> {
  let bytes = glb;
  for (let round = 0; round < DECIMATE_ROUNDS_MAX; round++) {
    const triangles = glbTriangles(bytes);
    if (triangles <= cap) return { bytes, triangles };
    const outcome = await addLodExtras(bytes, { minTriangles: 1 });
    if (!outcome.simplified) throw new DecimateError(MESSAGE.CannotReach(triangles, cap));
    const next = promote(outcome.bytes, cap);
    if (glbTriangles(next) >= triangles) throw new DecimateError(MESSAGE.CannotReach(triangles, cap));
    bytes = next;
  }
  throw new DecimateError(MESSAGE.CannotReach(glbTriangles(bytes), cap));
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
