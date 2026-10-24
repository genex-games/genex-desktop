/**
 * Small synthetic glTF models for the Roblox plugin's asset gate (`plugins/roblox/asset-gate.ts`):
 * a GLB writer and the models the fixtures in `fixtures/roblox-models/` are made from, each failing
 * the gate for one reason only. `writeModelFixtures` writes them again; a test holds the committed
 * files equal to what these builders make.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";

export const MODEL_FIXTURES = path.resolve(import.meta.dirname, "../fixtures/roblox-models");

/** One primitive: flat arrays as glTF holds them. */
export interface Primitive {
  positions: number[];
  normals?: number[];
  uvs?: number[];
  indices?: number[];
  material?: number;
  /** JOINTS_n and WEIGHTS_n, four per vertex each, set by set. */
  joints?: number[][];
  weights?: number[][];
  mode?: number;
}

/** A picture the model embeds, used as the first material's colour texture. */
export interface Picture {
  mime: string;
  bytes: Uint8Array;
  name: string;
}

/** What one model file holds. */
export interface ModelSpec {
  primitives: Primitive[];
  materials?: number;
  picture?: Picture;
  /** The root node's translation. */
  root?: [number, number, number];
  /** A child node under the root holding the mesh, with its own translation. */
  child?: [number, number, number];
  /** Joints the mesh is skinned to, all at the origin. */
  joints?: number;
  extensionsRequired?: string[];
}

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const UNSIGNED_BYTE = 5121;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

const pad4 = (bytes: Buffer, fill: number) => {
  const extra = (4 - (bytes.length % 4)) % 4;
  return extra ? Buffer.concat([bytes, Buffer.alloc(extra, fill)]) : bytes;
};

/** A GLB 2 file of `spec`: one buffer, one view per accessor, the picture in a view of its own. */
export function buildGlb(spec: ModelSpec): Buffer {
  const chunks: Buffer[] = [];
  const bufferViews: Array<Record<string, number>> = [];
  const accessors: Array<Record<string, unknown>> = [];
  let length = 0;
  const view = (bytes: Buffer, target?: number) => {
    const padded = pad4(bytes, 0);
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, ...(target ? { target } : {}) });
    chunks.push(padded);
    length += padded.length;
    return bufferViews.length - 1;
  };
  const floats = (values: number[], type: string, size: number, minMax = false) => {
    const bytes = Buffer.alloc(values.length * 4);
    values.forEach((value, i) => {
      bytes.writeFloatLE(value, i * 4);
    });
    const accessor: Record<string, unknown> = {
      bufferView: view(bytes, ARRAY_BUFFER),
      componentType: FLOAT,
      count: values.length / size,
      type,
    };
    if (minMax) {
      const axes = [0, 1, 2].map((axis) => values.filter((_, i) => i % 3 === axis));
      accessor.min = axes.map((axis) => Math.min(...axis));
      accessor.max = axes.map((axis) => Math.max(...axis));
    }
    accessors.push(accessor);
    return accessors.length - 1;
  };
  const indices = (values: number[]) => {
    const wide = values.some((value) => value > 0xffff);
    const bytes = Buffer.alloc(values.length * (wide ? 4 : 2));
    values.forEach((value, i) => {
      if (wide) bytes.writeUInt32LE(value, i * 4);
      else bytes.writeUInt16LE(value, i * 2);
    });
    accessors.push({
      bufferView: view(bytes, ELEMENT_ARRAY_BUFFER),
      componentType: wide ? UNSIGNED_INT : UNSIGNED_SHORT,
      count: values.length,
      type: "SCALAR",
    });
    return accessors.length - 1;
  };
  const jointSet = (values: number[]) => {
    accessors.push({
      bufferView: view(Buffer.from(values), ARRAY_BUFFER),
      componentType: UNSIGNED_BYTE,
      count: values.length / 4,
      type: "VEC4",
    });
    return accessors.length - 1;
  };
  const primitives = spec.primitives.map((primitive) => {
    const attributes: Record<string, number> = { POSITION: floats(primitive.positions, "VEC3", 3, true) };
    if (primitive.normals) attributes.NORMAL = floats(primitive.normals, "VEC3", 3);
    if (primitive.uvs) attributes.TEXCOORD_0 = floats(primitive.uvs, "VEC2", 2);
    (primitive.joints ?? []).forEach((set, n) => {
      attributes[`JOINTS_${n}`] = jointSet(set);
    });
    (primitive.weights ?? []).forEach((set, n) => {
      attributes[`WEIGHTS_${n}`] = floats(set, "VEC4", 4);
    });
    return {
      attributes,
      ...(primitive.indices ? { indices: indices(primitive.indices) } : {}),
      ...(primitive.material === undefined ? {} : { material: primitive.material }),
      ...(primitive.mode === undefined ? {} : { mode: primitive.mode }),
    };
  });
  const json: Record<string, unknown> = { asset: { version: "2.0", generator: "Genex test models" } };
  if (spec.extensionsRequired) {
    json.extensionsUsed = spec.extensionsRequired;
    json.extensionsRequired = spec.extensionsRequired;
  }
  Object.assign(json, sceneOf(spec));
  json.meshes = [{ name: "Model", primitives }];
  const materials = Array.from({ length: spec.materials ?? 1 }, (_, i) => ({
    name: `Material${i}`,
    pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1] },
  }));
  if (spec.picture) {
    json.images = [
      { name: spec.picture.name, mimeType: spec.picture.mime, bufferView: view(Buffer.from(spec.picture.bytes)) },
    ];
    json.textures = [{ source: 0 }];
    (materials[0] as unknown as Record<string, Record<string, unknown>>).pbrMetallicRoughness.baseColorTexture = {
      index: 0,
    };
  }
  json.materials = materials;
  json.accessors = accessors;
  json.bufferViews = bufferViews;
  json.buffers = [{ byteLength: length }];
  return glbFile(json, Buffer.concat(chunks));
}

