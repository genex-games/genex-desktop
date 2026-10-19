/**
 * Eject (extension ladder level 5, M7.1): the person copies the genex crates of a Rust game's lock
 * line into its `engine/` as a game-owned fork (`src/main/rust-eject.ts`), the build links the fork
 * (`rust-stage.ts`, `rust-manifest.ts`), and Live, capture and export of an ejected game need a
 * green conformance run on the current build digest (`core/game-conformance-gate.ts`).
 *
 * The fast rows eject a copy of `tests/fixtures/rust-ejected-game` from a small vendored set
 * written here with cargo's own digest manifests: the copy is byte for byte with a digest manifest,
 * every hostile `engine/`, tampered source and swept lock line is refused with nothing written, a
 * lock bump stages the fork at its own release with host-written crate manifests, the gate opens
 * only on a green run of the same build, and un-eject snapshots first. The real row (Apple silicon,
 * the release's vendored crates and the pinned toolchain; `GENEX_REQUIRE_TOOLCHAINS=1` turns a skip
 * into a failure) ejects from the real set, builds the fork offline through the real lane and runs
 * the conformance suite on that build.
 *
 * A second fixture, `tests/fixtures/rust-render-game` ("Every Light"), reaches every renderer
 * feature through the facade (presets, the sky, sun and spot shadows, bloom, AO, fog, TAA, binned
 * lights, emissive surfaces, meshlets with Hi-Z occlusion, a v2 material, a v2 post pass and a v2
 * `after-prepass` pass). Its fast rows parse its `genex.toml` and eject a renderer crate with nested
 * shaders and its README byte for byte; its real row (renderer follow-up RX.2) ejects it from the
 * release's vendored crates, checks the fork holds every module and shader of the workspace's
 * `genex-render` and its README, builds the fork through the real lane, passes every conformance
 * check (`render-presets` included) and draws every renderer feature with its extensions admitted.
 * Point `GENEX_RUST_VENDOR_DIR` at a tree of the current workspace
 * (`node scripts/toolchains/rust-release.ts tree --out <dir>`): an older tree is missing modules.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  conformanceGate,
  checkConformanceGate,
  storeConformanceRuns,
} from "../../src/main/core/game-conformance-gate.ts";
import { type ConformanceLaunch, runGameConformance, stopGameChild } from "../../src/main/core/game-conformance.ts";
import { rustPayloadDir, shippedRustStage } from "../../src/main/core/rust-lane.ts";
import type { GameBuildGame } from "../../src/main/game-build.ts";
import { RustBuilds, type RustToolchain, rustBuildSandboxes } from "../../src/main/rust-build.ts";
import {
  createEngineEject,
  createEngineEjections,
  ENGINE_EJECTS_FILE,
  ENGINE_MANIFEST_FILE,
  type EngineEjectDeps,
  type EngineEjections,
  judgesOnThisHost,
  type EngineLockLine,
  type EngineManifest,
  EngineUpdates,
} from "../../src/main/rust-eject.ts";
import { gameCargoLock, RUST_ENGINE_CRATES } from "../../src/main/rust-manifest.ts";
import { RustStageCode, stageRustGame } from "../../src/main/rust-stage.ts";
import {
  allowedFile as reviewAllowedFile,
  type ReviewSpec as OwnershipSpec,
} from "../../src/harness-seed/loop/review.ts";
import { HostMethod as SeedHostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import { BuildProblemCode, CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { type EventData, EventKind } from "../../src/shared/event-log.ts";
import {
  CONFORMANCE_CHECKS,
  ConformanceCheck,
  ConformanceOutcome,
  ConformanceProblem,
  type ConformanceRunPayload,
  type EngineEjectedPayload,
  ExtensionRefusal,
  type GameConformanceReport,
} from "../../src/shared/game-conformance.ts";
import { BuildTarget, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { CustomPassStage, NativeOp, NativeRunMode, type NativeTimers } from "../../src/shared/native-contract.ts";
import {
  DegradeReason,
  DeviceClass,
  ExposureMode,
  FormFactor,
  QualityPreset,
  RenderFeature,
  Tonemapper,
} from "../../src/shared/render-quality.ts";
import { parseGenexToml, readGenexToml, WgslKind } from "../../src/substrate/genex-toml.ts";
import { NativeGamePort } from "../../src/substrate/native-game-port.ts";
import { allowedFile as hookAllowedFile } from "../../src/substrate/ownership.ts";
import type { GameChild, GameExit } from "../../src/substrate/spawn.ts";
import { lockOf } from "../../src/substrate/toolchain-store/lock.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = path.join(REPO, "tests", "fixtures", "rust-ejected-game");
/** The game that reaches every renderer feature, and the project it is ejected as. */
const RENDER_FIXTURE = path.join(REPO, "tests", "fixtures", "rust-render-game");
const RENDER_PROJECT = "every-light";
const DOUBLE = path.join(REPO, "tests", "fixtures", "rust-nonconforming", "game.mjs");
const RELEASE = "0.1.0";
const LOCK_DIGEST = "1".repeat(64);
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const SKIP_ON_WINDOWS = process.platform === "win32" ? "links, process groups and fd 3 are POSIX" : false;

/** The game-systems crates EP-0b adds to the fork, in the order an eject patches them. */
const GAME_SYSTEMS_CRATES = ["genex-anim", "genex-nav", "genex-stream"] as const;

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** One crate of the small vendored set: its files, written with cargo's `.cargo-checksum.json`. */
async function vendoredCrate(vendor: string, name: string, version: string, files: Record<string, string>) {
  const folder = path.join(vendor, `${name}-${version}`);
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(folder, rel)), { recursive: true });
    await writeFile(path.join(folder, rel), text);
  }
  const listed = Object.fromEntries(Object.entries(files).map(([rel, text]) => [rel, sha256(text)]));
  await writeFile(path.join(folder, ".cargo-checksum.json"), JSON.stringify({ files: listed, package: sha256(name) }));
  return folder;
}

const crateToml = (name: string, version: string, deps: readonly string[] = []) =>
  `[package]\nname = "${name}"\nversion = "${version}"\nedition = "2024"\n\n[dependencies]\n${deps
    .map((dep) => `${dep} = "${version}"`)
    .join("\n")}\n`;

/** A vendored set holding two forked crates at `version`, a kept one (genex-studio) and a third-party crate. */
async function smallVendor(version = RELEASE): Promise<string> {
  const vendor = path.join(await realpath(await tmpDir("rust-eject-vendor-")), "vendor");
  await vendoredCrate(vendor, "genex", version, {
    "Cargo.toml": crateToml("genex", version, ["genex-core"]),
    "src/lib.rs":
      '//! the facade\npub use genex_core::*;\npub const NAME: Option<&str> = option_env!("GENEX_GAME_NAME");\n',
  });
  await vendoredCrate(vendor, "genex-core", version, {
    "Cargo.toml": crateToml("genex-core", version),
    "src/lib.rs": "//! the core\npub fn tick() -> u32 { 1 }\n",
    "shaders/common.wgsl": "// shared\n",
  });
  await vendoredCrate(vendor, "genex-studio", version, {
    "Cargo.toml": crateToml("genex-studio", version),
    "src/lib.rs": "//! the transport (kept in the store)\n",
  });
  await vendoredCrate(vendor, "serde", "1.0.0", { "Cargo.toml": crateToml("serde", "1.0.0"), "src/lib.rs": "\n" });
  return vendor;
}

/** A fresh copy of a fixture game (the pond by default), by its real path, in a folder named `project`. */
async function gameCopy(fixture = FIXTURE, project = "forked-pond"): Promise<string> {
  const dir = path.join(await realpath(await tmpDir("rust-eject-game-")), project);
  await cp(fixture, dir, { recursive: true });
  return dir;
}

