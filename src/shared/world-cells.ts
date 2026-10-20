/**
 * World placement (`world/*.cells.json`): the small JSON an agent writes to place a big world, and
 * what the host compiles it into. Types and vocabularies only; the compiler is
 * `substrate/asset-import/world-cells.ts`. Browser-safe.
 *
 * A placement file names its cell grid and lists what stands in it, either per cell (`cells`) or
 * as world-space lists (`things`, `models`, `colliders`, `groups`) that the compiler bins into
 * cells by each placement's position. It also holds one terrain source (an image or a named
 * height function) and which cells get a tile of it. The import step compiles it into a cell pack
 * v1 folder under `assets/` (`world.json` and `cells/<x>_<z>.cell`, the format genex-stream's
 * `pack.rs` reads and `tests/fixtures/stream/cell-pack-v1.json` holds) plus r16 terrain tiles
 * (`terrain/<x>_<z>.r16` and `terrain/terrain.json`) in that folder. Anything it cannot place is
 * refused with a {@link WorldCellsCode} and the JSON location, and nothing is written.
 */

/** A placement file's `format` value. */
export const WORLD_CELLS_FORMAT = "genex-world-cells";
/** The placement format version this host compiles. */
export const WORLD_CELLS_VERSION = 1;
/** Where placement files sit, relative to the game folder. */
export const WORLD_CELLS_DIR = "world";
/** A placement file's name ends with this. */
export const WORLD_CELLS_SUFFIX = ".cells.json";

/** The cell pack format version the compiler writes (genex-stream `PACK_VERSION`). */
export const CELL_PACK_VERSION = 1;
/** `world.json`'s `format` value (genex-stream `PACK_FORMAT`). */
export const CELL_PACK_FORMAT = "genex-cell-pack";
/** A pack's world file (genex-stream `PACK_WORLD_FILE`). */
export const CELL_PACK_WORLD_FILE = "world.json";
/** A pack's terrain tiles folder, inside the pack folder. */
export const TERRAIN_TILES_DIR = "terrain";
/** The terrain tiles' index, inside {@link TERRAIN_TILES_DIR}. */
export const TERRAIN_TILES_FILE = "terrain.json";
/** `terrain.json`'s `format` value. */
export const TERRAIN_TILES_FORMAT = "genex-terrain-tiles";
/** The terrain tiles format version. */
export const TERRAIN_TILES_VERSION = 1;

/**
 * The cell pack v1 caps, a typed copy of genex-stream `pack.rs`'s (the `CellBuild` caps), held to
 * the shared fixture's `caps` by `world-cells.test.ts`.
 */
export const CELL_PACK_CAPS = {
  worldBytesMax: 8 * 1024 * 1024,
  cellBytesMax: 16 * 1024 * 1024,
  cellsMax: 65_536,
  thingsMax: 4_096,
  collidersMax: 4_096,
  modelsMax: 1_024,
  groupsMax: 256,
  instancesMax: 65_536,
  pathBytesMax: 256,
  dataBytesMax: 4_096,
} as const;

/** The samples per side a terrain tile may have (tile side = cell size; genex-stream `TERRAIN_TILE_SAMPLES`). */
export const TERRAIN_TILE_SAMPLES = [65, 129, 257, 513] as const;
/** The smallest cell side, in metres (genex-stream `STREAM_CELL_SIZE_MIN`). */
export const WORLD_CELL_SIZE_MIN = 8;
/** The largest cell side, in metres (genex-stream `STREAM_CELL_SIZE_MAX`). */
export const WORLD_CELL_SIZE_MAX = 1024;
/** The world is the square `-extent <= x, z < extent` metres (genex-stream `STREAM_WORLD_EXTENT_MAX`). */
export const WORLD_EXTENT_MAX = 8192;

/** A collider shape, in its pack tag order (genex-stream `ColliderShapeKind::ALL`). Wire values: never rename one. */
export const ColliderShape = {
  /** A box by its half extents (`half`). */
  Cuboid: "cuboid",
  /** A sphere (`radius`). */
  Ball: "ball",
  /** A Y-axis capsule (`halfHeight`, `radius`). */
  Capsule: "capsule",
  /** A Y-axis cylinder (`halfHeight`, `radius`). */
  Cylinder: "cylinder",
  /** A window of the cell's terrain tile in samples (`x`, `z`, `columns`, `rows`; the whole tile by default). */
  Heightfield: "heightfield",
} as const;
export type ColliderShape = (typeof ColliderShape)[keyof typeof ColliderShape];

/** What a cell's nav island is built from. Wire values: never rename one. */
export const NavSource = {
  Colliders: "colliders",
  Terrain: "terrain",
} as const;
export type NavSource = (typeof NavSource)[keyof typeof NavSource];

/** Each nav source's bit in a cell body's `nav` field (genex-stream `NavSource::bit`). */
export const NAV_SOURCE_BIT = { colliders: 1, terrain: 2 } as const satisfies Record<NavSource, number>;

/** A named height function a terrain source may use. Wire values: never rename one. */
export const TerrainHeight = {
  /** `level` everywhere. */
  Flat: "flat",
  /** `level + rise[0] * x + rise[1] * z`. */
  Slope: "slope",
  /** Rolling hills: `level` plus up to `amplitude`, features about `wavelength` metres apart, from `seed`. */
  Hills: "hills",
} as const;
export type TerrainHeight = (typeof TerrainHeight)[keyof typeof TerrainHeight];

