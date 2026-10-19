/**
 * The content-addressed import cache (game systems C-3): an unchanged build runs no importer job,
 * a changed `[[texture]]` row or dependency re-imports exactly its file, an interrupted job leaves
 * its `.pending` marker and re-runs, hostile cache entries are refused with no side effect, and
 * the LRU cap never evicts an entry a running build holds.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AssetCacheRefusal,
  type AssetCache,
  beginEntry,
  type CachedImportRequest,
  commitEntry,
  evictEntries,
  holdEntries,
  importCacheKey,
  type ImportCacheKeyInput,
  importWithCache,
  lookupEntry,
  openAssetCache,
} from "../../src/main/asset-cache.ts";
import { type ImportSandbox, importRustAssets, type RustAssetImportDeps } from "../../src/main/rust-assets.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import { AssetImportRefusal, ImportConverter } from "../../src/substrate/asset-import/import-plan.ts";
import { IMPORT_JOB_VERSION, ImportJobLayout } from "../../src/substrate/asset-import/job.ts";
import { TextureCompression } from "../../src/substrate/asset-import/texture-table.ts";
import { runImportJob } from "../../src/substrate/asset-import/worker.ts";
import type { RunResult } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

const SAMPLES = fileURLToPath(new URL("../fixtures/asset-previews/", import.meta.url));
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const MIB = 1024 * 1024;

/** Every importer job a build started: the files its `job.json` named. */
interface JobLog {
  jobs: string[][];
}

/**
 * Import deps whose sandbox runs the real importer in this process (the job folder is its cwd),
 * counting jobs: the sandbox itself is `rust-assets.test.ts`'s subject.
 */
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

const GAME_FILES = ["model.obj", "model.mtl", "model.stl", "model.ply", "texture.ktx2", "tone.wav"] as const;
const IMPORTED = [
  "assets/model.obj",
  "assets/model.stl",
  "assets/model.ply",
  "assets/texture.ktx2",
  "assets/rock.ktx2",
];

async function makeGame(): Promise<{ root: string; game: string; outside: string }> {
  const root = await realpath(await tmpDir("genex-asset-cache-"));
  const game = path.join(root, "game");
  const outside = path.join(root, "outside");
  await mkdir(path.join(game, "assets"), { recursive: true });
  await mkdir(outside);
  for (const name of GAME_FILES) await copyFile(path.join(SAMPLES, name), path.join(game, "assets", name));
  await copyFile(path.join(SAMPLES, "texture.ktx2"), path.join(game, "assets", "rock.ktx2"));
  return { root, game, outside };
}

/** `[[texture]]` rows, by path: what a build reads from `genex.toml`. */
type TextureRows = Record<string, { usage: string }>;

function request(game: string, rows: TextureRows, files = [...IMPORTED, "assets/tone.wav"]): CachedImportRequest {
  return {
    gameRoot: game,
    stack: GameStack.RustWgpu,
    files,
    targets: [BuildTarget.Mac],
    tools: { "basis-encoder": "2.50" },
    settingsFor: (file) => rows[file] ?? {},
  };
}

/** A folder's names and file digests, recursively, links named but never followed. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const rel = path.relative(dir, full);
    if (entry.isSymbolicLink()) out[rel] = "link";
    else if (entry.isFile()) out[rel] = sha(await readFile(full));
    else out[rel] = "dir";
  }
  return out;
}

describe("the import cache key", () => {
  const base: ImportCacheKeyInput = {
    source: sha("source"),
    converter: ImportConverter.ObjToGlb,
    name: "ship",
    settings: { usage: "color", scale: 1 },
    jobVersion: IMPORT_JOB_VERSION,
    tools: { "basis-encoder": "a", draco: "b" },
    deps: { mtl: sha("mtl") },
    families: [TextureCompression.Bc, TextureCompression.Rgba8],
  };

  it("is a sha256 that ignores key order and family order", () => {
    const key = importCacheKey(base);
    assert.match(key, /^[0-9a-f]{64}$/);
    const reordered = importCacheKey({
      ...base,
      settings: { scale: 1, usage: "color" },
      tools: { draco: "b", "basis-encoder": "a" },
      families: [TextureCompression.Rgba8, TextureCompression.Bc],
    });
    assert.equal(reordered, key);
  });

  const changes: Array<[string, Partial<ImportCacheKeyInput>]> = [
    ["the source digest", { source: sha("other") }],
    ["the converter", { converter: ImportConverter.StlToGlb }],
    ["the model's name", { name: "boat" }],
    ["a setting", { settings: { usage: "normal", scale: 1 } }],
    ["the importer version", { jobVersion: IMPORT_JOB_VERSION + 1 }],
    ["a tool digest", { tools: { "basis-encoder": "a", draco: "c" } }],
    ["a dependency digest", { deps: { mtl: sha("other mtl") } }],
    ["the family set", { families: [TextureCompression.Astc, TextureCompression.Rgba8] }],
  ];
  for (const [what, change] of changes) {
    it(`changes with ${what}`, () => {
      assert.notEqual(importCacheKey({ ...base, ...change }), importCacheKey(base));
    });
  }
});

/** One test's game, cache and counted importer, fresh for each test. */
interface GameContext {
  root: string;
  game: string;
  outside: string;
  cache: AssetCache;
  log: JobLog;
  deps: RustAssetImportDeps;
}

