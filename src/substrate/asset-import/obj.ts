/**
 * Wavefront OBJ (with its MTL) to the plain mesh model: one primitive per material, in first-use
 * order, vertices shared within a primitive by their position/uv/normal triple, polygons fanned
 * into triangles, texture coordinates flipped to glTF's top-left origin. OBJ is Y-up, as glTF is.
 */
import { isSafeAssetPath } from "./safe-asset.ts";
import type { MeshDocument, MeshMaterial, MeshPrimitive } from "./glb.ts";

/** Why a model file could not be converted: damaged, or not the format its name says. */
export class MeshFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeshFormatError";
  }
}

/** A finite number from `token`, or a {@link MeshFormatError}. */
export function finite(token: string | undefined, what: string): number {
  const value = Number(token);
  if (token === undefined || token === "" || !Number.isFinite(value)) throw new MeshFormatError(`bad ${what}`);
  return value;
}

/** The MTL's materials by name: base colour, alpha and diffuse texture. */
export function parseMtl(text: string, mtlDir: string): Map<string, MeshMaterial> {
  const materials = new Map<string, MeshMaterial>();
  let current: { name: string; color: [number, number, number, number]; texture?: string } | null = null;
  const commit = () => {
    if (current) materials.set(current.name, { name: current.name, baseColor: current.color, ...texture(current) });
  };
  for (const line of text.split(/\r?\n/)) {
    const [keyword, ...rest] = line.trim().split(/\s+/);
    if (keyword === "newmtl") {
      commit();
      current = { name: rest.join(" "), color: [1, 1, 1, 1] };
    } else if (current) {
      applyMtlLine(current, keyword ?? "", rest, mtlDir);
    }
  }
  commit();
  return materials;
}

const texture = (material: { texture?: string }) => (material.texture ? { texture: material.texture } : {});

function applyMtlLine(
  material: { color: [number, number, number, number]; texture?: string },
  keyword: string,
  rest: string[],
  mtlDir: string,
): void {
  if (keyword === "Kd") {
    material.color = [finite(rest[0], "Kd"), finite(rest[1], "Kd"), finite(rest[2], "Kd"), material.color[3]];
  } else if (keyword === "d") {
    material.color[3] = finite(rest[0], "d");
  } else if (keyword === "Tr") {
    material.color[3] = 1 - finite(rest[0], "Tr");
  } else if (keyword === "map_Kd") {
    const uri = textureUri(mtlDir, rest.at(-1) ?? "");
    if (uri) material.texture = uri;
  }
}

/**
 * A texture the MTL names, as a relative URI beside the model: only a name that passes the
 * asset-path rule once joined to the MTL's folder; anything else is dropped (the runtime shows its
 * missing-texture checker instead of reading outside the game).
 */
function textureUri(mtlDir: string, name: string): string | null {
  const joined = [mtlDir, name.replaceAll("\\", "/")].filter(Boolean).join("/");
  if (!isSafeAssetPath(joined)) return null;
  return joined.split("/").map(encodeURIComponent).join("/");
}

/** One primitive being built: its own vertices, shared by triple. */
interface Building {
  material: string | null;
  keys: Map<string, number>;
  positions: number[];
  uvs: number[];
  normals: number[];
  hasUv: boolean;
  allNormals: boolean;
  indices: number[];
}

/** The parsed OBJ tables a face indexes into. */
interface ObjTables {
  v: number[];
  vt: number[];
  vn: number[];
}

/** A 1-based (or negative, counted from the end) OBJ index as a 0-based one, checked. */
function resolveIndex(token: string | undefined, length: number): number | null {
  if (token === undefined || token === "") return null;
  const index = finite(token, "index");
  const resolved = index < 0 ? length + index : index - 1;
  if (!Number.isInteger(index) || index === 0 || resolved < 0 || resolved >= length) {
    throw new MeshFormatError("face index out of range");
  }
  return resolved;
}

/** The primitive-local index of one face corner (`v`, `v/t`, `v//n`, `v/t/n`). */
function corner(token: string, tables: ObjTables, prim: Building): number {
  const [vi, ti, ni] = token.split("/");
  const v = resolveIndex(vi, tables.v.length / 3);
  if (v === null) throw new MeshFormatError("face without a position");
  const t = resolveIndex(ti, tables.vt.length / 2);
  const n = resolveIndex(ni, tables.vn.length / 3);
  const key = `${v}/${t ?? ""}/${n ?? ""}`;
  const known = prim.keys.get(key);
  if (known !== undefined) return known;
  const index = prim.positions.length / 3;
  prim.keys.set(key, index);
  prim.positions.push(tables.v[v * 3] ?? 0, tables.v[v * 3 + 1] ?? 0, tables.v[v * 3 + 2] ?? 0);
  prim.uvs.push(t === null ? 0 : (tables.vt[t * 2] ?? 0), t === null ? 0 : 1 - (tables.vt[t * 2 + 1] ?? 0));
  prim.hasUv ||= t !== null;
  prim.normals.push(...(n === null ? [0, 0, 0] : tables.vn.slice(n * 3, n * 3 + 3)));
  prim.allNormals &&= n !== null;
  return index;
}

