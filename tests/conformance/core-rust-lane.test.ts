/**
 * The core's own Rust lane (`core/rust-lane.ts`, constructed by `StudioCore`): a Rust · wgpu
 * game's build reaches `RustBuilds` through the build-lane seam instead of `lane-missing`, over
 * the profile's store and the shipped payload (`<resources>/native/genex-rust/`: the lock line the
 * genex release is read from and the determinism gate's `clippy.toml`). A payload part that is
 * absent, a link or not a regular file refuses typed, with nothing staged.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  createCoreRustBuilds,
  RUST_CLIPPY_FILE,
  RUST_LOCK_LINE_FILE,
  rustPayloadDir,
  shippedGenexRelease,
  shippedRustStage,
  storeRustLocate,
} from "../../src/main/core/rust-lane.ts";
import {
  FIXTURE_GENEX_VERSION,
  FIXTURE_RUST_FORCE_ERROR,
  FIXTURE_RUST_FORCED_ERROR,
  fixtureRustWebOutput,
  RustFixtureKind,
  seedFixtureRustStore,
  seedRustFixture,
} from "../../src/main/dev/fixture-rust.ts";
import {
  FIXTURE_RUST_GAME,
  fixtureWebOutput,
  seedFixtureToolchainStore,
} from "../../src/main/dev/fixture-toolchains.ts";
import type { GameBuildGame } from "../../src/main/game-build.ts";
import type { RustBuildSandbox, RustBuildsOptions } from "../../src/main/rust-build.ts";
import { rustTargetBuilders } from "../../src/main/core/internals.ts";
import { RustBuildRefusal, RustBuildStep } from "../../src/main/rust-build-diagnostics.ts";
import { RUST_WEB_EXPORT_PROFILE_SETTINGS, WEB_FILES, type WebAssetMap } from "../../src/main/rust-build-web.ts";
import { RustFlavour, RustManifestCode } from "../../src/main/rust-manifest.ts";
import { ASSET_INDEX_FILE, type AssetIndex } from "../../src/main/rust-package-assets.ts";
import { BuildProblemCode, CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { ExportWarningCode, WEB_BUDGET_MB_BYTES } from "../../src/shared/game-export-contract.ts";
import { BuildTarget, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import type { ToolchainLock } from "../../src/shared/toolchain.ts";
import { fnv1a64Hex } from "../../src/substrate/native-game-port.ts";
import { type RunRequest, type RunResult, shellQuote } from "../../src/substrate/spawn.ts";
import { readCurrentLock } from "../../src/substrate/toolchain-store/lock.ts";
import { RustMissing, rustSysroot } from "../../src/substrate/toolchain-store/rust-locate.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const LOCK_LINE = path.join(REPO, "native", "genex-rust", RUST_LOCK_LINE_FILE);
const CLIPPY = path.join(REPO, "native", "genex-rust", RUST_CLIPPY_FILE);
const SKIP_UNLESS_MAC = process.platform === "darwin" ? false : "a Rust Mac build needs the Mac SDK";
const SKIP_ON_WINDOWS = process.platform === "win32" ? "the fixture's stub tools are POSIX shell scripts" : false;
/**
 * The targets the fixture store's Rust base locates on this host: the Mac and the browser on a Mac;
 * the browser alone on the Linux runner, whose Rust lane builds no Mac app.
 */
const LOCATED_HERE = process.platform === "darwin" ? [BuildTarget.Mac, BuildTarget.Web] : [BuildTarget.Web];
const MAC_SDK = "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk";
const TEMPLATE_GENEX_TOML = path.join(REPO, "src", "game-template-rust", "genex.toml");
const RENDER_TABLE = "[render]";
const RENDER_SUBTABLE_PREFIX = "[render.";
/** Two `[[asset_group]]` rows sharing `props/door.png` (C-30). */
const ASSET_GROUP_ROWS =
  '[[asset_group]]\nname = "harbour"\npaths = ["props/**", "textures/sky.png"]\n\n[[asset_group]]\nname = "crypt"\npaths = ["props/door.png"]\n';

