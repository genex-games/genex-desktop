/**
 * The studio's own embedded cua-driver daemon (`substrate/cua-embedded.ts`), driven against a
 * stand-in driver process: started as the studio's direct child on a private socket, with the
 * embedded, no-telemetry and no-update-check environment and nothing else of the studio's, reached
 * through the driver's MCP proxy, restarted so a new grant is seen, and stopped without a trace.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { connectCuaDriver, driverEnv, GrantHolder } from "../../src/substrate/cua-driver-client.ts";
import { bundledCuaDriver, type EmbeddedCuaDriver, embeddedCuaDriver } from "../../src/substrate/cua-embedded.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** How long a killed daemon's exit may take to reach the studio on a loaded machine. */
const DIED_WITHIN_MS = 10_000;
const FAKE = fileURLToPath(new URL("../fixtures/fake-cua-driver.mjs", import.meta.url));
const HOST = "games.genex.desktop";
const started: EmbeddedCuaDriver[] = [];
after(async () => {
  await Promise.all(started.map((driver) => driver.stop()));
});

/** One daemon start the stand-in logged. */
interface Served {
  pid: number;
  argv: string[];
  env: Record<string, string>;
}

/** An embedded stand-in driver, logging each daemon start; `grants` is the file whose presence grants. */
async function standIn(flags: string[] = []) {
  const dir = await tmpDir("cua-embedded-");
  const serveLog = path.join(dir, "serve.jsonl");
  const grants = path.join(dir, "granted");
  const driver = embeddedCuaDriver(
    { command: process.execPath, args: [FAKE, "--serve-log", serveLog, "--grants", grants, ...flags] },
    { hostBundleId: HOST, env: driverEnv() },
  );
  started.push(driver);
  const served = async (): Promise<Served[]> =>
    existsSync(serveLog)
      ? (await readFile(serveLog, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Served)
      : [];
  return { driver, served, grants };
}

/** The value after `name` in a command line. */
const valueOf = (argv: readonly string[], name: string): string | undefined => argv[argv.indexOf(name) + 1];

describe("the studio's embedded cua-driver", () => {
  it("is the app's own child, embedded on a private socket, without telemetry, update checks or the studio's secrets", async () => {
    process.env.GENEX_SECRET = "an api key";
    try {
      const { driver, served, grants } = await standIn();
      await writeFile(grants, "");
      const proxy = await driver.command();
      const [daemon] = await served();
      assert.ok(daemon, "a daemon was started");
      assert.deepEqual(daemon.argv.slice(-4), ["serve", "--embedded", "--socket", valueOf(daemon.argv, "--socket")]);
      assert.deepEqual(daemon.env, {
        CUA_DRIVER_EMBEDDED: "1",
        CUA_DRIVER_HOST_BUNDLE_ID: HOST,
        DO_NOT_TRACK: "1",
        CUA_DRIVER_RS_UPDATE_CHECK: "0",
      });
      const socket = valueOf(daemon.argv, "--socket")!;
      assert.equal((await stat(path.dirname(socket))).mode & 0o777, 0o700, "no other user reaches the socket");
      assert.ok(Buffer.byteLength(socket) < 104, "a Unix socket path fits macOS's limit");
      assert.deepEqual(proxy.args.slice(-4), ["mcp", "--embedded", "--socket", socket]);
      assert.equal(proxy.env?.CUA_DRIVER_EMBEDDED, "1", "the proxy is embedded too");
      // The studio drives it through the proxy as it drives any driver.
      const desktop = await connectCuaDriver(() => driver.command(), { local: false, holder: GrantHolder.Host });
      try {
        assert.deepEqual([(await desktop.screenshot()).width], [1366]);
      } finally {
        await desktop.close();
      }
    } finally {
      delete process.env.GENEX_SECRET;
    }
  });

  it("starts one daemon for calls that come together, and keeps it for the next", async () => {
    const { driver, served } = await standIn();
    const [a, b] = await Promise.all([driver.command(), driver.command()]);
    assert.deepEqual(a, b);
    await driver.command();
    assert.equal((await served()).length, 1);
  });

  it("restarts on a new socket, leaving no process and no folder behind, and starts again after a daemon dies", async () => {
    const { driver, served } = await standIn();
    const first = valueOf((await driver.command()).args, "--socket")!;
    await driver.restart();
    const [old] = await served();
    assert.equal(running(old!.pid), false, "the old daemon is gone");
    assert.equal(existsSync(path.dirname(first)), false, "and its folder");
    const second = valueOf((await driver.command()).args, "--socket")!;
    assert.notEqual(second, first);
    const latest = (await served()).at(-1)!;
    process.kill(latest.pid, "SIGKILL");
    // A daemon that died is started again on the next call, not reported as running. The death
    // reaches the studio as the child's exit event, whenever the machine gets to it: wait for that.
    const until = Date.now() + DIED_WITHIN_MS;
    while (Date.now() < until && valueOf((await driver.command()).args, "--socket") === second) await sleep(20);
    assert.equal((await served()).length, 3);
    await driver.stop();
    assert.equal(running((await served()).at(-1)!.pid), false);
  });

  it("says at once why a driver that cannot be run did not start", async () => {
    const missing = embeddedCuaDriver(
      { command: path.join(await tmpDir("cua-missing-"), "cua-driver"), args: [] },
      { hostBundleId: HOST, env: driverEnv() },
    );
    started.push(missing);
    const begun = Date.now();
    await assert.rejects(missing.command(), /cua-driver did not start: .*ENOENT/);
    assert.ok(Date.now() - begun < 5_000, "not after the 10 s start deadline");
  });

  it("says the daemon's own reason when it cannot start, and leaves nothing behind", async () => {
    const { driver, served } = await standIn(["--serve-fail"]);
    await assert.rejects(driver.command(), /cua-driver did not start: .*could not bind the daemon socket/);
    assert.deepEqual(await served(), []);
  });

  it("sees a grant given after its daemon started by restarting it once, and asks macOS for a grant still missing", async () => {
    const { driver, served, grants } = await standIn();
    await driver.command();
    // The person grants while the daemon runs: macOS keeps its old answer until it restarts.
    await writeFile(grants, "");
    let asked = 0;
    const options = {
      local: false,
      holder: GrantHolder.Host,
      restart: () => driver.restart(),
      askForGrants: async () => {
        asked += 1;
      },
    };
    const desktop = await connectCuaDriver(() => driver.command(), options);
    await desktop.close();
    assert.equal((await served()).length, 2, "restarted once");
    assert.equal(asked, 0, "nothing asked of macOS");
    // Never given (a daemon started without it): one more restart cannot help, so macOS is asked
    // and the person told what to turn on.
    await rm(grants);
    await driver.restart();
    await assert.rejects(
      connectCuaDriver(() => driver.command(), options),
      /^Error: Genex needs Accessibility/,
    );
    assert.equal(asked, 1);
    assert.equal((await served()).length, 4, "one restart, not a loop");
  });

  it("lives in the app's resources", () => {
    assert.equal(
      bundledCuaDriver("/Applications/Genex.app/Contents/Resources/r"),
      "/Applications/Genex.app/Contents/Resources/r/cua-driver/cua-driver",
    );
  });
});
