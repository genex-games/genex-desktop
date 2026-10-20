/**
 * The build lane's import step (C-2, `rustStageImporter` in `src/main/rust-assets.ts`, run by
 * `RustBuilds`): after a game is staged, every staged `assets/**` file is planned for the build's
 * destination; the importable ones run as per-file jobs, at most `IMPORT_JOBS_MAX` at once, each in
 * its own sandbox (no network, writes only its job's `out/`); the admitted outputs replace their
 * sources in the stage, so `<bin>.out/assets` holds what the runtime reads (a converted OBJ's GLB,
 * a Draco GLB written back plain), and a refused file stays out of the build. The receipt lists
 * each file's action and refusal. A game with nothing importable spawns no sandbox.
 *
 * The lane runs over a stub cargo and rustc (as `rust-build.test.ts`); the importer is the real one
 * in the real Seatbelt sandbox, so those rows run on macOS only. The real toolchain row builds the
 * template with a model to import and reads `state().__render.missingModels` from the running game
 * (`GENEX_REQUIRE_TOOLCHAINS=1` turns its skip into a failure).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { copyFile, cp, mkdir, readdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { layoutFor, prewarmDenyWrites } from "../../src/main/core/layout.ts";
import { rustPayloadDir, shippedRustStage } from "../../src/main/core/rust-lane.ts";
import type { GameBuildGame } from "../../src/main/game-build.ts";
import {
  IMPORT_JOBS_MAX,
  type ImportSandbox,
  importStagedAssets,
  type RustAssetImportDeps,
  rustStageImporter,
  StagePlacementRefusal,
  type StagedImportReport,
} from "../../src/main/rust-assets.ts";
import {
  RustBuilds,
  type RustBuildSandbox,
  type RustBuildsOptions,
  type RustStaged,
  type RustToolchain,
  rustBuildSandboxes,
} from "../../src/main/rust-build.ts";
import { BuildProblemCode, CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import { BuildTarget, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { NativeOp, NativeRunMode, type NativeTimers } from "../../src/shared/native-contract.ts";
import type { ToolchainLock } from "../../src/shared/toolchain.ts";
import { readGlb } from "../../src/substrate/asset-import/glb.ts";
import { AssetImportRefusal, ImportAction, ImportConverter } from "../../src/substrate/asset-import/import-plan.ts";
import { IMPORT_DETAIL_MAX_CHARS } from "../../src/substrate/asset-import/job.ts";
import { NativeGamePort } from "../../src/substrate/native-game-port.ts";
import {
  type GameChild,
  type GameExit,
  ProcessSandbox,
  type RunRequest,
  type RunResult,
} from "../../src/substrate/spawn.ts";
import { isInside } from "../../src/substrate/paths.ts";
import { lockOf } from "../../src/substrate/toolchain-store/lock.ts";
import type { XcodeExec } from "../../src/substrate/toolchain-store/locate.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const SAMPLES = path.join(FIXTURES, "asset-previews");
const IMPORT = path.join(FIXTURES, "asset-import");
const SKIP_UNLESS_MAC = process.platform === "darwin" ? false : "the importer's Seatbelt sandbox is macOS's";
const IMPORT_ROW_MS = 2 * MINUTE_MS;
const LOCK: ToolchainLock = {
  version: 1,
  entries: { rust: { version: "1.99.0", sha12: "0123456789ab" } },
  digest: "0123456789abcdef".repeat(4),
};
const RUSTC_VV = "rustc 1.99.0 (1d4e1a2b3 2026-09-17)\nhost: aarch64-apple-darwin\nrelease: 1.99.0";
const LOCK_FILE =
  '[[package]]\nname = "game"\nversion = "0.0.0"\ndependencies = ["genex"]\n\n[[package]]\nname = "genex"\nversion = "0.1.0"\n';
const ARTIFACT =
  '{"reason":"compiler-artifact","package_id":"path+file://STAGE#game@0.0.0","manifest_path":"MANIFEST",' +
  '"target":{"kind":["bin"],"crate_types":["bin"],"name":"game"},"filenames":["EXE"],"executable":"EXE","fresh":false}';

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const xcode: XcodeExec = async (file) =>
  file.endsWith("xcode-select")
    ? { code: 0, stdout: "/Library/Developer/CommandLineTools\n", stderr: "" }
    : { code: 0, stdout: "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk\n", stderr: "" };

/** A stub cargo: writes the lock, passes clippy, and "builds" a shell script it names as the artifact. */
const STUB_CARGO = `#!/bin/sh
sub=$1
shift
manifest=""
prev=""
for a in "$@"; do
  if [ "$prev" = --manifest-path ]; then manifest=$a; fi
  prev=$a
done
case "$sub" in
  generate-lockfile) printf '%s' '${LOCK_FILE}' > "$(dirname "$manifest")/Cargo.lock" ;;
  clippy) echo '{"reason":"build-finished","success":true}' ;;
  build)
    exe="$CARGO_TARGET_DIR/aarch64-apple-darwin/debug/game"
    mkdir -p "$(dirname "$exe")"
    printf '#!/bin/sh\\necho game\\n' > "$exe"
    chmod +x "$exe"
    echo '${ARTIFACT}' | sed -e "s#STAGE#$(dirname "$manifest")#" -e "s#MANIFEST#$manifest#" -e "s#EXE#$exe#g"
    echo '{"reason":"build-finished","success":true}'
    ;;
esac
exit 0
`;

