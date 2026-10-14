/**
 * A profile's vendored crate overlay (`crate-overlay.ts`) and the vendor job that fills it
 * (`crate-vendor-job.ts`), over the fixture registry with no network: a tampered crate folder or
 * digest manifest refuses the grant `crate-overlay-tampered` (and with it the build, before cargo
 * runs); the vendor job writes only its job folder and opens no socket; an approval in one profile
 * never appears in another; an approved crate builds for its own game only, from the merged
 * directory source (with the real toolchain: `crate-request-real.test.ts`), and its licence
 * reaches the export notices. The resolver's requirement and licence-expression readers are tabled.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { describe, it } from "node:test";
import { createCrateRequests } from "../../src/main/crate-requests.ts";
import {
  RustBuilds,
  type RustBuildSandboxSpec,
  type RustBuildsOptions,
  type RustStaged,
} from "../../src/main/rust-build.ts";
import { RustBuildRefusal } from "../../src/main/rust-build-diagnostics.ts";
import { CppBuildPurpose } from "../../src/shared/build-problem.ts";
import { CrateDecision, CrateRefusal, CrateRequestState } from "../../src/shared/crate-requests.ts";
import { BuildTarget, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import type { ToolchainLock } from "../../src/shared/toolchain.ts";
import { NoticeSourceKind } from "../../src/substrate/native-export.ts";
import { readVendoredLicences, RustRuntimePart, rustNotices } from "../../src/substrate/rust-notices.ts";
import { crateOverlayLayout, overlayGrant } from "../../src/substrate/toolchain-store/crate-overlay.ts";
import {
  builtinCrateChecker,
  CRATE_BANS,
  CRATE_LICENCE_ALLOW,
  licenceAllowed,
} from "../../src/substrate/toolchain-store/crate-check.ts";
import {
  directoryCrateDownload,
  directoryCrateIndex,
  parseRequirement,
  runCrateVendorJob,
  sparseIndexPath,
} from "../../src/substrate/toolchain-store/crate-vendor-job.ts";
import {
  FIXTURE_ADVISORIES,
  FIXTURE_AUDITS,
  FIXTURE_BASE_LOCK,
  writeFixtureRegistry,
} from "../fixtures/crate-registry/registry.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** The fixture profiles' engine: the built-in rules over the fixtures' snapshot and audit list. */
const CHECKER = builtinCrateChecker({
  licences: CRATE_LICENCE_ALLOW,
  advisories: FIXTURE_ADVISORIES,
  advisoryDb: "fixture",
  advisoryDbDate: "2026-10-08",
  audits: FIXTURE_AUDITS,
  bans: CRATE_BANS,
});
const LOCK: ToolchainLock = {
  version: 1,
  entries: { rust: { version: "1.99.0", sha12: "0123456789ab" } },
  digest: "0123456789abcdef".repeat(4),
};
const SKIP_ON_WINDOWS = process.platform === "win32" ? "the merged source's folder links are POSIX links here" : false;

/** A profile (its own store) over a shared registry and download cache, with Rust games `pond` and `other`. */
async function profile(root: string, name: string) {
  const registry = path.join(root, "registry");
  const store = path.join(root, name, "toolchains");
  const games = path.join(root, name, "games");
  for (const game of ["pond", "other"]) {
    await mkdir(path.join(games, game), { recursive: true });
    await writeFile(path.join(games, game, "genex.toml"), `[game]\ntitle = "${game}"\n`);
  }
  const service = createCrateRequests({
    store,
    downloadCache: path.join(root, "download-cache"),
    index: directoryCrateIndex(registry),
    download: directoryCrateDownload(registry),
    checker: async () => ({ ok: true as const, checker: CHECKER }),
    locked: async () => FIXTURE_BASE_LOCK,
    rustGame: async (project) => (["pond", "other"].includes(project) ? { dir: path.join(games, project) } : null),
    rustGames: async () => ["pond", "other"],
    record: async () => {},
  });
  return { service, layout: crateOverlayLayout(store), games };
}

async function approved(service: Awaited<ReturnType<typeof profile>>["service"], name: string, version: string) {
  const asked = await service.request({ project: "pond", name, version });
  const view = await service.decide({ requestId: asked.requestId, decision: CrateDecision.Approve });
  assert.equal(view.state, CrateRequestState.Vendored, JSON.stringify(view));
  return view;
}

async function fixture(prefix: string) {
  const root = await realpath(await tmpDir(prefix));
  await writeFixtureRegistry(path.join(root, "registry"));
  return root;
}

