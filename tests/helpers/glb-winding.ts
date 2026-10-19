/**
 * Which way a GLB's triangles face: the count wound clockwise seen from outside a mesh about the
 * origin (a sphere fixture), which a renderer that culls back faces draws inside out.
 */
import { GltfComponent, readGlb } from "../../src/substrate/asset-import/glb.ts";

// biome-ignore lint/suspicious/noExplicitAny: fixtures read untyped glTF JSON.
type Json = Record<string, any>;

/** Each component type's size and reader. */
const READ: Readonly<Record<number, readonly [number, (data: DataView, at: number) => number]>> = {
  [GltfComponent.Float]: [4, (data, at) => data.getFloat32(at, true)],
  [GltfComponent.UnsignedByte]: [1, (data, at) => data.getUint8(at)],
  [GltfComponent.UnsignedShort]: [2, (data, at) => data.getUint16(at, true)],
  [GltfComponent.UnsignedInt]: [4, (data, at) => data.getUint32(at, true)],
};

/** Accessor `at`'s elements, each `width` numbers. */
function elements(json: Json, bin: Uint8Array, at: number, width: number): number[][] {
  const accessor = json.accessors[at];
  const view = json.bufferViews[accessor.bufferView];
  const [size, get] = READ[accessor.componentType] ?? [4, () => Number.NaN];
  const stride = view.byteStride ?? size * width;
  const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return Array.from({ length: accessor.count }, (_, i) =>
    Array.from({ length: width }, (_, c) => get(data, start + i * stride + c * size)),
  );
}

/** a × b. */
const cross = ([ax = 0, ay = 0, az = 0]: number[], [bx = 0, by = 0, bz = 0]: number[]) => [
  ay * bz - az * by,
  az * bx - ax * bz,
  ax * by - ay * bx,
];

/** The triangles of mesh 0's primitive `primitive` that face the origin. */
export function inwardTriangles(glb: Uint8Array, primitive = 0): number {
  const { json, bin } = readGlb(glb) as { json: Json; bin: Uint8Array };
  const prim = json.meshes[0].primitives[primitive];
  const positions = elements(json, bin, prim.attributes.POSITION, 3);
  const indices = elements(json, bin, prim.indices, 1).map(([i = 0]) => i);
  let facing = 0;
  for (let at = 0; at + 2 < indices.length; at += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => positions[indices[at + k] ?? 0] ?? []);
    const edge = (to: number[] | undefined) => [0, 1, 2].map((k) => (to?.[k] ?? 0) - (a?.[k] ?? 0));
    const normal = cross(edge(b), edge(c));
    const centre = [0, 1, 2].map((k) => (a?.[k] ?? 0) + (b?.[k] ?? 0) + (c?.[k] ?? 0));
    if (normal.reduce((sum, n, k) => sum + n * (centre[k] ?? 0), 0) < 0) facing++;
  }
  return facing;
}
