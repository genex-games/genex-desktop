/**
 * The world placement compiler (C-28): a `world/<name>.cells.json` an agent wrote, validated and
 * compiled into a cell pack v1 folder and r16 terrain tiles (`shared/world-cells.ts` has the
 * format). All or nothing: anything it cannot place refuses with a typed code and the JSON
 * location, and no file is returned. The output is a pure function of the text and the assets it
 * reads, so two compiles give equal bytes.
 *
 * The pack bytes follow genex-stream's `pack.rs` (the module doc spells the wire format) and are
 * held to `tests/fixtures/stream/cell-pack-v1.json` byte for byte. Positions are binned on their
 * `f32` value, the way the runtime's grid bins them. A terrain tile is `samples` by `samples`
 * little-endian `u16` heights, rows by world z then columns by world x, sample `i` of cell `x` at
 * world `(x * (samples - 1) + i) * cellSize / (samples - 1)` metres, so neighbours share their
 * border samples bit for bit. A height is `min + value / 65535 * (max - min)` with `min` and `max`
 * from `terrain/terrain.json`, the same for every tile.
 *
 * Ideas from Bevy's `.scn.ron` scenes, Godot's `.tscn` and Unreal's World Partition actor
 * placement (no code taken).
 */
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { AssetLockOutput } from "../../shared/asset-db.ts";
import { AssetImportRefusal, assetExtension } from "../../shared/game-assets.ts";
import {
  CELL_PACK_CAPS,
  CELL_PACK_FORMAT,
  CELL_PACK_VERSION,
  CELL_PACK_WORLD_FILE,
  ColliderShape,
  NAV_SOURCE_BIT,
  NavSource,
  TERRAIN_TILE_SAMPLES,
  TERRAIN_TILES_DIR,
  TERRAIN_TILES_FILE,
  TERRAIN_TILES_FORMAT,
  TERRAIN_TILES_VERSION,
  TerrainHeight,
  WORLD_CELL_SIZE_MAX,
  WORLD_CELL_SIZE_MIN,
  WORLD_CELLS_DIR,
  WORLD_CELLS_FORMAT,
  WORLD_CELLS_SUFFIX,
  WORLD_CELLS_VERSION,
  WORLD_EXTENT_MAX,
  WorldCellsCode,
  type WorldCellsRefusal,
} from "../../shared/world-cells.ts";
import { atomicWriteFile, ensureDirBelow } from "../fsx.ts";
import { isSafeAssetPath, readGameAsset } from "./safe-asset.ts";

/** The most bytes of a heightmap image the stage step reads. */
const HEIGHTMAP_BYTES_MAX = 128 * 1024 * 1024;
/** A staged game's assets folder. */
const STAGE_ASSETS_DIR = "assets";
/** The largest placement file, in bytes (refused before it is parsed). */
const WORLD_CELLS_BYTES_MAX = 32 * 1024 * 1024;
/** The most terrain tile bytes one placement file may write. */
const TERRAIN_BYTES_MAX = 256 * 1024 * 1024;
/** The most pixels a heightmap image may have (checked from its header, before decoding). */
const HEIGHTMAP_PIXELS_MAX = 4096 * 4096;
/** How far a rotation's length may be from 1. */
const UNIT_QUATERNION_TOLERANCE = 1e-3;
/** The largest r16 sample. */
const R16_MAX = 65_535;
/** The octaves of the `hills` height function. */
const HILLS_OCTAVES = 4;
/** The largest `u32`. */
const U32_MAX = 0xffff_ffff;
/** The largest grid coordinate a cell may have on either side (cell size 8 m). */
const CELL_COORD_MAX = WORLD_EXTENT_MAX / WORLD_CELL_SIZE_MIN;
/** The extensions a model placement may name. */
const MODEL_EXTENSIONS: ReadonlySet<string> = new Set(["glb", "gltf"]);
/** Where a PNG's width and height sit in its header. */
const PNG_SIZE_AT = 16;
/** The PNG signature. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const TOP_KEYS = ["folder", "bounds", "nav", "terrain", "cells", "things", "models", "colliders", "groups"] as const;
const PLACEMENT_KEYS = ["rotation", "yaw", "scale"] as const;
const CELL_KEYS = ["nav", "things", "models", "colliders", "groups", "far"] as const;

/** One compiled file: its path under `assets/` and its bytes. */
export interface WorldCellsFile {
  path: string;
  bytes: Uint8Array;
}

/** What a compile placed. */
export interface WorldCellsCounts {
  things: number;
  models: number;
  colliders: number;
  instances: number;
}

/** A compiled placement file (files sorted by path), or why it was refused (no files). */
export type WorldCellsCompile =
  | { ok: true; folder: string; files: WorldCellsFile[]; cells: number; tiles: number; counts: WorldCellsCounts }
  | { ok: false; refusal: WorldCellsRefusal };

/** What a compile may read beside the text. */
export interface WorldCellsOptions {
  /** The file's path relative to the game folder (`world/<name>.cells.json`). */
  source: string;
  /** The game's asset paths (`assets/`-relative); when given, a path naming none refuses `world-cells-asset-missing`. */
  assets?: ReadonlySet<string>;
  /** Reads an asset (`assets/`-relative) for a heightmap; null when there is none. */
  readAsset?: (rel: string) => Promise<Uint8Array | null>;
}

/** Thrown inside the compile and returned as its refusal. */
class WorldCellsRefused extends Error {
  readonly code: WorldCellsCode;
  readonly at: string;
  constructor(code: WorldCellsCode, at: string) {
    super(`${code} at ${at}`);
    this.code = code;
    this.at = at;
  }
}

function refuse(code: WorldCellsCode, at: string): never {
  throw new WorldCellsRefused(code, at);
}

const member = (at: string, key: string) => (at ? `${at}.${key}` : key);
const item = (at: string, i: number) => `${at}[${i}]`;

// ---------------------------------------------------------------------------------------------
// JSON reads: each refuses with the location of the value at fault.

type Fields = Record<string, unknown>;

