/**
 * The binary glTF container (GLB, glTF 2.0 §4.4) read and written, and the plain mesh model the
 * converters build written as one: positions, optional normals, texture coordinates and colours,
 * triangle indices, base-colour materials. The output is a pure function of the input, byte for
 * byte, so an import is reproducible.
 */

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const SPACE = 0x20;
/** glTF component types (accessor `componentType`). */
export const GltfComponent = {
  Byte: 5120,
  UnsignedByte: 5121,
  Short: 5122,
  UnsignedShort: 5123,
  UnsignedInt: 5125,
  Float: 5126,
} as const;
export type GltfComponent = (typeof GltfComponent)[keyof typeof GltfComponent];
const FLOAT = GltfComponent.Float;
const UNSIGNED_SHORT = GltfComponent.UnsignedShort;
const UNSIGNED_INT = GltfComponent.UnsignedInt;
/** glTF buffer view targets. */
export const ARRAY_BUFFER = 34962;
export const ELEMENT_ARRAY_BUFFER = 34963;
const TRIANGLES = 4;
/** The largest vertex index a 16-bit index buffer holds. */
const MAX_SHORT_INDEX = 0xffff;
const GENERATOR = "Genex asset import";

/** A glTF document's JSON, as far as this module reads it. */
export type GltfJson = Record<string, unknown>;

/** A GLB split into its JSON and its binary chunk (empty when it has none). */
export interface GlbParts {
  json: GltfJson;
  bin: Uint8Array;
}

/** Why a GLB could not be read. */
export class GlbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlbError";
  }
}

/** Whether `bytes` start like a GLB. */
export function isGlb(bytes: Uint8Array): boolean {
  return bytes.byteLength >= HEADER_BYTES && view(bytes).getUint32(0, true) === GLB_MAGIC;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The JSON and binary chunks of a GLB; throws {@link GlbError} on anything that is not one. */
export function readGlb(bytes: Uint8Array): GlbParts {
  if (!isGlb(bytes)) throw new GlbError("not a GLB");
  const data = view(bytes);
  if (data.getUint32(4, true) !== GLB_VERSION) throw new GlbError("not glTF 2.0");
  const length = data.getUint32(8, true);
  if (length > bytes.byteLength || length < HEADER_BYTES + CHUNK_HEADER_BYTES) throw new GlbError("bad length");
  const jsonChunk = readChunk(bytes, HEADER_BYTES, length);
  if (jsonChunk.type !== CHUNK_JSON) throw new GlbError("first chunk is not JSON");
  const json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(jsonChunk.body)) as unknown;
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new GlbError("JSON chunk is not an object");
  const next = jsonChunk.end;
  const bin = next < length ? readChunk(bytes, next, length) : null;
  if (bin && bin.type !== CHUNK_BIN) throw new GlbError("second chunk is not BIN");
  return { json: json as GltfJson, bin: bin ? bin.body : new Uint8Array(0) };
}

function readChunk(bytes: Uint8Array, at: number, length: number): { type: number; body: Uint8Array; end: number } {
  if (at + CHUNK_HEADER_BYTES > length) throw new GlbError("truncated chunk header");
  const size = view(bytes).getUint32(at, true);
  const type = view(bytes).getUint32(at + 4, true);
  const start = at + CHUNK_HEADER_BYTES;
  if (start + size > length) throw new GlbError("truncated chunk");
  return { type, body: bytes.subarray(start, start + size), end: start + size };
}

const padded = (size: number) => Math.ceil(size / 4) * 4;

/** A GLB of `json` and `bin`; the JSON is padded with spaces, the binary chunk with zeros. */
export function writeGlb(json: GltfJson, bin: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonSize = padded(text.byteLength);
  const binSize = padded(bin.byteLength);
  const total = HEADER_BYTES + CHUNK_HEADER_BYTES + jsonSize + (bin.byteLength ? CHUNK_HEADER_BYTES + binSize : 0);
  const out = new Uint8Array(total);
  const data = view(out);
  data.setUint32(0, GLB_MAGIC, true);
  data.setUint32(4, GLB_VERSION, true);
  data.setUint32(8, total, true);
  data.setUint32(12, jsonSize, true);
  data.setUint32(16, CHUNK_JSON, true);
  out.set(text, 20);
  out.fill(SPACE, 20 + text.byteLength, 20 + jsonSize);
  if (bin.byteLength) {
    const at = 20 + jsonSize;
    data.setUint32(at, binSize, true);
    data.setUint32(at + 4, CHUNK_BIN, true);
    out.set(bin, at + CHUNK_HEADER_BYTES);
  }
  return out;
}

/** One triangle list with one material. */
export interface MeshPrimitive {
  /** xyz per vertex. */
  positions: Float32Array;
  /** xyz per vertex, unit length. */
  normals?: Float32Array;
  /** uv per vertex, glTF's origin (top left). */
  uvs?: Float32Array;
  /** rgb per vertex, 0–1. */
  colors?: Float32Array;
  indices: Uint32Array;
  /** Index into the document's materials. */
  material?: number;
}

