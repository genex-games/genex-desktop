/**
 * The per-destination package (C-15, `src/main/rust-package-assets.ts`, called by `RustBuilds`'
 * `writeOutput`): a build's `out/assets` carries only the texture families its destination can
 * pick (Mac, Windows and Linux BC, iOS ASTC, Android ASTC and ETC2, the web BC, ASTC and ETC2 for
 * its adapter to choose from), never the RGBA8 family file the runtime never reads, and no source
 * image on a phone whose families cover it (owner call C6). Phones drop KTX2 mip levels above
 * `PHONE_MAX_TEXTURE_PX`. Every package carries `assets/genex-asset-index.json` (ids from the
 * trusted `genex-assets.lock`, bytes per family, dependency edges, the `boot` flag), and a game's
 * own file at that name is refused at stage (`reserved-asset-name`). The receipt's `package`
 * gives the destination's bytes.
 *
 * The lane rows run over a stub cargo and rustc (as `rust-assets-build.test.ts`), with the phones'
 * builders and stand-in Windows and Linux ones; the web's packaging needs its tools, so its row
 * runs the package step itself.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { serializeAssetLock } from "../../src/main/asset-db.ts";
import type { GameBuildGame } from "../../src/main/game-build.ts";
import type { StagedImportReport } from "../../src/main/rust-assets.ts";
import { RUST_MOBILE_TARGET_BUILDERS } from "../../src/main/rust-build-mobile.ts";
import {
  RustBuilds,
  type RustBuildSandbox,
  type RustBuildsOptions,
  type RustStaged,
  type RustTargetBuilder,
  type RustToolchain,
} from "../../src/main/rust-build.ts";
import {
  ASSET_INDEX_FILE,
  ASSET_INDEX_VERSION,
  type AssetIndex,
  type AssetPackageReport,
  DESTINATION_PACKAGES,
  PackageDrop,
  PackageRefusal,
  PHONE_MAX_TEXTURE_PX,
  packageAssets,
  packageCeilingRefusal,
  packageFamiliesListed,
  trimKtx2,
} from "../../src/main/rust-package-assets.ts";
import { AssetLicence, type AssetLockEntry, AssetOrigin } from "../../src/shared/asset-db.ts";
import { BuildProblemCode, CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { BuildTarget, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import type { ToolchainLock } from "../../src/shared/toolchain.ts";
import { ImportAction } from "../../src/substrate/asset-import/import-plan.ts";
import { readKtx2Header } from "../../src/substrate/asset-import/ktx2.ts";
import { writeKtx2 } from "../../src/substrate/asset-import/ktx2-write.ts";
import { TextureCompression } from "../../src/substrate/asset-import/texture-table.ts";
import type { RunRequest, RunResult } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const IMPORT = path.join(FIXTURES, "asset-import");
const SAMPLES = path.join(FIXTURES, "asset-previews");
const SKIP_OFF_POSIX = process.platform === "win32" ? "the stub toolchain is a POSIX shell script" : false;
const LANE_ROW_MS = 2 * MINUTE_MS;
const INDEX = ASSET_INDEX_FILE;
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
    exe="$CARGO_TARGET_DIR/stub/debug/game"
    mkdir -p "$(dirname "$exe")"
    printf '#!/bin/sh\\necho game\\n' > "$exe"
    chmod +x "$exe"
    echo '${ARTIFACT}' | sed -e "s#STAGE#$(dirname "$manifest")#" -e "s#MANIFEST#$manifest#" -e "s#EXE#$exe#g"
    echo '{"reason":"build-finished","success":true}'
    ;;
esac
exit 0
`;

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** `request` run by /bin/sh, uncontained: the lane's build sandbox is not what these rows test. */
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

/** Stand-in desktop cross builders (the real ones register with the cross lane). */
const crossBuilder = (triple: string, exe: string): RustTargetBuilder => ({
  ready: true,
  triple,
  macSdk: false,
  executables: [exe],
  assets: true,
});
const BUILDERS: Partial<Record<BuildTarget, RustTargetBuilder>> = {
  ...RUST_MOBILE_TARGET_BUILDERS,
  [BuildTarget.Windows]: crossBuilder("x86_64-pc-windows-gnullvm", "game.exe"),
  [BuildTarget.Linux]: crossBuilder("x86_64-unknown-linux-gnu", "game"),
};