/** An object with every `required` key and no key outside `required` and `optional`. */
function objectAt(value: unknown, at: string, required: readonly string[], optional: readonly string[] = []): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) refuse(WorldCellsCode.Invalid, at);
  const fields = value as Fields;
  const unknown = Object.keys(fields).find((key) => !required.includes(key) && !optional.includes(key));
  if (unknown !== undefined) refuse(WorldCellsCode.Invalid, member(at, unknown));
  const missing = required.find((key) => !Object.hasOwn(fields, key));
  if (missing !== undefined) refuse(WorldCellsCode.Invalid, member(at, missing));
  return fields;
}

/** A number an `f32` holds. */
function numberAt(value: unknown, at: string): number {
  if (typeof value !== "number") refuse(WorldCellsCode.Invalid, at);
  if (!Number.isFinite(Math.fround(value))) refuse(WorldCellsCode.NotFinite, at);
  return value;
}

/** A whole number in `min..=max`. */
function integerAt(value: unknown, at: string, min: number, max: number): number {
  const n = numberAt(value, at);
  if (!Number.isInteger(n) || n < min || n > max) refuse(WorldCellsCode.Invalid, at);
  return n;
}

/** A number above zero, refusing `code` otherwise. */
function positiveAt(value: unknown, at: string, code: WorldCellsCode): number {
  const n = numberAt(value, at);
  if (!(n > 0)) refuse(code, at);
  return n;
}

function arrayAt(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) refuse(WorldCellsCode.Invalid, at);
  return value;
}

/** An optional list: empty when absent. */
const listAt = (value: unknown, at: string): unknown[] => (value === undefined ? [] : arrayAt(value, at));

function numbersAt(value: unknown, at: string, length: number): number[] {
  const values = arrayAt(value, at);
  if (values.length !== length) refuse(WorldCellsCode.Invalid, at);
  return values.map((v, i) => numberAt(v, item(at, i)));
}

const utf8 = new TextEncoder();

/** A safe `assets/`-relative path within the path cap. */
function pathAt(value: unknown, at: string): string {
  if (typeof value !== "string") refuse(WorldCellsCode.Invalid, at);
  if (utf8.encode(value).byteLength > CELL_PACK_CAPS.pathBytesMax) refuse(WorldCellsCode.OverCap, at);
  if (!isSafeAssetPath(value)) refuse(WorldCellsCode.PathUnsafe, at);
  return value;
}

// ---------------------------------------------------------------------------------------------
// The placement model.

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

interface Transform {
  translation: Vec3;
  rotation: Quat;
  scale: Vec3;
}

interface Cell {
  x: number;
  z: number;
}

type Shape =
  | { kind: typeof ColliderShape.Cuboid; half: Vec3 }
  | { kind: typeof ColliderShape.Ball; radius: number }
  | { kind: typeof ColliderShape.Capsule | typeof ColliderShape.Cylinder; halfHeight: number; radius: number }
  | { kind: typeof ColliderShape.Heightfield; x: number; z: number; columns: number | null; rows: number | null };

interface Built {
  cell: Cell;
  nav: number | null;
  things: Array<{ kind: number; transform: Transform; data: string }>;
  colliders: Array<{ shape: Shape; transform: Transform; at: string }>;
  models: Array<{ path: string; transform: Transform }>;
  groups: Array<{ model: string; instances: Transform[] }>;
  instances: number;
  far: string | null;
}

/** What a terrain source answers: a height anywhere and the range every height falls in. */
interface HeightSource {
  height: (x: number, z: number) => number;
  min: number;
  max: number;
}

interface Terrain {
  samples: number;
  source: HeightSource;
  cells: Cell[] | null;
}

/** The compile's state while it reads the file. */
interface Compile {
  options: WorldCellsOptions;
  cellSize: number;
  bounds: { min: Cell; max: Cell } | null;
  cells: Map<string, Built>;
  counts: WorldCellsCounts;
}

const cellKey = (cell: Cell) => `${cell.x},${cell.z}`;
const byCell = (a: Cell, b: Cell) => a.x - b.x || a.z - b.z;

/** The first and last cells of the grid (both inclusive, on both axes), as genex-stream's `Grid` has them. */
function gridCells(cellSize: number): { lo: number; hi: number } {
  return { lo: Math.floor(-WORLD_EXTENT_MAX / cellSize), hi: Math.ceil(WORLD_EXTENT_MAX / cellSize) - 1 };
}

function insideGrid(c: Compile, cell: Cell): boolean {
  const { lo, hi } = gridCells(c.cellSize);
  return cell.x >= lo && cell.x <= hi && cell.z >= lo && cell.z <= hi;
}

function insideBounds(c: Compile, cell: Cell): boolean {
  if (!c.bounds) return insideGrid(c, cell);
  const { min, max } = c.bounds;
  return cell.x >= min.x && cell.x <= max.x && cell.z >= min.z && cell.z <= max.z;
}

/** The cell under a world position, binned on its `f32` value; refuses one outside the world. */
function cellUnder(c: Compile, translation: Vec3, at: string): Cell {
  const [x, , z] = translation.map(Math.fround);
  const inside = (v: number | undefined) => v !== undefined && v >= -WORLD_EXTENT_MAX && v < WORLD_EXTENT_MAX;
  if (!(inside(x) && inside(z))) refuse(WorldCellsCode.OutsideWorld, at);
  const cell = { x: Math.floor(Math.fround((x ?? 0) / c.cellSize)), z: Math.floor(Math.fround((z ?? 0) / c.cellSize)) };
  if (!insideBounds(c, cell)) refuse(WorldCellsCode.OutsideWorld, at);
  return cell;
}

function builtAt(c: Compile, cell: Cell): Built {
  const key = cellKey(cell);
  const known = c.cells.get(key);
  if (known) return known;
  const built: Built = { cell, nav: null, things: [], colliders: [], models: [], groups: [], instances: 0, far: null };
  c.cells.set(key, built);
  return built;
}

// ---------------------------------------------------------------------------------------------
// Placements.

