/**
 * `cc0__terrain-layer` (`src/plugins/cc0/terrain-layer.ts`): a PBR scan already in the game's
 * assets packed into the two textures a Rust `TerrainLayer::textured(albedo, data, tile)` reads.
 * The albedo carries the colour with the height in alpha; the data texture the OpenGL normal's x
 * and y, roughness and occlusion. The packing is checked texel by texel on tiny synthetic maps, the
 * role detection on both libraries' file names, and every path on a hostile table that must leave
 * the game and the folder beside it exactly as they were.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { decode, encode } from "fast-png";
import jpeg from "jpeg-js";
import { Cc0Tool, createCc0Plugin } from "../../src/plugins/cc0/backend.ts";
import type { Cc0Net } from "../../src/plugins/cc0/net.ts";
import {
  type MapImage,
  packTerrainLayer,
  resizePlane,
  rolesInFolder,
  TerrainLayerRefusal,
  terrainRoleOf,
} from "../../src/plugins/cc0/terrain-layer.ts";
import type { PluginContext, PluginScalar } from "../../src/plugin-sdk/index.d.ts";
import { tmpDir } from "../helpers/tmp.ts";

const JOB = "0b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const SCAN = `assets/cc0/${JOB}`;

/** An RGBA8 map from its texels, row by row. */
const rgba = (width: number, height: number, texels: number[][]): MapImage => ({
  width,
  height,
  channels: 4,
  max: 255,
  data: Uint8Array.from(texels.flat()),
});
/** A grey 8-bit map from its values. */
const grey = (width: number, height: number, values: number[]): MapImage => ({
  width,
  height,
  channels: 1,
  max: 255,
  data: Uint8Array.from(values),
});
/** The texels of an RGBA8 buffer, one array per texel. */
const texels = (data: Uint8Array) =>
  Array.from({ length: data.length / 4 }, (_, i) => [...data.subarray(i * 4, i * 4 + 4)]);
const column = (data: Uint8Array, channel: number) => texels(data).map((texel) => texel[channel]);

const DIFF = rgba(2, 2, [
  [10, 20, 30, 255],
  [40, 50, 60, 255],
  [70, 80, 90, 255],
  [100, 110, 120, 255],
]);
const NORMAL = rgba(2, 2, [
  [128, 200, 255, 255],
  [0, 64, 255, 255],
  [255, 0, 255, 255],
  [77, 255, 255, 255],
]);

