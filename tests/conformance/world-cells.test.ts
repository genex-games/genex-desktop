import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  compileWorldCells,
  fnv1a64Hex,
  stageWorldCells,
  type WorldCellsCompile,
  worldCellsLockOutputs,
} from "../../src/substrate/asset-import/world-cells.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { importStagedAssets } from "../../src/main/rust-assets.ts";
import {
  CELL_PACK_CAPS,
  CELL_PACK_FORMAT,
  CELL_PACK_VERSION,
  ColliderShape,
  NAV_SOURCE_BIT,
  TERRAIN_TILE_SAMPLES,
  TERRAIN_TILES_FORMAT,
  WorldCellsCode,
} from "../../src/shared/world-cells.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const FIXTURES = path.join(ROOT, "tests/fixtures/world");
const PACK_FIXTURE = path.join(ROOT, "tests/fixtures/stream/cell-pack-v1.json");

interface PackFixture {
  codes: string[];
  caps: Record<string, number>;
  terrainSamples: number[];
  colliderShapes: string[];
  navSources: Record<string, number>;
  world: string;
  cells: Array<{ file: string; hex: string }>;
}

const packFixture = async (): Promise<PackFixture> => JSON.parse(await readFile(PACK_FIXTURE, "utf8")) as PackFixture;
const fixtureText = (name: string) => readFile(path.join(FIXTURES, name), "utf8");

/** The assets the fixtures name, as an inventory would list them. */
const FIXTURE_ASSETS: ReadonlySet<string> = new Set([
  "models/house.glb",
  "models/rock.glb",
  "models/hlod/-1_0.glb",
  "models/mill.glb",
  "models/well.glb",
  "models/tree.glb",
]);

function compiled(result: WorldCellsCompile): Extract<WorldCellsCompile, { ok: true }> {
  if (!result.ok) assert.fail(`refused ${result.refusal.code} at ${result.refusal.at}`);
  return result;
}

const fileOf = (result: Extract<WorldCellsCompile, { ok: true }>, rel: string) =>
  result.files.find((file) => file.path === rel);

/** A minimal valid placement file, with `patch` merged over it. */
function placement(patch: Record<string, unknown>): string {
  return JSON.stringify({ format: "genex-world-cells", version: 1, cellSize: 64, ...patch });
}

describe("world-cells: contract with genex-stream's cell pack v1", () => {
  it("holds the same caps, tile sizes, collider tags and nav bits as the shared pack fixture", async () => {
    const fixture = await packFixture();
    assert.deepEqual(fixture.caps, { ...CELL_PACK_CAPS });
    assert.deepEqual(fixture.terrainSamples, [...TERRAIN_TILE_SAMPLES]);
    assert.deepEqual(fixture.colliderShapes, Object.values(ColliderShape));
    assert.deepEqual(fixture.navSources, { ...NAV_SOURCE_BIT });
  });

  it("compiles the pack fixture's placement into the fixture's bytes exactly (world.json and every cell)", async () => {
    const fixture = await packFixture();
    const result = compiled(
      await compileWorldCells(await fixtureText("pack-v1.cells.json"), {
        source: "world/pack-v1.cells.json",
        assets: FIXTURE_ASSETS,
      }),
    );
    assert.equal(result.folder, "world");
    assert.equal(new TextDecoder().decode(fileOf(result, "world/world.json")?.bytes), fixture.world);
    const cells = result.files.filter((file) => file.path.startsWith("world/cells/"));
    assert.deepEqual(
      cells.map((file) => file.path),
      fixture.cells.map((cell) => `world/${cell.file}`),
    );
    for (const cell of fixture.cells) {
      assert.equal(Buffer.from(fileOf(result, `world/${cell.file}`)?.bytes ?? []).toString("hex"), cell.hex, cell.file);
    }
  });

  it("writes the fixture cell's r16 tile and the terrain index the tile path names", async () => {
    const result = compiled(
      await compileWorldCells(await fixtureText("pack-v1.cells.json"), { source: "world/pack-v1.cells.json" }),
    );
    const tile = fileOf(result, "world/terrain/-1_0.r16");
    assert.equal(tile?.bytes.byteLength, 65 * 65 * 2);
    const index = JSON.parse(new TextDecoder().decode(fileOf(result, "world/terrain/terrain.json")?.bytes));
    assert.deepEqual(index, {
      format: TERRAIN_TILES_FORMAT,
      version: 1,
      cellSize: 64,
      samples: 65,
      min: 0,
      max: 0,
      tiles: [{ x: -1, z: 0, fnv: fnv1a64Hex(tile?.bytes ?? new Uint8Array()) }],
    });
    assert.deepEqual(
      result.files.map((file) => file.path),
      [...result.files.map((file) => file.path)].sort(),
    );
  });

  it("gives equal bytes on two compiles (FNV-1a 64 of every file)", async () => {
    const text = await fixtureText("valley.cells.json");
    const once = compiled(await compileWorldCells(text, { source: "world/valley.cells.json", assets: FIXTURE_ASSETS }));
    const twice = compiled(
      await compileWorldCells(text, { source: "world/valley.cells.json", assets: FIXTURE_ASSETS }),
    );
    const digests = (result: typeof once) => result.files.map((file) => [file.path, fnv1a64Hex(file.bytes)]);
    assert.deepEqual(digests(once), digests(twice));
    assert.ok(once.files.length > 16, "the valley lists every terrain cell");
  });
});

