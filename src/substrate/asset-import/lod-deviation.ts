/**
 * How far a simplified level strays from the mesh it came from (LOD-09): the largest distance from
 * any vertex the original triangles use to the level's surface. meshoptimizer's own error is an
 * estimate from its quadrics and reads under this on a curved mesh (a unit sphere's first level
 * reports 0.0063 where its vertices lie 0.0097 away), so `lods.ts` never records less than this.
 *
 * The level's triangles are binned in a uniform grid over the mesh's bounds; each vertex searches
 * shells of cells outwards until no unvisited cell can hold a nearer triangle. A vertex the level
 * keeps lies on it. Pure float64 arithmetic over float32 input: a pure function of its input.
 */

/** Grid cells per axis at most: bounds the grid's memory (128³ offsets) on any mesh. */
const GRID_MAX_CELLS_PER_AXIS = 128;
const TRIANGLE = 3;
const AXES = 3;

/** The grid's shape: its corner, cell size and cells per axis. */
interface GridShape {
  min: Float64Array;
  cell: Float64Array;
  dims: Int32Array;
}

/** The level's triangles binned by the cells their bounding boxes touch, as offsets into one list. */
interface TriangleGrid extends GridShape {
  /** Cell `c` holds `triangles[start[c] .. start[c + 1]]` (first-corner offsets into the level). */
  start: Int32Array;
  triangles: Int32Array;
}

/** The smallest box around the vertices `indices` use. */
function boundsOf(positions: Float32Array, indices: Uint32Array): { min: Float64Array; max: Float64Array } {
  const min = new Float64Array(AXES).fill(Number.POSITIVE_INFINITY);
  const max = new Float64Array(AXES).fill(Number.NEGATIVE_INFINITY);
  for (const vertex of indices) {
    for (let axis = 0; axis < AXES; axis++) {
      const value = positions[vertex * AXES + axis] ?? 0;
      if (value < (min[axis] ?? 0)) min[axis] = value;
      if (value > (max[axis] ?? 0)) max[axis] = value;
    }
  }
  return { min, max };
}

/** The cell coordinate of `value` on `axis`, clamped into the grid. */
function cellOf(grid: GridShape, axis: number, value: number): number {
  const at = Math.floor((value - (grid.min[axis] ?? 0)) / (grid.cell[axis] ?? 1));
  return Math.min(Math.max(at, 0), (grid.dims[axis] ?? 1) - 1);
}

/** The cell box a triangle's bounding box covers, low xyz then high xyz, into `out`. */
function triangleCells(grid: GridShape, positions: Float32Array, level: Uint32Array, first: number, out: Int32Array) {
  for (let axis = 0; axis < AXES; axis++) {
    const a = positions[(level[first] ?? 0) * AXES + axis] ?? 0;
    const b = positions[(level[first + 1] ?? 0) * AXES + axis] ?? 0;
    const c = positions[(level[first + 2] ?? 0) * AXES + axis] ?? 0;
    out[axis] = cellOf(grid, axis, Math.min(a, b, c));
    out[axis + AXES] = cellOf(grid, axis, Math.max(a, b, c));
  }
}

/** Call `visit` with the flat index of every cell in the box `range` (low xyz, high xyz). */
function eachCell(dims: Int32Array, range: Int32Array, visit: (cell: number) => void): void {
  const [dx, dy] = [dims[0] ?? 1, dims[1] ?? 1];
  for (let z = range[2] ?? 0; z <= (range[5] ?? 0); z++)
    for (let y = range[1] ?? 0; y <= (range[4] ?? 0); y++)
      for (let x = range[0] ?? 0; x <= (range[3] ?? 0); x++) visit((z * dy + y) * dx + x);
}

/** The grid's shape over the bounds of the mesh `original` draws, sized for `triangles`. */
function gridShape(positions: Float32Array, original: Uint32Array, triangles: number): GridShape {
  const { min, max } = boundsOf(positions, original);
  // Surfaces are two-dimensional: about one triangle per cell of the box's largest face.
  const side = Math.min(Math.max(Math.ceil(Math.sqrt(triangles)), 1), GRID_MAX_CELLS_PER_AXIS);
  const extent = (axis: number) => Math.max((max[axis] ?? 0) - (min[axis] ?? 0), Number.EPSILON);
  const largest = Math.max(extent(0), extent(1), extent(2));
  const dims = Int32Array.from([0, 1, 2], (axis) => Math.max(1, Math.ceil((side * extent(axis)) / largest)));
  const cell = Float64Array.from([0, 1, 2], (axis) => extent(axis) / (dims[axis] ?? 1));
  return { min, cell, dims };
}

