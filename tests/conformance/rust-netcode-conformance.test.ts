/**
 * The netcode-bench conformance runner for the Rust drivers, `scripts/netcode/rust-conformance.ts`
 * (multiplayer MP-6c). It runs genex-demo's `test/conformance.test.ts` with
 * `GENEX_CONFORMANCE_DRIVERS=rust`, once with the vendored crate's driver and once with the facade
 * driver (`examples/net-driver`), and writes the evidence.
 *
 * These rows hold its admission: a genex-demo checkout at any commit but the vendored crate's pin,
 * a dirty or uninstalled one (whose modules would resolve from a folder above it), and a driver
 * path outside the repository or the cargo target folder are refused before anything runs or is
 * written. The real suite is the acceptance command itself (see the README), not a row here.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import { gitFile } from "../helpers/git.ts";
import { tmpDir } from "../helpers/tmp.ts";
import {
  CONFORMANCE_REFUSAL_EXIT,
  ConformanceRefusal,
  DriverName,
  main,
  parseTap,
  planRun,
  readPin,
  type SuiteRun,
} from "../../scripts/netcode/rust-conformance.ts";

const execute = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = path.join(REPO, "scripts", "netcode", "rust-conformance.ts");
/** The genex-demo commit the vendored genex-multiplayer is pinned to (design-MP, MP-6c). */
const PINNED_COMMIT = "8cd1477a2a120937a1c79fc1c98b99cef3fcc145";
const REFUSAL_PREFIX = "genex-netcode-conformance-refusal: ";
const POSIX_ONLY = process.platform === "win32" ? { skip: "the fixture drivers are POSIX executables" } : {};

/** A genex-demo look-alike: a git checkout with the bench and relay folders, at its own commit. */
async function fakeDemo(root: string, options: { installed?: boolean } = {}): Promise<{ dir: string; head: string }> {
  const dir = path.join(root, "genex-demo");
  for (const folder of ["packages/netcode-bench/test", "packages/multiplayer", "apps/colyseus"]) {
    await mkdir(path.join(dir, folder), { recursive: true });
  }
  await writeFile(path.join(dir, "packages/netcode-bench/package.json"), '{"name":"@genex/netcode-bench"}\n');
  await writeFile(path.join(dir, "packages/netcode-bench/test/conformance.test.ts"), "// fixture\n");
  await writeFile(path.join(dir, "packages/multiplayer/package.json"), '{"name":"@genex-ai/multiplayer"}\n');
  await writeFile(path.join(dir, "apps/colyseus/package.json"), '{"name":"@genex/colyseus"}\n');
  await writeFile(path.join(dir, ".gitignore"), "node_modules/\n");
  if (options.installed !== false) await installModules(dir);
  await gitFile(["init", "-q", dir]);
  await gitFile(["-C", dir, "add", "-A"]);
  await gitFile(["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "fixture"]);
  const { stdout } = await gitFile(["-C", dir, "rev-parse", "HEAD"]);
  return { dir, head: String(stdout).trim() };
}

/** The packages the bench and the relay resolve, installed in `dir`'s own node_modules. */
async function installModules(dir: string): Promise<void> {
  for (const name of ["@colyseus/core", "@genex-ai/multiplayer"]) {
    const folder = path.join(dir, "node_modules", name);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "package.json"), JSON.stringify({ name }));
  }
}

/** An executable stand-in driver at `file`. */
async function fakeDriver(file: string): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "#!/bin/sh\nexit 0\n");
  await chmod(file, 0o755);
  return file;
}

/** A repository root, a genex-demo at `pin`, and both drivers under the repo's cargo target. */
async function fixture() {
  const root = realpathSync(await tmpDir("netcode-conformance-"));
  const repo = path.join(root, "repo");
  const outside = path.join(root, "outside");
  await mkdir(repo, { recursive: true });
  await mkdir(outside, { recursive: true });
  const demo = await fakeDemo(root);
  const target = path.join(repo, ".studio-dev", "cargo-target", "debug");
  const crate = await fakeDriver(path.join(target, "examples", "driver"));
  const facade = await fakeDriver(path.join(target, "net-driver"));
  const env = { GENEX_DEMO_DIR: demo.dir };
  return { root, repo, outside, demo, crate, facade, env };
}