/** A Rust lane over the stub toolchain in `parent`. */
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
    exec: async (file) =>
      file.endsWith("xcode-select")
        ? { code: 0, stdout: "/Library/Developer/CommandLineTools\n", stderr: "" }
        : { code: 0, stdout: "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk\n", stderr: "" },
    builders: BUILDERS,
    ...options,
  });
}

function gameOf(dir: string): GameBuildGame {
  const shape = {
    entry: "index.html",
    main: "src/main.rs",
    build: null,
    install: null,
    own: false,
    kind: ProjectKind.RustWgpu,
    serve: ".",
  };
  return {
    project: "game",
    dir,
    shape,
    destinations: { stack: GameStack.RustWgpu, targets: Object.values(BuildTarget) },
  };
}

const BASIS = path.join(IMPORT, "basis-uastc-64.ktx2");
const family = (name: string) => path.join(IMPORT, `basis-uastc-64.${name}.ktx2`);

/**
 * The textures of the package rows: a Basis source with all four family files, an image with three,
 * an image with ASTC only, an image with none, a model and a sound. The image bytes are never
 * decoded by the package step, so a GIF sample stands in for each PNG.
 */
const HARBOUR: Array<[string, string]> = [
  ["textures/rock.ktx2", BASIS],
  ["textures/rock.bc.ktx2", family("bc")],
  ["textures/rock.astc.ktx2", family("astc")],
  ["textures/rock.etc2.ktx2", family("etc2")],
  ["textures/rock.rgba8.ktx2", family("rgba8")],
  ["bark.png", path.join(SAMPLES, "animated.gif")],
  ["bark.bc.ktx2", family("bc")],
  ["bark.astc.ktx2", family("astc")],
  ["bark.etc2.ktx2", family("etc2")],
  ["leaf.png", path.join(SAMPLES, "animated.gif")],
  ["leaf.astc.ktx2", family("astc")],
  ["ground.png", path.join(SAMPLES, "animated.gif")],
  ["ship.glb", path.join(SAMPLES, "animated.glb")],
  ["tone.wav", path.join(SAMPLES, "tone.wav")],
];

/** What each destination's `out/assets` holds of {@link HARBOUR} (the index beside it). */
const EXPECTED: Record<BuildTarget, string[]> = {
  [BuildTarget.Mac]: [
    "bark.bc.ktx2",
    "bark.png",
    INDEX,
    "ground.png",
    "leaf.png",
    "ship.glb",
    "textures/rock.bc.ktx2",
    "textures/rock.ktx2",
    "tone.wav",
  ],
  [BuildTarget.Windows]: [],
  [BuildTarget.Linux]: [],
  [BuildTarget.Ios]: [
    "bark.astc.ktx2",
    INDEX,
    "ground.png",
    "leaf.astc.ktx2",
    "ship.glb",
    "textures/rock.astc.ktx2",
    "tone.wav",
  ],
  [BuildTarget.Android]: [
    "bark.astc.ktx2",
    "bark.etc2.ktx2",
    INDEX,
    "ground.png",
    "leaf.astc.ktx2",
    "leaf.png",
    "ship.glb",
    "textures/rock.astc.ktx2",
    "textures/rock.etc2.ktx2",
    "tone.wav",
  ],
  [BuildTarget.Web]: [
    "bark.astc.ktx2",
    "bark.bc.ktx2",
    "bark.etc2.ktx2",
    "bark.png",
    INDEX,
    "ground.png",
    "leaf.astc.ktx2",
    "leaf.png",
    "ship.glb",
    "textures/rock.astc.ktx2",
    "textures/rock.bc.ktx2",
    "textures/rock.etc2.ktx2",
    "textures/rock.ktx2",
    "tone.wav",
  ],
};
EXPECTED[BuildTarget.Windows] = EXPECTED[BuildTarget.Mac];
EXPECTED[BuildTarget.Linux] = EXPECTED[BuildTarget.Mac];