/** `level`'s triangles binned over the bounds of the mesh `original` draws (counted, then filled). */
function buildGrid(positions: Float32Array, original: Uint32Array, level: Uint32Array): TriangleGrid {
  const shape = gridShape(positions, original, level.length / TRIANGLE);
  const cellCount = (shape.dims[0] ?? 1) * (shape.dims[1] ?? 1) * (shape.dims[2] ?? 1);
  const start = new Int32Array(cellCount + 1);
  const range = new Int32Array(AXES * 2);
  for (let first = 0; first < level.length; first += TRIANGLE) {
    triangleCells(shape, positions, level, first, range);
    eachCell(shape.dims, range, (at) => {
      start[at + 1] = (start[at + 1] ?? 0) + 1;
    });
  }
  for (let at = 0; at < cellCount; at++) start[at + 1] = (start[at + 1] ?? 0) + (start[at] ?? 0);
  const fill = start.slice(0, cellCount);
  const triangles = new Int32Array(start[cellCount] ?? 0);
  for (let first = 0; first < level.length; first += TRIANGLE) {
    triangleCells(shape, positions, level, first, range);
    eachCell(shape.dims, range, (at) => {
      triangles[fill[at] ?? 0] = first;
      fill[at] = (fill[at] ?? 0) + 1;
    });
  }
  return { ...shape, start, triangles };
}

/** Squared distance from point `p` to triangle `abc`, each a vertex of `positions`. */
function pointTriangleSquared(positions: Float32Array, p: number, a: number, b: number, c: number): number {
  const ax = positions[a * AXES] ?? 0;
  const ay = positions[a * AXES + 1] ?? 0;
  const az = positions[a * AXES + 2] ?? 0;
  const abx = (positions[b * AXES] ?? 0) - ax;
  const aby = (positions[b * AXES + 1] ?? 0) - ay;
  const abz = (positions[b * AXES + 2] ?? 0) - az;
  const acx = (positions[c * AXES] ?? 0) - ax;
  const acy = (positions[c * AXES + 1] ?? 0) - ay;
  const acz = (positions[c * AXES + 2] ?? 0) - az;
  const apx = (positions[p * AXES] ?? 0) - ax;
  const apy = (positions[p * AXES + 1] ?? 0) - ay;
  const apz = (positions[p * AXES + 2] ?? 0) - az;
  // Ericson, Real-Time Collision Detection 5.1.5: the closest point as weights (v, w) on ab and ac.
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  const abab = abx * abx + aby * aby + abz * abz;
  const abac = abx * acx + aby * acy + abz * acz;
  const acac = acx * acx + acy * acy + acz * acz;
  const [v, w] = closestWeights(d1, d2, d1 - abab, d2 - abac, d1 - abac, d2 - acac);
  const dx = apx - v * abx - w * acx;
  const dy = apy - v * aby - w * acy;
  const dz = apz - v * abz - w * acz;
  return dx * dx + dy * dy + dz * dz;
}

/** The closest point's weights on ab and ac from Ericson's six dot products (a vertex, edge or face region). */
function closestWeights(d1: number, d2: number, d3: number, d4: number, d5: number, d6: number): [number, number] {
  if (d1 <= 0 && d2 <= 0) return [0, 0];
  if (d3 >= 0 && d4 <= d3) return [1, 0];
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return [d1 / (d1 - d3), 0];
  if (d6 >= 0 && d5 <= d6) return [0, 1];
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return [0, d2 / (d2 - d6)];
  const va = d3 * d6 - d5 * d4;
  const onBc = va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0;
  if (onBc) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [1 - w, w];
  }
  const sum = va + vb + vc;
  // A degenerate (zero-area) triangle falls back to its first corner.
  return sum > 0 ? [vb / sum, vc / sum] : [0, 0];
}

/** What every vertex's search shares: the grid, the level, and the triangles measured (stamped per vertex). */
interface Search {
  grid: TriangleGrid;
  positions: Float32Array;
  level: Uint32Array;
  seen: Int32Array;
  range: Int32Array;
}

/** The nearest squared distance from vertex `p` to a triangle of one cell it has not measured yet. */
function cellNearest(search: Search, p: number, cell: number): number {
  const { grid, level, positions, seen } = search;
  let nearest = Number.POSITIVE_INFINITY;
  for (let at = grid.start[cell] ?? 0; at < (grid.start[cell + 1] ?? 0); at++) {
    const first = grid.triangles[at] ?? 0;
    const triangle = first / TRIANGLE;
    if (seen[triangle] === p) continue;
    seen[triangle] = p;
    const squared = pointTriangleSquared(positions, p, level[first] ?? 0, level[first + 1] ?? 0, level[first + 2] ?? 0);
    if (squared < nearest) nearest = squared;
  }
  return nearest;
}