const primitiveFor = (material: string | null): Building => ({
  material,
  keys: new Map(),
  positions: [],
  uvs: [],
  normals: [],
  hasUv: false,
  allNormals: true,
  indices: [],
});

/** The `mtllib` the OBJ names first, or null: the host copies it beside the OBJ for the importer. */
export function objMaterialLibrary(text: string): string | null {
  const line = text.split(/\r?\n/).find((entry) => entry.trimStart().startsWith("mtllib "));
  return line ? line.trim().slice("mtllib ".length).trim() : null;
}

/** Push a numeric OBJ table row: `width` values, of which the first `required` must be there (the rest default to 0). */
function pushRow(table: number[], rest: string[], width: number, required: number, what: string): void {
  for (let i = 0; i < width; i++) table.push(finite(rest[i] ?? (i < required ? undefined : "0"), what));
}

/** The OBJ being read: its tables, its primitives by material, and the material in use. */
interface ObjReading {
  tables: ObjTables;
  prims: Map<string | null, Building>;
  material: string | null;
}

/** One face, fanned into triangles of its material's primitive. */
function addFace(reading: ObjReading, rest: string[]): void {
  if (rest.length < 3) throw new MeshFormatError("face with fewer than three corners");
  const prim = reading.prims.get(reading.material) ?? primitiveFor(reading.material);
  reading.prims.set(reading.material, prim);
  const corners = rest.map((token) => corner(token, reading.tables, prim));
  for (let i = 1; i + 1 < corners.length; i++) prim.indices.push(corners[0] ?? 0, corners[i] ?? 0, corners[i + 1] ?? 0);
}

/** What each OBJ keyword this converter reads does; any other line (groups, smoothing, comments) is ignored. */
const OBJ_LINES: Readonly<Record<string, (reading: ObjReading, rest: string[]) => void>> = {
  v: (reading, rest) => pushRow(reading.tables.v, rest, 3, 3, "vertex"),
  vt: (reading, rest) => pushRow(reading.tables.vt, rest, 2, 1, "texture coordinate"),
  vn: (reading, rest) => pushRow(reading.tables.vn, rest, 3, 3, "normal"),
  usemtl: (reading, rest) => {
    reading.material = rest.join(" ");
  },
  f: addFace,
};

/** The OBJ's faces, grouped into primitives by material. */
function parseObjFaces(text: string): Building[] {
  const reading: ObjReading = { tables: { v: [], vt: [], vn: [] }, prims: new Map(), material: null };
  for (const line of text.split(/\r?\n/)) {
    const [keyword = "", ...rest] = line.trim().split(/\s+/);
    if (Object.hasOwn(OBJ_LINES, keyword)) OBJ_LINES[keyword]?.(reading, rest);
  }
  return [...reading.prims.values()];
}

/** `text` (an OBJ) as a mesh; `mtl` is its material library's text, `mtlDir` that library's folder relative to the OBJ. */
export function objToMesh(text: string, mtl: string | null, mtlDir: string, name: string): MeshDocument {
  const prims = parseObjFaces(text);
  if (!prims.length) throw new MeshFormatError("no faces");
  const library = mtl === null ? new Map<string, MeshMaterial>() : parseMtl(mtl, mtlDir);
  const materials: MeshMaterial[] = [];
  const materialIndex = (wanted: string | null): number | undefined => {
    if (wanted === null) return undefined;
    const known = materials.findIndex((material) => material.name === wanted);
    if (known >= 0) return known;
    materials.push(library.get(wanted) ?? { name: wanted, baseColor: [1, 1, 1, 1] });
    return materials.length - 1;
  };
  const primitives: MeshPrimitive[] = prims.map((prim) => ({
    positions: Float32Array.from(prim.positions),
    ...(prim.allNormals ? { normals: Float32Array.from(prim.normals) } : {}),
    ...(prim.hasUv ? { uvs: Float32Array.from(prim.uvs) } : {}),
    indices: Uint32Array.from(prim.indices),
    ...withMaterial(materialIndex(prim.material)),
  }));
  return { name, primitives, materials };
}

const withMaterial = (material: number | undefined) => (material === undefined ? {} : { material });