/** `request` run by /bin/sh, uncontained: the lane's own build sandbox is not what these rows test. */
async function runShell(request: RunRequest): Promise<RunResult> {
  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", request.command], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve({
        code,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut: false,
        truncated: false,
        sandboxed: false,
        command: request.command,
        cwd: request.cwd,
      }),
    );
  });
}

const openSandbox = async (): Promise<RustBuildSandbox> => ({ run: runShell, dispose: async () => {} });

/** Copies the regular files and folders under `from` into `to`, as the real stager's link-free copy does. */
async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyTree(path.join(from, entry.name), path.join(to, entry.name));
    else if (entry.isFile()) await copyFile(path.join(from, entry.name), path.join(to, entry.name));
  }
}

/** A stand-in for M2.2's stager: src/ and assets/ copied link-free, and a manifest on the facade. */
async function stage(game: { dir: string }, into: string): Promise<RustStaged> {
  for (const folder of ["src", "assets"]) await copyTree(path.join(game.dir, folder), path.join(into, folder));
  const manifest =
    '[package]\nname = "game"\nversion = "0.0.0"\nedition = "2024"\n\n[dependencies]\ngenex = "=0.1.0"\n';
  await writeFile(path.join(into, "Cargo.toml"), manifest);
  return { ok: true, dependencies: ["genex"], nativeFeatures: [] };
}

/** Every sandbox the importer asked for and every run, recorded; the real ProcessSandbox underneath. */
function importerSandboxes() {
  const created: ProcessSandbox[] = [];
  const runs: RunResult[] = [];
  const sandboxFor: RustAssetImportDeps["sandboxFor"] = async (options): Promise<ImportSandbox> => {
    const sandbox = await ProcessSandbox.create(options);
    created.push(sandbox);
    return {
      run: async (request) => {
        const run = await sandbox.run(request);
        runs.push(run);
        return run;
      },
      dispose: () => sandbox.dispose(),
    };
  };
  return { sandboxFor, created, runs };
}

after(async () => {
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  await SandboxManager.reset();
});

/** A Rust game folder with `assets` copied in under their names here (`[game name, sample]`). */
async function gameWith(parent: string, assets: Array<[string, string | Uint8Array]>): Promise<string> {
  const dir = path.join(parent, "game");
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "assets"), { recursive: true });
  await writeFile(path.join(dir, "genex.toml"), '[game]\ntitle = "Game"\n');
  await writeFile(path.join(dir, "src", "main.rs"), "fn main() {}\n");
  for (const [name, from] of assets) {
    const to = path.join(dir, "assets", name);
    await mkdir(path.dirname(to), { recursive: true });
    if (typeof from === "string") await copyFile(from, to);
    else await writeFile(to, from);
  }
  return dir;
}

/** A Rust lane over the stub toolchain in `parent`, the given import step and options. */
async function lane(parent: string, options: Partial<RustBuildsOptions> = {}): Promise<RustBuilds> {
  const bin = path.join(parent, "toolchain", "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "cargo"), STUB_CARGO, { mode: 0o755 });
  await writeFile(path.join(bin, "rustc"), `#!/bin/sh\nprintf '%s\\n' '${RUSTC_VV}'\n`, { mode: 0o755 });
  const vendor = path.join(parent, "toolchain", "vendor");
  await mkdir(vendor, { recursive: true });
  const toolchain: RustToolchain = { bin, vendor, clippyConf: bin, reads: [path.join(parent, "toolchain")] };
  return new RustBuilds({
    root: path.join(parent, "rust-builds"),
    sandbox: openSandbox,
    locate: async () => ({ ok: true, toolchain }),
    currentLock: async () => LOCK,
    stage,
    emit: () => {},
    platform: "darwin",
    cores: 8,
    denyWrite: [],
    writeLock: async () => {},
    exec: xcode,
    ...options,
  });
}

function gameOf(dir: string): GameBuildGame {
  return {
    project: "game",
    dir,
    shape: {
      entry: "index.html",
      main: "src/main.rs",
      build: null,
      install: null,
      own: false,
      kind: ProjectKind.RustWgpu,
      serve: ".",
    },
    destinations: { stack: GameStack.RustWgpu, targets: [BuildTarget.Mac] },
  };
}

/** Every regular file under `dir`, `/`-separated, sorted, with its sha256. */
async function tree(dir: string, rel = ""): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, await tree(dir, child));
    else if (entry.isFile()) files[child] = sha(await readFile(path.join(dir, child)));
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The receipt the lane wrote beside `output` (`<bin>.out` → `<bin>.receipt.json`). */
async function receiptOf(output: string): Promise<{ assets?: StagedImportReport }> {
  return JSON.parse(await readFile(output.replace(/\.out$/, ".receipt.json"), "utf8"));
}

