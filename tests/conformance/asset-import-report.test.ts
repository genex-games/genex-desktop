/**
 * The validation report and character facts (game systems C-23): the importer checks the GLB it
 * wrote (material ranges, the triangle budget) and reads a rigged GLB's clips, joints, humanoid
 * coverage and skinned levels, and both reach `assets.inventory` on `ProjectAsset.import`, from a
 * fresh import and from the import cache. A receipt's copy is checked before an agent sees it.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { openAssetCache } from "../../src/main/asset-cache.ts";
import { AssetService, cacheWarmer } from "../../src/main/core/assets.ts";
import type { ImportSandbox, RustAssetImportDeps } from "../../src/main/rust-assets.ts";
import type { StudioCore } from "../../src/main/studio-core.ts";
import { ImportIssueCode } from "../../src/shared/asset-db.ts";
import {
  CHARACTER_CLIPS_MAX,
  type CharacterFacts,
  ClipMotion,
  HUMANOID_REQUIRED_BONES,
  parseCharacterFacts,
} from "../../src/shared/character-facts.ts";
import { AssetImportStatus, type ProjectAsset } from "../../src/shared/game-assets.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { HUMANOID_BONES, characterFacts } from "../../src/substrate/asset-import/character-facts.ts";
import { meshToGlb, readGlb, writeGlb } from "../../src/substrate/asset-import/glb.ts";
import { ImportJobLayout, parseImportReceipt } from "../../src/substrate/asset-import/job.ts";
import { reportGlb } from "../../src/substrate/asset-import/report.ts";
import { runImportJob } from "../../src/substrate/asset-import/worker.ts";
import type { RunResult } from "../../src/substrate/spawn.ts";
import aliasTable from "../fixtures/humanoid-aliases.json" with { type: "json" };
import { tmpDir } from "../helpers/tmp.ts";

// biome-ignore lint/suspicious/noExplicitAny: a glTF's JSON, read and edited as data
type Json = Record<string, any>;

const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;

/** A quad with one base-colour material, its PBR factors then set as given. */
function materialQuad(pbr: Json, extensions?: Json): Uint8Array {
  const glb = meshToGlb({
    name: "quad",
    materials: [{ name: "surface", baseColor: [1, 1, 1, 1] }],
    primitives: [
      {
        positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: Uint32Array.from([0, 2, 1, 2, 3, 1]),
        material: 0,
      },
    ],
  });
  const { json, bin } = readGlb(glb) as { json: Json; bin: Uint8Array };
  json.materials[0].pbrMetallicRoughness = { ...json.materials[0].pbrMetallicRoughness, ...pbr };
  if (extensions) {
    json.materials[0].extensions = extensions;
    json.extensionsUsed = Object.keys(extensions);
  }
  return writeGlb(json, bin);
}

/** The UE mannequin's skeleton (Quaternius UAL ships it): name, parent name, rest translation. */
const UE_JOINTS: readonly [string, string | null, [number, number, number]][] = [
  ["root", null, [0, 0, 0]],
  ["pelvis", "root", [0, 1, 0]],
  ["spine_01", "pelvis", [0, 0.1, 0]],
  ["spine_02", "spine_01", [0, 0.1, 0]],
  ["spine_03", "spine_02", [0, 0.1, 0]],
  ["neck_01", "spine_03", [0, 0.2, 0]],
  ["head", "neck_01", [0, 0.1, 0]],
  ["clavicle_l", "spine_03", [0.05, 0.15, 0]],
  ["upperarm_l", "clavicle_l", [0.15, 0, 0]],
  ["lowerarm_l", "upperarm_l", [0.25, 0, 0]],
  ["hand_l", "lowerarm_l", [0.25, 0, 0]],
  ["clavicle_r", "spine_03", [-0.05, 0.15, 0]],
  ["upperarm_r", "clavicle_r", [-0.15, 0, 0]],
  ["lowerarm_r", "upperarm_r", [-0.25, 0, 0]],
  ["hand_r", "lowerarm_r", [-0.25, 0, 0]],
  ["thigh_l", "pelvis", [0.1, -0.05, 0]],
  ["calf_l", "thigh_l", [0, -0.45, 0]],
  ["foot_l", "calf_l", [0, -0.42, 0]],
  ["ball_l", "foot_l", [0, -0.05, 0.12]],
  ["thigh_r", "pelvis", [-0.1, -0.05, 0]],
  ["calf_r", "thigh_r", [0, -0.45, 0]],
  ["foot_r", "calf_r", [0, -0.42, 0]],
  ["ball_r", "foot_r", [0, -0.05, 0.12]],
];

