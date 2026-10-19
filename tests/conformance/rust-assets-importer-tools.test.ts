/**
 * The asset importer's tools carried in the app (game systems C-1): the Basis Universal v2.50
 * build, Draco's glTF decoder from npm `draco3dgltf` and meshoptimizer's modules from npm
 * `meshoptimizer`, staged into one folder the packaged app carries and read from there through
 * `GENEX_IMPORTER_TOOLS`, every file held to its pin before anything in it runs. The importer no
 * longer reaches into the `three` package. The Basis rows need the pinned build fetched
 * (`node scripts/toolchains/importer-tools.ts fetch`).
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  bundleImporterTools,
  IMPORTER_TOOLS_RESOURCES_FOLDER,
  ImporterToolsError,
  ImporterToolsRefusal,
  stageImporterTools,
  verifyImporterTools,
} from "../../scripts/toolchains/importer-tools.ts";
import {
  decoderFile,
  devToolFolder,
  IMPORT_DECODERS,
  IMPORTER_TOOL_FILES,
  IMPORTER_TOOLS_ENV,
  ImporterToolError,
  ImporterToolFault,
  ImporterToolFolder,
  pinnedToolFile,
} from "../../src/substrate/asset-import/decoders.ts";
import { tmpDir } from "../helpers/tmp.ts";

const run = promisify(execFile);
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const ASSET_IMPORT = path.join(REPO, "src/substrate/asset-import");
const basisFetched = Object.keys(IMPORTER_TOOL_FILES)
  .filter((name) => name.startsWith(`${ImporterToolFolder.Basis}/`))
  .every((name) => existsSync(decoderFile(name, {})));
const BASIS_SKIP = !basisFetched && "the Basis build is not fetched (node scripts/toolchains/importer-tools.ts fetch)";
const NPM_DECODERS = ["dracoDecoder", "meshoptDecoder", "meshoptSimplifier", "meshoptClusterizer"];

/** The importer's decoder modules, copied into a folder no `node_modules` is reachable from. */
async function isolatedDecoders(): Promise<string> {
  const dir = path.join(await tmpDir("genex-importer-isolated-"), "asset-import");
  await mkdir(dir);
  for (const file of ["decoders.ts", "basis-encoder.ts"])
    await copyFile(path.join(ASSET_IMPORT, file), path.join(dir, file));
  return dir;
}

