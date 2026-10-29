/**
 * The Roblox plugin's asset gate (`plugins/roblox/asset-gate.ts`): a `.glb` or `.gltf` in the game
 * folder is checked before it reaches a place. At most 20,000 triangles, closed (every welded edge
 * shared by exactly two triangles), one material, at most 4 bone influences per vertex, the root at
 * the origin and textures at most 1024 by 1024, their sizes read from the PNG or JPEG header by hand.
 * Each fixture fails for exactly its own reason and the cube passes; a file that can't be checked
 * (outside the game folder, through a link, too large, FBX, a broken header) is refused in plain
 * words, read no further than its header.
 */
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  bytesSource,
  checkModel,
  type GateAnswer,
  imageSize,
  MAX_MODEL_BYTES,
  type ModelCheck,
  type ModelFile,
  ModelProblem,
  ModelRefusal,
  openModelFile,
} from "../../src/plugins/roblox/asset-gate.ts";
import {
  buildGlb,
  glbFile,
  gridCube,
  greyPng,
  MODEL_FIXTURES,
  manyTriangles,
  modelFixtures,
} from "../helpers/roblox-models.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PREVIEWS = path.resolve(import.meta.dirname, "../fixtures/asset-previews");
const links = { skip: process.platform === "win32" ? "links need privileges on Windows" : false };

const checked = (answer: GateAnswer): ModelCheck => {
  assert.ok(answer.ok, answer.ok ? "" : answer.message);
  return answer.check;
};
const problems = (answer: GateAnswer) => checked(answer).problems.map((one) => one.problem);

/** A game folder with the committed fixtures in `models/`. */
async function gameWithFixtures(): Promise<string> {
  const folder = path.join(await tmpDir("roblox-gate-"), "game");
  await mkdir(path.join(folder, "models"), { recursive: true });
  for (const name of Object.keys(await modelFixtures()))
    await copyFile(path.join(MODEL_FIXTURES, name), path.join(folder, "models", name));
  return folder;
}

/** An `open` that records every read: where, and how many bytes. */
function recording() {
  const opened: string[] = [];
  const reads: Array<{ offset: number; length: number }> = [];
  const open = async (file: string): Promise<ModelFile> => {
    opened.push(file);
    const real = await openModelFile(file);
    return {
      size: real.size,
      read: (offset, length) => {
        reads.push({ offset, length });
        return real.read(offset, length);
      },
      close: real.close,
    };
  };
  const furthest = () => Math.max(0, ...reads.map((read) => read.offset + read.length));
  return { open, opened, reads, furthest };
}