/** One clip of a test rig: its name, length, and how far its pelvis travels forward (metres). */
interface TestClip {
  name: string;
  seconds: number;
  travel: number;
}

/** Bytes appended to a BIN chunk, 4-aligned, each a buffer view. */
class Bin {
  readonly parts: Uint8Array[] = [];
  readonly views: Json[] = [];
  length = 0;
  view(bytes: Uint8Array, target?: number): number {
    this.views.push({
      buffer: 0,
      byteOffset: this.length,
      byteLength: bytes.byteLength,
      ...(target ? { target } : {}),
    });
    this.parts.push(bytes);
    this.length += bytes.byteLength;
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.parts.push(new Uint8Array(pad));
      this.length += pad;
    }
    return this.views.length - 1;
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  }
}

const f32 = (values: number[]) => new Uint8Array(Float32Array.from(values).buffer);

/**
 * A bumpy `cells`x`cells` grid skinned to the pelvis, on the UE mannequin skeleton (or `joints`),
 * with one translation channel on the pelvis per clip: a stand-in for a UAL character, built here
 * because the pack itself is fetched by sha256 (C-22), never committed.
 */
function riggedGlb(
  clips: readonly TestClip[],
  options: { cells?: number; joints?: typeof UE_JOINTS } = {},
): Uint8Array {
  const joints = options.joints ?? UE_JOINTS;
  const cells = options.cells ?? 2;
  const bin = new Bin();
  const accessors: Json[] = [];
  const accessor = (fields: Json) => accessors.push(fields) - 1;
  const positions: number[] = [];
  for (let y = 0; y <= cells; y++)
    for (let x = 0; x <= cells; x++)
      positions.push(x / cells, 1 + y / cells, Math.sin(x * 1.7) * Math.cos(y * 2.3) * 0.05);
  const vertices = positions.length / 3;
  const indices: number[] = [];
  for (let y = 0; y < cells; y++)
    for (let x = 0; x < cells; x++) {
      const a = y * (cells + 1) + x;
      indices.push(a, a + 1, a + cells + 1, a + 1, a + cells + 2, a + cells + 1);
    }
  const pelvis = joints.findIndex(([name]) => name === "pelvis");
  const min = [0, 1, Math.min(...positions.filter((_, i) => i % 3 === 2))];
  const max = [1, 2, Math.max(...positions.filter((_, i) => i % 3 === 2))];
  const attributes = {
    POSITION: accessor({
      bufferView: bin.view(f32(positions), 34962),
      componentType: FLOAT,
      count: vertices,
      type: "VEC3",
      min,
      max,
    }),
    JOINTS_0: accessor({
      bufferView: bin.view(
        new Uint8Array(vertices * 4).map((_, i) => (i % 4 === 0 ? Math.max(pelvis, 0) : 0)),
        34962,
      ),
      componentType: UNSIGNED_BYTE,
      count: vertices,
      type: "VEC4",
    }),
    WEIGHTS_0: accessor({
      bufferView: bin.view(f32(Array.from({ length: vertices * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0))), 34962),
      componentType: FLOAT,
      count: vertices,
      type: "VEC4",
    }),
  };
  const indexAccessor = accessor({
    bufferView: bin.view(new Uint8Array(Uint16Array.from(indices).buffer), 34963),
    componentType: UNSIGNED_SHORT,
    count: indices.length,
    type: "SCALAR",
  });
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const ibm = accessor({
    bufferView: bin.view(f32(joints.flatMap(() => identity))),
    componentType: FLOAT,
    count: joints.length,
    type: "MAT4",
  });
  const nodes: Json[] = joints.map(([name, , translation]) => ({ name, translation }));
  for (const [at, [, parent]] of joints.entries()) {
    if (parent === null) continue;
    const owner = nodes[joints.findIndex(([name]) => name === parent)] as Json;
    owner.children = [...(owner.children ?? []), at];
  }
  const meshNode = nodes.push({ name: "body", mesh: 0, skin: 0 }) - 1;
  const animations = clips.map((clip) => {
    const input = accessor({
      bufferView: bin.view(f32([0, clip.seconds])),
      componentType: FLOAT,
      count: 2,
      type: "SCALAR",
      min: [0],
      max: [clip.seconds],
    });
    const output = accessor({
      bufferView: bin.view(f32([0, 1, 0, 0, 1, clip.travel])),
      componentType: FLOAT,
      count: 2,
      type: "VEC3",
    });
    return {
      name: clip.name,
      samplers: [{ input, output, interpolation: "LINEAR" }],
      channels: [{ sampler: 0, target: { node: pelvis, path: "translation" } }],
    };
  });
  const json: Json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0, meshNode] }],
    nodes,
    meshes: [{ primitives: [{ attributes, indices: indexAccessor }] }],
    skins: [{ joints: joints.map((_, at) => at), inverseBindMatrices: ibm }],
    animations,
    accessors,
    bufferViews: bin.views,
    buffers: [{ byteLength: bin.length }],
  };
  return writeGlb(json, bin.bytes());
}

