import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reconcileGeneratedAssets } from "../../src/main/game-assets.ts";
import { validateArguments, validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { readFile } from "node:fs/promises";

test("retained generated originals survive missing delivery and renamed local copies retain provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-reliability-"));
  try {
    const id = "11111111-1111-4111-8111-111111111111",
      game = path.join(root, "game"),
      output = path.join(root, "genex/projects/game/jobs", id, "output");
    await mkdir(output, { recursive: true });
    await mkdir(path.join(game, "assets"), { recursive: true });
    const bytes = Buffer.alloc(6 * 1024 ** 2, 42);
    await writeFile(path.join(output, "trout.glb"), bytes);
    const jobs = [
      { id, generationId: "existing-trout", files: [`assets/genex/${id}/trout.glb`], status: "downloaded" },
    ];
    const empty = () => ({ project: "game", assets: [], truncated: false, skipped: [] });
    const missing = await reconcileGeneratedAssets(game, root, empty(), jobs);
    assert.equal(missing.assets.length, 1);
    assert.equal(missing.assets[0]!.availability!.originalAvailable, true);
    assert.deepEqual(
      missing.assets[0]!.availability!.deliveries,
      [],
      "no copy anywhere: where the file is lives in availability, not in a sentence",
    );
    assert.equal(missing.assets[0]!.pluginStatus, "downloaded");
    await writeFile(path.join(game, "assets/hero.glb"), bytes);
    const local = await reconcileGeneratedAssets(
      game,
      root,
      {
        ...empty(),
        assets: [{ file: "assets/hero.glb", kind: "model", bytes: bytes.length, mtime: "now", source: "imported" }],
      },
      jobs,
    );
    assert.equal(local.assets.length, 1);
    assert.equal(local.assets[0]!.generationId, "existing-trout");
    assert.equal(local.assets[0]!.availability!.deliveries[0]!.present, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Genex options accept objects and legacy JSON but refuse malformed values before dispatch", async () => {
  const manifest = validateManifest(
    JSON.parse(await readFile(new URL("../../src/plugins/genex/plugin.json", import.meta.url), "utf8")),
  );
  const tool = manifest.tools.find((t) => t.name === "asset")!;
  validateArguments(tool, { operation: "sfx", options: { duration: 2 } });
  validateArguments(tool, { operation: "sfx", options: '{"duration":2}' });
  for (const options of [null, [], 123, "null", "[]", "invalid"])
    assert.throws(() => validateArguments(tool, { operation: "sfx", options }));
});
test("Blender declares its model input and one consistent 100 MiB output boundary", async () => {
  const manifest = validateManifest(
    JSON.parse(await readFile(new URL("../../src/plugins/blender/plugin.json", import.meta.url), "utf8")),
  );
  assert.deepEqual(manifest.nativeJobs!.find((j) => j.id === "transform")!.inputs, ["script", "model"]);
  assert.equal(manifest.assetLimits, undefined);
  assert.ok(manifest.nativeJobs!.every((j) => j.maxAssetBytes === 100 * 1024 ** 2));
});