/** The extensions a GLB still declares. */
async function extensionsOf(file: string): Promise<unknown> {
  return (readGlb(new Uint8Array(await readFile(file))).json as { extensionsUsed?: unknown }).extensionsUsed;
}

describe("the build lane imports a Rust game's staged assets", { skip: SKIP_UNLESS_MAC }, () => {
  it("an OBJ and a Draco GLB reach out/assets as plain GLBs, refused files stay out, and the receipt says why", {
    timeout: IMPORT_ROW_MS,
  }, async () => {
    const parent = await realpath(await tmpDir("rust-assets-build-"));
    const dir = await gameWith(parent, [
      ["ship.obj", path.join(SAMPLES, "model.obj")],
      ["ship.mtl", path.join(SAMPLES, "model.mtl")],
      ["hull.glb", path.join(SAMPLES, "compressed.glb")],
      ["props/crate.stl", path.join(SAMPLES, "model.stl")],
      ["walk.fbx", path.join(SAMPLES, "animated.fbx")],
      ["broken.stl", new TextEncoder().encode("solid broken\nfacet normal 0 0 1\nvertex nope\n")],
      ["notes.xyz", new TextEncoder().encode("metadata")],
      ["tone.wav", path.join(SAMPLES, "tone.wav")],
    ]);
    const sandboxes = importerSandboxes();
    const importAssets = rustStageImporter({
      jobsRoot: path.join(parent, "asset-jobs"),
      sandboxFor: sandboxes.sandboxFor,
      secretPaths: [],
    });
    const builds = await lane(parent, { importAssets });
    const built = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(built.ok, true, JSON.stringify(built.problem));
    const out = path.join(String(built.output), "assets");
    const files = Object.keys(await tree(out));
    // The package step (C-15) writes the asset index beside the assets.
    assert.deepEqual(files, [
      "genex-asset-index.json",
      "hull.glb",
      "notes.xyz",
      "props/crate.glb",
      "ship.glb",
      "ship.mtl",
      "tone.wav",
    ]);
    assert.equal(await extensionsOf(path.join(out, "hull.glb")), undefined, "Draco written back plain");
    assert.equal(await extensionsOf(path.join(out, "ship.glb")), undefined);
    assert.ok(sandboxes.runs.length > 0 && sandboxes.runs.every((run) => run.sandboxed), "every job ran sandboxed");

    const receipt = await receiptOf(String(built.output));
    const rows = Object.fromEntries((receipt.assets?.files ?? []).map((row) => [row.file, row]));
    assert.deepEqual(Object.keys(rows), [
      "assets/broken.stl",
      "assets/hull.glb",
      "assets/notes.xyz",
      "assets/props/crate.stl",
      "assets/ship.mtl",
      "assets/ship.obj",
      "assets/tone.wav",
      "assets/walk.fbx",
    ]);
    assert.equal(rows["assets/ship.obj"]?.action, ImportAction.Convert);
    assert.equal(rows["assets/ship.obj"]?.converter, ImportConverter.ObjToGlb);
    assert.equal(rows["assets/ship.obj"]?.output?.file, "assets/ship.glb");
    assert.equal(rows["assets/ship.obj"]?.output?.sha256, sha(await readFile(path.join(out, "ship.glb"))));
    assert.equal(rows["assets/hull.glb"]?.action, ImportAction.Normalize);
    assert.equal(rows["assets/tone.wav"]?.action, ImportAction.Keep);
    assert.equal(rows["assets/notes.xyz"]?.action, ImportAction.Skip);
    const refused = Object.fromEntries(
      Object.values(rows)
        .filter((row) => row.refusal)
        .map((row) => [row.file, row.refusal]),
    );
    assert.deepEqual(refused, {
      "assets/broken.stl": AssetImportRefusal.Malformed,
      "assets/walk.fbx": AssetImportRefusal.UnsupportedByRust,
    });
    assert.equal(receipt.assets?.jobs, IMPORT_JOBS_MAX);
    assert.deepEqual(await readdir(path.join(parent, "asset-jobs")), [], "every job folder removed");
    assert.ok(existsSync(path.join(dir, "assets", "ship.obj")), "the game folder keeps its sources");
    assert.ok(!existsSync(path.join(dir, "assets", "ship.glb")), "outputs never land in the game folder");
  });

  it("spawns no sandbox when nothing is importable, and the assets go out as delivered", async () => {
    const parent = await realpath(await tmpDir("rust-assets-none-"));
    const dir = await gameWith(parent, [
      ["tone.wav", path.join(SAMPLES, "tone.wav")],
      ["notes.xyz", new TextEncoder().encode("metadata")],
      ["walk.fbx", path.join(SAMPLES, "animated.fbx")],
    ]);
    let asked = 0;
    const importAssets = rustStageImporter({
      jobsRoot: path.join(parent, "asset-jobs"),
      sandboxFor: async () => {
        asked += 1;
        throw new Error("no sandbox should be asked for");
      },
      secretPaths: [],
    });
    const builds = await lane(parent, { importAssets });
    const built = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(built.ok, true, JSON.stringify(built.problem));
    assert.equal(asked, 0);
    assert.deepEqual(Object.keys(await tree(path.join(String(built.output), "assets"))), [
      "genex-asset-index.json",
      "notes.xyz",
      "tone.wav",
    ]);
    const receipt = await receiptOf(String(built.output));
    assert.equal(receipt.assets?.files.find((row) => row.file === "assets/walk.fbx")?.refusal, "unsupported-by-rust");
  });
});