/** 45 clips like UAL's: a loop of lengths, every third one travelling forward. */
const UAL_CLIPS: TestClip[] = Array.from({ length: 45 }, (_, at) => ({
  name: `Clip_${String(at).padStart(2, "0")}`,
  seconds: Math.round((0.5 + at * 0.1) * 1000) / 1000,
  travel: at % 3 === 0 ? 1.4 : 0,
}));

/** Import deps whose sandbox runs the real importer in this process. */
function inProcessDeps(jobsRoot: string, jobs: { count: number }): RustAssetImportDeps {
  return {
    jobsRoot,
    secretPaths: [],
    sandboxFor: async (): Promise<ImportSandbox> => ({
      run: async (request): Promise<RunResult> => {
        jobs.count++;
        const code = await runImportJob(request.cwd);
        return {
          code,
          signal: null,
          stdout: "",
          stderr: "",
          durationMs: 0,
          timedOut: false,
          truncated: false,
          sandboxed: true,
          command: request.command,
          cwd: request.cwd,
        };
      },
      dispose: async () => {},
    }),
  };
}

/** A Rust game and an `AssetService` whose delivery imports run the real importer through a real cache. */
async function rustGame() {
  const root = await realpath(await tmpDir("genex-import-report-"));
  const game = path.join(root, "game");
  const scratch = path.join(root, "scratch");
  const engineHomes = path.join(root, "engines");
  for (const folder of [path.join(game, "assets"), scratch, engineHomes]) await mkdir(folder, { recursive: true });
  await writeFile(path.join(game, "genex.toml"), '[game]\nname = "report"\n');
  const jobs = { count: 0 };
  const deps = inProcessDeps(path.join(root, "jobs"), jobs);
  const cache = openAssetCache({ root: path.join(root, "cache") });
  const service = (cacheRoot = cache) =>
    new AssetService(
      {
        games: { dirFor: () => game, factsOf: async () => [] },
        layout: { scratch, engineHomes },
        assetCheckpoints: { records: async () => [] },
        options: {},
      } as unknown as StudioCore,
      async () => "",
      Date.now,
      new Map(),
      { imports: cacheWarmer(cacheRoot, deps, BuildTarget.Mac) },
    );
  return { game, jobs, service };
}

async function importedRow(service: AssetService, file: string): Promise<ProjectAsset["import"]> {
  await service.warmImports("game", [file]);
  return (await service.projectAssets("game")).assets.find((asset) => asset.file === file)?.import;
}

const reportCodes = (issues: { code: string; detail?: string }[] | undefined) =>
  (issues ?? []).filter((issue) => issue.code !== ImportIssueCode.ValidationWarning);