const ROWS: TextureRows = { "assets/texture.ktx2": { usage: "color" }, "assets/rock.ktx2": { usage: "color" } };

/** A fresh {@link GameContext} before each test of the calling suite. */
function useGame(): GameContext {
  const ctx = {} as GameContext;
  beforeEach(async () => {
    const made = await makeGame();
    const log: JobLog = { jobs: [] };
    Object.assign(ctx, {
      ...made,
      cache: openAssetCache({ root: path.join(made.root, "asset-cache") }),
      log,
      deps: countingDeps(path.join(made.root, "jobs"), log),
    });
  });
  return ctx;
}

const POSIX_ONLY = { skip: process.platform === "win32" && "POSIX links" };

/** A hostile change to a committed entry, and the refusal it must meet. */
type HostileRow = [string, AssetCacheRefusal, (entry: string, outside: string) => Promise<void>];

const receiptOf = async (entry: string) => JSON.parse(await readFile(path.join(entry, "receipt.json"), "utf8"));
const outputOf = async (entry: string) =>
  (await readdir(entry)).find((name) => name !== "receipt.json") ?? assert.fail("no output");

const HOSTILE: HostileRow[] = [
  [
    "the entry is a link to a folder outside the cache",
    AssetCacheRefusal.NotFolder,
    async (entry, outside) => {
      await rm(path.join(outside, "planted"), { recursive: true, force: true });
      await copyDir(entry, path.join(outside, "planted"));
      await rm(entry, { recursive: true });
      await symlink(path.join(outside, "planted"), entry);
    },
  ],
  [
    "the receipt's own digest does not match its body",
    AssetCacheRefusal.ReceiptDigest,
    async (entry) => {
      const receipt = await receiptOf(entry);
      receipt.files[0].bytes += 1;
      await writeFile(path.join(entry, "receipt.json"), JSON.stringify(receipt));
    },
  ],
  [
    "the receipt names another key",
    AssetCacheRefusal.BadReceipt,
    async (entry) => {
      const receipt = await receiptOf(entry);
      receipt.key = "0".repeat(64);
      await writeFile(path.join(entry, "receipt.json"), JSON.stringify(rehash(receipt)));
    },
  ],
  [
    "the receipt names a file outside the entry",
    AssetCacheRefusal.BadReceipt,
    async (entry, outside) => {
      const receipt = await receiptOf(entry);
      // A real file of the right size waits there, so only the name rule can refuse it.
      await copyFile(path.join(entry, receipt.files[0].name), path.join(outside, "secret.glb"));
      receipt.files[0].name = "../../outside/secret.glb";
      await writeFile(path.join(entry, "receipt.json"), JSON.stringify(rehash(receipt)));
    },
  ],
  [
    "the receipt is a link",
    AssetCacheRefusal.BadReceipt,
    async (entry, outside) => {
      await copyFile(path.join(entry, "receipt.json"), path.join(outside, "receipt.json"));
      await rm(path.join(entry, "receipt.json"));
      await symlink(path.join(outside, "receipt.json"), path.join(entry, "receipt.json"));
    },
  ],
  [
    "an output is a link to a file outside",
    AssetCacheRefusal.OutputNotRegular,
    async (entry, outside) => {
      const name = await outputOf(entry);
      await copyFile(path.join(entry, name), path.join(outside, "secret.glb"));
      await rm(path.join(entry, name));
      await symlink(path.join(outside, "secret.glb"), path.join(entry, name));
    },
  ],
  [
    "an output was truncated",
    AssetCacheRefusal.OutputSize,
    async (entry) => {
      const name = await outputOf(entry);
      await writeFile(path.join(entry, name), "glTF");
    },
  ],
  [
    "an output is missing",
    AssetCacheRefusal.OutputNotRegular,
    async (entry) => {
      await rm(path.join(entry, await outputOf(entry)));
    },
  ],
];

