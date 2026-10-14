/**
 * The crate request flow with the real pinned toolchain under the real Seatbelt sandbox (Apple
 * silicon), checked by the shipped policy (`crate-policy.json`, person-decides) with the store's
 * real cargo-deny over the pinned RustSec snapshot: the person approves `tidy` from the fixture
 * registry, the checker passes it with its notice (no trusted source's list is installed), the vendor job
 * adds it to the profile's overlay, and the Rust template naming it at its exact version builds
 * offline from the merged directory source; the admitted lock holds it and its licence entry reads
 * from the overlay for the export notices. The toolchain and vendored set are
 * `rust-lane-real.test.ts`'s, the checker's downloads `crate-check-real.test.ts`'s; without them
 * the row skips, and `GENEX_REQUIRE_TOOLCHAINS=1` turns the skip into a failure.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { rustPayloadDir, shippedRustStage } from "../../src/main/core/rust-lane.ts";
import { shippedCrateChecker } from "../../src/main/crate-checker.ts";
import { createCrateRequests, shippedLockedCrates } from "../../src/main/crate-requests.ts";
import { RustBuilds, rustBinaryDir, rustBuildSandboxes } from "../../src/main/rust-build.ts";
import { CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { CrateCheckEngine, CrateDecision, CrateNotice, CrateRequestState } from "../../src/shared/crate-requests.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { BuildTarget, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { type ToolchainLock, toolchainHostOf } from "../../src/shared/toolchain.ts";
import { parseLockClosure, readVendoredLicences } from "../../src/substrate/rust-notices.ts";
import { crateOverlayLayout } from "../../src/substrate/toolchain-store/crate-overlay.ts";
import { crateCheckSandboxes } from "../../src/substrate/toolchain-store/crate-check.ts";
import { locateCrateCheckTools } from "../../src/substrate/toolchain-store/crate-check-store.ts";
import { CRATE_POLICY_FILE } from "../../src/substrate/toolchain-store/crate-policy.ts";
import { directoryCrateDownload, directoryCrateIndex } from "../../src/substrate/toolchain-store/crate-vendor-job.ts";
import { writeFixtureRegistry } from "../fixtures/crate-registry/registry.ts";
import { installRealCrateCheck, realCrateCheckAbsent } from "../helpers/crate-check-store.ts";
import { tmpDir } from "../helpers/tmp.ts";
const LOCK: ToolchainLock = {
  version: 1,
  entries: { rust: { version: "1.99.0", sha12: "0123456789ab" } },
  digest: "0123456789abcdef".repeat(4),
};

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const TOOLCHAIN_DIR = process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev", "spike-toolchain");
const VENDOR_DIR = process.env.GENEX_RUST_VENDOR_DIR ?? path.join(REPO, ".studio-dev", "rust-release", "e2e", "vendor");
const WORKSPACE = path.join(REPO, "native", "genex-rust");
const TEMPLATE = path.join(REPO, "src", "game-template-rust");
/** A cold build compiles the facade's whole dependency graph twice (clippy, then the build). */
const COLD_BUILD_MS = 60 * MINUTE_MS;

/** Why the real row cannot run here, or null (the toolchain and vendored set `rust-lane-real.test.ts` names). */
function realAbsent(): string | null {
  if (process.platform !== "darwin" || process.arch !== "arm64") return "an Apple silicon Mac";
  if (!existsSync(path.join(TOOLCHAIN_DIR, "sysroot", "bin", "cargo"))) return `the Rust toolchain (${TOOLCHAIN_DIR})`;
  if (!existsSync(path.join(VENDOR_DIR, "genex-0.1.0"))) return `the release's vendored crates (${VENDOR_DIR})`;
  return realCrateCheckAbsent();
}

function needsToolchain(): { skip?: string } {
  const missing = realAbsent();
  if (!missing) return {};
  if (process.env.GENEX_REQUIRE_TOOLCHAINS === "1") throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return { skip: `not run: ${missing} absent` };
}

