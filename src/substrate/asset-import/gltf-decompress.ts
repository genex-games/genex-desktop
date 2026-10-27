/**
 * A glTF the Rust runtime can read as delivered: the runtime's `gltf` 1.4.1 has no Draco or
 * meshopt decoder, so a GLB whose meshes use `KHR_draco_mesh_compression` or
 * `EXT_meshopt_compression` is written back with plain buffer views (one binary chunk, every view
 * re-laid out), and a GLB using `KHR_mesh_quantization` (gltfpack's default) is then written back
 * with float attributes (`dequantize.ts`). Anything else the file requires must be an extension
 * the runtime reads, or the file is refused. A `.gltf` (JSON with external buffers) is checked,
 * never rewritten. Before any of this, a GLB's accessor bounds are written from its data
 * (`bounds.ts`) and the file passes the glTF validation gate (`validate.ts`): nothing decodes a
 * file the validator finds an error in.
 */
import { repairAccessorBounds } from "./bounds.ts";
import { AssetImportRefusal } from "./import-plan.ts";
import {
  ARRAY_BUFFER,
  BinWriter,
  ELEMENT_ARRAY_BUFFER,
  GltfComponent,
  type GltfJson,
  readGlb,
  writeGlb,
} from "./glb.ts";
import { type DracoDecoder, type DracoModule, dracoDecoder, meshoptDecoder } from "./decoders.ts";
import { dequantizeGlb, MESH_QUANTIZATION, usesMeshQuantization } from "./dequantize.ts";
import {
  dropExtension,
  extension,
  GltfImportError,
  index,
  isObject,
  type Json,
  malformed,
  objects,
  remapViews,
  strings,
  withoutExtensions,
} from "./gltf-json.ts";
import { type GltfIssue, GltfIssueCode, GltfIssueSeverity, validateGltf } from "./validate.ts";

const DRACO = "KHR_draco_mesh_compression";
const MESHOPT = ["EXT_meshopt_compression", "KHR_meshopt_compression"] as const;
/** The compression extensions the import step removes by decoding them. */
const DECOMPRESSED: ReadonlySet<string> = new Set([DRACO, ...MESHOPT]);
/** Every extension the import step removes: the compressions, and quantization (`dequantize.ts`). */
const DECODED: ReadonlySet<string> = new Set([...DECOMPRESSED, MESH_QUANTIZATION]);
/**
 * The extensions `genex-assets` reads (the `gltf` features the workspace enables) and the ones a
 * renderer may ignore: a file may *require* only these.
 */
export const RUNTIME_GLTF_EXTENSIONS: ReadonlySet<string> = new Set([
  "KHR_lights_punctual",
  "KHR_materials_emissive_strength",
  "KHR_materials_unlit",
  "KHR_texture_transform",
]);

/** Refuse a file that still requires an extension the runtime does not read. */
function checkRequired(json: Json, decoded: boolean): void {
  for (const name of strings(json.extensionsRequired)) {
    if (decoded && DECODED.has(name)) continue;
    if (!RUNTIME_GLTF_EXTENSIONS.has(name)) {
      throw new GltfImportError(AssetImportRefusal.UnsupportedExtension, `requires ${name}`);
    }
  }
}

/** The bytes of every buffer a GLB holds: buffer 0 is the binary chunk; a meshopt fallback buffer has none. */
function bufferData(json: Json, bin: Uint8Array): Array<Uint8Array | null> {
  return objects(json.buffers).map((buffer, at) => {
    const fallback = MESHOPT.some((name) => extension(buffer, name)?.fallback === true);
    if (fallback) return null;
    if (at === 0 && buffer.uri === undefined) return bin;
    throw malformed("a GLB buffer outside the binary chunk");
  });
}

/** A slice of a buffer, bounds-checked. */
function slice(buffers: Array<Uint8Array | null>, buffer: unknown, offset: unknown, length: unknown): Uint8Array {
  const data = buffers[index(buffer) ?? -1];
  const start = offset === undefined ? 0 : index(offset);
  const size = index(length);
  if (!data || start === null || size === null || start + size > data.byteLength) throw malformed("bad buffer view");
  return data.subarray(start, start + size);
}

/** Each view's bytes: plain views sliced, meshopt views decoded. */
async function viewData(json: Json, buffers: Array<Uint8Array | null>): Promise<Uint8Array[]> {
  const views = objects(json.bufferViews);
  const meshopt = views.some((view) => MESHOPT.some((name) => extension(view, name)));
  const decoder = meshopt ? await meshoptDecoder() : null;
  return views.map((view) => {
    const compressed = MESHOPT.map((name) => extension(view, name)).find((found) => found !== null);
    if (!compressed || !decoder) return slice(buffers, view.buffer, view.byteOffset, view.byteLength);
    const count = index(compressed.count);
    const stride = index(compressed.byteStride);
    if (count === null || stride === null || !stride) throw malformed("bad meshopt view");
    const source = slice(buffers, compressed.buffer, compressed.byteOffset, compressed.byteLength);
    const target = new Uint8Array(count * stride);
    const mode = typeof compressed.mode === "string" ? compressed.mode : "";
    const filter = typeof compressed.filter === "string" ? compressed.filter : "NONE";
    try {
      decoder.decodeGltfBuffer(target, count, stride, source, mode, filter);
    } catch {
      throw malformed("meshopt data does not decode");
    }
    for (const name of MESHOPT) dropExtension(view, name);
    return target;
  });
}