import { AssetCheckpoints } from "../../src/main/asset-checkpoints.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GIT_ENV } from "../../src/substrate/snapshots.ts";
import { markDeployment, verifyDeployment } from "../../src/plugins/genex/deployment.ts";
const exec = promisify(execFile);
test("host checkpoint preserves unrelated staged and unstaged changes and refuses edited deliveries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-checkpoint-"));
  const git = async (...args: string[]) =>
    (await exec("git", args, { cwd: root, env: { ...process.env, ...GIT_ENV } })).stdout.trim();
  try {
    await git("init");
    await writeFile(path.join(root, "index.html"), "initial");
    await git("add", ".");
    await git("commit", "-m", "initial");
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets/trout.glb"), Buffer.alloc(6 * 1024 ** 2, 7));
    const checkpoints = new AssetCheckpoints(path.join(root, ".git/host-deliveries.json"));
    await checkpoints.record("game", root, "genex", "job", ["assets/trout.glb"]);
    await writeFile(path.join(root, "notes.txt"), "staged user work");
    await git("add", "notes.txt");
    await writeFile(path.join(root, "index.html"), "unstaged user work");
    const result = await checkpoints.checkpoint("game", root);
    assert.deepEqual(result.files, ["assets/trout.glb"]);
    assert.equal(await git("diff", "--cached", "--name-only"), "notes.txt");
    assert.equal(await git("show", "HEAD:index.html"), "initial");
    assert.equal(await readFile(path.join(root, "index.html"), "utf8"), "unstaged user work");
    assert.deepEqual((await checkpoints.checkpoint("game", root)).files, []);
    await writeFile(path.join(root, "assets/trout.glb"), "user replacement");
    await assert.rejects(checkpoints.checkpoint("game", root), /was modified/);
    await assert.rejects(checkpoints.record("game", root, "genex", "job", ["index.html"]), /Only delivered/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("static deployment requires its unique marker and every exact runtime file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deployment-check-"));
  try {
    await writeFile(path.join(root, "index.html"), '<script src="main.js"></script>');
    await writeFile(path.join(root, "main.js"), "window.ready=true");
    const expected = await markDeployment(root, "upload-one");
    const serve = (async (url: URL | RequestInfo) =>
      new Response(await readFile(path.join(root, new URL(String(url)).pathname.slice(1))))) as typeof fetch;
    await verifyDeployment("https://game.genex.technology/", expected, serve);
    await writeFile(path.join(root, "main.js"), "previous build");
    await assert.rejects(verifyDeployment("https://game.genex.technology/", expected, serve), /hosted content/);
    await markDeployment(root, "upload-two");
    await assert.rejects(verifyDeployment("https://game.genex.technology/", expected, serve), /previous deployment/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every hosted HTML page passes with the scripts Genex adds to its head, and a stale one does not", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deployment-html-"));
  try {
    const page = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;
    await writeFile(path.join(root, "index.html"), page("game"));
    await mkdir(path.join(root, "dev"));
    await writeFile(path.join(root, "dev/audio.html"), page("audio bench"));
    const expected = await markDeployment(root, "upload-one");
    let audioBody = "audio bench";
    const injected = (html: string) =>
      html
        .replace(/<head>/i, "<head><script>window.__GENEX__={}</script>")
        .replace(/<\/head>/i, '<script defer src="/__genex/watchdog.js"></script></head>');
    const serve = (async (url: URL | RequestInfo) => {
      const relative = new URL(String(url)).pathname.slice(1);
      if (relative === "dev/audio.html") return new Response(injected(page(audioBody)));
      const bytes = await readFile(path.join(root, relative));
      return new Response(relative.endsWith(".html") ? injected(bytes.toString("utf8")) : bytes);
    }) as typeof fetch;
    await verifyDeployment("https://game.genex.technology/", expected, serve);
    audioBody = "previous audio bench";
    await assert.rejects(verifyDeployment("https://game.genex.technology/", expected, serve), /dev\/audio\.html/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native derivative retains the staged original identity after both files are renamed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "asset-lineage-"));
  try {
    const id = "11111111-1111-4111-8111-111111111111",
      native = "22222222-2222-4222-8222-222222222222";
    const game = path.join(root, "game"),
      original = Buffer.from("original model"),
      derivative = Buffer.from("optimized model");
    const output = path.join(root, "genex/projects/game/jobs", id, "output"),
      nativeDir = path.join(root, "plugins/data/blender/native-jobs", native);
    await mkdir(output, { recursive: true });
    await mkdir(path.join(nativeDir, "delivery"), { recursive: true });
    await mkdir(path.join(game, "assets"), { recursive: true });
    await writeFile(path.join(output, "trout.glb"), original);
    await writeFile(path.join(game, "assets/original.glb"), original);
    await writeFile(path.join(game, "assets/small.glb"), derivative);
    await writeFile(path.join(nativeDir, "delivery/model.glb"), derivative);
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(original).digest("hex");
    await writeFile(
      path.join(nativeDir, "job.json"),
      JSON.stringify({
        project: "game",
        state: "completed",
        files: ["model.glb"],
        inputs: { model: { file: "assets/old-name.glb", sha256: hash } },
      }),
    );
    const inventory = await reconcileGeneratedAssets(
      game,
      root,
      {
        project: "game",
        assets: [
          { file: "assets/original.glb", kind: "model", bytes: original.length, mtime: "now", source: "imported" },
          { file: "assets/small.glb", kind: "model", bytes: derivative.length, mtime: "now", source: "imported" },
        ],
        truncated: false,
        skipped: [],
      },
      [{ id, generationId: "trout", files: [] }],
    );
    const small = inventory.assets.find((a) => a.file === "assets/small.glb")!;
    assert.equal(small.source, "blender");
    assert.equal(small.derivedFrom, "genex:trout:" + hash);
    assert.equal(small.availability?.usage, "unverified");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