describe("a tampered overlay refuses its grant", () => {
  const tamperings: ReadonlyArray<readonly [string, (layout: ReturnType<typeof crateOverlayLayout>) => Promise<void>]> =
    [
      [
        "a changed source file",
        async (layout) => {
          await writeFile(path.join(layout.vendor, "tidy-1.0.0", "src", "lib.rs"), "pub fn value() -> u32 { 8 }\n");
        },
      ],
      [
        "an added file",
        async (layout) => {
          await writeFile(path.join(layout.vendor, "tidy-1.0.0", "build.rs"), "fn main() {}\n");
        },
      ],
      [
        "a link planted in the crate",
        async (layout) => {
          await symlink("/etc/hosts", path.join(layout.vendor, "tidy-1.0.0", "hosts"));
        },
      ],
      [
        "the crate folder removed",
        async (layout) => {
          await rm(path.join(layout.vendor, "tidy-1.0.0"), { recursive: true });
        },
      ],
      [
        "the crate folder swapped for a link",
        async (layout) => {
          const moved = `${layout.vendor}-moved`;
          await mkdir(moved, { recursive: true });
          await rm(path.join(layout.vendor, "tidy-1.0.0"), { recursive: true });
          await symlink(moved, path.join(layout.vendor, "tidy-1.0.0"));
        },
      ],
      [
        "a digest rewritten in the manifest",
        async (layout) => {
          const manifest = JSON.parse(await readFile(layout.manifest, "utf8"));
          manifest.crates["tidy@1.0.0"].digest = "0".repeat(64);
          await writeFile(layout.manifest, JSON.stringify(manifest));
        },
      ],
      [
        "a manifest that is not JSON",
        async (layout) => {
          await writeFile(layout.manifest, "{ not json");
        },
      ],
      [
        "a grant naming a crate the manifest does not hold",
        async (layout) => {
          const manifest = JSON.parse(await readFile(layout.manifest, "utf8"));
          manifest.grants.pond.push({ name: "ghost", version: "1.0.0", requestId: "x" });
          await writeFile(layout.manifest, JSON.stringify(manifest));
        },
      ],
      [
        "a manifest swapped for a link",
        async (layout) => {
          const copy = `${layout.manifest}.copy`;
          await writeFile(copy, await readFile(layout.manifest));
          await rm(layout.manifest);
          await symlink(copy, layout.manifest);
        },
      ],
    ];
  for (const [label, tamper] of tamperings) {
    it(`${label}: crate-overlay-tampered`, { skip: SKIP_ON_WINDOWS }, async () => {
      const root = await fixture("crate-overlay-tamper-");
      const { service, layout } = await profile(root, "dev");
      await approved(service, "tidy", "1.0.0");
      const clean = await overlayGrant(layout, "pond");
      assert.ok(clean.ok && clean.crates.length === 1);
      await tamper(layout);
      const grant = await overlayGrant(layout, "pond");
      assert.equal(grant.ok, false);
      assert.equal(!grant.ok && grant.refusal, CrateRefusal.OverlayTampered);
      const forBuild = await service.grantFor("pond");
      assert.equal(!forBuild.ok && forBuild.refusal, CrateRefusal.OverlayTampered);
    });
  }
});