describe("the validation report reaches assets.inventory", () => {
  it("base colour (255, 255, 255) with metallic 0.5 reports two issues on its material, fresh and from the cache", async () => {
    const { game, jobs, service } = await rustGame();
    await writeFile(
      path.join(game, "assets", "white.glb"),
      materialQuad({ baseColorFactor: [1, 1, 1, 1], metallicFactor: 0.5 }),
    );
    const fresh = await importedRow(service(), "assets/white.glb");
    assert.equal(fresh?.status, AssetImportStatus.Ready);
    assert.deepEqual(reportCodes(fresh?.issues), [
      { code: ImportIssueCode.AlbedoOutOfRange, detail: "/materials/0" },
      { code: ImportIssueCode.MetallicPartial, detail: "/materials/0" },
    ]);
    const restarted = await importedRow(service(), "assets/white.glb");
    assert.equal(jobs.count, 1, "the second read was a cache hit");
    assert.deepEqual(restarted, fresh);
  });

  it("a rigged GLB lists its 45 clips with durations, its joints, humanoid 22/22 and its skinned levels", async () => {
    const { game, service } = await rustGame();
    await writeFile(path.join(game, "assets", "ual.glb"), riggedGlb(UAL_CLIPS, { cells: 24 }));
    const facts = (await importedRow(service(), "assets/ual.glb"))?.character;
    assert.ok(facts, "the inventory row carries character facts");
    assert.equal(facts.clipCount, 45);
    assert.deepEqual(
      facts.clips.map((clip) => [clip.name, clip.seconds]),
      UAL_CLIPS.map((clip) => [clip.name, clip.seconds]),
    );
    assert.equal(facts.joints, UE_JOINTS.length);
    assert.deepEqual(facts.humanoid, { rig: "ue-mannequin", mapped: 22, required: 22, missing: [] });
    assert.ok(
      facts.skinnedLevels >= 2,
      `a 1,152-triangle skinned mesh gets LODs that keep its skin (${facts.skinnedLevels})`,
    );
  });

  it("a model with no skin carries no character facts", async () => {
    const { game, service } = await rustGame();
    await writeFile(
      path.join(game, "assets", "grey.glb"),
      materialQuad({ baseColorFactor: [0.2, 0.2, 0.2, 1], metallicFactor: 0 }),
    );
    const row = await importedRow(service(), "assets/grey.glb");
    assert.equal(row?.character, undefined);
    assert.deepEqual(reportCodes(row?.issues), []);
  });
});

describe("the report's checks", () => {
  const cases: [string, Uint8Array, { code: string; detail?: string }[]][] = [
    ["a mid-grey dielectric", materialQuad({ baseColorFactor: [0.2, 0.2, 0.2, 1], metallicFactor: 0 }), []],
    ["a bright metal", materialQuad({ baseColorFactor: [0.95, 0.93, 0.88, 1], metallicFactor: 1 }), []],
    [
      "a near-black dielectric",
      materialQuad({ baseColorFactor: [0.005, 0.005, 0.005, 1], metallicFactor: 0 }),
      [{ code: ImportIssueCode.AlbedoOutOfRange, detail: "/materials/0" }],
    ],
    [
      "a dark metal",
      materialQuad({ baseColorFactor: [0.1, 0.1, 0.1, 1], metallicFactor: 1 }),
      [{ code: ImportIssueCode.AlbedoOutOfRange, detail: "/materials/0" }],
    ],
    [
      "a textured base colour is the texture's business",
      materialQuad({ baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, baseColorTexture: { index: 0 } }),
      [],
    ],
    [
      "a metallic map with a partial factor",
      materialQuad({
        baseColorFactor: [0.2, 0.2, 0.2, 1],
        metallicFactor: 0.5,
        metallicRoughnessTexture: { index: 0 },
      }),
      [],
    ],
    [
      "an IOR of 5",
      materialQuad({ baseColorFactor: [0.2, 0.2, 0.2, 1], metallicFactor: 0 }, { KHR_materials_ior: { ior: 5 } }),
      [{ code: ImportIssueCode.IorOutOfRange, detail: "/materials/0" }],
    ],
    [
      "an IOR of 1.5",
      materialQuad({ baseColorFactor: [0.2, 0.2, 0.2, 1], metallicFactor: 0 }, { KHR_materials_ior: { ior: 1.5 } }),
      [],
    ],
  ];
  for (const [name, glb, expected] of cases) {
    it(name, () => assert.deepEqual(reportGlb(glb), expected));
  }

  it("a model over its class's triangle budget is named with its count and the budget", () => {
    const glb = materialQuad({ baseColorFactor: [0.2, 0.2, 0.2, 1], metallicFactor: 0 });
    assert.deepEqual(reportGlb(glb, { model: 1, character: 1 }), [
      { code: ImportIssueCode.TrianglesOverBudget, detail: "2/1" },
    ]);
    const rigged = riggedGlb(UAL_CLIPS.slice(0, 1));
    assert.deepEqual(reportGlb(rigged, { model: 100, character: 4 }), [
      { code: ImportIssueCode.TrianglesOverBudget, detail: "8/4" },
    ]);
  });

  it("an unreadable GLB reports nothing (the validator owns damaged files)", () => {
    assert.deepEqual(reportGlb(new Uint8Array([1, 2, 3])), []);
  });
});