/** The nodes and scene of `spec`: the mesh's node (under a root when it has a child offset) and its bones. */
function sceneOf(spec: ModelSpec): Record<string, unknown> {
  const nodes: Array<Record<string, unknown>> = [];
  const meshNode: Record<string, unknown> = { name: "Model", mesh: 0 };
  const root = spec.root ? { translation: spec.root } : {};
  if (spec.child) nodes.push({ name: "Root", children: [1], ...root }, { ...meshNode, translation: spec.child });
  else nodes.push({ ...meshNode, ...root });
  const roots = [0];
  const scene: Record<string, unknown> = {};
  if (spec.joints) {
    const first = nodes.length;
    const bones = Array.from({ length: spec.joints }, (_, i) => first + i);
    nodes.push({ name: "Bone0", children: bones.slice(1) });
    for (let i = 1; i < spec.joints; i++) nodes.push({ name: `Bone${i}` });
    roots.push(first);
    (nodes[0] as Record<string, unknown>).skin = 0;
    scene.skins = [{ joints: bones }];
  }
  return { ...scene, scene: 0, scenes: [{ nodes: roots }], nodes };
}

/** A GLB 2 file of a glTF document and its one buffer. */
export function glbFile(json: Record<string, unknown>, bin: Buffer): Buffer {
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json)), 0x20);
  const chunkHeader = (size: number, type: number) => {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(size, 0);
    header.writeUInt32LE(type, 4);
    return header;
  };
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + bin.length, 8);
  return Buffer.concat([
    header,
    chunkHeader(jsonChunk.length, 0x4e4f534a),
    jsonChunk,
    chunkHeader(bin.length, 0x004e4942),
    bin,
  ]);
}

/** One face of the unit cube: its outward axis and sign, as four corners with normal and UVs. */
const FACES: Array<{ axis: number; sign: number }> = [
  { axis: 0, sign: 1 },
  { axis: 0, sign: -1 },
  { axis: 1, sign: 1 },
  { axis: 1, sign: -1 },
  { axis: 2, sign: 1 },
  { axis: 2, sign: -1 },
];

/**
 * A cube of side `size` centred on the origin, each face an `n` × `n` grid of quads with its own
 * vertices (welded only by position, as exporters write them), wound outward.
 */
export function gridCube(n = 1, size = 1, faces = FACES): Primitive {
  const cube: Required<Pick<Primitive, "positions" | "normals" | "uvs" | "indices">> = {
    positions: [],
    normals: [],
    uvs: [],
    indices: [],
  };
  for (const face of faces) gridFace(cube, face, n, size);
  return cube;
}

