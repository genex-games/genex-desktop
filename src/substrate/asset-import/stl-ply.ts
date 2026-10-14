/**
 * STL (binary and ASCII) and PLY (ASCII, binary little- and big-endian) to the plain mesh model.
 * Both formats are Z-up by convention (Blender, slicers and scanners write them so); glTF is Y-up,
 * so every position and normal is turned (x, y, z) → (x, z, −y). STL keeps one normal per facet;
 * PLY keeps the normals, texture coordinates and colours its vertices carry.
 */
import type { MeshDocument } from "./glb.ts";
import { finite, MeshFormatError } from "./obj.ts";

const STL_HEADER_BYTES = 80;
const STL_FACET_BYTES = 50;
const PLY_HEADER_MAX_BYTES = 64 * 1024;

/** Z-up to Y-up, in place, over xyz triples. */
function zUpToYUp(values: number[]): number[] {
  for (let i = 0; i + 2 < values.length; i += 3) {
    const y = values[i + 1] ?? 0;
    values[i + 1] = values[i + 2] ?? 0;
    values[i + 2] = -y;
  }
  return values;
}

/** The unit normal of a triangle, or +Z (before the turn) for a degenerate one. */
function faceNormal(p: readonly number[]): [number, number, number] {
  const [ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0, cx = 0, cy = 0, cz = 0] = p;
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx] as const;
  const length = Math.hypot(...n);
  return length > 0 ? [n[0] / length, n[1] / length, n[2] / length] : [0, 0, 1];
}

/** A facet's normal as stored, or computed when it is zero or not unit-ish. */
function facetNormal(stored: readonly number[], corners: readonly number[]): [number, number, number] {
  const length = Math.hypot(...stored);
  if (length > 0.5) return [(stored[0] ?? 0) / length, (stored[1] ?? 0) / length, (stored[2] ?? 0) / length];
  return faceNormal(corners);
}

/** Whether `bytes` are a binary STL: its facet count matches its length exactly. */
function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.byteLength < STL_HEADER_BYTES + 4) return false;
  const count = new DataView(bytes.buffer, bytes.byteOffset).getUint32(STL_HEADER_BYTES, true);
  return STL_HEADER_BYTES + 4 + count * STL_FACET_BYTES === bytes.byteLength;
}

/** Facets as flat corner positions and stored normals. */
function stlFacets(bytes: Uint8Array): { corners: number[]; normals: number[] } {
  if (isBinaryStl(bytes)) {
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = data.getUint32(STL_HEADER_BYTES, true);
    const corners: number[] = [];
    const normals: number[] = [];
    for (let f = 0; f < count; f++) {
      const at = STL_HEADER_BYTES + 4 + f * STL_FACET_BYTES;
      for (let i = 0; i < 3; i++) normals.push(data.getFloat32(at + i * 4, true));
      for (let i = 0; i < 9; i++) corners.push(data.getFloat32(at + 12 + i * 4, true));
    }
    return { corners, normals };
  }
  return asciiStlFacets(new TextDecoder().decode(bytes));
}

function asciiStlFacets(text: string): { corners: number[]; normals: number[] } {
  if (!/^\s*solid\b/.test(text)) throw new MeshFormatError("not an STL");
  const corners: number[] = [];
  const normals: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const words = line.trim().split(/\s+/);
    if (words[0] === "facet" && words[1] === "normal")
      normals.push(...words.slice(2, 5).map((w) => finite(w, "normal")));
    else if (words[0] === "vertex") corners.push(...words.slice(1, 4).map((w) => finite(w, "vertex")));
  }
  if (corners.length !== normals.length * 3) throw new MeshFormatError("facets and vertices disagree");
  return { corners, normals };
}

/** An STL as a mesh: three vertices per facet, each with the facet's normal. */
export function stlToMesh(bytes: Uint8Array, name: string): MeshDocument {
  const { corners, normals } = stlFacets(bytes);
  const facets = corners.length / 9;
  if (!facets) throw new MeshFormatError("no facets");
  const vertexNormals: number[] = [];
  for (let f = 0; f < facets; f++) {
    const n = facetNormal(normals.slice(f * 3, f * 3 + 3), corners.slice(f * 9, f * 9 + 9));
    vertexNormals.push(...n, ...n, ...n);
  }
  const indices = Uint32Array.from({ length: facets * 3 }, (_, i) => i);
  const primitive = {
    positions: Float32Array.from(zUpToYUp(corners)),
    normals: Float32Array.from(zUpToYUp(vertexNormals)),
    indices,
  };
  return { name, primitives: [primitive], materials: [] };
}