describe("packing a terrain layer", () => {
  it("keeps the colour as it is and takes the OpenGL normal's x and y, roughness and occlusion", () => {
    const packed = packTerrainLayer(
      {
        diff: DIFF,
        nor_gl: NORMAL,
        rough: grey(2, 2, [0, 85, 170, 255]),
        ao: grey(2, 2, [255, 200, 100, 0]),
        disp: grey(2, 2, [0, 255, 51, 102]),
      },
      { size: 2048, normalizeHeight: false },
    );
    assert.deepEqual([packed.width, packed.height], [2, 2]);
    assert.deepEqual(texels(packed.albedo), [
      [10, 20, 30, 0],
      [40, 50, 60, 255],
      [70, 80, 90, 51],
      [100, 110, 120, 102],
    ]);
    assert.deepEqual(texels(packed.data), [
      [128, 200, 0, 255],
      [0, 64, 85, 200],
      [255, 0, 170, 100],
      [77, 255, 255, 0],
    ]);
    assert.deepEqual(packed.channels, {
      color: "diff",
      height: "disp",
      normal: "nor_gl",
      roughness: "rough",
      occlusion: "ao",
    });
    assert.deepEqual(packed.missing, []);
  });

  it("flips a DirectX normal's green, and prefers an OpenGL one when both are there", () => {
    const dx = packTerrainLayer({ diff: DIFF, nor_dx: NORMAL }, { size: 2048, normalizeHeight: true });
    assert.deepEqual(column(dx.data, 0), [128, 0, 255, 77]);
    assert.deepEqual(column(dx.data, 1), [55, 191, 255, 0]);
    assert.equal(dx.channels.normal, "nor_dx");
    const both = packTerrainLayer(
      {
        diff: DIFF,
        nor_gl: NORMAL,
        nor_dx: rgba(2, 2, [
          [1, 1, 1, 1],
          [1, 1, 1, 1],
          [1, 1, 1, 1],
          [1, 1, 1, 1],
        ]),
      },
      { size: 2048, normalizeHeight: true },
    );
    assert.deepEqual(column(both.data, 1), [200, 64, 0, 255]);
    assert.equal(both.channels.normal, "nor_gl");
  });

  it("splits an ARM map: occlusion from red, roughness from green, metalness left out", () => {
    const arm = rgba(2, 2, [
      [11, 22, 33, 255],
      [44, 55, 66, 255],
      [77, 88, 99, 255],
      [111, 122, 133, 255],
    ]);
    const packed = packTerrainLayer({ diff: DIFF, arm }, { size: 2048, normalizeHeight: true });
    assert.deepEqual(column(packed.data, 2), [22, 55, 88, 122]);
    assert.deepEqual(column(packed.data, 3), [11, 44, 77, 111]);
    assert.deepEqual([packed.channels.roughness, packed.channels.occlusion], ["arm", "arm"]);
    const own = packTerrainLayer(
      { diff: DIFF, arm, rough: grey(2, 2, [1, 2, 3, 4]), ao: grey(2, 2, [5, 6, 7, 8]) },
      { size: 2048, normalizeHeight: true },
    );
    assert.deepEqual(column(own.data, 2), [1, 2, 3, 4], "a roughness map of its own wins");
    assert.deepEqual(column(own.data, 3), [5, 6, 7, 8], "an occlusion map of its own wins");
  });

  it("stretches the height over its own range unless told not to; a flat or missing one is 128", () => {
    const disp = grey(2, 2, [100, 150, 125, 200]);
    const stretched = packTerrainLayer({ diff: DIFF, disp }, { size: 2048, normalizeHeight: true });
    assert.deepEqual(column(stretched.albedo, 3), [0, 128, 64, 255]);
    const kept = packTerrainLayer({ diff: DIFF, disp }, { size: 2048, normalizeHeight: false });
    assert.deepEqual(column(kept.albedo, 3), [100, 150, 125, 200]);
    const flat = packTerrainLayer(
      { diff: DIFF, disp: grey(2, 2, [9, 9, 9, 9]) },
      { size: 2048, normalizeHeight: true },
    );
    assert.deepEqual(column(flat.albedo, 3), [128, 128, 128, 128]);
  });

  it("reads a colour displacement by its luminance and a 16-bit one at full precision", () => {
    const colour = packTerrainLayer(
      {
        diff: DIFF,
        disp: rgba(2, 2, [
          [255, 0, 0, 255],
          [0, 255, 0, 255],
          [0, 0, 255, 255],
          [255, 255, 255, 255],
        ]),
      },
      { size: 2048, normalizeHeight: false },
    );
    assert.deepEqual(column(colour.albedo, 3), [54, 182, 18, 255]);
    const deep: MapImage = {
      width: 2,
      height: 2,
      channels: 1,
      max: 65535,
      data: Uint16Array.from([1000, 1100, 1075, 1000]),
    };
    const packed = packTerrainLayer({ diff: DIFF, disp: deep }, { size: 2048, normalizeHeight: true });
    assert.deepEqual(column(packed.albedo, 3), [0, 255, 191, 0], "a range inside one 8-bit step still spans 0..255");
  });

  it("gives every missing role its neutral value and says which were missing", () => {
    const packed = packTerrainLayer({ diff: DIFF }, { size: 2048, normalizeHeight: true });
    assert.deepEqual(texels(packed.data), Array(4).fill([128, 128, 255, 255]));
    assert.deepEqual(column(packed.albedo, 3), [128, 128, 128, 128]);
    assert.deepEqual(packed.channels, { color: "diff", height: null, normal: null, roughness: null, occlusion: null });
    assert.deepEqual(packed.missing, ["height", "normal", "roughness", "occlusion"]);
  });

  it("refuses a layer without a colour map", () => {
    assert.throws(
      () => packTerrainLayer({ nor_gl: NORMAL }, { size: 2048, normalizeHeight: true }),
      (error: { code?: string }) => error.code === TerrainLayerRefusal.NoColour,
    );
  });
});