/** One face of a grid cube added to `cube`: its corners, then its quads as two triangles each. */
function gridFace(
  cube: Required<Pick<Primitive, "positions" | "normals" | "uvs" | "indices">>,
  { axis, sign }: { axis: number; sign: number },
  n: number,
  size: number,
): void {
  const half = size / 2;
  const u = (axis + 1) % 3;
  const v = (axis + 2) % 3;
  const base = cube.positions.length / 3;
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      const point = [0, 0, 0];
      point[axis] = sign * half;
      point[u] = -half + (size * i) / n;
      point[v] = -half + (size * j) / n;
      const normal = [0, 0, 0];
      normal[axis] = sign;
      cube.positions.push(...point);
      cube.normals.push(...normal);
      cube.uvs.push(i / n, j / n);
    }
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = base + j * (n + 1) + i;
      const c = a + n + 1;
      // u × v points along +axis, so a positive face winds a-b-d, a negative one the other way.
      if (sign > 0) cube.indices.push(a, a + 1, c + 1, a, c + 1, c);
      else cube.indices.push(a, c + 1, a + 1, a, c, c + 1);
    }
}

/** The cube split into two primitives by faces, the second with its own material. */
function twoMaterialCube(): Primitive[] {
  const first = gridCube(1, 1, FACES.slice(0, 3));
  const second = gridCube(1, 1, FACES.slice(3));
  return [
    { ...first, material: 0 },
    { ...second, material: 1 },
  ];
}

/** The cube skinned to five bones, its first vertex moved by all five. */
function fiveInfluenceCube(): Primitive {
  const cube = gridCube();
  const count = cube.positions.length / 3;
  const joints0 = Array.from({ length: count }, () => [0, 1, 2, 3]).flat();
  const weights0 = Array.from({ length: count }, () => [1, 0, 0, 0]).flat();
  const joints1 = Array.from({ length: count }, () => [4, 0, 0, 0]).flat();
  const weights1 = Array.from({ length: count }, () => [0, 0, 0, 0]).flat();
  weights0.splice(0, 4, 0.2, 0.2, 0.2, 0.2);
  weights1[0] = 0.2;
  return { ...cube, joints: [joints0, joints1], weights: [weights0, weights1] };
}

const pngChunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

/** A real grey PNG of `width` × `height` pixels (it compresses to a few kilobytes). */
export function greyPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  const rows = Buffer.alloc(height * (width + 1), 0x80);
  for (let row = 0; row < height; row++) rows[row * (width + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The committed models by file name; each fails the gate for one reason, or none. */
export async function modelFixtures(): Promise<Record<string, ModelSpec>> {
  const jpeg = await readFile(path.join(MODEL_FIXTURES, "texture.jpg"));
  return {
    "cube.glb": { primitives: [gridCube()] },
    "open-box.glb": {
      primitives: [
        gridCube(
          1,
          1,
          FACES.filter((face) => !(face.axis === 1 && face.sign > 0)),
        ),
      ],
    },
    "two-materials.glb": { primitives: twoMaterialCube(), materials: 2 },
    "five-influences.glb": { primitives: [fiveInfluenceCube()], joints: 5 },
    "off-origin.glb": { primitives: [gridCube()], root: [3, 0, 0] },
    "big-texture.glb": {
      primitives: [gridCube()],
      picture: { mime: "image/png", bytes: greyPng(2048, 2048), name: "stone" },
    },
    "jpeg-texture.glb": { primitives: [gridCube()], picture: { mime: "image/jpeg", bytes: jpeg, name: "wood" } },
  };
}

/** More than 20,000 triangles, closed: a cube whose faces are 41 × 41 grids (20,172 triangles). */
export const manyTriangles = (): ModelSpec => ({ primitives: [gridCube(41)] });

/** Writes the committed fixtures again from their builders. */
export async function writeModelFixtures(dir = MODEL_FIXTURES): Promise<void> {
  for (const [name, spec] of Object.entries(await modelFixtures()))
    await writeFile(path.join(dir, name), buildGlb(spec));
}