function rotationAt(fields: Fields, at: string): Quat {
  if (fields.rotation !== undefined && fields.yaw !== undefined) refuse(WorldCellsCode.Invalid, member(at, "yaw"));
  if (fields.yaw !== undefined) {
    const half = (numberAt(fields.yaw, member(at, "yaw")) * Math.PI) / 360;
    return [0, Math.sin(half), 0, Math.cos(half)];
  }
  if (fields.rotation === undefined) return [0, 0, 0, 1];
  const q = numbersAt(fields.rotation, member(at, "rotation"), 4) as Quat;
  const length = Math.hypot(...q);
  if (Math.abs(length - 1) > UNIT_QUATERNION_TOLERANCE) refuse(WorldCellsCode.TransformInvalid, member(at, "rotation"));
  return q;
}

function scaleAt(value: unknown, at: string): Vec3 {
  if (value === undefined) return [1, 1, 1];
  if (typeof value === "number") {
    const s = positiveAt(value, at, WorldCellsCode.TransformInvalid);
    return [s, s, s];
  }
  const s = numbersAt(value, at, 3);
  s.forEach((v, i) => {
    if (!(v > 0)) refuse(WorldCellsCode.TransformInvalid, item(at, i));
  });
  return s as Vec3;
}

function transformAt(fields: Fields, at: string): Transform {
  const translation = numbersAt(fields.at, member(at, "at"), 3) as Vec3;
  return { translation, rotation: rotationAt(fields, at), scale: scaleAt(fields.scale, member(at, "scale")) };
}

/** The cell a placement lands in: its own cell (it must stand there), or the cell under it. */
function landing(c: Compile, transform: Transform, at: string, own: Cell | null): Built {
  const cell = cellUnder(c, transform.translation, member(at, "at"));
  if (own && byCell(own, cell) !== 0) refuse(WorldCellsCode.OutsideCell, member(at, "at"));
  return builtAt(c, cell);
}

function modelPathAt(c: Compile, value: unknown, at: string): string {
  const rel = pathAt(value, at);
  if (!MODEL_EXTENSIONS.has(assetExtension(rel))) refuse(WorldCellsCode.NotModel, at);
  if (c.options.assets && !c.options.assets.has(rel)) refuse(WorldCellsCode.AssetMissing, at);
  return rel;
}

function placeThing(c: Compile, value: unknown, at: string, own: Cell | null): void {
  const fields = objectAt(value, at, ["kind", "at"], [...PLACEMENT_KEYS, "data"]);
  const kind = integerAt(fields.kind, member(at, "kind"), 0, U32_MAX);
  const transform = transformAt(fields, at);
  const data = JSON.stringify(fields.data ?? null);
  if (utf8.encode(data).byteLength > CELL_PACK_CAPS.dataBytesMax) refuse(WorldCellsCode.OverCap, member(at, "data"));
  const built = landing(c, transform, at, own);
  if (built.things.length >= CELL_PACK_CAPS.thingsMax) refuse(WorldCellsCode.OverCap, at);
  built.things.push({ kind, transform, data });
  c.counts.things += 1;
}

function placeModel(c: Compile, value: unknown, at: string, own: Cell | null): void {
  const fields = objectAt(value, at, ["model", "at"], PLACEMENT_KEYS);
  const path = modelPathAt(c, fields.model, member(at, "model"));
  const transform = transformAt(fields, at);
  const built = landing(c, transform, at, own);
  if (built.models.length >= CELL_PACK_CAPS.modelsMax) refuse(WorldCellsCode.OverCap, at);
  built.models.push({ path, transform });
  c.counts.models += 1;
}

const SHAPE_KEYS: Readonly<Record<ColliderShape, readonly string[]>> = {
  [ColliderShape.Cuboid]: ["half"],
  [ColliderShape.Ball]: ["radius"],
  [ColliderShape.Capsule]: ["halfHeight", "radius"],
  [ColliderShape.Cylinder]: ["halfHeight", "radius"],
  [ColliderShape.Heightfield]: [],
};
const HEIGHTFIELD_KEYS = ["x", "z", "columns", "rows"] as const;

function shapeOf(fields: Fields, kind: ColliderShape, at: string): Shape {
  const size = (key: string) => positiveAt(fields[key], member(at, key), WorldCellsCode.ShapeInvalid);
  const window = (key: string) =>
    fields[key] === undefined ? null : integerAt(fields[key], member(at, key), 0, TERRAIN_TILE_SAMPLES[3]);
  switch (kind) {
    case ColliderShape.Cuboid: {
      const half = numbersAt(fields.half, member(at, "half"), 3);
      half.forEach((v, i) => {
        if (!(v > 0)) refuse(WorldCellsCode.ShapeInvalid, item(member(at, "half"), i));
      });
      return { kind, half: half as Vec3 };
    }
    case ColliderShape.Ball:
      return { kind, radius: size("radius") };
    case ColliderShape.Capsule:
    case ColliderShape.Cylinder:
      return { kind, halfHeight: size("halfHeight"), radius: size("radius") };
    case ColliderShape.Heightfield:
      return { kind, x: window("x") ?? 0, z: window("z") ?? 0, columns: window("columns"), rows: window("rows") };
  }
}

function colliderShapeAt(value: unknown, at: string): ColliderShape {
  const shapes: readonly unknown[] = Object.values(ColliderShape);
  const shape = objectAt(value, at, ["shape"], Object.keys(value ?? {})).shape;
  if (!shapes.includes(shape)) refuse(WorldCellsCode.Invalid, member(at, "shape"));
  return shape as ColliderShape;
}

function placeCollider(c: Compile, value: unknown, at: string, own: Cell | null): void {
  const kind = colliderShapeAt(value, at);
  const window = kind === ColliderShape.Heightfield ? HEIGHTFIELD_KEYS : [];
  const fields = objectAt(value, at, ["shape", "at", ...SHAPE_KEYS[kind]], [...PLACEMENT_KEYS, ...window]);
  const shape = shapeOf(fields, kind, at);
  const transform = transformAt(fields, at);
  const built = landing(c, transform, at, own);
  if (built.colliders.length >= CELL_PACK_CAPS.collidersMax) refuse(WorldCellsCode.OverCap, at);
  built.colliders.push({ shape, transform, at });
  c.counts.colliders += 1;
}

