/**
 * Accessor bounds written from the data (B8). A GLB merged or edited by hand (clips copied from
 * one file into another, a script's own export) often keeps the `min`/`max` its source declared
 * or drops them, and the glTF gate refuses such a file (`ACCESSOR_MAX_MISMATCH`,
 * `…_ACCESSOR_WITHOUT_BOUNDS`) though nothing in it is unsafe: bounds are a fact of the data. So
 * before the gate the import step writes them from the data for every accessor that declares
 * them or must (a primitive's or morph target's `POSITION`, an animation sampler's input).
 *
 * Only what this module can read whole is touched: a non-sparse accessor of a known type and
 * component, not a matrix, in a view of the GLB's own BIN chunk with every element inside it.
 * Anything else is left as it is for the gate to judge, so a damaged file is refused exactly as
 * before. A file whose bounds already hold comes back byte for byte.
 */
import { GltfComponent, readGlb, writeGlb } from "./glb.ts";
import { index, isObject, type Json, objects } from "./gltf-json.ts";

/** Components per element of each accessor type this module reads (matrices are left alone). */
const TYPE_COMPONENTS: Readonly<Record<string, number>> = Object.freeze({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 });

/** Bytes and reader of each component type. */
const COMPONENT_READERS: Readonly<Record<number, ComponentReader>> = Object.freeze({
  [GltfComponent.Byte]: { bytes: 1, read: (data, at) => data.getInt8(at) },
  [GltfComponent.UnsignedByte]: { bytes: 1, read: (data, at) => data.getUint8(at) },
  [GltfComponent.Short]: { bytes: 2, read: (data, at) => data.getInt16(at, true) },
  [GltfComponent.UnsignedShort]: { bytes: 2, read: (data, at) => data.getUint16(at, true) },
  [GltfComponent.UnsignedInt]: { bytes: 4, read: (data, at) => data.getUint32(at, true) },
  [GltfComponent.Float]: { bytes: 4, read: (data, at) => data.getFloat32(at, true) },
});

/** A file with its accessor bounds written from the data, and which accessors changed. */
export interface RepairedBounds {
  bytes: Uint8Array;
  /** The accessors whose bounds were rewritten or added, ascending. */
  repaired: number[];
}

/** One accessor's bounds. */
interface Bounds {
  min: number[];
  max: number[];
}

/** The accessors glTF requires bounds on: every `POSITION` (morph targets' too) and every animation input. */
function boundedByRule(json: Json): Set<number> {
  const required = new Set<number>();
  for (const primitive of objects(json.meshes).flatMap((mesh) => objects(mesh.primitives))) {
    const attributes = [primitive.attributes, ...objects(primitive.targets)].filter(isObject);
    for (const position of attributes.map((set) => index(set.POSITION))) {
      if (position !== null) required.add(position);
    }
  }
  for (const sampler of objects(json.animations).flatMap((animation) => objects(animation.samplers))) {
    const input = index(sampler.input);
    if (input !== null) required.add(input);
  }
  return required;
}

/** Whether buffer 0 is the GLB's BIN chunk (it names no URI). */
const binIsBufferZero = (json: Json): boolean => {
  const [first] = objects(json.buffers);
  return first !== undefined && first.uri === undefined;
};

/** How one component type is read. */
interface ComponentReader {
  bytes: number;
  read: (data: DataView, at: number) => number;
}

/** Where an accessor's elements lie in the BIN chunk, and how to read them. */
interface Span {
  start: number;
  end: number;
  stride: number;
  components: number;
  reader: ComponentReader;
}

/** `accessor`'s view when it is a view of buffer 0 (the BIN chunk), else null. */
function binViewOf(json: Json, accessor: Json): Json | null {
  const at = index(accessor.bufferView);
  const view = at === null ? undefined : objects(json.bufferViews)[at];
  return view && index(view.buffer) === 0 ? view : null;
}

