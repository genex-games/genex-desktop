/**
 * The asset gate: a model in the game folder checked before it reaches a Roblox place (decision 15).
 *
 * - Only `.glb` and `.gltf`. An FBX is answered with how to export it as `.glb`.
 * - What a Roblox mesh takes, and what a phone draws well: at most {@link MAX_MODEL_TRIANGLES}
 *   triangles; closed (every edge, once vertices at the same place are welded, shared by exactly two
 *   triangles); one material; at most {@link MAX_BONE_INFLUENCES} bone influences per vertex; the
 *   scene's roots at the origin; textures at most {@link MAX_TEXTURE_SIDE} by
 *   {@link MAX_TEXTURE_SIDE} by default.
 * - Texture sizes come from the pictures' own headers, read here by hand (PNG `IHDR`, a JPEG's
 *   frame marker), never by decoding them.
 * - The file is the agent's to name, so it is read like hostile input: a path inside the game folder
 *   with no link anywhere on the way, a size cap checked before any read, and a GLB read stage by
 *   stage, so a broken header is refused before anything past it is read. A `.gltf`'s buffers and
 *   pictures follow the same rules, or come inline as `data:` addresses.
 *
 * A model that passes carries its triangles in world space, for `model-import.ts`.
 */
import { constants as FS, type Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { openNoFollow } from "../../substrate/fsx.ts";

/** The most triangles a Roblox mesh takes. */
export const MAX_MODEL_TRIANGLES = 20_000;
/** The most bones that move one vertex. */
export const MAX_BONE_INFLUENCES = 4;
/** The longest texture side by default: phone-sized. */
export const MAX_TEXTURE_SIDE = 1024;
/** The largest model file, and all its buffers together, the gate reads. */
export const MAX_MODEL_BYTES = 64 * 1024 * 1024;
/** The largest glTF JSON (a GLB's JSON chunk, or a whole `.gltf`). */
const MAX_JSON_BYTES = 8 * 1024 * 1024;
/** Past this many triangles the model is only counted: its edges and shape aren't built. */
const MAX_BUILT_TRIANGLES = 10 * MAX_MODEL_TRIANGLES;
/** The most values one accessor may hold. */
const MAX_ACCESSOR_COUNT = 4 * 1024 * 1024;
/** Vertices this close are one vertex when edges are counted, as exporters split them per face. */
const WELD_STEP = 1e-5;
/** How far a root may sit from the origin and still be at it. */
const ORIGIN_TOLERANCE = 1e-4;
/** The most marker segments read in a JPEG before giving up on its frame. */
const MAX_JPEG_SEGMENTS = 1024;

const GLB_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const GLB_MAGIC = "glTF";
const GLB_VERSION = 2;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
/** glTF's primitive mode for triangles, the default. */
const TRIANGLES = 4;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** A JPEG's frame markers (SOFn): every 0xC0–0xCF but DHT, JPG and DAC. */
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
/** JPEG markers that stand alone, with no length: TEM, RST0–7, SOI. */
const JPEG_STANDALONE = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8]);
const JPEG_SCAN = 0xda;
const JPEG_END = 0xd9;

/** Extensions a model may require and still be read: they change nothing the gate measures. */
const READABLE_EXTENSION = (name: string) =>
  name === "KHR_mesh_quantization" || name === "KHR_texture_transform" || name.startsWith("KHR_materials_");
const COMPRESSION_EXTENSIONS = new Set(["KHR_draco_mesh_compression", "EXT_meshopt_compression"]);

/** A component type's bytes, and the largest value of a normalized integer of that type. */
const COMPONENT = {
  5120: { bytes: 1, max: 127 },
  5121: { bytes: 1, max: 255 },
  5122: { bytes: 2, max: 32_767 },
  5123: { bytes: 2, max: 65_535 },
  5125: { bytes: 4, max: 4_294_967_295 },
  5126: { bytes: 4, max: 1 },
} as const satisfies Record<number, { bytes: number; max: number }>;
type ComponentType = keyof typeof COMPONENT;
const SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 } as const;

/** What a model that can be read fails on. Wire values: never rename. */
export const ModelProblem = {
  Triangles: "triangles",
  Watertight: "watertight",
  Materials: "materials",
  Influences: "influences",
  Origin: "origin",
  Texture: "texture",
} as const;
export type ModelProblem = (typeof ModelProblem)[keyof typeof ModelProblem];

/** Why a model can't be checked at all. Wire values: never rename. */
export const ModelRefusal = {
  /** Not a plain path inside the game folder. */
  Path: "path",
  Link: "link",
  Missing: "missing",
  NotFile: "not-file",
  Fbx: "fbx",
  Format: "format",
  TooLarge: "too-large",
  Malformed: "malformed",
  Unsupported: "unsupported",
  /** The tool's own arguments aren't what it takes. */
  Arguments: "arguments",
} as const;
export type ModelRefusal = (typeof ModelRefusal)[keyof typeof ModelRefusal];

const fmt = (value: number) => value.toLocaleString("en-US");
const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;
const plural = (count: number, one: string, many: string) => `${fmt(count)} ${count === 1 ? one : many}`;
const coordinate = (value: number) => String(Number(value.toFixed(3)));

