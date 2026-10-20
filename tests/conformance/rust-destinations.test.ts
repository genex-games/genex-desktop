/**
 * The six-destination compile check `scripts/toolchains/rust-destinations.ts` (RQ0.2): the seven
 * rows it plans, the crate sets per destination, the refusals that start no cargo (`disk`, an
 * unknown crate), the Linux row's sysroot-scoped pkg-config, and the summary files. Cargo itself
 * is a stub here; the real run is `npm run check:rust-destinations`.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type CargoJob,
  cargoCheckArgs,
  DestinationsRefusal,
  DestinationTriple,
  type DestinationsDeps,
  linuxPkgConfigEnv,
  MIN_FREE_BYTES,
  NotRunReason,
  planRows,
  RowStatus,
  runDestinations,
} from "../../scripts/toolchains/rust-destinations.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = path.join(REPO, "scripts", "toolchains", "rust-destinations.ts");
const REFUSAL_EXIT = 78;
const REFUSAL_PREFIX = "genex-rust-destinations-refusal: ";
const GIB = 1024 ** 3;
const ENGINE = [
  "genex-core",
  "genex-render",
  "genex-hud",
  "genex-frames",
  "genex-gpu-memory",
  "genex-assets",
  "genex-audio",
  "genex-anim",
  "genex-nav",
  "genex-stream",
  "genex-net",
  "genex",
];
/** The game-systems crates (EP-0b): every destination compiles them, since the facade re-exports them. */
const GAME_SYSTEMS_CRATES = ["genex-anim", "genex-nav", "genex-stream"];
/** The vendored relay client (MP-0t): checked on the web row with its `web` feature only, until the store gives native rows a libcolyseus. */
const RELAY_CLIENT = "genex-multiplayer";

const EXPECTED_ROWS: Record<string, string[]> = {
  [DestinationTriple.MacArm]: [...ENGINE, "genex-platform-desktop", "genex-studio"],
  [DestinationTriple.Web]: [...ENGINE, "genex-platform-web", RELAY_CLIENT],
  [DestinationTriple.IosDevice]: [...ENGINE, "genex-platform-ios"],
  [DestinationTriple.IosSimulator]: [...ENGINE, "genex-platform-ios"],
  [DestinationTriple.Android]: [...ENGINE, "genex-platform-android"],
  [DestinationTriple.Windows]: [...ENGINE, "genex-platform-desktop", "genex-studio"],
  [DestinationTriple.Linux]: [...ENGINE, "genex-platform-desktop", "genex-studio"],
};

/** Seams for a run that never starts cargo: everything is recorded, nothing is spawned. */
function stubs(over: Partial<DestinationsDeps> = {}) {
  const jobs: CargoJob[] = [];
  let clock = 0;
  const deps: Partial<DestinationsDeps> = {
    freeBytes: async () => 50 * GIB,
    runCargo: async (job) => {
      jobs.push(job);
      return { exitCode: 0, output: "    Finished `dev` profile\n" };
    },
    now: () => (clock += 1000),
    findLinuxSysroot: () => "/sysroot/linux",
    ...over,
  };
  return { deps, jobs };
}

