/**
 * Leaf cards (LOD-09): the small, flat components a foliage primitive is made of. Every card vertex
 * is on an open border, so edge collapse either cannot touch a card or erodes it into a sliver and
 * the crown loses half its drawn area at the first level; `lods.ts` locks every card vertex so
 * cards stay whole.
 *
 * - **Cards** are connected components of at most {@link CARD_MAX_TRIANGLES} triangles that are
 *   nearly flat (open quads, or front and back faces over the same vertices) and small against
 *   the primitive.
 * - **Order.** Cards are listed along a Morton curve of their centres, ties broken by a hash of
 *   where each is and how it faces, so the list never depends on their order in the file.
 *
 * Pure arithmetic over the input: the output is a pure function of it.
 */
import type { Geometry } from "./meshlets.ts";

/** A component with more triangles than this is not a card. */
export const CARD_MAX_TRIANGLES = 8;
/** A primitive needs at least this many cards for them to count as cards. */
export const CARD_MIN_COUNT = 8;
/** A card's farthest vertex may lie this share of its size off its mean plane. */
const CARD_MAX_BEND = 0.15;
/** A card is at most this share of the primitive's largest extent across. */
const CARD_MAX_SIZE_SHARE = 0.25;
/** Bits per axis of a card centre's Morton code. */
const MORTON_BITS = 10;
const TRIANGLE = 3;
const AXES = 3;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** One card: its triangles (corner indices), its distinct vertices, centre, area and order keys. */
interface Card {
  corners: Uint32Array;
  vertices: Uint32Array;
  centre: [number, number, number];
  area: number;
  hash: number;
  morton: number;
}

/** A primitive split into its cards and the triangles that are not cards. */
export interface CardSplit {
  cards: Card[];
  rest: Uint32Array;
}

/** Union-find root of `vertex`, halving the path as it goes. */
function root(parent: Int32Array, vertex: number): number {
  let at = vertex;
  while (parent[at] !== at) {
    const up = parent[at] ?? at;
    parent[at] = parent[up] ?? up;
    at = parent[at] ?? at;
  }
  return at;
}