describe("the build lane's import jobs", { skip: SKIP_UNLESS_MAC }, () => {
  it("writes the same out/assets with one job and with four", { timeout: 2 * IMPORT_ROW_MS }, async () => {
    const assets: Array<[string, string]> = [];
    for (let i = 0; i < 4; i += 1) assets.push([`rock-${i}.ktx2`, path.join(IMPORT, "basis-uastc-64.ktx2")]);
    assets.push(["ship.obj", path.join(SAMPLES, "model.obj")], ["hull.glb", path.join(SAMPLES, "compressed.glb")]);
    assets.push(["crate.stl", path.join(SAMPLES, "model.stl")], ["crate.ply", path.join(SAMPLES, "model.ply")]);
    const outputs: Array<Record<string, string>> = [];
    const times: number[] = [];
    for (const jobs of [1, 4]) {
      const parent = await realpath(await tmpDir(`rust-assets-jobs-${jobs}-`));
      const dir = await gameWith(parent, assets);
      const sandboxes = importerSandboxes();
      const importAssets = rustStageImporter(
        { jobsRoot: path.join(parent, "asset-jobs"), sandboxFor: sandboxes.sandboxFor, secretPaths: [] },
        { jobs },
      );
      const built = await (await lane(parent, { importAssets })).ensure(
        gameOf(dir),
        BuildTarget.Mac,
        CppBuildPurpose.Live,
      );
      assert.equal(built.ok, true, JSON.stringify(built.problem));
      outputs.push(await tree(path.join(String(built.output), "assets")));
      const receipt = await receiptOf(String(built.output));
      assert.equal(receipt.assets?.jobs, jobs);
      times.push(receipt.assets?.ms ?? 0);
      assert.equal(sandboxes.created.length, assets.length, "one sandbox per importable file");
    }
    assert.deepEqual(outputs[0], outputs[1]);
    assert.ok(Object.keys(outputs[0] ?? {}).includes("rock-0.bc.ktx2"), "a Mac build gets the BC family file");
    console.log(`import of ${assets.length} files: 1 job ${times[0]} ms, 4 jobs ${times[1]} ms`);
  });

  it("a stopped build stops at the import step: Cancelled, nothing admitted", { timeout: IMPORT_ROW_MS }, async () => {
    const parent = await realpath(await tmpDir("rust-assets-lane-stop-"));
    const dir = await gameWith(parent, [["ship.obj", path.join(SAMPLES, "model.obj")]]);
    const stop = new AbortController();
    const importAssets = rustStageImporter({
      jobsRoot: path.join(parent, "asset-jobs"),
      sandboxFor: async () => {
        stop.abort();
        throw new Error("the build was stopped");
      },
      secretPaths: [],
    });
    const builds = await lane(parent, { importAssets });
    const built = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live, { signal: stop.signal });
    assert.equal(built.ok, false);
    assert.equal(built.problem?.reason, BuildProblemCode.Cancelled);
  });
});