function runScript(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { cwd: REPO }, (error, stdout, stderr) => {
      const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

describe("rust-destinations plan", () => {
  it("plans the seven rows of the six destinations with the right crate sets", () => {
    const rows = planRows();
    assert.deepEqual(
      rows.map((row) => row.triple),
      Object.keys(EXPECTED_ROWS),
    );
    for (const row of rows) assert.deepEqual(row.crates, EXPECTED_ROWS[row.triple], row.triple);
  });

  it("puts each platform crate only on its own family", () => {
    const withCrate = (name: string) =>
      planRows()
        .filter((row) => row.crates.includes(name))
        .map((row) => row.triple);
    assert.deepEqual(withCrate("genex-platform-ios"), [DestinationTriple.IosDevice, DestinationTriple.IosSimulator]);
    assert.deepEqual(withCrate("genex-platform-android"), [DestinationTriple.Android]);
    assert.deepEqual(withCrate("genex-platform-web"), [DestinationTriple.Web]);
    assert.deepEqual(withCrate("genex-platform-desktop"), [
      DestinationTriple.MacArm,
      DestinationTriple.Windows,
      DestinationTriple.Linux,
    ]);
  });

  it("compiles the game-systems crates on every destination, and --crates names each", () => {
    for (const row of planRows())
      for (const name of GAME_SYSTEMS_CRATES) assert.ok(row.crates.includes(name), `${row.triple} lacks ${name}`);
    const rows = planRows(GAME_SYSTEMS_CRATES);
    assert.equal(rows.length, 7);
    for (const row of rows) assert.deepEqual(row.crates, GAME_SYSTEMS_CRATES, row.triple);
  });

  it("compiles the multiplayer layer on every destination, and the vendored relay client on the web row with its web feature", () => {
    for (const row of planRows()) assert.ok(row.crates.includes("genex-net"), `${row.triple} lacks genex-net`);
    const withClient = planRows().filter((row) => row.crates.includes(RELAY_CLIENT));
    assert.deepEqual(
      withClient.map((row) => row.triple),
      [DestinationTriple.Web],
    );
    assert.deepEqual(cargoCheckArgs(withClient[0]).slice(-2), ["--features", `${RELAY_CLIENT}/web`]);
    for (const row of planRows().filter((found) => found.triple !== DestinationTriple.Web))
      assert.equal(cargoCheckArgs(row).includes("--features"), false, row.triple);
    const narrowed = planRows(["genex-core"]).find((row) => row.triple === DestinationTriple.Web);
    assert.ok(narrowed);
    assert.equal(
      cargoCheckArgs(narrowed).includes("--features"),
      false,
      "no feature for a crate the row does not check",
    );
  });

  it("narrows every row to --crates and drops rows left empty", () => {
    const rows = planRows(["genex-render", "genex-platform-ios"]);
    assert.equal(rows.length, 7);
    assert.deepEqual(rows.find((row) => row.triple === DestinationTriple.Web)?.crates, ["genex-render"]);
    assert.deepEqual(rows.find((row) => row.triple === DestinationTriple.IosDevice)?.crates, [
      "genex-render",
      "genex-platform-ios",
    ]);
    const onlyIos = planRows(["genex-platform-ios"]);
    assert.deepEqual(
      onlyIos.map((row) => row.triple),
      [DestinationTriple.IosDevice, DestinationTriple.IosSimulator],
    );
  });

  it("refuses an unknown crate name", () => {
    assert.throws(
      () => planRows(["genex-render", "genex-nope"]),
      (error: { code?: string }) => error.code === DestinationsRefusal.UnknownCrate,
    );
  });
});

describe("rust-destinations refusals", () => {
  it("refuses disk at 4 GB free before any cargo runs or file is written", async () => {
    const out = path.join(await tmpDir(), "out");
    const { deps, jobs } = stubs({ freeBytes: async () => 4 * GIB });
    await assert.rejects(
      runDestinations({ outDir: out }, deps),
      (error: { code?: string }) => error.code === DestinationsRefusal.Disk,
    );
    assert.equal(jobs.length, 0);
    assert.equal(existsSync(out), false);
  });

  it("starts at exactly the floor", async () => {
    const out = path.join(await tmpDir(), "out");
    const { deps, jobs } = stubs({ freeBytes: async () => MIN_FREE_BYTES });
    const summary = await runDestinations({ outDir: out }, deps);
    assert.equal(jobs.length, 7);
    assert.equal(summary.lowDisk, true);
  });

  it("refuses an unknown crate before the disk is asked", async () => {
    let asked = false;
    const { deps, jobs } = stubs({
      freeBytes: async () => {
        asked = true;
        return 50 * GIB;
      },
    });
    await assert.rejects(
      runDestinations({ crates: ["nope"], outDir: await tmpDir() }, deps),
      (error: { code?: string }) => error.code === DestinationsRefusal.UnknownCrate,
    );
    assert.equal(asked, false);
    assert.equal(jobs.length, 0);
  });

  it("exits 78 with a typed line for an unknown --crates name and starts nothing", async () => {
    const out = path.join(await tmpDir(), "out");
    const run = await runScript(["--crates", "genex-core,genex-nope", "--out", out]);
    assert.equal(run.code, REFUSAL_EXIT);
    const line = run.stderr.split("\n").find((found) => found.startsWith(REFUSAL_PREFIX));
    assert.ok(line, run.stderr);
    assert.equal(JSON.parse(line.slice(REFUSAL_PREFIX.length)).code, DestinationsRefusal.UnknownCrate);
    assert.equal(existsSync(out), false);
  });

  it("lists the plan without running cargo", async () => {
    const run = await runScript(["--list"]);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).length, 7);
  });
});