describe("each fixture fails for exactly its reason", () => {
  it("the cube passes: 12 triangles, one material, closed, at the origin", async () => {
    const folder = await gameWithFixtures();
    const check = checked(await checkModel(folder, "models/cube.glb"));
    assert.equal(check.passed, true, check.problems.map((one) => one.message).join("; "));
    assert.equal(check.triangles, 12);
    assert.equal(check.materials, 1);
    assert.deepEqual(check.problems, []);
    assert.deepEqual(check.textures, []);
  });

  const TABLE: Array<[string, ModelProblem[], RegExp]> = [
    ["open-box.glb", [ModelProblem.Watertight], /4 edges/],
    ["two-materials.glb", [ModelProblem.Materials], /2 materials/],
    ["five-influences.glb", [ModelProblem.Influences], /1 vertex .*more than 4/],
    ["off-origin.glb", [ModelProblem.Origin], /\(3, 0, 0\)/],
    ["big-texture.glb", [ModelProblem.Texture], /stone.*2048 by 2048/],
    ["jpeg-texture.glb", [], /./],
  ];
  for (const [name, expected, words] of TABLE)
    it(`${name}: ${expected.length ? expected.join(", ") : "passes"}`, async () => {
      const folder = await gameWithFixtures();
      const answer = await checkModel(folder, `models/${name}`);
      assert.deepEqual(problems(answer), expected);
      for (const one of checked(answer).problems) assert.match(one.message, words);
      assert.equal(checked(answer).passed, expected.length === 0);
    });

  it("more than 20,000 triangles fails for that alone", async () => {
    const folder = await tmpDir("roblox-gate-many-");
    await writeFile(path.join(folder, "many.glb"), buildGlb(manyTriangles()));
    const answer = await checkModel(folder, "many.glb");
    assert.deepEqual(problems(answer), [ModelProblem.Triangles]);
    assert.equal(checked(answer).triangles, 20_172);
    assert.match(checked(answer).problems[0]?.message ?? "", /20,172 triangles.*20,000/);
  });

  it("the committed fixtures are what the builders make", async () => {
    for (const [name, spec] of Object.entries(await modelFixtures()))
      assert.ok((await readFile(path.join(MODEL_FIXTURES, name))).equals(buildGlb(spec)), name);
  });

  it("reads the texture sizes from the embedded PNG and JPEG", async () => {
    const folder = await gameWithFixtures();
    assert.deepEqual(checked(await checkModel(folder, "models/big-texture.glb")).textures, [
      { name: "stone", format: "png", width: 2048, height: 2048 },
    ]);
    assert.deepEqual(checked(await checkModel(folder, "models/jpeg-texture.glb")).textures, [
      { name: "wood", format: "jpeg", width: 640, height: 320 },
    ]);
  });

  it("a stricter texture side is asked for: 1024 by 1024 still passes at 1024, not at 512", async () => {
    const folder = await tmpDir("roblox-gate-side-");
    const picture = { mime: "image/png", bytes: greyPng(1024, 1024), name: "grass" };
    await writeFile(path.join(folder, "grass.glb"), buildGlb({ primitives: [gridCube()], picture }));
    assert.deepEqual(problems(await checkModel(folder, "grass.glb")), []);
    assert.deepEqual(problems(await checkModel(folder, "grass.glb", { textureSide: 512 })), [ModelProblem.Texture]);
  });
});

/** A JPEG's segments up to its frame: SOI, then each marker with its length and body. */
function jpegHeader(frame: number, before: Array<[number, number]>, width: number, height: number): Buffer {
  const segments: Buffer[] = [Buffer.from([0xff, 0xd8])];
  for (const [marker, size] of before) {
    const segment = Buffer.alloc(4 + size, 0x11);
    segment.writeUInt8(0xff, 0);
    segment.writeUInt8(marker, 1);
    segment.writeUInt16BE(size + 2, 2);
    segments.push(segment);
  }
  const sof = Buffer.from([0xff, frame, 0, 17, 8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  segments.push(sof);
  return Buffer.concat(segments);
}

/**
 * A model drawing the unit cube `copies` times from one POSITION accessor of `vertices` vertices
 * (the cube's first, the rest unused), as exporters write a vertex buffer that primitives share.
 */
function sharedPositions(vertices: number, copies: number): Buffer {
  const cube = gridCube();
  const corners = cube.indices ?? [];
  const positions = Buffer.alloc(vertices * 12);
  cube.positions.forEach((value, at) => positions.writeFloatLE(value, at * 4));
  const indices = Buffer.alloc(corners.length * 2);
  corners.forEach((value, at) => indices.writeUInt16LE(value, at * 2));
  const primitive = { attributes: { POSITION: 0 }, indices: 1, material: 0 };
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: Array.from({ length: copies }, () => primitive) }],
    materials: [{ name: "Material0" }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertices, type: "VEC3" },
      { bufferView: 1, componentType: 5123, count: corners.length, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.length },
      { buffer: 0, byteOffset: positions.length, byteLength: indices.length },
    ],
    buffers: [{ byteLength: positions.length + indices.length }],
  };
  return glbFile(json, Buffer.concat([positions, indices]));
}

describe("a vertex buffer the primitives share", () => {
  it("is read for the vertices the triangles use, not whole for each primitive", async () => {
    const folder = await tmpDir("roblox-gate-shared-");
    await writeFile(path.join(folder, "shared.glb"), sharedPositions(400_000, 5));
    const check = checked(await checkModel(folder, "shared.glb"));
    assert.equal(check.triangles, 60);
    assert.equal(check.mesh?.positions.length, 5 * 24 * 3, "each copy's 24 corners, and no more");
    assert.equal(check.mesh?.indices.length, 5 * 36);
  });

  it("drawn once is checked as the model it is", async () => {
    const folder = await tmpDir("roblox-gate-shared-");
    await writeFile(path.join(folder, "one.glb"), sharedPositions(1_000, 1));
    const check = checked(await checkModel(folder, "one.glb"));
    assert.deepEqual(check.problems, []);
    assert.deepEqual(check.size, [1, 1, 1]);
  });
});