describe("the import step over a stage", { skip: SKIP_UNLESS_MAC }, () => {
  it("a delivered GLB keeps its name: an OBJ that would write over it is refused name-taken", {
    timeout: IMPORT_ROW_MS,
  }, async () => {
    const parent = await realpath(await tmpDir("rust-assets-taken-"));
    const stageDir = path.join(parent, "stage");
    await mkdir(path.join(stageDir, "assets"), { recursive: true });
    await copyFile(path.join(SAMPLES, "model.obj"), path.join(stageDir, "assets", "ship.obj"));
    await copyFile(path.join(SAMPLES, "compressed.glb"), path.join(stageDir, "assets", "ship.glb"));
    await copyFile(path.join(SAMPLES, "model.stl"), path.join(stageDir, "assets", "ship.stl"));
    const sandboxes = importerSandboxes();
    const deps = { jobsRoot: path.join(parent, "jobs"), sandboxFor: sandboxes.sandboxFor, secretPaths: [] };
    const report = await importStagedAssets(deps, { stage: stageDir, target: BuildTarget.Mac });
    const rows = Object.fromEntries((report?.files ?? []).map((row) => [row.file, row]));
    assert.equal(rows["assets/ship.glb"]?.output?.file, "assets/ship.glb");
    assert.equal(rows["assets/ship.obj"]?.refusal, StagePlacementRefusal.NameTaken);
    assert.equal(rows["assets/ship.stl"]?.refusal, StagePlacementRefusal.NameTaken);
    assert.deepEqual(await readdir(path.join(stageDir, "assets")), ["ship.glb"]);
    assert.equal(await extensionsOf(path.join(stageDir, "assets", "ship.glb")), undefined, "the delivered GLB, plain");
  });

  it("runs at most the jobs it was given at once, and never more than IMPORT_JOBS_MAX", async () => {
    for (const [asked, expected] of [
      [1, 1],
      [3, 3],
      [16, IMPORT_JOBS_MAX],
    ] as const) {
      const parent = await realpath(await tmpDir("rust-assets-cap-"));
      const stageDir = path.join(parent, "stage");
      await mkdir(path.join(stageDir, "assets"), { recursive: true });
      for (let i = 0; i < 10; i += 1)
        await copyFile(path.join(SAMPLES, "model.stl"), path.join(stageDir, "assets", `m${i}.stl`));
      const files = 10;
      let running = 0;
      let started = 0;
      let peak = 0;
      let waiting: Array<() => void> = [];
      // Each run holds until as many run as may (or every file has started): the peak is the cap.
      const sandboxFor = async (): Promise<ImportSandbox> => ({
        run: async (request) => {
          running += 1;
          started += 1;
          peak = Math.max(peak, running);
          const held = new Promise<void>((resolve) => waiting.push(resolve));
          if (running >= expected || started === files) {
            for (const release of waiting) release();
            waiting = [];
          }
          await held;
          running -= 1;
          return { ...(await runShell({ ...request, command: "exit 1" })), code: 1 };
        },
        dispose: async () => {},
      });
      const report = await importStagedAssets(
        { jobsRoot: path.join(parent, "jobs"), sandboxFor, secretPaths: [] },
        { stage: stageDir, target: BuildTarget.Mac, jobs: asked },
      );
      assert.equal(peak, expected, `jobs ${asked}`);
      assert.equal(report?.jobs, expected);
      assert.ok(report?.files.every((row) => row.refusal === AssetImportRefusal.ImporterFailed));
      assert.deepEqual(await readdir(path.join(stageDir, "assets")), [], "a failed file stays out of the stage");
    }
  });

  it("names how a failed job ended in its refusal: the exit and the importer's stderr, a timeout, a sandbox that did not start", async () => {
    const parent = await realpath(await tmpDir("rust-assets-detail-"));
    const stageDir = path.join(parent, "stage");
    await mkdir(path.join(stageDir, "assets"), { recursive: true });
    for (let i = 0; i < 3; i += 1)
      await copyFile(path.join(SAMPLES, "model.stl"), path.join(stageDir, "assets", `m${i}.stl`));
    let jobs = 0;
    // One job at a time, so each file meets the failure its turn brings.
    const sandboxFor = async (): Promise<ImportSandbox> => {
      jobs += 1;
      if (jobs === 3) throw new Error("sandbox-exec: profile refused");
      const timedOut = jobs === 2;
      return {
        run: async (request) => ({
          ...(await runShell({ ...request, command: "echo 'encoder: out of memory' >&2; exit 3" })),
          ...(timedOut ? { code: null, timedOut: true } : {}),
        }),
        dispose: async () => {},
      };
    };
    const report = await importStagedAssets(
      { jobsRoot: path.join(parent, "jobs"), sandboxFor, secretPaths: [] },
      { stage: stageDir, target: BuildTarget.Mac, jobs: 1 },
    );
    const rows = report?.files ?? [];
    assert.deepEqual(
      rows.map((row) => row.refusal),
      [AssetImportRefusal.ImporterFailed, AssetImportRefusal.ImporterFailed, AssetImportRefusal.ImporterFailed],
    );
    assert.match(rows[0]?.detail ?? "", /exited 3: encoder: out of memory/);
    assert.match(rows[1]?.detail ?? "", /timed out/);
    assert.match(rows[2]?.detail ?? "", /sandbox-exec: profile refused/);
    for (const row of rows) assert.ok((row.detail ?? "").length <= IMPORT_DETAIL_MAX_CHARS, row.detail);
  });

  it("runs a job again once when the importer crashed, and names the signal when it crashes twice; an ordinary exit is not retried", {
    timeout: IMPORT_ROW_MS,
  }, async () => {
    const crash = { code: 139, stderr: "/bin/sh: line 1: 4242 Segmentation fault: 11  node worker.ts job" };
    const outcome = async (ends: ReadonlyArray<{ code: number; stderr: string } | "real">) => {
      const parent = await realpath(await tmpDir("rust-assets-crash-"));
      const stageDir = path.join(parent, "stage");
      await mkdir(path.join(stageDir, "assets"), { recursive: true });
      await copyFile(path.join(SAMPLES, "model.stl"), path.join(stageDir, "assets", "ship.stl"));
      let runs = 0;
      const sandboxFor = async (): Promise<ImportSandbox> => ({
        run: async (request) => {
          const end = ends[runs] ?? "real";
          runs += 1;
          // A crashed importer may leave a partial output behind; the retry starts from an empty out/.
          await writeFile(path.join(request.cwd, "out", "0.glb"), "partial");
          if (end === "real") return await runShell({ ...request, command: `rm -f out/0.glb; ${request.command}` });
          return { ...(await runShell({ ...request, command: "true" })), code: end.code, stderr: end.stderr };
        },
        dispose: async () => {},
      });
      const report = await importStagedAssets(
        { jobsRoot: path.join(parent, "jobs"), sandboxFor, secretPaths: [] },
        { stage: stageDir, target: BuildTarget.Mac },
      );
      return { runs, row: report?.files[0] };
    };
    const once = await outcome([crash, "real"]);
    assert.equal(once.runs, 2, "a crash runs the job once more");
    assert.equal(once.row?.output?.file, "assets/ship.glb", JSON.stringify(once.row));
    const twice = await outcome([crash, crash]);
    assert.equal(twice.runs, 2, "at most once more");
    assert.equal(twice.row?.refusal, AssetImportRefusal.ImporterFailed);
    assert.match(twice.row?.detail ?? "", /SIGSEGV/);
    const exited = await outcome([{ code: 1, stderr: "no" }, "real"]);
    assert.equal(exited.runs, 1, "an importer that exits on its own is not run again");
    assert.equal(exited.row?.refusal, AssetImportRefusal.ImporterFailed);
  });

  it("answers null and places nothing once the build is stopped", async () => {
    const parent = await realpath(await tmpDir("rust-assets-stop-"));
    const stageDir = path.join(parent, "stage");
    await mkdir(path.join(stageDir, "assets"), { recursive: true });
    await copyFile(path.join(SAMPLES, "model.obj"), path.join(stageDir, "assets", "ship.obj"));
    const stop = new AbortController();
    stop.abort();
    let asked = 0;
    const sandboxFor = async (): Promise<ImportSandbox> => {
      asked += 1;
      throw new Error("stopped before any job");
    };
    const deps = { jobsRoot: path.join(parent, "jobs"), sandboxFor, secretPaths: [] };
    const report = await importStagedAssets(deps, { stage: stageDir, target: BuildTarget.Mac, signal: stop.signal });
    assert.equal(report, null);
    assert.equal(asked, 0);
    assert.deepEqual(await readdir(path.join(stageDir, "assets")), ["ship.obj"]);
  });
});