/** A Rust game folder with `assets` copied in under their names here. */
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

/** Every regular file under `dir`, `/`-separated, sorted. */
async function files(dir: string, rel = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await files(dir, child)));
    else if (entry.isFile()) found.push(child);
  }
  return found.sort((a, b) => (a < b ? -1 : Number(a > b)));
}

/** The receipt the lane wrote beside `output`. */
async function receiptOf(output: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(output.replace(/\.out$/, ".receipt.json"), "utf8"));
}

const LANE_TARGETS = [BuildTarget.Mac, BuildTarget.Windows, BuildTarget.Linux, BuildTarget.Ios, BuildTarget.Android];

describe("a Rust build's package carries only what its destination reads", { skip: SKIP_OFF_POSIX }, () => {
  for (const target of LANE_TARGETS) {
    it(`${target}: out/assets holds its families, the index, and the receipt its package bytes`, {
      timeout: LANE_ROW_MS,
    }, async () => {
      const parent = await realpath(await tmpDir(`rust-package-${target}-`));
      const dir = await gameWith(parent, HARBOUR);
      const built = await (await lane(parent)).ensure(gameOf(dir), target, CppBuildPurpose.Live);
      assert.equal(built.ok, true, JSON.stringify(built.problem));
      const out = path.join(String(built.output), "assets");
      assert.deepEqual(await files(out), EXPECTED[target]);
      const receipt = await receiptOf(String(built.output));
      const pack = receipt.package as AssetPackageReport | undefined;
      assert.equal(pack?.target, target);
      const outputs = receipt.outputs as Array<{ path: string; bytes: number }>;
      const assetBytes = outputs
        .filter((row) => row.path.startsWith("assets/"))
        .reduce((sum, row) => sum + row.bytes, 0);
      assert.equal(pack?.bytes, assetBytes, "the receipt's package bytes are out/assets' bytes");
      assert.equal(pack?.files, EXPECTED[target].length);
    });
  }

  // C-17: the lane hands the package the game's [assets] (its texture cap and budget) from the stage.
  it("an iPhone build trims to the game's phone_max_texture_px and measures its own [assets.ios] budget", {
    timeout: LANE_ROW_MS,
  }, async () => {
    const parent = await realpath(await tmpDir("rust-package-assets-toml-"));
    const dir = await gameWith(parent, [["huge.png", path.join(SAMPLES, "animated.gif")]]);
    await writeFile(path.join(dir, "assets", "huge.astc.ktx2"), chain(TextureCompression.Astc, 1024));
    const assets = { budgetMb: null, phoneMaxTexturePx: 512, destinations: { ios: 1 } };
    const staging: RustBuildsOptions["stage"] = async (game, into) => ({ ...(await stage(game, into)), assets });
    const built = await (await lane(parent, { stage: staging })).ensure(
      gameOf(dir),
      BuildTarget.Ios,
      CppBuildPurpose.Live,
    );
    assert.equal(built.ok, true, JSON.stringify(built.problem));
    const pack = (await receiptOf(String(built.output))).package as AssetPackageReport;
    assert.deepEqual(
      pack.trimmed.map((row) => [row.file, row.fromPx, row.toPx]),
      [["huge.astc.ktx2", 1024, 512]],
    );
    assert.deepEqual(pack.budget, {
      budgetBytes: 1024 * 1024,
      ceilingBytes: 4096 * 1024 * 1024,
      withinBudget: pack.bytes <= 1024 * 1024,
      withinCeiling: true,
    });
  });

  it("a game's own file at the index's name is refused at stage: reserved-asset-name", {
    timeout: LANE_ROW_MS,
  }, async () => {
    for (const name of [INDEX, "GENEX-Asset-Index.json"]) {
      const parent = await realpath(await tmpDir("rust-package-reserved-"));
      const dir = await gameWith(parent, [[name, new TextEncoder().encode('{"assets":[]}')]]);
      const built = await (await lane(parent)).ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
      assert.equal(built.ok, false, name);
      assert.equal(built.problem?.reason, BuildProblemCode.CommandFailed);
      assert.equal(built.rust?.refusal, "stage-refused");
      assert.match(JSON.stringify(built.problem), new RegExp(`${PackageRefusal.ReservedAssetName}: assets/${name}`));
    }
    // Only the top of assets/ is reserved: a nested file of that name is the game's.
    const parent = await realpath(await tmpDir("rust-package-nested-"));
    const nested = new TextEncoder().encode("{}");
    const dir = await gameWith(parent, [[`levels/${INDEX}`, nested]]);
    const built = await (await lane(parent)).ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(built.ok, true, JSON.stringify(built.problem));
    const out = path.join(String(built.output), "assets");
    assert.equal(sha(await readFile(path.join(out, "levels", INDEX))), sha(nested));
  });
});

