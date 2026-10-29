/**
 * The Rust lane builds the template for all six destinations on a Mac, for real: the core's lane
 * (`createCoreRustBuilds`, `rustTargetBuilders`, `rustTargetSettings`, `storeRustAdmit`) over the
 * developer's Rust dev store and this worktree's Rust lock (`dev-store.ts --stack rust-wgpu`),
 * under the real build sandbox, each destination from a cold build folder. Browser and Mac build
 * from the store's prewarm; Windows, Linux, iPhone and Android from a cold target folder, through
 * the store's llvm-mingw, zig with cargo-zigbuild and the Linux headers, Xcode's iOS SDK and the
 * pinned NDK in the person's own Android SDK. Each destination's typed outcome is printed; nothing
 * is run, on this Mac or a device: the Windows and Linux programs are admitted only, and the phone
 * builds are never launched (containment stage 1).
 *
 * Six cold builds take a long while, so the row runs only when asked: `GENEX_RUST_LANE_ALL=1`
 * (`GENEX_RUST_LANE_TARGETS=ios,android` narrows it), with
 * `GENEX_DEV_TOOLCHAINS` naming the toolchains folder whose `dev-store` holds the lock. Without the
 * store, the lock or Xcode and the NDK it skips; `GENEX_REQUIRE_TOOLCHAINS=1` turns a skip into a failure.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { rustTargetBuilders } from "../../src/main/core/internals.ts";
import { hostAndroidSdk } from "../../src/main/core/mobile-export-deps.ts";
import { rustTargetSettings } from "../../src/main/core/rust-cross-lane.ts";
import { createCoreRustBuilds, rustPayloadDir, storeRustAdmit } from "../../src/main/core/rust-lane.ts";
import type { GameBuildGame } from "../../src/main/game-build.ts";
import { rustBuildSandboxes } from "../../src/main/rust-build.ts";
import { mobileTargetSettings } from "../../src/main/rust-build-mobile.ts";
import { CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { HOUR_MS } from "../../src/shared/duration.ts";
import { ALL_BUILD_TARGETS, BuildTarget, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { isToolchainLock } from "../../src/substrate/toolchain-store/lock.ts";
import { execXcode } from "../../src/substrate/toolchain-store/locate.ts";
import { devStoreRustLockFile } from "../helpers/dev-toolchains.ts";
import { removeTree, tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TEMPLATE = path.join(REPO, "src", "game-template-rust");
const WORKSPACE = path.join(REPO, "native", "genex-rust");
const TOOLCHAINS = process.env.GENEX_DEV_TOOLCHAINS ?? path.join(REPO, ".studio-dev", "toolchains");
const STORE = path.join(TOOLCHAINS, "dev-store");
const ASKED = process.env.GENEX_RUST_LANE_ALL === "1";
const REQUIRED = process.env.GENEX_REQUIRE_TOOLCHAINS === "1";
/** Six cold builds of the facade's dependency graph, one after another. */
const ALL_BUILDS_MS = 4 * HOUR_MS;
const PROBLEM_LINES = 8;
/** The destinations to build: all six, or those `GENEX_RUST_LANE_TARGETS` names (`ios,android`). */
const TARGETS: readonly BuildTarget[] = ALL_BUILD_TARGETS.filter((target) => {
  const named = process.env.GENEX_RUST_LANE_TARGETS;
  return named === undefined || named.split(",").includes(target);
});

/** Why the row cannot run here, or null. */
function absent(): string | null {
  if (!ASKED) return "GENEX_RUST_LANE_ALL=1 (six cold builds)";
  if (process.platform !== "darwin" || process.arch !== "arm64") return "an Apple silicon Mac";
  if (!existsSync(STORE)) return `the Rust dev store (${STORE})`;
  if (!existsSync(devStoreRustLockFile())) return `this worktree's Rust lock (${devStoreRustLockFile()})`;
  return null;
}