const MESSAGE = {
  path: (name: string) => `${name} must be a path inside the game folder, such as models/chair.glb.`,
  missing: (name: string) => `There's no ${name} in the game folder.`,
  link: (name: string) => `${name} goes through a link; Genex checks only files that are really in the game folder.`,
  notFile: (name: string) => `${name} isn't a file.`,
  fbx: (name: string) =>
    `Genex checks only .glb and .gltf models, not ${name}. Export it as .glb (in Blender: File › Export › glTF 2.0, format glTF Binary) and check that file.`,
  format: (name: string) => `Genex checks only .glb or .gltf models; export ${name} as .glb.`,
  tooLarge: (name: string) =>
    `${name} is larger than ${megabytes(MAX_MODEL_BYTES)} with its buffers; a Roblox mesh is far smaller. Reduce it and export again.`,
  jsonTooLarge: (name: string) => `${name} is larger than ${megabytes(MAX_JSON_BYTES)} of glTF text.`,
  notGlb: (name: string) => `${name} isn't a whole GLB file: its header doesn't match its size. Export it again.`,
  notGltf: (name: string, why: string) => `${name} isn't a readable glTF file: ${why}. Export it again.`,
  compressed: (name: string, extension: string) =>
    `${name} is compressed (${extension}). Export it again without mesh compression (in Blender, turn Compression off).`,
  extension: (name: string, extension: string) =>
    `${name} needs the glTF extension ${extension}, which Genex can't read. Export it again without it.`,
  notTriangles: (name: string) => `${name} draws points or lines; only triangles go into a Roblox mesh.`,
  noTriangles: (name: string) => `${name} has no triangles to check.`,
  triangles: (count: number) =>
    `It has ${fmt(count)} triangles; a Roblox mesh takes at most ${fmt(MAX_MODEL_TRIANGLES)}. Reduce it (Blender's Decimate) and export again.`,
  open: (open: number, crowded: number) => {
    const holes = open ? `${plural(open, "edge borders", "edges border")} a hole` : "";
    const extra = crowded ? `${plural(crowded, "edge is", "edges are")} shared by more than two triangles` : "";
    return `It isn't closed: ${[holes, extra].filter(Boolean).join(", and ")}. Close the holes and merge vertices by distance, then export again.`;
  },
  materials: (count: number) =>
    `It uses ${count} materials; a Roblox mesh takes one. Join them into one material (one baked texture), or export one file per material.`,
  influences: (count: number) =>
    `${plural(count, "vertex is", "vertices are")} moved by more than ${MAX_BONE_INFLUENCES} bones; Roblox takes at most ${MAX_BONE_INFLUENCES}. Limit the weights to ${MAX_BONE_INFLUENCES} per vertex and export again.`,
  origin: (name: string, at: readonly number[]) =>
    `Its root "${name}" sits at (${at.map(coordinate).join(", ")}), not at the origin. Move it to 0, 0, 0 and apply the move before exporting.`,
  textureSize: (name: string, width: number, height: number, side: number) =>
    `Texture "${name}" is ${width} by ${height}; for phones keep textures at most ${side} by ${side}. Scale it down and export again.`,
  textureFormat: (name: string) =>
    `Texture "${name}" isn't a PNG or JPEG whose size Genex can read. Use PNG or JPEG textures.`,
} as const;

/** One thing a model fails on, in plain words. */
export interface ModelFinding {
  problem: ModelProblem;
  message: string;
}

/** A texture's size, read from its header. */
export interface TextureSize {
  name: string;
  format: ImageFormat;
  width: number;
  height: number;
}

/** A passing model's triangles in world space (glTF's metres), for the import. */
export interface CheckedMesh {
  positions: Float32Array;
  normals?: Float32Array;
  uvs?: Float32Array;
  indices: Uint32Array;
}

/** What the gate found in a model it could read. */
export interface ModelCheck {
  file: string;
  passed: boolean;
  triangles: number;
  materials: number;
  textures: TextureSize[];
  problems: ModelFinding[];
  /** Built while the model has at most {@link MAX_BUILT_TRIANGLES} triangles. */
  mesh?: CheckedMesh;
  /** The model's extent along x, y and z, in glTF's metres. */
  size?: [number, number, number];
}

/** The gate's answer: the check, or why the file can't be checked. */
export type GateAnswer = { ok: true; check: ModelCheck } | { ok: false; refusal: ModelRefusal; message: string };

/** Bytes that can be read at an offset: a file, or bytes already in memory. */
export interface ByteSource {
  size: number;
  /** Exactly `length` bytes at `offset`, or null when fewer are there. */
  read(offset: number, length: number): Promise<Buffer | null>;
}

/** An opened model file. */
export interface ModelFile extends ByteSource {
  close(): Promise<void>;
}

/** How the gate checks; tests hand in an `open` that records reads. */
export interface GateOptions {
  /** A stricter longest texture side than {@link MAX_TEXTURE_SIDE}. */
  textureSide?: number;
  open?(file: string): Promise<ModelFile>;
}

class GateRefusal extends Error {
  refusal: ModelRefusal;
  constructor(refusal: ModelRefusal, message: string) {
    super(message);
    this.refusal = refusal;
  }
}

const refuse = (refusal: ModelRefusal, message: string): never => {
  throw new GateRefusal(refusal, message);
};

/** Bytes in memory as a {@link ByteSource}. */
export function bytesSource(bytes: Uint8Array): ByteSource {
  const all = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    size: all.length,
    read: async (offset, length) =>
      offset >= 0 && length >= 0 && offset + length <= all.length ? all.subarray(offset, offset + length) : null,
  };
}

/** A regular file opened without following a link at its name. */
export async function openModelFile(file: string): Promise<ModelFile> {
  const handle = await openNoFollow(file, FS.O_RDONLY | FS.O_NONBLOCK);
  const info = await handle.stat().catch(async (error: unknown) => {
    await handle.close();
    throw error;
  });
  if (!info.isFile()) {
    await handle.close();
    throw new Error(`${file} isn't a file`);
  }
  return {
    size: info.size,
    async read(offset, length) {
      const bytes = Buffer.alloc(length);
      if (length === 0) return bytes;
      const { bytesRead } = await handle.read(bytes, 0, length, offset);
      return bytesRead === length ? bytes : null;
    },
    close: () => handle.close(),
  };
}