const COMPONENTS: Readonly<Record<string, number>> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** Draco's data type and the typed array of each glTF component type. */
function dracoType(draco: DracoModule, component: unknown): { type: number; size: number } {
  const table: Readonly<Record<number, { type: number; size: number }>> = {
    [GltfComponent.Byte]: { type: draco.DT_INT8, size: 1 },
    [GltfComponent.UnsignedByte]: { type: draco.DT_UINT8, size: 1 },
    [GltfComponent.Short]: { type: draco.DT_INT16, size: 2 },
    [GltfComponent.UnsignedShort]: { type: draco.DT_UINT16, size: 2 },
    [GltfComponent.UnsignedInt]: { type: draco.DT_UINT32, size: 4 },
    [GltfComponent.Float]: { type: draco.DT_FLOAT32, size: 4 },
  };
  const found = typeof component === "number" ? table[component] : undefined;
  if (!found) throw malformed("bad accessor component type");
  return found;
}

/** Copy `byteLength` bytes Draco writes through `write` out of its heap. */
function fromHeap(draco: DracoModule, byteLength: number, write: (pointer: number) => boolean): Uint8Array {
  const pointer = draco._malloc(byteLength);
  try {
    if (!write(pointer)) throw malformed("draco data does not decode");
    return draco.HEAPU8.slice(pointer, pointer + byteLength);
  } finally {
    draco._free(pointer);
  }
}

/** Indices as the accessor's own component type. */
function indexBytes(indices: Uint32Array, component: unknown): Uint8Array {
  if (component === GltfComponent.UnsignedByte) return Uint8Array.from(indices);
  if (component === GltfComponent.UnsignedShort) return new Uint8Array(Uint16Array.from(indices).buffer);
  return new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength);
}

/** One Draco primitive decoded: its accessors pointed at new plain views appended to `bin`. */
function decodeDracoPrimitive(
  context: { draco: DracoModule; decoder: DracoDecoder; accessors: Json[]; views: Uint8Array[]; bin: BinWriter },
  primitive: Json,
  compressed: Json,
): void {
  const { draco, decoder, accessors, views, bin } = context;
  const data = views[index(compressed.bufferView) ?? -1];
  if (!data) throw malformed("draco view missing");
  const mesh = new draco.Mesh();
  try {
    const status = decoder.DecodeArrayToMesh(
      new Int8Array(data.buffer, data.byteOffset, data.byteLength),
      data.byteLength,
      mesh,
    );
    if (!status.ok?.()) throw malformed("draco data does not decode");
    const points = mesh.num_points?.() ?? 0;
    const attributes = isObject(compressed.attributes) ? compressed.attributes : {};
    const own = isObject(primitive.attributes) ? primitive.attributes : {};
    for (const [name, id] of Object.entries(attributes)) {
      const accessor = accessors[index(own[name]) ?? -1];
      const unique = index(id);
      if (!accessor || unique === null) throw malformed(`draco attribute ${name}`);
      const { type, size } = dracoType(draco, accessor.componentType);
      const width = COMPONENTS[String(accessor.type)] ?? 0;
      const attribute = decoder.GetAttributeByUniqueId(mesh, unique);
      const bytes = fromHeap(draco, points * width * size, (at) =>
        decoder.GetAttributeDataArrayForAllPoints(mesh, attribute, type, points * width * size, at),
      );
      Object.assign(accessor, { bufferView: bin.add(bytes, { target: ARRAY_BUFFER }), count: points });
      delete accessor.byteOffset;
    }
    decodeDracoIndices(context, primitive, mesh);
  } finally {
    draco.destroy(mesh);
  }
}

function decodeDracoIndices(
  context: { draco: DracoModule; decoder: DracoDecoder; accessors: Json[]; bin: BinWriter },
  primitive: Json,
  mesh: InstanceType<DracoModule["Mesh"]>,
): void {
  const accessor = context.accessors[index(primitive.indices) ?? -1];
  if (!accessor) return;
  const count = (mesh.num_faces?.() ?? 0) * 3;
  const raw = fromHeap(context.draco, count * 4, (at) => context.decoder.GetTrianglesUInt32Array(mesh, count * 4, at));
  const indices = new Uint32Array(raw.buffer, raw.byteOffset, count);
  const bytes = indexBytes(indices, accessor.componentType);
  Object.assign(accessor, { bufferView: context.bin.add(bytes, { target: ELEMENT_ARRAY_BUFFER }), count });
  delete accessor.byteOffset;
}