function options(): { skip?: string } {
  const missing = absent();
  if (!missing) return {};
  if (REQUIRED && ASKED) throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return { skip: `not run: ${missing}` };
}

/** The app's resources as the core reads them: the Rust payload and the template's web shell. */
async function resourcesIn(folder: string): Promise<string> {
  const payload = rustPayloadDir(folder);
  await mkdir(payload, { recursive: true });
  for (const file of ["Cargo.lock", "clippy.toml"])
    await writeFile(path.join(payload, file), await readFile(path.join(WORKSPACE, file)));
  const shell = path.join(folder, "game-template-rust", "web");
  await mkdir(shell, { recursive: true });
  await writeFile(path.join(shell, "shell.html"), await readFile(path.join(TEMPLATE, "web", "shell.html")));
  return folder;
}

/** The template as a created game naming every destination. */
async function templateGame(parent: string): Promise<GameBuildGame> {
  const dir = path.join(parent, "pond");
  await cp(TEMPLATE, dir, { recursive: true });
  for (const file of [path.join(dir, "genex.toml"), path.join(dir, "src", "main.rs")])
    await writeFile(file, (await readFile(file, "utf8")).replaceAll("__GAME_TITLE__", "Pond"));
  const lock: unknown = JSON.parse(await readFile(devStoreRustLockFile(), "utf8"));
  assert.ok(isToolchainLock(lock), "the worktree's Rust lock is well formed");
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
    destinations: { stack: GameStack.RustWgpu, targets: [...ALL_BUILD_TARGETS] },
    lock,
    recordLock: false,
  };
}

describe("the Rust lane builds the template for all six destinations on a Mac (real toolchain)", () => {
  it("each destination builds and is admitted, with its typed outcome", {
    ...options(),
    timeout: ALL_BUILDS_MS,
  }, async () => {
    const home = await realpath(await tmpDir("rust-lane-six-"));
    const store = await realpath(STORE);
    const game = await templateGame(path.join(home, "games"));
    const resources = await resourcesIn(path.join(home, "resources"));
    const sdk = hostAndroidSdk({
      platform: process.platform,
      home: os.homedir(),
      env: process.env,
      protectedPaths: [],
    });
    /** A lane of the core's shape whose build folders are `root`'s. */
    const laneAt = (root: string) =>
      createCoreRustBuilds({
        root,
        store,
        resources,
        sandbox: rustBuildSandboxes({ secretPaths: [], enabled: true, denyRead: [os.homedir(), home] }),
        emit: () => {},
        platform: process.platform,
        cores: os.availableParallelism(),
        denyWrite: [store],
        writeLock: async () => {},
        builders: rustTargetBuilders(),
        targetSettings: rustTargetSettings({
          store,
          mobile: mobileTargetSettings(process.platform, execXcode, {
            ndk: async () => (await sdk())?.ndk?.dir ?? null,
          }),
        }),
        admit: storeRustAdmit(store),
      });
    const outcomes: Record<string, { ok: boolean }> = {};
    for (const target of TARGETS) {
      // Each destination's build folders are removed once its outcome is read: one cold target folder on disk at a time.
      const root = path.join(home, `rust-builds-${target}`);
      const started = performance.now();
      const outcome = await laneAt(root).ensure(game, target, CppBuildPurpose.Live);
      const { problem, rust } = outcome;
      const row = {
        ok: outcome.ok,
        ms: Math.round(performance.now() - started),
        problem: problem && { reason: problem.reason, lines: problem.lines.slice(0, PROBLEM_LINES) },
        refusal: rust?.refusal ?? null,
        triple: rust?.receipt?.triple ?? null,
        source: rust?.receipt?.cache ?? null,
        outputs: rust?.receipt?.outputs.map((file) => `${file.path} ${file.bytes} ${file.sha256.slice(0, 12)}`),
      };
      outcomes[target] = row;
      console.log(`${target}: ${JSON.stringify(row)}`);
      await removeTree(root);
    }
    for (const target of TARGETS) assert.equal(outcomes[target]?.ok, true, target);
  });
});