/** Everything under `dir`: each path with its kind and its bytes' digest (a link's target): "nothing written" compares two. */
async function listing(dir: string, rel = ""): Promise<string[]> {
  const rows: string[] = [];
  for (const name of (await readdir(path.join(dir, rel))).sort()) {
    const child = rel ? `${rel}/${name}` : name;
    const full = path.join(dir, child);
    const info = await lstat(full);
    if (info.isSymbolicLink()) rows.push(`${child} -> ${await readlink(full)}`);
    else if (info.isDirectory()) rows.push(`${child}/`, ...(await listing(dir, child)));
    else rows.push(`${child} ${sha256(await readFile(full))}`);
  }
  return rows;
}

/** The profile's eject records, in memory: what the build lane and the gate would read. */
function memoryEjections(): EngineEjections & { kept: Map<string, string> } {
  const kept = new Map<string, string>();
  return {
    kept,
    ejectedFrom: async (project) => kept.get(project) ?? null,
    set: async (project, _dir, ejectedFrom) => {
      if (ejectedFrom === null) kept.delete(project);
      else kept.set(project, ejectedFrom);
    },
  };
}

/** An eject over `game` and `line`, recording snapshots, events and the profile's eject records. */
function ejectFor(game: string, line: EngineLockLine | null, extra: Partial<EngineEjectDeps> = {}) {
  const records: EngineEjectedPayload[] = [];
  const snapshots: Array<{ project: string; engineThere: boolean; row: boolean }> = [];
  const ejections = memoryEjections();
  const scratch = path.join(path.dirname(game), "host-scratch");
  const service = createEngineEject({
    rustGame: async (project) => (project === path.basename(game) ? { dir: game } : null),
    judgeable: async () => true,
    ejections,
    scratch,
    lockLine: async () => line,
    snapshot: async (project) => {
      const engineThere = existsSync(path.join(game, "engine"));
      const row = (await readFile(path.join(game, "genex.toml"), "utf8")).includes("[engine]");
      snapshots.push({ project, engineThere, row });
      return "snap-1";
    },
    record: async (payload) => {
      records.push(payload);
    },
    ...extra,
  });
  return { service, records, snapshots, ejections, scratch };
}

const lineOf = (vendor: string, genexVersion = RELEASE): EngineLockLine => ({
  vendor,
  genexVersion,
  lock: LOCK_DIGEST,
});

describe("eject copies the lock line's engine into the game", { skip: SKIP_ON_WINDOWS }, () => {
  it("copies each forked crate byte for byte with a digest manifest, writes the [engine] row and records the event", async () => {
    const game = await gameCopy();
    const vendor = await smallVendor();
    const before = await readFile(path.join(game, "genex.toml"), "utf8");
    const { service, records, ejections, scratch } = ejectFor(game, lineOf(vendor));

    const answer = await service.eject("forked-pond");

    assert.deepEqual(answer, { project: "forked-pond", ok: true, refusal: null, ejectedFrom: RELEASE });
    for (const [crate, rel] of [
      ["genex", "src/lib.rs"],
      ["genex", "Cargo.toml"],
      ["genex-core", "shaders/common.wgsl"],
      ["genex-core", ".cargo-checksum.json"],
    ] as const) {
      const copied = await readFile(path.join(game, "engine", crate, rel));
      assert.deepEqual(copied, await readFile(path.join(vendor, `${crate}-${RELEASE}`, rel)), `${crate}/${rel}`);
    }
    assert.equal(existsSync(path.join(game, "engine", "genex-studio")), false, "the transport stays the store's");
    assert.equal(existsSync(path.join(game, "engine", "serde")), false, "third-party crates stay vendored");
    const manifest = JSON.parse(
      await readFile(path.join(game, "engine", ENGINE_MANIFEST_FILE), "utf8"),
    ) as EngineManifest;
    assert.equal(manifest.ejectedFrom, RELEASE);
    assert.equal(manifest.lock, LOCK_DIGEST);
    assert.equal(manifest.engineUpdates, EngineUpdates.Manual);
    assert.deepEqual(
      manifest.crates.map((crate) => crate.name),
      ["genex", "genex-core"],
    );
    for (const crate of manifest.crates)
      for (const [rel, digest] of Object.entries(crate.files))
        assert.equal(
          sha256(await readFile(path.join(game, "engine", crate.name, rel))),
          digest,
          `${crate.name}/${rel}`,
        );
    const toml = await readFile(path.join(game, "genex.toml"), "utf8");
    assert.ok(toml.startsWith(before), "every line the game wrote is kept");
    const parsed = parseGenexToml(toml);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.manifest.engine, { ejectedFrom: RELEASE });
    assert.deepEqual(records, [{ project: "forked-pond", ejected: true, ejectedFrom: RELEASE }]);
    assert.equal(await ejections.ejectedFrom("forked-pond"), RELEASE, "the person's eject is recorded in the profile");
    assert.deepEqual(
      (await readdir(game)).filter((name) => name.startsWith(".engine")),
      [],
      "no copy in progress is left behind",
    );
    assert.deepEqual(await readdir(scratch), [], "the copy was made in the host's scratch folder, and removed");
  });

  it("copies the game-systems crates (animation, navigation, streaming) beside the facade, each held to its digest manifest", async () => {
    const game = await gameCopy();
    const vendor = await smallVendor();
    for (const crate of GAME_SYSTEMS_CRATES)
      await vendoredCrate(vendor, crate, RELEASE, {
        "Cargo.toml": crateToml(crate, RELEASE, ["genex-core"]),
        "src/lib.rs": `//! ${crate}\npub fn stub() {}\n`,
      });
    const { service } = ejectFor(game, lineOf(vendor));

    const answer = await service.eject("forked-pond");

    assert.equal(answer.ok, true, JSON.stringify(answer));
    for (const crate of GAME_SYSTEMS_CRATES)
      for (const rel of ["Cargo.toml", "src/lib.rs", ".cargo-checksum.json"])
        assert.deepEqual(
          await readFile(path.join(game, "engine", crate, rel)),
          await readFile(path.join(vendor, `${crate}-${RELEASE}`, rel)),
          `${crate}/${rel}`,
        );
    const manifest = JSON.parse(
      await readFile(path.join(game, "engine", ENGINE_MANIFEST_FILE), "utf8"),
    ) as EngineManifest;
    assert.deepEqual(
      manifest.crates.map((crate) => crate.name),
      ["genex", "genex-anim", "genex-core", "genex-nav", "genex-stream"],
    );
  });

  it("is offered only where the suite can judge the fork: no Mac host or no macOS destination is eject-needs-mac, nothing written", async () => {
    const game = await gameCopy();
    const before = await listing(game);
    const { service, records, ejections } = ejectFor(game, lineOf(await smallVendor()), {
      judgeable: async () => false,
    });
    assert.deepEqual(await service.eject("forked-pond"), {
      project: "forked-pond",
      ok: false,
      refusal: ExtensionRefusal.EjectNeedsMac,
      ejectedFrom: null,
    });
    assert.deepEqual(await listing(game), before);
    assert.deepEqual(records, []);
    assert.equal(ejections.kept.size, 0);
    const iosWeb = { destinations: { targets: [BuildTarget.Ios, BuildTarget.Web] } } as never;
    const withMac = { destinations: { targets: [BuildTarget.Mac, BuildTarget.Web] } } as never;
    assert.equal(judgesOnThisHost("darwin", iosWeb), false, "a game made for iOS and the web");
    assert.equal(judgesOnThisHost("linux", withMac), false, "the Linux host, where Rust creation is open");
    assert.equal(judgesOnThisHost("win32", withMac), false);
    assert.equal(judgesOnThisHost("darwin", withMac), true);
  });

  it("refuses a hostile engine/, a tampered source and a swept lock line with nothing written", async () => {
    /** One row: how the game or the store is set up, the lock line handed over, and the refusal. */
    type Row = {
      why: string;
      refusal: ExtensionRefusal;
      setup: (game: string, vendor: string) => Promise<void>;
      line?: (vendor: string) => EngineLockLine | null;
    };
    const rows: Row[] = [
      {
        why: "engine/ is a link to a folder",
        refusal: ExtensionRefusal.EjectTargetExists,
        setup: async (game, vendor) => symlink(path.join(vendor, `genex-${RELEASE}`), path.join(game, "engine")),
      },
      {
        why: "engine/ is a dangling link",
        refusal: ExtensionRefusal.EjectTargetExists,
        setup: async (game) => symlink(path.join(game, "nowhere"), path.join(game, "engine")),
      },
      {
        why: "engine/ already holds files",
        refusal: ExtensionRefusal.EjectTargetExists,
        setup: async (game) => {
          await mkdir(path.join(game, "engine", "genex"), { recursive: true });
          await writeFile(path.join(game, "engine", "genex", "lib.rs"), "// mine\n");
        },
      },
      {
        why: "engine/ is an empty folder",
        refusal: ExtensionRefusal.EjectTargetExists,
        setup: async (game) => mkdir(path.join(game, "engine")),
      },
      {
        why: "engine is a file",
        refusal: ExtensionRefusal.EjectTargetExists,
        setup: async (game) => writeFile(path.join(game, "engine"), "not a folder\n"),
      },
      {
        why: "genex.toml already names an ejected engine",
        refusal: ExtensionRefusal.EjectTargetExists,
        setup: async (game) =>
          writeFile(
            path.join(game, "genex.toml"),
            '[game]\ntitle = "Forked Pond"\n\n[engine]\nejected_from = "0.1.0"\n',
          ),
      },
      {
        why: "a vendored file's bytes changed",
        refusal: ExtensionRefusal.EjectSourceTampered,
        setup: async (_game, vendor) =>
          writeFile(path.join(vendor, `genex-core-${RELEASE}`, "src", "lib.rs"), "pub fn tick() -> u32 { 2 }\n"),
      },
      {
        why: "a file cargo's manifest does not list",
        refusal: ExtensionRefusal.EjectSourceTampered,
        setup: async (_game, vendor) => writeFile(path.join(vendor, `genex-core-${RELEASE}`, "src", "extra.rs"), "\n"),
      },
      {
        why: "a listed file removed",
        refusal: ExtensionRefusal.EjectSourceTampered,
        setup: async (_game, vendor) => rm(path.join(vendor, `genex-core-${RELEASE}`, "shaders", "common.wgsl")),
      },
      {
        why: "a link inside the vendored crate",
        refusal: ExtensionRefusal.EjectSourceTampered,
        setup: async (_game, vendor) => symlink("/etc/hosts", path.join(vendor, `genex-${RELEASE}`, "src", "hosts.rs")),
      },
      {
        why: "the vendored crate folder is a link",
        refusal: ExtensionRefusal.EjectSourceTampered,
        setup: async (_game, vendor) => {
          const folder = path.join(vendor, `genex-core-${RELEASE}`);
          await cp(folder, `${folder}.real`, { recursive: true });
          await rm(folder, { recursive: true });
          await symlink(`${folder}.real`, folder);
        },
      },
      {
        why: "the digest manifest is not cargo's",
        refusal: ExtensionRefusal.EjectSourceTampered,
        setup: async (_game, vendor) =>
          writeFile(path.join(vendor, `genex-${RELEASE}`, ".cargo-checksum.json"), '{"files":{"../x":"00"}}'),
      },
      {
        why: "the store swept the game's lock line",
        refusal: ExtensionRefusal.EjectLockMissing,
        setup: async () => {},
        line: () => null,
      },
      {
        why: "the lock line's vendored set is gone",
        refusal: ExtensionRefusal.EjectLockMissing,
        setup: async (_game, vendor) => rm(vendor, { recursive: true }),
      },
      {
        why: "the vendored set holds no genex at the release",
        refusal: ExtensionRefusal.EjectLockMissing,
        setup: async () => {},
        line: (vendor) => lineOf(vendor, "0.9.0"),
      },
    ];
    for (const row of rows) {
      const game = await gameCopy();
      const vendor = await smallVendor();
      await row.setup(game, vendor);
      const before = await listing(game);
      const { service, records, ejections } = ejectFor(game, row.line ? row.line(vendor) : lineOf(vendor));
      const answer = await service.eject("forked-pond");
      assert.deepEqual(
        answer,
        { project: "forked-pond", ok: false, refusal: row.refusal, ejectedFrom: null },
        `${row.why}: ${JSON.stringify(answer)}`,
      );
      assert.deepEqual(await listing(game), before, `${row.why}: nothing written`);
      assert.deepEqual(records, [], `${row.why}: nothing recorded`);
      assert.equal(ejections.kept.size, 0, `${row.why}: no eject in the profile`);
    }
  });

  it("throws for a project that is no Rust game, with nothing written", async () => {
    const game = await gameCopy();
    const before = await listing(game);
    const { service } = ejectFor(game, lineOf(await smallVendor()));
    await assert.rejects(service.eject("someone-else"), /not a Rust · wgpu game/);
    assert.deepEqual(await listing(game), before);
  });

  it("is the person's act alone: no harness method or seed method ejects, un-ejects or sets trust", () => {
    // `engine.*` methods are the AI engines'; nothing a harness calls names an eject or the trust flag.
    const person = /eject|trust/i;
    assert.deepEqual(
      Object.values(HostMethod).filter((method) => person.test(method)),
      [],
    );
    assert.deepEqual(
      Object.values(SeedHostMethod).filter((method) => person.test(method)),
      [],
    );
  });
});