/** Why a placement file was refused (nothing was written). Wire values: never rename one. */
export const WorldCellsCode = {
  /** Not JSON, not the v1 shape, an unknown or missing key, or a value of the wrong type. */
  Invalid: "world-cells-invalid",
  /** A placement or cell outside the world (or outside the file's own `bounds`). */
  OutsideWorld: "world-cells-outside-world",
  /** A placement listed under a cell whose position is in another cell. */
  OutsideCell: "world-cells-outside-cell",
  /** The same cell listed twice under `cells`. */
  CellRepeated: "world-cells-cell-repeated",
  /** A path that is not a safe `assets/`-relative path (it escapes `assets/`). */
  PathUnsafe: "world-cells-path-unsafe",
  /** A model path that is not a glTF (`.glb` or `.gltf`). */
  NotModel: "world-cells-not-model",
  /** A path that names no asset of the game. */
  AssetMissing: "world-cells-asset-missing",
  /** A number that is NaN, infinite or past what an `f32` holds. */
  NotFinite: "world-cells-not-finite",
  /** A rotation that is not a unit quaternion, or a scale that is not positive. */
  TransformInvalid: "world-cells-transform-invalid",
  /** A collider size that is not positive, or a heightfield outside its cell's terrain tile. */
  ShapeInvalid: "world-cells-shape-invalid",
  /** An unknown height function, a range that is not ordered, or an image that is not a heightmap. */
  TerrainInvalid: "world-cells-terrain-invalid",
  /** A pack folder another placement file compiles into, or one that already holds the game's own assets. */
  FolderTaken: "world-cells-folder-taken",
  /** More than a cell pack holds (the {@link CELL_PACK_CAPS}), or a file, text or terrain over its cap. */
  OverCap: "world-cells-over-cap",
} as const;
export type WorldCellsCode = (typeof WorldCellsCode)[keyof typeof WorldCellsCode];

/** A refused placement file: the code and where (`cells[0].colliders[1].radius`). */
export interface WorldCellsRefusal {
  code: WorldCellsCode;
  /** The JSON location of the value at fault; empty for the whole file. */
  at: string;
}

/** A cell by its grid coordinates (cell `x` covers `x * cellSize <= world x < (x + 1) * cellSize`). */
export interface WorldCellRef {
  x: number;
  z: number;
}

/** Where something stands: world metres, and an optional rotation (or yaw) and scale. */
export interface WorldPlacement {
  /** World position x, y, z, metres. */
  at: [number, number, number];
  /** A unit quaternion x, y, z, w; not with `yaw`. */
  rotation?: [number, number, number, number];
  /** Degrees about +Y; not with `rotation`. */
  yaw?: number;
  /** One positive factor, or one per axis. */
  scale?: number | [number, number, number];
}

/** A thing the game spawns when its cell enters: its own kind number and any JSON. */
export interface WorldThing extends WorldPlacement {
  kind: number;
  data?: unknown;
}

/** One model drawn while its cell is resident. */
export interface WorldModel extends WorldPlacement {
  /** The model's path under `assets/` (`.glb` or `.gltf`). */
  model: string;
}

/** A static collider. */
export type WorldCollider = WorldPlacement &
  (
    | { shape: typeof ColliderShape.Cuboid; half: [number, number, number] }
    | { shape: typeof ColliderShape.Ball; radius: number }
    | { shape: typeof ColliderShape.Capsule | typeof ColliderShape.Cylinder; halfHeight: number; radius: number }
    | { shape: typeof ColliderShape.Heightfield; x?: number; z?: number; columns?: number; rows?: number }
  );

/** One model drawn many times; binned per instance. */
export interface WorldGroup {
  model: string;
  instances: WorldPlacement[];
}

/** What one cell holds, with its positions inside that cell. */
export interface WorldCell extends WorldCellRef {
  /** What the cell's nav island is built from; none by default. */
  nav?: NavSource[];
  things?: WorldThing[];
  models?: WorldModel[];
  colliders?: WorldCollider[];
  groups?: WorldGroup[];
  /** The model drawn past the detail radius (its HLOD). */
  far?: string;
}

/** A terrain source: a named height function with its parameters, or a heightmap image. */
export type WorldTerrainHeight =
  | { function: typeof TerrainHeight.Flat; level: number }
  | { function: typeof TerrainHeight.Slope; level: number; rise: [number, number] }
  | { function: typeof TerrainHeight.Hills; level: number; amplitude: number; wavelength: number; seed: number }
  /** A PNG under `assets/` stretched over the terrain cells: black is `low` metres, white `high`. */
  | { image: string; low: number; high: number };

/** The terrain: tile samples, its source, and the cells that get a tile (every cell in `bounds` by default). */
export interface WorldTerrain {
  samples: (typeof TERRAIN_TILE_SAMPLES)[number];
  height: WorldTerrainHeight;
  cells?: WorldCellRef[];
}

/** A whole placement file. */
export interface WorldCellsSource {
  format: typeof WORLD_CELLS_FORMAT;
  version: typeof WORLD_CELLS_VERSION;
  /** Cell side, whole metres in {@link WORLD_CELL_SIZE_MIN}..={@link WORLD_CELL_SIZE_MAX}. */
  cellSize: number;
  /** The pack folder under `assets/`; `world/<name>` for `world/<name>.cells.json` by default. */
  folder?: string;
  /** The inclusive cells of the world; the cells that hold something by default. */
  bounds?: { min: WorldCellRef; max: WorldCellRef };
  /** The nav sources of every listed cell that names none. */
  nav?: NavSource[];
  terrain?: WorldTerrain;
  cells?: WorldCell[];
  things?: WorldThing[];
  models?: WorldModel[];
  colliders?: WorldCollider[];
  groups?: WorldGroup[];
}