describe("the import step's links and odd files (hostile stage)", {
  skip: SKIP_UNLESS_MAC,
}, () => {
  it("never writes through a link nor reads a file that is not a regular one", { timeout: IMPORT_ROW_MS }, async () => {
    const parent = await realpath(await tmpDir("rust-assets-hostile-"));
    const outside = path.join(parent, "outside");
    const stageDir = path.join(parent, "stage");
    await mkdir(path.join(outside, "dir"), { recursive: true });
    await mkdir(path.join(stageDir, "assets"), { recursive: true });
    const victim = path.join(outside, "victim.glb");
    await writeFile(victim, "untouched");
    await copyFile(path.join(SAMPLES, "model.obj"), path.join(outside, "dir", "far.obj"));
    // ship.obj converts to ship.glb, where a link to a file outside the stage already sits.
    await copyFile(path.join(SAMPLES, "model.obj"), path.join(stageDir, "assets", "ship.obj"));
    await symlink(victim, path.join(stageDir, "assets", "ship.glb"));
    // A linked folder and a linked file: never listed, never imported, never written through.
    await symlink(path.join(outside, "dir"), path.join(stageDir, "assets", "linked"));
    await symlink(path.join(outside, "dir", "far.obj"), path.join(stageDir, "assets", "far.obj"));
    execFileSync("mkfifo", [path.join(stageDir, "assets", "pipe.obj")]);
    const before = await tree(outside);
    const sandboxes = importerSandboxes();
    const deps = { jobsRoot: path.join(parent, "jobs"), sandboxFor: sandboxes.sandboxFor, secretPaths: [] };
    const report = await importStagedAssets(deps, { stage: stageDir, target: BuildTarget.Mac });
    assert.deepEqual(
      report?.files.map((row) => row.file),
      ["assets/ship.obj"],
      "links and the FIFO are not the stage's files",
    );
    assert.equal(report?.files[0]?.output?.file, "assets/ship.glb");
    assert.deepEqual(await tree(outside), before, "nothing outside the stage changed");
    assert.equal(await readFile(victim, "utf8"), "untouched");
    const placed = await stat(path.join(stageDir, "assets", "ship.glb"));
    assert.ok(placed.isFile(), "the link was replaced by the admitted GLB, not written through");
    assert.equal(sandboxes.created.length, 1, "one job: only the stage's own regular file");
  });
});