/** A child Node that starts each named decoder from `tools` and prints what happened, one JSON object. */
async function startInChild(decoders: string, tools: string, names: readonly string[]) {
  const script = `
    const d = await import(${JSON.stringify(pathToFileURL(path.join(decoders, "decoders.ts")).href)});
    const out = { three: "absent" };
    try { import.meta.resolve("three"); out.three = "resolvable"; } catch {}
    for (const name of ${JSON.stringify(names)}) {
      try { const m = await d[name](); out[name] = m.supported === false ? "unsupported" : "ok"; }
      catch (error) { out[name] = error.fault ?? String(error.message).split("\\n")[0]; }
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
    cwd: decoders,
    env: { ...process.env, [IMPORTER_TOOLS_ENV]: tools },
  });
  return JSON.parse(stdout) as Record<string, string>;
}

/** The pinned tools staged from this checkout into a fresh folder. */
async function stagedTools(): Promise<string> {
  const dest = path.join(await tmpDir("genex-importer-tools-"), IMPORTER_TOOLS_RESOURCES_FOLDER);
  await stageImporterTools(REPO, dest);
  return dest;
}

describe("the importer's tools, without three", () => {
  it("every npm decoder starts from the importer tools folder with `three` absent", async () => {
    const result = await startInChild(await isolatedDecoders(), await stagedTools(), NPM_DECODERS);
    assert.deepEqual(result, {
      three: "absent",
      dracoDecoder: "ok",
      meshoptDecoder: "ok",
      meshoptSimplifier: "ok",
      meshoptClusterizer: "ok",
    });
  });

  it("the Basis v2.50 transcoder starts from the importer tools folder with `three` absent", {
    skip: BASIS_SKIP,
  }, async () => {
    const result = await startInChild(await isolatedDecoders(), await stagedTools(), ["basisTranscoder"]);
    assert.deepEqual(result, { three: "absent", basisTranscoder: "ok" });
  });

  it("no decoder names a file of the `three` package, and every file is pinned", () => {
    for (const [decoder, record] of Object.entries(IMPORT_DECODERS)) {
      for (const file of record.files) {
        assert.ok(!file.startsWith("examples/jsm/"), `${decoder}: ${file}`);
        assert.ok(IMPORTER_TOOL_FILES[file], `${decoder}: ${file} has a pin`);
      }
    }
  });

  it("a development checkout reads the npm tools in place and the Basis build where its fetch keeps it", () => {
    assert.equal(devToolFolder(ImporterToolFolder.Meshoptimizer, REPO), path.join(REPO, "node_modules/meshoptimizer"));
    assert.equal(devToolFolder(ImporterToolFolder.Draco, REPO), path.join(REPO, "node_modules/draco3dgltf"));
    assert.equal(
      devToolFolder(ImporterToolFolder.Basis, REPO),
      path.join(REPO, ".studio-dev/tools/basis-encoder-2.50"),
    );
    assert.equal(
      decoderFile("meshoptimizer/meshopt_simplifier.js", { [IMPORTER_TOOLS_ENV]: "/app/importer-tools" }),
      "/app/importer-tools/meshoptimizer/meshopt_simplifier.js",
    );
  });
});

/** An ES module that, if it ever ran, would leave `marker` behind and pass for the simplifier. */
const planted = (marker: string) =>
  `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");
   export const MeshoptSimplifier = { ready: Promise.resolve(), supported: true };`;

describe("a tools folder someone changed", () => {
  const rows: Array<[string, ImporterToolFault, (tools: string, marker: string) => Promise<void>]> = [
    [
      "a simplifier replaced by a script",
      ImporterToolFault.Mismatch,
      (tools, marker) => writeFile(path.join(tools, "meshoptimizer/meshopt_simplifier.js"), planted(marker)),
    ],
    [
      "a simplifier one byte longer",
      ImporterToolFault.Mismatch,
      async (tools) => {
        const file = path.join(tools, "meshoptimizer/meshopt_simplifier.js");
        await writeFile(file, `${await readFile(file, "utf8")}\n`);
      },
    ],
    [
      "a simplifier that is a link to its own pinned bytes",
      ImporterToolFault.Missing,
      async (tools) => {
        const file = path.join(tools, "meshoptimizer/meshopt_simplifier.js");
        await copyFile(file, `${file}.real`);
        await rm(file);
        await symlink(`${file}.real`, file);
      },
    ],
    [
      "a missing simplifier",
      ImporterToolFault.Missing,
      (tools) => rm(path.join(tools, "meshoptimizer/meshopt_simplifier.js")),
    ],
  ];
  for (const [name, fault, change] of rows) {
    it(`${name} is refused ${fault} and never runs`, async () => {
      const tools = await stagedTools();
      const marker = path.join(path.dirname(tools), "ran.txt");
      await change(tools, marker);
      const result = await startInChild(await isolatedDecoders(), tools, ["meshoptSimplifier", "meshoptDecoder"]);
      assert.equal(result.meshoptSimplifier, fault);
      assert.equal(result.meshoptDecoder, "ok", "the other tools still start");
      assert.equal(existsSync(marker), false, "nothing of the changed file ran");
    });
  }

  it("a Draco loader replaced by a script is refused mismatch and never runs", async () => {
    const tools = await stagedTools();
    const marker = path.join(path.dirname(tools), "ran.txt");
    await writeFile(
      path.join(tools, "draco3dgltf/draco_decoder_gltf_nodejs.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`,
    );
    const result = await startInChild(await isolatedDecoders(), tools, ["dracoDecoder"]);
    assert.equal(result.dracoDecoder, ImporterToolFault.Mismatch);
    assert.equal(existsSync(marker), false);
  });

  it("a name no tool pins is refused before any path is read", async () => {
    for (const name of ["../package.json", "meshoptimizer/../../x.js", "three/build/three.module.js"]) {
      await assert.rejects(
        pinnedToolFile(name),
        (error: unknown) => error instanceof ImporterToolError && error.fault === ImporterToolFault.Unpinned,
        name,
      );
    }
  });
});