/** The picture formats whose size the gate reads. Wire values: never rename. */
export const ImageFormat = { Png: "png", Jpeg: "jpeg" } as const;
export type ImageFormat = (typeof ImageFormat)[keyof typeof ImageFormat];

/** What the JPEG marker at `at` leads to: the next marker, the frame's size fields, or nothing. */
type JpegStep = { next: number } | { frame: number } | undefined;

function jpegStep(marker: Buffer, at: number, size: number): JpegStep {
  if (marker[0] !== 0xff) return undefined;
  const code = marker[1] ?? 0;
  // A fill byte, then markers with no length of their own.
  if (code === 0xff) return { next: at + 1 };
  if (JPEG_STANDALONE.has(code)) return { next: at + 2 };
  if (code === JPEG_SCAN || code === JPEG_END) return undefined;
  const length = marker.readUInt16BE(2);
  if (length < 2 || at + 2 + length > size) return undefined;
  return JPEG_FRAMES.has(code) ? { frame: at + 5 } : { next: at + 2 + length };
}

/** A JPEG's size from its frame marker, walking only the markers before it: undefined without one. */
async function jpegSize(source: ByteSource): Promise<{ width: number; height: number } | undefined> {
  let at = 2;
  for (let segment = 0; segment < MAX_JPEG_SEGMENTS; segment++) {
    const marker = await source.read(at, 4);
    const step = marker ? jpegStep(marker, at, source.size) : undefined;
    if (!step) return undefined;
    if ("next" in step) {
      at = step.next;
      continue;
    }
    const frame = await source.read(step.frame, 4);
    return frame ? { height: frame.readUInt16BE(0), width: frame.readUInt16BE(2) } : undefined;
  }
  return undefined;
}

/** A PNG's or JPEG's size from its header, read by hand; undefined for anything else or a cut header. */
export async function imageSize(
  source: ByteSource,
): Promise<{ format: ImageFormat; width: number; height: number } | undefined> {
  const head = await source.read(0, Math.min(PNG_SIGNATURE.length, source.size));
  if (!head || head.length < 3) return undefined;
  if (head.length === PNG_SIGNATURE.length && head.equals(PNG_SIGNATURE)) {
    const ihdr = await source.read(PNG_SIGNATURE.length, 16);
    if (ihdr?.toString("latin1", 4, 8) !== "IHDR") return undefined;
    return { format: ImageFormat.Png, width: ihdr.readUInt32BE(8), height: ihdr.readUInt32BE(12) };
  }
  if (head[0] !== 0xff || head[1] !== 0xd8 || head[2] !== 0xff) return undefined;
  const size = await jpegSize(source);
  return size && { format: ImageFormat.Jpeg, ...size };
}