describe("world-cells: binning and terrain", () => {
  it("bins world-space lists into the cell under each position and splits a group per cell", async () => {
    const result = compiled(
      await compileWorldCells(await fixtureText("valley.cells.json"), {
        source: "world/valley.cells.json",
        assets: FIXTURE_ASSETS,
      }),
    );
    assert.equal(result.folder, "world/valley");
    const world = JSON.parse(new TextDecoder().decode(fileOf(result, "world/valley/world.json")?.bytes));
    assert.equal(world.format, CELL_PACK_FORMAT);
    assert.equal(world.version, CELL_PACK_VERSION);
    assert.deepEqual(
      [world.min, world.max],
      [
        { x: -2, z: -2 },
        { x: 1, z: 1 },
      ],
    );
    assert.equal(world.cells.length, 16, "every cell of the bounds has a tile, so every cell is listed");
    assert.equal(result.cells, 16);
    assert.equal(result.tiles, 16);
    assert.deepEqual(result.counts, { things: 2, models: 2, colliders: 2, instances: 5 });
  });

  it("tile borders share bit-equal samples with their neighbours", async () => {
    const result = compiled(
      await compileWorldCells(await fixtureText("valley.cells.json"), {
        source: "world/valley.cells.json",
        assets: FIXTURE_ASSETS,
      }),
    );
    const samples = 65;
    const tile = (x: number, z: number) => {
      const bytes = fileOf(result, `world/valley/terrain/${x}_${z}.r16`)?.bytes;
      assert.ok(bytes, `${x}_${z}`);
      return new Uint16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    };
    const west = tile(-1, 0);
    const east = tile(0, 0);
    for (let row = 0; row < samples; row++) {
      assert.equal(west[row * samples + samples - 1], east[row * samples], `row ${row}`);
    }
    const south = tile(0, -1);
    for (let column = 0; column < samples; column++) {
      assert.equal(south[(samples - 1) * samples + column], east[column], `column ${column}`);
    }
    const distinct = new Set(east);
    assert.ok(distinct.size > 100, "hills are not flat");
  });

  it("stretches a 16-bit heightmap over the terrain cells (black is low, white high)", async () => {
    const { encode } = await import("fast-png");
    const width = 3;
    const data = new Uint16Array([0, 32768, 65535, 0, 32768, 65535, 0, 32768, 65535]);
    const png = encode({ width, height: 3, data, channels: 1, depth: 16 });
    const text = placement({
      folder: "world/map",
      terrain: { samples: 65, height: { image: "terrain/height.png", low: -10, high: 30 }, cells: [{ x: 0, z: 0 }] },
    });
    const result = compiled(
      await compileWorldCells(text, {
        source: "world/map.cells.json",
        readAsset: async (rel) => (rel === "terrain/height.png" ? png : null),
      }),
    );
    const bytes = fileOf(result, "world/map/terrain/0_0.r16")?.bytes ?? new Uint8Array();
    const tile = new Uint16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    assert.deepEqual([tile[0], tile[32], tile[64]], [0, 32768, 65535]);
    const index = JSON.parse(new TextDecoder().decode(fileOf(result, "world/map/terrain/terrain.json")?.bytes));
    assert.deepEqual([index.min, index.max], [-10, 30]);
  });

  it("lists the lock outputs of every file with its stage path, sha256 and size", async () => {
    const result = compiled(
      await compileWorldCells(await fixtureText("pack-v1.cells.json"), { source: "world/pack-v1.cells.json" }),
    );
    const outputs = worldCellsLockOutputs(result);
    assert.equal(outputs.length, result.files.length);
    assert.equal(outputs[0]?.file.startsWith("assets/world/"), true);
    assert.match(outputs[0]?.sha256 ?? "", /^[0-9a-f]{64}$/);
  });
});