/** The box of cells within `ring` of `home`, clipped to the grid, into `search.range`. */
function shellBox(search: Search, home: Int32Array, ring: number): Int32Array {
  const { grid, range } = search;
  for (let axis = 0; axis < AXES; axis++) {
    range[axis] = Math.max((home[axis] ?? 0) - ring, 0);
    range[axis + AXES] = Math.min((home[axis] ?? 0) + ring, (grid.dims[axis] ?? 1) - 1);
  }
  return range;
}

/** The nearest squared distance from vertex `p` to a triangle in row (y, z) of shell `ring` around `home`. */
function rowNearest(search: Search, p: number, home: Int32Array, ring: number, y: number, z: number): number {
  const [low, high] = [search.range[0] ?? 0, search.range[3] ?? 0];
  const [hx, hy, hz] = [home[0] ?? 0, home[1] ?? 0, home[2] ?? 0];
  const row = (z * (search.grid.dims[1] ?? 1) + y) * (search.grid.dims[0] ?? 1);
  const onFace = Math.abs(z - hz) === ring || Math.abs(y - hy) === ring;
  // On the shell's z and y faces the whole row lies on it; elsewhere only its two x ends.
  const xs = onFace ? null : [hx - ring, hx + ring].filter((x) => x >= low && x <= high);
  let nearest = Number.POSITIVE_INFINITY;
  if (xs) {
    for (const x of xs) nearest = Math.min(nearest, cellNearest(search, p, row + x));
    return nearest;
  }
  for (let x = low; x <= high; x++) nearest = Math.min(nearest, cellNearest(search, p, row + x));
  return nearest;
}

/** The nearest squared distance from vertex `p` to a triangle in the cells of shell `ring` around `home`. */
function shellNearest(search: Search, p: number, home: Int32Array, ring: number): number {
  const range = shellBox(search, home, ring);
  const [y0, z0, y1, z1] = [range[1] ?? 0, range[2] ?? 0, range[4] ?? 0, range[5] ?? 0];
  let nearest = Number.POSITIVE_INFINITY;
  for (let z = z0; z <= z1; z++)
    for (let y = y0; y <= y1; y++) nearest = Math.min(nearest, rowNearest(search, p, home, ring, y, z));
  return nearest;
}

/** The distance from vertex `p` to the nearest triangle of the level. */
function nearest(search: Search, p: number): number {
  const { grid, positions } = search;
  const home = Int32Array.from([0, 1, 2], (axis) => cellOf(grid, axis, positions[p * AXES + axis] ?? 0));
  const step = Math.min(...grid.cell);
  const reach = Math.max(...grid.dims);
  let best = Number.POSITIVE_INFINITY;
  for (let ring = 0; ring <= reach; ring++) {
    best = Math.min(best, shellNearest(search, p, home, ring));
    // Every cell past this shell is at least `ring` whole cells from any point of the home cell.
    if (best <= (ring * step) ** 2) break;
  }
  return Math.sqrt(best);
}

/** Call `visit` with each vertex `original` uses that `level` drops, once, and its distance to `level`. */
function eachDropped(
  positions: Float32Array,
  original: Uint32Array,
  level: Uint32Array,
  visit: (vertex: number, distance: number) => void,
): void {
  const done = new Uint8Array(positions.length / AXES);
  // A vertex the level keeps lies on it.
  for (const vertex of level) done[vertex] = 1;
  const search: Search = {
    grid: buildGrid(positions, original, level),
    positions,
    level,
    seen: new Int32Array(level.length / TRIANGLE).fill(-1),
    range: new Int32Array(AXES * 2),
  };
  for (const vertex of original) {
    if (done[vertex]) continue;
    done[vertex] = 1;
    visit(vertex, nearest(search, vertex));
  }
}

/**
 * The largest distance from a vertex `original` uses to the surface of `level` (both triangle
 * lists over `positions`, xyz floats); 0 for an empty original, infinity for an empty level.
 */
export function vertexDeviation(positions: Float32Array, original: Uint32Array, level: Uint32Array): number {
  if (!original.length) return 0;
  if (!level.length) return Number.POSITIVE_INFINITY;
  let worst = 0;
  eachDropped(positions, original, level, (_, distance) => {
    worst = Math.max(worst, distance);
  });
  return worst;
}

/**
 * The vertices `original` uses that lie farther than `bound` from the surface of `level` (lane FR:
 * the ones a finer level must keep), in first-use order; every dropped vertex for an empty level.
 */
export function verticesBeyond(
  positions: Float32Array,
  original: Uint32Array,
  level: Uint32Array,
  bound: number,
): number[] {
  const beyond: number[] = [];
  if (!level.length) return [...new Set(original)];
  eachDropped(positions, original, level, (vertex, distance) => {
    if (distance > bound) beyond.push(vertex);
  });
  return beyond;
}
