/**
 * Delivery-time import (game systems C-5): a file delivered into a Rust game is planned, validated
 * and imported into the import cache without waiting for a build, so `assets.inventory` says what
 * the import step will do with it (`ProjectAsset.import`), and the first build after the delivery
 * finds its outputs ready.
 */
import assert from "node:assert/strict";
import { cp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cachedImporter, openAssetCache } from "../../src/main/asset-cache.ts";
import { AssetService, cacheWarmer, type DeliveryImports } from "../../src/main/core/assets.ts";
import { type ImportSandbox, importStagedAssets, type RustAssetImportDeps } from "../../src/main/rust-assets.ts";
import type { StudioCore } from "../../src/main/studio-core.ts";
import { ImportIssueCode } from "../../src/shared/asset-db.ts";
import { AssetImportRefusal, AssetImportStatus, type ProjectAsset } from "../../src/shared/game-assets.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { meshToGlb, readGlb, writeGlb } from "../../src/substrate/asset-import/glb.ts";
import { ImportAction } from "../../src/substrate/asset-import/import-plan.ts";
import { ImportJobLayout } from "../../src/substrate/asset-import/job.ts";
import { runImportJob } from "../../src/substrate/asset-import/worker.ts";
import type { RunResult } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

const SAMPLES = fileURLToPath(new URL("../fixtures/asset-previews/", import.meta.url));
// biome-ignore lint/suspicious/noExplicitAny: a glTF's JSON, read and edited as data
type Json = Record<string, any>;

/** Every importer job started: the files its `job.json` named. */
interface JobLog {
  jobs: string[][];
}