// ---------- PLY ----------

type PlyFormat = "ascii" | "binary_little_endian" | "binary_big_endian";

interface PlyProperty {
  name: string;
  type: string;
  /** The count type of a list property. */
  countType?: string;
}

interface PlyElement {
  name: string;
  count: number;
  properties: PlyProperty[];
}

/** Byte size and DataView reader of each PLY scalar type. */
const PLY_TYPES: Readonly<Record<string, { size: number; read: (d: DataView, at: number, le: boolean) => number }>> = {
  char: { size: 1, read: (d, at) => d.getInt8(at) },
  int8: { size: 1, read: (d, at) => d.getInt8(at) },
  uchar: { size: 1, read: (d, at) => d.getUint8(at) },
  uint8: { size: 1, read: (d, at) => d.getUint8(at) },
  short: { size: 2, read: (d, at, le) => d.getInt16(at, le) },
  int16: { size: 2, read: (d, at, le) => d.getInt16(at, le) },
  ushort: { size: 2, read: (d, at, le) => d.getUint16(at, le) },
  uint16: { size: 2, read: (d, at, le) => d.getUint16(at, le) },
  int: { size: 4, read: (d, at, le) => d.getInt32(at, le) },
  int32: { size: 4, read: (d, at, le) => d.getInt32(at, le) },
  uint: { size: 4, read: (d, at, le) => d.getUint32(at, le) },
  uint32: { size: 4, read: (d, at, le) => d.getUint32(at, le) },
  float: { size: 4, read: (d, at, le) => d.getFloat32(at, le) },
  float32: { size: 4, read: (d, at, le) => d.getFloat32(at, le) },
  double: { size: 8, read: (d, at, le) => d.getFloat64(at, le) },
  float64: { size: 8, read: (d, at, le) => d.getFloat64(at, le) },
};

const isPlyType = (type: string | undefined): type is string => type !== undefined && Object.hasOwn(PLY_TYPES, type);

/** The header's format and elements, and where the body starts. */
function plyHeader(bytes: Uint8Array): { format: PlyFormat; elements: PlyElement[]; body: number } {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.byteLength, PLY_HEADER_MAX_BYTES)));
  const end = head.search(/end_header\r?\n/);
  if (!head.startsWith("ply") || end < 0) throw new MeshFormatError("not a PLY");
  const body = end + (head.slice(end).match(/end_header\r?\n/)?.[0].length ?? 0);
  let format: PlyFormat | null = null;
  const elements: PlyElement[] = [];
  for (const line of head.slice(0, end).split(/\r?\n/)) {
    const words = line.trim().split(/\s+/);
    if (words[0] === "format") format = plyFormat(words[1]);
    else if (words[0] === "element") elements.push({ name: words[1] ?? "", count: plyCount(words[2]), properties: [] });
    else if (words[0] === "property") elements.at(-1)?.properties.push(plyProperty(words));
  }
  if (!format) throw new MeshFormatError("PLY without a format");
  return { format, elements, body };
}

function plyFormat(word: string | undefined): PlyFormat {
  if (word === "ascii" || word === "binary_little_endian" || word === "binary_big_endian") return word;
  throw new MeshFormatError("unknown PLY format");
}

function plyCount(word: string | undefined): number {
  const count = finite(word, "element count");
  if (!Number.isSafeInteger(count) || count < 0) throw new MeshFormatError("bad element count");
  return count;
}

function plyProperty(words: string[]): PlyProperty {
  if (words[1] === "list") {
    if (!isPlyType(words[2]) || !isPlyType(words[3])) throw new MeshFormatError("bad list property");
    return { name: words[4] ?? "", type: words[3], countType: words[2] };
  }
  if (!isPlyType(words[1])) throw new MeshFormatError("bad property type");
  return { name: words[2] ?? "", type: words[1] };
}

/** A reader of the body's values, one scalar at a time, in either encoding. */
function plyReader(bytes: Uint8Array, format: PlyFormat, body: number): (type: string) => number {
  if (format === "ascii") {
    const words = new TextDecoder("latin1").decode(bytes.subarray(body)).split(/\s+/).filter(Boolean);
    let next = 0;
    return () => finite(words[next++], "value");
  }
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = format === "binary_little_endian";
  let at = body;
  return (type) => {
    const reader = PLY_TYPES[type];
    if (!reader || at + reader.size > bytes.byteLength) throw new MeshFormatError("truncated PLY");
    const value = reader.read(data, at, le);
    at += reader.size;
    return value;
  };
}