/**
 * The [render] fragment the stage hands the lane for src/game-template-rust/genex.toml, read from
 * that file: its `[render]` and `[render.*]` headers and assignments in file order, without comments
 * or blank lines, so the row follows the template's look instead of a copy that goes stale.
 */
async function templateRenderToml(): Promise<string> {
  const lines: string[] = [];
  let inRender = false;
  for (const raw of (await readFile(TEMPLATE_GENEX_TOML, "utf8")).split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      inRender = line === RENDER_TABLE || line.startsWith(RENDER_SUBTABLE_PREFIX);
      if (inRender) lines.push(line);
      continue;
    }
    if (inRender) lines.push(line);
  }
  assert.ok(lines.includes(RENDER_TABLE), "the template declares a [render] section");
  return `${lines.join("\n")}\n`;
}

/** A resources folder holding the checkout's Rust payload (lock line and gate), as a package ships it. */
async function shippedResources(): Promise<string> {
  const resources = await realpath(await tmpDir("core-rust-lane-resources-"));
  const payload = rustPayloadDir(resources);
  await mkdir(payload, { recursive: true });
  await copyFile(LOCK_LINE, path.join(payload, RUST_LOCK_LINE_FILE));
  await copyFile(CLIPPY, path.join(payload, RUST_CLIPPY_FILE));
  const web = path.join(resources, "game-template-rust", "web");
  await mkdir(web, { recursive: true });
  await copyFile(path.join(REPO, "src", "game-template-rust", "web", "shell.html"), path.join(web, "shell.html"));
  return resources;
}

/** A disposable fixture Rust store and its lock. */
async function fixtureStore(): Promise<{ store: string; lock: ToolchainLock }> {
  const store = path.join(await realpath(await tmpDir("core-rust-lane-store-")), "toolchains");
  const lock = await seedFixtureRustStore(store, { webOutput: fixtureRustWebOutput(), kind: RustFixtureKind.Game });
  assert.ok(lock, "the fixture seeded its store");
  return { store, lock };
}

/** A game folder made from the shipped Rust template, as the library scaffolds it. */
async function templateGame(): Promise<string> {
  const { core } = await coreLite({ gamesRoot: await realpath(await tmpDir("core-rust-lane-games-")) });
  await seedRustFixture(core, RustFixtureKind.Game);
  const game = (await core.games.list()).find((listed) => listed.name === FIXTURE_RUST_GAME.name);
  assert.ok(game, "the fixture's Rust game is in the library");
  return game.dir;
}

/** `request` run by /bin/sh, recorded: the lane's commands without containment. */
function openSandbox() {
  const requests: RunRequest[] = [];
  const sandbox = async (): Promise<RustBuildSandbox> => ({
    run: async (request) => {
      requests.push(request);
      return await runShell(request);
    },
    dispose: async () => {},
  });
  return { sandbox, requests };
}

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
    child.on("close", (code, signal) => {
      const facts = { timedOut: false, truncated: false, sandboxed: false, durationMs: Date.now() - started };
      resolve({ code, signal, stdout, stderr, ...facts, command: request.command, cwd: request.cwd });
    });
  });
}

/** A Rust game as the lane takes it. */
function rustGame(dir: string): GameBuildGame {
  const shape = {
    entry: "index.html",
    main: "src/main.rs",
    build: null,
    install: null,
    own: false,
    kind: ProjectKind.RustWgpu,
    serve: ".",
  };
  const destinations = { stack: GameStack.RustWgpu, targets: [...FIXTURE_RUST_GAME.targets] };
  return { project: FIXTURE_RUST_GAME.name, dir, shape, destinations };
}