function placeGroup(c: Compile, value: unknown, at: string, own: Cell | null): void {
  const fields = objectAt(value, at, ["model", "instances"]);
  const model = modelPathAt(c, fields.model, member(at, "model"));
  const perCell = new Map<Built, { model: string; instances: Transform[] }>();
  listAt(fields.instances, member(at, "instances")).forEach((entry, i) => {
    const where = item(member(at, "instances"), i);
    const transform = transformAt(objectAt(entry, where, ["at"], PLACEMENT_KEYS), where);
    const built = landing(c, transform, where, own);
    if (built.instances >= CELL_PACK_CAPS.instancesMax) refuse(WorldCellsCode.OverCap, where);
    let group = perCell.get(built);
    if (!group) {
      if (built.groups.length >= CELL_PACK_CAPS.groupsMax) refuse(WorldCellsCode.OverCap, at);
      group = { model, instances: [] };
      perCell.set(built, group);
      built.groups.push(group);
    }
    group.instances.push(transform);
    built.instances += 1;
    c.counts.instances += 1;
  });
}

type Place = (c: Compile, value: unknown, at: string, own: Cell | null) => void;

/** The placement lists a cell or the file may hold, in the order the compiler reads them. */
const LISTS: ReadonlyArray<readonly [string, Place]> = [
  ["things", placeThing],
  ["models", placeModel],
  ["colliders", placeCollider],
  ["groups", placeGroup],
];

function placeLists(c: Compile, fields: Fields, at: string, own: Cell | null): void {
  for (const [key, place] of LISTS) {
    const where = member(at, key);
    listAt(fields[key], where).forEach((entry, i) => {
      place(c, entry, item(where, i), own);
    });
  }
}

function navAt(value: unknown, at: string): number | null {
  if (value === undefined) return null;
  const sources: readonly unknown[] = Object.values(NavSource);
  return arrayAt(value, at).reduce<number>((bits, source, i) => {
    if (!sources.includes(source)) refuse(WorldCellsCode.Invalid, item(at, i));
    return bits | NAV_SOURCE_BIT[source as NavSource];
  }, 0);
}

function cellRefAt(c: Compile, value: unknown, at: string, keys: readonly string[] = []): Cell {
  const fields = objectAt(value, at, ["x", "z"], keys);
  const cell = {
    x: integerAt(fields.x, member(at, "x"), -CELL_COORD_MAX, CELL_COORD_MAX),
    z: integerAt(fields.z, member(at, "z"), -CELL_COORD_MAX, CELL_COORD_MAX),
  };
  if (!(insideGrid(c, cell) && insideBounds(c, cell))) refuse(WorldCellsCode.OutsideWorld, at);
  return cell;
}

function placeCells(c: Compile, value: unknown): void {
  const seen = new Set<string>();
  listAt(value, "cells").forEach((entry, i) => {
    const at = item("cells", i);
    const cell = cellRefAt(c, entry, at, CELL_KEYS);
    if (seen.has(cellKey(cell))) refuse(WorldCellsCode.CellRepeated, at);
    seen.add(cellKey(cell));
    const fields = entry as Fields;
    const built = builtAt(c, cell);
    built.nav = navAt(fields.nav, member(at, "nav"));
    if (fields.far !== undefined) built.far = modelPathAt(c, fields.far, member(at, "far"));
    placeLists(c, fields, at, cell);
  });
}

// ---------------------------------------------------------------------------------------------
// Terrain.

/** A 32-bit integer hash (lowbias32), for the `hills` phases. */
function hash32(seed: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

function hillsSource(fields: Fields, at: string): HeightSource {
  const level = numberAt(fields.level, member(at, "level"));
  const amplitude = numberAt(fields.amplitude, member(at, "amplitude"));
  if (amplitude < 0) refuse(WorldCellsCode.TerrainInvalid, member(at, "amplitude"));
  const wavelength = positiveAt(fields.wavelength, member(at, "wavelength"), WorldCellsCode.TerrainInvalid);
  const seed = integerAt(fields.seed, member(at, "seed"), 0, U32_MAX);
  // Each octave's axes are turned by a seeded angle, so the hills do not line up with the grid.
  const phase = (k: number) => (hash32(seed * 3 * HILLS_OCTAVES + k) / 2 ** 32) * 2 * Math.PI;
  const octaves = Array.from({ length: HILLS_OCTAVES }, (_, o) => ({
    frequency: (2 * Math.PI * 2 ** o) / wavelength,
    weight: 0.5 ** o,
    px: phase(3 * o),
    pz: phase(3 * o + 1),
    cos: Math.cos(phase(3 * o + 2)),
    sin: Math.sin(phase(3 * o + 2)),
  }));
  const total = octaves.reduce((sum, o) => sum + o.weight, 0);
  const wave = (o: (typeof octaves)[number], x: number, z: number) =>
    Math.sin(o.frequency * (o.cos * x + o.sin * z) + o.px) * Math.sin(o.frequency * (o.cos * z - o.sin * x) + o.pz);
  const height = (x: number, z: number) =>
    level + (amplitude * octaves.reduce((sum, o) => sum + o.weight * wave(o, x, z), 0)) / total;
  return { height, min: level - amplitude, max: level + amplitude };
}

function functionSource(fields: Fields, at: string, area: [Cell, Cell], cellSize: number): HeightSource {
  const kind = fields.function;
  if (kind === TerrainHeight.Flat) {
    const level = numberAt(objectAt(fields, at, ["function", "level"]).level, member(at, "level"));
    return { height: () => level, min: level, max: level };
  }
  if (kind === TerrainHeight.Slope) {
    objectAt(fields, at, ["function", "level", "rise"]);
    const level = numberAt(fields.level, member(at, "level"));
    const [gx = 0, gz = 0] = numbersAt(fields.rise, member(at, "rise"), 2);
    const height = (x: number, z: number) => level + gx * x + gz * z;
    const [lo, hi] = area;
    const xs = [lo.x * cellSize, (hi.x + 1) * cellSize];
    const zs = [lo.z * cellSize, (hi.z + 1) * cellSize];
    const corners = xs.flatMap((x) => zs.map((z) => height(x, z)));
    return { height, min: Math.min(...corners), max: Math.max(...corners) };
  }
  if (kind === TerrainHeight.Hills) {
    objectAt(fields, at, ["function", "level", "amplitude", "wavelength", "seed"]);
    return hillsSource(fields, at);
  }
  return refuse(WorldCellsCode.TerrainInvalid, member(at, "function"));
}

function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signed = PNG_SIGNATURE.every((b, i) => bytes[i] === b);
  if (!signed || bytes.byteLength < PNG_SIZE_AT + 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(PNG_SIZE_AT), height: view.getUint32(PNG_SIZE_AT + 4) };
}