describe("character facts read from a GLB", () => {
  it("clip motion: a pelvis that travels is root motion, one that stays is in place", () => {
    const facts = characterFacts(riggedGlb(UAL_CLIPS.slice(0, 3)));
    assert.deepEqual(
      facts?.clips.map((clip) => clip.motion),
      [ClipMotion.RootMotion, ClipMotion.InPlace, ClipMotion.InPlace],
    );
  });

  it("the alias table is the fixture's, and every family's first names map all 22 bones", () => {
    assert.deepEqual(HUMANOID_BONES, aliasTable.bones);
    for (const profile of aliasTable.profiles) {
      const names = aliasTable.bones.map((bone) => (profile.aliases as Record<string, string[]>)[bone]?.[0] ?? bone);
      const joints: typeof UE_JOINTS = names.map((name, at) => [
        name,
        at === 0 ? null : (names[0] as string),
        [0, at === 0 ? 1 : -0.04, 0] as [number, number, number],
      ]);
      const facts = characterFacts(riggedGlb([], { joints }));
      assert.deepEqual(facts?.humanoid, { rig: profile.id, mapped: 22, required: 22, missing: [] }, profile.id);
    }
  });

  it("prefixed mixamo names match by their part after ':' ignoring case, and a missing bone is named", () => {
    const mixamo = aliasTable.profiles.find((profile) => profile.id === "mixamorig");
    assert.ok(mixamo);
    const names = aliasTable.bones
      .filter((bone) => bone !== "LeftToes")
      .map((bone) => `mixamorig:${(mixamo.aliases as Record<string, string[]>)[bone]?.[0]}`.toLowerCase());
    const joints: typeof UE_JOINTS = names.map((name, at) => [
      name,
      at === 0 ? null : (names[0] as string),
      [0, 0.1, 0],
    ]);
    const facts = characterFacts(riggedGlb([], { joints }));
    assert.deepEqual(facts?.humanoid, { rig: "mixamorig", mapped: 21, required: 22, missing: ["LeftToes"] });
  });

  it("skinned levels count the primitive's own triangles and its genex_lods levels", () => {
    const { json, bin } = readGlb(riggedGlb([])) as { json: Json; bin: Uint8Array };
    json.meshes[0].primitives[0].extras = {
      genex_lods: {
        version: 1,
        indices: 0,
        levels: [
          { first: 0, count: 3, error: 0.1 },
          { first: 3, count: 3, error: 0.2 },
        ],
      },
    };
    assert.equal(characterFacts(writeGlb(json, bin))?.skinnedLevels, 3);
  });

  it("a GLB with no skinned mesh node, or one that is not a GLB, has no facts", () => {
    assert.equal(characterFacts(materialQuad({})), null);
    assert.equal(characterFacts(new Uint8Array(16)), null);
  });

  it(`a file with more than ${CHARACTER_CLIPS_MAX} clips lists the first ${CHARACTER_CLIPS_MAX} and counts them all`, () => {
    const many = Array.from({ length: CHARACTER_CLIPS_MAX + 4 }, (_, at) => ({
      name: `c${at}`,
      seconds: 1,
      travel: 0,
    }));
    const facts = characterFacts(riggedGlb(many));
    assert.equal(facts?.clips.length, CHARACTER_CLIPS_MAX);
    assert.equal(facts?.clipCount, CHARACTER_CLIPS_MAX + 4);
  });
});