describe("resizing the maps to one size", () => {
  it("box-filters a larger map down and caps the colour map's size at size", () => {
    const rough = grey(4, 4, [0, 40, 80, 120, 40, 80, 120, 160, 200, 200, 0, 0, 200, 200, 0, 255]);
    const diff = rgba(4, 4, Array(16).fill([50, 100, 150, 255]));
    const packed = packTerrainLayer({ diff, rough }, { size: 2, normalizeHeight: true });
    assert.deepEqual([packed.width, packed.height], [2, 2]);
    assert.deepEqual(column(packed.data, 2), [40, 120, 200, 64]);
    assert.deepEqual(
      texels(packed.albedo).map((texel) => texel.slice(0, 3)),
      Array(4).fill([50, 100, 150]),
    );
  });

  it("stretches a smaller map up to the colour map's size, the same bytes every run", () => {
    const diff = rgba(4, 4, Array(16).fill([1, 2, 3, 255]));
    const maps = { diff, rough: grey(2, 2, [0, 255, 255, 0]), disp: grey(2, 2, [0, 64, 128, 255]) };
    const first = packTerrainLayer(maps, { size: 2048, normalizeHeight: true });
    const second = packTerrainLayer(maps, { size: 2048, normalizeHeight: true });
    assert.deepEqual([first.width, first.height], [4, 4]);
    assert.deepEqual(first.data, second.data);
    assert.deepEqual(first.albedo, second.albedo);
    assert.deepEqual(column(first.data, 2).slice(0, 4), [0, 64, 191, 255]);
  });

  it("keeps a plane the size it already is, and averages exactly on a halving", () => {
    const plane = { width: 2, height: 2, data: Float32Array.from([0, 0.5, 1, 0.25]) };
    assert.equal(resizePlane(plane, 2, 2), plane);
    assert.deepEqual([...resizePlane(plane, 1, 1).data], [0.4375]);
  });
});

/** File names as the two libraries ship them, and the role each names. */
const ROLE_NAMES: Array<[string, string | null]> = [
  ["snow_02_diff_2k.jpg", "diff"],
  ["snow_02_nor_gl_2k.png", "nor_gl"],
  ["snow_02_nor_dx_2k.png", "nor_dx"],
  ["snow_02_rough_2k.jpg", "rough"],
  ["snow_02_arm_2k.jpg", "arm"],
  ["snow_02_ao_2k.jpg", "ao"],
  ["snow_02_disp_2k.png", "disp"],
  ["rough_plaster_diff_1k.jpg", "diff"],
  ["Ground054_1K-JPG_Color.jpg", "diff"],
  ["Ground054_1K-JPG_NormalGL.jpg", "nor_gl"],
  ["Ground054_1K-JPG_NormalDX.jpg", "nor_dx"],
  ["Ground054_1K-JPG_Roughness.jpg", "rough"],
  ["Ground054_1K-JPG_AmbientOcclusion.jpg", "ao"],
  ["Ground054_1K-PNG_Displacement.png", "disp"],
  ["Ground054_1K-JPG_Metalness.jpg", null],
  ["snow_02_diff_2k.exr", null],
  ["snow_02_1k.glb", null],
];

describe("finding each map's role by its file name", () => {
  it("reads Poly Haven's and ambientCG's names, the role being the last word that names one", () => {
    for (const [name, role] of ROLE_NAMES) assert.equal(terrainRoleOf(name), role, name);
  });

  it("maps a folder's files to roles and refuses two files of one role", () => {
    assert.deepEqual(
      rolesInFolder(["Bricks_1K-JPG_Color.jpg", "Bricks_1K-JPG_NormalGL.jpg", "Bricks_1K-JPG.usdc", "notes.txt"]),
      { diff: "Bricks_1K-JPG_Color.jpg", nor_gl: "Bricks_1K-JPG_NormalGL.jpg" },
    );
    assert.throws(
      () => rolesInFolder(["a_diff_1k.jpg", "a_diff_2k.jpg"]),
      (error: { code?: string }) => error.code === TerrainLayerRefusal.AmbiguousMap,
    );
  });
});