/** One cell with one entry of `kind`, for the hostile table. */
const oneCell = (entry: Record<string, unknown>) => placement({ cells: [{ x: 0, z: 0, ...entry }] });

const HOSTILE: Array<{ name: string; text: string; code: WorldCellsCode; at?: string }> = [
  { name: "not JSON", text: "{", code: WorldCellsCode.Invalid, at: "" },
  { name: "another format", text: placement({ format: "x" }), code: WorldCellsCode.Invalid, at: "format" },
  { name: "another version", text: placement({ version: 2 }), code: WorldCellsCode.Invalid, at: "version" },
  { name: "an unknown key", text: placement({ cels: [] }), code: WorldCellsCode.Invalid, at: "cels" },
  { name: "a cell size off the grid", text: placement({ cellSize: 7 }), code: WorldCellsCode.Invalid, at: "cellSize" },
  {
    name: "a placement outside the world",
    text: placement({ things: [{ kind: 1, at: [9000, 0, 0] }] }),
    code: WorldCellsCode.OutsideWorld,
    at: "things[0].at",
  },
  {
    name: "a placement outside the declared bounds",
    text: placement({
      bounds: { min: { x: 0, z: 0 }, max: { x: 0, z: 0 } },
      models: [{ model: "m.glb", at: [-1, 0, 1] }],
    }),
    code: WorldCellsCode.OutsideWorld,
    at: "models[0].at",
  },
  {
    name: "a cell outside the world",
    text: placement({ cells: [{ x: 200, z: 0 }] }),
    code: WorldCellsCode.OutsideWorld,
    at: "cells[0]",
  },
  {
    name: "a per-cell placement in another cell",
    text: oneCell({ things: [{ kind: 1, at: [70, 0, 1] }] }),
    code: WorldCellsCode.OutsideCell,
    at: "cells[0].things[0].at",
  },
  {
    name: "a cell listed twice",
    text: placement({
      cells: [
        { x: 0, z: 0 },
        { x: 0, z: 0 },
      ],
    }),
    code: WorldCellsCode.CellRepeated,
    at: "cells[1]",
  },
  {
    name: "a model path that escapes assets/",
    text: placement({ models: [{ model: "../secrets/x.glb", at: [1, 0, 1] }] }),
    code: WorldCellsCode.PathUnsafe,
    at: "models[0].model",
  },
  {
    name: "an absolute model path",
    text: placement({ groups: [{ model: "/etc/x.glb", instances: [] }] }),
    code: WorldCellsCode.PathUnsafe,
    at: "groups[0].model",
  },
  {
    name: "a backslash far path",
    text: oneCell({ far: "models\\..\\x.glb" }),
    code: WorldCellsCode.PathUnsafe,
    at: "cells[0].far",
  },
  {
    name: "a model that is not a glTF",
    text: placement({ models: [{ model: "textures/a.png", at: [1, 0, 1] }] }),
    code: WorldCellsCode.NotModel,
    at: "models[0].model",
  },
  {
    name: "a model the game does not have",
    text: placement({ models: [{ model: "models/ghost.glb", at: [1, 0, 1] }] }),
    code: WorldCellsCode.AssetMissing,
    at: "models[0].model",
  },
  {
    name: "a collider radius of 1e999 (NaN and infinity have no JSON spelling)",
    text: oneCell({ colliders: [{ shape: "ball", radius: "INF", at: [1, 0, 1] }] }).replace('"INF"', "1e999"),
    code: WorldCellsCode.NotFinite,
    at: "cells[0].colliders[0].radius",
  },
  {
    name: "a collider half extent past f32",
    text: oneCell({ colliders: [{ shape: "cuboid", half: [1, 1e39, 1], at: [1, 0, 1] }] }),
    code: WorldCellsCode.NotFinite,
    at: "cells[0].colliders[0].half[1]",
  },
  {
    name: "a collider position that is a string NaN",
    text: oneCell({ colliders: [{ shape: "ball", radius: 1, at: [1, "NaN", 1] }] }),
    code: WorldCellsCode.Invalid,
    at: "cells[0].colliders[0].at[1]",
  },
  {
    name: "a zero collider radius",
    text: oneCell({ colliders: [{ shape: "capsule", halfHeight: 1, radius: 0, at: [1, 0, 1] }] }),
    code: WorldCellsCode.ShapeInvalid,
    at: "cells[0].colliders[0].radius",
  },
  {
    name: "a heightfield in a cell without terrain",
    text: oneCell({ colliders: [{ shape: "heightfield", at: [0, 0, 0] }] }),
    code: WorldCellsCode.ShapeInvalid,
    at: "cells[0].colliders[0]",
  },
  {
    name: "a heightfield window past its tile",
    text: placement({
      terrain: { samples: 65, height: { function: "flat", level: 0 } },
      bounds: { min: { x: 0, z: 0 }, max: { x: 0, z: 0 } },
      colliders: [{ shape: "heightfield", x: 60, columns: 8, at: [0, 0, 0] }],
    }),
    code: WorldCellsCode.ShapeInvalid,
    at: "colliders[0]",
  },
  {
    name: "a rotation that is not a unit quaternion",
    text: placement({ things: [{ kind: 1, at: [1, 0, 1], rotation: [0, 2, 0, 1] }] }),
    code: WorldCellsCode.TransformInvalid,
    at: "things[0].rotation",
  },
  {
    name: "both a rotation and a yaw",
    text: placement({ things: [{ kind: 1, at: [1, 0, 1], rotation: [0, 0, 0, 1], yaw: 3 }] }),
    code: WorldCellsCode.Invalid,
    at: "things[0].yaw",
  },
  {
    name: "a negative scale",
    text: placement({ things: [{ kind: 1, at: [1, 0, 1], scale: -1 }] }),
    code: WorldCellsCode.TransformInvalid,
    at: "things[0].scale",
  },
  {
    name: "a thing kind that is not a u32",
    text: placement({ things: [{ kind: -1, at: [1, 0, 1] }] }),
    code: WorldCellsCode.Invalid,
    at: "things[0].kind",
  },
  {
    name: "an unknown height function",
    text: placement({ terrain: { samples: 65, height: { function: "mountains", level: 0 } } }),
    code: WorldCellsCode.TerrainInvalid,
    at: "terrain.height.function",
  },
  {
    name: "a terrain sample count that is not a tile size",
    text: placement({ terrain: { samples: 64, height: { function: "flat", level: 0 } } }),
    code: WorldCellsCode.TerrainInvalid,
    at: "terrain.samples",
  },
  {
    name: "an image range that is not ordered",
    text: placement({ terrain: { samples: 65, height: { image: "h.png", low: 5, high: 5 } } }),
    code: WorldCellsCode.TerrainInvalid,
    at: "terrain.height",
  },
  {
    name: "a heightmap the game does not have",
    text: placement({ terrain: { samples: 65, height: { image: "h.png", low: 0, high: 5 } } }),
    code: WorldCellsCode.AssetMissing,
    at: "terrain.height.image",
  },
  {
    name: "an unknown nav source",
    text: oneCell({ nav: ["water"] }),
    code: WorldCellsCode.Invalid,
    at: "cells[0].nav[0]",
  },
  {
    name: "thing data over the cap",
    text: placement({ things: [{ kind: 1, at: [1, 0, 1], data: "x".repeat(CELL_PACK_CAPS.dataBytesMax) }] }),
    code: WorldCellsCode.OverCap,
    at: "things[0].data",
  },
  {
    name: "a path over the cap",
    text: placement({ models: [{ model: `${"m".repeat(CELL_PACK_CAPS.pathBytesMax)}.glb`, at: [1, 0, 1] }] }),
    code: WorldCellsCode.OverCap,
    at: "models[0].model",
  },
  {
    name: "more models in one cell than the CellBuild cap",
    text: placement({
      models: Array.from({ length: CELL_PACK_CAPS.modelsMax + 1 }, () => ({ model: "m.glb", at: [1, 0, 1] })),
    }),
    code: WorldCellsCode.OverCap,
    at: "models[1024]",
  },
  {
    name: "more instances in one cell than the CellBuild cap",
    text: placement({
      groups: [
        {
          model: "m.glb",
          instances: Array.from({ length: CELL_PACK_CAPS.instancesMax + 1 }, () => ({ at: [1, 0, 1] })),
        },
      ],
    }),
    code: WorldCellsCode.OverCap,
    at: "groups[0].instances[65536]",
  },
  {
    name: "terrain on more cells than a pack lists",
    text: placement({
      cellSize: 8,
      bounds: { min: { x: -1024, z: -1024 }, max: { x: 1023, z: 1023 } },
      terrain: { samples: 65, height: { function: "flat", level: 0 } },
    }),
    code: WorldCellsCode.OverCap,
    at: "terrain.cells",
  },
];

