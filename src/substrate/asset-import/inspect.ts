/**
 * What a GLB the import step wrote is made of, in counts and bytes (C-7): the receipt carries it
 * for each model, and the validation report reads it (C-23). Every field is a non-negative
 * integer, so the host can check a receipt's numbers without trusting them.
 *
 * The shape follows glTF-Transform 4.4.2's `inspect` (MIT, © 2024 Don McCurdy,
 * THIRD-PARTY-NOTICES.md "Asset importer ports"), `packages/functions/src/inspect.ts`: a mesh's
 * size is the bytes of the distinct accessors its primitives and morph targets read, its vertices
 * are counted once per distinct `POSITION` accessor (upload count), and an animation's size is the
 * bytes of its samplers' distinct accessors.
 */
import { readGlb } from "./glb.ts";
import { index, isObject, type Json, objects } from "./gltf-json.ts";
import { attributeMaps, elementLayout } from "./prune.ts";

/** The receipt's size fields. Wire values in the import receipt: never rename one. */
export const ImportSizeKey = {
  Bytes: "bytes",
  JsonBytes: "jsonBytes",
  BinBytes: "binBytes",
  Meshes: "meshes",
  Primitives: "primitives",
  Vertices: "vertices",
  Triangles: "triangles",
  MeshBytes: "meshBytes",
  Materials: "materials",
  Textures: "textures",
  TextureBytes: "textureBytes",
  Animations: "animations",
  AnimationBytes: "animationBytes",
} as const;
export type ImportSizeKey = (typeof ImportSizeKey)[keyof typeof ImportSizeKey];

/** A GLB's sizes, as the receipt carries them. */
export type ImportSizes = Record<ImportSizeKey, number>;

const KEYS: readonly ImportSizeKey[] = Object.values(ImportSizeKey);
const TRIANGLES = 4;
const TRIANGLE_STRIP = 5;
const TRIANGLE_FAN = 6;
const STRIP_OVERHEAD = 2;
const TRIANGLE = 3;
/** Where a GLB's JSON chunk length is (after the 12-byte header). */
const JSON_CHUNK_LENGTH_AT = 12;

/** The bytes an accessor's elements take densely; 0 for one without a glTF layout. */
function accessorBytes(accessor: Json | undefined): number {
  if (!accessor) return 0;
  try {
    return elementLayout(accessor).elementBytes * (index(accessor.count) ?? 0);
  } catch {
    return 0;
  }
}

/** Bytes of the distinct accessors named. */
function distinctBytes(json: Json, named: Iterable<unknown>): number {
  const accessors = objects(json.accessors);
  const distinct = new Set<number>();
  for (const value of named) {
    const at = index(value);
    if (at !== null) distinct.add(at);
  }
  return [...distinct].reduce((sum, at) => sum + accessorBytes(accessors[at]), 0);
}

/** Triangles a primitive draws: lists, strips and fans; 0 for points and lines. */
function triangles(json: Json, primitive: Json): number {
  const mode = index(primitive.mode) ?? TRIANGLES;
  const accessors = objects(json.accessors);
  const indices = index(primitive.indices);
  const position = isObject(primitive.attributes) ? index(primitive.attributes.POSITION) : null;
  const counted = indices === null ? position : indices;
  const count = index(accessors[counted ?? -1]?.count) ?? 0;
  if (mode === TRIANGLES) return Math.floor(count / TRIANGLE);
  const strip = mode === TRIANGLE_STRIP || mode === TRIANGLE_FAN;
  return strip ? Math.max(count - STRIP_OVERHEAD, 0) : 0;
}

/** The mesh counts and bytes of a document. */
function meshSizes(json: Json): Pick<ImportSizes, "meshes" | "primitives" | "vertices" | "triangles" | "meshBytes"> {
  const meshes = objects(json.meshes);
  const primitives = meshes.flatMap((mesh) => objects(mesh.primitives));
  const accessors = objects(json.accessors);
  const positions = new Set(
    primitives.flatMap((primitive) => {
      const at = isObject(primitive.attributes) ? index(primitive.attributes.POSITION) : null;
      return at === null ? [] : [at];
    }),
  );
  const meshBytes = meshes.reduce((sum, mesh) => {
    const named = objects(mesh.primitives).flatMap((primitive) => [
      ...attributeMaps(primitive).flatMap((map) => Object.values(map)),
      primitive.indices,
    ]);
    return sum + distinctBytes(json, named);
  }, 0);
  return {
    meshes: meshes.length,
    primitives: primitives.length,
    vertices: [...positions].reduce((sum, at) => sum + (index(accessors[at]?.count) ?? 0), 0),
    triangles: primitives.reduce((sum, primitive) => sum + triangles(json, primitive), 0),
    meshBytes,
  };
}

/** The bytes of every embedded image (an image in a view of the binary chunk). */
function textureBytes(json: Json): number {
  const views = objects(json.bufferViews);
  return objects(json.images).reduce((sum, image) => {
    const at = index(image.bufferView);
    return sum + (at === null ? 0 : (index(views[at]?.byteLength) ?? 0));
  }, 0);
}

/** The animation bytes: each animation's distinct sampler accessors. */
function animationBytes(json: Json): number {
  return objects(json.animations).reduce((sum, animation) => {
    const named = objects(animation.samplers).flatMap((sampler) => [sampler.input, sampler.output]);
    return sum + distinctBytes(json, named);
  }, 0);
}

/** A GLB's sizes, or null when the bytes are not a GLB. */
export function inspectGlb(glb: Uint8Array): ImportSizes | null {
  let json: Json;
  let bin: Uint8Array;
  try {
    ({ json, bin } = readGlb(glb));
  } catch {
    return null;
  }
  return {
    bytes: glb.byteLength,
    jsonBytes: new DataView(glb.buffer, glb.byteOffset, glb.byteLength).getUint32(JSON_CHUNK_LENGTH_AT, true),
    binBytes: bin.byteLength,
    ...meshSizes(json),
    materials: objects(json.materials).length,
    textures: objects(json.images).length,
    textureBytes: textureBytes(json),
    animations: objects(json.animations).length,
    animationBytes: animationBytes(json),
  };
}

/** A receipt's sizes: exactly the {@link ImportSizeKey} fields, each a non-negative safe integer; null otherwise. */
export function parseImportSizes(value: unknown): ImportSizes | null {
  if (!isObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== KEYS.length || !KEYS.every((key) => index(value[key]) !== null)) return null;
  return Object.fromEntries(KEYS.map((key) => [key, value[key] as number])) as ImportSizes;
}
