/**
 * The Rust lane (`RustBuilds`) with the real pinned toolchain under the real Seatbelt sandbox:
 * the Rust template builds for the Mac offline from a cold build folder, then again after a
 * change; cargo reads no `.cargo/config.toml` planted in the game, the folder above it or a folder
 * above the build root (as the person's home is above the app's data); the clippy gate refuses a
 * platform `sin` with the store's `clippy.toml` and an `unsafe` block under `-F unsafe_code`, each
 * reported as its first diagnostic with spans, rendered.
 *
 * The game is staged by the shipped stager (`shippedRustStage`: `rust-stage.ts`'s link-free copy
 * and source scan, `rust-manifest.ts`'s host-written manifest at the payload's genex release),
 * and the build sandbox denies reading the person's home and the folder holding the game except
 * the build's own reads, as the core configures it. The compiler is the pinned sysroot of the
 * spike folder `.studio-dev/spike-toolchain/` (`GENEX_RUST_TOOLCHAIN_DIR` overrides it); the crates
 * are the genex release's vendored set cut by `scripts/toolchains/rust-release.ts`
 * (`GENEX_RUST_VENDOR_DIR` names one), the same pair `rust-end-to-end.test.ts`'s real row builds
 * with; the store's own install and prewarm of them are `rust-store.test.ts`'s real rows. Apple
 * silicon only; without them the rows skip, and `GENEX_REQUIRE_TOOLCHAINS=1` turns the skip into
 * a failure. A cold build compiles the facade's dependency graph (minutes).
 */