const isPlainRelative = (name: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them.
  !/[\u0000-\u001f\u007f\\]/.test(name) &&
  !path.posix.isAbsolute(name) &&
  !/^[a-zA-Z]:/.test(name) &&
  name.split("/").every((segment) => segment && segment !== "." && segment !== "..");

/** Refuses a part of the path that isn't what it must be: a folder on the way, a file small enough at the end. */
function checkPart(info: Stats | undefined, last: boolean, name: string, limit: number, tooLarge: string): void {
  if (!info) refuse(ModelRefusal.Missing, MESSAGE.missing(name));
  else if (info.isSymbolicLink()) refuse(ModelRefusal.Link, MESSAGE.link(name));
  else if (!last && !info.isDirectory()) refuse(ModelRefusal.Missing, MESSAGE.missing(name));
  else if (last && !info.isFile()) refuse(ModelRefusal.NotFile, MESSAGE.notFile(name));
  else if (last && info.size > limit) refuse(ModelRefusal.TooLarge, tooLarge);
}

/**
 * The file `name` names in the game folder, opened: every part on the way lstat'ed (a link refused
 * before anything is opened), the size checked against `limit` before any read.
 */
async function openInFolder(
  folder: string,
  name: string,
  limit: number,
  options: GateOptions,
  tooLarge: string,
): Promise<ModelFile> {
  let at = folder;
  const segments = name.split("/");
  for (const [index, segment] of segments.entries()) {
    at = path.join(at, segment);
    checkPart(await lstat(at).catch(() => undefined), index === segments.length - 1, name, limit, tooLarge);
  }
  // A link swapped in after the lstat makes the no-follow open fail.
  const file = await (options.open ?? openModelFile)(at).catch(() => refuse(ModelRefusal.Link, MESSAGE.link(name)));
  if (file.size > limit) {
    await file.close();
    return refuse(ModelRefusal.TooLarge, tooLarge);
  }
  return file;
}

/** Reads from an opened file, then closes it. */
async function withFile<T>(file: ModelFile, read: (file: ModelFile) => Promise<T>): Promise<T> {
  try {
    return await read(file);
  } finally {
    await file.close();
  }
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const index = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

/** A glTF document, its buffers' bytes, and where its own files are read from. */
interface Model {
  name: string;
  doc: Json;
  buffers: Buffer[];
  folder: string;
  options: GateOptions;
}

function parseJson(name: string, bytes: Buffer): Json {
  let doc: unknown;
  try {
    doc = JSON.parse(bytes.toString("utf8").replace(/[\0\s]+$/, ""));
  } catch {
    return refuse(ModelRefusal.Malformed, MESSAGE.notGltf(name, "its JSON doesn't parse"));
  }
  if (!isObject(doc)) return refuse(ModelRefusal.Malformed, MESSAGE.notGltf(name, "its JSON isn't an object"));
  return doc;
}

/** A GLB's JSON and binary chunk, read stage by stage: nothing past a header that doesn't hold. */
async function readGlb(name: string, file: ModelFile): Promise<{ doc: Json; bin?: Buffer }> {
  const broken = () => refuse(ModelRefusal.Malformed, MESSAGE.notGlb(name));
  const header = (await file.read(0, GLB_HEADER_BYTES)) ?? broken();
  const whole =
    header.toString("latin1", 0, 4) === GLB_MAGIC &&
    header.readUInt32LE(4) === GLB_VERSION &&
    header.readUInt32LE(8) === file.size;
  if (!whole) return broken();
  const chunk = (await file.read(GLB_HEADER_BYTES, CHUNK_HEADER_BYTES)) ?? broken();
  const jsonLength = chunk.readUInt32LE(0);
  const jsonAt = GLB_HEADER_BYTES + CHUNK_HEADER_BYTES;
  const jsonFits = chunk.readUInt32LE(4) === JSON_CHUNK && jsonLength <= MAX_JSON_BYTES;
  if (!jsonFits || jsonAt + jsonLength > file.size) return broken();
  const doc = parseJson(name, (await file.read(jsonAt, jsonLength)) ?? broken());
  const binAt = jsonAt + jsonLength;
  if (binAt + CHUNK_HEADER_BYTES > file.size) return { doc };
  const binHeader = (await file.read(binAt, CHUNK_HEADER_BYTES)) ?? broken();
  const binLength = binHeader.readUInt32LE(0);
  const binFits = binHeader.readUInt32LE(4) === BIN_CHUNK && binAt + CHUNK_HEADER_BYTES + binLength <= file.size;
  if (!binFits) return broken();
  return { doc, bin: (await file.read(binAt + CHUNK_HEADER_BYTES, binLength)) ?? broken() };
}

/** Whether an address's path stays a plain relative one: `..` may lead up, the joined path is checked after. */
const isRelativeUri = (decoded: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them.
  !/[\u0000-\u001f\u007f\\]/.test(decoded) &&
  !path.posix.isAbsolute(decoded) &&
  decoded.split("/").every((segment) => segment && segment !== ".");

/** Where a `.gltf`'s address leads: inline bytes, or a plain path inside the game folder. */
function resolveUri(model: Model, uri: string): { bytes: Buffer } | { file: string } {
  const inline = /^data:[^,]*;base64,(.*)$/s.exec(uri);
  if (inline) return { bytes: Buffer.from(inline[1] ?? "", "base64") };
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri)) return refuse(ModelRefusal.Path, MESSAGE.path(uri));
  let decoded = "";
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    return refuse(ModelRefusal.Path, MESSAGE.path(uri));
  }
  const file = path.posix.normalize(path.posix.join(path.posix.dirname(model.name), decoded));
  if (!isRelativeUri(decoded) || !isPlainRelative(file)) return refuse(ModelRefusal.Path, MESSAGE.path(uri));
  return { file };
}

/** One buffer's bytes: the GLB's binary chunk, inline bytes or a file beside the model. */
async function bufferBytes(model: Model, buffer: Json, first: boolean, bin: Buffer | undefined, room: number) {
  if (typeof buffer.uri !== "string") return first && bin ? bin : Buffer.alloc(0);
  const source = resolveUri(model, buffer.uri);
  if ("bytes" in source) return source.bytes;
  const file = await openInFolder(model.folder, source.file, room, model.options, MESSAGE.tooLarge(model.name));
  return withFile(file, async (opened) => (await opened.read(0, opened.size)) ?? Buffer.alloc(0));
}

/** Each buffer's bytes, all of them together within {@link MAX_MODEL_BYTES}. */
async function readBuffers(model: Model, bin: Buffer | undefined, spent: number): Promise<Buffer[]> {
  const buffers: Buffer[] = [];
  let total = spent;
  for (const [at, raw] of list(model.doc.buffers).entries()) {
    const buffer = isObject(raw) ? raw : {};
    const length = index(buffer.byteLength);
    if (length === undefined) refuse(ModelRefusal.Malformed, MESSAGE.notGltf(model.name, "a buffer has no length"));
    const bytes = await bufferBytes(model, buffer, at === 0, bin, MAX_MODEL_BYTES - total);
    // The GLB's own binary chunk was counted with the file.
    if (bytes !== bin) total += bytes.length;
    if (total > MAX_MODEL_BYTES) refuse(ModelRefusal.TooLarge, MESSAGE.tooLarge(model.name));
    if (bytes.length < (length ?? 0))
      refuse(ModelRefusal.Malformed, MESSAGE.notGltf(model.name, "a buffer is shorter than it says"));
    buffers.push(bytes);
  }
  return buffers;
}

/** The extensions the model needs that the gate can't read through: compression first. */
function checkExtensions(model: Model): void {
  const required = list(model.doc.extensionsRequired).filter((name): name is string => typeof name === "string");
  const compressed = required.find((name) => COMPRESSION_EXTENSIONS.has(name));
  if (compressed) refuse(ModelRefusal.Unsupported, MESSAGE.compressed(model.name, compressed));
  const unknown = required.find((name) => !READABLE_EXTENSION(name));
  if (unknown) refuse(ModelRefusal.Unsupported, MESSAGE.extension(model.name, unknown));
}