const png = (width: number, height: number, data: Uint8Array | Uint16Array, channels: number, depth: 8 | 16 = 8) =>
  encode({ width, height, data, channels, depth });

const RECORD = {
  jobId: JOB,
  source: "polyhaven",
  id: "snow_02",
  kind: "texture",
  resolution: "1k",
  licence: "CC0-1.0",
  page: "https://polyhaven.com/a/snow_02",
  authors: ["Rob Tuytel"],
  files: [],
};

/** A game with a Poly Haven scan in `assets/cc0/<job>/`, a folder beside it, and a context whose host only reads job records. */
async function scanGame() {
  const root = await tmpDir("cc0-terrain-");
  const game = path.join(root, "game");
  const outside = path.join(root, "outside");
  await mkdir(path.join(game, SCAN), { recursive: true });
  await mkdir(path.join(game, "src"), { recursive: true });
  await mkdir(outside);
  await writeFile(path.join(outside, "victim.png"), "keep me");
  const put = (name: string, bytes: Uint8Array) => writeFile(path.join(game, SCAN, name), bytes);
  await put("snow_02_diff_1k.png", png(2, 2, Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]), 3));
  await put("snow_02_nor_gl_1k.png", png(2, 2, Uint8Array.from(NORMAL.data), 4));
  await put("snow_02_arm_1k.png", png(2, 2, Uint8Array.from([11, 22, 33, 44, 55, 66, 77, 88, 99, 111, 122, 133]), 3));
  await put("snow_02_disp_1k.png", png(2, 2, Uint16Array.from([1000, 1100, 1075, 1000]), 1, 16));
  const asked: string[] = [];
  const ctx: PluginContext = {
    project: "snow-game",
    directory: game,
    stack: "rust-wgpu",
    signal: new AbortController().signal,
    callId: 1,
    host: (async (method: string, args: Record<string, unknown>) => {
      asked.push(method);
      if (method === "jobs.read") return args.id === JOB ? RECORD : null;
      throw new Error(`unexpected host call ${method}`);
    }) as PluginContext["host"],
  };
  return { root, game, outside, ctx, asked };
}

const NO_NET: Cc0Net = {
  json: () => Promise.reject(new Error("no network")),
  download: () => Promise.reject(new Error("no network")),
};

async function pack(ctx: PluginContext, args: Record<string, PluginScalar>) {
  const activation = await createCc0Plugin({ net: NO_NET });
  assert.ok(activation.tool);
  return activation.tool(Cc0Tool.TerrainLayer, args, ctx) as Promise<Record<string, unknown>>;
}

/** Every entry under `root` (links not followed) with its bytes or link target, for a before/after compare. */
async function tree(root: string): Promise<Record<string, string>> {
  const seen: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const full = path.join(dir, name);
      const info = await lstat(full);
      const key = path.relative(root, full);
      if (info.isSymbolicLink()) seen[key] = `-> ${await readlink(full)}`;
      else if (info.isDirectory()) {
        seen[key] = "dir";
        await walk(full);
      } else seen[key] = (await readFile(full)).toString("base64");
    }
  };
  await walk(root);
  return seen;
}

/** Each hostile call: what it tries, the refusal it gets, its arguments, and what the game holds first. */
const HOSTILE: Array<
  [string, TerrainLayerRefusal, Record<string, PluginScalar>, (game: string, outside: string) => Promise<void>]