/** The core's lane over `store` and `resources`, the Mac SDK answered without running `xcrun`. */
async function coreLane(
  store: string,
  resources: string,
  sandbox: () => Promise<RustBuildSandbox>,
  builders?: RustBuildsOptions["builders"],
) {
  return createCoreRustBuilds({
    ...(builders ? { builders } : {}),
    root: path.join(await realpath(await tmpDir("core-rust-lane-builds-")), "rust-builds"),
    store,
    resources,
    sandbox,
    emit: () => {},
    platform: "darwin",
    cores: 8,
    denyWrite: [store],
    writeLock: async () => {},
    exec: async (file) =>
      file.endsWith("xcode-select")
        ? { code: 0, stdout: "/Library/Developer/CommandLineTools\n", stderr: "" }
        : { code: 0, stdout: `${MAC_SDK}\n`, stderr: "" },
  });
}

/** Replaces a payload file with a hostile stand-in. */
type Plant = (file: string, real: string) => Promise<void>;

/** Payload files that are not a regular file the payload holds: each refuses. */
const HOSTILE_PAYLOAD_FILES: ReadonlyArray<readonly [string, Plant]> = [
  ["absent", async () => {}],
  ["a link to the real file", async (file, real) => symlink(real, file)],
  ["a folder", async (file) => mkdir(file)],
  ["empty", async (file) => writeFile(file, "")],
];