/** An accessor's declared shape: its component type, values per item and item count. */
function accessorShape(model: Model, at: unknown, want: number | undefined) {
  const broken = (why: string) => refuse(ModelRefusal.Malformed, MESSAGE.notGltf(model.name, why));
  const accessor = list(model.doc.accessors)[index(at) ?? -1];
  if (!isObject(accessor)) return broken("a mesh names an accessor it doesn't have");
  if (accessor.sparse !== undefined)
    return refuse(ModelRefusal.Unsupported, MESSAGE.extension(model.name, "sparse accessors"));
  const type = accessor.componentType as ComponentType;
  const component = COMPONENT[type];
  const size = SIZES[accessor.type as keyof typeof SIZES];
  const count = index(accessor.count) ?? -1;
  const shaped = component && size && count >= 0 && count <= MAX_ACCESSOR_COUNT;
  if (!shaped || (want !== undefined && size !== want)) return broken("an accessor's shape isn't one glTF has");
  return { accessor, type, component, size, count };
}

/** Where an accessor's items lie: its buffer, the first item's offset and the stride; undefined with no view. */
function accessorSpan(model: Model, shape: ReturnType<typeof accessorShape>) {
  const { accessor, component, size, count } = shape;
  if (accessor.bufferView === undefined) return undefined;
  const broken = (why: string) => refuse(ModelRefusal.Malformed, MESSAGE.notGltf(model.name, why));
  const view = list(model.doc.bufferViews)[index(accessor.bufferView) ?? -1];
  const buffer = isObject(view) ? model.buffers[index(view.buffer) ?? -1] : undefined;
  if (!isObject(view) || !buffer) return broken("an accessor names a buffer view it doesn't have");
  const element = component.bytes * size;
  const stride = index(view.byteStride) || element;
  const viewStart = index(view.byteOffset) ?? 0;
  const start = viewStart + (index(accessor.byteOffset) ?? 0);
  const viewEnd = viewStart + (index(view.byteLength) ?? 0);
  const end = count === 0 ? start : start + stride * (count - 1) + element;
  if (stride < element || end > viewEnd || viewEnd > buffer.length)
    return broken("an accessor reaches past its buffer");
  return { buffer, start, stride };
}

/** Reads an accessor's items one at a time, normalized integers scaled to 0–1 (or −1–1), as glTF reads them. */
interface AccessorReader {
  count: number;
  size: number;
  /** Item `item`'s values into `into` from `offset` (zeros for an accessor with no buffer view). */
  read(item: number, into: Float64Array, offset: number): void;
}

function accessorReader(model: Model, at: unknown, want?: number): AccessorReader {
  const shape = accessorShape(model, at, want);
  const { accessor, type, component, size, count } = shape;
  const span = accessorSpan(model, shape);
  const normalized = accessor.normalized === true;
  const scale = normalized ? component.max : 1;
  const read = (item: number, into: Float64Array, offset: number) => {
    if (!span) return;
    for (let part = 0; part < size; part++) {
      const value = readComponent(span.buffer, span.start + item * span.stride + part * component.bytes, type) / scale;
      into[offset + part] = normalized ? Math.max(value, -1) : value;
    }
  };
  return { count, size, read };
}

/** One accessor's values, normalized integers scaled to 0–1 (or −1–1), as glTF reads them. */
function accessorValues(model: Model, at: unknown, want?: number): Float64Array {
  const reader = accessorReader(model, at, want);
  const values = new Float64Array(reader.count * reader.size);
  for (let item = 0; item < reader.count; item++) reader.read(item, values, item * reader.size);
  return values;
}

/** A vertex attribute's reader, refused when it has fewer items than the primitive's `vertices`. */
function attributeReader(model: Model, at: unknown, want: number, vertices: number): AccessorReader {
  const reader = accessorReader(model, at, want);
  if (reader.count < vertices)
    refuse(
      ModelRefusal.Malformed,
      MESSAGE.notGltf(model.name, "a mesh's attribute has fewer values than its vertices"),
    );
  return reader;
}

/** The items of `reader` at `items`, in that order: only what a primitive's triangles use is read. */
function itemsAt(reader: AccessorReader, items: readonly number[]): Float64Array {
  const values = new Float64Array(items.length * reader.size);
  items.forEach((item, at) => reader.read(item, values, at * reader.size));
  return values;
}

function readComponent(buffer: Buffer, offset: number, type: ComponentType): number {
  if (type === 5126) return buffer.readFloatLE(offset);
  if (type === 5125) return buffer.readUInt32LE(offset);
  if (type === 5123) return buffer.readUInt16LE(offset);
  if (type === 5122) return buffer.readInt16LE(offset);
  if (type === 5121) return buffer.readUInt8(offset);
  return buffer.readInt8(offset);
}

type Matrix = number[];
const IDENTITY: Matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a: Matrix, b: Matrix): Matrix {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++)
        out[column * 4 + row] = (out[column * 4 + row] ?? 0) + (a[k * 4 + row] ?? 0) * (b[column * 4 + k] ?? 0);
  return out;
}

const numbers = (value: unknown, length: number): number[] | undefined =>
  Array.isArray(value) &&
  value.length === length &&
  value.every((one) => typeof one === "number" && Number.isFinite(one))
    ? (value as number[])
    : undefined;

/** A node's own transform: its matrix, or translation × rotation × scale. */
function localMatrix(node: Json): Matrix {
  const matrix = numbers(node.matrix, 16);
  if (matrix) return matrix;
  const t = numbers(node.translation, 3) ?? [0, 0, 0];
  const r = numbers(node.rotation, 4) ?? [0, 0, 0, 1];
  const s = numbers(node.scale, 3) ?? [1, 1, 1];
  const [x, y, z, w] = [r[0] ?? 0, r[1] ?? 0, r[2] ?? 0, r[3] ?? 1];
  const [sx, sy, sz] = [s[0] ?? 1, s[1] ?? 1, s[2] ?? 1];
  // biome-ignore format: a matrix reads best four values to a column.
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    t[0] ?? 0, t[1] ?? 0, t[2] ?? 0, 1,
  ];
}