describe("the vendor job", () => {
  it("writes only its job folder and opens no socket", async () => {
    const root = await fixture("crate-vendor-job-");
    const parent = path.join(root, "work");
    const jobDir = path.join(parent, "job");
    await mkdir(parent, { recursive: true });
    await writeFile(path.join(parent, "neighbour.txt"), "untouched");
    const tree = async (dir: string): Promise<string[]> => {
      const names: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
        names.push(path.relative(dir, path.join(entry.parentPath, entry.name)));
      }
      const job = path.relative(dir, jobDir);
      return names.filter((name) => name !== job && !name.startsWith(`${job}${path.sep}`)).sort();
    };
    const before = await tree(root);
    const connects: unknown[] = [];
    const connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
      connects.push(args[0]);
      throw new Error("the vendor job opened a socket");
    } as typeof connect;
    try {
      const crates = [];
      for (const [name, version] of [
        ["buildy", "0.2.0"],
        ["climber", "0.1.0"],
      ] as const) {
        const index = await directoryCrateIndex(path.join(root, "registry")).versions(name);
        const cksum = index?.find((entry) => entry.vers === version)?.cksum ?? "";
        crates.push({
          name,
          version,
          cksum,
          archive: path.join(root, "registry", "crates", `${name}-${version}.crate`),
        });
      }
      const result = await runCrateVendorJob({
        jobDir,
        root: { name: "buildy", version: "0.2.0" },
        crates,
        approvals: { buildScripts: true, procMacros: false },
        checker: CHECKER,
      });
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.refusal, CrateRefusal.OverlayTampered, "the climbing archive refuses the job");
      // A job that vets and passes, under the same guards: the policy and checksum steps open no socket either.
      const tidyIndex = await directoryCrateIndex(path.join(root, "registry")).versions("tidy");
      const passed = await runCrateVendorJob({
        jobDir,
        root: { name: "tidy", version: "1.0.0" },
        crates: [
          {
            name: "tidy",
            version: "1.0.0",
            cksum: tidyIndex?.find((entry) => entry.vers === "1.0.0")?.cksum ?? "",
            archive: path.join(root, "registry", "crates", "tidy-1.0.0.crate"),
          },
        ],
        approvals: { buildScripts: false, procMacros: false },
        checker: CHECKER,
      });
      assert.ok(passed.ok, JSON.stringify(passed));
    } finally {
      net.Socket.prototype.connect = connect;
    }
    assert.deepEqual(connects, []);
    assert.deepEqual(await tree(root), before, "nothing outside the job folder changed");
    assert.equal(await readFile(path.join(parent, "neighbour.txt"), "utf8"), "untouched");
  });

  it("refuses a crate or a closure that would unpack past its cap, before writing its files", async () => {
    const root = await fixture("crate-vendor-caps-");
    const crateOf = async (name: string, version: string) => {
      const index = await directoryCrateIndex(path.join(root, "registry")).versions(name);
      const cksum = index?.find((entry) => entry.vers === version)?.cksum ?? "";
      return { name, version, cksum, archive: path.join(root, "registry", "crates", `${name}-${version}.crate`) };
    };
    const tidy = await crateOf("tidy", "1.0.0");
    const helper = await crateOf("helper", "0.1.0");
    const job = (jobDir: string, limits: { crateBytes: number; closureBytes: number }, crates = [tidy]) =>
      runCrateVendorJob({
        jobDir,
        root: { name: "tidy", version: "1.0.0" },
        crates,
        approvals: { buildScripts: false, procMacros: false },
        checker: CHECKER,
        limits,
      });
    const perCrate = await job(path.join(root, "job-a"), { crateBytes: 8, closureBytes: 1024 * 1024 });
    assert.equal(!perCrate.ok && perCrate.refusal, CrateRefusal.OverlayTampered);
    assert.deepEqual(await readdir(path.join(root, "job-a")), [], "nothing of the crate was written");
    const closure = await job(path.join(root, "job-b"), { crateBytes: 1024 * 1024, closureBytes: 200 }, [tidy, helper]);
    assert.equal(!closure.ok && closure.refusal, CrateRefusal.OverlayTampered, JSON.stringify(closure));
    const fits = await job(path.join(root, "job-c"), { crateBytes: 1024 * 1024, closureBytes: 1024 * 1024 });
    assert.ok(fits.ok, JSON.stringify(fits));
  });

  it("writes cargo's checksum file for each crate it vets", async () => {
    const root = await fixture("crate-vendor-sums-");
    const index = await directoryCrateIndex(path.join(root, "registry")).versions("tidy");
    const cksum = index?.find((entry) => entry.vers === "1.0.0")?.cksum ?? "";
    const jobDir = path.join(root, "job");
    const result = await runCrateVendorJob({
      jobDir,
      root: { name: "tidy", version: "1.0.0" },
      crates: [
        { name: "tidy", version: "1.0.0", cksum, archive: path.join(root, "registry", "crates", "tidy-1.0.0.crate") },
      ],
      approvals: { buildScripts: false, procMacros: false },
      checker: CHECKER,
    });
    assert.ok(result.ok);
    const sums = JSON.parse(await readFile(path.join(jobDir, "tidy-1.0.0", ".cargo-checksum.json"), "utf8"));
    assert.equal(sums.package, cksum);
    assert.deepEqual(Object.keys(sums.files).sort(), ["Cargo.toml", "LICENSE", "src/lib.rs"]);
  });
});