describe("the core registers its Rust lane behind the seam", { skip: SKIP_ON_WINDOWS }, () => {
  it("a Rust game's web export reaches the Rust lane, never lane-missing, and is the packaged page", async () => {
    const { core } = await coreLite({ gamesRoot: await realpath(await tmpDir("core-rust-lane-games-")) });
    await seedRustFixture(core, RustFixtureKind.Game);
    const out = path.join(await tmpDir("core-rust-lane-export-"), "out");
    // The web builder is registered (M2.12c): the export is the lane's packaged folder.
    await core.exportPublicCopy(FIXTURE_RUST_GAME.name, out);
    const served = await readdir(out);
    for (const file of ["index.html", "game.js", "game_bg.wasm", "size.json"]) assert.ok(served.includes(file), file);
    assert.ok(!served.includes("game.wasm"), "the raw module cargo built is never served");
  });

  it("a Rust game's web export carries its staged assets and the asset map the page fetches them by", async () => {
    const { core } = await coreLite({ gamesRoot: await realpath(await tmpDir("core-rust-lane-games-")) });
    await seedRustFixture(core, RustFixtureKind.Game);
    const png = Buffer.from("\u0089PNG\r\n\u001a\na staged texture");
    const textures = path.join(core.games.dirFor(FIXTURE_RUST_GAME.name), "assets", "textures");
    await mkdir(textures, { recursive: true });
    await writeFile(path.join(textures, "sky.png"), png);
    const out = path.join(await tmpDir("core-rust-lane-export-"), "out");
    await core.exportPublicCopy(FIXTURE_RUST_GAME.name, out);
    assert.deepEqual(
      await readFile(path.join(out, "assets", "textures", "sky.png")),
      png,
      "the export carries the asset",
    );
    const map = JSON.parse(await readFile(path.join(out, WEB_FILES.assetMap), "utf8")) as WebAssetMap;
    const sky = map.files.find((file) => file.path === "textures/sky.png");
    assert.deepEqual(sky, { path: "textures/sky.png", bytes: png.length, fnv1a64: fnv1a64Hex(png) });
  });

  it("a Rust game's export indexes the asset groups its genex.toml names; a member is not boot (C-30)", async () => {
    const { core } = await coreLite({ gamesRoot: await realpath(await tmpDir("core-rust-lane-games-")) });
    await seedRustFixture(core, RustFixtureKind.Game);
    const game = core.games.dirFor(FIXTURE_RUST_GAME.name);
    const toml = path.join(game, "genex.toml");
    await writeFile(toml, `${await readFile(toml, "utf8")}\n${ASSET_GROUP_ROWS}`);
    for (const rel of ["props/door.png", "props/sail.png", "textures/sky.png", "textures/sea.png"]) {
      await mkdir(path.dirname(path.join(game, "assets", rel)), { recursive: true });
      await writeFile(path.join(game, "assets", rel), Buffer.from(`\u0089PNG\r\n\u001a\n${rel}`));
    }
    const out = path.join(await tmpDir("core-rust-lane-export-"), "out");
    await core.exportPublicCopy(FIXTURE_RUST_GAME.name, out);
    const index = JSON.parse(await readFile(path.join(out, "assets", ASSET_INDEX_FILE), "utf8")) as AssetIndex;
    assert.deepEqual(index.groups, [
      { name: "crypt", assets: ["props/door.png"] },
      { name: "harbour", assets: ["props/door.png", "props/sail.png", "textures/sky.png"] },
    ]);
    assert.deepEqual(
      index.assets.filter((entry) => entry.boot).map((entry) => entry.path),
      ["textures/sea.png"],
    );
  });

  // Owner call C8 (C-17): a web package past its game's budget exports with `assets-over-budget`, its
  // bytes and the budget; one within it carries no such warning.
  it("a Rust game's web export past its [assets.web] budget warns assets-over-budget, and is made (C-17)", async () => {
    const { core } = await coreLite({ gamesRoot: await realpath(await tmpDir("core-rust-lane-games-")) });
    await seedRustFixture(core, RustFixtureKind.Game);
    const game = core.games.dirFor(FIXTURE_RUST_GAME.name);
    const toml = path.join(game, "genex.toml");
    await writeFile(toml, `${await readFile(toml, "utf8")}\n[assets.web]\nbudget_mb = 1\n`);
    await mkdir(path.join(game, "assets", "data"), { recursive: true });
    await writeFile(path.join(game, "assets", "data", "big.bin"), new Uint8Array(WEB_BUDGET_MB_BYTES + 1));
    const out = path.join(await tmpDir("core-rust-lane-export-"), "out");
    const result = await core.exportPublicCopy(FIXTURE_RUST_GAME.name, out);
    const warning = result.warnings?.find((found) => found.code === ExportWarningCode.AssetsOverBudget);
    assert.ok(warning && warning.code === ExportWarningCode.AssetsOverBudget, JSON.stringify(result.warnings));
    assert.equal(warning.budgetBytes, WEB_BUDGET_MB_BYTES);
    assert.ok(warning.bytes > WEB_BUDGET_MB_BYTES, `${warning.bytes} bytes`);
    assert.ok(existsSync(path.join(out, "assets", "data", "big.bin")), "the export is made");
  });

  it("a Rust game's web export within its asset budget carries no assets warning (C-17)", async () => {
    const { core } = await coreLite({ gamesRoot: await realpath(await tmpDir("core-rust-lane-games-")) });
    await seedRustFixture(core, RustFixtureKind.Game);
    const out = path.join(await tmpDir("core-rust-lane-export-"), "out");
    const result = await core.exportPublicCopy(FIXTURE_RUST_GAME.name, out);
    assert.ok(!result.warnings?.some((found) => found.code === ExportWarningCode.AssetsOverBudget));
  });

  it("a Rust game's build runs the import step: a model the importer refuses leaves the export", async () => {
    const { core } = await coreLite({ gamesRoot: await realpath(await tmpDir("core-rust-lane-games-")) });
    await seedRustFixture(core, RustFixtureKind.Game);
    const models = path.join(core.games.dirFor(FIXTURE_RUST_GAME.name), "assets", "models");
    await mkdir(models, { recursive: true });
    await writeFile(path.join(models, "boat.glb"), Buffer.from("glTF\u0002\u0000\u0000\u0000not a model"));
    const out = path.join(await tmpDir("core-rust-lane-export-"), "out");
    await core.exportPublicCopy(FIXTURE_RUST_GAME.name, out);
    assert.equal(existsSync(path.join(out, "assets", "models", "boat.glb")), false, "the refused model is not shipped");
    const map = JSON.parse(await readFile(path.join(out, WEB_FILES.assetMap), "utf8")) as WebAssetMap;
    assert.equal(
      map.files.find((file) => file.path === "models/boat.glb"),
      undefined,
      "nor fetched by the page",
    );
  });
});