import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { GameBuildGame } from "../../src/main/game-build.ts";
import { rustPayloadDir, shippedRustStage } from "../../src/main/core/rust-lane.ts";
import { RustBuilds, type RustToolchain, rustBuildSandboxes } from "../../src/main/rust-build.ts";
import { RustDiagnosticTool } from "../../src/main/rust-build-diagnostics.ts";
import { BuildPhase, BuildProblemCode, CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { BuildTarget, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { excludedFromExport } from "../../src/substrate/game-export.ts";
import { lockOf } from "../../src/substrate/toolchain-store/lock.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TOOLCHAIN_DIR = process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev", "spike-toolchain");
const VENDOR_DIR = process.env.GENEX_RUST_VENDOR_DIR ?? path.join(REPO, ".studio-dev", "rust-release", "e2e", "vendor");
const WORKSPACE = path.join(REPO, "native", "genex-rust");
const TEMPLATE = path.join(REPO, "src", "game-template-rust");
const REQUIRED = process.env.GENEX_REQUIRE_TOOLCHAINS === "1";
/** A cold build compiles the facade's whole dependency graph twice (clippy, then the build). */
const COLD_BUILD_MS = 30 * MINUTE_MS;
/** The first bytes of a thin 64-bit Mach-O and the arm64 CPU type, little-endian. */
const MACHO_64 = 0xfeedfacf;
const CPU_ARM64 = 0x0100000c;
const LOCK = lockOf({ rust: { version: "1.99.0", sha12: "000000000000" } });

/** Why the rows cannot run here, or null. */
function absent(): string | null {
  if (process.platform !== "darwin" || process.arch !== "arm64") return "an Apple silicon Mac";
  for (const need of ["sysroot/bin/cargo", "sysroot/bin/cargo-clippy"])
    if (!existsSync(path.join(TOOLCHAIN_DIR, need))) return `the Rust toolchain (${path.join(TOOLCHAIN_DIR, need)})`;
  if (!existsSync(path.join(VENDOR_DIR, "genex-0.1.0")))
    return `the release's vendored crates (${VENDOR_DIR}; rust-release.ts tree --out .studio-dev/rust-release/e2e)`;
  return null;
}

/** `node:test` options: skip without the toolchain, unless required. */
function needsToolchain(): { skip?: string } {
  const missing = absent();
  if (!missing) return {};
  if (REQUIRED) throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return { skip: `not run: ${missing} absent` };
}

/** The app's Rust payload as the core ships it: the workspace's lock line and the store's clippy.toml. */
async function payloadIn(resources: string): Promise<string> {
  const payload = rustPayloadDir(resources);
  await mkdir(payload, { recursive: true });
  for (const file of ["Cargo.lock", "clippy.toml"])
    await writeFile(path.join(payload, file), await readFile(path.join(WORKSPACE, file)));
  return payload;
}

/** The template as a created game: its title filled in. */
async function templateGame(parent: string): Promise<string> {
  const dir = path.join(parent, "pond");
  await cp(TEMPLATE, dir, { recursive: true });
  for (const file of [path.join(dir, "genex.toml"), path.join(dir, "src", "main.rs")])
    await writeFile(file, (await readFile(file, "utf8")).replaceAll("__GAME_TITLE__", "Pond"));
  return dir;
}

function gameOf(dir: string): GameBuildGame {
  return {
    project: "pond",
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
    destinations: { stack: GameStack.RustWgpu, targets: [BuildTarget.Web, BuildTarget.Mac] },
  };
}

/** Whether `file` is a thin arm64 Mach-O. */
async function isArm64MachO(file: string): Promise<boolean> {
  const bytes = await readFile(file);
  return bytes.readUInt32LE(0) === MACHO_64 && bytes.readUInt32LE(4) === CPU_ARM64;
}

describe("the Rust lane builds the template with the real toolchain (macOS)", () => {
  const options = needsToolchain();

  it("builds offline from a cold folder, again after a change, and planted configs change nothing", {
    ...options,
    timeout: 2 * COLD_BUILD_MS,
  }, async () => {
    const toolchainDir = realpathSync(TOOLCHAIN_DIR);
    // The build root sits under a folder holding a planted config, as the app's data sits under the person's home.
    const home = await realpath(await tmpDir("rust-lane-real-"));
    const planted = '[build]\nrustc = "/usr/bin/false"\nrustflags = ["--cfg", "planted"]\n';
    const games = path.join(home, "games");
    await mkdir(games, { recursive: true });
    const dir = await templateGame(games);
    // The stage leaves out what an export leaves out (notes such as the assets README).
    const assets = (await readdir(path.join(dir, "assets"))).filter((name) => !excludedFromExport(name));
    for (const where of [home, games, dir]) {
      await mkdir(path.join(where, ".cargo"), { recursive: true });
      await writeFile(path.join(where, ".cargo", "config.toml"), planted);
    }
    const vendor = await realpath(VENDOR_DIR);
    const payload = await payloadIn(path.join(home, "resources"));
    const toolchain: RustToolchain = {
      bin: path.join(toolchainDir, "sysroot", "bin"),
      vendor,
      clippyConf: payload,
      reads: [toolchainDir, vendor, payload],
    };
    const progress: string[] = [];
    const builds = new RustBuilds({
      root: path.join(home, "app-data", "rust-builds"),
      // As the core: nothing of the person's home (here both the real one and the planted one) but the build's reads.
      sandbox: rustBuildSandboxes({ secretPaths: [], enabled: true, denyRead: [os.homedir(), home] }),
      locate: async () => ({ ok: true, toolchain }),
      currentLock: async () => LOCK,
      stage: shippedRustStage(payload),
      emit: (event) => progress.push(event.phase),
      platform: process.platform,
      cores: 8,
      denyWrite: [],
      writeLock: async () => {},
    });

    const cold = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(cold.ok, true, JSON.stringify(cold.problem));
    const out = cold.output ?? "";
    assert.ok(await isArm64MachO(path.join(out, "game")));
    assert.ok(await isArm64MachO(path.join(out, "game-headless")));
    assert.deepEqual(await readdir(path.join(out, "assets")), assets);
    const receipt = cold.rust?.receipt;
    assert.equal(receipt?.compiler.release, "1.99.0");
    assert.equal(receipt?.compiler.host, "aarch64-apple-darwin");
    console.log(`cold build steps: ${JSON.stringify(receipt?.steps)}`);

    const game = path.join(dir, "src", "game.rs");
    const source = await readFile(game, "utf8");
    await writeFile(game, source.replace("SPIN_PER_SECOND: f32 = 0.8", "SPIN_PER_SECOND: f32 = 0.9"));
    const warm = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(warm.ok, true, JSON.stringify(warm.problem));
    assert.notEqual(
      warm.rust?.receipt?.outputs.find((file) => file.path === "game")?.sha256,
      receipt?.outputs.find((file) => file.path === "game")?.sha256,
      "the change was built",
    );
    console.log(`warm build steps: ${JSON.stringify(warm.rust?.receipt?.steps)}`);

    // The clippy gate: a platform `sin` against the store's clippy.toml.
    await writeFile(
      game,
      `${source}\n/// Not deterministic across targets.\n#[allow(dead_code)]\npub fn wobble(x: f32) -> f32 {\n    x.sin()\n}\n`,
    );
    const linted = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(linted.ok, false);
    assert.equal(linted.problem?.reason, BuildProblemCode.CommandFailed);
    const [lint] = linted.rust?.diagnostics ?? [];
    assert.equal(lint?.tool, RustDiagnosticTool.Clippy, JSON.stringify(linted.rust?.diagnostics));
    assert.equal(lint?.code, "clippy::disallowed_methods");
    assert.equal(lint?.file, "src/game.rs");
    assert.ok(linted.problem?.lines[0]?.startsWith("error"), JSON.stringify(linted.problem?.lines));
    assert.equal(linted.lastGood, warm.output, "the stage keeps the last admitted build");

    // -F unsafe_code: an unsafe block in game code is an error, with its span.
    await writeFile(
      game,
      `${source}\n/// Unsafe in game code.\n#[allow(dead_code)]\npub fn peek(p: *const u8) -> u8 {\n    unsafe { *p }\n}\n`,
    );
    const unsafeBuild = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(unsafeBuild.ok, false);
    const [unsafeError] = unsafeBuild.rust?.diagnostics ?? [];
    assert.equal(unsafeError?.code, "unsafe_code");
    assert.equal(unsafeError?.file, "src/game.rs");
    assert.ok((unsafeError?.line ?? 0) > 0);
    assert.ok(progress.includes(BuildPhase.Done) && progress.includes(BuildPhase.Failed));
  });
});