/** A full-chain KTX2 of `side` texels in `compression`, each level filled with its level number. */
function chain(compression: TextureCompression, side: number): Uint8Array {
  const blockBytes = compression === TextureCompression.Rgba8 ? 4 : 16;
  const levels: Uint8Array[] = [];
  for (let px = side, level = 0; px >= 1; px >>= 1, level++) {
    const blocks = compression === TextureCompression.Rgba8 ? px * px : Math.ceil(px / 4) ** 2;
    levels.push(new Uint8Array(blocks * blockBytes).fill(level + 1));
  }
  return writeKtx2({ compression, srgb: true, side, levels });
}

/** A staged `assets/` folder of `parent` holding `assets` (from a sample path or bytes). */
async function stagedAssets(parent: string, assets: Array<[string, string | Uint8Array]>): Promise<string> {
  const from = path.join(parent, "stage", "assets");
  await mkdir(from, { recursive: true });
  for (const [name, source] of assets) {
    const to = path.join(from, name);
    await mkdir(path.dirname(to), { recursive: true });
    if (typeof source === "string") await copyFile(source, to);
    else await writeFile(to, source);
  }
  return from;
}

const indexOf = async (to: string): Promise<AssetIndex> =>
  JSON.parse(await readFile(path.join(to, ASSET_INDEX_FILE), "utf8")) as AssetIndex;

/** A lock row for `file` (game-relative) with `id`, its kind, a CC0 licence and `deps`. */
function lockRow(file: string, id: string, deps: string[] = []): AssetLockEntry {
  return {
    id,
    path: file,
    sha256: "0".repeat(64),
    kind: file.endsWith(".png") ? "image" : "model",
    origin: AssetOrigin.Cc0,
    licence: AssetLicence.Cc0,
    settings: {},
    importer: "1",
    deps,
    outputs: [],
    issues: [],
  };
}

describe("the package step over a stage", () => {
  it("the web package keeps every compressed family and the sources, never RGBA8", async () => {
    const parent = await realpath(await tmpDir("rust-package-web-"));
    const from = await stagedAssets(parent, HARBOUR);
    const to = path.join(parent, "out", "assets");
    const report = await packageAssets({ from, to, target: BuildTarget.Web });
    assert.deepEqual(await files(to), EXPECTED[BuildTarget.Web]);
    assert.deepEqual(report.dropped, [{ file: "textures/rock.rgba8.ktx2", reason: PackageDrop.FamilyNotShipped }]);
    const sizes = await Promise.all((await files(to)).map(async (rel) => (await readFile(path.join(to, rel))).length));
    assert.equal(
      report.bytes,
      sizes.reduce((sum, bytes) => sum + bytes, 0),
    );
    assert.equal(
      Object.values(report.bytesBy).reduce((sum, bytes) => sum + bytes, 0),
      report.bytes,
      "the per-family buckets add up to the package",
    );
  });
});

describe("the destination package table", () => {
  it("every destination's families are ones its texture table may pick, and none ships RGBA8", () => {
    for (const target of Object.values(BuildTarget)) {
      assert.equal(packageFamiliesListed(target), true, target);
      const families: readonly TextureCompression[] = DESTINATION_PACKAGES[target].families;
      assert.ok(!families.includes(TextureCompression.Rgba8), target);
    }
    assert.deepEqual(DESTINATION_PACKAGES[BuildTarget.Ios].families, [TextureCompression.Astc]);
    assert.equal(DESTINATION_PACKAGES[BuildTarget.Ios].keepSources, false, "owner call C6");
    assert.equal(DESTINATION_PACKAGES[BuildTarget.Android].keepSources, false, "owner call C6");
    assert.equal(DESTINATION_PACKAGES[BuildTarget.Mac].keepSources, true);
  });
});