describe("native.build of a Rust game", { skip: SKIP_UNLESS_MAC }, () => {
  it("builds with the Rust stack's lock, never the C++ stack's, beside a C++ store", async () => {
    const { core, api } = await coreLite({ gamesRoot: await realpath(await tmpDir("core-rust-lane-games-")) });
    const cpp = await seedFixtureToolchainStore(core.layout.toolchains, { webOutput: fixtureWebOutput() });
    assert.ok(cpp, "the C++ fixture seeded the store");
    await seedRustFixture(core, RustFixtureKind.Game);
    const rust = await readCurrentLock(core.layout.toolchains, GameStack.RustWgpu);
    assert.ok(rust && rust.digest !== cpp.digest);
    const call = api() as unknown as Record<
      string,
      (params: unknown) => Promise<{ lock: string | null; problem: unknown }>
    >;
    const built = await call["native.build"]?.({ project: FIXTURE_RUST_GAME.name, target: BuildTarget.Mac });
    assert.equal(built?.lock, rust.digest.slice(0, 12), JSON.stringify(built?.problem));
    assert.notEqual((built?.problem as { reason?: string } | null)?.reason, BuildProblemCode.ToolchainMissing);
  });
});

describe("the core's Rust locate: the store's toolchain, the payload's gate", { skip: SKIP_ON_WINDOWS }, () => {
  it("locates the Mac and the web from the base, clippy at the payload, reading only the store and the payload", async () => {
    const { store, lock } = await fixtureStore();
    const payload = rustPayloadDir(await shippedResources());
    const locate = storeRustLocate(store, payload);
    for (const target of LOCATED_HERE) {
      const found = await locate(lock, target);
      assert.ok(found.ok, `${target}: ${JSON.stringify(found)}`);
      assert.equal(found.toolchain.bin, path.join(rustSysroot(store, lock), "bin"));
      assert.equal(found.toolchain.clippyConf, payload);
      assert.deepEqual(found.toolchain.reads, [store, payload]);
    }
    assert.deepEqual(await locate(lock, BuildTarget.Ios), { ok: false, missing: [RustMissing.Base] });
  });

  for (const [name, plant] of HOSTILE_PAYLOAD_FILES) {
    it(`locates nothing when the payload's clippy.toml is ${name}`, async () => {
      const { store, lock } = await fixtureStore();
      const payload = rustPayloadDir(await shippedResources());
      const file = path.join(payload, RUST_CLIPPY_FILE);
      await rm(file);
      await plant(file, CLIPPY);
      const found = await storeRustLocate(store, payload)(lock, BuildTarget.Web);
      assert.equal(found.ok, false);
      assert.match(found.ok ? "" : (found.missing[0] ?? ""), /clippy\.toml/);
    });
  }
});

