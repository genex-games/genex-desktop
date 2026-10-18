/**
 * `KHR_mesh_quantization` undone at import (A6.2): gltfpack writes it by default, and the runtime's
 * `gltf` 1.4.1 reads only float positions, normals and tangents. Every vertex attribute but
 * `JOINTS_n` (morph targets too) that is not float is rewritten as tightly packed float32 in a view
 * of its own, normalized integers divided out; the node transforms gltfpack writes to undo its
 * position scale stay as they are. A material whose every texture carries one and the same
 * `KHR_texture_transform` without rotation (gltfpack's uv dequantization) has that transform baked
 * into its primitives' `TEXCOORD_0` when no other material shares those uvs, since the runtime
 * does not apply texture transforms.
 *
 * Ported from glTF-Transform 4.5.1 (MIT, © 2024 Don McCurdy, THIRD-PARTY-NOTICES.md "Asset
 * importer ports"): `packages/functions/src/dequantize.ts` (which attributes, every component as
 * float32, `normalized` cleared) and `MathUtils.decodeNormalizedInt` (the division and its -1
 * clamp). The output is a pure function of the input.
 */
import { ARRAY_BUFFER, BinWriter, GltfComponent, type GltfJson, writeGlb } from "./glb.ts";
import {
  dropExtension,
  extension,
  index,
  isObject,
  type Json,
  malformed,
  objects,
  remapViews,
  strings,
  withoutExtensions,
} from "./gltf-json.ts";

/** The extension this step removes. */
export const MESH_QUANTIZATION = "KHR_mesh_quantization";
const TEXTURE_TRANSFORM = "KHR_texture_transform";
/** Attributes that keep their integers: skin joint indices. */
const KEEP_INTEGERS = /^JOINTS_/;
const UV0 = "TEXCOORD_0";

const COMPONENTS: Readonly<Record<string, number>> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** Bytes per component and how a stored integer reads back, per integer type a vertex attribute may have. */
const COMPONENT_READ: Readonly<
  Record<number, { bytes: number; read: (data: DataView, at: number) => number; normalized: (value: number) => number }>
> = {
  [GltfComponent.Byte]: { bytes: 1, read: (d, at) => d.getInt8(at), normalized: (v) => Math.max(v / 127, -1) },
  [GltfComponent.UnsignedByte]: { bytes: 1, read: (d, at) => d.getUint8(at), normalized: (v) => v / 255 },
  [GltfComponent.Short]: {
    bytes: 2,
    read: (d, at) => d.getInt16(at, true),
    normalized: (v) => Math.max(v / 32767, -1),
  },
  [GltfComponent.UnsignedShort]: { bytes: 2, read: (d, at) => d.getUint16(at, true), normalized: (v) => v / 65535 },
};

/** Whether the document says it is quantized: the step runs only then. */
export const usesMeshQuantization = (json: Json) => strings(json.extensionsUsed).includes(MESH_QUANTIZATION);

/** Every primitive's attribute maps: its own, then its morph targets'. */
function attributeMaps(primitive: Json): Json[] {
  const own = isObject(primitive.attributes) ? [primitive.attributes] : [];
  return [...own, ...objects(primitive.targets)];
}

function primitives(json: Json): Json[] {
  return objects(json.meshes).flatMap((mesh) => objects(mesh.primitives));
}

/** Every attribute use of every primitive and morph target: its semantic and accessor index. */
function attributeUses(json: Json): Array<[string, number]> {
  const accessors = objects(json.accessors);
  return primitives(json)
    .flatMap(attributeMaps)
    .flatMap((map) => Object.entries(map))
    .map(([semantic, value]): [string, number] => {
      const at = index(value);
      if (at === null || !accessors[at]) throw malformed(`${semantic} names no accessor`);
      return [semantic, at];
    });
}

/** The accessors to rewrite as float, ascending; refuses one that is also a skin's joints. */
function quantizedAccessors(json: Json): number[] {
  const accessors = objects(json.accessors);
  const uses = attributeUses(json);
  const joints = new Set(uses.filter(([semantic]) => KEEP_INTEGERS.test(semantic)).map(([, at]) => at));
  const quantized = (at: number) => accessors[at]?.componentType !== GltfComponent.Float;
  const wanted = new Set(
    uses.filter(([semantic, at]) => !KEEP_INTEGERS.test(semantic) && quantized(at)).map(([, at]) => at),
  );
  const both = [...wanted].find((at) => joints.has(at));
  if (both !== undefined) throw malformed(`accessor ${both} is both a skin's joints and an attribute`);
  return [...wanted].sort((a, b) => a - b);
}

/** Where a quantized accessor's elements are in the binary chunk, and how each component reads. */
interface QuantizedLayout {
  kind: (typeof COMPONENT_READ)[number];
  width: number;
  count: number;
  /** Byte offset of element 0 in the binary chunk, or null for an accessor without a view (all zeros). */
  start: number | null;
  stride: number;
  normalized: boolean;
}