describe("world-cells: hostile placements are refused typed and write no pack", () => {
  for (const row of HOSTILE) {
    it(row.name, async () => {
      const assets = new Set(["m.glb", "models/house.glb", "textures/a.png"]);
      const result = await compileWorldCells(row.text, {
        source: "world/hostile.cells.json",
        assets,
        readAsset: async () => null,
      });
      assert.equal(result.ok, false, "refused");
      if (result.ok) return;
      assert.equal(result.refusal.code, row.code);
      if (row.at !== undefined) assert.equal(result.refusal.at, row.at);
      assert.equal("files" in result, false, "no files on a refusal");
    });
  }

  it("refuses a source path outside world/ or not ending .cells.json", async () => {
    for (const source of ["../world/a.cells.json", "world/a.json", "assets/world/a.cells.json"]) {
      const result = await compileWorldCells(placement({}), { source });
      assert.equal(result.ok, false, source);
      if (!result.ok) assert.equal(result.refusal.code, WorldCellsCode.PathUnsafe, source);
    }
  });

  it("refuses a file over its byte cap before parsing", async () => {
    const result = await compileWorldCells(placement({ pad: "x".repeat(64 * 1024 * 1024) }), {
      source: "world/big.cells.json",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.refusal.code, WorldCellsCode.OverCap);
  });
});

/** Creating a link needs a privilege a Windows runner may lack. */
const LINKS = { skip: process.platform === "win32" && "symlinks need a privilege on Windows" };

/** A stage holding `files` (game-relative path to text). */
async function stageWith(files: Record<string, string>): Promise<string> {
  const stage = await tmpDir("world-cells-");
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(stage, rel)), { recursive: true });
    await writeFile(path.join(stage, rel), text);
  }
  return stage;
}