describe("the core's Rust stage: the genex release the shipped lock line pins", { skip: SKIP_ON_WINDOWS }, () => {
  it("reads the checkout's release and stages the template game with the facade pinned to it", async () => {
    const payload = rustPayloadDir(await shippedResources());
    assert.equal(await shippedGenexRelease(payload), FIXTURE_GENEX_VERSION);
    const into = path.join(await realpath(await tmpDir("core-rust-lane-stage-")), "game.stage");
    const staged = await shippedRustStage(payload)(
      { project: "ferris", dir: await templateGame() },
      into,
      BuildTarget.Mac,
      RustFlavour.Export,
    );
    // Flipped (RQ0 review): the stage also hands the lane the game's [render] and [[wgsl]] fragments.
    // Flipped (pass-1 gate): the template ships a [render] section with its look since RX wave 0, so
    // the fragment is that section; it still has no [[wgsl]] rows (an empty set, still compiled in).
    // Flipped (pass-1 fix, platform cheap): the expected fragment is read from the template's own
    // genex.toml, so a change to its look (ev_compensation 0.5 to 1.5) moves both sides.
    assert.deepEqual(staged, {
      ok: true,
      dependencies: ["genex"],
      title: FIXTURE_RUST_GAME.title,
      nativeFeatures: [],
      renderToml: await templateRenderToml(),
      wgslToml: "",
      wasmBudgetMb: null,
      // Flipped (renderer pass 2, D11): the stage also hands the lane the game's [render.loading],
      // null for the template, which styles no loading screen of its own.
      loading: null,
      // Flipped (C-30): the stage also hands the lane the game's [[asset_group]] rows, none for the template.
      assetGroups: [],
      // Flipped (C-17): the stage also hands the lane the game's [assets] budgets, null for the template.
      assets: null,
      // Flipped (G6 MP-5b): the stage also hands the lane the game's [net], null for the template.
      net: null,
    });
    // Flipped (release R-2): the template switches off nav, streaming and animation, so the facade
    // is linked without default features. Flipped again (gate GR): audio is off too, keeping physics.
    assert.match(
      await readFile(path.join(into, "Cargo.toml"), "utf8"),
      /^genex = \{ version = "=0\.1\.0", default-features = false, features = \["physics"\] \}$/m,
    );
  });

  it("hands the lane the web budget a game names in [web]", async () => {
    const payload = rustPayloadDir(await shippedResources());
    const dir = await templateGame();
    await writeFile(
      path.join(dir, "genex.toml"),
      `${await readFile(path.join(dir, "genex.toml"), "utf8")}\n[web]\nwasm_budget_mb = 12\n`,
    );
    const into = path.join(await realpath(await tmpDir("core-rust-lane-stage-")), "game.stage");
    const staged = await shippedRustStage(payload)(
      { project: "ferris", dir },
      into,
      BuildTarget.Web,
      RustFlavour.Export,
    );
    assert.ok(staged.ok, JSON.stringify(staged));
    assert.equal(staged.wasmBudgetMb, 12);
  });

  it("hands the lane the loading screen a game styles in [render.loading]", async () => {
    const payload = rustPayloadDir(await shippedResources());
    const dir = await templateGame();
    const style = { title: "Harbour Nights", background: "#203040", logo: "ui/logo.png" };
    const table = Object.entries(style).map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
    await writeFile(
      path.join(dir, "genex.toml"),
      `${await readFile(path.join(dir, "genex.toml"), "utf8")}\n[render.loading]\n${table.join("\n")}\n`,
    );
    const into = path.join(await realpath(await tmpDir("core-rust-lane-stage-")), "game.stage");
    const staged = await shippedRustStage(payload)(
      { project: "ferris", dir },
      into,
      BuildTarget.Web,
      RustFlavour.Export,
    );
    assert.ok(staged.ok, JSON.stringify(staged));
    assert.deepEqual(staged.loading, style);
  });

  const lockLines: ReadonlyArray<readonly [string, Plant]> = [
    ...HOSTILE_PAYLOAD_FILES,
    ["not a cargo lock", async (file) => writeFile(file, "genex = 1\n")],
    [
      "a lock without genex",
      async (file) => writeFile(file, 'version = 4\n\n[[package]]\nname = "noise"\nversion = "0.9.0"\n'),
    ],
    [
      "a lock with two genex releases",
      async (file) =>
        writeFile(
          file,
          'version = 4\n\n[[package]]\nname = "genex"\nversion = "0.1.0"\n\n[[package]]\nname = "genex"\nversion = "0.2.0"\n',
        ),
    ],
  ];
  for (const [name, plant] of lockLines) {
    it(`refuses lock-unreadable, staging nothing, when the lock line is ${name}`, async () => {
      const payload = rustPayloadDir(await shippedResources());
      const file = path.join(payload, RUST_LOCK_LINE_FILE);
      await rm(file);
      await plant(file, LOCK_LINE);
      const parent = await realpath(await tmpDir("core-rust-lane-stage-"));
      const staged = await shippedRustStage(payload)(
        { project: "ferris", dir: await templateGame() },
        path.join(parent, "game.stage"),
        BuildTarget.Mac,
        RustFlavour.Export,
      );
      assert.equal(staged.ok, false);
      assert.equal(staged.ok ? null : staged.code, RustManifestCode.LockUnreadable);
      assert.deepEqual(await readdir(parent), [], "nothing staged");
    });
  }
});