/** The layout of accessor `at`, checked to lie inside its view and the binary chunk. */
function quantizedLayout(json: Json, bin: Uint8Array, at: number): QuantizedLayout {
  const accessor = objects(json.accessors)[at] ?? {};
  const kind = COMPONENT_READ[accessor.componentType as number];
  const width = COMPONENTS[String(accessor.type)];
  const count = index(accessor.count);
  if (!kind || !width || count === null) throw malformed(`accessor ${at} has no glTF layout`);
  if (accessor.sparse !== undefined) throw malformed(`accessor ${at} is sparse and quantized`);
  const normalized = accessor.normalized === true;
  const viewAt = index(accessor.bufferView);
  if (viewAt === null) return { kind, width, count, start: null, stride: 0, normalized };
  const view = objects(json.bufferViews)[viewAt];
  if (!view || index(view.buffer) !== 0) throw malformed(`accessor ${at} reads outside the binary chunk`);
  const element = kind.bytes * width;
  const stride = index(view.byteStride) || element;
  const viewStart = index(view.byteOffset) ?? 0;
  const start = viewStart + (index(accessor.byteOffset) ?? 0);
  const viewEnd = viewStart + (index(view.byteLength) ?? 0);
  const end = count ? start + stride * (count - 1) + element : start;
  if (end > viewEnd || viewEnd > bin.byteLength) throw malformed(`accessor ${at} lies past its view`);
  return { kind, width, count, start, stride, normalized };
}

/** One quantized accessor's elements as float32, each component decoded as glTF-Transform does. */
function readAsFloat(json: Json, bin: Uint8Array, at: number): Float32Array {
  const { kind, width, count, start, stride, normalized } = quantizedLayout(json, bin, at);
  const out = new Float32Array(count * width);
  if (start === null) return out;
  const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const decode = normalized ? kind.normalized : (value: number) => value;
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < width; c++) out[i * width + c] = decode(kind.read(data, start + i * stride + c * kind.bytes));
  }
  return out;
}

/** A texture transform gltfpack writes: an offset and a scale, no rotation, on the first uv set. */
interface UvTransform {
  offset: readonly [number, number];
  scale: readonly [number, number];
}

/** Every `textureInfo` in a material (anything with an `index` under it), however deep. */
function textureInfos(owner: unknown): Json[] {
  if (Array.isArray(owner)) return owner.flatMap(textureInfos);
  if (!isObject(owner)) return [];
  const own = index(owner.index) !== null ? [owner] : [];
  return [...own, ...Object.values(owner).flatMap(textureInfos)];
}

const pair = (value: unknown, fallback: number): [number, number] | null => {
  if (value === undefined) return [fallback, fallback];
  const [x, y] = Array.isArray(value) ? value : [];
  return Array.isArray(value) && value.length === 2 && Number.isFinite(x) && Number.isFinite(y)
    ? [x as number, y as number]
    : null;
};

/** The one transform every texture of `material` carries, or null when they differ or one is absent. */
function uniformTransform(material: Json): UvTransform | null {
  const infos = textureInfos(material);
  const transforms = infos.map((info) => extension(info, TEXTURE_TRANSFORM));
  const first = transforms[0];
  if (!first || transforms.some((t) => JSON.stringify(t) !== JSON.stringify(first))) return null;
  const onUv0 = infos.every((info) => (index(info.texCoord) ?? 0) === 0) && (index(first.texCoord) ?? 0) === 0;
  const rotated = first.rotation !== undefined && first.rotation !== 0;
  const offset = pair(first.offset, 0);
  const scale = pair(first.scale, 1);
  return onUv0 && !rotated && offset && scale ? { offset, scale } : null;
}

/** The uv accessor of each material whose uniform transform can be baked, and the transform. */
function bakeableTransforms(json: Json, dequantized: ReadonlySet<number>): Map<number, UvTransform> {
  const materials = objects(json.materials);
  const owners = new Map<number, Set<number>>();
  for (const primitive of primitives(json)) {
    const uv = isObject(primitive.attributes) ? index(primitive.attributes[UV0]) : null;
    if (uv === null) continue;
    const users = owners.get(uv) ?? new Set<number>();
    users.add(index(primitive.material) ?? -1);
    owners.set(uv, users);
  }
  const bake = new Map<number, UvTransform>();
  for (const [uv, users] of owners) {
    const [material] = users;
    const only = users.size === 1 && material !== undefined && material >= 0;
    const transform = only && dequantized.has(uv) ? uniformTransform(materials[material] ?? {}) : null;
    if (transform) bake.set(uv, transform);
  }
  return bake;
}