describe("approvals stay in their profile and their game", () => {
  it("an approval in a developer profile never appears in the normal profile", async () => {
    const root = await fixture("crate-overlay-profiles-");
    const dev = await profile(root, "dev");
    const normal = await profile(root, "normal");
    await approved(dev.service, "tidy", "1.0.0");
    const devGrant = await dev.service.grantFor("pond");
    assert.ok(devGrant.ok && devGrant.names.includes("tidy"));
    const normalGrant = await normal.service.grantFor("pond");
    assert.ok(normalGrant.ok);
    assert.deepEqual(normalGrant.names, []);
    assert.deepEqual(normalGrant.crates, []);
    assert.deepEqual(await normal.service.list(), []);
    assert.equal(await lstat(normal.layout.root).catch(() => null), null, "the normal profile has no overlay at all");
  });

  it("grants a crate to the game it was approved for only", async () => {
    const root = await fixture("crate-overlay-games-");
    const { service } = await profile(root, "dev");
    await approved(service, "tidy", "1.0.0");
    const other = await service.grantFor("other");
    assert.ok(other.ok);
    assert.deepEqual(other.names, []);
  });
});

describe("an approved crate builds from the merged directory source", { skip: SKIP_ON_WINDOWS }, () => {
  /** A lane whose stager names `dependencies`; every step fails, so only what precedes cargo is observed. */
  async function lane(root: string, crateGrant: RustBuildsOptions["crateGrant"], dependencies: readonly string[]) {
    const vendor = path.join(root, "store-vendor");
    await mkdir(path.join(vendor, "fastrand-2.5.0"), { recursive: true });
    const specs: RustBuildSandboxSpec[] = [];
    const builds = new RustBuilds({
      root: path.join(root, "rust-builds"),
      sandbox: async (spec) => {
        specs.push(spec);
        return {
          run: async (request) => ({
            code: 1,
            signal: null,
            stdout: "",
            stderr: "stopped by the test",
            durationMs: 0,
            timedOut: false,
            truncated: false,
            sandboxed: false,
            command: request.command,
            cwd: request.cwd,
          }),
          dispose: async () => {},
        };
      },
      locate: async () => ({
        ok: true,
        toolchain: { bin: path.join(root, "bin"), vendor, clippyConf: root, reads: [vendor] },
      }),
      currentLock: async () => LOCK,
      stage: async (): Promise<RustStaged> => ({ ok: true, dependencies }),
      emit: () => {},
      platform: "darwin",
      cores: 8,
      denyWrite: [],
      writeLock: async () => {},
      exec: async (file) => ({ code: 0, stdout: file.endsWith("xcode-select") ? "/clt\n" : "/sdk\n", stderr: "" }),
      crateGrant,
    });
    return { builds, specs, vendor };
  }

  const game = (dir: string, project: string) => ({
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
  });

  it("links the store's crates and the granted crate into the build's source, and reads the overlay", async () => {
    const root = await fixture("crate-overlay-build-");
    const { service, layout, games } = await profile(root, "dev");
    await approved(service, "tidy", "1.0.0");
    const { builds, specs, vendor } = await lane(root, (project) => service.grantFor(project), ["genex", "tidy"]);
    const outcome = await builds.ensure(game(path.join(games, "pond"), "pond"), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.notEqual(outcome.rust?.refusal, RustBuildRefusal.DependencyNotAllowed, JSON.stringify(outcome.problem));
    const spec = specs[0];
    assert.ok(spec);
    assert.ok(spec.reads.includes(layout.vendor), "the build reads the overlay's vendor folder");
    const merged = `${spec.bin}.vendor`;
    assert.ok(spec.reads.includes(merged));
    assert.equal(await readlink(path.join(merged, "tidy-1.0.0")), path.join(layout.vendor, "tidy-1.0.0"));
    assert.equal(await readlink(path.join(merged, "fastrand-2.5.0")), path.join(vendor, "fastrand-2.5.0"));
    assert.deepEqual((await readdir(merged)).sort(), ["fastrand-2.5.0", "tidy-1.0.0"]);
  });

  it("refuses the same crate for a game it was not approved for", async () => {
    const root = await fixture("crate-overlay-other-");
    const { service, games } = await profile(root, "dev");
    await approved(service, "tidy", "1.0.0");
    const { builds, specs } = await lane(root, (project) => service.grantFor(project), ["genex", "tidy"]);
    const outcome = await builds.ensure(
      game(path.join(games, "other"), "other"),
      BuildTarget.Mac,
      CppBuildPurpose.Live,
    );
    assert.equal(outcome.rust?.refusal, RustBuildRefusal.DependencyNotAllowed);
    assert.ok(specs.every((spec) => !spec.reads.some((read) => read.endsWith(".vendor"))));
  });

  it("refuses a build whose overlay was tampered with crate-overlay-tampered, opening no sandbox", async () => {
    const root = await fixture("crate-overlay-build-tamper-");
    const { service, layout, games } = await profile(root, "dev");
    await approved(service, "tidy", "1.0.0");
    await writeFile(path.join(layout.vendor, "tidy-1.0.0", "src", "lib.rs"), "pub fn value() -> u32 { 9 }\n");
    const { builds, specs } = await lane(root, (project) => service.grantFor(project), ["genex", "tidy"]);
    const outcome = await builds.ensure(game(path.join(games, "pond"), "pond"), BuildTarget.Mac, CppBuildPurpose.Live);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.rust?.crate?.refusal, CrateRefusal.OverlayTampered, "typed, never read out of the line");
    assert.deepEqual(specs, [], "no sandbox was opened");
  });

  it("lists an approved crate's licence in the export notices", async () => {
    const root = await fixture("crate-overlay-notices-");
    const { service, layout } = await profile(root, "dev");
    await approved(service, "tidy", "1.0.0");
    const store = path.join(root, "store-vendor");
    await mkdir(store, { recursive: true });
    const lock = [
      "version = 4",
      "",
      "[[package]]",
      'name = "genex-game"',
      'version = "0.1.0"',
      'dependencies = ["tidy"]',
      "",
      "[[package]]",
      'name = "tidy"',
      'version = "1.0.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      "",
    ].join("\n");
    const licences = await readVendoredLicences(
      [store, layout.vendor],
      [{ name: "tidy", version: "1.0.0", source: null }],
    );
    const runtime = Object.fromEntries(
      Object.values(RustRuntimePart).map((part) => [
        part,
        [{ kind: NoticeSourceKind.Text, name: `${part}.txt`, text: part }],
      ]),
    );
    const notices = rustNotices({ target: BuildTarget.Mac, lock, roots: ["genex-game"], licences, runtime });
    assert.ok(notices.ok, JSON.stringify(notices));
    const index = notices.notices[0]?.sources[0];
    assert.ok(index && index.kind === NoticeSourceKind.Text && index.text.includes("tidy 1.0.0: MIT"));
  });
});