describe("a receipt's character facts and report, checked before an agent sees them", () => {
  const good: CharacterFacts = {
    joints: 23,
    clips: [{ name: "Walk", seconds: 1, motion: ClipMotion.InPlace }],
    clipCount: 1,
    humanoid: { rig: "ue-mannequin", mapped: 22, required: HUMANOID_REQUIRED_BONES, missing: [] },
    skinnedLevels: 1,
  };
  it("good facts pass as they are", () => assert.deepEqual(parseCharacterFacts(good, HUMANOID_BONES), good));
  const hostile: [string, unknown][] = [
    ["not an object", "facts"],
    ["zero joints", { ...good, joints: 0 }],
    ["more joints than a skeleton has", { ...good, joints: 100_000 }],
    ["a NaN clip length", { ...good, clips: [{ ...good.clips[0], seconds: Number.NaN }] }],
    ["a negative clip length", { ...good, clips: [{ ...good.clips[0], seconds: -1 }] }],
    ["an unknown motion", { ...good, clips: [{ ...good.clips[0], motion: "teleport" }] }],
    ["a clip name past the cap", { ...good, clips: [{ ...good.clips[0], name: "x".repeat(10_000) }] }],
    ["more clips listed than counted", { ...good, clipCount: 0 }],
    [
      "more clips than the cap",
      { ...good, clips: Array(CHARACTER_CLIPS_MAX + 1).fill(good.clips[0]), clipCount: 9999 },
    ],
    ["more bones mapped than required", { ...good, humanoid: { ...good.humanoid, mapped: 23 } }],
    ["a missing list that disagrees with the count", { ...good, humanoid: { ...good.humanoid, mapped: 21 } }],
    ["an unknown missing bone", { ...good, humanoid: { ...good.humanoid, mapped: 21, missing: ["Tail"] } }],
    ["a rig id with a path in it", { ...good, humanoid: { ...good.humanoid, rig: "../etc" } }],
    ["too many skinned levels", { ...good, skinnedLevels: 99 }],
  ];
  for (const [name, value] of hostile) {
    it(`refused: ${name}`, () => assert.equal(parseCharacterFacts(value, HUMANOID_BONES), null));
  }

  const receipt = (line: Json) => ({ version: 1, files: [{ index: 0, ok: true, output: "out/0.glb", ...line }] });
  it("a receipt line with facts and report issues keeps them", () => {
    const report = [{ code: ImportIssueCode.MetallicPartial, detail: "/materials/0" }];
    const parsed = parseImportReceipt(receipt({ character: good, report }));
    assert.deepEqual(parsed?.files[0], { index: 0, ok: true, output: "out/0.glb", character: good, report });
  });
  const badLines: [string, Json][] = [
    ["hostile facts", { character: { ...good, joints: -1 } }],
    ["a report code outside the vocabulary", { report: [{ code: "made-up" }] }],
    ["a report code that is the validator's", { report: [{ code: ImportIssueCode.ValidationWarning }] }],
    ["a report detail past its cap", { report: [{ code: ImportIssueCode.MetallicPartial, detail: "/".repeat(5000) }] }],
    ["a report past its cap", { report: Array(1000).fill({ code: ImportIssueCode.MetallicPartial }) }],
  ];
  for (const [name, line] of badLines) {
    it(`a receipt line with ${name} is dropped whole (its file counts as failed)`, () =>
      assert.deepEqual(parseImportReceipt(receipt(line))?.files, []));
  }
});

describe("the importer writes the facts and report into its receipt", () => {
  it("a job over a rigged white GLB writes both on the file's line", async () => {
    const root = await realpath(await tmpDir("genex-import-report-job-"));
    for (const folder of [ImportJobLayout.In, ImportJobLayout.Out, ImportJobLayout.Tmp])
      await mkdir(path.join(root, folder), { recursive: true });
    const { json, bin } = readGlb(riggedGlb(UAL_CLIPS.slice(0, 2))) as { json: Json; bin: Uint8Array };
    json.materials = [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0.5 } }];
    json.meshes[0].primitives[0].material = 0;
    await writeFile(path.join(root, "in", "0.glb"), writeGlb(json, bin));
    const job = {
      version: 1,
      targets: [BuildTarget.Mac],
      files: [
        { index: 0, input: "in/0.glb", ext: "glb", converter: "gltf-decompress", output: "out/0.glb", name: "hero" },
      ],
    };
    await writeFile(path.join(root, ImportJobLayout.Job), JSON.stringify(job));
    assert.equal(await runImportJob(root), 0);
    const parsed = parseImportReceipt(
      JSON.parse(await readFile(path.join(root, "out", ImportJobLayout.Receipt), "utf8")),
    );
    const line = parsed?.files[0];
    assert.ok(line?.ok);
    assert.equal(line.character?.clipCount, 2);
    assert.deepEqual(
      line.report?.map((issue) => issue.code),
      [ImportIssueCode.AlbedoOutOfRange, ImportIssueCode.MetallicPartial],
    );
  });
});