/** A vendored genex-render as the release packs it: modules, nested shaders and its README. */
const RENDER_CRATE_FILES: Readonly<Record<string, string>> = {
  "Cargo.toml": crateToml("genex-render", RELEASE, ["genex-core"]),
  "README.md": "# genex-render\n\n## Frame graph\n\n| node | stage |\n| --- | --- |\n",
  "src/lib.rs": "//! the renderer\npub mod graph;\n",
  "src/graph.rs": 'pub const FORWARD: &str = include_str!("../shaders/forward.wgsl");\n',
  "shaders/forward.wgsl": "// forward\n",
  "shaders/part2/material_v2.wgsl": "// the v2 material prelude\n",
  "shaders/post/taa.wgsl": "// temporal resolve\n",
};

describe("a game using every renderer feature ejects whole", { skip: SKIP_ON_WINDOWS }, () => {
  it("forks the same crate set: the renderer and the game-systems crates are the game's, the transport and the phone shells stay the store's", () => {
    // Flipped in EP-0b: the animation, navigation and streaming crates join the fork.
    assert.deepEqual(
      [...RUST_ENGINE_CRATES],
      [
        "genex",
        "genex-anim",
        "genex-assets",
        "genex-audio",
        "genex-core",
        "genex-hud",
        "genex-nav",
        "genex-platform-desktop",
        "genex-platform-web",
        "genex-render",
        "genex-stream",
      ],
    );
  });

  it("declares its look, its per-class quality and a v2 source of each kind in genex.toml", async () => {
    const parsed = parseGenexToml(await readFile(path.join(RENDER_FIXTURE, "genex.toml"), "utf8"));
    assert.ok(parsed.ok, JSON.stringify(parsed));
    const { render, wgsl } = parsed.manifest;
    assert.ok(render);
    assert.deepEqual(render.formFactors, [FormFactor.Desktop, FormFactor.Mobile]);
    assert.equal(render.preset, QualityPreset.Auto, "the device picks the preset");
    assert.equal(render.look.tonemapper, Tonemapper.AgxPunchy);
    assert.equal(render.look.exposure, ExposureMode.Auto);
    for (const amount of [render.look.bloomIntensity, render.look.aoIntensity, render.look.fogDensity])
      assert.ok((amount ?? 0) > 0, "bloom, AO and fog are part of the look");
    for (const strong of [DeviceClass.DesktopHigh, DeviceClass.DesktopUltra])
      assert.deepEqual(render.classes[strong]?.features, {
        [RenderFeature.Meshlets]: true,
        [RenderFeature.Occlusion]: true,
      });
    assert.deepEqual(
      wgsl.map((row) => [row.kind, row.api]),
      [
        [WgslKind.Material, 2],
        [WgslKind.Post, 2],
        [WgslKind.Pass, 2],
        [WgslKind.Pass, 2],
      ],
    );
  });

  it("copies the renderer's modules, nested shaders and README byte for byte", async () => {
    const game = await gameCopy(RENDER_FIXTURE, RENDER_PROJECT);
    const vendor = await smallVendor();
    await vendoredCrate(vendor, "genex-render", RELEASE, RENDER_CRATE_FILES);
    const { service } = ejectFor(game, lineOf(vendor));

    const answer = await service.eject(RENDER_PROJECT);

    assert.deepEqual(answer, { project: RENDER_PROJECT, ok: true, refusal: null, ejectedFrom: RELEASE });
    for (const [rel, text] of Object.entries(RENDER_CRATE_FILES))
      assert.equal(await readFile(path.join(game, "engine", "genex-render", rel), "utf8"), text, rel);
    const manifest = JSON.parse(
      await readFile(path.join(game, "engine", ENGINE_MANIFEST_FILE), "utf8"),
    ) as EngineManifest;
    assert.deepEqual(
      manifest.crates.map((crate) => crate.name),
      ["genex", "genex-core", "genex-render"],
    );
    for (const own of [
      "src/scene.rs",
      "src/probe.rs",
      "src/warm.rs",
      "shaders/glow.wgsl",
      "shaders/vignette.wgsl",
      "shaders/depth_probe.wgsl",
      "shaders/warm.wgsl",
    ])
      assert.deepEqual(
        await readFile(path.join(game, own)),
        await readFile(path.join(RENDER_FIXTURE, own)),
        `${own}: the game's own code is untouched`,
      );
  });
});