describe("importing through the cache", POSIX_ONLY, () => {
  const ctx = useGame();

  it("an unchanged second build spawns 0 importer jobs and answers the same outputs", {
    timeout: 120_000,
  }, async () => {
    const first = await importWithCache(ctx.cache, ctx.deps, request(ctx.game, ROWS));
    first.release();
    assert.equal(ctx.log.jobs.length, 1);
    assert.deepEqual(ctx.log.jobs[0], ["model.obj", "model.stl", "model.ply", "texture.ktx2", "rock.ktx2"]);
    assert.equal(first.misses, 5);
    const second = await importWithCache(ctx.cache, ctx.deps, request(ctx.game, ROWS));
    second.release();
    assert.equal(ctx.log.jobs.length, 1, "no importer job on an unchanged build");
    assert.equal(second.hits, 5);
    assert.equal(second.job, undefined);
    const strip = (files: typeof first.files) =>
      files.map(({ output, families, ...rest }) => ({
        ...rest,
        output: output && { file: output.file, bytes: output.bytes, sha256: output.sha256 },
        families: families?.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 })),
      }));
    assert.deepEqual(strip(second.files), strip(first.files));
    for (const entry of second.files) {
      if (!entry.output) continue;
      assert.equal(sha(await readFile(entry.output.path)), entry.output.sha256, entry.file);
      assert.ok(entry.output.path.startsWith(ctx.cache.root + path.sep), "served from the cache");
    }
    assert.equal(second.files.find((entry) => entry.file === "assets/model.obj")?.output?.file, "assets/model.glb");
  });

  it("changing one [[texture]] row re-imports exactly that file", { timeout: 120_000 }, async () => {
    (await importWithCache(ctx.cache, ctx.deps, request(ctx.game, ROWS))).release();
    const changed = { ...ROWS, "assets/rock.ktx2": { usage: "data" } };
    const second = await importWithCache(ctx.cache, ctx.deps, request(ctx.game, changed));
    second.release();
    assert.deepEqual(ctx.log.jobs[1], ["rock.ktx2"]);
    assert.equal(second.hits, 4);
    assert.equal(second.misses, 1);
  });

  it("changing an OBJ's material library re-imports the OBJ alone", { timeout: 120_000 }, async () => {
    (await importWithCache(ctx.cache, ctx.deps, request(ctx.game, ROWS))).release();
    await writeFile(path.join(ctx.game, "assets", "model.mtl"), "newmtl other\nKd 1 0 0\n");
    (await importWithCache(ctx.cache, ctx.deps, request(ctx.game, ROWS))).release();
    assert.deepEqual(ctx.log.jobs[1], ["model.obj"]);
  });

  it("the same content under a new path is a hit, named beside its new path", { timeout: 120_000 }, async () => {
    (await importWithCache(ctx.cache, ctx.deps, request(ctx.game, ROWS, ["assets/model.stl"]))).release();
    await mkdir(path.join(ctx.game, "assets", "props"));
    await copyFile(path.join(ctx.game, "assets", "model.stl"), path.join(ctx.game, "assets", "props", "model.stl"));
    const moved = await importWithCache(ctx.cache, ctx.deps, request(ctx.game, ROWS, ["assets/props/model.stl"]));
    moved.release();
    assert.equal(ctx.log.jobs.length, 1);
    assert.equal(moved.files[0]?.output?.file, "assets/props/model.glb");
  });
});