describe("the asset index", () => {
  it("the index lists each asset under its game name, with the trusted lock's ids, licence and edges", async () => {
    const parent = await realpath(await tmpDir("rust-package-index-"));
    const from = await stagedAssets(parent, [...HARBOUR, ["ship.mtl", path.join(SAMPLES, "model.mtl")]]);
    const to = path.join(parent, "out", "assets");
    const lock = [
      lockRow("assets/bark.png", "00000000000000b1"),
      // The import step converted ship.obj into ship.glb: the GLB takes the OBJ's id.
      lockRow("assets/ship.obj", "00000000000000a1", ["00000000000000a2"]),
      lockRow("assets/ship.mtl", "00000000000000a2"),
    ];
    const imported: StagedImportReport = {
      jobs: 1,
      ms: 0,
      files: [
        {
          file: "assets/ship.obj",
          action: ImportAction.Convert,
          output: { file: "assets/ship.glb", sha256: "0".repeat(64), bytes: 1 },
        },
      ],
    };
    const report = await packageAssets({ from, to, target: BuildTarget.Ios, lock, imported });
    const index = await indexOf(to);
    assert.equal(index.version, ASSET_INDEX_VERSION);
    assert.equal(index.target, BuildTarget.Ios);
    const byPath = Object.fromEntries(index.assets.map((entry) => [entry.path, entry]));
    assert.deepEqual(Object.keys(byPath), [
      "bark.png",
      "ground.png",
      "leaf.png",
      "ship.glb",
      "ship.mtl",
      "textures/rock.ktx2",
      "tone.wav",
    ]);
    const astc = (await readFile(family("astc"))).length;
    // bark.png went out as its ASTC file only: the entry keeps the name the game reads it by. Its
    // file's levels (C-29, smallest first) are `rust-asset-index.test.ts`'s rows; here only their sides.
    const barkFile = byPath["bark.png"]?.files[0];
    assert.deepEqual(
      barkFile?.levels?.map((level) => level.px),
      [1, 2, 4, 8, 16, 32, 64],
    );
    const { levels: _levels, ...barkShipped } = barkFile ?? { path: "" };
    assert.deepEqual(
      { ...byPath["bark.png"], files: [barkShipped] },
      {
        path: "bark.png",
        id: "00000000000000b1",
        kind: "image",
        licence: AssetLicence.Cc0,
        bytes: astc,
        files: [{ path: "bark.astc.ktx2", family: TextureCompression.Astc, bytes: astc, px: 64 }],
        deps: [],
        boot: true,
      },
    );
    assert.equal(byPath["ship.glb"]?.id, "00000000000000a1");
    assert.deepEqual(byPath["ship.glb"]?.deps, ["00000000000000a2"]);
    assert.equal(byPath["ship.mtl"]?.id, "00000000000000a2");
    assert.equal(byPath["ground.png"]?.id, undefined, "no lock row: no id");
    assert.equal(byPath["ground.png"]?.licence, AssetLicence.Unknown);
    assert.deepEqual(
      byPath["ground.png"]?.files.map((file) => file.path),
      ["ground.png"],
    );
    assert.ok(
      index.assets.every((entry) => entry.boot),
      "every asset is boot when the game names no asset group (C-30)",
    );
    assert.deepEqual(
      report.dropped.filter((row) => row.reason === PackageDrop.SourceCovered).map((row) => row.file),
      ["bark.png", "leaf.png", "textures/rock.ktx2"],
    );
  });
});