describe("the resolver's readers", () => {
  const requirements: ReadonlyArray<readonly [string, string, boolean]> = [
    ["^1.2", "1.9.0", true],
    ["^1.2", "2.0.0", false],
    ["^0.2.3", "0.2.9", true],
    ["^0.2.3", "0.3.0", false],
    ["^0.0.3", "0.0.4", false],
    ["~1.2", "1.2.7", true],
    ["~1.2", "1.3.0", false],
    ["=1.0.0", "1.0.0", true],
    ["=1.0.0", "1.0.1", false],
    [">=1, <2", "1.5.0", true],
    [">=1, <2", "2.0.0", false],
    ["1.*", "1.9.9", true],
    ["*", "0.0.1", true],
    ["^1.0", "1.1.0-beta", false],
    ["=1.1.0-beta", "1.1.0-beta", true],
    ["<=1.2", "1.2.5", true],
    [">1.2.3", "1.2.3", false],
  ];
  for (const [req, version, expected] of requirements) {
    it(`${req} ${expected ? "accepts" : "refuses"} ${version}`, () => {
      assert.equal(parseRequirement(req)?.(version), expected);
    });
  }

  it("refuses an unreadable requirement", () => {
    assert.equal(parseRequirement("1.0 || 2.0"), null);
  });

  const licences: ReadonlyArray<readonly [string | null, boolean]> = [
    ["MIT", true],
    ["MIT OR GPL-3.0-only", true],
    ["MIT AND GPL-3.0-only", false],
    ["MIT/Apache-2.0", false],
    ["Apache-2.0 WITH LLVM-exception", true],
    ["GPL-2.0-only WITH Classpath-exception-2.0", false],
    ["(MIT OR Apache-2.0) AND Unicode-3.0", true],
    ["see LICENSE", false],
    ["MIT OR", false],
    ["", false],
    [null, false],
  ];
  for (const [expression, expected] of licences) {
    it(`${JSON.stringify(expression)} is ${expected ? "allowed" : "refused"}`, () => {
      assert.equal(licenceAllowed(expression, CRATE_LICENCE_ALLOW), expected);
    });
  }

  it("names crates in the sparse index as crates.io lays them out", () => {
    assert.deepEqual(["a", "ab", "abc", "Tidy", "fastrand"].map(sparseIndexPath), [
      "1/a",
      "2/ab",
      "3/a/abc",
      "ti/dy/tidy",
      "fa/st/fastrand",
    ]);
  });
});