/** `uv * scale + offset` in place, two components an element. */
function applyTransform(uvs: Float32Array, { offset, scale }: UvTransform): void {
  for (let i = 0; i < uvs.length; i += 2) {
    uvs[i] = (uvs[i] ?? 0) * scale[0] + offset[0];
    uvs[i + 1] = (uvs[i + 1] ?? 0) * scale[1] + offset[1];
  }
}

/** Drop the transforms just baked from the materials whose uvs took them. */
function dropBakedTransforms(json: Json, baked: ReadonlySet<number>): void {
  const materials = objects(json.materials);
  for (const primitive of primitives(json)) {
    const uv = isObject(primitive.attributes) ? index(primitive.attributes[UV0]) : null;
    const material = materials[index(primitive.material) ?? -1];
    if (uv === null || !baked.has(uv) || !material) continue;
    for (const info of textureInfos(material)) dropExtension(info, TEXTURE_TRANSFORM);
  }
}

/** Per-component bounds of float data, as single-precision values. */
function bounds(values: Float32Array, width: number): { min: number[]; max: number[] } {
  const min = Array.from({ length: width }, () => Number.POSITIVE_INFINITY);
  const max = Array.from({ length: width }, () => Number.NEGATIVE_INFINITY);
  for (let i = 0; i < values.length; i++) {
    const c = i % width;
    const value = values[i] ?? 0;
    if (value < (min[c] ?? 0)) min[c] = value;
    if (value > (max[c] ?? 0)) max[c] = value;
  }
  return { min: min.map(Math.fround), max: max.map(Math.fround) };
}

/** The views anything still reads once `rewritten` accessors have moved to views of their own. */
function viewsInUse(json: Json, rewritten: ReadonlySet<number>): Set<number> {
  const used = new Set<number>();
  const add = (owner: unknown) => {
    const at = isObject(owner) ? index(owner.bufferView) : null;
    if (at !== null) used.add(at);
  };
  objects(json.accessors).forEach((accessor, at) => {
    if (!rewritten.has(at)) add(accessor);
    const sparse = isObject(accessor.sparse) ? accessor.sparse : undefined;
    add(sparse?.indices);
    add(sparse?.values);
  });
  for (const image of objects(json.images)) add(image);
  return used;
}

/**
 * A quantized GLB (its parsed JSON, which this changes, and binary chunk) written back with float
 * attributes and without `KHR_mesh_quantization`; throws a `malformed` {@link GltfImportError}
 * on an accessor it cannot read. Views only the rewritten accessors read are left out.
 */
export function dequantizeGlb(json: Json, bin: Uint8Array): Uint8Array {
  const targets = quantizedAccessors(json);
  const floats = new Map(targets.map((at) => [at, readAsFloat(json, bin, at)]));
  const bake = bakeableTransforms(json, new Set(targets));
  for (const [uv, transform] of bake) {
    const data = floats.get(uv);
    if (data) applyTransform(data, transform);
  }
  dropBakedTransforms(json, new Set(bake.keys()));
  const rewritten = new Set(targets);
  const used = viewsInUse(json, rewritten);
  const out = new BinWriter();
  const moved = new Map<number, number>();
  objects(json.bufferViews).forEach((view, at) => {
    if (!used.has(at)) return;
    const offset = index(view.byteOffset) ?? 0;
    const length = index(view.byteLength) ?? 0;
    if (index(view.buffer) !== 0 || offset + length > bin.byteLength)
      throw malformed(`view ${at} lies outside the binary chunk`);
    const stride = index(view.byteStride);
    const fields = { ...(view.target === undefined ? {} : { target: view.target as number }) };
    moved.set(at, out.add(bin.subarray(offset, offset + length), stride ? { ...fields, byteStride: stride } : fields));
  });
  remapViews(json, moved);
  const accessors = objects(json.accessors);
  for (const at of targets) writeFloatAccessor(accessors[at] ?? {}, floats.get(at) ?? new Float32Array(0), out);
  const data = out.bytes();
  const transformsLeft = objects(json.materials).some((material) =>
    textureInfos(material).some((info) => extension(info, TEXTURE_TRANSFORM)),
  );
  const gone = (name: string) => name === MESH_QUANTIZATION || (name === TEXTURE_TRANSFORM && !transformsLeft);
  const finished = withoutExtensions(
    { ...json, bufferViews: out.views, buffers: [{ byteLength: data.byteLength }] },
    gone,
  );
  return writeGlb(finished as GltfJson, data);
}

/** Point `accessor` at a new float view of `values`, its bounds recomputed when it had any. */
function writeFloatAccessor(accessor: Json, values: Float32Array, out: BinWriter): void {
  const width = COMPONENTS[String(accessor.type)] ?? 1;
  const hadBounds = accessor.min !== undefined || accessor.max !== undefined;
  const bufferView = out.add(values, { target: ARRAY_BUFFER });
  Object.assign(accessor, { bufferView, componentType: GltfComponent.Float }, hadBounds ? bounds(values, width) : {});
  delete accessor.byteOffset;
  delete accessor.normalized;
}