describe("interrupted and failed imports", POSIX_ONLY, () => {
  const ctx = useGame();

  it("a killed job leaves .pending, and the next build re-runs it rather than reading partial outputs", {
    timeout: 120_000,
  }, async () => {
    const killed: typeof importRustAssets = async (d, r) => {
      await importRustAssets(d, r);
      throw new Error("the host died before the cache commit");
    };
    await assert.rejects(importWithCache(ctx.cache, ctx.deps, request(ctx.game, ROWS, ["assets/model.stl"]), killed));
    const pending = (await readdir(ctx.cache.root)).filter((name) => name.endsWith(".pending"));
    assert.equal(pending.length, 1, "the marker stays");
    const key = pending[0]?.replace(/\.pending$/, "") ?? assert.fail("no marker");
    assert.equal((await lookupEntry(ctx.cache, key)).refusal, AssetCacheRefusal.Pending);
    // A complete-looking entry beside a marker is never read either.
    await mkdir(path.join(ctx.cache.root, key));
    assert.equal((await lookupEntry(ctx.cache, key)).refusal, AssetCacheRefusal.Pending);
    await rm(path.join(ctx.cache.root, key), { recursive: true });
    const again = await importWithCache(ctx.cache, ctx.deps, request(ctx.game, ROWS, ["assets/model.stl"]));
    again.release();
    assert.equal(ctx.log.jobs.length, 2, "the interrupted import ran again");
    assert.deepEqual(
      (await readdir(ctx.cache.root)).filter((name) => name.endsWith(".pending")),
      [],
      "removed after the rename",
    );
    assert.equal((await lookupEntry(ctx.cache, key)).ok, true);
  });

  it("an importer failure is not cached: the next build tries again", { timeout: 120_000 }, async () => {
    const failing: RustAssetImportDeps = {
      ...ctx.deps,
      sandboxFor: async () => ({
        run: async () => {
          throw new Error("sandbox unavailable");
        },
        dispose: async () => {},
      }),
    };
    const first = await importWithCache(ctx.cache, failing, request(ctx.game, ROWS, ["assets/model.stl"]));
    first.release();
    assert.equal(first.files[0]?.refusal, AssetImportRefusal.ImporterFailed);
    const second = await importWithCache(ctx.cache, ctx.deps, request(ctx.game, ROWS, ["assets/model.stl"]));
    second.release();
    assert.equal(ctx.log.jobs.length, 1);
    assert.equal(second.misses, 1);
    assert.ok(second.files[0]?.output);
  });
});

describe("hostile cache entries are refused with no side effect", POSIX_ONLY, () => {
  const ctx = useGame();

  /** The key a build of `assets/model.stl` looks up, and its entry as the cache wrote it. */
  async function seeded(): Promise<{ key: string; entry: string }> {
    (await importWithCache(ctx.cache, ctx.deps, request(ctx.game, ROWS, ["assets/model.stl"]))).release();
    const [key] = (await readdir(ctx.cache.root)).filter((name) => /^[0-9a-f]{64}$/.test(name));
    assert.ok(key);
    return { key, entry: path.join(ctx.cache.root, key) };
  }

  for (const [what, refusal, plant] of HOSTILE) {
    it(what, { timeout: 120_000 }, async () => {
      const { key, entry } = await seeded();
      await plant(entry, ctx.outside);
      const before = { outside: await snapshot(ctx.outside), cache: await snapshot(ctx.cache.root) };
      const looked = await lookupEntry(ctx.cache, key);
      assert.equal(looked.ok, false);
      assert.equal(looked.refusal, refusal);
      assert.deepEqual(await snapshot(ctx.outside), before.outside, "nothing outside the cache changed");
      assert.deepEqual(await snapshot(ctx.cache.root), before.cache, "the lookup changed nothing in the cache");
      // The build re-imports instead of serving it, and replaces the entry without following it.
      const rebuilt = await importWithCache(ctx.cache, ctx.deps, request(ctx.game, ROWS, ["assets/model.stl"]));
      rebuilt.release();
      assert.equal(ctx.log.jobs.length, 2);
      assert.equal(rebuilt.misses, 1);
      assert.deepEqual(await snapshot(ctx.outside), before.outside, "the replacement never wrote through a link");
      assert.equal((await lookupEntry(ctx.cache, key)).ok, true);
      assert.equal((await lstat(entry)).isDirectory(), true);
    });
  }

  it("a line outside the import vocabularies is a miss, re-imported", { timeout: 120_000 }, async () => {
    const { key, entry } = await seeded();
    for (const meta of [{ action: "run-anything" }, { action: "convert", converter: "obj-to-glb", output: 9 }]) {
      const receipt = await receiptOf(entry);
      receipt.meta = { ...receipt.meta, ...meta };
      await writeFile(path.join(entry, "receipt.json"), JSON.stringify(rehash(receipt)));
      assert.equal((await lookupEntry(ctx.cache, key)).ok, true, "the entry itself checks out");
      const rebuilt = await importWithCache(ctx.cache, ctx.deps, request(ctx.game, ROWS, ["assets/model.stl"]));
      rebuilt.release();
      assert.equal(rebuilt.misses, 1, JSON.stringify(meta));
    }
    assert.equal(ctx.log.jobs.length, 3);
  });

  it("a key that is not a sha256 is refused before any path is built", async () => {
    for (const key of ["../outside", "", "A".repeat(64), `${"0".repeat(63)}/`, "0".repeat(65)]) {
      assert.equal((await lookupEntry(ctx.cache, key)).refusal, AssetCacheRefusal.BadKey, key);
    }
  });
});