describe("rust-destinations run", () => {
  it("runs cargo check offline and locked per row and writes a summary of seven rows", async () => {
    const out = path.join(await tmpDir(), "out");
    const { deps, jobs } = stubs();
    const summary = await runDestinations({ outDir: out }, deps);
    assert.equal(summary.passed, true);
    assert.equal(summary.rows.length, 7);
    assert.deepEqual(
      jobs.map((job) => job.args.slice(0, 5)),
      Object.keys(EXPECTED_ROWS).map((triple) => ["check", "--offline", "--locked", "--target", triple]),
    );
    const written = JSON.parse(await readFile(path.join(out, "summary.json"), "utf8"));
    assert.deepEqual(
      written.rows.map((row: { target: string }) => row.target),
      Object.keys(EXPECTED_ROWS),
    );
    for (const triple of Object.keys(EXPECTED_ROWS)) {
      const row = JSON.parse(await readFile(path.join(out, `${triple}.json`), "utf8"));
      assert.equal(row.status, RowStatus.Passed);
      assert.deepEqual(row.crates, EXPECTED_ROWS[triple]);
    }
  });

  it("checks the crates of a row with -p", async () => {
    const { deps, jobs } = stubs();
    await runDestinations({ crates: ["genex-core", "genex-platform-web"], outDir: await tmpDir() }, deps);
    const web = jobs.find((job) => job.args.includes(DestinationTriple.Web));
    assert.deepEqual(web?.args.slice(5), ["-p", "genex-core", "-p", "genex-platform-web"]);
  });

  it("runs every row after a failure and reports it", async () => {
    const out = await tmpDir();
    const { deps } = stubs({
      runCargo: async (job) =>
        job.args.includes(DestinationTriple.Web)
          ? { exitCode: 101, output: "warning: unused\nerror[E0432]: unresolved import\n" }
          : { exitCode: 0, output: "" },
    });
    const summary = await runDestinations({ outDir: out }, deps);
    assert.equal(summary.passed, false);
    assert.equal(summary.rows.length, 7);
    const web = summary.rows.find((row) => row.target === DestinationTriple.Web);
    assert.equal(web?.status, RowStatus.Failed);
    assert.equal(web?.exitCode, 101);
    assert.equal(web?.warnings, 1);
    assert.deepEqual(web?.excerpt, ["error[E0432]: unresolved import"]);
    assert.equal(summary.rows.filter((row) => row.status === RowStatus.Passed).length, 6);
  });

  it("reports a refusal of the env helper as not-run, with its code", async () => {
    const { deps } = stubs({
      runCargo: async (job) =>
        job.args.includes(DestinationTriple.Android)
          ? {
              exitCode: 78,
              output: `genex-rust-env-refusal: ${JSON.stringify({ code: "tool-missing", detail: "no NDK" })}\n`,
            }
          : { exitCode: 0, output: "" },
    });
    const summary = await runDestinations({ outDir: await tmpDir() }, deps);
    const android = summary.rows.find((row) => row.target === DestinationTriple.Android);
    assert.equal(android?.status, RowStatus.NotRun);
    assert.equal(android?.reason, "tool-missing");
    assert.equal(summary.passed, false);
  });

  it("scopes the sysroot's pkg-config to the Linux row only", async () => {
    const { deps, jobs } = stubs();
    await runDestinations({ outDir: await tmpDir(), env: { CARGO_TARGET_DIR: "/tmp/t" } }, deps);
    const key = "PKG_CONFIG_LIBDIR_x86_64_unknown_linux_gnu";
    const byTarget = new Map(jobs.map((job) => [job.args[4], job.env]));
    assert.match(byTarget.get(DestinationTriple.Linux)?.[key] ?? "", /^\/sysroot\/linux\/usr\/lib64\/pkgconfig:/);
    for (const [target, env] of byTarget) {
      if (target !== DestinationTriple.Linux) assert.equal(env[key], undefined, String(target));
    }
  });

  it("does not run the Linux row green without a sysroot", async () => {
    const { deps, jobs } = stubs({ findLinuxSysroot: () => null });
    const summary = await runDestinations({ outDir: await tmpDir() }, deps);
    const linux = summary.rows.find((row) => row.target === DestinationTriple.Linux);
    assert.equal(linux?.status, RowStatus.NotRun);
    assert.equal(linux?.reason, NotRunReason.SysrootMissing);
    assert.equal(jobs.length, 6);
    assert.equal(summary.passed, false);
  });
});

describe("linuxPkgConfigEnv", () => {
  it("scopes every variable to the Linux triple and searches only the sysroot", () => {
    const env = linuxPkgConfigEnv("/s");
    assert.deepEqual(Object.keys(env).sort(), [
      "PKG_CONFIG_ALLOW_CROSS_x86_64_unknown_linux_gnu",
      "PKG_CONFIG_LIBDIR_x86_64_unknown_linux_gnu",
      "PKG_CONFIG_PATH_x86_64_unknown_linux_gnu",
      "PKG_CONFIG_SYSROOT_DIR_x86_64_unknown_linux_gnu",
      "PKG_CONFIG_x86_64_unknown_linux_gnu",
    ]);
    assert.equal(env.PKG_CONFIG_LIBDIR_x86_64_unknown_linux_gnu, "/s/usr/lib64/pkgconfig:/s/usr/share/pkgconfig");
    assert.equal(env.PKG_CONFIG_x86_64_unknown_linux_gnu, "/s/bin/pkg-config");
  });
});