describe("the core's Rust stage: a game's [[asset_group]] rows", { skip: SKIP_ON_WINDOWS }, () => {
  it("hands the lane the asset groups a game names in [[asset_group]], in file order (C-30)", async () => {
    const payload = rustPayloadDir(await shippedResources());
    const dir = await templateGame();
    await writeFile(
      path.join(dir, "genex.toml"),
      `${await readFile(path.join(dir, "genex.toml"), "utf8")}\n${ASSET_GROUP_ROWS}`,
    );
    const into = path.join(await realpath(await tmpDir("core-rust-lane-stage-")), "game.stage");
    const staged = await shippedRustStage(payload)(
      { project: "ferris", dir },
      into,
      BuildTarget.Mac,
      RustFlavour.Export,
    );
    assert.ok(staged.ok, JSON.stringify(staged));
    assert.deepEqual(staged.assetGroups, [
      { name: "harbour", paths: ["props/**", "textures/sky.png"] },
      { name: "crypt", paths: ["props/door.png"] },
    ]);
  });
});

describe("the core's Rust stage: a game's [assets] budgets", { skip: SKIP_ON_WINDOWS }, () => {
  it("hands the lane the budgets and the phone texture cap a game names in [assets] (C-17)", async () => {
    const payload = rustPayloadDir(await shippedResources());
    const dir = await templateGame();
    await writeFile(
      path.join(dir, "genex.toml"),
      `${await readFile(path.join(dir, "genex.toml"), "utf8")}\n[assets]\nphone_max_texture_px = 1024\n\n[assets.ios]\nbudget_mb = 150\n`,
    );
    const into = path.join(await realpath(await tmpDir("core-rust-lane-stage-")), "game.stage");
    const staged = await shippedRustStage(payload)(
      { project: "ferris", dir },
      into,
      BuildTarget.Ios,
      RustFlavour.Export,
    );
    assert.ok(staged.ok, JSON.stringify(staged));
    assert.deepEqual(staged.assets, { budgetMb: null, phoneMaxTexturePx: 1024, destinations: { ios: 150 } });
  });
});

describe("the core's Rust lane: a web export (stub cargo)", { skip: SKIP_ON_WINDOWS }, () => {
  // Pass-1 gate (owner decision 2026-10-11): an export's module is built for size, and its budget
  // is the game's own: past it the export warns, only past the 32 MB ceiling is it refused.
  it("builds with the size profile and packages against the game's own [web] budget; Live keeps the dev profile", async () => {
    const { store, lock } = await fixtureStore();
    const resources = await shippedResources();
    const dir = await templateGame();
    await writeFile(
      path.join(dir, "genex.toml"),
      `${await readFile(path.join(dir, "genex.toml"), "utf8")}\n[web]\nwasm_budget_mb = 12\n`,
    );
    const sizeConfig = RUST_WEB_EXPORT_PROFILE_SETTINGS.map(
      (setting) => `${shellQuote("--config")} ${shellQuote(setting)}`,
    );
    for (const purpose of [CppBuildPurpose.Export, CppBuildPurpose.Live]) {
      const { sandbox, requests } = openSandbox();
      const lane = await coreLane(store, resources, sandbox, rustTargetBuilders());
      const outcome = await lane.ensure({ ...rustGame(dir), lock }, BuildTarget.Web, purpose);
      assert.equal(outcome.ok, true, JSON.stringify(outcome.problem));
      const build = requests.find((request) => request.label?.endsWith(`:${RustBuildStep.Build}`));
      assert.ok(build, "cargo built");
      const exported = purpose === CppBuildPurpose.Export;
      for (const setting of sizeConfig)
        assert.equal(build.command.includes(setting), exported, `${purpose}: ${setting}`);
      const web = outcome.rust?.receipt?.web;
      assert.equal(web?.gzipBudgetBytes, 12 * WEB_BUDGET_MB_BYTES, purpose);
      assert.equal(web?.warning, null, purpose);
    }
  });
});

/** The `--config profile.…` settings of a shell-quoted cargo command, in order. */
function profileSettings(command: string): string[] {
  return [...command.matchAll(/'--config' '(profile\.[^']*)'/g)].map((match) => match[1] ?? "");
}