describe("an approved crate builds offline with the real toolchain (macOS)", () => {
  it("vendors tidy, builds the template naming it under the real sandbox, and lists it in the notices", {
    ...needsToolchain(),
    timeout: COLD_BUILD_MS,
  }, async () => {
    const home = await realpath(await tmpDir("crate-overlay-real-"));
    await writeFixtureRegistry(path.join(home, "registry"));
    const payload = rustPayloadDir(path.join(home, "resources"));
    await mkdir(payload, { recursive: true });
    for (const file of ["Cargo.lock", "clippy.toml", CRATE_POLICY_FILE])
      await writeFile(path.join(payload, file), await readFile(path.join(WORKSPACE, file)));
    const dir = path.join(home, "games", "pond");
    await cp(TEMPLATE, dir, { recursive: true });
    for (const file of [path.join(dir, "genex.toml"), path.join(dir, "src", "main.rs")])
      await writeFile(file, (await readFile(file, "utf8")).replaceAll("__GAME_TITLE__", "Pond"));
    await writeFile(
      path.join(dir, "genex.toml"),
      `${await readFile(path.join(dir, "genex.toml"), "utf8")}\n[crates]\ntidy = "=1.0.0"\n`,
    );
    const gameRs = path.join(dir, "src", "game.rs");
    const tidyUse =
      "\n/// The approved crate, linked.\n#[allow(dead_code)]\npub fn tidy_value() -> u32 {\n    tidy::value()\n}\n";
    await writeFile(gameRs, `${await readFile(gameRs, "utf8")}${tidyUse}`);

    const store = path.join(home, "app-data", "toolchains");
    // The store installs the checker as the app does on a first approval, from the pinned downloads.
    await installRealCrateCheck(store, path.join(home, "install-scratch"));
    const host = toolchainHostOf(process.platform, process.arch);
    assert.ok(host);
    const service = createCrateRequests({
      store,
      downloadCache: path.join(home, "download-cache"),
      index: directoryCrateIndex(path.join(home, "registry")),
      download: directoryCrateDownload(path.join(home, "registry")),
      checker: () =>
        shippedCrateChecker({
          payload,
          tools: (policy) => locateCrateCheckTools(store, host, policy),
          sandbox: crateCheckSandboxes({ secretPaths: [], denyRead: [os.homedir(), home], enabled: true }),
          auditList: async () => null,
        }),
      locked: () => shippedLockedCrates(payload),
      rustGame: async (project) => (project === "pond" ? { dir } : null),
      rustGames: async () => ["pond"],
      record: async () => {},
    });
    const asked = await service.request({ project: "pond", name: "tidy", version: "1.0.0" });
    const view = await service.decide({ requestId: asked.requestId, decision: CrateDecision.Approve });
    assert.equal(view.state, CrateRequestState.Vendored, JSON.stringify(view));
    assert.equal(view.check?.engine, CrateCheckEngine.CargoDeny, "the real cargo-deny passed it");
    // Flipped: this was `crate-unaudited`; with no audit list installed no source was asked.
    assert.equal(view.check?.notice, CrateNotice.NoAuditLists, "added on the approval; no audit list to ask");

    const toolchainDir = await realpath(TOOLCHAIN_DIR);
    const vendor = await realpath(VENDOR_DIR);
    const builds = new RustBuilds({
      root: path.join(home, "app-data", "rust-builds"),
      sandbox: rustBuildSandboxes({ secretPaths: [], enabled: true, denyRead: [os.homedir(), home] }),
      locate: async () => ({
        ok: true,
        toolchain: {
          bin: path.join(toolchainDir, "sysroot", "bin"),
          vendor,
          clippyConf: payload,
          reads: [toolchainDir, vendor, payload],
        },
      }),
      currentLock: async () => LOCK,
      stage: shippedRustStage(payload),
      emit: () => {},
      platform: process.platform,
      cores: 8,
      denyWrite: [],
      writeLock: async () => {},
      crateGrant: (project) => service.grantFor(project),
    });
    const game = {
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
      destinations: { stack: GameStack.RustWgpu, targets: [BuildTarget.Mac] },
    };
    const built = await builds.ensure(game, BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(built.ok, true, JSON.stringify(built.problem));
    console.log(`build steps with the approved crate: ${JSON.stringify(built.rust?.receipt?.steps)}`);

    const stageLock = await readFile(
      `${rustBinaryDir(path.join(home, "app-data", "rust-builds"), "pond", await realpath(dir), BuildTarget.Mac, LOCK)}.stage/Cargo.lock`,
      "utf8",
    );
    assert.match(stageLock, /name = "tidy"\nversion = "1\.0\.0"/);
    const closure = parseLockClosure(stageLock);
    assert.ok(closure.ok);
    const layout = crateOverlayLayout(store);
    const licences = await readVendoredLicences([vendor, layout.vendor], closure.crates);
    assert.equal(licences.get("tidy@1.0.0")?.license, "MIT");
  });
});