describe("rust netcode conformance runner: the checkout (MP-6c)", POSIX_ONLY, () => {
  it("reads the genex-demo pin from the vendored crate's PROVENANCE.toml", () => {
    assert.equal(readPin(REPO), PINNED_COMMIT);
  });

  it("admits a clean, installed checkout at the pin with both drivers built in the repository", async () => {
    const f = await fixture();
    const result = await planRun({ env: f.env, repo: f.repo, pin: f.demo.head });
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(
      result.plan.drivers.map((driver) => [driver.name, driver.path]),
      [
        [DriverName.Crate, f.crate],
        [DriverName.Facade, f.facade],
      ],
    );
    assert.equal(result.plan.commit, f.demo.head);
  });

  it("refuses a genex-demo checkout at any other commit", async () => {
    const f = await fixture();
    const result = await planRun({ env: f.env, repo: f.repo, pin: PINNED_COMMIT });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, ConformanceRefusal.DemoWrongCommit);
  });

  it("refuses an unset demo, a folder that is no checkout, and a checkout with local changes", async () => {
    const f = await fixture();
    const plain = path.join(f.root, "plain");
    await mkdir(plain);
    await writeFile(path.join(f.demo.dir, "packages/netcode-bench/test/conformance.test.ts"), "// edited\n");
    const rows: Array<[NodeJS.ProcessEnv, ConformanceRefusal]> = [
      [{}, ConformanceRefusal.DemoUnset],
      [{ GENEX_DEMO_DIR: path.join(f.root, "missing") }, ConformanceRefusal.DemoNotCheckout],
      [{ GENEX_DEMO_DIR: plain }, ConformanceRefusal.DemoNotCheckout],
      [f.env, ConformanceRefusal.DemoDirty],
    ];
    for (const [env, code] of rows) {
      const result = await planRun({ env, repo: f.repo, pin: f.demo.head });
      assert.equal(!result.ok && result.code, code, JSON.stringify(env));
    }
  });

  it("refuses a checkout whose bench modules would resolve from a folder above it", async () => {
    const root = realpathSync(await tmpDir("netcode-conformance-"));
    const repo = path.join(root, "repo");
    const target = path.join(repo, ".studio-dev", "cargo-target", "debug");
    await fakeDriver(path.join(target, "examples", "driver"));
    await fakeDriver(path.join(target, "net-driver"));
    // The packages exist one folder up, as an enclosing checkout's node_modules would: Node would
    // load them, and the bench would run against another tree's relay.
    await installModules(root);
    const demo = await fakeDemo(root, { installed: false });
    const result = await planRun({ env: { GENEX_DEMO_DIR: demo.dir }, repo, pin: demo.head });
    assert.equal(!result.ok && result.code, ConformanceRefusal.DemoNotInstalled);
  });
});

describe("rust netcode conformance runner: the drivers (MP-6c)", POSIX_ONLY, () => {
  it("refuses driver paths outside the repository and the cargo target folder", async () => {
    const f = await fixture();
    const outsideDriver = await fakeDriver(path.join(f.outside, "driver"));
    const linked = path.join(f.repo, "linked-driver");
    await symlink(outsideDriver, linked);
    const notExecutable = path.join(f.repo, "plain-file");
    await writeFile(notExecutable, "");
    const spaced = await fakeDriver(path.join(f.repo, "a driver"));
    const rows: Array<[string, ConformanceRefusal]> = [
      [outsideDriver, ConformanceRefusal.DriverOutside],
      [path.join(f.repo, "..", "outside", "driver"), ConformanceRefusal.DriverOutside],
      [linked, ConformanceRefusal.DriverOutside],
      ["/bin/sh", ConformanceRefusal.DriverOutside],
      [path.join(f.repo, "absent"), ConformanceRefusal.DriverMissing],
      [f.repo, ConformanceRefusal.DriverMissing],
      [notExecutable, ConformanceRefusal.DriverNotExecutable],
      [spaced, ConformanceRefusal.DriverUnquotable],
    ];
    for (const key of ["GENEX_NET_CRATE_DRIVER", "GENEX_NET_FACADE_DRIVER"]) {
      for (const [driver, code] of rows) {
        const result = await planRun({ env: { ...f.env, [key]: driver }, repo: f.repo, pin: f.demo.head });
        assert.equal(!result.ok && result.code, code, `${key}=${driver}`);
      }
    }
  });

  it("admits a driver under a CARGO_TARGET_DIR outside the repository (a shared target)", async () => {
    const f = await fixture();
    const shared = path.join(f.outside, "cargo-target");
    const crate = await fakeDriver(path.join(shared, "debug", "examples", "driver"));
    const facade = await fakeDriver(path.join(shared, "debug", "net-driver"));
    const env = { ...f.env, CARGO_TARGET_DIR: shared };
    const result = await planRun({ env, repo: f.repo, pin: f.demo.head });
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(
      result.plan.drivers.map((driver) => driver.path),
      [crate, facade],
    );
  });

  it("a refusal starts no suite and writes no evidence", async () => {
    const f = await fixture();
    const evidence = path.join(f.root, "evidence");
    const started: SuiteRun[] = [];
    const errors: string[] = [];
    const code = await main(
      ["--out", evidence],
      { ...f.env, GENEX_NET_FACADE_DRIVER: "/bin/sh" },
      {
        repo: f.repo,
        pin: f.demo.head,
        runSuite: async (run) => {
          started.push(run);
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ms: 0 };
        },
        log: () => {},
        error: (line) => errors.push(line),
      },
    );
    assert.equal(code, CONFORMANCE_REFUSAL_EXIT);
    assert.deepEqual(started, []);
    assert.equal(existsSync(evidence), false);
    assert.equal(errors.length, 1);
    assert.equal(JSON.parse(errors[0].slice(REFUSAL_PREFIX.length)).code, ConformanceRefusal.DriverOutside);
  });
});

