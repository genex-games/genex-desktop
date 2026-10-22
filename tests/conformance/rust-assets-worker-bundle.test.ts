/**
 * The asset importer as a built app carries it: the build bundles `worker.ts` into the app's
 * resources, and a main process running from its bundle starts that copy (a built app has no
 * `src/`). The row bundles the worker exactly as `scripts/build.mjs` does, stages the importer's
 * tools beside it, and imports one Draco GLB through the real import step in its own sandbox.
 */
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { bundleImporterTools, IMPORTER_TOOLS_RESOURCES_FOLDER } from "../../scripts/toolchains/importer-tools.ts";
import {
  defaultImporterCommand,
  type ImportSandbox,
  importerWorker,
  importRustAssets,
} from "../../src/main/rust-assets.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import { ImportConverter } from "../../src/substrate/asset-import/import-plan.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const SAMPLES = path.join(REPO, "tests/fixtures/asset-previews");

interface NodeBundle {
  entry: string;
  outfile: string;
  format: "esm" | "cjs";
  banner?: { js: string };
}

/** The build's own bundle entry for the importer worker, written under `dist`. */
async function workerBundle(dist: string): Promise<NodeBundle> {
  const { nodeBundles } = await import("../../scripts/build.mjs");
  const bundles = nodeBundles(REPO, dist) as NodeBundle[];
  const worker = bundles.find((bundle) => bundle.entry === path.join(REPO, "src/substrate/asset-import/worker.ts"));
  assert.ok(worker, "the build bundles the importer worker");
  return worker;
}

describe("the importer a built app carries", { skip: process.platform === "win32" && "POSIX sandbox" }, () => {
  const sandboxes: ProcessSandbox[] = [];
  after(async () => {
    await Promise.all(sandboxes.map((sandbox) => sandbox.dispose()));
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    await SandboxManager.reset();
  });

  it("a main process running from its bundle starts the worker the build put in the resources", async () => {
    const dist = path.join(await tmpDir("genex-worker-bundle-paths-"), "dist");
    const resources = path.join(dist, "resources");
    const bundle = await workerBundle(dist);
    const bundledMain = pathToFileURL(path.join(dist, "main", "main.mjs")).href;
    assert.equal(importerWorker(resources, bundledMain), bundle.outfile);
    const fromSource = pathToFileURL(path.join(REPO, "src/main/rust-assets.ts")).href;
    assert.equal(importerWorker(resources, fromSource), path.join(REPO, "src/substrate/asset-import/worker.ts"));
  });

  it("the bundled worker imports a Draco GLB in its sandbox with the staged tools", { timeout: 180_000 }, async () => {
    const root = await realpath(await tmpDir("genex-worker-bundle-"));
    const dist = path.join(root, "dist");
    const resources = path.join(dist, "resources");
    const bundle = await workerBundle(dist);
    await esbuild.build({
      bundle: true,
      platform: "node",
      target: "node22",
      logLevel: "silent",
      entryPoints: [bundle.entry],
      outfile: bundle.outfile,
      format: bundle.format,
      ...(bundle.banner ? { banner: bundle.banner } : {}),
    });
    await bundleImporterTools({ root: REPO, resources, release: false, warn: () => {} });
    const game = path.join(root, "game");
    await mkdir(path.join(game, "assets"), { recursive: true });
    await copyFile(path.join(SAMPLES, "compressed.glb"), path.join(game, "assets", "crate.glb"));
    const importer = defaultImporterCommand(
      path.join(resources, IMPORTER_TOOLS_RESOURCES_FOLDER),
      importerWorker(resources, pathToFileURL(path.join(dist, "main", "main.mjs")).href),
    );
    const result = await importRustAssets(
      {
        jobsRoot: path.join(root, "jobs"),
        secretPaths: [],
        importer,
        newJobId: () => "job-bundled",
        sandboxFor: async (options): Promise<ImportSandbox> => {
          const sandbox = await ProcessSandbox.create(options);
          sandboxes.push(sandbox);
          return { run: (request) => sandbox.run(request), dispose: () => sandbox.dispose() };
        },
      },
      { gameRoot: game, stack: GameStack.RustWgpu, files: ["assets/crate.glb"], targets: [BuildTarget.Mac] },
    );
    const [entry] = result.files;
    assert.equal(entry?.converter, ImportConverter.GltfDecompress);
    assert.equal(entry?.refusal, undefined, `${JSON.stringify(entry)} ${result.log}`);
    assert.ok(entry?.output, result.log);
    const glb = await readFile(entry.output.path);
    assert.equal(glb.subarray(0, 4).toString("latin1"), "glTF");
  });
});