/** Vertex attributes PLY names in several spellings. */
const UV_NAMES = [
  ["s", "t"],
  ["u", "v"],
  ["texture_u", "texture_v"],
  ["texture_s", "texture_t"],
] as const;
const COLOR_NAMES = ["red", "green", "blue"] as const;

/** The value of each named property of one row, lists as arrays. */
function readRow(element: PlyElement, read: (type: string) => number): Map<string, number | number[]> {
  const row = new Map<string, number | number[]>();
  for (const property of element.properties) {
    if (property.countType === undefined) {
      row.set(property.name, read(property.type));
      continue;
    }
    const count = read(property.countType);
    if (!Number.isSafeInteger(count) || count < 0) throw new MeshFormatError("bad list length");
    row.set(
      property.name,
      Array.from({ length: count }, () => read(property.type)),
    );
  }
  return row;
}

/** A PLY as a mesh: its vertices, fanned faces, and the normals, uvs and colours it carries. */
export function plyToMesh(bytes: Uint8Array, name: string): MeshDocument {
  const { format, elements, body } = plyHeader(bytes);
  const read = plyReader(bytes, format, body);
  const vertex = { positions: [] as number[], normals: [] as number[], uvs: [] as number[], colors: [] as number[] };
  const indices: number[] = [];
  let vertexElement: PlyElement | null = null;
  for (const element of elements) {
    if (element.name === "vertex") vertexElement = element;
    for (let i = 0; i < element.count; i++) {
      const row = readRow(element, read);
      if (element.name === "vertex") pushVertex(vertex, row, element);
      else if (element.name === "face") pushFace(indices, row, vertex.positions.length / 3);
    }
  }
  if (!vertexElement || !indices.length) throw new MeshFormatError("no faces");
  return { name, primitives: [plyPrimitive(vertex, vertexElement, indices)], materials: [] };
}

function plyPrimitive(
  vertex: { positions: number[]; normals: number[]; uvs: number[]; colors: number[] },
  element: PlyElement,
  indices: number[],
) {
  const has = (names: readonly string[]) => names.every((n) => element.properties.some((p) => p.name === n));
  return {
    positions: Float32Array.from(zUpToYUp(vertex.positions)),
    ...(has(["nx", "ny", "nz"]) ? { normals: Float32Array.from(zUpToYUp(vertex.normals)) } : {}),
    ...(vertex.uvs.length ? { uvs: Float32Array.from(vertex.uvs) } : {}),
    ...(has(COLOR_NAMES) ? { colors: Float32Array.from(vertex.colors) } : {}),
    indices: Uint32Array.from(indices),
  };
}

const scalar = (row: Map<string, number | number[]>, key: string): number => {
  const value = row.get(key);
  return typeof value === "number" ? value : 0;
};

function pushVertex(
  vertex: { positions: number[]; normals: number[]; uvs: number[]; colors: number[] },
  row: Map<string, number | number[]>,
  element: PlyElement,
): void {
  vertex.positions.push(scalar(row, "x"), scalar(row, "y"), scalar(row, "z"));
  vertex.normals.push(scalar(row, "nx"), scalar(row, "ny"), scalar(row, "nz"));
  const uv = UV_NAMES.find(([u, v]) => row.has(u) && row.has(v));
  if (uv) vertex.uvs.push(scalar(row, uv[0]), 1 - scalar(row, uv[1]));
  const integer = element.properties.find((p) => p.name === "red")?.type.includes("char") ?? false;
  for (const channel of COLOR_NAMES) vertex.colors.push(integer ? scalar(row, channel) / 255 : scalar(row, channel));
}

function pushFace(indices: number[], row: Map<string, number | number[]>, vertices: number): void {
  const list = row.get("vertex_indices") ?? row.get("vertex_index");
  if (!Array.isArray(list) || list.length < 3) throw new MeshFormatError("face without three vertices");
  if (list.some((index) => !Number.isInteger(index) || index < 0 || index >= vertices)) {
    throw new MeshFormatError("face index out of range");
  }
  for (let i = 1; i + 1 < list.length; i++) indices.push(list[0] ?? 0, list[i] ?? 0, list[i + 1] ?? 0);
}