/** A heightmap's first channel, normalized to 0..1 per pixel. */
async function heightmapAt(
  c: Compile,
  rel: string,
  at: string,
): Promise<{ width: number; height: number; v: Float64Array }> {
  if (c.options.assets && !c.options.assets.has(rel)) refuse(WorldCellsCode.AssetMissing, at);
  const bytes = (await c.options.readAsset?.(rel)) ?? null;
  if (!bytes) return refuse(WorldCellsCode.AssetMissing, at);
  const size = pngSize(bytes);
  if (!size || size.width < 2 || size.height < 2) return refuse(WorldCellsCode.TerrainInvalid, at);
  if (size.width * size.height > HEIGHTMAP_PIXELS_MAX) refuse(WorldCellsCode.OverCap, at);
  const { decode } = await import("fast-png");
  let png: ReturnType<typeof decode>;
  try {
    png = decode(bytes);
  } catch {
    return refuse(WorldCellsCode.TerrainInvalid, at);
  }
  const usable =
    !png.palette && (png.depth === 8 || png.depth === 16) && png.data.length >= png.width * png.height * png.channels;
  if (!usable) refuse(WorldCellsCode.TerrainInvalid, at);
  const top = png.depth === 16 ? R16_MAX : 255;
  const v = new Float64Array(png.width * png.height);
  for (let p = 0; p < v.length; p++) v[p] = (png.data[p * png.channels] ?? 0) / top;
  return { width: png.width, height: png.height, v };
}

async function imageSource(c: Compile, fields: Fields, at: string, area: [Cell, Cell]): Promise<HeightSource> {
  objectAt(fields, at, ["image", "low", "high"]);
  const low = numberAt(fields.low, member(at, "low"));
  const high = numberAt(fields.high, member(at, "high"));
  if (!(high > low)) refuse(WorldCellsCode.TerrainInvalid, at);
  const rel = pathAt(fields.image, member(at, "image"));
  const map = await heightmapAt(c, rel, member(at, "image"));
  const [lo, hi] = area;
  const x0 = lo.x * c.cellSize;
  const z0 = lo.z * c.cellSize;
  const width = (hi.x + 1 - lo.x) * c.cellSize;
  const depth = (hi.z + 1 - lo.z) * c.cellSize;
  const pixel = (px: number, pz: number) => map.v[pz * map.width + px] ?? 0;
  const height = (x: number, z: number) => {
    const u = Math.min(Math.max(((x - x0) / width) * (map.width - 1), 0), map.width - 1);
    const w = Math.min(Math.max(((z - z0) / depth) * (map.height - 1), 0), map.height - 1);
    const [ux, wz] = [Math.min(Math.floor(u), map.width - 2), Math.min(Math.floor(w), map.height - 2)];
    const [fu, fw] = [u - ux, w - wz];
    const top = pixel(ux, wz) * (1 - fu) + pixel(ux + 1, wz) * fu;
    const bottom = pixel(ux, wz + 1) * (1 - fu) + pixel(ux + 1, wz + 1) * fu;
    return low + (top * (1 - fw) + bottom * fw) * (high - low);
  };
  return { height, min: low, max: high };
}

function terrainCellsAt(c: Compile, value: unknown, at: string): Cell[] | null {
  if (value === undefined) return null;
  const cells = arrayAt(value, at);
  if (cells.length > CELL_PACK_CAPS.cellsMax) refuse(WorldCellsCode.OverCap, at);
  const seen = new Set<string>();
  return cells.flatMap((entry, i) => {
    const cell = cellRefAt(c, entry, item(at, i));
    if (seen.has(cellKey(cell))) return [];
    seen.add(cellKey(cell));
    return [cell];
  });
}

/** The terrain section with its source read later, once the area is known. */
function terrainAt(c: Compile, value: unknown): { samples: number; height: Fields; cells: Cell[] | null } | null {
  if (value === undefined) return null;
  const fields = objectAt(value, "terrain", ["samples", "height"], ["cells"]);
  const samples = integerAt(fields.samples, "terrain.samples", 0, U32_MAX);
  if (!(TERRAIN_TILE_SAMPLES as readonly number[]).includes(samples))
    refuse(WorldCellsCode.TerrainInvalid, "terrain.samples");
  const height = objectAt(fields.height, "terrain.height", [], Object.keys(fields.height ?? {}));
  return { samples, height, cells: terrainCellsAt(c, fields.cells, "terrain.cells") };
}

async function heightSource(c: Compile, height: Fields, area: [Cell, Cell]): Promise<HeightSource> {
  const at = "terrain.height";
  if (height.image !== undefined) return imageSource(c, height, at, area);
  if (height.function === undefined) refuse(WorldCellsCode.Invalid, member(at, "function"));
  return functionSource(height, at, area, c.cellSize);
}