describe("the import jobs' folder", () => {
  for (const userData of [
    "/Users/me/Library/Application Support/Genex",
    "/repo/.studio-dev/profiles/live-1/userData",
  ]) {
    it(`sits in the profile's data, under no writable root, denied to a prewarm (${userData})`, () => {
      const layout = layoutFor(userData);
      assert.equal(layout.assetJobs, path.join(userData, "asset-jobs"));
      for (const root of [layout.workspaces, layout.runs, layout.exports, layout.gamesRoot, layout.scratch]) {
        assert.ok(!isInside(root, layout.assetJobs), `${layout.assetJobs} is under ${root}`);
      }
      for (const [name, folder] of Object.entries(layout)) {
        if (name === "assetJobs") continue;
        assert.ok(!isInside(folder, layout.assetJobs), `assetJobs sits inside ${name}`);
      }
      assert.ok(prewarmDenyWrites(layout).includes(layout.assetJobs));
    });
  }
});

// ---- The real toolchain row ----------------------------------------------------------------------

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TOOLCHAIN_DIR = process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev", "spike-toolchain");
const VENDOR_DIR = process.env.GENEX_RUST_VENDOR_DIR ?? path.join(REPO, ".studio-dev", "rust-release", "e2e", "vendor");
const WORKSPACE = path.join(REPO, "native", "genex-rust");
const TEMPLATE = path.join(REPO, "src", "game-template-rust");
const COLD_BUILD_MS = 30 * MINUTE_MS;
const STATE_WAIT_MS = 20 * SECOND_MS;

/** Why the real row cannot run here, or null. */
function realAbsent(): string | null {
  if (process.platform !== "darwin" || process.arch !== "arm64") return "an Apple silicon Mac";
  if (!existsSync(path.join(TOOLCHAIN_DIR, "sysroot", "bin", "cargo"))) return `the Rust toolchain (${TOOLCHAIN_DIR})`;
  if (!existsSync(path.join(VENDOR_DIR, "genex-0.1.0"))) return `the release's vendored crates (${VENDOR_DIR})`;
  return null;
}

function needsToolchain(): { skip?: string } {
  const missing = realAbsent();
  if (!missing) return {};
  if (process.env.GENEX_REQUIRE_TOOLCHAINS === "1") throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return { skip: `not run: ${missing} absent` };
}

/** The template drawing two models to import every frame: the OBJ's GLB and the Draco GLB written back plain. */
async function templateWithModels(parent: string): Promise<string> {
  const dir = path.join(parent, "pond");
  await cp(TEMPLATE, dir, { recursive: true });
  for (const file of [path.join(dir, "genex.toml"), path.join(dir, "src", "main.rs")])
    await writeFile(file, (await readFile(file, "utf8")).replaceAll("__GAME_TITLE__", "Pond"));
  const game = path.join(dir, "src", "game.rs");
  const source = await readFile(game, "utf8");
  const edits: Array<[string, string]> = [
    [
      "    pub settings_open: bool,\n}",
      "    pub settings_open: bool,\n    /// The imported models.\n    pub models: Vec<Model>,\n}",
    ],
    [
      "    game.on_update(",
      '    game.on_reset(|sim, _seed, _rng, gfx| sim.world.models = vec![gfx.assets().model("ship.glb"), gfx.assets().model("hull.glb")]);\n    game.on_update(',
    ],
    [
      '    frame.tag("floor")',
      '    for (model, x) in world.models.iter().zip([2.0, -2.0]) {\n        frame.model(model, Transform::from_xyz(x, 0.5, 0.0));\n    }\n    frame.tag("floor")',
    ],
  ];
  let edited = source;
  for (const [from, to] of edits) {
    assert.ok(edited.includes(from), `the template still has ${JSON.stringify(from)}`);
    edited = edited.replace(from, to);
  }
  await writeFile(game, edited);
  await copyFile(path.join(SAMPLES, "model.obj"), path.join(dir, "assets", "ship.obj"));
  await copyFile(path.join(SAMPLES, "compressed.glb"), path.join(dir, "assets", "hull.glb"));
  return dir;
}