/** The scene's root nodes: the default scene's, or every node no other node holds. */
function sceneRoots(doc: Json): number[] {
  const scenes = list(doc.scenes);
  const scene = scenes[index(doc.scene) ?? 0];
  if (isObject(scene))
    return list(scene.nodes).flatMap((node) => (index(node) === undefined ? [] : [index(node) as number]));
  const held = new Set(list(doc.nodes).flatMap((node) => (isObject(node) ? list(node.children) : [])));
  return list(doc.nodes).flatMap((_, at) => (held.has(at) ? [] : [at]));
}

/** Each node that draws a mesh, with its world transform; a node reached twice is refused. */
function meshNodes(model: Model): Array<{ mesh: Json; world: Matrix }> {
  const nodes = list(model.doc.nodes);
  const found: Array<{ mesh: Json; world: Matrix }> = [];
  const seen = new Set<number>();
  const stack = sceneRoots(model.doc).map((at) => ({ at, parent: IDENTITY }));
  while (stack.length > 0) {
    const { at, parent } = stack.pop() as { at: number; parent: Matrix };
    const node = nodes[at];
    if (!isObject(node) || seen.has(at))
      return refuse(ModelRefusal.Malformed, MESSAGE.notGltf(model.name, "its nodes don't form a tree"));
    seen.add(at);
    const world = multiply(parent, localMatrix(node));
    const mesh = list(model.doc.meshes)[index(node.mesh) ?? -1];
    if (isObject(mesh)) found.push({ mesh, world });
    for (const child of list(node.children)) stack.push({ at: index(child) ?? -1, parent: world });
  }
  return found;
}

/** The roots that don't sit at the origin, with where they are. */
function rootsOffOrigin(doc: Json): ModelFinding[] {
  const nodes = list(doc.nodes);
  return sceneRoots(doc).flatMap((at) => {
    const node = nodes[at];
    if (!isObject(node)) return [];
    const matrix = localMatrix(node);
    const offset = [matrix[12] ?? 0, matrix[13] ?? 0, matrix[14] ?? 0];
    if (Math.hypot(...offset) <= ORIGIN_TOLERANCE) return [];
    const name = typeof node.name === "string" && node.name ? node.name : `node ${at}`;
    return [{ problem: ModelProblem.Origin, message: MESSAGE.origin(name, offset) }];
  });
}

/** One primitive's vertex count, triangle indexes and attributes' accessors, its mode checked. */
function primitiveShape(model: Model, raw: unknown) {
  const primitive = isObject(raw) ? raw : {};
  if ((primitive.mode ?? TRIANGLES) !== TRIANGLES) refuse(ModelRefusal.Unsupported, MESSAGE.notTriangles(model.name));
  const attributes = isObject(primitive.attributes) ? primitive.attributes : {};
  if (attributes.POSITION === undefined)
    refuse(ModelRefusal.Malformed, MESSAGE.notGltf(model.name, "a mesh has no positions"));
  return { primitive, attributes };
}

/** The triangle count of every drawn primitive, read from the accessors' counts alone. */
function countTriangles(model: Model, drawn: Array<{ mesh: Json }>): number {
  let triangles = 0;
  for (const { mesh } of drawn)
    for (const raw of list(mesh.primitives)) {
      const { primitive, attributes } = primitiveShape(model, raw);
      const counted = primitive.indices ?? attributes.POSITION;
      const accessor = list(model.doc.accessors)[index(counted) ?? -1];
      const count = isObject(accessor) ? (index(accessor.count) ?? 0) : 0;
      if (count % 3 !== 0)
        refuse(ModelRefusal.Malformed, MESSAGE.notGltf(model.name, "a mesh's triangles don't come in threes"));
      triangles += count / 3;
    }
  return triangles;
}

/** How many of the vertices `used` more than {@link MAX_BONE_INFLUENCES} bones move. */
function overInfluenced(model: Model, attributes: Json, used: readonly number[], vertices: number): number {
  const sets = Object.keys(attributes).filter((name) => /^WEIGHTS_\d+$/.test(name));
  if (sets.length <= 1) return 0;
  const counts = new Uint8Array(used.length);
  for (const set of sets) {
    const weights = itemsAt(attributeReader(model, attributes[set], 4, vertices), used);
    weights.forEach((weight, at) => {
      if (weight > 0) counts[Math.floor(at / 4)] = (counts[Math.floor(at / 4)] ?? 0) + 1;
    });
  }
  return counts.filter((count) => count > MAX_BONE_INFLUENCES).length;
}

const item = (values: ArrayLike<number>, at: number) => values[at] ?? 0;

/** Applies a world transform to points (w = 1) or to normals (by the inverse transpose, renormalized). */
function transformed(values: Float64Array, world: Matrix, normals: boolean): Float64Array {
  const m = normals ? normalMatrix(world) : world;
  const w = normals ? 0 : 1;
  const out = new Float64Array(values.length);
  for (let at = 0; at < values.length; at += 3) {
    const [x, y, z] = [item(values, at), item(values, at + 1), item(values, at + 2)];
    for (let axis = 0; axis < 3; axis++)
      out[at + axis] = item(m, axis) * x + item(m, 4 + axis) * y + item(m, 8 + axis) * z + item(m, 12 + axis) * w;
  }
  return normals ? unitVectors(out) : out;
}

/** Each three values scaled to length 1 (a zero vector left as it is). */
function unitVectors(values: Float64Array): Float64Array {
  for (let at = 0; at < values.length; at += 3) {
    const length = Math.hypot(item(values, at), item(values, at + 1), item(values, at + 2)) || 1;
    for (let axis = 0; axis < 3; axis++) values[at + axis] = item(values, at + axis) / length;
  }
  return values;
}