/** The r16 bytes of one tile. */
function tileBytes(cell: Cell, samples: number, cellSize: number, source: HeightSource): Uint8Array {
  const out = new Uint8Array(samples * samples * 2);
  const view = new DataView(out.buffer);
  const span = source.max - source.min;
  const world = (cellCoord: number, i: number) => ((cellCoord * (samples - 1) + i) * cellSize) / (samples - 1);
  for (let row = 0; row < samples; row++) {
    const z = world(cell.z, row);
    for (let column = 0; column < samples; column++) {
      const h = source.height(world(cell.x, column), z);
      const value = span > 0 ? Math.round(((h - source.min) / span) * R16_MAX) : 0;
      view.setUint16((row * samples + column) * 2, Math.min(Math.max(value, 0), R16_MAX), true);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Bytes.

/** FNV-1a 64 of `bytes` as 16 lowercase hex digits (genex-core `digest::fnv1a64`, `hex64`). */
export function fnv1a64Hex(bytes: Uint8Array): string {
  // Four 16-bit limbs, lowest first: the offset basis cbf29ce484222325; the prime is 2^40 + 0x1b3.
  let [h0, h1, h2, h3] = [0x2325, 0x8422, 0x9ce4, 0xcbf2];
  for (const byte of bytes) {
    h0 ^= byte;
    const t0 = h0 * 0x1b3;
    const t1 = h1 * 0x1b3 + (t0 >>> 16);
    const t2 = h2 * 0x1b3 + (h0 << 8) + (t1 >>> 16);
    const t3 = h3 * 0x1b3 + (h1 << 8) + (t2 >>> 16);
    [h0, h1, h2, h3] = [t0 & 0xffff, t1 & 0xffff, t2 & 0xffff, t3 & 0xffff];
  }
  return [h3, h2, h1, h0].map((limb) => limb.toString(16).padStart(4, "0")).join("");
}

/** A cell body being written (postcard 1.x rules, as `pack.rs` spells them). */
class BodyWriter {
  private bytes = new Uint8Array(256);
  private length = 0;

  private room(n: number): void {
    if (this.length + n <= this.bytes.byteLength) return;
    const grown = new Uint8Array(Math.max(this.bytes.byteLength * 2, this.length + n));
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }

  byte(value: number): void {
    this.room(1);
    this.bytes[this.length++] = value;
  }

  varint(value: number): void {
    let n = value >>> 0;
    while (n >= 0x80) {
      this.byte((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    this.byte(n);
  }

  zigzag(value: number): void {
    this.varint(((value << 1) ^ (value >> 31)) >>> 0);
  }

  f32s(values: readonly number[]): void {
    this.room(values.length * 4);
    const view = new DataView(this.bytes.buffer);
    for (const v of values) {
      view.setFloat32(this.length, v, true);
      this.length += 4;
    }
  }

  text(text: string): void {
    const encoded = utf8.encode(text);
    this.varint(encoded.byteLength);
    this.room(encoded.byteLength);
    this.bytes.set(encoded, this.length);
    this.length += encoded.byteLength;
  }

  transform(t: Transform): void {
    this.f32s([...t.translation, ...t.rotation, ...t.scale]);
  }

  done(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

/** A collider shape's pack tag and fields (a heightfield's window defaults to the rest of its tile). */
function writeShape(w: BodyWriter, shape: Shape, samples: number): void {
  w.varint(Object.values(ColliderShape).indexOf(shape.kind));
  switch (shape.kind) {
    case ColliderShape.Cuboid:
      w.f32s(shape.half);
      break;
    case ColliderShape.Ball:
      w.f32s([shape.radius]);
      break;
    case ColliderShape.Capsule:
    case ColliderShape.Cylinder:
      w.f32s([shape.halfHeight, shape.radius]);
      break;
    case ColliderShape.Heightfield:
      for (const v of [shape.x, shape.z, shape.columns ?? samples - shape.x, shape.rows ?? samples - shape.z]) {
        w.varint(v);
      }
  }
}

/** Refuses a heightfield in a cell without a tile, or a window outside the tile. */
function checkHeightfields(built: Built, samples: number | null): void {
  for (const { shape, at } of built.colliders) {
    if (shape.kind !== ColliderShape.Heightfield) continue;
    if (samples === null) refuse(WorldCellsCode.ShapeInvalid, at);
    const fits = (first: number, count: number | null) => {
      const n = count ?? samples - first;
      return n >= 2 && first + n <= samples;
    };
    if (!(fits(shape.x, shape.columns) && fits(shape.z, shape.rows))) refuse(WorldCellsCode.ShapeInvalid, at);
  }
}

function cellBody(built: Built, terrain: { path: string; samples: number } | null, nav: number): Uint8Array {
  const w = new BodyWriter();
  w.varint(CELL_PACK_VERSION);
  w.zigzag(built.cell.x);
  w.zigzag(built.cell.z);
  w.byte(terrain ? 1 : 0);
  if (terrain) {
    w.text(terrain.path);
    w.varint(terrain.samples);
  }
  w.varint(nav);
  w.varint(built.things.length);
  for (const thing of built.things) {
    w.varint(thing.kind);
    w.transform(thing.transform);
    w.text(thing.data);
  }
  w.varint(built.colliders.length);
  for (const collider of built.colliders) {
    writeShape(w, collider.shape, terrain?.samples ?? 0);
    w.transform(collider.transform);
  }
  w.varint(built.models.length);
  for (const model of built.models) {
    w.text(model.path);
    w.transform(model.transform);
  }
  w.varint(built.groups.length);
  for (const group of built.groups) {
    w.text(group.model);
    w.varint(group.instances.length);
    for (const instance of group.instances) w.transform(instance);
  }
  w.byte(built.far === null ? 0 : 1);
  if (built.far !== null) w.text(built.far);
  return w.done();
}

const cellJson = (cell: Cell) => `{"x":${cell.x},"z":${cell.z}}`;

// ---------------------------------------------------------------------------------------------
// The compile.

/** The pack folder for a source: its own `folder`, or `world/<name>` for `world/<name>.cells.json`. */
function folderOf(source: string, value: unknown): string {
  const sourceOk =
    isSafeAssetPath(source) &&
    source.startsWith(`${WORLD_CELLS_DIR}/`) &&
    source.endsWith(WORLD_CELLS_SUFFIX) &&
    source.length > WORLD_CELLS_DIR.length + 1 + WORLD_CELLS_SUFFIX.length;
  if (!sourceOk) refuse(WorldCellsCode.PathUnsafe, "");
  if (value !== undefined) return pathAt(value, "folder");
  return pathAt(source.slice(0, -WORLD_CELLS_SUFFIX.length), "folder");
}

function boundsAt(c: Compile, value: unknown): { min: Cell; max: Cell } | null {
  if (value === undefined) return null;
  const fields = objectAt(value, "bounds", ["min", "max"]);
  const min = cellRefAt(c, fields.min, "bounds.min");
  const max = cellRefAt(c, fields.max, "bounds.max");
  if (min.x > max.x || min.z > max.z) refuse(WorldCellsCode.OutsideWorld, "bounds");
  return { min, max };
}

function parseText(text: string | Uint8Array): unknown {
  const bytes = typeof text === "string" ? Buffer.byteLength(text) : text.byteLength;
  if (bytes > WORLD_CELLS_BYTES_MAX) refuse(WorldCellsCode.OverCap, "");
  try {
    return JSON.parse(typeof text === "string" ? text : new TextDecoder("utf-8", { fatal: true }).decode(text));
  } catch {
    return refuse(WorldCellsCode.Invalid, "");
  }
}

function headerAt(value: unknown): { fields: Fields; cellSize: number } {
  const fields = objectAt(value, "", ["format", "version", "cellSize"], TOP_KEYS);
  if (fields.format !== WORLD_CELLS_FORMAT) refuse(WorldCellsCode.Invalid, "format");
  if (fields.version !== WORLD_CELLS_VERSION) refuse(WorldCellsCode.Invalid, "version");
  return { fields, cellSize: integerAt(fields.cellSize, "cellSize", WORLD_CELL_SIZE_MIN, WORLD_CELL_SIZE_MAX) };
}

/** The area of the pack: its declared bounds, or the cells that hold something (with the terrain's own). */
function areaOf(c: Compile, terrainCells: Cell[] | null): [Cell, Cell] {
  if (c.bounds) return [c.bounds.min, c.bounds.max];
  const cells = [...c.cells.values()].map((built) => built.cell).concat(terrainCells ?? []);
  if (cells.length === 0)
    return [
      { x: 0, z: 0 },
      { x: 0, z: 0 },
    ];
  const xs = cells.map((cell) => cell.x);
  const zs = cells.map((cell) => cell.z);
  return [
    { x: Math.min(...xs), z: Math.min(...zs) },
    { x: Math.max(...xs), z: Math.max(...zs) },
  ];
}

/** Every cell the terrain covers: its own list, or every cell of the area. */
function terrainCover(samples: number, cells: Cell[] | null, area: [Cell, Cell]): Cell[] {
  const [lo, hi] = area;
  const count = cells ? cells.length : (hi.x - lo.x + 1) * (hi.z - lo.z + 1);
  const tooMany = count > CELL_PACK_CAPS.cellsMax || count * samples * samples * 2 > TERRAIN_BYTES_MAX;
  if (tooMany) refuse(WorldCellsCode.OverCap, "terrain.cells");
  if (cells) return cells;
  const all: Cell[] = [];
  for (let x = lo.x; x <= hi.x; x++) for (let z = lo.z; z <= hi.z; z++) all.push({ x, z });
  return all;
}

async function readTerrain(c: Compile, value: unknown): Promise<{ terrain: Terrain | null; area: [Cell, Cell] }> {
  const section = terrainAt(c, value);
  const area = areaOf(c, section?.cells ?? null);
  if (!section) return { terrain: null, area };
  const cells = terrainCover(section.samples, section.cells, area);
  const source = await heightSource(c, section.height, area);
  for (const cell of cells) builtAt(c, cell);
  return { terrain: { samples: section.samples, source, cells }, area };
}

function terrainFiles(c: Compile, folder: string, terrain: Terrain): WorldCellsFile[] {
  const cells = [...(terrain.cells ?? [])].sort(byCell);
  const tiles = cells.map((cell) => ({
    cell,
    path: `${folder}/${TERRAIN_TILES_DIR}/${cell.x}_${cell.z}.r16`,
    bytes: tileBytes(cell, terrain.samples, c.cellSize, terrain.source),
  }));
  const index = {
    format: TERRAIN_TILES_FORMAT,
    version: TERRAIN_TILES_VERSION,
    cellSize: c.cellSize,
    samples: terrain.samples,
    min: terrain.source.min,
    max: terrain.source.max,
    tiles: tiles.map((tile) => ({ x: tile.cell.x, z: tile.cell.z, fnv: fnv1a64Hex(tile.bytes) })),
  };
  return [
    ...tiles.map(({ path, bytes }) => ({ path, bytes })),
    { path: `${folder}/${TERRAIN_TILES_DIR}/${TERRAIN_TILES_FILE}`, bytes: utf8.encode(JSON.stringify(index)) },
  ];
}

function packFiles(
  c: Compile,
  folder: string,
  terrain: Terrain | null,
  area: [Cell, Cell],
  defaultNav: number,
): WorldCellsFile[] {
  const listed = [...c.cells.values()].sort((a, b) => byCell(a.cell, b.cell));
  if (listed.length > CELL_PACK_CAPS.cellsMax) refuse(WorldCellsCode.OverCap, "");
  const tiled = new Set((terrain?.cells ?? []).map(cellKey));
  const rows: string[] = [];
  const files: WorldCellsFile[] = [];
  for (const built of listed) {
    const tile = tiled.has(cellKey(built.cell)) && terrain ? terrain.samples : null;
    checkHeightfields(built, tile);
    const path = `${folder}/${TERRAIN_TILES_DIR}/${built.cell.x}_${built.cell.z}.r16`;
    const body = cellBody(built, tile === null ? null : { path, samples: tile }, built.nav ?? defaultNav);
    if (body.byteLength > CELL_PACK_CAPS.cellBytesMax) refuse(WorldCellsCode.OverCap, "");
    rows.push(`{"x":${built.cell.x},"z":${built.cell.z},"bytes":${body.byteLength},"fnv":"${fnv1a64Hex(body)}"}`);
    files.push({ path: `${folder}/cells/${built.cell.x}_${built.cell.z}.cell`, bytes: body });
  }
  const world = `{"format":"${CELL_PACK_FORMAT}","version":${CELL_PACK_VERSION},"cellSize":${c.cellSize},"min":${cellJson(area[0])},"max":${cellJson(area[1])},"cells":[${rows.join(",")}]}`;
  const worldBytes = utf8.encode(world);
  if (worldBytes.byteLength > CELL_PACK_CAPS.worldBytesMax) refuse(WorldCellsCode.OverCap, "");
  return [{ path: `${folder}/${CELL_PACK_WORLD_FILE}`, bytes: worldBytes }, ...files];
}

async function compile(text: string | Uint8Array, options: WorldCellsOptions): Promise<WorldCellsCompile> {
  const { fields, cellSize } = headerAt(parseText(text));
  const counts = { things: 0, models: 0, colliders: 0, instances: 0 };
  const c: Compile = { options, cellSize, bounds: null, cells: new Map(), counts };
  const folder = folderOf(options.source, fields.folder);
  c.bounds = boundsAt(c, fields.bounds);
  const defaultNav = navAt(fields.nav, "nav") ?? 0;
  placeCells(c, fields.cells);
  placeLists(c, fields, "", null);
  const { terrain, area } = await readTerrain(c, fields.terrain);
  const files = [
    ...packFiles(c, folder, terrain, area, defaultNav),
    ...(terrain ? terrainFiles(c, folder, terrain) : []),
  ];
  files.sort((a, b) => (a.path < b.path ? -1 : Number(a.path > b.path)));
  const tiles = terrain?.cells?.length ?? 0;
  return { ok: true, folder, files, cells: c.cells.size, tiles, counts };
}

/**
 * Compile one placement file into its pack folder's files (`assets/`-relative, sorted by path):
 * `world.json`, `cells/<x>_<z>.cell` and, with a terrain, `terrain/<x>_<z>.r16` and
 * `terrain/terrain.json`. Never throws for the file's sake: a refusal names its code and location
 * and carries no files.
 */
export async function compileWorldCells(
  text: string | Uint8Array,
  options: WorldCellsOptions,
): Promise<WorldCellsCompile> {
  try {
    return await compile(text, options);
  } catch (error) {
    if (error instanceof WorldCellsRefused) return { ok: false, refusal: { code: error.code, at: error.at } };
    if (error instanceof RangeError) return { ok: false, refusal: { code: WorldCellsCode.Invalid, at: "" } };
    throw error;
  }
}

/** The lock's outputs for a compiled placement: each file's stage path (`assets/...`), sha256 and size. */
export function worldCellsLockOutputs(result: Extract<WorldCellsCompile, { ok: true }>): AssetLockOutput[] {
  return result.files.map((file) => ({
    file: `assets/${file.path}`,
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
    bytes: file.bytes.byteLength,
  }));
}

/** One placement file of a staged game, compiled into the stage or refused (nothing written). */
export interface StagedWorldCells {
  /** The file's path relative to the game (`world/<name>.cells.json`). */
  source: string;
  /** The placement file's sha256 (its lock row's). */
  sha256: string;
  /** The pack folder under `assets/`, when compiled. */
  folder?: string;
  /** What it wrote, as the lock records it (stage paths), when compiled. */
  outputs?: AssetLockOutput[];
  refusal?: WorldCellsRefusal;
}

/** The `world/*.cells.json` files of a stage: regular files only (a link is never followed), sorted. */
async function placementFiles(stage: string): Promise<string[]> {
  const entries = await readdir(path.join(stage, WORLD_CELLS_DIR), { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(WORLD_CELLS_SUFFIX))
    .map((entry) => `${WORLD_CELLS_DIR}/${entry.name}`)
    .sort((a, b) => (a < b ? -1 : Number(a > b)));
}

/** Writes a compiled pack under the stage's `assets/`, never through a link planted on the way. */
async function writeCompiled(stage: string, files: readonly WorldCellsFile[]): Promise<void> {
  for (const file of files) {
    const parts = file.path.split("/");
    const dir = await ensureDirBelow(stage, [STAGE_ASSETS_DIR, ...parts.slice(0, -1)]);
    await atomicWriteFile(path.join(dir, parts.at(-1) ?? ""), file.bytes);
  }
}

/** Why a compiled folder may not be written: another file's, or one holding the game's own assets. */
function folderTaken(folder: string, taken: ReadonlySet<string>, assets: ReadonlySet<string>): boolean {
  const nested = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  return [...taken].some((other) => nested(folder, other)) || [...assets].some((rel) => rel.startsWith(`${folder}/`));
}

async function stageOne(
  stage: string,
  source: string,
  assets: ReadonlySet<string>,
  taken: Set<string>,
): Promise<StagedWorldCells> {
  const read = await readGameAsset(stage, source, WORLD_CELLS_BYTES_MAX);
  if (!read.ok) {
    const code = read.refusal === AssetImportRefusal.TooLarge ? WorldCellsCode.OverCap : WorldCellsCode.PathUnsafe;
    return { source, sha256: "", refusal: { code, at: "" } };
  }
  const sha256 = createHash("sha256").update(read.bytes).digest("hex");
  const readAsset = async (rel: string) => {
    const image = await readGameAsset(stage, `${STAGE_ASSETS_DIR}/${rel}`, HEIGHTMAP_BYTES_MAX);
    return image.ok ? new Uint8Array(image.bytes) : null;
  };
  const result = await compileWorldCells(new Uint8Array(read.bytes), { source, assets, readAsset });
  if (!result.ok) return { source, sha256, refusal: result.refusal };
  if (folderTaken(result.folder, taken, assets))
    return { source, sha256, refusal: { code: WorldCellsCode.FolderTaken, at: "folder" } };
  taken.add(result.folder);
  await writeCompiled(stage, result.files);
  return { source, sha256, folder: result.folder, outputs: worldCellsLockOutputs(result) };
}

/**
 * The import step's placement pass over a staged game: every `world/*.cells.json` compiled, in
 * path order, into its pack folder under the stage's `assets/`. `assets` are the game's own asset
 * paths (`assets/`-relative), which placements may name and a pack folder may not hold. A refused
 * file writes nothing; the others still compile.
 */
export async function stageWorldCells(stage: string, assets: ReadonlySet<string>): Promise<StagedWorldCells[]> {
  const taken = new Set<string>();
  const rows: StagedWorldCells[] = [];
  for (const source of await placementFiles(stage)) rows.push(await stageOne(stage, source, assets, taken));
  return rows;
}