const NONCE = "rust-assets-build-nonce";
const REAL_TIMERS: NativeTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => {
    if (typeof handle === "object" && handle !== null) clearTimeout(handle as NodeJS.Timeout);
  },
};

/** `state()` of the admitted dev-flavour game at `executable`, read over fd 3 after it drew a frame. */
async function stateOf(executable: string, scratch: string): Promise<Record<string, unknown>> {
  const stateDir = path.join(scratch, "state");
  await mkdir(stateDir, { recursive: true });
  const proc = spawn(executable, [], {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    detached: true,
    cwd: scratch,
    env: {
      GENEX_STUDIO_FD: "3",
      GENEX_STUDIO_NONCE: NONCE,
      GENEX_STATE_DIR: stateDir,
      HOME: scratch,
      GENEX_HEADLESS: "1",
    },
  });
  const exited = new Promise<GameExit>((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
  await once(proc, "spawn");
  const { pid, stdout, stderr } = proc;
  const fd3 = proc.stdio[3];
  if (!(fd3 instanceof Duplex) || pid === undefined || !stdout || !stderr) throw new Error("no protocol pipe");
  const kill = (signal: NodeJS.Signals) => {
    if (proc.exitCode === null && proc.signalCode === null) process.kill(-pid, signal);
  };
  const child: GameChild = { pid, fd3, stdout, stderr, exited, kill };
  const port = new NativeGamePort({
    child,
    nonce: NONCE,
    mode: NativeRunMode.Headless,
    stateDir,
    timers: REAL_TIMERS,
    encodeJpeg: async () => Buffer.from("jpeg"),
  });
  try {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("no ready within the wait")), STATE_WAIT_MS).unref();
    });
    await Promise.race([port.ready(), timeout]);
    await port.call(NativeOp.Capture, {});
    return await port.call(NativeOp.State);
  } finally {
    kill("SIGKILL");
    await exited;
  }
}

describe("the real lane imports a template game's models (macOS, pinned toolchain)", () => {
  const options = needsToolchain();
  it("builds the template with an OBJ and a Draco GLB, and the running game misses no model", {
    ...options,
    timeout: COLD_BUILD_MS,
  }, async () => {
    const home = await realpath(await tmpDir("rust-assets-real-"));
    const dir = await templateWithModels(path.join(home, "games"));
    const payload = rustPayloadDir(path.join(home, "resources"));
    await mkdir(payload, { recursive: true });
    for (const file of ["Cargo.lock", "clippy.toml"])
      await copyFile(path.join(WORKSPACE, file), path.join(payload, file));
    const toolchainDir = realpathSync(TOOLCHAIN_DIR);
    const vendor = await realpath(VENDOR_DIR);
    const toolchain: RustToolchain = {
      bin: path.join(toolchainDir, "sysroot", "bin"),
      vendor,
      clippyConf: payload,
      reads: [toolchainDir, vendor, payload],
    };
    const sandboxes = importerSandboxes();
    const builds = new RustBuilds({
      root: path.join(home, "app-data", "rust-builds"),
      sandbox: rustBuildSandboxes({ secretPaths: [], enabled: true, denyRead: [os.homedir(), home] }),
      locate: async () => ({ ok: true, toolchain }),
      currentLock: async () => lockOf({ rust: { version: "1.99.0", sha12: "000000000000" } }),
      stage: shippedRustStage(payload),
      emit: () => {},
      platform: process.platform,
      cores: 8,
      denyWrite: [],
      writeLock: async () => {},
      importAssets: rustStageImporter({
        jobsRoot: path.join(home, "app-data", "asset-jobs"),
        sandboxFor: sandboxes.sandboxFor,
        secretPaths: [],
      }),
    });
    const built = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Judging);
    assert.equal(built.ok, true, JSON.stringify(built.problem));
    const out = String(built.output);
    const assets = (await readdir(path.join(out, "assets"))).filter((name) => name.endsWith(".glb")).sort();
    assert.deepEqual(assets, ["hull.glb", "ship.glb"]);
    assert.equal(await extensionsOf(path.join(out, "assets", "hull.glb")), undefined);
    console.log(`real import receipt: ${JSON.stringify((await receiptOf(out)).assets)}`);
    const state = await stateOf(path.join(out, "game"), home);
    const render = (state.__render ?? {}) as Record<string, unknown>;
    assert.ok(render.tags, `the state names what was drawn: ${JSON.stringify(state)}`);
    assert.equal(render.missingModels, undefined, JSON.stringify(render));
  });
});