describe("an ejected game builds its fork", { skip: SKIP_ON_WINDOWS }, () => {
  /** A copy of the fixture, ejected from the small vendored set. */
  async function ejected(): Promise<{ game: string; vendor: string }> {
    const game = await gameCopy();
    const vendor = await smallVendor();
    const { service } = ejectFor(game, lineOf(vendor));
    assert.equal((await service.eject("forked-pond")).ok, true);
    return { game, vendor };
  }
  /** The person's eject of the small set's release, as the host hands it to the stage. */
  const recorded = { ejectedFrom: RELEASE };

  it("stays on its fork through a lock bump, with the host's crate manifests and engine-updates: manual", async () => {
    const { game, vendor } = await ejected();
    // An agent edits the fork: its code is the game's, its manifest never reaches cargo.
    await writeFile(path.join(game, "engine", "genex-core", "src", "lib.rs"), "pub fn tick() -> u32 { 3 }\n");
    await writeFile(
      path.join(game, "engine", "genex-core", "Cargo.toml"),
      `${crateToml("genex-core", RELEASE)}build = "build.rs"\n[dependencies.evil]\npath = "/etc"\n`,
    );
    const stage = path.join(await realpath(await tmpDir("rust-eject-stage-")), "stage");
    // The store moved on to genex 0.2.0: the ejected game keeps its own release.
    const pins = { genexVersion: "0.2.0", baseLock: null };
    const staged = await stageRustGame({
      source: game,
      stage,
      target: BuildTarget.Mac,
      pins,
      engineVendor: vendor,
      ...recorded,
    });
    assert.ok(staged.ok, JSON.stringify(staged));
    assert.match(staged.cargoToml, /^genex = "=0\.1\.0"$/m, "the fork's own release, not the store's");
    assert.match(
      staged.cargoToml,
      /^\[patch\.crates-io\]\n"genex" = \{ path = "engine\/genex" \}\n"genex-core" = \{ path = "engine\/genex-core" \}$/m,
    );
    assert.equal(
      await readFile(path.join(stage, "engine", "genex-core", "Cargo.toml"), "utf8"),
      await readFile(path.join(vendor, `genex-core-${RELEASE}`, "Cargo.toml"), "utf8"),
      "the host writes each forked crate's manifest from the store's vendored crate",
    );
    assert.equal(
      await readFile(path.join(stage, "engine", "genex-core", "src", "lib.rs"), "utf8"),
      "pub fn tick() -> u32 { 3 }\n",
    );
    assert.ok(staged.files.includes("engine/genex-core/shaders/common.wgsl"));
    assert.ok(
      !staged.files.some((file) => file.endsWith(ENGINE_MANIFEST_FILE) || file.endsWith(".cargo-checksum.json")),
    );
    const manifest = JSON.parse(
      await readFile(path.join(game, "engine", ENGINE_MANIFEST_FILE), "utf8"),
    ) as EngineManifest;
    assert.equal(manifest.engineUpdates, EngineUpdates.Manual);
  });

  it("names the forked crates as path packages in a lock derived from the lock line", () => {
    const baseLock = [
      "version = 4",
      "",
      "[[package]]",
      'name = "genex"',
      `version = "${RELEASE}"`,
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      `checksum = "${"c".repeat(64)}"`,
      'dependencies = [\n "genex-core",\n "serde",\n]',
      "",
      "[[package]]",
      'name = "genex-core"',
      `version = "${RELEASE}"`,
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      `checksum = "${"d".repeat(64)}"`,
      "",
      "[[package]]",
      'name = "serde"',
      'version = "1.0.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      `checksum = "${"e".repeat(64)}"`,
      "",
    ].join("\n");
    const manifest = {
      title: "Forked Pond",
      worldSize: [960, 540] as const,
      saveName: null,
      crates: [],
      wgsl: [],
      nativeFeatures: [],
    };
    const fork = { version: RELEASE, crates: ["genex", "genex-core"] };
    const lock = gameCargoLock(manifest, { genexVersion: "0.2.0", baseLock, fork });
    assert.ok(lock.ok, JSON.stringify(lock));
    const block = (name: string) => lock.text.split("\n\n").find((part) => part.includes(`name = "${name}"`)) ?? "";
    assert.doesNotMatch(block("genex"), /source|checksum/);
    assert.doesNotMatch(block("genex-core"), /source|checksum/);
    assert.match(block("serde"), /source = "registry\+/);
  });

  it("lets the fork read the facade's genex.toml build variables ([render] and [[wgsl]] rows)", async () => {
    const { game, vendor } = await ejected();
    const stage = path.join(await realpath(await tmpDir("rust-eject-stage-")), "stage");
    const pins = { genexVersion: RELEASE, baseLock: null };
    const core = path.join(game, "engine", "genex-core", "src", "lib.rs");
    for (const name of ["GENEX_RENDER_TOML", "GENEX_WGSL_TOML"]) {
      await writeFile(core, `pub const ROWS: Option<&str> = option_env!(${JSON.stringify(name)});\n`);
      const staged = await stageRustGame({
        source: game,
        stage,
        target: BuildTarget.Mac,
        pins,
        engineVendor: vendor,
        ...recorded,
      });
      assert.equal(staged.ok ? null : staged.code, null, `the facade's option_env!(${JSON.stringify(name)}) stages`);
    }
  });

  it("lets the fork read the facade's own build variables, never a host variable, and the game's code neither", async () => {
    const { game, vendor } = await ejected();
    const stage = path.join(await realpath(await tmpDir("rust-eject-stage-")), "stage");
    const pins = { genexVersion: RELEASE, baseLock: null };
    const stageIt = () =>
      stageRustGame({ source: game, stage, target: BuildTarget.Mac, pins, engineVendor: vendor, ...recorded });
    assert.equal((await stageIt()).ok, true, 'the facade\'s option_env!("GENEX_GAME_NAME") stages');
    const core = path.join(game, "engine", "genex-core", "src", "lib.rs");
    await writeFile(core, 'pub const HOME: Option<&str> = option_env!("HOME");\n');
    const home = await stageIt();
    assert.equal(home.ok ? null : home.code, RustStageCode.EnvNotFixed);
    await writeFile(core, "pub fn tick() -> u32 { 1 }\n");
    await writeFile(
      path.join(game, "src", "game.rs"),
      `${await readFile(path.join(game, "src", "game.rs"), "utf8")}\npub const N: Option<&str> = option_env!("GENEX_GAME_NAME");\n`,
    );
    const own = await stageIt();
    assert.equal(
      own.ok ? null : own.code,
      RustStageCode.EnvNotFixed,
      "the game's own code reads cargo's variables only",
    );
  });

  it("refuses an ejected game whose fork or vendored crate is missing", async () => {
    const stageOf = async (game: string, vendor: string | null) => {
      const stage = path.join(await realpath(await tmpDir("rust-eject-stage-")), "stage");
      const pins = { genexVersion: RELEASE, baseLock: null };
      return stageRustGame({ source: game, stage, target: BuildTarget.Mac, pins, engineVendor: vendor, ...recorded });
    };
    const code = (result: Awaited<ReturnType<typeof stageOf>>) => (result.ok ? null : result.code);
    const noVendor = await ejected();
    assert.equal(code(await stageOf(noVendor.game, null)), RustStageCode.EngineMissing, "no vendored set handed over");
    const noFacade = await ejected();
    await rm(path.join(noFacade.game, "engine", "genex"), { recursive: true });
    assert.equal(code(await stageOf(noFacade.game, noFacade.vendor)), RustStageCode.EngineMissing, "no engine/genex");
    const linked = await ejected();
    await rm(path.join(linked.game, "engine", "genex-core"), { recursive: true });
    await symlink(path.join(linked.vendor, `genex-core-${RELEASE}`), path.join(linked.game, "engine", "genex-core"));
    assert.equal(code(await stageOf(linked.game, linked.vendor)), RustStageCode.Symlink, "a forked crate as a link");
  });

  it("links a fork only where the person ejected: a row and engine/ an agent wrote, or a row it removed or changed, is engine-unrecorded", async () => {
    const stageOf = async (game: string, vendor: string, ejectedFrom: string | null) => {
      const stage = path.join(await realpath(await tmpDir("rust-eject-stage-")), "stage");
      const pins = { genexVersion: RELEASE, baseLock: null };
      const result = await stageRustGame({
        source: game,
        stage,
        target: BuildTarget.Mac,
        pins,
        engineVendor: vendor,
        ejectedFrom,
      });
      return { code: result.ok ? null : result.code, staged: existsSync(stage) };
    };
    const refused = { code: RustStageCode.EngineUnrecorded, staged: false };
    // An agent copies the vendored engine into engine/ and writes the row itself: no person's record.
    const forged = await gameCopy();
    const vendor = await smallVendor();
    for (const name of ["genex", "genex-core"])
      await cp(path.join(vendor, `${name}-${RELEASE}`), path.join(forged, "engine", name), { recursive: true });
    const toml = path.join(forged, "genex.toml");
    await writeFile(toml, `${await readFile(toml, "utf8")}\n[engine]\nejected_from = "${RELEASE}"\n`);
    assert.deepEqual(await stageOf(forged, vendor, null), refused, "an agent-written row links nothing");
    // The person ejected; then an agent removes the row, or names another release.
    const { game } = await ejected();
    const ejectedToml = await readFile(path.join(game, "genex.toml"), "utf8");
    assert.deepEqual(await stageOf(game, vendor, "0.2.0"), refused, "a row naming another release than the record");
    await writeFile(path.join(game, "genex.toml"), ejectedToml.replace(/\n\[engine\][^[]*$/, "\n"));
    assert.deepEqual(await stageOf(game, vendor, RELEASE), refused, "a removed row is no silent un-eject");
    await writeFile(path.join(game, "genex.toml"), ejectedToml);
    assert.deepEqual(await stageOf(game, vendor, RELEASE), { code: null, staged: true }, "row and record agree");
  });

  it("stages a game that is not ejected exactly as before, a stray engine/ folder or not (characterization)", async () => {
    const plain = await gameCopy();
    const stray = await gameCopy();
    await mkdir(path.join(stray, "engine", "genex", "src"), { recursive: true });
    await writeFile(path.join(stray, "engine", "genex", "src", "lib.rs"), 'compile_error!("never staged");\n');
    const vendor = await smallVendor();
    const stageOf = async (game: string) => {
      const stage = path.join(await realpath(await tmpDir("rust-eject-stage-")), "stage");
      const pins = { genexVersion: RELEASE, baseLock: null };
      return stageRustGame({ source: game, stage, target: BuildTarget.Mac, pins, engineVendor: vendor });
    };
    const [a, b] = [await stageOf(plain), await stageOf(stray)];
    assert.ok(a.ok && b.ok);
    assert.deepEqual(b.files, a.files);
    assert.equal(b.cargoToml, a.cargoToml);
    assert.doesNotMatch(a.cargoToml, /patch/);
    assert.ok(!a.files.some((file) => file.startsWith("engine/")));
  });
});

describe("the conformance gate of an ejected game", { skip: SKIP_ON_WINDOWS, timeout: 2 * MINUTE_MS }, () => {
  const green = (project: string, buildDigest: string): ConformanceRunPayload => ({
    project,
    buildDigest,
    passed: true,
    checks: [
      { check: ConformanceCheck.Verbs, outcome: ConformanceOutcome.Pass, code: null, detail: null },
      { check: ConformanceCheck.SeedDeterminism, outcome: ConformanceOutcome.Pass, code: null, detail: null },
      { check: ConformanceCheck.CaptureDigest, outcome: ConformanceOutcome.Pass, code: null, detail: null },
      {
        check: ConformanceCheck.LiveRing,
        outcome: ConformanceOutcome.Unavailable,
        code: ConformanceProblem.LiveNotMac,
        detail: null,
      },
      { check: ConformanceCheck.StopReap, outcome: ConformanceOutcome.Pass, code: null, detail: null },
      {
        check: ConformanceCheck.RenderPresets,
        outcome: ConformanceOutcome.Unavailable,
        code: ConformanceProblem.RenderSettingsUnsupported,
        detail: null,
      },
      {
        check: ConformanceCheck.RenderExtensions,
        outcome: ConformanceOutcome.Unavailable,
        code: ConformanceProblem.RenderSettingsUnsupported,
        detail: null,
      },
    ],
  });

  it("opens only on a green run of this game on this build digest, the latest run counting", () => {
    const required = { ok: false, refusal: ExtensionRefusal.ConformanceRequired };
    const gate = (runs: ConformanceRunPayload[], ejected = true, buildDigest: string | null = DIGEST_B) => {
      const result = conformanceGate({ project: "pond", ejected, buildDigest, runs });
      return result.ok ? { ok: true } : { ok: false, refusal: result.refusal };
    };
    assert.deepEqual(gate([], false), { ok: true }, "a game on the store's engine needs no run");
    assert.deepEqual(gate([]), required, "no run");
    assert.deepEqual(gate([green("pond", DIGEST_A)]), required, "a green run of an older build");
    assert.deepEqual(gate([green("cove", DIGEST_B)]), required, "another game's run");
    assert.deepEqual(gate([green("pond", DIGEST_B)], true, null), required, "no build yet");
    assert.deepEqual(gate([green("pond", DIGEST_B)]), { ok: true });
    const red = { ...green("pond", DIGEST_B), passed: false };
    assert.deepEqual(gate([green("pond", DIGEST_B), red]), required, "a later red run on the same build closes it");
    const claimed = { ...green("pond", DIGEST_B), checks: [] };
    assert.deepEqual(gate([claimed]), required, "a run's flag alone, without its checks, never opens it");
  });

  it("an engine edit that breaks seed determinism blocks Live and export until a green run on that build", async () => {
    const game = await gameCopy();
    const { service } = ejectFor(game, lineOf(await smallVendor()));
    assert.equal((await service.eject("forked-pond")).ok, true);
    const runs: ConformanceRunPayload[] = [];
    const ejectedFrom = async () => RELEASE;
    const gate = () =>
      checkConformanceGate({ project: "forked-pond", ejectedFrom, buildDigest: DIGEST_B, runs: async () => runs });

    // The edited engine's build: two seeded runs disagree.
    const red = await suiteOnDouble(["nondeterministic"], DIGEST_B);
    assert.equal(red.passed, false);
    runs.push({ project: red.project, buildDigest: red.buildDigest, passed: red.passed, checks: red.checks });
    const blocked = await gate();
    assert.deepEqual(blocked.ok ? null : blocked.refusal, ExtensionRefusal.ConformanceRequired);

    // The fixed engine's build passes on the same digest: the gate opens.
    const fixed = await suiteOnDouble([], DIGEST_B);
    assert.equal(fixed.passed, true, JSON.stringify(fixed.checks));
    runs.push({ project: fixed.project, buildDigest: fixed.buildDigest, passed: fixed.passed, checks: fixed.checks });
    assert.deepEqual(await gate(), { ok: true });

    // The same game on the store's engine needs no run at all.
    const open = await checkConformanceGate({
      project: "forked-pond",
      ejectedFrom: async () => null,
      buildDigest: DIGEST_B,
      runs: async () => [],
    });
    assert.deepEqual(open, { ok: true });
  });

  it("harness code cannot forge a host record: a green conformance_run, an eject or a trust row is refused with nothing written", async () => {
    const { core, api } = await coreLite();
    const turn = await api()[HostMethod.TurnBegin]({});
    const forged: Array<[CustomEvent, Record<string, unknown>]> = [
      [CustomEvent.ConformanceRun, { ...green("pond", DIGEST_B) }],
      [CustomEvent.EngineEjected, { project: "pond", ejected: true, ejectedFrom: RELEASE }],
      [CustomEvent.GameTrust, { project: "pond", trusted: true }],
      [CustomEvent.CrateRequest, { project: "pond", requestId: "r1", name: "evil", version: "1.0.0" }],
      [CustomEvent.CrateDecision, { project: "pond", requestId: "r1", approved: true }],
    ];
    for (const [type, payload] of forged) {
      const head = await core.store.head(core.mainThread);
      const batch: EventData[] = [{ type: EventKind.Custom, event_type: type, payload }];
      await assert.rejects(api()[HostMethod.EventsAppend]({ batch }), /studio only/, `events.append ${type}`);
      await assert.rejects(api()[HostMethod.TurnAppend]({ turnId: turn.turnId, batch }), /studio only/, type);
      assert.equal(await core.store.head(core.mainThread), head, `nothing of ${type} is written`);
    }
    const runs = await storeConformanceRuns(core.store)();
    assert.deepEqual(runs, [], "no forged run reaches the gate");
    const gate = conformanceGate({ project: "pond", ejected: true, buildDigest: DIGEST_B, runs });
    assert.equal(gate.ok, false, "the gate stays closed");
  });
});

describe("the person's eject is kept in the profile, never the game", { skip: SKIP_ON_WINDOWS }, () => {
  it("holds for the library folder it was made on: a replaced folder, a hand-edited file or a link ejects nothing", async () => {
    const home = await realpath(await tmpDir("rust-eject-records-"));
    const file = path.join(home, "userData", ENGINE_EJECTS_FILE);
    await mkdir(path.dirname(file), { recursive: true });
    let dir = await gameCopy();
    const records = createEngineEjections({ file, rustGame: async (project) => (project === "pond" ? { dir } : null) });
    assert.equal(await records.ejectedFrom("pond"), null, "nothing ejected by default");
    await records.set("pond", dir, RELEASE);
    assert.equal(await records.ejectedFrom("pond"), RELEASE);
    assert.equal(await records.ejectedFrom("cove"), null, "another game");
    dir = await gameCopy();
    assert.equal(await records.ejectedFrom("pond"), null, "a copy under the same name is not the folder ejected");
    const hostile: Array<[string, () => Promise<void>]> = [
      ["not JSON", () => writeFile(file, "{")],
      ["another schema", () => writeFile(file, JSON.stringify({ schema: 2, games: [] }))],
      [
        "a release that is no release",
        async () => {
          const kept = JSON.parse(await readFile(file, "utf8")) as { games: Array<Record<string, string>> };
          await writeFile(
            file,
            JSON.stringify({ schema: 1, games: kept.games.map((g) => ({ ...g, ejectedFrom: "../x" })) }),
          );
        },
      ],
      [
        "a link to a file that would eject it",
        async () => {
          const real = `${file}.real`;
          await writeFile(real, await readFile(file));
          await rm(file);
          await symlink(real, file);
        },
      ],
    ];
    for (const [why, plant] of hostile) {
      await rm(file, { force: true });
      await records.set("pond", dir, RELEASE);
      assert.equal(await records.ejectedFrom("pond"), RELEASE, why);
      await plant();
      assert.equal(await records.ejectedFrom("pond"), null, why);
    }
    await rm(file, { force: true });
    await records.set("pond", dir, RELEASE);
    await records.set("pond", dir, null);
    assert.equal(await records.ejectedFrom("pond"), null, "un-eject clears it");
  });
});

describe("un-eject gives the store engine back", { skip: SKIP_ON_WINDOWS }, () => {
  it("clears the person's record even when an agent already removed the row and the folder, after a snapshot", async () => {
    const game = await gameCopy();
    const original = await readFile(path.join(game, "genex.toml"), "utf8");
    const { service, snapshots, ejections } = ejectFor(game, lineOf(await smallVendor()));
    assert.equal((await service.eject("forked-pond")).ok, true);
    await writeFile(path.join(game, "genex.toml"), original);
    await rm(path.join(game, "engine"), { recursive: true });
    assert.equal((await service.uneject("forked-pond")).ok, true);
    assert.equal(snapshots.length, 1, "snapshot first");
    assert.equal(await ejections.ejectedFrom("forked-pond"), null);
  });

  it("snapshots the game first, then removes the fork and the [engine] row", async () => {
    const game = await gameCopy();
    const original = await readFile(path.join(game, "genex.toml"), "utf8");
    const { service, records, snapshots, ejections } = ejectFor(game, lineOf(await smallVendor()));
    assert.equal((await service.eject("forked-pond")).ok, true);
    const answer = await service.uneject("forked-pond");
    assert.equal(await ejections.ejectedFrom("forked-pond"), null, "the profile's record is cleared");
    assert.deepEqual(answer, { project: "forked-pond", ok: true, refusal: null, ejectedFrom: null });
    assert.deepEqual(
      snapshots,
      [{ project: "forked-pond", engineThere: true, row: true }],
      "taken while the fork was there",
    );
    assert.equal(existsSync(path.join(game, "engine")), false);
    assert.equal(
      await readFile(path.join(game, "genex.toml"), "utf8"),
      original,
      "the build input as it was before the eject",
    );
    const parsed = await readGenexToml(game);
    assert.ok(parsed.ok);
    assert.equal(parsed.manifest.engine, null);
    assert.deepEqual(records.at(-1), {
      project: "forked-pond",
      ejected: false,
      ejectedFrom: null,
      snapshotId: "snap-1",
    });
  });

  it("removes nothing when the snapshot fails, and does nothing for a game on the store's engine", async () => {
    const game = await gameCopy();
    const vendor = await smallVendor();
    assert.equal((await ejectFor(game, lineOf(vendor)).service.eject("forked-pond")).ok, true);
    const before = await listing(game);
    const failing = ejectFor(game, lineOf(vendor), {
      snapshot: async () => {
        throw new Error("snapshot refused");
      },
    });
    await assert.rejects(failing.service.uneject("forked-pond"), /snapshot refused/);
    assert.deepEqual(await listing(game), before);
    assert.deepEqual(failing.records, []);

    const plain = await gameCopy();
    const untouched = await listing(plain);
    const idle = ejectFor(plain, lineOf(vendor));
    assert.deepEqual(await idle.service.uneject("forked-pond"), {
      project: "forked-pond",
      ok: true,
      refusal: null,
      ejectedFrom: null,
    });
    assert.deepEqual(idle.snapshots, []);
    assert.deepEqual(await listing(plain), untouched);
  });
});

describe("an ejected engine is the entry owner's", () => {
  /** Both copies of the ownership rule answer `allowed`. */
  const agree = (file: string, spec: OwnershipSpec, ownsMain: boolean, allowed: boolean, why: string) => {
    assert.equal(hookAllowedFile(file, spec, ownsMain), allowed, `hook: ${file} — ${why}`);
    assert.equal(reviewAllowedFile(file, spec, ownsMain), allowed, `review: ${file} — ${why}`);
  };
  it("gives engine/** to the facet that owns the entry and to no other, whatever its seam or name", () => {
    const world: OwnershipSpec = { id: "world", owns: ["src/game.rs"] };
    agree("engine/genex-core/src/lib.rs", world, true, true, "the entry owner's");
    agree("engine/genex/Cargo.toml", world, true, true, "the entry owner's");
    agree(
      "engine/genex-core/src/lib.rs",
      { id: "core", owns: ["src/facets/core.rs"] },
      false,
      false,
      "a facet named like a crate",
    );
    agree("engine/genex-render/src/pbr.rs", { id: "fx", owns: ["engine/**"] }, false, false, "a seam naming it");
    agree("engine/genex/src/lib.rs", { id: "loose" }, false, false, "a facet with no seam");
    agree("src/facets/core.rs", { id: "core", owns: ["src/facets/core.rs"] }, false, true, "its own module still");
    const own: OwnershipSpec = { id: "fx", owns: ["engine/**"], template: false };
    agree("engine/physics.js", own, false, true, "a game the user brought keeps its own engine/ seam");
  });
});

// ── The suite over the nonconforming double ─────────────────────────────────────────────────────

const isTimeout = (handle: unknown): handle is NodeJS.Timeout => typeof handle === "object" && handle !== null;
const TIMERS: NativeTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => {
    if (isTimeout(handle)) clearTimeout(handle);
  },
};
const leftovers: Array<() => void> = [];
after(() => {
  for (const kill of leftovers) kill();
});

/** Starts the double as `spawnGame` would (fd 3, its own group, the studio's variables), for the suite. */
function launchDouble(args: readonly string[], buildDigest: string): Promise<ConformanceLaunch> {
  return launchOnFd3(process.execPath, [DOUBLE, ...args], buildDigest, {});
}

/** Starts `file` on fd 3 in a process group of its own with only the studio's variables (and `env`); ready or rejects. */
async function launchOnFd3(
  file: string,
  args: readonly string[],
  buildDigest: string,
  env: Readonly<Record<string, string>>,
): Promise<ConformanceLaunch> {
  const scratch = await realpath(await tmpDir("rust-eject-run-"));
  const stateDir = path.join(scratch, "state");
  await mkdir(stateDir, { recursive: true });
  const nonce = "rust-eject-nonce";
  const proc = spawn(file, args, {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    detached: true,
    cwd: scratch,
    env: { GENEX_STUDIO_FD: "3", GENEX_STUDIO_NONCE: nonce, GENEX_STATE_DIR: stateDir, HOME: scratch, ...env },
  });
  const exited = new Promise<GameExit>((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
  await once(proc, "spawn");
  proc.on("error", () => {});
  const { pid, stdout, stderr } = proc;
  const fd3 = proc.stdio[3];
  if (!(fd3 instanceof Duplex) || pid === undefined || !stdout || !stderr) throw new Error("no protocol pipe");
  const kill = (signal: NodeJS.Signals) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  };
  leftovers.push(() => kill("SIGKILL"));
  const child: GameChild = { pid, fd3, stdout, stderr, exited, kill };
  const port = new NativeGamePort({
    child,
    nonce,
    mode: NativeRunMode.Headless,
    stateDir,
    timers: TIMERS,
    encodeJpeg: async () => Buffer.from("jpeg"),
  });
  await port.ready();
  return { port, pid, stateDir, buildDigest, stop: () => stopGameChild(child, port) };
}

async function suiteOnDouble(args: readonly string[], buildDigest: string): Promise<GameConformanceReport> {
  return runGameConformance(
    { launch: () => launchDouble(args, buildDigest), platform: "linux", now: () => Date.now() },
    { project: "forked-pond", target: BuildTarget.Mac },
  );
}

// ── The real fork: ejected from the release's vendored crates, built offline, judged ─────────────

const TOOLCHAIN_DIR = process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev", "spike-toolchain");
const VENDOR_DIR = process.env.GENEX_RUST_VENDOR_DIR ?? path.join(REPO, ".studio-dev", "rust-release", "e2e", "vendor");
const WORKSPACE = path.join(REPO, "native", "genex-rust");
const REQUIRED = process.env.GENEX_REQUIRE_TOOLCHAINS === "1";
/** A cold build compiles the facade's whole dependency graph twice (clippy, then the build). */
const COLD_BUILD_MS = 30 * MINUTE_MS;

/** Why the real row cannot run here, or null. */
function absent(): string | null {
  if (process.platform !== "darwin" || process.arch !== "arm64") return "an Apple silicon Mac";
  for (const need of ["sysroot/bin/cargo", "sysroot/bin/cargo-clippy"])
    if (!existsSync(path.join(TOOLCHAIN_DIR, need))) return `the Rust toolchain (${path.join(TOOLCHAIN_DIR, need)})`;
  if (!existsSync(path.join(VENDOR_DIR, `genex-${RELEASE}`))) return `the release's vendored crates (${VENDOR_DIR})`;
  return null;
}

function needsToolchain(): { skip?: string } {
  const missing = absent();
  if (!missing) return {};
  if (REQUIRED) throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return { skip: `not run: ${missing} absent` };
}

function gameOf(dir: string, project = "forked-pond"): GameBuildGame {
  return {
    project,
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

/** `npm run conformance:game -- --game <exe> --json`, its report. */
async function conformanceOf(exe: string): Promise<GameConformanceReport> {
  // The test's own build of the fixture, outside the developer's cargo target: run as such.
  const script = path.join(REPO, "scripts", "game-conformance.ts");
  const proc = spawn(process.execPath, [script, "--game", exe, "--json", "--unsandboxed"], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  await once(proc, "exit");
  return JSON.parse(out) as GameConformanceReport;
}

/** A copy of `fixture` as the library's `project`, ejected from the release's vendored crates, and the real lane that builds it. */
async function ejectedFromRelease(fixture: string, project: string) {
  const toolchainDir = realpathSync(TOOLCHAIN_DIR);
  const home = await realpath(await tmpDir("rust-eject-real-"));
  const games = path.join(home, "games");
  await mkdir(games, { recursive: true });
  const dir = path.join(games, project);
  await cp(fixture, dir, { recursive: true });
  const vendor = await realpath(VENDOR_DIR);
  const { service } = ejectFor(dir, lineOf(vendor));
  const answer = await service.eject(project);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(
    (await readdir(path.join(dir, "engine"))).filter((name) => name !== ENGINE_MANIFEST_FILE).sort(),
    RUST_ENGINE_CRATES.filter((name) => existsSync(path.join(vendor, `${name}-${RELEASE}`))).sort(),
  );

  const payload = rustPayloadDir(path.join(home, "resources"));
  await mkdir(payload, { recursive: true });
  for (const file of ["Cargo.lock", "clippy.toml"])
    await writeFile(path.join(payload, file), await readFile(path.join(WORKSPACE, file)));
  const toolchain: RustToolchain = {
    bin: path.join(toolchainDir, "sysroot", "bin"),
    vendor,
    clippyConf: payload,
    reads: [toolchainDir, vendor, payload],
  };
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
    ejection: async () => RELEASE,
  });
  return { dir, builds };
}

/** Folders of a crate whose every file the fork must hold: its modules and its shaders. */
const CRATE_SOURCE_FOLDERS = ["src", "shaders"] as const;

/** Every file under `crate`'s source folders, crate-relative and `/`-joined. */
async function crateSources(crate: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const entry of await readdir(path.join(crate, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else files.push(child);
    }
  };
  for (const folder of CRATE_SOURCE_FOLDERS) await walk(folder);
  return files.sort();
}

/** The `## ` sections of a Markdown text, by their titles. */
function sectionsOf(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  for (const part of markdown.split(/^## /m).slice(1)) {
    const [title = "", ...body] = part.split("\n");
    sections.set(title.trim(), body.join("\n"));
  }
  return sections;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The fork's `state().volatile` as a reference desktop draws it at `high` (the class captures are drawn as). */
/** How long a studio run's settings change may take to land: its renderer warms off the frame thread. */
const CHANGE_LANDS_MS = 2 * MINUTE_MS;
/** The sim time each poll steps while the change warms, and the wall time between polls. */
const CHANGE_POLL_MS = 100;

/** Whether the last drawn frame still holds the settings before a change (`pipeline-change-deferred`). */
function changeDeferred(state: Record<string, unknown>): boolean {
  const volatile = isRecord(state.volatile) ? state.volatile : {};
  const render = isRecord(volatile.render) ? volatile.render : {};
  const degraded = Array.isArray(render.degraded) ? render.degraded : [];
  return degraded.some((entry) => isRecord(entry) && entry.reason === DegradeReason.PipelineChangeDeferred);
}

/**
 * Steps a studio run until Live draws the settings asked of it: Live keeps drawing the last ones
 * (`pipeline-change-deferred`) while the new renderer warms on another thread (GENEX_API).
 */
async function untilChangeLands(port: ConformanceLaunch["port"]): Promise<void> {
  const deadline = Date.now() + CHANGE_LANDS_MS;
  while (Date.now() < deadline) {
    await port.call(NativeOp.Step, { ms: CHANGE_POLL_MS });
    if (!changeDeferred(await port.call(NativeOp.State))) return;
    await sleep(CHANGE_POLL_MS);
  }
}

async function volatileAtHigh(exe: string): Promise<Record<string, unknown>> {
  const launch = await launchOnFd3(exe, [], "", { GENEX_HEADLESS: "1" });
  try {
    const { port } = launch;
    await port.call(NativeOp.Seed, { seed: 1 });
    await port.call(NativeOp.RenderSettings, {
      set: { deviceClass: DeviceClass.DesktopHigh, preset: QualityPreset.High },
    });
    await untilChangeLands(port);
    await port.call(NativeOp.Step, { ms: 1000 });
    const shot = await port.call(NativeOp.Capture, {});
    const evidence = process.env.GENEX_EJECT_EVIDENCE_DIR;
    if (evidence && launch.stateDir) {
      const name = `${RENDER_PROJECT}-fork-high-${shot.width}x${shot.height}-${shot.digest}.bgra`;
      await cp(path.join(launch.stateDir, "captures", `${shot.seq}.bgra`), path.join(evidence, name));
    }
    const state = await port.call(NativeOp.State);
    return isRecord(state.volatile) ? state.volatile : {};
  } finally {
    await launch.stop();
  }
}

describe("the real fork builds offline and conforms (macOS)", () => {
  const options = needsToolchain();
  it("ejects the release's engine, builds the fork through the real lane, passes the suite, and builds again after an engine edit", {
    ...options,
    timeout: 3 * COLD_BUILD_MS,
  }, async () => {
    const { dir, builds } = await ejectedFromRelease(FIXTURE, "forked-pond");

    const built = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(built.ok, true, JSON.stringify(built.problem));
    const exe = path.join(built.output ?? "", "game");
    const report = await conformanceOf(exe);
    assert.equal(report.passed, true, JSON.stringify(report.checks));

    // The fork is the game's: an edit to the engine is what the next build compiles.
    const core = path.join(dir, "engine", "genex-core", "src", "lib.rs");
    await writeFile(
      core,
      `${await readFile(core, "utf8")}\n/// An engine edit the fork owns.\npub const FORKED: bool = true;\n`,
    );
    const again = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(again.ok, true, JSON.stringify(again.problem));
    assert.notEqual(again.problem?.reason, BuildProblemCode.CommandFailed);
  });

  it("ejects a game using every renderer feature: the fork holds every module, shader and the README, conforms on every check and draws every feature", {
    ...options,
    timeout: 2 * COLD_BUILD_MS,
  }, async () => {
    const { dir, builds } = await ejectedFromRelease(RENDER_FIXTURE, RENDER_PROJECT);
    const fork = path.join(dir, "engine", "genex-render");
    const workspaceRender = path.join(WORKSPACE, "crates", "genex-render");
    const stale: string[] = [];
    for (const rel of await crateSources(workspaceRender)) {
      const forked = path.join(fork, ...rel.split("/"));
      const same =
        existsSync(forked) &&
        (await readFile(forked)).equals(await readFile(path.join(workspaceRender, ...rel.split("/"))));
      if (!same) stale.push(rel);
    }
    assert.deepEqual(
      stale,
      [],
      "the fork lacks modules or shaders of the workspace's genex-render, or holds older bytes: the vendored tree is older than the workspace (rebuild it: rust-release.ts tree)",
    );
    const readme = sectionsOf(await readFile(path.join(fork, "README.md"), "utf8"));
    const graph = readme.get("Frame graph") ?? "";
    assert.ok(/^\| .+ \|$/m.test(graph), "the README's frame graph has its node table");
    assert.ok(readme.has("Extension layouts"), "the README holds the v2 layouts");
    const meshlets = [...readme.entries()].find(([title]) => title.startsWith("Meshlets"));
    assert.ok(meshlets?.[1].includes("genex_meshlets"), "the README holds the meshlet schema");

    const built = await builds.ensure(gameOf(dir, RENDER_PROJECT), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(built.ok, true, JSON.stringify(built.problem));
    const exe = path.join(built.output ?? "", "game");
    const report = await conformanceOf(exe);
    assert.equal(report.passed, true, JSON.stringify(report.checks));
    for (const check of CONFORMANCE_CHECKS) {
      const outcome = report.checks.find((result) => result.check === check)?.outcome;
      const judged =
        check === ConformanceCheck.LiveRing ? outcome !== ConformanceOutcome.Fail : outcome === ConformanceOutcome.Pass;
      assert.ok(judged, `${check}: ${outcome}`);
    }

    const drawn = await volatileAtHigh(exe);
    const render = isRecord(drawn.render) ? drawn.render : {};
    const features = isRecord(render.features) ? render.features : {};
    assert.deepEqual(
      Object.values(RenderFeature).filter((feature) => features[feature] !== true),
      [],
      "every renderer feature is drawn",
    );
    assert.deepEqual(render.degraded, [], "nothing degraded");
    assert.deepEqual(drawn.extensions, [
      { path: "shaders/glow.wgsl", kind: WgslKind.Material, api: 2, code: null, fault: null, detail: null },
      { path: "shaders/vignette.wgsl", kind: WgslKind.Post, api: 2, code: null, fault: null, detail: null },
    ]);
    assert.deepEqual(drawn.customPasses, [
      { name: "depth-probe", stage: CustomPassStage.AfterPrepass, running: true, code: null },
      { name: "warm", stage: CustomPassStage.PostHdr, running: true, code: null },
    ]);
  });
});