> = [
  [
    "a folder climbing out",
    TerrainLayerRefusal.PathRefused,
    { name: "x", folder: "assets/../../outside" },
    async () => {},
  ],
  ["an absolute folder", TerrainLayerRefusal.PathRefused, { name: "x", folder: "/tmp" }, async () => {}],
  [
    "a colour map climbing out",
    TerrainLayerRefusal.PathRefused,
    { name: "x", diff: "assets/../../outside/victim.png" },
    async () => {},
  ],
  ["an absolute colour map", TerrainLayerRefusal.PathRefused, { name: "x", diff: "/etc/hosts" }, async () => {}],
  [
    "a folder linked out of the game",
    TerrainLayerRefusal.PathRefused,
    { name: "x", folder: "assets/linked" },
    async (game, outside) => {
      await writeFile(path.join(outside, "a_diff_1k.png"), png(1, 1, Uint8Array.from([1, 2, 3]), 3));
      await symlink(outside, path.join(game, "assets/linked"));
    },
  ],
  [
    "a map linked out of the game",
    TerrainLayerRefusal.PathRefused,
    { name: "x", folder: SCAN, rough: "assets/rough_link.png" },
    async (game, outside) => symlink(path.join(outside, "victim.png"), path.join(game, "assets/rough_link.png")),
  ],
  [
    "a missing map",
    TerrainLayerRefusal.MapMissing,
    { name: "x", folder: SCAN, ao: "assets/nowhere_ao.png" },
    async () => {},
  ],
  ["a missing folder", TerrainLayerRefusal.MapMissing, { name: "x", folder: "assets/cc0/nowhere" }, async () => {}],
  [
    "no colour map",
    TerrainLayerRefusal.NoColour,
    { name: "x", nor_gl: `${SCAN}/snow_02_nor_gl_1k.png` },
    async () => {},
  ],
  [
    "a map that is no image",
    TerrainLayerRefusal.NotImage,
    { name: "x", folder: SCAN, ao: "assets/notes_ao.png" },
    async (game) => writeFile(path.join(game, "assets/notes_ao.png"), "text"),
  ],
  [
    "an output outside assets",
    TerrainLayerRefusal.OutsideAssets,
    { name: "x", folder: SCAN, out: "src" },
    async () => {},
  ],
  [
    "an output climbing out of assets",
    TerrainLayerRefusal.OutsideAssets,
    { name: "x", folder: SCAN, out: "assets/../src" },
    async () => {},
  ],
  [
    "an output folder linked out",
    TerrainLayerRefusal.PathRefused,
    { name: "x", folder: SCAN, out: "assets/terrain" },
    async (game, outside) => symlink(outside, path.join(game, "assets/terrain")),
  ],
  [
    "an output file linked out",
    TerrainLayerRefusal.PathRefused,
    { name: "snow", folder: SCAN },
    async (game, outside) => {
      await mkdir(path.join(game, "assets/terrain"));
      await symlink(path.join(outside, "victim.png"), path.join(game, "assets/terrain/snow_data.png"));
    },
  ],
  ["a name with a slash", TerrainLayerRefusal.InvalidArgument, { name: "../x", folder: SCAN }, async () => {}],
  ["no name", TerrainLayerRefusal.InvalidArgument, { folder: SCAN }, async () => {}],
  [
    "a size off the powers of two",
    TerrainLayerRefusal.InvalidArgument,
    { name: "x", folder: SCAN, size: 300 },
    async () => {},
  ],
  ["a size past 4096", TerrainLayerRefusal.InvalidArgument, { name: "x", folder: SCAN, size: 8192 }, async () => {}],
  [
    "a tile that is not positive",
    TerrainLayerRefusal.InvalidArgument,
    { name: "x", folder: SCAN, tile: 0 },
    async () => {},
  ],
  ["a role given a number", TerrainLayerRefusal.InvalidArgument, { name: "x", folder: SCAN, ao: 3 }, async () => {}],
];