/** Every file under `dir`, stage-relative, sorted. */
async function listed(stage: string, dir = "assets"): Promise<string[]> {
  const entries = await readdir(path.join(stage, dir), { withFileTypes: true, recursive: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(stage, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

describe("world-cells: the import step's placement pass over a stage", () => {
  it("compiles world/*.cells.json into the stage's assets/ with the lock outputs of what it wrote", async () => {
    const stage = await stageWith({ "world/pack-v1.cells.json": await fixtureText("pack-v1.cells.json") });
    const rows = await stageWorldCells(stage, FIXTURE_ASSETS);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row?.refusal, undefined);
    assert.equal(row?.folder, "world");
    assert.match(row?.sha256 ?? "", /^[0-9a-f]{64}$/);
    const written = await listed(stage);
    assert.deepEqual(written, (row?.outputs ?? []).map((output) => output.file).sort());
    const fixture = await packFixture();
    assert.equal(await readFile(path.join(stage, "assets/world/world.json"), "utf8"), fixture.world);
  });

  it("refuses a second file compiling into a taken folder, and a folder holding the game's own assets, writing nothing", async () => {
    const one = placement({ folder: "world/a", cells: [{ x: 0, z: 0 }] });
    const stage = await stageWith({ "world/one.cells.json": one, "world/two.cells.json": one });
    const rows = await stageWorldCells(stage, new Set(["world/b/keep.glb"]));
    assert.deepEqual(
      rows.map((row) => [row.source, row.refusal?.code ?? "ok"]),
      [
        ["world/one.cells.json", "ok"],
        ["world/two.cells.json", WorldCellsCode.FolderTaken],
      ],
    );
    const own = await stageWith({ "world/b.cells.json": placement({ cells: [{ x: 0, z: 0 }] }) });
    const [refused] = await stageWorldCells(own, new Set(["world/b/keep.glb"]));
    assert.equal(refused?.refusal?.code, WorldCellsCode.FolderTaken);
    assert.deepEqual(await listed(own), []);
  });

  it("writes nothing for a refused file and still compiles the others", async () => {
    const stage = await stageWith({
      "world/bad.cells.json": placement({ models: [{ model: "../x.glb", at: [1, 0, 1] }] }),
      "world/good.cells.json": placement({ cells: [{ x: 0, z: 0 }] }),
    });
    const rows = await stageWorldCells(stage, new Set());
    assert.deepEqual(
      rows.map((row) => row.refusal?.code ?? "ok"),
      [WorldCellsCode.PathUnsafe, "ok"],
    );
    assert.deepEqual(await listed(stage), ["assets/world/good/cells/0_0.cell", "assets/world/good/world.json"]);
  });

  it("the build's import step compiles the stage's placement files and reports them", async () => {
    const stage = await stageWith({ "world/good.cells.json": placement({ cells: [{ x: 0, z: 0 }] }) });
    const deps = {
      jobsRoot: path.join(stage, "..", "jobs"),
      sandboxFor: async () => assert.fail("nothing in the stage needs the importer"),
      secretPaths: [],
    };
    const report = await importStagedAssets(deps, { stage, target: BuildTarget.Mac });
    assert.deepEqual(
      report?.worlds?.map((row) => [row.source, row.refusal?.code ?? "ok"]),
      [["world/good.cells.json", "ok"]],
    );
    assert.deepEqual(await listed(stage), ["assets/world/good/cells/0_0.cell", "assets/world/good/world.json"]);
  });

  it("never follows a placement file that is a link, nor writes through a linked pack folder", LINKS, async () => {
    const outside = await tmpDir("world-cells-outside-");
    await writeFile(path.join(outside, "x.cells.json"), placement({ cells: [{ x: 0, z: 0 }] }));
    const stage = await stageWith({});
    await mkdir(path.join(stage, "world"), { recursive: true });
    await symlink(path.join(outside, "x.cells.json"), path.join(stage, "world/x.cells.json"));
    assert.deepEqual(await stageWorldCells(stage, new Set()), []);

    const planted = await stageWith({ "world/y.cells.json": placement({ cells: [{ x: 0, z: 0 }] }) });
    await mkdir(path.join(planted, "assets/world"), { recursive: true });
    await symlink(outside, path.join(planted, "assets/world/y"));
    await assert.rejects(stageWorldCells(planted, new Set()));
    assert.deepEqual((await readdir(outside)).sort(), ["x.cells.json"]);
  });
});