describe("texture sizes from image headers, read by hand", () => {
  const TABLE: Array<[string, Buffer, { format: string; width: number; height: number } | undefined]> = [
    ["a PNG's IHDR", greyPng(300, 200), { format: "png", width: 300, height: 200 }],
    [
      "a baseline JPEG (SOF0) after APP0 and DQT",
      jpegHeader(
        0xc0,
        [
          [0xe0, 14],
          [0xdb, 65],
        ],
        800,
        600,
      ),
      { format: "jpeg", width: 800, height: 600 },
    ],
    [
      "a progressive JPEG (SOF2) after a 60 KB APP1",
      jpegHeader(0xc2, [[0xe1, 60_000]], 4096, 2048),
      { format: "jpeg", width: 4096, height: 2048 },
    ],
    [
      "a JPEG whose DHT (0xC4) comes before its frame",
      jpegHeader(0xc0, [[0xc4, 30]], 64, 32),
      { format: "jpeg", width: 64, height: 32 },
    ],
    ["a PNG cut inside its IHDR", greyPng(300, 200).subarray(0, 20), undefined],
    ["a JPEG that ends before any frame", jpegHeader(0xc0, [[0xe0, 14]], 1, 1).subarray(0, 22), undefined],
    [
      "a JPEG whose segment claims more than it holds",
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 1, 2]),
      undefined,
    ],
    ["a WebP", Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"), undefined],
    ["nothing", Buffer.alloc(0), undefined],
  ];
  for (const [what, bytes, size] of TABLE)
    it(what, async () => {
      assert.deepEqual(await imageSize(bytesSource(bytes)), size);
    });

  it("reads a JPEG's markers, not its segments' bodies", async () => {
    const bytes = jpegHeader(0xc2, [[0xe1, 60_000]], 4096, 2048);
    const reads: number[] = [];
    const source = bytesSource(bytes);
    const size = await imageSize({
      size: source.size,
      read: (offset, length) => {
        reads.push(length);
        return source.read(offset, length);
      },
    });
    assert.equal(size?.width, 4096);
    assert.ok(Math.max(...reads) <= 16, `largest read ${Math.max(...reads)} bytes`);
  });
});