describe("the asset index's ids", { skip: SKIP_OFF_POSIX }, () => {
  it("the lane takes ids only from a trusted lock: an edited one gives none", async () => {
    for (const edited of [false, true]) {
      const parent = await realpath(await tmpDir("rust-package-lock-"));
      const dir = await gameWith(parent, [["ship.glb", path.join(SAMPLES, "animated.glb")]]);
      const text = serializeAssetLock({
        version: 1,
        entries: [lockRow("assets/ship.glb", "00000000000000c1")],
        derived: [],
      });
      await writeFile(
        path.join(dir, "genex-assets.lock"),
        edited ? text.replace('"importer": "1"', '"importer": "2"') : text,
      );
      const built = await (await lane(parent)).ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
      assert.equal(built.ok, true, JSON.stringify(built.problem));
      const index = await indexOf(path.join(String(built.output), "assets"));
      assert.equal(index.assets[0]?.id, edited ? undefined : "00000000000000c1", edited ? "edited" : "trusted");
    }
  });
});

describe("a phone package's texture cap", () => {
  it("a phone drops family mips above its cap; desktops and the web keep the whole chain", async () => {
    const parent = await realpath(await tmpDir("rust-package-trim-"));
    const big = chain(TextureCompression.Astc, 256);
    const from = await stagedAssets(parent, [
      ["rock.png", path.join(SAMPLES, "animated.gif")],
      ["rock.astc.ktx2", big],
      ["rock.etc2.ktx2", chain(TextureCompression.Etc2, 256)],
      ["rock.bc.ktx2", chain(TextureCompression.Bc, 256)],
    ]);
    for (const target of [BuildTarget.Ios, BuildTarget.Android]) {
      const to = path.join(parent, target, "assets");
      const report = await packageAssets({ from, to, target, textureCapPx: 64 });
      const trimmed = new Uint8Array(await readFile(path.join(to, "rock.astc.ktx2")));
      const header = readKtx2Header(trimmed);
      assert.equal(header?.width, 64, target);
      assert.equal(header?.levels, 7, "every level from 64 down to 1 x 1");
      // The kept levels are the original's levels 2.. byte for byte: nothing is re-encoded.
      const expected = trimKtx2(big, 64);
      assert.deepEqual(trimmed, expected?.bytes);
      const original = writeKtx2({
        compression: TextureCompression.Astc,
        srgb: true,
        side: 64,
        levels: Array.from({ length: 7 }, (_, at) => new Uint8Array(Math.ceil((64 >> at) / 4) ** 2 * 16).fill(at + 3)),
      });
      assert.equal(sha(trimmed), sha(original), "levels 2.. of the 256 chain");
      const row = report.trimmed.find((cut) => cut.file === "rock.astc.ktx2");
      assert.deepEqual(row && { fromPx: row.fromPx, toPx: row.toPx }, { fromPx: 256, toPx: 64 });
      const index = await indexOf(to);
      const px = index.assets[0]?.files.find((file) => file.family === TextureCompression.Astc)?.px;
      assert.equal(px, 64);
    }
    for (const target of [BuildTarget.Mac, BuildTarget.Web]) {
      const to = path.join(parent, target, "assets");
      const report = await packageAssets({ from, to, target, textureCapPx: 64 });
      assert.deepEqual(report.trimmed, [], target);
      assert.equal(readKtx2Header(new Uint8Array(await readFile(path.join(to, "rock.bc.ktx2"))))?.width, 256);
    }
  });

  it(`a phone's default cap is ${PHONE_MAX_TEXTURE_PX} px`, async () => {
    const parent = await realpath(await tmpDir("rust-package-cap-"));
    const from = await stagedAssets(parent, [
      ["huge.astc.ktx2", chain(TextureCompression.Astc, 2 * PHONE_MAX_TEXTURE_PX)],
    ]);
    const to = path.join(parent, "out", "assets");
    const report = await packageAssets({ from, to, target: BuildTarget.Ios });
    assert.equal(
      readKtx2Header(new Uint8Array(await readFile(path.join(to, "huge.astc.ktx2"))))?.width,
      PHONE_MAX_TEXTURE_PX,
    );
    assert.ok((report.trimmed[0]?.bytesAfter ?? 0) < (report.trimmed[0]?.bytesBefore ?? 0) / 3);
  });

  it("a file the trim cannot read as a family's full chain goes out as it is", async () => {
    const parent = await realpath(await tmpDir("rust-package-untrimmed-"));
    const full = chain(TextureCompression.Astc, 256);
    const partial = writeKtx2({
      compression: TextureCompression.Astc,
      srgb: false,
      side: 256,
      levels: [new Uint8Array(64 * 64 * 16)],
    });
    const truncated = full.subarray(0, full.length - 100);
    const notKtx2 = new TextEncoder().encode("not a texture");
    const cases: Array<[string, Uint8Array]> = [
      ["partial.astc.ktx2", partial],
      ["truncated.astc.ktx2", truncated],
      ["text.astc.ktx2", notKtx2],
      ["basis.astc.ktx2", new Uint8Array(await readFile(BASIS))],
    ];
    const from = await stagedAssets(parent, cases);
    const to = path.join(parent, "out", "assets");
    const report = await packageAssets({ from, to, target: BuildTarget.Ios, textureCapPx: 64 });
    assert.deepEqual(report.trimmed, []);
    for (const [name, bytes] of cases) assert.equal(sha(await readFile(path.join(to, name))), sha(bytes), name);
  });

  it("two packages of one stage are byte-identical", async () => {
    const parent = await realpath(await tmpDir("rust-package-twice-"));
    const from = await stagedAssets(parent, HARBOUR);
    const trees: string[] = [];
    for (const run of ["a", "b"]) {
      const to = path.join(parent, run, "assets");
      await packageAssets({ from, to, target: BuildTarget.Android });
      const listed = await files(to);
      const digests = await Promise.all(listed.map(async (rel) => `${rel} ${sha(await readFile(path.join(to, rel)))}`));
      trees.push(digests.join("\n"));
    }
    assert.equal(trees[0], trees[1]);
  });
});

