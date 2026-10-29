/**
 * Dense synthetic models for the decimation tests: a bumpy grid of any density, as a GLB or as a
 * glTF with its buffer beside it (the shape Poly Haven serves a model in).
 */
import { meshToGlb, readGlb } from "../../src/substrate/asset-import/glb.ts";

/**
 * A bumpy `cells` x `cells` grid, 1 m across, as `parts` primitives split by rows that share their
 * seam rows' positions: normals and UVs on every vertex, so the simplifier weighs both.
 */
export function bumpyGrid(cells: number, parts = 2): Uint8Array {
  const side = cells + 1;
  const height = (x: number, z: number) => 0.02 * Math.sin(x * 23) * Math.cos(z * 17);
  const vertex = (row: number, column: number) => {
    const x = column / cells;
    const z = row / cells;
    return { position: [x, height(x, z), z], normal: [0, 1, 0], uv: [x, z] };
  };
  const per = Math.ceil(cells / parts);
  const primitives = Array.from({ length: parts }, (_, part) => {
    const first = part * per;
    const last = Math.min(cells, (part + 1) * per);
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    for (let row = first; row <= last; row++) {
      for (let column = 0; column < side; column++) {
        const each = vertex(row, column);
        positions.push(...each.position);
        normals.push(...each.normal);
        uvs.push(...each.uv);
      }
    }
    const indices: number[] = [];
    for (let row = 0; row < last - first; row++) {
      for (let column = 0; column < cells; column++) {
        const a = row * side + column;
        const b = a + side;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    return {
      positions: Float32Array.from(positions),
      normals: Float32Array.from(normals),
      uvs: Float32Array.from(uvs),
      indices: Uint32Array.from(indices),
    };
  });
  return meshToGlb({ name: "grid", materials: [], primitives });
}

/** {@link bumpyGrid} as a glTF naming its buffer `bin` by URI, and that buffer's bytes. */
export function bumpyGltf(cells: number, bin: string): { gltf: Uint8Array; bin: Uint8Array } {
  const parts = readGlb(bumpyGrid(cells));
  const json = structuredClone(parts.json) as { buffers: Array<Record<string, unknown>> };
  json.buffers = [{ uri: bin, byteLength: parts.bin.byteLength }];
  return { gltf: new TextEncoder().encode(JSON.stringify(json)), bin: parts.bin };
}