/** Where `accessor`'s elements lie in `bin`, or null when it is not a plain accessor wholly inside its view and the chunk. */
function spanOf(json: Json, bin: Uint8Array, accessor: Json): Span | null {
  const components = TYPE_COMPONENTS[String(accessor.type)];
  const reader = COMPONENT_READERS[Number(accessor.componentType)];
  const count = index(accessor.count);
  const view = binViewOf(json, accessor);
  if (!components || !reader || !count || accessor.sparse !== undefined || !view) return null;
  const element = components * reader.bytes;
  const stride = view.byteStride === undefined ? element : index(view.byteStride);
  const viewStart = index(view.byteOffset ?? 0);
  const offset = index(accessor.byteOffset ?? 0);
  const length = index(view.byteLength);
  if (stride === null || viewStart === null || offset === null || length === null || stride < element) return null;
  const start = viewStart + offset;
  const end = start + (count - 1) * stride + element;
  const inside = end <= viewStart + length && viewStart + length <= bin.byteLength;
  return inside ? { start, end, stride, components, reader } : null;
}

/** The bounds of the elements `span` names in `bin`, or null when one is not finite. */
function boundsOf(bin: Uint8Array, span: Span): Bounds | null {
  const { start, end, stride, components, reader } = span;
  const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const min = Array<number>(components).fill(Number.POSITIVE_INFINITY);
  const max = Array<number>(components).fill(Number.NEGATIVE_INFINITY);
  for (let at = start; at < end; at += stride) {
    for (let c = 0; c < components; c += 1) {
      const value = reader.read(data, at + c * reader.bytes);
      if (!Number.isFinite(value)) return null;
      min[c] = Math.min(min[c] ?? value, value);
      max[c] = Math.max(max[c] ?? value, value);
    }
  }
  return { min, max };
}

/** `accessor`'s bounds read from `bin`, or null when any part of it is not readable whole. */
function readBounds(json: Json, bin: Uint8Array, accessor: Json): Bounds | null {
  const span = spanOf(json, bin, accessor);
  return span ? boundsOf(bin, span) : null;
}

/**
 * Whether `declared` holds `actual`, component for component: exactly for integers, and at float32
 * precision for floats, as the validator compares them (an exporter writes a float's bound as the
 * shortest decimal of its double, 0.041666666666666664 for the float32 0.0416666679…).
 */
const same = (declared: unknown, actual: readonly number[], float: boolean): boolean =>
  Array.isArray(declared) &&
  declared.length === actual.length &&
  declared.every((value, at) => typeof value === "number" && (float ? Math.fround(value) : value) === actual[at]);

/**
 * `bytes` (a GLB) with the bounds of every accessor that declares them or must have them written
 * from its data. A file that is not a readable GLB, or whose bounds all hold, comes back as it is.
 */
export function repairAccessorBounds(bytes: Uint8Array): RepairedBounds {
  let parts: { json: Json; bin: Uint8Array };
  try {
    parts = readGlb(bytes) as { json: Json; bin: Uint8Array };
  } catch {
    return { bytes, repaired: [] };
  }
  const { json, bin } = parts;
  if (!binIsBufferZero(json)) return { bytes, repaired: [] };
  const required = boundedByRule(json);
  const repaired: number[] = [];
  objects(json.accessors).forEach((accessor, at) => {
    const declares = accessor.min !== undefined || accessor.max !== undefined;
    if (!declares && !required.has(at)) return;
    const bounds = readBounds(json, bin, accessor);
    const float = accessor.componentType === GltfComponent.Float;
    if (!bounds || (same(accessor.min, bounds.min, float) && same(accessor.max, bounds.max, float))) return;
    accessor.min = bounds.min;
    accessor.max = bounds.max;
    repaired.push(at);
  });
  return repaired.length ? { bytes: writeGlb(json, bin), repaired } : { bytes, repaired };
}