/** The triangles of `indices` grouped into connected components (shared vertex indices), in first-triangle order. */
function components(indices: Uint32Array, vertexCount: number): number[][] {
  const parent = Int32Array.from({ length: vertexCount }, (_, at) => at);
  for (let at = 0; at < indices.length; at += TRIANGLE) {
    const a = root(parent, indices[at] ?? 0);
    parent[root(parent, indices[at + 1] ?? 0)] = a;
    parent[root(parent, indices[at + 2] ?? 0)] = a;
  }
  const groups = new Map<number, number[]>();
  for (let at = 0; at < indices.length; at += TRIANGLE) {
    const key = root(parent, indices[at] ?? 0);
    const group = groups.get(key) ?? [];
    group.push(at);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** A vertex's position. */
const point = (positions: Float32Array, vertex: number): [number, number, number] => [
  positions[vertex * AXES] ?? 0,
  positions[vertex * AXES + 1] ?? 0,
  positions[vertex * AXES + 2] ?? 0,
];

/** Twice the triangle's area vector (its unnormalized normal). */
function areaVector(positions: Float32Array, a: number, b: number, c: number): [number, number, number] {
  const [pa, pb, pc] = [point(positions, a), point(positions, b), point(positions, c)];
  const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
  const v = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
  const [ux, uy, uz, vx, vy, vz] = [u[0] ?? 0, u[1] ?? 0, u[2] ?? 0, v[0] ?? 0, v[1] ?? 0, v[2] ?? 0];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/**
 * Twice a sheet's area vector: its triangles' area vectors summed, each turned to face the first
 * one's way, so a card drawn as front and back faces over the same vertices still has a facing.
 */
function sheetNormal(positions: Float32Array, corners: Uint32Array): number[] {
  const normal = [0, 0, 0];
  const first = areaVector(positions, corners[0] ?? 0, corners[1] ?? 0, corners[2] ?? 0);
  for (let at = 0; at < corners.length; at += TRIANGLE) {
    const vector = areaVector(positions, corners[at] ?? 0, corners[at + 1] ?? 0, corners[at + 2] ?? 0);
    const sign = dot(vector, first) < 0 ? -1 : 1;
    for (let axis = 0; axis < AXES; axis++) normal[axis] = (normal[axis] ?? 0) + sign * (vector[axis] ?? 0);
  }
  return normal;
}

/**
 * The component as a card, or null when it is too big or too bent to be one. A flat component is
 * open or a two-faced sheet either way: anything closed with volume fails the flatness bound.
 */
function asCard(geometry: Geometry, triangles: readonly number[], largestExtent: number): Card | null {
  const { indices, positions } = geometry;
  if (triangles.length > CARD_MAX_TRIANGLES) return null;
  const corners = Uint32Array.from(
    triangles.flatMap((at) => [indices[at] ?? 0, indices[at + 1] ?? 0, indices[at + 2] ?? 0]),
  );
  const vertices = Uint32Array.from(new Set(corners));
  const normal = sheetNormal(positions, corners);
  const doubled = Math.hypot(normal[0] ?? 0, normal[1] ?? 0, normal[2] ?? 0);
  const centre = [0, 1, 2].map(
    (axis) =>
      Array.from(vertices).reduce((sum, vertex) => sum + (positions[vertex * AXES + axis] ?? 0), 0) / vertices.length,
  ) as [number, number, number];
  const size = Math.max(...Array.from(vertices, (vertex) => distance(point(positions, vertex), centre))) * 2;
  if (doubled === 0 || size === 0 || size > largestExtent * CARD_MAX_SIZE_SHARE) return null;
  const unit = normal.map((value) => value / doubled);
  const bend = Math.max(
    ...Array.from(vertices, (vertex) => Math.abs(dot(unit, sub(point(positions, vertex), centre)))),
  );
  if (bend > size * CARD_MAX_BEND) return null;
  // Crossed cards share a centre: the facing tells them apart.
  const hash = positionHash([...centre, ...unit]);
  return { corners, vertices, centre, area: cardArea(positions, corners), hash, morton: 0 };
}

const sub = (a: readonly number[], b: readonly number[]) => [0, 1, 2].map((axis) => (a[axis] ?? 0) - (b[axis] ?? 0));
const dot = (a: readonly number[], b: readonly number[]) =>
  [0, 1, 2].reduce((sum, axis) => sum + (a[axis] ?? 0) * (b[axis] ?? 0), 0);
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(...sub(a, b));

/** The summed area of a card's triangles. */
function cardArea(positions: Float32Array, corners: Uint32Array): number {
  let sum = 0;
  for (let at = 0; at < corners.length; at += TRIANGLE) {
    sum += Math.hypot(...areaVector(positions, corners[at] ?? 0, corners[at + 1] ?? 0, corners[at + 2] ?? 0)) / 2;
  }
  return sum;
}

/** FNV-1a over numbers' float32 bits (-0 read as 0): where a card is and how it faces, as 32 bits. */
function positionHash(values: readonly number[]): number {
  const bits = new Uint32Array(Float32Array.from(values, (value) => value + 0).buffer);
  let hash = FNV_OFFSET;
  for (const word of bits) {
    for (let shift = 0; shift < 32; shift += 8) hash = Math.imul(hash ^ ((word >>> shift) & 0xff), FNV_PRIME) >>> 0;
  }
  return hash;
}

/** `value` with a zero bit after each of its low {@link MORTON_BITS} bits, twice (one axis of a 3D Morton code). */
function spread(value: number): number {
  let out = 0;
  for (let bit = 0; bit < MORTON_BITS; bit++) out |= ((value >>> bit) & 1) << (bit * AXES);
  return out >>> 0;
}

/** Each card's Morton code over the cards' centre bounds. */
function withMorton(cards: Card[]): void {
  const low = [0, 1, 2].map((axis) => Math.min(...cards.map((each) => each.centre[axis])));
  const high = [0, 1, 2].map((axis) => Math.max(...cards.map((each) => each.centre[axis])));
  const cells = (1 << MORTON_BITS) - 1;
  for (const each of cards) {
    const q = [0, 1, 2].map((axis) => {
      const span = (high[axis] ?? 0) - (low[axis] ?? 0);
      return span > 0 ? Math.round((((each.centre[axis] ?? 0) - (low[axis] ?? 0)) / span) * cells) : 0;
    });
    each.morton = (spread(q[0] ?? 0) | (spread(q[1] ?? 0) << 1) | (spread(q[2] ?? 0) << 2)) >>> 0;
  }
}

/** The largest side of the box around the vertices `indices` use. */
function largestExtent(positions: Float32Array, indices: Uint32Array): number {
  const { min, max } = boundsOf(positions, indices);
  return Math.max(...[0, 1, 2].map((axis) => (max[axis] ?? 0) - (min[axis] ?? 0)));
}

/** The box around the vertices `indices` use. */
function boundsOf(positions: Float32Array, indices: Uint32Array): { min: number[]; max: number[] } {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const vertex of indices) {
    for (let axis = 0; axis < AXES; axis++) {
      const value = positions[vertex * AXES + axis] ?? 0;
      if (value < (min[axis] ?? 0)) min[axis] = value;
      if (value > (max[axis] ?? 0)) max[axis] = value;
    }
  }
  return { min, max };
}

/**
 * The primitive's cards (in Morton order of their centres, ties by hash) and its other triangles,
 * or null when it has fewer than {@link CARD_MIN_COUNT} cards.
 */
export function findCards(geometry: Geometry): CardSplit | null {
  const extent = largestExtent(geometry.positions, geometry.indices);
  const cards: Card[] = [];
  const rest: number[] = [];
  for (const triangles of components(geometry.indices, geometry.positions.length / AXES)) {
    const found = asCard(geometry, triangles, extent);
    if (found) cards.push(found);
    else for (const at of triangles) rest.push(...geometry.indices.subarray(at, at + TRIANGLE));
  }
  if (cards.length < CARD_MIN_COUNT) return null;
  withMorton(cards);
  cards.sort((a, b) => a.morton - b.morton || a.hash - b.hash);
  return { cards, rest: Uint32Array.from(rest) };
}