/** The cofactor matrix of the upper 3 × 3: the inverse transpose up to scale, which renormalizing drops. */
function normalMatrix(m: Matrix): Matrix {
  const v = (at: number) => m[at] ?? 0;
  const [a, b, c, d, e, f, g, h, i] = [v(0), v(1), v(2), v(4), v(5), v(6), v(8), v(9), v(10)];
  // biome-ignore format: a matrix reads best four values to a column.
  return [
    e * i - f * h, f * g - d * i, d * h - e * g, 0,
    c * h - b * i, a * i - c * g, b * g - a * h, 0,
    b * f - c * e, c * d - a * f, a * e - b * d, 0,
    0, 0, 0, 1,
  ];
}

/** The drawn triangles as they are gathered, in world space. */
interface Gathered {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  materials: Set<number>;
  influenced: number;
  allNormals: boolean;
  allUvs: boolean;
}

const append = (to: number[], values: ArrayLike<number>) => {
  for (let at = 0; at < values.length; at++) to.push(values[at] ?? 0);
};

/**
 * The vertices a primitive's triangles use, in first-use order, and each corner's place among
 * them: a vertex buffer the primitives share is read for what each draws, never whole.
 */
function usedVertices(model: Model, primitive: Json, vertices: number) {
  const order =
    primitive.indices === undefined
      ? Float64Array.from({ length: vertices }, (_, at) => at)
      : accessorValues(model, primitive.indices, 1);
  if (order.some((at) => at >= vertices))
    refuse(ModelRefusal.Malformed, MESSAGE.notGltf(model.name, "a triangle names a vertex the mesh doesn't have"));
  const places = new Map<number, number>();
  const corners = Array.from(order, (vertex) => {
    const known = places.get(vertex);
    if (known !== undefined) return known;
    places.set(vertex, places.size);
    return places.size - 1;
  });
  return { used: [...places.keys()], corners };
}

/** Adds one primitive drawn at `world`. */
function addPrimitive(model: Model, into: Gathered, raw: unknown, world: Matrix): void {
  const { primitive, attributes } = primitiveShape(model, raw);
  const position = accessorReader(model, attributes.POSITION, 3);
  const { used, corners } = usedVertices(model, primitive, position.count);
  const base = into.positions.length / 3;
  into.materials.add(index(primitive.material) ?? -1);
  into.influenced += overInfluenced(model, attributes, used, position.count);
  append(into.positions, transformed(itemsAt(position, used), world, false));
  into.allNormals &&= attributes.NORMAL !== undefined;
  into.allUvs &&= attributes.TEXCOORD_0 !== undefined;
  if (attributes.NORMAL !== undefined)
    append(
      into.normals,
      transformed(itemsAt(attributeReader(model, attributes.NORMAL, 3, position.count), used), world, true),
    );
  if (attributes.TEXCOORD_0 !== undefined)
    append(into.uvs, itemsAt(attributeReader(model, attributes.TEXCOORD_0, 2, position.count), used));
  for (const at of corners) into.indices.push(base + at);
}

/** The drawn triangles gathered into one mesh in world space, materials and influences counted on the way. */
function gather(model: Model, drawn: Array<{ mesh: Json; world: Matrix }>) {
  const into: Gathered = {
    positions: [],
    normals: [],
    uvs: [],
    indices: [],
    materials: new Set(),
    influenced: 0,
    allNormals: true,
    allUvs: true,
  };
  for (const { mesh, world } of drawn) for (const raw of list(mesh.primitives)) addPrimitive(model, into, raw, world);
  const mesh: CheckedMesh = { positions: Float32Array.from(into.positions), indices: Uint32Array.from(into.indices) };
  if (into.allNormals) mesh.normals = Float32Array.from(into.normals);
  if (into.allUvs) mesh.uvs = Float32Array.from(into.uvs);
  return { mesh, materials: into.materials.size, influenced: into.influenced };
}

/** A welder: each vertex's index among the distinct places its positions sit at. */
function welder(positions: Float32Array): (vertex: number) => number {
  const welded = new Map<string, number>();
  return (vertex) => {
    const key = [0, 1, 2].map((axis) => Math.round(item(positions, vertex * 3 + axis) / WELD_STEP)).join(",");
    const known = welded.get(key);
    if (known !== undefined) return known;
    welded.set(key, welded.size);
    return welded.size - 1;
  };
}

/** How many triangles share each edge, by welded corners; a triangle that collapses to a line or point is left out. */
function edgeUses(mesh: CheckedMesh): Map<number, number> {
  const weld = welder(mesh.positions);
  const span = mesh.positions.length / 3 + 1;
  const edges = new Map<number, number>();
  for (let at = 0; at < mesh.indices.length; at += 3) {
    const corners = [0, 1, 2].map((corner) => weld(item(mesh.indices, at + corner)));
    if (new Set(corners).size < 3) continue;
    corners.forEach((a, side) => {
      const b = item(corners, (side + 1) % 3);
      const key = Math.min(a, b) * span + Math.max(a, b);
      edges.set(key, (edges.get(key) ?? 0) + 1);
    });
  }
  return edges;
}

/** Edges that border a hole (one triangle) and edges shared by more than two, once same-place vertices are welded. */
export function openEdges(mesh: CheckedMesh): { open: number; crowded: number } {
  const uses = [...edgeUses(mesh).values()];
  return { open: uses.filter((count) => count === 1).length, crowded: uses.filter((count) => count > 2).length };
}

/** The extent of the positions along each axis. */
function extent(positions: Float32Array): [number, number, number] {
  const size: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (let at = axis; at < positions.length; at += 3) {
      low = Math.min(low, positions[at] ?? 0);
      high = Math.max(high, positions[at] ?? 0);
    }
    size[axis] = positions.length ? high - low : 0;
  }
  return size;
}