const MIB = 1024 * 1024;

/** A stage of `count` files of `bytes` each, for the budget rows. */
async function sizedStage(parent: string, count: number, bytes: number): Promise<string> {
  const filler = new Uint8Array(bytes).fill(7);
  return await stagedAssets(
    parent,
    Array.from({ length: count }, (_, at): [string, Uint8Array] => [`data/blob-${at}.bin`, filler]),
  );
}

// Owner call C8: each destination's package has a budget (warn past it) and the web a hard cap,
// the shell's 512 MB, past which the build is refused `assets-over-ceiling`.
describe("the package step against its destination's budget (C-17)", () => {
  const defaults: Array<[BuildTarget, number, number | null]> = [
    [BuildTarget.Web, 64, 512],
    [BuildTarget.Ios, 200, 4096],
    [BuildTarget.Android, 200, 4096],
    [BuildTarget.Mac, 2048, null],
    [BuildTarget.Windows, 2048, null],
    [BuildTarget.Linux, 2048, null],
  ];
  for (const [target, budgetMb, ceilingMb] of defaults) {
    it(`a ${target} package with no budget named is measured against ${budgetMb} MB`, async () => {
      const parent = await realpath(await tmpDir("rust-package-budget-default-"));
      const from = await sizedStage(parent, 2, 1024);
      const report = await packageAssets({ from, to: path.join(parent, "out", "assets"), target });
      assert.deepEqual(report.budget, {
        budgetBytes: budgetMb * MIB,
        ceilingBytes: ceilingMb === null ? null : ceilingMb * MIB,
        withinBudget: true,
        withinCeiling: true,
      });
    });
  }

  it("a web package past its budget is measured over it, within the ceiling, and not refused", async () => {
    const parent = await realpath(await tmpDir("rust-package-budget-over-"));
    const from = await sizedStage(parent, 3, 4096);
    const to = path.join(parent, "out", "assets");
    const budget = { budgetBytes: 8192, ceilingBytes: 64 * 1024 };
    const report = await packageAssets({ from, to, target: BuildTarget.Web, budget });
    assert.ok(report.bytes > budget.budgetBytes, `${report.bytes} bytes`);
    assert.deepEqual(report.budget, { ...budget, withinBudget: false, withinCeiling: true });
    assert.equal(packageCeilingRefusal(report), null, "past the budget only warns");
    assert.deepEqual((await files(to)).length, 4, "every file still goes out");
  });

  it("a web package past the ceiling is refused assets-over-ceiling, naming its size and the cap", async () => {
    const parent = await realpath(await tmpDir("rust-package-budget-ceiling-"));
    const from = await sizedStage(parent, 3, 4096);
    const budget = { budgetBytes: 4096, ceilingBytes: 8192 };
    const report = await packageAssets({
      from,
      to: path.join(parent, "out", "assets"),
      target: BuildTarget.Web,
      budget,
    });
    assert.deepEqual(report.budget, { ...budget, withinBudget: false, withinCeiling: false });
    assert.equal(PackageRefusal.AssetsOverCeiling, "assets-over-ceiling");
    const refusal = packageCeilingRefusal(report) ?? "";
    assert.match(refusal, /^assets-over-ceiling: /);
    assert.match(refusal, new RegExp(`${report.bytes} bytes`));
    assert.match(refusal, /web/);
  });

  it("a package exactly at its budget and its ceiling is within both", async () => {
    const parent = await realpath(await tmpDir("rust-package-budget-exact-"));
    const from = await sizedStage(parent, 1, 2048);
    const probe = await packageAssets({ from, to: path.join(parent, "probe", "assets"), target: BuildTarget.Web });
    const budget = { budgetBytes: probe.bytes, ceilingBytes: probe.bytes };
    const report = await packageAssets({
      from,
      to: path.join(parent, "out", "assets"),
      target: BuildTarget.Web,
      budget,
    });
    assert.deepEqual(report.budget, { ...budget, withinBudget: true, withinCeiling: true });
    assert.equal(packageCeilingRefusal(report), null);
  });

  it("a desktop package has no ceiling: however far past its budget, it is never refused", async () => {
    const parent = await realpath(await tmpDir("rust-package-budget-desktop-"));
    const from = await sizedStage(parent, 2, 4096);
    const budget = { budgetBytes: 1, ceilingBytes: null };
    const report = await packageAssets({
      from,
      to: path.join(parent, "out", "assets"),
      target: BuildTarget.Mac,
      budget,
    });
    assert.deepEqual(report.budget, { ...budget, withinBudget: false, withinCeiling: true });
    assert.equal(packageCeilingRefusal(report), null);
  });
});