/** A development checkout with the npm tools copied in (and the Basis build when this one has it). */
async function fakeCheckout(): Promise<string> {
  const repo = await tmpDir("genex-importer-repo-");
  for (const folder of Object.values(ImporterToolFolder)) {
    const from = devToolFolder(folder, REPO);
    const to = devToolFolder(folder, repo);
    await mkdir(to, { recursive: true });
    const names = Object.keys(IMPORTER_TOOL_FILES).filter((name) => name.startsWith(`${folder}/`));
    for (const name of [...names.map((n) => n.slice(folder.length + 1)), "package.json"]) {
      if (existsSync(path.join(from, name))) await copyFile(path.join(from, name), path.join(to, name));
    }
  }
  await writeFile(path.join(repo, "THIRD-PARTY-NOTICES.md"), "# Third-party notices\n");
  return repo;
}

describe("staging the tools", () => {
  it("stages every pinned file and the notices, and the copy verifies", { skip: BASIS_SKIP }, async () => {
    const dest = path.join(await tmpDir("genex-importer-stage-"), "tools");
    const { staged, refused } = await stageImporterTools(REPO, dest);
    assert.deepEqual(refused, []);
    assert.deepEqual(staged, Object.keys(IMPORTER_TOOL_FILES).sort());
    await verifyImporterTools(dest);
    assert.ok(existsSync(path.join(dest, "THIRD-PARTY-NOTICES.md")));
  });

  const hostile: Array<[string, ImporterToolsRefusal, (repo: string) => Promise<void>, string]> = [
    [
      "a source that differs from its pin",
      ImporterToolsRefusal.HashMismatch,
      async (repo) => {
        const file = path.join(devToolFolder(ImporterToolFolder.Meshoptimizer, repo), "meshopt_decoder.mjs");
        const bytes = await readFile(file);
        bytes[100] = (bytes[100] ?? 0) ^ 1;
        await writeFile(file, bytes);
      },
      "meshoptimizer/meshopt_decoder.mjs",
    ],
    [
      "a source that is a link",
      ImporterToolsRefusal.Missing,
      async (repo) => {
        const file = path.join(devToolFolder(ImporterToolFolder.Draco, repo), "draco_decoder_gltf.wasm");
        await copyFile(file, `${file}.real`);
        await rm(file);
        await symlink(`${file}.real`, file);
      },
      "draco3dgltf/draco_decoder_gltf.wasm",
    ],
  ];
  for (const [name, code, change, file] of hostile) {
    it(`${name} is refused ${code} and not written`, async () => {
      const repo = await fakeCheckout();
      await change(repo);
      const dest = path.join(repo, "out");
      const { staged, refused } = await stageImporterTools(repo, dest);
      assert.ok(
        refused.some((error) => error.code === code && error.message.startsWith(file)),
        JSON.stringify(refused.map((e) => [e.code, e.message])),
      );
      assert.ok(!staged.includes(file));
      assert.equal(existsSync(path.join(dest, file)), false);
    });
  }

  it("a package at another version stages nothing from it", async () => {
    const repo = await fakeCheckout();
    const manifest = path.join(devToolFolder(ImporterToolFolder.Meshoptimizer, repo), "package.json");
    await writeFile(manifest, JSON.stringify({ name: "meshoptimizer", version: "1.2.0" }));
    const dest = path.join(repo, "out");
    const { staged, refused } = await stageImporterTools(repo, dest);
    assert.ok(refused.some((error) => error.code === ImporterToolsRefusal.VersionMismatch));
    assert.ok(staged.every((name) => !name.startsWith("meshoptimizer/")));
    assert.equal(existsSync(path.join(dest, "meshoptimizer")), false);
  });
});