/** A base-colour material: what OBJ's MTL and PLY's colours carry. */
export interface MeshMaterial {
  name: string;
  /** Linear rgba, 0–1. */
  baseColor: readonly [number, number, number, number];
  /** A texture beside the model, as a relative URI the runtime resolves under the safe-path rule. */
  texture?: string;
}

/** A converted model: one mesh of primitives. */
export interface MeshDocument {
  name: string;
  primitives: MeshPrimitive[];
  materials: MeshMaterial[];
}

/** A buffer view's own fields besides where it is. */
export interface ViewFields {
  target?: number;
  byteStride?: number;
}

/** The binary chunk being built: views appended in order, each starting 4-byte aligned. */
export class BinWriter {
  readonly views: Array<{ buffer: 0; byteOffset: number; byteLength: number } & ViewFields> = [];
  #parts: Uint8Array[] = [];
  #length = 0;

  /** Append `data` as a new buffer view of buffer 0; returns its index. */
  add(data: ArrayBufferView, fields: ViewFields = {}): number {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.views.push({ buffer: 0, byteOffset: this.#length, byteLength: bytes.byteLength, ...fields });
    this.#parts.push(bytes);
    const pad = padded(bytes.byteLength) - bytes.byteLength;
    if (pad) this.#parts.push(new Uint8Array(pad));
    this.#length += bytes.byteLength + pad;
    return this.views.length - 1;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let at = 0;
    for (const part of this.#parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  }
}

/** The per-component bounds glTF requires on POSITION. */
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

const VEC_TYPE: Readonly<Record<number, string>> = { 2: "VEC2", 3: "VEC3" };

/** The accessors and views of one primitive, appended to `bin` and `accessors`. */
function writePrimitive(primitive: MeshPrimitive, bin: BinWriter, accessors: GltfJson[]): GltfJson {
  const count = primitive.positions.length / 3;
  const attribute = (values: Float32Array, width: number, extra: GltfJson = {}) => {
    const bufferView = bin.add(values, { target: ARRAY_BUFFER });
    accessors.push({ bufferView, componentType: FLOAT, count, type: VEC_TYPE[width], ...extra });
    return accessors.length - 1;
  };
  const attributes: GltfJson = { POSITION: attribute(primitive.positions, 3, bounds(primitive.positions, 3)) };
  if (primitive.normals) attributes.NORMAL = attribute(primitive.normals, 3);
  if (primitive.uvs) attributes.TEXCOORD_0 = attribute(primitive.uvs, 2);
  if (primitive.colors) attributes.COLOR_0 = attribute(primitive.colors, 3);
  const short = count <= MAX_SHORT_INDEX;
  const indexData = short ? Uint16Array.from(primitive.indices) : primitive.indices;
  const indexView = bin.add(indexData, { target: ELEMENT_ARRAY_BUFFER });
  accessors.push({
    bufferView: indexView,
    componentType: short ? UNSIGNED_SHORT : UNSIGNED_INT,
    count: primitive.indices.length,
    type: "SCALAR",
  });
  const material = primitive.material === undefined ? {} : { material: primitive.material };
  return { attributes, indices: accessors.length - 1, mode: TRIANGLES, ...material };
}

/** The materials, with one texture (and image) per distinct texture URI, in first-use order. */
function writeMaterials(materials: readonly MeshMaterial[]): GltfJson {
  const uris = [...new Set(materials.flatMap((material) => (material.texture ? [material.texture] : [])))];
  const gltfMaterials = materials.map((material) => {
    const pbr: GltfJson = { baseColorFactor: [...material.baseColor], metallicFactor: 0, roughnessFactor: 1 };
    if (material.texture) pbr.baseColorTexture = { index: uris.indexOf(material.texture) };
    return { name: material.name, pbrMetallicRoughness: pbr };
  });
  if (!gltfMaterials.length) return {};
  if (!uris.length) return { materials: gltfMaterials };
  return {
    materials: gltfMaterials,
    images: uris.map((uri) => ({ uri })),
    samplers: [{}],
    textures: uris.map((_, source) => ({ sampler: 0, source })),
  };
}

/** `doc` as a GLB: one scene, one node, one mesh. Empty primitives are dropped. */
export function meshToGlb(doc: MeshDocument): Uint8Array {
  const bin = new BinWriter();
  const accessors: GltfJson[] = [];
  const primitives = doc.primitives
    .filter((primitive) => primitive.indices.length > 0)
    .map((primitive) => writePrimitive(primitive, bin, accessors));
  const data = bin.bytes();
  const json: GltfJson = {
    asset: { version: "2.0", generator: GENERATOR },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: doc.name }],
    meshes: [{ name: doc.name, primitives }],
    ...writeMaterials(doc.materials),
    accessors,
    bufferViews: bin.views,
    buffers: [{ byteLength: data.byteLength }],
  };
  return writeGlb(json, data);
}