/** Every primitive that carries Draco data, with its extension object. */
function dracoPrimitives(json: Json): Array<{ primitive: Json; compressed: Json }> {
  return objects(json.meshes).flatMap((mesh) =>
    objects(mesh.primitives).flatMap((primitive) => {
      const compressed = extension(primitive, DRACO);
      return compressed ? [{ primitive, compressed }] : [];
    }),
  );
}

/** A GLB with Draco or meshopt data, written back with plain views in one binary chunk. */
async function rewriteGlb(json: Json, bin: Uint8Array): Promise<Uint8Array> {
  const views = await viewData(json, bufferData(json, bin));
  const draco = dracoPrimitives(json);
  const dracoViews = new Set(draco.map(({ compressed }) => index(compressed.bufferView)));
  const out = new BinWriter();
  const moved = new Map<number, number>();
  objects(json.bufferViews).forEach((view, at) => {
    if (dracoViews.has(at)) return;
    const fields = { ...(view.target === undefined ? {} : { target: view.target as number }) };
    const stride = index(view.byteStride);
    moved.set(at, out.add(views[at] ?? new Uint8Array(0), stride ? { ...fields, byteStride: stride } : fields));
  });
  remapViews(json, moved);
  if (draco.length) {
    const module = await dracoDecoder();
    const decoder = new module.Decoder();
    const context = { draco: module, decoder, accessors: objects(json.accessors), views, bin: out };
    try {
      for (const { primitive, compressed } of draco) {
        decodeDracoPrimitive(context, primitive, compressed);
        dropExtension(primitive, DRACO);
      }
    } finally {
      module.destroy(decoder);
    }
  }
  const data = out.bytes();
  return writeGlb(finishJson(json, out, data.byteLength), data);
}

/** The document with the decompressed extensions gone and one buffer, the binary chunk. */
function finishJson(json: Json, out: BinWriter, byteLength: number): GltfJson {
  return withoutExtensions({ ...json, bufferViews: out.views, buffers: [{ byteLength }] }, (name) =>
    DECOMPRESSED.has(name),
  ) as GltfJson;
}

/** Whether `json` uses a compression the import step decodes. */
const needsDecompressing = (json: Json) => strings(json.extensionsUsed).some((name) => DECOMPRESSED.has(name));

/** A glTF file as the import step writes it, with the validator's warnings about the input. */
export interface ImportedGltf {
  bytes: Uint8Array;
  issues: GltfIssue[];
}

/** The most bounds repairs one file reports, so the validator's own warnings keep room in the receipt. */
const BOUNDS_ISSUES_MAX = 8;

/**
 * A glTF file validated (`validate.ts`), then in the form the runtime loads: a GLB with its
 * accessor bounds written from its data first (`bounds.ts`, each repair a warning), Draco or
 * meshopt data rewritten plain, then a quantized one with float attributes, any other file
 * unchanged. Throws {@link GltfImportError} when the validator finds an error, when it is damaged,
 * or when it requires an extension the runtime does not read; a compressed `.gltf` is refused
 * (deliver it as GLB).
 */
export async function importGltf(bytes: Uint8Array, ext: string): Promise<ImportedGltf> {
  const bounded = ext === "glb" ? repairAccessorBounds(bytes) : { bytes, repaired: [] };
  const repairs: GltfIssue[] = bounded.repaired.slice(0, BOUNDS_ISSUES_MAX).map((at) => ({
    code: GltfIssueCode.BoundsRepaired,
    severity: GltfIssueSeverity.Warning,
    pointer: `/accessors/${at}`,
  }));
  const issues = await validateGltf(bounded.bytes, ext);
  return { bytes: await normalizeValid(bounded.bytes, ext), issues: [...repairs, ...issues] };
}

/** {@link importGltf}'s output bytes alone. */
export async function normalizeGltf(bytes: Uint8Array, ext: string): Promise<Uint8Array> {
  return (await importGltf(bytes, ext)).bytes;
}

/** The runtime's form of a file the gate passed. */
async function normalizeValid(bytes: Uint8Array, ext: string): Promise<Uint8Array> {
  if (ext === "gltf") {
    const json = parseJson(bytes);
    checkRequired(json, false);
    return bytes;
  }
  let parts: { json: GltfJson; bin: Uint8Array };
  try {
    parts = readGlb(bytes);
  } catch (error) {
    throw malformed(error instanceof Error ? error.message : "not a GLB");
  }
  checkRequired(parts.json, true);
  const quantized = usesMeshQuantization(parts.json);
  const plain = needsDecompressing(parts.json) ? await rewriteGlb(structuredClone(parts.json), parts.bin) : bytes;
  if (!quantized) return plain;
  const decompressed = plain === bytes ? parts : readGlb(plain);
  return dequantizeGlb(structuredClone(decompressed.json), decompressed.bin);
}

function parseJson(bytes: Uint8Array): Json {
  try {
    const json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (isObject(json)) return json;
  } catch {
    // Refused below.
  }
  throw malformed("not glTF JSON");
}