describe("files that can't be checked are refused in plain words, read no further than the header", () => {
  /** A game folder with hostile neighbours: a model outside it, links and broken files inside. */
  async function hostile() {
    const root = await tmpDir("roblox-gate-hostile-");
    const folder = path.join(root, "game");
    const outside = path.join(root, "outside");
    await mkdir(path.join(folder, "models"), { recursive: true });
    await mkdir(outside, { recursive: true });
    const cube = await readFile(path.join(MODEL_FIXTURES, "cube.glb"));
    await writeFile(path.join(outside, "cube.glb"), cube);
    await writeFile(path.join(folder, "models", "model.fbx"), "Kaydara FBX Binary  \0");
    await writeFile(path.join(folder, "models", "model.obj"), "v 0 0 0\n");
    await writeFile(path.join(folder, "models", "short.glb"), cube.subarray(0, 6));
    const liar = Buffer.from(cube.subarray(0, 40));
    liar.writeUInt32LE(100_000, 8);
    await writeFile(path.join(folder, "models", "liar.glb"), liar);
    const huge = Buffer.from(cube.subarray(0, 20));
    huge.writeUInt32LE(0x7fff_fff0, 12);
    huge.writeUInt32LE(cube.length, 8);
    await writeFile(path.join(folder, "models", "huge-json.glb"), Buffer.concat([huge, cube.subarray(20)]));
    await writeFile(path.join(folder, "models", "picture.glb"), greyPng(16, 16));
    await writeFile(path.join(folder, "models", "oversize.glb"), "");
    await truncate(path.join(folder, "models", "oversize.glb"), MAX_MODEL_BYTES + 1);
    await mkdir(path.join(folder, "models", "folder.glb"));
    return { root, folder, outside };
  }

  const TABLE: Array<[string, string, ModelRefusal, RegExp, number]> = [
    ["a path up out of the game folder", "../outside/cube.glb", ModelRefusal.Path, /inside the game folder/, -1],
    ["an absolute path", "/etc/hosts.glb", ModelRefusal.Path, /inside the game folder/, -1],
    ["a backslash path", "models\\cube.glb", ModelRefusal.Path, /inside the game folder/, -1],
    ["a missing file", "models/none.glb", ModelRefusal.Missing, /no models\/none\.glb/, -1],
    ["an FBX", "models/model.fbx", ModelRefusal.Fbx, /export it as \.glb/i, -1],
    ["an OBJ", "models/model.obj", ModelRefusal.Format, /\.glb or \.gltf/, -1],
    ["a folder named .glb", "models/folder.glb", ModelRefusal.NotFile, /isn't a file/, -1],
    ["a file past the size cap", "models/oversize.glb", ModelRefusal.TooLarge, /larger than/, 0],
    ["a file shorter than its header", "models/short.glb", ModelRefusal.Malformed, /isn't a whole GLB/, 12],
    ["a header that claims another length", "models/liar.glb", ModelRefusal.Malformed, /isn't a whole GLB/, 12],
    ["a picture named .glb", "models/picture.glb", ModelRefusal.Malformed, /isn't a whole GLB/, 12],
    ["a JSON chunk longer than the cap", "models/huge-json.glb", ModelRefusal.Malformed, /isn't a whole GLB/, 20],
  ];
  for (const [what, file, refusal, words, furthest] of TABLE)
    it(`${what}: ${refusal}`, async () => {
      const { folder } = await hostile();
      const reader = recording();
      const answer = await checkModel(folder, file, { open: reader.open });
      assert.equal(answer.ok, false);
      if (answer.ok) return;
      assert.equal(answer.refusal, refusal);
      assert.match(answer.message, words);
      if (furthest < 0) assert.deepEqual(reader.opened, [], "never opened");
      else assert.ok(reader.furthest() <= furthest, `read up to byte ${reader.furthest()}, header ends at ${furthest}`);
    });

  it("a GLB past half the size cap is still read: its binary chunk counts once", async () => {
    const folder = await tmpDir("roblox-gate-large-");
    const picture = { mime: "image/png", bytes: Buffer.alloc(Math.ceil(MAX_MODEL_BYTES * 0.6)), name: "blank" };
    await writeFile(path.join(folder, "large.glb"), buildGlb({ primitives: [gridCube()], picture }));
    assert.deepEqual(problems(await checkModel(folder, "large.glb")), [ModelProblem.Texture]);
  });

  it("a link to a model outside, and a linked folder on the way, are refused unopened", links, async () => {
    const { folder, outside } = await hostile();
    await symlink(path.join(outside, "cube.glb"), path.join(folder, "models", "link.glb"));
    await symlink(outside, path.join(folder, "linked"));
    for (const file of ["models/link.glb", "linked/cube.glb"]) {
      const reader = recording();
      const answer = await checkModel(folder, file, { open: reader.open });
      assert.equal(answer.ok, false, file);
      if (!answer.ok) assert.equal(answer.refusal, ModelRefusal.Link, file);
      assert.deepEqual(reader.opened, [], `${file} never opened`);
    }
  });
});

describe(".gltf files and real exports", () => {
  /** The cube as a .gltf, its buffer beside it or inline. */
  async function gltfCube(folder: string, uri: (bin: Buffer) => string) {
    const glb = buildGlb({ primitives: [gridCube()] });
    const jsonLength = glb.readUInt32LE(12);
    const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8"));
    const bin = glb.subarray(20 + jsonLength + 8);
    json.buffers = [{ byteLength: json.buffers[0].byteLength, uri: uri(bin) }];
    await writeFile(path.join(folder, "models", "cube.gltf"), JSON.stringify(json));
    return bin;
  }

  it("reads a buffer beside the file and an inline one alike", async () => {
    const folder = path.join(await tmpDir("roblox-gltf-"), "game");
    await mkdir(path.join(folder, "models", "data"), { recursive: true });
    const bin = await gltfCube(folder, () => "data/cube%20mesh.bin");
    await writeFile(path.join(folder, "models", "data", "cube mesh.bin"), bin);
    assert.deepEqual(problems(await checkModel(folder, "models/cube.gltf")), []);
    await gltfCube(folder, (bytes) => `data:application/octet-stream;base64,${bytes.toString("base64")}`);
    assert.deepEqual(problems(await checkModel(folder, "models/cube.gltf")), []);
  });

  const HOSTILE_URIS: Array<[string, string]> = [
    ["a buffer up out of the game folder", "../../outside.bin"],
    ["an absolute buffer path", "/etc/passwd"],
    ["a file: address", "file:///etc/passwd"],
    ["a web address", "https://example.com/cube.bin"],
    ["an encoded way up", "..%2F..%2Foutside.bin"],
  ];
  for (const [what, uri] of HOSTILE_URIS)
    it(`refuses ${what}, reading nothing it names`, async () => {
      const root = await tmpDir("roblox-gltf-hostile-");
      const folder = path.join(root, "game");
      await mkdir(path.join(folder, "models"), { recursive: true });
      const bin = await gltfCube(folder, () => uri);
      await writeFile(path.join(root, "outside.bin"), bin);
      const reader = recording();
      const answer = await checkModel(folder, "models/cube.gltf", { open: reader.open });
      assert.equal(answer.ok, false);
      if (!answer.ok) assert.equal(answer.refusal, ModelRefusal.Path);
      assert.deepEqual(reader.opened, [path.join(folder, "models", "cube.gltf")], "only the .gltf itself");
    });

  it("refuses a buffer that is a link, without opening it", links, async () => {
    const root = await tmpDir("roblox-gltf-link-");
    const folder = path.join(root, "game");
    await mkdir(path.join(folder, "models"), { recursive: true });
    const bin = await gltfCube(folder, () => "cube.bin");
    await writeFile(path.join(root, "outside.bin"), bin);
    await symlink(path.join(root, "outside.bin"), path.join(folder, "models", "cube.bin"));
    const reader = recording();
    const answer = await checkModel(folder, "models/cube.gltf", { open: reader.open });
    assert.equal(answer.ok, false);
    if (!answer.ok) assert.equal(answer.refusal, ModelRefusal.Link);
    assert.deepEqual(reader.opened, [path.join(folder, "models", "cube.gltf")]);
  });

  it("reads Blender's own exports: the GLB and the .gltf with its buffer agree", async () => {
    const folder = path.join(await tmpDir("roblox-blender-"), "game");
    await mkdir(folder, { recursive: true });
    for (const name of ["animated.glb", "animated.gltf", "animated.bin"])
      await copyFile(path.join(PREVIEWS, name), path.join(folder, name));
    const glb = checked(await checkModel(folder, "animated.glb"));
    const gltf = checked(await checkModel(folder, "animated.gltf"));
    assert.equal(glb.triangles, 968, "Suzanne's 500 faces as triangles");
    assert.equal(glb.materials, 1);
    assert.deepEqual(
      gltf.problems.map((one) => one.problem),
      glb.problems.map((one) => one.problem),
    );
    assert.equal(gltf.triangles, glb.triangles);
  });

  it("a Draco-compressed export asks for one without compression", async () => {
    const folder = path.join(await tmpDir("roblox-draco-"), "game");
    await mkdir(folder, { recursive: true });
    await copyFile(path.join(PREVIEWS, "compressed.glb"), path.join(folder, "compressed.glb"));
    const answer = await checkModel(folder, "compressed.glb");
    assert.equal(answer.ok, false);
    if (!answer.ok) {
      assert.equal(answer.refusal, ModelRefusal.Unsupported);
      assert.match(answer.message, /without .*compression/i);
    }
  });

  it("refuses points and lines: only triangles are checked", async () => {
    const folder = await tmpDir("roblox-gate-points-");
    await writeFile(path.join(folder, "points.glb"), buildGlb({ primitives: [{ ...gridCube(), mode: 0 }] }));
    const answer = await checkModel(folder, "points.glb");
    assert.equal(answer.ok, false);
    if (!answer.ok) assert.equal(answer.refusal, ModelRefusal.Unsupported);
  });
});