describe("the package step over a hostile stage", { skip: SKIP_OFF_POSIX }, () => {
  it("never follows a link or reads a FIFO, and writes nothing outside out/assets", async () => {
    const parent = await realpath(await tmpDir("rust-package-hostile-"));
    const outside = path.join(parent, "outside");
    await mkdir(path.join(outside, "dir"), { recursive: true });
    await writeFile(path.join(outside, "secret.png"), "secret");
    await writeFile(path.join(outside, "dir", "inner.astc.ktx2"), chain(TextureCompression.Astc, 8));
    const before = await files(outside);
    const from = await stagedAssets(parent, [["real.png", path.join(SAMPLES, "animated.gif")]]);
    await symlink(path.join(outside, "secret.png"), path.join(from, "linked.png"));
    await symlink(path.join(outside, "secret.png"), path.join(from, "real.astc.ktx2"));
    await symlink(path.join(outside, "dir"), path.join(from, "linked-dir"));
    execFileSync("/usr/bin/mkfifo", [path.join(from, "pipe.astc.ktx2")]);
    // A link in place of the index's name: the package writes its own file there, never through it.
    await symlink(path.join(outside, "secret.png"), path.join(from, ASSET_INDEX_FILE));
    const to = path.join(parent, "out", "assets");
    const report = await packageAssets({ from, to, target: BuildTarget.Ios });
    assert.deepEqual(await files(to), [ASSET_INDEX_FILE, "real.png"], "the image stays: no family file covers it");
    assert.deepEqual(report.dropped, []);
    assert.deepEqual(await files(outside), before);
    assert.equal(await readFile(path.join(outside, "secret.png"), "utf8"), "secret", "the link's target is untouched");
    const index = await indexOf(to);
    assert.deepEqual(
      index.assets.map((entry) => entry.path),
      ["real.png"],
    );
  });
});