describe("cc0__terrain-layer in a game", () => {
  it("packs a fetched Poly Haven scan into assets/terrain/ and answers the Rust line", async () => {
    const { game, ctx, asked } = await scanGame();
    const result = await pack(ctx, { name: "snow", folder: SCAN, tile: 6 });
    assert.equal(result.albedo, "terrain/snow_albedo.png");
    assert.equal(result.data, "terrain/snow_data.png");
    assert.deepEqual(result.files, ["assets/terrain/snow_albedo.png", "assets/terrain/snow_data.png"]);
    assert.deepEqual(result.size, { width: 2, height: 2 });
    assert.equal(result.rust, 'TerrainLayer::textured("terrain/snow_albedo.png", "terrain/snow_data.png", 6.0)');
    assert.deepEqual(result.found, ["diff", "nor_gl", "arm", "disp"]);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.derivedFrom, {
      jobId: JOB,
      source: "polyhaven",
      id: "snow_02",
      licence: "CC0-1.0",
      page: "https://polyhaven.com/a/snow_02",
      authors: ["Rob Tuytel"],
    });
    assert.deepEqual(asked, ["jobs.read"], "no network, no delivery: one record read");

    const albedo = decode(await readFile(path.join(game, "assets/terrain/snow_albedo.png")));
    assert.deepEqual([albedo.width, albedo.height, albedo.channels, albedo.depth], [2, 2, 4, 8]);
    assert.deepEqual(texels(albedo.data as Uint8Array), [
      [10, 20, 30, 0],
      [40, 50, 60, 255],
      [70, 80, 90, 191],
      [100, 110, 120, 0],
    ]);
    const data = decode(await readFile(path.join(game, "assets/terrain/snow_data.png")));
    assert.deepEqual(texels(data.data as Uint8Array), [
      [128, 200, 22, 11],
      [0, 64, 55, 44],
      [255, 0, 88, 77],
      [77, 255, 122, 111],
    ]);

    const again = await pack(ctx, { name: "snow", folder: SCAN, tile: 6 });
    assert.deepEqual(again.files, result.files, "a repeat call replaces its own outputs");
  });

  it("packs an ambientCG folder with a DirectX normal and a JPEG colour, naming what it lacked", async () => {
    const { game, ctx } = await scanGame();
    const folder = "assets/cc0/acg";
    await mkdir(path.join(game, folder));
    const colour = jpeg.encode(
      { width: 2, height: 2, data: Uint8Array.from(Array(4).fill([90, 90, 90, 255]).flat()) },
      100,
    );
    await writeFile(path.join(game, folder, "Snow003_1K-JPG_Color.jpg"), colour.data);
    await writeFile(path.join(game, folder, "Snow003_1K-JPG_NormalDX.png"), png(2, 2, Uint8Array.from(NORMAL.data), 4));
    const result = await pack(ctx, { name: "snow003", folder, out: "assets/ground" });
    assert.equal(result.rust, 'TerrainLayer::textured("ground/snow003_albedo.png", "ground/snow003_data.png", 4.0)');
    assert.deepEqual(result.found, ["diff", "nor_dx"]);
    assert.deepEqual(result.missing, ["height", "roughness", "occlusion"]);
    assert.equal(result.derivedFrom, undefined);
    const data = decode(await readFile(path.join(game, "assets/ground/snow003_data.png")));
    assert.deepEqual(column(data.data as Uint8Array, 1), [55, 191, 255, 0]);
    const albedo = decode(await readFile(path.join(game, "assets/ground/snow003_albedo.png")));
    assert.ok(column(albedo.data as Uint8Array, 0).every((value) => Math.abs((value ?? 0) - 90) <= 2));
  });

  it("takes explicit paths over the folder's own", async () => {
    const { game, ctx } = await scanGame();
    await writeFile(path.join(game, "assets/own_rough.png"), png(2, 2, Uint8Array.from([1, 2, 3, 4]), 1));
    const result = await pack(ctx, { name: "snow", folder: SCAN, rough: "assets/own_rough.png", size: 256 });
    assert.deepEqual(result.found, ["diff", "nor_gl", "rough", "arm", "disp"]);
    const data = decode(await readFile(path.join(game, "assets/terrain/snow_data.png")));
    assert.deepEqual(column(data.data as Uint8Array, 2), [1, 2, 3, 4]);
  });

  it("refuses every hostile path and argument, writing nothing in the game or beside it", async () => {
    for (const [label, code, args, arrange] of HOSTILE) {
      const { root, game, outside, ctx } = await scanGame();
      await arrange(game, outside);
      const before = await tree(root);
      await assert.rejects(pack(ctx, args), (error: Error) => error.message.startsWith(`cc0 ${code}: `), label);
      assert.deepEqual(await tree(root), before, `${label}: nothing changed`);
    }
  });
});