/** Import deps whose sandbox runs the real importer in this process, counting jobs (the sandbox is `rust-assets.test.ts`'s subject). */
function countingDeps(jobsRoot: string, log: JobLog): RustAssetImportDeps {
  return {
    jobsRoot,
    secretPaths: [],
    sandboxFor: async (): Promise<ImportSandbox> => ({
      run: async (request): Promise<RunResult> => {
        const job = JSON.parse(await readFile(path.join(request.cwd, ImportJobLayout.Job), "utf8"));
        log.jobs.push(job.files.map((file: { name: string; ext: string }) => `${file.name}.${file.ext}`));
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

/** The Draco sample with one more required extension the runtime does not read. */
async function basisuDracoGlb(): Promise<Uint8Array> {
  const { json, bin } = readGlb(new Uint8Array(await readFile(path.join(SAMPLES, "compressed.glb")))) as {
    json: Json;
    bin: Uint8Array;
  };
  json.extensionsUsed = [...(json.extensionsUsed ?? []), "KHR_texture_basisu"];
  json.extensionsRequired = [...(json.extensionsRequired ?? []), "KHR_texture_basisu"];
  return writeGlb(json, bin);
}

/** A plain quad whose normals are not unit length: the validator warns, and the file imports. */
function warnedQuad(): Uint8Array {
  return meshToGlb({
    name: "quad",
    materials: [],
    primitives: [
      {
        positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
        indices: Uint32Array.from([0, 1, 2, 2, 1, 3]),
        normals: Float32Array.from([0, 0, 2, 0, 0, 2, 0, 0, 2, 0, 0, 2]),
      },
    ],
  });
}

interface Rig {
  root: string;
  game: string;
  log: JobLog;
  deps: RustAssetImportDeps;
  service: AssetService;
  cache: ReturnType<typeof openAssetCache>;
  /** The files each delivery import was asked for. */
  asked: string[][];
}

/** A Rust game (a `genex.toml`, no page) and an `AssetService` over a fake core whose delivery imports run through a real cache. */
async function rig(options: { rust?: boolean } = {}): Promise<Rig> {
  const root = await realpath(await tmpDir("genex-import-facts-"));
  const game = path.join(root, "game");
  const scratch = path.join(root, "scratch");
  const engineHomes = path.join(root, "engines");
  for (const folder of [path.join(game, "assets"), scratch, engineHomes]) await mkdir(folder, { recursive: true });
  if (options.rust !== false) await writeFile(path.join(game, "genex.toml"), '[game]\nname = "facts"\n');
  else await writeFile(path.join(game, "index.html"), "<!doctype html><title>web</title>");
  const log: JobLog = { jobs: [] };
  const deps = countingDeps(path.join(root, "jobs"), log);
  const cache = openAssetCache({ root: path.join(root, "cache") });
  const core = {
    games: { dirFor: () => game, factsOf: async () => [] },
    layout: { scratch, engineHomes },
    assetCheckpoints: { records: async () => [] },
    options: {},
  } as unknown as StudioCore;
  const warmer = cacheWarmer(cache, deps, BuildTarget.Mac);
  const asked: string[][] = [];
  const imports: DeliveryImports = {
    run: (gameRoot, files, signal) => {
      asked.push([...files]);
      return warmer.run(gameRoot, files, signal);
    },
  };
  const service = new AssetService(core, async () => "", Date.now, new Map(), { imports });
  return { root, game, log, deps, service, cache, asked };
}

async function inventoryRow(service: AssetService, file: string): Promise<ProjectAsset | undefined> {
  return (await service.projectAssets("game")).assets.find((asset) => asset.file === file);
}

describe("delivery-time import facts in assets.inventory", () => {
  it("a delivered Draco GLB requiring an extension the runtime does not read shows import.refusal unsupported-extension", async () => {
    const { game, service } = await rig();
    await writeFile(path.join(game, "assets", "ship.glb"), await basisuDracoGlb());
    await service.warmImports?.("game", ["assets/ship.glb"]);
    const ship = await inventoryRow(service, "assets/ship.glb");
    assert.equal(ship?.kind, "model");
    assert.deepEqual(ship?.import, {
      status: AssetImportStatus.Refused,
      refusal: AssetImportRefusal.UnsupportedExtension,
    });
  });

  it("the first build after a delivery finds the outputs ready: no importer job runs, and the stage holds the same output", async () => {
    const { root, game, log, deps, service, cache } = await rig();
    await cp(path.join(SAMPLES, "compressed.glb"), path.join(game, "assets", "ship.glb"));
    await cp(path.join(SAMPLES, "model.obj"), path.join(game, "assets", "crate.obj"));
    await service.warmImports("game", ["assets/ship.glb", "assets/crate.obj"]);
    assert.equal(log.jobs.length, 1, "the delivery ran one importer job");
    assert.deepEqual((await inventoryRow(service, "assets/ship.glb"))?.import, { status: AssetImportStatus.Ready });
    const stage = path.join(root, "stage");
    await cp(game, stage, { recursive: true });
    const report = await importStagedAssets(deps, {
      stage,
      target: BuildTarget.Mac,
      importFile: cachedImporter(cache),
    });
    assert.equal(log.jobs.length, 1, "the build started no importer job");
    const rows = report?.files.filter((row) => row.output) ?? [];
    assert.deepEqual(
      rows.map((row) => row.output?.file),
      ["assets/crate.glb", "assets/ship.glb"],
    );
    const placed = await readFile(path.join(stage, "assets", "ship.glb"));
    assert.equal(rows[1]?.output?.bytes, placed.byteLength);
  });

  it("validator warnings reach the inventory as issues, by code and pointer, from a fresh import and from the cache", async () => {
    const first = await rig();
    await writeFile(path.join(first.game, "assets", "quad.glb"), warnedQuad());
    await first.service.warmImports("game", ["assets/quad.glb"]);
    const fresh = (await inventoryRow(first.service, "assets/quad.glb"))?.import;
    assert.equal(fresh?.status, AssetImportStatus.Ready);
    const warning = fresh?.issues?.find((issue) => issue.detail?.startsWith("ACCESSOR_VECTOR3_NON_UNIT"));
    assert.equal(warning?.code, ImportIssueCode.ValidationWarning);
    assert.match(warning?.detail ?? "", /^ACCESSOR_VECTOR3_NON_UNIT \/meshes\/0\/primitives\/0\/attributes\/NORMAL$/);
    // A second service over the same cache (a restarted app): the hit carries the same issues.
    const restarted = await rig();
    const service = new AssetService(
      {
        games: { dirFor: () => first.game, factsOf: async () => [] },
        layout: { scratch: path.join(restarted.root, "scratch"), engineHomes: path.join(restarted.root, "engines") },
        assetCheckpoints: { records: async () => [] },
        options: {},
      } as unknown as StudioCore,
      async () => "",
      Date.now,
      new Map(),
      { imports: cacheWarmer(first.cache, first.deps, BuildTarget.Mac) },
    );
    await service.warmImports("game", ["assets/quad.glb"]);
    assert.equal(first.log.jobs.length, 1, "the cache hit ran no job");
    assert.deepEqual((await inventoryRow(service, "assets/quad.glb"))?.import, fresh);
  });
});

describe("which files a delivery-time import reads, and when", () => {
  it("before its import a Rust game's importer file is pending, a kept file ready and a format the stack cannot load refused; the read starts the import", async () => {
    const { game, service, log } = await rig();
    await cp(path.join(SAMPLES, "compressed.glb"), path.join(game, "assets", "ship.glb"));
    await cp(path.join(SAMPLES, "tone.wav"), path.join(game, "assets", "tone.wav"));
    await cp(path.join(SAMPLES, "animated.fbx"), path.join(game, "assets", "hero.fbx"));
    await cp(path.join(SAMPLES, "notes.json"), path.join(game, "assets", "notes.json"));
    const listed = await service.projectAssets("game");
    const facts: Record<string, ProjectAsset["import"]> = Object.fromEntries(
      listed.assets.map((asset) => [asset.file, asset.import]),
    );
    assert.equal(facts["assets/notes.json"], undefined, "a format the import step does not know has no facts");
    assert.deepEqual(facts, {
      "assets/ship.glb": { status: AssetImportStatus.Pending },
      "assets/tone.wav": { status: AssetImportStatus.Ready },
      "assets/hero.fbx": { status: AssetImportStatus.Refused, refusal: AssetImportRefusal.UnsupportedByRust },
    });
    await service.importsSettled("game");
    assert.equal(log.jobs.length, 1, "the read started one import");
    assert.deepEqual((await inventoryRow(service, "assets/ship.glb"))?.import, { status: AssetImportStatus.Ready });
    await service.projectAssets("game");
    await service.importsSettled("game");
    assert.equal(log.jobs.length, 1, "a known file is not imported again");
  });

  it("a file changed after its import is pending again, and its new bytes are imported", async () => {
    const { game, service, log } = await rig();
    const ship = path.join(game, "assets", "ship.glb");
    await cp(path.join(SAMPLES, "compressed.glb"), ship);
    await service.warmImports("game", ["assets/ship.glb"]);
    await writeFile(ship, await basisuDracoGlb());
    assert.deepEqual((await inventoryRow(service, "assets/ship.glb"))?.import, { status: AssetImportStatus.Pending });
    await service.importsSettled("game");
    assert.equal(log.jobs.length, 2);
    assert.equal(
      (await inventoryRow(service, "assets/ship.glb"))?.import?.refusal,
      AssetImportRefusal.UnsupportedExtension,
    );
  });

  it("a Three.js game's assets carry no import facts and start no import", async () => {
    const { game, service, log } = await rig({ rust: false });
    await cp(path.join(SAMPLES, "compressed.glb"), path.join(game, "assets", "ship.glb"));
    await service.warmImports("game", ["assets/ship.glb"]);
    assert.equal((await inventoryRow(service, "assets/ship.glb"))?.import, undefined);
    await service.importsSettled("game");
    assert.equal(log.jobs.length, 0);
  });

  it("hostile delivered names are refused before any import: nothing outside the game is read or written", async () => {
    const { root, game, service, log, asked } = await rig();
    const outside = path.join(root, "outside.glb");
    await cp(path.join(SAMPLES, "compressed.glb"), outside);
    await mkdir(path.join(root, "elsewhere"));
    await cp(outside, path.join(root, "elsewhere", "x.glb"));
    await symlink(outside, path.join(game, "assets", "link.glb"));
    await symlink(path.join(root, "elsewhere"), path.join(game, "assets", "linked"));
    await mkdir(path.join(game, "assets", "folder.glb"));
    await service.warmImports("game", [
      "../outside.glb",
      "/etc/hosts",
      "assets/../../outside.glb",
      "assets/missing.glb",
      "assets/link.glb",
      "assets/linked/x.glb",
      "assets/folder.glb",
    ]);
    assert.deepEqual(asked, [], "no hostile name reaches the import");
    assert.equal(log.jobs.length, 0);
    assert.equal(
      (await inventoryRow(service, "assets/link.glb"))?.import,
      undefined,
      "a link is not listed as an asset",
    );
    assert.deepEqual(await readFile(outside), await readFile(path.join(SAMPLES, "compressed.glb")));
  });
});

describe("a delivery-time import when the core stops", () => {
  it("stopping ends an import in flight, keeps no facts from it, and starts none after", async () => {
    const { game } = await rig();
    await cp(path.join(SAMPLES, "compressed.glb"), path.join(game, "assets", "ship.glb"));
    const runs: string[][] = [];
    let started: () => void = () => {};
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const service = new AssetService(
      {
        games: { dirFor: () => game, factsOf: async () => [] },
        layout: { scratch: game, engineHomes: game },
        assetCheckpoints: { records: async () => [] },
        options: {},
      } as unknown as StudioCore,
      async () => "",
      Date.now,
      new Map(),
      {
        imports: {
          run: (_root, files, signal) => {
            runs.push([...files]);
            started();
            return new Promise((resolve) =>
              signal?.addEventListener("abort", () =>
                resolve(files.map((file) => ({ file, action: ImportAction.Keep }))),
              ),
            );
          },
        },
      },
    );
    const warming = service.warmImports("game", ["assets/ship.glb"]);
    await running;
    await service.stopImports();
    await warming;
    assert.deepEqual((await inventoryRow(service, "assets/ship.glb"))?.import, { status: AssetImportStatus.Pending });
    await service.warmImports("game", ["assets/ship.glb"]);
    assert.equal(runs.length, 1, "no import starts once stopped");
  });
});