/** The size of one picture the model uses: from a buffer view, inline bytes or a file beside it. */
async function pictureSize(model: Model, image: Json) {
  if (image.bufferView !== undefined) {
    const view = list(model.doc.bufferViews)[index(image.bufferView) ?? -1];
    const buffer = isObject(view) ? model.buffers[index(view.buffer) ?? -1] : undefined;
    if (!isObject(view) || !buffer) return undefined;
    const start = index(view.byteOffset) ?? 0;
    return imageSize(bytesSource(buffer.subarray(start, start + (index(view.byteLength) ?? 0))));
  }
  if (typeof image.uri !== "string") return undefined;
  const source = resolveUri(model, image.uri);
  if ("bytes" in source) return imageSize(bytesSource(source.bytes));
  const file = await openInFolder(
    model.folder,
    source.file,
    MAX_MODEL_BYTES,
    model.options,
    MESSAGE.tooLarge(model.name),
  );
  return withFile(file, imageSize);
}

/** Each picture's size, and the findings for those too large or unreadable. */
async function checkTextures(model: Model, side: number) {
  const textures: TextureSize[] = [];
  const problems: ModelFinding[] = [];
  for (const [at, raw] of list(model.doc.images).entries()) {
    const image = isObject(raw) ? raw : {};
    const uriName =
      typeof image.uri === "string" && !image.uri.startsWith("data:") ? path.posix.basename(image.uri) : "";
    const name = typeof image.name === "string" && image.name ? image.name : uriName || `image ${at}`;
    const size = await pictureSize(model, image);
    if (!size) {
      problems.push({ problem: ModelProblem.Texture, message: MESSAGE.textureFormat(name) });
      continue;
    }
    textures.push({ name, format: size.format, width: size.width, height: size.height });
    if (size.width > side || size.height > side)
      problems.push({
        problem: ModelProblem.Texture,
        message: MESSAGE.textureSize(name, size.width, size.height, side),
      });
  }
  return { textures, problems };
}

/** The checks over a model read whole. */
async function checkRead(model: Model, side: number): Promise<ModelCheck> {
  checkExtensions(model);
  const drawn = meshNodes(model);
  const triangles = countTriangles(model, drawn);
  if (triangles === 0) refuse(ModelRefusal.Unsupported, MESSAGE.noTriangles(model.name));
  const problems: ModelFinding[] = [];
  if (triangles > MAX_MODEL_TRIANGLES)
    problems.push({ problem: ModelProblem.Triangles, message: MESSAGE.triangles(triangles) });
  const built = triangles <= MAX_BUILT_TRIANGLES ? gather(model, drawn) : undefined;
  if (built) {
    const { open, crowded } = openEdges(built.mesh);
    if (open || crowded) problems.push({ problem: ModelProblem.Watertight, message: MESSAGE.open(open, crowded) });
    if (built.materials > 1)
      problems.push({ problem: ModelProblem.Materials, message: MESSAGE.materials(built.materials) });
    if (built.influenced)
      problems.push({ problem: ModelProblem.Influences, message: MESSAGE.influences(built.influenced) });
  }
  problems.push(...rootsOffOrigin(model.doc));
  const textures = await checkTextures(model, side);
  problems.push(...textures.problems);
  return {
    file: model.name,
    passed: problems.length === 0,
    triangles,
    materials: built?.materials ?? 0,
    textures: textures.textures,
    problems,
    ...(built ? { mesh: built.mesh, size: extent(built.mesh.positions) } : {}),
  };
}

/** Reads the model file `name` names in `folder`, refusing what can't be checked. */
async function readModel(folder: string, name: string, options: GateOptions): Promise<Model> {
  if (!isPlainRelative(name)) return refuse(ModelRefusal.Path, MESSAGE.path(name));
  const ext = path.posix.extname(name).toLowerCase();
  if (ext === ".fbx") return refuse(ModelRefusal.Fbx, MESSAGE.fbx(name));
  if (ext !== ".glb" && ext !== ".gltf") return refuse(ModelRefusal.Format, MESSAGE.format(name));
  const binary = ext === ".glb";
  const limit = binary ? MAX_MODEL_BYTES : MAX_JSON_BYTES;
  const file = await openInFolder(
    folder,
    name,
    limit,
    options,
    binary ? MESSAGE.tooLarge(name) : MESSAGE.jsonTooLarge(name),
  );
  const read = await withFile(file, async (opened) => {
    if (binary) return readGlb(name, opened);
    const text =
      (await opened.read(0, opened.size)) ?? refuse(ModelRefusal.Malformed, MESSAGE.notGltf(name, "it ends early"));
    return { doc: parseJson(name, text), bin: undefined, size: opened.size };
  });
  const model: Model = { name, doc: read.doc, buffers: [], folder, options };
  model.buffers = await readBuffers(model, read.bin, file.size);
  return model;
}

/**
 * Checks the `.glb` or `.gltf` at `name` in the game folder: what it fails on, or why it can't be
 * checked. `textureSide` may only lower {@link MAX_TEXTURE_SIDE}.
 */
export async function checkModel(folder: string, name: string, options: GateOptions = {}): Promise<GateAnswer> {
  const side = Math.min(MAX_TEXTURE_SIDE, options.textureSide ?? MAX_TEXTURE_SIDE);
  try {
    return { ok: true, check: await checkRead(await readModel(folder, name, options), side) };
  } catch (error) {
    if (error instanceof GateRefusal) return { ok: false, refusal: error.refusal, message: error.message };
    throw error;
  }
}