describe("the build's step and the command line", () => {
  it("a release build whose Basis fetch fails is refused with nothing staged; a development build warns and stages the rest", async () => {
    const repo = await fakeCheckout();
    await rm(devToolFolder(ImporterToolFolder.Basis, repo), { recursive: true, force: true });
    const resources = path.join(repo, "resources");
    const offline = async () => {
      throw new ImporterToolsError(ImporterToolsRefusal.DownloadFailed, "basis_encoder.js: no answer");
    };
    await assert.rejects(
      bundleImporterTools({ root: repo, resources, release: true, fetchBasis: offline }),
      (error: unknown) => error instanceof ImporterToolsError && error.code === ImporterToolsRefusal.DownloadFailed,
    );
    assert.equal(existsSync(path.join(resources, IMPORTER_TOOLS_RESOURCES_FOLDER)), false);
    const warnings: string[] = [];
    const fetched: string[] = [];
    const dev = await bundleImporterTools({
      root: repo,
      resources,
      release: false,
      warn: (m) => warnings.push(m),
      fetchBasis: async (dir) => {
        fetched.push(dir);
      },
    });
    assert.deepEqual(fetched, [], "a development build fetches nothing");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /basis-encoder-2\.50\/basis_encoder\.js/);
    assert.deepEqual(
      dev.staged,
      Object.keys(IMPORTER_TOOL_FILES)
        .filter((name) => !name.startsWith(`${ImporterToolFolder.Basis}/`))
        .sort(),
    );
    await assert.rejects(
      verifyImporterTools(path.join(resources, IMPORTER_TOOLS_RESOURCES_FOLDER)),
      (error: unknown) => error instanceof ImporterToolsError && error.code === ImporterToolsRefusal.Missing,
    );
  });

  it("a release build fetches a missing Basis build, then stages every pinned file", { skip: BASIS_SKIP }, async () => {
    const repo = await fakeCheckout();
    await rm(devToolFolder(ImporterToolFolder.Basis, repo), { recursive: true, force: true });
    const resources = path.join(repo, "resources");
    const fetchBasis = async (dir: string) => {
      await mkdir(dir, { recursive: true });
      for (const name of ["basis_encoder.js", "basis_encoder.wasm"])
        await copyFile(path.join(devToolFolder(ImporterToolFolder.Basis, REPO), name), path.join(dir, name));
    };
    const { staged, refused } = await bundleImporterTools({ root: repo, resources, release: true, fetchBasis });
    assert.deepEqual(refused, []);
    assert.deepEqual(staged, Object.keys(IMPORTER_TOOL_FILES).sort());
    await verifyImporterTools(path.join(resources, IMPORTER_TOOLS_RESOURCES_FOLDER));
  });

  it("a release build refuses a fetched Basis build that is not its pin", async () => {
    const repo = await fakeCheckout();
    const resources = path.join(repo, "resources");
    const fetchBasis = async (dir: string) => {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "basis_encoder.js"), "globalThis.planted = true;");
      await writeFile(path.join(dir, "basis_encoder.wasm"), new Uint8Array([0, 97, 115, 109]));
    };
    await assert.rejects(
      bundleImporterTools({ root: repo, resources, release: true, fetchBasis }),
      (error: unknown) => error instanceof ImporterToolsError && error.code === ImporterToolsRefusal.SizeMismatch,
    );
    assert.equal(existsSync(path.join(resources, IMPORTER_TOOLS_RESOURCES_FOLDER)), false);
  });

  it("the command line refuses a wrong command with one line and exit 78", async () => {
    const script = path.join(REPO, "scripts/toolchains/importer-tools.ts");
    const failed = await run(process.execPath, [script, "nonsense"]).then(
      () => null,
      (error: { code: number; stderr: string }) => error,
    );
    assert.equal(failed?.code, 78);
    const lines = (failed?.stderr ?? "").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? "", /^genex-importer-tools-refusal: \{"code":"usage"/);
  });
});