/** A receipt whose own digest was recomputed after an edit (an attacker who knows the format). */
function rehash(receipt: Record<string, unknown>): Record<string, unknown> {
  const { digest: _digest, ...body } = receipt;
  return { ...body, digest: sha(canonical(body)) };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

async function copyDir(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const name of await readdir(from)) await copyFile(path.join(from, name), path.join(to, name));
}

describe("retention: LRU to a cap, never an entry a build holds", {
  skip: process.platform === "win32" && "POSIX",
}, () => {
  let root: string;
  let clock: number;
  let cache: AssetCache;

  beforeEach(async () => {
    root = await realpath(await tmpDir("genex-asset-cache-lru-"));
    clock = 1_000_000;
    cache = openAssetCache({ root: path.join(root, "cache"), capBytes: 3 * MIB, now: () => clock });
  });

  /** An entry of `mib` MiB under a fresh key, committed at the current clock. */
  async function put(name: string, mib: number): Promise<string> {
    const key = sha(name);
    const file = path.join(root, `${name}.bin`);
    await writeFile(file, Buffer.alloc(mib * MIB, name.charCodeAt(0)));
    await beginEntry(cache, key);
    assert.ok(await commitEntry(cache, key, [file], { name }));
    clock += 1000;
    return key;
  }

  it("evicts least recently used first, a hit counting as a use", async () => {
    const a = await put("a", 1);
    const b = await put("b", 1);
    const c = await put("c", 1);
    assert.equal((await lookupEntry(cache, a)).ok, true, "a is used again");
    clock += 1000;
    await put("d", 1);
    const report = await evictEntries(cache);
    assert.deepEqual(report.evicted, [b]);
    assert.equal(report.keptBytes <= 3 * MIB, true);
    assert.equal((await lookupEntry(cache, b)).refusal, AssetCacheRefusal.Missing);
    for (const key of [a, c]) assert.equal((await lookupEntry(cache, key)).ok, true);
  });

  it("never evicts an entry a running build holds, even past the cap", async () => {
    const a = await put("a", 2);
    const b = await put("b", 2);
    const release = holdEntries(cache, [a, b]);
    const held = await evictEntries(cache);
    assert.deepEqual(held.evicted, []);
    assert.equal(held.keptBytes, 4 * MIB, "over the cap while held");
    release();
    const freed = await evictEntries(cache);
    assert.deepEqual(freed.evicted, [a]);
  });

  it("ignores what is not an entry it wrote: links, stray files and other names stay untouched", async () => {
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "keep.bin"), Buffer.alloc(4 * MIB));
    await put("a", 1);
    await symlink(outside, path.join(cache.root, sha("link")));
    await writeFile(path.join(cache.root, "notes.txt"), "x");
    const report = await evictEntries(cache);
    assert.deepEqual(report.evicted, []);
    assert.equal((await stat(path.join(outside, "keep.bin"))).size, 4 * MIB);
    assert.equal((await lstat(path.join(cache.root, sha("link")))).isSymbolicLink(), true);
  });
});

describe("incremental cost", { skip: process.platform === "win32" && "POSIX" }, () => {
  it("100 unchanged files resolve from the cache (advisory budget: under 200 ms)", { timeout: 300_000 }, async (t) => {
    const { root, game } = await makeGame();
    const files: string[] = [];
    const obj = await readFile(path.join(SAMPLES, "model.obj"), "utf8");
    await mkdir(path.join(game, "assets", "many"), { recursive: true });
    for (let at = 0; at < 100; at++) {
      const file = `assets/many/m${at}.obj`;
      // Each file differs by a trailing comment line, so each is its own entry.
      await writeFile(path.join(game, file), `${obj}\n# copy ${at}\n`);
      files.push(file);
    }
    const cache = openAssetCache({ root: path.join(root, "asset-cache") });
    const log: JobLog = { jobs: [] };
    const deps = countingDeps(path.join(root, "jobs"), log);
    (await importWithCache(cache, deps, request(game, {}, files))).release();
    const times: number[] = [];
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      const again = await importWithCache(cache, deps, request(game, {}, files));
      times.push(performance.now() - started);
      again.release();
      assert.equal(again.hits, 100);
    }
    assert.equal(log.jobs.length, 1);
    const median = times.sort((x, y) => x - y)[1] ?? 0;
    t.diagnostic(
      `incremental: ${median.toFixed(1)} ms per 100 unchanged files (runs ${times.map((x) => x.toFixed(1)).join(", ")})`,
    );
  });
});