describe("rust netcode conformance runner: the run (MP-6c)", POSIX_ONLY, () => {
  it("runs the crate's driver and then the facade's, and is green only when both pass with no skip", async () => {
    const f = await fixture();
    const evidence = path.join(f.root, "evidence");
    const started: SuiteRun[] = [];
    const green = "ok 1 - conformance [rust] probe\nok 2 - conformance [rust] chat\n# tests 2\n# pass 2\n# fail 0\n";
    const skipped = "ok 1 - conformance [rust] probe\nok 2 - conformance [rust] feel # SKIP lacks 'skew'\n";
    const outputs = [green, skipped];
    const code = await main(["--out", evidence], f.env, {
      repo: f.repo,
      pin: f.demo.head,
      runSuite: async (run) => {
        started.push(run);
        return { exitCode: 0, stdout: outputs[started.length - 1], stderr: "", timedOut: false, ms: 5 };
      },
      log: () => {},
      error: () => {},
    });
    assert.equal(code, 1);
    assert.deepEqual(
      started.map((run) => [run.env.GENEX_CONFORMANCE_DRIVERS, run.env.GENEX_DRIVER_RUST, run.cwd]),
      [
        ["rust", f.crate, path.join(f.demo.dir, "packages", "netcode-bench")],
        ["rust", f.facade, path.join(f.demo.dir, "packages", "netcode-bench")],
      ],
    );
    assert.ok(existsSync(path.join(evidence, "crate.tap")));
    assert.ok(existsSync(path.join(evidence, "facade.tap")));
    const summary = JSON.parse(await readFile(path.join(evidence, "summary.json"), "utf8"));
    assert.equal(summary.commit, f.demo.head);
    assert.deepEqual(
      summary.drivers.map((driver: { name: string; green: boolean }) => [driver.name, driver.green]),
      [
        [DriverName.Crate, true],
        [DriverName.Facade, false],
      ],
    );
    assert.ok(summary.ownerRows.length > 0);
  });

  it("counts a skip, a failure and a cancelled test as not green", () => {
    const rows: Array<[string, boolean]> = [
      ["ok 1 - a\nok 2 - b\n", true],
      ["ok 1 - a\nok 2 - b # SKIP reason\n", false],
      ['ok 1 - a\nnot ok 2 - b\n  ---\n  error: \'result.reason: want "x", got "y"\'\n  ...\n', false],
      ["ok 1 - a\nnot ok 2 - b # TODO later\n", false],
      ["", false],
    ];
    for (const [tap, green] of rows) assert.equal(parseTap(tap).green, green, tap);
    const failed = parseTap(rows[2][0]);
    assert.deepEqual(
      failed.failures.map((failure) => failure.name),
      ["b"],
    );
    assert.match(failed.failures[0].error, /want "x", got "y"/);
  });

  it("the command refuses with one typed line and the refusal exit", async () => {
    const root = realpathSync(await tmpDir("netcode-conformance-"));
    const evidence = path.join(root, "evidence");
    const env: NodeJS.ProcessEnv = { ...process.env, GENEX_DEMO_DIR: root };
    delete env.NODE_TEST_CONTEXT;
    const failure = await execute(process.execPath, [SCRIPT, "--out", evidence], { env }).then(
      () => assert.fail("the runner admitted a folder that is no checkout"),
      (error: { code: number; stderr: string }) => error,
    );
    assert.equal(failure.code, CONFORMANCE_REFUSAL_EXIT);
    const line = failure.stderr.trim().split("\n").at(-1) ?? "";
    assert.ok(line.startsWith(REFUSAL_PREFIX), line);
    assert.equal(JSON.parse(line.slice(REFUSAL_PREFIX.length)).code, ConformanceRefusal.DemoNotCheckout);
    assert.equal(existsSync(evidence), false);
  });
});