describe("the core's Rust lane: Live builds run optimized (stub cargo)", { skip: SKIP_UNLESS_MAC }, () => {
  // OPT: the engine and every dependency at opt-level 3, the game crate at 1 (still incremental),
  // line tables kept; exactly the store prewarm's settings, so a first build clones every unit.
  it("passes the prewarm's profile to clippy and the build of every Live and judging build, Mac and web, and none to an export", async () => {
    const { store, lock } = await fixtureStore();
    const resources = await shippedResources();
    const dir = await templateGame();
    const liveProfile = [
      "profile.dev.opt-level=1",
      'profile.dev.package."*".opt-level=3',
      'profile.dev.debug="line-tables-only"',
    ];
    const purposes = [CppBuildPurpose.Live, CppBuildPurpose.Judging, CppBuildPurpose.Export];
    for (const target of [BuildTarget.Mac, BuildTarget.Web])
      for (const purpose of purposes) {
        const { sandbox, requests } = openSandbox();
        const lane = await coreLane(store, resources, sandbox, rustTargetBuilders());
        const outcome = await lane.ensure({ ...rustGame(dir), lock }, target, purpose);
        assert.equal(outcome.ok, true, `${target} ${purpose}: ${JSON.stringify(outcome.problem)}`);
        const cargo = requests.filter((request) =>
          [RustBuildStep.Clippy, RustBuildStep.Build].some((step) => request.label?.endsWith(`:${step}`)),
        );
        assert.equal(cargo.length, 2, `${target} ${purpose}: clippy and the build ran`);
        for (const request of cargo) {
          const settings = profileSettings(request.command);
          if (purpose === CppBuildPurpose.Export)
            assert.ok(!settings.some((setting) => setting.startsWith("profile.dev.")), `${target}: ${settings}`);
          else assert.deepEqual(settings, liveProfile, `${target} ${purpose} ${request.label}`);
        }
      }
  });
});

describe("the core's Rust lane builds over the store and the payload (stub cargo)", { skip: SKIP_UNLESS_MAC }, () => {
  it("a forced error is the first problem; clippy read the payload's gate and every tool came from the store", async () => {
    const { store, lock } = await fixtureStore();
    const resources = await shippedResources();
    const dir = await templateGame();
    const main = path.join(dir, "src", "main.rs");
    await writeFile(main, `${await readFile(main, "utf8")}\nconst _FORCED: i32 = ${FIXTURE_RUST_FORCE_ERROR};\n`);
    const { sandbox, requests } = openSandbox();
    const lane = await coreLane(store, resources, sandbox);
    const outcome = await lane.ensure({ ...rustGame(dir), lock }, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.problem?.reason, BuildProblemCode.CommandFailed);
    assert.equal(outcome.rust?.refusal, null, JSON.stringify(outcome.rust));
    assert.equal(outcome.rust?.diagnostics[0]?.code, FIXTURE_RUST_FORCED_ERROR.code);
    const clippy = requests.find((request) => request.label?.endsWith(`:${RustBuildStep.Clippy}`));
    assert.ok(clippy?.command.includes(`CLIPPY_CONF_DIR=${rustPayloadDir(resources)}`), clippy?.command);
    const sysroot = rustSysroot(store, lock);
    for (const request of requests) assert.ok(request.command.includes(sysroot), request.command);
  });

  it("refuses the stage, running no cargo, when the payload has no lock line", async () => {
    const { store, lock } = await fixtureStore();
    const resources = await shippedResources();
    await rm(path.join(rustPayloadDir(resources), RUST_LOCK_LINE_FILE));
    const { sandbox, requests } = openSandbox();
    const lane = await coreLane(store, resources, sandbox);
    const outcome = await lane.ensure(
      { ...rustGame(await templateGame()), lock },
      BuildTarget.Mac,
      CppBuildPurpose.Live,
    );
    assert.equal(outcome.rust?.refusal, RustBuildRefusal.StageRefused);
    assert.match(outcome.problem?.lines[0] ?? "", /^lock-unreadable: /);
    assert.deepEqual(requests, [], "no command ran");
  });
});
